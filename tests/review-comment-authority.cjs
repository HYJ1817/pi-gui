const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('  ok ' + name); };

(async () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../server/review-comment-authority.js')),
    'T3-B must resolve persistent identity through backend authority');
  const { createReviewCommentAuthority } = await import('../server/review-comment-authority.js');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-comment-authority-'));
  const project = path.join(world, 'project'), sessionFile = path.join(world, 'session.jsonl');
  const init = p => { fs.mkdirSync(p); execFileSync('git', ['init', '-q'], { cwd: p, windowsHide: true, stdio: 'ignore' }); };
  init(project); fs.writeFileSync(sessionFile, '{"type":"session","id":"native-a"}\n');
  let cwd = project, generation = 1, focused = null, nativeId = 'native-a';
  let owner = { backendInstance: 'backend-a', projectId: 'project-a', repoId: null, workspaceId: 'w-a', workspaceEpoch: '1',
    conversationId: 'classic-chat', runtimeId: 'run-a', runtimeGeneration: '1', sessionId: nativeId };
  let workspace = { projectId: 'p', repoId: 'r', workspaceId: 'w', workspaceEpoch: 'epoch', root: project, cwd: project };
  let runtimeOwner = { ...owner, conversationId: 'conversation-a', workspaceId: 'w', workspaceEpoch: 'epoch' };
  let target = { sessionId: nativeId, sessionLocator: sessionFile,
    sessionIdentity: (() => { const s = fs.statSync(sessionFile); return { dev:s.dev, ino:s.ino, birthtimeMs:s.birthtimeMs }; })() };
  const registry = {
    snapshot: () => ({ focusedConversationId: focused }),
    getOwner: id => id === 'conversation-a' ? runtimeOwner : null,
    workspaceIdentityOf: id => id === 'conversation-a' ? { id: workspace.workspaceId, epoch: workspace.workspaceEpoch } : null,
    historyTarget: id => id === 'conversation-a' ? target : null,
    read: async (expected, command) => {
      assert.deepEqual(expected, runtimeOwner); assert.equal(command.type, 'get_state');
      return { sessionId: nativeId, sessionFile };
    },
  };
  const options = {
    classic: { cwd: () => cwd, generation: () => generation, owner: () => owner,
      state: async () => ({ sessionId: nativeId, sessionFile }),
      resolveSession: id => id === nativeId ? { file:sessionFile,cwd,sessionId:id } : null,
      withWorkspace: (root, action) => action({ root, cwd: root }) }, registry,
    withWorkspace: (identity, action) => {
      assert.deepEqual(identity, { id:workspace.workspaceId,epoch:workspace.workspaceEpoch }); return action(workspace);
    },
  };
  const req = (expected = owner, id) => ({ headers: { 'x-pi-gui-owner': JSON.stringify(expected), ...(id ? { 'x-pi-gui-conversation':id } : {}) } });
  const denied = async fn => assert.rejects(fn, error => error.code === 'comment_scope_unavailable');
  try {
    const authority = createReviewCommentAuthority(options);
    let classicScope;
    await check('classic scope comes from private state and a verified native session', async () => {
      classicScope = await authority(req(), s => s); assert.match(classicScope.key, /^[a-f0-9]{64}$/);
      assert.equal(classicScope.projectRoot, project); assert.equal(typeof classicScope.token, 'string'); classicScope.assertCurrent();
    });
    await check('backend restart changes request token but preserves permanent scope', async () => {
      owner = { ...owner, backendInstance:'backend-b',runtimeId:'run-b',runtimeGeneration:'2',workspaceEpoch:'2' }; generation++;
      const restored = await createReviewCommentAuthority(options)(req(), s => s);
      assert.equal(restored.key, classicScope.key); assert.notEqual(restored.token, classicScope.token);
    });
    await check('client cannot choose another native session or owner', () => denied(() => authority(req({ ...owner, sessionId:'other' }), s => s)));
    await check('missing owner is refused even without a parallel runtime', () => denied(() => authority({headers:{}}, s => s)));
    await check('additional owner fields do not become authority', () => denied(() => authority(req({ ...owner,cwd:project }), s => s)));
    await check('classic requests are refused while a parallel conversation is focused', async () => {
      focused = 'conversation-a'; await denied(() => authority(req(), s => s)); focused = null;
    });
    await check('a native session without recoverable disk identity is refused', async () => {
      fs.renameSync(sessionFile, sessionFile + '.away'); await denied(() => authority(req(), s => s)); fs.renameSync(sessionFile + '.away', sessionFile);
    });
    await check('a late operation is invalidated by workspace generation change', async () => {
      const scope = await authority(req(), s => s); generation++;
      assert.throws(() => scope.assertCurrent(), error => error.code === 'comment_scope_unavailable');
    });
    await check('conversation scope uses durable registry identity', async () => {
      focused = 'conversation-a';
      const first = await authority(req(runtimeOwner,'conversation-a'), s => s);
      runtimeOwner = { ...runtimeOwner,backendInstance:'backend-c',runtimeId:'run-c',runtimeGeneration:'3' };
      const second = await createReviewCommentAuthority(options)(req(runtimeOwner,'conversation-a'), s => s);
      assert.equal(first.key, second.key); assert.notEqual(first.key, classicScope.key);
    });
    await check('forged conversation ids cannot fall back to classic data', () => denied(() => authority(req(runtimeOwner,'forged'), s => s)));
    await check('another focused conversation invalidates the requested scope', async () => {
      focused = 'conversation-b'; await denied(() => authority(req(runtimeOwner,'conversation-a'), s => s)); focused = 'conversation-a';
    });
    await check('a stale runtime owner is refused', () => denied(() => authority(req({...runtimeOwner,runtimeId:'old'},'conversation-a'),s=>s)));
    await check('session readback must match the registered session', async () => {
      target = { ...target,sessionId:'different' }; await denied(() => authority(req(runtimeOwner,'conversation-a'),s=>s)); target = { ...target,sessionId:nativeId };
    });
    await check('a new workspace epoch cannot recover the old comment scope', async () => {
      const first = await authority(req(runtimeOwner,'conversation-a'),s=>s);
      workspace = {...workspace,workspaceEpoch:'new-epoch'};runtimeOwner={...runtimeOwner,workspaceEpoch:'new-epoch'};
      const next = await authority(req(runtimeOwner,'conversation-a'),s=>s);assert.notEqual(first.key,next.key);
    });
    await check('workspace replacement at the same path changes the permanent scope', async () => {
      focused=null;const first=await authority(req(),s=>s);
      fs.renameSync(project,project+'-old');init(project);
      const second=await authority(req(),s=>s);assert.notEqual(first.key,second.key);
      assert.throws(()=>first.assertCurrent());
    });
    console.log(`Review comment authority: ${checks}/${checks}; skipped=0`);
  } finally { fs.rmSync(world,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
