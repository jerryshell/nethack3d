/**
 * 推箱（Sokoban）分支。
 *
 * 关卡数据由 `tools/extract-nh-sokoban.ts` 从原版 `dat/soko*.lua` 提取，
 * 4 层各有两个变体；底层是入口，顶层放奖励。这里只放类型与生成逻辑。
 */

/** 原版 `des.object` 在推箱层里的摆放。 */
export interface SokobanSpawn {
  /** 原型 id；与 cls 二选一。 */
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
  branch?: { x: number; y: number };
  prizes?: string[];
  prizeSpots?: [number, number][];
}

export interface SokobanLevelData {
  /** 分支层号：1 是顶层（奖励），4 是底层（入口）。 */
  depth: number;
  variants: SokobanVariant[];
}

/** 原版 `des.object({ class = ... })` 的类别字符到引擎物品类别。 */
export const SOKOBAN_CLASSES: Record<string, string> = {
  '%': 'food',
  '=': 'ring',
  '/': 'wand',
  '?': 'scroll',
  '!': 'potion',
  '[': 'armor',
  ')': 'weapon',
  '(': 'tool',
  '"': 'amulet',
};
