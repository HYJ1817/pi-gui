// Pure, bounded content planning. No filesystem I/O, write authority, or metadata claims.
const DEFAULTS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxTokens: 20000, maxCells: 2000000, maxMs: 750, maxOperations: 256, maxAgeMs: 7 * 86400000 });
export const SESSION_REVERT_REASONS = Object.freeze(['unsupported_operation', 'incomplete_evidence', 'unsupported_text', 'budget_exceeded',
  'creation_modified', 'current_missing', 'ambiguous_mapping', 'overlapping_changes', 'expired_evidence', 'no_evidence',
  'invalid_selection', 'invalid_evidence_order', 'scope_mismatch', 'attribution_gap', 'unproven_continuity', 'cross_session_conflict']);
const same = (a, b) => a === null ? b === null : Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
const refused = reason => ({ status: 'refused', reason, candidate: null, action: 'none' });
const noop = () => ({ status: 'already_reverted', reason: null, candidate: null, action: 'none' });
function stop(reason) { throw Object.assign(new Error(reason), { reason }); }
function budget(options) {
  const limits = { ...DEFAULTS, ...options };
  if (!Object.values(limits).every(n => Number.isSafeInteger(n) && n >= 0)) stop('budget_exceeded');
  return { limits, deadline: performance.now() + limits.maxMs, cells: 0 };
}
function check(work, cells = 0) {
  work.cells += cells;
  if (work.cells > work.limits.maxCells || performance.now() >= work.deadline) stop('budget_exceeded');
}
function tokens(bytes, work) {
  check(work);
  if (!Buffer.isBuffer(bytes)) stop('incomplete_evidence');
  if (bytes.length > work.limits.maxBytes) stop('budget_exceeded');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { stop('unsupported_text'); }
  if (!Buffer.from(text, 'utf8').equals(bytes) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) stop('unsupported_text');
  // Keep every CR/LF sequence and BOM in its original token. No normalization.
  const result = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || [];
  if (result.length > work.limits.maxTokens) stop('budget_exceeded');
  return result;
}
/** Unique optimal LCS mapping, not an arbitrary tie-broken edit script.
 * Every match that belongs to ANY optimal alignment must belong to the ONE
 * accepted alignment. Multiple delete/insert orderings with no matches are
 * equivalent; multiple placements of repeated matching text are not.
 */
