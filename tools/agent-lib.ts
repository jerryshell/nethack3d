/**
 * Agent 反馈循环的共享库。
 *
 * 提供三类能力：
 *
 * 1. 无头运行辅助：创建会话、寻路、随机行动生成、状态快照。
 * 2. 不变量检查：任何一次行动之后都能判定游戏状态是否自洽。
 * 3. 结构化结果类型：场景、失败项与报告，供 Agent 解析与迭代。
 */

import type { CharacterChoice, ItemInstance, Level, Monster, Rng } from '../src/types';
import { GameSession } from '../src/game/session';
import { branchByEntrance } from '../src/game/branches';
import { isContainer } from '../src/game/containers';
import { index, coords, inBounds } from '../src/game/dungeon';
import { computeFov } from '../src/game/fov';
import {
  generateLevel,
  levelToAscii,
  doorBlocksEastWest,
  inRoom,
  shopRoom,
} from '../src/game/dungeon';
import { sessionAscii } from '../src/game/ascii';
import { T, isFurniture, isWalkable, isWall } from '../src/core/constants';
import { createRng, deriveSeed } from '../src/core/rng';
import { roleById, raceById } from '../src/game/roles';
import { MONSTERS, monById } from '../src/data/index';
import { monsterAt } from '../src/game/monsters';
import { SHOP_TYPES } from '../src/game/items';
import { INTRINSIC_KINDS } from '../src/game/resist';

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

/** 单条检查失败。`repro` 给出可直接复现的命令。 */
export interface Failure {
  scope: string;
  check: string;
  detail: string;
  repro?: string;
}

/** 场景运行结果。metrics 供 Agent 观察行为是否合理。 */
export interface ScenarioResult {
  name: string;
  ok: boolean;
  durationMs: number;
  actions: number;
  invariantChecks: number;
  metrics: Record<string, number | string | boolean>;
  failures: Failure[];
  /** 失败时的现场快照：ASCII 地图与状态摘要，便于 Agent 定位问题。 */
  dump?: string;
}

/** 快照比对结果。 */
interface GoldenResult {
  compared: number;
  mismatched: { key: string; expected: string; actual: string }[];
  written: boolean;
}

/** 一次完整运行的结构化报告，是 Agent 的主要输入。 */
export interface AgentReport {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  baseSeed: number;
  totals: {
    scenarios: number;
    failedScenarios: number;
    checks: number;
    failedChecks: number;
    actions: number;
    fuzzRuns: number;
    mapLevels: number;
    mapDoors: number;
    mapProper: number;
    mapPanels: number;
  };
  scenarios: ScenarioResult[];
  golden: GoldenResult;
  failures: Failure[];
  /** 给 Agent 的下一步建议，按优先级排列。 */
  hints: string[];
  /** 参考仓库版本状态；无法访问参考仓库时为 unavailable。 */
  reference: ReferenceStatus;
}

/** 参考版本的检查结果。 */
export interface ReferenceStatus {
  status: 'up-to-date' | 'drift' | 'unavailable';
  commit?: string;
  changedFiles?: string[];
  countDrift?: string[];
  hints?: string[];
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------

/** 收集检查结果，供场景内部使用。 */
export class Checker {
  readonly failures: Failure[] = [];
  checks = 0;
  private dumper: (() => string) | null = null;

  constructor(private readonly scope: string) {}

  /** 注册现场快照函数；失败时由执行外壳调用。 */
  attachDump(dumper: () => string): void {
    this.dumper = dumper;
  }

