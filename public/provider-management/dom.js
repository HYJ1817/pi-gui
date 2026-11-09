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

const ICONS = Object.freeze({
  search: ['circle:10.5,10.5,6', 'path:M15 15l5 5'],
  close: ['path:M7 7l10 10M17 7L7 17'],
  chevronDown: ['path:M6 9l6 6 6-6'],
  chevronRight: ['path:M9 6l6 6-6 6'],
  chevronLeft: ['path:M15 6l-6 6 6 6'],
  plus: ['path:M12 5v14M5 12h14'],
  check: ['path:M5 12.5l4.5 4.5L19 7.5'],
  refresh: ['path:M20 6v5h-5', 'path:M19.2 15.5a8 8 0 1 1-.7-7.2L20 11'],
  drag: ['circle:9,7,1.1', 'circle:15,7,1.1', 'circle:9,12,1.1', 'circle:15,12,1.1', 'circle:9,17,1.1', 'circle:15,17,1.1'],
  more: ['circle:5,12,1.5', 'circle:12,12,1.5', 'circle:19,12,1.5'],
  key: ['circle:8,15,4', 'path:M11 12l8-8M16 4h4v4'],
  alert: ['path:M12 3 2.5 20h19z', 'path:M12 9v5M12 17.5v.1'],
  info: ['circle:12,12,9', 'path:M12 11v6M12 7.5v.1'],
  external: ['path:M14 4h6v6M20 4l-9 9', 'path:M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  lock: ['rect:5,10,14,10,2', 'path:M8 10V7a4 4 0 0 1 8 0v3'],
  globe: ['circle:12,12,9', 'path:M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z'],
  arrowUp: ['path:M12 19V5M6 11l6-6 6 6'],
  arrowDown: ['path:M12 5v14M6 13l6 6 6-6'],
  spark: ['path:M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8'],
});

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const spec of ICONS[name] || ICONS.info) {
    const [kind, raw] = spec.split(':');
    if (kind === 'circle') {
      const [cx, cy, r] = raw.split(',');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', cx); circle.setAttribute('cy', cy); circle.setAttribute('r', r);
      if (name === 'drag' || name === 'more') circle.setAttribute('fill', 'currentColor');
      svg.appendChild(circle);
    } else if (kind === 'rect') {
      /* lock 的锁体：x,y,width,height[,rx]。曾经的实现把 rect 规格当 path 的 d
       * 写出（"5,10,14,10,2"），浏览器报非法 path 且锁体不显示。 */
      const [x, y, width, height, rx] = raw.split(',');
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x); rect.setAttribute('y', y);
      rect.setAttribute('width', width); rect.setAttribute('height', height);
      if (rx) rect.setAttribute('rx', rx);
      svg.appendChild(rect);
    } else {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', raw);
      svg.appendChild(path);
    }
  }
  return svg;
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

export function field(label, control, { hint = '', error = '', className = '' } = {}) {
  const wrap = h('div', { class: `pm-field ${className}`.trim() });
  const labelNode = h('label', { class: 'pm-field-label' });
  const text = h('span', { text: label });
  labelNode.appendChild(text);
  wrap.appendChild(labelNode);
  wrap.appendChild(control);
  if (hint) wrap.appendChild(h('div', { class: 'pm-field-hint', text: hint }));
  if (error) wrap.appendChild(h('div', { class: 'pm-field-error', role: 'alert', text: error }));
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
