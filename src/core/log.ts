/**
 * 统一日志入口。
 *
 * 默认只输出 warn 与 error，避免刷屏影响游戏体验。调试开关的优先级从高到低：
 *
 * 1. URL 参数：`?debug=1` 打开全部命名空间，`?debug=combat,fov` 只打开指定命名空间。
 * 2. 本地存储：`localStorage.setItem('nethack3d.debug', 'combat')`。
 * 3. 控制台调用：`__nethack3dLog.enable('combat')`。
 *
 * 用法：
 *
 * ```ts
 * const log = createLogger('combat');
 * log.debug('命中判定', { roll, ac });   // 仅在 combat 命名空间开启时输出
 * ```
 *
 * 所有日志同时写入环形缓冲区，便于崩溃后回溯最近的关键路径。
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 一条日志记录。`seq` 为自增序号，便于排序与去重。 */
export interface LogEntry {
  seq: number;
  time: number;
  level: LogLevel;
  namespace: string;
  message: string;
  data?: unknown;
}

/** 对外暴露的日志器接口。 */
interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** 派生带子命名空间的日志器，例如 `combat` -> `combat.roll`。 */
  child(namespace: string): Logger;
  /** 计时器：调用返回值即可结束并输出耗时（毫秒）。 */
  time(label: string): (extra?: unknown) => number;
  /** 当前命名空间是否开启了 debug 输出。 */
  isDebug(): boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 缓冲区容量，够保留一局游戏的关键事件。 */
const RING_CAPACITY = 500;

const buffer: LogEntry[] = [];
let seq = 0;

/** 已开启 debug 的命名空间；`'*'` 表示全部开启。 */
const debugNamespaces = new Set<string>();

/** 最低输出级别。默认为 warn，控制台保持安静；开启调试后降为 debug。 */
let minLevel: LogLevel = 'warn';

/** 解析 `1`、`*`、`combat,fov` 形式的开关描述。 */
export function parseDebugSpec(spec: string | null | undefined): void {
  if (!spec) return;
  for (const raw of spec.split(',')) {
    const item = raw.trim().toLowerCase();
    if (!item || item === '0' || item === 'off' || item === 'false') continue;
    debugNamespaces.add(item === '1' || item === 'true' || item === 'all' ? '*' : item);
  }
}

/** 打开指定命名空间（支持前缀匹配，`'*'` 为全部）。 */
function enableDebug(...namespaces: string[]): void {
  for (const ns of namespaces) debugNamespaces.add(ns.trim().toLowerCase());
}

/** 关闭指定命名空间；不传参数时全部关闭。 */
export function disableDebug(...namespaces: string[]): void {
  if (!namespaces.length) debugNamespaces.clear();
  else namespaces.forEach((ns) => debugNamespaces.delete(ns.trim().toLowerCase()));
}

/** 设置最低输出级别。 */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function isDebugEnabled(namespace: string): boolean {
  if (debugNamespaces.has('*')) return true;
  for (const ns of debugNamespaces) {
    if (namespace === ns || namespace.startsWith(`${ns}.`)) return true;
  }
  return false;
}

