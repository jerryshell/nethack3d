/**
 * Agent 反馈循环的场景库。
 *
 * 每个场景都是一条确定性的游戏路径：给定种子必然复现同样的走向，
 * 内部定期执行不变量检查，并返回可被 Agent 解析的指标与失败项。
 *
 * 新增场景的约定：
 *
 * 1. 只用 `newSession(seed, ...)` 创建会话，不依赖全局状态。
 * 2. 每次状态变更后调用 `checkInvariants`，把问题交给 `Checker.absorb`。
 * 3. 指标写进 `metrics`，便于 Agent 判断行为是否偏离预期。
 * 4. 失败时给出 `repro` 命令，方便一条命令复现。
 */

import type { Failure, ScenarioResult } from './agent-lib';
import {
  Checker,
  FIXED_CHARACTER,
  checkInvariants,
  checkLevelDeterminism,
  createSeenTracker,
  monsterSummary,
  newSession,
  randomAction,
  renderMap,
  seenCount,
  standBeside,
  stepTowardGoal,
  teleportPlayer,
  testRng,
  walkableAt,
} from './agent-lib';
import type { Level as LevelType, MonsterData, ObjectData } from '../src/types';
import { MAX_DEPTH } from '../src/game/session';
import { BRANCHES } from '../src/game/branches';
import { index, inRoom, shopRoom } from '../src/game/dungeon';
import { makeItem, SHOP_TYPES, shopBuyPrice, shopSellPrice } from '../src/game/items';
import { addToInventory, wearItem, wieldItem } from '../src/game/inventory';
import { clearBones, loadBones, saveBones } from '../src/game/bones';
import { Monster } from '../src/game/monsters';
import { monById, objById } from '../src/data/index';
import { FEATURE_ACTIONS, type FeatureAction } from '../src/game/features';
import { serializeSession, restoreSession } from '../src/game/save';
import { computeFov } from '../src/game/fov';
import { T, COLNO } from '../src/core/constants';

/** 场景定义。 */
interface Scenario {
  name: string;
  description: string;
  run(seed: number): ScenarioResult;
}

/** 状态摘要：失败快照的头部信息。 */
export function describeState(session: ReturnType<typeof newSession>): string {
  const s = session.status;
  return [
    `第 ${s.depth} 层 回合 ${s.turn}`,
    `生命 ${s.hp}/${s.maxHp} 法力 ${s.pw}/${s.maxPw} 防御 ${s.ac}`,
    `等级 ${s.level} 经验 ${s.xp} 金币 ${s.gold} 击杀 ${s.kills}`,
    `角色 ${s.role}/${s.race}/${s.align} 位置 ${session.player.x},${session.player.y}`,
    `怪物 ${session.level.monsters.length} 地面物品堆 ${session.level.objects.length}`,
  ].join('\n');
}

/** 复现命令，出现在失败详情与报告提示中。 */
function repro(name: string, seed: number): string {
  return `bun tools/agent-loop.ts --scenario=${name} --seed=${seed}`;
}

/** 统一的场景执行外壳：负责计时与结果组装。 */
function runScenario(
  name: string,
  seed: number,
  body: (checker: Checker) => {
    metrics?: Record<string, number | string | boolean>;
    actions?: number;
    invariantChecks?: number;
  },
): ScenarioResult {
  const started = Date.now();
  const checker = new Checker(name);
  let extra: ReturnType<typeof body> = {};
  try {
    extra = body(checker);
  } catch (err) {
    checker.fail(
      '运行时异常',
      err instanceof Error ? (err.stack ?? err.message) : String(err),
      repro(name, seed),
    );
  }
  const failures: Failure[] = checker.failures;
  return {
    name,
    ok: failures.length === 0,
    durationMs: Date.now() - started,
    actions: extra.actions ?? 0,
    invariantChecks: extra.invariantChecks ?? 0,
    metrics: extra.metrics ?? {},
    failures,
    dump: failures.length ? checker.renderDump() : undefined,
  };
}

// ---------------------------------------------------------------------------
// 场景实现
// ---------------------------------------------------------------------------

/** 新游戏：初始状态、视野与关卡地形是否合理。 */
const boot: Scenario = {
  name: 'boot',
  description: '创建新游戏，检查初始状态、视野与关卡地形',
  run: (seed) =>
    runScenario('boot', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => `${describeState(session)}\n\n${renderMap(session)}`);

      checker.absorb('初始状态自洽', checkInvariants(session), repro('boot', seed));
      checker.ok(session.depth === 1, '起始楼层为 1', `depth=${session.depth}`);
      checker.ok(
        player.hp > 0 && player.hp === player.maxHp,
        '初始生命已满',
        `${player.hp}/${player.maxHp}`,
      );
      checker.ok(player.inventory.length > 0, '初始装备非空', `物品数=${player.inventory.length}`);
      checker.ok(level.rooms.length >= 3, '房间数量不少于 3', `实际=${level.rooms.length}`);
      checker.ok(!!level.down, '第 1 层存在下行楼梯');
      checker.absorb('关卡可复现', checkLevelDeterminism(seed, 1), repro('boot', seed));

      const fov = computeFov(level, player.x, player.y);
      let visible = 0;
      for (let i = 0; i < fov.length; i++) visible += fov[i];
      checker.ok(visible > 1, '视野内至少有两个可见格', `可见=${visible}`);
      checker.ok(
        player.x >= 0 && player.y >= 0 && walkableAt(level, player.x, player.y),
        '起始位置可通行',
        `位置=${player.x},${player.y}`,
      );

      // 视野内的瓦片必须写入记忆。
      let remembered = 0;
      for (let i = 0; i < fov.length; i++) if (fov[i]) remembered += level.seen[i] ? 1 : 0;
      checker.ok(
        remembered === visible,
        '可见瓦片均写入迷雾记忆',
        `可见=${visible} 已记忆=${remembered}`,
      );

      return {
        metrics: {
          rooms: level.rooms.length,
          visibleTiles: visible,
          doors: level.doors.size,
          traps: level.traps.size,
          monsters: level.monsters.length,
          inventory: player.inventory.length,
        },
        actions: 0,
        invariantChecks: 1,
      };
    }),
};

/** 随机行走：用随机行动覆盖移动、等待、拾取与使用物品。 */
const walk: Scenario = {
  name: 'walk',
  description: '随机行动若干步，逐步检查不变量',
  run: (seed) =>
    runScenario('walk', seed, (checker) => {
      const session = newSession(seed);
      const rng = testRng(seed, 'walk');
      const tracker = createSeenTracker();
      checker.attachDump(() => `${describeState(session)}\n\n${renderMap(session)}`);
      const steps = 240;
      let invariants = 0;
      let descents = 0;
      let pickups = 0;
      let uses = 0;
      const kinds = new Set<string>();

      for (let i = 0; i < steps && !session.dead; i++) {
        const action = randomAction(session, rng);
        kinds.add(action.action.split(':')[0]);
        if (action.action === 'pickup' && action.delta > 0) pickups++;
        if (
          action.action.startsWith('use:') ||
          action.action.startsWith('wield:') ||
          action.action.startsWith('wear:')
        ) {
          uses++;
        }
        if (action.result === 'descended' || action.result === 'ascended') descents++;

        const problems = checkInvariants(session, tracker);
        invariants++;
        if (problems.length) {
          checker.absorb(`第 ${i} 步后状态自洽`, problems, repro('walk', seed));
          break;
        }
        if (action.delta < 0) {
          checker.fail('回合数单调不减', `行动 ${action.action} 使回合数回退`, repro('walk', seed));
          break;
        }
      }

      checker.ok(session.turn > 0, '随机行走产生了回合变化', `回合=${session.turn}`);
      checker.ok(kinds.size >= 3, '随机行动覆盖至少三类操作', `实际=${[...kinds].join(',')}`);
      checker.ok(
        session.player.hp <= session.player.maxHp && session.player.hp >= 0,
        '生命维持在上限内',
        `${session.player.hp}/${session.player.maxHp}`,
      );

      return {
        metrics: {
          steps,
          turn: session.turn,
          distinctActions: kinds.size,
          pickups,
          uses,
          descents,
          dead: session.dead,
        },
        actions: session.turn,
        invariantChecks: invariants,
      };
    }),
};

/** 下潜：用寻路走到下行楼梯，连续下潜若干层。 */
const descend: Scenario = {
  name: 'descend',
  description: '寻路至下行楼梯并连续下潜，检查每层地形与不变量',
  run: (seed) =>
    runScenario('descend', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => `${describeState(session)}\n\n${renderMap(session)}`);
      // 本场景验证下楼流程与关卡连通性，不验证生存能力，因此提升玩家强度，
      // 并在每次行动后消去伤害与异常，保证任何种子都能走到目标层。
      session.player.maxHp = 500;
      session.player.hp = 500;
      session.player.level = 10;
      const targetDepth = 5;
      const tracker = createSeenTracker();
      let steps = 0;
      let invariants = 0;

      while (session.depth < targetDepth && steps < 900 && !session.dead) {
        // 本场景只验证下楼路径与连通性，清场避免怪物堵路。
        session.level.monsters = [];
        const down = session.level.down;
        if (!down) {
          checker.fail(
            '每层都有下行楼梯',
            `第 ${session.depth} 层缺少下行楼梯`,
            repro('descend', seed),
          );
          break;
        }
        if (session.player.x === down.x && session.player.y === down.y) {
          // 已经站在楼梯上，等待即可触发下楼。
          session.wait();
          steps++;
          session.player.hp = session.player.maxHp;
          session.player.petrifying = 0;
          session.player.sick = 0;
          continue;
        }
        // 绕开上行与分支楼梯：下楼路径穿过它们会离开当前分支。
        const avoid = new Set<number>();
        for (const s of session.level.stairs) {
          if (s.dir !== 'down') avoid.add(index(s.x, s.y));
        }
        const dirWithAvoid = stepTowardGoal(
          session.level,
          { x: session.player.x, y: session.player.y },
          down,
          avoid,
        );
        // 避免集合让楼梯不可达时允许穿过楼梯，随后再把玩家送回本层。
        const dir =
          dirWithAvoid ??
          stepTowardGoal(session.level, { x: session.player.x, y: session.player.y }, down);
        if (!dir) {
          checker.fail('下行楼梯可达', `第 ${session.depth} 层寻路失败`, repro('descend', seed));
          break;
        }
        const depthBefore = session.depth;
        const branchBefore = session.branch;
        session.movePlayer(dir[0], dir[1]);
        steps++;
        session.player.hp = session.player.maxHp;
        session.player.petrifying = 0;
        session.player.sick = 0;
        // 误入分支或误上楼梯时回到原层继续。
        if (session.branch !== branchBefore) {
          const entrance = BRANCHES[session.branch]?.entranceDepth ?? depthBefore;
          session.changeDepth(entrance, 'up', 'main');
          continue;
        }
        if (session.depth < depthBefore) {
          session.changeDepth(depthBefore, 'down');
          continue;
        }

        if (session.depth !== depthBefore) {
          checker.absorb(
            `第 ${session.depth} 层地形可复现`,
            checkLevelDeterminism(seed, session.depth),
            repro('descend', seed),
          );
        }
        const problems = checkInvariants(session, tracker);
        invariants++;
        if (problems.length) {
          checker.absorb(`第 ${steps} 步后状态自洽`, problems, repro('descend', seed));
          break;
        }
      }

      checker.ok(
        !session.dead,
        '下潜过程未死亡',
        `在第 ${session.depth} 层阵亡，回合=${session.turn}`,
        repro('descend', seed),
      );
      checker.ok(
        session.depth >= targetDepth,
        `成功下潜到第 ${targetDepth} 层`,
        `实际到达第 ${session.depth} 层`,
        repro('descend', seed),
      );

      return {
        metrics: {
          depth: session.depth,
          steps,
          turn: session.turn,
          monstersSeen: session.level.monsters.length,
        },
        actions: steps,
        invariantChecks: invariants,
      };
    }),
};

/** 战斗：构造一场遭遇战，验证命中、伤害、击杀与经验结算。 */
const combat: Scenario = {
  name: 'combat',
  description: '与怪物交战至击杀，检查伤害、击杀计数与经验',
  run: (seed) =>
    runScenario('combat', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => `${describeState(session)}\n\n${renderMap(session)}`);

      // 强化玩家并把目标怪物削弱到可在一场内击杀。
      player.maxHp = 80;
      player.hp = 80;
      player.level = 5;
      player.str = 18;

      const target = level.monsters[0];
      if (!target) {
        checker.fail('关卡内存在怪物', '第 1 层没有生成怪物', repro('combat', seed));
        return {};
      }
      target.mhp = 6;
      target.mhpmax = 6;
      target.asleep = false;

      const toward = standBeside(session, target);
      if (!toward) {
        checker.fail('目标旁边有落脚点', '四周都不可站立', repro('combat', seed));
        return {};
      }
      const beforeXp = player.xp;
      const beforeKills = session.kills;
      let attacks = 0;
      let missed = 0;
      let hits = 0;
      let invariants = 0;

      for (let i = 0; i < 60; i++) {
        const damageBefore = target.mhp;
        // 直接调用攻击：本场景验证战斗数值，目标逃跑时仍能持续攻击。
        const outcome = session.attackMonster(target);
        attacks++;
        if (target.mhp < damageBefore) hits++;
        else missed++;
        invariants++;
        // 与真实回合一致：死亡怪物在行动阶段结束时移出列表。
        if (target.dead) level.monsters = level.monsters.filter((m) => !m.dead);
        const problems = checkInvariants(session);
        if (problems.length) {
          checker.absorb(`第 ${attacks} 次攻击后状态自洽`, problems, repro('combat', seed));
          break;
        }
        if (outcome === 'killed' || target.dead) break;
        if (session.dead) break;
      }

      checker.ok(hits > 0, '至少命中一次', `命中=${hits} 未命中=${missed}`, repro('combat', seed));
      checker.ok(session.kills > beforeKills, '击杀计数增加', `击杀=${session.kills}`);
      checker.ok(player.xp > beforeXp, '获得经验', `经验=${beforeXp} -> ${player.xp}`);
      checker.ok(
        !level.monsters.includes(target),
        '死亡怪物已移出列表',
        `剩余=${level.monsters.length}`,
      );
      checker.ok(!session.dead, '测试用玩家未被击杀');

      return {
        metrics: {
          attacks,
          hits,
          missed,
          kills: session.kills,
          xpGain: player.xp - beforeXp,
          hpLeft: player.hp,
          monsters: level.monsters.length,
        },
        actions: attacks,
        invariantChecks: invariants,
      };
    }),
};

