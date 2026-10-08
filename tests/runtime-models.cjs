const assert = require('node:assert/strict');
(async () => {
  const { JSDOM } = require('jsdom'); const dom = new JSDOM('<div id="toasts"></div>', { url: 'http://127.0.0.1/' });
  global.document = dom.window.document; global.window = dom.window;
  const { createRuntimeModels } = await import('../public/runtime-models.js');
  const { createRuntimeStore } = await import('../public/runtime-store.js');
  let checks = 0; const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };
  const owner = id => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: 'ws-' + id, workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: 'one', sessionId: 'session-' + id });
  const item = id => ({ conversationId: id, owner: owner(id), lifecycle: 'ready', activity: 'idle', revision: 1 });
  const store = createRuntimeStore(); store.seed({ backendInstance: 'backend', items: ['A', 'B'].map(item) });
  const model = (id, reasoning = true) => ({ provider: 'fixture', id, name: id, reasoning, input: ['text'] });
  const native = { A: { model: model('a'), thinkingLevel: 'low', sessionName: 'Native A' }, B: { model: model('b'), thinkingLevel: 'high', sessionName: 'Native B' } };
  const listeners = new Set(), posts = [], changes = [];
  let readFailure = null, deferredState = null, deferredAck = null, unsupported = false, writeFailure = false;
  const levels = ['off', 'low', 'high'];
  const request = async p => {
    posts.push(p);
    if (p.action === 'command') { if (deferredAck) return new Promise(resolve => { deferredAck.resolve = resolve; }); return { ok: !writeFailure }; }
    if (p.command.type === 'get_state' && deferredState) { const gate = deferredState; deferredState = null; return new Promise(resolve => { gate.resolve = resolve; }); }
    if (readFailure) return { ok: false, code: readFailure, error: 'secret raw failure' };
    const id = p.owner.conversationId;
    if (p.command.type === 'get_state') return { ok: true, data: structuredClone(native[id]) };
    if (p.command.type === 'get_available_models') return { ok: true, data: { models: [model('a'), model('b'), model('next'), model('false', false), model('unknown', undefined)] } };
    if (p.command.type === 'get_available_thinking_levels') return unsupported ? { ok: false, code: 'pi_request_failed' } : { ok: true, data: { levels } };
    throw Error('unexpected_fixture_command');
  };
  const controller = createRuntimeModels({ store, request, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, onChange: id => changes.push(id), timeoutMs: 80 });
  const seq = { A: 0, B: 0 };
  const emit = (id, event, overrideOwner = owner(id)) => {
    const frame = { type: 'runtime_event', owner: overrideOwner, eventSequence: ++seq[id], event };
    if (store.apply(frame)) for (const listener of [...listeners]) listener(frame);
  };
  const until = async test => { for (let n = 0; n < 100; n++) { if (test()) return; await new Promise(r => setImmediate(r)); } throw Error('model_fixture_timeout'); };
  const mutation = () => posts.filter(p => p.action === 'command').at(-1);
  const respond = (p, success = true, extras = {}) => emit(p.owner.conversationId, { type: 'response', id: p.command.id, command: p.command.type, success, ...extras });
  await Promise.all([controller.refresh('A'), controller.refresh('B')]);
  ok('A and B show independent native models', controller.get('A').model.id === 'a' && controller.get('B').model.id === 'b');
  ok('native thinking levels and values are per conversation', controller.get('A').thinkingLevel === 'low' && controller.get('B').thinkingLevel === 'high' && controller.get('A').levels.join(',') === levels.join(','));
  ok('capability projection uses shared reasoning evidence', controller.get('A').reasoning === true && controller.get('A').capability.evidence.reasoning === 'pi-runtime');
  ok('native sessionName is projected', controller.get('A').sessionName === 'Native A');
  const count = posts.length; const setting = controller.setModel('A', { providerId: 'fixture', modelId: 'next' }); await until(() => mutation()); const first = mutation();
  ok('model command captures complete A owner and unique string ID', first.command.provider === 'fixture' && first.command.modelId === 'next' && typeof first.command.id === 'string' && Object.keys(first.owner).length === 9 && first.owner.conversationId === 'A');
  ok('HTTP ack keeps old selection pending without optimistic reads', controller.get('A').model.id === 'a' && controller.get('A').pending && posts.length === count + 1);
  emit('A', { type: 'response', id: 'wrong', command: 'set_model', success: true });
  emit('A', { type: 'response', id: first.command.id, command: 'set_thinking_level', success: true });
  emit('A', { type: 'response', id: first.command.id, command: 'set_model', success: true }, { ...owner('A'), runtimeGeneration: 'old' });
  ok('wrong id command and stale owner never trigger readback', posts.length === count + 1);
  native.A.model = model('next'); native.A.thinkingLevel = 'high'; respond(first); ok('successful delayed A does not change B', controller.get('B').model.id === 'b');
  ok('matching native success performs readback', await setting);
  ok('selection updates only after authoritative state', controller.get('A').model.id === 'next' && !controller.get('A').pending);
  ok('setter readback includes native thinking levels', posts.slice(count + 1).some(p => p.command.type === 'get_available_thinking_levels'));
  const errorStart = posts.length; const rejected = controller.setModel('A', { providerId: 'fixture', modelId: 'bad' }); await until(() => posts.length > errorStart); respond(mutation(), false, { error: 'secret unsafe backend payload' });
  ok('native model error is not HTTP success', await rejected === false);
  ok('native failure leaves prior model and no readback', controller.get('A').model.id === 'next' && posts.length === errorStart + 1);
  ok('safe notice never renders raw native error', controller.get('A').notice && !controller.get('A').notice.includes('secret'));
  const thinkStart = posts.length; const thinking = controller.setThinking('B', 'low'); await until(() => posts.length > thinkStart); const thinkingCommand = mutation();
  ok('thinking captures B and exact requested level', thinkingCommand.owner.conversationId === 'B' && thinkingCommand.command.type === 'set_thinking_level' && thinkingCommand.command.level === 'low');
  native.B.thinkingLevel = 'low'; respond(thinkingCommand); ok('thinking native success is read back', await thinking && controller.get('B').thinkingLevel === 'low');
  ok('B thinking does not change A', controller.get('A').thinkingLevel === 'high');
  native.B.model = model('false', false); await controller.refresh('B');
  ok('explicit unsupported reasoning exposes no levels', controller.get('B').reasoning === false && controller.get('B').levels === null);
  const beforeFalse = posts.length; ok('unsupported thinking sends no command', await controller.setThinking('B', 'high') === false && posts.length === beforeFalse);
  native.B.model = { provider: 'fixture', id: 'unknown' }; await controller.refresh('B');
  ok('unknown reasoning remains unknown despite native levels', controller.get('B').reasoning === null && controller.get('B').levels === null);
  native.B.model = model('b'); unsupported = true; await controller.refresh('B');
  ok('unsupported native levels never become guessed defaults', controller.get('B').reasoning === true && controller.get('B').levels === null); unsupported = false;
  const readStart = posts.length; const readRejected = controller.setModel('A', { providerId: 'fixture', modelId: 'a' }); await until(() => posts.length > readStart); readFailure = 'pi_request_failed'; respond(mutation());
  ok('failed native readback does not confirm selection', await readRejected === false && controller.get('A').model.id === 'next'); readFailure = null;
  const gate = {}; deferredState = gate; const oldRefresh = controller.refresh('A'); await until(() => gate.resolve); native.A.model = model('latest'); await controller.refresh('A'); gate.resolve({ ok: true, data: { model: model('stale'), thinkingLevel: 'off' } });
  ok('same-owner late refresh cannot overwrite newer readback', await oldRefresh === false && controller.get('A').model.id === 'latest');
  let start = posts.length; const oldMutation = controller.setModel('A', { providerId: 'fixture', modelId: 'old' }); await until(() => posts.length > start); const oldCommand = mutation();
  start = posts.length; const newMutation = controller.setModel('A', { providerId: 'fixture', modelId: 'new' }); await until(() => posts.length > start); const newCommand = mutation();
  respond(oldCommand); native.A.model = model('new'); respond(newCommand);
  ok('same-owner concurrent mutations invalidate older waiter', await oldMutation === false && await newMutation === true && controller.get('A').model.id === 'new' && oldCommand.command.id !== newCommand.command.id);
  const ackGate = {}; deferredAck = ackGate; start = posts.length; const beforeAck = controller.setModel('A', { providerId: 'fixture', modelId: 'after-ack' }); await until(() => ackGate.resolve); const ackCommand = mutation(); respond(ackCommand);
  await new Promise(r => setImmediate(r)); ok('native success before delayed transport ack waits for both', posts.length === start + 1 && controller.get('A').pending);
  native.A.model = model('after-ack'); deferredAck = null; ackGate.resolve({ ok: true }); ok('delayed HTTP ack then native readback succeeds', await beforeAck && controller.get('A').model.id === 'after-ack');
  const hangGate = {}; deferredAck = hangGate; const timed = controller.setModel('A', { providerId: 'fixture', modelId: 'timeout' }); await until(() => hangGate.resolve); respond(mutation());
  ok('combined ack/native wait timeout clears pending without success', await timed === false && !controller.get('A').pending && controller.get('A').model.id === 'after-ack'); deferredAck = null; hangGate.resolve({ ok: true });
  start = posts.length; const stalePending = controller.setModel('A', { providerId: 'fixture', modelId: 'lost-owner' }); await until(() => posts.length > start);
  store.seed({ backendInstance: 'backend', items: [{ ...item('A'), owner: null, lifecycle: 'dormant', revision: 20 }] }); for (const listener of [...listeners]) listener();
  ok('owner retirement cancels pending and clears model UI', await stalePending === false && controller.get('A') === null);
  ok('dormant refresh does not spawn or issue reads', await controller.refresh('A') === false);
  ok('async state changes notify captured conversation IDs', changes.includes('A') && changes.includes('B'));
  writeFailure = true; const writeBefore = posts.length;
  ok('transport rejection requires no native wait or readback', await controller.setModel('B', { providerId: 'fixture', modelId: 'a' }) === false && posts.length === writeBefore + 1 && !controller.get('B').pending); writeFailure = false;
  const partial = { ...owner('B') }; delete partial.runtimeId;
  store.seed({ backendInstance: 'backend', items: [{ ...item('B'), owner: partial, revision: 30 }] });
  const partialBefore = posts.length;
  ok('incomplete owner cannot render active model controls', controller.get('B') === null);
  ok('incomplete owner never issues model reads', await controller.refresh('B') === false && posts.length === partialBefore);
  controller.dispose(); ok('dispose unsubscribes accepted frame observer', listeners.size === 0);
  // Real RPC child fixtures prove native error data is not wrapped as a
  // successful model read, and the registry admits the native levels read.
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p32-runtime-models-')));
  const packageDir = path.join(dir, 'node_modules/@earendil-works/pi-coding-agent'); fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.4', bin: { pi: 'cli.cjs' } }));
  const cli = path.join(packageDir, 'cli.cjs');
  fs.writeFileSync(cli, `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const c=JSON.parse(line);console.log(JSON.stringify(['get_available_thinking_levels','set_thinking_level','cycle_thinking_level'].includes(c.type)?{type:'response',id:c.id,command:c.type,success:false,error:'secret fixture upstream error',data:{credential:'secret fixture data'},workerPayload:'secret fixture worker'}:{type:'response',id:c.id,command:c.type,success:true,data:{sessionId:'fixture-native',model:{provider:'fixture',id:'native',reasoning:true},thinkingLevel:'low',isStreaming:false}}));});`);
  const { createSessionRuntime, projectRuntimeEvent } = await import('../server/session-runtime.js');
  for (const command of ['set_thinking_level', 'cycle_thinking_level']) {
    const projected = projectRuntimeEvent({ type: 'response', id: 'safe-correlation', command, success: false, error: 'secret upstream details', data: { token: 'secret' }, workerPayload: 'secret', bridgeRun: 4 });
    ok(`${command} failure keeps correlation but drops all raw payloads`, projected.id === 'safe-correlation' && projected.command === command && projected.success === false && projected.bridgeRun === 4 && typeof projected.error === 'string' && !JSON.stringify(projected).includes('secret') && !Object.hasOwn(projected, 'workerPayload') && !Object.hasOwn(projected, 'data'));
  }
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const cwd = path.join(dir, 'workspace'); fs.mkdirSync(cwd);
  let adapter, registry, fixtureFailure; const emitted = [], transport = [];
  const { createPiSupervisor } = await import('../server/pi-supervisor.js');
  const { launchOwnedProcess, processAssets } = await import('../server/process-runner.js');
  // Add fixed stage markers to a private copy; never print the guardian spec.
  const diagnosticAssets = path.join(dir, 'guardian-assets'); fs.mkdirSync(diagnosticAssets);
  for (const name of ['runner-win.ps1', 'runner-posix.cjs', 'runtime-child.cjs']) {
    let source = fs.readFileSync(path.join(processAssets(), name), 'utf8');
    if (name === 'runner-win.ps1') {
      for (const [anchor, stage] of [
        ["$ErrorActionPreference = 'Stop'", 'before_script'],
        ['  Add-Type -TypeDefinition', 'before_compile'],
        ['  $inputReader = [PiGuiJob]::OpenInput()', 'after_compile'],
        ['  $spec = $inputReader.ReadLine()', 'after_reader'],
        ['  [string[]]$entries =', 'after_read'],
        ['  [PiGuiJob]::Run(', 'before_run'],
      ]) {
        if (!source.includes(anchor)) throw Error('guardian_fixture_anchor_missing');
        source = source.replace(anchor, `[Console]::Error.WriteLine('fixture_guardian_phase:${stage}')\n` + anchor);
      }
    }
    fs.writeFileSync(path.join(diagnosticAssets, name), source);
  }
  const transportStart = Date.now();
  const trace = (stage, code) => { if (transport.length < 32) transport.push({ stage, code, elapsedMs: Date.now() - transportStart }); };
  const supervisorFactory = options => {
    const supervisor = createPiSupervisor({ ...options, launch(spec, launchOptions) {
      const guardian = launchOwnedProcess(spec, { ...launchOptions, assets: diagnosticAssets });
      for (const stage of ['started', 'failure', 'close']) guardian.on(stage, () => trace('guardian_' + stage));
      let diagnosticTail = ''; const diagnosticStages = new Set();
      guardian.on('log', chunk => {
        const text = diagnosticTail + chunk.toString();
        diagnosticTail = text.slice(-128);
        for (const match of text.matchAll(/fixture_guardian_phase:(before_script|before_compile|after_compile|after_reader|after_read|before_run)/g)) {
          if (!diagnosticStages.has(match[1])) { diagnosticStages.add(match[1]); trace(match[1]); }
        }
        for (const code of ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'SyntaxError', 'ENOENT', 'EACCES']) {
          if (text.includes(code)) trace('guardian_diagnostic', code);
        }
      });
      return guardian;
    } });
    return { ...supervisor, spawnProcess(...args) {
      const child = supervisor.spawnProcess(...args);
      child.on('spawn', () => trace('native_spawn'));
      child.on('error', error => trace('native_error', ['pi_connect_timeout', 'pi_spawn_failed', 'pi_guardian_failed', 'stop_unconfirmed', 'pi_channel_closed'].includes(error.code) ? error.code : 'other'));
      return child;
    } };
  };
  try {
    adapter = await createSessionRuntime({ piBin: cli, supervisorFactory, env: { ...process.env, PI_NO_CONTINUE: '1' }, dataDir: path.join(dir, 'adapter-data'), context: { cwd, isCurrent: () => true }, emit: event => emitted.push(event) });
    let failure; try { await adapter.request({ type: 'get_state' }); } catch (e) { failure = e; }
    ok('unstarted native read is unconfirmed rather than fake success', failure?.code === 'pi_request_unconfirmed');
    adapter.start();
    const deadline = Date.now() + 20000; while (adapter.getState().state !== 'ready') {
      if (Date.now() > deadline) throw Error('native_model_fixture_ready_timeout:' + JSON.stringify({
        state: adapter.getState().state,
        events: emitted.map(event => ({ type: event.type, state: event.state, code: event.code })),
        transport,
      }));
      await new Promise(r => setTimeout(r, 20));
    }
    ok('real native child state read preserves model shape', (await adapter.request({ type: 'get_state' })).model.id === 'native');
    failure = null; try { await adapter.request({ type: 'get_available_thinking_levels' }); } catch (e) { failure = e; }
    ok('native private __error is rejected before success projection', failure?.code === 'pi_request_failed' && !failure.message.includes('secret'));
    for (const command of ['set_thinking_level', 'cycle_thinking_level']) {
      adapter.send({ type: command, id: 'safe-' + command, level: 'high' });
      const untilResponse = Date.now() + 10000; while (!emitted.some(e => e.id === 'safe-' + command)) { if (Date.now() > untilResponse) throw Error('native_thinking_fixture_response_timeout'); await new Promise(r => setTimeout(r, 20)); }
      const event = emitted.find(e => e.id === 'safe-' + command);
      ok(`real native ${command} error is safe before SSE publication`, event.command === command && event.success === false && !JSON.stringify(event).includes('secret') && typeof event.error === 'string' && !Object.hasOwn(event, 'data'));
    }
    await adapter.dispose(); failure = null; try { await adapter.request({ type: 'get_state' }); } catch (e) { failure = e; }
    ok('disposed adapter read is stale', failure?.code === 'stale_runtime');
    registry = createRuntimeRegistry({ dataDir: path.join(dir, 'registry-data'), resolveWorkspace: async () => ({ projectId: 'project', repoId: 'repo', workspaceId: 'workspace', workspaceEpoch: 'epoch', root: cwd, cwd, branch: 'fixture' }), factory: async (_context, emit) => ({
      start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }),
      getState: () => ({ state: 'ready', stop: null }), request: async command => command.type === 'get_state' ? { sessionId: null } : { levels }, send() {}, dispose: async () => {}, cleanupConfirmed: () => true,
    }) });
    await registry.start({ id: 'workspace', epoch: 'epoch' }); await new Promise(r => setImmediate(r));
    const scopedOwner = registry.snapshot().items[0].owner;
    const answer = await registry.read(scopedOwner, { type: 'get_available_thinking_levels' });
    ok('registry reads native available thinking levels under captured owner', answer.levels.join(',') === levels.join(','));
    failure = null; try { await registry.read({ ...scopedOwner, runtimeGeneration: 'old' }, { type: 'get_available_thinking_levels' }); } catch (e) { failure = e; }
    ok('native levels read rejects stale owner', failure?.code === 'stale_runtime');
    await registry.dispose(); registry = null;
    let failIdentity = true, nativeEmit, rejectOld;
    const failedEvents = [], unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      registry = createRuntimeRegistry({ dataDir: path.join(dir, 'failed-identity'), publish: event => failedEvents.push(event), resolveWorkspace: async () => ({ projectId: 'project', repoId: 'repo', workspaceId: 'workspace', workspaceEpoch: 'epoch', root: cwd, cwd, branch: 'fixture' }), factory: async (_context, emit) => {
        nativeEmit = emit; return {
          start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }), getState: () => ({ state: 'ready', stop: null }),
          request: async () => { if (failIdentity) throw Error('secret native identity failure'); return { sessionId: 'safe-native-identity' }; },
          send() {}, dispose: async () => {}, cleanupConfirmed: () => true,
        };
      } });
      await registry.start({ id: 'workspace', epoch: 'epoch' });
      for (let n = 0; n < 3; n++) await new Promise(r => setImmediate(r));
      ok('ready identity failure produces zero unhandled rejections', unhandled.length === 0);
      const failed = registry.snapshot().items[0];
      ok('failed identity stays occupied and blocks commands', failed.lifecycle === 'error' && failed.attention === true && failed.error === 'session_state_unconfirmed' && registry.snapshot().totalCount === 1 && failed.owner.sessionId === null);
      ok('failed identity error is safe in runtime state publication', !JSON.stringify(failedEvents).includes('secret') && !registry.historyTarget(failed.conversationId).sessionLocator);
      let denied; try { await registry.command(failed.owner, { type: 'prompt', message: 'fixture' }); } catch (e) { denied = e; }
      ok('unconfirmed native identity fails command admission', denied?.code === 'runtime_not_ready');
      await registry.close(failed.owner); failIdentity = false; await registry.start({ id: 'workspace', epoch: 'epoch' }); await new Promise(r => setImmediate(r));
      ok('explicit close reclaims lease and later launch works', registry.snapshot().totalCount === 1 && registry.snapshot().items.find(i => i.owner)?.owner.sessionId === 'safe-native-identity');
      await registry.dispose(); registry = null;
      let requests = 0;
      registry = createRuntimeRegistry({ dataDir: path.join(dir, 'late-identity'), resolveWorkspace: async () => ({ projectId: 'project', repoId: 'repo', workspaceId: 'workspace', workspaceEpoch: 'epoch', root: cwd, cwd, branch: 'fixture' }), factory: async (_context, emit) => {
        nativeEmit = emit; return {
          start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }), getState: () => ({ state: 'ready', stop: null }),
          request: async () => { requests++; if (requests === 1) return new Promise((_resolve, reject) => { rejectOld = reject; }); return { sessionId: 'safe-current-generation' }; },
          send() {}, dispose: async () => {}, cleanupConfirmed: () => true,
        };
      } });
      await registry.start({ id: 'workspace', epoch: 'epoch' }); nativeEmit({ type: 'bridge_status', state: 'ready', bridgeRun: 2 }); await new Promise(r => setImmediate(r));
      rejectOld(Error('secret late old generation error')); for (let n = 0; n < 3; n++) await new Promise(r => setImmediate(r));
      const latest = registry.snapshot().items[0];
      ok('late prior-generation identity rejection cannot poison new owner', latest.lifecycle === 'ready' && latest.error === null && latest.owner.sessionId === 'safe-current-generation' && unhandled.length === 0);
      await registry.dispose(); registry = null;
      let rejectRetired;
      registry = createRuntimeRegistry({ dataDir: path.join(dir, 'retired-identity'), resolveWorkspace: async () => ({ projectId: 'project', repoId: 'repo', workspaceId: 'workspace', workspaceEpoch: 'epoch', root: cwd, cwd, branch: 'fixture' }), factory: async (_context, emit) => ({
        start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }), getState: () => ({ state: 'ready', stop: null }), request: () => new Promise((_resolve, reject) => { rejectRetired = reject; }),
        send() {}, dispose: async () => {}, cleanupConfirmed: () => true,
      }) });
      await registry.start({ id: 'workspace', epoch: 'epoch' }); await registry.close(registry.snapshot().items[0].owner);
      rejectRetired(Error('secret retired identity failure')); for (let n = 0; n < 3; n++) await new Promise(r => setImmediate(r));
      ok('retired child identity rejection cannot resurrect error or slot', unhandled.length === 0 && registry.snapshot().totalCount === 0 && registry.snapshot().items[0].lifecycle === 'dormant' && registry.snapshot().items[0].error === null);
    } finally { process.off('unhandledRejection', onUnhandled); }
  } catch (error) { fixtureFailure = error; throw error; }
  finally {
    const cleanup = await Promise.allSettled([adapter?.dispose(), registry?.dispose()]);
    if (cleanup.some(result => result.status === 'rejected')) {
      console.error('native_model_fixture_cleanup_unconfirmed');
      if (!fixtureFailure) fixtureFailure = Error('native_model_fixture_cleanup_unconfirmed');
    }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) {
      if (!fixtureFailure) fixtureFailure = error;
      else console.error('native_model_fixture_remove_failed:' + error.code);
    }
    if (fixtureFailure) throw fixtureFailure;
  }
  console.log(`Runtime models: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exit(1); });
