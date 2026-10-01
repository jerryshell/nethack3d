/**
 * 全局类型定义。
 *
 * 数据类类型（MonsterData / ObjectData / RoleData / RaceData）描述由 tools 目录
 * 下的提取脚本从 NetHack 5.0 C 头文件生成的结构；其余类型描述运行时对象。
 */

// ---------------------------------------------------------------------------
// 由 C 头文件提取的游戏数据
// ---------------------------------------------------------------------------

/** 怪物的一次攻击：攻击方式、伤害类型、骰子（数量与面数）。 */
export interface MonsterAttack {
  at: string;
  ad: string;
  dice: [number, number];
}

/** 怪物原型，对应 NetHack 的 struct permonst。 */
export interface MonsterData {
  /** NetHack 枚举名，例如 GIANT_ANT。 */
  id: string;
  name: string;
  /** 地图字形，单字符。 */
  glyph: string;
  /** 字形类名，例如 S_ANT。 */
  sym: string;
  symClass: string;
  lvl: number;
  speed: number;
  ac: number;
  mr: number;
  align: number;
  /** 生成频率（G_FREQ），0 表示不随机生成。 */
  freq: number;
  genFlags: string[];
  attacks: MonsterAttack[];
  weight: number;
  nutrition: number;
  sound: string;
  size: MonsterSize;
  /** 抗性列表（MR_*）。 */
  resists: string[];
  /** 赋予其他生物的抗性（MR_*）。 */
  confers: string[];
  /** 行为标志（M1_*、M2_*、M3_*）。 */
  flags: string[];
  diff: number;
  /** 十六进制颜色，用于 3D 模型与界面。 */
  color: string;
}

export type MonsterSize =
  | 'MZ_TINY'
  | 'MZ_SMALL'
  | 'MZ_MEDIUM'
  | 'MZ_HUMAN'
  | 'MZ_LARGE'
  | 'MZ_HUGE'
  | 'MZ_GIGANTIC';

export type ObjectClass =
  | 'weapon'
  | 'armor'
  | 'food'
  | 'potion'
  | 'scroll'
  | 'spellbook'
  | 'wand'
  | 'ring'
  | 'amulet'
  | 'tool'
  | 'gem'
  | 'rock'
  | 'ball'
  | 'coin';

/** 物品原型，对应 NetHack 的 struct objclass 中的静态部分。 */
export interface ObjectData {
  id: string;
  name: string;
  cls: ObjectClass;
  /** 提取时使用的类宏名，例如 WEAPON、ARMOR、SPELL。 */
  kind: string;
  /** 未鉴定外观，例如药水的 ruby、魔杖的 glass。 */
  appr?: string | null;
  prob: number;
  weight: number;
  cost: number;
  material: string;
  color: string;
  /** 占位条目（WAN1..WAN3），只用于补齐外观池。 */
  dummy?: boolean;

  // 武器
  dmg?: string;
  dmgLarge?: string;
  hit?: number;
  skill?: string | null;
  launcher?: string | null;
  wtype?: string | null;

  // 护甲
  ac?: number;
  slot?: ArmorSlot;
  blocking?: number;

  // 食物
  nutrition?: number;
  delay?: number;
  tin?: string;

  // 药水 / 戒指 / 护身符 / 法术书
  power?: string;
  spec?: number;
  spellClass?: string;
  level?: number;

  // 卷轴 / 魔杖
  label?: string;
  dir?: string;
  charges?: boolean;

  // 宝石与岩石
  gval?: number;
  mohs?: number;

  // 工具
  tool?: string;
  container?: boolean;
  eyewear?: boolean;
}

type ArmorSlot = 'suit' | 'shield' | 'helm' | 'gloves' | 'boots' | 'cloak' | 'shirt';

/** 属性升级曲线：初始与每级固定值/随机值。 */
export interface RoleAdvance {
  infix: number;
  inrnd: number;
  lofix: number;
  lornd: number;
  hifix: number;
  hirnd: number;
}

export interface Attributes {
  str: number;
  int: number;
  wis: number;
  dex: number;
  con: number;
  cha: number;
}

