/* Small shared controls, not a parallel component system. Document values only
 * enter textContent; trusted icons come from the repository's icon owner. */
import { createIcon } from '../ui/icons.js';
import { openActionMenu } from '../ui/action-menu.js';

// These fixed action names share the app's existing outline icons. Unknown
// labels remain text buttons; document text can never pick arbitrary markup.
const controlIcons = Object.freeze({
  '上一个匹配项': 'arrowUp', '下一个匹配项': 'arrowDown', '上一处': 'arrowUp', '下一处': 'arrowDown',
  '上一页': 'chevronLeft', '下一页': 'chevronRight', '缩小': 'minus', '放大': 'plus',
  '适合宽度': 'scan', '适合窗口': 'scan', '原始尺寸': 'image',
});

export function node(tag, className = '', text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

export function button(label, handler, { icon, title } = {}) {
  const element = node('button', icon ? 'icon-btn fp-button' : 'btn ghost tiny fp-button', icon ? undefined : label);
  element.type = 'button';
  element.title = title || label;
  element.setAttribute('aria-label', label);
  if (icon) element.append(createIcon(icon));
  element.addEventListener('click', handler);
  return element;
}

export function navigationButton(label, handler) {
  return button(label, handler, { icon: Object.hasOwn(controlIcons, label) ? controlIcons[label] : undefined });
}

export function compactNavigation(element) {
  const label = element.getAttribute('aria-label');
  if (!Object.hasOwn(controlIcons, label)) return;
  element.classList.remove('btn', 'ghost', 'tiny');
  element.classList.add('icon-btn');
  element.replaceChildren(createIcon(controlIcons[label]));
}

export function toolbarMenu(ctx, items, { label = '阅读选项', icon = 'more' } = {}) {
  let menu = null;
  const trigger = button(label, () => {
    if (ctx.resources.signal.aborted || !ctx.resources.isCurrent()) return;
    menu = openActionMenu(trigger, typeof items === 'function' ? items() : items);
    if (!menu) return;
    const popup = trigger.ownerDocument.getElementById(trigger.getAttribute('aria-controls'));
    // The shared menu closes before calling an action. Reject stale detached
    // clicks in capture phase, before they can dismiss another surface's menu
    // or execute an action that belonged to a now-disposed document.
    popup?.addEventListener('click', event => {
      if (popup.isConnected && !ctx.resources.signal.aborted && ctx.resources.isCurrent()) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
  }, { icon });
  trigger.classList.add('fp-reading-menu');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  ctx.resources.own(() => {
    if (trigger.getAttribute('aria-expanded') === 'true') menu?.close();
    trigger.remove();
  });
  return trigger;
}

export function searchControl(toolbar, onSearch) {
  const input = node('input', 'ds-input fp-search');
  input.type = 'search';
  input.placeholder = '查找';
  input.setAttribute('aria-label', '在文件中查找');
  input.maxLength = 256;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.addEventListener('input', () => onSearch(input.value));
  toolbar.append(input);
  return input;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const styles = new Set();
export function loadStyle(name) {
  // Callers use hard-coded local filenames, never values from a document.
  if (!/^[a-z-]+\.css$/.test(name) || styles.has(name)) return;
  const link = node('link');
  link.rel = 'stylesheet';
  link.href = new URL(name === 'katex.css' ? '../vendor/file-preview/katex.css' : name, import.meta.url).href;
  link.dataset.filePreviewStyle = name;
  document.head.append(link);
  styles.add(name);
}

export function decodeText(bytes, encoding = 'auto') {
  if (!(bytes instanceof Uint8Array)) throw new Error('invalid_bytes');
  let charset = encoding;
  if (encoding === 'auto') {
    if (bytes[0] === 255 && bytes[1] === 254) charset = 'utf-16le';
    else if (bytes[0] === 254 && bytes[1] === 255) charset = 'utf-16be';
    else {
      try { return checked(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { charset = 'gb18030'; }
    }
  }
  return checked(new TextDecoder(charset, { fatal: true }).decode(bytes));
}
function checked(text) {
  if (text.includes('\0') || /[\x01-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error('binary_text');
  return text.replace(/^﻿/, '');
}

export function shortError(code) {
  if (code === 'unsupported_type') return '此二进制或不支持的格式暂不内联预览。';
  if (['file_changed', 'stale_workspace', 'external_file_changed'].includes(code)) return '文件或工作区已变化，请重新打开。';
  if (/grant|denied|unauthorized|scope/.test(code || '')) return '文件访问权限已失效。';
  if (/large|size|budget|limit/.test(code || '')) return '此文件超出安全预览范围，可选择其他打开方式。';
  return '无法预览此文件，可选择其他打开方式。';
}
