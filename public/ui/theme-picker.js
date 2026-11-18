/* Searchable anchored theme picker. Theme persistence stays in theme.js. */
import { createIcon } from './icons.js';
import { createAnchoredMenu } from './anchored-menu.js';

const THEME_OPTIONS = Object.freeze([
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]);

export function createThemePicker({
  value = 'dark',
  onSelect = () => true,
  label = '界面主题'
} = {}) {
  const root = document.createElement('div');
  root.className = 'settings-picker settings-theme-picker';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'settings-picker-trigger settings-theme-trigger';
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  const triggerLabel = document.createElement('span');
  triggerLabel.className = 'settings-picker-trigger-label';
  trigger.append(triggerLabel, createIcon('chevronDown', { className: 'settings-picker-chevron' }));
  root.appendChild(trigger);

  let current = THEME_OPTIONS.some((option) => option.value === value) ? value : 'dark';
  let query = '';
  let active = current;
  let inputEl = null;
  let listEl = null;
  let emptyEl = null;
  let destroyed = false;

  function paintTrigger() {
    triggerLabel.textContent = THEME_OPTIONS.find((option) => option.value === current)?.label || current;
  }

  function visibleOptions() {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return THEME_OPTIONS;
    return THEME_OPTIONS.filter((option) => option.label.toLocaleLowerCase().includes(needle));
  }

  function paintActive() {
    if (!listEl) return;
    for (const node of listEl.querySelectorAll('[data-theme-option]')) {
      node.classList.toggle('is-active', node.dataset.themeOption === active);
    }
    if (inputEl) {
      const found = visibleOptions().some((option) => option.value === active);
      if (found) inputEl.setAttribute('aria-activedescendant', `themeOption-${active}`);
      else inputEl.removeAttribute('aria-activedescendant');
    }
  }

  function renderOptions() {
    if (!listEl) return;
    const options = visibleOptions();
    const fragment = document.createDocumentFragment();
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `themeOption-${option.value}`;
      button.dataset.themeOption = option.value;
      button.className = 'settings-theme-option';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.value === current));
      if (option.value === current) button.classList.add('is-current');
      if (option.value === active) button.classList.add('is-active');
      const text = document.createElement('span');
      text.className = 'settings-theme-option-label';
      text.textContent = option.label;
      button.appendChild(text);
      if (option.value === current) button.appendChild(createIcon('check', { className: 'settings-theme-check' }));
      button.addEventListener('mouseenter', () => {
        active = option.value;
        paintActive();
      });
      button.addEventListener('click', () => { void choose(option.value); });
      fragment.appendChild(button);
    }
    listEl.replaceChildren(fragment);
    emptyEl.hidden = options.length > 0;
    listEl.hidden = options.length === 0;
    paintActive();
  }

  function moveActive(delta) {
    const options = visibleOptions();
    if (!options.length) return;
    const index = options.findIndex((option) => option.value === active);
    active = options[(index < 0 ? (delta > 0 ? 0 : options.length - 1) : (index + delta + options.length) % options.length)].value;
    paintActive();
  }

  function onKeyDown(event) {
    // Never commit or move the highlight while an IME is composing a query.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      if (event.target?.tagName === 'BUTTON') return;
      const option = visibleOptions().find((item) => item.value === active);
      if (!option) return;
      event.preventDefault();
      void choose(option.value);
    }
  }

  async function choose(next) {
    menu.close({ restoreFocus: true });
    if (next === current) return;
    let accepted = true;
    try { accepted = await onSelect(next); } catch { accepted = false; }
    if (accepted === false || destroyed) return;
    current = next;
    paintTrigger();
  }

  function ensureMenu(menuEl) {
    menuEl.classList.add('settings-theme-menu');
    const search = document.createElement('div');
    search.className = 'settings-theme-search';
    search.append(createIcon('search', { className: 'settings-theme-search-icon' }));
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = '搜索主题…';
    inputEl.setAttribute('aria-label', '搜索主题');
    inputEl.setAttribute('role', 'combobox');
    inputEl.setAttribute('aria-autocomplete', 'list');
    search.appendChild(inputEl);

    listEl = document.createElement('div');
    listEl.className = 'settings-theme-list';
    listEl.setAttribute('role', 'listbox');
    listEl.setAttribute('aria-label', '可用主题');

    emptyEl = document.createElement('div');
    emptyEl.className = 'settings-theme-empty';
    emptyEl.textContent = '没有匹配的主题';
    emptyEl.hidden = true;

    menuEl.append(search, listEl, emptyEl);
    listEl.id = `${menuEl.id}-list`;
    inputEl.setAttribute('aria-controls', listEl.id);
    inputEl.addEventListener('input', () => {
      query = inputEl.value;
      const options = visibleOptions();
      if (!options.some((option) => option.value === active)) active = options[0]?.value || current;
      renderOptions();
      if (menu.isOpen()) menu.reposition();
    });
    inputEl.addEventListener('keydown', onKeyDown);
    listEl.addEventListener('keydown', onKeyDown);
    renderOptions();
  }

  const menu = createAnchoredMenu({
    anchor: trigger,
    className: 'settings-theme-menu-anchored',
    label,
    role: 'dialog',
    align: 'end',
    initialFocus: 'input',
    build: ensureMenu
  });

  trigger.addEventListener('click', () => {
    if (menu.isOpen()) {
      menu.close({ restoreFocus: true });
      return;
    }
    query = '';
    active = current;
    if (inputEl) inputEl.value = '';
    menu.open();
    renderOptions();
  });

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      trigger.click();
    }
  });

  paintTrigger();

  return {
    element: root,
    trigger,
    setValue(next) {
      if (!THEME_OPTIONS.some((option) => option.value === next)) return;
      current = next;
      active = next;
      paintTrigger();
      if (menu.isOpen()) renderOptions();
    },
    focus() { trigger.focus(); },
    destroy() {
      destroyed = true;
      menu.destroy();
      root.remove();
    },
    _state: () => ({ value: current, query, active })
  };
}
