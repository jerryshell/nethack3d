/**
 * 带种子的随机数发生器，调用语义与 NetHack 一致。
 *
 * NetHack 的随机数接口很小（源码 src/rnd.c）：
 *
 * - `rn2(n)`：返回 `[0, n)` 区间整数，`n <= 0` 时返回 0。
 * - `rnd(n)`：返回 `[1, n]` 区间整数。
 * - `rn1(x, y)`：返回 `[x, x+y)` 区间整数。
 * - `dice(n, s)`：掷 `n` 个 `s` 面骰并求和，`n = 0` 时返回 0。
 *
 * 底层使用 xoshiro128**，由 splitmix32 播种：体积小、速度快，
 * 并且完全由种子决定，便于存档只保存种子。
 */

import type { Rng } from '../types';

/** 32 位循环左移。 */
const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** 对任意整数或字符串片段做确定性的 32 位散列，用于派生种子。 */
export function deriveSeed(...parts: (number | string)[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const v = typeof part === 'number' ? part | 0 : hashString(String(part));
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** FNV-1a 字符串散列。 */
function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 由种子创建发生器。相同种子必然产生相同序列。 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  const splitmix = (): number => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };

  let s0 = splitmix();
  let s1 = splitmix();
  let s2 = splitmix();
  let s3 = splitmix();

  /** 返回一个原始 32 位无符号整数。 */
  function next(): number {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  }

  /** 返回 `[0, 1)` 区间浮点数。 */
  const float = (): number => next() / 4294967296;

  /** NetHack rn2：返回 `[0, n)`。 */
  const rn2 = (n: number): number => (n > 0 ? next() % n : 0);

  /** NetHack rnd：返回 `[1, n]`。 */
  const rnd = (n: number): number => (n > 0 ? rn2(n) + 1 : 0);

  /** NetHack rn1：返回 `[x, x+y)`。 */
  const rn1 = (x: number, y: number): number => x + rn2(y);

  /** NetHack dice：掷 `n` 个 `s` 面骰。 */
  function dice(n: number, s: number): number {
    let total = 0;
    for (let i = 0; i < n; i++) total += rnd(s);
    return total;
  }

  /** 按 `"1d8"`、`"2d6"` 形式的字符串掷伤害。 */
  function rollDamage(spec: string): number {
    const m = /^(\d+)d(\d+)$/.exec(String(spec || '1d2'));
    if (!m) return 0;
    return dice(Number(m[1]), Number(m[2]));
  }

  /** 以概率 `p`（0 到 1）返回 true。 */
  const chance = (p: number): boolean => float() < p;

  /** 原地 Fisher–Yates 洗牌，等价于 NetHack 的 shuffle()。 */
  function shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rn2(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** 从数组中均匀取一个元素。 */
  const pick = <T>(arr: T[]): T | undefined => (arr.length ? arr[rn2(arr.length)] : undefined);

  /**
   * 按权重取一个元素。`weightFn` 可以是函数或属性名。
   * 权重为零或负数的元素会被跳过，全部不可取时返回 undefined。
   */
  function pickWeighted<T>(items: T[], weightFn: keyof T | ((item: T) => number)): T | undefined {
    const w: (item: T) => number =
      typeof weightFn === 'function'
        ? (weightFn as (item: T) => number)
        : (it) => Number(it[weightFn] ?? 0);
    let total = 0;
    for (const it of items) total += Math.max(0, w(it));
    if (total <= 0) return undefined;
    let roll = float() * total;
    for (const it of items) {
      roll -= Math.max(0, w(it));
      if (roll < 0) return it;
    }
    return items[items.length - 1];
  }

  return {
    seed,
    next,
    float,
    rn2,
    rnd,
    rn1,
    dice,
    rollDamage,
    chance,
    shuffle,
    pick,
    pickWeighted,
    /** 导出发生器状态，供存档使用。 */
    getState: (): [number, number, number, number] => [s0, s1, s2, s3],
    setState: ([a0, a1, a2, a3]: [number, number, number, number]): void => {
      s0 = a0 >>> 0;
      s1 = a1 >>> 0;
      s2 = a2 >>> 0;
      s3 = a3 >>> 0;
    },
  };
}
