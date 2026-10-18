/* UI-3C：Composer 内联 Slash 命令菜单 —— 离线契约（jsdom）。
 *
 * 覆盖任务 C1–C5 的可离线判定部分：
 *   1 输入 `/`         2 输入 `/query`      3 URL/路径不误触发
 *   4 when(ctx) 过滤   5 ArrowUp/Down       6 Enter/Tab
 *   7 Escape 只关菜单  8 中文 IME 组合       9 Enter 不发消息
 *  10 旧 Palette 仍在 11 会话/项目切换关闭  12 过期候选不可执行
 *  13 未知命令不发指令 14 destroy 无重复监听
 *  15 这里是 CSS/DOM 契约；真实 Electron（右栏 Browser / 明暗 / 窄屏）在
 *     docs/claude-ui-redesign/ui3-c-evidence/ 的截图夹具里，截图才是排版证据。
 *
 * 本文件**不依赖真 pi、不联网、不写用户数据**：只 import public 下的真模块，
 * 用 index.html 的真 DOM。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

(async () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.navigator = dom.window.navigator;
  global.CustomEvent = dom.window.CustomEvent;
  global.Event = dom.window.Event;
  global.KeyboardEvent = dom.window.KeyboardEvent;

  /* 记录任何出站 RPC —— 用来证明「未知/过期命令不会伪造指令」。 */
  const fetches = [];
  const fetchStub = async (url, opts) => { fetches.push({ url: String(url), body: opts && opts.body }); return { json: async () => ({ ok: true }) }; };
  global.fetch = fetchStub;
  dom.window.fetch = fetchStub;

  const pm = await import('../public/palette-model.js');
  const { createInlineCommandMenu, parseSlashTrigger, ensureStylesheet } = await import('../public/ui/inline-command-menu.js');
  const palette = await import('../public/palette.js');

  const input = dom.window.document.getElementById('input');

  /* ---------- 造一批真实注册表命令（与 app.js 同一份注册表） ---------- */
  const runs = { alpha: 0, beta: 0, hidden: 0, flaky: 0 };
  const ctx = { allow: false, ok: true };
  pm.resetPaletteRegistry();
  pm.defineCommands([
    { id: 'alpha', title: 'Alpha 命令', group: '测试', keywords: 'first 甲', hint: 'Ctrl+A', run: () => runs.alpha++ },
    { id: 'beta', title: 'Beta 命令', group: '测试', keywords: 'second 乙', run: () => runs.beta++ },
    { id: 'hidden', title: 'Gamma 秘密', group: '测试', when: (c) => c.allow === true, run: () => runs.hidden++ },
    { id: 'flaky', title: 'Flaky 命令', group: '测试', when: (c) => c.ok !== false, run: () => runs.flaky++ },
  ]);

  /* ---------- 集成契约：与 app.js 建议的接法完全一致 ----------
   * 在原有 keydown 分支**之前**调用 handleKeydown 并 return；其余走既有 submit/stop。 */
  let submits = 0;
  let stops = 0;
  let controller = createInlineCommandMenu({ input, getContext: () => ({ ...ctx }) });
  input.addEventListener('keydown', (e) => {
    if (controller.handleKeydown(e)) return;      // ← 集成方要加的那一行
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submits++; }
    else if (e.key === 'Escape') { stops++; }
  });
  controller.attach();

  /* ---------- 工具 ---------- */
  const setInput = (value, caret = value.length) => {
    input.value = value;
    try { input.setSelectionRange(caret, caret); } catch { /* ignore */ }
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const key = (k, opts = {}) => {
    const e = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
    input.dispatchEvent(e);
    return e;
  };
  const reset = () => { for (const id of Object.keys(runs)) runs[id] = 0; submits = 0; stops = 0; fetches.length = 0; };
  const items = () => controller.items().map((c) => c.id);

  /* ================= 1. 输入 `/` ================= */
  section('1. 输入 `/` 打开全部可执行命令');
  check('行首 `/` 打开菜单，候选 = allCommands({query:""})', () => {
    reset();
    setInput('/');
    assert.equal(controller.isOpen(), true, '菜单应打开');
    assert.deepEqual(items(), pm.allCommands({ query: '' }).map((c) => c.id), '应与注册表同一份真相');
    assert.equal(controller.activeIndex(), 0);
  });
  check('前导空白的行首也能触发', () => {
    setInput('   /');
    assert.equal(controller.isOpen(), true);
    assert.equal(controller.query(), '');
    assert.equal(parseSlashTrigger('  /', 3).start, 2);
  });
  check('换行后的行首能触发（多行输入）', () => {
    const value = '第一行\n/';
    setInput(value);
    assert.equal(controller.isOpen(), true);
    assert.equal(controller.query(), '');
  });
  check('失去命令前缀后自动关闭', () => {
    setInput('/al');
    assert.equal(controller.isOpen(), true);
    setInput('删掉了');
    assert.equal(controller.isOpen(), false, '不再是命令片段就关闭');
  });

  /* ================= 2. 输入 `/query` 实时筛选 ================= */
  section('2. 输入 `/query` 实时筛选');
  check('`/al` 只留 alpha；`/zzz` 无候选', () => {
    setInput('/al');
    assert.deepEqual(items(), ['alpha']);
    setInput('/zzz');
    assert.equal(controller.isOpen(), true, '无候选时菜单仍开（给明确空状态）');
    assert.deepEqual(items(), []);
  });
  check('无候选展示明确空状态', () => {
    setInput('/zzz');
    const empty = controller.menuElement().querySelector('.ui3-inline-empty');
    assert.ok(empty, '存在空状态节点');
    assert.equal(empty.hidden, false, '空状态可见');
    assert.equal(empty.textContent, '没有匹配的命令');
  });
  check('有候选时空状态隐藏', () => {
    setInput('/al');
    assert.equal(controller.menuElement().querySelector('.ui3-inline-empty').hidden, true);
  });

  /* ================= 3. URL / 路径不误触发 ================= */
  section('3. URL 与路径不误触发');
  for (const [label, value] of [
    ['https URL', 'https://example.com/path'],
    ['scheme 后斜杠', 'http://127.0.0.1:8080/'],
    ['Windows 绝对路径', 'C:\\Users\\me\\a/b.txt'],
    ['普通正文里的斜杠', 'and/or not a command'],
    ['行内（非行首）斜杠', '看看 /help 文档'],
  ]) {
    check(label + ' 不触发菜单', () => {
      reset();
      setInput(value);
      assert.equal(controller.isOpen(), false, value);
    });
  }
  check('行首 POSIX 路径：第二个 `/` 立即关闭且从不执行', () => {
    reset();
    setInput('/usr');
    /* 单个 `/usr` 是合法命令词、无候选 —— 只是空状态，不会执行任何东西。 */
    assert.equal(controller.isOpen(), true);
    assert.deepEqual(items(), []);
    assert.deepEqual(Object.values(runs).filter((n) => n > 0), [], '没有任何命令被触发');
    setInput('/usr/bin');
    assert.equal(controller.isOpen(), false, '出现第二个 `/` 立刻关闭');
    assert.equal(fetches.length, 0, '没有发出任何 RPC');
  });
  check('parseSlashTrigger 直接判据', () => {
    assert.deepEqual(parseSlashTrigger('/', 1), { start: 0, end: 1, query: '', caret: 1 });
    assert.equal(parseSlashTrigger('你好 /he', 6), null, '前面有非空白正文 → 不是行首');
    assert.equal(parseSlashTrigger('  /ab', 3), null, '光标停在词中间 → 不完整');
    assert.equal(parseSlashTrigger('x/y', 3), null);
  });

  /* ================= 4. when(ctx) 过滤 ================= */
  section('4. 仅展示 when(ctx) 可执行的命令');
  check('when 为假不进候选，为真才进', () => {
    ctx.allow = false;
    setInput('/');
    assert.ok(!items().includes('hidden'), 'when=false 不出现（不灰着骗人）');
    ctx.allow = true;
    setInput('/');
    assert.ok(items().includes('hidden'), 'when=true 出现');
    ctx.allow = false;
  });
  check('与独立 Palette 用同一份 when 判定', () => {
    ctx.allow = false;
    setInput('/');
    assert.deepEqual(items(), pm.allCommands({ query: '' }).map((c) => c.id));
  });

  /* ================= 5. ArrowUp / ArrowDown ================= */
  section('5. ArrowUp / ArrowDown 移动活动项');
  check('ArrowDown/Up 移动并 preventDefault，且不发送消息', () => {
    reset();
    setInput('/');
    const n = controller.items().length;
    assert.ok(n >= 2, '至少两条候选');
    const down = key('ArrowDown');
    assert.equal(controller.activeIndex(), 1);
    assert.equal(down.defaultPrevented, true, '方向键默认行为被拦下');
    key('ArrowDown');
    assert.equal(controller.activeIndex(), 2);
    key('ArrowUp');
    assert.equal(controller.activeIndex(), 1);
    assert.equal(submits, 0);
    assert.equal(controller.isOpen(), true);
  });
  check('环形移动（首尾相接）', () => {
    controller.close();
    setInput('/');
    const n = controller.items().length;
    for (let i = 0; i < n; i++) key('ArrowUp');
    assert.equal(controller.activeIndex(), 0, `绕一圈回到 0（n=${n}）`);
  });

  /* ================= 6. Enter / Tab 接受 ================= */
  section('6. Enter / Tab 接受当前命令');
  check('Enter 执行选中命令、清理输入片段、关闭菜单', () => {
    reset();
    setInput('/al');
    assert.deepEqual(items(), ['alpha']);
    key('Enter');
    assert.equal(runs.alpha, 1, '执行了 alpha.run()');
    assert.equal(controller.isOpen(), false, '菜单关闭');
    assert.equal(input.value, '', '输入里的 `/al` 被清理');
  });
  check('Tab 也接受（契约规定适用时）', () => {
    reset();
    setInput('/be');
    assert.deepEqual(items(), ['beta']);
    const e = key('Tab');
    assert.equal(e.defaultPrevented, true);
    assert.equal(runs.beta, 1);
    assert.equal(controller.isOpen(), false);
  });
  check('Shift+Tab 不接受（保留给反向焦点）', () => {
    reset();
    setInput('/al');
    key('Tab', { shiftKey: true });
    assert.equal(runs.alpha, 0, 'Shift+Tab 未接受命令');
    assert.equal(controller.isOpen(), true, '菜单仍开着');
  });

  /* ================= 7. Escape 只关菜单 ================= */
  section('7. Escape 只关闭菜单，不触发 stop');
  check('Escape 关闭菜单、不执行命令、不触发既有 Escape(stop)', () => {
    reset();
    setInput('/al');
    const e = key('Escape');
    assert.equal(controller.isOpen(), false, '菜单关闭');
    assert.equal(stops, 0, '没有冒泡到 app.js 的 Escape(stop)');
    assert.equal(runs.alpha, 0, '没有执行命令');
    assert.equal(e.defaultPrevented, true);
  });
  check('菜单没开时 Escape 照常走既有行为', () => {
    reset();
    setInput('普通文本');
    assert.equal(controller.isOpen(), false);
    key('Escape');
    assert.equal(stops, 1, '没有菜单时 Escape 仍是既有 stop 分支');
  });

  /* ================= 8. 中文输入法 ================= */
  section('8. 中文输入法 composition 不误确认');
  check('composition 期间不触发；compositionend 后再判断', () => {
    reset();
    input.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    assert.equal(controller.isComposing(), true);
    input.value = '/al';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(controller.isOpen(), false, '组合期间不弹菜单');
    input.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    assert.equal(controller.isComposing(), false);
    assert.equal(controller.isOpen(), true, '组合结束后按当前值重新判断');
    controller.close();
  });
  check('isComposing 的 Enter 不被接受（交给输入法上屏）', () => {
    reset();
    setInput('/al');
    assert.equal(controller.isOpen(), true);
    const e = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(e, 'isComposing', { value: true });
    input.dispatchEvent(e);
    assert.equal(runs.alpha, 0, '组合中的 Enter 不执行命令');
    assert.equal(submits, 0, '组合中的 Enter 也不发送消息');
    assert.equal(controller.isOpen(), true, '菜单仍在，等输入法结束');
    controller.close();
  });
  check('keyCode 229（IME 占位键）不被接受', () => {
    reset();
    setInput('/al');
    const e = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: 229 });
    input.dispatchEvent(e);
    assert.equal(runs.alpha, 0);
    assert.equal(submits, 0);
    controller.close();
  });

  /* ================= 9. Enter 不会既执行又发送 ================= */
  section('9. Enter 不会同时执行命令并发送聊天');
  check('一次 Enter：命令执行 1 次、聊天发送 0 次', () => {
    reset();
    setInput('/al');
    key('Enter');
    assert.equal(runs.alpha, 1);
    assert.equal(submits, 0, 'handleKeydown 消费了 Enter，submit 不触发');
  });
  check('Shift+Enter 不执行命令（交给 Composer 换行）', () => {
    reset();
    setInput('/al');
    key('Enter', { shiftKey: true });
    assert.equal(runs.alpha, 0);
    assert.equal(submits, 0, 'Shift+Enter 既不发消息也不接受命令');
    assert.equal(controller.isOpen(), true);
  });
  check('菜单关闭后 Enter 仍是原有发送行为', () => {
    reset();
    controller.close();
    setInput('普通消息');
    key('Enter');
    assert.equal(submits, 1, '没有菜单时 Enter = 发送');
  });

  /* ================= 10. 旧独立 Palette 仍可打开 ================= */
  section('10. 独立命令面板完整保留');
  check('palette.openPalette() 仍能打开、内容来自同一注册表', () => {
    const layer = dom.window.document.getElementById('paletteLayer');
    assert.equal(palette.paletteOpen(), false);
    const ok = palette.openPalette({});
    assert.equal(ok, true);
    assert.equal(palette.paletteOpen(), true);
    assert.equal(layer.hidden, false);
    const rows = [...layer.querySelectorAll('.palette-item')].map((r) => r.dataset.commandId);
    assert.ok(rows.includes('alpha'), '面板列出同一注册表的命令');
    palette.closePalette({ restoreFocus: false });
    assert.equal(palette.paletteOpen(), false);
  });

  /* ================= 11. 项目 / 会话切换关闭菜单 ================= */
  section('11. 项目 / 会话切换关闭菜单并清上下文');
  check('pi-gui:workspace-generation 事件关闭菜单', () => {
    reset();
    setInput('/al');
    assert.equal(controller.isOpen(), true);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation', { detail: { generation: 2 } }));
    assert.equal(controller.isOpen(), false, '切项目/会话即关闭');
  });
  check('关闭后不会用旧候选在新上下文执行', () => {
    reset();
    setInput('/al');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation', { detail: { generation: 3 } }));
    assert.equal(controller.isOpen(), false, '切项目/会话即关闭');
    key('Enter');
    assert.equal(runs.alpha, 0, '旧候选不再执行');
    assert.equal(fetches.length, 0, '没有伪造 RPC（菜单关着的 Enter 走既有发送路径，与本模块无关）');
  });

  /* ========== 11b. 会话切换（generation 不变）与中央视图切换 ========== */
  section('11b. session-switch / workspace-view 生命周期');
  check('pi-gui:session-switch 关闭菜单（同一 workspaceGeneration 内）', () => {
    reset();
    setInput('/al');
    assert.equal(controller.isOpen(), true);
    assert.equal(input.value, '/al');
    /* 会话切换在 rpc.js 的 afterSessionSwitch 里发；**不**递增 workspaceGeneration，
     * 所以只靠 workspace-generation 的旧实现会漏掉这条。 */
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:session-switch'));
    assert.equal(controller.isOpen(), false, '同代内换会话也要关闭');
    assert.equal(input.value, '/al', '不替用户清空草稿');
    assert.equal(submits, 0, '不提交输入框');
    assert.equal(stops, 0, '不停止任务');
    assert.equal(runs.alpha, 0, '不执行待选命令');
  });
  check('会话切换后旧候选不能被执行、不发 RPC', () => {
    reset();
    setInput('/al');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:session-switch'));
    key('Enter');
    assert.equal(runs.alpha, 0, '旧会话的待选命令不被执行');
    assert.equal(fetches.length, 0, '没有伪造 RPC');
  });
  check('workspace-view 离开 Chat（planner/runtime/extensions）时关闭', () => {
    for (const view of ['planner', 'runtime', 'extensions']) {
      reset();
      setInput('/al');
      assert.equal(controller.isOpen(), true, view);
      dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-view', { detail: { view } }));
      assert.equal(controller.isOpen(), false, '离开 Chat 即关闭：' + view);
      assert.equal(input.value, '/al', '草稿保留：' + view);
    }
  });
  check('返回 Chat（workspace-view detail=chat）不自动弹出', () => {
    reset();
    setInput('/al');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-view', { detail: { view: 'planner' } }));
    assert.equal(controller.isOpen(), false);
    /* 回来时输入框里还残留 `/al` —— 但用户没敲 `/`，不该自己弹菜单。 */
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-view', { detail: { view: 'chat' } }));
    assert.equal(controller.isOpen(), false, '返回 Chat 不自动打开');
    assert.equal(input.value, '/al');
    /* 空输入 + chat 事件同样不弹 */
    setInput('');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-view', { detail: { view: 'chat' } }));
    assert.equal(controller.isOpen(), false);
  });

  /* ================= 12/13. 过期 / 未知命令不执行、不伪造 ================= */
  section('12/13. 过期与未知候选不可执行、不发伪造指令');
  check('打开后命令变得不可用 → 接受时按 when 重新判定，不执行', () => {
    reset();
    ctx.ok = true;
    setInput('/fla');
    assert.deepEqual(items(), ['flaky']);
    ctx.ok = false;                 // 命令随后不可用（例如 run 结束 / 会话变化）
    key('Enter');
    assert.equal(runs.flaky, 0, '不能借旧候选绕过 when(ctx)');
    assert.equal(controller.isOpen(), false);
    ctx.ok = true;
  });
  check('候选 id 从注册表消失（未知命令）→ 不执行、不发 RPC', () => {
    reset();
    setInput('/al');
    assert.deepEqual(items(), ['alpha']);
    /* 模拟注册表被清空/换掉：旧候选的 id 已不再存在。 */
    pm.resetPaletteRegistry();
    pm.defineCommands([{ id: 'other', title: 'Other', group: '测试', run: () => { throw new Error('不该执行'); } }]);
    key('Enter');
    assert.equal(runs.alpha, 0, '未知 id 不执行原命令');
    assert.equal(fetches.length, 0, '没有发出任何伪造 RPC');
    /* 复原注册表，后续用例继续用 */
    pm.resetPaletteRegistry();
    pm.defineCommands([
      { id: 'alpha', title: 'Alpha 命令', group: '测试', keywords: 'first 甲', hint: 'Ctrl+A', run: () => runs.alpha++ },
      { id: 'beta', title: 'Beta 命令', group: '测试', keywords: 'second 乙', run: () => runs.beta++ },
      { id: 'hidden', title: 'Gamma 秘密', group: '测试', when: (c) => c.allow === true, run: () => runs.hidden++ },
      { id: 'flaky', title: 'Flaky 命令', group: '测试', when: (c) => c.ok !== false, run: () => runs.flaky++ },
    ]);
  });
  check('模块从不调用 fetch / 不拼 RPC（只调 cmd.run）', () => {
    reset();
    setInput('/al');
    key('Enter');
    assert.equal(runs.alpha, 1);
    assert.equal(fetches.length, 0, '执行链路里没有网络/RPC');
  });

  /* ================= a11y / DOM ================= */
  section('可访问性契约');
  check('listbox / option / aria-expanded / aria-activedescendant', () => {
    setInput('/al');
    const list = controller.listElement();
    assert.equal(list.getAttribute('role'), 'listbox');
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    assert.equal(input.getAttribute('aria-controls'), list.id);
    const opt = list.querySelector('.ui3-inline-item');
    assert.equal(opt.getAttribute('role'), 'option');
    assert.equal(opt.getAttribute('aria-selected'), 'true');
    assert.equal(input.getAttribute('aria-activedescendant'), opt.id);
    controller.close();
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(input.hasAttribute('aria-activedescendant'), false);
  });
  check('候选行显示名称 / 分组 / 快捷键提示', () => {
    setInput('/al');
    const opt = controller.listElement().querySelector('.ui3-inline-item');
    assert.equal(opt.querySelector('.ui3-inline-title').textContent, 'Alpha 命令');
    assert.equal(opt.querySelector('.ui3-inline-group').textContent, '测试');
    assert.equal(opt.querySelector('.ui3-inline-hint').textContent, 'Ctrl+A');
    controller.close();
  });
  check('鼠标点击候选执行', () => {
    reset();
    setInput('/be');
    const opt = controller.listElement().querySelector('.ui3-inline-item');
    opt.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.equal(runs.beta, 1, '点击即执行');
    assert.equal(controller.isOpen(), false);
  });

  /* ================= 14. destroy 清理 ================= */
  section('14. destroy 后无重复监听 / 无残留 DOM');
  check('destroy 移除 DOM、监听与 aria；重挂后不重复', () => {
    const base = dom.window.document.querySelectorAll('.ui3-inline-menu').length;
    const solo = createInlineCommandMenu({ input, getContext: () => ({ ...ctx }), injectStyles: false });
    solo.attach();
    assert.equal(dom.window.document.querySelectorAll('.ui3-inline-menu').length, base + 1);
    solo.destroy();
    assert.equal(solo.menuElement(), null);
    assert.equal(solo.isOpen(), false);
    assert.equal(dom.window.document.querySelectorAll('.ui3-inline-menu').length, base, 'DOM 被清理');
    assert.equal(input.getAttribute('aria-expanded'), 'false', 'aria 回到折叠态');
    assert.equal(input.hasAttribute('aria-controls'), false, 'aria-controls 被清理');

    /* 销毁后输入不再弹菜单 */
    input.value = '/al';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(solo.isOpen(), false, '销毁后监听已移除');

    /* 重挂只产生一个菜单、一次处理器 */
    solo.attach();
    assert.equal(dom.window.document.querySelectorAll('.ui3-inline-menu').length, base + 1, '重挂不重复 DOM');
    runs.alpha = 0;
    input.value = '/al';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    solo.handleKeydown(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.equal(runs.alpha, 1, '重挂后只执行一次，无重复监听');
    solo.destroy();
    input.value = '';
  });
  check('ensureStylesheet 幂等且指向 ui3-inline-commands.css', () => {
    const a = ensureStylesheet(dom.window.document);
    const b = ensureStylesheet(dom.window.document);
    assert.equal(a, b, '只注入一个 link');
    assert.equal(dom.window.document.querySelectorAll('link[data-ui3-inline-commands]').length, 1);
    assert.ok(String(a.href).includes('ui3-inline-commands.css'), String(a.href));
  });
  check('生命周期监听随 destroy 解绑、重挂不重复绑定', () => {
    controller.close();
    const base = dom.window.document.querySelectorAll('.ui3-inline-menu').length;
    const solo = createInlineCommandMenu({ input, getContext: () => ({ ...ctx }), injectStyles: false });
    solo.attach();
    solo.attach(); // 幂等
    assert.equal(dom.window.document.querySelectorAll('.ui3-inline-menu').length, base + 1, '重复 attach 不重复 DOM');
    const openVia = () => {
      input.value = '/al';
      input.setSelectionRange(3, 3);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    openVia();
    assert.equal(solo.isOpen(), true);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:session-switch'));
    assert.equal(solo.isOpen(), false, 'session-switch 生效且只绑一次');
    openVia();
    assert.equal(solo.isOpen(), true);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-view', { detail: { view: 'runtime' } }));
    assert.equal(solo.isOpen(), false, 'workspace-view 生效且只绑一次');

    solo.destroy();
    /* destroy 后三个生命周期事件都不该再影响它、也不该抛。 */
    openVia();
    assert.equal(solo.isOpen(), false, '销毁后不再响应输入');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:session-switch'));
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation', { detail: { generation: 9 } }));
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-view', { detail: { view: 'planner' } }));
    assert.equal(solo.isOpen(), false, '销毁后生命周期事件无副作用');
    solo.destroy(); // 幂等
    input.value = '';
  });

  /* ================= 15. CSS 契约（真实排版看 Electron 截图） ================= */
  section('15. 样式表类名契约（排版证据见 Electron 截图）');
  check('CSS 含约定类名与 reduced-motion 分支', () => {
    const css = fs.readFileSync(path.join(__dirname, '../public/ui3-inline-commands.css'), 'utf8');
    for (const sel of ['.ui3-inline-menu', '.ui3-inline-list', '.ui3-inline-item', '.ui3-inline-empty', '.ui3-inline-hint']) {
      assert.ok(css.includes(sel), '缺少选择器 ' + sel);
    }
    assert.ok(css.includes('prefers-reduced-motion'), '缺少 reduced-motion 分支');
    assert.ok(css.includes('--ui-popover-surface') || css.includes('var(--ui-'), '使用 token 变量而非写死颜色');
  });

  console.log(`\n${count}/${count} 通过`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
