/**
 * 许愿输入框。
 *
 * 使用许愿魔杖或魔法灯后弹出，收集玩家输入的物品名。
 * 提交回调返回 false 表示没匹配到，面板保持打开让玩家重试。
 */

import { t, applyI18n } from '../i18n/index';

export interface WishPanelHandle {
  destroy(): void;
}

export interface WishPanelOptions {
  /** 提交一次愿望；返回 true 表示愿望已兑现，面板应当关闭。 */
  onWish: (text: string) => boolean;
  /** 面板关闭时的回调（取消、兑现或销毁）。 */
  onClose: () => void;
}

/** 在给定容器里创建许愿面板。 */
export function createWishPanel(
  mount: HTMLElement,
  { onWish, onClose }: WishPanelOptions,
): WishPanelHandle {
  const mask = document.createElement('div');
  mask.className = 'mask wish-mask';
  const dialog = document.createElement('div');
  dialog.className = 'dialog wish';

  const title = document.createElement('h2');
  title.dataset.i18n = 'wish.title';
  const hint = document.createElement('p');
  hint.className = 'muted wish-hint';
  hint.dataset.i18n = 'wish.hint';

  const input = document.createElement('input');
  input.className = 'wish-input';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = t('wish.placeholder');

  const bar = document.createElement('div');
  bar.className = 'dump-actions';
  const okBtn = document.createElement('button');
  okBtn.className = 'btn primary';
  okBtn.dataset.i18n = 'wish.confirm';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn ghost';
  cancelBtn.dataset.i18n = 'wish.cancel';

  const handle = {
    destroy(): void {
      mask.remove();
      onClose();
    },
  };

  const submit = (): void => {
    const text = input.value.trim();
    if (!text) return;
    if (onWish(text)) handle.destroy();
    else input.select();
  };
  okBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => handle.destroy());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      handle.destroy();
    }
  });
  mask.addEventListener('click', (event) => {
    if (event.target === mask) handle.destroy();
  });

  dialog.append(title, hint, input, bar);
  bar.append(okBtn, cancelBtn);
  mask.append(dialog);
  mount.append(mask);
  applyI18n(mask);
  input.focus();

  return { destroy: () => handle.destroy() };
}
