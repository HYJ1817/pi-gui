import { scanHtmlArtifactReferences } from './html-artifact-sessions.js';

// GUI admission can pause its own writers, NOT external Pi append/branch/copy.
// No native-exclusion capability exists in production, including the offline
// CLI. A user's stop confirmation is not a proof and NEVER enables snapshot GC.
export function createHtmlArtifactMaintenance({ store, roots, maintenance = null,
  scan = scanHtmlArtifactReferences, graceMs = 10 * 60 * 1000, now = Date.now,
  offline = false } = {}) {
  let running = false;
  return {
    async run({ action = 'plan' } = {}) {
      if (running) return { ok: false, code: 'html_artifact_storage_busy' };
      if (!['stats', 'plan', 'collect', 'recover-lock', 'cleanup-temporary'].includes(action)) return { ok: false, code: 'invalid_request' };
      if (action === 'collect') return { ok: false, code: 'native_mutation_unproven' };
      // Only fixed, unpublished temporary inventory and a proven-dead v2 lock
      // may be maintained explicitly. These never select a native snapshot.
      if (['recover-lock', 'cleanup-temporary'].includes(action) && !offline) {
        return { ok: false, code: 'offline_maintenance_required' };
      }
      running = true;
      let admitted = false;
      try {
        if (action === 'stats') return { ok: true, storage: await store.stats() };
        if (maintenance) {
          const status = await maintenance.prepare('storage');
          if (!status?.ok) return { ok: false, code: 'maintenance_busy' };
          admitted = true;
        }
        if (action === 'recover-lock') return await store.recoverLock();
        if (action === 'cleanup-temporary') return { ok: true, ...await store.cleanupTemporary() };
        const result = await store.collect({ dryRun: true, scan: () => {
          const snapshot = scan(roots());
          if (snapshot?.complete !== true) return { complete: false };
          return { complete: true, referencedIds: snapshot.referencedIds,
            beforeMs: Math.max(0, now() - graceMs), isCurrent: snapshot.isCurrent,
            releasePending: true, dryRun: true };
        } });
        return { ok: result.complete === true, ...result,
          mode: 'candidates-only', nativeExclusionProven: false };
      } catch (error) {
        return { ok: false, code: ['html_artifact_storage_busy', 'html_artifact_storage_unsafe',
          'html_artifact_storage_corrupt'].includes(error?.code) ? error.code : 'html_store_unavailable' };
      } finally {
        try {
          if (admitted && (await maintenance.release('storage'))?.ok !== true) {
            return { ok: false, code: 'maintenance_release_unconfirmed' };
          }
        } catch { return { ok: false, code: 'maintenance_release_unconfirmed' }; }
        finally { running = false; }
      }
    },
  };
}
