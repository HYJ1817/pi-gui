import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

const OWNER_KEYS = ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'runtimeId', 'runtimeGeneration', 'sessionId'];
const GAP_REASONS = new Set(['unknown_tool', 'shell', 'disabled', 'source_changed', 'capture_failed', 'restart', 'excluded_path', 'incomplete', 'external_writer_possible', 'session_changed', 'extension_unavailable']);
const DEFAULTS = { fileBytes: 2 * 1024 ** 2, operationBytes: 16 * 1024 ** 2, operationFiles: 32, conversationBytes: 128 * 1024 ** 2, globalBytes: 512 * 1024 ** 2, retentionDays: 7 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function identity(scope) {
  const owner = scope?.runtimeOwner;
  if (!owner || !OWNER_KEYS.every(k => (k === 'repoId' && owner[k] === null) || (typeof owner[k] === 'string' && owner[k].length > 0 && owner[k].length <= 256 && !/[\x00-\x1f]/.test(owner[k])))
    || !['conversationId', 'workspaceId', 'workspaceEpoch'].every(k => scope[k] === owner[k]) || scope.nativeSessionId !== owner.sessionId) fail('invalid_evidence_scope');
  if (scope.workspaceFingerprint != null && (typeof scope.workspaceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(scope.workspaceFingerprint))) fail('invalid_evidence_scope');
  return { runtimeOwner: Object.fromEntries(OWNER_KEYS.map(k => [k, owner[k]])), conversationId: scope.conversationId,
    nativeSessionId: scope.nativeSessionId, workspaceId: scope.workspaceId, workspaceEpoch: scope.workspaceEpoch,
    projectId: owner.projectId, repoId: owner.repoId, workspaceFingerprint: scope.workspaceFingerprint ?? null };
}
const scopeKey = s => digest(JSON.stringify([s.projectId, s.repoId, s.workspaceId, s.workspaceEpoch, s.conversationId, s.nativeSessionId, s.workspaceFingerprint ?? null]));
const workspaceKey = s => digest(JSON.stringify([s.projectId, s.repoId, s.workspaceId, s.workspaceEpoch, s.workspaceFingerprint ?? null]));
function persistentIdentity(scope) {
  if (!scope || !['projectId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'nativeSessionId'].every(k => typeof scope[k] === 'string' && scope[k].length > 0 && scope[k].length <= 256 && !/[\x00-\x1f\x7f]/.test(scope[k]))
    || !(scope.repoId === null || (typeof scope.repoId === 'string' && scope.repoId.length > 0 && scope.repoId.length <= 256 && !/[\x00-\x1f\x7f]/.test(scope.repoId)))
    || (scope.workspaceFingerprint != null && (typeof scope.workspaceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(scope.workspaceFingerprint)))) fail('invalid_evidence_scope');
  return Object.fromEntries(['projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'nativeSessionId', 'workspaceFingerprint'].map(k => [k, scope[k] ?? null]));
}
function relative(value, prefix = false) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f:]/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) fail('unsupported_evidence_path');
  const normalized = value.replaceAll('\\', '/').replace(prefix ? /\/+$/ : /$^/, '');
  if (!normalized || normalized.split('/').some(p => !p || p === '.' || p === '..')) fail('unsupported_evidence_path');
  return normalized;
}
function identifier(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(value)) fail('invalid_evidence_operation'); return value; }
function toolIdentifier(value) { if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) fail('invalid_evidence_operation'); return value; }
async function noLinks(target, file = false) {
  let current = path.resolve(target);
  while (true) {
    try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || (current === path.resolve(target) && file && (!stat.isFile() || stat.nlink !== 1))) fail('evidence_privacy_unavailable'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function powershell(script, target) {
  const env = { ...process.env, PI_GUI_EVIDENCE_ACL_TARGET: target };
  // PowerShell 7 module paths can break Windows PowerShell's native ACL module.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10000, maxBuffer: 8192, env },
    (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}
async function privacy(target, initialize, requireProtected = true) {
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $p=$env:PI_GUI_EVIDENCE_ACL_TARGET; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544'); `
      + (initialize ? `$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($s in $allowed){$id=New-Object System.Security.Principal.SecurityIdentifier($s); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule)}; Set-Acl -LiteralPath $p -AclObject $acl; ` : '')
      + `$acl=Get-Acl -LiteralPath $p; if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 2}; $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); $own=$false; foreach($r in $rules){if($r.AccessControlType -eq 'Allow'){if($allowed -notcontains $r.IdentityReference.Value){exit 3}; if($r.IdentityReference.Value -eq $sid.Value -and (($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)){$own=$true}}}; if(-not $own){exit 4}; ` + (requireProtected ? `if(-not $acl.AreAccessRulesProtected){exit 5}; ` : '') + `'private'`;
    return (await powershell(script, target)) === 'private';
  }
  const st = await fs.stat(target);
  return st.uid === process.getuid() && (st.mode & 0o077) === 0;
}

/** Private raw evidence store. Callers authenticate authority and capture target identities. */
export async function createSessionChangeStore({ dataDir, privacyCheck, budgets = {}, now = Date.now } = {}) {
  const limits = { ...DEFAULTS, ...budgets };
  if (typeof dataDir !== 'string' || !Object.values(limits).every(n => Number.isSafeInteger(n) && n > 0)) fail('evidence_privacy_unavailable');
  const root = path.resolve(dataDir, 'revert-evidence', 'v1'), objects = path.join(root, 'objects'), journal = path.join(root, 'journal.jsonl');
  const checker = privacyCheck || privacy;
  async function childPrivacy(target) { if (!await checker(target, false, false)) fail('evidence_privacy_unavailable'); }
  try {
    await noLinks(root); let fresh = false;
    try { await fs.lstat(root); } catch (e) { if (e.code !== 'ENOENT') throw e; fresh = true; }
    try { await fs.mkdir(root, { recursive: true, mode: 0o700 }); } catch { fail('evidence_privacy_unavailable'); }
    if (!await checker(root, fresh)) fail('evidence_privacy_unavailable');
    await fs.mkdir(objects, { mode: 0o700, recursive: true }); await noLinks(objects); await noLinks(journal, true);
    await childPrivacy(objects);
  } catch { fail('evidence_privacy_unavailable'); }
  const records = new Map(), configurations = new Map(), workspaces = new Map();
  let chain = '', pending = Promise.resolve(), broken = false;
  const queue = fn => { const task = pending.then(async () => { if (broken) fail('evidence_integrity_failed'); try { return await fn(); } catch (e) { if (e.code === 'evidence_integrity_failed') broken = true; if (e.code?.startsWith('evidence_') || ['invalid_evidence_scope', 'invalid_evidence_operation', 'unsupported_evidence_path'].includes(e.code)) throw e; fail('evidence_storage_failed'); } }); pending = task.catch(() => {}); return task; };
  function ws(s) { const key = workspaceKey(s); if (!workspaces.has(key)) workspaces.set(key, { revision: 0, sequence: 0, gapRevision: 0 }); return workspaces.get(key); }
  function apply(event) {
    const s = identity(event.scope), w = ws(s);
    if (event.revision !== w.revision + 1) fail('evidence_integrity_failed');
    w.revision = event.revision;
    if (event.type === 'operation') { const r = event.record; if (r.workspaceSequence > w.sequence) w.sequence = r.workspaceSequence; records.set(scopeKey(s) + ':' + r.operationId, r); }
    else if (event.type === 'gap') w.gapRevision = event.revision;
    else if (event.type === 'settings') configurations.set(scopeKey(s), event.settings);
    else fail('evidence_integrity_failed');
  }
  function validateReference(ref) {
    if (ref === null) return;
    if (!ref || !/^[0-9a-f]{64}$/.test(ref.digest) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > limits.fileBytes) fail('evidence_integrity_failed');
  }
  async function verifyRef(ref) {
    validateReference(ref); if (ref === null) return null;
    const location = path.join(objects, ref.digest); await noLinks(location, true); await childPrivacy(location);
    let bytes, fd;
    try {
      const expected = await fs.lstat(location);
      fd = await fs.open(location, 'r');
      const stat = await fd.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== ref.bytes || stat.size > limits.fileBytes || stat.dev !== expected.dev || stat.ino !== expected.ino) fail('evidence_integrity_failed');
      const buffer = Buffer.alloc(ref.bytes + 1); let count = 0;
      while (count < buffer.length) { const result = await fd.read(buffer, count, buffer.length - count, null); if (!result.bytesRead) break; count += result.bytesRead; }
      const after = await fd.stat(), linked = await fs.lstat(location);
      if (count !== ref.bytes || after.size !== ref.bytes || linked.isSymbolicLink() || linked.nlink !== 1 || linked.dev !== stat.dev || linked.ino !== stat.ino) fail('evidence_integrity_failed');
      bytes = buffer.subarray(0, count);
    } catch { fail('evidence_integrity_failed'); } finally { if (fd) await fd.close(); }
    if (bytes.length !== ref.bytes || digest(bytes) !== ref.digest) fail('evidence_integrity_failed'); return bytes;
  }
  async function append(scope, event) {
    await noLinks(journal, true); await noLinks(objects);
    if (!await checker(root, false)) fail('evidence_privacy_unavailable');
    const item = { ...event, scope, revision: ws(scope).revision + 1, at: now() };
    const body = JSON.stringify(item), hash = digest(chain + '\n' + body);
    const line = JSON.stringify({ previous: chain, hash, body }) + '\n';
    const size = await fs.stat(journal).then(st => st.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
    if (size + Buffer.byteLength(line) > 32 * 1024 ** 2) fail('evidence_quota_exceeded');
    const fd = await fs.open(journal, 'a', 0o600);
    try { await childPrivacy(journal); await fd.writeFile(line); await fd.sync(); }
    catch { broken = true; fail('evidence_storage_failed'); } finally { await fd.close(); }
    chain = hash; apply(item);
  }
  try {
    const text = await (async () => { try { const st = await fs.stat(journal); if (st.size > 32 * 1024 ** 2) fail('evidence_integrity_failed'); await childPrivacy(journal); return await fs.readFile(journal, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } })();
    if (text && !text.endsWith('\n')) fail('evidence_integrity_failed');
    for (const line of text.split('\n').filter(Boolean)) {
      const envelope = JSON.parse(line); if (envelope.previous !== chain || digest(chain + '\n' + envelope.body) !== envelope.hash) fail('evidence_integrity_failed');
      const event = JSON.parse(envelope.body); apply(event); chain = envelope.hash;
    }
    const verified = new Map();
    for (const record of records.values()) for (const key of ['beforeRef', 'intendedAfterRef', 'observedAfterRef']) {
      const reference = record[key]; validateReference(reference); if (reference === null) continue;
      if (verified.has(reference.digest)) { if (verified.get(reference.digest) !== reference.bytes) fail('evidence_integrity_failed'); }
      else { await verifyRef(reference); verified.set(reference.digest, reference.bytes); }
    }
    const restartGaps = new Map();
    for (const record of [...records.values()]) if (['begun', 'prepared'].includes(record.state) || (record.state === 'observed' && record.toolResultObserved !== true)) {
      await append(record.scope, { type: 'operation', record: { ...record, state: 'incomplete', evidenceLevel: 'incomplete', mutationOutcome: record.state === 'observed' ? record.mutationOutcome : 'unknown' } });
      restartGaps.set(workspaceKey(record.scope), record.scope);
    }
    for (const scope of restartGaps.values()) await append(scope, { type: 'gap', reason: 'restart' });
  } catch { fail('evidence_integrity_failed'); }
  function settings(s) { return { enabled: false, exclusions: [], retentionDays: limits.retentionDays, noticeVersion: 1, ...configurations.get(scopeKey(s)) }; }
  function authorized(s, record) { if (JSON.stringify(record.scope.runtimeOwner) !== JSON.stringify(s.runtimeOwner)) fail('invalid_evidence_scope'); }
  function ref(bytes) { if (bytes === null) return null; if (!Buffer.isBuffer(bytes)) fail('invalid_evidence_operation'); if (bytes.length > limits.fileBytes) fail('evidence_quota_exceeded'); return { digest: digest(bytes), bytes: bytes.length }; }
  async function blob(bytes) {
    const reference = ref(bytes); if (!reference) return null;
    await noLinks(root); await noLinks(objects);
    if (!await checker(root, false)) fail('evidence_privacy_unavailable');
    await childPrivacy(objects);
    const location = path.join(objects, reference.digest); await noLinks(location, true);
    let fd; try { fd = await fs.open(location, 'wx', 0o600); await childPrivacy(location); await fd.writeFile(bytes); await fd.sync(); }
    catch (e) { if (e.code !== 'EEXIST') throw e; } finally { if (fd) await fd.close(); }
    await verifyRef(reference); return reference;
  }
  async function quota(s, next) {
    const refs = [next.beforeRef, next.intendedAfterRef, next.observedAfterRef].filter(Boolean);
    if (refs.reduce((n, r) => n + r.bytes, 0) > limits.operationBytes || limits.operationFiles < 1) fail('evidence_quota_exceeded');
    const all = [...records.values()].filter(r => !(scopeKey(r.scope) === scopeKey(s) && r.operationId === next.operationId)); all.push(next);
    const global = new Map(), conversation = new Map();
    for (const name of await fs.readdir(objects)) {
      if (!/^[0-9a-f]{64}$/.test(name)) fail('evidence_integrity_failed');
      const location = path.join(objects, name); await noLinks(location, true); const st = await fs.stat(location); global.set(name, st.size);
    }
    for (const r of all) for (const key of ['beforeRef', 'intendedAfterRef', 'observedAfterRef']) if (r[key]) { global.set(r[key].digest, Math.max(global.get(r[key].digest) || 0, r[key].bytes)); if (scopeKey(r.scope) === scopeKey(s)) conversation.set(r[key].digest, r[key].bytes); }
    if ([...global.values()].reduce((a, b) => a + b, 0) > limits.globalBytes || [...conversation.values()].reduce((a, b) => a + b, 0) > limits.conversationBytes) fail('evidence_quota_exceeded');
  }
  async function capture(s, args, before, prepared) {
    const id = identifier(args.operationId), key = scopeKey(s) + ':' + id, old = records.get(key);
    if (!settings(s).enabled) fail('evidence_consent_required');
    const target = relative(args.path);
    if (settings(s).exclusions.some(p => target === p || target.startsWith(p + '/'))) fail('evidence_path_excluded');
    if (old) { authorized(s, old); if (old.state !== 'begun' || !prepared || old.path !== target || old.toolCallId !== args.toolCallId || JSON.stringify(old.beforeRef) !== JSON.stringify(ref(before))) fail('invalid_evidence_operation'); }
    const record = { operationId: id, parentOperationId: args.parentOperationId == null ? null : identifier(args.parentOperationId),
      toolCallId: toolIdentifier(args.toolCallId), path: target, scope: s, workspaceSequence: old?.workspaceSequence || ws(s).sequence + 1,
      effectiveToolSource: identifier(args.effectiveToolSource), state: prepared ? 'prepared' : 'begun', evidenceLevel: 'incomplete',
      attributionGapRevision: old?.attributionGapRevision ?? ws(s).gapRevision, createdAt: old?.createdAt ?? now(), beforeRef: ref(before), intendedAfterRef: prepared ? ref(args.intendedAfter) : null,
      observedAfterRef: null, toolOutcome: 'pending', mutationOutcome: 'unknown', toolResultObserved: false };
    await quota(s, record); record.beforeRef = await blob(before); if (prepared) record.intendedAfterRef = await blob(args.intendedAfter);
    await append(s, { type: 'operation', record }); return structuredClone(record);
  }
  function summarize(s) {
    const w = ws(s), items = [...records.values()].filter(r => scopeKey(r.scope) === scopeKey(s));
    const operations = items.map(r => ({ operationId: r.operationId, workspaceSequence: r.workspaceSequence, relativePath: r.path, state: r.state,
      // P33.2 has no verified mechanism to end an unknown writer's lifetime.
      evidenceLevel: r.evidenceLevel, eligible: r.evidenceLevel === 'intent_verified' && r.toolResultObserved === true && w.gapRevision === 0 && r.attributionGapRevision === 0 && now() - r.createdAt <= limits.retentionDays * 86400000 }));
    const levels = { intent_verified: 0, incomplete: 0, observed: 0 };
    for (const operation of operations) levels[operation.evidenceLevel] = (levels[operation.evidenceLevel] || 0) + 1;
    return { revision: w.revision, gapRevision: w.gapRevision, operationCount: items.length, eligibleCount: operations.filter(o => o.eligible).length, levels, operations };
  }
  return {
    settings: scope => queue(() => settings(identity(scope))),
    configure: (scope, value) => queue(async () => {
      const s = identity(scope); if (value?.enabled === true && value.acknowledged !== true) fail('evidence_consent_required');
      if (typeof value?.enabled !== 'boolean' || (value.exclusions != null && (!Array.isArray(value.exclusions) || value.exclusions.length > 128))) fail('invalid_evidence_operation');
      const config = { enabled: value.enabled, exclusions: (value.exclusions ?? settings(s).exclusions).map(p => relative(p, true)), retentionDays: limits.retentionDays, noticeVersion: 1 };
      await append(s, { type: 'settings', settings: config }); if (!config.enabled) await append(s, { type: 'gap', reason: 'disabled' }); return { ...config };
    }),
    captureBefore: (scope, args, before) => queue(() => capture(identity(scope), args, before, false)),
    prepare: (scope, args) => queue(() => capture(identity(scope), args, args.before, true)),
    settle: (scope, operationId, value) => queue(async () => {
      const s = identity(scope), key = scopeKey(s) + ':' + identifier(operationId), old = records.get(key);
      if (!old) fail('evidence_not_found'); authorized(s, old); if (!['prepared', 'begun'].includes(old.state)) fail('invalid_evidence_operation');
      const record = { ...old, observedAfterRef: ref(value.observedAfter), toolOutcome: identifier(value.toolOutcome), mutationOutcome: identifier(value.mutationOutcome), state: 'observed', evidenceLevel: 'incomplete', toolResultObserved: false };
      if (old.state === 'prepared' && record.observedAfterRef && record.observedAfterRef.digest === old.intendedAfterRef?.digest && value.evidenceLevel === 'intent_verified') record.evidenceLevel = value.evidenceLevel;
      else record.state = 'incomplete';
      await quota(s, record); record.observedAfterRef = await blob(value.observedAfter); await append(s, { type: 'operation', record });
      if (record.evidenceLevel !== 'intent_verified') await append(s, { type: 'gap', reason: 'incomplete' });
      return structuredClone(record);
    }),
    amendOutcome: (scope, operationId, value) => queue(async () => {
      const s = identity(scope), old = records.get(scopeKey(s) + ':' + identifier(operationId));
      if (!old) fail('evidence_not_found'); authorized(s, old);
      if (!['observed', 'incomplete'].includes(old.state) || !['success', 'error', 'aborted'].includes(value?.toolOutcome)) fail('invalid_evidence_operation');
      const record = { ...old, toolOutcome: old.toolOutcome === 'aborted' ? 'aborted' : value.toolOutcome, toolResultObserved: true };
      await append(s, { type: 'operation', record }); return structuredClone(record);
    }),
    gap: (scope, reason) => queue(async () => { const s = identity(scope); await append(s, { type: 'gap', reason: GAP_REASONS.has(reason) ? reason : 'capture_failed' }); return { gapRevision: ws(s).gapRevision }; }),
    summary: scope => queue(() => summarize(identity(scope))),
    // The backend must authorize this persistent identity before calling it.
    // It grants safe historical metadata only, never mutation or raw blob access.
    summaryPersistent: scope => queue(() => { const s = persistentIdentity(scope); return { ...summarize(s), capture: settings(s) }; }),
    read: (scope, operationId) => queue(async () => {
      const s = identity(scope), record = records.get(scopeKey(s) + ':' + identifier(operationId)); if (!record) fail('evidence_not_found');
      return { ...structuredClone(record), before: await verifyRef(record.beforeRef), intendedAfter: await verifyRef(record.intendedAfterRef), observedAfter: await verifyRef(record.observedAfterRef) };
    }),
  };
}
