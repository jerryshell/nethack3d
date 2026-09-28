/**
 * 参考 NetHack 仓库的版本记录与漂移检测。
 *
 * 游戏数据由 tools 下的提取脚本从 NetHack 5.0 源码生成，因此必须记住
 * 生成时的参考版本：将来参考仓库更新后，才能判断哪些文件变了、
 * 是否需要重新提取、生成结果是否已经过期。
 *
 * 记录的元数据写在 tools/nethack-reference.json，随仓库提交。
 * 检测逻辑被提取脚本与 `bun run sync:check` 共用。
 */

import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dir, '..');

/** 记录文件路径。 */
export const REFERENCE_RECORD_PATH = path.join(projectRoot, 'tools', 'nethack-reference.json');

/**
 * 提取脚本读取的参考文件。
 *
 * 这里的清单必须与 extract-nh-data.ts、extract-nh-roles.ts 实际读取的文件一致，
 * 否则漂移检测会漏报。
 */
export const REFERENCE_FILES = [
  'include/monsters.h',
  'include/objects.h',
  'include/defsym.h',
  'include/color.h',
  'src/role.c',
];

/** 参考仓库当前状态。 */
export interface ReferenceState {
  root: string;
  commit: string;
  shortCommit: string;
  branch: string;
  commitDate: string;
  commitSubject: string;
  remote: string | null;
  /** 工作区是否干净；有未提交改动时记录值不能完全代表生成数据。 */
  worktreeClean: boolean;
  /** 关键文件的 sha256 前 16 位，用于精确判断是否变化。 */
  fileHashes: Record<string, string>;
  /** 参考文件中的条目计数。 */
  counts: { monsters: number; objects: number };
}

/** 写入文件的记录。 */
export interface RecordedReference extends ReferenceState {
  version: 1;
  recordedAt: string;
  /** 记录时生成数据的条数，便于与参考计数交叉验证。 */
  generated: { monsters: number; objects: number; roles: number; races: number };
}

