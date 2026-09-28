/**
 * Agent 反馈循环入口。
 *
 * 一次运行完成四件事：
 *
 * 1. 执行确定性场景，逐步校验游戏不变量。
 * 2. 用随机种子做模糊测试，扩大覆盖面。
 * 3. 用 ASCII 地图审计关卡结构（如门朝向），覆盖静态地图缺陷。
 * 4. 比对关卡与战斗快照，发现行为漂移。
 *
 * 输出结构化报告与失败现场，供 Agent 解析后迭代。
 *
 * 常用命令：
 *
 * ```bash
 * bun tools/agent-loop.ts                      # 全量检查
 * bun tools/agent-loop.ts --json               # 输出机器可读报告
 * bun tools/agent-loop.ts --scenario=combat    # 只跑一个场景
 * bun tools/agent-loop.ts --seed=1234          # 换一个基础种子
 * bun tools/agent-loop.ts --fuzz-seed=7788     # 复现某轮模糊测试
 * bun tools/agent-loop.ts --update-golden      # 确认行为变更后更新快照
 * bun tools/agent-loop.ts --list               # 列出可用场景
 * ```
 */

import path from 'node:path';
import * as THREE from 'three';
import type { AgentReport, Failure, ReferenceStatus, ScenarioResult } from './agent-lib';
import {
  auditDoors,
  checkInvariants,
  createSeenTracker,
  doorBlocksEastWest,
  generateLevel,
  levelToAscii,
  newSession,
  randomAction,
  renderMap,
  testRng,
} from './agent-lib';
import { DungeonMesh } from '../src/render/dungeonMesh';
import { describeState } from './agent-scenarios';
import { SCENARIO_NAMES, SCENARIOS } from './agent-scenarios';
import { checkLevelDeterminism } from './agent-lib';
import { collectGolden, compareGolden, type GoldenDiff } from './agent-golden';
import {
  buildSyncHints,
  compareReference,
  loadRecordedReference,
  readReferenceState,
  resolveReferenceRoot,
} from './nethack-ref';

const projectRoot = path.resolve(import.meta.dir, '..');
const DEFAULT_SEED = 20240101;

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

interface Options {
  scenarios: string[];
  seed: number;
  fuzzRuns: number;
  fuzzSteps: number;
  fuzzSeed: number | null;
  mapFuzz: number;
  updateGolden: boolean;
  skipGolden: boolean;
  json: boolean;
  quiet: boolean;
  artifactsDir: string;
}

