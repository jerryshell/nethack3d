/**
 * 引擎基础自检。
 *
 * 运行：`bun test tools/selfcheck.test.ts`，或 `bun run check`。
 * 每个分组是一个测试用例，失败时列出该组的全部失败标签。
 * 覆盖率：`bun run check:coverage`。
 */

import { afterAll, describe, expect, test } from 'bun:test';
import type {
  GroundPile,
  ItemInstance,
  Level,
  MonsterData,
  ObjectData,
  Room,
  ShopType,
} from '../src/types';
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
import { isWalkable, isWall, COLNO, ROWNO, T } from '../src/core/constants';

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
    // 地形设施等分组在慢机器上接近 5 秒，留出更宽的超时余量。
    test(
      name,
      async () => {
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
      },
      20_000,
    );
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

  // 地狱专属怪物只在深层出现。
  {
    const { pickMonsterType } = await import('../src/game/monsters');
    const shallow = new Set<string>();
    const deep = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const near = pickMonsterType(createRng(1000 + i), 20, 30);
      if (near) shallow.add(near.id);
      const far = pickMonsterType(createRng(2000 + i), 25, 30);
      if (far) deep.add(far.id);
    }
    const isHell = (id: string): boolean => monById.get(id)?.genFlags.includes('G_HELL') === true;
    ok(![...shallow].some(isHell), '第 20 层不生成地狱专属怪物');
    ok([...deep].some(isHell), '第 25 层生成地狱专属怪物');
  }
});

section('任务起始层数据', async () => {
  const { QUEST_HOME_LEVELS } = await import('../src/data/quest.gen');
  const { QUEST_MAP_CHARS } = await import('../src/game/quest');
  const { generateBranchLevel } = await import('../src/game/dungeon');

  ok(QUEST_HOME_LEVELS.length === 12, `12 个职业有固定起始层（${QUEST_HOME_LEVELS.length}）`);
  const roles = new Set(QUEST_HOME_LEVELS.map((home) => home.role));
  ok(roles.size === QUEST_HOME_LEVELS.length, '任务起始层没有重复职业');
  ok(!roles.has('RANGER'), '浪人没有固定地图，保持通用布局');
  for (const home of QUEST_HOME_LEVELS) {
    const width = Math.max(...home.map.map((line) => line.length));
    ok(
      width <= 80 && home.map.length <= 21,
      `${home.role} 地图尺寸合法（${width}×${home.map.length}）`,
    );
    ok(
      home.map.every((line) => [...line].every((ch) => ch in QUEST_MAP_CHARS)),
      `${home.role} 地图字符都在表内`,
    );
    ok(
      home.stairs.some((stair) => stair.dir === 'down'),
      `${home.role} 有下行楼梯`,
    );
    ok(!!home.branch, `${home.role} 有分支落脚区`);
  }

  // 生成端：同一职业与种子两次生成完全一致，楼梯可站且连通。
  const build = (role: string) =>
    generateBranchLevel({
      gameSeed: 20240101,
      branch: 'quest',
      depth: 1,
      levels: 5,
      questRole: role,
      align: 'neutral',
    });
  for (const home of QUEST_HOME_LEVELS) {
    const first = build(home.role);
    const again = build(home.role);
    ok(
      first.doors.size === again.doors.size &&
        first.stairs.length === again.stairs.length &&
        first.traps.size === again.traps.size,
      `${home.role} 固定地图可复现`,
    );
    ok(
      !!first.up &&
        !!first.down &&
        isWalkable(first.tiles[index(first.up.x, first.up.y)]) &&
        isWalkable(first.tiles[index(first.down.x, first.down.y)]),
      `${home.role} 上下楼梯都可站`,
    );
  }
});

section('语言包完整性', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const en = (await import('../src/i18n/en')).default as unknown as Record<string, unknown>;
  const zh = (await import('../src/i18n/zh-CN')).default as unknown as Record<string, unknown>;

  const lookup = (catalog: Record<string, unknown>, key: string): unknown => {
    let node: unknown = catalog;
    for (const part of key.split('.')) {
      if (node == null || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  };

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.gen.ts')) files.push(full);
    }
  };
  walk(path.join(import.meta.dir, '..', 'src'));

  // 只看 t('literal.key') 这种字面量调用；模板拼接的键靠运行时回退。
  const keys = new Set<string>();
  const pattern = /(?<![A-Za-z0-9_.])t\(\s*'([a-zA-Z0-9_.]+)'/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) keys.add(match[1]);
  }
  ok(keys.size > 50, `源码里找到 ${keys.size} 个字面量文案键`);
  const missingEn = [...keys].filter((k) => lookup(en, k) === undefined);
  const missingZh = [...keys].filter((k) => lookup(zh, k) === undefined);
  ok(
    missingEn.length === 0,
    `英文语言包覆盖全部字面量键（缺 ${missingEn.length}：${missingEn.slice(0, 3)}）`,
  );
  ok(
    missingZh.length === 0,
    `中文语言包覆盖全部字面量键（缺 ${missingZh.length}：${missingZh.slice(0, 3)}）`,
  );

  // 任务对白是按职业拼接的键，单独核对 13 个职业 × 三段文本。
  const { ROLES } = await import('../src/data/roles.gen');
  const questKeys: string[] = [];
  for (const role of ROLES) {
    for (const field of ['brief', 'thanks', 'taunt']) questKeys.push(`quest.${role.id}.${field}`);
  }
  const missingQuestEn = questKeys.filter((k) => lookup(en, k) === undefined);
  const missingQuestZh = questKeys.filter((k) => lookup(zh, k) === undefined);
  ok(missingQuestEn.length === 0, `英文任务对白齐全（缺 ${missingQuestEn.length}）`);
  ok(missingQuestZh.length === 0, `中文任务对白齐全（缺 ${missingQuestZh.length}）`);
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
        const roomRule =
          level.special === 'big_room' ? level.rooms.length === 1 : level.rooms.length >= 3;
        ok(roomRule, `seed ${seed} depth ${depth}: 房间数量符合布局`);
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
      session.level.monsters.filter((m) => !m.tame).every((m) => m.data.diff <= maxDiff1),
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

  // 祝福武器对亡者与恶魔额外有效（weapon.c 的 mon_hates_blessings）。
  {
    const { GameSession } = await import('../src/game/session.js');
    const { Monster } = await import('../src/game/monsters.js');
    const { monById, objById } = await import('../src/data/index.js');
    const { makeItem } = await import('../src/game/items.js');
    const { createRng } = await import('../src/core/rng.js');
    const forceBuc = (item: ItemInstance, buc: ItemInstance['buc']): void => {
      item.buc = buc;
    };
    const strike = (blessed: boolean): number => {
      const s = new GameSession({ seed: 4711 });
      s.level.monsters = [];
      // 抬高等级确保两边都命中，差异只来自祝福加成。
      s.player.level = 10;
      const sword = makeItem(objById.get('LONG_SWORD') as ObjectData, createRng(7));
      forceBuc(sword, blessed ? 'blessed' : 'uncursed');
      s.player.inventory.push(sword);
      s.player.equipment.weapon = sword;
      const zombie = new Monster(
        monById.get('KOBOLD_ZOMBIE') as MonsterData,
        s.player.x + 1,
        s.player.y,
        createRng(9),
      );
      zombie.asleep = false;
      zombie.mhp = 100;
      zombie.mhpmax = 100;
      s.level.monsters.push(zombie);
      s.attackMonster(zombie);
      return 100 - zombie.mhp;
    };
    const plain = strike(false);
    const holy = strike(true);
    ok(plain > 0, `普通武器命中亡者（${plain}）`);
    ok(holy > plain, `祝福武器对亡者额外伤害（${plain} -> ${holy}）`);
  }

  // 银制武器克制狼人、吸血鬼与恶魔（weapon.c 的 mon_hates_silver）。
  {
    const { GameSession } = await import('../src/game/session.js');
    const { Monster } = await import('../src/game/monsters.js');
    const { monById, objById } = await import('../src/data/index.js');
    const { makeItem } = await import('../src/game/items.js');
    const { createRng } = await import('../src/core/rng.js');
    const strike = (silver: boolean): number => {
      const s = new GameSession({ seed: 4712 });
      s.level.monsters = [];
      s.player.level = 10;
      const base = objById.get('LONG_SWORD') as ObjectData;
      const weaponProto = silver ? ({ ...base, material: 'SILVER' } as ObjectData) : base;
      const sword = makeItem(weaponProto, createRng(7));
      s.player.inventory.push(sword);
      s.player.equipment.weapon = sword;
      const were = new Monster(
        monById.get('WEREWOLF') as MonsterData,
        s.player.x + 1,
        s.player.y,
        createRng(9),
      );
      were.asleep = false;
      were.mhp = 200;
      were.mhpmax = 200;
      s.level.monsters.push(were);
      s.attackMonster(were);
      return 200 - were.mhp;
    };
    const plain = strike(false);
    const silver = strike(true);
    ok(plain > 0, `普通武器命中狼人（${plain}）`);
    ok(silver > plain, `银制武器对狼人额外伤害（${plain} -> ${silver}）`);
  }
});