/** 物品：拾取、持握、穿戴、喝药、进食，验证状态变化与消耗。 */
/**
 * 开启仪式：三件圣物的位置、振动方块的传送门与星界的登神。
 *
 * 覆盖完整终局路径：任务仇敌守着开启之铃、巫妖塔底藏着祈祷烛台、
 * 死亡之书在圣所；集齐后在振动方块举行仪式，进入异界把护身符献给
 * 自己阵营的祭坛。
 */
const invocation: Scenario = {
  name: 'invocation',
  description: '收集三件开启圣物，在振动方块开启传送门，到星界献上护身符',
  run: (seed) =>
    runScenario('invocation', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => `${describeState(session)}\n\n${renderMap(session)}`);
      const call = repro('invocation', seed);
      // 仪式会惊醒圣所的全部恶魔，给测试角色足够的生命值，
      // 避免被贴脸的恶魔当场打死而中断终局流程。
      session.player.maxHp = 300;
      session.player.hp = 300;
      const hasItem = (id: string): boolean =>
        session.player.inventory.some((i) => i.proto.id === id);
      const pickUp = (id: string, buc: 'cursed' | 'uncursed' = 'uncursed') => {
        const proto = objById.get(id);
        if (!proto) throw new Error(`缺少物品原型 ${id}`);
        const item = makeItem(proto, session.rng);
        item.buc = buc;
        addToInventory(session.player, item);
      };

      // 开启之铃在任务仇敌脚下。
      session.changeDepth(1, 'down', 'quest');
      session.changeDepth(5, 'down', 'quest');
      const bell = session.level.objects
        .flatMap((p) => p.items)
        .find((i) => i.id === 'BELL_OF_OPENING');
      checker.ok(!!bell, '任务目标层放着开启之铃', '', call);
      // 祈祷烛台在巫妖塔底层。
      session.changeDepth(1, 'down', 'vlad');
      session.changeDepth(4, 'down', 'vlad');
      const candelabrum = session.level.objects
        .flatMap((p) => p.items)
        .find((i) => i.id === 'CANDELABRUM_OF_INVOCATION');
      checker.ok(!!candelabrum, '巫妖塔底层放着祈祷烛台', '', call);
      // 死亡之书在圣所。
      session.changeDepth(29, 'down', 'main');
      const book = session.level.objects
        .flatMap((p) => p.items)
        .find((i) => i.id === 'SPE_BOOK_OF_THE_DEAD');
      checker.ok(!!book, '圣所放着死亡之书', '', call);
      const square = [...session.level.traps].find(([, t]) => t.type === 'VIBRATING_SQUARE');
      checker.ok(!!square, '圣所有一块振动方块', '', call);
      if (!square) {
        return {
          metrics: { relics: 0 } as Record<string, number | string | boolean>,
          actions: 4,
          invariantChecks: 1,
        };
      }
      teleportPlayer(session, square[0] % COLNO, Math.floor(square[0] / COLNO));

      // 缺圣物时仪式不生效，也无传送门。
      session.invokeRitual();
      checker.ok(
        session.level.traps.get(square[0])?.type === 'VIBRATING_SQUARE',
        '缺圣物时不会开启传送门',
      );
      // 诅咒的圣物让仪式失败。
      pickUp('BELL_OF_OPENING', 'cursed');
      pickUp('CANDELABRUM_OF_INVOCATION');
      pickUp('SPE_BOOK_OF_THE_DEAD');
      session.invokeRitual();
      checker.ok(
        session.level.traps.get(square[0])?.type === 'VIBRATING_SQUARE',
        '诅咒的圣物让仪式失败',
      );
      // 解除诅咒后仪式成功，原地出现传送门。
      const cursedBell = session.player.inventory.find((i) => i.id === 'BELL_OF_OPENING');
      if (cursedBell) cursedBell.buc = 'uncursed';
      session.invokeRitual();
      checker.ok(
        session.level.traps.get(square[0])?.type === 'MAGIC_PORTAL',
        '仪式开启魔法传送门',
        session.level.traps.get(square[0])?.type ?? '-',
        call,
      );
      checker.absorb('开启传送门后状态自洽', checkInvariants(session), call);

      // 踏入传送门：先到土之位面，再过气、火、水三面抵达星界。
      session.enterPortal();
      checker.ok(
        session.branch === 'planes' && session.depth === 1,
        '传送门通往异界第一层',
        `branch=${session.branch} depth=${session.depth}`,
        call,
      );
      checker.ok(
        session.level.special === 'plane_earth',
        '异界第一层是土之位面',
        session.level.special ?? '-',
        call,
      );
      // 土之位面没楼梯：拾起保底镐，向下挖穿地板到气之位面。
      const pick = session.level.objects.flatMap((p) => p.items).find((i) => i.id === 'PICK_AXE');
      checker.ok(!!pick, '土之位面放着保底镐', '', call);
      checker.ok(!session.level.down, '土之位面没有下行楼梯', '', call);
      if (pick) {
        addToInventory(session.player, pick);
        wieldItem(session.player, pick);
        session.player.hp = session.player.maxHp;
        const spot = (
          [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as [number, number][]
        )
          .map(([dx, dy]) => ({ x: session.player.x + dx, y: session.player.y + dy }))
          .find((p) => session.level.tiles[index(p.x, p.y)] === T.ROOM);
        if (spot) {
          session.player.x = spot.x;
          session.player.y = spot.y;
        }
        for (let n = 0; n < 3; n++) {
          session.player.hp = session.player.maxHp;
          session.digDown();
        }
        checker.ok(
          session.level.special === 'plane_air',
          '挖穿土之位面到达气之位面',
          session.level.special ?? '-',
          call,
        );
      }
      const planes: [number, string][] = [
        [3, 'plane_fire'],
        [4, 'plane_water'],
        [5, 'astral'],
      ];
      for (const [depth, id] of planes) {
        session.changeDepth(depth, 'down', 'planes');
        checker.ok(
          session.level.special === id,
          `异界第 ${depth} 层是${id}`,
          session.level.special ?? '-',
          call,
        );
      }
      const altars = [...session.level.features].filter(([, f]) => f.type === 'ALTAR');
      checker.ok(altars.length === 3, '星界有三座阵营祭坛', `n=${altars.length}`, call);
      checker.ok(
        altars.some(([, f]) => f.align === session.player.align),
        '祭坛包含玩家阵营',
        altars.map(([, f]) => f.align).join(','),
        call,
      );
      checker.absorb('星界状态自洽', checkInvariants(session), call);

      // 带着护身符：献错祭坛会受罚，献给自己阵营的祭坛则登神。
      session.player.hp = session.player.maxHp;
      pickUp('AMULET_OF_YENDOR');
      const wrong = altars.find(([, f]) => f.align && f.align !== session.player.align);
      if (wrong) {
        teleportPlayer(session, wrong[0] % COLNO, Math.floor(wrong[0] / COLNO));
        const hpBefore = session.player.hp;
        session.offerAmulet();
        checker.ok(!session.victory, '献错祭坛不会登神');
        checker.ok(session.player.hp < hpBefore, '献错祭坛会受到惩罚', `hp=${session.player.hp}`);
        checker.ok(hasItem('AMULET_OF_YENDOR'), '献错祭坛不会失去护身符');
      }
      const own = altars.find(([, f]) => f.align === session.player.align);
      checker.ok(!!own, '存在玩家阵营的祭坛', '', call);
      if (own) {
        session.player.hp = session.player.maxHp;
        teleportPlayer(session, own[0] % COLNO, Math.floor(own[0] / COLNO));
        session.offerAmulet();
        checker.ok(
          session.victory,
          '在自家祭坛献上护身符即登神',
          `victory=${session.victory}`,
          call,
        );
        checker.ok(!hasItem('AMULET_OF_YENDOR'), '献上的护身符已经交出');
        checker.ok(
          session.messages.some((m) => m.key === 'msg.ascended'),
          '记录登神消息',
          session.messages
            .slice(-2)
            .map((m) => m.key)
            .join(','),
        );
        checker.absorb('登神后状态自洽', checkInvariants(session), call);
      }

      return {
        metrics: {
          relics: Number(!!bell) + Number(!!candelabrum) + Number(!!book),
          altars: altars.length,
          ascended: session.victory,
          attempts: session.player.alignRecord,
        },
        actions: 6,
        invariantChecks: 3,
      };
    }),
};

const items: Scenario = {
  name: 'items',
  description: '拾取与使用物品，检查鉴定、恢复与消耗',
  run: (seed) =>
    runScenario('items', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(
        () =>
          `${describeState(session)}\n背包：${player.inventory.map((i) => i.proto.id).join(', ')}`,
      );
      const invBefore = player.inventory.length;

      // 拾取：站到有物品的格子；先清场，避免传送与怪物重叠。
      level.monsters = [];
      const pile = level.objects.find((p) => p.items.some((i) => !i.gold));
      if (!pile) {
        checker.fail('关卡内存在地面物品', '第 1 层没有非金币物品', repro('items', seed));
        return {};
      }
      teleportPlayer(session, pile.x, pile.y);
      const pickup = session.pickupAction();
      checker.ok(
        pickup.result === 'picked',
        '拾取成功',
        `结果=${pickup.result}`,
        repro('items', seed),
      );
      checker.ok(
        player.inventory.length >= invBefore,
        '背包物品数未减少',
        `${invBefore} -> ${player.inventory.length}`,
      );

      // 持握武器：装备槽应指向背包内的武器。
      const weapon = player.inventory.find((i) => i.proto.cls === 'weapon');
      if (weapon) {
        session.useItem(weapon, 'wield');
        checker.ok(
          player.equipment.weapon === weapon,
          '武器已持握',
          `槽位=${player.equipment.weapon?.proto.id}`,
        );
      }

      // 喝药：治疗药水应恢复生命并消耗。
      const healing = player.inventory.find((i) => i.proto.id === 'POT_HEALING');
      if (healing) {
        player.hp = 1;
        const before = player.hp;
        session.useItem(healing);
        checker.ok(player.hp > before, '治疗药水恢复生命', `${before} -> ${player.hp}`);
        checker.ok(healing.known, '使用后药水被鉴定', `known=${healing.known}`);
        checker.ok(
          !player.inventory.includes(healing),
          '药水被消耗',
          `剩余=${player.inventory.length}`,
        );
      }

      // 进食：饱食度应上升。
      const food = player.inventory.find((i) => i.proto.cls === 'food');
      if (food) {
        player.hunger = 100;
        const before = player.hunger;
        session.useItem(food);
        checker.ok(player.hunger > before, '进食提升饱食度', `${before} -> ${player.hunger}`);
      }

      // 充能卷轴：给法杖补能。
      const wand = makeItem(objById.get('WAN_FIRE') as ObjectData, session.rng);
      wand.charges = 1;
      addToInventory(player, wand);
      const wandCharges = (): number =>
        player.inventory
          .filter((i) => i.proto.cls === 'wand')
          .reduce((n, i) => n + (i.charges ?? 0), 0);
      const beforeCharges = wandCharges();
      const charging = makeItem(objById.get('SCR_CHARGING') as ObjectData, session.rng);
      charging.buc = 'uncursed';
      addToInventory(player, charging);
      session.useItem(charging);
      checker.ok(
        wandCharges() === beforeCharges + 2,
        '充能卷轴给法杖补能',
        `${beforeCharges} -> ${wandCharges()}`,
      );

      checker.absorb('物品操作后状态自洽', checkInvariants(session), repro('items', seed));

      return {
        metrics: {
          inventory: player.inventory.length,
          weapon: player.equipment.weapon?.proto.id ?? '无',
          armor: player.equipment.suit?.proto.id ?? '无',
          hunger: player.hunger,
        },
        actions: 3,
        invariantChecks: 1,
      };
    }),
};

