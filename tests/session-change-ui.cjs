const assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
(async()=>{
  let checks=0;const ok=(name,value)=>{assert.ok(value,name);checks++;console.log('  ok  '+name);};
  const dom=new JSDOM(fs.readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8'),{url:'http://localhost/'});
  global.document=dom.window.document;global.window=dom.window;global.localStorage=dom.window.localStorage;global.CustomEvent=dom.window.CustomEvent;
  const {configureSecondaryPane}=await import('../public/ui/secondary-surface.js');
  let kind;const listeners=[];configureSecondaryPane({root:document.querySelector('#rightPane'),open(v){kind=v;for(const f of listeners)f(v);},close(){kind=null;for(const f of listeners)f(null);},onSurfaceChange:f=>listeners.push(f)});
  let api={};try{api=await import('../public/session-changes-panel.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
  ok('read-only session panel exists',typeof api.openSessionChangesPanel==='function');
  let context={conversationId:'A',owner:{runtimeGeneration:'a',workspaceId:'w',workspaceEpoch:'e'}},queryPending,previewPending,exportPending,failCode,empty=false,historyEmpty=false,previewResult,queryExtra={};
  const requests=[];
  const file={relativePath:'A.txt',operationType:'modified',operationCount:2,evidenceIds:['a1','a2'],evidenceLevel:'intent_verified',previewEligible:true,historyAvailable:true};
  const summary=()=>({ok:true,owner:context.owner,target:{conversationId:context.conversationId},capture:{enabled:true},operationCount:2,fileCount:1,evidenceComplete:true,attributionGap:false,expired:false,previewEligible:true,revision:3,files:empty?[]:[{...file,relativePath:context.conversationId+'.txt'}],...queryExtra});
  const transport={query:async body=>{requests.push({type:'query',body});if(queryPending)return new Promise(r=>queryPending=r);return failCode?{ok:false,code:failCode}:summary();},
    preview:async body=>{requests.push({type:'preview',body});if(previewPending)return new Promise(r=>previewPending=r);return previewResult||{ok:true,files:[{relativePath:file.relativePath,status:'candidate',contentEligible:true,limited:{applyEligible:false},diff:'--- current\n+++ candidate\n@@ -1,1 +1,1 @@\n-agent\n+user\n'}]};},
    history:async body=>{requests.push({type:'history',body});return {ok:true,plans:historyEmpty?[]:[{planId:'plan',createdAt:1,completion:'recovery_required',state:'recovery_required',files:[{fileId:'f',relativePath:'A.txt',state:'not_applied',backupAvailable:true}]}]};},
    export:async (body,isCurrent)=>{requests.push({type:'export',body});if(exportPending)return new Promise(r=>exportPending=()=>r({ok:isCurrent()}));return {ok:true};}};
  const tick=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
  const button=text=>[...document.querySelectorAll('#rightPane button')].find(b=>b.textContent===text);
  const panel=api.openSessionChangesPanel({context:()=>context,transport});await tick();
  ok('session list uses distinct right surface',kind==='session-changes');
  ok('file rows and captured counts displayed',document.querySelector('#rightPane').textContent.includes('A.txt')&&document.querySelector('#rightPane').textContent.includes('2 项操作'));
  ok('opening summary does not request content',requests.every(r=>r.type==='query'));
  button('查看撤销预览').click();await tick();
  ok('explicit single-file diff includes confirmed IDs revision owner mode',requests.at(-1).body.includeDiff===true&&requests.at(-1).body.mode==='confirmed_limited'&&requests.at(-1).body.evidenceRevision===3&&requests.at(-1).body.evidenceIds.length===2);
  ok('candidate states read-only eligibility and renders diff',document.querySelector('.diff')&&document.querySelector('#rightPane').textContent.includes('实际恢复未开放'));
  ok('diff does not enter localStorage',!JSON.stringify(localStorage).includes('agent'));
  document.dispatchEvent(new dom.window.CustomEvent('pi-gui:session-evidence-changed',{detail:{workspaceId:'other',workspaceEpoch:'e'}}));
  ok('unrelated worktree event leaves current candidate alone',document.querySelector('.diff'));
  document.dispatchEvent(new dom.window.CustomEvent('pi-gui:session-evidence-changed',{detail:{workspaceId:'w',workspaceEpoch:'e'}}));
  ok('same-owner evidence change invalidates rendered candidate',!document.querySelector('.diff')&&document.querySelector('#rightPane').textContent.includes('重新预览'));
  button('刷新').click();await tick();
  for(const code of ['overlapping_changes','attribution_gap','expired_evidence','incomplete_evidence']){
    previewResult={ok:true,files:[{relativePath:'A.txt',contentEligible:false,reason:code}]};button('查看撤销预览').click();await tick();
    ok('refused '+code+' displays safe reason and no success diff',!document.querySelector('.diff')&&document.querySelector('#rightPane').textContent.includes(api.sessionRevertReason(code)));
  }
  previewResult={ok:false,code:'stale_current'};button('查看撤销预览').click();await tick();ok('changed current file requires repreview',document.querySelector('#rightPane').textContent.includes('文件已变化'));
  previewResult={ok:true,files:[{relativePath:'A.txt',contentEligible:true,diffUnavailable:'diff_budget_exceeded'}]};button('查看撤销预览').click();await tick();ok('oversized diff is refused without truncated body',!document.querySelector('.diff')&&document.querySelector('#rightPane').textContent.includes('未返回正文'));
  previewResult=null;
  previewPending=true;button('查看撤销预览').click();await tick();
  context={conversationId:'B',owner:{runtimeGeneration:'b'}};panel.contextChanged();await tick();
  previewPending({ok:true,files:[{contentEligible:true,diff:'PRIVATE_OLD_A'}]});previewPending=null;await tick();
  ok('late prior preview discarded after session switch',!document.querySelector('#rightPane').textContent.includes('PRIVATE_OLD_A')&&document.querySelector('#rightPane').textContent.includes('B.txt'));
  queryPending=true;button('刷新').click();await tick();const resolveOld=queryPending;queryPending=null;
  context={conversationId:'C',owner:null,workspace:{workspaceId:'w',workspaceEpoch:'e'}};panel.contextChanged();await tick();resolveOld({ok:true,files:[{relativePath:'OLD_A'}]});await tick();
  ok('late old summary cannot overwrite dormant current session',!document.querySelector('#rightPane').textContent.includes('OLD_A'));
  document.dispatchEvent(new dom.window.CustomEvent('pi-gui:session-evidence-changed',{detail:{workspaceId:'w',workspaceEpoch:'e'}}));
  ok('dormant preview invalidates on shared-workspace classic writes',document.querySelector('#rightPane').textContent.includes('重新预览'));
  button('历史恢复材料').click();await tick();
  ok('history list shows incomplete prior state',document.querySelector('#rightPane').textContent.includes('需要人工检查')&&document.querySelector('#rightPane').textContent.includes('尚未应用'));
  ok('no automatic export on history open',!requests.some(r=>r.type==='export'));
  button('导出备份').click();await tick();ok('user export names existing single-file material',requests.at(-1).type==='export'&&requests.at(-1).body.sourcePlanId==='plan'&&requests.at(-1).body.fileId==='f');
  exportPending=true;button('导出备份').click();await tick();button('比较备份').click();await tick();exportPending();exportPending=null;await tick();
  ok('concurrent backup comparison does not strand export or cancel authorized download',!button('导出备份').disabled&&document.querySelector('#rightPane').textContent.includes('备份已导出'));
  historyEmpty=true;button('刷新').click();await tick();ok('no history is explicit empty state',document.querySelector('#rightPane').textContent.includes('没有历史恢复材料'));
  button('会话变更').click();empty=true;await tick();button('刷新').click();await tick();
  ok('no evidence never claims no file modified',document.querySelector('#rightPane').textContent.includes('不代表文件没有被修改'));
  failCode='PRIVATE_C:\\secret';button('刷新').click();await tick();ok('unknown backend error remains generic',!document.querySelector('#rightPane').textContent.includes('PRIVATE_'));
  failCode=null;queryExtra={capture:{enabled:false}};button('刷新').click();await tick();ok('capture disabled explicit UI state',document.querySelector('#rightPane').textContent.includes('未启用修改捕获'));
  ok('read-only actions never call prepare apply stop or git restore',requests.every(r=>['query','preview','history','export'].includes(r.type)));
  panel.dispose();dom.window.close();console.log(`Session change UI: ${checks}/${checks}; failed=0; skipped=0`);
})().catch(e=>{console.error(e);process.exitCode=1;});
