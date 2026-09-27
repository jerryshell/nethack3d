/**
 * 全局常量：关卡尺寸、瓦片类型、方向、陷阱表、物品生成权重与材质配色。
 *
 * 瓦片编号对齐 NetHack 的 include/rm.h，便于与参考源码对照；
 * 当前只生成其中一部分类型。
 */

import type { ObjectClass } from '../types';

/** NetHack 的屏幕级关卡尺寸：宽 80、高 21。 */
export const COLNO = 80;
export const ROWNO = 21;

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

export type TileType = (typeof T)[keyof typeof T];

export const isWall = (t: number): boolean => t >= T.VWALL && t <= T.DBWALL;
export const isDoor = (t: number): boolean => t === T.DOOR || t === T.SDOOR;
export const isRoom = (t: number): boolean => t === T.ROOM;
export const isCorr = (t: number): boolean => t === T.CORR || t === T.SCORR;
export const isStairs = (t: number): boolean => t === T.STAIRS || t === T.LADDER;
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

/** 阻挡移动的地形。当前与 `isWalkable` 互补。 */
export function isPassable(t: number): boolean {
  return isWalkable(t);
}

/** 阻挡视线的地形。 */
export function isOpaque(t: number): boolean {
  return !(isCorr(t) || isRoom(t) || isFurniture(t) || t === T.ICE || t === T.AIR || t === T.CLOUD);
}

/** ASCII 与调试视图使用的字形。 */
export const TILE_GLYPH: Record<number, string> = {
  [T.STONE]: ' ',
  [T.VWALL]: '|',
  [T.HWALL]: '-',
  [T.TLCORNER]: '-',
  [T.TRCORNER]: '-',
  [T.BLCORNER]: '-',
  [T.BRCORNER]: '-',
  [T.CROSSWALL]: '+',
  [T.TUWALL]: '-',
  [T.TDWALL]: '-',
  [T.TLWALL]: '|',
  [T.TRWALL]: '|',
  [T.DBWALL]: '#',
  [T.TREE]: '#',
  [T.SDOOR]: '+',
  [T.SCORR]: '#',
  [T.POOL]: '}',
  [T.MOAT]: '}',
  [T.WATER]: '}',
  [T.LAVA]: '}',
  [T.IRONBARS]: '#',
  [T.DOOR]: '+',
  [T.CORR]: '#',
  [T.ROOM]: '.',
  [T.STAIRS]: '>',
  [T.LADDER]: 'H',
  [T.FOUNTAIN]: '{',
  [T.THRONE]: '\\',
  [T.SINK]: '#',
  [T.GRAVE]: '|',
  [T.ALTAR]: '_',
  [T.ICE]: '.',
  [T.AIR]: ' ',
  [T.CLOUD]: ' ',
};

/** 地形对应的 i18n 键，用于消息文本。 */
export const TILE_NAME_KEY: Record<number, string> = {
  [T.STONE]: 'terrain.stone',
  [T.VWALL]: 'terrain.wall',
  [T.HWALL]: 'terrain.wall',
  [T.DOOR]: 'terrain.door',
  [T.SDOOR]: 'terrain.door',
  [T.CORR]: 'terrain.corridor',
  [T.ROOM]: 'terrain.room',
  [T.STAIRS]: 'terrain.stairs',
  [T.LADDER]: 'terrain.ladder',
  [T.FOUNTAIN]: 'terrain.fountain',
  [T.THRONE]: 'terrain.throne',
  [T.SINK]: 'terrain.sink',
  [T.GRAVE]: 'terrain.grave',
  [T.ALTAR]: 'terrain.altar',
  [T.POOL]: 'terrain.pool',
  [T.MOAT]: 'terrain.moat',
  [T.WATER]: 'terrain.water',
  [T.LAVA]: 'terrain.lava',
  [T.ICE]: 'terrain.ice',
  [T.TREE]: 'terrain.tree',
  [T.IRONBARS]: 'terrain.ironbars',
};

// ---------------------------------------------------------------------------
// 方向：按 NetHack 顺序排列（东、东南、南、西南、西、西北、北、东北）
// ---------------------------------------------------------------------------

export type DirectionId = 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' | 'N' | 'NE';

