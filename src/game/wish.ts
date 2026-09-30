/**
 * 许愿：把玩家输入的文字解析成物品或金币。
 *
 * 匹配顺序是内部 id、英文全名、中文名，最后是子串；支持「2 potions of healing」
 * 这样的数量前缀。匹配不到时返回 `none`，愿望不消耗，玩家可以再试。
 *
 * 索引在模块加载时构建一次，覆盖所有可随机生成的物品；任务神器与唯一物品
 * 不在其列，与原版的许愿限制一致。
 */

import type { ObjectClass, ObjectData, Rng } from '../types';
import { REAL_OBJECTS } from '../data/index';
import { OBJECTS_ZH } from '../data/i18n.zh';
import { NEVER_SPAWN } from './items';

/** 许愿结果。 */
type WishMatch =
  | { kind: 'item'; proto: ObjectData; quantity: number }
  | { kind: 'gold'; amount: number }
  | { kind: 'none'; query: string };

/** 许愿可以得到的物品：可随机生成，且不属于唯一物品。 */
const WISHABLE = REAL_OBJECTS.filter(
  (o) => o.prob > 0 && o.cls !== 'coin' && !NEVER_SPAWN.has(o.id),
);

/** 需要补类别前缀的类别，与原版「potion of healing」的叫法一致。 */
const CLASS_PREFIX: Partial<Record<ObjectClass, string>> = {
  potion: 'potion of',
  scroll: 'scroll of',
  spellbook: 'spellbook of',
  wand: 'wand of',
  ring: 'ring of',
};

/** 物品的英文全名，例如「potion of healing」。 */
function wishFullName(proto: ObjectData): string {
  const prefix = CLASS_PREFIX[proto.cls];
  return prefix ? `${prefix} ${proto.name}` : proto.name;
}

/** 归一化：转小写，把非字母数字汉字压成空格。 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();
}

/** 去掉常见的复数后缀，用于「2 potions of healing」这类输入。 */
function singular(text: string): string {
  return text.replace(/\b([a-z]{3,}?)s\b/g, '$1');
}

/** 名称索引：归一化名称到原型；同名时保留先登记的类别。 */
const NAME_INDEX = new Map<string, ObjectData>();
for (const proto of WISHABLE) {
  const names = [proto.id, proto.name, wishFullName(proto), OBJECTS_ZH[proto.id] ?? ''];
  for (const name of names) {
    const key = normalize(name);
    if (key && !NAME_INDEX.has(key)) NAME_INDEX.set(key, proto);
  }
}

/** 子串匹配：查询长度足够时，取第一个名字包含它的物品。 */
function findBySubstring(query: string): ObjectData | null {
  if (query.length < 3) return null;
  return (
    WISHABLE.find((proto) =>
      [proto.name, wishFullName(proto), OBJECTS_ZH[proto.id] ?? ''].some((name) =>
        normalize(name).includes(query),
      ),
    ) ?? null
  );
}

/** 解析一次愿望。 */
export function resolveWish(rng: Rng, text: string): WishMatch {
  const raw = String(text ?? '').trim();
  if (!raw) return { kind: 'none', query: raw };
  const qtyMatch = raw.match(/^(\d+)\s+(.*)$/);
  const quantity = qtyMatch ? Math.max(1, Math.min(10, Number(qtyMatch[1]))) : 1;
  const phrase = qtyMatch ? qtyMatch[2] : raw;
  const norm = normalize(phrase);

  if (norm === 'gold' || norm === 'money' || norm === '金币') {
    return { kind: 'gold', amount: 100 + rng.rn2(400) };
  }
  const proto =
    NAME_INDEX.get(norm) ??
    NAME_INDEX.get(singular(norm)) ??
    findBySubstring(norm) ??
    (norm !== singular(norm) ? findBySubstring(singular(norm)) : null);
  if (!proto) return { kind: 'none', query: raw };
  return { kind: 'item', proto, quantity };
}
