/**
 * 地牢关卡生成。
 *
 * 参考 NetHack 的 src/mklev.c：随机放置互不重叠的房间，再用走廊连接。
 * 本实现的步骤：
 *
 * 1. 反复尝试放置房间，直到连续失败（尺寸上限与 NetHack 一致：宽 2 到 12、
 *    高 2 到 6、面积不超过 50）。
 * 2. 按横坐标排序，连接相邻房间，另外追加若干随机连接。
 * 3. 用最短路挖走廊，房间内瓦片代价更高，因此走廊只有在无路可走时才穿房。
 *    NetHack 直接挖 L 形走廊；这里用寻路得到同样的拓扑，但更少破坏房间。
 * 4. 在走廊与房间交界处放门，计算墙体，然后布置楼梯、陷阱与地形设施。
 *
 * 关卡完全由 `(gameSeed, depth)` 决定，因此存档只需保存种子。
 */

import {
  COLNO,
  MAX_DEPTH,
  ROWNO,
  T,
  isWall,
  isRoom,
  isCorr,
  isWalkable,
  randomTrapTypes,
} from '../core/constants';
import { createRng, deriveSeed } from '../core/rng';
import { createLogger, LOG_NS } from '../core/log';
import { specialLevelFor, branchSpecialFor } from './special';
import { branchById, branchByEntrance } from './branches';
import { SOKOBAN_LEVELS } from '../data/sokoban.gen';
import { SOKOBAN_CLASSES, type SokobanVariant } from './sokoban';
import { QUEST_HOME_LEVELS, QUEST_LOCATE_LEVELS, QUEST_GOAL_LEVELS } from '../data/quest.gen';
import { QUEST_MAP_CHARS } from './quest';
import { makeBoulder, makeItem, randomItemOfClass } from './items';
import { OBJECTS } from '../data/index';
import type {
  Alignment,
  FeatureState,
  GroundPile,
  ItemInstance,
  Level,
  ObjectClass,
  Room,
  Rng,
  ShopType,
} from '../types';

const log = createLogger(LOG_NS.dungeon);

/** 二维坐标转一维下标。 */
export const index = (x: number, y: number): number => y * COLNO + x;

/** 一维下标转二维坐标。 */
export const coords = (i: number): { x: number; y: number } => ({
  x: i % COLNO,
  y: Math.floor(i / COLNO),
});

/** 坐标是否落在关卡范围内。 */
export const inBounds = (x: number, y: number): boolean =>
  x >= 0 && x < COLNO && y >= 0 && y < ROWNO;

/** 生成阶段的房间候选（尚未写入 level）。 */
interface RoomRect {
  lx: number;
  ly: number;
  hx: number;
  hy: number;
  lit: boolean;
}

// ---------------------------------------------------------------------------
// 房间
// ---------------------------------------------------------------------------

/** 两个矩形在给定间距内是否重叠。 */
function roomsOverlap(a: RoomRect, b: RoomRect, pad = 1): boolean {
  return !(a.lx - pad > b.hx || a.hx + pad < b.lx || a.ly - pad > b.hy || a.hy + pad < b.ly);
}

/** 房间中心点。 */
function roomCenter(r: { lx: number; ly: number; hx: number; hy: number }): {
  x: number;
  y: number;
} {
  return { x: Math.floor((r.lx + r.hx) / 2), y: Math.floor((r.ly + r.hy) / 2) };
}

/** 矩形房间是否包含某格。 */
export function inRoom(
  r: { lx: number; ly: number; hx: number; hy: number },
  x: number,
  y: number,
): boolean {
  return x >= r.lx && x <= r.hx && y >= r.ly && y <= r.hy;
}

/** 本层的商店房间，没有时返回 null。 */
export function shopRoom(level: Level): Room | null {
  return level.rooms.find((r) => r.type === 'shop') ?? null;
}

/** 坐标是否位于商店房间内。 */
export function inShopRoom(level: Level, x: number, y: number): boolean {
  const room = shopRoom(level);
  return !!room && inRoom(room, x, y);
}

/** 随机放置房间，返回房间列表。 */
function placeRooms(level: Level, rng: Rng): Room[] {
  const rects: RoomRect[] = [];
  const MAX_ROOMS = 10;
  const MAX_TRIES = 400;

  for (let tries = 0; tries < MAX_TRIES && rects.length < MAX_ROOMS; tries++) {
    if (tries > 50 && rects.length >= 6 && rng.rn2(3) === 0) break;

    let w = 2 + rng.rn2(11); // 2 到 12
    let h = 2 + rng.rn2(5); // 2 到 6
    if (w * h > 50) h = Math.max(2, Math.floor(50 / w));
    // 深层关卡房间略大，与 NetHack 的倾向一致。
    if (level.depth > 10 && rng.rn2(3) === 0) w = Math.min(12, w + 2);

    const lx = 1 + rng.rn2(COLNO - w - 2);
    const ly = 1 + rng.rn2(ROWNO - h - 2);
    const cand: RoomRect = { lx, ly, hx: lx + w - 1, hy: ly + h - 1, lit: false };

    // 房间之间留 3 格：两侧各一格墙体，中间一格给走廊，
    // 走廊因此不会紧贴房间，房间侧面也不会被凿出缺口。
    if (rects.some((r) => roomsOverlap(cand, r, 3))) continue;
    rects.push(cand);
  }

  return rects.map((r, i) => ({
    lx: r.lx,
    ly: r.ly,
    hx: r.hx,
    hy: r.hy,
    index: i,
    type: 'room' as const,
    lit: level.depth === 1 ? true : rng.rn2(4) !== 0,
  }));
}

