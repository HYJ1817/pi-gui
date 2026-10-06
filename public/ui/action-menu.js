/* 侧栏动作菜单（P24 收口）—— 项目行与会话行共用的**一套**浮层。
 *
 * ---------- 为什么新开一个模块，而不是复用 composer 的 popover ----------
 *
 * `ui/popover.js` 是 composer 的：单例、默认向上定位、role 语义是「选择器」。
 * 硬复用它会把「输入框上方的选择器」和「侧栏行的动作菜单」搅成一件事。
 * 这里只要一件小而清楚的事：**锚定一个 trigger 的动作菜单**。
 *
 * ---------- 它保证什么 ----------
 *
 *   - **同时最多一个**菜单（开新的会先关旧的）；
 *   - 锚在 trigger 上：优先出现在 trigger **下方、右对齐**；视口放不下就向上翻转，
 *     两边都放不下就夹在视口内 —— **绝不超出屏幕**；
 *   - 挂在 `document.body` 上（`position:fixed`）：**不会被侧栏的 overflow 裁掉**，
 *     也不会被会话区盖住（z-index 在弹层之下、正文之上）；
 *   - 键盘：ArrowUp / ArrowDown / Home / End 导航，Enter / Space 执行，
 *     Escape 关闭并**把焦点还给 trigger**；
 *   - 点菜单外、窗口 resize、任何滚动 → 关闭；
 *   - 语义：容器 `role="menu"`，每一项 `role="menuitem"`，分隔线 `role="separator"`；
 *     trigger 上打 `aria-haspopup="menu"` 与 `aria-expanded`。
 *
 * ---------- items 的形态 ----------
 *
 *   { label, icon, danger, disabled, disabledReason, onClick }
 *   { separator: true }
 *
 * `icon` 是**常量 SVG 字符串**（见 `MENU_ICONS`）；这里不做任何 URL / 用户数据
 * 拼接，`textContent` 一律走赋值。空项与首尾 / 连续分隔线会被丢掉。
 */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 细线单色图标（16px，`currentColor`）。**都是自己写的 path**，不复制任何产品资产。 */
const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
export const MENU_ICONS = Object.freeze({
  /* 铅笔：项目设置 / 重命名 */
  pencil: `<svg ${SVG_ATTRS}><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 5.5l3 3"/></svg>`,
  /* 垃圾桶：移除 / 删除 */
  trash: `<svg ${SVG_ATTRS}><path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/></svg>`,
  /* 归档：向下的方框箭头 */
  archive: `<svg ${SVG_ATTRS}><path d="M3.5 5h17v4h-17z"/><path d="M5.5 9v9.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M12 11.5v4.5"/><path d="M9.8 14l2.2 2.2L14.2 14"/></svg>`,
  /* 取消归档：向上的方框箭头 */
  restore: `<svg ${SVG_ATTRS}><path d="M3.5 5h17v4h-17z"/><path d="M5.5 9v9.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M12 16v-4.5"/><path d="M9.8 13.5l2.2-2.2 2.2 2.2"/></svg>`,
});

const MENU_ID = 'actionMenu';
const GAP = 6;
const MARGIN = 8;

let openState = null; // { menu, anchor, returnFocus, listeners }

function menuItems(menu) {
  return [...menu.querySelectorAll('[role="menuitem"]')].filter((n) => !n.disabled);
}

function onKeydown(event) {
  if (!openState) return;
  const { menu } = openState;
  const inside = menu.contains(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeActionMenu({ restoreFocus: true });
    return;
  }
  if (!inside) return;
  const items = menuItems(menu);
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
    items[next].focus();
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    (event.key === 'Home' ? items[0] : items[items.length - 1]).focus();
    return;
  }
  /* Enter / Space 在真实浏览器里由 button 自己变成 click；jsdom 与合成事件不会，
   * 所以显式执行一次，语义与真实按钮一致。 */
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    document.activeElement.click();
    return;
  }
  if (event.key === 'Tab') {
    /* 菜单是浮层，Tab 出去等于离开它 —— 直接收起，焦点交给浏览器按 DOM 继续走。 */
    const dialogMenu = Boolean(openState.anchor.closest('.modal'));
    if (dialogMenu) event.preventDefault();
    closeActionMenu({ restoreFocus: dialogMenu });
  }
}

function onDocMouseDown(event) {
  if (!openState) return;
  const { menu, anchor } = openState;
  if (menu.contains(event.target) || anchor.contains(event.target)) return;
  closeActionMenu({ restoreFocus: false });
}

function onScroll(event) {
  if (!openState) return;
  /* 菜单自己滚动不算「页面动了」；其它任何容器滚动都会让固定定位看起来跑偏，
   * 所以直接收起 —— 比起「浮在半空对不上锚点」，收起是更诚实的表现。 */
  if (openState.menu.contains(event.target)) return;
  closeActionMenu({ restoreFocus: false });
}

function onResize() {
  if (openState) closeActionMenu({ restoreFocus: false });
}

