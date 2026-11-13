/* Shell selection and PTY process management for the project terminal.
 *
 * Kept separate from the session ledger so the native-module loading rules and
 * the Windows process-tree teardown can be reviewed (and tested) without the
 * HTTP/session machinery around them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import processIdentity from '../lib/process-identity.cjs';

/** Resolve the shell without accepting a path from the renderer.
 *
 * Windows prefers the absolute Windows PowerShell path, then the absolute
 * ComSpec/cmd.exe. POSIX uses $SHELL only when it is an absolute path.
 * `exists` is injectable so the selection rules can be tested without spawning
 * a shell. */
export function resolveTerminalShell({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform === 'win32') {
    const winRoot = typeof env.SystemRoot === 'string' && path.isAbsolute(env.SystemRoot)
      ? env.SystemRoot
      : 'C:\\Windows';
    const powerShell = path.join(winRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(powerShell)) {
      return { file: powerShell, args: ['-NoLogo', '-NoProfile'], shell: 'PowerShell', winRoot };
    }
    const comspec = typeof env.ComSpec === 'string' && path.isAbsolute(env.ComSpec)
      ? env.ComSpec
      : path.join(winRoot, 'System32', 'cmd.exe');
    return { file: comspec, args: ['/d', '/q'], shell: '命令提示符', winRoot };
  }
  const configured = typeof env.SHELL === 'string' && path.isAbsolute(env.SHELL) && exists(env.SHELL)
    ? env.SHELL
    : '/bin/sh';
  return { file: configured, args: [], shell: path.basename(configured) || 'shell' };
}

let nativePty = null;
let nativePtyFailure = null;

/** Load node-pty from the directories that exist in our three run modes:
 *   - source:       <repo>/node_modules/node-pty
 *   - Electron app: <resources>/app/node_modules/node-pty
 *   - Node SEA:     <exe dir>/node_modules/node-pty
 *
 * `createRequire` works inside a Node SEA executable (plain `require` only
 * knows built-ins), so the native prebuild can be loaded without bundling it
 * into server.cjs. */
function loadNodePty() {
  if (nativePty) return nativePty;
  if (nativePtyFailure) throw nativePtyFailure;
  const candidates = [];
  const add = (dir) => {
    if (dir && !candidates.includes(dir)) candidates.push(dir);
  };
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    add(here);
    /* Source mode only: server/terminal-process.js -> <repo>/node_modules. The
     * packaged app must not walk up from build/ or resources/app into an
     * arbitrary ancestor checkout and load its node-pty instead of the staged
     * sidecar. */
    if (path.basename(here) === 'server') add(path.resolve(here, '..'));
  } catch {
    /* Bundled CJS still has __filename via the esbuild banner. */
  }
  /* Never search process.cwd(): the desktop backend runs with cwd set to the
   * user-writable data directory, so a planted node_modules/node-pty there
   * would execute arbitrary native code. Only the source tree, the app
   * directory and the executable directory are trusted. */
  if (process.execPath) add(path.dirname(process.execPath));
  if (process.resourcesPath) add(path.join(process.resourcesPath, 'app'));

  let lastError = null;
  for (const base of candidates) {
    const packageDir = path.join(base, 'node_modules', 'node-pty');
    try {
      const req = createRequire(path.join(base, '.pi-gui-pty-loader.cjs'));
      const loaded = req(packageDir);
      if (loaded && typeof loaded.spawn === 'function') {
        nativePty = loaded;
        return loaded;
      }
    } catch (error) {
      lastError = error;
    }
  }
  nativePtyFailure = Object.assign(
    Error('node-pty is not available in this build'),
    { code: 'pty_unavailable', cause: lastError }
  );
  throw nativePtyFailure;
}

const WINDOWS_TASKKILL_TIMEOUT_MS = 8000;

/* Opt-in, structure-only trace for hard-to-reproduce CI failures. It never
 * records pids, image paths or command lines: those can end up in a public CI
 * log. The app-check turns it on so a failed teardown says whether the gate
 * stopped at capture, query, verdict or taskkill. */
function killDebug(env, text) {
  if (!env || env.PI_GUI_KILL_DEBUG !== '1') return;
  try {
    process.stderr.write(`[kill] ${text}\n`);
  } catch {
    /* diagnostics must never affect teardown */
  }
}

/* taskkill is the tree kill, but it is still addressed by a bare pid. The
 * caller must have verified the pid's identity immediately before this runs.
 * There is no fallback to pty.kill() on Windows: node-pty's ConPTY agent
 * attaches to the same bare pid and, after five seconds, may call
 * process.kill(shellPid). If the shell exited and its pid was reused, that
 * fallback creates a second chance to kill an unrelated process. A wedged
 * session stays `closing` until the bounded retry budget is spent. */
