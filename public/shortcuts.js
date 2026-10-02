/* P24 快捷键注册表 —— **全应用唯一的键盘入口**。
 *
 * ---------- 为什么要有它 ----------
 *
 * P24 之前，键盘处理散在四个地方：`app.js` 的输入框 keydown、`modal.js` 的
 * document capture 监听、`app.js` 的 Escape 分支、`conversation-nav.js` 自己的。
 * 加一个快捷键要去猜「有没有人已经占了」，冲突永远只能靠用户发现。
 *
 * 现在：**只有这一个 document 监听器**负责分发。模块要加键位就 `registerShortcut()`，
 * 重复键位在注册时就报错（`assertNoConflicts()` 在装配末尾跑一次）。
 *
 * ---------- 三条纪律 ----------
 *
 * 1. **不抢普通文本输入。** 不带修饰键的组合（以及单字符）在
 *    input / textarea / contenteditable 里一律不触发 —— 用户打字时按 `?`
 *    是想输入问号，不是想看帮助。带 Ctrl/Alt/Meta 的组合照常生效。
 * 2. **危险动作不能被快捷键绕过确认。** 注册表只负责「按键 → 调用已有动作」，
 *    动作内部的确认流程（`confirmModal`）原样保留；这里不提供任何 `skipConfirm`。
 * 3. **可发现。** 每个键位都有 label 与 group，帮助面板（`ui/shortcut-help.js`）
 *    直接从注册表渲染，并按当前平台显示（Windows/Linux 是 Ctrl，macOS 是 ⌘）。
 *
 * 与 `modal.js` 的关系：那边的 trapTab / Esc 用的是 **capture:true**，
 * 这里用默认的冒泡阶段 —— 弹层开着时弹层先处理，并且会 `stopPropagation()`，
 * 所以「Esc 关弹层」永远优先于这里的任何绑定。
 *
 * ⚠️ 本文件**刻意不 import 任何碰 DOM 的模块**（帮助面板在 `ui/shortcut-help.js`）：
 * 注册表与匹配逻辑要能离线单测，见 `tests/daily-use.cjs`。
 */

/** 当前平台是不是 mac（只影响显示与 primary 修饰键）。 */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

/** `primary` 在 mac 上是 ⌘，别处是 Ctrl。 */
const PRIMARY = IS_MAC ? 'meta' : 'ctrl';

/** id -> def。 */
const registry = new Map();

export function normalizeCombo(combo) {
  if (typeof combo !== 'string') return null;
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const modifiers = new Set();
  let key = '';
  for (const part of parts) {
    if (part === 'primary') modifiers.add(PRIMARY);
    else if (part === 'ctrl' || part === 'control') modifiers.add('ctrl');
    else if (part === 'meta' || part === 'cmd' || part === 'command') modifiers.add('meta');
    else if (part === 'alt' || part === 'option') modifiers.add('alt');
    else if (part === 'shift') modifiers.add('shift');
    else key = part;
  }
  if (!key) return null;
  const order = ['ctrl', 'meta', 'alt', 'shift'];
  return [...order.filter((m) => modifiers.has(m)), key].join('+');
}

/** 事件 → 组合串（与 normalizeCombo 同一套写法，便于比较）。 */
export function comboFromEvent(event) {
  if (!event || typeof event.key !== 'string') return null;
  // 只有修饰键自己按下时不算一个组合
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return null;
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.metaKey) parts.push('meta');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

/** 把组合串渲染成人看的写法（按平台）。 */
export function formatCombo(combo) {
  const normalized = normalizeCombo(combo);
  if (!normalized) return '';
  const names = IS_MAC
    ? { ctrl: '⌃', meta: '⌘', alt: '⌥', shift: '⇧' }
    : { ctrl: 'Ctrl', meta: 'Win', alt: 'Alt', shift: 'Shift' };
  const parts = normalized.split('+');
  const key = parts.pop();
  const display =
    { '/': '/', space: 'Space', arrowup: '↑', arrowdown: '↓', enter: 'Enter', escape: 'Esc', '?': '?' }[key]
    || key.toUpperCase();
  if (IS_MAC) return parts.map((p) => names[p]).join('') + display;
  return [...parts.map((p) => names[p]), display].join('+');
}

