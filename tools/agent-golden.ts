/**
 * 快照回归。
 *
 * 记录「关卡地形」与「一场固定战斗的结果序列」的散列值，
 * 用于发现无意间的行为漂移：改动前后散列不同即说明行为变了。
 *
 * 判定为有意改动时，用 `bun tools/agent-loop.ts --update-golden` 更新快照，
 * 并在提交信息中说明原因。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Level } from '../src/types';
import { generateLevel } from '../src/game/dungeon';
import { newSession } from './agent-lib';
import { teleportPlayer } from './agent-lib';

const projectRoot = path.resolve(import.meta.dir, '..');

/** 快照文件路径，随仓库提交。 */
const GOLDEN_PATH = path.join(projectRoot, 'tools', 'agent-golden.json');

/** 参与快照的种子与层数。覆盖面广且数量可控，便于人工核对差异。 */
const GOLDEN_SEEDS = [1, 42, 777, 12345, 99991];
const GOLDEN_DEPTHS = [1, 2, 5, 10, 20, 30];

/** 战斗轨迹使用的种子。 */
const TRACE_SEEDS = [17, 4093];

/** 快照文件结构。 */
interface GoldenData {
  version: 1;
  generatedAt: string;
  levels: Record<string, string>;
  combat: Record<string, string>;
}

/** 快照比对结果。 */
export interface GoldenDiff {
  compared: number;
  mismatched: { key: string; expected: string; actual: string }[];
  written: boolean;
}

/** FNV-1a 散列，输出 8 位十六进制。 */
export function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 关卡地形与设施的规范化字符串。 */
function levelFingerprint(level: Level): string {
  return [
    `tiles=${Array.from(level.tiles).join('')}`,
    `lit=${Array.from(level.lit).join('')}`,
    `rooms=${level.rooms.map((r) => `${r.lx},${r.ly},${r.hx},${r.hy},${r.lit ? 1 : 0}`).join(';')}`,
    `doors=${[...level.doors.keys()].sort((a, b) => a - b).join(',')}`,
    `traps=${[...level.traps.keys()].sort((a, b) => a - b).join(',')}`,
    `stairs=${level.stairs.map((s) => `${s.x},${s.y},${s.dir}`).join(';')}`,
    `up=${level.up ? `${level.up.x},${level.up.y}` : '-'}`,
    `down=${level.down ? `${level.down.x},${level.down.y}` : '-'}`,
    `features=${[...level.features.keys()].sort((a, b) => a - b).join(',')}`,
  ].join('|');
}

/**
 * 固定战斗的结果轨迹。
 *
 * 玩家与怪物的属性都写死，唯一变量是游戏内的随机数，
 * 因此轨迹变化只可能来自战斗规则或随机数使用的改动。
 */
function combatTrace(seed: number): string {
  const session = newSession(seed);
  const { player } = session;
  player.maxHp = 100;
  player.hp = 100;
  player.level = 6;
  player.str = 18;

  const target = session.level.monsters[0];
  if (!target) return 'no-monster';
  target.mhp = 20;
  target.mhpmax = 20;
  target.asleep = false;
  teleportPlayer(session, target.x - 1, target.y);

  const events: string[] = [];
  for (let i = 0; i < 25 && !target.dead && !session.dead; i++) {
    const hpBefore = target.mhp;
    const outcome = session.movePlayer(1, 0);
    events.push(`${i}:${outcome.result}:${hpBefore}->${target.mhp}:${player.hp}`);
  }
  return [
    ...events,
    `kills=${session.kills}`,
    `turn=${session.turn}`,
    `playerHp=${player.hp}`,
    `dead=${session.dead ? 1 : 0}`,
  ].join('|');
}

/** 采集当前行为对应的全部快照值。 */
export function collectGolden(): GoldenData {
  const levels: Record<string, string> = {};
  for (const seed of GOLDEN_SEEDS) {
    for (const depth of GOLDEN_DEPTHS) {
      const level = generateLevel({ gameSeed: seed, depth });
      levels[`${seed}:${depth}`] = hash(levelFingerprint(level));
    }
  }
  const combat: Record<string, string> = {};
  for (const seed of TRACE_SEEDS) {
    combat[`${seed}`] = hash(combatTrace(seed));
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    levels,
    combat,
  };
}

/** 读取快照文件；不存在或损坏时返回 null。 */
function loadGolden(): GoldenData | null {
  try {
    if (!fs.existsSync(GOLDEN_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as GoldenData;
    if (data.version !== 1) return null;
    return data;
  } catch {
    return null;
  }
}

/** 写入快照文件。 */
function writeGolden(data: GoldenData): void {
  fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * 比对快照。
 *
 * 未传入基准时（首次运行）只统计数量，不做判定；
 * `update` 为真时直接覆盖写盘。
 */
export function compareGolden(current: GoldenData, update: boolean): GoldenDiff {
  const stored = loadGolden();
  const mismatched: { key: string; expected: string; actual: string }[] = [];

  if (update || !stored) {
    writeGolden(current);
    return {
      compared: Object.keys(current.levels).length + Object.keys(current.combat).length,
      mismatched: [],
      written: true,
    };
  }

  for (const [key, value] of Object.entries(current.levels)) {
    if (stored.levels[key] !== value) {
      mismatched.push({
        key: `levels:${key}`,
        expected: stored.levels[key] ?? '缺失',
        actual: value,
      });
    }
  }
  for (const [key, value] of Object.entries(current.combat)) {
    if (stored.combat[key] !== value) {
      mismatched.push({
        key: `combat:${key}`,
        expected: stored.combat[key] ?? '缺失',
        actual: value,
      });
    }
  }

  return {
    compared: Object.keys(current.levels).length + Object.keys(current.combat).length,
    mismatched,
    written: false,
  };
}
