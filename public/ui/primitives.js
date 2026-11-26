import { pop, toggleHelpPop } from './popover.js';
import { createIcon } from './icons.js';

/**
 * Base UI Primitives for pi-GUI
 * Audited and implemented cleanly following PI-Desktop Design Specifications.
 */

/**
 * Creates an accessible switch toggle matching PI-Desktop D601 / REF-004 specifications.
 */
export function createSettingsToggle({ checked = false, onChange = () => {}, disabled = false, ariaLabel = '', id } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ds-switch' + (checked ? ' is-on' : '');
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(Boolean(checked)));
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  if (id) button.id = id;
  if (disabled) button.disabled = true;

  const knob = document.createElement('span');
  knob.className = 'ds-switch-knob';
  button.appendChild(knob);

  button.onclick = (e) => {
    e.preventDefault();
    if (button.disabled) return;
    const next = !button.classList.contains('is-on');
    button.classList.toggle('is-on', next);
    button.setAttribute('aria-checked', String(next));
    onChange(next);
  };

  return {
    element: button,
    setChecked(val) {
      button.classList.toggle('is-on', Boolean(val));
      button.setAttribute('aria-checked', String(Boolean(val)));
    },
    isChecked() {
      return button.classList.contains('is-on');
    },
    setDisabled(val) {
      button.disabled = Boolean(val);
    }
  };
}

/**
 * Creates a Segmented Control matching PI-Desktop SegmentedControl specification.
 */
export function createSegmentedControl({ options = [], value = '', onChange = () => {}, ariaLabel = '', id } = {}) {
  const group = document.createElement('div');
  group.className = 'ds-segmented';
  group.setAttribute('role', 'radiogroup');
  if (ariaLabel) group.setAttribute('aria-label', ariaLabel);
  if (id) group.id = id;

  let currentValue = value;
  const buttons = [];

  /**
   * radiogroup 的 Tab 语义：整组只有一个停靠点，落在当前选中项；
   * 当前项被禁用 / 隐藏时退到第一个可用的项。方向键在组内移动并选中。
   */
  function tabStop() {
    const visible = (b) => !b.disabled && !b.hidden;
    return buttons.find((b) => b.getAttribute('data-value') === currentValue && visible(b))
      || buttons.find(visible)
      || null;
  }
  function syncTabStops() {
    const stop = tabStop();
    for (const b of buttons) b.tabIndex = b === stop ? 0 : -1;
  }
  function rememberTabStop(btn) {
    /* 聚焦中的项就是后续 Tab 的进入点；选中项换了以后由 setValue / 点击重新同步。 */
    for (const b of buttons) b.tabIndex = b === btn ? 0 : -1;
  }

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ds-segment-item' + (opt.value === currentValue ? ' is-active' : '');
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(opt.value === currentValue));
    btn.setAttribute('data-value', opt.value);
    if (opt.disabled) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    }
    if (opt.icon) {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'ds-segment-icon';
      iconSpan.innerHTML = opt.icon;
      btn.appendChild(iconSpan);
    }
    const labelSpan = document.createElement('span');
    labelSpan.className = 'ds-segment-label';
    labelSpan.textContent = opt.label;
    btn.appendChild(labelSpan);
    // 可选的条数（PI-Desktop 筛选分段「全部 5」的弱化数字）；只有传了 count 的项才有这个节点。
    if ('count' in opt) {
      const countSpan = document.createElement('span');
      countSpan.className = 'ds-segment-count';
      countSpan.textContent = opt.count === null || opt.count === undefined ? '' : String(opt.count);
      btn.appendChild(countSpan);
    }

    const select = ({ focus = false } = {}) => {
      if (btn.disabled) return;
      const changed = currentValue !== opt.value;
      currentValue = opt.value;
      buttons.forEach(b => {
        const active = b.getAttribute('data-value') === currentValue;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-checked', String(active));
      });
      rememberTabStop(btn);
      /* 先聚焦再通知：使用方可能在 onChange 里重建整组（如 MCP 工具栏），
       * 它需要从 activeElement 读到当前项并把焦点还原到新节点。 */
      if (focus) btn.focus();
      if (changed) onChange(currentValue);
    };

    btn.onclick = (e) => {
      e.preventDefault();
      select();
    };
    buttons.push(btn);
    group.appendChild(btn);
  });

  /* WAI-ARIA radiogroup：Tab 进组一次，方向键 / Home / End 在可用项之间移动并选中。 */
  group.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const from = event.target instanceof Element ? event.target.closest('.ds-segment-item') : null;
    const enabled = buttons.filter((b) => !b.disabled && !b.hidden);
    if (!enabled.length) return;
    const index = from ? enabled.indexOf(from) : enabled.indexOf(tabStop());
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = enabled[(index + 1 + enabled.length) % enabled.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    event.preventDefault();
    if (next === from) return;
    /* 先聚焦再触发 click：使用方在 onChange 里重建整组时，能从 activeElement 记住新项。 */
    next.focus();
    next.click();
  });

  syncTabStops();

  return {
    element: group,
    setValue(val) {
      currentValue = val;
      buttons.forEach(b => {
        const active = b.getAttribute('data-value') === currentValue;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-checked', String(active));
      });
      syncTabStops();
    },
    getValue() {
      return currentValue;
    },
    setDisabled(val) {
      buttons.forEach(b => {
        b.disabled = Boolean(val);
        if (val) b.setAttribute('aria-disabled', 'true');
        else b.removeAttribute('aria-disabled');
      });
      syncTabStops();
    },
    setOptionDisabled(optionValue, val) {
      buttons.forEach(b => {
        if (b.getAttribute('data-value') !== optionValue) return;
        b.disabled = Boolean(val);
        if (val) b.setAttribute('aria-disabled', 'true');
        else b.removeAttribute('aria-disabled');
      });
      syncTabStops();
    },
    /** 更新某一项的条数；null / undefined 清空（空节点不占位）。只作用于创建时声明了 count 的项。 */
    setCount(optionValue, count) {
      buttons.forEach(b => {
        if (b.getAttribute('data-value') !== optionValue) return;
        const countSpan = b.querySelector('.ds-segment-count');
        if (countSpan) countSpan.textContent = count === null || count === undefined ? '' : String(count);
      });
    },
    /** 隐藏 / 恢复某一项（例如没有条目的可选分类）。隐藏当前选中项由调用方先改值。 */
    setOptionHidden(optionValue, val) {
      buttons.forEach(b => {
        if (b.getAttribute('data-value') === optionValue) b.hidden = Boolean(val);
      });
      syncTabStops();
    }
  };
}

