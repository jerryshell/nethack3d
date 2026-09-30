/**
 * Main entry point: boots the renderer, switches between the title screen and
 * the game, and owns input handling for movement and the camera.
 */

import { ViewRenderer } from './render/view';
import './styles.css';
import {
  t,
  getLocale,
  setLocale,
  nextLocale,
  LOCALES,
  onLocaleChange,
  applyI18n,
} from './i18n/index';
import { createTitleBackdrop } from './render/titleBackdrop';
import { GameScene } from './render/scene';
import { loadModels, loadedModelCount } from './render/assets';
import { loadCharacters, lookForPlayer, loadedCharacterCount } from './render/characters';
import { GameSession } from './game/session';
import { findPath, pathPoints } from './game/path';
import type { Point, Step } from './game/path';
import { isWalkable, COLNO, HUNGER_WARN, T } from './core/constants';
import { index } from './game/dungeon';
import { FEATURE_ACTIONS } from './game/features';
import { isContainer } from './game/containers';
import type { ActionResultInfo, Attributes, CharacterChoice } from './types';
import type { HudAction, HudHandle } from './ui/hud';
import { describeTile } from './ui/tileInfo';
import { createHud } from './ui/hud';
import type { InventoryPanelHandle } from './ui/inventory';
import { createInventoryPanel } from './ui/inventory';
import { createWishPanel } from './ui/wish';
import type { WishPanelHandle } from './ui/wish';
import { createCreationScreen } from './ui/creation';
import { hasSave, loadGame, saveGame, clearSave } from './game/save';
import { saveBones } from './game/bones';
import {
  createLogger,
  dumpLogs,
  debugRequested,
  initLoggingFromEnvironment,
  installLogConsoleApi,
  LOG_NS,
} from './core/log';
import {
  initAudio,
  resumeAudio,
  installAudioConsoleApi,
  playFootstep,
  playSfx,
} from './core/audio';
import './data/i18n'; // 初始化数据层翻译

const log = createLogger(LOG_NS.app);

// 先初始化日志开关，再启动其它模块，保证首个日志也被记录。
initLoggingFromEnvironment();
installLogConsoleApi();
initAudio();
installAudioConsoleApi();

/** 捕获未处理异常，写入日志缓冲区，便于回溯。 */
/** 首次交互恢复音频；顺带给所有按钮加上点击音。 */
function installAudioUnlock(): void {
  const unlock = (): void => {
    resumeAudio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  // 事件委托：所有按钮共用同一个点击音，不必逐个绑定。
  document.addEventListener('click', (event) => {
    if ((event.target as HTMLElement | null)?.closest('button')) playSfx('click', { gain: 0.6 });
  });
}

function installErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    log.error('未捕获异常', {
      message: event.message,
      source: `${event.filename}:${event.lineno}:${event.colno}`,
      error: event.error instanceof Error ? event.error.stack : String(event.error),
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    log.error('未处理的 Promise 拒绝', event.reason);
  });
}

installErrorHandlers();
installAudioUnlock();

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const overlay = document.getElementById('overlay') as HTMLElement;

const renderer = new ViewRenderer(canvas);
const backdrop = createTitleBackdrop(renderer);
renderer.addUpdater((dt) => backdrop.update(dt));
renderer.start();

/** 当前界面：标题页、角色创建或游戏中。 */
type ScreenId = 'title' | 'creation' | 'game';
let screen: ScreenId = 'title';

/** 一局游戏所需的运行时对象。 */
/** 渲染开销快照，供自动化检查与现场排查使用。 */
interface RenderStats {
  /** 每帧绘制调用数。 */
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  /** 已加载的外部模型数量，0 表示回退到程序化几何体。 */
  models: number;
  pixelRatio: number;
  /** 画布尺寸（设备像素）。 */
  width: number;
  height: number;
}

interface GameContext {
  session: GameSession;
  scene: GameScene;
  hud: HudHandle;
  /** 读取当前渲染开销。 */
  perf: () => RenderStats;
  cleanup: () => void;
}

let game: GameContext | null = null;

/** 启动新游戏或从存档恢复时的参数。 */
interface StartGameOptions {
  session?: GameSession;
  seed?: number;
  depth?: number;
  character?: CharacterChoice;
  attributes?: Attributes;
}

// ---------------------------------------------------------------------------
// DOM 辅助
// ---------------------------------------------------------------------------

