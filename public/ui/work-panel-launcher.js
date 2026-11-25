import { createIcon } from './icons.js';
import { shortcutFor, subscribeShortcuts, isTextEntry } from '../shortcuts.js';

/* A local keyboard/presentation projection of the actual Surface registry.
 * Capability and action ownership stay with each registered tool. There are
 * deliberately no hidden DOM source buttons and no global letter shortcuts. */
export function mountWorkPanelLauncher(host, tools, options = {}) {
  const root = document.createElement('section');
  root.className = 'work-panel-empty';
  const content = document.createElement('div');
  content.className = 'work-panel-launcher-content';
  const title = document.createElement('h2'); title.textContent = '打开工具';
  const list = document.createElement('div'); list.className = 'work-panel-launcher-list';
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', '打开工作面板工具');
  content.append(title, list); root.append(content); host.append(root);
  let disposed = false;
  let bindings = [];
  const entries = () => (typeof tools === 'function' ? tools() : Array.isArray(tools) ? tools : [])
    .filter(tool => tool && typeof tool.id === 'string' && (typeof tool.available !== 'function' || tool.available()));
  const enabled = () => bindings.filter(({ row }) => !row.hidden && !row.disabled);

  function select(binding, focus = false) {
    for (const item of bindings) item.row.tabIndex = item === binding ? 0 : -1;
    if (focus) binding?.row.focus();
  }
  function syncShortcuts() {
    for (const { tool, shortcut } of bindings) {
      const registered = tool.shortcutId ? shortcutFor(tool.shortcutId) : null;
      shortcut.hidden = !registered?.effectiveCombo || registered.available === false;
      shortcut.textContent = shortcut.hidden ? '' : registered.display;
    }
  }
  function render() {
    if (disposed) return;
    const focusedId = bindings.find(item => item.row === document.activeElement)?.tool.id;
    bindings = entries().map(tool => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'work-panel-launcher-row'; row.dataset.tool = tool.id;
      row.disabled = typeof tool.disabled === 'function' ? Boolean(tool.disabled()) : tool.disabled === true;
      const icon = document.createElement('span'); icon.className = 'work-panel-launcher-icon'; icon.setAttribute('aria-hidden', 'true'); icon.append(createIcon(tool.icon || 'panel'));
      const label = document.createElement('span'); label.className = 'work-panel-launcher-label'; label.textContent = tool.label || tool.id;
      const shortcut = document.createElement('kbd'); shortcut.className = 'work-panel-launcher-shortcut';
      row.append(icon, label, shortcut);
      row.onclick = () => { if (!disposed && !row.disabled) (options.open || tool.open)?.(tool.id); };
      return { tool, row, shortcut };
    });
    list.replaceChildren(...bindings.map(item => item.row));
    syncShortcuts();
    const active = enabled().find(item => item.tool.id === focusedId) || enabled()[0];
    select(active, Boolean(focusedId));
  }
  const onKey = event => {
    if (disposed || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || isTextEntry(event.target)
      || event.target?.closest?.('[contenteditable="true"]') || !root.contains(document.activeElement)) return;
    const rows = enabled();
    const index = rows.findIndex(item => item.row === document.activeElement);
    let next;
    if (event.key === 'Escape') {
      if (!options.onEscape) return;
      event.preventDefault(); event.stopPropagation(); options.onEscape(); return;
    }
    if (!rows.length) return;
    if (event.key === 'ArrowDown') next = rows[(index + 1) % rows.length];
    else if (event.key === 'ArrowUp') next = rows[(index - 1 + rows.length) % rows.length];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key === 'Enter' || event.key === ' ') {
      if (index < 0) return;
      event.preventDefault(); rows[index].row.click(); return;
    } else if (/^[a-z]$/i.test(event.key)) {
      // Type-ahead only while the Launcher itself has focus. It cannot steal
      // letters from Composer, browser addresses, file search or xterm.
      const letter = event.key.toLowerCase();
      next = [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find(item => (item.tool.key || item.tool.label || '').toLowerCase().startsWith(letter));
    } else return;
    if (next) { event.preventDefault(); select(next, true); }
  };
  root.addEventListener('keydown', onKey);
  const offShortcuts = subscribeShortcuts(syncShortcuts);
  const offTools = options.subscribe?.(render);
  render();
  return () => {
    if (disposed) return;
    disposed = true; offShortcuts(); offTools?.(); root.removeEventListener('keydown', onKey);
    for (const { row } of bindings) { row.onclick = null; row.disabled = true; }
  };
}
