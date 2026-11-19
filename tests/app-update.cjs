const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const modPath = '../electron/app-update.cjs';
test('Windows updater module is implemented', () => assert.ok(fs.existsSync(path.join(__dirname, modPath))));
if (!fs.existsSync(path.join(__dirname, modPath))) return;
const { createAppUpdate, selectAsset, detectMode, allowedDownload } = require(modPath);
const bytes = Buffer.from('MZ verified installer fixture');
const hash = createHash('sha256').update(bytes).digest('hex');
const base = 'https://github.com/HYJ1817/pi-gui/releases/download/v0.27.0/';
const release = { ok:true, updateAvailable:true, latestVersion:'0.27.0', release:{tag:'v0.27.0',assets:[
  {name:'Pi-GUI-Setup-0.27.0.exe',size:bytes.length,url:base+'Pi-GUI-Setup-0.27.0.exe',digest:'sha256:'+hash},
  {name:'SHA256SUMS.txt',size:110,url:base+'SHA256SUMS.txt'}]} };
function setup(t, extra={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-app-update-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[];
  const opts={directory:root,version:'0.26.2',mode:'installed',readUpdate:async()=>structuredClone(release),
    fetchImpl:async(url)=> {calls.push(url);return new Response(url.endsWith('.txt')?`${hash}  Pi-GUI-Setup-0.27.0.exe\n`:bytes);},
    prepare:async()=>({ok:true}),launch:async()=>{},quit:async()=>{},...extra};
  return {u:createAppUpdate(opts),root,calls,opts};
}
test('exact official repository, version, name and size binding',()=>{
  assert.equal(selectAsset(release).name,'Pi-GUI-Setup-0.27.0.exe');
  for(const value of ['https://evil.test/a','file:///a','https://github.com/other/repo/releases/download/v0.27.0/a','https://x@github.com/a']) assert.equal(allowedDownload(value),false);
  for(const change of [{name:'../evil.exe'},{url:base+'wrong.exe'},{size:0},{name:'Pi-GUI-Setup-0.26.0.exe'}]) {
    const r=structuredClone(release);Object.assign(r.release.assets[0],change);assert.throws(()=>selectAsset(r));
  }
});
test('download requires explicit confirmation and never trusts renderer URL/path',async t=>{
  const {u,calls}=setup(t);assert.equal((await u.download({url:'file:///evil'})).ok,false);assert.equal(calls.length,0);
  assert.equal((await u.download({confirm:true,url:'file:///evil',path:'C:\\evil.exe'})).ok,false);
  assert.equal(calls.length,0);
});
test('download progress, ready persistence and rehash on next launch',async t=>{
  const {u,opts}=setup(t);const states=[];u.onChange(s=>states.push(s));
  assert.equal((await u.download({confirm:true})).ok,true);assert.equal(u.state().phase,'ready');
  assert.ok(states.some(s=>s.received===bytes.length));assert.equal(u.state().total,bytes.length);
  const next=createAppUpdate(opts);await next.restore();assert.equal(next.state().phase,'ready');
  fs.writeFileSync(path.join(opts.directory,'Pi-GUI-Setup-0.27.0.exe'),'corrupt');
  const corrupt=createAppUpdate(opts);await corrupt.restore();assert.notEqual(corrupt.state().phase,'ready');
});
test('SHA256 mismatch, failure retry and no executable admission',async t=>{
  let bad=true,launched=0;const {u}=setup(t,{fetchImpl:async url=>new Response(url.endsWith('.txt')?`${hash}  Pi-GUI-Setup-0.27.0.exe\n`:bad?Buffer.alloc(bytes.length):bytes),launch:async()=>launched++});
  assert.equal((await u.download({confirm:true})).ok,false);assert.equal(u.state().phase,'failed');
  assert.equal((await u.install({confirm:true})).ok,false);assert.equal(launched,0);
  bad=false;assert.equal((await u.download({confirm:true})).ok,true);
});
test('busy multiple sessions refuse install without launching or quitting',async t=>{
  let launched=0,quit=0;const {u}=setup(t,{prepare:async()=>({ok:false,code:'busy-runtime'}),launch:async()=>launched++,quit:async()=>quit++});
  await u.download({confirm:true});assert.equal((await u.install({confirm:true})).code,'busy-runtime');assert.equal(launched+quit,0);assert.equal(u.state().phase,'ready');
});
test('install ordered after prepare and verified package; duplicate install denied',async t=>{
  const order=[];const {u}=setup(t,{prepare:async()=>{order.push('prepare');return {ok:true};},launch:async()=>{order.push('launch');},quit:async()=>order.push('quit')});
  await u.download({confirm:true});assert.equal((await u.install({confirm:true})).ok,true);assert.deepEqual(order,['prepare','launch','quit']);assert.equal((await u.install({confirm:true})).ok,false);
});
test('install authorization is rechecked after preparation and before launch',async t=>{
  let allowed=true,launched=0,released=0;
  const {u}=setup(t,{
    prepare:async()=>{allowed=false;return {ok:true};},
    launch:async()=>launched++,
    release:async()=>released++,
  });
  await u.download({confirm:true});
  const result=await u.install({confirm:true},{authorize:()=>allowed});
  assert.equal(result.ok,false);
  assert.equal(result.code,'revoked');
  assert.equal(launched,0,'a revoked install must never launch the helper');
  assert.equal(released,1,'prepared maintenance must be released');
  assert.equal(u.state().phase,'ready','the verified package remains retryable');
  assert.match(u.state().error,/更新资格已改变/);
});
test('portable/development never install and development never downloads',async t=>{
  for(const mode of ['portable','development']) {const {u,calls}=setup(t,{mode});assert.equal((await u.install({confirm:true})).ok,false);if(mode==='development'){assert.equal((await u.download({confirm:true})).ok,false);assert.equal(calls.length,0);}}
  assert.equal(detectMode({packaged:false}),'development');
  assert.equal(detectMode({packaged:true,exe:process.execPath,readInstall:()=>null}),'portable');
});
test('download cancellation removes partial file and supports retry',async t=>{
  let blocking=true;const {u,root}=setup(t,{fetchImpl:async(_url,{signal})=>{
    if(!blocking)return new Response(bytes);
    return new Response(new ReadableStream({start(c){signal.addEventListener('abort',()=>c.error(new Error('aborted')));c.enqueue(bytes.subarray(0,2));}}));
  }});
  const p=u.download({confirm:true});while(u.state().received!==2)await new Promise(r=>setTimeout(r,5));
  u.cancel();await p;assert.equal(u.state().phase,'cancelled');assert.ok(!fs.readdirSync(root).some(n=>n.endsWith('.part')));
  blocking=false;await u.download({confirm:true});assert.equal(u.state().phase,'ready');
});
test('missing digest falls back to exact official checksum entry',async t=>{
  const info=structuredClone(release);delete info.release.assets[0].digest;
  const {u,calls}=setup(t,{readUpdate:async()=>info});assert.equal((await u.download({confirm:true})).ok,true);
  assert.deepEqual(calls,[base+'SHA256SUMS.txt',base+'Pi-GUI-Setup-0.27.0.exe']);
});
test('foreign redirect, wrong size, duplicate checksum entries never become ready',async t=>{
  for(const response of [()=>new Response(null,{status:302,headers:{location:'https://evil.test/installer.exe'}}),()=>new Response(Buffer.alloc(bytes.length+1))]) {
    const {u}=setup(t,{fetchImpl:response});assert.equal((await u.download({confirm:true})).ok,false);assert.equal(u.state().phase,'failed');
  }
  const info=structuredClone(release);delete info.release.assets[0].digest;
  const {u}=setup(t,{readUpdate:async()=>info,fetchImpl:async()=>new Response(`${hash}  Pi-GUI-Setup-0.27.0.exe\n${hash}  Pi-GUI-Setup-0.27.0.exe\n`)});
  assert.equal((await u.download({confirm:true})).ok,false);
});
test('install failure releases maintenance and permits retry with old application intact',async t=>{
  let released=0;const {u}=setup(t,{launch:async()=>{throw Error('fixture failure');},release:async()=>released++});
  await u.download({confirm:true});assert.equal((await u.install({confirm:true})).ok,false);assert.equal(u.state().phase,'ready');assert.equal(released,1);
  assert.equal((await u.install({confirm:true})).ok,false);assert.equal(released,2);
});
test('tampered package after download cannot be launched',async t=>{
  let launched=0;const {u,root}=setup(t,{launch:async()=>launched++});await u.download({confirm:true});
  fs.writeFileSync(path.join(root,'Pi-GUI-Setup-0.27.0.exe'),Buffer.alloc(bytes.length));
  assert.equal((await u.install({confirm:true})).ok,false);assert.equal(launched,0);
  assert.equal(u.state().phase,'failed','changed cached bytes require a fresh download, not another restart');
  assert.equal((await u.download({confirm:true})).ok,true,'corrupt cache is recoverable through download');
});
test('installed detection needs registered exact executable plus uninstaller, copied portable is refused',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-mode-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const exe=path.join(root,'Pi GUI.exe');fs.writeFileSync(exe,'fixture');
  assert.equal(detectMode({packaged:true,exe,readInstall:()=>root}),'portable');
  fs.writeFileSync(path.join(root,'Uninstall Pi GUI.exe'),'fixture');assert.equal(detectMode({packaged:true,exe,readInstall:()=>root}),'installed');
  const copy=path.join(root,'copied.exe');fs.copyFileSync(exe,copy);assert.equal(detectMode({packaged:true,exe:copy,readInstall:()=>root}),'portable');
});
test('modified fallback manifest and package must still match official checksum before install',async t=>{
  const info=structuredClone(release);delete info.release.assets[0].digest;
  const {u,opts,root}=setup(t,{readUpdate:async()=>info});await u.download({confirm:true});
  const malicious=Buffer.alloc(bytes.length);fs.writeFileSync(path.join(root,'Pi-GUI-Setup-0.27.0.exe'),malicious);
  const manifest=path.join(root,'ready.json'),a=JSON.parse(fs.readFileSync(manifest,'utf8'));
  a.sha256=createHash('sha256').update(malicious).digest('hex');fs.writeFileSync(manifest,JSON.stringify(a));
  let launched=0;const restored=createAppUpdate({...opts,launch:async()=>launched++});await restored.restore();
  assert.equal((await restored.install({confirm:true})).code,'checksum');assert.equal(launched,0);
});

