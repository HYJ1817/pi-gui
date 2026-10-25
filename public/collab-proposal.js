/* Read-only proposal projection; explicit buttons delegate every decision. */
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const types = new Set(['node.add', 'node.update', 'node.remove', 'edge.add', 'edge.update', 'edge.remove']);

function validProposal(proposal) {
  return proposal && proposal.schemaVersion === 1 && validId(proposal.proposalId) && validId(proposal.documentId) &&
    validId(proposal.sessionId) && Number.isSafeInteger(proposal.baseRevision) && proposal.baseRevision >= 1 &&
    typeof proposal.rationale === 'string' && proposal.rationale.length <= 2000 &&
    Array.isArray(proposal.ops) && proposal.ops.length > 0 && proposal.ops.length <= 50 &&
    new Set(proposal.ops.map(op => op?.opId)).size === proposal.ops.length &&
    proposal.ops.every(op => op && validId(op.opId) && types.has(op.type) && op.actor === 'agent' &&
      op.baseRevision === proposal.baseRevision && op.params && typeof op.params === 'object' && !Array.isArray(op.params));
}

function validPreview(preview, proposal) {
  return preview && Array.isArray(preview.diff) && preview.diff.length === proposal.ops.length &&
    preview.diff.every((entry, index) => entry && entry.opId === proposal.ops[index].opId && entry.type === proposal.ops[index].type &&
      typeof entry.summary === 'string' && entry.summary.length <= 10000) &&
    Number.isSafeInteger(preview.resultingRevision) && preview.resultingRevision === proposal.baseRevision + 1 &&
    Number.isInteger(preview.nodeCount) && preview.nodeCount >= 0 && preview.nodeCount <= 200 &&
    Number.isInteger(preview.edgeCount) && preview.edgeCount >= 0 && preview.edgeCount <= 400;
}

export function mountCollabProposal(host, { onAccept = () => {}, onReject = () => {}, onRegenerate = () => {} } = {}) {
  const dom = host.ownerDocument;
  const root = dom.createElement('section'); root.className = 'collab-proposal'; root.setAttribute('aria-label', 'Agent 建议预览');
  const title = dom.createElement('h3'); title.textContent = '建议预览';
  const state = dom.createElement('p'); state.className = 'collab-proposal-state'; state.setAttribute('role', 'status');
  const alert = dom.createElement('p'); alert.className = 'collab-error'; alert.setAttribute('role', 'alert');
  const rationale = dom.createElement('p'); rationale.className = 'collab-rationale';
  const metadata = dom.createElement('p'); metadata.className = 'collab-proposal-meta';
  const list = dom.createElement('ol'); list.className = 'collab-proposal-diff';
  const actions = dom.createElement('div'); actions.className = 'collab-proposal-actions';
  let alive = true, document = null, proposal = null, preview = null, busy = false, error = null, readOnly = false;
  let localError = '';
  let generation = 0;
  const callbacks = [];
  const button = (text, callback) => {
    const domNode = dom.createElement('button'); domNode.type = 'button'; domNode.textContent = text;
    const handler = () => {
      if (!alive || domNode.disabled || !validProposal(proposal)) return;
      const id = proposal.proposalId;
      const expectedGeneration = generation;
      try {
        const result = callback(id);
        if (result?.then) Promise.resolve(result).catch(() => {
          if (alive && generation === expectedGeneration && proposal?.proposalId === id) {
            localError = '建议操作失败，请重新预览。'; render();
          }
        });
      } catch { localError = '建议操作失败，请重新预览。'; render(); }
    };
    domNode.addEventListener('click', handler); callbacks.push(() => domNode.removeEventListener('click', handler));
    actions.append(domNode); return domNode;
  };
  const accept = button('接受建议', onAccept);
  const reject = button('拒绝建议', onReject);
  const regenerate = button('重新生成', onRegenerate);
  root.append(title, state, alert, metadata, rationale, list, actions); host.append(root);

  function render() {
    const valid = validProposal(proposal);
    const matches = valid && document && proposal.documentId === document.documentId && proposal.sessionId === document.boundSessionId;
    const conflict = matches && proposal.baseRevision !== document.revision;
    const previewValid = valid && validPreview(preview, proposal);
    const failed = error || localError;
    root.setAttribute('aria-busy', String(busy)); root.dataset.readonly = String(readOnly);
    list.replaceChildren();
    rationale.textContent = valid ? proposal.rationale : '';
    metadata.textContent = valid ? `基于版本 ${proposal.baseRevision}${previewValid ? ` → ${preview.resultingRevision} · ${preview.nodeCount} 节点 · ${preview.edgeCount} 连线` : ''}` : '';
    state.textContent = !proposal ? '暂无建议。尚未接入可信 Agent 建议来源。' : !valid ? '建议数据无效，无法操作。' : !matches ? '建议与当前文档或会话不匹配。' : conflict ? '版本冲突：当前文档已变化，请重新生成建议。' : busy ? '建议处理中…' : readOnly ? '只读预览' : !previewValid ? '尚无有效预览，不能接受建议。' : '预览不会修改画布。确认后才接受建议。';
    alert.textContent = typeof failed === 'string' ? failed : failed ? '建议操作失败，请重新预览。' : '';
    alert.hidden = !failed;
    if (previewValid) for (const entry of preview.diff) {
      const item = dom.createElement('li');
      const type = dom.createElement('span'); type.className = 'collab-operation-type'; type.textContent = entry.type;
      const summary = dom.createElement('span'); summary.textContent = entry.summary;
      item.append(type, summary); list.append(item);
    }
    const disabled = !alive || !valid || !matches || busy || readOnly;
    // 重新生成是冲突后的恢复入口：只读或版本冲突时仍保持可用（由上层发起新的受控任务）。
    accept.disabled = disabled || !!conflict || !previewValid || !!failed;
    reject.disabled = disabled;
    regenerate.disabled = !alive || !valid || !matches || busy;
    actions.hidden = !proposal;
  }
  render();
  return {
    update(next = {}) {
      if (!alive) return;
      generation++;
      if (Object.hasOwn(next, 'document')) document = next.document;
      if (Object.hasOwn(next, 'proposal')) proposal = next.proposal;
      if (Object.hasOwn(next, 'preview')) preview = next.preview;
      if (Object.hasOwn(next, 'busy')) busy = !!next.busy;
      if (Object.hasOwn(next, 'error')) error = next.error;
      if (Object.hasOwn(next, 'readOnly')) readOnly = !!next.readOnly;
      localError = ''; render();
    },
    destroy() {
      if (!alive) return;
      alive = false; for (const dispose of callbacks.splice(0)) dispose();
      root.remove(); document = proposal = preview = null;
    },
  };
}
