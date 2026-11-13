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
    identities.set(pty, {
      pid: pty.pid,
      env,
      /* Capture has its own, deliberately tight budget: it starts immediately
       * after spawn, and delaying the identity read increases the chance of
       * capturing a reused pid. The stop-time re-query may use a larger budget
       * because it is always compared against this captured identity. */
      expected: capture(pty.pid, expectedImagePath, { env, timeoutMs: captureTimeoutMs }),
    });
  }

  async function kill(pty) {
    const entry = pty ? identities.get(pty) : null;
    if (!entry) return { result: 'unknown', reason: 'no_identity' };
    const expected = await entry.expected;
    if (!expected || expected.state !== 'captured') {
      return { result: 'unknown', reason: expected?.reason || 'identity_unknown' };
    }
    const current = await query(entry.pid, { env: entry.env, timeoutMs });
    const verdict = processIdentity.classifyProcessIdentity(expected, current);
    if (verdict !== 'match') return { result: verdict };
    const outcome = await taskkill(entry.pid, { env: entry.env, timeoutMs: taskkillTimeoutMs });
    return outcome?.ok ? { result: 'killed' } : { result: 'failed', code: outcome?.code ?? null };
  }

  return { capture: remember, kill, _identities: identities };
}

const defaultWindowsKillGate = createWindowsKillGate();

export function defaultSpawnPty({ file, args, cwd, env, cols, rows, platform = process.platform }) {
  const nodePty = loadNodePty();
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
  if (platform === 'win32') options.useConpty = true;
  const pty = nodePty.spawn(file, args, options);
  /* Capture before returning, so a stop that arrives immediately after
   * create still has an identity to wait for. The probe is asynchronous and
   * does not delay the response. */
  if (platform === 'win32') defaultWindowsKillGate.capture(pty, file, { env });
  return pty;
}

export function defaultKillPty(pty, platform = process.platform) {
  if (!pty) return undefined;
  if (platform === 'win32') return defaultWindowsKillGate.kill(pty);
  try {
    pty.kill();
  } catch {
    /* already gone */
  }
  return undefined;
}
