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
 *    F1–F12 不是打字键，在输入框里也照常生效。
 * 2. **危险动作不能被快捷键绕过确认。** 注册表只负责「按键 → 调用已有动作」，
 *    动作内部的确认流程（`confirmModal`）原样保留；这里不提供任何 `skipConfirm`。
 * 3. **可发现、可改。** 每个键位都有 label 与 group，设置页
 *    （`ui/shortcut-help.js`）直接从注册表渲染，并按当前平台显示。
 *    用户覆盖值按 **三态** 保存：没有条目 = 用默认值，字符串 = 自定义，
 *    `null` = 明确禁用（ADR 0148 的语义）。**绝不用空字符串表示禁用。**
 *
 * ---------- 覆盖值与真实分发 ----------
 *
 * `dispatchShortcut()` 比较的是 `effectiveCombo`，不是注册时的 `def.combo`。
 * 因此设置页保存后**不需要重启**：新键位立刻生效，旧键位立刻失效。
 * 覆盖值只存在 `pi-gui.keybindings.v1` 一个版本化键里，结构是
 * `{ shortcutId: string | null }`；主题、字体等设置各有自己的键，互不覆盖。
 *
 * 与 `modal.js` 的关系：那边的 trapTab / Esc 用的是 **capture:true**，
 * 这里用默认的冒泡阶段 —— 弹层开着时弹层先处理，并且会 `stopPropagation()`，
 * 所以「Esc 关弹层」永远优先于这里的任何绑定。
 *
 * ⚠️ 本文件**刻意不 import 任何碰 DOM 的模块**（设置页在 `ui/shortcut-help.js`）：
 * 注册表与匹配逻辑要能离线单测，见 `tests/daily-use.cjs` / `tests/shortcut-settings.cjs`。
 */

/** 当前平台是不是 mac（只影响显示与 primary 修饰键）。 */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

/** `primary` 在 mac 上是 ⌘，别处是 Ctrl。 */
const PRIMARY = IS_MAC ? 'meta' : 'ctrl';

/** 覆盖值的唯一存储键。改动结构时升版本号，不要就地改旧键的含义。 */
export const KEYBINDINGS_STORAGE_KEY = 'pi-gui.keybindings.v1';

const MODIFIER_ORDER = ['ctrl', 'meta', 'alt', 'shift'];

/** 单独的修饰键 / 锁定键永远不是一个组合。 */
const MODIFIER_KEYS = new Set([
  'control', 'meta', 'alt', 'shift', 'altgraph', 'capslock', 'fn', 'fnlock',
  'hyper', 'super', 'symbol', 'symbollock', 'os',
]);

/** 死键、输入法处理键、未识别键：不能拿来当快捷键。 */
const DEAD_KEYS = new Set(['dead', 'process', 'compose']);

const NAMED_KEYS = new Set([
  'space', 'enter', 'tab', 'backspace', 'delete', 'insert', 'home', 'end',
  'pageup', 'pagedown', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
]);

const PUNCTUATION_KEYS = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/']);

/* 终端（xterm）自己会消费的控制键。pi-GUI 的默认键位里 Ctrl+K / Ctrl+P /
 * Ctrl+/ 与 readline 冲突，所以焦点在终端里时让给终端；Ctrl+Shift+P 仍可
 * 打开命令面板。这里只挡这些明确的控制键，不挡 Alt+1..4 这类应用级视图键。 */
const TERMINAL_CONTROLS = new Set([
  'ctrl+a', 'ctrl+b', 'ctrl+c', 'ctrl+d', 'ctrl+e', 'ctrl+f', 'ctrl+h', 'ctrl+k',
  'ctrl+l', 'ctrl+n', 'ctrl+p', 'ctrl+r', 'ctrl+u', 'ctrl+w', 'ctrl+y', 'ctrl+z',
  'ctrl+/', 'ctrl+shift+c', 'ctrl+shift+v', 'ctrl+insert', 'shift+insert',
]);

