/**
 * 引擎基础自检。
 *
 * 运行：`bun test tools/selfcheck.test.ts`，或 `bun run check`。
 * 每个分组是一个测试用例，失败时列出该组的全部失败标签。
 * 覆盖率：`bun run check:coverage`。
 */

import { afterAll, describe, expect, test } from 'bun:test';
import type { GroundPile, Level, MonsterData, ObjectData } from '../src/types';
import { createRng, deriveSeed } from '../src/core/rng';
import {
  MONSTERS,
  OBJECTS,
  GENERATABLE_MONSTERS,
  REAL_OBJECTS,
  monById,
  objById,
  shuffleAppearances,
} from '../src/data/index';
import { generateLevel, index } from '../src/game/dungeon';
import { isWalkable, COLNO, ROWNO, T } from '../src/core/constants';

interface CheckRecord {
  name: string;
  checks: number;
  failures: string[];
}

let current: CheckRecord | null = null;
let totalChecks = 0;
const allFailures: string[] = [];

/** 记录一次断言，必须位于 section 内。 */
const ok = (cond: boolean | undefined, label: string): void => {
  if (!current) throw new Error('断言必须写在 section() 内');
  current.checks++;
  if (!cond) current.failures.push(label);
};

/** 记录一次失败，用于循环内的批量检查。 */
const fail = (label: string): void => {
  if (!current) throw new Error('断言必须写在 section() 内');
  current.checks++;
  current.failures.push(label);
};

/** 定义一个自检分组，对应一个测试用例。 */
function section(name: string, body: () => void | Promise<void>): void {
  describe(name, () => {
    test(name, async () => {
      const record: CheckRecord = { name, checks: 0, failures: [] };
      current = record;
      try {
        await body();
      } finally {
        current = null;
      }
      totalChecks += record.checks;
      if (record.failures.length > 0) {
        allFailures.push(...record.failures.map((label) => `${name}：${label}`));
        console.error(`FAIL ${name}，${record.failures.length} 项：`);
        for (const label of record.failures) console.error(`  · ${label}`);
      }
      expect(record.failures).toEqual([]);
    });
  });
}

section('随机数', async () => {
  const rng = createRng(12345);
  ok(rng.rn2(1) === 0, 'rn2(1) always 0');
  ok(rng.rn2(0) === 0, 'rn2(0) is 0');
  for (let i = 0; i < 1000; i++) {
    const v = rng.rn2(10);
    if (v < 0 || v > 9) {
      fail('rn2 range');
      break;
    }
    const w = rng.rnd(6);
    if (w < 1 || w > 6) {
      fail('rnd range');
      break;
    }
  }
  ok(true, 'rn2/rnd stay in range');
  ok(rng.dice(0, 6) === 0, 'dice(0,6) is 0');
  {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const v = rng.dice(2, 6);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    ok(lo >= 2 && hi <= 12, 'dice(2,6) in [2,12]');
  }
  {
    const a = createRng(deriveSeed('game', 1));
    const b = createRng(deriveSeed('game', 1));
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    ok(seqA.join() === seqB.join(), 'same seed -> same sequence');
    const c = createRng(deriveSeed('game', 2));
    const seqC = Array.from({ length: 20 }, () => c.next());
    ok(seqA.join() !== seqC.join(), 'different seed -> different sequence');
  }
});

section('数据完整性', async () => {
  ok(MONSTERS.length === 394, `monster count is 394 (got ${MONSTERS.length})`);
  ok(OBJECTS.length > 420, `object count > 420 (got ${OBJECTS.length})`);
  ok(
    GENERATABLE_MONSTERS.length > 200,
    `generatable monsters > 200 (got ${GENERATABLE_MONSTERS.length})`,
  );
  ok(
    MONSTERS.every((m) => m.glyph.length === 1),
    'every monster has a 1-char glyph',
  );
  ok(
    MONSTERS.every((m) => Number.isFinite(m.lvl) && Number.isFinite(m.ac)),
    'monster level/ac numeric',
  );
  ok(
    REAL_OBJECTS.every((o) => o.name && o.cls),
    'every real object has name + class',
  );

  // 与原版数值对照的抽样检查。
  const ant = monById.get('GIANT_ANT') as MonsterData;
  ok(ant && ant.lvl === 2 && ant.speed === 18 && ant.ac === 3, 'giant ant stats match NetHack');
  ok(ant.attacks[0].at === 'AT_BITE' && ant.attacks[0].dice[0] === 1, 'giant ant bites 1d4');
  const sword = objById.get('LONG_SWORD');
  ok(sword && sword.dmg === '1d8' && sword.dmgLarge === '1d12', 'long sword damage 1d8/1d12');
  const plate = objById.get('PLATE_MAIL');
  ok(plate && plate.ac === 7 && plate.slot === 'suit', 'plate mail +7 AC');
  const heal = objById.get('POT_HEALING');
  ok(heal && heal.appr === 'purple-red', 'potion of healing is purple-red');
});

