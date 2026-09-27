/**
 * 怪物实例与生成。
 *
 * 选怪思路与 NetHack 的 rndmonst() 一致：从可生成集合中按 `freq` 权重抽取，
 * 限制在当前难度窗口内，并排除唯一怪物。AI 逻辑放在 session.ts，
 * 使回合流程集中在一处。
 */

import type { Level, Monster as MonsterState, MonsterData, Player, Rng } from '../types';
import { GENERATABLE_MONSTERS } from '../data/index';
import { index } from './dungeon';
import { T, isWalkable } from '../core/constants';

let nextId = 1;

export class Monster implements MonsterState {
  id: number;
  data: MonsterData;
  x: number;
  y: number;
  mlev: number;
  mhp: number;
  mhpmax: number;
  mv: number;
  asleep: boolean;
  fleeing: boolean;
  dead: boolean;

  constructor(data: MonsterData, x: number, y: number, rng: Rng, { mlev }: { mlev?: number } = {}) {
    this.id = nextId++;
    this.data = data;
    this.x = x;
    this.y = y;
    this.mlev = mlev ?? data.lvl;
    const hpDice = Math.max(1, data.lvl);
    this.mhpmax = Math.max(1, rng.dice(hpDice, 8));
    this.mhp = this.mhpmax;
    this.mv = 0;
    this.asleep = rng.chance(0.45);
    this.fleeing = false;
    this.dead = false;
  }

  get ac(): number {
    return this.data.ac;
  }

  get name(): string {
    return this.data.name;
  }

  /** i18n 键，界面据此查找译名，缺失时回退英文名。 */
  get nameKey(): string {
    return `mon.${this.data.id}`;
  }
}

/**
 * 依据深度与玩家等级挑选怪物，使用 NetHack 的难度窗口（include/monst.h）：
 *
 * - 下界 `min = depth / 6`
 * - 上界 `max = (depth + heroLevel) / 2`
 *
 * 难度落在区间内、可随机生成、非唯一、非地狱专属的怪物才会入选。
 */
export function pickMonsterType(rng: Rng, depth: number, heroLevel = 1): MonsterData | null {
  const minDiff = Math.floor(depth / 6);
  const maxDiff = Math.floor((depth + heroLevel) / 2);
  const pool = [];
  for (const m of GENERATABLE_MONSTERS) {
    if (m.genFlags.includes('G_UNIQ') || m.genFlags.includes('G_HELL')) continue;
    if (m.diff < minDiff || m.diff > maxDiff) continue;
    pool.push({ m, weight: Math.max(1, m.freq) });
  }
  // 兜底：窗口内没有候选时，向上放宽一个难度档。
  if (!pool.length) {
    for (const m of GENERATABLE_MONSTERS) {
      if (m.genFlags.includes('G_UNIQ') || m.genFlags.includes('G_HELL')) continue;
      if (m.diff > maxDiff + 1) continue;
      pool.push({ m, weight: Math.max(1, m.freq) });
    }
  }
  return rng.pickWeighted(pool, 'weight')?.m ?? null;
}

/** 为刚进入的楼层生成怪物，写入 `level.monsters`。 */
export function spawnMonsters(
  level: Level,
  rng: Rng,
  { player, heroLevel = 1, count }: { player?: Player; heroLevel?: number; count?: number } = {},
): Monster[] {
  const depth = level.depth;
  const n = count ?? Math.min(12, 4 + rng.rn2(4) + Math.floor(depth / 3));
  const occupied = new Set<number>();
  const spots: { x: number; y: number }[] = [];
  for (let x = 1; x < level.width - 1; x++) {
    for (let y = 1; y < level.height - 1; y++) {
      const t = level.tiles[index(x, y)];
      if (t !== T.ROOM) continue;
      if (player && Math.abs(x - player.x) + Math.abs(y - player.y) < 8) continue;
      spots.push({ x, y });
    }
  }
  rng.shuffle(spots);
  for (let i = 0; i < n && spots.length; i++) {
    const spot = spots.pop() as { x: number; y: number };
    const i2 = index(spot.x, spot.y);
    if (occupied.has(i2)) continue;
    const data = pickMonsterType(rng, depth, heroLevel);
    if (!data) continue;
    occupied.add(i2);
    level.monsters.push(new Monster(data, spot.x, spot.y, rng));
  }
  // 有小概率在楼梯旁生成一只怪物，对应原版的守卫。
  if (level.down && rng.chance(0.35)) {
    for (const [dx, dy] of rng.shuffle([
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ])) {
      const x = level.down.x + dx;
      const y = level.down.y + dy;
      if (x < 1 || y < 1 || x >= level.width - 1 || y >= level.height - 1) continue;
      if (!isWalkable(level.tiles[index(x, y)])) continue;
      const data = pickMonsterType(rng, depth, heroLevel);
      if (data) level.monsters.push(new Monster(data, x, y, rng));
      break;
    }
  }
  return level.monsters;
}

/** 查询指定坐标上存活的怪物。 */
export function monsterAt(level: Level, x: number, y: number): Monster | null {
  for (const m of level.monsters) {
    if (!m.dead && m.x === x && m.y === y) return m;
  }
  return null;
}

export function monsterAtTile(level: Level, i: number): Monster | null {
  for (const m of level.monsters) {
    if (!m.dead && index(m.x, m.y) === i) return m;
  }
  return null;
}
