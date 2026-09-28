/**
 * 特殊楼层表。
 *
 * 每个特殊楼层绑定一个固定深度：布局变体、怪物主题、保证出现的怪物与物品。
 * 没有登记的深度就是普通楼层。布局与内容都由 `(seed, depth)` 决定，
 * 与普通楼层一样可复现。
 */

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
  29: { id: 'sanctum', monsterTheme: 'demon', graves: 2 },
};

/** 取某深度的特殊楼层定义；普通楼层返回 null。 */
export function specialLevelFor(depth: number): SpecialLevel | null {
  return SPECIAL_LEVELS[depth] ?? null;
}

/** 按标识取特殊楼层定义。 */
export function specialLevelById(id: string | null | undefined): SpecialLevel | null {
  if (!id) return null;
  return Object.values(SPECIAL_LEVELS).find((level) => level.id === id) ?? null;
}
