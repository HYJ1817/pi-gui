// Z4-3 阶段 D：协同面板 Agent 生成交互闭环（jsdom + 真实 service/source + fake 通道）。
// 覆盖：发起生成、轮询拾取、预览展示、接受应用、失败文案、冲突后重新生成、生命周期停轮。
'use strict';
const baseAssert = require('node:assert/strict');
let assertions = 0;
const assert = new Proxy(baseAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value; },
});
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('ok ' + name); };
(async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://127.0.0.1/' });
  // 轮询间隔在测试中压缩到 10ms，行为语义（setInterval 驱动）不变。
  const originalSetInterval = dom.window.setInterval.bind(dom.window);
  dom.window.setInterval = (fn, ms) => originalSetInterval(fn, Math.min(ms, 10));
  Object.assign(global, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
  const { S } = await import('../public/state.js');
  const api = await import('../public/api.js');
  const { mountCollabPanel } = await import('../public/collab-panel.js');
  const { createCollabService, COLLAB_MESSAGES } = await import('../server/collab-service.js');
  const { createCollabProposalSource } = await import('../server/collab-proposal-source.js');
  const { createProposalQueue } = await import('../server/collab-proposal-queue.js');
  const { validateDocument } = await import('../lib/collab-doc.js');
  S.cwd = 'C:\\temp-fixture'; S.workspaceGeneration = 1; S.bridgeRun = 1; S.state = { sessionId: 'native-a' };
  S.legacyOwner = { sessionId: 'native-a', runtimeGeneration: '1' };

  const FENCE = json => '分析完成。\n```pi-gui-collab\n' + JSON.stringify(json) + '\n```';
  const ADD_N9 = { version: 1, rationale: '增加异常处理节点', ops: [{ type: 'node.add', params: { id: 'n9', label: '异常处理', x: 600, y: 0 } }] };
  const ADD_N8 = { version: 1, rationale: '第二个建议', ops: [{ type: 'node.add', params: { id: 'n8', label: '重试', x: 300, y: 100 } }] };
  const ADD_N7 = { version: 1, rationale: '待拾取的建议', ops: [{ type: 'node.add', params: { id: 'n7', label: '拾取节点', x: 200, y: 200 } }] };
  let doc = null, prompts = [], failNextGenerate = false;
  const scope = { key: 'a'.repeat(64), token: 'b'.repeat(64), sessionId: 'scope-session', origin: 'classic', conversationId: null, assertCurrent() {} };
  const channels = {
    classic: { captureIdentity: () => ({ bridgeRun: 7 }),
      sendPrompt: async (_key, message) => { if (failNextGenerate) { failNextGenerate = false; throw Object.assign(Error(), { code: 'runtime_busy' }); } prompts.push(message); } },
    runtime: { captureIdentity: () => { throw Object.assign(Error(), { code: 'collab_generate_unavailable' }); }, sendPrompt: async () => {} },
  };
  const source = createCollabProposalSource({ queue: createProposalQueue(), channels });
  const service = createCollabService({
    store: { read: () => ({ doc }), write(_s, base, value) { assert.equal(base, doc?.revision ?? null); doc = validateDocument(value); return { doc }; } },
    proposals: source });
  const calls = [];
  global.fetch = async (url, options) => {
    assert.equal(url, '/api/collab-documents');
    const body = JSON.parse(options.body); calls.push({ body, headers: options.headers });
    let answer;
    try { answer = await service.execute(scope, body); calls.at(-1).answer = answer; }
    catch (e) { answer = { ok: false, code: e.code, error: COLLAB_MESSAGES[e.code] ?? '操作未确认' }; }
    return { json: async () => answer };
  };
  const tick = (n = 1) => new Promise(resolve => { setTimeout(resolve, 12 * n); });
  const mount = () => {
    const host = document.createElement('div'); document.body.append(host); let alive = true, dispose;
    const view = { isCurrent: () => alive, onDispose: fn => { dispose = fn; } };
    mountCollabPanel(host, view);
    return { host, close() { alive = false; dispose?.(); host.remove(); } };
  };
  const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text);
  const feedRun = (payload = ADD_N9) => {
    source.observeClassic({ type: 'agent_start', bridgeRun: 7 });
    source.observeClassic({ type: 'message_end', bridgeRun: 7, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: FENCE(payload) }] } });
    source.observeClassic({ type: 'agent_settled', aborted: false, bridgeRun: 7 });
  };

  let panel = mount(); await tick();
  await check('生成入口：输入与按钮随文档与当前性启停', async () => {
    button(panel.host, '新建流程图').click(); await tick();
    assert.equal(doc.revision, 1);
    const input = panel.host.querySelector('.collab-agent-input');
    const generate = button(panel.host, '让 Agent 修改');
    assert.equal(generate.hidden, false);
    assert.equal(generate.disabled, true, '空输入时禁用');
    input.value = '增加一个异常处理节点';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(generate.disabled, false);
    assert.match(panel.host.querySelector('.collab-panel-source').textContent, /预览确认后才会应用/);
  });

  await check('发起生成：generate 请求携带指令；轮询拾取 ready 并自动预览', async () => {
    button(panel.host, '让 Agent 修改').click();
    await tick(2);
    const generateCall = calls.findLast(c => c.body.action === 'generate');
    assert.equal(generateCall.body.instruction, '增加一个异常处理节点');
    assert.equal(prompts.length, 1, '服务端组合的 prompt 已交给通道');
    assert.match(prompts[0], /```pi-gui-collab/);
    assert.equal(button(panel.host, '让 Agent 修改').disabled, true, '生成中禁用再次发起');
    feedRun();
    await tick(4); // 轮询压缩为 10ms，等待拾取 ready → 自动 preview
    assert.equal(calls.some(c => c.body.action === 'proposal_status'), true);
    assert.equal(calls.some(c => c.body.action === 'preview'), true);
    const card = panel.host.querySelector('.collab-proposal');
    assert.match(card.textContent, /增加异常处理节点/);
    assert.match(card.textContent, /基于版本 1 → 2/);
    assert.match(card.textContent, /node\.add/);
    assert.equal(button(card, '接受建议').disabled, false);
    assert.equal(button(card, '重新生成').disabled, false);
  });

  await check('接受建议：CAS 提交成功并更新画布，可撤销', async () => {
    button(panel.host.querySelector('.collab-proposal'), '接受建议').click();
    await tick(2);
    assert.equal(doc.revision, 2);
    assert.ok(doc.graph.nodes.some(n => n.id === 'n9'));
    assert.ok(panel.host.querySelector('[data-node-id="n9"]'), '画布出现新节点');
    assert.equal(button(panel.host, '撤销').disabled, false);
    const emptyCard = panel.host.querySelector('.collab-proposal');
    assert.equal(emptyCard.querySelector('.collab-proposal-actions').hidden, true, '接受后建议动作隐藏');
    assert.match(emptyCard.textContent, /暂无建议/);
  });

  await check('拒绝路径与失败文案：通道 busy 显示安全提示且可再次发起', async () => {
    failNextGenerate = true;
    const input = panel.host.querySelector('.collab-agent-input');
    input.value = '再来一次修改';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    button(panel.host, '让 Agent 修改').click();
    await tick(2);
    assert.match(panel.host.querySelector('.collab-panel-status').textContent, /Pi 正在执行任务/);
    assert.equal(prompts.length, 1, 'busy 失败不产生新 prompt');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(button(panel.host, '让 Agent 修改').disabled, false, '失败后可再次发起');
  });

  await check('冲突后重新生成：卡片保持入口可用，重开编辑器并发起新受控任务', async () => {
    const { applyUserOperations } = await import('../lib/collab-doc.js');
    const input = panel.host.querySelector('.collab-agent-input');
    button(panel.host, '让 Agent 修改').click();
    await tick(2);
    feedRun(ADD_N8);
    const waitForPreview = async baseline => {
      for (let i = 0; i < 40; i++) {
        await tick();
        if (calls.filter(c => c.body.action === 'preview').length > baseline) break;
      }
      await tick(2);
      return calls.filter(c => c.body.action === 'preview').length;
    };
    const previewBaseline = calls.filter(c => c.body.action === 'preview').length;
    assert.ok(await waitForPreview(previewBaseline) > previewBaseline, '建议进入预览');
    assert.match(panel.host.querySelector('.collab-proposal').textContent, /基于版本 2 → 3/);
    // 服务端文档被外部推进到 revision 3（模拟其他编辑器/后续落盘），面板仍停留在 2
    doc = applyUserOperations(doc, [
      { opId: 'ext-1', type: 'node.update', baseRevision: 2, actor: 'user', params: { id: 'n1', label: '外部修改' } },
    ]).doc;
    assert.equal(doc.revision, 3);
    const card = panel.host.querySelector('.collab-proposal');
    button(card, '接受建议').click(); await tick(3);
    assert.match(card.textContent, /文档已被修改/, '接受旧版本建议返回冲突文案');
    assert.equal(button(card, '接受建议').disabled, true, '冲突时不可接受');
    assert.equal(button(card, '重新生成').disabled, false, '冲突时保留重新生成入口');
    button(card, '重新生成').click();
    await tick(4);
    assert.ok(calls.filter(c => c.body.action === 'open').length >= 1, '重新生成先重开编辑器取得最新 revision');
    assert.equal(calls.some(c => c.body.action === 'generate'), true, '重新生成发起新受控任务');
    feedRun(ADD_N8); // 新的受控任务基于 revision 3 产出新建议（supersede 旧 pending）
    assert.ok(await waitForPreview(calls.filter(c => c.body.action === 'preview').length) > 0, '重新生成后进入预览');
    assert.match(panel.host.querySelector('.collab-proposal').textContent, /基于版本 3 → 4/);
    button(panel.host.querySelector('.collab-proposal'), '接受建议').click();
    await tick(3);
    assert.equal(doc.revision, 4);
    assert.ok(doc.graph.nodes.some(n => n.id === 'n8'));
  });

  await check('生命周期：会话切换同步停轮并失效面板', async () => {
    const pollsBefore = calls.filter(c => c.body.action === 'proposal_status').length;
    document.dispatchEvent(new window.CustomEvent('pi-gui:session-switch'));
    assert.equal(panel.host.querySelectorAll('[data-node-id]').length, 0);
    await tick(6);
    const pollsAfter = calls.filter(c => c.body.action === 'proposal_status').length;
    assert.equal(pollsAfter, pollsBefore, '失效后不再轮询');
    panel.close();
  });

  await check('来源未接入：无 proposals 的服务显示原文案并拒绝生成', async () => {
    const bareService = createCollabService({ store: { read: () => ({ doc: null }), write: (_s, _b, v) => ({ doc: validateDocument(v) }) } });
    const savedFetch = global.fetch;
    const bareDoc = { current: null };
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ body, headers: options.headers });
      const bareScope = { ...scope };
      const bareStore = { read: () => ({ doc: bareDoc.current }), write: (_s, _b, v) => { bareDoc.current = validateDocument(v); return { doc: bareDoc.current }; } };
      let answer; try { answer = bareService.execute(bareScope, body); } catch (e) { answer = { ok: false, code: e.code, error: COLLAB_MESSAGES[e.code] ?? '操作未确认' }; }
      return { json: async () => answer };
    };
    const pollsBaseline = calls.filter(c => c.body.action === 'proposal_status').length;
    panel = mount(); await tick();
    button(panel.host, '新建流程图').click(); await tick();
    assert.match(panel.host.querySelector('.collab-panel-source').textContent, /来源尚未接入/);
    const input = panel.host.querySelector('.collab-agent-input');
    input.value = 'x'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    button(panel.host, '让 Agent 修改').click(); await tick(2);
    assert.match(panel.host.querySelector('.collab-panel-status').textContent, /尚无来自可信 Agent 来源的建议|尚未接入/);
    assert.equal(calls.filter(c => c.body.action === 'proposal_status').length, pollsBaseline, '无来源时不轮询');
    panel.close();
    global.fetch = savedFetch;
  });

  await check('重开面板拾取未决建议：open 后自动 preview 展示', async () => {
    panel = mount(); await tick(4);
    const input = panel.host.querySelector('.collab-agent-input');
    input.value = '再生成一条但先不接受';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    button(panel.host, '让 Agent 修改').click(); await tick(3);
    feedRun(ADD_N7); // 生成完成但用户未决定；关闭面板
    await tick(3);
    panel.close();
    const previewCount = calls.filter(c => c.body.action === 'preview').length;
    panel = mount(); await tick(5);
    assert.equal(calls.filter(c => c.body.action === 'preview').length > previewCount, true, '重开后自动 preview');
    assert.match(panel.host.querySelector('.collab-proposal')?.textContent ?? '', /待拾取的建议/);
    panel.close();
  });

  dom.window.close();
  console.log(`Collab panel agent: ${checks}/${checks}; assertions=${assertions}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
