const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const {bundle}=require('./esm-bundle.cjs');
const source=bundle(path.join(__dirname,'../public/update.js')).code;
async function fixture(t,state={phase:'idle',mode:'installed',currentVersion:'0.29.0'}){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),{url:'http://127.0.0.1:7788',runScripts:'outside-only'});
  t.after(()=>dom.window.close());const w=dom.window;let publish,downloads=0;
  w.piGuiDesktop={appUpdate:{state:async()=>state,onState:fn=>{publish=fn;},download:async()=>{downloads++;return {ok:true};},install:async()=>({ok:true}),cancel:async()=>({ok:true})}};
  w.fetch=async()=>({ok:true,json:async()=>({ok:true,currentVersion:'0.29.0',latestVersion:'0.30.0',updateAvailable:true,
    release:{tag:'v0.30.0',notes:'Release notes',url:'https://github.com/HYJ1817/pi-gui/releases/tag/v0.30.0',assets:[
      {kind:'installer',name:'Pi-GUI-Setup-0.30.0.exe',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.30.0/Pi-GUI-Setup-0.30.0.exe'},
      {kind:'portable',name:'Pi-GUI-0.30.0-portable.zip',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.30.0/Pi-GUI-0.30.0-portable.zip'},
      {kind:'checksums',name:'SHA256SUMS.txt',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.30.0/SHA256SUMS.txt'}]}})});
  w.eval(source);const container=w.document.createElement('div');w.document.body.append(container);w.renderUpdateSection(container,'0.29.0');
  await w.checkForUpdate();await new Promise(r=>setImmediate(r));
  return {w,container,buttons:()=>[...container.querySelectorAll('button')],set:value=>publish(value),downloads:()=>downloads};
}
function releaseFixture(overrides={}){
  return {tag:'v0.30.0',notes:'Release notes',url:'https://github.com/HYJ1817/pi-gui/releases/tag/v0.30.0',
    publishedAt:'2026-11-01T00:00:00.000Z',assets:[
      {kind:'installer',name:'Pi-GUI-Setup-0.30.0.exe',url:'https://github.com/HYJ1817/pi-gui/releases/download/v0.30.0/Pi-GUI-Setup-0.30.0.exe'},
    ],...overrides};
}
function desktopSnapshot(overrides={}){
  return {phase:'idle',mode:'installed',currentVersion:'0.29.0',version:null,received:0,total:0,speed:0,error:'',code:'',
    preference:'manual',requestedPreference:'manual',storedPreference:'manual',persistedPreference:'manual',
    automaticSupported:true,automaticUnsupportedReason:null,automaticTrusted:true,
    overrideActive:false,overridePersisted:false,
    discovery:{status:'available',latestVersion:'0.30.0',release:releaseFixture(),error:'',checkedAt:'2026-11-01T00:00:00.000Z'},
    ignoredVersion:null,pausedVersion:null,lastNotifiedVersion:'0.30.0',ignored:false,paused:false,
    preferenceSaveFailed:false,installOnQuit:false,installOnQuitBlockedReason:'preference',...overrides};
}
async function desktopFixture(t,{snapshot=desktopSnapshot(),checkResult=null,preferenceResult=null,ignoreResult=null,unignoreResult=null}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),{url:'http://127.0.0.1:7788',runScripts:'outside-only'});
  t.after(()=>dom.window.close());const w=dom.window;let publish;
  const calls={check:0,preference:[],ignore:0,unignore:0,download:0,cancel:0};
  let current=snapshot;
  w.piGuiDesktop={appUpdate:{
    state:async()=>current,
    check:async()=>{calls.check++;const r=checkResult||{ok:true,snapshot:current};if(r?.snapshot)current=r.snapshot;return r;},
    setPreference:async preference=>{calls.preference.push(preference);const r=preferenceResult||{ok:true,persisted:true,snapshot:current};if(r?.snapshot)current=r.snapshot;return r;},
    ignore:async()=>{calls.ignore++;const r=ignoreResult||{ok:true,persisted:true,snapshot:{...current,ignored:true,ignoredVersion:'0.30.0'}};if(r?.snapshot)current=r.snapshot;return r;},
    unignore:async()=>{calls.unignore++;const r=unignoreResult||{ok:true,persisted:true,snapshot:current};if(r?.snapshot)current=r.snapshot;return r;},
    download:async()=>{calls.download++;return {ok:true};},
    cancel:async()=>{calls.cancel++;return {ok:true};},
    install:async()=>({ok:true}),openFolder:async()=>({ok:true}),
    onState:fn=>{publish=fn;},
  }};
  w.fetch=async()=>{throw Error('desktop manager must own discovery');};
  w.eval(source);const container=w.document.createElement('div');w.document.body.append(container);w.renderUpdateSection(container,'0.29.0');
  await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  return {w,container,calls,buttons:()=>[...container.querySelectorAll('button')],set:value=>publish(value)};
}
const byText=(buttons,text)=>buttons.find(b=>b.textContent===text);
test('desktop has one primary download with manual assets under an explicit disclosure',async t=>{
  const f=await fixture(t);
  assert.equal(f.buttons().filter(b=>b.classList.contains('primary')).length,1);
  const download=f.buttons().find(b=>b.textContent==='下载更新');assert.ok(download);await download.click();assert.equal(f.downloads(),1);
  const manual=f.container.querySelector('details.update-manual-downloads');assert.ok(manual);assert.equal(manual.open,false);
  assert.equal(manual.querySelectorAll('button').length,3);
  assert.equal(f.w.document.getElementById('updateDot').hidden,false);
  assert.equal(f.w.document.getElementById('menuUpdateDot').hidden,false);
});
test('ready package exposes restart as the sole primary action and displays the running Electron version',async t=>{
  const f=await fixture(t,{phase:'ready',mode:'installed',currentVersion:'0.29.1',version:'0.30.0'});
  assert.equal(f.container.querySelector('.update-title').textContent,'Pi GUI v0.29.1');
  assert.deepEqual(f.buttons().filter(b=>b.classList.contains('primary')).map(b=>b.textContent),['重启以更新']);
  assert.ok(!f.buttons().some(b=>b.textContent==='下载更新'));
});
test('unavailable desktop IPC is visible with a retry instead of silent manual-only downgrade',async t=>{
  const f=await fixture(t,null);
  assert.match(f.container.textContent,/更新服务.*不可用/);
  assert.ok(f.buttons().some(b=>/重试/.test(b.textContent)));
});
test('download, verify and prepare hide download operations and indicate one active phase',async t=>{
  const f=await fixture(t);
  for(const phase of ['downloading','verifying','preparing','installing']){
    f.set({phase,mode:'installed',currentVersion:'0.29.0',version:'0.30.0',received:50,total:100,speed:10});
    assert.equal(f.buttons().filter(b=>b.classList.contains('primary')).length,0,phase);
    assert.ok(!f.buttons().some(b=>b.textContent==='下载更新'),phase);
    assert.match(f.container.textContent,phase==='preparing'?/安全退出检查/:phase==='verifying'?/校验/:phase==='installing'?/退出|安装/:/50%/);
  }
});
test('a ready older package offers the newer download without ignoring it',async t=>{
  const f=await desktopFixture(t,{snapshot:desktopSnapshot({phase:'ready',version:'0.29.5',preference:'manual',installOnQuit:false})});
  assert.match(f.container.textContent,/发现更高版本 v0\.30\.0/);
  assert.deepEqual(f.buttons().filter(b=>b.classList.contains('primary')).map(b=>b.textContent),['下载 v0.30.0']);
  assert.ok(byText(f.buttons(),'重启以更新'));
  assert.equal(byText(f.buttons(),'忽略此版本'),undefined,'ignore must not silently target the older ready package');
  await byText(f.buttons(),'下载 v0.30.0').click();await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.download,1);
});
test('an ignored newer release offers unignore instead of a download that must fail',async t=>{
  const f=await desktopFixture(t,{snapshot:desktopSnapshot({phase:'ready',version:'0.29.5',preference:'manual',ignoredVersion:'0.30.0'})});
  assert.match(f.container.textContent,/发现更高版本 v0\.30\.0，但它已被忽略/);
  assert.equal(byText(f.buttons(),'下载 v0.30.0'),undefined);
  assert.deepEqual(f.buttons().filter(b=>b.classList.contains('primary')).map(b=>b.textContent),['取消忽略']);
  await byText(f.buttons(),'取消忽略').click();await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.unignore,1);
});
test('a pushed desktop discovery updates the already mounted info page',async t=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),{url:'http://127.0.0.1:7788',runScripts:'outside-only'});
  t.after(()=>dom.window.close());const w=dom.window;let publish;
  const idle=desktopSnapshot({discovery:{status:'idle',latestVersion:'',release:null,error:'',checkedAt:''}});
  w.piGuiDesktop={appUpdate:{state:async()=>idle,check:async()=>({ok:true,snapshot:idle}),
    setPreference:async()=>({ok:true,persisted:true}),ignore:async()=>({ok:true}),unignore:async()=>({ok:true}),
    download:async()=>({ok:true}),cancel:async()=>({ok:true}),install:async()=>({ok:true}),openFolder:async()=>({ok:true}),
    onState:fn=>{publish=fn;}}};
  w.fetch=async()=>{throw Error('desktop manager owns discovery');};
  w.eval(source);
  w.initUpdateAuto({delayMs:0});
  const container=w.document.createElement('div');w.document.body.append(container);
  w.renderUpdateSection(container,'0.29.0');
  await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  publish(desktopSnapshot());
  await new Promise(r=>setImmediate(r));
  assert.equal(w.getUpdateState().status,'available','the mounted page must apply the pushed main-process discovery');
  assert.match(container.querySelector('.update-state').textContent,/发现新版本 v0\.30\.0/);
  assert.ok(byText([...container.querySelectorAll('button')],'下载更新'),'the discovery push must expose the real action');
  assert.equal(w.document.getElementById('updateDot').hidden,false);
});
test('portable explains manual replacement and never offers restart installation',async t=>{
  const f=await fixture(t,{phase:'ready',mode:'portable',currentVersion:'0.29.0',version:'0.30.0'});
  assert.match(f.container.textContent,/便携版.*手动替换/);
  assert.ok(!f.buttons().some(b=>b.textContent==='重启以更新'));
});
test('failed installation retains explicit retry and manual recovery; actual version mismatch never says completed',async t=>{
  const f=await fixture(t,{phase:'ready',mode:'installed',currentVersion:'0.29.0',version:'0.30.0',completion:{phase:'failed',error:'安装未完成，请重试。'}});
  assert.match(f.container.textContent,/安装未完成/);
  assert.ok(f.buttons().some(b=>b.textContent==='重启以更新'));
  assert.ok(!f.container.textContent.includes('已更新至'));
  assert.ok(f.container.querySelector('details.update-manual-downloads'));
});
test('preference row renders automatic/manual and saves only explicit choices',async t=>{
  const f=await desktopFixture(t);
  const row=f.container.querySelector('.update-pref-row');assert.ok(row);
  const items=[...row.querySelectorAll('.ds-segment-item')];
  assert.deepEqual(items.map(i=>i.textContent),['自动','手动']);
  assert.equal(items[0].disabled,false);
  assert.equal(items[1].getAttribute('aria-checked'),'true');
  assert.match(row.textContent,/自动检查新版本并提醒/);
  await items[0].click();await new Promise(r=>setImmediate(r));
  assert.deepEqual(f.calls.preference,['automatic']);
  assert.equal(f.container.querySelector('.update-pref-error').hidden,true);
  assert.match(f.container.querySelector('.update-state').textContent,/发现新版本 v0\.30\.0/);
});
test('unsupported install shapes disable automatic with a concrete reason',async t=>{
  const f=await desktopFixture(t,{snapshot:desktopSnapshot({automaticSupported:false,automaticUnsupportedReason:'portable',mode:'portable',preference:'manual'})});
  const items=[...f.container.querySelectorAll('.update-pref-row .ds-segment-item')];
  assert.equal(items[0].disabled,true);
  assert.equal(items[0].getAttribute('aria-disabled'),'true');
  assert.equal(items[1].getAttribute('aria-checked'),'true');
  assert.match(f.container.querySelector('.update-pref-note').textContent,/便携版/);
  await items[0].click();await new Promise(r=>setImmediate(r));
  assert.deepEqual(f.calls.preference,[]);
});
test('preference save failure is visible and never claims success',async t=>{
  const f=await desktopFixture(t,{preferenceResult:{ok:false,code:'unavailable',error:'写入本地配置失败。'}});
  const automatic=f.container.querySelectorAll('.update-pref-row .ds-segment-item')[0];
  await automatic.click();await new Promise(r=>setImmediate(r));
  const error=f.container.querySelector('.update-pref-error');
  assert.equal(error.hidden,false);
  assert.equal(error.getAttribute('role'),'alert');
  assert.match(error.textContent,/写入本地配置失败/);
  assert.equal(f.container.querySelectorAll('.update-pref-row .ds-segment-item')[1].getAttribute('aria-checked'),'true','failed save reverts the visual selection');
});
test('a non-persisted automatic choice is shown as degraded manual, never as active',async t=>{
  const effective=desktopSnapshot({preference:'manual',requestedPreference:'automatic',persistedPreference:'manual',
    automaticTrusted:false,preferenceSaveFailed:true,installOnQuit:false});
  const f=await desktopFixture(t,{snapshot:effective,preferenceResult:{ok:true,persisted:false,error:'自动更新设置未能写入，本次运行仍按手动更新。请重试保存。',snapshot:effective}});
  const items=f.container.querySelectorAll('.update-pref-row .ds-segment-item');
  await items[0].click();await new Promise(r=>setTimeout(r,0));await new Promise(r=>setTimeout(r,0));
  assert.equal(f.container.querySelectorAll('.update-pref-row .ds-segment-item')[1].getAttribute('aria-checked'),'true','the effective policy remains manual');
  const error=f.container.querySelector('.update-pref-error');
  assert.equal(error.hidden,false);
  assert.match(error.textContent,/手动更新|降级|写入失败/);
  assert.ok([...error.querySelectorAll('button')].some(b=>b.textContent==='重试保存'),'a retry entry is offered');
});
test('persisted write failure is surfaced on reopen',async t=>{
  const f=await desktopFixture(t,{snapshot:desktopSnapshot({preferenceSaveFailed:true})});
  const error=f.container.querySelector('.update-pref-error');
  assert.equal(error.hidden,false);
  assert.match(error.textContent,/重启后可能恢复/);
});

test('a cross-process manual override is rendered as manual with an honest retry',async t=>{
  const f=await desktopFixture(t,{snapshot:desktopSnapshot({preference:'manual',requestedPreference:'manual',
    persistedPreference:'automatic',automaticTrusted:false,overrideActive:true,overridePersisted:true,
    preferenceSaveFailed:true,installOnQuit:false})});
  const items=[...f.container.querySelectorAll('.update-pref-row .ds-segment-item')];
  assert.equal(items[0].getAttribute('aria-checked'),'false');
  assert.equal(items[1].getAttribute('aria-checked'),'true');
  assert.match(f.container.querySelector('.update-pref-error').textContent,/手动|未能可靠保存/);
  assert.ok([...f.container.querySelectorAll('.update-pref-error button')].some(b=>b.textContent==='重试保存'));
});

test('a successful save paints the persisted automatic policy instead of a stale manual view',async t=>{
  const saved=desktopSnapshot({preference:'automatic',requestedPreference:'automatic',
    persistedPreference:'automatic',automaticTrusted:true,installOnQuit:true});
  const f=await desktopFixture(t,{snapshot:desktopSnapshot(),preferenceResult:{ok:true,persisted:true,snapshot:saved}});
  const automatic=f.container.querySelectorAll('.update-pref-row .ds-segment-item')[0];
  await automatic.click();await new Promise(r=>setTimeout(r,0));await new Promise(r=>setTimeout(r,0));
  assert.equal(f.container.querySelectorAll('.update-pref-row .ds-segment-item')[0].getAttribute('aria-checked'),'true');
  assert.equal(f.container.querySelector('.update-pref-error').hidden,true);
});
test('ignored available version hides download, suppresses the dot and offers unignore',async t=>{
  const f=await desktopFixture(t,{snapshot:desktopSnapshot({ignored:true,ignoredVersion:'0.30.0'})});
  assert.match(f.container.textContent,/已忽略/);
  assert.ok(!f.buttons().some(b=>b.textContent==='下载更新'));
  assert.equal(byText(f.buttons(),'取消忽略')!==undefined,true);
  assert.equal(f.w.document.getElementById('updateDot').hidden,true);
  assert.equal(f.w.document.getElementById('menuUpdateDot').hidden,true);
  await byText(f.buttons(),'取消忽略').click();await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.unignore,1);
});
test('cancelled download explains the pause and keeps retry plus ignore',async t=>{
  const f=await desktopFixture(t,{snapshot:desktopSnapshot({phase:'cancelled',version:'0.30.0',paused:true,pausedVersion:'0.30.0'})});
  assert.match(f.container.textContent,/不会自动重试此版本/);
  assert.ok(byText(f.buttons(),'重新下载'));
  assert.ok(byText(f.buttons(),'忽略此版本'));
  assert.equal(f.buttons().filter(b=>b.classList.contains('primary')).length,1);
});
test('download progress carries percent, received, total and speed with cancel and ignore',async t=>{
  const f=await desktopFixture(t,{snapshot:desktopSnapshot({phase:'downloading',version:'0.30.0',received:5242880,total:10485760,speed:2097152})});
  assert.match(f.container.textContent,/50% · 5\.0 MB \/ 10\.0 MB · 2\.0 MB\/s/);
  const download=f.w.document.querySelector('.update-sec progress');assert.ok(download);assert.equal(download.value,5242880);
  assert.ok(byText(f.buttons(),'取消下载'));assert.ok(byText(f.buttons(),'忽略此版本'));
  await byText(f.buttons(),'忽略此版本').click();await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.ignore,1);
});
test('automatic ready explains safe-quit installation while keeping immediate restart',async t=>{
  const f=await desktopFixture(t,{snapshot:desktopSnapshot({phase:'ready',version:'0.30.0',preference:'automatic',automaticSupported:true,installOnQuit:true})});
  assert.match(f.container.textContent,/正常安全退出应用时自动安装/);
  assert.deepEqual(f.buttons().filter(b=>b.classList.contains('primary')).map(b=>b.textContent),['重启以更新']);
  assert.ok(byText(f.buttons(),'稍后'));
});
test('manual ready never claims quit installation',async t=>{
  const f=await desktopFixture(t,{snapshot:desktopSnapshot({phase:'ready',version:'0.30.0',preference:'manual'})});
  assert.ok(!/正常安全退出应用时自动安装/.test(f.container.textContent));
  assert.deepEqual(f.buttons().filter(b=>b.classList.contains('primary')).map(b=>b.textContent),['重启以更新']);
});
test('check button asks the trusted main process exactly once',async t=>{
  const f=await desktopFixture(t);
  const check=byText(f.buttons(),'检查更新');assert.ok(check);
  await check.click();await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.check,1);
});
