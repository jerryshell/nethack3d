/**
 * 游戏内 HUD：状态栏、目标提示、情境操作、消息日志、状态转储与语言切换按钮。
 *
 * 消息变量里保存的是实体 ID（mon、obj、roleId、raceId），
 * 在这里解析成当前语言的名称，因此切换语言后历史消息也会重新翻译。
 *
 * 面向不熟悉 roguelike 的玩家，这里刻意做了两件事：
 * 常驻显示当前目标；把此刻可做的操作做成按钮，不必先背下按键。
 */

import type { GameSession } from '../game/session';
import { MAX_DEPTH } from '../game/session';
import { luckArtifactBonus } from '../game/combat';
import { t, applyI18n, onLocaleChange, setLocale, nextLocale, LOCALES } from '../i18n/index';
import { formatMessage } from './message';
import { createMinimap } from './minimap';
import { statusIconSvg } from './icons';
import { buildDump, dumpFileName } from './dump';
import { alignDisplayName } from '../data/i18n';
import { isMuted, playSfx, setMuted } from '../core/audio';
import { HUNGER_DANGER, HUNGER_WARN } from '../core/constants';

/** 情境操作：由调用方根据当前局面生成。 */
export interface HudAction {
  id: string;
  label: string;
  /** 对应的快捷键，显示在按钮上帮助键盘玩家建立对应关系。 */
  key?: string;
  /** 鼠标悬停时的补充说明。 */
  hint?: string;
  onRun: () => void;
}

/** HUD 的可选回调。 */
interface HudOptions {
  onExit?: () => void;
}

/** HUD 句柄：DOM 元素、渲染入口与销毁方法。 */
export interface HudHandle {
  el: HTMLElement;
  render(session?: GameSession | null): void;
  /**
   * 更新情境操作按钮。 */
  setActions(actions: HudAction[]): void;
  /** 同步旅行路径到小地图。 */
  setPath(points: { x: number; y: number }[]): void;
  /** 转储弹窗是否打开。 */
  dumpOpen(): boolean;
  /** 关闭转储弹窗；未打开时返回 false。 */
  closeDump(): boolean;
  /** 消息历史弹窗是否打开。 */
  historyOpen(): boolean;
  /** 关闭消息历史弹窗；未打开时返回 false。 */
  closeHistory(): boolean;
  destroy(): void;
}

