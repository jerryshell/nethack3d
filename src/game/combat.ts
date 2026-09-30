/**
 * 战斗数值，移植自 NetHack。
 *
 * - 玩家攻击怪物（uhitm.c 的 find_roll_to_hit()）：
 *   `tmp = 1 + abon() + find_mac(mon) + uhitinc + 幸运修正 + 等级`，
 *   `tmp > rnd(20)` 时命中。
 * - 怪物攻击玩家（mhitu.c）：
 *   `tmp = AC_VALUE(玩家 AC) + 10 + 怪物等级`，
 *   `tmp > rnd(20 + 攻击序号)` 时命中。
 * - 伤害：玩家 AC 为负时，按 `rnd(-AC)` 减免怪物造成的伤害。
 * - 经验：exper.c 的 experience() 与 newuexp()。
 */

import type { Monster, MonsterAttack, Player, Rng } from '../types';
import { createLogger, LOG_NS } from '../core/log';

const log = createLogger(LOG_NS.combat);

/** 参与命中计算的属性子集。 */
type Attacker = Pick<Player, 'str' | 'dex' | 'level'>;

/** AC_VALUE()：负 AC 会被随机化，与 NetHack 的宏一致。 */
export function acValue(ac: number, rng: Rng): number {
  return ac >= 0 ? ac : -rng.rnd(-ac);
}

/**
 * 属性/命中/伤害戒指的装备加值。
 *
 * 这一类戒指在数据里的 power 为空，因此按原型 id 识别：
 * 力量戒指在命中与伤害里各 +1，命中/伤害戒指各加对应数值。
 */
export function equipmentRingBonus(player: Player, id: string): number {
  return Object.values(player.equipment).some((item) => item?.proto.id === id) ? 1 : 0;
}

/** abon()：力量与敏捷带来的命中加值，含低等级补偿。 */
export function abon({ str, dex, level }: Attacker): number {
  let sbon;
  if (str < 6) sbon = -2;
  else if (str < 8) sbon = -1;
  else if (str < 17) sbon = 0;
  else if (str < 18) sbon = 1;
  else sbon = 2;
  sbon += level < 3 ? 1 : 0;

  if (dex < 4) return sbon - 3;
  if (dex < 6) return sbon - 2;
  if (dex < 8) return sbon - 1;
  if (dex < 14) return sbon;
  return sbon + Math.max(0, dex - 14);
}

/** dbon()：力量带来的伤害加成。 */
export function dbon(str: number): number {
  if (str < 6) return -1;
  if (str < 16) return 0;
  if (str < 18) return 1;
  if (str === 18) return 2;
  if (str <= 20) return 3;
  return 4;
}

/** NetHack 的幸运修正，用于命中判定。 */
function luckBonus(luck: number): number {
  return Math.sign(luck) * Math.floor((Math.abs(luck) + 2) / 3);
}

/** 携带幸运神器与幸运石带来的额外幸运：村正与命运之球（artilist.h 的 SPFX_LUCK）。 */
export function luckArtifactBonus(player: Player): number {
  let bonus = 0;
  for (const item of player.inventory) {
    if (item.artifact === 'tsurugi_of_muramasa' || item.artifact === 'orb_of_fate') {
      bonus = Math.max(bonus, 2);
    }
    // 幸运石：诅咒 -1，普通 +1，祝福 +3；只计第一颗。
    if (item.id === 'LUCKSTONE') {
      const stone = item.buc === 'cursed' ? -1 : item.buc === 'blessed' ? 3 : 1;
      return bonus + stone;
    }
  }
  return bonus;
}

/** 武器熟练度带来的命中加值：每两级 +1。 */
export function skillHitBonus(level: number): number {
  return Math.floor(level / 2);
}

/** 武器熟练度带来的伤害加值：每三级 +1。 */
export function skillDamageBonus(level: number): number {
  return Math.floor(level / 3);
}

/** 玩家攻击目标的命中判定；`target.ac` 为怪物护甲等级。 */
export function heroHits(
  player: Player,
  target: Monster,
  rng: Rng,
  bonus = 0,
): { hit: boolean; roll: number } {
  const tmp =
    1 +
    abon({
      str: player.str + equipmentRingBonus(player, 'RIN_GAIN_STRENGTH'),
      dex: player.dex,
      level: player.level,
    }) +
    target.ac +
    (player.hitInc ?? 0) +
    equipmentRingBonus(player, 'RIN_INCREASE_ACCURACY') +
    luckBonus((player.luck ?? 0) + luckArtifactBonus(player)) +
    player.level +
    bonus +
    (target.asleep ? 2 : 0) +
    (target.fleeing ? 2 : 0);
  // NetHack 判定：命中值大于 rnd(20) 即命中。
  const die = rng.rnd(20);
  const hit = tmp > die;
  log.debug('玩家命中判定', { target: target.data.id, toHit: tmp, die, hit });
  return { hit, roll: tmp };
}

