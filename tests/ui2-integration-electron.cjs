/* Offline actual Electron integration: production ESM/store/CSS; no real Pi. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'docs/claude-ui-redesign/ui2-integration-evidence/scroll');
if(!process.versions.electron){
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'ui2-scroll-'));const env={...process.env,UI2_SCROLL_WORLD:world};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[__filename,'--no-sandbox','--in-process-gpu'],{env,stdio:'inherit',windowsHide:true});
 child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;fs.rm(world,{recursive:true,force:true,maxRetries:30,retryDelay:100},()=>{});});
}else{
 const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.UI2_SCROLL_WORLD);app.on('window-all-closed',()=>{});
 let win,harness;const checks=[],facts=[],wheelFacts=[],screenshots=[],errors=[],started=Date.now();const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const read=s=>win.webContents.executeJavaScript(s,true);const check=(pass,label,detail)=>{checks.push({pass:!!pass,label,detail});console.log((pass?'PASS ':'FAIL ')+label+(pass?'':' '+JSON.stringify(detail)));};
 const metrics=selector=>read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return {top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight,gap:e.scrollHeight-e.clientHeight-e.scrollTop}})()`);
 async function shot(name){await sleep(80);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());screenshots.push(name+'.png');}
 async function wheel(selector,deltaY){
  const point=await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY});await sleep(350);
 }
 async function wheelCase(label,selector,append){
  await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});window.__wheelEvents=[];e.addEventListener('scroll',event=>window.__wheelEvents.push({trusted:event.isTrusted,top:e.scrollTop}),{passive:true});})()`);
  await wheel(selector,100000);const bottom=await metrics(selector);
  await read(`window.__wheelEvents=[]`);await wheel(selector,-650);const up=await metrics(selector),events=await read(`window.__wheelEvents`);
  check(up.top<bottom.top-300&&up.gap>160&&events.some(e=>e.trusted),label+' CDP wheel scrolls upward and produces trusted DOM scroll', {bottom,up,events});
  for(let i=0;i<6;i++){await read(append(3));await sleep(50);}const reading=await metrics(selector);
  check(Math.abs(reading.top-up.top)<=2,label+' continuous deltas preserve wheel-selected reading position',{up,reading});await shot(label.toLowerCase()+'-wheel-reading');
  await wheel(selector,100000);const returned=await metrics(selector);check(returned.gap<=2,label+' CDP wheel returns to bottom',returned);
  await read(append(20));await sleep(150);const following=await metrics(selector);check(following.gap<=2,label+' streaming follows again after wheel return',following);await shot(label.toLowerCase()+'-wheel-following');
  wheelFacts.push({label,bottom,up,events,reading,returned,following});
 }
 async function main(){
  fs.mkdirSync(OUT,{recursive:true});await app.whenReady();
  harness=spawn(process.execPath,[path.join(ROOT,'tests/visual-harness.cjs')],{cwd:process.env.UI2_SCROLL_WORLD,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HARNESS_PORT:'0'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  harness.stderr.on('data',c=>errors.push('harness '+String(c)));
  const origin=await new Promise((resolve,reject)=>{let buf='';const timer=setTimeout(()=>reject(Error('harness startup')),15000);harness.stdout.on('data',c=>{buf+=c;const m=buf.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});harness.on('error',reject);});
  win=new BrowserWindow({width:1200,height:900,useContentSize:true,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message',async(_e,method,p)=>{if(method!=='Fetch.requestPaused')return;const url=new URL(p.request.url);const body=url.searchParams.has('conversationId')?{ok:true,messages:[{role:'user',text:'History question'},{role:'assistant',text:('History answer line\n').repeat(180)}],truncated:false}:{ok:true};await win.webContents.debugger.sendCommand('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(body)).toString('base64')});});
  await win.webContents.debugger.sendCommand('Fetch.enable',{patterns:[{urlPattern:'*/api/runtime-sessions*'}]});
  await win.loadURL(origin);await sleep(2500);
  await read(`(async()=>{window.M=await import('/messages.js');window.T=await import('/tools.js');window.ST=await import('/state.js');M.clearThread();M.onMessageStart({message:{role:'assistant'}});window.cd=t=>M.onMessageUpdate({assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:t}});cd(('Classic scroll fixture line\\n\\n').repeat(100));})()`);await sleep(200);
  for(let i=0;i<12;i++){await read(`cd('continuous delta ${i}\\n\\n')`);await sleep(40);const m=await metrics('#stream');check(m.gap<=2,'Classic bottom follows delta '+i,m);}
  await read(`document.querySelector('#stream').scrollTop=100`);const cBefore=await metrics('#stream');
  for(let i=0;i<8;i++){await read(`cd(('while reading previous text\\n\\n').repeat(3))`);await sleep(40);}
  const cAfter=await metrics('#stream');check(Math.abs(cAfter.top-cBefore.top)<=2,'Classic delta preserves user scroll', {before:cBefore,after:cAfter});await shot('classic-reading');
  await read(`document.querySelector('#stream').scrollTop=document.querySelector('#stream').scrollHeight`);await read(`cd(('resume following\\n\\n').repeat(20))`);await sleep(100);check((await metrics('#stream')).gap<=2,'Classic returning bottom resumes follow',await metrics('#stream'));
  await read(`document.querySelector('#stream').scrollTop=100;M.onMessageStart({message:{role:'assistant'}})`);await sleep(120);check(Math.abs((await metrics('#stream')).top-100)<=2,'Classic new assistant does not steal reader scroll',await metrics('#stream'));
  await read(`document.querySelector('#stream').scrollTop=100;T.onToolStart({toolCallId:'scroll-tool',toolName:'bash',args:{command:'fixture'}})`);await sleep(150);check(Math.abs((await metrics('#stream')).top-100)<=2,'Classic tool start does not steal reader scroll',await metrics('#stream'));
  await shot('classic-after-tool');
  await wheelCase('Classic','#stream',n=>`cd(('wheel continuation\\n\\n').repeat(${n}))`);
  await read(`(async()=>{const R=await import('/runtime-state.js'),CV=await import('/runtime-conversation.js');window.R=R;window.owner=id=>({backendInstance:'scroll-backend',projectId:'p',repoId:'r',workspaceId:'w-'+id,workspaceEpoch:'e',conversationId:id,runtimeId:'rt-'+id,runtimeGeneration:'g',sessionId:'s-'+id});window.item=id=>({conversationId:id,owner:owner(id),workspace:{branch:'fixture-'+id},lifecycle:'ready',activity:'running',revision:1});window.seq={A:0,B:0};window.frame=(id,event)=>R.observeRuntimeFrame({type:'runtime_event',owner:owner(id),eventSequence:++seq[id],event});window.rd=(id,t)=>frame(id,{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:t}});R.seedRuntimeSnapshot({backendInstance:'scroll-backend',items:[item('A'),item('B')]});const host=document.querySelector('#runtimeConversationView')||document.querySelector('.runtime-conversation-view');if(!host)throw Error('runtime host missing');(await import('/ui/workspace-surface.js')).showRuntimeConversation();host.replaceChildren();window.V=CV.createRuntimeConversation({host});V.show('A');rd('A',('A history line\\n').repeat(150));rd('B',('B history line\\n').repeat(150));})()`);await sleep(150);
  const sel='.rtc-output';check((await metrics(sel)).height>(await metrics(sel)).client+500,'Runtime fixture has real scroll geometry',await metrics(sel));
  await read(`document.querySelector('.rtc-output').scrollTop=document.querySelector('.rtc-output').scrollHeight`);
  for(let i=0;i<12;i++){await read(`rd('A',('large continuous chunk ${i}\\n').repeat(20))`);await sleep(40);check((await metrics(sel)).gap<=2,'Runtime bottom follows large delta '+i,await metrics(sel));}
  await read(`document.querySelector('.rtc-output').scrollTop=120`);const aBefore=await metrics(sel);
  for(let i=0;i<8;i++){await read(`rd('A',('reading preserved\\n').repeat(5))`);await sleep(35);}
  check(Math.abs((await metrics(sel)).top-aBefore.top)<=2,'Runtime delta preserves user scroll',{before:aBefore,after:await metrics(sel)});
  await read(`const input=document.querySelector('.runtime-conversation textarea');input.value='draft A';input.dispatchEvent(new Event('input'));V.show('B');document.querySelector('.rtc-output').scrollTop=240;document.querySelector('.runtime-conversation textarea').value='draft B';document.querySelector('.runtime-conversation textarea').dispatchEvent(new Event('input'));rd('A','late legal A delta\\n')`);await sleep(100);
  check(await read(`!document.querySelector('.rtc-output').textContent.includes('late legal A')&&document.querySelector('.runtime-conversation textarea').value==='draft B'`),'Runtime legal late A event leaves B text and draft isolated');
  await read(`V.show('A')`);await sleep(100);check(Math.abs((await metrics(sel)).top-120)<=2&&await read(`document.querySelector('.runtime-conversation textarea').value==='draft A'&&document.querySelector('.rtc-output').textContent.includes('late legal A')`),'Runtime A scroll draft and late text restored',await metrics(sel));
  await read(`V.show('B')`);await sleep(100);check(Math.abs((await metrics(sel)).top-240)<=2&&await read(`document.querySelector('.runtime-conversation textarea').value==='draft B'`),'Runtime B scroll and draft restored',await metrics(sel));
  await read(`V.show('A');document.querySelector('.rtc-output').scrollTop=document.querySelector('.rtc-output').scrollHeight;rd('A',('back at bottom\\n').repeat(20))`);await sleep(100);check((await metrics(sel)).gap<=2,'Runtime returning bottom resumes follow',await metrics(sel));
  await shot('runtime-scroll');
  await wheelCase('Runtime','.rtc-output',n=>`rd('A',('wheel continuation\\n').repeat(${n}))`);
  await read(`document.querySelector('.rtc-output').scrollTop=180;V.leave();document.querySelector('#runtimeView').hidden=true;rd('A',('hidden arriving delta\\n').repeat(20));document.querySelector('#runtimeView').hidden=false;V.show('A')`);await sleep(120);
  check(Math.abs((await metrics(sel)).top-180)<=2,'Runtime leave and same-id show preserve reader viewport',await metrics(sel));
  await read(`[...document.querySelectorAll('.rtc-controls button')].find(e=>e.textContent==='停止').click()`);await sleep(120);
  check(Math.abs((await metrics(sel)).top-180)<=2,'Runtime stop request preserves reading viewport',await metrics(sel));
  await read(`R.observeRuntimeFrame({type:'runtime_closed',backendInstance:'scroll-backend',owner:owner('A'),conversationId:'A',item:{...item('A'),owner:null,lifecycle:'dormant',activity:'idle',revision:2}});[...document.querySelectorAll('.rtc-controls button')].find(e=>e.textContent==='打开历史').click()`);await sleep(150);
  check(await read(`document.querySelector('.rtc-output').textContent.includes('History answer')&&document.querySelector('.rtc-state').textContent.includes('只含正文')&&document.querySelector('.runtime-conversation textarea').disabled`),'Runtime history uses actual API renderer and disables composer');
  await read(`document.querySelector('.rtc-output').scrollTop=210;V.draw()`);await sleep(100);check(Math.abs((await metrics(sel)).top-210)<=2,'Runtime history redraw preserves reading viewport',await metrics(sel));await shot('runtime-history');
  await read(`R.observeRuntimeFrame({type:'runtime_state',owner:owner('A'),item:{...item('A'),revision:3}});[...document.querySelectorAll('.rtc-controls button')].find(e=>e.textContent==='返回实时会话').click();seq.A=0;rd('A','resumed live text')`);await sleep(100);
  check(await read(`document.querySelector('.rtc-output').textContent.includes('resumed live text')&&!document.querySelector('.runtime-conversation textarea').disabled`),'Runtime history returns to its live text and composer');
  await read(`frame('A',{type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'LongUnbrokenThinking'.repeat(7000)}});for(const [id,error] of [['done',false],['failed',true],['running',null]]){frame('A',{type:'tool_execution_start',toolCallId:id,toolName:id});if(error!==null)frame('A',{type:'tool_execution_end',toolCallId:id,isError:error});}document.querySelector('.ui2-runtime-thinking').open=true`);
  for(const theme of ['dark','light'])for(const width of [700,900,1200,1536]){win.setContentSize(width,900);await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await sleep(150);const f=await read(`(()=>{const q=s=>document.querySelector(s),o=q('.rtc-output'),t=q('.ui2-runtime-thinking-body');return {width:innerWidth,page:document.documentElement.scrollWidth,thinking:{w:t.clientWidth,sw:t.scrollWidth,whiteSpace:getComputedStyle(t).whiteSpace,wrap:getComputedStyle(t).overflowWrap},usageHidden:q('.ui2-runtime-usage').hidden,states:[...document.querySelectorAll('.ui2-runtime-tool')].map(e=>e.dataset.state),truncation:q('.ui2-runtime-thinking-head').textContent.includes('已截断'),output:{h:o.clientHeight,sh:o.scrollHeight},color:getComputedStyle(q('.runtime-conversation')).color}})()`);facts.push({theme,width,...f});check(f.page<=f.width+1&&f.thinking.sw<=f.thinking.w+1,theme+' '+width+' long Thinking wraps without page overflow',f);check(f.usageHidden&&f.truncation&&['done','error','running'].every(s=>f.states.includes(s)),theme+' '+width+' unknown usage hidden, truncation and real tool three states',f);await shot('runtime-'+theme+'-'+width);await read(`document.querySelector('.ui2-runtime-thinking').open=false`);await sleep(80);const visibleTools=await read(`[...document.querySelectorAll('.ui2-runtime-tool')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.top>=0&&r.bottom<=innerHeight})`);check(visibleTools,theme+' '+width+' collapsed thinking keeps three tool states visible');await shot('runtime-tools-'+theme+'-'+width);await read(`document.querySelector('.ui2-runtime-thinking').open=true`);}
  check(errors.length===0,'No renderer or harness console errors',errors);
 }
 const timeout=setTimeout(()=>{console.error('Electron scroll timeout');app.exit(1);},180000);
 main().catch(e=>{errors.push(e.stack);check(false,'execution completed',e.message);}).finally(async()=>{const failed=checks.filter(c=>!c.pass).length;fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({passed:checks.length-failed,failed,exitCode:failed?1:0,checks,facts,wheelFacts,screenshots,errors,durationMs:Date.now()-started,versions:{electron:process.versions.electron,chrome:process.versions.chrome},coverage:'Actual Electron production ESM and validated runtime frames, temporary userData, offline port-0 harness; fixture-only no real Pi/model; history/live/stop request and leave/show included; stop command response is offline fixture; no real Pi termination proof'},null,2));console.log('UI2 integration scroll '+(checks.length-failed)+'/'+checks.length);clearTimeout(timeout);win?.destroy();harness?.kill();await sleep(100);app.exit(failed?1:0);});
}
