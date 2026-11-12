/* Project-scoped PTY terminal for the right-pane Terminal surface.
 *
 * The renderer never supplies a cwd, shell executable, arguments or environment.
 * Those come from the focused conversation's workspace identity and from the
 * server's own platform defaults. The HTTP body carries only an action, a
 * session id, raw keyboard bytes and terminal dimensions.
 *
 * PTY output is kept byte-for-byte (well, code-unit-for-code-unit): CR, ANSI
 * escapes and cursor movement are not normalized. The buffer is bounded in
 * memory and is never written to logs. A session keeps running when the xterm
 * surface is closed, so reopening the panel can reconnect to it; it is stopped
 * by an explicit stop, a workspace change, an idle timeout or app shutdown.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { normalizeForCompare, realPathOrNull } from '../lib/safe-path.js';
import { json, readRawBody } from './http-utils.js';
import { scrubInternalEnv } from './child-env.js';

export const TERMINAL_LIMITS = Object.freeze({
  maxSessions: 2,
  maxInputBytes: 64 * 1024,
  maxBufferChars: 256 * 1024,
  maxBodyBytes: 128 * 1024,
  idleMs: 30 * 60 * 1000,
  minCols: 20,
  maxCols: 500,
  minRows: 5,
  maxRows: 200,
  defaultCols: 80,
  defaultRows: 24,
  /* Recheck the focused workspace even when the terminal panel is closed.
   * Without this, switching projects while another surface is open would
   * leave the old shell alive until its idle timeout. */
  scopeSweepMs: 5000,
});

const fail = (code, message) => Object.assign(new Error(message || code), { code });
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
const toSlashes = (value) => String(value).replace(/\\/g, '/');
const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

function workspaceFor(scope) {
  if (!scope || typeof scope !== 'object') throw fail('unknown_conversation');
  if (scope.root == null) return null;
  if (typeof scope.root !== 'string') throw fail('workspace_unavailable');
  const root = realPathOrNull(scope.root);
  if (!root) throw fail('workspace_unavailable');
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    throw fail('workspace_unavailable');
  }
  if (!stat.isDirectory()) throw fail('workspace_unavailable');
  const scopeId = typeof scope.scopeId === 'string' ? scope.scopeId : '';
  return {
    root,
    scopeId,
    generation: String(scope.generation ?? ''),
    id: hash(normalizeForCompare(root) + '\0' + scopeId + '\0' + String(scope.generation ?? '')),
  };
}

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
    /* Source mode only: server/terminal.js -> <repo>/node_modules. The
     * packaged app must not walk up from build/ or resources/app into an
     * arbitrary ancestor checkout and load its node-pty instead of the
     * staged sidecar. */
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
 * is routine here (the sweep retries while a session is "stopping", and
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
  const fallbackToPty = () => {
    if (platform === 'win32' && !ptyProcessAlive(pty)) return;
    try { pty.kill(); } catch { /* already gone */ }
  };
  if (platform === 'win32' && pid) {
    try {
      const winRoot = process.env.SystemRoot || 'C:\\Windows';
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
        if (code !== 0) fallbackToPty();
      });
      return;
    } catch {
      /* fall through to the PTY handle */
    }
  }
  try {
    pty.kill();
  } catch {
    /* already gone */
  }
}

