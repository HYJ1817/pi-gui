// Real TEMP copies exercise the production loader; source helpers are never changed.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const base=path.resolve(__dirname,'..');let passed=0,failed=0,skipped=0;
const hashes={observer:'230eade3a3611f2340b8ecb3d536b61d2adb88deabc44b44d7c59ec065a2063f',writer:'7d773b63777d97a6a78d9a81c37cf946929062b22028425889258becd3aa39ef'};
const check=async(name,fn)=>{try{await fn();passed++;console.log('ok '+name);}catch(e){failed++;console.error('FAIL '+name+': '+(e.code||e.name));}};
async function fixture(fn){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-d4-assets-'));
 try{
  for(const d of ['server','lib','public','revert-object','project'])await fs.mkdir(path.join(root,d));
  await fs.writeFile(path.join(root,'package.json'),'{"type":"module"}');
  for(const f of ['lib/assets.js','server/session-revert-object-source.js','server/session-revert-object-observer.js','server/session-revert-object-profile.js','server/session-revert-object-writer.js','server/session-revert-object-native.ps1','server/session-revert-object-write-native.ps1','server/session-revert-object-resources.js']){
   try{await fs.copyFile(path.join(base,f),path.join(root,f));}catch(e){if(e.code!=='ENOENT'||!f.endsWith('resources.js'))throw e;}
  }
  for(const [kind,name] of [['observer','observe'],['writer','write']])await fs.copyFile(path.join(root,'server',kind==='observer'?'session-revert-object-native.ps1':'session-revert-object-write-native.ps1'),path.join(root,'revert-object',name+'.ps1'));
  return await fn(root);
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^p33-d4-assets-/);await fs.rm(root,{recursive:true,force:true});}
}
function load(root,kind,expected,{cwd=path.join(root,'project'),env={}}={}){
 const code=`import {loadObjectHelper} from ${JSON.stringify(require('node:url').pathToFileURL(path.join(root,'server/session-revert-object-resources.js')).href)};try{const r=loadObjectHelper(${JSON.stringify(kind)});console.log(JSON.stringify({kind:r.kind,helperHash:r.helperHash,helperVersion:r.helperVersion,source:r.source,bytes:r.bytes.length}));}catch(e){console.log(JSON.stringify({code:e.code}));}`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd,env:{...process.env,...env},encoding:'utf8',timeout:10000});assert.equal(r.status,0);const row=JSON.parse(r.stdout.trim());if(expected)assert.equal(row.code,expected);return row;
}
function observe(root,env={}){
 const scope={runtimeOwner:{backendInstance:'d4',projectId:'fixture',repoId:null,workspaceId:'w',workspaceEpoch:'e',conversationId:'c',runtimeId:'r',runtimeGeneration:'g',sessionId:'s'},workspaceId:'w',workspaceEpoch:'e',conversationId:'c',nativeSessionId:'s'};
 const code=`import {observeFileObject} from ${JSON.stringify(require('node:url').pathToFileURL(path.join(root,'server/session-revert-object-observer.js')).href)};const r=await observeFileObject({root:${JSON.stringify(path.join(root,'project'))},relativePath:'file.txt',scope:${JSON.stringify(scope)},operationId:'d4'});console.log(JSON.stringify({status:r.status,reason:r.reason,helperHash:r.source.helperHash}));`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:path.join(root,'project'),env:{...process.env,...env},encoding:'utf8',timeout:40000});assert.equal(r.status,0);return JSON.parse(r.stdout.trim());
}
(async()=>{
 let m;try{m=await import('../server/session-revert-object-resources.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 await check('build copies nested Unicode and space paths with exact bytes',()=>fixture(async root=>{
  const {copyInto}=await import('../scripts/util.mjs'),source=path.join(root,'copy source'),dest=path.join(root,'中文 space');
  await fs.mkdir(path.join(source,'中文 nested'),{recursive:true});await fs.writeFile(path.join(source,'中文 nested','file.txt'),'exact bytes');
  copyInto(dest,source,'assets');assert.equal(await fs.readFile(path.join(dest,'assets','中文 nested','file.txt'),'utf8'),'exact bytes');
 }));
 await check('fixed helper loader exists',()=>assert.equal(typeof m?.loadObjectHelper,'function'));
 if(!m){console.log(`Object assets: ${passed}/${passed+failed}; failed=${failed}; skipped=0`);process.exitCode=1;return;}
 for(const kind of ['observer','writer']){
  await check(kind+' source has approved bytes and fixed metadata',()=>fixture(async root=>{const r=load(root,kind);assert.equal(r.kind,kind);assert.equal(r.helperHash,hashes[kind]);assert.equal(r.helperVersion,1);assert.equal(r.source,'source');assert.ok(r.bytes>0);}));
  await check(kind+' Electron fixed resource has identical bytes',()=>fixture(async root=>{await fs.writeFile(path.join(root,'asset-manifest.json'),'[]');const r=load(root,kind);assert.equal(r.helperHash,hashes[kind]);assert.equal(r.source,'electron');}));
  for(const bundled of [false,true]){
   const file=bundled?path.join('revert-object',kind==='observer'?'observe.ps1':'write.ps1'):path.join('server',kind==='observer'?'session-revert-object-native.ps1':'session-revert-object-write-native.ps1');
   await check(kind+' '+(bundled?'Electron':'source')+' tamper rejected',()=>fixture(async root=>{if(bundled)await fs.writeFile(path.join(root,'asset-manifest.json'),'[]');await fs.appendFile(path.join(root,file),'\n# changed');load(root,kind,'object_helper_integrity_failed');}));
   await check(kind+' '+(bundled?'Electron':'source')+' missing resource never falls back',()=>fixture(async root=>{if(bundled)await fs.writeFile(path.join(root,'asset-manifest.json'),'[]');await fs.rm(path.join(root,file));load(root,kind,'object_helper_unavailable');}));
  }
  await check(kind+' cwd PATH env and fake cache cannot substitute helper',()=>fixture(async root=>{await fs.writeFile(path.join(root,'project','powershell.exe'),'fake');await fs.writeFile(path.join(root,'project','observe.ps1'),'fake');await fs.mkdir(path.join(root,'project','pi-gui-assets','revert-object'),{recursive:true});await fs.writeFile(path.join(root,'project','pi-gui-assets','revert-object','.ok'),'');await fs.writeFile(path.join(root,'project','pi-gui-assets','revert-object',kind==='observer'?'observe.ps1':'write.ps1'),'fake');const r=load(root,kind,null,{env:{PATH:path.join(root,'project'),OBJECT_HELPER_PATH:path.join(root,'project','observe.ps1'),TEMP:path.join(root,'project'),TMP:path.join(root,'project')}});assert.equal(r.helperHash,hashes[kind]);}));
 }
 await check('unknown kind rejected with fixed code',()=>fixture(root=>{load(root,'../project/observe.ps1','object_helper_unknown');}));
 await check('returned bytes cannot poison subsequent reads',()=>{const a=m.loadObjectHelper('observer');a.bytes.fill(0);assert.equal(require('node:crypto').createHash('sha256').update(m.loadObjectHelper('observer').bytes).digest('hex'),hashes.observer);});
 await check('production writer still rejects and exports no fixture factory',async()=>{const writer=await import('../server/session-revert-object-writer.js');assert.deepEqual(Object.keys(writer),['openOriginalAttempt']);await assert.rejects(writer.openOriginalAttempt(),e=>e.code==='production_allowlist_empty');});
 if(process.platform==='win32'){
  await check('real observer ignores fake cwd and PATH interpreter',()=>fixture(async root=>{await fs.writeFile(path.join(root,'project','file.txt'),'fixture');await fs.writeFile(path.join(root,'project','powershell.exe'),'fake interpreter');const r=observe(root,{PATH:path.join(root,'project')});assert.equal(r.status,'observed');assert.equal(r.helperHash,hashes.observer);}));
  for(const bundled of [false,true])await check('real observer refuses '+(bundled?'Electron':'source')+' tampered script before execution',()=>fixture(async root=>{await fs.writeFile(path.join(root,'project','file.txt'),'fixture');if(bundled)await fs.writeFile(path.join(root,'asset-manifest.json'),'[]');const target=path.join(root,bundled?'revert-object/observe.ps1':'server/session-revert-object-native.ps1');await fs.writeFile(target,"[IO.File]::WriteAllText('executed.txt','unsafe')");const r=observe(root);assert.equal(r.status,'unavailable');assert.equal(r.reason,'object_observation_unavailable');assert.equal(r.helperHash,hashes.observer);assert.equal(await fs.readFile(path.join(root,'project','file.txt'),'utf8'),'fixture');await assert.rejects(fs.stat(path.join(root,'project','executed.txt')),e=>e.code==='ENOENT');}));
  await check('real observer refuses relative SystemRoot without PATH fallback',()=>fixture(async root=>{await fs.writeFile(path.join(root,'project','file.txt'),'fixture');const r=observe(root,{SystemRoot:'.',PATH:path.join(root,'project')});assert.equal(r.status,'unavailable');assert.equal(r.reason,'object_observation_unavailable');}));
 }else{skipped+=4;console.log('skip Windows interpreter and observer cases: platform');}
 console.log(`Object assets: ${passed}/${passed+failed}; failed=${failed}; skipped=${skipped}`);if(failed)process.exitCode=1;
})().catch(e=>{console.error(e.code||e.name);process.exitCode=1;});
