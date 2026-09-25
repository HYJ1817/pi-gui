/* 居中模态框。
 *
 * 只有「打开」这一个入口：build(card, close) 负责往卡片里塞内容，
 * 关闭统一走 close()，把卡片清空并把动态容器置空（见 state.js 的 panels）。
 *
 * onClose 会在**任何**关闭路径上触发一次（按钮、点遮罩、Esc），
 * 用于让「等用户答复」的调用方不会因为用户点了遮罩就永远挂着。 */

import { el, panels } from '../state.js';

/* 当前弹层的关闭回调。只可能有一个弹层，所以用单个槽位就够。 */
let closeHook = null;
let modalReturnFocus = null;
let confirmReturnFocus = null;

function focusDialog(card, fallback) {
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.tabIndex = -1;
  (fallback || card.querySelector('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])') || card).focus();
}

function restoreFocus(node) {
  if (node && node.isConnected && typeof node.focus === 'function') node.focus();
}

function trapTab(card, e) {
  if (e.key !== 'Tab') return;
  const items = [...card.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')];
  if (!items.length) {
    e.preventDefault();
    card.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (document.activeElement === card) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function closeModal() {
  const hook = closeHook;
  closeHook = null;

  el.modal.hidden = true;
  el.modalCard.innerHTML = '';
  panels.tree = null;
  panels.providers = null;
  panels.changes = null;
  const returnFocus = modalReturnFocus;
  modalReturnFocus = null;

  if (hook) {
    try {
      hook();
    } catch {
      /* 回调自己炸了不该带塌关闭流程 */
    }
  }
  restoreFocus(returnFocus);
}

export function openModal(build, onClose) {
  if (!el.modal.hidden) closeModal();
  modalReturnFocus = document.activeElement;
  closeHook = null;
  el.modalCard.innerHTML = '';
  // 弹层里的动态区域在关闭时失效，避免继续往已卸载的节点里写
  panels.tree = null;
  panels.providers = null;
  panels.changes = null;

  build(el.modalCard, closeModal);
  el.modal.hidden = false;
  closeHook = typeof onClose === 'function' ? onClose : null;
  focusDialog(el.modalCard);
}

/* 二次确认。
 *
 * 返回 Promise<true | 'alt' | false>；点遮罩 / 未作答就关闭一律算「取消」。
 *
 * 存在价值是把「危险操作必须二次确认」收敛成一个固定形态 ——
 * 撤销文件、删除未跟踪文件、撤销全部都走它，不会各自实现一遍、各自漏掉取消路径。
 *
 * ---------- 为什么它有自己的 DOM 层（#confirmLayer） ----------
 *
 * 因为它**总是盖在别的弹层上面**：最典型的场景是在「文件变更」面板里点撤销，
 * 确认框必须叠在那个面板之上。如果复用 #modal / #modalCard，openModal 会先
 * `innerHTML = ''` 把面板连同已展开的 diff 一起清掉 —— 用户确认完回来发现
 * 面板没了。所以确认单独一层，`closeModal()` 也不碰它。
 *
 * ---------- altText：第三条路径 ----------
 *
 * 有些危险操作不是「做 / 不做」二选一，而是「做到什么程度」。
 * 最典型的是「撤销全部」：工作区里既有被改的旧文件，也有新建的未跟踪文件 ——
 * 「把改动撤了」和「把新文件删了」是两个不同的意愿。只给一个确认按钮，
 * 就是在逼用户把两件事一起接受；分成两个弹窗，用户会在第二个上条件反射地点确认。
 * 所以给一个中间的选项，一次把话说完。
 *
 * 同时只允许存在一个确认框：新的把旧的按「取消」结掉，否则旧 Promise 会永久挂着。 */

let confirmResolve = null;

function closeConfirm(value) {
  const fn = confirmResolve;
  confirmResolve = null;
  el.confirmLayer.hidden = true;
  el.confirmCard.innerHTML = '';
  const returnFocus = confirmReturnFocus;
  confirmReturnFocus = null;
  if (fn) {
    try {
      fn(value);
    } catch {
      /* 调用方自己炸了不该带塌关闭流程 */
    }
  }
  restoreFocus(returnFocus);
}

export function confirmModal({ title, message, okText = '确认', cancelText = '取消', altText = '', danger = false }) {
  if (confirmResolve) closeConfirm(false);

  return new Promise((resolve) => {
    confirmReturnFocus = document.activeElement;
    confirmResolve = resolve;
    el.confirmCard.innerHTML = '';

    const h = document.createElement('h3');
    h.textContent = title;
    el.confirmCard.appendChild(h);

    if (message) {
      const p = document.createElement('div');
      p.className = 'modal-desc';
      p.textContent = message;
      el.confirmCard.appendChild(p);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn';
    no.textContent = cancelText;
    no.onclick = () => closeConfirm(false);
    actions.appendChild(no);

    // 中间那条路径：只有调用方明确要求时才出现
    if (altText) {
      const alt = document.createElement('button');
      alt.type = 'button';
      alt.className = 'btn alt';
      alt.textContent = altText;
      alt.onclick = () => closeConfirm('alt');
      actions.appendChild(alt);
    }

    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn ' + (danger ? 'danger' : 'primary');
    yes.textContent = okText;
    yes.onclick = () => closeConfirm(true);

    actions.appendChild(yes);
    el.confirmCard.appendChild(actions);

    el.confirmLayer.hidden = false;
    focusDialog(el.confirmCard, no);
  });
}

document.addEventListener('keydown', (e) => {
  if (!el.confirmLayer.hidden) {
    trapTab(el.confirmCard, e);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeConfirm(false);
    } else if (e.key === 'Enter') {
      // 危险操作必须显式点击；键盘 Enter 不能误把默认确认按钮按下。
      const dangerous = Boolean(el.confirmCard.querySelector('.btn.danger'));
      if (dangerous) e.preventDefault();
      else if (document.activeElement === el.confirmCard) {
        e.preventDefault();
        el.confirmCard.querySelector('.btn.primary')?.click();
      }
    }
    return;
  }
  if (!el.modal.hidden) trapTab(el.modalCard, e);
  if (e.key === 'Escape' && !el.modal.hidden) {
    e.preventDefault();
    e.stopPropagation();
    closeModal();
  }
}, true);

// 点遮罩关闭
el.modal.addEventListener('click', (e) => {
  if (e.target === el.modal) closeModal();
});

el.confirmLayer.addEventListener('click', (e) => {
  if (e.target === el.confirmLayer) closeConfirm(false);
});