/** 把房间内部挖成地板。 */
function carveRooms(level: Level, rooms: Room[]): void {
  for (const r of rooms) {
    for (let x = r.lx; x <= r.hx; x++) {
      for (let y = r.ly; y <= r.hy; y++) {
        level.tiles[index(x, y)] = T.ROOM;
        if (r.lit) level.lit[index(x, y)] = 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 走廊
// ---------------------------------------------------------------------------

/** 液体格：走廊不能穿过。 */
function isLiquidTile(t: number): boolean {
  return t === T.POOL || t === T.MOAT || t === T.WATER || t === T.LAVA;
}

/**
 * 该格是否落在某个房间的矩形之内。
 *
 * 不能只看瓦片类型：房间地面可能被楼梯、陷阱或设施覆盖，
 * 那时 `tiles[i]` 已经不是 ROOM，但它在结构上仍然是房间的一部分。
 */
export function insideRoom(level: Level, x: number, y: number): boolean {
  for (const room of level.rooms) {
    if (x >= room.lx && x <= room.hx && y >= room.ly && y <= room.hy) return true;
  }
  return false;
}

/**
 * 该格是否与房间外圈相邻（含对角）。
 *
 * 外圈一圈含四个角都留给墙与门：走廊斜着切过房间角会蹭到门的两侧，
 * 让门失去「左右是墙」的形状。中间的车道离房间两格，不受影响。
 */
function touchesRoom(level: Level, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (insideRoom(level, x + dx, y + dy)) return true;
    }
  }
  return false;
}

/** 门朝向判定里算作「可通行」的瓦片。 */
function doorPassage(t: number): boolean {
  return isRoom(t) || isCorr(t) || t === T.DOOR || t === T.STAIRS;
}

/**
 * 一扇门是否拦东西方向的通行，即门板是否竖着立在格子里。
 *
 * 生成器保证每扇门都是「一个轴两侧是通道、另一个轴两侧是墙」，
 * 对角都能走的轴就是玩家实际穿过的轴，门板垂直于它。
 * 万一遇到不合规的门（地图被外部改动或旧数据），退回房间所在轴，
 * 用房间矩形而不是瓦片类型判断，因为房间地面可能被楼梯或设施覆盖。
 */
export function doorBlocksEastWest(level: Level, x: number, y: number): boolean {
  const open = (px: number, py: number): number =>
    doorPassage(level.tiles[index(px, py)]) ? 1 : 0;
  const openEW = open(x - 1, y) + open(x + 1, y) === 2;
  const openNS = open(x, y - 1) + open(x, y + 1) === 2;
  if (openEW !== openNS) return openEW;
  const roomX = insideRoom(level, x - 1, y) || insideRoom(level, x + 1, y);
  const roomY = insideRoom(level, x, y - 1) || insideRoom(level, x, y + 1);
  if (roomX !== roomY) return roomX;
  // 两侧都有房间或都没有时，按可通行的邻居数量决定。
  const scoreX = open(x - 1, y) + open(x + 1, y);
  const scoreY = open(x, y - 1) + open(x, y + 1);
  return scoreX >= scoreY;
}

/** 四个正交方向，顺序固定以便结果可复现。 */
const CORRIDOR_DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** 转弯的额外代价：让路线倾向长直线，而不是每一步都拐一下。 */
const TURN_COST = 0.35;

/**
 * 挖走廊用的最短路。
 *
 * 状态是「格子 + 进入方向」，因此可以给转弯加价：路线会尽量走直线，
 * 拐弯集中在少数几处，这与原版走廊的观感一致。
 *
 * 房间内部与**房间外墙一圈**都不可穿越：外墙一圈留给墙体和门。
 * 走廊踩到外墙会把房间侧面凿出缺口，也会造出没有正对通道的拐角门。
 * 液体不可通过。
 */
function findCorridorPath(level: Level, from: number, to: number): number[] | null {
  const states = COLNO * ROWNO * 4;
  const dist = new Float64Array(states).fill(Infinity);
  const prevState = new Int32Array(states).fill(-1);
  const visited = new Uint8Array(states);
  const heap: [number, number][] = [];

  const push = (d: number, s: number): void => {
    heap.push([d, s]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop() as [number, number];
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  const fromX = from % COLNO;
  const fromY = (from / COLNO) | 0;
  // 起点向四个方向铺开，第一步不计转弯代价。
  for (let d = 0; d < 4; d++) {
    const [dx, dy] = CORRIDOR_DIRS[d];
    const nx = fromX + dx;
    const ny = fromY + dy;
    if (!inBounds(nx, ny)) continue;
    const v = index(nx, ny);
    if (isLiquidTile(level.tiles[v])) continue;
    if (isRoom(level.tiles[v]) && v !== to) continue;
    if (touchesRoom(level, nx, ny)) continue;
    const step = isCorr(level.tiles[v]) || level.tiles[v] === T.DOOR ? 0.5 : 1;
    const s = v * 4 + d;
    if (step < dist[s]) {
      dist[s] = step;
      push(step, s);
    }
  }

  let endState = -1;
  while (heap.length) {
    const [d, state] = pop();
    if (visited[state] || d > dist[state]) continue;
    visited[state] = 1;
    const node = state >> 2;
    if (node === to) {
      endState = state;
      break;
    }
    const x = node % COLNO;
    const y = (node / COLNO) | 0;
    const dir = state & 3;
    for (let nd = 0; nd < 4; nd++) {
      const [dx, dy] = CORRIDOR_DIRS[nd];
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const v = index(nx, ny);
      const t = level.tiles[v];
      if (isLiquidTile(t)) continue;
      if (isRoom(t) && v !== to) continue;
      if (touchesRoom(level, nx, ny)) continue;
      const step = isCorr(t) || t === T.DOOR ? 0.5 : 1;
      const turn = nd === dir ? 0 : TURN_COST;
      const ns = v * 4 + nd;
      const alt = d + step + turn;
      if (alt < dist[ns]) {
        dist[ns] = alt;
        prevState[ns] = state;
        push(alt, ns);
      }
    }
  }

  if (endState < 0) return null;
  const path: number[] = [];
  for (let s = endState; s !== -1; s = prevState[s]) path.push(s >> 2);
  path.reverse();
  return path;
}

/** 一扇门的两个关键格：房间外圈的门位，以及门外一格的走廊起点。 */
interface DoorExit {
  door: { x: number; y: number };
  outer: { x: number; y: number };
}

/**
 * 房间朝目标一侧的开口。
 *
 * 门位在房间外圈，门口方向与房间外墙垂直：门外一格是走廊起点，
 * 两侧则是同一道外墙延伸出去的墙，因此天然满足「前后是通道、左右是墙」。
 * 开口位置尽量对准目标，走廊因此接近直线；加上一点抖动避免每层都一样。
 */
function exitPoint(
  level: Level,
  room: { lx: number; ly: number; hx: number; hy: number },
  toward: { x: number; y: number },
  rng: Rng,
): DoorExit | null {
  const dx = toward.x < room.lx ? -1 : toward.x > room.hx ? 1 : 0;
  const dy = toward.y < room.ly ? -1 : toward.y > room.hy ? 1 : 0;
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const jitter = rng.rn2(3) - 1;
  const horizontalFirst = dx !== 0 && (dy === 0 || rng.rn2(2) === 0);
  let door: { x: number; y: number };
  let outward: { x: number; y: number };
  if (horizontalFirst) {
    door = {
      x: dx < 0 ? room.lx - 1 : room.hx + 1,
      y: clamp(Math.round(toward.y) + jitter, room.ly, room.hy),
    };
    outward = { x: dx < 0 ? -1 : 1, y: 0 };
  } else if (dy !== 0) {
    door = {
      x: clamp(Math.round(toward.x) + jitter, room.lx, room.hx),
      y: dy < 0 ? room.ly - 1 : room.hy + 1,
    };
    outward = { x: 0, y: dy < 0 ? -1 : 1 };
  } else {
    door = { x: room.hx + 1, y: clamp(Math.round(toward.y), room.ly, room.hy) };
    outward = { x: 1, y: 0 };
  }
  const outer = { x: door.x + outward.x, y: door.y + outward.y };
  if (!inBounds(outer.x, outer.y)) return null;
  // 门外一格不能贴着任何房间，否则那条走廊会把别的房间凿出缺口。
  if (touchesRoom(level, outer.x, outer.y)) return null;
  return { door, outer };
}

/** 门位是否合规：只贴一间房，正面可通行，两侧是墙或石头。 */
function doorShapeOk(level: Level, x: number, y: number): boolean {
  if (!inBounds(x, y)) return false;
  const roomEast = insideRoom(level, x + 1, y);
  const roomWest = insideRoom(level, x - 1, y);
  const roomNorth = insideRoom(level, x, y - 1);
  const roomSouth = insideRoom(level, x, y + 1);
  if ([roomEast, roomWest, roomNorth, roomSouth].filter(Boolean).length !== 1) return false;
  const passable = (px: number, py: number): boolean => {
    const t = level.tiles[index(px, py)];
    return isCorr(t) || isRoom(t) || t === T.STAIRS || t === T.DOOR;
  };
  const solid = (px: number, py: number): boolean => {
    const t = level.tiles[index(px, py)];
    return !passable(px, py) && t !== T.DOOR;
  };
  if (roomEast || roomWest) {
    const front = roomEast ? { x: x - 1, y } : { x: x + 1, y };
    return passable(front.x, front.y) && solid(x, y - 1) && solid(x, y + 1);
  }
  const front = roomSouth ? { x, y: y - 1 } : { x, y: y + 1 };
  return passable(front.x, front.y) && solid(x - 1, y) && solid(x + 1, y);
}

/** 把合规的门位落成门；形状不合规时原样保留走廊。 */
function placeDoor(level: Level, at: { x: number; y: number }, rng: Rng): boolean {
  if (!doorShapeOk(level, at.x, at.y)) return false;
  const i = index(at.x, at.y);
  if (!level.doors.has(i)) {
    level.doors.set(i, { closed: rng.rn2(3) !== 0, locked: rng.rn2(6) === 0, broken: false });
  }
  level.tiles[i] = T.DOOR;
  return true;
}

/**
 * 挖通两个房间：从房间外圈开口，门外一格作为走廊起点，
 * 走廊不碰任何房间外墙，末端落到对面的门口。
 */
function connectRooms(level: Level, a: Room, b: Room, rng: Rng): boolean {
  const ca = roomCenter(a);
  const cb = roomCenter(b);
  // 抖动只影响开口位置；失败就重掷几次，换一处墙试试。
  for (let attempt = 0; attempt < 8; attempt++) {
    const pa = exitPoint(level, a, cb, rng);
    const pb = exitPoint(level, b, ca, rng);
    if (!pa || !pb) continue;
    const from = index(pa.outer.x, pa.outer.y);
    const to = index(pb.outer.x, pb.outer.y);
    const path = from === to ? [from] : findCorridorPath(level, from, to);
    if (!path) continue;

    const tiles = [...path];
    if (tiles[0] !== from) tiles.unshift(from);
    if (tiles[tiles.length - 1] !== to) tiles.push(to);
    for (const i of tiles) {
      const tile = level.tiles[i];
      if (tile === T.STONE || isWall(tile)) level.tiles[i] = T.CORR;
    }
    const first = placeDoor(level, pa.door, rng);
    const second = placeDoor(level, pb.door, rng);
    // 至少落下一扇门时这条走廊就有效；两扇都被旁边的门挤掉才会重试。
    if (first || second) return true;
  }
  return false;
}

/** 房间中心之间的曼哈顿距离，用于就近接入走廊网络。 */
function roomDistance(a: Room, b: Room): number {
  const ca = roomCenter(a);
  const cb = roomCenter(b);
  return Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
}

/** 连接所有房间：每间房就近接入已连通的网络，再补若干随机连接。 */
function makeCorridors(level: Level, rng: Rng): void {
  const sorted = [...level.rooms].sort((a, b) => a.lx - b.lx || a.ly - b.ly);
  const connected: Room[] = [];
  for (const room of sorted) {
    if (!connected.length) {
      connected.push(room);
      continue;
    }
    // 距离相同时按房间序号，保证同一颗种子得到同一条走廊。
    const targets = [...connected].sort(
      (a, b) => roomDistance(a, room) - roomDistance(b, room) || a.index - b.index,
    );
    for (const target of targets) {
      if (connectRooms(level, target, room, rng)) break;
    }
    connected.push(room);
  }
  // 额外连接避免地图退化成树形，原版同样会这样做。
  const extra = rng.rn2(sorted.length) + 4;
  for (let i = 0; i < extra && sorted.length > 2; i++) {
    const a = rng.rn2(sorted.length);
    const b = rng.rn2(sorted.length);
    if (a !== b) connectRooms(level, sorted[a], sorted[b], rng);
  }
}

/** 房间外圈上正对房间、且门外一格可用的所有门位。 */
function ringDoorExits(level: Level, room: Room): DoorExit[] {
  const out: DoorExit[] = [];
  const push = (door: { x: number; y: number }, outer: { x: number; y: number }): void => {
    if (!inBounds(outer.x, outer.y)) return;
    if (touchesRoom(level, outer.x, outer.y)) return;
    out.push({ door, outer });
  };
  for (let y = room.ly; y <= room.hy; y++) {
    push({ x: room.lx - 1, y }, { x: room.lx - 2, y });
    push({ x: room.hx + 1, y }, { x: room.hx + 2, y });
  }
  for (let x = room.lx; x <= room.hx; x++) {
    push({ x, y: room.ly - 1 }, { x, y: room.ly - 2 });
    push({ x, y: room.hy + 1 }, { x, y: room.hy + 2 });
  }
  return out;
}

/** 从门外一格向外挖，接到最近的走廊；接不到就留一格死头，保证门外是通道。 */
function reachCorridor(level: Level, from: { x: number; y: number }): void {
  const start = index(from.x, from.y);
  const prev = new Map<number, number>();
  const queue = [start];
  prev.set(start, -1);
  let found = -1;
  for (let head = 0; head < queue.length && found < 0; head++) {
    const node = queue[head] as number;
    const x = node % COLNO;
    const y = (node / COLNO) | 0;
    for (const [dx, dy] of CORRIDOR_DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const v = index(nx, ny);
      if (prev.has(v)) continue;
      if (isCorr(level.tiles[v])) {
        prev.set(v, node);
        found = v;
        break;
      }
      if (level.tiles[v] !== T.STONE || touchesRoom(level, nx, ny)) continue;
      prev.set(v, node);
      queue.push(v);
    }
  }
  for (let node = found >= 0 ? found : start; node !== -1; node = prev.get(node) ?? -1) {
    if (level.tiles[node] === T.STONE) level.tiles[node] = T.CORR;
  }
}

/** 房间外圈上是否已有门。 */
function roomHasDoor(level: Level, room: Room): boolean {
  for (let x = room.lx - 1; x <= room.hx + 1; x++) {
    for (let y = room.ly - 1; y <= room.hy + 1; y++) {
      if (level.doors.has(index(x, y))) return true;
    }
  }
  return false;
}

/**
 * 门的规范化：清掉不合规的门，并保证每个房间都有入口。
 *
 * 正常生成时门位已经由 `placeDoor` 校验过，这里主要兜住连接失败
 * 或地图被外部改动的情况：宁可补一段走廊，也不留下没有门的房间。
 */
function placeDoors(level: Level, rng: Rng): void {
  // 一、清理不合规或相邻的门，封回墙位，避免房间侧面留下缺口。
  // 迭代中只删除当前项，Map 迭代器允许这种写法。
  for (const i of level.doors.keys()) {
    const x = i % COLNO;
    const y = (i / COLNO) | 0;
    const adjacent =
      level.doors.has(index(x - 1, y)) ||
      level.doors.has(index(x + 1, y)) ||
      level.doors.has(index(x, y - 1)) ||
      level.doors.has(index(x, y + 1));
    if (adjacent || !doorShapeOk(level, x, y)) {
      level.tiles[i] = T.STONE;
      level.doors.delete(i);
    }
  }

  // 二、给还没有门的房间补入口：优先用门外已有的走廊，其次补一小段。
  for (const room of level.rooms) {
    if (roomHasDoor(level, room)) continue;
    let placed = false;
    for (const exit of ringDoorExits(level, room)) {
      if (!isCorr(level.tiles[index(exit.outer.x, exit.outer.y)])) continue;
      if (placeDoor(level, exit.door, rng)) {
        placed = true;
        break;
      }
    }
    if (placed) continue;
    for (const exit of ringDoorExits(level, room)) {
      reachCorridor(level, exit.outer);
      if (placeDoor(level, exit.door, rng)) break;
    }
  }
}

/** 与被开挖区域相邻的石头变为墙体，并按邻接方向区分横墙与竖墙。 */
function computeWalls(level: Level): void {
  const carved = new Uint8Array(COLNO * ROWNO);
  for (let i = 0; i < carved.length; i++) {
    const t = level.tiles[i];
    if (t !== T.STONE && !isWall(t)) carved[i] = 1;
  }
  for (let x = 0; x < COLNO; x++) {
    for (let y = 0; y < ROWNO; y++) {
      const i = index(x, y);
      if (level.tiles[i] !== T.STONE) continue;
      let adj = false;
      for (let dx = -1; dx <= 1 && !adj; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(nx, ny)) continue;
          if (carved[index(nx, ny)]) {
            adj = true;
            break;
          }
        }
      }
      if (!adj) continue;
      // 左右有地板则为竖墙，上下有地板则为横墙。
      const sideFloor =
        (inBounds(x - 1, y) && carved[index(x - 1, y)]) ||
        (inBounds(x + 1, y) && carved[index(x + 1, y)]);
      level.tiles[i] = sideFloor ? T.VWALL : T.HWALL;
    }
  }
}

// ---------------------------------------------------------------------------
// 楼梯、陷阱与地形设施
// ---------------------------------------------------------------------------

/** 收集所有满足条件的瓦片下标。 */
function freeTiles(
  level: Level,
  predicate: (t: number, i: number, x: number, y: number) => boolean,
): number[] {
  const out: number[] = [];
  for (let x = 1; x < COLNO - 1; x++) {
    for (let y = 1; y < ROWNO - 1; y++) {
      const i = index(x, y);
      if (predicate(level.tiles[i], i, x, y)) out.push(i);
    }
  }
  return out;
}

/** 放置上下楼梯；分支楼层由 opts 决定是否缺上行或下行。 */
function placeStairs(
  level: Level,
  rng: Rng,
  opts: {
    isBranch?: boolean;
    isBottom?: boolean;
    /** 不能落楼梯的瓦片（例如任务巢穴的室内）；按下标判断。 */
    avoidTiles?: (i: number) => boolean;
  } = {},
): void {
  const rooms = level.rooms;
  if (!rooms.length) return;
  const avoid = opts.avoidTiles ?? ((): boolean => false);
  const startRoom = rooms[0];
  const sc = roomCenter(startRoom);

  // 下行楼梯放在离起始房间最远的房间。
  let far = rooms[0];
  let farDist = -1;
  for (const r of rooms) {
    const c = roomCenter(r);
    const d = Math.abs(c.x - sc.x) + Math.abs(c.y - sc.y);
    if (d > farDist) {
      farDist = d;
      far = r;
    }
  }

  const put = (room: Room, glyph: 'up' | 'down'): { x: number; y: number } | null => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = rng.rn1(room.lx, room.hx - room.lx + 1);
      const y = rng.rn1(room.ly, room.hy - room.ly + 1);
      const i = index(x, y);
      if (level.tiles[i] === T.ROOM && !avoid(i)) {
        level.tiles[i] = T.STAIRS;
        level.stairs.push({ x, y, dir: glyph });
        return { x, y };
      }
    }
    return null;
  };

  if (opts.isBranch || level.depth > 1) {
    // 从上层下来时，玩家出现在起始房间的上行楼梯处；分支第一层也靠它返回入口层。
    const up = put(startRoom, 'up');
    if (up) level.up = up;
  }
  if (!opts.isBranch || !opts.isBottom) {
    // 土之位面的出口要靠向下挖，不铺下行楼梯。
    if (level.special !== 'plane_earth') {
      const down = put(far === startRoom ? rooms[rooms.length - 1] : far, 'down');
      if (down) level.down = down;
    }
  }

  // 主地牢第 1 层的起始位置在起始房间内；其余层从上行楼梯进入。
  if (level.depth === 1 && !opts.isBranch) {
    level.start = level.down ? { x: startRoom.lx, y: startRoom.ly } : { ...sc };
    if (level.tiles[index(level.start.x, level.start.y)] !== T.ROOM) {
      const spot = freeTiles(level, (t) => t === T.ROOM)[0];
      if (spot !== undefined) level.start = coords(spot);
    }
  } else {
    level.start = level.up ?? { ...sc };
  }
}

