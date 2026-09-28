/**
 * 会话视角的 ASCII 地图：在关卡地形上叠加玩家与怪物。
 *
 * `levelToAscii` 只看地形；这里补上实体，供失败现场、状态转储与人工排查使用。
 * 玩家标记为 `@`，怪物用原版字形。
 */

import type { GameSession } from './session';
import { levelToAscii } from './dungeon';

/** 把关卡渲染成 ASCII，附带玩家与怪物标记。 */
export function sessionAscii(session: GameSession): string {
  const ascii = levelToAscii(session.level, { showTraps: true }).split('\n');
  const mark = (x: number, y: number, ch: string): void => {
    if (y < 0 || y >= ascii.length) return;
    const line = ascii[y];
    if (x < 0 || x >= line.length) return;
    ascii[y] = `${line.slice(0, x)}${ch}${line.slice(x + 1)}`;
  };
  mark(session.player.x, session.player.y, '@');
  for (const mon of session.level.monsters) {
    mark(mon.x, mon.y, mon.data.glyph);
  }
  return ascii.join('\n');
}