/** 商店：买入、卖出与付不起时的拒绝，并验证店主在受挑衅前保持和平。 */
const shop: Scenario = {
  name: 'shop',
  description: '在商店里买入、卖出与付不起时拒绝交易',
  run: (seed) =>
    runScenario('shop', seed, (checker) => {
      let session = newSession(seed);
      // 后续要故意触怒店主，先给测试角色足够生命，避免被当场打死。
      session.player.maxHp = 200;
      session.player.hp = 200;
      checker.attachDump(() => `${describeState(session)}\n商店层=${session.depth}`);

      // 逐层查找商店：关卡生成是确定性的，同一颗种子结果一致；
      // 极少数种子 30 层内没有商店，换盐种子继续找。
      const findShopDepth = (target: ReturnType<typeof newSession>): number => {
        for (let depth = 2; depth < MAX_DEPTH; depth++) {
          if (shopRoom(target.getLevel(depth))) return depth;
        }
        return -1;
      };
      let shopDepth = findShopDepth(session);
      for (let salt = 1; salt <= 8 && shopDepth < 0; salt++) {
        session = newSession((seed + salt * 0x9e3779b1) >>> 0, { character: session.character });
        shopDepth = findShopDepth(session);
      }
      if (shopDepth < 0) {
        checker.fail('存在带商店的楼层', `${MAX_DEPTH} 层内没有商店`, repro('shop', seed));
        return {
          metrics: { depth: -1, shopType: '-', buyPrice: 0, sellPrice: 0, stock: 0, gold: 0 },
        };
      }
      session.changeDepth(shopDepth, 'down');
      const level = session.level;
      const room = shopRoom(level);
      if (!room) {
        checker.fail('商店楼层有商店', `第 ${shopDepth} 层商店丢失`, repro('shop', seed));
        return {
          metrics: {
            depth: shopDepth,
            shopType: '-',
            buyPrice: 0,
            sellPrice: 0,
            stock: 0,
            gold: 0,
          },
        };
      }

      const keeper = level.monsters.find((m) => !m.dead && m.data.id === 'SHOPKEEPER');
      checker.ok(!!keeper, '店主在场', '商店里没有店主', repro('shop', seed));
      checker.ok(
        !!room.shopType && room.shopType in SHOP_TYPES,
        '商店有合法种类',
        `种类=${room.shopType ?? '无'}`,
        repro('shop', seed),
      );

      // 买入：带上足够的金币拾取一件货。
      const pile = level.objects.find(
        (p) => inRoom(room, p.x, p.y) && p.items.some((i) => i.unpaid),
      );
      const goods = pile?.items.find((i) => i.unpaid);
      if (!pile || !goods) {
        checker.fail('商店有货', '商店地面没有未付款商品', repro('shop', seed));
        return {
          metrics: {
            depth: shopDepth,
            shopType: room.shopType ?? '-',
            buyPrice: 0,
            sellPrice: 0,
            stock: 0,
            gold: 0,
          },
        };
      }
      const buyPrice = pile.items
        .filter((i) => i.unpaid)
        .reduce((n, i) => n + shopBuyPrice(i, session.player.cha), 0);
      session.player.gold = buyPrice + 7;
      teleportPlayer(session, pile.x, pile.y);
      const goldBeforeBuy = session.player.gold;
      const bought = session.pickupAction();
      checker.ok(
        bought.result === 'picked' && session.player.inventory.includes(goods),
        '金币足够时买下商品',
        `结果=${bought.result} 金币=${session.player.gold}`,
        repro('shop', seed),
      );
      checker.ok(!goods.unpaid, '买入后结清货款', `unpaid=${goods.unpaid}`);
      checker.ok(
        goldBeforeBuy - session.player.gold === buyPrice,
        '扣款等于标价',
        `标价=${buyPrice} 扣款=${goldBeforeBuy - session.player.gold}`,
      );

      // 卖出：丢回店里，店主按半价收购。
      const sellPrice = shopSellPrice(goods, session.player.cha);
      const goldBeforeSell = session.player.gold;
      session.useItem(goods, 'drop');
      checker.ok(
        session.player.gold === goldBeforeSell + sellPrice,
        '卖出得到金币',
        `${goldBeforeSell} -> ${session.player.gold}，报价=${sellPrice}`,
      );
      checker.ok(!!goods.unpaid, '卖出的物品重新变成店产', `unpaid=${goods.unpaid}`);

      // 身无分文：先赊账拿货，离店时结账。
      session.player.gold = 0;
      const broke = session.pickupAction();
      checker.ok(
        broke.picked === 1 && session.player.inventory.includes(goods),
        '付不起时可以赊账取货',
        `结果=${broke.result} picked=${broke.picked}`,
      );
      checker.ok(goods.unpaid === true, '赊账的货品保持未付款');
      checker.ok(
        session.messages.some((m) => m.key === 'msg.shopCredit'),
        '有赊账提示',
      );

      // 找一间店外的空地用于结算测试。
      const outside = (() => {
        for (let x = 1; x < level.width - 1; x++) {
          for (let y = 1; y < level.height - 1; y++) {
            if (inRoom(room, x, y)) continue;
            if (!walkableAt(level, x, y)) continue;
            if (level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
            return { x, y };
          }
        }
        return null;
      })();
      checker.ok(!!outside, '商店外有空地', '', repro('shop', seed));

      // 离店前把金币补上，账要结清。
      if (outside) {
        const bill = shopBuyPrice(goods, session.player.cha);
        session.player.gold = bill + 3;
        teleportPlayer(session, outside.x, outside.y);
        session.wait();
        checker.ok(!goods.unpaid, '离店结清货款');
        checker.ok(
          session.player.gold === 3,
          '扣款等于标价',
          `金币=${session.player.gold}，标价=${bill}`,
        );
        checker.ok(
          session.messages.some((m) => m.key === 'msg.shopBillPaid'),
          '有结账提示',
        );
      }

      // 店主和平：清掉其它怪物贴身等待不应受伤；挑衅后转为敌对。
      if (keeper) {
        level.monsters = level.monsters.filter((m) => m === keeper);
        // 店主不能永久堵死入口：站到门口内侧后会主动让开。
        const doorway = (() => {
          for (const i of level.doors.keys()) {
            const dx0 = i % COLNO;
            const dy0 = Math.floor(i / COLNO);
            for (const [dx, dy] of [
              [-1, 0],
              [1, 0],
              [0, -1],
              [0, 1],
            ]) {
              const x = dx0 + dx;
              const y = dy0 + dy;
              if (!room || !inRoom(room, x, y)) continue;
              if (level.tiles[index(x, y)] !== T.ROOM) continue;
              if (x === session.player.x && y === session.player.y) continue;
              return { x, y };
            }
          }
          return null;
        })();
        if (doorway) {
          keeper.x = doorway.x;
          keeper.y = doorway.y;
          session.wait();
          const blocks = [...level.doors.keys()].some((i) => {
            const at = { x: i % COLNO, y: Math.floor(i / COLNO) };
            return Math.max(Math.abs(at.x - keeper.x), Math.abs(at.y - keeper.y)) <= 1;
          });
          checker.ok(
            !blocks,
            '店主让开门口',
            `位置=(${keeper.x}, ${keeper.y})`,
            repro('shop', seed),
          );
          checker.ok(
            !!room && inRoom(room, keeper.x, keeper.y),
            '店主让路后仍在店内',
            `位置=(${keeper.x}, ${keeper.y})`,
            repro('shop', seed),
          );
        } else {
          checker.ok(false, '商店门口内侧有地板格', '没找到门旁的店内地面', repro('shop', seed));
        }
        const around = [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]
          .map(([dx, dy]) => ({ x: keeper.x + dx, y: keeper.y + dy }))
          .find((p) => walkableAt(level, p.x, p.y));
        if (around) teleportPlayer(session, around.x, around.y);
        const hpBefore = session.player.hp;
        for (let i = 0; i < 6; i++) session.wait();
        checker.ok(
          session.player.hp === hpBefore,
          '店主在受挑衅前不攻击',
          `生命=${session.player.hp}`,
        );
        session.attackMonster(keeper);
        checker.ok(keeper.angry, '挑衅后店主转为敌对', `angry=${keeper.angry}`);
      }

      // 偷窃：带着未付款的货品离店，店主转为敌对并扣阵营记录。
      if (outside && keeper) {
        const stealPile = level.objects.find(
          (p) => inRoom(room, p.x, p.y) && p.items.some((i) => i.unpaid),
        );
        const stolen = stealPile?.items.find((i) => i.unpaid);
        if (stolen && stealPile) {
          teleportPlayer(session, stealPile.x, stealPile.y);
          session.player.gold = 0;
          session.pickupAction();
          const alignBefore = session.player.alignRecord;
          teleportPlayer(session, outside.x, outside.y);
          session.wait();
          checker.ok(
            session.messages.some((m) => m.key === 'msg.shopTheft'),
            '偷窃有提示',
            '',
            repro('shop', seed),
          );
          checker.ok(
            session.player.alignRecord === alignBefore - 5,
            '偷窃扣阵营记录',
            `${alignBefore} -> ${session.player.alignRecord}`,
          );
          checker.ok(!stolen.unpaid, '偷走的货物归玩家');
        }
      }

      checker.absorb('商店操作后状态自洽', checkInvariants(session), repro('shop', seed));

      return {
        metrics: {
          depth: shopDepth,
          shopType: room.shopType ?? '-',
          buyPrice,
          sellPrice,
          stock: level.objects.filter((p) => inRoom(room, p.x, p.y)).length,
          gold: session.player.gold,
        },
        actions: 3 + 6,
        invariantChecks: 1,
      };
    }),
};

/** 特殊攻击：偷窃、石化、反射与被动攻击在会话里真实结算。 */
const special: Scenario = {
  name: 'special',
  description: '结算偷窃、石化、反射与被动攻击，检查装备与状态自洽',
  run: (seed) =>
    runScenario('special', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => describeState(session));

      /** 把一只真实怪物放到玩家身边，提高等级保证命中。 */
      const place = (id: string): Monster | null => {
        const data = monById.get(id);
        if (!data) return null;
        const spot = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]
          .map(([dx, dy]) => ({ x: player.x + dx, y: player.y + dy }))
          .find(
            (p) =>
              walkableAt(level, p.x, p.y) &&
              !level.monsters.some((m) => !m.dead && m.x === p.x && m.y === p.y),
          );
        if (!spot) return null;
        const mon = new Monster(data, spot.x, spot.y, session.rng);
        mon.mlev = 40;
        mon.asleep = false;
        level.monsters.push(mon);
        return mon;
      };

      // 偷窃：装备中的物品也可能被拿走，槽位不能留下悬空引用。
      const nymph = place('WOOD_NYMPH');
      checker.ok(!!nymph, '放得下林中仙女', '玩家周围没有空位', repro('special', seed));
      if (nymph) {
        const before = player.inventory.length;
        session.monsterAttack(nymph);
        checker.ok(
          player.inventory.length < before,
          '林中仙女偷走物品',
          `背包 ${before} -> ${player.inventory.length}`,
          repro('special', seed),
        );
      }

      // 石化：先用完全治疗药水解开，状态必须复位。
      const cock = place('COCKATRICE');
      if (cock) {
        session.monsterAttack(cock);
        checker.ok(
          player.petrifying > 0,
          '鸡蛇让玩家开始石化',
          `petrifying=${player.petrifying}`,
          repro('special', seed),
        );
        const potion = makeItem(objById.get('POT_FULL_HEALING') as ObjectData, session.rng);
        addToInventory(player, potion);
        session.useItem(potion);
        checker.ok(player.petrifying === 0 && !session.dead, '完全治疗药水解石化');
      }

      // 反射：戴上反射护身符，电系攻击应弹回且玩家无伤。
      const amulet = makeItem(objById.get('AMULET_OF_REFLECTION') as ObjectData, session.rng);
      addToInventory(player, amulet);
      wearItem(player, amulet);
      const sphere = place('SHOCKING_SPHERE');
      if (sphere) {
        sphere.mhp = sphere.mhpmax = 200;
        const hp = player.hp;
        session.monsterAttack(sphere);
        checker.ok(
          player.hp === hp && sphere.mhp < 200,
          '电击被反射给攻击者',
          `玩家 ${hp} -> ${player.hp}，球体 ${sphere.mhp}/200`,
          repro('special', seed),
        );
      }

      // 被动攻击：近战命中酸块会被灼伤。
      player.hitInc = 100;
      const blob = place('ACID_BLOB');
      if (blob) {
        // 留出足够生命，让它接下这一击并触发被动酸液。
        blob.mhp = blob.mhpmax = 999;
        const hp = player.hp;
        session.attackMonster(blob);
        checker.ok(
          player.hp < hp,
          '命中酸液团触发被动酸液',
          `生命 ${hp} -> ${player.hp}`,
          repro('special', seed),
        );
      }

      checker.absorb('特殊攻击后状态自洽', checkInvariants(session), repro('special', seed));

      return {
        metrics: {
          inventory: player.inventory.length,
          petrifying: player.petrifying,
          sphereHp: sphere?.mhp ?? -1,
          hp: player.hp,
        },
        actions: 4,
        invariantChecks: 1,
      };
    }),
};

/** 祈祷：阵营记录随击杀变化，祈祷结果随神坛与冷却变化。 */
const prayer: Scenario = {
  name: 'prayer',
  description: '击杀改变阵营记录，在祭坛上祈祷并验证惩罚与冷却',
  run: (seed) =>
    runScenario('prayer', seed, (checker) => {
      let session = newSession(seed);
      checker.attachDump(() => describeState(session));

      // 少数种子 30 层内没有祭坛；换盐过的种子继续找，保证祈祷路径可测。
      const findAltar = (
        s: ReturnType<typeof newSession>,
      ): { depth: number; tile: number } | null => {
        for (let depth = 2; depth < MAX_DEPTH; depth++) {
          const level = s.getLevel(depth);
          for (const [i, feature] of level.features) {
            if (feature.type === 'ALTAR') return { depth, tile: i };
          }
        }
        return null;
      };
      let altar = findAltar(session);
      for (let salt = 1; salt <= 8 && !altar; salt++) {
        session = newSession((seed + salt * 0x9e3779b1) >>> 0, { character: session.character });
        altar = findAltar(session);
      }
      checker.ok(!!altar, '30 层内有祭坛', '', repro('prayer', seed));

      const { player } = session;
      // 击杀一只敌对怪物，阵营记录应上升。
      const imp = monById.get('IMP') as MonsterData;
      const mon = new Monster(imp, player.x + 1, player.y, session.rng);
      mon.mlev = 12;
      session.slayMonster(mon, true);
      checker.ok(
        player.alignRecord > 0,
        '击杀敌对怪物提高阵营记录',
        `record=${player.alignRecord}`,
        repro('prayer', seed),
      );

      if (altar) {
        session.changeDepth(altar.depth, 'down');
        session.level.monsters = [];
        player.hunger = 2000;
        const feature = session.level.features.get(altar.tile);
        if (feature) feature.align = player.align;
        player.x = altar.tile % COLNO;
        player.y = Math.floor(altar.tile / COLNO);
        session.refreshFov();
        player.hp = 1;
        player.blind = 5;
        player.petrifying = 3;
        session.pray();
        checker.ok(player.hp === player.maxHp, '祈祷满血', `hp=${player.hp}`);
        checker.ok(player.blind === 0 && player.petrifying === 0, '祈祷清除异常状态');
        checker.ok(player.prayerTimeout >= 299, '祈祷写入冷却', `timeout=${player.prayerTimeout}`);
        // 冷却中再次祈祷应受罚。
        const hpBefore = player.hp;
        session.pray();
        checker.ok(
          player.hp < hpBefore,
          '冷却中祈祷受伤',
          `${hpBefore} -> ${player.hp}`,
          repro('prayer', seed),
        );
      }

      checker.absorb('祈祷后状态自洽', checkInvariants(session), repro('prayer', seed));

      return {
        metrics: { record: player.alignRecord, timeout: player.prayerTimeout, hp: player.hp },
        actions: 2,
        invariantChecks: 1,
      };
    }),
};

