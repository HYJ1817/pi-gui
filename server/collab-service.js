import { randomUUID } from 'node:crypto';
import { createFlowchartDocument, bindSession, createEditorState, applyUserOperations,
  commitOperations, undo, redo, previewProposalReadonly, acceptProposal, rejectProposal } from '../lib/collab-doc.js';

const fail = code => { throw Object.assign(Error(code), { code }); };
const clone = value => JSON.parse(JSON.stringify(value));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k));

export const COLLAB_MESSAGES = Object.freeze({
  collab_invalid: '协同文档请求无效。',
  collab_conflict: '文档已被修改，请重新打开查看最新版本。当前修改未提交。',
  collab_scope_unavailable: '会话或工作区已变化，请重新打开协同文档。',
  collab_editor_expired: '编辑器已关闭或过期，请重新打开。',
  collab_proposal_unavailable: '尚无来自可信 Agent 来源的建议。',
  collab_storage_busy: '文档存储被锁定。若刚发生异常退出，需关闭所有 Pi GUI 后由维护者检查遗留锁；不会自动删除锁或覆盖文档。',
  collab_storage_unsafe: '存储身份发生变化，已停止写入。',
  collab_storage_inside_project: '应用数据目录不能位于项目中。',
  collab_storage_corrupt: '文档文件损坏，已保留原文件并停止写入。',
  collab_storage_limit: '文档存储已达到容量限制。',
  collab_storage_unavailable: '文档存储暂时不可用。',
  collab_storage_write_failed: '文档保存失败，当前内容未提交。',
  collab_undo_empty: '没有可撤销的操作。',
  collab_redo_empty: '没有可重做的操作。',
});

const invalidResult = result => ({ ok: false, code: result.code === 'stale-base' ? 'collab_conflict'
  : result.code === 'undo-empty' ? 'collab_undo_empty' : result.code === 'redo-empty' ? 'collab_redo_empty' : 'collab_invalid',
  ...(result.conflict ? { conflict: result.conflict } : {}) });

/* The store is the document authority. Editor histories are ephemeral, scoped
 * capabilities: clone before edits, publish only after a durable CAS succeeds.
 * proposals is a backend-only source adapter; production deliberately leaves it
 * null until RPC provenance is qualified. HTTP can only name a known proposal. */
export function createCollabService({ store, proposals = null, now = () => Date.now() } = {}) {
  const editors = new Map();
  const maxEditors = 32, ttl = 30 * 60 * 1000;
  const prune = () => {
    for (const [key,entry] of editors) if (now() - entry.seen > ttl) editors.delete(key);
    while (editors.size >= maxEditors) editors.delete(editors.keys().next().value);
  };
  function snapshot(entry, doc) {
    const document = doc ? clone({ documentId:doc.documentId,schemaVersion:doc.schemaVersion,revision:doc.revision,
      title:doc.title,boundSessionId:doc.boundSessionId,graph:doc.graph }) : null;
    return { ok:true,editorId:entry.id,document,canUndo:entry.history.undoStack.length>0,
      canRedo:entry.history.redoStack.length>0,proposalSourceAvailable:Boolean(proposals) };
  }
  function execute(scope, request) {
    scope.assertCurrent();
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail('collab_invalid');
    const { action } = request;
    if (action === 'open') {
      if (!exact(request,['action'])) fail('collab_invalid');
      const { doc } = store.read(scope);
      if (doc && doc.boundSessionId !== scope.sessionId) fail('collab_scope_unavailable');
      prune();
      const entry = { id:randomUUID(),key:scope.key,token:scope.token,revision:doc?.revision??null,seen:now(),history:createEditorState() };
      editors.set(entry.id,entry);
      return snapshot(entry,doc);
    }
    if (!id(request.editorId)) fail('collab_invalid');
    const entry = editors.get(request.editorId);
    if (!entry || now()-entry.seen>ttl) { editors.delete(request.editorId); fail('collab_editor_expired'); }
    if (entry.key!==scope.key || entry.token!==scope.token) fail('collab_scope_unavailable');
    entry.seen=now();
    editors.delete(entry.id);editors.set(entry.id,entry); // bounded LRU, after authority matches only
    if (action==='close') {
      if (!exact(request,['action','editorId'])) fail('collab_invalid');
      editors.delete(entry.id); return {ok:true};
    }
    const keys=['action','editorId','expectedRevision'];
    if (action==='operations') keys.push('ops');
    if (['preview','accept','reject'].includes(action)) keys.push('proposalId');
    if (!['create','operations','undo','redo','preview','accept','reject'].includes(action) || !exact(request,keys)
      || !(request.expectedRevision===null || revision(request.expectedRevision))) fail('collab_invalid');
    const {doc}=store.read(scope);
    if (doc && doc.boundSessionId!==scope.sessionId) fail('collab_scope_unavailable');
    let userResult;
    if(action==='operations') {
      if(!doc || !Array.isArray(request.ops) || request.ops.some(op=>op?.baseRevision!==request.expectedRevision)) fail('collab_invalid');
      userResult=applyUserOperations(doc,request.ops);
      if(userResult.ok && userResult.status==='duplicate' && entry.revision===doc.revision) return {...snapshot(entry,doc),status:'duplicate'};
    }
    if (entry.revision!==(doc?.revision??null)) {
      entry.history=createEditorState(); fail('collab_conflict');
    }
    if ((doc?.revision??null)!==request.expectedRevision) fail('collab_conflict');
    if (action==='create') {
      if (doc) fail('collab_conflict');
      // Initial template is constructed here, never supplied by Renderer.
      const seeded=createFlowchartDocument({documentId:'diagram',title:'流程图'});
      const next=bindSession({...seeded,revision:1,appliedOps:[]},scope.sessionId);
      scope.assertCurrent(); const stored=store.write(scope,null,next).doc;
      entry.revision=stored.revision;return snapshot(entry,stored);
    }
    if (!doc) fail('collab_invalid');
    const history=clone(entry.history);
    let result;
    if (action==='operations') {
      result=userResult;
      if (result.ok && result.status!=='duplicate') result=commitOperations(doc,history,request.ops);
    } else if (action==='undo') result=undo(doc,history);
    else if (action==='redo') result=redo(doc,history);
    else {
      if (!id(request.proposalId) || !proposals) fail('collab_proposal_unavailable');
      const evidence=proposals.get(scope,request.proposalId);
      if (!evidence || evidence.scopeToken!==scope.token) fail('collab_proposal_unavailable');
      if(action==='preview') {
        const preview=previewProposalReadonly(doc,evidence.proposal);
        return preview.ok ? {...snapshot(entry,doc),proposal:clone(evidence.proposal),preview:preview.preview} : invalidResult(preview);
      }
      result=action==='accept' ? acceptProposal(doc,history,evidence.proposal,{expectedRevision:request.expectedRevision}) : rejectProposal(doc,evidence.proposal);
    }
    if (!result.ok) return invalidResult(result);
    if (result.status==='duplicate' || result.status==='rejected') return {...snapshot(entry,doc),status:result.status};
    scope.assertCurrent();
    const stored=store.write(scope,doc.revision,result.doc).doc;
    entry.history=history;entry.revision=stored.revision;
    return snapshot(entry,stored);
  }
  return {execute};
}
