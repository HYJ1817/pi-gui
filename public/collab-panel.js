import { S } from './state.js';
import { collabDocumentAction, gitConversationScope } from './api.js';
import { runtimeStore, onRuntimeChange } from './runtime-state.js';
import { workspaceView } from './ui/workspace-surface.js';
import { openSecondarySurface } from './ui/secondary-surface.js';
import { createPaneHeader } from './right-pane.js';
import { mountCollabCanvas } from './collab-canvas.js';
import { mountCollabProposal } from './collab-proposal.js';
import { confirmModal, confirmSurfaceMeta, dismissConfirm } from './ui/modal.js';

const node=(tag,className,text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
function context() {
  const conversationId=gitConversationScope(),view=workspaceView();
  const record=conversationId?runtimeStore.get(conversationId):null;
  const owner=conversationId?record?.owner:S.legacyOwner;
  const headers={...(conversationId?{'X-Pi-Gui-Conversation':conversationId}:{}),'X-Pi-Gui-Owner':JSON.stringify(owner??null)};
  return {valid:Boolean(owner?.sessionId && !S.switching && (view==='chat'&&!conversationId || view==='runtime'&&conversationId&&record?.item?.lifecycle==='ready')),headers,
    signature:JSON.stringify([S.workspaceGeneration,S.cwd,S.bridgeRun,view,conversationId,headers])};
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
  const canvasHost=node('div','collab-canvas-host'),proposalHost=node('div','collab-proposal-host');
  const source=node('p','collab-panel-source','Agent 建议来源尚未接入；当前支持用户编辑与保存。');
  body.append(status,controls,canvasHost,proposalHost,source);host.append(head,body);
  let alive=true,invalid=false,busy=false,sequence=0,snapshot=null,canvas=null,proposal=null;
  const confirmationOwner=crypto.randomUUID();
  const dismissOwnedConfirmation=()=>{if(confirmSurfaceMeta()?.collabSurface===confirmationOwner)dismissConfirm();};
  const current=()=>alive && !invalid && view.isCurrent() && context().valid && context().signature===captured.signature;
  const closeEditor=id=>{if(id)void collabDocumentAction({action:'close',editorId:id},captured.headers);};
  function render(error='') {
    const doc=snapshot?.document;
    status.textContent=error || (busy?'正在保存…':doc?`版本 ${doc.revision} · 已保存`:'当前会话还没有协同文档。');
    create.hidden=Boolean(doc)||!snapshot;create.disabled=busy||!current();reload.disabled=busy;
    if(!doc)return;
    if(!canvas)canvas=mountCollabCanvas(canvasHost,{document:doc,onOperations:intents=>{
      if(!current()||busy||!snapshot?.document)return;
      const baseRevision=snapshot.document.revision;
      const ops=intents.map(intent=>({opId:crypto.randomUUID(),type:intent.type,params:intent.params,baseRevision,actor:'user'}));
      void request('operations',{ops});
    },onUndo:()=>void request('undo'),onRedo:()=>void request('redo'),confirmDelete:message=>confirmModal({title:'删除图形',message,okText:'删除',danger:true,
      surface:'collab-delete',meta:{collabSurface:confirmationOwner}})});
    canvas.update({document:doc,readOnly:!current(),busy,error,canUndo:!!snapshot.canUndo,canRedo:!!snapshot.canRedo});
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
    canvas?.destroy();proposal?.destroy();canvas=proposal=null;
    canvasHost.replaceChildren();proposalHost.replaceChildren();create.hidden=true;reload.hidden=false;
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
    canvas?.destroy();proposal?.destroy();create.onclick=reload.onclick=null;
  });
  if(captured.valid)void request('open');
  else {invalid=true;status.textContent='请先打开一个已就绪的会话。';reload.hidden=false;}
}
