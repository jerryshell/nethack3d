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

import { COLNO, ROWNO, T, isWall, isRoom, isCorr, randomTrapTypes } from '../core/constants';
import { createRng, deriveSeed } from '../core/rng';
import { createLogger, LOG_NS } from '../core/log';
import type { Level, Room, Rng } from '../types';

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

/** 该格是否与房间正交相邻。 */
function touchesRoom(level: Level, x: number, y: number): boolean {
  return (
    insideRoom(level, x - 1, y) ||
    insideRoom(level, x + 1, y) ||
    insideRoom(level, x, y - 1) ||
    insideRoom(level, x, y + 1)
  );
}

/** 门朝向判定里算作「可通行」的瓦片。 */
function doorPassage(t: number): boolean {
  return isRoom(t) || isCorr(t) || t === T.DOOR || t === T.STAIRS;
}

/**
 * 一扇门是否拦东西方向的通行，即门板是否竖着立在格子里。
 *
 * 先看通道：对侧都能走的轴就是玩家实际穿过的轴，门板必须垂直于它。
 * 走廊贴着房间外墙经过时，房间虽在东西侧，通道却可能拐向南北；
 * 只按房间判断会把门板横着架在走廊里。实测约 5% 的可判定门踩中此坑。
 * 通道不明确（拐角、十字口）时退回房间所在轴：房间在东或西就拦东西向。
 * 房间所在侧用矩形判断而不是瓦片类型，因为房间地面可能被楼梯或设施覆盖。
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
/** 紧贴房间外墙的代价：只在无路可走时才从房间侧面擦过。 */
const HUG_COST = 6;

/**
 * 挖走廊用的最短路。
 *
 * 状态是「格子 + 进入方向」，因此可以给转弯加价：路线会尽量走直线，
 * 拐弯集中在少数几处，这与原版走廊的观感一致。
 * 房间内部不可穿越（终点除外），紧贴房间外墙的格子代价很高，
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
      let step = 1;
      if (isCorr(t) || t === T.DOOR) step = 0.5;
      else if (touchesRoom(level, nx, ny)) step = HUG_COST;
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

/**
 * 房间朝目标一侧的墙外开口格。
 *
 * 位置尽量对准目标，走廊因此接近直线；加上一点抖动避免每层都一样。
 */
function exitPoint(
  room: { lx: number; ly: number; hx: number; hy: number },
  toward: { x: number; y: number },
  rng: Rng,
): { x: number; y: number } {
  const dx = toward.x < room.lx ? -1 : toward.x > room.hx ? 1 : 0;
  const dy = toward.y < room.ly ? -1 : toward.y > room.hy ? 1 : 0;
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const jitter = rng.rn2(3) - 1;
  const horizontalFirst = dx !== 0 && (dy === 0 || rng.rn2(2) === 0);
  if (horizontalFirst) {
    return {
      x: dx < 0 ? room.lx - 1 : room.hx + 1,
      y: clamp(Math.round(toward.y) + jitter, room.ly, room.hy),
    };
  }
  if (dy !== 0) {
    return {
      x: clamp(Math.round(toward.x) + jitter, room.lx, room.hx),
      y: dy < 0 ? room.ly - 1 : room.hy + 1,
    };
  }
  return { x: room.hx + 1, y: clamp(Math.round(toward.y), room.ly, room.hy) };
}

/** 紧贴房间的走廊格转为门。 */
function placeDoorIfNeeded(level: Level, x: number, y: number, rng: Rng): void {
  const i = index(x, y);
  if (level.tiles[i] !== T.CORR || level.doors.has(i)) return;
  if (!touchesRoom(level, x, y)) return;
  level.doors.set(i, { closed: rng.rn2(3) !== 0, locked: rng.rn2(6) === 0, broken: false });
  level.tiles[i] = T.DOOR;
}

