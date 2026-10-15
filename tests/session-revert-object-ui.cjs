const assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
(async()=>{
 let checks=0;const ok=(name,value)=>{assert.ok(value,name);checks++;console.log('  ok  '+name);};
 const dom=new JSDOM('<body><main id="host"></main><button id="return">返回</button></body>',{url:'http://localhost/'});
 global.document=dom.window.document;global.window=dom.window;global.CustomEvent=dom.window.CustomEvent;
 let api={};try{api=await import('../public/session-revert-object-ui.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 ok('restricted UI controller exists',typeof api.createObjectRevertUI==='function');
 let context={conversationId:'A',owner:{workspaceId:'w',workspaceEpoch:'e',workspaceFingerprint:'fp',runtimeGeneration:1}},eligible=false,pending=null,preparePending=null,applyPending=null,exportPending=null,applyResult={ok:true,state:'applied_verified',durable:true,backupAvailable:true,objectMaintained:true},backupReady=true,expires=Date.now()+60000,recoveryObject='object',preparedOverrides={},exportsCreated=0;
 const calls=[];const identity={providerId:'windows-original-object-v1',fileId:'file',objectId:'object',riskNoticeVersion:3};
 const transport={qualification:async b=>{calls.push(['qualification',b]);if(pending)return new Promise(r=>pending=r);return {ok:true,eligible,reason:'production_allowlist_empty',...identity};},
 prepare:async b=>{calls.push(['prepare',b]);if(preparePending)return new Promise(r=>preparePending=r);return {ok:true,...identity,scope:{conversationId:context.conversationId,...context.owner},planId:'plan',expiresAt:expires,backupReady,currentBytes:10,candidateBytes:8,diff:'--- C\n+++ R\n@@ -1 +1 @@\n-current\n+candidate',token:'PRIVATE_TOKEN',helperPath:'PRIVATE_HELPER',...preparedOverrides};},
 apply:async b=>{calls.push(['apply',b]);if(applyPending)return new Promise(r=>applyPending=r);return applyResult;},cancel:async b=>{calls.push(['cancel',b]);return {ok:true};},
 inspectRecovery:async b=>{calls.push(['inspectRecovery',b]);return {ok:true,state:'recovery_required',durable:false,availableMaterials:['C','R'],materialAvailable:true,recoveryEligible:true,revision:7,diff:'--- D\n+++ C',currentBytes:6,candidateBytes:10};},
 prepareRecovery:async b=>{calls.push(['prepareRecovery',b]);return {ok:true,...identity,scope:{conversationId:context.conversationId,...context.owner},objectId:recoveryObject,planId:'recovery',expiresAt:Date.now()+60000,backupReady,currentBytes:6,candidateBytes:10,diff:'--- D\n+++ C'};},
 exportMaterial:async b=>{calls.push(['exportMaterial',b]);if(exportPending)return new Promise(r=>exportPending=r);return {ok:false,code:'material_unavailable'};}};
 const tick=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};
 const host=document.querySelector('#host'),select=()=>ui.select({relativePath:'A.txt',evidenceIds:['ev'],evidenceRevision:3},host);
 const ui=api.createObjectRevertUI({context:()=>context,isCurrent:()=>true,transport});
 const action=name=>document.querySelector(`[data-object-action="${name}"]`);
 const modal=()=>document.querySelector('[data-object-modal]');
 const fill=()=>{for(const b of document.querySelectorAll('[data-object-risk]')){b.checked=true;b.dispatchEvent(new dom.window.Event('change'));}};
 select();await tick();ok('production backend denies restricted action despite candidate',action('prepare').disabled&&host.textContent.includes('正式产品'));
 eligible=true;select();await tick();ok('only explicit backend qualification enables prepare',!action('prepare').disabled);
 action('prepare').click();await tick();ok('prepare opens four fresh unchecked confirmations',modal()&&document.querySelectorAll('[data-object-risk]').length===4&&[...document.querySelectorAll('[data-object-risk]')].every(x=>!x.checked));
 ok('cancel receives initial focus, apply is disabled',document.activeElement===action('cancel')&&action('confirm').disabled);
 [...modal().querySelectorAll('button,input')].find(x=>!x.disabled).focus();document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));ok('Shift Tab wraps within modal excluding disabled confirm',document.activeElement===action('cancel'));
 ok('private token and helper never enter DOM',!document.body.textContent.includes('PRIVATE_')&&!document.body.innerHTML.includes('PRIVATE_'));
 document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();ok('Enter with unchecked risks never submits',!calls.some(x=>x[0]==='apply'));
 document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();ok('Escape cancels without apply and returns focus',!modal()&&!calls.some(x=>x[0]==='apply')&&document.activeElement===action('prepare'));
 action('prepare').click();await tick();fill();action('confirm').click();action('confirm')?.click();await tick();
 ok('double confirm sends exactly one apply',calls.filter(x=>x[0]==='apply').length===1);
 const body=calls.find(x=>x[0]==='apply')[1];ok('apply binds plan provider file object request and all four risks',body.planId==='plan'&&body.fileId==='file'&&body.objectId==='object'&&body.riskNoticeVersion===3&&typeof body.requestId==='string'&&Object.values(body.confirmation).every(x=>x===true)&&Object.keys(body.confirmation).length===4);
 ok('verified completion displays durability and object result',host.querySelector('[data-object-status="applied_verified"]')&&host.textContent.includes('持久记录')&&host.textContent.includes('文件对象'));
 select();await tick();action('prepare').click();await tick();fill();context={...context,owner:{...context.owner,runtimeGeneration:2}};action('confirm').click();await tick();ok('generation switch rejects cached modal before apply',calls.filter(x=>x[0]==='apply').length===1&&!modal());
 select();await tick();action('prepare').click();await tick();fill();ui.invalidate();ok('evidence invalidation closes modal and clears confirmation',!modal());
 preparePending=true;select();await tick();action('prepare').click();await tick();const finish=preparePending;preparePending=null;select();await tick();finish({ok:true,...identity,planId:'old',expiresAt:Date.now()+60000,backupReady:true});await tick();ok('late old selection prepare cannot open modal',!modal());
 expires=Date.now()-1;action('prepare').click();await tick();ok('already expired plan cannot open confirmation',!modal());expires=Date.now()+60000;
 backupReady=false;action('prepare').click();await tick();ok('unverified backup blocks confirmation',!modal());backupReady=true;
 for(const override of [{scope:undefined},{riskNoticeVersion:2},{fileId:'other-file'},{scope:{conversationId:'A',...context.owner,workspaceFingerprint:'other'}}]){
  preparedOverrides=override;action('prepare').click();await tick();ok('invalid prepared binding '+Object.keys(override).join(','),!modal());
 }preparedOverrides={};
 for(const field of ['conversationId','workspaceId','workspaceEpoch','workspaceFingerprint']){
  select();await tick();action('prepare').click();await tick();fill();const snapshot=context,countBefore=calls.filter(x=>x[0]==='apply').length;
  context=field==='conversationId'?{...context,conversationId:'B'}:{...context,owner:{...context.owner,[field]:'changed'}};action('confirm').click();await tick();
  ok('changed '+field+' rejects old confirm',!modal()&&calls.filter(x=>x[0]==='apply').length===countBefore);context=snapshot;
 }
 select();await tick();expires=Date.now()+120;action('prepare').click();await tick();await new Promise(r=>setTimeout(r,230));ok('live TTL expiry removes confirmation',!modal());expires=Date.now()+60000;
 pending=true;select();await tick();const finishQualification=pending;pending=null;context={...context,conversationId:'B'};finishQualification({ok:true,eligible:true,...identity});await tick();ok('late qualification cannot enable stale session button',action('prepare').disabled);context={...context,conversationId:'A'};select();await tick();
 applyResult={ok:false,code:'stale_current'};action('prepare').click();await tick();fill();action('confirm').click();await tick();ok('backend stale closes and clears risks',!modal()&&host.textContent.includes('重新'));
 const before=calls.filter(x=>x[0]==='apply').length;document.dispatchEvent(new dom.window.CustomEvent('pi-gui:approval-history'));document.dispatchEvent(new dom.window.CustomEvent('pi-gui:sse-replay'));await tick();ok('SSE and Approval replay cannot trigger apply',calls.filter(x=>x[0]==='apply').length===before);
 for(const [name,result] of [['missing durability',{ok:true,state:'applied_verified'}],['null durability',{ok:true,state:'applied_verified',durable:null}],['contradictory failed verification',{ok:false,state:'applied_verified',durable:true}]]){
  select();await tick();applyResult=result;action('prepare').click();await tick();fill();action('confirm').click();await tick();
  ok(name+' is recovery required without verified success claim',host.querySelector('[data-object-status="recovery_required"]')&&!host.textContent.includes('本次操作已完成验证'));
 }
 select();await tick();applyResult={ok:true,completion:'UNKNOWN_COMPLETION',durable:true};action('prepare').click();await tick();fill();action('confirm').click();await tick();ok('unknown completion is not applied with no verified claim',host.querySelector('[data-object-status="not_applied"]')&&!host.textContent.includes('本次操作已完成验证'));
 select();await tick();applyResult={ok:false,state:'not_applied',durable:false,code:'stale_current'};action('prepare').click();await tick();fill();action('confirm').click();await tick();ok('not applied incomplete durability is explicitly displayed',host.textContent.includes('durable:false')&&host.textContent.includes('持久记录'));
 for(const [code,text] of [['material_unavailable','备份材料不可读取'],['journal_corrupt','持久记录损坏'],['workspace_invalid','工作区已失效'],['backup_invalid','备份校验失败']]){
  select();await tick();preparedOverrides={ok:false,code};const beforeRefusal=calls.filter(x=>x[0]==='apply').length;action('prepare').click();await tick();
  ok('safe prepare refusal '+code+' has readable reason and no native submission',!modal()&&host.textContent.includes(text)&&calls.filter(x=>x[0]==='apply').length===beforeRefusal);
 }preparedOverrides={};
 select();await tick();applyResult={ok:false,state:'recovery_required',durable:false,planId:'plan'};action('prepare').click();await tick();fill();action('confirm').click();await tick();ok('uncertain native result opens dedicated recovery without retry',host.querySelector('[data-object-status="recovery_required"]')&&!host.textContent.includes('重试'));
 const count=calls.filter(x=>x[0]==='apply').length;await tick();ok('uncertain result never auto retries',calls.filter(x=>x[0]==='apply').length===count);
 action('inspect').click();await tick();ok('inspection is read only and enables explicit new recovery plan',action('prepare-recovery')&&!calls.some(x=>x[0]==='prepareRecovery'));
 ok('only verified available C and R export actions are advertised',[...host.querySelectorAll('[data-object-action="export"]')].map(x=>x.textContent).join(',').includes(' R ')&&![...host.querySelectorAll('[data-object-action="export"]')].some(x=>x.textContent.includes(' D ')));
 backupReady=false;action('prepare-recovery').click();await tick();ok('new D backup must be ready before recovery confirmation',!modal());backupReady=true;
 recoveryObject='different-object';action('prepare-recovery').click();await tick();ok('recovery preparation cannot change target object binding',!modal());recoveryObject='object';
 action('prepare-recovery').click();await tick();ok('new recovery plan has fresh independent unchecked risks',modal()&&[...document.querySelectorAll('[data-object-risk]')].every(x=>!x.checked));action('cancel').click();await tick();
 ok('new recovery preparation carries current evidence revision',calls.filter(x=>x[0]==='prepareRecovery').at(-1)[1].evidenceRevision===7);
 const oldCreate=URL.createObjectURL;URL.createObjectURL=()=>{exportsCreated++;return 'blob:verified';};exportPending=true;action('export').click();await tick();const finishExport=exportPending;exportPending=null;ui.invalidate();finishExport({ok:true,verified:true,bytes:[1,2,3]});await tick();ok('stale export result cannot create a download',exportsCreated===0);URL.createObjectURL=oldCreate;
 const record={...identity,planId:'persisted',relativePath:'A.txt',completion:'recovery_required',durable:true};const applyBeforeHistory=calls.filter(x=>x[0]==='apply').length;
 ui.openRecovery(record,host);await tick();ok('reopening persistent record displays recovery with no automatic apply or modal',!modal()&&calls.filter(x=>x[0]==='apply').length===applyBeforeHistory&&host.querySelector('[data-object-status="recovery_required"]'));
 const originalInspection=transport.inspectRecovery;
 for(const recoveryEligible of [false,undefined]){
  transport.inspectRecovery=async b=>({...await originalInspection(b),recoveryAvailable:true,recoveryEligible});
  ui.openRecovery(record,host);action('inspect').click();await tick();
  ok('material availability cannot grant recovery eligibility '+String(recoveryEligible),action('prepare-recovery').disabled);
 }
 transport.inspectRecovery=originalInspection;
 ui.openRecovery({...record,riskNoticeVersion:2},host);action('inspect').click();await tick();ok('legacy risk record remains read only even backend offers recovery',action('prepare-recovery').disabled);
 ui.dispose();ok('closing controller removes all confirmation UI',!modal());dom.window.close();
 console.log(`Object revert UI: ${checks}/${checks}; failed=0; skipped=0 (DI interaction only)`);
})().catch(e=>{console.error(e);process.exit(1);});