function releaseFor(version,payload=bytes){
  const base=`https://github.com/HYJ1817/pi-gui/releases/download/v${version}/`;
  const digest=createHash('sha256').update(payload).digest('hex');
  return {ok:true,updateAvailable:true,latestVersion:version,release:{tag:`v${version}`,assets:[
    {name:`Pi-GUI-Setup-${version}.exe`,size:payload.length,url:base+`Pi-GUI-Setup-${version}.exe`,digest:'sha256:'+digest},
  ]}};
}

test('a new download clears the old target until the official release resolves',async t=>{
  let version='0.27.0';
  const {u}=setup(t,{readUpdate:async()=>releaseFor(version)});
  assert.equal((await u.download({confirm:true})).ok,true);
  assert.equal(u.state().version,'0.27.0');
  version='0.28.0';
  const approved=[];
  const result=await u.download({confirm:true,transactionId:7,expectedVersion:'0.28.0',
    approve:info=>{approved.push(info.version);return {ok:true};}});
  assert.equal(result.ok,true);
  assert.deepEqual(approved,['0.28.0']);
  assert.equal(u.state().version,'0.28.0','only the actual release target is exposed');
  assert.equal(u.state().transactionId,null,'the transaction identity is cleared when it settles');
});

test('an official target newer than the expected version converges only with a target-bound approval',async t=>{
  const first=setup(t,{readUpdate:async()=>releaseFor('0.28.0')});
  const approved=[];
  const converged=await first.u.download({confirm:true,transactionId:5,expectedVersion:'0.27.0',
    approve:info=>{approved.push(info.version);return {ok:true,version:info.version};}});
  assert.equal(converged.ok,true);
  assert.deepEqual(approved,['0.28.0']);
  assert.equal(first.u.state().version,'0.28.0','the actual official target wins');
  assert.equal(first.calls.length,1,'only the verified package was fetched');

  const second=setup(t,{readUpdate:async()=>releaseFor('0.28.0')});
  const rejected=await second.u.download({confirm:true,expectedVersion:'0.27.0',approve:()=>({ok:true})});
  assert.equal(rejected.code,'superseded','an unbound approval cannot authorize another version');
  assert.equal(second.u.state().phase,'cancelled');
  assert.equal(second.u.state().version,'0.28.0');
});