export interface RoleData {
  id: string;
  names: { male: string; female: string | null };
  attrs: Attributes;
  attrdist: Attributes;
  hp: RoleAdvance;
  energy: RoleAdvance;
  xlev: number;
  initRecord: number;
  spell: {
    base: number;
    heal: number;
    shield: number;
    armor: number;
    stat: string;
    spec: string;
    bonus: number;
  };
  /** 职业任务线：来自 src/role.c 的 quest 字段。 */
  quest: RoleQuest;
  /** 允许的种族/性别/阵营位掩码。 */
  allowMask: number;
  aligns: Alignment[];
  races: string[];
  genders: Gender[];
}

/** 职业任务线的领袖、护卫、仇敌与地名。 */
interface RoleQuest {
  /** 任务领袖的怪物 id。 */
  leader: string;
  /** 任务护卫的怪物 id；没有时为空。 */
  guardian: string | null;
  /** 任务仇敌的怪物 id。 */
  nemesis: string;
  /** 任务层主题怪物类，取自 role.c 的 enemy1sym/enemy2sym。 */
  enemies: string[];
  /** 任务总部地名，例如 the College of Archeology。 */
  home: string;
  /** 任务目标地名，例如 the Tomb of the Toltec Kings。 */
  goal: string;
  /** 任务文件前缀，例如 Arc。 */
  prefix: string;
}

export interface RaceData {
  id: string;
  name: string;
  adj: string;
  filecode: string;
  names: { male: string; female: string };
  attrs: Attributes;
  attrmax: Attributes;
  hp: RoleAdvance;
  energy: RoleAdvance;
  allowMask: number;
  aligns: Alignment[];
}

export type Alignment = 'lawful' | 'neutral' | 'chaotic';
export type Gender = 'male' | 'female';

// ---------------------------------------------------------------------------
// 地牢
// ---------------------------------------------------------------------------

export interface Room {
  lx: number;
  ly: number;
  hx: number;
  hy: number;
  index: number;
  /** 商店房间由会话在其中摆放店主与货物。 */
  type: 'room' | 'shop' | 'morgue' | 'zoo' | 'beehive' | 'barracks' | 'leprechaun' | 'temple';
  /** 商店种类；非商店房间为空。 */
  shopType?: ShopType;
  lit: boolean;
}

/** 商店种类，决定店内的货品类别与招呼语。 */
export type ShopType =
  | 'general'
  | 'weapon'
  | 'armor'
  | 'potion'
  | 'scroll'
  | 'wand'
  | 'book'
  | 'jewelry'
  | 'food'
  | 'tool';

export interface DoorState {
  closed: boolean;
  locked: boolean;
  broken: boolean;
  /** 门上的机关：开门时触发一次。 */
  trapped?: boolean;
  /** 机关是否已被搜索发现（影响提示文字）。 */
  trapKnown?: boolean;
  /** 密门：未发现前按墙渲染与阻挡，搜索或探门后现形。 */
  hidden?: boolean;
  /** 吊桥：不参与「前后通道、两侧墙」的门形审计，初始上锁。 */
  drawbridge?: boolean;
}

interface TrapState {
  type: string;
  seen: boolean;
}

interface StairRef {
  x: number;
  y: number;
  dir: 'up' | 'down' | 'branch';
  /** dir 为 branch 时，通往哪个分支。 */
  branch?: string;
}

export interface FeatureState {
  type: string;
  /** 喷泉干涸、水槽损坏、坟墓挖开。 */
  depleted?: boolean;
  /** 王座坐过一次后不再有效果。 */
  used?: boolean;
  /** 祭坛归属的阵营；未设置表示中立神坛（摩洛克）。 */
  align?: Alignment;
}

export interface GroundPile {
  x: number;
  y: number;
  items: ItemInstance[];
}