/** 怪物第 `i` 次攻击的命中判定。 */ export function monsterHits(
  monster: Monster,
  player: Player,
  attackIndex: number,
  rng: Rng,
): { hit: boolean; roll: number } {
  let tmp = acValue(player.ac, rng) + 10 + (monster.mlev ?? monster.data.lvl);
  if (tmp <= 0) tmp = 1;
  const die = rng.rnd(20 + attackIndex);
  const hit = tmp > die;
  log.debug('怪物命中判定', {
    attacker: monster.data.id,
    attackIndex,
    toHit: tmp,
    die,
    hit,
    playerAc: player.ac,
  });
  return { hit, roll: tmp };
}

/** 击杀怪物获得的经验，对应 exper.c 的 experience()。 */
export function killExperience(mon: Monster): number {
  const data = mon.data;
  const mlev = mon.mlev ?? data.lvl;
  let xp = 1 + mlev * mlev;
  const mac = data.ac;
  if (mac < 3) xp += (7 - mac) * (mac < 0 ? 2 : 1);
  if (data.speed > 12) xp += data.speed > 18 ? 5 : 3;
  for (const atk of data.attacks) {
    if (atk.at === 'AT_WEAP') xp += 5;
    else if (atk.at === 'AT_MAGC') xp += 10;
    else if (!['AT_NONE', 'AT_CLAW', 'AT_BITE', 'AT_KICK', 'AT_BUTT', 'AT_TUCH'].includes(atk.at)) {
      xp += 3;
    }
    const ad = atk.ad;
    if (
      ad !== 'AD_PHYS' &&
      [
        'AD_MAGM',
        'AD_FIRE',
        'AD_COLD',
        'AD_SLEE',
        'AD_DISN',
        'AD_ELEC',
        'AD_DRST',
        'AD_ACID',
      ].includes(ad)
    ) {
      xp += 2 * mlev;
    } else if (['AD_DRLI', 'AD_STON'].includes(ad)) {
      xp += 50;
    } else if (ad !== 'AD_PHYS') {
      xp += mlev;
    }
    if (atk.dice[0] * atk.dice[1] > 23) xp += mlev;
  }
  if (mlev > 8) xp += 50;
  return xp;
}

/** 升到下一级所需经验，对应 exper.c 的 newuexp()。 */
export function xpForLevel(level: number): number {
  if (level < 1) return 0;
  if (level < 10) return 10 * (1 << level);
  if (level < 20) return 10000 * (1 << (level - 10));
  return 10000000 * (level - 19);
}

/** 怪物伤势档位：界面用它显示剩余生命。 */
export type WoundLevel = 'unhurt' | 'light' | 'heavy' | 'nearDeath';

/**
 * 按剩余生命比例分档：满血为未受伤，其余按 2/3 与 1/3 分为轻伤、重伤与滨死。
 * 只有完全回满才算未受伤，与「还能接几刀」的直觉一致。
 */
export function woundLevel(mhp: number, mhpmax: number): WoundLevel {
  if (mhpmax <= 0 || mhp >= mhpmax) return 'unhurt';
  const ratio = mhp / mhpmax;
  if (ratio > 2 / 3) return 'light';
  if (ratio > 1 / 3) return 'heavy';
  return 'nearDeath';
}

/** 怪物单次攻击的伤害，尚未按护甲减免。 */
export function monsterDamage(monster: Monster, attack: MonsterAttack, rng: Rng): number {
  const [n, sides] = attack.dice;
  return rng.dice(n, sides);
}

/**
 * 怪物对怪物的命中判定，移植 mhitm.c 的思路：
 * `AC_VALUE(目标 AC) + 10 + 攻击者等级 > rnd(20 + 攻击序号)`。
 */
export function monsterHitsMonster(
  attacker: Monster,
  defender: Monster,
  attackIndex: number,
  rng: Rng,
): boolean {
  let tmp = acValue(defender.ac, rng) + 10 + (attacker.mlev ?? attacker.data.lvl);
  if (tmp <= 0) tmp = 1;
  return tmp > rng.rnd(20 + attackIndex);
}
