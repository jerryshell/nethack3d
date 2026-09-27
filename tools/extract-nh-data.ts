#!/usr/bin/env bun
/**
 * 数据提取脚本：解析 NetHack 5.0 的 C 头文件，生成带类型的 TypeScript 数据模块。
 *
 *   src/data/monsters.gen.ts   来自 include/monsters.h（MON 宏条目）
 *   src/data/objects.gen.ts    来自 include/objects.h（类宏条目）
 *
 * 用法：
 *   bun tools/extract-nh-data.ts [NetHack 源码路径]
 *
 * 源码路径默认取环境变量 NETHACK_SRC，其次取项目根目录的上一级 ../nethack。
 * 生成结果提交进仓库，因此构建过程不依赖参考源码。
 */

import type { MonsterData, ObjectData } from '../src/types';
import fs from 'node:fs';
import path from 'node:path';
import { compareReference, loadRecordedReference, readReferenceState } from './nethack-ref';

const projectRoot = path.resolve(import.meta.dir, '..');
const nhRoot = path.resolve(
  process.argv[2] || process.env.NETHACK_SRC || path.join(projectRoot, '..', 'nethack'),
);

/** 预处理阶段的宏定义：参数列表（对象宏为 null）与展开体。 */
interface MacroDef {
  params: string[] | null;
  body: string;
}

/** 提取过程中逐步构建的动态记录，写盘前再收窄为具体类型。 */
type LooseRecord = Record<string, unknown>;

const read = (p: string): string => fs.readFileSync(p, 'utf8');
const inc = (f: string): string => read(path.join(nhRoot, 'include', f));

// ---------------------------------------------------------------------------
// C 文本处理工具
// ---------------------------------------------------------------------------

/** 去掉块注释与行注释，同时保留字符串字面量。 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        out += src[i];
        if (src[i] === '\\') {
          if (i + 1 < src.length) out += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 按顶层逗号切分 C 参数列表。 */
function splitTopLevel(s: string): string[] {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') i += 2;
        else if (s[i] === q) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  const tail = s.slice(start).trim();
  if (tail.length || parts.length) parts.push(tail);
  return parts;
}

/** 从 `from` 开始查找 `NAME(` 调用，返回 {args, end}，找不到时返回 null。 */
function findCall(text: string, name: string, from = 0): { args: string[]; end: number } | null {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  let i = openIdx + 1;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (text[i] === q) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  return { args: splitTopLevel(text.slice(openIdx + 1, i - 1)), end: i };
}

/** 表达式中第一个 C 字符串字面量，没有则返回 null。 */
function firstString(expr: string): string | null {
  const m = /"((?:[^"\\]|\\.)*)"/.exec(expr);
  return m ? m[1] : null;
}

/** 表达式中所有以指定前缀开头的标识符，已去重。 */
function idents(expr: string, prefix: string): string[] {
  return (expr.match(new RegExp(`\\b${prefix}[A-Za-z0-9_]*\\b`, 'g')) || []).filter(
    (v, i, a) => a.indexOf(v) === i,
  );
}

/** 转义序列查表，键为反斜杠后的字符。 */
const C_ESCAPES: Record<string, string> = {};
C_ESCAPES['n'] = String.fromCharCode(10);
C_ESCAPES['t'] = String.fromCharCode(9);
C_ESCAPES['r'] = String.fromCharCode(13);
C_ESCAPES['0'] = String.fromCharCode(0);
C_ESCAPES['\\'] = String.fromCharCode(92);
C_ESCAPES["'"] = String.fromCharCode(39);
C_ESCAPES['"'] = String.fromCharCode(34);

/** 还原 C 字符串与字符字面量中的转义序列。 */
function unescapeC(src: string): string {
  return src.replace(/\\(.)/g, (_m: string, c: string) => C_ESCAPES[c] ?? c);
}