function validDimension(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function readDimensions(body, limits, required) {
  const cols = body?.cols === undefined ? limits.defaultCols : body.cols;
  const rows = body?.rows === undefined ? limits.defaultRows : body.rows;
  if (required ? body?.cols === undefined || body?.rows === undefined : false) {
    throw fail('invalid_size', '终端尺寸不完整。');
  }
  if (!validDimension(cols, limits.minCols, limits.maxCols)
    || !validDimension(rows, limits.minRows, limits.maxRows)) {
    throw fail('invalid_size', '终端尺寸不合法。');
  }
  return { cols, rows };
}

function conversationIdOf(req) {
  const value = req?.headers?.['x-pi-gui-conversation'];
  return typeof value === 'string' && value ? value : undefined;
}

export function createTerminal({
  scopeForRequest = async () => null,
  scopeForSession = null,
  enabled = true,
  limits = TERMINAL_LIMITS,
  spawnPty = defaultSpawnPty,
  killPty = defaultKillPty,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (typeof scopeForRequest !== 'function') throw new TypeError('scopeForRequest must be a function');
  if (typeof spawnPty !== 'function') throw new TypeError('spawnPty must be a function');
  if (typeof killPty !== 'function') throw new TypeError('killPty must be a function');

  const sessions = new Map();
  let disposed = false;
  let disposePromise = null;
  let sweepTimer = null;
  let sweeping = false;

  function publicSession(session) {
    return {
      id: session.id,
      workspace: { id: session.workspace.id, generation: session.workspace.generation },
      cwd: toSlashes(session.workspace.root),
      shell: session.shell,
      state: session.state,
      exitCode: session.exitCode,
      signal: session.signal,
      cursor: session.end,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      pty: true,
    };
  }

  function waitForExit(session, ms) {
    if (!session || ['exited', 'failed'].includes(session.state)) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        session.exitWaiters.delete(done);
        resolve();
      };
      session.exitWaiters.add(done);
      timer = setTimeout(done, ms);
      timer.unref?.();
    });
  }

  function resolveWaiters(session) {
    for (const resolve of [...session.exitWaiters]) resolve();
    session.exitWaiters.clear();
  }

  function append(session, text) {
    if (typeof text !== 'string' || !text) return;
    session.output += text;
    session.end += text.length;
    if (session.output.length > limits.maxBufferChars) {
      let drop = session.output.length - limits.maxBufferChars;
      // Do not start the retained buffer in the middle of a surrogate pair;
      // xterm would otherwise receive a replacement character forever.
      if (drop > 0 && isLowSurrogate(session.output.charCodeAt(drop))
        && isHighSurrogate(session.output.charCodeAt(drop - 1))) drop += 1;
      session.output = session.output.slice(drop);
      session.start += drop;
      session.dropped = true;
    }
    session.lastAt = Date.now();
    if (session.state === 'running') touch(session);
  }

  function touch(session) {
    clearTimeout(session.idleTimer);
    if (!limits.idleMs || !Number.isFinite(limits.idleMs) || disposed || session.state !== 'running') return;
    session.idleTimer = setTimeout(() => {
      if (sessions.get(session.id) !== session || session.state !== 'running') return;
      append(session, '\r\n[空闲超时，终端已停止]\r\n');
      void stopSession(session, 'idle');
    }, limits.idleMs);
    session.idleTimer.unref?.();
  }

  function handleExit(session, event) {
    if (['exited', 'failed'].includes(session.state)) return;
    clearTimeout(session.idleTimer);
    session.state = 'exited';
    session.exitCode = Number.isInteger(event?.exitCode) ? event.exitCode : null;
    session.signal = event?.signal ?? null;
    session.exitedAt = Date.now();
    if (!disposed) {
      const suffix = session.exitCode !== null
        ? ` (${session.exitCode})`
        : session.signal !== null ? ` (${String(session.signal)})` : '';
      append(session, `\r\n[进程已退出${suffix}]\r\n`);
    }
    resolveWaiters(session);
    if (session.retired && sessions.get(session.id) === session) sessions.delete(session.id);
  }

  function removeAndStop(session, reason) {
    /* Keep the retired session in the map until the real exit event. Deleting
     * it up front would hide a wedged kill from dispose() and from the sweep's
     * stopping-session retry, leaving an untracked process tree behind. */
    session.retired = true;
    return stopSession(session, reason);
  }

  function stopSession(session, reason = 'user') {
    if (!session) return Promise.resolve();
    if (['exited', 'failed'].includes(session.state)) {
      resolveWaiters(session);
      return Promise.resolve();
    }
    if (session.state === 'stopping') return waitForExit(session, 5000);
    session.state = 'stopping';
    session.stopReason = reason;
    clearTimeout(session.idleTimer);
    try {
      killPty(session.pty, platform);
    } catch {
      try { session.pty?.kill?.(); } catch { /* already gone */ }
    }
    // The state changes only when node-pty reports the real exit event. If a
    // kill path is wedged, the sweep retries it instead of pretending success.
    return waitForExit(session, 5000);
  }

  async function verifyScope(req, session) {
    if (!session) throw fail('terminal_missing', '终端会话不存在。');
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace || workspace.id !== session.workspace.id) {
      /* Same conversation + different workspace generation means the user
       * switched this conversation's project: retire the stale shell. A
       * request from a *different* conversation must only be refused — if it
       * could stop the session here, knowing a session id would be enough to
       * kill another workspace's shell. */
      if (conversationIdOf(req) === session.conversationId) {
        await removeAndStop(session, 'workspace');
      }
      throw fail('stale_workspace', '工作区已经变化，终端已停止。');
    }
  }

  function sessionsForWorkspace(workspace) {
    return [...sessions.values()].filter((session) => session.workspace.id === workspace.id);
  }

  function pruneFinished() {
    for (const session of [...sessions.values()]) {
      if (['exited', 'failed'].includes(session.state)) sessions.delete(session.id);
    }
  }

  async function start(req, res, body) {
    if (disposed) return json(res, 503, { ok: false, code: 'terminal_unavailable', error: '终端已关闭。' });
    if (!enabled) {
      return json(res, 403, { ok: false, code: 'terminal_disabled', error: '终端仅在桌面版可用。' });
    }
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) {
      return json(res, 200, { ok: true, noProject: true, enabled: true, session: null });
    }
    const dimensions = readDimensions(body, limits, false);
    /* scopeForRequest is async. Shutdown may have started while it resolved;
     * spawning after dispose() snapshotted the session list would leave a PTY
     * outside every cleanup path. */
    if (disposed) return json(res, 503, { ok: false, code: 'terminal_unavailable', error: '终端已关闭。' });

    const existing = sessionsForWorkspace(workspace)
      .find((session) => !session.retired && !['exited', 'failed'].includes(session.state));
    if (existing) {
      if (existing.state === 'running') {
        touch(existing);
        return json(res, 200, { ok: true, enabled: true, reused: true, session: publicSession(existing) });
      }
      return json(res, 409, {
        ok: false,
        code: 'terminal_stopping',
        error: '终端正在停止，请稍后再试。',
        session: publicSession(existing),
      });
    }
    pruneFinished();

    // A different workspace generation in the same project must not be reused.
    // Stop it and drop it from the accounting before checking the session cap.
    for (const stale of [...sessions.values()]) {
      if (!stale.retired && stale.workspace.scopeId === workspace.scopeId && stale.workspace.id !== workspace.id) {
        removeAndStop(stale, 'workspace');
      }
    }

    const live = [...sessions.values()].filter((session) => ['running', 'stopping'].includes(session.state));
    if (live.length >= limits.maxSessions) {
      return json(res, 409, {
        ok: false,
        code: 'terminal_limit',
        error: '终端会话数已达上限。请先停止另一个终端。',
      });
    }

    const shell = resolveTerminalShell({ platform, env });
    const childEnv = scrubInternalEnv(env);
    childEnv.TERM = 'xterm-256color';
    childEnv.COLORTERM = 'truecolor';
    if (shell.winRoot) childEnv.SystemRoot = shell.winRoot;

    let pty;
    try {
      pty = spawnPty({
        file: shell.file,
        args: shell.args,
        cwd: workspace.root,
        env: childEnv,
        cols: dimensions.cols,
        rows: dimensions.rows,
        platform,
      });
    } catch (error) {
      const unavailable = error?.code === 'pty_unavailable' || /node-pty|native module/i.test(String(error?.message || ''));
      return json(res, 503, {
        ok: false,
        code: unavailable ? 'pty_unavailable' : 'terminal_unavailable',
        error: unavailable ? '终端组件未安装或无法加载。' : '无法启动终端。',
      });
    }
    if (!pty || typeof pty.onData !== 'function' || typeof pty.onExit !== 'function'
      || typeof pty.write !== 'function' || typeof pty.resize !== 'function') {
      try { pty?.kill?.(); } catch { /* noop */ }
      return json(res, 503, { ok: false, code: 'terminal_unavailable', error: '无法启动终端。' });
    }

    const session = {
      id: crypto.randomUUID(),
      conversationId: conversationIdOf(req),
      workspace,
      pty,
      shell: shell.shell,
      output: '',
      start: 0,
      end: 0,
      dropped: false,
      state: 'running',
      exitCode: null,
      signal: null,
      cols: dimensions.cols,
      rows: dimensions.rows,
      createdAt: Date.now(),
      lastAt: Date.now(),
      exitedAt: null,
      stopReason: null,
      retired: false,
      idleTimer: null,
      exitWaiters: new Set(),
    };
    sessions.set(session.id, session);
    pty.onData((chunk) => append(session, chunk));
    pty.onExit((event) => handleExit(session, event));
    touch(session);

    return json(res, 200, { ok: true, enabled: true, reused: false, session: publicSession(session) });
  }

  async function read(req, res, url) {
    const id = String(url.searchParams.get('id') || '');
    if (!id || id.length > 128) return json(res, 400, { ok: false, code: 'invalid_request', error: '缺少终端会话。' });
    const session = sessions.get(id);
    if (!session) return json(res, 404, { ok: false, code: 'terminal_missing', error: '终端会话不存在。' });
    await verifyScope(req, session);

    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw === null || sinceRaw === '' ? 0 : Number(sinceRaw);
    if (!Number.isSafeInteger(since) || since < 0) {
      return json(res, 400, { ok: false, code: 'invalid_cursor', error: '终端读取位置不合法。' });
    }

    let text;
    let truncated = false;
    if (since < session.start) {
      text = session.output;
      truncated = true;
    } else if (since >= session.end) {
      text = '';
    } else {
      text = session.output.slice(since - session.start);
    }
    if (session.state === 'running') {
      session.lastAt = Date.now();
      touch(session);
    }
    return json(res, 200, {
      ok: true,
      text,
      cursor: session.end,
      truncated: truncated || (session.dropped && since < session.start),
      state: session.state,
      exitCode: session.exitCode,
      session: publicSession(session),
    });
  }

  async function input(req, res, body) {
    const id = typeof body?.id === 'string' ? body.id : '';
    const session = sessions.get(id);
    if (!session) return json(res, 404, { ok: false, code: 'terminal_missing', error: '终端会话不存在。' });
    await verifyScope(req, session);
    const data = typeof body?.data === 'string' ? body.data : null;
    if (data === null || data.includes('\0') || Buffer.byteLength(data, 'utf8') > limits.maxInputBytes) {
      return json(res, 400, { ok: false, code: 'invalid_input', error: '终端输入不合法或过长。' });
    }
    if (session.state !== 'running') {
      return json(res, 409, { ok: false, code: 'terminal_not_running', error: '终端已经停止，请重新启动。' });
    }
    try {
      session.pty.write(data);
    } catch {
      return json(res, 503, { ok: false, code: 'terminal_unavailable', error: '无法写入终端。' });
    }
    session.lastAt = Date.now();
    touch(session);
    return json(res, 200, { ok: true, cursor: session.end });
  }

  async function resize(req, res, body) {
    const id = typeof body?.id === 'string' ? body.id : '';
    const session = sessions.get(id);
    if (!session) return json(res, 404, { ok: false, code: 'terminal_missing', error: '终端会话不存在。' });
    await verifyScope(req, session);
    const dimensions = readDimensions(body, limits, true);
    if (session.state !== 'running') {
      return json(res, 409, { ok: false, code: 'terminal_not_running', error: '终端已经停止，请重新启动。' });
    }
    try {
      session.pty.resize(dimensions.cols, dimensions.rows);
    } catch {
      return json(res, 409, { ok: false, code: 'terminal_resize_failed', error: '无法调整终端尺寸。' });
    }
    session.cols = dimensions.cols;
    session.rows = dimensions.rows;
    session.lastAt = Date.now();
    touch(session);
    return json(res, 200, { ok: true, cursor: session.end, cols: session.cols, rows: session.rows });
  }

  async function stop(req, res, body) {
    const id = typeof body?.id === 'string' ? body.id : '';
    const session = sessions.get(id);
    if (!session) return json(res, 404, { ok: false, code: 'terminal_missing', error: '终端会话不存在。' });
    // This call was missing from the pipe-era implementation. Every action,
    // including stop, must prove that the session belongs to this workspace.
    await verifyScope(req, session);
    if (['exited', 'failed'].includes(session.state)) {
      return json(res, 200, { ok: true, session: publicSession(session) });
    }
    void stopSession(session, 'user');
    return json(res, 200, { ok: true, session: publicSession(session) });
  }

  async function sweep() {
    if (sweeping || disposed) return;
    sweeping = true;
    try {
      for (const session of [...sessions.values()]) {
        if (session.state === 'stopping') {
          /* A kill path that never produced an exit would otherwise leave the
           * session stuck in "stopping" forever. Retry the tree kill; the
           * state still changes only when node-pty reports the real exit. */
          try {
            killPty(session.pty, platform);
          } catch {
            try { session.pty?.kill?.(); } catch { /* already gone */ }
          }
          continue;
        }
        if (session.state !== 'running') continue;
        try {
          const scope = typeof scopeForSession === 'function'
            ? await scopeForSession(session)
            : await scopeForRequest({
              headers: session.conversationId ? { 'x-pi-gui-conversation': session.conversationId } : {},
            });
          const workspace = workspaceFor(scope);
          if (!workspace || workspace.id !== session.workspace.id) {
            await removeAndStop(session, 'workspace');
          }
        } catch {
          await removeAndStop(session, 'workspace');
        }
      }
    } finally {
      sweeping = false;
    }
  }

  if (limits.scopeSweepMs > 0 && Number.isFinite(limits.scopeSweepMs)) {
    sweepTimer = setInterval(() => { void sweep(); }, limits.scopeSweepMs);
    sweepTimer.unref?.();
  }

  async function handle(req, res, url) {
    if (url.pathname === '/api/terminal/status') {
      if (req.method !== 'GET') {
        return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
      }
      return json(res, 200, {
        ok: true,
        enabled,
        platform,
        pty: true,
        maxSessions: limits.maxSessions,
        limits: {
          maxInputBytes: limits.maxInputBytes,
          maxBufferChars: limits.maxBufferChars,
          minCols: limits.minCols,
          maxCols: limits.maxCols,
          minRows: limits.minRows,
          maxRows: limits.maxRows,
        },
      });
    }
    if (url.pathname !== '/api/terminal') {
      return json(res, 404, { ok: false, code: 'not_found', error: '未知的终端接口。' });
    }
    if (!enabled) {
      return json(res, 403, { ok: false, code: 'terminal_disabled', error: '终端仅在桌面版可用。' });
    }
    if (req.method === 'GET') {
      try {
        return await read(req, res, url);
      } catch (error) {
        return terminalError(res, error);
      }
    }
    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
    }
    let body;
    try {
      body = JSON.parse((await readRawBody(req, limits.maxBodyBytes)).toString('utf8') || '{}');
    } catch {
      return json(res, 400, { ok: false, code: 'invalid_request', error: '请求不是合法 JSON。' });
    }
    try {
      if (body?.action === 'start') return await start(req, res, body);
      if (body?.action === 'input') return await input(req, res, body);
      if (body?.action === 'resize') return await resize(req, res, body);
      if (body?.action === 'stop') return await stop(req, res, body);
      return json(res, 400, { ok: false, code: 'invalid_action', error: '未知的终端操作。' });
    } catch (error) {
      return terminalError(res, error);
    }
  }

  function terminalError(res, error) {
    const code = error?.code || 'terminal_unavailable';
    const status = code === 'terminal_missing' ? 404
      : code === 'invalid_request' || code === 'invalid_input' || code === 'invalid_size' || code === 'invalid_cursor' ? 400
        : code === 'stale_workspace' || code === 'terminal_not_running' || code === 'terminal_stopping'
          || code === 'terminal_limit' || code === 'terminal_resize_failed'
          || code === 'unknown_conversation' || code === 'workspace_unavailable' ? 409
          : 503;
    const message = code === 'stale_workspace'
      ? '工作区已经变化，终端已停止。'
      : code === 'terminal_not_running'
        ? '终端已经停止，请重新启动。'
        : code === 'terminal_stopping'
          ? '终端正在停止，请稍后再试。'
          : code === 'terminal_limit'
            ? '终端会话数已达上限。请先停止另一个终端。'
            : code === 'invalid_size'
              ? '终端尺寸不合法。'
              : code === 'invalid_cursor'
                ? '终端读取位置不合法。'
                : code === 'terminal_missing'
                  ? '终端会话不存在。'
                  : code === 'pty_unavailable'
                    ? '终端组件未安装或无法加载。'
                    : '终端暂时不可用。';
    return json(res, status, { ok: false, code, error: message });
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    clearInterval(sweepTimer);
    sweepTimer = null;
    const live = [...sessions.values()];
    for (const session of live) {
      clearTimeout(session.idleTimer);
      void stopSession(session, 'shutdown');
    }
    disposePromise = Promise.all(live.map((session) => waitForExit(session, 3000))).then(() => {
      sessions.clear();
    });
    return disposePromise;
  }

  return { handle, dispose, _sessions: sessions };
}
