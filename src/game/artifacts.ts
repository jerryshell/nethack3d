/**
 * 职业神器。
 *
 * 沿用原版的职业任务神器设定：神器放在职业任务线最终层的仇敌脚下，
 * 用基础物品原型 + 附魔加值表示。武器类附魔计入命中与伤害；
 * 非武器神器按 `artilist.h` 的 CARY/DFNS 规则提供被动抗性，
 * 医神之杖在手时回复加倍。任务总部与目标地名取自 role.c，中文译名在 i18n 里。
 */

interface ArtifactDef {
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

/**
 * 可以启动的神器。
 *
 * 对应 artilist.h 的 invoke 字段：探知之球揭示地图，命运之球层级传送，
 * 蒂安娜长弓造箭，圣洁法冠回法力，医神之杖治疗。
 */
export const ARTIFACT_INVOKES: ReadonlySet<string> = new Set([
  'orb_of_detection',
  'orb_of_fate',
  'longbow_of_diana',
  'mitre_of_holiness',
  'staff_of_aesculapius',
  'master_key_of_thievery',
  'platinum_yendorian_express_card',
  'eyes_of_the_overworld',
]);