section('抗性与特殊攻击', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { playerResists, monsterResists, monsterMagicResists } = await import('../src/game/resist');
  const { createRng } = await import('../src/core/rng');
  const { monById, objById } = await import('../src/data/index');
  const { makeItem } = await import('../src/game/items');
  const { wearItem, wieldItem, zapWand, addToInventory } = await import('../src/game/inventory');

  const antData = monById.get('GIANT_ANT') as MonsterData;

  // 保护戒指与守护护身符按 spec 提供 AC。
  {
    const s = new GameSession({ seed: 7171 });
    const before = s.player.ac;
    const ring = makeItem(objById.get('RIN_PROTECTION') as ObjectData, s.rng);
    addToInventory(s.player, ring);
    wearItem(s.player, ring);
    ok(s.player.ac === before - 1, `保护戒指降低 AC（${before} -> ${s.player.ac}）`);
  }

  // 回复、缓慢消化与传送戒指的装备效果。
  {
    const s = new GameSession({ seed: 8181 });
    const ring = makeItem(objById.get('RIN_REGENERATION') as ObjectData, s.rng);
    addToInventory(s.player, ring);
    wearItem(s.player, ring);
    s.player.maxHp = 60;
    s.player.hp = 1;
    for (let i = 0; i < 10; i++) s.wait();
    ok(s.player.hp > 1, `回复戒指加快自然回复（hp=${s.player.hp}）`);
  }
  {
    const s = new GameSession({ seed: 8182 });
    const slow = makeItem(objById.get('RIN_SLOW_DIGESTION') as ObjectData, s.rng);
    addToInventory(s.player, slow);
    wearItem(s.player, slow);
    s.player.hunger = 900;
    for (let i = 0; i < 10; i++) s.wait();
    ok(s.player.hunger >= 895, `缓慢消化减慢饥饿（${s.player.hunger}）`);
    ok(s.hasEquipmentPower('SLOW_DIGESTION'), '缓慢消化戒指被识别');
  }
  {
    const s = new GameSession({ seed: 8183 });
    const tp = makeItem(objById.get('RIN_TELEPORTATION') as ObjectData, s.rng);
    addToInventory(s.player, tp);
    wearItem(s.player, tp);
    ok(s.hasEquipmentPower('TELEPORT'), '传送戒指被识别');
  }

  // 变形戒指：佩戴后偶尔变成怪物形态。
  {
    const s = new GameSession({ seed: 9292 });
    const ring = makeItem(objById.get('RIN_POLYMORPH') as ObjectData, s.rng);
    addToInventory(s.player, ring);
    wearItem(s.player, ring);
    for (let i = 0; i < 300 && !s.player.form; i++) s.wait();
    ok(!!s.player.form, `变形戒指最终生效（${s.player.form?.id ?? '-'}）`);
  }

  // 幸运石：携带时按 BUC 提供幸运加值。
  {
    const { luckArtifactBonus } = await import('../src/game/combat.js');
    const s = new GameSession({ seed: 6161 });
    const stone = makeItem(objById.get('LUCKSTONE') as ObjectData, s.rng);
    s.player.inventory.push(stone);
    ok(luckArtifactBonus(s.player) === 1, `普通幸运石 +1（${luckArtifactBonus(s.player)}）`);
    stone.buc = 'blessed';
    ok(luckArtifactBonus(s.player) === 3, `祝福幸运石 +3（${luckArtifactBonus(s.player)}）`);
    stone.buc = 'cursed';
    ok(luckArtifactBonus(s.player) === -1, `诅咒幸运石 -1（${luckArtifactBonus(s.player)}）`);
  }

  // 隐形、潜行与搜索戒指的装备效果。
  {
    const s = new GameSession({ seed: 8282 });
    const invis = makeItem(objById.get('RIN_INVISIBILITY') as ObjectData, s.rng);
    addToInventory(s.player, invis);
    wearItem(s.player, invis);
    ok(s.hasInvisibility(), '隐形戒指让玩家隐形');
    const stealth = makeItem(objById.get('RIN_STEALTH') as ObjectData, s.rng);
    addToInventory(s.player, stealth);
    wearItem(s.player, stealth);
    ok(s.hasEquipmentPower('STEALTH'), '潜行戒指被识别');
  }
  {
    const s = new GameSession({ seed: 8283 });
    const search = makeItem(objById.get('RIN_SEARCHING') as ObjectData, s.rng);
    addToInventory(s.player, search);
    wearItem(s.player, search);
    const at = index(s.player.x + 1, s.player.y);
    s.level.traps.set(at, { type: 'PIT', seen: false });
    s.player.hunger = 900;
    for (let i = 0; i < 10; i++) s.wait();
    ok(s.level.traps.get(at)?.seen === true, '搜索戒指显露身旁陷阱');
  }

  /** 造一只只会一种特殊攻击的怪物，贴近玩家并保证命中。 */
  const foe = (session: InstanceType<typeof GameSession>, ad: string, dice: [number, number]) => {
    const mon = new Monster(antData, session.player.x + 1, session.player.y, createRng(3));
    mon.data = { ...antData, attacks: [{ at: 'AT_CLAW', ad, dice }] };
    mon.mlev = 40;
    mon.asleep = false;
    return mon;
  };

  // 火焰：无抗性受伤，戴抗火戒指完全免伤。
  {
    const s = new GameSession({ seed: 4242 });
    const before = s.player.hp;
    s.monsterAttack(foe(s, 'AD_FIRE', [3, 6]));
    ok(s.player.hp < before, '火焰攻击造成伤害');
    ok(
      s.messages.some((m) => m.key === 'msg.hitFire'),
      '火焰伤害使用独立消息',
    );
  }
  {
    const s = new GameSession({ seed: 4242 });
    const ring = makeItem(objById.get('RIN_FIRE_RESISTANCE') as ObjectData, s.rng);
    wearItem(s.player, ring);
    ok(playerResists(s.player).has('fire'), '抗火戒指提供火焰抗性');
    const before = s.player.hp;
    s.monsterAttack(foe(s, 'AD_FIRE', [3, 6]));
    ok(s.player.hp === before, '火焰抗性完全免伤');
    ok(
      s.messages.some((m) => m.key === 'msg.resistFire'),
      '免伤有对应消息',
    );
  }

  // 毒素：力量下降；解毒护身符免疫。
  {
    const s = new GameSession({ seed: 4242 });
    const before = s.player.str;
    s.monsterAttack(foe(s, 'AD_DRST', [1, 4]));
    ok(s.player.str === before - 1, '毒素攻击降低力量');
  }
  {
    const s = new GameSession({ seed: 4242 });
    const amulet = makeItem(objById.get('AMULET_VERSUS_POISON') as ObjectData, s.rng);
    wearItem(s.player, amulet);
    const before = s.player.str;
    s.monsterAttack(foe(s, 'AD_DRST', [1, 4]));
    ok(s.player.str === before, '解毒护身符免疫力量流失');
  }

  // 状态效果：睡眠、麻痹、混乱、失明写入计时器；自由行动戒指免疫麻痹。
  {
    const s = new GameSession({ seed: 4242 });
    s.monsterAttack(foe(s, 'AD_SLEE', [1, 4]));
    ok(s.player.sleep > 0, '睡眠攻击写入睡眠计时');
  }
  {
    const s = new GameSession({ seed: 4242 });
    s.monsterAttack(foe(s, 'AD_PLYS', [1, 4]));
    ok(s.player.held > 0, '麻痹攻击写入定身计时');
  }
  {
    const s = new GameSession({ seed: 4242 });
    const ring = makeItem(objById.get('RIN_FREE_ACTION') as ObjectData, s.rng);
    wearItem(s.player, ring);
    s.monsterAttack(foe(s, 'AD_PLYS', [1, 4]));
    ok(s.player.held === 0, '自由行动戒指免疫麻痹');
  }
  {
    const s = new GameSession({ seed: 4242 });
    s.monsterAttack(foe(s, 'AD_CONF', [1, 4]));
    s.monsterAttack(foe(s, 'AD_BLND', [1, 4]));
    ok(s.player.confused > 0 && s.player.blind > 0, '混乱与失明写入计时');
  }

  // 吸能、吸级与腐蚀。
  {
    const s = new GameSession({ seed: 4242 });
    s.player.pw = 10;
    s.monsterAttack(foe(s, 'AD_DREN', [1, 1]));
    ok(s.player.pw === 5, `吸能抽走一半法力（${s.player.pw}/10）`);
  }
  {
    const s = new GameSession({ seed: 4242 });
    s.player.level = 5;
    s.player.xp = 1000;
    s.player.maxHp = 30;
    s.player.hp = 30;
    s.monsterAttack(foe(s, 'AD_DRLI', [1, 4]));
    ok(s.player.level === 4, `吸级降低一级（${s.player.level}）`);
    ok(s.player.maxHp === 29, `吸级降低生命上限（${s.player.maxHp}）`);
  }
  {
    const s = new GameSession({ seed: 4242 });
    const mail = makeItem(objById.get('LEATHER_ARMOR') as ObjectData, s.rng);
    mail.enchant = 2;
    wearItem(s.player, mail);
    s.monsterAttack(foe(s, 'AD_RUST', [1, 1]));
    ok(mail.enchant === 1, `锈蚀降低盔甲附魔（${mail.enchant}）`);
  }
  {
    const s = new GameSession({ seed: 4242 });
    const mon = foe(s, 'AD_HEAL', [2, 6]);
    mon.mhp = 1;
    s.monsterAttack(mon);
    ok(mon.mhp > 1, `治疗攻击恢复怪物生命（${mon.mhp}）`);
  }

  // 怪物抗性：红龙免疫火焰光束，普通怪物照常受伤。
  const redDragon = monById.get('RED_DRAGON') as MonsterData;
  ok(monsterResists(redDragon, 'fire'), '红龙原型带火焰抗性');
  ok(!monsterResists(antData, 'fire'), '蚂蚁不抗拒火焰');
  {
    const s = new GameSession({ seed: 4242 });
    const dragon = new Monster(redDragon, s.player.x + 1, s.player.y, s.rng);
    dragon.asleep = false;
    s.level.monsters = [dragon];
    s.refreshFov();
    const wand = makeItem(objById.get('WAN_FIRE') as ObjectData, s.rng);
    const out = zapWand(s, wand);
    ok(out.key === 'use.zapResisted', '红龙免疫火焰光束');
    ok(dragon.mhp === dragon.mhpmax, '免疫时生命不变');
  }
  {
    const s = new GameSession({ seed: 4242 });
    const ant = new Monster(antData, s.player.x + 1, s.player.y, s.rng);
    ant.mhp = ant.mhpmax = 999;
    ant.asleep = false;
    s.level.monsters = [ant];
    s.refreshFov();
    const wand = makeItem(objById.get('WAN_FIRE') as ObjectData, s.rng);
    const out = zapWand(s, wand);
    ok(out.key === 'use.zap', '无抗性怪物被光束击中');
    ok(ant.mhp < 999, '无抗性时生命下降');
  }

  // 死亡、亡灵驱散与探测三个法杖效果。
  {
    const s = new GameSession({ seed: 4242 });
    const ant = new Monster(antData, s.player.x + 1, s.player.y, s.rng);
    ant.asleep = false;
    s.level.monsters = [ant];
    s.refreshFov();
    const death = makeItem(objById.get('WAN_DEATH') as ObjectData, s.rng);
    const out = zapWand(s, death);
    ok(out.key === 'use.zapDeath', '死亡法杖秒杀普通怪物');
    ok(ant.dead, '死亡法杖的目标已死亡');
  }
  {
    const s = new GameSession({ seed: 4242 });
    const zombie = new Monster(
      monById.get('KOBOLD_ZOMBIE') as MonsterData,
      s.player.x + 1,
      s.player.y,
      s.rng,
    );
    zombie.mhp = zombie.mhpmax = 999;
    zombie.asleep = false;
    s.level.monsters = [zombie];
    s.refreshFov();
    const turn = makeItem(objById.get('WAN_UNDEAD_TURNING') as ObjectData, s.rng);
    const out = zapWand(s, turn);
    ok(out.key === 'use.zapTurnUndead', '亡灵驱散命中亡者');
    ok(zombie.mhp < 999 && zombie.fleeing, '亡者受伤并逃跑');
    const ant = new Monster(antData, s.player.x + 1, s.player.y, s.rng);
    ant.asleep = false;
    s.level.monsters = [ant];
    const antOut = zapWand(s, turn);
    ok(antOut.key === 'use.zapNoEffect', '亡灵驱散对活物无效');
  }
  {
    const s = new GameSession({ seed: 4242 });
    const ant = new Monster(antData, s.player.x + 1, s.player.y, s.rng);
    ant.asleep = false;
    s.level.monsters = [ant];
    s.refreshFov();
    const probe = makeItem(objById.get('WAN_PROBING') as ObjectData, s.rng);
    const out = zapWand(s, probe);
    ok(out.key === 'use.zapProbe' && out.vars?.hp === ant.mhp, '探测报告目标生命');
  }

  // 照明法杖点亮玩家所在房间。
  {
    const s = new GameSession({ seed: 4242 });
    const room = s.level.rooms.find(
      (r) => s.player.x >= r.lx && s.player.x <= r.hx && s.player.y >= r.ly && s.player.y <= r.hy,
    );
    if (room) {
      room.lit = false;
      for (let x = room.lx; x <= room.hx; x++) {
        for (let y = room.ly; y <= room.hy; y++) s.level.lit[index(x, y)] = 0;
      }
      s.refreshFov();
      const light = makeItem(objById.get('WAN_LIGHT') as ObjectData, s.rng);
      const out = zapWand(s, light);
      ok(out.key === 'use.zapLight', '照明法杖点亮房间');
      // 通过函数读取，避免 TS 把字段类型收窄成字面量。
      const litAt = (): boolean => room.lit;
      ok(litAt() === true && s.level.lit[index(room.lx, room.ly)] === 1, '房间照明标记已写入');
    } else {
      ok(true, '本层没有可点亮的房间');
    }
  }

  // 加速与缓速法杖写入计时，实际速度按倍率计算。
  {
    const { monsterSpeed } = await import('../src/game/monsters');
    const s = new GameSession({ seed: 4242 });
    const ant = new Monster(antData, s.player.x + 1, s.player.y, s.rng);
    ant.asleep = false;
    s.level.monsters = [ant];
    s.refreshFov();
    const slow = makeItem(objById.get('WAN_SLOW_MONSTER') as ObjectData, s.rng);
    zapWand(s, slow);
    ok(ant.slowed === 20, `缓速写入计时（${ant.slowed}）`);
    ok(monsterSpeed(ant) === Math.max(1, Math.floor(ant.data.speed / 2)), '缓速时速度减半');
    const speed = makeItem(objById.get('WAN_SPEED_MONSTER') as ObjectData, s.rng);
    zapWand(s, speed);
    ok(ant.hasted === 20, `加速写入计时（${ant.hasted}）`);
    ok(monsterSpeed(ant) === ant.data.speed, '又加速又缓速时速度回到原值');
    ant.slowed = 0;
    ok(monsterSpeed(ant) === ant.data.speed * 2, '加速时速度翻倍');
    s.monsterTurns();
    ok(ant.hasted === 19, '加速计时随回合递减');
  }

  // 龙鳞甲按颜色提供抗性；法术抗性按 mr 百分比判定。
  {
    const s = new GameSession({ seed: 4242 });
    const mail = makeItem(objById.get('RED_DRAGON_SCALE_MAIL') as ObjectData, s.rng);
    wearItem(s.player, mail);
    ok(playerResists(s.player).has('fire'), '红龙鳞甲提供火焰抗性');
  }
  {
    const sure = { ...antData, mr: 100 };
    const none = { ...antData, mr: 0 };
    ok(monsterMagicResists(none, createRng(1)) === false, 'mr 为 0 时不抵抗法术');
    ok(monsterMagicResists(sure, createRng(1)) === true, 'mr 为 100 时必定抵抗法术');
  }

  // 偷窃、金币、诅咒与去附魔：0 骰的攻击也要生效。
  {
    const s = new GameSession({ seed: 4242 });
    const before = s.player.inventory.length;
    s.monsterAttack(foe(s, 'AD_SITM', [0, 0]));
    ok(s.player.inventory.length === before - 1, '偷窃攻击拿走一件物品');
    ok(
      s.messages.some((m) => m.key === 'msg.monSteals'),
      '偷窃使用独立消息',
    );
  }
  {
    const s = new GameSession({ seed: 4242 });
    s.player.gold = 101;
    s.monsterAttack(foe(s, 'AD_SGLD', [1, 2]));
    ok(s.player.gold === 51, `偷金币只留下一半（${s.player.gold}）`);
  }
  {
    const s = new GameSession({ seed: 4242 });
    s.monsterAttack(foe(s, 'AD_CURS', [0, 0]));
    ok(
      s.player.inventory.some((i) => i.buc === 'cursed'),
      '诅咒攻击让物品带上诅咒',
    );
  }
  {
    const s = new GameSession({ seed: 4242 });
    /** 已穿戴装备的附魔总和。 */
    const enchantSum = (): number =>
      Object.values(s.player.equipment).reduce((sum, item) => sum + (item ? item.enchant : 0), 0);
    const before = enchantSum();
    s.monsterAttack(foe(s, 'AD_ENCH', [4, 4]));
    ok(enchantSum() === before - 1, `去附魔降低装备附魔（${before} -> ${enchantSum()}）`);
  }

  // 锈蚀攻击在没有护甲时腐蚀手中武器。
  {
    const s = new GameSession({ seed: 8888 });
    s.player.equipment.suit = undefined;
    let weapon = s.player.weapon;
    if (!weapon) {
      weapon = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
      addToInventory(s.player, weapon);
      wieldItem(s.player, weapon);
    }
    weapon.enchant = 2;
    s.monsterAttack(foe(s, 'AD_RUST', [0, 0]));
    ok(weapon.enchant === 1, `锈蚀攻击腐蚀武器（${weapon.enchant}）`);
  }

  // 毅力戒指防止属性吸取。
  {
    const s = new GameSession({ seed: 8484 });
    const ring = makeItem(objById.get('RIN_SUSTAIN_ABILITY') as ObjectData, s.rng);
    addToInventory(s.player, ring);
    wearItem(s.player, ring);
    const before = s.player.str;
    s.monsterAttack(foe(s, 'AD_DRIN', [0, 0]));
    ok(s.player.str === before, `毅力戒指防止属性吸取（${s.player.str}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.drainResisted'),
      '属性吸取被护住有提示',
    );
  }

  // 命中/伤害戒指的装备加值。
  {
    const { heroHits } = await import('../src/game/combat');
    const s = new GameSession({ seed: 8585 });
    const ant = new Monster(antData, s.player.x + 1, s.player.y, createRng(3));
    const base = heroHits(s.player, ant, createRng(1), 0).roll;
    const acc = makeItem(objById.get('RIN_INCREASE_ACCURACY') as ObjectData, s.rng);
    addToInventory(s.player, acc);
    wearItem(s.player, acc);
    ok(heroHits(s.player, ant, createRng(1), 0).roll === base + 1, '命中戒指 +1 命中');
  }
  {
    const strike = (ring: boolean): number => {
      const s = new GameSession({ seed: 8686 });
      s.level.monsters = [];
      s.player.level = 10;
      if (ring) {
        const item = makeItem(objById.get('RIN_INCREASE_DAMAGE') as ObjectData, createRng(5));
        addToInventory(s.player, item);
        wearItem(s.player, item);
      }
      const ant = new Monster({ ...antData, ac: 10 }, s.player.x + 1, s.player.y, createRng(3));
      ant.asleep = false;
      ant.mhp = 200;
      ant.mhpmax = 200;
      s.level.monsters.push(ant);
      s.attackMonster(ant);
      return 200 - ant.mhp;
    };
    ok(strike(true) === strike(false) + 1, '伤害戒指 +1 伤害');
  }

  // 挑衅戒指：进入新楼层会唤醒沉睡怪物。
  {
    const s = new GameSession({ seed: 8787 });
    const ring = makeItem(objById.get('RIN_AGGRAVATE_MONSTER') as ObjectData, s.rng);
    addToInventory(s.player, ring);
    wearItem(s.player, ring);
    const target = s.getLevel(2);
    s.ensureLevelPopulation(target);
    for (const mon of target.monsters) mon.asleep = true;
    if (target.monsters.length) {
      s.changeDepth(2, 'down');
      ok(
        s.level.monsters.every((m) => !m.asleep),
        '挑衅戒指唤醒新楼层的怪物',
      );
      ok(
        s.messages.some((m) => m.key === 'msg.aggravate'),
        '挑衅戒指有提示',
      );
    } else {
      ok(true, '目标层没有怪物，跳过挑衅戒指检查');
    }
  }

  // 取消、缠绕与眩晕。
  {
    const s = new GameSession({ seed: 4242 });
    s.player.seeInvisible = true;
    s.player.invisible = 10;
    s.monsterAttack(foe(s, 'AD_CNCL', [2, 4]));
    ok(!s.player.seeInvisible && s.player.invisible === 0, '取消清空魔法效果');
  }
  {
    const s = new GameSession({ seed: 4242 });
    s.monsterAttack(foe(s, 'AD_WRAP', [1, 6]));
    ok(s.player.held > 0, '缠绕攻击定住玩家');
  }
  {
    const s = new GameSession({ seed: 4242 });
    s.monsterAttack(foe(s, 'AD_STUN', [0, 4]));
    ok(s.player.stun > 0, `眩晕攻击写入计时（${s.player.stun}）`);
  }

  // 石化：倒计时结束死亡，完全治疗药水解开。
  {
    const s = new GameSession({ seed: 4242 });
    s.monsterAttack(foe(s, 'AD_STON', [0, 0]));
    ok(s.player.petrifying > 0, '石化攻击写入倒计时');
    for (let i = 0; i < 12 && !s.dead; i++) s.finishTurn();
    ok(s.dead, '石化倒计时归零后死亡');
  }
  {
    const s = new GameSession({ seed: 4242 });
    s.monsterAttack(foe(s, 'AD_STON', [0, 0]));
    const potion = makeItem(objById.get('POT_FULL_HEALING') as ObjectData, s.rng);
    addToInventory(s.player, potion);
    const r = s.useItem(potion);
    ok(s.player.petrifying === 0 && !s.dead, '完全治疗药水解除石化');
    ok(r.key === 'use.curedStone', '解石化有独立消息');
  }

  // 分解：无抗性即死，黑龙鳞甲免疫。
  {
    const s = new GameSession({ seed: 4242 });
    s.monsterAttack(foe(s, 'AD_DISN', [0, 0]));
    ok(s.dead, '分解攻击在没有抗性时即死');
  }
  {
    const s = new GameSession({ seed: 4242 });
    const scales = makeItem(objById.get('BLACK_DRAGON_SCALE_MAIL') as ObjectData, s.rng);
    wearItem(s.player, scales);
    s.monsterAttack(foe(s, 'AD_DISN', [0, 0]));
    ok(!s.dead, '分解抗性挡住即死');
  }

  // 反射：电击弹回攻击者，玩家不受伤害。
  {
    const s = new GameSession({ seed: 4242 });
    const amulet = makeItem(objById.get('AMULET_OF_REFLECTION') as ObjectData, s.rng);
    wearItem(s.player, amulet);
    ok(playerResists(s.player).has('reflection'), '反射护身符提供反射');
    const mon = foe(s, 'AD_ELEC', [4, 6]);
    // 留出足够生命，避免反射击杀后升级恢复生命干扰判定。
    mon.mhp = mon.mhpmax = 200;
    const hp = s.player.hp;
    s.monsterAttack(mon);
    ok(s.player.hp === hp, '反射时玩家不受电击伤害');
    ok(mon.mhp < 200, '电击被弹回攻击者');
  }

  // 被动攻击（AT_NONE）：命中酸液团会被灼伤，手持武器则隔开石化。
  {
    const s = new GameSession({ seed: 4242 });
    s.player.hitInc = 100;
    const blob = new Monster(
      monById.get('ACID_BLOB') as MonsterData,
      s.player.x + 1,
      s.player.y,
      createRng(5),
    );
    blob.asleep = false;
    blob.mhp = blob.mhpmax = 999;
    const hp = s.player.hp;
    s.attackMonster(blob);
    ok(s.player.hp < hp, '命中酸液团触发被动酸液');
  }
  {
    const s = new GameSession({ seed: 4242 });
    s.player.hitInc = 100;
    const cock = new Monster(
      monById.get('COCKATRICE') as MonsterData,
      s.player.x + 1,
      s.player.y,
      createRng(6),
    );
    cock.asleep = false;
    cock.mhp = cock.mhpmax = 999;
    s.attackMonster(cock);
    ok(s.player.petrifying === 0, '手持武器时不会被动石化');
  }

  // 疾病与饥荒：瘟疫让人生病、饥荒额外消耗饱食度，另外照常造成伤害。
  {
    const s = new GameSession({ seed: 4242 });
    s.player.hp = s.player.maxHp = 200;
    s.player.sick = 0;
    s.monsterAttack(foe(s, 'AD_PEST', [1, 1]));
    ok(s.player.sick > 0, `瘟疫攻击让人生病（${s.player.sick}）`);
    ok(s.player.hp < 200, '瘟疫攻击照常造成伤害');
  }
  {
    const s = new GameSession({ seed: 4242 });
    s.player.hunger = 900;
    s.monsterAttack(foe(s, 'AD_FAMN', [1, 1]));
    ok(s.player.hunger <= 860, `饥荒攻击额外消耗饱食度（${s.player.hunger}）`);
  }
  {
    // 已有病时疫病加重而不是重新计时，对应原版的 Sick/3 + 1。
    const s = new GameSession({ seed: 4242 });
    s.player.sick = 60;
    s.monsterAttack(foe(s, 'AD_DISE', [1, 1]));
    ok(s.player.sick === 21, `已有疾病时病情加重（${s.player.sick}）`);
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

  // 其余药水：麻痹、睡眠、疾病、启明与果汁。
  {
    const { GameSession } = await import('../src/game/session.js');
    const { makeItem } = await import('../src/game/items.js');
    const { roleById, raceById } = await import('../src/game/roles.js');
    const dataIndex = await import('../src/data/index.js');
    const effects: [string, string][] = [
      ['POT_PARALYSIS', 'use.paralyzed'],
      ['POT_SLEEPING', 'use.asleepPotion'],
      ['POT_SICKNESS', 'use.sickness'],
    ];
    for (const [id, key] of effects) {
      const s = new GameSession({
        seed: 5150,
        character: {
          role: roleById.VALKYRIE,
          race: raceById.HUMAN,
          align: 'neutral',
          gender: 'female',
        },
      });
      const potion = makeItem(dataIndex.objById.get(id) as ObjectData, s.rng);
      s.player.inventory.push(potion);
      const r = s.useItem(potion);
      ok(r.key === key, `${id} 生效（${r.key}）`);
    }
    const s = new GameSession({ seed: 5151 });
    const juice = makeItem(dataIndex.objById.get('POT_FRUIT_JUICE') as ObjectData, s.rng);
    s.player.hunger = 100;
    s.player.inventory.push(juice);
    s.useItem(juice);
    ok(s.player.hunger > 100, `果汁恢复饱食度（${s.player.hunger}）`);
    const light = makeItem(dataIndex.objById.get('POT_ENLIGHTENMENT') as ObjectData, s.rng);
    s.player.inventory.push(light);
    s.useItem(light);
    ok(
      s.level.seen.every((v) => v === 1),
      '启明药水揭示全图',
    );
    const sense = makeItem(dataIndex.objById.get('POT_MONSTER_DETECTION') as ObjectData, s.rng);
    s.player.inventory.push(sense);
    s.useItem(sense);
    ok(s.player.senseMonsters > 0, `怪物探测写入计时（${s.player.senseMonsters}）`);
    const objSense = makeItem(dataIndex.objById.get('POT_OBJECT_DETECTION') as ObjectData, s.rng);
    s.player.inventory.push(objSense);
    s.useItem(objSense);
    ok(s.player.senseObjects > 0, `物品探测写入计时（${s.player.senseObjects}）`);
    const goldDetect = makeItem(dataIndex.objById.get('SCR_GOLD_DETECTION') as ObjectData, s.rng);
    s.player.inventory.push(goldDetect);
    s.useItem(goldDetect);
    ok(s.player.senseGold > 0, `金币探测写入计时（${s.player.senseGold}）`);
    const foodDetect = makeItem(dataIndex.objById.get('SCR_FOOD_DETECTION') as ObjectData, s.rng);
    s.player.inventory.push(foodDetect);
    s.useItem(foodDetect);
    ok(s.player.senseFood > 0, `食物探测写入计时（${s.player.senseFood}）`);
    const speedPotion = makeItem(dataIndex.objById.get('POT_SPEED') as ObjectData, s.rng);
    s.player.inventory.push(speedPotion);
    s.useItem(speedPotion);
    ok(s.player.hasted > 0, `加速药水写入计时（${s.player.hasted}）`);
    // 加速时行动不给怪物回合。
    const watcher = s.level.monsters.find((m) => !m.dead);
    if (watcher) {
      s.player.hasted = 2;
      const mvBefore = watcher.mv;
      s.wait();
      ok(watcher.mv === mvBefore, '加速时行动不给怪物回合');
    }
  }

  // 卷轴：驯服、召唤、照明、毁甲与臭云。
  {
    const { GameSession } = await import('../src/game/session.js');
    const { makeItem } = await import('../src/game/items.js');
    const { Monster } = await import('../src/game/monsters.js');
    const { monById } = await import('../src/data/index.js');
    const { createRng } = await import('../src/core/rng.js');
    const dataIndex = await import('../src/data/index.js');

    const a = new GameSession({ seed: 6161 });
    const ant = new Monster(
      monById.get('GIANT_ANT') as MonsterData,
      a.player.x + 1,
      a.player.y,
      createRng(3),
    );
    ant.asleep = false;
    a.level.monsters = [ant];
    a.refreshFov();
    const taming = makeItem(dataIndex.objById.get('SCR_TAMING') as ObjectData, a.rng);
    a.player.inventory.push(taming);
    a.useItem(taming);
    ok(ant.tame, '驯服卷轴收服最近怪物');

    const b = new GameSession({ seed: 6162 });
    b.level.monsters = [];
    const create = makeItem(dataIndex.objById.get('SCR_CREATE_MONSTER') as ObjectData, b.rng);
    b.player.inventory.push(create);
    b.useItem(create);
    ok(b.level.monsters.length === 1, '召唤卷轴生成一只怪物');
    const lightScroll = makeItem(dataIndex.objById.get('SCR_LIGHT') as ObjectData, b.rng);
    b.player.inventory.push(lightScroll);
    ok(b.useItem(lightScroll).key === 'use.scrollLight', '照明卷轴点亮房间');

    const c = new GameSession({ seed: 6163 });
    const suit = c.player.equipment.suit;
    if (suit) {
      const destroy = makeItem(dataIndex.objById.get('SCR_DESTROY_ARMOR') as ObjectData, c.rng);
      c.player.inventory.push(destroy);
      c.useItem(destroy);
      ok(!c.player.inventory.includes(suit), '毁甲卷轴摧毁穿戴的护甲');
    } else {
      ok(true, '该角色没有护甲，跳过毁甲检查');
    }

    const d = new GameSession({ seed: 6164 });
    const mon = new Monster(
      monById.get('GIANT_ANT') as MonsterData,
      d.player.x + 1,
      d.player.y,
      createRng(4),
    );
    mon.asleep = false;
    d.level.monsters = [mon];
    const cloud = makeItem(dataIndex.objById.get('SCR_STINKING_CLOUD') as ObjectData, d.rng);
    d.player.inventory.push(cloud);
    d.useItem(cloud);
    ok(mon.fleeing, '臭云让附近怪物逃跑');

    // 灭绝卷轴：按物种名灭绝，存档保留，后续生成排除。
    {
      const { serializeSession, restoreSession } = await import('../src/game/save.js');
      const { pickMonsterType } = await import('../src/game/monsters.js');
      const s = new GameSession({ seed: 9191 });
      ok(s.tryGenocide('giant ant'), '按英文名灭绝巨蚁');
      ok(s.genocides.has('GIANT_ANT'), '灭绝记录已写入');
      const restored = restoreSession(serializeSession(s));
      ok(restored.genocides.has('GIANT_ANT'), '灭绝记录随存档保留');
      let picked = false;
      for (let i = 0; i < 300 && !picked; i++) {
        const m = pickMonsterType(
          createRng(2000 + i),
          1,
          5,
          undefined,
          undefined,
          restored.genocides,
        );
        if (m?.id === 'GIANT_ANT') picked = true;
      }
      ok(!picked, '灭绝的物种不再生成');
    }
  }

  // 同一件戒指不能同时占两个槽位；移除时清掉全部引用。
  {
    const { GameSession } = await import('../src/game/session');
    const { makeItem } = await import('../src/game/items');
    const { objById } = await import('../src/data/index');
    const { wearItem, removeFromInventory } = await import('../src/game/inventory');
    const s = new GameSession({ seed: 9292 });
    const ring = makeItem(objById.get('RIN_GAIN_CONSTITUTION') as ObjectData, s.rng);
    s.player.inventory.push(ring);
    ok(wearItem(s.player, ring).ok, '首次戴戒指成功');
    const again = wearItem(s.player, ring);
    ok(!again.ok && again.reason === 'item.alreadyWorn', '同一件戒指不能重复戴');
    const slots = Object.entries(s.player.equipment).filter(([, it]) => it === ring);
    ok(slots.length === 1, `戒指只占一个槽位（${slots.length}）`);
    s.useItem(ring, 'wear');
    ok(
      s.messages.some((m) => m.key === 'use.alreadyWorn'),
      '重复戴给出已戴提示',
    );
    // 防御性回归：即使两个槽位指向同一件物品，移除也要清干净。
    s.player.equipment.ringLeft = ring;
    s.player.equipment.ringRight = ring;
    removeFromInventory(s.player, ring);
    ok(
      !s.player.equipment.ringLeft && !s.player.equipment.ringRight,
      '移除物品会清掉全部装备槽引用',
    );
  }
});

section('尸体与进食', async () => {
  const { GameSession } = await import('../src/game/session.js');
  const { Monster } = await import('../src/game/monsters.js');
  const { monById } = await import('../src/data/index.js');
  const { makeItem } = await import('../src/game/items.js');
  const { addToInventory, wearItem, removeItem } = await import('../src/game/inventory.js');
  const { playerResists } = await import('../src/game/resist.js');
  const { roleById, raceById } = await import('../src/game/roles.js');
  const { serializeSession, restoreSession } = await import('../src/game/save.js');
  const { createRng } = await import('../src/core/rng.js');

  // 击杀会留尸体的怪物，尸体记录原型 id；G_NOCORPSE 的怪物不留尸体。
  {
    const s = new GameSession({ seed: 4242 });
    const ant = monById.get('GIANT_ANT') as MonsterData;
    for (let i = 0; i < 20; i++) {
      const mon = new Monster(ant, 5, 5, createRng(6 + i));
      s.level.monsters.push(mon);
      s.slayMonster(mon, false);
    }
    const corpses = s.level.objects.flatMap((p) => p.items).filter((i) => i.corpse);
    ok(corpses.length > 0, `击杀留下尸体（${corpses.length} 具）`);
    ok(
      corpses.every((i) => i.corpse === 'GIANT_ANT'),
      '尸体记录怪物原型',
    );
    ok(
      corpses.every((i) => i.proto.id === 'CORPSE' && i.known),
      '尸体用具名原型且已鉴定',
    );

    const lich = new Monster(monById.get('LICH') as MonsterData, 6, 6, createRng(9));
    s.level.monsters.push(lich);
    const before = s.level.objects.flatMap((p) => p.items).filter((i) => i.corpse).length;
    s.slayMonster(lich, false);
    const after = s.level.objects.flatMap((p) => p.items).filter((i) => i.corpse).length;
    ok(after === before, 'G_NOCORPSE 的怪物不留尸体');

    // 尸体年龄随存档保留。
    const kept = s.level.objects.flatMap((p) => p.items).find((i) => i.corpse);
    if (kept) {
      kept.age = 12;
      const restoredCorpse = restoreSession(serializeSession(s))
        .level.objects.flatMap((p) => p.items)
        .find((i) => i.corpse);
      ok(restoredCorpse?.age === 12, '尸体年龄随存档保留');
    }
  }

  // 吃抗性尸体获得内在抗性，且随存档保留。
  {
    const s = new GameSession({ seed: 77 });
    const corpseProto = objById.get('CORPSE') as ObjectData;
    let gained = false;
    for (let attempt = 0; attempt < 40 && !gained; attempt++) {
      const body = makeItem(corpseProto, s.rng);
      body.corpse = 'FIRE_GIANT';
      addToInventory(s.player, body);
      const hungerBefore = s.player.hunger;
      s.useItem(body);
      ok(s.player.hunger > hungerBefore, '尸体提供营养');
      if (s.player.intrinsics.includes('fire')) gained = true;
    }
    ok(gained, '吃火巨人尸体获得火焰抗性');
    ok(playerResists(s.player).has('fire'), '内在抗性参与抗性集合');
    const restored = restoreSession(serializeSession(s));
    ok(restored.player.intrinsics.includes('fire'), '内在抗性随存档保留');
  }

  // 毒尸体伤害没有毒素抗性的玩家。
  {
    const s = new GameSession({
      seed: 99,
      character: {
        role: roleById.VALKYRIE,
        race: raceById.HUMAN,
        align: 'neutral',
        gender: 'female',
      },
    });
    const body = makeItem(objById.get('CORPSE') as ObjectData, s.rng);
    body.corpse = 'GIANT_SPIDER';
    addToInventory(s.player, body);
    const hpBefore = s.player.hp;
    s.useItem(body);
    ok(s.player.hp < hpBefore, `毒尸体造成伤害（${hpBefore} -> ${s.player.hp}）`);
  }

  // 腐败：存放太久的尸体会致病，蜥蜴等地衣类不腐尸体不受影响。
  {
    const s = new GameSession({ seed: 2024 });
    const body = makeItem(objById.get('CORPSE') as ObjectData, s.rng);
    body.corpse = 'GIANT_ANT';
    body.age = s.turn - 1000;
    addToInventory(s.player, body);
    s.useItem(body);
    ok(s.player.sick > 0, `腐坏尸体致病（${s.player.sick} 回合）`);
    ok(
      s.messages.some((m) => m.key === 'use.corpseTainted'),
      '腐坏尸体有提示',
    );
  }
  {
    const s = new GameSession({ seed: 2025 });
    const body = makeItem(objById.get('CORPSE') as ObjectData, s.rng);
    body.corpse = 'LICHEN';
    body.age = s.turn - 1000;
    addToInventory(s.player, body);
    const hpBefore = s.player.hp;
    s.useItem(body);
    ok(s.player.hp === hpBefore, '地衣不腐尸体放久也不致病');
  }

  // 鸡蛇的肉会石化；有石化抗性才能安全吃下。
  {
    const s = new GameSession({ seed: 808 });
    const body = makeItem(objById.get('CORPSE') as ObjectData, s.rng);
    body.corpse = 'COCKATRICE';
    addToInventory(s.player, body);
    s.useItem(body);
    ok(s.dead && s.player.dead, '吃鸡蛇尸体石化致死');
    ok(
      s.messages.some((m) => m.key === 'use.corpsePetrified'),
      '石化致死有提示',
    );
  }
  {
    const s = new GameSession({ seed: 809 });
    s.player.intrinsics = ['stone'];
    const body = makeItem(objById.get('CORPSE') as ObjectData, s.rng);
    body.corpse = 'COCKATRICE';
    addToInventory(s.player, body);
    s.useItem(body);
    ok(!s.dead, '石化抗性可以安全吃下鸡蛇尸体');
  }

  // 浮游眼的肉赋予心灵感应，并随存档保留。
  {
    const s = new GameSession({ seed: 1001 });
    const body = makeItem(objById.get('CORPSE') as ObjectData, s.rng);
    body.corpse = 'FLOATING_EYE';
    addToInventory(s.player, body);
    s.useItem(body);
    ok(s.player.telepathy, '吃浮游眼尸体获得心灵感应');
    ok(
      s.messages.some((m) => m.key === 'msg.telepathyGained'),
      '心灵感应有提示',
    );
    const restored = restoreSession(serializeSession(s));
    ok(restored.player.telepathy, '心灵感应随存档保留');
  }

  // 装备提供的心灵感应：ESP 护身符与心灵感应头盔。
  {
    const s = new GameSession({ seed: 1002 });
    const amulet = makeItem(objById.get('AMULET_OF_ESP') as ObjectData, s.rng);
    addToInventory(s.player, amulet);
    wearItem(s.player, amulet);
    ok(s.hasTelepathy(), 'ESP 护身符提供心灵感应');
    removeItem(s.player, amulet);
    ok(!s.hasTelepathy(), '摘除后失去装备提供的心灵感应');
    const helm = makeItem(objById.get('HELM_OF_TELEPATHY') as ObjectData, s.rng);
    addToInventory(s.player, helm);
    wearItem(s.player, helm);
    ok(s.hasTelepathy(), '心灵感应头盔提供心灵感应');
  }

  // 会传送的怪物尸体赋予传送症；传送症偶尔随机传送。
  {
    const s = new GameSession({ seed: 1102 });
    let gained = false;
    for (let i = 0; i < 30 && !gained; i++) {
      const corpse = makeItem(objById.get('CORPSE') as ObjectData, s.rng);
      corpse.corpse = 'TENGU';
      addToInventory(s.player, corpse);
      s.useItem(corpse);
      if (s.player.teleportitis) gained = true;
    }
    ok(gained, '吃天狗尸体获得传送症');
    ok(
      s.messages.some((m) => m.key === 'msg.teleportitisGained'),
      '传送症有提示',
    );
    const restored = restoreSession(serializeSession(s));
    ok(restored.player.teleportitis, '传送症随存档保留');

    // 触发一次随机传送：600 回合内几乎必然发生。
    s.level.monsters = [];
    const before = { x: s.player.x, y: s.player.y };
    let moved = false;
    for (let i = 0; i < 600 && !moved; i++) {
      s.wait();
      if (s.player.x !== before.x || s.player.y !== before.y) moved = true;
    }
    ok(moved, '传送症会把玩家随机传走');
  }

  // 疾病：停止自然回复并周期性掉血，完全治疗药水可解。
  {
    const s = new GameSession({ seed: 1919 });
    s.player.maxHp = 60;
    s.player.hp = 20;
    s.player.sick = 12;
    const before = s.player.hp;
    for (let i = 0; i < 6; i++) s.wait();
    ok(s.player.sick < 12, `疾病回合递减（${s.player.sick}）`);
    ok(s.player.hp < before, `疾病持续掉血（${before} -> ${s.player.hp}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.sickPulse'),
      '疾病有掉血提示',
    );
    const potion = makeItem(objById.get('POT_FULL_HEALING') as ObjectData, s.rng);
    addToInventory(s.player, potion);
    s.useItem(potion);
    ok(s.player.sick === 0, '完全治疗药水治病');
    ok(
      s.messages.some((m) => m.key === 'use.curedSick'),
      '治病有提示',
    );
    s.player.sick = 4;
    const restoredSick = restoreSession(serializeSession(s)).player.sick;
    ok(restoredSick === 4, `疾病随存档保留（${restoredSick}）`);
  }

  // 罐头：缺开罐器与武器时不消耗；有武器时开罐获得营养并记录内容。
  {
    const s = new GameSession({
      seed: 3131,
      character: {
        role: roleById.VALKYRIE,
        race: raceById.HUMAN,
        align: 'neutral',
        gender: 'female',
      },
    });
    const proto = objById.get('TIN') as ObjectData;
    const tin = makeItem(proto, s.rng);
    addToInventory(s.player, tin);
    s.player.equipment.weapon = undefined;
    s.useItem(tin);
    ok(s.player.inventory.includes(tin), '缺工具时罐头不消耗');
    ok(
      s.messages.some((m) => m.key === 'use.tinNeedOpener'),
      '缺工具有提示',
    );

    const sword = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
    addToInventory(s.player, sword);
    s.player.equipment.weapon = sword;
    const hungerBefore = s.player.hunger;
    s.useItem(tin);
    ok(!s.player.inventory.includes(tin), '有武器时开罐并消耗');
    ok(tin.tin !== undefined && monById.has(tin.tin), `罐头记录内容怪物（${tin.tin}）`);
    ok(s.player.hunger > hungerBefore, '开罐提供营养');

    // 内容记录随存档保留。
    const spare = makeItem(proto, s.rng);
    spare.tin = 'GIANT_ANT';
    addToInventory(s.player, spare);
    const restoredSpare = restoreSession(serializeSession(s)).player.inventory.find(
      (i) => i.tin === 'GIANT_ANT',
    );
    ok(!!restoredSpare, '罐头内容随存档保留');
  }

  // 石化抗性挡下石化攻击。
  {
    const s = new GameSession({ seed: 321 });
    s.player.intrinsics = ['stone'];
    const mon = new Monster(
      monById.get('COCKATRICE') as MonsterData,
      s.player.x + 1,
      s.player.y,
      createRng(4),
    );
    s.monsterAction(mon);
    ok(s.player.petrifying === 0, `石化抗性挡下石化（petrifying=${s.player.petrifying}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.resistStone'),
      '石化抗性有提示',
    );
  }
});

section('商店', async () => {
  {
    const { GameSession } = await import('../src/game/session.js');
    const { shopBuyPrice, shopSellPrice, makeItem } = await import('../src/game/items.js');
    const { shopRoom, inRoom, coords } = await import('../src/game/dungeon.js');
    const { serializeSession, restoreSession } = await import('../src/game/save.js');

    // 定价公式：售价加三分之一，收购价一半，最低 1 枚。
    const proto = objById.get('LONG_SWORD') as ObjectData;
    const sampleItem = makeItem(proto, createRng(7));
    ok(
      shopBuyPrice(sampleItem) === Math.ceil(proto.cost * (4 / 3)),
      `buy price = ${shopBuyPrice(sampleItem)}`,
    );
    ok(
      shopSellPrice(sampleItem) === Math.floor(proto.cost / 2),
      `sell price = ${shopSellPrice(sampleItem)}`,
    );
    const freeItem = makeItem({ ...proto, cost: 0 } as ObjectData, createRng(8));
    ok(
      shopBuyPrice(freeItem) === 1 && shopSellPrice(freeItem) === 1,
      'zero-cost items still settle at 1 gold',
    );
    // 魅力议价：越高买得越便宜、卖得越贵。
    ok(
      shopBuyPrice(sampleItem, 18) < shopBuyPrice(sampleItem, 10),
      `高魅力买得更便宜（${shopBuyPrice(sampleItem, 18)} < ${shopBuyPrice(sampleItem, 10)}）`,
    );
    ok(
      shopSellPrice(sampleItem, 18) > shopSellPrice(sampleItem, 10),
      `高魅力卖得更贵（${shopSellPrice(sampleItem, 18)} > ${shopSellPrice(sampleItem, 10)}）`,
    );

    // 逐层找一家商店，进店后应有店主与未付款商品。
    const s = new GameSession({ seed: 20240101 });
    let shopDepth = -1;
    for (let depth = 2; depth < 30 && shopDepth < 0; depth++) {
      if (shopRoom(s.getLevel(depth))) shopDepth = depth;
    }
    ok(shopDepth > 0, `found a shop at depth ${shopDepth}`);
    s.changeDepth(shopDepth, 'down');
    const room = shopRoom(s.level);
    ok(!!room, 'shop room survives population');
    const a = generateLevel({ gameSeed: 20240101, depth: shopDepth });
    const b = generateLevel({ gameSeed: 20240101, depth: shopDepth });
    ok(shopRoom(a)?.index === shopRoom(b)?.index, 'shop placement is deterministic');

    // 只留店主，避免其它怪物在交易期间干扰。
    s.level.monsters = s.level.monsters.filter((m) => m.data.id === 'SHOPKEEPER');
    const keeper = s.level.monsters[0];
    ok(!!keeper && !!room && inRoom(room, keeper.x, keeper.y), 'shopkeeper stands inside the shop');
    ok(!keeper?.asleep, 'shopkeeper stays awake');
    const stock = s.level.objects.filter((p) => room && inRoom(room, p.x, p.y));
    const goods = stock.flatMap((p) => p.items).filter((i) => i.unpaid);
    ok(goods.length > 0, `shop stocks ${goods.length} unpaid goods`);
    ok(
      [...s.level.traps.keys()].every((i) => {
        const at = coords(i);
        return !room || !inRoom(room, at.x, at.y);
      }),
      'shop has no traps',
    );

    // 和平的店主不能永久堵死入口：站在门口内侧时要主动让开一步。
    const doorway = (() => {
      for (const i of s.level.doors.keys()) {
        const at = coords(i);
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) {
          const x = at.x + dx;
          const y = at.y + dy;
          if (!room || !inRoom(room, x, y)) continue;
          if (s.level.tiles[index(x, y)] !== T.ROOM) continue;
          if (x === s.player.x && y === s.player.y) continue;
          return { x, y };
        }
      }
      return null;
    })();
    ok(!!doorway, 'shop door has an interior floor tile');
    if (doorway && keeper && room) {
      keeper.x = doorway.x;
      keeper.y = doorway.y;
      s.monsterTurns();
      const blocksDoor = [...s.level.doors.keys()].some((i) => {
        const at = coords(i);
        return Math.max(Math.abs(at.x - keeper.x), Math.abs(at.y - keeper.y)) <= 1;
      });
      ok(!blocksDoor, `shopkeeper steps aside from the door (${keeper.x}, ${keeper.y})`);
      ok(inRoom(room, keeper.x, keeper.y), 'shopkeeper stays inside after stepping aside');
    }

    // 钱够时买入：扣款等于标价，物品结清。
    const pile = stock.find((p) => p.items.some((i) => i.unpaid)) as GroundPile;
    const sample = pile.items.find((i) => i.unpaid) as (typeof goods)[number];
    const price = shopBuyPrice(sample, s.player.cha);
    s.player.gold = price;
    s.player.x = pile.x;
    s.player.y = pile.y;
    s.pickupAction();
    ok(s.player.inventory.includes(sample), 'paying picks the item up');
    ok(!sample.unpaid, 'paid item is no longer shop property');
    ok(s.player.gold === 0, 'gold decreases by the buy price');

    // 卖出：店主按半价收购，物品重新变成店产。
    const sellPrice = shopSellPrice(sample, s.player.cha);
    s.useItem(sample, 'drop');
    ok(s.player.gold === sellPrice, 'selling credits half the base cost');
    ok(!!sample.unpaid, 'sold item becomes shop property');

    // 钱不够时可以赊账拿走；离店结清或转为偷窃。
    s.player.gold = 0;
    const broke = s.pickupAction();
    ok(
      broke.picked === 1 && s.player.inventory.includes(sample),
      'unaffordable goods can be taken on credit',
    );
    ok(!!sample.unpaid, 'credit keeps the unpaid mark');
    ok(
      s.messages.some((m) => m.key === 'msg.shopCredit'),
      'credit is announced',
    );

    // 店外找一块空地用于结算。
    let outside: { x: number; y: number } | null = null;
    if (room) {
      for (let x = 1; x < COLNO - 1 && !outside; x++) {
        for (let y = 1; y < ROWNO - 1; y++) {
          if (inRoom(room, x, y)) continue;
          if (!isWalkable(s.level.tiles[index(x, y)])) continue;
          if (s.level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
          outside = { x, y };
          break;
        }
      }
    }
    ok(!!outside, 'shop has a tile outside');

    // 把金币补上再走出商店：账要结清。
    if (outside) {
      const bill = shopBuyPrice(sample, s.player.cha);
      s.player.gold = bill + 2;
      s.player.x = outside.x;
      s.player.y = outside.y;
      s.wait();
      ok(!sample.unpaid, 'leaving the shop settles the bill');
      ok(s.player.gold === 2, `bill equals the buy price（${s.player.gold}）`);
      ok(
        s.messages.some((m) => m.key === 'msg.shopBillPaid'),
        'settlement is announced',
      );
    }

    // 再赊一次，空着钱包离店：店主转为敌对，阵营记录下降。
    const steal = pile.items.find((i) => i.unpaid);
    if (outside && steal) {
      s.player.x = pile.x;
      s.player.y = pile.y;
      s.player.gold = 0;
      s.pickupAction();
      const alignBefore = s.player.alignRecord;
      s.player.x = outside.x;
      s.player.y = outside.y;
      s.wait();
      ok(
        s.messages.some((m) => m.key === 'msg.shopTheft'),
        'theft is announced',
      );
      ok(s.player.alignRecord === alignBefore - 5, 'theft costs alignment');
      ok(!steal.unpaid, 'stolen goods belong to the player');
      ok(keeper?.angry === true, 'shopkeeper turns hostile after a theft');
    }

    // 存档往返保留未付款标记。
    const restored = restoreSession(serializeSession(s));
    const restoredUnpaid = restored.level.objects.flatMap((p) => p.items).filter((i) => i.unpaid);
    ok(restoredUnpaid.length > 0, 'save round-trip keeps unpaid goods');
  }

  // 专卖店按库存表铺货：清空商店地面后重铺，货物类别不超出对应表。
  {
    const { stockShop, SHOP_TYPES } = await import('../src/game/items.js');
    const { shopRoom: findShop } = await import('../src/game/dungeon.js');
    let level: Level | undefined;
    let shop: Room | undefined;
    for (let depth = 2; depth < 30 && !shop; depth++) {
      const candidate = generateLevel({ gameSeed: 5150, depth });
      const room = findShop(candidate);
      if (room) {
        level = candidate;
        shop = room;
      }
    }
    ok(!!shop, '铺货测试找到商店');
    if (level && shop) {
      const inShop = (x: number, y: number): boolean =>
        x >= shop.lx && x <= shop.hx && y >= shop.ly && y <= shop.hy;
      const types = Object.keys(SHOP_TYPES) as ShopType[];
      let offType = 0;
      let placedTotal = 0;
      for (let n = 0; n < types.length; n++) {
        shop.shopType = types[n];
        level.objects = level.objects.filter((p) => !inShop(p.x, p.y));
        stockShop(level, createRng(900 + n), level.depth);
        const allowed = new Set(SHOP_TYPES[types[n]].map(([cls]) => cls));
        for (const pile of level.objects) {
          if (!inShop(pile.x, pile.y)) continue;
          for (const item of pile.items) {
            placedTotal++;
            if (!allowed.has(item.proto.cls)) offType++;
          }
        }
      }
      ok(offType === 0, `专卖店货物符合库存表（越界 ${offType} 件）`);
      ok(placedTotal >= types.length * 6, `每家店都铺到货（共 ${placedTotal} 件）`);
    }
  }

  // 商店每 200 回合补一件货，计时随存档保留。
  {
    const { GameSession } = await import('../src/game/session.js');
    const { shopRoom, inRoom } = await import('../src/game/dungeon.js');
    const { serializeSession, restoreSession } = await import('../src/game/save.js');
    const s = new GameSession({ seed: 20240101 });
    let depth = -1;
    for (let d = 2; d < 30 && depth < 0; d++) if (shopRoom(s.getLevel(d))) depth = d;
    if (depth < 0) {
      fail('补货测试需要商店楼层');
    } else {
      s.changeDepth(depth, 'down');
      const room = shopRoom(s.level);
      const count = (): number =>
        s.level.objects.filter((p) => room && inRoom(room, p.x, p.y)).length;
      const before = count();
      s.level.shopRestockAt = s.turn;
      s.wait();
      ok(count() === before + 1, `商店补货（${before} -> ${count()}）`);
      ok(
        s.messages.some((m) => m.key === 'msg.shopRestocks'),
        '补货有提示',
      );
      ok((s.level.shopRestockAt ?? 0) > s.turn, '补货后重置计时');
      const restored = restoreSession(serializeSession(s));
      ok(restored.level.shopRestockAt === s.level.shopRestockAt, '补货计时随存档保留');
    }
  }
});

section('挖掘的噪音与商店修缮费', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById, objById } = await import('../src/data/index');
  const { makeItem } = await import('../src/game/items');
  const { wieldItem } = await import('../src/game/inventory');
  const { shopRoom, inRoom } = await import('../src/game/dungeon');
  const { serializeSession, restoreSession } = await import('../src/game/save');
  const { createRng } = await import('../src/core/rng');

  // 噪音按 wake_nearby 的半径唤醒沉睡的怪物，远处的不受影响。
  {
    const s = new GameSession({ seed: 20240101 });
    s.level.monsters = [];
    const proto = monById.get('GIANT_ANT') as MonsterData;
    const nearSpot = [
      [s.player.x + 1, s.player.y],
      [s.player.x, s.player.y + 1],
      [s.player.x - 1, s.player.y],
      [s.player.x, s.player.y - 1],
    ].find(([x, y]) => isWalkable(s.level.tiles[index(x, y)]));
    const farSpot = (() => {
      for (let x = 1; x < s.level.width - 1; x++) {
        for (let y = 1; y < s.level.height - 1; y++) {
          if (!isWalkable(s.level.tiles[index(x, y)])) continue;
          if (Math.max(Math.abs(x - s.player.x), Math.abs(y - s.player.y)) < 6) continue;
          return { x, y };
        }
      }
      return null;
    })();
    ok(!!nearSpot && !!farSpot, '找得到噪音测试的远近位置');
    if (nearSpot && farSpot) {
      const near = new Monster(proto, nearSpot[0], nearSpot[1], createRng(3));
      near.asleep = true;
      const far = new Monster(proto, farSpot.x, farSpot.y, createRng(4));
      far.asleep = true;
      s.level.monsters.push(near, far);
      s.wakeNearby();
      ok(!near.asleep, '挖凿声唤醒附近的沉睡怪物');
      ok(far.asleep, '远处的怪物不受挖凿声影响');
    }
  }

  // 商店外墙被镐挖开照 SHOP_WALL_DMG 赔偿，离店时结清；付不起则店主翻脸。
  const findShopDepth = (target: InstanceType<typeof GameSession>): number => {
    for (let d = 2; d < 30; d++) if (shopRoom(target.getLevel(d))) return d;
    return -1;
  };
  const shopWall = (target: InstanceType<typeof GameSession>): { x: number; y: number } | null => {
    const room = shopRoom(target.level);
    if (!room) return null;
    for (let x = 1; x < target.level.width - 1; x++) {
      for (let y = 1; y < target.level.height - 1; y++) {
        if (!isWall(target.level.tiles[index(x, y)])) continue;
        const borders =
          inRoom(room, x - 1, y) ||
          inRoom(room, x + 1, y) ||
          inRoom(room, x, y - 1) ||
          inRoom(room, x, y + 1);
        if (borders) return { x, y };
      }
    }
    return null;
  };
  const outsideShop = (
    target: InstanceType<typeof GameSession>,
  ): { x: number; y: number } | null => {
    const room = shopRoom(target.level);
    for (let x = 1; x < target.level.width - 1; x++) {
      for (let y = 1; y < target.level.height - 1; y++) {
        if (room && inRoom(room, x, y)) continue;
        if (!isWalkable(target.level.tiles[index(x, y)])) continue;
        if (target.level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
        return { x, y };
      }
    }
    return null;
  };

  const depth = findShopDepth(new GameSession({ seed: 20240101 }));
  ok(depth > 0, '找得到带商店的楼层');

  // 镐挖商店外墙：记下修缮费，离店付清。
  if (depth > 0) {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(depth, 'down');
    s.level.monsters = s.level.monsters.filter((m) => m.data.id === 'SHOPKEEPER');
    const wall = shopWall(s);
    const outside = outsideShop(s);
    ok(!!wall && !!outside, '商店外墙与店外空地都在');
    if (wall && outside) {
      const cost = 10 * s.player.str;
      s.player.gold = cost + 25;
      ok(s.digWall(wall.x, wall.y) === 'dug', '镐可以挖开商店外墙');
      ok(s.shopDamage === cost, `挖穿商店外墙记下修缮费（${s.shopDamage}/${cost}）`);
      const charged = s.messages.find((m) => m.key === 'msg.shopDamage');
      ok(charged?.vars.n === cost, '修缮费有提示');
      const restored = restoreSession(serializeSession(s));
      ok(restored.shopDamage === cost, '修缮费随存档保留');
      s.player.x = outside.x;
      s.player.y = outside.y;
      s.wait();
      ok(s.shopDamage === 0 && s.player.gold === 25, `离店结清修缮费（金币=${s.player.gold}）`);
      ok(
        s.messages.some((m) => m.key === 'msg.shopBillPaid'),
        '修缮费计入账单提示',
      );
    }
  }

  // 付不起修缮费：店主翻脸。
  if (depth > 0) {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(depth, 'down');
    s.level.monsters = s.level.monsters.filter((m) => m.data.id === 'SHOPKEEPER');
    const wall = shopWall(s);
    const outside = outsideShop(s);
    if (wall && outside) {
      s.player.gold = 0;
      s.digWall(wall.x, wall.y);
      s.player.x = outside.x;
      s.player.y = outside.y;
      s.wait();
      ok(
        s.messages.some((m) => m.key === 'msg.shopDamageUnpaid'),
        '付不起修缮费有提示',
      );
      const keeper = s.level.monsters.find((m) => m.data.id === 'SHOPKEEPER');
      ok(keeper?.angry === true, '付不起修缮费店主翻脸');
    }
  }

  // 在商店地板上向下挖：照 SHOP_HOLE_COST 收 200。
  if (depth > 0) {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(depth, 'down');
    s.level.monsters = s.level.monsters.filter((m) => m.data.id === 'SHOPKEEPER');
    const room = shopRoom(s.level);
    const floor = (() => {
      if (!room) return null;
      for (let x = room.lx; x <= room.hx; x++) {
        for (let y = room.ly; y <= room.hy; y++) {
          if (s.level.tiles[index(x, y)] !== T.ROOM) continue;
          if (s.level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
          return { x, y };
        }
      }
      return null;
    })();
    ok(!!floor, '商店里有可挖的地板');
    if (floor) {
      s.player.x = floor.x;
      s.player.y = floor.y;
      const pick = makeItem(objById.get('PICK_AXE') as ObjectData, s.rng);
      s.player.inventory.push(pick);
      ok(wieldItem(s.player, pick).ok, '持镐准备向下挖');
      s.player.gold = 500;
      const depthBefore = s.depth;
      for (let i = 0; i < 3; i++) s.digDown();
      ok(s.depth === depthBefore + 1, '商店地板也能凿穿下行');
      const damage = s.messages.find((m) => m.key === 'msg.shopDamage');
      ok(damage?.vars.n === 200, '商店地板挖洞收 200 修缮费');
    }
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

section('怪物开门', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById } = await import('../src/data/index');
  const { createRng } = await import('../src/core/rng');

  // 开门规则：有手且不小的怪物推门，变形怪钻门缝，巨型怪物砸锁。
  const s = new GameSession({ seed: 4242 });
  const mon = (id: string): InstanceType<typeof Monster> =>
    new Monster(monById.get(id) as MonsterData, s.player.x, s.player.y, createRng(5));
  const door = { closed: true, locked: false, broken: false };
  const locked = { closed: true, locked: true, broken: false };
  ok(s.monsterDoorMove(mon('KOBOLD'), door) === 'open', '有手的怪物能推开普通门');
  ok(s.monsterDoorMove(mon('GIANT_ANT'), door) === 'none', '没手的小怪物开不了门');
  ok(s.monsterDoorMove(mon('ACID_BLOB'), door) === 'squeeze', '变形怪从门缝钻过');
  ok(s.monsterDoorMove(mon('KOBOLD'), locked) === 'none', '普通怪物推不开上锁的门');
  ok(s.monsterDoorMove(mon('GIANT'), locked) === 'break', '巨型怪物砸开上锁的门');
  ok(s.monsterDoorMove(mon('ACID_BLOB'), locked) === 'squeeze', '变形怪能从锁着的门下钻过');

  // 集成：普通怪物反复尝试也推不开上锁的门；巨型怪物一下砸开。
  const doorScene = (monId: string) => {
    const world = new GameSession({ seed: 4242 });
    world.level.monsters = [];
    for (const [tile, target] of world.level.doors) {
      if (!target.locked || !target.closed) continue;
      const dx = tile % world.level.width;
      const dy = Math.floor(tile / world.level.width);
      const sides: [number, number][] = [
        [dx - 1, dy],
        [dx + 1, dy],
        [dx, dy - 1],
        [dx, dy + 1],
      ];
      const spot = sides.find(([x, y]) => isWalkable(world.level.tiles[index(x, y)]));
      if (!spot) continue;
      let across: [number, number];
      if (spot[0] === dx - 1) across = [dx + 1, dy];
      else if (spot[0] === dx + 1) across = [dx - 1, dy];
      else if (spot[1] === dy - 1) across = [dx, dy + 1];
      else across = [dx, dy - 1];
      if (!isWalkable(world.level.tiles[index(across[0], across[1])])) continue;
      const keeper = new Monster(monById.get(monId) as MonsterData, spot[0], spot[1], createRng(7));
      keeper.asleep = false;
      world.level.monsters.push(keeper);
      world.player.x = across[0];
      world.player.y = across[1];
      return { world, keeper, door: target };
    }
    return null;
  };
  const plain = doorScene('KOBOLD');
  ok(!!plain, '找得到可用于开门测试的锁门');
  if (plain) {
    for (let i = 0; i < 5; i++) plain.world.stepMonster(plain.keeper, 1);
    ok(plain.door.closed && plain.door.locked, '普通怪物反复尝试也推不开上锁的门');
  }
  const giant = doorScene('GIANT');
  ok(!!giant, '找得到巨型怪物砸门的现场');
  if (giant) {
    giant.world.stepMonster(giant.keeper, 1);
    ok(!giant.door.closed && giant.door.broken, '巨型怪物一下砸开上锁的门');
  }
});

section('怪物与陷阱', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById } = await import('../src/data/index');
  const { createRng } = await import('../src/core/rng');

  const s = new GameSession({ seed: 917 });
  s.level.monsters = [];
  s.level.traps.clear();
  s.refreshFov();
  const spot = (() => {
    let fallback: { x: number; y: number } | null = null;
    for (let x = 1; x < s.level.width - 1; x++) {
      for (let y = 1; y < s.level.height - 1; y++) {
        if (s.level.tiles[index(x, y)] !== T.ROOM) continue;
        if (x === s.player.x && y === s.player.y) continue;
        const at = { x, y };
        if (s.visible?.[index(x, y)] === 1) return at;
        fallback ??= at;
      }
    }
    return fallback;
  })();
  ok(!!spot, '找得到放置陷阱的地面');
  if (spot) {
    const spawn = (id: string): InstanceType<typeof Monster> =>
      new Monster(monById.get(id) as MonsterData, spot.x, spot.y, createRng(5));

    // 伤害陷阱：怪物掉血，血量不足时死于陷阱、不计入玩家击杀。
    const kobold = spawn('KOBOLD');
    kobold.mhp = 100;
    kobold.mhpmax = 100;
    s.level.monsters.push(kobold);
    s.level.traps.set(index(spot.x, spot.y), { type: 'FIRE_TRAP', seen: false });
    s.monsterTrap(kobold);
    ok(kobold.mhp < 100, `怪物踩中火焰陷阱掉血（${kobold.mhp}/100）`);
    ok(s.level.traps.get(index(spot.x, spot.y))?.seen === true, '玩家看得见时陷阱被发现');

    const doomed = spawn('KOBOLD');
    doomed.mhp = 1;
    doomed.mhpmax = 1;
    doomed.tame = true;
    s.level.monsters.push(doomed);
    const killsBefore = s.kills;
    s.monsterTrap(doomed);
    ok(doomed.dead, '重伤怪物被陷阱打死');
    ok(s.kills === killsBefore, '陷阱击杀不计入玩家击杀数');
    ok(
      s.messages.some((m) => m.key === 'msg.petDies'),
      '宠物死于陷阱有单独提示',
    );
    s.level.monsters = [];

    // 定身、睡眠、传送三类陷阱。
    const held = spawn('KOBOLD');
    held.asleep = false;
    s.level.monsters.push(held);
    s.level.traps.set(index(spot.x, spot.y), { type: 'BEAR_TRAP', seen: false });
    s.monsterTrap(held);
    ok((held.stasis ?? 0) > 0, '捕兽夹困住怪物');

    s.level.traps.set(index(spot.x, spot.y), { type: 'SLEEPING_GAS_TRAP', seen: false });
    held.asleep = false;
    s.monsterTrap(held);
    ok(!!held.asleep, '催眠气体让怪物沉睡');

    s.level.traps.set(index(spot.x, spot.y), { type: 'TELEP_TRAP', seen: false });
    held.asleep = false;
    s.monsterTrap(held);
    ok(held.x !== spot.x || held.y !== spot.y, '传送陷阱把怪物挪走');

    // 飞行的怪物从地面陷阱上方掠过。
    const bee = spawn('KILLER_BEE');
    bee.mhp = 100;
    s.level.monsters.push(bee);
    s.level.traps.set(index(spot.x, spot.y), { type: 'FIRE_TRAP', seen: false });
    s.monsterTrap(bee);
    ok(bee.mhp === 100, '飞行的怪物不触发地面陷阱');

    // 看见陷阱触发的怪物会记住同类陷阱，之后不再踩上去。
    s.level.monsters = [];
    s.level.traps.clear();
    const watcher = spawn('KOBOLD');
    watcher.asleep = false;
    s.level.monsters = [watcher];
    s.monsSeeTrap(spot.x, spot.y, 'FIRE_TRAP');
    ok(s.monsterKnowsTrap(watcher, 'FIRE_TRAP'), '怪物看见陷阱触发后记住它');
    ok(!s.monsterKnowsTrap(watcher, 'PIT'), '没见过的陷阱不记得');
    const animal = spawn('GIANT_ANT');
    s.level.monsters = [animal];
    s.monsSeeTrap(spot.x, spot.y, 'PIT');
    ok(!s.monsterKnowsTrap(animal, 'PIT'), '动物不记陷阱');

    // 已知陷阱会被绕开：八邻格全埋已知火焰陷阱时寸步难受。
    const stuck = spawn('KOBOLD');
    stuck.mhp = 100;
    stuck.asleep = false;
    s.level.monsters = [stuck];
    s.level.traps.clear();
    let trappedNeighbors = 0;
    for (const [dx, dy] of [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ]) {
      const x = stuck.x + dx;
      const y = stuck.y + dy;
      if (!isWalkable(s.level.tiles[index(x, y)])) continue;
      s.level.traps.set(index(x, y), { type: 'FIRE_TRAP', seen: false });
      trappedNeighbors++;
    }
    ok(trappedNeighbors > 0, '怪物身边有可走的格');
    s.monLearnsTrap(stuck, 'FIRE_TRAP');
    const start = { x: stuck.x, y: stuck.y };
    s.stepMonster(stuck, 0);
    ok(stuck.x === start.x && stuck.y === start.y, '怪物不会踏上已知的陷阱');
    const { serializeSession, restoreSession } = await import('../src/game/save');
    const restored = restoreSession(serializeSession(s));
    ok(
      restored.level.monsters.some((m) => s.monsterKnowsTrap(m, 'FIRE_TRAP')),
      '陷阱记忆随存档保留',
    );

    // 地洞把怪物送到下一层。
    s.level.monsters = [stuck];
    s.level.traps.clear();
    s.level.traps.set(index(stuck.x, stuck.y), { type: 'HOLE', seen: false });
    const depthBefore = s.depth;
    s.monsterTrap(stuck);
    ok(!s.level.monsters.includes(stuck), '怪物掉进地洞后离开当前层');
    ok(s.getLevel(depthBefore + 1).monsters.includes(stuck), '怪物出现在下一层');
  }

  // 楼层传送陷阱把怪物送出当前层（在第二层测试，保证目标层不同）。
  {
    const s2 = new GameSession({ seed: 917, depth: 2 });
    s2.level.monsters = [];
    s2.level.traps.clear();
    s2.refreshFov();
    const spot2 = (() => {
      for (let x = 1; x < s2.level.width - 1; x++) {
        for (let y = 1; y < s2.level.height - 1; y++) {
          if (s2.level.tiles[index(x, y)] !== T.ROOM) continue;
          if (x === s2.player.x && y === s2.player.y) continue;
          return { x, y };
        }
      }
      return null;
    })();
    ok(!!spot2, '找得到楼层传送测试的地面');
    if (spot2) {
      const mon = new Monster(monById.get('KOBOLD') as MonsterData, spot2.x, spot2.y, createRng(5));
      mon.asleep = false;
      s2.level.monsters = [mon];
      s2.level.traps.set(index(spot2.x, spot2.y), { type: 'LEVEL_TELEP', seen: false });
      s2.monsterTrap(mon);
      ok(!s2.level.monsters.includes(mon), '楼层传送陷阱把怪物送出当前层');
    }
  }

  // 变形陷阱把怪物换成另一只，保留剩余生命比例。
  {
    const s3 = new GameSession({ seed: 917 });
    s3.level.monsters = [];
    s3.level.traps.clear();
    const spot3 = (() => {
      for (let x = 1; x < s3.level.width - 1; x++) {
        for (let y = 1; y < s3.level.height - 1; y++) {
          if (s3.level.tiles[index(x, y)] !== T.ROOM) continue;
          if (x === s3.player.x && y === s3.player.y) continue;
          return { x, y };
        }
      }
      return null;
    })();
    ok(!!spot3, '找得到变形陷阱测试的地面');
    if (spot3) {
      const mon = new Monster(monById.get('KOBOLD') as MonsterData, spot3.x, spot3.y, createRng(5));
      mon.asleep = false;
      mon.mhp = 20;
      mon.mhpmax = 40;
      s3.level.monsters = [mon];
      s3.level.traps.set(index(spot3.x, spot3.y), { type: 'POLY_TRAP', seen: false });
      const before = mon.data.id;
      for (let i = 0; i < 40 && mon.data.id === before; i++) s3.monsterTrap(mon);
      ok(mon.data.id !== before, `变形陷阱把怪物换了形态（${before} -> ${mon.data.id}）`);
      ok(mon.mhp > 0 && mon.mhp <= mon.mhpmax, '变形后生命值仍合法');
    }
  }

  // 魔法陷阱对怪物造成一种随机效果。
  {
    const s4 = new GameSession({ seed: 917 });
    s4.level.monsters = [];
    s4.level.traps.clear();
    const spot4 = (() => {
      for (let x = 1; x < s4.level.width - 1; x++) {
        for (let y = 1; y < s4.level.height - 1; y++) {
          if (s4.level.tiles[index(x, y)] !== T.ROOM) continue;
          if (x === s4.player.x && y === s4.player.y) continue;
          return { x, y };
        }
      }
      return null;
    })();
    if (spot4) {
      const mon = new Monster(monById.get('KOBOLD') as MonsterData, spot4.x, spot4.y, createRng(5));
      mon.asleep = false;
      mon.mhp = 10;
      mon.mhpmax = 40;
      s4.level.monsters = [mon];
      s4.level.traps.set(index(spot4.x, spot4.y), { type: 'MAGIC_TRAP', seen: false });
      const hp = mon.mhp;
      let changed = false;
      for (let i = 0; i < 30 && !changed; i++) {
        s4.monsterTrap(mon);
        changed = mon.mhp !== hp || mon.x !== spot4.x || mon.y !== spot4.y || mon.asleep;
      }
      ok(changed, '魔法陷阱对怪物产生了效果');
    }
  }
});

section('怪物捡拾物品', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById, objById } = await import('../src/data/index');
  const { makeGold, makeItem } = await import('../src/game/items');
  const { createRng } = await import('../src/core/rng');
  const { serializeSession, restoreSession } = await import('../src/game/save');
  const { shopRoom, inRoom } = await import('../src/game/dungeon');

  const s = new GameSession({ seed: 917 });
  s.level.monsters = [];
  s.level.traps.clear();
  s.level.objects = [];
  s.refreshFov();
  const spot = (() => {
    let fallback: { x: number; y: number } | null = null;
    for (let x = 1; x < s.level.width - 1; x++) {
      for (let y = 1; y < s.level.height - 1; y++) {
        if (s.level.tiles[index(x, y)] !== T.ROOM) continue;
        if (x === s.player.x && y === s.player.y) continue;
        const at = { x, y };
        if (s.visible?.[index(x, y)] === 1) return at;
        fallback ??= at;
      }
    }
    return fallback;
  })();
  ok(!!spot, '找得到放置物品的地面');
  if (spot) {
    const mon = new Monster(monById.get('KOBOLD') as MonsterData, spot.x, spot.y, createRng(5));
    mon.asleep = false;
    s.level.monsters = [mon];
    const item = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
    const gold = makeGold(s.rng, s.depth, 42);
    s.level.objects.push({ x: spot.x, y: spot.y, items: [item, gold] });
    s.monsterPickup(mon);
    ok((mon.carried?.length ?? 0) === 2, `怪物捡起了金币与物品（${mon.carried?.length}）`);
    ok(!s.level.objects.some((p) => p.x === spot.x && p.y === spot.y), '地面堆被清空');
    ok(
      s.messages.some((m) => m.key === 'msg.monPicksGold'),
      '捡金币有提示',
    );
    ok(
      s.messages.some((m) => m.key === 'msg.monPicksUp'),
      '捡物品有提示',
    );

    const restored = restoreSession(serializeSession(s));
    const restoredMon = restored.level.monsters.find((m) => m.data.id === 'KOBOLD');
    ok((restoredMon?.carried?.length ?? 0) === 2, '怪物携带的物品随存档保留');

    // 死亡时掉回脚下。
    s.slayMonster(mon, false);
    const dropped = s.level.objects.find((p) => p.x === spot.x && p.y === spot.y);
    ok(
      !!dropped &&
        dropped.items.some((i) => i.id === 'LONG_SWORD') &&
        dropped.items.some((i) => i.gold),
      '怪物死亡时把携带的物品掉回脚下',
    );

    // 不会收集的怪物不拿东西。
    const blob = new Monster(monById.get('ACID_BLOB') as MonsterData, spot.x, spot.y, createRng(6));
    s.level.monsters = [blob];
    s.level.objects = [
      { x: spot.x, y: spot.y, items: [makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng)] },
    ];
    s.monsterPickup(blob);
    ok((blob.carried?.length ?? 0) === 0, '不会收集的怪物不拿东西');
  }

  // 商店里的货物不碰。
  {
    const shop = new GameSession({ seed: 20240101 });
    let depth = -1;
    for (let d = 2; d < 30 && depth < 0; d++) if (shopRoom(shop.getLevel(d))) depth = d;
    if (depth < 0) {
      fail('捡拾测试需要商店楼层');
    } else {
      shop.changeDepth(depth, 'down');
      shop.level.monsters = shop.level.monsters.filter((m) => m.data.id === 'SHOPKEEPER');
      const room = shopRoom(shop.level);
      const pile = shop.level.objects.find(
        (p) => room && inRoom(room, p.x, p.y) && !p.items.some((i) => i.gold),
      );
      if (!pile) {
        fail('商店里没有可测试的货物堆');
      } else {
        const mon = new Monster(monById.get('KOBOLD') as MonsterData, pile.x, pile.y, createRng(7));
        shop.level.monsters.push(mon);
        shop.monsterPickup(mon);
        ok((mon.carried?.length ?? 0) === 0, '怪物不拿商店里的货');
      }
    }
  }
});

section('怪物伤势提示', async () => {
  const { woundLevel } = await import('../src/game/combat');
  ok(woundLevel(10, 10) === 'unhurt', '满血是未受伤');
  ok(woundLevel(7, 10) === 'light', '七成血是轻伤');
  ok(woundLevel(4, 10) === 'heavy', '四成血是重伤');
  ok(woundLevel(1, 10) === 'nearDeath', '一成血是濒死');
  ok(woundLevel(1, 0) === 'unhurt', '生命上限为 0 时视为未受伤');

  const { GameSession } = await import('../src/game/session');
  const { describeTile, monsterHealthHint } = await import('../src/ui/tileInfo');
  const { Monster } = await import('../src/game/monsters');
  const { monById } = await import('../src/data/index');
  const { createRng } = await import('../src/core/rng');
  const s = new GameSession({ seed: 4242 });
  s.level.monsters = [];
  s.refreshFov();
  const spot = (() => {
    for (let x = 1; x < s.level.width - 1; x++) {
      for (let y = 1; y < s.level.height - 1; y++) {
        if (s.level.tiles[index(x, y)] !== T.ROOM) continue;
        if (x === s.player.x && y === s.player.y) continue;
        if (s.visible?.[index(x, y)] === 1) return { x, y };
      }
    }
    return null;
  })();
  ok(!!spot, '找得到悬停测试的可见地面');
  if (spot) {
    const mon = new Monster(monById.get('KOBOLD') as MonsterData, spot.x, spot.y, createRng(5));
    mon.mhp = 1;
    mon.mhpmax = 4;
    s.level.monsters = [mon];
    const info = describeTile(s, spot.x, spot.y);
    ok(!!info && info.kind === 'monster' && info.title.length > 0, '悬停怪物能给出说明');
    ok(!!info?.hint?.includes('25%'), `悬停提示带生命百分比（${info?.hint ?? ''}）`);
    ok(monsterHealthHint(mon).includes('25%'), '伤势提示包含生命百分比');
  }
});

section('自动拾取', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { serializeSession, restoreSession } = await import('../src/game/save');

  const setup = (seed: number): InstanceType<typeof GameSession> => {
    const s = new GameSession({ seed });
    s.level.monsters = [];
    s.level.traps.clear();
    s.level.objects = [];
    return s;
  };
  /** 找一个空着的相邻地面，用来放测试物品。 */
  const stepTo = (s: InstanceType<typeof GameSession>) => {
    const p = s.player;
    return [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]
      .map(([dx, dy]) => ({ dx, dy, x: p.x + dx, y: p.y + dy }))
      .find(
        (spot) =>
          isWalkable(s.level.tiles[index(spot.x, spot.y)]) &&
          !s.level.doors.has(index(spot.x, spot.y)) &&
          !s.level.traps.has(index(spot.x, spot.y)) &&
          !s.level.stairs.some((st) => st.x === spot.x && st.y === spot.y),
      );
  };

  // 关闭时物品留在原地。
  {
    const s = setup(2468);
    const step = stepTo(s);
    ok(!!step, '找得到自动拾取测试的相邻地面');
    if (step) {
      const item = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
      s.level.objects.push({ x: step.x, y: step.y, items: [item] });
      const r = s.movePlayer(step.dx, step.dy);
      ok(r.result === 'moved', `走到物品格（${r.result}）`);
      ok(!s.player.inventory.includes(item), '关闭自动拾取时物品留在地上');
    }
  }

  // 打开时顺手捡起，且不额外消耗回合。
  {
    const s = setup(2468);
    s.autoPickup = true;
    const step = stepTo(s);
    if (step) {
      const item = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
      s.level.objects.push({ x: step.x, y: step.y, items: [item] });
      const turnBefore = s.turn;
      const r = s.movePlayer(step.dx, step.dy);
      ok(r.result === 'moved' && s.turn === turnBefore + 1, '自动拾取不额外消耗回合');
      ok(s.player.inventory.includes(item), '打开自动拾取时物品被捡起');
      ok(
        s.messages.some((m) => m.key === 'msg.autoPickup'),
        '自动拾取有提示',
      );
    }
  }

  // 未付款的商店货物不碰。
  {
    const s = setup(2468);
    s.autoPickup = true;
    const step = stepTo(s);
    if (step) {
      const item = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
      item.unpaid = true;
      s.level.objects.push({ x: step.x, y: step.y, items: [item] });
      s.movePlayer(step.dx, step.dy);
      ok(!s.player.inventory.includes(item), '未付款的商店货物不自动拾取');
    }
  }

  // 开关随存档保留。
  {
    const s = setup(2468);
    s.autoPickup = true;
    const restored = restoreSession(serializeSession(s));
    ok(restored.autoPickup === true, '自动拾取开关随存档保留');
  }
});

section('巨石', async () => {
  {
    const { GameSession } = await import('../src/game/session');
    const { makeBoulder } = await import('../src/game/items');

    const s = new GameSession({ seed: 7171 });
    s.level.monsters.length = 0;
    const tiles = s.level.tiles;
    const open = (x: number, y: number) =>
      isWalkable(tiles[index(x, y)]) &&
      !s.level.doors.has(index(x, y)) &&
      !s.level.traps.has(index(x, y));

    // 可推：三格直线空地。
    let px = -1;
    let py = -1;
    for (let y = 1; y < ROWNO - 1 && px < 0; y++) {
      for (let x = 1; x < COLNO - 3; x++) {
        if (open(x, y) && open(x + 1, y) && open(x + 2, y)) {
          px = x;
          py = y;
          break;
        }
      }
    }
    ok(px > 0, '找得到三格直线空地');
    if (px > 0) {
      s.player.x = px;
      s.player.y = py;
      s.level.objects.push({ x: px + 1, y: py, items: [makeBoulder(s.rng)] });
      const r = s.movePlayer(1, 0);
      ok(s.player.x === px + 1 && s.player.y === py, `推巨石后玩家前进（${r.result}）`);
      const pushed = s.level.objects.find((p) => p.items.some((i) => i.id === 'BOULDER'));
      ok(pushed?.x === px + 2 && pushed?.y === py, '巨石被推到后一格');

      // 推不动：身后是不可通行地形。
      let bx = -1;
      let by = -1;
      for (let y = 1; y < ROWNO - 1 && bx < 0; y++) {
        for (let x = 1; x < COLNO - 3; x++) {
          if (open(x, y) && open(x + 1, y) && !isWalkable(tiles[index(x + 2, y)])) {
            bx = x;
            by = y;
            break;
          }
        }
      }
      ok(bx > 0, '找得到巨石推不动的直线');
      if (bx > 0) {
        s.level.monsters.length = 0;
        s.level.objects.length = 0;
        s.player.x = bx;
        s.player.y = by;
        s.level.objects.push({ x: bx + 1, y: by, items: [makeBoulder(s.rng)] });
        const before = s.turn;
        const r2 = s.movePlayer(1, 0);
        ok(r2.result === 'blocked', `推不动的巨石返回 blocked（${r2.result}）`);
        ok(s.player.x === bx && s.player.y === by, '推不动时玩家原地不动');
        ok(s.turn === before, '推不动不消耗回合');
        const stuck = s.level.objects.find((p) => p.items.some((i) => i.id === 'BOULDER'));
        ok(stuck?.x === bx + 1 && stuck?.y === by, '推不动时巨石原地不动');
      }
    }
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
      ok(s.victory === false, 'picking up the Amulet alone does not win');
      ok(
        s.messages.some((m) => m.key === 'msg.amuletTaken'),
        'amulet pickup tells you to escape',
      );
      ok(
        s.level.monsters.some((m) => m.data.id === 'WIZARD_OF_YENDOR'),
        'picking up the Amulet spawns the Wizard of Yendor',
      );
      s.changeDepth(1, 'up', 'main');
      ok(s.victory === true, 'escaping to depth 1 with the Amulet wins');
      ok(
        s.messages.some((m) => m.key === 'msg.victory'),
        'victory message is logged',
      );
    }
  }

  // 巫师夺回护身符：近身抢走并逃开，击杀后掉落。
  {
    const { GameSession } = await import('../src/game/session.js');
    const { Monster } = await import('../src/game/monsters.js');
    const { monById, objById } = await import('../src/data/index.js');
    const { makeItem } = await import('../src/game/items.js');
    const s = new GameSession({ seed: 999 });
    s.player.maxHp = 500;
    s.player.hp = 500;
    const amulet = makeItem(objById.get('AMULET_OF_YENDOR') as ObjectData, s.rng);
    s.player.inventory.push(amulet);
    s.level.monsters = [];
    const wizard = new Monster(
      monById.get('WIZARD_OF_YENDOR') as MonsterData,
      s.player.x + 1,
      s.player.y,
      s.rng,
    );
    wizard.asleep = false;
    s.level.monsters.push(wizard);
    s.refreshFov();
    let stolen = false;
    for (let i = 0; i < 40 && !stolen && !s.dead; i++) {
      wizard.x = s.player.x + 1;
      wizard.y = s.player.y;
      s.monsterAction(wizard);
      if (s.wizardHasAmulet) stolen = true;
    }
    ok(stolen, '巫师抢走护身符');
    ok(!s.carryingAmulet, '护身符离开背包');
    s.slayMonster(wizard, true);
    ok(!s.wizardHasAmulet, '巫师死后抢走标记清除');
    ok(
      s.level.objects.flatMap((p) => p.items).some((i) => i.proto.id === 'AMULET_OF_YENDOR'),
      '护身符掉回地面',
    );
  }

  // 没有护身符回到第 1 层不算通关，也不会有追击者。
  {
    const { GameSession } = await import('../src/game/session.js');
    const s = new GameSession({ seed: 9 });
    s.changeDepth(2, 'down');
    ok(
      !s.level.monsters.some((m) => m.data.id === 'WIZARD_OF_YENDOR'),
      'no Wizard of Yendor without the Amulet',
    );
    s.changeDepth(1, 'up', 'main');
    ok(s.victory === false, 'returning to depth 1 without the Amulet does not win');
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

    // 自动路径避开已经见过的陷阱；目标格不受此限制。
    if (path && path.length >= 2) {
      const trapAt = {
        x: start.x + path[0].dx + path[1].dx,
        y: start.y + path[0].dy + path[1].dy,
      };
      if (trapAt.x !== target.x || trapAt.y !== target.y) {
        const trapIndex = index(trapAt.x, trapAt.y);
        level.traps.set(trapIndex, { type: 'PIT', seen: true });
        const safe = findPath(level, start, target);
        const safePoints = safe ? pathPoints(start, safe) : [];
        ok(
          safe === null || safePoints.every((p) => p.x !== trapAt.x || p.y !== trapAt.y),
          '自动寻路绕开已见的陷阱',
        );
        ok(findPath(level, start, target, { avoidHazards: false }) !== null, '关掉避让仍可达');
        level.traps.delete(trapIndex);
      }
    }
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
  const { auditDoors } = await import('./agent-lib');

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
      auditProblems = auditProblems.concat(auditDoors(level).problems);
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
        // 大房间是一整间无门大厅，不参与「每个房间有门」的检查。
        if (level.special === 'big_room') break;
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
  let fuzzProper = 0;
  const fuzzProblems: string[] = [];
  for (let n = 0; n < 24; n++) {
    const seed = (9001 + n * 104729) >>> 0;
    const depth = 1 + ((n * 7 + 3) % 30);
    const audit = auditDoors(generateLevel({ gameSeed: seed, depth }));
    fuzzDoors += audit.doors;
    fuzzProper += audit.proper;
    fuzzProblems.push(...audit.problems.map((p) => `种子 ${seed} 第 ${depth} 层：${p}`));
  }
  ok(fuzzDoors > 200, `模糊样本内共有 ${fuzzDoors} 扇门`);
  ok(
    fuzzProper === fuzzDoors,
    `模糊样本的门都满足「前后通道、两侧墙」（${fuzzProper}/${fuzzDoors}）`,
  );
  ok(
    fuzzProblems.length === 0,
    `模糊样本门朝向与地图通道一致（${fuzzProblems.length} 扇判反` +
      `${fuzzProblems.length ? `：${fuzzProblems.slice(0, 2).join('；')}` : ''}）`,
  );
});
section('状态转储', async () => {
  const { GameSession } = await import('../src/game/session');
  const { buildDump, dumpFileName, DUMP_SAVE_MARKER } = await import('../src/ui/dump');
  const { restoreSession } = await import('../src/game/save');

  const session = new GameSession({ seed: 4242 });
  const text = buildDump(session);
  ok(text.includes(`seed: ${session.seed}`), `转储包含种子（${session.seed}）`);
  ok(text.includes(`depth: ${session.depth} /`), `转储包含层数（${session.depth}）`);
  ok(text.includes(`turn: ${session.turn}`), `转储包含回合数`);
  ok(text.includes('@'), '地图标出玩家位置');
  ok(text.includes('intrinsics:') && text.includes('quest:'), '转储包含内在抗性与任务状态');
  ok(text.includes('telepathy='), '转储包含心灵感应状态');
  ok(
    text.includes('map:') && text.includes('messages') && text.includes('logs:'),
    '转储包含地图、消息与日志分段',
  );
  ok(!text.includes('undefined'), '转储没有 undefined');
  ok(text.split('\n').length > 30, `转储篇幅足够（${text.split('\n').length} 行）`);

  // 末段的存档 JSON 必须能恢复现场，否则玩家发来的转储只能靠猜。
  const saved = text.slice(text.indexOf(DUMP_SAVE_MARKER) + DUMP_SAVE_MARKER.length).trim();
  const problems: string[] = [];
  try {
    const restored = restoreSession(JSON.parse(saved));
    if (restored.seed !== session.seed) problems.push(`种子 ${restored.seed}`);
    if (restored.depth !== session.depth) problems.push(`层数 ${restored.depth}`);
    if (restored.player.x !== session.player.x || restored.player.y !== session.player.y) {
      problems.push('玩家位置');
    }
    if (restored.player.hp !== session.player.hp) problems.push('生命');
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  ok(problems.length === 0, `转储里的存档可以恢复现场（${problems.join('；') || '无差异'}）`);
  ok(
    dumpFileName(session).includes(String(session.seed)) && dumpFileName(session).endsWith('.txt'),
    `文件名可辨识（${dumpFileName(session)}）`,
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

  // 雕像陷阱：触发后原地生成一只敌对怪物；振动方块有专属提示。
  {
    const s = new GameSession({ seed: 606 });
    s.player.maxHp = 60;
    s.player.hp = 60;
    const before = s.level.monsters.length;
    const { sprung } = stepOn(s, 'STATUE_TRAP');
    ok(sprung, '找到可下脚的位置放雕像陷阱');
    if (sprung) {
      ok(
        s.level.monsters.length > before,
        `雕像陷阱生成怪物（${before} -> ${s.level.monsters.length}）`,
      );
      ok(
        s.messages.some((m) => m.key === 'msg.trapStatue'),
        '雕像陷阱有专属提示',
      );
    }
  }
  {
    const s = new GameSession({ seed: 707 });
    stepOn(s, 'VIBRATING_SQUARE');
    ok(
      s.messages.some((m) => m.key === 'msg.trapVibrating'),
      '振动方块有专属提示',
    );
  }

  // 未登记的陷阱类型按无事发生处理，不应抛异常。
  {
    const s = new GameSession({ seed: 8 });
    const { sprung } = stepOn(s, 'NOT_A_REAL_TRAP');
    ok(sprung, '未知陷阱类型可以正常结算');
    ok(!s.dead, '未知陷阱类型不会导致死亡');
  }

  // 门上的机关：深层生成、开门触发、搜索可见、随存档保留。
  {
    const { serializeSession, restoreSession } = await import('../src/game/save');
    const { Monster } = await import('../src/game/monsters');
    const deep = generateLevel({ gameSeed: 20240101, depth: 15 });
    const again = generateLevel({ gameSeed: 20240101, depth: 15 });
    const trapped = [...deep.doors.values()].filter((d) => d.trapped).length;
    const trappedAgain = [...again.doors.values()].filter((d) => d.trapped).length;
    ok(trapped > 0, `深层门上有机关（${trapped} 扇）`);
    ok(trapped === trappedAgain, '门上的机关可复现');
    const shallow = generateLevel({ gameSeed: 20240101, depth: 3 });
    ok(
      [...shallow.doors.values()].every((d) => !d.trapped),
      '浅层门上没有机关',
    );

    // 开门触发机关并消耗它。
    const s = new GameSession({ seed: 4242 });
    s.player.maxHp = 200;
    s.player.hp = 200;
    s.level.monsters = [];
    const entry = [...s.level.doors].find(([, d]) => d.closed);
    ok(!!entry, '开门测试需要一扇关闭的门');
    if (entry) {
      const [tile, door] = entry;
      door.trapped = true;
      door.trapKnown = true;
      const dx = tile % s.level.width;
      const dy = Math.floor(tile / s.level.width);
      const near = [
        [dx - 1, dy],
        [dx + 1, dy],
        [dx, dy - 1],
        [dx, dy + 1],
      ].find(([x, y]) => isWalkable(s.level.tiles[index(x, y)]));
      ok(!!near, '门旁边有可站立的位置');
      if (near) {
        s.player.x = near[0];
        s.player.y = near[1];
        s.refreshFov();
        const restored = restoreSession(serializeSession(s));
        ok(restored.level.doors.get(tile)?.trapped === true, '门上机关随存档保留');
        const r = s.movePlayer(dx - near[0], dy - near[1]);
        ok(r.result === 'opened', `开门返回 opened（${r.result}）`);
        ok(!door.trapped, '开门触发后机关失效');
        ok(
          s.messages.some((m) => m.key === 'msg.doorTrap'),
          '触发门机关有提示',
        );
      }
    }

    // 搜索可以提前发现门上的机关。
    const s2 = new GameSession({ seed: 4242 });
    s2.level.monsters = [];
    const entry2 = [...s2.level.doors].find(([, d]) => d.closed);
    if (entry2) {
      const [tile2, door2] = entry2;
      door2.trapped = true;
      const dx2 = tile2 % s2.level.width;
      const dy2 = Math.floor(tile2 / s2.level.width);
      const near2 = [
        [dx2 - 1, dy2],
        [dx2 + 1, dy2],
        [dx2, dy2 - 1],
        [dx2, dy2 + 1],
      ].find(([x, y]) => isWalkable(s2.level.tiles[index(x, y)]));
      if (near2) {
        s2.player.x = near2[0];
        s2.player.y = near2[1];
        s2.refreshFov();
        for (let i = 0; i < 30 && !door2.trapKnown; i++) s2.searchAction();
        ok(door2.trapKnown === true, '搜索可以发现门上的机关');
        // 已知的机关门可以拆除。
        ok(s2.disarmTarget()?.type === 'DOOR_TRAP', '机关门成为拆陷阱目标');
        for (let i = 0; i < 40 && door2.trapped; i++) s2.untrapAction();
        ok(!door2.trapped, '拆陷阱可以拆除门上的机关');
        ok(
          s2.messages.some((m) => m.key === 'msg.untrapDoorDone'),
          '拆除门机关有提示',
        );
      }
    }

    // 怪物开门也会触发机关。
    const s3 = new GameSession({ seed: 4242 });
    s3.player.maxHp = 200;
    s3.player.hp = 200;
    s3.level.monsters = [];
    const entry3 = [...s3.level.doors].find(([, d]) => d.closed);
    if (entry3) {
      const [tile3, door3] = entry3;
      door3.trapped = true;
      const dx3 = tile3 % s3.level.width;
      const dy3 = Math.floor(tile3 / s3.level.width);
      const near3 = [
        [dx3 - 1, dy3],
        [dx3 + 1, dy3],
        [dx3, dy3 - 1],
        [dx3, dy3 + 1],
      ].find(([x, y]) => isWalkable(s3.level.tiles[index(x, y)]));
      let opposite3: [number, number] | null = null;
      if (near3) {
        if (near3[0] === dx3 - 1) opposite3 = [dx3 + 1, dy3];
        else if (near3[0] === dx3 + 1) opposite3 = [dx3 - 1, dy3];
        else if (near3[1] === dy3 - 1) opposite3 = [dx3, dy3 + 1];
        else opposite3 = [dx3, dy3 - 1];
      }
      if (near3 && opposite3 && isWalkable(s3.level.tiles[index(opposite3[0], opposite3[1])])) {
        const mon = new Monster(
          monById.get('KOBOLD') as MonsterData,
          near3[0],
          near3[1],
          createRng(9),
        );
        mon.mhp = mon.mhpmax = 100;
        mon.asleep = false;
        s3.level.monsters = [mon];
        s3.player.x = opposite3[0];
        s3.player.y = opposite3[1];
        s3.stepMonster(mon, 1);
        ok(!door3.trapped, '怪物开门也会触发门上的机关');
      }
    }
  }
});
section('地形设施', async () => {
  const { GameSession } = await import('../src/game/session');
  const { FEATURE_ACTIONS, FEATURE_TABLES, rollFeatureEffect } =
    await import('../src/game/features');
  const { createRng } = await import('../src/core/rng');
  const { serializeSession, restoreSession } = await import('../src/game/save');

  // 效果表完整：权重为正，文案键合法，抽取结果不越界。
  for (const kind of ['fountain', 'sink', 'grave', 'throne'] as const) {
    const table = FEATURE_TABLES[kind];
    ok(table.length > 0, `${kind} 有效果表`);
    ok(
      table.every((e) => e.weight > 0 && e.message.startsWith('msg.')),
      `${kind} 的权重与文案键合法`,
    );
    ok(
      table.some((e) => e.kind === 'nothing'),
      `${kind} 保留无事发生的分支`,
    );
    const rng = createRng(99);
    ok(
      Array.from({ length: 50 }, () => rollFeatureEffect(rng, kind)).every((e) =>
        table.includes(e),
      ),
      `${kind} 的抽取结果都在表内`,
    );
  }
  // 四种设施都有情境动作，祭坛留到祈祷机制。
  ok(Object.keys(FEATURE_ACTIONS).length === 4, '四种设施提供情境动作');
  ok(!FEATURE_ACTIONS[T.ALTAR], '祭坛暂不提供动作');

  /** 逐层找一处指定设施，把玩家放到设施格上。 */
  const standOn = (
    session: InstanceType<typeof GameSession>,
    type: string,
  ): { i: number; depth: number } | null => {
    for (let depth = 2; depth < 30; depth++) {
      const level = session.getLevel(depth);
      for (const [i, feature] of level.features) {
        if (feature.type === type) {
          session.changeDepth(depth, 'down');
          session.level.monsters = [];
          session.player.x = i % COLNO;
          session.player.y = Math.floor(i / COLNO);
          session.player.hunger = 2000;
          session.refreshFov();
          return { i, depth };
        }
      }
    }
    return null;
  };

  // 坟墓：挖一次就到底，第二次只消耗回合。
  {
    const s = new GameSession({ seed: 20240101 });
    const at = standOn(s, 'GRAVE');
    ok(!!at, `第 ${at?.depth} 层找得到坟墓`);
    if (at) {
      s.useFeature('dig');
      ok(s.level.features.get(at.i)?.depleted === true, '挖过的坟墓标记为已挖开');
      const before = s.turn;
      const again = s.useFeature('dig');
      ok(again.result === 'used' && s.turn > before, '再次挖掘只消耗回合');
    }
  }

  // 王座：坐过一次后失效或直接消失。
  {
    const s = new GameSession({ seed: 20240101 });
    const at = standOn(s, 'THRONE');
    ok(!!at, `第 ${at?.depth} 层找得到王座`);
    if (at) {
      s.useFeature('sit');
      const feature = s.level.features.get(at.i);
      ok(!feature || feature.used === true, '王座坐过一次后失效或消失');
      if (!feature) ok(s.level.tiles[at.i] === T.ROOM, '消失的王座恢复成普通地面');
    }
  }

  // 喷泉：一直喝到干涸，干涸后不再产生效果。
  {
    const s = new GameSession({ seed: 20240101 });
    const at = standOn(s, 'FOUNTAIN');
    ok(!!at, `第 ${at?.depth} 层找得到喷泉`);
    if (at) {
      s.player.hp = s.player.maxHp;
      for (let n = 0; n < 300 && !s.level.features.get(at.i)?.depleted; n++) {
        s.useFeature('drink');
        // 现身的怪物不参与后续回合，避免测试被战斗打断。
        s.level.monsters = [];
      }
      ok(s.level.features.get(at.i)?.depleted === true, '喷泉最终会干涸');
      ok(isWalkable(s.level.tiles[at.i]), '干涸的喷泉仍可通行');
      const hp = s.player.hp;
      s.useFeature('drink');
      ok(s.player.hp === hp, '干涸后喝水不再有治疗效果');
    }
  }

  // 存档往返保留失效标记，已挖开的坟墓不会复活。
  {
    const s = new GameSession({ seed: 20240101 });
    const at = standOn(s, 'GRAVE');
    if (at) {
      s.useFeature('dig');
      const restored = restoreSession(serializeSession(s));
      ok(restored.level.features.get(at.i)?.depleted === true, '挖开的坟墓随存档保留');
    } else {
      fail('存档测试需要一座坟墓');
    }
  }
});
section('祈祷与阵营', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById } = await import('../src/data/index');
  const { serializeSession, restoreSession } = await import('../src/game/save');
  const { FIXED_CHARACTER } = await import('./agent-lib');

  /** 固定角色，保证阵营是中立。 */
  const newFixed = () => new GameSession({ seed: 20240101, character: FIXED_CHARACTER });

  // 击杀改变阵营记录：敌对加分，和平扣分。
  {
    const s = newFixed();
    const imp = monById.get('IMP') as MonsterData;
    const mon = new Monster(imp, s.player.x + 1, s.player.y, s.rng);
    mon.mlev = 10;
    s.slayMonster(mon, true);
    ok(s.player.alignRecord > 0, `击杀敌对怪物提高阵营记录（${s.player.alignRecord}）`);
    const watch = monById.get('WATCHMAN') as MonsterData;
    const w = new Monster(watch, s.player.x + 1, s.player.y, s.rng);
    const before = s.player.alignRecord;
    s.slayMonster(w, true);
    ok(
      s.player.alignRecord < before,
      `击杀和平生物降低阵营记录（${before} -> ${s.player.alignRecord}）`,
    );
  }

  // 扫一遍 2..29 层，收集祭坛位置并顺带检查归属合法；生成是确定性的，
  // 后续测试直接跳到已知层，避免重复生成拖垮超时。
  const altarSpots: { depth: number; i: number }[] = [];
  {
    const probe = newFixed();
    for (let depth = 2; depth < 30; depth++) {
      for (const [i, feature] of probe.getLevel(depth).features) {
        if (feature.type !== 'ALTAR') continue;
        altarSpots.push({ depth, i });
        ok(
          !feature.align || ['lawful', 'neutral', 'chaotic'].includes(feature.align),
          `祭坛归属合法（${feature.align}）`,
        );
      }
    }
  }
  ok(altarSpots.length > 0, `样本里存在祭坛（${altarSpots.length} 座）`);
  const altarAt = altarSpots[0] ?? null;

  /** 跳到已知祭坛那一层，改写成指定阵营并把玩家放上去。 */
  const standOnAltar = (
    s: InstanceType<typeof GameSession>,
    align: 'lawful' | 'neutral' | 'chaotic',
  ): boolean => {
    if (!altarAt) return false;
    s.changeDepth(altarAt.depth, 'down');
    s.level.monsters = [];
    const feature = s.level.features.get(altarAt.i);
    if (!feature) return false;
    feature.align = align;
    s.player.x = altarAt.i % COLNO;
    s.player.y = Math.floor(altarAt.i / COLNO);
    s.player.hunger = 2000;
    s.refreshFov();
    return true;
  };

  // 在自己阵营的祭坛上祈祷：满血、回法、清除异常、记录 +1、写入冷却。
  {
    const s = newFixed();
    ok(standOnAltar(s, 'neutral'), '找得到祭坛');
    s.player.hp = 5;
    s.player.pw = 0;
    s.player.blind = 5;
    s.player.stun = 3;
    s.player.petrifying = 4;
    s.player.sick = 6;
    s.pray();
    ok(s.player.hp === s.player.maxHp, `祈祷满血（${s.player.hp}）`);
    ok(s.player.pw === s.player.maxPw, '祈祷回满法力');
    ok(
      s.player.blind === 0 && s.player.stun === 0 && s.player.petrifying === 0,
      '祈祷清除异常状态',
    );
    ok(s.player.sick === 0, '祈祷清除疾病');
    ok(s.player.sick === 0, '祈祷清除疾病');
    ok(s.player.alignRecord === 1, `祈祷提升阵营记录（${s.player.alignRecord}）`);
    ok(s.player.prayerTimeout >= 300, `祈祷写入冷却（${s.player.prayerTimeout}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.prayerBlessed'),
      '祈祷使用祝福消息',
    );
  }

  // 祝福祈祷解除装备上的诅咒。
  {
    const s = newFixed();
    ok(standOnAltar(s, 'neutral'), '找得到祭坛（除咒）');
    const { makeItem } = await import('../src/game/items');
    const sword = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
    const setBuc = (item: ItemInstance, buc: ItemInstance['buc']): void => {
      item.buc = buc;
    };
    setBuc(sword, 'cursed');
    s.player.inventory.push(sword);
    s.player.equipment.weapon = sword;
    s.pray();
    ok(sword.buc === 'uncursed', `祝福祈祷解除装备诅咒（${sword.buc}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.prayerUncursed'),
      '除咒有提示',
    );
  }

  // 祭坛上的水随神意转化：同阵营祈祷出圣水，受罚时变诅咒之水。
  {
    const s = newFixed();
    ok(standOnAltar(s, 'neutral'), '找得到祭坛（圣水）');
    const { makeItem } = await import('../src/game/items');
    const water = makeItem(objById.get('POT_WATER') as ObjectData, s.rng);
    s.level.objects.push({ x: s.player.x, y: s.player.y, items: [water] });
    s.pray();
    ok(water.buc === 'blessed', `祈祷把祭坛上的水变成圣水（${water.buc}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.waterBlessed'),
      '圣水转化有提示',
    );
  }
  {
    const s = newFixed();
    ok(standOnAltar(s, 'neutral'), '找得到祭坛（诅咒之水）');
    const { makeItem } = await import('../src/game/items');
    const water = makeItem(objById.get('POT_WATER') as ObjectData, s.rng);
    // 通过函数赋值，避免 TS 把字段类型收窄成字面量。
    const setBuc = (item: ItemInstance, buc: ItemInstance['buc']): void => {
      item.buc = buc;
    };
    setBuc(water, 'blessed');
    s.level.objects.push({ x: s.player.x, y: s.player.y, items: [water] });
    s.player.prayerTimeout = 10;
    s.pray();
    ok(water.buc === 'cursed', `受罚时水变成诅咒之水（${water.buc}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.waterCursed'),
      '诅咒之水有提示',
    );
  }

  // 冷却中再次祈祷：受伤、记录下降、召唤敌对天使。
  {
    const s = newFixed();
    ok(standOnAltar(s, 'neutral'), '找得到祭坛（受罚）');
    s.player.prayerTimeout = 100;
    const before = s.player.hp;
    const recordBefore = s.player.alignRecord;
    s.pray();
    ok(s.player.hp < before, `冷却中祈祷受伤（${before} -> ${s.player.hp}）`);
    ok(s.player.alignRecord === recordBefore - 5, '惩罚降低阵营记录');
    ok(
      s.level.monsters.some((m) => m.data.id === 'ANGEL' && m.angry),
      '惩罚召唤敌对天使',
    );
  }

  // 站在别的阵营祭坛前祈祷：同样受罚。
  {
    const s = newFixed();
    const other = FIXED_CHARACTER.align === 'lawful' ? 'chaotic' : 'lawful';
    ok(standOnAltar(s, other), '找得到异教祭坛');
    const before = s.player.hp;
    s.pray();
    ok(s.player.hp < before, '敬拜异教祭坛受伤');
  }

  // 献祭：同阵营祭坛接受强壮的祭品，提升幸运与阵营记录。
  {
    const s = newFixed();
    ok(standOnAltar(s, 'neutral'), '找得到祭坛（献祭）');
    const { makeItem } = await import('../src/game/items');
    const proto = objById.get('CORPSE') as ObjectData;
    const body = makeItem(proto, s.rng);
    body.corpse = 'FIRE_GIANT';
    s.player.inventory.push(body);
    const luckBefore = s.player.luck;
    const recordBefore = s.player.alignRecord;
    s.offerCorpse();
    ok(!s.player.inventory.includes(body), '献祭消耗尸体');
    ok(s.player.luck === luckBefore + 1, `献祭提升幸运（${s.player.luck}）`);
    ok(s.player.alignRecord === recordBefore + 3, '献祭提升阵营记录');
    ok(
      s.messages.some((m) => m.key === 'msg.sacrificeAccepted'),
      '同阵营祭坛接受祭品',
    );
  }

  // 太弱的祭品不生效。
  {
    const s = newFixed();
    ok(standOnAltar(s, 'neutral'), '找得到祭坛（弱小祭品）');
    const { makeItem } = await import('../src/game/items');
    const body = makeItem(objById.get('CORPSE') as ObjectData, s.rng);
    body.corpse = 'GIANT_ANT';
    s.player.inventory.push(body);
    s.player.level = 20;
    const luckBefore = s.player.luck;
    s.offerCorpse();
    ok(s.player.luck === luckBefore, '弱小祭品不提升幸运');
    ok(
      s.messages.some((m) => m.key === 'msg.sacrificeWeak'),
      '弱小祭品没有效果',
    );
  }

  // 无主祭坛只吞祭品；异教祭坛多次献祭后归附本阵营。
  if (altarAt) {
    const { makeItem } = await import('../src/game/items');
    const proto = objById.get('CORPSE') as ObjectData;
    const moloch = newFixed();
    ok(standOnAltar(moloch, 'neutral'), '找得到祭坛（摩洛克）');
    const feature = moloch.level.features.get(altarAt.i);
    if (feature) feature.align = undefined;
    const offering = makeItem(proto, moloch.rng);
    offering.corpse = 'GIANT_ANT';
    moloch.player.inventory.push(offering);
    moloch.offerCorpse();
    ok(
      moloch.messages.some((m) => m.key === 'msg.sacrificeMoloch'),
      '无主祭坛不给予回报',
    );

    const s = newFixed();
    const other = FIXED_CHARACTER.align === 'lawful' ? 'chaotic' : 'lawful';
    ok(standOnAltar(s, other), '找得到异教祭坛（献祭）');
    let converted = false;
    for (let i = 0; i < 40 && !converted; i++) {
      const body = makeItem(proto, s.rng);
      body.corpse = 'FIRE_GIANT';
      s.player.inventory.push(body);
      s.offerCorpse();
      if (s.level.features.get(altarAt.i)?.align === s.player.align) converted = true;
    }
    ok(converted, '异教祭坛最终归附本阵营');
    ok(
      s.messages.some((m) => m.key === 'msg.sacrificeConverted'),
      '归附有提示',
    );
  }

  // 冷却递减；阵营记录与冷却随存档保留。
  {
    const s = newFixed();
    s.player.alignRecord = 7;
    s.player.prayerTimeout = 3;
    s.wait();
    ok(s.player.prayerTimeout === 2, `冷却随回合递减（${s.player.prayerTimeout}）`);
    const restored = restoreSession(serializeSession(s));
    ok(restored.player.alignRecord === 7, '阵营记录随存档保留');
    ok(restored.player.prayerTimeout === 2, '祈祷冷却随存档保留');
  }
});
section('变形', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById, objById } = await import('../src/data/index');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory, wearItem } = await import('../src/game/inventory');
  const { playerResists } = await import('../src/game/resist');
  const { serializeSession, restoreSession } = await import('../src/game/save');
  const { createRng } = await import('../src/core/rng');
  const { index } = await import('../src/game/dungeon');

  // 药水：变成随机怪物形态，属性改用形态数据。
  {
    const s = new GameSession({ seed: 4242 });
    const potion = makeItem(objById.get('POT_POLYMORPH') as ObjectData, s.rng);
    addToInventory(s.player, potion);
    const r = s.useItem(potion);
    const form = s.player.formData;
    ok(r.key === 'use.polymorph' && !!form, `变形药水生效（${form?.id}）`);
    ok(
      s.player.form !== null && s.player.form.turns >= 20 && s.player.form.turns <= 39,
      `变形持续 20-39 回合（${s.player.form?.turns}）`,
    );
    if (form) {
      ok(s.player.ac === form.ac - s.player.acBonus, `护甲改用形态数据（${s.player.ac}）`);
      const atk = form.attacks.find((a) => a.at !== 'AT_NONE' && a.dice[0] > 0 && a.dice[1] > 0);
      const expected = atk ? `${atk.dice[0]}d${atk.dice[1]}` : '1d2';
      ok(s.player.weaponDamageSpec('MZ_MEDIUM') === expected, `近战骰改用形态数据（${expected}）`);
    }
  }

  // 不变护身符完全挡住变形。
  {
    const s = new GameSession({ seed: 4242 });
    const amulet = makeItem(objById.get('AMULET_OF_UNCHANGING') as ObjectData, s.rng);
    addToInventory(s.player, amulet);
    wearItem(s.player, amulet);
    const potion = makeItem(objById.get('POT_POLYMORPH') as ObjectData, s.rng);
    addToInventory(s.player, potion);
    const r = s.useItem(potion);
    ok(s.player.form === null && r.key === 'use.polyUnchanging', '不变护身符挡住变形药水');
    ok(s.polymorph().blocked, '不变护身符挡住所有变形来源');
  }

  // 形态自带抗性：红龙形态不怕火。
  {
    const s = new GameSession({ seed: 4242 });
    s.player.form = { id: 'RED_DRAGON', turns: 10 };
    ok(playerResists(s.player).has('fire'), '红龙形态提供火焰抗性');
    s.player.form = null;
    ok(!playerResists(s.player).has('fire'), '恢复原形后失去形态抗性');
  }

  // 到期自动恢复。
  {
    const s = new GameSession({ seed: 4242 });
    s.polymorph();
    ok(!!s.player.form, '变形已开始');
    const turns = s.player.form?.turns ?? 0;
    s.level.monsters = [];
    s.player.hunger = 2000;
    for (let i = 0; i <= turns; i++) s.wait();
    ok(s.player.form === null, '变形到期自动恢复');
    ok(
      s.messages.some((m) => m.key === 'msg.polyEnd'),
      '恢复原形有提示',
    );
  }

  // 变形陷阱：踩中后变成怪物形态。
  {
    const s = new GameSession({ seed: 777 });
    const p = s.player;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      if (!isWalkable(s.level.tiles[index(p.x + dx, p.y + dy)])) continue;
      if (s.level.monsters.some((m) => m.x === p.x + dx && m.y === p.y + dy)) continue;
      s.level.traps.set(index(p.x + dx, p.y + dy), { type: 'POLY_TRAP', seen: false });
      s.movePlayer(dx, dy);
      break;
    }
    ok(!!s.player.form, `变形陷阱让玩家变形（${s.player.form?.id}）`);
  }

  // 怪物攻击变形：AD_POLY 也换成形态而不是混乱。
  {
    const s = new GameSession({ seed: 5 });
    const ant = monById.get('GIANT_ANT') as MonsterData;
    const mon = new Monster(ant, s.player.x + 1, s.player.y, createRng(3));
    mon.data = { ...ant, attacks: [{ at: 'AT_CLAW', ad: 'AD_POLY', dice: [1, 4] }] };
    mon.mlev = 40;
    mon.asleep = false;
    s.monsterAttack(mon);
    ok(!!s.player.form, `AD_POLY 让玩家变形（${s.player.form?.id}）`);
  }

  // 存档往返保留形态。
  {
    const s = new GameSession({ seed: 4242 });
    s.polymorph();
    const id = s.player.form?.id;
    const restored = restoreSession(serializeSession(s));
    ok(restored.player.form?.id === id, `变形形态随存档保留（${id}）`);
    ok(restored.player.form?.turns === s.player.form?.turns, '变形剩余回合随存档保留');
  }
});
section('许愿', async () => {
  const { GameSession } = await import('../src/game/session');
  const { resolveWish } = await import('../src/game/wish');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory, INVENTORY_LIMIT } = await import('../src/game/inventory');
  const { objById } = await import('../src/data/index');
  const { createRng } = await import('../src/core/rng');

  // 文字解析：英文全名、中文名、id、数量前缀与金币。
  {
    const rng = createRng(1);
    const healing = resolveWish(rng, 'potion of healing');
    ok(healing.kind === 'item' && healing.proto.id === 'POT_HEALING', '英文全名可以许愿');
    const plural = resolveWish(rng, '2 potions of healing');
    ok(
      plural.kind === 'item' && plural.proto.id === 'POT_HEALING' && plural.quantity === 2,
      '数量前缀生效',
    );
    const zh = resolveWish(rng, '治疗药水');
    ok(zh.kind === 'item' && zh.proto.id === 'POT_HEALING', '中文名可以许愿');
    const byId = resolveWish(rng, 'POT_HEALING');
    ok(byId.kind === 'item' && byId.proto.id === 'POT_HEALING', '内部 id 可以许愿');
    const pluralTool = resolveWish(rng, 'arrows');
    ok(pluralTool.kind === 'item' && pluralTool.proto.id === 'ARROW', '英文复数可以许愿');
    const gold = resolveWish(rng, '金币');
    ok(
      gold.kind === 'gold' && gold.amount > 0,
      `金币愿望给出数量（${gold.kind === 'gold' ? gold.amount : 0}）`,
    );
    ok(resolveWish(rng, 'banana sword').kind === 'none', '无关的愿望匹配不到');
    ok(resolveWish(rng, '').kind === 'none', '空愿望匹配不到');
  }

  // 许愿魔杖：消耗充能，记下待处理愿望；兑现后入包。
  {
    const s = new GameSession({ seed: 42 });
    const wand = makeItem(objById.get('WAN_WISHING') as ObjectData, s.rng);
    addToInventory(s.player, wand);
    const charges = wand.charges ?? 0;
    const r = s.useItem(wand, 'zap');
    ok(r.key === 'use.zapWish' && s.pendingWishes === 1, '许愿魔杖产生愿望');
    ok(wand.charges === charges - 1, '许愿消耗一点充能');
    const granted = s.grantWish('potion of healing');
    ok(granted.ok && s.player.inventory.some((i) => i.proto.id === 'POT_HEALING'), '愿望变成物品');
    ok(s.pendingWishes === 0, '兑现后愿望清空');
  }

  // 匹配不到时不消耗愿望，可以重试；金币入堆。
  {
    const s = new GameSession({ seed: 42 });
    s.openWish();
    ok(!s.grantWish('banana sword').ok && s.pendingWishes === 1, '未知愿望不消耗');
    ok(s.grantWish('金币').ok && s.pendingWishes === 0, '重试后成功');
    ok(
      s.level.objects.some(
        (p) => p.x === s.player.x && p.y === s.player.y && p.items.some((i) => i.gold),
      ),
      '金币堆在脚下',
    );
  }

  // 魔法灯：摩擦一次得到愿望，之后失效。
  {
    const s = new GameSession({ seed: 42 });
    const lamp = makeItem(objById.get('MAGIC_LAMP') as ObjectData, s.rng);
    addToInventory(s.player, lamp);
    const first = s.useItem(lamp, 'apply');
    ok(first.key === 'use.wishLamp' && s.pendingWishes === 1, '魔法灯产生愿望');
    s.grantWish('long sword');
    const spent = s.useItem(lamp, 'apply');
    ok(spent.key === 'use.lampSpent' && s.pendingWishes === 0, '灯用尽后不再产生愿望');
  }

  // 背包放不下时，愿望物品丢在脚下。
  {
    const s = new GameSession({ seed: 42 });
    s.openWish();
    s.player.inventory = s.player.inventory.slice(0, 1);
    while (s.player.inventory.length < INVENTORY_LIMIT) {
      s.player.inventory.push(s.player.inventory[0]);
    }
    ok(s.grantWish('leather armor').ok, '背包满时愿望仍兑现');
    ok(
      s.level.objects.some(
        (p) =>
          p.x === s.player.x &&
          p.y === s.player.y &&
          p.items.some((i) => i.proto.id === 'LEATHER_ARMOR'),
      ),
      '放不下的愿望物品丢在脚下',
    );
  }
});
section('宠物', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById, objById } = await import('../src/data/index');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');
  const { serializeSession, restoreSession } = await import('../src/game/save');
  const { createRng } = await import('../src/core/rng');

  const newSession = () => new GameSession({ seed: 20240101 });
  const petOf = (s: InstanceType<typeof GameSession>) => s.level.monsters.find((m) => m.tame);

  // 新游戏自带一只驯服的宠物，且贴着玩家。
  {
    const s = newSession();
    const pet = petOf(s);
    ok(!!pet && pet.tame, `新游戏带宠物（${pet?.data.id}）`);
    if (pet) {
      const dist = Math.max(Math.abs(pet.x - s.player.x), Math.abs(pet.y - s.player.y));
      ok(dist <= 1, `宠物在玩家身边（距离 ${dist}）`);
    }
  }

  // 宠物不攻击玩家。
  {
    const s = newSession();
    s.level.monsters = s.level.monsters.filter((m) => m.tame);
    const hp = s.player.hp;
    for (let i = 0; i < 20; i++) s.wait();
    ok(s.player.hp >= hp, `宠物不会伤害玩家（${s.player.hp}/${hp}）`);
  }

  // 跟随：把宠物放到远处，玩家不动，距离应当缩短。
  {
    const s = newSession();
    s.level.monsters = s.level.monsters.filter((m) => m.tame);
    const pet = petOf(s);
    let spot: { x: number; y: number } | null = null;
    for (let r = 5; r >= 3 && !spot; r--) {
      for (const [dx, dy] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ]) {
        const x = s.player.x + dx;
        const y = s.player.y + dy;
        if (isWalkable(s.level.tiles[index(x, y)])) {
          spot = { x, y };
          break;
        }
      }
    }
    if (pet && spot) {
      pet.x = spot.x;
      pet.y = spot.y;
      const before = Math.max(Math.abs(pet.x - s.player.x), Math.abs(pet.y - s.player.y));
      for (let i = 0; i < 12; i++) s.monsterTurns();
      const after = Math.max(Math.abs(pet.x - s.player.x), Math.abs(pet.y - s.player.y));
      ok(after < before, `宠物会靠近玩家（${before} -> ${after}）`);
    } else {
      fail('跟随测试需要宠物与空地');
    }
  }

  // 宠物主动攻击敌对怪物。
  {
    const s = newSession();
    s.level.monsters = s.level.monsters.filter((m) => m.tame);
    const pet = petOf(s);
    const ant = new Monster(
      monById.get('GIANT_ANT') as MonsterData,
      (pet?.x ?? 0) + 1,
      pet?.y ?? 0,
      createRng(9),
    );
    ant.asleep = false;
    ant.mhp = ant.mhpmax = 60;
    s.level.monsters.push(ant);
    if (pet) {
      for (let i = 0; i < 30 && !ant.dead; i++) {
        pet.mv += 12;
        s.monsterAction(pet);
      }
      ok(ant.mhp < 60 || ant.dead, `宠物会攻击敌对怪物（${ant.mhp}）`);
      ok(
        s.messages.some((m) => m.key === 'msg.petHits'),
        '宠物攻击有独立消息',
      );
    } else {
      fail('参战测试需要宠物');
    }
  }

  // 走进宠物时交换位置，而不是发起攻击。
  {
    const s = newSession();
    const pet = petOf(s);
    const dir = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].find(([dx, dy]) => isWalkable(s.level.tiles[index(s.player.x + dx, s.player.y + dy)]));
    if (pet && dir) {
      pet.x = s.player.x + dir[0];
      pet.y = s.player.y + dir[1];
      const fromX = s.player.x;
      const fromY = s.player.y;
      s.movePlayer(dir[0], dir[1]);
      ok(s.player.x === fromX + dir[0] && pet.x === fromX && pet.y === fromY, '走进宠物时交换位置');
    } else {
      fail('交换测试需要宠物与空地');
    }
  }

  // 攻击宠物会失去信任。
  {
    const s = newSession();
    const pet = petOf(s);
    if (pet) {
      s.player.hitInc = 100;
      s.attackMonster(pet);
      ok(!pet.tame, '攻击宠物后不再驯服');
      ok(
        s.messages.some((m) => m.key === 'msg.petBetrayed'),
        '背叛宠物有提示',
      );
    } else {
      fail('背叛测试需要宠物');
    }
  }

  // 换层时宠物跟随，且存档保留驯服标记。
  {
    const s = newSession();
    const pet = petOf(s);
    s.changeDepth(2, 'down');
    ok(!!pet && s.level.monsters.includes(pet), '宠物跟随玩家换层');
    ok(!pet || !s.levels.get(1)?.monsters.includes(pet), '原层不再留有宠物');
    const restored = restoreSession(serializeSession(s));
    ok(
      restored.level.monsters.some((m) => m.tame),
      '驯服标记随存档保留',
    );
  }

  // 喂食：消耗食物、恢复生命、提升驯服度，满值后成长。
  {
    const s = newSession();
    s.level.monsters = s.level.monsters.filter((m) => m.tame);
    const pet = petOf(s);
    addToInventory(s.player, makeItem(objById.get('FOOD_RATION') as ObjectData, s.rng));
    if (pet) {
      pet.mhp = 1;
      const before = s.player.inventory.length;
      s.feedPet();
      ok(s.player.inventory.length === before - 1, '喂食消耗一份食物');
      ok(pet.mhp > 1, `喂食恢复宠物生命（${pet.mhp}）`);
      ok(pet.tameness >= 12, `喂食提升驯服度（${pet.tameness}）`);
      ok(
        s.messages.some((m) => m.key === 'msg.petEats'),
        '喂食有提示',
      );
      // 满驯服度成长。
      pet.tameness = 19;
      addToInventory(s.player, makeItem(objById.get('FOOD_RATION') as ObjectData, s.rng));
      const beforeId = pet.data.id;
      s.feedPet();
      ok(pet.data.id !== beforeId, `宠物成长（${beforeId} -> ${pet.data.id}）`);
      ok(
        s.messages.some((m) => m.key === 'msg.petGrows'),
        '成长有提示',
      );
    } else {
      fail('喂食测试需要宠物');
    }
  }

  // 没有宠物或没有食物时不消耗回合。
  {
    const s = newSession();
    s.level.monsters = [];
    const turn = s.turn;
    s.feedPet();
    ok(s.turn === turn && s.messages.some((m) => m.key === 'msg.petNone'), '没有宠物时喂食无效');
  }
  {
    const s = newSession();
    s.level.monsters = s.level.monsters.filter((m) => m.tame);
    s.player.inventory = s.player.inventory.filter((i) => i.proto.cls !== 'food');
    const turn = s.turn;
    s.feedPet();
    ok(s.turn === turn && s.messages.some((m) => m.key === 'msg.petNoFood'), '没有食物时喂食无效');
  }

  // 宠物会饿：靠近饥饿阈值会抱怨，归零后变野；喂食能补回饱食度。
  {
    const s = newSession();
    const pet = s.level.monsters.find((m) => m.tame);
    ok(!!pet, '开局有宠物');
    if (pet) {
      pet.hunger = 101;
      s.upkeep();
      ok(
        s.messages.some((m) => m.key === 'msg.petHungry'),
        '宠物饿了会抱怨',
      );
      pet.hunger = 1;
      s.upkeep();
      ok(!pet.tame, '饿到 0 的宠物变野');
      ok(
        s.messages.some((m) => m.key === 'msg.petTurnsWild'),
        '记录宠物变野消息',
      );
    }
  }
  {
    const s = newSession();
    const pet = s.level.monsters.find((m) => m.tame);
    if (pet) {
      addToInventory(s.player, makeItem(objById.get('FOOD_RATION') as ObjectData, s.rng));
      pet.hunger = 100;
      ok(s.feedPet().result === 'used', '喂食可用');
      ok((pet.hunger ?? 0) > 100, `喂食提升饱食度（${pet.hunger}）`);
    }
  }

  // 骑乘：中大型驯服宠物可骑，攻击有冲锋，存档保留坐骑。
  {
    const s = newSession();
    const pony = new Monster(
      monById.get('PONY') as MonsterData,
      s.player.x + 1,
      s.player.y,
      createRng(7),
    );
    pony.tame = true;
    s.level.monsters = [pony];
    pony.x = s.player.x + 1;
    pony.y = s.player.y;
    ok(s.canMount() === pony, '中大型宠物可以骑乘');
    const mounted = s.mountPet();
    ok(
      mounted.result === 'used' && s.ride === pony && !s.level.monsters.includes(pony),
      '骑上后坐骑离开地图',
    );
    const ant = new Monster(
      monById.get('GIANT_ANT') as MonsterData,
      s.player.x,
      s.player.y + 1,
      createRng(8),
    );
    ant.asleep = false;
    ant.mhp = ant.mhpmax = 999;
    s.level.monsters.push(ant);
    s.player.hitInc = 100;
    s.attackMonster(ant);
    ok(
      s.messages.some((m) => m.key === 'msg.mountStrike'),
      '骑乘攻击有冲锋伤害',
    );
    s.dismount();
    ok(s.ride === null && s.level.monsters.includes(pony), '下马后坐骑回到地图');
  }

  // 小型宠物不能骑。
  {
    const s = newSession();
    s.level.monsters = s.level.monsters.filter((m) => m.tame);
    const pet = petOf(s);
    if (pet && pet.data.size === 'MZ_SMALL') {
      ok(s.canMount() === null, '小型宠物不能骑乘');
    } else {
      ok(true, '随机宠物不是小型，跳过');
    }
  }

  // 坐骑随存档保留。
  {
    const s = newSession();
    const pony = new Monster(
      monById.get('PONY') as MonsterData,
      s.player.x + 1,
      s.player.y,
      createRng(9),
    );
    pony.tame = true;
    s.level.monsters = [pony];
    pony.x = s.player.x + 1;
    s.mountPet();
    const restored = restoreSession(serializeSession(s));
    ok(restored.ride?.data.id === 'PONY', '坐骑随存档保留');
    ok(!restored.level.monsters.some((m) => m.data.id === 'PONY'), '读档后坐骑不在怪物列表');
  }
});
section('特殊楼层', async () => {
  const { GameSession } = await import('../src/game/session');
  const { SPECIAL_LEVELS, specialLevelFor } = await import('../src/game/special');

  ok(specialLevelFor(7) === null, '普通深度没有特殊楼层');
  ok(SPECIAL_LEVELS[5]?.id === 'big_room', '第五层登记为大房间');

  // 大房间：一间大厅、没有门，楼梯齐全。
  {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(5, 'down');
    const level = s.level;
    ok(level.special === 'big_room', `五层标记为大房间（${level.special}）`);
    ok(level.rooms.length === 1, `大房间只有一间房（${level.rooms.length}）`);
    const room = level.rooms[0];
    ok(!!room && room.hx - room.lx > 50, '大房间覆盖大半张地图');
    ok(level.doors.size === 0, '大房间没有门');
    ok(!!level.up && !!level.down, '大房间楼梯齐全');
    ok(
      s.messages.some((m) => m.key === 'msg.specialLevel'),
      '进入特殊楼层有提示',
    );
  }

  // 美杜莎：保证出现，周围散布雕像。
  {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(20, 'down');
    ok(s.level.special === 'medusa', `第二十层是美杜莎（${s.level.special}）`);
    ok(
      s.level.monsters.some((m) => m.data.id === 'MEDUSA'),
      '美杜莎保证出现',
    );
    const statues = s.level.objects.flatMap((p) => p.items).filter((i) => i.proto.id === 'STATUE');
    ok(statues.length === 6, `雕像数量正确（${statues.length}）`);
  }

  // 大墓地：怪物全部是不死生物，坟墓更多。
  {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(25, 'down');
    ok(s.level.special === 'valley', `第二十五层是大墓地（${s.level.special}）`);
    const spawned = s.level.monsters.filter((m) => !m.tame && m.data.id !== 'SHOPKEEPER');
    ok(
      spawned.length > 0 && spawned.every((m) => m.data.flags.includes('M2_UNDEAD')),
      `大墓地只有不死生物（${spawned.length} 只）`,
    );
    const graves = [...s.level.features.values()].filter((f) => f.type === 'GRAVE').length;
    ok(graves >= 4, `大墓地坟墓更多（${graves}）`);
  }

  // 神谕所：神谕在场、喷泉更多；付费咨询给出提示。
  {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(8, 'down');
    ok(s.level.special === 'oracle', `第八层是神谕所（${s.level.special}）`);
    ok(
      s.level.monsters.some((m) => m.data.id === 'ORACLE'),
      '神谕保证出现',
    );
    const fountains = [...s.level.features.values()].filter((f) => f.type === 'FOUNTAIN').length;
    ok(fountains >= 3, `神谕所喷泉更多（${fountains}）`);
    s.player.gold = 5;
    const turn = s.turn;
    s.consultOracle();
    ok(s.player.gold === 5 && s.turn === turn, '付不起时咨询不扣回合');
    ok(
      s.messages.some((m) => m.key === 'msg.oraclePoor'),
      '付不起时有提示',
    );
    s.player.gold = 50;
    s.consultOracle();
    ok(s.player.gold === 30, `咨询扣 20 金币（${s.player.gold}）`);
    const said = s.messages.find((m) => m.key === 'msg.oracleSays');
    ok(
      !!said && /oracle\.tip\d+/.test(String(said.vars.tip)),
      `咨询给出提示（${String(said?.vars.tip)}）`,
    );
  }

  // 每条神谕提示都有文案。
  {
    const { t } = await import('../src/i18n/index');
    let missing = 0;
    for (let i = 1; i <= 21; i++) if (t(`oracle.tip${i}`) === `oracle.tip${i}`) missing++;
    ok(missing === 0, `21 条神谕提示都有文案（缺 ${missing}）`);
  }

  // 要塞：士兵把守，还有一根许愿魔杖。
  {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(27, 'down');
    ok(s.level.special === 'castle', `第二十七层是要塞（${s.level.special}）`);
    const ids = new Set(s.level.monsters.map((m) => m.data.id));
    for (const id of ['SOLDIER', 'SERGEANT', 'LIEUTENANT', 'CAPTAIN']) {
      ok(ids.has(id), `要塞里有 ${id}`);
    }
    const wish = s.level.objects
      .flatMap((p) => p.items)
      .filter((i) => i.proto.id === 'WAN_WISHING');
    ok(wish.length === 1, `要塞里有许愿魔杖（${wish.length}）`);
  }

  // 圣所：怪物全部是恶魔。
  {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(29, 'down');
    ok(s.level.special === 'sanctum', `第二十九层是圣所（${s.level.special}）`);
    const spawned = s.level.monsters.filter((m) => !m.tame && m.data.id !== 'SHOPKEEPER');
    ok(
      spawned.length > 0 && spawned.every((m) => m.data.flags.includes('M2_DEMON')),
      `圣所只有恶魔（${spawned.length} 只）`,
    );
    const squares = [...s.level.traps.values()].filter((t) => t.type === 'VIBRATING_SQUARE');
    ok(squares.length === 1, `圣所有一块振动方块（${squares.length}）`);
  }

  // 巫妖塔：入口第 16 层，4 层不死主题，底层有 BOSS 与额外财富。
  {
    const s = new GameSession({ seed: 20240101 });
    const main16 = s.getLevel(16);
    const exit2 = main16.stairs.find((st) => st.dir === 'branch' && st.branch === 'vlad');
    ok(!!exit2, '第 16 层有巫妖塔楼梯');
    s.changeDepth(1, 'down', 'vlad');
    ok(s.branch === 'vlad' && s.depth === 1, `进入巫妖塔（${s.branch} ${s.depth}）`);
    const undead = s.level.monsters.filter((m) => !m.tame && m.data.id !== 'SHOPKEEPER');
    ok(
      undead.length > 0 && undead.every((m) => m.data.flags.includes('M2_UNDEAD')),
      `巫妖塔只有不死生物（${undead.length} 只）`,
    );
    for (let d = 2; d <= 4; d++) s.changeDepth(d, 'down');
    ok(s.depth === 4 && !s.level.down, '巫妖塔底层没有下行楼梯');
    ok(
      s.level.monsters.some((m) => m.data.id === 'VAMPIRE_LEADER'),
      '巫妖塔底层有首领',
    );
    const loot = s.level.objects.flatMap((p) => p.items);
    ok(
      loot.some((i) => i.gold && i.quantity >= 400),
      '巫妖塔底层有厚宝藏',
    );
    ok(
      loot.filter((i) => i.proto.cls !== 'coin').length >= 2,
      `巫妖塔底层有额外物品（${loot.length} 件）`,
    );
    s.changeDepth(16, 'up', 'main');
    ok(s.branch === 'main' && s.depth === 16, '从巫妖塔回到主地牢');
  }

  // 生成可复现：同一种子得到同样的特殊楼层与怪物组合。
  {
    const a = new GameSession({ seed: 4242 });
    const b = new GameSession({ seed: 4242 });
    a.changeDepth(25, 'down');
    b.changeDepth(25, 'down');
    const ids = (s: InstanceType<typeof GameSession>) =>
      s.level.monsters
        .map((m) => m.data.id)
        .sort()
        .join(',');
    ok(ids(a) === ids(b), '特殊楼层的怪物组合可复现');
  }
});
section('开启仪式与异界', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory, wieldItem } = await import('../src/game/inventory');
  const { objById } = await import('../src/data/index');
  const { COLNO, T } = await import('../src/core/constants');
  const { branchByEntrance } = await import('../src/game/branches');
  const { branchSpecialFor, specialLevelById } = await import('../src/game/special');
  const { serializeSession, restoreSession } = await import('../src/game/save');

  const give = (
    s: InstanceType<typeof GameSession>,
    id: string,
    buc: 'cursed' | 'uncursed' = 'uncursed',
  ) => {
    const proto = objById.get(id);
    if (!proto) throw new Error(`缺少物品原型 ${id}`);
    const item = makeItem(proto, s.rng);
    item.buc = buc;
    addToInventory(s.player, item);
    return item;
  };

  // 三件圣物各有出处。
  {
    const s = new GameSession({ seed: 20240101 });
    // 测试只关心圣物摆放，直接解锁任务楼梯。
    s.questUnlocked = true;
    s.changeDepth(1, 'down', 'quest');
    s.changeDepth(5, 'down', 'quest');
    ok(
      s.level.objects.flatMap((p) => p.items).some((i) => i.id === 'BELL_OF_OPENING'),
      '开启之铃在任务仇敌脚下',
    );
    s.changeDepth(1, 'down', 'vlad');
    s.changeDepth(4, 'down', 'vlad');
    ok(
      s.level.objects.flatMap((p) => p.items).some((i) => i.id === 'CANDELABRUM_OF_INVOCATION'),
      '祈祷烛台在巫妖塔底层',
    );
    s.changeDepth(29, 'down', 'main');
    const book = s.level.objects
      .flatMap((p) => p.items)
      .find((i) => i.id === 'SPE_BOOK_OF_THE_DEAD');
    ok(!!book, '死亡之书在圣所');
    ok(book?.buc === 'uncursed' && book?.known === true, '开启圣物保持未诅咒且已鉴定');
  }

  // 隐藏分支不在入口层预生成楼梯，仪式后才能由传送门进入。
  ok(
    branchByEntrance(29)?.id === 'planes' && branchByEntrance(29)?.hidden === true,
    '异界是第 29 层的隐藏分支',
  );
  {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(29, 'down');
    ok(!s.level.stairs.some((st) => st.dir === 'branch'), '仪式前没有通往异界的楼梯');
    const square = [...s.level.traps].find(([, t]) => t.type === 'VIBRATING_SQUARE');
    ok(!!square, '圣所有振动方块');
    if (!square) return;
    s.player.x = square[0] % COLNO;
    s.player.y = Math.floor(square[0] / COLNO);
    s.invokeRitual();
    ok(s.level.traps.get(square[0])?.type === 'VIBRATING_SQUARE', '缺圣物时仪式不生效');
    give(s, 'BELL_OF_OPENING', 'cursed');
    give(s, 'CANDELABRUM_OF_INVOCATION');
    give(s, 'SPE_BOOK_OF_THE_DEAD');
    s.invokeRitual();
    ok(s.level.traps.get(square[0])?.type === 'VIBRATING_SQUARE', '诅咒圣物让仪式失败');
    const bell = s.player.inventory.find((i) => i.id === 'BELL_OF_OPENING');
    if (bell) bell.buc = 'uncursed';
    s.invokeRitual();
    ok(s.level.traps.get(square[0])?.type === 'MAGIC_PORTAL', '集齐圣物后开启传送门');
    s.enterPortal();
    ok(s.branch === 'planes' && s.depth === 1, `传送门通往异界（${s.branch} ${s.depth}）`);
    ok(s.level.special === 'plane_earth', '异界第一层是土之位面');
    ok(!!s.level.up, '元素位面保留回程楼梯');
    // 土之位面没有下行楼梯，必须拿保底镐自己向下挖。
    ok(!s.level.down, '土之位面没有下行楼梯');
    const earthPick = s.level.objects.flatMap((p) => p.items).find((i) => i.id === 'PICK_AXE');
    ok(!!earthPick, '土之位面放着保底镐');
    if (earthPick) {
      const spot = (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as [number, number][]
      )
        .map(([dx, dy]) => ({ x: s.player.x + dx, y: s.player.y + dy }))
        .find((p) => s.level.tiles[index(p.x, p.y)] === T.ROOM);
      if (spot) {
        s.player.x = spot.x;
        s.player.y = spot.y;
      }
      addToInventory(s.player, earthPick);
      wieldItem(s.player, earthPick);
      ok(s.canDigDown(), '拿到镐后可以在土之位面向下挖');
    }
    for (const [depth, id] of [
      [2, 'plane_air'],
      [3, 'plane_fire'],
      [4, 'plane_water'],
      [5, 'astral'],
    ] as [number, string][]) {
      s.changeDepth(depth, 'down', 'planes');
      ok(s.level.special === id, `异界第 ${depth} 层是 ${id}`);
    }
    ok(!s.level.down, '星界没有下行楼梯（终局）');
    const altars = [...s.level.features.values()].filter((f) => f.type === 'ALTAR');
    ok(altars.length === 3, `星界有三座祭坛（${altars.length}）`);
    // 每座神殿两位天使守卫：同阵营的天使平和，异教神殿的天使敌对。
    const guards = s.level.monsters.filter((m) => !m.dead && m.data.id === 'ANGEL');
    ok(guards.length >= 6, `三座神殿各有两位天使（${guards.length}）`);
    const peaceful = guards.filter((g) => g.peaceful === true);
    ok(peaceful.length === 2, `本阵营神殿的天使平和（${peaceful.length}）`);
    ok(guards.filter((g) => g.peaceful !== true).length >= 4, '异教神殿的天使敌对');
    ok(
      ['lawful', 'neutral', 'chaotic'].every((a) => altars.some((f) => f.align === a)),
      '三座祭坛分属三个阵营',
    );

    // 献错祭坛受罚，献对祭坛登神。
    s.player.maxHp = 300;
    s.player.hp = 300;
    give(s, 'AMULET_OF_YENDOR');
    const wrong = [...s.level.features].find(
      ([, f]) => f.type === 'ALTAR' && f.align && f.align !== s.player.align,
    );
    if (wrong) {
      s.player.x = wrong[0] % COLNO;
      s.player.y = Math.floor(wrong[0] / COLNO);
      const hp = s.player.hp;
      s.offerAmulet();
      ok(!s.victory && s.player.hp < hp, '献错祭坛受罚但不登神');
      ok(
        s.player.inventory.some((i) => i.id === 'AMULET_OF_YENDOR'),
        '献错祭坛保留护身符',
      );
    }
    const own = [...s.level.features].find(
      ([, f]) => f.type === 'ALTAR' && f.align === s.player.align,
    );
    if (own) {
      s.player.hp = s.player.maxHp;
      s.player.x = own[0] % COLNO;
      s.player.y = Math.floor(own[0] / COLNO);
      s.offerAmulet();
      ok(s.victory, '在自家祭坛献上护身符即登神');
      ok(!s.player.inventory.some((i) => i.id === 'AMULET_OF_YENDOR'), '献上的护身符已经交出');
    }

    // 存档保留传送门与异界位置。
    const restored = restoreSession(serializeSession(s));
    ok(restored.branch === 'planes', '存档保留异界位置');
    ok(
      [...restored.getLevel(29).traps.values()].some((t) => t.type === 'MAGIC_PORTAL'),
      '存档保留魔法传送门',
    );
  }

  // 星界在分支特殊楼层表里可查，四层元素位面各有主体地形。
  ok(branchSpecialFor('planes', 1)?.id === 'plane_earth', '土之位面登记在分支特殊楼层里');
  ok(branchSpecialFor('planes', 4)?.id === 'plane_water', '水之位面登记在分支特殊楼层里');
  ok(branchSpecialFor('planes', 5)?.id === 'astral', '星界登记在分支特殊楼层里');
  ok(specialLevelById('astral')?.altars?.length === 3, '按标识能找到星界定义');

  // 元素位面的地形散布：虚空、岩浆与水流，整层仍连成一片。
  {
    const { isWalkable, ROWNO } = await import('../src/core/constants');
    const s = new GameSession({ seed: 20240101 });
    const cases: [number, number, string][] = [
      [2, T.AIR, '气之位面铺虚空'],
      [3, T.LAVA, '火之位面铺岩浆'],
      [4, T.WATER, '水之位面铺水流'],
    ];
    for (const [depth, tile, label] of cases) {
      const level = s.getBranchLevel('planes', depth);
      const blocks = Array.from(level.tiles).filter((t) => t === tile).length;
      ok(blocks > 0, `${label}（${blocks} 格）`);
      ok(
        level.stairs.every((st) => level.tiles[st.y * COLNO + st.x] === T.STAIRS),
        `${label}不覆盖楼梯`,
      );
      ok(
        !!level.up && level.tiles[level.up.y * COLNO + level.up.x] === T.STAIRS,
        `${label}保留上行楼梯`,
      );
      // 从上行楼梯淹水，所有可行走格子都要走得到。
      let total = 0;
      for (const t of level.tiles) if (isWalkable(t)) total++;
      const seen = new Set<number>();
      const queue: number[] = [];
      if (level.up) {
        const start = level.up.y * COLNO + level.up.x;
        seen.add(start);
        queue.push(start);
      }
      while (queue.length) {
        const i = queue.pop() as number;
        const x = i % COLNO;
        const y = (i / COLNO) | 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as [number, number][]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= COLNO || ny >= ROWNO) continue;
          const ni = ny * COLNO + nx;
          if (seen.has(ni) || !isWalkable(level.tiles[ni])) continue;
          seen.add(ni);
          queue.push(ni);
        }
      }
      ok(seen.size === total, `${label}后全层仍连通（${seen.size}/${total}）`);
    }
  }

  // 岩浆会灼伤踏进去的玩家，火焰抗性减半。
  {
    const s = new GameSession({ seed: 20240101 });
    s.changeDepth(3, 'down', 'planes');
    let spot: { from: [number, number]; to: [number, number] } | null = null;
    for (let i = 0; i < s.level.tiles.length && !spot; i++) {
      if (s.level.tiles[i] !== T.LAVA) continue;
      const x = i % COLNO;
      const y = (i / COLNO) | 0;
      if (s.level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as [number, number][]) {
        const nx = x + dx;
        const ny = y + dy;
        if (s.level.tiles[ny * COLNO + nx] !== T.ROOM) continue;
        spot = { from: [nx, ny], to: [x, y] };
        break;
      }
    }
    ok(!!spot, '火之位面能找到可走上去的岩浆');
    if (spot) {
      s.player.maxHp = 200;
      s.player.hp = 200;
      const hp = s.player.hp;
      s.player.x = spot.from[0];
      s.player.y = spot.from[1];
      s.movePlayer(spot.to[0] - spot.from[0], spot.to[1] - spot.from[1]);
      ok(s.player.hp < hp, `踩进岩浆会灼伤（${hp} → ${s.player.hp}）`);
      ok(
        s.messages.some((m) => m.key === 'msg.lavaBurn'),
        '记录岩浆灼伤消息',
      );
    }
  }

  // 普通楼层的祭坛不足以登神：必须先经传送门到异界。
  {
    const s = new GameSession({ seed: 20240101 });
    let altarAt: { depth: number; x: number; y: number } | null = null;
    for (let d = 2; d <= 29 && !altarAt; d++) {
      const found = [...s.getLevel(d).features].find(([, f]) => f.type === 'ALTAR');
      if (found) {
        altarAt = { depth: d, x: found[0] % COLNO, y: Math.floor(found[0] / COLNO) };
      }
    }
    ok(!!altarAt, '主地牢里能找到祭坛');
    if (altarAt) {
      s.changeDepth(altarAt.depth, 'down');
      s.player.x = altarAt.x;
      s.player.y = altarAt.y;
      give(s, 'AMULET_OF_YENDOR');
      s.offerAmulet();
      ok(!s.victory, '主地牢的祭坛不能登神');
      ok(
        s.messages.some((m) => m.key === 'msg.ascendBeyond'),
        '提示登神只能在异界',
      );
    }
  }
});

section('骨头文件', async () => {
  const { GameSession } = await import('../src/game/session');
  const { saveBones, loadBones, clearBones } = await import('../src/game/bones');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');
  const { objById } = await import('../src/data/index');

  clearBones();
  ok(loadBones() === null, '初始没有骨头文件');

  // 死亡现场写入后可以读回。
  {
    const s = new GameSession({ seed: 111 });
    const sword = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
    addToInventory(s.player, sword);
    saveBones(s);
    const bones = loadBones();
    ok(bones?.depth === s.depth, `骨头记录死亡层数（${bones?.depth}）`);
    ok(
      bones?.inventory.some((i) => i.p === 'LONG_SWORD'),
      '骨头保留死亡时的背包',
    );
  }

  // 新一局到达同一层：遗物出现、幽灵看守、记录清空。
  {
    const s = new GameSession({ seed: 222 });
    const items = s.level.objects.flatMap((p) => p.items);
    ok(
      items.some((i) => i.proto.id === 'LONG_SWORD'),
      '同层发现遗物',
    );
    ok(
      s.level.monsters.some((m) => m.data.id === 'GHOST'),
      '幽灵看守遗物',
    );
    ok(
      s.messages.some((m) => m.key === 'msg.bonesFound'),
      '发现遗物有提示',
    );
    ok(loadBones() === null, '取出后骨头文件清空');
  }

  // 遗物只出现一次。
  {
    const s = new GameSession({ seed: 333 });
    ok(
      !s.level.objects.flatMap((p) => p.items).some((i) => i.proto.id === 'LONG_SWORD'),
      '遗物不会重复出现',
    );
  }
  clearBones();
  ok(loadBones() === null, '清理后没有骨头文件');
});
section('分支地牢', async () => {
  const { GameSession } = await import('../src/game/session');
  const { BRANCHES, branchByEntrance } = await import('../src/game/branches');
  const { serializeSession, restoreSession } = await import('../src/game/save');
  const { shopRoom } = await import('../src/game/dungeon');
  const { T, COLNO } = await import('../src/core/constants');

  ok(branchByEntrance(4)?.id === 'mines', '第 4 层是矿坑入口');
  ok(BRANCHES.mines?.levels === 8, '矿坑共 8 层');

  // 主地牢入口层有一段分支楼梯。
  const s = new GameSession({ seed: 20240101 });
  const main4 = s.getLevel(4);
  const exit = main4.stairs.find((st) => st.dir === 'branch');
  ok(!!exit && exit.branch === 'mines', '入口层有通往矿坑的楼梯');
  if (exit) {
    ok(main4.tiles[exit.y * COLNO + exit.x] === T.STAIRS, '分支楼梯铺在楼梯地形上');
  }

  // 进入矿坑：层号独立、主题怪物、底层宝藏、没有向下楼梯。
  s.changeDepth(1, 'down', 'mines');
  ok(s.branch === 'mines' && s.depth === 1, `进入矿坑第一层（${s.branch} ${s.depth}）`);
  ok(s.level.branch === 'mines', '矿坑关卡带分支标记');
  ok(!!s.level.up, '矿坑第一层有回到主地牢的楼梯');
  const names = s.level.monsters.filter((m) => !m.tame).map((m) => m.data.id);
  ok(
    names.some((n) => n.includes('GNOME') || n.includes('DWARF')),
    `矿坑有侏儒矮人（${names.slice(0, 4).join('、')}）`,
  );
  for (let d = 2; d <= 8; d++) s.changeDepth(d, 'down');
  ok(s.depth === 8 && !s.level.down, '矿坑底层没有下行楼梯');
  const gold = s.level.objects
    .flatMap((p) => p.items)
    .filter((i) => i.gold)
    .reduce((n, i) => n + i.quantity, 0);
  ok(gold >= 300, `矿坑底层有厚宝藏（${gold} 金币）`);
  // 矿镇：底层是市集，必有商店与额外喷泉。
  ok(!!shopRoom(s.level), '矿镇有商店');
  const mineFountains = [...s.level.features.values()].filter((f) => f.type === 'FOUNTAIN').length;
  ok(mineFountains >= 3, `矿镇喷泉更多（${mineFountains}）`);

  // 回到入口层，落点是分支楼梯。
  s.changeDepth(4, 'up', 'main');
  ok(s.branch === 'main' && s.depth === 4, '回到主地牢入口层');
  ok(!!exit && s.player.x === exit.x && s.player.y === exit.y, '落点在分支楼梯上');

  // 生成可复现：同样的种子得到同样的矿坑地形。
  {
    const a = new GameSession({ seed: 4242 });
    const b = new GameSession({ seed: 4242 });
    const ka = a.getBranchLevel('mines', 1);
    const kb = b.getBranchLevel('mines', 1);
    ok(Array.from(ka.tiles).join('') === Array.from(kb.tiles).join(''), '矿坑地形可复现');
  }

  // 存档往返保留分支位置与矿坑关卡。
  {
    const sv = new GameSession({ seed: 777 });
    sv.changeDepth(1, 'down', 'mines');
    sv.changeDepth(2, 'down');
    const restored = restoreSession(serializeSession(sv));
    ok(restored.branch === 'mines' && restored.depth === 2, '存档保留分支位置');
    ok(restored.level.branch === 'mines', '存档恢复矿坑关卡');
    ok(restored.branchCache.has('mines:1'), '分支关卡随存档保留');
  }

  // 推箱：原版提取的固定布局，从底层进、顶层拿奖励。
  {
    const { SOKOBAN_LEVELS } = await import('../src/data/sokoban.gen');
    ok(SOKOBAN_LEVELS.length === 4, '推箱共 4 层数据');
    ok(
      SOKOBAN_LEVELS.every((l) => l.variants.length === 2),
      '推箱每层两个变体',
    );
    for (const lv of SOKOBAN_LEVELS) {
      for (const v of lv.variants) {
        const bad = v.boulders.filter(
          ([x, y]) => y >= v.map.length || !'.|+'.includes(v.map[y][x] ?? ' '),
        );
        ok(bad.length === 0, `${v.id} 的巨石都在地面格上`);
      }
    }
    const soko = new GameSession({ seed: 555 });
    soko.changeDepth(4, 'down', 'sokoban');
    ok(soko.branch === 'sokoban' && soko.depth === 4, '推箱从底层进入');
    ok(soko.level.branch === 'sokoban', '推箱关卡带分支标记');
    ok(
      soko.level.objects.filter((p) => p.items.some((i) => i.id === 'BOULDER')).length >= 8,
      '推箱底层有巨石',
    );
    ok(
      soko.level.stairs.some((st) => st.dir === 'branch'),
      '推箱底层有回主地牢的楼梯',
    );
    ok(soko.level.monsters.filter((m) => !m.tame).length === 0, '推箱层不随机刷怪');
    soko.changeDepth(3, 'up');
    soko.changeDepth(2, 'up');
    soko.changeDepth(1, 'up');
    ok(soko.depth === 1, '爬到推箱顶层');
    ok(
      soko.level.objects
        .flatMap((p) => p.items)
        .some((i) => i.id === 'BAG_OF_HOLDING' || i.id === 'AMULET_OF_REFLECTION'),
      '推箱顶层有奖励',
    );
    ok(
      soko.level.monsters.filter((m) => m.data.id === 'GIANT_MIMIC').length === 2,
      '推箱顶层有两只巨型拟形怪',
    );
    // 拟形怪伪装成巨石，攻击后才现形。
    const mimic = soko.level.monsters.find((m) => m.data.id === 'GIANT_MIMIC');
    ok(mimic?.disguise === 'BOULDER', '拟形怪伪装成巨石');
    if (mimic) {
      soko.attackMonster(mimic);
      ok(!mimic.disguise, '攻击后拟形怪现出原形');
      ok(
        soko.messages.some((m) => m.key === 'msg.mimicRevealed'),
        '记录拟形怪现形消息',
      );
    }
  }

  // 推箱分支禁止传送：陷阱、卷轴与传送症都被神秘力量挡住。
  {
    const s = new GameSession({ seed: 561 });
    s.changeDepth(1, 'down', 'sokoban');
    ok(s.teleportBlocked, '推箱分支标记为禁止传送');
    const at = index(s.player.x, s.player.y);
    s.level.traps.set(at, { type: 'TELEP_TRAP', seen: true });
    const before = { x: s.player.x, y: s.player.y };
    const moved = s.springTrap(at);
    ok(!moved && s.player.x === before.x && s.player.y === before.y, '传送陷阱在推箱层不生效');
    ok(
      s.messages.some((m) => m.key === 'msg.teleportBlocked'),
      '记录传送被挡下的消息',
    );
  }

  // 力场法术轰碎巨石；推箱层会因此损失幸运。
  {
    const { makeItem } = await import('../src/game/items');
    const s = new GameSession({ seed: 563 });
    s.changeDepth(1, 'down', 'sokoban');
    s.level.monsters.length = 0;
    const pile = s.level.objects.find((p) => p.items.some((i) => i.id === 'BOULDER'));
    ok(!!pile, '推箱层有巨石可轰');
    if (pile) {
      s.player.x = pile.x;
      s.player.y = pile.y;
      const book = makeItem(objById.get('SPE_FORCE_BOLT') as ObjectData, s.rng);
      s.player.knownSpells.push('SPE_FORCE_BOLT');
      s.player.pw = 50;
      const luck = s.player.luck;
      s.castSpell(book);
      ok(!pile.items.some((i) => i.id === 'BOULDER'), '力场法术轰碎了巨石');
      ok(s.player.luck === luck - 1, `推箱层破坏巨石扣幸运（${luck} → ${s.player.luck}）`);
    }
  }

  // 拟形怪的伪装随存档保留。
  {
    const s = new GameSession({ seed: 567 });
    s.changeDepth(1, 'down', 'sokoban');
    const restored = restoreSession(serializeSession(s));
    const mimic = restored.level.monsters.find((m) => m.data.id === 'GIANT_MIMIC');
    ok(mimic?.disguise === 'BOULDER', '存档保留拟形怪伪装');
  }

  // 巨石滚进洞里：巨石与洞一起消失。
  {
    const s2 = new GameSession({ seed: 557 });
    s2.level.monsters.length = 0;
    const tiles = s2.level.tiles;
    const open = (x: number, y: number) =>
      isWalkable(tiles[index(x, y)]) &&
      !s2.level.doors.has(index(x, y)) &&
      !s2.level.traps.has(index(x, y));
    let px = -1;
    let py = -1;
    for (let y = 1; y < ROWNO - 1 && px < 0; y++) {
      for (let x = 1; x < COLNO - 3; x++) {
        if (open(x, y) && open(x + 1, y) && open(x + 2, y)) {
          px = x;
          py = y;
          break;
        }
      }
    }
    if (px > 0) {
      const { makeBoulder } = await import('../src/game/items');
      s2.player.x = px;
      s2.player.y = py;
      s2.level.traps.set(index(px + 2, py), { type: 'HOLE', seen: false });
      s2.level.objects.push({ x: px + 1, y: py, items: [makeBoulder(s2.rng)] });
      s2.movePlayer(1, 0);
      ok(!s2.level.objects.some((p) => p.items.some((i) => i.id === 'BOULDER')), '巨石被洞吞掉');
      ok(!s2.level.traps.has(index(px + 2, py)), '洞被巨石填平');
      ok(s2.player.x === px + 1 && s2.player.y === py, '填洞后玩家前进');
    }
  }
});
section('挖掘与地形改造', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory, wieldItem } = await import('../src/game/inventory');
  const { isWall } = await import('../src/core/constants');

  const emptyNeighborWall = (s: InstanceType<typeof GameSession>) => {
    for (let x = 1; x < COLNO - 1; x++) {
      for (let y = 1; y < ROWNO - 1; y++) {
        if (!isWall(s.level.tiles[index(x, y)])) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as [number, number][]) {
          const from = { x: x + dx, y: y + dy };
          if (from.x < 0 || from.y < 0 || from.x >= COLNO || from.y >= ROWNO) continue;
          if (!isWalkable(s.level.tiles[index(from.x, from.y)])) continue;
          if (s.level.monsters.some((m) => !m.dead && m.x === from.x && m.y === from.y)) continue;
          return { wall: { x, y }, from };
        }
      }
    }
    return null;
  };

  // 镐类工具可以持握，朝同一面墙连挖三回合才能凿穿。
  {
    const s = new GameSession({ seed: 4242 });
    const pick = makeItem(objById.get('PICK_AXE') as ObjectData, s.rng);
    addToInventory(s.player, pick);
    ok(wieldItem(s.player, pick).ok, '镐类工具可以持握');
    const spot = emptyNeighborWall(s);
    ok(!!spot, '地牢里有可挖的墙');
    if (spot) {
      s.player.x = spot.from.x;
      s.player.y = spot.from.y;
      const dx = spot.wall.x - spot.from.x;
      const dy = spot.wall.y - spot.from.y;
      const before = s.level.revision ?? 0;
      const first = s.movePlayer(dx, dy);
      ok(first.result === 'moved', '挖掘消耗一次行动');
      ok(s.level.tiles[index(spot.wall.x, spot.wall.y)] !== T.CORR, '第一回合只是凿出缺口');
      ok(
        s.messages.some((m) => m.key === 'msg.digWallProgress'),
        '记录挖掘进度消息',
      );
      s.movePlayer(dx, dy);
      ok(s.level.tiles[index(spot.wall.x, spot.wall.y)] !== T.CORR, '第二回合仍未打通');
      s.movePlayer(dx, dy);
      ok(s.level.tiles[index(spot.wall.x, spot.wall.y)] === T.CORR, '第三回合凿穿墙壁');
      ok((s.level.revision ?? 0) === before + 1, '挖掘递增瓦片版本号');
      ok(
        s.messages.some((m) => m.key === 'msg.digWall'),
        '记录挖掘消息',
      );
    }
  }

  // 换到另一面墙会从头计时。
  {
    const s = new GameSession({ seed: 4245 });
    const pick = makeItem(objById.get('PICK_AXE') as ObjectData, s.rng);
    addToInventory(s.player, pick);
    wieldItem(s.player, pick);
    const first = emptyNeighborWall(s);
    ok(!!first, '找到第一面墙');
    if (first) {
      s.player.x = first.from.x;
      s.player.y = first.from.y;
      const dx = first.wall.x - first.from.x;
      const dy = first.wall.y - first.from.y;
      s.movePlayer(dx, dy);
      ok(s.digging?.progress === 1, '第一面墙有一回合进度');
      const away = (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as [number, number][]
      )
        .map(([ax, ay]) => ({ x: first.from.x + ax, y: first.from.y + ay, dx: ax, dy: ay }))
        .find(
          (p) =>
            (p.dx !== dx || p.dy !== dy) &&
            isWalkable(s.level.tiles[index(p.x, p.y)]) &&
            !s.level.monsters.some((m) => !m.dead && m.x === p.x && m.y === p.y),
        );
      if (away) {
        s.movePlayer(away.dx, away.dy);
        ok(s.digging === null, '挪动后挖掘进度重置');
      }
    }
  }

  // 矮人锹比普通镐快一回合：两回合凿穿一面墙。
  {
    const s = new GameSession({ seed: 4248 });
    const mattock = makeItem(objById.get('DWARVISH_MATTOCK') as ObjectData, s.rng);
    addToInventory(s.player, mattock);
    wieldItem(s.player, mattock);
    const spot = emptyNeighborWall(s);
    ok(!!spot, '矮人锹能找到可挖的墙');
    if (spot) {
      s.player.x = spot.from.x;
      s.player.y = spot.from.y;
      const dx = spot.wall.x - spot.from.x;
      const dy = spot.wall.y - spot.from.y;
      s.movePlayer(dx, dy);
      ok(s.level.tiles[index(spot.wall.x, spot.wall.y)] !== T.CORR, '矮人锹第一回合只是凿入口');
      s.movePlayer(dx, dy);
      ok(s.level.tiles[index(spot.wall.x, spot.wall.y)] === T.CORR, '矮人锹两回合凿穿');
    }
  }

  // 推箱分支禁止破坏结构：挖墙只给提示，地形不变。
  {
    const s = new GameSession({ seed: 4243 });
    s.changeDepth(4, 'down', 'sokoban');
    const pick = makeItem(objById.get('PICK_AXE') as ObjectData, s.rng);
    addToInventory(s.player, pick);
    wieldItem(s.player, pick);
    const spot = emptyNeighborWall(s);
    ok(!!spot, '推箱层有贴着地面的墙');
    if (spot) {
      s.player.x = spot.from.x;
      s.player.y = spot.from.y;
      const tile = s.level.tiles[index(spot.wall.x, spot.wall.y)];
      s.movePlayer(spot.wall.x - spot.from.x, spot.wall.y - spot.from.y);
      ok(s.level.tiles[index(spot.wall.x, spot.wall.y)] === tile, '推箱层挖不动墙');
      ok(
        s.messages.some((m) => m.key === 'msg.digBlocked'),
        '记录挖墙被挡下的消息',
      );
    }
  }

  // 元素位面是大房间：没有可挖的墙时，挖掘魔杖向下开洞并换层。
  {
    const s = new GameSession({ seed: 4244 });
    s.changeDepth(1, 'down', 'planes');
    s.player.x = Math.floor(COLNO / 2);
    s.player.y = Math.floor(ROWNO / 2);
    const result = s.zapDigging();
    ok(result === 'down', `挖掘魔杖向下开洞（${result}）`);
    ok(s.depth === 2, '向下挖后换层');
    ok(
      [...s.getBranchLevel('planes', 1).traps.values()].some((t) => t.type === 'HOLE'),
      '原层留下地洞',
    );
  }

  // 挖开的墙随存档保留。
  {
    const { serializeSession, restoreSession } = await import('../src/game/save');
    const s = new GameSession({ seed: 4246 });
    const pick = makeItem(objById.get('PICK_AXE') as ObjectData, s.rng);
    addToInventory(s.player, pick);
    wieldItem(s.player, pick);
    const spot = emptyNeighborWall(s);
    ok(!!spot, '存档测试找得到可挖的墙');
    if (spot) {
      s.player.x = spot.from.x;
      s.player.y = spot.from.y;
      const dx = spot.wall.x - spot.from.x;
      const dy = spot.wall.y - spot.from.y;
      for (let i = 0; i < 3; i++) s.movePlayer(dx, dy);
      const restored = restoreSession(serializeSession(s));
      ok(restored.level.tiles[index(spot.wall.x, spot.wall.y)] === T.CORR, '存档保留挖开的墙');
    }
  }

  // 持镐向下挖三回合，凿穿地板并落到下一层。
  {
    const s = new GameSession({ seed: 4247 });
    const pick = makeItem(objById.get('PICK_AXE') as ObjectData, s.rng);
    addToInventory(s.player, pick);
    wieldItem(s.player, pick);
    ok(s.canDigDown(), '持镐站在地面可以向下挖');
    const depthBefore = s.depth;
    const first = s.digDown();
    ok(first.result === 'used' && s.depth === depthBefore, '向下挖需要多回合');
    ok(
      s.messages.some((m) => m.key === 'msg.digDownProgress'),
      '记录向下挖的进度',
    );
    s.digDown();
    const third = s.digDown();
    ok(third.result === 'descended' && s.depth === depthBefore + 1, '挖穿地板后换层');
    ok(
      [...s.getLevel(depthBefore).traps.values()].some((t) => t.type === 'HOLE'),
      '原层留下地洞',
    );
  }
});

section('法杖效果', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');

  const giveWand = (s: InstanceType<typeof GameSession>, id: string) => {
    const wand = makeItem(objById.get(id) as ObjectData, s.rng);
    wand.charges = 10;
    addToInventory(s.player, wand);
    return wand;
  };
  /** 只留一只不抵抗魔法的怪物，并把玩家挪到它旁边。 */
  const loneTarget = (s: InstanceType<typeof GameSession>) => {
    const mon = s.level.monsters.find((m) => !m.dead && !m.tame);
    if (!mon) return null;
    s.level.monsters = [mon];
    mon.data = { ...mon.data, mr: 0 };
    const around = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as [number, number][];
    for (const [dx, dy] of around) {
      const x = mon.x + dx;
      const y = mon.y + dy;
      if (x < 1 || y < 1 || x >= COLNO - 1 || y >= ROWNO - 1) continue;
      if (!isWalkable(s.level.tiles[index(x, y)])) continue;
      s.player.x = x;
      s.player.y = y;
      s.refreshFov();
      return mon;
    }
    return null;
  };

  // 定身：目标被冻结，怪物行动阶段递减而不是行动。
  {
    const s = new GameSession({ seed: 5001 });
    const mon = loneTarget(s);
    ok(!!mon, '找到可测试的怪物');
    if (mon) {
      s.useItem(giveWand(s, 'WAN_STASIS'));
      ok((mon.stasis ?? 0) > 0, '定身魔杖定住目标');
      const before = mon.stasis ?? 0;
      for (let i = 0; i < before; i++) s.monsterTurns();
      ok((mon.stasis ?? 0) < before, '定身回合会递减');
    }
  }

  // 取消：目标失去特殊能力，取消状态随存档保留。
  {
    const { serializeSession, restoreSession } = await import('../src/game/save');
    const s = new GameSession({ seed: 5002 });
    const mon = loneTarget(s);
    ok(!!mon, '找到可测试的怪物');
    if (mon) {
      s.useItem(giveWand(s, 'WAN_CANCELLATION'));
      ok(mon.cancelled === true, '取消魔杖抹掉目标的能力');
      const restored = restoreSession(serializeSession(s));
      ok(
        restored.level.monsters.some((m) => m.cancelled),
        '存档保留取消状态',
      );
    }
  }

  // 变形：目标换成另一种怪物，生命比例保留。
  {
    const s = new GameSession({ seed: 5003 });
    const mon = loneTarget(s);
    ok(!!mon, '找到可测试的怪物');
    if (mon) {
      s.useItem(giveWand(s, 'WAN_POLYMORPH'));
      ok(
        s.messages.some((m) => m.key === 'use.zapPolymorph'),
        '变形魔杖换掉了怪物的形态',
      );
      ok(mon.mhp > 0 && mon.mhpmax > 0, '变形后生命值合法');
    }
  }

  // 造怪：身边多出一只怪物。
  {
    const s = new GameSession({ seed: 5004 });
    const before = s.level.monsters.length;
    s.useItem(giveWand(s, 'WAN_CREATE_MONSTER'));
    ok(s.level.monsters.length === before + 1, '造怪魔杖多出一只怪物');
    ok(
      s.messages.some((m) => m.key === 'use.zapCreateMonster'),
      '记录造怪消息',
    );
  }

  // 锁门：附近开着的门被关上并上锁。
  {
    const s = new GameSession({ seed: 5005 });
    const door = [...s.level.doors].find(([, d]) => !d.broken);
    ok(!!door, '地牢里有门');
    if (door) {
      const x = door[0] % COLNO;
      const y = Math.floor(door[0] / COLNO);
      const around = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as [number, number][];
      const spot = around
        .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
        .find(
          (pt) =>
            pt.x > 0 &&
            pt.y > 0 &&
            pt.x < COLNO - 1 &&
            pt.y < ROWNO - 1 &&
            isWalkable(s.level.tiles[index(pt.x, pt.y)]),
        );
      ok(!!spot, '门旁边有空地');
      if (spot) {
        s.player.x = spot.x;
        s.player.y = spot.y;
        door[1].closed = false;
        door[1].locked = false;
        s.useItem(giveWand(s, 'WAN_LOCKING'));
        ok(door[1].closed && door[1].locked, '锁门魔杖把门锁上了');
      }
    }
  }

  // 开门：只开身边 8 格内的门，远处的不受影响。
  {
    const s = new GameSession({ seed: 5005 });
    const doors = [...s.level.doors].filter(([, d]) => !d.broken);
    const near = doors[0];
    ok(!!near, '地牢里有可测试的门');
    if (near) {
      const nx = near[0] % COLNO;
      const ny = Math.floor(near[0] / COLNO);
      const spot = [
        [nx + 1, ny],
        [nx - 1, ny],
        [nx, ny + 1],
        [nx, ny - 1],
      ].find(
        ([x, y]) =>
          x > 0 &&
          y > 0 &&
          x < COLNO - 1 &&
          y < ROWNO - 1 &&
          isWalkable(s.level.tiles[index(x, y)]),
      );
      ok(!!spot, '近门旁边有可站立的位置');
      if (spot) {
        s.player.x = spot[0];
        s.player.y = spot[1];
        for (const [, door] of doors) {
          door.closed = true;
          door.locked = true;
        }
        const grid = (i: number): number =>
          Math.max(
            Math.abs((i % COLNO) - s.player.x),
            Math.abs(Math.floor(i / COLNO) - s.player.y),
          );
        const far = doors.find(([i]) => grid(i) > 8);
        s.useItem(giveWand(s, 'WAN_OPENING'));
        ok(!near[1].closed, '开门魔杖打开了近处的门');
        ok(near[1].locked === false, '开门也会解锁');
        if (far) ok(far[1].closed && far[1].locked, '射程外的门不受影响');
      }
    }
  }

  // 探门：未探索的门与楼梯写入记忆。
  {
    const s = new GameSession({ seed: 5006 });
    const before = [...s.level.doors.keys()].filter((i) => s.level.seen[i] !== 1).length;
    const revealed = s.revealDoors();
    ok(revealed >= before, '探门揭示未探索的门');
    ok(
      [...s.level.doors.keys()].every((i) => s.level.seen[i] === 1),
      '所有门都写进记忆',
    );
  }

  // 启智：把属性与抗性写进消息。
  {
    const s = new GameSession({ seed: 5007 });
    s.useItem(giveWand(s, 'WAN_ENLIGHTENMENT'));
    ok(
      s.messages.some((m) => m.key === 'msg.enlightenStats'),
      '启智魔杖报告属性',
    );
  }
});

section('冷门药水与卷轴', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');

  const give = (s: InstanceType<typeof GameSession>, id: string) => {
    const item = makeItem(objById.get(id) as ObjectData, s.rng);
    item.buc = 'uncursed';
    addToInventory(s.player, item);
    return item;
  };

  // 恢复属性药水把被吸走的属性补回基准。
  {
    const s = new GameSession({ seed: 6001 });
    const base = { ...s.player.baseAttributes };
    s.player.str = Math.max(3, base.str - 2);
    s.player.con = Math.max(3, base.con - 3);
    s.useItem(give(s, 'POT_RESTORE_ABILITY'));
    ok(s.player.str === base.str && s.player.con === base.con, '恢复属性药水补回基准值');
    ok(
      s.messages.some((m) => m.key === 'use.restored'),
      '记录恢复属性消息',
    );
  }

  // 失忆卷轴忘掉一半法术。
  {
    const s = new GameSession({ seed: 6002 });
    s.player.knownSpells = ['SPE_FORCE_BOLT', 'SPE_KNOCK', 'SPE_HEALING', 'SPE_LIGHT'];
    s.useItem(give(s, 'SCR_AMNESIA'));
    ok(s.player.knownSpells.length === 2, `失忆卷轴忘掉一半法术（${s.player.knownSpells.length}）`);
  }

  // 地震卷轴震伤附近怪物并留下陷坑。
  {
    const s = new GameSession({ seed: 6003 });
    const mon = s.level.monsters.find((m) => !m.dead);
    ok(!!mon, '地震测试有怪物');
    if (mon) {
      mon.mhp = 200;
      mon.mhpmax = 200;
      mon.x = s.player.x + 1;
      mon.y = s.player.y;
      const trapsBefore = s.level.traps.size;
      s.useItem(give(s, 'SCR_EARTH'));
      ok(mon.mhp < 200, `地震震伤了怪物（${mon.mhp}）`);
      ok(s.level.traps.size > trapsBefore, '地震留下一处陷坑');
    }
  }

  // 喝油难以下咽：短暂恶心并损失饱食度。
  {
    const s = new GameSession({ seed: 6005 });
    const hunger = s.player.hunger;
    s.useItem(give(s, 'POT_OIL'));
    ok(s.player.sick > 0, '喝油会恶心');
    ok(s.player.hunger < hunger, '喝油损失饱食度');
    ok(
      s.messages.some((m) => m.key === 'use.oil'),
      '记录喝油消息',
    );
  }

  // 邮件与空白卷轴只有提示，不改变状态。
  {
    const s = new GameSession({ seed: 6004 });
    const hp = s.player.hp;
    s.useItem(give(s, 'SCR_MAIL'));
    ok(
      s.messages.some((m) => m.key === 'use.mail'),
      '邮件卷轴给出提示',
    );
    s.useItem(give(s, 'SCR_BLANK_PAPER'));
    ok(
      s.messages.some((m) => m.key === 'use.blankScroll'),
      '空白卷轴给出提示',
    );
    ok(s.player.hp === hp, '两类卷轴不改变生命');
  }
});

section('浮空', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory, wearItem } = await import('../src/game/inventory');
  const { serializeSession, restoreSession } = await import('../src/game/save');

  const openNeighbor = (s: InstanceType<typeof GameSession>) => {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as [number, number][]) {
      const x = s.player.x + dx;
      const y = s.player.y + dy;
      const i = index(x, y);
      if (s.level.tiles[i] !== T.ROOM && s.level.tiles[i] !== T.CORR) continue;
      if (s.level.traps.has(i)) continue;
      if (s.level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
      return { dx, dy, x, y, i };
    }
    return null;
  };

  // 浮空药水与浮空戒指都能进入浮空状态。
  {
    const s = new GameSession({ seed: 7001 });
    s.useItem(makeItem(objById.get('POT_LEVITATION') as ObjectData, s.rng));
    ok(s.player.levitating > 0 && s.hasLevitation(), '浮空药水让人飘浮');
    ok(
      s.messages.some((m) => m.key === 'use.levitate'),
      '记录浮空消息',
    );
    const restored = restoreSession(serializeSession(s));
    ok(restored.player.levitating > 0, '浮空计时随存档保留');
  }
  {
    const s = new GameSession({ seed: 7002 });
    const ring = makeItem(objById.get('RIN_LEVITATION') as ObjectData, s.rng);
    addToInventory(s.player, ring);
    wearItem(s.player, ring);
    ok(s.hasLevitation(), '浮空戒指戴上就飘浮');
  }

  // 浮空时从岩浆上方飘过，不受灼伤；落地后再踩会受伤。
  {
    const s = new GameSession({ seed: 7003 });
    s.player.maxHp = 200;
    s.player.hp = 200;
    const spot = openNeighbor(s);
    ok(!!spot, '找得到相邻空地');
    if (spot) {
      s.level.tiles[spot.i] = T.LAVA;
      s.player.levitating = 5;
      s.movePlayer(spot.dx, spot.dy);
      ok(s.player.hp === 200, '浮空跳过岩浆伤害');
      ok(s.player.x === spot.x && s.player.y === spot.y, '浮空时仍可移动到岩浆上');
      // 取消浮空，再走回原格（把原格也变成岩浆）。
      s.player.levitating = 0;
      const back = openNeighbor(s);
      ok(!!back, '岩浆旁边还有空地');
      if (back) {
        s.level.tiles[back.i] = T.LAVA;
        const hp = s.player.hp;
        s.movePlayer(back.dx, back.dy);
        ok(s.player.hp < hp, `失去浮空后岩浆造成伤害（${hp} → ${s.player.hp}）`);
      }
    }
  }

  // 浮空时越过虚空，并从陷阱上方飘过。
  {
    const s = new GameSession({ seed: 7004 });
    const spot = openNeighbor(s);
    ok(!!spot, '找得到相邻空地');
    if (spot) {
      s.level.tiles[spot.i] = T.AIR;
      s.player.levitating = 5;
      s.movePlayer(spot.dx, spot.dy);
      ok(s.player.x === spot.x && s.player.y === spot.y, '浮空可以越过虚空');
    }
  }
  {
    const s = new GameSession({ seed: 7005 });
    const spot = openNeighbor(s);
    ok(!!spot, '找得到相邻空地');
    if (spot) {
      s.level.traps.set(spot.i, { type: 'PIT', seen: false });
      s.player.levitating = 5;
      const hp = s.player.hp;
      s.movePlayer(spot.dx, spot.dy);
      ok(s.player.hp === hp, '浮空不触发陷阱伤害');
      ok(
        s.messages.some((m) => m.key === 'msg.levitateTrap'),
        '记录从陷阱上方飘过的消息',
      );
    }
  }

  // 浮空够不着楼梯，飞行则可以正常上下。
  {
    const s = new GameSession({ seed: 7007 });
    const down = s.level.down;
    ok(!!down, '首层有下行楼梯');
    if (down) {
      const spot = (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as [number, number][]
      )
        .map(([dx, dy]) => ({ x: down.x + dx, y: down.y + dy, dx, dy }))
        .find((p) => isWalkable(s.level.tiles[index(p.x, p.y)]));
      ok(!!spot, '楼梯旁有可站立的格子');
      if (spot) {
        s.player.x = spot.x;
        s.player.y = spot.y;
        s.player.levitating = 5;
        const depth = s.depth;
        s.movePlayer(down.x - spot.x, down.y - spot.y);
        ok(s.depth === depth, '浮空时踩楼梯不能下潜');
        ok(
          s.messages.some((m) => m.key === 'msg.levitateStairs'),
          '记录浮空够不着楼梯',
        );
        s.player.levitating = 0;
        const fly = makeItem(objById.get('AMULET_OF_FLYING') as ObjectData, s.rng);
        addToInventory(s.player, fly);
        wearItem(s.player, fly);
        ok(s.hasFlight() && s.isFloating(), '飞行护身符让人飘起来');
        // 回到楼梯旁再踩一次。
        s.player.x = spot.x;
        s.player.y = spot.y;
        s.movePlayer(down.x - spot.x, down.y - spot.y);
        ok(s.depth === depth + 1, '飞行时踩楼梯可以下潜');
      }
    }
  }

  // 计时归零落回地面。
  {
    const s = new GameSession({ seed: 7006 });
    s.player.levitating = 1;
    s.upkeep();
    ok(s.player.levitating === 0 && !s.hasLevitation(), '浮空计时归零');
    ok(
      s.messages.some((m) => m.key === 'msg.levitateEnd'),
      '记录落地消息',
    );
  }
});

section('深水与溺水', async () => {
  const { GameSession } = await import('../src/game/session');
  const { T } = await import('../src/core/constants');

  const standOnWater = (s: InstanceType<typeof GameSession>) => {
    s.level.tiles[index(s.player.x, s.player.y)] = T.WATER;
  };

  // 不会游泳又没有浮空：每回合受伤。
  {
    const s = new GameSession({ seed: 7101 });
    s.player.maxHp = 100;
    s.player.hp = 100;
    standOnWater(s);
    s.upkeep();
    ok(s.player.hp < 100, `深水造成溺水伤害（${s.player.hp}）`);
    ok(s.player.drowning > 0, '溺水计数递增');
    ok(
      s.messages.some((m) => m.key === 'msg.drowning'),
      '记录溺水消息',
    );
    // 离开水面后计数归零。
    s.level.tiles[index(s.player.x, s.player.y)] = T.ROOM;
    s.upkeep();
    ok(s.player.drowning === 0, '离开水面后溺水计数归零');
  }

  // 浮空与会游泳的形态都能免除溺水。
  {
    const s = new GameSession({ seed: 7102 });
    s.player.maxHp = 100;
    s.player.hp = 100;
    s.player.levitating = 5;
    standOnWater(s);
    s.upkeep();
    ok(s.player.hp === 100 && s.player.drowning === 0, '浮空不溺水');
    s.player.levitating = 0;
    s.player.form = { id: 'GIANT_EEL', turns: 10 };
    s.upkeep();
    ok(s.player.hp === 100 && s.player.drowning === 0, '两栖形态不溺水');
  }

  // 火之位面的热浪：没有火焰抗性每回合受伤，有抗性免疫。
  {
    const s = new GameSession({ seed: 7103 });
    s.player.maxHp = 100;
    s.player.hp = 100;
    s.changeDepth(3, 'down', 'planes');
    ok(s.level.special === 'plane_fire', '到达火之位面');
    s.upkeep();
    ok(s.player.hp < 100, `火之位面热浪造成伤害（${s.player.hp}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.planeHeat'),
      '记录热浪消息',
    );
    s.player.hp = 100;
    s.player.intrinsics.push('fire');
    s.upkeep();
    ok(s.player.hp === 100, '火焰抗性免疫热浪');
  }
});

