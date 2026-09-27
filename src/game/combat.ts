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
export function luckBonus(luck: number): number {
  return Math.sign(luck) * Math.floor((Math.abs(luck) + 2) / 3);
}

/** 玩家攻击目标的命中判定；`target.ac` 为怪物护甲等级。 */
export function heroHits(
  player: Player,
  target: Monster,
  rng: Rng,
): { hit: boolean; roll: number } {
  const tmp =
    1 +
    abon(player) +
    target.ac +
    (player.hitInc ?? 0) +
    luckBonus(player.luck ?? 0) +
    player.level +
    (target.asleep ? 2 : 0) +
    (target.fleeing ? 2 : 0);
  // NetHack 判定：命中值大于 rnd(20) 即命中。
  const die = rng.rnd(20);
  const hit = tmp > die;
  log.debug('玩家命中判定', { target: target.data.id, toHit: tmp, die, hit });
  return { hit, roll: tmp };
}

/** 怪物第 `i` 次攻击的命中判定。 */
export function monsterHits(
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

/** 怪物单次攻击的伤害，尚未按护甲减免。 */
export function monsterDamage(monster: Monster, attack: MonsterAttack, rng: Rng): number {
  const [n, sides] = attack.dice;
  return rng.dice(n, sides);
}
