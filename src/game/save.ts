/**
 * 存档读写，使用 localStorage。
 *
 * 存档包含玩家、会话计数，以及所有到访楼层的可变状态
 * （迷雾、门、陷阱、物品、怪物）。关卡几何不入档，
 * 由 `(seed, depth)` 确定性重建。
 */

import type {
  EquipmentSlot,
  FeatureState,
  GameMessage,
  ItemInstance,
  Level,
  Monster as MonsterState,
  Rng,
  SaveData,
  SerializedLevel,
  SerializedMonster,
} from '../types';
import { createLogger, LOG_NS } from '../core/log';
import { generateLevel, generateBranchLevel } from './dungeon';
import { branchById } from './branches';
import { GameSession } from './session';
import { Monster } from './monsters';
import { monById } from '../data/index';
import { deserializeItem, serializeItem } from './itemcodec';
import { roleById, raceById } from './roles';

const log = createLogger(LOG_NS.save);

export const SAVE_KEY = 'nethack3d.save.v1';

export { deserializeItem, serializeItem };

export function serializeMonster(m: MonsterState): SerializedMonster {
  return {
    t: m.data.id,
    x: m.x,
    y: m.y,
    hp: m.mhp,
    max: m.mhpmax,
    lv: m.mlev,
    asleep: m.asleep ? 1 : 0,
    fleeing: m.fleeing ? 1 : 0,
    angry: m.angry ? 1 : 0,
    tame: m.tame ? 1 : 0,
    tameness: m.tameness ?? 0,
    mv: m.mv,
  };
}

/** 反序列化一只怪物；原型缺失时返回 null。 */
export function deserializeMonster(data: SerializedMonster, rng: Rng): MonsterState | null {
  const proto = monById.get(data.t);
  if (!proto) return null;
  const mon = new Monster(proto, data.x, data.y, rng, { mlev: data.lv });
  mon.mhp = data.hp;
  mon.mhpmax = data.max;
  mon.asleep = !!data.asleep;
  mon.fleeing = !!data.fleeing;
  mon.angry = !!data.angry;
  mon.tame = !!data.tame;
  mon.tameness = data.tameness ?? 0;
  mon.mv = data.mv ?? 0;
  return mon;
}

function serializeLevel(level: Level): SerializedLevel {
  return {
    depth: level.depth,
    branch: level.branch ?? undefined,
    ...(level.shopRestockAt !== undefined ? { shopRestockAt: level.shopRestockAt } : {}),
    seen: Array.from(level.seen),
    populated: !!level.populated,
    doors: [...level.doors].map(([i, d]): [number, boolean, boolean, boolean] => [
      i,
      d.closed,
      d.locked,
      d.broken,
    ]),
    traps: [...level.traps].map(([i, tp]): [number, string, boolean] => [i, tp.type, tp.seen]),
    features: [...level.features].map(([i, f]): [number, 0 | 1, 0 | 1] => [
      i,
      f.depleted ? 1 : 0,
      f.used ? 1 : 0,
    ]),
    objects: level.objects.map((pile: Level['objects'][number]) => ({
      x: pile.x,
      y: pile.y,
      items: pile.items.map(serializeItem),
    })),
    monsters: level.monsters.map((m) => serializeMonster(m)),
  };
}

export function serializeSession(session: GameSession): SaveData {
  const p = session.player;
  return {
    v: 1,
    seed: session.seed,
    depth: session.depth,
    ...(session.branch !== 'main' ? { branch: session.branch } : {}),
    ...(session.ride ? { ride: serializeMonster(session.ride) } : {}),
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
      stun: p.stun ?? 0,
      petrifying: p.petrifying ?? 0,
      alignRecord: p.alignRecord ?? 0,
      prayerTimeout: p.prayerTimeout ?? 0,
      form: p.form ? { id: p.form.id, turns: p.form.turns } : null,
      skillUses: { ...p.skillUses },
      skillLevels: { ...p.skillLevels },
      seeInvisible: p.seeInvisible ?? false,
      knownSpells: p.knownSpells ?? [],
      inventory: p.inventory.map(serializeItem),
      equipment: Object.fromEntries(
        Object.entries(p.equipment).map(([slot, item]) => [slot, p.inventory.indexOf(item)]),
      ),
    },
    levels: [...session.levels.values(), ...session.branchCache.values()].map(serializeLevel),
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
  player.stun = p.stun ?? 0;
  player.petrifying = p.petrifying ?? 0;
  player.alignRecord = p.alignRecord ?? 0;
  player.prayerTimeout = p.prayerTimeout ?? 0;
  player.form = p.form ? { id: p.form.id, turns: p.form.turns } : null;
  player.skillUses = { ...p.skillUses };
  player.skillLevels = { ...p.skillLevels };
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
  session.branchCache = new Map();
  for (const ld of data.levels ?? []) {
    const level = ld.branch
      ? generateBranchLevel({
          gameSeed: session.seed,
          branch: ld.branch,
          depth: ld.depth,
          levels: branchById(ld.branch)?.levels ?? ld.depth,
        })
      : generateLevel({ gameSeed: session.seed, depth: ld.depth });
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
    if (ld.features) {
      // 只保留存档里仍存在的设施：消失的王座与碎裂的水槽不会复活。
      const kept = new Map<number, FeatureState>();
      for (const [i, depleted, used] of ld.features) {
        const feature = level.features.get(i);
        if (!feature) continue;
        if (depleted) feature.depleted = true;
        if (used) feature.used = true;
        kept.set(i, feature);
      }
      level.features = kept;
    }
    level.objects = (ld.objects ?? []).map((pile) => ({
      x: pile.x,
      y: pile.y,
      items: pile.items.map(deserializeItem).filter((i): i is ItemInstance => !!i),
    }));
    level.monsters = (ld.monsters ?? [])
      .map((m: SerializedMonster) => deserializeMonster(m, session.rng))
      .filter((m): m is MonsterState => !!m);
    session.levels.set(ld.depth, level);
    if (ld.branch) session.branchCache.set(`${ld.branch}:${ld.depth}`, level);
    if (ld.shopRestockAt !== undefined) level.shopRestockAt = ld.shopRestockAt;
  }

  session.depth = data.depth;
  session.branch = data.branch ?? 'main';
  session.ride = data.ride ? deserializeMonster(data.ride, session.rng) : null;
  session.turn = data.turn ?? 0;
  session.kills = data.kills ?? 0;
  session.dead = !!data.dead;
  session.messages = (data.messages ?? []).map((m: GameMessage) => Object.assign({}, m));
  session.level =
    session.branch === 'main'
      ? session.getLevel(data.depth)
      : session.getBranchLevel(session.branch, data.depth);
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