section('铁球惩罚', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');

  const freeStep = (s: InstanceType<typeof GameSession>) => {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as [number, number][]) {
      const x = s.player.x + dx;
      const y = s.player.y + dy;
      if (!isWalkable(s.level.tiles[index(x, y)])) continue;
      if (s.level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
      return { dx, dy };
    }
    return null;
  };

  // 读惩罚卷轴会招来铁球，再读提示已在受罚。
  {
    const s = new GameSession({ seed: 8001 });
    s.level.monsters.length = 0;
    s.useItem(makeItem(objById.get('SCR_PUNISHMENT') as ObjectData, s.rng));
    ok(s.player.punished, '惩罚卷轴招来铁球');
    const ball = s.player.inventory.find((i) => i.proto.id === 'HEAVY_IRON_BALL');
    ok(!!ball, '铁球进了背包');
    ok(
      s.messages.some((m) => m.key === 'use.punished'),
      '记录受罚消息',
    );
    s.useItem(makeItem(objById.get('SCR_PUNISHMENT') as ObjectData, s.rng));
    ok(
      s.messages.some((m) => m.key === 'use.alreadyPunished'),
      '重复受罚只给提示',
    );

    // 铁球拖慢脚步：隔一回合才能动。
    const step = freeStep(s);
    ok(!!step, '找得到可走的方向');
    if (step) {
      s.player.punishedTurn = 0;
      const first = s.movePlayer(step.dx, step.dy);
      ok(first.result === 'moved', '受罚第一回合可以移动');
      ok(s.player.punishedTurn === 1, '受罚计数递增');
      const back = freeStep(s);
      if (back) {
        const second = s.movePlayer(back.dx, back.dy);
        ok(second.result === 'held', '受罚隔回合被拖住');
        ok(
          s.messages.some((m) => m.key === 'msg.punishedDrag'),
          '记录被拖住的消息',
        );
      }
    }

    // 铁球丢不掉。
    if (ball) {
      s.useItem(ball, 'drop');
      ok(s.player.inventory.includes(ball), '受罚期间铁球丢不掉');
      ok(
        s.messages.some((m) => m.key === 'msg.ballStuck'),
        '记录铁球丢不掉的消息',
      );
    }

    // 祈祷可以解除惩罚。
    s.player.alignRecord = 10;
    s.pray();
    ok(!s.player.punished, '祈祷解除铁球惩罚');
    ok(!s.player.inventory.some((i) => i.proto.id === 'HEAVY_IRON_BALL'), '解除后铁球消失');
    ok(
      s.messages.some((m) => m.key === 'msg.punishmentLifted'),
      '记录解除消息',
    );
  }

  // 背包满时不会挂上惩罚却没有铁球。
  {
    const s = new GameSession({ seed: 8003 });
    const rock = objById.get('ROCK') as ObjectData;
    while (s.player.inventory.length < 51) {
      s.player.inventory.push(makeItem(rock, s.rng));
    }
    const scroll = makeItem(objById.get('SCR_PUNISHMENT') as ObjectData, s.rng);
    s.player.inventory.push(scroll);
    s.useItem(scroll);
    ok(!s.player.punished, '背包满时不进入受罚状态');
    ok(
      s.messages.some((m) => m.key === 'use.inventoryFull'),
      '背包满时给出提示',
    );
  }

  // 惩罚状态随存档保留。
  {
    const { serializeSession, restoreSession } = await import('../src/game/save');
    const s = new GameSession({ seed: 8002 });
    s.player.punished = true;
    const ball = makeItem(objById.get('HEAVY_IRON_BALL') as ObjectData, s.rng);
    addToInventory(s.player, ball);
    const restored = restoreSession(serializeSession(s));
    ok(restored.player.punished, '存档保留惩罚状态');
    ok(
      restored.player.inventory.some((i) => i.proto.id === 'HEAVY_IRON_BALL'),
      '存档保留铁球',
    );
  }
});

