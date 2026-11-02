/* Runtime-owned view of the existing native selects. No Classic state or RPC:
 * choices are submitted through the original, owner-scoped change handlers. */
let pickerId = 0;

export function createRuntimePicker({ select, label, className, searchable = false, scope, onOpen = () => {} }) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = `rtc-picker-trigger ${className}`;
  const buttonLabel = document.createElement('span'); buttonLabel.className = 'rtc-picker-label'; button.append(buttonLabel);
  button.setAttribute('aria-label', `选择${label}`);
  button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div');
  panel.className = 'rtc-picker-menu'; panel.id = `runtimePicker-${++pickerId}`;
  panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', label);
  button.setAttribute('aria-controls', panel.id);
  document.body.append(panel);
  select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
  let openedScope = null, signature = '', disposed = false;

  function close({ restoreFocus = false } = {}) {
    const wasOpen = !panel.hidden;
    panel.hidden = true; panel.replaceChildren(); openedScope = null;
    button.setAttribute('aria-expanded', 'false');
    if (wasOpen && restoreFocus && button.isConnected && !button.disabled) button.focus();
  }

  function position() {
    const anchor = button.getBoundingClientRect();
    const composer = button.closest('.rtc-composer')?.getBoundingClientRect();
    const upperEdge = composer?.top ?? anchor.top;
    const pane = document.getElementById('rightPane');
    const edge = pane && !pane.hidden ? Math.min(window.innerWidth, pane.getBoundingClientRect().left) : window.innerWidth;
    const width = Math.max(0, Math.min(searchable ? 380 : 240, edge - 16));
    panel.style.width = `${width}px`;
    const above = Math.max(0, upperEdge - 16), below = Math.max(0, window.innerHeight - anchor.bottom - 16);
    const useAbove = above >= below;
    panel.style.maxHeight = `${Math.max(32, Math.min(420, useAbove ? above : below))}px`;
    panel.style.left = `${Math.max(8, Math.min(anchor.left, edge - width - 8))}px`;
    panel.style.top = `${useAbove ? Math.max(8, upperEdge - panel.getBoundingClientRect().height - 8) : anchor.bottom + 8}px`;
  }

  function candidates() { return [...panel.querySelectorAll('[data-picker-value]')]; }
  function focusCandidate(node) {
    if (!node) return;
    for (const item of candidates()) item.tabIndex = item === node ? 0 : -1;
    node.focus(); node.scrollIntoView?.({ block: 'nearest' });
  }

  function open() {
    if (disposed || select.disabled) return;
    if (!panel.hidden) { close(); return; }
    onOpen(); openedScope = scope();
    const options = [...select.options].filter(option => option.value);
    const title = document.createElement('div'); title.className = 'rtc-picker-title'; title.textContent = label;
    const list = document.createElement('div'); list.className = 'rtc-picker-list';
    const render = query => {
      list.replaceChildren();
      for (const option of options.filter(item => item.textContent.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) {
        const item = document.createElement('button');
        item.type = 'button'; item.className = 'pop-item rtc-picker-option'; item.tabIndex = -1;
        item.dataset.pickerValue = option.value; item.textContent = option.textContent;
        if (option.value === select.value) item.setAttribute('aria-current', 'true');
        item.onclick = () => {
          // Detached callbacks must never turn an A choice into a B command.
          if (disposed || panel.hidden || select.disabled || scope() !== openedScope) return;
          select.value = option.value; close({ restoreFocus: true });
          select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
        };
        list.append(item);
      }
      if (!list.children.length) {
        const empty = document.createElement('p'); empty.className = 'rtc-picker-empty'; empty.textContent = '没有匹配的模型'; empty.setAttribute('role', 'status'); list.append(empty);
      }
      const first = list.querySelector('[aria-current="true"]') || candidates()[0];
      if (first) first.tabIndex = 0;
    };
    panel.append(title);
    let search;
    if (searchable) {
      search = document.createElement('input'); search.type = 'search'; search.className = 'rtc-picker-search';
      search.setAttribute('aria-label', '搜索当前会话模型'); search.placeholder = '搜索模型或供应商…';
      search.oninput = () => { render(search.value); position(); }; panel.append(search);
    }
    panel.append(list); render(''); panel.hidden = false;
    signature = JSON.stringify([...select.options].map(option => [option.value, option.textContent]));
    button.setAttribute('aria-expanded', 'true'); position();
    if (search) search.focus(); else focusCandidate(panel.querySelector('[aria-current="true"]') || candidates()[0]);
  }

  button.onclick = open;
  panel.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close({ restoreFocus: true }); return; }
    const list = candidates(), index = list.indexOf(document.activeElement);
    // Match the existing action-menu keyboard contract. Prevent native default
    // activation as well so one Enter/Space always produces one selection.
    if (index >= 0 && ['Enter', ' ', 'Spacebar'].includes(event.key)) {
      event.preventDefault(); list[index].click(); return;
    }
    let next;
    if (event.key === 'ArrowDown') next = list[(index + 1) % list.length];
    else if (event.key === 'ArrowUp') next = list[(index - 1 + list.length) % list.length];
    else if (event.key === 'Home' && document.activeElement?.type !== 'search') next = list[0];
    else if (event.key === 'End' && document.activeElement?.type !== 'search') next = list.at(-1);
    if (next) { event.preventDefault(); focusCandidate(next); }
  };
  const outside = event => { if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close(); };
  const focusOutside = event => { if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close(); };
  const resize = () => close();
  document.addEventListener('mousedown', outside); document.addEventListener('focusin', focusOutside);
  window.addEventListener('resize', resize); window.addEventListener('blur', resize);
  return {
    button, close,
    sync() {
      button.disabled = select.disabled;
      const selected = select.selectedOptions[0];
      buttonLabel.textContent = selected?.textContent || label; button.title = select.title || buttonLabel.textContent;
      if (!panel.hidden && (select.disabled || openedScope !== scope() || signature !== JSON.stringify([...select.options].map(option => [option.value, option.textContent])))) close();
    },
    dispose() {
      disposed = true; close(); panel.remove();
      document.removeEventListener('mousedown', outside); document.removeEventListener('focusin', focusOutside);
      window.removeEventListener('resize', resize); window.removeEventListener('blur', resize);
    },
  };
}