/** 解析 `--key=value` 形式的参数，未知参数直接报错退出。 */
function parseArgs(argv: string[]): Options | 'help' | 'list' {
  const options: Options = {
    scenarios: SCENARIO_NAMES,
    seed: DEFAULT_SEED,
    fuzzRuns: 6,
    fuzzSteps: 150,
    fuzzSeed: null,
    mapFuzz: 48,
    updateGolden: false,
    skipGolden: false,
    json: false,
    quiet: false,
    artifactsDir: path.join(projectRoot, 'tools', 'agent-artifacts'),
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--list') return 'list';
    if (arg === '--json') options.json = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--update-golden') options.updateGolden = true;
    else if (arg === '--no-golden') options.skipGolden = true;
    else if (arg.startsWith('--scenario=')) {
      options.scenarios = arg
        .slice('--scenario='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--seed=')) options.seed = Number(arg.slice(7)) >>> 0;
    else if (arg.startsWith('--fuzz=')) options.fuzzRuns = Math.max(0, Number(arg.slice(7)) | 0);
    else if (arg.startsWith('--fuzz-steps='))
      options.fuzzSteps = Math.max(1, Number(arg.slice(13)) | 0);
    else if (arg.startsWith('--fuzz-seed='))
      options.fuzzSeed = Number(arg.slice('--fuzz-seed='.length)) >>> 0;
    else if (arg.startsWith('--map-fuzz='))
      options.mapFuzz = Math.max(0, Number(arg.slice('--map-fuzz='.length)) | 0);
    else if (arg.startsWith('--artifacts='))
      options.artifactsDir = path.resolve(projectRoot, arg.slice('--artifacts='.length));
  }

  const unknown = options.scenarios.filter((name) => !SCENARIOS[name]);
  if (unknown.length) {
    console.error(`未知场景：${unknown.join(', ')}`);
    console.error(`可用场景：${SCENARIO_NAMES.join(', ')}`);
    process.exit(2);
  }
  return options;
}

const USAGE = `Agent 反馈循环

用法：bun tools/agent-loop.ts [选项]

  --scenario=名1,名2   只运行指定场景（默认全部）
  --seed=N             基础种子，默认 ${DEFAULT_SEED}
  --fuzz=N             模糊测试轮数，默认 6，设为 0 关闭
  --fuzz-steps=N       每轮随机动作数，默认 150
  --fuzz-seed=N        只复现某一轮模糊测试
  --map-fuzz=N         地图模糊测试层数，默认 48，设为 0 关闭
  --update-golden      更新快照基准（确认行为变更后使用）
  --no-golden          跳过快照比对
  --json               输出结构化报告到 stdout
  --quiet              只输出失败信息
  --artifacts=DIR      产物目录，默认 tools/agent-artifacts
  --list               列出场景
`;

// ---------------------------------------------------------------------------
// 模糊测试
// ---------------------------------------------------------------------------

interface FuzzOutcome {
  runs: number;
  actions: number;
  invariantChecks: number;
  failures: Failure[];
  /** 每轮的关键指标，失败时用于定位。 */
  dumps: { seed: number; depth: number; text: string }[];
}

/** 随机种子与随机行动的组合测试。 */
function runFuzz(options: Options): FuzzOutcome {
  const outcome: FuzzOutcome = { runs: 0, actions: 0, invariantChecks: 0, failures: [], dumps: [] };
  const seeds = options.fuzzSeed !== null ? [options.fuzzSeed] : null;
  const total = seeds ? seeds.length : options.fuzzRuns;

  for (let i = 0; i < total; i++) {
    const seed = seeds ? (seeds[i] as number) : (options.seed + i * 7919) >>> 0;
    const rng = testRng(seed, 'fuzz');
    const depth = 1 + rng.rn2(Math.min(20, 30));
    const session = newSession(seed, { depth });
    const repro = `bun tools/agent-loop.ts --fuzz-seed=${seed} --fuzz=1 --scenario=boot --no-golden`;
    const tracker = createSeenTracker();
    let failed = false;

    const determinism = checkLevelDeterminism(seed, depth);
    if (determinism.length) {
      outcome.failures.push({
        scope: `fuzz seed=${seed}`,
        check: `第 ${depth} 层地形可复现`,
        detail: determinism.join('；'),
        repro,
      });
      failed = true;
    }

    for (let step = 0; step < options.fuzzSteps && !session.dead && !failed; step++) {
      const action = randomAction(session, rng);
      outcome.actions++;
      outcome.invariantChecks++;
      const problems = checkInvariants(session, tracker);
      if (problems.length) {
        outcome.failures.push({
          scope: `fuzz seed=${seed}`,
          check: `第 ${step} 步（${action.action}）后状态自洽`,
          detail: problems.slice(0, 6).join('；'),
          repro,
        });
        outcome.dumps.push({
          seed,
          depth: session.depth,
          text: `${describeState(session)}\n\n${renderMap(session)}`,
        });
        failed = true;
      }
    }
    outcome.runs++;
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// 地图模糊测试
// ---------------------------------------------------------------------------

interface MapFuzzOutcome {
  levels: number;
  doors: number;
  proper: number;
  panels: number;
  failures: Failure[];
  dumps: { seed: number; depth: number; text: string }[];
}

/** 地图缺陷失败项的上限，避免系统性回归时刷屏。 */
const MAP_FUZZ_MAX_FAILURES = 8;

/**
 * 批量生成关卡，用 ASCII 地图审计门的朝向。
 *
 * 行动模糊测试很少碰到静态地图缺陷，而且每轮只生成一层；
 * 这里直接按种子批量生成，把每扇门的通道走向与朝向判定都过一遍。
 */
function runMapFuzz(options: Options): MapFuzzOutcome {
  const outcome: MapFuzzOutcome = {
    levels: 0,
    doors: 0,
    proper: 0,
    panels: 0,
    failures: [],
    dumps: [],
  };
  for (let i = 0; i < options.mapFuzz; i++) {
    const seed = (options.seed + i * 7919) >>> 0;
    const depth = 1 + ((i * 13 + 5) % 30);
    const level = generateLevel({ gameSeed: seed, depth });
    const audit = auditDoors(level);
    outcome.levels++;
    outcome.doors += audit.doors;
    outcome.proper += audit.proper;
    for (const problem of audit.problems) {
      if (outcome.failures.length >= MAP_FUZZ_MAX_FAILURES) continue;
      outcome.failures.push({
        scope: `map fuzz seed=${seed}`,
        check: '门朝向与 ASCII 通道一致',
        detail: `种子 ${seed} 第 ${depth} 层：${problem}`,
        repro: `bun tools/dump-level.ts ${seed} ${depth}`,
      });
      outcome.dumps.push({ seed, depth, text: levelToAscii(level) });
    }

    // 每四层抽一层量渲染几何：闭合门板的长轴必须垂直于判定出的通道。
    // 这一步覆盖渲染层，把「判定对了但渲染用反」挡在提交前。
    if (i % 4 === 0) {
      const mesh = new DungeonMesh(level);
      for (const feature of mesh.features) {
        if (feature.userData.kind !== 'door') continue;
        const anim = feature.userData.animate as
          | { pivot: THREE.Group; closed: boolean }
          | undefined;
        if (!anim?.closed) continue;
        const panel = anim.pivot.children[0] as THREE.Mesh | undefined;
        if (!panel) continue;
        const tile = feature.userData.tile as number;
        panel.updateWorldMatrix(true, false);
        const size = new THREE.Vector3();
        new THREE.Box3().setFromObject(panel).getSize(size);
        outcome.panels++;
        const rendered = size.z > size.x;
        const expected = doorBlocksEastWest(
          level,
          tile % level.width,
          Math.floor(tile / level.width),
        );
        if (rendered !== expected && outcome.failures.length < MAP_FUZZ_MAX_FAILURES) {
          outcome.failures.push({
            scope: `map fuzz seed=${seed}`,
            check: '门板几何与朝向判定一致',
            detail:
              `种子 ${seed} 第 ${depth} 层 (${tile % level.width}, ${Math.floor(tile / level.width)})：` +
              `渲染为拦${rendered ? '东西' : '南北'}向，判定为拦${expected ? '东西' : '南北'}向`,
            repro: `bun tools/dump-level.ts ${seed} ${depth}`,
          });
        }
      }
      for (const kind of mesh.kinds) kind.dispose();
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// 产物写入
// ---------------------------------------------------------------------------

/** 把失败现场写入产物目录，返回写入的文件列表。Bun.write 会自动创建父目录。 */
async function writeFailureDumps(
  dir: string,
  scenarios: ScenarioResult[],
  fuzz: FuzzOutcome,
  mapFuzz: MapFuzzOutcome | null,
): Promise<string[]> {
  const written: string[] = [];
  const failuresDir = path.join(dir, 'failures');
  if (!scenarios.some((s) => !s.ok) && !fuzz.dumps.length && !mapFuzz?.dumps.length) return written;

  // 各份现场互不依赖，收集后并行写入。
  const writes: Promise<number>[] = [];
  for (const scenario of scenarios) {
    if (scenario.ok || !scenario.dump) continue;
    const file = path.join(failuresDir, `${scenario.name}.txt`);
    writes.push(Bun.write(file, `${scenario.name}\n${'='.repeat(40)}\n${scenario.dump}\n`));
    written.push(file);
  }
  for (const dump of fuzz.dumps) {
    const file = path.join(failuresDir, `fuzz-${dump.seed}.txt`);
    writes.push(
      Bun.write(
        file,
        `fuzz seed=${dump.seed} depth=${dump.depth}\n${'='.repeat(40)}\n${dump.text}\n`,
      ),
    );
    written.push(file);
  }
  for (const dump of mapFuzz?.dumps ?? []) {
    const file = path.join(failuresDir, `map-${dump.seed}-d${dump.depth}.txt`);
    writes.push(
      Bun.write(
        file,
        `map seed=${dump.seed} depth=${dump.depth}\n${'='.repeat(40)}\n${dump.text}\n`,
      ),
    );
    written.push(file);
  }
  await Promise.all(writes);
  return written;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/**
 * 参考仓库版本检查。
 *
 * 参考仓库可能不存在（例如只在 CI 中运行游戏代码），因此失败时静默降级为
 * unavailable，不阻塞反馈循环。
 */
function checkReference(): ReferenceStatus {
  try {
    const recorded = loadRecordedReference();
    if (!recorded) return { status: 'unavailable' };
    const root = resolveReferenceRoot();
    const current = readReferenceState(root);
    if (current.commit === 'unknown') return { status: 'unavailable' };
    const drift = compareReference(recorded, current);
    if (drift.upToDate) {
      return { status: 'up-to-date', commit: current.shortCommit };
    }
    return {
      status: 'drift',
      commit: current.shortCommit,
      changedFiles: drift.changedFiles,
      countDrift: drift.countDrift,
      hints: buildSyncHints(drift, current),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/** 生成给 Agent 的下一步建议。 */
function buildHints(report: AgentReport, golden: GoldenDiff, dumps: string[]): string[] {
  const hints: string[] = [];
  if (report.failures.length) {
    hints.push('按 repro 命令逐个复现失败场景，修复后重跑本命令');
    hints.push('失败现场已包含地图与状态摘要，见 --artifacts 目录');
  }
  if (golden.mismatched.length && !golden.written) {
    hints.push('快照不一致：若是预期改动，执行 --update-golden 更新基准并在提交信息中说明');
  }
  if (!report.failures.length && !golden.mismatched.length) {
    hints.push('全部通过：可运行 bun run verify 完成提交前校验');
    hints.push('如需覆盖浏览器渲染，运行 bun tools/agent-e2e.ts');
  }
  if (report.reference.status === 'drift') {
    hints.push('参考仓库已更新：先按 docs/NETHACK-SYNC.md 同步数据，再判断游戏侧改动');
  }
  if (report.totals.actions < 200) {
    hints.push('本轮动作数偏少，可提高 --fuzz 或 --fuzz-steps 扩大覆盖');
  }
  if (dumps.length) hints.push(`失败现场文件：${dumps.slice(0, 3).join('、')}`);
  return hints;
}

/** 人类可读摘要。 */
function printSummary(report: AgentReport, options: Options): void {
  const { totals } = report;
  const scenarioPass = totals.scenarios - totals.failedScenarios;
  console.log(
    `Agent 反馈循环 · 种子 ${report.baseSeed} · 耗时 ${(report.durationMs / 1000).toFixed(2)}s`,
  );
  console.log(
    `场景 ${scenarioPass}/${totals.scenarios} 通过 · 模糊 ${totals.fuzzRuns} 轮 · ` +
      `动作 ${totals.actions} · 不变量 ${totals.checks} 项`,
  );
  if (totals.mapLevels > 0) {
    console.log(
      `地图模糊 ${totals.mapLevels} 层 · 门 ${totals.mapDoors} 扇 · ` +
        `形状合规 ${totals.mapProper} 项 · 门板抽检 ${totals.mapPanels} 扇`,
    );
  }
  if (!options.skipGolden) {
    console.log(
      `快照 ${report.golden.compared} 项，不一致 ${report.golden.mismatched.length} 项` +
        (report.golden.written ? '（已更新）' : ''),
    );
  }
  const ref = report.reference;
  if (ref.status !== 'unavailable') {
    console.log(
      ref.status === 'up-to-date'
        ? `参考版本 ${ref.commit} 与记录一致`
        : `参考版本已漂移：变化文件 ${(ref.changedFiles ?? []).join('、') || '无'}`,
    );
  }

  for (const scenario of report.scenarios) {
    if (scenario.ok) continue;
    console.log(`\n失败场景 ${scenario.name}（${scenario.durationMs}ms）`);
    for (const failure of scenario.failures) {
      console.log(`  · ${failure.check}`);
      if (failure.detail) console.log(`    ${failure.detail}`);
      if (failure.repro) console.log(`    复现：${failure.repro}`);
    }
  }
  const fuzzFailures = report.failures.filter((f) => f.scope.startsWith('fuzz'));
  if (fuzzFailures.length) {
    console.log(`\n模糊测试失败 ${fuzzFailures.length} 项`);
    for (const failure of fuzzFailures.slice(0, 5)) {
      console.log(`  · ${failure.scope} ${failure.check}`);
      if (failure.detail) console.log(`    ${failure.detail}`);
      if (failure.repro) console.log(`    复现：${failure.repro}`);
    }
  }
  const mapFailures = report.failures.filter((f) => f.scope.startsWith('map fuzz'));
  if (mapFailures.length) {
    console.log(`\n地图模糊失败 ${mapFailures.length} 项`);
    for (const failure of mapFailures.slice(0, 5)) {
      console.log(`  · ${failure.check}`);
      if (failure.detail) console.log(`    ${failure.detail}`);
      if (failure.repro) console.log(`    复现：${failure.repro}`);
    }
  }
  if (report.golden.mismatched.length) {
    console.log('\n快照不一致');
    for (const item of report.golden.mismatched.slice(0, 8)) {
      console.log(`  · ${item.key} 期望 ${item.expected} 实际 ${item.actual}`);
    }
  }

  if (!options.quiet) {
    console.log('\n提示');
    for (const hint of report.hints) console.log(`  · ${hint}`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  if (parsed === 'list') {
    for (const name of SCENARIO_NAMES) {
      console.log(`${name.padEnd(10)} ${SCENARIOS[name].description}`);
    }
    return;
  }
  const options = parsed;
  const startedAt = new Date();
  const start = Date.now();

  const scenarios: ScenarioResult[] = [];
  for (const name of options.scenarios) {
    const started = Date.now();
    const result = SCENARIOS[name].run(options.seed);
    result.durationMs = Date.now() - started;
    scenarios.push(result);
    if (!options.json) {
      process.stderr.write(`${result.ok ? 'ok  ' : 'fail'} ${name} ${result.durationMs}ms\n`);
    }
  }

  const fuzz = options.fuzzRuns > 0 || options.fuzzSeed !== null ? runFuzz(options) : null;
  const mapFuzz = options.mapFuzz > 0 ? runMapFuzz(options) : null;
  const reference = checkReference();
  const goldenData = collectGolden();
  const golden = options.skipGolden
    ? { compared: 0, mismatched: [], written: false }
    : compareGolden(goldenData, options.updateGolden);

  const failures: Failure[] = [
    ...scenarios.flatMap((s) => s.failures),
    ...(fuzz?.failures ?? []),
    ...(mapFuzz?.failures ?? []),
    ...golden.mismatched.map((m) => ({
      scope: 'golden',
      check: `快照不一致 ${m.key}`,
      detail: `期望 ${m.expected} 实际 ${m.actual}`,
      repro: 'bun tools/agent-loop.ts --update-golden',
    })),
  ];

  const report: AgentReport = {
    ok: failures.length === 0,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - start,
    baseSeed: options.seed,
    totals: {
      scenarios: scenarios.length,
      failedScenarios: scenarios.filter((s) => !s.ok).length,
      checks:
        scenarios.reduce((sum, s) => sum + s.invariantChecks, 0) + (fuzz?.invariantChecks ?? 0),
      failedChecks: failures.length,
      actions: scenarios.reduce((sum, s) => sum + s.actions, 0) + (fuzz?.actions ?? 0),
      fuzzRuns: fuzz?.runs ?? 0,
      mapLevels: mapFuzz?.levels ?? 0,
      mapDoors: mapFuzz?.doors ?? 0,
      mapProper: mapFuzz?.proper ?? 0,
      mapPanels: mapFuzz?.panels ?? 0,
    },
    scenarios,
    golden,
    failures,
    hints: [],
    reference,
  };

  const dumps = await writeFailureDumps(
    options.artifactsDir,
    scenarios,
    fuzz ?? { runs: 0, actions: 0, invariantChecks: 0, failures: [], dumps: [] },
    mapFuzz,
  );
  // 先补齐提示再写文件，保证报告文件与终端输出一致。
  report.hints = buildHints(report, golden, dumps);
  await Bun.write(
    path.join(options.artifactsDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report, options);

  process.exit(report.ok ? 0 : 1);
}

await main();
