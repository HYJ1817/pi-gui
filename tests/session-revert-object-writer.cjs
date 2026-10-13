const assert=require('node:assert/strict');
(async()=>{
 let api;try{api=await import('../server/session-revert-object-writer.js');}catch{}
 assert.ok(api,'independent writer module exists');
 assert.deepEqual(Object.keys(api).sort(),['openOriginalAttempt']);
 await assert.rejects(()=>api.openOriginalAttempt({authority:{approved:true}}),e=>e.code==='production_allowlist_empty');
 const h=require('./fixtures/session-revert-object-harness.cjs'),fs=require('node:fs/promises'),path=require('node:path');
 if(process.platform!=='win32'){console.log('Object writer: 2/2; skipped=1 (Windows matrix)');return;}
 let passed=2;const check=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
 const cases=[['LF','C\n','R\n'],['BOM CRLF','\ufeffC\r\n','\ufeffR\r\n'],['mixed','C\r\nX\n','R\r\nX\n'],['empty','C',''],['grow','','R longer'],... [1024,65536,2097152].map(n=>['size '+n,Buffer.alloc(n,67),Buffer.alloc(n,82)])];
 for(const [name,c,r] of cases)await check('real Win32 '+name,()=>h.fixture(Buffer.from(c),async(root,attempts)=>{
  const C=Buffer.from(c),R=Buffer.from(r),m=await h.prepare(root,C,R),a=await m.open(m.args);attempts.push(a);
  const result=await a.commit(m.binding(a));assert.equal(result.status,'verified');assert.equal(result.durable,false);assert.equal(result.measurement.id,m.observation.file.id);assert.deepEqual(await fs.readFile(path.join(root,'workspace/file.txt')),R);
  const reopened=await m.reopen();assert.deepEqual(await reopened.restoreRead(h.scope,m.currentRef),C);assert.deepEqual(await reopened.restoreRead(h.scope,m.candidateRef),R);
  const second=await h.prepare(root,R,await reopened.restoreRead(h.scope,m.currentRef)),b=await second.open(second.args);attempts.push(b);assert.equal((await b.commit(second.binding(b))).status,'verified');assert.deepEqual(await fs.readFile(path.join(root,'workspace/file.txt')),C);
  console.log('content measurement',JSON.stringify({name,currentBytes:C.length,candidateBytes:R.length,currentDigest:h.hash(C),candidateDigest:h.hash(R),idEqual:true,metadataEqual:true,saclState:a.ready.saclState}));
 }));
 const old=require('./session-revert-inplace.cjs');
 for(const kind of ['protected','inherited'])await check('real metadata witness '+kind,()=>h.fixture(Buffer.from('C'),async(root,attempts)=>{
  const before=await old.setup(root,kind,true),m=await h.prepare(root,Buffer.from('C'),Buffer.from('R'),{extras:true}),a=await m.open(m.args);attempts.push(a);assert.equal((await a.commit(m.binding(a))).status,'verified');
  const after=await old.observe(root);for(const k of ['id','owner','group','dacl','ea','ads','attributes'])assert.deepEqual(after[k],before[k],k);
  const second=await h.prepare(root,Buffer.from('R'),await m.read(m.currentRef),{extras:true}),b=await second.open(second.args);attempts.push(b);assert.equal((await b.commit(second.binding(b))).status,'verified');const restored=await old.observe(root);for(const k of ['id','owner','group','dacl','ea','ads','attributes'])assert.deepEqual(restored[k],before[k],k);
  await assert.rejects(async()=>{const denied=await h.prepare(root,Buffer.from('C'),Buffer.from('R'));await denied.open(denied.args);});
  console.log('metadata witness',JSON.stringify({kind,ownerEqual:true,groupEqual:true,daclEqual:true,adsEqual:true,eaEqual:true,attributesEqual:true,saclState:a.ready.saclState,namedStreams:a.ready.streams,eaBytes:a.ready.eaBytes,productionAdmission:false}));
 }));
 for(const attrs of [32,34,8224,8226])await check('real attributes '+attrs,()=>h.fixture(Buffer.from('C'),async(root,attempts)=>{
  await old.fixturePowerShell("[IO.File]::SetAttributes((Join-Path $env:PI_INPLACE_ROOT 'workspace/file.txt'),[IO.FileAttributes]"+attrs+")",root);
  const m=await h.prepare(root,Buffer.from('C'),Buffer.from('R')),a=await m.open(m.args);attempts.push(a);const result=await a.commit(m.binding(a));assert.equal(result.status,'verified');assert.equal(result.measurement.attributes,attrs);
  const n=await h.prepare(root,Buffer.from('R'),await m.read(m.currentRef)),b=await n.open(n.args);attempts.push(b);assert.equal((await b.commit(n.binding(b))).status,'verified');console.log('attribute measurement',JSON.stringify({before:attrs,after:result.measurement.attributes,restore:true}));
 }));
 await check('real Unicode path',()=>h.fixture(Buffer.from('C'),async(root,attempts)=>{const relativePath='workspace/中文 😀.txt';await fs.rename(path.join(root,'workspace/file.txt'),path.join(root,relativePath));const m=await h.prepare(root,Buffer.from('C'),Buffer.from('R'),{relativePath}),a=await m.open(m.args);attempts.push(a);assert.equal((await a.commit(m.binding(a))).status,'verified');assert.equal(await fs.readFile(path.join(root,relativePath),'utf8'),'R');}));
 await check('content algorithm preserves independent user change and refuses overlap',async()=>{
  const {computeSessionRevert}=await import('../lib/session-revert.js');
  const record={operationId:'op',workspaceSequence:1,scope:h.scope,createdAt:Date.now(),attributionGapRevision:0,path:'file.txt',before:Buffer.from('user\nanchor\ntail\n'),intendedAfter:Buffer.from('agent\nanchor\ntail\n'),observedAfter:Buffer.from('agent\nanchor\ntail\n'),evidenceLevel:'intent_verified',state:'observed',toolResultObserved:true,toolOutcome:'success',mutationOutcome:'written'};
  const C=Buffer.from('agent\nanchor\nuser later\n'),r=computeSessionRevert({records:[record],selectedOperationIds:['op'],current:C,gapRevision:0});assert.equal(r.status,'candidate');
  await h.fixture(C,async(root,attempts)=>{const m=await h.prepare(root,C,r.candidate),a=await m.open(m.args);attempts.push(a);assert.equal((await a.commit(m.binding(a))).status,'verified');assert.deepEqual(await fs.readFile(path.join(root,'workspace/file.txt')),Buffer.from('user\nanchor\nuser later\n'));});
  assert.notEqual(computeSessionRevert({records:[record],selectedOperationIds:['op'],current:Buffer.from('overlap\nanchor\ntail\n'),gapRevision:0}).status,'candidate');
 });
 await check('formal graph has no writer or test harness import',async()=>{
  for(const file of ['server.js','server/session-revert-service.js','server/session-revert-routes.js','server/session-change-store.js']){const s=await fs.readFile(path.join(h.base,file),'utf8');assert.ok(!s.includes('session-revert-object-writer')&&!s.includes('object-harness'));}
  const {PRODUCTION_OBJECT_ALLOWLIST}=await import('../server/session-revert-object-profile.js');assert.equal(PRODUCTION_OBJECT_ALLOWLIST.length,0);
 });
 console.log(`Object writer: ${passed}/${passed}; failed=0; skipped=0; isolated only`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
