/**
 * Agent 交互式观察通道。
 *
 * 维护一个游戏会话，逐条读取命令并输出 JSON，适合 Agent 逐步探查游戏行为：
 *
 * ```bash
 * printf 'new seed=7\nmove e\nstatus\nmap 12\nquit\n' | bun tools/agent-repl.ts
 * bun tools/agent-repl.ts --interactive        # 人工逐条输入
 * ```
 *
 * 每条命令输出一行 JSON：`{ ok, command, data }` 或 `{ ok: false, command, error }`。
 * 列表索引使用背包字母（a 到 z、A 到 Z），与游戏内界面一致。
 */

import * as readline from 'node:readline';
import type { GameMessage, ItemDescription } from '../src/types';
import { GameSession, MAX_DEPTH } from '../src/game/session';
import { letterToIndex } from '../src/game/inventory';
import { describeItem } from '../src/game/items';
import { clearLogs, createLogger, recentLogs, type LogEntry } from '../src/core/log';
import { restoreSession, saveGame, serializeSession } from '../src/game/save';
import { roleById, raceById } from '../src/game/roles';
import {
  checkInvariants,
  createSeenTracker,
  levelSummary,
  monsterSummary,
  renderMap,
} from './agent-lib';

const log = createLogger('agent.repl');

/** 输出一行 JSON 应答。 */
function reply(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** 解析 `k=v` 形式的参数。 */
function parsePairs(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** 方向别名。 */
const DIRECTIONS: Record<string, [number, number]> = {
  n: [0, -1],
  s: [0, 1],
  e: [1, 0],
  w: [-1, 0],
  ne: [1, -1],
  nw: [-1, -1],
  se: [1, 1],
  sw: [-1, 1],
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
};

/** 把消息转成可读文本，保留变量中的实体 ID。 */
function messageView(message: GameMessage): string {
  return `${message.key} ${JSON.stringify(message.vars)}`;
}

const HELP = [
  'new [seed=N] [depth=N] [role=ID] [race=ID] [align=lawful|neutral|chaotic]  创建会话',
  'move <n|s|e|w|ne|nw|se|sw|dx,dy>   移动或攻击',
  'wait                                等待一回合',
  'pickup                              拾取当前格',
  'wield|wear|use|drop <字母>          对背包物品执行动作',
  'status                              状态快照',
  'inventory                           背包列表',
  'map [半径]                          以玩家为中心的 ASCII 地图',
  'monsters                            视野附近的怪物',
  'level [层号]                        关卡摘要（可指定已访问楼层）',
  'invariants                          立即运行不变量检查',
  'save|load                           存档读写（localStorage 不可用时仅返回序列化长度）',
  'log [条数]                          最近的消息与内部日志',
  'help                                本说明',
  'quit                                退出',
].join('\n');

const options = parsePairs(process.argv.slice(2).map((a) => a.replace(/^--/, '')));
const interactive = process.argv.includes('--interactive');

/** 当前会话与追踪器。 */
let session = new GameSession({ seed: Number(options.seed ?? 20240101) >>> 0 });
let tracker = createSeenTracker();

/** 建立新会话。 */
function createSession(pairs: Record<string, string>): GameSession {
  const seed = Number(pairs.seed ?? 20240101) >>> 0;
  const depth = Math.max(1, Math.min(MAX_DEPTH, Number(pairs.depth ?? 1)));
  const role = pairs.role ? roleById[pairs.role.toUpperCase()] : undefined;
  const race = pairs.race ? raceById[pairs.race.toUpperCase()] : undefined;
  const character =
    role && race
      ? {
          role,
          race,
          align: (pairs.align as 'lawful' | 'neutral' | 'chaotic') ?? 'neutral',
          gender: 'female' as const,
        }
      : null;
  return new GameSession({ seed, depth, character });
}

/** 执行一条命令并返回应答数据。 */
function execute(command: string, args: string[]): { ok: boolean; data?: unknown; error?: string } {
  switch (command) {
    case 'new': {
      session = createSession(parsePairs(args));
      tracker = createSeenTracker();
      return { ok: true, data: { status: session.status } };
    }
    case 'move': {
      const key = (args[0] ?? '').toLowerCase();
      let dir = DIRECTIONS[key];
      if (!dir && key.includes(',')) {
        const [dx, dy] = key.split(',').map(Number);
        dir = [dx, dy];
      }
      if (!dir) return { ok: false, error: `未知方向：${args[0] ?? ''}` };
      const result = session.movePlayer(dir[0], dir[1]);
      return { ok: true, data: { result, status: session.status, lastCombat: session.lastCombat } };
    }
    case 'wait':
      return { ok: true, data: { result: session.wait().result, status: session.status } };
    case 'pickup':
      return {
        ok: true,
        data: { result: session.pickupAction().result, inventory: session.player.inventory.length },
      };
    case 'wield':
    case 'wear':
    case 'use':
    case 'drop': {
      const idx = letterToIndex(args[0] ?? '');
      const item = idx >= 0 ? session.player.inventory[idx] : undefined;
      if (!item) return { ok: false, error: `背包中没有字母 ${args[0]} 对应的物品` };
      const verb = command === 'use' ? null : command;
      const result = session.useItem(item, verb);
      return { ok: true, data: { result, status: session.status } };
    }
    case 'status':
      return {
        ok: true,
        data: { status: session.status, inventory: session.player.inventory.length },
      };
    case 'inventory':
      return {
        ok: true,
        data: session.player.inventory.map((item, i) => ({
          letter: i < 26 ? String.fromCharCode(97 + i) : String.fromCharCode(65 + i - 26),
          description: describeItem(item) as ItemDescription,
          itemId: item.proto.id,
          known: item.known,
          equipped: session.equipped(item),
        })),
      };
    case 'map': {
      const radius = args[0] ? Number(args[0]) : 0;
      if (!radius) return { ok: true, data: { ascii: renderMap(session) } };
      const map = renderMap(session).split('\n');
      const y0 = Math.max(0, session.player.y - radius);
      const y1 = Math.min(map.length, session.player.y + radius + 1);
      const x0 = Math.max(0, session.player.x - radius);
      const x1 = session.player.x + radius + 1;
      return {
        ok: true,
        data: {
          ascii: map
            .slice(y0, y1)
            .map((l) => l.slice(x0, x1))
            .join('\n'),
        },
      };
    }
    case 'monsters':
      return { ok: true, data: monsterSummary(session.level.monsters) };
    case 'level': {
      const depth = args[0] ? Number(args[0]) : session.depth;
      const level = session.levels.get(depth);
      if (!level) return { ok: false, error: `未访问过第 ${depth} 层` };
      const wasCurrent = session.level;
      session.level = level;
      const summary = levelSummary(session);
      session.level = wasCurrent;
      return { ok: true, data: summary };
    }
    case 'invariants':
      return { ok: true, data: { problems: checkInvariants(session, tracker) } };
    case 'save': {
      const payload = JSON.stringify(serializeSession(session));
      const stored = saveGame(session);
      return { ok: true, data: { bytes: payload.length, stored } };
    }
    case 'load': {
      const raw =
        typeof localStorage !== 'undefined' ? localStorage.getItem('nethack3d.save.v1') : null;
      if (!raw) return { ok: false, error: '没有可用存档' };
      session = restoreSession(JSON.parse(raw));
      tracker = createSeenTracker();
      return { ok: true, data: { status: session.status } };
    }
    case 'log': {
      const count = args[0] ? Number(args[0]) : 8;
      return {
        ok: true,
        data: {
          messages: session.messages.slice(-count).map(messageView),
          internals: recentLogs(count).map(
            (e: LogEntry) => `${e.level} ${e.namespace} ${e.message}`,
          ),
        },
      };
    }
    case 'help':
      return { ok: true, data: { help: HELP } };
    case '':
      return { ok: true, data: {} };
    default:
      return { ok: false, error: `未知命令：${command}，可用 help 查看说明` };
  }
}

/** 处理一行输入。 */
function handle(line: string): boolean {
  const [command = '', ...args] = line.trim().split(/\s+/);
  if (command === 'quit' || command === 'exit') return false;
  const started = Date.now();
  try {
    const outcome = execute(command, args);
    reply({
      ok: outcome.ok,
      command,
      durationMs: Date.now() - started,
      ...(outcome.ok ? { data: outcome.data } : { error: outcome.error }),
    });
  } catch (err) {
    log.error('命令执行异常', err);
    reply({
      ok: false,
      command,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

clearLogs();
reply({ ok: true, command: 'ready', data: { status: session.status, help: 'help 查看命令列表' } });

const rl = readline.createInterface({ input: process.stdin, terminal: interactive });
if (interactive) {
  rl.setPrompt('nh3d> ');
  rl.prompt();
  rl.on('line', (line) => {
    if (handle(line)) rl.prompt();
    else rl.close();
  });
} else {
  rl.on('line', (line) => {
    if (!handle(line)) rl.close();
  });
}
rl.on('close', () => process.exit(0));
