import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const fail = code => { throw Object.assign(Error(code), { code }); };
const equal = (left, right) => left && right && Object.keys(left).length === Object.keys(right).length
  && Object.keys(right).every(key => left[key] === right[key]);

/** Reuses P32 authority; never resolves a path or native session from the client. */
export function createSessionRevertAuthority({ classicBridge, classicOwner, classicNativeState, classicBusy, registry, worktrees, classicRoot = () => null }) {
  const itemFor = id => registry.snapshot().items.find(item => item.conversationId === id);
  const overlaps = (a,b) => {
    if (!a || !b) return false;
    const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    const inside = (x,y) => {const p=path.relative(normalize(x),normalize(y));return !p || p!=='..'&&!p.startsWith('..'+path.sep)&&!path.isAbsolute(p);};
    return inside(a,b)||inside(b,a);
  };
  const busyIn = (scope,root) => Boolean(overlaps(root,classicRoot()) && classicBusy()) || registry.snapshot().items.some(item => (item.workspace?.workspaceId === scope.workspaceId || overlaps(root,item.workspace?.root))
    && item.owner && (item.activity !== 'idle' || item.lifecycle !== 'ready'));
  return async (req, body, action, { allowActiveWriter = false } = {}) => {
    if (!body.conversationId || body.conversationId === 'classic-chat') {
      let expected = body.owner;
      if (!expected) { try { expected = JSON.parse(req.headers['x-pi-gui-owner'] || 'null'); } catch { fail('stale_runtime'); } }
      if (!equal(expected, classicOwner())) fail('stale_runtime');
      return classicBridge.withEvidenceAuthority(async (scope, workspace) => {
        if (!equal(expected, scope.runtimeOwner)) fail('stale_runtime');
        const revalidate = async () => {
          const state = await classicNativeState();
          if (state?.sessionId !== scope.nativeSessionId || !equal(expected, classicOwner())) fail('stale_runtime');
          if (!allowActiveWriter && (classicBusy() || busyIn(scope,workspace.root))) fail('active_writer');
        };
        return action({ scope, root:workspace.root, activeWriter:Boolean(classicBusy() || busyIn(scope,workspace.root)), revalidate,
          ...(allowActiveWriter?{capture:await classicBridge.captureStatus?.(scope)}:{}) });
      });
    }
    const item = itemFor(body.conversationId);
    if (item?.owner) {
      if (!equal(body.owner, item.owner)) fail('stale_runtime');
      const expected = item.owner, adapter = registry.getAdapter(expected);
      return adapter.changes.withEvidenceAuthority(async (scope, workspace) => {
        if (!equal(expected, scope.runtimeOwner) || scope.conversationId !== body.conversationId) fail('stale_runtime');
        const revalidate = async () => {
          if (!equal(itemFor(body.conversationId)?.owner, expected)) fail('stale_runtime');
          const state = await adapter.request({ type:'get_state' });
          if (state?.sessionId !== scope.nativeSessionId || !equal(itemFor(body.conversationId)?.owner, expected)) fail('stale_runtime');
          if (!allowActiveWriter && busyIn(scope,workspace.root)) fail('active_writer');
        };
        return action({ scope, root:workspace.root, activeWriter:busyIn(scope,workspace.root), revalidate,
          ...(allowActiveWriter?{capture:await adapter.changes.captureStatus?.(scope)}:{}) });
      });
    }
    if (body.owner) fail('stale_runtime');
    const target = registry.historyTarget(body.conversationId), identity = registry.workspaceIdentityOf(body.conversationId);
    if (!target?.sessionId || !identity) fail('evidence_not_found');
    return worktrees.withWorkspace(identity, async workspace => {
      const stat = await fs.stat(workspace.root);
      const scope = { projectId:workspace.projectId, repoId:workspace.repoId, workspaceId:workspace.workspaceId,
        workspaceEpoch:workspace.workspaceEpoch, conversationId:body.conversationId, nativeSessionId:target.sessionId,
        workspaceFingerprint:createHash('sha256').update(JSON.stringify([stat.dev,stat.ino,stat.birthtimeMs])).digest('hex') };
      const revalidate = async () => {
        if (itemFor(body.conversationId)?.owner) fail('stale_runtime');
        if (!equal(registry.workspaceIdentityOf(body.conversationId), identity)) fail('stale_workspace');
        if (registry.historyTarget(body.conversationId)?.sessionId !== target.sessionId) fail('stale_runtime');
        if (!allowActiveWriter && busyIn(scope,workspace.root)) fail('active_writer');
      };
      return action({ scope, root:workspace.root, activeWriter:busyIn(scope,workspace.root), revalidate });
    });
  };
}

/** Resolve and release lifecycle authority BEFORE Stop: extension settle needs it. */
export function createSessionRevertMutationAuthority({ withAuthority, admission, stopAndDrain }) {
  return async (req, body, action, { lease: suppliedLease } = {}) => {
    const first = await withAuthority(req, body, authority => ({ root: authority.root, scope: authority.scope, contextRevision: authority.contextRevision }));
    const lease = suppliedLease || admission.acquire(first.root);
    try {
      lease.assertCurrent(first.root);
      await stopAndDrain(first.root);
      await lease.drain();
      return await withAuthority(req, body, async authority => {
        lease.assertCurrent(authority.root);
        if (first.contextRevision !== authority.contextRevision) fail('stale_runtime');
        if (!equal({ ...first.scope, runtimeOwner: undefined }, { ...authority.scope, runtimeOwner: undefined })
          || Boolean(first.scope.runtimeOwner) !== Boolean(authority.scope.runtimeOwner)
          || (first.scope.runtimeOwner && !equal(first.scope.runtimeOwner, authority.scope.runtimeOwner))) fail('stale_runtime');
        await authority.revalidate();
        return action({ ...authority, lease });
      });
    } catch (error) { lease.release(); throw error; }
  };
}