export interface Direction {
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

export const dirById: Record<DirectionId, Direction> = Object.fromEntries(
  DIRS.map((d) => [d.id, d]),
) as Record<DirectionId, Direction>;

/** 反方向。 */
export const OPPOSITE: Record<DirectionId, DirectionId> = {
  E: 'W',
  W: 'E',
  N: 'S',
  S: 'N',
  NE: 'SW',
  SW: 'NE',
  NW: 'SE',
  SE: 'NW',
};

// ---------------------------------------------------------------------------
// 陷阱：名称与 NetHack 保持一致，当前只实现一部分效果
// ---------------------------------------------------------------------------

export interface TrapType {
  key: string;
  dice: [number, number];
  color: string;
  poison?: boolean;
  holds?: boolean;
  sleeps?: boolean;
  fire?: boolean;
  falls?: boolean;
  teleports?: boolean;
}

export const TRAPS: Record<string, TrapType> = {
  ARROW_TRAP: { key: 'trap.arrow', dice: [1, 6], color: '#aaaaaa' },
  DART_TRAP: { key: 'trap.dart', dice: [1, 4], color: '#aaaaaa', poison: true },
  ROCKTRAP: { key: 'trap.fallingRock', dice: [2, 6], color: '#aa5500' },
  SQKY_BOARD: { key: 'trap.squeakyBoard', dice: [0, 0], color: '#aa5500' },
  BEAR_TRAP: { key: 'trap.bearTrap', dice: [2, 4], color: '#aaaaaa', holds: true },
  LANDMINE: { key: 'trap.landMine', dice: [4, 6], color: '#aa0000' },
  ROLLING_BOULDER_TRAP: { key: 'trap.rollingBoulder', dice: [1, 6], color: '#aaaaaa' },
  SLEEPING_GAS_TRAP: { key: 'trap.sleepingGas', dice: [0, 0], color: '#55ff55', sleeps: true },
  RUST_TRAP: { key: 'trap.rust', dice: [0, 0], color: '#aa5500' },
  FIRE_TRAP: { key: 'trap.fire', dice: [1, 6], color: '#ff5555', fire: true },
  PIT: { key: 'trap.pit', dice: [1, 6], color: '#aa5500' },
  SPIKED_PIT: { key: 'trap.spikedPit', dice: [2, 6], color: '#aaaaaa' },
  HOLE: { key: 'trap.hole', dice: [0, 0], color: '#aa5500', falls: true },
  TELEP_TRAP: { key: 'trap.teleport', dice: [0, 0], color: '#5555ff', teleports: true },
  LEVEL_TELEP: { key: 'trap.levelTeleport', dice: [0, 0], color: '#5555ff' },
  WEB: { key: 'trap.web', dice: [0, 0], color: '#aaaaaa', holds: true },
  STATUE_TRAP: { key: 'trap.statue', dice: [0, 0], color: '#aaaaaa' },
  MAGIC_TRAP: { key: 'trap.magic', dice: [0, 0], color: '#ff55ff' },
  ANTI_MAGIC: { key: 'trap.antiMagic', dice: [0, 0], color: '#55ffff' },
  POLY_TRAP: { key: 'trap.polymorph', dice: [0, 0], color: '#ff55ff' },
  VIBRATING_SQUARE: { key: 'trap.vibratingSquare', dice: [0, 0], color: '#ff55ff' },
};

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

/** 材质到颜色的映射，界面与 3D 模型共用。 */
export const COLOR_BY_MATERIAL: Record<string, string> = {
  IRON: '#aaaaaa',
  METAL: '#aaaaaa',
  COPPER: '#aa5500',
  SILVER: '#ffffff',
  GOLD: '#ffff55',
  PLATINUM: '#ffffff',
  MITHRIL: '#55ffff',
  WOOD: '#aa5500',
  LEATHER: '#aa5500',
  CLOTH: '#aa5500',
  PAPER: '#ffffff',
  GLASS: '#55ffff',
  GEMSTONE: '#ff55ff',
  MINERAL: '#aaaaaa',
  FLESH: '#aa0000',
  VEGGY: '#00aa00',
  BONE: '#ffffff',
  DRAGON_HIDE: '#aa00aa',
  WAX: '#aa5500',
  PLASTIC: '#55ffff',
  LIQUID: '#00aa00',
};
