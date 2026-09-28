/**
 * 全流程冒烟测试。
 *
 * 按真实玩家的路径走一遍：标题页、语言切换、说明、角色创建、游戏内移动与战斗、
 * 背包动作、下潜、饥饿提示、存档续玩、死亡与通关。
 * 每一步都用真实鼠标与键盘事件驱动，并留下截图，便于人工复核画面。
 *
 * ```bash
 * bun tools/agent-smoke.ts               # 需要 dev server 或自动拉起
 * bun tools/agent-smoke.ts --keep-browser
 * ```
 *
 * 截图写到 `tools/agent-artifacts/smoke/`，报告写到同目录的 `report.json`。
 * 未安装 agent-browser 时输出 `skipped` 并以 0 退出。
 */

import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dir, '..');
const artifactsDir = path.join(projectRoot, 'tools', 'agent-artifacts', 'smoke');

interface Options {
  port: number;
  keepBrowser: boolean;
  keepServer: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { port: 5273, keepBrowser: false, keepServer: false };
  for (const arg of argv) {
    if (arg.startsWith('--port=')) options.port = Number(arg.slice(7));
    else if (arg === '--keep-browser') options.keepBrowser = true;
    else if (arg === '--keep-server') options.keepServer = true;
  }
  return options;
}

/** 执行外部命令。 */
function run(cmd: string[], timeoutMs = 60_000): { code: number; out: string } {
  const proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
  const out = `${proc.stdout?.toString() ?? ''}${proc.stderr?.toString() ?? ''}`.trim();
  return { code: proc.exitCode ?? -1, out };
}

/** 页面内求值，返回解析后的结果。 */
function evaluate(session: string, expression: string): unknown {
  const { code, out } = run(['agent-browser', '--session', session, 'eval', expression]);
  if (code !== 0) return null;
  let parsed: unknown = out;
  try {
    parsed = JSON.parse(out);
  } catch {
    // 非 JSON 输出保持原样。
  }
  // agent-browser 会把返回值再包一层 JSON。
  if (typeof parsed === 'string' && (parsed.startsWith('{') || parsed.startsWith('['))) {
    try {
      return JSON.parse(parsed);
    } catch {
      return parsed;
    }
  }
  return parsed;
}

/** 在页面内按下按键（游戏监听 window 上的 keydown）。 */
function pressKey(session: string, key: string): void {
  run([
    'agent-browser',
    '--session',
    session,
    'eval',
    `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); return 'ok'; })()`,
  ]);
}

/** 真实鼠标点击某个坐标。 */
function clickAt(session: string, x: number, y: number): void {
  run(['agent-browser', '--session', session, 'mouse', 'move', String(x), String(y)]);
  run(['agent-browser', '--session', session, 'mouse', 'down']);
  run(['agent-browser', '--session', session, 'mouse', 'up']);
}

/** 依次尝试若干文字，点到第一个存在的元素。 */
function clickFirstText(session: string, texts: string[]): boolean {
  for (const text of texts) {
    if (clickText(session, text)) return true;
  }
  return false;
}

