/* Viewing a native history is separate from handing Pi another session/cwd.
 * The classic stream stays mounted; independent execution uses existing Runtime
 * workspaces. No background task is stopped by any operation in this view. */
import { S } from './state.js';
import { fetchSessionHistory, fetchSessions } from './api.js';
import { runtimeStore } from './runtime-state.js';
import { openWorkSurface, showChat } from './ui/workspace-surface.js';
import { samePath } from './util.js';
import { draftKey, hashKey, readDraftText, writeDraftText, removeDraft, DRAFT_MAX_CHARS } from './draft.js';

const node = (tag, cls, text) => { const element = document.createElement(tag); if (cls) element.className = cls; if (text != null) element.textContent = text; return element; };
const primaryBusy = () => Boolean(S.streaming || S.submitting || S.stopping || S.fallbackActive);

export function createSessionNavigation({ continueSession, newSession, createParallel, restoreNewDraft = () => {},
  readHistory = fetchSessionHistory, readSessions = fetchSessions,
  busy = primaryBusy, background = null } = {}) {
  const hasBackground = background || (() => busy() || runtimeStore.values().some(record => record.owner));
  const drafts = new Map();
  let viewed = null;
  let pendingNewDraft = null, requestSequence = 0;
  const projectOf = project => ({ path: project?.path || S.cwd, name: project?.name || project?.path || S.cwd });
  const button = (text, run) => { const element = node('button', 'btn', text); element.type = 'button'; element.onclick = run; return element; };

  function open(session, project, locateUserIndex = null) {
    project = projectOf(project);
    // This row still owns the untouched classic DOM and its pending approvals.
    if (session?.current && samePath(project.path, S.cwd)) { viewed = null; showChat({ focusComposer: true }); return true; }
    if (!hasBackground()) return false;
    showHistory(session, project, locateUserIndex);
    return true;
  }

  function showHistory(session, project, locateUserIndex = null, resolved = null) {
    const key = JSON.stringify([project.path, session?.id || 'new']);
    const persistedKey = draftKey(hashKey(project.path), session?.sessionId ? hashKey(session.sessionId)
      : session?.id ? 'history-' + hashKey(session.id) : 'background-new');
    viewed = { session, project };
    openWorkSurface('history', (card, instance) => {
      const bar = node('div', 'ext-bar');
      bar.append(node('h3', '', session?.title || '新会话草稿'), button('返回主会话', () => { viewed = null; showChat({ focusComposer: true }); }));
      card.append(bar, node('p', 'modal-desc', project.name));
      const status = node('p', 'cfg-note'); status.setAttribute('role', 'status');
      status.textContent = '其它会话继续在后台执行。此页只查看历史，不切换 Pi 的会话或工作目录。';
      const output = node('div', 'session-history-output');
      card.append(status, output);
      if (session) {
        output.textContent = '正在读取历史…';
        void (resolved ? Promise.resolve(resolved) : readHistory(session.id, project.path)).then(result => {
          if (!instance.isCurrent()) return;
          output.replaceChildren();
          if (!result?.ok) { status.textContent = '历史读取失败。可以重新打开此会话重试，后台任务未受影响。'; return; }
          // Bounded native history provides text only; do not invent tools/usage.
          for (const message of result.messages || []) {
            const row = node('article', 'msg ' + (message.role === 'user' ? 'user' : 'assistant'));
            row.append(node('div', 'msg-role', message.role === 'user' ? '你' : 'Pi'), node('div', 'msg-body', message.text));
            row.dataset.userIndex = String(message.userIndex);
            output.append(row);
          }
          status.textContent = result.truncated ? '历史已按读取预算截断；此页只含正文，工具、思考与用量仍归属各自执行会话。' : '只读历史（正文）。后台输出、工具、用量和审批仍保留在原会话。';
          if (Number.isInteger(locateUserIndex)) [...output.children].find(row => row.dataset.userIndex === String(locateUserIndex))?.scrollIntoView?.({ block: 'nearest' });
        }).catch(() => { if (instance.isCurrent()) { output.textContent = ''; status.textContent = '历史读取失败，后台任务未受影响。'; } });
      }
      if (session?.readOnly) return;
      const label = node('label', 'wt-field', '会话草稿');
      const input = node('textarea', 'modal-input'); input.rows = 3; input.maxLength = DRAFT_MAX_CHARS;
      input.value = drafts.get(key) ?? readDraftText(persistedKey) ?? '';
      input.setAttribute('aria-label', '会话草稿'); input.oninput = () => {
        drafts.set(key, input.value); writeDraftText(persistedKey, input.value);
        while (drafts.size > 32) drafts.delete(drafts.keys().next().value);
      };
      label.append(input); card.append(label);
      const actions = node('div', 'ext-bar');
      const resume = button(session ? '继续此会话' : '创建此会话', async () => {
        if (busy()) { status.textContent = '同一工作目录仍有后台任务。可先保留草稿，或在独立工作区新建并行会话。'; return; }
        resume.disabled = true;
        let transfer = null;
        try {
          const requestId = 'navigation-new-' + (++requestSequence);
          transfer = session ? null : { requestId, oldId: S.state?.sessionId, project: project.path, generation: S.workspaceGeneration, text: input.value, acknowledged: false };
          if (transfer) pendingNewDraft = transfer;
          const result = session ? await continueSession?.(session, project, input.value) : await newSession?.(project, input.value, requestId);
          if (session && result?.ok && result.sessionId) writeDraftText(draftKey(hashKey(project.path), hashKey(result.sessionId)), input.value);
          if (result === false && pendingNewDraft === transfer) pendingNewDraft = null;
          if (instance.isCurrent()) status.textContent = result === false ? '执行交接未完成，后台会话和草稿已保留。' : '正在打开会话…';
        } catch { if (pendingNewDraft === transfer) pendingNewDraft = null; if (instance.isCurrent()) status.textContent = '打开会话失败，草稿已保留。'; }
        finally { if (instance.isCurrent()) resume.disabled = false; }
      });
      const parallel = button('在独立工作区新建并行会话', () => createParallel?.(project));
      actions.append(resume, parallel); card.append(actions);
      if (!session) input.focus();
    });
  }

  function openProject(project) {
    if (!hasBackground()) return false;
    project = projectOf(project); viewed = { project, session: null };
    openWorkSurface('history', (card, instance) => {
      card.append(node('h3', '', project.name), node('p', 'cfg-note', '查看项目不会改变后台任务的工作目录。'),
        button('返回主会话', () => showChat()), button('新会话草稿', () => showHistory(null, project)),
        button('在独立工作区新建并行会话', () => createParallel?.(project)));
      const list = node('div', 'ext-list'); list.textContent = '正在读取会话…'; card.append(list);
      void readSessions(project.path).then(result => {
        if (!instance.isCurrent()) return;
        list.replaceChildren();
        if (!result?.ok) { list.textContent = '会话读取失败，请重新打开项目重试。'; return; }
        for (const session of result.sessions || []) if (!session.pending) list.append(button(session.title || '未命名会话', () => showHistory(session, project)));
        if (!list.childElementCount) list.textContent = '还没有会话';
      }).catch(() => { if (instance.isCurrent()) list.textContent = '会话读取失败'; });
    });
    return true;
  }

  return { open, openProject,
    openResolvedHistory(result, project) { showHistory({ id: result.id, sessionId: result.sessionId, title: result.title, readOnly: true }, projectOf(project), null, result); },
    observeResponse(event) {
      const transfer = pendingNewDraft;
      if (!transfer || event._replay) return;
      if (event.command === 'new_session' && event.id === transfer.requestId) {
        if (!event.success) { pendingNewDraft = null; return; }
        transfer.acknowledged = true;
      }
      if (!transfer.acknowledged || event.command !== 'get_state' || !event.success) return;
      const nativeId = S.state?.sessionId;
      if (!nativeId || nativeId === transfer.oldId || !samePath(S.cwd, transfer.project) || S.workspaceGeneration !== transfer.generation) return;
      pendingNewDraft = null;
      writeDraftText(draftKey(hashKey(transfer.project), hashKey(nativeId)), transfer.text);
      if (readDraftText(draftKey(hashKey(transfer.project), 'background-new')) === transfer.text) removeDraft(draftKey(hashKey(transfer.project), 'background-new'));
      const key = JSON.stringify([transfer.project, 'new']);
      if (drafts.get(key) === transfer.text) drafts.delete(key);
      restoreNewDraft(transfer.text);
    },
    newDraft(project = null) { if (!hasBackground()) return false; showHistory(null, projectOf(project || viewed?.project)); return true; },
    get viewed() { return viewed; } };
}
