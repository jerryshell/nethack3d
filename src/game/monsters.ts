/**
 * 怪物实例与生成。
 *
 * 选怪思路与 NetHack 的 rndmonst() 一致：从可生成集合中按 `freq` 权重抽取，
 * 限制在当前难度窗口内，并排除唯一怪物。AI 逻辑放在 session.ts，
 * 使回合流程集中在一处。
 */

import type { Level, Monster as MonsterState, MonsterData, Player, Rng } from '../types';
import { GENERATABLE_MONSTERS, monById } from '../data/index';
import { inShopRoom, index, shopRoom } from './dungeon';
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
  /** 被玩家挑衅过的和平生物转为敌对。 */
  angry: boolean;
  /** 驯服的宠物。 */
  tame: boolean;
  /** 驯服度：喂食提升。 */
  tameness: number;
  /** 加速剩余回合：速度翻倍。 */
  hasted: number;
  /** 缓速剩余回合：速度减半（最低 1）。 */
  slowed: number;
  /** 拟形怪的伪装物品原型 id；为空表示现出原形。 */
  disguise?: string | null;
  /** 定身剩余回合：大于 0 时跳过行动。 */
  stasis?: number;
  /** 被取消：非物理的特殊攻击全部失效。 */
  cancelled?: boolean;
  /** 任务仇敌是否已经叫过阵。 */
  taunted?: boolean;

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
    this.angry = false;
    this.tame = false;
    this.tameness = 0;
    this.hasted = 0;
    this.slowed = 0;
    this.disguise = null;
    this.stasis = 0;
    this.cancelled = false;
    this.taunted = false;
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

/** 地狱专属怪物开始出现的深度；对应原版穿过要塞后的深层。 */
const HELL_DEPTH = 25;

/**
 * 依据深度与玩家等级挑选怪物，使用 NetHack 的难度窗口（include/monst.h）：
 *
 * - 下界 `min = depth / 6`
 * - 上界 `max = (depth + heroLevel) / 2`
 *
 * 难度落在区间内、可随机生成、非唯一、非地狱专属的怪物才会入选；
 * 第 25 层起的深层放开 `G_HELL`，让地狱犬、巫妖与涕魔等恶魔登场。
 */
export function pickMonsterType(
  rng: Rng,
  depth: number,
  heroLevel = 1,
  theme?: 'undead' | 'mines' | 'demon',
  symbols?: string[],
  /** 已被灭绝的物种，不再进入生成池。 */
  exclude?: ReadonlySet<string>,
): MonsterData | null {
  const minDiff = Math.floor(depth / 6);
  const maxDiff = Math.floor((depth + heroLevel) / 2);
  const matchesTheme = (m: MonsterData): boolean => {
    if (!theme) return true;
    if (theme === 'undead') return m.flags.includes('M2_UNDEAD');
    if (theme === 'demon') return m.flags.includes('M2_DEMON');
    // 矿坑：侏儒与矮人为主。
    return m.id.includes('GNOME') || m.id.includes('DWARF');
  };
  const matchesSymbols = (m: MonsterData): boolean => !symbols?.length || symbols.includes(m.sym);
  const collect = (
    lo: number,
    hi: number,
    useTheme: boolean,
    useSymbols: boolean,
  ): { m: MonsterData; weight: number }[] => {
    const pool: { m: MonsterData; weight: number }[] = [];
    for (const m of GENERATABLE_MONSTERS) {
      if (m.genFlags.includes('G_UNIQ')) continue;
      if (exclude?.has(m.id)) continue;
      if (m.genFlags.includes('G_HELL') && depth < HELL_DEPTH) continue;
      if (m.diff < lo || m.diff > hi) continue;
      if (useTheme && !matchesTheme(m)) continue;
      if (useSymbols && !matchesSymbols(m)) continue;
      pool.push({ m, weight: Math.max(1, m.freq) });
    }
    return pool;
  };
  // 优先取主题池，再依次退回普通池与放宽的难度窗口。
  let pool = collect(minDiff, maxDiff, true, true);
  if (!pool.length) pool = collect(minDiff, maxDiff, false, true);
  if (!pool.length) pool = collect(0, maxDiff + 1, true, true);
  if (!pool.length) pool = collect(0, maxDiff + 1, false, true);
  if (!pool.length) pool = collect(minDiff, maxDiff, true, false);
  if (!pool.length) pool = collect(minDiff, maxDiff, false, false);
  return rng.pickWeighted(pool, 'weight')?.m ?? null;
}

