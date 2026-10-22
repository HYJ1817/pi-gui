/* Real Git worktrees + real lifecycle manager/registry + disk store. Only the
 * external Pi adapter is a fixture; native headers keep the upstream shape. */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
let checks = 0;
const check = async (name, action) => { await action(); checks++; console.log('  ok ' + name); };
(async () => {
  const { createWorktrees } = await import('../server/worktrees.js');
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const { createReviewCommentAuthority } = await import('../server/review-comment-authority.js');
  const { createReviewCommentStore } = await import('../server/review-comment-store.js');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-comment-runtime-'));
  const repo = path.join(world, 'repo'), data = path.join(world, 'data'); fs.mkdirSync(repo); fs.mkdirSync(data);
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig') } });
  git('init', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.js'), 'source\n'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const managerOptions = { dataDir: data, getProjects: () => [{ path: repo, name: 'Fixture' }],
    getContext: () => ({ cwd: repo, generation: 1 }), activate: async () => ({ ok: true }) };
  let manager = createWorktrees(managerOptions), registry, commands = [];
  const withWorkspace = (identity, action) => manager.withWorkspace(identity, action);
  const options = { dataDir: data, admission: withWorkspace, resolveWorkspace: identity => withWorkspace(identity, w => w),
    validateWorkspace: w => withWorkspace({ id: w.workspaceId, epoch: w.workspaceEpoch }, () => {}),
    factory: async (context, emit) => {
      const sessionId = context.sessionId || 'native-' + context.workspace.workspaceId;
      const sessionFile = context.sessionLocator || path.join(world, sessionId + '.jsonl');
      if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: context.cwd, timestamp: '2026-01-01T00:00:00Z' }) + '\n');
      let disposed = false;
      return { start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }),
        request: async cmd => { commands.push(cmd.type); return { sessionId, sessionFile, sessionName: 'Fixture' }; },
        sessionLocator: async () => sessionFile, getState: () => ({ state: 'ready', stop: null }),
        dispose: async () => { disposed = true; }, cleanupConfirmed: () => disposed };
    } };
  const authority = () => createReviewCommentAuthority({ registry, withWorkspace });
  const req = id => ({ headers: { 'x-pi-gui-conversation': id, 'x-pi-gui-owner': JSON.stringify(registry.getOwner(id)) } });
  const focus = async id => { for (let i=0;i<100&&!registry.getOwner(id)?.sessionId;i++) await new Promise(resolve=>setImmediate(resolve)); await registry.focus(registry.getOwner(id)); };
  const store = () => createReviewCommentStore({ dataDir: data });
  const comment = { id: 'comment-a', path: 'a.js', text: 'A only', createdAt: 1, updatedAt: 1,
    anchor: { path: 'a.js', section: 'working', type: 'add', oldLine: null, newLine: 1, hunkIndex: 0,
      hunkHeader: '12345678', codeHash: 'abcdef01', diffFingerprint: '01234567' } };
  try {
    await manager.list({ project: repo });
    const create = async branch => (await manager.create({ nonce: (await manager.prepare({ project: repo, branch })).nonce })).workspace;
    const a = await create('fixture-a'), b = await create('fixture-b');
    registry = createRuntimeRegistry(options);
    const ar = await registry.start({ id: a.id, epoch: a.epoch }); await focus(ar.conversationId);
    const aOwner = registry.getOwner(ar.conversationId), aScope = await authority()(req(ar.conversationId), s => s);
    const saved = store().write(aScope, null, [comment]);
    const br = await registry.start({ id: b.id, epoch: b.epoch }); await focus(br.conversationId);
    const bScope = await authority()(req(br.conversationId), s => s);
    await check('real linked worktrees share a repository but have separate comment identities', () => {
      assert.equal(aScope.gitCommon, bScope.gitCommon); assert.notEqual(aScope.key, bScope.key); assert.deepEqual(store().read(bScope).comments, []);
    });
    await check('an unfocused real registry conversation cannot read its old comments', () => assert.rejects(() => authority()(req(ar.conversationId), s => store().read(s)), e => e.code === 'comment_scope_unavailable'));
    await registry.closeAll(); await registry.dispose();
    manager = createWorktrees(managerOptions); registry = createRuntimeRegistry(options);
    await registry.resume(ar.conversationId); await focus(ar.conversationId);
    const restored = await authority()(req(ar.conversationId), s => s);
    await check('persisted conversation restores the same scope after manager/registry recreation', () => {
      assert.equal(restored.key, aScope.key); assert.notEqual(registry.getOwner(ar.conversationId).runtimeId, aOwner.runtimeId);
      assert.deepEqual(store().read(restored), saved);
    });
    await check('the old owner guard is invalid after backend recreation', () => assert.throws(() => aScope.assertCurrent()));
    await registry.closeAll();
    const mainFile=path.join(world,'main-session.jsonl'), mainOwner={sessionId:'main-native',runtimeId:'classic'};
    fs.writeFileSync(mainFile,JSON.stringify({type:'session',version:3,id:'main-native',cwd:repo})+'\n');
    const mainAuthority=createReviewCommentAuthority({registry,withWorkspace,classic:{cwd:()=>repo,generation:()=>1,owner:()=>mainOwner,
      state:async()=>({sessionId:'main-native',sessionFile:mainFile}),resolveSession:()=>({sessionId:'main-native',file:mainFile,cwd:repo}),
      withWorkspace:(cwd,action)=>manager.withActivation(cwd,action)}});
    const mainScope=await mainAuthority({headers:{'x-pi-gui-owner':JSON.stringify(mainOwner)}},s=>s);
    await check('the main workspace cannot inherit a linked worktree comment', () => {
      assert.notEqual(mainScope.key, restored.key); assert.notEqual(mainScope.key, bScope.key); assert.equal(store().read(mainScope).comments.length, 0);
    });
    await registry.closeAll(); await manager.archive({ id: a.id, epoch: a.epoch, archived: true });
    await check('archiving a registered worktree blocks restoration rather than rebinding', () => assert.rejects(() => registry.resume(ar.conversationId)));
    await check('identity checks issue only private get_state requests', () => assert.ok(commands.length > 0 && commands.every(c => c === 'get_state')));
    console.log(`Review comment runtime: ${checks}/${checks}; skipped=0`);
  } finally { await registry?.dispose(); fs.rmSync(world, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
