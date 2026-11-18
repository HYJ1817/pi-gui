/* Searchable, windowed system-font picker for Appearance settings. */
import { createIcon } from './icons.js';
import { createAnchoredMenu } from './anchored-menu.js';
import {
  FONT_GROUP_ROW_HEIGHT,
  FONT_OPTION_ROW_HEIGHT,
  buildFontListLayout,
  visibleRowRange
} from './font-list.js';
import {
  buildFontOptions,
  filterFontOptions,
  loadSystemFonts,
  normalizeFontValue,
  readableFontFamily
} from '../fonts.js';

const GROUP_LABELS = {
  default: '默认',
  custom: '当前字体',
  system: '系统字体',
  builtin: '内置'
};

function statusText(status, fontCount) {
  if (status === 'loading') return '正在读取系统字体…';
  if (status === 'unavailable') return '网页版无法读取本机已安装字体，仅显示内置选项。';
  if (status === 'failed') return '读取系统字体失败，仅显示内置选项。';
  if (status === 'ok' && fontCount === 0) return '未检测到系统字体，仅显示内置选项。';
  return '';
}

export function createFontPicker({
  selectedValue = '',
  onSelect = () => true,
  loadFonts = loadSystemFonts,
  label = '排版字体'
} = {}) {
  const root = document.createElement('div');
  root.className = 'settings-font-picker';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'settings-picker-trigger settings-font-trigger';
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  const triggerLabel = document.createElement('span');
  triggerLabel.className = 'settings-picker-trigger-label';
  trigger.append(triggerLabel, createIcon('chevronDown', { className: 'settings-picker-chevron' }));
  root.appendChild(trigger);

  let value = normalizeFontValue(selectedValue);
  let systemFonts = [];
  let fontStatus = 'loading';
  let query = '';
  let highlight = 0;
  let scrollTop = 0;
  let listEl = null;
  let viewportEl = null;
  let inputEl = null;
  let noteEl = null;
  let emptyEl = null;
  let listFrame = 0;
  let destroyed = false;
  let optionsCache = null;

  // Building the option list sorts every installed family. Scroll frames must
  // not repeat that work; only a new list or a new selection invalidates it.
  const options = () => {
    if (!optionsCache || optionsCache.fonts !== systemFonts || optionsCache.value !== value) {
      optionsCache = { fonts: systemFonts, value, list: buildFontOptions(systemFonts, value) };
    }
    return optionsCache.list;
  };
  const selectedOption = () => options().find((option) => option.value === value)
    || (value ? { value, label: readableFontFamily(value), family: readableFontFamily(value), group: 'custom' } : null);

  function paintTrigger() {
    const option = selectedOption();
    triggerLabel.textContent = option?.group === 'default' || !value ? '跟随系统' : option?.label || readableFontFamily(value);
    triggerLabel.style.fontFamily = option?.family || '';
  }

  function ensureMenu(menuEl) {
    menuEl.classList.add('settings-font-menu');
    const search = document.createElement('div');
    search.className = 'settings-font-search';
    search.append(createIcon('search', { className: 'settings-font-search-icon' }));
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'settings-font-search-input';
    inputEl.placeholder = '搜索字体…';
    inputEl.setAttribute('aria-label', '搜索字体');
    inputEl.setAttribute('role', 'combobox');
    inputEl.setAttribute('aria-autocomplete', 'list');
    search.appendChild(inputEl);

    noteEl = document.createElement('div');
    noteEl.className = 'settings-font-note';
    noteEl.setAttribute('role', 'status');

    listEl = document.createElement('div');
    listEl.className = 'settings-font-list';
    listEl.setAttribute('role', 'listbox');
    listEl.setAttribute('aria-label', '可用字体');
    viewportEl = document.createElement('div');
    viewportEl.className = 'settings-font-viewport';
    listEl.appendChild(viewportEl);

    emptyEl = document.createElement('div');
    emptyEl.className = 'settings-font-empty';
    emptyEl.textContent = '没有匹配的字体';
    emptyEl.hidden = true;

    menuEl.append(search, noteEl, listEl, emptyEl);

    const listId = `${menuEl.id}-list`;
    listEl.id = listId;
    inputEl.setAttribute('aria-controls', listId);
    const onInput = () => {
      query = inputEl.value;
      // A filtered list is a new result set: Enter must take its first match,
      // not whatever index the previous, larger list happened to highlight.
      highlight = 0;
      refreshOptions({ resetScroll: true });
      if (menu.isOpen()) menu.reposition();
    };
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('keydown', onKeyDown);
    listEl.addEventListener('scroll', onScroll);
    listEl.addEventListener('keydown', onKeyDown);
    paintStatus();
    refreshOptions({ resetScroll: true, initial: true });
  }

  function paintStatus() {
    if (!noteEl) return;
    const text = statusText(fontStatus, systemFonts.length);
    noteEl.textContent = text;
    noteEl.hidden = !text;
  }

  function filteredOptions() {
    return filterFontOptions(options(), query);
  }

  function activeOption() {
    const filtered = filteredOptions();
    return filtered[Math.min(Math.max(0, highlight), filtered.length - 1)] || null;
  }

  function paintActive() {
    if (!viewportEl) return;
    const active = activeOption();
    for (const node of viewportEl.querySelectorAll('[data-font-option]')) {
      const isActive = Number(node.dataset.fontOption) === highlight;
      node.classList.toggle('is-active', isActive);
    }
    if (inputEl) {
      if (active) inputEl.setAttribute('aria-activedescendant', `fontOption-${highlight}`);
      else inputEl.removeAttribute('aria-activedescendant');
    }
  }

  function renderRows() {
    if (!viewportEl) return;
    const filtered = filteredOptions();
    const layout = buildFontListLayout(filtered, (group) => GROUP_LABELS[group] || group);
    viewportEl.style.height = `${layout.totalHeight}px`;
    const list = listEl;
    const viewportHeight = list?.clientHeight || 320;
    const { start, end } = visibleRowRange(layout, scrollTop, viewportHeight);
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const row = layout.rows[index];
      if (!row) continue;
      if (row.kind === 'group') {
        const heading = document.createElement('div');
        heading.className = 'settings-font-group';
        heading.textContent = row.label;
        heading.style.top = `${layout.offsets[index]}px`;
        heading.style.height = `${FONT_GROUP_ROW_HEIGHT}px`;
        fragment.appendChild(heading);
        continue;
      }
      const option = row.option;
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `fontOption-${row.optionIndex}`;
      button.dataset.fontOption = String(row.optionIndex);
      button.className = 'settings-font-option';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.value === value));
      if (row.optionIndex === highlight) button.classList.add('is-active');
      if (option.value === value) button.classList.add('is-current');
      button.style.top = `${layout.offsets[index]}px`;
      button.style.height = `${FONT_OPTION_ROW_HEIGHT}px`;
      if (option.family) button.style.fontFamily = option.family;
      const text = document.createElement('span');
      text.className = 'settings-font-option-label';
      text.textContent = option.label;
      button.appendChild(text);
      if (option.group === 'custom') {
        const badge = document.createElement('span');
        badge.className = 'settings-font-option-badge';
        badge.textContent = '未检测到';
        button.appendChild(badge);
      } else if (option.group === 'builtin') {
        const badge = document.createElement('span');
        badge.className = 'settings-font-option-badge';
        badge.textContent = '内置';
        button.appendChild(badge);
      }
      if (option.value === value) button.appendChild(createIcon('check', { className: 'settings-font-check' }));
      button.addEventListener('mouseenter', () => {
        highlight = row.optionIndex;
        paintActive();
      });
      button.addEventListener('click', () => { void choose(option); });
      fragment.appendChild(button);
    }
    viewportEl.replaceChildren(fragment);
    emptyEl.hidden = filtered.length > 0;
    listEl.hidden = filtered.length === 0;
    paintActive();
  }

  function scrollHighlightIntoView() {
    if (!listEl) return;
    const filtered = filteredOptions();
    const layout = buildFontListLayout(filtered, (group) => GROUP_LABELS[group] || group);
    const rowIndex = layout.optionRowIndex[highlight];
    if (rowIndex === undefined) return;
    const top = layout.offsets[rowIndex];
    const height = layout.heights[rowIndex];
    const viewport = listEl.clientHeight || 320;
    if (top < listEl.scrollTop) listEl.scrollTop = top;
    else if (top + height > listEl.scrollTop + viewport) listEl.scrollTop = top + height - viewport;
    scrollTop = listEl.scrollTop;
  }

  function refreshOptions({ resetScroll = false, initial = false } = {}) {
    const filtered = filteredOptions();
    if (initial) {
      const selectedIndex = filtered.findIndex((option) => option.value === value);
      highlight = selectedIndex >= 0 ? selectedIndex : 0;
    } else {
      highlight = Math.min(Math.max(0, highlight), Math.max(0, filtered.length - 1));
    }
    if (resetScroll) {
      scrollTop = 0;
      if (listEl) listEl.scrollTop = 0;
    }
    renderRows();
    if (initial && highlight > 0) scrollHighlightIntoView();
  }

  function onScroll() {
    if (!listEl || listFrame) return;
    const update = () => {
      listFrame = 0;
      scrollTop = listEl.scrollTop;
      renderRows();
    };
    listFrame = requestAnimationFrame(update);
    if (!listFrame) update();
  }

  function moveHighlight(delta) {
    const filtered = filteredOptions();
    if (!filtered.length) return;
    highlight = (highlight + delta + filtered.length) % filtered.length;
    paintActive();
    scrollHighlightIntoView();
  }

  function onKeyDown(event) {
    // Never commit or move the highlight while an IME is composing a name.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      if (event.target?.tagName === 'BUTTON') return;
      const option = activeOption();
      if (!option) return;
      event.preventDefault();
      void choose(option);
    }
  }

  async function choose(option) {
    menu.close({ restoreFocus: true });
    if (option.value === value) return;
    let accepted = true;
    try { accepted = await onSelect(option.value); } catch { accepted = false; }
    if (accepted === false || destroyed) return;
    value = option.value;
    paintTrigger();
  }

  const menu = createAnchoredMenu({
    anchor: trigger,
    className: 'settings-font-menu-anchored',
    label,
    role: 'dialog',
    align: 'end',
    initialFocus: 'input',
    build: ensureMenu
  });

  trigger.addEventListener('click', () => {
    if (menu.isOpen()) menu.close({ restoreFocus: true });
    else {
      query = '';
      if (inputEl) inputEl.value = '';
      menu.open();
      refreshOptions({ resetScroll: true, initial: true });
    }
  });

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      trigger.click();
    }
  });

  void Promise.resolve(loadFonts()).then((result) => {
    if (destroyed) return;
    fontStatus = result?.status || 'failed';
    systemFonts = Array.isArray(result?.fonts) ? result.fonts : [];
    paintTrigger();
    if (menu.isOpen()) {
      paintStatus();
      refreshOptions();
      menu.reposition();
    }
  }).catch(() => {
    if (destroyed) return;
    fontStatus = 'failed';
    systemFonts = [];
    paintTrigger();
    if (menu.isOpen()) {
      paintStatus();
      refreshOptions();
      menu.reposition();
    }
  });

  paintTrigger();

  return {
    element: root,
    trigger,
    setValue(next) {
      value = normalizeFontValue(typeof next === 'string' ? next : '');
      paintTrigger();
      if (menu.isOpen()) {
        paintStatus();
        refreshOptions();
      }
    },
    focus() { trigger.focus(); },
    destroy() {
      destroyed = true;
      if (listFrame) cancelAnimationFrame(listFrame);
      listFrame = 0;
      if (inputEl) inputEl.removeEventListener('keydown', onKeyDown);
      menu.destroy();
      root.remove();
    },
    _state: () => ({ value, fontStatus, systemFonts: [...systemFonts], query, highlight })
  };
}
