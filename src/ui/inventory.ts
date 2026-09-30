/**
 * 背包面板。
 *
 * 用字母列出背包内容，同时充当选择器：有待执行的动作时，
 * 面板提示按字母选择，并把选中的物品回传给调用方。
 */

import type { ItemInstance } from '../types';
import type { GameSession } from '../game/session';
import { t, onLocaleChange, applyI18n } from '../i18n/index';
import { describeItem } from '../game/items';
import { itemName, itemSuffix } from './itemName';
import { letterToIndex } from '../game/inventory';
import { ARTIFACT_INVOKES } from '../game/artifacts';
import { createLogger, LOG_NS } from '../core/log';
import { containerHasRoom, isContainer } from '../game/containers';

const log = createLogger(LOG_NS.ui);

const VERB_TITLE = {
  wield: 'verb.wield',
  wear: 'verb.wear',
  remove: 'verb.remove',
  drop: 'verb.drop',
  quaff: 'verb.quaff',
  eat: 'verb.eat',
  read: 'verb.read',
  zap: 'verb.zap',
  apply: 'verb.apply',
  throw: 'verb.throw',
  fire: 'verb.fire',
  put: 'verb.put',
  open: 'verb.open',
  invoke: 'verb.invoke',
  view: 'verb.view',
};

/** 各动作对应的快捷键，显示在按钮上帮助键盘玩家建立对应关系。 */
const VERB_KEY_HINTS: Record<string, string> = {
  wield: 'w',
  wear: 'W',
  remove: 'T',
  quaff: 'q',
  eat: 'e',
  read: 'r',
  zap: 'z',
  apply: 'a',
  throw: 't',
  fire: 'f',
  put: 'P',
  open: 'o',
  drop: 'd',
  view: '',
};

/** 某件物品可用的动作，与原版提示一致。 */
function verbsFor(item: ItemInstance, session?: GameSession): string[] {
  const cls = item.proto.cls;
  const verbs: string[] = [];
  // 容器只能打开；普通物品在背包里有空容器时可以放进去。
  if (isContainer(item)) {
    verbs.push('open');
  } else if (
    session &&
    session.player.inventory.some((it) => it !== item && containerHasRoom(it))
  ) {
    verbs.push('put');
  }
  if (cls === 'weapon') {
    verbs.push('wield');
    verbs.push('throw');
  }
  if (cls === 'gem' || cls === 'food') verbs.push('throw');
  if (cls === 'weapon' && item.proto.kind === 'PROJECTILE') verbs.push('fire');
  if (cls === 'armor' || cls === 'ring' || cls === 'amulet') verbs.push('wear');
  if (cls === 'potion') verbs.push('quaff');
  if (cls === 'scroll') verbs.push('read');
  // 法术书：学过的可以施展，没学过的先研读。
  if (cls === 'spellbook') verbs.push(item.known ? 'cast' : 'read');
  if (cls === 'food') verbs.push('eat');
  if (cls === 'wand') verbs.push('zap');
  if (cls === 'tool') {
    // 可启动的神器只给「启动」，避免多一个无效果的「使用」。
    if (!(item.artifact && ARTIFACT_INVOKES.has(item.artifact))) verbs.push('apply');
  }
  // 能启动的神器额外给出启动动作。
  if (item.artifact && ARTIFACT_INVOKES.has(item.artifact)) verbs.push('invoke');
  return verbs;
}

/** 背包面板的回调。 */
interface InventoryPanelOptions {
  session: GameSession;
  onClose?: () => void;
  /** verb 为 null 表示按物品类别的默认操作。 */
  onChoose?: (verb: string | null, item: ItemInstance) => void;
}

/** 背包面板句柄。 */
export interface InventoryPanelHandle {
  el: HTMLElement;
  /** 切换到某个动作的挑选模式；传 null 回到浏览模式。 */
  setVerb(verb: string | null): void;
  render(): void;
  destroy(): void;
}

