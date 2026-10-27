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

  const { runtimeStore, observeRuntimeFrame, seedRuntimeSnapshot } = await import('../public/runtime-state.js');
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

  /* ---- R1: 输入法及 Enter 发送保护 ---- */
  const imeView = createRuntimeConversation({ host });
  const imeOwner = owner('IME-1');
  global.fetch = async (url, opts = {}) => ({ json: async () => {
    if (!opts.body) return { ok: true, backendInstance: 'backend', items: [] };
    const body = JSON.parse(opts.body); requests.push(body);
    return { ok: true };
  } });
  runtimeStore.seed({ backendInstance: 'backend', items: [
    { conversationId: 'IME-1', createdAt: '2026-01-01T00:00:00.000Z', workspace: { branch: 'branch-ime', projectId: 'project' }, owner: imeOwner, lifecycle: 'ready', activity: 'idle', attention: false, error: null, stop: null },
    { conversationId: 'IME-2', createdAt: '2026-01-01T00:00:00.000Z', workspace: { branch: 'branch-ime-2', projectId: 'project' }, owner: owner('IME-2'), lifecycle: 'ready', activity: 'idle', attention: false, error: null, stop: null },
  ] });
  imeView.show('IME-1');
  const imeInput = input();
  const imeSend = btn('发送');
  ok('初始状态发送按钮启用', !imeSend.disabled);

  requests.length = 0;
  // 1. keyCode=229 (即使 key 是 Enter, isComposing 是 false) 不发送
  imeInput.value = '测试输入法';
  imeInput.dispatchEvent(new dom.window.Event('input'));
  const ev229 = new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: false, bubbles: true, cancelable: true });
  imeInput.dispatchEvent(ev229);
  await tick();
  ok('keyCode=229 不发送', requests.length === 0);

  // 2. isComposing=true 不发送
  const evComposing = new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: true, bubbles: true, cancelable: true });
  imeInput.dispatchEvent(evComposing);
  await tick();
  ok('isComposing=true 不发送', requests.length === 0);

  // 3. compositionstart 后的兼容 Enter 不发送
  imeInput.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  const evCompEnter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: false, bubbles: true, cancelable: true });
  imeInput.dispatchEvent(evCompEnter);
  await tick();
  ok('compositionstart 后的兼容 Enter 不发送', requests.length === 0);

  // 4. compositionend 后下一次正常 Enter 可以发送
  imeInput.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  const evNormalEnter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: false, bubbles: true, cancelable: true });
  imeInput.dispatchEvent(evNormalEnter);
  await tick();
  ok('compositionend 后下一次正常 Enter 发送恰好一次', requests.length === 1 && requests[0].command?.message === '测试输入法');

  // 5. Shift+Enter 只换行不发送
  requests.length = 0;
  imeInput.value = '第二行前缀';
  imeInput.dispatchEvent(new dom.window.Event('input'));
  let shiftPrevented = false;
  const evShiftEnter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, shiftKey: true, isComposing: false, bubbles: true, cancelable: true });
  imeInput.dispatchEvent(evShiftEnter);
  await tick();
  ok('Shift+Enter 不发送且不 preventDefault', requests.length === 0 && !evShiftEnter.defaultPrevented);

  // 6. 切换 A/B 会话不继承错误 composition 状态
  imeInput.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  imeView.show('IME-2');
  input().value = 'B 正常输入';
  input().dispatchEvent(new dom.window.Event('input'));
  const evBEnter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: false, bubbles: true, cancelable: true });
  input().dispatchEvent(evBEnter);
  await tick();
  ok('切换 A/B 会话不继承错误 composition 状态且能正常发送', requests.length === 1 && requests[0].command?.message === 'B 正常输入');

  // 7. busy / history / disabled 状态不产生误发送
  requests.length = 0;
  imeView.show('IME-1');
  const rIme1 = runtimeStore.get('IME-1');
  rIme1.item.activity = 'running'; // busy
  imeView.draw();
  imeInput.value = 'busy 时不发';
  imeInput.dispatchEvent(new dom.window.Event('input'));
  imeInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: false, bubbles: true, cancelable: true }));
  await tick();
  ok('busy 状态按 Enter 不产生误发送', requests.length === 0);

  imeView.dispose();

  /* ---- R2: Runtime 未发送纯文本草稿持久化与安全恢复集成测试 ---- */
  localStorage.clear();
  const draftView1 = createRuntimeConversation({ host });
  const draftOwnerA = {
    backendInstance: 'backend',
    projectId: 'p-draft',
    repoId: 'r-draft',
    workspaceId: 'ws-draft-a',
    workspaceEpoch: 'epoch-1',
    conversationId: 'DRAFT-A',
    runtimeId: 'rt-a',
    runtimeGeneration: 'g-a',
    sessionId: 'native-draft-a',
  };
  const draftOwnerB = {
    backendInstance: 'backend',
    projectId: 'p-draft',
    repoId: 'r-draft',
    workspaceId: 'ws-draft-b',
    workspaceEpoch: 'epoch-1',
    conversationId: 'DRAFT-B',
    runtimeId: 'rt-b',
    runtimeGeneration: 'g-b',
    sessionId: 'native-draft-b',
  };
  runtimeStore.seed({ backendInstance: 'backend', items: [
    { conversationId: 'DRAFT-A', nativeSessionId: 'native-draft-a', workspace: { projectId: 'p-draft', workspaceId: 'ws-draft-a', workspaceEpoch: 'epoch-1' }, owner: draftOwnerA, lifecycle: 'ready', activity: 'idle', revision: 1 },
    { conversationId: 'DRAFT-B', nativeSessionId: 'native-draft-b', workspace: { projectId: 'p-draft', workspaceId: 'ws-draft-b', workspaceEpoch: 'epoch-1' }, owner: draftOwnerB, lifecycle: 'ready', activity: 'idle', revision: 1 },
  ] });

  // 1. A/B 会话分别输入草稿，离开时 flush 到持久存储
  draftView1.show('DRAFT-A');
  input().value = '持久草稿 A';
  input().dispatchEvent(new dom.window.Event('input'));
  draftView1.show('DRAFT-B');
  ok('切到 B 后输入框为空', input().value === '');
  input().value = '持久草稿 B';
  input().dispatchEvent(new dom.window.Event('input'));
  draftView1.leave();
  draftView1.dispose();

  // 2. 模拟重开：相同稳定 locator 重新 seed
  runtimeStore.seed({ backendInstance: 'backend-new', items: [
    { conversationId: 'DRAFT-A', nativeSessionId: 'native-draft-a', workspace: { projectId: 'p-draft', workspaceId: 'ws-draft-a', workspaceEpoch: 'epoch-1' }, owner: { ...draftOwnerA, backendInstance: 'backend-new', runtimeId: 'rt-a2' }, lifecycle: 'ready', activity: 'idle', revision: 2 },
    { conversationId: 'DRAFT-B', nativeSessionId: 'native-draft-b', workspace: { projectId: 'p-draft', workspaceId: 'ws-draft-b', workspaceEpoch: 'epoch-1' }, owner: { ...draftOwnerB, backendInstance: 'backend-new', runtimeId: 'rt-b2' }, lifecycle: 'ready', activity: 'idle', revision: 2 },
  ] });

  requests.length = 0;
  const draftView2 = createRuntimeConversation({ host });
  draftView2.show('DRAFT-A');
  ok('重开后自动恢复 A 草稿', input().value === '持久草稿 A');
  ok('恢复草稿绝不自动触发网络发送', requests.length === 0);

  draftView2.show('DRAFT-B');
  ok('切到 B 后自动恢复 B 草稿', input().value === '持久草稿 B');

  // 3. 发送成功 ACK 清除草稿
  let finishSend;
  global.fetch = async (url, opts = {}) => ({ json: async () => {
    if (!opts.body) return { ok: true, backendInstance: 'backend-new', items: [] };
    const body = JSON.parse(opts.body); requests.push(body);
    return new Promise(resolve => { finishSend = resolve; });
  } });

  requests.length = 0;
  draftView2.show('DRAFT-A');
  btn('发送').click();
  await tick();
  ok('点击发送发出 prompt', requests.length === 1 && requests[0].command?.message === '持久草稿 A');

  // 3.1 用户在等待 ACK 期间输入新文本
  input().value = '发送后的新思考';
  input().dispatchEvent(new dom.window.Event('input'));

  // ACK 此时返回
  finishSend({ ok: true });
  await tick();
  ok('旧 ACK 不清除用户新输入的草稿', input().value === '发送后的新思考');

  // 3.2 正常发送并成功清除
  requests.length = 0;
  btn('发送').click();
  await tick();
  finishSend({ ok: true });
  await tick();
  ok('成功发送后草稿被清除', input().value === '');

  // 验证重新打开 A 时也是空的
  draftView2.leave();
  draftView2.show('DRAFT-A');
  ok('清空后再次打开草稿为空', input().value === '');

  // 4. 超限 20000 字符内联提示
  const hugeText = 'H'.repeat(20005);
  input().value = hugeText;
  input().dispatchEvent(new dom.window.Event('input'));
  const noticeEl = host.querySelector('.rtc-draft-notice');
  ok('超限显示内联提示', !noticeEl.hidden && noticeEl.textContent.includes('超过本地恢复上限'));

  // 缩短后提示消失
  input().value = '缩短后的安全草稿';
  input().dispatchEvent(new dom.window.Event('input'));
  ok('缩短后内联提示隐藏', noticeEl.hidden);

  /* ---- R2-Bug1: 清空草稿后，400ms防抖前状态重绘不得恢复旧草稿 ---- */
  const clearOwner = {
    backendInstance: 'backend-new',
    projectId: 'p-clear',
    repoId: 'r-clear',
    workspaceId: 'ws-clear',
    workspaceEpoch: 'epoch-1',
    conversationId: 'CLEAR-1',
    runtimeId: 'rt-c1',
    runtimeGeneration: 'g-c1',
    sessionId: 'native-clear-1',
  };
  runtimeStore.seed({ backendInstance: 'backend-new', items: [
    { conversationId: 'CLEAR-1', nativeSessionId: 'native-clear-1', workspace: { projectId: 'p-clear', workspaceId: 'ws-clear', workspaceEpoch: 'epoch-1' }, owner: clearOwner, lifecycle: 'ready', activity: 'idle', revision: 1 },
  ] });
  draftView2.show('CLEAR-1');
  input().value = '即将被清空的旧草稿';
  input().dispatchEvent(new dom.window.Event('input'));
  await new Promise(r => setTimeout(r, 450)); // 确保已防抖持久化
  ok('旧草稿已持久化', localStorage.getItem('pi-gui.draft.v1:runtime:p-clear:ws-clear:epoch-1:CLEAR-1:native-clear-1')?.includes('即将被清空的旧草稿'));

  // 用户主动清空输入框并派发 input 事件
  input().value = '';
  input().dispatchEvent(new dom.window.Event('input'));
  ok('清空后输入框立即为空', input().value === '');
  ok('清空后内存草稿立即为空', runtimeStore.get('CLEAR-1').draft === '');

  // 关键步骤：在400ms防抖删除完成前，后台推来一帧事件触发 draw()
  observeRuntimeFrame({ type: 'runtime_event', owner: clearOwner, eventSequence: 1,
    event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live' } } });
  draftView2.draw();

  // 此时预期草稿仍然保持为空，绝不能被旧持久副本反向冲刷复活！
  ok('防抖期间触发 draw 绝不恢复旧草稿到输入框', input().value === '');
  ok('防抖期间触发 draw 绝不恢复旧草稿到 store', runtimeStore.get('CLEAR-1').draft === '');

  // 验证后续重新输入仍能正常保存
  input().value = '清空后重新输入的有效草稿';
  input().dispatchEvent(new dom.window.Event('input'));
  await new Promise(r => setTimeout(r, 450));
  ok('清空后重新输入的草稿能正常持久化保存', localStorage.getItem('pi-gui.draft.v1:runtime:p-clear:ws-clear:epoch-1:CLEAR-1:native-clear-1')?.includes('清空后重新输入的有效草稿'));

  // 再次清空，验证持久副本被立即删除
  input().value = '';
  input().dispatchEvent(new dom.window.Event('input'));
  ok('清空后持久副本被立即删除', localStorage.getItem('pi-gui.draft.v1:runtime:p-clear:ws-clear:epoch-1:CLEAR-1:native-clear-1') === null);

  // 验证旧会话存在草稿，随后切换到不同稳定 locator 时，UI 立即移走旧草稿
  input().value = '发生身份变化前的草稿';
  input().dispatchEvent(new dom.window.Event('input'));
  const newSessionOwner = { ...clearOwner, sessionId: 'native-clear-2' };
  runtimeStore.seed({ backendInstance: 'backend-new', items: [
    { conversationId: 'CLEAR-1', nativeSessionId: 'native-clear-2', workspace: { projectId: 'p-clear', workspaceId: 'ws-clear', workspaceEpoch: 'epoch-1' }, owner: newSessionOwner, lifecycle: 'ready', activity: 'idle', revision: 2 },
  ] });
  draftView2.draw();
  ok('会话切换到不同稳定 locator 后输入框移走旧草稿', input().value === '');
  ok('新身份下 store 草稿为空', runtimeStore.get('CLEAR-1').draft === '');

  draftView2.dispose();

  /* ---- R2-Bug3: 旧 ACK 尚未返回，用户清空草稿，相同 Owner/locator 快照插入其间，
   * 用户随后输入与先前完全相同的文本，旧 ACK 到达时绝不能清除新草稿！ ---- */
  const raceOwner = {
    backendInstance: 'backend-new',
    projectId: 'p-race',
    repoId: 'r-race',
    workspaceId: 'ws-race',
    workspaceEpoch: 'epoch-1',
    conversationId: 'RACE-1',
    runtimeId: 'rt-race-1',
    runtimeGeneration: 'g1',
    sessionId: 'native-race-1',
  };
  const raceItem = {
    conversationId: 'RACE-1',
    nativeSessionId: 'native-race-1',
    workspace: { projectId: 'p-race', workspaceId: 'ws-race', workspaceEpoch: 'epoch-1' },
    owner: raceOwner,
    lifecycle: 'ready',
    activity: 'idle',
    revision: 1,
  };
  runtimeStore.seed({ backendInstance: 'backend-new', items: [raceItem] });

  let finishRaceSend;
  global.fetch = async (url, opts = {}) => ({ json: async () => {
    if (!opts.body) return { ok: true, backendInstance: 'backend-new', items: [] };
    const body = JSON.parse(opts.body); requests.push(body);
    return new Promise(resolve => { finishRaceSend = resolve; });
  } });

  requests.length = 0;
  const draftView3 = createRuntimeConversation({ host });
  draftView3.show('RACE-1');

  // 1. 首次输入文本 A 并点击发送（捕获 draftRevision = 1, draft = "文本A"）
  input().value = '文本A';
  input().dispatchEvent(new dom.window.Event('input'));
  btn('发送').click();
  await tick();
  ok('文本A已发出待ACK', requests.length === 1 && requests[0].command?.message === '文本A');

  // 2. 用户清空输入框（draftRevision 增至 2）
  input().value = '';
  input().dispatchEvent(new dom.window.Event('input'));

  // 3. 相同 Owner、相同稳定 locator 的状态快照插入其间
  // （在有 Bug 的实现中，因 draft 为空导致 draftRevision 被错误重置为 0）
  runtimeStore.seed({ backendInstance: 'backend-new', items: [{ ...raceItem, revision: 2 }] });

  // 4. 用户重新输入完全相同的文本 A
  // （在有 Bug 的实现中，0++ 导致 draftRevision 重新变为 1，与旧 ACK 捕获的 revision=1 碰撞）
  input().value = '文本A';
  input().dispatchEvent(new dom.window.Event('input'));

  // 5. 迟到的旧 ACK 此时到达
  finishRaceSend({ ok: true });
  await tick();

  // 验证新输入的文本 A 绝不能被旧 ACK 清除！
  ok('相同文本与Owner下状态快照插入后旧ACK绝不清空新草稿', input().value === '文本A');
  ok('store中新草稿同样完整保留', runtimeStore.get('RACE-1').draft === '文本A');

  draftView3.dispose();

  /* ========================================================================
   * ---- Z5-3B: 历史工具摘要 UI 集成与回归测试 ----
   * ======================================================================== */
  const z53bView = createRuntimeConversation({ host });
  const z53bOwner = id => ({
    backendInstance: 'backend-z53b', projectId: 'p-z53b', repoId: 'r-z53b',
    workspaceId: 'ws-' + id, workspaceEpoch: 'epoch-1', conversationId: id,
    runtimeId: 'rt-' + id, runtimeGeneration: 'g1', sessionId: 'native-' + id
  });
  runtimeStore.seed({ backendInstance: 'backend-z53b', items: [
    { conversationId: 'Z-1', nativeSessionId: 'native-Z-1', workspace: { projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' }, owner: null, lifecycle: 'dormant', activity: 'idle', revision: 1 },
    { conversationId: 'Z-2', nativeSessionId: 'native-Z-2', workspace: { projectId: 'p-z53b', workspaceId: 'ws-Z-2', workspaceEpoch: 'epoch-1' }, owner: null, lifecycle: 'dormant', activity: 'idle', revision: 1 },
    { conversationId: 'Z-LIVE', nativeSessionId: 'native-Z-LIVE', workspace: { projectId: 'p-z53b', workspaceId: 'ws-Z-LIVE', workspaceEpoch: 'epoch-1' }, owner: z53bOwner('Z-LIVE'), lifecycle: 'ready', activity: 'idle', revision: 1 }
  ] });

  const zLocator = id => ({
    conversationId: id,
    nativeSessionId: 'native-' + id,
    projectId: 'p-z53b',
    workspaceId: 'ws-' + id,
    workspaceEpoch: 'epoch-1'
  });

  let zHistoryMock = null;
  global.fetch = async (url, opts = {}) => ({
    json: async () => {
      const u = String(url);
      if (!opts.body) {
        if (u.includes('conversationId=')) {
          const matchId = u.match(/conversationId=([^&]+)/)?.[1] || 'Z-1';
          const mock = typeof zHistoryMock === 'function' ? await zHistoryMock(u) : zHistoryMock;
          if (mock && !Object.hasOwn(mock, 'locator')) {
            return { locator: zLocator(matchId), ...mock };
          }
          return mock;
        }
        return { ok: true, backendInstance: 'backend-z53b', items: [] };
      }
      const body = JSON.parse(opts.body);
      requests.push(body);
      return { ok: true };
    }
  });

  // 1 & 7. 正文之间正确插入工具行，及 completed/error/unknown 状态文案
  zHistoryMock = {
    ok: true,
    sessionId: 'native-Z-1',
    messages: [
      { role: 'user', text: '问题1', messageId: 'm-u1' },
      { role: 'assistant', text: '回答1', messageId: 'm-a1' }
    ],
    truncated: false,
    toolSummary: {
      items: [
        { toolName: 'read', status: 'completed', source: 'confirmed', messagePosition: 1 },
        { toolName: 'bash', status: 'error', source: 'confirmed', messagePosition: 1 },
        { toolName: 'write', status: 'unknown', source: 'unconfirmed', messagePosition: 1 }
      ],
      returned: 3, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: true
    }
  };
  z53bView.show('Z-1');
  btn('打开历史').click();
  await tick();

  const toolRows = () => [...host.querySelectorAll('.rtc-history-tool')];
  const msgRows = () => [...host.querySelectorAll('.rtc-history-message')];
  ok('1. 正文之间正确插入工具行', toolRows().length === 3 && msgRows().length === 2);
  ok('7. completed/error/unknown 状态文案映射准确',
    toolRows()[0].textContent === 'read · 已记录完成' && toolRows()[0].dataset.status === 'completed' &&
    toolRows()[1].textContent === 'bash · 结果报错' && toolRows()[1].dataset.status === 'error' &&
    toolRows()[2].textContent === 'write · 状态未知' && toolRows()[2].dataset.status === 'unknown');
  ok('5. 新版 API 状态行包含只读工具摘要说明及不完整提示',
    stateLine().includes('历史正文与只读工具摘要；不含思考及用量') && stateLine().includes('状态证据不完整'));

  // 2. 多个工具共享一个位置，严格保持后端顺序
  const outputChildren = [...output().children];
  const toolIndices = toolRows().map(r => outputChildren.indexOf(r));
  const u1Index = outputChildren.indexOf(msgRows()[0]);
  const a1Index = outputChildren.indexOf(msgRows()[1]);
  ok('2. 多个工具共享一个位置并保持后端顺序插在正文之间',
    u1Index < toolIndices[0] && toolIndices[0] < toolIndices[1] && toolIndices[1] < toolIndices[2] && toolIndices[2] < a1Index);

  // 3 & 4. messagePosition=0 与 messagePosition=messages.length
  zHistoryMock = {
    ok: true,
    sessionId: 'native-Z-1',
    messages: [
      { role: 'user', text: '首条正文', messageId: 'm-u' },
      { role: 'assistant', text: '末条正文', messageId: 'm-a' }
    ],
    truncated: false,
    toolSummary: {
      items: [
        { toolName: 'find', status: 'completed', source: 'confirmed', messagePosition: 0 },
        { toolName: 'edit', status: 'completed', source: 'confirmed', messagePosition: 2 }
      ],
      returned: 2, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false
    }
  };
  await z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  await tick();

  const currentChildren = [...output().children];
  const headTool = host.querySelector('.rtc-history-tool[data-tool-name="find"]');
  const tailTool = host.querySelector('.rtc-history-tool[data-tool-name="edit"]');
  const currentMsgs = msgRows();
  ok('3. messagePosition=0 插入在首条正文之前', headTool && currentChildren.indexOf(headTool) < currentChildren.indexOf(currentMsgs[0]));
  ok('4. messagePosition=messages.length 插入在正文末尾', tailTool && currentChildren.indexOf(tailTool) > currentChildren.indexOf(currentMsgs[1]));

  // 5. messagePosition=null 放在独立的“位置未确认”只读区域
  zHistoryMock = {
    ok: true,
    sessionId: 'native-Z-1',
    messages: [{ role: 'user', text: '单条正文', messageId: 'm-single' }],
    truncated: false,
    toolSummary: {
      items: [
        { toolName: 'ls', status: 'unknown', source: 'unconfirmed', messagePosition: null }
      ],
      returned: 1, limit: 100, truncated: false, historyTruncated: true, unavailableReason: null, uncertain: true
    }
  };
  await z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  await tick();

  const unconfirmedZone = host.querySelector('.rtc-history-unconfirmed');
  ok('5. messagePosition=null 位于独立的“位置未确认”只读区域',
    unconfirmedZone && unconfirmedZone.textContent.includes('ls · 状态未知') && unconfirmedZone.textContent.includes('位置未确认'));

  // 6. 非法位置安全降级
  zHistoryMock = {
    ok: true,
    sessionId: 'native-Z-1',
    messages: [{ role: 'user', text: '正文', messageId: 'm-valid' }],
    truncated: false,
    toolSummary: {
      items: [
        { toolName: 'grep', status: 'completed', source: 'confirmed', messagePosition: -1 },
        { toolName: 'bash', status: 'completed', source: 'confirmed', messagePosition: 999 },
        { toolName: 'read', status: 'completed', source: 'confirmed', messagePosition: 'not_a_number' }
      ],
      returned: 3, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false
    }
  };
  await z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  await tick();

  const degradedZone = host.querySelector('.rtc-history-unconfirmed');
  ok('6. 非法位置安全降级至未确认区域，正文正常显示',
    msgRows().length === 1 && degradedZone && degradedZone.querySelectorAll('.rtc-history-tool').length === 3);

  // 8. 旧 API 不含 toolSummary
  zHistoryMock = {
    ok: true,
    sessionId: 'native-Z-1',
    messages: [{ role: 'user', text: '旧版问题' }],
    truncated: false
  };
  await z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  await tick();

  ok('8. 旧 API 不含 toolSummary 时保持正文-only 兼容提示且无工具行',
    stateLine().includes('历史只含正文（无工具、思考、用量）') && toolRows().length === 0);

  // 9. 空摘要不产生多余元素
  zHistoryMock = {
    ok: true,
    sessionId: 'native-Z-1',
    messages: [{ role: 'user', text: '仅正文' }],
    truncated: false,
    toolSummary: {
      items: [],
      returned: 0, limit: 100, truncated: false, historyTruncated: false, unavailableReason: 'no_tool_calls', uncertain: false
    }
  };
  await z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  await tick();

  ok('9. 空摘要不产生多余元素，状态行正常',
    toolRows().length === 0 && !host.querySelector('.rtc-history-unconfirmed') &&
    stateLine().includes('历史正文与只读工具摘要；不含思考及用量') && !stateLine().includes('无法解析'));

  // 10. 100项摘要容量边界
  const hundredItems = Array.from({ length: 100 }, (_, i) => ({
    toolName: 'read', status: 'completed', source: 'confirmed', messagePosition: i % 2
  }));
  zHistoryMock = {
    ok: true,
    sessionId: 'native-Z-1',
    messages: [{ role: 'user', text: '轮次1' }, { role: 'assistant', text: '轮次2' }],
    truncated: false,
    toolSummary: {
      items: hundredItems,
      returned: 100, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false
    }
  };
  await z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  await tick();

  ok('10. 100项摘要容量边界正常渲染且数量完全吻合', toolRows().length === 100);

  // 11. 正文800项与摘要100项分别截断
  const eightHundredMessages = Array.from({ length: 800 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant', text: 'msg ' + i, messageId: 'm-' + i, userIndex: i % 2 === 0 ? i / 2 : undefined
  }));
  const hundredTruncatedItems = [
    { toolName: 'read', status: 'completed', source: 'confirmed', messagePosition: null },
    ...Array.from({ length: 99 }, (_, i) => ({
      toolName: 'read', status: 'completed', source: 'confirmed', messagePosition: 701 + i
    }))
  ];
  zHistoryMock = {
    ok: true,
    sessionId: 'native-Z-1',
    messages: eightHundredMessages,
    truncated: true,
    toolSummary: {
      items: hundredTruncatedItems,
      returned: 100, limit: 100, truncated: true, historyTruncated: true, unavailableReason: null, uncertain: true
    }
  };
  await z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  await tick();

  ok('11. 正文800项截断与摘要100项截断并存时提示清晰且未确认区域正常隔离',
    msgRows().length === 800 && toolRows().length === 100 &&
    stateLine().includes('800 条（仅显示最近部分）') && stateLine().includes('仅显示部分工具') &&
    Boolean(host.querySelector('.rtc-history-unconfirmed')));

  // 12 & 13. 历史搜索按 messageId 与 userIndex 精确定位，不受插入的工具行干扰
  let scrolledElements = [];
  const origScrollIntoView = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (opts) {
    scrolledElements.push(this);
  };
  try {
    zHistoryMock = {
      ok: true,
      sessionId: 'native-Z-1',
      messages: [
        { role: 'user', text: '搜索问', messageId: 'search-u', userIndex: 0 },
        { role: 'assistant', text: '搜索答', messageId: 'search-a' }
      ],
      truncated: false,
      toolSummary: {
        items: [
          { toolName: 'read', status: 'completed', source: 'confirmed', messagePosition: 0 },
          { toolName: 'bash', status: 'completed', source: 'confirmed', messagePosition: 1 },
          { toolName: 'write', status: 'completed', source: 'confirmed', messagePosition: 2 }
        ],
        returned: 3, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false
      }
    };
    scrolledElements = [];
    await z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' }, { messageId: 'search-a' });
    await tick();

    ok('12. 历史搜索按 messageId 精确定位到正文行而非工具行',
      scrolledElements.length === 1 && scrolledElements[0].dataset.historyMessageId === 'search-a' &&
      scrolledElements[0].classList.contains('rtc-history-message'));

    scrolledElements = [];
    await z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' }, { userIndex: 0 });
    await tick();

    ok('13. 历史搜索按 userIndex 精确定位到正文行而非工具行',
      scrolledElements.length === 1 && scrolledElements[0].dataset.historyUserIndex === '0' &&
      scrolledElements[0].classList.contains('rtc-history-message'));
  } finally {
    dom.window.HTMLElement.prototype.scrollIntoView = origScrollIntoView;
  }

  // 14. A 请求迟到不能覆盖 B
  let finishGateA;
  const gateAPromise = new Promise(r => { finishGateA = r; });
  zHistoryMock = url => {
    if (url.includes('conversationId=Z-1')) return gateAPromise;
    return {
      ok: true,
      sessionId: 'native-Z-2',
      messages: [{ role: 'user', text: 'B正文' }],
      truncated: false,
      toolSummary: { items: [{ toolName: 'find', status: 'completed', source: 'confirmed', messagePosition: 0 }], returned: 1, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false }
    };
  };
  z53bView.show('Z-1');
  const aPromise = z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  z53bView.show('Z-2');
  await z53bView.openHistory({ conversationId: 'Z-2', nativeSessionId: 'native-Z-2', projectId: 'p-z53b', workspaceId: 'ws-Z-2', workspaceEpoch: 'epoch-1' });
  await tick();

  ok('切到 B 显示 B 自己的历史与工具', toolRows().length === 1 && toolRows()[0].dataset.toolName === 'find');
  finishGateA({
    ok: true,
    sessionId: 'native-Z-1',
    messages: [{ role: 'user', text: 'A正文' }],
    truncated: false,
    toolSummary: { items: [{ toolName: 'bash', status: 'completed', source: 'confirmed', messagePosition: 0 }], returned: 1, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false }
  });
  await aPromise;
  await tick();

  ok('14. A 请求迟到不覆盖当前会话 B 的工具摘要与正文',
    toolRows().length === 1 && toolRows()[0].dataset.toolName === 'find' && output().textContent.includes('B正文'));

  // 15. 同一会话较旧响应不能覆盖新响应（代次保护）
  let finishOld, finishNew;
  const pOld = new Promise(r => { finishOld = r; });
  const pNew = new Promise(r => { finishNew = r; });
  let reqCount = 0;
  zHistoryMock = () => {
    reqCount++;
    return reqCount === 1 ? pOld : pNew;
  };
  z53bView.show('Z-1');
  const call1 = z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  await tick();

  // 会话状态更新使代次推进且允许新请求
  seedRuntimeSnapshot({ backendInstance: 'backend-z53b', items: [
    { conversationId: 'Z-1', nativeSessionId: 'native-Z-1', workspace: { projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' }, owner: null, lifecycle: 'dormant', activity: 'idle', revision: 2 },
    { conversationId: 'Z-2', nativeSessionId: 'native-Z-2', workspace: { projectId: 'p-z53b', workspaceId: 'ws-Z-2', workspaceEpoch: 'epoch-1' }, owner: null, lifecycle: 'dormant', activity: 'idle', revision: 1 },
    { conversationId: 'Z-LIVE', nativeSessionId: 'native-Z-LIVE', workspace: { projectId: 'p-z53b', workspaceId: 'ws-Z-LIVE', workspaceEpoch: 'epoch-1' }, owner: z53bOwner('Z-LIVE'), lifecycle: 'ready', activity: 'idle', revision: 1 }
  ] });
  await tick();

  const call2 = z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  await tick();

  finishNew({
    ok: true, sessionId: 'native-Z-1',
    messages: [{ role: 'user', text: '新响应' }],
    truncated: false,
    toolSummary: { items: [{ toolName: 'write', status: 'completed', messagePosition: 0 }], returned: 1, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false }
  });
  await call2; await tick();
  ok('新响应正常呈现', toolRows()[0]?.dataset.toolName === 'write');

  finishOld({
    ok: true, sessionId: 'native-Z-1',
    messages: [{ role: 'user', text: '旧响应' }],
    truncated: false,
    toolSummary: { items: [{ toolName: 'read', status: 'completed', messagePosition: 0 }], returned: 1, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false }
  });
  await call1; await tick();
  ok('15. 同一会话较旧响应因代次被丢弃，不覆盖新响应',
    toolRows()[0]?.dataset.toolName === 'write' && output().textContent.includes('新响应'));

  // 16. locator 变化拒绝显示旧摘要
  zHistoryMock = {
    ok: true, sessionId: 'native-Z-1',
    locator: { conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-DIFF' },
    messages: [{ role: 'user', text: '陈旧定位' }],
    truncated: false,
    toolSummary: { items: [{ toolName: 'grep', status: 'completed', messagePosition: 0 }], returned: 1, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false }
  };
  await z53bView.openHistory({ conversationId: 'Z-1', nativeSessionId: 'native-Z-1', projectId: 'p-z53b', workspaceId: 'ws-Z-1', workspaceEpoch: 'epoch-1' });
  await tick();

  ok('16. locator 变化拒绝显示旧摘要并给出 notice',
    toolRows().length === 0 && host.querySelector('.rtc-notice').textContent.includes('会话历史身份已变化'));

  // 17. 返回实时会话后不残留历史工具行
  z53bView.show('Z-LIVE');
  zHistoryMock = {
    ok: true, sessionId: 'native-Z-LIVE',
    messages: [{ role: 'user', text: 'LIVE历史' }],
    truncated: false,
    toolSummary: { items: [{ toolName: 'bash', status: 'completed', messagePosition: 0 }], returned: 1, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false }
  };
  await z53bView.openHistory(zLocator('Z-LIVE'));
  await tick();
  ok('LIVE 会话已显示历史工具行', toolRows().length === 1);
  btn('返回实时会话').click();
  await tick();
  ok('17. 返回实时会话后历史工具行与未确认区域完全清除',
    toolRows().length === 0 && !host.querySelector('.rtc-history-unconfirmed') && output().textContent === '等待任务');

  // 18. 显式恢复后不继承陈旧的历史摘要
  z53bView.show('Z-1');
  zHistoryMock = {
    ok: true, sessionId: 'native-Z-1',
    messages: [{ role: 'user', text: '待恢复历史' }],
    truncated: false,
    toolSummary: { items: [{ toolName: 'read', status: 'completed', messagePosition: 0 }], returned: 1, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false }
  };
  btn('打开历史').click();
  await tick();
  ok('恢复前历史工具已呈现', toolRows().length === 1);
  requests.length = 0;
  btn('恢复会话').click();
  await tick();
  ok('18. 显式恢复会话发起了 resume 且历史摘要被清空',
    requests.length === 1 && requests[0].action === 'resume' && toolRows().length === 0);

  // 19. 恶意工具名称或状态无法注入 HTML
  z53bView.show('Z-2');
  zHistoryMock = {
    ok: true, sessionId: 'native-Z-2',
    messages: [{ role: 'user', text: '注入测试' }],
    truncated: false,
    toolSummary: {
      items: [
        { toolName: '<img src=x onerror=alert(1)>', status: '<script>alert(2)</script>', messagePosition: 0 }
      ],
      returned: 1, limit: 100, truncated: false, historyTruncated: false, unavailableReason: null, uncertain: false
    }
  };
  btn('打开历史').click();
  await tick();
  ok('19. 恶意工具名称及状态转义为纯文本，无 HTML 标签注入',
    host.querySelector('img, script') === null && toolRows().length === 1 &&
    toolRows()[0].textContent.includes('<img src=x onerror=alert(1)>'));

  // 20. 只读历史操作绝不调用工具、审批或 prompt
  requests.length = 0;
  ok('只读历史下发送按钮与输入框禁用', btn('发送').disabled && input().disabled);
  toolRows()[0]?.click();
  await tick();
  ok('20. 只读历史界面交互绝不产生工具、审批或 prompt 动作', requests.length === 0);

  z53bView.dispose();

  console.log(`Runtime conversation: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
