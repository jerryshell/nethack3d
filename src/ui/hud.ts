/**
 * 游戏内 HUD：状态栏、目标提示、情境操作、消息日志与语言切换按钮。
 *
 * 消息变量里保存的是实体 ID（mon、obj、roleId、raceId），
 * 在这里解析成当前语言的名称，因此切换语言后历史消息也会重新翻译。
 *
 * 面向不熟悉 roguelike 的玩家，这里刻意做了两件事：
 * 常驻显示当前目标；把此刻可做的操作做成按钮，不必先背下按键。
 */

import type { GameMessage, ItemDescription } from '../types';
import type { GameSession } from '../game/session';
import { MAX_DEPTH } from '../game/session';
import { t, applyI18n, onLocaleChange, setLocale, nextLocale, LOCALES } from '../i18n/index';
import { monsterName, objectName } from '../data/index';
import { itemName } from './itemName';
import { roleDisplayName, raceDisplayName, alignDisplayName } from '../data/i18n';
import { isMuted, setMuted } from '../core/audio';

/** 把消息变量里的实体 ID 解析成当前语言的可读名称。 */
function resolveVars(vars: GameMessage['vars']): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(vars ?? {})) {
    if (key === 'mon') out.mon = monsterName(value as string);
    else if (key === 'item' && value && typeof value === 'object')
      out.item = itemName(value as ItemDescription);
    else if (key === 'obj') out.obj = value ? objectName(value as string) : '';
    else if (key === 'roleId') out.role = roleDisplayName(value as string);
    else if (key === 'raceId') out.race = raceDisplayName(value as string);
    else if (key === 'trap') out.trap = t(value as string);
    else if (key === 'align')
      out.align = alignDisplayName(value as Parameters<typeof alignDisplayName>[0]);
    else out[key] = value as string | number;
  }
  return out;
}

/** 渲染一条会话消息；导出以便测试。 */
export function formatMessage(message: GameMessage): string {
  return t(message.key, resolveVars(message.vars));
}

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
export interface HudOptions {
  onExit?: () => void;
}

/** HUD 句柄：DOM 元素、渲染入口与销毁方法。 */
export interface HudHandle {
  el: HTMLElement;
  render(session?: GameSession | null): void;
  /** 更新情境操作按钮。 */
  setActions(actions: HudAction[]): void;
  destroy(): void;
}

/** 饱食度低于此值时给出提示，对应原版的 Hungry 状态。 */
const HUNGER_WARN = 150;
const HUNGER_DANGER = 40;

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

  const exitBtn = document.createElement('button');
  exitBtn.className = 'btn ghost small';
  exitBtn.dataset.i18n = 'menu.back';
  exitBtn.addEventListener('click', () => onExit?.());

  actions.append(langBtn, muteBtn, exitBtn);
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

  el.append(top, center, log, help);
  applyI18n(el);

  /** 状态格：小号标签加数值，数值用等宽数字避免跳动。 */
  function statCell(
    key: string,
    labelKey: string,
    vars: Record<string, string | number>,
  ): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'hud-stat';
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
    cell.textContent = t(hunger < HUNGER_DANGER ? 'hud.hungerFaint' : 'hud.hungerHungry');
    return cell;
  }

  function renderStats(session: GameSession): void {
    const s = session.status;
    stats.replaceChildren();
    stats.append(
      statCell('hud.depth', 'hud.depthLabel', { depth: s.depth }),
      hpCell(session),
      statCell('hud.levelXp', 'hud.levelXpLabel', { level: s.level, xp: s.xp, next: s.nextXp }),
      statCell('hud.power', 'hud.powerLabel', { pw: s.pw, max: s.maxPw }),
      statCell('hud.armorClass', 'hud.armorClassLabel', { ac: s.ac }),
      statCell('hud.gold', 'hud.goldLabel', { gold: s.gold }),
      statCell('hud.turn', 'hud.turnLabel', { turn: s.turn }),
    );
    const hunger = hungerCell(session);
    if (hunger) stats.append(hunger);
  }

  function renderObjective(session: GameSession): void {
    if (session.victory) {
      objective.textContent = t('hud.goalDone');
      objective.dataset.state = 'done';
      return;
    }
    objective.textContent =
      session.depth < MAX_DEPTH
        ? t('hud.goalStairs', { depth: session.depth + 1, total: MAX_DEPTH })
        : t('hud.goalAmulet');
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
    applyI18n(el);
    if (session) {
      renderStats(session);
      renderObjective(session);
      renderLog(session);
    }
  }

  const offLocale = onLocaleChange(() => render());

  return {
    el,
    render,
    setActions,
    destroy() {
      offLocale();
      el.remove();
    },
  };
}
