/**
 * 背包操作与物品效果。
 *
 * 背包沿用 NetHack 的扁平列表形式，界面用字母 a 到 z、A 到 Z 表示下标。
 */

import type {
  EquipmentSlot,
  Monster,
  GroundPile,
  ItemInstance,
  Level,
  ObjectData,
  Player,
  MonsterData,
} from '../types';
import type { GameSession } from './session';
import { describeItem, makeItem } from './items';
import { killExperience } from './combat';
import { monsterMagicResists, monsterResists, playerResists } from './resist';
import type { ResistKind } from './resist';
import { isWalkable, MAX_DEPTH } from '../core/constants';
import { index, inRoom } from './dungeon';
import { monById, objById } from '../data/index';
import { pickMonsterType, Monster as MonsterEntity } from './monsters';

export const INVENTORY_LIMIT = 52; // 字母 a 到 z、A 到 Z

/** 物品使用结果：可翻译的消息键与变量。 */
export interface UseOutcome {
  key: string;
  vars?: Record<string, unknown>;
  identified?: boolean;
  charges?: number;
  /** 食物类结果为真时不移除物品（例如缺开罐工具）。 */
  keep?: boolean;
}

export function letterToIndex(letter: string): number {
  const code = letter.charCodeAt(0);
  if (code >= 97 && code <= 122) return code - 97;
  if (code >= 65 && code <= 90) return 26 + (code - 65);
  return -1;
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

const WEARABLE_SLOT = (proto: ObjectData): EquipmentSlot | null =>
  proto.cls === 'armor' ? (proto.slot ?? 'suit') : null;

export function wieldItem(player: Player, item: ItemInstance): { ok: boolean; reason?: string } {
  if (item.proto.cls !== 'weapon') return { ok: false, reason: 'item.notWeapon' };
  player.equipment.weapon = item;
  return { ok: true };
}

export function wearItem(
  player: Player,
  item: ItemInstance,
): { ok: boolean; slot?: EquipmentSlot; reason?: string } {
  const proto = item.proto;
  if (proto.cls === 'armor') {
    const slot = WEARABLE_SLOT(proto) ?? 'suit';
    player.equipment[slot] = item;
    return { ok: true, slot };
  }
  if (proto.cls === 'ring') {
    const slot = player.equipment.ringLeft ? 'ringRight' : 'ringLeft';
    player.equipment[slot] = item;
    return { ok: true, slot };
  }
  if (proto.cls === 'amulet') {
    player.equipment.amulet = item;
    return { ok: true, slot: 'amulet' };
  }
  if (proto.cls === 'tool' && proto.eyewear) {
    player.equipment.eyes = item;
    return { ok: true, slot: 'eyes' };
  }
  return { ok: false, reason: 'item.notWearable' };
}

export function removeItem(
  player: Player,
  item: ItemInstance,
): { ok: boolean; slot?: EquipmentSlot; reason?: string } {
  for (const [slot, equipped] of Object.entries(player.equipment)) {
    if (equipped === item) {
      delete player.equipment[slot as EquipmentSlot];
      return { ok: true, slot: slot as EquipmentSlot };
    }
  }
  return { ok: false, reason: 'item.notWorn' };
}

export function equippedSlot(player: Player, item: ItemInstance): EquipmentSlot | null {
  for (const [slot, equipped] of Object.entries(player.equipment)) {
    if (equipped === item) return slot as EquipmentSlot;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ground interaction
// ---------------------------------------------------------------------------

export function pileAt(level: Level, x: number, y: number): GroundPile | null {
  return level.objects.find((o) => o.x === x && o.y === y) ?? null;
}

export function addToInventory(
  player: Player,
  item: ItemInstance,
): { ok: boolean; reason?: string } {
  if (player.inventory.length >= INVENTORY_LIMIT) return { ok: false, reason: 'inventory.full' };
  player.inventory.push(item);
  return { ok: true };
}

export function removeFromInventory(player: Player, item: ItemInstance): boolean {
  const i = player.inventory.indexOf(item);
  if (i >= 0) player.inventory.splice(i, 1);
  removeItem(player, item);
  return i >= 0;
}

/**
 * 拾取整堆物品；金币直接计入钱包。
 *
 * `canTake` 用于商店结账：返回 false 的物品留在原地，
 * 计入 `blocked`，与背包已满的 `refused` 区分开。
 */
export function pickup(
  player: Player,
  level: Level,
  { canTake }: { canTake?: (item: ItemInstance) => boolean } = {},
): {
  ok: boolean;
  picked: ItemInstance[];
  refused: ItemInstance[];
  blocked: ItemInstance[];
  reason?: string | null;
} {
  const pile = pileAt(level, player.x, player.y);
  if (!pile || !pile.items.length)
    return { ok: false, picked: [], refused: [], blocked: [], reason: 'pickup.nothing' };
  const picked: ItemInstance[] = [];
  const refused: ItemInstance[] = [];
  const blocked: ItemInstance[] = [];
  for (const item of pile.items.slice()) {
    if (item.gold) {
      player.gold += item.quantity;
      picked.push(item);
      pile.items.splice(pile.items.indexOf(item), 1);
      continue;
    }
    if (canTake && !canTake(item)) {
      blocked.push(item);
      continue;
    }
    const res = addToInventory(player, item);
    if (res.ok) {
      picked.push(item);
      pile.items.splice(pile.items.indexOf(item), 1);
    } else {
      refused.push(item);
    }
  }
  if (!pile.items.length) level.objects.splice(level.objects.indexOf(pile), 1);
  return {
    ok: picked.length > 0,
    picked,
    refused,
    blocked,
    reason: picked.length ? null : 'pickup.nothing',
  };
}

/** 把物品或指定数量的一叠放到当前格。 */
export function drop(
  player: Player,
  level: Level,
  item: ItemInstance,
  quantity: number = item.quantity,
): { ok: boolean; item: ItemInstance } {
  removeFromInventory(player, item);
  const dropped = quantity >= item.quantity ? item : { ...item, quantity };
  if (dropped !== item) item.quantity -= quantity;
  const existing = pileAt(level, player.x, player.y);
  if (existing) existing.items.push(dropped);
  else level.objects.push({ x: player.x, y: player.y, items: [dropped] });
  return { ok: true, item: dropped };
}

/** 自动拾取金币，每次移动后调用。 */
export function autoPickupGold(player: Player, level: Level): number {
  const pile = pileAt(level, player.x, player.y);
  if (!pile) return 0;
  let total = 0;
  for (const item of pile.items.slice()) {
    if (item.gold) {
      total += item.quantity;
      player.gold += item.quantity;
      pile.items.splice(pile.items.indexOf(item), 1);
    }
  }
  if (!pile.items.length) level.objects.splice(level.objects.indexOf(pile), 1);
  return total;
}

// ---------------------------------------------------------------------------
// Effects — quaff / read / eat / zap / apply
// ---------------------------------------------------------------------------

/**
 * 启动神器：消耗一次充能，按神器给出不同效果。
 *
 * 非充能类神器首次启动时获得 3 次机会，充能卷轴可以补给。
 */
export function invokeArtifact(session: GameSession, item: ItemInstance): UseOutcome {
  const id = item.artifact;
  if (!id) return { key: 'use.nothing' };
  if (item.charges === undefined) item.charges = 3;
  if (item.charges <= 0) return { key: 'use.noCharges' };
  item.charges -= 1;
  const { player } = session;
  switch (id) {
    case 'orb_of_detection': {
      session.revealLevel();
      return { key: 'use.artifactMap', identified: true, charges: item.charges };
    }
    case 'orb_of_fate': {
      const candidates = [session.depth - 1, session.depth + 1].filter(
        (d) => d >= 1 && d <= MAX_DEPTH,
      );
      const target = session.rng.pick(candidates) as number;
      session.changeDepth(target, target > session.depth ? 'down' : 'up');
      return {
        key: 'use.artifactTeleport',
        vars: { depth: target },
        identified: true,
        charges: item.charges,
      };
    }
    case 'longbow_of_diana': {
      const proto = objById.get('ARROW');
      if (!proto) return { key: 'use.nothing' };
      const n = 5 + session.rng.rn2(10);
      addToInventory(player, makeItem(proto, session.rng, { quantity: n }));
      return { key: 'use.artifactAmmo', vars: { n }, identified: true, charges: item.charges };
    }
    case 'mitre_of_holiness': {
      player.pw = player.maxPw;
      return { key: 'use.artifactEnergy', identified: true, charges: item.charges };
    }
    case 'staff_of_aesculapius': {
      const healed = Math.min(player.maxHp, player.hp + Math.max(1, Math.ceil(player.maxHp / 2)));
      const n = healed - player.hp;
      player.hp = healed;
      player.sick = 0;
      player.blind = 0;
      return { key: 'use.artifactHeal', vars: { n }, identified: true, charges: item.charges };
    }
    case 'master_key_of_thievery': {
      let n = 0;
      for (const trap of session.level.traps.values()) {
        if (trap.seen) continue;
        trap.seen = true;
        n++;
      }
      return {
        key: n > 0 ? 'use.artifactDetect' : 'use.artifactDetectNone',
        vars: { n },
        identified: true,
        charges: item.charges,
      };
    }
    case 'platinum_yendorian_express_card': {
      const charged = player.inventory
        .filter((it) => it !== item && it.charges !== undefined)
        .sort((a, b) => (a.charges ?? 0) - (b.charges ?? 0));
      const target = charged[0];
      if (!target) {
        return { key: 'use.artifactChargeNone', identified: true, charges: item.charges };
      }
      target.charges = (target.charges ?? 0) + 2;
      return {
        key: 'use.artifactCharge',
        vars: { obj: target.proto.id, charges: target.charges },
        identified: true,
        charges: item.charges,
      };
    }
    case 'eyes_of_the_overworld': {
      // 启明：同时揭示地形与陷阱。
      session.revealLevel();
      for (const trap of session.level.traps.values()) trap.seen = true;
      return { key: 'use.artifactEnlighten', identified: true, charges: item.charges };
    }
    default: {
      // 没有启动能力的神器不消耗次数。
      item.charges += 1;
      return { key: 'use.nothing' };
    }
  }
}

/** 应用物品效果，返回描述结果的 { key, vars }。 */
export function applyItem(session: GameSession, item: ItemInstance): UseOutcome {
  const proto = item.proto;

  switch (proto.cls) {
    case 'potion':
      return quaffPotion(session, item);
    case 'scroll':
      return readScroll(session, item);
    case 'spellbook':
      return readSpellbook(session, item);
    case 'food':
      return eatFood(session, item);
    case 'wand':
      return zapWand(session, item);
    case 'ring':
    case 'amulet':
    case 'armor':
    case 'weapon':
      return { key: 'use.equipHint' };
    case 'tool': {
      // 魔法灯：摩擦一次得到愿望，之后变成没用的灯。
      if (proto.id === 'MAGIC_LAMP') {
        if (item.charges === undefined) item.charges = 1;
        if (item.charges <= 0) return { key: 'use.lampSpent' };
        item.charges -= 1;
        session.openWish();
        return { key: 'use.wishLamp', identified: true };
      }
      return { key: 'use.nothing' };
    }
    default:
      return { key: 'use.nothing' };
  }
}

/** BUC 对数值的调整：祝福 +1，诅咒 -1。 */
function bucShift(item: ItemInstance): number {
  return item.buc === 'blessed' ? 1 : item.buc === 'cursed' ? -1 : 0;
}

/** 圣水与诅咒之水：把背包里所有物品改成同一 BUC，返回变化数量。 */
function blessInventory(player: Player, buc: 'blessed' | 'cursed'): number {
  let count = 0;
  for (const it of player.inventory) {
    if (it.buc !== buc) {
      it.buc = buc;
      count++;
    }
  }
  return count;
}

function quaffPotion(session: GameSession, item: ItemInstance): UseOutcome {
  const { player, rng } = session;
  const id = item.proto.id;
  const out: UseOutcome = { key: 'use.quaff', vars: { obj: id } };
  const shift = bucShift(item);
  switch (id) {
    case 'POT_HEALING':
    case 'POT_EXTRA_HEALING': {
      const dice: [number, number] = id === 'POT_HEALING' ? [2, 4] : [4, 4];
      const healed = Math.max(1, rng.dice(dice[0], dice[1]) + shift * dice[0]);
      player.hp = Math.min(player.maxHp, player.hp + healed);
      // 祝福的治疗药水还能提高生命上限。
      if (item.buc === 'blessed') {
        player.maxHp += dice[0];
        player.hp += dice[0];
      }
      out.key = 'use.healed';
      break;
    }
    case 'POT_FULL_HEALING': {
      // 石化与疾病与 BUC 无关，诅咒版本也能治，只是回血少。
      const curedStone = player.petrifying > 0;
      const curedSick = player.sick > 0;
      player.petrifying = 0;
      player.sick = 0;
      if (item.buc === 'cursed') {
        player.hp = Math.min(player.maxHp, player.hp + Math.ceil(player.maxHp / 4));
        out.key = curedStone ? 'use.curedStone' : curedSick ? 'use.curedSick' : 'use.healed';
        break;
      }
      player.hp = player.maxHp;
      if (item.buc === 'blessed') player.maxHp += 3;
      out.key = curedStone ? 'use.curedStone' : curedSick ? 'use.curedSick' : 'use.healed';
      break;
    }
    case 'POT_GAIN_LEVEL':
      player.gainXp(session.rng.rn1(1, 10) + 10 + shift * 5, rng, (level: number) =>
        session.log('msg.levelUp', { level }),
      );
      out.key = 'use.gainLevel';
      break;
    case 'POT_GAIN_ENERGY':
      player.pw = Math.min(player.maxPw, player.pw + Math.max(1, rng.dice(2, 4) + shift * 2));
      out.key = 'use.energy';
      break;
    case 'POT_GAIN_ABILITY':
      if (item.buc === 'cursed') {
        player.luck -= 1;
        out.key = 'use.badPotion';
      } else {
        player.luck += 1 + Math.max(0, shift);
        out.key = 'use.luckUp';
      }
      break;
    case 'POT_POLYMORPH': {
      const res = session.polymorph();
      out.key = res.changed
        ? 'use.polymorph'
        : res.blocked
          ? 'use.polyUnchanging'
          : 'use.nothingHappens';
      if (res.monId) out.vars = { mon: res.monId };
      break;
    }
    case 'POT_SEE_INVISIBLE':
      if (item.buc === 'cursed') {
        out.key = 'use.badPotion';
      } else {
        player.seeInvisible = true;
        out.key = 'use.seeInvisible';
      }
      break;
    case 'POT_INVISIBILITY':
      player.invisible = item.buc === 'cursed' ? 5 : item.buc === 'blessed' ? 30 : 20;
      out.key = 'use.invisible';
      break;
    case 'POT_BLINDNESS':
      player.blind = 15;
      out.key = 'use.blind';
      break;
    case 'POT_CONFUSION':
      player.confused = 10;
      out.key = 'use.confused';
      break;
    case 'POT_HALLUCINATION':
      player.confused = 8;
      out.key = 'use.confused';
      break;
    case 'POT_ACID':
      player.takeDamage(rng.dice(1, 8));
      out.key = 'use.acid';
      break;
    case 'POT_BOOZE':
      player.confused = 6;
      out.key = 'use.confused';
      break;
    case 'POT_SPEED':
      player.hasted = Math.max(player.hasted, 30);
      out.key = 'use.hasted';
      break;
    case 'POT_PARALYSIS':
      if (playerResists(player).has('hold')) {
        out.key = 'use.badPotion';
      } else {
        player.held = 4 + rng.rn2(4);
        out.key = 'use.paralyzed';
      }
      break;
    case 'POT_SLEEPING':
      if (playerResists(player).has('sleep')) {
        out.key = 'use.badPotion';
      } else {
        player.sleep = 4 + rng.rn2(4);
        out.key = 'use.asleepPotion';
      }
      break;
    case 'POT_SICKNESS':
      if (playerResists(player).has('poison')) {
        out.key = 'use.badPotion';
      } else {
        player.sick = 10 + rng.rn2(10);
        out.key = 'use.sickness';
      }
      break;
    case 'POT_MONSTER_DETECTION':
      player.senseMonsters = Math.max(player.senseMonsters, 30);
      out.key = 'use.senseMonsters';
      break;
    case 'POT_OBJECT_DETECTION':
      player.senseObjects = Math.max(player.senseObjects, 30);
      out.key = 'use.senseObjects';
      break;
    case 'POT_ENLIGHTENMENT':
      session.revealLevel();
      out.key = 'use.enlightened';
      break;
    case 'POT_FRUIT_JUICE':
      player.hunger = Math.min(2000, player.hunger + 10 + rng.rn2(10));
      out.key = 'use.juice';
      break;
    case 'POT_WATER':
      if (item.buc === 'blessed' || item.buc === 'cursed') {
        const count = blessInventory(player, item.buc);
        out.key = item.buc === 'blessed' ? 'use.holyWater' : 'use.unholyWater';
        out.vars = { count };
      } else {
        out.key = 'use.water';
      }
      break;
    default:
      out.key = 'use.nothingHappens';
  }
  out.identified = true;
  return out;
}

function readScroll(session: GameSession, item: ItemInstance): UseOutcome {
  const id = item.proto.id;
  const out: UseOutcome = { key: 'use.read', vars: { obj: id }, identified: true };
  switch (id) {
    case 'SCR_ENCHANT_ARMOR': {
      const armor =
        session.player.equipment.suit ??
        session.player.equipment.shield ??
        session.player.equipment.helm;
      if (armor) {
        armor.enchant += item.buc === 'blessed' ? 2 : item.buc === 'cursed' ? -1 : 1;
        out.key = 'use.enchantArmor';
        out.vars = { obj: armor.proto.id, bonus: armor.enchant };
      } else {
        out.key = 'use.nothingHappens';
      }
      break;
    }
    case 'SCR_ENCHANT_WEAPON': {
      const weapon = session.player.weapon;
      if (weapon) {
        weapon.enchant += item.buc === 'blessed' ? 2 : item.buc === 'cursed' ? -1 : 1;
        out.key = 'use.enchantWeapon';
        out.vars = { obj: weapon.proto.id, bonus: weapon.enchant };
      } else {
        out.key = 'use.nothingHappens';
      }
      break;
    }
    case 'SCR_REMOVE_CURSE': {
      if (item.buc === 'cursed') {
        out.key = 'use.badScroll';
        break;
      }
      let count = 0;
      for (const it of session.player.inventory) {
        if (it.buc === 'cursed') {
          it.buc = 'uncursed';
          count++;
        }
      }
      out.key = count ? 'use.removeCurse' : 'use.nothingHappens';
      out.vars = { count };
      break;
    }
    case 'SCR_IDENTIFY': {
      if (item.buc === 'cursed') {
        session.player.confused = Math.max(session.player.confused, 10);
        out.key = 'use.badScroll';
        break;
      }
      const unknown = session.player.inventory.filter(
        (it: ItemInstance) => !it.known && it !== item,
      );
      const targets = item.buc === 'blessed' ? unknown : unknown.slice(0, 1);
      for (const it of targets) it.known = true;
      if (targets.length) {
        out.key = 'use.identify';
        out.vars = { obj: targets[0].proto.id, count: targets.length };
      } else {
        out.key = 'use.nothingHappens';
      }
      break;
    }
    case 'SCR_CHARGING': {
      // 优先给充能最少的法杖补能；没有法杖时给用尽的魔法灯重新蓄力。
      const wands = session.player.inventory
        .filter((it: ItemInstance) => it.proto.cls === 'wand')
        .sort((a, b) => (a.charges ?? 0) - (b.charges ?? 0));
      const target = wands[0];
      if (target) {
        const before = target.charges ?? 0;
        const gain = item.buc === 'blessed' ? 3 : item.buc === 'cursed' ? -1 : 2;
        target.charges = Math.max(0, before + gain);
        out.key = gain >= 0 ? 'use.charging' : 'use.chargingDrain';
        out.vars = { obj: target.proto.id, n: Math.abs(gain), charges: target.charges };
        break;
      }
      const lamp = session.player.inventory.find(
        (it: ItemInstance) => it.proto.id === 'MAGIC_LAMP' && (it.charges ?? 0) <= 0,
      );
      if (lamp) {
        lamp.charges = 1;
        out.key = 'use.chargingLamp';
        out.vars = { obj: lamp.proto.id };
        break;
      }
      out.key = 'use.nothingHappens';
      break;
    }
    case 'SCR_TELEPORTATION': {
      if (session.teleportBlocked) {
        out.key = 'use.teleportBlocked';
        break;
      }
      const spot = findTeleportSpot(session);
      if (spot) {
        session.player.x = spot.x;
        session.player.y = spot.y;
        session.refreshFov();
        out.key = 'use.teleport';
      } else out.key = 'use.nothingHappens';
      break;
    }
    case 'SCR_FIRE': {
      const dmg = session.rng.dice(2, 6);
      session.player.takeDamage(dmg);
      out.key = 'use.burn';
      out.vars = { dmg };
      break;
    }
    case 'SCR_CONFUSE_MONSTER':
    case 'SCR_SCARE_MONSTER': {
      const nearby = session.level.monsters.filter(
        (m: Monster) =>
          Math.max(Math.abs(m.x - session.player.x), Math.abs(m.y - session.player.y)) <= 6,
      );
      for (const m of nearby) m.fleeing = true;
      out.key = nearby.length ? 'use.scareMonsters' : 'use.nothingHappens';
      out.vars = { count: nearby.length };
      break;
    }
    case 'SCR_STINKING_CLOUD': {
      let fled = 0;
      for (const mon of session.level.monsters) {
        if (mon.dead || mon.tame) continue;
        const d = Math.max(Math.abs(mon.x - session.player.x), Math.abs(mon.y - session.player.y));
        if (d > 6) continue;
        mon.fleeing = true;
        fled++;
      }
      if (!playerResists(session.player).has('poison')) {
        session.player.sick = Math.max(session.player.sick, 4 + session.rng.rn2(4));
      }
      out.key = fled ? 'use.stinkingCloud' : 'use.nothingHappens';
      out.vars = { count: fled };
      break;
    }
    case 'SCR_TAMING': {
      const target = nearestMonster(session, 8);
      if (!target) {
        out.key = 'use.nothingHappens';
        break;
      }
      target.tame = true;
      target.tameness = 10;
      target.asleep = false;
      out.key = 'use.tamed';
      out.vars = { mon: target.data.id };
      break;
    }
    case 'SCR_CREATE_MONSTER': {
      const data = pickMonsterType(session.rng, session.depth + 1, session.player.level);
      const spot = nearbyFreeSpot(session);
      if (data && spot) {
        const mon = new MonsterEntity(data, spot.x, spot.y, session.rng);
        mon.asleep = false;
        session.level.monsters.push(mon);
        out.key = 'use.createMonster';
        out.vars = { mon: data.id };
      } else {
        out.key = 'use.nothingHappens';
      }
      break;
    }
    case 'SCR_LIGHT': {
      const room = session.level.rooms.find((r) => inRoom(r, session.player.x, session.player.y));
      if (!room) {
        out.key = 'use.nothingHappens';
        break;
      }
      room.lit = true;
      for (let x = room.lx; x <= room.hx; x++) {
        for (let y = room.ly; y <= room.hy; y++) session.level.lit[index(x, y)] = 1;
      }
      session.refreshFov();
      out.key = 'use.scrollLight';
      break;
    }
    case 'SCR_DESTROY_ARMOR': {
      const armor =
        session.player.equipment.suit ??
        session.player.equipment.shield ??
        session.player.equipment.helm;
      if (!armor || armor.buc === 'blessed') {
        out.key = 'use.nothingHappens';
        break;
      }
      removeFromInventory(session.player, armor);
      out.key = 'use.destroyArmor';
      out.vars = { obj: armor.proto.id };
      break;
    }
    case 'SCR_MAGIC_MAPPING': {
      session.revealLevel();
      out.key = 'use.magicMapping';
      break;
    }
    case 'SCR_GOLD_DETECTION': {
      session.player.senseGold = Math.max(session.player.senseGold, 30);
      out.key = 'use.detectGold';
      break;
    }
    case 'SCR_FOOD_DETECTION': {
      session.player.senseFood = Math.max(session.player.senseFood, 30);
      out.key = 'use.detectFood';
      break;
    }
    case 'SCR_GENOCIDE': {
      session.openGenocide();
      out.key = 'use.genocidePrompt';
      break;
    }
    default:
      out.key = 'use.nothingHappens';
  }
  return out;
}

function readSpellbook(session: GameSession, item: ItemInstance): UseOutcome {
  const out: UseOutcome = { key: 'use.studySpell', vars: { obj: item.proto.id }, identified: true };
  session.player.knownSpells = session.player.knownSpells ?? [];
  if (!session.player.knownSpells.includes(item.proto.id)) {
    session.player.knownSpells.push(item.proto.id);
  }
  return out;
}

function eatFood(session: GameSession, item: ItemInstance): UseOutcome {
  if (item.corpse) return eatCorpse(session, item);
  if (item.id === 'TIN') return eatTin(session, item);
  const { player } = session;
  const nutrition = item.proto.nutrition ?? 100;
  player.hunger = Math.min(2000, player.hunger + nutrition);
  return { key: 'use.eat', vars: { obj: item.proto.id }, identified: true };
}

/** 怪物 confers 字段到内在抗性；MR_DRAIN 等没有对应机制的不在此列。 */
const CORPSE_RESIST: Record<string, ResistKind> = {
  MR_FIRE: 'fire',
  MR_COLD: 'cold',
  MR_ELEC: 'elec',
  MR_ACID: 'acid',
  MR_POISON: 'poison',
  MR_SLEEP: 'sleep',
  MR_DISINT: 'disint',
  MR_STONE: 'stone',
};

/** 不会腐败的尸体：蜥蜴、地衣、酸块与天启骑士，与 eat.c 的 nonrotting_corpse 一致。 */
const NONROTTING = new Set(['LIZARD', 'LICHEN', 'ACID_BLOB', 'DEATH', 'PESTILENCE', 'FAMINE']);

/** 吃尸体得到心灵感应的怪物（mondata.h 的 telepathic）。 */
const TELEPATHY_MONSTERS = new Set(['FLOATING_EYE', 'MIND_FLAYER', 'MASTER_MIND_FLAYER']);

/**
 * 吃尸体：先判定腐败，再结算毒性/酸性代价，
 * 最后按怪物等级掷骰决定是否获得内在抗性（与 eat.c 的 should_givit 一致）。
 */
export function eatCorpse(session: GameSession, item: ItemInstance): UseOutcome {
  const { player, rng } = session;
  const id = item.corpse as string;
  const data = monById.get(id);
  if (!data) return { key: 'use.eat', vars: { obj: item.proto.id }, identified: true };
  const resists = playerResists(player);
  // 鸡蛇、美杜莎这类会石化的肉：没有石化抗性就直接石化死亡（eat.c 的 cprefx）。
  if (!resists.has('stone') && data.attacks.some((a) => a.ad === 'AD_STON')) {
    player.takeDamage(player.hp);
    session.dead = true;
    return { key: 'use.corpsePetrified', vars: { mon: id }, identified: true };
  }
  player.hunger = Math.min(2000, player.hunger + Math.max(1, Math.round(data.nutrition / 2)));
  let outcome: UseOutcome = { key: 'use.eatCorpse', vars: { mon: id }, identified: true };

  // 腐败：存放越久越危险，腐坏到一定程度会直接致病。
  if (!NONROTTING.has(id) && item.age !== undefined) {
    const age = Math.max(0, session.turn - item.age);
    const rotted = Math.floor(age / (10 + rng.rn2(20)));
    if (rotted > 5) {
      const sickTurns = 10 + rng.rn2(10);
      player.sick = Math.max(player.sick, sickTurns);
      return { key: 'use.corpseTainted', vars: { mon: id }, identified: true };
    }
    if (rotted > 3 && rng.rn2(5) === 0) {
      const dmg = rng.rnd(4);
      player.takeDamage(dmg);
      outcome = { key: 'use.corpseRotten', vars: { mon: id, dmg }, identified: true };
    }
  }

  const attacks = new Set(data.attacks.map((a) => a.ad));
  if (attacks.has('AD_DRST') && !resists.has('poison')) {
    const dmg = rng.rnd(4);
    player.takeDamage(dmg);
    outcome = { key: 'use.corpsePoison', vars: { mon: id, dmg }, identified: true };
  } else if (attacks.has('AD_ACID') && !resists.has('acid')) {
    const dmg = rng.rnd(6);
    player.takeDamage(dmg);
    outcome = { key: 'use.corpseAcid', vars: { mon: id, dmg }, identified: true };
  }
  // 内在抗性：与罐头共用同一套掷骰。
  grantIntrinsic(session, data, id);
  // 浮游眼与夺心魔的肉赋予心灵感应（eat.c 的 corpse_intrinsic 对 TELEPAT 概率必中）。
  if (!player.telepathy && TELEPATHY_MONSTERS.has(id)) {
    player.telepathy = true;
    session.log('msg.telepathyGained');
  }
  // 会传送的怪物的肉赋予传送症，概率按等级 / 10。
  if (!player.teleportitis && data.flags.includes('M1_TPORT') && rng.rn2(10) < data.lvl) {
    player.teleportitis = true;
    session.log('msg.teleportitisGained');
  }
  return outcome;
}

/** 按怪物等级掷骰，从 confers 里赋予一种尚未拥有的内在抗性。 */
function grantIntrinsic(session: GameSession, data: MonsterData, id: string): void {
  const { player, rng } = session;
  const gains = data.confers
    .map((flag) => CORPSE_RESIST[flag])
    .filter((kind): kind is ResistKind => !!kind && !player.intrinsics.includes(kind));
  if (!gains.length || rng.rn2(15) >= data.lvl) return;
  const kind = rng.pick(gains) as ResistKind;
  player.intrinsics.push(kind);
  session.log('msg.intrinsicGained', { res: kind, mon: id });
}

/**
 * 吃罐头：没有开罐器或武器时原样留下；内容在开启时随机确定，
 * 偶尔变质，祝福的罐头不会。
 */
function eatTin(session: GameSession, item: ItemInstance): UseOutcome {
  const { player, rng } = session;
  const hasOpener = player.inventory.some((it) => it.proto.id === 'TIN_OPENER');
  if (!hasOpener && !player.weapon) {
    return { key: 'use.tinNeedOpener', keep: true };
  }
  // 内容按当前层数抽一只可生成的怪物，之后固定下来。
  if (!item.tin) {
    const pick = pickMonsterType(rng, session.depth, player.level);
    if (!pick) return { key: 'use.tinEmpty', identified: true };
    item.tin = pick.id;
  }
  const data = monById.get(item.tin);
  if (!data) return { key: 'use.tinEmpty', identified: true };
  player.hunger = Math.min(2000, player.hunger + Math.max(1, data.nutrition));
  if (item.buc !== 'blessed' && rng.rn2(6) === 0) {
    const dmg = rng.rnd(8);
    player.takeDamage(dmg);
    return { key: 'use.tinSpoiled', vars: { mon: item.tin, dmg }, identified: true };
  }
  grantIntrinsic(session, data, item.tin);
  return { key: 'use.tinOpened', vars: { mon: item.tin }, identified: true };
}

export function zapWand(session: GameSession, item: ItemInstance): UseOutcome {
  const { rng } = session;
  const id = item.proto.id;
  if (!item.charges) return { key: 'use.noCharges' };
  item.charges -= 1;
  const out: UseOutcome = {
    key: 'use.zap',
    vars: { obj: id },
    identified: true,
    charges: item.charges,
  };
  const beamDamage = {
    WAN_FIRE: [6, 6],
    WAN_COLD: [6, 6],
    WAN_LIGHTNING: [6, 6],
    WAN_MAGIC_MISSILE: [2, 6],
    WAN_STRIKING: [2, 12],
  }[id];
  if (beamDamage) {
    const target = nearestMonster(session, 12);
    if (target) {
      // 元素伤害先看怪物的元素抗性；法术抗性不拦伤害光束。
      const kind = { WAN_FIRE: 'fire', WAN_COLD: 'cold', WAN_LIGHTNING: 'elec' }[id] as
        | 'fire'
        | 'cold'
        | 'elec'
        | undefined;
      if (kind && monsterResists(target.data, kind)) {
        out.key = 'use.zapResisted';
        out.vars = { ...out.vars, mon: target.data.id };
        return out;
      }
      const dmg = rng.dice(Math.max(1, beamDamage[0] + bucShift(item)), beamDamage[1]);
      target.mhp -= dmg;
      session.lastCombat = { monsterId: target.id, hit: true, byPlayer: true, damage: dmg };
      session.log('msg.zapHit', { mon: target.data.id, obj: id, dmg });
      if (target.mhp <= 0) {
        target.dead = true;
        session.kills++;
        const xp = killExperience(target);
        session.log('msg.youKill', { mon: target.data.id });
        session.player.gainXp(xp, rng, (level: number) => session.log('msg.levelUp', { level }));
      }
    } else {
      session.log('msg.zapMiss', { obj: id });
    }
    out.key = 'use.zap';
    return out;
  }
  switch (id) {
    case 'WAN_WISHING': {
      session.openWish();
      out.key = 'use.zapWish';
      break;
    }
    case 'WAN_TELEPORTATION': {
      if (session.teleportBlocked) {
        out.key = 'use.teleportBlocked';
        break;
      }
      const target = nearestMonster(session, 12);
      const spot = findTeleportSpot(session);
      if (target && spot) {
        target.x = spot.x;
        target.y = spot.y;
        out.key = 'use.zapTeleport';
      } else out.key = 'use.nothingHappens';
      break;
    }
    case 'WAN_OPENING': {
      let opened = 0;
      for (const [, door] of session.level.doors) {
        if (door.closed) {
          door.closed = false;
          opened++;
        }
      }
      out.key = opened ? 'use.zapOpening' : 'use.nothingHappens';
      break;
    }
    case 'WAN_SLEEP': {
      const target = nearestMonster(session, 12);
      if (!target) {
        out.key = 'use.nothingHappens';
        break;
      }
      if (monsterResists(target.data, 'sleep')) {
        out.key = 'use.zapResisted';
        out.vars = { ...out.vars, mon: target.data.id };
        break;
      }
      target.asleep = true;
      out.key = 'use.zapSleep';
      break;
    }
    case 'WAN_MAKE_INVISIBLE': {
      session.player.invisible = 20;
      out.key = 'use.invisible';
      break;
    }
    case 'WAN_DEATH': {
      const target = nearestMonster(session, 12);
      if (!target) {
        out.key = 'use.nothingHappens';
        break;
      }
      if (monsterMagicResists(target.data, rng)) {
        out.key = 'use.zapResisted';
        out.vars = { ...out.vars, mon: target.data.id };
        break;
      }
      session.slayMonster(target, true);
      out.key = 'use.zapDeath';
      out.vars = { ...out.vars, mon: target.data.id };
      break;
    }
    case 'WAN_UNDEAD_TURNING': {
      const target = nearestMonster(session, 12);
      if (!target) {
        out.key = 'use.nothingHappens';
        break;
      }
      if (!target.data.flags.includes('M2_UNDEAD')) {
        out.key = 'use.zapNoEffect';
        out.vars = { ...out.vars, mon: target.data.id };
        break;
      }
      const dmg = rng.dice(1, 8);
      target.mhp -= dmg;
      target.fleeing = true;
      out.key = 'use.zapTurnUndead';
      out.vars = { ...out.vars, mon: target.data.id, dmg };
      if (target.mhp <= 0) session.slayMonster(target, true);
      break;
    }
    case 'WAN_PROBING': {
      const target = nearestMonster(session, 12);
      if (!target) {
        out.key = 'use.nothingHappens';
        break;
      }
      out.key = 'use.zapProbe';
      out.vars = { ...out.vars, mon: target.data.id, hp: target.mhp, ac: target.ac };
      break;
    }
    case 'WAN_LIGHT': {
      const player = session.player;
      const room = session.level.rooms.find((r) => inRoom(r, player.x, player.y));
      if (!room) {
        out.key = 'use.nothingHappens';
        break;
      }
      room.lit = true;
      for (let x = room.lx; x <= room.hx; x++) {
        for (let y = room.ly; y <= room.hy; y++) {
          session.level.lit[index(x, y)] = 1;
        }
      }
      session.refreshFov();
      out.key = 'use.zapLight';
      break;
    }
    case 'WAN_SLOW_MONSTER':
    case 'WAN_SPEED_MONSTER': {
      const target = nearestMonster(session, 12);
      if (target) {
        if (id === 'WAN_SLOW_MONSTER') {
          target.slowed = Math.max(target.slowed, 20);
          out.key = 'use.zapSlow';
        } else {
          target.hasted = Math.max(target.hasted, 20);
          out.key = 'use.zapHaste';
        }
        out.vars = { ...out.vars, mon: target.data.id };
      } else out.key = 'use.nothingHappens';
      break;
    }
    case 'WAN_NOTHING':
      out.key = 'use.nothingHappens';
      break;
    default:
      out.key = 'use.nothingHappens';
  }
  return out;
}

function nearbyFreeSpot(session: GameSession, range = 2): { x: number; y: number } | null {
  const { player } = session;
  const spots: { x: number; y: number }[] = [];
  for (let dx = -range; dx <= range; dx++) {
    for (let dy = -range; dy <= range; dy++) {
      if (!dx && !dy) continue;
      const x = player.x + dx;
      const y = player.y + dy;
      if (!isWalkable(session.level.tiles[index(x, y)])) continue;
      if (session.level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
      spots.push({ x, y });
    }
  }
  return spots.length ? (session.rng.pick(spots) as { x: number; y: number }) : null;
}

function nearestMonster(session: GameSession, range: number) {
  const p = session.player;
  let best = null;
  let bestD = Infinity;
  for (const m of session.level.monsters) {
    if (m.dead || m.tame) continue;
    const i = index(m.x, m.y);
    if (!session.visible || session.visible[i] !== 1) continue;
    const d = Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y));
    if (d <= range && d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

function findTeleportSpot(session: GameSession): { x: number; y: number } | null {
  const level = session.level;
  const spots: { x: number; y: number }[] = [];
  for (let x = 1; x < level.width - 1; x++) {
    for (let y = 1; y < level.height - 1; y++) {
      if (isWalkable(level.tiles[index(x, y)])) spots.push({ x, y });
    }
  }
  return session.rng.pick(spots) ?? null;
}

export { describeItem };
