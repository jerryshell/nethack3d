/**
 * 游戏会话：维护玩家、地牢、回合、怪物与战斗。
 *
 * 会话与语言无关：消息以「键 + 实体 ID」的形式记录，由界面负责翻译，
 * 因此切换语言后历史消息也会重新渲染。
 */

import type {
  ActionResultInfo,
  Alignment,
  Attributes,
  CharacterChoice,
  CombatFeedback,
  GameMessage,
  GroundPile,
  ItemInstance,
  Level,
  MessageVars,
  Monster,
  MonsterData,
  ObjectData,
  Room,
  Rng,
  SessionStatus,
} from '../types';
import type { UseOutcome } from './inventory';
import { trapEffect, trapNameKey } from './traps';
import { castFailChance, rollSpellAmount, spellProfile } from './spells';
import { createLogger, LOG_NS } from '../core/log';
import {
  generateLevel,
  generateBranchLevel,
  coords,
  index,
  inRoom,
  inShopRoom,
  shopRoom,
  QUEST_LAIR,
} from './dungeon';
import { computeFov } from './fov';
import { createRng, deriveSeed } from '../core/rng';
import {
  T,
  COLNO,
  MAX_DEPTH,
  HUNGER_DANGER,
  HUNGER_WARN,
  isWalkable,
  isDoor,
  isWall,
} from '../core/constants';
import { Player } from './player';
import { randomCharacter } from './roles';
import {
  heroHits,
  monsterHits,
  monsterHitsMonster,
  killExperience,
  monsterDamage,
  skillDamageBonus,
  skillHitBonus,
  equipmentRingBonus,
  xpForLevel,
} from './combat';
import type { ResistKind } from './resist';
import { monsterMagicResists, playerResists, halfDamageKinds } from './resist';
import {
  spawnMonsters,
  monsterAt,
  monsterSpeed,
  placeShopkeeper,
  pickMonsterType,
  Monster as MonsterEntity,
} from './monsters';
import {
  createAppearanceMap,
  describeItem,
  spawnObjects,
  makeGold,
  makeItem,
  nextItemId,
  randomItem,
  randomShopItem,
  stockShop,
  shopBuyPrice,
  shopSellPrice,
  INVOCATION_ITEMS,
} from './items';
import type { FeatureAction, FeatureEffect } from './features';
import { FEATURE_ACTIONS, rollFeatureEffect } from './features';
import { resolveWish } from './wish';
import { specialLevelById } from './special';
import type { SpecialLevel } from './special';
import { branchById, branchMaxDepth } from './branches';
import { clearBones, loadBones } from './bones';
import { deserializeItem } from './itemcodec';
import { containerCapacity, containerHasRoom, isContainer } from './containers';
import { findExploreTarget } from './path';
import type { Point } from './path';
import { artifactForRole } from './artifacts';
import { objById, monById, MONSTERS, monsterName } from '../data/index';
import { SOKOBAN_LEVELS } from '../data/sokoban.gen';
import {
  applyItem,
  addToInventory,
  autoPickupGold,
  drop as dropItem,
  invokeArtifact,
  pickup as pickupItems,
  removeFromInventory,
  removeItem,
  wearItem,
  wieldItem,
  equippedSlot,
  pileAt,
} from './inventory';

const log = createLogger(LOG_NS.session);

// 地牢总层数定义在 core/constants.ts；这里重新导出，保持原有引用路径可用。
export { MAX_DEPTH };

/** 创建会话的参数。 */
interface SessionOptions {
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

/** 神谕咨询的价格与提示条数。 */
const ORACLE_COST = 20;
const ORACLE_TIPS = 21;

/** 武器熟练度上限与每级所需使用次数。 */
const SKILL_MAX = 7;

/** 镐类工具凿穿一面墙或一层地板所需的默认回合数。 */
const DIG_TURNS = 3;
const SKILL_USES_PER_LEVEL = 8;

/** 宠物成长表：驯服度满值后进阶一次。 */
const PET_GROWTH: Record<string, string> = {
  KITTEN: 'LARGE_CAT',
  LITTLE_DOG: 'DOG',
  PONY: 'WARHORSE',
};

/** 阵营的数值符号：守序 +1、混沌 -1、中立 0。 */
function alignSign(align: Alignment): number {
  return align === 'lawful' ? 1 : align === 'chaotic' ? -1 : 0;
}

/** 元素与魔法攻击：抗性种类、命中消息、免伤消息。电击另算，因为它可以被反射。 */
const ELEMENTAL_ATTACKS: Record<string, [ResistKind, string, string]> = {
  AD_FIRE: ['fire', 'msg.hitFire', 'msg.resistFire'],
  AD_COLD: ['cold', 'msg.hitCold', 'msg.resistCold'],
  AD_ACID: ['acid', 'msg.hitAcid', 'msg.resistAcid'],
  AD_MAGM: ['magic', 'msg.hitMagic', 'msg.resistMagic'],
  AD_SPEL: ['magic', 'msg.hitMagic', 'msg.resistMagic'],
  AD_CLRC: ['magic', 'msg.hitMagic', 'msg.resistMagic'],
};

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
  /** 分支地牢的关卡，键为 `分支:层号`。 */
  branchCache: Map<string, Level>;
  depth: number;
  /** 当前所在分支；主地牢为 main。 */
  branch: string;
  /** 正在骑乘的宠物；不在关卡怪物列表里。 */
  ride: Monster | null = null;
  level: Level;

  /** 职业任务的楼梯是否已获领袖许可。 */
  questUnlocked = false;
  /** 是否已带着职业神器向领袖复命。 */
  questComplete = false;
  /** 尤恩多巫师是否抢走了护身符。 */
  wizardHasAmulet = false;
  /** 任务领袖是否已被杀死；对应原版 ok_to_quest 的 killed_leader 例外。 */
  questLeaderDead = false;
  /** 在商店里造成的修缮费，离店时与货款一起结算。 */
  shopDamage = 0;
  /** 已被灭绝的物种，不再生成。 */
  genocides = new Set<string>();
  /** 玩家读完灭绝卷轴后等待输入物种名。 */
  pendingGenocide = false;

  /** 最近一次战斗反馈，供界面播放受击动画。 */
  lastCombat: CombatFeedback | null = null;

  /** 当前正在进行的挖掘；目标或楼层一变就重置。 */
  digging: { x: number; y: number; down: boolean; progress: number } | null = null;

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
    this.branchCache = new Map();
    this.branch = 'main';
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
      this.spawnPet();
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

  /** 取一层分支地牢；同一 `(分支, 层号)` 只生成一次。 */
  getBranchLevel(branch: string, depth: number): Level {
    const key = `${branch}:${depth}`;
    if (!this.branchCache.has(key)) {
      const def = branchById(branch);
      this.branchCache.set(
        key,
        generateBranchLevel({
          gameSeed: this.seed,
          branch,
          depth,
          levels: def?.levels ?? depth,
          questRole: branch === 'quest' ? this.character.role.id : null,
        }),
      );
    }
    return this.branchCache.get(key) as Level;
  }

  /** 当前分支的最大层号。 */
  get maxDepth(): number {
    return this.branch === 'main' ? MAX_DEPTH : branchMaxDepth(this.branch);
  }

  /** 推箱分支禁止传送：原版的「神秘力量」挡住所有传送。 */
  get teleportBlocked(): boolean {
    return this.branch === 'sokoban';
  }

  ensureLevelPopulation(level: Level): void {
    if (level.populated) return;
    level.populated = true;
    const label = level.branch ? `${level.branch} 第 ${level.depth} 层` : `第 ${level.depth} 层`;
    const done = log.time(`${label} 放置生物与物品`);
    const special = specialLevelById(level.special);
    // 推箱层只放固定怪物，不随机刷怪与物品。
    if (level.branch === 'sokoban') {
      this.placeSokobanMonsters(level);
      done({
        monsters: level.monsters.length,
        piles: level.objects.length,
        special: level.special,
      });
      return;
    }
    const branchDef = branchById(level.branch);
    const branchTheme = branchDef?.monsterTheme;
    const theme = special?.monsterTheme ?? branchTheme;
    const quest = level.branch === 'quest' ? this.character.role.quest : null;
    // 分支的怪物难度跟着层数走：主题怪物的难度普遍高于同层主地牢。
    const themeBoost = (branchTheme || quest ? level.depth + 2 : 0) + (branchDef?.difficulty ?? 0);
    spawnMonsters(level, this.rng, {
      player: this.player,
      heroLevel: this.player.level + themeBoost,
      theme,
      symbols: quest?.enemies,
      exclude: this.genocides,
      count:
        special?.layout === 'bigRoom' ? Math.min(20, 8 + Math.floor(level.depth / 2)) : undefined,
    });
    spawnObjects(level, this.rng, level.depth, this.appearances);
    this.placeSpecialContent(level, special);
    this.placeBones(level);
    this.placeQuestContent(level);
    if (!level.branch && level.depth >= MAX_DEPTH) this.placeAmulet(level);
    if (level.branch && level.depth >= branchMaxDepth(level.branch)) {
      this.placeBranchReward(level);
    }
    // 商店的货物与店主用独立随机流，不扰动其它生成结果。
    const shopSeed = level.branch
      ? deriveSeed(this.seed, 'shop', level.branch, level.depth)
      : deriveSeed(this.seed, 'shop', level.depth);
    const shopRng = createRng(shopSeed);
    const shopStock = stockShop(level, shopRng, level.depth, this.appearances);
    if (shopRoom(level)) placeShopkeeper(level, shopRng);
    done({
      monsters: level.monsters.length,
      piles: level.objects.length,
      shopStock,
      special: level.special,
    });
  }

  /** 推箱层的固定怪物：原版顶层有两只伪装成巨石的巨型拟形怪。 */
  private placeSokobanMonsters(level: Level): void {
    const variant = SOKOBAN_LEVELS.find((l) => l.depth === level.depth)?.variants.find(
      (v) => v.id === level.sokobanVariant,
    );
    for (const spawn of variant?.monsters ?? []) {
      // 提取的是原版显示名（giant mimic），换成原型 id。
      const id = spawn.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      const data = monById.get(id);
      if (!data) continue;
      // 在固定地图的地面格上挑一个空位。
      const candidates: { x: number; y: number }[] = [];
      for (let i = 0; i < level.tiles.length; i++) {
        if (level.tiles[i] !== T.ROOM) continue;
        const x = i % COLNO;
        const y = Math.floor(i / COLNO);
        if (monsterAt(level, x, y)) continue;
        candidates.push({ x, y });
      }
      if (!candidates.length) continue;
      const spot = candidates[this.rng.rn2(candidates.length)];
      const mon = new MonsterEntity(data, spot.x, spot.y, this.rng);
      // 顶层两只巨型拟形怪伪装成巨石，像原版一样等玩家撞上来。
      if (data.id === 'GIANT_MIMIC') mon.disguise = 'BOULDER';
      level.monsters.push(mon);
    }
  }

  /** 职业任务线：总部放领袖与护卫，目标层放仇敌与职业神器。 */
  private placeQuestContent(level: Level): void {
    if (level.branch !== 'quest') return;
    const quest = this.character.role.quest;
    if (!quest) return;
    const goalDepth = branchMaxDepth('quest');
    if (level.depth >= goalDepth) {
      this.placeQuestGoal(level, quest);
      return;
    }
    // 搜索层：额外护卫与一小堆金币，让中段也有内容。
    if (level.depth === Math.ceil(goalDepth / 2)) {
      const guardProto = quest.guardian ? monById.get(quest.guardian) : null;
      if (guardProto) {
        const count = 2 + this.rng.rn2(3);
        for (let n = 0; n < count; n++) {
          const spot = this.farSpot(level, 4);
          if (!spot) break;
          const guard = new MonsterEntity(guardProto, spot.x, spot.y, this.rng);
          guard.asleep = false;
          level.monsters.push(guard);
        }
      }
      const loot = this.floorSpot(level);
      if (loot) {
        const gold = makeGold(this.rng, level.depth, 80 + this.rng.rn2(120));
        const pile = level.objects.find((p) => p.x === loot.x && p.y === loot.y);
        if (pile) pile.items.push(gold);
        else level.objects.push({ x: loot.x, y: loot.y, items: [gold] });
      }
      log.info('任务搜索层已布置', { role: this.player.role.id, depth: level.depth });
      return;
    }
    if (level.depth !== 1) return;
    // 领袖与护卫守在入口楼梯附近，玩家一进任务总部就能看到。
    const base = level.up ?? level.start ?? { x: level.width >> 1, y: level.height >> 1 };
    const leaderProto = monById.get(quest.leader);
    if (leaderProto) {
      const spot = this.spotNear(level, base, 3, 7);
      if (spot) {
        const leader = new MonsterEntity(leaderProto, spot.x, spot.y, this.rng);
        leader.asleep = false;
        level.monsters.push(leader);
      }
    }
    const guardProto = quest.guardian ? monById.get(quest.guardian) : null;
    if (guardProto) {
      const count = 2 + this.rng.rn2(3);
      for (let n = 0; n < count; n++) {
        const spot = this.spotNear(level, base, 2, 9);
        if (!spot) break;
        const guard = new MonsterEntity(guardProto, spot.x, spot.y, this.rng);
        guard.asleep = false;
        level.monsters.push(guard);
      }
    }
    log.info('任务总部已布置', { role: this.player.role.id, depth: level.depth });
  }

  /** 任务目标层：唤醒仇敌，把本职业神器放在它脚下，并让爪牙把守门口。 */
  private placeQuestGoal(level: Level, quest: { nemesis: string; enemies: string[] }): void {
    const nemesisProto = monById.get(quest.nemesis);
    const spot = this.questGoalSpot(level);
    if (!nemesisProto || !spot) return;
    const nemesis = new MonsterEntity(nemesisProto, spot.x, spot.y, this.rng);
    nemesis.asleep = false;
    level.monsters.push(nemesis);

    // 开启之铃由任务仇敌看守，是开启仪式所需的三件圣物之一。
    const loot: ItemInstance[] = [makeGold(this.rng, level.depth, 200 + this.rng.rn2(300))];
    const bellProto = objById.get('BELL_OF_OPENING');
    if (bellProto) {
      const bell = makeItem(bellProto, this.rng);
      bell.buc = 'uncursed';
      bell.known = true;
      loot.push(bell);
    }
    const def = artifactForRole(this.player.role.id);
    const proto = def ? objById.get(def.proto) : null;
    if (def && proto) {
      const item = makeItem(proto, this.rng);
      item.artifact = def.id;
      item.enchant = def.enchant;
      item.known = true;
      loot.push(item);
    }
    // 圣物、神器与一小堆金币垫在仇敌脚下，击败它就能拿走。
    const pile = level.objects.find((p) => p.x === spot.x && p.y === spot.y);
    if (pile) pile.items.push(...loot);
    else level.objects.push({ x: spot.x, y: spot.y, items: loot });
    // 仇敌的爪牙把守巢穴门口，玩家要先闯过这一关。
    const pool = MONSTERS.filter(
      (m) =>
        quest.enemies.includes(m.sym) &&
        m.freq > 0 &&
        !m.genFlags.includes('G_UNIQ') &&
        m.diff <= 22,
    );
    const doorX = (QUEST_LAIR.lx + QUEST_LAIR.hx) >> 1;
    const doorY = QUEST_LAIR.hy + 1;
    for (const post of [
      { x: doorX - 1, y: doorY + 1 },
      { x: doorX, y: doorY + 1 },
      { x: doorX + 1, y: doorY + 1 },
    ]) {
      if (!pool.length) break;
      if (!isWalkable(this.tileAt(post.x, post.y))) continue;
      if (monsterAt(this.level, post.x, post.y)) continue;
      const data = this.rng.pick(pool) as MonsterData;
      const guard = new MonsterEntity(data, post.x, post.y, this.rng);
      guard.asleep = false;
      level.monsters.push(guard);
    }
    log.info('任务神器已放置', { artifact: def?.id ?? null, nemesis: quest.nemesis, at: spot });
  }

  /** 任务目标层的落点：不进商店，尽量远离入口楼梯。 */
  private questGoalSpot(level: Level): { x: number; y: number } | null {
    // 任务目标层的仇敌守在巢穴里：只在室内挑落点，玩家要破门而入。
    const lair = level.special === 'quest_goal' ? QUEST_LAIR : null;
    const far: { x: number; y: number }[] = [];
    const near: { x: number; y: number }[] = [];
    for (let x = 1; x < level.width - 1; x++) {
      for (let y = 1; y < level.height - 1; y++) {
        const t = level.tiles[index(x, y)];
        if (t !== T.ROOM && t !== T.CORR) continue;
        if (inShopRoom(level, x, y)) continue;
        if (x === this.player.x && y === this.player.y) continue;
        if (monsterAt(level, x, y)) continue;
        const spot = { x, y };
        if (lair) {
          if (x < lair.lx || x > lair.hx || y < lair.ly || y > lair.hy) continue;
          near.push(spot);
          continue;
        }
        if (Math.abs(x - this.player.x) + Math.abs(y - this.player.y) >= 8) far.push(spot);
        else near.push(spot);
      }
    }
    const pool = far.length ? far : near;
    return pool.length ? (this.rng.pick(pool) as { x: number; y: number }) : null;
  }

  /** 在 `from` 周围 [min, max] 格内找一块空地面。 */
  private spotNear(
    level: Level,
    from: { x: number; y: number },
    min: number,
    max: number,
  ): { x: number; y: number } | null {
    const spots: { x: number; y: number }[] = [];
    for (let x = 1; x < level.width - 1; x++) {
      for (let y = 1; y < level.height - 1; y++) {
        const t = level.tiles[index(x, y)];
        if (t !== T.ROOM && t !== T.CORR) continue;
        const d = Math.max(Math.abs(x - from.x), Math.abs(y - from.y));
        if (d < min || d > max) continue;
        if (x === this.player.x && y === this.player.y) continue;
        if (monsterAt(level, x, y)) continue;
        if (inShopRoom(level, x, y)) continue;
        if (level.objects.some((p) => p.x === x && p.y === y)) continue;
        spots.push({ x, y });
      }
    }
    return spots.length ? (this.rng.pick(spots) as { x: number; y: number }) : null;
  }

  /** 背包里是否带着本职业的神器。 */
  carryingQuestArtifact(): boolean {
    const def = artifactForRole(this.player.role.id);
    if (!def) return false;
    return this.player.inventory.some((item) => item.artifact === def.id);
  }

