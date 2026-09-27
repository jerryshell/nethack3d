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
} from '../types';
import type { GameSession } from './session';
import { describeItem } from './items';
import { killExperience } from './combat';
import { isWalkable } from '../core/constants';
import { index } from './dungeon';

export const INVENTORY_LIMIT = 52; // 字母 a 到 z、A 到 Z

/** 物品使用结果：可翻译的消息键与变量。 */
export interface UseOutcome {
  key: string;
  vars?: Record<string, unknown>;
  identified?: boolean;
  charges?: number;
}

export function inventoryLetter(i: number): string {
  return i < 26 ? String.fromCharCode(97 + i) : String.fromCharCode(65 + (i - 26));
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

/** 拾取整堆物品；金币直接计入钱包。 */
export function pickup(
  player: Player,
  level: Level,
): { ok: boolean; picked: ItemInstance[]; refused: ItemInstance[]; reason?: string | null } {
  const pile = pileAt(level, player.x, player.y);
  if (!pile || !pile.items.length)
    return { ok: false, picked: [], refused: [], reason: 'pickup.nothing' };
  const picked: ItemInstance[] = [];
  const refused: ItemInstance[] = [];
  for (const item of pile.items.slice()) {
    if (item.gold) {
      player.gold += item.quantity;
      picked.push(item);
      pile.items.splice(pile.items.indexOf(item), 1);
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
    default:
      return { key: 'use.nothing' };
  }
}

export function quaffPotion(session: GameSession, item: ItemInstance): UseOutcome {
  const { player, rng } = session;
  const id = item.proto.id;
  const out: UseOutcome = { key: 'use.quaff', vars: { obj: id } };
  switch (id) {
    case 'POT_HEALING':
      player.hp = Math.min(player.maxHp, player.hp + session.rng.dice(2, 4));
      out.key = 'use.healed';
      break;
    case 'POT_EXTRA_HEALING':
      player.hp = Math.min(player.maxHp, player.hp + rng.dice(4, 4));
      out.key = 'use.healed';
      break;
    case 'POT_FULL_HEALING':
      player.hp = player.maxHp;
      out.key = 'use.healed';
      break;
    case 'POT_GAIN_LEVEL':
      player.gainXp(session.rng.rn1(1, 10) + 10, rng, (level: number) =>
        session.log('msg.levelUp', { level }),
      );
      out.key = 'use.gainLevel';
      break;
    case 'POT_GAIN_ENERGY':
      player.pw = Math.min(player.maxPw, player.pw + rng.dice(2, 4));
      out.key = 'use.energy';
      break;
    case 'POT_GAIN_ABILITY':
      player.luck += 1;
      out.key = 'use.luckUp';
      break;
    case 'POT_SEE_INVISIBLE':
      player.seeInvisible = true;
      out.key = 'use.seeInvisible';
      break;
    case 'POT_INVISIBILITY':
      player.invisible = 20;
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
    case 'POT_WATER':
      out.key = 'use.water';
      break;
    default:
      out.key = 'use.nothingHappens';
  }
  out.identified = true;
  return out;
}

export function readScroll(session: GameSession, item: ItemInstance): UseOutcome {
  const id = item.proto.id;
  const out: UseOutcome = { key: 'use.read', vars: { obj: id }, identified: true };
  switch (id) {
    case 'SCR_ENCHANT_ARMOR': {
      const armor =
        session.player.equipment.suit ??
        session.player.equipment.shield ??
        session.player.equipment.helm;
      if (armor) {
        armor.enchant += 1;
        out.key = 'use.enchantArmor';
        out.vars = { obj: armor.proto.id, bonus: armor.enchant };
      } else {
        out.key = 'use.nothingHappens';
      }
      break;
    }
    case 'SCR_REMOVE_CURSE': {
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
      const target = session.player.inventory.find((it: ItemInstance) => !it.known && it !== item);
      if (target) {
        target.known = true;
        out.key = 'use.identify';
        out.vars = { obj: target.proto.id };
      } else {
        out.key = 'use.nothingHappens';
      }
      break;
    }
    case 'SCR_TELEPORTATION': {
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
    case 'SCR_MAGIC_MAPPING': {
      session.revealLevel();
      out.key = 'use.magicMapping';
      break;
    }
    default:
      out.key = 'use.nothingHappens';
  }
  return out;
}

export function readSpellbook(session: GameSession, item: ItemInstance): UseOutcome {
  const out: UseOutcome = { key: 'use.studySpell', vars: { obj: item.proto.id }, identified: true };
  session.player.knownSpells = session.player.knownSpells ?? [];
  if (!session.player.knownSpells.includes(item.proto.id)) {
    session.player.knownSpells.push(item.proto.id);
  }
  return out;
}

export function eatFood(session: GameSession, item: ItemInstance): UseOutcome {
  const { player } = session;
  const nutrition = item.proto.nutrition ?? 100;
  player.hunger = Math.min(2000, player.hunger + nutrition);
  return { key: 'use.eat', vars: { obj: item.proto.id }, identified: true };
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
      const dmg = rng.dice(beamDamage[0], beamDamage[1]);
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
    case 'WAN_TELEPORTATION': {
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
      if (target) {
        target.asleep = true;
        out.key = 'use.zapSleep';
      } else out.key = 'use.nothingHappens';
      break;
    }
    case 'WAN_MAKE_INVISIBLE': {
      session.player.invisible = 20;
      out.key = 'use.invisible';
      break;
    }
    case 'WAN_SLOW_MONSTER':
    case 'WAN_SPEED_MONSTER': {
      const target = nearestMonster(session, 12);
      if (target) {
        out.key = id === 'WAN_SLOW_MONSTER' ? 'use.zapSlow' : 'use.zapHaste';
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

function nearestMonster(session: GameSession, range: number) {
  const p = session.player;
  let best = null;
  let bestD = Infinity;
  for (const m of session.level.monsters) {
    if (m.dead) continue;
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

export function findTeleportSpot(session: GameSession): { x: number; y: number } | null {
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
