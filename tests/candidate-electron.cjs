/* Production server/renderer/RPC/Worktree, normal Electron sandbox and a fake Pi. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn,spawnSync,execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.resolve(process.env.T4B_EVIDENCE_DIR||path.join(ROOT,'.probe/t4b-electron'));
if(!process.versions.electron){const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const r=spawnSync(require('electron'),[__filename],{env,stdio:'inherit',windowsHide:true,timeout:360000});process.exit(r.status??1);}
const {app,BrowserWindow,ipcMain}=require('electron'),assert=require('node:assert/strict');
app.on('window-all-closed',()=>{}); // Preserve the explicit result/exit during fixture cleanup.
const world=fs.mkdtempSync(path.join(os.tmpdir(),'t4b-electron-'));let backend,win,browser,legacyHost,runtimeHost,base,checks=0;const shots=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,ok)=>{assert(ok,name);checks++;console.log('ok '+name);};
const read=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(e){console.error('Failed fixture renderer step: '+code.slice(0,160));throw e;}};
async function until(code,label){for(let i=0;i<500;i++){if(await read(code))return;await sleep(100);}throw Error('timeout: '+label);}
async function click(text,selector='#modalCard'){await read(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)}+' button')].find(b=>b.textContent===${JSON.stringify(text)}&&!b.hidden&&!b.disabled);if(!b)throw Error('button unavailable');b.scrollIntoView({block:'center'});b.click()})()`);}
async function shot(name){await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await sleep(100);fs.writeFileSync(path.join(OUT,name+'.png'),(await win.webContents.capturePage()).toPNG());shots.push(name+'.png');}
async function main(){
 app.setPath('userData',path.join(world,'electron'));await app.whenReady();fs.mkdirSync(OUT,{recursive:true});
 const repo=path.join(world,'source'),data=path.join(world,'data'),home=path.join(world,'home'),pkg=path.join(world,'node_modules/@earendil-works/pi-coding-agent');
 for(const dir of [repo,data,home,path.join(pkg,'dist/core/extensions'),path.join(pkg,'dist/cli')])fs.mkdirSync(dir,{recursive:true});
 fs.mkdirSync(path.join(repo,'src'));fs.writeFileSync(path.join(repo,'src/app.js'),'export const value = 1;\n');fs.writeFileSync(path.join(repo,'SPEC.md'),'# Fixture\n');
 const git=(...a)=>execFileSync('git',a,{cwd:repo,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
 git('init','-b','main');git('config','user.name','fixture');git('config','user.email','f@example.invalid');git('config','core.autocrlf','false');git('add','.');git('commit','-m','base');
 fs.writeFileSync(path.join(repo,'src/app.js'),'export const value = 2;\n');const original=fs.readFileSync(path.join(repo,'src/app.js')),originalIndex=fs.readFileSync(path.join(repo,'.git/index'));
 fs.writeFileSync(path.join(data,'projects.json'),JSON.stringify({active:repo,items:[{path:repo,name:'T4-B Fixture'}]}));
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.3.0',bin:{pi:'cli.cjs'}}));
 fs.writeFileSync(path.join(pkg,'dist/core/extensions/types.d.ts'),'"tool_call" "tool_execution_end" getAllTools() registerTool<');fs.writeFileSync(path.join(pkg,'dist/cli/args.js'),'if (arg === "--extension") {}');
 fs.copyFileSync(path.join(ROOT,'tests/fixtures/candidate-pi.cjs'),path.join(pkg,'cli.cjs'));
 const shim=path.join(world,process.platform==='win32'?'pi.cmd':'pi');fs.writeFileSync(shim,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${path.join(pkg,'cli.cjs')}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${path.join(pkg,'cli.cjs')}" "$@"\n`,{mode:0o755});
 const net=require('node:net').createServer();await new Promise(r=>net.listen(0,'127.0.0.1',r));const port=net.address().port;await new Promise(r=>net.close(r));base=`http://127.0.0.1:${port}`;
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',PORT:String(port),PI_GUI_DATA:data,PI_CWD:repo,PI_BIN:shim,PI_GUI_TOKEN:'',PI_GUI_OPEN:'0',PI_GUI_OFFLINE:'1',PI_OFFLINE:'1',PI_CODING_AGENT_DIR:path.join(home,'agent'),HOME:home,USERPROFILE:home,CANDIDATE_TRACE:path.join(world,'trace.jsonl')};
 async function start(){backend=spawn(process.execPath,[path.join(ROOT,'server.js')],{cwd:ROOT,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='';backend.stderr.on('data',c=>stderr+=c);backend.stdout.resume();
  for(let i=0;i<150;i++){try{if((await(await fetch(base+'/api/health')).json()).app==='pi-gui')return;}catch{}if(backend.exitCode!==null){console.error(stderr);throw Error('backend exited');}await sleep(100);}throw Error('health timeout');}
 async function stopBackend(){if(backend&&backend.exitCode===null){backend.kill();for(let i=0;i<100&&backend.exitCode===null;i++)await sleep(100);}}
 browser=require('../electron/browser-view.cjs').createBrowserController({origin:base,getWindow:()=>win,ipcMain,isVisible:()=>!runtimeHost||runtimeHost.isLegacyVisible()});browser.register();
 legacyHost=require('../electron/browser-agent-host.cjs').createBrowserAgentHost({browser,origin:base,getWindow:()=>win,ipcMain,extensionPath:path.join(ROOT,'extensions/pi-gui-browser/index.js')});await legacyHost.start();
 runtimeHost=require('../electron/browser-runtime-host.cjs').createRuntimeBrowserHost({origin:base,getWindow:()=>win,ipcMain,extensionPath:path.join(ROOT,'extensions/pi-gui-browser/index.js'),onFocus:active=>browser.setOccluded(active)});await runtimeHost.start();
 Object.assign(env,legacyHost.environment(),runtimeHost.environment());
 await start();
 win=new BrowserWindow({width:1200,height:850,show:true,useContentSize:true,autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(ROOT,'electron/preload.cjs')}});
 win.webContents.on('console-message',e=>{if(e.level==='error')console.error('Fixture renderer error: '+e.message.slice(0,240));});
 await win.loadURL(base+'/');await until("document.querySelector('#connText')?.textContent.includes('已连接')",'source ready');
 check('normal sandbox is enabled',win.webContents.getLastWebPreferences().sandbox===true);
 await read("document.querySelector('#navChanges').click()");await until("!!document.querySelector('.chg-main')",'source Changes');await read("document.querySelector('.chg-main').click()");await until("!!document.querySelector('.d-row[data-line-type=add]')",'source Diff');
 await until("import('/review-comment-persistence.js').then(m=>m.reviewPersistenceState().status==='ready')",'comment storage ready');
 await read("document.querySelector('.d-row[data-line-type=add] .d-gutter').click()");await until("!!document.querySelector('.d-review-editor textarea')",'comment editor');
 await read("(()=>{const t=document.querySelector('.d-review-editor textarea');t.value='修改为候选实现';t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.d-review-editor .btn.primary').click()})()");
 await until("!!document.querySelector('.d-row.has-comment')&&!document.querySelector('.d-review-editor')",'saved comment');
 await read("document.querySelector('#input').value='保留原草稿';document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}))");
 await read("document.querySelector('#btnChangesReview').click()");await click('准备修改任务');await click('预览修改任务');await click('在隔离工作区生成修改');
 await until("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent==='确认创建并执行')",'preflight');
 check('no prompt or worktree before confirmation',!fs.existsSync(path.join(data,'worktrees'))&&!fs.readFileSync(path.join(world,'trace.jsonl'),'utf8').includes('"prompt"'));
 for(const width of [720,900,1200,1536]){win.setContentSize(width,850);await sleep(120);check(`preflight fits ${width}px`,await read("(()=>{const r=document.querySelector('#modalCard').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth+1})()"));}
 win.setContentSize(1200,850);await shot('01-preflight');await click('确认创建并执行');
 await until("document.querySelector('.candidate-flow')?.textContent.includes('执行中')",'candidate started');
 check('candidate uses distinct registered Worktree',fs.readdirSync(path.join(data,'worktrees')).length===1&&original.equals(fs.readFileSync(path.join(repo,'src/app.js'))));
 await click('打开候选会话查看审批');await until("!!document.querySelector('.rtc-approval')",'real approval');
 check('existing tool approval is preserved',await read("document.querySelector('.rtc-approval').textContent.includes('允许候选 fixture')"));await shot('02-approval');await click('确认','.rtc-approval');
 await until("import('/runtime-state.js').then(m=>m.runtimeStore.values ? true : true)",'approval handled');
 for(let i=0;i<600;i++){const files=fs.existsSync(path.join(data,'candidate-runs'))?fs.readdirSync(path.join(data,'candidate-runs')).filter(n=>n.endsWith('.json')):[];if(files.length&&JSON.parse(fs.readFileSync(path.join(data,'candidate-runs',files[0]),'utf8')).run.state==='completed')break;await sleep(100);if(i===599)throw Error('candidate completion timeout');}
 await read("document.querySelector('#navHome').click();document.querySelector('#navChanges').click()");await until("!!document.querySelector('#btnChangesReview')",'source return');
 await read("document.querySelector('#btnChangesReview').click()");await click('准备修改任务');await click('候选修改');await until("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent.startsWith('已完成'))",'retained run');
 await read("[...document.querySelectorAll('.candidate-flow button')].find(b=>b.textContent.startsWith('已完成')).click()");await until("!!document.querySelector('.candidate-file')",'real result');
 await read("document.querySelector('.candidate-file').open=true");check('real diff starts at dirty value 2 not HEAD value 1',await read("document.querySelector('.candidate-diff').textContent.includes('-export const value = 2')&&document.querySelector('.candidate-diff').textContent.includes('+export const value = 3')&&!document.querySelector('.candidate-diff').textContent.includes('-export const value = 1')"));
 check('source file and real index unchanged',original.equals(fs.readFileSync(path.join(repo,'src/app.js')))&&originalIndex.equals(fs.readFileSync(path.join(repo,'.git/index'))));
 check('source composer draft survives candidate execution',await read("document.querySelector('#input').value==='保留原草稿'"));await shot('03-real-diff');
 const evidenceFiles=fs.readdirSync(path.join(data,'candidate-runs')).filter(n=>n.endsWith('.json'));
 const qualified=JSON.parse(fs.readFileSync(path.join(data,'candidate-runs',evidenceFiles[0]),'utf8')).result;
 const adoptionAt=()=>{const files=fs.existsSync(path.join(data,'candidate-transactions'))?fs.readdirSync(path.join(data,'candidate-transactions')).filter(n=>/^[a-f0-9-]{36}$/.test(n)):[];if(!files.length)return null;const dir=path.join(data,'candidate-transactions',files[0]),rows=fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort(),latest=JSON.parse(fs.readFileSync(path.join(dir,rows.at(-1)),'utf8')).event;return{state:latest.state,uncertain:latest.uncertain===true,files:rows.map(n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8')).event).filter(e=>e.state==='step_verified').length};};
 if(!qualified.reliable)console.error('Evidence qualification: '+JSON.stringify(qualified.unconfirmedReasons));
 check('guarded real write has matching intended-byte proof',qualified.reliable===true);
 async function checkAdoption(label){
  await click('准备采纳修改','.candidate-flow');
  await until("document.querySelector('.candidate-flow')?.textContent.includes('预检通过，尚未采纳')",label+' apply preflight');
  check(label+' preflight offers explicit confirmation',await read("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent==='确认采纳')"));
  check(label+' preflight leaves source bytes and index unchanged',original.equals(fs.readFileSync(path.join(repo,'src/app.js')))&&originalIndex.equals(fs.readFileSync(path.join(repo,'.git/index'))));
  for(const width of [720,900,1200,1536]){win.setContentSize(width,850);await sleep(120);check(`${label} apply preflight fits ${width}px`,await read("document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('#modalCard').getBoundingClientRect().right<=innerWidth+1"));}
  win.setContentSize(1200,850);await shot('t4c-'+label+'-apply-preflight');
  await click('返回候选 Diff','.candidate-flow');await until("!!document.querySelector('.candidate-file')",'back to actual Diff');
 }
 if(process.env.T4C_APPLY_ADOPTION==='1')await checkAdoption('source');
 async function closePreview(){await click('返回修改任务','.candidate-flow');await click('关闭','.review-task');}
 async function openResult(){await read("document.querySelector('#btnChangesReview').click()");await click('准备修改任务');await click('候选修改');await until("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent.startsWith('已完成'))",'retained result');await read("[...document.querySelectorAll('.candidate-flow button')].find(b=>b.textContent.startsWith('已完成')).click()");await until("!!document.querySelector('.candidate-file')",'candidate result');await read("document.querySelector('.candidate-file').open=true");}
 await closePreview();await read("document.querySelector('#btnChangesSplit').click()");await until("!!document.querySelector('#workbenchChangesPane #btnChangesReview')",'Specs Changes split');await openResult();
 check('Specs and Changes share the candidate preview',await read("!!document.querySelector('#workbenchChangesPane')&&!!document.querySelector('.candidate-file')"));
 for(const width of [720,900,1200,1536]){win.setContentSize(width,850);await sleep(120);check(`actual Diff fits ${width}px`,await read("document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('#modalCard').getBoundingClientRect().right<=innerWidth+1"));}
 win.setContentSize(1200,850);await shot('04-specs-diff');await closePreview();
 await read("document.querySelector('#btnBrowser').click()");await until("!!document.querySelector('#browserSplit')",'Browser opened');await read("document.querySelector('#browserSplit').click()");await until("!!document.querySelector('#workbenchChangesPane #btnChangesReview')",'Browser Changes split');
 for(let i=0;i<100&&win.contentView.children.length===0;i++)await sleep(50);check('real native Browser view attached before modal',win.contentView.children.length>0);
 await openResult();for(let i=0;i<100&&win.contentView.children.length;i++)await sleep(50);check('native Browser cannot cover candidate Diff modal',win.contentView.children.length===0);await shot('05-browser-diff');
 if(process.env.T4C_APPLY_ADOPTION==='1'){
  await checkAdoption('browser');check('native Browser cannot cover apply preflight',win.contentView.children.length===0);
  fs.writeFileSync(path.join(repo,'src/app.js'),'export const value = 999;\n');
  await click('准备采纳修改','.candidate-flow');await until("document.querySelector('.candidate-flow')?.textContent.includes('来源工作区内容或身份已变化')",'source conflict');
  check('source conflict refuses preflight and preserves external bytes',fs.readFileSync(path.join(repo,'src/app.js'),'utf8').includes('999')&&!await read("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent==='确认采纳')"));
  await shot('t4c-source-conflict');fs.writeFileSync(path.join(repo,'src/app.js'),original);
  await click('返回候选 Diff','.candidate-flow');await until("!!document.querySelector('.candidate-file')",'source restored Diff');
  await click('准备采纳修改','.candidate-flow');await until("document.querySelector('.candidate-flow')?.textContent.includes('预检通过，尚未采纳')",'explicit source apply preflight');await click('确认采纳','.candidate-flow');
  await until("document.querySelector('.candidate-flow')?.textContent.includes('已采纳')",'source adoption');await shot('t4c-applied');
  check('confirmed candidate writes exact source bytes',fs.readFileSync(path.join(repo,'src/app.js'),'utf8')==='export const value = 3;\n');
  check('confirmed candidate preserves staged index bytes',originalIndex.equals(fs.readFileSync(path.join(repo,'.git/index'))));
  await click('返回候选 Diff','.candidate-flow');await until("!!document.querySelector('.candidate-file')",'adopted result');
  check('confirmed adoption is durably recorded as applied',adoptionAt()?.state==='applied'&&adoptionAt()?.files===1);
  fs.writeFileSync(path.join(repo,'src/app.js'),'export const value = 999;\n');
  check('applied candidate cannot be prepared again',!await read("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent==='确认采纳')"));
  check('external post-apply bytes are never overwritten',fs.readFileSync(path.join(repo,'src/app.js'),'utf8').includes('999'));
  await shot('t4c-post-apply-external');
  fs.writeFileSync(path.join(repo,'src/app.js'),'export const value = 3;\n');
 }
 await closePreview();for(let i=0;i<100&&!win.contentView.children.length;i++)await sleep(50);check('native Browser restored after closing preview',win.contentView.children.length>0);
 const trace=fs.readFileSync(path.join(world,'trace.jsonl'),'utf8').trim().split('\n').map(v=>JSON.parse(v));check('exactly one prompt and only to candidate',trace.filter(v=>v.type==='prompt').length===1&&trace.filter(v=>v.type==='prompt').every(v=>v.candidate));
 console.log('stage restart backend');await stopBackend();await start();await win.loadURL(base+'/');await until("document.querySelector('#connText')?.textContent.includes('已连接')",'restart');
 console.log('stage restart ready');
 await read("document.querySelector('#navChanges').click()");await until("!!document.querySelector('#btnChangesReview')",'restored Changes');await until("import('/review-comment-persistence.js').then(m=>m.reviewPersistenceState().status==='ready')",'restored comment authority');await read("document.querySelector('#btnChangesReview').click()");await click('准备修改任务');await click('候选修改');
 await until("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent.startsWith('已完成'))",'recovered history');
 check('restart restores retained result without another Agent run',fs.readFileSync(path.join(world,'trace.jsonl'),'utf8').split('"prompt"').length===2);
 if(process.env.T4C_APPLY_ADOPTION==='1'){
 await read("[...document.querySelectorAll('.candidate-flow button')].find(b=>b.textContent.startsWith('已完成')).click()");await until("!!document.querySelector('.candidate-file')",'restored candidate Diff');
 check('restart reports the durable applied transaction',await read("document.querySelector('.candidate-flow').textContent.includes('已采纳')")&&adoptionAt()?.state==='applied');
 check('restart keeps the consumed confirmation unavailable',!await read("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent==='准备采纳修改'||b.textContent==='确认采纳')"));
 }
 await click('返回修改任务','.candidate-flow');await click('关闭','.review-task');await read("document.querySelector('.chg-main').click()");
 if(process.env.T4C_APPLY_ADOPTION==='1')await until("document.querySelector('#btnChangesReview')?.textContent.includes('1')",'retained source comment after adoption');
 else await until("!!document.querySelector('.d-row.has-comment')",'revalidated source comment');
 if(process.env.T4C_APPLY_ADOPTION==='1'){
  await read("document.querySelector('#btnChangesReview').click()");
  await until("document.querySelector('#modalCard .review-stale')?.textContent==='原位置已变化'",'stale source comment after adoption');
  check('adopted source retains the comment as stale at its old location',await read("document.querySelector('#modalCard').textContent.includes('修改为候选实现')"));
  await shot('t4c-stale-source-comment');
  await click('准备修改任务');
  await until("document.querySelector('#modalCard .review-task')?.dataset.step==='select'&&document.querySelector('.review-summary-body')?.textContent.includes('修改为候选实现')",'task selection after adoption');
  const staleTask=await read("(()=>{const t=document.querySelector('#modalCard .review-task');const c=t.querySelector('input[data-comment-id]');const p=[...t.querySelectorAll('button')].find(b=>b.textContent==='预览修改任务');return{checkbox:Boolean(c),disabled:c?.disabled,previewDisabled:p?.disabled,text:t.textContent,body:t.querySelector('.review-summary-body')?.textContent||''}})()");
  check('stale adopted comment is retained but cannot become a new task',staleTask.checkbox&&staleTask.disabled===true&&staleTask.previewDisabled===true&&staleTask.body.includes('修改为候选实现'));
  await click('返回审查意见','.review-task');
  await click('关闭','.review-task');
  await read("document.querySelector('#btnChangesReview').click()");
  await until("document.querySelector('#modalCard .review-item')",'stale review summary before second comment');
  await click('准备修改任务');
  await until("document.querySelector('#modalCard .review-task input[data-comment-id]')&&document.querySelector('.review-summary-body')?.textContent.includes('修改为候选实现')",'stale task visible before second comment');
  await click('返回审查意见','.review-task');
  await until("document.querySelector('#modalCard .review-item button.danger')",'stale comment delete control');
  await read("document.querySelector('#modalCard .review-item button.danger').click()");
  await until("document.querySelector('#modalCard .review-summary-empty')",'stale comment deleted');
  await click('关闭','.review-task');
  await read("document.querySelector('.chg-main').click()");
  await until("!!document.querySelector('.d-row[data-line-type=add] .d-gutter')",'source Diff reopened for second comment');
  await read("document.querySelector('.d-row[data-line-type=add] .d-gutter').click()");
  await until("!!document.querySelector('.d-review-editor textarea')",'new comment editor');
  await read("(()=>{const t=document.querySelector('.d-review-editor textarea');t.value='第二次有效意见';t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.d-review-editor .btn.primary').click();return true})()");
  await until("!!document.querySelector('.d-row.has-comment')&&!document.querySelector('.d-review-editor')",'second valid comment');
  await read("document.querySelector('.chg-main').click()");
 }
  await read("document.querySelector('#btnChangesReview').click()");await click('准备修改任务');await click('预览修改任务');
  const secondTask=await read("(()=>{const t=document.querySelector('.review-task textarea');return t?.value||''})()");
  if(process.env.T4C_APPLY_ADOPTION==='1')check('second task is built only from the fresh valid comment',secondTask.includes('第二次有效意见')&&!secondTask.includes('修改为候选实现'));
  await click('在隔离工作区生成修改');await until("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent==='确认创建并执行')",'second preflight');await click('确认创建并执行');await until("[...document.querySelectorAll('.candidate-flow button')].some(b=>b.textContent==='停止候选执行')&&document.querySelector('.candidate-flow').textContent.includes('执行中')",'second run');
 // The UI can show running just before prompt transport is acknowledged. This
 // case tests active execution Stop; stopping before dispatch is separately safe.
 for(let i=0;i<200;i++){if(fs.readFileSync(path.join(world,'trace.jsonl'),'utf8').split('"prompt"').length===3)break;if(i===199)throw Error('second prompt not dispatched');await sleep(50);}
 await click('停止候选执行','.candidate-flow');await until("document.querySelector('.candidate-flow')?.textContent.includes('已停止')",'authoritative Stop');
 check('Stop retains both registered candidate directories',fs.readdirSync(path.join(data,'worktrees',fs.readdirSync(path.join(data,'worktrees'))[0])).length===2);
 if(process.env.T4C_APPLY_ADOPTION==='1')check('adopted source remains after later candidate runs and index is unchanged',fs.readFileSync(path.join(repo,'src/app.js'),'utf8')==='export const value = 3;\n'&&originalIndex.equals(fs.readFileSync(path.join(repo,'.git/index'))));
 else check('all candidate runs leave source bytes and index unchanged',original.equals(fs.readFileSync(path.join(repo,'src/app.js')))&&originalIndex.equals(fs.readFileSync(path.join(repo,'.git/index'))));
 check('two explicit confirmations produce two candidate prompts without retry',fs.readFileSync(path.join(world,'trace.jsonl'),'utf8').split('"prompt"').length===3);
 await stopBackend();fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({checks,failed:0,skip:0,sandbox:true,screenshots:shots,electron:process.versions.electron},null,2));
}
main().catch(e=>{console.error(e);fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({checks,failed:1,error:e.message,screenshots:shots},null,2));process.exitCode=1;}).finally(async()=>{try{await runtimeHost?.stop();await legacyHost?.stop();}catch{}browser?.dispose?.();win?.destroy();if(backend?.exitCode===null)backend.kill();await sleep(500);app.exit(process.exitCode||0);});
