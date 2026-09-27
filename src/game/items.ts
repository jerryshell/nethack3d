/**
 * 物品：实例、关卡生成、鉴定与显示名称。
 *
 * 这里实现的 NetHack 规则：
 *
 * - 物品类别按 mkobjprobs 权重生成（源码 src/mkobj.c）。
 * - 每局开始时洗牌未鉴定外观（源码 src/o_init.c 的 shuffle_all()）。
 * - 未鉴定的药水、卷轴、魔杖、戒指、护身符、法术书、宝石显示随机外观，
 *   而不是真实名称。
 * - BUC（受祝福、未诅咒、被诅咒）在鉴定前不可见。
 */

import type {
  GroundPile,
  ItemDescription,
  ItemInstance,
  Level,
  ObjectClass,
  ObjectData,
  Rng,
} from '../types';
import { createLogger, LOG_NS } from '../core/log';
import { MKOBJ_PROBS } from '../core/constants';
import { REAL_OBJECTS, objById, shuffleAppearances } from '../data/index';
import { index } from './dungeon';
import { T } from '../core/constants';

const log = createLogger(LOG_NS.items);

let itemIdCounter = 1;

/** 分配全局唯一的物品 ID，读档恢复时也会使用。 */
export function nextItemId() {
  return itemIdCounter++;
}

/** 类别名在鉴定前置为不可见的物品类别。 */
export const UNKNOWN_CLASSES = new Set([
  'potion',
  'scroll',
  'wand',
  'ring',
  'amulet',
  'spellbook',
  'gem',
]);

/** 可随机出现的物品：生成概率大于 0，且不是占位条目或唯一任务物品。 */
const SPAWNABLE = REAL_OBJECTS.filter((o) => o.prob > 0 && o.cls !== 'coin');

const NEVER_SPAWN = new Set([
  'AMULET_OF_YENDOR',
  'FAKE_AMULET_OF_YENDOR',
  'BELL_OF_OPENING',
  'CANDELABRUM_OF_INVOCATION',
  'BOOK_OF_THE_DEAD',
  'NOVEL',
]);

function pickObjectType(rng: Rng, cls: ObjectClass): ObjectData | null {
  const pool = SPAWNABLE.filter((o) => o.cls === cls && !NEVER_SPAWN.has(o.id));
  return rng.pickWeighted(pool, 'prob') ?? null;
}

/** 依据原型创建一个新的物品实例。 */
export function makeItem(
  proto: ObjectData,
  rng: Rng,
  { appearance = null, quantity = 1 }: { appearance?: string | null; quantity?: number } = {},
): ItemInstance {
  const item: ItemInstance = {
    uid: nextItemId(),
    proto,
    id: proto.id,
    quantity,
    enchant: 0,
    known: !UNKNOWN_CLASSES.has(proto.cls),
    buc: rng.rn2(10) === 0 ? 'cursed' : 'uncursed',
    appearance,
    charges: proto.charges ? rng.rn1(4, 4) : undefined,
  };
  return item;
}

/** 随机抽取类别与物品，权重与 NetHack 的 mkobj 一致。 */
export function randomItem(
  rng: Rng,
  depth: number,
  appearanceMap?: Map<string, string>,
): ItemInstance | null {
  const cls = rng.pickWeighted(
    MKOBJ_PROBS.map(([id, prob]) => ({ id, prob })),
    'prob',
  )?.id;
  if (!cls) return null;
  const proto = pickObjectType(rng, cls);
  if (!proto) return null;
  const appearance = appearanceMap?.get(proto.id) ?? proto.appr ?? null;
  return makeItem(proto, rng, { appearance });
}

/** 一堆金币。 */
export function makeGold(rng: Rng, depth: number, amount: number | null = null): ItemInstance {
  const value = amount ?? rng.rn2(depth * 20 + 1) + 5;
  const proto = objById.get('GOLD_PIECE') as ObjectData;
  return {
    uid: nextItemId(),
    proto,
    id: 'GOLD_PIECE',
    quantity: Math.max(1, value),
    gold: true,
    known: true,
    buc: 'uncursed',
    enchant: 0,
    appearance: null,
  };
}

/**
 * 为关卡生成地面物品，按「{ x, y, items: [...] }」的形式写入 `level.objects`。
 */
export function spawnObjects(
  level: Level,
  rng: Rng,
  depth: number,
  appearanceMap?: Map<string, string>,
): GroundPile[] {
  const done = log.time(`第 ${depth} 层生成地面物品`);
  const floorTiles: { x: number; y: number }[] = [];
  for (let x = 1; x < level.width - 1; x++) {
    for (let y = 1; y < level.height - 1; y++) {
      const t = level.tiles[index(x, y)];
      if (t === T.ROOM || t === T.CORR) floorTiles.push({ x, y });
    }
  }
  rng.shuffle(floorTiles);

  const count = 4 + rng.rn2(5) + Math.floor(depth / 2);
  const put = (item: ItemInstance, spot: { x: number; y: number }): void => {
    const existing = level.objects.find((o) => o.x === spot.x && o.y === spot.y);
    if (existing) existing.items.push(item);
    else level.objects.push({ x: spot.x, y: spot.y, items: [item] });
  };

  for (let i = 0; i < count && floorTiles.length; i++) {
    const spot = floorTiles.pop() as { x: number; y: number };
    const item = randomItem(rng, depth, appearanceMap);
    if (item) put(item, spot);
  }
  // 额外的金币堆。
  const goldPiles = 2 + rng.rn2(4);
  for (let i = 0; i < goldPiles && floorTiles.length; i++) {
    put(makeGold(rng, depth), floorTiles.pop() as { x: number; y: number });
  }
  done({ piles: level.objects.length, candidates: count + goldPiles });
  return level.objects;
}

// ---------------------------------------------------------------------------
// 鉴定与命名
// ---------------------------------------------------------------------------

/** 本局的外观描述池，每局只创建一次。 */
export function createAppearanceMap(rng: Rng): Map<string, string> {
  const map = shuffleAppearances(rng);
  log.debug('未鉴定外观洗牌完成', { entries: map.size });
  return map;
}

/** 把某类物品标记为已鉴定。 */
export function identifyItem(item: ItemInstance): ItemInstance {
  item.known = true;
  return item;
}

export function identifiedName(item: ItemInstance): string {
  return item.proto.name;
}

/**
 * 生成可翻译的物品描述：{ qty, key, vars }。
 *
 * `vars` 中可能包含界面需要解析的实体 ID（name 为物品名、apprId 为外观词）。
 * 未鉴定卷轴的 vars.label 保存卷轴上的魔法词。
 */
export function describeItem(item: ItemInstance): ItemDescription {
  const proto = item.proto;
  const cls = proto.cls;
  if (item.gold || cls === 'coin') {
    return { qty: item.quantity, key: 'item.gold', vars: { n: item.quantity } };
  }
  if (item.known) {
    return {
      qty: item.quantity,
      key: `item.known.${cls}`,
      vars: { name: proto.id, nameText: proto.name, cls },
    };
  }
  const appr = item.appearance ?? proto.appr ?? '';
  if (cls === 'scroll') {
    return {
      qty: item.quantity,
      key: 'item.unknown.scroll',
      vars: { label: proto.label ?? '' },
    };
  }
  return {
    qty: item.quantity,
    key: `item.unknown.${cls}`,
    vars: { apprId: appr, apprText: appr },
  };
}

/** 类别的短标签键，供界面显示。 */
export function classLabelKey(proto: ObjectData): string {
  return `item.class.${proto.cls}`;
}
