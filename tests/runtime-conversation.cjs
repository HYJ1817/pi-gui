/* P32.4-B：中央 focused conversation 的隔离与生命周期契约。
 *
 * 只测**契约**（草稿/滚动/owner/历史 vs 恢复/关闭/重启），不测像素。所有数据是
 * fixture：不发真实网络、不启 Pi。真实 Electron 闭环见 runtime-electron.cjs。 */
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

(async () => {
  let checks = 0;
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };

  const dom = new JSDOM('<div id="host"></div><div id="modal" hidden><div id="modalCard"></div></div>'
    + '<div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div>', { url: 'http://127.0.0.1/' });
  global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;

  const { runtimeStore, observeRuntimeFrame } = await import('../public/runtime-state.js');
  const { createRuntimeConversation } = await import('../public/runtime-conversation.js');

  const owner = (id, gen = 'one') => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id,
    workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: gen, sessionId: 's-' + id });

  const requests = [];
  let historyResult = { ok: true, messages: [{ role: 'user', text: '历史问题' }, { role: 'assistant', text: '历史回答' }] };
  global.fetch = async (url, opts = {}) => ({ json: async () => {
    const u = String(url);
    if (!opts.body) return u.includes('conversationId=')
      ? { ok: true, sessionId: 's-A', messages: historyResult.messages, truncated: false }
      : { ok: true, backendInstance: 'backend', items: [] };
    const body = JSON.parse(opts.body); requests.push(body);
    if (body.command?.type === 'abort') return new Promise(resolve => { global.__stopResolve = resolve; });
    return { ok: true };
  } });

  const host = document.querySelector('#host');
  const view = createRuntimeConversation({ host });
  const output = () => host.querySelector('.rtc-output');
  const input = () => host.querySelector('textarea');
  const btn = text => [...host.querySelectorAll('button')].find(b => b.textContent === text);
  const stateLine = () => host.querySelector('.rtc-state').textContent;
  const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const frame = (id, seq, text, gen = 'one') => observeRuntimeFrame({ type: 'runtime_event', owner: owner(id, gen), eventSequence: seq,
    event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } } });

  runtimeStore.seed({ backendInstance: 'backend', items: [
    { conversationId: 'A', createdAt: '2026-01-01T00:00:00.000Z', workspace: { branch: 'branch-A', projectId: 'project' }, owner: owner('A'), lifecycle: 'ready', activity: 'running', attention: false, error: null, stop: null },
    { conversationId: 'B', createdAt: '2026-01-02T00:00:00.000Z', workspace: { branch: 'branch-B', projectId: 'project' }, owner: owner('B'), lifecycle: 'ready', activity: 'running', attention: false, error: null, stop: null },
    { conversationId: 'D', createdAt: '2026-01-03T00:00:00.000Z', workspace: { branch: 'branch-D', projectId: 'project' }, owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, error: null, stop: null },
    { conversationId: 'E', createdAt: '2026-01-04T00:00:00.000Z', workspace: { branch: 'branch-E', projectId: 'project' }, owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, error: null, stop: null },
  ] });

  frame('A', 1, 'A-output'); frame('B', 1, 'B-output');
  view.show('A');
  ok('切到 A 显示 A 自己的输出', output().textContent === 'A-output');

  /* ---- 7：草稿分离 ---- */
  input().value = 'draft A'; input().dispatchEvent(new dom.window.Event('input'));
  view.show('B');
  ok('切到 B 后不显示 A 的输出', output().textContent === 'B-output');
  ok('切到 B 后输入框为空（草稿不串）', input().value === '');
  input().value = 'draft B'; input().dispatchEvent(new dom.window.Event('input'));
  view.show('A');
  ok('切回 A 草稿仍在', input().value === 'draft A');
  view.show('B');
  ok('切回 B 草稿仍在', input().value === 'draft B');

  /* ---- 8：滚动分离 ---- */
  view.show('A'); output().scrollTop = 42; view.show('B'); output().scrollTop = 7;
  view.show('A');
  ok('A 的滚动位置被恢复（不串到 B）', output().scrollTop === 42);
  view.show('B');
  ok('B 的滚动位置被恢复', output().scrollTop === 7);

  /* ---- 9/10：A streaming 时切 B，A 的 delta 不进 B DOM ---- */
  view.show('A');
  view.show('B');
  const beforeB = output().textContent;
  frame('A', 2, '-late-A');
  ok('切到 B 后 A 的新 delta 不进 B 的 DOM', output().textContent === beforeB && !output().textContent.includes('late-A'));
  view.show('A');
  ok('切回 A 能看到 A 的迟到 delta（后台确实继续在跑）', output().textContent.includes('-late-A'));

  /* ---- 12：A 的 Stop 响应不修改 B ---- */
  view.show('A'); btn('停止').click(); await tick();
  const stopCall = requests.find(r => r.command?.type === 'abort');
  ok('Stop 带 A 的完整 owner', stopCall && stopCall.owner.conversationId === 'A' && stopCall.owner.runtimeGeneration === 'one');
  view.show('B'); input().value = 'draft B2'; input().dispatchEvent(new dom.window.Event('input'));
  global.__stopResolve({ ok: true }); await tick();
  ok('迟到的 A Stop 响应不改 B 的草稿', input().value === 'draft B2');
  ok('迟到的 A Stop 响应不改 B 的输出', output().textContent === 'B-output');

  /* ---- 13：同 approval id 按 owner 隔离 ---- */
  const approval = (id, gen = 'one') => observeRuntimeFrame({ type: 'runtime_event', owner: owner(id, gen), eventSequence: 9,
    event: { type: 'extension_ui_request', id: 'shared-approval', method: 'confirm', title: 'Approve ' + id } });
  view.show('A'); approval('A'); await tick();
  const capturedA = btn('确认');
  ok('A 的审批出现在 A 的视图里', Boolean(capturedA) && host.textContent.includes('Approve A'));
  view.show('B'); approval('B'); await tick();
  ok('切到 B 后显示的是 B 的审批', host.textContent.includes('Approve B'));
  requests.length = 0;
  capturedA.click(); await tick();
  const answered = requests.filter(r => r.command?.type === 'extension_ui_response');
  ok('捕获 A 的审批后切 B，应答仍只发给 A 的完整 owner',
    answered.length === 1 && answered[0].owner.conversationId === 'A' && answered[0].command.id === 'shared-approval');
  ok('A 的审批应答不清掉 B 自己的审批', host.textContent.includes('Approve B'));

  /* ---- 14/15：dormant 打开历史不 spawn；只有显式恢复才 spawn ---- */
  requests.length = 0;
  view.show('D'); await tick();
  ok('切到 dormant 只显示已关闭，不自动 spawn、不自动读历史', stateLine().includes('已关闭') && requests.length === 0);
  ok('dormant 时不显示发送，显示「恢复会话」与「打开历史」', btn('发送').disabled && !btn('恢复会话').disabled && !btn('打开历史').disabled);
  btn('打开历史').click(); await tick();
  ok('打开历史只发只读请求，不 spawn', requests.length === 0 && output().textContent.includes('历史问题') && output().textContent.includes('历史回答'));
  ok('历史视图明确标注未启动、不占名额', stateLine().includes('未被启动'));
  ok('历史视图禁止发送', btn('发送').disabled && input().disabled);
  requests.length = 0;
  btn('恢复会话').click(); await tick();
  ok('只有显式「恢复会话」才发 resume', requests.length === 1 && requests[0].action === 'resume' && requests[0].conversationId === 'D');

  /* ---- 16/17：close → dormant；restart → 新 runtime identity 且旧 owner 不再命中 ---- */
  requests.length = 0;
  view.show('A'); btn('关闭会话').click(); await tick();
  ok('关闭会话带 A 的 captured owner', requests[0]?.action === 'close' && requests[0].owner.conversationId === 'A' && requests[0].owner.runtimeGeneration === 'one');
  observeRuntimeFrame({ type: 'runtime_state', owner: owner('A'), item: { conversationId: 'A', createdAt: '2026-01-01T00:00:00.000Z',
    workspace: { branch: 'branch-A', projectId: 'project' }, owner: null, lifecycle: 'dormant', activity: 'idle', attention: false, focused: false, error: null, stop: null } });
  await tick();
  ok('关闭后视图回到已关闭、并给出恢复入口', stateLine().includes('已关闭') && !btn('恢复会话').disabled);

  /* ---- 11：stale（旧 generation）事件不作用于重启后的 A ---- */
  const restarted = { ...owner('A', 'two') };
  observeRuntimeFrame({ type: 'runtime_state', owner: restarted, item: { conversationId: 'A', createdAt: '2026-01-01T00:00:00.000Z',
    workspace: { branch: 'branch-A', projectId: 'project' }, owner: restarted, lifecycle: 'ready', activity: 'idle', attention: false, focused: false, error: null, stop: null } });
  await tick();
  const afterRestart = output().textContent;
  frame('A', 3, '-stale-old-gen', 'one');
  ok('旧 generation 的 delta 不进入重启后的 A', output().textContent === afterRestart && !output().textContent.includes('-stale-old-gen'));
  frame('A', 4, '-fresh-new-gen', 'two');
  ok('新 generation 的 delta 正常进入', output().textContent.includes('-fresh-new-gen'));

  /* ---------- 异步串线：历史与动作都必须按 captured target 归属 ----------
   *
   * 这一节盯住两个真实缺陷（都曾被上一个版本写出来）：
   *   1) loadHistory() 用模块级的 id 归属结果 —— 请求在飞时切走，A 的历史会画到 B 上；
   *   2) busy/notice 是模块级单值 —— A 的 Stop pending 会让 B 的控件被禁用，
   *      而且 A 的迟到响应会写进 B 的提示条。
   * 用「可控的门」把响应压在手里，精确构造乱序返回。 */
  view.dispose();
  const calls = [];
  const gates = new Map();
  const gate = label => { let g = gates.get(label); if (!g) { g = {}; g.promise = new Promise(r => { g.open = r; }); gates.set(label, g); } return g; };
  global.fetch = async (url, opts = {}) => ({ json: async () => {
    const u = String(url);
    if (!opts.body) {
      const m = /conversationId=([^&]+)/.exec(u);
      if (m) { const key = decodeURIComponent(m[1]); calls.push({ history: key }); return gate('history:' + key).promise; }
      return { ok: true, backendInstance: 'backend', items: [] };
    }
    const body = JSON.parse(opts.body); calls.push({ body });
    if (body.command?.type === 'abort') return gate('abort:' + body.owner.conversationId).promise;
    return { ok: true };
  } });

  const view2 = createRuntimeConversation({ host });
  const out2 = () => host.querySelector('.rtc-output');
  const input2 = () => host.querySelector('textarea');
  const btn2 = text => [...host.querySelectorAll('button')].find(b => b.textContent === text);
  const notice2 = () => host.querySelector('.rtc-notice').textContent;
  const state2 = () => host.querySelector('.rtc-state').textContent;

  /* 1–4：dormant D 的历史延迟返回，中途切到 dormant E */
  view2.show('D'); btn2('打开历史').click(); await tick();
  ok('dormant D 发出历史请求', calls.some(c => c.history === 'D'));
  view2.show('E'); await tick();
  gate('history:D').open({ ok: true, messages: [{ role: 'user', text: 'D-历史' }], truncated: false });
  await tick(4);
  ok('D 的历史返回后，当前会话 E 不显示 D 的历史', !out2().textContent.includes('D-历史'));
  ok('D 的历史返回不改 E 的状态行', state2().includes('已关闭'));
  ok('D 的历史返回不改 E 的 notice', notice2() === '');
  view2.show('D'); await tick();
  ok('切回 D 能看到自己的历史', out2().textContent.includes('D-历史'));

  /* 5：D/E 同时各发一次历史请求，**乱序**返回也不能串 */
  view2.dispose();
  const view3 = createRuntimeConversation({ host });
  const out3 = () => host.querySelector('.rtc-output');
  const btn3 = text => [...host.querySelectorAll('button')].find(b => b.textContent === text);
  view3.show('D'); btn3('打开历史').click(); await tick();
  view3.show('E'); btn3('打开历史').click(); await tick();
  gate('history:E').open({ ok: true, messages: [{ role: 'user', text: 'E-历史' }], truncated: false });
  await tick();
  gate('history:D').open({ ok: true, messages: [{ role: 'user', text: 'D-历史' }], truncated: false });
  await tick(4);
  ok('后回的 D 历史不覆盖当前 E 的历史', out3().textContent.includes('E-历史') && !out3().textContent.includes('D-历史'));
  view3.show('D'); await tick();
  ok('切到 D 看到的是 D 自己的历史', out3().textContent.includes('D-历史'));

  /* 6–7：Stop A pending 时切 B —— B 必须完全可操作，且不受 A 的迟到响应影响 */
  /* 前面那一节把 A 关成 dormant 了；这里把四个会话都重设成已知状态（seed 直接覆盖 item），
   * 让这一节的起点确定，不再受前面用例的副作用影响。 */
  runtimeStore.seed({ backendInstance: 'backend', items: [
    { conversationId: 'A', createdAt: '2026-01-01T00:00:00.000Z', workspace: { branch: 'branch-A', projectId: 'project' }, owner: owner('A'), lifecycle: 'ready', activity: 'running', attention: false, error: null, stop: null },
    { conversationId: 'B', createdAt: '2026-01-02T00:00:00.000Z', workspace: { branch: 'branch-B', projectId: 'project' }, owner: owner('B'), lifecycle: 'ready', activity: 'running', attention: false, error: null, stop: null },
  ] });
  await tick();
  view3.show('A');
  btn3('停止').click(); await tick(2);
  ok('A 的 Stop 已发出且仍未完成', calls.some(c => c.body?.command?.type === 'abort' && c.body.owner.conversationId === 'A'));
  view3.show('B'); await tick();
  ok('A pending 时切到 B，B 的控件不被 A 的 busy 禁用', !btn3('停止').disabled && !btn3('重启').disabled && !btn3('关闭会话').disabled);
  input2().value = 'draft-B3'; input2().dispatchEvent(new dom.window.Event('input'));
  const bNotice = notice2();
  const bBefore = { notice: bNotice, draft: 'draft-B3', output: out3().textContent, state: state2() };
  gate('abort:A').open({ ok: false, error: '会话操作未完成', code: 'runtime_not_ready' });
  await tick(4);
  ok('A 的 Stop 失败响应不改 B 的 notice', notice2() === bBefore.notice);
  ok('A 的 Stop 失败响应不改 B 的 state', state2() === bBefore.state);
  ok('A 的 Stop 失败响应不改 B 的 output', out3().textContent === bBefore.output);
  ok('A 的 Stop 失败响应不改 B 的草稿', input2().value === bBefore.draft);
  ok('A 的 Stop 失败响应不禁用 B 的控件', !btn3('停止').disabled);
  view3.show('A'); await tick();
  ok('A 的迟到失败只记在 A 自己身上', notice2().includes('操作未完成') || notice2().includes('运行'));
  view3.show('B'); await tick();
  ok('切回 B 后 B 的 notice 仍为空（A 的错误不跟过来）', notice2() === bNotice && bNotice === '');

  view3.dispose();
  const focusCalls = [];
  global.fetch = async (_url, opts = {}) => ({ json: async () => {
    if (!opts.body) return { ok: true, backendInstance: 'backend', items: [] };
    const body = JSON.parse(opts.body); focusCalls.push(body);
    return body.action === 'resume' ? { ok: true, owner: owner(body.conversationId, 'resumed') } : { ok: true };
  } });
  const view4 = createRuntimeConversation({ host });
  view4.show('D'); [...host.querySelectorAll('button')].find(b => b.textContent === '恢复会话').click(); await tick();
  ok('恢复请求接收确认时还不 focus 未就绪的 owner', !focusCalls.some(c => c.action === 'focus'));
  const unboundD = { ...owner('D', 'resumed'), sessionId: null };
  observeRuntimeFrame({ type: 'runtime_state', owner: unboundD, item: { conversationId: 'D', revision: 99, owner: unboundD, lifecycle: 'ready', activity: 'idle' } }); await tick();
  ok('ready 尚未绑定原生 sessionId 时不消耗 focus 意图', !focusCalls.some(c => c.action === 'focus'));
  observeRuntimeFrame({ type: 'runtime_state', owner: owner('D', 'resumed'), item: { conversationId: 'D', revision: 100, owner: owner('D', 'resumed'), lifecycle: 'ready', activity: 'idle' } }); await tick();
  ok('当前历史会话恢复就绪后 focus 完整 ready owner', focusCalls.some(c => c.action === 'focus' && c.owner.conversationId === 'D' && c.owner.runtimeGeneration === 'resumed'));
  view4.show('E'); [...host.querySelectorAll('button')].find(b => b.textContent === '恢复会话').click(); await tick();
  view4.show('B');
  observeRuntimeFrame({ type: 'runtime_state', owner: owner('E', 'resumed'), item: { conversationId: 'E', revision: 101, owner: owner('E', 'resumed'), lifecycle: 'ready', activity: 'idle' } }); await tick();
  ok('切走后的恢复就绪不会抢走 B 焦点', !focusCalls.some(c => c.action === 'focus' && c.owner.conversationId === 'E'));
  view4.dispose();
  for (const [target, leave] of [['F', false], ['G', true]]) {
    runtimeStore.seed({ backendInstance: 'backend', items: [{ conversationId: target, owner: null, lifecycle: 'dormant', revision: 1 }] });
    let finishResume;
    global.fetch = async (_url, opts = {}) => ({ json: async () => {
      if (!opts.body) return { ok: true, backendInstance: 'backend', items: [] };
      const body = JSON.parse(opts.body); focusCalls.push(body);
      if (body.action === 'resume') return new Promise(resolve => { finishResume = resolve; });
      return { ok: true };
    } });
    const returningView = createRuntimeConversation({ host }); returningView.show(target);
    [...host.querySelectorAll('button')].find(b => b.textContent === '恢复会话').click(); await tick();
    if (leave) returningView.leave(); else returningView.show('B');
    returningView.show(target);
    finishResume({ ok: true, owner: owner(target, 'resumed') }); await tick();
    observeRuntimeFrame({ type: 'runtime_state', owner: owner(target, 'resumed'), item: { conversationId: target, revision: 100, owner: owner(target, 'resumed'), lifecycle: 'ready', activity: 'idle' } }); await tick();
    ok(leave ? '离开经典视图再返回不恢复迟到 focus 意图' : '切走再切回不重新创建迟到 focus 意图', !focusCalls.some(c => c.action === 'focus' && c.owner.conversationId === target));
    returningView.dispose();
  }
  console.log(`Runtime conversation: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
