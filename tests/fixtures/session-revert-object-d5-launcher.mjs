// Standalone test main process. No ordinary APP/SEA entry imports this file.
import {app,BrowserWindow,ipcMain} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createD5Fixture} from './session-revert-object-d5-issuer.mjs';
async function main(){
const config=JSON.parse(await fs.readFile(process.argv[process.defaultApp?2:1],'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
app.setPath('userData',path.join(config.launchRoot,'user-data-'+config.scale));
app.commandLine.appendSwitch('force-device-scale-factor',String(config.scale));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed',()=>{});
const nonce=randomBytes(32).toString('hex');let accepted=false;
if(typeof process.send!=='function')throw Error('private_parent_channel_required');
process.send({phase:'challenge',nonce,version:1});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('challenge_timeout')),15000);process.on('message',row=>{if(accepted)return;try{assert.deepEqual(row,{version:1,command:'run',nonce});accepted=true;clearTimeout(timer);resolve();}catch{reject(Error('challenge_refused'));}});});
let checks=0,win,server,fixture,phase='start';const evidence=[],screens=[],errors=[];
const check=(name,value)=>{assert.ok(value,name);checks++;};
const tick=()=>new Promise(r=>setTimeout(r,80));
const read=code=>win.webContents.executeJavaScript(code,true);
const progress=msg=>fs.appendFile(path.join(config.launchRoot,'progress-'+config.scale+'.log'),new Date().toISOString()+' '+phase+' '+msg+'\n');
const until=async code=>{await progress(code);const end=Date.now()+120000;while(!await read(code)){if(Date.now()>end)throw Error('gui_timeout:'+phase);await tick();}};
async function click(selector,double=false){const p=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);win.webContents.focus();for(let n=0;n<(double?2:1);n++){win.webContents.sendInputEvent({type:'mouseMove',...p});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:n+1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:n+1,...p});}await tick();}
async function key(keyCode){win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await tick();}
async function capture(name){await tick();const img=await win.webContents.capturePage(),file=path.join(config.output,config.layer+'-'+Math.round(config.scale*100)+'-'+name+'.png');await fs.writeFile(file,img.toPNG());screens.push({file,width:img.getSize().width,height:img.getSize().height,scale:config.scale,cssWidth:await read('innerWidth')});}
const permitted=new Set(['query','preview','history','qualification','prepare','apply','cancel','inspectRecovery','prepareRecovery','exportMaterial']);
let allowedContents=null,origin=null;
ipcMain.handle('p33-d5-private-object',async(event,method,body)=>{
 if(event.sender!==allowedContents||event.senderFrame!==allowedContents?.mainFrame||event.senderFrame?.url!==origin+'/d5'||!permitted.has(method)||!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>16384)return {ok:false,code:'unauthorized'};
 await progress('IPC begin '+method);const result=await fixture.invoke(method,body);await progress('IPC end '+method);await fs.appendFile(path.join(config.launchRoot,'ipc-safe-'+config.scale+'.jsonl'),JSON.stringify({method,ok:result.ok,code:result.code??null,reason:result.reason??null,keys:Object.keys(result)})+'\n');return result;
});
async function boot(fault){
 phase='real-rpc-capture';await progress('boot begin');fixture=await createD5Fixture({rpcLauncher:config.rpcLauncher,fault});await progress('fixture ready');
 if(!server){server=createServer(async(req,res)=>{
  if(req.method!=='GET'||req.url.startsWith('/api/')){res.writeHead(403).end();return;}
  const name=req.url==='/d5'?'index.html':new URL(req.url,'http://localhost').pathname.slice(1),root=path.join(config.resourceRoot,'public'),file=path.resolve(root,name);
  if(!file.startsWith(root+path.sep)){res.writeHead(404).end();return;}
  try{let bytes=await fs.readFile(file);if(name==='index.html')bytes=Buffer.from(bytes.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));res.writeHead(200,{'content-type':name.endsWith('.html')?'text/html;charset=utf-8':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/javascript;charset=utf-8'}).end(bytes);}catch{res.writeHead(404).end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;}
 const previous=win;allowedContents=null;
 win=new BrowserWindow({show:true,useContentSize:true,width:1200,height:1100,autoHideMenuBar:true,title:'D5 TEMP GUI '+config.layer,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:config.preload,backgroundThrottling:false}});allowedContents=win.webContents;
 previous?.destroy();
 win.webContents.on('console-message',details=>{if(details.level==='error'&&!details.message.includes('404'))errors.push(details.message);});
 win.webContents.on('will-navigate',(event,url)=>{if(url!==origin+'/d5')event.preventDefault();});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 await win.loadURL(origin+'/d5');
 const context={conversationId:fixture.owner.conversationId,owner:fixture.owner,workspaceFingerprint:fixture.scope.workspaceFingerprint};
 await read(`(async()=>{const {initRightPane}=await import('/right-pane.js');const {configureSecondaryPane}=await import('/ui/secondary-surface.js');const {openSessionChangesPanel}=await import('/session-changes-panel.js');const {S}=await import('/state.js');const c=${JSON.stringify(context)};S.legacyOwner=c.owner;configureSecondaryPane(initRightPane());const call=(name)=>body=>window.piGuiObjectTest.invoke(name,body);const transport={query:call('query'),preview:call('preview'),history:async()=>({ok:true,plans:[]})};const objectTransport=Object.fromEntries(['history','qualification','prepare','apply','cancel','inspectRecovery','prepareRecovery','exportMaterial'].map(k=>[k,call(k)]));document.querySelector('#btnMore').onclick=()=>openSessionChangesPanel({context:()=>c,transport,objectTransport});document.querySelector('#workspace').dataset.workspaceView='chat';document.querySelector('#projects').textContent='D5 独立 TEMP · installed Pi RPC fixture';})();`);
 check('Windows device scale '+config.scale,Math.abs(await read('devicePixelRatio')-config.scale)<0.02);
 check('real Pi stdio source handshake',fixture.measure.sourceVerified&&fixture.measure.rpcTools.length===2);
 const blocked=await fetch(origin+'/api/session-revert-object/apply',{method:'POST',body:'{}'});check('static HTTP cannot execute apply',blocked.status===403);
 const rogue=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:config.preload}});await rogue.loadURL(origin+'/d5');
 const rejected=await rogue.webContents.executeJavaScript("window.piGuiObjectTest.invoke('apply',{})",true);rogue.destroy();check('different WebContents cannot obtain writer authorization',rejected.code==='unauthorized'&&fixture.measure.commits===0);
 const malformed=await read("window.piGuiObjectTest.invoke('apply',{root:'client-selected',path:'file.txt',bytes:'client'})");check('renderer cannot select roots paths materials',malformed.code==='invalid_request'&&fixture.measure.commits===0);
}
async function open(){phase='open-panel';if(await read("!document.querySelector('#rightPane').hidden&&document.querySelector('.session-change-actions')!==null"))await click('.session-change-actions > button:last-child');else await click('#btnMore');await until("document.querySelector('.session-change-row > button')");await click('.session-change-row > button');await until("document.querySelector('[data-object-action=prepare]')&&!document.querySelector('[data-object-action=prepare]').disabled");}
async function modal(){phase='prepare';await click('[data-object-action=prepare]');await until("document.querySelector('[data-object-modal]')");check('four unchecked distinct risks',await read("document.querySelectorAll('[data-object-risk]').length===4&&[...document.querySelectorAll('[data-object-risk]')].every(e=>!e.checked)"));check('confirm starts disabled with cancel focus',await read("document.querySelector('[data-object-action=confirm]').disabled&&document.activeElement.dataset.objectAction==='cancel'"));}
async function risks(){for(const name of ['externalWritersPaused','lastCheckRaceAccepted','partialOverwriteAccepted','metadataLimitsAccepted'])await click('[data-object-risk='+name+']');check('four explicit real mouse confirmations enable submit',await read("!document.querySelector('[data-object-action=confirm]').disabled"));}
async function run(){
 await app.whenReady();await fs.mkdir(config.output,{recursive:true});await boot(false);await open();await modal();
 phase='keyboard-cancel';await key('Tab');await key('Enter');check('incomplete Enter does not commit',fixture.measure.commits===0);await key('Escape');await until("!document.querySelector('[data-object-modal]')");check('Escape does not commit',fixture.measure.commits===0);check('Escape restores entry focus',await read("document.activeElement.dataset.objectAction==='prepare'"));
 await tick();await open();await modal();await click('[data-object-action=cancel]');await until("!document.querySelector('[data-object-modal]')");check('mouse cancel does not commit',fixture.measure.commits===0);
 await tick();await open();await modal();phase='layout';
 for(const width of [720,900,1200,1280,1440,1920]){
  win.setContentSize(width,1100);await tick();await tick();
  check('modal card within viewport '+width,await read("(()=>{const r=document.querySelector('[data-object-modal] .modal-card').getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1})()"));
  check('no risk text/control overlap '+width,await read("[...document.querySelectorAll('.object-revert-risk')].every(e=>{const i=e.querySelector('input').getBoundingClientRect(),s=e.querySelector('span').getBoundingClientRect();return i.right<=s.left+1&&s.width>100})"));
  await capture('confirm-'+width);
 }
 win.setContentSize(1200,1100);await tick();
 await read("document.querySelector('#projectSidebar').hidden=true");check('sidebar collapse preserves modal',await read("document.querySelector('[data-object-modal]')!==null"));await capture('sidebar-collapsed');
 phase='native-success';await risks();await click('[data-object-action=confirm]',true);await until("document.querySelector('[data-object-status=applied_verified]')");check('double mouse confirmation commits once',fixture.measure.commits===1);check('real Native byte-exact R', (await fs.readFile(fixture.target)).equals(fixture.R));
 let report=await fixture.verify();check('persisted Native identity/metadata verified',report.saved.at(-1).state==='applied_verified'&&report.saved.at(-1).metadataEqual===true);check('Git refs/index unchanged',report.gitUnchanged);await capture('applied');
 // Reload has no action replay. Bootstrap is intentionally absent after reload.
 await win.reload();await tick();await tick();check('page reload cannot replay confirmation',fixture.measure.commits===1);evidence.push({layer:config.layer,scale:config.scale,scenario:'normal',...report});await fixture.dispose();
 await boot(2);await open();await modal();phase='native-uncertain';await risks();await click('[data-object-action=confirm]');await until("!document.querySelector('[data-object-modal]')&&document.querySelector('[data-object-status=recovery_required]')");check('real Native uncertain outcome persisted',fixture.measure.commits===1&&fixture.measure.actualNativeVerified===1);await tick();await tick();check('no automatic retry after uncertainty',fixture.measure.commits===1);await capture('recovery-required');
 phase='history-reopen';await click('.session-change-actions > button:nth-child(2)');await until("document.querySelector('.session-change-row > button')");check('history refresh never auto confirms or commits',fixture.measure.commits===1&&await read("!document.querySelector('[data-object-modal]')"));await click('.session-change-row > button');await until("document.querySelector('[data-object-action=inspect]')");await capture('history-recovery-reopened');
 phase='fresh-D-recovery';await fixture.externalD();const D=hash(await fs.readFile(fixture.target));await click('[data-object-action=inspect]');await until("document.querySelector('[data-object-action=prepare-recovery]')&&!document.querySelector('[data-object-action=prepare-recovery]').disabled");await click('[data-object-action=prepare-recovery]');await until("document.querySelector('[data-object-modal]')");check('second recovery resets every risk',await read("[...document.querySelectorAll('[data-object-risk]')].every(e=>!e.checked)"));check('second recovery starts confirm disabled',await read("document.querySelector('[data-object-action=confirm]').disabled"));await capture('D-to-C-second-confirm');await risks();await click('[data-object-action=confirm]');await until("!document.querySelector('[data-object-modal]')&&document.querySelector('[data-object-status=recovery_required]')");check('second Native failure commits only once more',fixture.measure.commits===2&&fixture.measure.actualNativeVerified===2);check('uncertain second write physically restored C',(await fs.readFile(fixture.target)).equals(fixture.C));await capture('second-recovery-required');
 phase='second-failure-materials';await click('[data-object-action=inspect]');await until("document.querySelectorAll('[data-object-action=export]').length===3");
 const exports=[];
 for(const [i,material] of ['C','R','D'].entries()){
  const file=path.join(fixture.root,'export-verified-'+material+'.bin');
  const download=new Promise((resolve,reject)=>{win.webContents.session.once('will-download',(_event,item)=>{item.setSavePath(file);item.once('done',(_e,state)=>state==='completed'?resolve():reject(Error('export_download_'+state)));});});
  await click('[data-object-action=export]:nth-of-type('+(i+1)+')');await download;
  const bytes=await fs.readFile(file),expected=material==='C'?fixture.C:material==='R'?fixture.R:Buffer.from('external-D\nanchor-one\nbody\nanchor-two\nuser later\n');check('GUI verified '+material+' export preserves original lineage',bytes.equals(expected));exports.push({material,digest:hash(bytes),file});
 }
 check('exports never retry writer',fixture.measure.commits===2);report=await fixture.verify();check('two failure generations retain verified C R D',report.saved.length===2&&report.saved.every(p=>p.state==='recovery_required')&&report.saved[1].currentDigest===D);evidence.push({layer:config.layer,scale:config.scale,scenario:'second-uncertain-recovery',D,exports,...report});await capture('verified-C-R-D-exports');
 await fixture.externalD();await click('[data-object-action=inspect]');await until("document.querySelector('[data-object-action=prepare-recovery]')&&!document.querySelector('[data-object-action=prepare-recovery]').disabled");await click('[data-object-action=prepare-recovery]');await until("document.querySelector('[data-object-modal]')");check('third recovery still requires all new risk confirmations',await read("document.querySelector('[data-object-action=confirm]').disabled&&[...document.querySelectorAll('[data-object-risk]')].every(e=>!e.checked)"));await risks();await click('[data-object-action=confirm]');await until("document.querySelector('[data-object-status=applied_verified]')");check('independent final recovery commits once',fixture.measure.commits===3);check('final recovery restores original C byte-exact',(await fs.readFile(fixture.target)).equals(fixture.C));report=await fixture.verify();check('three durable generations retained',report.saved.length===3&&report.saved[2].state==='applied_verified');evidence.push({layer:config.layer,scale:config.scale,scenario:'uncertain-recovery-final',D,...report});await capture('recovered-C');
 check('renderer errors absent',errors.length===0);
 const assets={publicPanelHash:hash(await fs.readFile(path.join(config.resourceRoot,'public/session-changes-panel.js'))),publicObjectHash:hash(await fs.readFile(path.join(config.resourceRoot,'public/session-revert-object-ui.js'))),styleHash:hash(await fs.readFile(path.join(config.resourceRoot,'public/styles.css')))};
 await fs.writeFile(path.join(config.output,config.layer+'-'+Math.round(config.scale*100)+'-evidence.json'),JSON.stringify({checks,failed:0,skipped:0,assets,screens,evidence},null,2));
 console.log(JSON.stringify({phase:'result',checks,failed:0,skipped:0,runtime:{versions:process.versions,platform:process.platform,arch:process.arch,piCompatibility:'installed Pi 1.2 private fixture experimental; production bridge unchanged'},assets,screens,evidence}));
}
try{await run();}catch(e){if(win)try{await capture('failure-'+phase+'-'+path.basename(config.launchRoot));}catch{}await fs.writeFile(path.join(config.launchRoot,'private-failure-'+config.scale+'.log'),e.stack??e.message);console.error('D5 GUI failure '+phase+': '+(e.code??e.message));console.log(JSON.stringify({phase:'failure',at:phase,checks,reason:e.code??e.message,root:fixture?.root}));process.exitCode=1;}finally{await fixture?.dispose().catch(()=>{});allowedContents=null;win?.destroy();if(server){server.closeAllConnections();server.close();}app.exit(process.exitCode??0);}
}
main().catch(e=>{process.stderr.write('D5 private launcher blocked: '+(e.code??e.message)+'\n');app.exit(2);});