/** 随机撒陷阱，数量随深度增加。 */
function placeTraps(level: Level, rng: Rng): void {
  const count = Math.min(10, rng.rn2(3) + Math.floor(level.depth / 4));
  if (count <= 0) return;
  const pool = randomTrapTypes(level.depth);
  const candidates = freeTiles(
    level,
    (t, i, x, y) =>
      (t === T.ROOM || t === T.CORR) &&
      !level.stairs.some((s) => index(s.x, s.y) === i) &&
      !level.traps.has(i) &&
      !inShopRoom(level, x, y),
  );
  rng.shuffle(candidates);
  for (let n = 0; n < count && candidates.length; n++) {
    const i = candidates.pop() as number;
    level.traps.set(i, { type: rng.pick(pool) as string, seen: false });
  }
}

/** 门口周围的格子不进设施，保证「门的前后是通道、两侧是墙」。 */
function nearDoor(level: Level, i: number): boolean {
  const x = i % COLNO;
  const y = (i / COLNO) | 0;
  return (
    level.doors.has(i) ||
    level.doors.has(index(x - 1, y)) ||
    level.doors.has(index(x + 1, y)) ||
    level.doors.has(index(x, y - 1)) ||
    level.doors.has(index(x, y + 1))
  );
}

/** 在入口层放一段通往分支的楼梯。 */
function placeBranchStairs(level: Level, rng: Rng, branch: string): void {
  const spots = freeTiles(
    level,
    (t, i) =>
      (t === T.ROOM || t === T.CORR) &&
      !level.traps.has(i) &&
      !level.stairs.some((s) => index(s.x, s.y) === i),
  );
  if (!spots.length) return;
  const i = rng.pick(spots) as number;
  const at = coords(i);
  level.tiles[i] = T.STAIRS;
  level.stairs.push({ x: at.x, y: at.y, dir: 'branch', branch });
}