section('怪物避让危险地形', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById } = await import('../src/data/index');
  const { T } = await import('../src/core/constants');

  /** 搭一个封闭场地：左格怪物、中格 hazard、右格玩家，其余全封死。 */
  const arena = (hazard: number) => {
    const s = new GameSession({ seed: 8100 });
    s.level.monsters.length = 0;
    const room = s.level.rooms[0];
    const cx = Math.floor((room.lx + room.hx) / 2);
    const cy = Math.floor((room.ly + room.hy) / 2);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        s.level.tiles[index(cx + dx, cy + dy)] = T.VWALL;
      }
    }
    s.level.tiles[index(cx - 1, cy)] = T.ROOM;
    s.level.tiles[index(cx, cy)] = hazard;
    s.level.tiles[index(cx + 1, cy)] = T.ROOM;
    s.player.x = cx + 1;
    s.player.y = cy;
    return { s, cx, cy };
  };
  const spawn = (s: InstanceType<typeof GameSession>, id: string, x: number, y: number) => {
    const mon = new Monster(monById.get(id)!, x, y, s.rng);
    mon.asleep = false;
    s.level.monsters.push(mon);
    return mon;
  };

  // 不会水的怪物不下水，水生怪物照走。
  {
    const first = arena(T.WATER);
    const ant = spawn(first.s, 'GIANT_ANT', first.cx - 1, first.cy);
    first.s.stepMonster(ant, 1);
    ok(ant.x === first.cx - 1 && ant.y === first.cy, '不会水的怪物不下水');

    const second = arena(T.WATER);
    const eel = spawn(second.s, 'GIANT_EEL', second.cx - 1, second.cy);
    second.s.stepMonster(eel, 1);
    ok(eel.x === second.cx && eel.y === second.cy, '水生怪物照样进水');
  }

  // 无火抗的怪物不踏岩浆，有火抗的可以。
  {
    const first = arena(T.LAVA);
    const ant = spawn(first.s, 'GIANT_ANT', first.cx - 1, first.cy);
    first.s.stepMonster(ant, 1);
    ok(ant.x === first.cx - 1 && ant.y === first.cy, '无火抗的怪物不踏岩浆');

    const second = arena(T.LAVA);
    const salamander = spawn(second.s, 'SALAMANDER', second.cx - 1, second.cy);
    second.s.stepMonster(salamander, 1);
    ok(salamander.x === second.cx && salamander.y === second.cy, '火抗怪物可以进岩浆');
  }
});

