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
test('desktop has one primary download with manual assets under an explicit disclosure',async t=>{
  const f=await fixture(t);
  assert.equal(f.buttons().filter(b=>b.classList.contains('primary')).length,1);
  const download=f.buttons().find(b=>b.textContent==='下载更新');assert.ok(download);await download.click();assert.equal(f.downloads(),1);
  const manual=f.container.querySelector('details.update-manual-downloads');assert.ok(manual);assert.equal(manual.open,false);
  assert.equal(manual.querySelectorAll('button').length,3);
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