  /**
   * 当前是否具备心灵感应：吃尸体的内在能力、ESP 护身符或心灵感应头盔。
   * 装备提供的感应随穿戴状态变化，不写入存档。
   */
  hasTelepathy(): boolean {
    if (this.player.telepathy) return true;
    if (this.player.equipment.amulet?.proto.power === 'TELEPAT') return true;
    return this.player.equipment.helm?.proto.id === 'HELM_OF_TELEPATHY';
  }

  /** 装备中是否有指定 power 的物品（戒指、护身符等）。 */
  hasEquipmentPower(power: string): boolean {
    return Object.values(this.player.equipment).some((item) => item?.proto.power === power);
  }

  /** 当前是否隐形：药水/陷阱的计时或隐形戒指。 */
  hasInvisibility(): boolean {
    return this.player.invisible > 0 || this.hasEquipmentPower('INVIS');
  }

  /** 当前是否浮空：浮空药水计时、浮空戒指或浮空靴；够不着楼梯。 */
  hasLevitation(): boolean {
    const p = this.player;
    return (
      p.levitating > 0 ||
      p.equipment.boots?.proto.id === 'LEVITATION_BOOTS' ||
      this.hasEquipmentPower('LEVITATION')
    );
  }

  /** 当前是否飞行：飞行护身符；与浮空同样飘在危险地表之上，但能正常上下楼梯。 */
  hasFlight(): boolean {
    return this.hasEquipmentPower('FLYING');
  }

  /** 飘在地表之上：可以越过虚空、液面并免触发地面陷阱。 */
  isFloating(): boolean {
    return this.hasLevitation() || this.hasFlight();
  }

  /** 当前形态是否会游泳或两栖；原形不会游泳，需要浮空过深水。 */
  playerSwims(): boolean {
    const form = this.player.formData;
    if (!form) return false;
    return form.flags.includes('M1_SWIM') || form.flags.includes('M1_AMPHIBIOUS');
  }

  /**
   * 与身边的职业任务领袖交谈。
   *
   * 第一次交谈获得下行许可；带着神器回来复命则标记任务完成。
   */
  talkToLeader(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const quest = this.character.role.quest;
    const leader = quest
      ? this.level.monsters.find(
          (m) =>
            !m.dead &&
            m.data.id === quest.leader &&
            Math.abs(m.x - this.player.x) <= 1 &&
            Math.abs(m.y - this.player.y) <= 1 &&
            (m.x !== this.player.x || m.y !== this.player.y),
        )
      : undefined;
    if (!quest || !leader) {
      this.log('msg.questNoLeader');
      return { result: 'nothing' };
    }
    if (leader.angry) {
      this.log('msg.questLeaderAngry', { mon: quest.leader });
      return { result: 'nothing' };
    }
    if (this.carryingQuestArtifact()) {
      if (!this.questComplete) {
        this.questComplete = true;
        // 首次复命给幸运与阵营奖励；重复交谈不再叠加。
        this.player.luck = Math.min(10, this.player.luck + 1);
        this.adjustAlign(5);
        this.log('msg.questThanks', {
          mon: quest.leader,
          artifact: this.questArtifactName(),
          nemesis: quest.nemesis,
          roleId: this.player.role.id,
        });
        log.info('职业任务完成', { role: this.player.role.id });
      } else {
        this.log('msg.questAlreadyDone', {
          mon: quest.leader,
          artifact: this.questArtifactName(),
          nemesis: quest.nemesis,
          roleId: this.player.role.id,
        });
      }
      return { result: 'nothing' };
    }
    if (!this.questUnlocked) {
      this.questUnlocked = true;
      this.log('msg.questBriefing', {
        mon: quest.leader,
        artifact: this.questArtifactName(),
        nemesis: quest.nemesis,
        roleId: this.player.role.id,
      });
      log.info('任务楼梯已解锁', { role: this.player.role.id });
    } else {
      this.log('msg.questKeepGoing', { mon: quest.leader, roleId: this.player.role.id });
    }
    return { result: 'nothing' };
  }

  /** 本职业神器的 id，供任务对白引用；没有时为空串。 */
  private questArtifactName(): string {
    return artifactForRole(this.player.role.id)?.id ?? '';
  }

  /** 任务仇敌首次照面时叫阵；同一只只叫一次。 */
  private maybeTaunt(mon: Monster): void {
    const quest = this.character.role.quest;
    if (!quest || quest.nemesis !== mon.data.id || mon.taunted) return;
    mon.taunted = true;
    this.log('msg.nemesisTaunt', { mon: mon.data.id, roleId: this.player.role.id });
  }

  /** 分支底层的额外宝藏与守关怪物。 */
  private placeBranchReward(level: Level): void {
    const def = branchById(level.branch);
    const loot = def?.loot;
    const spot = this.floorSpot(level) ?? this.farSpot(level, 2);
    if (spot && loot) {
      const pile = level.objects.find((p) => p.x === spot.x && p.y === spot.y);
      const items: ItemInstance[] = [
        makeGold(this.rng, level.depth, loot.gold + this.rng.rn2(loot.gold)),
      ];
      const gem = objById.get('DIAMOND');
      if (gem) {
        for (let n = 0; n < (loot.gems ?? 0); n++) items.push(makeItem(gem, this.rng));
      }
      for (let n = 0; n < (loot.items ?? 0); n++) {
        const item = randomItem(this.rng, level.depth, this.appearances);
        if (item) items.push(item);
      }
      // 矿坑底层的幸运石（原版 minend 的固定宝物，这里不给诅咒）。
      if (loot.luckstone) {
        const proto = objById.get('LUCKSTONE');
        if (proto) {
          const stone = makeItem(proto, this.rng);
          stone.buc = 'uncursed';
          stone.known = true;
          items.push(stone);
        }
      }
      // 巫妖塔底层的祈祷烛台：弗拉德看守的开启圣物。
      if (level.branch === 'vlad') {
        const proto = objById.get('CANDELABRUM_OF_INVOCATION');
        if (proto) {
          const candelabrum = makeItem(proto, this.rng);
          candelabrum.buc = 'uncursed';
          candelabrum.known = true;
          items.push(candelabrum);
        }
      }
      if (pile) pile.items.push(...items);
      else level.objects.push({ x: spot.x, y: spot.y, items });
    }
    // 底层守关的 BOSS：放在远处，不堵住楼梯。
    if (def?.boss) {
      const data = monById.get(def.boss);
      const bossSpot = this.farSpot(level, 8);
      if (data && bossSpot) {
        const boss = new MonsterEntity(data, bossSpot.x, bossSpot.y, this.rng);
        boss.asleep = false;
        level.monsters.push(boss);
      }
    }
    // 额外守军：围着宝藏摆放，不挡楼梯。
    if (def?.guards?.length) {
      const center = spot ?? this.farSpot(level, 6) ?? { x: this.player.x, y: this.player.y };
      for (const id of def.guards) {
        const data = monById.get(id);
        if (!data) continue;
        const guardSpot = this.spotNear(level, center, 1, 6);
        if (!guardSpot) continue;
        const guard = new MonsterEntity(data, guardSpot.x, guardSpot.y, this.rng);
        guard.asleep = false;
        level.monsters.push(guard);
      }
    }
    log.info('分支底层已布置', {
      branch: level.branch,
      depth: level.depth,
      boss: def?.boss,
      guards: def?.guards?.length ?? 0,
    });
  }

  /** 放置特殊楼层要求的怪物与物品。 */
  private placeSpecialContent(level: Level, special: SpecialLevel | null): void {
    if (!special) return;
    for (const id of special.monsters ?? []) {
      const data = monById.get(id);
      if (!data) continue;
      const spot = this.farSpot(level);
      if (!spot) continue;
      const mon = new MonsterEntity(data, spot.x, spot.y, this.rng);
      mon.asleep = false;
      level.monsters.push(mon);
    }
    this.placeAltarGuards(level, special);
    for (const entry of special.objects ?? []) {
      const proto = objById.get(entry.proto);
      if (!proto) continue;
      for (let n = 0; n < entry.count; n++) {
        const spot = this.floorSpot(level);
        if (!spot) break;
        const item = makeItem(proto, this.rng);
        // 开启圣物固定未诅咒，避免随机 BUC 让仪式变成死局。
        if (INVOCATION_ITEMS.has(proto.id)) {
          item.buc = 'uncursed';
          item.known = true;
        }
        const pile = level.objects.find((p) => p.x === spot.x && p.y === spot.y);
        if (pile) pile.items.push(item);
        else level.objects.push({ x: spot.x, y: spot.y, items: [item] });
      }
    }
  }

  /**
   * 圣坛守卫：每座祭坛旁站一只守卫，与祭坛同阵营的守卫对玩家友好，
   * 异教祭坛的守卫直接动手（星界位面的三座神殿各有一位天使）。
   */
  private placeAltarGuards(level: Level, special: SpecialLevel): void {
    if (!special.altarGuards) return;
    const data = monById.get(special.altarGuards);
    if (!data) return;
    for (const [i, feature] of level.features) {
      if (feature.type !== 'ALTAR') continue;
      const at = coords(i);
      for (let n = 0; n < 2; n++) {
        const at2 = this.spotNear(level, at, 1, 2);
        if (!at2) break;
        const guard = new MonsterEntity(data, at2.x, at2.y, this.rng);
        guard.asleep = false;
        // 同阵营神殿的天使只是守卫；异教神殿的天使直接动手。
        guard.peaceful = feature.align === this.player.align;
        guard.angry = false;
        level.monsters.push(guard);
      }
    }
  }

  /** 把上一局的遗物放到死亡层，并留下一只幽灵看守。 */
  private placeBones(level: Level): void {
    const bones = loadBones();
    if (!bones || bones.depth !== level.depth) return;
    // 一份骨头只会出现一次：取出即清，避免同层反复刷遗物。
    clearBones();
    const spot = this.floorSpot(level);
    if (spot) {
      const items = bones.inventory
        .map(deserializeItem)
        .filter((item): item is ItemInstance => item !== null);
      for (const item of items) {
        const pile = level.objects.find((p) => p.x === spot.x && p.y === spot.y);
        if (pile) pile.items.push(item);
        else level.objects.push({ x: spot.x, y: spot.y, items: [item] });
      }
      this.log('msg.bonesFound');
    }
    const ghostData = monById.get('GHOST');
    if (ghostData) {
      const ghostSpot = this.farSpot(level, 8) ?? spot;
      if (ghostSpot) {
        const ghost = new MonsterEntity(ghostData, ghostSpot.x, ghostSpot.y, this.rng);
        ghost.asleep = false;
        level.monsters.push(ghost);
        this.log('msg.bonesGhost');
      }
    }
    log.info('发现前任冒险者的遗物', { depth: level.depth, items: bones.inventory.length });
  }

  /** 在指定层找一块远离玩家的空地。 */
  private farSpot(level: Level, minDistance = 8): { x: number; y: number } | null {
    const spots: { x: number; y: number }[] = [];
    for (let x = 1; x < level.width - 1; x++) {
      for (let y = 1; y < level.height - 1; y++) {
        if (!isWalkable(level.tiles[index(x, y)])) continue;
        if (monsterAt(level, x, y)) continue;
        if (x === this.player.x && y === this.player.y) continue;
        if (inShopRoom(level, x, y)) continue;
        if (Math.abs(x - this.player.x) + Math.abs(y - this.player.y) < minDistance) continue;
        spots.push({ x, y });
      }
    }
    return spots.length ? (this.rng.pick(spots) as { x: number; y: number }) : null;
  }

  /** 在指定层找一块可放物品的地面。 */
  private floorSpot(level: Level): { x: number; y: number } | null {
    const spots: { x: number; y: number }[] = [];
    for (let x = 1; x < level.width - 1; x++) {
      for (let y = 1; y < level.height - 1; y++) {
        const t = level.tiles[index(x, y)];
        if (t !== T.ROOM && t !== T.CORR) continue;
        if (x === this.player.x && y === this.player.y) continue;
        if (inShopRoom(level, x, y)) continue;
        spots.push({ x, y });
      }
    }
    return spots.length ? (this.rng.pick(spots) as { x: number; y: number }) : null;
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
    const radius = this.player.isBlind ? 1 : undefined;
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
    // 受罚的铁球拖住脚步：每隔一回合才能移动一次。
    if (this.player.punished && this.player.punishedTurn % 2 === 1) {
      this.log('msg.punishedDrag');
      this.finishTurn();
      return { result: 'held' };
    }
    // 眩晕时会踉跄，白白浪费一次行动。
    if (this.player.stun > 0 && this.rng.chance(0.33)) {
      this.log('msg.stumble');
      this.finishTurn();
      return { result: 'moved' };
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
      // 宠物挡路时交换位置，避免把玩家堵在走廊里。
      if (mon.tame) {
        mon.x = this.player.x;
        mon.y = this.player.y;
        this.player.x = nx;
        this.player.y = ny;
        this.refreshFov();
        this.finishTurn();
        return { result: this.dead ? 'dead' : 'moved' };
      }
      const result = this.attackMonster(mon);
      this.finishTurn();
      return { result: this.dead ? 'dead' : result };
    }

    const t = this.tileAt(nx, ny);
    if (isDoor(t)) {
      const door = this.level.doors.get(index(nx, ny));
      if (door && door.closed) {
        if (door.locked) {
          // 沿用 NetHack 的踢门判定：按力量与等级掷骰，失败同样消耗一回合，
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
          // 踢门声会吵醒附近的怪物，对应原版 dokick 的 wake_nearby()。
          this.wakeNearby();
        } else {
          door.closed = false;
          this.log('msg.doorOpens');
        }
        // 门开后视野立刻改变，不能等下一次移动才重算。
        this.refreshFov();
        this.finishTurn();
        return { result: 'opened' };
      }
    }

    const levitating = this.isFloating();
    if (!isWalkable(t) && !(levitating && t === T.AIR)) {
      // 持握镐类工具时，向墙壁移动就是挖掘；要连续凿几回合才穿。
      if (isWall(t) && this.wieldingDigger()) {
        if (this.branch === 'sokoban') {
          this.digWall(nx, ny);
          this.finishTurn();
          return { result: 'blocked' };
        }
        const digKey = this.progressDigWall(nx, ny);
        this.refreshFov();
        this.finishTurn();
        return { result: 'moved', key: digKey };
      }
      return { result: 'blocked' };
    }

    // 巨石：推得动就推到身后一格，推不动就原地不动（不消耗回合）。
    const boulder = this.boulderAt(nx, ny);
    if (boulder) {
      const bx = nx + dx;
      const by = ny + dy;
      if (
        isWalkable(this.tileAt(bx, by)) &&
        !isDoor(this.tileAt(bx, by)) &&
        !this.boulderAt(bx, by) &&
        !monsterAt(this.level, bx, by)
      ) {
        // 巨石滚进洞里会连同洞一起消失（原版 dokick/单推规则）。
        const destIndex = index(bx, by);
        if (this.level.traps.get(destIndex)?.type === 'HOLE') {
          this.level.traps.delete(destIndex);
          boulder.items = boulder.items.filter((i) => i.id !== 'BOULDER');
          if (!boulder.items.length) {
            this.level.objects.splice(this.level.objects.indexOf(boulder), 1);
          }
          this.log('msg.boulderHole');
        } else {
          boulder.x = bx;
          boulder.y = by;
        }
        this.player.x = nx;
        this.player.y = ny;
        this.digging = null;
        this.refreshFov();
        this.finishTurn();
        return { result: this.dead ? 'dead' : 'moved' };
      }
      this.log('msg.boulderStuck');
      return { result: 'blocked' };
    }

    const shop = shopRoom(this.level);
    const enteredShop =
      !!shop &&
      !inRoom(shop, this.player.x, this.player.y) &&
      inRoom(shop, nx, ny) &&
      this.shopkeeperAlive();
    this.player.x = nx;
    this.player.y = ny;
    // 挪到新格子后，原本对着墙锯的进度作废。
    this.digging = null;
    if (enteredShop) this.log('msg.shopWelcome', { shop: shop?.shopType ?? 'general' });

    const gold = autoPickupGold(this.player, this.level);
    if (gold > 0) this.log('msg.gold', { n: gold });
    this.refreshFov();

    // 元素位面的地表：岩浆灼伤，水流与溺水由 upkeep 逐回合结算。
    const tileNow = this.tileAt(nx, ny);
    if (!levitating && tileNow === T.LAVA) {
      const rolled = this.rng.dice(2, 6);
      const resisted = playerResists(this.player).has('fire');
      const dmg = resisted ? Math.ceil(rolled / 2) : rolled;
      this.log(resisted ? 'msg.lavaResist' : 'msg.lavaBurn', { n: dmg });
      if (this.player.takeDamage(dmg)) {
        this.dead = true;
        return { result: 'dead' };
      }
    }

    // 踩中陷阱：可能受伤、被传走或掉到下一层。
    const displaced = this.springTrap(index(nx, ny));
    if (this.dead) return { result: 'dead' };
    if (displaced) {
      // 已经不在原格，楼梯判定失去意义。
      this.finishTurn();
      return { result: 'moved' };
    }

    let special: 'descend' | 'ascend' | 'branch' | null = null;
    if (t === T.STAIRS) {
      const stair = this.level.stairs.find((s) => s.x === nx && s.y === ny);
      if (stair?.dir === 'branch' && stair.branch) {
        special = 'branch';
      } else {
        const goingDown = this.level.down && nx === this.level.down.x && ny === this.level.down.y;
        const goingUp = this.level.up && nx === this.level.up.x && ny === this.level.up.y;
        if (goingDown && this.depth < this.maxDepth) special = 'descend';
        else if (goingUp) {
          // 分支第一层的上行楼梯回到主地牢的入口层。
          const def = branchById(this.branch);
          if (this.branch === 'main' ? this.depth > 1 : !!def && this.depth === 1)
            special = 'ascend';
        }
      }
    }

    // 浮空时够不着楼梯：要落地才能上下（飞行不受影响）。
    if (special && this.hasLevitation()) {
      this.log('msg.levitateStairs');
      this.finishTurn();
      return { result: 'moved' };
    }

    // 任务楼梯要等领袖下令才能下行。
    if (special === 'descend' && this.questDescentBlocked()) {
      this.log('msg.questLocked');
      return { result: 'blocked' };
    }
    if (special === 'branch') {
      const stair = this.level.stairs.find((s) => s.x === nx && s.y === ny);
      this.turn++;
      if (this.branch === 'main') {
        // 从主地牢进分支：推箱从底层进，其余分支从第一层进。
        const def = branchById(stair?.branch ?? 'main');
        this.changeDepth(def?.entryDepth ?? 1, 'down', stair?.branch ?? 'main');
      } else {
        // 分支里的「回主地牢」楼梯。
        const def = branchById(this.branch);
        this.changeDepth(def?.entranceDepth ?? 1, 'up', 'main');
      }
      this.monsterTurns();
      return { result: this.dead ? 'dead' : 'descended' };
    }
    if (special === 'descend') {
      this.turn++;
      this.changeDepth(this.depth + 1, 'down');
      this.monsterTurns();
      return { result: this.dead ? 'dead' : 'descended' };
    }
    if (special === 'ascend') {
      this.turn++;
      const def = branchById(this.branch);
      if (def && this.depth === 1) this.changeDepth(def.entranceDepth, 'up', 'main');
      else this.changeDepth(this.depth - 1, 'up');
      this.monsterTurns();
      return { result: this.dead ? 'dead' : 'ascended' };
    }

    this.finishTurn();
    return { result: this.dead ? 'dead' : 'moved' };
  }