export function createHud({ onExit }: HudOptions = {}): HudHandle {
  const el = document.createElement('div');
  el.className = 'hud';

  const top = document.createElement('div');
  top.className = 'hud-top';

  const stats = document.createElement('div');
  stats.className = 'hud-stats';

  const actions = document.createElement('div');
  actions.className = 'hud-actions';

  const langBtn = document.createElement('button');
  langBtn.className = 'btn ghost small';
  const paintLang = () => {
    langBtn.textContent = LOCALES[nextLocale()].label;
    langBtn.title = t('lang.switch', { name: LOCALES[nextLocale()].label });
  };
  paintLang();
  langBtn.addEventListener('click', () => setLocale(nextLocale()));

  const muteBtn = document.createElement('button');
  muteBtn.className = 'btn ghost small';
  const paintMute = (): void => {
    muteBtn.textContent = t(isMuted() ? 'audio.muted' : 'audio.on');
    muteBtn.title = t(isMuted() ? 'audio.unmuteHint' : 'audio.muteHint');
  };
  muteBtn.addEventListener('click', () => {
    setMuted(!isMuted());
    paintMute();
  });

  const dumpBtn = document.createElement('button');
  const historyBtn = document.createElement('button');
  historyBtn.className = 'btn ghost small';
  historyBtn.dataset.i18n = 'hud.history';
  historyBtn.title = t('hud.historyHint');
  historyBtn.addEventListener('click', () => openHistory());

  dumpBtn.className = 'btn ghost small';
  dumpBtn.dataset.i18n = 'hud.dump';
  dumpBtn.title = t('hud.dumpHint');
  dumpBtn.addEventListener('click', () => openDump());

  const exitBtn = document.createElement('button');
  exitBtn.className = 'btn ghost small';
  exitBtn.dataset.i18n = 'menu.back';
  exitBtn.addEventListener('click', () => onExit?.());

  actions.append(langBtn, muteBtn, historyBtn, dumpBtn, exitBtn);
  top.append(stats, actions);

  const center = document.createElement('div');
  center.className = 'hud-center';

  const objective = document.createElement('div');
  objective.className = 'hud-objective';
  objective.dataset.role = 'objective';

  const actionBar = document.createElement('div');
  actionBar.className = 'hud-actionbar';
  actionBar.dataset.role = 'actions';

  center.append(objective, actionBar);

  const log = document.createElement('div');
  log.className = 'hud-log';

  const help = document.createElement('div');
  help.className = 'hud-help';
  help.dataset.i18n = 'hud.controls';

  const minimap = createMinimap();

  el.append(top, center, log, help, minimap.el);
  applyI18n(el);

  /** 状态格：小号标签加数值，数值用等宽数字避免跳动。 */
  function statCell(
    key: string,
    labelKey: string,
    vars: Record<string, string | number>,
  ): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'hud-stat';
    // 供自动化读取：数据键与 i18n 键一致，如 hud.seed。
    cell.dataset.stat = key;
    const label = document.createElement('span');
    label.className = 'hud-stat-label';
    label.textContent = t(labelKey);
    const value = document.createElement('span');
    value.className = 'hud-stat-value';
    value.textContent = t(key, vars);
    cell.append(label, value);
    return cell;
  }

  /** 生命条：颜色随比例变化，危险时更醒目。 */
  function hpCell(session: GameSession): HTMLElement {
    const s = session.status;
    const cell = statCell('hud.hitPoints', 'hud.hitPointsLabel', { hp: s.hp, max: s.maxHp });
    const ratio = s.maxHp > 0 ? Math.max(0, Math.min(1, s.hp / s.maxHp)) : 0;
    const bar = document.createElement('div');
    bar.className = 'hud-bar';
    const fill = document.createElement('b');
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    bar.append(fill);
    cell.classList.add('has-bar');
    cell.dataset.level = ratio <= 0.25 ? 'danger' : ratio <= 0.5 ? 'warn' : 'ok';
    cell.append(bar);
    return cell;
  }

  /** 饥饿只在需要提醒时出现，状态正常时不占用注意力。 */
  function hungerCell(session: GameSession): HTMLElement | null {
    const hunger = session.player.hunger;
    if (hunger >= HUNGER_WARN) return null;
    const cell = document.createElement('div');
    cell.className = 'hud-stat hud-warn';
    const svg = statusIconSvg('hunger');
    if (svg) cell.insertAdjacentHTML('beforeend', svg);
    cell.append(
      document.createTextNode(t(hunger < HUNGER_DANGER ? 'hud.hungerFaint' : 'hud.hungerHungry')),
    );
    return cell;
  }

  /** 疾病提醒：患病期间常驻，治疗或自愈后消失。 */
  function sickCell(session: GameSession): HTMLElement | null {
    if (session.player.sick <= 0) return null;
    const cell = document.createElement('div');
    cell.className = 'hud-stat hud-warn';
    const svg = statusIconSvg('sick');
    if (svg) cell.insertAdjacentHTML('beforeend', svg);
    cell.append(document.createTextNode(t('hud.sick')));
    return cell;
  }

  /** 状态小标签：失明、混乱、隐形、沉睡、被缠、眩晕与石化。 */
  function effectsCell(session: GameSession): HTMLElement | null {
    const p = session.player;
    const all: [number, string, boolean, string][] = [
      [p.isBlind ? Math.max(1, p.blind) : 0, 'hud.effectBlind', false, 'blind'],
      [p.confused, 'hud.effectConfused', false, 'confused'],
      [p.sleep, 'hud.effectSleep', false, 'sleep'],
      [p.held, 'hud.effectHeld', false, 'held'],
      [p.stun, 'hud.effectStun', false, 'stun'],
      [p.hasted, 'hud.effectHasted', false, 'hasted'],
      [p.senseMonsters, 'hud.effectSenseMonsters', false, 'eye'],
      [p.petrifying, 'hud.effectPetrifying', true, 'petrifying'],
      [p.punished ? 1 : 0, 'hud.effectPunished', true, 'punished'],
    ];
    if (session.hasTelepathy()) all.push([1, 'hud.effectTelepathy', false, 'telepathy']);
    if (session.hasLevitation())
      all.push([session.player.levitating || 1, 'hud.effectLevitation', false, 'levitation']);
    if (session.hasFlight()) all.push([1, 'hud.effectFlight', false, 'levitation']);
    if (p.drowning > 0) all.push([p.drowning, 'hud.effectDrowning', true, 'drowning']);
    if (session.hasInvisibility()) all.push([1, 'hud.effectInvisible', false, 'invisible']);
    if (session.player.senseObjects > 0) all.push([1, 'hud.effectSenseObjects', false, 'eye']);
    if (session.player.senseGold > 0) all.push([1, 'hud.effectSenseGold', false, 'eye']);
    if (session.player.senseFood > 0) all.push([1, 'hud.effectSenseFood', false, 'eye']);
    const active = all.filter(([turns]) => turns > 0);
    if (!active.length) return null;
    const cell = document.createElement('div');
    cell.className = 'hud-effects';
    for (const [turns, key, danger, icon] of active) {
      cell.append(chipOf(key, icon, danger, turns));
    }
    return cell;
  }

  /** 把图标、文字与剩余回合拼成一个状态标签。 */
  function chipOf(key: string, icon: string, danger: boolean, turns = 0): HTMLElement {
    const chip = document.createElement('span');
    chip.className = danger ? 'hud-chip danger' : 'hud-chip';
    const svg = statusIconSvg(icon);
    if (svg) chip.insertAdjacentHTML('beforeend', svg);
    chip.append(document.createTextNode(t(key)));
    // 计时状态额外标出剩余回合；常驻能力（心灵感应等）不进这个分支。
    if (turns > 1) {
      const count = document.createElement('span');
      count.className = 'hud-chip-turns';
      count.textContent = String(Math.ceil(turns));
      chip.append(count);
    }
    return chip;
  }

  function renderStats(session: GameSession): void {
    const s = session.status;
    const luck = session.player.luck + luckArtifactBonus(session.player);
    stats.replaceChildren();
    stats.append(
      statCell('hud.depth', 'hud.depthLabel', { depth: s.depth }),
      hpCell(session),
      statCell('hud.levelXp', 'hud.levelXpLabel', { level: s.level, xp: s.xp, next: s.nextXp }),
      statCell('hud.power', 'hud.powerLabel', { pw: s.pw, max: s.maxPw }),
      statCell('hud.armorClass', 'hud.armorClassLabel', { ac: s.ac }),
      statCell('hud.gold', 'hud.goldLabel', { gold: s.gold }),
      statCell('hud.luck', 'hud.luckLabel', { luck: `${luck >= 0 ? '+' : ''}${luck}` }),
      statCell('hud.align', 'hud.alignLabel', {
        align: alignDisplayName(session.player.align),
        record: `${session.player.alignRecord >= 0 ? '+' : ''}${session.player.alignRecord}`,
      }),
      statCell('hud.turn', 'hud.turnLabel', { turn: s.turn }),
      statCell('hud.seed', 'hud.seedLabel', { seed: session.seed }),
    );
    const hunger = hungerCell(session);
    if (hunger) stats.append(hunger);
    const sick = sickCell(session);
    if (sick) stats.append(sick);
    const effects = effectsCell(session);
    if (effects) stats.append(effects);
  }

  function renderObjective(session: GameSession): void {
    if (session.victory) {
      objective.textContent = t('hud.goalDone');
      objective.dataset.state = 'done';
      return;
    }
    if (session.branch !== 'main') {
      // 任务分支的目标随进度变化：先见领袖，再找神器，最后复命。
      if (session.branch === 'quest') {
        const roleId = session.player.role.id;
        let key = 'hud.questBrief';
        if (session.questComplete) key = 'hud.questDone';
        else if (session.carryingQuestArtifact()) key = 'hud.questReturn';
        else if (session.questUnlocked) key = 'hud.questSeek';
        objective.textContent = t(key, {
          goal: t(`quest.${roleId}.goal`),
          home: t(`quest.${roleId}.home`),
        });
        objective.dataset.state = session.questComplete ? 'done' : 'active';
        return;
      }
      // 异界终局：先穿过元素位面，到星界后把护身符献给本阵营的祭坛。
      if (session.branch === 'planes') {
        const astral = session.depth >= session.maxDepth;
        if (astral && session.carryingAmulet) {
          objective.textContent = t('hud.astralGoal');
          objective.dataset.state = 'active';
        } else if (astral) {
          objective.textContent = t('hud.astralNoAmulet');
          objective.dataset.state = 'active';
        } else {
          objective.textContent = t('hud.planesGoal', {
            depth: session.depth,
            max: session.maxDepth,
          });
          objective.dataset.state = 'active';
        }
        return;
      }
      objective.textContent = t('hud.branchGoal', {
        branch: t(`branch.${session.branch}`),
        depth: session.depth,
        max: session.maxDepth,
      });
      objective.dataset.state = 'active';
      return;
    }
    objective.textContent = session.wizardHasAmulet
      ? t('hud.goalRecover')
      : session.carryingAmulet
        ? t('hud.goalEscape')
        : session.depth < MAX_DEPTH
          ? t('hud.goalStairs', { depth: session.depth + 1, total: MAX_DEPTH })
          : t('hud.goalAmulet', { depth: MAX_DEPTH });
    objective.dataset.state = 'active';
  }

  function renderLog(session: GameSession): void {
    const recent = session.messages.slice(-6);
    log.replaceChildren();
    for (const m of recent) {
      const line = document.createElement('div');
      line.className = 'hud-log-line';
      line.textContent = formatMessage(m);
      log.append(line);
    }
    log.scrollTop = log.scrollHeight;
  }

  function setActions(next: HudAction[]): void {
    actionBar.replaceChildren();
    for (const action of next) {
      const button = document.createElement('button');
      button.className = 'btn action';
      button.type = 'button';
      button.append(action.label);
      if (action.key) {
        const badge = document.createElement('kbd');
        badge.textContent = action.key;
        button.append(badge);
      }
      if (action.hint) button.title = action.hint;
      button.dataset.action = action.id;
      button.addEventListener('click', action.onRun);
      actionBar.append(button);
    }
  }

  function render(session: GameSession | null = null): void {
    paintLang();
    paintMute();
    dumpBtn.title = t('hud.dumpHint');
    applyI18n(el);
    if (session) {
      current = session;
      renderStats(session);
      renderObjective(session);
      renderLog(session);
      minimap.update(session);
    }
  }

  // -------------------------------------------------------------------------
  // 状态转储弹窗
  // -------------------------------------------------------------------------

  /** 转储弹窗：只保留一份，关掉即销毁。 */
  let dumpMask: HTMLElement | null = null;
  /** 消息历史弹窗：只保留一份，关掉即销毁。 */
  let historyMask: HTMLElement | null = null;
  /** 最近一次渲染的会话，转储按钮据此取状态。 */
  let current: GameSession | null = null;

  function closeDump(): boolean {
    if (!dumpMask) return false;
    dumpMask.remove();
    dumpMask = null;
    return true;
  }

  /** 打开消息历史：最新的消息排在最上面，每行带回合数。 */
  function openHistory(): void {
    const session = current;
    if (!session || historyMask) return;

    const mask = document.createElement('div');
    mask.className = 'mask history-mask';
    const dialog = document.createElement('div');
    dialog.className = 'dialog history';

    const title = document.createElement('h2');
    title.dataset.i18n = 'history.title';

    const list = document.createElement('div');
    list.className = 'history-list';
    for (const message of [...session.messages].reverse()) {
      const row = document.createElement('div');
      row.className = 'history-row';
      const turn = document.createElement('span');
      turn.className = 'history-turn';
      turn.textContent = String(message.turn);
      row.append(turn, document.createTextNode(formatMessage(message)));
      list.append(row);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn ghost';
    closeBtn.dataset.i18n = 'dump.close';
    closeBtn.addEventListener('click', () => closeHistory());
    dialog.append(title, list, closeBtn);
    mask.append(dialog);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) closeHistory();
    });
    el.append(mask);
    historyMask = mask;
    applyI18n(mask);
    playSfx('open', { gain: 0.6 });
  }

  function closeHistory(): boolean {
    if (!historyMask) return false;
    historyMask.remove();
    historyMask = null;
    playSfx('close', { gain: 0.6 });
    return true;
  }

  function openDump(): void {
    const session = current;
    if (!session || dumpMask) return;
    const text = buildDump(session);

    const mask = document.createElement('div');
    mask.className = 'mask dump-mask';
    const dialog = document.createElement('div');
    dialog.className = 'dialog dump';

    const title = document.createElement('h2');
    title.dataset.i18n = 'dump.title';
    const hint = document.createElement('p');
    hint.className = 'muted dump-hint';
    hint.dataset.i18n = 'dump.hint';

    const area = document.createElement('textarea');
    area.className = 'dump-text';
    area.readOnly = true;
    area.spellcheck = false;
    area.value = text;

    const bar = document.createElement('div');
    bar.className = 'dump-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn primary';
    copyBtn.dataset.i18n = 'dump.copy';
    copyBtn.addEventListener('click', () => {
      void (async () => {
        let copied = true;
        try {
          await navigator.clipboard.writeText(area.value);
        } catch {
          // 非安全上下文里没有剪贴板权限：退化为全选，让玩家手动复制。
          copied = false;
          area.focus();
          area.select();
        }
        if (copied) {
          copyBtn.textContent = t('dump.copied');
          setTimeout(() => {
            copyBtn.textContent = t('dump.copy');
          }, 1200);
        } else {
          hint.textContent = t('dump.selectHint');
        }
      })();
    });
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'btn';
    downloadBtn.dataset.i18n = 'dump.download';
    downloadBtn.addEventListener('click', () => {
      const blob = new Blob([area.value], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = dumpFileName(session);
      link.click();
      URL.revokeObjectURL(url);
    });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn ghost';
    closeBtn.dataset.i18n = 'dump.close';
    closeBtn.addEventListener('click', () => closeDump());
    bar.append(copyBtn, downloadBtn, closeBtn);

    dialog.append(title, hint, area, bar);
    mask.append(dialog);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) closeDump();
    });
    el.append(mask);
    dumpMask = mask;
    applyI18n(mask);
    area.focus();
    area.setSelectionRange(0, 0);
    // focus 后浏览器可能把视口带到文末，显式回到开头，先看到种子与地图。
    area.scrollTop = 0;
  }

  const offLocale = onLocaleChange(() => render());

  return {
    el,
    render,
    setActions,
    setPath: (points) => minimap.setPath(points),
    dumpOpen: () => dumpMask !== null,
    closeDump,
    historyOpen: () => historyMask !== null,
    closeHistory,
    destroy() {
      closeDump();
      closeHistory();
      offLocale();
      el.remove();
    },
  };
}
