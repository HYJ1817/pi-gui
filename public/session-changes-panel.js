/* Journal projection with a separately qualified, default-off object action. */
import { S } from './state.js';
import { runtimeStore, onRuntimeChange } from './runtime-state.js';
import { gitConversationScope, fetchSessionEvidence, previewSessionRevert,
  previewSessionRevertRecovery, downloadSessionRevertBackup } from './api.js';
import { openSecondarySurface } from './ui/secondary-surface.js';
import { diffHtml, bindDiffToggles } from './diff.js';
import { createObjectRevertUI } from './session-revert-object-ui.js';
import { objectRevertTransport } from './session-revert-object-api.js';
import { createPaneHeader } from './right-pane.js';

const REASONS = {
  overlapping_changes:'当前内容与拟撤销区域冲突。', ambiguous_mapping:'无法唯一确定修改位置。',
  attribution_gap:'存在无法完整归因的文件操作。', incomplete_evidence:'修改证据不完整。',
  expired_evidence:'证据已超过预览有效期。', stale_evidence:'证据已更新，请刷新后重新预览。',
  stale_current:'文件已变化，需要重新预览。', stale_runtime:'会话运行环境已变化，请刷新。',
  stale_generation:'会话运行环境已变化，请刷新。', stale_workspace:'工作区身份已变化，请刷新。',
  unsupported_text:'暂不支持该文件内容。', metadata_unsupported:'文件元数据尚不满足实际恢复条件。',
  metadata_audit_unavailable:'文件元数据安全验证尚未完成。', already_reverted:'当前内容已与待恢复结果一致。',
  active_writer:'工作区仍有 Agent 在运行；结束后可重新预览。', no_evidence:'没有已捕获的修改证据。',
  evidence_not_found:'没有找到此会话的修改证据。', diff_budget_exceeded:'差异超过预览范围，未返回正文。',
  budget_exceeded:'证据数量超过单次预览范围。', oversized:'文件超过内容预览大小限制。',
  unsupported_path:'该文件不在支持的预览范围内。', cross_session_conflict:'与其他会话的操作存在冲突。',
  unproven_continuity:'无法证明连续操作之间的内容关系。', current_missing:'当前文件不存在。',
  recovery_unavailable:'此文件没有可用的历史备份。', preview_busy:'预览服务忙，请稍后重试。',
  evidence_initializing:'会话证据正在初始化，请稍后刷新。',
};
export const sessionRevertReason = code => REASONS[code] || '当前无法读取此项，请刷新后重试。';
const LEVELS={intent_verified:'意图已验证',exclusive_verified:'独占已验证',observed:'仅观察',incomplete:'不完整',unsupported:'不支持'};
const STATES={applied_verified:'已验证应用',recovery_required:'需要人工检查',not_applied:'尚未应用',prepared:'已准备',completed:'已完成',partial:'部分完成',cancelled:'已取消',refused:'已拒绝'};
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const button=(text,fn)=>{const e=node('button','btn',text);e.type='button';e.onclick=fn;return e;};
/* 状态标记：颜色只是辅助，文字本身已经把状态说清楚（不靠颜色单独表意）。 */
const chip=(text,tone)=>{const e=node('span','rp-chip',text);if(tone)e.dataset.tone=tone;return e;};
/* 空态是一个明确的「这里现在没有东西」区块，而不是一行看起来像出错的提示。 */
function emptyState(title,text){const box=node('div','rp-empty');box.append(node('p','rp-empty-title',title),node('p','rp-empty-text',text));return box;}
const fingerprint=value=>JSON.stringify(value);
function defaultContext() {
  const id=gitConversationScope();
  if(id){const r=runtimeStore.get(id);return {conversationId:id,owner:r?.owner?{...r.owner}:null,
    workspace:r?.item?.workspace,nativeSessionId:r?.item?.nativeSessionId};}
  return {conversationId:'classic-chat',owner:S.legacyOwner?{...S.legacyOwner}:null,
    generation:S.workspaceGeneration,bridgeRun:S.bridgeRun,bridgeState:S.bridgeState,sessionId:S.state?.sessionId};
}
const wire=context=>({conversationId:context.conversationId,...(context.owner?{owner:context.owner}:{})});