/** Shift 会改变字符的符号 → 物理基础键。 */
const SHIFTED_SYMBOLS = new Map([
  ['!', '1'], ['@', '2'], ['#', '3'], ['$', '4'], ['%', '5'], ['^', '6'], ['&', '7'], ['*', '8'], ['(', '9'], [')', '0'],
  ['_', '-'], ['+', '='], ['{', '['], ['}', ']'], ['|', '\\'], [':', ';'], ['"', "'"], ['<', ','], ['>', '.'], ['?', '/'], ['~', '`'],
]);

/** 手写 / 旧存储里可能出现的物理键名。 */
const KEY_ALIASES = new Map([
  ['esc', 'escape'], ['return', 'enter'], ['spacebar', 'space'], ['del', 'delete'], ['ins', 'insert'],
  ['pgup', 'pageup'], ['pgdn', 'pagedown'], ['up', 'arrowup'], ['down', 'arrowdown'],
  ['left', 'arrowleft'], ['right', 'arrowright'], ['equal', '='], ['minus', '-'], ['comma', ','],
  ['period', '.'], ['slash', '/'], ['backquote', '`'], ['backslash', '\\'], ['bracketleft', '['],
  ['bracketright', ']'], ['semicolon', ';'], ['quote', "'"],
]);

/** event.code → 规范键名。只在 event.key 不可用时兜底（见 keyFromEvent）。 */
const CODE_KEYS = new Map([
  ['Backquote', '`'], ['Minus', '-'], ['Equal', '='], ['BracketLeft', '['], ['BracketRight', ']'],
  ['Backslash', '\\'], ['Semicolon', ';'], ['Quote', "'"], ['Comma', ','], ['Period', '.'],
  ['Slash', '/'], ['Space', 'space'], ['Enter', 'enter'], ['Tab', 'tab'], ['Backspace', 'backspace'],
  ['Delete', 'delete'], ['Insert', 'insert'], ['Home', 'home'], ['End', 'end'], ['PageUp', 'pageup'],
  ['PageDown', 'pagedown'], ['ArrowUp', 'arrowup'], ['ArrowDown', 'arrowdown'],
  ['ArrowLeft', 'arrowleft'], ['ArrowRight', 'arrowright'], ['Escape', 'escape'],
]);

/* 保留组合：录制时直接拒绝。这里放的是**系统、编辑器、终端、Electron 主进程**
 * 已经占用的键位；pi-GUI 自己的默认键位（Ctrl+K / Ctrl+P / Ctrl+Shift+G /
 * Ctrl+/ / Ctrl+` / Alt+1..4 / Ctrl+Shift+P）**不在其中**。 */
const RESERVED_COMMON = new Set([
  // 文本编辑 / 终端控制
  'ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+shift+v', 'ctrl+x', 'ctrl+z', 'ctrl+shift+z', 'ctrl+y',
  'ctrl+insert', 'shift+insert',
  'ctrl+backspace', 'ctrl+delete', 'ctrl+enter', 'ctrl+shift+enter',
  'ctrl+alt+delete', 'ctrl+shift+delete',
  'ctrl+arrowleft', 'ctrl+arrowright', 'ctrl+arrowup', 'ctrl+arrowdown',
  'ctrl+home', 'ctrl+end', 'ctrl+pageup', 'ctrl+pagedown',
  'ctrl+tab', 'ctrl+shift+tab', 'ctrl+space', 'alt+space',
  'alt+arrowleft', 'alt+arrowright', 'alt+home',
  // 查找 / 保存 / 刷新 / 终端清屏等
  'ctrl+f', 'ctrl+g', 'ctrl+h', 'ctrl+s', 'ctrl+r', 'ctrl+shift+r', 'ctrl+u', 'ctrl+d', 'ctrl+l',
  // 窗口 / 浏览器 / 标签页
  'ctrl+q', 'ctrl+w', 'ctrl+shift+w', 'ctrl+n', 'ctrl+shift+n', 'ctrl+t', 'ctrl+shift+t',
  'ctrl+1', 'ctrl+2', 'ctrl+3', 'ctrl+4', 'ctrl+5', 'ctrl+6', 'ctrl+7', 'ctrl+8', 'ctrl+9',
  // 缩放 / 开发者工具 / 系统
  'ctrl+0', 'ctrl+=', 'ctrl+shift+=', 'ctrl+-', 'ctrl+shift+-',
  'f5', 'f11', 'f12', 'ctrl+shift+i', 'ctrl+shift+j', 'ctrl+shift+c',
  'alt+f4', 'alt+tab', 'alt+shift+tab',
]);

