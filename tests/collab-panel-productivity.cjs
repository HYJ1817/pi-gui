/* Z4-4B：协同面板 × 生产力工具条正式集成测试（jsdom + 真实 service adapter）。
 * 覆盖：预览→确认→保存→撤销全链路、取消预览零提交、over-limit 明确提示、
 * 外部修订后的 CAS 冲突、会话切换销毁、busy/readonly 禁用、重复点击、
 * 下载触发与失败恢复。复用 tests/collab-panel.cjs 的装配方式。
 * 直接运行：node tests/collab-panel-productivity.cjs（亦入 test:collab 链）。
 */
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
  /* jsdom 不实现 <a download> 的下载语义，点击会尝试导航并打印 not-implemented；
   * 用静默 VirtualConsole 收掉这类已知噪音（真实浏览器中 download 属性阻止导航）。 */
  const virtualConsole = new (require('jsdom').VirtualConsole)();
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://127.0.0.1/', virtualConsole });
  Object.assign(global, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
  const { S } = await import('../public/state.js');
  const { mountCollabPanel } = await import('../public/collab-panel.js');
  const { createCollabService, COLLAB_MESSAGES } = await import('../server/collab-service.js');
  const { validateDocument, createFlowchartDocument, applyUserOperations, bindSession } = await import('../lib/collab-doc.js');
  const { computeAutoLayout } = await import('../public/collab-auto-layout.js');
  S.cwd = 'C:\\temp-fixture'; S.workspaceGeneration = 1; S.bridgeRun = 1; S.state = { sessionId: 'native-a' };
  S.legacyOwner = { sessionId: 'native-a', runtimeGeneration: '1' };
  const scope = { key: 'a'.repeat(64), token: 'b'.repeat(64), sessionId: 'scope-session', assertCurrent() {} };
  const tick = () => new Promise(resolve => setTimeout(resolve, 15));

  /* 每个阶段独立 service / fetch / 面板，文档互不串台。 */
  let doc = null, calls = [], hold = null, pending = null;
  const storeStub = { read: () => ({ doc }), write(_scope, base, value) { assert.equal(base, doc?.revision ?? null); doc = validateDocument(value); return { doc }; } };
  let service = createCollabService({ store: storeStub });
  global.fetch = async (url, options) => {
    assert.equal(url, '/api/collab-documents');
    const body = JSON.parse(options.body); calls.push({ body, headers: options.headers });
    let answer;
    try { answer = service.execute(scope, body); } catch (error) { answer = { ok: false, code: error.code, error: COLLAB_MESSAGES[error.code] || '操作未确认' }; }
    if (hold === body.action) { hold = null; return new Promise(resolve => { pending = () => resolve({ json: async () => answer }); }); }
    return { json: async () => answer };
  };
  const mount = () => {
    const host = document.createElement('div'); document.body.append(host);
    let alive = true, dispose;
    const view = { isCurrent: () => alive, onDispose: fn => { dispose = fn; } };
    mountCollabPanel(host, view);
    return { host, close() { alive = false; dispose?.(); host.remove(); } };
  };
  const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text);
  const seedScattered = () => {
    let core = createFlowchartDocument({ documentId: 'doc-z44b' });
    core = applyUserOperations(core, [
      { opId: 'scatter-1', type: 'node.update', baseRevision: core.revision, actor: 'user', params: { id: 'n1', x: 8100, y: -4200 } },
      { opId: 'scatter-2', type: 'node.update', baseRevision: core.revision, actor: 'user', params: { id: 'n3', x: -9100, y: 7600 } },
    ]).doc;
    return bindSession(core, scope.sessionId);
  };

  /* ---------- 阶段 A：预览 → 确认 → 保存 → 撤销；取消；重复点击；下载与恢复 ---------- */
  doc = seedScattered();
  let panel = mount(); await tick();
  const host = panel.host;
  await check('面板挂载生产力工具条（画布与建议区之间）', async () => {
    assert.ok(host.querySelector('.collab-productivity'));
    const following = dom.window.Node.DOCUMENT_POSITION_FOLLOWING;
    assert.ok(host.querySelector('.collab-canvas').compareDocumentPosition(host.querySelector('.collab-productivity')) & following);
    assert.ok(host.querySelector('.collab-productivity').compareDocumentPosition(host.querySelector('.collab-proposal')) & following);
    assert.ok(button(host, '自动整理') && button(host, '导出 SVG') && button(host, '导出 PNG'));
  });
  const layoutTarget = computeAutoLayout(doc).positions;
  await check('自动整理先出预览且不保存', async () => {
    const before = JSON.stringify(doc);
    button(host, '自动整理').click(); await tick();
    assert.equal(host.querySelector('.collab-prod-preview').hidden, false);
    assert.match(host.querySelector('.collab-prod-preview p').textContent, /将移动 3 个节点/);
    assert.equal(calls.filter(c => c.body.action === 'operations').length, 0);
    assert.equal(JSON.stringify(doc), before);
  });
  await check('确认后单批原子保存且带 Owner 头', async () => {
    button(host, '确认应用布局').click(); await tick();
    const submissions = calls.filter(c => c.body.action === 'operations');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].body.ops.length, 3);
    assert.ok(submissions[0].body.ops.every(op => op.type === 'node.update' && op.actor === 'user'));
    assert.equal(submissions[0].headers['X-Pi-Gui-Owner'], JSON.stringify(S.legacyOwner));
    for (const node of doc.graph.nodes) assert.deepEqual({ x: node.x, y: node.y }, layoutTarget[node.id]);
  });
  await check('布局后现有撤销可用并恢复原坐标', async () => {
    button(host, '撤销').click(); await tick();
    const positions = Object.fromEntries(doc.graph.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
    assert.equal(positions.n1.x, 8100); assert.equal(positions.n3.x, -9100); assert.equal(positions.n2.x, 200);
    assert.equal(button(host, '撤销').disabled, true);
  });
  await check('取消预览不提交且文档不变', async () => {
    const before = JSON.stringify(doc);
    const operationsBefore = calls.filter(c => c.body.action === 'operations').length;
    button(host, '自动整理').click(); await tick();
    button(host, '取消预览').click(); await tick();
    assert.equal(host.querySelector('.collab-prod-preview').hidden, true);
    assert.equal(calls.filter(c => c.body.action === 'operations').length, operationsBefore);
    assert.equal(JSON.stringify(doc), before);
  });
  await check('预览清除后重复点击确认零提交', async () => {
    const operationsBefore = calls.filter(c => c.body.action === 'operations').length;
    button(host, '确认应用布局').click(); await tick();
    assert.equal(calls.filter(c => c.body.action === 'operations').length, operationsBefore);
  });
  const downloads = [];
  URL.createObjectURL = blob => { downloads.push({ blob, revoked: false }); return 'blob:z44b-' + downloads.length; };
  URL.revokeObjectURL = url => { const entry = downloads.find(d => 'blob:z44b-' + (downloads.indexOf(d) + 1) === url); if (entry) entry.revoked = true; };
  await check('导出 SVG 触发用户下载且不改文档', async () => {
    const before = JSON.stringify(doc);
    button(host, '导出 SVG').click(); await tick();
    assert.equal(downloads.length, 1);
    const svg = await downloads[0].blob.text();
    assert.ok(svg.includes('<svg') && svg.includes('开始') && svg.includes('流程图'));
    assert.match(host.textContent, /已开始下载 .*\.svg/);
    assert.equal(JSON.stringify(doc), before);
    assert.equal(calls.filter(c => c.body.action === 'operations').length, 1);
  });
  await check('下载环境缺失时报错且可恢复', async () => {
    const createObjectURL = URL.createObjectURL; delete URL.createObjectURL;
    button(host, '导出 SVG').click(); await tick();
    assert.match(host.textContent, /当前环境不支持文件下载/);
    URL.createObjectURL = createObjectURL;
    button(host, '导出 SVG').click(); await tick();
    assert.equal(downloads.length, 2);
    assert.match(host.textContent, /已开始下载/);
  });
  await check('保存期间 busy 禁用自动整理', async () => {
    hold = 'operations';
    button(host, '自动整理').click(); await tick();
    button(host, '确认应用布局').click(); await tick();
    assert.equal(button(host, '自动整理').disabled, true);
    pending(); await tick();
    assert.equal(button(host, '自动整理').disabled, false);
  });
  await check('会话切换同步销毁工具条', async () => {
    document.dispatchEvent(new window.CustomEvent('pi-gui:session-switch'));
    assert.equal(host.querySelectorAll('.collab-productivity').length, 0);
    assert.equal(host.querySelectorAll('.collab-canvas').length, 0);
  });
  panel.close();

  /* ---------- 阶段 B：60 节点 over-limit 明确提示、零提交 ---------- */
  doc = null; calls = []; service = createCollabService({ store: storeStub });
  {
    let big = createFlowchartDocument({ documentId: 'doc-big' });
    const items = [
      ...Array.from({ length: 60 }, (_, i) => ({ op: 'node.add', data: { id: `b${String(i).padStart(2, '0')}`, label: `节点${i}`, x: (i * 613) % 9000, y: (i * 197) % 9000 } })),
      ...Array.from({ length: 59 }, (_, i) => ({ op: 'edge.add', data: { id: `x${String(i).padStart(2, '0')}`, from: `b${String(i).padStart(2, '0')}`, to: `b${String(i + 1).padStart(2, '0')}` } })),
    ];
    for (let start = 0; start < items.length; start += 40) {
      big = applyUserOperations(big, items.slice(start, start + 40).map((item, index) => ({
        opId: `seed-${start + index}`, type: item.op, baseRevision: big.revision, actor: 'user', params: item.data,
      }))).doc;
    }
    doc = bindSession(big, scope.sessionId);
  }
  panel = mount(); await tick();
  await check('60 节点自动整理给出明确超限提示', async () => {
    button(panel.host, '自动整理').click(); await tick();
    assert.match(panel.host.querySelector('.collab-prod-preview p').textContent, /超过单批 50 条操作上限/);
    assert.equal(button(panel.host, '确认应用布局').disabled, true);
  });
  await check('超限路径零提交零部分保存', async () => {
    button(panel.host, '取消预览').click(); await tick();
    assert.equal(calls.filter(c => c.body.action === 'operations').length, 0);
    const node = doc.graph.nodes.find(n => n.id === 'b00');
    assert.equal(node.x, 0);
  });
  panel.close();

  /* ---------- 阶段 C：外部修订后的 CAS 冲突与只读隔离 ---------- */
  doc = seedScattered(); calls = []; service = createCollabService({ store: storeStub });
  panel = mount(); await tick();
  await check('外部修订后确认布局触发 CAS 冲突', async () => {
    button(panel.host, '自动整理').click(); await tick();
    const external = service.execute(scope, { action: 'open' });
    service.execute(scope, { action: 'operations', editorId: external.editorId, expectedRevision: doc.revision,
      ops: [{ opId: 'ext-1', type: 'node.update', baseRevision: doc.revision, actor: 'user', params: { id: 'n2', label: '外部修订' } }] });
    button(panel.host, '确认应用布局').click(); await tick();
    assert.match(panel.host.textContent, /文档已被修改/);
    assert.equal(button(panel.host, '重新打开').hidden, false);
  });
  await check('冲突后文档只含外部修订且工具条只读', async () => {
    assert.equal(doc.graph.nodes.find(n => n.id === 'n2').label, '外部修订');
    assert.equal(doc.graph.nodes.find(n => n.id === 'n1').x, 8100, '布局坐标未被部分应用');
    assert.equal(button(panel.host, '自动整理').disabled, true);
  });
  panel.close();
  dom.window.close();
  console.log(`Collab panel productivity: ${checks}/${checks}; assertions=${assertions}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