/** 布置喷泉、水槽、祭坛、坟墓与王座。 */
function placeFeatures(
  level: Level,
  rng: Rng,
  gameSeed: number,
  { fixedAltars = false }: { fixedAltars?: boolean } = {},
): void {
  // 祭坛归属用独立随机流，不扰动其它设施的生成顺序。
  const altarSeed = level.branch
    ? deriveSeed(gameSeed, 'altar', level.branch, level.depth)
    : deriveSeed(gameSeed, 'altar', level.depth);
  const altarRng = createRng(altarSeed);
  const ALIGNMENTS: Alignment[] = ['lawful', 'neutral', 'chaotic'];
  const add = (
    tileType: number,
    chance: number,
    extra: () => Partial<FeatureState> = () => ({}),
  ): void => {
    if (!rng.chance(chance)) return;
    const spots = freeTiles(
      level,
      (t, i, x, y) =>
        t === T.ROOM &&
        !level.traps.has(i) &&
        !level.stairs.some((s) => index(s.x, s.y) === i) &&
        !nearDoor(level, i) &&
        !inShopRoom(level, x, y),
    );
    if (!spots.length) return;
    const i = rng.pick(spots) as number;
    level.tiles[i] = tileType;
    level.features.set(i, {
      type: Object.entries(T).find(([, v]) => v === tileType)?.[0] ?? 'feature',
      ...extra(),
    });
  };
  // 固定祭坛的特殊楼层（星界位面）由 placeSpecialAltars 单独布置，
  // 也不再撒喷泉与水槽，保持终局大厅干净。
  if (!fixedAltars) {
    add(T.FOUNTAIN, 0.22);
    add(T.SINK, 0.08);
    add(T.ALTAR, 0.12, () =>
      // 四分之一的祭坛不属于任何阵营（摩洛克），其余随机归属三神之一。
      altarRng.rn2(4) === 0 ? {} : { align: altarRng.pick(ALIGNMENTS) as Alignment },
    );
  }
  if (level.depth >= 3) add(T.GRAVE, 0.08);
  if (level.depth >= 6) add(T.THRONE, 0.07);
}

/** 大房间：整层是一间没有隔断的大厅，对应原版 Big Room。 */
function carveBigRoom(level: Level): void {
  const room: Room = {
    lx: 2,
    ly: 2,
    hx: COLNO - 3,
    hy: ROWNO - 3,
    index: 0,
    type: 'room',
    lit: true,
  };
  level.rooms = [room];
  carveRooms(level, level.rooms);
}

/** 任务目标层仇敌巢穴的室内范围（含），随大厅布局固定。 */
export const QUEST_LAIR = { lx: 34, ly: 7, hx: 46, hy: 14 } as const;

/**
 * 任务目标层的仇敌巢穴：大厅中央一间石室，只在南墙开一扇门。
 *
 * 在 computeWalls 之前把环墙置回石头，墙体类型由它统一计算；
 * 门留在南墙中点，满足「前后通道、两侧墙」的审计规则。
 */
function carveLairChamber(level: Level): void {
  const { lx, ly, hx, hy } = QUEST_LAIR;
  for (let x = lx - 1; x <= hx + 1; x++) {
    level.tiles[index(x, ly - 1)] = T.STONE;
    level.tiles[index(x, hy + 1)] = T.STONE;
  }
  for (let y = ly; y <= hy; y++) {
    level.tiles[index(lx - 1, y)] = T.STONE;
    level.tiles[index(hx + 1, y)] = T.STONE;
  }
  // 南墙开门：门两侧是墙，前后是地面。
  const doorX = (lx + hx) >> 1;
  level.tiles[index(doorX, hy + 1)] = T.DOOR;
  level.doors.set(index(doorX, hy + 1), { closed: true, locked: false, broken: false });
}

/** 额外放置同类设施（大墓地的坟墓、神谕所的喷泉）。 */
function placeExtraFeatures(
  level: Level,
  rng: Rng,
  count: number,
  tile: number,
  type: string,
): void {
  for (let n = 0; n < count; n++) {
    const spots = freeTiles(
      level,
      (t, i, x, y) =>
        t === T.ROOM &&
        !level.traps.has(i) &&
        !level.stairs.some((s) => index(s.x, s.y) === i) &&
        !nearDoor(level, i) &&
        !inShopRoom(level, x, y),
    );
    if (!spots.length) return;
    const i = rng.pick(spots) as number;
    level.tiles[i] = tile;
    level.features.set(i, { type });
  }
}

/**
 * 特殊楼层的固定祭坛（星界位面的三座神殿）。
 *
 * 空地按「到已选祭坛的最近距离」打分，逐座挑最远的，让三座祭坛分散在大厅里。
 */