export function createInventoryPanel({
  session,
  onClose,
  onChoose,
}: InventoryPanelOptions): InventoryPanelHandle {
  const el = document.createElement('div');
  el.className = 'mask inventory-mask';

  const panel = document.createElement('div');
  panel.className = 'dialog inventory';

  const title = document.createElement('h2');
  const list = document.createElement('div');
  list.className = 'inv-list';
  const hint = document.createElement('div');
  hint.className = 'inv-hint';
  hint.dataset.i18n = 'inventory.hint';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn small';
  closeBtn.dataset.i18n = 'menu.close';
  closeBtn.addEventListener('click', () => onClose?.());

  panel.append(title, list, hint, closeBtn);
  el.append(panel);

  let mode: 'view' | 'select' = 'view';
  let pendingVerb: string | null = null;
  /** 展开动作菜单的物品；null 表示没有展开。 */
  let expanded: ItemInstance | null = null;

  /** 一件物品的动作按钮：按类别给出可用动作，并标出快捷键。 */
  function buildActions(item: ItemInstance): HTMLElement {
    const row = document.createElement('div');
    row.className = 'inv-actions';
    const verbs = [...verbsFor(item, session), 'drop'];
    for (const verb of verbs) {
      const button = document.createElement('button');
      button.className = 'btn tiny';
      button.type = 'button';
      const label = t(`verbAction.${verb}`);
      const key = VERB_KEY_HINTS[verb] ?? '';
      if (key) {
        const badge = document.createElement('kbd');
        badge.textContent = key;
        button.append(label, badge);
      } else {
        button.textContent = label;
      }
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        log.debug('动作菜单选择', { verb });
        onChoose?.(verb, item);
      });
      row.append(button);
    }
    return row;
  }

  function render(): void {
    title.textContent = t(VERB_TITLE[(pendingVerb ?? 'view') as keyof typeof VERB_TITLE]);
    list.innerHTML = '';
    const entries = session.inventoryLetters();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'inv-empty';
      empty.textContent = t('inventory.empty');
      list.append(empty);
    }
    for (const { item, letter } of entries) {
      const row = document.createElement('button');
      row.className = 'inv-row';
      const equipped = session.equipped(item);
      const name = itemName(describeItem(item));
      const suffixes = [t(`item.class.${item.proto.cls}`)];
      row.innerHTML = '';
      const letterEl = document.createElement('span');
      letterEl.className = 'inv-letter';
      letterEl.textContent = `${letter})`;
      const nameEl = document.createElement('span');
      nameEl.className = 'inv-name';
      nameEl.textContent = name + itemSuffix(item, { equipped });
      const classEl = document.createElement('span');
      classEl.className = 'inv-class';
      classEl.textContent = suffixes.join(' · ');
      row.append(letterEl, nameEl, classEl);
      const isExpanded = expanded === item;
      if (isExpanded) row.classList.add('expanded');
      row.addEventListener('click', () => {
        // 浏览模式下点击展开动作菜单，让可用动作一目了然；
        // 键盘仍可沿用字母直接执行默认动作。
        if (mode === 'view') {
          expanded = isExpanded ? null : item;
          render();
          return;
        }
        choose(letter);
      });
      list.append(row);
      if (isExpanded) list.append(buildActions(item));
    }
    applyI18n(el);
  }

  function choose(letter: string): void {
    const idx = letterToIndex(letter);
    const item = idx >= 0 ? session.player.inventory[idx] : null;
    if (!item) return;
    if (mode === 'view') {
      const verbs = verbsFor(item, session);
      if (verbs.length) {
        onChoose?.(verbs[0], item);
      } else {
        onChoose?.(null, item);
      }
    } else {
      log.debug('挑选模式确认物品', { letter, verb: pendingVerb });
      onChoose?.(pendingVerb, item);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      // 先收起展开的菜单，再关闭面板。
      if (expanded) {
        expanded = null;
        render();
        return;
      }
      onClose?.();
      return;
    }
    if (/^[a-zA-Z]$/.test(e.key)) {
      e.preventDefault();
      choose(e.key);
    }
  }
  window.addEventListener('keydown', onKeyDown);
  const offLocale = onLocaleChange(render);

  render();

  return {
    el,
    setVerb(verb: string | null): void {
      pendingVerb = verb;
      mode = verb ? 'select' : 'view';
      render();
    },
    render,
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      offLocale();
      el.remove();
    },
  };
}