export function openSessionChangesPanel({context=defaultContext,transport,objectTransport}={}) {
  const api=transport || {query:fetchSessionEvidence,preview:previewSessionRevert,history:previewSessionRevertRecovery,export:downloadSessionRevertBackup};
  let alive=true,serial=0,viewGeneration=0,signature=fingerprint(context()),tab='changes',summary=null;
  let head,body,notice,instance;
  const objectAPI=objectTransport || objectRevertTransport;
  const objectContext=()=>({...context(),...(summary?.target?.workspaceFingerprint?{workspaceFingerprint:summary.target.workspaceFingerprint}:{})});
  const objectUI=createObjectRevertUI({context:objectContext,isCurrent:()=>alive&&Boolean(instance?.isCurrent()),transport:objectAPI});
  const current=(token,key)=>alive&&instance.isCurrent()&&token===serial&&key===fingerprint(context());
  /* tone: 'info' | 'warn' | 'error' | undefined。只有真正会变的状态才带 role=status，
   * 否则每段说明都去打断读屏。 */
  function hint(text,host=body,tone){const p=node('p','session-change-note',text);if(tone){p.dataset.tone=tone;p.setAttribute('role','status');}host.append(p);return p;}
  function clear(){objectUI.invalidate();serial++;viewGeneration++;summary=null;body.replaceChildren();body.removeAttribute('aria-busy');}
  function evidenceChanged(){if(!alive)return;clear();hint('文件或修改证据可能已变化，请刷新后重新预览。',body,'warn');}
  function drawDiff(host,file) {
    if(file.diffUnavailable){hint(sessionRevertReason(file.diffUnavailable),host);return;}
    if(typeof file.diff!=='string'){hint('未提供正文差异。',host);return;}
    if(!file.diff){hint('当前内容与候选一致。',host);return;}
    const box=node('div','chg-diff-inner');box.innerHTML=diffHtml(file.diff);
    const root=box.querySelector('.diff');if(root)bindDiffToggles(root);host.append(box);
  }
  async function preview(file,host,trigger) {
    objectUI.invalidate();
    const token=++serial,key=fingerprint(context()),identity={conversationId:summary?.target?.conversationId || context().conversationId,
      ...(summary?.owner?{owner:summary.owner}:{})},revision=summary?.revision;
    // Only one bounded body at a time. Re-opening computes current C again.
    for(const old of body.querySelectorAll('.session-change-preview'))old.replaceChildren();
    trigger.disabled=true;host.replaceChildren();hint('正在计算只读候选…',host,'info');
    const result=await api.preview({...identity,evidenceIds:file.evidenceIds,evidenceRevision:revision,mode:'confirmed_limited',includeDiff:true});
    if(alive&&key===fingerprint(context())&&trigger.isConnected)trigger.disabled=false;
    if(!current(token,key))return;
    trigger.disabled=false;host.replaceChildren();
    if(!result.ok){hint(sessionRevertReason(result.code),host);return;}
    const candidate=result.files?.find(f=>f.relativePath===file.relativePath);
    if(!candidate){hint('未提供此文件的预览结果。',host);return;}
    if(!candidate.contentEligible){hint(sessionRevertReason(candidate.reason),host);return;}
    hint(candidate.status==='already_reverted'?sessionRevertReason('already_reverted'):'可以计算内容候选；实际恢复未开放。',host);
    hint('差异显示当前 C → 候选 R：移除的是拟撤销内容，新增的是拟恢复内容；后续独立修改仅在算法能够证明时保留。',host);
    hint('候选仅反映本次读取；后续编辑需要重新预览，外部写入未被排除。',host);
    drawDiff(host,candidate);
    const objectHost=node('div','session-object-action');host.append(objectHost);
    objectUI.select({...file,evidenceRevision:revision},objectHost);
  }
  function drawSummary(result) {
    summary=result;
    /* 概览分层：一行真实的计数（数量级）+ 一排状态标记（能不能预览、证据全不全）。
     * 数字仍然来自后端的 fileCount/operationCount，不自己数列表长度。 */
    const card=node('section','session-change-summary');card.setAttribute('aria-label','本会话修改概览');
    card.append(node('p','session-change-summary-count',`${result.fileCount} 个已捕获文件 · ${result.operationCount} 项操作`));
    const chips=node('div','rp-chips');
    chips.append(
      chip(`证据${result.operationCount===0?'为空':result.evidenceComplete?'完整':'不完整'}`,result.evidenceComplete?'ok':'warn'),
      chip(`归因缺口${result.attributionGap?'存在':'未记录'}`,result.attributionGap?'warn':undefined),
      chip(`证据过期${result.expired?'存在':'未记录'}`,result.expired?'warn':undefined),
      chip(result.previewEligible?'内容预览可请求':'内容预览暂不具备资格',result.previewEligible?'ok':'muted'));
    card.append(chips);
    body.append(card);
    hint('捕获仅覆盖已接管的 write/edit；shell、MCP 和外部编辑器不属于完整捕获范围。');
    if(!result.capture?.enabled)hint('此会话当前未启用修改捕获；旧证据如存在仍可查看。',body,'warn');
    if(result.activeWriter)hint(sessionRevertReason('active_writer'),body,'warn');
    if(!result.files?.length){
      /* 空态不得读成「文件没被改过」—— 没证据不等于没改动，这句话必须原样保留。 */
      body.append(emptyState('没有已捕获的修改证据','没有已捕获的修改证据；这不代表文件没有被修改。'));
      if(result.nextCursor)body.append(button('下一页',()=>void load(result.nextCursor)));
      return;
    }
    const list=node('div','session-change-list');body.append(list);
    for(const file of result.files || []) {
      const row=node('article','session-change-row');list.append(row);
      const head=node('div','session-change-info');
      const mark=node('span','session-change-mark',file.operationType==='created'?'A':'M');
      /* 字母是给速度看的重复编码，语义由下面那行文字提供 —— 读屏不必念两遍。 */
      mark.setAttribute('aria-hidden','true');
      mark.dataset.operation=file.operationType==='created'?'created':'modified';
      const pathEl=node('div','session-change-path',file.relativePath);
      /* 单行省略时仍能看到完整路径（长路径是这类面板的常态）。 */
      pathEl.title=file.relativePath;
      const level=LEVELS[file.evidenceLevel] || '未知';
      const meta=node('p','session-change-meta',`${file.operationType==='created'?'创建':'修改'} · ${file.operationCount} 项操作 · ${level} · 尚未预览`);
      const nameBox=node('div','session-change-name');nameBox.append(pathEl,meta);
      head.append(mark,nameBox);
      row.append(head);
      hint(file.historyAvailable?'已有历史恢复材料':'未记录可用历史备份',row);
      if(file.reason)hint(sessionRevertReason(file.reason),row,'warn');
      if(file.evidenceIds?.length) {
        const target=node('div','session-change-preview');
        /* 动作按钮仍是 .session-change-row 的直接子元素（既有验收脚本按这个结构取它）。 */
        const action=button('查看撤销预览',()=>void preview(file,target,action));action.classList.add('rp-row-action');
        row.append(action,target);
      }
    }
    if(result.nextCursor)body.append(button('下一页',()=>void load(result.nextCursor)));
  }
  async function compare(plan,file,host,trigger) {
    objectUI.invalidate();
    const token=++serial,key=fingerprint(context());
    for(const old of body.querySelectorAll('.session-change-preview'))old.replaceChildren();
    trigger.disabled=true;hint('正在比较历史备份…',host);
    const result=await api.history({...wire(context()),sourcePlanId:plan.planId,selectedFileIds:[file.fileId],includeDiff:true});
    if(alive&&key===fingerprint(context())&&trigger.isConnected)trigger.disabled=false;
    if(!current(token,key))return;trigger.disabled=false;host.replaceChildren();
    if(!result.ok){hint(sessionRevertReason(result.code),host);return;}
    const comparison=result.files?.[0];if(!comparison){hint('没有可用的比较结果。',host);return;}
    const matches={preimage:'当前内容与历史备份一致',candidate:'当前内容与历史候选一致',absent:'当前文件不存在',other:'当前内容与备份、历史候选均不同'};
    hint(matches[comparison.observedMatches] || '比较结果未知',host);
    hint('比较仅表示本次读取的内容；不证明历史恢复成功，也不授权写回。',host);drawDiff(host,comparison);
  }
  function drawHistory(result) {
    if(!result.plans?.length){hint('此会话没有历史恢复材料。');return;}
    hint('以下为已存在的恢复记录；只读查看不创建备份计划。');
    for(const plan of result.plans) {
      const group=node('article','session-change-row');body.append(group);
      const date=Number.isFinite(plan.createdAt)?new Date(plan.createdAt).toLocaleString():'时间未知';
      group.append(node('h4','',date));hint(STATES[plan.completion] || STATES[plan.state] || '历史状态未知',group);
      if(plan.state==='recovery_required'||['partial','recovery_required'].includes(plan.completion))hint('历史记录不完整，需要人工检查；不能据此认定恢复成功。',group);
      for(const file of plan.files || []) {
        const row=node('div','session-change-history-file');group.append(row);
        row.append(node('div','session-change-path',file.relativePath));hint(STATES[file.state] || '历史状态未知',row);
        if(!file.backupAvailable){hint('没有可导出的备份。',row);continue;}
        const target=node('div','session-change-preview'),tools=node('div','session-change-actions');
        const view=button('比较备份',()=>void compare(plan,file,target,view));
        const download=button('导出备份',async()=>{
          const generation=viewGeneration,key=fingerprint(context());download.disabled=true;
          const exportCurrent=()=>alive&&instance.isCurrent()&&generation===viewGeneration&&key===fingerprint(context());
          const result=await api.export({...wire(context()),sourcePlanId:plan.planId,fileId:file.fileId,exportName:'session-backup-'+file.fileId+'.bin'},exportCurrent);
          if(alive&&key===fingerprint(context())&&download.isConnected)download.disabled=false;
          if(!exportCurrent())return;hint(result.ok?'备份已导出。':sessionRevertReason(result.code),target);
        });tools.append(view,download);row.append(tools,target);
      }
    }
  }
  function drawObjectHistory(result) {
    for(const record of result?.ok?result.plans || []:[]) {
      const row=node('article','session-change-row');body.append(row);
      row.append(node('div','session-change-path',record.relativePath || '单文件对象恢复记录'));
      hint(`受限对象恢复 · ${STATES[record.completion] || STATES[record.state] || '历史状态未知'}`,row);
      hint(`计划：${record.planId} · 持久记录：${record.durable===true?'已保存':'未完成或未知'} · 备份：${record.backupReady===true?'已验证可用':'不可确认'}`,row);
      hint('历史记录仅显示状态，不会恢复确认或自动提交。正式产品恢复仍关闭。',row);
      if(record.completion==='recovery_required'||record.state==='recovery_required') {
        const target=node('div','session-change-preview');
        row.append(button('查看对象恢复材料',()=>objectUI.openRecovery(record,target)),target);
      }
    }
  }
  async function load(cursor) {
    clear();const token=serial,key=signature=fingerprint(context()),identity=wire(context());
    body.setAttribute('aria-busy','true');
    const loading=node('div','rp-loading');loading.append(node('span','rp-loading-dot'),node('span','','正在读取…'));body.append(loading);
    const results=tab==='changes'?[await api.query({...identity,limit:25,...(cursor?{cursor}:{})})]:await Promise.all([
      api.history(identity),Promise.resolve().then(()=>objectAPI.history?.(identity)).catch(()=>({ok:false}))]);
    const result=results[0];
    if(!current(token,key))return;body.replaceChildren();body.removeAttribute('aria-busy');
    if(tab==='history'&&results[1]?.ok){
      const target=results[1].target,c=context(),workspace=c.owner || c.workspace;
      if(target?.conversationId===c.conversationId&&target.workspaceId===workspace?.workspaceId&&target.workspaceEpoch===workspace?.workspaceEpoch
        &&typeof target.workspaceFingerprint==='string')summary={target};
    }
    if(!result.ok){hint(sessionRevertReason(result.code),body,'error');if(tab==='history')drawObjectHistory(results[1]);return;}
    if(tab==='changes')drawSummary(result);else {drawHistory(result);drawObjectHistory(results[1]);}
  }
  const contextChanged=()=>{if(alive&&signature!==fingerprint(context()))void load();};
  /* 订阅「同一个会话」的证据变化：
   * Classic 没有 owner 时，事件 detail 里的 workspaceId 就是 undefined（app.js 直接取
   * S.legacyOwner?.workspaceId）。这时两边都没有工作区维度可比，
   * 只能按「同一个会话」算 —— 否则同一个会话里的真实改动不会让旧预览失效。
   * Runtime 帧仍然要求两边的 workspace 身份都真存在（unknownMeansSame 不开）。 */
  const workspaceMatches=(identity,{unknownMeansSame=false}={})=>{
    const active=context(),workspace=active.owner || active.workspace;
    if(!workspace)return unknownMeansSame && active.conversationId==='classic-chat' && !identity?.workspaceId && !identity?.workspaceEpoch;
    return Boolean(identity?.workspaceId&&identity?.workspaceEpoch&&identity.workspaceId===workspace?.workspaceId&&identity.workspaceEpoch===workspace?.workspaceEpoch);
  };
  const offRuntime=onRuntimeChange(frame=>{
    contextChanged();
    if(workspaceMatches(frame?.owner)
      && ['agent_start','tool_execution_start','tool_execution_end','agent_settled'].includes(frame?.event?.type))evidenceChanged();
  });
  const classicEvidenceChanged=event=>{if(workspaceMatches(event.detail||{},{unknownMeansSame:true}))evidenceChanged();};
  const closeForSwitch=()=>{if(alive){clear();hint('会话或工作区正在切换，请重新打开本会话变更。',body,'warn');}};
  for(const name of ['pi-gui:git-scope','pi-gui:session-evidence-context'])document.addEventListener(name,contextChanged);
  for(const name of ['pi-gui:workspace-generation','pi-gui:session-switch'])document.addEventListener(name,closeForSwitch);
  document.addEventListener('pi-gui:session-evidence-changed',classicEvidenceChanged);
  const dispose=()=>{if(!alive)return;objectUI.dispose();alive=false;serial++;summary=null;body?.replaceChildren();offRuntime();
    for(const name of ['pi-gui:git-scope','pi-gui:session-evidence-context'])document.removeEventListener(name,contextChanged);
    for(const name of ['pi-gui:workspace-generation','pi-gui:session-switch'])document.removeEventListener(name,closeForSwitch);
    document.removeEventListener('pi-gui:session-evidence-changed',classicEvidenceChanged);};
  instance=openSecondarySurface('session-changes',(host,view)=>{
    /* 面板外壳与「开发进程」共用 createPaneHeader：标题 + 一行说明 + 工具按钮，
     * 关闭按钮由 ui/secondary-surface.js 追加在本标题带最右端。 */
    const refresh=button('刷新',()=>void load());refresh.classList.add('rp-btn');
    const header=createPaneHeader({title:'本会话变更',subtitle:'只读证据 · 撤销预览',actions:[refresh]});
    head=header.el;host.append(head);
    /* 页签独占第二行：两个中文标签加按钮在 320px 的右栏里放不进标题带。 */
    const bar=node('div','rp-bar');
    const tabs=node('nav','rp-tabs');tabs.setAttribute('aria-label','会话修改材料');
    for(const [label,value] of [['会话变更','changes'],['历史恢复材料','history']]){
      const b=button(label,()=>{tab=value;for(const sibling of tabs.querySelectorAll('[aria-pressed]'))sibling.setAttribute('aria-pressed',String(sibling===b));void load();});
      b.classList.add('rp-tab');
      b.setAttribute('aria-pressed',String(tab===value));tabs.append(b);
    }
    bar.append(tabs);host.append(bar);
    notice=node('p','session-change-note','当前支持查看本会话修改与撤销预览。自动恢复仍需完成安全验证。');
    notice.classList.add('rp-notice');notice.dataset.tone='info';host.append(notice);
    body=node('div','session-change-body rp-scroll');body.setAttribute('aria-live','polite');host.append(body);view.onDispose(dispose);
  },{label:'本会话变更',headerSelector:'.rp-head',triggerId:context().conversationId==='classic-chat'?'btnMore':'runtimeSessionMore'});
  head.querySelector('#rightPaneClose')?.focus();
  void load();return {contextChanged,dispose};
}
