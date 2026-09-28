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
import { inRoom, index, shopRoom } from './dungeon';
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

export const NEVER_SPAWN = new Set([
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
// 商店
// ---------------------------------------------------------------------------

/** 商店进货的类别权重：以武器、护甲、药水、卷轴为主。 */
const SHOP_CLASS_PROBS: [ObjectClass, number][] = [
  ['weapon', 12],
  ['armor', 12],
  ['potion', 16],
  ['scroll', 14],
  ['wand', 6],
  ['ring', 4],
  ['amulet', 2],
  ['tool', 8],
  ['food', 8],
  ['gem', 4],
];

/**
 * 商店售价：基础价加利润，利润随魅力变化（魅力越高越低）。
 * 默认魅力 10 时就是基础价加三分之一。
 */
export function shopBuyPrice(item: ItemInstance, cha = 10): number {
  const markup = Math.max(0.1, Math.min(1, 1 / 3 + (10 - cha) * 0.02));
  return Math.max(1, Math.ceil((item.proto.cost || 0) * item.quantity * (1 + markup)));
}

/** 商店收购价：基础价一半，魅力高时卖得更贵，最低 1 枚金币。 */
export function shopSellPrice(item: ItemInstance, cha = 10): number {
  const rate = Math.max(0.2, Math.min(0.9, 0.5 + (cha - 10) * 0.02));
  return Math.max(1, Math.floor((item.proto.cost || 0) * item.quantity * rate));
}

export function randomShopItem(
  rng: Rng,
  depth: number,
  appearanceMap?: Map<string, string>,
): ItemInstance | null {
  const cls = rng.pickWeighted(
    SHOP_CLASS_PROBS.map(([id, prob]) => ({ id, prob })),
    'prob',
  )?.id;
  if (!cls) return null;
  const proto = pickObjectType(rng, cls);
  if (!proto) return null;
  const appearance = appearanceMap?.get(proto.id) ?? proto.appr ?? null;
  return makeItem(proto, rng, { appearance });
}

/**
 * 给商店房间铺货。
 *
 * 房间内已生成的物品与金币都算店主的：金币收进钱箱，物品标记为未付款。
 * 新货物撒在空地上，已存在物品堆的格子也会追加，重复利用同一批栈。
 * 返回新增的货物数量。
 */
export function stockShop(
  level: Level,
  rng: Rng,
  depth: number,
  appearanceMap?: Map<string, string>,
): number {
  const room = shopRoom(level);
  if (!room) return 0;
  for (const pile of level.objects) {
    if (!inRoom(room, pile.x, pile.y)) continue;
    pile.items = pile.items.filter((item) => !item.gold);
    for (const item of pile.items) item.unpaid = true;
  }
  // 只装金币的堆清空后不能留下空堆，不变量要求每堆至少一件物品。
  level.objects = level.objects.filter((pile) => pile.items.length > 0);

  const spots: { x: number; y: number }[] = [];
  for (let x = room.lx; x <= room.hx; x++) {
    for (let y = room.ly; y <= room.hy; y++) {
      if (level.tiles[index(x, y)] === T.ROOM) spots.push({ x, y });
    }
  }
  rng.shuffle(spots);
  const target = Math.min(spots.length, 8 + rng.rn2(6) + Math.floor(depth / 4));
  let placed = 0;
  for (const spot of spots) {
    if (placed >= target) break;
    const item = randomShopItem(rng, depth, appearanceMap);
    if (!item) continue;
    item.unpaid = true;
    const existing = level.objects.find((o) => o.x === spot.x && o.y === spot.y);
    if (existing) existing.items.push(item);
    else level.objects.push({ x: spot.x, y: spot.y, items: [item] });
    placed++;
  }
  log.debug('商店铺货完成', { depth, room: room.index, placed, target });
  return placed;
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
  // 职业神器有专属名字，与基础原型无关。
  if (item.artifact) {
    return { qty: item.quantity, key: 'item.artifact', vars: { artifact: item.artifact } };
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