section('外观洗牌', async () => {
  {
    const r1 = createRng(7);
    const map = shuffleAppearances(r1);
    const potions = REAL_OBJECTS.filter((o) => o.cls === 'potion');
    const assigned = potions.map((p) => map.get(p.id));
    ok(assigned.every(Boolean), 'every potion gets an appearance');
    ok(new Set(assigned).size === assigned.length, 'potion appearances are unique');
    const wands = REAL_OBJECTS.filter((o) => o.cls === 'wand');
    const wandAppr = wands.map((w) => map.get(w.id));
    ok(new Set(wandAppr).size === wandAppr.length, 'wand appearances are unique');
  }
});

section('地牢生成', async () => {
  function reachable(level: Level, from: { x: number; y: number }): Uint8Array {
    const seen = new Uint8Array(COLNO * ROWNO);
    const queue = [index(from.x, from.y)];
    seen[queue[0]] = 1;
    while (queue.length) {
      const i = queue.pop() as number;
      const x = i % COLNO;
      const y = (i / COLNO) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= COLNO || ny < 0 || ny >= ROWNO) continue;
        const j = index(nx, ny);
        if (seen[j] || !isWalkable(level.tiles[j])) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
    return seen;
  }

  {
    const t0 = Date.now();
    let generated = 0;
    for (const seed of [1, 42, 777, 987654]) {
      for (const depth of [1, 2, 5, 11, 20]) {
        const level = generateLevel({ gameSeed: seed, depth });
        generated++;
        ok(level.rooms.length >= 3, `seed ${seed} depth ${depth}: >= 3 rooms`);
        ok(!!level.down, `seed ${seed} depth ${depth}: down stairs present`);
        ok(depth === 1 ? !level.up : !!level.up, `seed ${seed} depth ${depth}: up stairs rule`);
        const start = level.start ?? { x: 1, y: 1 };
        const seen = reachable(level, start);
        const downRef = level.down as { x: number; y: number };
        ok(seen[index(downRef.x, downRef.y)] === 1, `seed ${seed} depth ${depth}: down reachable`);
        if (level.up)
          ok(
            seen[index(level.up.x, level.up.y)] === 1,
            `seed ${seed} depth ${depth}: up reachable`,
          );
        const allRoomsTouched = level.rooms.every((r) => {
          for (let x = r.lx; x <= r.hx; x++)
            for (let y = r.ly; y <= r.hy; y++) if (seen[index(x, y)]) return true;
          return false;
        });
        ok(allRoomsTouched, `seed ${seed} depth ${depth}: every room reachable`);
        for (const s of level.stairs) {
          ok(
            level.tiles[index(s.x, s.y)] === T.STAIRS,
            `seed ${seed} depth ${depth}: stair tile is stairs`,
          );
        }
      }
    }
    const ms = Date.now() - t0;
    ok(ms < 4000, `${generated} levels generated in ${ms}ms`);
  }
});

section('战斗与会话', async () => {
  {
    const { GameSession, MAX_DEPTH } = await import('../src/game/session.js');
    const { xpForLevel, abon, dbon, acValue } = await import('../src/game/combat.js');
    const { createRng } = await import('../src/core/rng.js');

    ok(xpForLevel(1) === 20, 'newuexp(1) is 20');
    ok(xpForLevel(9) === 5120, 'newuexp(9) is 5120');
    ok(abon({ str: 10, dex: 12, level: 1 }) === 1, 'abon includes the low-level kludge');
    ok(dbon(18) === 2 && dbon(8) === 0, 'dbon table');
    {
      const rng = createRng(5);
      ok(acValue(-4, rng) <= -1 && acValue(-4, rng) >= -4, 'AC_VALUE randomizes negative AC');
    }

    const session = new GameSession({ seed: 20240101 });
    ok(session.player.hp > 0 && session.player.maxHp > 0, 'hero starts with hit points');
    ok(session.player.ac <= 10, `hero AC is at most 10 (got ${session.player.ac})`);
    ok(
      session.player.weapon !== null || session.player.role.id === 'MONK',
      'starting kit equips a weapon',
    );
    ok(session.level.monsters.length > 0, 'level 1 spawns monsters');
    const maxDiff1 = Math.floor((1 + session.player.level) / 2);
    ok(
      session.level.monsters.every((m) => m.data.diff <= maxDiff1),
      `dlvl1 monsters respect difficulty window (max ${maxDiff1})`,
    );

    // 通过真实回合循环把一只怪物打到死。
    const mon = session.level.monsters[0];
    session.player.x = mon.x - 1;
    session.player.y = mon.y;
    session.refreshFov();
    let killed = false;
    for (let i = 0; i < 200 && !session.dead; i++) {
      const r = session.movePlayer(1, 0);
      if (r.result === 'killed') {
        killed = true;
        break;
      }
      if (r.result === 'blocked') break;
    }
    ok(killed, 'hero can kill a level-1 monster');
    ok(session.kills === 1, 'kill counter increments');
    ok(session.player.xp > 0, 'experience is awarded');

    // 构造必死局面，验证死亡处理。
    const s2 = new GameSession({ seed: 99 });
    s2.player.hp = 1;
    const foe = s2.level.monsters[0];
    foe.mhp = 999;
    foe.mhpmax = 999;
    foe.asleep = false;
    s2.player.x = foe.x - 1;
    s2.player.y = foe.y;
    s2.refreshFov();
    for (let i = 0; i < 60 && !s2.dead; i++) s2.wait();
    ok(s2.dead === true, 'hero dies when HP reaches 0');
    ok(
      s2.messages.some((m) => m.key === 'msg.youDie'),
      'death message is logged',
    );

    // 有怪物在场时，下楼流程依然可用。
    const s3 = new GameSession({ seed: 7 });
    const down = s3.level.down as { x: number; y: number };
    const walk = (t: number): boolean => [22, 23, 24, 26, 21, 30, 25, 31].includes(t);
    const W = s3.level.width;
    const at = (x: number, y: number): number => s3.level.tiles[y * W + x];
    const dir = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ].find(([dx, dy]) => walk(at(down.x + dx, down.y + dy)));
    if (dir) {
      s3.player.x = down.x + dir[0];
      s3.player.y = down.y + dir[1];
      const r = s3.movePlayer(-dir[0], -dir[1]);
      ok(r.result === 'descended' || s3.dead, 'stepping on down stairs descends');
    }
    ok(MAX_DEPTH === 30, 'dungeon runs 30 levels');
  }
});

