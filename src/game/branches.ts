/**
 * 分支地牢定义。
 *
 * 分支从主地牢的固定楼层进入，有自己的一套层号与生成随机流；
 * 入口层会多出一段「分支楼梯」，分支第一层的上行楼梯回到入口层。
 * 矿坑以侏儒与矮人为主，底层有更厚的宝藏；巫妖塔是不死主题；
 * 职业任务线从主地牢第 14 层（神谕所往下六层）进入，首层是总部，
 * 底层是仇敌与职业神器。
 */

interface BranchDef {
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
  loot?: { gold: number; gems?: number; items?: number; luckstone?: boolean };
  /** 底层是市集（矿镇）：必有一间商店，额外喷泉与坟墓。 */
  town?: boolean;
  /** 额外坟墓数量。 */
  graves?: number;
  /** 额外喷泉数量。 */
  fountains?: number;
  /** 底层额外守军；按顺序放到宝藏附近。 */
  guards?: string[];
  /** 从主地牢进入时到达的分支层号；缺省为 1（顶层）。推箱从底层进。 */
  entryDepth?: number;
  /** 推箱分支：固定布局与巨石谜题。 */
  sokoban?: boolean;
  /** 职业任务线：内容随角色变化，由会话按职业填充。 */
  quest?: boolean;
}

export const BRANCHES: Record<string, BranchDef> = {
  mines: {
    id: 'mines',
    entranceDepth: 4,
    levels: 8,
    monsterTheme: 'mines',
    loot: { gold: 300, gems: 3, luckstone: true },
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
  sokoban: {
    id: 'sokoban',
    // 原版 dungon.lua：链在神谕所（本实现第 8 层）上，从底层进入。
    entranceDepth: 8,
    levels: 4,
    entryDepth: 4,
    sokoban: true,
  },
  quest: {
    id: 'quest',
    // 神谕所在第 8 层，任务入口按原版 dungeon.lua 的 oracle + 6 偏移。
    entranceDepth: 14,
    levels: 5,
    quest: true,
  },
  ludios: {
    id: 'ludios',
    // 原版格额尔多斯要塞通过传送门进入；本作沿用分支楼梯的简化。
    entranceDepth: 18,
    levels: 1,
    boss: 'CROESUS',
    loot: { gold: 1200, gems: 6, items: 3 },
    guards: ['SOLDIER', 'SOLDIER', 'SERGEANT', 'LIEUTENANT'],
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
