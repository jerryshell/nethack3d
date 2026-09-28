/**
 * 抗性：玩家与怪物对特殊攻击的抵抗。
 *
 * 玩家的抗性只来自穿戴的装备，摘下即失效：戒指与护身符看 `power` 字段，
 * 反射盾按物品 id，龙鳞甲按物品 ID 对应元素。怪物的抗性取自原型数据的 `MR_*` 列表，
 * 法术抗性另用 `mr` 百分比判定，与 NetHack 的 mresists() 与 resists_magm() 一致。
 */

import type { MonsterData, Player, Rng } from '../types';
import { monById } from '../data/index';

/** 参与判定的抗性种类。 */
export type ResistKind =
  | 'fire'
  | 'cold'
  | 'elec'
  | 'acid'
  | 'poison'
  | 'sleep'
  | 'magic'
  | 'drain'
  | 'disint'
  | 'hold'
  /** 反射：弹回电击等可反射的攻击，不完全等同于魔法抗性。 */
  | 'reflection';

/** 戒指与护身符的 power 到抗性。 */
const POWER_RESIST: Record<string, ResistKind> = {
  FIRE_RES: 'fire',
  COLD_RES: 'cold',
  SHOCK_RES: 'elec',
  POISON_RES: 'poison',
  FREE_ACTION: 'hold',
  REFLECTING: 'reflection',
};

/** 直接按物品 id 认定的抗性，用于没有 power 字段的装备。 */
const ID_RESIST: [string, ResistKind][] = [['SHIELD_OF_REFLECTION', 'reflection']];

/** 龙鳞甲的颜色前缀到抗性；金、银、微光三色不在此列。 */
const SCALE_RESIST: [string, ResistKind][] = [
  ['RED_DRAGON_SCALE', 'fire'],
  ['WHITE_DRAGON_SCALE', 'cold'],
  ['BLUE_DRAGON_SCALE', 'elec'],
  ['BLACK_DRAGON_SCALE', 'disint'],
  ['GREEN_DRAGON_SCALE', 'poison'],
  ['YELLOW_DRAGON_SCALE', 'acid'],
  ['ORANGE_DRAGON_SCALE', 'sleep'],
  ['GRAY_DRAGON_SCALE', 'magic'],
];

/** 怪物的抗性标志；没有对应标志的种类只能靠法术抗性拦截。 */
const MONSTER_RESIST: Partial<Record<ResistKind, string>> = {
  fire: 'MR_FIRE',
  cold: 'MR_COLD',
  elec: 'MR_ELEC',
  acid: 'MR_ACID',
  poison: 'MR_POISON',
  sleep: 'MR_SLEEP',
  disint: 'MR_DISINT',
};

/** 全部抗性种类，用于遍历形态自带的抗性。 */
const RESIST_KINDS: ResistKind[] = [
  'fire',
  'cold',
  'elec',
  'acid',
  'poison',
  'sleep',
  'magic',
  'drain',
  'disint',
  'hold',
  'reflection',
];

/** 玩家当前的抗性集合。 */
export function playerResists(player: Player): Set<ResistKind> {
  const out = new Set<ResistKind>();
  for (const item of Object.values(player.equipment)) {
    if (!item) continue;
    const power = item.proto.power ?? '';
    const fromPower = POWER_RESIST[power];
    if (fromPower) out.add(fromPower);
    for (const [id, kind] of ID_RESIST) {
      if (item.proto.id === id) out.add(kind);
    }
    for (const [prefix, kind] of SCALE_RESIST) {
      if (item.proto.id.startsWith(prefix)) out.add(kind);
    }
  }
  // 变形形态自带怪物抗性。
  const form = player.form ? monById.get(player.form.id) : undefined;
  if (form) {
    for (const kind of RESIST_KINDS) {
      if (monsterResists(form, kind)) out.add(kind);
    }
  }
  return out;
}

/** 怪物原型是否免疫某类元素伤害。 */
export function monsterResists(mon: MonsterData, kind: ResistKind): boolean {
  const flag = MONSTER_RESIST[kind];
  return flag ? mon.resists.includes(flag) : false;
}

/** 怪物的法术抗性判定：`mr` 是百分比，命中即挡下效果。 */
export function monsterMagicResists(mon: MonsterData, rng: Rng): boolean {
  return mon.mr > 0 && rng.rnd(100) <= mon.mr;
}