export interface Level {
  depth: number;
  width: number;
  height: number;
  /** 瓦片类型，取值见 core/constants.ts 的 T。 */
  tiles: Uint8Array;
  /** 是否曾经看到过。 */
  seen: Uint8Array;
  /** 房间是否照明。 */
  lit: Uint8Array;
  rooms: Room[];
  doors: Map<number, DoorState>;
  traps: Map<number, TrapState>;
  features: Map<number, FeatureState>;
  stairs: StairRef[];
  up: { x: number; y: number } | null;
  down: { x: number; y: number } | null;
  start: { x: number; y: number } | null;
  objects: GroundPile[];
  monsters: Monster[];
  /** 是否已经生成过怪物与物品。 */
  populated?: boolean;
  /** 商店下次补货的回合。 */
  shopRestockAt?: number;
  /** 特殊楼层标识；普通楼层为空。 */
  special?: string | null;
  /** 推箱层的变体 id（soko1-1 等），供会话放固定怪物。 */
  sokobanVariant?: string;
  /** 固定任务目标层的仇敌落脚点（原版神器的坐标）。 */
  questGoalAnchor?: { x: number; y: number };
  /** 要塞吊桥靠着的 DBWALL 瓦片下标；放桥时开通、收桥时封回。 */
  drawbridgeWall?: number;
  /** 分支标识；主地牢为空。 */
  branch?: string | null;
  /** 玩家是否到过该层。 */
  visited?: boolean;
  /** 瓦片结构版本号；挖墙或设施消失时递增，渲染层据此重建网格。 */
  revision?: number;
  /** 运行时被改造过的瓦片下标；存档只记录这些差异。 */
  changedTiles?: Set<number>;
}

// ---------------------------------------------------------------------------
// 运行时实体
// ---------------------------------------------------------------------------

/** 物品实例。proto 指向静态原型，其余字段随游戏进程变化。 */
export interface ItemInstance {
  uid: number;
  proto: ObjectData;
  id: string;
  quantity: number;
  enchant: number;
  /** 是否已鉴定。 */
  known: boolean;
  buc: 'blessed' | 'uncursed' | 'cursed';
  appearance: string | null;
  charges?: number;
  gold?: boolean;
  /** 职业神器标识；设置后显示神器名。 */
  artifact?: string;
  /** 容器内部物品（箱子、袋子等）。 */
  contents?: ItemInstance[];
  /** 商店货品：尚未付款，结账或卖出时翻转。 */
  unpaid?: boolean;
  /** 尸体：记录怪物原型 id，营养与内在抗性都从它推导。 */
  corpse?: string;
  /** 尸体的形成回合；用于判断腐败程度。 */
  age?: number;
  /** 罐头内容：记录怪物原型 id，开启后固定。 */
  tin?: string;
  /** 起始装备标记，装备后清空。 */
  equipped?: EquipIntent | null;
  /** 涂过油脂：下次锈蚀或摧毁会消耗它并保住装备。 */
  greased?: boolean;
}

export type EquipIntent = 'wield' | 'wear' | 'offhand' | null;

export interface Monster {
  id: number;
  data: MonsterData;
  /** 怪物护甲等级，取自原型数据。 */
  readonly ac: number;
  /** 英文名，用于回退显示。 */
  readonly name: string;
  /** i18n 键（mon.XXXX），界面据此查找译名。 */
  readonly nameKey: string;
  x: number;
  y: number;
  /** NetHack 的 m_lev。 */
  mlev: number;
  mhp: number;
  mhpmax: number;
  /** 行动力累积，达到 12 行动一次。 */
  mv: number;
  asleep: boolean;
  fleeing: boolean;
  dead: boolean;
  /** 被玩家挑衅过的和平生物转为敌对。 */
  angry: boolean;
  /** 驯服的宠物：跟随玩家、攻击敌对怪物，不会攻击玩家。 */
  tame: boolean;
  /** 驯服度：喂食提升，达到上限后成长一次。 */
  tameness: number;
  /** 加速剩余回合：速度翻倍。 */
  hasted: number;
  /** 缓速剩余回合：速度减半（最低 1）。 */
  slowed: number;
  /** 拟形怪的伪装：物品原型 id（如 BOULDER），被识破后清空。 */
  disguise?: string | null;
  /** 定身剩余回合：大于 0 时无法行动（定身魔杖）。 */
  stasis?: number;
  /** 被取消：失去所有非物理的特殊攻击。 */
  cancelled?: boolean;
  /** 任务仇敌是否已经叫过阵。 */
  taunted?: boolean;
  /** 拴了牵引绳：只能在玩家两格内活动。 */
  leashed?: boolean;
  /** 宠物的饱食度：900 为饱腹，归零会变野。 */
  hunger?: number;
  /** 平和生物：数据默认敌对、但因站位/阵营不主动出手（如同阵营神殿的天使）。 */
  peaceful?: boolean;
  /** 已知陷阱的位掩码：见过触发后就会绕开，对应原版的 mtrapseen。 */
  trapSeen?: number;
  /** 会收集物品的怪物（M2_COLLECT）携带的东西；死亡时掉落。 */
  carried?: ItemInstance[];
}