/** 焦点是不是在「会吃掉按键」的文本输入里。 */
export function isTextEntry(node) {
  if (!node || typeof node !== 'object') return false;
  const tag = String(node.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = String(node.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes(type);
  }
  return node.isContentEditable === true;
}

/**
 * 注册一个快捷键。
 *
 * @param def.id     稳定 id（帮助面板与测试都用它）
 * @param def.combo  `'primary+k'` / `'alt+1'` / `'primary+/'` —— `primary` 按平台解析
 * @param def.label  人看的说明（中文，动作语义）
 * @param def.group  帮助面板里的分组
 * @param def.when   额外条件（返回 false 时不触发，也不显示在帮助里）
 * @param def.inInput 允许在文本框里触发（默认 false；带修饰键的也不建议开）
 * @param def.run    真正的动作 —— **必须复用已有 handler，不复制业务逻辑**
 */
export function registerShortcut(def) {
  if (!def || typeof def.id !== 'string' || !def.id) throw new Error('shortcut 需要 id');
  const combo = normalizeCombo(def.combo);
  if (!combo) throw new Error(`shortcut ${def.id} 的 combo 无法解析：${def.combo}`);
  if (typeof def.run !== 'function') throw new Error(`shortcut ${def.id} 需要 run()`);
  if (registry.has(def.id)) throw new Error(`shortcut id 重复：${def.id}`);
  registry.set(def.id, {
    id: def.id,
    combo,
    label: def.label || def.id,
    group: def.group || '通用',
    when: typeof def.when === 'function' ? def.when : null,
    inInput: def.inInput === true,
    run: def.run,
  });
  return registry.get(def.id);
}

/** 同一个组合被注册两次就是冲突 —— 装配末尾跑一次，早失败好过用户发现。 */
export function assertNoConflicts() {
  const byCombo = new Map();
  for (const def of registry.values()) {
    const other = byCombo.get(def.combo);
    if (other) throw new Error(`快捷键冲突：${formatCombo(def.combo)} 同时绑给 ${other.id} 与 ${def.id}`);
    byCombo.set(def.combo, def);
  }
  return true;
}

export function listShortcuts() {
  return [...registry.values()].map((def) => ({
    ...def,
    display: formatCombo(def.combo),
    available: def.when ? Boolean(def.when()) : true,
  }));
}

export function shortcutFor(id) {
  return registry.get(id) || null;
}

/** 只给测试用：清空注册表。 */
export function resetShortcuts() {
  registry.clear();
}

/**
 * 分发一次按键。
 * @returns 命中的 def（已执行）或 null
 */
export function dispatchShortcut(event, scope = {}) {
  if (!event || event.defaultPrevented) return null;
  const combo = comboFromEvent(event);
  if (!combo) return null;
  for (const def of registry.values()) {
    if (def.combo !== combo) continue;
    /* **不抢普通文本输入**：焦点在文本框里时，只有带 Ctrl/Alt/Meta 的组合才触发。
     * 不带修饰键的键位（`?`、字母、空格）是「打字」，一律让给输入框 ——
     * 除非那条键位显式声明 `inInput: true`。
     *
     * 注意：带修饰键的组合**在输入框里也要生效** —— Ctrl+K 打开面板、Alt+1 切视图
     * 这些最常见的用法，恰恰是用户正在写消息的时候按的。所以这里判的是
     * 「有没有修饰键」，不是「在不在输入框」。 */
    if (isTextEntry(event.target)) {
      const hasModifier = Boolean(event.ctrlKey || event.metaKey || event.altKey);
      if (!hasModifier && !def.inInput) return null;
    }
    if (def.when && !def.when(scope)) return null;
    event.preventDefault();
    def.run(scope);
    return def;
  }
  return null;
}

/** 装唯一的那个监听器。重复调用只装一次。 */
let installed = false;
export function installShortcuts(scope = {}) {
  if (installed) return false;
  installed = true;
  document.addEventListener('keydown', (event) => {
    dispatchShortcut(event, scope);
  });
  return true;
}
