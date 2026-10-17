/* UI-3C：Composer 内联 Slash 命令菜单。
 *
 * ---------- 这个模块存在的理由 ----------
 *
 * P24 已经有一套**命令注册表**（`palette-model.js` 的 `allCommands(ctx)` /
 * `filterCommands`）和一套**动作**（每个 command 的 `run()`）。命令面板
 * （`palette.js`）是「弹一个居中卡片、单独搜索框」的形态；Claude Code 那种
 * **在输入框里直接打 `/`** 的形态，缺的只是「触发 + 列表 + 键盘」这一层。
 *
 * 所以这里**只做增量**，绝不重新定义任何业务：
 *   - 候选来源永远是 `listCommands(ctx)`（默认 `allCommands`）——`when(ctx)` 为假
 *     的命令根本不会出现，和独立面板同一份真相；
 *   - 执行永远是 `cmd.run(ctx)` —— 不拼 RPC、不复制 handler，危险动作该有的确认
 *     原样保留（本模块不提供任何 `skipConfirm`/bypass）。
 *   - 独立命令面板 `palette.js` 完整保留，两者共用同一份注册表。
 *
 * ---------- 与 app.js 现有 keydown 的契约（重要） ----------
 *
 * `app.js` 已经在 textarea 上监听 keydown，而且**不看 `event.defaultPrevented`**：
 *   `if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }`
 * 所以「内联菜单吃掉 Enter」这件事，光 `preventDefault` 不够，必须让集成层在
 * **原有分支之前**调用 `controller.handleKeydown(e)` 并 `return`：
 *
 *     el.input.addEventListener('keydown', (e) => {
 *       if (inlineMenu.handleKeydown(e)) return;   // ← 只加这一行
 *       ... 原有 Enter / Escape 逻辑 ...
 *     });
 *
 * `handleKeydown` 在「菜单开着且这个键归我管」时返回 true（并 preventDefault +
 * stopPropagation），其余情况返回 false、什么都不做。菜单没开时，输入与发送行为
 * 与从前完全一致。
 *
 * 无法改 keydown handler 的宿主可以退而用 `bindKeyboard(scopeEl)`：它把监听挂在
 * **composer 子树**的捕获阶段（不是全局永久拦截），只对绑定的 textarea 生效，
 * 且只在真正消费按键时 stopPropagation。
 *
 * ---------- 触发语义（安全） ----------
 *
 * 只有「行首（允许前导空白）的 `/` + 命令词」才触发，命令词只允许 `[A-Za-z0-9_-]`：
 *   - `https://…` / `and/or`：`/` 前面不是行首空白 → 不触发；
 *   - `C:\Users\…\a/b`：`/` 前是普通字符 → 不触发（Windows 路径走反斜杠更不会）；
 *   - `/usr/bin`：第二个 `/` 出现时命令词非法 → 立刻关闭；
 *   - 一旦行首前缀不再是命令片段（打空格、换行、删掉 `/`）→ 自动关闭。
 *
 * ---------- IME ----------
 *
 * `compositionstart` 期间不触发也不接受；`handleKeydown` 遇到 `isComposing` 或
 * `keyCode === 229` 一律放行（让输入法把 Enter 当「上屏」）。`Shift+Enter` 永远
 * 交给 Composer 换行。
 */

import { allCommands, filterCommands } from '../palette-model.js';

const STYLE_ID = 'ui3-inline-commands-style';
const EMPTY_TEXT = '没有匹配的命令';
const DEFAULT_MENU_LABEL = '命令';
const MIN_WIDTH = 200;

let uidSeq = 0;

/** 幂等注入本模块的样式表。返回已存在/新建的 <link>。
 *
 * 为什么由模块自己注入：本任务不允许改 `public/index.html`，但样式必须待在
 * `public/ui3-inline-commands.css`。集成方若愿意在 index.html 里加一条静态
 * `<link rel="stylesheet" href="/ui3-inline-commands.css">`，本函数会检测到并复用，
 * 不会重复注入。 */
export function ensureStylesheet(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return null;
  const existing = doc.getElementById(STYLE_ID);
  if (existing) return existing;
  const link = doc.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.setAttribute('data-ui3-inline-commands', '');
  let href = './ui3-inline-commands.css';
  try {
    href = new URL('../ui3-inline-commands.css', import.meta.url).href;
  } catch {
    /* 老引擎没有 URL/import.meta —— 回落相对路径 */
  }
  link.href = href;
  (doc.head || doc.documentElement).appendChild(link);
  return link;
}

