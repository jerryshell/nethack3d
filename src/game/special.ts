/**
 * 特殊楼层表。
 *
 * 每个特殊楼层绑定一个固定深度：布局变体、怪物主题、保证出现的怪物与物品。
 * 没有登记的深度就是普通楼层，分支地牢的固定楼层登记在 `BRANCH_SPECIAL_LEVELS`。
 * 布局与内容都由 `(seed, depth)` 决定，与普通楼层一样可复现。
 */

import type { Alignment } from '../types';

/** 特殊楼层的定义。 */
export interface SpecialLevel {
  /** 稳定标识，写入关卡与状态转储，供测试与调试查看。 */
  id: string;
  /** 布局变体：默认房间走廊，或一整间大房间。 */
  layout?: 'default' | 'bigRoom';
  /** 怪物主题：undead 只生成不死生物，demon 只生成恶魔，mines 以侏儒矮人为主。 */
  monsterTheme?: 'undead' | 'demon' | 'mines';
  /** 保证出现的怪物 id。 */
  monsters?: string[];
  /** 额外放置的物品：原型 id 与数量。 */
  objects?: { proto: string; count: number }[];
  /** 额外坟墓数量。 */
  graves?: number;
  /** 额外喷泉数量（神谕所）。 */
  fountains?: number;
  /** 保证出现的祭坛归属；星界位面用它铺出三座神殿。 */
  altars?: Alignment[];
}

/** 深度到特殊楼层的映射。 */
export const SPECIAL_LEVELS: Record<number, SpecialLevel> = {
  5: { id: 'big_room', layout: 'bigRoom' },
  8: { id: 'oracle', monsters: ['ORACLE'], fountains: 3 },
  20: {
    id: 'medusa',
    monsters: ['MEDUSA'],
    objects: [{ proto: 'STATUE', count: 6 }],
  },
  25: { id: 'valley', monsterTheme: 'undead', graves: 4 },
  27: {
    id: 'castle',
    monsters: ['SOLDIER', 'SOLDIER', 'SERGEANT', 'LIEUTENANT', 'CAPTAIN'],
    objects: [{ proto: 'WAN_WISHING', count: 1 }],
  },
  29: {
    id: 'sanctum',
    monsterTheme: 'demon',
    graves: 2,
    // 死亡之书藏在圣所里，是开启仪式所需的三件圣物之一。
    objects: [{ proto: 'SPE_BOOK_OF_THE_DEAD', count: 1 }],
  },
};

/**
 * 分支地牢的固定楼层，按 `分支 -> 深度` 登记。
 *
 * 星界位面是本作的终点：一整间大厅里立着三座阵营祭坛，
 * 天使与天启骑士守着中央，把尤恩多护身符献给自己阵营的祭坛即登神。
 */
export const BRANCH_SPECIAL_LEVELS: Record<string, Record<number, SpecialLevel>> = {
  planes: {
    1: {
      id: 'astral',
      layout: 'bigRoom',
      monsters: ['DEATH', 'FAMINE', 'PESTILENCE', 'ANGEL', 'ANGEL', 'ARCHON'],
      altars: ['lawful', 'neutral', 'chaotic'],
    },
  },
};

/** 取某分支深度的特殊楼层定义；普通楼层返回 null。 */
export function branchSpecialFor(
  branch: string | null | undefined,
  depth: number,
): SpecialLevel | null {
  if (!branch) return null;
  return BRANCH_SPECIAL_LEVELS[branch]?.[depth] ?? null;
}

/** 取某深度的特殊楼层定义；普通楼层返回 null。 */
export function specialLevelFor(depth: number): SpecialLevel | null {
  return SPECIAL_LEVELS[depth] ?? null;
}

/** 按标识取特殊楼层定义；主地牢与分支地牢都找。 */
export function specialLevelById(id: string | null | undefined): SpecialLevel | null {
  if (!id) return null;
  for (const level of Object.values(SPECIAL_LEVELS)) {
    if (level.id === id) return level;
  }
  for (const byDepth of Object.values(BRANCH_SPECIAL_LEVELS)) {
    for (const level of Object.values(byDepth)) {
      if (level.id === id) return level;
    }
  }
  return null;
}
