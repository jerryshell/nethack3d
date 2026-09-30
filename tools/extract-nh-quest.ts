#!/usr/bin/env bun
/**
 * 数据提取脚本：解析 NetHack 5.0 的职业任务固定层，生成 `src/data/quest.gen.ts`。
 *
 * 用法：
 *   bun tools/extract-nh-quest.ts [NetHack 源码路径]
 *
 * 目前提取两类：
 *   - 起始层 `dat/*-strt.lua`（12 个职业；浪人没有 `des.map`）；
 *   - 搜索层 `dat/*-loca.lua`（13 个职业）。
 *
 * 只提取固定地图本身：字符网格、门、楼梯、分支落脚区、亮暗区域、
 * 固定设施与陷阱。领袖、护卫、怪物与物品仍由游戏侧按职业数据布置，
 * 因此这里不解析 `des.monster`/`des.object`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { compareReference, loadRecordedReference, readReferenceState } from './nethack-ref';
import type {
  QuestFeature,
  QuestFixedLevel,
  QuestRegion,
  QuestStair,
  QuestTrap,
} from '../src/game/quest';
import { QUEST_MAP_CHARS } from '../src/game/quest';

const projectRoot = path.resolve(import.meta.dir, '..');
const nhRoot = path.resolve(
  process.argv[2] || process.env.NETHACK_SRC || path.join(projectRoot, '..', 'nethack'),
);

/** 职业 id 到原版文件前缀的映射。 */
const ROLE_PREFIXES: Record<string, string> = {
  ARCHEOLOGIST: 'Arc',
  BARBARIAN: 'Bar',
  CAVE_DWELLER: 'Cav',
  HEALER: 'Hea',
  KNIGHT: 'Kni',
  MONK: 'Mon',
  CLERIC: 'Pri',
  RANGER: 'Ran',
  ROGUE: 'Rog',
  SAMURAI: 'Sam',
  TOURIST: 'Tou',
  VALKYRIE: 'Val',
  WIZARD: 'Wiz',
};

/** Lua 的陷阱名映射到引擎的陷阱 id。 */
const TRAP_NAMES: Record<string, string> = {
  pit: 'PIT',
  'spiked pit': 'SPIKED_PIT',
  'trap door': 'HOLE',
  hole: 'HOLE',
  'sleep gas': 'SLEEPING_GAS_TRAP',
  board: 'SQKY_BOARD',
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

/** 解析 `local align = { ... }`；没有本地定义时用 nhlib.lua 的全居表。 */
function parseAlignTable(src: string): string[] {
  const m = src.match(/local\s+align\s*=\s*\{([^}]*)\}/);
  if (!m) return ['law', 'neutral', 'chaos'];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((a) => a[1]);
}

