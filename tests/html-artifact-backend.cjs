// Offline backend behavior/security tests. Every writable path is an os.tmpdir fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

(async () => {
  const { createHtmlArtifactStore } = await import('../server/html-artifact-store.js');
  const { projectHtmlArtifacts, createHtmlArtifactProjection, htmlReferencesInPath } = await import('../server/html-artifact-projection.js');
  const { createHtmlArtifactAuthority, createHtmlArtifactHttp } = await import('../server/html-artifact-http.js');
  const { createHtmlRenderBridge } = await import('../server/html-render-bridge.js');
  const { readExecutionBranch } = await import('../server/execution-timeline.js');
  const { readHtmlArtifactSession, scanHtmlArtifactReferences, createHtmlArtifactReconciler } = await import('../server/html-artifact-sessions.js');
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const { projectRuntimeEvent } = await import('../server/session-runtime.js');
  const { installHtmlRender, htmlTransport } = await import('../extensions/pi-gui-html/index.js');
  const { readSessionMessages } = await import('../server/session-history.js');
  const { scrubInternalEnv } = await import('../server/child-env.js');
  await test('HTML artifact backend', async t => {
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-backend-'));
    t.after(() => fs.rmSync(world, { recursive: true, force: true }));
    const store = createHtmlArtifactStore({ dataDir: world });
    const input = { sessionId: 'native-a', messageId: 'assistant-a', toolCallId: 'call-a', title: 'Fixture', html: '<!doctype html><p>HTML_CANARY_秘密</p>', height: 320 };
    const artifact = await store.publish(input);
    const details = { kind: 'html_artifact', schemaVersion: 1, ok: true, artifact };
    const assistant = { type: 'message', id: input.messageId, parentId: null, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'html_render', id: input.toolCallId, arguments: { html: input.html } }] } };
    const result = { type: 'message', id: 'result-a', parentId: assistant.id, message: { role: 'toolResult', toolName: 'html_render', toolCallId: input.toolCallId, content: [{ type: 'text', text: input.html }], details: { ...details, raw: input.html } } };
    let entries = [assistant, result], leafId = result.id, epoch = 0;
    let owner = { backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'workspace', workspaceEpoch: 'epoch', conversationId: 'conversation-a', runtimeId: 'runtime', runtimeGeneration: 'generation', sessionId: input.sessionId };
    let classic = { ...owner, conversationId: 'classic-chat', runtimeId: 'classic', runtimeGeneration: '1', workspaceEpoch: '1', sessionId: 'classic-native' };
    let dormant = null, classicTarget = null, liveNative = false;
    const branch = (scope, callback) => readExecutionBranch({ scope, branchEpoch: epoch,
      readState: async () => ({ sessionId: scope.kind === 'runtime' ? scope.owner.sessionId : scope.sessionId }),
      readEntries: async () => ({ entries, leafId }), isCurrent: () => true, onVerifiedPath: callback });
    const registry = { getOwner: id => id === 'conversation-a' ? owner : null,
      executionBranch: (expected, _detail, cb) => branch({ kind: 'runtime', owner: expected }, cb),
      historyTarget: () => dormant, ownsNativeSession: () => liveNative };
    const authority = createHtmlArtifactAuthority({ registry, sessions: { resolveProjectSession: () => classicTarget },
      getClassicOwner: () => classic, getClassicCwd: () => world,
      readClassicBranch: (expected, cb) => branch({ kind: 'classic', bridgeInstance: expected.runtimeId, bridgeRun: 1,
        workspaceKey: expected.workspaceId, workspaceGeneration: 1, sessionId: expected.sessionId }, cb) });
    let readHook = null;
    const handler = createHtmlArtifactHttp({ store: { read: async id => { const value = await store.read(id); await readHook?.(); return value; } }, resolveScope: authority });
    let router;
    const server = http.createServer((req, res) => router(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const port = server.address().port, url = `http://127.0.0.1:${port}`, token = 'fixture-public-token';
    router = createRouter({ auth: createAuth({ token, port }), htmlArtifacts: handler, requireLegacyScope: () => true });
    const request = async (body, options = {}) => {
      const response = await fetch(url + '/api/html-artifacts/read', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...options.headers }, body: typeof body === 'string' ? body : JSON.stringify(body), ...options });
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    const payload = () => ({ id: artifact.id, scope: { conversationId: 'conversation-a', owner: { ...owner } } });
    await t.test('real Router enforces token and Origin before artifact authority', async () => {
      assert.equal((await request(payload(), { headers: {} })).status, 401);
      const cross = await request(payload(), { headers: { origin: 'https://foreign.invalid' } });
      assert.equal(cross.status, 403); assert.ok(!JSON.stringify(cross).includes(token));
    });
    await t.test('live Runtime read proves native branch and returns exact immutable bytes', async () => {
      const value = await request(payload());
      assert.equal(value.status, 200); assert.deepEqual(value.body, { ok: true, artifact, html: input.html });
      assert.equal(value.headers.get('cache-control'), 'no-store');
      assert.equal(value.headers.get('x-content-type-options'), 'nosniff');
    });
    await t.test('live Classic uses conversationId plus full legacyOwner, not focused Runtime', async () => {
      const value = await request({ id: artifact.id, scope: { conversationId: 'classic-chat', owner: classic } });
      assert.equal(value.status, 200);
    });
    for (const [name, modify, code] of [
      ['wrong owner epoch', p => { p.scope.owner.workspaceEpoch = 'old'; }, 'stale_runtime'],
      ['missing owner', p => { delete p.scope.owner; }, 'stale_runtime'],
      ['extra owner field', p => { p.scope.owner.path = world; }, 'stale_runtime'],
      ['path input', p => { p.sessionFile = world; }, 'invalid_request'],
      ['old artifactId API', p => { p.artifactId = p.id; delete p.id; }, 'invalid_request'],
      ['extra scope field', p => { p.scope.sessionFile = world; }, 'invalid_request'],
      ['foreign valid ID', p => { p.id = hash('foreign'); }, 'reference_pending'],
      ['path as ID', p => { p.id = '../document.html'; }, 'invalid_request'],
    ]) await t.test(name + ' fails without raw bytes or paths', async () => {
      const p = payload(); modify(p); const value = await request(p);
      assert.equal(value.status, code === 'invalid_request' ? 400 : 409); assert.deepEqual(value.body, { ok: false, code });
      assert.ok(!JSON.stringify(value.body).includes(world)); assert.ok(!JSON.stringify(value.body).includes('HTML_CANARY'));
    });
    await t.test('malformed, oversized and empty JSON are invalid requests', async () => {
      for (const value of ['{', 'null', '{}', JSON.stringify({ ...payload(), extra: 'x'.repeat(9000) })]) assert.equal((await request(value)).status, 400);
      assert.equal((await fetch(url + '/api/html-artifacts/read', { headers: { authorization: 'Bearer ' + token } })).status, 405);
    });
    await t.test('tool event or stored snapshot alone never authorizes a read', async () => {
      entries = [assistant]; leafId = assistant.id;
      assert.equal((await request(payload())).body.code, 'reference_pending');
      entries = [assistant, result]; leafId = 'unresolved-native-leaf';
      assert.equal((await request(payload())).body.code, 'reference_pending'); leafId = result.id;
    });
    await t.test('branch/epoch and owner mutation during storage read discard the old result', async () => {
      readHook = () => { epoch++; };
      assert.equal((await request(payload())).body.code, 'reference_pending');
      readHook = () => { owner = { ...owner, runtimeGeneration: 'next-generation' }; };
      assert.equal((await request(payload())).body.code, 'stale_runtime'); readHook = null;
    });
    await t.test('reused call IDs and duplicate native results do not authorize a foreign assistant', () => {
      assert.deepEqual(htmlReferencesInPath([assistant, { ...result, message: { ...result.message, details: { ...details, artifact: { ...artifact, messageId: 'different-assistant' } } } }]), []);
      assert.deepEqual(htmlReferencesInPath([assistant, result, { ...result, id: 'duplicate' }]), []);
      assert.equal(htmlReferencesInPath([assistant, result]).length, 1);
    });
    const root = path.join(world, 'native'); fs.mkdirSync(root);
    const nativeFile = path.join(root, 'fixture.jsonl');
    const writeNative = rows => fs.writeFileSync(nativeFile, [JSON.stringify({ type: 'session', version: 3, id: input.sessionId, cwd: world }), ...rows.map(row => JSON.stringify(row)), ''].join('\n'));
    writeNative([assistant, result]);
    const stat = fs.statSync(nativeFile), sessionIdentity = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
    dormant = { sessionId: input.sessionId, sessionLocator: nativeFile, sessionIdentity, cwd: world, locator: { conversationId: 'dormant' } };
    await t.test('dormant Runtime reads a proven v3 restored branch without spawning', async () => {
      assert.equal((await request({ id: artifact.id, scope: { conversationId: 'dormant' } })).status, 200);
      assert.equal((await request({ id: artifact.id, scope: { conversationId: 'dormant', owner } })).body.code, 'stale_runtime');
    });
    await t.test('Classic historical sessionId is a 16-character list ID, never a path or native UUID', async () => {
      classicTarget = { file: nativeFile, sessionId: input.sessionId, cwd: world };
      assert.equal((await request({ id: artifact.id, scope: { sessionId: 'a'.repeat(16) } })).status, 200);
      assert.equal((await request({ id: artifact.id, scope: { sessionId: input.sessionId } })).body.code, 'invalid_request');
    });
    await t.test('file restore cannot impersonate another live child memory-only leaf', async () => {
      liveNative = true;
      for (const scope of [{ conversationId: 'dormant' }, { sessionId: 'a'.repeat(16) }]) assert.equal((await request({ id: artifact.id, scope })).body.code, 'reference_pending');
      liveNative = false;
    });
    await t.test('old physical branch is retained but not readable from the restored branch', async () => {
      writeNative([assistant, result, { type: 'message', id: 'other-leaf', parentId: null, message: { role: 'user', content: 'other' } }]);
      assert.equal(readHtmlArtifactSession(nativeFile).branch.length, 1);
      assert.equal((await request({ id: artifact.id, scope: { conversationId: 'dormant' } })).body.code, 'reference_pending');
      assert.equal(scanHtmlArtifactReferences([root]).referencedIds.has(artifact.id), true);
    });
    await t.test('copied fork inherits a reference without rewriting the snapshot identity', async () => {
      const fork = path.join(root, 'fork.jsonl');
      fs.writeFileSync(fork, [JSON.stringify({ type: 'session', version: 3, id: 'fork-native', cwd: world }), JSON.stringify(assistant), JSON.stringify(result), ''].join('\n'));
      assert.equal(htmlReferencesInPath(readHtmlArtifactSession(fork).branch)[0].sessionId, input.sessionId);
    });
    await t.test('retention includes dormant, trash and all physical leaves', async () => {
      const trash = path.join(world, 'trash'); fs.mkdirSync(trash); fs.copyFileSync(nativeFile, path.join(trash, 'trashed.jsonl'));
      const scanned = scanHtmlArtifactReferences([root, trash]);
      assert.equal(scanned.complete, true); assert.equal(scanned.files, 3); assert.ok(scanned.referencedIds.has(artifact.id));
      const reconciler = createHtmlArtifactReconciler({ store, roots: () => [root, trash], graceMs: 0 });
      const first = await reconciler.reconcile(); assert.equal(first.removed, 0); assert.equal(first.retained, 1);
      assert.equal(fs.existsSync(path.join(world, 'html-artifacts', artifact.id, '.pending')), false);
      await reconciler.dispose();
    });
    await t.test('incomplete native scans never collect even a known orphan', async () => {
      fs.writeFileSync(path.join(root, 'broken.jsonl'), 'partial');
      let collections = 0;
      const reconciler = createHtmlArtifactReconciler({ store: { collect: () => { collections++; } }, roots: () => [root] });
      assert.equal((await reconciler.reconcile()).reason, 'native_scan_incomplete'); assert.equal(collections, 0);
      await reconciler.dispose(); fs.unlinkSync(path.join(root, 'broken.jsonl'));
    });
    await t.test('disposal during a delayed scan prevents collection and joins the scan', async () => {
      const gate = deferred(); let collections = 0;
      const reconciler = createHtmlArtifactReconciler({ store: { collect: () => { collections++; } }, roots: () => [], scan: () => gate.promise });
      const running = reconciler.reconcile(), disposed = reconciler.dispose();
      gate.resolve({ complete: true, files: 0, referencedIds: new Set() });
      assert.equal((await running).reason, 'disposed'); await disposed; assert.equal(collections, 0);
    });
    await t.test('dynamic publication inventory is not a fixed session-count admission limit', async () => {
      let cutoff;
      const reconciler = createHtmlArtifactReconciler({ store: { collect: async value => { cutoff = value.beforeMs; return { removed: 0 }; } }, roots: () => [], graceMs: 0,
        scan: () => ({ complete: true, files: 0, referencedIds: new Set() }) });
      const finishes = Array.from({ length: 20000 }, () => reconciler.begin());
      await reconciler.reconcile(); assert.ok(cutoff <= Date.now()); finishes.forEach(finish => finish()); await reconciler.dispose();
    });
    await t.test('generic/Runtime/history wrappers and stream deltas contain refs but no HTML arguments', () => {
      const wrappers = [assistant.message, result.message, { type: 'agent_end', messages: [assistant.message, result.message] },
        { type: 'turn_end', toolResults: [result.message] }, { type: 'entry_appended', entry: result },
        { type: 'response', command: 'get_tree', data: { tree: [{ entry: assistant, children: [{ entry: result }] }] } },
        { type: 'message_update', message: assistant.message, assistantMessageEvent: { type: 'toolcall_delta', delta: JSON.stringify({ html: input.html }), partial: assistant.message } },
        { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: assistant.message.content[0] } },
        { type: 'tool_execution_start', toolName: 'html_render', toolCallId: input.toolCallId, args: { html: input.html } },
        { type: 'tool_execution_update', toolName: 'html_render', partialResult: { content: [{ type: 'text', text: input.html }] } },
        { type: 'tool_execution_end', toolName: 'html_render', result: result.message }];
      for (const wrapper of wrappers) {
        const original = JSON.stringify(wrapper), safe = projectHtmlArtifacts(wrapper), runtime = projectRuntimeEvent(wrapper);
        assert.ok(!JSON.stringify(safe).includes('HTML_CANARY')); assert.ok(!JSON.stringify(runtime).includes('HTML_CANARY'));
        assert.equal(JSON.stringify(wrapper), original);
      }
      const projected = projectRuntimeEvent({ type: 'tool_execution_end', toolName: 'html_render', result: result.message });
      assert.deepEqual(projected.result.details.artifact, artifact);
      assert.deepEqual(projectHtmlArtifacts(result.message).details, details);
      writeNative([assistant, result]); assert.ok(!JSON.stringify(readSessionMessages(nativeFile)).includes('HTML_CANARY'));
    });
    await t.test('legacy nameless completions retain ordinary tool output but never HTML bytes', () => {
      const project = createHtmlArtifactProjection();
      project({ type: 'tool_execution_start', toolCallId: 'ordinary', toolName: 'read', bridgeRun: 1 });
      assert.equal(project({ type: 'tool_execution_end', toolCallId: 'ordinary', result: { content: 'ordinary output' }, bridgeRun: 1 }).result.content, 'ordinary output');
      project({ type: 'tool_execution_start', toolCallId: 'html', toolName: 'html_render', bridgeRun: 1 });
      assert.ok(!JSON.stringify(project({ type: 'tool_execution_end', toolCallId: 'html', result: { content: input.html }, bridgeRun: 1 })).includes('HTML_CANARY'));
      assert.ok(!JSON.stringify(project({ type: 'tool_execution_end', toolCallId: 'unknown', result: { content: input.html }, bridgeRun: 2 })).includes('HTML_CANARY'));
    });
    await t.test('GUI child environments strip the new private capability', () => {
      const env = scrubInternalEnv({ PI_GUI_HTML_URL: 'http://127.0.0.1:1', PI_GUI_HTML_TOKEN: 'private', OTHER: 'kept' });
      assert.equal(env.PI_GUI_HTML_URL, undefined); assert.equal(env.PI_GUI_HTML_TOKEN, undefined); assert.equal(env.OTHER, 'kept');
    });
    // Real private HTTP + real extension execute + real immutable store, with
    // only native RPC reads supplied by the fixture above (no Pi or model).
    let current = true, nativeReads = 0;
    const bridge = createHtmlRenderBridge({ store, supported: true, launch: { identityKey: () => 'source' }, getCwd: () => world,
      capture: () => ({ sessionId: input.sessionId, owner: { ...owner } }), isCurrent: () => current,
      scopeForWitness: witness => ({ kind: 'runtime', owner: witness.owner }),
      readState: async () => ({ sessionId: input.sessionId }), readEntries: async () => { nativeReads++; return { entries: [assistant], leafId: assistant.id }; } });
    t.after(() => bridge.dispose());
    const prepared = await bridge.prepare();
    const connection = { url: prepared.env.PI_GUI_HTML_URL, token: prepared.env.PI_GUI_HTML_TOKEN };
    const hooks = new Map(); let tool;
    const installed = installHtmlRender({ on: (name, fn) => hooks.set(name, fn), registerTool: value => { tool = value; } }, connection);
    t.after(() => installed.dispose());
    const ctx = { cwd: world, sessionManager: { getSessionId: () => input.sessionId, getLeafId: () => assistant.id, getBranch: () => [assistant] } };
    await t.test('bundled extension returns only a reference after strict two-pass native verification', async () => {
      hooks.get('session_start')({}, ctx);
      const value = await tool.execute(input.toolCallId, input, undefined, undefined, ctx);
      assert.equal(value.isError, undefined); assert.deepEqual(value.details, details);
      assert.ok(!JSON.stringify(value).includes('HTML_CANARY')); assert.ok(nativeReads >= 4);
    });
    await t.test('immutable tuple conflicts map the real store code without leaking bytes', async () => {
      const value = await tool.execute(input.toolCallId, { ...input, html: '<p>changed</p>' }, undefined, undefined, ctx);
      assert.equal(value.isError, true); assert.equal(value.details.code, 'html_immutable_conflict');
      assert.equal((await store.read(artifact.id)).html, input.html);
    });
    await t.test('private bridge denies wrong capabilities, browser Origins and malformed bodies', async () => {
      const bad = await fetch(connection.url + '/hello', { method: 'POST', headers: { 'x-pi-gui-html-token': 'é'.repeat(64) }, body: '{}' });
      assert.equal(bad.status, 403);
      const cross = await fetch(connection.url + '/hello', { method: 'POST', headers: { origin: url, 'x-pi-gui-html-token': connection.token }, body: '{}' });
      assert.equal(cross.status, 403);
      await assert.rejects(htmlTransport({ ...connection, url: 'https://foreign.invalid' }, 'hello', {}), { code: 'html_bridge_unavailable' });
    });
    await t.test('Stop rejects in-flight publications until a new admitted turn resumes the binding', async () => {
      bridge.pause(); const paused = await tool.execute(input.toolCallId, input, undefined, undefined, ctx);
      assert.equal(paused.isError, true); bridge.resume();
      assert.equal((await tool.execute(input.toolCallId, input, undefined, undefined, ctx)).isError, undefined);
    });
    await t.test('old owner, cancelled execute and revoked capability fail closed', async () => {
      current = false; assert.equal((await tool.execute(input.toolCallId, input, undefined, undefined, ctx)).isError, true); current = true;
      const controller = new AbortController(); controller.abort();
      assert.equal((await tool.execute(input.toolCallId, input, controller.signal, undefined, ctx)).details.code, 'html_cancelled');
      bridge.invalidate(); assert.equal((await tool.execute(input.toolCallId, input, undefined, undefined, ctx)).isError, true);
    });
    await t.test('unsupported source contract is an optional capability, not a startup exception', async () => {
      const unavailable = createHtmlRenderBridge({ store, launch: { packageDir: () => world }, getCwd: () => world });
      assert.equal(await unavailable.prepare(), null); await unavailable.dispose();
    });
    await bridge.dispose();
    await t.test('disposed private bridge closes the port and cannot restart', async () => {
      await assert.rejects(fetch(connection.url + '/hello')); assert.equal(await bridge.prepare(), null);
    });
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
