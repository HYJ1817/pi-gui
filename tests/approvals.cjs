/* P19 离线契约：approval 模型 / 统一确认 foundation / 能力探测 / 回归。
 *
 * 完全离线：不装任何 Extension、不 spawn pi、不读真实 ~/.pi、不联网、不执行 pi 代码。
 * 需要的只是 public/index.html 里那两个真实弹层（#modal / #confirmLayer）。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let count = 0;
function check(name, fn) { fn(); count++; console.log('  ok  ' + name); }

(async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://127.0.0.1/' });
  global.document = dom.window.document;
  global.window = dom.window;
  global.navigator = dom.window.navigator;

  /* 捕获出站 RPC 命令：allow/deny 必须是明确的 extension_ui_response，
   * 不是「发一条普通聊天文本」。 */
  const commands = [];
  const fetchStub = async (url, opts) => {
    if (String(url).endsWith('/api/command')) {
      /* sendJSON 的 body 就是那条 RPC 命令本身（api.js 里 opts.body = JSON.stringify(body)）。 */
      try { commands.push(JSON.parse(opts.body)); } catch { /* 忽略 */ }
      return { json: async () => ({ ok: true }) };
    }
    return { json: async () => ({ ok: false }) };
  };
  global.fetch = fetchStub;
  dom.window.fetch = fetchStub;

  const model = await import('../public/approval-model.js');
  const approval = await import('../public/approval.js');
  const { S } = await import('../public/state.js');
  const { confirmModal, dismissConfirm } = await import('../public/ui/modal.js');

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const layer = () => document.getElementById('confirmLayer');
  const card = () => document.getElementById('confirmCard');
  const modalLayer = () => document.getElementById('modal');
  const modalCard = () => document.getElementById('modalCard');
  const lastCommand = () => commands[commands.length - 1];
  /* 决定必须是明确的 extension_ui_response（sendCommand 会附上 __bridgeRun，
   * 那是传输层字段，协议字段单独断言）。 */
  const assertCommand = (id, fields) => {
    const cmd = lastCommand();
    assert.equal(cmd.type, 'extension_ui_response');
    assert.equal(cmd.id, id);
    for (const [k, v] of Object.entries(fields)) assert.equal(cmd[k], v, k);
  };
  const request = (over = {}) => ({
    type: 'extension_ui_request', id: 'r-' + Math.random().toString(36).slice(2),
    method: 'confirm', title: 'Allow dangerous command?', message: 'rm -rf /tmp/demo', ...over,
  });
  const buttonByText = (scope, text) => [...scope.querySelectorAll('button')].find((b) => b.textContent === text);

  S.bridgeRun = 1;
  S.workspaceGeneration = 0;
  S.switching = false;
  S.bridgeState = 'ready';

  /* ---------- 模型：只信真实字段 ---------- */
  check('dialog kinds are the four protocol methods', () => assert.deepEqual([...model.APPROVAL_KINDS], ['select', 'confirm', 'input', 'editor']));
  check('fire-and-forget methods are not approvals', () => { for (const m of ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']) assert.equal(model.isDialogRequest({ type: 'extension_ui_request', method: m }), false); });
  check('dialog request is an approval', () => assert.equal(model.isDialogRequest(request()), true));
  check('missing id is refused (no identity, no dialog)', () => assert.equal(model.normalizeApprovalRequest({ type: 'extension_ui_request', method: 'confirm' }, S), null));
  check('unknown method is refused', () => assert.equal(model.normalizeApprovalRequest({ type: 'extension_ui_request', id: 'x', method: 'custom' }, S), null));
  const normalized = model.normalizeApprovalRequest(request({ id: 'n1', timeout: 5000 }), S);
  check('normalized keeps real fields', () => { assert.equal(normalized.requestId, 'n1'); assert.equal(normalized.kind, 'confirm'); assert.equal(normalized.title, 'Allow dangerous command?'); assert.equal(normalized.timeout, 5000); assert.equal(normalized.status, 'pending'); });
  check('no structured scope -> null', () => assert.equal(normalized.scope, null));
  check('no structured action -> null', () => assert.equal(normalized.action, null));
  check('risk is unknown, never guessed from text', () => assert.equal(normalized.risk, 'unknown'));
  check('source is the extension channel', () => assert.equal(normalized.source, 'pi-extension'));
  check('no persistent decision without a persistence protocol', () => assert.equal(model.supportsPersistentDecision(), false));
  check('title and message are bounded', () => {
    const big = model.normalizeApprovalRequest(request({ id: 'n2', title: 'T'.repeat(10000), message: 'M'.repeat(10000) }), S);
    assert.ok(big.title.length <= 200 && big.message.length <= 600);
  });
  check('options are strings only, deduped and bounded', () => {
    const n = model.normalizeApprovalRequest(request({ id: 'n3', method: 'select', options: ['Allow', 'Allow', 'Block', 42, { a: 1 }, 'X'.repeat(500)] }), S);
    assert.deepEqual(n.options, ['Allow', 'Block', 'X'.repeat(80)]);
  });
  check('non-select keeps no options', () => assert.deepEqual(model.normalizeApprovalRequest(request({ id: 'n4', options: ['Allow'] }), S).options, []));
  check('timeout must be a positive finite number', () => assert.equal(model.normalizeApprovalRequest(request({ id: 'n5', timeout: 'soon' }), S).timeout, null));
  check('editor prefill only for editor', () => {
    assert.equal(model.normalizeApprovalRequest(request({ id: 'n6', method: 'editor', prefill: 'line1' }), S).prefill, 'line1');
    assert.equal(model.normalizeApprovalRequest(request({ id: 'n7', method: 'input', prefill: 'line1' }), S).prefill, '');
  });
  check('unknown extra fields are not projected', () => {
    const n = model.normalizeApprovalRequest(request({
      id: 'n8', env: 'MARKER_ENV', token: 'MARKER_TOKEN', command: 'MARKER_COMMAND',
      rawArgs: 'MARKER_RAW', authorization: 'MARKER_AUTH', cookie: 'MARKER_COOKIE',
    }), S);
    const json = JSON.stringify(n);
    assert.ok(!/MARKER_/.test(json), json);
  });
  check('confirm payloads', () => { assert.deepEqual(model.decidePayload('confirm', 'allow'), { confirmed: true }); assert.deepEqual(model.decidePayload('confirm', 'deny'), { confirmed: false }); assert.deepEqual(model.decidePayload('confirm', 'cancel'), { cancelled: true }); });
  check('value payloads', () => { assert.deepEqual(model.decidePayload('select', 'value', 'Allow'), { value: 'Allow' }); assert.deepEqual(model.decidePayload('input', 'value', 'hi'), { value: 'hi' }); assert.deepEqual(model.decidePayload('editor', 'cancel'), { cancelled: true }); });
  check('status for decision', () => { assert.equal(model.statusForDecision('confirm', 'allow'), 'allowed'); assert.equal(model.statusForDecision('confirm', 'deny'), 'denied'); assert.equal(model.statusForDecision('input', 'value'), 'answered'); assert.equal(model.statusForDecision('input', 'cancel'), 'cancelled'); });
  check('summary has no payload beyond title', () => assert.equal(model.approvalSummary({ kind: 'confirm', title: 'Allow?' }), 'Pi Extension · confirm · Allow?'));

  /* ---------- 展示 / 决定 ---------- */
  const r1 = request({ id: 'c1' });
  approval.observeApprovalEvent(r1, S);
  check('confirm request opens the shared confirm layer', () => assert.equal(layer().hidden, false));
  check('card shows extension text and one-shot note', () => {
    const text = card().textContent;
    assert.ok(text.includes('Allow dangerous command?') && text.includes('rm -rf /tmp/demo'));
    assert.ok(text.includes('允许一次') && text.includes('拒绝'));
    assert.ok(text.includes('一次性决定'));
    assert.ok(text.includes('来源：Pi Extension'));
  });
  check('no "always allow" button exists', () => {
    const labels = [...card().querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(labels, ['拒绝', '允许一次']);
    assert.ok(!labels.some((l) => /总是|始终|作用域|永久/.test(l)));
  });
  buttonByText(card(), '允许一次').click();
  await tick();
  check('allow goes out as extension_ui_response', () => assertCommand('c1', { confirmed: true }));
  check('allow settles the request', () => {
    const snap = approval.approvalSnapshot();
    assert.equal(snap.pending.length, 0);
    assert.deepEqual(snap.settled.find((s) => s.requestId === 'c1'), { requestId: 'c1', status: 'allowed' });
  });
  check('allow closes the layer', () => assert.equal(layer().hidden, true));

  approval.observeApprovalEvent(request({ id: 'c2' }), S);
  buttonByText(card(), '拒绝').click();
  await tick();
  check('deny goes out as confirmed:false', () => assertCommand('c2', { confirmed: false }));
  check('deny settles as denied', () => assert.equal(approval.approvalSnapshot().settled.find((s) => s.requestId === 'c2').status, 'denied'));

  approval.observeApprovalEvent(request({ id: 'c3' }), S);
  const second = confirmModal({ title: 'x' });
  await tick();
  check('a second confirm dismisses the first (fail-closed)', () => assert.equal(approval.approvalSnapshot().settled.find((s) => s.requestId === 'c3').status, 'denied'));
  buttonByText(card(), '取消').click();
  await second;

  /* ---------- 重放 / 重复 ---------- */
  const replay = request({ id: 'rep1' });
  approval.observeApprovalEvent(replay, S);
  const before = commands.length;
  approval.observeApprovalEvent(replay, S);
  check('duplicate while pending does not open a second dialog', () => assert.equal(approval.approvalSnapshot().pending.length, 1));
  buttonByText(card(), '拒绝').click();
  await tick();
  check('duplicate caused no extra command', () => assert.equal(commands.length, before + 1));
  approval.observeApprovalEvent(replay, S);
  check('settled request is never re-opened (SSE replay)', () => {
    assert.equal(layer().hidden, true);
    assert.equal(approval.approvalSnapshot().pending.length, 0);
  });

  /* ---------- 陈旧守卫 ---------- */
  S.workspaceGeneration = 4;
  approval.observeApprovalEvent(request({ id: 'stale-gen' }), { workspaceGeneration: 3, bridgeRun: 1 });
  check('stale workspace generation is dropped', () => assert.equal(approval.approvalSnapshot().pending.length, 0));
  S.bridgeRun = 7;
  approval.observeApprovalEvent(request({ id: 'stale-run' }), { workspaceGeneration: 4, bridgeRun: 6 });
  check('stale bridge run is dropped', () => assert.equal(approval.approvalSnapshot().pending.length, 0));
  S.switching = true;
  approval.observeApprovalEvent(request({ id: 'switching' }), S);
  check('during workspace switch nothing is shown', () => assert.equal(approval.approvalSnapshot().pending.length, 0));
  S.switching = false;

  /* ---------- 生命周期：重启 / Stop / 超时 ---------- */
  approval.observeApprovalEvent(request({ id: 'br1' }), S);
  const beforeBridge = commands.length;
  approval.observeApprovalEvent({ type: 'bridge_status', state: 'restarting' }, S);
  check('bridge restart expires pending', () => assert.equal(approval.approvalSnapshot().pending.length, 0));
  check('bridge restart does not answer a dead process', () => assert.equal(commands.length, beforeBridge));
  check('bridge restart closes the card', () => assert.equal(layer().hidden, true));

  approval.observeApprovalEvent(request({ id: 'stop1' }), S);
  approval.cancelPendingApprovals();
  check('Stop cancels pending fail-closed', () => assertCommand('stop1', { cancelled: true }));
  check('Stop leaves nothing pending', () => assert.equal(approval.approvalSnapshot().pending.length, 0));
  check('Stop closes the card', () => assert.equal(layer().hidden, true));

  approval.observeApprovalEvent(request({ id: 'to1', timeout: 40 }), S);
  const beforeTimeout = commands.length;
  check('timeout request is shown with its deadline', () => assert.ok(card().textContent.includes('秒后按默认值处理')));
  await new Promise((r) => setTimeout(r, 140));
  check('timeout expires locally instead of guessing', () => {
    assert.equal(approval.approvalSnapshot().pending.length, 0);
    assert.equal(approval.approvalSnapshot().settled.find((s) => s.requestId === 'to1').status, 'expired');
  });
  check('timeout sends no answer (Pi already resolved it)', () => assert.equal(commands.length, beforeTimeout));
  check('timeout removes the card', () => assert.equal(layer().hidden, true));

  /* ---------- select / input / editor ---------- */
  approval.observeApprovalEvent(request({ id: 'sel1', method: 'select', title: 'Pick', options: ['Allow', 'Block'] }), S);
  check('select uses the modal layer with real options', () => {
    assert.equal(modalLayer().hidden, false);
    assert.ok(buttonByText(modalCard(), 'Allow') && buttonByText(modalCard(), 'Block'));
  });
  buttonByText(modalCard(), 'Allow').click();
  await tick();
  check('select answers with the chosen value', () => assertCommand('sel1', { value: 'Allow' }));
  check('select settles as answered', () => assert.equal(approval.approvalSnapshot().settled.find((s) => s.requestId === 'sel1').status, 'answered'));

  approval.observeApprovalEvent(request({ id: 'in1', method: 'input', title: 'Value?', placeholder: 'type…' }), S);
  check('input keeps the placeholder', () => assert.equal(modalCard().querySelector('input').placeholder, 'type…'));
  modalCard().querySelector('input').value = 'hello';
  buttonByText(modalCard(), '提交').click();
  await tick();
  check('input answers with the typed value', () => assertCommand('in1', { value: 'hello' }));

  approval.observeApprovalEvent(request({ id: 'ed1', method: 'editor', title: 'Edit', prefill: 'line-1' }), S);
  check('editor prefills a textarea', () => assert.equal(modalCard().querySelector('textarea').value, 'line-1'));
  buttonByText(modalCard(), '取消').click();
  await tick();
  check('editor cancel answers cancelled', () => assertCommand('ed1', { cancelled: true }));
  check('editor cancel settles as cancelled', () => assert.equal(approval.approvalSnapshot().settled.find((s) => s.requestId === 'ed1').status, 'cancelled'));

  /* ---------- 恶意输入 ---------- */
  const hostile = request({ id: 'h1', title: '<img onerror="evil()">', message: '<script>bad()</script>', token: 'MARKER_TOKEN', env: 'MARKER_ENV' });
  approval.observeApprovalEvent(hostile, S);
  check('hostile HTML is inert in the card', () => {
    assert.equal(card().querySelector('img'), null);
    assert.equal(card().querySelector('script'), null);
  });
  check('hostile extra fields never reach the DOM', () => assert.ok(!/MARKER_/.test(card().outerHTML)));
  buttonByText(card(), '拒绝').click();
  await tick();
  check('malformed options do not break select', () => {
    approval.observeApprovalEvent(request({ id: 'h2', method: 'select', options: 'not-an-array' }), S);
    assert.equal(modalLayer().hidden, false);
    buttonByText(modalCard(), '取消').click();
  });
  await tick();
  check('unknown event types are ignored', () => {
    approval.observeApprovalEvent({ type: 'message_update' }, S);
    approval.observeApprovalEvent({ type: 'extension_ui_request', id: 'x', method: 'notify' }, S);
    assert.equal(approval.approvalSnapshot().pending.length, 0);
  });

  /* ---------- 统一确认 foundation 回归 ---------- */
  const pendingConfirm = confirmModal({ title: '普通确认' });
  dismissConfirm();
  check('dismissConfirm closes like a cancel', async () => assert.equal(await pendingConfirm, false));
  check('confirmModal still returns true on primary', async () => { const p = confirmModal({ title: 'x' }); buttonByText(document.getElementById('confirmCard'), '确认').click(); assert.equal(await p, true); });
  const dangerPromise = confirmModal({ title: '危险', danger: true });
  check('danger confirm has no primary shortcut on Enter', () => assert.ok(document.getElementById('confirmCard').querySelector('.btn.danger')));
  buttonByText(document.getElementById('confirmCard'), '取消').click();
  await dangerPromise;

  /* ---------- Extensions 页能力块：unsupported 必须说清、且没有假按钮 ---------- */
  const box = document.createElement('section');
  document.body.appendChild(box);
  approval.renderApprovalSetup(box, {
    piVersion: '0.87.0',
    checks: {
      toolCallHook: { supported: true, evidence: 'types.d.ts:889 「block?: boolean」' },
      uiPromptDialog: { supported: true, evidence: 'rpc.md:1190 「block until the client sends back…」' },
      coreApproval: { supported: false, evidence: 'usage.md:150 「does not include … permission popups」' },
      customUiOverRpc: { supported: false, evidence: 'rpc-mode.js:152 「Custom UI not supported in RPC mode」' },
    },
  });
  check('capability block reports supported and unsupported', () => {
    const text = box.textContent;
    assert.ok(text.includes('tool_call hook）') && text.includes('：是'));
    assert.ok(text.includes('Pi 核心自带审批弹窗 / 全局权限闸门：否'));
    assert.ok(text.includes('ctx.ui.custom() 可用：否'));
    assert.ok(text.includes('pi 0.87.0'));
  });
  check('capability block states the real boundary', () => assert.ok(box.textContent.includes('不是 OS sandbox')));
  check('capability block offers no Allow button', () => assert.deepEqual([...box.querySelectorAll('button')].map((b) => b.textContent), []));
  approval.renderApprovalSetup(box, null);
  check('unknown capability is not dressed up as protection', () => {
    assert.ok(box.textContent.includes('未知'));
    assert.ok(box.textContent.includes('不宣称任何已具备的拦截能力'));
    assert.deepEqual([...box.querySelectorAll('button')].map((b) => b.textContent), []);
  });

  /* ---------- 后端能力探测（fixture 世界） ---------- */
  const { probeApprovalSupport } = await import('../server/approval-probe.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-approval-'));
  const pkgDir = path.join(root, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const write = (rel, text) => { const f = path.join(pkgDir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  write('package.json', JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.87.0' }));
  write('docs/rpc.md', '# RPC\nDialog methods … emit an `extension_ui_request` and block until the client sends back an `extension_ui_response` with the matching `id`.\n');
  write('docs/extensions.md', '# Extensions\nFired after `tool_execution_start`, before the tool executes. **Can block.**\n');
  write('docs/usage.md', 'It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode.\n');
  write('dist/modes/rpc/rpc-mode.js', 'async custom() {\n // Custom UI not supported in RPC mode\n return undefined;\n}\n');
  write('dist/core/extensions/types.d.ts', 'export interface ToolCallEventResult {\n  block?: boolean;\n}\n');
  const report = probeApprovalSupport({ env: { APPDATA: root }, piBin: '' });
  check('probe finds the tool_call block contract', () => { assert.equal(report.checks.toolCallHook.supported, true); assert.ok(report.checks.toolCallHook.evidence.includes('types.d.ts')); });
  check('probe finds the blocking dialog contract', () => { assert.equal(report.checks.uiPromptDialog.supported, true); assert.ok(report.checks.uiPromptDialog.evidence.includes('rpc.md')); });
  check('probe reports core has no built-in approval', () => { assert.equal(report.checks.coreApproval.supported, false); assert.ok(report.checks.coreApproval.evidence.includes('usage.md')); });
  check('probe reports custom() degraded over RPC', () => assert.equal(report.checks.customUiOverRpc.supported, false));
  check('probe reports the pi version it read', () => assert.equal(report.piVersion, '0.87.0'));
  check('probe never leaks the package path', () => assert.ok(!JSON.stringify(report).includes(root)));
  const empty = probeApprovalSupport({ env: { APPDATA: path.join(root, 'nowhere') }, piBin: '' });
  check('missing pi package stays unknown', () => { for (const c of Object.values(empty.checks)) assert.equal(c.supported, null); });
  fs.rmSync(root, { recursive: true, force: true });

  /* ---------- 回归：其它 feature 不受影响 ---------- */
  const pub = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
  check('approval does not touch tool timeline or adapters', () => {
    const src = pub('approval.js') + pub('approval-model.js');
    assert.doesNotMatch(src, /tool_execution_start|tool_execution_end|memoryActivity|subagentActivity|webActivity/);
  });
  check('approval never parses tool payloads', () => assert.doesNotMatch(pub('approval.js'), /entry\.output|entry\.args|JSON\.parse\(.*content/));
  check('app.js no longer implements its own dialog modals', () => {
    const app = pub('app.js');
    assert.doesNotMatch(app, /function uiConfirm|function uiSelect|function uiInput/);
  });
  check('only one confirmation surface is used for approvals', () => {
    assert.match(pub('approval.js'), /confirmModal\(/);
    assert.doesNotMatch(pub('app.js'), /respond\(evt\.id/);
  });
  check('every captured decision was an extension_ui_response', () => assert.ok(commands.every((c) => c.type === 'extension_ui_response')));
  check('Session Search untouched', () => assert.doesNotMatch(pub('session-search.js'), /approval/i));
  check('Planner untouched', () => {
    const files = fs.readdirSync(path.join(__dirname, '../public')).filter((n) => n.startsWith('planner') && n.endsWith('.js'));
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../public', f), 'utf8'), /approval/i);
  });

  dom.window.close();
  console.log(`\n${count}/${count} 通过`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