function runWindowsTaskkill(pid, { env = process.env, timeoutMs = WINDOWS_TASKKILL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve({ ok: false, code: 'invalid_pid' });
    const envRoot = env.SystemRoot;
    const winRoot = typeof envRoot === 'string' && path.isAbsolute(envRoot) ? envRoot : 'C:\\Windows';
    const taskkill = path.join(winRoot, 'System32', 'taskkill.exe');
    let settled = false;
    let timer = null;
    let child = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    try {
      child = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      finish({ ok: false, code: 'spawn_failed' });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, code: 'timeout' });
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => finish({ ok: false, code: error?.code || 'spawn_failed' }));
    child.once('close', (code) => finish({ ok: code === 0, code }));
  });
}

/* Identity gate for Windows kills.
 *
 * `capture` records the shell identity as soon as spawn returns. `kill`
 * re-queries the pid and only runs taskkill when creation time and image path
 * still match. gone/mismatch/unknown never reach taskkill:
 *   - gone: the shell already exited; wait for the real exit event
 *   - mismatch: the pid now belongs to another process; do not kill
 *   - unknown: identity could not be proven; fail closed
 * A query and the subsequent taskkill remain two separate steps, so a pid
 * reused in between is still possible. This narrows the window; it does not
 * remove it. */
function captureOnce(capture, pid, expectedImagePath, options) {
  const started = Date.now();
  return Promise.resolve()
    .then(() => capture(pid, expectedImagePath, options))
    .then((result) => {
      killDebug(options.env, `capture state=${result?.state || 'none'} reason=${result?.reason || ''} ms=${Date.now() - started}`);
      return result;
    })
    .catch((error) => {
      killDebug(options.env, `capture state=unknown reason=${error?.code || 'capture_failed'} ms=${Date.now() - started}`);
      return { state: 'unknown', reason: error?.code || 'capture_failed' };
    });
}

export function createWindowsKillGate({
  query = processIdentity.queryProcessIdentity,
  capture = processIdentity.captureProcessIdentity,
  taskkill = runWindowsTaskkill,
  captureTimeoutMs = processIdentity.DEFAULT_CAPTURE_TIMEOUT_MS,
  timeoutMs = processIdentity.DEFAULT_QUERY_TIMEOUT_MS,
  taskkillTimeoutMs = WINDOWS_TASKKILL_TIMEOUT_MS,
} = {}) {
  const identities = new WeakMap();

  function remember(pty, expectedImagePath, { env = process.env } = {}) {
    if (!pty || !Number.isInteger(pty.pid) || pty.pid <= 0) return;
    const entry = {
      pid: pty.pid,
      env,
      expectedImagePath,
      retried: false,
      retryPending: null,
    };
    /* Capture has its own, deliberately tight budget: it starts immediately
     * after spawn, and delaying the identity read increases the chance of
     * capturing a reused pid. The stop-time re-query may use a larger budget
     * because it is always compared against this captured identity. */
    entry.expected = captureOnce(capture, entry.pid, expectedImagePath, { env, timeoutMs: captureTimeoutMs });
    identities.set(pty, entry);
  }

  /* A cold PowerShell can push the spawn-time probe past its tight budget even
   * though the shell is healthy. Retry only after the PTY has produced output:
   * live output is strong evidence the shell is still alive, which narrows the
   * pid-reuse window (it does not eliminate it). Definite answers (`gone`,
   * `mismatch`, `missing`) are never retried; they must keep failing closed. */
  async function recapture(pty) {
    const entry = pty ? identities.get(pty) : null;
    if (!entry || entry.retried) return;
    const first = await entry.expected;
    if (first?.state === 'captured' || entry.retried) return;
    if (first?.reason === 'gone' || first?.reason === 'missing' || first?.reason === 'image_mismatch') return;
    entry.retried = true;
    const retry = captureOnce(capture, entry.pid, entry.expectedImagePath, { env: entry.env, timeoutMs: captureTimeoutMs });
    entry.retryPending = retry;
    entry.expected = retry;
    try {
      await retry;
    } finally {
      if (entry.retryPending === retry) entry.retryPending = null;
    }
  }

  async function kill(pty) {
    const entry = pty ? identities.get(pty) : null;
    if (!entry) return { result: 'unknown', reason: 'no_identity' };
    /* A first-output recapture may still be in flight. Waiting for it is
     * bounded by the same capture budget and avoids reporting `unknown` just
     * because the stop arrived while the retry was starting. */
    if (entry.retryPending) {
      try { await entry.retryPending; } catch { /* captureOnce resolves unknown */ }
    }
    let expected = await entry.expected;
    if (expected?.state !== 'captured' && entry.retried) {
      /* The first probe settled just as recapture replaced the promise. Read
       * the current one instead of deciding from the stale first result. */
      expected = await entry.expected;
    }
    if (!expected || expected.state !== 'captured') {
      return { result: 'unknown', reason: expected?.reason || 'identity_unknown' };
    }
    const queryStarted = Date.now();
    const current = await query(entry.pid, { env: entry.env, timeoutMs });
    killDebug(entry.env, `query state=${current?.state || 'none'} reason=${current?.reason || ''} ms=${Date.now() - queryStarted}`);
    const verdict = processIdentity.classifyProcessIdentity(expected, current);
    killDebug(entry.env, `verdict=${verdict}`);
    if (verdict !== 'match') return { result: verdict };
    const taskkillStarted = Date.now();
    const outcome = await taskkill(entry.pid, { env: entry.env, timeoutMs: taskkillTimeoutMs });
    killDebug(entry.env, `taskkill ok=${outcome?.ok === true} code=${outcome?.code ?? ''} ms=${Date.now() - taskkillStarted}`);
    return outcome?.ok ? { result: 'killed' } : { result: 'failed', code: outcome?.code ?? null };
  }

  return { capture: remember, recapture, kill, _identities: identities };
}

