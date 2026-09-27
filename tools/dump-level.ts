#!/usr/bin/env bun
/**
 * 输出生成关卡的 ASCII 视图，便于人工检查。
 *
 * 用法：bun tools/dump-level.ts [种子] [层数...]
 * 默认为种子 42、第 1 到 5 层。
 */
import { generateLevel, levelToAscii, describeLevel } from '../src/game/dungeon';

const seed = Number(process.argv[2] ?? 42) >>> 0;
const depths = process.argv.slice(3).map(Number);
if (!depths.length) depths.push(1, 2, 3, 4, 5, 10, 20);

for (const depth of depths) {
  const level = generateLevel({ gameSeed: seed, depth });
  const info = describeLevel(level);
  console.log(
    `\n=== seed=${seed} depth=${depth} rooms=${info.rooms} doors=${info.doors} traps=${info.traps} ` +
      `up=${info.up ? `${info.up.x},${info.up.y}` : '-'} down=${info.down ? `${info.down.x},${info.down.y}` : '-'}`,
  );
  console.log(levelToAscii(level));
}