/** 变形：喝药水变成怪物形态，战斗后等它自动恢复。 */
const poly: Scenario = {
  name: 'poly',
  description: '喝变形药水并以怪物形态战斗，验证到期恢复与状态自洽',
  run: (seed) =>
    runScenario('poly', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => describeState(session));

      level.monsters = [];
      const potion = makeItem(objById.get('POT_POLYMORPH') as ObjectData, session.rng);
      addToInventory(player, potion);
      session.useItem(potion);
      checker.ok(!!player.form, '变形药水生效', `form=${player.form?.id}`, repro('poly', seed));

      // 以怪物形态战斗：造一只耐打的怪物，连续攻击。
      const ant = monById.get('GIANT_ANT') as MonsterData;
      const foe = new Monster(ant, player.x + 1, player.y, session.rng);
      foe.asleep = false;
      foe.mhp = foe.mhpmax = 999;
      level.monsters = [foe];
      player.hitInc = 100;
      for (let i = 0; i < 5 && !session.dead; i++) session.attackMonster(foe);
      checker.ok(foe.mhp < 999, '以怪物形态造成伤害', `hp=${foe.mhp}`, repro('poly', seed));
      checker.absorb('变形战斗中状态自洽', checkInvariants(session), repro('poly', seed));

      // 等变形结束：清场避免战斗，推完剩余回合。
      level.monsters = [];
      player.hunger = 2000;
      const turns = player.form?.turns ?? 0;
      for (let i = 0; i <= turns && player.form; i++) session.wait();
      checker.ok(
        player.form === null,
        '变形到期恢复原形',
        `form=${player.form?.id ?? '-'}`,
        repro('poly', seed),
      );

      return {
        metrics: { turns, hp: player.hp, kills: session.kills },
        actions: 5 + turns,
        invariantChecks: 1,
      };
    }),
};

/** 许愿：用魔杖许下一件物品，并验证未知愿望可以重试。 */
const wish: Scenario = {
  name: 'wish',
  description: '用许愿魔杖兑现物品，验证匹配、重试与状态自洽',
  run: (seed) =>
    runScenario('wish', seed, (checker) => {
      const session = newSession(seed);
      const { player } = session;
      checker.attachDump(() => describeState(session));

      session.level.monsters = [];
      const wand = makeItem(objById.get('WAN_WISHING') as ObjectData, session.rng);
      addToInventory(player, wand);
      session.useItem(wand, 'zap');
      checker.ok(
        session.pendingWishes === 1,
        '许愿魔杖产生愿望',
        `pending=${session.pendingWishes}`,
        repro('wish', seed),
      );
      const bad = session.grantWish('banana sword');
      checker.ok(!bad.ok && session.pendingWishes === 1, '未知愿望不消耗，可以重试');
      const good = session.grantWish('potion of healing');
      checker.ok(
        good.ok && player.inventory.some((i) => i.proto.id === 'POT_HEALING'),
        '愿望变成物品',
        `pending=${session.pendingWishes}`,
        repro('wish', seed),
      );
      checker.absorb('许愿后状态自洽', checkInvariants(session), repro('wish', seed));

      return {
        metrics: {
          pending: session.pendingWishes,
          inventory: player.inventory.length,
          charges: wand.charges ?? 0,
        },
        actions: 3,
        invariantChecks: 1,
      };
    }),
};

/** 宠物：开局自带的宠物跟随、参战，并随玩家换层。 */
const pet: Scenario = {
  name: 'pet',
  description: '检查宠物的跟随、战斗与换层跟随',
  run: (seed) =>
    runScenario('pet', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => describeState(session));

      const pet = level.monsters.find((m) => m.tame);
      checker.ok(!!pet, '新游戏自带宠物', '开局没有宠物', repro('pet', seed));

      if (pet) {
        // 跟随：把宠物放远，推怪物回合，看它是否靠近。
        level.monsters = level.monsters.filter((m) => m.tame);
        const fov = computeFov(level, player.x, player.y, 12, { remember: false });
        const spot = [
          [5, 0],
          [-5, 0],
          [0, 5],
          [0, -5],
          [4, 0],
          [-4, 0],
          [0, 4],
          [0, -4],
        ]
          .map(([dx, dy]) => ({ x: player.x + dx, y: player.y + dy }))
          .find((p) => walkableAt(level, p.x, p.y) && fov[index(p.x, p.y)] === 1);
        if (spot) {
          pet.x = spot.x;
          pet.y = spot.y;
          const before = Math.max(Math.abs(pet.x - player.x), Math.abs(pet.y - player.y));
          for (let i = 0; i < 30; i++) session.monsterTurns();
          const after = Math.max(Math.abs(pet.x - player.x), Math.abs(pet.y - player.y));
          checker.ok(after < before, '宠物会靠近玩家', `${before} -> ${after}`, repro('pet', seed));
        }

        // 参战：放一只敌对怪物在宠物旁边。
        const ant = new Monster(
          monById.get('GIANT_ANT') as MonsterData,
          pet.x + 1,
          pet.y,
          session.rng,
        );
        ant.asleep = false;
        ant.mhp = ant.mhpmax = 60;
        level.monsters.push(ant);
        for (let i = 0; i < 30 && !ant.dead; i++) {
          pet.mv += 12;
          session.monsterAction(pet);
        }
        checker.ok(
          ant.mhp < 60 || ant.dead,
          '宠物会攻击敌对怪物',
          `hp=${ant.mhp}`,
          repro('pet', seed),
        );

        // 喂食：把宠物叫回身边，喂一份食物回血。
        const spotAdj = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]
          .map(([dx, dy]) => ({ x: player.x + dx, y: player.y + dy }))
          .find(
            (p) =>
              walkableAt(level, p.x, p.y) &&
              !level.monsters.some((m) => m !== pet && m.x === p.x && m.y === p.y),
          );
        checker.ok(!!spotAdj, '宠物身边有空位可喂食');
        if (spotAdj) {
          pet.x = spotAdj.x;
          pet.y = spotAdj.y;
          addToInventory(player, makeItem(objById.get('FOOD_RATION') as ObjectData, session.rng));
          pet.mhp = 1;
          session.feedPet();
          checker.ok(pet.mhp > 1, '喂食恢复宠物生命', `hp=${pet.mhp}`);
        }
      }

      // 换层跟随。
      session.changeDepth(2, 'down');
      checker.ok(
        !!pet && session.level.monsters.includes(pet),
        '宠物跟随换层',
        `depth=${session.depth}`,
        repro('pet', seed),
      );

      checker.absorb('宠物行动后状态自洽', checkInvariants(session), repro('pet', seed));

      return {
        metrics: {
          pet: pet?.data.id ?? '无',
          petHp: pet?.mhp ?? 0,
          monsters: session.level.monsters.length,
          depth: session.depth,
        },
        actions: 42,
        invariantChecks: 1,
      };
    }),
};

/** 特殊楼层：走访大房间、美杜莎与大墓地，检查特殊标记与内容。 */
const specialLevel: Scenario = {
  name: 'special_level',
  description: '走访大房间、美杜莎与大墓地，检查特殊标记与内容',
  run: (seed) =>
    runScenario('special_level', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => describeState(session));

      const visit = (depth: number, id: string, check: (level: LevelType) => void): void => {
        session.changeDepth(depth, 'down');
        const level = session.level;
        checker.ok(
          level.special === id,
          `第 ${depth} 层是 ${id}`,
          `special=${level.special}`,
          repro('special_level', seed),
        );
        check(level);
        checker.absorb(
          `第 ${depth} 层状态自洽`,
          checkInvariants(session),
          repro('special_level', seed),
        );
      };

      visit(5, 'big_room', (level) => {
        checker.ok(level.rooms.length === 1, '大房间只有一间', `rooms=${level.rooms.length}`);
        checker.ok(level.doors.size === 0, '大房间没有门', `doors=${level.doors.size}`);
      });
      visit(8, 'oracle', (level) => {
        checker.ok(
          level.monsters.some((m) => m.data.id === 'ORACLE'),
          '神谕在场',
        );
        const fountains = [...level.features.values()].filter((f) => f.type === 'FOUNTAIN').length;
        checker.ok(fountains >= 3, '神谕所喷泉更多', `fountains=${fountains}`);
        session.player.gold = 50;
        session.consultOracle();
        checker.ok(session.player.gold === 30, '咨询扣费', `gold=${session.player.gold}`);
        checker.ok(
          session.messages.some((m) => m.key === 'msg.oracleSays'),
          '咨询给出提示',
        );
      });
      visit(20, 'medusa', (level) => {
        checker.ok(
          level.monsters.some((m) => m.data.id === 'MEDUSA'),
          '美杜莎在场',
        );
        const statues = level.objects
          .flatMap((p) => p.items)
          .filter((i) => i.proto.id === 'STATUE').length;
        checker.ok(statues === 6, '雕像散落', `statues=${statues}`);
      });
      visit(25, 'valley', (level) => {
        const spawned = level.monsters.filter((m) => !m.tame && m.data.id !== 'SHOPKEEPER');
        checker.ok(
          spawned.every((m) => m.data.flags.includes('M2_UNDEAD')),
          '大墓地只有不死生物',
        );
      });
      visit(27, 'castle', (level) => {
        const ids = new Set(level.monsters.map((m) => m.data.id));
        checker.ok(
          ids.has('SOLDIER') && ids.has('CAPTAIN'),
          '要塞有士兵把守',
          [...ids].slice(0, 6).join('、'),
        );
        const wish = level.objects
          .flatMap((p) => p.items)
          .filter((i) => i.proto.id === 'WAN_WISHING').length;
        checker.ok(wish >= 1, '要塞有许愿魔杖', `wish=${wish}`);
      });
      visit(29, 'sanctum', (level) => {
        const spawned = level.monsters.filter((m) => !m.tame && m.data.id !== 'SHOPKEEPER');
        checker.ok(
          spawned.length > 0 && spawned.every((m) => m.data.flags.includes('M2_DEMON')),
          '圣所只有恶魔',
          `${spawned.length} 只`,
        );
        const squares = [...level.traps.values()].filter((t) => t.type === 'VIBRATING_SQUARE');
        checker.ok(
          squares.length === 1,
          '圣所有一块振动方块',
          `${squares.length}`,
          repro('special_level', seed),
        );
      });

      return {
        metrics: {
          depth: session.depth,
          special: session.level.special ?? '-',
          monsters: session.level.monsters.length,
        },
        actions: 3,
        invariantChecks: 3,
      };
    }),
};

/** 骨头文件：上一局死亡留下的遗物在下一局同层出现。 */
const bones: Scenario = {
  name: 'bones',
  description: '记录死亡现场，在下一局同层发现遗物与幽灵',
  run: (seed) =>
    runScenario('bones', seed, (checker) => {
      clearBones();
      const first = newSession(seed);
      const marker = makeItem(objById.get('LONG_SWORD') as ObjectData, first.rng);
      addToInventory(first.player, marker);
      saveBones(first);

      const second = newSession(seed + 1);
      const items = second.level.objects.flatMap((p) => p.items);
      checker.ok(
        items.some((i) => i.proto.id === 'LONG_SWORD'),
        '下一局发现遗物',
        `地面物品 ${items.length} 件`,
        repro('bones', seed),
      );
      checker.ok(
        second.level.monsters.some((m) => m.data.id === 'GHOST'),
        '幽灵看守遗物',
      );
      checker.ok(loadBones() === null, '遗物取出后骨头文件清空');
      checker.absorb('骨头楼层状态自洽', checkInvariants(second), repro('bones', seed));
      clearBones();

      return {
        metrics: {
          items: items.length,
          ghost: second.level.monsters.filter((m) => m.data.id === 'GHOST').length,
        },
        actions: 0,
        invariantChecks: 1,
      };
    }),
};

/** 分支地牢：从入口层进矿坑，走到最底层再回到主地牢。 */
const mines: Scenario = {
  name: 'mines',
  description: '从入口层进入矿坑，走到最底层再回到主地牢',
  run: (seed) =>
    runScenario('mines', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => describeState(session));

      // 先跳到入口层，再用真实移动踩上分支楼梯。
      session.changeDepth(4, 'down');
      const exit = session.level.stairs.find((st) => st.dir === 'branch');
      checker.ok(!!exit, '入口层有矿坑楼梯', '', repro('mines', seed));
      if (!exit)
        return { metrics: { gold: 0, branch: 'main', depth: 4 }, actions: 0, invariantChecks: 0 };
      const spot = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]
        .map(([dx, dy]) => ({ x: exit.x + dx, y: exit.y + dy, dx, dy }))
        .find(
          (p) =>
            walkableAt(session.level, p.x, p.y) &&
            !session.level.monsters.some((m) => m.x === p.x && m.y === p.y),
        );
      checker.ok(!!spot, '分支楼梯旁有空位');
      if (!spot)
        return { metrics: { gold: 0, branch: 'main', depth: 4 }, actions: 0, invariantChecks: 0 };
      teleportPlayer(session, spot.x, spot.y);
      session.movePlayer(-spot.dx, -spot.dy);
      checker.ok(
        session.branch === 'mines' && session.depth === 1,
        '踩楼梯进入矿坑',
        `branch=${session.branch} depth=${session.depth}`,
        repro('mines', seed),
      );
      checker.absorb('矿坑第一层状态自洽', checkInvariants(session), repro('mines', seed));

      for (let depth = 2; depth <= 8; depth++) session.changeDepth(depth, 'down');
      checker.ok(session.depth === 8 && !session.level.down, '矿坑底层没有下行楼梯');
      const gold = session.level.objects
        .flatMap((p) => p.items)
        .filter((i) => i.gold)
        .reduce((n, i) => n + i.quantity, 0);
      checker.ok(gold >= 300, '底层宝藏更厚', `gold=${gold}`);
      const mineLuck = session.level.objects.some((p) => p.items.some((i) => i.id === 'LUCKSTONE'));
      checker.ok(mineLuck, '矿坑底层有幸运石');
      // 矿镇：底层是市集，必有商店与额外喷泉。
      checker.ok(!!shopRoom(session.level), '矿镇有商店');
      const mineFountains = [...session.level.features.values()].filter(
        (f) => f.type === 'FOUNTAIN',
      ).length;
      checker.ok(mineFountains >= 3, '矿镇喷泉更多', `fountains=${mineFountains}`);
      checker.absorb('矿坑底层状态自洽', checkInvariants(session), repro('mines', seed));

      session.changeDepth(4, 'up', 'main');
      checker.ok(
        session.branch === 'main' && session.depth === 4,
        '回到主地牢入口层',
        `branch=${session.branch} depth=${session.depth}`,
      );

      return {
        metrics: { gold, branch: session.branch, depth: session.depth },
        actions: 8,
        invariantChecks: 2,
      };
    }),
};

