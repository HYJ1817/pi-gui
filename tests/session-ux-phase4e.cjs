/* P4-E：后台会话完成/失败/中断提示。
 *
 * 这里钉住两件事：
 *   1. 终态只来自真实生命周期证据（generationResult / assistant stopReason /
 *      bridge 在一次运行中退出 / 用户 Stop 成功），并且每轮只记一次；
 *   2. 侧栏只增加**一条**聚合提示，后台更新不切会话、不抢焦点，点击才定位。
 *
 * 全部使用 fixture：不启 Pi、不发真实网络、不写用户数据。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

(async () => {
  let checks = 0;
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const waitFor = async (fn, label) => {
    for (let i = 0; i < 80; i++) { if (fn()) return true; await tick(); }
    throw new Error('等待超时：' + label);
  };

  /* ---------- 后端：终态归一、去重与焦点竞态 ---------- */
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4e-runtime-'));
  const cwd = path.join(dir, 'A');
  fs.mkdirSync(cwd);
  const workspace = { projectId: 'project', repoId: 'repo', workspaceId: 'A', workspaceEpoch: 'epoch-A', cwd, root: cwd, branch: 'A' };
  const published = [];
  let adapter = null;
  let focusGate = null;
  let failFocus = false;
  let abortOk = true;
  let abortThrows = false;
  const registry = createRuntimeRegistry({
    dataDir: dir,
    publish: event => published.push(event),
    resolveWorkspace: async () => ({ ...workspace }),
    validateWorkspace: async () => {},
    onFocus: async () => { if (failFocus) throw new Error('focus failed'); if (focusGate) await focusGate; },
    factory: async (context, emit) => {
      adapter = {
        context, emit,
        start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }),
        getState: () => ({ state: 'ready', stop: null }),
        send: () => {},
        abortAndWait: async () => {
          if (abortThrows) throw new Error('abort crashed');
          return abortOk ? { ok: true, evidence: 'abort-response' } : { ok: false, code: 'stop_unconfirmed' };
        },
        request: async cmd => cmd.type === 'get_state' ? { sessionId: 'native-A', isStreaming: false } : { messages: [] },
        dispose: async () => {},
      };
      return adapter;
    },
  });

  try {
    const started = await registry.start({ id: 'A', epoch: 'epoch-A' });
    await tick();
    const id = started.conversationId;
    let owner = registry.getOwner(id);
    const item = () => registry.snapshot().items.find(entry => entry.conversationId === id);
    let bridgeRun = 1;
    const emit = event => adapter.emit({ bridgeRun, ...event });
    const settle = (generationResult, extra = {}) => emit({ type: 'agent_settled', ...(generationResult ? { generationResult } : {}), ...extra });

    ok('初始没有终态', item().outcome === null);

    emit({ type: 'agent_start' });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    settle({ requestId: 'r1', outcome: 'success', hasVisibleOutput: true });
    ok('成功 generationResult → 已完成，且仍保留 attention', item().outcome?.kind === 'completed'
      && item().outcome.reason === 'generation_completed' && item().outcome.sequence === 1
      && item().attention === true && item().activity === 'idle');

    await registry.focus(owner);
    ok('聚焦该会话后终态被读掉', item().outcome === null && item().attention === false);
    await registry.blur(owner);
    settle({ requestId: 'r1', outcome: 'success', hasVisibleOutput: true });
    ok('已读掉的终态不会被迟到的重复 settled 重新点亮', item().outcome === null
      && item().attention === false);

    emit({ type: 'agent_start' });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    settle(null);
    ok('没有 generationResult 时退回真实 assistant stopReason', item().outcome?.kind === 'completed');
    const fallbackSequence = item().outcome.sequence;

    emit({ type: 'agent_start' });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } });
    settle(null);
    ok('assistant stopReason=error → 失败', item().outcome?.kind === 'failed'
      && item().outcome.reason === 'generation_failed' && item().outcome.sequence === fallbackSequence + 1);

    emit({ type: 'agent_start' });
    await registry.command(owner, { type: 'abort' });
    const abortSequence = item().outcome?.sequence;
    ok('运行中用户 Stop 成功 → 已中断（用户取消）并标记未读', item().outcome?.kind === 'interrupted'
      && item().outcome.reason === 'user_cancelled' && item().activity === 'idle' && item().attention === true);
    settle({ requestId: 'r-abort', outcome: 'success', hasVisibleOutput: true });
    ok('随后迟到的成功 settled 不覆盖用户中断，也不重复计数', item().outcome?.kind === 'interrupted'
      && item().outcome.sequence === abortSequence);

    emit({ type: 'agent_start' });
    abortOk = false;
    const failedAbort = await registry.command(owner, { type: 'abort' });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    settle(null);
    ok('Stop 未被确认时，后续正常完成不会误报为已中断', failedAbort.ok === false
      && item().outcome?.kind === 'completed');
    abortOk = true;
    emit({ type: 'stop_state', pending: false });

    emit({ type: 'agent_start' });
    abortThrows = true;
    await assert.rejects(() => registry.command(owner, { type: 'abort' }));
    abortThrows = false;
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    settle(null);
    ok('Stop 请求异常也不会把后续正常完成误报为中断', item().outcome?.kind === 'completed');
    emit({ type: 'stop_state', pending: false });

    emit({ type: 'agent_start' });
    settle(null);
    ok('没有可确认证据时只报未知终态', item().outcome?.kind === 'unknown'
      && item().outcome.reason === 'unconfirmed');

    emit({ type: 'agent_start' });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse' } });
    settle(null, { aborted: true });
    ok('真实 aborted settled → 已中断，不由 toolUse 误判为未知', item().outcome?.kind === 'interrupted'
      && item().outcome.reason === 'user_cancelled');

    emit({ type: 'agent_start' });
    settle({ requestId: 'aborted-success', outcome: 'success', hasVisibleOutput: true }, { aborted: true });
    ok('aborted 优先于迟到的成功摘要', item().outcome?.kind === 'interrupted'
      && item().outcome.reason === 'user_cancelled');

    emit({ type: 'agent_start' });
    emit({ type: 'bridge_status', state: 'error', bridgeRun: 1 });
    const crashSequence = item().outcome?.sequence;
    ok('运行中 bridge 退出 → 已中断（运行不可用）', item().outcome?.kind === 'interrupted'
      && item().outcome.reason === 'runtime_unavailable' && item().lifecycle === 'error');
    settle(null);
    ok('bridge 崩溃后的空 settled 不覆盖已记录的中断', item().outcome?.kind === 'interrupted'
      && item().outcome.sequence === crashSequence);

    emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 });
    await registry.command(owner, { type: 'prompt', id: 'preflight', message: 'fixture' });
    emit({ type: 'response', command: 'prompt', id: 'preflight', success: false,
      generationResult: { requestId: 'preflight', outcome: 'failed', failure: { class: 'model_unavailable' }, hasVisibleOutput: false } });
    ok('prompt preflight 失败也记录真实终态', item().outcome?.kind === 'failed'
      && item().outcome.reason === 'generation_failed' && item().error === 'generation_failed');

    await registry.focus(owner);
    emit({ type: 'bridge_status', state: 'error', bridgeRun: 1 });
    ok('空闲时 bridge 断开不伪造任务终态', item().outcome === null);
    emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 });

    await registry.blur(owner);
    emit({ type: 'agent_start' });
    settle({ requestId: 'race-1', outcome: 'success', hasVisibleOutput: true });
    const seen = item().outcome;
    ok('后台完成先记下一条终态', seen?.kind === 'completed');

    let releaseFocus;
    focusGate = new Promise(resolve => { releaseFocus = resolve; });
    const focusing = registry.focus(owner);
    await tick();
    emit({ type: 'agent_start' });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } });
    settle(null);
    const duringFocus = item().outcome;
    releaseFocus();
    focusGate = null;
    await focusing;
    ok('聚焦期间新到的终态不被这次聚焦吞掉', duringFocus?.kind === 'failed'
      && item().outcome?.sequence === duringFocus.sequence && item().focused === true);
    await registry.focus(owner);
    ok('再次聚焦才清掉当前终态', item().outcome === null);

    emit({ type: 'agent_start' });
    settle({ requestId: 'focused-run', outcome: 'success', hasVisibleOutput: true });
    ok('用户正看着的会话不生成后台提示', item().outcome === null);

    await registry.blur(owner);
    emit({ type: 'agent_start' });
    settle({ requestId: 'fail-focus', outcome: 'success', hasVisibleOutput: true });
    const beforeFailedFocus = item().outcome?.sequence;
    failFocus = true;
    await assert.rejects(() => registry.focus(owner));
    failFocus = false;
    ok('聚焦失败不会丢掉已有终态', item().outcome?.sequence === beforeFailedFocus && item().focused === false);

    bridgeRun = 2;
    emit({ type: 'bridge_status', state: 'ready', bridgeRun: 2 });
    owner = registry.getOwner(id);
    ok('bridge generation 变化后旧终态作废', item().outcome === null);

    emit({ type: 'agent_start' });
    settle({ requestId: 'clear-on-prompt', outcome: 'success', hasVisibleOutput: true });
    ok('新一轮结束仍能记录', item().outcome?.kind === 'completed');
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    await registry.command(owner, { type: 'prompt', id: 'next', message: 'next' });
    ok('提交新任务立即清掉上一轮终态', item().outcome === null && item().activity === 'running');

    /* 复审回归：失败结果也必须走 recordOutcome 的一次性收口。 */
    emit({ type: 'agent_start' });
    settle({ requestId: 'dup-fail', outcome: 'failed', failure: { class: 'server_error' }, hasVisibleOutput: false });
    ok('后台失败同时记录终态、错误与未读', item().outcome?.kind === 'failed'
      && item().error === 'generation_failed' && item().attention === true);

    await registry.focus(owner);
    ok('聚焦读掉失败终态与未读点，但保留详情错误', item().outcome === null
      && item().attention === false && item().error === 'generation_failed');

    settle({ requestId: 'dup-fail', outcome: 'failed', failure: { class: 'server_error' }, hasVisibleOutput: false });
    ok('同一轮重复失败 settled 不重新点亮终态或 attention', item().outcome === null
      && item().attention === false);

    emit({ type: 'agent_start' });
    settle({ requestId: 'focused-fail', outcome: 'failed', failure: { class: 'server_error' }, hasVisibleOutput: false });
    ok('用户正看着的会话失败只记录详情错误，不产生未读点', item().outcome === null
      && item().attention === false && item().error === 'generation_failed');

    await registry.blur(owner);
    emit({ type: 'agent_start' });
    settle({ requestId: 'retry-fail', outcome: 'failed', failure: { class: 'server_error' }, hasVisibleOutput: false });
    ok('后台失败在下一轮开始前保持可见', item().error === 'generation_failed'
      && item().outcome?.kind === 'failed');

    emit({ type: 'agent_start' });
    ok('自动重试的新 agent_start 清掉上一轮失败错误', item().error === null
      && item().outcome === null);

    settle({ requestId: 'retry-success', outcome: 'success', hasVisibleOutput: true });
    ok('自动重试成功后不再保留上次失败错误', item().error === null
      && item().outcome?.kind === 'completed');

    settle({ requestId: 'retry-fail', outcome: 'failed', failure: { class: 'server_error' }, hasVisibleOutput: false });
    ok('新轮成功后迟到的旧失败帧不覆盖终态或 error', item().outcome?.kind === 'completed'
      && item().error === null);

    await registry.focus(owner);
    settle({ requestId: 'retry-fail', outcome: 'failed', failure: { class: 'server_error' }, hasVisibleOutput: false });
    ok('已读后迟到的失败帧不重新点亮 attention', item().outcome === null
      && item().attention === false && item().error === null);
  } finally {
    try { await registry.dispose(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  /* ---------- 前端：聚合提示、状态区分与点击定位 ---------- */
  const dom = new JSDOM('<div id="list"></div><div id="modal" hidden><div id="modalCard"></div></div>'
    + '<div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div>', { url: 'http://127.0.0.1/' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;

  const nav = await import('../public/runtime-nav.js');
  const { observeRuntimeEvent, configureRuntimeSessions } = await import('../public/runtime-sessions.js');

  const owner = id => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id,
    workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: 'one', sessionId: 's-' + id });
  const record = (id, createdAt, over = {}) => ({ conversationId: id, createdAt, revision: 1,
    workspace: { branch: 'branch-' + id, projectId: 'project' }, owner: null, lifecycle: 'dormant', activity: 'idle',
    attention: false, focused: false, error: null, stop: null, outcome: null, ...over });
  const outcome = (kind, sequence) => ({ kind, reason: kind === 'completed' ? 'generation_completed'
    : kind === 'failed' ? 'generation_failed' : kind === 'interrupted' ? 'user_cancelled' : 'unconfirmed', sequence });

  let items = [
    record('A', '2026-01-01T00:00:01.000Z', { owner: owner('A'), lifecycle: 'ready', attention: true, outcome: outcome('completed', 1), revision: 10 }),
    record('B', '2026-01-01T00:00:02.000Z', { owner: owner('B'), lifecycle: 'ready', attention: true, outcome: outcome('failed', 1), revision: 11 }),
    record('C', '2026-01-01T00:00:03.000Z', { owner: owner('C'), lifecycle: 'ready', attention: true, outcome: outcome('interrupted', 1), revision: 12 }),
    record('D', '2026-01-01T00:00:04.000Z'),
  ];
  const requests = [];
  const switches = [];
  nav.setRuntimeFocusHandler(conversationId => switches.push(conversationId));
  configureRuntimeSessions({ focusView: conversationId => switches.push(conversationId) });
  global.fetch = async (url, options = {}) => ({ json: async () => {
    if (String(url).startsWith('/api/worktrees')) return { ok: true, projectId: 'project', contextGeneration: 1, items: [] };
    if (!options.body) return { ok: true, backendInstance: 'backend', items };
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.action === 'focus') {
      const target = body.owner.conversationId;
      items = items.map(entry => entry.conversationId === target
        ? { ...entry, focused: true, attention: false, outcome: null, revision: entry.revision + 1 }
        : { ...entry, focused: false });
      const updated = items.find(entry => entry.conversationId === target);
      /* 真实后端 focus 成功后会用 SSE 广播新的 runtime_state；这里照同一形状补一帧。 */
      setImmediate(() => observeRuntimeEvent({ type: 'runtime_state', owner: body.owner, item: updated }));
      return { ok: true, item: updated };
    }
    return { ok: true };
  } });

  const list = document.querySelector('#list');
  nav.setRuntimeNavParent(list);
  await nav.loadRuntimeNav({ path: '/fixture' }, { parent: list });
  const rows = () => [...list.querySelectorAll('.pj-runtime[data-conversation-id]')];
  const row = id => rows().find(entry => entry.dataset.conversationId === id);
  const status = id => row(id)?.querySelector('.pj-runtime-status')?.textContent || '';
  const resultButton = () => list.querySelector('.pj-runtime-results');

  ok('完成/失败/中断/休眠四条会话都保持原行数', rows().length === 4);
  ok('已完成使用安静文案', status('A') === '已完成' && row('A').dataset.outcome === 'completed');
  ok('失败与中断分别展示', status('B') === '失败' && status('C') === '已中断'
    && row('B').dataset.outcome === 'failed' && row('C').dataset.outcome === 'interrupted');
  ok('语义点与文字类名严格跟随终态', row('A').querySelector('.pj-runtime-dot').classList.contains('outcome-completed')
    && row('B').querySelector('.pj-runtime-dot').classList.contains('outcome-failed')
    && row('C').querySelector('.pj-runtime-dot').classList.contains('outcome-interrupted')
    && row('B').querySelector('.pj-runtime-status').classList.contains('outcome-failed'));
  ok('dormant 行不冒充终态', !row('D').dataset.outcome && status('D') === '已关闭');
  ok('项目内只有一条聚合提示', list.querySelectorAll('.pj-runtime-results').length === 1
    && resultButton().textContent.includes('3 个后台会话有结果'));
  ok('聚合提示带可读的终态构成', resultButton().getAttribute('aria-label').includes('已完成 1')
    && resultButton().getAttribute('aria-label').includes('失败 1')
    && resultButton().getAttribute('aria-label').includes('已中断 1'));
  ok('载入/后台状态本身不切会话、不抢焦点', switches.length === 0
    && !rows().some(entry => entry.classList.contains('on'))
    && !requests.some(request => request.action === 'focus'));

  /* 后台更新重画：焦点留在用户当前所在的聚合按钮上，不跳到任何会话。 */
  resultButton().focus();
  const beforeUpdateRequests = requests.length;
  const liveD = record('D', '2026-01-01T00:00:04.000Z', {
    owner: owner('D'), lifecycle: 'ready', activity: 'idle', attention: true, outcome: outcome('unknown', 1), revision: 13,
  });
  observeRuntimeEvent({ type: 'runtime_state', owner: owner('D'), item: liveD });
  /* 后续快照读回同一状态；真实后端也会带着相同 revision/owner。 */
  items = items.map(entry => entry.conversationId === 'D' ? liveD : entry);
  ok('未知终态与其它状态区分', status('D') === '已结束' && row('D').dataset.outcome === 'unknown'
    && row('D').querySelector('.pj-runtime-dot').classList.contains('outcome-unknown'));
  ok('后台更新后聚合计入新结果', resultButton().textContent.includes('4 个后台会话有结果'));
  ok('后台重画保留聚合按钮焦点，不抢输入/不切会话', document.activeElement === resultButton()
    && switches.length === 0 && requests.length === beforeUpdateRequests);

  /* 多条结果：打开既有 Runtime 列表，只预选，不自动 focus。 */
  const modal = document.querySelector('#modal');
  resultButton().click();
  await waitFor(() => modal.querySelector('.runtime-list [data-conversation-id]'), '打开 Runtime 列表');
  ok('多条结果打开既有 Runtime 列表', modal.hidden === false && !!modal.querySelector('.runtime-list'));
  ok('打开聚合列表不发送 focus、不切换中央会话', !requests.some(request => request.action === 'focus') && switches.length === 0);
  const modalRow = id => modal.querySelector(`.runtime-list [data-conversation-id="${id}"]`);
  ok('列表预选最近变化的那条结果', modalRow('D')?.getAttribute('aria-pressed') === 'true');
  ok('列表行区分失败与未确认', modalRow('B').textContent.includes('失败')
    && modalRow('D').textContent.includes('已结束')
    && modalRow('B').dataset.outcome === 'failed' && modalRow('D').dataset.outcome === 'unknown');
  ok('详情行同样给出终态而不是把中断说成生成失败', modal.querySelector('.runtime-body .modal-desc').textContent.includes('已结束'));

  const focusBeforeChoose = requests.filter(request => request.action === 'focus').length;
  modalRow('B').click();
  await waitFor(() => switches.includes('B'), '点击列表行后切到 B');
  ok('点击具体结果才发送 focus 并切到正确会话', requests.filter(request => request.action === 'focus').length === focusBeforeChoose + 1
    && requests.find(request => request.action === 'focus' && request.owner.conversationId === 'B')
    && switches.includes('B'));
  await waitFor(() => !resultButton().textContent.includes('4 个后台会话有结果'), 'B 的终态被读掉');
  ok('读掉一条后聚合数下降，已读结果不再提示', resultButton().textContent.includes('3 个后台会话有结果')
    && status('B') === '就绪');
  ok('点击结果不发 prompt / abort / start', !requests.some(request => ['prompt', 'abort'].includes(request.command?.type) || request.action === 'start'));

  /* 列表 refresh（重启等动作后）不能把用户改选的会话拽回预选项。 */
  const restart = [...modal.querySelectorAll('button')].find(entry => entry.textContent === '重启');
  restart.click();
  await waitFor(() => modalRow('B')?.getAttribute('aria-pressed') === 'true' && !restart.disabled, 'refresh 后保留用户选择');
  ok('列表刷新后仍保留用户改选，不回到预选结果', modalRow('B')?.getAttribute('aria-pressed') === 'true'
    && modalRow('D')?.getAttribute('aria-pressed') === 'false');

  [...modal.querySelectorAll('button')].find(entry => entry.textContent === '关闭')?.click();
  await tick();
  ok('关闭既有列表后回到侧栏', modal.hidden === true);

  /* 单条结果：直接定位该会话，不再经过列表。 */
  items = items.map(entry => entry.conversationId === 'D' || entry.conversationId === 'C' || entry.conversationId === 'B'
    ? { ...entry, outcome: null, attention: false, revision: entry.revision + 1 } : entry);
  await nav.loadRuntimeNav({ path: '/fixture' }, { parent: list });
  ok('只剩一条结果时聚合提示仍只出现一次', resultButton().textContent.includes('1 个后台会话有结果'));
  requests.length = 0;
  switches.length = 0;
  resultButton().focus();
  resultButton().click();
  await waitFor(() => requests.some(request => request.action === 'focus'), '单条结果直接 focus');
  ok('单条结果点击直接定位会话', requests.find(request => request.action === 'focus')?.owner.conversationId === 'A'
    && switches.length === 1 && switches[0] === 'A');
  ok('单条结果不打开列表、不自动改其它会话', modal.hidden === true);
  await waitFor(() => document.activeElement?.closest?.('[data-conversation-id]')?.dataset.conversationId === 'A',
    '单条结果激活后焦点落到会话行');
  ok('单条结果激活后键盘焦点落到对应会话行，不掉到 body',
    document.activeElement?.closest?.('[data-conversation-id]')?.dataset.conversationId === 'A');

  /* 终态与当前 runtime 错误同时存在：两者都要可见，不能用旧结果盖掉错误。 */
  items = [...items, record('E', '2026-01-01T00:00:05.000Z', {
    owner: owner('E'), lifecycle: 'error', error: 'runtime_unavailable',
    attention: true, outcome: outcome('completed', 1), revision: 20,
  })];
  await nav.loadRuntimeNav({ path: '/fixture' }, { parent: list });
  ok('后台终态不会盖掉当前 runtime 错误', status('E') === '已完成 · 错误'
    && row('E').querySelector('.pj-runtime-status').classList.contains('outcome-completed'));

  console.log(`\nSession UX P4-E: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
