import { S } from './state.js';
import { collabDocumentAction, gitConversationScope } from './api.js';
import { runtimeStore, onRuntimeChange } from './runtime-state.js';
import { workspaceView } from './ui/workspace-surface.js';
import { openSecondarySurface } from './ui/secondary-surface.js';
import { createPaneHeader } from './right-pane.js';
import { mountCollabCanvas } from './collab-canvas.js';
import { mountCollabProductivity } from './collab-canvas-productivity.js';
import { mountCollabProposal } from './collab-proposal.js';
import { confirmModal, confirmSurfaceMeta, dismissConfirm } from './ui/modal.js';

const node=(tag,className,text)=>{const domNode=document.createElement(tag);if(className)domNode.className=className;if(text!==undefined)domNode.textContent=text;return domNode;};
function context() {
  const conversationId=gitConversationScope(),view=workspaceView();
  const record=conversationId?runtimeStore.get(conversationId):null;
  const owner=conversationId?record?.owner:S.legacyOwner;
  const headers={...(conversationId?{'X-Pi-Gui-Conversation':conversationId}:{}),'X-Pi-Gui-Owner':JSON.stringify(owner??null)};
  return {valid:Boolean(owner?.sessionId && !S.switching && (view==='chat'&&!conversationId || view==='runtime'&&conversationId&&record?.item?.lifecycle==='ready')),headers,
    signature:JSON.stringify([S.workspaceGeneration,S.cwd,conversationId?null:S.bridgeRun,view,conversationId,headers])};
}

export function openCollabPanel() {
  return openSecondarySurface('collab',mountCollabPanel,{label:'协同文档',headerSelector:'.collab-head',triggerId:'btnCollab'});
}

/* Only this adapter holds the current server snapshot. Canvas emits intents;
 * request failures preserve that snapshot, and context changes synchronously
 * remove it before any pending response can repaint or enable a new owner. */
