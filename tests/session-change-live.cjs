// Opt-in only: node tests/session-change-live.cjs [bound-Pi-package-directory]
// Runs the installed Pi dispatcher with a fixture stream provider. No model/network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

(async () => {
  const { createPiLaunch } = await import('../server/pi-launch.js');
  const launch = createPiLaunch();
  const packageDir = process.argv[2] || launch.packageDir();
  assert.ok(packageDir, 'Cannot prove installed Pi launch identity');
  if (process.argv[2]) assert.equal(path.resolve(packageDir), path.resolve(launch.packageDir()), 'Explicit package must match bound launch identity');
  const metadata = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const pi = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')));
  const { createSessionChangeStore } = await import('../server/session-change-store.js');
  const { createSessionChangeBridge } = await import('../server/session-change-bridge.js');
  const { installSessionChangeExtension, transport } = await import('../extensions/pi-gui-revert/index.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-gui-session-change-live-'));
  const workspace = path.join(root, 'workspace'), agentDir = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
  await fs.mkdir(workspace); await fs.mkdir(agentDir);
  let checks = 0, session, bridge, secondSession, secondBridge;
  const check = (name, fn) => Promise.resolve().then(fn).then(() => { checks++; console.log('  ok  ' + name); });
  try {
    // Real production privacy checks, including Windows ACLs; no injected checker.
    const store = await createSessionChangeStore({ dataDir: path.join(root, 'data') });
    await check('production private evidence directory initialized', () => assert.ok(store));
    execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true, stdio: 'pipe' });
    await fs.writeFile(path.join(workspace, 'tracked.txt'), 'base\n');
    execFileSync('git', ['-C', workspace, 'add', 'tracked.txt'], { windowsHide: true, stdio: 'pipe' });
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'], { windowsHide: true, stdio: 'pipe' });
    await fs.writeFile(path.join(workspace, 'tracked.txt'), 'user dirty\n');
    await fs.writeFile(path.join(workspace, 'untracked.txt'), 'user untracked\n');
    const bom = Buffer.from('\ufeffalpha\r\nbeta\r\n');
    await fs.writeFile(path.join(workspace, 'bom.txt'), bom);
    const settings = pi.SettingsManager.inMemory({});
    const manager = pi.SessionManager.create(workspace, sessions);
    const owner = Object.fromEntries(['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'runtimeId', 'runtimeGeneration'].map(k => [k, randomUUID()]));
    owner.sessionId = manager.getSessionId();
    const wsStat = await fs.stat(workspace);
    const workspaceFingerprint = createHash('sha256').update(JSON.stringify([wsStat.dev, wsStat.ino, wsStat.birthtimeMs])).digest('hex');
    const scope = { runtimeOwner: owner, conversationId: owner.conversationId, workspaceId: owner.workspaceId, workspaceEpoch: owner.workspaceEpoch, nativeSessionId: owner.sessionId, workspaceFingerprint };
    bridge = createSessionChangeBridge({ store, launch, resolveScope: async () => scope,
      withAuthority: async fn => fn({ root: workspace }), extensionPath: path.resolve(__dirname, '../extensions/pi-gui-revert/index.js') });
    const prepared = await bridge.prepare();
    assert.ok(prepared, 'Bound installed Pi public API is unverified');
    const connection = { url: prepared.env.PI_GUI_SESSION_CHANGE_URL, token: prepared.env.PI_GUI_SESSION_CHANGE_TOKEN };
    const factories = { createWriteToolDefinition: pi.createWriteToolDefinition, createEditToolDefinition: pi.createEditToolDefinition };
    const guard = { name: 'guard', factory: api => installSessionChangeExtension(api, { ...factories, connection, ownSource: '<inline:guard>' }) };
    const nested = { name: 'nested-fixture', factory(api) {
      api.registerTool({ name: 'nested_write', label: 'nested fixture', description: 'Fixture nested write', parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async (_id, _args, _signal, _update, ctx) => (await ctx.executeTool('write', { path: 'nested.txt', content: 'nested after\n' })).result });
      // Loaded after guard: proves operations capture the final, later-hook rewrite.
      api.on('tool_call', event => { if (event.toolName === 'write' && event.input.path === 'hook-input.txt') event.input.path = 'hook-final.txt'; });
      api.on('tool_result', event => {
        if (event.toolName === 'write' && event.input.path === 'final-error.txt') return { isError: true };
      });
    } };
    const loaderFor = async (extensions, additionalExtensionPaths = []) => {
      const loader = new pi.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true,
        noPromptTemplates: true, noContextFiles: true, extensionFactories: extensions, additionalExtensionPaths });
      await loader.reload(); return loader;
    };
    const loader = await loaderFor([guard, nested]);
    const extensionFile = path.resolve(__dirname, '../extensions/pi-gui-revert/index.js');
    const oldEnvironment = Object.fromEntries(Object.keys(prepared.env).map(key => [key, process.env[key]]));
    let fileLoader;
    try {
      Object.assign(process.env, prepared.env);
      fileLoader = await loaderFor([nested], [extensionFile]);
      assert.equal(fileLoader.getExtensions().errors.length, 0, 'Actual file extension load failed: ' + fileLoader.getExtensions().errors.map(e => e.error).join('; '));
    } finally {
      for (const [key, value] of Object.entries(oldEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    const runtime = await pi.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const model = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://127.0.0.1:1', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 };
    const options = { cwd: workspace, agentDir, model, modelRuntime: runtime, settingsManager: settings, tools: ['write', 'edit', 'nested_write'] };
    let planned = [], serial = 0;
    const fixtureStream = () => {
      const calls = planned.splice(0);
      const message = { role: 'assistant', content: calls.length ? calls.map(c => ({ type: 'toolCall', id: 'fixture-' + (++serial), name: c.name, arguments: c.args })) : [{ type: 'text', text: 'fixture done' }],
        api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: calls.length ? 'toolUse' : 'stop', timestamp: Date.now() };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, async result() { return message; } };
    };
    async function bind(manager, resourceLoader = loader, reason = 'startup') {
      const result = await pi.createAgentSession({ ...options, resourceLoader, sessionManager: manager, sessionStartEvent: { type: 'session_start', reason } });
      session = result.session;
      await session.bindExtensions({ mode: 'rpc', onError: event => { throw Error('Fixture extension error: ' + event.event + ':' + event.error); } });
      session.agent.streamFunction = fixtureStream;
    }
    async function waitSource(expected) {
      const deadline = Date.now() + 5000;
      do { if ((await bridge.summary()).sourceVerified === expected) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
      assert.equal((await bridge.summary()).sourceVerified, expected, 'Source handshake did not settle');
    }
    async function run(name, args, expectedError = false) {
      planned = [{ name, args }]; await session.agent.prompt('Run fixture tool call');
      const result = session.agent.state.messages.filter(m => m.role === 'toolResult').at(-1);
      assert.ok(result); assert.equal(Boolean(result.isError), expectedError, 'Unexpected tool outcome: ' + String(result.content?.[0]?.text || '').replaceAll(workspace, '<fixture>')); return result;
    }
    async function record(relativePath) {
      const summary = await store.summary(scope);
      const row = summary.operations.filter(item => item.relativePath === relativePath).at(-1);
      assert.ok(row, 'Missing operation: ' + relativePath); return store.read(scope, row.operationId);
    }
    async function verify(relativePath, before, after) {
      const item = await record(relativePath);
      assert.deepEqual(item.before, before); assert.deepEqual(item.intendedAfter, after); assert.deepEqual(item.observedAfter, after);
      assert.equal(item.evidenceLevel, 'intent_verified'); assert.equal(item.toolOutcome, 'success'); assert.equal(item.mutationOutcome, 'written');
      assert.equal(item.toolResultObserved, true);
      assert.deepEqual(item.scope.runtimeOwner, owner); assert.equal(item.scope.nativeSessionId, manager.getSessionId());
    }
    await bind(manager);
    await waitSource(true);
    await check('real Pi default tool override has verified source', async () => {
      assert.equal(session.getAllTools().find(t => t.name === 'write').sourceInfo.path, '<inline:guard>');
      assert.equal((await bridge.summary()).sourceVerified, true);
      const own = session.getToolDefinition('edit'), upstream = pi.createEditToolDefinition(workspace);
      assert.deepEqual(own.parameters, upstream.parameters); assert.equal(own.renderCall, upstream.renderCall); assert.equal(own.renderResult, upstream.renderResult);
    });
    await transport(connection, '/configure', { nativeSessionId: owner.sessionId, enabled: true, acknowledged: true, exclusions: [] });
    await run('write', { path: 'tracked.txt', content: 'agent after\n' });
    await check('dirty tracked file B/A/P uses actual preimage', () => verify('tracked.txt', Buffer.from('user dirty\n'), Buffer.from('agent after\n')));
    await run('write', { path: 'untracked.txt', content: 'agent untracked after\n' });
    await check('untracked file B/A/P retains user bytes', () => verify('untracked.txt', Buffer.from('user untracked\n'), Buffer.from('agent untracked after\n')));
    await run('write', { path: 'created.txt', content: 'created after\n' });
    await check('new file B is null and A/P match', () => verify('created.txt', null, Buffer.from('created after\n')));
    const editResult = await run('edit', { path: 'bom.txt', edits: [{ oldText: 'alpha', newText: 'gamma' }] });
    await check('BOM/CRLF exact B/A/P and upstream diff remain intact', async () => {
      await verify('bom.txt', bom, Buffer.from('\ufeffgamma\r\nbeta\r\n'));
      assert.equal(typeof editResult.details.diff, 'string'); assert.equal(typeof editResult.details.patch, 'string');
    });
    // P33.3 end-to-end: real default tools -> durable evidence -> actual HTTP preview.
    const previewPath = path.join(workspace, 'preview.txt');
    const previewB = Buffer.from('user preexisting\nanchor-one\nbody\nanchor-two\ntail\n');
    await fs.writeFile(previewPath, previewB);
    await run('write', { path:'preview.txt', content:'agent-one\nanchor-one\nbody\nanchor-two\ntail\n' });
    await run('edit', { path:'preview.txt', edits:[{oldText:'body',newText:'agent-two'}] });
    const previewC = Buffer.from('agent-one\nanchor-one\nagent-two\nanchor-two\nuser later\n');
    const previewR = Buffer.from('user preexisting\nanchor-one\nbody\nanchor-two\nuser later\n');
    await fs.writeFile(previewPath, previewC);
    const { createSessionRevertRoutes } = await import('../server/session-revert-routes.js');
    const { createRouter } = await import('../server/router.js');
    const { createAuth } = await import('../server/auth.js');
    const { runSessionRevert } = await import('../server/session-revert-compute.js');
    const { createServer } = await import('node:http');
    const previewIds = (await store.summary(scope)).operations.filter(row=>row.relativePath==='preview.txt').map(row=>row.operationId);
    const evidenceSnapshot = await store.previewSnapshot(scope,{evidenceIds:previewIds});
    const journalBefore = await fs.readFile(path.join(root,'data/revert-evidence/v1/journal.jsonl'));
    const gitBefore = ['HEAD','HEAD^{tree}'].map(ref=>execFileSync('git',['-C',workspace,'rev-parse',ref],{stdio:'pipe'}).toString());
    const indexBefore = await fs.readFile(path.join(workspace,'.git/index'));
    const previewServer = createServer(createRouter({ auth:createAuth({token:'fixture-preview-token',port:0}),
      sessionRevert:createSessionRevertRoutes({store,withAuthority:async(_req,body,fn)=>{
        assert.deepEqual(body.owner,owner);
        return fn({scope,root:workspace,activeWriter:false,revalidate:async()=>{}});
      }}) }));
    await new Promise(resolve=>previewServer.listen(0,'127.0.0.1',resolve));
    const previewCall = async extra=>fetch(`http://127.0.0.1:${previewServer.address().port}/api/session-revert/preview`,{method:'POST',
      headers:{'content-type':'application/json','x-pi-gui-token':'fixture-preview-token'},
      body:JSON.stringify({owner,evidenceIds:previewIds,mode:'confirmed_limited',...extra})}).then(r=>r.json());
    try {
      await check('real write/edit durable evidence produces exact byte candidate without writing',async()=>{
        const candidate = await runSessionRevert({records:evidenceSnapshot.records,selectedOperationIds:previewIds,current:previewC,gapRevision:evidenceSnapshot.gapRevision});
        assert.equal(candidate.status,'candidate');assert.deepEqual(candidate.candidate,previewR);
        assert.deepEqual(await fs.readFile(previewPath),previewC);
      });
      await check('real evidence HTTP summary separates content eligibility from unprepared writeback',async()=>{
        const result=await previewCall({});assert.equal(result.ok,true);assert.equal(result.files[0].status,'candidate');
        assert.equal(result.files[0].limited.contentEligible,true);assert.equal(result.files[0].limited.applyEligible,false);
        assert.equal(result.files[0].limited.reason,'metadata_unsupported');assert.equal(result.strict.contentEligible,false);assert.equal(result.backupReady,false);
        assert.ok(!JSON.stringify(result).includes('user preexisting'));assert.ok(!JSON.stringify(result).includes(previewC.toString()));
      });
      await check('real evidence explicit diff is deterministic and preserves later user region',async()=>{
        const first=await previewCall({includeDiff:true}),second=await previewCall({includeDiff:true});
        assert.deepEqual(first,second);assert.match(first.files[0].diff,/\+user preexisting/);assert.match(first.files[0].diff,/\+body/);
        assert.ok(!first.files[0].diff.includes('-user later'));assert.deepEqual(await fs.readFile(previewPath),previewC);
      });
      await check('real evidence current overlapping edit refuses content candidate',async()=>{
        const conflict=Buffer.from('user conflict\nanchor-one\nagent-two\nanchor-two\nuser later\n');await fs.writeFile(previewPath,conflict);
        const result=await previewCall({});assert.equal(result.ok,true);assert.equal(result.files[0].status,'refused');
        assert.equal(result.files[0].limited.contentEligible,false);assert.deepEqual(await fs.readFile(previewPath),conflict);
      });
      await check('all real preview requests leave journal index and Git refs unchanged',async()=>{
        assert.deepEqual(await fs.readFile(path.join(root,'data/revert-evidence/v1/journal.jsonl')),journalBefore);
        assert.deepEqual(await fs.readFile(path.join(workspace,'.git/index')),indexBefore);
        assert.deepEqual(['HEAD','HEAD^{tree}'].map(ref=>execFileSync('git',['-C',workspace,'rev-parse',ref],{stdio:'pipe'}).toString()),gitBefore);
      });
    } finally { await new Promise(resolve=>{previewServer.close(resolve);previewServer.closeAllConnections();}); }
    await run('write', { path: 'hook-input.txt', content: 'hook after\n' });
    await check('later tool_call rewrite captures final operation path', async () => {
      await verify('hook-final.txt', null, Buffer.from('hook after\n'));
      await assert.rejects(fs.stat(path.join(workspace, 'hook-input.txt')), { code: 'ENOENT' });
    });
    await run('nested_write', {});
    await check('nested ctx.executeTool dispatch records child identity', async () => {
      await verify('nested.txt', null, Buffer.from('nested after\n'));
      assert.ok((await record('nested.txt')).toolCallId.includes('/'));
    });
    await session.reload();
    await run('write', { path: 'reloaded.txt', content: 'reload after\n' });
    await check('real Pi reload preserves verified capture operations', () => verify('reloaded.txt', null, Buffer.from('reload after\n')));
    const sessionFile = session.sessionManager.getSessionFile(); session.dispose(); session = null;
    await bind(pi.SessionManager.open(sessionFile), await loaderFor([guard, nested]), 'resume');
    await waitSource(true);
    await run('write', { path: 'resumed.txt', content: 'resume after\n' });
    await check('real Pi fixture session resume captures under same native scope', () => verify('resumed.txt', null, Buffer.from('resume after\n')));
    session.dispose(); session = null;
    await bind(pi.SessionManager.open(sessionFile), fileLoader, 'resume');
    await waitSource(true);
    await run('write', { path: 'file-loaded.txt', content: 'file loader after\n' });
    await check('actual file extension loader resolves public Pi factories and captures bytes', async () => {
      assert.equal(path.resolve(session.getAllTools().find(t => t.name === 'write').sourceInfo.path), extensionFile);
      await verify('file-loaded.txt', null, Buffer.from('file loader after\n'));
    });
    await run('write', { path: 'final-error.txt', content: 'written despite final error\n' }, true);
    await check('real final tool_result error records written bytes independently', async () => {
      const item = await record('final-error.txt'); assert.equal(item.toolResultObserved, true); assert.equal(item.toolOutcome, 'error');
      assert.equal(item.mutationOutcome, 'written'); assert.deepEqual(item.observedAfter, Buffer.from('written despite final error\n'));
    });
    const secondWorkspace = path.join(root, 'worktree');
    execFileSync('git', ['-C', workspace, 'worktree', 'add', '--quiet', '--detach', secondWorkspace, 'HEAD'], { windowsHide: true, stdio: 'pipe' });
    await fs.writeFile(path.join(secondWorkspace, 'tracked.txt'), 'second user dirty\n');
    const secondManager = pi.SessionManager.create(secondWorkspace, path.join(root, 'second-sessions'));
    const secondOwner = Object.fromEntries(Object.keys(owner).map(key => [key, randomUUID()])); secondOwner.sessionId = secondManager.getSessionId();
    const secondStat = await fs.stat(secondWorkspace);
    const secondScope = { runtimeOwner: secondOwner, conversationId: secondOwner.conversationId, workspaceId: secondOwner.workspaceId,
      workspaceEpoch: secondOwner.workspaceEpoch, nativeSessionId: secondOwner.sessionId,
      workspaceFingerprint: createHash('sha256').update(JSON.stringify([secondStat.dev, secondStat.ino, secondStat.birthtimeMs])).digest('hex') };
    secondBridge = createSessionChangeBridge({ store, launch, resolveScope: async () => secondScope, withAuthority: async fn => fn({ root: secondWorkspace }), extensionPath: extensionFile });
    const secondPrepared = await secondBridge.prepare(); assert.ok(secondPrepared);
    const secondConnection = { url: secondPrepared.env.PI_GUI_SESSION_CHANGE_URL, token: secondPrepared.env.PI_GUI_SESSION_CHANGE_TOKEN };
    assert.notEqual(connection.token, secondConnection.token);
    const secondSettings = pi.SettingsManager.inMemory({});
    const secondLoader = new pi.DefaultResourceLoader({ cwd: secondWorkspace, agentDir, settingsManager: secondSettings, noExtensions: true, noSkills: true, noThemes: true,
      noPromptTemplates: true, noContextFiles: true, extensionFactories: [{ name: 'guard2', factory: api => installSessionChangeExtension(api, { ...factories, connection: secondConnection, ownSource: '<inline:guard2>' }) }] });
    await secondLoader.reload();
    ({ session: secondSession } = await pi.createAgentSession({ ...options, cwd: secondWorkspace, settingsManager: secondSettings, resourceLoader: secondLoader, sessionManager: secondManager }));
    await secondSession.bindExtensions({ mode: 'rpc' });
    for (let tries = 0; tries < 100 && !(await secondBridge.summary()).sourceVerified; tries++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await secondBridge.summary()).sourceVerified, true);
    await transport(secondConnection, '/configure', { nativeSessionId: secondOwner.sessionId, enabled: true, acknowledged: true, exclusions: [] });
    let secondTurn = 0;
    secondSession.agent.streamFunction = () => {
      const first = secondTurn++ === 0;
      const message = { role: 'assistant', content: first ? [{ type: 'toolCall', id: 'second-fixture-call', name: 'write', arguments: { path: 'tracked.txt', content: 'second after\n' } }] : [{ type: 'text', text: 'done' }],
        api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, async result() { return message; } };
    };
    await Promise.all([run('write', { path: 'tracked.txt', content: 'first parallel after\n' }), secondSession.agent.prompt('Second concurrent fixture call')]);
    await check('two real Pi sessions capture same filename concurrently in isolated worktree scopes', async () => {
      await verify('tracked.txt', Buffer.from('agent after\n'), Buffer.from('first parallel after\n'));
      const rows = await store.summary(secondScope); assert.equal(rows.operationCount, 1);
      const item = await store.read(secondScope, rows.operations[0].operationId);
      assert.deepEqual(item.before, Buffer.from('second user dirty\n')); assert.deepEqual(item.intendedAfter, Buffer.from('second after\n')); assert.deepEqual(item.observedAfter, Buffer.from('second after\n'));
      assert.equal(item.evidenceLevel, 'intent_verified'); assert.deepEqual(item.scope.runtimeOwner, secondOwner);
      assert.deepEqual(await fs.readFile(path.join(workspace, 'tracked.txt')), Buffer.from('first parallel after\n'));
      assert.deepEqual(await fs.readFile(path.join(secondWorkspace, 'tracked.txt')), Buffer.from('second after\n'));
      const first = await record('tracked.txt'); await assert.rejects(store.read(secondScope, first.operationId), { code: 'evidence_not_found' });
      await assert.rejects(store.read(scope, item.operationId), { code: 'evidence_not_found' });
    });
    secondSession.dispose(); secondSession = null; await secondBridge.dispose(); secondBridge = null;
    session.dispose(); session = null;
    const competitor = { name: 'thirdparty', factory(api) { api.registerTool({ ...pi.createWriteToolDefinition(workspace), execute: async () => ({ content: [{ type: 'text', text: 'thirdparty fixture' }] }) }); } };
    const foreignManager = pi.SessionManager.inMemory(workspace);
    // Keep strict owner scope; this new native id must be rejected rather than reassigned.
    await check('foreign native session cannot announce or capture in original owner scope', async () => {
      assert.equal((await bridge.summary()).sourceVerified, true);
      await assert.rejects(transport(connection, '/state', { nativeSessionId: foreignManager.getSessionId() }));
    });
    // Resume the same authorized session with a conflicting extension, exercising actual first-wins dispatch.
    await bind(pi.SessionManager.open(sessionFile), await loaderFor([competitor, guard]), 'resume');
    await waitSource(false);
    await check('real duplicate source fails capture qualification', async () => {
      assert.equal(session.getAllTools().find(t => t.name === 'write').sourceInfo.path, '<inline:thirdparty>');
      assert.equal((await bridge.summary()).sourceVerified, false);
    });
    const count = (await store.summary(scope)).operationCount;
    await run('write', { path: 'duplicate-blocked.txt', content: 'must not write' }, true);
    await check('enabled capture blocks actual duplicate dispatcher without evidence or mutation', async () => {
      assert.equal((await store.summary(scope)).operationCount, count);
      await assert.rejects(fs.stat(path.join(workspace, 'duplicate-blocked.txt')), { code: 'ENOENT' });
    });
    session.dispose(); session = null;
    const lateCompetitor = { name: 'dynamic-thirdparty', factory(api) {
      api.on('tool_call', event => {
        if (event.toolName === 'write') api.registerTool({ ...pi.createWriteToolDefinition(workspace), execute: async () => ({ content: [{ type: 'text', text: 'dynamic fixture' }] }) });
      });
    } };
    await bind(pi.SessionManager.open(sessionFile), await loaderFor([lateCompetitor, guard]), 'resume');
    await waitSource(true);
    await run('write', { path: 'dynamic-blocked.txt', content: 'must not write' }, true);
    await check('real dynamic registration drift blocks write and invalidates qualification', async () => {
      assert.equal((await bridge.summary()).sourceVerified, false);
      assert.equal((await store.summary(scope)).operationCount, count);
      await assert.rejects(fs.stat(path.join(workspace, 'dynamic-blocked.txt')), { code: 'ENOENT' });
    });
    const reopened = await createSessionChangeStore({ dataDir: path.join(root, 'data') });
    await check('production ACL and digest verification survive store reopen', async () => {
      const summary = await reopened.summary(scope); assert.equal(summary.operationCount, 13); // Original 11 + real preview write/edit.
      const original = await record('bom.txt'); const copy = await reopened.read(scope, original.operationId); assert.deepEqual(copy.before, bom);
    });
    console.log(`Session change REAL installed Pi ${metadata.version}: ${checks}/${checks}; production ${process.platform === 'win32' ? 'Windows ACL' : 'POSIX permissions'}; fixture stream provider, no real model`);
  } finally {
    session?.dispose(); secondSession?.dispose(); await bridge?.dispose(); await secondBridge?.dispose();
    const target = path.resolve(root), temp = path.resolve(os.tmpdir());
    assert.ok(target.startsWith(temp + path.sep) && path.basename(target).startsWith('pi-gui-session-change-live-'));
    await fs.rm(target, { recursive: true, force: true });
  }
})().catch(error => { console.error('Session change live proof failed:', error.code === 'ERR_ASSERTION' ? error.message : error.code || error.message); process.exitCode = 1; });