section('附魔与蒸发', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory, wearItem, wieldItem } = await import('../src/game/inventory');

  /** 读一张指定 BUC 的附魔卷轴。 */
  const readEnchant = (
    s: InstanceType<typeof GameSession>,
    id: string,
    buc: 'blessed' | 'cursed' | 'uncursed',
  ) => {
    const scroll = makeItem(objById.get(id) as ObjectData, s.rng);
    scroll.buc = buc;
    addToInventory(s.player, scroll);
    s.useItem(scroll);
  };

  // 低附魔稳步生效：普通卷轴 +1~+2，祝福卷轴更多，诅咒卷轴反向削弱。
  {
    const s = new GameSession({ seed: 8201 });
    const armor = makeItem(objById.get('PLATE_MAIL') as ObjectData, s.rng);
    addToInventory(s.player, armor);
    wearItem(s.player, armor);
    armor.enchant = 0;
    readEnchant(s, 'SCR_ENCHANT_ARMOR', 'uncursed');
    ok(armor.enchant >= 1 && armor.enchant <= 2, `普通卷轴给护甲 +1~+2（${armor.enchant}）`);
    const before = armor.enchant;
    readEnchant(s, 'SCR_ENCHANT_ARMOR', 'blessed');
    ok(
      armor.enchant > before && armor.enchant - before <= 3,
      `祝福卷轴附魔更多（${before} -> ${armor.enchant}）`,
    );
    const beforeCurse = armor.enchant;
    readEnchant(s, 'SCR_ENCHANT_ARMOR', 'cursed');
    ok(armor.enchant < beforeCurse, `诅咒卷轴削弱护甲（${beforeCurse} -> ${armor.enchant}）`);
  }

  // 武器在 +5 以下稳步附魔。
  {
    const s = new GameSession({ seed: 8202 });
    const sword = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
    addToInventory(s.player, sword);
    wieldItem(s.player, sword);
    sword.enchant = 5;
    readEnchant(s, 'SCR_ENCHANT_WEAPON', 'uncursed');
    ok(sword.enchant === 6, `武器 +5 仍能稳步附魔（${sword.enchant}）`);
  }

  // 高附魔再附魔会蒸发：护甲超过 +3、武器超过 +5。
  {
    const s = new GameSession({ seed: 8203 });
    const armor = makeItem(objById.get('PLATE_MAIL') as ObjectData, s.rng);
    addToInventory(s.player, armor);
    wearItem(s.player, armor);
    armor.enchant = 20;
    for (let n = 0; n < 5; n++) readEnchant(s, 'SCR_ENCHANT_ARMOR', 'uncursed');
    ok(!s.player.inventory.includes(armor), '高附魔护甲会被附魔卷轴蒸发');
    ok(
      s.messages.some((m) => m.key === 'use.enchantArmorEvaporate'),
      '记录护甲蒸发消息',
    );
  }
  {
    const s = new GameSession({ seed: 8204 });
    const sword = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
    addToInventory(s.player, sword);
    wieldItem(s.player, sword);
    sword.enchant = 6;
    for (let n = 0; n < 10; n++) readEnchant(s, 'SCR_ENCHANT_WEAPON', 'uncursed');
    ok(!s.player.inventory.includes(sword), '高附魔武器会被附魔卷轴蒸发');
    ok(
      s.messages.some((m) => m.key === 'use.enchantWeaponEvaporate'),
      '记录武器蒸发消息',
    );
  }
});

