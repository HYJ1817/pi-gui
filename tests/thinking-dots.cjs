/* 四点折叠 / 三点轨道执行指示：结构、CSS 时间轴、相位切换与两处接入。
 *
 * jsdom 不做布局，也不运行动画，所以这里做三类事：
 *   1. 对 CSS 源做契约断言（方阵 1.25s、三点 2s、过渡 0.75s、独立 keyframes、
 *      过渡两端与相位 0% 对齐、固定尺寸、reduced-motion、深浅色）；
 *   2. 对相位控制器做单元断言（等循环边界、过渡结束落相位、边界前取消）；
 *   3. 对真实模块（messages.js / runtime-conversation.js）跑 DOM 断言，
 *      确认形态按自己的节奏自动交替、工具起停不覆盖它，切换会话不串相位。
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

/* 取某个百分比停靠点后面的声明块（一个选择器可能写多个百分比）。 */
function declAt(block, pct) {
  const re = /([\d.]+%(?:\s*,\s*[\d.]+%)*)\s*\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(block))) {
    const stops = match[1].split(',').map(s => parseFloat(s));
    if (stops.includes(pct)) return match[2].replace(/\s+/g, ' ').trim();
  }
  return '';
}
/* 端点对齐只比位移：方阵 keyframes 不写 scale（默认 1），过渡会显式写
 * scale(1)，两者在画面上等价，不该因为字符串不同就判失败。 */
function transformOf(decl) {
  const match = decl.match(/transform:\s*([^;]+)/);
  return match ? match[1].replace(/\s*scale\([^)]*\)/g, '').replace(/\s+/g, ' ').trim() : '';
}

