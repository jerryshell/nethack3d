/**
 * 游戏数据的多语言名称查询：怪物、物品、职业、种族、外观词。
 *
 * UI 文案由 i18n 运行时负责；本模块只处理实体名称，
 * 并在语言切换时同步更新查找表。
 */

import type { LocaleId } from '../i18n/index';
import type { Alignment, RaceData, RoleData } from '../types';
import { onLocaleChange, getLocale, t } from '../i18n/index';
import { setNameOverrides } from './index';
import { MONSTERS_ZH, OBJECTS_ZH, SPELLS_ZH, ROLES_ZH, RACES_ZH, APPEARANCES_ZH } from './i18n.zh';
import { ROLES, RACES } from './roles.gen';

type NameMap = Record<string, string>;

const roleById: Record<string, RoleData> = Object.fromEntries(ROLES.map((r) => [r.id, r]));
const raceById: Record<string, RaceData> = Object.fromEntries(RACES.map((r) => [r.id, r]));

let currentRoleMap: NameMap | null = null;
let currentRaceMap: NameMap | null = null;
let currentAppearanceMap: NameMap | null = null;

export function applyDataTranslations(locale: LocaleId): void {
  if (locale === 'zh-CN') {
    setNameOverrides({ monsters: MONSTERS_ZH, objects: { ...OBJECTS_ZH, ...SPELLS_ZH } });
    currentRoleMap = ROLES_ZH;
    currentRaceMap = RACES_ZH;
    currentAppearanceMap = APPEARANCES_ZH;
  } else {
    setNameOverrides({ monsters: {}, objects: {} });
    currentRoleMap = null;
    currentRaceMap = null;
    currentAppearanceMap = null;
  }
}

export function roleDisplayName(roleOrId: string | RoleData): string {
  const id = typeof roleOrId === 'string' ? roleOrId : roleOrId?.id;
  if (currentRoleMap?.[id]) return currentRoleMap[id];
  const role = typeof roleOrId === 'string' ? roleById[id] : roleOrId;
  return role?.names?.male ?? id;
}

export function raceDisplayName(raceOrId: string | RaceData): string {
  const id = typeof raceOrId === 'string' ? raceOrId : raceOrId?.id;
  if (currentRaceMap?.[id]) return currentRaceMap[id];
  const race = typeof raceOrId === 'string' ? raceById[id] : raceOrId;
  return race?.name ?? id;
}

export function alignDisplayName(align: Alignment): string {
  return t(`align.${align}`);
}

/**
 * 外观词（ruby、glass 等）在当前语言下的写法。
 * 中文例如红宝石色、玻璃；英文直接返回原词。
 */
export function appearanceName(word: string): string {
  return currentAppearanceMap?.[word] ?? word;
}

applyDataTranslations(getLocale());
onLocaleChange(applyDataTranslations);
