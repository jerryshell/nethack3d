/**
 * 浏览器端到端检查。
 *
 * 无头场景覆盖不到渲染与界面，本脚本用 agent-browser 驱动真实浏览器补上这一环：
 *
 * - 打开带调试参数的页面，确认应用启动且没有错误级日志。
 * - 走完「标题 → 角色创建 → 开始游戏」，确认会话已建立。
 * - 下发若干按键，确认渲染循环在跑、回合在推进。
 * - 截图保存到产物目录，供人工或模型复核画面。
 *
 * ```bash
 * bun tools/agent-e2e.ts                  # 默认端口 5273，开发服务器
 * bun tools/agent-e2e.ts --preview        # 先构建，再检查生产产物
 * bun tools/agent-e2e.ts --keep-server    # 保留服务，便于手动继续观察
 * bun tools/agent-e2e.ts --keep-browser   # 复用浏览器会话，跳过冷启动
 * ```
 *
 * 开发服务器与生产产物可能表现不同（压缩、摇树、相对路径都在构建期生效），
 * 因此提交前建议至少跑一次 `--preview`。
 *
 * 首次启动浏览器需要约一分钟，因此迭代时建议加 `--keep-browser`：
 * 会话固定为 `nh3d-e2e` 且不关闭，再次运行只需数秒。收尾时手动执行
 * `agent-browser --session nh3d-e2e close`。
 *
 * 未安装 agent-browser 时输出 `skipped` 并以 0 退出，避免阻塞纯逻辑开发。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Failure } from './agent-lib';

const projectRoot = path.resolve(import.meta.dir, '..');
const artifactsDir = path.join(projectRoot, 'tools', 'agent-artifacts');

interface Options {
  port: number;
  keepServer: boolean;
  keepBrowser: boolean;
  preview: boolean;
  url: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    port: 5273,
    keepServer: false,
    keepBrowser: false,
    preview: false,
    url: null,
  };
  for (const arg of argv) {
    if (arg.startsWith('--port=')) options.port = Number(arg.slice(7));
    else if (arg === '--keep-server') options.keepServer = true;
    else if (arg === '--keep-browser') options.keepBrowser = true;
    else if (arg === '--preview') options.preview = true;
    else if (arg.startsWith('--url=')) options.url = arg.slice(6);
  }
  return options;
}

// ---------------------------------------------------------------------------
// 进程与网络辅助
// ---------------------------------------------------------------------------

/** 在进入浏览器步骤前失败退出：输出与正常报告同构的 JSON，方便上游解析。 */
function failFast(check: string, detail: string): never {
  console.log(
    JSON.stringify(
      { ok: false, failure: { scope: 'e2e', check, detail }, hint: '修正后重跑 bun run agent:e2e' },
      null,
      2,
    ),
  );
  process.exit(1);
}

/** 执行外部命令，返回退出码与合并输出。 */
function run(cmd: string[], timeoutMs = 60_000): { code: number; out: string } {
  const proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
  const out = `${proc.stdout?.toString() ?? ''}${proc.stderr?.toString() ?? ''}`.trim();
  return { code: proc.exitCode ?? -1, out };
}

/** 服务类型：开发服务器、生产产物，或无法判断。 */
type ServerKind = 'dev' | 'built' | 'unknown';

/**
 * 判断端口上运行的是哪种服务。
 *
 * 开发服务器会在 HTML 里注入 `/@vite/client`，生产产物只会引用构建后的资源。
 * 这一步用于避免「以为在验证生产构建，实际连的是开发服务器」。
 */