/** 计算简单常量表达式：数字与加减乘除、括号。 */
function evalNum(expr: string | number, env: Record<string, number> = {}): number | null {
  let e = String(expr).trim();
  if (/^-?\d+$/.test(e)) return Number(e);
  for (const [k, v] of Object.entries(env)) {
    e = e.replace(new RegExp(`\\b${k}\\b`, 'g'), String(v));
  }
  e = e.replace(/\(char\s*\*\)/g, '').replace(/\b0L\b/g, '0');
  if (!/^[\d\s+\-*/()]+$/.test(e)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${e});`)();
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 感知预处理指令的扫描：逐行前进并维护实时的宏表，
// 把非指令内容交给 `onCode(text)` 处理。
// ---------------------------------------------------------------------------

function scanDirectives(
  src: string,
  onCode: (code: string, macros: Map<string, MacroDef>) => void,
): Map<string, MacroDef> {
  const lines = stripComments(src).split('\n');
  const macros = new Map<string, MacroDef>();
  let pending = null; // accumulated logic line (for line continuations)
  let codeBuf: string[] = [];

  const flushCode = (): void => {
    if (codeBuf.length) {
      onCode(codeBuf.join('\n'), new Map(macros));
      codeBuf = [];
    }
  };

  const handleLine = (line: string): void => {
    const t = line.trim();
    if (!t) return;
    if (!t.startsWith('#')) {
      codeBuf.push(line);
      return;
    }
    flushCode();
    const def = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(([^)]*)\))?\s*(.*)$/.exec(t);
    if (def) {
      const name = def[1];
      const params = def[3] !== undefined ? splitTopLevel(def[3]).filter(Boolean) : null;
      macros.set(name, { params, body: def[4] ?? '' });
      return;
    }
    const undef = /^#\s*undef\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
    if (undef) macros.delete(undef[1]);
  };

  for (const raw of lines) {
    const line: string = pending !== null ? pending + raw : raw;
    if (/\\\s*$/.test(line)) {
      pending = line.replace(/\\\s*$/, ' ');
      continue;
    }
    pending = null;
    handleLine(line);
  }
  if (pending !== null) handleLine(pending);
  flushCode();
  return macros;
}

// ---------------------------------------------------------------------------
// 颜色表
// ---------------------------------------------------------------------------

const CGA = {
  0: '#000000',
  1: '#aa0000',
  2: '#00aa00',
  3: '#aa5500',
  4: '#0000aa',
  5: '#aa00aa',
  6: '#00aaaa',
  7: '#aaaaaa',
  8: '#555555',
  9: '#ff5555',
  10: '#55ff55',
  11: '#ffff55',
  12: '#5555ff',
  13: '#ff55ff',
  14: '#55ffff',
  15: '#ffffff',
};

function parseColors(): Map<string, string | null> {
  const src = stripComments(inc('color.h'));
  const raw = new Map<string, string>();
  for (const m of src.matchAll(/^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/gm)) {
    raw.set(m[1], m[2].trim());
  }
  const resolved = new Map<string, string | null>();
  const resolve = (name: string, depth = 0): string | null => {
    if (depth > 6) return null;
    if (resolved.has(name)) return resolved.get(name) ?? null;
    const v = raw.get(name);
    if (v === undefined) return null;
    if (/^-?\d+$/.test(v)) {
      const hex = (CGA as Record<number, string>)[Number(v)] ?? null;
      resolved.set(name, hex);
      return hex;
    }
    const sub = resolve(v.split(/[^A-Za-z0-9_]/)[0], depth + 1);
    resolved.set(name, sub);
    return sub;
  };
  for (const name of raw.keys()) resolve(name);
  return resolved;
}

// ---------------------------------------------------------------------------
// 怪物字形类别，来源 defsym.h 的 MONSYM 行
// ---------------------------------------------------------------------------

function parseSymbols(): Map<string, { glyph: string; className: string; desc: string }> {
  const src = stripComments(inc('defsym.h'));
  const out = new Map<string, { glyph: string; className: string; desc: string }>();
  for (const m of src.matchAll(
    /MONSYM\(\s*\d+\s*,\s*'((?:[^'\\]|\\.)*)'\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(S_[A-Za-z_][A-Za-z0-9_]*)\s*,\s*"([^"]*)"/g,
  )) {
    out.set(m[3], { glyph: unescapeC(m[1]), className: m[2], desc: m[4] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 怪物提取：结构化解析 MON 宏条目
// ---------------------------------------------------------------------------

const ALIGN = { A_LAWFUL: 1, A_NEUTRAL: 0, A_CHAOTIC: -1, A_NONE: -128 };

function parseMonsters({
  colors,
  symbols,
}: {
  colors: Map<string, string | null>;
  symbols: Map<string, { glyph: string; className: string; desc: string }>;
}): MonsterData[] {
  const src = inc('monsters.h');
  const monsters: MonsterData[] = [];
  const seen = new Set<string>();

  scanDirectives(src, (code, _macros) => {
    let from = 0;
    for (;;) {
      const call = findCall(code, 'MON', from);
      if (!call) break;
      from = call.end;
      const [
        namArg,
        symArg,
        lvlArg,
        genArg,
        atkArg,
        sizArg,
        mr1Arg,
        mr2Arg,
        m1Arg,
        m2Arg,
        m3Arg,
        diffArg,
        colArg,
        tagArg,
      ] = call.args;
      if (!namArg || !tagArg) continue;

      const name = firstString(namArg);
      const tag = (tagArg.match(/\b[A-Z][A-Z0-9_]*\b/) || [null])[0];
      if (!name || !tag || seen.has(tag)) continue;
      seen.add(tag);
      const symMeta = symbols.get(symArg.trim());

      // LVL(等级, 速度, 护甲, 魔抗, 阵营)
      const lvl = findCall(lvlArg, 'LVL');
      const lvlArgs = lvl ? lvl.args : [];
      // SIZ(重量, 营养, 叫声, 体型)
      const siz = findCall(sizArg, 'SIZ');
      const sizArgs = siz ? siz.args : [];

      const attacks: MonsterData['attacks'] = [];
      const aCall = findCall(atkArg, 'A');
      const aArgs = aCall ? aCall.args : splitTopLevel(atkArg);
      for (const a of aArgs) {
        const attk = findCall(a, 'ATTK');
        if (!attk || attk.args.length < 4) continue;
        attacks.push({
          at: attk.args[0].trim(),
          ad: attk.args[1].trim(),
          dice: [evalNum(attk.args[2]) ?? 0, evalNum(attk.args[3]) ?? 0],
        });
      }

      const freq = evalNum(
        String(genArg)
          .replace(/\(|\)/g, '')
          .match(/(?<![A-Z_0-9])(\d+)(?![A-Z_0-9])/)?.[0] ?? '0',
      );
      const alignName = idents(lvlArgs[4] ?? '0', 'A_')[0];
      const colorHex =
        colors.get(idents(colArg, 'CLR_')[0]) ?? colors.get(idents(colArg, 'HI_')[0]) ?? '#aaaaaa';

      monsters.push({
        id: tag,
        name,
        glyph: symMeta?.glyph ?? firstString(symArg) ?? '?',
        sym: symArg.trim(),
        symClass: symMeta?.className ?? '',
        lvl: evalNum(lvlArgs[0] ?? '0') ?? 0,
        speed: evalNum(lvlArgs[1] ?? '0') ?? 0,
        ac: evalNum(lvlArgs[2] ?? '0') ?? 0,
        mr: evalNum(lvlArgs[3] ?? '0') ?? 0,
        align:
          alignName && alignName in ALIGN
            ? (ALIGN as Record<string, number>)[alignName]
            : (evalNum(lvlArgs[4] ?? '0') ?? 0),
        freq: freq ?? 0,
        genFlags: idents(genArg, 'G_'),
        attacks,
        weight: evalNum(sizArgs[0] ?? '0') ?? 0,
        nutrition: evalNum(sizArgs[1] ?? '0') ?? 0,
        // 少数特殊条目（例如 long worm tail）把 SIZ 全写成 0，这里做一次归一。
        sound: /^MS_[A-Z_]+$/.test(sizArgs[2]?.trim() ?? '') ? sizArgs[2].trim() : 'MS_SILENT',
        size: (/^MZ_[A-Z_]+$/.test(sizArgs[3]?.trim() ?? '')
          ? sizArgs[3].trim()
          : 'MZ_MEDIUM') as MonsterData['size'],
        resists: idents(mr1Arg, 'MR_'),
        confers: idents(mr2Arg, 'MR_'),
        flags: [...idents(m1Arg, 'M1_'), ...idents(m2Arg, 'M2_'), ...idents(m3Arg, 'M3_')],
        diff: evalNum(diffArg) ?? 0,
        color: colorHex,
      });
    }
  });
  return monsters;
}

// ---------------------------------------------------------------------------
// 物品提取：支持一层宏展开
// ---------------------------------------------------------------------------

const TERMINAL = new Set(['OBJECT', 'OBJ', 'BITS', 'GENERIC', 'MARKER']);

function expandMacros(text: string, macros: Map<string, MacroDef>, depth = 0): string {
  if (depth > 8) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = c;
      out += c;
      i++;
      while (i < text.length) {
        out += text[i];
        if (text[i] === '\\') {
          out += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (text[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (idMatch) {
      const name = idMatch[0];
      const mac = macros.get(name);
      if (mac && !TERMINAL.has(name)) {
        let j = i + name.length;
        while (text[j] === ' ' || text[j] === '\t') j++;
        if (text[j] === '(') {
          const call = findCall(text, name, i);
          if (call && call.end > j) {
            const body = call.args;
            if (mac.params) {
              const expanded = substituteParams(mac.body, mac.params, body);
              out += expandMacros(expanded, macros, depth + 1);
              i = call.end;
              continue;
            }
            out += expandMacros(mac.body, macros, depth + 1);
            i = call.end;
            continue;
          }
        }
        if (!mac.params) {
          out += expandMacros(mac.body, macros, depth + 1);
          i += name.length;
          continue;
        }
      }
      out += name;
      i += name.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const OBJ_CLASS = {
  WEAPON_CLASS: 'weapon',
  ARMOR_CLASS: 'armor',
  POTION_CLASS: 'potion',
  SCROLL_CLASS: 'scroll',
  SPBOOK_CLASS: 'spellbook',
  WAND_CLASS: 'wand',
  RING_CLASS: 'ring',
  AMULET_CLASS: 'amulet',
  TOOL_CLASS: 'tool',
  FOOD_CLASS: 'food',
  GEM_CLASS: 'gem',
  COIN_CLASS: 'coin',
  ROCK_CLASS: 'rock',
};

const ARMOR_SLOTS = {
  ARM_SUIT: 'suit',
  ARM_SHIELD: 'shield',
  ARM_HELM: 'helm',
  ARM_GLOVES: 'gloves',
  ARM_BOOTS: 'boots',
  ARM_CLOAK: 'cloak',
  ARM_SHIRT: 'shirt',
};

/**
 * 用实参文本替换宏参数，并跳过字符串字面量。
 * 若不做限制，参数名出现在其它实参的字符串里时会被误替换，
 * 例如 FOOD("tin", ..., METAL, ...) 中的 tin。
 */
function substituteParams(body: string, params: string[], args: string[]): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'") {
      const q = c;
      out += c;
      i++;
      while (i < body.length) {
        out += body[i];
        if (body[i] === '\\') {
          out += body[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (body[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i));
    if (idMatch) {
      const name = idMatch[0];
      const idx = params.indexOf(name);
      if (idx >= 0) {
        out += args[idx] ?? '0';
        i += name.length;
        continue;
      }
      out += name;
      i += name.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function parseObjects({ colors }: { colors: Map<string, string | null> }): ObjectData[] {
  const src = inc('objects.h');
  const objects: ObjectData[] = [];
  const seen = new Set<string>();

  scanDirectives(src, (code, macros) => {
    // 找到任意函数式宏调用，展开后查找生成的 OBJECT(...) 调用。
    let i = 0;
    while (i < code.length) {
      const m = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(code.slice(i));
      if (!m) break;
      const name = m[1];
      const at = i + m.index;
      const mac = macros.get(name);
      if (!mac || !mac.params) {
        i = at + name.length;
        continue;
      }
      if (TERMINAL.has(name) && name !== 'OBJECT') {
        i = at + name.length;
        continue;
      }
      const call = findCall(code, name, at);
      if (!call) break;
      i = call.end;

      // 把调用展开到 OBJECT(...) 一层。
      let expanded;
      if (name === 'OBJECT') {
        expanded = code.slice(at, call.end);
      } else {
        expanded = expandMacros(substituteParams(mac.body, mac.params, call.args), macros);
      }

      const objCall = findCall(expanded, 'OBJECT');
      if (!objCall || objCall.args.length < 15) continue;
      const [
        objArg,
        bitsArg,
        ,
        symArg,
        probArg,
        dlyArg,
        wtArg,
        costArg,
        sdamArg,
        ldamArg,
        oc1Arg,
        ,
        nutArg,
        colArg,
        snArg,
      ] = objCall.args;
      const objInner = findCall(objArg, 'OBJ');
      const objArgs = objInner ? objInner.args : splitTopLevel(objArg);
      const objName = firstString(objArgs[0] ?? '');
      const descRaw = (objArgs[1] ?? '').trim();
      if (!objName) continue;
      const sym = symArg.trim();
      const cls = (OBJ_CLASS as Record<string, ObjectData['cls'] | undefined>)[sym];
      if (!cls) continue; // ILLOBJ etc.
      const id = (snArg.match(/\b[A-Z][A-Z0-9_]*\b/) || [null])[0];
      if (!id || seen.has(id)) continue;
      if (id.startsWith('GENERIC_') || id === 'STRANGE_OBJECT') continue;
      seen.add(id);

      const bits = findCall(bitsArg, 'BITS');
      const b = bits ? bits.args : [];
      const colorHex =
        colors.get(idents(colArg, 'CLR_')[0]) ?? colors.get(idents(colArg, 'HI_')[0]) ?? '#aaaaaa';

      const item: LooseRecord = {
        id,
        name: objName,
        cls,
        kind: name,
        appr: descRaw === 'NoDes' ? null : firstString(descRaw),
        prob: evalNum(probArg) ?? 0,
        weight: evalNum(wtArg) ?? 0,
        cost: evalNum(costArg) ?? 0,
        material: b[12]?.trim() ?? '0',
        color: colorHex,
      };
      // WAN1 到 WAN3 等无名条目只用于补齐魔杖外观池，保留它们才能与
      // NetHack 的外观洗牌结果一致。
      if (!item.name) item.dummy = true;
      const wrapperParams = macros.get(name)?.params ?? [];
      if (wrapperParams.includes('chg')) {
        const chgIdx = wrapperParams.indexOf('chg');
        item.charges = (evalNum(call.args[chgIdx] ?? '0') ?? 0) !== 0;
      }

      // Class-specific fields.
      const prp = objCall.args[2];
      if (cls === 'weapon') {
        const small = /^\s*"/.test(sdamArg) ? firstString(sdamArg) : `1d${evalNum(sdamArg) ?? 2}`;
        const large = /^\s*"/.test(ldamArg) ? firstString(ldamArg) : `1d${evalNum(ldamArg) ?? 2}`;
        item.dmg = small;
        item.dmgLarge = large;
        item.hit = evalNum(oc1Arg) ?? 0;
        const sub = (b[11] ?? '').trim();
        if (/^-?P_[A-Z_]+$/.test(sub)) {
          if (sub.startsWith('-')) item.launcher = sub;
          else item.skill = sub;
        } else if (sub) {
          item.skill = sub;
        }
        item.wtype = (b[10] ?? '').trim() || null;
      } else if (cls === 'armor') {
        const wrapper = macros.get(name);
        item.slot = (ARMOR_SLOTS as Record<string, string>)[b[11]?.trim()] ?? 'suit';
        item.blocking = evalNum(b[8]) ?? 0;
        item.ac = wrapper?.params?.includes('ac')
          ? 10 - (evalNum(call.args[wrapper.params.indexOf('ac')]) ?? 10)
          : 10 - (evalNum(oc1Arg) ?? 10);
      } else if (cls === 'food') {
        item.nutrition = evalNum(nutArg) ?? 0;
        item.delay = evalNum(dlyArg) ?? 0;
        item.tin = b[11]?.trim() ?? null;
      } else if (cls === 'potion') {
        item.power = prp?.trim() ?? '0';
      } else if (cls === 'scroll') {
        item.label = firstString(objArgs[1] ?? '') ?? '';
      } else if (cls === 'wand') {
        item.dir = b[10]?.trim() ?? 'NODIR';
        item.charges = true;
      } else if (cls === 'ring') {
        item.power = prp?.trim() ?? '0';
        item.spec = evalNum(b[2]) ?? 0;
      } else if (cls === 'amulet') {
        item.power = prp?.trim() ?? '0';
      } else if (cls === 'spellbook') {
        item.spellClass = (b[11] ?? '').trim();
        item.level = evalNum(objCall.args[11]) ?? 1;
        item.dir = (b[10] ?? '').trim() || null;
      } else if (cls === 'gem' || cls === 'rock') {
        item.gval = evalNum(costArg) ?? 0;
        item.nutrition = evalNum(nutArg) ?? 0;
        const mohsIdx = wrapperParams.indexOf('mohs');
        item.mohs = mohsIdx >= 0 ? (evalNum(call.args[mohsIdx]) ?? 0) : 0;
        item.material = (b[12] ?? '').trim();
      } else if (cls === 'tool') {
        item.tool = name;
        item.container = /CONTAINER/.test(name);
        item.eyewear = /EYEWEAR/.test(name);
      }

      objects.push(item as unknown as ObjectData);
    }
  });
  return objects;
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function fmt(v: unknown, _indent = 2): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  return JSON.stringify(v);
}

function emit(name: string, items: object[], note: string, typeName: string) {
  const lines = items.map((it) => {
    const fields = Object.entries(it)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${fmt(v)}`)
      .join(', ');
    return `  { ${fields} },`;
  });
  return (
    `// 本文件由脚本生成，请勿手动修改。\n` +
    `// 来源：${note}\n` +
    `// 重新生成：bun tools/extract-nh-data.ts [NetHack 源码路径]\n` +
    `// 内容派生自 NetHack，按 NetHack General Public License 分发，见 NOTICE.md。\n\n` +
    `import type { ${typeName} } from '../types';\n\n` +
    `export const ${name}: ${typeName}[] = [\n${lines.join('\n')}\n];\n`
  );
}

