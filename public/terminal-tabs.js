/* Tab bar, empty state and inline notice for the multi-terminal surface.
 *
 * Kept free of PTY/transport state: the panel owns sessions and tells this
 * module what to render. Tabs use the ARIA tabs pattern; the close control is
 * a separate button so a tab is not a button-inside-a-button.
 */

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const button = (className, text) => {
  const element = node('button', className, text);
  element.type = 'button';
  return element;
};

const STATE_TEXT = {
  creating: '正在启动',
  running: '运行中',
  closing: '正在停止',
  stopping: '正在停止',
  exited: '已退出',
  failed: '启动失败',
  error: '启动失败',
  stale: '工作区已变化',
  retry: '连接中断',
  idle: '未运行',
};

export function terminalStateText(state) {
  return STATE_TEXT[state] || STATE_TEXT.idle;
}

export function createTerminalTabs({ onActivate, onClose, onNew } = {}) {
  const root = node('div', 'terminal-tabbar');
  const list = node('div', 'terminal-tablist');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', '终端标签');
  const newButton = button('terminal-new', '+');
  newButton.title = '新建终端';
  newButton.setAttribute('aria-label', '新建终端');
  newButton.onclick = () => onNew?.();
  root.append(list, newButton);

  const notice = node('div', 'terminal-notice');
  notice.hidden = true;

  const empty = node('div', 'terminal-empty');
  empty.hidden = true;
  const emptyTitle = node('p', 'terminal-empty-title');
  const emptyHint = node('p', 'terminal-empty-hint');
  const emptyAction = button('btn tiny rp-btn terminal-empty-action', '新建终端');
  empty.append(emptyTitle, emptyHint, emptyAction);
  let emptyActionHandler = null;
  emptyAction.onclick = () => emptyActionHandler?.();

  const tabs = new Map();

  function tabNodes(id) {
    return tabs.get(id) || null;
  }

  function add({ id, label, viewId, ordinal }) {
    if (!id || tabs.has(id)) return tabNodes(id);
    const tab = node('div', 'terminal-tab');
    tab.dataset.terminalId = id;
    const select = button('terminal-tab-select', '');
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', 'false');
    select.setAttribute('aria-controls', viewId);
    select.tabIndex = -1;
    const dot = node('span', 'terminal-tab-dot');
    dot.setAttribute('aria-hidden', 'true');
    const text = node('span', 'terminal-tab-label', label);
    select.append(dot, text);
    select.onclick = () => onActivate?.(id);
    select.ondblclick = (event) => {
      event.preventDefault();
      /* Double-click is a quick title affordance, not a rename feature. Keep
       * it toggling focus so a stray double click does not destroy a tab. */
      select.focus();
    };
    const close = button('terminal-tab-close', '×');
    close.setAttribute('aria-label', `关闭${label}`);
    close.title = `关闭${label}`;
    close.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClose?.(id);
    };
    tab.append(select, close);
    list.append(tab);
    const entry = { id, label, viewId, ordinal, tab, select, close, text, dot };
    tabs.set(id, entry);
    return entry;
  }

  function update(entry, { label, state = 'idle', selected = false } = {}) {
    if (!entry) return;
    if (label && label !== entry.label) {
      entry.label = label;
      entry.text.textContent = label;
      entry.close.setAttribute('aria-label', `关闭${label}`);
      entry.close.title = `关闭${label}`;
    }
    entry.state = state;
    const stateText = terminalStateText(state);
    entry.tab.dataset.state = state;
    entry.select.dataset.state = state;
    entry.select.setAttribute('aria-selected', selected ? 'true' : 'false');
    entry.select.tabIndex = selected ? 0 : -1;
    entry.select.title = `${entry.label} · ${stateText}`;
    if (selected) entry.tab.classList.add('is-active');
    else entry.tab.classList.remove('is-active');
  }

  function remove(id) {
    const entry = tabs.get(id);
    if (!entry) return;
    entry.tab.remove();
    tabs.delete(id);
  }

  function activate(id) {
    const entry = tabs.get(id);
    if (!entry) return;
    for (const other of tabs.values()) {
      const selected = other.id === id;
      update(other, { state: other.state || 'idle', selected });
    }
    try {
      entry.select.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } catch {
      /* Older engines do not accept options; the tab remains usable. */
    }
  }

  function focusTab(id) {
    tabNodes(id)?.select.focus();
  }

  function neighbors(id, step) {
    const ids = [...tabs.keys()];
    const index = ids.indexOf(id);
    if (index < 0 || !ids.length) return null;
    return ids[(index + step + ids.length) % ids.length];
  }

  list.addEventListener('keydown', (event) => {
    const current = event.target?.closest?.('.terminal-tab-select');
    if (!current) return;
    const id = current.closest('.terminal-tab')?.dataset.terminalId;
    if (!id) return;
    let next = null;
    if (event.key === 'ArrowRight') next = neighbors(id, 1);
    else if (event.key === 'ArrowLeft') next = neighbors(id, -1);
    else if (event.key === 'Home') next = [...tabs.keys()][0] || null;
    else if (event.key === 'End') next = [...tabs.keys()].at(-1) || null;
    else return;
    event.preventDefault();
    if (next) {
      onActivate?.(next);
      focusTab(next);
    }
  });

  function setEmpty({ hidden = false, title = '', hint = '', actionLabel = '', onAction = null } = {}) {
    empty.hidden = hidden;
    emptyTitle.textContent = title;
    emptyHint.textContent = hint;
    emptyHint.hidden = !hint;
    emptyAction.hidden = !actionLabel;
    emptyAction.textContent = actionLabel || '新建终端';
    emptyActionHandler = onAction;
  }

  function setNotice(text, tone = 'info') {
    if (!text) {
      notice.hidden = true;
      notice.textContent = '';
      notice.removeAttribute('data-tone');
      return;
    }
    notice.hidden = false;
    notice.textContent = text;
    notice.dataset.tone = tone;
  }

  function setNewEnabled(enabled, title = '新建终端') {
    newButton.disabled = !enabled;
    newButton.title = title;
    newButton.setAttribute('aria-label', title);
  }

  function clear() {
    for (const id of [...tabs.keys()]) remove(id);
  }

  return {
    el: root,
    list,
    newButton,
    notice,
    empty,
    tabs,
    add,
    update,
    remove,
    activate,
    focusTab,
    setEmpty,
    setNotice,
    setNewEnabled,
    clear,
  };
}