function placeSpecialAltars(level: Level, aligns: Alignment[]): void {
  const chosen: { x: number; y: number }[] = [];
  for (const align of aligns) {
    const spots = freeTiles(
      level,
      (t, i, x, y) =>
        t === T.ROOM &&
        !level.traps.has(i) &&
        !level.stairs.some((s) => index(s.x, s.y) === i) &&
        !level.features.has(i) &&
        !nearDoor(level, i) &&
        !inShopRoom(level, x, y),
    );
    if (!spots.length) return;
    let best = spots[0];
    let bestScore = -1;
    for (const i of spots) {
      const at = coords(i);
      const score = chosen.length
        ? Math.min(...chosen.map((c) => Math.abs(c.x - at.x) + Math.abs(c.y - at.y)))
        : Math.abs(at.x - COLNO / 2) + Math.abs(at.y - ROWNO / 2);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    const at = coords(best);
    chosen.push(at);
    level.tiles[best] = T.ALTAR;
    level.features.set(best, { type: 'ALTAR', align });
  }
  log.debug('特殊祭坛已布置', { depth: level.depth, count: chosen.length });
}

/**
 * 元素位面的地形散布：把部分房间地面换成岩浆、水流或虚空。
 *
 * 虚空不可通行，可能把地面切成孤岛；每次改造后做一次连通性检查，
 * 不连通就撒回，因此楼梯与所有可行走格子始终连在一起。
 */
function scatterTerrain(
  level: Level,
  rng: Rng,
  tile: 'lava' | 'water' | 'air',
  chance: number,
): number {
  const target = tile === 'lava' ? T.LAVA : tile === 'water' ? T.WATER : T.AIR;
  const locked = new Set<number>();
  for (const spot of [level.up, level.down, level.start]) {
    if (spot) locked.add(index(spot.x, spot.y));
  }
  for (const stair of level.stairs) locked.add(index(stair.x, stair.y));
  for (const i of level.traps.keys()) locked.add(i);
  for (const i of level.features.keys()) locked.add(i);

  const candidates: number[] = [];
  for (let i = 0; i < level.tiles.length; i++) {
    if (level.tiles[i] === T.ROOM) candidates.push(i);
  }
  rng.shuffle(candidates);
  let changed = 0;
  for (const i of candidates) {
    if (locked.has(i)) continue;
    if (rng.float() >= chance) continue;
    level.tiles[i] = target;
    // 只有虚空会改变可通行性；其余地形不用重新检查。
    if (target === T.AIR && !floorConnected(level)) {
      level.tiles[i] = T.ROOM;
      continue;
    }
    changed++;
  }
  return changed;
}

/** 所有可行走格子是否连成一片；虚空散布后用它兜底。 */
function floorConnected(level: Level): boolean {
  const start = level.up ?? level.down ?? level.start;
  if (!start) return true;
  const from = index(start.x, start.y);
  if (!isWalkable(level.tiles[from])) return false;
  let total = 0;
  for (let i = 0; i < level.tiles.length; i++) {
    if (isWalkable(level.tiles[i])) total++;
  }
  const queue = [from];
  const seen = new Set<number>([from]);
  while (queue.length) {
    const i = queue.pop() as number;
    const x = i % COLNO;
    const y = (i / COLNO) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as [number, number][]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= COLNO || ny >= ROWNO) continue;
      const ni = index(nx, ny);
      if (seen.has(ni) || !isWalkable(level.tiles[ni])) continue;
      seen.add(ni);
      queue.push(ni);
    }
  }
  return seen.size === total;
}

/** 房间四周一圈内是否有门。 */
function hasDoor(level: Level, room: Room): boolean {
  for (let x = room.lx - 1; x <= room.hx + 1; x++) {
    for (let y = room.ly - 1; y <= room.hy + 1; y++) {
      if (level.doors.has(index(x, y))) return true;
    }
  }
  return false;
}

/**
 * 商店种类权重，沿用 NetHack 的 shtypes[] 相对比例：
 * 杂货店最常见，其余的武器、护甲、药水、卷轴、法杖、珠宝、
 * 食物、工具与书店各占一小部分。
 */
const SHOP_TYPE_WEIGHTS: [ShopType, number][] = [
  ['general', 42],
  ['armor', 14],
  ['scroll', 10],
  ['potion', 10],
  ['weapon', 5],
  ['food', 5],
  ['jewelry', 3],
  ['wand', 3],
  ['tool', 3],
  ['book', 3],
];

/**
 * 把一间有门、无楼梯的房间标记为商店。
 *
 * 这里只决定房间归属与商店种类，货物与店主由会话在放置阶段生成，
 * 避免地牢模块反向依赖物品与怪物模块。首层与底层不放商店：
 * 前者是出生层，后者要留给尤恩多护身符。
 */
function placeShop(level: Level, rng: Rng, chance = 0.25): void {
  if (level.depth < 2 || level.depth >= MAX_DEPTH) return;
  if (!rng.chance(chance)) return;
  const stairTiles = new Set(level.stairs.map((s) => index(s.x, s.y)));
  const candidates = level.rooms.filter((room) => {
    for (let x = room.lx; x <= room.hx; x++) {
      for (let y = room.ly; y <= room.hy; y++) {
        if (stairTiles.has(index(x, y))) return false;
      }
    }
    return hasDoor(level, room);
  });
  if (!candidates.length) return;
  const room = rng.pick(candidates) as Room;
  room.type = 'shop';
  room.shopType =
    rng.pickWeighted(
      SHOP_TYPE_WEIGHTS.map(([id, prob]) => ({ id, prob })),
      'prob',
    )?.id ?? 'general';
  log.debug('商店房间已标记', { depth: level.depth, room: room.index, type: room.shopType });
}

