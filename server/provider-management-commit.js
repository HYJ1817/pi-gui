import { providerFailure } from '../public/provider-management/contract.js';

const COMMIT_TIMEOUT_MS = 30_000;

async function beforeDeadline(deadline, run) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) providerFailure('config_busy');
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('config_busy'), { code: 'config_busy' }));
    }, Math.ceil(remaining));
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => run(controller.signal)), timeout]);
    if (performance.now() >= deadline) providerFailure('config_busy');
    return result;
  } finally { clearTimeout(timer); }
}

function project(receipt, outcome) {
  if (outcome === 'saved' || outcome === 'cleared') return { ...receipt, credentialSaved: true, credentialState: outcome };
  const uncertain = outcome === 'credential-unconfirmed';
  return { ...receipt, ok: false, credentialSaved: uncertain ? null : false, credentialState: outcome,
    code: uncertain ? 'credential_unconfirmed' : 'native_write_failed',
    message: uncertain ? '配置已保存，凭据结果待确认。' : '配置已保存，凭据保存失败。',
    retryable: !uncertain, sync: { state: 'idle', reason: null } };
}

export function createNativeCommit({ store, credentials, mutationBlocked }) {
  const active = new Map();
  const drafts = new Set();

  function commit({ request, fingerprint, binding, inspect, apply }) {
    const prior = active.get(request.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) providerFailure('request_id_conflict');
      return prior.promise;
    }
    if (drafts.has(request.draftId)) providerFailure('config_busy');
    drafts.add(request.draftId);
    const promise = Promise.resolve().then(() => store.withCredentialOperation(async tx => {
      const deadline = performance.now() + COMMIT_TIMEOUT_MS;
      const { operation, receipt } = tx.lookup(request.requestId, fingerprint);
      if (operation?.phase === 'finished') {
        const result = receipt ?? { ok: true, serviceId: operation.providerId, saved: true, operationId: null,
          sync: { state: 'pending', reason: 'runtime_sync_pending' }, revision: operation.revision };
        return project(result, operation.outcome);
      }
      if (operation) {
        if (!receipt) providerFailure('config_recovery_required');
        tx.finish(request.requestId, 'credential-unconfirmed');
        return project(receipt, 'credential-unconfirmed');
      }
      if (receipt) providerFailure('request_id_conflict');
      if (mutationBlocked()) providerFailure('config_busy');
      const bound = binding();
      const approval = await beforeDeadline(deadline, signal => credentials.authorize(bound, { signal }));
      if (!approval) providerFailure('credential_conflict');
      const credential = await beforeDeadline(deadline, () => inspect(bound.providerId));
      tx.prepare({ requestId: request.requestId, fingerprint, providerId: bound.providerId, action: bound.action });
      let saved;
      try {
        saved = tx.transact({ expectedRevision: request.expectedRevision, requestId: request.requestId, fingerprint,
          apply: current => apply(current, credential) });
      } catch (error) {
        if (error?.code !== 'config_recovery_required') tx.abandon(request.requestId);
        throw error;
      }
      const ready = () => performance.now() < deadline && !mutationBlocked() && tx.isCurrent(saved.revision);
      if (ready()) tx.dispatch(request.requestId);
      else {
        tx.finish(request.requestId, 'saved-credential-error');
        return project(saved, 'saved-credential-error');
      }
      let outcome = 'saved-credential-error';
      if (ready()) {
        outcome = 'credential-unconfirmed';
        try {
          const result = await beforeDeadline(deadline, signal => credentials.persist(approval, { signal }));
          const expected = bound.action === 'clear-native' ? 'cleared' : 'saved';
          if (result?.ok === true && result.credentialSaved === true && result.credentialState === expected) outcome = expected;
          else if (result?.ok === false && result.credentialSaved === false) outcome = 'saved-credential-error';
        } catch { /* The SDK may have written before failing to acknowledge. */ }
      }
      try { tx.finish(request.requestId, outcome); }
      catch { return project(saved, 'credential-unconfirmed'); }
      return project(saved, outcome);
    })).finally(() => {
      active.delete(request.requestId);
      drafts.delete(request.draftId);
    });
    active.set(request.requestId, { fingerprint, promise });
    return promise;
  }

  return { commit, hasDraft: draftId => drafts.has(draftId) };
}