/** 祝福与诅咒：圣水祝福行囊，诅咒卷轴失效。 */
const buc: Scenario = {
  name: 'buc',
  description: '用圣水祝福行囊，再验证诅咒物品与卷轴',
  run: (seed) =>
    runScenario('buc', seed, (checker) => {
      const session = newSession(seed);
      const { player } = session;
      checker.attachDump(() => describeState(session));

      const water = makeItem(objById.get('POT_WATER') as ObjectData, session.rng);
      water.buc = 'blessed';
      addToInventory(player, water);
      session.useItem(water);
      checker.ok(
        player.inventory.every((i) => i.buc === 'blessed'),
        '圣水祝福整包物品',
        '',
        repro('buc', seed),
      );

      // 祝福状态下读诅咒卷轴应当失效。
      const scr = makeItem(objById.get('SCR_IDENTIFY') as ObjectData, session.rng);
      scr.buc = 'cursed';
      addToInventory(player, scr);
      const r = session.useItem(scr);
      checker.ok(r.key === 'use.badScroll', '诅咒卷轴失效', `key=${r.key}`);
      checker.absorb('祝福操作后状态自洽', checkInvariants(session), repro('buc', seed));

      return {
        metrics: { items: player.inventory.length, luck: player.luck },
        actions: 2,
        invariantChecks: 1,
      };
    }),
};

/** 巫妖塔：从第 16 层进入，4 层不死主题，底层有首领与财富。 */
const vlad: Scenario = {
  name: 'vlad',
  description: '进入巫妖塔，走到最底层再回到主地牢',
  run: (seed) =>
    runScenario('vlad', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => describeState(session));

      session.changeDepth(16, 'down');
      const exit = session.level.stairs.find((st) => st.dir === 'branch' && st.branch === 'vlad');
      checker.ok(!!exit, '第 16 层有巫妖塔楼梯', '', repro('vlad', seed));
      if (!exit) return { metrics: { gold: 0, depth: 0, boss: 0 }, actions: 0, invariantChecks: 0 };

      session.changeDepth(1, 'down', 'vlad');
      checker.ok(
        session.branch === 'vlad',
        '进入巫妖塔',
        `branch=${session.branch}`,
        repro('vlad', seed),
      );
      checker.absorb('巫妖塔第一层状态自洽', checkInvariants(session), repro('vlad', seed));

      for (let depth = 2; depth <= 4; depth++) session.changeDepth(depth, 'down');
      const boss = session.level.monsters.some((m) => m.data.id === 'VAMPIRE_LEADER');
      const gold = session.level.objects
        .flatMap((p) => p.items)
        .filter((i) => i.gold)
        .reduce((n, i) => n + i.quantity, 0);
      checker.ok(boss, '巫妖塔底层有首领');
      checker.ok(gold >= 400, '巫妖塔底层有厚宝藏', `gold=${gold}`);
      checker.absorb('巫妖塔底层状态自洽', checkInvariants(session), repro('vlad', seed));

      session.changeDepth(16, 'up', 'main');
      checker.ok(
        session.branch === 'main' && session.depth === 16,
        '从巫妖塔回到主地牢',
        `branch=${session.branch} depth=${session.depth}`,
      );

      return {
        metrics: { gold, depth: session.depth, boss: boss ? 1 : 0 },
        actions: 6,
        invariantChecks: 2,
      };
    }),
};

/** 投掷：向视野内的怪物投出武器，物品落在目标格。 */
const throwing: Scenario = {
  name: 'throw',
  description: '投掷武器与射击，检查消耗与掉落',
  run: (seed) =>
    runScenario('throw', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => describeState(session));

      const data = monById.get('GIANT_ANT') as MonsterData;
      // 目标要站得住，且在玩家视野内，否则投掷会自动打空。
      const fov = computeFov(level, player.x, player.y, 12, { remember: false });
      const candidates: { x: number; y: number }[] = [];
      for (let x = 1; x < level.width - 1; x++) {
        for (let y = 1; y < level.height - 1; y++) {
          const d = Math.max(Math.abs(x - player.x), Math.abs(y - player.y));
          if (d < 1 || d > 8) continue;
          if (!walkableAt(level, x, y)) continue;
          if (fov[index(x, y)] !== 1) continue;
          candidates.push({ x, y });
        }
      }
      const targetSpot = candidates[0];
      checker.ok(!!targetSpot, '目标位置可用', '', repro('throw', seed));
      if (!targetSpot) return { metrics: { hp: 0, piles: level.objects.length } };
      const target = new Monster(data, targetSpot.x, targetSpot.y, session.rng);
      target.asleep = false;
      target.mhp = target.mhpmax = 60;
      level.monsters = [target];
      session.refreshFov();
      player.hitInc = 100;

      const sword = makeItem(objById.get('LONG_SWORD') as ObjectData, session.rng);
      addToInventory(player, sword);
      session.throwItem(sword);
      checker.ok(target.mhp < 60, '投掷造成伤害', `hp=${target.mhp}`, repro('throw', seed));
      checker.ok(
        level.objects.some((p) => p.items.includes(sword)),
        '投掷物落在地上',
      );
      checker.absorb('投掷后状态自洽', checkInvariants(session), repro('throw', seed));

      return {
        metrics: { hp: target.mhp, piles: level.objects.length },
        actions: 1,
        invariantChecks: 1,
      };
    }),
};

/** 深层随机行动：从第 25 层开始，覆盖后期怪物与特殊楼层。 */
const deep: Scenario = {
  name: 'deep',
  description: '从第 25 层开始随机行动，检查后期内容与不变量',
  run: (seed) =>
    runScenario('deep', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => `${describeState(session)}\n\n${renderMap(session)}`);

      session.changeDepth(25, 'down');
      session.player.maxHp = Math.max(session.player.maxHp, 300);
      session.player.hp = session.player.maxHp;
      const rng = testRng(seed, 'deep');
      let checks = 0;
      for (let i = 0; i < 200 && !session.dead; i++) {
        randomAction(session, rng);
        checks++;
        const problems = checkInvariants(session);
        if (problems.length) {
          checker.absorb(`第 ${i + 1} 步后状态自洽`, problems, repro('deep', seed));
          break;
        }
      }
      checker.absorb('深层结束时状态自洽', checkInvariants(session), repro('deep', seed));

      return {
        metrics: { depth: session.depth, turn: session.turn, kills: session.kills },
        actions: checks,
        invariantChecks: checks + 1,
      };
    }),
};

/**
 * 异界漫游：从土之位面开始随机行动。
 *
 * 覆盖元素位面的新机制：虚空、岩浆、深水、热浪与挖穿地板，
 * 逐步校验不变量，死亡即停（与 deep 场景同风格）。
 */
const planes: Scenario = {
  name: 'planes',
  description: '在异界随机行动，覆盖浮空、岩浆、深水与挖掘等新机制',
  run: (seed) =>
    runScenario('planes', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(
        () => `${describeState(session)}

${renderMap(session)}`,
      );
      session.player.maxHp = 300;
      session.player.hp = 300;
      session.changeDepth(1, 'down', 'planes');
      const rng = testRng(seed, 'planes');
      let checks = 0;
      for (let i = 0; i < 150 && !session.dead; i++) {
        randomAction(session, rng);
        checks++;
        const problems = checkInvariants(session);
        if (problems.length) {
          checker.absorb(`第 ${i + 1} 步后状态自洽`, problems, repro('planes', seed));
          break;
        }
      }
      checker.absorb('异界漫游结束时状态自洽', checkInvariants(session), repro('planes', seed));

      return {
        metrics: { depth: session.depth, turn: session.turn, kills: session.kills },
        actions: checks,
        invariantChecks: checks + 1,
      };
    }),
};

/** 卢迪奥斯要塞：财宝与守军，进入后拿到金币再返回主地牢。 */
const ludios: Scenario = {
  name: 'ludios',
  description: '进入卢迪奥斯要塞，检查守军与财宝，再回到主地牢',
  run: (seed) =>
    runScenario('ludios', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => describeState(session));
      const call = repro('ludios', seed);

      session.changeDepth(18, 'down');
      const exit = session.level.stairs.find((st) => st.dir === 'branch' && st.branch === 'ludios');
      checker.ok(!!exit, '第 18 层有卢迪奥斯楼梯', '', call);
      if (!exit)
        return { metrics: { gold: 0, boss: 0, guards: 0 }, actions: 0, invariantChecks: 0 };

      session.changeDepth(1, 'down', 'ludios');
      checker.ok(session.branch === 'ludios', '进入卢迪奥斯', `branch=${session.branch}`, call);
      const boss = session.level.monsters.some((m) => m.data.id === 'CROESUS');
      const guards = session.level.monsters.filter((m) =>
        ['SOLDIER', 'SERGEANT', 'LIEUTENANT'].includes(m.data.id),
      ).length;
      const gold = session.level.objects
        .flatMap((p) => p.items)
        .filter((i) => i.gold)
        .reduce((n, i) => n + i.quantity, 0);
      checker.ok(boss, '要塞有克罗伊斯', '', call);
      checker.ok(guards >= 3, '要塞有守军', `guards=${guards}`);
      checker.ok(gold >= 1000, '要塞有巨额金币', `gold=${gold}`);
      checker.absorb('要塞状态自洽', checkInvariants(session), call);

      session.changeDepth(18, 'up', 'main');
      checker.ok(
        session.branch === 'main' && session.depth === 18,
        '从要塞回到主地牢',
        `branch=${session.branch} depth=${session.depth}`,
      );

      return {
        metrics: { gold, boss: boss ? 1 : 0, guards },
        actions: 4,
        invariantChecks: 1,
      };
    }),
};

/** 容器：把物品放进箱子再取出。 */
const container: Scenario = {
  name: 'container',
  description: '把物品放进箱子再取出，检查内容与状态',
  run: (seed) =>
    runScenario('container', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => describeState(session));

      const chest = makeItem(objById.get('CHEST') as ObjectData, session.rng);
      chest.buc = 'uncursed';
      addToInventory(player, chest);
      const gem = makeItem(objById.get('DIAMOND') as ObjectData, session.rng);
      addToInventory(player, gem);

      session.putInContainer(gem, chest);
      checker.ok(
        !player.inventory.includes(gem) && chest.contents?.includes(gem) === true,
        '宝石放进箱子',
        `contents=${chest.contents?.length ?? 0}`,
        repro('container', seed),
      );
      session.openContainer(chest);
      checker.ok(player.inventory.includes(gem), '宝石取回背包');
      checker.absorb('容器操作后状态自洽', checkInvariants(session), repro('container', seed));

      // 地面容器：搜划把内容倒在地上。
      const groundChest = makeItem(objById.get('CHEST') as ObjectData, session.rng);
      groundChest.buc = 'uncursed';
      const rock = makeItem(objById.get('ROCK') as ObjectData, session.rng);
      groundChest.contents = [rock];
      const existing = level.objects.find((p) => p.x === player.x && p.y === player.y);
      if (existing) existing.items.push(groundChest);
      else level.objects.push({ x: player.x, y: player.y, items: [groundChest] });
      session.lootContainer();
      checker.ok(
        level.objects.flatMap((p) => p.items).includes(rock),
        '搜划地面容器取到内容',
        `地面堆=${level.objects.length}`,
        repro('container', seed),
      );

      return {
        metrics: { contents: chest.contents?.length ?? 0, inventory: player.inventory.length },
        actions: 3,
        invariantChecks: 1,
      };
    }),
};

/** 骑乘：骑上驯服的小马，冲锋攻击后下马。 */
const ride: Scenario = {
  name: 'ride',
  description: '骑上宠物战斗与移动，再下马',
  run: (seed) =>
    runScenario('ride', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => describeState(session));

      level.monsters = [];
      const spot = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]
        .map(([dx, dy]) => ({ x: player.x + dx, y: player.y + dy }))
        .find((p) => walkableAt(level, p.x, p.y));
      checker.ok(!!spot, '玩家身边有空位');
      if (!spot)
        return {
          metrics: { ride: 0, monsters: 0, depth: session.depth },
          actions: 0,
          invariantChecks: 0,
        };

      const pony = new Monster(monById.get('PONY') as MonsterData, spot.x, spot.y, session.rng);
      pony.tame = true;
      level.monsters.push(pony);
      checker.ok(session.canMount() === pony, '可以骑乘身边的宠物');
      session.mountPet();
      checker.ok(session.ride === pony, '骑乘生效');

      const ant = new Monster(monById.get('GIANT_ANT') as MonsterData, spot.x, spot.y, session.rng);
      ant.asleep = false;
      ant.mhp = ant.mhpmax = 999;
      level.monsters.push(ant);
      player.hitInc = 100;
      session.attackMonster(ant);
      checker.ok(
        session.messages.some((m) => m.key === 'msg.mountStrike'),
        '骑乘攻击有冲锋伤害',
        `hp=${ant.mhp}`,
        repro('ride', seed),
      );

      session.dismount();
      checker.ok(session.ride === null && level.monsters.includes(pony), '下马后坐骑回到地图');
      checker.absorb('骑乘后状态自洽', checkInvariants(session), repro('ride', seed));

      return {
        metrics: {
          ride: session.ride ? 1 : 0,
          monsters: level.monsters.length,
          depth: session.depth,
        },
        actions: 3,
        invariantChecks: 1,
      };
    }),
};