/** 圣所的振动方块：放在一间房间里，用独立随机流定位。 */
function placeVibratingSquare(level: Level, gameSeed: number): void {
  const rng = createRng(deriveSeed(gameSeed, 'vibrating-square', level.depth));
  const spots = freeTiles(
    level,
    (t, i) =>
      t === T.ROOM &&
      !level.traps.has(i) &&
      !level.stairs.some((s) => index(s.x, s.y) === i) &&
      !nearDoor(level, i) &&
      !inShopRoom(level, i % COLNO, Math.floor(i / COLNO)),
  );
  if (!spots.length) return;
  const i = rng.pick(spots) as number;
  level.traps.set(i, { type: 'VIBRATING_SQUARE', seen: false });
  log.debug('振动方块已放置', { depth: level.depth, at: coords(i) });
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 生成主地牢的一层。相同 `(gameSeed, depth)` 必然得到相同结果。 */
export function generateLevel({ gameSeed, depth }: { gameSeed: number; depth: number }): Level {
  return generateLevelCore({ gameSeed, depth });
}

/** 原版里总部是露天营地或洞穴的职业：任务总部用一整间大厅表示。 */
const OPEN_HOME_ROLES = new Set(['BARBARIAN', 'CAVE_DWELLER', 'RANGER', 'VALKYRIE', 'MONK']);

/** 生成一层分支地牢（矿坑等）；随机流与主地牢互相独立。 */
export function generateBranchLevel({
  gameSeed,
  branch,
  depth,
  levels,
  questRole = null,
  align = 'neutral',
}: {
  gameSeed: number;
  branch: string;
  depth: number;
  levels: number;
  /** 职业任务分支时传入职业 id，用于选择总部布局。 */
  questRole?: string | null;
  /** 玩家阵营：任务起始层的同阵营祭坛按它落归属。 */
  align?: Alignment;
}): Level {
  // 推箱用原版提取的固定布局，不跑随机房间生成。
  if (branchById(branch)?.sokoban) return generateSokobanLevel({ gameSeed, depth });
  // 任务起始层、搜索层与目标层有固定地图，不连通或缺失时退回通用布局。
  if (branch === 'quest' && questRole) {
    const make = (kind: 'home' | 'locate' | 'goal') =>
      generateQuestHomeLevel({ gameSeed, role: questRole, kind, depth, align });
    const fixed =
      depth === 1
        ? make('home')
        : depth === 3
          ? make('locate')
          : depth === levels
            ? make('goal')
            : null;
    if (fixed) return fixed;
  }
  return generateLevelCore({ gameSeed, depth, branch, levels, questRole });
}

/** 按原版显示名找物品原型：同时接受带类别前缀的名字。 */
function findProtoByName(name: string) {
  const exact = OBJECTS.find((o) => o.name === name);
  if (exact) return exact;
  const stripped = name.replace(/^(scroll|potion|wand|ring|amulet|spellbook) of /, '');
  return OBJECTS.find((o) => o.name === stripped);
}

/**
 * 生成一层推箱关卡。
 *
 * 地图字符、巨石、陷阱、楼梯与门都来自 `dat/soko*.lua`（见 sokoban.gen.ts），
 * 变体按派生随机流二选一；整层照明并预先可见（原版的 lit + premapped）。
 */
function generateSokobanLevel({ gameSeed, depth }: { gameSeed: number; depth: number }): Level {
  const data = SOKOBAN_LEVELS.find((l) => l.depth === depth);
  if (!data) throw new Error(`没有推箱第 ${depth} 层的数据`);
  const rng = createRng(deriveSeed(gameSeed, 'sokoban', depth));
  const variant = rng.pick(data.variants) as SokobanVariant;
  const width = Math.max(...variant.map.map((line) => line.length));
  const height = variant.map.length;
  const ox = Math.floor((COLNO - width) / 2);
  const oy = Math.floor((ROWNO - height) / 2);
  const level: Level = {
    depth,
    width: COLNO,
    height: ROWNO,
    tiles: new Uint8Array(COLNO * ROWNO),
    seen: new Uint8Array(COLNO * ROWNO),
    lit: new Uint8Array(COLNO * ROWNO),
    rooms: [],
    doors: new Map(),
    traps: new Map(),
    features: new Map(),
    stairs: [],
    up: null,
    down: null,
    start: null,
    objects: [],
    monsters: [],
    populated: false,
    visited: false,
    special: 'sokoban',
    sokobanVariant: variant.id,
    branch: 'sokoban',
  };
  const at = (x: number, y: number) => index(ox + x, oy + y);
  const floors: number[] = [];
  for (let y = 0; y < height; y++) {
    const line = variant.map[y];
    for (let x = 0; x < line.length; x++) {
      const i = at(x, y);
      const ch = line[x];
      if (ch === '-') level.tiles[i] = T.HWALL;
      else if (ch === '|') level.tiles[i] = T.VWALL;
      else if (ch === '+') {
        level.tiles[i] = T.DOOR;
        level.doors.set(i, { closed: true, locked: false, broken: false });
      } else if (ch === '.') {
        level.tiles[i] = T.ROOM;
        level.lit[i] = 1;
        level.seen[i] = 1;
        floors.push(i);
      }
    }
  }
  // 整张地图算一间房，供 FOV、寻路与设施判定使用。
  level.rooms.push({
    lx: ox,
    ly: oy,
    hx: ox + width - 1,
    hy: oy + height - 1,
    index: 0,
    type: 'room',
    lit: true,
  });
  for (const door of variant.doors) {
    const i = at(door.x, door.y);
    level.tiles[i] = T.DOOR;
    level.doors.set(i, { closed: true, locked: door.state === 'locked', broken: false });
  }
  for (const trap of variant.traps) {
    level.traps.set(at(trap.x, trap.y), { type: trap.id, seen: false });
  }
  for (const stair of variant.stairs) {
    const i = at(stair.x, stair.y);
    level.tiles[i] = T.STAIRS;
    const spot = { x: ox + stair.x, y: oy + stair.y };
    level.stairs.push({ ...spot, dir: stair.dir });
    if (stair.dir === 'up') level.up = spot;
    else level.down = spot;
  }
  if (variant.branch) {
    const i = at(variant.branch.x, variant.branch.y);
    level.tiles[i] = T.STAIRS;
    level.stairs.push({
      x: ox + variant.branch.x,
      y: oy + variant.branch.y,
      dir: 'branch',
      branch: 'sokoban',
    });
    level.start = { x: ox + variant.branch.x, y: oy + variant.branch.y };
  } else {
    level.start = level.up ?? level.down ?? coords(floors[0] ?? 0);
  }
  const put = (x: number, y: number, item: ItemInstance): void => {
    const pile = level.objects.find((p) => p.x === x && p.y === y);
    if (pile) pile.items.push(item);
    else level.objects.push({ x, y, items: [item] });
  };
  for (const [x, y] of variant.boulders) {
    level.objects.push({ x: ox + x, y: oy + y, items: [makeBoulder(rng)] });
  }
  const randomFloor = (): GroundPile | null => {
    if (!floors.length) return null;
    const i = rng.pick(floors) as number;
    return { x: i % COLNO, y: Math.floor(i / COLNO), items: [] };
  };
  for (const spawn of variant.objects) {
    let item: ItemInstance | null = null;
    if (spawn.id) {
      const proto = findProtoByName(spawn.id);
      if (proto) item = makeItem(proto, rng);
    } else if (spawn.cls) {
      const cls = SOKOBAN_CLASSES[spawn.cls];
      if (cls) item = randomItemOfClass(rng, cls as ObjectClass);
    }
    if (!item) continue;
    if (spawn.buc === 'cursed') item.buc = 'cursed';
    const spot =
      spawn.x >= 0 && spawn.y >= 0 ? { x: ox + spawn.x, y: oy + spawn.y } : randomFloor();
    if (spot) put(spot.x, spot.y, item);
  }
  // 顶层奖励：75% 次元袋，25% 反射护身符（原版 percent(75)）。
  if (variant.prizes?.length && variant.prizeSpots?.length) {
    const name = rng.chance(0.75) ? variant.prizes[0] : (variant.prizes[1] ?? variant.prizes[0]);
    const proto = findProtoByName(name);
    const spot = rng.pick(variant.prizeSpots) as [number, number];
    if (proto) {
      const prize = makeItem(proto, rng);
      prize.buc = 'uncursed';
      put(ox + spot[0], oy + spot[1], prize);
    }
  }
  log.info(`推箱第 ${depth} 层生成完成：${variant.id}`, {
    boulders: variant.boulders.length,
    traps: variant.traps.length,
  });
  return level;
}

/** 任务地图字符到引擎瓦片的映射，字符语义来自 `char2typ`。 */
function questHomeTile(ch: string): number {
  switch (QUEST_MAP_CHARS[ch]) {
    case 'stone':
      return T.STONE;
    case 'corr':
      return T.CORR;
    case 'scorr':
      return T.SCORR;
    case 'hwall':
      return T.HWALL;
    case 'vwall':
      return T.VWALL;
    case 'crosswall':
      // 原版的 B 是“隐形边界”：remove_boundary_syms() 会把它换成 ROOM。
      return T.ROOM;
    case 'door':
      return T.DOOR;
    case 'sdoor':
      // 密门：未发现前按墙渲染与阻挡。
      return T.SDOOR;
    case 'air':
      return T.AIR;
    case 'cloud':
      return T.CLOUD;
    case 'fountain':
      return T.FOUNTAIN;
    case 'throne':
      return T.THRONE;
    case 'sink':
      return T.SINK;
    case 'moat':
      return T.MOAT;
    case 'pool':
      return T.POOL;
    case 'lava':
    case 'lavawall':
      return T.LAVA;
    case 'ice':
      return T.ICE;
    case 'water':
      return T.WATER;
    case 'tree':
      return T.TREE;
    case 'ironbars':
      return T.IRONBARS;
    default:
      return T.ROOM;
  }
}

/** 祭坛归属：原版的短名 law/neutral/chaos 与 coaligned/noalign 都要兼容。 */
function questAltarAlign(raw: string | undefined, align: Alignment): Alignment {
  if (raw === 'coaligned') return align;
  if (raw === 'law') return 'lawful';
  if (raw === 'chaos') return 'chaotic';
  return 'neutral';
}

/** 离指定地图坐标最近的、可站立的瓦片；找不到返回 null。 */
function nearestWalkable(
  level: Level,
  x: number,
  y: number,
  width: number,
  height: number,
  at: (x: number, y: number) => number,
): { x: number; y: number } | null {
  for (let r = 0; r < 30; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (isWalkable(level.tiles[at(nx, ny)])) return { x: nx, y: ny };
      }
    }
  }
  return null;
}

/** 离起点最远的一处可站地面，供固定地图缺少下行楼梯时兜底。 */
function pickFarWalkable(
  level: Level,
  rng: Rng,
  from: { x: number; y: number },
): { x: number; y: number } | null {
  const spots: { x: number; y: number }[] = [];
  let best = -1;
  for (let i = 0; i < level.tiles.length; i++) {
    if (!isWalkable(level.tiles[i])) continue;
    const at = coords(i);
    const d = Math.max(Math.abs(at.x - from.x), Math.abs(at.y - from.y));
    if (d > best) {
      best = d;
      spots.length = 0;
    }
    if (d === best) spots.push(at);
  }
  return spots.length ? (rng.pick(spots) as { x: number; y: number }) : null;
}

/** 从落脚点能走到的全部格子；固定地图不连通时调用方会退回通用布局。 */
function reachableTiles(level: Level, from: { x: number; y: number }): number[] {
  const start = index(from.x, from.y);
  const seen = new Uint8Array(level.tiles.length);
  const queue: number[] = [start];
  seen[start] = 1;
  const out: number[] = [];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    out.push(cur);
    const cx = cur % COLNO;
    const cy = (cur / COLNO) | 0;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= COLNO || ny >= ROWNO) continue;
      const ni = index(nx, ny);
      if (seen[ni] || !isWalkable(level.tiles[ni])) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }
  return out;
}

/** 从落脚点能否走下行楼梯；固定地图不连通时调用方会退回通用布局。 */
function questHomeConnected(
  level: Level,
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  const start = index(from.x, from.y);
  const goal = index(to.x, to.y);
  const seen = new Uint8Array(level.tiles.length);
  const queue: number[] = [start];
  seen[start] = 1;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (cur === goal) return true;
    const cx = cur % COLNO;
    const cy = (cur / COLNO) | 0;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= COLNO || ny >= ROWNO) continue;
      const ni = index(nx, ny);
      if (seen[ni] || !isWalkable(level.tiles[ni])) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }
  return false;
}

/**
 * 任务起始层的固定地图（12 个职业，数据见 quest.gen.ts）。
 *
 * 地图里的门、楼梯、设施与亮暗按原版摆放；领袖与护卫仍由会话的
 * `placeQuestContent` 布置。地图不连通或缺少关键楼梯时返回 null，
 * 调用方退回通用布局，保证不会把玩家困住。
 */
