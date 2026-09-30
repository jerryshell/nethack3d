/**
 * 地面寻路，用于点击移动。
 *
 * 只走玩家已经见过的格子：未经探索的区域不参与寻路，
 * 避免自动走进未知的危险，这与原版的旅行命令一致。
 * 对角线移动要求两侧正交格也可通行，避免从墙角斜穿过去。
 */

import type { Level } from '../types';
import { COLNO, ROWNO, T, isWalkable } from '../core/constants';
import { index } from './dungeon';

export interface Point {
  x: number;
  y: number;
}

export interface Step {
  dx: number;
  dy: number;
}

/** 固定的方向顺序：正交在前，保证同样输入得到同样路径。 */
const DIRS: Step[] = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -1 },
];

/** 单次搜索访问的格子上限，防止在大地图上退化为全图扫描。 */
const MAX_VISITS = 4000;

const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

/** 格子是否可以走过：需要已探索且地形可通行。 */
function passable(level: Level, x: number, y: number, levitating: boolean): boolean {
  if (x < 0 || y < 0 || x >= COLNO || y >= ROWNO) return false;
  const i = index(x, y);
  if (level.seen[i] !== 1) return false;
  if (isWalkable(level.tiles[i])) return true;
  // 浮空时可以从虚空上方走过，与元素位面的移动规则一致。
  return levitating && level.tiles[i] === T.AIR;
}

/** 对角线移动时，两侧正交格都必须可通行。 */
function diagonalAllowed(level: Level, from: Point, step: Step, levitating: boolean): boolean {
  if (step.dx === 0 || step.dy === 0) return true;
  return (
    passable(level, from.x + step.dx, from.y, levitating) &&
    passable(level, from.x, from.y + step.dy, levitating)
  );
}

/** 该格是否有挡路的怪物：宠物可以交换位置，不算阻挡。 */
function hasMonster(level: Level, x: number, y: number): boolean {
  return level.monsters.some((m) => m.x === x && m.y === y && m.mhp > 0 && !m.tame);
}

/**
 * 求从 `from` 到 `to` 的路径。
 *
 * 返回相邻移动序列，不含起点；不可达时返回 null。
 * 目标格允许站着怪物：此时路线只走到它旁边，由调用方决定攻击。
 */
export function findPath(
  level: Level,
  from: Point,
  to: Point,
  { levitating = false }: { levitating?: boolean } = {},
): Step[] | null {
  if (same(from, to)) return [];
  if (!passable(level, to.x, to.y, levitating)) return null;

  const start = index(from.x, from.y);
  const goal = index(to.x, to.y);
  const cameFrom = new Int32Array(COLNO * ROWNO).fill(-1);
  const queue: number[] = [start];
  cameFrom[start] = start;
  let visited = 0;
  let found = false;

  while (queue.length && visited < MAX_VISITS) {
    const current = queue.shift() as number;
    visited++;
    if (current === goal) {
      found = true;
      break;
    }
    const cx = current % COLNO;
    const cy = (current / COLNO) | 0;
    for (const step of DIRS) {
      const nx = cx + step.dx;
      const ny = cy + step.dy;
      if (nx < 0 || ny < 0 || nx >= COLNO || ny >= ROWNO) continue;
      const next = index(nx, ny);
      if (cameFrom[next] !== -1) continue;
      if (next !== goal && (!passable(level, nx, ny, levitating) || hasMonster(level, nx, ny)))
        continue;
      if (!diagonalAllowed(level, { x: cx, y: cy }, step, levitating)) continue;
      cameFrom[next] = current;
      queue.push(next);
    }
  }

  if (!found) return null;

  // 回溯并转成方向序列。
  const steps: Step[] = [];
  let node = goal;
  while (node !== start) {
    const prev = cameFrom[node];
    if (prev < 0) return null;
    const nx = node % COLNO;
    const ny = (node / COLNO) | 0;
    const px = prev % COLNO;
    const py = (prev / COLNO) | 0;
    steps.push({ dx: nx - px, dy: ny - py });
    node = prev;
  }
  steps.reverse();
  return steps;
}

/** 沿路径展开经过的格子，用于界面预览。 */
export function pathPoints(from: Point, steps: Step[]): Point[] {
  const points: Point[] = [];
  let { x, y } = from;
  for (const step of steps) {
    x += step.dx;
    y += step.dy;
    points.push({ x, y });
  }
  return points;
}
