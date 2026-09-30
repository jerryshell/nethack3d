/**
 * 玩家角色。
 *
 * 保存属性、装备、生命与法力、背包，并负责升级与受伤结算。
 * 派生属性（护甲等级、武器、伤害加值）通过 getter 计算。
 */

import type {
  Attributes,
  Equipment,
  EquipmentSlot,
  ItemInstance,
  MonsterData,
  MonsterSize,
  Player as PlayerState,
  PolymorphForm,
  RaceData,
  RoleData,
  Rng,
  Alignment,
  Gender,
} from '../types';
import { rollAttributes, buildStartingKit } from './roles';
import { dbon, xpForLevel } from './combat';
import { monById } from '../data/index';

/** 初始装备的佩戴方式转成装备槽位。 */
function slotFor(item: ItemInstance, equip: string): EquipmentSlot {
  if (equip === 'offhand') return 'shield';
  if (equip === 'wear') {
    if (item.proto.cls === 'armor') return (item.proto.slot as EquipmentSlot) ?? 'suit';
    return 'suit';
  }
  return 'weapon';
}

/** 创建玩家的参数。 */
interface PlayerOptions {
  role: RoleData;
  race: RaceData;
  align: Alignment;
  gender?: Gender;
  rng: Rng;
  name?: string;
  /** 角色创建界面已确定的属性，省略时按点数规则重新分配。 */
  attributes?: Attributes | null;
}

export class Player implements PlayerState {
  name: string;
  role: RoleData;
  race: RaceData;
  align: Alignment;
  gender: Gender;

  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  pw: number;
  maxPw: number;

  // 属性由 Object.assign 从 rollAttributes() 写入，构造期无法静态推断。
  str!: number;
  int!: number;
  wis!: number;
  dex!: number;
  con!: number;
  cha!: number;
  /** 生成时的属性基准；恢复属性药水用它判断提升空间。 */
  baseAttributes!: Attributes;

  hitInc: number;
  luck: number;
  gold: number;
  hunger: number;
  acBonus: number;

  inventory: ItemInstance[];
  equipment: Equipment;

  x: number;
  y: number;
  dead: boolean;

  blind: number;
  confused: number;
  invisible: number;
  sleep: number;
  held: number;
  /** 眩晕剩余回合。 */
  stun: number;
  /** 石化剩余回合；归零即死亡。 */
  petrifying: number;
  /** 加速剩余回合；大于 0 时跳过怪物行动。 */
  hasted: number;
  /** 浮空剩余回合；大于 0 时飘浮。 */
  levitating: number;
  /** 溺水累积回合；站在水里递增。 */
  drowning: number;
  /** 疾病剩余回合；大于 0 时停止自然回复并周期性掉血。 */
  sick: number;
  /** 阵营记录与祈祷冷却。 */
  alignRecord: number;
  /** 是否受铁球惩罚；受罚期间移动减半。 */
  punished: boolean;
  /** 受罚计数：奇数回合无法移动。 */
  punishedTurn: number;
  prayerTimeout: number;
  /** 当前变形形态；为空表示原形。 */
  form: PolymorphForm | null;
  /** 武器技能使用次数与等级。 */
  skillUses: Record<string, number>;
  skillLevels: Record<string, number>;
  seeInvisible: boolean;
  knownSpells: string[];
  /** 吃尸体得到的内在抗性（不依赖装备，永久保留）。 */
  intrinsics: string[];
  /** 心灵感应：感知附近怪物的位置。 */
  telepathy: boolean;
  /** 怪物探测剩余回合。 */
  senseMonsters: number;
  /** 物品探测剩余回合。 */
  senseObjects: number;
  /** 金币探测与食物探测剩余回合。 */
  senseGold: number;
  senseFood: number;
  /** 传送症：每回合有小概率随机传送。 */
  teleportitis: boolean;

