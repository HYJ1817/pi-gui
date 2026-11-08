/* 四点折叠执行指示：结构、CSS 时间轴、聊天流/并行会话两处接入与状态绑定。
 *
 * jsdom 不做布局，也不运行动画，所以这里能做两类事：
 *   1. 对 CSS 源做契约断言（1.25s、四组独立 keyframes、只改 transform、
 *      固定尺寸、reduced-motion、深浅色）；
 *   2. 对真实模块（messages.js / runtime-conversation.js）跑 DOM 断言，
 *      确认动画出现在正确位置、且只随当前会话自己的状态显隐。
 * 像素级还原另由真实浏览器截图核对，不在这个套件里假装能测。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const css = fs.readFileSync(path.join(PUB, 'thinking-dots.css'), 'utf8');

function keyframeBlock(name) {
  const start = css.indexOf('@keyframes ' + name);
  assert.ok(start >= 0, '缺少 @keyframes ' + name);
  const open = css.indexOf('{', start);
  let depth = 0, end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}') { depth--; if (depth === 0) break; }
  }
  return css.slice(open, end + 1);
}

(async () => {
  let checks = 0;
  const ok = (label, value, detail = '') => {
    assert.ok(value, label + (detail ? ': ' + detail : ''));
    checks++;
    console.log('  ok  ' + label);
  };

  /* ---------- 1. CSS 契约：录屏测量出的时间轴 ---------- */
  console.log('thinking-dots CSS');
  ok('循环 1.25s、无限、线性（缓动由采样点表达）',
    /animation-duration:\s*1\.25s/.test(css) && /animation-iteration-count:\s*infinite/.test(css) && /animation-timing-function:\s*linear/.test(css));
  const names = ['thinking-dots-a', 'thinking-dots-b', 'thinking-dots-c', 'thinking-dots-d'];
  for (const [i, name] of names.entries()) {
    ok(`第 ${i + 1} 个点使用独立时间线 ${name}`,
      new RegExp(`nth-child\\(${i + 1}\\)\\s*\\{[^}]*animation-name:\\s*${name}`).test(css));
    const block = keyframeBlock(name);
    ok(`${name} 有显式 0% / 100%（缺一端会被插值回基础位置）`, /(^|[{\s])0%/.test(block) && /100%/.test(block));
    const decls = block.match(/[\d.]+%(?:\s*,\s*[\d.]+%)*\s*\{[^}]*\}/g) || [];
    ok(`${name} 只改 transform（不触发回流、不缩放）`,
      decls.length >= 7 && decls.every(d => /transform:/.test(d) && !/\b(width|height|opacity|left|top|margin|padding)\s*:/.test(d) && !/\bscale\(/.test(d)));
  }
  ok('容器固定尺寸（step + dot），不随动画变化',
    /width:\s*calc\(var\(--td-step\)\s*\+\s*var\(--td-dot\)\)/.test(css)
    && /height:\s*calc\(var\(--td-step\)\s*\+\s*var\(--td-dot\)\)/.test(css));
  ok('深色用 Claude 珊瑚色，浅色主题压深一档',
    /--td-color:\s*#d97757/.test(css) && /:root\[data-theme="light"\]\s+\.thinking-dots\s*\{[^}]*--td-color:\s*#c15f3c/.test(css));
  ok('prefers-reduced-motion 下停在静态方阵',
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.thinking-dots\s*>\s*span\s*\{\s*animation:\s*none\s*!important/.test(css));
  ok('工具执行时只收文案、保留动画',
    /\.working\.is-tool-active\s+\.working-label\s*\{\s*display:\s*none/.test(css));
  ok('点组在并行会话状态行内垂直对齐',
    /\.rtc-head\s*>\s*\.rtc-state\s+\.thinking-dots\s*\{[^}]*margin-right:\s*7px/.test(css));

  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  ok('index.html 在 styles.css 之后加载组件样式',
    html.indexOf('href="/thinking-dots.css"') > html.indexOf('href="/styles.css"'));

  /* ---------- 2. 组件结构 ---------- */
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  global.window = w; global.document = d; global.localStorage = w.localStorage;
  global.HTMLElement = w.HTMLElement; global.Event = w.Event;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const fetchStub = async (url, opts = {}) => ({ status: 200, json: async () => {
    const u = String(url);
    if (!opts.body) return u.includes('conversationId=')
      ? { ok: true, sessionId: 's-D', messages: [{ role: 'user', text: '历史问题' }, { role: 'assistant', text: '历史回答' }], truncated: false }
      : { ok: true, backendInstance: 'backend', items: [] };
    return { ok: true };
  } });
  w.fetch = fetchStub;
  global.fetch = fetchStub;

  console.log('thinking-dots 结构与聊天流接入');
  const { thinkingDots, THINKING_DOT_COUNT } = await import(pathToFileURL(path.join(PUB, 'thinking-dots.js')).href);
  const dots = thinkingDots();
  ok('四个点、纯装饰、无文本', THINKING_DOT_COUNT === 4 && dots.classList.contains('thinking-dots')
    && dots.getAttribute('aria-hidden') === 'true' && dots.children.length === 4 && dots.textContent === '');
  ok('可附加调用方类名', thinkingDots('extra').classList.contains('thinking-dots') && thinkingDots('extra').classList.contains('extra'));

  const M = await import(pathToFileURL(path.join(PUB, 'messages.js')).href);
  const row = () => d.querySelector('#stream .working');
  M.showWorking();
  const workRow = row();
  ok('聊天流出现 working 行', Boolean(workRow));
  ok('working 行内是四点组件 + 文案', workRow.querySelectorAll('.thinking-dots > span').length === 4
    && workRow.querySelector('.working-label')?.textContent === 'Pi 正在处理…');
  ok('默认不隐藏、不带工具态', workRow.hidden === false && !workRow.classList.contains('is-tool-active'));

  const TM = await import(pathToFileURL(path.join(PUB, 'tool-model.js')).href);
  TM.registerEntry({ id: 'fixture-running', status: 'running' });
  M.syncToolWorking();
  ok('工具运行中：动画保留（未 hidden），只加 is-tool-active', workRow.hidden === false && workRow.classList.contains('is-tool-active'));
  TM.clearLiveEntries();
  M.syncToolWorking();
  ok('工具结束：去掉 is-tool-active，文案回来', !workRow.classList.contains('is-tool-active'));

  M.setStreaming(false);
  ok('setStreaming(false) 收起指示器', row() === null);
  M.setStreaming(true);
  ok('setStreaming(true) 重新出现指示器', row() !== null && row().querySelectorAll('.thinking-dots > span').length === 4);
  M.interruptActive();
  ok('interruptActive（取消/中断）收起指示器', row() === null);
  M.hideWorking();

  /* ---------- 3. 并行会话：状态行按各自 activity 显隐 ---------- */
  console.log('并行会话状态行');
  const { runtimeStore, seedRuntimeSnapshot, observeRuntimeFrame } = await import(pathToFileURL(path.join(PUB, 'runtime-state.js')).href);
  const { createRuntimeConversation } = await import(pathToFileURL(path.join(PUB, 'runtime-conversation.js')).href);
  const owner = id => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id,
    workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: 'one', sessionId: 's-' + id });
  const item = (id, over = {}) => ({ conversationId: id, createdAt: '2026-01-01T00:00:00.000Z',
    workspace: { branch: 'branch-' + id, projectId: 'project' }, owner: owner(id), lifecycle: 'ready',
    activity: 'idle', attention: false, error: null, stop: null, revision: 1, ...over });
  runtimeStore.seed({ backendInstance: 'backend', items: [
    item('A', { activity: 'running' }),
    item('B', { activity: 'idle' }),
    item('C', { lifecycle: 'error', activity: 'idle', error: 'spawn_failed' }),
    item('D', { owner: null, lifecycle: 'dormant', activity: 'idle' }),
    item('F', { activity: 'running' }),
  ] });
  const host = d.createElement('div'); host.id = 'dots-runtime-host'; d.body.appendChild(host);
  const view = createRuntimeConversation({ host });
  const stateLine = () => host.querySelector('.rtc-state');
  const stateDots = () => stateLine().querySelector('.thinking-dots');
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const show = id => view.show(id);

  show('A');
  ok('运行中显示动画，状态文案不变', stateDots().hidden === false && stateLine().textContent === '就绪 · 运行中');
  observeRuntimeFrame({ type: 'runtime_event', owner: owner('A'), eventSequence: 1,
    event: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read' } });
  ok('工具调用期间动画保持', stateDots().hidden === false && host.querySelectorAll('.ui2-runtime-tool').length === 1);

  show('F');
  observeRuntimeFrame({ type: 'runtime_event', owner: owner('F'), eventSequence: 1,
    event: { type: 'extension_ui_request', id: 'ap1', method: 'confirm', title: '继续？' } });
  ok('待审批时停下（Agent 在等人，不在执行）', stateDots().hidden === true);

  show('B');
  ok('切到空闲会话：隐藏动画，文案是 B 自己的', stateDots().hidden === true && stateLine().textContent === '就绪 · 空闲');
  show('A');
  ok('切回运行中的 A：动画恢复，A 的状态未被 B 覆盖', stateDots().hidden === false && stateLine().textContent === '就绪 · 运行中');
  show('C');
  ok('报错会话不显示动画', stateDots().hidden === true && stateLine().textContent.includes('运行异常'));
  show('D');
  await tick();
  ok('已关闭会话不显示动画', stateDots().hidden === true && stateLine().textContent.includes('已关闭'));
  const historyBtn = [...host.querySelectorAll('button')].find(b => b.textContent === '打开历史');
  ok('dormant 会话提供打开历史入口', Boolean(historyBtn));
  historyBtn.click();
  await tick();
  ok('历史视图不显示执行动画', stateDots().hidden === true && stateLine().textContent.includes('未被启动'));

  show('A');
  const completed = JSON.parse(JSON.stringify(runtimeStore.get('A').item));
  completed.activity = 'idle'; completed.revision = 2;
  seedRuntimeSnapshot({ backendInstance: 'backend', items: [completed] });
  ok('会话完成（running -> idle）：动画停下', stateDots().hidden === true && stateLine().textContent === '就绪 · 空闲');
  ok('状态行里的点组是稳定子节点（流式重画不会重建动画）', stateLine().querySelector('.thinking-dots') === stateDots());

  console.log(`Thinking dots: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exit(1); });
