/**
 * 小地图：把已探索的楼层画进一张小画布。
 *
 * 每格一个像素，再用 CSS 放大；只画见过的区域，不泄露未探索地形。
 * 玩家（白）、视野内怪物（红）、楼梯（金）单独叠色。
 */

import type { GameSession } from '../game/session';
import type { Level } from '../types';
import { shopRoom } from '../game/dungeon';
import { COLNO, ROWNO, T, isDoor, isWall } from '../core/constants';
import { PALETTE, tileColor } from '../render/palette';

export interface MinimapHandle {
  el: HTMLElement;
  update(session: GameSession): void;
  /** 设置要叠加的旅行路径；传空数组清空。 */
  setPath(points: { x: number; y: number }[]): void;
}

/** 只保留落在已探索区域内的路径点。 */
export function visiblePathPoints(
  level: Level,
  points: { x: number; y: number }[],
): { x: number; y: number }[] {
  return points.filter(
    (p) =>
      p.x >= 0 && p.y >= 0 && p.x < COLNO && p.y < ROWNO && level.seen[p.y * COLNO + p.x] === 1,
  );
}

/** 小地图格值：0 未探索，其余为瓦片编号 + 1。 */
export function minimapGrid(session: GameSession): Uint8Array {
  const level = session.level;
  const grid = new Uint8Array(COLNO * ROWNO);
  for (let i = 0; i < grid.length; i++) {
    if (level.seen[i] !== 1) continue;
    grid[i] = level.tiles[i] + 1;
  }
  return grid;
}

/** 把 0xRRGGBB 转成 CSS 颜色。 */
function css(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** 小地图格子的颜色：楼梯与设施优先，其余按地形。 */
export function minimapColor(tile: number, stair: 'up' | 'down' | 'branch' | null): number {
  if (stair === 'branch') return PALETTE.fountainWater;
  if (stair === 'down') return PALETTE.stairsDown;
  if (stair === 'up') return PALETTE.stairsUp;
  if (tile === T.FOUNTAIN) return PALETTE.fountainWater;
  if (tile === T.SINK) return PALETTE.sinkMetal;
  if (tile === T.ALTAR) return PALETTE.altarGlow;
  if (tile === T.THRONE) return PALETTE.throne;
  if (tile === T.GRAVE) return PALETTE.grave;
  if (tile === T.LAVA) return PALETTE.lava;
  if (tile === T.POOL || tile === T.MOAT || tile === T.WATER) return PALETTE.water;
  if (isWall(tile)) return PALETTE.wall;
  if (isDoor(tile)) return PALETTE.doorWood;
  return tileColor(tile, 0, 0);
}

/** 创建小地图画布。 */
export function createMinimap(): MinimapHandle {
  const el = document.createElement('div');
  el.className = 'hud-minimap';
  const canvas = document.createElement('canvas');
  canvas.width = COLNO;
  canvas.height = ROWNO;
  canvas.setAttribute('aria-label', 'minimap');
  el.append(canvas);

  const ctx = canvas.getContext('2d');
  const stairAt = new Map<number, 'up' | 'down' | 'branch'>();
  let path: { x: number; y: number }[] = [];

  const update = (session: GameSession): void => {
    if (!ctx) return;
    const level = session.level;
    stairAt.clear();
    for (const s of level.stairs) stairAt.set(s.y * COLNO + s.x, s.dir);

    ctx.clearRect(0, 0, COLNO, ROWNO);
    for (let y = 0; y < ROWNO; y++) {
      for (let x = 0; x < COLNO; x++) {
        const i = y * COLNO + x;
        if (level.seen[i] !== 1) continue;
        const t = level.tiles[i];
        const stair = stairAt.get(i) ?? null;
        ctx.fillStyle = css(minimapColor(t, stair));
        ctx.fillRect(x, y, 1, 1);
      }
    }

    // 商店房间染上一层金色底，一眼能认出市集。
    const shop = shopRoom(level);
    if (shop) {
      ctx.fillStyle = 'rgba(201, 164, 76, 0.35)';
      for (let y = shop.ly; y <= shop.hy; y++) {
        for (let x = shop.lx; x <= shop.hx; x++) {
          if (level.seen[y * COLNO + x] !== 1) continue;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    // 旅行路径：只画已探索的格子，压在设施之上。
    if (path.length) {
      ctx.fillStyle = '#7fd1ff';
      for (const p of visiblePathPoints(level, path)) ctx.fillRect(p.x, p.y, 1, 1);
    }

    // 视野内的怪物与玩家叠在最上层。
    if (session.visible) {
      for (const mon of level.monsters) {
        if (mon.dead || mon.mhp <= 0) continue;
        if (session.visible[mon.y * COLNO + mon.x] !== 1) continue;
        ctx.fillStyle = css(PALETTE.altarGlow);
        ctx.fillRect(mon.x, mon.y, 1, 1);
      }
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(session.player.x, session.player.y, 1, 1);
  };

  return {
    el,
    update,
    setPath(next: { x: number; y: number }[]): void {
      path = next.slice();
    },
  };
}
