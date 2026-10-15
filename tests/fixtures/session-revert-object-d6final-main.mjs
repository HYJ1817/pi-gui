// Standalone test main process. No ordinary APP/SEA entry imports this file.
import {app,BrowserWindow,ipcMain} from 'electron';
import {safeFailure,createCleanup} from './session-revert-object-d6final-checks.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createD6ModelFixture} from './session-revert-object-d6-issuer.mjs';
async function main(){
const config=JSON.parse(await fs.readFile(process.argv[process.defaultApp?2:1],'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
app.setPath('userData',path.join(config.launchRoot,'user-data-'+config.scale));
app.commandLine.appendSwitch('force-device-scale-factor',String(config.scale));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed',()=>{});
const nonce=randomBytes(32).toString('hex');let accepted=false,modelConfig=null;const pendingPermits=new Map();
process.on('message',row=>{if(row?.type==='d6-root-permit-result'&&pendingPermits.has(row.requestId)){const fn=pendingPermits.get(row.requestId);pendingPermits.delete(row.requestId);fn(row);}});
const permitRequest=details=>new Promise((resolve,reject)=>{const id=randomBytes(16).toString('hex');const timer=setTimeout(()=>{pendingPermits.delete(id);reject(Error('permit_timeout'));},10000);pendingPermits.set(id,row=>{clearTimeout(timer);resolve({allowed:row.allowed,totalReserved:row.totalReserved});});process.send({type:'d6-root-permit',requestId:id,projectId:details.projectId,projectRequest:details.projectRequest});});
if(typeof process.send!=='function')throw Error('private_parent_channel_required');
process.send({phase:'challenge',nonce,version:1});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('challenge_timeout')),15000);process.on('message',row=>{if(accepted)return;try{assert.equal(Object.keys(row).sort().join('|'),'command|modelConfig|nonce|version');assert.equal(row.version,1);assert.equal(row.command,'run');assert.equal(row.nonce,nonce);assert.ok(row.modelConfig?.apiKey);modelConfig=row.modelConfig;accepted=true;clearTimeout(timer);resolve();}catch{reject(Error('challenge_refused'));}});});
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
 phase='real-rpc-capture';await progress('boot begin');const ready=await createD6ModelFixture({rpcLauncher:config.rpcLauncher,mode:config.mode,modelConfig,permitRequest,fault:1});assert.equal(ready.phase,'ready');fixture=ready;fixture=await ready.capture();modelConfig=null;await progress('fixture ready');
 if(!server){server=createServer(async(req,res)=>{
  if(req.method!=='GET'||req.url.startsWith('/api/')){res.writeHead(403).end();return;}
  const name=req.url==='/d5'?'index.html':new URL(req.url,'http://localhost').pathname.slice(1),root=path.join(config.resourceRoot,'public'),file=path.resolve(root,name);
  if(!file.startsWith(root+path.sep)){res.writeHead(404).end();return;}
  try{let bytes=await fs.readFile(file);if(name==='index.html')bytes=Buffer.from(bytes.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));res.writeHead(200,{'content-type':name.endsWith('.html')?'text/html;charset=utf-8':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/javascript;charset=utf-8'}).end(bytes);}catch{res.writeHead(404).end();}
 });
 const forbidden=new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080]);
 for(let n=0;n<16;n++){await new Promise(r=>server.listen(0,'127.0.0.1',r));if(!forbidden.has(server.address().port))break;await new Promise(r=>server.close(r));if(n===15)throw Error('private_browser_port_unavailable');}
 origin='http://127.0.0.1:'+server.address().port;}
 const previous=win;allowedContents=null;
 win=new BrowserWindow({show:true,useContentSize:true,width:1200,height:1100,autoHideMenuBar:true,title:'D6 TEST ONLY TEMP '+config.mode,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:config.preload,backgroundThrottling:false}});allowedContents=win.webContents;
 previous?.destroy();
 win.webContents.on('console-message',details=>{if(details.level==='error'&&!details.message.includes('404'))errors.push('renderer_error');});
 win.webContents.on('will-navigate',(event,url)=>{if(url!==origin+'/d5')event.preventDefault();});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 await win.loadURL(origin+'/d5');
 const context={conversationId:fixture.owner.conversationId,owner:fixture.owner,workspaceFingerprint:fixture.scope.workspaceFingerprint};
 await read(`(async()=>{const {initRightPane}=await import('/right-pane.js');const {configureSecondaryPane}=await import('/ui/secondary-surface.js');const {openSessionChangesPanel}=await import('/session-changes-panel.js');const {S}=await import('/state.js');const c=${JSON.stringify(context)};S.legacyOwner=c.owner;configureSecondaryPane(initRightPane());const call=(name)=>body=>window.piGuiObjectTest.invoke(name,body);const transport={query:call('query'),preview:call('preview'),history:async()=>({ok:true,plans:[]})};const objectTransport=Object.fromEntries(['history','qualification','prepare','apply','cancel','inspectRecovery','prepareRecovery','exportMaterial'].map(k=>[k,call(k)]));document.querySelector('#btnMore').onclick=()=>openSessionChangesPanel({context:()=>c,transport,objectTransport});document.querySelector('#workspace').dataset.workspaceView='chat';document.querySelector('#projects').textContent='D6 TEST ONLY TEMP · actual SDK · guardian transport DI';})();`);
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
 await app.whenReady();await fs.mkdir(config.output,{recursive:true});await boot(1);await open();await modal();
 phase='keyboard-cancel';await key('Tab');await key('Enter');check('incomplete Enter does not commit',fixture.measure.commits===0);await key('Escape');await until("!document.querySelector('[data-object-modal]')");check('Escape never commits',fixture.measure.commits===0);
 await open();await modal();phase='layout';
 for(const width of [720,900,1200,1280,1440,1920]){
  win.setContentSize(width,1100);await tick();await tick();
  check('modal within viewport '+width,await read("(()=>{const r=document.querySelector('[data-object-modal] .modal-card').getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1})()"));
  check('risk controls separated '+width,await read("[...document.querySelectorAll('.object-revert-risk')].every(e=>{const i=e.querySelector('input').getBoundingClientRect(),s=e.querySelector('span').getBoundingClientRect();return i.right<=s.left+1&&s.width>100})"));
  await capture('confirm-'+width);
 }
 win.setContentSize(1200,1100);await tick();phase='native-result-pipe-uncertain';await risks();await click('[data-object-action=confirm]');
 await until("!document.querySelector('[data-object-modal]')&&document.querySelector('[data-object-status=recovery_required]')");
 check('Native verified then result pipe corrupted exactly once',fixture.measure.commits===1&&fixture.measure.actualNativeVerified===1);
 check('physical first result is exact R',(await fs.readFile(fixture.target)).equals(fixture.R));await tick();await tick();check('uncertainty never retries',fixture.measure.commits===1);await capture('recovery-required');
 phase='history';await click('.session-change-actions > button:nth-child(2)');await until("document.querySelector('.session-change-row > button')");await click('.session-change-row > button');await until("document.querySelector('[data-object-action=inspect]')");
 check('history remains read-only without new confirmation',fixture.measure.commits===1&&await read("!document.querySelector('[data-object-modal]')"));
 await fixture.externalD();const D=hash(await fs.readFile(fixture.target));phase='fresh-D-confirm';await click('[data-object-action=inspect]');
 await until("document.querySelector('[data-object-action=prepare-recovery]')&&!document.querySelector('[data-object-action=prepare-recovery]').disabled");await click('[data-object-action=prepare-recovery]');await until("document.querySelector('[data-object-modal]')");
 check('fresh D-to-C resets all four v3 risks',await read("document.querySelectorAll('[data-object-risk]').length===4&&[...document.querySelectorAll('[data-object-risk]')].every(e=>!e.checked)&&document.querySelector('[data-object-action=confirm]').disabled"));await capture('D-to-C-new-confirm');await risks();await click('[data-object-action=confirm]');
 await until("document.querySelector('[data-object-status=applied_verified]')");check('new recovery commits once and final C is exact',fixture.measure.commits===2&&(await fs.readFile(fixture.target)).equals(fixture.C));
 const report=await fixture.verify();const activePlans=report.saved.filter(p=>p.state!=='not_applied');check('cancelled plan and two durable write generations preserve C R D',report.saved.length===3&&report.saved[0].state==='not_applied'&&activePlans.length===2&&activePlans[0].state==='recovery_required'&&activePlans[1].state==='applied_verified'&&activePlans[1].currentDigest===D&&activePlans[1].candidateDigest===report.C);
 check('Native identity and visible metadata verified',activePlans[1].metadataEqual===true&&activePlans[1].verifiedObjectId===activePlans[0].objectId);check('Git index and refs unchanged',report.gitUnchanged);check('two default real model tool captures',report.rpcTools.length===2&&report.sourceVerified);check('model request bound',config.offlineFixture?report.modelRequests===0:report.modelRequests>0&&report.modelRequests<=4);check('renderer errors absent',errors.length===0);
 await capture('recovered-C');evidence.push({mode:config.mode,scale:config.scale,scenario:'real-model-capture-uncertain-new-D-recovery',D,...report});
 const assets={publicPanelHash:hash(await fs.readFile(path.join(config.resourceRoot,'public/session-changes-panel.js'))),publicObjectHash:hash(await fs.readFile(path.join(config.resourceRoot,'public/session-revert-object-ui.js'))),styleHash:hash(await fs.readFile(path.join(config.resourceRoot,'public/styles.css')))};
 const result={phase:'result',checks,failed:0,skipped:0,mode:config.mode,guardianTransport:'test-ipc-supervisor',actualSdk:true,offlineFixture:config.offlineFixture===true,realModel:config.offlineFixture?'REAL_MODEL_RETEST_PENDING':'REAL_MODEL_VERIFIED',modelRequests:fixture.measure.modelRequests,sameProcessOnly:true,assets,screens,evidence};
 await fs.writeFile(path.join(config.output,config.mode+'-evidence.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
let primaryFailure=null;
try{await run();}catch(error){primaryFailure={phase:'failure',at:phase,checks,reason:'d6_model_gui_failed',diagnostic:safeFailure(error,phase),mode:config.mode};process.exitCode=1;if(win)try{await capture('failure-'+phase);}catch{}console.log(JSON.stringify(primaryFailure));}
finally{
 modelConfig=null;
 const cleanup=createCleanup([
  ['fixture',async()=>{const rows=await fixture?.dispose();if(rows?.some(row=>!row.ok))throw Object.assign(Error('cleanup_failed'),{code:'cleanup_failed'});}],
  ['window',()=>{allowedContents=null;win?.destroy();}],
  ['server',()=>{if(server){server.closeAllConnections();server.close();}}]
 ]);
 const records=await cleanup.run();if(records.some(row=>!row.ok))process.exitCode=1;
 try{await fs.writeFile(path.join(config.output,config.mode+'-cleanup.json'),JSON.stringify({primaryFailure,records,fixture:fixture?.measure.cleanup??[]}));if(primaryFailure)await fs.writeFile(path.join(config.output,config.mode+'-failure.json'),JSON.stringify(primaryFailure));}catch(error){process.exitCode=1;process.stderr.write(JSON.stringify(safeFailure(error,'cleanup-record'))+'\n');}
 app.exit(process.exitCode??0);
}
}
main().catch(error=>{process.stderr.write(JSON.stringify(safeFailure(error,'launcher'))+'\n');app.exit(2);});