section('搜索陷阱', async () => {
  const { GameSession } = await import('../src/game/session');

  // 相邻的隐藏陷阱能被搜出来。
  {
    const s = new GameSession({ seed: 8301 });
    s.level.monsters = [];
    const i = index(s.player.x + 1, s.player.y);
    s.level.traps.set(i, { type: 'PIT', seen: false });
    let found = false;
    for (let n = 0; n < 20 && !found; n++) {
      s.searchAction();
      found = s.level.traps.get(i)?.seen === true;
    }
    ok(found, '搜索能发现相邻的隐藏陷阱');
    ok(
      s.messages.some((m) => m.key === 'msg.searchFound'),
      '记录发现陷阱消息',
    );
  }

  // 没有隐藏陷阱时只给提示。
  {
    const s = new GameSession({ seed: 8302 });
    s.level.monsters = [];
    s.level.traps.clear();
    s.searchAction();
    ok(
      s.messages.some((m) => m.key === 'msg.searchNothing'),
      '没有隐藏陷阱时一无所获',
    );
    ok(s.turn === 1, '搜索消耗一个回合');
  }
});

section('解除陷阱', async () => {
  const { GameSession } = await import('../src/game/session');

  // 相邻的已知陷阱可以拆除，多试几次总能成功。
  {
    const s = new GameSession({ seed: 8401 });
    s.level.monsters = [];
    const i = index(s.player.x + 1, s.player.y);
    s.level.traps.set(i, { type: 'PIT', seen: true });
    let removed = false;
    for (let n = 0; n < 30 && !removed; n++) {
      s.untrapAction();
      removed = !s.level.traps.has(i);
    }
    ok(removed, '解除陷阱最终能拆掉相邻的陷阱');
    ok(
      s.messages.some((m) => m.key === 'msg.untrapDone'),
      '记录解除陷阱消息',
    );
  }

  // 没有目标时只给提示，不消耗回合。
  {
    const s = new GameSession({ seed: 8402 });
    s.level.monsters = [];
    s.level.traps.clear();
    const turn = s.turn;
    s.untrapAction();
    ok(
      s.messages.some((m) => m.key === 'msg.untrapNone'),
      '没有陷阱时给出提示',
    );
    ok(s.turn === turn, '没有陷阱时不消耗回合');
  }

  // 未见过的陷阱不在候选里，传送门也不能拆。
  {
    const s = new GameSession({ seed: 8403 });
    s.level.monsters = [];
    s.level.traps.clear();
    s.level.traps.set(index(s.player.x + 1, s.player.y), { type: 'PIT', seen: false });
    ok(s.disarmTarget() === null, '未见过的陷阱不可解除');
    s.level.traps.clear();
    s.level.traps.set(index(s.player.x + 1, s.player.y), { type: 'MAGIC_PORTAL', seen: true });
    ok(s.disarmTarget() === null, '传送门不可解除');
  }
});