/** 把菜单放进视口：优先锚点下方右对齐，放不下就向上翻转，再夹紧。 */
function position(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const width = box.width;
  const height = box.height;
  const vw = document.documentElement.clientWidth || window.innerWidth || width;
  const vh = document.documentElement.clientHeight || window.innerHeight || height;

  let left = rect.right - width;
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - width - MARGIN));

  let top = rect.bottom + GAP;
  if (top + height > vh - MARGIN) {
    const flipped = rect.top - GAP - height;
    top = flipped >= MARGIN ? flipped : Math.max(MARGIN, vh - height - MARGIN);
  }
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}

/**
 * 打开一个动作菜单。
 * @param anchor 触发元素（会被打上 aria-haspopup / aria-expanded）
 * @param items  见文件头的形态说明
 * @returns {{close: Function}|null} 没有可显示的项时返回 null（**不画空菜单**）
 */
export function openActionMenu(anchor, items = []) {
  const list = (Array.isArray(items) ? items : [])
    .filter((item) => item && (item.separator === true || (typeof item.label === 'string' && item.label)))
    .filter((item, index, all) => !(item.separator === true
      && (index === 0 || index === all.length - 1 || all[index - 1]?.separator === true)));
  if (!anchor || !list.length) {
    closeActionMenu({ restoreFocus: false });
    return null;
  }
  /* 同一个 trigger 再点一次 = 收起（toggle 语义）。 */
  if (openState && openState.anchor === anchor) {
    closeActionMenu({ restoreFocus: false });
    return null;
  }
  closeActionMenu({ restoreFocus: false });

  const menu = el('div', 'action-menu');
  menu.id = MENU_ID;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', anchor.getAttribute('aria-label') || '操作');
  menu.hidden = false;
  const reasons = [...new Set(list.filter((item) => item.disabled && typeof item.disabledReason === 'string' && item.disabledReason)
    .map((item) => item.disabledReason))];
  const noteId = MENU_ID + 'Note';

  for (const item of list) {
    if (item.separator === true) {
      const sep = el('div', 'action-menu-sep');
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }
    const button = el('button', 'action-menu-item' + (item.danger ? ' danger' : ''));
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    if (item.disabled) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      if (typeof item.disabledReason === 'string' && item.disabledReason) {
        button.title = item.disabledReason;
        button.setAttribute('aria-describedby', noteId);
      }
    }
    if (typeof item.icon === 'string' && item.icon) {
      const icon = el('span', 'action-menu-ic');
      /* 常量 SVG 模板，不含任何用户数据。 */
      icon.innerHTML = item.icon;
      button.appendChild(icon);
    }
    button.appendChild(el('span', 'action-menu-label', item.label));
    button.onclick = () => {
      if (button.disabled) return;
      closeActionMenu({ restoreFocus: true });
      if (typeof item.onClick === 'function') item.onClick();
    };
    menu.appendChild(button);
  }
  if (reasons.length) {
    const note = el('div', 'action-menu-note', reasons.join(' '));
    note.id = noteId;
    note.setAttribute('role', 'note');
    menu.appendChild(note);
  }

  /* 先挂上去再量尺寸（`visibility:hidden` 下仍然可以量到真实宽高）。 */
  menu.style.visibility = 'hidden';
  (anchor.closest('.modal') || document.body).appendChild(menu);
  position(menu, anchor);
  menu.style.visibility = '';

  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', MENU_ID);

  const listeners = { keydown: onKeydown, mousedown: onDocMouseDown, scroll: onScroll, resize: onResize };
  document.addEventListener('keydown', listeners.keydown, true);
  document.addEventListener('mousedown', listeners.mousedown, true);
  document.addEventListener('scroll', listeners.scroll, true);
  window.addEventListener('resize', listeners.resize);

  openState = { menu, anchor, listeners };

  const first = menuItems(menu)[0];
  if (first) first.focus();
  return { close: () => closeActionMenu({ restoreFocus: false }) };
}

/**
 * 关闭当前菜单（没有就什么都不做）。
 * @param restoreFocus true 时把焦点还给 trigger（Escape 那条路走它）
 */
export function closeActionMenu({ restoreFocus = false } = {}) {
  if (!openState) return;
  const { menu, anchor, listeners } = openState;
  openState = null;
  document.removeEventListener('keydown', listeners.keydown, true);
  document.removeEventListener('mousedown', listeners.mousedown, true);
  document.removeEventListener('scroll', listeners.scroll, true);
  window.removeEventListener('resize', listeners.resize);
  if (anchor && anchor.isConnected) anchor.setAttribute('aria-expanded', 'false');
  if (menu && menu.isConnected) menu.remove();
  if (restoreFocus && anchor && anchor.isConnected && typeof anchor.focus === 'function') anchor.focus();
}

/** 当前有没有菜单开着（测试与调用方用）。 */
export function actionMenuOpen() {
  return Boolean(openState);
}
