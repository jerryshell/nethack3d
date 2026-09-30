/**
 * 会话消息的渲染：把消息变量里的实体 ID 解析成当前语言的可读名称。
 *
 * 放在单独模块里，HUD 与状态转储共用；切换语言后调用方重新渲染即可。
 */

import type { GameMessage, ItemDescription } from '../types';
import { t } from '../i18n/index';
import { monsterName, objectName } from '../data/index';
import { itemName } from './itemName';
import { roleDisplayName, raceDisplayName, alignDisplayName } from '../data/i18n';

/** 把消息变量里的实体 ID 解析成当前语言的可读名称。 */
function resolveVars(vars: GameMessage['vars']): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(vars ?? {})) {
    if (key === 'mon') out.mon = monsterName(value as string);
    else if (key === 'form') out.form = value ? monsterName(value as string) : '';
    else if (key === 'target') out.target = value ? monsterName(value as string) : '';
    else if (key === 'special') out.special = value ? t(`special.${value}`) : '';
    else if (key === 'branch') out.branch = value ? t(`branch.${value}`) : '';
    else if (key === 'shop') out.shop = value ? t(`shop.${value}`) : '';
    else if (key === 'artifact') out.artifact = value ? t(`artifact.${value}`) : '';
    else if (key === 'tip') out.tip = value ? t(value as string) : '';
    else if (key === 'item' && value && typeof value === 'object')
      out.item = itemName(value as ItemDescription);
    else if (key === 'obj') out.obj = value ? objectName(value as string) : '';
    else if (key === 'roleId') out.role = roleDisplayName(value as string);
    else if (key === 'raceId') out.race = raceDisplayName(value as string);
    else if (key === 'trap') out.trap = t(value as string);
    else if (key === 'res') out.res = value ? t(`resist.${value}`) : '';
    else if (key === 'align')
      out.align = alignDisplayName(value as Parameters<typeof alignDisplayName>[0]);
    else out[key] = value as string | number;
  }
  // 任务对白按职业取地名，调用方只需带上 roleId。
  if (typeof vars?.roleId === 'string') {
    out.home = t(`quest.${vars.roleId}.home`);
    out.goal = t(`quest.${vars.roleId}.goal`);
  }
  return out;
}

/** 渲染一条会话消息。 */
export function formatMessage(message: GameMessage): string {
  return t(message.key, resolveVars(message.vars));
}