const defaultWindowsKillGate = createWindowsKillGate();

/** Local trial switch. Default off: every existing terminal keeps the P3-B
 * identity-gated PID path and never loads the Job-Object code path. */
export function jobObjectEnabled(env = process.env) {
  return env?.PI_GUI_TERMINAL_JOB_OBJECT === '1';
}

/** Build node-pty options and enforce the capability before any shell (or
 * even the PTY pipes) is created. `nodePty` is injectable so the refusal
 * path is testable without a real native module. */
export function resolvePtyOptions({
  file, cwd, env, cols, rows,
  platform = process.platform,
  nodePty,
  jobObject = jobObjectEnabled(),
} = {}) {
  const options = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  };
  // Default ConPTY is the supported mode on Windows 10/11. winpty and the
  // bundled ConPTY DLL are not used: they failed independently in the target
  // Electron/Node combination, and silently switching would hide that failure.
  if (jobObject && (platform !== 'win32' || typeof nodePty?.supportsJobObject !== 'function'
    || nodePty.supportsJobObject() !== true)) {
    throw Object.assign(new Error('terminal Job Object capability is unavailable'), {
      code: 'pty_job_unavailable',
    });
  }
  if (platform === 'win32') {
    options.useConpty = true;
    if (jobObject) options.useJobObject = true;
  }
  return options;
}

export function defaultSpawnPty({ file, args, cwd, env, cols, rows, platform = process.platform }) {
  const jobObject = jobObjectEnabled();
  let nodePty;
  try {
    nodePty = loadNodePty();
  } catch (error) {
    if (jobObject) error.code = 'pty_job_unavailable';
    throw error;
  }
  const options = resolvePtyOptions({
    file, cwd, env, cols, rows, platform, nodePty, jobObject,
  });
  const pty = nodePty.spawn(file, args, options);
  /* Job mode has no PID to gate: the exit path is killJob/TerminateJobObject.
   * Capturing an identity would only invite a PID-based fallback later. */
  if (platform === 'win32' && pty.jobMode !== true) {
    defaultWindowsKillGate.capture(pty, file, { env });
    /* If a cold probe missed the tight spawn-time budget, the first PTY output
     * is a safe point to try again: the shell is demonstrably alive then.
     * The listener is one-shot and never consumes the data. */
    try {
      if (typeof pty.onData === 'function') {
        let dataSub = null;
        dataSub = pty.onData(() => {
          try { dataSub?.dispose?.(); } catch { /* already disposed */ }
          void defaultWindowsKillGate.recapture(pty).catch(() => {});
        });
      }
    } catch {
      /* keep the single capture result: an unverified pid is never killed */
    }
  }
  return pty;
}

export function defaultKillPty(pty, platform = process.platform) {
  if (!pty) return undefined;
  /* Job mode is a hard boundary: no identity gate, no taskkill, no PID reuse
   * guess. killJob() terminates the Job and returns immediately; the native
   * exit/cleanup threads close HPCON after the Job drains. */
  if (platform === 'win32' && pty.jobMode === true) {
    let snapshot;
    try { snapshot = pty.killJob?.(); } catch { /* reconciliation still runs */ }
    return {
      job: true,
      requested: snapshot?.requested === true,
      terminateAccepted: snapshot?.terminateAccepted === true,
    };
  }
  if (platform === 'win32') return defaultWindowsKillGate.kill(pty);
  try {
    pty.kill();
  } catch {
    /* already gone */
  }
  return undefined;
}
