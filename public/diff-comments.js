/* In-memory, line-anchored review comments for the Changes panel.
 *
 * This pure model owns anchor reconciliation. review-comment-persistence.js
 * coordinates backend snapshots and confirmed writes; drafts remain in the UI.
 *
 * The anchor keeps both Git coordinates and content evidence. Matching is
 * conservative: when a line cannot be re-identified uniquely it is marked
 * stale instead of being attached to a different row.
 */
import { S } from './state.js';
import { gitConversationScope } from './api.js';
import { rangePosition, reviewRangeLabel, reviewRangesOverlap, reconcileReviewRange } from './review-comment-range.js';

import { REVIEW_LIMITS } from './review-comment-limits.js';
export { REVIEW_LIMITS };

const SECTIONS = Object.freeze({ staged: '暂存区', working: '工作区' });
const scopes = new Map();
const MAX_SCOPES = 20;
const NO_COMMENTS = Object.freeze([]);
let sequence = 0;
// Transient evidence generation, separate from disk revision and anchor policy.
let evidenceRevision = 0;
const evidenceReads = new Map();
export const reviewEvidenceRevision = () => evidenceRevision;
export const reviewEvidencePending = (scope = currentReviewScope()) => [...evidenceReads.values()].includes(scope);
/** A late save acknowledgement cannot turn an in-flight read into evidence. */
export function beginReviewEvidenceRead(scope = currentReviewScope(), path = null) {
  const token = {};
  evidenceReads.set(token, scope);
  beginReviewRefresh(scope, path);
  return (current = true) => {
    evidenceReads.delete(token);
    if (current) beginReviewRefresh(scope, path);
    else invalidateReviewEvidence(scope);
  };
}
export function invalidateReviewEvidence(scope = currentReviewScope()) {
  evidenceRevision++;
  try { document.dispatchEvent(new globalThis.CustomEvent('pi-gui:review-evidence', {detail:{scope}})); }
  catch { /* Pure/headless callers have no document. */ }
}

/**
 * Reviews change from several places (saving, deleting, a diff re-render that
 * confirms or invalidates anchors). The summary is a live view of that state,
 * so it listens instead of freezing whatever was true when it opened.
 */
function emitChange(scope) {
  invalidateReviewEvidence(scope);
  try {
    document.dispatchEvent(new globalThis.CustomEvent('pi-gui:review-change', { detail: { scope } }));
  } catch {
    /* Headless callers may not have a document. */
  }
}