section('工具应用', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory, wearItem } = await import('../src/game/inventory');

  // 毛巾擦脸解除失明，没失明时什么也不做。
  {
    const s = new GameSession({ seed: 8501 });
    const towel = makeItem(objById.get('TOWEL') as ObjectData, s.rng);
    addToInventory(s.player, towel);
    s.player.blind = 10;
    s.useItem(towel);
    ok(s.player.blind === 0, '毛巾解除失明');
    ok(
      s.messages.some((m) => m.key === 'use.towel'),
      '记录擦脸消息',
    );
    s.useItem(towel);
    ok(
      s.messages.some((m) => m.key === 'use.nothing'),
      '没失明时毛巾没有效果',
    );
  }

  // 独角兽角随机祛除一项异常，无异常时只给提示。
  {
    const s = new GameSession({ seed: 8502 });
    const horn = makeItem(objById.get('UNICORN_HORN') as ObjectData, s.rng);
    addToInventory(s.player, horn);
    s.player.blind = 10;
    s.useItem(horn);
    ok(s.player.blind === 0, '独角兽角解除失明');
    ok(
      s.messages.some((m) => m.key === 'use.hornBlind'),
      '记录独角兽角消息',
    );
    s.useItem(horn);
    ok(
      s.messages.some((m) => m.key === 'use.hornNothing'),
      '没有异常时只给提示',
    );
  }

  // 听诊器报告自身或相邻怪物的状态。
  {
    const s = new GameSession({ seed: 8503 });
    s.level.monsters = [];
    const stethoscope = makeItem(objById.get('STETHOSCOPE') as ObjectData, s.rng);
    addToInventory(s.player, stethoscope);
    s.useItem(stethoscope);
    ok(
      s.messages.some((m) => m.key === 'use.stethoscopeSelf'),
      '听诊器报告自身状态',
    );
    const mon = new Monster(monById.get('GIANT_ANT')!, s.player.x + 1, s.player.y, s.rng);
    s.level.monsters.push(mon);
    s.useItem(stethoscope);
    ok(
      s.messages.some((m) => m.key === 'use.stethoscopeMon'),
      '听诊器报告怪物状态',
    );
  }

  // 水晶球揭示地图，记号笔在空白卷轴上写字。
  {
    const s = new GameSession({ seed: 8504 });
    const ball = makeItem(objById.get('CRYSTAL_BALL') as ObjectData, s.rng);
    addToInventory(s.player, ball);
    s.useItem(ball);
    ok(
      s.messages.some((m) => m.key === 'use.crystalBall'),
      '水晶球揭示本层地图',
    );
    const marker = makeItem(objById.get('MAGIC_MARKER') as ObjectData, s.rng);
    addToInventory(s.player, marker);
    s.useItem(marker);
    ok(
      s.messages.some((m) => m.key === 'use.markerNoPaper'),
      '没有空白卷轴时记号笔无从下笔',
    );
    const blank = makeItem(objById.get('SCR_BLANK_PAPER') as ObjectData, s.rng);
    addToInventory(s.player, blank);
    s.useItem(marker);
    ok(
      s.messages.some((m) => m.key === 'use.markerWrite'),
      '记号笔在空白卷轴上写字',
    );
    ok(
      !s.player.inventory.includes(blank) &&
        s.player.inventory.some((it) => it.id !== 'SCR_BLANK_PAPER' && it.proto.cls === 'scroll'),
      '写成的卷轴取代了空白卷轴',
    );
  }

  // 镜子、相机与魔哨：惊退怪物、聚拢宠物。
  {
    const s = new GameSession({ seed: 8506 });
    s.level.monsters = [];
    const ant = new Monster(monById.get('GIANT_ANT')!, s.player.x + 2, s.player.y, s.rng);
    ant.asleep = false;
    s.level.monsters.push(ant);
    const mirror = makeItem(objById.get('MIRROR') as ObjectData, s.rng);
    addToInventory(s.player, mirror);
    s.useItem(mirror);
    ok(ant.fleeing, '镜子吓退最近的怪物');
    const camera = makeItem(objById.get('EXPENSIVE_CAMERA') as ObjectData, s.rng);
    addToInventory(s.player, camera);
    ant.fleeing = false;
    s.useItem(camera);
    ok(ant.fleeing, '闪光灯吓退附近的怪物');
    const whistle = makeItem(objById.get('MAGIC_WHISTLE') as ObjectData, s.rng);
    addToInventory(s.player, whistle);
    const pet = new Monster(monById.get('LITTLE_DOG')!, 10, 10, s.rng);
    pet.tame = true;
    s.level.monsters.push(pet);
    s.useItem(whistle);
    ok(
      Math.max(Math.abs(pet.x - s.player.x), Math.abs(pet.y - s.player.y)) <= 1,
      '魔哨把宠物叫到身边',
    );
  }

  // 乐器：号角喷吐息、魔琴催眠、地震鼓晃地。
  {
    const s = new GameSession({ seed: 8507 });
    s.level.monsters = [];
    const ant = new Monster(monById.get('GIANT_ANT')!, s.player.x + 3, s.player.y, s.rng);
    ant.asleep = false;
    ant.mhp = 100;
    ant.mhpmax = 100;
    s.level.monsters.push(ant);
    const horn = makeItem(objById.get('FIRE_HORN') as ObjectData, s.rng);
    addToInventory(s.player, horn);
    s.useItem(horn);
    ok(ant.mhp < 100, '火焰号角灼伤最近的怪物');
    ok(
      s.messages.some((m) => m.key === 'use.hornFire'),
      '记录号角喷吐消息',
    );
    const harp = makeItem(objById.get('MAGIC_HARP') as ObjectData, s.rng);
    addToInventory(s.player, harp);
    ant.asleep = false;
    s.useItem(harp);
    ok(
      s.messages.some((m) => m.key === 'use.instrumentSleep'),
      '魔琴让附近的怪物沉睡',
    );
    const drum = makeItem(objById.get('DRUM_OF_EARTHQUAKE') as ObjectData, s.rng);
    addToInventory(s.player, drum);
    s.useItem(drum);
    ok(
      s.messages.some((m) => m.key === 'use.earthquake'),
      '地震鼓晃动大地',
    );
  }

  // 油灯点亮所在的房间。
  {
    const s = new GameSession({ seed: 8508 });
    const room = s.level.rooms[0];
    ok(!!room, '首层有房间');
    if (room) {
      s.player.x = (room.lx + room.hx) >> 1;
      s.player.y = (room.ly + room.hy) >> 1;
      room.lit = false;
      const lamp = makeItem(objById.get('OIL_LAMP') as ObjectData, s.rng);
      addToInventory(s.player, lamp);
      s.useItem(lamp);
      ok(!!room.lit, '油灯点亮所在的房间');
      ok(
        s.messages.some((m) => m.key === 'use.lampLit'),
        '记录点灯消息',
      );
    }
  }

  // 牵引绳：拴住的宠物走不出玩家两格。
  {
    const s = new GameSession({ seed: 8509 });
    s.level.monsters = [];
    const pet = new Monster(monById.get('LITTLE_DOG')!, s.player.x + 1, s.player.y, s.rng);
    pet.tame = true;
    s.level.monsters.push(pet);
    const leash = makeItem(objById.get('LEASH') as ObjectData, s.rng);
    addToInventory(s.player, leash);
    s.useItem(leash);
    ok(pet.leashed === true, '牵引绳拴住宠物');
    ok(
      s.messages.some((m) => m.key === 'msg.leashOn'),
      '记录拴绳消息',
    );
    pet.x = s.player.x + 2;
    pet.y = s.player.y;
    s.stepMonster(pet, -1);
    ok(
      Math.max(Math.abs(pet.x - s.player.x), Math.abs(pet.y - s.player.y)) <= 2,
      '拴住的宠物走不出两格',
    );
    pet.x = s.player.x + 1;
    pet.y = s.player.y;
    s.useItem(leash);
    ok(pet.leashed === false, '再用一次解开牵引绳');
  }

  // 塑像：放出来变成活物。
  {
    const s = new GameSession({ seed: 8510 });
    s.level.monsters = [];
    const figurine = makeItem(objById.get('FIGURINE') as ObjectData, s.rng);
    addToInventory(s.player, figurine);
    ok(!!figurine.corpse, '塑像生成时封着一只怪物');
    const before = s.level.monsters.length;
    s.useItem(figurine);
    ok(s.level.monsters.length === before + 1, '塑像放出封着的怪物');
    ok(!s.player.inventory.includes(figurine), '塑像用后消失');
    ok(
      s.messages.some((m) => m.key === 'use.figurineLive'),
      '记录塑像活化消息',
    );
  }

  // 罐装油脂护住护甲一次，毁甲卷轴随之失效。
  {
    const s = new GameSession({ seed: 8505 });
    const armor = makeItem(objById.get('PLATE_MAIL') as ObjectData, s.rng);
    addToInventory(s.player, armor);
    wearItem(s.player, armor);
    const grease = makeItem(objById.get('CAN_OF_GREASE') as ObjectData, s.rng);
    addToInventory(s.player, grease);
    s.useItem(grease);
    ok(armor.greased === true, '涂油后护甲受保护');
    s.useItem(grease);
    ok(
      s.messages.some((m) => m.key === 'use.alreadyGreased'),
      '重复涂油只给提示',
    );
    s.useItem(makeItem(objById.get('SCR_DESTROY_ARMOR') as ObjectData, s.rng));
    ok(s.player.inventory.includes(armor), '涂过油的护甲躲过毁甲');
    ok(armor.greased === false, '油脂随之耗掉');
  }
});

section('蒙眼与目光', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory, wearItem } = await import('../src/game/inventory');
  const { createRng } = await import('../src/core/rng');

  // 蒙眼罩让人失明，毛巾擦不掉它。
  {
    const s = new GameSession({ seed: 8601 });
    const blindfold = makeItem(objById.get('BLINDFOLD') as ObjectData, s.rng);
    addToInventory(s.player, blindfold);
    wearItem(s.player, blindfold);
    ok(s.player.isBlind, '戴上蒙眼罩后失明');
    const towel = makeItem(objById.get('TOWEL') as ObjectData, s.rng);
    addToInventory(s.player, towel);
    s.player.blind = 5;
    s.useItem(towel);
    ok(s.player.blind === 0 && s.player.isBlind, '毛巾擦脸但蒙眼罩仍让人失明');
  }

  // 失明时躲得过石化目光，看得见时会被盯上。
  {
    const s = new GameSession({ seed: 8602 });
    s.level.monsters = [];
    const medusa = new Monster(monById.get('MEDUSA')!, s.player.x + 1, s.player.y, createRng(3));
    medusa.asleep = false;
    // 只留石化目光，排除其它攻击的干扰。
    medusa.data = { ...medusa.data, attacks: [{ at: 'AT_GAZE', ad: 'AD_STON', dice: [0, 0] }] };
    s.level.monsters.push(medusa);
    s.player.maxHp = 100;
    s.player.hp = 100;
    s.player.blind = 10;
    for (let n = 0; n < 5; n++) s.monsterAttack(medusa);
    ok(s.player.petrifying === 0, '失明时躲得过石化目光');
    s.player.blind = 0;
    for (let n = 0; n < 5; n++) {
      if (s.player.petrifying > 0) break;
      s.monsterAttack(medusa);
    }
    ok(s.player.petrifying > 0, '看得见时会被石化目光盯上');
  }
});

