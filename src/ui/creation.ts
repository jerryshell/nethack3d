/**
 * 角色创建：选择职业、种族、阵营与性别，可重掷属性并预览初始装备，
 * 确认后进入游戏。
 *
 * 预览由显式种子生成，因此显示出来的角色与最终游玩的角色完全一致。
 */

import type { Alignment, Attributes, CharacterChoice, Gender, ItemInstance } from '../types';
import { t, applyI18n, onLocaleChange } from '../i18n/index';
import { createRng, deriveSeed } from '../core/rng';
import {
  ROLES,
  RACES,
  roleById,
  raceById,
  rollAttributes,
  buildStartingKit,
  validCombinations,
} from '../game/roles';
import { roleDisplayName, raceDisplayName, alignDisplayName } from '../data/i18n';
import { describeItem } from '../game/items';
import { itemName } from './itemName';

const ATTR_KEYS: (keyof Attributes)[] = ['str', 'int', 'wis', 'dex', 'con', 'cha'];

/** 创建界面的回调。`onStart` 收到可直接传给 GameSession 的角色配置。 */
export interface CreationScreenOptions {
  onStart: (options: { seed: number; character: CharacterChoice; attributes: Attributes }) => void;
  onBack?: () => void;
}

/** 创建界面内部状态。 */
interface CreationState {
  seed: number;
  roleId: string;
  raceId: string;
  align: Alignment;
  gender: Gender;
  attributes: Attributes | null;
  kit: ItemInstance[];
}

export function createCreationScreen({ onStart, onBack }: CreationScreenOptions) {
  const el = document.createElement('div');
  el.className = 'mask creation-mask';

  const panel = document.createElement('div');
  panel.className = 'dialog creation';

  const state: CreationState = {
    seed: (Math.random() * 0x7fffffff) | 0,
    roleId: 'VALKYRIE',
    raceId: 'HUMAN',
    align: 'neutral',
    gender: 'female',
    attributes: null,
    kit: [],
  };

  /** 按当前选择重掷属性并生成初始装备预览。 */
  function roll(): void {
    const rng = createRng(deriveSeed(state.seed, 'creation'));
    state.attributes = rollAttributes(roleById[state.roleId], raceById[state.raceId], rng);
    state.kit = buildStartingKit(state.roleId, rng);
  }

  function normalizeSelection(): void {
    const role = roleById[state.roleId];
    if (!role.races.includes(state.raceId)) state.raceId = role.races[0];
    if (!role.aligns.includes(state.align)) state.align = role.aligns[0];
    if (!role.genders.length) state.gender = 'female';
    else if (!role.genders.includes(state.gender)) state.gender = role.genders[0];
    roll();
  }

  function render(): void {
    const role = roleById[state.roleId];
    panel.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = t('creation.title');
    panel.append(title);

    // --- 职业选择 ---
    panel.append(sectionLabel('creation.role'));
    const roleGrid = div('creation-grid');
    for (const r of ROLES) {
      const btn = document.createElement('button');
      btn.className = `chip ${r.id === state.roleId ? 'active' : ''}`;
      btn.textContent = roleDisplayName(r);
      btn.addEventListener('click', () => {
        state.roleId = r.id;
        normalizeSelection();
        render();
      });
      roleGrid.append(btn);
    }
    panel.append(roleGrid);

    // --- 种族选择，按职业过滤 ---
    panel.append(sectionLabel('creation.race'));
    const raceGrid = div('creation-grid');
    for (const r of RACES) {
      const allowed = role.races.includes(r.id);
      const btn = document.createElement('button');
      btn.className = `chip ${r.id === state.raceId ? 'active' : ''}`;
      btn.textContent = raceDisplayName(r);
      btn.disabled = !allowed;
      btn.addEventListener('click', () => {
        state.raceId = r.id;
        normalizeSelection();
        render();
      });
      raceGrid.append(btn);
    }
    panel.append(raceGrid);

    // --- 阵营与性别 ---
    panel.append(sectionLabel('creation.alignment'));
    const alignRow = div('creation-grid');
    for (const a of ['lawful', 'neutral', 'chaotic'] as Alignment[]) {
      const allowed = role.aligns.includes(a);
      const btn = document.createElement('button');
      btn.className = `chip ${a === state.align ? 'active' : ''}`;
      btn.textContent = alignDisplayName(a);
      btn.disabled = !allowed;
      btn.addEventListener('click', () => {
        state.align = a;
        render();
      });
      alignRow.append(btn);
    }
    panel.append(alignRow);

    if (role.genders.length) {
      panel.append(sectionLabel('creation.gender'));
      const genderRow = div('creation-grid');
      for (const g of role.genders) {
        const btn = document.createElement('button');
        btn.className = `chip ${g === state.gender ? 'active' : ''}`;
        btn.textContent = t(`creation.${g}`);
        btn.addEventListener('click', () => {
          state.gender = g;
          render();
        });
        genderRow.append(btn);
      }
      panel.append(genderRow);
    }

    // --- 属性与初始装备预览 ---
    const info = div('creation-info');
    const attrs = div('creation-attrs');
    const rolled = state.attributes as Attributes;
    for (const key of ATTR_KEYS) {
      const cell = document.createElement('div');
      cell.className = 'attr-cell';
      cell.innerHTML = `<span>${t(`attr.${key}`)}</span><strong>${rolled[key]}</strong>`;
      attrs.append(cell);
    }
    const kit = div('creation-kit');
    const kitTitle = document.createElement('div');
    kitTitle.className = 'muted';
    kitTitle.textContent = t('creation.startingKit');
    kit.append(kitTitle);
    for (const item of state.kit) {
      const line = document.createElement('div');
      line.textContent = `· ${itemName(describeItem(item))}`;
      kit.append(line);
    }
    info.append(attrs, kit);
    panel.append(info);

    // --- 操作按钮 ---
    const actions = div('creation-actions');
    const reroll = button('creation.reroll', 'btn', () => {
      state.seed = (Math.random() * 0x7fffffff) | 0;
      roll();
      render();
    });
    const random = button('creation.random', 'btn ghost', () => {
      const combo = validCombinations()[Math.floor(Math.random() * validCombinations().length)];
      state.roleId = combo.role.id;
      state.raceId = combo.race.id;
      state.align = combo.align;
      state.gender = combo.gender;
      state.seed = (Math.random() * 0x7fffffff) | 0;
      normalizeSelection();
      render();
    });
    const back = button('menu.back', 'btn ghost', () => onBack?.());
    const begin = button('creation.begin', 'btn primary', () => {
      onStart?.({
        seed: state.seed,
        character: {
          role: roleById[state.roleId],
          race: raceById[state.raceId],
          align: state.align,
          gender: state.gender,
        },
        attributes: state.attributes as Attributes,
      });
    });
    actions.append(begin, reroll, random, back);
    panel.append(actions);

    applyI18n(panel);
  }

  /** 生成分组标题。 */
  function sectionLabel(key: string): HTMLDivElement {
    const el2 = document.createElement('div');
    el2.className = 'creation-label';
    el2.textContent = t(key);
    return el2;
  }

  /** 生成带类名的容器。 */
  function div(cls: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = cls;
    return d;
  }

  /** 生成使用 i18n 文案的按钮。 */
  function button(key: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = t(key);
    b.addEventListener('click', onClick);
    return b;
  }

  const offLocale = onLocaleChange(render);

  normalizeSelection();
  render();
  el.append(panel);

  return {
    el,
    destroy() {
      offLocale();
      el.remove();
    },
  };
}
