/**
 * 游戏会话：维护玩家、地牢、回合、怪物与战斗。
 *
 * 会话与语言无关：消息以「键 + 实体 ID」的形式记录，由界面负责翻译，
 * 因此切换语言后历史消息也会重新渲染。
 */

import type {
  ActionResultInfo,
  Attributes,
  CharacterChoice,
  CombatFeedback,
  GameMessage,
  ItemInstance,
  Level,
  MessageVars,
  Monster,
  Rng,
  SessionStatus,
} from '../types';
import type { UseOutcome } from './inventory';
import { trapEffect, trapNameKey } from './traps';
import { castFailChance, rollSpellAmount, spellProfile } from './spells';
import { createLogger, LOG_NS } from '../core/log';
import { generateLevel, index } from './dungeon';
import { computeFov } from './fov';
import { createRng, deriveSeed } from '../core/rng';
import { T, COLNO, isWalkable, isDoor } from '../core/constants';
import { Player } from './player';
import { randomCharacter } from './roles';
import { heroHits, monsterHits, killExperience, monsterDamage, xpForLevel } from './combat';
import { spawnMonsters, monsterAt } from './monsters';
import { createAppearanceMap, describeItem, spawnObjects, makeGold, makeItem } from './items';
import { objById } from '../data/index';
import {
  applyItem,
  autoPickupGold,
  drop as dropItem,
  pickup as pickupItems,
  removeItem,
  wearItem,
  wieldItem,
  equippedSlot,
  pileAt,
} from './inventory';

const log = createLogger(LOG_NS.session);

export const MAX_DEPTH = 30;

/** 创建会话的参数。 */
export interface SessionOptions {
  seed?: number;
  depth?: number;
  character?: CharacterChoice | null;
  attributes?: Attributes | null;
  /** 由存档恢复时跳过初始生成与欢迎消息。 */
  skipInit?: boolean;
}

const DIR8 = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

export class GameSession {
  seed: number;
  rng: Rng;
  turn: number;
  messages: GameMessage[];
  dead: boolean;
  kills: number;
  victory: boolean;
  visible: Uint8Array | null;

  character: CharacterChoice;
  player: Player;
  appearances: Map<string, string>;

  levels: Map<number, Level>;
  depth: number;
  level: Level;

  /** 最近一次战斗反馈，供界面播放受击动画。 */
  lastCombat: CombatFeedback | null = null;

