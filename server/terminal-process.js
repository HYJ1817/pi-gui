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

export function defaultSpawnPty({ file, args, cwd, env, cols, rows, platform = process.platform }) {
  const pty = loadNodePty();
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
  return pty.spawn(file, args, options);
}

/* node-pty's ConPTY kill path forks conpty_console_list_agent.js, which calls
 * AttachConsole on the shell pid. If the shell has already exited that helper
 * crashes and prints a full stack trace to the backend's stderr — even though
 * the session is on its way to a perfectly normal exit. A repeated tree kill
 * is routine here (the sweep retries while a session is "closing", and
 * taskkill reports 128 once the pid is gone), so only fall back to the PTY
 * handle while the shell is actually alive. Otherwise the real exit event is
 * already in flight and pty.kill() has nothing left to do. */
export function ptyProcessAlive(pty) {
  const pid = Number.isInteger(pty?.pid) && pty.pid > 0 ? pty.pid : null;
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still means the process exists; node cannot query it.
    return error?.code === 'EPERM';
  }
}

export function defaultKillPty(pty, platform = process.platform) {
  if (!pty) return;
  const pid = Number.isInteger(pty.pid) && pty.pid > 0 ? pty.pid : null;
  let fellBack = false;
  const fallbackToPty = () => {
    if (fellBack) return;
    fellBack = true;
    if (platform === 'win32' && !ptyProcessAlive(pty)) return;
    try { pty.kill(); } catch { /* already gone */ }
  };
  if (platform === 'win32' && pid) {
    try {
      const envRoot = process.env.SystemRoot;
      const winRoot = typeof envRoot === 'string' && path.isAbsolute(envRoot) ? envRoot : 'C:\\Windows';
      const taskkill = path.join(winRoot, 'System32', 'taskkill.exe');
      const child = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      child.once('error', () => {
        // taskkill itself was unavailable; fall back to the PTY handle.
        fallbackToPty();
      });
      child.once('close', (code) => {
        // Non-zero means taskkill could not tear the tree down (or the shell
        // was already gone). Retry through node-pty only while it is alive so
        // the session still reaches a real exit event without a crash trace.
        // spawn() emits error and then close for a missing executable; the
        // one-shot guard keeps that from killing the same PTY twice.
        if (code !== 0) fallbackToPty();
      });
      return;
    } catch {
      fallbackToPty();
      return;
    }
  }
  try {
    pty.kill();
  } catch {
    /* already gone */
  }
}
