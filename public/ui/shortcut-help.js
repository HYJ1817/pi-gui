/* P24 快捷键帮助面板 —— 直接由注册表渲染。
 *
 * 单独成文件（而不是塞在 `shortcuts.js` 里）是为了让那个模块**保持零 DOM 依赖**：
 * 注册表与匹配逻辑要能离线单测，`openModal` 会把 `document` 拉进来。
 *
 * 面板内容分两段：
 *   1. **注册表里的键位**（按分组）—— 加一个快捷键就自动出现在这里，
 *      不存在「文档忘了更新」这种情况；
 *   2. **本来就有的输入 / 弹层键位**（Enter / Shift+Enter / Esc / Tab）。
 *      这几条的语义是上下文相关的（Esc 在输入框、弹层、面板里各不相同），
 *      实现分散在各自模块，硬塞进注册表只会让它们互相打架 —— 所以只在这里列出来。
 */
import { openModal } from './modal.js';
import { listShortcuts, IS_MAC } from '../shortcuts.js';

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function keyRows(pairs) {
  const rows = node('div', 'stat-rows kb-rows');
  for (const [label, keys] of pairs) {
    const row = node('div');
    row.append(node('span', '', label), node('b', 'kb-keys', keys));
    rows.appendChild(row);
  }
  return rows;
}

export function openShortcutHelp() {
  openModal((card, close) => {
    card.classList.add('wide');
    card.appendChild(node('h3', '', '键盘快捷键'));

    const desc = node('div', 'modal-desc',
      `${IS_MAC ? 'macOS' : 'Windows / Linux'} 映射。在输入框里打字时不会被抢 —— `
      + '不带修饰键的组合一律让给文本输入。');
    card.appendChild(desc);

    const groups = new Map();
    for (const item of listShortcuts()) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push([item.label, item.display]);
    }
    for (const [group, pairs] of groups) {
      card.appendChild(node('div', 'ext-sec-head', group));
      card.appendChild(keyRows(pairs));
    }

    card.appendChild(node('div', 'ext-sec-head', '输入与弹层'));
    card.appendChild(keyRows([
      ['发送消息', 'Enter'],
      ['换行', 'Shift+Enter'],
      ['停止生成 / 关闭浮层', 'Esc'],
      ['列表与面板内移动', '↑ ↓ · Tab'],
      ['危险确认框', 'Tab / Enter（主操作需显式点击）'],
    ]));

    const actions = node('div', 'modal-actions');
    const done = node('button', 'btn primary', '关闭');
    done.type = 'button';
    done.onclick = close;
    actions.appendChild(done);
    card.appendChild(actions);
  });
}
