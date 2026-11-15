import { createIcon } from '../ui/icons.js';
/* P4 视图的 DOM 小工具。
 * 只做静态结构；所有用户/后端文本一律走 textContent。 */

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    else if (key.startsWith('aria-') || key === 'role' || key === 'tabindex') node.setAttribute(key, String(value));
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden' || key === 'readOnly') node[key] = Boolean(value);
    else if (key === 'value') node.value = value;
    else if (key === 'type') node.type = value;
    else if (key.startsWith('data-')) node.setAttribute(key, String(value));
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function icon(name, size = 16) {
  return createIcon(name === 'alert' ? 'warning' : name, { size, fallback: 'info' });
}

export function iconButton(label, name, onClick, className = '') {
  const button = h('button', {
    type: 'button',
    class: `pm-icon-btn ${className}`.trim(),
    'aria-label': label,
    title: label,
    on: { click: onClick },
  }, icon(name, 15));
  return button;
}

export function button(label, className = '', onClick = null, attrs = {}) {
  return h('button', {
    type: 'button',
    class: `pm-btn ${className}`.trim(),
    on: onClick ? { click: onClick } : undefined,
    ...attrs,
  }, label);
}

let fieldDescriptionId = 0;

export function field(label, control, { hint = '', error = '', className = '' } = {}) {
  const wrap = h('div', { class: `pm-field ${className}`.trim() });
  const labelNode = h('label', { class: 'pm-field-label' });
  const isField = control.matches('input, select, textarea');
  if (isField) {
    control.id ||= `pm-field-${++fieldDescriptionId}`;
    labelNode.htmlFor = control.id;
  }
  const text = h('span', { text: label });
  labelNode.appendChild(text);
  wrap.appendChild(labelNode);
  wrap.appendChild(control);
  const descriptions = [control.getAttribute('aria-describedby')].filter(Boolean);
  if (hint && isField) {
    const id = `pm-field-hint-${++fieldDescriptionId}`;
    wrap.appendChild(h('div', { class: 'pm-field-hint', id, text: hint }));
    descriptions.push(id);
  } else if (hint) wrap.appendChild(h('div', { class: 'pm-field-hint', text: hint }));
  if (error) {
    const id = `pm-field-error-${++fieldDescriptionId}`;
    wrap.appendChild(h('div', { class: 'pm-field-error', id, role: 'alert', text: error }));
    if (isField) {
      control.setAttribute('aria-invalid', 'true');
      descriptions.push(id);
    }
  }
  if (descriptions.length) control.setAttribute('aria-describedby', descriptions.join(' '));
  return wrap;
}

export function badge(text, tone = '') {
  return h('span', { class: `pm-badge ${tone ? `is-${tone}` : ''}`.trim(), text });
}

export function focusFirst(root, selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') {
  const target = root && root.querySelector(selector);
  if (target && typeof target.focus === 'function') target.focus();
  return target;
}

export function isComposing(event) {
  return Boolean(event?.isComposing || event?.keyCode === 229);
}
