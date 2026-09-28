/**
 * 法术效果与施法判定。
 *
 * 法术书的数据里已经带有 `spellClass`（攻击、治疗、占卜……）与 `level`，
 * 因此效果不必硬编码：类别决定做什么，等级决定代价与强度。
 * 成功率参考原版思路——等级越高越难，智力越高越稳，施法职业有加成。
 */

import type { ObjectData, Player, Rng } from '../types';

/** 法术的效果类型，由法术书的类别推导。 */
export type SpellKind =
  | 'attack'
  | 'heal'
  | 'divine'
  | 'detect'
  | 'enchant'
  | 'escape'
  | 'matter'
  | 'none';

export interface SpellProfile {
  kind: SpellKind;
  /** 消耗的法力：等于法术等级，最低 1。 */
  cost: number;
  /** 伤害或治疗的骰子。 */
  dice?: [number, number];
  /** 效果持续的回合数（催眠等）。 */
  turns?: number;
}

/** 法术书的类别到效果类型。 */
const CLASS_KINDS: Record<string, SpellKind> = {
  P_ATTACK_SPELL: 'attack',
  P_HEALING_SPELL: 'heal',
  P_CLERIC_SPELL: 'divine',
  P_DIVINATION_SPELL: 'detect',
  P_ENCHANTMENT_SPELL: 'enchant',
  P_ESCAPE_SPELL: 'escape',
  P_MATTER_SPELL: 'matter',
  P_NONE: 'none',
};

/** 施加法职业：施法更稳。 */
const CASTER_ROLES = new Set(['WIZARD', 'CLERIC', 'HEALER', 'MONK']);

/** 从法术书原型推导效果。 */
export function spellProfile(proto: ObjectData): SpellProfile {
  const level = Math.max(0, Math.min(7, proto.level ?? 1));
  const kind = CLASS_KINDS[proto.spellClass ?? 'P_NONE'] ?? 'none';
  const profile: SpellProfile = { kind, cost: Math.max(1, level) };
  switch (kind) {
    case 'attack':
      // 高等级法术伤害更高：等级 1 为 1d6，等级 7 为 4d6。
      profile.dice = [1 + Math.floor(level / 2), 6];
      break;
    case 'heal':
      profile.dice = [1 + Math.floor(level / 2), 8];
      break;
    case 'divine':
      // 祛邪法术：对不死生物伤害更高，同时略微治疗自己。
      profile.dice = [level, 6];
      profile.turns = level;
      break;
    case 'enchant':
      profile.turns = level + 2;
      break;
    default:
      break;
  }
  return profile;
}

/** 施法失败的几率，0 到 0.85；战斗/法术流派熟练度会降低失败率。 */
export function castFailChance(player: Player, level: number, skillLevel = 0): number {
  const base = 0.08 + level * 0.07;
  const skill = (player.int - 10) * 0.03;
  const roleBonus = CASTER_ROLES.has(player.role.id) ? 0.15 : 0;
  return Math.max(0, Math.min(0.85, base - skill - roleBonus - skillLevel * 0.03));
}

/** 施法结果。 */
export type CastOutcome =
  | { result: 'unknown' }
  | { result: 'no-mana'; need: number }
  | { result: 'failed' }
  | {
      result: 'cast';
      kind: SpellKind;
      /** 伤害或治疗量。 */
      amount?: number;
      /** 影响到的怪物 id。 */
      monsterId?: number;
      /** 占卜等效果是否生效。 */
      applied?: boolean;
    };

/** 掷出伤害或治疗量。 */
export function rollSpellAmount(rng: Rng, profile: SpellProfile): number {
  if (!profile.dice) return 0;
  return rng.dice(profile.dice[0], profile.dice[1]);
}