/** 创建元素：`class` 设置类名，`text` 设置文本，`on*` 绑定事件，其余作为属性。 */
function el(
  tag: string,
  props: Record<string, unknown> = {},
  children: (Node | string)[] = [],
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

function showHelp() {
  const close = () => mask.remove();
  const body = t('help.body');
  const dialog = el('div', { class: 'dialog' }, [
    el('h2', { text: t('help.title') }),
    ...body.split('\n\n').map((p) => el('p', { class: 'about-body', text: p })),
    el('p', { class: 'muted', text: t('help.keys') }),
    el('button', { class: 'btn', 'data-i18n': 'menu.close', onclick: close }),
  ]);
  const mask = el(
    'div',
    { class: 'mask', onclick: (e: MouseEvent) => e.target === mask && close() },
    [dialog],
  );
  overlay.append(mask);
  applyI18n(mask);
}

function showAbout() {
  const close = () => mask.remove();
  const dialog = el('div', { class: 'dialog' }, [
    el('h2', { 'data-i18n': 'about.title' }),
    el('pre', { class: 'about-body', 'data-i18n': 'about.body' }),
    el('p', { class: 'muted', 'data-i18n': 'about.source' }),
    el('button', { class: 'btn', 'data-i18n': 'menu.close', onclick: close }),
  ]);
  const mask = el(
    'div',
    { class: 'mask', onclick: (e: MouseEvent) => e.target === mask && close() },
    [dialog],
  );
  overlay.append(mask);
  applyI18n(mask);
}

function languageButton() {
  const btn = el('button', { class: 'btn ghost lang-btn' });
  const paint = () => {
    btn.textContent = t('lang.switch', { name: LOCALES[nextLocale()].label });
  };
  btn.addEventListener('click', () => setLocale(nextLocale()));
  paint();
  onLocaleChange(paint);
  return btn;
}

// ---------------------------------------------------------------------------
// Title screen
// ---------------------------------------------------------------------------

function renderTitle() {
  log.info('进入标题界面');
  if (game) {
    game.cleanup();
    game = null;
  }
  screen = 'title';
  backdrop.attach();
  renderer.setFog(18, 42);
  const canContinue = hasSave();
  const menu = el('div', { class: 'title-screen' }, [
    el('div', { class: 'title-panel' }, [
      el('h1', { class: 'game-title', text: 'NetHack' }),
      el('div', { class: 'title-3d', text: '3D' }),
      el('p', { class: 'tagline', 'data-i18n': 'app.tagline' }),
      el('div', { class: 'menu-buttons' }, [
        el('button', {
          class: 'btn primary',
          'data-i18n': 'title.newGame',
          onclick: () => showCreation(),
        }),
        canContinue
          ? el('button', {
              class: 'btn',
              'data-i18n': 'title.continue',
              onclick: () => {
                const session = loadGame();
                if (session) startGame({ session });
              },
            })
          : el('button', {
              class: 'btn disabled',
              'data-i18n': 'title.continue',
              disabled: 'true',
            }),
        el('button', { class: 'btn', 'data-i18n': 'title.howToPlay', onclick: showHelp }),
        el('button', { class: 'btn', 'data-i18n': 'title.about', onclick: showAbout }),
      ]),
      languageButton(),
    ]),
  ]);
  ui.replaceChildren(menu);
  applyI18n(menu);
}

function showCreation() {
  log.info('进入角色创建界面');
  backdrop.detach();
  renderer.setFog(26, 68);
  const creation = createCreationScreen({
    onBack: () => renderTitle(),
    onStart: (options) => startGame(options),
  });
  const holder = el('div', { class: 'creation-screen' }, [creation.el]);
  ui.replaceChildren(holder);
  screen = 'creation';
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

function showVictoryScreen(session: GameSession, onRestart: () => void): () => void {
  const close = () => mask.remove();
  const s = session.status;
  const dialog = el('div', { class: 'dialog victory' }, [
    el('h2', { 'data-i18n': 'victory.title' }),
    el('p', {
      class: 'death-line',
      text: t('victory.summary', { depth: s.depth, turn: s.turn, level: s.level, kills: s.kills }),
    }),
    el('p', { class: 'death-line muted', text: t('victory.seed', { seed: session.seed }) }),
    el('div', { class: 'menu-buttons' }, [
      el('button', {
        class: 'btn primary',
        'data-i18n': 'victory.again',
        onclick: () => {
          close();
          onRestart();
        },
      }),
      el('button', { class: 'btn', 'data-i18n': 'title.backToMenu', onclick: close }),
    ]),
  ]);
  const mask = el('div', { class: 'mask' }, [dialog]);
  overlay.append(mask);
  applyI18n(mask);
  return close;
}

function showDeathScreen(session: GameSession, onRestart: () => void): () => void {
  const close = () => mask.remove();
  const s = session.status;
  const dialog = el('div', { class: 'dialog death' }, [
    el('h2', { 'data-i18n': 'death.title' }),
    el('p', {
      class: 'death-line',
      text: t('death.summary', { depth: s.depth, turn: s.turn, level: s.level, kills: s.kills }),
    }),
    el('p', { class: 'death-line muted', text: t('death.seed', { seed: session.seed }) }),
    el('div', { class: 'menu-buttons' }, [
      el('button', {
        class: 'btn primary',
        'data-i18n': 'death.newGame',
        onclick: () => {
          close();
          onRestart();
        },
      }),
      el('button', { class: 'btn', 'data-i18n': 'title.backToMenu', onclick: close }),
    ]),
  ]);
  const mask = el('div', { class: 'mask' }, [dialog]);
  overlay.append(mask);
  applyI18n(mask);
  return close;
}

const KEY_DIRS: Record<string, string> = {
  ArrowUp: 'N',
  ArrowDown: 'S',
  ArrowLeft: 'W',
  ArrowRight: 'E',
  w: 'N',
  k: 'N',
  s: 'S',
  j: 'S',
  a: 'W',
  h: 'W',
  d: 'E',
  l: 'E',
  y: 'NW',
  u: 'NE',
  b: 'SW',
  n: 'SE',
  Numpad8: 'N',
  Numpad2: 'S',
  Numpad4: 'W',
  Numpad6: 'E',
  Numpad7: 'NW',
  Numpad9: 'NE',
  Numpad1: 'SW',
  Numpad3: 'SE',
};

const DIR_VECTORS: Record<string, [number, number]> = {
  N: [0, -1],
  S: [0, 1],
  E: [1, 0],
  W: [-1, 0],
  NW: [-1, -1],
  NE: [1, -1],
  SW: [-1, 1],
  SE: [1, 1],
};

/** Keys that open the inventory in picker mode. */
const VERB_KEYS: Record<string, string> = {
  w: 'wield',
  W: 'wear',
  T: 'remove',
  q: 'quaff',
  e: 'eat',
  r: 'read',
  z: 'zap',
  d: 'drop',
  a: 'apply',
  t: 'throw',
  f: 'fire',
  P: 'put',
  o: 'open',
};

/** Verbs handled directly; everything else goes through applyItem by class. */
const DIRECT_VERBS: ReadonlySet<string> = new Set([
  'wield',
  'wear',
  'remove',
  'drop',
  'cast',
  'throw',
  'fire',
  'put',
  'open',
  'invoke',
]);

function startGame(options: StartGameOptions = {}): void {
  if (game) {
    game.cleanup();
    game = null;
  }
  backdrop.detach();
  const session = options.session ?? new GameSession(options);
  log.info('开始游戏', {
    seed: session.seed,
    depth: session.depth,
    role: session.player.role.id,
    race: session.player.race.id,
    restored: !!options.session,
  });
  const scene = new GameScene(renderer);
  scene.setPlayerLook(lookForPlayer(session.player.race.id, session.player.gender));
  scene.setLevel(session.level, session.visible);
  scene.setPlayer(session.player.x, session.player.y, { immediate: true });
  scene.syncEntities(session);

  const hud = createHud({ onExit: () => renderTitle() });
  ui.replaceChildren(hud.el);
  hud.render(session);

  // 光标提示：说明所指格子是什么、点击会发生什么。
  const tooltip = document.createElement('div');
  tooltip.className = 'tile-tip';
  tooltip.hidden = true;
  ui.append(tooltip);

  function updateTooltip(tile: Point | null, clientX: number, clientY: number): void {
    const info = tile ? describeTile(session, tile.x, tile.y) : null;
    if (!info) {
      tooltip.hidden = true;
      return;
    }
    tooltip.hidden = false;
    tooltip.dataset.kind = info.kind;
    const title = document.createElement('div');
    title.className = 'tile-tip-title';
    title.textContent = info.title;
    tooltip.replaceChildren(title);
    if (info.hint) {
      const hint = document.createElement('div');
      hint.className = 'tile-tip-hint';
      hint.textContent = info.hint;
      tooltip.append(hint);
    }
    // 跟随光标，并保证不越出视口。
    const box = tooltip.getBoundingClientRect();
    const pad = 14;
    const left = Math.max(8, Math.min(clientX + pad, window.innerWidth - box.width - 8));
    const top = Math.max(8, clientY - box.height - pad);
    tooltip.style.transform = `translate(${left}px, ${top}px)`;
  }

  const offUpdate = renderer.addUpdater((dt) => scene.update(dt));
  // 进入游戏先给出一轮情境操作，不必等到第一次行动之后。
  refreshActions();

  // -------------------------------------------------------------------------
  // 点击移动与情境操作
  // -------------------------------------------------------------------------

  let travel: { steps: Step[]; target: Point; legSeen: number } | null = null;
  /** 自动探索是否在进行中。 */
  let exploring = false;
  /** 自动探索中「走到了也揭不开新区域」的格子，避免原地打转。 */
  let exploreTried = new Set<number>();
  /** 单次自动探索的尝试次数上限，防止异常状态下无限循环。 */
  let exploreAttempts = 0;

  /** 结束自动移动与自动探索，并清掉路径预览。 */
  function cancelTravel(): void {
    exploring = false;
    clearTravel();
  }

  /** 只清路径与预览，不动自动探索状态。 */
  function clearTravel(): void {
    if (!travel) return;
    travel = null;
    scene.setPathPreview([]);
    hud.setPath([]);
  }

  /** 已探索格子数：用来判断一段自动探索有没有揭开新区域。 */
  function seenCount(): number {
    const seen = session.level.seen;
    let n = 0;
    for (let i = 0; i < seen.length; i++) if (seen[i] === 1) n++;
    return n;
  }

  /** 自动探索：反复走向最近的未探索边界，直到走遍全层或出现威胁。 */
  function startExplore(): void {
    clearTravel();
    exploring = true;
    exploreTried = new Set();
    exploreAttempts = 0;
    continueExplore();
  }

  /** 找一处未探索边界并走过去；找不到就停下。 */
  function continueExplore(): void {
    if (!exploring) return;
    // 视野里出现敌人或尝试次数异常时收手，把决定权交回玩家。
    if (session.dead || session.hostileInSight() || exploreAttempts++ > 64) {
      cancelTravel();
      return;
    }
    const target = session.exploreTarget(exploreTried);
    if (!target) {
      cancelTravel();
      return;
    }
    beginTravel(target);
  }

  /** 走到一段探索路径的尽头：没揭开新区域就把脚下这格记下，换一处再走。 */
  function arriveExplore(): void {
    const legSeen = travel?.legSeen ?? 0;
    clearTravel();
    if (seenCount() === legSeen) exploreTried.add(index(session.player.x, session.player.y));
    continueExplore();
  }

  /** 该格是否可以作为点击目标：已探索且可通行。 */
  function clickable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= COLNO || y >= session.level.height) return false;
    const i = index(x, y);
    return session.level.seen[i] === 1 && isWalkable(session.level.tiles[i]);
  }

  /** 站到目标格旁边的方向；相邻时直接返回该方向。 */
  function stepToward(target: Point): Step | null {
    const dx = Math.sign(target.x - session.player.x);
    const dy = Math.sign(target.y - session.player.y);
    if (dx === 0 && dy === 0) return null;
    return { dx, dy };
  }

  /** 手动走向目标：先结束自动探索，再算路径。 */
  function startTravel(target: Point): void {
    cancelTravel();
    beginTravel(target);
  }

  /** 走向目标：算出路径并显示预览，然后逐步推进。 */
  function beginTravel(target: Point): boolean {
    clearTravel();
    const from = { x: session.player.x, y: session.player.y };
    const steps = findPath(session.level, from, target, { levitating: session.isFloating() });
    if (!steps || steps.length === 0) {
      log.debug('没有可走的路径', { from, target });
      // 探索时遇到不可达的边界（例如隔着关着的门）就跳过，换下一处。
      if (exploring) {
        exploreTried.add(index(target.x, target.y));
        continueExplore();
      }
      return false;
    }
    travel = { steps, target, legSeen: seenCount() };
    const preview = pathPoints(from, steps);
    scene.setPathPreview(preview);
    hud.setPath(preview);
    stepTravel();
    return true;
  }

  /** 沿路径走一步；被挡住或受伤就停下。 */
  function stepTravel(): void {
    const active = travel;
    if (!active) return;
    if (active.steps.length === 0) {
      finishLeg();
      return;
    }
    const step = active.steps[0];
    const hpBefore = session.player.hp;
    const result = session.movePlayer(step.dx, step.dy);
    afterAction(result);
    if (!travel) return; // 换层等操作已经清掉了路径。
    // 受伤说明附近有威胁，交给玩家决定下一步。
    if (session.player.hp < hpBefore) {
      cancelTravel();
      return;
    }
    if (result.result === 'moved') {
      travel.steps.shift();
      if (travel.steps.length === 0) {
        finishLeg();
        return;
      }
      const preview = pathPoints({ x: session.player.x, y: session.player.y }, travel.steps);
      scene.setPathPreview(preview);
      hud.setPath(preview);
      stepTravel();
      return;
    }
    // 开门要花一回合但人没动：自动探索重试这一步；锁着的门则放弃。
    if (result.result === 'opened' && exploring) {
      const door = session.level.doors.get(
        index(session.player.x + step.dx, session.player.y + step.dy),
      );
      if (door && !door.closed) {
        stepTravel();
        return;
      }
    }
    cancelTravel();
  }

  /** 一段路径走完：自动探索接着找下一处，手动模式则收起预览。 */
  function finishLeg(): void {
    if (exploring) arriveExplore();
    else clearTravel();
  }

  /**
   * 休息到恢复：原地等待直到生命与法力回满。
   *
   * 视野里出现敌人、生命开始下降（挨打或生病）或开始饿肚子时提前停下，
   * 把决定权交回玩家；等待有回合上限，避免异常状态下长时间阻塞。
   */
  function restUntilHealed(): void {
    cancelTravel();
    const p = session.player;
    let turns = 0;
    let result: ActionResultInfo = { result: 'waited' };
    while (!session.dead && turns < 600) {
      if (p.hp >= p.maxHp && p.pw >= p.maxPw) break;
      if (session.hostileInSight()) break;
      if (p.hunger < HUNGER_WARN) break;
      const hpBefore = p.hp;
      result = session.wait();
      turns++;
      if (p.hp < hpBefore) break;
    }
    if (turns > 0) afterAction(result);
  }

  /** 根据当前局面生成情境操作。 */
  function refreshActions(): void {
    const level = session.level;
    const player = session.player;
    const actions: HudAction[] = [];

    const pile = level.objects.find(
      (p) => p.x === player.x && p.y === player.y && p.items.length > 0,
    );
    if (pile) {
      actions.push({
        id: 'pickup',
        label: t('actions.pickup'),
        key: 'g',
        hint: t('actionHints.pickup'),
        onRun: () => {
          cancelTravel();
          afterAction(session.pickupAction());
        },
      });
      // 脚下的堆里有容器时，可以就地搜划。
      if (pile.items.some((item) => isContainer(item))) {
        actions.push({
          id: 'loot',
          label: t('actions.loot'),
          hint: t('actionHints.loot'),
          onRun: () => {
            cancelTravel();
            afterAction(session.lootContainer());
          },
        });
      }
    }

    // 脚下的地形设施：喷泉、水槽、坟墓、王座各有自己的动作。
    const featureDef = FEATURE_ACTIONS[level.tiles[index(player.x, player.y)]];
    if (featureDef) {
      const feature = level.features.get(index(player.x, player.y));
      const spent = !!feature && (feature.depleted || feature.used);
      actions.push({
        id: featureDef.id,
        label: t(featureDef.labelKey),
        hint: spent ? t('msg.featureSpent') : t(featureDef.hintKey),
        onRun: () => {
          cancelTravel();
          afterAction(session.useFeature(featureDef.action));
        },
      });
    }

    // 圣所的振动方块：集齐三件圣物后可以举行开启仪式。
    const onTrap = level.traps.get(index(player.x, player.y));
    if (onTrap?.type === 'VIBRATING_SQUARE') {
      const ready = !!session.invocationRelics();
      actions.push({
        id: 'invoke',
        label: t('actions.invoke'),
        hint: ready ? t('actionHints.invoke') : t('actionHints.invokeMissing'),
        onRun: () => {
          cancelTravel();
          afterAction(session.invokeRitual());
        },
      });
    }
    // 仪式开启的魔法传送门：站上去就能踏入异界。
    if (onTrap?.type === 'MAGIC_PORTAL') {
      actions.push({
        id: 'enterPortal',
        label: t('actions.enterPortal'),
        hint: t('actionHints.enterPortal'),
        onRun: () => {
          cancelTravel();
          afterAction(session.enterPortal());
        },
      });
    }

    // 脚下或身边有已知陷阱时，可以动手拆除。
    if (session.disarmTarget()) {
      actions.push({
        id: 'untrap',
        label: t('actions.untrap'),
        hint: t('actionHints.untrap'),
        onRun: () => {
          cancelTravel();
          afterAction(session.untrapAction());
        },
      });
    }

    // 持镐站在地面上时，可以向下挖穿地板。
    if (session.canDigDown()) {
      actions.push({
        id: 'digDown',
        label: t('actions.digDown'),
        hint: t('actionHints.digDown'),
        onRun: () => {
          cancelTravel();
          afterAction(session.digDown());
        },
      });
    }

    // 站在祭坛上且背包里有尸体时，可以献祭。
    if (level.tiles[index(player.x, player.y)] === T.ALTAR) {
      const corpse = player.inventory.find((item) => item.corpse);
      if (corpse) {
        actions.push({
          id: 'offer',
          label: t('actions.offer'),
          hint: t('actionHints.offer'),
          onRun: () => {
            cancelTravel();
            afterAction(session.offerCorpse());
          },
        });
      }
      // 带着尤恩多护身符时，可以在异界的祭坛上献礼登神。
      if (
        session.branch === 'planes' &&
        player.inventory.some((item) => item.proto.id === 'AMULET_OF_YENDOR')
      ) {
        actions.push({
          id: 'ascend',
          label: t('actions.ascend'),
          hint: t('actionHints.ascend'),
          onRun: () => {
            cancelTravel();
            afterAction(session.offerAmulet());
          },
        });
      }
    }

    const foe = level.monsters.find(
      (m) =>
        m.mhp > 0 &&
        Math.abs(m.x - player.x) <= 1 &&
        Math.abs(m.y - player.y) <= 1 &&
        (m.x !== player.x || m.y !== player.y),
    );
    if (foe) {
      actions.push({
        id: 'attack',
        label: t('actions.attack'),
        hint: t('actionHints.attack'),
        onRun: () => {
          cancelTravel();
          const toward = stepToward(foe);
          if (toward) afterAction(session.movePlayer(toward.dx, toward.dy));
        },
      });
    }

    // 神谕就在身边时，可以花金币买一条提示。
    const oracle = level.monsters.find(
      (m) =>
        !m.dead &&
        m.data.id === 'ORACLE' &&
        Math.abs(m.x - player.x) <= 1 &&
        Math.abs(m.y - player.y) <= 1 &&
        (m.x !== player.x || m.y !== player.y),
    );
    if (oracle) {
      actions.push({
        id: 'consult',
        label: t('actions.consult'),
        hint: t('actionHints.consult'),
        onRun: () => {
          cancelTravel();
          afterAction(session.consultOracle());
        },
      });
    }

    // 身边的职业任务领袖：交谈一次即可解锁任务楼梯。
    const quest = session.character.role.quest;
    const questLeader = quest
      ? level.monsters.find(
          (m) =>
            !m.dead &&
            m.data.id === quest.leader &&
            Math.abs(m.x - player.x) <= 1 &&
            Math.abs(m.y - player.y) <= 1 &&
            (m.x !== player.x || m.y !== player.y),
        )
      : undefined;
    if (questLeader) {
      actions.push({
        id: 'talk',
        label: t('actions.talk'),
        hint: session.questUnlocked ? t('actionHints.talkDone') : t('actionHints.talk'),
        onRun: () => {
          cancelTravel();
          afterAction(session.talkToLeader());
        },
      });
    }

    // 身边有宠物且有食物时，可以喂它一份。
    const petNearby = level.monsters.find(
      (m) =>
        !m.dead &&
        m.tame &&
        Math.abs(m.x - player.x) <= 1 &&
        Math.abs(m.y - player.y) <= 1 &&
        (m.x !== player.x || m.y !== player.y),
    );
    const hasFood = player.inventory.some((item) => item.proto.cls === 'food');
    if (petNearby && hasFood) {
      actions.push({
        id: 'feed',
        label: t('actions.feed'),
        hint: t('actionHints.feed'),
        onRun: () => {
          cancelTravel();
          afterAction(session.feedPet());
        },
      });
    }

    // 骑乘：中大型宠物可骑上；骑乘中显示下马。
    if (session.ride) {
      actions.push({
        id: 'dismount',
        label: t('actions.dismount'),
        hint: t('actionHints.dismount'),
        onRun: () => {
          cancelTravel();
          afterAction(session.dismount());
        },
      });
    } else if (session.canMount()) {
      actions.push({
        id: 'mount',
        label: t('actions.mount'),
        hint: t('actionHints.mount'),
        onRun: () => {
          cancelTravel();
          afterAction(session.mountPet());
        },
      });
    }

    // 楼梯要已经探索过才给这个按钮：否则点了也走不过去，只会让人困惑。
    const stairs = level.down as Point | undefined;
    if (
      stairs &&
      level.seen[index(stairs.x, stairs.y)] === 1 &&
      (stairs.x !== player.x || stairs.y !== player.y)
    ) {
      actions.push({
        id: 'travel',
        label: t('actions.travel'),
        hint: t('actionHints.travel'),
        onRun: () => startTravel(stairs),
      });
    }

    actions.push(
      {
        id: 'explore',
        label: t('actions.explore'),
        key: 'x',
        hint: t('actionHints.explore'),
        onRun: () => startExplore(),
      },
      {
        id: 'rest',
        label: t('actions.rest'),
        key: 'R',
        hint: t('actionHints.rest'),
        onRun: () => restUntilHealed(),
      },
      {
        id: 'wait',
        label: t('actions.wait'),
        key: '.',
        hint: t('actionHints.wait'),
        onRun: () => {
          cancelTravel();
          afterAction(session.wait());
        },
      },
      {
        id: 'search',
        label: t('actions.search'),
        key: 's',
        hint: t('actionHints.search'),
        onRun: () => {
          cancelTravel();
          afterAction(session.searchAction());
        },
      },
      {
        id: 'pray',
        label: t('actions.pray'),
        key: 'p',
        hint: t('actionHints.pray'),
        onRun: () => {
          cancelTravel();
          afterAction(session.pray());
        },
      },
      {
        id: 'pack',
        label: t('actions.pack'),
        key: 'i',
        hint: t('actionHints.pack'),
        onRun: () => {
          cancelTravel();
          openPanel(null);
        },
      },
      {
        id: 'help',
        label: t('actions.help'),
        key: '?',
        hint: t('actionHints.help'),
        onRun: () => {
          cancelTravel();
          showHelp();
        },
      },
    );

    hud.setActions(actions);
  }

  /** 把动作结果翻译成音效。 */
  function playActionResult(result: ActionResultInfo, hpBefore: number, levelBefore: number): void {
    // 挖掘、读书与捡金币有自己的音效，不走通用结果音。
    const key = result.key ?? '';
    if (key.startsWith('msg.dig')) {
      playSfx('mining', { gain: 0.8, rate: 0.95 });
    } else if (key === 'use.studySpell') {
      playSfx('book', { gain: 0.8 });
    } else if (key === 'msg.gold') {
      playSfx('coins', { gain: 0.8 });
    } else {
      switch (result.result) {
        case 'moved':
          playFootstep();
          break;
        case 'opened':
          playSfx('door-open', { gain: 0.8 });
          break;
        case 'blocked':
          playSfx('hit-wood', { gain: 0.5, rate: 0.9 });
          break;
        case 'picked':
          playSfx('confirm', { gain: 0.7 });
          break;
        case 'used':
          playSfx('potion', { gain: 0.7 });
          break;
        case 'descended':
          playSfx('descend', { gain: 0.9 });
          break;
        default:
          break;
      }
    }
    // 受击与升级用状态变化判断，比结果字段更直接。
    if (session.player.hp < hpBefore) playSfx('hit-light', { gain: 0.8 });
    if (session.player.level > levelBefore) playSfx('level-up', { gain: 0.9 });
    if (session.dead) playSfx('body-fall', { gain: 0.9, rate: 0.8 });
  }

  function afterAction(result: ActionResultInfo): void {
    const hpBefore = session.player.hp;
    const levelBefore = session.player.level;
    if (result && (result.result === 'descended' || result.result === 'ascended')) {
      // 换层后旧路径失效。
      cancelTravel();
      scene.setLevel(session.level, session.visible);
      scene.setPlayer(session.player.x, session.player.y, { immediate: true });
    } else {
      scene.setPlayer(session.player.x, session.player.y);
      // 挖墙或设施消失会改变瓦片结构，网格要重建并立即补回实体视图。
      if (scene.syncLevel(session.level, session.visible)) scene.syncEntities(session);
      if (session.lastCombat) {
        const c = session.lastCombat;
        scene.entities.flash(c.monsterId, c.byPlayer ? 0xff4444 : 0x66aaff);
        if (c.byPlayer && c.hit) scene.entities.lunge(c.monsterId, 0, 0);
        scene.spawnMonsterSparks(c.monsterId, c.byPlayer ? 0xffd479 : 0x66aaff, c.killed === true);
        if (c.byPlayer) {
          scene.playerAttack();
          playSfx(c.hit ? 'hit-heavy' : 'slice', { gain: 0.85, rate: 0.95 + Math.random() * 0.1 });
        } else if (c.hit) {
          playSfx('hit-light', { gain: 0.7 });
        }
        session.lastCombat = null;
      }
    }
    scene.setVisibility(session.visible);
    scene.syncEntities(session);
    hud.render(session);
    refreshActions();
    if (session.pendingWishes > 0 || session.pendingGenocide) openWishPanel();
    playActionResult(result, hpBefore, levelBefore);
    if (session.dead && !deathShown) {
      deathShown = true;
      scene.playerDie();
      log.warn('本局结束：玩家死亡', { turn: session.turn, depth: session.depth });
      playSfx('error', { gain: 0.9 });
      // 死亡现场写成骨头文件，下一局会在同一层发现遗物。
      saveBones(session);
      clearSave();
      showDeathScreen(session, () => startGame());
    } else if (session.victory && !victoryShown) {
      victoryShown = true;
      log.info('本局结束：取得护身符', { turn: session.turn, kills: session.kills });
      playSfx('level-up', { gain: 1 });
      playSfx('confirm', { gain: 0.8 });
      clearSave();
      showVictoryScreen(session, () => startGame());
    } else if (!session.dead) {
      saveGame(session);
    }
  }

  let deathShown = false;
  let victoryShown = false;
  let panel: InventoryPanelHandle | null = null;
  let wishPanel: WishPanelHandle | null = null;

  /** 打开许愿输入框：使用许愿魔杖或魔法灯后出现。 */
  function openWishPanel(): void {
    if (wishPanel) return;
    playSfx('open', { gain: 0.6 });
    wishPanel = createWishPanel(hud.el, {
      mode: session.pendingGenocide ? 'genocide' : 'wish',
      onWish: (text) => {
        if (session.pendingGenocide) {
          const ok = session.tryGenocide(text);
          hud.render(session);
          refreshActions();
          if (ok) playSfx('confirm', { gain: 0.8 });
          return ok;
        }
        const res = session.grantWish(text);
        hud.render(session);
        refreshActions();
        if (res.ok) playSfx('confirm', { gain: 0.8 });
        return res.ok;
      },
      onClose: () => {
        wishPanel = null;
      },
    });
  }

  function openPanel(verb: string | null = null): void {
    // 面板遮住场景时，光标提示没有意义。
    tooltip.hidden = true;
    playSfx('open', { gain: 0.6 });
    if (panel) panel.destroy();
    panel = createInventoryPanel({
      session,
      onClose: () => {
        panel?.destroy();
        panel = null;
      },
      onChoose: (chosenVerb, item) => {
        panel?.destroy();
        panel = null;
        if (!chosenVerb && !item) return;
        const effectiveVerb = chosenVerb && DIRECT_VERBS.has(chosenVerb) ? chosenVerb : null;
        const res = session.useItem(item, effectiveVerb);
        afterAction(res);
      },
    });
    panel.setVerb(verb);
    ui.append(panel.el);
  }

  function onKeyDown(e: KeyboardEvent): void {
    // 手动操作即接管，停止自动移动。
    if (e.key !== '?') cancelTravel();
    if (e.key === 'Escape') {
      if (panel) {
        panel.destroy();
        panel = null;
        return;
      }
      if (hud.closeDump()) return;
      renderTitle();
      return;
    }
    // 转储弹窗里在选文本，按键不应驱动游戏。
    if (hud.dumpOpen()) return;
    if (panel) return; // the panel owns its keys
    if (wishPanel) return; // the wish input owns its keys
    if (e.key === 'i') {
      e.preventDefault();
      openPanel(null);
      return;
    }
    if (e.key === '?' || e.key === '/') {
      e.preventDefault();
      showHelp();
      return;
    }
    if (e.key === 'g' || e.key === ',') {
      e.preventDefault();
      afterAction(session.pickupAction());
      return;
    }
    if (e.key === 'p') {
      e.preventDefault();
      afterAction(session.pray());
      return;
    }
    if (e.key === 's') {
      e.preventDefault();
      afterAction(session.searchAction());
      return;
    }
    // 现代 roguelike 的便捷操作：自动探索与休息到恢复。
    if (e.key === 'x') {
      e.preventDefault();
      startExplore();
      return;
    }
    if (e.key === 'R') {
      e.preventDefault();
      restUntilHealed();
      return;
    }
    if (VERB_KEYS[e.key]) {
      e.preventDefault();
      openPanel(VERB_KEYS[e.key]);
      return;
    }
    const dir = KEY_DIRS[e.key] ?? KEY_DIRS[e.code];
    if (dir) {
      e.preventDefault();
      const [dx, dy] = DIR_VECTORS[dir];
      afterAction(session.movePlayer(dx, dy));
      return;
    }
    if (e.key === '.' || e.key === ' ' || e.code === 'Numpad5') {
      e.preventDefault();
      afterAction(session.wait());
    }
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  // 累计拖动距离，用来区分「拖动视角」与「点击地面」。
  let dragDistance = 0;

  /** 光标所指的可行走格子；其它位置返回 null。 */
  function hoverTile(clientX: number, clientY: number): Point | null {
    const tile = scene.tileFromScreen(clientX, clientY);
    if (!tile || !clickable(tile.x, tile.y)) return null;
    return tile;
  }

  const onPointerDown = (e: PointerEvent): void => {
    tooltip.hidden = true;
    dragging = true;
    dragDistance = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    // 合成的指针事件没有活动指针，捕获会抛错；失败不影响点击判定。
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // 忽略：仅表示无法锁定指针。
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) {
      const tile = scene.tileFromScreen(e.clientX, e.clientY);
      const walkable = !!tile && clickable(tile.x, tile.y);
      scene.setHoverTile(walkable ? tile : null);
      canvas.style.cursor = walkable ? 'pointer' : 'default';
      updateTooltip(tile, e.clientX, e.clientY);
      return;
    }
    tooltip.hidden = true;
    dragDistance += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    scene.rig.rotate(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
  };

  const onPointerUp = (e: PointerEvent): void => {
    const wasDragging = dragging;
    dragging = false;
    try {
      canvas.releasePointerCapture?.(e.pointerId);
    } catch {
      // 忽略：与捕获失败同因。
    }
    // 拖动过视角就不算点击。
    if (!wasDragging || dragDistance > 6) return;
    const tile = hoverTile(e.clientX, e.clientY);
    if (!tile) return;
    if (tile.x === session.player.x && tile.y === session.player.y) return;
    const foe = session.level.monsters.find((m) => m.mhp > 0 && m.x === tile.x && m.y === tile.y);
    if (foe && Math.abs(foe.x - session.player.x) <= 1 && Math.abs(foe.y - session.player.y) <= 1) {
      cancelTravel();
      const toward = stepToward(foe);
      if (toward) afterAction(session.movePlayer(toward.dx, toward.dy));
      return;
    }
    startTravel(tile);
  };

  const onPointerLeave = (): void => {
    scene.setHoverTile(null);
    tooltip.hidden = true;
    canvas.style.cursor = 'default';
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    scene.rig.zoom(e.deltaY);
  };
  const onContextMenu = (e: Event): void => e.preventDefault();

  window.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);

  const offLocale = onLocaleChange(() => hud.render(session));

  // 触屏方向键：粗指针设备（手机/平板）上提供八方向与等待按钮；
  // 自动化检查可以用 `?touch=1` 强制显示。
  const forceTouch = new URLSearchParams(location.search).has('touch');
  if (
    forceTouch ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
  ) {
    const pad = document.createElement('div');
    pad.className = 'touch-pad';
    const layout: Array<{ id: string; dx: number; dy: number; label: string } | 'wait' | null> = [
      { id: 'NW', dx: -1, dy: -1, label: 'northwest' },
      { id: 'N', dx: 0, dy: -1, label: 'north' },
      { id: 'NE', dx: 1, dy: -1, label: 'northeast' },
      { id: 'W', dx: -1, dy: 0, label: 'west' },
      'wait',
      { id: 'E', dx: 1, dy: 0, label: 'east' },
      { id: 'SW', dx: -1, dy: 1, label: 'southwest' },
      { id: 'S', dx: 0, dy: 1, label: 'south' },
      { id: 'SE', dx: 1, dy: 1, label: 'southeast' },
    ];
    const glyph: Record<string, string> = {
      NW: '↖',
      N: '↑',
      NE: '↗',
      W: '←',
      E: '→',
      SW: '↙',
      S: '↓',
      SE: '↘',
    };
    for (const cell of layout) {
      if (!cell) {
        pad.append(document.createElement('span'));
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'touch-key';
      if (cell === 'wait') {
        button.textContent = '·';
        button.setAttribute('aria-label', t('actions.wait'));
        button.addEventListener('pointerdown', (e): void => {
          e.preventDefault();
          cancelTravel();
          afterAction(session.wait());
        });
      } else {
        button.textContent = glyph[cell.id];
        button.setAttribute('aria-label', t(`dir.${cell.label}`));
        const dx = cell.dx;
        const dy = cell.dy;
        button.addEventListener('pointerdown', (e): void => {
          e.preventDefault();
          cancelTravel();
          afterAction(session.movePlayer(dx, dy));
        });
      }
      pad.append(button);
    }
    ui.append(pad);
  }

  game = {
    session,
    scene,
    hud,
    perf(): RenderStats {
      const view = scene.renderer;
      const info = view.renderer.info;
      const buffer = view.renderer.domElement;
      return {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
        models: loadedModelCount() + loadedCharacterCount(),
        pixelRatio: view.renderer.getPixelRatio(),
        width: buffer.width,
        height: buffer.height,
      };
    },
    cleanup() {
      if (panel) {
        panel.destroy();
        panel = null;
      }
      window.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      offLocale();
      offUpdate();
      scene.dispose();
      tooltip.remove();
      hud.destroy();
    },
  };
  screen = 'game';
  // 开发模式或带 `?debug=1` 时暴露调试句柄：自动化检查需要它验证生产构建，
  // 线上排查也依赖它读取现场状态。
  if (typeof window !== 'undefined' && (import.meta.env?.DEV || debugRequested())) {
    (window as unknown as { __nethack3d: GameContext }).__nethack3d = game;
  }
}

onLocaleChange(() => {
  if (screen === 'title') renderTitle();
});

// 模型素材在启动前加载完毕，游戏内不再有异步等待。
// 加载失败会回退到程序化几何体，不影响启动。
await loadModels();
await loadCharacters();

renderTitle();
log.info('应用启动完成', { locale: getLocale(), version: '0.1.0' });
log.debug('调试已开启，可用 __nethack3dLog.dump() 导出日志');
// 便于在控制台快速取日志。
(window as unknown as { __nethack3dDumpLogs?: () => string }).__nethack3dDumpLogs = dumpLogs;
