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
