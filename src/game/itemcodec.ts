/**
 * 物品的存档编解码。
 *
 * 存档与骨头文件共用：把物品实例压成可 JSON 化的短字段，再还原回来。
 * 原型从数据表查回，其余可变状态逐个保存。
 */

import type { ItemInstance, SerializedItem } from '../types';
import { objById } from '../data/index';
import { nextItemId } from './items';

export function serializeItem(item: ItemInstance): SerializedItem {
  return {
    p: item.proto.id,
    q: item.quantity,
    e: item.enchant,
    b: item.buc,
    k: item.known ? 1 : 0,
    a: item.appearance,
    c: item.charges,
    g: item.gold ? 1 : 0,
    u: item.unpaid ? 1 : 0,
    ar: item.artifact,
    cp: item.corpse,
    ag: item.age,
    tn: item.tin,
    n: item.contents?.length ? item.contents.map(serializeItem) : undefined,
  };
}

export function deserializeItem(data: SerializedItem): ItemInstance | null {
  const proto = objById.get(data.p);
  if (!proto) return null;
  return {
    uid: nextItemId(),
    proto,
    id: proto.id,
    quantity: data.q ?? 1,
    enchant: data.e ?? 0,
    buc: (data.b === 'blessed' || data.b === 'cursed' ? data.b : 'uncursed') as ItemInstance['buc'],
    known: !!data.k,
    appearance: data.a ?? null,
    charges: data.c,
    gold: !!data.g,
    unpaid: !!data.u,
    artifact: data.ar,
    corpse: data.cp,
    age: data.ag,
    tin: data.tn,
    contents: data.n?.map(deserializeItem).filter((i): i is ItemInstance => i !== null),
  };
}