export type EquipmentSlot =
  | 'weapon'
  | 'shield'
  | 'suit'
  | 'cloak'
  | 'helm'
  | 'gloves'
  | 'boots'
  | 'shirt'
  | 'amulet'
  | 'ringLeft'
  | 'ringRight'
  | 'eyes';

export type Equipment = Partial<Record<EquipmentSlot, ItemInstance>>;

export interface Player {
  name: string;
  role: RoleData;
  race: RaceData;
  align: Alignment;
  gender: Gender;
  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  pw: number;
  maxPw: number;
  /** 属性。 */
  str: number;
  int: number;
  wis: number;
  dex: number;
  con: number;
  cha: number;
  hitInc: number;
  luck: number;
  gold: number;
  /** 饱食度，900 为正常，0 以下会昏倒。 */
  hunger: number;
  acBonus: number;
  /** 只读派生属性，由 getter 计算。 */
  readonly ac: number;
  readonly weapon: ItemInstance | null;
  readonly damageBonus: number;
  inventory: ItemInstance[];
  equipment: Equipment;
  x: number;
  y: number;
  dead: boolean;
  /** 剩余回合数状态。 */
  blind: number;
  confused: number;
  invisible: number;
  /** 睡眠剩余回合；大于 0 时无法行动。 */
  sleep: number;
  /** 被缠住剩余回合；大于 0 时无法移动。 */
  held: number;
  /** 眩晕剩余回合；大于 0 时行动可能失手。 */
  stun: number;
  /** 石化剩余回合；归零即死亡，完全治疗药水可解。 */
  petrifying: number;
  /** 加速剩余回合；大于 0 时每次行动不给怪物回合。 */
  hasted: number;
  /** 浮空剩余回合；大于 0 时飘浮，可越过虚空与地面陷阱。 */
  levitating: number;
  /** 溺水累积回合；站在深水里时递增，脱离后归零。 */
  drowning: number;
  /** 疾病剩余回合；大于 0 时停止自然回复并周期性掉血。 */
  sick: number;
  /** 阵营记录：正数表示神满意，负数表示失望，范围 [-128, 127]。 */
  alignRecord: number;
  /** 是否受铁球惩罚；受罚期间移动减半。 */
  punished: boolean;
  /** 受罚计数：奇数回合无法移动。 */
  punishedTurn: number;
  /** 祈祷冷却：大于 0 时再次祈祷会触怒神明。 */
  prayerTimeout: number;
  /** 当前变形形态；为空表示原形。 */
  form: PolymorphForm | null;
  /** 武器技能使用次数，键为 P_* 技能名。 */
  skillUses: Record<string, number>;
  /** 武器技能等级，键为 P_* 技能名。 */
  skillLevels: Record<string, number>;
  seeInvisible: boolean;
  knownSpells: string[];
  /** 吃尸体得到的内在抗性（不依赖装备，永久保留）。 */
  intrinsics: string[];
  /** 心灵感应：感知附近怪物的位置（浮游眼等尸体赋予）。 */
  telepathy: boolean;
  /** 怪物探测剩余回合：与心灵感应相同的感知效果。 */
  senseMonsters: number;
  /** 物品探测剩余回合：小地图标出地面物品。 */
  senseObjects: number;
  /** 金币探测剩余回合：小地图标出带金币的物品堆。 */
  senseGold: number;
  /** 食物探测剩余回合：小地图标出带食物的物品堆。 */
  senseFood: number;
  /** 传送症：每回合有小概率随机传送（会传送的怪物尸体赋予）。 */
  teleportitis: boolean;
}

