/* Local Chromium proof of both live surfaces using the existing offline fixture server. */
'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const out = path.resolve(process.env.P5B_SCREENSHOTS || '.shots/session-ux-p5b');
const chromePath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(file => fs.existsSync(file));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(get, name) {
  for (let n = 0; n < 100; n++) {
    const result = await Promise.resolve().then(get).catch(() => null);
    if (result) return result;
    await wait(100);
  }
  throw Error(name);
}

async function seedSurface(mode) {
  const modules = await Promise.all([
    import('/state.js'), import('/messages.js'), import('/tools.js'), import('/execution-timeline-state.js'),
    import('/classic-execution-view.js'), import('/runtime-state.js'), import('/runtime-conversation.js'),
    import('/ui/workspace-surface.js'),
  ]);
  const [{ S }, M, T, state, classic, runtime, rtc, surface] = modules;
  const owner = { backendInstance: 'fixture', projectId: 'fixture', repoId: 'repo', workspaceId: 'workspace',
    workspaceEpoch: '1', runtimeId: 'fixture-runtime', runtimeGeneration: '1', sessionId: 'fixture-session',
    conversationId: 'fixture-p5b' };
  const execution = { startSequence: 0, branchEpoch: 0, observedAt: Date.now() - 25000 };
  const start = Date.now() - 25000;
  let seq = 0;
  if (mode === 'classic') {
    M.clearThread();
    M.ensureThread();
  } else {
    surface.showRuntimeConversation();
    const host = document.querySelector('#runtimeView');
    host.replaceChildren();
    const view = rtc.createRuntimeConversation({ host });
    runtime.seedRuntimeSnapshot({ backendInstance: owner.backendInstance, items: [{
      conversationId: owner.conversationId, owner, execution,
      workspace: { branch: 'p5b-fixture', projectId: owner.projectId, workspaceId: owner.workspaceId, workspaceEpoch: owner.workspaceEpoch },
      title: '代码审查演示', lifecycle: 'ready', activity: 'running',
    }] });
    view.show(owner.conversationId);
  }
  function emit(type, data = {}) {
    const event = { type, ...data };
    const observedAt = start + (++seq * 400);
    if (mode === 'runtime') {
      runtime.observeRuntimeFrame({ type: 'runtime_event', owner, eventSequence: seq, event,
        execution: { ...execution, observedAt } });
      return;
    }
    Object.assign(event, { _seq: seq, legacyOwner: owner,
      executionClassic: { sessionId: owner.sessionId, branchEpoch: 0, observedAt } });
    state.observeClassicExecution(event);
    classic.scheduleClassicExecutionView(event);
    if (type === 'agent_start') { M.beginTurn(); M.setStreaming(true); }
    if (type === 'agent_settled') M.onSettled();
    if (type === 'message_start') M.onMessageStart(event);
    if (type === 'message_end') M.onMessageEnd(event);
    if (type === 'tool_execution_start') T.onToolStart(event);
    if (type === 'tool_execution_end') T.onToolEnd(event);
  }
  const text = text => ({ type: 'text', text });
  const message = (role, content, stopReason) => {
    const message = { role, content, stopReason,
      ...(role === 'assistant' && { model: 'fixture-model', provider: 'fixture', usage: { input: 48, output: 12, reasoning: 0, totalTokens: 60 } }),
    };
    emit('message_start', { message });
    emit('message_end', { message });
  };
  const lines = [
    '请检查会话面板的执行顺序，并验证读取、搜索、修改三类工具的结果能按开始顺序查看。',
    '先核对范围，再阅读布局和已保留的测试夹具。并行检查记录与会话归属。',
    '失败的搜索需要可回查，输出只显示已取得的数据。',
    '保留原来的 Markdown 最终回答和折叠后的用量明细。',
    '多模型执行时，逐个响应保存模型和原始计数。',
    '验证窄屏、浅色和键盘；用户回到历史时恢复阅读位置。',
    '最后核对处理时间、运行状态和文件变更行数。',
    '[验收记录](#fixture-verification)',
  ];
  emit('execution_submission', { id: 'fixture-prompt', command: 'prompt' });
  emit('agent_start');
  message('user', [text(lines.join('\n\n'))]);

  const plan = { tool: 'gui_plan', version: 1, turnId: 'fixture-plan', revision: 1,
    tasks: [{ id: 'read', title: '核对事件和现有渲染', status: 'completed' },
      { id: 'fixtures', title: '检查会话夹具', status: 'in_progress' },
      { id: 'regression', title: '定向回归', status: 'pending' }] };
  const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
  message('assistant', [call('plan', 'gui_plan', plan)], 'toolUse');
  emit('tool_execution_start', { toolCallId: 'plan', toolName: 'gui_plan',
    ...(mode === 'classic' ? { args: plan } : { plan }) });
  emit('tool_execution_end', { toolCallId: 'plan',
    ...(mode === 'classic' ? { result: { details: plan } } : { plan }) });
  const tools = [
    { id: 'read', name: 'read', args: { path: 'state.js', offset: 31, limit: 42 },
      facts: { kind: 'read', title: '读取 state.js', fileName: 'state.js', requestedRange: { start: 31, end: 72 } } },
    { id: 'edit', name: 'edit', args: { path: 'contract.js', oldText: 'state', newText: 'currentState' },
      facts: { kind: 'edit', title: '修改 contract.js', fileName: 'contract.js', diffStat: { added: 6, removed: 3 } } },
    { id: 'grep', name: 'grep', args: { pattern: 'runtimeScope' },
      facts: { kind: 'search', title: '搜索 runtimeScope', query: 'runtimeScope' } },
  ];
  message('assistant', [text('先并行读取和核对调用边界。'), { type: 'thinking', thinking: '已公开的思考文本。' },
    ...tools.map(tool => call(tool.id, tool.name, tool.args))], 'toolUse');
  for (const tool of tools) emit('tool_execution_start', {
    toolCallId: tool.id, toolName: tool.name, activity: tool.facts, ...(mode === 'classic' && { args: tool.args }),
  });
  emit('tool_execution_end', { toolCallId: 'grep', isError: true, durationMs: 840,
    ...(mode === 'classic' && { result: { content: [text('搜索失败：路径超出夹具目录。')] } }) });
  emit('tool_execution_end', { toolCallId: 'edit', durationMs: 1250, activity: tools[1].facts,
    ...(mode === 'classic' && { result: { content: [text('更新了 contract.js')] } }) });
  globalThis.finishP5b = () => {
    emit('tool_execution_end', { toolCallId: 'read', durationMs: 2220, activity: tools[0].facts,
      ...(mode === 'classic' && { result: { content: [text('const state = readState();\nreturn state.owner;')] } }) });
    message('assistant', [text('已核对 **事件顺序**。搜索失败已保留，文件修改可以逐条回查。')], 'stop');
    emit('agent_settled', { aborted: false });
    if (mode === 'runtime') {
      const item = runtime.runtimeStore.get(owner.conversationId).item;
      runtime.observeRuntimeFrame({ type: 'runtime_state', owner, item: { ...item, activity: 'idle' } });
    }
  };
}

