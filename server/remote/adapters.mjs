/**
 * Remote v1 domain adapters — the project/conversation/approval surface the
 * gateway dispatches to. These wrap the desktop's existing stores and the
 * runtimeRegistry; they never fabricate a domain truth — every handler re-reads
 * the live store so a local mutation (remove a project, close a conversation,
 * resolve an approval) is reflected in the next remote call.
 *
 * Owner resolution: a remote conversationId is a registry conversation; the
 * adapters re-resolve it to the registry's typed `owner` object (projectId,
 * workspaceId, workspaceEpoch, conversationId, sessionId, runtimeId,
 * runtimeGeneration) via `snapshot()` before invoking a registry action. That
 * typed owner is the same authority the local UI uses, so owner/namespace
 * checks are one mechanism, not two.
 */
import crypto from 'node:crypto';
import { isRecord } from './contract.mjs';
import { requiredEventScope } from './contract.mjs';

function deny(status, code, retryable = false) { return { denied: { status, code, retryable } }; }
function ok(body, status = 200) { return { status, body }; }

export function buildAdapters({ projects, runtimeRegistry, ordinarySessions, stream }) {
  // projectId (remote opaque) -> { workspaceId, epoch, path }
  // Populated by the pairing/grants step; re-verified per call against the live
  // projects.read() list so a removed project stops resolving.
  const projectIndex = new Map();
  const pathIndex = new Map();
  function projectIdFor(path, workspaceId, epoch) {
    if (pathIndex.has(path)) return pathIndex.get(path);
    const id = 'p-' + crypto.createHash('sha256').update(path).digest('base64url').slice(0, 12);
    projectIndex.set(id, { workspaceId, epoch, path });
    pathIndex.set(path, id);
    return id;
  }
  function projectEntry(projectId) { return projectIndex.get(projectId) ?? null; }
  function grantedPaths(device) {
    const out = [];
    for (const p of (projects.read().items ?? [])) {
      const id = pathIndex.get(p.path) ?? projectIdFor(p.path, p.workspaceId ?? p.path, p.workspaceEpoch ?? 0);
      if ((device.grants ?? {})[id]) out.push({ projectId: id, project: p });
    }
    return out;
  }
  // Resolve a conversationId to its current owner record (or null).
  function ownerFor(conversationId) {
    const snap = runtimeRegistry.snapshot();
    const item = (snap.items ?? []).find(i => i.conversationId === conversationId);
    return item ? { item, owner: item.owner } : null;
  }
  function deviceOwnsConversation(device, conversationId) {
    const o = ownerFor(conversationId);
    if (!o) return false;
    const ws = o.item.workspace ?? {};
    // A project grant maps to a path; the conversation must live under a granted path.
    for (const { projectId } of grantedPaths(device)) {
      const entry = projectEntry(projectId);
      if (entry && entry.workspaceId && ws.workspaceId === entry.workspaceId) return true;
      if (entry && ws.cwd && ws.cwd === entry.path) return true;
    }
    return false;
  }
  function conversationProjectId(conversationId) {
    const o = ownerFor(conversationId);
    if (!o) return null;
    const ws = o.item.workspace ?? {};
    for (const [id, entry] of projectIndex.entries()) {
      if (entry.workspaceId === ws.workspaceId || entry.path === ws.cwd) return id;
    }
    return null;
  }

  async function invokeOwner(conversationId, fn) {
    const o = ownerFor(conversationId);
    if (!o || !o.owner) return deny(404, 'unknown_resource');
    try { return await fn(o); }
    catch (e) {
      const code = e?.code;
      if (code === 'stale_runtime' || code === 'stale_workspace' || code === 'unknown_conversation') return deny(404, 'unknown_resource');
      if (code === 'runtime_busy' || code === 'edit_in_progress' || code === 'stop_in_progress' || code === 'maintenance') return deny(409, 'operation_rejected', true);
      return deny(503, 'unavailable', true);
    }
  }

  return {
    // Remote-visible surface the gateway can introspect for contract conformance.
    projectIdFor, ownerFor, deviceOwnsConversation, conversationProjectId,
    projects: {
      list: async ({ device }) => {
        const items = [];
        for (const { projectId, project } of grantedPaths(device)) {
          items.push({
            projectId,
            path: project.path,
            displayName: project.name ?? project.path.split(/[\\/]/).pop() ?? project.path,
            ownerEpoch: 0,
            lastSeen: new Date().toISOString(),
          });
        }
        return ok({ items, projectionNote: 'items are filtered by this device\'s project grants' });
      },
    },
    sessions: {
      list: async ({ device, params }) => {
        const entry = projectEntry(params.projectId);
        if (!entry || !(device.grants ?? {})[params.projectId]) return deny(403, 'scope_denied');
        const snap = runtimeRegistry.snapshot();
        const items = (snap.items ?? [])
          .filter(i => i.kind === 'project' && (i.workspace?.cwd === entry.path || i.workspace?.workspaceId === entry.workspaceId))
          .map(i => ({
            sessionId: i.conversationId,
            projectId: params.projectId,
            displayName: i.title ?? i.conversationId,
            updatedAt: i.createdAt ?? new Date().toISOString(),
            activeConversations: [i.conversationId],
            projectionNote: 'item.projectId===path projectId; a project conversation is its own active entry',
          }));
        return ok({ items });
      },
    },
    conversations: {
      // runtime.create — open (or resume) a project conversation under the grant.
      create: async ({ device, params, body }) => {
        const entry = projectEntry(params.projectId);
        if (!entry || !(device.grants ?? {})[params.projectId]) return deny(403, 'scope_denied');
        // Reuse an existing conversation for this workspace if one is registered.
        const snap = runtimeRegistry.snapshot();
        const existing = (snap.items ?? []).find(i => i.workspace?.workspaceId === entry.workspaceId);
        if (existing && existing.owner) {
          return ok({ conversationId: existing.conversationId, ownerRevision: existing.revision ?? 1, reused: true });
        }
        try {
          const out = await ordinarySessions.open({ project: entry.path, requestId: crypto.randomUUID(), allowThird: false });
          return ok({ conversationId: out.conversationId, ownerRevision: out.item?.revision ?? 1 }, 201);
        } catch (e) {
          const code = e?.code;
          if (code === 'runtime_limit' || code === 'runtime_start_failed' || code === 'session_in_use') return deny(503, 'unavailable', true);
          if (code === 'workspace_in_use' || code === 'stale_workspace') return deny(409, 'operation_rejected', true);
          return deny(503, 'unavailable', true);
        }
      },
      // runtime.snapshot — latest state for one owned conversation.
      snapshot: async ({ device, params }) => {
        if (!deviceOwnsConversation(device, params.conversationId)) return deny(404, 'unknown_resource');
        return invokeOwner(params.conversationId, async ({ item }) => ok({
          conversationId: params.conversationId,
          ownerRevision: item.revision ?? 1,
          status: item.lifecycle ?? 'unknown',
          activity: item.activity ?? 'idle',
          attention: item.attention === true,
          lastActivityAt: item.createdAt ?? new Date().toISOString(),
          title: item.title ?? null,
          result: {
            lifecycle: item.lifecycle ?? 'unknown',
            activity: item.activity ?? 'idle',
            focused: item.focused === true,
            error: item.error ?? null,
            ...(item.outcome ? { outcome: item.outcome } : {}),
          },
        }));
      },
      send: async ({ device, params, body, requestId }) => {
        if (!deviceOwnsConversation(device, params.conversationId)) return deny(404, 'unknown_resource');
        const text = typeof body?.text === 'string' ? body.text : null;
        if (!text || !text.trim()) return deny(400, 'payload_invalid');
        return invokeOwner(params.conversationId, async ({ owner }) => {
          await runtimeRegistry.command(owner, { type: 'prompt', prompt: text, id: requestId });
          stream?.publish(params.conversationId, 0, 'message.append', { requestId, role: 'user' });
          stream?.publish(params.conversationId, 0, 'conversation.status', { status: 'running' });
          return ok({ accepted: true, conversationId: params.conversationId, ownerRevision: 1 }, 202);
        });
      },
      stop: async ({ device, params }) => {
        if (!deviceOwnsConversation(device, params.conversationId)) return deny(404, 'unknown_resource');
        return invokeOwner(params.conversationId, async ({ owner }) => {
          await runtimeRegistry.command(owner, { type: 'abort' });
          stream?.publish(params.conversationId, 0, 'conversation.status', { status: 'stopped' });
          return ok({ accepted: true, conversationId: params.conversationId, ownerRevision: 1 });
        });
      },
    },
    approvals: {
      list: async ({ device, params }) => {
        if (!deviceOwnsConversation(device, params.conversationId)) return deny(404, 'unknown_resource');
        const out = runtimeRegistry.events(ownerFor(params.conversationId).owner, 0);
        const items = (out.approvals ?? []).map(a => ({
          requestId: a.id ?? a.requestId,
          conversationId: params.conversationId,
          type: a.type ?? a.commandName ?? 'unknown',
          createdAt: a.receivedAt ?? a.createdAt ?? new Date().toISOString(),
          ...(a.toolCall ? { toolCall: a.toolCall } : {}),
        }));
        return ok({ items, ownerRevision: 1 });
      },
      respond: async ({ device, params, body }) => {
        if (!isRecord(body) || typeof body.method !== 'string' || typeof body.decision !== 'string') return deny(400, 'payload_invalid');
        // approvals respond via extension_ui_response on the owning conversation
        const snap = runtimeRegistry.snapshot();
        const item = (snap.items ?? []).find(i => i.conversationId && deviceOwnsConversation(device, i.conversationId));
        if (!item || !item.owner) return deny(404, 'unknown_resource');
        try {
          await runtimeRegistry.command(item.owner, { type: 'extension_ui_response', id: params.requestId, response: { method: body.method, decision: body.decision, ...(body.value !== undefined ? { value: body.value } : {}) } });
          stream?.publish(item.conversationId, 0, 'approval.settled', { requestId: params.requestId, decision: body.decision });
          return ok({ accepted: true, ownerRevision: 1 });
        } catch (e) {
          const code = e?.code;
          if (code === 'stale_approval' || code === 'stale_runtime') return deny(409, 'operation_rejected');
          return deny(503, 'unavailable', true);
        }
      },
    },
  };
}
