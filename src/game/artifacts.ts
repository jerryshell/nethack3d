/**
 * 职业神器。
 *
 * 沿用原版的职业任务神器设定，但本作还没有任务楼层：神器作为圣所
 * （第 29 层）的必得奖励出现，用基础物品原型 + 附魔加值表示。
 * 非武器类神器目前只是具名珍品，没有额外能力。
 */

export interface ArtifactDef {
  /** 文案键后缀：artifact.<id>。 */
  id: string;
  role: string;
  /** 基础物品原型 id。 */
  proto: string;
  /** 附魔加值；武器类的命中与伤害都会加上它。 */
  enchant: number;
}

export const ARTIFACTS: Record<string, ArtifactDef> = {
  ARCHEOLOGIST: {
    id: 'orb_of_detection',
    role: 'ARCHEOLOGIST',
    proto: 'CRYSTAL_BALL',
    enchant: 0,
  },
  BARBARIAN: { id: 'heart_of_ahriman', role: 'BARBARIAN', proto: 'LUCKSTONE', enchant: 0 },
  CAVE_DWELLER: {
    id: 'sceptre_of_might',
    role: 'CAVE_DWELLER',
    proto: 'MACE',
    enchant: 5,
  },
  HEALER: {
    id: 'staff_of_aesculapius',
    role: 'HEALER',
    proto: 'QUARTERSTAFF',
    enchant: 5,
  },
  KNIGHT: {
    id: 'magic_mirror_of_merlin',
    role: 'KNIGHT',
    proto: 'CRYSTAL_BALL',
    enchant: 0,
  },
  MONK: { id: 'eyes_of_the_overworld', role: 'MONK', proto: 'LENSES', enchant: 0 },
  CLERIC: { id: 'mitre_of_holiness', role: 'CLERIC', proto: 'HELMET', enchant: 0 },
  ROGUE: {
    id: 'master_key_of_thievery',
    role: 'ROGUE',
    proto: 'SKELETON_KEY',
    enchant: 0,
  },
  RANGER: { id: 'longbow_of_diana', role: 'RANGER', proto: 'BOW', enchant: 5 },
  SAMURAI: {
    id: 'tsurugi_of_muramasa',
    role: 'SAMURAI',
    proto: 'KATANA',
    enchant: 5,
  },
  TOURIST: {
    id: 'platinum_yendorian_express_card',
    role: 'TOURIST',
    proto: 'CREDIT_CARD',
    enchant: 0,
  },
  VALKYRIE: { id: 'orb_of_fate', role: 'VALKYRIE', proto: 'CRYSTAL_BALL', enchant: 0 },
  WIZARD: {
    id: 'eye_of_the_aethiopica',
    role: 'WIZARD',
    proto: 'AMULET_OF_ESP',
    enchant: 0,
  },
};

/** 按职业取神器定义。 */
export function artifactForRole(roleId: string): ArtifactDef | null {
  return Object.values(ARTIFACTS).find((artifact) => artifact.role === roleId) ?? null;
}