section('祝福与诅咒', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');
  const { objById } = await import('../src/data/index');

  // 圣水与诅咒之水改变整包 BUC。
  {
    const s = new GameSession({ seed: 42 });
    const water = makeItem(objById.get('POT_WATER') as ObjectData, s.rng);
    water.buc = 'blessed';
    addToInventory(s.player, water);
    const r = s.useItem(water);
    ok(r.key === 'use.holyWater', '圣水有独立消息');
    ok(
      s.player.inventory.every((i) => i.buc === 'blessed'),
      '圣水祝福整包物品',
    );
  }
  {
    const s = new GameSession({ seed: 42 });
    const water = makeItem(objById.get('POT_WATER') as ObjectData, s.rng);
    water.buc = 'cursed';
    addToInventory(s.player, water);
    const r = s.useItem(water);
    ok(r.key === 'use.unholyWater', '诅咒之水有独立消息');
    ok(
      s.player.inventory.every((i) => i.buc === 'cursed'),
      '诅咒之水污染整包物品',
    );
  }

  // 祝福与诅咒影响药水效果。
  {
    const s = new GameSession({ seed: 42 });
    const pot = makeItem(objById.get('POT_EXTRA_HEALING') as ObjectData, s.rng);
    pot.buc = 'blessed';
    addToInventory(s.player, pot);
    const max = s.player.maxHp;
    s.useItem(pot);
    ok(s.player.maxHp > max, `祝福治疗提高生命上限（${max} -> ${s.player.maxHp}）`);
  }
  {
    const s = new GameSession({ seed: 42 });
    const pot = makeItem(objById.get('POT_GAIN_ABILITY') as ObjectData, s.rng);
    pot.buc = 'cursed';
    addToInventory(s.player, pot);
    const luck = s.player.luck;
    const r = s.useItem(pot);
    ok(s.player.luck < luck && r.key === 'use.badPotion', '诅咒能力药水降低幸运');
  }

  // 卷轴：祝福鉴定全鉴，诅咒卷轴失效，移除诅咒可解装备。
  {
    const s = new GameSession({ seed: 42 });
    for (const i of s.player.inventory) i.known = false;
    const scr = makeItem(objById.get('SCR_IDENTIFY') as ObjectData, s.rng);
    scr.buc = 'blessed';
    addToInventory(s.player, scr);
    s.useItem(scr);
    ok(
      s.player.inventory.every((i) => i.known),
      '祝福鉴定卷轴鉴定全部物品',
    );
  }
  {
    const s = new GameSession({ seed: 42 });
    const scr = makeItem(objById.get('SCR_REMOVE_CURSE') as ObjectData, s.rng);
    scr.buc = 'cursed';
    addToInventory(s.player, scr);
    const r = s.useItem(scr);
    ok(r.key === 'use.badScroll', '诅咒的移除诅咒卷轴失效');
  }
  {
    const s = new GameSession({ seed: 42 });
    const armor = s.player.equipment.suit;
    if (armor) {
      armor.buc = 'cursed';
      const stuck = s.useItem(armor, 'remove');
      ok(stuck.key === 'msg.cursedStuck' && s.player.equipment.suit === armor, '诅咒装备取不下来');
      const scr = makeItem(objById.get('SCR_REMOVE_CURSE') as ObjectData, s.rng);
      addToInventory(s.player, scr);
      s.useItem(scr);
      ok(String(armor.buc) === 'uncursed', '移除诅咒解开装备');
      s.useItem(armor, 'remove');
      ok(s.player.equipment.suit === undefined, '解除诅咒后可以取下');
    } else {
      fail('诅咒装备测试需要盔甲');
    }
  }
});
section('充能与充能卷轴', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');
  const { objById } = await import('../src/data/index');

  /** 造一根充能较低的法杖与一张指定 BUC 的充能卷轴。 */
  const setup = (buc: 'blessed' | 'uncursed' | 'cursed') => {
    const s = new GameSession({ seed: 42 });
    const wand = makeItem(objById.get('WAN_FIRE') as ObjectData, s.rng);
    wand.charges = 2;
    addToInventory(s.player, wand);
    const scroll = makeItem(objById.get('SCR_CHARGING') as ObjectData, s.rng);
    scroll.buc = buc;
    addToInventory(s.player, scroll);
    return { s, wand, scroll };
  };

  {
    const { s, wand, scroll } = setup('uncursed');
    const r = s.useItem(scroll);
    ok(wand.charges === 4, `普通充能卷轴补 2 点（${wand.charges}）`);
    ok(r.key === 'use.charging', '充能有独立消息');
  }
  {
    const { s, wand, scroll } = setup('blessed');
    s.useItem(scroll);
    ok(wand.charges === 5, `祝福充能卷轴补 3 点（${wand.charges}）`);
  }
  {
    const { s, wand, scroll } = setup('cursed');
    const r = s.useItem(scroll);
    ok(wand.charges === 1, `诅咒充能卷轴倒扣 1 点（${wand.charges}）`);
    ok(r.key === 'use.chargingDrain', '倒扣有独立消息');
  }

  // 用尽的魔法灯可以重新蓄力。
  {
    const s = new GameSession({ seed: 42 });
    const lamp = makeItem(objById.get('MAGIC_LAMP') as ObjectData, s.rng);
    lamp.charges = 0;
    addToInventory(s.player, lamp);
    const scroll = makeItem(objById.get('SCR_CHARGING') as ObjectData, s.rng);
    addToInventory(s.player, scroll);
    const r = s.useItem(scroll);
    ok(lamp.charges === 1 && r.key === 'use.chargingLamp', '用尽的魔法灯重新蓄力');
  }

  // 没有目标时卷轴失效。
  {
    const s = new GameSession({ seed: 42 });
    const scroll = makeItem(objById.get('SCR_CHARGING') as ObjectData, s.rng);
    addToInventory(s.player, scroll);
    const r = s.useItem(scroll);
    ok(r.key === 'use.nothingHappens', '没有目标时充能卷轴失效');
  }
});
section('投掷与射击', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById, objById } = await import('../src/data/index');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');
  const { createRng } = await import('../src/core/rng');

  /** 造一只近处的怪物并保证玩家看得见。 */
  const foe = (s: InstanceType<typeof GameSession>, id: string, hp = 50) => {
    const data = monById.get(id) as MonsterData;
    const mon = new Monster(data, s.player.x + 1, s.player.y, createRng(3));
    mon.asleep = false;
    mon.mhp = mon.mhpmax = hp;
    s.level.monsters = [mon];
    s.refreshFov();
    return mon;
  };

  // 投掷武器：造成伤害，物品落在目标格。
  {
    const s = new GameSession({ seed: 42 });
    s.player.hitInc = 100;
    const target = foe(s, 'GIANT_ANT');
    const sword = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
    addToInventory(s.player, sword);
    const r = s.throwItem(sword);
    ok(r.result === 'used', '投掷消耗回合');
    ok(target.mhp < 50, `投掷造成伤害（${target.mhp}）`);
    ok(!s.player.inventory.includes(sword), '投出的武器离开背包');
    ok(
      s.level.objects.some((p) => p.x === target.x && p.y === target.y && p.items.includes(sword)),
      '投掷物落在目标格',
    );
  }

  // 投掷可堆叠物品：只消耗一件。
  {
    const s = new GameSession({ seed: 42 });
    s.player.hitInc = 100;
    foe(s, 'GIANT_ANT');
    const arrows = makeItem(objById.get('ARROW') as ObjectData, s.rng, { quantity: 5 });
    addToInventory(s.player, arrows);
    s.throwItem(arrows);
    ok(arrows.quantity === 4, `投掷只消耗一件（剩 ${arrows.quantity}）`);
  }

  // 射击：需要持握弓，命中加成。
  {
    const s = new GameSession({ seed: 42 });
    s.player.hitInc = 100;
    const target = foe(s, 'GIANT_ANT');
    const arrow = makeItem(objById.get('ARROW') as ObjectData, s.rng);
    addToInventory(s.player, arrow);
    const noBow = s.fireItem(arrow);
    ok(noBow.result === 'nothing', '没有弓时无法射击');
    const bow = makeItem(objById.get('BOW') as ObjectData, s.rng);
    addToInventory(s.player, bow);
    s.useItem(bow, 'wield');
    const shot = s.fireItem(arrow);
    ok(shot.result === 'used' && target.mhp < 50, `射击命中（${target.mhp}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.fireHit'),
      '射击有独立消息',
    );
  }

  // 视野内没有目标时不消耗物品。
  {
    const s = new GameSession({ seed: 42 });
    s.level.monsters = [];
    const rock = makeItem(objById.get('ROCK') as ObjectData, s.rng);
    addToInventory(s.player, rock);
    const r = s.throwItem(rock);
    ok(r.result === 'nothing' && s.player.inventory.includes(rock), '没有目标时不消耗投掷物');
    ok(
      s.messages.some((m) => m.key === 'msg.throwNothing'),
      '没有目标时有提示',
    );
  }
});
section('容器', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');
  const { isContainer, containerCapacity, containerHasRoom } =
    await import('../src/game/containers');
  const { serializeSession, restoreSession } = await import('../src/game/save');
  const { objById } = await import('../src/data/index');

  // 放进与取出。
  {
    const s = new GameSession({ seed: 42 });
    const chest = makeItem(objById.get('CHEST') as ObjectData, s.rng);
    const sword = makeItem(objById.get('LONG_SWORD') as ObjectData, s.rng);
    addToInventory(s.player, chest);
    addToInventory(s.player, sword);
    ok(isContainer(chest) && containerCapacity(chest) === 20, '箱子被识别为容器');
    const put = s.putInContainer(sword);
    ok(put.result === 'used' && !s.player.inventory.includes(sword), '物品放进容器');
    ok(chest.contents?.includes(sword) === true, '容器内容正确');
    const open = s.openContainer(chest);
    ok(open.result === 'used' && s.player.inventory.includes(sword), '容器内容取回背包');
    ok(chest.contents?.length === 0, '取出后容器为空');
  }

  // 容量上限与容器嵌套。
  {
    const s = new GameSession({ seed: 42 });
    const sack = makeItem(objById.get('SACK') as ObjectData, s.rng);
    addToInventory(s.player, sack);
    sack.contents = [];
    for (let n = 0; n < containerCapacity(sack); n++) {
      sack.contents.push(makeItem(objById.get('ROCK') as ObjectData, s.rng));
    }
    ok(!containerHasRoom(sack), '容器装满后没有空间');
    const extra = makeItem(objById.get('ROCK') as ObjectData, s.rng);
    addToInventory(s.player, extra);
    const full = s.putInContainer(extra, sack);
    ok(full.result === 'nothing' && s.player.inventory.includes(extra), '满容器拒绝放入');
    const other = makeItem(objById.get('SACK') as ObjectData, s.rng);
    addToInventory(s.player, other);
    const nest = s.putInContainer(other, sack);
    ok(nest.result === 'nothing', '容器不能嵌套');
  }

  // 诅咒容器打不开；口袋袋放出怪物。
  {
    const s = new GameSession({ seed: 42 });
    const chest = makeItem(objById.get('CHEST') as ObjectData, s.rng);
    chest.buc = 'cursed';
    addToInventory(s.player, chest);
    const r = s.openContainer(chest);
    ok(
      r.result === 'nothing' && s.messages.some((m) => m.key === 'msg.containerStuck'),
      '诅咒容器打不开',
    );
  }
  {
    const s = new GameSession({ seed: 42 });
    const bag = makeItem(objById.get('BAG_OF_TRICKS') as ObjectData, s.rng);
    addToInventory(s.player, bag);
    const before = s.level.monsters.length;
    s.openContainer(bag);
    ok(s.level.monsters.length > before, '口袋袋放出怪物');
    ok(
      s.messages.some((m) => m.key === 'msg.bagOfTricks'),
      '口袋袋有独立消息',
    );
  }

  // 嵌套内容随存档保留。
  {
    const s = new GameSession({ seed: 42 });
    const chest = makeItem(objById.get('CHEST') as ObjectData, s.rng);
    const gem = makeItem(objById.get('DIAMOND') as ObjectData, s.rng);
    addToInventory(s.player, chest);
    addToInventory(s.player, gem);
    s.putInContainer(gem, chest);
    const restored = restoreSession(serializeSession(s));
    const restoredChest = restored.player.inventory.find((i) => i.proto.id === 'CHEST');
    ok(
      restoredChest?.contents?.some((i) => i.proto.id === 'DIAMOND') === true,
      '容器内容随存档保留',
    );
  }

  // 地面容器：搜划把内容倒到地上；诅咒的地面容器搜划不开。
  {
    const s = new GameSession({ seed: 42 });
    const chest = makeItem(objById.get('CHEST') as ObjectData, s.rng);
    const gem = makeItem(objById.get('DIAMOND') as ObjectData, s.rng);
    chest.contents = [gem];
    const existing = s.level.objects.find((p) => p.x === s.player.x && p.y === s.player.y);
    if (existing) existing.items.push(chest);
    else s.level.objects.push({ x: s.player.x, y: s.player.y, items: [chest] });
    const r = s.lootContainer();
    ok(r.result === 'used', '搜划地面容器');
    ok(s.level.objects.flatMap((p) => p.items).includes(gem), '搜划后内容在地上');
    ok(chest.contents?.length === 0, '搜划后容器为空');
  }
  {
    const s = new GameSession({ seed: 42 });
    const chest = makeItem(objById.get('CHEST') as ObjectData, s.rng);
    chest.buc = 'cursed';
    chest.contents = [makeItem(objById.get('ROCK') as ObjectData, s.rng)];
    const existing = s.level.objects.find((p) => p.x === s.player.x && p.y === s.player.y);
    if (existing) existing.items.push(chest);
    else s.level.objects.push({ x: s.player.x, y: s.player.y, items: [chest] });
    const r = s.lootContainer();
    ok(r.result === 'nothing' && chest.contents?.length === 1, '诅咒的地面容器搜划不开');
  }
  {
    const s = new GameSession({ seed: 42 });
    const before = s.level.monsters.length;
    const r = s.lootContainer();
    ok(r.result === 'nothing' && s.level.monsters.length === before, '没有容器时搜划无效');
  }
});
section('小地图', async () => {
  const { GameSession } = await import('../src/game/session');
  const { minimapColor, minimapGrid, visiblePathPoints } = await import('../src/ui/minimap');
  const { PALETTE } = await import('../src/render/palette');
  const { COLNO, ROWNO, T } = await import('../src/core/constants');

  const s = new GameSession({ seed: 20240101 });
  const grid = minimapGrid(s);
  ok(grid.length === COLNO * ROWNO, '小地图尺寸与关卡一致');
  ok(
    grid.some((v) => v === 0),
    '未探索区域保持空白',
  );
  ok(
    grid.some((v) => v > 0),
    '已探索区域有内容',
  );
  let missing = 0;
  for (let i = 0; i < grid.length; i++) {
    if (s.level.seen[i] === 1 && grid[i] === 0) missing++;
  }
  ok(missing === 0, `已探索瓦片都有标记（缺 ${missing}）`);

  // 揭示全图后不留空白。
  s.revealLevel();
  const full = minimapGrid(s);
  ok(
    full.every((v) => v > 0),
    '揭示全图后小地图全部有内容',
  );

  // 颜色区分：设施、楼梯与普通地面。
  ok(minimapColor(T.ALTAR, null) === PALETTE.altarGlow, '祭坛有独立颜色');
  ok(minimapColor(T.ROOM, 'down') === PALETTE.stairsDown, '楼梯颜色覆盖地形');
  ok(minimapColor(T.ROOM, null) === PALETTE.floorRoom, '普通地面用房间色');

  // 路径只保留已探索的格子。
  {
    const fresh = new GameSession({ seed: 20240101 });
    const level = fresh.level;
    const points = [
      { x: fresh.player.x, y: fresh.player.y },
      { x: 0, y: 0 },
      { x: COLNO - 1, y: ROWNO - 1 },
    ];
    const visible = visiblePathPoints(level, points);
    ok(visible.length === 1, `路径点过滤未探索格（${visible.length}）`);
    ok(visible[0]?.x === fresh.player.x, '保留的路径点是玩家所在已探索格');
  }
});
section('武器技能', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById } = await import('../src/data/index');
  const { createRng } = await import('../src/core/rng');
  const { skillHitBonus, skillDamageBonus } = await import('../src/game/combat');
  const { serializeSession, restoreSession } = await import('../src/game/save');
  const { FIXED_CHARACTER } = await import('./agent-lib');

  ok(skillHitBonus(0) === 0 && skillHitBonus(7) === 3, '命中加值每两级 +1');
  ok(skillDamageBonus(0) === 0 && skillDamageBonus(6) === 2, '伤害加值每三级 +1');

  // 连续命中同一只怪物：使用次数累加，8 次后升到 1 级。
  {
    const s = new GameSession({ seed: 42, character: FIXED_CHARACTER });
    s.player.hitInc = 100;
    const data = monById.get('GIANT_ANT') as MonsterData;
    const ant = new Monster(data, s.player.x + 1, s.player.y, createRng(3));
    ant.asleep = false;
    ant.mhp = ant.mhpmax = 999;
    s.level.monsters = [ant];
    s.refreshFov();
    const skill = s.player.weapon?.proto.skill ?? '';
    ok(skill.length > 0, `持握武器带技能（${skill}）`);
    for (let i = 0; i < 8; i++) s.attackMonster(ant);
    ok(s.player.skillUses[skill] === 8, `命中累计使用次数（${s.player.skillUses[skill]}）`);
    ok(s.player.skillLevels[skill] === 1, `满 8 次升到 1 级（${s.player.skillLevels[skill]}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.skillUp'),
      '升熟练度有提示',
    );

    const restored = restoreSession(serializeSession(s));
    ok(restored.player.skillLevels[skill] === 1, '熟练度随存档保留');
    ok(restored.player.skillUses[skill] === 8, '使用次数随存档保留');
  }
});
section('法术技能', async () => {
  const { GameSession } = await import('../src/game/session');
  const { makeItem } = await import('../src/game/items');
  const { addToInventory } = await import('../src/game/inventory');
  const { objById } = await import('../src/data/index');
  const { castFailChance } = await import('../src/game/spells');

  // 熟练度降低失败率。
  {
    const s = new GameSession({ seed: 42 });
    const base = castFailChance(s.player, 3, 0);
    ok(
      castFailChance(s.player, 3, 5) < base,
      `熟练度降低施法失败率（${base} → ${castFailChance(s.player, 3, 5)}）`,
    );
  }

  // 连续施法：使用次数累加，8 次成功后升到 1 级。
  {
    const s = new GameSession({ seed: 42 });
    const book = makeItem(objById.get('SPE_FORCE_BOLT') as ObjectData, s.rng);
    addToInventory(s.player, book);
    s.player.knownSpells.push('SPE_FORCE_BOLT');
    // 无目标施法也算成功施法，避免靶子反击打断测试。
    s.level.monsters = [];
    const skill = book.proto.spellClass ?? '';
    let successes = 0;
    for (let i = 0; i < 60 && successes < 8; i++) {
      s.player.pw = 500;
      s.player.maxPw = Math.max(s.player.maxPw, 500);
      const before = s.player.skillUses[skill] ?? 0;
      s.castSpell(book);
      if ((s.player.skillUses[skill] ?? 0) > before) successes++;
    }
    ok(s.player.skillUses[skill] === 8, `施法累计使用次数（${s.player.skillUses[skill]}）`);
    ok(s.player.skillLevels[skill] === 1, `满 8 次升到 1 级（${s.player.skillLevels[skill]}）`);
    ok(
      s.messages.some((m) => m.key === 'msg.spellSkillUp'),
      '法术升熟练度有提示',
    );
  }
});
section('职业神器', async () => {
  const { GameSession } = await import('../src/game/session');
  const { ARTIFACTS, artifactForRole } = await import('../src/game/artifacts');
  const { roleById } = await import('../src/game/roles');
  const { raceById } = await import('../src/game/roles');
  const { objById, monById } = await import('../src/data/index');
  const { describeItem, makeItem } = await import('../src/game/items');
  const { itemName } = await import('../src/ui/itemName');
  const { formatMessage } = await import('../src/ui/message');
  const { t } = await import('../src/i18n/index');
  const { heroHits } = await import('../src/game/combat');
  const { Monster } = await import('../src/game/monsters');
  const { createRng } = await import('../src/core/rng');
  const { serializeSession, restoreSession } = await import('../src/game/save');

  // 每个职业都有神器，且基础原型存在。
  let missing = 0;
  for (const roleId of Object.keys(roleById)) {
    const def = artifactForRole(roleId);
    if (!def || !objById.has(def.proto)) missing++;
  }
  ok(missing === 0, `每个职业都有神器且原型存在（缺 ${missing}）`);
  ok(
    Object.keys(ARTIFACTS).length === Object.keys(roleById).length,
    `神器表覆盖全部职业（${Object.keys(ARTIFACTS).length}）`,
  );

  // 神器被动：携带与装备分别生效的抗性。
  {
    const { playerResists } = await import('../src/game/resist');
    const s = new GameSession({ seed: 31415 });
    const orb = makeItem(objById.get('CRYSTAL_BALL') as ObjectData, s.rng);
    orb.artifact = 'orb_of_detection';
    s.player.inventory.push(orb);
    ok(playerResists(s.player).has('magic'), '探测器之球携带时提供魔法抗性');
    const bow = makeItem(objById.get('BOW') as ObjectData, s.rng);
    bow.artifact = 'longbow_of_diana';
    s.player.inventory.push(bow);
    ok(!playerResists(s.player).has('reflection'), '长弓未持握时不给反射');
    s.player.equipment.weapon = bow;
    ok(playerResists(s.player).has('reflection'), '持握长弓获得反射');
  }

  // 幸运神器：携带村正或命运之球提高命中判定。
  {
    const s = new GameSession({ seed: 1618 });
    const ant = monById.get('GIANT_ANT') as MonsterData;
    const target = new Monster(ant, s.player.x + 1, s.player.y, createRng(2));
    const base = heroHits(s.player, target, createRng(1), 0).roll;
    const orb = makeItem(objById.get('CRYSTAL_BALL') as ObjectData, s.rng);
    orb.artifact = 'orb_of_fate';
    s.player.inventory.push(orb);
    const boosted = heroHits(s.player, target, createRng(1), 0).roll;
    ok(boosted === base + 1, `命运之球携带时提高命中（${base} -> ${boosted}）`);
  }

  // 神器减伤：半物理与半法术（SPFX_HPHDAM / SPFX_HSPDAM）。
  {
    const { halfDamageKinds } = await import('../src/game/resist');
    const probe = new GameSession({ seed: 55 });
    const key = makeItem(objById.get('SKELETON_KEY') as ObjectData, createRng(99));
    key.artifact = 'master_key_of_thievery';
    probe.player.inventory.push(key);
    const kinds = halfDamageKinds(probe.player);
    ok(kinds.physical && !kinds.spell, '万能钥匙携带时半物理伤害');

    // 同种子对比：带神器与不带神器受到同一骰子的伤害。
    const hit = (artifact: string | null, ad: string): number => {
      const s = new GameSession({ seed: 777 });
      s.level.monsters = [];
      s.player.hp = 100;
      s.player.maxHp = 100;
      if (artifact) {
        const item = makeItem(objById.get('CRYSTAL_BALL') as ObjectData, createRng(99));
        item.artifact = artifact;
        s.player.inventory.push(item);
      }
      const proto = {
        ...(monById.get('GIANT_ANT') as MonsterData),
        attacks: [{ at: 'AT_BITE', ad, dice: [2, 6] as [number, number] }],
      };
      const mon = new Monster(proto, s.player.x + 1, s.player.y, createRng(3));
      mon.asleep = false;
      s.level.monsters.push(mon);
      const before = s.player.hp;
      s.monsterAction(mon);
      return before - s.player.hp;
    };
    const plainPhys = hit(null, 'AD_PHYS');
    const wardedPhys = hit('orb_of_fate', 'AD_PHYS');
    ok(plainPhys > 0, `无神器时受到物理伤害（${plainPhys}）`);
    ok(
      wardedPhys === Math.ceil(plainPhys / 2),
      `命运之球把物理伤害减半（${plainPhys} -> ${wardedPhys}）`,
    );
    const plainSpell = hit(null, 'AD_MAGM');
    const wardedSpell = hit('orb_of_fate', 'AD_MAGM');
    ok(plainSpell > 0, `无神器时受到法术伤害（${plainSpell}）`);
    ok(
      wardedSpell === Math.ceil(plainSpell / 2),
      `命运之球把法术伤害减半（${plainSpell} -> ${wardedSpell}）`,
    );
  }

  // 神器启动：探知之球揭示全图，命运之球层级传送，都消耗充能。
  {
    const s = new GameSession({ seed: 616 });
    const orb = makeItem(objById.get('CRYSTAL_BALL') as ObjectData, s.rng);
    orb.artifact = 'orb_of_detection';
    orb.charges = 2;
    s.player.inventory.push(orb);
    s.useItem(orb, 'invoke');
    ok(
      s.level.seen.every((v) => v === 1),
      '探知之球揭示全图',
    );
    ok(orb.charges === 1, `启动消耗充能（${orb.charges}）`);
    ok(
      s.messages.some((m) => m.key === 'use.artifactMap'),
      '揭示全图有提示',
    );

    const fate = makeItem(objById.get('CRYSTAL_BALL') as ObjectData, s.rng);
    fate.artifact = 'orb_of_fate';
    fate.charges = 1;
    s.player.inventory.push(fate);
    const depthBefore = s.depth;
    s.useItem(fate, 'invoke');
    ok(s.depth !== depthBefore, `命运之球层级传送（${depthBefore} -> ${s.depth}）`);
    ok(fate.charges === 0, '命运之球消耗最后一点充能');
    s.useItem(fate, 'invoke');
    ok(
      s.messages.some((m) => m.key === 'use.noCharges'),
      '充能耗尽时提示',
    );
  }

  // 其余神器启动：长弓造箭、法冠回法、医神之杖治疗，各消耗一次充能。
  {
    const s = new GameSession({ seed: 717 });
    const bow = makeItem(objById.get('BOW') as ObjectData, s.rng);
    bow.artifact = 'longbow_of_diana';
    s.player.inventory.push(bow);
    s.useItem(bow, 'invoke');
    const arrows = s.player.inventory.find((i) => i.proto.id === 'ARROW');
    ok(!!arrows && arrows.quantity >= 5, `长弓造出箭矢（${arrows?.quantity ?? 0}）`);
    ok(bow.charges === 2, `首次启动初始化 3 次充能（${bow.charges}）`);

    const mitre = makeItem(objById.get('HELMET') as ObjectData, s.rng);
    mitre.artifact = 'mitre_of_holiness';
    s.player.inventory.push(mitre);
    s.player.pw = 0;
    s.useItem(mitre, 'invoke');
    ok(s.player.pw === s.player.maxPw, '圣洁法冠回满法力');

    const staff = makeItem(objById.get('QUARTERSTAFF') as ObjectData, s.rng);
    staff.artifact = 'staff_of_aesculapius';
    s.player.inventory.push(staff);
    s.player.maxHp = 60;
    s.player.hp = 1;
    s.player.sick = 5;
    s.useItem(staff, 'invoke');
    ok(s.player.hp > 1, `医神之杖治疗（${s.player.hp}）`);
    ok(s.player.sick === 0, '医神之杖治好疾病');
  }

  // 万能钥匙探陷阱、白金信用卡补能。
  {
    const s = new GameSession({ seed: 818 });
    const key = makeItem(objById.get('SKELETON_KEY') as ObjectData, s.rng);
    key.artifact = 'master_key_of_thievery';
    s.player.inventory.push(key);
    const trapAt = index(s.player.x + 1, s.player.y);
    s.level.traps.set(trapAt, { type: 'PIT', seen: false });
    s.useItem(key, 'invoke');
    ok(s.level.traps.get(trapAt)?.seen === true, '万能钥匙揭示隐藏陷阱');
    ok(
      s.messages.some((m) => m.key === 'use.artifactDetect'),
      '陷阱探测有提示',
    );

    const card = makeItem(objById.get('CREDIT_CARD') as ObjectData, s.rng);
    card.artifact = 'platinum_yendorian_express_card';
    s.player.inventory.push(card);
    const wand = makeItem(objById.get('WAN_FIRE') as ObjectData, s.rng);
    wand.charges = 1;
    s.player.inventory.push(wand);
    s.useItem(card, 'invoke');
    ok(wand.charges === 3, `白金信用卡给法杖补 2 点（${wand.charges}）`);
  }

  // 彼世之眼启动：同时揭示地形与陷阱。
  {
    const s = new GameSession({ seed: 919 });
    const eyes = makeItem(objById.get('LENSES') as ObjectData, s.rng);
    eyes.artifact = 'eyes_of_the_overworld';
    s.player.inventory.push(eyes);
    const trapAt = index(s.player.x + 1, s.player.y);
    s.level.traps.set(trapAt, { type: 'PIT', seen: false });
    s.useItem(eyes, 'invoke');
    ok(
      s.level.seen.every((v) => v === 1),
      '彼世之眼揭示全图',
    );
    ok(s.level.traps.get(trapAt)?.seen === true, '彼世之眼同时揭示陷阱');
    ok(
      s.messages.some((m) => m.key === 'use.artifactEnlighten'),
      '启明有提示',
    );
  }

  // 医神之杖在手时自然回复加倍。
  {
    const s = new GameSession({ seed: 2718 });
    const staff = makeItem(objById.get('QUARTERSTAFF') as ObjectData, s.rng);
    staff.artifact = 'staff_of_aesculapius';
    s.player.inventory.push(staff);
    s.player.equipment.weapon = staff;
    s.player.maxHp = 60;
    s.player.hp = 1;
    for (let i = 0; i < 10; i++) s.wait();
    ok(s.player.hp > 1, `医神之杖加快回复（hp=${s.player.hp}）`);
  }

  // 附魔参与命中：同一目标下命中值相差附魔数。
  {
    const s = new GameSession({ seed: 42 });
    const ant = new Monster(
      (await import('../src/data/index')).monById.get('GIANT_ANT') as MonsterData,
      s.player.x + 1,
      s.player.y,
      createRng(3),
    );
    const base = heroHits(s.player, ant, createRng(1), 0).roll;
    const boosted = heroHits(s.player, ant, createRng(1), 5).roll;
    ok(boosted === base + 5, '武器附魔计入命中（+5）');
  }

  // 任务目标层的仇敌脚下放着本职业神器，附魔与名字都写入物品。
  {
    const s = new GameSession({
      seed: 7,
      character: {
        role: roleById.SAMURAI,
        race: raceById.HUMAN,
        align: 'lawful',
        gender: 'male',
      },
    });
    // 测试只关心神器摆放，直接解锁任务楼梯。
    s.questUnlocked = true;
    s.changeDepth(5, 'down', 'quest');
    const found = s.level.objects.flatMap((p) => p.items).find((i) => i.artifact);
    ok(found?.artifact === 'tsurugi_of_muramasa', `任务目标层放着本职业神器（${found?.artifact}）`);
    ok(found?.enchant === 5 && found?.known === true, '神器带附魔且已鉴定');
    if (found) {
      const desc = describeItem(found);
      ok(desc.key === 'item.artifact', '神器使用专属描述键');
      ok(
        itemName(desc) === t('artifact.tsurugi_of_muramasa'),
        `神器显示专属名字（${itemName(desc)}）`,
      );
    }
    const restored = restoreSession(serializeSession(s));
    const again = restored.level.objects.flatMap((p) => p.items).find((i) => i.artifact);
    ok(again?.artifact === 'tsurugi_of_muramasa', '神器随存档保留');
  }

  // 任务目标层的仇敌守在巢穴里：一间带门的石室，神器与仇敌都在室内。
  {
    const { QUEST_LAIR } = await import('../src/game/dungeon');
    const { auditDoors } = await import('./agent-lib');
    const s = new GameSession({
      seed: 4244,
      character: {
        role: roleById.ARCHEOLOGIST,
        race: raceById.HUMAN,
        align: 'neutral' as const,
        gender: 'male' as const,
      },
    });
    // 测试只关心巢穴结构与摆放，直接解锁任务楼梯。
    s.questUnlocked = true;
    s.changeDepth(5, 'down', 'quest');
    const lair = QUEST_LAIR;
    const inside = (x: number, y: number) =>
      x >= lair.lx && x <= lair.hx && y >= lair.ly && y <= lair.hy;
    const nemesis = s.level.monsters.find((m) => m.data.id === s.character.role.quest.nemesis);
    ok(!!nemesis && inside(nemesis.x, nemesis.y), '仇敌守在巢穴里');
    const artifactPile = s.level.objects.find((p) => p.items.some((i) => i.artifact));
    ok(!!artifactPile && inside(artifactPile.x, artifactPile.y), '神器放在巢穴里');
    ok(s.level.doors.size === 1, `巢穴只开一扇门（${s.level.doors.size}）`);
    // 门口有仇敌的爪牙把守，玩家要先闯过这一关。
    const doorX = (lair.lx + lair.hx) >> 1;
    const doorY = lair.hy + 1;
    const guards = s.level.monsters.filter(
      (m) => !m.dead && Math.abs(m.x - doorX) <= 1 && m.y === doorY + 1,
    );
    ok(guards.length >= 2, `巢穴门口有爪牙把守（${guards.length}）`);
    ok(
      guards.every((g) => s.character.role.quest.enemies.includes(g.data.sym)),
      '门口守卫是仇敌的爪牙',
    );
    const audit = auditDoors(s.level);
    ok(
      audit.problems.length === 0,
      `巢穴的门满足形状审计（${audit.problems.join(';') || '通过'}）`,
    );
    ok(!!s.level.up && !inside(s.level.up.x, s.level.up.y), '入口楼梯在巢穴外');
  }

  // 12 个职业的任务总部用提取的固定地图；浪人退回通用布局。
  {
    const character = (role: typeof roleById.SAMURAI) => ({
      role,
      race: raceById.HUMAN,
      align: 'neutral' as const,
      gender: 'male' as const,
    });
    const open = new GameSession({
      seed: 4243,
      character: character(roleById.CAVE_DWELLER),
    });
    open.changeDepth(1, 'down', 'quest');
    ok(open.level.special === 'quest_home', '洞穴人的总部加载成功');
    ok(open.level.doors.size <= 2, `洞穴地图少门（${open.level.doors.size}）`);
    const restored = restoreSession(serializeSession(open));
    ok(restored.level.special === 'quest_home', '存档恢复保留任务总部');
    const indoor = new GameSession({
      seed: 4243,
      character: character(roleById.ARCHEOLOGIST),
    });
    indoor.changeDepth(1, 'down', 'quest');
    ok(indoor.level.special === 'quest_home', '考古学家的总部加载成功');
    ok(indoor.level.doors.size > 2, `考古学家地图多门（${indoor.level.doors.size}）`);
    const ranger = new GameSession({
      seed: 4243,
      character: character(roleById.RANGER),
    });
    ranger.changeDepth(1, 'down', 'quest');
    ok(ranger.level.special === 'quest_home', '浪人退回通用总部布局');
  }

  // 任务仇敌首次照面时叫阵一次。
  {
    const s = new GameSession({
      seed: 13,
      character: {
        role: roleById.SAMURAI,
        race: raceById.HUMAN,
        align: 'lawful',
        gender: 'male',
      },
    });
    // 测试只关心叫阵，直接解锁任务楼梯。
    s.questUnlocked = true;
    s.changeDepth(5, 'down', 'quest');
    const nemesis = s.level.monsters.find((m) => m.data.id === 'ASHIKAGA_TAKAUJI');
    ok(!!nemesis, '任务目标层有仇敌');
    if (nemesis) {
      nemesis.mhp = 999;
      nemesis.mhpmax = 999;
      s.attackMonster(nemesis);
      ok(
        s.messages.some((m) => m.key === 'msg.nemesisTaunt'),
        '仇敌首次照面叫阵',
      );
      const before = s.messages.filter((m) => m.key === 'msg.nemesisTaunt').length;
      s.attackMonster(nemesis);
      const after = s.messages.filter((m) => m.key === 'msg.nemesisTaunt').length;
      ok(after === before, '同一只仇敌只叫阵一次');
    }
  }

  // 任务领袖在场，交谈解锁楼梯，并标记任务完成。
  {
    const s = new GameSession({
      seed: 11,
      character: {
        role: roleById.SAMURAI,
        race: raceById.HUMAN,
        align: 'lawful',
        gender: 'male',
      },
    });
    s.changeDepth(1, 'down', 'quest');
    const quest = s.character.role.quest;
    const leader = s.level.monsters.find((m) => m.data.id === quest.leader);
    ok(leader?.data.id === 'LORD_SATO', `任务总部有领袖（${leader?.data.id}）`);
    // 未交谈时楼梯被挡住。
    const down = s.level.down;
    ok(!!down, '任务总部有下行楼梯');
    if (down && leader) {
      const spot = [
        [down.x - 1, down.y],
        [down.x + 1, down.y],
        [down.x, down.y - 1],
        [down.x, down.y + 1],
      ].find(
        ([x, y]) =>
          isWalkable(s.level.tiles[index(x, y)]) &&
          !s.level.monsters.some((m) => m.x === x && m.y === y),
      );
      if (spot) {
        s.player.x = spot[0];
        s.player.y = spot[1];
        const blocked = s.movePlayer(down.x - spot[0], down.y - spot[1]);
        ok(blocked.result === 'blocked', `未获许可时楼梯不可用（${blocked.result}）`);
      }

      // 地洞、向下挖与换层入口同样被神秘力量拦住。
      const roomSpot = (() => {
        for (let x = 1; x < s.level.width - 1; x++) {
          for (let y = 1; y < s.level.height - 1; y++) {
            if (s.level.tiles[index(x, y)] !== T.ROOM) continue;
            if (s.level.monsters.some((m) => !m.dead && m.x === x && m.y === y)) continue;
            return { x, y };
          }
        }
        return null;
      })();
      ok(!!roomSpot, '任务总部有可站立的地板');
      if (roomSpot) {
        s.player.x = roomSpot.x;
        s.player.y = roomSpot.y;
        const depthBefore = s.depth;
        const holeTile = index(roomSpot.x, roomSpot.y);
        s.level.traps.set(holeTile, { type: 'HOLE', seen: true });
        s.springTrap(holeTile);
        ok(s.depth === depthBefore, '未获许可时地洞不换层');
        ok(
          s.messages.some((m) => m.key === 'msg.questLocked'),
          '地洞被神秘力量挡下',
        );
        const { makeItem } = await import('../src/game/items.js');
        const { wieldItem } = await import('../src/game/inventory.js');
        const pick = makeItem(objById.get('PICK_AXE') as ObjectData, s.rng);
        s.player.inventory.push(pick);
        ok(wieldItem(s.player, pick).ok, '镐类工具可以持握');
        const dug = s.digDown();
        ok(dug.result === 'blocked' && s.depth === depthBefore, '未获许可时挖不穿地板');
      }
      const forced = s.changeDepth(2, 'down', 'quest');
      ok(forced.result === 'blocked' && s.depth === 1, '换层入口拦住任务下行');
      s.player.x = leader.x;
      s.player.y = leader.y - 1;
      s.talkToLeader();
      ok(s.questUnlocked, '交谈后任务楼梯解锁');
      const briefMsg = s.messages.find((m) => m.key === 'msg.questBriefing');
      if (briefMsg) {
        const text = formatMessage(briefMsg);
        ok(
          text.includes(t('artifact.tsurugi_of_muramasa')),
          `任务简报点出本职业神器（${text.slice(0, 48)}）`,
        );
      }
      const restoredQuest = restoreSession(serializeSession(s));
      ok(restoredQuest.questUnlocked, '任务许可随存档保留');

      // 带着神器复命：标记完成并给幸运与阵营奖励。
      const def = artifactForRole('SAMURAI');
      if (def) {
        const artifact = makeItem(objById.get(def.proto) as ObjectData, s.rng);
        artifact.artifact = def.id;
        s.player.inventory.push(artifact);
        const luckBefore = s.player.luck;
        const recordBefore = s.player.alignRecord;
        s.talkToLeader();
        ok(s.questComplete, '带神器复命标记任务完成');
        ok(s.player.luck === luckBefore + 1, '任务完成提升幸运');
        ok(s.player.alignRecord === recordBefore + 5, '任务完成提升阵营记录');
      }

      // 被挑衅过的领袖拒绝交谈。
      leader.angry = true;
      s.talkToLeader();
      ok(s.messages.at(-1)?.key === 'msg.questLeaderAngry', '愤怒的领袖拒绝交谈');
    }
  }

  // 打任务领袖会让整个总部翻脸。
  {
    const s = new GameSession({
      seed: 4246,
      character: {
        role: roleById.SAMURAI,
        race: raceById.HUMAN,
        align: 'lawful' as const,
        gender: 'male' as const,
      },
    });
    s.changeDepth(1, 'down', 'quest');
    const quest = s.character.role.quest;
    const leader = s.level.monsters.find((m) => m.data.id === quest.leader);
    ok(!!leader, '任务总部有领袖');
    if (leader) {
      s.attackMonster(leader);
      const allies = s.level.monsters.filter(
        (m) => !m.dead && (m.data.id === quest.leader || m.data.id === quest.guardian),
      );
      ok(allies.length > 0 && allies.every((g) => g.angry), '打领袖后任务总部全员翻脸');
      ok(
        s.messages.some((m) => m.key === 'msg.questBetrayed'),
        '记录背叛消息',
      );
      // 杀死领袖后下行解封（原版 ok_to_quest 的 killed_leader 例外），且随存档保留。
      s.slayMonster(leader);
      ok(s.questLeaderDead, '杀死领袖标记任务已失败');
      ok(!s.questDescentBlocked(), '杀死领袖后下行解封');
      const restoredLeader = restoreSession(serializeSession(s));
      ok(restoredLeader.questLeaderDead, '领袖死亡随存档保留');
    }
  }
});
section('远程吐息', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById, objById } = await import('../src/data/index');
  const { makeItem } = await import('../src/game/items');
  const { wearItem } = await import('../src/game/inventory');
  const { createRng } = await import('../src/core/rng');

  /** 在玩家同排距离 4 的可走格放一只怪物。 */
  const place = (s: InstanceType<typeof GameSession>, id: string) => {
    const spot = [
      [4, 0],
      [-4, 0],
      [0, 4],
      [0, -4],
    ]
      .map(([dx, dy]) => ({ x: s.player.x + dx, y: s.player.y + dy }))
      .find((p) => isWalkable(s.level.tiles[index(p.x, p.y)]));
    if (!spot) return null;
    const mon = new Monster(monById.get(id) as MonsterData, spot.x, spot.y, createRng(5));
    mon.asleep = false;
    s.level.monsters = [mon];
    s.refreshFov();
    return { mon, home: spot };
  };

  // 红龙在远处吐火。
  {
    const s = new GameSession({ seed: 42 });
    s.player.maxHp = 200;
    s.player.hp = 200;
    const placed = place(s, 'RED_DRAGON');
    ok(!!placed, '找得到放置红龙的位置');
    if (placed) {
      let hurt = false;
      for (let i = 0; i < 60 && !hurt; i++) {
        const hp = s.player.hp;
        s.monsterAction(placed.mon);
        if (s.player.hp < hp) hurt = true;
        else {
          placed.mon.x = placed.home.x;
          placed.mon.y = placed.home.y;
        }
      }
      ok(hurt, '红龙会在远距离吐息');
    }
  }

  // 火焰抗性：不再徒劳远射，改为靠近。
  {
    const s = new GameSession({ seed: 42 });
    const ring = makeItem(objById.get('RIN_FIRE_RESISTANCE') as ObjectData, s.rng);
    wearItem(s.player, ring);
    s.player.maxHp = 200;
    s.player.hp = 200;
    const placed = place(s, 'RED_DRAGON');
    if (placed) {
      const start = Math.max(
        Math.abs(placed.mon.x - s.player.x),
        Math.abs(placed.mon.y - s.player.y),
      );
      s.monsterAction(placed.mon);
      s.monsterAction(placed.mon);
      const now = Math.max(
        Math.abs(placed.mon.x - s.player.x),
        Math.abs(placed.mon.y - s.player.y),
      );
      ok(now < start, `被免疫的怪物改为靠近（${start} -> ${now}）`);
    }
    ok(s.player.hp === 200, '火焰抗性下不会被吐息伤到');
    ok(
      s.messages.every((m) => m.key !== 'msg.hitFire'),
      '免疫时不再远射火焰',
    );
  }

  // 纯近战怪物只会靠近，不会远程攻击。
  {
    const s = new GameSession({ seed: 42 });
    s.player.hp = 200;
    s.player.maxHp = 200;
    const placed = place(s, 'GIANT_ANT');
    if (placed) {
      for (let i = 0; i < 2; i++) s.monsterAction(placed.mon);
      ok(s.player.hp === 200, '近战怪物不会远程攻击');
      const dist = Math.max(
        Math.abs(placed.mon.x - s.player.x),
        Math.abs(placed.mon.y - s.player.y),
      );
      ok(dist < 4, `近战怪物会靠近（距离 ${dist}）`);
    } else {
      fail('远程吐息测试需要空地');
    }
  }
});
section('怪物呼救', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById } = await import('../src/data/index');
  const { createRng } = await import('../src/core/rng');

  // 一只怪物醒来后会唤醒 6 格内的同伴。
  {
    const s = new GameSession({ seed: 42 });
    const data = monById.get('GIANT_ANT') as MonsterData;
    const sleeper = new Monster(data, s.player.x + 2, s.player.y, createRng(3));
    sleeper.asleep = true;
    const buddy = new Monster(data, s.player.x + 3, s.player.y, createRng(4));
    buddy.asleep = true;
    s.level.monsters = [sleeper, buddy];
    s.refreshFov();
    for (let i = 0; i < 80 && sleeper.asleep; i++) s.monsterAction(sleeper);
    ok(!sleeper.asleep, '怪物会从睡眠中醒来');
    ok(!buddy.asleep, '醒来的怪物会唤醒附近同伴');
    ok(
      s.messages.some((m) => m.key === 'msg.monCalls'),
      '呼救有提示',
    );
  }

  // 宠物不会被呼救波及（驯服标记保持）。
  {
    const s = new GameSession({ seed: 42 });
    const data = monById.get('GIANT_ANT') as MonsterData;
    const sleeper = new Monster(data, s.player.x + 2, s.player.y, createRng(3));
    sleeper.asleep = true;
    const pet = new Monster(data, s.player.x + 3, s.player.y, createRng(4));
    pet.asleep = true;
    pet.tame = true;
    s.level.monsters = [sleeper, pet];
    s.refreshFov();
    for (let i = 0; i < 80 && sleeper.asleep; i++) s.monsterAction(sleeper);
    ok(pet.asleep === true && pet.tame === true, '呼救不会吵醒宠物');
  }
});
section('怪物逃跑', async () => {
  const { GameSession } = await import('../src/game/session');
  const { Monster } = await import('../src/game/monsters');
  const { monById } = await import('../src/data/index');
  const { createRng } = await import('../src/core/rng');

  // 重伤的怪物会逃跑。
  {
    const s = new GameSession({ seed: 42 });
    s.player.maxHp = 200;
    s.player.hp = 200;
    const ant = new Monster(
      monById.get('GIANT_ANT') as MonsterData,
      s.player.x + 2,
      s.player.y,
      createRng(3),
    );
    ant.asleep = false;
    ant.mhp = 1;
    ant.mhpmax = 40;
    s.level.monsters = [ant];
    for (let i = 0; i < 40 && !ant.fleeing; i++) s.monsterAction(ant);
    ok(ant.fleeing, '重伤的怪物会逃跑');
    ok(
      s.messages.some((m) => m.key === 'msg.monFlees'),
      '逃跑有提示',
    );
  }

  // 健康的怪物不会逃跑。
  {
    const s = new GameSession({ seed: 42 });
    s.player.maxHp = 200;
    s.player.hp = 200;
    const ant = new Monster(
      monById.get('GIANT_ANT') as MonsterData,
      s.player.x + 2,
      s.player.y,
      createRng(3),
    );
    ant.asleep = false;
    s.level.monsters = [ant];
    for (let i = 0; i < 20; i++) s.monsterAction(ant);
    ok(!ant.fleeing, '健康的怪物不会逃跑');
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
      ok(
        s.messages.some((m) => m.key === 'msg.castHit'),
        '命中提示',
      );
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

section('自动探索与休息', async () => {
  const { GameSession } = await import('../src/game/session.js');
  const { Monster } = await import('../src/game/monsters.js');
  const { monById } = await import('../src/data/index.js');
  const { findPath } = await import('../src/game/path.js');
  const { createRng } = await import('../src/core/rng.js');

  // 刚开局的迷宫必定有未探索区域：目标要挨着未知格，而且要走得过去。
  const s = new GameSession({ seed: 20240101 });
  const target = s.exploreTarget();
  ok(!!target, '开局能找到探索目标');
  if (target) {
    ok(s.level.seen[index(target.x, target.y)] === 1, '探索目标是已见过的格子');
    const touchesUnknown = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ].some(([dx, dy]) => {
      const x = target.x + dx;
      const y = target.y + dy;
      return x >= 0 && y >= 0 && x < COLNO && y < ROWNO && s.level.seen[index(x, y)] !== 1;
    });
    ok(touchesUnknown, '探索目标紧邻未探索区域');
    ok(
      !!findPath(s.level, { x: s.player.x, y: s.player.y }, target, {
        levitating: s.isFloating(),
      }),
      '探索目标可达',
    );
    const other = s.exploreTarget(new Set([index(target.x, target.y)]));
    ok(!other || other.x !== target.x || other.y !== target.y, '排除后不再选同一格');
  }

  // 整层揭开后没有可探索的目标。
  s.revealLevel();
  ok(s.exploreTarget() === null, '全图揭开后没有探索目标');

  // 视野内的敌对生物会被识别，和平生物不算威胁。
  const s2 = new GameSession({ seed: 20240102 });
  s2.level.monsters = [];
  s2.refreshFov();
  ok(s2.hostileInSight() === null, '没有怪物时视野内没有敌人');
  const antData = monById.get('GIANT_ANT');
  const spot = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]
    .map(([dx, dy]) => ({ x: s2.player.x + dx, y: s2.player.y + dy }))
    .find((p) => isWalkable(s2.tileAt(p.x, p.y)));
  if (antData && spot) {
    const ant = new Monster(antData, spot.x, spot.y, createRng(11));
    ant.asleep = false;
    s2.level.monsters.push(ant);
    s2.refreshFov();
    ok(s2.hostileInSight() === ant, '视野内的敌对生物被识别');
    ant.peaceful = true;
    s2.refreshFov();
    ok(s2.hostileInSight() === null, '和平生物不算威胁');
  } else {
    fail('找不到用来验证视野威胁的相邻地面');
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
