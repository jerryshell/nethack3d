#!/usr/bin/env bun
/**
 * 职业与种族提取脚本：解析参考源码的 src/role.c，生成 src/data/roles.gen.ts。
 *
 * 输出包含 13 个职业与 5 个可选种族：允许的阵营与种族、属性基准、
 * 生命与法力成长曲线、施法相关参数。
 *
 * 用法：bun tools/extract-nh-roles.ts [NetHack 源码路径]
 */

import type { Alignment, Attributes, RaceData, RoleAdvance, RoleData } from '../src/types';
import fs from 'node:fs';
import path from 'node:path';
import { compareReference, loadRecordedReference, readReferenceState } from './nethack-ref';

const projectRoot = path.resolve(import.meta.dir, '..');
const nhRoot = path.resolve(
  process.argv[2] || process.env.NETHACK_SRC || path.join(projectRoot, '..', 'nethack'),
);

const CONSTANTS: Record<string, number> = {
  AM_CHAOTIC: 0x01,
  AM_NEUTRAL: 0x02,
  AM_LAWFUL: 0x04,
  ROLE_CHAOTIC: 0x01,
  ROLE_NEUTRAL: 0x02,
  ROLE_LAWFUL: 0x04,
  ROLE_MALE: 0x1000,
  ROLE_FEMALE: 0x2000,
  ROLE_NEUTER: 0x4000,
  MH_HUMAN: 0x00000008,
  MH_ELF: 0x00000010,
  MH_DWARF: 0x00000020,
  MH_GNOME: 0x00000040,
  MH_ORC: 0x00000080,
  NON_PM: -1,
};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

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
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  const tail = s.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/** 取出 `marker` 之后的 `{...}` 初始化块内容。 */
function extractArrayBody(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(open + 1, i);
}

/** 把大括号包裹的数组体切成顶层条目。 */
function splitEntries(body: string): string[] {
  return splitTopLevel(body).filter((e) => e.startsWith('{'));
}

const groupValues = (group: string): string[] =>
  splitTopLevel(group.replace(/^\s*\{/, '').replace(/\}\s*$/, '')).map((v) => v.trim());

const num = (expr: string | number): number => {
  const e = String(expr).replace(/\bSTR18\((\d+)\)/g, '18');
  if (/^-?\d+$/.test(e.trim())) return Number(e.trim());
  return 0;
};

function evalMask(expr: string): number {
  const tokens = String(expr)
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);
  let mask = 0;
  for (const t of tokens) {
    if (t in CONSTANTS) mask |= CONSTANTS[t];
  }
  return mask;
}

const ALIGN_BY_BIT: [number, string][] = [
  [0x04, 'lawful'],
  [0x02, 'neutral'],
  [0x01, 'chaotic'],
];
const RACE_BY_BIT: [number, string][] = [
  [0x08, 'HUMAN'],
  [0x10, 'ELF'],
  [0x20, 'DWARF'],
  [0x40, 'GNOME'],
  [0x80, 'ORC'],
];

function parseAttrs(group: string): Attributes {
  const v = groupValues(group).map(num);
  return { str: v[0], int: v[1], wis: v[2], dex: v[3], con: v[4], cha: v[5] };
}

function parseAdvance(group: string): RoleAdvance {
  const [infix, inrnd, lofix, lornd, hifix, hirnd] = groupValues(group).map(num);
  return { infix, inrnd, lofix, lornd, hifix, hirnd };
}