/** 武器技能：连续命中同一只怪物，熟练度成长。 */
const skill: Scenario = {
  name: 'skill',
  description: '连续命中同一只怪物，检查熟练度成长',
  run: (seed) =>
    runScenario('skill', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => describeState(session));

      const data = monById.get('GIANT_ANT') as MonsterData;
      const ant = new Monster(data, player.x + 1, player.y, session.rng);
      ant.asleep = false;
      ant.mhp = ant.mhpmax = 999;
      level.monsters = [ant];
      session.refreshFov();
      player.hitInc = 100;
      const skillId = player.weapon?.proto.skill ?? '';
      for (let i = 0; i < 10 && !session.dead; i++) session.attackMonster(ant);
      checker.ok(
        (player.skillUses[skillId] ?? 0) >= 8,
        '命中累计使用次数',
        `uses=${player.skillUses[skillId] ?? 0}`,
        repro('skill', seed),
      );
      checker.ok(
        (player.skillLevels[skillId] ?? 0) >= 1,
        '熟练度提升',
        `level=${player.skillLevels[skillId] ?? 0}`,
      );

      // 法术流派：学习法术书并连续施法；先清场，避免被反击打断。
      level.monsters = [];
      const book = makeItem(objById.get('SPE_FORCE_BOLT') as ObjectData, session.rng);
      addToInventory(player, book);
      player.knownSpells.push('SPE_FORCE_BOLT');
      const spellSkill = book.proto.spellClass ?? '';
      let successes = 0;
      for (let i = 0; i < 60 && successes < 8; i++) {
        player.maxPw = Math.max(player.maxPw, 500);
        player.pw = 500;
        const before = player.skillUses[spellSkill] ?? 0;
        session.castSpell(book);
        if ((player.skillUses[spellSkill] ?? 0) > before) successes++;
      }
      checker.ok(
        (player.skillLevels[spellSkill] ?? 0) >= 1,
        '法术流派熟练度提升',
        `level=${player.skillLevels[spellSkill] ?? 0}`,
        repro('skill', seed),
      );
      checker.absorb('技能成长后状态自洽', checkInvariants(session), repro('skill', seed));

      return {
        metrics: {
          uses: player.skillUses[skillId] ?? 0,
          level: player.skillLevels[skillId] ?? 0,
          spellLevel: player.skillLevels[spellSkill] ?? 0,
        },
        actions: 10,
        invariantChecks: 1,
      };
    }),
};

/** 尸体与内在抗性：击杀留尸，吃下抗性尸体获得抗性。 */
const corpse: Scenario = {
  name: 'corpse',
  description: '击杀怪物留下尸体，吃掉火巨人尸体获得火焰抗性',
  run: (seed) =>
    runScenario('corpse', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => describeState(session));
      const call = repro('corpse', seed);

      // 杀掉一群巨蚁，验证尸体落地与内在不变量。
      const ant = monById.get('GIANT_ANT');
      if (ant) {
        // 收集全层可站立空格，反复利用同一批位置；每次都清掉已死怪物，
        // 保证足够多次击杀，让 50% 的留尸概率必然至少命中一次。
        const free: { x: number; y: number }[] = [];
        for (let x = 1; x < session.level.width - 1; x++) {
          for (let y = 1; y < session.level.height - 1; y++) {
            if (!walkableAt(session.level, x, y)) continue;
            if (session.level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
            free.push({ x, y });
          }
        }
        let corpses = 0;
        for (let i = 0; i < 24 && corpses === 0 && free.length; i++) {
          const spot = free[i % free.length];
          const mon = new Monster(ant, spot.x, spot.y, testRng(seed, 'corpse-ant', i));
          session.level.monsters.push(mon);
          session.slayMonster(mon, true);
          session.level.monsters = session.level.monsters.filter((m) => !m.dead);
          corpses = session.level.objects.flatMap((p) => p.items).filter((i2) => i2.corpse).length;
        }
        checker.ok(corpses > 0, '击杀留下尸体', `尸体=${corpses}`, call);
        checker.absorb('留尸后状态自洽', checkInvariants(session), call);
      }

      // 吃火巨人尸体，直到获得火焰抗性；概率由怪物等级决定，最多试 40 次。
      const proto = objById.get('CORPSE');
      if (proto) {
        for (let i = 0; i < 40 && !session.player.intrinsics.includes('fire'); i++) {
          const body = makeItem(proto, session.rng);
          body.corpse = 'FIRE_GIANT';
          addToInventory(session.player, body);
          session.useItem(body);
        }
        checker.ok(
          session.player.intrinsics.includes('fire'),
          '吃火巨人尸体获得火焰抗性',
          `内在抗性=${session.player.intrinsics.join('/') || '无'}`,
          call,
        );
        checker.absorb('进食后状态自洽', checkInvariants(session), call);
      }

      // 罐头：确保手中有武器即可开罐。
      const tinProto = objById.get('TIN');
      if (tinProto) {
        if (!session.player.weapon) {
          const swordProto = objById.get('LONG_SWORD');
          if (swordProto) {
            const sword = makeItem(swordProto, session.rng);
            addToInventory(session.player, sword);
            session.player.equipment.weapon = sword;
          }
        }
        const tin = makeItem(tinProto, session.rng);
        addToInventory(session.player, tin);
        const hungerBefore = session.player.hunger;
        session.useItem(tin);
        checker.ok(!session.player.inventory.includes(tin), '开罐消耗罐头');
        checker.ok(tin.tin !== undefined, '罐头记录了内容怪物', tin.tin ?? '-', call);
        checker.ok(session.player.hunger >= hungerBefore, '开罐不减少饱食度');
        checker.absorb('开罐后状态自洽', checkInvariants(session), call);
      }

      return {
        metrics: {
          intrinsics: session.player.intrinsics.join('/') || '-',
          hunger: session.player.hunger,
        },
        actions: 3,
        invariantChecks: 3,
      };
    }),
};

/** 献祭：在祭坛上献祭尸体换取神恩，异教祭坛可能归附。 */
const sacrifice: Scenario = {
  name: 'sacrifice',
  description: '在祭坛上献祭尸体，检查同阵营神恩与异教归附',
  run: (seed) =>
    runScenario('sacrifice', seed, (checker) => {
      // 扫层找一座祭坛；少数种子 30 层内没有祭坛，换盐种子继续找。
      let session = newSession(seed);
      const findAltar = (s: ReturnType<typeof newSession>): { depth: number; i: number } | null => {
        for (let depth = 2; depth < MAX_DEPTH; depth++) {
          for (const [i, feature] of s.getLevel(depth).features) {
            if (feature.type === 'ALTAR') return { depth, i };
          }
        }
        return null;
      };
      let altar = findAltar(session);
      for (let salt = 1; salt <= 8 && !altar; salt++) {
        session = newSession((seed + salt * 0x9e3779b1) >>> 0, { character: session.character });
        altar = findAltar(session);
      }
      checker.attachDump(() => describeState(session));
      const call = repro('sacrifice', seed);
      checker.ok(!!altar, '样本里存在祭坛', '', call);
      if (!altar)
        return {
          metrics: { altar: '-', luck: 0, converted: false },
          actions: 0,
          invariantChecks: 0,
        };

      session.changeDepth(altar.depth, 'down');
      session.level.monsters = [];
      const feature = session.level.features.get(altar.i);
      if (feature) feature.align = session.player.align;
      session.player.x = altar.i % COLNO;
      session.player.y = Math.floor(altar.i / COLNO);
      session.player.hunger = 2000;
      session.refreshFov();

      const proto = objById.get('CORPSE');
      checker.ok(!!proto, '尸体原型存在', '', call);
      if (!proto)
        return {
          metrics: { altar: `${altar.depth}:${altar.i}`, luck: 0, converted: false },
          actions: 1,
          invariantChecks: 0,
        };

      const luckBefore = session.player.luck;
      const recordBefore = session.player.alignRecord;
      for (let n = 0; n < 3; n++) {
        const body = makeItem(proto, session.rng);
        body.corpse = 'FIRE_GIANT';
        addToInventory(session.player, body);
      }
      session.offerCorpse();
      checker.ok(
        session.player.luck > luckBefore,
        '同阵营献祭提升幸运',
        `${luckBefore} -> ${session.player.luck}`,
        call,
      );
      checker.ok(
        session.player.alignRecord > recordBefore,
        '同阵营献祭提升阵营记录',
        `${recordBefore} -> ${session.player.alignRecord}`,
      );

      // 把祭坛改成异教，多次献祭直到归附。
      if (feature) feature.align = session.player.align === 'lawful' ? 'chaotic' : 'lawful';
      let converted = false;
      for (let n = 0; n < 30 && !converted; n++) {
        const body = makeItem(proto, session.rng);
        body.corpse = 'FIRE_GIANT';
        addToInventory(session.player, body);
        session.offerCorpse();
        if (feature?.align === session.player.align) converted = true;
      }
      checker.ok(converted, '异教祭坛最终归附', '', call);

      // 把水放在归属自己的祭坛上祈祷，水化成圣水。
      const waterProto = objById.get('POT_WATER');
      if (waterProto && feature) {
        feature.align = session.player.align;
        session.player.alignRecord = 0;
        const water = makeItem(waterProto, session.rng);
        session.level.objects.push({
          x: session.player.x,
          y: session.player.y,
          items: [water],
        });
        session.pray();
        checker.ok(water.buc === 'blessed', '同阵营祈祷把水变成圣水', water.buc, call);
        checker.absorb('圣水转化后状态自洽', checkInvariants(session), call);
      }
      checker.absorb('献祭后状态自洽', checkInvariants(session), call);

      return {
        metrics: {
          altar: `${altar.depth}:${altar.i}`,
          luck: session.player.luck,
          converted,
        },
        actions: 2,
        invariantChecks: 1,
      };
    }),
};

/** 职业神器：任务目标层的仇敌守着本职业神器。 */
const artifact: Scenario = {
  name: 'artifact',
  description: '深入职业任务，在目标层拿到本职业神器，检查名字与附魔',
  run: (seed) =>
    runScenario('artifact', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => describeState(session));

      session.changeDepth(1, 'down', 'quest');
      session.changeDepth(5, 'down', 'quest');
      checker.ok(
        session.level.special === 'quest_goal',
        '任务目标层标记为 quest_goal',
        session.level.special ?? '-',
        repro('artifact', seed),
      );
      const found = session.level.objects.flatMap((p) => p.items).find((i) => i.artifact);
      checker.ok(!!found, '任务目标层放着职业神器', '', repro('artifact', seed));
      checker.ok(found?.known === true, '神器已鉴定');
      checker.absorb('神器楼层状态自洽', checkInvariants(session), repro('artifact', seed));

      return {
        metrics: { artifact: found?.artifact ?? '-', enchant: found?.enchant ?? 0 },
        actions: 2,
        invariantChecks: 1,
      };
    }),
};

/** 职业任务：领袖解锁楼梯，仇敌守着神器。 */
const quest: Scenario = {
  name: 'quest',
  description: '进入职业任务总部，与领袖交谈解锁楼梯，到目标层找到仇敌与神器',
  run: (seed) =>
    runScenario('quest', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => describeState(session));
      const call = repro('quest', seed);

      session.changeDepth(1, 'down', 'quest');
      const quest = session.character.role.quest;
      checker.ok(
        session.level.special === 'quest_home',
        '任务首层标记为总部',
        session.level.special ?? '-',
        call,
      );
      session.changeDepth(3, 'down', 'quest');
      checker.ok(
        session.level.special === 'quest_locate',
        '任务中层标记为搜索层',
        session.level.special ?? '-',
        call,
      );
      session.changeDepth(1, 'up', 'quest');
      const leader = session.level.monsters.find((m) => m.data.id === quest.leader);
      checker.ok(!!leader, `任务总部有领袖 ${quest.leader}`, '', call);
      checker.absorb('任务总部状态自洽', checkInvariants(session), call);
      if (!leader)
        return {
          metrics: { leader: 0 } as Record<string, string | number | boolean>,
          actions: 1,
          invariantChecks: 1,
        };

      const freeSpot = (x: number, y: number): boolean =>
        walkableAt(session.level, x, y) &&
        !session.level.monsters.some((m) => !m.dead && m.x === x && m.y === y) &&
        !(session.player.x === x && session.player.y === y);

      // 未获许可时，踩下行楼梯会被挡回来。
      const down = session.level.down;
      if (down) {
        const near = [
          [down.x - 1, down.y],
          [down.x + 1, down.y],
          [down.x, down.y - 1],
          [down.x, down.y + 1],
        ].find(([x, y]) => freeSpot(x, y));
        if (near) {
          teleportPlayer(session, near[0], near[1]);
          const blocked = session.movePlayer(down.x - near[0], down.y - near[1]);
          checker.ok(blocked.result === 'blocked', '未获许可时楼梯不可用', blocked.result, call);
          checker.ok(
            session.branch === 'quest' && session.depth === 1 && !session.questUnlocked,
            '被挡回后仍在任务总部',
          );
        }
      }

      // 走到领袖身边交谈。
      const beside = [
        [leader.x - 1, leader.y],
        [leader.x + 1, leader.y],
        [leader.x, leader.y - 1],
        [leader.x, leader.y + 1],
      ].find(([x, y]) => freeSpot(x, y));
      checker.ok(!!beside, '领袖身边有空位可供交谈', '', call);
      if (beside) {
        teleportPlayer(session, beside[0], beside[1]);
        const turnBefore = session.turn;
        session.talkToLeader();
        checker.ok(session.questUnlocked, '交谈后任务楼梯解锁');
        checker.ok(
          session.turn === turnBefore,
          '交谈不消耗回合',
          String(session.turn - turnBefore),
        );
      }

      // 解锁后可以下行，深处应有仇敌与神器。
      const level2 = session.changeDepth(2, 'down', 'quest');
      checker.ok(level2.result === 'descended', '解锁后可以下到任务第二层');
      session.changeDepth(5, 'down', 'quest');
      const nemesis = session.level.monsters.find((m) => m.data.id === quest.nemesis);
      const artifactItem = session.level.objects.flatMap((p) => p.items).find((i) => i.artifact);
      checker.ok(!!nemesis, `目标层有仇敌 ${quest.nemesis}`, '', call);
      checker.ok(!!artifactItem, '目标层有职业神器', '', call);
      checker.absorb('任务目标层状态自洽', checkInvariants(session), call);

      return {
        metrics: {
          leader: leader.data.id,
          nemesis: nemesis?.data.id ?? '-',
          artifact: artifactItem?.artifact ?? '-',
          unlocked: session.questUnlocked,
        },
        actions: 3,
        invariantChecks: 2,
      };
    }),
};

