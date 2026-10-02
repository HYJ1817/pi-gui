/* P24 命令面板的 **DOM 层** —— 只暴露已经存在、且当前 context 真的能执行的动作。
 *
 * ---------- 一条硬规矩 ----------
 *
 * **不复制业务逻辑。** 每个 command 的 `run` 由装配层（`app.js`）给出，
 * 直接调既有模块的既有 handler（`newSession` / `openPlanner` / `stop` /
 * `reloadPi` / `openDiagnostics`…）。面板自己不实现任何「切视图」「重启」「复制」
 * 的细节 —— 那样就会出现两份真相，而两份真相迟早会漂。
 * 危险动作（重启 Pi）走的仍是既有 `reloadPi()`，**面板不提供跳过确认的入口**。
 *
 * 命令的注册与搜索在 `palette-model.js`（纯逻辑，可离线单测）；
 * 这里只管一个输入框、一个列表、一套键盘，以及焦点从哪来回到哪去。
 */
import { el } from './state.js';
import { toast } from './ui/toast.js';
import { allCommands, filterCommands } from './palette-model.js';

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

let openState = null;

function layer() {
  return document.getElementById('paletteLayer');
}

export function paletteOpen() {
  return Boolean(layer() && !layer().hidden);
}

export function closePalette({ restoreFocus = true } = {}) {
  const l = layer();
  if (!l || l.hidden) return false;
  const state = openState;
  openState = null;
  l.hidden = true;
  l.replaceChildren();
  if (restoreFocus && state && state.returnFocus && state.returnFocus.isConnected) {
    try {
      state.returnFocus.focus();
    } catch {
      /* 元素已经不可聚焦就算了 */
    }
  }
  return true;
}

/**
 * 打开面板。
 * @param ctx 传给 `when()` / 动态命令的上下文（默认空对象 —— 命令自己读 S）
 */
export function openPalette(ctx = {}) {
  const l = layer();
  if (!l) return false;
  if (!l.hidden) return true;

  const returnFocus = document.activeElement;
  l.hidden = false;
  l.replaceChildren();
  openState = { returnFocus, index: 0, items: [] };

  const card = node('div', 'palette-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', '命令面板');

  const input = node('input', 'palette-input');
  input.type = 'text';
  input.placeholder = '输入命令…（↑↓ 选择，Enter 执行，Esc 关闭）';
  input.setAttribute('aria-label', '搜索命令');
  input.setAttribute('autocomplete', 'off');
  input.spellcheck = false;

  const list = node('div', 'palette-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '命令');

  const empty = node('div', 'palette-empty', '没有匹配的命令');
  empty.hidden = true;

  card.append(input, list, empty);
  l.appendChild(card);

  function paint() {
    /* 动态命令每次按键都重新求值：它们要看当前 query（例如「会话」那批只在
     * 有查询时才出现），而静态命令只是被过滤。 */
    const items = filterCommands(allCommands({ ...ctx, query: input.value }), input.value);
    openState.items = items;
    if (openState.index >= items.length) openState.index = Math.max(0, items.length - 1);
    list.replaceChildren();
    empty.hidden = items.length > 0;
    let lastGroup = '';
    items.forEach((cmd, i) => {
      if (cmd.group !== lastGroup) {
        lastGroup = cmd.group;
        const head = node('div', 'palette-group', cmd.group);
        head.setAttribute('aria-hidden', 'true');
        list.appendChild(head);
      }
      const row = node('button', 'palette-item' + (i === openState.index ? ' on' : ''));
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === openState.index));
      row.dataset.commandId = cmd.id;
      row.append(node('span', 'palette-title', cmd.title));
      if (cmd.hint) row.append(node('span', 'palette-hint', cmd.hint));
      row.onclick = () => run(cmd);
      list.appendChild(row);
    });
    const current = list.querySelector('.palette-item.on');
    if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!openState.items.length) return;
    openState.index = (openState.index + delta + openState.items.length) % openState.items.length;
    paint();
  }

  function run(cmd) {
    if (!cmd) return;
    /* 先关面板再执行：动作可能会打开弹层 / 切视图，留着面板会挡住结果，
     * 也会和 modal.js 的「只有一个弹层」前提打架。 */
    closePalette({ restoreFocus: false });
    try {
      cmd.run(ctx);
    } catch (err) {
      toast(`命令执行失败：${err && err.message ? err.message : err}`, 'error');
    }
    /* 动作没开弹层时把焦点还回原处（通常是输入框）；开了弹层就交给弹层自己管焦点。 */
    if (el.modal.hidden && el.confirmLayer.hidden && returnFocus && returnFocus.isConnected) {
      try {
        returnFocus.focus();
      } catch {
        /* 元素已经不可聚焦就算了 */
      }
    }
  }

  input.addEventListener('input', () => {
    openState.index = 0;
    paint();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(openState.items[openState.index]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePalette();
    } else if (event.key === 'Tab') {
      /* 面板里只有一个输入框，Tab 留在它上面（符合 aria-modal 的语义）。 */
      event.preventDefault();
    }
  });
  /* 点空白处关闭：与其它弹层一致。 */
  l.addEventListener('mousedown', (event) => {
    if (event.target === l) closePalette();
  });

  paint();
  input.focus();
  return true;
}
