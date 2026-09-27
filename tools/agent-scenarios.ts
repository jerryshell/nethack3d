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
  stepTowardGoal,
  teleportPlayer,
  testRng,
  walkableAt,
} from './agent-lib';
import { MAX_DEPTH } from '../src/game/session';
import { index } from '../src/game/dungeon';
import { serializeSession, restoreSession } from '../src/game/save';
import { computeFov } from '../src/game/fov';
import { T } from '../src/core/constants';

/** 场景定义。 */
export interface Scenario {
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
      // 本场景验证下楼流程与关卡连通性，不验证生存能力，因此提升玩家强度。
      session.player.maxHp = 120;
      session.player.hp = 120;
      session.player.level = 5;
      const targetDepth = 5;
      const tracker = createSeenTracker();
      let steps = 0;
      let invariants = 0;

      while (session.depth < targetDepth && steps < 900 && !session.dead) {
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
          continue;
        }
        const dir = stepTowardGoal(
          session.level,
          { x: session.player.x, y: session.player.y },
          down,
        );
        if (!dir) {
          checker.fail('下行楼梯可达', `第 ${session.depth} 层寻路失败`, repro('descend', seed));
          break;
        }
        const depthBefore = session.depth;
        session.movePlayer(dir[0], dir[1]);
        steps++;

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

      teleportPlayer(session, target.x - 1, target.y);
      const beforeXp = player.xp;
      const beforeKills = session.kills;
      let attacks = 0;
      let missed = 0;
      let hits = 0;
      let invariants = 0;

      for (let i = 0; i < 60; i++) {
        const damageBefore = target.mhp;
        const outcome = session.movePlayer(1, 0);
        attacks++;
        if (target.mhp < damageBefore) hits++;
        else missed++;
        invariants++;
        const problems = checkInvariants(session);
        if (problems.length) {
          checker.absorb(`第 ${attacks} 次攻击后状态自洽`, problems, repro('combat', seed));
          break;
        }
        if (outcome.result === 'killed' || target.dead) break;
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

      // 拾取：站到有物品的格子。
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

      checker.ok(session.victory, '拾取护身符后标记通关', `victory=${session.victory}`);
      checker.ok(
        session.player.inventory.some((i) => i.proto.id === 'AMULET_OF_YENDOR'),
        '护身符进入背包',
        `背包=${session.player.inventory.map((i) => i.proto.id).join(',')}`,
      );
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
        metrics: { depth: session.depth, turn: session.turn, victory: session.victory },
        actions: 1,
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
      const foe = level.monsters[0];
      if (!foe) {
        checker.fail('关卡内存在怪物', '第 1 层没有生成怪物', repro('death', seed));
        return {};
      }
      foe.asleep = false;
      foe.mhp = 999;
      foe.mhpmax = 999;
      teleportPlayer(session, foe.x - 1, foe.y);

      for (let i = 0; i < 60 && !session.dead; i++) session.wait();

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
export const SCENARIOS: Record<string, Scenario> = Object.fromEntries(
  [boot, combat, death, descend, fov, hunger, items, save, victory, walk]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => [s.name, s]),
);

/** 场景名称列表。 */
export const SCENARIO_NAMES = Object.keys(SCENARIOS);

export { FIXED_CHARACTER, monsterSummary, newSession, renderMap };
