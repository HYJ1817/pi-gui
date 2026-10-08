import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(Error(code), { code }); };
const equal = (left, right) => left && right && Object.keys(left).length === Object.keys(right).length
  && Object.keys(right).every(key => left[key] === right[key]);

/** Reuses P32 authority; never resolves a path or native session from the client. */
export function createSessionRevertAuthority({ classicBridge, classicOwner, classicNativeState, classicBusy, registry, worktrees }) {
  const itemFor = id => registry.snapshot().items.find(item => item.conversationId === id);
  const busyIn = scope => registry.snapshot().items.some(item => item.workspace?.workspaceId === scope.workspaceId
    && item.owner && (item.activity !== 'idle' || item.lifecycle !== 'ready'));
  return async (req, body, action) => {
    if (!body.conversationId || body.conversationId === 'classic-chat') {
      let expected = body.owner;
      if (!expected) { try { expected = JSON.parse(req.headers['x-pi-gui-owner'] || 'null'); } catch { fail('stale_runtime'); } }
      if (!equal(expected, classicOwner())) fail('stale_runtime');
      return classicBridge.withEvidenceAuthority(async (scope, workspace) => {
        if (!equal(expected, scope.runtimeOwner)) fail('stale_runtime');
        const revalidate = async () => {
          const state = await classicNativeState();
          if (state?.sessionId !== scope.nativeSessionId || !equal(expected, classicOwner())) fail('stale_runtime');
          if (classicBusy() || busyIn(scope)) fail('active_writer');
        };
        return action({ scope, root:workspace.root, activeWriter:Boolean(classicBusy() || busyIn(scope)), revalidate });
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
          if (busyIn(scope)) fail('active_writer');
        };
        return action({ scope, root:workspace.root, activeWriter:busyIn(scope), revalidate });
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
        if (busyIn(scope)) fail('active_writer');
      };
      return action({ scope, root:workspace.root, activeWriter:busyIn(scope), revalidate });
    });
  };
}
