/* P32.4-A：项目会话区里的并行会话导航。
 *
 * 只测**归属 / 排序 / focus / attention / 不 spawn** 这几条契约 —— 中央会话渲染
 * 属于 P32.4-B，不在这里假造。所有数据都是 fixture：不发真实网络、不启 Pi。 */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

(async () => {
  let checks = 0;
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };

  const dom = new JSDOM('<div id="list"></div><div id="modal" hidden><div id="modalCard"></div></div>'
    + '<div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div>', { url: 'http://127.0.0.1/' });
  global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;

  const nav = await import('../public/runtime-nav.js');
  const { observeRuntimeEvent } = await import('../public/runtime-sessions.js');

  const owner = id => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id,
    workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: 'one', sessionId: 's-' + id });
  /* B 先创建、A 后创建：故意让「创建顺序」与「字母顺序」相反，
   * 否则「按 createdAt 排」和「按 id 排」区分不出来。 */
  const record = (id, createdAt, over = {}) => ({ conversationId: id, createdAt, revision: 1,
    workspace: { branch: 'branch-' + id, projectId: 'project' }, owner: null, lifecycle: 'dormant', activity: 'idle',
    attention: false, focused: false, error: null, stop: null, ...over });

  let items = [record('B', '2026-01-02T00:00:00.000Z'), record('A', '2026-01-01T00:00:00.000Z')];
  const requests = [];
  global.fetch = async (url, opts = {}) => ({ json: async () => {
    if (String(url).startsWith('/api/worktrees')) return { ok: true, projectId: 'project', contextGeneration: 1, items: [] };
    if (!opts.body) return { ok: true, backendInstance: 'backend', items };
    const body = JSON.parse(opts.body); requests.push(body);
    if (body.action === 'focus') { items = items.map(i => ({ ...i, focused: i.conversationId === body.owner.conversationId })); return { ok: true }; }
    return { ok: true };
  } });

  const list = document.querySelector('#list');
  nav.setRuntimeNavParent(list);
  await nav.loadRuntimeNav({ path: '/fixture' }, { parent: list });

  const rows = () => [...list.querySelectorAll('[data-conversation-id]')];
  const ids = () => rows().map(r => r.dataset.conversationId);
  const order = () => ids().join(',');
  /* 后端用 runtime_state 广播状态；前端只按它画（不自己推算）。 */
  const state = (id, over) => observeRuntimeEvent({ type: 'runtime_state', owner: owner(id), item: { ...record(id, '2026-01-01T00:00:00.000Z'), ...over } });

  ok('A/B 两条并行会话都显示', ids().length === 2 && ids().includes('A') && ids().includes('B'));
  ok('排序按后端 createdAt，不是字母序', order() === 'A,B');
  ok('dormant 会话也列出（不因休眠而隐藏）', rows().every(r => r.textContent.includes('已关闭')));
  ok('列表读取不 spawn Runtime', !requests.some(r => r.action === 'start'));
  ok('提供「新建并行会话」入口', !!list.querySelector('.pj-runtime-new'));

  /* dormant 行点了**不能**发 focus（没有 live owner 可校验），更不能 spawn。 */
  requests.length = 0;
  rows().find(r => r.dataset.conversationId === 'A').querySelector('button').click();
  await new Promise(r => setImmediate(r));
  ok('dormant 行点击不发 focus、不 spawn', !requests.some(r => r.action === 'focus' || r.action === 'start'));

  /* 让 A/B 变成 live（有 owner），再验证 focus 语义。 */
  state('A', { owner: owner('A'), lifecycle: 'ready', focused: false });
  state('B', { owner: owner('B'), lifecycle: 'ready', focused: false });
  ok('live 会话显示就绪态', rows().every(r => r.textContent.includes('就绪')));

  /* 点 A → 只发一条带**完整 owner** 的 focus；行位置不动。 */
  const before = order();
  requests.length = 0;
  rows().find(r => r.dataset.conversationId === 'A').querySelector('button').click();
  for (let n = 0; n < 50 && !requests.some(r => r.action === 'focus'); n++) await new Promise(r => setImmediate(r));
  const focus = requests.find(r => r.action === 'focus');
  ok('点击只发 focus，且 owner 完整（不是当前 UI 推断）', focus
    && ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'runtimeId', 'runtimeGeneration', 'sessionId']
      .every(k => typeof focus.owner[k] === 'string'));
  ok('点击不改变排序', order() === before);
  ok('点击不发 prompt / abort / start', !requests.some(r => ['prompt', 'abort'].includes(r.command?.type) || r.action === 'start'));

  /* focused 只有一个：后端用 runtime_state 广播，前端只按它画。 */
  state('A', { owner: owner('A'), focused: true, lifecycle: 'ready' });
  ok('focused 行只有一个', rows().filter(r => r.classList.contains('on')).length === 1
    && rows().find(r => r.classList.contains('on')).dataset.conversationId === 'A');
  /* 换焦点时后端会**两条都广播**（旧的置 false、新的置 true，见 runtime-registry
   * 的 focus）；这里照它广播的形状喂帧。 */
  state('A', { owner: owner('A'), focused: false, lifecycle: 'ready' });
  state('B', { owner: owner('B'), focused: true, lifecycle: 'ready' });
  ok('focus 换到 B 之后仍只有一个 focused', rows().filter(r => r.classList.contains('on')).length === 1
    && rows().find(r => r.classList.contains('on')).dataset.conversationId === 'B');

  /* 后台完成 → attention；点它清 attention（后端 focus 会把 attention 置回 false）。 */
  state('A', { owner: owner('A'), focused: false, lifecycle: 'ready', activity: 'idle', attention: true });
  const rowA = () => rows().find(r => r.dataset.conversationId === 'A');
  ok('后台完成给出 attention 提示', !!rowA().querySelector('.pj-runtime-attention'));
  ok('attention 不抢 focus（focused 仍是 B）', rows().find(r => r.classList.contains('on')).dataset.conversationId === 'B');
  requests.length = 0;
  rowA().querySelector('button').click();
  for (let n = 0; n < 50 && !requests.some(r => r.action === 'focus'); n++) await new Promise(r => setImmediate(r));
  state('A', { owner: owner('A'), focused: true, lifecycle: 'ready', activity: 'idle', attention: false });
  ok('点击该会话后 attention 清除', !rowA().querySelector('.pj-runtime-attention'));

  /* 运行中 / 错误 的状态文案 */
  state('B', { owner: owner('B'), focused: false, lifecycle: 'ready', activity: 'running' });
  ok('运行中显示运行态', rows().find(r => r.dataset.conversationId === 'B').textContent.includes('运行中'));
  state('B', { owner: owner('B'), focused: false, lifecycle: 'error', activity: 'idle' });
  ok('错误显示错误态', rows().find(r => r.dataset.conversationId === 'B').textContent.includes('错误'));

  /* 非 Git 项目：worktrees 拿不到 projectId → 整块不显示，也不留一个必然失败的入口。 */
  global.fetch = async (url, opts = {}) => ({ json: async () => {
    if (String(url).startsWith('/api/worktrees')) return { ok: false, error: 'not_git' };
    if (!opts.body) return { ok: true, backendInstance: 'backend', items };
    return { ok: true };
  } });
  await nav.loadRuntimeNav({ path: '/not-a-repo' }, { parent: list });
  ok('非 Git 项目不显示并行会话块', list.querySelector('#pjRuntimeList').hidden === true && rows().length === 0);

  /* ---------- 「新建并行会话」的创建闭环 ----------
   *
   * 这一节存在的理由：`askBranchName()` 曾经在「创建并启动」里写成 `finish(null)`，
   * 于是**任何合法分支名都被当成取消**，按钮看着能点、实际什么都不发生。
   * 「按钮存在」这种断言抓不到它 —— 必须真的点下去并检查后续动作序列。 */
  const card = () => document.querySelector('#modalCard');
  const btn = text => [...card().querySelectorAll('button')].find(b => b.textContent === text);
  const branchInput = () => card().querySelector('input');

  function mockApi({ prepare, create, start } = {}) {
    const calls = [];
    global.fetch = async (url, opts = {}) => ({ json: async () => {
      const u = String(url);
      if (u.startsWith('/api/worktrees') && !opts.body) return { ok: true, projectId: 'project', contextGeneration: 7, items: [] };
      if (u.startsWith('/api/runtime-sessions') && !opts.body) return { ok: true, backendInstance: 'backend', items };
      const body = JSON.parse(opts.body); calls.push({ url: u, body });
      if (u.startsWith('/api/worktrees')) {
        if (body.action === 'prepare') return prepare ? prepare(body) : { ok: true, nonce: 'nonce-1' };
        if (body.action === 'create') return create ? create(body) : { ok: true, workspace: { id: 'ws-new', epoch: 'epoch-new', branch: body.branch } };
        return { ok: true };
      }
      if (body.action === 'start') return start ? start(body) : { ok: true };
      return { ok: true };
    } });
    return calls;
  }

  async function openCreateDialog() {
    document.querySelector('.pj-runtime-new').click();
    for (let n = 0; n < 80 && !btn('创建并启动'); n++) await new Promise(r => setImmediate(r));
    return Boolean(btn('创建并启动'));
  }

  /* 上一节把 worktrees mock 成 not_git 并隐藏了整块；先恢复成 Git 项目再重载。 */
  let calls = mockApi();
  await nav.loadRuntimeNav({ path: '/fixture' }, { parent: list });
  ok('点击「新建并行会话」打开输入分支名的对话框', await openCreateDialog());
  ok('对话框给出可编辑的分支名默认值', typeof branchInput().value === 'string' && branchInput().value.length > 0);

  branchInput().value = 'pi-gui/p32/regression';
  btn('创建并启动').click();
  for (let n = 0; n < 80 && !calls.some(c => c.body.action === 'start'); n++) await new Promise(r => setImmediate(r));
  const seq = calls.map(c => c.body.action).filter(Boolean);
  ok('创建按 prepare → create → start 依次发生', JSON.stringify(seq) === JSON.stringify(['prepare', 'create', 'start']));
  ok('prepare 带上真实分支名', calls[0].body.branch === 'pi-gui/p32/regression');
  const startCall = calls.find(c => c.body.action === 'start');
  ok('start 用 create 返回的 workspace.id + epoch', startCall.body.args.id === 'ws-new' && startCall.body.args.epoch === 'epoch-new');
  ok('start 不是用 UI 里猜的 id', startCall.body.args.id !== 'main-project' && typeof startCall.body.args.id === 'string');
  ok('创建后对话框关闭', card().children.length === 0);

  /* Cancel 不得创建 */
  calls = mockApi();
  await openCreateDialog();
  btn('取消').click();
  await new Promise(r => setImmediate(r));
  ok('点「取消」不创建任何东西', calls.length === 0);

  /* Escape 不得创建 */
  calls = mockApi();
  await openCreateDialog();
  branchInput().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setImmediate(r));
  ok('Escape 不创建任何东西', calls.length === 0);

  /* Enter 与点击一致 */
  calls = mockApi();
  await openCreateDialog();
  branchInput().value = 'pi-gui/p32/enter';
  branchInput().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  for (let n = 0; n < 80 && !calls.some(c => c.body.action === 'start'); n++) await new Promise(r => setImmediate(r));
  ok('Enter 与点击行为一致（同样走完 prepare→create→start）',
    JSON.stringify(calls.map(c => c.body.action).filter(Boolean)) === JSON.stringify(['prepare', 'create', 'start'])
    && calls[0].body.branch === 'pi-gui/p32/enter');

  /* 失败短路：任一步失败，后续步骤不得继续 */
  calls = mockApi({ prepare: () => ({ ok: false, error: 'branch_conflict' }) });
  await openCreateDialog();
  btn('创建并启动').click();
  for (let n = 0; n < 40; n++) await new Promise(r => setImmediate(r));
  ok('prepare 失败后不 create、不 start', calls.map(c => c.body.action).join(',') === 'prepare');

  calls = mockApi({ create: () => ({ ok: false, error: 'partial_creation' }) });
  await openCreateDialog();
  btn('创建并启动').click();
  for (let n = 0; n < 40; n++) await new Promise(r => setImmediate(r));
  ok('create 失败后不 start', calls.map(c => c.body.action).join(',') === 'prepare,create');

  calls = mockApi({ start: () => ({ ok: false, error: 'runtime_limit' }) });
  await openCreateDialog();
  btn('创建并启动').click();
  for (let n = 0; n < 80 && !calls.some(c => c.body.action === 'start'); n++) await new Promise(r => setImmediate(r));
  ok('start 失败时如实提示「工作区已创建」，不谎报成功',
    document.querySelector('#toasts').textContent.includes('工作区已创建'));

  // 某条快照先发现新会话、归属列表尚在读取时，持续 SSE 不得不断废弃前一个读取。
  const { runtimeStore } = await import('../public/runtime-state.js');
  let listReads = 0, snapshotReads = 0, releaseList;
  let discoveryItems = [record('A', '2026-01-01', { owner: owner('A'), lifecycle: 'ready' })];
  global.fetch = async url => ({ json: async () => String(url).startsWith('/api/worktrees')
    ? { ok: true, projectId: 'project' }
    : { ok: true, backendInstance: 'backend', items: discoveryItems } });
  await nav.loadRuntimeNav({ path: '/fixture' });
  discoveryItems = [...discoveryItems, record('C', '2026-01-03', { owner: owner('C'), lifecycle: 'ready' })];
  runtimeStore.seed({ ok: true, backendInstance: 'backend', items: discoveryItems });
  global.fetch = async url => ({ json: async () => {
    if (String(url).startsWith('/api/worktrees')) { listReads++; return new Promise(resolve => { releaseList = resolve; }); }
    snapshotReads++; return { ok: true, backendInstance: 'backend', items: discoveryItems };
  } });
  for (let n = 0; n < 50; n++) observeRuntimeEvent({ type: 'runtime_event', owner: owner('A'), eventSequence: 1000 + n,
    event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '.' } } });
  await new Promise(r => setImmediate(r));
  ok('50 个 SSE 只发一次尚未完成的归属读取', listReads === 1 && snapshotReads === 1);
  releaseList({ ok: true, projectId: 'project' }); await new Promise(r => setImmediate(r));
  ok('归属读取完成后新会话正常出现', order() === 'A,C');
  console.log(`Runtime nav: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