const RESERVED_MAC = new Set([
  // macOS 文本编辑 / 窗口
  'meta+a', 'meta+c', 'meta+v', 'meta+shift+v', 'meta+x', 'meta+z', 'meta+shift+z',
  'meta+backspace', 'meta+delete', 'meta+arrowleft', 'meta+arrowright',
  'meta+arrowup', 'meta+arrowdown', 'meta+home', 'meta+end', 'meta+pageup', 'meta+pagedown',
  'meta+q', 'meta+w', 'meta+shift+w', 'meta+n', 'meta+shift+n', 'meta+t', 'meta+shift+t',
  'meta+1', 'meta+2', 'meta+3', 'meta+4', 'meta+5', 'meta+6', 'meta+7', 'meta+8', 'meta+9',
  'meta+f', 'meta+g', 'meta+s', 'meta+r', 'meta+shift+r', 'meta+m', 'meta+h', 'meta+alt+h',
  'meta+0', 'meta+=', 'meta+shift+=', 'meta+-', 'meta+shift+-',
  'meta+space', 'meta+tab', 'meta+shift+3', 'meta+shift+4', 'meta+shift+5',
  'meta+shift+i', 'meta+shift+j', 'meta+shift+c', 'meta+ctrl+f', 'meta+ctrl+q',
  // macOS 的 Mission Control / 输入法 / 终端 Emacs 键
  'ctrl+arrowleft', 'ctrl+arrowright', 'ctrl+arrowup', 'ctrl+arrowdown',
  'ctrl+space', 'ctrl+a', 'ctrl+b', 'ctrl+d', 'ctrl+e', 'ctrl+f', 'ctrl+h', 'ctrl+k',
  'ctrl+n', 'ctrl+p', 'ctrl+u', 'ctrl+w', 'ctrl+y',
]);

/** id -> def。 */
const registry = new Map();

/** id -> 规范化后的组合串 | null。没有条目 = 默认值。 */
let overrides = new Map();

/** 测试 / 嵌入宿主可以注入一个 localStorage 形状的存储。 */
let storageAdapter = null;

/** 设置页与工作面板入口订阅覆盖值变化。 */
const listeners = new Set();

/** 检测同步写入期间的重入（localStorage 本身是同步的，正常不会触发）。 */
let commitSerial = 0;

function isKeyToken(key) {
  if (key === 'space') return true;
  if (/^[a-z0-9]$/.test(key)) return true;
  if (PUNCTUATION_KEYS.has(key)) return true;
  if (/^f([1-9]|1[0-2])$/.test(key)) return true;
  return NAMED_KEYS.has(key);
}

/**
 * 规范化组合串。
 *
 * - 修饰键顺序固定为 ctrl → meta → alt → shift；
 * - `primary` 按平台解析；
 * - `!` / `+` / `?` 等 Shift 符号折回基础键并补上 shift，
 *   于是 `ctrl+?` 与 `ctrl+shift+/` 是同一个键；
 * - 畸形值回 null，不抛异常、不猜。
 */
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
    else if (part === 'meta' || part === 'cmd' || part === 'command' || part === 'win' || part === 'super') modifiers.add('meta');
    else if (part === 'alt' || part === 'option' || part === 'opt') modifiers.add('alt');
    else if (part === 'shift') modifiers.add('shift');
    else {
      // 两个非修饰键（ctrl+k+j）不是组合，直接判畸形。
      if (key) return null;
      key = KEY_ALIASES.get(part) || part;
    }
  }
  if (!key) return null;
  const shifted = SHIFTED_SYMBOLS.get(key);
  if (shifted) {
    modifiers.add('shift');
    key = shifted;
  }
  // Escape 是「取消」这个上下文动作，不能绑给业务快捷键；
  // 允许它会让设置页的取消与注册表分发互相打架。
  if (key === 'escape') return null;
  if (!isKeyToken(key)) return null;
  return [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), key].join('+');
}

