/* Real Router/auth/Registry + artificial native files. No real Pi or user data. */
let assertions = 0;
const assert = new Proxy(require('node:assert/strict'), { get(target, key) {
  const value = target[key]; return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value;
} });
const fs = require('node:fs'), os = require('node:os');
const path = require('node:path'), http = require('node:http');
(async () => {
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const { createRuntimeRoutes } = await import('../server/runtime-routes.js');
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const { readSessionMessages } = await import('../server/session-history.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z53-history-http-'));
  for (const id of ['A', 'B']) fs.mkdirSync(path.join(root, id));
  let factories = 0, wire = [], checks = 0, hold = null, entered = null;
  let overrideTarget = null;
  const check = async (name, fn) => { await fn(); checks++; console.log('  ok  ' + name); };
  const files = new Map();
  const write = (id, error) => {
    const file = path.join(root, id + '.jsonl');
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id, cwd: root },
      { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'question' } },
      { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [
        { type: 'text', text: 'answer' }, { type: 'toolCall', id: 'same-call', name: 'read', arguments: { token: 'PRIVATE_TOKEN' } },
      ] } },
      { type: 'message', id: 'r', parentId: 'a', message: { role: 'toolResult', toolName: 'read', toolCallId: 'same-call',
        isError: error, content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }], details: { path: 'C:/PRIVATE_PATH' } } },
    ].map(JSON.stringify).join('\n') + '\n'); files.set(id, file); return file;
  };
  const options = { dataDir: path.join(root, 'registry'),
    resolveWorkspace: async args => ({ projectId: 'project-' + args.id, repoId: 'repo-' + args.id,
      workspaceId: args.id, workspaceEpoch: 'epoch', cwd: root, root: path.join(root, args.id), branch: args.id }),
    factory: async (context, emit) => {
      factories++; const nativeId = 'native-' + context.workspace.workspaceId;
      const file = write(nativeId, context.workspace.workspaceId === 'B');
      return { start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }),
        request: async command => { wire.push(command); return { sessionId: nativeId }; },
        send: command => wire.push(command), sessionLocator: () => fs.realpathSync(file),
        getState: () => ({}), dispose: async () => {}, cleanupConfirmed: () => true };
    } };
  let registry = createRuntimeRegistry(options);
  const routes = createRuntimeRoutes({ registry: { ...registry, historyTarget: id => overrideTarget || registry.historyTarget(id) },
    readHistory: async (file, expected) => { const body = readSessionMessages(file, { expected }); if (hold) { entered(); await hold; } return body; } });
  const auth = createAuth({ token: 'z53-fixture-token', port: 7788, appId: 'pi-gui', protocol: 1, version: 'fixture' });
  const server = http.createServer(createRouter({ auth, runtimeSessions: routes, rpc: { getState: () => ({ state: 'stopped' }) } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-pi-gui-token': 'z53-fixture-token' };
  const get = async (id, extra = '', requestHeaders = headers) => {
    const response = await fetch(base + '/api/runtime-sessions?conversationId=' + encodeURIComponent(id) + extra, { headers: requestHeaders });
    return { status: response.status, body: await response.json() };
  };
  try {
    const a = await registry.start({ id: 'A', epoch: 'epoch' });
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    const oldOwner = registry.getOwner(a.conversationId); await registry.close(oldOwner);
    const b = await registry.start({ id: 'B', epoch: 'epoch' });
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    await registry.close(registry.getOwner(b.conversationId));
    const beforeFactories = factories, beforeWire = wire.length;
    const target = registry.historyTarget(a.conversationId), beforeBytes = fs.readFileSync(target.sessionLocator);
    await check('authenticated dormant HTTP returns the bounded safe summary', async () => {
      const response = await get(a.conversationId); assert.equal(response.status, 200);
      assert.ok(response.body.toolSummary, 'HTTP must forward the proven safe summary');
      assert.equal(response.body.toolSummary.items[0].status, 'completed');
      assert.deepEqual(response.body.locator, target.locator);
      assert.deepEqual(response.body.messages.map(m => m.text), ['question', 'answer']);
    });
    await check('same call ID is isolated by native session and project/workspace', async () => {
      const response = await get(b.conversationId); assert.equal(response.body.toolSummary.items[0].status, 'error');
      assert.notEqual(response.body.locator.projectId, target.locator.projectId);
      assert.notEqual(response.body.locator.nativeSessionId, target.locator.nativeSessionId);
    });
    await check('no token cannot read text or tool evidence', async () => {
      const response = await get(a.conversationId, '', {}); assert.equal(response.status, 401);
      assert.equal(response.body.toolSummary, undefined); assert.equal(response.body.messages, undefined);
    });
    await check('wrong Origin is rejected even with a valid token', async () => {
      const response = await get(a.conversationId, '', { ...headers, Origin: 'https://foreign.invalid' }); assert.equal(response.status, 403);
      assert.equal(response.body.toolSummary, undefined);
    });
    await check('unknown conversation cannot authorize a client path', async () => {
      const response = await get('missing', '&sessionLocator=' + encodeURIComponent(target.sessionLocator));
      assert.equal(response.status, 404); assert.equal(response.body.toolSummary, undefined);
    });
    await check('client path fields cannot redirect a proven conversation', async () => {
      const response = await get(a.conversationId, '&sessionLocator=' + encodeURIComponent(files.get('native-B')));
      assert.equal(response.body.toolSummary.items[0].status, 'completed'); assert.deepEqual(response.body.locator, target.locator);
    });
    await check('HTTP payload excludes arguments, output, private proof and path', async () => {
      const response = await get(a.conversationId), json = JSON.stringify(response.body);
      for (const secret of ['PRIVATE', root, '.jsonl', 'sessionIdentity', 'same-call']) assert.equal(json.includes(secret), false);
    });
    await check('history does not create Runtime, RPC, tool or approval activity', async () => {
      for (let i = 0; i < 3; i++) assert.equal((await get(a.conversationId)).status, 200);
      assert.equal(factories, beforeFactories); assert.equal(wire.length, beforeWire); assert.equal(registry.liveCount(), 0);
      assert.equal(registry.getOwner(a.conversationId), null); assert.deepEqual(fs.readFileSync(target.sessionLocator), beforeBytes);
    });
    await check('old Owner remains unable to send after read-only browsing', async () => {
      await assert.rejects(registry.command(oldOwner, { type: 'prompt', message: 'must-not-send' }), e => e.code === 'stale_runtime');
      assert.equal(wire.length, beforeWire);
    });
    await check('native header replacement rejects both text and summary', async () => {
      fs.writeFileSync(target.sessionLocator, beforeBytes.toString().replace('native-A', 'foreign-A'));
      try { const response = await get(a.conversationId); assert.equal(response.status, 409);
        assert.equal(response.body.toolSummary, undefined); assert.equal(response.body.messages, undefined); }
      finally { fs.writeFileSync(target.sessionLocator, beforeBytes); }
    });
    await check('late read is rejected when captured workspace identity changes', async () => {
      let release; hold = new Promise(resolve => release = resolve);
      const ready = new Promise(resolve => entered = resolve);
      const pending = get(a.conversationId); await ready;
      overrideTarget = { ...target, locator: { ...target.locator, workspaceEpoch: 'replaced' } };
      release(); const response = await pending; hold = null; overrideTarget = null;
      assert.equal(response.status, 409); assert.equal(response.body.toolSummary, undefined); assert.equal(response.body.messages, undefined);
    });
    await check('late read is rejected when captured file proof changes', async () => {
      let release; hold = new Promise(resolve => release = resolve);
      const ready = new Promise(resolve => entered = resolve);
      const pending = get(a.conversationId); await ready;
      overrideTarget = { ...target, sessionIdentity: { ...target.sessionIdentity, ino: 0 } };
      release(); const response = await pending; hold = null; overrideTarget = null;
      assert.equal(response.status, 409); assert.equal(response.body.toolSummary, undefined);
    });
    await check('backend restart retains dormant summary without launching Pi', async () => {
      await registry.dispose(); registry = createRuntimeRegistry(options);
      assert.equal((await get(a.conversationId)).body.toolSummary.items[0].status, 'completed');
      assert.equal(factories, beforeFactories); assert.equal(registry.liveCount(), 0);
    });
    await check('legacy injected reader remains compatible without summary data', async () => {
      const legacy = createRuntimeRoutes({ registry, readHistory: () => ({ ok: true, messages: [], truncated: false }) });
      const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
      await legacy.handle({ method: 'GET', url: '/api/runtime-sessions?conversationId=' + a.conversationId }, response);
      assert.equal(response.status, 200); assert.deepEqual(response.body.messages, []);
      assert.equal(response.body.toolSummary, undefined);
    });
  } finally {
    await registry.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  console.log(`History tool summary HTTP: ${checks}/${checks} cases; ${assertions}/${assertions} assertions; skipped=0`);
})().catch(e => { console.error(e); process.exitCode = 1; });