/**
 * 从输入值与光标位置解析出「正在输入的命令片段」。
 *
 * @returns {{ start:number, end:number, query:string, caret:number } | null}
 *   - `start`/`end` 是该片段在 value 里的半开区间（`/` 到光标）；
 *   - `query` 是去掉 `/` 之后的命令词（可能为空，表示刚敲 `/`）；
 *   - 返回 null 表示当前不是安全命令片段（菜单应关闭）。
 */
export function parseSlashTrigger(value, caret) {
  const text = typeof value === 'string' ? value : '';
  const pos = Number.isInteger(caret) ? caret : text.length;
  if (pos < 1 || pos > text.length) return null;
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const lineBefore = text.slice(lineStart, pos);
  const m = /^[ \t]*\/([A-Za-z0-9_-]*)$/.exec(lineBefore);
  if (!m) return null;
  const next = text[pos];
  /* 光标停在词中间（后面还接着命令词字符）不算一个完整触发片段。 */
  if (next && /[A-Za-z0-9_-]/.test(next)) return null;
  const slashOffset = lineBefore.length - 1 - m[1].length;
  return { start: lineStart + slashOffset, end: pos, query: m[1], caret: pos };
}

/**
 * 创建并绑定一个 Composer 内联命令菜单。
 *
 * @param options.input      必填，绑定的 textarea
 * @param options.getContext 返回传给 `when(ctx)` / `run(ctx)` 的上下文（可读 S 等）
 * @param options.listCommands 取候选（默认 palette-model 的 allCommands）
 * @param options.filter     过滤（默认 palette-model 的 filterCommands）
 * @param options.hintFor    (cmd)=>string，覆盖右侧快捷键/提示文案
 * @param options.onError    (err)=>void，命令执行出错时的落点（默认 console.error）
 * @param options.host       菜单挂载点（默认 input.ownerDocument.body）
 * @param options.acceptTab  菜单开着时 Tab 是否等于「接受」（默认 true）
 * @param options.maxItems   列表最多渲染多少条（默认 50）
 * @param options.injectStyles 是否自动注入样式表（默认 true）
 * @param options.label      listbox 的 aria-label
 */
