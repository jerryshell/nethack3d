#!/usr/bin/env bun
/**
 * 数据提取脚本：解析 NetHack 5.0 的推箱关卡（dat/soko*.lua），
 * 生成 `src/data/sokoban.gen.ts`。
 *
 * 用法：
 *   bun tools/extract-nh-sokoban.ts [NetHack 源码路径]
 *
 * 推箱分支共 4 层，每层有两个变体；底层（soko4）是入口，顶层（soko1）
 * 放奖励（75% 次元袋、25% 反射护身符）。地图字符沿用原版：
 * `-`/`|` 是墙，`.` 是房间地面，`+` 是门，空格是岩石。
 */

import fs from 'node:fs';
import path from 'node:path';
import { compareReference, loadRecordedReference, readReferenceState } from './nethack-ref';

const projectRoot = path.resolve(import.meta.dir, '..');
const nhRoot = path.resolve(
  process.argv[2] || process.env.NETHACK_SRC || path.join(projectRoot, '..', 'nethack'),
);

/** 生成时需要的固定怪物或物品。 */
export interface SokobanSpawn {
  /** 直接指定原型 id。 */
  id?: string;
  /** 按物品类别随机：`%` 食物、`=` 戒指、`/` 魔杖、`?` 卷轴。 */
  cls?: string;
  x: number;
  y: number;
  buc?: string;
}

export interface SokobanDoor {
  x: number;
  y: number;
  state: 'locked' | 'closed';
}

export interface SokobanVariant {
  id: string;
  map: string[];
  boulders: [number, number][];
  traps: { id: string; x: number; y: number }[];
  stairs: { dir: 'up' | 'down'; x: number; y: number }[];
  doors: SokobanDoor[];
  objects: SokobanSpawn[];
  monsters: { id: string; x?: number; y?: number }[];
  /** 入口层（soko4）的分支楼梯位置。 */
  branch?: { x: number; y: number };
  /** 顶层奖品的候选组合与落点。 */
  prizes?: string[];
  prizeSpots?: [number, number][];
}

export interface SokobanLevelData {
  /** 分支层号：1 是顶层（奖励），4 是底层（入口）。 */
  depth: number;
  variants: SokobanVariant[];
}

/** Lua 的陷阱名映射到引擎的陷阱 id。 */
const TRAP_NAMES: Record<string, string> = {
  pit: 'PIT',
  hole: 'HOLE',
  'rolling boulder': 'ROLLING_BOULDER_TRAP',
  'sleeping gas': 'SLEEPING_GAS_TRAP',
  dart: 'DART_TRAP',
  arrow: 'ARROW_TRAP',
  'anti magic': 'ANTI_MAGIC',
  web: 'WEB',
  statue: 'STATUE_TRAP',
  magic: 'MAGIC_TRAP',
  fire: 'FIRE_TRAP',
  teleport: 'TELEP_TRAP',
  'level teleport': 'LEVEL_TELEP',
};

