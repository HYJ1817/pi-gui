/* Two steps inside the existing summary modal. Selection is ephemeral. */
import { commentsForScope, currentReviewScope, reviewEvidenceRevision, reviewEvidencePending } from './diff-comments.js';
import { reviewPersistenceState } from './review-comment-persistence.js';
import { createReviewTask, validateReviewTask, reviewTaskEligibility, taskPosition } from './review-task.js';
import { fillReviewComposer } from './review-fill.js';
import { S } from './state.js';
import { workspaceView } from './ui/workspace-surface.js';
import { gitConversationScope } from './api.js';
import { runtimeStore } from './runtime-state.js';

function node(tag, className, text) {
  const element=document.createElement(tag);
  if (className) element.className=className;
  if (text) element.textContent=text;
  return element;
}
function button(text, action) {
  const b=node('button','btn',text); b.type='button'; b.onclick=action; return b;
}

export function mountReviewTaskPreview({card, scope, close, onVisibility}) {
  const root=node('section','review-task'); root.hidden=true; root.dataset.step='select';
  const title=node('h4','','选择需要处理的审查意见');
  const note=node('p','review-summary-note','仅可选择已由当前完整 Diff 确认的位置。过期或待确认意见保留供查看，请返回 Diff 核实。');
  const warning=node('p','review-summary-note','填入输入框本身不会改代码；你之后发送给 Agent 的任务可能在真实工作区执行。文本范围约束不是文件写入权限隔离。');
  const status=node('p','review-summary-status'); status.setAttribute('role','status');
  const counts=node('p','review-task-count'); counts.setAttribute('aria-live','polite');
  const tools=node('div','review-summary-actions');
  const body=node('div','review-summary-body');
  const preview=node('textarea','review-feedback-preview'); preview.readOnly=true; preview.rows=16;
  preview.setAttribute('aria-label','修改任务预览'); preview.hidden=true;
  let disposed=false, mode='select', selectedIds=new Set(), task=null, invalidated=false;
  const context=()=>{
    const conversation=gitConversationScope();
    const record=conversation ? runtimeStore.get(conversation) : null;
    return {scope:currentReviewScope(),project:S.cwd,session:conversation ? `并行会话 ${conversation}` : S.state?.sessionId ? `经典会话 ${S.state.sessionId}` : '',
      worktree:conversation ? record?.item?.workspace?.cwd || S.changes.projectRoot : S.cwd,
      generation:S.workspaceGeneration,view:workspaceView(),owner:conversation ? runtimeStore.get(conversation)?.owner : S.legacyOwner,
      evidence:reviewEvidenceRevision(),evidencePending:reviewEvidencePending(scope),storage:reviewPersistenceState(scope)};
  };
  const active=()=>!disposed && !root.hidden && card.isConnected && scope===currentReviewScope();
  const source=()=>commentsForScope(scope);
  const eligible=c=>!reviewTaskEligibility(c,scope);
  const available=()=>scope===currentReviewScope() && reviewPersistenceState(scope).status==='ready' && !reviewEvidencePending(scope);
  const all=button('全选有效评论',()=>{selectedIds=new Set(source().filter(eligible).map(c=>c.id));drawSelection();});
  const none=button('取消选择',()=>{selectedIds.clear();drawSelection();});
  const back=button('返回审查意见',()=>{
    root.hidden=true; task=null; preview.value=''; onVisibility(false);
  });
  const next=button('预览修改任务',()=>{
    if (!active()) return;
    const result=createReviewTask({comments:source(),selectedIds:[...selectedIds],context:context()});
    if (!result.ok) {status.textContent=result.error;return;}
    task=result; invalidated=false; mode='preview'; root.dataset.step=mode;
    copy.disabled=fill.disabled=false;
    title.textContent='确认修改任务'; body.hidden=true; preview.hidden=false; preview.value=task.text;
    all.hidden=none.hidden=next.hidden=true; copy.hidden=fill.hidden=false;
    back.textContent='返回选择';back.onclick=()=>{mode='select';task=null;drawSelection();next.focus();};
    status.textContent=task.mixedSections ? '已包含暂存区和工作区意见，请分别核对。' : '请核对完整任务；这不是实际代码 Diff。';
    preview.focus();preview.setSelectionRange(0,0);preview.scrollTop=0;
  });
  next.classList.add('primary');
  function ensureFresh() {
    const result=active() && !invalidated ? validateReviewTask(task,{comments:source(),context:context()}) : {ok:false};
    if (!result.ok) {invalidate();return false;}
    return true;
  }
  const copy=button('复制修改任务',async()=>{
    if (!ensureFresh()) return;
    const copied=task;
    try {
      await navigator.clipboard.writeText(copied.text);
      if (!active() || task!==copied || !ensureFresh()) return;
      status.textContent='修改任务已复制；未发送、未执行。';
    } catch {
      if (!ensureFresh()) return;
      status.textContent='复制失败，请手动选择预览文本。'; preview.focus(); preview.select();
    }
  });
  const fill=button('填入当前会话',()=>{
    if (!ensureFresh()) return;
    const result=fillReviewComposer(task.text);
    status.textContent=result.ok ? '已追加到当前会话草稿；不会自动发送。' : result.error;
    if (result.ok) close();
  });
  const done=button('关闭',close);
  tools.append(back,all,none,next,copy,fill,done);
  root.append(title,note,warning,tools,status,counts,body,preview);card.append(root);

  function drawSelection(focusId) {
    const comments=source();
    selectedIds=new Set([...selectedIds].filter(id=>comments.some(c=>c.id===id&&eligible(c))));
    mode='select';root.dataset.step=mode;title.textContent='选择需要处理的审查意见';
    body.hidden=false;preview.hidden=true;preview.value='';task=null;
    all.hidden=none.hidden=next.hidden=false;copy.hidden=fill.hidden=true;
    back.textContent='返回审查意见';back.onclick=()=>{root.hidden=true;onVisibility(false);};
    body.replaceChildren();
    const groups=new Map();
    for(const c of comments) {if(!groups.has(c.path))groups.set(c.path,[]);groups.get(c.path).push(c);}
    for(const [path,items] of groups) {
      const group=node('section','review-file-group');
      const heading=node('label','review-task-file');
      const fileCheck=node('input');fileCheck.type='checkbox';fileCheck.setAttribute('aria-label',`选择文件 ${path} 的有效评论`);
      const ids=items.filter(eligible).map(c=>c.id);
      fileCheck.disabled=!available()||!ids.length;
      fileCheck.checked=ids.length>0&&ids.every(id=>selectedIds.has(id));
      fileCheck.indeterminate=!fileCheck.checked&&ids.some(id=>selectedIds.has(id));
      fileCheck.onchange=()=>{for(const id of ids) {if(fileCheck.checked)selectedIds.add(id);else selectedIds.delete(id);}drawSelection();
        [...body.querySelectorAll('.review-task-file input')].find(box=>box.getAttribute('aria-label')===fileCheck.getAttribute('aria-label'))?.focus();};
      heading.append(fileCheck,node('span','',path));group.append(heading);
      for(const c of items) {
        const item=node('label','review-item review-task-item');
        const checkbox=node('input');checkbox.type='checkbox';checkbox.dataset.commentId=c.id;
        const reason=reviewTaskEligibility(c,scope);
        checkbox.disabled=!available()||Boolean(reason);checkbox.checked=selectedIds.has(c.id);
        checkbox.setAttribute('aria-label',`选择评论 ${path} ${taskPosition(c)}`);
        checkbox.onchange=()=>{if(checkbox.checked)selectedIds.add(c.id);else selectedIds.delete(c.id);drawSelection(c.id);};
        const detail=node('span','review-task-detail');
        detail.append(node('span','review-item-meta',`${c.anchor.section==='staged'?'暂存区':'工作区'} · ${taskPosition(c)} · ${reason || '位置已确认'}`),node('span','review-item-text',c.text));
        item.append(checkbox,detail);group.append(item);
      }
      body.append(group);
    }
    if (!comments.length) body.append(node('p','review-summary-empty','当前作用域还没有评论。'));
    counts.textContent=`已选择 ${selectedIds.size} 条评论，涉及 ${new Set(comments.filter(c=>selectedIds.has(c.id)).map(c=>c.path)).size} 个文件。`;
    all.disabled=none.disabled=!available()||!comments.some(eligible);
    next.disabled=!available()||!selectedIds.size;
    status.textContent=reviewEvidencePending(scope) ? '正在刷新 Diff，请等待后展开文件重新确认位置。'
      : available() ? '' : '当前身份或评论存储不可用，请返回审查意见并重新同步。';
    // Rebuilding labels must not lose keyboard focus after toggling a checkbox.
    if(focusId) [...body.querySelectorAll('input[data-comment-id]')].find(box=>box.dataset.commentId===focusId)?.focus();
  }
  function invalidate() {
    invalidated=true;copy.disabled=fill.disabled=true;preview.value='';
    status.textContent='作用域、评论或 Diff 证据已变化，请返回选择并重新生成任务。';
  }
  function changed(event) {
    if (!active() || event?.detail?.scope && event.detail.scope!==scope) return;
    if(mode==='preview') invalidate();else drawSelection();
  }
  const events=['pi-gui:review-change','pi-gui:review-storage','pi-gui:review-evidence'];
  for(const name of events)document.addEventListener(name,changed);
  return {
    open() {
      if(disposed||scope!==currentReviewScope())return;
      onVisibility(true);root.hidden=false;selectedIds=new Set(source().filter(eligible).map(c=>c.id));
      copy.disabled=fill.disabled=false;drawSelection();next.focus();
    },
    dispose() {disposed=true;task=null;preview.value='';for(const name of events)document.removeEventListener(name,changed);},
  };
}
