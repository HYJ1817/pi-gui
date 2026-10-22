/* Durable Changes comments. The pure model changes only after a successful
 * backend read/commit; editor drafts stay with their existing DOM owner. */
import { S } from './state.js';
import { fetchReviewComments, persistReviewComments, gitConversationScope } from './api.js';
import { runtimeStore } from './runtime-state.js';
import { currentReviewScope, commentsForScope, positionKey, replaceReviewComments, beginReviewRefresh } from './diff-comments.js';
import { REVIEW_DATA_LIMITS, REVIEW_STORAGE_MESSAGES, sanitizeReviewComments, reviewCommentWire, validReviewRevision } from './review-comment-data.js';

const states = new Map();
let epoch = 0;
function headers() {
  const id = gitConversationScope(), owner = id ? runtimeStore.get(id)?.owner : S.legacyOwner;
  return { ...(id ? { 'X-Pi-Gui-Conversation': id } : {}), ...(owner ? { 'X-Pi-Gui-Owner': JSON.stringify(owner) } : {}) };
}
function changed(scope) {
  document.dispatchEvent(new window.CustomEvent('pi-gui:review-storage', { detail: { scope } }));
}
function stateFor(scope) {
  if (!states.has(scope)) {
    if (states.size >= REVIEW_DATA_LIMITS.scopes) {
      const old = [...states].find(([key, s]) => key !== scope && !['saving', 'loading'].includes(s.status));
      if (old) states.delete(old[0]);
    }
    const s = { status: 'idle', scope: null, token: null, revision: null, error: '', request: null, epoch };
    states.set(scope, s);
  }
  return states.get(scope);
}
export function reviewPersistenceState(scope = currentReviewScope()) {
  const s = states.get(scope);
  return s ? { status: s.status, error: s.error, scope: s.scope, revision: s.revision }
    : { status: 'idle', error: '', scope: null, revision: null };
}
export function invalidateReviewPersistence() {
  epoch++;
  for (const [scope, s] of states) {
    s.status = 'idle'; s.scope = null; s.token = null; s.request = null; s.error = ''; s.epoch = epoch;
    beginReviewRefresh(scope);
  }
}
for (const name of ['pi-gui:git-scope', 'pi-gui:workspace-generation', 'pi-gui:session-switch']) {
  document.addEventListener(name, invalidateReviewPersistence);
}
function active(s, scope, expectedEpoch, expectedHeaders) {
  return states.get(scope) === s && expectedEpoch === epoch && s.epoch === epoch
    && currentReviewScope() === scope && JSON.stringify(headers()) === JSON.stringify(expectedHeaders);
}
function abandon(s, scope, expectedEpoch) {
  // Owner updates can arrive without a scope-change event. Release only this
  // operation's slot, so a rejected late reply cannot leave Retry disabled.
  if (states.get(scope) === s && s.epoch === expectedEpoch && epoch === expectedEpoch) {
    s.status = 'idle'; s.scope = null; s.token = null; s.request = null; changed(scope);
  }
  return failed('comment_scope_unavailable');
}
const failed = code => ({ ok: false, code, error: REVIEW_STORAGE_MESSAGES[code] || REVIEW_STORAGE_MESSAGES.comment_storage_unavailable });
function snapshot(value) {
  if (value?.ok !== true || !/^[a-f0-9]{64}$/.test(value.scope) || !/^[a-f0-9]{64}$/.test(value.token)
    || !validReviewRevision(value.revision)) throw Error('invalid snapshot');
  return { scope: value.scope, token: value.token, revision: value.revision, comments: sanitizeReviewComments(value.comments) };
}
export async function loadReviewComments({ force = false } = {}) {
  const scope = currentReviewScope(), s = stateFor(scope);
  if (s.status === 'saving') return failed('comment_storage_busy');
  if (!force && s.status === 'ready') return { ok: true };
  if (!force && s.status === 'loading') return s.request;
  const operationEpoch = epoch, expectedHeaders = headers();
  s.status = 'loading'; s.error = ''; beginReviewRefresh(scope); changed(scope);
  const request = (async () => {
    const response = await fetchReviewComments(expectedHeaders);
    if (s.request !== request) return failed('comment_scope_unavailable');
    if (!active(s, scope, operationEpoch, expectedHeaders)) return abandon(s, scope, operationEpoch);
    try {
      if (response?.ok !== true) throw response;
      const result = snapshot(response);
      if (!replaceReviewComments(result.comments, scope)) throw { code: 'comment_storage_limit' };
      Object.assign(s, result, { status: 'ready', error: '' }); changed(scope); return { ok: true };
    } catch (e) {
      const result = failed(e?.code);
      s.status = 'unavailable'; s.scope = null; s.token = null; s.error = result.error; changed(scope); return result;
    }
  })();
  s.request = request;
  return request;
}
async function commit(change) {
  const scope = currentReviewScope(), s = stateFor(scope);
  if (!s.scope || !s.token || !['ready', 'error'].includes(s.status)) {
    return failed(s.status === 'conflict' ? 'comment_conflict' : 'comment_scope_unavailable');
  }
  const previous = commentsForScope(scope).map(c => ({ ...c, anchor: { ...c.anchor } }));
  let prepared;
  try { prepared = change(previous, scope); sanitizeReviewComments(prepared.comments.map(reviewCommentWire)); }
  catch (e) { return { ok: false, error: e?.userMessage || REVIEW_STORAGE_MESSAGES.comment_invalid, code: 'comment_invalid' }; }
  const expectedEpoch = epoch, expectedHeaders = headers(), revision = s.revision;
  s.status = 'saving'; s.error = ''; changed(scope);
  const response = await persistReviewComments({ scope: s.scope, token: s.token, revision,
    comments: prepared.comments.map(reviewCommentWire) }, expectedHeaders);
  if (!active(s, scope, expectedEpoch, expectedHeaders)) return abandon(s, scope, expectedEpoch);
  try {
    if (response?.ok !== true) throw response;
    const result = snapshot(response);
    if (result.scope !== s.scope || result.token !== s.token || result.revision === null || result.revision === revision) throw Error('unconfirmed');
    if (!replaceReviewComments(result.comments, scope, { previous: prepared.comments, restored: false })) throw { code: 'comment_storage_limit' };
    Object.assign(s, result, { status: 'ready', error: '' }); changed(scope);
    return { ok: true, comment: commentsForScope(scope).find(c => c.id === prepared.id) || null };
  } catch (e) {
    const result = failed(e?.code);
    s.status = e?.code === 'comment_conflict' ? 'conflict' : 'error'; s.error = result.error; changed(scope); return result;
  }
}
function invalid(message) { throw { userMessage: message }; }
export function saveReviewComment({ commentId, path, anchor, text }) {
  return commit((comments, scope) => {
    const value = String(text ?? '').trim();
    if (!value) invalid('评论不能为空。');
    if (value.length > REVIEW_DATA_LIMITS.textChars) invalid(`单条评论不能超过 ${REVIEW_DATA_LIMITS.textChars} 字。`);
    const now = Date.now();
    if (commentId) {
      const c = comments.find(item => item.id === commentId);
      if (!c) invalid('这条评论已不在当前作用域，请重新加载。');
      c.text = value; c.updatedAt = Math.max(now, c.updatedAt); return { comments, id: c.id };
    }
    if (comments.some(c => positionKey(c.anchor) === positionKey(anchor))) invalid('这一行已经有一条评论，请先处理原评论。');
    if (comments.length >= REVIEW_DATA_LIMITS.comments) invalid(`当前作用域最多保留 ${REVIEW_DATA_LIMITS.comments} 条评论。`);
    const id = globalThis.crypto?.randomUUID?.() || `review-${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
    comments.push({ id, scope, path, anchor: { ...anchor }, text: value, createdAt: now, updatedAt: now,
      stale: false, verified: true, resolvedLine: null, lastFingerprint: anchor.diffFingerprint });
    return { comments, id };
  });
}
export function removeReviewComment(id) {
  return commit(comments => {
    const index = comments.findIndex(c => c.id === id);
    if (index < 0) invalid('这条评论已不在当前作用域，请重新加载。');
    comments.splice(index, 1); return { comments, id };
  });
}