test('cancelling before metadata resolves never starts the late download',async t=>{
  let resolveRead,approvals=0,calls=0;
  const gate=new Promise(resolve=>{resolveRead=resolve;});
  const {u,root}=setup(t,{readUpdate:async()=>{await gate;return releaseFor('0.28.0');},
    fetchImpl:async()=>{calls+=1;return new Response(bytes);}});
  const pending=u.download({confirm:true,transactionId:11,expectedVersion:'0.28.0',
    approve:()=>{approvals+=1;return {ok:true};}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(u.state().version,null,'the previous task version is not reused');
  assert.equal(u.state().phase,'downloading');
  u.cancel();
  resolveRead();
  const result=await pending;
  assert.equal(result.code,'cancelled');
  assert.equal(u.state().phase,'cancelled');
  assert.equal(u.state().version,null);
  assert.equal(approvals,0,'a late release must not receive download approval');
  assert.equal(calls,0,'no installer bytes are fetched after cancellation');
  assert.ok(!fs.readdirSync(root).some(name=>name.endsWith('.part')));
});

test('download approval rejects ignored, paused, revoked and superseded targets before bytes',async t=>{
  for(const code of ['ignored','paused','revoked','superseded']){
    let calls=0;
    const {u}=setup(t,{fetchImpl:async()=>{calls+=1;return new Response(bytes);}});
    const result=await u.download({confirm:true,transactionId:3,expectedVersion:'0.27.0',
      approve:()=>({ok:false,code})});
    assert.equal(result.ok,false,code);
    assert.equal(result.code,code,code);
    assert.equal(u.state().phase,'cancelled',code);
    assert.equal(calls,0,code);
  }
  const {u}=setup(t);
  const mismatch=await u.download({confirm:true,expectedVersion:'0.28.0',approve:()=>({ok:true})});
  assert.equal(mismatch.code,'superseded','the actual release must match the transaction target');
});

test('revocation during helper preparation releases the unarmed helper and keeps the package retryable',async t=>{
  let allowed=true,launched=0,released=0;
  const {u}=setup(t,{
    launch:async()=>{launched+=1;allowed=false;},
    release:async()=>{released+=1;},
  });
  await u.download({confirm:true});
  const result=await u.install({confirm:true},{authorize:()=>allowed});
  assert.equal(result.code,'revoked');
  assert.equal(launched,1);
  assert.equal(released,1,'an unarmed helper is cancelled through the existing release path');
  assert.equal(u.state().phase,'ready');
});

test('authorization is rechecked synchronously at the armed boundary',async t=>{
  let allowed=true,released=0,armed=false;
  const {u}=setup(t,{
    quit:async({authorize})=>{
      allowed=false;
      if(authorize()===true){armed=true;}
      throw Object.assign(Error('revoked'),{code:'revoked'});
    },
    release:async()=>{released+=1;},
  });
  await u.download({confirm:true});
  const result=await u.install({confirm:true},{authorize:()=>allowed});
  assert.equal(result.code,'revoked');
  assert.equal(armed,false,'the armed marker must never be written after the last check fails');
  assert.equal(released,1);
  assert.equal(u.state().phase,'ready');
});

test('a failure after the armed marker becomes an irreversible installing transaction',async t=>{
  let released=0;
  const {u}=setup(t,{
    quit:async()=>{
      const error=Error('shutdown_unconfirmed');
      error.committed=true;
      throw error;
    },
    release:async()=>{released+=1;},
  });
  await u.download({confirm:true});
  const result=await u.install({confirm:true});
  assert.equal(result.ok,false);
  assert.equal(result.committed,true);
  assert.equal(released,0,'an armed transaction is never cancelled or released by the parent');
  assert.equal(u.state().phase,'installing');
  assert.equal((await u.install({confirm:true})).code,'busy','no second install may start after arming');
  assert.equal((await u.download({confirm:true})).code,'busy','no new download may start after arming');
});

test('internal download transaction fields are typed while renderer extras stay rejected',async t=>{
  const {u,calls}=setup(t);
  assert.equal((await u.download({confirm:true,transactionId:'7'})).code,'untrusted');
  assert.equal((await u.download({confirm:true,expectedVersion:'0.28'})).code,'untrusted');
  assert.equal((await u.download({confirm:true,approve:'yes'})).code,'untrusted');
  assert.equal(calls.length,0);
});

test('a failed newer download never deletes the previously verified installer',async t=>{
  let version='0.27.0',offline=false;
  const {u,opts,root}=setup(t,{
    readUpdate:async()=>releaseFor(version),
    fetchImpl:async()=>{if(offline)throw Error('offline');return new Response(bytes);},
  });
  assert.equal((await u.download({confirm:true})).ok,true);
  assert.equal(u.state().version,'0.27.0');
  const oldFile=path.join(root,'Pi-GUI-Setup-0.27.0.exe'),manifest=path.join(root,'ready.json');
  assert.equal(fs.existsSync(oldFile),true);
  const oldManifest=fs.readFileSync(manifest,'utf8');
  version='0.28.0';offline=true;
  const failed=await u.download({confirm:true,transactionId:4,expectedVersion:'0.28.0',approve:()=>({ok:true})});
  assert.equal(failed.ok,false);
  assert.equal(u.state().phase,'failed');
  assert.equal(fs.existsSync(oldFile),true,'the older verified package is retained for recovery');
  assert.equal(fs.readFileSync(manifest,'utf8'),oldManifest,'a failed download must not overwrite the verified manifest');
  assert.equal(fs.readdirSync(root).some(name=>name.endsWith('.part')),false);
  const restored=createAppUpdate(opts);
  await restored.restore();
  assert.equal(restored.state().phase,'ready','the retained package is re-verified on next launch');
  assert.equal(restored.state().version,'0.27.0');
});
