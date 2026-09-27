/**
 * 存档读写，使用 localStorage。
 *
 * 存档包含玩家、会话计数，以及所有到访楼层的可变状态
 * （迷雾、门、陷阱、物品、怪物）。关卡几何不落盘，
 * 由 `(seed, depth)` 确定性重建。
 */

import type {
  EquipmentSlot,
  GameMessage,
  ItemInstance,
  Level,
  Monster as MonsterState,
  SaveData,
  SerializedItem,
  SerializedLevel,
} from '../types';
import { createLogger, LOG_NS } from '../core/log';
import { generateLevel } from './dungeon';
import { GameSession } from './session';
import { Monster } from './monsters';
import { objById, monById } from '../data/index';
import { nextItemId } from './items';
import { roleById, raceById } from './roles';

const log = createLogger(LOG_NS.save);

export const SAVE_KEY = 'nethack3d.save.v1';

function serializeItem(item: ItemInstance): SerializedItem {
  return {
    p: item.proto.id,
    q: item.quantity,
    e: item.enchant,
    b: item.buc,
    k: item.known ? 1 : 0,
    a: item.appearance,
    c: item.charges,
    g: item.gold ? 1 : 0,
  };
}

function deserializeItem(data: SerializedItem): ItemInstance | null {
  const proto = objById.get(data.p);
  if (!proto) return null;
  return {
    uid: nextItemId(),
    proto,
    id: proto.id,
    quantity: data.q ?? 1,
    enchant: data.e ?? 0,
    buc: (data.b === 'blessed' || data.b === 'cursed' ? data.b : 'uncursed') as ItemInstance['buc'],
    known: !!data.k,
    appearance: data.a ?? null,
    charges: data.c,
    gold: !!data.g,
  };
}

function serializeLevel(level: Level): SerializedLevel {
  return {
    depth: level.depth,
    seen: Array.from(level.seen),
    populated: !!level.populated,
    doors: [...level.doors].map(([i, d]): [number, boolean, boolean, boolean] => [
      i,
      d.closed,
      d.locked,
      d.broken,
    ]),
    traps: [...level.traps].map(([i, tp]): [number, string, boolean] => [i, tp.type, tp.seen]),
    objects: level.objects.map((pile: Level['objects'][number]) => ({
      x: pile.x,
      y: pile.y,
      items: pile.items.map(serializeItem),
    })),
    monsters: level.monsters.map((m) => ({
      t: m.data.id,
      x: m.x,
      y: m.y,
      hp: m.mhp,
      max: m.mhpmax,
      lv: m.mlev,
      asleep: m.asleep ? 1 : 0,
      fleeing: m.fleeing ? 1 : 0,
      mv: m.mv,
    })),
  };
}

export function serializeSession(session: GameSession): SaveData {
  const p = session.player;
  return {
    v: 1,
    seed: session.seed,
    depth: session.depth,
    turn: session.turn,
    kills: session.kills,
    dead: session.dead ? 1 : 0,
    character: {
      roleId: p.role.id,
      raceId: p.race.id,
      align: p.align,
      gender: p.gender,
    },
    attributes: {
      str: p.str,
      int: p.int,
      wis: p.wis,
      dex: p.dex,
      con: p.con,
      cha: p.cha,
    },
    player: {
      x: p.x,
      y: p.y,
      hp: p.hp,
      maxHp: p.maxHp,
      pw: p.pw,
      maxPw: p.maxPw,
      gold: p.gold,
      hunger: p.hunger,
      xp: p.xp,
      level: p.level,
      luck: p.luck,
      hitInc: p.hitInc,
      blind: p.blind ?? 0,
      confused: p.confused ?? 0,
      invisible: p.invisible ?? 0,
      sleep: p.sleep ?? 0,
      held: p.held ?? 0,
      seeInvisible: p.seeInvisible ?? false,
      knownSpells: p.knownSpells ?? [],
      inventory: p.inventory.map(serializeItem),
      equipment: Object.fromEntries(
        Object.entries(p.equipment).map(([slot, item]) => [slot, p.inventory.indexOf(item)]),
      ),
    },
    levels: [...session.levels.values()].map(serializeLevel),
    messages: session.messages.slice(-40),
  };
}