/** 漂移比对结果。 */
export interface ReferenceDrift {
  upToDate: boolean;
  commitChanged: boolean;
  changedFiles: string[];
  countDrift: string[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// 仓库定位与读取
// ---------------------------------------------------------------------------

/** 解析参考仓库路径：命令行参数、环境变量、项目上级目录的 nethack。 */
export function resolveReferenceRoot(explicit?: string): string {
  return path.resolve(
    explicit || process.env.NETHACK_SRC || path.join(projectRoot, '..', 'nethack'),
  );
}

/**
 * 执行 git 命令，失败时返回 null。
 *
 * 使用 `cwd` 而不是 `-C`：在 Windows 上后者会让 git 的启动开销从约 0.1 秒
 * 涨到近 10 秒，反馈循环会因此明显变慢。
 */
function git(root: string, args: string[]): string | null {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  if ((proc.exitCode ?? -1) !== 0) return null;
  return proc.stdout.toString().trim();
}

/**
 * 直接读取 HEAD 指向的提交号与分支名。
 *
 * 轻量路径完全不启动子进程：解析 .git/HEAD、松散引用与 packed-refs 即可，
 * 成本接近零。这一点很关键：在本项目的运行环境里，一个进程内首次调用
 * git 需要约 10 秒（冷启动），后续调用约 0.1 秒，因此高频路径必须避免子进程。
 */
export function readHead(root: string): { commit: string; branch: string | null } {
  const gitDir = (() => {
    const dotGit = path.join(root, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      // HEAD 位于独立文件（worktree 或 submodule）时，.git 是一个文本文件。
      const text = fs.readFileSync(dotGit, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/.exec(text);
      return match ? path.resolve(root, match[1].trim()) : null;
    } catch {
      return null;
    }
  })();
  if (!gitDir) return { commit: 'unknown', branch: null };

  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return { commit: head, branch: null };
    const ref = head.slice(4).trim();
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    try {
      return { commit: fs.readFileSync(path.join(gitDir, ref), 'utf8').trim(), branch };
    } catch {
      // 引用被打包进 packed-refs。
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      for (const line of packed.split(String.fromCharCode(10))) {
        if (!line || line.startsWith('#') || line.startsWith('^')) continue;
        const [hash, name] = line.trim().split(/\s+/);
        if (name === ref) return { commit: hash, branch };
      }
      return { commit: 'unknown', branch };
    }
  } catch {
    return { commit: 'unknown', branch: null };
  }
}

/** 只取提交号。 */
export function readHeadCommit(root: string): string {
  return readHead(root).commit;
}

/** 计算文件散列；文件不存在时返回 null。 */
export function hashFile(filePath: string): string | null {
  try {
    return new Bun.CryptoHasher('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex')
      .slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * 统计参考文件中的条目数量。
 *
 * 与提取脚本使用同一套约定：怪物的 `MON(` 条目、物品的类宏条目。
 * 计数只用于漂移提示，正式数据仍以提取脚本的输出为准。
 */
export function countReferenceEntries(root: string): { monsters: number; objects: number } {
  const read = (rel: string): string => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return '';
    }
  };
  const classMacros =
    /^\s*(WEAPON|PROJECTILE|BOW|ARMOR|HELM|CLOAK|SHIELD|BOOTS|GLOVES|DRGN_ARMR|POTION|SCROLL|SPELL|WAND|RING|AMULET|TOOL|CONTAINER|EYEWEAR|WEPTOOL|FOOD|GEM|ROCK|COIN)\(/gm;
  return {
    monsters: (read('include/monsters.h').match(/^\s*MON\(/gm) ?? []).length,
    objects: (read('include/objects.h').match(classMacros) ?? []).length,
  };
}

/**
 * 读取参考仓库的当前状态。
 *
 * 默认使用轻量模式：只查提交号、文件散列与条目计数，成本在百毫秒级，
 * 适合反馈循环这类高频调用。`full` 模式才会额外读取分支、提交信息、
 * 远程地址与工作区状态，这些命令在大型仓库上可能耗时数秒。
 */
export function readReferenceState(
  root: string,
  { full = false }: { full?: boolean } = {},
): ReferenceState {
  const fileHashes: Record<string, string> = {};
  for (const rel of REFERENCE_FILES) {
    fileHashes[rel] = hashFile(path.join(root, rel)) ?? 'missing';
  }
  const head = readHead(root);
  const commit = head.commit;
  const base: ReferenceState = {
    root,
    commit,
    shortCommit: commit === 'unknown' ? 'unknown' : commit.slice(0, 7),
    // 分支名同样来自 .git/HEAD，无需启动 git。
    branch: head.branch ?? 'unknown',
    commitDate: 'unknown',
    commitSubject: 'unknown',
    remote: null,
    worktreeClean: true,
    fileHashes,
    counts: countReferenceEntries(root),
  };
  if (!full) return base;

  return {
    ...base,
    // 分支名已在 readHead 中解析；以下调用只出现在记录与漂移详情这类
    // 一次性路径上，可以接受冷启动开销。
    commitDate: git(root, ['log', '-1', '--format=%ad', '--date=iso']) ?? 'unknown',
    commitSubject: git(root, ['log', '-1', '--format=%s']) ?? 'unknown',
    remote: git(root, ['remote', 'get-url', 'origin']),
    worktreeClean: (git(root, ['status', '--porcelain']) ?? 'x').length === 0,
  };
}

/** 读取记录文件；文件缺失或损坏时返回 null。 */
export function loadRecordedReference(): RecordedReference | null {
  try {
    if (!fs.existsSync(REFERENCE_RECORD_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(REFERENCE_RECORD_PATH, 'utf8')) as RecordedReference;
    return data.version === 1 ? data : null;
  } catch {
    return null;
  }
}

/**
 * 写入记录文件。
 *
 * 参考仓库路径以相对项目根目录的形式保存，避免把机器相关的绝对路径提交进仓库。
 */
export function saveRecordedReference(record: RecordedReference): void {
  const normalized: RecordedReference = {
    ...record,
    root: path.relative(projectRoot, record.root).split(path.sep).join('/'),
  };
  fs.writeFileSync(REFERENCE_RECORD_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// 漂移比对
// ---------------------------------------------------------------------------

/** 比较记录与当前状态，给出是否需要重新生成数据。 */
export function compareReference(
  recorded: RecordedReference,
  current: ReferenceState,
): ReferenceDrift {
  const changedFiles: string[] = [];
  for (const rel of REFERENCE_FILES) {
    if (recorded.fileHashes[rel] !== current.fileHashes[rel]) changedFiles.push(rel);
  }
  const countDrift: string[] = [];
  if (recorded.counts.monsters !== current.counts.monsters) {
    countDrift.push(`怪物条目 ${recorded.counts.monsters} -> ${current.counts.monsters}`);
  }
  if (recorded.counts.objects !== current.counts.objects) {
    countDrift.push(`物品条目 ${recorded.counts.objects} -> ${current.counts.objects}`);
  }
  const notes: string[] = [];
  if (!current.worktreeClean) {
    notes.push('参考仓库工作区有未提交改动，记录值可能无法完全代表当前生成数据');
  }
  if (!changedFiles.length && recorded.commit !== current.commit) {
    notes.push('HEAD 已变化，但提取所依赖的文件未变，无需重新生成数据');
  }

  return {
    upToDate: changedFiles.length === 0 && countDrift.length === 0,
    commitChanged: recorded.commit !== current.commit,
    changedFiles,
    countDrift,
    notes,
  };
}

/** 输出两个版本之间指定文件的差异统计。 */
export function gitDiffStat(
  root: string,
  from: string,
  to: string,
  files = REFERENCE_FILES,
): string {
  return git(root, ['diff', '--stat', `${from}..${to}`, '--', ...files]) ?? '';
}

/** 输出两个版本之间指定文件的提交列表。 */
export function gitLogBetween(
  root: string,
  from: string,
  to: string,
  files = REFERENCE_FILES,
  limit = 20,
): string {
  return git(root, ['log', '--oneline', `-${limit}`, `${from}..${to}`, '--', ...files]) ?? '';
}

/** 输出指定文件在两个版本之间的补丁内容。 */
export function gitDiffPatch(
  root: string,
  from: string,
  to: string,
  files = REFERENCE_FILES,
): string {
  return git(root, ['diff', `${from}..${to}`, '--', ...files]) ?? '';
}

/** 生成给开发者与 Agent 的同步建议。 */
export function buildSyncHints(drift: ReferenceDrift, current: ReferenceState): string[] {
  const hints: string[] = [];
  if (drift.upToDate) {
    hints.push('参考版本与记录一致，生成数据无需更新');
    return hints;
  }
  hints.push('先看差异：bun tools/sync-nethack.ts --full-diff');
  hints.push('确认变更后重新提取：bun run extract');
  hints.push('记录新版本：bun run sync:record');
  hints.push('跑回归并检查快照：bun run agent（必要时 --update-golden）');
  hints.push('更新文档中的参考版本号：docs/NETHACK-SYNC.md 与 README.md');
  if (drift.countDrift.length) {
    hints.push(`条目数量变化：${drift.countDrift.join('；')}`);
  }
  if (!current.worktreeClean) {
    hints.push('参考仓库工作区不干净，建议先提交或暂存改动，保证记录可复现');
  }
  return hints;
}
