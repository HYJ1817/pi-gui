/* 快捷键设置的离线契约：数据模型、持久化、冲突、录制、禁用、恢复、分发同步。
 *
 * 这里不跑真 pi、不写真实项目：存储用内存对象，UI 用 jsdom。
 * 真实 Electron 键盘事件与截图在 `tests/shortcut-electron.cjs`。
 *
 * 覆盖四块：
 *   A. 模型：三态、规范化、冲突、保留键、分发同步
 *   B. 持久化：坏数据回退、未知 id、重启恢复、写入失败回滚、连续保存
 *   C. 设置页：录制 / 冲突 / Escape / 禁用 / 单项与全部恢复
 *   D. 提示同步：工作面板入口与命令面板从注册表读当前生效值
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const STORAGE_KEY = 'pi-gui.keybindings.v1';

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS ' + name);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.error('FAIL ' + name + ': ' + (error && error.stack ? error.stack : error));
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(entry) {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), {
    url: 'http://fixture.invalid/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;
  w.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.fetch = async () => ({ json: async () => ({ ok: false }) });
  w.eval(bundle(path.join(ROOT, 'public', entry)).code);
  return { w, d, close: () => dom.window.close() };
}

function memoryStore() {
  return {
    data: new Map(),
    fail: false,
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
    setItem(key, value) {
      if (this.fail) throw new Error('quota');
      this.data.set(key, String(value));
    },
    removeItem(key) { this.data.delete(key); },
  };
}

const SHORTCUTS = [
  { id: 'palette', combo: 'primary+k', label: '打开命令面板', group: '通用' },
  { id: 'palette-alt', combo: 'primary+shift+p', label: '打开命令面板（备用键）', group: '通用' },
  { id: 'shortcut-help', combo: 'primary+/', label: '键盘快捷键帮助', group: '通用' },
  { id: 'view-chat', combo: 'alt+1', label: '切到对话', group: '视图' },
  { id: 'view-planner', combo: 'alt+2', label: '切到任务', group: '视图' },
  { id: 'view-changes', combo: 'alt+3', label: '切到文件变更', group: '视图' },
  { id: 'view-extensions', combo: 'alt+4', label: '切到扩展与能力', group: '视图' },
  { id: 'work-changes', combo: 'primary+shift+g', label: '打开文件变更面板', group: '工作面板' },
  { id: 'work-terminal', combo: 'primary+`', label: '打开终端面板', group: '工作面板' },
  { id: 'work-files', combo: 'primary+p', label: '打开项目文件面板', group: '工作面板' },
];

function plainEvent(init = {}) {
  return {
    key: init.key,
    code: init.code,
    ctrlKey: Boolean(init.ctrlKey),
    metaKey: Boolean(init.metaKey),
    altKey: Boolean(init.altKey),
    shiftKey: Boolean(init.shiftKey),
    target: init.target || null,
    repeat: Boolean(init.repeat),
    isComposing: Boolean(init.isComposing),
    keyCode: init.keyCode,
    getModifierState: typeof init.getModifierState === 'function' ? init.getModifierState : undefined,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}

(async () => {
  const sc = await import('../public/shortcuts.js');

  /* ================= A. 模型 ================= */
  console.log('\n--- A. 模型 ---');
  await check('A1 规范化：顺序、别名、Shift 等价符号、畸形值', () => {
    assert.equal(sc.normalizeCombo('alt+ctrl+k'), 'ctrl+alt+k');
    assert.equal(sc.normalizeCombo('shift+primary+p'), `${sc.IS_MAC ? 'meta' : 'ctrl'}+shift+p`);
    assert.equal(sc.normalizeCombo('ctrl+shift+equal'), 'ctrl+shift+=');
    assert.equal(sc.normalizeCombo('ctrl+!'), 'ctrl+shift+1');
    assert.equal(sc.normalizeCombo('ctrl+?'), 'ctrl+shift+/');
    assert.equal(sc.normalizeCombo('ctrl+k+j'), null);
    assert.equal(sc.normalizeCombo('ctrl+escape'), null);
    assert.equal(sc.normalizeCombo(''), null);
  });
  await check('A2 事件：key 为主、code 兜底、死键 / AltGr / IME / 连发不误识别', () => {
    assert.equal(sc.comboFromEvent(plainEvent({ key: 'K', code: 'KeyK', ctrlKey: true })), 'ctrl+k');
    assert.equal(sc.comboFromEvent(plainEvent({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true })), 'ctrl+shift+=');
    assert.equal(sc.comboFromEvent(plainEvent({ key: 'Unidentified', code: 'KeyK', ctrlKey: true })), 'ctrl+k');
    assert.equal(sc.comboFromEvent(plainEvent({ key: 'Dead', code: 'Quote' })), null);
    assert.equal(sc.comboFromEvent(plainEvent({ key: 'Process', code: 'KeyK' })), null);
    assert.equal(sc.comboFromEvent(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true })), null);
    assert.equal(sc.comboFromEvent(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, keyCode: 229 })), null);
    assert.equal(sc.comboFromEvent(plainEvent({ key: 'Control', code: 'ControlLeft', ctrlKey: true })), null);
    assert.equal(sc.comboFromEvent(plainEvent({ key: 'k', code: 'Numpad4', ctrlKey: true })), null);
    assert.equal(sc.comboFromEvent(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, getModifierState: () => true })), null);
  });
  await check('A3 保留键：系统 / 编辑 / 终端 / Electron；默认键位不被误伤', () => {
    assert.equal(sc.isReservedKeybinding('ctrl+c'), true);
    assert.equal(sc.isReservedKeybinding('ctrl+shift+v'), true);
    assert.equal(sc.isReservedKeybinding('alt+f4'), true);
    assert.equal(sc.isReservedKeybinding('f12'), true);
    assert.equal(sc.isReservedKeybinding('ctrl+shift+i'), true);
    assert.equal(sc.isReservedKeybinding('ctrl+k'), false, 'Ctrl+K 是 pi-GUI 默认键');
    assert.equal(sc.isReservedKeybinding('ctrl+p'), false, 'Ctrl+P 是 pi-GUI 默认键');
    assert.equal(sc.isReservedKeybinding('ctrl+shift+g'), false, 'Ctrl+Shift+G 是 pi-GUI 默认键');
    assert.equal(sc.isReservedKeybinding('ctrl+/'), false);
    assert.equal(sc.isReservedKeybinding('ctrl+`'), false);
    assert.equal(sc.isReservedKeybinding('ctrl+shift+p'), false);
    assert.equal(sc.isReservedKeybinding('alt+1'), false);
    assert.equal(sc.isAllowedKeybinding('k'), false);
    assert.equal(sc.isAllowedKeybinding('shift+k'), false);
    assert.equal(sc.isAllowedKeybinding('f1'), true);
    assert.equal(sc.isAllowedKeybinding('ctrl+k'), true);
  });
  await check('A4 冲突：同键、修饰键顺序、Shift 标点等价；字母/数字 Shift 仍区分', () => {
    assert.equal(sc.keybindingsConflict('ctrl+alt+k', 'alt+ctrl+k'), true);
    assert.equal(sc.keybindingsConflict('ctrl+=', 'ctrl+shift+='), true);
    assert.equal(sc.keybindingsConflict('ctrl+/', 'ctrl+?'), true);
    assert.equal(sc.keybindingsConflict('ctrl+g', 'ctrl+shift+g'), false);
    assert.equal(sc.keybindingsConflict('ctrl+1', 'ctrl+shift+1'), false);
  });

  /* ================= B. 持久化 ================= */
  console.log('\n--- B. 持久化 ---');
  const store = memoryStore();
  const runs = {};
  const registerAll = (target, counts) => {
    target.resetShortcuts();
    for (const item of SHORTCUTS) {
      target.registerShortcut({ ...item, run: () => { counts[item.id] = (counts[item.id] || 0) + 1; } });
    }
    target.assertNoConflicts();
  };
  registerAll(sc, runs);
  sc.configureShortcutStorage(store);
  sc.loadShortcutOverrides(store);

  await check('B1 三态：默认 → 自定义 → 禁用（null）→ 恢复默认', () => {
    assert.equal(sc.shortcutState('palette').customized, false);
    assert.equal(sc.shortcutState('palette').disabled, false);
    assert.equal(sc.shortcutState('palette').effectiveCombo, sc.normalizeCombo('primary+k'));
    let result = sc.commitShortcutBinding('palette', 'ctrl+alt+k');
    assert.equal(result.ok, true);
    assert.equal(store.data.get(STORAGE_KEY), JSON.stringify({ palette: 'ctrl+alt+k' }));
    assert.equal(sc.shortcutState('palette').customized, true);
    assert.equal(sc.shortcutState('palette').disabled, false);
    assert.equal(sc.shortcutState('palette').effectiveCombo, 'ctrl+alt+k');
    result = sc.commitShortcutBinding('palette', null);
    assert.equal(result.ok, true);
    assert.equal(store.data.get(STORAGE_KEY), JSON.stringify({ palette: null }));
    assert.equal(sc.shortcutState('palette').disabled, true);
    assert.equal(sc.shortcutState('palette').effectiveCombo, null);
    assert.equal(sc.shortcutState('palette').display, '未绑定');
    result = sc.resetShortcutBinding('palette');
    assert.equal(result.ok, true);
    assert.equal(store.data.get(STORAGE_KEY), '{}');
    assert.equal(sc.shortcutState('palette').customized, false);
    assert.equal(sc.shortcutState('palette').effectiveCombo, sc.normalizeCombo('primary+k'));
  });
  await check('B2 分发同步：新键立刻生效，旧键立刻失效；禁用 / 恢复同样', () => {
    for (const key of Object.keys(runs)) delete runs[key];
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC })).id, 'palette');
    assert.equal(runs.palette, 1);
    sc.commitShortcutBinding('palette', 'ctrl+alt+k');
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC })), null);
    assert.equal(runs.palette, 1);
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })).id, 'palette');
    assert.equal(runs.palette, 2);
    sc.commitShortcutBinding('palette', null);
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })), null);
    assert.equal(runs.palette, 2);
    sc.resetShortcutBinding('palette');
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC })).id, 'palette');
    assert.equal(runs.palette, 3);
  });
  await check('B3 连发 / 文本输入 / 终端控制 / when 的保护仍然有效', () => {
    for (const key of Object.keys(runs)) delete runs[key];
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC, repeat: true })), null);
    const textarea = { tagName: 'TEXTAREA', isContentEditable: false, closest: () => null };
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC, target: textarea })).id, 'palette', '输入框里 Ctrl+K 仍打开面板');
    const terminal = { tagName: 'TEXTAREA', isContentEditable: false, closest: (sel) => (sel === '.xterm' ? {} : null) };
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, target: terminal })), null, '终端里 Ctrl+K 让给 readline');
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, target: terminal })).id, 'palette-alt', '终端里 Ctrl+Shift+P 仍可打开面板');
  });
  await check('B4 冲突 / 保留 / 不允许的值不写存储、不改内存', () => {
    sc.commitShortcutBinding('palette', 'ctrl+alt+k');
    const before = store.data.get(STORAGE_KEY);
    let result = sc.commitShortcutBinding('palette', 'alt+1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'conflict');
    assert.equal(result.conflict.id, 'view-chat');
    assert.equal(store.data.get(STORAGE_KEY), before);
    assert.equal(sc.shortcutState('palette').effectiveCombo, 'ctrl+alt+k');
    result = sc.commitShortcutBinding('palette', 'ctrl+c');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'reserved');
    result = sc.commitShortcutBinding('palette', 'k');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'modifier');
    sc.resetShortcutBinding('palette');
  });
  await check('B5 单项恢复默认前检查冲突；全部恢复会清空禁用项', () => {
    // 先把 palette 挪开，腾出 primary+k；再让 view-chat 占用它。
    // 此时单项恢复 palette 会把默认的 primary+k 带回来，必须被拒绝。
    sc.commitShortcutBinding('palette', 'ctrl+alt+k');
    const occupied = sc.commitShortcutBinding('view-chat', 'primary+k');
    assert.equal(occupied.ok, true);
    const before = store.data.get(STORAGE_KEY);
    const result = sc.resetShortcutBinding('palette');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'conflict');
    assert.equal(result.conflict.id, 'view-chat');
    assert.equal(store.data.get(STORAGE_KEY), before);
    assert.equal(sc.shortcutState('palette').effectiveCombo, 'ctrl+alt+k');

    // 录制时直接按回默认组合，也必须走同一条冲突检查，不能静默制造重复绑定。
    const direct = sc.commitShortcutBinding('palette', 'primary+k');
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, 'conflict');
    assert.equal(direct.conflict.id, 'view-chat');
    assert.equal(store.data.get(STORAGE_KEY), before);
    assert.equal(sc.shortcutState('palette').effectiveCombo, 'ctrl+alt+k');

    sc.commitShortcutBinding('work-files', null);
    const all = sc.resetAllShortcutBindings();
    assert.equal(all.ok, true);
    assert.equal(store.data.get(STORAGE_KEY), '{}');
    assert.equal(sc.shortcutState('view-chat').effectiveCombo, 'alt+1');
    assert.equal(sc.shortcutState('palette').effectiveCombo, sc.normalizeCombo('primary+k'));
    assert.equal(sc.shortcutState('work-files').disabled, false);
  });
  await check('B6 写入失败：存储与内存都不变', () => {
    sc.commitShortcutBinding('palette', 'ctrl+alt+k');
    const before = store.data.get(STORAGE_KEY);
    store.fail = true;
    const result = sc.commitShortcutBinding('palette', 'ctrl+alt+j');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'storage');
    assert.equal(store.data.get(STORAGE_KEY), before);
    assert.equal(sc.shortcutState('palette').effectiveCombo, 'ctrl+alt+k');
    store.fail = false;
    sc.resetAllShortcutBindings();
  });
  await check('B7 连续保存：最后一次状态是唯一真相', () => {
    const letters = 'abcdefghij';
    for (let i = 0; i < 50; i += 1) {
      const result = sc.commitShortcutBinding('palette', `ctrl+alt+${letters[i % letters.length]}`);
      assert.equal(result.ok, true);
    }
    assert.equal(sc.shortcutState('palette').effectiveCombo, 'ctrl+alt+j');
    assert.equal(store.data.get(STORAGE_KEY), JSON.stringify({ palette: 'ctrl+alt+j' }));
    sc.resetAllShortcutBindings();
  });
  await check('B8 重启恢复：自定义与禁用都回来', () => {
    sc.commitShortcutBinding('palette', 'ctrl+alt+k');
    sc.commitShortcutBinding('work-files', null);
    const saved = store.data.get(STORAGE_KEY);
    registerAll(sc, runs);
    sc.loadShortcutOverrides(store);
    assert.equal(store.data.get(STORAGE_KEY), saved, '加载不写回存储');
    assert.equal(sc.shortcutState('palette').effectiveCombo, 'ctrl+alt+k');
    assert.equal(sc.shortcutState('work-files').disabled, true);
    assert.equal(sc.shortcutState('view-chat').effectiveCombo, 'alt+1');
    sc.resetAllShortcutBindings();
  });
  await check('B9 坏 JSON / 未知 id / 无效值 / 保留值 / 冲突值都安全回退', () => {
    store.data.set(STORAGE_KEY, '{bad json');
    sc.loadShortcutOverrides(store);
    assert.equal(sc.hasShortcutOverrides(), false);
    store.data.set(STORAGE_KEY, JSON.stringify({
      palette: 'k',
      'palette-alt': 'ctrl+c',
      'view-chat': 'alt+2',
      unknown: 'alt+9',
      'work-files': null,
    }));
    sc.loadShortcutOverrides(store);
    assert.equal(sc.shortcutState('palette').effectiveCombo, sc.normalizeCombo('primary+k'));
    assert.equal(sc.shortcutState('palette-alt').effectiveCombo, sc.normalizeCombo('primary+shift+p'));
    assert.equal(sc.shortcutState('view-chat').effectiveCombo, 'alt+1');
    assert.equal(sc.shortcutState('work-files').disabled, true);
    assert.deepEqual(sc.getShortcutOverrides(), { 'work-files': null });
    sc.resetAllShortcutBindings();
    store.data.clear();
  });

  /* ================= C. 设置页 ================= */
  console.log('\n--- C. 设置页 ---');
  const main = fixture('ui/shortcut-help.js');
  const { w, d } = main;
  const uiRuns = {};
  const uiStore = memoryStore();
  let page = null;
  let closeCount = 0;
  let pageEscapes = 0;
  const onPageEscape = (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) pageEscapes++;
  };

  const row = (id) => d.querySelector(`.shortcut-row[data-shortcut-id="${id}"]`);
  const recorder = (id) => row(id).querySelector('.shortcut-recorder');
  const disableBtn = (id) => row(id).querySelector('.shortcut-disable');
  const resetBtn = (id) => row(id).querySelector('.shortcut-reset');
  const errorBox = (id) => row(id).querySelector('.shortcut-error');
  const chip = (id) => row(id).querySelector('.shortcut-state');

  function registerUiAll() {
    w.resetShortcuts();
    for (const item of SHORTCUTS) {
      w.registerShortcut({ ...item, run: () => { uiRuns[item.id] = (uiRuns[item.id] || 0) + 1; } });
    }
    w.assertNoConflicts();
  }

  function openPage() {
    closeCount = 0;
    pageEscapes = 0;
    d.addEventListener('keydown', onPageEscape);
    const host = d.createElement('div');
    d.body.append(host);
    let dispose = null;
    w.openShortcutHelp({
      present: (build, onClose) => {
        dispose = onClose;
        build(host, () => { closeCount++; });
      },
    });
    page = { host, dispose };
  }

  function closePage() {
    if (!page) return;
    page.dispose?.();
    page.host.remove();
    d.removeEventListener('keydown', onPageEscape);
    page = null;
  }

  function freshPage() {
    closePage();
    uiStore.data.clear();
    uiStore.fail = false;
    for (const key of Object.keys(uiRuns)) delete uiRuns[key];
    registerUiAll();
    w.configureShortcutStorage(uiStore);
    w.loadShortcutOverrides(uiStore);
    openPage();
  }

  const press = (target, init) => {
    const event = new w.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };

  await check('C1 默认列表：10 条、三组、键帽 / 恢复按钮状态准确', () => {
    freshPage();
    assert.equal(d.querySelectorAll('.shortcut-row').length, 10);
    const groups = [...d.querySelectorAll('.shortcut-map .shortcut-group-label')].map((n) => n.textContent);
    assert.deepEqual(groups, ['通用', '视图', '工作面板']);
    assert.ok(recorder('palette').textContent.includes('K'));
    assert.ok(recorder('palette').textContent.includes(w.IS_MAC ? '⌘' : 'Ctrl'));
    assert.equal(recorder('palette').querySelectorAll('kbd').length, 2);
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'false');
    assert.equal(resetBtn('palette').disabled, true);
    assert.equal(d.querySelector('.shortcut-reset-all').disabled, true);
    assert.equal(chip('palette').hidden, true);
    assert.equal(disableBtn('palette').disabled, false);
  });
  await check('C2 点击键帽进入录制，真实按键保存并立刻改变分发', () => {
    recorder('palette').click();
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'true');
    assert.equal(recorder('palette').textContent, '请按下快捷键');
    const event = press(recorder('palette'), { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
    assert.equal(event.defaultPrevented, true);
    assert.equal(uiStore.data.get(STORAGE_KEY), JSON.stringify({ palette: 'ctrl+alt+k' }));
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'false');
    assert.ok(recorder('palette').textContent.includes(w.IS_MAC ? '⌃' : 'Ctrl'));
    assert.ok(recorder('palette').textContent.includes(w.IS_MAC ? '⌥' : 'Alt'));
    assert.ok(recorder('palette').textContent.includes('K'));
    assert.equal(chip('palette').hidden, false);
    assert.equal(chip('palette').textContent, '自定义');
    assert.equal(resetBtn('palette').disabled, false);
    assert.equal(d.querySelector('.shortcut-reset-all').disabled, false);
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })).id, 'palette');
    assert.equal(uiRuns.palette, 1);
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: !w.IS_MAC, metaKey: w.IS_MAC })), null);
    assert.equal(uiRuns.palette, 1);
  });
  await check('C3 冲突：行内报错、不保存、保持录制；Escape 只取消录制不关页', () => {
    const before = uiStore.data.get(STORAGE_KEY);
    recorder('palette').click();
    press(recorder('palette'), { key: '1', code: 'Digit1', altKey: true });
    assert.equal(errorBox('palette').hidden, false);
    assert.ok(errorBox('palette').textContent.includes('切到对话'));
    assert.ok(errorBox('palette').textContent.includes('Alt+1'));
    assert.equal(uiStore.data.get(STORAGE_KEY), before);
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'true');
    const esc = press(recorder('palette'), { key: 'Escape', code: 'Escape' });
    assert.equal(esc.defaultPrevented, true);
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'false');
    assert.equal(errorBox('palette').hidden, true);
    assert.equal(page.host.isConnected, true);
    assert.equal(closeCount, 0);
    assert.equal(pageEscapes, 0, 'settings-surface 的 Escape 不能看到录制取消');
  });
  await check('C4 保留键与普通字母被拒绝，仍保持录制；单独修饰键不结束', () => {
    recorder('palette').click();
    press(recorder('palette'), { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    assert.equal(errorBox('palette').hidden, true, '单独 Ctrl 不报错');
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'true');
    press(recorder('palette'), { key: 'c', code: 'KeyC', ctrlKey: true });
    assert.equal(errorBox('palette').hidden, false);
    assert.ok(errorBox('palette').textContent.includes('保留'));
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'true');
    press(recorder('palette'), { key: 'Escape', code: 'Escape' });
    recorder('palette').click();
    press(recorder('palette'), { key: 'k', code: 'KeyK' });
    assert.equal(errorBox('palette').hidden, false);
    assert.ok(errorBox('palette').textContent.includes('需要配合'));
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'true');
    press(recorder('palette'), { key: 'Escape', code: 'Escape' });
  });
  await check('C5 IME 组合不录制、不 preventDefault；失去焦点安全退出', () => {
    recorder('palette').click();
    const ime = new w.KeyboardEvent('keydown', { key: 'Process', code: 'KeyK', bubbles: true, cancelable: true });
    Object.defineProperty(ime, 'isComposing', { value: true });
    recorder('palette').dispatchEvent(ime);
    assert.equal(ime.defaultPrevented, false);
    assert.equal(errorBox('palette').hidden, true);
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'true');
    recorder('palette').dispatchEvent(new w.FocusEvent('blur'));
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'false');
  });
  await check('C6 禁用：显示未绑定、立即失效、其他动作不受影响', () => {
    disableBtn('palette').click();
    assert.equal(uiStore.data.get(STORAGE_KEY), JSON.stringify({ palette: null }));
    assert.equal(recorder('palette').textContent, '未绑定');
    assert.equal(chip('palette').textContent, '已禁用');
    assert.equal(disableBtn('palette').disabled, true);
    assert.equal(resetBtn('palette').disabled, false);
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })), null);
    assert.equal(w.dispatchShortcut(plainEvent({ key: '1', code: 'Digit1', altKey: true })).id, 'view-chat');
  });
  await check('C7 单项恢复：回到默认并重新触发', () => {
    resetBtn('palette').click();
    assert.equal(uiStore.data.get(STORAGE_KEY), '{}');
    assert.equal(chip('palette').hidden, true);
    assert.equal(resetBtn('palette').disabled, true);
    assert.equal(recorder('palette').textContent.includes('K'), true);
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: !w.IS_MAC, metaKey: w.IS_MAC })).id, 'palette');
  });
  await check('C8 全部恢复：自定义与禁用一起清掉', () => {
    w.commitShortcutBinding('palette', 'ctrl+alt+k');
    w.commitShortcutBinding('work-files', null);
    // 让页面通过订阅刷新到最新状态
    assert.equal(chip('work-files').textContent, '已禁用');
    d.querySelector('.shortcut-reset-all').click();
    assert.equal(uiStore.data.get(STORAGE_KEY), '{}');
    assert.equal(chip('palette').hidden, true);
    assert.equal(chip('work-files').hidden, true);
    assert.equal(recorder('work-files').textContent.includes('P'), true);
    assert.equal(d.querySelector('.shortcut-reset-all').disabled, true);
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: !w.IS_MAC, metaKey: w.IS_MAC })).id, 'palette');
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'p', code: 'KeyP', ctrlKey: !w.IS_MAC, metaKey: w.IS_MAC })).id, 'work-files');
  });
  await check('C9 存储失败：行内提示、UI 与分发都停在旧值', () => {
    w.commitShortcutBinding('palette', 'ctrl+alt+k');
    uiStore.fail = true;
    recorder('palette').click();
    press(recorder('palette'), { key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true });
    assert.equal(errorBox('palette').hidden, false);
    assert.ok(errorBox('palette').textContent.includes('保存失败'));
    assert.equal(recorder('palette').getAttribute('aria-pressed'), 'true');
    press(recorder('palette'), { key: 'Escape', code: 'Escape' });
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })).id, 'palette');
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true })), null);
    uiStore.fail = false;
  });
  await check('C10 连续保存后页面与存储一致', () => {
    for (let i = 0; i < 30; i += 1) {
      w.commitShortcutBinding('palette', `ctrl+alt+${'abcdefghij'[i % 10]}`);
    }
    assert.equal(uiStore.data.get(STORAGE_KEY), JSON.stringify({ palette: 'ctrl+alt+j' }));
    assert.ok(recorder('palette').textContent.includes('J'));
    assert.equal(chip('palette').textContent, '自定义');
  });
  await check('C11 重启恢复：关闭后重新注册 + 加载，自定义与禁用回来', () => {
    w.commitShortcutBinding('work-files', null);
    closePage();
    w.resetShortcuts();
    registerUiAll();
    w.configureShortcutStorage(uiStore);
    w.loadShortcutOverrides(uiStore);
    assert.equal(w.shortcutState('palette').effectiveCombo, 'ctrl+alt+j');
    assert.equal(w.shortcutState('work-files').disabled, true);
    openPage();
    assert.ok(recorder('palette').textContent.includes('J'));
    assert.equal(chip('palette').textContent, '自定义');
    assert.equal(chip('work-files').textContent, '已禁用');
    assert.equal(resetBtn('palette').disabled, false);
    assert.equal(resetBtn('work-files').disabled, false);
    d.querySelector('.shortcut-reset-all').click();
    assert.equal(uiStore.data.get(STORAGE_KEY), '{}');
  });

  /* ================= D. 提示同步 ================= */
  console.log('\n--- D. 提示同步 ---');
  await check('D1 工作面板入口的快捷键提示随生效值更新', () => {
    const f = fixture('ui/work-panel-launcher.js');
    try {
      f.w.resetShortcuts();
      f.w.registerShortcut({ id: 'work-changes', combo: 'primary+shift+g', label: '打开文件变更面板', run() {} });
      f.w.configureShortcutStorage(memoryStore());
      const host = f.d.createElement('div');
      f.d.body.append(host);
      const source = f.d.createElement('button');
      source.id = 'navChanges';
      source.setAttribute('aria-label', '变更');
      const icon = f.d.createElementNS('http://www.w3.org/2000/svg', 'svg');
      source.append(icon);
      f.d.body.append(source);
      const dispose = f.w.mountWorkPanelLauncher(host, [{ source, label: '变更', shortcutId: 'work-changes' }]);
      const hint = () => host.querySelector('.work-panel-launcher-shortcut');
      assert.equal(hint().textContent, f.w.formatCombo('primary+shift+g'));
      f.w.commitShortcutBinding('work-changes', 'ctrl+alt+g');
      assert.equal(hint().textContent, f.w.formatCombo('ctrl+alt+g'));
      f.w.commitShortcutBinding('work-changes', null);
      assert.equal(hint().textContent, '未绑定');
      dispose();
    } finally {
      f.close();
    }
  });
  await check('D2 命令面板的快捷键提示随生效值更新', () => {
    const f = fixture('palette.js');
    try {
      f.w.resetShortcuts();
      f.w.registerShortcut({ id: 'shortcut-help', combo: 'primary+/', label: '键盘快捷键帮助', run() {} });
      f.w.configureShortcutStorage(memoryStore());
      f.w.defineCommands([{ id: 'app.shortcuts', title: '键盘快捷键', group: '全局', shortcutId: 'shortcut-help', run() {} }]);
      f.w.openPalette();
      const hint = () => f.d.querySelector('.palette-hint');
      assert.equal(hint().textContent, f.w.formatCombo('primary+/'));
      f.w.closePalette();
      f.w.commitShortcutBinding('shortcut-help', 'ctrl+alt+/');
      f.w.openPalette();
      assert.equal(hint().textContent, f.w.formatCombo('ctrl+alt+/'));
      f.w.closePalette();
      f.w.commitShortcutBinding('shortcut-help', null);
      f.w.openPalette();
      assert.equal(hint().textContent, '未绑定');
      f.w.closePalette();
    } finally {
      f.close();
    }
  });

  closePage();
  main.close();

  console.log(`\n${passed}/${passed + failed} 通过`);
  if (failed) {
    for (const item of failures) console.error('- ' + item.name);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
