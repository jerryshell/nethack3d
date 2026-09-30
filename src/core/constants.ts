/**
 * 全局常量：关卡尺寸、瓦片类型、方向、陷阱表、物品生成权重与材质配色。
 *
 * 瓦片编号取自 NetHack 的 include/rm.h，便于与参考源码对照；
 * 当前只生成其中一部分类型。
 */

import type { ObjectClass } from '../types';

/** NetHack 的屏幕级关卡尺寸：宽 80、高 21。 */
export const COLNO = 80;
export const ROWNO = 21;

/** 地牢总层数，底层放着通关用的尤恩多护身符。 */
export const MAX_DEPTH = 30;

/** 瓦片类型。编号沿用 NetHack include/rm.h。 */
export const T = {
  STONE: 0,
  VWALL: 1,
  HWALL: 2,
  TLCORNER: 3,
  TRCORNER: 4,
  BLCORNER: 5,
  BRCORNER: 6,
  CROSSWALL: 7,
  TUWALL: 8,
  TDWALL: 9,
  TLWALL: 10,
  TRWALL: 11,
  DBWALL: 12,
  TREE: 13,
  SDOOR: 14,
  SCORR: 15,
  POOL: 16,
  MOAT: 17,
  WATER: 18,
  LAVA: 19,
  IRONBARS: 20,
  DOOR: 21,
  CORR: 22,
  ROOM: 23,
  STAIRS: 24,
  LADDER: 25,
  FOUNTAIN: 26,
  THRONE: 27,
  SINK: 28,
  GRAVE: 29,
  ALTAR: 30,
  ICE: 31,
  AIR: 34,
  CLOUD: 35,
} as const;

export const isWall = (t: number): boolean => t >= T.VWALL && t <= T.DBWALL;
export const isDoor = (t: number): boolean => t === T.DOOR || t === T.SDOOR;
export const isRoom = (t: number): boolean => t === T.ROOM;
export const isCorr = (t: number): boolean => t === T.CORR || t === T.SCORR;
const isStairs = (t: number): boolean => t === T.STAIRS || t === T.LADDER;
export const isLiquid = (t: number): boolean =>
  t === T.POOL || t === T.MOAT || t === T.WATER || t === T.LAVA;
export const isFurniture = (t: number): boolean =>
  t === T.FOUNTAIN || t === T.THRONE || t === T.SINK || t === T.GRAVE || t === T.ALTAR;

/** 可通行的地形。 */
export function isWalkable(t: number): boolean {
  return (
    t === T.ROOM ||
    isCorr(t) ||
    isDoor(t) ||
    isStairs(t) ||
    isFurniture(t) ||
    t === T.ICE ||
    isLiquid(t)
  );
}

// ---------------------------------------------------------------------------
// 方向：按 NetHack 顺序排列（东、东南、南、西南、西、西北、北、东北）
// ---------------------------------------------------------------------------

type DirectionId = 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' | 'N' | 'NE';

interface Direction {
  id: DirectionId;
  dx: number;
  dy: number;
  key: string;
}

export const DIRS: Direction[] = [
  { id: 'E', dx: 1, dy: 0, key: 'dir.east' },
  { id: 'SE', dx: 1, dy: 1, key: 'dir.southeast' },
  { id: 'S', dx: 0, dy: 1, key: 'dir.south' },
  { id: 'SW', dx: -1, dy: 1, key: 'dir.southwest' },
  { id: 'W', dx: -1, dy: 0, key: 'dir.west' },
  { id: 'NW', dx: -1, dy: -1, key: 'dir.northwest' },
  { id: 'N', dx: 0, dy: -1, key: 'dir.north' },
  { id: 'NE', dx: 1, dy: -1, key: 'dir.northeast' },
];

// ---------------------------------------------------------------------------
// 陷阱：名称与 NetHack 保持一致，当前只实现一部分效果
// ---------------------------------------------------------------------------

/** 按深度返回可随机生成的陷阱类型，越深种类越多。 */
export function randomTrapTypes(depth: number): string[] {
  const common = ['ARROW_TRAP', 'DART_TRAP', 'ROCKTRAP', 'SQKY_BOARD', 'BEAR_TRAP', 'PIT', 'WEB'];
  const pool = [...common];
  if (depth >= 2) pool.push('SPIKED_PIT', 'LANDMINE', 'SLEEPING_GAS_TRAP');
  if (depth >= 3) pool.push('FIRE_TRAP', 'RUST_TRAP', 'TELEP_TRAP', 'HOLE');
  if (depth >= 5) pool.push('MAGIC_TRAP', 'ANTI_MAGIC');
  if (depth >= 7) pool.push('STATUE_TRAP', 'POLY_TRAP', 'ROLLING_BOULDER_TRAP');
  return pool;
}

// ---------------------------------------------------------------------------
// 物品类别的生成权重，来源 src/mkobj.c 的 mkobjprobs[]
// ---------------------------------------------------------------------------

export const MKOBJ_PROBS: [ObjectClass, number][] = [
  ['weapon', 10],
  ['armor', 11],
  ['food', 20],
  ['tool', 8],
  ['gem', 7],
  ['potion', 16],
  ['scroll', 16],
  ['spellbook', 4],
  ['wand', 4],
  ['ring', 3],
  ['amulet', 1],
];
