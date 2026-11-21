/* 资源页（技能 / 扩展 / MCP 能力报告）共用的极小 DOM 积木。
 *
 * 三个入口各自拥有页面与状态，只在这里共享「造节点」这一层：
 * 不放业务文案、不持有状态、不 import 任何页面模块 —— 页面之间因此不会互相 import UI。
 * 导出名带 `resource` 前缀：jsdom 测试打包会把所有模块的具名导出合并到 window，
 * 通用名（el / row / note）会和其它模块撞名。 */

/** 造一个元素；`text` 走 textContent，所以来自 pi / 文件系统的字符串不会被当成 HTML。 */
export function resourceEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

/** 详情里的一行「键 / 值」；值过长时靠 title 看全文。 */
export function resourceRow(label, value) {
  const r = resourceEl('div', 'ext-row');
  const v = resourceEl('span', 'ext-row-v', value);
  v.title = String(value ?? '');
  r.append(resourceEl('span', 'ext-row-k', label), v);
  return r;
}

/** 一条说明。kind 取 '' / 'warn' / 'err'，沿用 .cfg-note 的既有样式。 */
export function resourceNote(text, kind = '') {
  return resourceEl('div', 'cfg-note' + (kind ? ' ' + kind : ''), text);
}
