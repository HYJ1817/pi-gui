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
let streaming=false,current=null,helloAttempts=0,prompts=0,delayedStartup=null,firstState=true,helloBeforeStartup=false;
const failFirst=process.argv.includes('--fixture-first-hello-fails'),failAll=process.argv.includes('--fixture-hello-always-fails'),delayStartup=process.argv.includes('--fixture-delay-startup-state');
const append=message=>fs.appendFileSync(file,JSON.stringify({type:'message',id:randomUUID(),message})+'\n');
fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:native,cwd})+'\n');
const ready=import(guardUrl).then(({installToolGuard,toolTransport})=>{
  const connection={url:process.env.PI_GUI_TOOL_URL,token:process.env.PI_GUI_TOOL_TOKEN};
  installToolGuard({on:(type,fn)=>hooks.set(type,fn),getAllTools:()=>[{name:'write',sourceInfo:{source:'builtin',path:'builtin:write',scope:'temporary',origin:'top-level'}}]},
    {...connection,post:async(action,body,options)=>{
      if(action==='hello'){helloAttempts++;if(failAll||failFirst&&helloAttempts===1)throw Error('temporary fixture hello failure');}
      const result=await toolTransport(connection,action,body,options);
      if(action==='hello'&&delayStartup&&delayedStartup){helloBeforeStartup=true;delayedStartup();delayedStartup=null;}
      return result;
    }});
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
  }catch{
    try{await hooks.get('tool_execution_end')({toolCallId:'same-tool'},ctx);}catch{send({type:'extension_error',extensionPath:require('node:url').fileURLToPath(guardUrl),event:'tool_execution_end',error:'fixture end failed'});}
    send({type:'tool_execution_end',toolCallId:'same-tool',toolName:'write',isError:true});await settle(own,true);
  }
}
rl.on('line',async line=>{
  await ready;const c=JSON.parse(line);
  if(c.type==='prompt'&&c.message==='CRASH_FIXTURE_A'){send({type:'agent_start'});response(c,{disposition:'started'});setImmediate(()=>process.exit(23));return;}
  if(c.type==='prompt'){prompts++;void run(c);return;}
  if(c.type==='fixture_error'){
    const extensionPath=c.kind==='unrelated'?path.join(__dirname,'foreign-index.js'):c.kind==='guard'?require('node:url').fileURLToPath(guardUrl):undefined;
    send({type:'extension_error',extensionPath,event:'agent_start',error:'fixture-private-error-never-published'});response(c);return;
  }
  if(c.type==='extension_ui_response'){
    const run=current;append({role:'assistant',content:[{type:'text',text:'finished-'+path.basename(cwd)}]});
    if(run)await settle(run);response(c);return;
  }
  if(c.type==='abort'){if(current){current.cancelled=true;await settle(current,true);}response(c);return;}
  if(c.type==='fixture_metrics'){response(c,{fixtureHelloAttempts:helloAttempts,fixturePrompts:prompts,fixtureHelloBeforeStartup:helloBeforeStartup});return;}
  // This fixture has one native session; reject a mutation rather than claiming
  // success while silently keeping the old native/extension session unchanged.
  if(c.type==='new_session'){send({type:'response',id:c.id,command:c.type,success:false,error:'fixture mutation rejected'});return;}
  if(c.type==='get_state'){
    const reply=()=>response(c,{sessionId:native,sessionFile:file,isStreaming:streaming,isCompacting:false});
    if(delayStartup&&firstState){firstState=false;delayedStartup=reply;}else reply();return;
  }
  if(c.type==='get_messages'){response(c,{messages:fs.readFileSync(file,'utf8').trim().split('\n').slice(1).map(line=>JSON.parse(line).message)});return;}
  response(c);
});
`);
  fs.writeFileSync(path.join(pkg,'foreign-index.js'),'// unrelated extension fixture');
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
    await check('actual unrelated extension_error on A does not revoke its guard or disturb B/C runs', async () => {
      await children[0].request({type:'fixture_error',kind:'unrelated'});assert.equal(children[0].toolGuard.ready(),true);
      assert.ok((await Promise.all(owners.map(value=>registry.read(value,{type:'get_state'})))).every(state=>state.isStreaming));
      const error=events(ids[0],'extension_error').at(-1).event;assert.deepEqual(Object.keys(error).sort(),['bridgeRun','error','type']);
      assert.equal(JSON.stringify(error).includes('fixture-private-error'),false);assert.equal(JSON.stringify(error).includes(pkg),false);
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
    const readFixture=async child=>({...await child.request({type:'get_state'}),...await child.request({type:'fixture_metrics'})});
    async function controlled(name, run, extraArgs = [], additions = {}) {
      const cwd = path.join(world, name); fs.mkdirSync(cwd);
      const identity = { backendInstance: 'backend', projectId: name, repoId: name, workspaceId: 'project-' + name,
        workspaceEpoch: 'epoch', conversationId: name, runtimeId: name, runtimeGeneration: 'initial', sessionId: null };
      let child, active = true;
      const context = { cwd, workspace: workspace(cwd, name), getOwner: () => ({ ...identity }), isCurrent: () => active };
      child = await createSessionRuntime({ context, piBin: cli, dataDir: path.join(world, 'data'), toolScheduler: scheduler, extraArgs, ...additions,
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
    for (const mode of ['switch-root', 'revoke-guard', 'replace-owner', 'private-switch-sent', 'private-switch-completed', 'private-switch-already-pending', 'completed-stop']) await check('final synchronous admission witness rejects Classic ' + mode + ' during workspace validation', async () => {
      let cwd = mode === 'switch-root' ? same : other, guardReady = true, proved = false, created = 0, sessionEpoch = 0, guardRevision = 0;
      const classicOwner = { backendInstance: 'backend', projectId: 'classic', repoId: null, workspaceId: 'classic', workspaceEpoch: 'epoch',
        conversationId: 'classic-chat', runtimeId: 'classic-runtime', runtimeGeneration: 'one', sessionId: 'classic-native' };
      const primary = { getCwd: () => cwd, getRoot: async value => value, getOwner: () => ({ ...classicOwner }), isShuttingDown: () => false,
        getState: () => ({ state: 'ready' }), getSessionEpoch: () => sessionEpoch,
        isSessionChanging: () => mode === 'private-switch-already-pending',
        assertReady: async () => { const revision = guardRevision; return () => revision === guardRevision; }, readState: async () => ({ sessionId: classicOwner.sessionId }),
        ready: (_cwd, native) => guardReady && native === 'classic-native' };
      const isolated = createRuntimeRegistry({ dataDir: path.join(world, 'classic-witness-' + mode),
        validateWorkspace: async () => { if (proved) {
          if (mode === 'switch-root') cwd = other;
          if (mode === 'revoke-guard') guardReady = false;
          if (mode === 'replace-owner') classicOwner.runtimeGeneration = 'replacement';
          if (mode === 'private-switch-sent') sessionEpoch++;
          if (mode === 'completed-stop') guardRevision++; // ready/owner are unchanged after Stop completes
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
    await check('real guardian startup hello precedes startup get_state reply without forcing ready',()=>controlled('hello-before-startup',async(child,identity)=>{
      await child.assertToolGuardReady();const state=await readFixture(child);assert.equal(state.fixtureHelloBeforeStartup,true);
      assert.equal(state.sessionId,identity.sessionId);assert.equal(child.getState().state,'ready');assert.equal(state.fixturePrompts,0);
    },['--fixture-delay-startup-state']));
    await check('real child first hello failure recovers before ordinary send with exactly one prompt',()=>controlled('hello-retry',async(child,identity)=>{
      const input={type:'prompt',id:'one-input',message:'RETAINED_ONCE'},copy=JSON.stringify(input);
      await child.assertToolGuardReady();await child.send(input);await until(()=>fs.existsSync(path.join(world,'hello-retry','RETAINED_ONCE.txt')));
      const state=await readFixture(child);assert.equal(state.fixturePrompts,1);assert.equal(state.fixtureHelloAttempts,3);assert.equal(state.sessionId,identity.sessionId);assert.equal(JSON.stringify(input),copy);
      const messages=(await child.request({type:'get_messages'})).messages;assert.equal(messages.filter(message=>message.role==='user').length,1);
      assert.equal((await child.abortAndWait({type:'abort'})).ok,true);
    },['--fixture-first-hello-fails']));
    await check('permanent initial hello failure terminates at three attempts and retains unsent input',()=>controlled('hello-exhausted',async child=>{
      await assert.rejects(()=>child.assertToolGuardReady(),error=>error.code==='tool_guard_unavailable');
      const input={type:'prompt',id:'unsent',message:'KEEP_INPUT'},copy=JSON.stringify(input);
      await assert.rejects(()=>child.send(input),error=>error.code==='tool_guard_unavailable');assert.equal(JSON.stringify(input),copy);
      const state=await readFixture(child);assert.equal(state.fixtureHelloAttempts,3);assert.equal(state.fixturePrompts,0);assert.equal(child.toolGuard.ready(),false);
      assert.deepEqual((await child.request({type:'get_messages'})).messages,[]);
    },['--fixture-hello-always-fails']));
    for(const kind of ['guard','unknown'])await check('real '+kind+' extension fault cannot be healed by readState or resume',()=>controlled('fault-'+kind,async child=>{
      await child.assertToolGuardReady();await child.request({type:'fixture_error',kind});assert.equal(child.toolGuard.ready(),false);assert.equal(child.toolGuard.resume(),false);
      const input={type:'prompt',message:'KEEP_'+kind},copy=JSON.stringify(input);await assert.rejects(()=>child.send(input),error=>error.code==='tool_guard_unavailable');assert.equal(JSON.stringify(input),copy);
      assert.equal((await readFixture(child)).fixturePrompts,0);
    }));
    await check('ordinary send rechecks generation after guard await and preserves rejected input',()=>controlled('send-generation',async(child,identity)=>{
      await child.assertToolGuardReady();const prove=child.toolGuard.assertReady.bind(child.toolGuard);
      child.toolGuard.assertReady=async()=>{await prove();identity.runtimeGeneration='replacement';};
      const input={type:'prompt',message:'UNCHANGED'},copy=JSON.stringify(input);await assert.rejects(()=>child.send(input),error=>error.code==='stale_runtime');
      assert.equal(JSON.stringify(input),copy);assert.equal((await readFixture(child)).fixturePrompts,0);
    }));
    await check('rejected mutation keeps old Runtime proof invalid but permits a new strict same-native admission',()=>controlled('mutation-proof',async child=>{
      const proof=await child.assertToolGuardReady();await assert.rejects(()=>child.request({type:'new_session'}),error=>error.code==='pi_request_failed');assert.equal(proof(),false);assert.equal(child.toolGuard.ready(),false);
      assert.equal((await readFixture(child)).fixturePrompts,0,'settling a mutation must never replay input');
      const fresh=await child.assertToolGuardReady();assert.equal(fresh(),true);assert.equal(proof(),false,'new proof must not revive the old one');
      await child.send({type:'prompt',message:'EXPLICIT_ONCE'});await until(()=>fs.existsSync(path.join(world,'mutation-proof','EXPLICIT_ONCE.txt')));
      assert.equal((await readFixture(child)).fixturePrompts,1);assert.equal((await child.abortAndWait({type:'abort'})).ok,true);
    }));
    await check('Runtime wrapper retains its own proof when another strict revalidation completes before await returns',()=>controlled('proof-renewal-race',async child=>{
      await child.assertToolGuardReady();const prove=child.toolGuard.assertReady.bind(child.toolGuard);
      child.toolGuard.assertReady=async()=>{const old=await prove();await assert.rejects(()=>child.request({type:'new_session'}),error=>error.code==='pi_request_failed');
        const fresh=await prove();assert.equal(fresh(),true);assert.equal(old(),false);return old;};
      await assert.rejects(()=>child.assertToolGuardReady(),error=>error.code==='stale_runtime');assert.equal((await readFixture(child)).fixturePrompts,0);
      child.toolGuard.assertReady=prove;assert.equal((await child.assertToolGuardReady())(),true);
    }));
    for (const channel of ['send', 'messageEditRequest']) await check('completed Stop across Runtime ' + channel + ' change-capture wait never replays the old input', async () => {
      let hold = true, entered = false, release; const gate = new Promise(resolve => { release = resolve; });
      const changes = { available: () => false, invalidate: async () => {}, observe() {}, dispose: async () => {}, confirmWritersStopped() {},
        assertReady: async () => { if (hold) { entered = true; await gate; } } };
      await controlled('stop-capture-' + channel, async child => {
        await child.assertToolGuardReady(); const input = { type: 'prompt', message: 'KEEP_ONCE' }, copy = JSON.stringify(input);
        const waiting = child[channel](input); await until(() => entered);
        assert.equal((await child.abortAndWait({ type: 'abort' })).ok, true);
        hold = false; release();
        if (channel === 'send') await assert.rejects(() => waiting, error => error.code === 'stale_runtime');
        else { const result = await waiting; assert.equal(result.ok, false); assert.equal(result.code, 'stale_runtime'); }
        assert.equal(JSON.stringify(input), copy); assert.equal((await readFixture(child)).fixturePrompts, 0);
        await child[channel](input); await until(() => fs.existsSync(path.join(world, 'stop-capture-' + channel, 'KEEP_ONCE.txt')));
        assert.equal((await readFixture(child)).fixturePrompts, 1);
        assert.equal((await child.abortAndWait({ type: 'abort' })).ok, true);
      }, [], { createChanges: () => changes });
    });
    async function group(label,run){
      const root=path.join(world,label),independent=path.join(world,label+'-other');fs.mkdirSync(root);fs.mkdirSync(independent);
      const adapters=[],groupFrames=[];
      const local=createRuntimeRegistry({...options,dataDir:path.join(world,label+'-data'),publish:frame=>groupFrames.push(frame),
        factory:async(context,emit)=>{const child=await createSessionRuntime({context,emit,piBin:cli,dataDir:path.join(world,label+'-data'),toolScheduler:scheduler,env:{...process.env,PI_CODING_AGENT_DIR:path.join(world,'agent')}});adapters.push(child);return child;}});
      try{const records=[await local.openProjectSession({workspace:workspace(root,label)}),await local.openProjectSession({workspace:workspace(root,label)}),await local.openProjectSession({workspace:workspace(independent,label+'-other')},{allowThird:true})];
        await until(()=>local.snapshot().items.every(item=>item.lifecycle==='ready'));await Promise.all(adapters.map(child=>child.assertToolGuardReady()));
        const owners=records.map(record=>local.getOwner(record.conversationId));await run({local,adapters,owners,groupFrames,root,independent});
      }finally{await local.dispose();}
    }
    for(const kind of ['guard','unknown'])await check('A '+kind+' fault retains its writer while B/C remain independently controllable',()=>group('isolated-'+kind,async({local,adapters,owners,root,independent})=>{
      await local.command(owners[0],{type:'prompt',message:'FAULT_A'});await until(()=>fs.existsSync(path.join(root,'FAULT_A.txt')));
      await local.command(owners[1],{type:'prompt',message:'WAIT_B'});await local.command(owners[2],{type:'prompt',message:'LIVE_C'});await until(()=>fs.existsSync(path.join(independent,'LIVE_C.txt')));
      await adapters[0].request({type:'fixture_error',kind});assert.equal(adapters[0].toolGuard.ready(),false);assert.equal(adapters[1].toolGuard.ready(),true);assert.equal(adapters[2].toolGuard.ready(),true);
      assert.equal(fs.existsSync(path.join(root,'WAIT_B.txt')),false);assert.equal((await adapters[2].request({type:'get_state'})).isStreaming,true);
      assert.equal((await local.command(owners[0],{type:'abort'})).ok,true);await until(()=>fs.existsSync(path.join(root,'WAIT_B.txt')));
      const states=await Promise.all(adapters.map(readFixture));assert.deepEqual(states.map(state=>state.fixturePrompts),[1,1,1]);assert.equal(states[2].isStreaming,true);assert.equal(states[1].sessionId,owners[1].sessionId);
    }));
    await check('Stop queued B permits real blocked execution_end/settled and one later explicit prompt',()=>group('queued-stop',async({local,adapters,owners,groupFrames,root,independent})=>{
      await local.command(owners[0],{type:'prompt',message:'HOLDER_A'});await until(()=>fs.existsSync(path.join(root,'HOLDER_A.txt')));
      await local.command(owners[1],{type:'prompt',message:'CANCEL_B'});await local.command(owners[2],{type:'prompt',message:'CONTINUE_C'});
      await until(()=>groupFrames.some(frame=>frame.owner?.conversationId===owners[1].conversationId&&frame.event?.type==='tool_wait_state'&&frame.event.waiting));
      assert.equal((await local.command(owners[1],{type:'abort'})).ok,true);
      await until(()=>groupFrames.some(frame=>frame.owner?.conversationId===owners[1].conversationId&&frame.event?.type==='tool_execution_end'));
      assert.equal(adapters[1].toolGuard.ready(),true);assert.equal(groupFrames.filter(frame=>frame.owner?.conversationId===owners[1].conversationId&&frame.event?.type==='extension_error').length,0);
      const input={type:'prompt',id:'explicit-after-stop',message:'EXPLICIT_B'},copy=JSON.stringify(input);await local.command(owners[1],input);assert.equal(JSON.stringify(input),copy);
      assert.equal((await local.command(owners[0],{type:'abort'})).ok,true);await until(()=>fs.existsSync(path.join(root,'EXPLICIT_B.txt'))&&fs.existsSync(path.join(independent,'CONTINUE_C.txt')));
      assert.equal(fs.existsSync(path.join(root,'CANCEL_B.txt')),false);const state=await readFixture(adapters[1]);assert.equal(state.fixturePrompts,2);assert.equal(state.sessionId,owners[1].sessionId);assert.equal((await adapters[2].request({type:'get_state'})).isStreaming,true);
    }));
    console.log(`Parallel runtime integration: ${passed}/${passed}`);
  } finally {
    await registry.dispose(); scheduler.dispose(); fs.rmSync(world, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
