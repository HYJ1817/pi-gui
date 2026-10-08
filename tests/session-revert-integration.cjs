const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  let checks = 0;
  const check = async (name, fn) => { await fn(); checks++; console.log('  ok ' + name); };
  const modulePath = path.resolve(__dirname, '../server/session-revert-compute.js');
  let api = {};
  try { api = await import(pathToFileURL(modulePath)); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  await check('bounded worker computation is available', () => assert.equal(typeof api.runSessionRevert, 'function'));
  await check('bundled executable bytes bypass stale or tampered extraction caches', async () => {
    const workerBytes=await fs.readFile(path.resolve(__dirname,'../server/session-revert-worker.mjs'));
    const algorithmBytes=await fs.readFile(path.resolve(__dirname,'../lib/session-revert.js'));
    const urls=api.bundledRevertUrls(key=>key.endsWith('worker.mjs')?workerBytes:algorithmBytes);
    const changed=api.bundledRevertUrls(key=>key.endsWith('worker.mjs')?workerBytes:Buffer.concat([algorithmBytes,Buffer.from('\n// new build')]));
    assert.notEqual(urls.module,changed.module);assert.equal(urls.entry.protocol,'data:');
    const {Worker}=require('node:worker_threads');
    const value=await new Promise((resolve,reject)=>{
      const thread=new Worker(urls.entry,{workerData:{input:{records:[],selectedOperationIds:[],current:Buffer.from('x')},module:urls.module}});
      thread.once('message',resolve);thread.once('error',reject);
    });
    assert.equal(value.status,'refused');
  });
  let authorityApi = {};
  try { authorityApi = await import('../server/session-revert-authority.js'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  await check('preview authority factory is available', () => assert.equal(typeof authorityApi.createSessionRevertAuthority, 'function'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p33-revert-worker-'));
  try {
    const worker = path.join(root, 'fixture-worker.mjs');
    await fs.writeFile(worker, "import {parentPort} from 'node:worker_threads'; parentPort.postMessage({status:'candidate',candidate:new Uint8Array([65]),contentEligible:true});");
    await check('worker result preserves raw Buffer representation', async () => {
      const result = await api.runSessionRevert({}, { workerPath: worker });
      assert.deepEqual(result.candidate, Buffer.from('A'));
    });
    await fs.writeFile(worker, "for(;;){};");
    await check('CPU bound worker is terminated within a fixed deadline', async () => {
      const start = Date.now();
      const result = await api.runSessionRevert({}, { workerPath: worker, timeoutMs: 60 });
      assert.equal(result.reason, 'diff_budget_exceeded'); assert.ok(Date.now() - start < 2500);
    });
    await fs.writeFile(worker, "throw Error('SECRET_PRIVATE_PAYLOAD');");
    await check('worker failures expose fixed reasons only', async () => {
      const result = await api.runSessionRevert({}, { workerPath: worker });
      assert.equal(result.reason, 'compute_unavailable'); assert.ok(!JSON.stringify(result).includes('SECRET'));
    });
    await fs.writeFile(worker, "setInterval(()=>{},1000);");
    await check('worker admission bounds concurrent computations without an unbounded queue', async () => {
      const first = api.runSessionRevert({}, { workerPath: worker, timeoutMs: 150 });
      const second = api.runSessionRevert({}, { workerPath: worker, timeoutMs: 150 });
      const third = await api.runSessionRevert({}, { workerPath: worker, timeoutMs: 150 });
      assert.equal(third.reason, 'preview_busy'); await Promise.all([first, second]);
    });
    await check('default worker computes actual algorithm without mutating input', async () => {
      const before=Buffer.from('original\nanchor\ntail\n'), after=Buffer.from('agent\nanchor\ntail\n');
      const record={operationId:'op',workspaceSequence:1,scope:{projectId:'p',repoId:null,workspaceId:'w',workspaceEpoch:'e',conversationId:'c',nativeSessionId:'n'},state:'observed',toolResultObserved:true,evidenceLevel:'intent_verified',attributionGapRevision:0,createdAt:Date.now(),before,intendedAfter:after,observedAfter:after};
      const input={records:[record],selectedOperationIds:['op'],current:Buffer.from('agent\nanchor\nuser\n'),gapRevision:0};
      const result=await api.runSessionRevert(input);assert.deepEqual(result.candidate,Buffer.from('original\nanchor\nuser\n'));assert.deepEqual(record.intendedAfter,after);
      if (process.argv[2]) {
        const {Worker}=require('node:worker_threads');
        const directory=path.resolve(process.argv[2],'revert-compute');
        const packaged=await new Promise((resolve,reject)=>{
          const thread=new Worker(path.join(directory,'worker.mjs'),{workerData:{input,module:pathToFileURL(path.join(directory,'algorithm.mjs')).href}});
          const timer=setTimeout(()=>{void thread.terminate();reject(Error('packaged worker deadline'));},2000);
          thread.once('message',value=>{clearTimeout(timer);resolve(value);});thread.once('error',reject);
        });
        assert.deepEqual(Buffer.from(packaged.candidate),result.candidate);
      }
    });
    await check('renderer helper only sends an explicit read-only preview request', async () => {
      const source = await fs.readFile(path.resolve(__dirname, '../public/api.js'), 'utf8');
      assert.match(source, /export (?:async function|const) previewSessionRevert/);
      assert.match(source, /\/api\/session-revert\/preview/);
    });
    const owner = { backendInstance:'backend', projectId:'project', repoId:null, workspaceId:'workspace', workspaceEpoch:'epoch', conversationId:'classic-chat', runtimeId:'runtime', runtimeGeneration:'generation', sessionId:'native' };
    const scope = { runtimeOwner:owner, projectId:owner.projectId, repoId:null, conversationId:owner.conversationId, nativeSessionId:owner.sessionId, workspaceId:owner.workspaceId, workspaceEpoch:owner.workspaceEpoch };
    let currentOwner = owner, busy = false, items = [], target = null, identity = null, native = 'native';
    const bridge = { withEvidenceAuthority: async fn => fn({ ...scope, runtimeOwner:currentOwner, conversationId:currentOwner.conversationId }, { root }) };
    const registry = { snapshot:()=>({items}), getAdapter:()=>({changes:bridge,request:async()=>({sessionId:native})}), historyTarget:()=>target, workspaceIdentityOf:()=>identity };
    const withAuthority = authorityApi.createSessionRevertAuthority({ classicBridge:bridge, classicOwner:()=>currentOwner,
      classicNativeState:async()=>({sessionId:native}), classicBusy:()=>busy, registry, worktrees:{withWorkspace:async(_id,fn)=>fn({root,projectId:'project',repoId:null,workspaceId:'workspace',workspaceEpoch:'epoch'})} });
    const req = { headers:{'x-pi-gui-owner':JSON.stringify(owner)} };
    await check('classic preview binds full owner and revalidates native session', async()=>{
      await withAuthority(req,{},async value=>{assert.equal(value.scope.nativeSessionId,'native');assert.equal(value.activeWriter,false);await value.revalidate();});
    });
    await check('classic missing identity refuses even when no runtime is active', async()=>{
      await assert.rejects(withAuthority({headers:{}},{},()=>{}),{code:'stale_runtime'});
    });
    await check('classic native session change invalidates the preview', async()=>{
      await assert.rejects(withAuthority(req,{},async value=>{native='different';await value.revalidate();}),{code:'stale_runtime'});native='native';
    });
    await check('classic activity becoming busy invalidates the preview', async()=>{
      await assert.rejects(withAuthority(req,{},async value=>{busy=true;await value.revalidate();}),{code:'active_writer'});busy=false;
    });
    const runtimeOwner = {...owner,conversationId:'managed'};
    items=[{conversationId:'managed',owner:runtimeOwner,activity:'idle',lifecycle:'ready',workspace:{workspaceId:'workspace'}}];
    currentOwner=runtimeOwner;
    await check('managed preview accepts actual owner independently of legacy header', async()=>{
      await withAuthority(req,{conversationId:'managed',owner:runtimeOwner},async value=>{assert.equal(value.scope.conversationId,'managed');await value.revalidate();});
    });
    await check('managed owner from another generation is refused', async()=>{
      await assert.rejects(withAuthority(req,{conversationId:'managed',owner:{...runtimeOwner,runtimeGeneration:'old'}},()=>{}),{code:'stale_runtime'});
    });
    await check('managed closing during preview invalidates authority', async()=>{
      await assert.rejects(withAuthority(req,{conversationId:'managed',owner:runtimeOwner},async value=>{items=[];await value.revalidate();}),{code:'stale_runtime'});
    });
    target={sessionId:'native'}; identity={id:'workspace',epoch:'epoch'};
    await check('dormant preview uses persistent authority without invented runtime owner', async()=>{
      await withAuthority(req,{conversationId:'managed'},async value=>{assert.equal(value.scope.runtimeOwner,undefined);assert.equal(value.scope.nativeSessionId,'native');await value.revalidate();});
    });
    await check('dormant epoch change invalidates the preview', async()=>{
      await assert.rejects(withAuthority(req,{conversationId:'managed'},async value=>{identity={id:'workspace',epoch:'new'};await value.revalidate();}),{code:'stale_workspace'});identity={id:'workspace',epoch:'epoch'};
    });
    await check('dormant stale live owner cannot grant authority', async()=>{
      await assert.rejects(withAuthority(req,{conversationId:'managed',owner:runtimeOwner},()=>{}),{code:'stale_runtime'});
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  console.log(`Session revert worker/integration: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