function id() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* Fall through to a local-only identity. */
  }
  sequence += 1;
  return `review-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

/** Stable scope identity for comments. No absolute path is sent anywhere. */
export function currentReviewScope() {
  const conversation = gitConversationScope();
  const session = !conversation && typeof S.state?.sessionId === 'string' ? S.state.sessionId : '';
  const workspace = typeof S.cwd === 'string' ? S.cwd : '';
  const owner = conversation ? `conversation:${conversation}` : `classic:${session || 'nosession'}`;
  return `${owner}|${workspace}`;
}

/** Reads must never mutate the scope table or evict another scope's work. */
function peek(scope = currentReviewScope()) {
  return scopes.get(scope) || NO_COMMENTS;
}

/**
 * A writable bucket. Empty scopes may be reclaimed, but a bucket that still
 * holds comments is never silently discarded. Hitting the hard cap refuses the
 * new comment and leaves every existing comment intact.
 */
function writableBucket(scope = currentReviewScope()) {
  const existing = scopes.get(scope);
  if (existing) return existing;
  if (scopes.size >= MAX_SCOPES) {
    const empty = [...scopes].find(([, list]) => list.length === 0);
    if (!empty) return null;
    scopes.delete(empty[0]);
  }
  const list = [];
  scopes.set(scope, list);
  return list;
}

export function sectionLabel(section) {
  return SECTIONS[section] || '工作区';
}

export function lineLabel(comment) {
  const anchor = comment?.anchor || {};
  if (anchor.range) return reviewRangeLabel(anchor);
  if (anchor.type === 'add') return `新文件第 ${anchor.newLine} 行`;
  if (anchor.type === 'del') return `旧文件第 ${anchor.oldLine} 行`;
  return `第 ${anchor.newLine ?? anchor.oldLine} 行`;
}

export function lineKey(anchor) {
  return positionKey(anchor) + '|' + (anchor.range ? anchor.range.lines.map(r => r.codeHash).join(',') : anchor.codeHash);
}

/** Git coordinates only — a visual line regardless of the code currently there. */
export function positionKey(anchor) {
  return [anchor.path, anchor.section, anchor.type, anchor.oldLine ?? '', anchor.newLine ?? '',
    anchor.range ? JSON.stringify(anchor.range.lines.map(rangePosition)) : ''].join('|');
}

export function commentsForScope(scope = currentReviewScope()) {
  return peek(scope).slice();
}

export function commentsForPath(path, scope = currentReviewScope()) {
  return peek(scope).filter((comment) => comment.path === path);
}

export function commentCount(scope = currentReviewScope()) {
  return peek(scope).length;
}

export function commentForLine(anchor, scope = currentReviewScope()) {
  const key = lineKey(anchor);
  return peek(scope).find((comment) => lineKey(comment.anchor) === key) || null;
}

/**
 * Any comment occupying the same visual line, including a stale one.
 * Stale comments keep their place: a new comment at that line would create two
 * different opinions about one line, and after a future refresh they could
 * both try to rebind to it.
 */
export function commentAtPosition(anchor, scope = currentReviewScope()) {
  const key = positionKey(anchor);
  return peek(scope).find((comment) => positionKey(comment.anchor) === key) || null;
}

export function addComment({ path, anchor, text }, scope = currentReviewScope()) {
  const value = String(text ?? '').trim();
  if (!value) return { ok: false, error: '评论不能为空。' };
  if (value.length > REVIEW_LIMITS.textChars) {
    return { ok: false, error: `单条评论不能超过 ${REVIEW_LIMITS.textChars} 字。` };
  }
  const list = writableBucket(scope);
  if (!list) {
    return {
      ok: false,
      error: `当前已保留 ${MAX_SCOPES} 个会话/工作区的评论；请先删除不再需要的评论。`,
    };
  }
  if (list.length >= REVIEW_LIMITS.comments) {
    return { ok: false, error: `当前作用域最多保留 ${REVIEW_LIMITS.comments} 条评论。` };
  }
  const existing = commentAtPosition(anchor, scope);
  if (existing) {
    return {
      ok: false,
      error: existing.stale ? '这一行已有一条过期评论，请先处理或删除它。' : '这一行已经有一条评论。',
      comment: existing,
    };
  }

  if (list.some(c => reviewRangesOverlap(c.anchor, anchor))) return { ok:false, error:'区间与已有区间评论重叠，请先处理原评论。' };

  const now = Date.now();
  const comment = {
    id: id(),
    scope,
    path: String(path || ''),
    anchor: { ...anchor },
    text: value,
    createdAt: now,
    updatedAt: now,
    stale: false,
    /* Whether the last rendered diff actually confirmed this anchor. A list
     * refresh that never re-renders the diff leaves it false instead of
     * pretending the line is still valid. */
    verified: true,
    resolvedLine: null,
    lastFingerprint: anchor.diffFingerprint,
  };
  list.push(comment);
  emitChange(scope);
  return { ok: true, comment };
}

export function updateComment(commentId, text, scope = currentReviewScope()) {
  const value = String(text ?? '').trim();
  if (!value) return { ok: false, error: '评论不能为空。' };
  if (value.length > REVIEW_LIMITS.textChars) {
    return { ok: false, error: `单条评论不能超过 ${REVIEW_LIMITS.textChars} 字。` };
  }
  const comment = peek(scope).find((item) => item.id === commentId);
  if (!comment) return { ok: false, error: '这条评论已不在当前作用域。' };
  comment.text = value;
  comment.updatedAt = Date.now();
  emitChange(scope);
  return { ok: true, comment };
}

export function deleteComment(commentId, scope = currentReviewScope()) {
  const list = peek(scope);
  const index = list.findIndex((item) => item.id === commentId);
  if (index < 0) return false;
  list.splice(index, 1);
  emitChange(scope);
  return true;
}

/** Only the persistence coordinator calls this after validating a backend
 * snapshot. Restored anchors need new Diff evidence; derived flags and code
 * snippets are never disk authority. */
export function replaceReviewComments(records, scope = currentReviewScope(), { previous = [], restored = true } = {}) {
  if (!Array.isArray(records) || records.length > REVIEW_LIMITS.comments) return false;
  if (!records.length && !scopes.has(scope)) { emitChange(scope); return true; }
  const list = writableBucket(scope);
  if (!list) return false;
  const next = records.map(record => {
    const before = previous.find(c => c.id === record.id);
    return { ...record, scope, anchor: { ...record.anchor, snippet: before?.anchor?.snippet || '' },
      stale: restored ? false : Boolean(before?.stale), verified: restored ? false : before?.verified === true,
      resolvedLine: restored ? null : before?.resolvedLine || null,
      lastFingerprint: before?.lastFingerprint || record.anchor.diffFingerprint };
  });
  list.splice(0, list.length, ...next); emitChange(scope); return true;
}

/**
 * Reconcile comments with the lines that are currently rendered for one diff
 * section. `truncated` must be false; a truncated diff cannot prove a missing
 * line disappeared, so callers keep prior status in that case.
 */
export function reconcileSection(path, section, lines, fingerprint, scope = currentReviewScope()) {
  return reconcileSectionOptions(path, section, lines, fingerprint, { scope });
}

/**
 * Reconcile with an explicit evidence state. A truncated diff has no line rows
 * to compare, so it must not claim either validity or disappearance; callers
 * pass `complete: false` to leave the previous status untouched.
 */
export function reconcileSectionOptions(
  path,
  section,
  lines,
  fingerprint,
  { scope = currentReviewScope(), complete = true } = {}
) {
  invalidateReviewEvidence(scope);
  const targets = peek(scope).filter((comment) => comment.path === path && comment.anchor.section === section);
  if (!complete) return targets;
  let changed = false;
  for (const comment of targets) {
    const wasStale = comment.stale;
    const wasVerified = comment.verified;
    comment.verified = true;
    const anchor = comment.anchor;
    if (anchor.range) {
      const result = reconcileReviewRange({ ...anchor, diffFingerprint: comment.lastFingerprint }, lines, fingerprint);
      comment.stale = result === 'stale';
      comment.verified = result !== 'pending';
      comment.resolvedLine = result === 'valid' ? lineKey(anchor) : null;
      if (result === 'valid') comment.lastFingerprint = fingerprint;
      if (wasStale !== comment.stale || wasVerified !== comment.verified) changed = true;
      continue;
    }
    const exact = lines.filter((line) =>
      line.type === anchor.type &&
      String(line.oldLine ?? '') === String(anchor.oldLine ?? '') &&
      String(line.newLine ?? '') === String(anchor.newLine ?? '') &&
      line.codeHash === anchor.codeHash
    );
    const samePosition = lines.filter((line) =>
      line.type === anchor.type &&
      String(line.oldLine ?? '') === String(anchor.oldLine ?? '') &&
      String(line.newLine ?? '') === String(anchor.newLine ?? '')
    );

    let hit = null;
    if (exact.length === 1) hit = exact[0];
    else if (exact.length > 1) {
      const byHunk = exact.filter((line) =>
        line.hunkHeader === anchor.hunkHeader && Number(line.hunkIndex) === Number(anchor.hunkIndex)
      );
      if (byHunk.length === 1) hit = byHunk[0];
    }

    if (hit) {
      if (wasStale || wasVerified !== true) changed = true;
      comment.stale = false;
      comment.resolvedLine = lineKey({ ...anchor, ...hit });
      comment.lastFingerprint = fingerprint;
      continue;
    }

    /* The requested context row may simply be outside the newly requested
     * context. That is safe only for context rows, and only while the set of
     * changed lines is unchanged. A row at the same position with different
     * content is evidence that the old anchor is gone.
     *
     * The comment is kept, but this render does not show the row, so the
     * anchor is unproven rather than verified. Reporting "当前位置有效" here
     * would claim evidence this diff never produced. */
    if (!samePosition.length && anchor.type === 'context' && comment.lastFingerprint === fingerprint) {
      if (wasStale || wasVerified !== false) changed = true;
      comment.stale = false;
      comment.resolvedLine = null;
      comment.verified = false;
      continue;
    }

    if (!wasStale) changed = true;
    comment.stale = true;
    comment.resolvedLine = null;
  }
  if (changed) emitChange(scope);
  return targets;
}

/**
 * Start a status refresh: until a diff is rendered again, no anchor in this
 * scope has been re-verified. Comments are never deleted here.
 */
export function beginReviewRefresh(scope = currentReviewScope(), path = null) {
  invalidateReviewEvidence(scope);
  let changed = false;
  for (const comment of peek(scope)) {
    if (path !== null && comment.path !== path) continue;
    if (comment.verified !== false) changed = true;
    comment.verified = false;
  }
  if (changed) emitChange(scope);
}

/** Files that no longer appear in Git status cannot keep a live line anchor. */
export function markMissingPathsStale(paths, scope = currentReviewScope()) {
  const present = paths instanceof Set ? paths : new Set(paths || []);
  let changed = 0;
  for (const comment of peek(scope)) {
    if (present.has(comment.path)) continue;
    if (!comment.stale) changed += 1;
    comment.stale = true;
    comment.verified = true;
    comment.resolvedLine = null;
  }
  if (changed) emitChange(scope);
  return changed;
}

function safeSnippet(value) {
  const text = String(value ?? '').replace(/\r/g, '').trim();
  if (!text) return '';
  return text.length > REVIEW_LIMITS.snippetChars ? text.slice(0, REVIEW_LIMITS.snippetChars) + '…' : text;
}

function commentBlock(comment) {
  const anchor = comment.anchor;
  const state = comment.stale ? '原位置已变化' : comment.verified === false ? '尚未重新确认' : '当前位置有效';
  const snippet = safeSnippet(anchor.snippet);
  const path = String(comment.path ?? '').replace(/[\r\n]+/g, ' ');
  const lines = [
    `### ${path}`,
    `- Diff 分区：${sectionLabel(anchor.section)}`,
    `- 位置：${lineLabel(comment)}（${state}）`,
  ];
  if (snippet) lines.push(`- 代码：\`${snippet.replace(/`/g, '´')}\``);
  lines.push('', comment.text);
  return lines.join('\n');
}

/** Format bounded, plain-text feedback for the current scope only. */
export function formatReviewFeedback(comments, { maxChars = REVIEW_LIMITS.feedbackChars } = {}) {
  const list = Array.isArray(comments) ? comments : [];
  if (!list.length) return '';
  const header = [
    '以下是当前工作区的代码审查意见。请逐条处理；不要改动与这些意见无关的文件。',
    '',
  ];
  let text = header.join('\n');
  const sorted = list.slice().sort((a, b) =>
    String(a.path).localeCompare(String(b.path), 'zh') ||
    String(a.anchor?.section || '').localeCompare(String(b.anchor?.section || '')) ||
    Number(a.anchor?.newLine ?? a.anchor?.oldLine ?? 0) - Number(b.anchor?.newLine ?? b.anchor?.oldLine ?? 0)
  );
  for (const comment of sorted) {
    const block = commentBlock(comment);
    if (text.length + block.length + 2 > maxChars) {
      text += '\n\n[反馈已截断：评论数量超过可安全复制的长度上限]';
      break;
    }
    text += block + '\n\n';
  }
  return text.trimEnd();
}