function generateQuestHomeLevel({
  gameSeed,
  role,
  kind,
  depth,
  align,
}: {
  gameSeed: number;
  role: string;
  /** home 是任务起始层，locate 是原版的搜索层，goal 是目标层。 */
  kind: 'home' | 'locate' | 'goal';
  /** 分支内层号：起始 1、搜索 3、目标 5。 */
  depth: number;
  align: Alignment;
}): Level | null {
  const source =
    kind === 'home'
      ? QUEST_HOME_LEVELS
      : kind === 'locate'
        ? QUEST_LOCATE_LEVELS
        : QUEST_GOAL_LEVELS;
  const data = source.find((level) => level.role === role);
  if (!data) return null;
  const rng = createRng(deriveSeed(gameSeed, 'quest-fixed', kind, role));
  const width = Math.max(...data.map.map((line) => line.length));
  const height = data.map.length;
  const ox = Math.floor((COLNO - width) / 2);
  const oy = Math.floor((ROWNO - height) / 2);
  const at = (x: number, y: number): number => index(ox + x, oy + y);
  const level: Level = {
    depth,
    width: COLNO,
    height: ROWNO,
    tiles: new Uint8Array(COLNO * ROWNO),
    seen: new Uint8Array(COLNO * ROWNO),
    lit: new Uint8Array(COLNO * ROWNO),
    rooms: [],
    doors: new Map(),
    traps: new Map(),
    features: new Map(),
    stairs: [],
    up: null,
    down: null,
    start: null,
    objects: [],
    monsters: [],
    populated: false,
    visited: false,
    special: kind === 'home' ? 'quest_home' : kind === 'locate' ? 'quest_locate' : 'quest_goal',
    branch: 'quest',
  };
  for (let y = 0; y < height; y++) {
    const line = data.map[y];
    for (let x = 0; x < line.length; x++) {
      level.tiles[at(x, y)] = questHomeTile(line[x]);
    }
  }
  // 亮暗区域按原版顺序覆盖。
  for (const region of data.regions) {
    for (let y = region.y1; y <= region.y2; y++) {
      for (let x = region.x1; x <= region.x2; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        level.lit[at(x, y)] = region.lit ? 1 : 0;
      }
    }
  }
  for (const door of data.doors) {
    const i = at(door.x, door.y);
    level.tiles[i] = T.DOOR;
    level.doors.set(i, { closed: true, locked: door.state === 'locked', broken: false });
  }
  // 地图里直接画出的 `+` 与 `S` 也要有门状态；
  // `des.door` 未列出的按普通关门处理，`S` 是未发现的密门。
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < data.map[y].length; x++) {
      const i = at(x, y);
      if (level.tiles[i] === T.DOOR && !level.doors.has(i)) {
        level.doors.set(i, { closed: true, locked: false, broken: false });
      } else if (level.tiles[i] === T.SDOOR && !level.doors.has(i)) {
        level.doors.set(i, { closed: true, locked: false, broken: false, hidden: true });
      }
    }
  }
  // 地图字符自带的设施。
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < data.map[y].length; x++) {
      const i = at(x, y);
      if (level.tiles[i] === T.FOUNTAIN) level.features.set(i, { type: 'FOUNTAIN' });
      else if (level.tiles[i] === T.THRONE) level.features.set(i, { type: 'THRONE' });
      else if (level.tiles[i] === T.SINK) level.features.set(i, { type: 'SINK' });
    }
  }
  // 数据里单独写的设施（祭坛、喷泉等）。
  for (const feature of data.features) {
    const i = at(feature.x, feature.y);
    const type = feature.type.toUpperCase();
    if (type === 'FOUNTAIN') level.tiles[i] = T.FOUNTAIN;
    if (type === 'ALTAR') {
      level.tiles[i] = T.ALTAR;
      level.features.set(i, { type, align: questAltarAlign(feature.align, align) });
      continue;
    }
    level.features.set(i, { type });
  }
  // 上行楼梯：起始层是分支落脚区（levregion 中心），搜索层是原版的 up 楼梯；
  // 数据缺失（如浪人的搜索层）时从地图中间挑一处最远的地面。
  const upSource = kind === 'home' ? data.branch : data.stairs.find((stair) => stair.dir === 'up');
  const upSpot = upSource
    ? nearestWalkable(level, upSource.x, upSource.y, width, height, at)
    : pickFarWalkable(level, rng, {
        x: ox + Math.floor(width / 2),
        y: oy + Math.floor(height / 2),
      });
  if (upSpot) {
    const i = at(upSpot.x, upSpot.y);
    level.tiles[i] = T.STAIRS;
    const spot = { x: ox + upSpot.x, y: oy + upSpot.y };
    level.stairs.push(
      kind === 'home'
        ? { x: spot.x, y: spot.y, dir: 'branch', branch: 'quest' }
        : { x: spot.x, y: spot.y, dir: 'up' },
    );
    level.up = spot;
    level.start = spot;
  }
  // 下行楼梯：目标层是分支底部，没有下行楼梯；其余层优先原版坐标，
  // 不可站或缺失时挑最远的地面兜底。
  if (kind !== 'goal') {
    const downSource = data.stairs.find((stair) => stair.dir === 'down');
    const downSpot = downSource
      ? nearestWalkable(level, downSource.x, downSource.y, width, height, at)
      : null;
    const chosen = downSpot ?? (level.up ? pickFarWalkable(level, rng, level.up) : null);
    if (chosen) {
      const i = at(chosen.x, chosen.y);
      level.tiles[i] = T.STAIRS;
      const spot = { x: ox + chosen.x, y: oy + chosen.y };
      level.stairs.push({ x: spot.x, y: spot.y, dir: 'down' });
      level.down = spot;
    }
  } else if (data.goal) {
    // 目标层的仇敌与神器落在原版坐标上。
    const anchor = nearestWalkable(level, data.goal.x, data.goal.y, width, height, at);
    if (anchor) level.questGoalAnchor = { x: ox + anchor.x, y: oy + anchor.y };
  }
  // 陷阱：写了坐标的照放，随机陷阱按个数落在空地上。
  for (const trap of data.traps) {
    const i = at(trap.x, trap.y);
    if (isWalkable(level.tiles[i])) level.traps.set(i, { type: trap.type, seen: false });
  }
  if (data.trapCount > 0) {
    const floors: number[] = [];
    for (let i = 0; i < level.tiles.length; i++) {
      if (isWalkable(level.tiles[i]) && !level.traps.has(i) && !level.features.has(i)) {
        floors.push(i);
      }
    }
    const kinds = [
      'PIT',
      'SPIKED_PIT',
      'DART_TRAP',
      'ARROW_TRAP',
      'FIRE_TRAP',
      'SLEEPING_GAS_TRAP',
    ];
    for (let n = 0; n < data.trapCount && floors.length; n++) {
      const pick = rng.pick(floors) as number;
      floors.splice(floors.indexOf(pick), 1);
      level.traps.set(pick, { type: rng.pick(kinds) as string, seen: false });
    }
  }
  // 单一房间覆盖全图：给 inRoom 之类的判断一个范围即可。
  level.rooms.push({
    lx: 1,
    ly: 1,
    hx: COLNO - 2,
    hy: ROWNO - 2,
    index: 0,
    type: 'room',
    lit: true,
  });
  if (!level.up) return null;
  if (kind === 'goal') {
    if (!level.questGoalAnchor) return null;
    // 固定地图里上行楼梯可能落在与仇敌不同的连通块：把楼梯挪到
    // 仇敌一侧最远的地面，保留原版地图布局又不把玩家困住。
    if (!questHomeConnected(level, level.up, level.questGoalAnchor)) {
      const reachable = reachableTiles(level, level.questGoalAnchor);
      let best: { x: number; y: number } | null = null;
      let bestD = -1;
      for (const tile of reachable) {
        if (level.traps.has(tile) || level.features.has(tile)) continue;
        const at2 = coords(tile);
        const d = Math.max(
          Math.abs(at2.x - level.questGoalAnchor.x),
          Math.abs(at2.y - level.questGoalAnchor.y),
        );
        if (d > bestD) {
          bestD = d;
          best = at2;
        }
      }
      if (!best) return null;
      // 旧楼梯瓦片还原成地图上的原始地形。
      const oldLx = level.up.x - ox;
      const oldLy = level.up.y - oy;
      const oldCh = data.map[oldLy]?.[oldLx];
      level.tiles[index(level.up.x, level.up.y)] = oldCh ? questHomeTile(oldCh) : T.ROOM;
      const oldUp = level.stairs.findIndex((stair) => stair.dir === 'up');
      if (oldUp >= 0) level.stairs.splice(oldUp, 1);
      level.tiles[index(best.x, best.y)] = T.STAIRS;
      level.stairs.push({ x: best.x, y: best.y, dir: 'up' });
      level.up = best;
      level.start = best;
    }
    if (!questHomeConnected(level, level.up, level.questGoalAnchor)) return null;
  } else {
    if (!level.down) return null;
    if (!questHomeConnected(level, level.up, level.down)) return null;
  }
  log.debug('任务固定地图已生成', { role, kind, doors: level.doors.size });
  return level;
}

