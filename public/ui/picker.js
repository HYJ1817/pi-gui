/* Shared themed single-select listbox for settings surfaces.
 *
 * A native <select> hands its popup to the OS: on Windows that means a system
 * menu that ignores pi-GUI's theme, radius and focus language. This component
 * keeps the field look of `.ds-select` but renders the options in the shared
 * anchored layer (`ui/anchored-menu.js`), so it follows the same portal,
 * flip/clamp and Escape/Tab rules as the theme, font and project pickers.
 *
 * Keyboard model (trigger focused): Enter / Space / ArrowDown / ArrowUp opens.
 * Inside the listbox: ArrowUp/ArrowDown move, Home/End jump, Enter/Space pick,
 * Escape closes and returns focus to the trigger, Tab closes the same way.
 * Pointer selection never leaves a white browser focus ring: the trigger and
 * options style `:focus-visible` only.
 *
 * The caller owns the data and any async switch. `onSelect` returning `false`
 * (or throwing) restores the previous value; otherwise the trigger updates
 * immediately and the caller can disable the picker until its load settles.
 * Business state stays with the caller — this module only paints a choice.
 */

import { createIcon } from './icons.js';
import { createAnchoredMenu } from './anchored-menu.js';

const MIN_MENU_WIDTH = 180;
const MAX_MENU_WIDTH = 340;

function optionLabel(option) {
  return option && option.label !== undefined && option.label !== null ? String(option.label) : '';
}

function normalizeOptions(options) {
  const seen = new Set();
  const list = [];
  for (const option of Array.isArray(options) ? options : []) {
    if (!option || option.value === undefined || option.value === null) continue;
    const value = String(option.value);
    if (seen.has(value)) continue;
    seen.add(value);
    list.push({
      value,
      label: optionLabel(option) || value || '未选择',
      title: typeof option.title === 'string' ? option.title : '',
    });
  }
  return list;
}

/**
 * @param {object} options
 * @param {string} options.value      current value
 * @param {Array}  options.options    [{ value, label, title? }]
 * @param {string} options.label      accessible name for trigger and listbox
 * @param {string} options.fallbackLabel shown when the current value has no option
 * @param {boolean} options.disabled
 * @param {'start'|'end'} options.align  menu alignment against the trigger
 * @param {string} options.field      dataset.field on the trigger (test/automation hook)
 * @param {string} options.className        extra class on the root
 * @param {string} options.triggerClassName extra class on the trigger
 * @param {string} options.menuClassName    extra class on the portaled menu
 * @param {(value: string) => boolean|void|Promise<boolean|void>} options.onSelect
 */