section('物品与背包', async () => {
  {
    const { GameSession } = await import('../src/game/session.js');
    const { describeItem } = await import('../src/game/items.js');
    const { pickup, addToInventory } = await import('../src/game/inventory.js');
    const dataIndex = await import('../src/data/index.js');

    const s = new GameSession({ seed: 555 });
    ok(s.level.objects.length > 0, 'level spawns ground objects');
    ok(
      s.level.objects.some((p) => p.items.some((i) => i.gold)),
      'level spawns gold',
    );

    // 拾取一堆物品，确认进入背包。
    const pile = s.level.objects.find((p) => !p.items.every((i) => i.gold)) as GroundPile;
    s.player.x = pile.x;
    s.player.y = pile.y;
    const res = pickup(s.player, s.level);
    ok(res.ok && res.picked.length > 0, 'pickup moves items to the pack');
    ok(s.player.inventory.length > 4, 'starting kit plus loot');

    // 未鉴定药水显示外观，鉴定后显示真实名称。
    const potion = s.player.inventory.find((i) => i.proto.cls === 'potion');
    if (potion) {
      const unknown = describeItem(potion);
      ok(unknown.key === 'item.unknown.potion', 'potion starts unidentified');
      ok(
        typeof unknown.vars.apprId === 'string' && unknown.vars.apprId.length > 0,
        'potion has an appearance',
      );
      potion.known = true;
      const known = describeItem(potion);
      ok(
        known.key === 'item.known.potion' && known.vars.name === potion.proto.id,
        'identified potion uses its name',
      );
    }

    // 喝下治疗药水应恢复生命并消耗药水。
    const quaffable = Object.assign(
      {},
      s.player.inventory.find((i) => i.proto.id === 'POT_HEALING') ?? null,
    );
    if (!quaffable.proto) {
      const { makeItem } = await import('../src/game/items.js');
      const proto = dataIndex.objById.get('POT_HEALING') as ObjectData;
      const item = makeItem(proto, s.rng);
      addToInventory(s.player, item);
      s.player.hp = 1;
      const r = s.useItem(item);
      ok(s.player.hp > 1, 'quaffing healing restores hit points');
      ok(r.result === 'used', 'item use consumes a turn');
      ok(!s.player.inventory.includes(item), 'quaffed potion is consumed');
    } else {
      s.player.hp = 1;
      s.useItem(quaffable);
      ok(s.player.hp > 1, 'quaffing healing restores hit points');
    }

    // 进食提升饱食度，上限 2000。
    const { makeItem } = await import('../src/game/items.js');
    const food = makeItem(dataIndex.objById.get('FOOD_RATION') as ObjectData, s.rng);
    addToInventory(s.player, food);
    const before = s.player.hunger;
    s.useItem(food);
    ok(s.player.hunger > before, 'eating restores nutrition');
  }
});

