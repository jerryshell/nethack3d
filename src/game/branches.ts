/**
 * 分支地牢定义。
 *
 * 分支从主地牢的固定楼层进入，有自己的一套层号与生成随机流；
 * 入口层会多出一段「分支楼梯」，分支第一层的上行楼梯回到入口层。
 * 目前只有矿坑：8 层，以侏儒与矮人为主，底层有更厚的宝藏。
 */

export interface BranchDef {
  id: string;
  /** 主地牢里的入口层。 */
  entranceDepth: number;
  /** 分支总层数。 */
  levels: number;
  /** 怪物主题。 */
  monsterTheme?: 'mines' | 'undead';
  /** 底层守关的怪物。 */
  boss?: string;
  /** 底层额外财富。 */
  loot?: { gold: number; gems?: number; items?: number };
  /** 底层是市集（矿镇）：必有一间商店，额外喷泉与坟墓。 */
  town?: boolean;
  /** 额外坟墓数量。 */
  graves?: number;
  /** 额外喷泉数量。 */
  fountains?: number;
}

export const BRANCHES: Record<string, BranchDef> = {
  mines: {
    id: 'mines',
    entranceDepth: 4,
    levels: 8,
    monsterTheme: 'mines',
    loot: { gold: 300, gems: 3 },
    town: true,
    fountains: 3,
    graves: 2,
  },
  vlad: {
    id: 'vlad',
    entranceDepth: 16,
    levels: 4,
    monsterTheme: 'undead',
    boss: 'VAMPIRE_LEADER',
    loot: { gold: 400, gems: 2, items: 2 },
  },
};

/** 某主楼层是不是分支入口。 */
export function branchByEntrance(depth: number): BranchDef | null {
  return Object.values(BRANCHES).find((branch) => branch.entranceDepth === depth) ?? null;
}

/** 按标识取分支定义。 */
export function branchById(id: string | null | undefined): BranchDef | null {
  if (!id || id === 'main') return null;
  return BRANCHES[id] ?? null;
}

/** 某个分支的最大层号；主地牢由 MAX_DEPTH 决定。 */
export function branchMaxDepth(id: string | null | undefined): number {
  return branchById(id)?.levels ?? 0;
}
