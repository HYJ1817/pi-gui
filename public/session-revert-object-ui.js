/* Only explicit user interaction can submit a qualified, newly prepared plan.
 * Transport is supplied by the panel. No preload/global/environment discovery. */
import { diffHtml, bindDiffToggles } from './diff.js';

const RISK_VERSION=3;
const RISKS=[
 ['externalWritersPaused','我已暂停外部写入；程序只能尝试停止已知任务，不能保证停止所有外部程序。'],
 ['lastCheckRaceAccepted','我接受最后一次检查后，文件仍可能被外部进程修改的风险。'],
 ['partialOverwriteAccepted','我接受原位写入不是原子操作，中断可能留下部分覆盖；结果不确定时必须另建恢复方案，不能自动重试。'],
 ['metadataLimitsAccepted','我理解备份只保存已读取的正文，不能恢复未保存的编辑器缓冲，也不能保证恢复 SACL、ADS、EA 和其他元数据完整历史。'],
];
const REASONS={production_allowlist_empty:'正式产品尚未开放此受限恢复。',object_provider_disabled:'正式产品尚未开放此受限恢复。',
 stale_current:'文件已变化，请重新预览。',stale_generation:'运行环境已变化，请重新打开。',stale_workspace:'工作区已变化，请重新打开。',
 stale_runtime:'会话已变化，请重新打开。',stale_evidence:'证据已变化，请重新预览。',expired_plan:'计划已过期，请重新准备。',
 object_plan_expired:'计划已过期，请重新准备。',plan_expired:'计划已过期，请重新准备。',risk_version_unsupported:'此记录使用旧风险版本，只能只读检查。',
 backup_invalid:'持久备份校验失败。',evidence_integrity_failed:'修改证据校验失败。',evidence_storage_failed:'修改证据未完整保存。',
 backup_unavailable:'持久备份尚未验证就绪。',material_unavailable:'已验证备份材料不可读取。',
 journal_corrupt:'持久记录损坏，仅允许只读检查可验证材料。',workspace_invalid:'当前工作区已失效。',diff_budget_exceeded:'差异超过预览范围。',
 incomplete_evidence:'完整对象证据不足。',attribution_gap:'存在归因缺口，不能执行。',active_writer:'仍有写入任务运行。'};
const reason=code=>REASONS[code] || '当前操作被拒绝，请重新查看资格。';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const note=(host,text)=>{const p=el('p','session-change-note',text);p.setAttribute('role','status');host.append(p);return p;};
const btn=(name,text,fn)=>{const b=el('button','btn',text);b.type='button';b.dataset.objectAction=name;b.onclick=fn;return b;};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(x);
const signature=context=>JSON.stringify(context);
const wire=context=>({conversationId:context.conversationId,...(context.owner?{owner:{...context.owner}}:{})});