/**
 * Creates the inline help disclosure used by settings headings and rows.
 */
export function createHelpIcon({ tooltipText = '', ariaLabel = '' } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ds-help-icon';
  button.setAttribute('aria-label', ariaLabel || '帮助');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', pop.id);
  button.append(createIcon('help'));
  button.onclick = () => toggleHelpPop(button, tooltipText);
  return button;
}

/**
 * Creates a Badge component matching PI-Desktop ui.tsx#L829-L855 Badge specification.
 */
export function createBadge({ text = '', tone = 'neutral' } = {}) {
  const span = document.createElement('span');
  span.className = 'ds-badge ds-badge-' + tone;
  span.textContent = text;
  return span;
}

/**
 * Creates a D297 SettingsCard container matching PI-Desktop structure.
 */
export function createSettingsCard({ title = '', description = '', action = null, children = [], id } = {}) {
  const section = document.createElement('section');
  section.className = 'settings-card-block ds-settings-card-block ds-settings-card';
  if (id) section.id = id;
  if (title) {
    const header = document.createElement('div');
    header.className = action
      ? 'settings-card-heading-row settings-card-heading-with-action ds-settings-card-header'
      : 'settings-card-heading-help ds-settings-card-header';

    const headingWrap = document.createElement('div');
    headingWrap.className = 'settings-card-heading-help';
    const h3 = document.createElement('h3');
    h3.className = 'settings-card-heading ds-settings-card-title';
    h3.textContent = title;
    headingWrap.appendChild(h3);
    if (description) {
      const help = createHelpIcon({ tooltipText: description, ariaLabel: `${title}提示` });
      headingWrap.appendChild(help);
    }
    header.appendChild(headingWrap);
    if (action) header.appendChild(action);
    section.appendChild(header);
  }
  const panel = document.createElement('div');
  panel.className = 'settings-panel ds-settings-card-body';
  children.forEach(child => {
    if (child) panel.appendChild(child.nodeType ? child : (child.element || child));
  });
  section.appendChild(panel);
  return section;
}

/**
 * Creates a D601 single-line SettingsRow matching PI-Desktop structure.
 *
 * `flat` is the normalized in-flow variant for pages that present a continuous
 * settings list instead of separate tone tiles: no per-row background, no
 * rounded box, only a hairline between adjacent rows. The default stays the
 * existing tile so pages that opted into D297 tiles are not restyled here.
 */
export function createSettingsRow({
  label = '', help = '', detail = null, control = null, extraClass = '', id, flat = false,
} = {}) {
  const row = document.createElement('div');
  row.className = 'settings-row ds-settings-row'
    + (flat ? ' ds-settings-row-flat' : '')
    + (extraClass ? ' ' + extraClass : '');
  if (id) row.id = id;

  const copy = document.createElement('div');
  copy.className = 'settings-row-copy ds-settings-row-lead';
  
  const title = document.createElement('div');
  title.className = 'settings-row-title ds-settings-row-label';
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  title.appendChild(labelSpan);
  if (help) {
    const helpIcon = createHelpIcon({ tooltipText: help, ariaLabel: `${label}提示` });
    title.appendChild(helpIcon);
  }
  copy.appendChild(title);

  if (detail) {
    const detailDiv = document.createElement('div');
    detailDiv.className = 'settings-row-detail ds-settings-row-desc';
    if (typeof detail === 'string') detailDiv.textContent = detail;
    else detailDiv.appendChild(detail.nodeType ? detail : (detail.element || detail));
    copy.appendChild(detailDiv);
  }
  row.appendChild(copy);

  if (control) {
    const ctrlCol = document.createElement('div');
    ctrlCol.className = 'settings-row-control ds-settings-row-tail';
    ctrlCol.appendChild(control.nodeType ? control : (control.element || control));
    row.appendChild(ctrlCol);
  }

  return row;
}
