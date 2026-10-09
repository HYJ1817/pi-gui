import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { json, readRawBody } from './http-utils.js';
import { runSessionRevert } from './session-revert-compute.js';
import { SESSION_REVERT_REASONS } from '../lib/session-revert.js';
import { createSessionRevertService, revertFileId, safeRevertCode } from './session-revert-service.js';

const DEFAULTS = { maxFiles: 32, maxOperations: 128, rawBytes: 128 * 1024 ** 2, fileBytes: 2 * 1024 ** 2, deadlineMs: 30000, computeMs: 2000, diffBytes: 32 * 1024 };
const REQUIRES = ['metadata_validation', 'prepare_backup', 'confirmation', 'bounded_writer'];
// Admission precedes raw snapshot materialization, not merely worker creation.
let activePreviews = 0;
const REASONS = new Set([...SESSION_REVERT_REASONS, 'unsupported_path', 'oversized', 'diff_budget_exceeded']);
const ERROR_CODES = new Set(['invalid_request', 'active_writer', 'stale_runtime', 'stale_generation', 'stale_workspace', 'workspace_unavailable',
  'invalid_evidence_scope', 'evidence_not_found', 'evidence_integrity_failed', 'evidence_privacy_unavailable', 'evidence_storage_failed',
  'evidence_quota_exceeded', 'stale_evidence', 'stale_current', 'budget_exceeded', 'preview_busy', 'preview_unavailable', 'unsupported_path', 'oversized', 'diff_budget_exceeded']);
const fail = code => { throw Object.assign(Error(code), { code }); };
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const safeCode = e => ERROR_CODES.has(e?.code) ? e.code : 'preview_unavailable';
const strict = () => ({ contentEligible: false, applyEligible: false, reason: 'exclusive_provider_unavailable' });
const limited = (eligible, reason) => ({ contentEligible: eligible, applyEligible: false, reason: eligible ? 'metadata_unsupported' : reason, requires: [...REQUIRES] });
function workspaceIdentity(scope) {
  const owner = scope?.runtimeOwner || scope;
  return JSON.stringify([owner?.projectId, owner?.repoId, scope?.workspaceId, scope?.workspaceEpoch, scope?.workspaceFingerprint ?? null]);
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f:]/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) fail('unsupported_path');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || ['.git', '.pi'].includes(p.toLowerCase()) || /^\.env(?:\.|$)/i.test(p) || /\.(?:pem|key|p12|pfx)$/i.test(p))) fail('unsupported_path');
  return parts.join('/');
}
function identity(stat) { return [stat.dev, stat.ino, stat.birthtimeMs, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink].join(':'); }
async function ancestors(absolute, root) {
  const items = []; let cursor = absolute;
  while (true) {
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || (cursor !== absolute && !stat.isDirectory())) fail('unsupported_path');
      if (cursor === root && !stat.isDirectory()) fail('unsupported_path');
      // Directory modification times change for unrelated children; retain identity only.
      if (cursor !== absolute) items.push([cursor, stat.dev, stat.ino, stat.birthtimeMs, stat.mode].join(':'));
    } catch (e) { if (e.code !== 'ENOENT') throw e; if (cursor === root || path.relative(root, cursor).startsWith('..')) fail('stale_workspace'); }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return JSON.stringify(items);
}
/** Bounded descriptor read; repeated checks detect changes but do not provide OS exclusion. */
async function readCurrent(root, relativePath, fileBytes) {
  const normalized = relative(relativePath), absolute = path.resolve(root, ...normalized.split('/'));
  const parentIdentity = await ancestors(absolute, root);
  let stat;
  try { stat = await fs.lstat(absolute); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return { bytes: null, fingerprint: 'absent:' + parentIdentity }; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('unsupported_path');
  if (stat.size > fileBytes) fail('oversized');
  const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || identity(opened) !== identity(stat)) fail('stale_current');
    // Allocate a fixed bounded buffer, including one overflow byte; never use readFile on an untrusted descriptor.
    const buffer = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > fileBytes) fail('oversized');
    const after = await handle.stat(), linked = await fs.lstat(absolute);
    if (offset !== stat.size || identity(after) !== identity(stat) || identity(linked) !== identity(stat) || linked.isSymbolicLink()
      || await ancestors(absolute, root) !== parentIdentity) fail('stale_current');
    const bytes = buffer.subarray(0, offset);
    return { bytes, fingerprint: identity(after) + ':' + parentIdentity + ':' + createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}
