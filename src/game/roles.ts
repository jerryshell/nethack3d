/**
 * 职业与种族的辅助逻辑，数据来自 src/data/roles.gen.ts。
 *
 * 包含初始属性点数分配、随机角色选择，以及简化的初始装备。
 * 初始装备参照 u_init.c 的标志性物品，暂不包含随机工具与宠物。
 */

import type {
  Attributes,
  CharacterChoice,
  EquipIntent,
  ItemInstance,
  RaceData,
  RoleData,
  Rng,
} from '../types';
import { ROLES, RACES } from '../data/roles.gen';
import { objById } from '../data/index';
import { makeItem } from './items';

export { ROLES, RACES };

export const roleById: Record<string, RoleData> = Object.fromEntries(ROLES.map((r) => [r.id, r]));
export const raceById: Record<string, RaceData> = Object.fromEntries(RACES.map((r) => [r.id, r]));

export const ALIGNMENTS = [
  { id: 'lawful', key: 'align.lawful', value: 1 },
  { id: 'neutral', key: 'align.neutral', value: 0 },
  { id: 'chaotic', key: 'align.chaotic', value: -1 },
];

const ATTR_KEYS: (keyof Attributes)[] = ['str', 'int', 'wis', 'dex', 'con', 'cha'];

/**
 * 初始属性分配，对应 NetHack 的 init_attr(75) 与 init_attr_role_redist：
 * 以职业与种族的基准值为起点，剩余点数按职业的 attrdist 权重随机投放。
 */
export function rollAttributes(role: RoleData, race: RaceData, rng: Rng): Attributes {
  const attrs = {} as Attributes;
  let budget = 75;
  for (const key of ATTR_KEYS) {
    attrs[key] = Math.max(3, role.attrs[key] + race.attrs[key]);
    // NetHack 在职业基准值之上给出 75 点预算；这里把种族基准也计入，
    // 使初始属性落在原版的常见区间，而不是全部拉满。
    budget -= role.attrs[key] + race.attrs[key];
  }
  let guard = 0;
  while (budget > 0 && guard++ < 1000) {
    const candidates: { k: keyof Attributes; w: number }[] = ATTR_KEYS.filter(
      (k) => attrs[k] < (race.attrmax[k] || 18),
    ).map((k) => ({ k, w: Math.max(1, role.attrdist[k]) }));
    if (!candidates.length) break;
    const choice = rng.pickWeighted(candidates, 'w') as { k: keyof Attributes; w: number };
    attrs[choice.k]++;
    budget--;
  }
  return attrs;
}

/** 由 NetHack 位掩码允许的全部「职业 + 种族 + 阵营」组合。 */
export function validCombinations(): CharacterChoice[] {
  const out: CharacterChoice[] = [];
  for (const role of ROLES) {
    for (const raceId of role.races) {
      const race = raceById[raceId];
      if (!race) continue;
      const aligns = role.aligns.filter((a) => race.aligns.includes(a));
      for (const align of aligns) {
        for (const gender of role.genders.length ? role.genders : (['female', 'male'] as const)) {
          out.push({ role, race, align, gender });
        }
      }
    }
  }
  return out;
}

/** 随机生成一个可玩角色，对应原版的随机角色选项。 */
export function randomCharacter(rng: Rng): CharacterChoice {
  const combo = rng.pick(validCombinations()) as CharacterChoice;
  return combo;
}

/**
 * 简化的初始装备表，按职业 ID 索引。每项为「物品 ID + 装备方式」，
 * 装备方式取 wield、wear、offhand 或 null。
 */
const STARTING_KITS: Record<string, [string, EquipIntent][]> = {
  ARCHEOLOGIST: [
    ['BULLWHIP', 'wield'],
    ['LEATHER_JACKET', 'wear'],
    ['FOOD_RATION', null],
    ['PICK_AXE', null],
  ],
  BARBARIAN: [
    ['BATTLE_AXE', 'wield'],
    ['RING_MAIL', 'wear'],
    ['FOOD_RATION', null],
  ],
  CAVE_DWELLER: [
    ['CLUB', 'wield'],
    ['LEATHER_ARMOR', 'wear'],
    ['FOOD_RATION', null],
  ],
  HEALER: [
    ['SCALPEL', 'wield'],
    ['LEATHER_GLOVES', 'wear'],
    ['STETHOSCOPE', null],
    ['POT_HEALING', null],
    ['APPLE', null],
  ],
  KNIGHT: [
    ['LONG_SWORD', 'wield'],
    ['SMALL_SHIELD', 'offhand'],
    ['RING_MAIL', 'wear'],
    ['LANCE', null],
    ['FOOD_RATION', null],
  ],
  MONK: [
    ['ROBE', 'wear'],
    ['APPLE', null],
    ['APPLE', null],
  ],
  CLERIC: [
    ['MACE', 'wield'],
    ['ROBE', 'wear'],
    ['POT_HEALING', null],
  ],
  ROGUE: [
    ['SHORT_SWORD', 'wield'],
    ['LEATHER_ARMOR', 'wear'],
    ['DAGGER', null],
    ['DAGGER', null],
    ['LOCK_PICK', null],
  ],
  RANGER: [
    ['BOW', 'wield'],
    ['LEATHER_ARMOR', 'wear'],
    ['ARROW', null],
    ['ARROW', null],
    ['DAGGER', null],
  ],
  SAMURAI: [
    ['KATANA', 'wield'],
    ['SHORT_SWORD', 'offhand'],
    ['SPLINT_MAIL', 'wear'],
    ['FOOD_RATION', null],
  ],
  TOURIST: [
    ['DART', 'wield'],
    ['HAWAIIAN_SHIRT', 'wear'],
    ['EXPENSIVE_CAMERA', null],
    ['CREDIT_CARD', null],
    ['FOOD_RATION', null],
  ],
  VALKYRIE: [
    ['LONG_SWORD', 'wield'],
    ['SMALL_SHIELD', 'offhand'],
    ['FOOD_RATION', null],
  ],
  WIZARD: [
    ['QUARTERSTAFF', 'wield'],
    ['CLOAK_OF_PROTECTION', 'wear'],
    ['SPE_FORCE_BOLT', null],
    ['POT_HEALING', null],
  ],
};

/** 预览初始装备时使用的占位随机源。 */
const FALLBACK_RNG = { rn1: (): number => 5, rn2: (): number => 0 } as unknown as Rng;

/** 把初始装备表实例化为物品对象（初始装备一律为未诅咒）。 */
export function buildStartingKit(roleId: string, rng?: Rng): ItemInstance[] {
  const kit = STARTING_KITS[roleId] ?? STARTING_KITS.VALKYRIE;
  const items: ItemInstance[] = [];
  for (const [objId, equip] of kit) {
    const proto = objById.get(objId);
    if (!proto) continue;
    // 未传入随机源时（例如界面预览）使用固定的充能数。
    const item = makeItem(proto, rng ?? FALLBACK_RNG);
    item.equipped = equip;
    item.buc = 'uncursed';
    items.push(item);
  }
  return items;
}