/** 远程吐息：红龙在远处喷火。 */
const breath: Scenario = {
  name: 'breath',
  description: '红龙在远处吐息，检查远程攻击与状态自洽',
  run: (seed) =>
    runScenario('breath', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => describeState(session));

      player.maxHp = 300;
      player.hp = 300;
      // 在 2-6 格内找一块可站立、且能看见玩家的格子；
      // 2-6 格是远程吐息的有效范围，视野不可缺失否则永远不触发。
      // 本层找不到时换下一层继续找。
      const findBreathSpot = (): { x: number; y: number } | null => {
        const current = session.level;
        for (let x = 1; x < current.width - 1; x++) {
          for (let y = 1; y < current.height - 1; y++) {
            const d = Math.max(Math.abs(x - player.x), Math.abs(y - player.y));
            if (d < 2 || d > 6) continue;
            if (!walkableAt(current, x, y)) continue;
            const fov = computeFov(current, x, y, 12, { remember: false });
            if (fov[index(player.x, player.y)] !== 1) continue;
            return { x, y };
          }
        }
        return null;
      };
      let spot = findBreathSpot();
      const maxDepth = Math.min(session.depth + 5, MAX_DEPTH);
      for (let depth = session.depth + 1; depth <= maxDepth && !spot; depth++) {
        session.changeDepth(depth, 'down');
        session.level.monsters = [];
        session.refreshFov();
        spot = findBreathSpot();
      }
      checker.ok(!!spot, '龙的位置可用');
      if (!spot) return { metrics: { hp: player.hp, dragonHp: 0 }, actions: 0, invariantChecks: 0 };

      const dragon = new Monster(
        monById.get('RED_DRAGON') as MonsterData,
        spot.x,
        spot.y,
        session.rng,
      );
      dragon.asleep = false;
      level.monsters = [dragon];
      session.refreshFov();

      let hurt = false;
      for (let i = 0; i < 60 && !hurt; i++) {
        const hp = player.hp;
        session.monsterAction(dragon);
        if (player.hp < hp) hurt = true;
        else {
          dragon.x = spot.x;
          dragon.y = spot.y;
        }
      }
      checker.ok(hurt, '红龙在远处吐息', `hp=${player.hp}`, repro('breath', seed));
      checker.absorb('吐息后状态自洽', checkInvariants(session), repro('breath', seed));

      return {
        metrics: { hp: player.hp, dragonHp: dragon.mhp },
        actions: 60,
        invariantChecks: 1,
      };
    }),
};

/** 呼救：醒来的怪物会唤醒附近同伴。 */
const rally: Scenario = {
  name: 'rally',
  description: '怪物醒来后唤醒附近同伴',
  run: (seed) =>
    runScenario('rally', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => describeState(session));

      const spots: { x: number; y: number }[] = [];
      for (let dx = -4; dx <= 4; dx++) {
        for (let dy = -4; dy <= 4; dy++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (d < 1 || d > 4) continue;
          const x = player.x + dx;
          const y = player.y + dy;
          if (!walkableAt(level, x, y)) continue;
          // 需要在双方的视野内，沉睡的怪物才有机会醒来并呼救。
          const fov = computeFov(level, x, y, 12, { remember: false });
          if (fov[index(player.x, player.y)] !== 1) continue;
          spots.push({ x, y });
        }
      }
      checker.ok(spots.length >= 2, '玩家周围有空地');
      if (spots.length < 2) return { metrics: { woke: 0 }, actions: 0, invariantChecks: 0 };

      const data = monById.get('GIANT_ANT') as MonsterData;
      const sleeper = new Monster(data, spots[0].x, spots[0].y, session.rng);
      sleeper.asleep = true;
      // 同伴要在呼救半径（6 格）内，否则唤醒测试必然失败。
      const buddySpot =
        spots
          .slice(1)
          .find((p) => Math.max(Math.abs(p.x - spots[0].x), Math.abs(p.y - spots[0].y)) <= 6) ??
        spots[1];
      const buddy = new Monster(data, buddySpot.x, buddySpot.y, session.rng);
      buddy.asleep = true;
      level.monsters = [sleeper, buddy];
      session.refreshFov();

      for (let i = 0; i < 80 && sleeper.asleep; i++) session.monsterAction(sleeper);
      const woke = sleeper.asleep || buddy.asleep ? 0 : 1;
      checker.ok(
        woke === 1,
        '醒来的怪物唤醒同伴',
        `sleeper=${sleeper.asleep} buddy=${buddy.asleep}`,
        repro('rally', seed),
      );
      checker.absorb('呼救后状态自洽', checkInvariants(session), repro('rally', seed));

      return { metrics: { woke }, actions: 80, invariantChecks: 1 };
    }),
};

/** 重伤逃跑：低血量怪物转身逃走。 */
const flee: Scenario = {
  name: 'flee',
  description: '重伤的怪物转身逃跑',
  run: (seed) =>
    runScenario('flee', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => describeState(session));

      player.maxHp = 200;
      player.hp = 200;
      const spot = [
        [2, 0],
        [-2, 0],
        [0, 2],
        [0, -2],
      ]
        .map(([dx, dy]) => ({ x: player.x + dx, y: player.y + dy }))
        .find((p) => walkableAt(level, p.x, p.y));
      checker.ok(!!spot, '玩家周围有空地');
      if (!spot) return { metrics: { fled: 0 }, actions: 0, invariantChecks: 0 };

      const ant = new Monster(monById.get('GIANT_ANT') as MonsterData, spot.x, spot.y, session.rng);
      ant.asleep = false;
      ant.mhp = 1;
      ant.mhpmax = 40;
      level.monsters = [ant];
      for (let i = 0; i < 40 && !ant.fleeing; i++) session.monsterAction(ant);
      checker.ok(
        ant.fleeing,
        '重伤的怪物会逃跑',
        `hp=${ant.mhp}/${ant.mhpmax}`,
        repro('flee', seed),
      );
      checker.absorb('逃跑后状态自洽', checkInvariants(session), repro('flee', seed));

      return { metrics: { fled: ant.fleeing ? 1 : 0 }, actions: 40, invariantChecks: 1 };
    }),
};

/** 地形设施：把喷泉喝干、挖开坟墓、坐一次王座、踹坏水槽。 */
const feature: Scenario = {
  name: 'feature',
  description: '与喷泉、水槽、坟墓、王座互动，检查效果与设施状态',
  run: (seed) =>
    runScenario('feature', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => describeState(session));

      // 逐层扫描，记录每类设施第一次出现的位置；某些种子 28 层内可能缺少
      // 某一类设施，这时换盐过的种子继续找，保证四类都被覆盖。
      const found: {
        kind: string;
        action: FeatureAction;
        depth: number;
        tile: number;
        session: ReturnType<typeof newSession>;
      }[] = [];
      const collect = (target: ReturnType<typeof newSession>): void => {
        for (let depth = 2; depth < MAX_DEPTH; depth++) {
          const level = target.getLevel(depth);
          for (const [tileKey, def] of Object.entries(FEATURE_ACTIONS)) {
            if (!def || found.some((f) => f.kind === def.kind)) continue;
            const tileType = Number(tileKey);
            for (const [i] of level.features) {
              if (level.tiles[i] === tileType) {
                found.push({ kind: def.kind, action: def.action, depth, tile: i, session: target });
                break;
              }
            }
          }
        }
      };
      collect(session);
      for (let salt = 1; salt <= 8 && found.length < 4; salt++) {
        collect(newSession((seed + salt * 0x9e3779b1) >>> 0, { character: session.character }));
      }
      checker.ok(
        found.length === 4,
        '四种设施各找到一处',
        `找到 ${found.length} 种`,
        repro('feature', seed),
      );

      let effects = 0;
      let terminal = 0;
      for (const target of found) {
        const targetSession = target.session;
        targetSession.changeDepth(target.depth, 'down');
        // 隔离测试：提升生命并清理怪物，避免喷泉恶魔与坟墓亡者干扰后续步骤。
        targetSession.level.monsters = [];
        targetSession.player.maxHp = Math.max(targetSession.player.maxHp, 500);
        targetSession.player.hp = targetSession.player.maxHp;
        targetSession.player.hunger = 2000;
        targetSession.player.petrifying = 0;
        targetSession.player.sick = 0;
        const x = target.tile % COLNO;
        const y = Math.floor(target.tile / COLNO);
        teleportPlayer(targetSession, x, y);
        for (let n = 0; n < 300; n++) {
          const result = targetSession.useFeature(target.action);
          if (result.key) effects++;
          // 现身的怪物不参与后续回合，伤害与异常也在每步后复原。
          targetSession.level.monsters = [];
          targetSession.player.hp = targetSession.player.maxHp;
          targetSession.player.petrifying = 0;
          targetSession.player.sick = 0;
          const state = targetSession.level.features.get(target.tile);
          if (!state || state.depleted || state.used) break;
        }
        const state = targetSession.level.features.get(target.tile);
        if (!state || state.depleted || state.used) terminal++;
        checker.ok(
          !state || !!state.depleted || !!state.used,
          `${target.kind} 达到失效或使用状态`,
          `状态=${JSON.stringify(state)}`,
          repro('feature', seed),
        );
        checker.ok(
          walkableAt(targetSession.level, x, y),
          `${target.kind} 所在格仍可通行`,
          `瓦片=${targetSession.level.tiles[target.tile]}`,
        );
        checker.absorb(
          `${target.kind} 互动后状态自洽`,
          checkInvariants(targetSession),
          repro('feature', seed),
        );
      }

      return {
        metrics: { kinds: found.length, effects, terminal, depth: session.depth },
        actions: 4 + effects,
        invariantChecks: found.length,
      };
    }),
};

/** 饥饿：把饱食度压到阈值附近，验证提示与昏倒伤害。 */
const hunger: Scenario = {
  name: 'hunger',
  description: '推进饱食度阈值，检查提示消息与昏倒伤害',
  run: (seed) =>
    runScenario('hunger', seed, (checker) => {
      const session = newSession(seed);
      const { player } = session;
      checker.attachDump(() => describeState(session));
      player.maxHp = 60;
      player.hp = 60;

      const messagesSince = (from: number): string[] =>
        session.messages.slice(from).map((m) => m.key);

      let mark = session.messages.length;
      player.hunger = 151;
      for (let i = 0; i < 4 && player.hunger > 150; i++) session.wait();
      checker.ok(
        messagesSince(mark).includes('use.hunger'),
        '触发饥饿提示',
        messagesSince(mark).join(','),
        repro('hunger', seed),
      );

      mark = session.messages.length;
      player.hunger = 41;
      for (let i = 0; i < 4 && player.hunger > 40; i++) session.wait();
      checker.ok(
        messagesSince(mark).includes('use.weak'),
        '触发虚弱提示',
        messagesSince(mark).join(','),
        repro('hunger', seed),
      );

      mark = session.messages.length;
      player.hunger = 1;
      const hpBefore = player.hp;
      // 昏倒判定发生在回合数为 20 的倍数时，因此给足回合。
      for (let i = 0; i < 80; i++) {
        session.wait();
        if (session.messages.slice(mark).some((m) => m.key === 'use.fainting')) break;
      }
      const keys = messagesSince(mark);
      checker.ok(
        keys.includes('use.fainting') || player.hp < hpBefore,
        '饥饿会导致昏倒或掉血',
        `消息=${keys.join(',')} 生命=${hpBefore}->${player.hp}`,
        repro('hunger', seed),
      );

      checker.absorb('饥饿推进后状态自洽', checkInvariants(session), repro('hunger', seed));

      return {
        metrics: {
          hunger: player.hunger,
          hpLost: hpBefore - player.hp,
          turn: session.turn,
        },
        actions: session.turn,
        invariantChecks: 1,
      };
    }),
};

