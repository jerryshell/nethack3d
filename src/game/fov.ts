/**
 * 视野计算。
 *
 * 与 NetHack 的照明规则保持一致：
 *
 * - 玩家所在的照明房间整间可见（对应源码 src/vision.c）。
 * - 其他位置受半径限制，被墙体与关闭的门遮挡；
 *   使用八分区的递归阴影投射算法。
 * - `level.seen` 记录曾经看到过的瓦片，供 3D 地图保留记忆。
 */

import type { Level, Room } from '../types';
import { createLogger, LOG_NS } from '../core/log';
import { T, isFurniture, isCorr } from '../core/constants';
import { index, inBounds } from './dungeon';

const log = createLogger(LOG_NS.fov);

const DEFAULT_SIGHT_RADIUS = 12;

function blocksSight(level: Level, x: number, y: number): boolean {
  const i = index(x, y);
  const t = level.tiles[i];
  if (t === T.DOOR) {
    const door = level.doors.get(i);
    return door ? door.closed || door.locked : false;
  }
  if (t === T.SDOOR) return true;
  if (t === T.STONE || (t >= T.VWALL && t <= T.DBWALL) || t === T.TREE) return true;
  return !(isCorr(t) || t === T.ROOM || isFurniture(t) || t === T.ICE);
}

/** 包含坐标 (x, y) 的房间，不在房间内时返回 null。 */
function roomAt(level: Level, x: number, y: number): Room | null {
  for (const r of level.rooms) {
    if (x >= r.lx && x <= r.hx && y >= r.ly && y <= r.hy) return r;
  }
  return null;
}

/**
 * 计算以 (ox, oy) 为起点的可见范围，并合并进 level.seen。
 * 返回与 level.tiles 同下标的 Uint8Array 标记数组。
 */
export function computeFov(
  level: Level,
  ox: number,
  oy: number,
  radius: number = DEFAULT_SIGHT_RADIUS,
  { remember = true }: { remember?: boolean } = {},
): Uint8Array {
  const visible = new Uint8Array(level.width * level.height);
  const mark = (x: number, y: number): void => {
    if (!inBounds(x, y)) return;
    const i = index(x, y);
    visible[i] = 1;
    if (remember) level.seen[i] = 1;
  };
  mark(ox, oy);

  for (let oct = 0; oct < 8; oct++) {
    castLight(level, mark, ox, oy, radius, 1, 1.0, 0.0, OCTANTS[oct]);
  }

  // NetHack 规则：玩家踏入照明房间时，整间房间立刻可见。
  const room = roomAt(level, ox, oy);
  if (room && room.lit) {
    for (let x = room.lx; x <= room.hx; x++) {
      for (let y = room.ly; y <= room.hy; y++) mark(x, y);
    }
  }

  if (log.isDebug()) {
    let count = 0;
    for (let i = 0; i < visible.length; i++) count += visible[i];
    log.debug('视野计算完成', { from: [ox, oy], radius, visibleTiles: count });
  }
  return visible;
}

/** 八个分区的坐标变换向量：[xx, xy, yx, yy]。 */
const OCTANTS = [
  [1, 0, 0, 1],
  [0, 1, 1, 0],
  [0, -1, 1, 0],
  [-1, 0, 0, 1],
  [-1, 0, 0, -1],
  [0, -1, -1, 0],
  [0, 1, -1, 0],
  [1, 0, 0, -1],
];

/**
 * 递归阴影投射（Björn Bergström 算法，roguelike 领域的标准实现）。
 * `mark` 负责记录可见瓦片。
 */
function castLight(
  level: Level,
  mark: (x: number, y: number) => void,
  ox: number,
  oy: number,
  radius: number,
  row: number,
  start: number,
  end: number,
  [xx, xy, yx, yy]: number[],
): void {
  if (start < end) return;
  let newStart = start;
  for (let i = row; i <= radius; i++) {
    let blocked = false;
    for (let dx = -i, dy = -i; dx <= 0; dx++) {
      const X = ox + dx * xx + dy * xy;
      const Y = oy + dx * yx + dy * yy;
      const lSlope = (dx - 0.5) / (dy + 0.5);
      const rSlope = (dx + 0.5) / (dy - 0.5);
      if (start < rSlope) continue;
      if (end > lSlope) break;

      if (inBounds(X, Y)) {
        mark(X, Y);
        const opaque = blocksSight(level, X, Y);
        if (blocked) {
          if (opaque) {
            newStart = rSlope;
            continue;
          }
          blocked = false;
          start = newStart;
        } else if (opaque) {
          blocked = true;
          castLight(level, mark, ox, oy, radius, i + 1, start, lSlope, [xx, xy, yx, yy]);
          newStart = rSlope;
        }
      }
    }
    if (blocked) break;
  }
}
