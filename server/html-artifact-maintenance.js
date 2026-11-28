import { scanHtmlArtifactReferences } from './html-artifact-sessions.js';

// Production policy, independent of whether a store is readable or at quota.
// The existing source CLI/private parent IPC are explicit maintenance routes;
// reporting them must not invent a renderer/HTTP deletion capability.
export function htmlArtifactMaintenanceInfo() {
  return {
    mode: 'candidates-only', automaticCollection: false, snapshotDeletion: false,
    code: 'native_mutation_unproven',
    message: '正式快照回收未开放；plan 只列候选，不释放快照容量或清除 pending。',
    inspectionActions: ['stats', 'plan'],
    offlineActions: ['recover-lock', 'cleanup-temporary'],
    sourceEntry: 'server/html-artifact-maintenance-cli.js',
    recovery: '先保留原数据根；显式离线维护仅恢复已证明死亡的锁、清理未发布临时文件。正式快照占满时可另选全新空数据根，旧快照不会迁移或自动恢复；不要手工删除快照或未知锁。',
  };
}

// Checked numeric stats only; this is feedback, NOT publish admission. A session
// high-water mark can report some session full, not identify the caller's owner.
export function htmlArtifactCapacityInfo(value) {
  const { limits } = value;
  const globalLimitReached = value.bytes >= limits.totalBytes || value.count >= limits.totalCount;
  const sessionUsageKnown = ['sessionMaxBytes', 'sessionMaxCount'].every(key =>
    Number.isSafeInteger(value[key]) && value[key] >= 0);
  const sessionLimitReached = sessionUsageKnown
    ? value.sessionMaxBytes >= limits.sessionBytes || value.sessionMaxCount >= limits.sessionCount : null;
  const publicationBlockedByTemporary = value.temporary > 0;
  const code = publicationBlockedByTemporary ? 'temporary_cleanup_required'
    : globalLimitReached || sessionLimitReached ? 'html_artifact_quota' : 'within_reported_limits';
  return {
    code, remainingBytes: Math.max(0, limits.totalBytes - value.bytes),
    remainingCount: Math.max(0, limits.totalCount - value.count),
    globalLimitReached, sessionLimitReached, publicationBlockedByTemporary,
    message: code === 'temporary_cleanup_required'
      ? '存在未发布临时文件，新发布已阻止；可显式离线运行 cleanup-temporary，仅清理固定临时清单，正式快照保留。'
      : code === 'html_artifact_quota'
        ? '全局或某个原生会话已达到容量上限，不会自动删除正式快照；plan 不能释放容量，请按显式维护说明处理。'
        : '尚未达到已报告的容量上限；剩余字节不保证下次发布成功，仍需核对本会话、HTML、元数据及 pending 的实际占用。',
  };
}

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
        if (action === 'stats') {
          const storage = await store.stats();
          return { ok: true, storage, capacity: htmlArtifactCapacityInfo(storage), maintenance: htmlArtifactMaintenanceInfo() };
        }
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
          mode: 'candidates-only', nativeExclusionProven: false, maintenance: htmlArtifactMaintenanceInfo() };
      } catch (error) {
        return { ok: false, code: ['html_artifact_storage_busy', 'html_artifact_storage_unsafe',
          'html_artifact_storage_corrupt', 'html_artifact_storage_release_failed'].includes(error?.code) ? error.code : 'html_store_unavailable' };
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
