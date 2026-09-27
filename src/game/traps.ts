/**
 * 陷阱的效果表。
 *
 * 陷阱的生成、渲染与存档早已就位，这里补上踩中之后的结算规则。
 * 每种陷阱归到少数几种「效果类型」，会话层按类型执行，
 * 因此新增陷阱类型只是往表里加一行。
 *
 * 少数陷阱在本作里没有对应机制（变形、雕像），表里标为 `flavor`，
 * 只给出提示，边界记录在 docs/COGNITION.md。
 */

/** 效果类型。 */
export type TrapKind =
  | 'damage'
  | 'hold'
  | 'sleep'
  | 'drainPw'
  | 'wake'
  | 'rust'
  | 'teleport'
  | 'levelTeleport'
  | 'hole'
  | 'magic'
  | 'flavor';

export interface TrapEffect {
  kind: TrapKind;
  /** 伤害骰子：`[个数, 面数]`。 */
  dice?: [number, number];
  /** 定身或睡眠持续的回合数。 */
  turns?: number;
  /** 提示文案键。 */
  message: string;
}

/** 陷阱类型到效果的定义。 */
export const TRAP_EFFECTS: Record<string, TrapEffect> = {
  ARROW_TRAP: { kind: 'damage', dice: [1, 6], message: 'msg.trapDamage' },
  DART_TRAP: { kind: 'damage', dice: [1, 4], message: 'msg.trapDamage' },
  ROCKTRAP: { kind: 'damage', dice: [1, 8], message: 'msg.trapDamage' },
  PIT: { kind: 'damage', dice: [1, 6], message: 'msg.trapDamage' },
  SPIKED_PIT: { kind: 'damage', dice: [2, 6], message: 'msg.trapDamage' },
  LANDMINE: { kind: 'damage', dice: [3, 6], message: 'msg.trapDamage' },
  FIRE_TRAP: { kind: 'damage', dice: [2, 4], message: 'msg.trapDamage' },
  ROLLING_BOULDER_TRAP: { kind: 'damage', dice: [2, 6], message: 'msg.trapDamage' },
  BEAR_TRAP: { kind: 'hold', dice: [1, 4], turns: 2, message: 'msg.trapHold' },
  WEB: { kind: 'hold', turns: 2, message: 'msg.trapHold' },
  SLEEPING_GAS_TRAP: { kind: 'sleep', turns: 3, message: 'msg.trapSleep' },
  SQKY_BOARD: { kind: 'wake', message: 'msg.trapWake' },
  RUST_TRAP: { kind: 'rust', message: 'msg.trapRust' },
  TELEP_TRAP: { kind: 'teleport', message: 'msg.trapTeleport' },
  LEVEL_TELEP: { kind: 'levelTeleport', message: 'msg.trapLevelTeleport' },
  HOLE: { kind: 'hole', message: 'msg.trapHole' },
  ANTI_MAGIC: { kind: 'drainPw', message: 'msg.trapDrainPw' },
  MAGIC_TRAP: { kind: 'magic', message: 'msg.trapMagic' },
  STATUE_TRAP: { kind: 'flavor', message: 'msg.trapFlavor' },
  POLY_TRAP: { kind: 'flavor', message: 'msg.trapFlavor' },
  VIBRATING_SQUARE: { kind: 'flavor', message: 'msg.trapFlavor' },
};

/** 未登记的陷阱类型按无事发生处理，避免新数据导致异常。 */
export function trapEffect(type: string): TrapEffect {
  return TRAP_EFFECTS[type] ?? { kind: 'flavor', message: 'msg.trapFlavor' };
}

/**
 * 陷阱类型到名称文案键的映射。
 *
 * 界面（光标提示）与会话（消息）共用，避免两处各维护一份。
 */
export const TRAP_NAME_KEYS: Record<string, string> = {
  ARROW_TRAP: 'arrow',
  DART_TRAP: 'dart',
  ROCKTRAP: 'fallingRock',
  SQKY_BOARD: 'squeakyBoard',
  BEAR_TRAP: 'bearTrap',
  LANDMINE: 'landMine',
  ROLLING_BOULDER_TRAP: 'rollingBoulder',
  SLEEPING_GAS_TRAP: 'sleepingGas',
  RUST_TRAP: 'rust',
  FIRE_TRAP: 'fire',
  PIT: 'pit',
  SPIKED_PIT: 'spikedPit',
  HOLE: 'hole',
  TELEP_TRAP: 'teleport',
  LEVEL_TELEP: 'levelTeleport',
  WEB: 'web',
  STATUE_TRAP: 'statue',
  MAGIC_TRAP: 'magic',
  ANTI_MAGIC: 'antiMagic',
  POLY_TRAP: 'polymorph',
  VIBRATING_SQUARE: 'vibratingSquare',
};

/** 陷阱名称的文案键；未知类型回退到通用名称。 */
export function trapNameKey(type: string): string {
  return `trap.${TRAP_NAME_KEYS[type] ?? 'pit'}`;
}