export function createInlineCommandMenu(options = {}) {
  const input = options.input;
  if (!input || typeof input.addEventListener !== 'function') {
    throw new Error('inline command menu 需要绑定一个 textarea/input');
  }
  const doc = input.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('inline command menu 需要 DOM');

  const getContext = typeof options.getContext === 'function' ? options.getContext : () => ({});
  const listCommands = typeof options.listCommands === 'function' ? options.listCommands : (ctx) => allCommands(ctx);
  const filter = typeof options.filter === 'function' ? options.filter : filterCommands;
  const onError = typeof options.onError === 'function' ? options.onError : (err) => console.error('[ui3-inline-commands]', err);
  const hintFor = typeof options.hintFor === 'function' ? options.hintFor : null;
  const acceptTab = options.acceptTab !== false;
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 50;
  const injectStyles = options.injectStyles !== false;
  const menuLabel = options.label || DEFAULT_MENU_LABEL;
  const preferredHost = options.host || doc.body;

  const uid = ++uidSeq;
  const listId = `ui3-inline-list-${uid}`;

  let menuEl = null;
  let listEl = null;
  let emptyEl = null;
  let host = null;
  let attached = false;
  let keyScope = null;
  let composing = false;
  let open = false;
  let items = [];
  let index = 0;
  let trigger = null;

  /* ---------- DOM ---------- */

  function node(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function build() {
    if (menuEl) return;
    menuEl = node('div', 'ui3-inline-menu');
    menuEl.hidden = true;
    menuEl.setAttribute('data-ui3-inline-menu', '');
    listEl = node('div', 'ui3-inline-list');
    listEl.id = listId;
    listEl.setAttribute('role', 'listbox');
    listEl.setAttribute('aria-label', menuLabel);
    emptyEl = node('div', 'ui3-inline-empty', EMPTY_TEXT);
    emptyEl.hidden = true;
    emptyEl.setAttribute('role', 'status');
    menuEl.append(listEl, emptyEl);
    host = (preferredHost && preferredHost.isConnected !== false) ? preferredHost : doc.body;
    host.appendChild(menuEl);
    /* 用事件委托处理点击：列表每次重画都换新节点，逐个挂 onclick 会漏。 */
    menuEl.addEventListener('mousedown', (event) => event.preventDefault());
    listEl.addEventListener('mousedown', (event) => {
      const opt = event.target && event.target.closest ? event.target.closest('.ui3-inline-item') : null;
      if (!opt) return;
      const i = Number(opt.dataset.index);
      if (Number.isInteger(i)) accept(i);
    });
    listEl.addEventListener('mousemove', (event) => {
      const opt = event.target && event.target.closest ? event.target.closest('.ui3-inline-item') : null;
      if (!opt) return;
      const i = Number(opt.dataset.index);
      if (Number.isInteger(i) && i !== index) {
        index = i;
        paintActive();
      }
    });
  }

  function setInputAria(on) {
    if (on) {
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-controls', listId);
      input.setAttribute('aria-autocomplete', 'list');
    } else {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-controls');
      input.removeAttribute('aria-autocomplete');
      input.removeAttribute('aria-activedescendant');
    }
  }

  /* ---------- 渲染 ---------- */

  function paint() {
    if (!menuEl) return;
    emptyEl.hidden = items.length > 0;
    listEl.replaceChildren();
    items.forEach((cmd, i) => {
      const opt = node('div', 'ui3-inline-item' + (i === index ? ' on' : ''));
      opt.setAttribute('role', 'option');
      opt.id = `ui3-inline-opt-${uid}-${i}`;
      opt.dataset.index = String(i);
      opt.dataset.commandId = cmd.id;
      opt.setAttribute('aria-selected', String(i === index));
      opt.append(node('span', 'ui3-inline-title', cmd.title));
      if (cmd.group) opt.append(node('span', 'ui3-inline-group', cmd.group));
      const hint = hintFor ? hintFor(cmd) : cmd.hint;
      if (hint) opt.append(node('span', 'ui3-inline-hint', hint));
      listEl.appendChild(opt);
    });
    paintActive();
  }

  function paintActive() {
    if (!listEl) return;
    const opts = listEl.querySelectorAll('.ui3-inline-item');
    opts.forEach((opt, i) => {
      const on = i === index;
      opt.classList.toggle('on', on);
      opt.setAttribute('aria-selected', String(on));
    });
    const current = opts[index];
    if (current) {
      input.setAttribute('aria-activedescendant', current.id);
      if (typeof current.scrollIntoView === 'function') {
        try { current.scrollIntoView({ block: 'nearest' }); } catch { /* jsdom 无实现 */ }
      }
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  /* ---------- 定位 ---------- */

  function position() {
    if (!menuEl || menuEl.hidden) return;
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!win || typeof input.getBoundingClientRect !== 'function') return;
    const anchor = input.getBoundingClientRect();
    const vw = win.innerWidth || 0;
    const vh = win.innerHeight || 0;
    /* 右栏是**原生 WebContentsView**，z-index 管不着。菜单不假称能盖住它，
     * 而是老实把右边界收在 `--rp-width` 左边 —— 复用 right-pane.js 写下的这个
     * 全局变量，不去改它的遮挡协议。 */
    let rpWidth = 0;
    try {
      const raw = win.getComputedStyle(doc.documentElement).getPropertyValue('--rp-width');
      rpWidth = parseFloat(raw) || 0;
    } catch {
      rpWidth = 0;
    }
    const rightLimit = Math.max(MIN_WIDTH, vw - rpWidth - 8);
    const leftMin = 8;
    let width = anchor.width || rightLimit - leftMin;
    width = Math.max(MIN_WIDTH, Math.min(width, rightLimit - leftMin));
    menuEl.style.width = Math.round(width) + 'px';
    const rect = menuEl.getBoundingClientRect();
    const h = rect.height || 0;
    let left = anchor.left;
    left = Math.max(leftMin, Math.min(left, rightLimit - width));
    let top = anchor.top - h - 8;
    if (top < 8) top = Math.min(anchor.bottom + 8, vh - h - 8);
    if (top < 8) top = 8;
    menuEl.style.left = Math.round(left) + 'px';
    menuEl.style.top = Math.round(top) + 'px';
  }

  /* ---------- 开关 ---------- */

  function openMenu() {
    build();
    if (open) return;
    open = true;
    menuEl.hidden = false;
    setInputAria(true);
    paint();
    position();
  }

  function close({ restoreFocus = false } = {}) {
    if (!open) {
      /* 菜单没开也要清掉残留的 aria，防止上一次异常退出留下脏属性。 */
      setInputAria(false);
      return false;
    }
    open = false;
    trigger = null;
    items = [];
    index = 0;
    if (menuEl) {
      menuEl.hidden = true;
      if (listEl) listEl.replaceChildren();
      if (emptyEl) emptyEl.hidden = true;
    }
    setInputAria(false);
    if (restoreFocus && typeof input.focus === 'function' && doc.activeElement !== input) {
      try { input.focus(); } catch { /* 元素不可聚焦就算了 */ }
    }
    return true;
  }

  /* ---------- 刷新（输入 → 候选） ---------- */

  function recompute() {
    const next = parseSlashTrigger(input.value, input.selectionStart);
    if (!next) {
      close();
      return;
    }
    const sameQuery = trigger && trigger.query === next.query;
    trigger = next;
    const ctx = { ...getContext(), query: next.query };
    let list;
    try {
      list = filter(listCommands(ctx), next.query);
    } catch (err) {
      onError(err);
      close();
      return;
    }
    items = list.slice(0, Math.max(0, maxItems));
    index = sameQuery ? Math.min(index, Math.max(0, items.length - 1)) : 0;
    if (!open) openMenu();
    else { paint(); position(); }
  }

  function refresh() {
    /* 输入法组合期间不动菜单：候选窗还在拼字，这时候弹命令列表只会打架。 */
    if (composing) { close(); return; }
    recompute();
  }

  /* ---------- 键盘 ---------- */

  function move(delta) {
    if (!items.length) return;
    index = (index + delta + items.length) % items.length;
    paintActive();
  }

  /**
   * 处理一次 keydown。返回 true 表示「这个键菜单消费了」，调用方应立刻 return，
   * 不要继续走 submit / stop 分支。
   */
  function handleKeydown(event) {
    if (!event || !open) return false;
    /* 输入法正在组合：Enter 是「上屏」不是「接受」。
     *
     * `isComposing` 是标准判据；`keyCode === 229` 是旧引擎的等价信号。两者都可能
     * 出现在「菜单开着」的时候，而 app.js 原有的 submit 分支只看 `!isComposing`、
     * 不看 229 —— 所以菜单开着时，凡是「会做事」的键（Enter/Tab/Escape/方向键）
     * 只要命中这两个信号，就**原地吞掉**：既不接受命令，也不让它冒泡到 submit。 */
    if (event.isComposing || event.keyCode === 229) {
      if (['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    }
    const key = event.key;
    if (key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      move(1);
      return true;
    }
    if (key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      move(-1);
      return true;
    }
    if (key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      accept(index);
      return true;
    }
    if (key === 'Tab' && !event.shiftKey && acceptTab) {
      event.preventDefault();
      event.stopPropagation();
      accept(index);
      return true;
    }
    if (key === 'Escape') {
      /* Escape **只关菜单**，绝不继续冒泡到 app.js 的 stop()。 */
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
      return true;
    }
    /* 其它键（字母、Backspace、Shift+Enter…）放行，让输入正常发生；
     * 输入事件回来后会重新 `refresh()`。 */
    return false;
  }

  /* ---------- 执行 ---------- */

  function removeToken(trig) {
    const value = input.value;
    if (!trig || trig.start < 0 || trig.end > value.length || trig.start > trig.end) return;
    const next = value.slice(0, trig.start) + value.slice(trig.end);
    input.value = next;
    const caret = trig.start;
    try { input.setSelectionRange(caret, caret); } catch { /* 某些类型不支持 */ }
    /* 用真实 input 事件驱动既有链路（composer.autoGrow / updateSendState / 草稿），
     * 不直接调别人的模块，避免两份真相。 */
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } catch {
      /* 老引擎构造 Event 差异 —— 状态刷新少一次不影响正确性 */
    }
  }

  /**
   * 接受第 i 个候选。
   * @param {number} i
   * @param {{force?: boolean}} opts force=true 时忽略「菜单开着」检查（测试用）
   */
  function accept(i, opts = {}) {
    const picked = items[i];
    if (!picked) return false;
    const current = parseSlashTrigger(input.value, input.selectionStart) || trigger;
    /* 命令可能在菜单打开的这段时间里变得不可用（会话/项目切换、run 结束…）。
     * 绝不拿旧候选直接执行 —— 重新问一次注册表，按 id 找当前仍可执行的实例。 */
    let fresh = null;
    try {
      const ctx = { ...getContext(), query: current ? current.query : '' };
      fresh = listCommands(ctx).find((c) => c.id === picked.id) || null;
    } catch (err) {
      onError(err);
    }
    /* 先把输入里那截 `/命令` 去掉，再关菜单、再执行：执行可能开弹层/切视图，
     * 留着文字会像「没执行成功」。 */
    if (current) removeToken(current);
    close({ restoreFocus: true });
    if (!fresh) {
      /* 命令已不可用：什么都不做（更不会伪造任何 RPC）。 */
      if (!opts.force) return false;
      return false;
    }
    try {
      fresh.run({ ...getContext(), query: current ? current.query : '' });
    } catch (err) {
      onError(err);
    }
    return true;
  }

  /* ---------- 事件绑定 ---------- */

  function onInput() { refresh(); }
  function onCompositionStart() { composing = true; close(); }
  function onCompositionEnd() { composing = false; refresh(); }
  function onDocMouseDown(event) {
    if (!open) return;
    if (menuEl && menuEl.contains(event.target)) return;
    if (event.target === input) return;
    close();
  }
  function onWorkspaceSwitch() { close(); }
  /* 会话换掉（新建 / 切换 / 分叉）时，当前待选命令属于**上一条会话**，
   * 必须立刻关闭并清掉活动候选 —— 注意这条事件在**同一 workspaceGeneration 内**
   * 也会触发（`afterSessionSwitch` 不递增代次），所以不能只靠 workspace-generation。 */
  function onSessionSwitch() { close(); }
  /* 中央视图离开 Classic Chat（Planner / Runtime / Extensions）时关闭；
   * 回到 chat 时**不自动打开**（用户没敲 `/` 就不该弹）。 */
  function onWorkspaceView(event) {
    const view = event && event.detail ? event.detail.view : null;
    if (view && view !== 'chat') close();
  }
  function onResize() { if (open) position(); }
  function onScopedKeydown(event) {
    if (event.target !== input) return;
    handleKeydown(event);
  }

  /** 安装监听与 DOM。可重复调用（幂等）。 */
  function attach(el) {
    if (attached) return controller;
    if (injectStyles) ensureStylesheet(doc);
    build();
    if (el && el.isConnected !== false) {
      /* 允许集成方指定挂载点；换了就把菜单搬过去。 */
      if (el !== host) { el.appendChild(menuEl); host = el; }
    }
    input.addEventListener('input', onInput);
    input.addEventListener('compositionstart', onCompositionStart);
    input.addEventListener('compositionend', onCompositionEnd);
    doc.addEventListener('mousedown', onDocMouseDown, true);
    doc.addEventListener('pi-gui:workspace-generation', onWorkspaceSwitch);
    doc.addEventListener('pi-gui:session-switch', onSessionSwitch);
    doc.addEventListener('pi-gui:workspace-view', onWorkspaceView);
    const win = doc.defaultView;
    if (win) win.addEventListener('resize', onResize);
    attached = true;
    return controller;
  }

  /**
   * 可选：把 keydown 监听挂到 scopeEl（默认 input 的 .composer 祖先）的捕获阶段。
   * 这是给「没法改 app.js keydown handler」的宿主的兜底；能改 handler 的始终推荐
   * 在原有分支前调用 `handleKeydown` 并 return。菜单没开时本监听什么都不做。
   */
  function bindKeyboard(scopeEl) {
    if (keyScope && keyScope !== scopeEl) {
      keyScope.removeEventListener('keydown', onScopedKeydown, true);
      keyScope = null;
    }
    const scope = scopeEl || (input.closest && input.closest('.composer')) || input.parentElement || input;
    keyScope = scope;
    scope.addEventListener('keydown', onScopedKeydown, true);
    return () => {
      if (keyScope) keyScope.removeEventListener('keydown', onScopedKeydown, true);
      keyScope = null;
    };
  }

  /** 拆掉所有监听、DOM 与缓存状态。之后可以重新 attach。 */
  function destroy() {
    close({ restoreFocus: false });
    input.removeEventListener('input', onInput);
    input.removeEventListener('compositionstart', onCompositionStart);
    input.removeEventListener('compositionend', onCompositionEnd);
    doc.removeEventListener('mousedown', onDocMouseDown, true);
    doc.removeEventListener('pi-gui:workspace-generation', onWorkspaceSwitch);
    doc.removeEventListener('pi-gui:session-switch', onSessionSwitch);
    doc.removeEventListener('pi-gui:workspace-view', onWorkspaceView);
    const win = doc.defaultView;
    if (win) win.removeEventListener('resize', onResize);
    if (keyScope) {
      keyScope.removeEventListener('keydown', onScopedKeydown, true);
      keyScope = null;
    }
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    listEl = null;
    emptyEl = null;
    host = null;
    items = [];
    trigger = null;
    index = 0;
    open = false;
    composing = false;
    attached = false;
    setInputAria(false);
  }

  const controller = {
    attach,
    bindKeyboard,
    handleKeydown,
    refresh,
    close,
    destroy,
    isOpen: () => open,
    isComposing: () => composing,
    items: () => items.slice(),
    activeIndex: () => index,
    activeCommand: () => items[index] || null,
    query: () => (trigger ? trigger.query : null),
    menuElement: () => menuEl,
    listElement: () => listEl,
    input,
  };
  return controller;
}