function measure(root, scroller) {
  const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  function rgba(color) {
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = color;
    pixel.fillRect(0, 0, 1, 1);
    return [...pixel.getImageData(0, 0, 1, 1).data].map(value => value / 255);
  }
  function luminance(rgb) {
    const channels = rgb.slice(0, 3)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  function blend(color, bg) {
    return bg.map((under, index) => color[index] * color[3] + under * (1 - color[3]));
  }
  function background(node) {
    const layers = [];
    for (let parent = node; parent; parent = parent.parentElement) {
      const color = rgba(getComputedStyle(parent).backgroundColor);
      if (color[3]) layers.unshift(color);
      if (color[3] === 1) break;
    }
    return layers.reduce((under, layer) => blend(layer, under), [1, 1, 1]);
  }
  function ratio(color, bg) {
    const a = luminance(blend(rgba(color), bg)), b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  const group = root.querySelector('.execution-activity-group > button');
  const text = [...root.querySelectorAll('.execution-head-title, .execution-activity-status')]
    .filter(node => node.getBoundingClientRect().height > 0)
    .map(node => ratio(getComputedStyle(node).color, background(node)));
  return {
    overflow: Math.max(root.scrollWidth - root.clientWidth, scroller.scrollWidth - scroller.clientWidth),
    rows: [...root.querySelectorAll('.execution-activity-item > button')].map(row => row.getBoundingClientRect().height),
    taskExpandable: !root.querySelector('.execution-task-more').hidden,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    textContrast: Math.min(...text),
    focusContrast: ratio(getComputedStyle(group).outlineColor, background(group)),
  };
}

async function main() {
  assert.ok(chromePath, 'set CHROME_PATH to a locally installed Chromium');
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p5b-chrome-'));
  const harness = spawn(process.execPath, [path.join(__dirname, 'visual-harness.cjs')], {
    env: { ...process.env, HARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  });
  let url, chrome, ws;
  harness.stdout.on('data', chunk => { url ||= String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]; });
  const results = [];
  try {
    await until(() => url, 'offline fixture did not start');
    chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-background-networking',
      '--disable-component-update', '--disable-default-apps', '--no-first-run', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore', windowsHide: true });
    const target = await until(async () => {
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
      const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      return pages.find(page => page.type === 'page')?.webSocketDebuggerUrl;
    }, 'Chromium DevTools did not start');
    ws = new WebSocket(target);
    await once(ws, 'open');
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      callback(message);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      pending.set(++id, message => message.error ? reject(Error(message.error.message)) : resolve(message.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    };
    const shot = async name => {
      const image = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
    };
    const key = async (name, code, number) => {
      const fields = { key: name, code, windowsVirtualKeyCode: number, nativeVirtualKeyCode: number };
      const text = name === 'Enter' ? '\r' : name === ' ' ? ' ' : '';
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...fields, text, unmodifiedText: text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
      await wait(80);
    };
    await send('Page.enable');
    await send('Page.navigate', { url });
    await until(() => evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#stream .thread'))"), 'application did not boot');
    await wait(500);
    for (const mode of ['classic', 'runtime']) {
      const selector = mode === 'classic' ? '#stream' : '#runtimeView .rtc-output';
      const view = selector + ' .execution-turn';
      const select = 'document.querySelector(' + JSON.stringify(view) + ')';
      const scroll = 'document.querySelector(' + JSON.stringify(selector) + ')';
      await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 820, deviceScaleFactor: 1, mobile: false });
      await evaluate('(' + seedSurface.toString() + ')(' + JSON.stringify(mode) + ')');
      await until(() => evaluate('Boolean(' + select + '?.querySelector(".execution-activity-group:not([hidden])"))'), mode + ' Timeline missing');
      const preview = select + '.querySelector(".execution-task-more")';
      const link = select + '.querySelector("[data-execution-part=input] a[href=\\"#fixture-verification\\"]")';
      await until(() => evaluate('!' + preview + '.hidden'), mode + ' task preview missing');
      assert.equal(await evaluate(link + '?.hasAttribute("inert")'), true, mode + ' clipped link approachable');
      await evaluate(preview + '.focus()');
      await key(' ', 'Space', 32);
      assert.equal(await evaluate(preview + '.getAttribute("aria-expanded")'), 'true');
      assert.equal(await evaluate(link + '.hasAttribute("inert")'), false);
      await key(' ', 'Space', 32);
      assert.equal(await evaluate(preview + '.getAttribute("aria-expanded")'), 'false');
      await evaluate(select + '.querySelector(".execution-activity-group > button").focus()');
      await key('Enter', 'Enter', 13);
      const keyboard = await evaluate('(() => { const b = ' + select + '.querySelector(".execution-activity-group > button");'
        + 'return { open: b.getAttribute("aria-expanded"), focused: b === document.activeElement, outline: getComputedStyle(b).outlineStyle }; })()');
      assert.deepEqual([keyboard.open, keyboard.focused], ['true', true]);
      assert.notEqual(keyboard.outline, 'none');
      for (const [theme, width, height, scale] of [['dark', 1320, 820, 1], ['light', 1320, 820, 1],
        ['dark', 700, 600, 1], ['light', 700, 600, 1.25]]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: scale > 1 ? 'reduce' : 'no-preference' }] });
        await evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme)
          + '; document.documentElement.style.setProperty("--font-scale", ' + scale + '); ' + scroll + '.scrollTop = 0');
        await wait(180);
        const metric = await evaluate('(' + measure.toString() + ')(' + select + ', ' + scroll + ')');
        assert.ok(metric.overflow <= 1, JSON.stringify(metric));
        assert.equal(metric.rows.length, 3);
        assert.ok(metric.rows.every(height => height >= 24 && height < 51), JSON.stringify(metric));
        assert.ok(metric.textContrast >= 4.5 && metric.focusContrast >= 3, JSON.stringify(metric));
        assert.equal(metric.taskExpandable, true);
        if (scale > 1) assert.equal(metric.reducedMotion, true);
        const name = [mode, theme, width].join('-');
        results.push({ name, scale, ...metric, keyboard });
        if (width < 800) await evaluate(select + '.querySelector(".execution-activity-group").scrollIntoView({ block: "center", behavior: "instant" })');
        await shot(name);
      }
      await send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 820, deviceScaleFactor: 1, mobile: false });
      await evaluate('document.documentElement.style.setProperty("--font-scale", 1)');
      await evaluate(select + '.querySelector(".execution-activity-item > button").click(); finishP5b()');
      await until(() => evaluate('Boolean(' + select + '?.querySelector("[data-execution-part=answer] strong"))'), mode + ' final answer missing');
      const detail = await evaluate(select + '.querySelector(".execution-activity-item").textContent');
      assert.match(detail, mode === 'classic' ? /const state = readState/ : /当前视图无权读取详情/);
      await evaluate(scroll + '.scrollTop = ' + scroll + '.scrollHeight');
      await shot(mode + '-detail-and-answer');
    }
    fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(results, null, 2) + '\n');
    console.log('P5-B Chromium: ' + results.length + ' layouts verified; ' + out);
  } finally {
    ws?.close();
    chrome?.kill();
    harness.kill();
    await wait(250);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
