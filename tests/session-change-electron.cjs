// Child of session-change-live: real captured Pi evidence -> production GUI -> HTTP preview.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',process.env.P33_GUI_USER_DATA);
let win,checks=0,phase='bootstrap';const errors=[];
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('  ok  '+name);};
const read=code=>win.webContents.executeJavaScript(code,true);
const tick=()=>new Promise(r=>setTimeout(r,70));
const until=async code=>{for(let n=0;n<300;n++){if(await read(code))return;await tick();}throw Error('GUI state timeout');};
async function click(selector){const p=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);win.webContents.sendInputEvent({type:'mouseMove',...p});for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...p});await tick();}
(async()=>{
  await app.whenReady();win=new BrowserWindow({show:true,useContentSize:true,autoHideMenuBar:true,title:'P33.5a 临时项目验证',width:1200,height:850,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
  win.webContents.session.webRequest.onBeforeSendHeaders((details,callback)=>callback({requestHeaders:{...details.requestHeaders,'x-pi-gui-token':'fixture-preview-token'}}));
  if(process.env.P33_GUI_ACTUAL_APP==='1'){
    phase='actual-app-ready';await win.loadURL(process.env.P33_GUI_URL+'/');
    await until("document.querySelector('#btnMore')&&document.querySelector('#projects').textContent.includes('Fixture')");
    await until("document.querySelector('#projects .pj-sess')!==null&&!document.querySelector('#projects .pj-sess-hint')?.textContent.includes('读取')");
    await tick();await tick();
    const rowOrder=()=>read("[...document.querySelectorAll('#projects .pj-sess')].map(e=>e.dataset.id||e.dataset.conversationId||e.dataset.sessionId||e.getAttribute('aria-label')).join('|')");
    const rows=await rowOrder();
    phase='actual-app-menu';
    check('production menu handler is installed',await read("typeof document.querySelector('#btnMore').onclick==='function'"));
    win.webContents.focus();await read("window.p33MenuClicks=0;document.querySelector('#btnMore').addEventListener('click',()=>window.p33MenuClicks++);document.querySelector('#btnMore').focus()");
    check('production menu receives keyboard focus',await read("document.activeElement.id==='btnMore'"));
    await until("document.querySelector('#confirmLayer').hidden&&document.querySelector('#modal').hidden");
    await click('#btnMore');
    await until("[...document.querySelectorAll('.modal-item')].some(b=>b.textContent==='本会话变更')");
    await read("[...document.querySelectorAll('.modal-item')].find(b=>b.textContent==='本会话变更').id='realSessionChangesMenu'");
    phase='actual-app-panel';await click('#realSessionChangesMenu');await until("document.querySelector('#rightPane').textContent.includes('不代表文件没有被修改')");
    check('production app menu opens session evidence API empty state',await read("document.querySelector('#rightPane').dataset.surface==='session-changes'"));
    check('production app opening pane preserves session list order',await rowOrder()===rows);
    const out=path.resolve(__dirname,'../.shots/p33-5a');fs.mkdirSync(out,{recursive:true});
    await tick();await tick();fs.writeFileSync(path.join(out,(process.env.P33_GUI_TAG||'actual')+'-empty-1200.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(720,850);await tick();await tick();
    check('production app pane adapts to narrow window',await read("(()=>{const r=document.querySelector('#rightPane').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})()"));
    fs.writeFileSync(path.join(out,(process.env.P33_GUI_TAG||'actual')+'-empty-720.png'),(await win.webContents.capturePage()).toPNG());
    await read("document.querySelector('#rightPaneClose').focus()");
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await tick();
    check('production app Escape closes and restores menu focus',await read("document.querySelector('#rightPane').hidden&&document.activeElement.id==='btnMore'"));
    check('production app renderer has no errors',errors.length===0);
    console.log(`Session change actual app Electron: ${checks}/${checks}; failed=0; skipped=0`);return;
  }
  await win.loadURL(process.env.P33_GUI_URL+'/p33-gui');
  await read(`(async()=>{
    const {initRightPane}=await import('/right-pane.js');const {configureSecondaryPane}=await import('/ui/secondary-surface.js');
    const {openSessionChangesPanel}=await import('/session-changes-panel.js');const {S}=await import('/state.js');
    const owner=${process.env.P33_GUI_OWNER};S.legacyOwner=owner;
    configureSecondaryPane(initRightPane());
    window.guiPanel=null;document.querySelector('#btnMore').onclick=()=>{window.guiPanel=openSessionChangesPanel({context:()=>({conversationId:owner.conversationId,owner})});};
    document.querySelector('#workspace').dataset.workspaceView='chat';
    document.querySelector('#projectSidebar').hidden=false;
    document.querySelector('#projects').textContent='独立临时项目 · 真实 Pi 1.0.4';
  })()`);
  phase='summary';
  await click('#btnMore');await until("document.querySelector('.session-change-path')!==null");
  check('real GUI shows journal file preview.txt',await read("document.querySelector('#rightPane').textContent.includes('preview.txt')"));
  check('initial summary has no content diff',await read("!document.querySelector('.diff')"));
  await read("document.querySelector('#rightPane button').focus()");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await tick();
  check('Tab keeps visible keyboard focus',await read("document.querySelector('#rightPane').contains(document.activeElement)"));
  const selector=await read("(()=>{const rows=[...document.querySelectorAll('.session-change-row')];const row=rows.find(r=>r.textContent.includes('preview.txt'));row.id='livePreviewRow';return '#livePreviewRow > button';})()");
  phase='content-preview';
  await click(selector);await until("document.querySelector('#livePreviewRow .diff')!==null");
  check('real GUI displays candidate restoring preexisting user bytes',await read("document.querySelector('#livePreviewRow .diff').textContent.includes('user preexisting')"));
  check('real GUI keeps apply unavailable',await read("document.querySelector('#rightPane').textContent.includes('实际恢复未开放')"));
  await read("document.querySelector('#livePreviewRow .diff').scrollIntoView({block:'center'})");await tick();await tick();
  const out=path.resolve(__dirname,'../.shots/p33-5a');fs.mkdirSync(out,{recursive:true});
  phase='layout-keyboard';
  fs.writeFileSync(path.join(out,'real-pi-diff-1200.png'),(await win.webContents.capturePage()).toPNG());
  for(const width of [900,720]){
    win.setSize(width,850);await tick();
    await read("document.querySelector('#livePreviewRow .diff').scrollIntoView({block:'center'})");await tick();await tick();
    check('panel stays inside viewport '+width,await read("(()=>{const r=document.querySelector('#rightPane').getBoundingClientRect();return r.width>300&&r.left>=0&&r.right<=innerWidth+1;})()"));
    fs.writeFileSync(path.join(out,'real-pi-diff-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  await read("document.querySelector('#projectSidebar').hidden=true");await tick();
  fs.writeFileSync(path.join(out,'real-pi-sidebar-collapsed.png'),(await win.webContents.capturePage()).toPNG());
  check('sidebar collapse preserves file identity',await read("document.querySelector('#livePreviewRow').textContent.includes('preview.txt')"));
  await read("document.querySelector('#rightPaneClose').focus()");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await tick();
  check('Escape closes pane and discards diff',await read("document.querySelector('#rightPane').hidden&&!document.querySelector('.diff')"));
  check('Escape restores trigger focus',await read("document.activeElement.id==='btnMore'"));
  check('no renderer errors',errors.length===0);
  console.log(`Session change Electron: ${checks}/${checks}; failed=0; skipped=0`);
})().catch(async e=>{console.error('Session change Electron failed; phase='+phase+'; code='+(e.code==='ERR_ASSERTION'?'assertion':e.message==='GUI state timeout'?'timeout':e.name||'interaction'));
  if(win){const out=path.resolve(__dirname,'../.shots/p33-5a');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'failure-'+phase+'.png'),(await win.webContents.capturePage()).toPNG());}
  process.exitCode=1;}).finally(()=>{win?.destroy();app.exit(process.exitCode||0);});