/** 任务楼层的特殊标识：首层是总部，中间是搜索层，底层是目标层。 */
function questLevelSpecial(depth: number, levels: number): string | null {
  if (depth === 1) return 'quest_home';
  if (depth >= levels) return 'quest_goal';
  if (depth === Math.ceil(levels / 2)) return 'quest_locate';
  return null;
}

function generateLevelCore({
  gameSeed,
  depth,
  branch = null,
  levels = 0,
  questRole = null,
}: {
  gameSeed: number;
  depth: number;
  branch?: string | null;
  levels?: number;
  questRole?: string | null;
}): Level {
  const seed = branch
    ? deriveSeed(gameSeed, 'branch', branch, depth)
    : deriveSeed(gameSeed, 'level', depth);
  const rng = createRng(seed);
  const label = branch ? `${branch} 第 ${depth} 层` : `第 ${depth} 层`;
  const done = log.time(`生成 ${label}`);
  log.debug('开始生成关卡', { depth, branch, gameSeed, levelSeed: seed });
  const level: Level = {
    depth,
    width: COLNO,
    height: ROWNO,
    tiles: new Uint8Array(COLNO * ROWNO), // 初始全是石头
    seen: new Uint8Array(COLNO * ROWNO),
    lit: new Uint8Array(COLNO * ROWNO),
    rooms: [],
    doors: new Map(),
    traps: new Map(),
    features: new Map(),
    stairs: [],
    up: null,
    down: null,
    start: null,
    objects: [],
    monsters: [],
    populated: false,
    visited: false,
    special: null,
    branch,
  };

  /** 特殊楼层只存在于主地牢；任务分支按层号标记总部、搜索层与目标层。 */
  const special = branch ? branchSpecialFor(branch, depth) : specialLevelFor(depth);
  const branchDef = branch ? branchById(branch) : null;
  level.special = special?.id ?? (branchDef?.quest ? questLevelSpecial(depth, levels) : null);
  // 任务目标层用一整间大厅，让仇敌与神器更醒目。
  const questGoal = !!branchDef?.quest && depth >= levels;
  // 部分职业的任务总部是露天营地或洞穴，用大房间表达。
  const questHome =
    !!branchDef?.quest && depth === 1 && !!questRole && OPEN_HOME_ROLES.has(questRole);
  if (special?.layout === 'bigRoom' || questGoal || questHome) {
    carveBigRoom(level);
    if (questGoal) carveLairChamber(level);
  } else {
    level.rooms = placeRooms(level, rng);
    if (level.rooms.length < 3) {
      // 极端种子可能放不下房间，用加盐的种子重试。
      return generateLevelCore({ gameSeed: (gameSeed ^ 0x5bf03635) >>> 0, depth, branch, levels });
    }
    carveRooms(level, level.rooms);
    makeCorridors(level, rng);
    placeDoors(level, rng);
  }
  computeWalls(level);
  // 门上的机关：深层才有，用独立随机流，不扰动本层其它生成内容。
  // 对应原版 mklev.c 的 D_TRAPPED（难度 5 起，关闭的门 1/25）。
  if (depth >= 5) {
    const doorTrapRng = createRng(
      branch
        ? deriveSeed(gameSeed, 'door-traps', branch, depth)
        : deriveSeed(gameSeed, 'door-traps', depth),
    );
    for (const [, door] of level.doors) {
      if (!door.closed) continue;
      if (doorTrapRng.rn2(25) === 0) door.trapped = true;
    }
  }
  // 巢穴的室内不落楼梯，玩家要从门进去。
  const inLair = (i: number): boolean => {
    const x = i % COLNO;
    const y = (i / COLNO) | 0;
    return (
      questGoal &&
      x >= QUEST_LAIR.lx &&
      x <= QUEST_LAIR.hx &&
      y >= QUEST_LAIR.ly &&
      y <= QUEST_LAIR.hy
    );
  };
  placeStairs(level, rng, {
    isBranch: !!branch,
    isBottom: !!branch && depth >= levels,
    avoidTiles: questGoal ? inLair : undefined,
  });
  if (!branch) {
    const entrance = branchByEntrance(depth);
    // 隐藏分支（异界）的入口由仪式开启，不在生成时铺楼梯。
    if (entrance && !entrance.hidden) {
      // 分支楼梯用独立随机流，不扰动本层的陷阱与设施分布。
      placeBranchStairs(
        level,
        createRng(deriveSeed(gameSeed, 'branch-stairs', depth)),
        entrance.id,
      );
    }
  }
  // 商店判定用独立随机流，避免扰动无关楼层的陷阱与设施分布。
  const shopSeed = branch
    ? deriveSeed(gameSeed, 'shop-room', branch, depth)
    : deriveSeed(gameSeed, 'shop-room', depth);
  // 矿镇：市集层必有一间商店。
  placeShop(level, createRng(shopSeed), branchDef?.town ? 1 : 0.25);
  placeTraps(level, rng);
  if (special?.altars?.length) {
    placeFeatures(level, rng, gameSeed, { fixedAltars: true });
    placeSpecialAltars(level, special.altars);
  } else {
    placeFeatures(level, rng, gameSeed);
  }
  const graves = special?.graves ?? branchDef?.graves;
  const fountains = special?.fountains ?? branchDef?.fountains;
  if (graves) {
    placeExtraFeatures(level, rng, graves, T.GRAVE, 'GRAVE');
  }
  if (fountains) {
    placeExtraFeatures(level, rng, fountains, T.FOUNTAIN, 'FOUNTAIN');
  }
  if (special?.scatter) {
    const scattered = scatterTerrain(level, rng, special.scatter.tile, special.scatter.chance);
    log.debug('元素位面地形已散布', {
      depth: level.depth,
      tile: special.scatter.tile,
      n: scattered,
    });
  }
  // 圣所放一块振动方块：原版用它打开通往异界的传送门。
  if (level.special === 'sanctum') {
    placeVibratingSquare(level, gameSeed);
  }
  log.info(
    `${label} 生成完成：房间 ${level.rooms.length}、门 ${level.doors.size}、` +
      `陷阱 ${level.traps.size}、设施 ${level.features.size}`,
    { up: level.up, down: level.down, start: level.start },
  );
  done();
  return level;
}

// ---------------------------------------------------------------------------
// 调试辅助
// ---------------------------------------------------------------------------

const GLYPH: Record<number, string> = {
  [T.STONE]: ' ',
  [T.VWALL]: '|',
  [T.HWALL]: '-',
  [T.DOOR]: '+',
  [T.CORR]: '#',
  [T.ROOM]: '.',
  [T.STAIRS]: '>',
  [T.FOUNTAIN]: '{',
  [T.SINK]: '#',
  [T.ALTAR]: '_',
  [T.GRAVE]: '|',
  [T.THRONE]: '\\',
};

/** 把关卡渲染成 ASCII，用于调试与测试。 */
export function levelToAscii(level: Level, { showTraps = true } = {}): string {
  const rows: string[] = [];
  for (let y = 0; y < ROWNO; y++) {
    let line = '';
    for (let x = 0; x < COLNO; x++) {
      const i = index(x, y);
      let ch = GLYPH[level.tiles[i]] ?? '?';
      if (level.up && level.up.x === x && level.up.y === y) ch = '<';
      if (level.down && level.down.x === x && level.down.y === y) ch = '>';
      if (showTraps && level.traps.has(i)) ch = '^';
      line += ch;
    }
    rows.push(line.replace(/\s+$/, ''));
  }
  return rows.join('\n');
}

/** 关卡摘要，供调试输出与工具使用。 */
export function describeLevel(level: Level): {
  depth: number;
  rooms: number;
  doors: number;
  traps: number;
  special: string | null;
  up: { x: number; y: number } | null;
  down: { x: number; y: number } | null;
} {
  return {
    depth: level.depth,
    rooms: level.rooms.length,
    doors: level.doors.size,
    traps: level.traps.size,
    special: level.special ?? null,
    up: level.up,
    down: level.down,
  };
}