// ---------------------------------------------------------------------------

/** 提取完成后提示参考版本漂移，避免生成结果静默过期。 */
function warnOnReferenceDrift(root: string): void {
  const recorded = loadRecordedReference();
  if (!recorded) return;
  const current = readReferenceState(root);
  const drift = compareReference(recorded, current);
  if (drift.upToDate) return;
  console.log('');
  console.log('注意：参考仓库相对记录已发生变化，生成结果可能过期');
  if (drift.changedFiles.length) console.log(`  变化文件：${drift.changedFiles.join('、')}`);
  if (drift.countDrift.length) console.log(`  条目变化：${drift.countDrift.join('；')}`);
  console.log('  重新记录版本：bun run sync:record');
  console.log('  查看差异：bun tools/sync-nethack.ts --full-diff');
}

function main() {
  if (!fs.existsSync(path.join(nhRoot, 'include', 'monsters.h'))) {
    console.error(`NetHack source not found at: ${nhRoot}`);
    console.error('Pass the path as an argument or set NETHACK_SRC.');
    process.exit(1);
  }

  const colors = parseColors();
  const symbols = parseSymbols();
  const monsters = parseMonsters({ colors, symbols });
  const objects = parseObjects({ colors });

  const byClass: Record<string, number> = {};
  for (const o of objects) byClass[o.cls] = (byClass[o.cls] || 0) + 1;

  console.log(`monsters: ${monsters.length}`);
  console.log(`objects:  ${objects.length}`, byClass);

  // Self-checks: faithful entries we can verify by name.
  const ant = monsters.find((m) => m.id === 'GIANT_ANT');
  const sword = objects.find((o) => o.id === 'LONG_SWORD');
  const plate = objects.find((o) => o.id === 'PLATE_MAIL');
  const heal = objects.find((o) => o.id === 'POT_HEALING');
  if (
    !ant ||
    ant.lvl !== 2 ||
    ant.ac !== 3 ||
    ant.attacks[0]?.at !== 'AT_BITE' ||
    ant.glyph !== 'a'
  ) {
    throw new Error(`self-check failed for giant ant: ${JSON.stringify(ant)}`);
  }
  const fireAnt = monsters.find((m) => m.id === 'FIRE_ANT');
  if (!fireAnt?.resists.includes('MR_FIRE') || !fireAnt.flags.includes('M1_ANIMAL')) {
    throw new Error(`self-check failed for fire ant: ${JSON.stringify(fireAnt)}`);
  }
  const fireball = objects.find((o) => o.id === 'SPE_FIREBALL');
  if (!fireball || fireball.level !== 4 || fireball.spellClass !== 'P_ATTACK_SPELL') {
    throw new Error(`self-check failed for spellbook of fireball: ${JSON.stringify(fireball)}`);
  }
  if (!sword || sword.dmg !== '1d8' || sword.dmgLarge !== '1d12') {
    throw new Error(`self-check failed for long sword: ${JSON.stringify(sword)}`);
  }
  if (!heal || heal.appr !== 'purple-red') {
    throw new Error(`self-check failed for potion of healing: ${JSON.stringify(heal)}`);
  }
  if (plate && (plate.slot !== 'suit' || plate.ac !== 7)) {
    throw new Error(`self-check failed for plate mail: ${JSON.stringify(plate)}`);
  }

  fs.writeFileSync(
    path.join(projectRoot, 'src', 'data', 'monsters.gen.ts'),
    emit('MONSTERS', monsters, 'nethack/include/monsters.h', 'MonsterData'),
  );
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'data', 'objects.gen.ts'),
    emit('OBJECTS', objects, 'nethack/include/objects.h', 'ObjectData'),
  );
  console.log('wrote src/data/monsters.gen.ts and src/data/objects.gen.ts');
  warnOnReferenceDrift(nhRoot);
}

main();