  constructor({
    role,
    race,
    align,
    gender = 'female',
    rng,
    name = 'Hero',
    attributes = null,
  }: PlayerOptions) {
    this.name = name;
    this.role = role;
    this.race = race;
    this.align = align;
    this.gender = gender;

    Object.assign(this, attributes ?? rollAttributes(role, race, rng));
    this.baseAttributes = {
      str: this.str,
      int: this.int,
      wis: this.wis,
      dex: this.dex,
      con: this.con,
      cha: this.cha,
    };

    this.level = 1;
    this.xp = 0;
    this.maxHp = Math.max(
      1,
      role.hp.infix + race.hp.infix + rng.rn2(role.hp.inrnd + race.hp.inrnd + 1),
    );
    this.hp = this.maxHp;
    this.maxPw = Math.max(
      0,
      role.energy.infix + race.energy.infix + rng.rn2(role.energy.inrnd + race.energy.inrnd + 1),
    );
    this.pw = this.maxPw;
    this.hitInc = 0;
    this.luck = 0;
    this.gold = 0;
    this.hunger = 900; // NetHack 初始为 900，趋近 0 时昏倒，负数表示饥饿
    this.acBonus = 0; // 戒指、祈祷等带来的临时修正
    this.sleep = 0;
    this.held = 0;

    this.inventory = buildStartingKit(role.id, rng);
    this.equipment = {};
    this.x = 0;
    this.y = 0;
    this.dead = false;
    this.blind = 0;
    this.confused = 0;
    this.invisible = 0;
    this.sleep = 0;
    this.held = 0;
    this.stun = 0;
    this.petrifying = 0;
    this.hasted = 0;
    this.levitating = 0;
    this.drowning = 0;
    this.sick = 0;
    this.alignRecord = 0;
    this.punished = false;
    this.punishedTurn = 0;
    this.prayerTimeout = 0;
    this.form = null;
    this.skillUses = {};
    this.skillLevels = {};
    this.seeInvisible = false;
    this.knownSpells = [];
    this.intrinsics = [];
    this.telepathy = false;
    this.senseMonsters = 0;
    this.senseObjects = 0;
    this.senseGold = 0;
    this.senseFood = 0;
    this.teleportitis = false;
  }

  /** 当前变形形态的原型；未变形或数据缺失时为空。 */
  get formData(): MonsterData | null {
    return this.form ? (monById.get(this.form.id) ?? null) : null;
  }

  /** 护甲等级：10 为无甲，数值越低越好；变形时改用怪物的护甲。 */
  get ac(): number {
    const form = this.formData;
    if (form) return form.ac - this.acBonus;
    let bonus = this.acBonus;
    for (const item of Object.values(this.equipment)) {
      if (!item) continue;
      if (item.proto.cls === 'armor') bonus += item.proto.ac ?? 0;
      // 保护戒指与守护护身符按 spec 提供 AC，对应原版的 spe 加成。
      if (item.proto.power === 'PROTECTION') {
        bonus += (item.proto.spec ?? 1) + Math.max(0, item.enchant);
      }
    }
    return 10 - bonus;
  }

  /** 当前武器，未持握时为空。 */
  get weapon(): ItemInstance | null {
    return this.equipment.weapon ?? null;
  }

  /** 穿戴初始装备表中标记的装备。 */
  equipStartingGear(): void {
    for (const item of this.inventory) {
      if (!item.equipped) continue;
      const slot = slotFor(item, item.equipped);
      if (!this.equipment[slot]) this.equipment[slot] = item;
      item.equipped = null;
    }
  }

  /** 当前武器对指定体型目标的伤害骰。 */
  weaponDamageSpec(targetSize: MonsterSize): string {
    // 变形后徒手使用怪物形态的天然武器。
    const form = this.formData;
    if (form) {
      const atk = form.attacks.find((a) => a.at !== 'AT_NONE' && a.dice[0] > 0 && a.dice[1] > 0);
      return atk ? `${atk.dice[0]}d${atk.dice[1]}` : '1d2';
    }
    const large =
      targetSize === 'MZ_LARGE' || targetSize === 'MZ_HUGE' || targetSize === 'MZ_GIGANTIC';
    const w = this.weapon;
    if (!w) return '1d2';
    if (w.proto.cls === 'weapon') {
      return (large ? (w.proto.dmgLarge ?? w.proto.dmg) : w.proto.dmg) ?? '1d2';
    }
    return '1d2';
  }

  /** 力量带来的伤害加值。 */
  /** 力量带来的伤害加值；力量戒指额外 +1。 */
  get damageBonus(): number {
    const strRing = Object.values(this.equipment).some(
      (item) => item?.proto.id === 'RIN_GAIN_STRENGTH',
    )
      ? 1
      : 0;
    return dbon(this.str + strRing);
  }

  /** 获得经验，可能连续升级；每次升级调用一次 `onLevelUp`。 */
  gainXp(amount: number, rng: Rng, onLevelUp?: (level: number) => void): void {
    this.xp += amount;
    while (this.xp >= xpForLevel(this.level) && this.level < 30) {
      this.level++;
      const adv =
        this.level < this.role.xlev
          ? this.role.hp
          : { lofix: this.role.hp.hifix, lornd: this.role.hp.hirnd };
      const gain = adv.lofix + (adv.lornd > 0 ? rng.rn2(adv.lornd) : 0);
      this.maxHp += gain;
      this.hp += gain;
      const eadv =
        this.level < this.role.xlev
          ? this.role.energy
          : { lofix: this.role.energy.hifix, lornd: this.role.energy.hirnd };
      const egain = eadv.lofix + (eadv.lornd > 0 ? rng.rn2(eadv.lornd) : 0);
      this.maxPw += egain;
      this.pw += egain;
      onLevelUp?.(this.level);
    }
  }

  /** 扣血；生命归零时标记死亡并返回 true。 */
  takeDamage(amount: number): boolean {
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      return true;
    }
    return false;
  }
}