  /** 生成现场快照；未注册时返回空串。 */
  renderDump(): string {
    try {
      return this.dumper ? this.dumper() : '';
    } catch (err) {
      return `快照生成失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 条件成立则通过，否则记录失败。 */
  ok(condition: boolean, check: string, detail = '', repro?: string): boolean {
    this.checks++;
    if (!condition) {
      this.failures.push({ scope: this.scope, check, detail, repro });
    }
    return condition;
  }

  /** 记录一次不带条件的失败。 */
  fail(check: string, detail: string, repro?: string): void {
    this.checks++;
    this.failures.push({ scope: this.scope, check, detail, repro });
  }

  /** 把不变量检查返回的问题列表汇总成失败项。 */
  absorb(check: string, problems: string[], repro?: string): void {
    this.checks++;
    if (problems.length) {
      this.failures.push({
        scope: this.scope,
        check,
        detail: problems.slice(0, 6).join('；'),
        repro,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 会话构造
// ---------------------------------------------------------------------------

/** 场景统一使用的角色，保证跨版本可复现。 */
export const FIXED_CHARACTER: CharacterChoice = {
  role: roleById.VALKYRIE,
  race: raceById.HUMAN,
  align: 'neutral',
  gender: 'female',
};

/** 创建用于测试的会话；默认使用固定角色。 */
export function newSession(
  seed: number,
  { depth = 1, character = FIXED_CHARACTER }: { depth?: number; character?: CharacterChoice } = {},
): GameSession {
  return new GameSession({ seed, depth, character });
}

/** 由种子派生独立的随机源，避免与游戏内随机数互相干扰。 */
export function testRng(seed: number, ...parts: (string | number)[]): Rng {
  return createRng(deriveSeed(seed, 'agent', ...parts));
}

// ---------------------------------------------------------------------------
// 地形与寻路
// ---------------------------------------------------------------------------

/** 判断某格是否可以站人。 */
export function walkableAt(level: Level, x: number, y: number): boolean {
  if (!inBounds(x, y)) return false;
  return isWalkable(level.tiles[index(x, y)]);
}

/**
 * 在关卡内做广度优先搜索，返回从起点到目标的单步方向；无路可走时返回 null。
 *
 * 默认绕开锁着的门；`allowLocked` 为真时才把锁门视作可通行，
 * 用于「绕不过去就踹门」的两段式寻路。
 */
export function stepToward(
  level: Level,
  from: { x: number; y: number },
  to: { x: number; y: number },
  allowLocked = false,
  /** 需要绕开的格子（例如本层的上行楼梯，避免下楼途中被送回上层）。 */
  avoid?: ReadonlySet<number>,
): [number, number] | null {
  if (from.x === to.x && from.y === to.y) return null;
  const prev = new Int32Array(level.width * level.height).fill(-1);
  const visited = new Uint8Array(level.width * level.height);
  const queue: number[] = [index(from.x, from.y)];
  visited[queue[0]] = 1;
  const target = index(to.x, to.y);

  while (queue.length) {
    const current = queue.shift() as number;
    if (current === target) break;
    const cx = current % level.width;
    const cy = Math.floor(current / level.width);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(nx, ny)) continue;
      const next = index(nx, ny);
      if (visited[next]) continue;
      if (avoid?.has(next)) continue;
      if (!walkableAt(level, nx, ny)) continue;
      if (!allowLocked && lockedDoorAt(level, nx, ny)) continue;
      visited[next] = 1;
      prev[next] = current;
      queue.push(next);
    }
  }

  if (prev[target] === -1) return null;
  let cursor = target;
  while (prev[cursor] !== index(from.x, from.y)) {
    cursor = prev[cursor];
    if (cursor === -1) return null;
  }
  const cx = cursor % level.width;
  const cy = Math.floor(cursor / level.width);
  return [cx - from.x, cy - from.y];
}

/** 判断某格是否是锁着的门。 */
export function lockedDoorAt(level: Level, x: number, y: number): boolean {
  const door = level.doors.get(index(x, y));
  return !!door && door.closed && door.locked;
}

/** 两段式寻路：先绕开锁门，确实无路可走时再允许踹门通过。 */
export function stepTowardGoal(
  level: Level,
  from: { x: number; y: number },
  to: { x: number; y: number },
  avoid?: ReadonlySet<number>,
): [number, number] | null {
  return stepToward(level, from, to, false, avoid) ?? stepToward(level, from, to, true, avoid);
}

/** 把玩家移动到目标点附近（用于构造测试局面），必要时直接改坐标。 */
export function teleportPlayer(session: GameSession, x: number, y: number): void {
  // 目标格站着怪物时先把它挤到相邻空地，避免造出玩家与怪物重叠的非法局面。
  const occupant = monsterAt(session.level, x, y);
  if (occupant) {
    const steps: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    for (const [dx, dy] of steps) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      if (!isWalkable(session.level.tiles[index(nx, ny)])) continue;
      if (monsterAt(session.level, nx, ny)) continue;
      occupant.x = nx;
      occupant.y = ny;
      break;
    }
  }
  session.player.x = x;
  session.player.y = y;
  session.refreshFov();
}

/**
 * 把玩家放到目标旁边可站立、无怪物的一格，返回朝向目标的步进方向。
 *
 * 优先西侧；目标在边界或旁边是墙时依次尝试其它方向，
 * 避免场景直接把玩家放进墙里。
 */
export function standBeside(
  session: GameSession,
  target: { x: number; y: number },
): { dx: number; dy: number } | null {
  const options: [number, number][] = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  for (const [dx, dy] of options) {
    const x = target.x + dx;
    const y = target.y + dy;
    if (!walkableAt(session.level, x, y)) continue;
    if (session.level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
    teleportPlayer(session, x, y);
    return { dx: -dx, dy: -dy };
  }
  return null;
}

/** 把关卡渲染成 ASCII，附带玩家与怪物标记；与状态转储共用实现。 */
export const renderMap = sessionAscii;

// ---------------------------------------------------------------------------
// 不变量
// ---------------------------------------------------------------------------

/** 迷雾覆盖的瓦片数量，用于验证单调递增。 */
export function seenCount(level: Level): number {
  let total = 0;
  for (let i = 0; i < level.seen.length; i++) total += level.seen[i];
  return total;
}

/**
 * 迷雾追踪器：记住上一次检查的楼层与可见瓦片数量。
 *
 * 换层后自动重置基线，因此调用方不需要关心楼层切换。
 */
interface SeenTracker {
  level: Level | null;
  count: number;
}

/** 创建迷雾追踪器。 */
export function createSeenTracker(): SeenTracker {
  return { level: null, count: 0 };
}

/**
 * 检查游戏状态是否自洽，返回问题描述列表。
 *
 * 这些不变量覆盖位置合法性、数值范围、实体唯一性与装备一致性，
 * 是 Agent 判定「刚才的改动是否破坏游戏」的主要依据。
 */
/** 容器内容必须合法：不能再套容器，数量不小于 1。 */
function checkContents(item: ItemInstance, path: string, problems: string[]): void {
  for (const inner of item.contents ?? []) {
    if (inner.quantity < 1) problems.push(`${path} 内容数量小于 1：${inner.proto.id}`);
    if (isContainer(inner)) problems.push(`${path} 里套了容器：${inner.proto.id}`);
    checkContents(inner, path, problems);
  }
}

export function checkInvariants(session: GameSession, tracker?: SeenTracker): string[] {
  const problems: string[] = [];
  const { player, level } = session;

  // 位置
  if (!walkableAt(level, player.x, player.y)) {
    problems.push(
      `玩家位于不可通行的格子 (${player.x}, ${player.y}) 瓦片=${level.tiles[index(player.x, player.y)]}`,
    );
  }
  if (player.x < 0 || player.y < 0 || player.x >= level.width || player.y >= level.height) {
    problems.push(`玩家坐标越界 (${player.x}, ${player.y})`);
  }

  // 数值范围
  if (player.hp < 0) problems.push(`生命为负：${player.hp}`);
  if (player.hp > player.maxHp) problems.push(`生命超过上限：${player.hp}/${player.maxHp}`);
  if (player.maxHp < 1) problems.push(`生命上限异常：${player.maxHp}`);
  if (player.pw < 0) problems.push(`法力为负：${player.pw}`);
  if (player.pw > player.maxPw) problems.push(`法力超过上限：${player.pw}/${player.maxPw}`);
  if (player.level < 1) problems.push(`等级小于 1：${player.level}`);
  if (player.xp < 0) problems.push(`经验为负：${player.xp}`);
  if (player.gold < 0) problems.push(`金币为负：${player.gold}`);
  // 阵营记录与祈祷冷却。
  if (player.alignRecord < -128 || player.alignRecord > 127) {
    problems.push(`阵营记录越界：${player.alignRecord}`);
  }
  if (player.prayerTimeout < 0) problems.push(`祈祷冷却为负：${player.prayerTimeout}`);
  // 内在抗性必须是已知种类且不重复，否则存档中的错字或重复会静默生效。
  const intrinsics = player.intrinsics ?? [];
  for (const kind of intrinsics) {
    if (!INTRINSIC_KINDS.has(kind)) problems.push(`内在抗性非法：${kind}`);
  }
  if (new Set(intrinsics).size !== intrinsics.length) {
    problems.push(`内在抗性存在重复：${intrinsics.join('/')}`);
  }
  // 变形形态必须存在于数据里，计时不能为负。
  if (player.form) {
    if (!monById.has(player.form.id)) problems.push(`变形形态不存在：${player.form.id}`);
    if (player.form.turns < 0) problems.push(`变形剩余回合为负：${player.form.turns}`);
  }
  // 状态计时不能为负；陷阱会写入睡眠与定身。
  if (player.sleep < 0) problems.push(`睡眠回合为负：${player.sleep}`);
  if (player.held < 0) problems.push(`定身回合为负：${player.held}`);
  if (player.sick < 0) problems.push(`疾病回合为负：${player.sick}`);
  if ((player.hasted ?? 0) < 0) problems.push(`加速回合为负：${player.hasted}`);
  // 陷阱必须落在能走到的地面上，否则永远踩不到：这是生成器的错。
  for (const [i] of session.level.traps) {
    if (!isWalkable(session.level.tiles[i])) problems.push(`陷阱位于不可通行的格子：${i}`);
  }
  // 地形设施必须落在对应类型的格子上，且保持可通行。
  for (const [i, feature] of level.features) {
    if (!isFurniture(level.tiles[i])) {
      problems.push(`设施位于非设施格：${feature.type} @${i}`);
    }
    if (
      feature.type === 'ALTAR' &&
      feature.align &&
      !['lawful', 'neutral', 'chaotic'].includes(feature.align)
    ) {
      problems.push(`祭坛阵营非法：${feature.align}`);
    }
    const at = coords(i);
    if (!walkableAt(level, at.x, at.y)) {
      problems.push(`设施不可通行：${feature.type} (${at.x}, ${at.y})`);
    }
  }
  if (session.depth < 1 || session.depth > session.maxDepth) {
    problems.push(`楼层越界：${session.depth}`);
  }
  if (player.dead && player.hp !== 0) problems.push(`已死亡但生命不为 0：${player.hp}`);
  if (player.dead !== session.dead) problems.push('玩家死亡标记与会话不一致');

  // 怪物
  const occupied = new Set<number>();
  for (const mon of level.monsters) {
    const tile = index(mon.x, mon.y);
    if (!walkableAt(level, mon.x, mon.y)) {
      problems.push(`怪物 ${mon.data.id} 位于不可通行格 (${mon.x}, ${mon.y})`);
    }
    if (occupied.has(tile))
      problems.push(`多个怪物占用同一格：${mon.data.id} (${mon.x}, ${mon.y})`);
    occupied.add(tile);
    if (mon.x === player.x && mon.y === player.y) {
      problems.push(`怪物 ${mon.data.id} 与玩家重叠`);
    }
    if (mon.mhp <= 0) problems.push(`怪物 ${mon.data.id} 生命不为正：${mon.mhp}`);
    if (mon.mhp > mon.mhpmax)
      problems.push(`怪物 ${mon.data.id} 生命超过上限：${mon.mhp}/${mon.mhpmax}`);
    if (mon.mv < 0) problems.push(`怪物 ${mon.data.id} 行动力为负：${mon.mv}`);
    if ((mon.hasted ?? 0) < 0 || (mon.slowed ?? 0) < 0) {
      problems.push(`怪物 ${mon.data.id} 加速/缓速回合为负`);
    }
  }

  // 坐骑必须是驯服宠物，且不能同时出现在地图怪物里。
  if (session.ride) {
    if (!session.ride.tame) problems.push('坐骑不是驯服的宠物');
    if (level.monsters.includes(session.ride)) problems.push('坐骑同时出现在关卡怪物列表里');
  }

  // 地面物品
  for (const pile of level.objects) {
    if (!walkableAt(level, pile.x, pile.y)) {
      problems.push(`地面物品位于不可通行格 (${pile.x}, ${pile.y})`);
    }
    if (!pile.items.length) problems.push(`地面物品堆为空：(${pile.x}, ${pile.y})`);
    for (const item of pile.items) {
      if (item.quantity < 1) problems.push(`地面物品数量小于 1：${item.proto.id} ${item.quantity}`);
      if (item.corpse && !monById.has(item.corpse)) {
        problems.push(`尸体对应的怪物不存在：${item.corpse}`);
      }
      if (item.corpse && item.age !== undefined && item.age > session.turn) {
        problems.push(`尸体的形成回合晚于当前回合：${item.corpse} age=${item.age}`);
      }
      if (item.tin && !monById.has(item.tin)) {
        problems.push(`罐头内容对应的怪物不存在：${item.tin}`);
      }
      if (item.age !== undefined && !item.corpse) {
        problems.push(`非尸体带有形成回合：${item.proto.id}`);
      }
      if (item.age !== undefined && !Number.isFinite(item.age)) {
        problems.push(`尸体的形成回合非法：${item.age}`);
      }
      checkContents(item, `地面 ${item.proto.id}`, problems);
    }
  }

  // 背包与装备
  for (const item of player.inventory) {
    if (item.quantity < 1) problems.push(`背包物品数量小于 1：${item.proto.id}`);
    // 未付款的货品只能留在商店地面；一旦进了背包就是漏账。
    if (item.unpaid) problems.push(`未付款物品在背包中：${item.proto.id}`);
    checkContents(item, `背包 ${item.proto.id}`, problems);
  }
  for (const [slot, item] of Object.entries(player.equipment)) {
    if (item && !player.inventory.includes(item)) {
      problems.push(`装备槽 ${slot} 指向不在背包中的物品：${item.proto.id}`);
    }
  }

  // 挖掘进度必须指向本层仍然合法的目标，否则换层后会留下悬空状态。
  if (session.digging) {
    const d = session.digging;
    if (d.x < 0 || d.y < 0 || d.x >= level.width || d.y >= level.height) {
      problems.push(`挖掘目标越界：(${d.x}, ${d.y})`);
    } else {
      const tile = level.tiles[index(d.x, d.y)];
      if (d.down) {
        if (tile !== T.ROOM && tile !== T.CORR) problems.push('向下挖的目标不是普通地面');
      } else if (!isWall(tile)) {
        problems.push('挖墙的目标已经不是墙');
      }
    }
    if (d.progress < 1 || d.progress > 9) problems.push(`挖掘进度异常：${d.progress}`);
  }

  // 商店：房间完整可走，不藏陷阱，店主看店。
  const shops = level.rooms.filter((r) => r.type === 'shop');
  if (shops.length > 1) problems.push(`本层有 ${shops.length} 间商店`);
  for (const s of shops) {
    if (!s.shopType || !(s.shopType in SHOP_TYPES)) {
      problems.push(`商店缺少合法种类：${s.shopType ?? '无'}`);
    }
  }
  const shop = shopRoom(level);
  if (shop) {
    for (let x = shop.lx; x <= shop.hx; x++) {
      for (let y = shop.ly; y <= shop.hy; y++) {
        if (!walkableAt(level, x, y)) problems.push(`商店地板不可通行：(${x}, ${y})`);
      }
    }
    for (const [i] of level.traps) {
      const at = coords(i);
      if (inRoom(shop, at.x, at.y)) problems.push(`商店内存在陷阱：(${at.x}, ${at.y})`);
    }
    const keeper = level.monsters.find((m) => !m.dead && m.data.id === 'SHOPKEEPER');
    // 和平的店主守着店；被挑衅变敌对后会追出店外，这时不再要求它在店内。
    if (keeper && !keeper.angry && !inRoom(shop, keeper.x, keeper.y)) {
      problems.push(`店主不在店内：(${keeper.x}, ${keeper.y})`);
    }
  }

  // 楼梯必须存在且可通行；分支入口层还要有一段分支楼梯。
  if (!level.down && session.depth < session.maxDepth) problems.push('本层缺少下行楼梯');
  if (!level.up && !(session.branch === 'main' && session.depth === 1)) {
    // 推箱顶层只有下行楼梯，回程要从入口层走分支楼梯。
    if (!(level.branch === 'sokoban' && level.depth === 1)) problems.push('本层缺少上行楼梯');
  }
  if (
    !level.branch &&
    branchByEntrance(session.depth)?.hidden !== true &&
    branchByEntrance(session.depth) &&
    !level.stairs.some((s) => s.dir === 'branch')
  ) {
    problems.push(`分支入口层缺少分支楼梯：第 ${session.depth} 层`);
  }
  for (const stair of level.stairs) {
    if (level.tiles[index(stair.x, stair.y)] !== T.STAIRS) {
      problems.push(`楼梯标记与瓦片不符：(${stair.x}, ${stair.y})`);
    }
  }

  // 视野必须与玩家当前位置一致：自身所在格必须可见，且可见瓦片写入迷雾记忆。
  if (session.visible) {
    if (!session.visible[index(player.x, player.y)]) {
      problems.push(`玩家所在格不在视野内：(${player.x}, ${player.y})`);
    }
    let missing = 0;
    for (let i = 0; i < session.visible.length; i++) {
      if (session.visible[i] && !level.seen[i]) missing++;
    }
    if (missing) problems.push(`有 ${missing} 个可见瓦片未写入迷雾记忆`);
  }

  // 迷雾只增不减；换层后重置基线。
  if (tracker) {
    const seen = seenCount(level);
    if (tracker.level === level && seen < tracker.count) {
      problems.push(`迷雾数量倒退：${tracker.count} -> ${seen}`);
    }
    tracker.level = level;
    tracker.count = seen;
  }

  return problems;
}

/**
 * 关卡生成的确定性检查：同一种子必须得到同一地形。
 * 只比较地形与设施，怪物与物品在进入楼层时才生成。
 */
export function checkLevelDeterminism(gameSeed: number, depth: number): string[] {
  const problems: string[] = [];
  const a = generateLevel({ gameSeed, depth });
  const b = generateLevel({ gameSeed, depth });
  const key = (level: Level): string =>
    [
      Array.from(level.tiles).join(''),
      Array.from(level.lit).join(''),
      [...level.doors.keys()].sort((m, n) => m - n).join(','),
      [...level.traps.keys()].sort((m, n) => m - n).join(','),
      level.stairs.map((s) => `${s.x},${s.y},${s.dir}`).join(';'),
      `${level.rooms.length}`,
    ].join('|');
  if (key(a) !== key(b)) problems.push(`第 ${depth} 层地形不可复现`);
  if (!a.rooms.length) problems.push(`第 ${depth} 层没有房间`);
  if (a.down && !walkableAt(a, a.down.x, a.down.y)) problems.push(`第 ${depth} 层下行楼梯不可通行`);
  return problems;
}

/** 门审计结果。 */
interface DoorAudit {
  /** ASCII 地图上找到的门数。 */
  doors: number;
  /** 满足「前后是通道、两侧是墙」的门数。 */
  proper: number;
  problems: string[];
}

/**
 * 用 ASCII 地图核对门的形状与朝向。
 *
 * 期望值只从地图字符推导：门必须恰好在一个轴的**两侧都能走**，
 * 而另一个轴的两侧都是墙。这样通道唯一，门板垂直于它。
 * 期望值不调用 `doorBlocksEastWest`，否则就成了拿判定核对判定。
 *
 * 地图字符有同形：水槽是 `#`（与走廊同字），墓碑是 `|`（与墙同字），
 * 陷阱的 `^` 会盖住房间或走廊。生成器保证设施不挨着门，
 * 而 `^` 算可通行，因此这几种同形不会影响判定。
 */
export function auditDoors(level: Level): DoorAudit {
  const rows = levelToAscii(level).split('\n');
  const at = (x: number, y: number): string => rows[y]?.[x] ?? ' ';
  // 可通行的字形：房间、走廊、门、楼梯、陷阱、设施。
  const OPEN = new Set(['.', '#', '+', '<', '>', '^', '{', '_', '\\']);
  const WALL = new Set(['|', '-']);
  const doors: [number, number][] = [];
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      if (rows[y][x] === '+') doors.push([x, y]);
    }
  }
  const out: DoorAudit = { doors: doors.length, proper: 0, problems: [] };
  if (doors.length !== level.doors.size) {
    out.problems.push(`ASCII 地图有 ${doors.length} 扇门，门表有 ${level.doors.size} 扇`);
  }
  for (const [x, y] of doors) {
    const n = at(x, y - 1);
    const s = at(x, y + 1);
    const e = at(x + 1, y);
    const w = at(x - 1, y);
    const openEW = OPEN.has(e) && OPEN.has(w);
    const openNS = OPEN.has(n) && OPEN.has(s);
    const wallEW = WALL.has(e) && WALL.has(w);
    const wallNS = WALL.has(n) && WALL.has(s);
    const properEW = openEW && wallNS;
    const properNS = openNS && wallEW;
    if (!properEW && !properNS) {
      out.problems.push(
        `门 (${x}, ${y}) 不是「前后通道、两侧墙」：邻域 N=${n} S=${s} E=${e} W=${w}`,
      );
      continue;
    }
    out.proper++;
    const actual = doorBlocksEastWest(level, x, y);
    if (actual !== properEW) {
      out.problems.push(
        `门 (${x}, ${y}) 通道在${properEW ? '东西' : '南北'}向，` +
          `门板却拦${actual ? '东西' : '南北'}向；邻域 N=${n} S=${s} E=${e} W=${w}`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 随机行动
// ---------------------------------------------------------------------------

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** 一次随机行动的描述与执行结果。 */
interface RandomActionResult {
  action: string;
  result: string;
  delta: number;
}

/**
 * 生成并执行一步随机行动。
 *
 * 行动分布偏向移动，并混入等待、拾取与使用物品，
 * 以便在一次运行中覆盖更多代码路径。
 */
export function randomAction(session: GameSession, rng: Rng): RandomActionResult {
  if (session.dead) {
    // 死亡后继续发指令，用于验证状态被冻结。
    const before = session.turn;
    const outcome = session.movePlayer(0, 1);
    return { action: 'dead-move', result: outcome.result, delta: session.turn - before };
  }
  // 读到灭绝卷轴后在等待输入：随机挑一个物种提交，覆盖该分支。
  if (session.pendingGenocide) {
    const target = rng.pick(MONSTERS) as (typeof MONSTERS)[number];
    const ok = session.tryGenocide(target.name);
    return { action: `genocide:${target.id}`, result: ok ? 'used' : 'nothing', delta: 0 };
  }

  const roll = rng.rn2(100);
  const before = session.turn;

  if (roll < 6) {
    const outcome = session.wait();
    return { action: 'wait', result: outcome.result, delta: session.turn - before };
  }
  if (roll < 12) {
    const outcome = session.pickupAction();
    return { action: 'pickup', result: outcome.result, delta: session.turn - before };
  }
  if (roll < 20 && session.player.inventory.length) {
    const item = rng.pick(session.player.inventory) as (typeof session.player.inventory)[number];
    const verb = roll < 15 ? 'wield' : 'wear';
    const outcome = session.useItem(item, verb);
    return {
      action: `${verb}:${item.proto.id}`,
      result: outcome.result,
      delta: session.turn - before,
    };
  }
  if (roll < 30 && session.player.inventory.length) {
    const consumable = session.player.inventory.filter((i) =>
      ['potion', 'scroll', 'food'].includes(i.proto.cls),
    );
    const item = rng.pick(consumable);
    if (item) {
      const outcome = session.useItem(item);
      return {
        action: `use:${item.proto.id}`,
        result: outcome.result,
        delta: session.turn - before,
      };
    }
  }
  // 魔杖与神器启动：让模糊测试也覆盖这些效果分支。
  if (roll < 36 && session.player.inventory.length) {
    const wand = session.player.inventory.find(
      (i) => i.proto.cls === 'wand' && (i.charges ?? 0) > 0,
    );
    if (wand) {
      const outcome = session.useItem(wand, 'zap');
      return {
        action: `zap:${wand.proto.id}`,
        result: outcome.result,
        delta: session.turn - before,
      };
    }
  }
  if (roll < 40 && session.player.inventory.length) {
    const artifact = session.player.inventory.find((i) => i.artifact);
    if (artifact) {
      const outcome = session.useItem(artifact, 'invoke');
      return {
        action: `invoke:${artifact.proto.id}`,
        result: outcome.result,
        delta: session.turn - before,
      };
    }
  }
  if (roll < 44 && session.player.inventory.length) {
    const throwable = session.player.inventory.find((i) => i.proto.cls !== 'coin');
    if (throwable) {
      const outcome = session.useItem(throwable, 'throw');
      return {
        action: `throw:${throwable.proto.id}`,
        result: outcome.result,
        delta: session.turn - before,
      };
    }
  }

  const [dx, dy] = rng.pick(DIRS) as [number, number];
  const outcome = session.movePlayer(dx, dy);
  return { action: `move:${dx},${dy}`, result: outcome.result, delta: session.turn - before };
}

/** 探针：读取怪物列表的摘要，便于 Agent 观察战场。 */
export function monsterSummary(monsters: Monster[]): string[] {
  return monsters.map(
    (m) => `${m.data.id}@${m.x},${m.y} hp=${m.mhp}/${m.mhpmax} ${m.asleep ? '沉睡' : '清醒'}`,
  );
}

/** 关卡摘要：一屏内可读的地形与实体统计。 */
export function levelSummary(session: GameSession): Record<string, number | string> {
  const level = session.level;
  return {
    depth: session.depth,
    turn: session.turn,
    rooms: level.rooms.length,
    doors: level.doors.size,
    traps: level.traps.size,
    stairs: level.stairs.length,
    monsters: level.monsters.length,
    piles: level.objects.length,
    seen: seenCount(level),
    player: `${session.player.x},${session.player.y}`,
    hp: `${session.player.hp}/${session.player.maxHp}`,
    role: session.player.role.id,
  };
}

/** 把坐标转为可读字符串，供日志与失败详情使用。 */
export function pos(x: number, y: number): string {
  return `${x},${y}`;
}

export {
  index,
  coords,
  inBounds,
  computeFov,
  monsterAt,
  levelToAscii,
  generateLevel,
  doorBlocksEastWest,
  T,
  isWalkable,
};
