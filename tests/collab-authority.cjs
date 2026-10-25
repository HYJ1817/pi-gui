const baseAssert = require('node:assert/strict');
let assertions = 0;
const assert = new Proxy(baseAssert, { get(target, key) {
  const value = target[key];
  return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value;
} });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let checks = 0;
const check = async (name, action) => { await action(); checks++; console.log('  ok ' + name); };
const denied = action => assert.rejects(action, e => e.code === 'collab_scope_unavailable' && e.message === e.code);
(async () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../server/collab-authority.js')), 'collaborative documents require server authority');
  const { createCollabAuthority } = await import('../server/collab-authority.js');
  const { createReviewCommentAuthority } = await import('../server/review-comment-authority.js');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-collab-authority-'));
  const project = path.join(world, 'project'), sessionFile = path.join(world, 'native-session.jsonl');
  const init = p => { fs.mkdirSync(p); execFileSync('git', ['init', '-q'], { cwd:p, windowsHide:true, stdio:'ignore' }); };
  init(project); fs.writeFileSync(sessionFile, '{"type":"session","id":"native-a"}\n');
  let cwd = project, generation = 1, focused = null, revision = 1, nativeId = 'native-a';
  let owner = { backendInstance:'backend-a', projectId:'p-a', repoId:null, workspaceId:'w-a', workspaceEpoch:'1', conversationId:'classic-chat', runtimeId:'run-a', runtimeGeneration:'1', sessionId:nativeId };
  let workspace = { projectId:'p', repoId:'r', workspaceId:'w', workspaceEpoch:'epoch', root:project, cwd:project };
  let runtimeOwner = { ...owner, conversationId:'conversation-a', workspaceId:'w', workspaceEpoch:'epoch' };
  const stat = fs.statSync(sessionFile);
  let target = { sessionId:nativeId, sessionLocator:sessionFile, sessionIdentity:{ dev:stat.dev, ino:stat.ino, birthtimeMs:stat.birthtimeMs } };
  const registry = { snapshot:()=>({focusedConversationId:focused}), contextRevision:()=>revision,
    getOwner:id=>id==='conversation-a'?runtimeOwner:null,
    workspaceIdentityOf:id=>id==='conversation-a'?{id:workspace.workspaceId,epoch:workspace.workspaceEpoch}:null,
    historyTarget:id=>id==='conversation-a'?target:null,
    read:async expected=>{assert.deepEqual(expected,runtimeOwner);return {sessionId:nativeId,sessionFile};} };
  const options = { registry, withWorkspace:(identity,action)=>{assert.deepEqual(identity,{id:workspace.workspaceId,epoch:workspace.workspaceEpoch});return action(workspace);},
    classic:{cwd:()=>cwd,generation:()=>generation,owner:()=>owner,state:async()=>({sessionId:nativeId,sessionFile}),
      resolveSession:id=>id===nativeId?{file:sessionFile,cwd,sessionId:id}:null,withWorkspace:(root,action)=>action({root,cwd:root})} };
  const req=(expected=owner,id)=>({headers:{'x-pi-gui-owner':JSON.stringify(expected),...(id?{'x-pi-gui-conversation':id}:{})}});
  try {
    const authority=createCollabAuthority(options); let initial;
    await check('classic scope has opaque independent namespace and verified workspace',async()=>{
      initial=await authority(req(),s=>s); const comments=await createReviewCommentAuthority(options)(req(),s=>s);
      assert.match(initial.key,/^[a-f0-9]{64}$/);assert.match(initial.token,/^[a-f0-9]{64}$/);assert.match(initial.sessionId,/^[a-f0-9]{64}$/);
      assert.notEqual(initial.key,comments.key);assert.notEqual(initial.sessionId,nativeId);assert.equal(initial.projectRoot,project);
      assert.equal(initial.workspaceCwd,project);assert.equal(initial.gitCommon,path.join(project,'.git'));initial.assertCurrent();
    });
    await check('reopening keeps key and opaque session identity but changes token on backend restart',async()=>{
      owner={...owner,backendInstance:'backend-b',runtimeId:'run-b',runtimeGeneration:'2',workspaceEpoch:'2'};generation++;
      const next=await createCollabAuthority(options)(req(),s=>s);
      assert.equal(next.key,initial.key);assert.equal(next.sessionId,initial.sessionId);assert.notEqual(next.token,initial.token);
    });
    for (const bad of [{}, {...owner,sessionId:'forged'}, {...owner,cwd:project}, {...owner,backendInstance:'old'}, {...owner,runtimeGeneration:'old'}]) {
      await check('forged incomplete or stale owner cannot choose a session',()=>denied(()=>authority(req(bad),s=>s)));
    }
    await check('missing malformed and oversized owner are safely refused',async()=>{
      for(const value of [undefined,'{','null','[]','x'.repeat(4097)]) await denied(()=>authority({headers:{'x-pi-gui-owner':value}},s=>s));
    });
    await check('renderer scopeHash and path do not select identity',async()=>{
      const request=req();request.body={scopeHash:'b'.repeat(64),root:'C:\\escape',sessionId:'forged'};
      const next=await authority(request,s=>s);assert.equal(next.key,initial.key);assert.equal(next.sessionId,initial.sessionId);
    });
    await check('focused conversation prevents classic fallback',async()=>{focused='conversation-a';await denied(()=>authority(req(),s=>s));focused=null;});
    for (const mutation of [()=>{generation++;},()=>{revision++;},()=>{owner={...owner,backendInstance:'new'};},()=>{focused='conversation-a';}]) {
      await check('captured scope rejects late context or owner mutation',async()=>{
        focused=null;const scope=await authority(req(),s=>s);mutation();assert.throws(()=>scope.assertCurrent(),e=>e.code==='collab_scope_unavailable'&&e.message===e.code);focused=null;
      });
    }
    await check('session replacement invalidates captured scope and changes durable identity',async()=>{
      const before=await authority(req(),s=>s);fs.renameSync(sessionFile,sessionFile+'.old');fs.writeFileSync(sessionFile,'new identity');
      assert.throws(()=>before.assertCurrent(),e=>e.code==='collab_scope_unavailable');
      const next=await authority(req(),s=>s);assert.notEqual(next.key,before.key);assert.notEqual(next.sessionId,before.sessionId);
      const st=fs.statSync(sessionFile);target={...target,sessionIdentity:{dev:st.dev,ino:st.ino,birthtimeMs:st.birthtimeMs}};
    });
    await check('workspace replacement invalidates captured scope and key',async()=>{
      const before=await authority(req(),s=>s);fs.renameSync(project,project+'.old');init(project);
      assert.throws(()=>before.assertCurrent(),e=>e.code==='collab_scope_unavailable');assert.notEqual((await authority(req(),s=>s)).key,before.key);
    });
    await check('conversation scope reopens across backend generations',async()=>{
      focused='conversation-a';const first=await authority(req(runtimeOwner,focused),s=>s);
      runtimeOwner={...runtimeOwner,backendInstance:'backend-c',runtimeId:'run-c',runtimeGeneration:'3'};
      const next=await createCollabAuthority(options)(req(runtimeOwner,focused),s=>s);
      assert.equal(next.key,first.key);assert.equal(next.sessionId,first.sessionId);assert.notEqual(next.token,first.token);assert.notEqual(next.key,initial.key);
      assert.throws(()=>first.assertCurrent(),e=>e.code==='collab_scope_unavailable');
    });
    await check('forged conversation and stale runtime cannot fall back',async()=>{
      await denied(()=>authority(req(runtimeOwner,'forged'),s=>s));await denied(()=>authority(req({...runtimeOwner,runtimeId:'old'},focused),s=>s));
    });
    await check('native session readback and registered identity must match',async()=>{
      const before=target;target={...target,sessionId:'other'};await denied(()=>authority(req(runtimeOwner,focused),s=>s));
      target={...before,sessionIdentity:{...before.sessionIdentity,ino:-1}};await denied(()=>authority(req(runtimeOwner,focused),s=>s));target=before;
    });
    await check('focus and workspace epoch invalidate live conversation scopes',async()=>{
      const before=await authority(req(runtimeOwner,focused),s=>s);workspace={...workspace,workspaceEpoch:'next'};runtimeOwner={...runtimeOwner,workspaceEpoch:'next'};
      assert.throws(()=>before.assertCurrent(),e=>e.code==='collab_scope_unavailable');const next=await authority(req(runtimeOwner,focused),s=>s);assert.notEqual(next.key,before.key);
      focused='conversation-b';assert.throws(()=>next.assertCurrent(),e=>e.code==='collab_scope_unavailable');focused='conversation-a';
    });
    await check('unknown backend failures expose only a fixed safe error',()=>denied(()=>authority(req(runtimeOwner,focused),()=>{throw Error('sensitive native path');})));
    await check('domain errors retain a safe fixed code through authority callback',()=>assert.rejects(()=>authority(req(runtimeOwner,focused),()=>{throw Object.assign(Error('sensitive'),{code:'collab_conflict'});}),e=>e.code==='collab_conflict'&&e.message==='collab_conflict'));
    for(const safeCode of ['collab_editor_expired','collab_proposal_unavailable'])await check('service expiration and source unavailable retain their fixed safe codes',()=>assert.rejects(()=>authority(req(runtimeOwner,focused),()=>{throw Object.assign(Error('sensitive source detail'),{code:safeCode,detail:'private'});}),e=>e.code===safeCode&&e.message===safeCode&&!Object.hasOwn(e,'detail')));
    console.log(`Collab authority: ${checks}/${checks}; assertions=${assertions}; skipped=0`);
  } finally { fs.rmSync(world,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