export function createPicker({
  value = '',
  options = [],
  label = '选择',
  fallbackLabel = '未选择',
  disabled = false,
  align = 'end',
  field = '',
  className = '',
  triggerClassName = '',
  menuClassName = '',
  onSelect = () => true,
} = {}) {
  const root = document.createElement('div');
  root.className = ['ds-picker', className].filter(Boolean).join(' ');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = ['ds-picker-trigger', triggerClassName].filter(Boolean).join(' ');
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (field) trigger.dataset.field = field;
  const labelEl = document.createElement('span');
  labelEl.className = 'ds-picker-label';
  trigger.append(labelEl, createIcon('chevronDown', { className: 'ds-picker-chevron' }));
  root.appendChild(trigger);

  let current = value === null || value === undefined ? '' : String(value);
  let items = normalizeOptions(options);
  let blocked = Boolean(disabled);
  let busy = false;
  let destroyed = false;
  let menuEl = null;

  const currentOption = () => items.find((option) => option.value === current) || null;
  const triggerDisabled = () => blocked || busy || !items.length;

  function paintTrigger() {
    const hit = currentOption();
    /* Same precedence as the project picker this engine was extracted from:
     * an unknown current value still shows the caller's fallback wording. */
    labelEl.textContent = hit ? hit.label : (fallbackLabel || current || '未选择');
    trigger.title = hit ? (hit.title || hit.label) : '';
    trigger.disabled = triggerDisabled();
    trigger.setAttribute('aria-busy', String(busy));
    trigger.dataset.value = current;
  }

  function paintOptions() {
    if (!menuEl) return;
    /* Options can change while the menu is open (a list refresh).
     * Keep focus on the same value if it still exists, otherwise fall back
     * to the current value so the keyboard does not silently drop to body. */
    const focusedOption = menu.isOpen() ? document.activeElement?.closest?.('.ds-picker-option') : null;
    const focusedValue = focusedOption ? focusedOption.dataset.value : '';
    const fragment = document.createDocumentFragment();
    for (const option of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ds-picker-option';
      button.dataset.value = option.value;
      button.tabIndex = -1;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.value === current));
      button.classList.toggle('is-selected', option.value === current);
      const text = document.createElement('span');
      text.className = 'ds-picker-option-label';
      text.textContent = option.label;
      if (option.title) text.title = option.title;
      button.appendChild(text);
      if (option.value === current) button.appendChild(createIcon('check', { className: 'ds-picker-check' }));
      button.addEventListener('click', () => { void choose(option.value); });
      fragment.appendChild(button);
    }
    menuEl.replaceChildren(fragment);
    if (focusedValue) {
      const next = [...menuEl.querySelectorAll('.ds-picker-option')].find((node) => node.dataset.value === focusedValue)
        || menuEl.querySelector('.ds-picker-option.is-selected')
        || menuEl.querySelector('.ds-picker-option');
      next?.focus();
    }
  }

  function menuOptions() {
    return menuEl ? [...menuEl.querySelectorAll('.ds-picker-option')] : [];
  }

  function moveFocus(delta) {
    const optionsInMenu = menuOptions();
    if (!optionsInMenu.length) return;
    const index = optionsInMenu.indexOf(document.activeElement);
    const next = index < 0
      ? (delta > 0 ? 0 : optionsInMenu.length - 1)
      : (index + delta + optionsInMenu.length) % optionsInMenu.length;
    optionsInMenu[next].focus();
  }

  function onMenuKeyDown(event) {
    // Never move or commit while an IME is composing (e.g. a future search).
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      const optionsInMenu = menuOptions();
      if (!optionsInMenu.length) return;
      event.preventDefault();
      (event.key === 'Home' ? optionsInMenu[0] : optionsInMenu[optionsInMenu.length - 1]).focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      const option = document.activeElement?.closest?.('.ds-picker-option');
      if (!option) return;
      event.preventDefault();
      option.click();
    }
  }

  function build(anchored) {
    menuEl = anchored;
    menuEl.classList.add('ds-picker-menu');
    if (menuClassName) menuEl.classList.add(menuClassName);
    menuEl.style.minWidth = `${Math.min(MAX_MENU_WIDTH, Math.max(MIN_MENU_WIDTH, trigger.getBoundingClientRect().width))}px`;
    menuEl.addEventListener('keydown', onMenuKeyDown);
    paintOptions();
  }

  const menu = createAnchoredMenu({
    anchor: trigger,
    className: ['project-picker-menu-anchored', menuClassName ? `${menuClassName}-anchored` : ''].filter(Boolean).join(' '),
    label,
    role: 'listbox',
    align,
    initialFocus: 'selected',
    build,
    onClose: () => {
      // The layer removes the node itself; drop our reference so a later
      // setOptions()/setValue() never paints into a detached menu.
      if (menuEl) menuEl.removeEventListener('keydown', onMenuKeyDown);
      menuEl = null;
    },
  });

  function closeMenu() {
    menu.close({ restoreFocus: true });
  }

  async function choose(next) {
    closeMenu();
    if (next === current) return;
    const hadFocus = document.activeElement === trigger;
    const previous = current;
    current = next;
    busy = true;
    paintTrigger();
    let accepted = true;
    try {
      accepted = await onSelect(next);
    } catch {
      accepted = false;
    }
    busy = false;
    if (destroyed) return;
    if (accepted === false) {
      current = previous;
      paintTrigger();
      if (hadFocus) trigger.focus();
      return;
    }
    paintTrigger();
    /* Native disabled during a switch can drop focus to body in a real
     * browser. Only reclaim it if the picker had it and nobody moved on. */
    if (hadFocus && (document.activeElement === document.body || document.activeElement === null)) {
      trigger.focus();
    }
  }

  trigger.addEventListener('click', () => {
    if (trigger.disabled) return;
    if (menu.isOpen()) {
      closeMenu();
      return;
    }
    menu.open();
  });

  trigger.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      trigger.click();
    }
  });

  paintTrigger();

  return {
    element: root,
    trigger,
    /** Replace the option set and (optionally) the current value. */
    setOptions(nextOptions, { value: nextValue = current, disabled: nextDisabled = blocked } = {}) {
      if (destroyed) return;
      items = normalizeOptions(nextOptions);
      current = nextValue === null || nextValue === undefined ? '' : String(nextValue);
      blocked = Boolean(nextDisabled);
      paintTrigger();
      if (menu.isOpen()) {
        paintOptions();
        if (!items.length) closeMenu();
        else if (triggerDisabled()) closeMenu();
        else menu.reposition();
      }
    },
    setValue(next) {
      if (destroyed) return;
      current = next === null || next === undefined ? '' : String(next);
      paintTrigger();
      if (menu.isOpen()) paintOptions();
    },
    setDisabled(next) {
      if (destroyed) return;
      blocked = Boolean(next);
      paintTrigger();
      if (triggerDisabled() && menu.isOpen()) closeMenu();
    },
    close() { if (menu.isOpen()) closeMenu(); },
    isOpen: () => menu.isOpen(),
    focus() { trigger.focus(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      menu.destroy();
      root.remove();
    },
    _state: () => ({
      value: current,
      options: items.map((option) => ({ ...option })),
      disabled: triggerDisabled(),
      open: menu.isOpen(),
    }),
  };
}
