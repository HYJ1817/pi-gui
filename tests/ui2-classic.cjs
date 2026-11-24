/* UI-2A: actual Classic modules, offline DOM fixtures; --electron adds real rendering/keyboard evidence. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const text = value => ({ type: 'text', text: value });
const assistant = (value, usage) => ({ role: 'assistant', content: [text(value)], ...(usage === undefined ? {} : { usage }), stopReason: 'stop' });
const call = (id, name = 'read') => ({ type: 'toolCall', id, name, arguments: { path: 'fixture.txt' } });
const result = (id, isError = false, output = 'fixture output') => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [text(output)], isError });

async function unit() {
  const { JSDOM } = require('jsdom');
  const { bundle } = require('./esm-bundle.cjs');
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), { url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.fetch = async () => ({ ok: true, json: async () => ({ ok: true, files: [], isRepo: false }) });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(bundle(path.join(PUB, 'tools.js')).code);
  const { normalizeUsage } = await import('../public/message-meta.js');
  let passed = 0, failed = 0;
  const check = (name, run) => { try { run(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); } };
  const equal = assert.equal;
  const pause = () => new Promise(resolve => setTimeout(resolve, 35));
  const reset = () => { w.resetTimeline(); w.clearThread(); };
  const one = selector => d.querySelector('#stream ' + selector);
  const all = selector => [...d.querySelectorAll('#stream ' + selector)];
  const question = value => ({ role: 'user', content: [text(value)] });
  const usagePopup = () => d.querySelector('#messageUsagePopover');
  const openUsage = root => { root?.querySelector('.message-usage')?.click(); return usagePopup(); };
  const closeUsage = () => d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const gridValue = (pop, kind) => pop?.querySelector('.usage-pop-grid')
    ?.querySelector(`[data-kind="${kind}"]`)?.textContent || '';
  const usageValue = (root, kind) => { const pop = openUsage(root); const value = gridValue(pop, kind); closeUsage(); return value; };
  const usageState = () => all('.msg.assistant').map(node => {
    const button = node.querySelector('.message-usage');
    return button ? JSON.stringify(button._usageRecords) : null;
  });
  const data = [
    question('q1'), assistant('first', { input: 11, output: 3, reasoning: 0, totalTokens: 14 }),
    question('q2'), assistant('second', { input: 29, output: 7, reasoning: 2 }),
    question('q3'), assistant('unknown'),
    question('q4'), assistant('zero', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, totalTokens: 0 }),
  ];
  try {
    w.S.localUsage.lastTurn = { inputTokens: 999999, outputTokens: 888888 };
    w.rebuildFromMessages(data);
    check('message-specific usage exists for three known turns', () => equal(all('.message-usage').length, 3));
    check('each turn keeps its own input usage', () => {
      equal(usageValue(all('.msg.assistant')[0], 'input'), '11 Token');
      equal(usageValue(all('.msg.assistant')[1], 'input'), '29 Token');
    });
    check('missing usage stays absent despite global lastTurn', () => equal(all('.msg.assistant')[2].querySelector('.message-usage'), null));
    check('zero reasoning is distinct from unknown', () => {
      const pop = openUsage(all('.msg.assistant')[0]);
      equal(gridValue(pop, 'reasoning'), '0 Token');
      assert.ok(pop.textContent.includes('推理（含在输出中）'));
      closeUsage();
    });
    check('all seven actual zero fields remain visible', () => {
      const pop = openUsage(all('.msg.assistant')[3]);
      equal(pop.querySelectorAll('.usage-pop-grid [data-kind]').length, 7);
      closeUsage();
    });
    check('global or inferred time never enters usage', () => {
      const pop = openUsage(all('.msg.assistant')[0]);
      assert.ok(!/999999|888888|耗时|秒|ms/.test(pop.textContent));
      closeUsage();
    });
    const historyUsage = usageState();
    reset();
    for (const message of data) {
      if (message.role === 'user') { w.beginTurn(); w.onMessageStart({ message }); continue; }
      w.onMessageStart({ message: { role: 'assistant' } });
      w.onMessageUpdate({ usage: { input: 999 }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'draft' } });
      w.onMessageEnd({ message });
      w.onSettled();
    }
    check('live final authoritative usage equals historical usage', () => assert.deepEqual(usageState(), historyUsage));
    check('live authoritative body replaces streamed draft', () => equal(all('.msg.assistant')[0].querySelector('.msg-body').textContent, 'first'));
    w.rebuildFromMessages([question('bad'), assistant('bad', { input: '12', output: NaN, totalTokens: Infinity, reasoning: -1, cacheRead: null }), question('partial'), assistant('partial', { input: 4, output: 2 })]);
    check('malformed usage cannot create numeric metadata', () => equal(all('.msg.assistant')[0].querySelector('.message-usage'), null));
    check('total is not invented by adding input/output', () => equal(usageValue(all('.msg.assistant')[1], 'totalTokens'), ''));
    check('empty and malformed usage payloads create no entry', () => {
      equal(normalizeUsage({}), null);
      equal(normalizeUsage([]), null);
    });
    w.rebuildFromMessages([question('tool-only'), { role: 'assistant', content: [call('only-tool')], usage: { input: 100, output: 0 } }, result('only-tool'),
      question('thinking-only'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'provided thinking' }], usage: { output: 1 } }]);
    check('tool-only usage does not resurrect empty assistant shell', () => equal(all('.msg.assistant').length, 1));
    check('tool-only tool entry is retained', () => equal(all('.tl-item').length, 1));
    reset(); w.beginTurn(); w.onMessageStart({ message: { role: 'user', content: [text('pending')] } });
    w.onMessageStart({ message: { role: 'assistant' } });
    w.onMessageUpdate({ usage: { input: 999 }, assistantMessageEvent: { type: 'text_delta', delta: 'pending', contentIndex: 0 } });
    check('pending update usage is not promoted to authoritative usage', () => equal(all('.message-usage').length, 0));
    w.onMessageEnd({ message: { role: 'assistant', content: [call('live-only')], usage: { input: 9 } } });
    check('live tool-only final removes shell even with usage and streamed draft', () => equal(all('.msg.assistant').length, 0));
    w.rebuildFromMessages([question('tool-only'), { role: 'assistant', content: [call('only-tool')], usage: { input: 100, output: 0 } }, result('only-tool'),
      question('thinking-only'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'provided thinking' }], usage: { output: 1 } }]);
    check('thinking-only message keeps actual usage', () => equal(usageValue(one('.msg.assistant'), 'output'), '1 Token'));
    check('single tool has no duplicate batch title', () => { equal(one('.tl-group-head').hidden, true); equal(one('.tl-group-head').textContent, ''); equal(one('.tl-list').hidden, false); });
    reset();
    w.onMessageStart({ message: { role: 'assistant' } });
    w.onMessageEnd({ message: { role: 'assistant', content: [call('a'), call('b')], usage: { output: 0 } } });
    w.onToolStart({ toolCallId: 'a', toolName: 'read', args: { path: 'fixture.txt' } });
    w.onToolStart({ toolCallId: 'b', toolName: 'read', args: { path: 'fixture.txt' } });
    const group = one('.tl-group'), nativeList = group.querySelector('.tl-list');
    const work = group.closest('[data-conversation-work]');
    const head = work.querySelector('.conversation-work-head'), list = work.querySelector('.conversation-work-list');
    check('real message boundary groups both tools once', () => { equal(all('.tl-group').length, 1); equal(nativeList.children.length, 2); assert.match(head.textContent, /工作记录.*2 次工具/); });
    check('batch summary is native keyboard button', () => { equal(head.tagName, 'BUTTON'); equal(head.type, 'button'); assert.ok(head.classList.contains('conversation-work-head')); });
    check('multiple running tools start expanded by default', () => { equal(list.hidden, false); equal(head.getAttribute('aria-expanded'), 'true'); });
    head.click();
    check('summary controls its unique ARIA list', () => { assert.ok(list.id); equal(head.getAttribute('aria-controls'), list.id); equal(head.getAttribute('aria-expanded'), 'false'); });
    check('batch can collapse without destroying tool nodes', () => { equal(list.hidden, true); equal(head.getAttribute('aria-expanded'), 'false'); equal(nativeList.children.length, 2); });
    check('running tools are discoverable while collapsed', () => assert.match(head.textContent, /运行中 2/));
    w.onToolEnd({ toolCallId: 'a', isError: true, result: { content: [text('provider cancelled request')] } });
    check('failure stays discoverable while collapsed', () => assert.match(head.textContent, /失败 1/));
    check('provider cancellation error is not silently reclassified', () => { equal(nativeList.children[0].dataset.status, 'error'); assert.match(nativeList.children[0].textContent, /cancelled/); });
    check('status updates preserve chosen collapsed state', () => equal(list.hidden, true));
    w.interruptActive();
    check('settled running tool becomes discoverable incomplete', () => assert.match(head.textContent, /未完成 1/));
    head.click();
    check('batch expands same list and tool ids', () => { equal(head.getAttribute('aria-expanded'), 'true'); equal(list.hidden, false); equal(nativeList.children[0].dataset.id, 'a'); });
    list.querySelector('.tl-toggle').focus(); head.click();
    check('collapsing transfers focus out of the hidden list', () => equal(d.activeElement, head));
    const liveStatuses = [...nativeList.children].map(n => n.dataset.status);
    w.rebuildFromMessages([{ role: 'assistant', content: [call('a'), call('b')] }, result('a', true, 'provider cancelled request')]);
    check('history uses same grouped status semantics', () => assert.deepEqual(all('.tl-item').map(n => n.dataset.status), liveStatuses));
    check('history uses same interactive batch summary', () => assert.match(one('.conversation-work-head')?.textContent || '', /工作记录.*2 次工具/));
    w.rebuildFromMessages([{ role: 'assistant', content: [call('a')] }, result('a'), assistant('between'), { role: 'assistant', content: [call('b'), call('c')] }, result('b'), result('c'), result('orphan', true, 'orphan failed')]);
    check('separate assistant and orphan boundaries are retained', () => { equal(all('.tl-group').length, 3); equal(all('.tl-group')[0].querySelectorAll('.tl-item').length, 1); equal(all('.tl-group')[1].querySelectorAll('.tl-item').length, 2); });
    check('orphan toolResult remains visible at its own position', () => { equal(all('.tl-group')[2].querySelector('.tl-item').dataset.id, 'orphan'); assert.match(all('.tl-group')[2].textContent, /orphan failed/); });
    const direct = w.createGroup(); w.ensureThread().append(direct);
    for (const [id, status] of [['cancel', 'cancelled'], ['interruption', 'interrupted']]) { const entry = w.makeEntry({ toolCallId: id, toolName: 'read', args: {} }); entry.status = status; w.addToGroup(direct, w.renderEntry(entry)); }
    direct.querySelector('.ui2-tool-summary')?.click();
    direct.querySelector('.ui2-tool-summary')?.click();
    check('explicit cancelled and interrupted presentation states survive collapse', () => assert.match(direct.querySelector('.ui2-tool-state')?.textContent || '', /已中断 1.*已取消 1/));
    const extra = w.makeEntry({ toolCallId: 'later', toolName: 'read', args: {} });
    w.addToGroup(direct, w.renderEntry(extra));
    check('late tool keeps chosen collapse state and increments real count', () => { equal(direct.querySelector('.ui2-tool-summary').textContent, '工具调用 · 3 次'); equal(direct.querySelector('.tl-list').hidden, true); });
    reset();
    w.onMessageStart({ message: { role: 'assistant' } });
    w.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'checking' } }); await pause();
    const think = one('.think'), thinkingHead = think.querySelector('.think-head'), thinkingBody = think.querySelector('.think-body');
    check('thinking exposes actual streaming state', () => equal(think.dataset.state, 'streaming'));
    check('thinking region has explicit accessible label', () => { equal(thinkingBody.getAttribute('role'), 'region'); equal(thinkingBody.getAttribute('aria-labelledby'), thinkingHead.id); });
    thinkingHead.click();
    w.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'verified' } });
    check('thinking end state comes from actual event', () => equal(think.dataset.state, 'returned'));
    w.onMessageEnd({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'final thinking' }, text('final answer')], usage: { reasoning: 0 } } }); await pause();
    check('final authority reuses expanded thinking node', () => { equal(one('.think'), think); equal(thinkingHead.getAttribute('aria-expanded'), 'true'); equal(thinkingBody.textContent, 'final thinking'); });
    check('final thinking is complete without invented duration/token', () => { equal(think.dataset.state, 'complete'); assert.ok(!/Token|秒|ms/.test(thinkingHead.textContent)); });
    reset(); w.onMessageStart({ message: { role: 'assistant' } }); w.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'still thinking' } });
    w.interruptActive();
    check('interruption updates unfinished thinking state', () => equal(one('.think').dataset.state, 'interrupted'));
    reset(); w.onMessageStart({ message: { role: 'assistant' } });
    w.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'partial thought' } });
    const partialThink = one('.think'); partialThink.querySelector('.think-head').click();
    w.onMessageEnd({ message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'fixture failure' } });
    check('error without final content retains thinking and marks its true state', () => { equal(one('.think'), partialThink); equal(partialThink.dataset.state, 'error'); equal(partialThink.querySelector('.think-body').hidden, false); assert.ok(one('.msg-err')); });
    check('error before the next animation frame preserves pending thinking text', () => equal(partialThink.querySelector('.think-body').textContent, 'partial thought'));
    reset(); w.S.stopOwnedTurn = true;
    w.beginTurn(); w.onMessageStart({ message: { role: 'user', content: [text('stop me')] } });
    w.onMessageStart({ message: { role: 'assistant' } });
    w.onMessageEnd({ message: { role: 'assistant', content: [], stopReason: 'aborted', usage: { input: 0 } } });
    w.onSettled();
    check('owned cancellation remains neutral with real usage', () => { assert.match(one('.msg-note').textContent, /已由用户取消/); equal(one('.msg-err'), null); equal(usageValue(one('.msg.assistant'), 'input'), '0 Token'); });
    reset(); w.S.stopOwnedTurn = false;
    w.rebuildFromMessages([question('cancelled'), { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'provider cancelled' }]);
    check('unowned cancellation with error stays visible as error', () => assert.ok(one('.msg-err')));
    w.rebuildFromMessages([question('safe error'), { role: 'assistant', content: [], stopReason: 'error', errorMessage: '<img src=x onerror="evil()">', usage: { input: 0 } }]);
    check('error message preserves real zero usage and safe text', () => { assert.ok(one('.msg-err')); equal(usageValue(one('.msg.assistant'), 'input'), '0 Token'); equal(one('.msg-err img'), null); });
    w.dropTrailingError();
    check('retry removes error-only shell even with sibling metadata', () => equal(all('.msg.assistant').length, 0));
    const evil = '<img src=x onerror="evil()"><script>evil()</script>';
    w.rebuildFromMessages([question('evil'), assistant(evil, { input: evil }), { role: 'assistant', content: [{ type: 'thinking', thinking: evil }, call('evil-tool', evil), call('safe')] }, result('evil-tool', true, evil)]);
    check('untrusted message/thinking/tool text never becomes active HTML', () => { equal(one('script'), null); equal(one('img[onerror]'), null); equal(one('[onerror]'), null); assert.ok(one('.think-body').textContent.includes('<img')); });
    check('untrusted usage cannot create a usage entry', () => equal(all('.msg.assistant .message-usage').length, 0));
    const copied = [];
    Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async value => copied.push(value) } });
    const userText = '原始 **Markdown**\n<img src=x onerror=alert(1)>';
    w.rebuildFromMessages([{ role: 'user', content: [text(userText)] }]);
    check('history user exposes copy and edit actions', () => {
      equal(all('.msg.user .message-copy').length, 1);
      equal(all('.msg.user .message-edit').length, 1);
    });
    one('.message-copy')?.click(); await pause();
    check('copy uses original message text without rendered labels or markup changes', () => equal(copied[0], userText));
    w.onMessageStart({ message: { role: 'user', content: [text('live user text')] } });
    check('live user and history share the copy action', () => equal(all('.msg.user .message-copy').length, 2));
    all('.message-copy')[1]?.click(); await pause();
    check('live copy belongs to its own message', () => equal(copied[1], 'live user text'));
    w.navigator.clipboard.writeText = async () => { throw Error('denied'); };
    one('.message-copy')?.click(); await pause();
    check('clipboard rejection remains visible and permits retry', () => {
      assert.match(one('.message-actions')?.textContent || '', /复制失败/);
      equal(one('.message-copy')?.disabled, false);
    });
    w.rebuildFromMessages([{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }] }]);
    check('image-only message exposes edit but no empty-text copy action', () => {
      equal(all('.message-copy').length, 0);
      equal(one('.message-actions')?.hidden, false);
      equal(all('.message-actions .message-edit').length, 1);
      equal(all('.message-actions button').length, 1);
    });
    console.log(`UI-2A Classic ${passed}/${passed + failed}; failed=${failed}; skipped=0; DOM/fixture, not layout evidence`);
    return failed ? 1 : 0;
  } finally { reset(); dom.window.close(); }
}

async function electron() {
  const { app, BrowserWindow } = require('electron');
  const { spawn } = require('node:child_process');
  const out = process.env.UI2_CLASSIC_EVIDENCE || path.join(ROOT, 'docs/claude-ui-redesign/ui2a-evidence');
  const world = process.env.UI2A_WORLD;
  const shots = [], facts = [], errors = [];
  let win, harness, passed = 0, exitCode = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, name) => { assert.ok(ok, name); passed++; console.log('PASS ' + name); };
  const read = expression => win.webContents.executeJavaScript(expression);
  const key = async (key, code, windowsVirtualKeyCode) => {
    // Native buttons activate on the real character/default-action sequence.
    // A text-less CDP keyDown alone only exercises JS key listeners.
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, ...(type === 'keyDown' && (key === 'Enter' || key === ' ') ? { text: key === 'Enter' ? '\r' : key, unmodifiedText: key === 'Enter' ? '\r' : key } : {}) });
    await sleep(80);
  };
  app.on('window-all-closed', () => {});
  app.setPath('userData', world);
  const timer = setTimeout(() => { console.error('Electron fixture timeout'); harness?.kill(); app.exit(1); }, 180000);
  try {
    fs.mkdirSync(out, { recursive: true }); await app.whenReady();
    harness = spawn(process.execPath, [path.join(ROOT, 'tests/visual-harness.cjs')], { cwd: world, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('offline harness startup timeout')), 15000);
      harness.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
      harness.once('error', reject); harness.once('exit', code => reject(Error('harness exit ' + code)));
    });
    win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await win.loadURL(origin); win.show(); win.webContents.debugger.attach('1.3');
    const fixture = [
      { role: 'user', content: [text('核实当前结果，保留工具失败和真实消息用量。')] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '模型实际提供的思考文本；这里只使用固定测试数据。' }, text('先检查两项操作。'), call('shot-a'), call('shot-b')], usage: { input: 11, output: 7, reasoning: 2, totalTokens: 18 } },
      result('shot-a'), result('shot-b', true, 'fixture tool failed'),
      assistant('第二条助手消息具有独立用量。', { input: 29, output: 3, reasoning: 0, totalTokens: 32 }),
      assistant('这条消息没有 usage，因此不显示元信息。'),
      assistant('真实零值保留。', { input: 0, output: 0, totalTokens: 0 }),
      { role: 'assistant', content: [call('shot-only')], usage: { input: 55, output: 0 } }, result('shot-only'),
    ];
    for (const theme of ['dark', 'light']) {
      await read(`localStorage.setItem('pi-gui.theme.v1',${JSON.stringify(theme)})`); await win.loadURL(origin);
      for (let i = 0; i < 150; i++) {
        if (await read(`document.querySelector('#connText').textContent==='已连接'&&!!document.querySelector('#stream .msg')`)) break;
        await sleep(40);
      }
      check(await read(`document.querySelector('#connText').textContent==='已连接'&&!!document.querySelector('#stream .msg')`), theme + ' initial RPC fixture history ready');
      await read(`(async()=>{const m=await import('/messages.js');m.rebuildFromMessages(${JSON.stringify(fixture)});return true})()`);
      check(await read(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`), theme + ' actual theme');
      check(await read(`document.querySelectorAll('#stream .message-usage').length===1`), theme + ' one turn usage entry in real renderer');
      check(await read(`(async()=>{const pop=document.querySelector('#messageUsagePopover');document.querySelector('#stream .message-usage')?.click();const ok=!pop.hidden&&!!pop.querySelector('.usage-pop-grid')&&pop.textContent.includes('输入');(await import('/ui/usage-popover.js')).closeUsagePopover();return ok})()`), theme + ' usage popover reads real fields');
      check(await read(`document.querySelector('.ui2-tool-summary').tagName==='BUTTON'`), theme + ' native summary button');
      for (const width of [700, 900, 1200, 1536]) {
        win.setContentSize(width, 900); await sleep(150);
        await read(`document.querySelector('.ui2-tool-summary').focus()`); await key('Enter', 'Enter', 13);
        check(await read(`document.querySelector('.ui2-tool-summary').getAttribute('aria-expanded')==='false'&&document.querySelector('.tl-list').hidden`), theme + '/' + width + ' actual Enter collapses');
        check(await read(`document.querySelector('.ui2-tool-state').textContent.includes('失败 1')&&!document.querySelector('.ui2-tool-state').hidden`), theme + '/' + width + ' collapsed error discoverable');
        let file = `${theme}-${width}-collapsed.png`;
        fs.writeFileSync(path.join(out, file), (await win.webContents.capturePage()).toPNG()); shots.push(file);
        await key('Tab', 'Tab', 9);
        check(await read(`!document.querySelector('.tl-list').contains(document.activeElement)&&document.activeElement!==document.querySelector('.ui2-tool-summary')`), theme + '/' + width + ' Tab skips collapsed list');
        await read(`document.querySelector('.ui2-tool-summary').focus()`);
        await key(' ', 'Space', 32);
        check(await read(`document.querySelector('.ui2-tool-summary').getAttribute('aria-expanded')==='true'&&!document.querySelector('.tl-list').hidden`), theme + '/' + width + ' actual Space expands');
        await key('Tab', 'Tab', 9);
        check(await read(`document.querySelector('.tl-list').contains(document.activeElement)`), theme + '/' + width + ' Tab enters expanded list');
        await read(`document.querySelector('.think-head').focus()`); await key('Enter', 'Enter', 13);
        check(await read(`document.querySelector('.think-head').getAttribute('aria-expanded')==='true'`), theme + '/' + width + ' actual Thinking Enter');
        const f = await read(`({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,dpr:devicePixelRatio,usageButtons:document.querySelectorAll('#stream .message-usage').length,groups:document.querySelectorAll('.tl-group').length})`);
        check(f.width === width && f.scrollWidth <= f.width + 1, theme + '/' + width + ' correct CSS viewport and no page overflow');
        facts.push({ theme, ...f }); file = `${theme}-${width}-expanded.png`;
        fs.writeFileSync(path.join(out, file), (await win.webContents.capturePage()).toPNG()); shots.push(file);
        await key(' ', 'Space', 32); // Restore collapsed Thinking for the next width.
      }
    }
    check(errors.length === 0, 'no renderer errors');
  } catch (error) {
    console.error(error); errors.push(error.message); exitCode = 1;
    if (win && !win.isDestroyed()) console.error('Fixture focus state', await read(`({focused:document.hasFocus(),active:document.activeElement?.className,summary:document.querySelector('.ui2-tool-summary')?.getAttribute('aria-expanded'),hidden:document.querySelector('.tl-list')?.hidden,groups:document.querySelectorAll('.tl-group').length})`).catch(() => null));
  }
  finally {
    clearTimeout(timer);
    fs.writeFileSync(path.join(out, 'electron-results.json'), JSON.stringify({ passed, failed: exitCode ? 1 : 0, errors, screenshots: shots, facts, electron: process.versions.electron, note: 'UI-1 CSS only; Agent C shared styles and final integration visual acceptance pending; offline fixture, no model', exitCode }, null, 2));
    console.log(`UI-2A Electron ${passed}/${passed + (exitCode ? 1 : 0)}; failed=${exitCode ? 1 : 0}; screenshots=${shots.length}`);
    win?.destroy(); harness?.kill(); await sleep(150); app.exit(exitCode);
  }
}

if (process.argv.includes('--electron')) {
  if (process.versions.electron) electron().catch(error => { console.error(error); require('electron').app.exit(1); });
  else {
    const { spawn } = require('node:child_process'), os = require('node:os');
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-ui2a-'));
    const env = { ...process.env, UI2A_WORLD: world }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, '--electron', '--no-sandbox', '--in-process-gpu'], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', error => { console.error(error); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; fs.rm(world, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }, () => {}); });
  }
} else unit().then(code => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 1; });
