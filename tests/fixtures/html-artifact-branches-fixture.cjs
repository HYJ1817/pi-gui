'use strict';
// Only for html-artifact-branches.cjs. Every writable path belongs to its TEMP root.
// The external Pi RPC and Electron registration are explicit fixture boundaries.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { bundle } = require('../esm-bundle.cjs');
const PUB = path.resolve(__dirname, '../../public');
const STAMP = '2026-11-27T00:00:00.000Z';
const text = value => [{ type: 'text', text: value }];
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const entry = (id, parentId, role, content, extra = {}) => ({ type: 'message', id, parentId, timestamp: STAMP,
  message: { role, content, timestamp: Date.parse(STAMP), ...extra } });
const ownerFor = (conversationId, sessionId) => ({ backendInstance: 'branches-backend', projectId: 'branches-project',
  repoId: 'branches-repo', workspaceId: 'branches-workspace', workspaceEpoch: 'epoch-1', conversationId,
  runtimeId: 'runtime-' + conversationId, runtimeGeneration: 'generation-1', sessionId });

async function fixture(t, assert) {
  const { createHtmlArtifactStore } = await import('../../server/html-artifact-store.js');
  const { createHtmlArtifactHttp, createHtmlArtifactAuthority } = await import('../../server/html-artifact-http.js');
  const { projectHtmlArtifacts } = await import('../../server/html-artifact-projection.js');
  const { htmlSessionIdentity, readHtmlArtifactSession } = await import('../../server/html-artifact-sessions.js');
  const { activePath } = await import('../../server/session-edit-target.js');
  const { readExecutionBranch } = await import('../../server/execution-timeline.js');
  const { readSessionMessages } = await import('../../server/session-history.js');
  const { createSessions } = await import('../../server/sessions.js');
  const { createMessageEditService } = await import('../../server/message-edit.js');
  const { createMessageEditRoutes } = await import('../../server/message-edit-routes.js');
  const { createRuntimeRoutes } = await import('../../server/runtime-routes.js');
  const { createRouter } = await import('../../server/router.js');
  const { createAuth } = await import('../../server/auth.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-branches-')), cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const cwd = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  const nativeDir = path.join(home, '.pi', 'agent', 'sessions', '--fixture--');
  for (const dir of [cwd, data, nativeDir]) fs.mkdirSync(dir, { recursive: true });
  let sequence = 0;
  class Native {
    constructor(rows = [], sessionId = randomUUID(), parentSession = null) {
      this.sessionId = sessionId;
      this.file = path.join(nativeDir, `2026-11-27T00-00-00-000Z_${sessionId}.jsonl`);
      this.header = { type: 'session', version: 3, id: sessionId, timestamp: STAMP, cwd,
        ...(parentSession ? { parentSession } : {}) };
      this.rows = clone(rows); this.leafId = rows.at(-1)?.id ?? null; this.epoch = 0; this.calls = [];
      fs.writeFileSync(this.file, [this.header, ...this.rows].map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    branch(id) {
      assert.ok(id === null || this.rows.some(row => row.id === id), 'fixture branch resolves an actual native entry');
      this.leafId = id; this.epoch++; // Pi branch() does not append or persist a leaf marker.
    }
    append(row) {
      this.rows.push(clone(row)); this.leafId = row.id;
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    }
    path() { return activePath(this.rows, this.leafId); }
    messages() { return projectHtmlArtifacts(this.path().filter(row => row.type === 'message').map(row => row.message)); }
    fork(leafId = this.leafId) {
      // createBranchedSession: retain the selected path and original message IDs,
      // but assign a new native header.id. No label entries in these fixtures.
      return new Native(activePath(this.rows, leafId), randomUUID(), this.file);
    }
    async request(command) {
      this.calls.push(clone(command));
      const ok = data => ({ ok: true, data });
      if (command.type === 'get_state') return ok({ sessionId: this.sessionId, sessionFile: this.file,
        isStreaming: false, isCompacting: false, pendingMessageCount: 0, model: { provider: 'fixture', id: 'offline' } });
      if (command.type === 'get_entries') return ok({ entries: clone(this.rows), leafId: this.leafId });
      if (command.type === 'get_messages') return ok({ messages: this.messages() });
      if (command.type === 'get_commands') return ok({ commands: [{ name: 'branches-edit' }] });
      if (command.type !== 'prompt') throw Error('Unexpected offline fixture RPC: ' + command.type);
      if (command.message.startsWith('/branches-edit ')) {
        const [name, targetId, leaf, parent, sessionId, _requestId, token] = command.message.split(' ');
        assert.equal(name, '/branches-edit'); assert.equal(token, 'branches-edit-capability');
        assert.equal(sessionId, this.sessionId); assert.equal(leaf, this.leafId);
        const target = this.rows.find(row => row.id === targetId);
        assert.equal(parent, target.parentId ?? '-');
        // Test edit targets have an assistant leaf, so no restore guard is needed.
        this.branch(target.message?.role === 'user' ? target.parentId : target.id);
        return ok({ disposition: 'handled' });
      }
      this.append(entry('e' + (++sequence).toString(16).padStart(7, '0'), this.leafId, 'user', text(command.message)));
      return ok({ disposition: 'started' });
    }
  }
  const store = createHtmlArtifactStore({ dataDir: data });
  const source = new Native();
  const html = ['<section><p>BRANCH_EARLY_继承内容</p></section>', '<section><p>BRANCH_LATE_旧回复</p></section>'];
  const artifacts = [];
  for (let i = 1; i <= 2; i++) {
    const suffix = i.toString(16).padStart(7, '0');
    source.append(entry('1' + suffix, source.leafId, 'user', text('question ' + i)));
    const call = { type: 'toolCall', id: 'call-' + i, name: 'html_render', arguments: { html: html[i - 1] } };
    source.append(entry('2' + suffix, source.leafId, 'assistant', [call]));
    const ref = await store.publish({ sessionId: source.sessionId, messageId: '2' + suffix,
      toolCallId: call.id, title: 'Branch fixture ' + i, html: html[i - 1], height: 320 });
    artifacts.push(ref);
    source.append(entry('3' + suffix, source.leafId, 'toolResult', text('HTML: ' + ref.title), {
      toolName: 'html_render', toolCallId: call.id, isError: false,
      details: { kind: 'html_artifact', schemaVersion: 1, ok: true, artifact: ref } }));
    source.append(entry('4' + suffix, source.leafId, 'assistant', text('answer ' + i)));
  }
  const world = { root, cwd, data, Native, source, store, artifacts, html, projectHtmlArtifacts, activePath,
    readHtmlArtifactSession, htmlSessionIdentity, classic: source, runtimes: new Map(), dormant: new Map(), reads: [], readHook: null };
  const currentClassicOwner = () => ownerFor('classic-chat', world.classic.sessionId);
  const sessions = createSessions({ homeDir: home, dataDir: data, env: {},
    runtime: { getCurrentCwd: () => cwd }, rpc: { request: async cmd => (await world.classic.request(cmd)).data },
    getProjects: () => [{ path: cwd }], readHistory: (file, expected) => readSessionMessages(file, { expected }) });
  world.sessions = sessions;
  const nativeBranch = (native, scope, cb) => readExecutionBranch({ scope, branchEpoch: native.epoch,
    readState: async () => (await native.request({ type: 'get_state' })).data,
    readEntries: async () => (await native.request({ type: 'get_entries' })).data,
    isCurrent: () => scope.kind === 'runtime'
      ? world.runtimes.get(scope.owner.conversationId)?.native === native : world.classic === native, onVerifiedPath: cb });
  const service = createMessageEditService({ pollTimeoutMs: 200, pollIntervalMs: 5 });
  cleanups.push(() => service.dispose());
  const runtimeIo = expected => {
    const record = world.runtimes.get(expected.conversationId);
    assert.deepEqual(record?.owner, expected);
    return { scope: 'runtime', conversationId: expected.conversationId, sessionId: record.native.sessionId,
      commandName: () => 'branches-edit', editToken: () => 'branches-edit-capability', getBridgeRun: () => 1,
      validate: () => assert.deepEqual(world.runtimes.get(expected.conversationId)?.owner, expected),
      request: cmd => record.native.request(cmd) };
  };
  const registry = {
    getOwner: id => world.runtimes.get(id)?.owner ?? null,
    executionBranch: (expected, _detail, cb) => nativeBranch(world.runtimes.get(expected.conversationId).native, { kind: 'runtime', owner: expected }, cb),
    historyTarget: id => world.dormant.get(id) ?? null,
    ownsNativeSession: id => [...world.runtimes.values()].some(record => record.native.sessionId === id),
    snapshot: () => ({ ok: true, backendInstance: 'branches-backend', items: world.items() }),
    read: async (expected, command) => projectHtmlArtifacts((await runtimeIo(expected).request(command)).data),
    editPreflight: (expected, input) => service.preflight(runtimeIo(expected), input),
    editResend: (expected, input) => service.resend(runtimeIo(expected), input),
  };
  world.bind = (mode, native, id = 'runtime-inherited') => {
    if (mode === 'classic') world.classic = native;
    else world.runtimes.set(id, { native, owner: ownerFor(id, native.sessionId) });
    return world.scope(mode, id);
  };
  world.scope = (mode, id = 'runtime-inherited') => mode === 'classic'
    ? { conversationId: 'classic-chat', owner: currentClassicOwner() }
    : { conversationId: id, owner: world.runtimes.get(id).owner };
  world.retire = (id, native) => {
    world.runtimes.delete(id);
    const locator = { conversationId: id, nativeSessionId: native.sessionId, projectId: 'branches-project', repoId: 'branches-repo',
      workspaceId: 'branches-workspace', workspaceEpoch: 'epoch-1' };
    world.dormant.set(id, { sessionId: native.sessionId, sessionLocator: native.file,
      sessionIdentity: htmlSessionIdentity(native.file), cwd, locator });
    return locator;
  };
  world.items = () => [
    ...[...world.runtimes].map(([conversationId, record]) => ({ conversationId, owner: record.owner,
      nativeSessionId: record.native.sessionId, lifecycle: 'ready', activity: 'idle',
      workspace: { projectId: 'branches-project', repoId: 'branches-repo', workspaceId: 'branches-workspace', workspaceEpoch: 'epoch-1' } })),
    ...[...world.dormant].map(([conversationId, target]) => ({ conversationId, owner: null,
      nativeSessionId: target.sessionId, lifecycle: 'dormant', activity: 'idle', workspace: { ...target.locator } })),
  ];
  const authority = createHtmlArtifactAuthority({ registry, sessions, getClassicOwner: currentClassicOwner,
    getClassicCwd: () => cwd, readClassicBranch: (expected, cb) => nativeBranch(world.classic, {
      kind: 'classic', bridgeInstance: expected.runtimeId, bridgeRun: 1,
      workspaceKey: expected.workspaceId, workspaceGeneration: 1, sessionId: expected.sessionId }, cb) });
  const artifactsHttp = createHtmlArtifactHttp({ resolveScope: authority, store: { async read(id) {
    const value = await store.read(id); await world.readHook?.(); return value;
  } } });
  const runtimeRoutes = createRuntimeRoutes({ registry, readHistory: (file, expected) => readSessionMessages(file, { expected }) });
  const editRoutes = createMessageEditRoutes({ service, getOwner: currentClassicOwner,
    request: cmd => world.classic.request(cmd), commandName: () => 'branches-edit', editToken: () => 'branches-edit-capability',
    getSessionId: () => world.classic.sessionId, getBridgeRun: () => 1, getWorkspaceGeneration: () => 1, getCwd: () => cwd });
  let router;
  const server = http.createServer((req, res) => router(req, res));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port, url = `http://127.0.0.1:${port}`, token = randomUUID();
  router = createRouter({ auth: createAuth({ token, port }), htmlArtifacts: artifactsHttp, sessions,
    runtimeSessions: runtimeRoutes, messageEdit: editRoutes, requireLegacyScope: () => true, legacyScope: currentClassicOwner });
  world.request = async (route, body, owner = currentClassicOwner()) => {
    const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token, origin: url, 'content-type': 'application/json', 'x-pi-gui-owner': JSON.stringify(owner) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  world.read = (ref, scope) => world.request('/api/html-artifacts/read', { id: ref.id, scope });
  world.owner = currentClassicOwner;
  world.snapshots = () => fs.readdirSync(path.join(data, 'html-artifacts')).filter(name => /^[a-f0-9]{64}$/.test(name)).sort();

  const scripts = new Map();
  world.surface = (mode = 'classic') => {
    const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
      url: url + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window, document = w.document, surface = { w, document, dom, reads: [], releases: [], registered: [] };
    w.TextEncoder = TextEncoder;
    // Node's real fetch validates signal identity; jsdom's cross-realm signal
    // is not a Node AbortSignal. Use the paired native host primitives together.
    w.AbortController = AbortController; w.AbortSignal = AbortSignal;
    w.fetch = async (route, init = {}) => {
      const target = new URL(route, url);
      if (target.origin !== url) throw Error('Fixture forbids non-loopback requests');
      const headers = { ...init.headers, authorization: 'Bearer ' + token, origin: url };
      const response = await fetch(target, { ...init, headers });
      if (target.pathname === '/api/html-artifacts/read') {
        const record = { request: JSON.parse(init.body), status: response.status, body: await response.clone().json() };
        surface.reads.push(record); world.reads.push(record);
      }
      return response;
    };
    w.piGuiDesktop = { htmlArtifacts: {
      registerFrame: async request => { surface.registered.push(request); return { ok: true, javascriptEnabled: true }; },
      releaseFrame: request => surface.releases.push(request),
    } };
    const module = mode === 'classic' ? 'messages.js' : 'runtime-conversation.js';
    if (!scripts.has(module)) scripts.set(module, bundle(path.join(PUB, module)).code);
    w.eval(scripts.get(module)); w.S.legacyOwner = currentClassicOwner();
    if (mode === 'runtime') {
      w.runtimeStore.seed({ backendInstance: 'branches-backend', items: world.items() });
      surface.host = document.createElement('div'); document.body.append(surface.host);
      surface.view = w.createRuntimeConversation({ host: surface.host });
    }
    surface.hydrate = async (native, id = 'runtime-inherited') => {
      if (mode === 'classic') {
        w.S.legacyOwner = currentClassicOwner(); w.rebuildFromMessages(native.messages(), native.sessionId);
      } else {
        w.runtimeStore.seed({ backendInstance: 'branches-backend', items: world.items() });
        const record = w.runtimeStore.get(id);
        const reply = await w.runtimeSessionAction({ action: 'read', owner: record.owner, command: { type: 'get_messages' } });
        assert.equal(reply.ok, true);
        assert.equal(w.runtimeStore.history(id, reply.data.messages, record.owner, record.cursor), true);
        surface.view.show(id); surface.view.draw();
      }
    };
    surface.clear = () => mode === 'classic' ? w.clearThread() : surface.view.leave();
    cleanups.push(() => { surface.view?.dispose(); w.clearThread?.(); w.disposeHtmlArtifacts?.(document.body); dom.window.close(); });
    return surface;
  };
  return world;
}

async function waitFor(condition, message) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error('Timed out: ' + message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function loaded(surface, refs, assert) {
  await waitFor(() => refs.every(ref => surface.document.querySelector(`[data-artifact-id="${ref.id}"] iframe`)?.srcdoc), 'production renderer scoped artifact reads');
  for (const ref of refs) {
    const node = surface.document.querySelector(`[data-artifact-id="${ref.id}"]`), frame = node.querySelector('iframe');
    const nonce = frame.srcdoc.match(/"nonce":"([a-f0-9]+)"/)?.[1];
    assert.ok(nonce, 'loaded protocol document has a fresh nonce');
    surface.w.dispatchEvent(new surface.w.MessageEvent('message', { origin: 'null', source: frame.contentWindow,
      data: { schemaVersion: 1, type: 'ready', id: ref.id, nonce } }));
    assert.equal(node.dataset.state, 'ready');
    const read = surface.reads.find(record => record.request.id === ref.id && record.status === 200);
    assert.ok(read, 'bytes came from real authenticated HTTP, not a renderer fetch stub');
    assert.deepEqual(read.body.artifact, ref);
    assert.equal(digest(read.body.html), ref.digest);
    assert.equal(Buffer.byteLength(read.body.html), ref.bytes);
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  }
}
module.exports = { fixture, waitFor, loaded, entry, text, digest };