/** 变形形态：只存怪物原型 id 与剩余回合，属性从数据查回。 */
export interface PolymorphForm {
  id: string;
  turns: number;
}

/** 角色创建结果。 */
export interface CharacterChoice {
  role: RoleData;
  race: RaceData;
  align: Alignment;
  gender: Gender;
}

// ---------------------------------------------------------------------------
// 会话与消息
// ---------------------------------------------------------------------------

/** 消息中的变量。实体以 ID 形式保存，界面按当前语言解析。 */
export interface MessageVars {
  mon?: string;
  obj?: string | null;
  item?: ItemDescription;
  roleId?: string;
  raceId?: string;
  align?: Alignment;
  [key: string]: unknown;
}

export interface GameMessage {
  key: string;
  vars: MessageVars;
  turn: number;
}

/** 物品的可翻译描述，由 game/items.ts 的 describeItem 生成。 */
export interface ItemDescription {
  qty: number;
  key: string;
  vars: Record<string, unknown>;
}

export interface SessionStatus {
  depth: number;
  turn: number;
  hp: number;
  maxHp: number;
  pw: number;
  maxPw: number;
  ac: number;
  level: number;
  xp: number;
  nextXp: number;
  gold: number;
  kills: number;
  role: string;
  race: string;
  align: Alignment;
  dead: boolean;
}

type ActionResult =
  | 'moved'
  | 'blocked'
  | 'opened'
  | 'slept'
  | 'held'
  | 'attacked'
  | 'killed'
  | 'descended'
  | 'ascended'
  | 'dead'
  | 'waited'
  | 'picked'
  | 'used'
  | 'nothing';

export interface ActionResultInfo {
  result: ActionResult;
  picked?: number;
  key?: string;
  /** 消息变量；仅在由使用物品流程代为记日志时需要。 */
  vars?: MessageVars;
}

export interface CombatFeedback {
  monsterId: number;
  hit: boolean;
  byPlayer: boolean;
  damage?: number;
  killed?: boolean;
}

// ---------------------------------------------------------------------------
// 随机数发生器
// ---------------------------------------------------------------------------

export interface Rng {
  seed: number;
  next(): number;
  float(): number;
  /** 返回 [0, n)。 */
  rn2(n: number): number;
  /** 返回 [1, n]。 */
  rnd(n: number): number;
  /** 返回 [x, x+y)。 */
  rn1(x: number, y: number): number;
  /** n 个 s 面骰之和。 */
  dice(n: number, s: number): number;
  /** 按 "2d6" 形式掷伤害。 */
  rollDamage(spec: string): number;
  chance(p: number): boolean;
  shuffle<T>(arr: T[]): T[];
  pick<T>(arr: T[]): T | undefined;
  pickWeighted<T>(items: T[], weight: keyof T | ((item: T) => number)): T | undefined;
  getState(): [number, number, number, number];
  setState(state: [number, number, number, number]): void;
}

// ---------------------------------------------------------------------------
// 存档
// ---------------------------------------------------------------------------

export interface SerializedItem {
  p: string;
  q: number;
  e: number;
  b: string;
  k: 0 | 1;
  a: string | null;
  c?: number;
  g?: 0 | 1;
  u?: 0 | 1;
  /** 神器标识。 */
  ar?: string;
  /** 尸体的怪物原型 id。 */
  cp?: string;
  /** 尸体的形成回合。 */
  ag?: number;
  /** 罐头的怪物原型 id。 */
  tn?: string;
  /** 涂过油脂。 */
  gr?: 0 | 1;
  /** 容器内容；递归存储。 */
  n?: SerializedItem[];
}

