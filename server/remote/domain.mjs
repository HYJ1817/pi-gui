/**
 * Remote v1 production domain facade — binds the REAL pi-gui desktop stores
 * (projects registry, runtime registry, ordinary sessions) to the adapter
 * contract. Everything remote-visible is derived here; the adapters never
 * touch desktop internals directly. Any missing capability degrades to an
 * empty/failed result (fail closed), never a fabricated truth.
 *
 * The desktop domain knows ONLY the Runtime namespace for conversations;
 * classic sessions are read-only list entries (contract ownerNamespaces).
 */
export function buildDomain({ runtime, runtimeRegistry, projects, ordinarySessions }) {
  const safe = fn => { try { return fn(); } catch { return null; } };

  function projectItems() {
    const list = safe(() => projects?.read?.()?.items) ?? [];
    return list.filter(p => p && typeof p.path === 'string')
      .map(p => ({ path: p.path, name: p.name ?? null, workspaceId: p.workspaceId ?? p.path }));
  }

  function conversationItems() {
    const snap = safe(() => runtimeRegistry?.snapshot?.());
    const items = Array.isArray(snap?.items) ? snap.items : [];
    return items.map(i => {
      const ws = i.workspace ?? {};
      const pending = [];
      // Pending approvals: the registry exposes them per-owner via events();
      // we read the live owner's pending list if the adapter surfaces one.
      const evs = i.owner ? safe(() => runtimeRegistry?.events?.(i.owner, 0)) : null;
      for (const a of evs?.approvals ?? []) {
        pending.push({
          requestId: String(a.id ?? a.requestId ?? ''),
          conversationId: i.conversationId,
          owner: `runtime:${ws.backendInstance ?? ''}:${ws.workspaceId ?? ''}:${ws.workspaceEpoch ?? 0}:${i.conversationId}`,
          namespace: 'runtime',
          projectId: null,                                  // filled by adapters' projectOfConversation
          method: mapApprovalMethod(a),
          pending: true,
          expiresAtMs: Number.isSafeInteger(a.expiresAtMs) ? a.expiresAtMs : Date.now() + 60000,
          revision: Number.isSafeInteger(a.revision) ? a.revision : 0,
          options: Array.isArray(a.options) ? a.options.map((o, idx) => ({ optionId: String(o.optionId ?? o.id ?? `o${idx}`), label: String(o.label ?? o.optionId ?? `option ${idx + 1}`) })) : undefined,
          title: String(a.title ?? a.commandName ?? ''),
          message: String(a.message ?? ''),
        });
      }
      return {
        conversationId: i.conversationId,
        sessionId: i.sessionId ?? null,
        title: i.title ?? null,
        createdAt: i.createdAt ?? null,
        lifecycle: i.lifecycle === 'live' ? 'running' : ['idle', 'running', 'stopping', 'error'].includes(i.lifecycle) ? i.lifecycle : 'unknown',
        revision: Number.isSafeInteger(i.revision) ? i.revision : 0,
        workspace: { cwd: ws.cwd ?? null, workspaceId: ws.workspaceId ?? null, workspaceEpoch: ws.workspaceEpoch ?? null, backendInstance: ws.backendInstance ?? null },
        owner: i.owner ?? null,
        pendingApprovals: pending,
        messages: [],
      };
    }).filter(c => typeof c.conversationId === 'string');
  }
  function mapApprovalMethod(a) {
    const m = a?.method ?? a?.type;
    if (['select', 'confirm', 'input', 'editor'].includes(m)) return m;
    if (a?.options?.length) return 'select';
    return 'confirm';
  }

  return {
    projects: () => projectItems(),
    conversations: () => conversationItems(),
    sessionRecords: projectPath => {
      const snap = safe(() => runtimeRegistry?.snapshot?.());
      return (snap?.items ?? [])
        .filter(i => i?.workspace?.cwd === projectPath || (i?.workspace?.workspaceId && i.workspace.workspaceId === projectPath))
        .map(i => ({
          sessionId: String(i.sessionId ?? i.conversationId ?? ''),
          displayName: i.title ?? i.sessionName ?? i.conversationId ?? '',
          updatedAt: i.createdAt ?? new Date().toISOString(),
          conversationIds: i.conversationId ? [i.conversationId] : [],
        }))
        .filter(s => s.sessionId.length >= 8);
    },
    openConversation: async (projectPath, { clientConversationId }) => {
      const out = await ordinarySessions.open({ project: projectPath, requestId: clientConversationId, allowThird: false });
      return { conversationId: out?.conversationId ?? out?.item?.conversationId ?? '' };
    },
    sendMessage: async ({ owner, text, clientMessageId }) => {
      const item = safe(() => runtimeRegistry?.snapshot?.()?.items.find(i => i.conversationId === owner?.conversationId));
      if (!item?.owner) { const e = new Error('owner gone'); e.code = 'stale_owner'; throw e; }
      await runtimeRegistry.command(item.owner, { type: 'prompt', prompt: text, id: clientMessageId });
      return { accepted: true };
    },
    stop: async ({ conversationId }) => {
      const item = safe(() => runtimeRegistry?.snapshot?.()?.items.find(i => i.conversationId === conversationId));
      if (!item?.owner) { const e = new Error('owner gone'); e.code = 'stale_owner'; throw e; }
      await runtimeRegistry.command(item.owner, { type: 'abort' });
      return { stopped: true };
    },
    pendingDialogs: () => conversationItems().flatMap(c => (c.pendingApprovals ?? []).map(d => ({ ...d, conversationId: c.conversationId }))),
    consumeApproval: ({ requestId, conversationId, method, decision, value }) => {
      const item = safe(() => runtimeRegistry?.snapshot?.()?.items.find(i => i.conversationId === conversationId));
      if (!item?.owner) return false;
      try {
        runtimeRegistry.command(item.owner, {
          type: 'extension_ui_response', id: requestId,
          response: { method, decision, ...(value !== undefined ? { value } : {}) },
        });
        return true;
      } catch { return false; }
    },
  };
}
