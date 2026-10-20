// Offline regressions for review issues 1/4/7/10. All disk writes use TEMP.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

async function uploadChild() {
  const { createUploads } = await import('../server/uploads.js');
  const { createRouter } = await import('../server/router.js');
  const OriginalDate = Date;
  global.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2026-10-18T10:00:00.123Z'])); } };
  if (process.argv.includes('--collision')) {
    const write = fs.writeFileSync;
    let collide = true;
    fs.writeFileSync = function(file, body, options) {
      if (String(file).includes('.uploads') && collide) {
        collide = process.argv.includes('--exhaust-collisions');
        write(file, 'previous upload', { flag: 'wx' });
        // Model an already allocated path: a non-exclusive write overwrites it.
      }
      return write(file, body, options);
    };
  }
  const uploads = createUploads({ dataDir: process.argv[3] });
  const server = require('node:http').createServer(createRouter({ auth: { denyRequest: () => null }, uploads }));
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
}

async function main() {
  let passed = 0, failed = 0;
  const check = async (label, run) => {
    try { await run(); passed++; console.log('PASS ' + label); }
    catch (e) { failed++; console.error('FAIL ' + label + ': ' + e.message); }
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-high-risk-'));
  async function withUpload(label, run, extra = []) {
    const data = path.join(root, label); fs.mkdirSync(data);
    const child = fork(__filename, ['--upload-child', data, ...extra], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = ''; child.stderr.on('data', b => stderr += b);
    const exited = once(child, 'exit');
    try {
      const [{ port }] = await Promise.race([once(child, 'message'), exited.then(() => { throw Error('upload child exited: ' + stderr); })]);
      const upload = async (name, text) => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: text, signal: AbortSignal.timeout(5000) });
          return await response.json();
        } catch { return { ok: false, code: 'connection_lost' }; }
      };
      await run(upload, data);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; }
  }
  try {
    await check('isolated percent filename does not terminate actual upload router', () => withUpload('percent', async upload => {
      const result = await upload('100%.txt', 'percent body');
      assert.equal(result.ok, true); assert.equal(result.name, '100%.txt');
      assert.equal((await upload('after.txt', 'alive')).ok, true);
    }));
    for (const name of ['中文附件.txt', 'report%20final.txt', 'literal%25.txt']) {
      await check('filename preserved exactly: ' + name, () => withUpload('name-' + passed + '-' + failed, async upload => {
        const result = await upload(name, 'file body');
        assert.equal(result.ok, true); assert.equal(result.name, name); assert.equal(result.text, 'file body');
      }));
    }
    await check('same-millisecond uploads keep every path and original body', () => withUpload('parallel', async upload => {
      const bodies = Array.from({ length: 30 }, (_, i) => 'body-' + i);
      const results = await Promise.all(bodies.map(body => upload('same.txt', body)));
      assert.equal(results.filter(r => r.ok).length, 30);
      assert.equal(new Set(results.map(r => r.id)).size, 30);
      results.forEach((r, i) => assert.equal(fs.readFileSync(r.path, 'utf8'), bodies[i]));
    }));
    await check('previously valid long Chinese filename stays within portable component limit', () => withUpload('multibyte', async upload => {
      const name = '汉'.repeat(70) + '.txt';
      const result = await upload(name, 'long filename body');
      assert.equal(result.ok, true); assert.equal(result.name, name);
      assert.ok(Buffer.byteLength(result.id, 'utf8') <= 255, 'stored filename must remain usable on byte-bounded filesystems');
      assert.equal(fs.readFileSync(result.path, 'utf8'), 'long filename body');
    }));
    await check('exclusive file creation retries collision and preserves previous upload', () => withUpload('collision', async (upload, data) => {
      const result = await upload('same.txt', 'new upload'); assert.equal(result.ok, true);
      const bodies = fs.readdirSync(path.join(data, '.uploads')).map(name => fs.readFileSync(path.join(data, '.uploads', name), 'utf8'));
      assert.deepEqual(bodies.sort(), ['new upload', 'previous upload']);
    }, ['--collision']));
    await check('persistent allocation collisions fail without overwriting files', () => withUpload('exhausted', async (upload, data) => {
      const result = await upload('same.txt', 'new upload');
      assert.equal(result.ok, false); assert.notEqual(result.code, 'connection_lost');
      const files = fs.readdirSync(path.join(data, '.uploads'));
      assert.equal(files.length, 5);
      files.forEach(name => assert.equal(fs.readFileSync(path.join(data, '.uploads', name), 'utf8'), 'previous upload'));
    }, ['--collision', '--exhaust-collisions']));

    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<div id="host"></div><div id="modal" hidden><div id="modalCard"></div></div><div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div>', { url: 'http://fixture.invalid/' });
    global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;
    const { runtimeStore: store, seedRuntimeSnapshot } = await import('../public/runtime-state.js');
    const { createRuntimeConversation } = await import('../public/runtime-conversation.js');
    const { openRuntimeSessions } = await import('../public/runtime-sessions.js');
    const { closeModal } = await import('../public/ui/modal.js');
    const owner = id => ({ backendInstance: 'fixture', projectId: 'p', repoId: 'r', workspaceId: id, workspaceEpoch: 'e', conversationId: id, runtimeId: id, runtimeGeneration: '1', sessionId: id });
    for (const surface of ['central', 'modal']) for (const scenario of ['unchanged', 'new draft', 'edit back to same text', 'switch target', 'failure', 'new owner']) {
      await check(surface + ': pending send preserves correct draft: ' + scenario, async () => {
        const records = ['A', 'B'].map(id => ({ conversationId: id, owner: owner(id), workspace: { branch: id, projectId: 'p' }, lifecycle: 'ready', activity: 'idle' }));
        store.seed({ backendInstance: 'reset-' + surface + scenario, items: [] });
        seedRuntimeSnapshot({ ok: true, backendInstance: 'fixture', items: records });
        let finish, calls = 0;
        global.fetch = async (_url, options = {}) => ({ json: async () => {
          if (!options.body) return { ok: true, backendInstance: 'fixture', items: records };
          const body = JSON.parse(options.body);
          if (body.command?.type === 'prompt') { calls++; return new Promise(resolve => { finish = resolve; }); }
          if (body.action === 'read') return { ok: true, data: { messages: [] } };
          return { ok: true };
        } });
        const host = document.getElementById(surface === 'central' ? 'host' : 'modalCard');
        let view;
        try {
          if (surface === 'central') { view = createRuntimeConversation({ host }); view.show('A'); }
          else { openRuntimeSessions({}); await tick(); host.querySelector('[data-conversation-id="A"]').click(); await tick(); }
          const input = host.querySelector('textarea');
          const type = text => { input.value = text; input.dispatchEvent(new dom.window.Event('input')); };
          type('  submitted draft  ');
          [...host.querySelectorAll('button')].find(b => b.textContent === '发送').click(); await tick();
          assert.equal(calls, 1); assert.equal(input.disabled, false);
          let expected = '';
          if (scenario === 'new draft' || scenario === 'switch target') { type('new unsent draft'); expected = 'new unsent draft'; }
          if (scenario === 'edit back to same text') { type('changed'); type('  submitted draft  '); expected = '  submitted draft  '; }
          if (scenario === 'failure') expected = '  submitted draft  ';
          if (scenario === 'new owner') {
            records[0] = { ...records[0], owner: { ...owner('A'), runtimeId: 'replacement', runtimeGeneration: '2' } };
            seedRuntimeSnapshot({ ok: true, backendInstance: 'fixture', items: records }); type('replacement draft'); expected = 'replacement draft';
          }
          if (scenario === 'switch target') {
            if (view) view.show('B'); else host.querySelector('[data-conversation-id="B"]').click();
            type('B independent draft');
          }
          finish({ ok: scenario !== 'failure' }); await tick();
          assert.equal(store.get('A').draft, expected);
          assert.equal(input.value, scenario === 'switch target' ? 'B independent draft' : expected);
          if (scenario === 'switch target') assert.equal(store.get('B').draft, 'B independent draft');
        } finally { if (view) view.dispose(); else closeModal(); await tick(); }
      });
    }
    dom.window.close();

    const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
    for (const command of ['steer', 'follow_up']) for (const handled of [false, true]) {
      await check(command + (handled ? ' handled' : ' rejected') + ' leaves original task running and stoppable', async () => {
        let emit, aborts = 0;
        const dir = path.join(root, command + '-' + handled); fs.mkdirSync(dir);
        const workspace = { projectId: 'p', repoId: 'r', workspaceId: 'w', workspaceEpoch: 'e', cwd: dir, root: dir, branch: 'fixture' };
        const registry = createRuntimeRegistry({ dataDir: path.join(dir, 'registry'), resolveWorkspace: async () => workspace,
          factory: async (_ctx, publish) => { emit = publish; return { start: () => emit({ type: 'bridge_status', state: 'ready' }), request: async () => ({ sessionId: 'native' }), getState: () => ({}), send() {}, abortAndWait: async () => { aborts++; return { ok: true }; }, dispose: async () => {}, cleanupConfirmed: () => true }; } });
        try {
          const first = await registry.start({}); await tick(); const target = registry.getOwner(first.conversationId);
          await registry.command(target, { type: 'prompt', id: 'original', message: 'fixture' }); emit({ type: 'agent_start' });
          await registry.command(target, { type: command, id: 'extra', message: 'extra' });
          emit({ type: 'response', command, id: 'extra', success: handled, ...(handled ? { data: { disposition: 'handled' } } : {}) });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'still running' } });
          assert.equal(registry.snapshot().items[0].activity, 'running'); assert.equal(registry.busy(), true);
          assert.equal((await registry.command(target, { type: 'abort' })).ok, true); assert.equal(aborts, 1);
          assert.equal(registry.snapshot().items[0].activity, 'idle');
        } finally { await registry.dispose(); }
      });
    }
    await check('prompt cannot create a second turn while the original task runs', async () => {
      let emit, aborts = 0, sends = 0;
      const dir = path.join(root, 'prompt-busy'); fs.mkdirSync(dir);
      const workspace = { projectId: 'p', repoId: 'r', workspaceId: 'w', workspaceEpoch: 'e', cwd: dir, root: dir, branch: 'fixture' };
      const registry = createRuntimeRegistry({ dataDir: path.join(dir, 'registry'), resolveWorkspace: async () => workspace,
        factory: async (_ctx, publish) => { emit = publish; return { start: () => emit({ type: 'bridge_status', state: 'ready' }), request: async () => ({ sessionId: 'native' }), getState: () => ({}), send() { sends++; }, abortAndWait: async () => { aborts++; return { ok: true }; }, dispose: async () => {}, cleanupConfirmed: () => true }; } });
      try {
        const first = await registry.start({}); await tick(); const target = registry.getOwner(first.conversationId);
        await registry.command(target, { type: 'prompt', id: 'original', message: 'fixture' }); emit({ type: 'agent_start' });
        const before = sends;
        await assert.rejects(() => registry.command(target, { type: 'prompt', id: 'extra', message: 'extra' }), error => error.code === 'runtime_busy');
        assert.equal(sends, before, 'the rejected prompt must not reach the Pi adapter');
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'still running' } });
        assert.equal(registry.snapshot().items[0].activity, 'running');
        assert.equal((await registry.command(target, { type: 'abort' })).ok, true); assert.equal(aborts, 1);
        assert.equal(registry.snapshot().items[0].activity, 'idle');
      } finally { await registry.dispose(); }
    });
    await check('preflight failure returns idle; late response cannot release Stop barrier', async () => {
      let emit, finishStop;
      const dir = path.join(root, 'stop-barrier'); fs.mkdirSync(dir);
      const workspace = { projectId: 'p', repoId: 'r', workspaceId: 'w', workspaceEpoch: 'e', cwd: dir, root: dir, branch: 'fixture' };
      const registry = createRuntimeRegistry({ dataDir: path.join(dir, 'registry'), resolveWorkspace: async () => workspace,
        factory: async (_ctx, publish) => { emit = publish; return { start: () => emit({ type: 'bridge_status', state: 'ready' }), request: async () => ({ sessionId: 'native' }), getState: () => ({}), send() {}, abortAndWait: () => new Promise(resolve => { finishStop = resolve; }), dispose: async () => {}, cleanupConfirmed: () => true }; } });
      try {
        const first = await registry.start({}); await tick(); const target = registry.getOwner(first.conversationId);
        await registry.command(target, { type: 'prompt', id: 'rejected', message: 'fixture' });
        emit({ type: 'response', command: 'prompt', id: 'rejected', success: false });
        assert.equal(registry.snapshot().items[0].activity, 'idle');
        await registry.command(target, { type: 'prompt', message: 'fixture' }); emit({ type: 'agent_start' });
        const stopping = registry.command(target, { type: 'abort' });
        emit({ type: 'response', command: 'steer', success: false }); emit({ type: 'agent_start' }); emit({ type: 'agent_settled' });
        assert.equal(registry.snapshot().items[0].activity, 'stopping');
        finishStop({ ok: true }); await stopping; assert.equal(registry.snapshot().items[0].activity, 'idle');
        await registry.command(target, { type: 'prompt', id: 'after-stop', message: 'after stop' });
        emit({ type: 'response', command: 'prompt', id: 'after-stop', success: false }); assert.equal(registry.snapshot().items[0].activity, 'idle');
      } finally { await registry.dispose(); }
    });
    await check('out-of-order responses retain the accepted original turn and reject a second prompt', async () => {
      let emit;
      const dir = path.join(root, 'pending-turns'); fs.mkdirSync(dir);
      const workspace = { projectId: 'p', repoId: 'r', workspaceId: 'w', workspaceEpoch: 'e', cwd: dir, root: dir, branch: 'fixture' };
      const registry = createRuntimeRegistry({ dataDir: path.join(dir, 'registry'), resolveWorkspace: async () => workspace,
        factory: async (_ctx, publish) => { emit = publish; return { start: () => emit({ type: 'bridge_status', state: 'ready' }), request: async () => ({ sessionId: 'native' }), getState: () => ({}), send() {}, dispose: async () => {}, cleanupConfirmed: () => true }; } });
      try {
        const first = await registry.start({}); await tick(); const target = registry.getOwner(first.conversationId);
        const send = id => registry.command(target, { type: 'prompt', id, message: 'fixture' });
        const reject = id => emit({ type: 'response', command: 'prompt', id, success: false });
        await send('first');
        await assert.rejects(() => send('extra'), error => error.code === 'runtime_busy');
        reject('extra');
        assert.equal(registry.snapshot().items[0].activity, 'running', 'a late rejection cannot settle the original request');
        reject('first'); assert.equal(registry.snapshot().items[0].activity, 'idle', 'all preflight requests failed');
        await send('malformed'); emit({ type: 'response', command: 'prompt', id: 'malformed' });
        assert.equal(registry.snapshot().items[0].activity, 'running', 'missing success is unknown, not settlement');
        emit({ type: 'response', command: 'steer', id: 'malformed', success: false });
        assert.equal(registry.snapshot().items[0].activity, 'running', 'wrong command cannot consume the request');
        reject('malformed'); assert.equal(registry.snapshot().items[0].activity, 'idle');
        await send('accepted'); emit({ type: 'response', command: 'prompt', id: 'accepted', success: true, data: { disposition: 'queued' } });
        await assert.rejects(() => send('extra-again'), error => error.code === 'runtime_busy');
        reject('extra-again');
        assert.equal(registry.snapshot().items[0].activity, 'running', 'a rejected addition cannot settle the accepted original');
        emit({ type: 'agent_settled' });
        await send('new-pending'); reject('extra-again');
        assert.equal(registry.snapshot().items[0].activity, 'running', 'late old rejection cannot settle new request');
        reject('new-pending'); assert.equal(registry.snapshot().items[0].activity, 'idle');
        const add = id => registry.command(target, { type: 'steer', id, message: 'fixture' });
        for (let i = 0; i < 32; i++) await add('bounded-' + i);
        await assert.rejects(() => add('bounded-0'), e => e.code === 'invalid_command');
        await assert.rejects(() => add('over-budget'), e => e.code === 'runtime_request_limit');
        for (let i = 0; i < 32; i++) emit({ type: 'response', command: 'steer', id: 'bounded-' + i, success: false });
        assert.equal(registry.snapshot().items[0].activity, 'idle');
      } finally { await registry.dispose(); }
    });
    await check('real bridge and guardian retain original fake-Pi task after rejected additions', async () => {
      const { createSessionRuntime } = await import('../server/session-runtime.js');
      const dir = path.join(root, 'bridge'); fs.mkdirSync(dir);
      const pkg = path.join(dir, 'node_modules/@earendil-works/pi-coding-agent'); fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.4', bin: { pi: 'cli.cjs' } }));
      const cli = path.join(pkg, 'cli.cjs');
      fs.writeFileSync(cli, `let streaming=false;const send=v=>console.log(JSON.stringify(v));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.type==='prompt'){streaming=true;send({type:'agent_start'});}if(c.type==='abort'){streaming=false;send({type:'agent_settled'});}if(['steer','follow_up'].includes(c.type)){send({type:'response',id:c.id,command:c.type,success:false,error:'fixture rejection'});send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'original task still running'}});return;}send({type:'response',id:c.id,command:c.type,success:true,data:c.type==='get_state'?{sessionId:'native-fixture',isStreaming:streaming}:c.type==='prompt'?{disposition:'started'}:{}});});`);
      const workspace = { projectId: 'p', repoId: 'r', workspaceId: 'w', workspaceEpoch: 'e', cwd: dir, root: dir, branch: 'fixture' };
      const events = []; let adapter;
      const registry = createRuntimeRegistry({ dataDir: path.join(dir, 'registry'), resolveWorkspace: async () => workspace, publish: e => events.push(e),
        factory: async (context, emit) => adapter = await createSessionRuntime({ context, emit, piBin: cli, env: { ...process.env, PI_NO_CONTINUE: '1', PI_CODING_AGENT_DIR: path.join(dir, 'agent') }, dataDir: path.join(dir, 'runtime') }) });
      const until = async fn => { const end = Date.now() + 25000; while (!fn()) { if (Date.now() > end) throw Error('owned_bridge_fixture_timeout'); await new Promise(r => setTimeout(r, 20)); } };
      try {
        const first = await registry.start({}); await until(() => registry.getOwner(first.conversationId)?.sessionId);
        const target = registry.getOwner(first.conversationId);
        await registry.command(target, { type: 'prompt', id: 'original', message: 'fixture' }); await until(() => events.some(e => e.event?.type === 'agent_start'));
        for (const type of ['steer', 'follow_up']) {
          await registry.command(target, { type, id: 'reject-' + type, message: 'fixture addition' });
          await until(() => events.some(e => e.event?.id === 'reject-' + type));
          assert.equal((await registry.read(target, { type: 'get_state' })).isStreaming, true);
          assert.equal(registry.snapshot().items[0].activity, 'running'); assert.equal(Boolean(adapter.activity.busy()), true);
        }
        assert.equal((await registry.command(target, { type: 'abort' })).ok, true);
        assert.equal(registry.snapshot().items[0].activity, 'idle');
      } finally { await registry.dispose(); }
    });
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  console.log(`High-risk regressions: ${passed}/${passed + failed}; failed=${failed}; offline fixtures`);
  process.exitCode = failed ? 1 : 0;
}
if (process.argv[2] === '--upload-child') uploadChild().catch(e => { console.error(e); process.exitCode = 1; });
else main().catch(e => { console.error(e); process.exitCode = 1; });
