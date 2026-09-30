/**
 * 职业任务起始层的固定地图。
 *
 * 数据由 `tools/extract-nh-quest.ts` 从原版 `dat/{Role}-strt.lua` 提取，
 * 这里只放类型与地图字符表的定义。地图字符沿用 NetHack 的 `char2typ`
 * （见 `src/nhlua.c`）；生成端再把它翻成引擎的瓦片。
 */

/** 原版 `des.door` 的两种初始状态。 */
export interface QuestDoor {
  x: number;
  y: number;
  state: 'locked' | 'closed';
}

/** 原版 `des.stair` 的楼梯。 */
export interface QuestStair {
  dir: 'up' | 'down';
  x: number;
  y: number;
}

/** 原版 `des.region` 的矩形；`lit` 为假表示暗区。 */
export interface QuestRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lit: boolean;
}

/** 原版 `des.feature`/`des.altar` 的设施。 */
export interface QuestFeature {
  /** 引擎侧设施名：fountain、sink、throne、grave、altar。 */
  type: string;
  x: number;
  y: number;
  /** 祭坛的归属原文（coaligned|neutral|noalign），生成端再解析。 */
  align?: string;
}

/** 原版 `des.trap` 的固定陷阱。 */
export interface QuestTrap {
  /** 引擎侧陷阱 id（PIT、SPIKED_PIT 等）。 */
  type: string;
  x: number;
  y: number;
}

/** 一个职业的任务起始层。 */
export interface QuestHomeData {
  /** 职业 id（与 roles.gen.ts 一致）。 */
  role: string;
  /** 地图字符网格；行数与列数按原版文件原样保留。 */
  map: string[];
  doors: QuestDoor[];
  stairs: QuestStair[];
  /** 从主地牢过来的落脚区中心；没有时由生成端自行选择。 */
  branch: { x: number; y: number } | null;
  regions: QuestRegion[];
  features: QuestFeature[];
  /** 写了坐标的陷阱。 */
  traps: QuestTrap[];
  /** `des.trap()` 的个数：位置由生成端随机落点。 */
  trapCount: number;
}

/**
 * 原版地图字符到瓦片语义的映射，取自 `src/nhlua.c` 的 `char2typ`。
 *
 * 值用字符串表示，生成端再映射到 `T` 里的具体编号；
 * `x` 是「可穿透」标记，按房间地面处理。
 */
export const QUEST_MAP_CHARS: Record<string, string> = {
  ' ': 'stone',
  '#': 'corr',
  '.': 'room',
  '-': 'hwall',
  '|': 'vwall',
  '+': 'door',
  A: 'air',
  C: 'cloud',
  S: 'sdoor',
  H: 'scorr',
  '{': 'fountain',
  '\\': 'throne',
  K: 'sink',
  '}': 'moat',
  P: 'pool',
  L: 'lava',
  Z: 'lavawall',
  I: 'ice',
  W: 'water',
  T: 'tree',
  F: 'ironbars',
  x: 'room',
  B: 'crosswall',
  w: 'crosswall',
};
