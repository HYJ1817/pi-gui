import { json, readRawBody } from './http-utils.js';
import { isHtmlArtifactId } from '../public/html-artifact-model.js';
import { htmlReferencesInPath, sameHtmlReference } from './html-artifact-projection.js';
import { readHtmlArtifactSession, htmlSessionIdentity } from './html-artifact-sessions.js';

const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const equal = (a, b) => Boolean(a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && a[key] === b[key]));
const fail = code => { throw Object.assign(Error('HTML visualization unavailable.'), { code }); };
const identityOf = value => JSON.stringify([value?.sessionId, value?.sessionLocator, value?.sessionIdentity, value?.cwd, value?.locator]);
const cut = (entries, branchEpoch, leafId) => ({ entries, key: JSON.stringify([branchEpoch, leafId]) });

// All paths/owners are resolved on the server. A caller's reference is never
// evidence: only a native typed result on the verified requested branch grants
// a read. Revalidation must prove the same branch cut after storage IO as well.
export function createHtmlArtifactAuthority({ registry, sessions, getClassicOwner, getClassicCwd, readClassicBranch } = {}) {
  function classicReader(owner) {
    return async () => {
      if (!equal(owner, getClassicOwner())) fail('stale_runtime');
      let path = null;
      const branch = await readClassicBranch(owner, entries => { path = entries; });
      if (!equal(owner, getClassicOwner())) fail('stale_runtime');
      if (!branch || !path) fail('reference_pending');
      return cut(path, branch.branchEpoch, branch.leafId);
    };
  }
  return async scope => {
    if (!closed(scope, ['conversationId', 'owner', 'sessionId'])) fail('invalid_request');
    if (scope.conversationId !== undefined) {
      if (typeof scope.conversationId !== 'string' || !scope.conversationId || scope.conversationId.length > 160 || scope.sessionId !== undefined) fail('invalid_request');
      const classic = getClassicOwner();
      if (scope.conversationId === classic?.conversationId) {
        if (!equal(scope.owner, classic)) fail('stale_runtime');
        return classicReader(classic);
      }
      const owner = registry.getOwner(scope.conversationId);
      if (owner) {
        if (!equal(scope.owner, owner)) fail('stale_runtime');
        return async () => {
          if (!equal(owner, registry.getOwner(scope.conversationId))) fail('stale_runtime');
          let path = null;
          const branch = await registry.executionBranch(owner, null, entries => { path = entries; });
          if (!equal(owner, registry.getOwner(scope.conversationId))) fail('stale_runtime');
          if (!branch || !path) fail('reference_pending');
          return cut(path, branch.branchEpoch, branch.leafId);
        };
      }
      if (scope.owner !== undefined) fail('stale_runtime');
      const target = registry.historyTarget(scope.conversationId);
      if (!target?.sessionLocator || !target.sessionIdentity) fail('reference_pending');
      const identity = identityOf(target);
      return async () => {
        const current = () => !registry.getOwner(scope.conversationId) && identityOf(registry.historyTarget(scope.conversationId)) === identity;
        if (!current()) fail('stale_runtime');
        // A file cannot prove the in-memory leaf of another live child.
        if (registry.ownsNativeSession(target.sessionId) || getClassicOwner()?.sessionId === target.sessionId) fail('reference_pending');
        const native = readHtmlArtifactSession(target.sessionLocator, target);
        if (!current()) fail('stale_runtime');
        if (!native) fail('reference_pending');
        return cut(native.branch, identity, native.leafId);
      };
    }
    const owner = getClassicOwner();
    if (scope.owner !== undefined && !equal(scope.owner, owner)) fail('stale_runtime');
    if (typeof scope.sessionId !== 'string' || !/^[a-f0-9]{16}$/.test(scope.sessionId)) fail('invalid_request');
    const cwd = getClassicCwd(), target = sessions.resolveProjectSession(scope.sessionId, cwd);
    if (!target) fail('reference_pending');
    if (target.sessionId === owner?.sessionId) return classicReader(owner);
    const sessionIdentity = htmlSessionIdentity(target.file);
    return async () => {
      const current = sessions.resolveProjectSession(scope.sessionId, cwd);
      if (getClassicCwd() !== cwd || !equal(owner, getClassicOwner()) || !current || current.file !== target.file || current.sessionId !== target.sessionId) fail('stale_runtime');
      if (registry.ownsNativeSession(target.sessionId)) fail('reference_pending');
      const native = readHtmlArtifactSession(target.file, { cwd: target.cwd, sessionId: target.sessionId, sessionIdentity });
      if (!native) fail('reference_pending');
      return cut(native.branch, JSON.stringify(sessionIdentity), native.leafId);
    };
  };
}

export function createHtmlArtifactHttp({ store, resolveScope } = {}) {
  return { async handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'invalid_request' });
    try {
      let body;
      try { body = JSON.parse((await readRawBody(req, 8192)).toString('utf8')); }
      catch { fail('invalid_request'); }
      if (!closed(body, ['id', 'scope']) || !isHtmlArtifactId(body.id)) fail('invalid_request');
      const readPath = await resolveScope(body.scope), first = await readPath();
      const reference = htmlReferencesInPath(first.entries).find(ref => ref.id === body.id);
      // Same non-oracular code for absent, foreign and not-yet-native results.
      if (!reference) fail('reference_pending');
      const snapshot = await store.read(body.id);
      if (!sameHtmlReference(reference, snapshot?.artifact)) fail('html_store_unavailable');
      const last = await readPath();
      if (first.key !== last.key || !htmlReferencesInPath(last.entries).some(ref => sameHtmlReference(ref, reference))) fail('reference_pending');
      return json(res, 200, { ok: true, artifact: snapshot.artifact, html: snapshot.html });
    } catch (error) {
      const code = ['invalid_request', 'stale_runtime', 'reference_pending'].includes(error?.code) ? error.code : 'html_store_unavailable';
      return json(res, code === 'invalid_request' ? 400 : 409, { ok: false, code });
    }
  } };
}
