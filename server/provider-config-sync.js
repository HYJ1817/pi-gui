const oauthReasons = Object.freeze({
  no_live_runtime: '暂无运行中的会话，模型同步待确认',
  runtime_sync_pending: '当前会话继续运行，模型同步待确认',
  credential_unconfirmed: '认证操作尚未确认，模型同步仍待验证',
  sync_evidence_unavailable: '暂时无法读取模型同步状态，请稍后重试',
});

export function createProviderConfigSync({ store, hasLiveRuntime, authMutationActive = () => false }) {
  function snapshot(metadata) {
    try {
      const intent = store.readAuthSyncIntent();
      if (intent.unconfirmed) return authMutationActive() ? { state: 'pending', reason: 'runtime_sync_pending' }
        : { state: 'error', reason: 'credential_unconfirmed' };
      if (!intent.generation && (metadata ?? store.read().metadata).syncRequired !== true) return { state: 'idle', reason: null };
      return { state: 'pending', reason: hasLiveRuntime() ? 'runtime_sync_pending' : 'no_live_runtime' };
    } catch { return { state: 'error', reason: 'sync_evidence_unavailable' }; }
  }

  return { snapshot, oauthSnapshot() {
    const result = snapshot();
    return { state: result.state, reason: oauthReasons[result.reason] ?? null };
  } };
}