function diff(a, b, work) {
  check(work);
  if (a.length === b.length && a.every((v, i) => v === b[i])) return [];
  const n = a.length, m = b.length, width = m + 1, size = (n + 1) * width;
  check(work, size * 2);
  const prefix = new Uint32Array(size), suffix = new Uint32Array(size);
  for (let i = 1; i <= n; i++) {
    check(work);
    for (let j = 1; j <= m; j++) prefix[i * width + j] = a[i - 1] === b[j - 1]
      ? prefix[(i - 1) * width + j - 1] + 1 : Math.max(prefix[(i - 1) * width + j], prefix[i * width + j - 1]);
  }
  for (let i = n - 1; i >= 0; i--) {
    check(work);
    for (let j = m - 1; j >= 0; j--) suffix[i * width + j] = a[i] === b[j]
      ? suffix[(i + 1) * width + j + 1] + 1 : Math.max(suffix[(i + 1) * width + j], suffix[i * width + j + 1]);
  }
  const matches = [], length = suffix[0];
  for (let i = 0; i < n; i++) {
    check(work);
    for (let j = 0; j < m; j++) if (a[i] === b[j] && prefix[i * width + j] + 1 + suffix[(i + 1) * width + j + 1] === length) {
      matches.push([i, j]);
      if (matches.length > length) stop('ambiguous_mapping');
    }
  }
  const hunks = []; let ai = 0, bi = 0;
  for (const [i, j] of [...matches, [n, m]]) {
    if (i < ai || j < bi) stop('ambiguous_mapping');
    if (i !== ai || j !== bi) hunks.push({ start: ai, end: i, replacement: b.slice(bi, j) });
    ai = i + 1; bi = j + 1;
  }
  return hunks;
}
function overlaps(a, b) {
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}
function mergeInternal({ before, intendedAfter, current }, work) {
  if (intendedAfter === null) return refused('unsupported_operation');
  const A = tokens(intendedAfter, work), B = before === null ? null : tokens(before, work), C = current === null ? null : tokens(current, work);
  if (before === null) {
    if (current === null) return noop();
    if (same(current, intendedAfter)) return { status: 'candidate', reason: null, candidate: null, action: 'move_to_recovery' };
    return refused('creation_modified');
  }
  if (current === null) return refused('current_missing');
  if (same(current, before)) return noop();
  // Exact A is a complete byte-level proof; no contextual mapping is needed.
  if (same(current, intendedAfter)) return { status: 'candidate', reason: null, candidate: Buffer.from(before), action: 'replace' };
  const inverse = diff(A, B, work), external = diff(A, C, work);
  for (const left of inverse) for (const right of external) { check(work); if (overlaps(left, right)) return refused('overlapping_changes'); }
  const combined = [...inverse, ...external].sort((a, b) => a.start - b.start || a.end - b.end);
  const result = []; let at = 0;
  for (const hunk of combined) { result.push(...A.slice(at, hunk.start), ...hunk.replacement); at = hunk.end; }
  result.push(...A.slice(at));
  const candidate = Buffer.from(result.join(''), 'utf8');
  if (candidate.length > work.limits.maxBytes) return refused('budget_exceeded');
  return same(candidate, current) ? noop() : { status: 'candidate', reason: null, candidate, action: 'replace' };
}
export function inverseMerge(input = {}) {
  try { return mergeInternal(input, budget(input.budgets)); }
  catch (error) { return refused(error.reason || 'incomplete_evidence'); }
}
const workspaceKeys = ['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'workspaceFingerprint'];
const sessionKeys = [...workspaceKeys, 'conversationId', 'nativeSessionId', 'evidenceEpoch'];
const identity = (record, keys) => JSON.stringify(keys.map(key => record.scope?.[key] ?? null));
function complete(record, now, work) {
  check(work);
  if (record.kind === 'rename' || record.kind === 'delete' || record.operationType === 'rename' || record.operationType === 'delete') stop('unsupported_operation');
  if (record.state !== 'observed' || record.toolResultObserved !== true
    || !['intent_verified', 'exclusive_verified'].includes(record.evidenceLevel)
    || !Buffer.isBuffer(record.intendedAfter) || !same(record.intendedAfter, record.observedAfter)
    || !(record.before === null || Buffer.isBuffer(record.before))) stop('incomplete_evidence');
  if (!Number.isFinite(record.createdAt) || record.createdAt > now || now - record.createdAt > work.limits.maxAgeMs) stop('expired_evidence');
  tokens(record.intendedAfter, work); if (record.before !== null) tokens(record.before, work);
}
// Detect references to any identifier on either side of selected changed lines,
// including existing bindings whose value changes and short/Unicode names.
// Later removed text also matters: removing an API use can depend on A just as
// adding one can. Shared identifiers may cause conservative false refusals;
// absence of a shared identifier is still not a semantic independence proof.
function directDependency(selected, later, work) {
  if (selected.before === null || later.before === null) return true;
  const identifiers = text => text.match(/[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu) || [];
  const changedText = (before, after) => diff(before, after, work)
    .flatMap(h => [...before.slice(h.start, h.end), ...h.replacement]).join('');
  const selectedNames = new Set(identifiers(changedText(tokens(selected.intendedAfter, work), tokens(selected.before, work))));
  if (!selectedNames.size) return false;
  const laterText = changedText(tokens(later.before, work), tokens(later.intendedAfter, work));
  return identifiers(laterText).some(word => selectedNames.has(word));
}
/** records must cover one file in one workspace, including intervening sessions.
 * The authority layer supplies authenticated raw records; this function never
 * upgrades evidence or authorizes an actual write.
 */
export function computeSessionRevert({ records, selectedOperationIds, current, gapRevision = 0, now = Date.now(), budgets } = {}) {
  let operationIds = [], conflictOperationIds = [], evidenceLevel = null;
  const finish = result => ({ ...result, operationIds, conflictOperationIds, evidenceLevel, contentEligible: result.status !== 'refused' });
  try {
    const work = budget(budgets);
    if (!Array.isArray(records) || !Array.isArray(selectedOperationIds) || !selectedOperationIds.length) return finish(refused('no_evidence'));
    if (records.length > work.limits.maxOperations || selectedOperationIds.length > work.limits.maxOperations) stop('budget_exceeded');
    if (new Set(selectedOperationIds).size !== selectedOperationIds.length) stop('invalid_selection');
    const ordered = [...records].sort((a, b) => a.workspaceSequence - b.workspaceSequence), ids = new Set(selectedOperationIds);
    const selected = ordered.filter(r => ids.has(r.operationId)); operationIds = selected.map(r => r.operationId);
    if (selected.length !== ids.size) return finish(refused('no_evidence'));
    if (new Set(ordered.map(r => r.operationId)).size !== ordered.length
      || new Set(ordered.map(r => r.workspaceSequence)).size !== ordered.length
      || ordered.some(r => !Number.isSafeInteger(r.workspaceSequence) || r.workspaceSequence <= 0)) stop('invalid_evidence_order');
    if (new Set(ordered.map(r => identity(r, workspaceKeys))).size !== 1 || new Set(selected.map(r => identity(r, sessionKeys))).size !== 1) stop('scope_mismatch');
    const levels = new Set(selected.map(r => r.evidenceLevel));
    evidenceLevel = ['incomplete', 'unsupported', 'observed', 'intent_verified', 'exclusive_verified'].find(level => levels.has(level)) || null;
    const relevant = ordered.filter(r => r.workspaceSequence >= selected[0].workspaceSequence);
    if (gapRevision !== 0 || relevant.some(r => r.attributionGapRevision !== 0)) stop('attribution_gap');
    for (const r of relevant) complete(r, now, work);
    // Validate unrecorded gaps between the recorded operations. Only a unique
    // disjoint external change can bridge an A_i -> B_(i+1) discontinuity.
    for (let i = 1; i < relevant.length; i++) {
      const previous = relevant[i - 1], next = relevant[i];
      if (!same(previous.intendedAfter, next.before)) {
        const proof = mergeInternal({ before: previous.before, intendedAfter: previous.intendedAfter, current: next.before }, work);
        if (proof.status === 'refused') { conflictOperationIds = [next.operationId]; return finish(refused(proof.reason === 'budget_exceeded' ? proof.reason : 'unproven_continuity')); }
      }
    }
    for (const chosen of selected) for (const later of relevant) {
      check(work);
      if (later.workspaceSequence <= chosen.workspaceSequence || ids.has(later.operationId)) continue;
      const beforeProof = mergeInternal({ before: chosen.before, intendedAfter: chosen.intendedAfter, current: later.before }, work);
      const afterProof = mergeInternal({ before: chosen.before, intendedAfter: chosen.intendedAfter, current: later.intendedAfter }, work);
      if (beforeProof.status === 'refused' || afterProof.status === 'refused' || directDependency(chosen, later, work)) {
        conflictOperationIds = [later.operationId]; return finish(refused('cross_session_conflict'));
      }
    }
    if (current !== null) tokens(current, work);
    // A complete exact first preimage is already the requested state. In
    // particular, do not replay a multi-operation inverse over it a second time.
    if (same(current, selected[0].before)) return finish(noop());
    let virtual = current, action = 'none', changed = false;
    for (const r of selected.toReversed()) {
      const result = mergeInternal({ before: r.before, intendedAfter: r.intendedAfter, current: virtual }, work);
      if (result.status === 'refused') return finish(result);
      if (result.status === 'candidate') { virtual = result.candidate; action = result.action; changed = true; }
    }
    check(work);
    return finish(changed ? { status: 'candidate', reason: null, candidate: virtual, action } : noop());
  } catch (error) { return finish(refused(error.reason || 'incomplete_evidence')); }
}
