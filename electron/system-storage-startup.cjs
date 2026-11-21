'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createSystemStorage } = require('./system-storage-migration.cjs');
const { obtainPiAgentDirectory } = require('./system-storage-policy.cjs');

async function initializeSystemStorage({ directory, appRoot, executable, probe, env = process.env } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const explicit = env.PI_GUI_DATA ? path.resolve(env.PI_GUI_DATA) : undefined;
  const runtimeDirectory = env.PI_GUI_RUNTIME_DIR && path.isAbsolute(env.PI_GUI_RUNTIME_DIR)
    ? path.resolve(env.PI_GUI_RUNTIME_DIR)
    : env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA)
      ? path.join(env.LOCALAPPDATA, 'pi-gui', 'runtime') : path.join(directory, 'runtime');
  const storage = createSystemStorage({ directory, defaultDataDirectory: directory,
    explicitDataDirectory: explicit, piAgentDirectory: obtainPiAgentDirectory(env.PI_CODING_AGENT_DIR), runtimeDirectory,
    protectedRoots: [appRoot, path.dirname(executable), ...['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']
      .map(key => env[key]).filter(value => value && path.isAbsolute(value))] });
  let result = await storage.initialize();
  if (!result.ok) throw Error('storage_boot_unavailable');
  if (result.state.pending) {
    // The boot phase witnesses shutdown of the original owned writer. A port
    // probe is an extra startup guard for reuse/conflict, not that witness.
    if ((await probe()).state !== 'not-running') throw Error('storage_writers_unconfirmed');
    result = await storage.runPendingCold({ writersStopped: true });
  }
  const state = storage.state();
  if (!state.dataDirectory || state.pending) throw Error('storage_root_unavailable');
  return { storage, runtimeDirectory, dataDirectory: state.dataDirectory, source: state.source };
}
module.exports = { initializeSystemStorage };
