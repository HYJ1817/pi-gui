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
// A reused card element is not a dialog identity. Async closures own one token.
let modalInstance = null;
let modalReturnFocus = null;
let confirmReturnFocus = null;
/* UI-4B：当前确认框的展示元数据。approval.js 用它判断「屏幕上这张卡还是不是
 * 我那条请求」—— 只按层是否打开判断会把别人的卡片当自己的收掉。 */
let confirmMeta = null;
let modalMeta = null;
/* UI-4B：Esc / 点遮罩的「取消」出口。审批卡有提交过程，取消也必须走同一条
 * 可等待的路径（失败时卡片要留着说明原因），不能绕过 onDecide 直接关。 */
let confirmCancelPath = null;
let modalCancelPath = null;

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
  const items = [...card.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')]
    .filter(item => !item.closest('[hidden]'));
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
  modalInstance = null;

  el.modal.hidden = true;
  el.modalCard.innerHTML = '';
  el.modalCard.className = 'modal-card';
  el.modalCard.removeAttribute('data-surface');
  el.modalCard.removeAttribute('aria-labelledby');
  el.modalCard.removeAttribute('aria-describedby');
  el.modalCard.removeAttribute('aria-busy');
  modalMeta = null;
  modalCancelPath = null;
  panels.tree = null;
  panels.providers = null;
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

export function openModal(build, onClose, options = {}) {
  if (!el.modal.hidden) closeModal();
  const instance = {};
  modalInstance = instance;
  modalReturnFocus = document.activeElement;
  closeHook = null;
  el.modalCard.innerHTML = '';
  el.modalCard.className = 'modal-card' + (options.className ? ' ' + options.className : '');
  if (options.surface) el.modalCard.setAttribute('data-surface', String(options.surface));
  else el.modalCard.removeAttribute('data-surface');
  if (options.labelledBy) el.modalCard.setAttribute('aria-labelledby', String(options.labelledBy));
  else el.modalCard.removeAttribute('aria-labelledby');
  if (options.describedBy) el.modalCard.setAttribute('aria-describedby', String(options.describedBy));
  else el.modalCard.removeAttribute('aria-describedby');
  modalMeta = options.meta && typeof options.meta === 'object' ? { ...options.meta } : null;
  modalCancelPath = typeof options.onCancel === 'function' ? options.onCancel : null;
  // 弹层里的动态区域在关闭时失效，避免继续往已卸载的节点里写
  panels.tree = null;
  panels.providers = null;

  build(el.modalCard, () => { if (modalInstance === instance) closeModal(); });
  if (modalInstance !== instance) return;
  el.modal.hidden = false;
  closeHook = typeof onClose === 'function' ? onClose : null;
  focusDialog(el.modalCard, options.initialFocus);
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

function closeConfirm(value) {
  const fn = confirmResolve;
  confirmResolve = null;
  confirmMeta = null;
  confirmCancelPath = null;
  el.confirmLayer.hidden = true;
  el.confirmCard.innerHTML = '';
  el.confirmCard.className = 'modal-card';
  el.confirmCard.removeAttribute('data-surface');
  el.confirmCard.removeAttribute('aria-labelledby');
  el.confirmCard.removeAttribute('aria-describedby');
  el.confirmCard.removeAttribute('aria-busy');
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

/* 由生命周期方主动撤掉当前确认框（approval 超时 / 桥接重启等）。
 * 语义与用户点「取消」完全一致：Promise 解析成 false。
 * 同时只可能有一个确认框，所以调用方必须先确认那个框是自己的
 * —— approval 的 pending 表保证了这一点：自己那条一旦被别的框顶掉，
 * 它的 Promise 会立刻以 false 结算并从 pending 移除。 */
export function dismissConfirm() {
  if (confirmResolve) closeConfirm(false);
}

/** 当前确认框的展示身份（只读副本）。没有打开时为 null。
 *  approval.js 用它做「这张卡还是不是我那条请求」的判据，而不是只看层是否可见。 */
export function confirmSurfaceMeta() {
  return confirmMeta ? { ...confirmMeta } : null;
}

/** 当前普通弹层的展示身份（只读副本）。没有打开时为 null。 */
export function modalSurfaceMeta() {
  return modalMeta ? { ...modalMeta } : null;
}

/* 结构化正文：只吃调用方给的纯数据，全部走 textContent。
 * 这是给审批卡片用的展示扩展 —— 不解析、不执行、不猜语义。 */
function appendDetails(card, details) {
  if (!Array.isArray(details) || !details.length) return;
  const box = document.createElement('div');
  box.className = 'ui4-confirm-details';
  for (const item of details) {
    if (!item || typeof item.text !== 'string' || !item.text) continue;
    const row = document.createElement('div');
    row.className = 'ui4-confirm-detail';
    if (item.mono) row.classList.add('is-mono');
    if (item.label) {
      const label = document.createElement('div');
      label.className = 'ui4-confirm-detail-label';
      label.textContent = String(item.label);
      row.appendChild(label);
    }
    const value = document.createElement('div');
    value.className = 'ui4-confirm-detail-text';
    value.textContent = item.text;
    row.appendChild(value);
    box.appendChild(row);
  }
  if (box.childElementCount) card.appendChild(box);
}

/**
 * 二次确认。
 *
 * 返回 Promise<true | 'alt' | false>；点遮罩 / 未作答就关闭一律算「取消」。
 *
 * ---------- UI-4B 的增量（全部可选，不改既有调用语义） ----------
 *
 * · `source` / `kindLabel` / `context` / `details`：展示真实请求内容的结构化正文；
 * · `surface` / `meta`：让生命周期方认领「屏幕上这张卡是不是我那条」；
 * · `onDecide`：点击后先执行一次提交，只有它明确成功才关闭。没有它时行为
 *   与旧版完全一致（点击即关闭）。
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

export function confirmModal({
  title,
  message,
  okText = '确认',
  cancelText = '取消',
  altText = '',
  deferText = '',
  danger = false,
  source = '',
  kindLabel = '',
  context = '',
  details = [],
  risk = '',
  surface = '',
  meta = null,
  onDecide = null,
  onDefer = null,
  submittingText = '正在发送…',
  failureText = '发送失败，请重试。',
}) {
  if (confirmResolve) closeConfirm(false);

  return new Promise((resolve) => {
    confirmReturnFocus = document.activeElement;
    confirmResolve = resolve;
    confirmMeta = meta && typeof meta === 'object' ? { ...meta } : null;
    el.confirmCard.innerHTML = '';
    el.confirmCard.className = 'modal-card';
    el.confirmCard.removeAttribute('aria-busy');
    if (surface) el.confirmCard.setAttribute('data-surface', String(surface));
    else el.confirmCard.removeAttribute('data-surface');

    const h = document.createElement('h3');
    h.id = 'ui4ConfirmTitle';
    h.textContent = title;
    el.confirmCard.appendChild(h);

    if (source || kindLabel) {
      const src = document.createElement('div');
      src.className = 'ui4-confirm-source';
      src.textContent = [source, kindLabel].filter(Boolean).join(' · ');
      el.confirmCard.appendChild(src);
    }

    if (message) {
      const p = document.createElement('div');
      p.className = 'modal-desc';
      p.id = 'ui4ConfirmMessage';
      p.textContent = message;
      el.confirmCard.appendChild(p);
    }

    appendDetails(el.confirmCard, details);

    if (risk) {
      /* 风险说明只显示调用方给的**事实**（「协议未提供结构化风险信息」）。
       * 这一层不判断危险与否，也不根据自然语言猜等级。 */
      const rk = document.createElement('div');
      rk.className = 'ui4-confirm-risk';
      rk.id = 'ui4ConfirmRisk';
      rk.textContent = risk;
      el.confirmCard.appendChild(rk);
    }

    if (context) {
      const ctx = document.createElement('div');
      ctx.className = 'ui4-confirm-context';
      ctx.id = 'ui4ConfirmContext';
      ctx.textContent = context;
      el.confirmCard.appendChild(ctx);
    }

    /* 状态行：默认不占位。提交中 / 失败时才出现，并作为 aria-describedby
     * 的一部分被读屏软件读出来。 */
    const status = document.createElement('div');
    status.className = 'ui4-confirm-status';
    status.id = 'ui4ConfirmStatus';
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    el.confirmCard.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    /* 键盘提示：只描述真实存在的键位，不承诺协议没有的能力。
     * 屏幕阅读器不会读纯视觉提示，所以 aria-hidden；同一信息在按钮文字里。
     * 只放在审批卡片上（surface 由 approval.js 指定），不改动其它确认框的
     * 既有排版 —— 那些框有自己的既有测试与截图基线。 */
    if (surface === 'approval') {
      const hint = document.createElement('div');
      hint.className = 'ui4-confirm-hint';
      hint.setAttribute('aria-hidden', 'true');
      hint.textContent = 'Esc 取消 · Tab 在按钮间移动 · Enter 不会替你允许';
      actions.appendChild(hint);
    }

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn';
    no.textContent = cancelText;
    actions.appendChild(no);

    // 中间那条路径：只有调用方明确要求时才出现
    let alt = null;
    if (altText) {
      alt = document.createElement('button');
      alt.type = 'button';
      alt.className = 'btn alt';
      alt.textContent = altText;
      actions.appendChild(alt);
    }

    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn ' + (danger ? 'danger' : 'primary');
    yes.textContent = okText;
    actions.appendChild(yes);

    /* 延期不是一次决定：它只收起当前卡片，请求仍由调用方保留。
     * 该按钮必须和拒绝/允许同属忙碌集合，否则提交期间仍能切走，
     * 留下一条无法从当前界面判断投递结果的审批。 */
    let defer = null;
    if (deferText && typeof onDefer === 'function') {
      defer = document.createElement('button');
      defer.type = 'button';
      defer.className = 'btn';
      defer.textContent = deferText;
      actions.appendChild(defer);
    }
    el.confirmCard.appendChild(actions);

    const allButtons = () => [no, alt, yes, defer].filter(Boolean);

    /* 提交中：所有出口暂时关闭。这不是「禁用危险操作」，而是防止同一次决定
     * 被发两遍、以及提交途中 Esc 把一次已发出的允许再补一条取消。 */
    let busy = false;
    let settled = false;

    function setBusy(on, text = '') {
      busy = on;
      el.confirmCard.setAttribute('aria-busy', on ? 'true' : 'false');
      for (const b of allButtons()) b.disabled = on;
      if (on) {
        status.hidden = false;
        status.dataset.state = 'pending';
        status.textContent = text || submittingText;
      }
    }

    function showFailure(text) {
      status.hidden = false;
      status.dataset.state = 'error';
      status.textContent = text || failureText;
    }

    /* Esc / 点遮罩的取消出口。审批卡（有 onDecide）必须走它，否则「取消」
     * 在投递失败时会被直接关掉，用户看不到「Pi 仍在等待」。
     * 传 'cancel' 而不是 false：协议里 confirmed:false 是「明确拒绝」，
     * 关闭 / Esc 是「取消」—— 两者在 Pi 侧都 fail-closed，但语义不同。 */
    confirmCancelPath = typeof onDecide === 'function' ? () => decide('cancel', no) : null;

    async function decide(answer, button) {
      if (confirmResolve !== resolve || busy || settled) return;
      if (typeof onDecide !== 'function') {
        settled = true;
        closeConfirm(answer);
        return;
      }
      setBusy(true);
      let outcome;
      try {
        outcome = await onDecide(answer);
      } catch (err) {
        outcome = { ok: false, error: err && err.message ? err.message : String(err || '') };
      }
      /* 提交期间卡片可能被生命周期收掉（Stop / 工作区切换 / 超时）。
       * 这时**不能**再碰已经清空的 DOM，也不能二次结算。 */
      if (confirmResolve !== resolve || settled || el.confirmLayer.hidden) return;
      if (outcome === true || outcome?.ok === true) {
        settled = true;
        closeConfirm(answer);
        return;
      }
      /* 失败：保持这张卡、保留用户已经做出的选择，重新允许点击。
       * 不自动重发 —— 重试必须是用户的下一次明确点击。 */
      setBusy(false);
      showFailure(outcome?.error || failureText);
      if (outcome?.uncertain === true) {
        settled = true;
        for (const b of allButtons()) b.disabled = true;
        status.dataset.state = 'unknown';
        const close = document.createElement('button');
        close.type = 'button'; close.className = 'btn'; close.textContent = '关闭提示';
        close.onclick = () => { if (confirmResolve === resolve) closeConfirm(false); };
        actions.append(close);
        confirmCancelPath = close.onclick;
        const hint = actions.querySelector('.ui4-confirm-hint');
        if (hint) hint.textContent = 'Esc 仅关闭提示 · 不会重发或撤回决定';
        close.focus();
        return;
      }
      (button || no).focus();
    }

    no.onclick = () => decide(false, no);
    if (alt) alt.onclick = () => decide('alt', alt);
    yes.onclick = () => decide(true, yes);
    if (defer) defer.onclick = () => {
      if (confirmResolve !== resolve || busy || settled) return;
      onDefer();
    };

    el.confirmLayer.hidden = false;
    el.confirmCard.setAttribute('aria-labelledby', h.id);
    el.confirmCard.setAttribute('aria-describedby', [message ? 'ui4ConfirmMessage' : '', risk ? 'ui4ConfirmRisk' : '', context ? 'ui4ConfirmContext' : '', 'ui4ConfirmStatus'].filter(Boolean).join(' '));
    focusDialog(el.confirmCard, no);
  });
}