async function detectServerKind(url: string): Promise<ServerKind> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const html = await res.text();
    if (html.includes('/@vite/client')) return 'dev';
    if (/\/assets\/[^"']+\.js/.test(html)) return 'built';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 轮询等待服务可访问。 */
async function waitForServer(url: string, timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // 轮询等待服务就绪：必须逐次请求与休眠，不能合并为并行调用。
  /* oxlint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // 服务还没起来，继续等待。
    }
    await Bun.sleep(500);
  }
  /* oxlint-enable no-await-in-loop */
  return false;
}

/**
 * 启动待测服务；返回停止函数。
 *
 * 默认用开发服务器；`preview` 模式先构建，再用 `vite preview` 提供生产产物。
 */
function startServer(port: number, preview: boolean): () => void {
  if (preview) {
    const build = run(
      ['bun', path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
      180_000,
    );
    if (build.code !== 0) {
      console.error(`构建失败：
${build.out}`);
      process.exit(1);
    }
  }
  // 直接运行 vite 的入口脚本。套一层 `bun run` 或在 Windows 上调用
  // node_modules/.bin 里的批处理壳，都会多出一层进程：kill 只杀得掉包装进程，
  // 服务会留在端口上，后续运行就会连到上一次的旧服务。
  const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const args = preview ? ['preview'] : [];
  const proc = Bun.spawn({
    cmd: ['bun', viteBin, ...args, '--port', String(port)],
    cwd: projectRoot,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return () => proc.kill();
}

// ---------------------------------------------------------------------------
// 浏览器步骤
// ---------------------------------------------------------------------------

/** 单步结果。 */
interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
  /** 该步耗时，毫秒。 */
  ms: number;
}

/**
 * 展开嵌套的 JSON 编码。
 *
 * agent-browser 会把页面返回值再包一层 JSON，因此字符串可能被编码两次。
 */
function unwrap(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 3; i++) {
    if (typeof current !== 'string') break;
    const text = current.trim();
    const looksLikeJson =
      text.startsWith('{') ||
      text.startsWith('[') ||
      text.startsWith('"') ||
      text === 'true' ||
      text === 'false' ||
      text === 'null' ||
      /^-?\d/.test(text);
    if (!looksLikeJson) break;
    try {
      current = JSON.parse(text);
    } catch {
      break;
    }
  }
  return current;
}

/** 在页面内执行表达式并返回解析后的结果。 */
function evaluate(
  session: string,
  expression: string,
): { ok: boolean; value: unknown; raw: string } {
  const { code, out } = run(['agent-browser', '--session', session, 'eval', expression]);
  if (code !== 0) return { ok: false, value: null, raw: out };
  let parsed: unknown = out;
  try {
    parsed = JSON.parse(out);
  } catch {
    // 输出不是 JSON，保持原始文本。
  }
  return { ok: true, value: unwrap(parsed), raw: out };
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const options = parseArgs(process.argv.slice(2));
  const failures: Failure[] = [];
  const steps: StepResult[] = [];
  // 记录每步耗时：浏览器路径最容易变慢，报告里保留数据便于定位。
  let lastMark = performance.now();
  const record = (name: string, ok: boolean, detail = ''): void => {
    const now = performance.now();
    steps.push({ name, ok, detail, ms: Math.round(now - lastMark) });
    lastMark = now;
    if (!ok) failures.push({ scope: 'e2e', check: name, detail });
  };

  const browser = Bun.which('agent-browser');
  if (!browser) {
    console.log(
      JSON.stringify({ ok: true, skipped: true, reason: '未安装 agent-browser' }, null, 2),
    );
    return;
  }

  const baseUrl = options.url ?? `http://localhost:${options.port}/`;
  const wanted: ServerKind = options.preview ? 'built' : 'dev';
  let stopServer: (() => void) | null = null;
  // 渲染开销快照，写入报告供性能对比。
  let perfData: Record<string, number> | null = null;

  if (await waitForServer(baseUrl, 1500)) {
    // 端口上已经有服务：先确认类型，避免把开发服务器当成生产产物验证。
    const found = await detectServerKind(baseUrl);
    if (found !== wanted && found !== 'unknown') {
      const label = found === 'dev' ? '开发服务器' : '生产产物';
      const need = options.preview ? '生产产物' : '开发服务器';
      failFast(
        '待测服务类型',
        `${baseUrl} 上运行的是${label}，本次需要${need}。请先停止该服务，或用 --url 指定其它地址`,
      );
    }
  } else {
    console.error(`服务未启动，正在拉起服务：${baseUrl}`);
    stopServer = startServer(options.port, options.preview);
    if (!(await waitForServer(baseUrl))) failFast('待测服务可用', baseUrl);
  }

  // 沿用固定会话名时可直接复用已启动的浏览器。
  const session = options.keepBrowser ? 'nh3d-e2e' : `nh3d-e2e-${process.pid}`;
  fs.mkdirSync(artifactsDir, { recursive: true });
  const screenshotPath = path.join(artifactsDir, 'browser.png');

  try {
    // 1. 打开页面
    const open = run(['agent-browser', '--session', session, 'open', `${baseUrl}?debug=1`]);
    record('页面打开', open.code === 0, open.out.slice(0, 200));

    // 2. 应用启动：调试句柄存在，标题页渲染出按钮
    const boot = evaluate(
      session,
      `JSON.stringify({
        hook: typeof window.__nethack3dLog === 'object',
        logCount: window.__nethack3dLog ? window.__nethack3dLog.recent().length : -1,
        buttons: document.querySelectorAll('button').length,
        canvas: !!document.querySelector('canvas'),
        webgl: (() => { const c = document.querySelector('canvas'); return !!(c && (c.getContext('webgl2') || c.getContext('webgl'))); })(),
      })`,
    );
    const bootData = (boot.value ?? {}) as Record<string, unknown>;
    record('页面已加载应用', bootData.hook === true, JSON.stringify(bootData));
    record('标题页有可交互按钮', Number(bootData.buttons ?? 0) >= 3, `按钮数=${bootData.buttons}`);
    record('画布存在', bootData.canvas === true);
    record('WebGL 上下文可用', bootData.webgl === true);

    // 3. 走到开始游戏
    evaluate(
      session,
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => /新游戏|New Game/i.test(x.textContent)); b?.click(); return !!b; })()`,
    );
    const creation = evaluate(session, `document.querySelectorAll('.chip').length`);
    record('角色创建界面可用', Number(creation.value ?? 0) > 10, `选项数=${creation.value}`);

    evaluate(
      session,
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => /开始下潜|Begin/i.test(x.textContent)); b?.click(); return !!b; })()`,
    );
    const started = evaluate(session, `!!window.__nethack3d`);
    record('进入游戏会话', started.value === true);

    // 4. 渲染循环与回合推进
    const frames = evaluate(
      session,
      `new Promise((resolve) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 600) requestAnimationFrame(tick); else resolve(n); }; requestAnimationFrame(tick); })`,
    );
    record('渲染循环在运行', Number(frames.value ?? 0) > 5, `600ms 内帧数=${frames.value}`);

    const played = evaluate(
      session,
      `(() => {
        const g = window.__nethack3d; if (!g) return JSON.stringify({ error: 'no-game' });
        for (const key of ['ArrowRight','ArrowDown','ArrowDown','ArrowUp','g','.']) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key }));
        }
        const s = g.session;
        return JSON.stringify({ turn: s.turn, depth: s.depth, hp: s.player.hp, monsters: s.level.monsters.length });
      })()`,
    );
    const playedData = (played.value ?? {}) as Record<string, unknown>;
    record('按键驱动回合推进', Number(playedData.turn ?? 0) > 0, JSON.stringify(playedData));
    record('会话保持在合法楼层', Number(playedData.depth ?? 0) >= 1);

    // 5. 错误级日志必须为空
    const errors = evaluate(
      session,
      `JSON.stringify(window.__nethack3dLog.recent(200).filter((e) => e.level === 'error').map((e) => e.message))`,
    );
    const errorList = (errors.value ?? []) as string[];
    record('没有错误级日志', errorList.length === 0, errorList.slice(0, 3).join('；'));

    // 5b. 面向新手的界面：目标提示与情境操作应当存在
    const guide = evaluate(
      session,
      `(() => {
        const objective = document.querySelector('[data-role="objective"]');
        const actions = document.querySelectorAll('[data-role="actions"] button');
        return JSON.stringify({
          objective: objective ? objective.textContent.trim() : '',
          actions: actions.length,
          labels: [...actions].map((b) => b.textContent.trim()),
        });
      })()`,
    );
    const guideData = (guide.value ?? {}) as Record<string, unknown>;
    record(
      '目标提示可见',
      typeof guideData.objective === 'string' && guideData.objective.length > 4,
      String(guideData.objective ?? ''),
    );

    // 小地图：画布存在且已经画上内容。
    const minimapProbe = evaluate(
      session,
      `(() => {
        const canvas = document.querySelector('.hud-minimap canvas');
        if (!canvas) return JSON.stringify({ ok: false, painted: 0, w: 0, h: 0 });
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
        return JSON.stringify({ ok: true, painted, w: canvas.width, h: canvas.height });
      })()`,
    );
    const mm = (minimapProbe.value ?? {}) as {
      ok?: boolean;
      painted?: number;
      w?: number;
      h?: number;
    };
    record(
      '小地图已绘制',
      mm.ok === true && (mm.painted ?? 0) > 20,
      `${mm.w}×${mm.h} 已画 ${mm.painted} 格`,
    );

    // 粒子系统：喷一团粒子并确认计数。
    const particleProbe = evaluate(
      session,
      `(() => {
        const scene = window.__nethack3d.scene;
        scene.spawnBurstAt(0, 1, 0, 0xffd479, 24);
        return JSON.stringify({ count: scene.particles.count });
      })()`,
    );
    const pfx = (particleProbe.value ?? {}) as { count?: number };
    // 等一秒：手动喷发的粒子会消散，能留下来的是火把飞灰。
    await Bun.sleep(900);
    const emberProbe = evaluate(
      session,
      `JSON.stringify({ count: window.__nethack3d.scene.particles.count })`,
    );
    const ember = (emberProbe.value ?? {}) as { count?: number };
    record(
      '粒子系统可绘制',
      (pfx.count ?? 0) > 0 && (ember.count ?? 0) < (pfx.count ?? 0),
      `喷发=${pfx.count} 一秒后=${ember.count}`,
    );

    record(
      '情境操作可用',
      Number(guideData.actions ?? 0) >= 3,
      `按钮=${guideData.actions}：${(guideData.labels as string[] | undefined)?.join('、') ?? ''}`,
    );

    // 5b2. 状态栏要显示本局种子与层数，便于复现
    const identity = evaluate(
      session,
      `(() => {
        const seed = document.querySelector('[data-stat="hud.seed"]');
        const depth = document.querySelector('[data-stat="hud.depth"]');
        const s = window.__nethack3d.session;
        return JSON.stringify({
          seed: seed ? seed.textContent.trim() : '',
          depth: depth ? depth.textContent.trim() : '',
          expectedSeed: String(s.seed),
          expectedDepth: String(s.depth),
        });
      })()`,
    );
    const idData = (identity.value ?? {}) as Record<string, unknown>;
    record(
      '种子与层数可见',
      String(idData.seed ?? '').includes(String(idData.expectedSeed)) &&
        String(idData.depth ?? '').includes(String(idData.expectedDepth)),
      `种子 ${idData.seed}（应为 ${idData.expectedSeed}）· 层数 ${idData.depth}（应为 ${idData.expectedDepth}）`,
    );

    // 5b4. 状态效果标签：设置失明与石化后 HUD 出现对应词条。
    const effects = evaluate(
      session,
      `(() => {
        const g = window.__nethack3d;
        g.session.player.blind = 5;
        g.session.player.petrifying = 3;
        g.hud.render(g.session);
        const chips = [...document.querySelectorAll('.hud-chip')].map((c) => c.textContent.trim());
        const danger = document.querySelectorAll('.hud-chip.danger').length;
        g.session.player.blind = 0;
        g.session.player.petrifying = 0;
        g.hud.render(g.session);
        return JSON.stringify({ chips, danger });
      })()`,
    );
    const effectData = (effects.value ?? {}) as { chips?: string[]; danger?: number };
    record(
      '状态效果标签可用',
      (effectData.chips?.length ?? 0) >= 2 && (effectData.danger ?? 0) >= 1,
      `标签=${(effectData.chips ?? []).join('/')} 危险=${effectData.danger ?? 0}`,
    );

    // 5b3. 转储按钮：弹出可复制的状态文本，含种子、地图与存档载荷
    const dump = evaluate(
      session,
      `(() => {
        const btn = document.querySelector('[data-i18n="hud.dump"]');
        if (!btn) return JSON.stringify({ error: 'missing button' });
        btn.click();
        const area = document.querySelector('.dump-text');
        const seed = String(window.__nethack3d.session.seed);
        const out = {
          opened: !!area,
          hasSeed: !!area && area.value.includes('seed: ' + seed),
          hasMap: !!area && area.value.includes('map:') && area.value.includes('@'),
          hasSave: !!area && area.value.includes('--- save json ---'),
          length: area ? area.value.length : 0,
        };
        const close = document.querySelector('.dump-mask [data-i18n="dump.close"]');
        if (close) close.click();
        out.closed = !document.querySelector('.dump-mask');
        return JSON.stringify(out);
      })()`,
    );
    const dumpData = (dump.value ?? {}) as Record<string, unknown>;
    record(
      '转储按钮可导出状态',
      Boolean(dumpData.opened) &&
        Boolean(dumpData.hasSeed) &&
        Boolean(dumpData.hasMap) &&
        Boolean(dumpData.hasSave) &&
        Number(dumpData.length ?? 0) > 500 &&
        Boolean(dumpData.closed),
      `长度=${dumpData.length} 种子=${dumpData.hasSeed} 地图=${dumpData.hasMap} ` +
        `存档=${dumpData.hasSave} 可关闭=${dumpData.closed}`,
    );

    // 5c. 画布必须能接收点击（覆盖层不得挡住它），并用真实鼠标事件验证交互
    const probe = evaluate(
      session,
      `(() => {
        const canvas = document.querySelector('canvas');
        const rect = canvas.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height * 0.45);
        const el = document.elementFromPoint(x, y);
        return JSON.stringify({ x, y, top: el ? el.className || el.tagName : '' });
      })()`,
    );
    const probeData = (probe.value ?? {}) as { x?: number; y?: number; top?: string };
    const px = Number(probeData.x ?? 0);
    const py = Number(probeData.y ?? 0);
    // 命中测试：画布之上不应压着全屏覆盖层，否则点击与拖拽都会被吃掉。
    record(
      '画布可接收点击',
      String(probeData.top ?? '').toLowerCase() === 'canvas',
      `顶层元素=${probeData.top} @ ${px},${py}`,
    );

    const readTurn = (): number => {
      const value = evaluate(session, `JSON.stringify({ turn: window.__nethack3d.session.turn })`);
      const data = (value.value ?? {}) as { turn?: number };
      return Number(data.turn ?? -1);
    };

    // 点击必须落在可走的地面上，锚在墙上不会推进回合。
    // 用真实的 pointermove 处理器扫描中心周围，取第一个带提示的格子；
    // 提示（.tile-tip-hint）只在可点击目标上出现。
    const walkablePoint = evaluate(
      session,
      `(() => {
        const canvas = document.querySelector('canvas');
        const rect = canvas.getBoundingClientRect();
        const tip = document.querySelector('.tile-tip');
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height * 0.62;
        for (let r = 0; r <= 0.35; r += 0.05) {
          for (let a = 0; a < 16; a++) {
            const angle = (a / 16) * Math.PI * 2;
            const x = Math.round(cx + Math.cos(angle) * rect.width * r);
            const y = Math.round(cy + Math.sin(angle) * rect.height * r);
            // 跳过被操作按钮等元素覆盖的位置，保证真实鼠标事件能落到画布。
            const top = document.elementFromPoint(x, y);
            if (!top || top.tagName !== 'CANVAS') continue;
            window.dispatchEvent(
              new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }),
            );
            if (tip && !tip.hidden && tip.querySelector('.tile-tip-hint')) {
              return JSON.stringify({ x, y, text: tip.textContent.trim() });
            }
          }
        }
        return JSON.stringify(null);
      })()`,
    );
    const walkPoint = (walkablePoint.value ?? {}) as { x?: number; y?: number; text?: string };
    const wx = Number.isFinite(walkPoint.x) ? Number(walkPoint.x) : px;
    const wy = Number.isFinite(walkPoint.y) ? Number(walkPoint.y) : py;

    // 悬停：真实鼠标移动后应出现提示气泡。
    run(['agent-browser', '--session', session, 'mouse', 'move', String(wx), String(wy)]);
    await Bun.sleep(250);
    const tip = evaluate(
      session,
      `(() => {
        const tip = document.querySelector('.tile-tip');
        return JSON.stringify({ hidden: tip ? tip.hidden : null, text: tip ? tip.textContent.trim() : '' });
      })()`,
    );
    const tipData = (tip.value ?? {}) as Record<string, unknown>;
    record(
      '光标提示可用',
      tipData.hidden === false && String(tipData.text ?? '').length > 0,
      String(tipData.text ?? ''),
    );

    // 点击：真实按下与松开，经过命中测试。
    const turnBeforeClick = readTurn();
    run(['agent-browser', '--session', session, 'mouse', 'down']);
    run(['agent-browser', '--session', session, 'mouse', 'up']);
    await Bun.sleep(500);
    record(
      '点击地面可移动',
      readTurn() > turnBeforeClick,
      `回合 ${turnBeforeClick} → ${readTurn()}`,
    );

    // 拖拽：按下后移动鼠标应当旋转相机（同一覆盖层问题也会影响它）。
    const cameraBefore = evaluate(
      session,
      `JSON.stringify(window.__nethack3d.scene.renderer.camera.position.toArray().map((n) => Math.round(n * 100) / 100))`,
    );
    run(['agent-browser', '--session', session, 'mouse', 'move', String(px), String(py)]);
    run(['agent-browser', '--session', session, 'mouse', 'down']);
    run(['agent-browser', '--session', session, 'mouse', 'move', String(px + 120), String(py)]);
    run(['agent-browser', '--session', session, 'mouse', 'move', String(px + 220), String(py)]);
    run(['agent-browser', '--session', session, 'mouse', 'up']);
    await Bun.sleep(300);
    const cameraAfter = evaluate(
      session,
      `JSON.stringify(window.__nethack3d.scene.renderer.camera.position.toArray().map((n) => Math.round(n * 100) / 100))`,
    );
    record(
      '拖拽可旋转视角',
      JSON.stringify(cameraBefore.value) !== JSON.stringify(cameraAfter.value),
      `${JSON.stringify(cameraBefore.value)} → ${JSON.stringify(cameraAfter.value)}`,
    );

    // 5e. 背包动作菜单：点击条目应列出可用动作
    const menuBox = evaluate(
      session,
      `(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));
        const row = document.querySelector('.inv-row');
        if (!row) {
          document.querySelector('.inventory-mask .btn')?.click();
          return JSON.stringify({ rows: 0 });
        }
        const rect = row.getBoundingClientRect();
        return JSON.stringify({
          rows: document.querySelectorAll('.inv-row').length,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        });
      })()`,
    );
    const box = (menuBox.value ?? {}) as { rows?: number; x?: number; y?: number };
    if (Number(box.rows ?? 0) > 0) {
      run(['agent-browser', '--session', session, 'mouse', 'move', String(box.x), String(box.y)]);
      run(['agent-browser', '--session', session, 'mouse', 'down']);
      run(['agent-browser', '--session', session, 'mouse', 'up']);
      await Bun.sleep(200);
    }
    const menu = evaluate(
      session,
      `(() => {
        const buttons = [...document.querySelectorAll('.inv-actions button')];
        const labels = buttons.map((b) => b.textContent.trim());
        document.querySelector('.inventory-mask .btn')?.click();
        return JSON.stringify({ rows: document.querySelectorAll('.inv-row').length, actions: buttons.length, labels });
      })()`,
    );
    const menuData = (menu.value ?? {}) as Record<string, unknown>;
    // 打不开背包时把原始返回带进报告，便于判断是选择器、键盘还是界面状态的问题。
    const boxDebug = menuBox.ok ? '' : ` eval 失败：${menuBox.raw.slice(0, 140)}`;
    record(
      '背包动作菜单可用',
      Number(box.rows ?? 0) >= 1 && Number(menuData.actions ?? 0) >= 2,
      `条目=${box.rows} 动作=${(menuData.labels as string[] | undefined)?.join('、') ?? ''}` +
        ` 面板=${!!menuData.rows}${boxDebug}`,
    );

    // 5f. 门板位置：闭合的门应当正好落在自己格子的中央
    const doorCheck = evaluate(
      session,
      `(() => {
        const g = window.__nethack3d;
        const level = g.session.level;
        const W = level.width;
        const doors = g.scene.dungeon.features.filter((f) => f.userData.kind === 'door');
        let checked = 0;
        const offCenter = [];
        for (const door of doors) {
          const anim = door.userData.animate;
          // 只查闭合的门：开着的门本来就转到了格子外。
          if (!anim || !anim.closed) continue;
          const panel = anim.pivot && anim.pivot.children[0];
          if (!panel) continue;
          const tile = door.userData.tile;
          const tx = tile % W;
          const ty = Math.floor(tile / W);
          const v = panel.position.clone();
          panel.getWorldPosition(v);
          const cx = tx - (W - 1) / 2;
          const cz = ty - (level.height - 1) / 2;
          const dist = Math.hypot(v.x - cx, v.z - cz);
          checked++;
          if (dist > 0.2) offCenter.push([tx, ty, Number(dist.toFixed(2))]);
        }
        return JSON.stringify({ checked, offCenter });
      })()`,
    );
    const doorData = (doorCheck.value ?? {}) as { checked?: number; offCenter?: number[][] };
    record(
      '门板位于格子中央',
      Number(doorData.checked ?? 0) > 0 && (doorData.offCenter?.length ?? 0) === 0,
      `检查 ${doorData.checked} 扇闭合的门，偏离 ${doorData.offCenter?.length ?? 0} 扇`,
    );

    // 5g. 门板朝向：门的形状必须是「前后通道、两侧墙」，门板垂直于通道。
    // 期望值只从地图瓦片推导，不引用渲染层的 doorBlocksEastWest。
    const orientationCheck = evaluate(
      session,
      `(() => {
        const g = window.__nethack3d;
        const level = g.session.level;
        const W = level.width;
        const H = level.height;
        // 空格子（石头）与 1..12（各种墙）不可通行，其余都算通道。
        const tile = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : level.tiles[y * W + x];
        const open = (x, y) => {
          const t = tile(x, y);
          return t !== 0 && !(t >= 1 && t <= 12);
        };
        const wall = (x, y) => {
          const t = tile(x, y);
          return t >= 1 && t <= 12;
        };
        const doors = g.scene.dungeon.features.filter((f) => f.userData.kind === 'door');
        let checked = 0;
        const improper = [];
        const mismatches = [];
        for (const door of doors) {
          const anim = door.userData.animate;
          if (!anim || !anim.closed) continue;
          const panel = anim.pivot && anim.pivot.children[0];
          if (!panel) continue;
          const tileIndex = door.userData.tile;
          const tx = tileIndex % W;
          const ty = Math.floor(tileIndex / W);
          const properEW = open(tx - 1, ty) && open(tx + 1, ty) && wall(tx, ty - 1) && wall(tx, ty + 1);
          const properNS = open(tx, ty - 1) && open(tx, ty + 1) && wall(tx - 1, ty) && wall(tx + 1, ty);
          if (!properEW && !properNS) {
            improper.push([tx, ty]);
            continue;
          }
          // 逐顶点算世界包围盒：闭合的门 pivot 未旋转，长轴就是朝向。
          panel.updateWorldMatrix(true, false);
          const m = panel.matrixWorld.elements;
          const pos = panel.geometry.attributes.position;
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (let v = 0; v < pos.count; v++) {
            const px = pos.getX(v), py = pos.getY(v), pz = pos.getZ(v);
            const wx = m[0] * px + m[4] * py + m[8] * pz + m[12];
            const wz = m[2] * px + m[6] * py + m[10] * pz + m[14];
            if (wx < minX) minX = wx;
            if (wx > maxX) maxX = wx;
            if (wz < minZ) minZ = wz;
            if (wz > maxZ) maxZ = wz;
          }
          const blocksEastWest = maxZ - minZ > maxX - minX;
          checked++;
          if (blocksEastWest !== properEW) mismatches.push([tx, ty]);
        }
        return JSON.stringify({ checked, improper, mismatches });
      })()`,
    );
    const orientationData = (orientationCheck.value ?? {}) as {
      checked?: number;
      improper?: number[][];
      mismatches?: number[][];
    };
    record(
      '门板朝向与地图通道一致',
      Number(orientationData.checked ?? 0) > 0 &&
        (orientationData.improper?.length ?? 0) === 0 &&
        (orientationData.mismatches?.length ?? 0) === 0,
      `核对 ${orientationData.checked} 扇，形状不合规 ${orientationData.improper?.length ?? 0} 扇，` +
        `判反 ${orientationData.mismatches?.length ?? 0} 扇`,
    );

    // 6. 渲染开销快照：既是性能基线，也验证调试句柄在构建产物中可用。
    const perf = evaluate(session, `JSON.stringify(window.__nethack3d?.perf?.() ?? null)`);
    perfData = (perf.value ?? null) as Record<string, number> | null;
    record(
      '渲染开销可读取',
      perfData !== null,
      perfData
        ? `绘制 ${perfData.calls} 次，三角面 ${perfData.triangles}，程序 ${perfData.programs} 个`
        : '缺少 perf 句柄',
    );
    // 素材缺失时渲染层会静默回退到程序化几何体，这里让回退可见。
    record(
      '模型素材已加载',
      Number(perfData?.models ?? 0) > 0,
      `模型 ${perfData?.models ?? 0} 个，贴图 ${perfData?.textures ?? 0} 张`,
    );

    // 实时阴影：渲染器启用阴影贴图，月光投射，地面接收。
    const shadowProbe = evaluate(
      session,
      `(() => {
        const scene = window.__nethack3d.scene;
        const renderer = scene.renderer.renderer;
        let casters = 0;
        let receivers = 0;
        scene.root.traverse((o) => {
          if (!o.isMesh) return;
          if (o.castShadow) casters++;
          if (o.receiveShadow) receivers++;
        });
        return JSON.stringify({
          mapEnabled: renderer.shadowMap.enabled === true,
          moonCast: scene.moon.castShadow === true,
          casters,
          receivers,
        });
      })()`,
    );
    const shadows = (shadowProbe.value ?? {}) as {
      mapEnabled?: boolean;
      moonCast?: boolean;
      casters?: number;
      receivers?: number;
    };
    record(
      '实时阴影已启用',
      shadows.mapEnabled === true &&
        shadows.moonCast === true &&
        (shadows.casters ?? 0) >= 5 &&
        (shadows.receivers ?? 0) >= 5,
      `贴图=${shadows.mapEnabled} 月光=${shadows.moonCast} 投射=${shadows.casters} 接收=${shadows.receivers}`,
    );

    // 7. 截图
    const shot = run(['agent-browser', '--session', session, 'screenshot', screenshotPath]);
    const shotFile = Bun.file(screenshotPath);
    const bytes = (await shotFile.exists()) ? shotFile.size : 0;
    record('截图已生成且非空白', shot.code === 0 && bytes > 20_000, `字节=${bytes}`);

    // 8. 触屏方向键：?touch=1 强制显示；九个按键都要在，点击能推进回合。
    run(['agent-browser', '--session', session, 'open', `${baseUrl}?debug=1&touch=1`]);
    evaluate(
      session,
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => /新游戏|New Game/i.test(x.textContent)); b?.click(); return !!b; })()`,
    );
    evaluate(
      session,
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => /开始下潜|Begin/i.test(x.textContent)); b?.click(); return !!b; })()`,
    );
    const touchKeys = evaluate(session, `document.querySelectorAll('.touch-key').length`);
    run(['agent-browser', '--session', session, 'click', '.touch-key:nth-child(6)']);
    const touchTurn = evaluate(
      session,
      `String(window.__nethack3d ? window.__nethack3d.session.turn : -1)`,
    );
    record(
      '触屏方向键可用',
      Number(touchKeys.value ?? 0) === 9 && Number(touchTurn.value ?? -1) === 1,
      `按键=${touchKeys.value} 回合=${touchTurn.value}`,
    );
  } finally {
    if (!options.keepBrowser) run(['agent-browser', '--session', session, 'close']);
    if (stopServer && !options.keepServer) stopServer();
  }

  const report = {
    ok: failures.length === 0,
    mode: options.preview ? 'preview' : 'dev',
    durationMs: Math.round(performance.now() - startedAt),
    metrics: { render: perfData },
    steps,
    failures,
    artifacts: { screenshot: screenshotPath },
    hints: failures.length
      ? ['打开截图确认画面，查看页面控制台的错误日志，修复后重跑 bun tools/agent-e2e.ts']
      : [
          '浏览器路径正常，可运行 bun run verify:full 完成整体校验',
          ...(options.keepServer
            ? [`开发服务器仍在 http://localhost:${options.port}/ ，跑 --preview 前先停止它`]
            : []),
          ...(options.keepBrowser
            ? ['浏览器会话已保留，收尾时执行 agent-browser --session nh3d-e2e close']
            : []),
        ],
  };
  await Bun.write(
    path.join(artifactsDir, 'e2e-report.json'),
    `${JSON.stringify(report, null, 2)}
`,
  );
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

await main();