section('锁门与踹门', async () => {
  {
    const { GameSession } = await import('../src/game/session');
    const { stepTowardGoal, lockedDoorAt } = await import('./agent-lib');
    const { index } = await import('../src/game/dungeon');

    const s = new GameSession({ seed: 4242 });
    const locked = [...s.level.doors].find(([, d]) => d.locked && d.closed);
    if (locked) {
      const [tileIndex, door] = locked;
      const doorX = tileIndex % s.level.width;
      const doorY = Math.floor(tileIndex / s.level.width);
      // 从门前一格反复撞门，力量足够时必然打开。
      s.player.x = doorX;
      s.player.y = doorY + 1;
      s.player.str = 18;
      s.player.level = 5;
      s.refreshFov();
      for (let i = 0; i < 40 && door.locked; i++) s.movePlayer(0, -1);
      ok(!door.locked, '锁着的门可通过反复踹击打开');
      ok(!lockedDoorAt(s.level, doorX, doorY), '踹开后不再被寻路视为锁门');
    } else {
      ok(true, '该种子没有锁门，跳过踹门检查');
    }

    // 寻路优先绕开锁门：两段式入口在无锁门路线时仍能找到路径。
    const dir = stepTowardGoal(
      s.level,
      { x: s.player.x, y: s.player.y },
      s.level.down as { x: number; y: number },
    );
    ok(
      dir !== null || s.player.x === (s.level.down as { x: number }).x,
      '两段式寻路可抵达下行楼梯',
    );
    void index;
  }
});

section('日志', async () => {
  {
    const {
      createLogger,
      parseDebugSpec,
      recentLogs,
      dumpLogs,
      clearLogs,
      setLogLevel,
      disableDebug,
    } = await import('../src/core/log');

    clearLogs();
    setLogLevel('info');
    const a = createLogger('test.a');
    const b = createLogger('test.b');
    a.info('info 始终输出');
    a.debug('debug 默认关闭');
    ok(recentLogs().length === 1, '默认只输出 info 及以上级别');

    setLogLevel('debug');
    parseDebugSpec('test.a');
    a.debug('开启后输出');
    b.debug('其它命名空间不输出');
    ok(recentLogs().length === 2, '命名空间过滤生效');
    ok(
      recentLogs().some((e) => e.message.includes('开启后输出')),
      '开启命名空间后 debug 进入缓冲区',
    );
    ok(dumpLogs().includes('[test.a]'), '日志导出包含命名空间');
    ok(typeof a.time('计时')() === 'number', '计时器返回耗时');

    const child = a.child('roll');
    child.debug('子命名空间日志');
    ok(
      recentLogs().some((e) => e.namespace === 'test.a.roll'),
      '子命名空间沿用父级开关',
    );
    clearLogs();
    // 恢复默认设置，避免影响后续检查的控制台输出。
    setLogLevel('warn');
    disableDebug();
  }
});

section('存档往返', async () => {
  {
    const { GameSession } = await import('../src/game/session.js');
    const { serializeSession, restoreSession } = await import('../src/game/save.js');

    const s = new GameSession({
      seed: 31337,
      attributes: { str: 9, int: 18, wis: 13, dex: 11, con: 10, cha: 12 },
    });
    s.movePlayer(1, 0);
    s.movePlayer(0, 1);
    const pile = s.level.objects.find((p) => p.items.length);
    if (pile) {
      s.player.x = pile.x;
      s.player.y = pile.y;
      s.refreshFov();
      s.pickupAction();
    }
    const restored = restoreSession(JSON.parse(JSON.stringify(serializeSession(s))));
    ok(
      JSON.stringify(s.status) === JSON.stringify(restored.status),
      'save round-trips session status',
    );
    ok(
      s.player.str === restored.player.str && s.player.int === restored.player.int,
      'save round-trips attributes',
    );
    ok(
      s.player.inventory.length === restored.player.inventory.length,
      'save round-trips inventory',
    );
    ok(
      Object.keys(s.player.equipment).sort().join() ===
        Object.keys(restored.player.equipment).sort().join(),
      'save round-trips equipment',
    );
    ok(s.level.seen.join('') === restored.level.seen.join(''), 'save round-trips fog of war');
    ok(
      s.level.monsters.length === restored.level.monsters.length &&
        s.level.objects.length === restored.level.objects.length,
      'save round-trips monsters and ground items',
    );
  }
});

section('终局', async () => {
  {
    const { GameSession, MAX_DEPTH } = await import('../src/game/session.js');
    const s = new GameSession({ seed: 8 });
    s.player.maxHp = 99;
    s.player.hp = 99;
    s.changeDepth(MAX_DEPTH, 'down');
    const pile = s.level.objects.find((p) =>
      p.items.some((i) => i.proto.id === 'AMULET_OF_YENDOR'),
    );
    ok(!!pile, `Amulet of Yendor is placed on depth ${MAX_DEPTH}`);
    if (pile) {
      s.player.x = pile.x;
      s.player.y = pile.y;
      s.refreshFov();
      s.pickupAction();
      ok(s.victory === true, 'picking up the Amulet wins the game');
      ok(
        s.messages.some((m) => m.key === 'msg.victory'),
        'victory message is logged',
      );
    }
  }
});

/** 已探索格子数量，用于判断关卡是否还有未探索区域。 */
function seen_count(level: Level): number {
  let n = 0;
  for (let i = 0; i < level.seen.length; i++) if (level.seen[i] === 1) n++;
  return n;
}