function validBody(body, maxOperations) {
  return closed(body, ['conversationId', 'owner', 'evidenceIds', 'mode', 'includeDiff', 'evidenceRevision'])
    && (body.conversationId === undefined || identifier(body.conversationId))
    && (body.owner === undefined || closed(body.owner, ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId', 'runtimeId', 'runtimeGeneration', 'sessionId'])
      && Object.values(body.owner).every(v => v === null || identifier(v)))
    && Array.isArray(body.evidenceIds) && body.evidenceIds.length > 0 && body.evidenceIds.length <= maxOperations
    && body.evidenceIds.every(identifier) && new Set(body.evidenceIds).size === body.evidenceIds.length
    && ['strict', 'confirmed_limited'].includes(body.mode)
    && (body.includeDiff === undefined || typeof body.includeDiff === 'boolean')
    && (body.evidenceRevision === undefined || Number.isSafeInteger(body.evidenceRevision) && body.evidenceRevision >= 0);
}
// Explicit-only C→R preview. Large diffs are refused as a whole, never truncated into a misleading patch.
function previewDiff(current, candidate, maxBytes) {
  const left = current === null ? '' : current.toString('utf8'), right = candidate === null ? '' : candidate.toString('utf8');
  if (left === right) return { diff: '' };
  const a = left.match(/[^\n]*\n|[^\n]+$/g) || [], b = right.match(/[^\n]*\n|[^\n]+$/g) || [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  let diff = '--- current\n+++ candidate\n@@ -' + (endA === start ? start : start + 1) + ',' + (endA - start) + ' +' + (endB === start ? start : start + 1) + ',' + (endB - start) + ' @@\n';
  for (const [marker, lines] of [['-', a.slice(start, endA)], ['+', b.slice(start, endB)]]) {
    for (const line of lines) {
      if (Buffer.byteLength(diff) + Buffer.byteLength(line) + 32 > maxBytes) return { diffUnavailable: 'diff_budget_exceeded' };
      diff += marker + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
    }
  }
  return { diff };
}
/** Read-only preview. Caller authenticates token/Origin and authorizes the complete current or dormant scope. */
export function createSessionRevertRoutes({ store, withAuthority, withMutationAuthority, writer, budgets = {} } = {}) {
  const limits = Object.fromEntries(Object.entries(DEFAULTS).map(([key, maximum]) => [key, Number.isSafeInteger(budgets[key]) && budgets[key] > 0 ? Math.min(maximum, budgets[key]) : maximum]));
  const service=createSessionRevertService({store,withAuthority,withMutationAuthority,...(writer?{writer}:{})});
  async function handle(req, res, url = new URL(req.url, 'http://localhost')) {
    const endpoint=url.pathname.slice('/api/session-revert/'.length);
    if(['prepare','apply','cancel','recover-preview','export'].includes(endpoint)){
      if(req.method!=='POST')return json(res,405,{ok:false,code:'method_not_allowed'});
      let body;try{body=JSON.parse((await readRawBody(req,16*1024)).toString('utf8'));}catch(e){return json(res,e instanceof SyntaxError?400:413,{ok:false,code:e instanceof SyntaxError?'invalid_request':'request_too_large'});}
      const fields={prepare:['evidenceIds','selectedFileIds','mode','evidenceRevision','sourcePlanId'],
        apply:['planId','requestId','confirmationToken','mode','selectedFileIds','confirmation'],cancel:['planId'],
        'recover-preview':['sourcePlanId','selectedFileIds','includeDiff'],export:['sourcePlanId','fileId','exportName']};
      if(!closed(body,['conversationId','owner',...fields[endpoint]]))return json(res,400,{ok:false,code:'invalid_request'});
      try{
        if(endpoint==='export'){
          const result=await service.exportMaterial(req,body);
          res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="'+result.name+'"',
            'cache-control':'no-store','x-content-type-options':'nosniff','content-length':result.bytes.length});return res.end(result.bytes);
        }
        const methods={prepare:'prepare',apply:'apply',cancel:'cancel','recover-preview':'recoverPreview'};
        return json(res,200,await service[methods[endpoint]](req,body));
      }catch(e){const code=safeRevertCode(e);return json(res,code==='invalid_request'?400:409,{ok:false,code,
        needsRepreview:['stale_evidence','stale_current','stale_runtime','stale_workspace','plan_expired'].includes(code)});}
    }
    if (url.pathname !== '/api/session-revert/preview') return json(res, 404, { ok: false, code: 'not_found' });
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    let body;
    try { body = JSON.parse((await readRawBody(req, 16 * 1024)).toString('utf8')); }
    catch (e) { return json(res, e instanceof SyntaxError ? 400 : 413, { ok: false, code: e instanceof SyntaxError ? 'invalid_request' : 'request_too_large' }); }
    if (!validBody(body, limits.maxOperations)) return json(res, 400, { ok: false, code: 'invalid_request' });
    if (activePreviews >= 2) return json(res, 503, { ok:false, code:'preview_busy', needsRepreview:false });
    activePreviews++;
    // Private ACL/object validation is I/O and may invoke the native platform adapter.
    // Its total request deadline is separate from the shared 2-second computation budget.
    const deadline = Date.now() + limits.deadlineMs; let computeMs = limits.computeMs;
    const checkDeadline = () => { if (Date.now() >= deadline) fail('budget_exceeded'); };
    try {
      const result = await withAuthority(req, body, async authority => {
        const { scope, root } = authority;
        if (!scope || typeof root !== 'string' || !path.isAbsolute(root)) fail('stale_workspace');
        if (authority.activeWriter !== false) fail('active_writer');
        const initialScope = JSON.stringify(scope), resolvedRoot = path.resolve(root);
        const data = typeof store === 'function' ? await store() : store;
        checkDeadline();
        const snapshot = await data.previewSnapshot(scope, { evidenceIds: body.evidenceIds, maxOperations: limits.maxOperations });
        checkDeadline();
        if (!snapshot || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.selectedOperationIds)
          || !Number.isSafeInteger(snapshot.revision) || !Number.isSafeInteger(snapshot.gapRevision)) fail('evidence_integrity_failed');
        if (body.evidenceRevision !== undefined && body.evidenceRevision !== snapshot.revision) fail('stale_evidence');
        if (snapshot.records.length > limits.maxOperations) fail('budget_exceeded');
        const selected = new Set(snapshot.selectedOperationIds), byPath = new Map(); let rawBytes = 0;
        if (selected.size !== body.evidenceIds.length || body.evidenceIds.some(id => !selected.has(id))) fail('evidence_integrity_failed');
        for (const record of snapshot.records) {
          if (workspaceIdentity(record.scope) !== workspaceIdentity(scope)) fail('invalid_evidence_scope');
          for (const key of ['before', 'intendedAfter', 'observedAfter']) {
            if (record[key] !== null && !Buffer.isBuffer(record[key])) fail('evidence_integrity_failed');
            rawBytes += record[key]?.length || 0;
            if (rawBytes > limits.rawBytes) fail('budget_exceeded');
          }
          if (!byPath.has(record.path)) byPath.set(record.path, []);
          byPath.get(record.path).push(record);
        }
        if (byPath.size > limits.maxFiles) fail('budget_exceeded');
        if (body.evidenceIds.some(id => !snapshot.records.some(r => r.operationId === id))) fail('evidence_not_found');
        const files = [], currents = []; let diffBytes = limits.diffBytes;
        for (const [target, records] of byPath) {
          checkDeadline();
          let publicPath = null, outcome, current;
          try {
            publicPath = relative(target);
            current = await readCurrent(resolvedRoot, publicPath, limits.fileBytes);
            checkDeadline();
            if (computeMs <= 0) fail('diff_budget_exceeded');
            const started = Date.now();
            outcome = await runSessionRevert({ records, selectedOperationIds: records.filter(r => selected.has(r.operationId)).map(r => r.operationId),
              current: current.bytes, gapRevision: snapshot.gapRevision, now: Date.now(), budgets: { maxBytes: limits.fileBytes, maxMs: Math.min(750, computeMs, Math.max(1, deadline - started)) } },
              { timeoutMs: Math.min(computeMs, Math.max(1, deadline - started)) });
            computeMs -= Date.now() - started;
            if (outcome?.reason === 'preview_busy') fail('preview_busy');
            if (outcome?.reason === 'compute_unavailable') fail('preview_unavailable');
            if (outcome?.reason === 'diff_budget_exceeded') fail('diff_budget_exceeded');
            if (outcome?.reason === 'budget_exceeded') outcome.reason = 'diff_budget_exceeded';
            checkDeadline();
            currents.push({ relativePath: publicPath, fingerprint: current.fingerprint });
          } catch (e) {
            const code = safeCode(e);
            if (!['unsupported_path', 'budget_exceeded', 'oversized', 'diff_budget_exceeded'].includes(code)) throw e;
            outcome = { status: 'refused', reason: code, contentEligible: false, action: 'none', operationIds: records.filter(r => selected.has(r.operationId)).map(r => r.operationId), conflictOperationIds: [], evidenceLevel: 'incomplete' };
          }
          if (!['candidate', 'already_reverted', 'refused'].includes(outcome.status) || !(outcome.reason === null || REASONS.has(outcome.reason))
            || !['replace', 'move_to_recovery', 'none'].includes(outcome.action) || typeof outcome.contentEligible !== 'boolean'
            || !Array.isArray(outcome.operationIds) || !outcome.operationIds.every(identifier)
            || !Array.isArray(outcome.conflictOperationIds) || !outcome.conflictOperationIds.every(identifier)
            || !(outcome.evidenceLevel === null || ['intent_verified', 'exclusive_verified', 'observed', 'incomplete', 'unsupported'].includes(outcome.evidenceLevel))) fail('preview_unavailable');
          const file = { fileId:publicPath?revertFileId(scope,publicPath):null, relativePath: publicPath, status: outcome.status, reason: outcome.reason, action: outcome.action,
            operationIds: outcome.operationIds, conflictOperationIds: outcome.conflictOperationIds, evidenceLevel: outcome.evidenceLevel,
            contentEligible: outcome.contentEligible, strict: strict(), limited: limited(outcome.contentEligible, outcome.reason) };
          if (outcome.contentEligible && current) file.changeSummary = {
            currentBytes: current.bytes?.length ?? null,
            candidateBytes: outcome.status === 'already_reverted' ? current.bytes?.length ?? null : outcome.candidate?.length ?? null,
            selectedOperationCount: outcome.operationIds.length, action: outcome.action,
          };
          if (body.includeDiff === true && outcome.contentEligible && current) {
            const diff = previewDiff(current.bytes, outcome.status === 'already_reverted' ? current.bytes : outcome.candidate, diffBytes);
            Object.assign(file, diff); diffBytes -= Buffer.byteLength(diff.diff || '');
          }
          files.push(file);
        }
        checkDeadline();
        // Revalidate while the existing workspace lifecycle authority remains held; do not acquire it recursively.
        if (authority.revalidate) await authority.revalidate();
        if (JSON.stringify(scope) !== initialScope || path.resolve(authority.root) !== resolvedRoot || authority.activeWriter !== false) fail('stale_runtime');
        const revision = await data.previewRevision(scope);
        if (revision.revision !== snapshot.revision || revision.gapRevision !== snapshot.gapRevision) fail('stale_evidence');
        for (const current of currents) {
          checkDeadline();
          const fresh = await readCurrent(resolvedRoot, current.relativePath, limits.fileBytes);
          if (fresh.fingerprint !== current.fingerprint) fail('stale_current');
        }
        if (authority.revalidate) await authority.revalidate();
        if (JSON.stringify(scope) !== initialScope || path.resolve(authority.root) !== resolvedRoot || authority.activeWriter !== false) fail('stale_runtime');
        const finalRevision = await data.previewRevision(scope);
        if (finalRevision.revision !== snapshot.revision || finalRevision.gapRevision !== snapshot.gapRevision) fail('stale_evidence');
        checkDeadline();
        const contentEligible = files.length > 0 && files.every(file => file.contentEligible);
        return { ok: true, mode: body.mode, target: { conversationId: scope.conversationId, workspaceId: scope.workspaceId, workspaceEpoch: scope.workspaceEpoch },
          revision: snapshot.revision, gapRevision: snapshot.gapRevision, retentionDays: 7, files, strict: strict(),
          limited: limited(contentEligible, files.find(file => !file.contentEligible)?.reason || 'no_evidence'),
          backupReady: false, needsRepreview: false, externalConcurrencyUnexcluded: true };
      });
      return json(res, 200, result);
    } catch (e) {
      const code = safeCode(e);
      return json(res, code === 'preview_unavailable' || code === 'preview_busy' ? 503 : 409,
        { ok: false, code, needsRepreview: ['stale_evidence', 'stale_current', 'stale_runtime', 'stale_generation', 'stale_workspace'].includes(code) });
    } finally { activePreviews--; }
  }
  return { handle, dispose:service.dispose };
}
