/**
 * 把 describeItem() 返回的 { qty, key, vars } 渲染成当前语言的字符串。
 * 消息日志与背包面板共用。
 */

import type { ItemDescription, ItemInstance } from '../types';
import { t } from '../i18n/index';
import { monsterName, objectName } from '../data/index';
import { appearanceName } from '../data/i18n';

function resolveItemVars(vars: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(vars ?? {})) {
    if (key === 'name') out.name = objectName(value as string);
    else if (key === 'mon') out.mon = monsterName(value as string);
    else if (key === 'artifact') out.name = t(`artifact.${value}`);
    else if (key === 'apprId') out.appr = appearanceName(value as string);
    else out[key] = String(value);
  }
  return out;
}

/** 物品描述在当前语言下的显示名。 */
export function itemName(desc: ItemDescription | null | undefined): string {
  if (!desc) return '';
  if (desc.key === 'item.gold') return t('item.gold', { n: desc.vars?.n ?? desc.qty ?? 1 });
  const text = t(desc.key, resolveItemVars(desc.vars));
  if (desc.qty > 1) return t('item.stack', { n: desc.qty, item: text });
  return text;
}

/** 背包界面使用的后缀，描述装备、附魔与充能状态。 */
export function itemSuffix(
  item: ItemInstance,
  { equipped = null }: { equipped?: string | null } = {},
): string {
  const bits: string[] = [];
  if (equipped) bits.push(t('item.equipped'));
  if (item.enchant > 0) bits.push(t('item.enchant', { n: item.enchant }));
  if (item.charges !== undefined && item.known) bits.push(t('item.charges', { n: item.charges }));
  if (item.known && item.buc === 'cursed') bits.push(t('item.cursed'));
  if (item.known && item.buc === 'blessed') bits.push(t('item.blessed'));
  return bits.length ? ` (${bits.join(', ')})` : '';
}
