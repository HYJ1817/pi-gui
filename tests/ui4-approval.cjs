/* UI-4B：审批 / 确认交互的专项契约与真实渲染测试。
 *
 * ---------- 测什么 ----------
 *
 * 用**真实**的 public/index.html、public/approval.js、public/ui/modal.js 和
 * public/approval-model.js，在 jsdom 里跑完整审批生命周期：
 *   展示内容、允许 / 拒绝 / 取消、重复提交、迟到结果、工作区 / 会话切换、
 *   Stop、空字段、恶意 HTML、长命令、焦点与键盘、投递失败与重试、
 *   多层弹窗、select/input/editor、Runtime 展示接口、样式表边界。
 *
 * ---------- 不测什么 ----------
 *
 * jsdom 不做布局、也不套用外部样式表 —— 排版、配色、窄屏、右栏遮挡、
 * reduced-motion 由 `--electron` 模式在真实 Electron 里截图验证。
 *
 * 数据全是 fixture：不发真实网络、不启 Pi、不碰用户数据。
 * 审批应答走真实 sendCommand（fetch 被替换为可控桩），不绕过权限检查。
 *
 * 用法：
 *   node tests/ui4-approval.cjs             # jsdom 契约
 *   node tests/ui4-approval.cjs --electron  # 额外跑真实 Electron 截图矩阵
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.resolve(__dirname, '../public');
let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; failures.push({ name, error: String(e && e.message || e) }); console.error(' FAIL ' + name + ': ' + (e && e.message || e)); }
}

async function main() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), { url: 'http://127.0.0.1/' });
  global.document = dom.window.document;
  global.window = dom.window;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });

  /* ---------- 可控的 /api/command 桩 ---------- */
  const commands = [];
  let mode = { ok: true };
  let pendingSends = [];
  let sendCount = 0;
  const fetchStub = async (url, opts) => {
    if (String(url).endsWith('/api/command')) {
      sendCount++;
      try { commands.push(JSON.parse(opts.body)); } catch { /* 忽略 */ }
      if (mode.network) throw new Error('fixture network down');
      if (mode.manual) {
        return new Promise((resolve) => pendingSends.push(() => resolve({ json: async () => mode.response || { ok: true } })));
      }
      if (mode.delay) await new Promise((r) => setTimeout(r, mode.delay));
      return { json: async () => mode.response || { ok: true } };
    }
    return { json: async () => ({ ok: false }) };
  };
  global.fetch = fetchStub;
  dom.window.fetch = fetchStub;

  const approval = await import('../public/approval.js');
  const modal = await import('../public/ui/modal.js');
  const { S } = await import('../public/state.js');

  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  const card = () => document.getElementById('confirmCard');
  const layer = () => document.getElementById('confirmLayer');
  const modalCard = () => document.getElementById('modalCard');
  const modalLayer = () => document.getElementById('modal');
  const buttonsOf = (scope = card()) => [...scope.querySelectorAll('.modal-actions button')];
  const buttonByText = (scope, text) => [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
  const lastCommand = () => commands[commands.length - 1];
  const snapshot = () => approval.approvalSnapshot();
  const settledOf = (id) => snapshot().settled.find((s) => s.requestId === id);
  const deliveryOf = (id) => snapshot().deliveries.find((d) => d.requestId === id);
  const request = (over = {}) => ({
    type: 'extension_ui_request',
    id: 'r-' + Math.random().toString(36).slice(2),
    method: 'confirm',
    title: 'Allow dangerous command?',
    message: 'rm -rf /tmp/demo',
    ...over,
  });
  const reset = () => {
    mode = { ok: true };
    pendingSends = [];
    commands.length = 0;
    sendCount = 0;
    S.bridgeRun = 1;
    S.workspaceGeneration = 0;
    S.switching = false;
    S.bridgeState = 'ready';
    approval.expireAll('test-reset');
    modal.dismissConfirm();
    modal.closeModal();
    dom.window.document.getElementById('toasts').replaceChildren();
  };
  const key = (k, opts = {}) => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));

  /* ================= 1. 展示内容：真实操作，不隐藏 ================= */
  reset();
  await check('confirm 请求走统一确认层并显示来源 / 类型', async () => {
    approval.observeApprovalEvent(request({ id: 'show1' }), S);
    assert.equal(layer().hidden, false);
    const text = card().textContent;
    assert.ok(text.includes('Allow dangerous command?'));
    assert.ok(text.includes('rm -rf /tmp/demo'), '真实命令正文必须完整出现');
    assert.ok(text.includes('来源：Pi Extension'));
    assert.ok(text.includes('确认请求'));
    assert.ok(text.includes('一次性决定'));
    assert.ok(text.includes('协议没有「总是允许」'));
  });

  await check('风险只陈述「协议没有结构化字段」，不猜危险等级', async () => {
    const risk = card().querySelector('.ui4-confirm-risk').textContent;
    assert.ok(risk.includes('协议未提供结构化风险信息'));
    assert.ok(!/高危|低危|安全|危险操作/.test(risk.replace('不判断这次操作是否危险', '')), risk);
    assert.equal(approval.approvalCardModel({ requestId: 'm', kind: 'confirm', title: 'x', risk: 'unknown' }).risk, 'unknown');
  });

  await check('确认卡只有一次性两个决定，没有 Always / Bypass / Auto', async () => {
    assert.deepEqual(buttonsOf().map((b) => b.textContent), ['拒绝', '允许一次']);
    const labels = [...card().querySelectorAll('button')].map((b) => b.textContent).join('|');
    assert.ok(!/总是|始终|永久|作用域|绕过|自动批准|Auto|Always|Bypass/i.test(labels), labels);
  });

  await check('长命令完整渲染，不在 UI 层二次截断', async () => {
    approval.expireAll('test');
    const long = 'sudo rm -rf /very/long/path/' + 'segment/'.repeat(60) + ' && echo done';
    approval.observeApprovalEvent(request({ id: 'long1', title: 'L'.repeat(180), message: long }), S);
    const text = card().querySelector('.ui4-confirm-detail-text').textContent;
    assert.equal(text, long);
    assert.ok(text.length > 500);
    assert.ok(card().querySelector('.ui4-confirm-details'), '正文在可滚动容器里');
    approval.expireAll('test');
  });

  await check('空字段使用可读兜底，不渲染 undefined', async () => {
    approval.observeApprovalEvent({ type: 'extension_ui_request', id: 'empty1', method: 'confirm' }, S);
    const text = card().textContent;
    assert.ok(text.includes('Pi Extension 确认请求'));
    assert.ok(!text.includes('undefined'));
    assert.ok(!text.includes('null'));
    approval.expireAll('test');
  });

  await check('恶意 HTML / 额外字段不进 DOM', async () => {
    approval.observeApprovalEvent(request({
      id: 'evil1',
      title: '<img src=x onerror="window.__pwn=1">',
      message: '<script>window.__pwn=2</script><b>bold?</b>',
      token: 'PRIVATE_TOKEN', env: 'PRIVATE_ENV', command: 'PRIVATE_COMMAND',
    }), S);
    assert.equal(card().querySelector('img'), null);
    assert.equal(card().querySelector('script'), null);
    assert.equal(card().querySelector('b'), null, '标签按文本渲染');
    assert.ok(card().textContent.includes('<b>bold?</b>'));
    assert.ok(!/PRIVATE_/.test(card().outerHTML));
    assert.equal(dom.window.__pwn, undefined);
    approval.expireAll('test');
  });

  /* ================= 2. 允许 / 拒绝 / 取消 ================= */
  reset();
  await check('允许一次只发一条 extension_ui_response{confirmed:true}', async () => {
    approval.observeApprovalEvent(request({ id: 'allow1' }), S);
    buttonByText(card(), '允许一次').click();
    await tick(10);
    assert.equal(commands.length, 1);
    assert.equal(lastCommand().type, 'extension_ui_response');
    assert.equal(lastCommand().id, 'allow1');
    assert.equal(lastCommand().confirmed, true);
    assert.equal(settledOf('allow1').status, 'allowed');
    assert.equal(deliveryOf('allow1').outcome, 'sent');
    assert.equal(layer().hidden, true);
  });

  await check('拒绝只发 confirmed:false，不伪装成取消', async () => {
    approval.observeApprovalEvent(request({ id: 'deny1' }), S);
    buttonByText(card(), '拒绝').click();
    await tick(10);
    assert.equal(lastCommand().id, 'deny1');
    assert.equal(lastCommand().confirmed, false);
    assert.equal(lastCommand().cancelled, undefined);
    assert.equal(settledOf('deny1').status, 'denied');
  });

  await check('Esc 发 cancelled:true（fail-closed 的取消）', async () => {
    approval.observeApprovalEvent(request({ id: 'esc1' }), S);
    key('Escape');
    await tick(10);
    assert.equal(lastCommand().id, 'esc1');
    assert.deepEqual(lastCommand().cancelled, true);
    assert.equal(settledOf('esc1').status, 'cancelled');
    assert.equal(layer().hidden, true);
  });

  await check('点遮罩取消同样走协议应答', async () => {
    approval.observeApprovalEvent(request({ id: 'outside1' }), S);
    layer().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick(10);
    assert.equal(lastCommand().id, 'outside1');
    assert.equal(lastCommand().cancelled, true);
    assert.equal(settledOf('outside1').status, 'cancelled');
  });

  /* ================= 3. 重复点击 / 迟到结果 ================= */
  reset();
  await check('提交中重复点击只发一条命令', async () => {
    mode = { manual: true, response: { ok: true } };
    approval.observeApprovalEvent(request({ id: 'dup1' }), S);
    const yes = buttonByText(card(), '允许一次');
    yes.click(); yes.click(); yes.click();
    await tick(5);
    assert.equal(commands.length, 1, '三连击只能有一条应答');
    assert.equal(commands[0].id, 'dup1');
    assert.equal(card().getAttribute('aria-busy'), 'true');
    assert.ok(buttonsOf().every((b) => b.disabled), '提交中所有出口禁用');
    pendingSends.shift()();
    await tick(10);
    assert.equal(settledOf('dup1').status, 'allowed');
    assert.equal(layer().hidden, true);
  });

  await check('提交中 Esc / 点遮罩 / Enter 都不会补发第二条应答', async () => {
    mode = { manual: true, response: { ok: true } };
    commands.length = 0;
    approval.observeApprovalEvent(request({ id: 'dup2' }), S);
    buttonByText(card(), '允许一次').click();
    await tick(5);
    key('Escape');
    layer().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    key('Enter');
    await tick(5);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].confirmed, true);
    pendingSends.shift()();
    await tick(10);
    assert.equal(layer().hidden, true);
    assert.equal(settledOf('dup2').status, 'allowed');
  });

  await check('迟到结果不覆盖已作废状态，也不再弹卡', async () => {
    mode = { manual: true, response: { ok: true } };
    approval.observeApprovalEvent(request({ id: 'late1' }), S);
    buttonByText(card(), '允许一次').click();
    await tick(5);
    /* 应答还在飞的时候切工作区：本地作废，卡片收掉。 */
    S.workspaceGeneration++;
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation'));
    assert.equal(layer().hidden, true, '切换后不能留一张可点的旧卡');
    assert.equal(settledOf('late1').status, 'expired');
    pendingSends.shift()();
    await tick(10);
    assert.equal(settledOf('late1').status, 'expired', '迟到的成功不能把 expired 改成 allowed');
    assert.equal(snapshot().pending.length, 0);
    assert.equal(layer().hidden, true);
  });

  await check('SSE 重放已结算请求不会再次弹卡', async () => {
    mode = { ok: true };
    const replay = request({ id: 'replay1' });
    approval.observeApprovalEvent(replay, S);
    buttonByText(card(), '拒绝').click();
    await tick(10);
    approval.observeApprovalEvent(replay, S);
    assert.equal(layer().hidden, true);
    assert.equal(snapshot().pending.length, 0);
  });

  /* ================= 4. 工作区 / 会话 / Stop ================= */
  reset();
  await check('工作区切换：旧审批本地作废且不发应答', async () => {
    approval.observeApprovalEvent(request({ id: 'ws1' }), S);
    const before = commands.length;
    S.workspaceGeneration++;
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:workspace-generation'));
    await tick(10);
    assert.equal(snapshot().pending.length, 0);
    assert.equal(settledOf('ws1').status, 'expired');
    assert.equal(layer().hidden, true);
    assert.equal(commands.length, before, '旧 workspace 的审批不能向 Pi 发应答');
  });

  await check('会话切换：旧审批本地作废且不发应答', async () => {
    approval.observeApprovalEvent(request({ id: 'ss1' }), S);
    const before = commands.length;
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('pi-gui:session-switch'));
    await tick(10);
    assert.equal(snapshot().pending.length, 0);
    assert.equal(settledOf('ss1').status, 'expired');
    assert.equal(layer().hidden, true);
    assert.equal(commands.length, before);
  });

  await check('卡片残留时点允许：本地作废、不发应答、卡片收掉', async () => {
    /* 模拟「事件没到、但 generation 已经变了」的窗口期：卡片仍在屏幕上。 */
    S.workspaceGeneration++;
    approval.observeApprovalEvent(request({ id: 'stale-click' }), { workspaceGeneration: S.workspaceGeneration - 1, bridgeRun: 1 });
    assert.equal(snapshot().pending.length, 0, '陈旧请求在入口就被丢弃');
    /* 直接构造一条属于旧代的 pending，确认点击时也会被拦下。 */
    S.workspaceGeneration--;
    approval.observeApprovalEvent(request({ id: 'stale-click2' }), S);
    S.workspaceGeneration++;
    const before = commands.length;
    buttonByText(card(), '允许一次').click();
    await tick(10);
    assert.equal(commands.length, before, '陈旧审批不得发出应答');
    assert.equal(settledOf('stale-click2').status, 'expired');
    assert.equal(layer().hidden, true);
  });

  await check('Stop：pending 收到取消、卡片收掉、不留关不掉的卡', async () => {
    approval.observeApprovalEvent(request({ id: 'stop1' }), S);
    approval.cancelPendingApprovals();
    await tick(10);
    assert.equal(lastCommand().id, 'stop1');
    assert.equal(lastCommand().cancelled, true);
    assert.equal(snapshot().pending.length, 0);
    assert.equal(settledOf('stop1').status, 'cancelled');
    assert.equal(layer().hidden, true);
  });

  await check('Stop 打断提交中：不补发取消，卡片仍收掉', async () => {
    mode = { manual: true, response: { ok: true } };
    approval.observeApprovalEvent(request({ id: 'stop2' }), S);
    buttonByText(card(), '允许一次').click();
    await tick(5);
    const before = commands.length;
    approval.cancelPendingApprovals();
    await tick(5);
    assert.equal(commands.length, before, '已经发出的决定不能再补一条取消');
    assert.equal(layer().hidden, true, 'Stop 后不能留一张关不掉的卡');
    pendingSends.shift()();
    await tick(10);
    assert.equal(layer().hidden, true);
    assert.equal(settledOf('stop2').status, 'cancelled');
  });

  await check('超时：卡片收掉、不发应答、状态 expired', async () => {
    approval.observeApprovalEvent(request({ id: 'timeout1', timeout: 40 }), S);
    assert.ok(card().textContent.includes('秒后按默认值处理'));
    const before = commands.length;
    await tick(140);
    assert.equal(snapshot().pending.length, 0);
    assert.equal(settledOf('timeout1').status, 'expired');
    assert.equal(commands.length, before, 'Pi 已按默认值处理，GUI 不再补应答');
    assert.equal(layer().hidden, true);
  });

  await check('桥接重启：本地作废且不向死进程发应答', async () => {
    approval.observeApprovalEvent(request({ id: 'bridge1' }), S);
    const before = commands.length;
    approval.observeApprovalEvent({ type: 'bridge_status', state: 'restarting' }, S);
    await tick(10);
    assert.equal(snapshot().pending.length, 0);
    assert.equal(commands.length, before);
    assert.equal(layer().hidden, true);
  });

  /* ================= 5. 投递失败 / 重试 ================= */
  reset();
  await check('后端拒绝：卡片保留、原因可见、可重试且只重发一次', async () => {
    mode = { response: { ok: false, error: 'stale_approval' } };
    approval.observeApprovalEvent(request({ id: 'fail1' }), S);
    buttonByText(card(), '允许一次').click();
    await tick(10);
    assert.equal(layer().hidden, false, '失败不能悄悄关掉卡片');
    const status = card().querySelector('.ui4-confirm-status');
    assert.equal(status.hidden, false);
    assert.equal(status.dataset.state, 'error');
    assert.ok(status.textContent.includes('没有接受'));
    assert.equal(snapshot().pending.length, 1, '失败后仍在等待用户重试');
    assert.equal(settledOf('fail1'), undefined);
    assert.equal(deliveryOf('fail1').outcome, 'failed');
    assert.ok(buttonsOf().every((b) => !b.disabled), '失败后恢复可点');
    assert.equal(card().getAttribute('aria-busy'), 'false');

    mode = { response: { ok: true } };
    buttonByText(card(), '允许一次').click();
    await tick(10);
    assert.equal(commands.length, 2, '重试是用户的第二次明确点击');
    assert.equal(layer().hidden, true);
    assert.equal(settledOf('fail1').status, 'allowed');
  });

  await check('网络层失败：结果未知，不声称未送达、不重发决定', async () => {
    mode = { network: true };
    approval.observeApprovalEvent(request({ id: 'net1' }), S);
    buttonByText(card(), '允许一次').click();
    await tick(10);
    assert.equal(layer().hidden, false);
    const status = card().querySelector('.ui4-confirm-status').textContent;
    assert.ok(status.includes('未知'), status);
    assert.ok(!status.includes('没有送达'), status);
    assert.ok(!status.includes('已允许'), status);
    assert.equal(deliveryOf('net1').outcome, 'unknown');
    assert.equal(deliveryOf('net1').network, true);
    assert.equal(snapshot().pending.length, 1);
    assert.equal(buttonByText(card(), '允许一次').disabled, true);
    assert.equal(buttonByText(card(), '拒绝').disabled, true);
  });

  await check('失败后用 Esc 取消：取消也走真实投递，成功后收卡', async () => {
    const before = commands.length;
    key('Escape'); await tick(10);
    assert.equal(commands.length, before, '未知投递的 Esc 仅关闭本地提示');
    mode = { response: { ok: false } };
    approval.observeApprovalEvent(request({ id: 'retry-cancel' }), S);
    buttonByText(card(), '允许一次').click();
    await tick(10);
    assert.equal(layer().hidden, false);
    mode = { response: { ok: true } };
    key('Escape');
    await tick(10);
    assert.equal(lastCommand().cancelled, true);
    assert.equal(settledOf('retry-cancel').status, 'cancelled');
    assert.equal(layer().hidden, true);
  });

  /* ================= 6. 焦点 / 键盘 / 多层 ================= */
  reset();
  await check('初始焦点在「拒绝」，Tab / Shift+Tab 在按钮间循环', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    approval.observeApprovalEvent(request({ id: 'focus1' }), S);
    assert.equal(document.activeElement, buttonByText(card(), '拒绝'));
    key('Tab', { shiftKey: true });
    assert.equal(document.activeElement, buttonByText(card(), '稍后处理'), 'Shift+Tab 从第一个绕到最后一个');
    key('Tab');
    assert.equal(document.activeElement, buttonByText(card(), '拒绝'), 'Tab 从最后一个绕回第一个');
    buttonByText(card(), '拒绝').click();
    await tick(10);
    assert.equal(document.activeElement, opener, '关闭后焦点回到打开它的元素');
    opener.remove();
  });

  await check('卡片本身获得焦点时 Enter 不会替你允许', async () => {
    approval.observeApprovalEvent(request({ id: 'enter1' }), S);
    card().focus();
    const before = commands.length;
    key('Enter');
    await tick(5);
    assert.equal(commands.length, before, 'Enter 不能触发默认允许');
    assert.equal(layer().hidden, false);
    buttonByText(card(), '拒绝').click();
    await tick(10);
  });

  await check('审批确认卡叠在普通弹层之上，关闭审批不关掉下面的弹层', async () => {
    modal.openModal((node) => { node.textContent = 'unrelated panel'; });
    assert.equal(modalLayer().hidden, false);
    approval.observeApprovalEvent(request({ id: 'layer1' }), S);
    assert.equal(layer().hidden, false);
    buttonByText(card(), '拒绝').click();
    await tick(10);
    assert.equal(layer().hidden, true);
    assert.equal(modalLayer().hidden, false, '下面的弹层必须还在');
    assert.ok(modalCard().textContent.includes('unrelated panel'));
    modal.closeModal();
  });

  await check('审批超时只收自己的卡，不关别人的弹层', async () => {
    modal.openModal((node) => { node.textContent = 'still here'; });
    approval.observeApprovalEvent(request({ id: 'layer2', timeout: 30 }), S);
    await tick(120);
    assert.equal(layer().hidden, true);
    assert.equal(modalLayer().hidden, false);
    assert.ok(modalCard().textContent.includes('still here'));
    modal.closeModal();
  });

  /* ================= 7. select / input / editor ================= */
  reset();
  await check('select：真实选项、选择后只发 value', async () => {
    approval.observeApprovalEvent(request({ id: 'sel1', method: 'select', title: 'Pick', options: ['Allow', 'Block'] }), S);
    assert.equal(modalLayer().hidden, false);
    assert.equal(modalCard().getAttribute('data-surface'), 'approval');
    assert.ok(buttonByText(modalCard(), 'Allow') && buttonByText(modalCard(), 'Block'));
    buttonByText(modalCard(), 'Allow').click();
    await tick(10);
    assert.equal(lastCommand().id, 'sel1');
    assert.equal(lastCommand().value, 'Allow');
    assert.equal(settledOf('sel1').status, 'answered');
    assert.equal(modalLayer().hidden, true);
  });

  await check('select 提交中重复点击只发一次', async () => {
    mode = { manual: true, response: { ok: true } };
    commands.length = 0;
    approval.observeApprovalEvent(request({ id: 'sel2', method: 'select', title: 'Pick', options: ['A', 'B'] }), S);
    const a = buttonByText(modalCard(), 'A');
    a.click(); a.click();
    await tick(5);
    assert.equal(commands.length, 1);
    pendingSends.shift()();
    await tick(10);
    assert.equal(modalLayer().hidden, true);
  });

  await check('select 投递失败：卡片保留、可重试', async () => {
    mode = { response: { ok: false, error: 'stale_approval' } };
    commands.length = 0;
    approval.observeApprovalEvent(request({ id: 'sel3', method: 'select', title: 'Pick', options: ['A'] }), S);
    buttonByText(modalCard(), 'A').click();
    await tick(10);
    assert.equal(modalLayer().hidden, false);
    assert.ok(modalCard().querySelector('.ui4-confirm-status').textContent.includes('没有接受'));
    mode = { response: { ok: true } };
    buttonByText(modalCard(), 'A').click();
    await tick(10);
    assert.equal(commands.length, 2);
    assert.equal(modalLayer().hidden, true);
    assert.equal(settledOf('sel3').status, 'answered');
  });

  await check('input：保留 placeholder，提交真实输入', async () => {
    approval.observeApprovalEvent(request({ id: 'in1', method: 'input', title: 'Value?', placeholder: 'type…' }), S);
    const input = modalCard().querySelector('input');
    assert.equal(input.placeholder, 'type…');
    input.value = 'hello';
    buttonByText(modalCard(), '提交').click();
    await tick(10);
    assert.equal(lastCommand().value, 'hello');
    assert.equal(settledOf('in1').status, 'answered');
  });

  await check('editor：prefill 真实值，取消发 cancelled', async () => {
    approval.observeApprovalEvent(request({ id: 'ed1', method: 'editor', title: 'Edit', prefill: 'line-1' }), S);
    assert.equal(modalCard().querySelector('textarea').value, 'line-1');
    buttonByText(modalCard(), '取消').click();
    await tick(10);
    assert.equal(lastCommand().cancelled, true);
    assert.equal(settledOf('ed1').status, 'cancelled');
  });

  await check('input 的 Esc / 点遮罩走取消且失败时保留卡片', async () => {
    mode = { response: { ok: false } };
    approval.observeApprovalEvent(request({ id: 'in2', method: 'input', title: 'Value?' }), S);
    key('Escape');
    await tick(10);
    assert.equal(modalLayer().hidden, false);
    assert.ok(modalCard().querySelector('.ui4-confirm-status').textContent.includes('没有接受'));
    mode = { response: { ok: true } };
    modalLayer().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await tick(10);
    assert.equal(modalLayer().hidden, true);
    assert.equal(settledOf('in2').status, 'cancelled');
  });

  /* ================= 8. Runtime 展示接口 ================= */
  reset();
  await check('Runtime 接口：确认点击只发一次，成功后不再可点', async () => {
    const row = document.createElement('div');
    row.className = 'rtc-approval';
    document.body.appendChild(row);
    let calls = 0;
    let release;
    const view = approval.renderRuntimeApproval(row, {
      approval: { id: 'rt1', method: 'confirm', title: 'Runtime confirm' },
      respond: () => { calls++; return new Promise((r) => { release = () => r({ ok: true }); }); },
    });
    assert.ok(view);
    assert.equal(row.querySelector('p').textContent, 'Runtime confirm');
    const yes = buttonByText(row, '确认');
    yes.click(); yes.click();
    await tick(5);
    assert.equal(calls, 1, '重复点击只能调用一次 respond');
    assert.equal(row.getAttribute('aria-busy'), 'true');
    release();
    await tick(10);
    assert.equal(row.dataset.state, 'sent');
    assert.ok(row.textContent.includes('应答已交给 Pi'));
    assert.ok([...row.querySelectorAll('button')].every((b) => b.disabled));
    assert.ok(!/总是|Always|Bypass/i.test(row.textContent));
    row.remove();
  });

  await check('Runtime 接口：失败可见并可重试', async () => {
    const row = document.createElement('div');
    row.className = 'runtime-approval';
    document.body.appendChild(row);
    let calls = 0;
    approval.renderRuntimeApproval(row, {
      approval: { id: 'rt2', method: 'confirm', title: 'Fails once' },
      respond: async () => (++calls === 1 ? { ok: false, error: 'stale_approval' } : { ok: true }),
    });
    buttonByText(row, '确认').click();
    await tick(10);
    assert.equal(row.querySelector('.ui4-confirm-status').dataset.state, 'error');
    assert.ok(!buttonByText(row, '确认').disabled, '失败后可重试');
    buttonByText(row, '确认').click();
    await tick(10);
    assert.equal(calls, 2);
    assert.equal(row.dataset.state, 'sent');
    row.remove();
  });

  await check('Runtime 接口：owner 变化返回 null → 明确失效、不伪造取消', async () => {
    const row = document.createElement('div');
    row.className = 'rtc-approval';
    document.body.appendChild(row);
    approval.renderRuntimeApproval(row, {
      approval: { id: 'rt3', method: 'confirm', title: 'Owner changed' },
      respond: async () => null,
    });
    buttonByText(row, '确认').click();
    await tick(10);
    assert.equal(row.dataset.state, 'stale');
    assert.ok(row.textContent.includes('没有发送任何应答'));
    assert.ok([...row.querySelectorAll('button')].every((b) => b.disabled));
    row.remove();
  });

  await check('Runtime 接口：select / input 真实值，恶意标题按文本', async () => {
    const row = document.createElement('div');
    document.body.appendChild(row);
    const sent = [];
    approval.renderRuntimeApproval(row, {
      approval: { id: 'rt4', method: 'select', title: '<img src=x onerror=1>', options: ['A', 'B'] },
      respond: async (payload) => { sent.push(payload); return { ok: true }; },
    });
    assert.equal(row.querySelector('img'), null);
    assert.ok(row.textContent.includes('<img'));
    buttonByText(row, 'B').click();
    await tick(10);
    assert.deepEqual(sent, [{ value: 'B' }]);

    const row2 = document.createElement('div');
    document.body.appendChild(row2);
    const sent2 = [];
    approval.renderRuntimeApproval(row2, {
      approval: { id: 'rt5', method: 'input', title: 'Type' },
      respond: async (payload) => { sent2.push(payload); return { ok: true }; },
    });
    row2.querySelector('textarea').value = 'typed';
    buttonByText(row2, '提交').click();
    await tick(10);
    assert.deepEqual(sent2, [{ value: 'typed' }]);
    row.remove(); row2.remove();
  });

  /* ================= 9. 模型 / 静态边界 ================= */
  await check('approvalCardModel 不发明 scope / action / 持久化', async () => {
    const model = approval.approvalCardModel({ requestId: 'm1', kind: 'confirm', title: 'T', message: 'M', timeout: 5000 });
    assert.equal(model.scope, null);
    assert.equal(model.action, null);
    assert.equal(model.risk, 'unknown');
    assert.equal(model.persistent, false);
    assert.ok(model.context.includes('5 秒后按默认值处理'));
  });

  await check('样式表幂等注入：只有一份，且复用已有 link', async () => {
    const links = [...document.querySelectorAll('link[href$="ui4-approval.css"]')];
    assert.equal(links.length, 1);
    assert.equal(links[0].id, 'ui4-approval-style');
    const again = approval.ensureApprovalStylesheet(document);
    assert.equal(again, links[0]);
    assert.equal([...document.querySelectorAll('link[href$="ui4-approval.css"]')].length, 1);
  });

  await check('CSS 只用 UI-1 语义 token，且覆盖三种审批 DOM', async () => {
    const css = fs.readFileSync(path.join(PUB, 'ui4-approval.css'), 'utf8');
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, '不能出现写死的十六进制颜色');
    assert.doesNotMatch(css, /\brgba?\(/, '不能出现写死的 rgb 颜色');
    const vars = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    assert.ok(vars.length > 20, '确实使用了 token');
    for (const name of vars) assert.ok(name.startsWith('--ui-'), `非 UI-1 token: ${name}`);
    assert.ok(css.includes('.modal-card[data-surface="approval"]'));
    assert.ok(css.includes('.rtc-approval'));
    assert.ok(css.includes('.runtime-approval'));
    assert.ok(css.includes('prefers-reduced-motion'));
    assert.ok(css.includes('overflow-wrap:anywhere') || css.includes('overflow-wrap: anywhere'));
  });

  await check('approval.js 不再 fire-and-forget respond，也不拼 innerHTML', async () => {
    const src = fs.readFileSync(path.join(PUB, 'approval.js'), 'utf8');
    assert.doesNotMatch(src, /from '\.\/rpc\.js'/, '应答投递必须走可观察的 sendCommand');
    assert.doesNotMatch(src, /\.innerHTML\s*=/, '审批内容只能走 textContent');
    assert.match(src, /sendCommand\(\{ type: 'extension_ui_response'/);
  });

  await check('modal.js 默认行为未变：没有 onDecide 时点击即关闭', async () => {
    const decision = modal.confirmModal({ title: '普通确认' });
    buttonByText(document.getElementById('confirmCard'), '确认').click();
    assert.equal(await decision, true);
  });

  await check('modal.js 危险确认仍然禁用 Enter 快捷确认', async () => {
    const p = modal.confirmModal({ title: '危险', danger: true });
    key('Enter');
    assert.equal(layer().hidden, false);
    key('Escape');
    assert.equal(await p, false);
  });

  dom.window.close();
  console.log(`\nui4-approval: ${pass}/${pass + fail} 通过` + (fail ? `, ${fail} 失败` : ''));
  return { pass, fail, failures };
}

/* ================= 真实 Electron 渲染矩阵 =================
 *
 * 由 `node tests/ui4-approval.cjs --electron` 启动：父进程先跑完 jsdom 契约，
 * 再用同目录的 Electron 运行本文件；子进程（process.versions.electron）只跑
 * 这一段，使用 tests/visual-harness.cjs 的真实静态资源与 SSE 夹具。
 *
 * 截图只证明「网页像素」：不含 OS 窗口装饰，也不代表真实 Pi 会话。
 * reduced-motion 通过 CDP 模拟；键盘通过受信 Input.dispatchKeyEvent 投递。 */
async function runElectronScreenshots() {
  const { app, BrowserWindow } = require('electron');
  const { spawn } = require('node:child_process');
  const OUT = process.env.UI4_EVIDENCE_ROOT || path.resolve(__dirname, '../.shots/ui4-approval');
  fs.mkdirSync(OUT, { recursive: true });
  const checks = [], facts = [], screenshots = [], errors = [];
  let pass = 0, fail = 0;
  const start = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, fn) => {
    try { fn(); pass++; checks.push({ name, pass: true }); console.log('  ok  ' + name); }
    catch (e) { fail++; checks.push({ name, pass: false, error: String(e && e.message || e) }); console.error(' FAIL ' + name + ': ' + (e && e.message || e)); }
  };
  let win, harness;
  const read = (src) => win.webContents.executeJavaScript(src, true);
  const shot = async (name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), image.toPNG());
    screenshots.push(name + '.png');
  };
  const key = async (name, modifiers = []) => {
    const vk = { Enter: 13, Escape: 27, Tab: 9 }[name];
    const code = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab' }[name];
    const params = { key: name, code, windowsVirtualKeyCode: vk, modifiers: modifiers.includes('shift') ? 8 : 0 };
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, ...params });
    await sleep(80);
  };
  try {
    app.setPath('userData', process.env.UI4_WORLD || path.join(require('node:os').tmpdir(), 'pi-gui-ui4b-electron'));
    app.on('window-all-closed', () => {});
    await app.whenReady();
    harness = spawn(process.execPath, [path.join(__dirname, 'visual-harness.cjs')], {
      cwd: path.dirname(OUT),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: '0', VISUAL_PUBLIC_ROOT: PUB },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    harness.stderr.on('data', (c) => errors.push(String(c).slice(0, 400)));
    const origin = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('harness timeout')), 15000);
      harness.stdout.on('data', (c) => {
        out += c;
        const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      });
      harness.on('error', reject);
    });
    win = new BrowserWindow({
      width: 1200, height: 900, useContentSize: true, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(String(message).slice(0, 400)); });
    await win.loadURL(origin);
    await sleep(2200);
    win.show(); win.focus(); win.webContents.focus();
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.bringToFront');
    const hasFocus = await read('document.hasFocus()');
    check('Electron 页面获得焦点（受信键盘可投递）', () => { if (!hasFocus) throw new Error('document.hasFocus() === false'); });

    await read(`(async () => {
      window.ST = await import('/state.js');
      window.AP = await import('/approval.js');
      Object.assign(ST.S, { hasProject: true, bridgeState: 'ready', switching: false, bridgeRun: 1, workspaceGeneration: 0 });
      window.__ui4 = { mode: 'ok', commands: [], release: null, seq: 0 };
      const orig = window.fetch;
      window.fetch = async (url, opts = {}) => {
        if (String(url) === '/api/command') {
          let cmd = null; try { cmd = JSON.parse(opts.body); } catch (e) {}
          __ui4.commands.push(cmd);
          if (__ui4.mode === 'fail') return { json: async () => ({ ok: false, error: 'fixture rejected' }) };
          if (__ui4.mode === 'network') throw new Error('fixture network down');
          if (__ui4.mode === 'manual') return new Promise((resolve) => { __ui4.release = () => resolve({ json: async () => ({ ok: true }) }); });
        }
        return orig(url, opts);
      };
      window.__pushApproval = (over = {}) => {
        const id = 'ui4-shot-' + (++__ui4.seq);
        AP.observeApprovalEvent({ type: 'extension_ui_request', id, method: 'confirm', title: 'Allow dangerous command?', message: 'rm -rf /tmp/demo', timeout: 30000, ...over }, ST.S);
        return id;
      };
      window.__click = (text) => [...document.querySelectorAll('#confirmCard button, #modalCard button')].find((b) => b.textContent === text)?.click();
      window.__cardFacts = () => {
        const c = document.querySelector('#confirmCard');
        const layer = document.getElementById('confirmLayer');
        const r = c.getBoundingClientRect();
        const a = c.querySelector('.modal-actions');
        const btns = [...a.querySelectorAll('button')];
        const d = c.querySelector('.ui4-confirm-detail-text');
        return {
          hidden: layer.hidden, left: r.left, top: r.top, right: r.right, bottom: r.bottom,
          vw: innerWidth, vh: innerHeight, pageWidth: document.documentElement.scrollWidth,
          actionsOverflow: a.scrollWidth - a.clientWidth,
          detailOverflow: d ? d.scrollWidth - d.clientWidth : 0,
          btnHeights: btns.map((b) => b.getBoundingClientRect().height),
          nowrap: btns.every((b) => getComputedStyle(b).whiteSpace === 'nowrap'),
          focus: document.activeElement && document.activeElement.textContent,
          paneHidden: document.getElementById('rightPane').hidden,
          animation: getComputedStyle(c).animationName,
          status: c.querySelector('.ui4-confirm-status')?.textContent || '',
          busy: c.getAttribute('aria-busy'),
          buttons: btns.map((b) => b.textContent),
        };
      };
    })()`);

    const longMessage = 'rm -rf /very/long/path/' + 'segment/'.repeat(38) + 'artifact && echo done';
    for (const theme of ['dark', 'light']) {
      for (const width of [700, 900, 1200, 1536]) {
        for (const pane of [false, true]) {
          win.setContentSize(width, 900);
          await sleep(80);
          await read(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
          if (pane) { await read(`document.querySelector('#navChanges').click()`); await sleep(240); }
          else { await read(`document.querySelector('#rightPane .secondary-close')?.click()`); await sleep(100); }
          await read(`document.getElementById('toasts').replaceChildren(); __ui4.mode = 'ok'; __pushApproval({ title: 'Run a shell command?', message: ${JSON.stringify(longMessage)} })`);
          await sleep(260);
          const label = `approval-${theme}-${width}-pane-${pane ? 'open' : 'closed'}`;
          const f = await read('__cardFacts()');
          facts.push({ label, ...f });
          check(label + '：卡片在视口内、正文/操作区无横向溢出', () => {
            if (f.hidden) throw new Error('layer hidden');
            if (f.left < -1 || f.top < -1 || f.right > f.vw + 1 || f.bottom > f.vh + 1) throw new Error('outside viewport');
            if (f.pageWidth > f.vw + 1) throw new Error('page horizontal overflow');
            if (f.actionsOverflow > 1) throw new Error('actions overflow');
            if (f.detailOverflow > 1) throw new Error('detail overflow');
          });
          check(label + '：按钮可读、初始焦点在「拒绝」、右栏状态正确', () => {
            if (!f.nowrap) throw new Error('button wraps');
            if (!f.btnHeights.every((h) => h >= 30)) throw new Error('button too short');
            if (f.focus !== '拒绝') throw new Error('initial focus is ' + f.focus);
            if (pane && f.paneHidden) throw new Error('right pane not open');
            if (!pane && !f.paneHidden) throw new Error('right pane not closed');
          });
          await shot(label);
          await read(`__click('拒绝')`);
          await sleep(200);
        }
      }
    }
    await read(`document.querySelector('#rightPane .secondary-close')?.click()`);
    win.setContentSize(900, 900);

    /* 提交中：按钮禁用、状态可见、重复点击不追加命令。 */
    await read(`document.documentElement.dataset.theme = 'dark'; document.getElementById('toasts').replaceChildren(); __ui4.mode = 'manual'; __ui4.commands = []; __pushApproval({ title: 'Long running command?', message: 'npm run build' })`);
    await sleep(120);
    await read(`__click('允许一次')`);
    await sleep(160);
    const busyFacts = await read(`(() => { const c = document.getElementById('confirmCard'); return { busy: c.getAttribute('aria-busy'), disabled: [...c.querySelectorAll('.modal-actions button')].every((b) => b.disabled), status: c.querySelector('.ui4-confirm-status')?.textContent || '', commands: __ui4.commands.length }; })()`);
    check('提交中：卡片保留、按钮禁用、状态说明可见', () => {
      if (busyFacts.busy !== 'true') throw new Error('not busy');
      if (!busyFacts.disabled) throw new Error('buttons enabled');
      if (!busyFacts.status.includes('正在把决定发给 Pi')) throw new Error('status=' + busyFacts.status);
      if (busyFacts.commands !== 1) throw new Error('commands=' + busyFacts.commands);
    });
    await read(`__click('允许一次')`);
    await sleep(80);
    const busyCommands = await read(`__ui4.commands.length`);
    check('提交中重复点击仍只有一条命令', () => { if (busyCommands !== 1) throw new Error('commands=' + busyCommands); });
    await shot('state-submitting-dark-900');
    await read(`__ui4.release()`);
    await sleep(220);

    /* 投递失败：卡片保留、错误状态可见、可重试。 */
    await read(`document.getElementById('toasts').replaceChildren(); __ui4.mode = 'fail'; __ui4.commands = []; __pushApproval({ title: 'This one fails', message: 'echo hello' })`);
    await sleep(120);
    await read(`__click('允许一次')`);
    await sleep(220);
    const failFacts = await read(`(() => { const c = document.getElementById('confirmCard'); return { hidden: document.getElementById('confirmLayer').hidden, state: c.querySelector('.ui4-confirm-status')?.dataset.state, text: c.querySelector('.ui4-confirm-status')?.textContent || '' }; })()`);
    check('投递失败：卡片不关闭、错误状态可见', () => {
      if (failFacts.hidden) throw new Error('card closed');
      if (failFacts.state !== 'error') throw new Error('state=' + failFacts.state);
      /* 后端明确拒绝时卡片显示的是真实投递结果（不是「仍在等待」的旧文案）：
       * Pi 仍持有这条请求，用户可以重试，但 UI 不能声称已经送达。 */
      if (!failFacts.text.includes('后端没有接受')) throw new Error('text=' + failFacts.text);
    });
    await shot('state-failed-dark-900');
    await read(`__ui4.mode = 'ok'; __click('允许一次')`);
    await sleep(220);

    /* select / input 审批卡。 */
    await read(`document.getElementById('toasts').replaceChildren(); __pushApproval({ method: 'select', title: 'Select what to allow', options: ['Allow reading .env', 'Allow running npm test', 'Block this request'] })`);
    await sleep(220);
    await shot('state-select-dark-900');
    await read(`__click('Block this request')`);
    await sleep(180);
    await read(`document.getElementById('toasts').replaceChildren(); __pushApproval({ method: 'input', title: 'Describe the reason', placeholder: 'Explain why this is safe…' })`);
    await sleep(220);
    await shot('state-input-dark-900');
    await read(`__click('取消')`);
    await sleep(180);

    /* Runtime 既有 DOM 形状 + 可集成展示接口。 */
    await read(`(() => {
      const host = document.createElement('div');
      host.className = 'runtime-conversation';
      host.style.cssText = 'padding:16px;max-width:760px;margin:0 auto';
      const old = document.querySelector('#ui4-runtime-fixture'); if (old) old.remove();
      host.id = 'ui4-runtime-fixture';
      const row = document.createElement('div');
      row.className = 'rtc-approval';
      host.appendChild(row);
      document.getElementById('chatView')?.appendChild(host) || document.body.appendChild(host);
      window.__rt = AP.renderRuntimeApproval(row, {
        approval: { id: 'rt-shot', method: 'confirm', title: 'Runtime approval: run a command?' },
        respond: async () => ({ ok: false, error: 'fixture rejects one time' }),
      });
      __rt.send({ confirmed: true });
    })()`);
    await sleep(220);
    const rtFacts = await read(`(() => { const r = document.querySelector('#ui4-runtime-fixture .rtc-approval'); return { text: r?.textContent || '', state: r?.querySelector('.ui4-confirm-status')?.dataset.state || '', overflow: r ? r.scrollWidth - r.clientWidth : -1 }; })()`);
    check('Runtime 卡：失败状态可见、无横向溢出、没有伪造的 Always 入口', () => {
      if (!rtFacts.text.includes('fixture rejects one time')) throw new Error('error not visible');
      if (rtFacts.state !== 'error') throw new Error('state=' + rtFacts.state);
      if (rtFacts.overflow > 1) throw new Error('overflow=' + rtFacts.overflow);
      if (/总是|Always|Bypass/i.test(rtFacts.text)) throw new Error('always/bypass text');
    });
    await shot('state-runtime-dark-900');
    await read(`document.getElementById('ui4-runtime-fixture')?.remove()`);

    /* reduced-motion：卡片动画关闭。 */
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await read(`document.getElementById('toasts').replaceChildren(); __pushApproval({ title: 'Reduced motion', message: 'echo ok' })`);
    await sleep(220);
    const rm = await read(`__cardFacts()`);
    check('reduced-motion：审批卡不播放入场动画', () => { if (rm.animation !== 'none') throw new Error('animation=' + rm.animation); });
    await shot('reduced-motion-dark-1200');
    await read(`__click('拒绝')`);
    await sleep(180);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });

    /* 受信键盘：Tab 循环、Enter 不替你允许、Esc 取消。 */
    await read(`__ui4.mode = 'ok'; __ui4.commands = []; __pushApproval({ title: 'Keyboard test' })`);
    await sleep(160);
    const focus0 = await read(`document.activeElement && document.activeElement.textContent`);
    check('键盘：初始焦点是「拒绝」', () => { if (focus0 !== '拒绝') throw new Error('focus=' + focus0); });
    await key('Tab');
    const focus1 = await read(`document.activeElement && document.activeElement.textContent`);
    check('键盘：Tab 移到「允许一次」', () => { if (focus1 !== '允许一次') throw new Error('focus=' + focus1); });
    await key('Tab', ['shift']);
    const focus2 = await read(`document.activeElement && document.activeElement.textContent`);
    check('键盘：Shift+Tab 回到「拒绝」', () => { if (focus2 !== '拒绝') throw new Error('focus=' + focus2); });
    await read(`document.getElementById('confirmCard').focus()`);
    const beforeEnter = await read(`__ui4.commands.length`);
    await key('Enter');
    const afterEnter = await read(`__ui4.commands.length`);
    check('键盘：卡片聚焦时 Enter 不会允许', () => { if (afterEnter !== beforeEnter) throw new Error('command sent'); });
    await key('Escape');
    await sleep(220);
    const escFacts = await read(`({ hidden: document.getElementById('confirmLayer').hidden, last: __ui4.commands[__ui4.commands.length - 1] })`);
    check('键盘：Esc 走取消应答并收卡', () => {
      if (!escFacts.hidden) throw new Error('card open');
      if (!escFacts.last || escFacts.last.cancelled !== true) throw new Error('last=' + JSON.stringify(escFacts.last));
    });

    check('渲染过程无控制台错误', () => { if (errors.length) throw new Error(errors.slice(0, 3).join(' | ')); });
  } catch (e) {
    fail++;
    checks.push({ name: 'Electron 矩阵执行完成', pass: false, error: String(e && e.stack || e) });
    console.error(' FAIL Electron 矩阵执行完成: ' + (e && e.stack || e));
  } finally {
    const result = {
      passed: pass, failed: fail, skipped: 0, exitCode: fail ? 1 : 0,
      checks, facts, screenshots, errors,
      durationMs: Date.now() - start,
      versions: { electron: process.versions.electron, chromium: process.versions.chrome },
      limits: 'Production public/ DOM/CSS in real Electron; offline fixture harness; capturePage web pixels only; no real Pi, no OS window chrome, no native browser view. Right pane uses the Changes surface (DOM), not the native Browser view.',
    };
    try { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2)); } catch { /* 输出目录问题已在上面暴露 */ }
    try { win?.destroy(); } catch {}
    try { harness?.kill(); } catch {}
    await sleep(100);
    console.log(`\nui4-approval electron: ${pass}/${pass + fail} 通过; screenshots=${screenshots.length}`);
    app.exit(fail ? 1 : 0);
  }
  return { pass, fail };
}

if (process.versions.electron) {
  runElectronScreenshots().catch((e) => { console.error(e); process.exit(1); });
} else {
  (async () => {
    const jsdomResult = await main().catch((e) => {
      console.error(e);
      return { pass, fail: fail + 1, failures: [{ name: 'jsdom suite', error: String(e && e.stack || e) }] };
    });
    if (process.argv.includes('--electron') && jsdomResult.fail === 0) {
      const { spawn } = require('node:child_process');
      const os = require('node:os');
      const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-ui4b-electron-'));
      const env = { ...process.env, UI4_WORLD: world };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [__filename, '--electron'], { env, stdio: 'inherit', windowsHide: false });
      child.on('error', (e) => { console.error(e); process.exitCode = 1; });
      child.on('exit', (code) => {
        process.exitCode = code ?? 1;
        if (process.exitCode === 0) console.log('\nui4-approval: jsdom + Electron 全部通过');
        fs.rm(world, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }, () => {});
      });
      return;
    }
    process.exitCode = jsdomResult.fail ? 1 : 0;
  })();
}
