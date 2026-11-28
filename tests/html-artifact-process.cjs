// Offline process integration: unmodified server.js -> Registry -> production
// guardian/RPC -> bundled html_render -> immutable store -> authenticated HTTP.
// This is not real Pi, a model call, Electron rendering, or P1 acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await wait(25); }
  throw Error('fixture_timeout:' + label);
}
function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })]).finally(() => clearTimeout(timer));
}

test('HTML artifact real server and guardian/RPC process integration', { timeout: 90000 }, async t => {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-process-'));
  const root = path.resolve(__dirname, '..'), data = path.join(world, 'data'), home = path.join(world, 'home');
  const projects = ['project-a', 'project-b'].map(name => path.join(world, name));
  const pkg = path.join(world, 'node_modules/@earendil-works/pi-coding-agent');
  for (const dir of [data, home, ...projects, path.join(pkg, 'dist/core/extensions'), path.join(pkg, 'dist/cli'), path.join(world, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ active: '', items: projects.map(project => ({ name: path.basename(project), path: project })) }));
  // File capture is explicitly disabled below. Keep its optional store
  // unavailable in this fixture so the artifact assertion cannot accidentally
  // depend on Windows ACL support or a writable evidence directory.
  fs.writeFileSync(path.join(data, 'revert-evidence'), 'capture-disabled-fixture');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.6.0', bin: { pi: 'cli.cjs' } }));
  // Source capability excerpts match the 1.6 public API used by production
  // probes. Nested entries/parentId/leafId match SessionManager, not a fake
  // top-level {role,content} tree or custom get_entries shortcut.
  fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), `
export interface ExtensionAPI {
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
  on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
  on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
  getAllTools(): ToolInfo[];
  registerTool<T>(definition: ToolDefinition<T>): void;
}
export interface ToolDefinition<T> { promptSnippet?: string; promptGuidelines?: string[]; execute(toolCallId: string, params: T): Promise<unknown>; }
export interface ToolCallEventResult { block?: boolean; reason?: string; }
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
`);
  fs.writeFileSync(path.join(pkg, 'dist/core/session-manager.d.ts'), 'export declare class SessionManager { getSessionId(): string; getLeafId(): string | null; getBranch(leafId?: string): SessionEntry[]; }');
  fs.writeFileSync(path.join(pkg, 'dist/cli/args.js'), 'const flags = ["--extension"];');
  fs.copyFileSync(path.join(__dirname, 'fixtures/html-artifact-fake-pi.cjs'), path.join(pkg, 'cli.cjs'));
  const token = randomUUID(), env = {};
  // Deliberate allowlist: no provider auth, real HOME, NODE_OPTIONS, npm config,
  // user Pi, shell startup or project/model selection is inherited.
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    TEMP: path.join(world, 'tmp'), TMP: path.join(world, 'tmp'), TMPDIR: path.join(world, 'tmp'),
    PORT: '0', PI_CWD: '', PI_BIN: path.join(pkg, 'cli.cjs'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
    PI_GUI_DATA: data, PI_GUI_RUNTIME_DIR: path.join(world, 'runtime'), PI_GUI_OPEN: '0', PI_GUI_OFFLINE: '1', PI_OFFLINE: '1',
    PI_GUI_TOKEN: token, PI_NO_CONTINUE: '1', PI_GUI_PROVIDER_KEY_INPUT: '0' });
  let child = null, exited = null, base, stream = null, streamTask = null, wire = '';
  const api = async (url, body, extra = {}) => {
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-pi-gui-token': token, 'content-type': 'application/json', ...extra.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
  };
  const rpc = body => api('/api/runtime-sessions', body);
  const snapshot = async () => (await api('/api/runtime-sessions')).body;
  const item = async id => (await snapshot()).items.find(row => row.conversationId === id);
  const ipc = async action => {
    const id = Math.floor(Math.random() * 1e8);
    return bounded(new Promise((resolve, reject) => {
      const receive = message => { if (message.type === 'app-update' && message.id === id) { child.off('message', receive); resolve(message); } };
      child.on('message', receive); child.send({ type: 'app-update', id, action }, error => { if (error) { child.off('message', receive); reject(error); } });
    }), 10000, 'server_ipc_timeout');
  };
  async function stop() {
    stream?.abort(); await streamTask;
    if (!child || child.exitCode !== null) return;
    // Also clean up a test that failed before its explicit close checkpoint.
    // Use production close, not PID-only kills, to join each owned guardian tree.
    for (const live of (await snapshot()).items.filter(row => row.owner))
      assert.equal((await rpc({ action: 'close', owner: live.owner })).status, 200);
    assert.equal((await ipc('prepare')).ok, true, 'production maintenance admission');
    assert.equal((await ipc('shutdown')).ok, true, 'production shutdown acknowledgment');
    await bounded(exited, 12000, 'server_shutdown_timeout'); child = null;
  }
  async function start() {
    // The production banner prints configured PORT, so allocate an ephemeral
    // loopback port first. Authentication below proves this is our own backend.
    const probe = require('node:net').createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    env.PORT = String(probe.address().port); await new Promise(resolve => probe.close(resolve));
    child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: world, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
    exited = once(child, 'exit'); exited.catch(() => {});
    let banner = '';
    child.stdout.on('data', chunk => { banner = (banner + chunk.toString()).slice(-8192); });
    const port = await until(() => /http:\/\/127\.0\.0\.1:(\d+)/.exec(banner)?.[1], 'server_listen');
    base = 'http://127.0.0.1:' + port;
    assert.equal((await api('/api/health')).body.app, 'pi-gui');
    stream = new AbortController(); wire = '';
    const response = await fetch(base + '/api/events', { headers: { 'x-pi-gui-token': token }, signal: stream.signal });
    assert.equal(response.status, 200);
    streamTask = (async () => { try { for await (const chunk of response.body) { wire += Buffer.from(chunk).toString('utf8'); assert.ok(wire.length < 4 * 1024 * 1024); } } catch (error) { if (!stream.signal.aborted) throw error; } })();
  }
  t.after(async () => {
    try { await stop(); } finally {
      if (child?.exitCode === null) { child.kill('SIGKILL'); await bounded(exited, 5000, 'forced_cleanup_timeout'); }
      fs.rmSync(world, { recursive: true, force: true });
    }
  });
  await start();
  const ids = [], owners = [], refs = [], identities = [];
  const artifactRead = (id, scope, extra) => api('/api/html-artifacts/read', { id, scope }, extra);
  await t.test('actual server Router rejects unauthenticated and foreign-Origin reads', async () => {
    const payload = { id: 'a'.repeat(64), scope: { conversationId: 'unknown' } };
    assert.equal((await api('/api/html-artifacts/read', payload, { headers: {} })).status, 401);
    assert.equal((await api('/api/html-artifacts/read', payload, { headers: { 'x-pi-gui-token': token, origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await api('/api/html-artifacts/read')).status, 405);
  });
  await t.test('two production Runtime guardian/RPC children install the bundled tool in isolated projects', async () => {
    for (const project of projects) {
      const opened = await rpc({ action: 'open-session', args: { project, requestId: randomUUID() } });
      assert.equal(opened.status, 200); assert.equal(opened.body.ok, true); ids.push(opened.body.conversationId);
      const ready = await until(async () => { const row = await item(ids.at(-1)); return row?.lifecycle === 'ready' && row.owner?.sessionId && row; }, 'runtime_ready');
      owners.push(ready.owner);
      const identity = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(project, 'fixture-launches.jsonl'), 'utf8').trim().split('\n').at(-1)); } catch { return null; } }, 'fixture_launch');
      identities.push(identity);
      assert.notEqual(identity.pid, process.pid); assert.notEqual(identity.pid, child.pid);
      assert.notEqual(identity.guardianPid, child.pid); assert.notEqual(identity.pid, identity.guardianPid);
      assert.equal(identity.native, ready.owner.sessionId); assert.ok(identity.htmlPort > 0);
    }
    assert.notEqual(identities[0].pid, identities[1].pid); assert.notEqual(identities[0].guardianPid, identities[1].guardianPid);
    assert.notEqual(owners[0].sessionId, owners[1].sessionId);
  });
  await t.test('unavailable capture fails closed until explicitly disabled, without creating a model turn', async () => {
    for (let i = 0; i < ids.length; i++) {
      const before = fs.readFileSync(identities[i].file, 'utf8');
      const rejected = await rpc({ action: 'command', owner: owners[i], command: { type: 'prompt', message: 'must not reach Pi' } });
      assert.equal(rejected.status, 409);
      assert.equal(fs.readFileSync(identities[i].file, 'utf8'), before);
      const evidence = await api('/api/session-change/evidence', undefined,
        { headers: { 'x-pi-gui-token': token, 'x-pi-gui-conversation': ids[i] } });
      assert.equal(evidence.body.ok, false);
      assert.equal(evidence.body.reason, 'evidence_privacy_unavailable');
      // Use the real user opt-out, never mock ACL success. Registry must not
      // wait for agent_settled for a command that does not reach Pi at all.
      const disabled = await rpc({ action: 'command', owner: owners[i], command: { type: 'prompt', message: '/gui-capture disable' } });
      assert.equal(disabled.status, 200, `fixture ${i + 1} capture disable: ${disabled.body.code ?? 'no_code'}`);
      assert.equal(disabled.body.ok, true);
      assert.equal((await item(ids[i])).activity, 'idle');
      assert.equal(fs.readFileSync(identities[i].file, 'utf8'), before);
      assert.equal(fs.statSync(path.join(data, 'revert-evidence')).isFile(), true);
    }
  });
  await t.test('private extension publishes refs before native persistence; HTTP stays reference_pending', async () => {
    for (let i = 0; i < ids.length; i++) {
      const prompt = await rpc({ action: 'command', owner: owners[i], command: { type: 'prompt', message: 'publish fixture' } });
      let capture = 'not_checked';
      if (prompt.status !== 200) {
        // Both routes project closed reason codes. Never print response bodies,
        // native errors, paths, tokens or the HTML when diagnosing admission.
        try {
          const evidence = await api('/api/session-change/evidence', undefined,
            { headers: { 'x-pi-gui-token': token, 'x-pi-gui-conversation': ids[i] } });
          capture = evidence.body.reason ?? evidence.body.code ?? 'no_code';
        } catch { capture = 'diagnostic_unavailable'; }
      }
      assert.equal(prompt.status, 200, `fixture ${i + 1} prompt admission: ${prompt.body.code ?? 'no_code'}; capture: ${capture}`);
      const event = await until(async () => {
        const events = (await rpc({ action: 'events', owner: owners[i], cursor: 0 })).body;
        assert.ok(!JSON.stringify(events).includes('PROCESS_HTML_CANARY'));
        return events.events?.map(frame => frame.event).find(frame => frame?.type === 'tool_execution_end');
      }, 'tool_end');
      assert.ok(event.result?.details?.artifact, 'production extension must publish a typed ref');
      refs.push(event.result.details.artifact);
      const pending = await artifactRead(refs[i].id, { conversationId: ids[i], owner: owners[i] });
      assert.equal(pending.status, 409); assert.equal(pending.body.code, 'reference_pending');
      assert.equal(fs.existsSync(path.join(data, 'html-artifacts', refs[i].id, '.pending')), true);
    }
    assert.notEqual(refs[0].id, refs[1].id); assert.equal(refs[0].toolCallId, refs[1].toolCallId);
  });
  await t.test('native typed toolResult authorizes exact immutable bytes without HTML in SSE or history', async () => {
    for (let i = 0; i < ids.length; i++) {
      fs.writeFileSync(path.join(projects[i], 'fixture-allow-native'), 'allow');
      await until(async () => (await item(ids[i])).activity === 'idle', 'native_settled');
      const value = await artifactRead(refs[i].id, { conversationId: ids[i], owner: owners[i] });
      assert.equal(value.status, 200); assert.deepEqual(value.body.artifact, refs[i]);
      assert.equal(createHash('sha256').update(value.body.html).digest('hex'), refs[i].digest);
      assert.equal(Buffer.byteLength(value.body.html), refs[i].bytes);
      assert.ok(value.body.html.includes('PROCESS_HTML_CANARY_' + path.basename(projects[i])));
      assert.equal(value.headers.get('cache-control'), 'no-store');
      const history = await api('/api/runtime-sessions?conversationId=' + ids[i]);
      assert.equal(history.status, 200); assert.ok(!history.text.includes('PROCESS_HTML_CANARY'));
      // HTML timeline block rendering belongs to the UI peer's public model;
      // this backend-only baseline proves the native ref and output isolation.
      const { readHtmlArtifactSession } = await import('../server/html-artifact-sessions.js');
      const { htmlReferencesInPath } = await import('../server/html-artifact-projection.js');
      const native = readHtmlArtifactSession(identities[i].file);
      assert.ok(native, 'physical v3 branch must be restorable');
      assert.deepEqual(htmlReferencesInPath(native.branch), [refs[i]]);
    }
    await until(() => wire.includes(refs[1].id), 'sse_ref');
    assert.ok(!wire.includes('PROCESS_HTML_CANARY')); assert.ok(!wire.includes('PI_GUI_HTML_TOKEN'));
  });
  await t.test('same-call foreign conversations and stale full owners cannot read snapshots', async () => {
    const foreign = await artifactRead(refs[0].id, { conversationId: ids[1], owner: owners[1] });
    assert.equal(foreign.status, 409); assert.equal(foreign.body.code, 'reference_pending');
    const stale = await artifactRead(refs[0].id, { conversationId: ids[0], owner: { ...owners[0], runtimeGeneration: 'old' } });
    assert.equal(stale.status, 409); assert.equal(stale.body.code, 'stale_runtime');
  });
  await t.test('production close joins guardian cleanup, revokes private ports, and permits dormant native reads', async () => {
    for (let i = 0; i < ids.length; i++) {
      assert.equal((await rpc({ action: 'close', owner: owners[i] })).status, 200);
      assert.equal((await item(ids[i])).lifecycle, 'dormant');
      await assert.rejects(fetch('http://127.0.0.1:' + identities[i].htmlPort + '/hello', { method: 'POST', signal: AbortSignal.timeout(1000) }));
      const dormant = await artifactRead(refs[i].id, { conversationId: ids[i] });
      assert.equal(dormant.status, 200, dormant.body.code);
      assert.equal((await artifactRead(refs[i].id, { conversationId: ids[i], owner: owners[i] })).body.code, 'stale_runtime');
    }
  });
  await t.test('actual backend restart restores dormant refs without spawning children or replaying model work', async () => {
    const launches = projects.map(project => fs.readFileSync(path.join(project, 'fixture-launches.jsonl'), 'utf8'));
    await stop(); await start();
    const restored = await snapshot(); assert.equal(restored.liveCount, 0);
    for (let i = 0; i < ids.length; i++) {
      assert.equal((await item(ids[i])).lifecycle, 'dormant');
      const value = await artifactRead(refs[i].id, { conversationId: ids[i] });
      assert.equal(value.status, 200); assert.deepEqual(value.body.artifact, refs[i]);
      assert.equal(fs.readFileSync(path.join(projects[i], 'fixture-launches.jsonl'), 'utf8'), launches[i]);
      assert.equal((await artifactRead(refs[i].id, { conversationId: ids[i], owner: owners[i] })).body.code, 'stale_runtime');
    }
  });
  await stop();
});
