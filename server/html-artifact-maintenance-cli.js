// Explicit source-only offline tool. Does NOT import server.js, launch Pi,
// listen on HTTP, restore tasks, load credentials, or accept renderer requests.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSessions } from './sessions.js';
import { createRuntimeRegistry } from './runtime-registry.js';
import { createHtmlArtifactStore } from './html-artifact-store.js';
import { createHtmlArtifactMaintenance } from './html-artifact-maintenance.js';

export async function runHtmlArtifactMaintenanceCli(args) {
  let action = 'plan', dataDir, agentDir;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--data-dir') dataDir = args[++i];
    else if (arg === '--agent-dir') agentDir = args[++i];
    else if (arg === '--action') action = args[++i];
    else if (arg === '--confirm-offline-native-writers-stopped') { /* Legacy spelling, never deletion authority. */ }
    else return { ok: false, code: 'invalid_request' };
  }
  if (![dataDir, agentDir].every(value => typeof value === 'string' && path.isAbsolute(value))) return { ok: false, code: 'invalid_request' };
  try {
    // Do not create/migrate directories based on a mistaken command line.
    for (const dir of [dataDir, agentDir]) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, code: 'html_artifact_storage_unsafe' };
    }
    const store = createHtmlArtifactStore({ dataDir });
    const sessions = createSessions({ dataDir, env: { PI_CODING_AGENT_DIR: agentDir },
      extraSessionRoots: [path.join(dataDir, 'planner-sessions')] });
    // Reuse the canonical manifest validator, never duplicate its schema or
    // silently skip a damaged registry / dormant locator outside session roots.
    const registry = createRuntimeRegistry({ dataDir, factory: () => { throw Error('offline'); } });
    const roots = () => {
      const snapshot = registry.snapshot();
      if (!snapshot.ok) throw Error('registry_unavailable');
      return [...sessions.artifactSessionRoots(), ...snapshot.items.map(item =>
        registry.historyTarget(item.conversationId)?.sessionLocator).filter(Boolean)];
    };
    return await createHtmlArtifactMaintenance({ store, roots, offline: true }).run({ action });
  } catch { return { ok: false, code: 'html_store_unavailable' }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runHtmlArtifactMaintenanceCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 1;
}