(async () => {
  let checks = 0;
  const ok = (label, value, detail = '') => {
    assert.ok(value, label + (detail ? ': ' + detail : ''));
    checks++;
    console.log('  ok  ' + label);
  };

  /* ---------- 1. CSS 契约：录屏测量出的两条时间轴 + 过渡 ---------- */
  console.log('thinking-dots CSS');
  ok('方阵 1.25s、三点 2s、过渡 0.75s，均线性',
    /animation-duration:\s*1\.25s/.test(css)
    && /\[data-phase="triangle"\]\s*>\s*span\s*\{[^}]*animation-duration:\s*2s/.test(css)
    && /\[data-transition\]\s*>\s*span\s*\{[^}]*animation-duration:\s*0\.75s[^}]*animation-iteration-count:\s*1[^}]*animation-fill-mode:\s*both/.test(css)
    && /animation-timing-function:\s*linear/.test(css));

  const squareNames = ['thinking-dots-a', 'thinking-dots-b', 'thinking-dots-c', 'thinking-dots-d'];
  for (const [i, name] of squareNames.entries()) {
    ok(`方阵第 ${i + 1} 个点使用独立时间线 ${name}`,
      new RegExp(`nth-child\\(${i + 1}\\)\\s*\\{[^}]*animation-name:\\s*${name}`).test(css));
    const block = keyframeBlock(name);
    ok(`${name} 有显式 0% / 100%（缺一端会被插值回基础位置）`, /(^|[{\s])0%/.test(block) && /100%/.test(block));
    const decls = block.match(/[\d.]+%(?:\s*,\s*[\d.]+%)*\s*\{[^}]*\}/g) || [];
    ok(`${name} 只改 transform（不触发回流、不缩放）`,
      decls.length >= 7 && decls.every(d => /transform:/.test(d) && !/\b(width|height|opacity|left|top|margin|padding)\s*:/.test(d) && !/\bscale\(/.test(d)));
  }

  const triNames = ['thinking-dots-tri-1', 'thinking-dots-tri-2', 'thinking-dots-tri-3', 'thinking-dots-tri-4'];
  for (const [i, name] of triNames.entries()) {
    ok(`三点第 ${i + 1} 个点使用独立时间线 ${name}`,
      new RegExp(`\\[data-phase="triangle"\\]\\s*>\\s*span:nth-child\\(${i + 1}\\)\\s*\\{[^}]*animation-name:\\s*${name}`).test(css));
  }
  for (let i = 1; i <= 3; i++) {
    const block = keyframeBlock(`thinking-dots-tri-${i}`);
    const decls = block.match(/[\d.]+%(?:\s*,\s*[\d.]+%)*\s*\{[^}]*\}/g) || [];
    ok(`三点时间线 ${i} 的 0% 与 100% 完全一致（循环无缝）`,
      declAt(block, 0) === declAt(block, 100) && declAt(block, 0) !== '');
    ok(`三点时间线 ${i} 有 13 个采样点，只用 transform / opacity`,
      decls.length === 13 && decls.every(d => /transform:/.test(d) && /opacity:/.test(d)
        && !/\b(width|height|left|top|margin|padding)\s*:/.test(d)));
  }
  const tri4 = keyframeBlock('thinking-dots-tri-4');
  ok('三点相位里第四点停在中心且完全透明',
    /translate\(calc\(var\(--td-step\) \* -0\.5\), calc\(var\(--td-step\) \* -0\.5\)\)/.test(tri4) && /opacity:\s*0;/.test(tri4));
  ok('静态兜底同样隐藏第四点',
    /\[data-phase="triangle"\]\s*>\s*span:nth-child\(4\)\s*\{\s*opacity:\s*0/.test(css));

  for (let i = 1; i <= 4; i++) {
    const tri = keyframeBlock(`thinking-dots-tri-${i}`);
    const square = keyframeBlock(squareNames[i - 1]);
    const toSquare = keyframeBlock(`thinking-dots-to-square-${i}`);
    const toTriangle = keyframeBlock(`thinking-dots-to-triangle-${i}`);
    ok(`过渡 ${i}：三点 -> 方阵，两端都接在相位的 0% 上`,
      transformOf(declAt(toSquare, 0)) === transformOf(declAt(tri, 0))
      && transformOf(declAt(toSquare, 100)) === transformOf(declAt(square, 0)));
    ok(`过渡 ${i}：方阵 -> 三点，两端都接在相位的 0% 上`,
      transformOf(declAt(toTriangle, 0)) === transformOf(declAt(square, 0))
      && transformOf(declAt(toTriangle, 100)) === transformOf(declAt(tri, 0)));
  }
  const morph = keyframeBlock('thinking-dots-to-square-1');
  ok('过渡按「收拢 - 停顿 - 绽开」三段采样',
    (morph.match(/[\d.]+%/g) || []).length === 7 && /55%/.test(morph) && /68%/.test(morph));
  ok('过渡规则写在相位规则之后（同特异性时后者生效）',
    css.indexOf('.thinking-dots[data-transition]') > css.indexOf('.thinking-dots[data-phase="triangle"]'));
  ok('关键帧百分比没有 %% 或缺失 % 的畸形写法',
    !/%%/.test(css) && !/^\s*[\d.]+\s*\{/m.test(css));

  ok('容器固定尺寸（step + dot），不随动画变化',
    /width:\s*calc\(var\(--td-step\)\s*\+\s*var\(--td-dot\)\)/.test(css)
    && /height:\s*calc\(var\(--td-step\)\s*\+\s*var\(--td-dot\)\)/.test(css));
  ok('深色用 Claude 珊瑚色，浅色主题压深一档',
    /--td-color:\s*#d97757/.test(css) && /:root\[data-theme="light"\]\s+\.thinking-dots\s*\{[^}]*--td-color:\s*#c15f3c/.test(css));
  ok('prefers-reduced-motion 下不播放动画（按当前形态静态显示）',
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.thinking-dots\s*>\s*span\s*\{\s*animation:\s*none\s*!important/.test(css));
  ok('工具执行时只收文案、保留动画',
    /\.working\.is-tool-active\s+\.working-label\s*\{\s*display:\s*none/.test(css));
  ok('点组在并行会话状态行内垂直对齐',
    /\.rtc-head\s*>\s*\.rtc-state\s+\.thinking-dots\s*\{[^}]*margin-right:\s*7px/.test(css));

  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  ok('index.html 在 styles.css 之后加载组件样式',
    html.indexOf('href="/thinking-dots.css"') > html.indexOf('href="/styles.css"'));

  /* ---------- 2. 组件结构与相位控制器 ---------- */
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

  console.log('thinking-dots 结构、相位控制器与聊天流接入');
  const { thinkingDots, THINKING_DOT_COUNT, setThinkingDotsPhase, startThinkingDotsCycle, stopThinkingDotsCycle } =
    await import(pathToFileURL(path.join(PUB, 'thinking-dots.js')).href);
  const dots = thinkingDots();
  ok('四个点、纯装饰、无文本', THINKING_DOT_COUNT === 4 && dots.classList.contains('thinking-dots')
    && dots.getAttribute('aria-hidden') === 'true' && dots.children.length === 4 && dots.textContent === '');
  ok('默认方阵，可按当前状态指定出生形态',
    dots.dataset.phase === 'square' && thinkingDots('', 'triangle').dataset.phase === 'triangle');
  ok('可附加调用方类名', thinkingDots('extra').classList.contains('thinking-dots') && thinkingDots('extra').classList.contains('extra'));

  /* jsdom 没有 Web Animations：没有动画可等，必须直接落相位。 */
  const plain = thinkingDots();
  d.body.appendChild(plain);
  setThinkingDotsPhase(plain, 'triangle');
  ok('没有可等动画时直接落相位（jsdom / reduced-motion / 隐藏节点）',
    plain.dataset.phase === 'triangle' && !plain.dataset.transition);

  /* 有动画时：等 animationiteration -> 过渡 -> animationend 落相位。 */
  const phaseNode = thinkingDots();
  d.body.appendChild(phaseNode);
  const firstDot = phaseNode.firstElementChild;
  Object.defineProperty(firstDot, 'getAnimations', { configurable: true, value: () => [{}] });
  const fire = type => firstDot.dispatchEvent(new w.Event(type));
  setThinkingDotsPhase(phaseNode, 'triangle');
  ok('有动画时先等循环边界，不硬切', phaseNode.dataset.phase === 'square' && !phaseNode.dataset.transition);
  fire('animationiteration');
  ok('边界到时进入 to-triangle 过渡', phaseNode.dataset.phase === 'triangle' && phaseNode.dataset.transition === 'to-triangle');
  fire('animationend');
  ok('过渡结束落回无限动画，过渡标记移除', phaseNode.dataset.phase === 'triangle' && !phaseNode.dataset.transition);

  setThinkingDotsPhase(phaseNode, 'square');
  setThinkingDotsPhase(phaseNode, 'triangle');
  fire('animationiteration');
  ok('边界前状态变回去：这次切换作废，不闪', phaseNode.dataset.phase === 'triangle' && !phaseNode.dataset.transition);

  setThinkingDotsPhase(phaseNode, 'square');
  fire('animationiteration');
  ok('反向过渡从方阵 0% 起步', phaseNode.dataset.phase === 'square' && phaseNode.dataset.transition === 'to-square');
  setThinkingDotsPhase(phaseNode, 'triangle');
  fire('animationend');
  ok('过渡中状态反转：从当前姿态直接往回走，不等整圈',
    phaseNode.dataset.phase === 'triangle' && phaseNode.dataset.transition === 'to-triangle');
  fire('animationend');
  ok('第二次过渡结束', phaseNode.dataset.phase === 'triangle' && !phaseNode.dataset.transition);

  setThinkingDotsPhase(phaseNode, 'square', { immediate: true });
  ok('immediate 跳过等待（切换会话/刚显示时用）', phaseNode.dataset.phase === 'square' && !phaseNode.dataset.transition);

  /* jsdom 不会自己跑 CSS 动画，但计时器会跑；用很短的注入节奏验证自动交替。
   * 三个形态 100ms 一段，检查点留足 40ms 余量。 */
  console.log('thinking-dots 自动交替');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const cycleNode = thinkingDots('', 'square');
  d.body.appendChild(cycleNode);
  const shortCycle = [
    { phase: 'triangle', hold: 100 },
    { phase: 'square', hold: 100 },
    { phase: 'triangle', hold: 100 },
  ];
  startThinkingDotsCycle(cycleNode, { immediate: true, cycle: shortCycle });
  ok('自动交替从开场三点开始', cycleNode.dataset.phase === 'triangle');
  await sleep(40);
  ok('第一段内保持三点', cycleNode.dataset.phase === 'triangle');
  await sleep(100);
  ok('过一段后自己切到四点方阵', cycleNode.dataset.phase === 'square');
  await sleep(100);
  ok('再下一段切回三点，不需要任何外部状态变化', cycleNode.dataset.phase === 'triangle');
  startThinkingDotsCycle(cycleNode, { immediate: true, cycle: shortCycle });
  await sleep(40);
  ok('重复 start 不重置正在进行的那一段', cycleNode.dataset.phase === 'triangle');
  stopThinkingDotsCycle(cycleNode);
  await sleep(140);
  ok('stop 之后不再改相位', cycleNode.dataset.phase === 'triangle');
  setThinkingDotsPhase(cycleNode, 'square', { immediate: true });
  startThinkingDotsCycle(cycleNode, { immediate: true, restart: true, cycle: shortCycle });
  ok('restart 从开场形态重新开始', cycleNode.dataset.phase === 'triangle');
  stopThinkingDotsCycle(cycleNode);

  const M = await import(pathToFileURL(path.join(PUB, 'messages.js')).href);
  const row = () => d.querySelector('#stream .working');
  M.showWorking();
  const workRow = row();
  const chatDots = () => workRow.querySelector('.thinking-dots');
  ok('聊天流出现 working 行', Boolean(workRow));
  ok('working 行内是四点组件 + 文案', workRow.querySelectorAll('.thinking-dots > span').length === 4
    && workRow.querySelector('.working-label')?.textContent === 'Pi 正在处理…');
  ok('开场是三点轨道、不隐藏、不带工具态', chatDots().dataset.phase === 'triangle' && workRow.hidden === false && !workRow.classList.contains('is-tool-active'));

  const TM = await import(pathToFileURL(path.join(PUB, 'tool-model.js')).href);
  TM.registerEntry({ id: 'fixture-running', status: 'running' });
  M.syncToolWorking();
  ok('工具运行中：保留动画、只收文案，形态不被工具起停打断',
    workRow.hidden === false && workRow.classList.contains('is-tool-active') && chatDots().dataset.phase === 'triangle');
  TM.clearLiveEntries();
  M.syncToolWorking();
  ok('工具结束：去掉 is-tool-active，形态仍按自己的节奏',
    !workRow.classList.contains('is-tool-active') && chatDots().dataset.phase === 'triangle');

  /* 把当前形态切成方阵，再起停工具：工具不能把它改回去。 */
  setThinkingDotsPhase(chatDots(), 'square', { immediate: true });
  TM.registerEntry({ id: 'fixture-no-override', status: 'running' });
  M.syncToolWorking();
  TM.clearLiveEntries();
  M.syncToolWorking();
  ok('工具起停不会覆盖自动交替的当前形态', chatDots().dataset.phase === 'square');

  TM.registerEntry({ id: 'fixture-born', status: 'running' });
  M.showWorking();
  ok('工具已运行时新指示器同样从开场三点出生', row().querySelector('.thinking-dots').dataset.phase === 'triangle');
  TM.clearLiveEntries();
  M.syncToolWorking();
  ok('新指示器同样不因工具结束而改形态', row().querySelector('.thinking-dots').dataset.phase === 'triangle');

  M.setStreaming(false);
  ok('setStreaming(false) 收起指示器', row() === null);
  M.setStreaming(true);
  ok('setStreaming(true) 重新出现指示器（开场三点）', row() !== null
    && row().querySelector('.thinking-dots').dataset.phase === 'triangle');
  M.interruptActive();
  ok('interruptActive（取消/中断）收起指示器', row() === null);
  M.hideWorking();

  /* ---------- 3. 并行会话：状态行按各自 activity 显隐，形态自动交替 ---------- */
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
    item('G', { activity: 'running' }),
  ] });
  const host = d.createElement('div'); host.id = 'dots-runtime-host'; d.body.appendChild(host);
  const view = createRuntimeConversation({ host });
  const stateLine = () => host.querySelector('.rtc-state');
  const stateDots = () => stateLine().querySelector('.thinking-dots');
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const show = id => view.show(id);

  show('A');
  ok('运行中显示动画，状态文案不变，开场为三点', stateDots().hidden === false
    && stateDots().dataset.phase === 'triangle' && stateLine().textContent === '就绪 · 运行中');
  observeRuntimeFrame({ type: 'runtime_event', owner: owner('A'), eventSequence: 1,
    event: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read' } });
  ok('工具调用期间动画保持，形态不被工具打断', stateDots().hidden === false
    && stateDots().dataset.phase === 'triangle' && host.querySelectorAll('.ui2-runtime-tool').length === 1);
  observeRuntimeFrame({ type: 'runtime_event', owner: owner('A'), eventSequence: 2,
    event: { type: 'tool_execution_end', toolCallId: 't1', isError: false } });
  ok('工具结束：形态同样不改', stateDots().dataset.phase === 'triangle');
  observeRuntimeFrame({ type: 'runtime_event', owner: owner('A'), eventSequence: 3,
    event: { type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash' } });
  ok('又起一个工具：动画与形态都保持', stateDots().dataset.phase === 'triangle');

  /* 手动把 A 的当前形态设成方阵（模拟自动交替走到方阵那一段），再切走；
   * 共享节点在切换时必须从 G 自己的开场形态重新开始。 */
  setThinkingDotsPhase(stateDots(), 'square', { immediate: true });
  show('G');
  ok('切到另一条运行中的会话 G：从 G 自己的开场三点重新开始，不继承 A 的方阵',
    stateDots().hidden === false && stateDots().dataset.phase === 'triangle');
  show('A');
  ok('切回 A：同样从开场形态重新开始', stateDots().hidden === false && stateDots().dataset.phase === 'triangle');

  show('B');
  ok('切到空闲会话：隐藏动画，文案是 B 自己的', stateDots().hidden === true && stateLine().textContent === '就绪 · 空闲');
  show('A');
  ok('切回运行中的 A：动画恢复，A 的状态未被 B 覆盖', stateDots().hidden === false && stateLine().textContent === '就绪 · 运行中');
  show('C');
  ok('报错会话不显示动画', stateDots().hidden === true && stateLine().textContent.includes('运行异常'));

  show('F');
  observeRuntimeFrame({ type: 'runtime_event', owner: owner('F'), eventSequence: 1,
    event: { type: 'extension_ui_request', id: 'ap1', method: 'confirm', title: '继续？' } });
  ok('待审批时停下（Agent 在等人，不在执行）', stateDots().hidden === true);

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