/** 挖通两个房间：从双方正对的一面开口，沿最短路开挖，两端放门。 */
function connectRooms(level: Level, a: Room, b: Room, rng: Rng): boolean {
  const ca = roomCenter(a);
  const cb = roomCenter(b);
  const pa = exitPoint(a, cb, rng);
  const pb = exitPoint(b, ca, rng);
  const path = findCorridorPath(level, index(pa.x, pa.y), index(pb.x, pb.y));
  if (!path) return false;

  // 起点与终点（紧贴房间的开口）也要挖开。
  const tiles = [index(pa.x, pa.y), ...path];
  if (tiles[tiles.length - 1] !== index(pb.x, pb.y)) tiles.push(index(pb.x, pb.y));
  for (const i of tiles) {
    const tile = level.tiles[i];
    if (tile === T.STONE || isWall(tile)) level.tiles[i] = T.CORR;
  }
  for (const t of [pa, pb]) placeDoorIfNeeded(level, t.x, t.y, rng);
  return true;
}

/** 连接所有房间：先按横向顺序连成链，再补若干随机连接。 */
function makeCorridors(level: Level, rng: Rng): void {
  const sorted = [...level.rooms].sort((a, b) => a.lx - b.lx || a.ly - b.ly);
  for (let i = 0; i < sorted.length - 1; i++) connectRooms(level, sorted[i], sorted[i + 1], rng);
  // 额外连接避免地图退化成树形，原版同样会这样做。
  const extra = rng.rn2(sorted.length) + 4;
  for (let i = 0; i < extra && sorted.length > 2; i++) {
    const a = rng.rn2(sorted.length);
    const b = rng.rn2(sorted.length);
    if (a !== b) connectRooms(level, sorted[a], sorted[b], rng);
  }
}

/** 门的规范化：去掉多余的门，并保证每个房间都有入口。 */
function placeDoors(level: Level, rng: Rng): void {
  const makeDoor = (i: number): void => {
    level.tiles[i] = T.DOOR;
    level.doors.set(i, { closed: rng.rn2(3) !== 0, locked: false, broken: false });
  };
  const openDoor = (i: number): void => {
    level.tiles[i] = T.CORR;
    level.doors.delete(i);
  };
  const adjacentToRoom = (x: number, y: number): boolean => touchesRoom(level, x, y);
  const adjacentToDoor = (i: number): boolean => {
    const x = i % COLNO;
    const y = (i / COLNO) | 0;
    return (
      level.doors.has(index(x - 1, y)) ||
      level.doors.has(index(x + 1, y)) ||
      level.doors.has(index(x, y - 1)) ||
      level.doors.has(index(x, y + 1))
    );
  };

  // 一、清掉连成排或不在房间入口的门。挖走廊时可能在同一处留下多个门，
  //     相邻的门在画面上会变成一串门板。
  // 迭代中只删除当前项，Map 迭代器允许这种写法。
  for (const i of level.doors.keys()) {
    const x = i % COLNO;
    const y = (i / COLNO) | 0;
    if (adjacentToDoor(i) || !adjacentToRoom(x, y)) {
      openDoor(i);
      continue;
    }
    // 门必须正好夹在房间与走廊之间：一侧是房间，另一侧可通行。
    const sides = [
      level.tiles[index(x - 1, y)],
      level.tiles[index(x + 1, y)],
      level.tiles[index(x, y - 1)],
      level.tiles[index(x, y + 1)],
    ];
    const hasRoom = sides.some(isRoom);
    const hasPassage = sides.some((t) => isCorr(t) || t === T.STAIRS);
    if (!hasRoom || !hasPassage) openDoor(i);
  }

  // 二、给还没有门的房间补一个入口。
  for (const room of level.rooms) {
    let hasDoor = false;
    for (let x = room.lx - 1; x <= room.hx + 1 && !hasDoor; x++) {
      for (let y = room.ly - 1; y <= room.hy + 1; y++) {
        if (level.doors.has(index(x, y))) {
          hasDoor = true;
          break;
        }
      }
    }
    if (hasDoor) continue;

    // 找房间外墙边上的走廊格，优先不与已有门相邻的位置。
    const candidates: number[] = [];
    const consider = (x: number, y: number): void => {
      if (!inBounds(x, y)) return;
      const i = index(x, y);
      if (level.tiles[i] !== T.CORR) return;
      if (!adjacentToRoom(x, y)) return;
      candidates.push(i);
    };
    for (let x = room.lx - 1; x <= room.hx + 1; x++) {
      consider(x, room.ly - 1);
      consider(x, room.hy + 1);
    }
    for (let y = room.ly - 1; y <= room.hy + 1; y++) {
      consider(room.lx - 1, y);
      consider(room.hx + 1, y);
    }
    const preferred = candidates.find((i) => !adjacentToDoor(i));
    const pick = preferred ?? candidates[0];
    if (pick !== undefined) makeDoor(pick);
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

/** 放置上下楼梯，并决定玩家在本层的初始位置。 */
function placeStairs(level: Level, rng: Rng): void {
  const rooms = level.rooms;
  if (!rooms.length) return;
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
      if (level.tiles[i] === T.ROOM) {
        level.tiles[i] = T.STAIRS;
        level.stairs.push({ x, y, dir: glyph });
        return { x, y };
      }
    }
    return null;
  };

  if (level.depth > 1) {
    // 从上层下来时，玩家出现在起始房间的上行楼梯处。
    const up = put(startRoom, 'up');
    if (up) level.up = up;
  }
  const down = put(far === startRoom ? rooms[rooms.length - 1] : far, 'down');
  if (down) level.down = down;

  // 第 1 层的起始位置在起始房间内；深层则从上行楼梯进入。
  if (level.depth === 1) {
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
    (t, i) =>
      (t === T.ROOM || t === T.CORR) &&
      !level.stairs.some((s) => index(s.x, s.y) === i) &&
      !level.traps.has(i),
  );
  rng.shuffle(candidates);
  for (let n = 0; n < count && candidates.length; n++) {
    const i = candidates.pop() as number;
    level.traps.set(i, { type: rng.pick(pool) as string, seen: false });
  }
}