/** 为刚进入的楼层生成怪物，写入 `level.monsters`。 */
export function spawnMonsters(
  level: Level,
  rng: Rng,
  {
    player,
    heroLevel = 1,
    count,
    theme,
    symbols,
    exclude,
  }: {
    player?: Player;
    heroLevel?: number;
    count?: number;
    theme?: 'undead' | 'mines' | 'demon';
    /** 只生成这些 S_* 类别的怪物（任务层）。 */
    symbols?: string[];
    /** 已被灭绝的物种。 */
    exclude?: ReadonlySet<string>;
  } = {},
): Monster[] {
  const depth = level.depth;
  const n = count ?? Math.min(12, 4 + rng.rn2(4) + Math.floor(depth / 3));
  const occupied = new Set<number>();
  const spots: { x: number; y: number }[] = [];
  for (let x = 1; x < level.width - 1; x++) {
    for (let y = 1; y < level.height - 1; y++) {
      const t = level.tiles[index(x, y)];
      if (t !== T.ROOM) continue;
      // 商店的房间由店主看守，不随机生成怪物。
      if (inShopRoom(level, x, y)) continue;
      if (player && Math.abs(x - player.x) + Math.abs(y - player.y) < 8) continue;
      spots.push({ x, y });
    }
  }
  rng.shuffle(spots);
  for (let i = 0; i < n && spots.length; i++) {
    const spot = spots.pop() as { x: number; y: number };
    const i2 = index(spot.x, spot.y);
    if (occupied.has(i2)) continue;
    const data = pickMonsterType(rng, depth, heroLevel, theme, symbols, exclude);
    if (!data) continue;
    occupied.add(i2);
    level.monsters.push(new Monster(data, spot.x, spot.y, rng));
  }
  // 有小概率在楼梯旁生成一只怪物，对应原版的守卫。
  // 这里也要查重复：主循环可能已经在这几格放过怪物，玩家也可能正好站在这里。
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
      const spot = index(x, y);
      if (occupied.has(spot)) continue;
      if (player && player.x === x && player.y === y) continue;
      const data = pickMonsterType(rng, depth, heroLevel, theme, symbols, exclude);
      if (data) {
        occupied.add(spot);
        level.monsters.push(new Monster(data, x, y, rng));
      }
      break;
    }
  }
  return level.monsters;
}

/** 本回合的行动力累积速度：加速翻倍、缓速减半（最低 1）。 */
export function monsterSpeed(mon: Monster): number {
  let speed = mon.data.speed;
  if (mon.hasted > 0) speed *= 2;
  if (mon.slowed > 0) speed = Math.max(1, Math.floor(speed / 2));
  return speed;
}

/** 查询指定坐标上存活的怪物。 */
export function monsterAt(level: Level, x: number, y: number): Monster | null {
  for (const m of level.monsters) {
    if (!m.dead && m.x === x && m.y === y) return m;
  }
  return null;
}

/**
 * 在商店里放下店主。
 *
 * 店主站在门内侧，其次是空着的房间地面：店主不睡觉，
 * 也不会离开商店（和平生物在受挑衅前不行动）。
 * 返回店主实例，本层没有商店时返回 null。
 */
export function placeShopkeeper(level: Level, rng: Rng): Monster | null {
  const room = shopRoom(level);
  if (!room) return null;
  const data = monById.get('SHOPKEEPER');
  if (!data) return null;

  const occupied = new Set(level.monsters.filter((m) => !m.dead).map((m) => index(m.x, m.y)));
  const piles = new Set(level.objects.map((p) => index(p.x, p.y)));
  const nearDoor: { x: number; y: number }[] = [];
  const any: { x: number; y: number }[] = [];
  for (let x = room.lx; x <= room.hx; x++) {
    for (let y = room.ly; y <= room.hy; y++) {
      if (level.tiles[index(x, y)] !== T.ROOM) continue;
      if (occupied.has(index(x, y))) continue;
      const spot = { x, y };
      any.push(spot);
      // 与门相邻的内部格：店主站这里可以拦住入口。
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        if (level.doors.has(index(x + dx, y + dy))) {
          nearDoor.push(spot);
          break;
        }
      }
    }
  }
  // 优先门边且没有货物堆的格子，避免把地面物品堵在店主脚下。
  const pick =
    nearDoor.find((s) => !piles.has(index(s.x, s.y))) ??
    nearDoor[0] ??
    any.find((s) => !piles.has(index(s.x, s.y))) ??
    any[0];
  if (!pick) return null;
  const keeper = new Monster(data, pick.x, pick.y, rng);
  keeper.asleep = false;
  level.monsters.push(keeper);
  return keeper;
}