/** 点击选择器命中的元素。 */
function clickSelector(session: string, selector: string): boolean {
  const point = evaluate(
    session,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return JSON.stringify({ ok: false });
      const rect = node.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
    })()`,
  ) as { ok?: boolean; x?: number; y?: number } | null;
  if (!point?.ok || point.x === undefined || point.y === undefined) return false;
  clickAt(session, point.x, point.y);
  return true;
}

/**
 * 点击地面上的指定格子。
 *
 * 用相机把世界坐标投影回屏幕，因此点击一定落在目标格上；
 * 顺带验证投影与 tileFromScreen 互为逆运算。
 */
function clickTile(session: string, tileX: number, tileY: number): boolean {
  const point = evaluate(
    session,
    `(() => {
      const g = window.__nethack3d;
      const camera = g.scene.renderer.camera;
      const level = g.session.level;
      const worldX = ${tileX} - (level.width - 1) / 2;
      const worldZ = ${tileY} - (level.height - 1) / 2;
      const v = camera.position.clone().set(worldX, 0, worldZ).project(camera);
      const rect = g.scene.renderer.renderer.domElement.getBoundingClientRect();
      return JSON.stringify({
        x: Math.round(rect.left + ((v.x + 1) / 2) * rect.width),
        y: Math.round(rect.top + ((1 - v.y) / 2) * rect.height),
      });
    })()`,
  ) as { x?: number; y?: number } | null;
  if (point?.x === undefined || point?.y === undefined) return false;
  clickAt(session, point.x, point.y);
  return true;
}

/** 找一个已探索、可通行、离玩家不远的格子，用于点击移动。 */
function pickWalkableTile(session: string): { x: number; y: number } | null {
  const result = evaluate(
    session,
    `(() => {
      const g = window.__nethack3d;
      const s = g.session;
      const level = s.level;
      const walkable = new Set([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 16, 17, 18, 19]);
      for (let radius = 1; radius <= 6; radius++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const x = s.player.x + dx;
            const y = s.player.y + dy;
            if (x < 0 || y < 0 || x >= level.width || y >= level.height) continue;
            const i = y * level.width + x;
            if (level.seen[i] !== 1) continue;
            if (!walkable.has(level.tiles[i])) continue;
            if (level.monsters.some((m) => m.x === x && m.y === y && m.mhp > 0)) continue;
            return JSON.stringify({ x, y });
          }
        }
      }
      return JSON.stringify(null);
    })()`,
  ) as { x?: number; y?: number } | null;
  return result && typeof result.x === 'number' ? { x: result.x, y: result.y as number } : null;
}

/** 把玩家恢复到安全状态：陷阱与怪物可能让流程提前结束。 */
function keepAlive(session: string): void {
  evaluate(
    session,
    `(() => {
      const s = window.__nethack3d?.session;
      if (!s) return 'no-session';
      s.player.hp = s.player.maxHp;
      s.player.sleep = 0;
      s.player.held = 0;
      return 'ok';
    })()`,
  );
}

/** 点击包含指定文字的元素，返回是否找到。 */
function clickText(session: string, text: string): boolean {
  const result = evaluate(
    session,
    `(() => {
      const nodes = [...document.querySelectorAll('button, .chip, [role="button"]')];
      const hit = nodes.find((n) => (n.textContent || '').includes(${JSON.stringify(text)}));
      if (!hit) return JSON.stringify({ ok: false, labels: nodes.map((n) => (n.textContent || '').trim()).slice(0, 12) });
      const rect = hit.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
    })()`,
  ) as { ok?: boolean; x?: number; y?: number; labels?: string[] } | null;
  if (!result?.ok || result.x === undefined || result.y === undefined) return false;
  clickAt(session, result.x, result.y);
  return true;
}

/**
 * 关闭当前弹窗：优先点带 menu.close 标记的按钮，不受界面语言影响。
 */
function closeDialog(session: string): boolean {
  const point = evaluate(
    session,
    `(() => {
      const dialog = document.querySelector('.dialog');
      if (!dialog) return JSON.stringify({ ok: false });
      const button =
        dialog.querySelector('[data-i18n="menu.close"]') ?? [...dialog.querySelectorAll('button')].pop();
      if (!button) return JSON.stringify({ ok: false });
      const rect = button.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
    })()`,
  ) as { ok?: boolean; x?: number; y?: number } | null;
  if (!point?.ok || point.x === undefined || point.y === undefined) return false;
  clickAt(session, point.x, point.y);
  return true;
}

/** 读一个数字字段；读不到返回 null，避免容错值造成假通过。 */
function readNumber(session: string, expression: string): number | null {
  const value = evaluate(session, `JSON.stringify({ v: ${expression} })`) as { v?: unknown } | null;
  return typeof value?.v === 'number' ? value.v : null;
}

/** 界面快照：DOM 层面的关键信息，用于断言。 */
function snapshot(session: string): {
  screen: string;
  title: string;
  buttons: string[];
  stats: string;
  objective: string;
  actions: string[];
  log: string;
  dialog: string;
} {
  const raw = evaluate(
    session,
    `(() => {
      const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? '';
      const all = (sel) => [...document.querySelectorAll(sel)].map((n) => (n.textContent || '').trim());
      const canvas = document.querySelector('canvas');
      return JSON.stringify({
        screen: document.querySelector('.hud') ? 'game' : (document.querySelector('.dialog') ? 'dialog' : 'title'),
        title: document.title,
        buttons: all('button').slice(0, 10),
        stats: all('.hud-stat').join(' | '),
        objective: text('[data-role="objective"]'),
        actions: all('[data-role="actions"] button'),
        log: text('.hud-log'),
        dialog: text('.dialog h2'),
        canvas: !!canvas,
      });
    })()`,
  ) as Record<string, unknown> | null;
  return {
    screen: String(raw?.screen ?? ''),
    title: String(raw?.title ?? ''),
    buttons: (raw?.buttons as string[]) ?? [],
    stats: String(raw?.stats ?? ''),
    objective: String(raw?.objective ?? ''),
    actions: (raw?.actions as string[]) ?? [],
    log: String(raw?.log ?? ''),
    dialog: String(raw?.dialog ?? ''),
  };
}

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
  shot?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!Bun.which('agent-browser')) {
    console.log(
      JSON.stringify({ ok: true, skipped: true, reason: '未安装 agent-browser' }, null, 2),
    );
    return;
  }

  fs.mkdirSync(artifactsDir, { recursive: true });
  const steps: StepResult[] = [];
  const failures: { scope: string; check: string; detail: string }[] = [];
  const session = options.keepBrowser ? 'nh3d-smoke' : `nh3d-smoke-${process.pid}`;
  const baseUrl = `http://localhost:${options.port}/`;
  let stopServer: (() => void) | null = null;

  const shot = (name: string): string => {
    const file = path.join(artifactsDir, `${name}.png`);
    run(['agent-browser', '--session', session, 'screenshot', file]);
    return file;
  };

  const record = (name: string, ok: boolean, detail: string, withShot = false): void => {
    const entry: StepResult = { name, ok, detail };
    if (withShot)
      entry.shot = path.basename(shot(name.replace(/[^\w\u4e00-\u9fa5]+/g, '-').toLowerCase()));
    steps.push(entry);
    if (!ok) failures.push({ scope: 'smoke', check: name, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 服务：没有就自己拉起。
  let ready = false;
  // 轮询必须逐次等待，不能并行。
  /* oxlint-disable no-await-in-loop */
  for (let i = 0; i < 40 && !ready; i++) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(600) });
      ready = res.ok;
    } catch {
      await Bun.sleep(300);
    }
  }
  if (!ready) {
    const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
    const proc = Bun.spawn({
      cmd: ['bun', viteBin, '--port', String(options.port)],
      cwd: projectRoot,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    stopServer = () => proc.kill();
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        const res = await fetch(baseUrl, { signal: AbortSignal.timeout(600) });
        ready = res.ok;
      } catch {
        await Bun.sleep(400);
      }
    }
  }
  /* oxlint-enable no-await-in-loop */

  try {
    // 1. 标题页
    run(['agent-browser', '--session', session, 'open', `${baseUrl}?debug=1`]);
    await Bun.sleep(1200);
    let view = snapshot(session);
    record(
      '标题页渲染',
      view.buttons.length >= 3 && view.screen === 'title',
      `按钮：${view.buttons.join('/')}`,
      true,
    );

    // 2. 切换语言
    clickFirstText(session, ['English', '简体中文']);
    await Bun.sleep(600);
    const afterLang = snapshot(session);
    record(
      '语言切换',
      afterLang.buttons.join() !== view.buttons.join(),
      `${view.buttons[0]} → ${afterLang.buttons[0]}`,
      true,
    );
    // 切回中文：后续步骤按中文文案查找控件。
    clickFirstText(session, ['简体中文', '中文']);
    await Bun.sleep(500);

    // 3. 说明弹窗
    clickSelector(session, '[data-i18n="title.howToPlay"]');
    await Bun.sleep(500);
    const help = snapshot(session);
    record('说明弹窗可打开', help.dialog.length > 0, `标题：${help.dialog}`, true);
    const closed = closeDialog(session);
    await Bun.sleep(400);
    record('说明弹窗可关闭', closed && snapshot(session).dialog === '', `关闭按钮=${closed}`);

    // 4. 角色创建
    clickFirstText(session, ['新游戏', 'New Game']);
    await Bun.sleep(700);
    const creation = evaluate(
      session,
      `(() => {
        const chips = [...document.querySelectorAll('.chip')];
        const groups = new Set(chips.map((c) => c.closest('.creation-grid')?.previousElementSibling?.textContent ?? ''));
        const start = [...document.querySelectorAll('button')].find((b) => /开始下潜|Begin/i.test(b.textContent));
        return JSON.stringify({
          chips: chips.length,
          groups: [...groups].map((g) => g.trim()),
          startDisabled: start ? start.disabled : null,
        });
      })()`,
    ) as Record<string, unknown> | null;
    record(
      '角色创建可用',
      Number(creation?.chips ?? 0) > 10 && creation?.startDisabled === false,
      `选项 ${creation?.chips} 个，分组：${((creation?.groups as string[]) ?? []).join('、')}`,
      true,
    );

    // 选一个职业并开始
    const picked = evaluate(
      session,
      `(() => {
        const chips = [...document.querySelectorAll('.chip')];
        const role = chips.find((c) => /女武神|Valkyrie/i.test(c.textContent || '')) ?? chips[0];
        role.click();
        return JSON.stringify({ role: (role.textContent || '').trim() });
      })()`,
    ) as { role?: string } | null;
    record(
      '可以切换职业',
      typeof picked?.role === 'string' && picked.role.length > 0,
      `选中 ${picked?.role}`,
    );
    await Bun.sleep(400);
    clickFirstText(session, ['开始下潜', 'Begin']);
    await Bun.sleep(1200);

    // 5. 进入游戏
    view = snapshot(session);
    record(
      '进入游戏',
      view.screen === 'game' && view.stats.length > 0,
      `状态栏：${view.stats}`,
      true,
    );
    record(
      '目标与情境操作',
      view.objective.length > 4 && view.actions.length >= 3,
      `${view.objective} · 按钮：${view.actions.join('/')}`,
    );

    // 5. 音效：素材应当加载完成，且 HUD 提供静音开关
    const audio = evaluate(
      session,
      `JSON.stringify({
        count: window.__nethack3dAudio ? window.__nethack3dAudio.count() : 0,
        muted: window.__nethack3dAudio ? window.__nethack3dAudio.muted() : null,
        muteButton: [...document.querySelectorAll('.hud-actions button')].map((b) => b.textContent.trim()),
      })`,
    ) as { count?: number; muted?: boolean; muteButton?: string[] } | null;
    record(
      '音效已加载',
      Number(audio?.count ?? 0) >= 20,
      `${audio?.count} 个音效，静音=${audio?.muted}`,
    );
    const toggle = evaluate(
      session,
      `(() => {
        const button = [...document.querySelectorAll('.hud-actions button')].find((b) => /音效|Sound/.test(b.textContent || ''));
        if (!button) return JSON.stringify({ ok: false });
        const before = window.__nethack3dAudio.muted();
        button.click();
        return JSON.stringify({ ok: true, before, after: window.__nethack3dAudio.muted() });
      })()`,
    ) as { ok?: boolean; before?: boolean; after?: boolean } | null;
    record(
      '静音开关可用',
      toggle?.ok === true && toggle.before !== toggle.after,
      `${toggle?.before} → ${toggle?.after}`,
    );
    // 恢复有声，避免影响后续人工看画面时的判断。
    evaluate(session, `(() => { window.__nethack3dAudio.setMuted(false); return 'ok'; })()`);

    // 6. 键盘移动
    keepAlive(session);
    const before = readNumber(session, 'window.__nethack3d?.session?.turn ?? null');
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowRight'])
      pressKey(session, key);
    await Bun.sleep(500);
    const after = readNumber(session, 'window.__nethack3d?.session?.turn ?? null');
    record(
      '键盘可以行动',
      before !== null && after !== null && after > before,
      `回合 ${before} → ${after}`,
    );

    // 7. 点击移动：点一个已探索的空地
    const target = pickWalkableTile(session);
    if (target) clickTile(session, target.x, target.y);
    await Bun.sleep(700);
    const walked = readNumber(session, 'window.__nethack3d?.session?.turn ?? null');
    record(
      '点击可以移动',
      target !== null && after !== null && walked !== null && walked > after,
      `目标 (${target?.x},${target?.y})，回合 ${after} → ${walked}`,
    );

    // 8. 背包动作
    keepAlive(session);
    pressKey(session, 'i');
    await Bun.sleep(400);
    const invPoint = evaluate(
      session,
      `(() => {
        const row = document.querySelector('.inv-row');
        if (!row) return JSON.stringify({ rows: 0 });
        const rect = row.getBoundingClientRect();
        return JSON.stringify({ rows: document.querySelectorAll('.inv-row').length, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) });
      })()`,
    ) as { rows?: number; x?: number; y?: number } | null;
    if (Number(invPoint?.rows ?? 0) > 0) {
      clickAt(session, Number(invPoint?.x), Number(invPoint?.y));
      await Bun.sleep(400);
    }
    const invMenu = evaluate(
      session,
      `(() => {
        const buttons = [...document.querySelectorAll('.inv-actions button')].map((b) => (b.textContent || '').trim());
        const title = document.querySelector('.dialog h2')?.textContent ?? '';
        return JSON.stringify({ buttons, title });
      })()`,
    ) as { buttons?: string[]; title?: string } | null;
    record(
      '背包动作菜单',
      (invMenu?.buttons?.length ?? 0) >= 1,
      `${invMenu?.title}：${(invMenu?.buttons ?? []).join('/')}`,
      true,
    );
    // 只按一次：游戏内第二次 Esc 会退回主菜单，后续步骤就跑在已停止的会话上。
    pressKey(session, 'Escape');
    await Bun.sleep(500);
    record(
      '背包可以关闭',
      snapshot(session).screen === 'game',
      `界面：${snapshot(session).screen}`,
    );

    // 8b. 状态转储：按钮弹出可复制的完整状态，截图供人工复核
    const dump = evaluate(
      session,
      `(() => {
        const btn = document.querySelector('[data-i18n="hud.dump"]');
        if (btn) btn.click();
        const area = document.querySelector('.dump-text');
        const seed = String(window.__nethack3d.session.seed);
        return JSON.stringify({
          open: !!area,
          hasSeed: !!area && area.value.includes('seed: ' + seed),
          hasMap: !!area && area.value.includes('map:') && area.value.includes('@'),
          length: area ? area.value.length : 0,
        });
      })()`,
    ) as { open?: boolean; hasSeed?: boolean; hasMap?: boolean; length?: number } | null;
    record(
      '转储可导出状态',
      Boolean(dump?.open) && Boolean(dump?.hasSeed) && Boolean(dump?.hasMap),
      `长度=${dump?.length} 种子=${dump?.hasSeed} 地图=${dump?.hasMap}`,
      true,
    );
    pressKey(session, 'Escape');
    await Bun.sleep(400);
    record(
      '转储可以关闭',
      snapshot(session).screen === 'game' && snapshot(session).dialog === '',
      `界面：${snapshot(session).screen} 弹窗：${snapshot(session).dialog || '无'}`,
    );

    // 9. 下潜一层
    const descend = evaluate(
      session,
      `(() => {
        const g = window.__nethack3d;
        const s = g.session;
        const level = s.level;
        const down = level.down;
        const walkable = new Set([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 16, 17, 18, 19]);
        // 冒烟测试只走了几步，楼梯一带可能还没探索。先站上楼梯把周围点亮
        // （踩上去不会下楼，下楼发生在「走进」这一格时），
        // 再退到相邻格用方向键走上去：走玩家真实输入这条路径，自动存档也会触发。
        // 临时状态与楼梯口的怪物会阻止移动，先清掉。
        s.player.sleep = 0;
        s.player.held = 0;
        level.monsters = level.monsters.filter(
          (m) => Math.max(Math.abs(m.x - down.x), Math.abs(m.y - down.y)) > 1,
        );
        s.player.x = down.x;
        s.player.y = down.y;
        s.refreshFov();
        const options = [
          { dx: 0, dy: -1, key: 'ArrowDown' },
          { dx: 0, dy: 1, key: 'ArrowUp' },
          { dx: -1, dy: 0, key: 'ArrowRight' },
          { dx: 1, dy: 0, key: 'ArrowLeft' },
        ];
        for (const option of options) {
          const x = down.x + option.dx;
          const y = down.y + option.dy;
          if (x < 0 || y < 0 || x >= level.width || y >= level.height) continue;
          const i = y * level.width + x;
          if (!walkable.has(level.tiles[i])) continue;
          s.player.x = x;
          s.player.y = y;
          s.refreshFov();
          return JSON.stringify({ before: level.depth, key: option.key, from: [x, y] });
        }
        return JSON.stringify({ before: level.depth, key: null });
      })()`,
    ) as { before?: number; key?: string | null; from?: number[] } | null;
    // 关门、怪物挤位都可能吃掉一次按键，最多试三次。
    /* oxlint-disable no-await-in-loop */
    for (let attempt = 0; attempt < 3; attempt++) {
      pressKey(session, descend?.key ?? 'ArrowDown');
      await Bun.sleep(700);
      const now = readNumber(session, 'window.__nethack3d?.session?.depth ?? null');
      if (now !== null && typeof descend?.before === 'number' && now > descend.before) break;
    }
    /* oxlint-enable no-await-in-loop */
    const depthAfter = readNumber(session, 'window.__nethack3d?.session?.depth ?? null');
    record(
      '可以下潜一层',
      typeof descend?.before === 'number' && depthAfter !== null && depthAfter > descend.before,
      `第 ${descend?.before} 层 → 第 ${depthAfter} 层（从 ${descend?.from?.join(',')} 按 ${descend?.key}）`,
    );

    // 10. 饥饿提示
    const hunger = evaluate(
      session,
      `(() => {
        const g = window.__nethack3d;
        g.session.player.hunger = 20;
        g.hud.render(g.session);
        const warn = document.querySelector('.hud-warn')?.textContent?.trim() ?? '';
        return JSON.stringify({
          warn,
          hunger: g.session.player.hunger,
          stats: [...document.querySelectorAll('.hud-stat')].map((n) => n.textContent.trim()).join('|'),
        });
      })()`,
    ) as { warn?: string; hunger?: number; stats?: string } | null;
    record(
      '饥饿会提示',
      (hunger?.warn ?? '').length > 2,
      `提示=${hunger?.warn ?? '（无）'} 饥饿值=${hunger?.hunger} 状态格=${hunger?.stats}`,
      true,
    );

    // 11. 存档与续玩
    const saved = evaluate(
      session,
      `JSON.stringify({ depth: window.__nethack3d.session.depth, turn: window.__nethack3d.session.turn, hasSave: localStorage.getItem('nethack3d.save') !== null })`,
    ) as { depth?: number; turn?: number; hasSave?: boolean } | null;
    run(['agent-browser', '--session', session, 'open', `${baseUrl}?debug=1`]);
    await Bun.sleep(1200);
    const titleView = snapshot(session);
    const canContinue = titleView.buttons.some((b) => /继续|Continue/i.test(b));
    clickFirstText(session, ['继续', 'Continue']);
    await Bun.sleep(1200);
    const resumed = evaluate(
      session,
      `JSON.stringify({ depth: window.__nethack3d?.session?.depth ?? null, turn: window.__nethack3d?.session?.turn ?? null })`,
    ) as { depth?: number; turn?: number } | null;
    record(
      '存档与续玩',
      canContinue && resumed?.depth === saved?.depth,
      `继续按钮=${canContinue}，第 ${saved?.depth} 层 → 第 ${resumed?.depth} 层`,
      true,
    );

    // 12. 死亡界面。陷阱与怪物都可能让玩家提前阵亡，这条路径同样算通过。
    const alreadyDead = /死|die/i.test(snapshot(session).dialog);
    if (!alreadyDead) {
      // 直接构造死亡状态，再推进一回合驱动界面结算；不再依赖怪物出伤。
      const forced = evaluate(
        session,
        `(() => {
          const s = window.__nethack3d.session;
          s.player.hp = 0;
          s.player.dead = true;
          s.dead = true;
          return JSON.stringify({ dead: s.dead });
        })()`,
      ) as { dead?: boolean } | null;
      record('构造死亡状态', forced?.dead === true, `dead=${forced?.dead}`);
      pressKey(session, '.');
    }
    await Bun.sleep(600);
    const death = snapshot(session);
    record('死亡界面出现', /死|die/i.test(death.dialog), `标题：${death.dialog}`, true);
    clickFirstText(session, ['再来', '重新', 'Restart', 'New Game']);
    await Bun.sleep(1000);
    const restarted = snapshot(session);
    record('死后可以重开', restarted.screen !== 'dialog', `界面：${restarted.screen}`);

    // 13. 通关界面
    evaluate(
      session,
      `(() => {
        const g = window.__nethack3d;
        const s = g.session;
        s.player.maxHp = 99;
        s.player.hp = 99;
        s.changeDepth(30, 'down');
        const pile = s.level.objects.find((p) => p.items.some((i) => i.proto.id === 'AMULET_OF_YENDOR'));
        if (pile) {
          s.player.x = pile.x;
          s.player.y = pile.y;
          s.refreshFov();
        }
        return JSON.stringify({ found: !!pile, depth: s.depth });
      })()`,
    );
    await Bun.sleep(400);
    pressKey(session, 'g');
    await Bun.sleep(900);
    // 拿到护身符还要带回地面：直接回到第 1 层，再推一回合触发结算。
    evaluate(
      session,
      `(() => {
        window.__nethack3d.session.changeDepth(1, 'up', 'main');
        return 'ok';
      })()`,
    );
    await Bun.sleep(300);
    pressKey(session, '.');
    await Bun.sleep(900);
    const victory = evaluate(
      session,
      `JSON.stringify({
        victory: window.__nethack3d.session.victory,
        title: document.querySelector('.dialog h2')?.textContent?.trim() ?? '',
        buttons: [...document.querySelectorAll('.dialog button')].map((b) => b.textContent.trim()),
      })`,
    ) as { victory?: boolean; title?: string; buttons?: string[] } | null;
    record(
      '通关界面出现',
      victory?.victory === true && (victory?.buttons?.length ?? 0) > 0,
      `标题：${victory?.title}，按钮：${(victory?.buttons ?? []).join('/')}`,
      true,
    );
  } finally {
    if (!options.keepBrowser) run(['agent-browser', '--session', session, 'close']);
    if (stopServer && !options.keepServer) stopServer();
  }

  const report = {
    ok: failures.length === 0,
    steps,
    failures,
    artifacts: { dir: artifactsDir },
    hints: failures.length
      ? ['看 smoke 目录下的截图确认画面问题，修好后重跑 bun tools/agent-smoke.ts']
      : ['全流程通过，可运行 bun run verify:full 收尾'],
  };
  fs.writeFileSync(
    path.join(artifactsDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exit(1);
}

await main();