section('点击移动寻路', async () => {
  const { GameSession } = await import('../src/game/session');
  const { findPath, pathPoints } = await import('../src/game/path');
  const { isWalkable, isWall } = await import('../src/core/constants');
  const { index } = await import('../src/game/dungeon');

  const s = new GameSession({ seed: 20240101 });
  const level = s.level;
  const start = { x: s.player.x, y: s.player.y };
  const occupied = (x: number, y: number): boolean =>
    level.monsters.some((m) => m.x === x && m.y === y && m.mhp > 0);

  // 起点周围应该能找到另一处已探索的空地。
  let target: { x: number; y: number } | null = null;
  let unseen: { x: number; y: number } | null = null;
  let wall: { x: number; y: number } | null = null;
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const i = index(x, y);
      if (!unseen && level.seen[i] === 0 && isWalkable(level.tiles[i])) unseen = { x, y };
      if (!wall && isWall(level.tiles[i])) wall = { x, y };
      if (
        !target &&
        level.seen[i] === 1 &&
        isWalkable(level.tiles[i]) &&
        !occupied(x, y) &&
        (x !== start.x || y !== start.y)
      ) {
        target = { x, y };
      }
    }
  }

  if (target) {
    const path = findPath(level, start, target);
    ok(!!path && path.length > 0, '同房间内已探索的空地可达');
    const points = pathPoints(start, path ?? []);
    const last = points[points.length - 1];
    ok(!!last && last.x === target.x && last.y === target.y, '路径终点落在目标格');
    ok(
      points.every((p) => level.seen[index(p.x, p.y)] === 1),
      '路径只经过已探索的格子',
    );
    ok(
      points.every((p) => isWalkable(level.tiles[index(p.x, p.y)])),
      '路径只经过可通行的格子',
    );
  } else {
    ok(false, '起点周围没有可用的目标格');
  }

  ok(findPath(level, start, start)?.length === 0, '起点到自身返回空路径');
  if (seen_count(level) > 0) {
    // 未探索的空地不应参与寻路。
    ok(unseen ? findPath(level, start, unseen) === null : true, '未探索区域不可达');
  }
  ok(wall ? findPath(level, start, wall) === null : true, '墙体不可达');
});

