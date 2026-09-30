#!/usr/bin/env bun
/**
 * 数据提取脚本：解析 NetHack 5.0 的职业任务起始层（dat/*-strt.lua），
 * 生成 `src/data/quest.gen.ts`。
 *
 * 用法：
 *   bun tools/extract-nh-quest.ts [NetHack 源码路径]
 *
 * 只提取固定地图本身：字符网格、门、楼梯、分支落脚区、亮暗区域、
 * 固定设施与陷阱。领袖、护卫、怪物与物品仍由游戏侧按职业数据布置，
 * 因此这里不解析 `des.monster`/`des.object`。
 * 浪人（Ran-strt.lua）的起始层没有 `des.map`，跳过。
 */

import fs from 'node:fs';
import path from 'node:path';
import { compareReference, loadRecordedReference, readReferenceState } from './nethack-ref';
import type {
  QuestFeature,
  QuestHomeData,
  QuestRegion,
  QuestStair,
  QuestTrap,
} from '../src/game/quest';
import { QUEST_MAP_CHARS } from '../src/game/quest';

const projectRoot = path.resolve(import.meta.dir, '..');
const nhRoot = path.resolve(
  process.argv[2] || process.env.NETHACK_SRC || path.join(projectRoot, '..', 'nethack'),
);

/** 职业 id 到原版起始层文件的映射；浪人没有固定地图。 */
const ROLE_FILES: Record<string, string> = {
  ARCHEOLOGIST: 'Arc-strt.lua',
  BARBARIAN: 'Bar-strt.lua',
  CAVE_DWELLER: 'Cav-strt.lua',
  HEALER: 'Hea-strt.lua',
  KNIGHT: 'Kni-strt.lua',
  MONK: 'Mon-strt.lua',
  CLERIC: 'Pri-strt.lua',
  ROGUE: 'Rog-strt.lua',
  SAMURAI: 'Sam-strt.lua',
  TOURIST: 'Tou-strt.lua',
  VALKYRIE: 'Val-strt.lua',
  WIZARD: 'Wiz-strt.lua',
};

/** Lua 的陷阱名映射到引擎的陷阱 id。 */
const TRAP_NAMES: Record<string, string> = {
  pit: 'PIT',
  'spiked pit': 'SPIKED_PIT',
  'trap door': 'HOLE',
  hole: 'HOLE',
  'sleep gas': 'SLEEPING_GAS_TRAP',
  dart: 'DART_TRAP',
  arrow: 'ARROW_TRAP',
  'falling rock': 'ROCKTRAP',
  'rolling boulder': 'ROLLING_BOULDER_TRAP',
  landmine: 'LANDMINE',
  fire: 'FIRE_TRAP',
  teleport: 'TELEP_TRAP',
  'level teleport': 'LEVEL_TELEP',
  web: 'WEB',
  rust: 'RUST_TRAP',
  magic: 'MAGIC_TRAP',
  polymorph: 'POLY_TRAP',
  statue: 'STATUE_TRAP',
  'anti-magic': 'ANTI_MAGIC',
  'anti magic': 'ANTI_MAGIC',
};

const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/**
 * 取出所有 `des.<name>(...)` 调用的括号内文本。
 *
 * 手写平衡括号扫描，跳过字符串字面量；比逐条正则稳，`place[1]`
 * 这类嵌套表达式也能原样带出来。
 */
