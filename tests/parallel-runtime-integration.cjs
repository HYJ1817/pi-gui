// Offline end-to-end regression: production registry -> guardian/RPC children ->
// bundled guard -> shared scheduler -> native-shaped persistence. Not a model test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log('PASS ' + name); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = Date.now() + 30000;
  while (!await fn()) { if (Date.now() >= deadline) throw Error('parallel_fixture_timeout'); await sleep(20); }
}
(async () => {
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const { createSessionRuntime } = await import('../server/session-runtime.js');
  const { createSessionToolScheduler } = await import('../server/session-tool-scheduler.js');
  const { assertSharedSessionTools } = await import('../server/ordinary-sessions.js');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-parallel-integration-'));
  const pkg = path.join(world, 'node_modules/@earendil-works/pi-coding-agent');
  fs.mkdirSync(path.join(pkg, 'dist/core/extensions'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.6.0', bin: { pi: 'cli.cjs' } }));
  // Excerpts from the actual 1.6.0 .d.ts files, not invented top-level message shapes.
  fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), `
export interface ExtensionAPI {
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
  on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
  on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
  getAllTools(): ToolInfo[];
}
export interface ToolCallEventResult { block?: boolean; reason?: string; }
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
`);
  fs.writeFileSync(path.join(pkg, 'dist/core/session-manager.d.ts'), 'export declare class SessionManager { getSessionId(): string; }');
  const cli = path.join(pkg, 'cli.cjs');
  const guardUrl = pathToFileURL(path.join(__dirname, '../extensions/pi-gui-tool-guard/index.js')).href;
  fs.writeFileSync(cli, `const guardUrl=${JSON.stringify(guardUrl)};\n` + String.raw`
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const rl=require('node:readline').createInterface({input:process.stdin});
const native=randomUUID(),cwd=process.cwd(),file=path.join(cwd,native+'.jsonl'),hooks=new Map();
const ctx={cwd,sessionManager:{getSessionId:()=>native}},send=value=>console.log(JSON.stringify(value));
let streaming=false,current=null;
const append=message=>fs.appendFileSync(file,JSON.stringify({type:'message',id:randomUUID(),message})+'\n');
fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:native,cwd})+'\n');
const ready=import(guardUrl).then(({installToolGuard})=>{
  installToolGuard({on:(type,fn)=>hooks.set(type,fn),getAllTools:()=>[{name:'write',sourceInfo:{source:'builtin'}}]},
    {url:process.env.PI_GUI_TOOL_URL,token:process.env.PI_GUI_TOOL_TOKEN});
  hooks.get('session_start')({},ctx);
});
const response=(c,data={})=>send({type:'response',id:c.id,command:c.type,success:true,data});
async function settle(run,aborted=false){
  if(current!==run)return;
  if(run.lease)await hooks.get('tool_execution_end')({toolCallId:'same-tool'},ctx);
  if(current!==run)return;
  streaming=false;current=null;await hooks.get('agent_settled')({},ctx);send({type:'agent_settled',aborted});
}
async function run(c){
  const own=current={lease:false,cancelled:false};streaming=true;
  append({role:'user',content:[{type:'text',text:c.message}]});send({type:'agent_start'});
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'output-'+c.message}});
  response(c,{disposition:'started'});
  try{
    await hooks.get('tool_call')({toolName:'write',toolCallId:'same-tool',input:{path:c.message+'.txt',content:c.message}},ctx);
    own.lease=true;if(own.cancelled){await settle(own,true);return;}
    fs.writeFileSync(path.join(cwd,c.message+'.txt'),c.message);
    send({type:'tool_execution_start',toolCallId:'same-tool',toolName:'write'});
    send({type:'extension_ui_request',id:'same-approval',method:'confirm',title:'permission-'+c.message});
  }catch{await settle(own,true);}
}
rl.on('line',async line=>{
  await ready;const c=JSON.parse(line);
  if(c.type==='prompt'&&c.message==='CRASH_FIXTURE_A'){send({type:'agent_start'});response(c,{disposition:'started'});setImmediate(()=>process.exit(23));return;}
  if(c.type==='prompt'){void run(c);return;}
  if(c.type==='extension_ui_response'){
    const run=current;append({role:'assistant',content:[{type:'text',text:'finished-'+path.basename(cwd)}]});
    if(run)await settle(run);response(c);return;
  }
  if(c.type==='abort'){if(current){current.cancelled=true;await settle(current,true);}response(c);return;}
  if(c.type==='get_state'){response(c,{sessionId:native,sessionFile:file,isStreaming:streaming,isCompacting:false});return;}
  if(c.type==='get_messages'){response(c,{messages:fs.readFileSync(file,'utf8').trim().split('\n').slice(1).map(line=>JSON.parse(line).message)});return;}
  response(c);
});
`);
  const same = path.join(world, 'same-project'), other = path.join(world, 'other-project');
  fs.mkdirSync(same); fs.mkdirSync(other);
  const workspace = (cwd, id) => ({ projectId: id, repoId: id, workspaceId: 'project-' + id, workspaceEpoch: 'epoch', cwd, root: cwd, branch: '' });
  const scheduler = createSessionToolScheduler(), frames = [], children = [];
  const options = {
    dataDir: path.join(world, 'data'), publish: event => frames.push(event), validateWorkspace: async () => {},
    sharedAdmission: assertSharedSessionTools,
    factory: async (context, emit) => {
      const child = await createSessionRuntime({ context, emit, piBin: cli, dataDir: path.join(world, 'data'),
        toolScheduler: scheduler, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(world, 'agent') } });
      children.push(child); return child;
    },
  };
  let registry = createRuntimeRegistry(options);
  const open = (cwd, id, allowThird = false) => registry.openProjectSession({ workspace: workspace(cwd, id) }, { allowThird });
  const owner = id => registry.getOwner(id);
  const events = (id, type) => frames.filter(frame => frame.owner?.conversationId === id && frame.event?.type === type);
  try {
    const a = await open(same, 'same');
    let b;
    await check('immediate same-project B admission waits for A startup and native hello, not a retry', async () => {
      assert.equal(children[0].getState().state, 'starting');
      assert.equal(children[0].toolGuard.status().installed, false);
      assert.equal(children[0].toolGuard.ready(), false);
      // Deliberately do not await A's RPC ready, prepare or hello here.
      b = await open(same, 'same');
      assert.equal(children[0].toolGuard.ready(), true);
    });
    await until(() => registry.snapshot().items.find(item => item.conversationId === b.conversationId)?.lifecycle === 'ready');
    const c = await open(other, 'other', true);
    await until(() => registry.snapshot().items.every(item => item.lifecycle === 'ready'));
    await Promise.all(children.map(child => child.toolGuard.assertReady()));
    const ids = [a, b, c].map(item => item.conversationId), owners = ids.map(owner);
    const nativeFiles = await Promise.all(owners.map(value => registry.read(value, { type: 'get_state' }).then(state => state.sessionFile)));
    await check('A/B/C have independent guardian/RPC/native identities including same-cwd A/B', () => {
      assert.equal(new Set(owners.map(value => value.sessionId)).size, 3);
      assert.equal(new Set(owners.map(value => value.runtimeId)).size, 3);
      assert.equal(new Set(owners.map(value => value.runtimeGeneration)).size, 3);
    });
    await check('fourth child is refused without bypassing resource limits', async () => {
      await assert.rejects(() => open(other, 'other', true), error => error.code === 'runtime_limit');
      assert.equal(children.length, 3);
    });
    await registry.focus(owners[1]);
    await registry.command(owners[0], { type: 'prompt', id: 'same-request', message: 'A' });
    await until(() => events(ids[0], 'extension_ui_request').length > 0);
    await registry.command(owners[1], { type: 'prompt', id: 'same-request', message: 'B' });
    await registry.command(owners[2], { type: 'prompt', id: 'same-request', message: 'C' });
    await until(() => ids.every(id => events(id, 'agent_start').length > 0) && events(ids[2], 'extension_ui_request').length > 0
      && events(ids[1], 'tool_wait_state').some(frame => frame.event.waiting));
    await check('all three runs overlap; B waits only for its shared workspace tool while C executes', async () => {
      const states = await Promise.all(owners.map(value => registry.read(value, { type: 'get_state' })));
      assert.ok(states.every(state => state.isStreaming));
      assert.ok(fs.existsSync(path.join(same, 'A.txt'))); assert.ok(!fs.existsSync(path.join(same, 'B.txt')));
      assert.equal(fs.readFileSync(path.join(other, 'C.txt'), 'utf8'), 'C');
    });
    await check('selected conversation is not the owner of background text, tools or equal approval IDs', () => {
      for (let i = 0; i < ids.length; i++) {
        const deltas = events(ids[i], 'message_update').map(frame => frame.event.assistantMessageEvent.delta);
        assert.deepEqual(deltas, ['output-' + ['A', 'B', 'C'][i]]);
        const ownFrames = frames.filter(frame => frame.type === 'runtime_event' && frame.owner?.conversationId === ids[i]);
        assert.ok(ownFrames.every(frame => frame.owner.runtimeId === owners[i].runtimeId));
        assert.ok(ownFrames.every((frame, n) => !n || frame.eventSequence > ownFrames[n - 1].eventSequence));
      }
      assert.equal(events(ids[0], 'extension_ui_request')[0].event.title, 'permission-A');
      assert.equal(events(ids[2], 'extension_ui_request')[0].event.title, 'permission-C');
    });
    await check('same-session prompt is rejected while another session remains independently controllable', async () => {
      await assert.rejects(() => registry.command(owners[1], { type: 'prompt', message: 'duplicate' }), error => error.code === 'runtime_busy');
    });
    const stopped = await registry.command(owners[0], { type: 'abort' });
    await until(() => events(ids[1], 'extension_ui_request').length > 0);
    await check('Stop A releases only its confirmed lease; B advances and C keeps running', async () => {
      assert.equal(stopped.ok, true);
      assert.equal((await registry.read(owners[0], { type: 'get_state' })).isStreaming, false);
      assert.equal((await registry.read(owners[1], { type: 'get_state' })).isStreaming, true);
      assert.equal((await registry.read(owners[2], { type: 'get_state' })).isStreaming, true);
      assert.equal(fs.readFileSync(path.join(same, 'B.txt'), 'utf8'), 'B');
    });
    await check('stopped A cannot reuse C approval; B approval completes only B', async () => {
      await assert.rejects(() => registry.command(owners[0], { type: 'extension_ui_response', id: 'same-approval', confirmed: true }), error => error.code === 'stale_approval');
      await registry.command(owners[1], { type: 'extension_ui_response', id: 'same-approval', confirmed: true });
      await until(() => events(ids[1], 'agent_settled').length > 0);
      assert.equal((await registry.read(owners[2], { type: 'get_state' })).isStreaming, true);
    });
    await check('abnormal A Pi child exit does not end C or corrupt the ready B runtime', async () => {
      await registry.command(owners[0], { type: 'prompt', message: 'CRASH_FIXTURE_A' });
      await until(() => registry.snapshot().items.find(item => item.conversationId === ids[0])?.lifecycle === 'error');
      assert.equal((await registry.read(owners[2], { type: 'get_state' })).isStreaming, true);
      assert.equal((await registry.read(owners[1], { type: 'get_state' })).sessionId, owners[1].sessionId);
      assert.equal(children[0].toolGuard.ready(), false);
      await assert.rejects(() => registry.command(owner(ids[0]), { type: 'prompt', message: 'after-crash' }), error => error.code === 'runtime_not_ready');
    });
    await registry.command(owners[2], { type: 'extension_ui_response', id: 'same-approval', confirmed: true });
    await until(() => events(ids[2], 'agent_settled').length > 0);
    await check('persistence is native-session scoped, not a shared selected-session buffer', async () => {
      for (let i = 0; i < owners.length; i++) {
        const lines = fs.readFileSync(nativeFiles[i], 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(lines[0].id, owners[i].sessionId);
        assert.equal(lines[1].message.content[0].text, ['A', 'B', 'C'][i]);
      }
    });
    await registry.dispose();
    await check('closing the app confirms all guardian trees cleaned before dropping live owners', () => {
      assert.ok(children.every(child => child.cleanupConfirmed())); assert.equal(scheduler.busy(), false);
    });
    registry = createRuntimeRegistry(options);
    await check('backend restart restores history identities as dormant; old owners cannot replay', async () => {
      const snapshot = registry.snapshot(); assert.equal(snapshot.liveCount, 0); assert.equal(snapshot.items.length, 3);
      assert.ok(snapshot.items.every(item => item.lifecycle === 'dormant' && item.owner === null));
      for (const previous of owners) await assert.rejects(() => registry.command(previous, { type: 'prompt', message: 'late' }), error => error.code === 'stale_runtime');
      assert.equal(children.length, 3);
    });
    async function controlled(name, run) {
      const cwd = path.join(world, name); fs.mkdirSync(cwd);
      const identity = { backendInstance: 'backend', projectId: name, repoId: name, workspaceId: 'project-' + name,
        workspaceEpoch: 'epoch', conversationId: name, runtimeId: name, runtimeGeneration: 'initial', sessionId: null };
      let child, active = true;
      const context = { cwd, workspace: workspace(cwd, name), getOwner: () => ({ ...identity }), isCurrent: () => active };
      child = await createSessionRuntime({ context, piBin: cli, dataDir: path.join(world, 'data'), toolScheduler: scheduler,
        env: { ...process.env, PI_CODING_AGENT_DIR: path.join(world, 'agent') }, emit: event => {
          if (event.type === 'bridge_status' && event.state === 'ready') void child.request({ type: 'get_state' }).then(state => { identity.sessionId = state.sessionId; }).catch(() => {});
        } });
      try { child.start(); await run(child, identity, context); }
      finally { active = false; await child.dispose(); }
    }
    await check('startup wait rejects generation supersession instead of admitting from a late hello', () => controlled('generation', async (child, identity) => {
      const pending = child.assertToolGuardReady(); identity.runtimeGeneration = 'replacement';
      await assert.rejects(() => pending, error => error.code === 'stale_runtime');
    }));
    await check('shared admission stays fail-closed when Pi RPC is ready but its source contract is missing', async () => {
      const typesFile = path.join(pkg, 'dist/core/extensions/types.d.ts'), contract = fs.readFileSync(typesFile, 'utf8');
      fs.writeFileSync(typesFile, 'export interface ExtensionAPI {}');
      try { await controlled('unsupported', async (child, identity, context) => {
        await until(() => child.getState().state === 'ready' && identity.sessionId);
        await assert.rejects(() => assertSharedSessionTools(context.workspace, [{ workspace: context.workspace, adapter: child }]), error => error.code === 'tool_guard_unavailable');
        assert.equal(child.toolGuard.status().installed, false);
      }); } finally { fs.writeFileSync(typesFile, contract); }
    });
    await check('native hello invalidation cannot be replaced by source capability or RPC ready', () => controlled('invalidated', async child => {
      await child.assertToolGuardReady(); child.toolGuard.invalidate();
      await assert.rejects(() => child.assertToolGuardReady(), error => error.code === 'tool_guard_unavailable');
    }));
    await check('owner is rechecked after the awaited native guard readback', () => controlled('post-await', async (child, identity) => {
      await child.assertToolGuardReady();
      const prove = child.toolGuard.assertReady.bind(child.toolGuard);
      child.toolGuard.assertReady = async () => { await prove(); identity.runtimeGeneration = 'replacement'; };
      await assert.rejects(() => child.assertToolGuardReady(), error => error.code === 'stale_runtime');
    }));
    for (const code of ['stale_workspace', 'maintenance']) await check('admission rechecks ' + code + ' after startup wait before creating a child', async () => {
      let changed = false, created = 0;
      const isolated = createRuntimeRegistry({ dataDir: path.join(world, 'recheck-' + code),
        validateWorkspace: async () => { if (changed && code === 'stale_workspace') throw Object.assign(Error(code), { code }); },
        beforeStart: () => changed && code === 'maintenance' ? code : null,
        sharedAdmission: async () => { changed = true; return () => true; }, factory: async () => { created++; throw Error('must_not_spawn'); } });
      try {
        await assert.rejects(() => isolated.openProjectSession({ workspace: workspace(other, 'other') }), error => error.code === code);
        assert.equal(created, 0); assert.equal(isolated.snapshot().liveCount, 0);
      } finally { await isolated.dispose(); }
    });
    await check('earlier Runtime proof revoked while awaiting a later child cannot authorize sharing', async () => {
      let firstReady = true;
      const adapter = (prove, after = () => {}) => ({ toolGuard: { ready: prove },
        assertToolGuardReady: async () => { after(); return prove; } });
      await assert.rejects(() => assertSharedSessionTools(workspace(same, 'same'), [
        { workspace: workspace(same, 'same'), adapter: adapter(() => firstReady) },
        { workspace: workspace(same, 'same'), adapter: adapter(() => true, () => { firstReady = false; }) },
      ]), error => error.code === 'tool_guard_unavailable');
    });
    for (const mode of ['switch-root', 'revoke-guard', 'replace-owner', 'private-switch-sent', 'private-switch-completed', 'private-switch-already-pending']) await check('final synchronous admission witness rejects Classic ' + mode + ' during workspace validation', async () => {
      let cwd = mode === 'switch-root' ? same : other, guardReady = true, proved = false, created = 0, sessionEpoch = 0;
      const classicOwner = { backendInstance: 'backend', projectId: 'classic', repoId: null, workspaceId: 'classic', workspaceEpoch: 'epoch',
        conversationId: 'classic-chat', runtimeId: 'classic-runtime', runtimeGeneration: 'one', sessionId: 'classic-native' };
      const primary = { getCwd: () => cwd, getRoot: async value => value, getOwner: () => ({ ...classicOwner }), isShuttingDown: () => false,
        getState: () => ({ state: 'ready' }), getSessionEpoch: () => sessionEpoch,
        isSessionChanging: () => mode === 'private-switch-already-pending',
        assertReady: async () => {}, readState: async () => ({ sessionId: classicOwner.sessionId }),
        ready: (_cwd, native) => guardReady && native === 'classic-native' };
      const isolated = createRuntimeRegistry({ dataDir: path.join(world, 'classic-witness-' + mode),
        validateWorkspace: async () => { if (proved) {
          if (mode === 'switch-root') cwd = other;
          if (mode === 'revoke-guard') guardReady = false;
          if (mode === 'replace-owner') classicOwner.runtimeGeneration = 'replacement';
          if (mode === 'private-switch-sent') sessionEpoch++;
          if (mode === 'private-switch-completed') sessionEpoch += 2; // owner/hello remain the old cached native
        } },
        sharedAdmission: async (target, others) => { const proof = await assertSharedSessionTools(target, others, primary); proved = true; return proof; },
        factory: async () => { created++; throw Error('must_not_spawn'); } });
      try {
        await assert.rejects(() => isolated.openProjectSession({ workspace: workspace(other, 'other') }), error => error.code === 'tool_guard_unavailable');
        assert.equal(created, 0); assert.equal(isolated.liveCount(), 0);
      } finally { await isolated.dispose(); }
    });
    await check('missing shared admission witness remains fail-closed before creating a child', async () => {
      let created = 0;
      const isolated = createRuntimeRegistry({ dataDir: path.join(world, 'missing-witness'), sharedAdmission: async () => {},
        factory: async () => { created++; throw Error('must_not_spawn'); } });
      try {
        await assert.rejects(() => isolated.openProjectSession({ workspace: workspace(other, 'other') }), error => error.code === 'tool_guard_unavailable');
        assert.equal(created, 0);
      } finally { await isolated.dispose(); }
    });
    console.log(`Parallel runtime integration: ${passed}/${passed}`);
  } finally {
    await registry.dispose(); scheduler.dispose(); fs.rmSync(world, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