section('地图结构', async () => {
  const { generateLevel, index, insideRoom } = await import('../src/game/dungeon');
  const { COLNO, T, isRoom } = await import('../src/core/constants');
  const { auditDoorOrientations } = await import('./agent-lib');

  let doors = 0;
  let adjacentPairs = 0;
  let tileMismatch = 0;
  let roomsWithoutDoor = 0;
  let corridorsInsideRooms = 0;
  let doorsAtEntrance = 0;
  let doorAmbiguous = 0;
  let auditProblems: string[] = [];

  for (const seed of [1, 42, 777]) {
    for (const depth of [1, 5, 11]) {
      const level = generateLevel({ gameSeed: seed, depth });
      auditProblems = auditProblems.concat(auditDoorOrientations(level).problems);
      doors += level.doors.size;

      for (const [i] of level.doors) {
        const x = i % COLNO;
        const y = (i / COLNO) | 0;
        // 门表与瓦片必须一致，否则渲染与寻路会各说各话。
        if (level.tiles[i] !== T.DOOR) tileMismatch++;
        // 门不该挨着门：连成一排的门在画面上是一串门板。
        if (level.doors.has(index(x + 1, y)) || level.doors.has(index(x, y + 1))) adjacentPairs++;
        // 门是房间入口：正交邻居里应当有房间或楼梯。
        const sides = [
          level.tiles[index(x - 1, y)],
          level.tiles[index(x + 1, y)],
          level.tiles[index(x, y - 1)],
          level.tiles[index(x, y + 1)],
        ];
        if (sides.some((t) => isRoom(t) || t === T.STAIRS)) doorsAtEntrance++;

        // 门应当恰好连接一个房间；朝向交给 ASCII 审计独立核对。
        const roomX = insideRoom(level, x - 1, y) || insideRoom(level, x + 1, y);
        const roomY = insideRoom(level, x, y - 1) || insideRoom(level, x, y + 1);
        if (roomX === roomY) doorAmbiguous++;
      }

      for (const room of level.rooms) {
        let hasDoor = false;
        for (const [i] of level.doors) {
          const x = i % COLNO;
          const y = (i / COLNO) | 0;
          if (x >= room.lx - 1 && x <= room.hx + 1 && y >= room.ly - 1 && y <= room.hy + 1) {
            hasDoor = true;
            break;
          }
        }
        if (!hasDoor) roomsWithoutDoor++;

        // 房间矩形内不应出现走廊或门。
        for (let x = room.lx; x <= room.hx; x++) {
          for (let y = room.ly; y <= room.hy; y++) {
            const t = level.tiles[index(x, y)];
            if (t === T.CORR || t === T.DOOR) corridorsInsideRooms++;
          }
        }
      }
    }
  }

  ok(doors > 100, `样本内共有 ${doors} 扇门`);
  ok(adjacentPairs === 0, `没有相邻的门（${adjacentPairs} 处）`);
  ok(tileMismatch === 0, `门表与瓦片一致（${tileMismatch} 处不一致）`);
  ok(roomsWithoutDoor === 0, `每个房间都有门（${roomsWithoutDoor} 个没有）`);
  ok(corridorsInsideRooms === 0, `房间内没有走廊（${corridorsInsideRooms} 格）`);
  ok(doorsAtEntrance / doors > 0.95, `门位于房间入口（${doorsAtEntrance}/${doors}）`);
  ok(doorAmbiguous === 0, `每扇门只连一个房间（${doorAmbiguous} 扇两侧都有或都没有）`);
  ok(
    auditProblems.length === 0,
    `固定样本门朝向与地图通道一致（${auditProblems.length} 扇判反` +
      `${auditProblems.length ? `：${auditProblems.slice(0, 2).join('；')}` : ''}）`,
  );

  // ASCII 模糊：固定样本碰不到「走廊贴着房间外墙经过」这类格局，
  // 批量生成关卡，把每扇门的朝向与地图上的通道走向对照一遍。
  let fuzzDoors = 0;
  let fuzzClear = 0;
  let fuzzRoomFallback = 0;
  let fuzzUnknown = 0;
  const fuzzProblems: string[] = [];
  for (let n = 0; n < 24; n++) {
    const seed = (9001 + n * 104729) >>> 0;
    const depth = 1 + ((n * 7 + 3) % 30);
    const audit = auditDoorOrientations(generateLevel({ gameSeed: seed, depth }));
    fuzzDoors += audit.doors;
    fuzzClear += audit.clear;
    fuzzRoomFallback += audit.roomFallback;
    fuzzUnknown += audit.unknown;
    fuzzProblems.push(...audit.problems.map((p) => `种子 ${seed} 第 ${depth} 层：${p}`));
  }
  ok(fuzzDoors > 200, `模糊样本内共有 ${fuzzDoors} 扇门`);
  ok(fuzzClear > 80, `模糊样本内有 ${fuzzClear} 扇通道明确的门`);
  ok(fuzzRoomFallback > 0, `模糊样本覆盖房间兜底判定（${fuzzRoomFallback} 扇）`);
  ok(fuzzUnknown * 10 < fuzzDoors, `绝大多数门可由地图判定（无法判定 ${fuzzUnknown} 扇）`);
  ok(
    fuzzProblems.length === 0,
    `模糊样本门朝向与地图通道一致（${fuzzProblems.length} 扇判反` +
      `${fuzzProblems.length ? `：${fuzzProblems.slice(0, 2).join('；')}` : ''}）`,
  );
});
section('陷阱', async () => {
  const { GameSession } = await import('../src/game/session');
  const { index } = await import('../src/game/dungeon');
  const { COLNO, isWalkable } = await import('../src/core/constants');

  /** 找一处可站立的相邻格，把陷阱放上去，再走过去踩中。 */
  const stepOn = (
    session: InstanceType<typeof GameSession>,
    type: string,
  ): { sprung: boolean; at: number } => {
    const p = session.player;
    const options: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [dx, dy] of options) {
      const x = p.x + dx;
      const y = p.y + dy;
      const i = index(x, y);
      const tile = session.level.tiles[i];
      if (!isWalkable(tile)) continue;
      if (session.level.monsters.some((m) => m.x === x && m.y === y && m.mhp > 0)) continue;
      session.level.traps.set(i, { type, seen: false });
      session.movePlayer(dx, dy);
      return { sprung: true, at: i };
    }
    return { sprung: false, at: -1 };
  };

  // 伤害类：生命下降，且陷阱被记为已发现。
  {
    const s = new GameSession({ seed: 4242 });
    s.player.maxHp = 60;
    s.player.hp = 60;
    const { sprung, at } = stepOn(s, 'PIT');
    ok(sprung, '找到可下脚的位置放坑');
    if (sprung) {
      ok(s.player.hp < 60, `踩中坑会掉血（剩余 ${s.player.hp}）`);
      ok(s.level.traps.get(at)?.seen === true, '踩过的陷阱被记为已发现');
      ok(s.level.traps.get(at) !== undefined, '陷阱仍留在地图上');
    }
  }

  // 定身与睡眠：写入状态计时，且此时无法移动。
  {
    const s = new GameSession({ seed: 777 });
    s.player.maxHp = 60;
    s.player.hp = 60;
    stepOn(s, 'BEAR_TRAP');
    ok(s.player.held > 0, `捕熊夹会缠住玩家（${s.player.held} 回合）`);
    const before = { x: s.player.x, y: s.player.y };
    s.movePlayer(1, 0);
    ok(s.player.x === before.x && s.player.y === before.y, '被缠住时无法移动');
  }
  {
    const s = new GameSession({ seed: 777 });
    s.player.maxHp = 60;
    s.player.hp = 60;
    stepOn(s, 'SLEEPING_GAS_TRAP');
    ok(s.player.sleep > 0, `催眠气体会让玩家睡着（${s.player.sleep} 回合）`);
    const before = s.turn;
    const result = s.movePlayer(1, 0);
    ok(result.result === 'slept', '沉睡时的移动会被拒绝');
    ok(s.turn > before, '沉睡仍然消耗回合');
  }

  // 法力类。
  {
    const s = new GameSession({ seed: 99 });
    s.player.pw = s.player.maxPw;
    stepOn(s, 'ANTI_MAGIC');
    ok(s.player.pw === 0, '反魔法力场会抽干法力');
  }

  // 传送类：位置改变后仍在可站立的格子上。
  {
    const s = new GameSession({ seed: 12345 });
    stepOn(s, 'TELEP_TRAP');
    const i = index(s.player.x, s.player.y);
    ok(isWalkable(s.level.tiles[i]), '传送后的落点可以站立');
    ok(s.player.x >= 0 && s.player.x < COLNO, '传送后坐标仍在界内');
  }

  // 掉层与唤醒。
  {
    const s = new GameSession({ seed: 555 });
    const before = s.depth;
    stepOn(s, 'HOLE');
    ok(s.depth > before, `掉进洞里会下一层（${before} → ${s.depth}）`);
  }
  {
    const s = new GameSession({ seed: 2024 });
    const mon = s.level.monsters[0];
    if (mon) {
      mon.asleep = true;
      stepOn(s, 'SQKY_BOARD');
      // 显式标成 boolean，避免 TS 按赋值结果收窄类型。
      const awake: boolean = mon.asleep;
      ok(!awake, '吱嘎板会吵醒场上的怪物');
    } else {
      ok(true, '该层没有怪物，跳过唤醒检查');
    }
  }

  // 腐蚀：穿着盔甲时附魔下降；没穿也不应出错。
  {
    const s = new GameSession({ seed: 31337 });
    const suit = s.player.equipment.suit;
    if (suit) {
      const before = suit.enchant;
      stepOn(s, 'RUST_TRAP');
      ok(suit.enchant < before, `腐蚀会降低盔甲附魔（${before} → ${suit.enchant}）`);
    } else {
      stepOn(s, 'RUST_TRAP');
      ok(true, '未穿盔甲时腐蚀陷阱不报错');
    }
  }

  // 未登记的陷阱类型按无事发生处理，不应抛异常。
  {
    const s = new GameSession({ seed: 8 });
    const { sprung } = stepOn(s, 'NOT_A_REAL_TRAP');
    ok(sprung, '未知陷阱类型可以正常结算');
    ok(!s.dead, '未知陷阱类型不会导致死亡');
  }
});
section('施法', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');
  const { spellProfile, castFailChance } = await import('../src/game/spells');
  const { objById } = await import('../src/data/index');
  const { index } = await import('../src/game/dungeon');
  const { isWalkable } = await import('../src/core/constants');
  const { roleById, raceById } = await import('../src/game/roles');

  /** 构造角色选项：测试只关心职业与属性。 */
  const choice = (roleId: string) => ({
    role: roleById[roleId]!,
    race: raceById['HUMAN']!,
    align: 'neutral' as const,
    gender: 'female' as const,
  });

  /** 造一本法术书并让玩家学会。 */
  const learn = (session: InstanceType<typeof GameSession>, id: string) => {
    const item = makeItem(objById.get(id)!, session.rng);
    addToInventory(session.player, item);
    session.player.knownSpells.push(id);
    return item;
  };

  // 数值设计：等级越高越难，智力越高越稳，施法职业有加成。
  {
    const s = new GameSession({
      seed: 1,
      character: choice('WIZARD'),
      attributes: { str: 10, int: 18, wis: 10, dex: 10, con: 10, cha: 10 },
    });
    const wizardLow = castFailChance(s.player, 1);
    const wizardHigh = castFailChance(s.player, 7);
    ok(wizardLow === 0, `高智力法师施放 1 级法术不会失败（${wizardLow}）`);
    ok(wizardHigh > wizardLow, `等级越高越难（1 级 ${wizardLow} < 7 级 ${wizardHigh.toFixed(2)}）`);
    const w = new GameSession({
      seed: 1,
      character: choice('BARBARIAN'),
      attributes: { str: 10, int: 10, wis: 10, dex: 10, con: 10, cha: 10 },
    });
    ok(castFailChance(w.player, 4) > castFailChance(s.player, 4), '非施法职业更难念对咒语');
  }

  // 未学会的法术不能施放。
  {
    const s = new GameSession({ seed: 2 });
    const item = makeItem(objById.get('SPE_FORCE_BOLT')!, s.rng);
    addToInventory(s.player, item);
    const pw = s.player.pw;
    s.castSpell(item);
    ok(s.player.pw === pw, '没学会的法术不会消耗法力');
    ok(s.messages.at(-1)?.key === 'msg.castUnknown', '未学会时给出提示');
  }

  // 法力不足时不消耗回合。
  {
    const s = new GameSession({ seed: 3, character: choice('WIZARD') });
    const item = learn(s, 'SPE_FIREBALL');
    const profile = spellProfile(item.proto);
    s.player.pw = profile.cost - 1;
    const before = s.turn;
    const result = s.castSpell(item);
    ok(result.result === 'nothing', '法力不足时施法被拒绝');
    ok(s.turn === before, '法力不足不消耗回合');
    ok(s.messages.at(-1)?.key === 'msg.castNoMana', '法力不足给出提示');
  }

  // 攻击法术：伤害目标并扣法力。
  {
    const s = new GameSession({
      seed: 4,
      character: choice('WIZARD'),
      attributes: { str: 10, int: 18, wis: 10, dex: 10, con: 10, cha: 10 },
    });
    const item = learn(s, 'SPE_FORCE_BOLT');
    const profile = spellProfile(item.proto);
    s.player.pw = 20;
    const mon = s.level.monsters[0];
    ok(!!mon, '关卡里有可用于测试的怪物');
    if (mon) {
      // 法术只作用于视野内的目标，先把怪物挪到旁边。
      mon.mhp = 80;
      mon.x = s.player.x + 1;
      mon.y = s.player.y;
      mon.asleep = true;
      s.refreshFov();
      const hpBefore = mon.mhp;
      const pwBefore = s.player.pw;
      const turnBefore = s.turn;
      s.castSpell(item);
      ok(mon.mhp < hpBefore, `攻击法术造成伤害（${hpBefore} → ${mon.mhp}）`);
      ok(s.player.pw === pwBefore - profile.cost, `施法消耗 ${profile.cost} 点法力`);
      ok(s.turn > turnBefore, '施法消耗回合');
      ok(s.messages.at(-1)?.key === 'msg.castHit', '命中提示');
    }
  }

  // 治疗法术：回血但不超过上限。
  {
    const s = new GameSession({ seed: 5, character: choice('CLERIC') });
    const item = learn(s, 'SPE_HEALING');
    s.player.pw = 20;
    s.player.hp = 1;
    s.castSpell(item);
    ok(s.player.hp > 1, `治疗法术回血（1 → ${s.player.hp}）`);
    ok(s.player.hp <= s.player.maxHp, '回血不超过上限');
  }

  // 占卜法术：揭开整层地图。
  {
    const s = new GameSession({ seed: 6, character: choice('WIZARD') });
    const item = learn(s, 'SPE_DETECT_MONSTERS');
    s.player.pw = 20;
    const before = s.level.seen.reduce((a, b) => a + b, 0);
    s.castSpell(item);
    const after = s.level.seen.reduce((a, b) => a + b, 0);
    ok(after > before, `占卜揭开地图（${before} → ${after} 格）`);
  }

  // 失败路径：低智力念高等级法术，多试几次必定出现失败。
  {
    const s = new GameSession({
      seed: 7,
      character: choice('BARBARIAN'),
      attributes: { str: 10, int: 3, wis: 10, dex: 10, con: 10, cha: 10 },
    });
    const item = learn(s, 'SPE_FINGER_OF_DEATH');
    s.player.pw = 200;
    s.player.maxPw = 200;
    let failed = false;
    for (let i = 0; i < 40 && !failed; i++) {
      s.player.pw = 200;
      s.castSpell(item);
      failed = s.messages.at(-1)?.key === 'msg.castFail';
    }
    ok(failed, '低智力施放高等级法术会出现失败');
    const lastPw = s.player.pw;
    /**
     * 失败时按原版损失一半法力：这里只检查法力确实减少且没有超过消耗。
     * 每次循环都会把法力重置为 200，因此剩余值应当落在 200 减去一半代价附近。
     */
    ok(lastPw < 200 && lastPw > 200 - spellProfile(item.proto).cost, '失败时损失一半法力');
  }

  // 物质法术：开门。
  {
    const s = new GameSession({ seed: 8 });
    const item = learn(s, 'SPE_KNOCK');
    s.player.pw = 20;
    const closed = [...s.level.doors].find(([, d]) => d.closed);
    if (closed) {
      const [tile, door] = closed;
      s.player.x = tile % 80;
      s.player.y = Math.floor(tile / 80);
      s.refreshFov();
      s.castSpell(item);
      ok(!door.closed, '物质法术会打开附近的门');
    } else {
      ok(true, '该层没有关闭的门，跳过开门检查');
    }
  }

  // 陷阱与法术都不该让角色落在不可通行的格子上。
  {
    const s = new GameSession({ seed: 9, character: choice('WIZARD') });
    const item = learn(s, 'SPE_TELEPORT_AWAY');
    s.player.pw = 20;
    s.castSpell(item);
    const i = index(s.player.x, s.player.y);
    ok(isWalkable(s.level.tiles[i]), '逃脱法术的落点可以站立');
  }
});

afterAll(() => {
  if (allFailures.length === 0) {
    console.log(`自检 ${totalChecks} 项断言通过`);
  } else {
    console.error(`自检失败 ${allFailures.length} 项：`);
    for (const label of allFailures) console.error(`  · ${label}`);
  }
});
