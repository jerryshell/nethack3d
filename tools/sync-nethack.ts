/**
 * 参考版本同步工具。
 *
 * 游戏数据来自参考 NetHack 仓库，因此需要能回答两个问题：
 * 参考仓库是否已经更新？生成的数据是否还对应当前参考版本？
 *
 * ```bash
 * bun run sync:check        # 检查漂移（默认行为，漂移时退出码为 1）
 * bun run sync:check --json # 机器可读输出，供 Agent 判断
 * bun tools/sync-nethack.ts --full-diff    # 查看关键文件的完整差异
 * bun run sync:record       # 记录当前参考版本（重新提取之后执行）
 * ```
 */

import type { ReferenceState } from './nethack-ref';
import {
  REFERENCE_FILES,
  REFERENCE_RECORD_PATH,
  buildSyncHints,
  compareReference,
  gitDiffStat,
  gitLogBetween,
  gitDiffPatch,
  loadRecordedReference,
  readReferenceState,
  resolveReferenceRoot,
  saveRecordedReference,
} from './nethack-ref';
import { MONSTERS, OBJECTS } from '../src/data/index';
import { ROLES, RACES } from '../src/game/roles';

interface Options {
  mode: 'check' | 'record';
  json: boolean;
  fullDiff: boolean;
  ref: string | undefined;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { mode: 'check', json: false, fullDiff: false, ref: undefined };
  for (const arg of argv) {
    if (arg === '--record') options.mode = 'record';
    else if (arg === '--check') options.mode = 'check';
    else if (arg === '--json') options.json = true;
    else if (arg === '--full-diff') options.fullDiff = true;
    else if (arg.startsWith('--ref=')) options.ref = arg.slice(6);
  }
  return options;
}

/** 当前生成数据的条数。 */
function generatedCounts(): { monsters: number; objects: number; roles: number; races: number } {
  return {
    monsters: MONSTERS.length,
    objects: OBJECTS.length,
    roles: ROLES.length,
    races: RACES.length,
  };
}

/** 记录模式的输出。 */
function runRecord(root: string, current: ReferenceState, json: boolean): number {
  const generated = generatedCounts();
  saveRecordedReference({
    ...current,
    version: 1,
    recordedAt: new Date().toISOString(),
    generated,
  });
  const payload = {
    ok: true,
    mode: 'record',
    record: REFERENCE_RECORD_PATH,
    commit: current.commit,
    shortCommit: current.shortCommit,
    branch: current.branch,
    commitDate: current.commitDate,
    counts: current.counts,
    generated,
    worktreeClean: current.worktreeClean,
    hints: [
      '确认数据已重新生成：bun run extract',
      '跑回归检查：bun run agent（快照有变化时先确认是否符合预期）',
      '更新文档：docs/NETHACK-SYNC.md 与 README.md 中的参考版本号',
    ],
  };
  if (json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`已记录参考版本 ${current.shortCommit}（${current.branch}）`);
    console.log(`参考条目：怪物 ${current.counts.monsters}、物品 ${current.counts.objects}`);
    console.log(
      `生成数据：怪物 ${generated.monsters}、物品 ${generated.objects}、职业 ${generated.roles}、种族 ${generated.races}`,
    );
    console.log(`记录文件：${REFERENCE_RECORD_PATH}`);
    // NOTICE.md 引用参考版本与提取的源文件，版本变化时需要同步更新。
    console.log('提醒：若版本与 NOTICE.md 中的值不同，请同步更新该文件');
    for (const hint of payload.hints) console.log(`  · ${hint}`);
  }
  return 0;
}