/** 布置喷泉、水槽、祭坛、坟墓与王座。 */
function placeFeatures(level: Level, rng: Rng): void {
  const add = (tileType: number, chance: number): void => {
    if (!rng.chance(chance)) return;
    const spots = freeTiles(
      level,
      (t, i) =>
        t === T.ROOM && !level.traps.has(i) && !level.stairs.some((s) => index(s.x, s.y) === i),
    );
    if (!spots.length) return;
    const i = rng.pick(spots) as number;
    level.tiles[i] = tileType;
    level.features.set(i, {
      type: Object.entries(T).find(([, v]) => v === tileType)?.[0] ?? 'feature',
    });
  };
  add(T.FOUNTAIN, 0.22);
  add(T.SINK, 0.08);
  add(T.ALTAR, 0.12);
  if (level.depth >= 3) add(T.GRAVE, 0.08);
  if (level.depth >= 6) add(T.THRONE, 0.07);
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 生成一层地牢。相同 `(gameSeed, depth)` 必然得到相同结果。 */
export function generateLevel({ gameSeed, depth }: { gameSeed: number; depth: number }): Level {
  const seed = deriveSeed(gameSeed, 'level', depth);
  const rng = createRng(seed);
  const done = log.time(`生成第 ${depth} 层`);
  log.debug('开始生成关卡', { depth, gameSeed, levelSeed: seed });
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
  };

  level.rooms = placeRooms(level, rng);
  if (level.rooms.length < 3) {
    // 极端种子可能放不下房间，用加盐的种子重试。
    return generateLevel({ gameSeed: (gameSeed ^ 0x5bf03635) >>> 0, depth });
  }
  carveRooms(level, level.rooms);
  makeCorridors(level, rng);
  placeDoors(level, rng);
  computeWalls(level);
  placeStairs(level, rng);
  placeTraps(level, rng);
  placeFeatures(level, rng);
  log.info(
    `第 ${depth} 层生成完成：房间 ${level.rooms.length}、门 ${level.doors.size}、` +
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
  up: { x: number; y: number } | null;
  down: { x: number; y: number } | null;
} {
  return {
    depth: level.depth,
    rooms: level.rooms.length,
    doors: level.doors.size,
    traps: level.traps.size,
    up: level.up,
    down: level.down,
  };
}
