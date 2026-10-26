// Bounded offline soak and resource regressions. Real TEMP store, injected Pi
// events, jsdom lifecycle; explicitly not Electron or real-model evidence.
const baseAssert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
let assertions = 0, checks = 0, failed = 0;
const assert = new Proxy(baseAssert, { get: (target, key) => typeof target[key] === 'function' ? (...args) => { assertions++; return target[key](...args); } : target[key] });
const check = async (name, fn) => { try { await fn(); checks++; console.log('ok ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } };
const deadline = setTimeout(() => { console.error('stability_timeout'); process.exit(1); }, 90000);
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
(async () => {
  const { createCollabStore } = await import('../server/collab-store.js');
  const { createCollabService } = await import('../server/collab-service.js');
  const { createCollabProposalSource } = await import('../server/collab-proposal-source.js');
  const { createProposalQueue } = await import('../server/collab-proposal-queue.js');
  const { createFlowchartDocument, validateDocument, applyUserOperations } = await import('../lib/collab-doc.js');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'z46-stability-'));
  const rssBefore = process.memoryUsage().rss, started = Date.now(), heapSamples = [];
  try {
    await check('40 mixed Classic/Runtime cycles over four documents: reject/accept/undo/redo, restart and bounded queues', async () => {
      const store = createCollabStore({ dataDir: world });
      const identity = { kind: 'runtime', backendInstance: 'backend', projectId: 'project', repoId: null, workspaceId: 'workspace', workspaceEpoch: 'epoch', conversationId: 'conv', runtimeId: 'runtime', runtimeGeneration: 'gen', sessionId: 'native' };
      const source = createCollabProposalSource({ queue: createProposalQueue(), channels: {
        classic: { captureIdentity: () => ({ kind: 'classic', bridgeRun: 1, cwd: world, workspaceGeneration: '1', sessionId: 'native' }), sendPrompt: async () => {} },
        runtime: { captureIdentity: () => identity, sendPrompt: async () => {} },
      } });
      const service = createCollabService({ store, proposals: source });
      const feed = (scope, event) => scope.origin === 'classic' ? source.observeClassic({ ...event, bridgeRun: 1 }) : source.observeRuntime({ type: 'runtime_event', owner: identity, event });
      for (let round = 0; round < 40; round++) {
        const projectRoot = path.join(os.tmpdir(), 'z46-synthetic-project-' + (round % 4));
        const scope = { key: (round % 4).toString(16).padStart(64, '0'), token: 'f'.repeat(64), sessionId: (round % 4 + 1).toString(16).padStart(64, '0'), origin: round % 2 ? 'runtime' : 'classic', conversationId: round % 2 ? 'conv' : null,
          projectRoot, workspaceCwd: projectRoot, gitCommon: path.join(projectRoot, '.git'), assertCurrent() {} };
        let snap = service.execute(scope, { action: 'open' });
        if (!snap.document) snap = service.execute(scope, { action: 'create', editorId: snap.editorId, expectedRevision: null });
        const initialLabel = snap.document.graph.nodes[0].label;
        const send = (action, extra = {}) => { const result = service.execute(scope, { action, editorId: snap.editorId, expectedRevision: snap.document.revision, ...extra }); if (result.ok && result.document) snap = result; return result; };
        const generate = async () => {
          const pending = send('generate', { instruction: 'fixture update' }).pendingGenerate;
          assert.equal((await service.dispatchPendingGenerate(pending)).ok, true);
          feed(scope, { type: 'agent_start' });
          feed(scope, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '\n```pi-gui-collab\n' + JSON.stringify({ version: 1, rationale: 'fixture', ops: [{ type: 'node.update', params: { id: 'n1', label: 'round-' + round } }] }) + '\n```' }] } });
          feed(scope, { type: 'agent_settled', aborted: false });
          return source.head(scope, 'diagram').proposalId;
        };
        const before = JSON.stringify(store.read(scope).doc);
        const rejected = await generate(); send('preview', { proposalId: rejected }); send('reject', { proposalId: rejected });
        assert.equal(JSON.stringify(store.read(scope).doc), before);
        assert.throws(() => send('accept', { proposalId: rejected }), e => e.code === 'collab_proposal_unavailable');
        const accepted = await generate(); send('accept', { proposalId: accepted });
        const graph = JSON.stringify(snap.document.graph);
        send('undo'); assert.equal(snap.document.graph.nodes[0].label, initialLabel);
        send('redo'); assert.equal(JSON.stringify(snap.document.graph), graph);
        service.execute(scope, { action: 'close', editorId: snap.editorId });
        const restarted = createCollabService({ store: createCollabStore({ dataDir: world }) });
        const restored = restarted.execute(scope, { action: 'open' });
        assert.equal(JSON.stringify(restored.document.graph), graph);
        assert.equal(restored.canUndo, false);
        restarted.execute(scope, { action: 'close', editorId: restored.editorId });
        assert.ok(source.stats().size <= 32 && source.stats().attempts <= 33);
      }
      source.dropAll(); assert.deepEqual(source.stats(), { size: 0, pending: 0, attempts: 0 });
    });

    const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://127.0.0.1/', virtualConsole: new VirtualConsole() });
    Object.assign(global, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
    try {
      const { S } = await import('../public/state.js');
      const { mountCollabPanel } = await import('../public/collab-panel.js');
      S.cwd = world; S.workspaceGeneration = 1; S.bridgeRun = 1; S.legacyOwner = { sessionId: 'fixture', runtimeGeneration: '1' };
      const timeouts = new Map(), intervals = new Map(), urls = new Set(), listeners = new Set();
      let serial = 0, doc = createFlowchartDocument({ documentId: 'diagram' });
      const originalAdd = document.addEventListener.bind(document), originalRemove = document.removeEventListener.bind(document);
      document.addEventListener = (type, fn, options) => { if (type.startsWith('pi-gui:')) listeners.add(fn); originalAdd(type, fn, options); };
      document.removeEventListener = (type, fn, options) => { listeners.delete(fn); originalRemove(type, fn, options); };
      window.setTimeout = (fn, ms) => { const id = ++serial; timeouts.set(id, { fn, ms }); return id; };
      window.clearTimeout = id => timeouts.delete(id);
      window.setInterval = fn => { const id = ++serial; intervals.set(id, fn); return id; };
      window.clearInterval = id => intervals.delete(id);
      const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
      URL.createObjectURL = () => { const url = 'blob:fixture-' + (++serial); urls.add(url); return url; };
      URL.revokeObjectURL = url => urls.delete(url);
      const button = (host, label) => [...host.querySelectorAll('button')].find(n => n.textContent === label);
      let calls = 0;
      global.fetch = async (_url, options) => {
        const req = JSON.parse(options.body); calls++;
        const answer = req.action === 'close' ? { ok: true } : { ok: true, editorId: 'editor-' + calls, document: validateDocument(doc), proposalSourceAvailable: false, canUndo: false, canRedo: false };
        return { ok: true, json: async () => answer };
      };
      try {
        await check('40 panel SVG exports and disposal leave no URLs, timers, polling or lifecycle listeners', async () => {
          for (let round = 0; round < 40; round++) {
            const host = document.createElement('div'); document.body.append(host);
            let dispose; mountCollabPanel(host, { isCurrent: () => true, onDispose: fn => { dispose = fn; } });
            await tick(); button(host, '导出 SVG').click(); await tick();
            assert.equal(urls.size, 1);
            if (round % 2) document.dispatchEvent(new CustomEvent('pi-gui:session-switch'));
            dispose(); host.remove();
            assert.equal(urls.size, 0); assert.equal(intervals.size, 0); assert.equal(listeners.size, 0);
            assert.equal(timeouts.size, 0, 'disposed panel must cancel deferred download revocation timers');
          }
        });
      } finally { URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL; timeouts.clear(); intervals.clear(); }

      await check('40 canvas cycles: copy/paste, layout confirmation and destruction block detached controls', async () => {
        const { mountCollabCanvas } = await import('../public/collab-canvas.js');
        const { mountCollabProductivity } = await import('../public/collab-canvas-productivity.js');
        for (let round = 0; round < 40; round++) {
          let graphDoc = createFlowchartDocument({ documentId: 'canvas-' + round }), submissions = 0, canvas, bar;
          const host = document.createElement('div'); document.body.append(host);
          const submit = intents => {
            const result = applyUserOperations(graphDoc, intents.map((intent, i) => ({ ...intent, actor: 'user', baseRevision: graphDoc.revision, opId: `r${round}-${submissions}-${i}` })));
            assert.equal(result.ok, true); submissions++; graphDoc = result.doc;
            canvas.update({ document: graphDoc }); bar.update({ document: graphDoc }); return true;
          };
          canvas = mountCollabCanvas(host, { document: graphDoc, onOperations: submit });
          bar = mountCollabProductivity(host, { document: graphDoc, onOperations: submit });
          const svg = host.querySelector('.collab-stage');
          for (const key of ['a', 'c', 'v']) svg.dispatchEvent(new window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
          assert.equal(graphDoc.graph.nodes.length, 6); assert.equal(graphDoc.graph.edges.length, 4); assert.equal(submissions, 1);
          button(host, '自动整理').click(); button(host, '确认应用布局').click();
          assert.equal(submissions, 2);
          const detached = button(host, '新增节点'); canvas.destroy(); bar.destroy(); detached.click();
          assert.equal(submissions, 2); host.remove();
          if ((round + 1) % 10 === 0) { global.gc?.(); heapSamples.push({ canvasRounds: round + 1, heapUsed: process.memoryUsage().heapUsed, gcRequested: typeof global.gc === 'function' }); }
        }
      });

      await check('oversized PNG refuses before Blob/Image/canvas allocation', async () => {
        const { exportFlowchart } = await import('../public/collab-export.js');
        let allocated = 0;
        const originalCreate = URL.createObjectURL;
        URL.createObjectURL = () => { allocated++; throw Error('allocation must not happen'); };
        const huge = createFlowchartDocument({ documentId: 'huge' }); huge.graph.nodes[0].x = -100000; huge.graph.nodes[2].x = 100000;
        try {
          const result = await exportFlowchart(huge, { format: 'png' });
          assert.equal(result.code, 'png-size-limit'); assert.equal(allocated, 0);
        } finally { URL.createObjectURL = originalCreate; }
      });
    } finally { dom.window.close(); }
    console.log(JSON.stringify({ rounds: 40, elapsedMs: Date.now() - started, rssBefore, rssAfter: process.memoryUsage().rss, heapSamples, qualification: 'bounded-short-soak-only' }));
  } finally {
    const relative = path.relative(os.tmpdir(), fs.realpathSync(world)); baseAssert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(world, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  console.log(`Collab stability: ${checks}/${checks + failed}; assertions=${assertions}; failed=${failed}`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
