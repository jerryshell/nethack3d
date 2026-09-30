/**
 * 抗性：玩家与怪物对特殊攻击的抵抗。
 *
 * 玩家的抗性来自穿戴的装备与携带的神器，以及吃尸体获得的内在抗性：
 * 戒指与护身符看 `power` 字段，反射盾按物品 id，龙鳞甲按物品 ID 对应元素，
 * 神器按 `artilist.h` 的 CARY（携带）与 DFNS（装备）规则映射。
 * 怪物的抗性取自原型数据的 `MR_*` 列表，
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
  /** 石化抵抗：吃鸡蛇类尸体得到，抵挡石化攻击。 */
  | 'stone'
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

/** 携带即生效的神器抗性（artilist.h 的 CARY）。 */
const CARRIED_ARTIFACT_RESIST: Record<string, ResistKind> = {
  orb_of_detection: 'magic',
  magic_mirror_of_merlin: 'magic',
  mitre_of_holiness: 'fire',
  platinum_yendorian_express_card: 'magic',
};

/** 装备后生效的神器抗性（artilist.h 的 DFNS 与 SPFX_REFLECT）。 */
const EQUIPPED_ARTIFACT_RESIST: Record<string, ResistKind> = {
  sceptre_of_might: 'magic',
  eyes_of_the_overworld: 'magic',
  eye_of_the_aethiopica: 'magic',
  staff_of_aesculapius: 'drain',
  longbow_of_diana: 'reflection',
};

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
  'stone',
  'reflection',
];

/** 内在抗性的合法取值；存档里可能缺失或过期，读入时过滤。 */
export const INTRINSIC_KINDS: ReadonlySet<string> = new Set(RESIST_KINDS);

/** 玩家当前的抗性集合。 */
export function playerResists(player: Player): Set<ResistKind> {
  const out = new Set<ResistKind>();
  // 吃尸体得到的内在抗性，不依赖装备。
  for (const kind of player.intrinsics ?? []) {
    if (INTRINSIC_KINDS.has(kind)) out.add(kind as ResistKind);
  }
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
    const artifactKind = item.artifact ? EQUIPPED_ARTIFACT_RESIST[item.artifact] : undefined;
    if (artifactKind) out.add(artifactKind);
  }
  // 神器带上就生效的抗性：不看是否装备。
  for (const item of player.inventory) {
    const kind = item.artifact ? CARRIED_ARTIFACT_RESIST[item.artifact] : undefined;
    if (kind) out.add(kind);
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

/**
 * 神器减伤：半物理与半法术伤害（artilist.h 的 SPFX_HPHDAM / SPFX_HSPDAM）。
 *
 * 命运之球两者兼有；万能钥匙半物理；探知之球、至尊卡片与埃塞俄比亚之眼半法术。
 * 只区分 AD_PHYS 与直接的法术攻击类型，元素吐息暂不减伤。
 */
export function halfDamageKinds(player: Player): { physical: boolean; spell: boolean } {
  let physical = false;
  let spell = false;
  for (const item of player.inventory) {
    if (!item.artifact) continue;
    if (item.artifact === 'orb_of_fate') {
      physical = true;
      spell = true;
    }
    if (item.artifact === 'master_key_of_thievery') physical = true;
    if (
      item.artifact === 'orb_of_detection' ||
      item.artifact === 'platinum_yendorian_express_card' ||
      item.artifact === 'eye_of_the_aethiopica'
    ) {
      spell = true;
    }
  }
  return { physical, spell };
}
