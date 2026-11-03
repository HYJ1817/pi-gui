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

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ds-segment-item' + (opt.value === currentValue ? ' is-active' : '');
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(opt.value === currentValue));
    btn.setAttribute('data-value', opt.value);
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

    btn.onclick = (e) => {
      e.preventDefault();
      if (currentValue === opt.value) return;
      currentValue = opt.value;
      buttons.forEach(b => {
        const active = b.getAttribute('data-value') === currentValue;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-checked', String(active));
      });
      onChange(currentValue);
    };
    buttons.push(btn);
    group.appendChild(btn);
  });

  return {
    element: group,
    setValue(val) {
      currentValue = val;
      buttons.forEach(b => {
        const active = b.getAttribute('data-value') === currentValue;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-checked', String(active));
      });
    },
    getValue() {
      return currentValue;
    }
  };
}

/**
 * Creates an inline Help Icon (?) with tooltip according to D601 specifications.
 */
export function createHelpIcon({ tooltipText = '', ariaLabel = '' } = {}) {
  const span = document.createElement('span');
  span.className = 'ds-help-icon';
  span.tabIndex = 0;
  span.setAttribute('role', 'note');
  span.setAttribute('aria-label', ariaLabel || tooltipText);
  span.title = tooltipText;
  span.textContent = '?';
  return span;
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
 * Creates a D297 SettingsCard container.
 */
export function createSettingsCard({ title = '', description = '', children = [], id } = {}) {
  const section = document.createElement('section');
  section.className = 'ds-settings-card';
  if (id) section.id = id;
  if (title) {
    const header = document.createElement('div');
    header.className = 'ds-settings-card-header';
    const h4 = document.createElement('h4');
    h4.className = 'ds-settings-card-title';
    h4.textContent = title;
    header.appendChild(h4);
    if (description) {
      const p = document.createElement('p');
      p.className = 'ds-settings-card-desc';
      p.textContent = description;
      header.appendChild(p);
    }
    section.appendChild(header);
  }
  const body = document.createElement('div');
  body.className = 'ds-settings-card-body';
  children.forEach(child => {
    if (child) body.appendChild(child);
  });
  section.appendChild(body);
  return section;
}

/**
 * Creates a D601 single-line SettingsRow.
 */
export function createSettingsRow({ label = '', help = '', control = null, extraClass = '', id } = {}) {
  const row = document.createElement('div');
  row.className = 'ds-settings-row' + (extraClass ? ' ' + extraClass : '');
  if (id) row.id = id;

  const labelCol = document.createElement('div');
  labelCol.className = 'ds-settings-row-lead';
  const labelSpan = document.createElement('span');
  labelSpan.className = 'ds-settings-row-label';
  labelSpan.textContent = label;
  labelCol.appendChild(labelSpan);
  if (help) {
    const helpIcon = createHelpIcon({ tooltipText: help });
    labelCol.appendChild(helpIcon);
  }
  row.appendChild(labelCol);

  if (control) {
    const ctrlCol = document.createElement('div');
    ctrlCol.className = 'ds-settings-row-tail';
    ctrlCol.appendChild(control.nodeType ? control : (control.element || control));
    row.appendChild(ctrlCol);
  }

  return row;
}