function calls(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`des\\.${name}\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    let quote: string | null = null;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    out.push(src.slice(start, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/** 解析 `des.region` 的矩形与亮暗。 */
function parseRegion(body: string): QuestRegion | null {
  const area = body.match(/selection\.area\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  const region = body.match(/region\s*=\s*\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/);
  const coords = area ?? region;
  if (!coords) return null;
  const lit = /"lit"/.test(body) || /lit\s*=\s*1/.test(body);
  return {
    x1: Number(coords[1]),
    y1: Number(coords[2]),
    x2: Number(coords[3]),
    y2: Number(coords[4]),
    lit,
  };
}

/** 解析 `local place = { {x,y}, ... }` 列表。 */
function parsePlaceTable(src: string): [number, number][] {
  const m = src.match(/local\s+place\s*=\s*\{((?:\s*\{[^}]*\}\s*,?\s*)+)\}/);
  if (!m) return [];
  return [...m[1].matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*\}/g)].map((p) => [
    Number(p[1]),
    Number(p[2]),
  ]);
}

/** 提取一个职业的起始层；缺少地图时返回 null。 */
function parseHome(role: string, file: string): QuestHomeData | null {
  const src = read(path.join(nhRoot, 'dat', file));
  const mapMatch = src.match(/des\.map\(\[\[\n([\s\S]*?)\n\]\]\)/);
  if (!mapMatch) return null;
  // 行尾空格去掉；行首空格保留，洞穴地图用它表示石头。
  const map = mapMatch[1].split('\n').map((line) => line.replace(/\s+$/, ''));
  const height = map.length;

  const doors: QuestHomeData['doors'] = [];
  for (const body of calls(src, 'door')) {
    const m = body.match(/^\s*"(locked|closed)"\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
    if (m) doors.push({ state: m[1] as 'locked' | 'closed', x: Number(m[2]), y: Number(m[3]) });
  }

  const place = parsePlaceTable(src);
  const stairs: QuestStair[] = [];
  for (const body of calls(src, 'stair')) {
    const literal = body.match(/^\s*"(up|down)"\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
    if (literal) {
      stairs.push({
        dir: literal[1] as 'up' | 'down',
        x: Number(literal[2]),
        y: Number(literal[3]),
      });
      continue;
    }
    const dir = body.match(/dir\s*=\s*"(up|down)"/);
    const coord = body.match(/coord\s*=\s*place\[(\d+)\]/);
    if (dir && coord) {
      // 原版会 shuffle(place)，这里取洗牌前的顺序；生成端会再校验落点。
      const at = place[Number(coord[1]) - 1];
      if (at) stairs.push({ dir: dir[1] as 'up' | 'down', x: at[0], y: at[1] });
    }
  }

  let branch: QuestHomeData['branch'] = null;
  for (const body of calls(src, 'levregion')) {
    if (!/type\s*=\s*"branch"/.test(body)) continue;
    const m = body.match(/region\s*=\s*\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/);
    if (!m) continue;
    branch = {
      x: Math.floor((Number(m[1]) + Number(m[3])) / 2),
      y: Math.floor((Number(m[2]) + Number(m[4])) / 2),
    };
  }

  const regions: QuestRegion[] = [];
  for (const body of calls(src, 'region')) {
    const region = parseRegion(body);
    if (region) regions.push(region);
  }

  const features: QuestFeature[] = [];
  for (const body of calls(src, 'feature')) {
    const m = body.match(/^\s*"([a-z]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
    if (m) features.push({ type: m[1], x: Number(m[2]), y: Number(m[3]) });
  }
  for (const body of calls(src, 'altar')) {
    const x = body.match(/\bx\s*=\s*(\d+)/);
    const y = body.match(/\by\s*=\s*(\d+)/);
    const align = body.match(/align\s*=\s*"([^"]+)"/);
    if (x && y) {
      features.push({
        type: 'altar',
        x: Number(x[1]),
        y: Number(y[1]),
        ...(align ? { align: align[1] } : {}),
      });
    }
  }

  const traps: QuestTrap[] = [];
  let trapCount = 0;
  for (const body of calls(src, 'trap')) {
    if (!body.trim()) {
      trapCount++;
      continue;
    }
    const m = body.match(/^\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
    if (!m) continue;
    const type = TRAP_NAMES[m[1]];
    if (!type) throw new Error(`${file}: 未知陷阱 ${m[1]}`);
    traps.push({ type, x: Number(m[2]), y: Number(m[3]) });
  }

  // 自检：地图在 80×21 内、字符可识别、门与楼梯不越界。
  const width = Math.max(...map.map((line) => line.length));
  if (width > 80 || height > 21) throw new Error(`${file}: 地图超出 80×21（${width}×${height}）`);
  for (let y = 0; y < height; y++) {
    for (const ch of map[y]) {
      if (!(ch in QUEST_MAP_CHARS)) throw new Error(`${file}: 未知地图字符 ${JSON.stringify(ch)}`);
    }
  }
  const inside = (x: number, y: number): boolean =>
    y >= 0 && y < height && x >= 0 && x < (map[y]?.length ?? 0);
  for (const door of doors)
    if (!inside(door.x, door.y)) throw new Error(`${file}: 门越界 (${door.x},${door.y})`);
  for (const stair of stairs)
    if (!inside(stair.x, stair.y)) throw new Error(`${file}: 楼梯越界 (${stair.x},${stair.y})`);
  if (branch && !inside(branch.x, branch.y))
    throw new Error(`${file}: 分支落脚区越界 (${branch.x},${branch.y})`);

  return { role, map, doors, stairs, branch, regions, features, traps, trapCount };
}

function main(): void {
  const homes: QuestHomeData[] = [];
  for (const [role, file] of Object.entries(ROLE_FILES)) {
    const home = parseHome(role, file);
    if (!home) {
      console.log(`跳过 ${file}：没有 des.map`);
      continue;
    }
    homes.push(home);
  }

  // 自检：每个职业都有地图、下行楼梯与分支落脚区。
  for (const home of homes) {
    if (!home.stairs.some((stair) => stair.dir === 'down')) {
      throw new Error(`${home.role}: 没有下行楼梯`);
    }
    if (!home.branch) throw new Error(`${home.role}: 没有分支落脚区`);
  }
  if (homes.length < 12) throw new Error(`只提取到 ${homes.length} 个职业的任务起始层`);

  const header = [
    '// 本文件由脚本生成，请勿手动修改。',
    '// 来源：nethack/dat/{Arc,Bar,Cav,Hea,Kni,Mon,Pri,Rog,Sam,Tou,Val,Wiz}-strt.lua',
    '// 重新生成：bun tools/extract-nh-quest.ts [NetHack 源码路径]',
    '// 内容派生自 NetHack，按 NetHack General Public License 分发，见 NOTICE.md。',
    '',
    "import type { QuestHomeData } from '../game/quest';",
    '',
  ].join('\n');
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'data', 'quest.gen.ts'),
    `${header}export const QUEST_HOME_LEVELS: QuestHomeData[] = ${JSON.stringify(homes, null, 2)};\n`,
  );
  console.log('wrote src/data/quest.gen.ts');

  const recorded = loadRecordedReference();
  if (!recorded) return;
  const drift = compareReference(recorded, readReferenceState(nhRoot));
  if (drift.upToDate) return;
  console.log('');
  console.log('注意：参考仓库相对记录已发生变化，生成结果可能过期');
  console.log('  重新记录版本：bun run sync:record');
}

main();
