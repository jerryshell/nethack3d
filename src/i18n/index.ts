/**
 * 国际化运行时。
 *
 * 语言包是嵌套的普通对象，键使用点号路径，例如 `t('title.newGame')`。
 * 变量插值使用花括号：`t('msg.welcome', { name: 'Alice' })`。
 * 复数形式把键的值写成 `{ one, other }`，由 `tn(key, count)` 选择。
 * 取值顺序：当前语言 → 英文 → 原始键名，任何情况下都不会抛错。
 */

import { createLogger, LOG_NS } from '../core/log';
import en from './en';
import zhCN from './zh-CN';

export type LocaleId = 'en' | 'zh-CN';

/** 语言包节点：字符串、复数对象或嵌套对象。 */
export type MessageNode =
  | string
  | { one?: string; other?: string }
  | { [key: string]: MessageNode };
export type MessageCatalog = Record<string, MessageNode>;

const log = createLogger(LOG_NS.i18n);

export const LOCALES: Record<LocaleId, { label: string; messages: MessageCatalog }> = {
  en: { label: 'English', messages: en as MessageCatalog },
  'zh-CN': { label: '简体中文', messages: zhCN as MessageCatalog },
};

export const LOCALE_STORAGE_KEY = 'nethack3d.locale';

let currentLocale: LocaleId = detectLocale();
const listeners = new Set<(locale: LocaleId) => void>();

/** 依次尝试本地存储、浏览器语言，最后回退英文。 */
function detectLocale(): LocaleId {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY) as LocaleId | null;
    if (saved && LOCALES[saved]) return saved;
  } catch {
    // 存储不可用时忽略，继续按浏览器语言判断。
  }
  const candidates: string[] = [];
  if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
    if (navigator.language) candidates.push(navigator.language);
  }
  for (const tag of candidates) {
    const norm = String(tag).toLowerCase();
    if (norm.startsWith('zh')) return 'zh-CN';
    if (norm.startsWith('en')) return 'en';
  }
  return 'en';
}

/** 按点号路径查找语言包节点。 */
function lookup(messages: MessageCatalog, key: string): MessageNode | undefined {
  let node: MessageNode | undefined = messages;
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, MessageNode>)[part];
  }
  return node;
}

/** 替换 `{name}` 形式的占位符，缺失的变量保持原样。 */
function interpolate(text: MessageNode | undefined, vars?: Record<string, unknown>): string {
  if (typeof text !== 'string') return '';
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
  );
}

/** 把语言包节点归一为字符串，复数对象优先取 other。 */
function toStringNode(value: MessageNode | undefined, prefer?: 'one' | 'other'): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const plural = value as { one?: string; other?: string };
    if (prefer && plural[prefer]) return plural[prefer] as string;
    if (plural.other) return plural.other;
    const first = Object.values(value)[0];
    if (typeof first === 'string') return first;
  }
  return '';
}

/** 在当前语言下翻译点号路径的键。 */
export function t(key: string, vars?: Record<string, unknown>): string {
  let value = lookup(LOCALES[currentLocale].messages, key);
  if (value === undefined && currentLocale !== 'en') value = lookup(en as MessageCatalog, key);
  if (value === undefined) return key; // 保留原始键名，便于定位缺失翻译
  return interpolate(value, vars);
}

/**
 * 带复数的翻译。英文语言包写 `{ one, other }`；
 * 中文没有语法复数，可以只写一个字符串。
 */
export function tn(key: string, count: number, vars?: Record<string, unknown>): string {
  let value = lookup(LOCALES[currentLocale].messages, key);
  if (value === undefined && currentLocale !== 'en') value = lookup(en as MessageCatalog, key);
  if (value === undefined) return key;
  return interpolate(toStringNode(value, count === 1 ? 'one' : 'other'), { ...vars, count });
}

export function getLocale(): LocaleId {
  return currentLocale;
}

/** 切换语言并写入本地存储，随后通知所有监听者。 */
export function setLocale(locale: LocaleId): void {
  if (!LOCALES[locale] || locale === currentLocale) return;
  const previous = currentLocale;
  currentLocale = locale;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 存储不可用时忽略。
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    document.dispatchEvent(new CustomEvent('localechange', { detail: { locale } }));
  }
  log.info('切换语言', { from: previous, to: locale });
  listeners.forEach((fn) => fn(locale));
}

/** 返回下一个可选语言，用于语言切换按钮。 */
export function nextLocale(): LocaleId {
  const keys = Object.keys(LOCALES) as LocaleId[];
  const idx = keys.indexOf(currentLocale);
  return keys[(idx + 1) % keys.length];
}

/** 注册语言变化回调，返回取消注册的函数。 */
export function onLocaleChange(fn: (locale: LocaleId) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 刷新所有声明了 data-i18n / data-i18n-title / data-i18n-placeholder 的元素。 */
export function applyI18n(root?: ParentNode): void {
  const scope: ParentNode = root ?? document;
  scope.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as string);
  });
  scope.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle as string);
  });
  scope.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder as string);
  });
}