const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** 提取一个文件里的地图、物品、陷阱、楼梯与门。 */
function parseVariant(file: string, id: string): SokobanVariant {
  const src = read(path.join(nhRoot, 'dat', file));
  const mapMatch = src.match(/des\.map\(\[\[\n([\s\S]*?)\n\]\]\)/);
  if (!mapMatch) throw new Error(`${file}: 找不到 des.map`);
  const map = mapMatch[1].split('\n').map((line) => line.replace(/\s+$/, ''));

  const boulders: [number, number][] = [];
  for (const m of src.matchAll(/des\.object\(\s*"boulder"\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
    boulders.push([Number(m[1]), Number(m[2])]);
  }

  const traps: SokobanVariant['traps'] = [];
  for (const m of src.matchAll(/des\.trap\(\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
    const trap = TRAP_NAMES[m[1]];
    if (!trap) throw new Error(`${file}: 未知陷阱 ${m[1]}`);
    traps.push({ id: trap, x: Number(m[2]), y: Number(m[3]) });
  }

  const stairs: SokobanVariant['stairs'] = [];
  for (const m of src.matchAll(/des\.stair\(\s*"(up|down)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
    stairs.push({ dir: m[1] as 'up' | 'down', x: Number(m[2]), y: Number(m[3]) });
  }

  const doors: SokobanDoor[] = [];
  for (const m of src.matchAll(/des\.door\(\s*"(locked|closed)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
    doors.push({ state: m[1] as 'locked' | 'closed', x: Number(m[2]), y: Number(m[3]) });
  }

  // 带坐标的字符串形式：des.object("scroll of earth", 01, 09)
  const objects: SokobanSpawn[] = [];
  for (const m of src.matchAll(
    /des\.object\(\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\)(?!\s*\);)/g,
  )) {
    if (m[1] === 'boulder') continue;
    objects.push({ id: m[1], x: Number(m[2]), y: Number(m[3]) });
  }
  // 按类别随机：des.object({ class = "%" })
  for (const m of src.matchAll(/des\.object\(\{\s*class\s*=\s*"([^"]+)"\s*\}\)/g)) {
    objects.push({ cls: m[1], x: -1, y: -1 });
  }
  // 指定 id 的条目（奖励与吓退卷轴），坐标由 place 给出或由奖励逻辑决定。
  const idObjects: { id: string; buc?: string }[] = [];
  for (const m of src.matchAll(
    /des\.object\(\{\s*id\s*=\s*"([^"]+)"[^}]*?(?:buc\s*=\s*"([^"]+)")?[^}]*\}\)/g,
  )) {
    idObjects.push({ id: m[1], buc: m[2] });
  }

  const monsters: SokobanVariant['monsters'] = [];
  for (const m of src.matchAll(/des\.monster\(\{\s*id\s*=\s*"([^"]+)"/g)) {
    monsters.push({ id: m[1] });
  }

  const branchMatch = src.match(
    /des\.levregion\(\{\s*region\s*=\s*\{(\d+),(\d+),(\d+),(\d+)\}\s*,\s*type\s*=\s*"branch"\s*\}\)/,
  );
  const branch = branchMatch ? { x: Number(branchMatch[1]), y: Number(branchMatch[2]) } : undefined;

  // 顶层奖励：place 里的候选点与 des.object 的 id 列表。
  const prizeSpots: [number, number][] = [];
  for (const m of src.matchAll(/place:set\((\d+),(\d+)\)/g)) {
    prizeSpots.push([Number(m[1]), Number(m[2])]);
  }
  const prizes = prizeSpots.length
    ? idObjects.filter((o) => !o.id.startsWith('scroll')).map((o) => o.id)
    : undefined;

  // 吓退卷轴放在奖励点旁边，坐标继承奖励点（原版用 coord = pt）。
  for (const o of idObjects) {
    if (o.id.startsWith('scroll')) {
      objects.push({ id: o.id, x: -1, y: -1, buc: o.buc });
    }
  }

  return {
    id,
    map,
    boulders,
    traps,
    stairs,
    doors,
    objects,
    monsters,
    branch,
    prizes: prizes?.length ? prizes : undefined,
    prizeSpots: prizeSpots.length ? prizeSpots : undefined,
  };
}

function main(): void {
  const levels: SokobanLevelData[] = [];
  for (const depthName of [1, 2, 3, 4]) {
    const variants: SokobanVariant[] = [];
    for (const variant of [1, 2]) {
      variants.push(parseVariant(`soko${depthName}-${variant}.lua`, `soko${depthName}-${variant}`));
    }
    levels.push({ depth: depthName, variants });
  }

  // 自检：顶层有奖励，底层有入口楼梯，巨石都落在地面格上。
  const top = levels.find((l) => l.depth === 1);
  if (!top?.variants.every((v) => (v.prizes?.length ?? 0) > 0))
    throw new Error('self-check failed: 顶层缺少奖励');
  const bottom = levels.find((l) => l.depth === 4);
  if (!bottom?.variants.every((v) => !!v.branch))
    throw new Error('self-check failed: 底层缺少分支楼梯');
  for (const level of levels) {
    for (const variant of level.variants) {
      if (variant.map.length < 5) throw new Error(`${variant.id}: 地图太短`);
      const height = variant.map.length;
      const width = Math.max(...variant.map.map((l) => l.length));
      const inside = (x: number, y: number) =>
        y >= 0 && y < height && x >= 0 && x < variant.map[y].length;
      for (const [x, y] of variant.boulders) {
        if (!inside(x, y) || !'.|+'.includes(variant.map[y][x]))
          throw new Error(`${variant.id}: 巨石落在非法格 (${x},${y})`);
      }
      for (const t of variant.traps) {
        if (!inside(t.x, t.y)) throw new Error(`${variant.id}: 陷阱越界 (${t.x},${t.y})`);
      }
      const boulders = new Set(variant.boulders.map(([x, y]) => `${x},${y}`));
      if (boulders.size !== variant.boulders.length)
        throw new Error(`${variant.id}: 同一格有多块巨石`);
      if (!variant.stairs.length && level.depth !== 4) throw new Error(`${variant.id}: 缺少楼梯`);
      void width;
    }
  }

  const emit = (data: SokobanLevelData[]): string => {
    const header = [
      '// 本文件由脚本生成，请勿手动修改。',
      '// 来源：nethack/dat/soko{1..4}-{1,2}.lua',
      '// 重新生成：bun tools/extract-nh-sokoban.ts [NetHack 源码路径]',
      '// 内容派生自 NetHack，按 NetHack General Public License 分发，见 NOTICE.md。',
      '',
      "import type { SokobanLevelData } from '../game/sokoban';",
      '',
    ].join('\n');
    return `${header}export const SOKOBAN_LEVELS: SokobanLevelData[] = ${JSON.stringify(data, null, 2)};\n`;
  };

  fs.writeFileSync(path.join(projectRoot, 'src', 'data', 'sokoban.gen.ts'), emit(levels));
  console.log('wrote src/data/sokoban.gen.ts');

  const recorded = loadRecordedReference();
  if (!recorded) return;
  const drift = compareReference(recorded, readReferenceState(nhRoot));
  if (drift.upToDate) return;
  console.log('');
  console.log('注意：参考仓库相对记录已发生变化，生成结果可能过期');
  console.log('  重新记录版本：bun run sync:record');
}

main();