export function hasSave() {
  try {
    return !!localStorage.getItem(SAVE_KEY);
  } catch {
    return false;
  }
}

export function saveGame(session: GameSession): boolean {
  try {
    const payload = JSON.stringify(serializeSession(session));
    localStorage.setItem(SAVE_KEY, payload);
    log.info('存档写入成功', {
      depth: session.depth,
      turn: session.turn,
      levels: session.levels.size,
      bytes: payload.length,
    });
    return true;
  } catch (err) {
    log.error('存档写入失败', err);
    return false;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

/** 依据存档数据重建可继续游玩的会话。 */
export function restoreSession(data: SaveData): GameSession {
  log.info('从存档恢复会话', {
    seed: data.seed,
    depth: data.depth,
    turn: data.turn,
    levels: data.levels.length,
  });
  const character = {
    role: roleById[data.character.roleId],
    race: raceById[data.character.raceId],
    align: data.character.align,
    gender: data.character.gender,
  };
  const session = new GameSession({
    seed: data.seed,
    depth: data.depth,
    character,
    attributes: data.attributes ?? null,
    skipInit: true,
  });

  const p = data.player;
  const player = session.player;
  player.x = p.x;
  player.y = p.y;
  player.hp = p.hp;
  player.maxHp = p.maxHp;
  player.pw = p.pw;
  player.maxPw = p.maxPw;
  player.gold = p.gold;
  player.hunger = p.hunger;
  player.xp = p.xp;
  player.level = p.level;
  player.luck = p.luck ?? 0;
  player.hitInc = p.hitInc ?? 0;
  player.blind = p.blind ?? 0;
  player.confused = p.confused ?? 0;
  player.invisible = p.invisible ?? 0;
  player.sleep = p.sleep ?? 0;
  player.held = p.held ?? 0;
  player.seeInvisible = p.seeInvisible ?? false;
  player.knownSpells = p.knownSpells ?? [];

  const items = (p.inventory ?? []).map(deserializeItem).filter((i): i is ItemInstance => !!i);
  player.inventory = items;
  player.equipment = {};
  for (const [slot, idx] of Object.entries(p.equipment ?? {})) {
    const item = items[idx as number];
    if (item) player.equipment[slot as EquipmentSlot] = item;
  }

  // Restore visited levels.
  session.levels = new Map();
  for (const ld of data.levels ?? []) {
    const level = generateLevel({ gameSeed: session.seed, depth: ld.depth });
    level.depth = ld.depth;
    level.seen = Uint8Array.from(ld.seen ?? []);
    level.populated = !!ld.populated;
    level.doors = new Map(
      (ld.doors ?? []).map(([i, closed, locked, broken]) => [
        i,
        { closed: !!closed, locked: !!locked, broken: !!broken },
      ]),
    );
    level.traps = new Map((ld.traps ?? []).map(([i, type, seen]) => [i, { type, seen: !!seen }]));
    level.objects = (ld.objects ?? []).map((pile) => ({
      x: pile.x,
      y: pile.y,
      items: pile.items.map(deserializeItem).filter((i): i is ItemInstance => !!i),
    }));
    level.monsters = (ld.monsters ?? [])
      .map((m: SerializedLevel['monsters'][number]) => {
        const data2 = monById.get(m.t);
        if (!data2) return null;
        const mon = new Monster(data2, m.x, m.y, session.rng, { mlev: m.lv });
        mon.mhp = m.hp;
        mon.mhpmax = m.max;
        mon.asleep = !!m.asleep;
        mon.fleeing = !!m.fleeing;
        mon.mv = m.mv ?? 0;
        return mon;
      })
      .filter((m): m is MonsterState => !!m);
    session.levels.set(ld.depth, level);
  }

  session.depth = data.depth;
  session.turn = data.turn ?? 0;
  session.kills = data.kills ?? 0;
  session.dead = !!data.dead;
  session.messages = (data.messages ?? []).map((m: GameMessage) => Object.assign({}, m));
  session.level = session.getLevel(data.depth);
  session.refreshFov();
  return session;
}

export function loadGame(): GameSession | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    return restoreSession(JSON.parse(raw));
  } catch (err) {
    log.error('存档解析失败，已忽略该存档', err);
    return null;
  }
}
