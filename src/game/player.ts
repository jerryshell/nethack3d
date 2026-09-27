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
  MonsterSize,
  Player as PlayerState,
  RaceData,
  RoleData,
  Rng,
  Alignment,
  Gender,
} from '../types';
import { rollAttributes, buildStartingKit } from './roles';
import { dbon, xpForLevel } from './combat';

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
export interface PlayerOptions {
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
  seeInvisible: boolean;
  knownSpells: string[];

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
    this.seeInvisible = false;
    this.knownSpells = [];
  }

  /** 护甲等级：10 为无甲，数值越低越好。 */
  get ac(): number {
    let bonus = this.acBonus;
    for (const item of Object.values(this.equipment)) {
      if (item && item.proto.cls === 'armor') bonus += item.proto.ac ?? 0;
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
  get damageBonus(): number {
    return dbon(this.str);
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
