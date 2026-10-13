import path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { validateObjectPlan, sameObjectScope } from './session-revert-object-contract.js';
import { objectScopeBinding } from './session-revert-object-profile.js';
import { readRecoveryFile } from './session-revert-object-material-reader.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const PERSISTENT = ['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'nativeSessionId', 'workspaceFingerprint'];
const key = s => JSON.stringify(PERSISTENT.map(k => s[k] ?? null));
const workspaceKey = s => JSON.stringify(['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'workspaceFingerprint'].map(k => s[k] ?? null));
const refKey = (s, digest) => key(s) + ':' + (s.runtimeOwner ? objectScopeBinding(s) : 'legacy-persistent') + ':' + digest;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
function persistentScope(s) {
  if (!s || !['projectId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'nativeSessionId'].every(k => identifier(s[k]))
    || !(s.repoId === null || identifier(s.repoId)) || s.workspaceFingerprint != null && !/^[0-9a-f]{64}$/.test(s.workspaceFingerprint)) fail('invalid_evidence_scope');
  return s;
}
function fullScope(s) {
  if (!s || !sameObjectScope(s, s) || s.projectId !== undefined && s.projectId !== s.runtimeOwner.projectId
    || s.repoId !== undefined && s.repoId !== s.runtimeOwner.repoId) fail('invalid_evidence_scope');
  return persistentScope({ ...s, projectId: s.runtimeOwner.projectId, repoId: s.runtimeOwner.repoId });
}
function plain(value, limits) {
  let nodes = 0;
  const visit = (v, depth) => {
    if (++nodes > limits.nodes || depth > limits.depth) fail('recovery_budget_exceeded');
    if (v === null || ['boolean', 'string'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) fail('evidence_integrity_failed');
    for (const k of Object.keys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (['__proto__', 'constructor', 'prototype'].includes(k) || !d || !Object.hasOwn(d, 'value')) fail('evidence_integrity_failed');
      visit(d.value, depth + 1);
    }
  };
  visit(value, 0);
}
const refValid = (r, limits) => r && Object.keys(r).length === 2 && /^[0-9a-f]{64}$/.test(r.digest) && Number.isSafeInteger(r.bytes) && r.bytes >= 0 && r.bytes <= limits.fileBytes;
const DEFAULTS = Object.freeze({ journalBytes: 32 * 1024 ** 2, events: 20000, eventBytes: 1024 ** 2, nodes: 20000, depth: 16, fileBytes: 2 * 1024 ** 2, rawBytes: 4 * 1024 ** 2, deadlineMs: 30000 });

/** Independent damaged-journal reader. No Store import, writable handle or apply capability. */
export function createSessionRevertObjectRecoveryReader({ dataDir, authorize = () => false, budgets = {}, privacyCheck } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof authorize !== 'function') fail('invalid_evidence_scope');
  const limits = { ...DEFAULTS, ...budgets };
  if (Object.keys(budgets).some(k => !Object.hasOwn(DEFAULTS, k)) || Object.entries(limits).some(([k, v]) => !Number.isSafeInteger(v) || v <= 0 || v > DEFAULTS[k])) fail('recovery_budget_exceeded');
  const root = path.resolve(dataDir, 'revert-evidence', 'v1');
  const journal = path.join(root, 'journal.jsonl');
  async function scan(deadline) {
    const raw = await readRecoveryFile({ root, target: journal, maxBytes: limits.journalBytes, privacyCheck, deadline });
    const plans = new Map(), refs = new Map(), revisions = new Map();
    let chain = '', offset = 0, count = 0, validBytes = 0, damaged = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (offset < raw.length) {
      if (Date.now() > deadline) fail('recovery_budget_exceeded');
      if (count >= limits.events) fail('recovery_budget_exceeded');
      const end = raw.indexOf(10, offset);
      if (end < 0) { damaged = true; break; }
      if (end - offset > limits.eventBytes) { damaged = true; break; }
      try {
        const envelope = JSON.parse(decoder.decode(raw.subarray(offset, end)));
        plain(envelope, limits);
        if (Object.keys(envelope).length !== 3 || envelope.previous !== chain || typeof envelope.body !== 'string'
          || envelope.hash !== hash(chain + '\n' + envelope.body)) fail('evidence_integrity_failed');
        const event = JSON.parse(envelope.body); plain(event, limits);
        event.scope = event.scope?.runtimeOwner ? fullScope(event.scope) : persistentScope(event.scope);
        const wk = workspaceKey(event.scope);
        if (event.revision !== (revisions.get(wk) || 0) + 1) fail('evidence_integrity_failed');
        if (event.type === 'apply' || event.type === 'object_apply_v1') {
          if (event.action === 'restore_object') {
            if (event.type !== 'apply') fail('evidence_integrity_failed');
            if (!refValid(event.ref, limits)) fail('evidence_integrity_failed');
            const rk = refKey(event.scope, event.ref.digest), old = refs.get(rk);
            if (old && old.ref.bytes !== event.ref.bytes) fail('evidence_integrity_failed');
            refs.set(rk, { ref: event.ref, scope: event.scope });
          } else if (event.action === 'plan') {
            // Legacy A events may coexist in this journal, but never authorize B materials.
            if (event.plan?.providerId === undefined && event.plan?.profileId !== 'windows-original-object-v1'
              && !(event.plan?.files ?? event.plan?.paths ?? []).some(f => f.action === 'write_original')) {
              if (event.type !== 'apply') fail('evidence_integrity_failed');
              if (!identifier(event.plan?.planId) || !['prepared', 'replacing', 'moving', 'applied_verified', 'recovery_required', 'not_applied'].includes(event.plan.state)
                || key(event.plan.scope) !== key(event.scope)) fail('evidence_integrity_failed');
              revisions.set(wk, event.revision); chain = envelope.hash; count++; validBytes = end + 1; offset = end + 1; continue;
            }
            if (event.type !== 'object_apply_v1') fail('evidence_integrity_failed');
            validateObjectPlan(event.plan);
            event.plan.scope = fullScope(event.plan.scope);
            if (!event.scope.runtimeOwner || key(event.plan.scope) !== key(event.scope) || !sameObjectScope(event.scope, event.plan.scope)
              || event.plan.revision !== event.revision) fail('evidence_integrity_failed');
            if (!Number.isSafeInteger(event.plan.journalReserveRemaining) || event.plan.journalReserveRemaining < 0
              || event.plan.journalReserveRemaining > 262144) fail('evidence_integrity_failed');
            const pk = key(event.scope) + ':' + event.plan.planId, previous = plans.get(pk);
            if (previous) {
              if (!sameObjectScope(previous.scope, event.plan.scope)) fail('evidence_integrity_failed');
              const transitions = { prepared: ['replacing', 'not_applied'], replacing: ['applied_verified', 'recovery_required'], applied_verified: [], recovery_required: [], not_applied: [] };
              if (!transitions[previous.state]?.includes(event.plan.state)) fail('evidence_integrity_failed');
              const mutablePlan = new Set(['state', 'completion', 'files', 'requestId', 'failureCode', 'confirmationAt', 'completedAt', 'recoveryStatus', 'revision', 'updatedAt', 'consumedOperationIds', 'restartReconciled', 'journalReserveRemaining']);
              for (const field of new Set([...Object.keys(previous), ...Object.keys(event.plan)]))
                if (!mutablePlan.has(field) && JSON.stringify(previous[field]) !== JSON.stringify(event.plan[field])) fail('evidence_integrity_failed');
              const mutableFile = new Set(['state', 'intent', 'observedPostDigest', 'verifiedMeasurement', 'failureCode']);
              for (const field of new Set([...Object.keys(previous.files[0]), ...Object.keys(event.plan.files[0])]))
                if (!mutableFile.has(field) && JSON.stringify(previous.files[0][field]) !== JSON.stringify(event.plan.files[0][field])) fail('evidence_integrity_failed');
              if (previous.files[0].intent && JSON.stringify(previous.files[0].intent) !== JSON.stringify(event.plan.files[0].intent)) fail('evidence_integrity_failed');
              if (previous.requestId && event.plan.requestId !== previous.requestId) fail('evidence_integrity_failed');
              if (event.plan.restartReconciled !== previous.restartReconciled && (event.plan.restartReconciled !== true
                || !['prepared:not_applied', 'replacing:recovery_required'].includes(previous.state + ':' + event.plan.state))) fail('evidence_integrity_failed');
              if (event.plan.journalReserveRemaining > previous.journalReserveRemaining && !(event.plan.restartReconciled === true
                && previous.restartReconciled !== true && ['prepared:not_applied', 'replacing:recovery_required'].includes(previous.state + ':' + event.plan.state))) fail('evidence_integrity_failed');
              if (JSON.stringify(event.plan.consumedOperationIds) !== JSON.stringify(event.plan.state === 'applied_verified'
                ? previous.selectedOperationIds : previous.consumedOperationIds)) fail('evidence_integrity_failed');
            } else if (event.plan.state !== 'prepared' || event.plan.consumedOperationIds.length) fail('evidence_integrity_failed');
            if (event.plan.state === 'replacing' && event.plan.files[0].intent?.journalRevision !== event.revision) fail('evidence_integrity_failed');
            for (const ref of [event.plan.files[0].currentRef, event.plan.files[0].candidateRef]) {
              const registered = refs.get(refKey(event.plan.scope, ref.digest));
              if (!registered || registered.ref.bytes !== ref.bytes || !registered.scope.runtimeOwner || !sameObjectScope(registered.scope, event.plan.scope)) fail('evidence_integrity_failed');
            }
            plans.set(pk, event.plan);
          } else fail('evidence_integrity_failed');
        } else if (event.type === 'operation') {
          if (!event.record || !identifier(event.record.operationId) || !Number.isSafeInteger(event.record.workspaceSequence)
            || event.record.workspaceSequence < 1 || key(event.record.scope) !== key(event.scope)) fail('evidence_integrity_failed');
        } else if (event.type === 'settings') {
          if (!event.settings || typeof event.settings !== 'object' || Array.isArray(event.settings)) fail('evidence_integrity_failed');
        } else if (event.type === 'gap') {
          if (typeof event.reason !== 'string' || !event.reason || event.reason.length > 256) fail('evidence_integrity_failed');
        } else fail('evidence_integrity_failed');
        revisions.set(wk, event.revision); chain = envelope.hash; count++; validBytes = end + 1;
      } catch { damaged = true; break; }
      offset = end + 1;
    }
    return { plans, refs, validBytes, validEvents: count, damaged };
  }
  async function resolve(request, material) {
    if (!request || Object.keys(request).some(k => !['scope', 'planId', ...(material ? ['material'] : [])].includes(k))
      || !identifier(request.planId) || material && !['current', 'candidate'].includes(request.material)) fail('invalid_evidence_operation');
    plain(request, limits); request = { ...request, scope: fullScope(request.scope) };
    // Reject before accessing private disk; a trusted caller cannot bypass owner binding below.
    const deadline = Date.now() + limits.deadlineMs;
    if (await authorize({ scope: request.scope, planId: request.planId, readOnly: true }) !== true) fail('recovery_unauthorized');
    if (Date.now() > deadline) fail('recovery_budget_exceeded');
    const prefix = await scan(deadline), plan = prefix.plans.get(key(request.scope) + ':' + request.planId);
    if (!plan || !sameObjectScope(plan.scope, request.scope)) fail('recovery_prefix_insufficient');
    const file = plan.files[0], available = {};
    let used = 0;
    for (const name of material ? [request.material] : ['current', 'candidate']) {
      const ref = file[name + 'Ref'];
      const registered = prefix.refs.get(refKey(plan.scope, ref?.digest));
      if (!refValid(ref, limits) || registered?.ref.bytes !== ref.bytes
        || !registered.scope.runtimeOwner || !sameObjectScope(registered.scope, plan.scope)) fail('recovery_prefix_insufficient');
      used += ref.bytes; if (used > limits.rawBytes) fail('recovery_budget_exceeded');
      const bytes = await readRecoveryFile({ root, target: path.join(root, 'objects', ref.digest), maxBytes: limits.fileBytes,
        privacyCheck, deadline, bytes: ref.bytes, digest: ref.digest });
      available[name] = material ? bytes : { bytes: bytes.length, digest: ref.digest };
    }
    return { planId: plan.planId, state: plan.state, readOnly: true, applyEligible: false, damagedJournal: prefix.damaged,
      validPrefixBytes: prefix.validBytes, validEvents: prefix.validEvents, materials: available };
  }
  return Object.freeze({ inspect: request => resolve(request, false), read: request => resolve(request, true) });
}
