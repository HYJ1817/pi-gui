/* P24 Daily-use：**离线**契约（纯逻辑，无 DOM、无网络、无真 pi）。
 *
 * 覆盖三块：
 *   A. 快捷键注册表（`public/shortcuts.js`）—— 组合解析、冲突检测、文本输入守卫
 *   B. 命令面板模型（`public/palette-model.js`）—— 注册、可执行性、搜索排序
 *   C. 状态文案（`public/status-copy.js`）—— 哪些状态该常驻、给什么下一步
 *
 * DOM 行为（面板真的能开、草稿真的落到 localStorage、状态条真的渲染）在
 * `tests/smoke.cjs` 的 P24 段；真实排版在 `tests/cdp-shot.cjs` 的场景里量。
 */
const assert = require('node:assert/strict');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

/** 造一个像 DOM 事件的对象（只需要匹配逻辑用到的那几个字段）。 */
function evt(key, { ctrl = false, meta = false, alt = false, shift = false, target = null, prevented = false } = {}) {
  return {
    key,
    ctrlKey: ctrl,
    metaKey: meta,
    altKey: alt,
    shiftKey: shift,
    target,
    defaultPrevented: prevented,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

const TEXTAREA = { tagName: 'TEXTAREA', isContentEditable: false };
const INPUT = { tagName: 'INPUT', type: 'text', isContentEditable: false };
const BUTTON = { tagName: 'BUTTON', isContentEditable: false };

(async () => {
  const sc = await import('../public/shortcuts.js');
  const pm = await import('../public/palette-model.js');
  const copy = await import('../public/status-copy.js');

  /* ================= A. 快捷键注册表 ================= */
  section('A. 快捷键注册表');
  check('primary 按平台解析（mac → ⌘，别处 → Ctrl）', () => {
    const expected = `${sc.IS_MAC ? 'meta' : 'ctrl'}+k`;
    assert.equal(sc.normalizeCombo('primary+k'), expected);
    assert.equal(sc.normalizeCombo('PRIMARY + K'), expected, '大小写与空格都要认');
    assert.equal(sc.normalizeCombo('alt+1'), 'alt+1');
    assert.equal(sc.normalizeCombo('primary+shift+p'), `${sc.IS_MAC ? 'meta' : 'ctrl'}+shift+p`);
  });
  check('组合修饰键顺序固定（ctrl+alt 与 alt+ctrl 是同一个键）', () => {
    assert.equal(sc.normalizeCombo('alt+ctrl+k'), 'ctrl+alt+k');
    assert.equal(sc.normalizeCombo('shift+ctrl+a'), 'ctrl+shift+a');
  });
  check('畸形组合回 null（不抛、不猜）', () => {
    assert.equal(sc.normalizeCombo(''), null);
    assert.equal(sc.normalizeCombo('ctrl'), null);
    assert.equal(sc.normalizeCombo('ctrl+'), null);
    assert.equal(sc.normalizeCombo(null), null);
  });
  check('事件 → 组合串：只按修饰键不算组合', () => {
    assert.equal(sc.comboFromEvent(evt('k', { ctrl: true })), 'ctrl+k');
    assert.equal(sc.comboFromEvent(evt('K', { ctrl: true, shift: true })), 'ctrl+shift+k');
    assert.equal(sc.comboFromEvent(evt('Control', { ctrl: true })), null);
    assert.equal(sc.comboFromEvent(evt(' ')), 'space');
    assert.equal(sc.comboFromEvent(null), null);
  });
  check('平台显示写法', () => {
    const display = sc.formatCombo('primary+k');
    assert.equal(display, sc.IS_MAC ? '⌘K' : 'Ctrl+K');
    assert.equal(sc.formatCombo('alt+1'), sc.IS_MAC ? '⌥1' : 'Alt+1');
    assert.equal(sc.formatCombo('primary+/'), sc.IS_MAC ? '⌘/' : 'Ctrl+/');
  });
  check('文本输入判定：input / textarea / contenteditable 都为真', () => {
    assert.equal(sc.isTextEntry(TEXTAREA), true);
    assert.equal(sc.isTextEntry(INPUT), true);
    assert.equal(sc.isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(sc.isTextEntry(BUTTON), false);
    assert.equal(sc.isTextEntry({ tagName: 'INPUT', type: 'checkbox' }), false, '复选框不吃按键');
    assert.equal(sc.isTextEntry(null), false);
  });

  check('注册：重复 id / 畸形 combo / 缺 run 都在注册时炸（早失败）', () => {
    sc.resetShortcuts();
    sc.registerShortcut({ id: 'a', combo: 'primary+k', label: 'A', run() {} });
    assert.throws(() => sc.registerShortcut({ id: 'a', combo: 'primary+j', run() {} }), /id 重复/);
    assert.throws(() => sc.registerShortcut({ id: 'b', combo: 'ctrl', run() {} }), /无法解析/);
    assert.throws(() => sc.registerShortcut({ id: 'c', combo: 'primary+m' }), /run/);
  });
  check('冲突检测：同一个组合绑两次会被 assertNoConflicts 抓住', () => {
    sc.resetShortcuts();
    sc.registerShortcut({ id: 'x', combo: 'alt+1', run() {} });
    sc.registerShortcut({ id: 'y', combo: 'alt+1', run() {} });
    assert.throws(() => sc.assertNoConflicts(), /冲突/);
    sc.resetShortcuts();
    sc.registerShortcut({ id: 'x', combo: 'alt+1', run() {} });
    sc.registerShortcut({ id: 'y', combo: 'alt+2', run() {} });
    assert.equal(sc.assertNoConflicts(), true);
  });
  check('分发：命中即执行并 preventDefault', () => {
    sc.resetShortcuts();
    let hits = 0;
    sc.registerShortcut({ id: 'go', combo: 'primary+k', run() { hits++; } });
    const e = evt('k', { ctrl: !sc.IS_MAC, meta: sc.IS_MAC, target: BUTTON });
    assert.equal(sc.dispatchShortcut(e).id, 'go');
    assert.equal(hits, 1);
    assert.equal(e.prevented, true);
  });
  check('分发：**不抢普通文本输入**，但带修饰键的照常生效', () => {
    sc.resetShortcuts();
    let plain = 0;
    let ctrl = 0;
    let alt = 0;
    sc.registerShortcut({ id: 'plain', combo: 'k', run() { plain++; } });
    sc.registerShortcut({ id: 'ctrl', combo: 'primary+k', run() { ctrl++; } });
    sc.registerShortcut({ id: 'alt', combo: 'alt+1', run() { alt++; } });
    /* 不带修饰键 → 在文本框里是「打字」，不触发 */
    assert.equal(sc.dispatchShortcut(evt('k', { target: TEXTAREA })), null);
    assert.equal(plain, 0);
    assert.equal(sc.dispatchShortcut(evt('k', { target: INPUT })), null);
    assert.equal(plain, 0);
    /* 带修饰键 → 在输入框里也要生效（Ctrl+K / Alt+1 正是边写边按的） */
    assert.equal(sc.dispatchShortcut(evt('k', { ctrl: !sc.IS_MAC, meta: sc.IS_MAC, target: TEXTAREA })).id, 'ctrl');
    assert.equal(sc.dispatchShortcut(evt('1', { alt: true, target: INPUT })).id, 'alt');
    assert.equal(ctrl, 1);
    assert.equal(alt, 1);
    /* 焦点不在输入里时，普通键位照常生效 */
    assert.equal(sc.dispatchShortcut(evt('k', { target: BUTTON })).id, 'plain');
    assert.equal(plain, 1);
  });
  check('分发：显式 inInput 的键位可以在文本框里用普通键触发', () => {
    sc.resetShortcuts();
    let hits = 0;
    sc.registerShortcut({ id: 'typing-ok', combo: 'k', inInput: true, run() { hits++; } });
    assert.equal(sc.dispatchShortcut(evt('k', { target: TEXTAREA })).id, 'typing-ok');
    assert.equal(hits, 1);
  });
  check('分发：when() 为假不触发；defaultPrevented 不重复处理', () => {
    sc.resetShortcuts();
    let hits = 0;
    sc.registerShortcut({ id: 'gated', combo: 'alt+9', when: () => false, run() { hits++; } });
    assert.equal(sc.dispatchShortcut(evt('9', { alt: true, target: BUTTON })), null);
    assert.equal(hits, 0);
    sc.resetShortcuts();
    sc.registerShortcut({ id: 'ok', combo: 'alt+8', run() { hits++; } });
    assert.equal(sc.dispatchShortcut(evt('8', { alt: true, target: BUTTON, prevented: true })), null);
    assert.equal(hits, 0, '别人已经处理过的按键不再处理');
  });
  check('列表：只读快照，带显示写法与可用性', () => {
    sc.resetShortcuts();
    sc.registerShortcut({ id: 'one', combo: 'alt+1', label: '第一', group: '视图', when: () => true, run() {} });
    sc.registerShortcut({ id: 'two', combo: 'alt+2', label: '第二', group: '视图', when: () => false, run() {} });
    const list = sc.listShortcuts();
    assert.equal(list.length, 2);
    assert.equal(list[0].display, sc.IS_MAC ? '⌥1' : 'Alt+1');
    assert.equal(list[0].available, true);
    assert.equal(list[1].available, false);
  });

  /* ================= B. 命令面板模型 ================= */
  section('B. 命令面板模型');
  const mk = (id, title, extra = {}) => ({ id, title, group: extra.group || '通用', keywords: extra.keywords || '', run: extra.run || (() => {}), ...extra });

  check('注册校验：缺 id / 缺 run / id 重复都抛', () => {
    pm.resetPaletteRegistry();
    pm.defineCommands([mk('a', 'A')]);
    assert.equal(pm.registeredCommands().length, 1);
    assert.throws(() => pm.defineCommands([{ title: '没 id', run() {} }]), /id 与 run/);
    assert.throws(() => pm.defineCommands([{ id: 'b' }]), /id 与 run/);
    assert.throws(() => pm.defineCommands([mk('a', '重复')]), /id 重复/);
  });
  check('when() 为假**不进列表**（不灰着骗人）', () => {
    pm.resetPaletteRegistry();
    let ran = 0;
    pm.defineCommands([
      mk('always', '总是', { run: () => ran++ }),
      mk('never', '从不', { when: () => false }),
      mk('contextual', '有项目时', { when: (c) => c.hasProject === true }),
    ]);
    assert.deepEqual(pm.allCommands({}).map((c) => c.id), ['always']);
    assert.deepEqual(pm.allCommands({ hasProject: true }).map((c) => c.id), ['always', 'contextual']);
  });
  check('动态命令每次求值都拿到当前 query（会话条目靠它按需出现）', () => {
    pm.resetPaletteRegistry();
    pm.defineCommands([mk('static', '静态')]);
    pm.setDynamicCommands((ctx) => (ctx.query ? [mk('dyn', '动态：' + ctx.query)] : []));
    assert.deepEqual(pm.allCommands({ query: '' }).map((c) => c.id), ['static']);
    assert.deepEqual(pm.allCommands({ query: '会话' }).map((c) => c.id), ['static', 'dyn']);
    pm.setDynamicCommands(null);
  });
  check('空查询返回全部且保持定义顺序（打开面板先看到常用动作）', () => {
    pm.resetPaletteRegistry();
    pm.defineCommands([mk('c', 'C'), mk('a', 'A'), mk('b', 'B')]);
    assert.deepEqual(pm.filterCommands(pm.allCommands({}), '').map((c) => c.id), ['c', 'a', 'b']);
    assert.deepEqual(pm.filterCommands(pm.allCommands({}), '   ').map((c) => c.id), ['c', 'a', 'b']);
  });
  check('搜索排序：前缀 > 词首 > 子串 > 子序列', () => {
    pm.resetPaletteRegistry();
    pm.defineCommands([
      mk('sub', '查看扩展面板', { keywords: 'mcp' }),   // 子串/关键词命中
      mk('word', '扩展 MCP 页'),                         // 词首命中
      mk('prefix', 'MCP 管理'),                          // 前缀命中
    ]);
    const ids = pm.filterCommands(pm.allCommands({}), 'mcp').map((c) => c.id);
    assert.deepEqual(ids.slice(0, 3), ['prefix', 'word', 'sub'], JSON.stringify(ids));
  });
  check('搜索：中文子串、关键词、组名都能命中', () => {
    pm.resetPaletteRegistry();
    pm.defineCommands([
      mk('view-mcp', 'MCP', { group: '视图', keywords: 'server 原生' }),
      mk('copy-diag', '复制诊断摘要', { group: '全局', keywords: 'issue copy' }),
    ]);
    assert.deepEqual(pm.filterCommands(pm.allCommands({}), '原生').map((c) => c.id), ['view-mcp']);
    assert.deepEqual(pm.filterCommands(pm.allCommands({}), '诊断').map((c) => c.id), ['copy-diag']);
    assert.deepEqual(pm.filterCommands(pm.allCommands({}), 'issue').map((c) => c.id), ['copy-diag']);
    assert.deepEqual(pm.filterCommands(pm.allCommands({}), '视图').map((c) => c.id), ['view-mcp']);
    assert.deepEqual(pm.filterCommands(pm.allCommands({}), 'zzz-nope').map((c) => c.id), []);
  });
  check('子序列匹配：gmc 命中「切到 MCP」这类缩写输入', () => {
    assert.equal(pm.subsequence('mcp', '能力视图 mcp'), true);
    assert.equal(pm.subsequence('mcp', 'my cat page'), true);
    assert.equal(pm.subsequence('xyz', '能力视图 mcp'), false);
    assert.equal(pm.subsequence('', '任何'), true);
  });

  /* ================= C. 状态文案 ================= */
  section('C. 启动 / 连接状态文案');
  check('六种连接状态都有文案与语气', () => {
    for (const state of ['no-project', 'starting', 'ready', 'restarting', 'exited', 'error']) {
      const copyItem = copy.connectionCopy(state);
      assert.ok(copyItem.label, state);
      assert.ok(typeof copyItem.tone === 'string', state);
    }
    assert.equal(copy.connectionCopy('ready').tone, 'ok');
    assert.equal(copy.connectionCopy('error').tone, 'bad');
    assert.equal(copy.connectionCopy('no-project').label, '未选择项目');
  });
  check('exited 用后端给的具体原因当标签（「pi 已退出 (1)」这类）', () => {
    assert.equal(copy.connectionCopy('exited', 'pi 已退出 (1)').label, 'pi 已退出 (1)');
    assert.equal(copy.connectionCopy('exited').label, 'pi 已退出');
  });
  check('启动失败 → 常驻说明带后端 error + hint，并给两个下一步', () => {
    const model = copy.startupNotice({
      bridgeState: 'error',
      bridgeError: '无法启动 pi：spawn pi ENOENT',
      bridgeHint: '确认 pi 已安装并在 PATH 中，或用环境变量 PI_BIN 指定完整路径。',
      hasProject: true,
    });
    assert.equal(model.id, 'bridge-error');
    assert.equal(model.tone, 'bad');
    assert.ok(model.detail.includes('ENOENT'));
    assert.ok(model.detail.includes('PATH'), '后端给的下一步必须原样带上');
    assert.deepEqual(model.actions, ['restart', 'diagnostics']);
  });
  check('pi 已退出 → 也常驻（不然用户只看到一条会消失的 toast）', () => {
    const model = copy.startupNotice({ bridgeState: 'exited', hasProject: true });
    assert.equal(model.id, 'bridge-exited');
    assert.deepEqual(model.actions, ['restart', 'diagnostics']);
  });
  check('没选项目 / 正常 / 启动中都不占用常驻条', () => {
    for (const ctx of [
      { bridgeState: 'starting', hasProject: true },
      { bridgeState: 'ready', hasProject: true },
      { bridgeState: 'restarting', hasProject: true },
      { bridgeState: 'error', hasProject: false },
    ]) {
      assert.equal(copy.startupNotice(ctx), null, JSON.stringify(ctx));
    }
  });
  check('关键能力不可用 → 常驻说明只给诊断入口（没有可自动做的修复）', () => {
    const model = copy.startupNotice({
      bridgeState: 'ready',
      hasProject: true,
      compat: { status: 'incompatible', missing: ['getState', 'rpc'] },
    });
    assert.equal(model.id, 'compat-incompatible');
    assert.deepEqual(model.actions, ['diagnostics']);
    assert.ok(model.detail.includes('getState'));
  });
  check('每个动作都有按钮文案与悬停说明（帮助面板与状态条共用一份）', () => {
    for (const [id, meta] of Object.entries(copy.NOTICE_ACTIONS)) {
      assert.ok(meta.label && meta.title, id);
    }
    assert.deepEqual(Object.keys(copy.NOTICE_ACTIONS).sort(), ['diagnostics', 'restart']);
  });
  check('面板 loading / empty / failed 文案统一，且重试是独立的一句', () => {
    assert.equal(copy.SURFACE_COPY.loading('文件变更'), '正在读取文件变更…');
    assert.equal(copy.SURFACE_COPY.empty('文件变更'), '还没有文件变更。');
    assert.equal(copy.SURFACE_COPY.failed('文件变更'), '文件变更读取失败。');
    assert.equal(copy.SURFACE_COPY.retry, '重试');
  });

  console.log(`\n${count}/${count} 通过`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