/** 存档：序列化与恢复后状态必须一致。 */
const save: Scenario = {
  name: 'save',
  description: '存档往返，比较状态、背包、装备与迷雾',
  run: (seed) =>
    runScenario('save', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => describeState(session));
      const rng = testRng(seed, 'save');
      for (let i = 0; i < 30; i++) randomAction(session, rng);

      const payload = JSON.parse(JSON.stringify(serializeSession(session)));
      const restored = restoreSession(payload);

      checker.ok(
        JSON.stringify(session.status) === JSON.stringify(restored.status),
        '状态快照一致',
        `${JSON.stringify(session.status)} != ${JSON.stringify(restored.status)}`,
        repro('save', seed),
      );
      checker.ok(
        session.player.inventory.length === restored.player.inventory.length,
        '背包数量一致',
        `${session.player.inventory.length} != ${restored.player.inventory.length}`,
      );
      checker.ok(
        Object.keys(session.player.equipment).sort().join() ===
          Object.keys(restored.player.equipment).sort().join(),
        '装备槽一致',
      );
      checker.ok(
        seenCount(session.level) === seenCount(restored.level),
        '迷雾数量一致',
        `${seenCount(session.level)} != ${seenCount(restored.level)}`,
      );
      checker.absorb('恢复后状态自洽', checkInvariants(restored), repro('save', seed));

      return {
        metrics: {
          turn: session.turn,
          depth: session.depth,
          levels: session.levels.size,
          bytes: JSON.stringify(payload).length,
        },
        actions: session.turn,
        invariantChecks: 1,
      };
    }),
};

/** 终局：抵达底层，取得尤恩多护身符。 */
const victory: Scenario = {
  name: 'victory',
  description: '下潜至底层并取得护身符，检查通关标记',
  run: (seed) =>
    runScenario('victory', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => `${describeState(session)}\n\n${renderMap(session)}`);
      session.player.maxHp = 200;
      session.player.hp = 200;
      session.changeDepth(MAX_DEPTH, 'down');

      const amulet = session.level.objects.find((p) =>
        p.items.some((i) => i.proto.id === 'AMULET_OF_YENDOR'),
      );
      checker.ok(!!amulet, `第 ${MAX_DEPTH} 层存在护身符`, '未找到护身符', repro('victory', seed));
      if (!amulet) return {};

      teleportPlayer(session, amulet.x, amulet.y);
      session.pickupAction();

      checker.ok(
        !session.victory && session.player.inventory.some((i) => i.proto.id === 'AMULET_OF_YENDOR'),
        '拾取护身符后尚未通关，需带回地面',
        `victory=${session.victory}`,
      );
      checker.ok(
        session.messages.some((m) => m.key === 'msg.amuletTaken'),
        '拾取时提示需要回到地面',
      );

      // 一路爬回第 1 层。
      for (let depth = MAX_DEPTH - 1; depth >= 1; depth--) session.changeDepth(depth, 'up');
      const hunts = session.messages.filter((m) => m.key === 'msg.wizardComes').length;
      checker.ok(hunts >= 2, '夺宝后巫师一路追击', `come=${hunts}`, repro('victory', seed));
      checker.ok(session.victory, '带着护身符回到第 1 层即通关', `victory=${session.victory}`);
      checker.ok(
        session.messages.some((m) => m.key === 'msg.victory'),
        '记录通关消息',
        session.messages
          .slice(-3)
          .map((m) => m.key)
          .join(','),
      );
      checker.absorb('通关后状态自洽', checkInvariants(session), repro('victory', seed));

      return {
        metrics: { depth: session.depth, turn: session.turn, victory: session.victory, hunts },
        actions: MAX_DEPTH,
        invariantChecks: 1,
      };
    }),
};

/** 死亡：构造必死局面，验证死亡结算与状态冻结。 */
const death: Scenario = {
  name: 'death',
  description: '构造必死局面，检查死亡消息与后续行动被冻结',
  run: (seed) =>
    runScenario('death', seed, (checker) => {
      const session = newSession(seed);
      const { player, level } = session;
      checker.attachDump(() => `${describeState(session)}\n\n${renderMap(session)}`);
      player.hp = 1;
      player.maxHp = 1;
      const foe = level.monsters[0];
      if (!foe) {
        checker.fail('关卡内存在怪物', '第 1 层没有生成怪物', repro('death', seed));
        return {};
      }
      foe.asleep = false;
      foe.mhp = 999;
      foe.mhpmax = 999;
      // 只留一个必杀物理攻击，避免怪物只会麻痹/催眠导致玩家死不了。
      foe.data = { ...foe.data, attacks: [{ at: 'AT_CLAW', ad: 'AD_PHYS', dice: [99, 99] }] };
      standBeside(session, foe);

      for (let i = 0; i < 200 && !session.dead; i++) session.wait();

      checker.ok(session.dead, '玩家最终死亡', `hp=${player.hp}`, repro('death', seed));
      checker.ok(player.hp === 0, '死亡时生命归零', `hp=${player.hp}`);
      checker.ok(
        session.messages.some((m) => m.key === 'msg.youDie'),
        '记录死亡消息',
        session.messages
          .slice(-2)
          .map((m) => m.key)
          .join(','),
      );

      const turnAtDeath = session.turn;
      const result = session.movePlayer(1, 0);
      checker.ok(result.result === 'dead', '死亡后移动被拒绝', `result=${result.result}`);
      checker.ok(
        session.turn === turnAtDeath,
        '死亡后回合不再推进',
        `${turnAtDeath} -> ${session.turn}`,
      );

      return {
        metrics: { turnAtDeath, depth: session.depth, kills: session.kills },
        actions: turnAtDeath,
        invariantChecks: 1,
      };
    }),
};

/** 视野：验证房间照明规则与墙体遮挡。 */
const fov: Scenario = {
  name: 'fov',
  description: '检查照明房间整间可见，且视野写入迷雾',
  run: (seed) =>
    runScenario('fov', seed, (checker) => {
      const session = newSession(seed);
      const level = session.level;
      checker.attachDump(() => renderMap(session));
      const room = level.rooms.find((r) => r.lit) ?? level.rooms[0];
      if (!room) {
        checker.fail('关卡内存在房间', '没有房间可用于视野检查', repro('fov', seed));
        return {};
      }
      teleportPlayer(
        session,
        Math.floor((room.lx + room.hx) / 2),
        Math.floor((room.ly + room.hy) / 2),
      );
      // 视野场景不验证实体，清场避免和宠物/怪物重叠。
      level.monsters = [];
      const visible = computeFov(level, session.player.x, session.player.y);
      session.visible = visible;

      let unseen = 0;
      for (let x = room.lx; x <= room.hx; x++) {
        for (let y = room.ly; y <= room.hy; y++) {
          if (!visible[index(x, y)]) unseen++;
        }
      }
      checker.ok(unseen === 0, '照明房间内全部可见', `未可见=${unseen}`, repro('fov', seed));

      // 墙体本身可见，但墙后的石头不可见。
      const wallTile = level.tiles[index(room.lx - 1, room.ly)];
      if (wallTile === T.VWALL || wallTile === T.HWALL) {
        checker.ok(visible[index(room.lx - 1, room.ly)] === 1, '与房间相邻的墙体可见');
      }

      let visibleCount = 0;
      for (let i = 0; i < visible.length; i++) visibleCount += visible[i];
      checker.ok(visibleCount < level.tiles.length, '视野不是整张地图', `可见=${visibleCount}`);
      checker.absorb('视野计算后状态自洽', checkInvariants(session), repro('fov', seed));

      return {
        metrics: {
          visibleTiles: visibleCount,
          roomTiles: (room.hx - room.lx + 1) * (room.hy - room.ly + 1),
        },
        actions: 0,
        invariantChecks: 1,
      };
    }),
};

/** 全部场景，按字母序执行以便输出稳定。 */
/** 推箱分支：从神谕所进入，推巨石、上顶层拿奖励，再从入口回主地牢。 */
const sokoban: Scenario = {
  name: 'sokoban',
  description: '进入推箱分支，推动巨石并取走顶层奖励',
  run: (seed) =>
    runScenario('sokoban', seed, (checker) => {
      const session = newSession(seed);
      checker.attachDump(() => describeState(session));
      const empty = { boulders: 0, pushed: 0, prize: 0 };

      // 神谕所（第 8 层）有通往推箱的分支楼梯。
      session.changeDepth(8, 'down');
      const exit = session.level.stairs.find(
        (st) => st.dir === 'branch' && st.branch === 'sokoban',
      );
      checker.ok(!!exit, '神谕所有推箱楼梯', '', repro('sokoban', seed));
      if (!exit) return { metrics: empty, actions: 0, invariantChecks: 0 };
      const spot = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]
        .map(([dx, dy]) => ({ x: exit.x + dx, y: exit.y + dy, dx, dy }))
        .find(
          (p) =>
            walkableAt(session.level, p.x, p.y) &&
            !session.level.monsters.some((m) => m.x === p.x && m.y === p.y),
        );
      checker.ok(!!spot, '推箱楼梯旁有空位');
      if (!spot) return { metrics: empty, actions: 0, invariantChecks: 0 };
      teleportPlayer(session, spot.x, spot.y);
      session.movePlayer(-spot.dx, -spot.dy);
      checker.ok(
        session.branch === 'sokoban' && session.depth === 4,
        '踩楼梯进入推箱底层',
        `branch=${session.branch} depth=${session.depth}`,
        repro('sokoban', seed),
      );
      checker.absorb('推箱底层状态自洽', checkInvariants(session), repro('sokoban', seed));

      const boulders = () =>
        session.level.objects.filter((p) => p.items.some((i) => i.id === 'BOULDER'));
      const total = boulders().length;
      checker.ok(total >= 8, '底层有多块巨石', `boulders=${total}`);
      checker.ok(
        session.level.traps.size >= 8,
        '底层有坑洞陷阱',
        `traps=${session.level.traps.size}`,
      );

      // 找一块能推的巨石：玩家站反方向，三格都无陷阱与障碍。
      let pushed = 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const free = (x: number, y: number) =>
          walkableAt(session.level, x, y) &&
          !session.level.doors.has(index(x, y)) &&
          !session.level.traps.has(index(x, y));
        const target = boulders().find((b) => {
          const back = { x: b.x - dx, y: b.y - dy };
          const ahead = { x: b.x + dx, y: b.y + dy };
          if (!free(back.x, back.y) || !free(ahead.x, ahead.y)) return false;
          if (
            session.level.monsters.some(
              (m) =>
                !m.dead &&
                ((m.x === back.x && m.y === back.y) || (m.x === ahead.x && m.y === ahead.y)),
            )
          )
            return false;
          return !boulders().some((o) => o.x === ahead.x && o.y === ahead.y);
        });
        if (!target) continue;
        teleportPlayer(session, target.x - dx, target.y - dy);
        // 推动会改写巨石堆的坐标，先把出发点存下来。
        const from = { x: target.x, y: target.y };
        const dest = { x: from.x + dx, y: from.y + dy };
        session.movePlayer(dx, dy);
        const moved = boulders().some((b) => b.x === dest.x && b.y === dest.y);
        if (moved && session.player.x === from.x && session.player.y === from.y) pushed++;
        break;
      }
      checker.ok(pushed > 0, '能把巨石推到后一格', `pushed=${pushed}`);
      checker.absorb('推箱推石后状态自洽', checkInvariants(session), repro('sokoban', seed));

      // 上层三层：顶层有奖励与两只巨型拟形怪。
      session.changeDepth(3, 'up');
      session.changeDepth(2, 'up');
      session.changeDepth(1, 'up');
      checker.ok(session.branch === 'sokoban' && session.depth === 1, '爬到推箱顶层');
      const prize = session.level.objects
        .flatMap((p) => p.items)
        .find((i) => i.id === 'BAG_OF_HOLDING' || i.id === 'AMULET_OF_REFLECTION');
      checker.ok(!!prize, '顶层有奖励', `prize=${prize?.id ?? '无'}`);
      const mimics = session.level.monsters.filter((m) => !m.dead && m.data.id === 'GIANT_MIMIC');
      checker.ok(mimics.length >= 2, '顶层有两只巨型拟形怪', `mimics=${mimics.length}`);
      const disguised = mimics.filter((m) => m.disguise === 'BOULDER').length;
      checker.ok(disguised === mimics.length, '拟形怪全部伪装成巨石', `n=${disguised}`);
      checker.ok(session.teleportBlocked, '推箱分支禁止传送');
      if (mimics.length) {
        session.attackMonster(mimics[0]);
        checker.ok(!mimics[0].disguise, '攻击后拟形怪现出原形');
      }
      checker.absorb('推箱顶层状态自洽', checkInvariants(session), repro('sokoban', seed));

      // 回到入口层，再踩分支楼梯回主地牢。
      session.changeDepth(4, 'down');
      const back = session.level.stairs.find((st) => st.dir === 'branch');
      checker.ok(!!back, '入口层有回主地牢的楼梯');
      if (back) {
        const beside = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]
          .map(([dx, dy]) => ({ x: back.x + dx, y: back.y + dy, dx, dy }))
          .find(
            (p) =>
              walkableAt(session.level, p.x, p.y) &&
              !session.level.monsters.some((m) => m.x === p.x && m.y === p.y),
          );
        if (beside) {
          teleportPlayer(session, beside.x, beside.y);
          session.movePlayer(-beside.dx, -beside.dy);
          checker.ok(
            session.branch === 'main' && session.depth === 8,
            '从推箱回到神谕所',
            `branch=${session.branch} depth=${session.depth}`,
          );
        }
      }

      return {
        metrics: { boulders: total, pushed, prize: prize ? 1 : 0 },
        actions: 6,
        invariantChecks: 3,
      };
    }),
};

export const SCENARIOS: Record<string, Scenario> = Object.fromEntries(
  [
    artifact,
    bones,
    boot,
    breath,
    buc,
    combat,
    container,
    corpse,
    death,
    deep,
    descend,
    feature,
    flee,
    fov,
    hunger,
    invocation,
    items,
    ludios,
    mines,
    pet,
    planes,
    poly,
    prayer,
    quest,
    rally,
    ride,
    sacrifice,
    save,
    shop,
    skill,
    sokoban,
    special,
    specialLevel,
    throwing,
    victory,
    vlad,
    walk,
    wish,
  ]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => [s.name, s]),
);

/** 场景名称列表。 */
export const SCENARIO_NAMES = Object.keys(SCENARIOS);

export { FIXED_CHARACTER, monsterSummary, newSession, renderMap };