/** 序列化的怪物：关卡与坐骑共用。 */
export interface SerializedMonster {
  t: string;
  x: number;
  y: number;
  hp: number;
  max: number;
  lv: number;
  asleep: 0 | 1;
  fleeing: 0 | 1;
  angry?: 0 | 1;
  /** 是否驯服（宠物）。 */
  tame?: 0 | 1;
  /** 驯服度。 */
  tameness?: number;
  /** 加速与缓速剩余回合。 */
  ha?: number;
  sl?: number;
  /** 拟形怪的伪装物品原型 id。 */
  dg?: string;
  /** 定身剩余回合。 */
  st?: number;
  /** 是否被取消。 */
  cn?: 0 | 1;
  /** 任务仇敌是否已经叫过阵。 */
  tt?: 0 | 1;
  /** 拴了牵引绳。 */
  lh?: 0 | 1;
  /** 宠物饱食度。 */
  hg?: number;
  /** 平和生物。 */
  pf?: 0 | 1;
  /** 已知陷阱的位掩码。 */
  ts?: number;
  /** 怪物携带的物品。 */
  inv?: SerializedItem[];
  mv: number;
}

export interface SerializedLevel {
  depth: number;
  /** 分支标识；主地牢省略。 */
  branch?: string;
  seen: number[];
  populated: boolean;
  doors: [number, boolean, boolean, boolean, boolean?, boolean?, boolean?, boolean?][];
  traps: [number, string, boolean][];
  /** 设施的可变状态：[下标, 是否失效, 是否用过]，省略时按生成时的默认值。 */
  features?: [number, 0 | 1, 0 | 1][];
  /** 商店下次补货的回合。 */
  shopRestockAt?: number;
  objects: { x: number; y: number; items: SerializedItem[] }[];
  monsters: SerializedMonster[];
  /** 与生成结果不同的瓦片：[下标, 瓦片类型]，只存运行时改造过的格子。 */
  tiles?: [number, number][];
}

export interface SaveData {
  v: 1;
  seed: number;
  depth: number;
  /** 当前分支；主地牢省略。 */
  branch?: string;
  /** 正在骑乘的坐骑；不在地图怪物列表里。 */
  ride?: SerializedMonster;
  turn: number;
  kills: number;
  dead: 0 | 1;
  character: { roleId: string; raceId: string; align: Alignment; gender: Gender };
  attributes: Attributes;
  /** 任务楼梯是否已获领袖许可。 */
  questUnlocked?: 0 | 1;
  /** 是否已带着职业神器向领袖复命。 */
  questComplete?: 0 | 1;
  /** 任务领袖是否已被杀死；对应原版 ok_to_quest 的例外。 */
  questLeaderDead?: 0 | 1;
  /** 在商店里造成的修缮费，离店时结算。 */
  shopDamage?: number;
  /** 自动拾取开关。 */
  autoPickup?: 0 | 1;
  /** 尤恩多巫师是否抢走了护身符。 */
  wizardHasAmulet?: 0 | 1;
  /** 已灭绝的怪物物种。 */
  genocides?: string[];
  /** 进行中的挖掘（墙或向下），随存档保留。 */
  digging?: { x: number; y: number; down: 0 | 1; progress: number };
  player: {
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    pw: number;
    maxPw: number;
    gold: number;
    hunger: number;
    xp: number;
    level: number;
    luck: number;
    hitInc: number;
    blind: number;
    confused: number;
    invisible: number;
    sleep?: number;
    held?: number;
    stun?: number;
    petrifying?: number;
    hasted?: number;
    sick?: number;
    /** 浮空剩余回合。 */
    levitating?: number;
    /** 溺水累积回合。 */
    drowning?: number;
    alignRecord?: number;
    prayerTimeout?: number;
    /** 是否受铁球惩罚。 */
    punished?: 0 | 1;
    /** 受罚计数。 */
    punishedTurn?: number;
    form?: { id: string; turns: number } | null;
    skillUses?: Record<string, number>;
    skillLevels?: Record<string, number>;
    seeInvisible: boolean;
    knownSpells: string[];
    /** 吃尸体得到的内在抗性。 */
    intrinsics?: string[];
    /** 心灵感应。 */
    telepathy?: 0 | 1;
    /** 怪物探测剩余回合。 */
    senseMonsters?: number;
    /** 物品探测剩余回合。 */
    senseObjects?: number;
    /** 金币探测与食物探测剩余回合。 */
    senseGold?: number;
    senseFood?: number;
    /** 传送症。 */
    teleportitis?: 0 | 1;
    inventory: SerializedItem[];
    equipment: Record<string, number>;
  };
  levels: SerializedLevel[];
  messages: GameMessage[];
}