document.addEventListener('keydown', (e) => {
  if (!el.confirmLayer.hidden) {
    trapTab(el.confirmCard, e);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      /* 提交中不响应 Esc：这时决定已经发出去了，再补一条取消只会制造
       * 「允许 + 取消」两条互相矛盾的应答。 */
      if (el.confirmCard.getAttribute('aria-busy') === 'true') return;
      if (confirmCancelPath) confirmCancelPath();
      else closeConfirm(false);
    } else if (e.key === 'Enter') {
      // 危险操作必须显式点击；键盘 Enter 不能误把默认确认按钮按下。
      // 审批同样如此（enterBlocked）：焦点落在卡片本身时按 Enter，
      // 不能变成一次「允许」。提交中同理，不提供任何隐式重复提交。
      const dangerous = Boolean(el.confirmCard.querySelector('.btn.danger')) || confirmMeta?.enterBlocked === true;
      if (dangerous || el.confirmCard.getAttribute('aria-busy') === 'true') e.preventDefault();
      else if (document.activeElement === el.confirmCard) {
        e.preventDefault();
        el.confirmCard.querySelector('.btn.primary')?.click();
      }
    }
    return;
  }
  // A dialog action menu owns its keyboard event until it closes.
  if (!el.modal.hidden && document.querySelector('#actionMenu') && el.modal.contains(document.querySelector('[aria-controls="actionMenu"][aria-expanded="true"]'))) return;
  if (!el.modal.hidden) trapTab(el.modalCard, e);
  if (e.key === 'Escape' && !el.modal.hidden) {
    e.preventDefault();
    e.stopPropagation();
    /* 提交中不关：决定已经发出，界面必须留着承接结果（成功关闭 / 失败重试）。 */
    if (el.modalCard.getAttribute('aria-busy') === 'true') return;
    if (modalCancelPath) modalCancelPath();
    else closeModal();
  }
}, true);

// 点遮罩关闭
el.modal.addEventListener('click', (e) => {
  if (e.target !== el.modal || el.modalCard.getAttribute('aria-busy') === 'true') return;
  if (modalCancelPath) modalCancelPath();
  else closeModal();
});

el.confirmLayer.addEventListener('click', (e) => {
  if (e.target !== el.confirmLayer || el.confirmCard.getAttribute('aria-busy') === 'true') return;
  if (confirmCancelPath) confirmCancelPath();
  else closeConfirm(false);
});