/** 提取一个固定任务层；文件缺少 `des.map` 时返回 null。 */
function parseFixedLevel(role: string, file: string): QuestFixedLevel | null {
  const src = read(path.join(nhRoot, 'dat', file));
  const mapMatch = src.match(/des\.map\(\[\[\n([\s\S]*?)\n\]\]\)/);
  if (!mapMatch) return null;
  // 行尾空格去掉；行首空格保留，洞穴地图用它表示石头。
  const map = mapMatch[1].split('\n').map((line) => line.replace(/\s+$/, ''));
  const height = map.length;
  const width = Math.max(...map.map((line) => line.length));

  const doors: QuestFixedLevel['doors'] = [];
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
    const numeric = body.match(/coord\s*=\s*place\[(\d+)\]/);
    const named = /coord\s*=\s*place\[placeidx\]/.test(body);
    if (dir && (numeric || named)) {
      // 原版会 shuffle(place) 或随机 placeidx，这里取第一项；生成端会再校验落点。
      const at = place[(named ? 1 : Number(numeric?.[1])) - 1];
      if (at) stairs.push({ dir: dir[1] as 'up' | 'down', x: at[0], y: at[1] });
    }
  }

  let branch: QuestFixedLevel['branch'] = null;
  for (const body of calls(src, 'levregion')) {
    if (!/type\s*=\s*"branch"/.test(body)) continue;
    const m = body.match(/region\s*=\s*\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/);
    if (!m) continue;
    branch = {
      x: Math.floor((Number(m[1]) + Number(m[3])) / 2),
      y: Math.floor((Number(m[2]) + Number(m[4])) / 2),
    };
  }
  // 有些目标层用 stair-up 的 levregion 指定上行楼梯；
  // region_islev 时坐标是屏幕绝对的，需减去居中偏移。
  for (const body of calls(src, 'levregion')) {
    if (!/type\s*=\s*"stair-up"/.test(body)) continue;
    const m = body.match(/region\s*=\s*\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/);
    if (!m) continue;
    const absolute = /region_islev\s*=\s*1/.test(body);
    const ox = Math.floor((80 - width) / 2);
    const oy = Math.floor((21 - height) / 2);
    stairs.push({
      dir: 'up',
      x: Math.floor((Number(m[1]) + Number(m[3])) / 2) - (absolute ? ox : 0),
      y: Math.floor((Number(m[2]) + Number(m[4])) / 2) - (absolute ? oy : 0),
    });
  }

  const regions: QuestRegion[] = [];
  for (const body of calls(src, 'region')) {
    const region = parseRegion(body);
    if (region) regions.push(region);
  }

  const alignTable = parseAlignTable(src);
  const features: QuestFeature[] = [];
  for (const body of calls(src, 'feature')) {
    const m = body.match(/^\s*"([a-z]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
    if (m) features.push({ type: m[1], x: Number(m[2]), y: Number(m[3]) });
  }
  for (const body of calls(src, 'altar')) {
    const x = body.match(/\bx\s*=\s*(\d+)/);
    const y = body.match(/\by\s*=\s*(\d+)/);
    const named = body.match(/align\s*=\s*"([^"]+)"/);
    const indexed = body.match(/align\s*=\s*align\[(\d+)\]/);
    if (!x || !y) continue;
    const align = named ? named[1] : indexed ? alignTable[Number(indexed[1]) - 1] : undefined;
    features.push({
      type: 'altar',
      x: Number(x[1]),
      y: Number(y[1]),
      ...(align ? { align } : {}),
    });
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

  // 目标层的任务神器 object 与仇敌同格，用它当仇敌落脚点；其它层为空。
  let goal: { x: number; y: number } | null = null;
  for (const body of calls(src, 'object')) {
    if (!/name\s*=\s*"The /.test(body)) continue;
    const xy = body.match(/x\s*=\s*(\d+)\s*,\s*y\s*=\s*(\d+)/);
    if (xy) {
      goal = { x: Number(xy[1]), y: Number(xy[2]) };
      break;
    }
    const numeric = body.match(/coord\s*=\s*place\[(\d+)\]/);
    const named = /coord\s*=\s*place\[placeidx\]/.test(body);
    if (numeric || named) {
      const at = place[(named ? 1 : Number(numeric?.[1])) - 1];
      if (at) {
        goal = { x: at[0], y: at[1] };
        break;
      }
    }
  }

  // 自检：地图在 80×21 内、字符可识别、门与楼梯不越界。
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
  // 原版有些楼梯故意放在地图外（如牧师搜索层的上行楼梯）；
  // 生成端会在可行走范围内兜底，这里只跳过越界项。
  for (let i = stairs.length - 1; i >= 0; i--) {
    if (inside(stairs[i].x, stairs[i].y)) continue;
    console.log(`跳过 ${file} 地图外的楼梯 (${stairs[i].x},${stairs[i].y})`);
    stairs.splice(i, 1);
  }
  if (branch && !inside(branch.x, branch.y))
    throw new Error(`${file}: 分支落脚区越界 (${branch.x},${branch.y})`);

  return { role, map, doors, stairs, branch, regions, features, traps, trapCount, goal };
}

/** 按文件后缀提取一类固定层；缺少地图的角色跳过。 */
function extractKind(kind: 'strt' | 'loca' | 'goal'): QuestFixedLevel[] {
  const out: QuestFixedLevel[] = [];
  for (const [role, prefix] of Object.entries(ROLE_PREFIXES)) {
    const file = `${prefix}-${kind}.lua`;
    const level = parseFixedLevel(role, file);
    if (!level) {
      console.log(`跳过 ${file}：没有 des.map`);
      continue;
    }
    if (kind === 'strt') {
      if (!level.stairs.some((stair) => stair.dir === 'down')) {
        throw new Error(`${role}: 起始层没有下行楼梯`);
      }
      if (!level.branch) throw new Error(`${role}: 起始层没有分支落脚区`);
    }
    out.push(level);
  }
  return out;
}

function main(): void {
  const homes = extractKind('strt');
  const locates = extractKind('loca');
  const goals = extractKind('goal');
  if (homes.length < 12) throw new Error(`只提取到 ${homes.length} 个起始层`);
  if (locates.length < 12) throw new Error(`只提取到 ${locates.length} 个搜索层`);
  if (goals.length < 13) throw new Error(`只提取到 ${goals.length} 个目标层`);
  for (const goal of goals) {
    if (!goal.goal) throw new Error(`${goal.role}: 目标层没有神器坐标`);
  }

  const header = [
    '// 本文件由脚本生成，请勿手动修改。',
    '// 来源：nethack/dat/{Role}-strt.lua、{Role}-loca.lua 与 {Role}-goal.lua',
    '// 重新生成：bun tools/extract-nh-quest.ts [NetHack 源码路径]',
    '// 内容派生自 NetHack，按 NetHack General Public License 分发，见 NOTICE.md。',
    '',
    "import type { QuestFixedLevel } from '../game/quest';",
    '',
  ].join('\n');
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'data', 'quest.gen.ts'),
    `${header}export const QUEST_HOME_LEVELS: QuestFixedLevel[] = ${JSON.stringify(homes, null, 2)};\n\n` +
      `export const QUEST_LOCATE_LEVELS: QuestFixedLevel[] = ${JSON.stringify(locates, null, 2)};\n\n` +
      `export const QUEST_GOAL_LEVELS: QuestFixedLevel[] = ${JSON.stringify(goals, null, 2)};\n`,
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