export function createObjectRevertUI({context,isCurrent,transport}) {
 let alive=true,revision=0,selected=null,qualification=null,host=null,overlay=null,plan=null,source=null,submitted=false,timer=null,trigger=null;
 const fresh=(r,key)=>alive&&isCurrent()&&r===revision&&key===signature(context());
 const binding=p=>({providerId:p.providerId,fileId:p.fileId,objectId:p.objectId,riskNoticeVersion:p.riskNoticeVersion});
 const validBinding=p=>p?.riskNoticeVersion===RISK_VERSION&&id(p.providerId)&&id(p.fileId)&&typeof p.objectId==='string'&&p.objectId.length>0&&p.objectId.length<512;
 const identity=()=>({...wire(context()),evidenceIds:[...(selected?.evidenceIds || [])],evidenceRevision:selected?.evidenceRevision});
 const scopeMatches=scope=>{if(!scope)return false;const c=context(),o=c.owner || c.workspace || c;
  return ['conversationId','workspaceId','workspaceEpoch','workspaceFingerprint','runtimeGeneration'].every(k=>scope[k]!==undefined&&scope[k]===(k==='conversationId'?c.conversationId:o[k]??c[k]));};
 async function request(method,body){try{return await transport[method](body);}catch{return {ok:false,code:'request_uncertain'};}}
 function closeModal(cancel=true) {
  if(!overlay)return;
  const old=plan;clearInterval(timer);timer=null;document.removeEventListener('keydown',keyHandler,true);overlay.remove();overlay=null;plan=null;
  if(cancel&&old&&!submitted)void request('cancel',{...wire(context()),...binding(old),planId:old.planId});
  if(trigger?.isConnected)trigger.focus();
 }
 function invalidate(){revision++;qualification=null;closeModal();if(host)host.querySelectorAll('[data-object-action]').forEach(b=>b.disabled=true);}
 function drawDiff(target,p){
  if(p.diffUnavailable){note(target,reason(p.diffUnavailable));return;}
  if(typeof p.diff!=='string'||p.diff.length>262144){note(target,'未提供可预览的差异。');return;}
  const box=el('div','chg-diff-inner object-revert-diff');box.innerHTML=diffHtml(p.diff);const root=box.querySelector('.diff');if(root)bindDiffToggles(root);target.append(box);
 }
 function info(target,p,recovery=false){
  const c=context(),o=c.owner || c.workspace || c;
  note(target,`会话：${c.conversationId} · Workspace：${o.workspaceId || '未知'}`);
  target.append(el('div','session-change-path',selected?.relativePath || p.relativePath || '单文件'));
  note(target,`Provider：${p.providerId}（受限） · ${recovery?'D → C':'C → R'}，仅修改本文件正文。`);
  note(target,`当前：${Number.isSafeInteger(p.currentBytes)?p.currentBytes:'未知'} 字节 · 候选：${Number.isSafeInteger(p.candidateBytes)?p.candidateBytes:'未知'} 字节`);
  note(target,`持久备份：${p.backupReady===true?'已验证就绪':'未验证'} · 计划过期：${new Date(p.expiresAt).toLocaleString()}`);
  drawDiff(target,p);
 }
 function keyHandler(event){
  if(!overlay)return;
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeModal();return;}
  if(event.key==='Enter'&&event.target?.tagName!=='BUTTON'){event.preventDefault();return;}
  if(event.key==='Tab'){
   const nodes=[...overlay.querySelectorAll('button,input')].filter(n=>!n.disabled),first=nodes[0],last=nodes.at(-1);
   if(event.shiftKey&&(document.activeElement===first||!overlay.contains(document.activeElement))){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&(document.activeElement===last||!overlay.contains(document.activeElement))){event.preventDefault();first?.focus();}
  }
 }
 function openConfirmation(p,r,key,recovery=false){
  if(!fresh(r,key))return;
  if(!p.ok||!id(p.planId)||!validBinding(p)||p.backupReady!==true||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=Date.now()||!scopeMatches(p.scope)
    ||p.diffUnavailable||!recovery&&(!qualification||p.providerId!==qualification.providerId||p.fileId!==qualification.fileId||p.objectId!==qualification.objectId)
    ||recovery&&(!source||source.riskNoticeVersion!==RISK_VERSION||p.providerId!==source.providerId||p.fileId!==source.fileId||p.objectId!==source.objectId)){
   note(host,reason(p.code || (p.expiresAt<=Date.now()?'expired_plan':p.diffUnavailable || 'backup_unavailable')));return;
  }
  closeModal();plan={planId:p.planId,...binding(p),expiresAt:p.expiresAt};submitted=false;
  overlay=el('div','modal object-revert-modal');overlay.dataset.objectModal='';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-labelledby','object-revert-title');
  const card=el('div','modal-card'),title=el('h3','',recovery?'重新备份 D 后恢复原始 C':'备份后恢复该文件（受限）');title.id='object-revert-title';
  const content=el('div','object-revert-body'),actions=el('div','modal-actions');card.append(title,content,actions);overlay.append(card);document.body.append(overlay);
  info(content,p,recovery);
  const boxes=[];const cancel=btn('cancel','取消',()=>closeModal()),confirm=btn('confirm',recovery?'确认本次 D → C 恢复':'确认本次 C → R 恢复',()=>void submit(r,key));
  const update=()=>confirm.disabled=submitted||!boxes.every(x=>x.checked);
  for(const [name,text] of RISKS){const label=el('label','object-revert-risk'),box=el('input');box.type='checkbox';box.dataset.objectRisk=name;box.checked=false;box.onchange=update;label.append(box,el('span','',text));boxes.push(box);content.append(label);}
  confirm.disabled=true;actions.append(cancel,confirm);document.addEventListener('keydown',keyHandler,true);cancel.focus();
  timer=setInterval(()=>{if(!fresh(r,key)||Date.now()>=p.expiresAt){closeModal();if(fresh(r,key))note(host,reason('expired_plan'));}},100);
 }
 async function submit(r,key){
  if(submitted||!overlay)return;
  if(!fresh(r,key)||!plan||plan.expiresAt<=Date.now()){closeModal();return;}
  const boxes=[...overlay.querySelectorAll('[data-object-risk]')];if(boxes.length!==4||boxes.some(x=>!x.checked))return;
  const activePlan={...plan},confirmation=Object.fromEntries(boxes.map(x=>[x.dataset.objectRisk,true]));submitted=true;
  if(trigger?.isConnected)trigger.disabled=true;
  overlay.querySelectorAll('input,[data-object-action="confirm"]').forEach(x=>x.disabled=true);
  const requestId=crypto.randomUUID().replaceAll('-','');
  const result=await request('apply',{...wire(context()),...binding(activePlan),planId:activePlan.planId,requestId,confirmation});
  if(!fresh(r,key))return;closeModal(false);
  qualification=null;host.replaceChildren();
  const state=result.state || result.completion;
  const verified=state==='applied_verified'&&result.ok===true&&result.durable===true;
  if(state==='recovery_required'||state==='applied_verified'&&!verified||result.code==='request_uncertain'){source={...activePlan};drawRecovery(result,r,key);return;}
  const status=el('div','object-revert-result');status.dataset.objectStatus=verified?'applied_verified':'not_applied';host.append(status);
  if(verified){
   note(status,'本次操作已完成验证；当前文件内容已按候选校验。验证仅代表本次完成时的结果。');
   note(status,`计划：${activePlan.planId} · 后端状态：applied_verified · 持久记录：${result.durable===true?'已保存':'未完成（durable:false）'}`);
   note(status,`备份：${result.backupAvailable===true||result.backupReady===true?'可用':'未知'} · 文件对象：${result.objectMaintained===true?'保持检查通过':'检查结果未知'}`);
  }else {note(status,reason(result.code));if(result.durable===false)note(status,'持久记录未完成（durable:false）；当前状态为 not_applied，请检查记录和可验证材料。');}
 }
 function drawRecovery(result,r,key){
  host.replaceChildren();const view=el('div','object-revert-result');view.dataset.objectStatus='recovery_required';host.append(view);
  note(view,'需要单独恢复检查：文件可能已部分覆盖，不能自动再次提交。');
  note(view,`后端状态：recovery_required · 持久记录：${result.durable===true?'已保存':'未完成（durable:false）'}`);
  const inspect=btn('inspect','查看恢复方案',async()=>{
   inspect.disabled=true;const report=await request('inspectRecovery',{...wire(context()),...binding(source),sourcePlanId:source.planId});
   if(!fresh(r,key))return;inspect.disabled=false;
   const details=el('div','object-revert-recovery');view.querySelector('.object-revert-recovery')?.remove();view.append(details);
   if(!report.ok){note(details,reason(report.code));return;}
   note(details,'只读检查不证明历史写入成功，也不授权写回。新方案须先重新观察并持久备份当前 D。');drawDiff(details,report);
   for(const material of ['C','R','D'].filter(m=>report.availableMaterials?.includes(m)))details.append(btn('export',`导出已验证 ${material} 到新位置`,()=>void exportMaterial(material,r,key,details)));
   const prepare=btn('prepare-recovery','备份当前 D 后创建 D → C 恢复方案',async()=>{
    prepare.disabled=true;const p=await request('prepareRecovery',{...wire(context()),...binding(source),sourcePlanId:source.planId,evidenceRevision:report.revision});
    if(!fresh(r,key))return;prepare.disabled=false;trigger=prepare;openConfirmation(p,r,key,true);
   });prepare.disabled=source.riskNoticeVersion!==RISK_VERSION||report.recoveryEligible!==true;details.append(prepare);
  });view.append(inspect);
 }
 async function exportMaterial(material,r,key,target){
  const report=await request('exportMaterial',{...wire(context()),...binding(source),sourcePlanId:source.planId,material});
  if(!fresh(r,key))return;
  if(!report.ok||report.verified!==true||!Array.isArray(report.bytes)||report.bytes.length>2097152||report.bytes.some(x=>!Number.isInteger(x)||x<0||x>255)){note(target,reason(report.code || 'material_unavailable'));return;}
  const url=URL.createObjectURL(new Blob([new Uint8Array(report.bytes)],{type:'application/octet-stream'}));
  const a=el('a');a.download=`verified-${material}-${source.planId}.bin`;a.href=url;document.body.append(a);
  if(fresh(r,key))a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);note(target,'已导出到新位置；没有向当前项目文件写回。');
 }
 function select(file,target){
  invalidate();selected={...file,evidenceIds:[...(file.evidenceIds || [])]};host=target;host.replaceChildren();source=null;const r=revision,key=signature(context());
  const action=btn('prepare','备份后恢复该文件（受限）',async()=>{
   if(!fresh(r,key)||!qualification?.eligible)return;action.disabled=true;trigger=action;
   const p=await request('prepare',{...identity(),...binding(qualification)});
   if(!fresh(r,key))return;action.disabled=false;openConfirmation(p,r,key);
  });action.disabled=true;host.append(action);const status=note(host,'正在读取后端恢复资格…');
  void (async()=>{const q=await request('qualification',identity());if(!fresh(r,key))return;
   qualification=q.ok&&q.eligible===true&&validBinding(q)?q:null;
   action.disabled=!qualification;status.textContent=qualification?'后端已通过本次资格检查；准备后仍须独立确认风险。':reason(q.reason || q.code);
  })();
 }
 function dispose(){invalidate();alive=false;host=null;selected=null;source=null;}
 function openRecovery(record,target){
  invalidate();host=target;selected={relativePath:record.relativePath};host.replaceChildren();
  if(!id(record.planId)||!id(record.providerId)||!id(record.fileId)||typeof record.objectId!=='string'){note(host,'此历史记录仅可查看状态，恢复材料不可用。');return;}
  source={planId:record.planId,...binding(record)};drawRecovery(record,revision,signature(context()));
 }
 return {select,openRecovery,invalidate,dispose};
}
