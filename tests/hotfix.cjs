/* P25.1 offline state-machine regressions. All writes stay in temp fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.error(' FAIL ' + name + ': ' + e.message); } }
const tick = () => new Promise(r => setTimeout(r, 20));
const res = () => ({ code: 0, headers: {}, body: null, writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; } });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-hotfix-'));
async function main() {
  const { createRuntime } = await import('../server/runtime.js');
  const { createRpcBridge } = await import('../server/rpc-bridge.js');
  const { createProjects } = await import('../server/projects.js');
  const A = path.join(tmp, 'A'), B = path.join(tmp, 'B'); fs.mkdirSync(A); fs.mkdirSync(B);
  const runtime = createRuntime({ initialCwd: A });
  const events = [], observed = [], launches = []; let child;
  const bridge = createRpcBridge({ runtime, isWin: false, piBin: 'fixture', env: { PI_GUI_TOKEN: 'gui-secret', OPENAI_API_KEY: 'provider-secret' }, publish: e => events.push(e), compat: { observeUpstream: e => observed.push(e) },
    spawnProcess: (_cmd, _args, opts) => {
      launches.push(opts); child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.stdin = new EventEmitter(); child.stdin.end = () => {}; child.stdin.write = line => { const cmd = JSON.parse(line); queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ type: 'response', command: cmd.type, id: cmd.id, success: true, data: { readback: cmd.type } }) + '\n')); };
      child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; }; queueMicrotask(() => child.emit('spawn')); return child;
    } });
  try {
    bridge.start(); await tick();
    await check('H1 internal numeric readback resolves without SSE', async () => {
      for (const type of ['get_state', 'get_available_models', 'get_available_thinking_levels']) assert.deepEqual(await bridge.request({ type }), { readback: type });
      assert.equal(events.filter(e => e.type === 'response').length, 0);
    });
    await check('H1 compatibility observes internal responses', () => assert.equal(observed.filter(e => e.type === 'response').length, 3));
    await check('H1 renderer string response remains an event', async () => { bridge.send({ type: 'get_state', id: 'composer-state-1' }); await tick(); assert.equal(events.at(-1).id, 'composer-state-1'); });
    await check('H1 late internal responses remain private after timeout', async () => { const saved = child.stdin.write; let command; child.stdin.write = line => { command = JSON.parse(line); }; const waiting = bridge.request({ type: 'get_state' }, { timeoutMs: 5 }); await tick(); assert.equal(await waiting, null); const count = events.length; child.stdout.emit('data', JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: {} }) + '\n'); assert.equal(events.length, count); child.stdin.write = saved; });
    await check('H4 GUI token stripped, provider environment retained', () => { assert.equal(launches[0].env.PI_GUI_TOKEN, undefined); assert.equal(launches[0].env.OPENAI_API_KEY, 'provider-secret'); assert.ok(!JSON.stringify(events).includes('provider-secret')); });
    let busy = null; const file = path.join(tmp, 'projects.json');
    const projects = createProjects({ projectsFile: file, runtime, isWin: false, restartPi: bridge.restart, beforeActivate: () => busy });
    projects.write({ active: A, items: [{ path: A }, { path: B }] });
    const remove = target => { const response = res(); projects.handle({ method: 'DELETE' }, response, new URL('http://fixture/api/projects?path=' + encodeURIComponent(target))); return response; };
    await check('H7 removing noncurrent B never restarts A', () => { const n = launches.length; assert.equal(remove(B).code, 200); assert.equal(runtime.getCurrentCwd(), A); assert.equal(launches.length, n); });
    await check('H7 busy removal is rejected before configuration write', () => { busy = '先停止正在运行的工作'; const before = fs.readFileSync(file, 'utf8'); assert.equal(remove(A).code, 409); assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(runtime.getCurrentCwd(), A); busy = null; });
    await check('H7 active removal closes runtime and bridge', async () => { assert.equal(remove(A).code, 200); assert.equal(runtime.getCurrentCwd(), null); await tick(); assert.equal(bridge.getState().hasProject, false); assert.equal(events.at(-1).state, 'no-project'); });
    await check('H7 deleted old folder cannot spawn or be recreated on restart', async () => { fs.rmSync(A, { recursive: true }); const n = launches.length; bridge.restart(); await tick(); assert.equal(launches.length, n); assert.equal(fs.existsSync(A), false); });
    await check('H7 re-add remains closed until explicit activation', async () => {
      const { Readable } = require('node:stream'); fs.mkdirSync(A);
      const add = Readable.from([Buffer.from(JSON.stringify({ path: A }))]); add.method = 'POST'; await projects.handle(add, res(), new URL('http://fixture/api/projects')); assert.equal(runtime.getCurrentCwd(), null);
      const activate = Readable.from([Buffer.from(JSON.stringify({ path: A }))]); activate.method = 'POST'; await projects.handle(activate, res(), new URL('http://fixture/api/projects/activate')); await tick(); assert.equal(runtime.getCurrentCwd(), A); assert.equal(events.at(-1).state, 'ready'); assert.equal(launches.at(-1).cwd, A);
    });
  } finally { runtime.setShuttingDown(true); bridge.stop(); }
  const { createPiLaunch } = await import('../server/pi-launch.js');
  const { createAgentRegistry } = await import('../server/agents/index.js');
  await check('P25 user-level OAuth survives closing current workspace', async () => {
    const { createProviderAuth } = await import('../server/provider-auth.js');
    const { authDescriptor } = await import('../server/provider-auth-sdk.js');
    let release; const gate = new Promise(r => { release = r; });
    const controller = createProviderAuth({ adapter: { identityKey: () => 'same-pi', list: async () => ({ capability: { sdkAvailable: true }, providers: [authDescriptor({ providerId: 'fixture', methods: [{ type: 'oauth', canLogin: true }] })] }), login: async () => gate, dispose() {} }, synchronize: async () => ({ ok: true }) });
    try { await controller.start('fixture', 'oauth'); const id = controller.snapshot().flow.id; controller.observeRuntime({ type: 'bridge_status', state: 'no-project' }); assert.equal(controller.snapshot().flow.id, id); assert.notEqual(controller.snapshot().flow.state, 'cancelled'); } finally { release(); controller.dispose(); }
  });
  const pkg = path.join(tmp, 'custom', 'node_modules', '@earendil-works', 'pi-coding-agent'); fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  const entry = path.join(pkg, 'dist', 'cli.js'); fs.writeFileSync(entry, 'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:"canonical fixture"}}));');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0', bin: { pi: 'dist/cli.js' } }));
  const env = { PI_BIN: entry, PATH: '', APPDATA: path.join(tmp, 'other-global') };
  const launch = createPiLaunch({ piBin: entry, env, isWin: false }); const registry = createAgentRegistry({ env, piLaunch: launch });
  await check('H2 non-global canonical Pi is available in registry and auto', () => { assert.equal(registry.detect('pi').available, true); assert.equal(registry.resolveAuto(), 'pi'); });
  await check('H2 Planner executes canonical package', async () => { const r = await registry.get('pi').start({ task: {}, prompt: 'fixture', cwd: B }); assert.equal(r.success, true); assert.equal(r.summary, 'canonical fixture'); });
  await check('H2 invalid explicit PI_BIN never falls back', () => { const bad = createPiLaunch({ piBin: path.join(tmp, 'missing'), env, isWin: false }); assert.equal(createAgentRegistry({ env, piLaunch: bad }).detect('pi').available, false); });
  await check('H2 two Pi packages never mix registry or diagnostics', async () => {
    const other = path.join(env.APPDATA, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent'); fs.mkdirSync(path.join(other, 'dist'), { recursive: true }); fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '9.9.9', bin: { pi: 'dist/cli.js' } })); fs.writeFileSync(path.join(other, 'dist', 'cli.js'), '// other');
    const { createDiagnostics } = await import('../server/diagnostics.js');
    const diag = createDiagnostics({ runtime: { getCurrentCwd: () => B }, rpc: { getState: () => ({}) }, agentRegistry: registry, dataDir: tmp, env: {} }).readSnapshot();
    assert.equal(registry.detect('pi').version, '1.0.0'); assert.ok(!JSON.stringify(diag).includes('9.9.9')); assert.ok(!JSON.stringify(diag).includes(entry));
  });
  await check('H5 export endpoint and cleanup', async () => {
    const { createSessionExport } = await import('../server/session-export.js');
    const types = path.join(pkg, 'dist', 'modes', 'rpc'); fs.mkdirSync(types, { recursive: true }); fs.writeFileSync(path.join(types, 'rpc-types.d.ts'), 'type RpcCommand = { type: "export_html"; outputPath?: string; };');
    execFileSync('git', ['init', '--quiet'], { cwd: B });
    const before = fs.readdirSync(B), status = execFileSync('git', ['status', '--porcelain'], { cwd: B }).toString(); let output;
    const fx = createSessionExport({ runtime: { getCurrentCwd: () => B }, resolvePackageDir: () => pkg, rpc: { getState: () => ({ bridgeRun: 1 }), request: async cmd => { output = cmd.outputPath; assert.equal(path.relative(B, output).startsWith('..'), true); fs.writeFileSync(output, '<!doctype html><p>fixture</p>'); assert.deepEqual(fs.readdirSync(B), before); return { path: output }; } } });
    const response = res(); await fx.handle({ method: 'POST' }, response); assert.equal(response.code, 200); assert.equal(response.headers['Content-Type'], 'text/html; charset=utf-8'); assert.ok(response.body.toString().includes('fixture')); assert.equal(fs.existsSync(path.dirname(output)), false); assert.deepEqual(fs.readdirSync(B), before); assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: B }).toString(), status); assert.ok(!JSON.stringify(response.headers).includes(tmp));
  });
  for (const mode of ['error', 'wrong-path', 'stale', 'symlink']) await check('H5 failure cleanup and path privacy: ' + mode, async () => {
    const { createSessionExport } = await import('../server/session-export.js'); let output, run = 1;
    const fx = createSessionExport({ runtime: { getCurrentCwd: () => B }, resolvePackageDir: () => pkg, rpc: { getState: () => ({ bridgeRun: run }), request: async cmd => { output = cmd.outputPath;
      if (mode === 'symlink') fs.symlinkSync(path.join(pkg, 'package.json'), output); else fs.writeFileSync(output, 'partial');
      if (mode === 'stale') run++;
      return mode === 'error' ? { __error: 'secret ' + output } : { path: mode === 'wrong-path' ? path.join(B, 'not-created.html') : output };
    } } });
    const response = res(); await fx.handle({ method: 'POST' }, response); assert.equal(response.code, 502); assert.equal(fs.existsSync(path.dirname(output)), false); assert.ok(!response.body.includes(tmp));
  });
  await check('H5 old Pi rejects before issuing export command', async () => { const { createSessionExport } = await import('../server/session-export.js'); let called = false; const fx = createSessionExport({ runtime: { getCurrentCwd: () => B }, resolvePackageDir: () => null, rpc: { getState: () => ({}), request: () => { called = true; } } }); const response = res(); await fx.handle({ method: 'POST', body: { outputPath: B } }, response); assert.equal(response.code, 409); assert.equal(called, false); });
  await check('H5 router rejects raw exports and reserved numeric client IDs', async () => {
    const { createRouter } = await import('../server/router.js'); const { Readable } = require('node:stream'); const sent = [];
    const route = createRouter({ auth: { denyRequest: () => null }, rpc: { send: cmd => sent.push(cmd) } });
    async function hit(command) { const request = Readable.from([Buffer.from(JSON.stringify(command))]); request.method = 'POST'; request.url = '/api/command'; request.headers = {}; const response = res(); route(request, response); await tick(); return response; }
    assert.equal((await hit({ type: 'export_html', outputPath: B })).code, 400); assert.equal((await hit({ type: 'get_state', id: 1 })).code, 400); assert.equal((await hit({ type: 'get_state', id: 'renderer-fixture' })).code, 200); assert.equal(sent.length, 1);
  });
  console.log(`\n${passed}/${passed + failed} 通过`); process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