export function mountCollabPanel(host,view) {
  const captured=context();
  const head=createPaneHeader({title:'协同文档',subtitle:'结构化流程图 · 自动保存到应用数据目录'}).el;head.classList.add('collab-head');
  const body=node('div','collab-panel-body'),status=node('p','collab-panel-status','正在读取文档…');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const controls=node('div','collab-panel-actions'),create=node('button','','新建流程图'),reload=node('button','','重新打开');
  create.type=reload.type='button';create.hidden=true;reload.hidden=true;controls.append(create,reload);
  const canvasHost=node('div','collab-canvas-host'),productivityHost=node('div','collab-productivity-host'),proposalHost=node('div','collab-proposal-host');
  const source=node('p','collab-panel-source','Agent 建议来源尚未接入；当前支持用户编辑与保存。');
  body.append(status,controls,canvasHost,productivityHost,proposalHost,source);host.append(head,body);
  let alive=true,invalid=false,busy=false,sequence=0,snapshot=null,canvas=null,productivity=null,proposal=null;
  const confirmationOwner=crypto.randomUUID();
  const dismissOwnedConfirmation=()=>{if(confirmSurfaceMeta()?.collabSurface===confirmationOwner)dismissConfirm();};
  const current=()=>alive && !invalid && view.isCurrent() && context().valid && context().signature===captured.signature;
  const closeEditor=id=>{if(id)void collabDocumentAction({action:'close',editorId:id},captured.headers);};
  /* 导出结果提示合成：adapter 在 onExport 之后还会发「导出完成」通知，
   * 面板把下载去向并入同一条状态，避免下载提示被立即覆盖。 */
  let downloadPending=null,downloadFailed=null;
  const productivityNotice=notice=>{
    if(!alive)return;
    let text=notice.message;
    if(notice.level!=='error'&&(downloadPending||downloadFailed)&&notice.message.includes('导出完成')){
      if(downloadPending){text=`${notice.message} 已开始下载 ${downloadPending}。`;downloadPending=null;}
      else{text=`${notice.message}（${downloadFailed}）`;downloadFailed=null;}
    }
    status.textContent=text;
  };
  /* Canvas and productivity toolbar speak the same intent dialect; one shared
   * completion path adds the envelope and submits through the guarded request
   * channel — Owner/CAS authority stays entirely server-side. */
  const submitIntents=intents=>{
    if(!current()||busy||!snapshot?.document)return;
    const baseRevision=snapshot.document.revision;
    const ops=intents.map(intent=>({opId:crypto.randomUUID(),type:intent.type,params:intent.params,baseRevision,actor:'user'}));
    void request('operations',{ops});
  };
  const downloadExport=result=>{
    const doc=snapshot?.document;
    const safe=(doc?.title||doc?.documentId||'flowchart').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'-').slice(0,60)||'flowchart';
    const name=`${safe}-r${doc?.revision??0}.${result.format==='png'?'png':'svg'}`;
    try{
      const anchor=document.createElement('a');anchor.download=name;
      if(result.format==='png'&&result.image?.dataUrl){anchor.href=result.image.dataUrl;}
      else{
        if(typeof URL?.createObjectURL!=='function'){downloadFailed='当前环境不支持文件下载';return;}
        anchor.href=URL.createObjectURL(new Blob([result.svg],{type:'image/svg+xml;charset=utf-8'}));
        anchor.addEventListener('click',()=>URL.revokeObjectURL(anchor.href),{once:true});
      }
      document.body.append(anchor);anchor.click();anchor.remove();
      downloadPending=name;
    }catch{downloadFailed='导出下载失败，请重试';}
  };
  function render(error='') {
    const doc=snapshot?.document;
    status.textContent=error || (busy?'正在保存…':doc?`版本 ${doc.revision} · 已保存`:'当前会话还没有协同文档。');
    create.hidden=Boolean(doc)||!snapshot;create.disabled=busy||!current();reload.disabled=busy;
    if(!doc)return;
    if(!canvas)canvas=mountCollabCanvas(canvasHost,{document:doc,onOperations:intents=>{
      submitIntents(intents);
    },onUndo:()=>void request('undo'),onRedo:()=>void request('redo'),confirmDelete:message=>confirmModal({title:'删除图形',message,okText:'删除',danger:true,
      surface:'collab-delete',meta:{collabSurface:confirmationOwner}})});
    canvas.update({document:doc,readOnly:!current(),busy,error,canUndo:!!snapshot.canUndo,canRedo:!!snapshot.canRedo});
    if(!productivity)productivity=mountCollabProductivity(productivityHost,{document:doc,
      onOperations:submitIntents,
      onExport:downloadExport,
      onNotice:productivityNotice});
    productivity.update({document:doc,readOnly:!current(),busy});
    if(!proposal)proposal=mountCollabProposal(proposalHost,{onAccept:proposalId=>void request('accept',{proposalId}),onReject:proposalId=>void request('reject',{proposalId}),
      onRegenerate:()=>{if(current())status.textContent='可信 Agent 建议来源尚未接入。';}});
    proposal.update({document:doc,proposal:snapshot.proposal??null,preview:snapshot.preview??null,busy,error,readOnly:!current()});
  }
  async function request(action,extra={}) {
    if(!current()||busy)return;
    const requestSequence=++sequence;
    const payload=action==='open'?{action}:{action,editorId:snapshot?.editorId,expectedRevision:snapshot?.document?.revision??null,...extra};
    busy=true;render();
    const result=await collabDocumentAction(payload,captured.headers);
    if(!current()||requestSequence!==sequence){if(action==='open'&&result?.ok)closeEditor(result.editorId);return;}
    busy=false;
    if(!result?.ok) {
      reload.hidden=false;
      const conflict=['collab_conflict','collab_editor_expired','collab_scope_unavailable'].includes(result?.code);
      if(conflict){canvas?.update({readOnly:true,canUndo:false,canRedo:false});reload.hidden=false;invalid=true;}
      render(result?.network?'保存结果尚未确认，请重新打开核对文档。':result?.error||'文档操作失败。');
      // Unknown network outcomes must not allow history retries against a
      // potentially committed revision. Reopen obtains a fresh authority.
      if(result?.network){invalid=true;reload.hidden=false;canvas?.update({readOnly:true,canUndo:false,canRedo:false});}
      return;
    }
    snapshot=result;render();
  }
  function invalidate(event) {
    const hardBoundary=['pi-gui:session-switch','pi-gui:workspace-generation'].includes(event?.type);
    if(!alive||!hardBoundary&&context().signature===captured.signature && context().valid)return;
    invalid=true;sequence++;closeEditor(snapshot?.editorId);snapshot=null;busy=false;
    dismissOwnedConfirmation();
    canvas?.destroy();productivity?.destroy();proposal?.destroy();canvas=productivity=proposal=null;
    canvasHost.replaceChildren();productivityHost.replaceChildren();proposalHost.replaceChildren();
    create.hidden=true;reload.hidden=false;
    status.textContent='会话或工作区已变化，旧编辑器已失效。请重新打开。';
  }
  create.onclick=()=>void request('create');reload.onclick=()=>{if(alive)openCollabPanel();};
  const events=['pi-gui:workspace-generation','pi-gui:session-switch','pi-gui:git-scope','pi-gui:workspace-view','pi-gui:session-evidence-context'];
  for(const event of events)document.addEventListener(event,invalidate);
  const offRuntime=onRuntimeChange(invalidate);
  view.onDispose(()=>{
    alive=false;sequence++;closeEditor(snapshot?.editorId);snapshot=null;
    dismissOwnedConfirmation();
    offRuntime();for(const event of events)document.removeEventListener(event,invalidate);
    canvas?.destroy();productivity?.destroy();proposal?.destroy();create.onclick=reload.onclick=null;
  });
  if(captured.valid)void request('open');
  else {invalid=true;status.textContent='请先打开一个已就绪的会话。';reload.hidden=false;}
}
