/* 快捷键设置的离线契约：数据模型、持久化、冲突、录制、禁用、恢复、分发同步。
 *
 * 这里不跑真 pi、不写真实项目：存储用内存对象，UI 用 jsdom。
 * 真实 Electron 键盘事件与截图在 `tests/shortcut-electron.cjs`。
 *
 * 覆盖四块：
 *   A. 模型：三态、规范化、冲突、保留键、分发同步
 *   B. 持久化：坏数据回退、未知 id、重启恢复、写入失败回滚、连续保存、
 *      旧命令面板键位 ID 的安全忽略
 *   C. 设置页：录制 / 冲突 / Escape / 禁用 / 单项与全部恢复
 *   D. 提示同步：工作面板入口从注册表读当前生效值
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
  { id: 'shortcut-help', combo: 'primary+/', label: '键盘快捷键帮助', group: '通用' },
  { id: 'view-chat', combo: 'alt+1', label: '切到对话', group: '视图' },
  { id: 'view-planner', combo: 'alt+2', label: '切到任务', group: '视图' },
  { id: 'view-changes', combo: 'alt+3', label: '切到文件变更', group: '视图' },
  { id: 'view-extensions', combo: 'alt+4', label: '切到扩展与 Skills', group: '视图' },
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
    assert.equal(sc.isReservedKeybinding('ctrl+k'), false, 'Ctrl+K 已无默认绑定，但也不是系统保留键');
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
    assert.equal(sc.shortcutState('shortcut-help').customized, false);
    assert.equal(sc.shortcutState('shortcut-help').disabled, false);
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, sc.normalizeCombo('primary+/'));
    let result = sc.commitShortcutBinding('shortcut-help', 'ctrl+alt+k');
    assert.equal(result.ok, true);
    assert.equal(store.data.get(STORAGE_KEY), JSON.stringify({ 'shortcut-help': 'ctrl+alt+k' }));
    assert.equal(sc.shortcutState('shortcut-help').customized, true);
    assert.equal(sc.shortcutState('shortcut-help').disabled, false);
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, 'ctrl+alt+k');
    result = sc.commitShortcutBinding('shortcut-help', null);
    assert.equal(result.ok, true);
    assert.equal(store.data.get(STORAGE_KEY), JSON.stringify({ 'shortcut-help': null }));
    assert.equal(sc.shortcutState('shortcut-help').disabled, true);
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, null);
    assert.equal(sc.shortcutState('shortcut-help').display, '未绑定');
    result = sc.resetShortcutBinding('shortcut-help');
    assert.equal(result.ok, true);
    assert.equal(store.data.get(STORAGE_KEY), '{}');
    assert.equal(sc.shortcutState('shortcut-help').customized, false);
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, sc.normalizeCombo('primary+/'));
  });
  await check('B2 分发同步：新键立刻生效，旧键立刻失效；禁用 / 恢复同样', () => {
    for (const key of Object.keys(runs)) delete runs[key];
    assert.equal(sc.dispatchShortcut(plainEvent({ key: '/', code: 'Slash', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC })).id, 'shortcut-help');
    assert.equal(runs['shortcut-help'], 1);
    sc.commitShortcutBinding('shortcut-help', 'ctrl+alt+k');
    assert.equal(sc.dispatchShortcut(plainEvent({ key: '/', code: 'Slash', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC })), null);
    assert.equal(runs['shortcut-help'], 1);
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })).id, 'shortcut-help');
    assert.equal(runs['shortcut-help'], 2);
    sc.commitShortcutBinding('shortcut-help', null);
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })), null);
    assert.equal(runs['shortcut-help'], 2);
    sc.resetShortcutBinding('shortcut-help');
    assert.equal(sc.dispatchShortcut(plainEvent({ key: '/', code: 'Slash', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC })).id, 'shortcut-help');
    assert.equal(runs['shortcut-help'], 3);
  });
  await check('B3 连发 / 文本输入 / 终端控制 / when 的保护仍然有效', () => {
    for (const key of Object.keys(runs)) delete runs[key];
    assert.equal(sc.dispatchShortcut(plainEvent({ key: '/', code: 'Slash', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC, repeat: true })), null);
    const textarea = { tagName: 'TEXTAREA', isContentEditable: false, closest: () => null };
    assert.equal(sc.dispatchShortcut(plainEvent({ key: '/', code: 'Slash', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC, target: textarea })).id, 'shortcut-help', '输入框里 Ctrl+/ 仍打开快捷键帮助');
    const terminal = { tagName: 'TEXTAREA', isContentEditable: false, closest: (sel) => (sel === '.xterm' ? {} : null) };
    assert.equal(sc.dispatchShortcut(plainEvent({ key: '/', code: 'Slash', ctrlKey: true, target: terminal })), null, '终端里 Ctrl+/ 让给 readline');
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, target: terminal })), null, 'Ctrl+Shift+P 已无任何绑定');
  });
  await check('B4 冲突 / 保留 / 不允许的值不写存储、不改内存', () => {
    sc.commitShortcutBinding('shortcut-help', 'ctrl+alt+k');
    const before = store.data.get(STORAGE_KEY);
    let result = sc.commitShortcutBinding('shortcut-help', 'alt+1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'conflict');
    assert.equal(result.conflict.id, 'view-chat');
    assert.equal(store.data.get(STORAGE_KEY), before);
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, 'ctrl+alt+k');
    result = sc.commitShortcutBinding('shortcut-help', 'ctrl+c');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'reserved');
    result = sc.commitShortcutBinding('shortcut-help', 'k');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'modifier');
    sc.resetShortcutBinding('shortcut-help');
  });
  await check('B5 单项恢复默认前检查冲突；全部恢复会清空禁用项', () => {
    // 先把 shortcut-help 挪开，腾出 primary+/；再让 view-chat 占用它。
    // 此时单项恢复 shortcut-help 会把默认的 primary+/ 带回来，必须被拒绝。
    sc.commitShortcutBinding('shortcut-help', 'ctrl+alt+k');
    const occupied = sc.commitShortcutBinding('view-chat', 'primary+/');
    assert.equal(occupied.ok, true);
    const before = store.data.get(STORAGE_KEY);
    const result = sc.resetShortcutBinding('shortcut-help');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'conflict');
    assert.equal(result.conflict.id, 'view-chat');
    assert.equal(store.data.get(STORAGE_KEY), before);
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, 'ctrl+alt+k');

    // 录制时直接按回默认组合，也必须走同一条冲突检查，不能静默制造重复绑定。
    const direct = sc.commitShortcutBinding('shortcut-help', 'primary+/');
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, 'conflict');
    assert.equal(direct.conflict.id, 'view-chat');
    assert.equal(store.data.get(STORAGE_KEY), before);
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, 'ctrl+alt+k');

    sc.commitShortcutBinding('work-files', null);
    const all = sc.resetAllShortcutBindings();
    assert.equal(all.ok, true);
    assert.equal(store.data.get(STORAGE_KEY), '{}');
    assert.equal(sc.shortcutState('view-chat').effectiveCombo, 'alt+1');
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, sc.normalizeCombo('primary+/'));
    assert.equal(sc.shortcutState('work-files').disabled, false);
  });
  await check('B6 写入失败：存储与内存都不变', () => {
    sc.commitShortcutBinding('shortcut-help', 'ctrl+alt+k');
    const before = store.data.get(STORAGE_KEY);
    store.fail = true;
    const result = sc.commitShortcutBinding('shortcut-help', 'ctrl+alt+j');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'storage');
    assert.equal(store.data.get(STORAGE_KEY), before);
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, 'ctrl+alt+k');
    store.fail = false;
    sc.resetAllShortcutBindings();
  });
  await check('B7 连续保存：最后一次状态是唯一真相', () => {
    const letters = 'abcdefghij';
    for (let i = 0; i < 50; i += 1) {
      const result = sc.commitShortcutBinding('shortcut-help', `ctrl+alt+${letters[i % letters.length]}`);
      assert.equal(result.ok, true);
    }
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, 'ctrl+alt+j');
    assert.equal(store.data.get(STORAGE_KEY), JSON.stringify({ 'shortcut-help': 'ctrl+alt+j' }));
    sc.resetAllShortcutBindings();
  });
  await check('B8 重启恢复：自定义与禁用都回来', () => {
    sc.commitShortcutBinding('shortcut-help', 'ctrl+alt+k');
    sc.commitShortcutBinding('work-files', null);
    const saved = store.data.get(STORAGE_KEY);
    registerAll(sc, runs);
    sc.loadShortcutOverrides(store);
    assert.equal(store.data.get(STORAGE_KEY), saved, '加载不写回存储');
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, 'ctrl+alt+k');
    assert.equal(sc.shortcutState('work-files').disabled, true);
    assert.equal(sc.shortcutState('view-chat').effectiveCombo, 'alt+1');
    sc.resetAllShortcutBindings();
  });
  await check('B9 坏 JSON / 未知 id / 无效值 / 保留值 / 冲突值都安全回退', () => {
    store.data.set(STORAGE_KEY, '{bad json');
    sc.loadShortcutOverrides(store);
    assert.equal(sc.hasShortcutOverrides(), false);
    store.data.set(STORAGE_KEY, JSON.stringify({
      'shortcut-help': 'k',
      'view-chat': 'alt+2',
      unknown: 'alt+9',
      'work-files': null,
    }));
    sc.loadShortcutOverrides(store);
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, sc.normalizeCombo('primary+/'));
    assert.equal(sc.shortcutState('view-chat').effectiveCombo, 'alt+1');
    assert.equal(sc.shortcutState('work-files').disabled, true);
    assert.deepEqual(sc.getShortcutOverrides(), { 'work-files': null });
    sc.resetAllShortcutBindings();
    store.data.clear();
  });
  await check('B10 键位互换：保存后重启，两项自定义都完整恢复', () => {
    // 用户实际操作顺序：禁用「切到任务」→ 把「切到对话」改到 alt+2
    // → 再把「切到任务」改到 alt+1。最终两项都启用，组合互换。
    assert.equal(sc.commitShortcutBinding('view-planner', null).ok, true);
    assert.equal(sc.commitShortcutBinding('view-chat', 'alt+2').ok, true);
    assert.equal(sc.commitShortcutBinding('view-planner', 'alt+1').ok, true);
    assert.equal(sc.shortcutState('view-chat').effectiveCombo, 'alt+2');
    assert.equal(sc.shortcutState('view-planner').effectiveCombo, 'alt+1');
    const saved = store.data.get(STORAGE_KEY);
    registerAll(sc, runs);
    sc.loadShortcutOverrides(store);
    assert.equal(store.data.get(STORAGE_KEY), saved, '加载不写回存储');
    assert.equal(sc.shortcutState('view-chat').effectiveCombo, 'alt+2');
    assert.equal(sc.shortcutState('view-planner').effectiveCombo, 'alt+1');
    assert.equal(sc.shortcutState('view-chat').customized, true);
    assert.equal(sc.shortcutState('view-planner').customized, true);
    assert.equal(sc.shortcutState('view-chat').disabled, false);
    assert.equal(sc.shortcutState('view-planner').disabled, false);
    assert.equal(sc.shortcutState('view-changes').effectiveCombo, 'alt+3', '无关键位保持默认');
    sc.resetAllShortcutBindings();
  });
  await check('B11 三条键位循环交换：保存后重启，三项自定义都完整恢复', () => {
    // 默认 chat=alt+1 / planner=alt+2 / changes=alt+3；
    // 目标 chat=alt+2 / planner=alt+3 / changes=alt+1（三项循环）。
    // 用 alt+5 作临时空位，逐步挪动，避免写入时产生瞬时重复。
    assert.equal(sc.commitShortcutBinding('view-chat', 'alt+5').ok, true);
    assert.equal(sc.commitShortcutBinding('view-changes', 'alt+1').ok, true);
    assert.equal(sc.commitShortcutBinding('view-planner', 'alt+3').ok, true);
    assert.equal(sc.commitShortcutBinding('view-chat', 'alt+2').ok, true);
    const saved = store.data.get(STORAGE_KEY);
    registerAll(sc, runs);
    sc.loadShortcutOverrides(store);
    assert.equal(store.data.get(STORAGE_KEY), saved, '加载不写回存储');
    assert.equal(sc.shortcutState('view-chat').effectiveCombo, 'alt+2');
    assert.equal(sc.shortcutState('view-planner').effectiveCombo, 'alt+3');
    assert.equal(sc.shortcutState('view-changes').effectiveCombo, 'alt+1');
    for (const key of Object.keys(runs)) delete runs[key];
    assert.equal(sc.dispatchShortcut(plainEvent({ key: '2', code: 'Digit2', altKey: true })).id, 'view-chat');
    assert.equal(sc.dispatchShortcut(plainEvent({ key: '3', code: 'Digit3', altKey: true })).id, 'view-planner');
    assert.equal(sc.dispatchShortcut(plainEvent({ key: '1', code: 'Digit1', altKey: true })).id, 'view-changes');
    assert.deepEqual(runs, { 'view-chat': 1, 'view-planner': 1, 'view-changes': 1 });
    sc.resetAllShortcutBindings();
  });
  await check('B12 真正重复 / 损坏的配置仍然安全降级', () => {
    store.data.set(STORAGE_KEY, JSON.stringify({
      'view-chat': 'alt+5',
      'view-planner': 'alt+5',
      'view-changes': 'ctrl+c',
      'view-extensions': 'not a combo',
      'work-files': null,
    }));
    sc.loadShortcutOverrides(store);
    assert.equal(sc.shortcutState('view-chat').effectiveCombo, 'alt+5', '注册顺序靠前的自定义保留');
    assert.equal(sc.shortcutState('view-planner').effectiveCombo, 'alt+2', '重复的一方回退默认');
    assert.equal(sc.shortcutState('view-changes').effectiveCombo, 'alt+3', '保留键回退默认');
    assert.equal(sc.shortcutState('view-extensions').effectiveCombo, 'alt+4', '损坏值回退默认');
    assert.equal(sc.shortcutState('work-files').disabled, true, '禁用值仍然生效');
    const combos = sc.listShortcuts().map((item) => item.effectiveCombo).filter(Boolean);
    assert.equal(new Set(combos).size, combos.length, '最终生效集合没有重复');
    sc.resetAllShortcutBindings();
    store.data.clear();
  });
  await check('B13 旧命令面板键位 ID 安全忽略，不产生绑定也不影响其他项', () => {
    store.data.set(STORAGE_KEY, JSON.stringify({
      palette: 'ctrl+alt+k',
      'palette-alt': null,
      'shortcut-help': 'ctrl+alt+/',
      'work-files': null,
    }));
    sc.loadShortcutOverrides(store);
    assert.equal(sc.shortcutState('shortcut-help').effectiveCombo, 'ctrl+alt+/');
    assert.equal(sc.shortcutState('work-files').disabled, true);
    assert.deepEqual(sc.getShortcutOverrides(), { 'shortcut-help': 'ctrl+alt+/', 'work-files': null });
    assert.equal(sc.listShortcuts().some((item) => item.id === 'palette' || item.id === 'palette-alt'), false);
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC })), null, 'Ctrl+K 不再触发任何动作');
    assert.equal(sc.dispatchShortcut(plainEvent({ key: 'P', code: 'KeyP', ctrlKey: !sc.IS_MAC, metaKey: sc.IS_MAC, shiftKey: true })), null, 'Ctrl+Shift+P 不再触发任何动作');
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

  await check('C1 默认列表：8 条、三组、键帽 / 恢复按钮状态准确，旧命令面板行不存在', () => {
    freshPage();
    assert.equal(d.querySelectorAll('.shortcut-row').length, 8);
    const groups = [...d.querySelectorAll('.shortcut-map .shortcut-group-label')].map((n) => n.textContent);
    assert.deepEqual(groups, ['通用', '视图', '工作面板']);
    assert.equal(row('palette'), null);
    assert.equal(row('palette-alt'), null);
    assert.equal(d.body.textContent.includes('命令面板'), false);
    assert.ok(recorder('shortcut-help').textContent.includes('/'));
    assert.ok(recorder('shortcut-help').textContent.includes(w.IS_MAC ? '⌘' : 'Ctrl'));
    assert.equal(recorder('shortcut-help').querySelectorAll('kbd').length, 2);
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'false');
    assert.equal(resetBtn('shortcut-help').disabled, true);
    assert.equal(d.querySelector('.shortcut-reset-all').disabled, true);
    assert.equal(chip('shortcut-help').hidden, true);
    assert.equal(disableBtn('shortcut-help').disabled, false);
  });
  await check('C2 点击键帽进入录制，真实按键保存并立刻改变分发', () => {
    recorder('shortcut-help').click();
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'true');
    assert.equal(recorder('shortcut-help').textContent, '请按下快捷键');
    const event = press(recorder('shortcut-help'), { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
    assert.equal(event.defaultPrevented, true);
    assert.equal(uiStore.data.get(STORAGE_KEY), JSON.stringify({ 'shortcut-help': 'ctrl+alt+k' }));
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'false');
    assert.ok(recorder('shortcut-help').textContent.includes(w.IS_MAC ? '⌃' : 'Ctrl'));
    assert.ok(recorder('shortcut-help').textContent.includes(w.IS_MAC ? '⌥' : 'Alt'));
    assert.ok(recorder('shortcut-help').textContent.includes('K'));
    assert.equal(chip('shortcut-help').hidden, false);
    assert.equal(chip('shortcut-help').textContent, '自定义');
    assert.equal(resetBtn('shortcut-help').disabled, false);
    assert.equal(d.querySelector('.shortcut-reset-all').disabled, false);
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })).id, 'shortcut-help');
    assert.equal(uiRuns['shortcut-help'], 1);
    assert.equal(w.dispatchShortcut(plainEvent({ key: '/', code: 'Slash', ctrlKey: !w.IS_MAC, metaKey: w.IS_MAC })), null);
    assert.equal(uiRuns['shortcut-help'], 1);
  });
  await check('C3 冲突：行内报错、不保存、保持录制；Escape 只取消录制不关页', () => {
    const before = uiStore.data.get(STORAGE_KEY);
    recorder('shortcut-help').click();
    press(recorder('shortcut-help'), { key: '1', code: 'Digit1', altKey: true });
    assert.equal(errorBox('shortcut-help').hidden, false);
    assert.ok(errorBox('shortcut-help').textContent.includes('切到对话'));
    assert.ok(errorBox('shortcut-help').textContent.includes('Alt+1'));
    assert.equal(uiStore.data.get(STORAGE_KEY), before);
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'true');
    const esc = press(recorder('shortcut-help'), { key: 'Escape', code: 'Escape' });
    assert.equal(esc.defaultPrevented, true);
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'false');
    assert.equal(errorBox('shortcut-help').hidden, true);
    assert.equal(page.host.isConnected, true);
    assert.equal(closeCount, 0);
    assert.equal(pageEscapes, 0, 'settings-surface 的 Escape 不能看到录制取消');
  });
  await check('C4 保留键与普通字母被拒绝，仍保持录制；单独修饰键不结束', () => {
    recorder('shortcut-help').click();
    press(recorder('shortcut-help'), { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    assert.equal(errorBox('shortcut-help').hidden, true, '单独 Ctrl 不报错');
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'true');
    press(recorder('shortcut-help'), { key: 'c', code: 'KeyC', ctrlKey: true });
    assert.equal(errorBox('shortcut-help').hidden, false);
    assert.ok(errorBox('shortcut-help').textContent.includes('保留'));
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'true');
    press(recorder('shortcut-help'), { key: 'Escape', code: 'Escape' });
    recorder('shortcut-help').click();
    press(recorder('shortcut-help'), { key: 'k', code: 'KeyK' });
    assert.equal(errorBox('shortcut-help').hidden, false);
    assert.ok(errorBox('shortcut-help').textContent.includes('需要配合'));
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'true');
    press(recorder('shortcut-help'), { key: 'Escape', code: 'Escape' });
  });
  await check('C5 IME 组合不录制、不 preventDefault；失去焦点安全退出', () => {
    recorder('shortcut-help').click();
    const ime = new w.KeyboardEvent('keydown', { key: 'Process', code: 'KeyK', bubbles: true, cancelable: true });
    Object.defineProperty(ime, 'isComposing', { value: true });
    recorder('shortcut-help').dispatchEvent(ime);
    assert.equal(ime.defaultPrevented, false);
    assert.equal(errorBox('shortcut-help').hidden, true);
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'true');
    recorder('shortcut-help').dispatchEvent(new w.FocusEvent('blur'));
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'false');
  });
  await check('C6 禁用：显示未绑定、立即失效、其他动作不受影响', () => {
    disableBtn('shortcut-help').click();
    assert.equal(uiStore.data.get(STORAGE_KEY), JSON.stringify({ 'shortcut-help': null }));
    assert.equal(recorder('shortcut-help').textContent, '未绑定');
    assert.equal(chip('shortcut-help').textContent, '已禁用');
    assert.equal(disableBtn('shortcut-help').disabled, true);
    assert.equal(resetBtn('shortcut-help').disabled, false);
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })), null);
    assert.equal(w.dispatchShortcut(plainEvent({ key: '1', code: 'Digit1', altKey: true })).id, 'view-chat');
  });
  await check('C7 单项恢复：回到默认并重新触发', () => {
    resetBtn('shortcut-help').click();
    assert.equal(uiStore.data.get(STORAGE_KEY), '{}');
    assert.equal(chip('shortcut-help').hidden, true);
    assert.equal(resetBtn('shortcut-help').disabled, true);
    assert.equal(recorder('shortcut-help').textContent.includes('/'), true);
    assert.equal(w.dispatchShortcut(plainEvent({ key: '/', code: 'Slash', ctrlKey: !w.IS_MAC, metaKey: w.IS_MAC })).id, 'shortcut-help');
  });
  await check('C8 全部恢复：自定义与禁用一起清掉', () => {
    w.commitShortcutBinding('shortcut-help', 'ctrl+alt+k');
    w.commitShortcutBinding('work-files', null);
    // 让页面通过订阅刷新到最新状态
    assert.equal(chip('work-files').textContent, '已禁用');
    d.querySelector('.shortcut-reset-all').click();
    assert.equal(uiStore.data.get(STORAGE_KEY), '{}');
    assert.equal(chip('shortcut-help').hidden, true);
    assert.equal(chip('work-files').hidden, true);
    assert.equal(recorder('work-files').textContent.includes('P'), true);
    assert.equal(d.querySelector('.shortcut-reset-all').disabled, true);
    assert.equal(w.dispatchShortcut(plainEvent({ key: '/', code: 'Slash', ctrlKey: !w.IS_MAC, metaKey: w.IS_MAC })).id, 'shortcut-help');
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'p', code: 'KeyP', ctrlKey: !w.IS_MAC, metaKey: w.IS_MAC })).id, 'work-files');
  });
  await check('C9 存储失败：行内提示、UI 与分发都停在旧值', () => {
    w.commitShortcutBinding('shortcut-help', 'ctrl+alt+k');
    uiStore.fail = true;
    recorder('shortcut-help').click();
    press(recorder('shortcut-help'), { key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true });
    assert.equal(errorBox('shortcut-help').hidden, false);
    assert.ok(errorBox('shortcut-help').textContent.includes('保存失败'));
    assert.equal(recorder('shortcut-help').getAttribute('aria-pressed'), 'true');
    press(recorder('shortcut-help'), { key: 'Escape', code: 'Escape' });
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })).id, 'shortcut-help');
    assert.equal(w.dispatchShortcut(plainEvent({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true })), null);
    uiStore.fail = false;
  });
  await check('C10 连续保存后页面与存储一致', () => {
    for (let i = 0; i < 30; i += 1) {
      w.commitShortcutBinding('shortcut-help', `ctrl+alt+${'abcdefghij'[i % 10]}`);
    }
    assert.equal(uiStore.data.get(STORAGE_KEY), JSON.stringify({ 'shortcut-help': 'ctrl+alt+j' }));
    assert.ok(recorder('shortcut-help').textContent.includes('J'));
    assert.equal(chip('shortcut-help').textContent, '自定义');
  });
  await check('C11 重启恢复：关闭后重新注册 + 加载，自定义与禁用回来', () => {
    w.commitShortcutBinding('work-files', null);
    closePage();
    w.resetShortcuts();
    registerUiAll();
    w.configureShortcutStorage(uiStore);
    w.loadShortcutOverrides(uiStore);
    assert.equal(w.shortcutState('shortcut-help').effectiveCombo, 'ctrl+alt+j');
    assert.equal(w.shortcutState('work-files').disabled, true);
    openPage();
    assert.ok(recorder('shortcut-help').textContent.includes('J'));
    assert.equal(chip('shortcut-help').textContent, '自定义');
    assert.equal(chip('work-files').textContent, '已禁用');
    assert.equal(resetBtn('shortcut-help').disabled, false);
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
      const dispose = f.w.mountWorkPanelLauncher(host, [{ id: 'changes', label: '文件变更', icon: 'changes', shortcutId: 'work-changes', open() {} }]);
      const hint = () => host.querySelector('.work-panel-launcher-shortcut');
      assert.equal(hint().textContent, f.w.formatCombo('primary+shift+g'));
      f.w.commitShortcutBinding('work-changes', 'ctrl+alt+g');
      assert.equal(hint().textContent, f.w.formatCombo('ctrl+alt+g'));
      f.w.commitShortcutBinding('work-changes', null);
      assert.equal(hint().hidden, true);
      assert.equal(hint().textContent, '');
      dispose();
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