function shouldLog(level: LogLevel, namespace: string): boolean {
  if (level === 'debug' && !isDebugEnabled(namespace)) return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

const CONSOLE_STYLE = 'color:#c9a44c';

function emit(level: LogLevel, namespace: string, message: string, data?: unknown): void {
  const entry: LogEntry = { seq: seq++, time: Date.now(), level, namespace, message, data };
  buffer.push(entry);
  if (buffer.length > RING_CAPACITY) buffer.shift();

  const prefix = `%c[nh3d:${namespace}]`;
  const fn = level === 'debug' ? console.debug : console[level];
  if (data === undefined) fn.call(console, prefix, CONSOLE_STYLE, message);
  else fn.call(console, prefix, CONSOLE_STYLE, message, data);
}

/** 创建指定命名空间的日志器。 */
export function createLogger(namespace: string): Logger {
  const make = (ns: string): Logger => ({
    debug: (message, data) => {
      if (shouldLog('debug', ns)) emit('debug', ns, message, data);
    },
    info: (message, data) => {
      if (shouldLog('info', ns)) emit('info', ns, message, data);
    },
    warn: (message, data) => {
      if (shouldLog('warn', ns)) emit('warn', ns, message, data);
    },
    error: (message, data) => {
      if (shouldLog('error', ns)) emit('error', ns, message, data);
    },
    child: (sub) => make(`${ns}.${sub}`),
    time: (label) => {
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return (extra?: unknown) => {
        const elapsed =
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
        if (shouldLog('debug', ns)) {
          emit('debug', ns, `${label} 耗时 ${elapsed.toFixed(1)}ms`, extra);
        }
        return elapsed;
      };
    },
    isDebug: () => isDebugEnabled(ns),
  });
  return make(namespace);
}

/** 读取最近的日志记录。`count` 为最多返回条数。 */
export function recentLogs(count = 100): LogEntry[] {
  return buffer.slice(-count);
}

/** 把最近的日志导出为纯文本，便于粘贴到问题反馈中。 */
export function dumpLogs(count = 200): string {
  return recentLogs(count)
    .map((e) => {
      const time = new Date(e.time).toISOString().slice(11, 23);
      const data = e.data === undefined ? '' : ` ${safeStringify(e.data)}`;
      return `${time} ${e.level.toUpperCase().padEnd(5)} [${e.namespace}] ${e.message}${data}`;
    })
    .join('\n');
}

/** 清空缓冲区。 */
export function clearLogs(): void {
  buffer.length = 0;
}

/** 序列化日志附加数据，循环引用与不可序列化值都能安全降级。 */
function safeStringify(value: unknown, maxLength = 400): string {
  try {
    const json = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return String(v);
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      return v;
    });
    if (json === undefined) return String(value);
    return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
  } catch {
    return String(value);
  }
}

/** 根据 URL 参数与本地存储初始化调试开关。 */
export function initLoggingFromEnvironment(search?: string): void {
  try {
    const query = search ?? (typeof location !== 'undefined' ? location.search : '');
    const params = new URLSearchParams(query);
    parseDebugSpec(params.get('debug'));
    const stored =
      typeof localStorage !== 'undefined' ? localStorage.getItem('nethack3d.debug') : null;
    parseDebugSpec(stored);
    if (params.get('debug') || stored) minLevel = 'debug';
  } catch {
    // 环境不可用时保持默认设置。
  }
}

/**
 * 是否请求了调试模式。
 *
 * 除开发模式外，带 `?debug=1` 打开页面时也应暴露游戏状态，
 * 否则生产构建无法被自动化检查验证，线上问题也难以现场排查。
 */
export function debugRequested(): boolean {
  try {
    if (typeof location === 'undefined') return false;
    if (new URLSearchParams(location.search).get('debug')) return true;
    return typeof localStorage !== 'undefined' && localStorage.getItem('nethack3d.debug') !== null;
  } catch {
    return false;
  }
}

/** 暴露到全局，便于在浏览器控制台临时开启调试。 */
export function installLogConsoleApi(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __nethack3dLog: unknown }).__nethack3dLog = {
    enable: enableDebug,
    disable: disableDebug,
    setLevel: setLogLevel,
    dump: dumpLogs,
    recent: recentLogs,
    clear: clearLogs,
  };
}

// 常用命名空间，减少散落的字符串字面量。
export const LOG_NS = {
  app: 'app',
  dungeon: 'dungeon',
  fov: 'fov',
  combat: 'combat',
  monsters: 'monsters',
  items: 'items',
  session: 'session',
  save: 'save',
  render: 'render',
  ui: 'ui',
  i18n: 'i18n',
  data: 'data',
} as const;
