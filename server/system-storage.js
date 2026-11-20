import { json } from './http-utils.js';

// The already-resolved DATA_DIR is authoritative. Reporting must not call the
// resolver a second time (which would repeat startup migration side effects).
export function createSystemStorage({ dataDir, piAgentDir, env = process.env, executionMode }) {
  const desktopDefault = executionMode === 'electron' && env.PI_GUI_DESKTOP === '1'
    && env.PI_GUI_DATA_SOURCE === 'electron-user-data';
  const storage = {
    dataDirectory: dataDir,
    source: env.PI_GUI_DATA ? desktopDefault ? 'electron-user-data' : 'environment' : 'resolver-default',
    executionMode,
    piAgentDirectory: piAgentDir,
    piAgentSource: env.PI_CODING_AGENT_DIR ? 'environment' : 'pi-default',
  };
  return { handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    return json(res, 200, { ok: true, storage });
  } };
}