/** 检查模式的输出。 */
function runCheck(root: string, current: ReferenceState, options: Options): number {
  const recorded = loadRecordedReference();
  if (!recorded) {
    const payload = {
      ok: false,
      mode: 'check',
      error: '尚未记录参考版本',
      fix: 'bun run sync:record',
    };
    if (options.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.error('尚未记录参考版本，先执行：bun run sync:record');
    }
    return 2;
  }

  const drift = compareReference(recorded, current);
  const generated = generatedCounts();
  const generatedDrift: string[] = [];
  if (recorded.generated.monsters !== generated.monsters) {
    generatedDrift.push(`怪物 ${recorded.generated.monsters} -> ${generated.monsters}`);
  }
  if (recorded.generated.objects !== generated.objects) {
    generatedDrift.push(`物品 ${recorded.generated.objects} -> ${generated.objects}`);
  }

  const diffStat = drift.upToDate ? '' : gitDiffStat(root, recorded.commit, current.commit);
  const log = drift.upToDate ? '' : gitLogBetween(root, recorded.commit, current.commit);
  const hints = buildSyncHints(drift, current);

  const payload = {
    ok: drift.upToDate && generatedDrift.length === 0,
    mode: 'check',
    recorded: {
      commit: recorded.commit,
      shortCommit: recorded.shortCommit,
      branch: recorded.branch,
      commitDate: recorded.commitDate,
      recordedAt: recorded.recordedAt,
      counts: recorded.counts,
      generated: recorded.generated,
    },
    current: {
      commit: current.commit,
      shortCommit: current.shortCommit,
      branch: current.branch,
      commitDate: current.commitDate,
      counts: current.counts,
      generated,
      worktreeClean: current.worktreeClean,
    },
    commitChanged: drift.commitChanged,
    changedFiles: drift.changedFiles,
    countDrift: drift.countDrift,
    generatedDrift,
    notes: drift.notes,
    diffStat,
    log,
    hints,
  };

  if (options.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(
      `参考版本：记录 ${recorded.shortCommit}（${recorded.branch}）· 当前 ${current.shortCommit}（${current.branch}）`,
    );
    if (drift.upToDate && !generatedDrift.length) {
      console.log('关键文件与条目数量均未变化，生成数据有效期正常');
    } else {
      if (drift.changedFiles.length) {
        console.log(`关键文件变化 ${drift.changedFiles.length} 个：`);
        for (const file of drift.changedFiles) console.log(`  · ${file}`);
      }
      if (drift.countDrift.length) console.log(`条目数量变化：${drift.countDrift.join('；')}`);
      if (generatedDrift.length) console.log(`生成数据与记录不一致：${generatedDrift.join('；')}`);
      if (diffStat) console.log(`\n差异统计：\n${diffStat}`);
      if (log) console.log(`\n相关提交：\n${log}`);
    }
    for (const note of drift.notes) console.log(`注意：${note}`);
    console.log('\n建议：');
    for (const hint of hints) console.log(`  · ${hint}`);
  }

  if (options.fullDiff && !drift.upToDate) {
    const patch = gitDiffPatch(root, recorded.commit, current.commit);
    if (options.json) console.log(JSON.stringify({ patch }, null, 2));
    else console.log(`\n完整差异（${REFERENCE_FILES.join('、')}）：\n${patch}`);
  }

  return payload.ok ? 0 : 1;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const root = resolveReferenceRoot(options.ref);
  // 检查默认只读轻量信息（提交号、分支、文件散列、条目计数），全程不启动子进程。
  // 只有确实检出漂移、需要展示提交列表与工作区状态时，才读取完整信息；
  // 命令行工具与反馈循环共用这一策略。
  let current = readReferenceState(root);
  if (options.mode === 'record') current = readReferenceState(root, { full: true });
  const recordedForCheck = options.mode === 'check' ? loadRecordedReference() : null;
  const drifted =
    recordedForCheck !== null &&
    current.commit !== 'unknown' &&
    !compareReference(recordedForCheck, current).upToDate;
  if (drifted) current = readReferenceState(root, { full: true });

  if (current.commit === 'unknown') {
    console.error(`无法读取参考仓库：${root}`);
    console.error('用 --ref=路径 或环境变量 NETHACK_SRC 指定 NetHack 源码目录。');
    process.exit(2);
  }

  const code =
    options.mode === 'record'
      ? runRecord(root, current, options.json)
      : runCheck(root, current, options);
  process.exit(code);
}

main();