  constructor({
    seed = (Math.random() * 0x7fffffff) | 0,
    depth = 1,
    character = null,
    attributes = null,
    skipInit = false,
  }: SessionOptions = {}) {
    this.seed = seed >>> 0;
    this.rng = createRng(deriveSeed(this.seed, 'session'));
    this.turn = 0;
    this.messages = [];
    this.dead = false;
    this.kills = 0;
    this.victory = false;
    this.visible = null;

    this.character = character ?? randomCharacter(this.rng);
    const c = this.character;
    this.player = new Player({
      role: c.role,
      race: c.race,
      align: c.align,
      gender: c.gender,
      rng: this.rng,
      attributes,
    });
    this.player.equipStartingGear();
    this.appearances = createAppearanceMap(this.rng);

    this.levels = new Map();
    this.depth = depth;
    this.level = this.getLevel(depth);
    const start = this.level.start ?? this.level.up ?? { x: 1, y: 1 };
    this.player.x = start.x;
    this.player.y = start.y;
    log.info('会话创建', {
      seed: this.seed,
      depth,
      role: c.role.id,
      race: c.race.id,
      align: c.align,
      gender: c.gender,
    });
    if (!skipInit) {
      this.ensureLevelPopulation(this.level);
      this.refreshFov();
      this.log('msg.welcome');
      this.log('msg.youAre', {
        roleId: c.role.id,
        raceId: c.race.id,
        align: c.align,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 关卡访问
  // -------------------------------------------------------------------------

  getLevel(depth: number): Level {
    if (!this.levels.has(depth)) {
      this.levels.set(depth, generateLevel({ gameSeed: this.seed, depth }));
    }
    return this.levels.get(depth) as Level;
  }

  ensureLevelPopulation(level: Level): void {
    if (level.populated) return;
    level.populated = true;
    const done = log.time(`第 ${level.depth} 层放置生物与物品`);
    spawnMonsters(level, this.rng, { player: this.player, heroLevel: this.player.level });
    spawnObjects(level, this.rng, level.depth, this.appearances);
    if (level.depth >= MAX_DEPTH) this.placeAmulet(level);
    done({ monsters: level.monsters.length, piles: level.objects.length });
  }

  /**
   * 地牢最底层放置尤恩多护身符，也是本作的通关条件。
   * 位置选在离入口楼梯最远的房间。
   */
  placeAmulet(level: Level): void {
    const proto = objById.get('AMULET_OF_YENDOR');
    if (!proto) return;
    const item = makeItem(proto, this.rng);
    item.known = true;
    const from = level.up ?? level.start ?? { x: 1, y: 1 };
    let best = null;
    let bestD = -1;
    for (const room of level.rooms) {
      for (let x = room.lx; x <= room.hx; x++) {
        for (let y = room.ly; y <= room.hy; y++) {
          if (level.tiles[index(x, y)] !== T.ROOM) continue;
          if (level.objects.some((o) => o.x === x && o.y === y)) continue;
          const d = Math.abs(x - from.x) + Math.abs(y - from.y);
          if (d > bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
    }
    if (best) {
      level.objects.push({ x: best.x, y: best.y, items: [item] });
      log.info('尤恩多护身符已放置在底层', { depth: level.depth, at: best });
    } else {
      log.warn('底层没有合适位置放置护身符', { depth: level.depth });
    }
  }

  tileAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.level.width || y >= this.level.height) return T.STONE;
    return this.level.tiles[index(x, y)];
  }

  refreshFov(): void {
    const radius = this.player.blind > 0 ? 1 : undefined;
    this.visible = computeFov(this.level, this.player.x, this.player.y, radius);
  }

  // -------------------------------------------------------------------------
  // 消息
  // -------------------------------------------------------------------------

  log(key: string, vars: MessageVars = {}): void {
    this.messages.push({ key, vars, turn: this.turn });
    if (this.messages.length > 200) this.messages.shift();
  }

  // -------------------------------------------------------------------------
  // 玩家动作
  // -------------------------------------------------------------------------

  /**
   * 朝指定方向移动或攻击。
   *
   * 返回的 `result` 取值：moved、blocked、opened、attacked、killed、
   * descended、ascended、dead。
   */
  movePlayer(dx: number, dy: number): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    // 沉睡时无法行动，但回合照样流逝。
    if (this.player.sleep > 0) {
      this.log('msg.asleep');
      this.finishTurn();
      return { result: 'slept' };
    }
    // 被缠住时无法移动；其它动作不受影响。
    if (this.player.held > 0) {
      this.log('msg.held');
      this.finishTurn();
      return { result: 'held' };
    }
    log.debug('玩家移动', {
      from: [this.player.x, this.player.y],
      delta: [dx, dy],
      turn: this.turn,
    });
    const nx = this.player.x + dx;
    const ny = this.player.y + dy;

    const mon = monsterAt(this.level, nx, ny);
    if (mon) {
      const result = this.attackMonster(mon);
      this.finishTurn();
      return { result: this.dead ? 'dead' : result };
    }

    const t = this.tileAt(nx, ny);
    if (isDoor(t)) {
      const door = this.level.doors.get(index(nx, ny));
      if (door && door.closed) {
        if (door.locked) {
          // 对齐 NetHack 的踢门：按力量与等级判定，失败同样消耗一回合，
          // 因此反复尝试最终一定能通过，不会出现无解的卡死。
          const power = Math.floor(this.player.str / 2) + this.player.level;
          if (this.rng.rnd(20) + power >= 15) {
            door.locked = false;
            door.closed = false;
            door.broken = this.rng.chance(0.3);
            this.log('msg.doorForced');
          } else {
            this.log('msg.doorLocked');
          }
        } else {
          door.closed = false;
          this.log('msg.doorOpens');
        }
        this.finishTurn();
        return { result: 'opened' };
      }
    }

    if (!isWalkable(t)) return { result: 'blocked' };

    this.player.x = nx;
    this.player.y = ny;

    const gold = autoPickupGold(this.player, this.level);
    if (gold > 0) this.log('msg.gold', { n: gold });
    this.refreshFov();

    // 踩中陷阱：可能受伤、被传走或掉到下一层。
    const displaced = this.springTrap(index(nx, ny));
    if (this.dead) return { result: 'dead' };
    if (displaced) {
      // 已经不在原格，楼梯判定失去意义。
      this.finishTurn();
      return { result: 'moved' };
    }

    let special: 'descend' | 'ascend' | null = null;
    if (t === T.STAIRS) {
      const goingDown = this.level.down && nx === this.level.down.x && ny === this.level.down.y;
      const goingUp = this.level.up && nx === this.level.up.x && ny === this.level.up.y;
      if (goingDown && this.depth < MAX_DEPTH) special = 'descend';
      else if (goingUp && this.depth > 1) special = 'ascend';
    }

    if (special === 'descend') {
      this.turn++;
      this.changeDepth(this.depth + 1, 'down');
      this.monsterTurns();
      return { result: this.dead ? 'dead' : 'descended' };
    }
    if (special === 'ascend') {
      this.turn++;
      this.changeDepth(this.depth - 1, 'up');
      this.monsterTurns();
      return { result: this.dead ? 'dead' : 'ascended' };
    }

    this.finishTurn();
    return { result: this.dead ? 'dead' : 'moved' };
  }

  /** 原地等待一回合。 */
  wait(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    this.finishTurn();
    return { result: this.dead ? 'dead' : 'waited' };
  }

  /** 玩家动作结束后依次执行怪物阶段与结算。 */
  finishTurn(): void {
    this.turn++;
    this.monsterTurns();
    this.upkeep();
  }

  /** 揭开整张地图，对应魔法地图卷轴。 */
  revealLevel(): void {
    this.level.seen.fill(1);
  }

  /**
   * 结算踩中的陷阱。
   *
   * 返回是否发生了位移或换层：位移之后调用方不应再按原格判断楼梯。
   */
  springTrap(tile: number): boolean {
    const trap = this.level.traps.get(tile);
    if (!trap) return false;
    const effect = trapEffect(trap.type);
    const trapName = trapNameKey(trap.type);
    trap.seen = true;
    let moved = false;

    switch (effect.kind) {
      case 'damage':
      case 'hold': {
        if (effect.dice) {
          const dmg = this.rng.dice(effect.dice[0], effect.dice[1]);
          this.log(effect.message, { trap: trapName, n: dmg });
          if (this.player.takeDamage(dmg)) {
            this.dead = true;
            return false;
          }
        } else {
          this.log(effect.message, { trap: trapName });
        }
        if (effect.kind === 'hold') {
          this.player.held = Math.max(this.player.held, effect.turns ?? 2);
        }
        break;
      }
      case 'sleep': {
        this.log(effect.message, { trap: trapName });
        this.player.sleep = Math.max(this.player.sleep, effect.turns ?? 3);
        break;
      }
      case 'drainPw': {
        const drained = this.player.pw;
        this.player.pw = 0;
        this.log(effect.message, { trap: trapName, n: drained });
        break;
      }
      case 'wake': {
        this.log(effect.message, { trap: trapName });
        for (const mon of this.level.monsters) mon.asleep = false;
        break;
      }
      case 'rust': {
        const suit = this.player.equipment.suit;
        if (suit && suit.enchant > -5) {
          suit.enchant--;
          // item 变量需要物品描述，交给界面翻译。
          this.log(effect.message, { trap: trapName, obj: suit.proto.id });
        } else {
          this.log('msg.trapRustNoArmor', { trap: trapName });
        }
        break;
      }
      case 'teleport': {
        const spot = this.randomFloorTile();
        if (spot) {
          this.player.x = spot.x;
          this.player.y = spot.y;
          this.refreshFov();
          moved = true;
        }
        this.log(effect.message, { trap: trapName });
        break;
      }
      case 'levelTeleport': {
        const delta = this.rng.rn2(3) - 1 || 1;
        const target = Math.max(1, Math.min(MAX_DEPTH, this.depth + delta));
        this.log(effect.message, { trap: trapName, depth: target });
        this.changeDepth(target, target > this.depth ? 'down' : 'up');
        moved = true;
        break;
      }
      case 'hole': {
        if (this.depth < MAX_DEPTH) {
          this.log(effect.message, { trap: trapName });
          this.changeDepth(this.depth + 1, 'down');
          moved = true;
        } else {
          this.log('msg.trapFlavor', { trap: trapName });
        }
        break;
      }
      case 'magic': {
        // 魔法陷阱的效果随机：伤害、恢复、抽干法力或传送。
        const roll = this.rng.rn2(4);
        if (roll === 0) {
          const dmg = this.rng.dice(1, 8);
          this.log('msg.trapDamage', { trap: trapName, n: dmg });
          if (this.player.takeDamage(dmg)) {
            this.dead = true;
            return false;
          }
        } else if (roll === 1) {
          this.player.hp = this.player.maxHp;
          this.log('msg.trapMagicHeal');
        } else if (roll === 2) {
          const drained = this.player.pw;
          this.player.pw = 0;
          this.log('msg.trapDrainPw', { trap: trapName, n: drained });
        } else {
          const spot = this.randomFloorTile();
          if (spot) {
            this.player.x = spot.x;
            this.player.y = spot.y;
            this.refreshFov();
            moved = true;
          }
          this.log('msg.trapTeleport', { trap: trapName });
        }
        break;
      }
      default: {
        this.log(effect.message, { trap: trapName });
        break;
      }
    }
    return moved;
  }

  /** 随机挑一个可站立的地面格，用于传送类效果。 */
  randomFloorTile(): { x: number; y: number } | null {
    const candidates: number[] = [];
    for (let i = 0; i < this.level.tiles.length; i++) {
      const t = this.level.tiles[i];
      if (t === T.ROOM || t === T.CORR) candidates.push(i);
    }
    if (!candidates.length) return null;
    const pick = candidates[this.rng.rn2(candidates.length)];
    return { x: pick % COLNO, y: Math.floor(pick / COLNO) };
  }

  upkeep(): void {
    if (this.dead) return;
    const p = this.player;
    // 与 NetHack 一致的缓慢回复。
    if (this.turn % 20 === 0 && p.hp < p.maxHp) p.hp++;
    if (this.turn % 15 === 0 && p.pw < p.maxPw) p.pw++;

    // 计时状态递减。
    if (p.blind > 0) {
      p.blind--;
      if (p.blind === 0) this.log('msg.blindnessEnds');
    }
    if (p.confused > 0) p.confused--;
    if (p.sleep > 0) {
      p.sleep--;
      if (p.sleep === 0) this.log('msg.wakesUp');
    }
    if (p.held > 0) {
      p.held--;
      if (p.held === 0) this.log('msg.freeFromTrap');
    }
    if (p.invisible > 0) {
      p.invisible--;
      if (p.invisible === 0) this.log('msg.invisibilityEnds');
    }

    // 饱食度：900 为饱腹；150、40、0 三个阈值沿用 NetHack。
    p.hunger--;
    if (p.hunger <= 0 && this.turn % 20 === 0) {
      this.log('use.fainting');
      p.takeDamage(1);
      if (p.dead) {
        this.dead = true;
        this.log('msg.starved');
      }
    } else if (p.hunger <= 40 && p.hunger > 39) {
      this.log('use.weak');
    } else if (p.hunger <= 150 && p.hunger > 149) {
      this.log('use.hunger');
    }
  }

  // -------------------------------------------------------------------------
  // 战斗：玩家进攻
  // -------------------------------------------------------------------------

  attackMonster(mon: Monster): 'attacked' | 'killed' {
    const player = this.player;
    mon.asleep = false;
    const { hit } = heroHits(player, mon, this.rng);
    const weaponId = player.weapon?.id ?? null;

    if (!hit) {
      this.log('msg.youMiss', { mon: mon.data.id });
      this.lastCombat = { monsterId: mon.id, hit: false, byPlayer: true };
      return 'attacked';
    }

    const spec = player.weaponDamageSpec(mon.data.size);
    let dmg = this.rng.rollDamage(spec) + player.damageBonus;
    dmg = Math.max(1, dmg);
    mon.mhp -= dmg;
    this.log(weaponId ? 'msg.youHitWith' : 'msg.youHit', {
      mon: mon.data.id,
      obj: weaponId,
      dmg,
    });
    this.lastCombat = { monsterId: mon.id, hit: true, byPlayer: true, damage: dmg };

    if (mon.mhp <= 0) {
      this.slayMonster(mon, true);
      return 'killed';
    }
    return 'attacked';
  }

  /**
   * 结算一只怪物的死亡：经验、击杀计数与掉落。
   *
   * 近战与法术共用，避免两处各写一份。
   */
  slayMonster(mon: Monster, byPlayer = true): void {
    if (mon.dead) return;
    mon.dead = true;
    this.kills++;
    const xp = killExperience(mon);
    log.info('怪物被击杀', {
      monster: mon.data.id,
      xp,
      monsterLevel: mon.mlev,
      depth: this.depth,
    });
    this.log('msg.youKill', { mon: mon.data.id });
    if (byPlayer) {
      this.lastCombat = { monsterId: mon.id, hit: true, byPlayer: true, killed: true };
    }
    this.player.gainXp(xp, this.rng, (level: number) => {
      this.log('msg.levelUp', { level });
    });
    // 怪物死亡时有概率留下金币。
    if (this.rng.chance(0.35)) {
      const pile = pileAt(this.level, mon.x, mon.y);
      const gold = makeGold(this.rng, this.depth);
      if (pile) pile.items.push(gold);
      else this.level.objects.push({ x: mon.x, y: mon.y, items: [gold] });
    }
  }

  /** 视野范围内最近的怪物，用于需要选目标的法术。 */
  nearestMonster(maxDistance = 8): Monster | null {
    let best: Monster | null = null;
    let bestDistance = maxDistance + 1;
    for (const mon of this.level.monsters) {
      if (mon.mhp <= 0) continue;
      const dist = Math.max(Math.abs(mon.x - this.player.x), Math.abs(mon.y - this.player.y));
      if (dist < bestDistance) {
        bestDistance = dist;
        best = mon;
      }
    }
    return best;
  }

  /** 该怪物是否属于不死生物。 */
  isUndead(mon: Monster): boolean {
    return mon.data.flags.some((flag) => flag.includes('UNDEAD'));
  }

  /**
   * 施放已知法术。
   *
   * 代价等于法术等级；失败时按原版规则损失一半法力。
   * 法力不足时不消耗回合，避免玩家白白空过。
   */
  castSpell(item: ItemInstance): ActionResultInfo {
    if (this.dead || !item) return { result: 'nothing' };
    const proto = item.proto;
    const profile = spellProfile(proto);
    const level = proto.level ?? 1;
    const known = (this.player.knownSpells ?? []).includes(proto.id);
    if (!known) {
      this.log('msg.castUnknown', { obj: proto.id });
      this.finishTurn();
      return { result: 'used', key: 'msg.castUnknown' };
    }
    if (this.player.pw < profile.cost) {
      this.log('msg.castNoMana', { need: profile.cost, pw: this.player.pw });
      return { result: 'nothing' };
    }

    if (this.rng.chance(castFailChance(this.player, level))) {
      const lost = Math.max(1, Math.ceil(profile.cost / 2));
      this.player.pw = Math.max(0, this.player.pw - lost);
      this.log('msg.castFail', { n: lost });
      this.finishTurn();
      return { result: 'used', key: 'msg.castFail' };
    }
    this.player.pw -= profile.cost;

    let key = 'msg.castNothing';
    const vars: Record<string, string | number> = { obj: proto.id };
    switch (profile.kind) {
      case 'attack': {
        const target = this.nearestMonster(8);
        if (!target) {
          key = 'msg.castNoTarget';
          break;
        }
        const amount = rollSpellAmount(this.rng, profile);
        target.mhp -= amount;
        this.lastCombat = { monsterId: target.id, hit: true, byPlayer: true, damage: amount };
        vars.mon = target.data.id;
        vars.dmg = amount;
        key = 'msg.castHit';
        if (target.mhp <= 0) this.slayMonster(target);
        break;
      }
      case 'heal': {
        const amount = rollSpellAmount(this.rng, profile);
        const before = this.player.hp;
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + amount);
        vars.n = this.player.hp - before;
        key = 'msg.castHeal';
        break;
      }
      case 'divine': {
        // 祛邪：优先打不死生物，没有目标时给自己一点治疗。
        const undead = this.level.monsters.find(
          (mon) => mon.mhp > 0 && this.isUndead(mon) && this.nearestMonster(8)?.id === mon.id,
        );
        if (undead) {
          const amount = rollSpellAmount(this.rng, profile) * 2;
          undead.mhp -= amount;
          vars.mon = undead.data.id;
          vars.dmg = amount;
          key = 'msg.castTurnUndead';
          if (undead.mhp <= 0) this.slayMonster(undead);
        } else {
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + 1);
          key = 'msg.castDivineBless';
        }
        break;
      }
      case 'detect': {
        this.revealLevel();
        key = 'msg.castDetect';
        break;
      }
      case 'enchant': {
        const target = this.nearestMonster(8);
        if (!target) {
          key = 'msg.castNoTarget';
          break;
        }
        target.asleep = true;
        vars.mon = target.data.id;
        key = 'msg.castSleep';
        break;
      }
      case 'escape': {
        const spot = this.randomFloorTile();
        if (spot) {
          this.player.x = spot.x;
          this.player.y = spot.y;
          this.refreshFov();
        }
        key = 'msg.castEscape';
        break;
      }
      case 'matter': {
        // 物质法术：打开附近的门；没有门就把相邻的墙化为地面。
        let opened = false;
        for (const [i, door] of this.level.doors) {
          if (!door.closed) continue;
          const x = i % COLNO;
          const y = Math.floor(i / COLNO);
          if (Math.max(Math.abs(x - this.player.x), Math.abs(y - this.player.y)) > 8) continue;
          door.closed = false;
          door.locked = false;
          opened = true;
          break;
        }
        key = opened ? 'msg.castKnock' : 'msg.castMatterNothing';
        break;
      }
      default: {
        key = 'msg.castNothing';
        break;
      }
    }

    this.log(key, vars);
    this.finishTurn();
    return { result: 'used', key };
  }

  // -------------------------------------------------------------------------
  // 物品操作
  // -------------------------------------------------------------------------

  /** 拾取玩家所在格的全部物品。 */
  pickupAction(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const res = pickupItems(this.player, this.level);
    if (!res.ok) {
      this.log(res.refused?.length ? 'use.inventoryFull' : 'use.pickupNothing');
    } else {
      for (const item of res.picked) {
        if (item.gold) this.log('msg.gold', { n: item.quantity });
        else this.log('msg.pickup', { item: describeItem(item) });
        if (item.proto.id === 'AMULET_OF_YENDOR') {
          this.victory = true;
          log.info('玩家取得尤恩多护身符', { turn: this.turn, depth: this.depth });
          this.log('msg.victory');
        }
      }
      if (res.refused.length) this.log('use.inventoryFull');
    }
    this.finishTurn();
    return { result: 'picked', picked: res.picked?.length ?? 0 };
  }

  /** 使用、持握、穿戴或放下背包中的物品。 */
  useItem(item: ItemInstance | null, verb: string | null = null): ActionResultInfo {
    if (this.dead || !item) return { result: 'nothing' };
    let outcome: UseOutcome | null = null;
    switch (verb) {
      case 'wield': {
        const res = wieldItem(this.player, item);
        outcome = res.ok
          ? { key: 'use.wield', vars: { item: describeItem(item) } }
          : { key: 'use.notWeapon' };
        break;
      }
      case 'wear': {
        const res = wearItem(this.player, item);
        outcome = res.ok
          ? { key: 'use.wear', vars: { item: describeItem(item) } }
          : { key: 'use.notWearable' };
        break;
      }
      case 'remove': {
        const res = removeItem(this.player, item);
        outcome = res.ok
          ? { key: 'use.remove', vars: { item: describeItem(item) } }
          : { key: 'use.nothingHappens' };
        break;
      }
      case 'drop': {
        const res = dropItem(this.player, this.level, item);
        outcome = { key: 'use.drop', vars: { item: describeItem(res.item) } };
        break;
      }
      case 'cast': {
        // 施法自带结算与回合推进，直接返回。
        return this.castSpell(item);
      }
      default: {
        outcome = applyItem(this, item);
        if (outcome.identified) item.known = true;
        const vars = { ...outcome.vars, item: describeItem(item) };
        outcome = { key: outcome.key, vars };
        // 消耗品在使用后扣除，效果自身声明不移除的除外。
        if (['potion', 'scroll', 'food'].includes(item.proto.cls)) {
          this.consumeItem(item);
        }
      }
    }
    if (outcome) this.log(outcome.key, outcome.vars ?? {});
    this.finishTurn();
    return { result: 'used', key: outcome?.key };
  }

  consumeItem(item: ItemInstance): void {
    if (item.quantity > 1) {
      item.quantity -= 1;
      return;
    }
    removeItem(this.player, item);
    const i = this.player.inventory.indexOf(item);
    if (i >= 0) this.player.inventory.splice(i, 1);
  }

  inventoryLetters(): { item: ItemInstance; letter: string }[] {
    return this.player.inventory.map((item, i) => ({
      item,
      letter: String.fromCharCode(i < 26 ? 97 + i : 65 + (i - 26)),
    }));
  }

  /** 物品所在的装备槽，未装备时返回 null。 */
  equipped(item: ItemInstance) {
    return equippedSlot(this.player, item);
  }

  // -------------------------------------------------------------------------
  // 怪物
  // -------------------------------------------------------------------------

  monsterTurns(): void {
    log.debug('怪物行动阶段开始', { monsters: this.level.monsters.length, turn: this.turn });
    for (const mon of this.level.monsters) {
      if (mon.dead || this.dead) continue;
      mon.mv += mon.data.speed;
      let guard = 0;
      while (mon.mv >= 12 && guard++ < 4 && !this.dead) {
        mon.mv -= 12;
        this.monsterAction(mon);
      }
    }
    // 清理死亡怪物，简化渲染与查找。
    this.level.monsters = this.level.monsters.filter((m) => !m.dead);
  }

  monsterAction(mon: Monster): void {
    const player = this.player;
    const dist = Math.max(Math.abs(mon.x - player.x), Math.abs(mon.y - player.y));

    if (mon.asleep) {
      if (dist <= 8 && this.monsterSees(mon) && this.rng.chance(0.4)) {
        mon.asleep = false;
      } else {
        return;
      }
    }

    if (mon.fleeing) {
      this.stepMonster(mon, -1);
      return;
    }

    const sees = this.monsterSees(mon);
    if (sees) {
      if (dist <= 1) {
        this.monsterAttack(mon);
      } else {
        this.stepMonster(mon, 1);
      }
    } else if (this.rng.chance(0.25)) {
      this.stepMonster(mon, 0);
    }
  }

  monsterSees(mon: Monster): boolean {
    const player = this.player;
    if (player.invisible > 0) return false;
    const dist = Math.max(Math.abs(mon.x - player.x), Math.abs(mon.y - player.y));
    if (dist > 12) return false;
    const fov = computeFov(this.level, mon.x, mon.y, 12, { remember: false });
    return fov[index(player.x, player.y)] === 1;
  }

  /** 单步移动：direction 为 1 时靠近玩家，-1 时远离，0 时随机游走。 */
  stepMonster(mon: Monster, direction: number): void {
    const player = this.player;
    const options: { x: number; y: number; d: number; dx: number; dy: number; t: number }[] = [];
    for (const [dx, dy] of DIR8) {
      const nx = mon.x + dx;
      const ny = mon.y + dy;
      if (nx < 0 || ny < 0 || nx >= this.level.width || ny >= this.level.height) continue;
      const i = index(nx, ny);
      const t = this.level.tiles[i];
      if (!isWalkable(t)) continue;
      if (monsterAt(this.level, nx, ny)) continue;
      if (nx === player.x && ny === player.y) continue;
      const d = Math.max(Math.abs(nx - player.x), Math.abs(ny - player.y));
      options.push({ x: nx, y: ny, d, dx, dy, t });
    }
    if (!options.length) return;
    options.sort((a, b) => (direction >= 0 ? a.d - b.d : b.d - a.d));
    const choice = (
      direction === 0 ? this.rng.pick(options) : options[0]
    ) as (typeof options)[number];

    if (isDoor(choice.t)) {
      const door = this.level.doors.get(index(choice.x, choice.y));
      if (door && door.closed) {
        // 怪物可以推开门；体型较大的必定成功。
        if (mon.data.size === 'MZ_LARGE' || mon.data.size === 'MZ_HUGE' || this.rng.chance(0.5)) {
          door.closed = false;
          return;
        }
        return;
      }
    }
    mon.x = choice.x;
    mon.y = choice.y;
  }

  monsterAttack(mon: Monster): void {
    const player = this.player;
    let index2 = 0;
    for (const atk of mon.data.attacks) {
      if (this.dead) return;
      const [n, sides] = atk.dice;
      const meaningful = n > 0 && sides > 0;
      if (atk.at === 'AT_NONE' || !meaningful) {
        index2++;
        continue;
      }
      const { hit } = monsterHits(mon, player, index2, this.rng);
      index2++;
      if (!hit) {
        this.log('msg.monMisses', { mon: mon.data.id });
        continue;
      }
      let dmg = monsterDamage(mon, atk, this.rng);
      // NetHack 规则：玩家 AC 为负时减免伤害，而不是直接免伤。
      if (dmg > 0 && player.ac < 0) {
        dmg -= this.rng.rnd(-player.ac);
        if (dmg < 1) dmg = 1;
      }
      if (dmg <= 0) continue;
      const died = player.takeDamage(dmg);
      this.log('msg.monHits', { mon: mon.data.id, dmg });
      this.lastCombat = { monsterId: mon.id, hit: true, byPlayer: false, damage: dmg };
      if (died) {
        this.dead = true;
        log.warn('玩家死亡', { turn: this.turn, depth: this.depth, killer: mon.data.id });
        this.log('msg.youDie', { mon: mon.data.id });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 楼层切换
  // -------------------------------------------------------------------------

  changeDepth(depth: number, direction: 'up' | 'down'): ActionResultInfo {
    log.info('切换楼层', { from: this.depth, to: depth, direction, turn: this.turn });
    const target = this.getLevel(depth);
    let arrival = direction === 'down' ? target.up : target.down;
    if (!arrival) arrival = target.down ?? target.up ?? target.start ?? { x: 1, y: 1 };
    this.depth = depth;
    this.level = target;
    this.player.x = arrival.x;
    this.player.y = arrival.y;
    this.ensureLevelPopulation(target);
    this.log(direction === 'down' ? 'msg.descend' : 'msg.ascend', { depth });
    this.refreshFov();
    return { result: direction === 'down' ? 'descended' : 'ascended' };
  }

  /** 状态快照：供 HUD 与测试使用。 */
  /** 状态快照，供 HUD 与测试使用。 */
  get status(): SessionStatus {
    const p = this.player;
    return {
      depth: this.depth,
      turn: this.turn,
      hp: p.hp,
      maxHp: p.maxHp,
      pw: p.pw,
      maxPw: p.maxPw,
      ac: p.ac,
      level: p.level,
      xp: p.xp,
      nextXp: xpForLevel(p.level),
      gold: p.gold,
      kills: this.kills,
      role: p.role.id,
      race: p.race.id,
      align: p.align,
      dead: this.dead,
    };
  }
}
