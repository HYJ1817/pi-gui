/* 居中模态框。
 *
 * 只有「打开」这一个入口：build(card, close) 负责往卡片里塞内容，
 * 关闭统一走 close()，把卡片清空并把动态容器置空（见 state.js 的 panels）。 */

import { el, panels } from '../state.js';

export function closeModal() {
  el.modal.hidden = true;
  el.modalCard.innerHTML = '';
  panels.tree = null;
  panels.providers = null;
}

export function openModal(build) {
  el.modalCard.innerHTML = '';
  // 弹层里的动态区域在关闭时失效，避免继续往已卸载的节点里写
  panels.tree = null;
  panels.providers = null;

  build(el.modalCard, closeModal);
  el.modal.hidden = false;
}

// 点遮罩关闭
el.modal.addEventListener('click', (e) => {
  if (e.target === el.modal) closeModal();
});