/** 从 event.code 取规范键名。只处理已知键，不猜。 */
function keyFromCode(code) {
  if (typeof code !== 'string' || !code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  return CODE_KEYS.get(code) || null;
}

/**
 * event → 规范键名 + 这个字符是否隐含 Shift。
 *
 * **以 event.key 为主**：Ctrl+/、Ctrl+`、Ctrl+Shift+P 这些旧默认在任何
 * 键盘布局下都保持用户按下的字符；event.code 只在 key 为
 * Unidentified / 空值时兜底，并用于提前挡掉修饰键、小键盘和死键。
 * 这样既不会因为 code 的物理键名把 Ctrl+/ 变成 Ctrl+Shift+7，
 * 也能在合成事件缺少 key 时识别出键位。
 */
function keyFromEvent(event) {
  const raw = typeof event.key === 'string' ? event.key : '';
  if (raw === 'Dead' || DEAD_KEYS.has(raw.toLowerCase())) return null;
  if (raw === 'Unidentified' || raw === '') {
    const fromCode = keyFromCode(event.code);
    return fromCode ? { key: fromCode, shift: false } : null;
  }
  if (raw === ' ' || raw === 'Spacebar') return { key: 'space', shift: false };
  if (raw.length === 1) {
    const lower = raw.toLowerCase();
    const shifted = SHIFTED_SYMBOLS.get(lower);
    if (shifted) return { key: shifted, shift: true };
    if (isKeyToken(lower)) return { key: lower, shift: false };
    return null;
  }
  const lower = raw.toLowerCase();
  const alias = KEY_ALIASES.get(lower);
  if (alias) {
    if (alias === 'escape') return null;
    return { key: alias, shift: false };
  }
  if (isKeyToken(lower)) return { key: lower, shift: false };
  const fromCode = keyFromCode(event.code);
  return fromCode && fromCode !== 'escape' ? { key: fromCode, shift: false } : null;
}

/**
 * 事件 → 组合串（与 normalizeCombo 同一套写法，便于比较）。
 *
 * 只按修饰键、死键、AltGr、小键盘、输入法正在组合时都回 null。
 * 连发的 keydown 仍然返回组合串 —— 由 dispatch 决定忽略，
 * 这样录制器可以先看清事件、再决定是否提交。
 */
export function comboFromEvent(event) {
  if (!event) return null;
  if (event.isComposing || event.keyCode === 229) return null;
  const code = typeof event.code === 'string' ? event.code : '';
  if (/^(Alt|Control|Meta|Shift)(Left|Right)$/.test(code)) return null;
  if (code.startsWith('Numpad') || event.location === 3) return null;
  const raw = typeof event.key === 'string' ? event.key : '';
  if (raw && MODIFIER_KEYS.has(raw.toLowerCase())) return null;
  if (raw && DEAD_KEYS.has(raw.toLowerCase())) return null;
  if (typeof event.getModifierState === 'function') {
    try {
      if (event.getModifierState('AltGraph')) return null;
    } catch {
      /* 合成事件没有实现完整接口时忽略 */
    }
  }
  const info = keyFromEvent(event);
  if (!info) return null;
  const modifiers = new Set();
  if (event.ctrlKey) modifiers.add('ctrl');
  if (event.metaKey) modifiers.add('meta');
  if (event.altKey) modifiers.add('alt');
  if (event.shiftKey || info.shift) modifiers.add('shift');
  return [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), info.key].join('+');
}

