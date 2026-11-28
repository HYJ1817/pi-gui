import { json } from './http-utils.js';
import { htmlArtifactCapacityInfo, htmlArtifactMaintenanceInfo } from './html-artifact-maintenance.js';

// The already-resolved DATA_DIR is authoritative. Reporting must not call the
// resolver a second time (which would repeat startup migration side effects).
export function createSystemStorage({ dataDir, piAgentDir, env = process.env, executionMode, artifactStats = null }) {
  const desktopDefault = executionMode === 'electron' && env.PI_GUI_DESKTOP === '1'
    && env.PI_GUI_DATA_SOURCE === 'electron-user-data';
  const managed = executionMode === 'electron' && env.PI_GUI_DESKTOP === '1' && env.PI_GUI_DATA_SOURCE === 'managed';
  const storage = {
    dataDirectory: dataDir,
    source: env.PI_GUI_DATA ? managed ? 'managed' : desktopDefault ? 'electron-user-data' : 'environment' : 'resolver-default',
    executionMode,
    piAgentDirectory: piAgentDir,
    piAgentSource: env.PI_CODING_AGENT_DIR ? 'environment' : 'pi-default',
  };
  return { async handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    if (typeof artifactStats !== 'function') return json(res, 200, { ok: true, storage });
    const maintenance = htmlArtifactMaintenanceInfo();
    let htmlArtifacts = { status: 'unknown', code: 'html_store_unavailable', maintenance };
    try {
      const value = await artifactStats();
      const keys = ['count', 'bytes', 'htmlBytes', 'pending', 'temporary', 'temporaryBytes'];
      if (keys.every(key => Number.isSafeInteger(value?.[key]) && value[key] >= 0)) {
        htmlArtifacts = { status: 'known', ...Object.fromEntries(keys.map(key => [key, value[key]])), maintenance };
        for (const key of ['sessionMaxBytes', 'sessionMaxCount']) {
          if (Number.isSafeInteger(value[key]) && value[key] >= 0) htmlArtifacts[key] = value[key];
        }
        const limits = ['totalBytes', 'sessionBytes', 'totalCount', 'sessionCount'];
        if (limits.every(key => Number.isSafeInteger(value.limits?.[key]) && value.limits[key] > 0)) {
          htmlArtifacts.limits = Object.fromEntries(limits.map(key => [key, value.limits[key]]));
          htmlArtifacts.capacity = htmlArtifactCapacityInfo(htmlArtifacts);
        }
      }
    } catch { /* Statistics never implicitly repair a lock or collect snapshots. */ }
    return json(res, 200, { ok: true, storage: { ...storage, htmlArtifacts } });
  } };
}
