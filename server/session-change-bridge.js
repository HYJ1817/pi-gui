import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { materializeDir } from '../lib/assets.js';
import { json, readRawBody } from './http-utils.js';

const LIMIT = 2 * 1024 ** 2;
const fail = code => { throw Object.assign(Error(code), { code }); };
const safe = e => new Set(['unauthorized', 'stale_generation', 'invalid_request', 'source_unverified', 'evidence_consent_required',
  'evidence_path_excluded', 'unsupported_evidence_path', 'evidence_quota_exceeded', 'evidence_integrity_failed',
  'evidence_privacy_unavailable', 'evidence_not_found']).has(e?.code) ? e.code : 'capture_unavailable';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const id = v => typeof v === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(v);
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
function bytes(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > Math.ceil(LIMIT / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)) fail('invalid_request');
  const raw = Buffer.from(v, 'base64'); if (raw.length > LIMIT || raw.toString('base64') !== v) fail('evidence_quota_exceeded'); return raw;
}

// Authority comes from the registry/activation gate, never from the wire path.
export async function evidenceTarget(root, absolute, exclusions = []) {
  if (typeof root !== 'string' || typeof absolute !== 'string' || !path.isAbsolute(absolute)) fail('unsupported_evidence_path');
  const rel = path.relative(root, absolute), parts = rel.split(path.sep);
  if (!rel || path.isAbsolute(rel) || parts.some(p => !p || p === '.' || p === '..' || /[\x00-\x1f\x7f:]/.test(p))) fail('unsupported_evidence_path');
  const relative = parts.join('/'), lower = relative.toLowerCase();
  if (parts.some(p => ['.git', '.pi'].includes(p.toLowerCase())) || parts.some(p => /^\.env(?:\.|$)/i.test(p) || /\.(?:pem|key|p12|pfx)$/i.test(p))
    || exclusions.some(p => lower === p.toLowerCase() || lower.startsWith(p.toLowerCase() + '/'))) fail('evidence_path_excluded');
  // Reject links and hardlinked targets. Also check every existing ancestor,
  // including ancestors above the workspace, rather than trusting realpath alone.
  let cursor = path.resolve(absolute);
  while (true) {
    try {
      const st = await fs.lstat(cursor);
      if (st.isSymbolicLink() || (cursor === path.resolve(absolute) && (!st.isFile() || st.nlink !== 1 || st.size > LIMIT))) fail('unsupported_evidence_path');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return relative;
}

/** One private capability per child launch. Raw bytes never enter public events. */
export function createSessionChangeBridge({ store, launch, resolveScope, withAuthority, extensionPath, supported, notify = () => {} } = {}) {
  let server = null, token = null, url = null, disposed = false, sourceVerified = false, reason = 'extension_unavailable', userDisabled = null;
  let sourceGapPending = false;
  let queue = Promise.resolve();
  const serial = action => { const result = queue.catch(() => {}).then(action); queue = result.catch(() => {}); return result; };
  const getStore = async () => typeof store === 'function' ? store() : store;
  const persistentKey = scope => JSON.stringify([scope.runtimeOwner.projectId, scope.runtimeOwner.repoId, scope.workspaceId,
    scope.workspaceEpoch, scope.conversationId, scope.nativeSessionId, scope.workspaceFingerprint]);
  async function capable() {
    if (supported !== undefined) return supported;
    try {
      const dir = launch.packageDir(), pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
      const exports = await fs.readFile(path.join(dir, 'dist/index.d.ts'), 'utf8');
      // Explicitly verified version. New versions need the real dispatcher proof again.
      return pkg.version === '1.0.4' && ['createWriteToolDefinition', 'createEditToolDefinition'].every(n => exports.includes(n));
    } catch { return false; }
  }
  async function scoped(nativeSessionId, action, noStore = false) {
    return withAuthority(async workspace => {
      let scope = await resolveScope();
      if (!scope || !id(scope.nativeSessionId) || (nativeSessionId !== undefined && nativeSessionId !== scope.nativeSessionId)) fail('stale_generation');
      const root = await fs.stat(workspace.root);
      scope = { ...scope, workspaceFingerprint: createHash('sha256').update(JSON.stringify([root.dev, root.ino, root.birthtimeMs])).digest('hex') };
      return action(noStore ? null : await getStore(), scope, workspace);
    });
  }
  async function state(nativeSessionId) {
    return scoped(nativeSessionId, async (_data, scope) => ({ ok: true,
      ...(userDisabled === persistentKey(scope) ? { enabled: false, exclusions: [] } : await (await getStore()).settings(scope)),
      sourceVerified, reason, externalConcurrencyUnexcluded: true }), true);
  }
  async function disable(nativeSessionId) {
    return scoped(nativeSessionId, async (_data, scope) => {
      userDisabled = persistentKey(scope);
      try { await (await getStore()).configure(scope, { enabled: false, acknowledged: false }); reason = 'disabled'; }
      catch {
        reason = 'disabled_not_persisted';
        notify({ type: 'extension_ui_request', method: 'notify', notifyType: 'warning',
          message: '本次运行已关闭文件采集，但无法保存设置。重启后请再次关闭采集；这段修改没有撤销证据。' });
      }
      return { ok: true, enabled: false, persisted: reason !== 'disabled_not_persisted', reason };
    }, true);
  }
  async function action(endpoint, body) {
    return scoped(body.nativeSessionId, async (data, scope, workspace) => {
      if (endpoint === '/hello') {
        if (!closed(body, ['nativeSessionId', 'sources', 'version']) || body.version !== 1 || !closed(body.sources, ['write', 'edit'])) fail('invalid_request');
        const verified = body.sources.write === 'own' && body.sources.edit === 'own';
        if (!verified || sourceGapPending) await data.gap(scope, sourceGapPending ? 'extension_unavailable' : 'source_changed');
        sourceGapPending = false; sourceVerified = verified; reason = sourceVerified ? null : 'source_unverified';
        return { ok: true, sourceVerified };
      }
      if (endpoint === '/configure') {
        if (!closed(body, ['nativeSessionId', 'enabled', 'acknowledged', 'exclusions']) || typeof body.enabled !== 'boolean') fail('invalid_request');
        if (body.enabled && body.acknowledged !== true) fail('evidence_consent_required');
        if (body.enabled && !sourceVerified) fail('source_unverified');
        const result = await data.configure(scope, body); userDisabled = null;
        return { ok: true, ...result };
      }
      if (endpoint === '/gap') {
        if (!closed(body, ['nativeSessionId', 'reason'])) fail('invalid_request');
        return { ok: true, ...await data.gap(scope, body.reason) };
      }
      if (endpoint === '/policy') {
        if (!closed(body, ['nativeSessionId', 'path'])) fail('invalid_request');
        if (!sourceVerified) fail('source_unverified');
        const config = await data.settings(scope); if (!config.enabled) fail('evidence_consent_required');
        await evidenceTarget(workspace.root, body.path, config.exclusions);
        return { ok: true };
      }
      if (endpoint === '/before' || endpoint === '/prepare') {
        if (!closed(body, ['nativeSessionId', 'operationId', 'parentOperationId', 'toolCallId', 'path', 'before', 'intendedAfter', 'effectiveToolSource'])
          || !id(body.operationId) || (body.parentOperationId !== null && !id(body.parentOperationId)) || typeof body.toolCallId !== 'string' || body.toolCallId.length > 256
          || body.effectiveToolSource !== 'pi-gui-revert') fail('invalid_request');
        if (!sourceVerified) fail('source_unverified');
        const config = await data.settings(scope); if (!config.enabled) fail('evidence_consent_required');
        const relative = await evidenceTarget(workspace.root, body.path, config.exclusions);
        const before = bytes(body.before), args = { operationId: body.operationId, parentOperationId: body.parentOperationId,
          toolCallId: body.toolCallId, path: relative, before, effectiveToolSource: body.effectiveToolSource };
        if (endpoint === '/before') await data.captureBefore(scope, args, before);
        else await data.prepare(scope, { ...args, intendedAfter: bytes(body.intendedAfter) });
        return { ok: true };
      }
      if (endpoint === '/settle') {
        if (!closed(body, ['nativeSessionId', 'operationId', 'observedAfter', 'toolOutcome', 'mutationOutcome', 'evidenceLevel']) || !id(body.operationId)
          || !['success', 'error', 'aborted'].includes(body.toolOutcome) || !['unchanged', 'written', 'unknown'].includes(body.mutationOutcome)
          || !['intent_verified', 'incomplete'].includes(body.evidenceLevel)) fail('invalid_request');
        await data.settle(scope, body.operationId, { observedAfter: bytes(body.observedAfter), toolOutcome: body.toolOutcome,
          mutationOutcome: body.mutationOutcome, evidenceLevel: sourceVerified ? body.evidenceLevel : 'incomplete' });
        return { ok: true };
      }
      if (endpoint === '/outcome') {
        if (!closed(body, ['nativeSessionId', 'operationId', 'toolOutcome']) || !id(body.operationId)
          || !['success', 'error', 'aborted'].includes(body.toolOutcome)) fail('invalid_request');
        await data.amendOutcome(scope, body.operationId, { toolOutcome: body.toolOutcome });
        return { ok: true };
      }
      fail('invalid_request');
    });
  }
  async function privateRoute(req, res) {
    const admitted = token;
    if (!token || req.headers.origin || !same(req.headers['x-pi-session-change-token'], token)) return json(res, 403, { ok: false, code: 'unauthorized' });
    try {
      if (req.method !== 'POST') fail('invalid_request');
      const body = JSON.parse((await readRawBody(req, 6 * 1024 ** 2)).toString('utf8'));
      if (admitted !== token || disposed) fail('stale_generation');
      const result = await serial(async () => {
        if (admitted !== token || disposed) fail('stale_generation');
        if (req.url === '/configure' && body.enabled === false) {
          if (!closed(body, ['nativeSessionId', 'enabled', 'acknowledged', 'exclusions'])) fail('invalid_request');
          return disable(body.nativeSessionId);
        }
        return req.url === '/state' ? state(body.nativeSessionId) : action(req.url, body);
      });
      if (admitted !== token) fail('stale_generation');
      return json(res, 200, result);
    } catch (e) { return json(res, 409, { ok: false, code: safe(e) }); }
  }
  return {
    // Prepare is deliberately always attempted, including unsupported versions:
    // disabled capture keeps chat usable; enabled capture is guarded separately.
    available: () => true,
    report: () => ({ bundled: true, bridgeReady: Boolean(token), sourceVerified, reason }),
    async prepare() {
      token = null; sourceVerified = false; userDisabled = null; reason = 'extension_unavailable';
      if (disposed) return null;
      if (!await capable()) { reason = 'pi_api_unverified'; return null; }
      if (!server) {
        server = http.createServer(privateRoute); server.requestTimeout = 10000; server.headersTimeout = 10000;
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        url = `http://127.0.0.1:${server.address().port}`;
      }
      token = randomUUID();
      let publicApi;
      if (supported === true) publicApi = pathToFileURL(path.join(launch.packageDir(), 'dist/index.js')).href;
      else {
        const packageDir = launch.packageDir(), pkg = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
        const entry = pkg.exports?.['.']?.import;
        if (entry !== './dist/index.js') { token = null; reason = 'pi_api_unverified'; return null; }
        publicApi = pathToFileURL(path.join(packageDir, entry)).href;
      }
      return { args: ['--extension', extensionPath || path.join(materializeDir('extensions/pi-gui-revert'), 'index.js')],
        env: { PI_GUI_SESSION_CHANGE_URL: url, PI_GUI_SESSION_CHANGE_TOKEN: token, PI_GUI_SESSION_CHANGE_API: publicApi } };
    },
    disable,
    async assertReady() { const value = await state(); if (value.enabled && !sourceVerified) fail('source_unverified'); },
    async summary() {
      try { return await scoped(undefined, async (data, scope) => ({ ok: true, capture: { enabled: userDisabled !== persistentKey(scope) && (await data.settings(scope)).enabled,
        retentionDays: 7, noticeVersion: 1 }, sourceVerified, reason,
        ...await data.summary(scope), externalConcurrencyUnexcluded: true })); }
      catch (e) { return { ok: false, capture: { status: 'unknown' }, sourceVerified: false, reason: safe(e), operationCount: 0 }; }
    },
    observe(event) {
      if (event?.type === 'extension_error') {
        sourceVerified = false; sourceGapPending = true; reason = 'extension_unavailable';
        void scoped(undefined, (data, scope) => data.gap(scope, 'extension_unavailable')).catch(() => {});
      }
      if (event?.type === 'tool_execution_start' && !['write', 'edit', 'read', 'ls', 'grep', 'find'].includes(event.toolName))
        void scoped(undefined, (data, scope) => data.gap(scope, 'unknown_tool')).catch(() => {});
    },
    async invalidate() { token = null; userDisabled = null; sourceVerified = false; reason = 'extension_unavailable'; },
    async dispose() {
      disposed = true; token = null; sourceVerified = false; await queue.catch(() => {});
      if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