function parseRoles(
  src: string,
): (Omit<RoleData, 'aligns' | 'races' | 'genders'> & Partial<RoleData>)[] {
  const body = extractArrayBody(src, 'const struct Role roles[');
  const roles: (Omit<RoleData, 'aligns' | 'races' | 'genders'> & Partial<RoleData>)[] = [];
  for (const entry of splitEntries(body)) {
    const items = splitTopLevel(entry.replace(/^\s*\{/, '').replace(/\}\s*$/, ''));
    const name = groupValues(items[0]);
    const idField = items.find((i) => /^PM_[A-Z_]+$/.test(i.trim()));
    if (!idField) continue;
    // attrbase 是第一个「六个数字」的组。
    const attrsAt = items.findIndex(
      (i) =>
        i.startsWith('{') &&
        groupValues(i).length === 6 &&
        groupValues(i).every((v) => /^\d+$/.test(v)),
    );
    const groups = items.slice(attrsAt).filter((i) => i.startsWith('{'));
    const tail = items.slice(attrsAt + 4).map((t) => t.replace(/\/\*[\s\S]*$/, '').trim());
    roles.push({
      id: idField.trim().replace(/^PM_/, ''),
      names: {
        male: name[0]?.replace(/"/g, '') ?? '',
        female: (name[1] ?? '0').replace(/"/g, '') || null,
      },
      attrs: parseAttrs(groups[0]),
      attrdist: parseAttrs(groups[1]),
      hp: parseAdvance(groups[2]),
      energy: parseAdvance(groups[3]),
      xlev: num(tail[0]),
      initRecord: num(tail[1]),
      spell: {
        base: num(tail[2]),
        heal: num(tail[3]),
        shield: num(tail[4]),
        armor: num(tail[5]),
        stat: (tail[6] ?? '').trim().replace(/^A_/, '').toLowerCase(),
        spec: (tail[7] ?? '').trim(),
        bonus: num(tail[8]),
      },
      allowMask: evalMask(items[attrsAt - 1] ?? ''),
    });
  }
  return roles;
}

function parseRaces(src: string): (Omit<RaceData, 'aligns'> & Partial<RaceData>)[] {
  const body = extractArrayBody(src, 'const struct Race races[');
  const races: (Omit<RaceData, 'aligns'> & Partial<RaceData>)[] = [];
  for (const entry of splitEntries(body)) {
    const items = splitTopLevel(entry.replace(/^\s*\{/, '').replace(/\}\s*$/, ''));
    const noun = items[0].replace(/"/g, '');
    const adj = items[1].replace(/"/g, '');
    const filecode = items[3].replace(/"/g, '');
    const individual = groupValues(items[4]).map((s) => s.replace(/"/g, ''));
    const idField = items.find(
      (i) => /^PM_[A-Z_]+$/.test(i.trim()) && !i.includes('MUMMY') && !i.includes('ZOMBIE'),
    );
    const groups = items
      .slice(
        items.findIndex(
          (i) =>
            i.startsWith('{') &&
            groupValues(i).length === 6 &&
            groupValues(i).every((v) => /^\d+$/.test(v)),
        ),
      )
      .filter((i) => i.startsWith('{'));
    const allowIdx = items.findIndex((i) => i.includes('MH_') || i.includes('ROLE_'));
    races.push({
      id: (idField ?? 'PM_HUMAN').trim().replace(/^PM_/, ''),
      name: noun,
      adj,
      filecode,
      names: { male: individual[0] || noun, female: individual[1] || noun },
      attrs: parseAttrs(groups[0]),
      attrmax: parseAttrs(groups[1]),
      hp: parseAdvance(groups[2]),
      energy: parseAdvance(groups[3]),
      allowMask: evalMask(items[allowIdx] ?? ''),
    });
  }
  return races;
}

function decodeMasks(
  roles: (Omit<RoleData, 'aligns' | 'races' | 'genders'> & Partial<RoleData>)[],
  races: (Omit<RaceData, 'aligns'> & Partial<RaceData>)[],
): { roles: RoleData[]; races: RaceData[] } {
  for (const r of roles) {
    r.aligns = ALIGN_BY_BIT.filter(([bit]) => (r.allowMask as number) & bit).map(
      ([, n]) => n as Alignment,
    );
    r.races = RACE_BY_BIT.filter(([bit]) => (r.allowMask as number) & bit).map(([, n]) => n);
    r.genders = [];
    if (r.allowMask & CONSTANTS.ROLE_MALE) r.genders.push('male');
    if (r.allowMask & CONSTANTS.ROLE_FEMALE) r.genders.push('female');
  }
  for (const r of races) {
    r.aligns = ALIGN_BY_BIT.filter(([bit]) => (r.allowMask as number) & bit).map(
      ([, n]) => n as Alignment,
    );
  }
  return { roles: roles as RoleData[], races: races as RaceData[] };
}

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

function main(): void {
  const src = stripComments(fs.readFileSync(path.join(nhRoot, 'src', 'role.c'), 'utf8'));
  const roles = parseRoles(src);
  const races = parseRaces(src);
  decodeMasks(roles, races);

  if (roles.length !== 13) throw new Error(`expected 13 roles, got ${roles.length}`);
  if (races.length !== 5) throw new Error(`expected 5 races, got ${races.length}`);
  const val = roles.find((r) => r.id === 'VALKYRIE');
  if (
    !val ||
    val.names.male !== 'Valkyrie' ||
    val.hp.infix !== 14 ||
    !(val.races ?? []).includes('DWARF')
  ) {
    throw new Error(`self-check failed for Valkyrie: ${JSON.stringify(val)}`);
  }
  const wiz = roles.find((r) => r.id === 'WIZARD');
  if (!wiz || wiz.spell.stat !== 'int' || wiz.energy.infix < 2) {
    throw new Error(`self-check failed for Wizard: ${JSON.stringify(wiz)}`);
  }
  const humans = races.filter((r) => (r.aligns ?? []).length === 3);
  if (humans.length < 1) throw new Error('no race with all three alignments');
  const valRaces: string[] = roles.find((r) => r.id === 'VALKYRIE')?.races ?? [];
  if (!valRaces.includes('DWARF')) throw new Error(`Valkyrie races look wrong: ${valRaces}`);

  const emit = (name: string, items: unknown[], typeName: string) =>
    `// 本文件由脚本生成，请勿手动修改。\n` +
    `// 来源：nethack/src/role.c\n` +
    `// 重新生成：bun tools/extract-nh-roles.ts [NetHack 源码路径]\n` +
    `// 内容派生自 NetHack，按 NetHack General Public License 分发，见 NOTICE.md。\n\n` +
    `import type { ${typeName} } from '../types';\n\n` +
    `export const ${name}: ${typeName}[] = ${JSON.stringify(items, null, 2)};\n`;

  fs.writeFileSync(
    path.join(projectRoot, 'src', 'data', 'roles.gen.ts'),
    emit('ROLES', roles, 'RoleData') + '\n' + emit('RACES', races, 'RaceData'),
  );
  console.log(`roles: ${roles.length}, races: ${races.length}`);
  for (const r of roles) {
    console.log(
      `  ${r.id.padEnd(12)} attr=${r.attrs.str}/${r.attrs.int}/${r.attrs.wis}/${r.attrs.dex}/${r.attrs.con}/${r.attrs.cha} hp=${r.hp.infix} pw=${r.energy.infix} align=${(r.aligns ?? []).join('/')} races=${(r.races ?? []).join('/')}`,
    );
  }
  warnOnReferenceDrift(nhRoot);
}

main();