/** 组合串 → 人看的键帽片段（不含分隔符）。 */
export function formatComboParts(combo) {
  const normalized = normalizeCombo(combo);
  if (!normalized) return [];
  const names = IS_MAC
    ? { ctrl: '⌃', meta: '⌘', alt: '⌥', shift: '⇧' }
    : { ctrl: 'Ctrl', meta: 'Win', alt: 'Alt', shift: 'Shift' };
  const parts = normalized.split('+');
  const key = parts.pop();
  const special = {
    space: 'Space', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
    insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
    arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  };
  const display = special[key] || key.toUpperCase();
  return [...parts.map((p) => names[p]), display];
}

/** 把组合串渲染成人看的写法（按平台；mac 紧凑，其余用 +）。 */
export function formatCombo(combo) {
  const parts = formatComboParts(combo);
  if (!parts.length) return '';
  return IS_MAC ? parts.join('') : parts.join('+');
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

/** 焦点是不是在 xterm 终端里（它的隐藏 textarea 位于 .xterm 内）。 */
export function isTerminalEntry(node) {
  if (!node || typeof node.closest !== 'function') return false;
  try {
    return Boolean(node.closest('.xterm'));
  } catch {
    return false;
  }
}

/** 两个组合是不是同一个键：顺序、Shift 等价符号都算。 */
export function keybindingsConflict(left, right) {
  const a = normalizeCombo(left);
  const b = normalizeCombo(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return physicalSignature(a) === physicalSignature(b);
}

/** 标点键的 Shift 版本和原键共享物理键；字母/数字/F 键保留 Shift 语义。 */
function physicalSignature(combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  if (!PUNCTUATION_KEYS.has(key)) return combo;
  return [...parts.filter((p) => p !== 'shift'), key].join('+');
}

/**
 * 这个组合是否允许用户绑定。
 *
 * 普通字母 / 数字必须带 Ctrl、Alt 或 Meta（Shift 单独不算）；
 * F1–F12 可以单独使用。Windows/Linux 上 Meta（Win 键）留给系统。
 */
export function isAllowedKeybinding(combo, platform = IS_MAC ? 'mac' : 'other') {
  const normalized = normalizeCombo(combo);
  if (!normalized) return false;
  const parts = normalized.split('+');
  const key = parts.pop();
  const modifiers = new Set(parts);
  if (key === 'escape') return false;
  if (platform !== 'mac' && modifiers.has('meta')) return false;
  if (/^f([1-9]|1[0-2])$/.test(key)) return true;
  return ['ctrl', 'meta', 'alt'].some((m) => modifiers.has(m));
}

/**
 * 系统 / 编辑器 / 终端 / Electron 已经占用的组合。
 * 禁用键位不参与冲突判断，所以这里只回答「这个组合本身能不能用」。
 */
export function isReservedKeybinding(combo, platform = IS_MAC ? 'mac' : 'other') {
  const normalized = normalizeCombo(combo);
  if (!normalized) return false;
  if (platform !== 'mac' && normalized.split('+').includes('meta')) return true;
  if (RESERVED_COMMON.has(normalized)) return true;
  return platform === 'mac' ? RESERVED_MAC.has(normalized) : false;
}

/**
 * 注册一个快捷键。
 *
 * @param def.id     稳定 id（设置页、持久化与测试都用它）
 * @param def.combo  `'primary+k'` / `'alt+1'` / `'primary+/'` —— `primary` 按平台解析
 * @param def.label  人看的说明（中文，动作语义）
 * @param def.group  设置页里的分组
 * @param def.when   额外条件（返回 false 时不触发，也不显示在帮助里）
 * @param def.inInput 允许在文本框里用普通键触发（默认 false；带修饰键的也不建议开）
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
    defaultCombo: combo,
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
  const defs = [...registry.values()];
  for (let i = 0; i < defs.length; i += 1) {
    for (let j = i + 1; j < defs.length; j += 1) {
      if (keybindingsConflict(defs[i].defaultCombo, defs[j].defaultCombo)) {
        throw new Error(`快捷键冲突：${formatCombo(defs[i].defaultCombo)} 同时绑给 ${defs[i].id} 与 ${defs[j].id}`);
      }
    }
  }
  return true;
}

/**
 * 一个 id 当前真正生效的组合。三态解析的唯一实现。
 * 无效 / 保留的覆盖值回退默认值（加载时也会被清洗，这里是最后一道保险）。
 */
export function resolveShortcutCombo(id, map = overrides) {
  const def = registry.get(id);
  if (!def) return null;
  if (map.has(id)) {
    const value = map.get(id);
    if (value === null) return null;
    const normalized = normalizeCombo(value);
    if (!normalized || !isAllowedKeybinding(normalized) || isReservedKeybinding(normalized)) return def.defaultCombo;
    return normalized;
  }
  return def.defaultCombo;
}

/** 设置页一行的完整状态。 */
export function shortcutState(id) {
  const def = registry.get(id);
  if (!def) return null;
  const customized = overrides.has(id);
  const disabled = customized && overrides.get(id) === null;
  const effectiveCombo = resolveShortcutCombo(id);
  return {
    id: def.id,
    label: def.label,
    group: def.group,
    defaultCombo: def.defaultCombo,
    effectiveCombo,
    disabled,
    customized,
    display: effectiveCombo ? formatCombo(effectiveCombo) : '未绑定',
    defaultDisplay: formatCombo(def.defaultCombo),
    available: def.when ? Boolean(def.when()) : true,
  };
}

export function listShortcuts() {
  return [...registry.values()].map((def) => ({ ...def, ...shortcutState(def.id) }));
}

export function shortcutFor(id) {
  const def = registry.get(id);
  return def ? { ...def, ...shortcutState(id) } : null;
}

/** 当前有没有任何覆盖值（设置页的「恢复默认」按钮据此禁用）。 */
export function hasShortcutOverrides() {
  return overrides.size > 0;
}

/** 覆盖值的只读快照（给测试 / 诊断用）。 */
export function getShortcutOverrides() {
  const out = {};
  for (const [id, value] of overrides) out[id] = value;
  return out;
}

/** 找到与 combo 冲突的另一条**生效中**的键位。禁用键位返回 null，不参与。 */
export function findShortcutConflict(id, combo, map = overrides) {
  const normalized = normalizeCombo(combo);
  if (!normalized) return null;
  for (const def of registry.values()) {
    if (def.id === id) continue;
    const other = resolveShortcutCombo(def.id, map);
    if (!other) continue;
    if (keybindingsConflict(normalized, other)) {
      return { id: def.id, label: def.label, combo: other, display: formatCombo(other) };
    }
  }
  return null;
}

/** 给测试 / 嵌入宿主注入 localStorage 形状的存储。 */
export function configureShortcutStorage(store) {
  storageAdapter = store && typeof store.getItem === 'function' && typeof store.setItem === 'function'
    ? store
    : null;
  return storageAdapter;
}

function resolveStore(store) {
  if (store && typeof store.getItem === 'function' && typeof store.setItem === 'function') return store;
  if (storageAdapter) return storageAdapter;
  try {
    const local = globalThis.localStorage;
    return local && typeof local.getItem === 'function' && typeof local.setItem === 'function' ? local : null;
  } catch {
    return null;
  }
}

function serializeOverrides(map) {
  const payload = {};
  for (const id of registry.keys()) {
    if (map.has(id)) payload[id] = map.get(id);
  }
  return JSON.stringify(payload);
}

function writeOverrides(map, store) {
  const target = resolveStore(store);
  if (!target) return { ok: false, reason: 'storage', error: new Error('localStorage unavailable') };
  const serial = ++commitSerial;
  try {
    target.setItem(KEYBINDINGS_STORAGE_KEY, serializeOverrides(map));
  } catch (error) {
    return { ok: false, reason: 'storage', error };
  }
  // 正常路径不会发生：setItem 是同步的，不存在两个写入交错。保留这个检查，
  // 是为了让任何宿主注入的异步入队存储也不会让旧写入覆盖新状态。
  if (serial !== commitSerial) return { ok: false, reason: 'superseded' };
  return { ok: true };
}

function notifyShortcuts(id = null) {
  const snapshot = { id, overrides: getShortcutOverrides() };
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch {
      /* 一个 UI 订阅者出错不能拖垮保存 */
    }
  }
}

/** 设置页 / 工作面板入口订阅覆盖值变化；返回取消订阅函数。 */
export function subscribeShortcuts(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 从存储加载覆盖值。**必须在注册完快捷键之后调用。**
 *
 * 只认已注册 id；字符串必须是可规范化、允许且不保留的值；
 * 未知 id、坏 JSON、非对象、无效值都静默忽略（回退默认值）。
 * 两个自定义值互相冲突时按注册顺序保留第一个，后面的回退默认值。
 * 禁用的 id 是 null，不参与冲突判断。
 *
 * 加载不写回存储：坏数据留在原处，下一次真正保存时会按注册表重新序列化。
 */
export function loadShortcutOverrides(store = null) {
  const target = resolveStore(store);
  if (!target) {
    overrides = new Map();
    notifyShortcuts();
    return getShortcutOverrides();
  }
  let raw = null;
  try {
    raw = target.getItem(KEYBINDINGS_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) {
    overrides = new Map();
    notifyShortcuts();
    return getShortcutOverrides();
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    overrides = new Map();
    notifyShortcuts();
    return getShortcutOverrides();
  }

  const next = new Map();
  // 第一遍：明确禁用（null）先落地，后面的冲突检查就不会把禁用键位算进去。
  for (const [id, value] of Object.entries(parsed)) {
    if (registry.has(id) && value === null) next.set(id, null);
  }
  // 第二遍：按注册顺序接收合法自定义值。
  for (const def of registry.values()) {
    const value = parsed[def.id];
    if (typeof value !== 'string') continue;
    const normalized = normalizeCombo(value);
    if (!normalized) continue;
    if (!isAllowedKeybinding(normalized) || isReservedKeybinding(normalized)) continue;
    if (normalized === def.defaultCombo) continue;
    if (findShortcutConflict(def.id, normalized, next)) continue;
    next.set(def.id, normalized);
  }
  overrides = next;
  notifyShortcuts();
  return getShortcutOverrides();
}

function bindingResult(id) {
  return { shortcut: shortcutFor(id), overrides: getShortcutOverrides() };
}

/**
 * 保存一个 id 的覆盖值。
 *
 * - `null`：禁用；
 * - 字符串：自定义；如果等于默认值，等价于删除覆盖值；
 * - 冲突 / 保留 / 不允许：**不写存储、不改内存**，返回原因，由设置页在行内展示。
 *
 * 写入顺序是「先存储、后内存」：写失败时 UI 与分发都还停留在旧状态，
 * 不会出现「界面显示新键、实际还是旧键」的半截状态。
 */
export function commitShortcutBinding(id, value, store = null) {
  const def = registry.get(id);
  if (!def) return { ok: false, reason: 'unknown' };
  if (value !== null && typeof value !== 'string') return { ok: false, reason: 'invalid' };

  const next = new Map(overrides);
  if (value === null) {
    next.set(id, null);
  } else {
    const normalized = normalizeCombo(value);
    if (!normalized) return { ok: false, reason: 'invalid' };
    /* 直接录回默认组合，语义与「单项恢复默认」相同：先检查默认值会不会
     * 与别的自定义键冲突，再删覆盖值。不能直接 delete —— 那会绕过检查，
     * 让两条动作落到同一个组合上。 */
    if (normalized === def.defaultCombo) {
      return resetShortcutBinding(id, store);
    }
    if (!isAllowedKeybinding(normalized)) return { ok: false, reason: 'modifier' };
    if (isReservedKeybinding(normalized)) return { ok: false, reason: 'reserved' };
    const conflict = findShortcutConflict(id, normalized, next);
    if (conflict) return { ok: false, reason: 'conflict', conflict };
    next.set(id, normalized);
  }

  if (sameOverrides(next, overrides)) {
    return { ok: true, unchanged: true, ...bindingResult(id) };
  }
  const write = writeOverrides(next, store);
  if (!write.ok) return write;
  overrides = next;
  notifyShortcuts(id);
  return { ok: true, ...bindingResult(id) };
}

/** 删除一个 id 的覆盖值，恢复默认；默认值若与其它生效键位冲突则拒绝。 */
export function resetShortcutBinding(id, store = null) {
  const def = registry.get(id);
  if (!def) return { ok: false, reason: 'unknown' };
  if (!overrides.has(id)) return { ok: true, unchanged: true, ...bindingResult(id) };
  const next = new Map(overrides);
  next.delete(id);
  const conflict = findShortcutConflict(id, def.defaultCombo, next);
  if (conflict) return { ok: false, reason: 'conflict', conflict };
  const write = writeOverrides(next, store);
  if (!write.ok) return write;
  overrides = next;
  notifyShortcuts(id);
  return { ok: true, ...bindingResult(id) };
}

/** 清空全部覆盖值，包括禁用项。 */
export function resetAllShortcutBindings(store = null) {
  if (!overrides.size) return { ok: true, unchanged: true, overrides: {} };
  const next = new Map();
  const write = writeOverrides(next, store);
  if (!write.ok) return write;
  overrides = next;
  notifyShortcuts();
  return { ok: true, overrides: {} };
}

function sameOverrides(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, value] of a) {
    if (!b.has(id) || b.get(id) !== value) return false;
  }
  return true;
}

/** 只给测试用：清空注册表、覆盖值与订阅者。存储适配器保留。 */
export function resetShortcuts() {
  registry.clear();
  overrides = new Map();
  listeners.clear();
  commitSerial = 0;
}

/**
 * 分发一次按键。
 *
 * - 比较当前 `effectiveCombo`，不是注册时的默认值；
 * - 连发（event.repeat）直接忽略；
 * - 输入法组合、AltGr、死键不会进入这里；
 * - 输入框里只有带 Ctrl/Alt/Meta 的组合或 F1–F12 才会触发；
 * - 同一个事件最多执行一个动作，命中后立即返回。
 *
 * @returns 命中的 def（已执行，combo 为实际生效值）或 null
 */
export function dispatchShortcut(event, scope = {}) {
  if (!event || event.defaultPrevented) return null;
  if (event.repeat) return null;
  const combo = comboFromEvent(event);
  if (!combo) return null;
  for (const def of registry.values()) {
    const effective = resolveShortcutCombo(def.id);
    if (!effective || effective !== combo) continue;
    /* 终端自己消费的控制键让给终端：xterm 的隐藏 textarea 也是 text entry，
     * 但带修饰键的组合默认会穿透输入守卫，Ctrl+K / Ctrl+P / Ctrl+/ 就会
     * 抢走 readline 的 kill-line / previous-history / undo。 */
    if (isTerminalEntry(event.target) && TERMINAL_CONTROLS.has(effective)) return null;
    /* **不抢普通文本输入**：焦点在文本框里时，只有带 Ctrl/Alt/Meta 的组合才触发。
     * 不带修饰键的键位（`?`、字母、空格）是「打字」，一律让给输入框 ——
     * 除非那条键位显式声明 `inInput: true`，或者它是 F1–F12。
     *
     * 注意：带修饰键的组合**在输入框里也要生效** —— Ctrl+K 打开面板、Alt+1 切视图
     * 这些最常见的用法，恰恰是用户正在写消息的时候按的。所以这里判的是
     * 「有没有修饰键」，不是「在不在输入框」。 */
    if (isTextEntry(event.target)) {
      const hasModifier = Boolean(event.ctrlKey || event.metaKey || event.altKey);
      const key = effective.split('+').pop();
      const functionKey = /^f([1-9]|1[0-2])$/.test(key);
      if (!hasModifier && !def.inInput && !functionKey) return null;
    }
    if (def.when && !def.when(scope)) return null;
    event.preventDefault();
    def.run(scope);
    return { ...def, combo: effective, effectiveCombo: effective };
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