  /**
   * 投掷一件物品：自动瞄准视野内最近的敌对怪物。
   *
   * 命中后造成武器伤害，物品落在目标格供回收；掷空时不消耗物品。
   */
  throwItem(item: ItemInstance, viaLauncher = false): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const target = this.nearestMonster(8);
    if (!target) {
      this.log('msg.throwNothing', { item: describeItem(item) });
      return { result: 'nothing' };
    }
    const { hit } = heroHits(this.player, target, this.rng, viaLauncher ? 2 : 0);
    if (!hit) {
      this.log('msg.throwMiss', { mon: target.data.id });
      this.takeOneAndDrop(item, target.x, target.y);
      this.finishTurn();
      return { result: 'used' };
    }
    const dice =
      item.proto.cls === 'weapon' || item.proto.cls === 'gem' ? (item.proto.dmg ?? '1d3') : '1d3';
    const dmg = Math.max(1, this.rng.rollDamage(dice) + this.player.damageBonus);
    target.mhp -= dmg;
    this.log(viaLauncher ? 'msg.fireHit' : 'msg.throwHit', {
      mon: target.data.id,
      obj: item.proto.id,
      dmg,
    });
    this.takeOneAndDrop(item, target.x, target.y);
    if (target.mhp <= 0) this.slayMonster(target, true);
    this.finishTurn();
    return { result: 'used' };
  }

  /** 用持握的弓弩射击；没有弩具时给出提示。 */
  fireItem(item: ItemInstance): ActionResultInfo {
    const weapon = this.player.weapon;
    if (!weapon || weapon.proto.kind !== 'BOW') {
      this.log('msg.needLauncher');
      return { result: 'nothing' };
    }
    return this.throwItem(item, true);
  }

  /** 从背包取出一件（一叠则拆一件），放到指定格。 */
  private takeOneAndDrop(item: ItemInstance, x: number, y: number): void {
    let dropped = item;
    if (item.quantity > 1) {
      item.quantity -= 1;
      dropped = { ...item, quantity: 1, uid: nextItemId() };
    } else {
      removeFromInventory(this.player, item);
    }
    const pile = pileAt(this.level, x, y);
    if (pile) pile.items.push(dropped);
    else this.level.objects.push({ x, y, items: [dropped] });
  }

  /** 把物品放进一个还有空间的容器；不指定时选背包里第一个可用的。 */
  putInContainer(item: ItemInstance, container: ItemInstance | null = null): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    if (isContainer(item)) {
      this.log('msg.noNest');
      return { result: 'nothing' };
    }
    const target = container ?? this.player.inventory.find((it) => containerHasRoom(it));
    if (!target || !isContainer(target)) {
      this.log('msg.noContainer');
      return { result: 'nothing' };
    }
    const contents = (target.contents ??= []);
    if (contents.length >= containerCapacity(target)) {
      this.log('msg.containerFull', { item: describeItem(target) });
      return { result: 'nothing' };
    }
    removeFromInventory(this.player, item);
    contents.push(item);
    this.log('msg.putIn', {
      item: describeItem(item),
      container: describeItem(target),
    });
    this.finishTurn();
    return { result: 'used' };
  }

  /** 打开容器：取出全部内容；诅咒的容器打不开，口袋袋会放出怪物。 */
  openContainer(item: ItemInstance): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    if (!isContainer(item)) return { result: 'nothing' };
    if (item.buc === 'cursed') {
      this.log('msg.containerStuck', { item: describeItem(item) });
      return { result: 'nothing' };
    }
    if (item.proto.id === 'BAG_OF_TRICKS') {
      this.releaseBagOfTricks(item);
      this.finishTurn();
      return { result: 'used' };
    }
    const contents = item.contents ?? [];
    if (!contents.length) {
      this.log('msg.containerEmpty', { item: describeItem(item) });
      return { result: 'nothing' };
    }
    for (const it of contents) {
      if (!addToInventory(this.player, it).ok) this.dropAtPlayer(it);
    }
    item.contents = [];
    this.log('msg.containerOpen', { count: contents.length });
    this.finishTurn();
    return { result: 'used' };
  }

  /** 搜刮脚下的容器：内容倒到地面，玩家可以再捡。 */
  lootContainer(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const pile = pileAt(this.level, this.player.x, this.player.y);
    const container = pile?.items.find((item) => isContainer(item));
    if (!container) {
      this.log('msg.noContainerHere');
      return { result: 'nothing' };
    }
    if (container.buc === 'cursed') {
      this.log('msg.containerStuck', { item: describeItem(container) });
      return { result: 'nothing' };
    }
    if (container.proto.id === 'BAG_OF_TRICKS') {
      this.releaseBagOfTricks(container);
      this.finishTurn();
      return { result: 'used' };
    }
    const contents = container.contents ?? [];
    if (!contents.length) {
      this.log('msg.containerEmpty', { item: describeItem(container) });
      return { result: 'nothing' };
    }
    container.contents = [];
    for (const it of contents) this.dropAtPlayer(it);
    this.log('msg.containerLoot', { count: contents.length });
    this.finishTurn();
    return { result: 'used' };
  }

  /** 口袋袋：清空内容并在身边放出一只本层难度的怪物。 */
  private releaseBagOfTricks(item: ItemInstance): void {
    item.contents = [];
    const data = pickMonsterType(this.rng, this.depth, this.player.level);
    if (!data) return;
    const spot = DIR8.map(([dx, dy]) => ({
      x: this.player.x + dx,
      y: this.player.y + dy,
    })).find((p) => this.freeSpot(p.x, p.y));
    if (spot) {
      const mon = new MonsterEntity(data, spot.x, spot.y, this.rng);
      mon.asleep = false;
      this.level.monsters.push(mon);
    }
    this.log('msg.bagOfTricks', { mon: data.id });
  }

  /** 身边可以骑乘的宠物；没有时返回 null。 */
  canMount(): Monster | null {
    if (this.ride) return null;
    return (
      this.level.monsters.find(
        (m) =>
          m.tame &&
          !m.dead &&
          m.data.size !== 'MZ_TINY' &&
          m.data.size !== 'MZ_SMALL' &&
          Math.max(Math.abs(m.x - this.player.x), Math.abs(m.y - this.player.y)) <= 1 &&
          (m.x !== this.player.x || m.y !== this.player.y),
      ) ?? null
    );
  }

  /** 骑上身边的中大型宠物。 */
  mountPet(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    if (this.ride) {
      this.log('msg.alreadyRiding');
      return { result: 'nothing' };
    }
    const pet = this.canMount();
    if (!pet) {
      this.log('msg.noMount');
      return { result: 'nothing' };
    }
    const slot = this.level.monsters.indexOf(pet);
    if (slot >= 0) this.level.monsters.splice(slot, 1);
    this.ride = pet;
    this.log('msg.mounted', { mon: pet.data.id });
    this.finishTurn();
    return { result: 'used' };
  }

  /** 下马：把坐骑放到身边的空地。 */
  dismount(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const mount = this.ride;
    if (!mount) {
      this.log('msg.notRiding');
      return { result: 'nothing' };
    }
    const spot = DIR8.map(([dx, dy]) => ({ x: this.player.x + dx, y: this.player.y + dy })).find(
      (p) => this.freeSpot(p.x, p.y),
    );
    if (!spot) {
      this.log('msg.noRoomDismount');
      return { result: 'nothing' };
    }
    mount.x = spot.x;
    mount.y = spot.y;
    mount.mv = 0;
    this.level.monsters.push(mount);
    this.ride = null;
    this.log('msg.dismounted', { mon: mount.data.id });
    this.finishTurn();
    return { result: 'used' };
  }

  /** 玩家是否带着尤恩多护身符。 */
  get carryingAmulet(): boolean {
    return this.player.inventory.some((item) => item.proto.id === 'AMULET_OF_YENDOR');
  }

  /** 夺宝后放出追击者：每层最多一只尤恩多巫师。 */
  private spawnAmuletHunter(): void {
    if (this.level.monsters.some((m) => !m.dead && m.data.id === 'WIZARD_OF_YENDOR')) return;
    const data = monById.get('WIZARD_OF_YENDOR');
    if (!data) return;
    const spot = this.farSpot(this.level, 6);
    if (!spot) return;
    const wizard = new MonsterEntity(data, spot.x, spot.y, this.rng);
    wizard.asleep = false;
    this.level.monsters.push(wizard);
    this.log('msg.wizardComes');
  }

  /** 原地等待一回合。 */
  /**
   * 搜索附近的隐藏陷阱。
   *
   * 对应原版的搜索命令：逐格判定是否发现未见过的陷阱，
   * 运气好更容易发现；已经见过的陷阱不再重复判定。
   */
  searchAction(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const chance = 0.35 + Math.max(0, this.player.luck) * 0.02;
    let found = 0;
    const spots: [number, number][] = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    for (const [dx, dy] of spots) {
      const i = index(this.player.x + dx, this.player.y + dy);
      const trap = this.level.traps.get(i);
      if (!trap || trap.seen) continue;
      if (this.rng.chance(chance)) {
        trap.seen = true;
        found++;
      }
    }
    if (found > 0) this.log('msg.searchFound', { n: found });
    else this.log('msg.searchNothing');
    this.finishTurn();
    return { result: 'used', key: found > 0 ? 'msg.searchFound' : undefined };
  }

  /** 脚下或相邻已知陷阱的下标；没有可拆的目标时返回 null。 */
  disarmTarget(): { tile: number; type: string } | null {
    const at = (dx: number, dy: number) => {
      const tile = index(this.player.x + dx, this.player.y + dy);
      const trap = this.level.traps.get(tile);
      if (!trap || !trap.seen) return null;
      // 传送门与振动方块是流程机关，不能拆。
      if (trap.type === 'MAGIC_PORTAL' || trap.type === 'VIBRATING_SQUARE') return null;
      return { tile, type: trap.type };
    };
    const offsets: [number, number][] = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    for (const [dx, dy] of offsets) {
      const found = at(dx, dy);
      if (found) return found;
    }
    return null;
  }

  /**
   * 解除陷阱：对脚下或相邻的已知陷阱动手，失败只浪费一回合。
   *
   * 成功率沿用原版 untrap_prob() 的门限：基础 1/3，
   * 失明/混乱加一级难度，眩晕加两级，盗贼与游侠更熟练。
   */
  untrapAction(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const target = this.disarmTarget();
    if (!target) {
      this.log('msg.untrapNone');
      return { result: 'nothing' };
    }
    let chance = 3;
    if (this.player.isBlind || this.player.confused > 0) chance++;
    if (this.player.stun > 0) chance += 2;
    if (this.player.role.id === 'ROGUE' || this.player.role.id === 'RANGER') chance--;
    if (chance < 1) chance = 1;
    const trapName = trapNameKey(target.type);
    if (this.rng.rn2(chance) === 0) {
      this.level.traps.delete(target.tile);
      this.log('msg.untrapDone', { trap: trapName });
    } else {
      this.log('msg.untrapFail', { trap: trapName });
    }
    this.finishTurn();
    return { result: 'used' };
  }

  wait(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    this.finishTurn();
    return { result: this.dead ? 'dead' : 'waited' };
  }

  /** 玩家动作结束后依次执行怪物阶段与结算。 */
  finishTurn(): void {
    this.turn++;
    // 手里有未付款货品却已经离开商店，先结账或转为偷窃。
    this.settleShopDebt();
    // 加速：省掉这次怪物行动，多给玩家一次行动。
    if (this.player.hasted > 0) {
      this.player.hasted--;
      this.upkeep();
      return;
    }
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
    // 浮空时从地面陷阱上方飘过；魔法传送门例外，否则终局会被浮空卡死。
    if (this.isFloating() && trap.type !== 'MAGIC_PORTAL') {
      trap.seen = true;
      this.log('msg.levitateTrap', { trap: trapName });
      return false;
    }
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
      case 'polymorph': {
        const res = this.polymorph();
        if (res.changed) this.log(effect.message, { trap: trapName, mon: res.monId ?? undefined });
        else this.log(res.blocked ? 'msg.polyUnchanging' : 'msg.polyNothing');
        break;
      }
      case 'rust': {
        const suit = this.player.equipment.suit;
        // 涂过油的护甲躲过一劫，油脂随之耗掉。
        if (suit?.greased) {
          suit.greased = false;
          this.log('msg.greaseSaves', { obj: suit.proto.id });
          break;
        }
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
        if (this.teleportBlocked) {
          this.log('msg.teleportBlocked');
          break;
        }
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
        if (this.teleportBlocked) {
          this.log('msg.teleportBlocked');
          break;
        }
        const delta = this.rng.rn2(3) - 1 || 1;
        const target = Math.max(1, Math.min(MAX_DEPTH, this.depth + delta));
        // 任务总部的下行封锁同样拦住楼层传送。
        if (target > this.depth && this.questDescentBlocked()) {
          this.log('msg.questLocked');
          break;
        }
        this.log(effect.message, { trap: trapName, depth: target });
        this.changeDepth(target, target > this.depth ? 'down' : 'up');
        moved = true;
        break;
      }
      case 'hole': {
        if (this.depth < MAX_DEPTH && !this.questDescentBlocked()) {
          this.log(effect.message, { trap: trapName });
          this.changeDepth(this.depth + 1, 'down');
          moved = true;
        } else if (this.questDescentBlocked()) {
          // 地洞也被神秘力量封住：人留在原地，洞照旧已发现。
          this.log('msg.questLocked');
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
          if (this.teleportBlocked) {
            this.log('msg.teleportBlocked');
            break;
          }
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
      // 雕像陷阱：雕像活过来，在旁边的空地上生成一只敌对怪物。
      case 'statue': {
        this.log(effect.message, { trap: trapName });
        const data = pickMonsterType(this.rng, this.depth + 2, this.player.level);
        if (data) {
          const at = coords(tile);
          const spots = [
            [at.x + 1, at.y],
            [at.x - 1, at.y],
            [at.x, at.y + 1],
            [at.x, at.y - 1],
          ].filter(([x, y]) => isWalkable(this.tileAt(x, y)) && !monsterAt(this.level, x, y));
          const spot = spots.length ? (this.rng.pick(spots) as [number, number]) : null;
          if (spot) {
            const mon = new MonsterEntity(data, spot[0], spot[1], this.rng);
            mon.asleep = false;
            this.level.monsters.push(mon);
          }
        }
        break;
      }
      // 魔法传送门：通往异界的入口，踩上去立刻换层。
      case 'portal': {
        this.log(effect.message, { trap: trapName });
        this.changeDepth(branchById('planes')?.entryDepth ?? 1, 'down', 'planes');
        moved = true;
        break;
      }
      default: {
        this.log(effect.message, { trap: trapName });
        break;
      }
    }
    return moved;
  }

  /** 随机挑一个可站立且没有生物的地面格，用于传送类效果。 */
  randomFloorTile(): { x: number; y: number } | null {
    const candidates: number[] = [];
    for (let i = 0; i < this.level.tiles.length; i++) {
      const t = this.level.tiles[i];
      if (t !== T.ROOM && t !== T.CORR) continue;
      const x = i % COLNO;
      const y = Math.floor(i / COLNO);
      if (x === this.player.x && y === this.player.y) continue;
      if (monsterAt(this.level, x, y)) continue;
      candidates.push(i);
    }
    if (!candidates.length) return null;
    const pick = candidates[this.rng.rn2(candidates.length)];
    return { x: pick % COLNO, y: Math.floor(pick / COLNO) };
  }

  upkeep(): void {
    if (this.dead) return;
    const p = this.player;
    // 与 NetHack 一致的缓慢回复；患病时停止回复，并且周期性掉血。
    // 医神之杖在手或戴回复戒指时回复加倍。
    const regenRate =
      p.weapon?.artifact === 'staff_of_aesculapius' || this.hasEquipmentPower('REGENERATION')
        ? 10
        : 20;
    if (p.sick === 0) {
      if (this.turn % regenRate === 0 && p.hp < p.maxHp) p.hp++;
    } else {
      p.sick--;
      if (this.turn % 5 === 0) {
        p.takeDamage(1);
        if (p.dead) {
          this.dead = true;
          this.log('msg.sickDies');
          log.warn('玩家病死', { turn: this.turn, depth: this.depth });
          return;
        }
        this.log('msg.sickPulse');
      }
      if (p.sick === 0) this.log('msg.sickRecovered');
    }
    if (this.turn % 15 === 0 && p.pw < p.maxPw) p.pw++;

    // 计时状态递减。
    if (p.punished) p.punishedTurn++;
    if (p.levitating > 0) {
      p.levitating--;
      if (p.levitating === 0) this.log('msg.levitateEnd');
    }
    // 深水：浮空、会游泳的形态或水上行走装备才能免除溺水。
    const watery =
      this.tileAt(p.x, p.y) === T.WATER ||
      this.tileAt(p.x, p.y) === T.POOL ||
      this.tileAt(p.x, p.y) === T.MOAT;
    if (watery && !this.isFloating() && !this.playerSwims()) {
      p.drowning++;
      const dmg = this.rng.dice(1, 6);
      this.log('msg.drowning', { n: dmg });
      if (p.takeDamage(dmg)) {
        this.dead = true;
        this.log('msg.drownDies');
        log.warn('玩家溺死', { turn: this.turn, depth: this.depth });
        return;
      }
    } else if (p.drowning > 0) {
      p.drowning = 0;
    }
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
    if (p.stun > 0) p.stun--;
    if (p.senseMonsters > 0) p.senseMonsters--;
    if (p.senseObjects > 0) p.senseObjects--;
    if (p.senseGold > 0) p.senseGold--;
    if (p.senseFood > 0) p.senseFood--;
    // 搜索戒指：每 10 回合显露身边 2 格内的陷阱。
    if (this.hasEquipmentPower('SEARCHING') && this.turn % 10 === 0) {
      for (const [i, trap] of this.level.traps) {
        const at = coords(i);
        if (Math.max(Math.abs(at.x - p.x), Math.abs(at.y - p.y)) <= 2) trap.seen = true;
      }
    }
    if (p.form) {
      p.form.turns--;
      if (p.form.turns <= 0) {
        p.form = null;
        this.log('msg.polyEnd');
      }
    } else if (this.hasEquipmentPower('POLYMORPH') && this.rng.rn2(20) === 0) {
      // 变形戒指：佩戴且未变形时，偶尔变成随机怪物形态。
      const res = this.polymorph();
      if (res.changed) this.log('msg.polyRing', { mon: res.monId ?? '' });
    }
    // 传送症或传送戒指：偶尔不受控地随机传走。
    if ((p.teleportitis || this.hasEquipmentPower('TELEPORT')) && this.rng.rn2(85) === 0) {
      if (this.teleportBlocked) {
        this.log('msg.teleportBlocked');
      } else {
        const spot = this.randomFloorTile();
        if (spot) {
          p.x = spot.x;
          p.y = spot.y;
          this.refreshFov();
          this.log('msg.teleportitis');
        }
      }
    }
    if (p.prayerTimeout > 0) p.prayerTimeout--;
    // 石化倒计时：归零即变成石头，完全治疗药水可以解除。
    if (p.petrifying > 0) {
      p.petrifying--;
      if (p.petrifying === 0) {
        p.takeDamage(p.hp);
        this.dead = true;
        this.log('msg.petrified');
        log.warn('玩家石化死亡', { turn: this.turn, depth: this.depth });
        return;
      }
      this.log('msg.petrifyingSoon');
    }

    // 商店每隔 200 回合补一件货。
    const shop = shopRoom(this.level);
    if (shop) {
      if (this.level.shopRestockAt === undefined) {
        this.level.shopRestockAt = this.turn + 200;
      } else if (this.turn >= this.level.shopRestockAt) {
        this.level.shopRestockAt = this.turn + 200;
        if (this.restockShopOnce(shop)) this.log('msg.shopRestocks');
      }
    }

    // 饱食度：900 为饱腹；150、40、0 三个阈值沿用 NetHack。
    // 缓慢消化戒指隔回合消耗，饥饿戒指加倍消耗。
    if (this.hasEquipmentPower('HUNGER')) p.hunger -= 2;
    else if (this.hasEquipmentPower('SLOW_DIGESTION')) {
      if (this.turn % 2 === 0) p.hunger--;
    } else p.hunger--;
    if (p.hunger <= 0 && this.turn % 20 === 0) {
      this.log('use.fainting');
      p.takeDamage(1);
      if (p.dead) {
        this.dead = true;
        this.log('msg.starved');
      }
    } else if (p.hunger <= HUNGER_DANGER && p.hunger > HUNGER_DANGER - 1) {
      this.log('use.weak');
    } else if (p.hunger <= HUNGER_WARN && p.hunger > HUNGER_WARN - 1) {
      this.log('use.hunger');
    }

    // 火之位面本身就是熔炉：没有火焰抗性会被热浪灼伤。
    if (this.branch === 'planes' && this.level.special === 'plane_fire') {
      if (!playerResists(p).has('fire')) {
        const dmg = this.rng.dice(1, 6);
        this.log('msg.planeHeat', { n: dmg });
        if (p.takeDamage(dmg)) {
          this.dead = true;
          this.log('msg.burnedToDeath');
          log.warn('玩家被平面热浪烧死', { turn: this.turn, depth: this.depth });
          return;
        }
      }
    }

    this.petUpkeep();
  }

  /** 宠物也会饿：饿到 0 会野生化，坐骑先落地再野生化。 */
  private petUpkeep(): void {
    for (const pet of this.level.monsters) {
      if (!pet.tame || pet.dead) continue;
      pet.hunger = (pet.hunger ?? 900) - 1;
      if (pet.hunger === 100) this.log('msg.petHungry', { mon: pet.data.id });
      if (pet.hunger <= 0) {
        pet.tame = false;
        pet.tameness = 0;
        this.log('msg.petTurnsWild', { mon: pet.data.id });
      }
    }
    const mount = this.ride;
    if (!mount || !mount.tame) return;
    mount.hunger = (mount.hunger ?? 900) - 1;
    if (mount.hunger === 100) this.log('msg.petHungry', { mon: mount.data.id });
    if (mount.hunger > 0) return;
    const spot = DIR8.map(([dx, dy]) => ({ x: this.player.x + dx, y: this.player.y + dy })).find(
      (p) => this.freeSpot(p.x, p.y),
    );
    if (!spot) {
      mount.hunger = 1;
      return;
    }
    mount.tame = false;
    mount.tameness = 0;
    mount.x = spot.x;
    mount.y = spot.y;
    mount.mv = 0;
    this.level.monsters.push(mount);
    this.ride = null;
    this.log('msg.petTurnsWild', { mon: mount.data.id });
  }

  // -------------------------------------------------------------------------
  // 战斗：玩家进攻
  // -------------------------------------------------------------------------

  attackMonster(mon: Monster): 'attacked' | 'killed' {
    const player = this.player;
    mon.asleep = false;
    this.maybeTaunt(mon);
    // 攻击伪装的拟形怪会先把它戳破。
    if (mon.disguise) {
      mon.disguise = null;
      this.log('msg.mimicRevealed', { mon: mon.data.id });
    }
    // 攻击自己的宠物会让它不再信任你。
    if (mon.tame) {
      mon.tame = false;
      this.log('msg.petBetrayed', { mon: mon.data.id });
    }
    // 捅了和平生物就等于宣战，店主还会记仇。
    if (this.isPeaceful(mon)) {
      mon.angry = true;
      if (mon.data.id === 'SHOPKEEPER') this.log('msg.shopkeeperAngry');
    }
    // 打任务领袖或护卫会让整个总部翻脸。
    const quest = this.character.role.quest;
    if (
      quest &&
      this.branch === 'quest' &&
      (mon.data.id === quest.leader || mon.data.id === quest.guardian)
    ) {
      for (const other of this.level.monsters) {
        if (other.dead) continue;
        if (other.data.id === quest.leader || other.data.id === quest.guardian) {
          other.angry = true;
          other.asleep = false;
        }
      }
      this.log('msg.questBetrayed');
    }
    // 武器附魔参与命中与伤害；变形时用形态天然武器，不算手持附魔。
    const enchant = player.form ? 0 : (player.weapon?.enchant ?? 0);
    // 祝福武器对亡者与恶魔更有效：命中 +2、伤害 +1d4（weapon.c）。
    const hatesBlessings =
      !player.form &&
      player.weapon?.buc === 'blessed' &&
      (mon.data.flags.includes('M2_UNDEAD') || mon.data.flags.includes('M2_DEMON'));
    // 银制武器克制狼人、吸血鬼、恶魔、小恶魔与幽影：伤害 +1d20。
    const hatesSilver =
      !player.form &&
      player.weapon?.proto.material === 'SILVER' &&
      (mon.data.flags.includes('M2_WERE') ||
        mon.data.sym === 'S_VAMPIRE' ||
        mon.data.flags.includes('M2_DEMON') ||
        (mon.data.sym === 'S_IMP' && mon.data.id !== 'TENGU') ||
        mon.data.id === 'SHADE');
    const { hit } = heroHits(
      player,
      mon,
      this.rng,
      skillHitBonus(this.weaponSkillLevel()) + enchant + (hatesBlessings ? 2 : 0),
    );
    // 变形后徒手使用天然武器，手持的锋刃不再参与战斗。
    const weaponId = player.form ? null : (player.weapon?.id ?? null);

    if (!hit) {
      this.log('msg.youMiss', { mon: mon.data.id });
      this.lastCombat = { monsterId: mon.id, hit: false, byPlayer: true };
      return 'attacked';
    }

    const spec = player.weaponDamageSpec(mon.data.size);
    let dmg =
      this.rng.rollDamage(spec) +
      player.damageBonus +
      skillDamageBonus(this.weaponSkillLevel()) +
      equipmentRingBonus(player, 'RIN_INCREASE_DAMAGE') +
      (player.form ? 0 : (player.weapon?.enchant ?? 0));
    if (hatesBlessings) dmg += this.rng.rnd(4);
    if (hatesSilver) dmg += this.rng.rnd(20);
    dmg = Math.max(1, dmg);
    // 骑乘冲锋：追加坐骑天然攻击的伤害。
    let mountDmg = 0;
    if (this.ride) {
      const atk = this.ride.data.attacks.find((a) => a.dice[0] > 0 && a.dice[1] > 0);
      if (atk) {
        mountDmg = Math.max(1, this.rng.rollDamage(`${atk.dice[0]}d${atk.dice[1]}`));
        dmg += mountDmg;
      }
    }
    mon.mhp -= dmg;
    this.log(weaponId ? 'msg.youHitWith' : 'msg.youHit', {
      mon: mon.data.id,
      obj: weaponId,
      dmg,
    });
    if (mountDmg > 0) this.log('msg.mountStrike', { mon: mon.data.id, dmg: mountDmg });
    this.gainSkillUse(this.weaponSkill(), this.player.weapon?.proto.id ?? null);
    this.lastCombat = { monsterId: mon.id, hit: true, byPlayer: true, damage: dmg };

    if (mon.mhp <= 0) {
      this.slayMonster(mon, true);
      return 'killed';
    }
    this.passiveAttack(mon);
    return 'attacked';
  }

  /**
   * 玩家近战命中怪物后结算它的被动攻击（AT_NONE）。
   *
   * 手持武器或戴手套时石化被隔开；其它被动效果照常触发。
   */
  private passiveAttack(mon: Monster): void {
    const resists = playerResists(this.player);
    for (const atk of mon.data.attacks) {
      if (this.dead) return;
      if (atk.at !== 'AT_NONE') continue;
      if (mon.cancelled && atk.ad !== 'AD_PHYS') continue;
      // 浮游眼这类被动目光同样要求「看得见」才生效。
      if (this.player.isBlind && atk.ad === 'AD_PLYS') continue;
      if (atk.ad === 'AD_STON' && (this.player.weapon || this.player.equipment.gloves)) continue;
      this.resolveAttack(mon, atk.ad, atk.dice, resists);
    }
  }

  /** 当前持握武器的技能名；变形或徒手时为空。 */
  private weaponSkill(): string | null {
    if (this.player.form) return null;
    return this.player.weapon?.proto.skill ?? null;
  }

  /** 当前武器技能的熟练度等级。 */
  private weaponSkillLevel(): number {
    const skill = this.weaponSkill();
    return skill ? (this.player.skillLevels[skill] ?? 0) : 0;
  }

  /** 法术流派熟练度等级。 */
  private spellSkillLevel(proto: ObjectData): number {
    const skill = proto.spellClass ?? null;
    return skill ? (this.player.skillLevels[skill] ?? 0) : 0;
  }

  /**
   * 记录一次成功的使用；达到阈值时提升熟练度。
   *
   * 近战与施法共用同一张技能表，只是提示文案不同。
   */
  private gainSkillUse(
    skill: string | null,
    objId: string | null,
    kind: 'weapon' | 'spell' = 'weapon',
  ): void {
    if (!skill) return;
    const uses = (this.player.skillUses[skill] ?? 0) + 1;
    this.player.skillUses[skill] = uses;
    const level = this.player.skillLevels[skill] ?? 0;
    if (level >= SKILL_MAX) return;
    const need = SKILL_USES_PER_LEVEL * (level + 1);
    if (uses % need === 0) {
      this.player.skillLevels[skill] = level + 1;
      this.log(kind === 'spell' ? 'msg.spellSkillUp' : 'msg.skillUp', {
        obj: objId,
        level: level + 1,
      });
    }
  }

  /**
   * 结算一只怪物的死亡：经验、击杀计数与掉落。
   *
   * 近战与法术共用，避免两处各写一份。
   */
  slayMonster(mon: Monster, byPlayer = true): void {
    if (mon.dead) return;
    mon.dead = true;
    // 杀死任务领袖也解锁下行（原版 ok_to_quest 的 killed_leader 例外），
    // 但任务从此无法正常复命。
    const quest = this.character.role.quest;
    if (quest && mon.data.id === quest.leader) {
      this.questLeaderDead = true;
      log.info('任务领袖被击杀', { role: this.player.role.id });
    }
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
      this.adjustAlign(this.killAlignDelta(mon));
    }
    this.player.gainXp(xp, this.rng, (level: number) => {
      this.log('msg.levelUp', { level });
    });
    // 宠物死亡要单独提示，而不是普通的击杀消息。
    if (mon.tame) this.log('msg.petDies', { mon: mon.data.id });
    // 怪物死亡时有概率留下金币。
    if (this.rng.chance(0.35)) {
      const pile = pileAt(this.level, mon.x, mon.y);
      const gold = makeGold(this.rng, this.depth);
      if (pile) pile.items.push(gold);
      else this.level.objects.push({ x: mon.x, y: mon.y, items: [gold] });
    }
    // 巫师死亡时抢走的护身符会掉回原地。
    if (this.wizardHasAmulet && mon.data.id === 'WIZARD_OF_YENDOR') {
      this.wizardHasAmulet = false;
      const proto = objById.get('AMULET_OF_YENDOR');
      if (proto) {
        const item = makeItem(proto, this.rng);
        item.known = true;
        const pile = pileAt(this.level, mon.x, mon.y);
        if (pile) pile.items.push(item);
        else this.level.objects.push({ x: mon.x, y: mon.y, items: [item] });
        this.log('msg.amuletRecovered');
      }
    }
    this.maybeDropCorpse(mon);
  }

  /**
   * 会留尸体的怪物死亡时按概率留下尸体。
   *
   * 尸体记下怪物原型 id：营养与可赋予的内在抗性都在进食时从怪物数据推导。
   */
  private maybeDropCorpse(mon: Monster): void {
    const data = mon.data;
    if (data.genFlags.includes('G_NOCORPSE')) return;
    // 原版大部分怪物约一半概率留尸，这里沿用一半。
    if (!this.rng.chance(0.5)) return;
    const proto = objById.get('CORPSE');
    if (!proto) return;
    const item = makeItem(proto, this.rng);
    item.corpse = data.id;
    item.known = true;
    item.age = this.turn;
    const pile = pileAt(this.level, mon.x, mon.y);
    if (pile) pile.items.push(item);
    else this.level.objects.push({ x: mon.x, y: mon.y, items: [item] });
  }

  /** 视野范围内最近的怪物，用于需要选目标的法术。 */
  nearestMonster(maxDistance = 8): Monster | null {
    let best: Monster | null = null;
    let bestDistance = maxDistance + 1;
    for (const mon of this.level.monsters) {
      if (mon.mhp <= 0 || mon.tame) continue;
      // 需要看得见才能瞄准。
      if (this.visible && this.visible[index(mon.x, mon.y)] !== 1) continue;
      const dist = Math.max(Math.abs(mon.x - this.player.x), Math.abs(mon.y - this.player.y));
      if (dist < bestDistance) {
        bestDistance = dist;
        best = mon;
      }
    }
    return best;
  }

  /** 自动探索的下一处目标：最近的未探索边界，没有时返回 null。 */
  exploreTarget(exclude?: ReadonlySet<number>): Point | null {
    return findExploreTarget(
      this.level,
      { x: this.player.x, y: this.player.y },
      {
        levitating: this.isFloating(),
        exclude,
      },
    );
  }

  /** 视野内最近的敌对生物；自动探索与休息据此提前中止。 */
  hostileInSight(): Monster | null {
    if (!this.visible) return null;
    for (const mon of this.level.monsters) {
      if (mon.dead || mon.mhp <= 0 || mon.tame || this.isPeaceful(mon)) continue;
      if (this.visible[index(mon.x, mon.y)] === 1) return mon;
    }
    return null;
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

    if (this.rng.chance(castFailChance(this.player, level, this.spellSkillLevel(proto)))) {
      const lost = Math.max(1, Math.ceil(profile.cost / 2));
      this.player.pw = Math.max(0, this.player.pw - lost);
      this.log('msg.castFail', { n: lost });
      this.finishTurn();
      return { result: 'used', key: 'msg.castFail' };
    }
    this.player.pw -= profile.cost;
    // 成功施法累计该流派的熟练度。
    this.gainSkillUse(proto.spellClass ?? null, proto.id, 'spell');

    let key = 'msg.castNothing';
    const vars: Record<string, string | number> = { obj: proto.id };
    switch (profile.kind) {
      case 'attack': {
        const target = this.nearestMonster(8);
        if (!target) {
          // 力场类法术没有活目标时改为轰碎最近的巨石（原版力场法术的用法）。
          const boulder = this.nearestBoulder(8);
          if (boulder) {
            this.breakBoulder(boulder);
            key = 'msg.boulderBroken';
            break;
          }
          key = 'msg.castNoTarget';
          break;
        }
        const amount =
          rollSpellAmount(this.rng, profile) + skillDamageBonus(this.spellSkillLevel(proto));
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
          const amount =
            rollSpellAmount(this.rng, profile) * 2 + skillDamageBonus(this.spellSkillLevel(proto));
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
        vars.mon = target.data.id;
        if (monsterMagicResists(target.data, this.rng)) {
          key = 'msg.castResisted';
          break;
        }
        target.asleep = true;
        key = 'msg.castSleep';
        break;
      }
      case 'escape': {
        if (item.proto.id === 'SPE_LEVITATION') {
          this.player.levitating = Math.max(this.player.levitating, 10 + level);
          key = 'msg.castLevitate';
          break;
        }
        if (this.teleportBlocked) {
          key = 'msg.teleportBlocked';
          break;
        }
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
        // 物质法术：打开附近的门；没有门就什么都不发生。
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

  /** 拾取玩家所在格的全部物品，店里的货要先结账。 */
  /** 指定格子上的巨石堆；没有则返回 null。 */
  private boulderAt(x: number, y: number): GroundPile | null {
    const pile = this.level.objects.find((p) => p.x === x && p.y === y);
    if (!pile) return null;
    return pile.items.some((i) => i.id === 'BOULDER') ? pile : null;
  }

  /** 射程内最近的一堆巨石；物质法术用它当靶子。 */
  private nearestBoulder(range: number): GroundPile | null {
    let best: GroundPile | null = null;
    let bestD = Infinity;
    for (const pile of this.level.objects) {
      if (!pile.items.some((item) => item.id === 'BOULDER')) continue;
      const d = Math.max(Math.abs(pile.x - this.player.x), Math.abs(pile.y - this.player.y));
      if (d > range || d >= bestD) continue;
      best = pile;
      bestD = d;
    }
    return best;
  }

  /**
   * 轰碎一堆巨石。
   *
   * 推箱分支里破坏巨石会触怒关底的力量：幸运 -1，对应原版的 dokick 惩罚。
   */
  private breakBoulder(pile: GroundPile): void {
    pile.items = pile.items.filter((item) => item.id !== 'BOULDER');
    if (!pile.items.length) {
      const at = this.level.objects.indexOf(pile);
      if (at >= 0) this.level.objects.splice(at, 1);
    }
    if (this.branch === 'sokoban') {
      this.player.luck = Math.max(-10, this.player.luck - 1);
      this.log('msg.sokobanLuck');
    }
  }

  /** 瓦片结构变化时记录差异并递增版本号，渲染层据此重建网格。 */
  private markTilesChanged(tile: number): void {
    this.level.revision = (this.level.revision ?? 0) + 1;
    if (!this.level.changedTiles) this.level.changedTiles = new Set();
    this.level.changedTiles.add(tile);
  }

  /** 玩家是否持握挖掘工具（镐或矮人锹）。 */
  private wieldingDigger(): boolean {
    const id = this.player.weapon?.id;
    return id === 'PICK_AXE' || id === 'DWARVISH_MATTOCK';
  }

  /** 当前工具凿穿一层需要的回合数：矮人锹比普通镐快一回合。 */
  private digTurns(): number {
    return this.player.weapon?.id === 'DWARVISH_MATTOCK' ? DIG_TURNS - 1 : DIG_TURNS;
  }

  /**
   * 凿墙进度：对同一面墙连续凿 digTurns() 回合才会穿。
   *
   * 目标或方向一变就从头计起，最后一步交给 `digWall` 收尾。
   */
  private progressDigWall(x: number, y: number): string {
    const turns = this.digTurns();
    if (!this.digging || this.digging.down || this.digging.x !== x || this.digging.y !== y) {
      this.digging = { x, y, down: false, progress: 0 };
    }
    this.digging.progress++;
    // 凿石有声：原版每挥一次镐都会唤醒附近怪物。
    this.wakeNearby();
    if (this.digging.progress < turns) {
      this.log('msg.digWallProgress', { n: turns - this.digging.progress });
      return 'msg.digWallProgress';
    }
    this.digging = null;
    this.digWall(x, y);
    return 'msg.digWall';
  }

  /** 能否用镐向下挖：持镐站在普通地面上，且本分支还有下层。 */
  canDigDown(): boolean {
    if (this.branch === 'sokoban' || this.depth >= this.maxDepth) return false;
    // 飘着的时候踩不到地面，挖不动地板。
    if (this.isFloating()) return false;
    if (!this.wieldingDigger()) return false;
    const t = this.tileAt(this.player.x, this.player.y);
    return t === T.ROOM || t === T.CORR;
  }

  /** 用镐向下挖：连续 DIG_TURNS 回合后凿穿地板，落到下一层。 */
  digDown(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    if (this.branch === 'sokoban') {
      this.log('msg.digBlocked');
      return { result: 'nothing' };
    }
    if (!this.canDigDown()) {
      this.log('msg.digDownNo');
      return { result: 'nothing' };
    }
    // 任务总部的地板受神秘力量保护，未经领袖许可不得穿透。
    if (this.questDescentBlocked()) {
      this.log('msg.questLocked');
      return { result: 'blocked' };
    }
    const x = this.player.x;
    const y = this.player.y;
    if (!this.digging || !this.digging.down || this.digging.x !== x || this.digging.y !== y) {
      this.digging = { x, y, down: true, progress: 0 };
    }
    this.digging.progress++;
    this.wakeNearby();
    const turns = this.digTurns();
    if (this.digging.progress < turns) {
      this.log('msg.digDownProgress', { n: turns - this.digging.progress });
      this.finishTurn();
      return { result: 'used', key: 'msg.digDownProgress' };
    }
    this.digging = null;
    // 在商店地板上挖洞照原版收修缮费（SHOP_HOLE_COST）。
    if (inShopRoom(this.level, x, y)) this.chargeShopDamage(200);
    this.level.traps.set(index(x, y), { type: 'HOLE', seen: true });
    this.log('msg.digDown');
    this.turn++;
    this.changeDepth(this.depth + 1, 'down');
    this.monsterTurns();
    return { result: this.dead ? 'dead' : 'descended' };
  }

  /**
   * 挖掘一格墙。返回结果：dug 挖开、blocked 被规则挡住、none 不是可挖的墙。
   *
   * 地图边界不可挖；推箱分支禁止破坏结构，对应原版的挖墙限制。
   * `magic` 为真时是挖掘魔杖：商店外墙按原版用更高的修缮价。
   */
  digWall(
    x: number,
    y: number,
    { magic = false }: { magic?: boolean } = {},
  ): 'dug' | 'blocked' | 'none' {
    if (x < 1 || y < 1 || x >= this.level.width - 1 || y >= this.level.height - 1) return 'none';
    const i = index(x, y);
    if (!isWall(this.level.tiles[i])) return 'none';
    if (this.branch === 'sokoban') {
      this.log('msg.digBlocked');
      return 'blocked';
    }
    this.level.tiles[i] = T.CORR;
    this.markTilesChanged(i);
    // 凿穿最后一下的噪动与商店外墙的修缮费。
    this.wakeNearby();
    this.chargeShopDamage(this.wallDamageCost(x, y, magic));
    this.log('msg.digWall');
    return 'dug';
  }

  /**
   * 挖掘魔杖：先挖穿附近最近的墙；没有墙就向下挖一层。
   *
   * 返回 blocked 表示推箱层禁止挖掘，wall 表示挖穿墙壁，
   * down 表示向下开洞并换层，none 表示没有可挖的目标。
   */
  zapDigging(): 'blocked' | 'quest' | 'wall' | 'down' | 'none' {
    if (this.branch === 'sokoban') return 'blocked';
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let x = 1; x < this.level.width - 1; x++) {
      for (let y = 1; y < this.level.height - 1; y++) {
        if (!isWall(this.level.tiles[index(x, y)])) continue;
        const d = Math.max(Math.abs(x - this.player.x), Math.abs(y - this.player.y));
        if (d > 8 || d >= bestD) continue;
        best = { x, y };
        bestD = d;
      }
    }
    if (best) return this.digWall(best.x, best.y, { magic: true }) === 'dug' ? 'wall' : 'none';
    // 飘着的时候踩不到地板，也落不进洞里。
    if (this.depth >= this.maxDepth || this.isFloating()) return 'none';
    // 任务总部的地板受神秘力量保护，未经领袖许可不得穿透。
    if (this.questDescentBlocked()) return 'quest';
    // 在商店地板上开洞照原版收修缮费（SHOP_HOLE_COST）。
    if (inShopRoom(this.level, this.player.x, this.player.y)) this.chargeShopDamage(200);
    // 向下打一个洞并立即落下，与踩中地洞陷阱一致。
    this.level.traps.set(index(this.player.x, this.player.y), { type: 'HOLE', seen: true });
    this.wakeNearby();
    this.changeDepth(this.depth + 1, 'down');
    return 'down';
  }

  pickupAction(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const res = pickupItems(this.player, this.level, {
      canTake: (item) => {
        if (item.id === 'BOULDER') {
          this.log('msg.boulderTooHeavy');
          return false;
        }
        return this.payForItem(item);
      },
    });
    if (!res.ok) {
      // 被价格拦下时已经给过提示，不再补一句「什么也没捡到」。
      if (!res.blocked.length)
        this.log(res.refused.length ? 'use.inventoryFull' : 'use.pickupNothing');
    } else {
      for (const item of res.picked) {
        if (item.gold) this.log('msg.gold', { n: item.quantity });
        else this.log('msg.pickup', { item: describeItem(item) });
        if (item.proto.id === 'AMULET_OF_YENDOR') {
          log.info('玩家取得尤恩多护身符', { turn: this.turn, depth: this.depth });
          this.log('msg.amuletTaken');
          this.spawnAmuletHunter();
        }
      }
      if (res.refused.length) this.log('use.inventoryFull');
    }
    this.finishTurn();
    const goldPicked = res.picked.some((item) => item.gold);
    return {
      result: 'picked',
      picked: res.picked.length,
      key: goldPicked ? 'msg.gold' : undefined,
    };
  }

  /**
   * 商店结账：未付款的货品在拾取前必须先付钱。
   *
   * 钱不够时物品留在原地并给出提示，返回是否允许拾取。
   */
  private payForItem(item: ItemInstance): boolean {
    if (!item.unpaid) return true;
    if (!this.shopkeeperAlive()) {
      // 店主不在，无人收款，货物直接归玩家。
      item.unpaid = false;
      return true;
    }
    const price = shopBuyPrice(item, this.player.cha);
    if (this.player.gold >= price) {
      this.player.gold -= price;
      item.unpaid = false;
      this.log('msg.shopBuy', { item: describeItem(item), n: price });
      return true;
    }
    // 钱不够也可以赊账拿走；离开商店时结账，付不起就变成偷窃。
    this.log('msg.shopCredit', { item: describeItem(item), n: price });
    return true;
  }

  /** 背包里还没付钱的商店货品。 */
  private unpaidItems(): ItemInstance[] {
    return this.player.inventory.filter((item) => item.unpaid);
  }

  /**
   * 离店结账：手里有未付款货品却已不在商店（或直接换层）时触发。
   *
   * 金币够就一次性付清；付不起则店主转为敌对，阵营记录下降。
   */
  private settleShopDebt(leaving = false): void {
    const unpaid = this.unpaidItems();
    const damage = this.shopDamage;
    if (!unpaid.length && damage <= 0) return;
    const shop = shopRoom(this.level);
    if (!leaving && shop && inRoom(shop, this.player.x, this.player.y)) return;
    const bill =
      unpaid.reduce((sum, item) => sum + shopBuyPrice(item, this.player.cha), 0) + damage;
    if (this.player.gold >= bill) {
      this.player.gold -= bill;
      for (const item of unpaid) item.unpaid = false;
      this.shopDamage = 0;
      this.log('msg.shopBillPaid', { n: bill });
      return;
    }
    // 付不起：货物归玩家、店主翻脸；只有修缮费时同样翻脸。
    for (const item of unpaid) item.unpaid = false;
    this.shopDamage = 0;
    if (unpaid.length) this.adjustAlign(-5);
    const keeper = this.level.monsters.find(
      (m) => !m.dead && m.data.id === 'SHOPKEEPER' && !m.angry,
    );
    if (keeper) keeper.angry = true;
    this.log(unpaid.length ? 'msg.shopTheft' : 'msg.shopDamageUnpaid');
    log.info('玩家未能付清商店的账', { turn: this.turn, depth: this.depth, bill });
  }

  /**
   * 在商店里造成破坏：照原版记下修缮费，离店时一并结算。
   *
   * 店主不在或已经翻脸时无人索赔，对应原版的已死店主情形。
   */
  private chargeShopDamage(amount: number): void {
    if (amount <= 0) return;
    const keeper = this.level.monsters.find(
      (m) => !m.dead && m.data.id === 'SHOPKEEPER' && !m.angry,
    );
    if (!keeper) return;
    this.shopDamage += amount;
    this.log('msg.shopDamage', { n: amount });
    log.info('商店受损', { turn: this.turn, depth: this.depth, amount });
  }

  /** 挖开某格墙要赔的修缮费：商店外墙按原版价格；其它情况不计。 */
  private wallDamageCost(x: number, y: number, magic: boolean): number {
    const shop = shopRoom(this.level);
    if (!shop) return 0;
    const borders =
      inRoom(shop, x - 1, y) ||
      inRoom(shop, x + 1, y) ||
      inRoom(shop, x, y - 1) ||
      inRoom(shop, x, y + 1);
    if (!borders) return 0;
    // 原版：镐挖商店外墙 SHOP_WALL_DMG = 10 × 力量，魔杖用 SHOP_WALL_COST。
    return magic ? 200 : 10 * this.player.str;
  }

  /**
   * 把物品卖给脚下的商店，返回成交价。
   *
   * 不在商店、店主不在场时不成交；店里的货（未付款）只是退货，
   * 不产生金币，卖出的物品重新变成店产。
   */
  private sellToShop(item: ItemInstance): number | null {
    const room = shopRoom(this.level);
    if (!room || !inRoom(room, this.player.x, this.player.y)) return null;
    if (item.unpaid || item.gold) return null;
    if (!this.shopkeeperAlive()) {
      this.log('msg.shopClosed');
      return null;
    }
    const price = shopSellPrice(item, this.player.cha);
    this.player.gold += price;
    item.unpaid = true;
    return price;
  }

  /** 本层商店的店主是否还健在。 */
  shopkeeperAlive(): boolean {
    return this.level.monsters.some((m) => !m.dead && m.data.id === 'SHOPKEEPER');
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
          : { key: res.reason === 'item.alreadyWorn' ? 'use.alreadyWorn' : 'use.notWearable' };
        break;
      }
      case 'remove': {
        if (item.buc === 'cursed' && this.equipped(item)) {
          outcome = { key: 'msg.cursedStuck', vars: { item: describeItem(item) } };
          break;
        }
        const res = removeItem(this.player, item);
        outcome = res.ok
          ? { key: 'use.remove', vars: { item: describeItem(item) } }
          : { key: 'use.nothingHappens' };
        break;
      }
      case 'drop': {
        // 受罚时铁球锁在脚踝上，放不下。
        if (item.proto.id === 'HEAVY_IRON_BALL' && this.player.punished) {
          outcome = { key: 'msg.ballStuck' };
          break;
        }
        // 被诅咒的装备取不下来，自然也无法放下。
        if (item.buc === 'cursed' && this.equipped(item)) {
          outcome = { key: 'msg.cursedStuck', vars: { item: describeItem(item) } };
          break;
        }
        const res = dropItem(this.player, this.level, item);
        const price = this.sellToShop(res.item);
        outcome =
          price !== null
            ? { key: 'msg.shopSell', vars: { item: describeItem(res.item), n: price } }
            : { key: 'use.drop', vars: { item: describeItem(res.item) } };
        break;
      }
      case 'cast': {
        // 施法自带结算与回合推进，直接返回。
        return this.castSpell(item);
      }
      case 'throw':
        return this.throwItem(item);
      case 'fire':
        return this.fireItem(item);
      case 'put':
        return this.putInContainer(item);
      case 'open':
        return this.openContainer(item);
      case 'invoke': {
        outcome = invokeArtifact(this, item);
        if (outcome.identified) item.known = true;
        outcome = { key: outcome.key, vars: { ...outcome.vars, item: describeItem(item) } };
        break;
      }
      default: {
        outcome = applyItem(this, item);
        if (outcome.identified) item.known = true;
        const vars = { ...outcome.vars, item: describeItem(item) };
        outcome = { key: outcome.key, vars, keep: outcome.keep };
        // 消耗品在使用后扣除，效果自身声明不移除的除外。
        if (['potion', 'scroll', 'food'].includes(item.proto.cls) && !outcome.keep) {
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
  // 地形设施
  // -------------------------------------------------------------------------

  /**
   * 与脚下的地形设施互动：喷泉喝水、水槽踢一脚、坟墓挖开、王座坐下。
   *
   * 祭坛没有对应动作，留待祈祷机制。已经失效或坐过的设施只消耗一回合。
   */
  useFeature(action: FeatureAction): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const i = index(this.player.x, this.player.y);
    const def = FEATURE_ACTIONS[this.level.tiles[i]];
    const feature = this.level.features.get(i);
    if (!def || def.action !== action || !feature) return { result: 'nothing' };
    if (feature.depleted || feature.used) {
      this.log('msg.featureSpent');
      this.finishTurn();
      return { result: 'used' };
    }
    const effect = rollFeatureEffect(this.rng, def.kind);
    this.applyFeatureEffect(effect, i);
    // 王座只灵验一次；坟墓挖开一次就到底。
    if (def.kind === 'throne' || def.kind === 'grave') feature.used = true;
    if (effect.depletes) feature.depleted = true;
    this.finishTurn();
    return { result: 'used', key: effect.message };
  }

  // -------------------------------------------------------------------------
  // 开启仪式与异界
  // -------------------------------------------------------------------------

  /** 背包里的三件开启圣物；缺任何一件都返回 null。 */
  invocationRelics(): {
    bell: ItemInstance;
    candelabrum: ItemInstance;
    book: ItemInstance;
  } | null {
    const find = (id: string) => this.player.inventory.find((item) => item.proto.id === id);
    const bell = find('BELL_OF_OPENING');
    const candelabrum = find('CANDELABRUM_OF_INVOCATION');
    const book = find('SPE_BOOK_OF_THE_DEAD');
    return bell && candelabrum && book ? { bell, candelabrum, book } : null;
  }

  /**
   * 探测密门：把本层所有门与楼梯写进记忆。
   *
   * 本作还没有生成密门（SDOOR），因此退化为揭示已有门与楼梯；
   * 返回新揭示的格子数。
   */
  revealDoors(): number {
    let revealed = 0;
    for (const [i] of this.level.doors) {
      if (this.level.seen[i] === 1) continue;
      this.level.seen[i] = 1;
      revealed++;
    }
    for (const stair of this.level.stairs) {
      const i = index(stair.x, stair.y);
      if (this.level.seen[i] === 1) continue;
      this.level.seen[i] = 1;
      revealed++;
    }
    return revealed;
  }

  /**
   * 在圣所的振动方块上举行开启仪式。
   *
   * 需要开启之铃、祈祷烛台与死亡之书都在身上，且一件都不能被诅咒；
   * 成功后原地开启通往异界的魔法传送门，并惊醒附近的怪物。
   */
  invokeRitual(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const i = index(this.player.x, this.player.y);
    const trap = this.level.traps.get(i);
    if (!trap || trap.type !== 'VIBRATING_SQUARE') {
      this.log('msg.invocationNoSquare');
      return { result: 'nothing' };
    }
    const relics = this.invocationRelics();
    if (!relics) {
      const missing = ['BELL_OF_OPENING', 'CANDELABRUM_OF_INVOCATION', 'SPE_BOOK_OF_THE_DEAD'].find(
        (id) => !this.player.inventory.some((item) => item.proto.id === id),
      );
      this.log('msg.invocationMissing', { obj: missing ?? null });
      return { result: 'nothing' };
    }
    if (
      relics.bell.buc === 'cursed' ||
      relics.candelabrum.buc === 'cursed' ||
      relics.book.buc === 'cursed'
    ) {
      this.log('msg.invocationCursed');
      return { result: 'nothing' };
    }
    // 振动方块化作传送门；玩家需要踏进去（或使用情境动作）。
    this.level.traps.set(i, { type: 'MAGIC_PORTAL', seen: true });
    let woken = 0;
    for (const mon of this.level.monsters) {
      if (mon.dead || !mon.asleep) continue;
      mon.asleep = false;
      woken++;
    }
    this.log('msg.invocationOpened', { n: woken });
    log.info('开启传送门', { depth: this.depth, at: { x: this.player.x, y: this.player.y } });
    this.finishTurn();
    return { result: 'used' };
  }

  /** 站在传送门上直接踏入异界，不必走出再踏回。 */
  enterPortal(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const trap = this.level.traps.get(index(this.player.x, this.player.y));
    if (!trap || trap.type !== 'MAGIC_PORTAL') return { result: 'nothing' };
    this.turn++;
    this.changeDepth(branchById('planes')?.entryDepth ?? 1, 'down', 'planes');
    this.monsterTurns();
    return { result: this.dead ? 'dead' : 'descended' };
  }

  /**
   * 在祭坛上奉献尤恩多护身符。
   *
   * 只认真正的护身符：献给自己阵营的祭坛即登神；摩洛克与异教神祇
   * 会把僭越者当作祭品。
   */
  offerAmulet(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    if (this.branch !== 'planes') {
      // 普通祭坛不具备登神的资格，只有在异界献礼才有意义。
      this.log('msg.ascendBeyond');
      return { result: 'nothing' };
    }
    const i = index(this.player.x, this.player.y);
    if (this.level.tiles[i] !== T.ALTAR) {
      this.log('msg.sacrificeNotAltar');
      return { result: 'nothing' };
    }
    const amulet = this.player.inventory.find((item) => item.proto.id === 'AMULET_OF_YENDOR');
    if (!amulet) {
      const fake = this.player.inventory.some((item) => item.proto.id === 'FAKE_AMULET_OF_YENDOR');
      this.log(fake ? 'msg.offerFake' : 'msg.offerNoAmulet');
      return { result: 'nothing' };
    }
    const altar = this.level.features.get(i);
    const vars: MessageVars = { align: this.player.align };
    if (altar?.align === this.player.align) {
      removeFromInventory(this.player, amulet);
      this.victory = true;
      this.log('msg.ascended', vars);
      log.info('玩家在异界献上护身符', { turn: this.turn, align: this.player.align });
      return { result: 'used' };
    }
    if (!altar?.align) {
      // 摩洛克亲自收下护身符：僭越者当场丧命。
      this.adjustAlign(-10);
      removeFromInventory(this.player, amulet);
      this.log('msg.offerMoloch');
      if (this.player.takeDamage(9999)) {
        this.dead = true;
        this.log('msg.slainByGod');
      }
      return { result: 'used' };
    }
    // 异教神祇：重罚，但不夺走护身符。
    this.adjustAlign(-10);
    const dmg = this.rng.dice(4, 10);
    this.log('msg.offerWrong', { ...vars, dmg });
    if (this.player.takeDamage(dmg)) {
      this.dead = true;
      this.log('msg.slainByGod');
    }
    return { result: 'used' };
  }

  /**
   * 向神祈祷。
   *
   * 结果由站位、祭坛归属、阵营记录与祈祷冷却共同决定：
   * 站在自己阵营的祭坛上最灵验；祈祷太频繁或敬拜别的神坛会招来惩罚。
   */
  pray(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const player = this.player;
    if (player.sleep > 0) {
      this.log('msg.asleep');
      this.finishTurn();
      return { result: 'slept' };
    }
    const i = index(player.x, player.y);
    const altar = this.level.tiles[i] === T.ALTAR ? this.level.features.get(i) : undefined;
    const vars: MessageVars = { align: player.align };
    let outcome: 'blessed' | 'heard' | 'unheard' | 'angry';
    if (player.prayerTimeout > 0) {
      outcome = 'angry';
    } else if (altar) {
      if (altar.align === player.align) outcome = player.alignRecord >= 0 ? 'blessed' : 'heard';
      else if (!altar.align) outcome = 'heard';
      else outcome = 'angry';
    } else if (player.alignRecord >= 10) {
      outcome = 'blessed';
    } else if (player.alignRecord >= 0) {
      outcome = 'heard';
    } else {
      outcome = 'unheard';
    }

    switch (outcome) {
      case 'blessed': {
        player.hp = player.maxHp;
        player.pw = player.maxPw;
        this.healAfflictions();
        this.adjustAlign(1);
        const uncursed = this.uncurseEquipment();
        if (uncursed > 0) this.log('msg.prayerUncursed', { n: uncursed });
        if (this.unpunish()) this.log('msg.punishmentLifted');
        this.log('msg.prayerBlessed', vars);
        break;
      }
      case 'heard': {
        player.hp = Math.min(player.maxHp, player.hp + Math.ceil(player.maxHp / 2));
        player.pw = Math.min(player.maxPw, player.pw + Math.ceil(player.maxPw / 2));
        this.healAfflictions();
        if (this.unpunish()) this.log('msg.punishmentLifted');
        this.log('msg.prayerHeard', vars);
        break;
      }
      case 'unheard': {
        this.log('msg.prayerUnheard', vars);
        break;
      }
      case 'angry': {
        this.adjustAlign(-5);
        const dmg = this.rng.dice(2, 6);
        vars.dmg = dmg;
        this.log('msg.prayerAngry', vars);
        // 神的惩罚由一名敌对天使执行。
        const angel = this.spawnMonsterNear('ANGEL');
        if (angel) {
          angel.angry = true;
          this.log('msg.prayerAngel');
        }
        if (player.takeDamage(dmg)) {
          this.dead = true;
          this.log(angel ? 'msg.youDie' : 'msg.slainByGod', { mon: 'ANGEL' });
          log.warn('玩家死于神罚', { turn: this.turn, depth: this.depth });
        }
        break;
      }
    }
    player.prayerTimeout = outcome === 'angry' ? 500 + this.rng.rn2(300) : 300 + this.rng.rn2(300);
    // 祭坛上的水随神意转化，对应 pray.c 的 water_prayer()。
    if (altar) this.waterPrayer(outcome === 'blessed');
    this.finishTurn();
    return { result: 'used' };
  }

  /**
   * 把祭坛上的水变成圣水或诅咒之水。
   *
   * 与 pray.c 的 water_prayer() 一致：放在祭坛地面的 POT_WATER 会随祈祷结果
   * 翻转 BUC；水不带在身上也能转化，因此流程是“放下水 → 祈祷 → 捡回”。
   */
  private waterPrayer(bless: boolean): void {
    const pile = pileAt(this.level, this.player.x, this.player.y);
    if (!pile) return;
    let changed = 0;
    for (const item of pile.items) {
      if (item.proto.id !== 'POT_WATER') continue;
      if (bless && item.buc !== 'blessed') {
        item.buc = 'blessed';
        item.known = true;
        changed++;
      } else if (!bless && item.buc !== 'cursed') {
        item.buc = 'cursed';
        item.known = true;
        changed++;
      }
    }
    if (changed > 0) this.log(bless ? 'msg.waterBlessed' : 'msg.waterCursed', { n: changed });
  }

  /** 祭坛献祭：用尸体换取神恩或触怒异教神祇。 */
  offerCorpse(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    if (this.tileAt(this.player.x, this.player.y) !== T.ALTAR) {
      this.log('msg.sacrificeNotAltar');
      return { result: 'nothing' };
    }
    const altar = this.level.features.get(index(this.player.x, this.player.y));
    if (!altar || altar.type !== 'ALTAR') {
      this.log('msg.sacrificeNotAltar');
      return { result: 'nothing' };
    }
    const corpse = this.player.inventory.find((item) => item.corpse);
    if (!corpse) {
      this.log('msg.sacrificeNoCorpse');
      return { result: 'nothing' };
    }
    const monsterId = corpse.corpse as string;
    removeFromInventory(this.player, corpse);

    // 无主祭坛（摩洛克）只吞祭品，不给回报。
    if (!altar.align) {
      this.log('msg.sacrificeMoloch', { mon: monsterId });
      this.finishTurn();
      return { result: 'used' };
    }
    const monLevel = monById.get(monsterId)?.lvl ?? 0;
    if (altar.align === this.player.align) {
      // 太弱的祭品不顶用，对应原版按怪物难度判定的门槛。
      if (monLevel + 3 < this.player.level) {
        this.log('msg.sacrificeWeak', { mon: monsterId });
      } else {
        this.player.luck = Math.min(10, this.player.luck + 1);
        this.adjustAlign(3);
        this.log('msg.sacrificeAccepted', { mon: monsterId, align: altar.align });
      }
      this.finishTurn();
      return { result: 'used' };
    }
    // 异阵营祭坛：有概率被本神收服，否则触怒对方。
    if (this.rng.chance(0.35)) {
      altar.align = this.player.align;
      this.adjustAlign(1);
      this.log('msg.sacrificeConverted', { mon: monsterId, align: this.player.align });
    } else {
      this.adjustAlign(-3);
      this.log('msg.sacrificeAngered', { mon: monsterId, align: altar.align });
    }
    this.finishTurn();
    return { result: 'used' };
  }

  /** 解除铁球惩罚：收回脚踝上的铁球；未受罚时返回 false。 */
  private unpunish(): boolean {
    if (!this.player.punished) return false;
    this.player.punished = false;
    this.player.punishedTurn = 0;
    const ball = this.player.inventory.find((i) => i.proto.id === 'HEAVY_IRON_BALL');
    if (ball) removeFromInventory(this.player, ball);
    return true;
  }

  /** 祝福祈祷解除装备上的诅咒，返回解除的件数。 */
  private uncurseEquipment(): number {
    let count = 0;
    for (const item of Object.values(this.player.equipment)) {
      if (item && item.buc === 'cursed') {
        item.buc = 'uncursed';
        count++;
      }
    }
    return count;
  }

  /** 祈祷清除的异常状态：失明、混乱、眩晕、定身与石化。 */
  private healAfflictions(): void {
    const p = this.player;
    p.blind = 0;
    p.confused = 0;
    p.stun = 0;
    p.held = 0;
    p.petrifying = 0;
    p.sick = 0;
  }

  /** 调整阵营记录，限制在 NetHack 的 [-128, 127] 区间。 */
  private adjustAlign(delta: number): void {
    this.player.alignRecord = Math.max(-128, Math.min(127, this.player.alignRecord + delta));
  }

  /** 击杀对阵营记录的影响：杀敌对的对立阵营加分，杀同阵营与和平生物扣分。 */
  private killAlignDelta(mon: Monster): number {
    const weight = Math.max(1, Math.floor(mon.mlev / 2));
    if (mon.peaceful === true || mon.data.flags.includes('M2_PEACEFUL')) return -weight;
    const monSign = Math.sign(mon.data.align);
    const playerSign = alignSign(this.player.align);
    if (monSign !== 0 && monSign === playerSign) return -weight;
    if (monSign !== 0 && playerSign !== 0 && monSign !== playerSign) return weight;
    return Math.max(1, Math.floor(weight / 2));
  }

  /**
   * 把玩家变成随机怪物的形态。
   *
   * `changed` 为假时，`blocked` 表示被不变护身符拦住。
   * 调用方负责记消息，便于不同来源（药水、陷阱、怪物攻击）用各自的文案。
   */
  polymorph(): { changed: boolean; blocked: boolean; monId: string | null } {
    const player = this.player;
    if (player.equipment.amulet?.proto.id === 'AMULET_OF_UNCHANGING') {
      return { changed: false, blocked: true, monId: null };
    }
    const data = pickMonsterType(this.rng, this.depth, player.level);
    if (!data) return { changed: false, blocked: false, monId: null };
    player.form = { id: data.id, turns: 20 + this.rng.rn2(20) };
    return { changed: true, blocked: false, monId: data.id };
  }

  /** 待处理的愿望数：界面收集文字后调用 `grantWish`。 */
  pendingWishes = 0;

  /** 记下一次待处理的愿望（许愿魔杖或魔法灯）。 */
  openWish(): void {
    this.pendingWishes += 1;
  }

  /**
   * 兑现一次待处理的愿望。
   *
   * 匹配不到时不消耗愿望，方便玩家重试；背包放不下时把物品丢在脚下。
   */
  grantWish(text: string): { ok: boolean; key: string } {
    const res = resolveWish(this.rng, text);
    if (res.kind === 'gold') {
      const gold = makeGold(this.rng, this.depth, res.amount);
      this.dropAtPlayer(gold);
      this.pendingWishes = Math.max(0, this.pendingWishes - 1);
      this.log('msg.wishGold', { n: gold.quantity });
      return { ok: true, key: 'msg.wishGold' };
    }
    if (res.kind === 'item') {
      const item = makeItem(res.proto, this.rng, {
        quantity: res.quantity,
        appearance: this.appearances.get(res.proto.id) ?? res.proto.appr ?? null,
      });
      this.pendingWishes = Math.max(0, this.pendingWishes - 1);
      if (!addToInventory(this.player, item).ok) this.dropAtPlayer(item);
      this.log('msg.wishGranted', { item: describeItem(item) });
      return { ok: true, key: 'msg.wishGranted' };
    }
    const query = String(text ?? '').trim();
    this.log('msg.wishNoSuch', { text: query });
    return { ok: false, key: 'msg.wishNoSuch' };
  }

  /** 读完灭绝卷轴后进入等待输入状态。 */
  openGenocide(): void {
    this.pendingGenocide = true;
  }

  /**
   * 灭绝一个怪物物种：接受英文名、中文名或原型 id。
   *
   * 成功后清掉本局已生成的全部同种怪物，并在后续生成中排除。
   */
  tryGenocide(text: string): boolean {
    const raw = String(text ?? '').trim();
    const norm = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[_\s]+/g, ' ')
        .trim();
    const needle = norm(raw);
    const target = needle
      ? MONSTERS.find(
          (m) => norm(m.id) === needle || norm(m.name) === needle || monsterName(m.id) === raw,
        )
      : undefined;
    if (!target) {
      this.log('msg.genocideNoMatch', { text: raw });
      return false;
    }
    if (this.genocides.has(target.id)) {
      this.log('msg.genocideAlready', { mon: target.id });
      this.pendingGenocide = false;
      return true;
    }
    this.genocides.add(target.id);
    let removed = 0;
    for (const level of [...this.levels.values(), ...this.branchCache.values()]) {
      const before = level.monsters.length;
      level.monsters = level.monsters.filter((m) => m.data.id !== target.id);
      removed += before - level.monsters.length;
    }
    this.pendingGenocide = false;
    this.log('msg.genocideOk', { mon: target.id, n: removed });
    log.info('物种被灭绝', { monster: target.id, removed });
    return true;
  }

  /**
   * 神谕咨询：付一笔金币，换一条关于本作的提示。
   *
   * 付不起时不消耗回合，方便玩家先去筹钱。
   */
  consultOracle(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    if (this.player.gold < ORACLE_COST) {
      this.log('msg.oraclePoor', { n: ORACLE_COST });
      return { result: 'nothing' };
    }
    this.player.gold -= ORACLE_COST;
    const tip = 1 + this.rng.rn2(ORACLE_TIPS);
    this.log('msg.oracleSays', { tip: `oracle.tip${tip}` });
    this.finishTurn();
    return { result: 'used' };
  }

  /**
   * 给身边的宠物拴上或解开牵引绳；栓住的宠物只能在玩家两格内活动。
   *
   * 只返回消息键，交给使用物品的流程统一记日志。
   */
  leashPet(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const pet = this.level.monsters.find(
      (m) =>
        m.tame &&
        !m.dead &&
        Math.max(Math.abs(m.x - this.player.x), Math.abs(m.y - this.player.y)) <= 1,
    );
    if (!pet) return { result: 'nothing', key: 'msg.leashNoPet' };
    pet.leashed = !pet.leashed;
    return {
      result: 'used',
      key: pet.leashed ? 'msg.leashOn' : 'msg.leashOff',
      vars: { mon: pet.data.id },
    };
  }

  /**
   * 喂食宠物：消耗一份食物，恢复生命并提升驯服度；驯服度满值后成长一次。
   */
  feedPet(): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    const pet = this.level.monsters.find(
      (m) =>
        m.tame &&
        !m.dead &&
        Math.max(Math.abs(m.x - this.player.x), Math.abs(m.y - this.player.y)) <= 1,
    );
    if (!pet) {
      this.log('msg.petNone');
      return { result: 'nothing' };
    }
    const food = this.player.inventory.find((item) => item.proto.cls === 'food');
    if (!food) {
      this.log('msg.petNoFood');
      return { result: 'nothing' };
    }
    this.consumeItem(food);
    pet.mhp = Math.min(pet.mhpmax, pet.mhp + Math.ceil(pet.mhpmax / 2));
    pet.tameness = Math.min(20, pet.tameness + 2);
    pet.hunger = Math.min(2000, (pet.hunger ?? 900) + (food.proto.nutrition ?? 100));
    this.log('msg.petEats', { mon: pet.data.id, item: describeItem(food) });
    const grown = PET_GROWTH[pet.data.id];
    if (pet.tameness >= 20 && grown) {
      const next = monById.get(grown);
      if (next) {
        const from = pet.data.id;
        pet.data = next;
        pet.mhpmax = Math.max(pet.mhpmax, next.lvl * 6);
        pet.mhp = pet.mhpmax;
        this.log('msg.petGrows', { mon: from, form: next.id });
      }
    }
    this.finishTurn();
    return { result: 'used' };
  }

  /** 商店补货：在空地上放一件未付款的新货，店满时返回 false。 */
  private restockShopOnce(room: Room): boolean {
    const spots: { x: number; y: number }[] = [];
    for (let x = room.lx; x <= room.hx; x++) {
      for (let y = room.ly; y <= room.hy; y++) {
        if (this.level.tiles[index(x, y)] !== T.ROOM) continue;
        if (this.level.objects.some((p) => p.x === x && p.y === y)) continue;
        spots.push({ x, y });
      }
    }
    if (!spots.length) return false;
    const spot = this.rng.pick(spots) as { x: number; y: number };
    const item = randomShopItem(this.rng, this.level.depth, this.appearances, room.shopType);
    if (!item) return false;
    item.unpaid = true;
    this.level.objects.push({ x: spot.x, y: spot.y, items: [item] });
    return true;
  }

  /** 结算一次设施效果，结束时已经记好消息。 */
  private applyFeatureEffect(effect: FeatureEffect, tile: number): void {
    const player = this.player;
    const vars: MessageVars = {};
    switch (effect.kind) {
      case 'heal': {
        const n = effect.dice ? this.rng.dice(effect.dice[0], effect.dice[1]) : 0;
        const healed = Math.min(player.maxHp, player.hp + n) - player.hp;
        player.hp += healed;
        vars.n = healed;
        break;
      }
      case 'refresh': {
        const n = effect.dice ? this.rng.dice(effect.dice[0], effect.dice[1]) : 0;
        const gained = Math.min(player.maxPw, player.pw + n) - player.pw;
        player.pw += gained;
        vars.n = gained;
        break;
      }
      case 'seeInvisible':
        player.seeInvisible = true;
        break;
      case 'luck':
        player.luck += 1;
        break;
      case 'strength':
        if (player.str < 25) player.str += 1;
        break;
      case 'gold': {
        const gold = makeGold(this.rng, this.depth);
        vars.n = gold.quantity;
        this.dropAtPlayer(gold);
        break;
      }
      case 'item': {
        const item = randomItem(this.rng, this.depth, this.appearances);
        if (item) {
          vars.item = describeItem(item);
          this.dropAtPlayer(item);
        }
        break;
      }
      case 'wake':
        for (const mon of this.level.monsters) if (!mon.dead) mon.asleep = false;
        break;
      case 'damage': {
        const dmg = effect.dice ? this.rng.dice(effect.dice[0], effect.dice[1]) : 1;
        vars.n = dmg;
        if (player.takeDamage(dmg)) this.dead = true;
        break;
      }
      case 'curse':
        player.luck -= 1;
        break;
      case 'break':
      case 'vanish':
        // 设施破坏后恢复成普通地面，渲染层随 features 一起移除。
        this.level.tiles[tile] = T.ROOM;
        this.level.features.delete(tile);
        this.markTilesChanged(tile);
        break;
      case 'spawn': {
        const mon = effect.monster ? this.spawnMonsterNear(effect.monster) : null;
        if (mon) vars.mon = mon.data.id;
        break;
      }
      case 'nothing':
      case 'dry':
      default:
        break;
    }
    this.log(effect.message, vars);
  }

  /** 玩家脚下放一件物品，与已有物品堆合并。 */
  private dropAtPlayer(item: ItemInstance): void {
    const pile = pileAt(this.level, this.player.x, this.player.y);
    if (pile) pile.items.push(item);
    else this.level.objects.push({ x: this.player.x, y: this.player.y, items: [item] });
  }

  /** 该格能否容纳新怪物：可通行、无怪物，也不在玩家脚下。 */
  private freeSpot(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.level.width || y >= this.level.height) return false;
    if (!isWalkable(this.level.tiles[index(x, y)])) return false;
    if (monsterAt(this.level, x, y)) return false;
    return x !== this.player.x || y !== this.player.y;
  }

  /** 在玩家身边放出一只怪物：优先后退一格，再退回任意空地。 */
  private spawnMonsterNear(id: string): Monster | null {
    const data = monById.get(id);
    if (!data) return null;
    const adjacent = DIR8.map(([dx, dy]) => ({
      x: this.player.x + dx,
      y: this.player.y + dy,
    })).filter((p) => this.freeSpot(p.x, p.y));
    let spot: { x: number; y: number } | null = adjacent.length
      ? (this.rng.pick(adjacent) as { x: number; y: number })
      : null;
    for (let y = 1; y < this.level.height - 1 && !spot; y++) {
      for (let x = 1; x < this.level.width - 1 && !spot; x++) {
        if (this.freeSpot(x, y)) spot = { x, y };
      }
    }
    if (!spot) return null;
    const mon = new MonsterEntity(data, spot.x, spot.y, this.rng);
    // 主动现身的怪物不会继续装睡。
    mon.asleep = false;
    this.level.monsters.push(mon);
    return mon;
  }

  // -------------------------------------------------------------------------
  // 怪物
  // -------------------------------------------------------------------------

  monsterTurns(): void {
    log.debug('怪物行动阶段开始', { monsters: this.level.monsters.length, turn: this.turn });
    for (const mon of this.level.monsters) {
      if (mon.dead || this.dead) continue;
      // 定身：跳过行动并递减剩余回合。
      if ((mon.stasis ?? 0) > 0) {
        mon.stasis = (mon.stasis ?? 0) - 1;
        continue;
      }
      // 加速翻倍、缓速减半；两者都有效时先加倍再减半。
      mon.mv += monsterSpeed(mon);
      if (mon.hasted > 0) mon.hasted--;
      if (mon.slowed > 0) mon.slowed--;
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
    // 宠物有自己的行动逻辑：打敌人、跟玩家。
    if (mon.tame) {
      this.petAction(mon);
      return;
    }
    // 店主虽然平和，但要让开门口：和平生物默认不动，否则会把入口堵死。
    if (mon.data.id === 'SHOPKEEPER' && this.isPeaceful(mon)) {
      this.shopkeeperAction(mon);
      return;
    }
    // 和平生物（店主、守卫）在受挑衅前不行动。
    if (this.isPeaceful(mon)) return;
    const dist = Math.max(Math.abs(mon.x - player.x), Math.abs(mon.y - player.y));
    const wasAsleep = mon.asleep;

    // 尤恩多巫师近身时可能抢走护身符并传送逃离。
    if (
      mon.data.id === 'WIZARD_OF_YENDOR' &&
      !this.wizardHasAmulet &&
      dist <= 1 &&
      this.carryingAmulet &&
      this.rng.chance(0.25)
    ) {
      const amulet = player.inventory.find((item) => item.proto.id === 'AMULET_OF_YENDOR');
      if (amulet) {
        removeFromInventory(player, amulet);
        this.wizardHasAmulet = true;
        const spot = this.randomFloorTile();
        if (spot) {
          mon.x = spot.x;
          mon.y = spot.y;
        }
        this.log('msg.wizardSteals');
        return;
      }
    }

    if (mon.asleep) {
      const wakeChance = this.hasEquipmentPower('STEALTH') ? 0.15 : 0.4;
      if (dist <= 8 && this.monsterSees(mon) && this.rng.chance(wakeChance)) {
        mon.asleep = false;
      } else {
        return;
      }
    }

    // 重伤的怪物有概率转身逃跑。
    if (!mon.fleeing && mon.mhp * 4 <= mon.mhpmax && this.rng.chance(0.5)) {
      mon.fleeing = true;
      this.log('msg.monFlees', { mon: mon.data.id });
    }
    if (mon.fleeing) {
      this.stepMonster(mon, -1);
      return;
    }

    const sees = this.monsterSees(mon);
    // 刚醒来的怪物会呼救，唤醒附近的同伴。
    if (sees && wasAsleep) this.rallyMonsters(mon);
    if (sees) {
      if (dist <= 1) {
        this.monsterAttack(mon);
      } else if (!this.rangedAttack(mon, dist)) {
        this.stepMonster(mon, 1);
      }
    } else if (this.rng.chance(0.25)) {
      this.stepMonster(mon, 0);
    }
  }

  /**
   * 店主让路。
   *
   * 原版店主会在玩家站上店门时走开（`shk_move` 的 avoid 分支）；
   * 本作的和平生物不主动行动，因此这里只做一件事：站在门边时向店里
   * 走一步，保证唯一的入口不会被永久堵住。
   */
  private shopkeeperAction(mon: Monster): void {
    const room = shopRoom(this.level);
    if (!room || !inRoom(room, mon.x, mon.y)) return;
    const doorGap = (x: number, y: number): number => {
      let nearest = Infinity;
      for (const i of this.level.doors.keys()) {
        const d = Math.max(Math.abs((i % COLNO) - x), Math.abs(Math.floor(i / COLNO) - y));
        if (d < nearest) nearest = d;
      }
      return nearest;
    };
    const current = doorGap(mon.x, mon.y);
    if (current > 1) return;
    // 先尝试离门更远的一小步，让移动看起来自然。
    let best: { x: number; y: number; d: number } | null = null;
    for (const [dx, dy] of DIR8) {
      const nx = mon.x + dx;
      const ny = mon.y + dy;
      if (!inRoom(room, nx, ny)) continue;
      if (this.level.tiles[index(nx, ny)] !== T.ROOM) continue;
      if (nx === this.player.x && ny === this.player.y) continue;
      if (monsterAt(this.level, nx, ny)) continue;
      const d = doorGap(nx, ny);
      if (d <= current) continue;
      if (!best || d > best.d) best = { x: nx, y: ny, d };
    }
    // 一步走不开（周围被占或被墙围住）时退而求其次：直接挪到店内离门最远的空地。
    if (!best) {
      for (let x = room.lx; x <= room.hx; x++) {
        for (let y = room.ly; y <= room.hy; y++) {
          if (this.level.tiles[index(x, y)] !== T.ROOM) continue;
          if (x === mon.x && y === mon.y) continue;
          if (x === this.player.x && y === this.player.y) continue;
          if (monsterAt(this.level, x, y)) continue;
          const d = doorGap(x, y);
          if (d <= current) continue;
          if (!best || d > best.d) best = { x, y, d };
        }
      }
    }
    if (best) {
      mon.x = best.x;
      mon.y = best.y;
    }
  }

  /**
   * 唤醒附近的沉睡怪物，对应原版的 `wake_nearby()`。
   *
   * 半径按等级放大（平方距离小于等级 × 20），与呼救的固定 6 格不同；
   * 每格挖凿、踢门都会发出噪音，让身边的怪物提前醒来。
   */
  wakeNearby(radiusSq: number = this.player.level * 20): void {
    let woke = 0;
    for (const mon of this.level.monsters) {
      if (mon.dead || !mon.asleep) continue;
      const dx = mon.x - this.player.x;
      const dy = mon.y - this.player.y;
      if (dx * dx + dy * dy >= radiusSq) continue;
      mon.asleep = false;
      woke++;
    }
    if (woke > 0) log.debug('噪音唤醒怪物', { woke, turn: this.turn });
  }

  /** 呼救：唤醒 6 格内尚在沉睡的同伴。 */
  private rallyMonsters(mon: Monster): void {
    let woke = 0;
    for (const other of this.level.monsters) {
      if (other === mon || other.dead || other.tame || !other.asleep) continue;
      const dist = Math.max(Math.abs(other.x - mon.x), Math.abs(other.y - mon.y));
      if (dist > 6) continue;
      other.asleep = false;
      woke++;
    }
    if (woke > 0) this.log('msg.monCalls', { mon: mon.data.id, n: woke });
  }

  /**
   * 远程攻击：吐息、喷吐与魔法弹在 2-6 格外结算。
   *
   * 命中不下骰，但元素与魔法效果照旧走抗性判定；有概率触发，
   * 所以怪物仍会边靠近边喷吐。返回是否已经行动。
   */
  private rangedAttack(mon: Monster, dist: number): boolean {
    if (dist < 2 || dist > 6) return false;
    // 被取消的怪物喷不出吐息。
    if (mon.cancelled) return false;
    const attack = mon.data.attacks.find(
      (a) => a.at === 'AT_BREA' || a.at === 'AT_SPIT' || a.at === 'AT_MAGC',
    );
    if (!attack) return false;
    // 已知玩家免疫时不再徒劳远射，改为靠近。
    const kind = this.resistKindOf(attack.ad);
    if (kind && playerResists(this.player).has(kind)) return false;
    if (!this.rng.chance(0.35)) return false;
    this.resolveAttack(mon, attack.ad, attack.dice, playerResists(this.player));
    return true;
  }

  /** 攻击类型对应的抗性种类；没有对应种类时返回 null。 */
  private resistKindOf(ad: string): ResistKind | null {
    if (ad === 'AD_ELEC') return 'elec';
    if (ad === 'AD_DRST') return 'poison';
    return ELEMENTAL_ATTACKS[ad]?.[0] ?? null;
  }

  monsterSees(mon: Monster): boolean {
    const player = this.player;
    if (this.hasInvisibility()) return false;
    const dist = Math.max(Math.abs(mon.x - player.x), Math.abs(mon.y - player.y));
    if (dist > 12) return false;
    const fov = computeFov(this.level, mon.x, mon.y, 12, { remember: false });
    return fov[index(player.x, player.y)] === 1;
  }

  /** 尚未被挑衅的和平生物：数据默认的 M2_PEACEFUL，或按站位判定的平和守卫。 */
  isPeaceful(mon: Monster): boolean {
    return !mon.angry && (mon.peaceful === true || mon.data.flags.includes('M2_PEACEFUL'));
  }

  /**
   * 地面是否会让怪物止步。
   *
   * 不会游泳、不能飞的怪物不主动下水；没有火焰抗性的怪物不踏进岩浆；
   * 水元素、火元素这类有对应标志或抗性的怪物照常通行。
   */
  private monsterFearsTile(mon: Monster, tile: number): boolean {
    const watery = tile === T.WATER || tile === T.POOL || tile === T.MOAT;
    if (!watery && tile !== T.LAVA) return false;
    const flags = mon.data.flags;
    if (flags.includes('M1_SWIM') || flags.includes('M1_AMPHIBIOUS') || flags.includes('M1_FLY')) {
      return false;
    }
    if (tile === T.LAVA) return !mon.data.resists.includes('MR_FIRE');
    return true;
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
      // 不会水、怕火的怪物主动绕开岩浆与水。
      if (this.monsterFearsTile(mon, t)) continue;
      // 拴了牵引绳的宠物走不出玩家两格。
      if (mon.leashed && Math.max(Math.abs(nx - player.x), Math.abs(ny - player.y)) > 2) continue;
      if (monsterAt(this.level, nx, ny)) continue;
      if (nx === player.x && ny === player.y) continue;
      const d = Math.max(Math.abs(nx - player.x), Math.abs(ny - player.y));
      options.push({ x: nx, y: ny, d, dx, dy, t });
    }
    if (!options.length) return;
    options.sort((a, b) => (direction >= 0 ? a.d - b.d : b.d - a.d));
    // 追击时优先走最短路：贪心在拐角处容易卡住，最短路只在能绕开时插队。
    if (direction > 0) {
      const step = this.monsterStepToward(mon);
      if (step) {
        const idx = options.findIndex((o) => o.dx === step[0] && o.dy === step[1]);
        if (idx > 0) options.unshift(...options.splice(idx, 1));
      }
    }
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

  /**
   * 怪物追击用的最短路。
   *
   * 只在贪心走法绕不过墙时作为下一步的参考：关闭的门可通行（怪物会推门），
   * 其它生物视为阻挡。限制访问格数，避免玩家不可达时退化为全图扫描。
   */
  private monsterStepToward(mon: Monster): [number, number] | null {
    const { width, height, tiles } = this.level;
    const start = index(mon.x, mon.y);
    const goal = index(this.player.x, this.player.y);
    const prev = new Int32Array(width * height).fill(-1);
    const queue: number[] = [start];
    prev[start] = start;
    const dirs: [number, number][] = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    let found = false;
    for (let head = 0; head < queue.length && head < 2000; head++) {
      const cur = queue[head];
      if (cur === goal) {
        found = true;
        break;
      }
      const cx = cur % width;
      const cy = (cur / width) | 0;
      for (const [dx, dy] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = index(nx, ny);
        if (prev[ni] !== -1) continue;
        if (ni !== goal && !isWalkable(tiles[ni])) continue;
        if (ni !== goal && this.monsterFearsTile(mon, tiles[ni])) continue;
        if (ni !== goal && monsterAt(this.level, nx, ny)) continue;
        prev[ni] = cur;
        queue.push(ni);
      }
    }
    if (!found) return null;
    let cursor = goal;
    while (prev[cursor] !== start) {
      cursor = prev[cursor];
      if (cursor === -1) return null;
    }
    return [(cursor % width) - mon.x, ((cursor / width) | 0) - mon.y];
  }

  /**
   * 结算一次怪物攻击。
   *
   * `AD_*` 决定效果：物理伤害走护甲减免，元素伤害与状态效果按抗性判定；
   * 状态攻击的骰子是持续回合数，与 NetHack 的 mhitu.c 一致。
   */
  monsterAttack(mon: Monster): void {
    const resists = playerResists(this.player);
    // 现出原形才能作战：伪装的拟形怪一旦出手就不再伪装。
    if (mon.disguise) mon.disguise = null;
    this.maybeTaunt(mon);
    let index2 = 0;
    for (const atk of mon.data.attacks) {
      if (this.dead || mon.dead) return;
      const [n, sides] = atk.dice;
      const meaningful = n > 0 && sides > 0;
      // AT_NONE 是被动攻击，由玩家主动出手时结算；0 骰的物理攻击仍是空挥，
      // 但 [0,N] 的特殊攻击按 1 颗骰子解释，不能让它们整个失效。
      if (atk.at === 'AT_NONE' || (atk.ad === 'AD_PHYS' && !meaningful)) {
        index2++;
        continue;
      }
      // 被取消的怪物只剩下物理攻击。
      if (mon.cancelled && atk.ad !== 'AD_PHYS') {
        index2++;
        continue;
      }
      // 看不见就躲得过目光攻击（美杜莎的石化目光等）。
      if (atk.at === 'AT_GAZE' && this.player.isBlind) {
        index2++;
        continue;
      }
      const { hit } = monsterHits(mon, this.player, index2, this.rng);
      index2++;
      if (!hit) {
        this.log('msg.monMisses', { mon: mon.data.id });
        continue;
      }
      this.resolveAttack(mon, atk.ad, atk.dice, resists);
    }
  }

  /** 怪物命中后的效果分派。 */
  private resolveAttack(
    mon: Monster,
    ad: string,
    dice: [number, number],
    resists: ReadonlySet<ResistKind>,
  ): void {
    const player = this.player;
    const monId = mon.data.id;
    const half = halfDamageKinds(player);
    const roll = (): number => {
      // 0 颗骰子在数据里表示「按 1 颗算」：被动攻击与哌视的 [0,N] 靠这条解释。
      const [n, sides] = dice;
      if (sides <= 0) return 0;
      return n > 0 ? this.rng.dice(n, sides) : this.rng.rn1(1, sides);
    };
    const damage = (dmg: number, key: string): void => {
      let final = dmg;
      if (ad === 'AD_PHYS' && half.physical) final = Math.ceil(dmg / 2);
      else if ((ad === 'AD_MAGM' || ad === 'AD_SPEL' || ad === 'AD_CLRC') && half.spell) {
        final = Math.ceil(dmg / 2);
      }
      const died = player.takeDamage(final);
      this.log(key, { mon: monId, dmg: final });
      this.lastCombat = { monsterId: mon.id, hit: true, byPlayer: false, damage: final };
      if (died) {
        this.dead = true;
        log.warn('玩家死亡', { turn: this.turn, depth: this.depth, killer: monId });
        this.log('msg.youDie', { mon: monId });
      }
    };

    switch (ad) {
      // 元素与魔法伤害：抗性完全免伤。
      case 'AD_FIRE':
      case 'AD_COLD':
      case 'AD_ACID':
      case 'AD_MAGM':
      case 'AD_SPEL':
      case 'AD_CLRC': {
        const [kind, hitKey, resistKey] = ELEMENTAL_ATTACKS[ad] as [ResistKind, string, string];
        if (resists.has(kind)) this.log(resistKey, { mon: monId });
        else damage(roll(), hitKey);
        return;
      }
      case 'AD_ELEC': {
        if (resists.has('elec')) {
          this.log('msg.resistElec', { mon: monId });
          return;
        }
        // 反射把电击弹回攻击者，与 NetHack 的 Reflecting 判定一致。
        if (resists.has('reflection')) {
          const dmg = Math.max(1, roll());
          mon.mhp -= dmg;
          this.log('msg.reflectElec', { mon: monId, dmg });
          if (mon.mhp <= 0) this.slayMonster(mon, false);
          return;
        }
        damage(roll(), 'msg.hitElec');
        return;
      }
      case 'AD_DRST': {
        if (resists.has('poison')) {
          this.log('msg.resistPoison', { mon: monId });
          return;
        }
        player.str = Math.max(3, player.str - 1);
        damage(roll(), 'msg.poisonSting');
        return;
      }
      case 'AD_SLEE': {
        if (resists.has('sleep')) {
          this.log('msg.resistSleep', { mon: monId });
          return;
        }
        const turns = Math.min(40, roll());
        player.sleep = Math.max(player.sleep, turns);
        this.log('msg.monSleep', { mon: monId });
        return;
      }
      case 'AD_PLYS':
      case 'AD_STCK': {
        if (resists.has('hold')) {
          this.log('msg.resistHold', { mon: monId });
          return;
        }
        const turns = Math.min(12, roll());
        player.held = Math.max(player.held, turns);
        this.log('msg.monParalyze', { mon: monId });
        return;
      }
      case 'AD_CONF': {
        player.confused = Math.max(player.confused, Math.min(20, roll()));
        this.log('msg.monConfuse', { mon: monId });
        return;
      }
      case 'AD_BLND': {
        player.blind = Math.max(player.blind, Math.min(30, roll()));
        this.log('msg.monBlind', { mon: monId });
        return;
      }
      case 'AD_DREN': {
        const drained = Math.floor(player.pw / 2);
        player.pw -= drained;
        this.log('msg.drainMana', { mon: monId, n: drained });
        return;
      }
      case 'AD_DRLI': {
        // 吸走一级：等级降到 1 为止，生命上限随之下调。
        if (player.level <= 1) {
          this.log('msg.drainLife', { mon: monId });
          return;
        }
        player.level -= 1;
        player.xp = Math.max(0, xpForLevel(player.level) - 1);
        player.maxHp = Math.max(1, player.maxHp - 1);
        player.hp = Math.min(player.hp, player.maxHp);
        this.log('msg.drainLife', { mon: monId });
        return;
      }
      case 'AD_DRIN':
      case 'AD_DRDX':
      case 'AD_DRCO': {
        // 毅力戒指（FIXED_ABIL）防止属性吸取。
        if (this.hasEquipmentPower('FIXED_ABIL')) {
          this.log('msg.drainResisted', { mon: monId });
          return;
        }
        if (ad === 'AD_DRIN') player.int = Math.max(3, player.int - 1);
        else if (ad === 'AD_DRDX') player.dex = Math.max(3, player.dex - 1);
        else player.con = Math.max(3, player.con - 1);
        this.log('msg.drainAbility', { mon: monId });
        return;
      }
      case 'AD_DCAY':
      case 'AD_RUST':
      case 'AD_CORR': {
        // 先腐蚀所穿护甲，没有可腐蚀的护甲时转向手中武器。
        const suit = player.equipment.suit;
        // 涂过油的护甲躲过一劫，油脂随之耗掉。
        if (suit?.greased) {
          suit.greased = false;
          this.log('msg.greaseSaves', { obj: suit.proto.id });
          return;
        }
        if (suit && suit.enchant > -5) {
          suit.enchant--;
          this.log('msg.rustAttack', { mon: monId, obj: suit.proto.id });
        } else if (player.weapon && player.weapon.enchant > -5) {
          player.weapon.enchant--;
          this.log('msg.rustAttack', { mon: monId, obj: player.weapon.proto.id });
        } else {
          this.log('msg.monNoEffect', { mon: monId });
        }
        return;
      }
      case 'AD_HEAL': {
        mon.mhp = Math.min(mon.mhpmax, mon.mhp + roll());
        this.log('msg.monHeals', { mon: monId });
        return;
      }
      case 'AD_TLPT': {
        const spot = this.randomFloorTile();
        if (spot) {
          player.x = spot.x;
          player.y = spot.y;
          this.refreshFov();
        }
        this.log('msg.monTeleport', { mon: monId });
        return;
      }
      // 偷窃与诱惑：夺走一件物品后脱身。
      case 'AD_SITM':
      case 'AD_SEDU': {
        const stolen = this.stealItem();
        if (!stolen) {
          this.log('msg.stealNothing', { mon: monId });
          return;
        }
        this.log('msg.monSteals', { mon: monId, item: describeItem(stolen) });
        this.fleeMonster(mon);
        return;
      }
      case 'AD_SGLD': {
        if (player.gold <= 0) {
          this.log('msg.stealNothing', { mon: monId });
          return;
        }
        const amount = Math.max(1, Math.floor(player.gold / 2));
        player.gold -= amount;
        this.log('msg.monStealsGold', { mon: monId, n: amount });
        this.fleeMonster(mon);
        return;
      }
      case 'AD_CURS': {
        const target = this.randomCarriedItem();
        if (!target || target.buc === 'cursed') {
          this.log('msg.monNoEffect', { mon: monId });
          return;
        }
        target.buc = 'cursed';
        this.log('msg.monCurses', { mon: monId, item: describeItem(target) });
        return;
      }
      case 'AD_ENCH': {
        const target = this.randomEquippedItem();
        if (!target || target.enchant <= -5) {
          this.log('msg.monNoEffect', { mon: monId });
          return;
        }
        target.enchant--;
        this.log('msg.monDisenchants', { mon: monId, obj: target.proto.id });
        return;
      }
      case 'AD_CNCL': {
        const hadMagic = player.seeInvisible || this.hasInvisibility();
        player.seeInvisible = false;
        player.invisible = 0;
        this.log(hadMagic ? 'msg.monCancels' : 'msg.monNoEffect', { mon: monId });
        return;
      }
      // 缠住玩家：立即伤害加上定身若干回合。
      case 'AD_WRAP':
      case 'AD_DGST': {
        player.held = Math.max(player.held, 4 + this.rng.rn2(5));
        damage(Math.max(1, roll()), ad === 'AD_DGST' ? 'msg.monSwallows' : 'msg.monGrabs');
        return;
      }
      case 'AD_LEGS': {
        player.held = Math.max(player.held, 8 + this.rng.rn2(9));
        damage(Math.max(1, roll()), 'msg.monStealsLegs');
        return;
      }
      case 'AD_STON': {
        if (resists.has('stone')) {
          this.log('msg.resistStone', { mon: monId });
          return;
        }
        player.petrifying = Math.max(player.petrifying, 4 + this.rng.rn2(3));
        this.log('msg.petrifying', { mon: monId });
        return;
      }
      case 'AD_DISN': {
        if (resists.has('disint')) {
          this.log('msg.resistDisint', { mon: monId });
          return;
        }
        player.takeDamage(player.hp);
        this.dead = true;
        this.log('msg.disintegrated', { mon: monId });
        log.warn('玩家被分解', { turn: this.turn, depth: this.depth, killer: monId });
        return;
      }
      case 'AD_STUN': {
        player.stun = Math.max(player.stun, Math.min(20, roll()));
        this.log('msg.monStun', { mon: monId });
        return;
      }
      case 'AD_SLOW': {
        // 本作没有速度系统，缓慢只能用提示表达。
        this.log('msg.monSlow', { mon: monId });
        return;
      }
      // 变形、黏液与幻觉：变形换成怪物形态，其余没有对应机制，用短暂混乱代替。
      case 'AD_POLY': {
        const res = this.polymorph();
        if (res.changed) this.log('msg.monPolyForm', { mon: monId, form: res.monId });
        else if (res.blocked) this.log('msg.monPolyBlocked', { mon: monId });
        else this.log('msg.monPoly', { mon: monId });
        return;
      }
      case 'AD_SLIM':
      case 'AD_HALU': {
        player.confused = Math.max(player.confused, Math.min(10, Math.max(2, roll())));
        this.log(ad === 'AD_SLIM' ? 'msg.monSlime' : 'msg.monHalu', { mon: monId });
        return;
      }
      default: {
        // 少数没有对应机制的攻击（死亡触碰、瘟疫、反魔法等）保留骰子伤害。
        let dmg = monsterDamage(mon, { at: '', ad, dice }, this.rng);
        if (dmg > 0 && player.ac < 0) {
          dmg -= this.rng.rnd(-player.ac);
          if (dmg < 1) dmg = 1;
        }
        if (dmg > 0) damage(dmg, 'msg.monHits');
        return;
      }
    }
  }

  /** 从背包里随机偷走一件物品（金币不在背包里，单独结算）。 */
  private stealItem(): ItemInstance | null {
    const candidates = this.player.inventory.filter((item) => !item.gold);
    if (!candidates.length) return null;
    const item = this.rng.pick(candidates) as ItemInstance;
    // 装备中的物品会先被卸下再离开背包。
    removeFromInventory(this.player, item);
    return item;
  }

  /** 背包里随机一件物品；空背包返回 null。 */
  private randomCarriedItem(): ItemInstance | null {
    const items = this.player.inventory;
    return items.length ? (this.rng.pick(items) as ItemInstance) : null;
  }

  /** 身上装备里随机一件；没穿装备返回 null。 */
  private randomEquippedItem(): ItemInstance | null {
    const items = Object.values(this.player.equipment).filter(
      (item): item is ItemInstance => !!item,
    );
    return items.length ? (this.rng.pick(items) as ItemInstance) : null;
  }

  /** 得手的贼立刻脱离接触：传送到本层别处。 */
  /** 偷窃后逃走：传送到本层一块没有其他生物的空地。 */
  private fleeMonster(mon: Monster): void {
    const spots: { x: number; y: number }[] = [];
    for (let i = 0; i < this.level.tiles.length; i++) {
      const t = this.level.tiles[i];
      if (t !== T.ROOM && t !== T.CORR) continue;
      const x = i % COLNO;
      const y = Math.floor(i / COLNO);
      if (x === this.player.x && y === this.player.y) continue;
      // monsterAt 也会排掉它自己，避免传送到原地。
      if (monsterAt(this.level, x, y)) continue;
      spots.push({ x, y });
    }
    const spot = spots.length ? (this.rng.pick(spots) as { x: number; y: number }) : null;
    if (spot) {
      mon.x = spot.x;
      mon.y = spot.y;
    }
  }

  // -------------------------------------------------------------------------
  // 宠物
  // -------------------------------------------------------------------------

  /**
   * 按职业给玩家一只初始宠物。
   *
   * 宠物不会攻击玩家，会主动打身边的敌对怪物，并跟着玩家上下楼。
   */
  private spawnPet(): void {
    const byRole: Record<string, string> = {
      KNIGHT: 'PONY',
      WIZARD: 'KITTEN',
      HEALER: 'KITTEN',
    };
    const data = monById.get(byRole[this.player.role.id] ?? 'LITTLE_DOG');
    if (!data) return;
    const spot = DIR8.map(([dx, dy]) => ({ x: this.player.x + dx, y: this.player.y + dy })).find(
      (p) => this.freeSpot(p.x, p.y),
    );
    if (!spot) return;
    const pet = new MonsterEntity(data, spot.x, spot.y, this.rng);
    pet.tame = true;
    pet.tameness = 10;
    pet.hunger = 900;
    pet.asleep = false;
    this.level.monsters.push(pet);
    this.log('msg.petAppears', { mon: data.id });
  }

  /** 宠物的行动：先攻击身边的敌对怪物，否则跟着玩家。 */
  private petAction(mon: Monster): void {
    const foe = this.level.monsters.find(
      (m) =>
        !m.dead &&
        m !== mon &&
        !m.tame &&
        !this.isPeaceful(m) &&
        Math.max(Math.abs(m.x - mon.x), Math.abs(m.y - mon.y)) <= 1,
    );
    if (foe) {
      this.petAttack(mon, foe);
      return;
    }
    const dist = Math.max(Math.abs(mon.x - this.player.x), Math.abs(mon.y - this.player.y));
    // 贴着玩家时让路，不再挤占位置。
    if (dist > 1) this.stepMonster(mon, 1);
  }

  /** 宠物攻击敌对怪物：命中与伤害走怪物之间的公式。 */
  private petAttack(pet: Monster, foe: Monster): void {
    const atk = pet.data.attacks.find((a) => a.at !== 'AT_NONE' && a.dice[1] > 0);
    if (!atk) return;
    if (!monsterHitsMonster(pet, foe, 0, this.rng)) {
      this.log('msg.petMisses', { mon: pet.data.id });
      return;
    }
    const dmg = Math.max(1, monsterDamage(pet, atk, this.rng));
    foe.mhp -= dmg;
    this.log('msg.petHits', { mon: pet.data.id, target: foe.data.id, dmg });
    if (foe.mhp <= 0) this.slayMonster(foe, false);
  }

  /** 换层时把原层的宠物带到新层，放在玩家身边。 */
  private followPets(from: Level, to: Level): void {
    for (const pet of from.monsters.filter((m) => m.tame && !m.dead)) {
      const spot = DIR8.map(([dx, dy]) => ({
        x: this.player.x + dx,
        y: this.player.y + dy,
      })).find((p) => this.freeSpot(p.x, p.y));
      if (!spot) continue; // 放不下就留在原层
      const slot = from.monsters.indexOf(pet);
      if (slot >= 0) from.monsters.splice(slot, 1);
      pet.x = spot.x;
      pet.y = spot.y;
      pet.mv = 0;
      to.monsters.push(pet);
    }
  }

  // -------------------------------------------------------------------------
  // 楼层切换
  // -------------------------------------------------------------------------

  /**
   * 任务总部的下行封锁。
   *
   * 对应原版的 `ok_to_quest()`：在任务总部（任务第一层）里，没经领袖
   * 许可前楼梯、地洞与楼层传送都无法下行；杀了领袖或复命之后解封。
   */
  questDescentBlocked(): boolean {
    return (
      this.branch === 'quest' &&
      this.depth === 1 &&
      !this.questUnlocked &&
      !this.questComplete &&
      !this.questLeaderDead
    );
  }

  changeDepth(
    depth: number,
    direction: 'up' | 'down',
    branch: string = this.branch,
  ): ActionResultInfo {
    // 任务总部的下行封锁放在入口处，未预期的下行路径也被拦下；
    // 具体调用方负责给消息，这里只拒绝换层。
    if (direction === 'down' && depth > this.depth && this.questDescentBlocked()) {
      log.info('任务下行被拦下', { from: this.depth, to: depth });
      return { result: 'blocked' };
    }
    log.info('切换楼层', {
      from: this.depth,
      to: depth,
      direction,
      branch,
      turn: this.turn,
    });
    const fromBranch = this.branch;
    const from = this.level;
    // 换层前先把商店的账结清，否则就成了跨层偷窃。
    this.settleShopDebt(true);
    const target = branch === 'main' ? this.getLevel(depth) : this.getBranchLevel(branch, depth);
    let arrival = direction === 'down' ? target.up : target.down;
    // 从主地牢下到分支时，落在分支入口楼梯上（推箱的入口在底层）。
    if (direction === 'down' && branch !== 'main' && fromBranch === 'main') {
      const entrance = target.stairs.find((s) => s.dir === 'branch' && s.branch === branch);
      if (entrance) arrival = { x: entrance.x, y: entrance.y };
    }
    // 从分支回到主地牢时，落在入口楼梯上，而不是普通下行楼梯。
    if (direction === 'up' && branch === 'main' && fromBranch !== 'main') {
      const exit = target.stairs.find((s) => s.dir === 'branch' && s.branch === fromBranch);
      if (exit) arrival = { x: exit.x, y: exit.y };
      else {
        // 隐藏分支（异界）的入口是魔法传送门，不在楼梯表里。
        const portal = [...target.traps].find(([, trap]) => trap.type === 'MAGIC_PORTAL');
        if (portal) arrival = coords(portal[0]);
      }
    }
    if (!arrival) arrival = target.down ?? target.up ?? target.start ?? { x: 1, y: 1 };
    this.depth = depth;
    this.branch = branch;
    this.level = target;
    this.digging = null;
    this.player.x = arrival.x;
    this.player.y = arrival.y;
    // 楼梯口可能站着怪物：先把它挪到相邻空地，避免与玩家重叠。
    const occupant = monsterAt(target, arrival.x, arrival.y);
    if (occupant) this.fleeMonster(occupant);
    this.ensureLevelPopulation(target);
    this.followPets(from, target);
    // 挑衅戒指：一进场就把整层怪物吵醒。
    if (this.hasEquipmentPower('AGGRAVATE_MONSTER')) {
      let woke = 0;
      for (const mon of target.monsters) {
        if (mon.dead || !mon.asleep) continue;
        mon.asleep = false;
        woke++;
      }
      if (woke > 0) this.log('msg.aggravate', { n: woke });
    }
    this.log(direction === 'down' ? 'msg.descend' : 'msg.ascend', { depth });
    if (target.branch) this.log('msg.branchEnter', { branch: target.branch });
    if (target.special) this.log('msg.specialLevel', { special: target.special });
    // 带着护身符回到地面才算通关。
    if (depth === 1 && branch === 'main' && this.carryingAmulet && !this.victory) {
      this.victory = true;
      log.info('玩家带护身符回到地面', { turn: this.turn });
      this.log('msg.victory');
    }
    // 带着护身符时，巫师会追着换层。
    if (this.carryingAmulet && !this.victory && this.rng.chance(0.5)) {
      this.spawnAmuletHunter();
    }
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
