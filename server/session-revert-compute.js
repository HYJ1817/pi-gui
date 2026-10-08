import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { hasBundledAssets, readAsset } from '../lib/assets.js';

// Executable assets never use the persistent extraction cache. A data URL binds
// execution to the bytes shipped with this process, including across upgrades.
export function bundledRevertUrls(read = readAsset) {
  const url = key => new URL('data:text/javascript;base64,' + read(key).toString('base64'));
  return { entry: url('revert-compute/worker.mjs'), module: url('revert-compute/algorithm.mjs').href };
}

let active = 0;
const refusal = reason => ({ status: 'refused', reason, candidate: null, contentEligible: false, action: 'none' });

// No unbounded queue: CPU and retained raw snapshots are bounded together.
export async function runSessionRevert(input, { workerPath, timeoutMs = 2000 } = {}) {
  if (active >= 2) return refusal('preview_busy');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) return refusal('diff_budget_exceeded');
  active++;
  try {
    const bundled = hasBundledAssets();
    const assets = bundled ? bundledRevertUrls() : null;
    const entry = workerPath || assets?.entry || fileURLToPath(new URL('./session-revert-worker.mjs', import.meta.url));
    const module = assets?.module || new URL('../lib/session-revert.js', import.meta.url).href;
    return await new Promise(resolve => {
      let worker, timer, finished = false;
      const done = async result => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        // Keep admission occupied until the worker actually stops.
        try { await worker?.terminate(); } catch { /* Fixed error result only. */ }
        if (result?.candidate != null) result.candidate = Buffer.from(result.candidate);
        resolve(result);
      };
      try {
        worker = new Worker(entry, { workerData: { input, module }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
        timer = setTimeout(() => { void done(refusal('diff_budget_exceeded')); }, timeoutMs);
        worker.once('message', result => { void done(result); });
        worker.once('error', () => { void done(refusal('compute_unavailable')); });
        worker.once('exit', () => { if (!finished) void done(refusal('compute_unavailable')); });
      } catch { void done(refusal('compute_unavailable')); }
    });
  } finally { active--; }
}
