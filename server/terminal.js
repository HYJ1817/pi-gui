/* Project-scoped PTY terminals for the right-pane Terminal surface.
 *
 * The renderer never supplies a cwd, shell executable, arguments or environment.
 * Those come from the focused conversation's workspace identity and from the
 * server's own platform defaults. The HTTP body carries only an action, a
 * session id, raw keyboard bytes and terminal dimensions.
 *
 * P2 keeps several independent sessions per workspace. Each session owns one
 * PTY and one bounded output buffer; input, resize, stop and close are always
 * checked against the requesting workspace. The renderer may list only the
 * sessions of its current workspace, and a session from another workspace can
 * neither be read nor controlled with a forged id.
 *
 * PTY output is kept byte-for-byte (well, code-unit-for-code-unit): CR, ANSI
 * escapes and cursor movement are not normalized. The buffer is bounded in
 * memory and is never written to logs. A session keeps running when the xterm
 * surface is closed or the user focuses another workspace; it is stopped by an
 * explicit stop/close, a confirmed workspace invalidation, an idle timeout or
 * app shutdown. Only an explicit close removes a stopped tab from the ledger.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { normalizeForCompare, realPathOrNull } from '../lib/safe-path.js';
import { json, readRawBody } from './http-utils.js';
import { scrubInternalEnv } from './child-env.js';
import {
  resolveTerminalShell,
  defaultSpawnPty,
  defaultKillPty,
  createWindowsKillGate,
} from './terminal-process.js';

export {
  resolveTerminalShell,
  defaultSpawnPty,
  defaultKillPty,
  createWindowsKillGate,
} from './terminal-process.js';

export const TERMINAL_LIMITS = Object.freeze({
  maxSessions: 12,
  maxSessionsPerWorkspace: 6,
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
  /* Recheck each session's own workspace even when the terminal panel is
   * closed. A deleted conversation or workspace must release its shells even
   * if the shell keeps producing output. A different focused workspace is not
   * a reason to stop anything: P2 keeps per-workspace terminals alive so
   * returning to a workspace reconnects to the same PTYs. */
  scopeSweepMs: 5000,
  /* A kill that cannot be confirmed is retried a bounded number of times.
   * The first attempt is immediate, then backoff[n] after attempt n completes.
   * After the budget is spent the session stays `closing` (`killState
   * unconfirmed`) and is never PID-killed again. */
  killMaxAttempts: 3,
  killBackoffMs: [0, 1000, 3000],
});

const fail = (code, message) => Object.assign(new Error(message || code), { code });
/* Scope errors that prove the session no longer has a workspace to belong to.
 * `registry_unavailable`, `workspace_check_failed` and errors without a
 * confirmed invalid code are deliberately absent: a temporary failure is not
 * proof of deletion, and killing a live shell on one is worse than keeping it
 * for the next sweep. */
const INVALID_SCOPE_CODES = new Set([
  'unknown_conversation',
  'unknown_workspace',
  'unknown_project',
  'workspace_unavailable',
  'stale_workspace',
]);
const FINISHED_STATES = new Set(['exited', 'error']);
/* Kill verdicts that prove another attempt would still be unsafe or useless:
 * the pid is gone, belongs to another process, or its identity could not be
 * established. Only a failed/unconfirmed taskkill is worth retrying. */
const KILL_STOP_RESULTS = new Set(['gone', 'mismatch', 'unknown']);
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
const toSlashes = (value) => String(value).replace(/\\/g, '/');
const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

function workspaceFor(scope) {
  if (!scope || typeof scope !== 'object') throw fail('unknown_conversation');
  if (scope.root == null) return null;
  if (typeof scope.root !== 'string') throw fail('workspace_unavailable');
  /* Stat before realpath so a removed directory can be told apart from a
   * transient I/O failure. `realPathOrNull` deliberately swallows the error
   * code; treating every failure as `workspace_unavailable` would let one
   * EACCES/EMFILE on a network share retire a healthy shell. Only ENOENT /
   * ENOTDIR (or a non-directory root) prove the workspace is gone. */
  let stat;
  try {
    stat = fs.statSync(scope.root);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw fail('workspace_unavailable');
    throw fail('workspace_check_failed');
  }
  if (!stat.isDirectory()) throw fail('workspace_unavailable');
  const root = realPathOrNull(scope.root);
  /* Stat succeeded but realpath did not: an access or link problem, not proof
   * that the workspace was deleted. Keep the shell and check again later. */
  if (!root) throw fail('workspace_check_failed');
  const scopeId = typeof scope.scopeId === 'string' ? scope.scopeId : '';
  const generation = String(scope.generation ?? '');
  /* Stable scopes (the classic single-project chat) have no durable
   * conversation identity. Their workspace is the folder itself, so returning
   * to the same folder must find the same terminal even though the classic
   * generation counter keeps increasing. Runtime workspaces keep the full
   * identity: a recreated workspace epoch must not resurrect an old shell. */
  const base = hash(normalizeForCompare(root) + '\0' + scopeId);
  const stable = scope.stable === true;
  return {
    root,
    scopeId,
    generation,
    stable,
    id: stable ? base : hash(base + '\0' + generation),
  };
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
  /* Per-workspace tab numbering. Purely presentational, but stable across
   * panel reopen while at least one tab of that workspace still exists. */
  const nextOrdinals = new Map();
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
      keepAliveRevision: session.keepAliveRevision || 0,
      cols: session.cols,
      rows: session.rows,
      ordinal: session.ordinal,
      createdAt: session.createdAt,
      keepAlive: session.keepAlive === true,
      pty: true,
    };
  }

  function waitForExit(session, ms) {
    if (!session || FINISHED_STATES.has(session.state)) return Promise.resolve();
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

  function disposeSessionHandles(session) {
    try { session.dataSub?.dispose?.(); } catch { /* already gone */ }
    try { session.exitSub?.dispose?.(); } catch { /* already gone */ }
    session.dataSub = null;
    session.exitSub = null;
  }

  function cleanupOrdinals(workspaceId) {
    if (!workspaceId) return;
    for (const session of sessions.values()) {
      if (session.workspace.id === workspaceId) return;
    }
    nextOrdinals.delete(workspaceId);
  }

  function allocateOrdinal(workspaceId) {
    const ordinal = nextOrdinals.get(workspaceId) || 1;
    nextOrdinals.set(workspaceId, ordinal + 1);
    return ordinal;
  }

  function removeSession(session) {
    sessions.delete(session.id);
    clearIdleTimer(session);
    disposeSessionHandles(session);
    cleanupOrdinals(session.workspace.id);
  }

  function clearIdleTimer(session) {
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  /* Keep Alive changes carry a small monotonic revision. Poll and list
   * responses are authorized against the same server state, but a response
   * sampled before a toggle can arrive after the toggle's response. The
   * renderer uses this revision to discard that stale snapshot instead of
   * letting it flip the visible button back. */
  function setKeepAliveFlag(session, enabled) {
    if (!session || session.keepAlive === enabled) return false;
    session.keepAlive = enabled;
    session.keepAliveRevision = (session.keepAliveRevision || 0) + 1;
    return true;
  }

  /* Server-side idle clock. Only real keyboard input and new PTY output count
   * as activity. read/list/resize and a reused start are observations or
   * layout: the renderer polls them every 60-240 ms, so treating them as
   * activity would keep a silent shell alive forever.
   *
   * A task that emits no output is indistinguishable from an idle shell using
   * only this interface. Any output resets the clock, so a long task that is
   * still working (even progress dots) is protected; complete silence for the
   * whole idle window is the bounded-resource policy. See the acceptance
   * record for the documented limitation. */
  function noteActivity(session) {
    if (!session || session.state !== 'running') return;
    session.lastActivityAt = Date.now();
    touch(session);
  }

  function append(session, text, { activity = true } = {}) {
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
    if (activity) noteActivity(session);
  }

  function touch(session) {
    clearIdleTimer(session);
    if (!limits.idleMs || !Number.isFinite(limits.idleMs) || disposed || session.state !== 'running'
      || session.keepAlive === true) return;
    /* noteActivity() stamps lastActivityAt immediately before calling here, so
     * this is normally a full window. Computing the remainder still keeps a
     * future direct caller from granting extra time. */
    const elapsed = Math.max(0, Date.now() - (session.lastActivityAt || Date.now()));
    const delay = Math.max(0, limits.idleMs - elapsed);
    session.idleTimer = setTimeout(() => {
      if (sessions.get(session.id) !== session || session.state !== 'running'
        || session.keepAlive === true) return;
      append(session, '\r\n[空闲超时，终端已停止]\r\n', { activity: false });
      void stopSession(session, 'idle');
    }, delay);
    session.idleTimer.unref?.();
  }

  function handleExit(session, event) {
    if (FINISHED_STATES.has(session.state)) return;
    clearIdleTimer(session);
    setKeepAliveFlag(session, false);
    session.state = 'exited';
    session.killState = 'exited';
    session.killNextAt = 0;
    session.exitCode = Number.isInteger(event?.exitCode) ? event.exitCode : null;
    session.signal = event?.signal ?? null;
    session.exitedAt = Date.now();
    if (!disposed) {
      const suffix = session.exitCode !== null
        ? ` (${session.exitCode})`
        : session.signal !== null ? ` (${String(session.signal)})` : '';
      append(session, `\r\n[进程已退出${suffix}]\r\n`);
    }
    disposeSessionHandles(session);
    resolveWaiters(session);
    if (session.retired && sessions.get(session.id) === session) removeSession(session);
  }

  function removeAndStop(session, reason) {
    /* Keep the retired session in the map until the real exit event. Deleting
     * it up front would hide a wedged kill from dispose() and from the sweep's
     * closing-session retry, leaving an untracked process tree behind. */
    session.retired = true;
    return stopSession(session, reason);
  }

  function killBudget() {
    return Number.isInteger(limits.killMaxAttempts) && limits.killMaxAttempts > 0
      ? limits.killMaxAttempts
      : 3;
  }

  function killBackoff(session) {
    const plan = Array.isArray(limits.killBackoffMs) && limits.killBackoffMs.length
      ? limits.killBackoffMs
      : [0, 1000, 3000];
    const value = Number(plan[Math.min(session.killAttempts, plan.length - 1)]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function markKillUnconfirmed(session) {
    /* Not `exited`: the shell may still be alive. Keeping the public state
     * `closing` preserves the session's slot and its tab; the real exit event
     * is the only thing that can finish it. */
    session.killState = 'unconfirmed';
    session.killNextAt = 0;
  }

  /* Start (or account for) one kill attempt. The killPty contract is:
   *   - `{result:'killed'|'failed'}` on Windows identity-gated taskkill
   *   - `{result:'gone'|'mismatch'|'unknown'}` when killing is unsafe/useless
   *   - anything else (undefined from a legacy injected killer) means
   *     "signal sent, wait for the real exit"
   * A promise lets the identity query finish before taskkill. Attempts never
   * overlap: sweep skips while killInFlight is true. */
  function attemptKill(session) {
    if (!session || session.state !== 'closing' || session.killState === 'unconfirmed') return;
    if (session.killInFlight) return;
    if (session.killAttempts >= killBudget()) {
      markKillUnconfirmed(session);
      return;
    }
    session.killAttempts += 1;
    session.killInFlight = true;
    session.killState = 'pending';
    let outcome;
    try {
      outcome = killPty(session.pty, platform);
    } catch {
      outcome = { result: 'failed' };
    }
    Promise.resolve(outcome).then((result) => {
      if (sessions.get(session.id) !== session || session.state !== 'closing') return;
      if (KILL_STOP_RESULTS.has(result?.result)) {
        markKillUnconfirmed(session);
        return;
      }
      if (session.killAttempts >= killBudget()) {
        markKillUnconfirmed(session);
        return;
      }
      session.killNextAt = Date.now() + killBackoff(session);
    }, () => {
      if (sessions.get(session.id) !== session || session.state !== 'closing') return;
      if (session.killAttempts >= killBudget()) {
        markKillUnconfirmed(session);
        return;
      }
      session.killNextAt = Date.now() + killBackoff(session);
    }).finally(() => {
      session.killInFlight = false;
    });
  }

  function stopSession(session, reason = 'user') {
    if (!session) return Promise.resolve();
    if (FINISHED_STATES.has(session.state)) {
      resolveWaiters(session);
      return Promise.resolve();
    }
    if (session.state === 'closing') return waitForExit(session, 5000);
    /* Keep Alive only exempts the idle timer. Explicit stop, close, workspace
     * retirement and shutdown all reach this path, so none of them can be
     * bypassed by the flag. The flag itself is meaningless once not running. */
    setKeepAliveFlag(session, false);
    session.state = 'closing';
    session.stopReason = reason;
    clearIdleTimer(session);
    attemptKill(session);
    // The state changes only when node-pty reports the real exit event. The
    // sweep retries a failed kill a bounded number of times instead of
    // pretending success.
    return waitForExit(session, 5000);
  }

  async function verifyScope(req, session) {
    if (!session) throw fail('terminal_missing', '终端会话不存在。');
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace || workspace.id !== session.workspace.id) {
      /* Same conversation + different workspace identity means that
       * conversation's workspace was replaced: retire the stale shell. A
       * request from a *different* conversation must only be refused — if it
       * could stop the session here, knowing a session id would be enough to
       * kill another workspace's shell. Stable classic scopes have no
       * conversation identity to prove continuity, so they are never retired
       * by a cross-workspace request; their sweep validates the folder. */
      if (!session.workspace.stable && conversationIdOf(req) === session.conversationId) {
        await removeAndStop(session, 'workspace');
      }
      throw fail('stale_workspace', '工作区已经变化，终端已停止。');
    }
  }

  function sessionsForWorkspace(workspace) {
    return [...sessions.values()].filter((session) => session.workspace.id === workspace.id);
  }

  /* Legacy `start` replaces the workspace's finished tab. Scope the cleanup to
   * that workspace: a request in workspace A must not delete an exited tab that
   * workspace B still shows (and can restart). */
  function pruneFinished(workspaceId) {
    for (const session of [...sessions.values()]) {
      if (session.workspace.id === workspaceId && FINISHED_STATES.has(session.state)) {
        removeSession(session);
      }
    }
  }

  function counts(workspace) {
    const inWorkspace = [...sessions.values()].filter((other) => other.workspace.id === workspace.id).length;
    return { inWorkspace, total: sessions.size };
  }

  function limitResponse(res, reason) {
    return json(res, 409, {
      ok: false,
      code: 'terminal_limit',
      limit: reason,
      error: reason === 'workspace'
        ? '当前工作区的终端数量已达上限，请先关闭一个终端。'
        : '终端会话总数已达上限，请先关闭一个终端。',
    });
  }

  /* Shared by `start` (reuse the workspace's most recent running terminal) and
   * `create` (always add a tab). Scope resolution is async; every check after
   * it re-runs against the current state, and the `creating` record is
   * inserted without another await so two concurrent creates cannot both pass
   * the cap. */
  async function openSession(req, res, body, { reuse }) {
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

    if (reuse) {
      const inWorkspace = sessionsForWorkspace(workspace)
        .filter((session) => !session.retired && !FINISHED_STATES.has(session.state));
      const existing = inWorkspace.find((session) => session.state === 'running')
        || inWorkspace.find((session) => session.state === 'closing');
      if (existing) {
        if (existing.state === 'running') {
          /* Reusing a live session is an observation, not keyboard activity.
           * Otherwise opening or remounting the legacy surface would postpone
           * the idle timeout indefinitely. */
          return json(res, 200, { ok: true, enabled: true, reused: true, session: publicSession(existing) });
        }
        return json(res, 409, {
          ok: false,
          code: 'terminal_stopping',
          error: '终端正在停止，请稍后再试。',
          session: publicSession(existing),
        });
      }
      // P1 compatibility: `start` treats this workspace's finished sessions as
      // replaceable. `create` keeps them as closable tabs instead.
      pruneFinished(workspace.id);
    }

    const current = counts(workspace);
    if (current.inWorkspace >= limits.maxSessionsPerWorkspace) return limitResponse(res, 'workspace');
    if (current.total >= limits.maxSessions) return limitResponse(res, 'global');

    const shell = resolveTerminalShell({ platform, env });
    const childEnv = scrubInternalEnv(env);
    childEnv.TERM = 'xterm-256color';
    childEnv.COLORTERM = 'truecolor';
    if (shell.winRoot) childEnv.SystemRoot = shell.winRoot;

    const session = {
      id: crypto.randomUUID(),
      conversationId: conversationIdOf(req),
      workspace,
      pty: null,
      shell: shell.shell,
      output: '',
      start: 0,
      end: 0,
      dropped: false,
      state: 'creating',
      exitCode: null,
      signal: null,
      cols: dimensions.cols,
      rows: dimensions.rows,
      ordinal: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      exitedAt: null,
      stopReason: null,
      retired: false,
      /* Server-owned. A create/start body that sends `keepAlive` is ignored:
       * the renderer must opt in through the scoped keep-alive action. */
      keepAlive: false,
      keepAliveRevision: 0,
      idleTimer: null,
      /* Internal kill bookkeeping. `killState` never becomes `exited` except
       * through the real PTY exit event above. */
      killAttempts: 0,
      killInFlight: false,
      killNextAt: 0,
      killState: 'none',
      dataSub: null,
      exitSub: null,
      exitWaiters: new Set(),
    };
    sessions.set(session.id, session);

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
      removeSession(session);
      const unavailable = error?.code === 'pty_unavailable' || /node-pty|native module/i.test(String(error?.message || ''));
      return json(res, 503, {
        ok: false,
        code: unavailable ? 'pty_unavailable' : 'terminal_unavailable',
        state: 'error',
        error: unavailable ? '终端组件未安装或无法加载。' : '无法启动终端。',
      });
    }
    if (!pty || typeof pty.onData !== 'function' || typeof pty.onExit !== 'function'
      || typeof pty.write !== 'function' || typeof pty.resize !== 'function') {
      try { void Promise.resolve(killPty(pty, platform)).catch(() => {}); } catch { /* noop */ }
      removeSession(session);
      return json(res, 503, { ok: false, code: 'terminal_unavailable', state: 'error', error: '无法启动终端。' });
    }

    session.pty = pty;
    try {
      session.dataSub = pty.onData((chunk) => append(session, chunk));
      session.exitSub = pty.onExit((event) => handleExit(session, event));
    } catch {
      /* A PTY that cannot be subscribed to is unusable. Tear it down without
       * leaving a ledger entry or an orphan process. On Windows this goes
       * through the identity gate; there is no bare pty.kill() fallback. */
      try { void Promise.resolve(killPty(pty, platform)).catch(() => {}); } catch { /* noop */ }
      removeSession(session);
      return json(res, 503, { ok: false, code: 'terminal_unavailable', state: 'error', error: '无法连接终端。' });
    }
    session.ordinal = allocateOrdinal(workspace.id);
    session.state = 'running';
    noteActivity(session);

    return json(res, 200, {
      ok: true, enabled: true, reused: false, session: publicSession(session),
    });
  }

  async function start(req, res, body) {
    return openSession(req, res, body, { reuse: true });
  }

  async function create(req, res, body) {
    return openSession(req, res, body, { reuse: false });
  }

  async function list(req, res) {
    if (disposed) return json(res, 503, { ok: false, code: 'terminal_unavailable', error: '终端已关闭。' });
    if (!enabled) {
      return json(res, 403, { ok: false, code: 'terminal_disabled', error: '终端仅在桌面版可用。' });
    }
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) {
      return json(res, 200, {
        ok: true, enabled: true, noProject: true, workspace: null, sessions: [],
      });
    }
    const visible = sessionsForWorkspace(workspace)
      .filter((session) => !session.retired)
      .sort((a, b) => (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER)
        || a.createdAt - b.createdAt)
      .map(publicSession);
    return json(res, 200, {
      ok: true,
      enabled: true,
      noProject: false,
      workspace: { id: workspace.id, generation: workspace.generation },
      sessions: visible,
    });
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
    /* Reading a cursor is explicit observation only. The renderer polls this
     * endpoint continuously, so it must not count as user or shell activity. */
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
    noteActivity(session);
    return json(res, 200, { ok: true, cursor: session.end });
  }

  /* Explicit, per-session exemption from the idle timer. It does not touch the
   * PTY, the buffer or the workspace binding. The server owns the flag; a
   * create/start body cannot pre-set it. Only a running session can be marked,
   * and a confirmed workspace change still retires the session through the
   * normal sweep/stop path. */
  async function setKeepAlive(req, res, body) {
    const id = typeof body?.id === 'string' ? body.id : '';
    const session = sessions.get(id);
    if (!session) return json(res, 404, { ok: false, code: 'terminal_missing', error: '终端会话不存在。' });
    await verifyScope(req, session);
    if (typeof body?.enabled !== 'boolean') {
      return json(res, 400, { ok: false, code: 'invalid_keep_alive', error: '保持运行状态不合法。' });
    }
    if (session.state !== 'running') {
      return json(res, 409, {
        ok: false,
        code: 'terminal_not_running',
        error: '终端已经停止，请重新启动。',
        session: publicSession(session),
      });
    }
    if (body.enabled) {
      setKeepAliveFlag(session, true);
      clearIdleTimer(session);
    } else {
      setKeepAliveFlag(session, false);
      /* Starting from this request, not from the last input/output: the user
       * gets a complete idle window after switching the exemption off. */
      session.lastActivityAt = Date.now();
      touch(session);
    }
    return json(res, 200, { ok: true, session: publicSession(session) });
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
    /* Resize is layout, not command input. Counting it would let window
     * resizing or a tab remount keep a silent shell alive, which is the same
     * class of bug as counting read polling. */
    return json(res, 200, { ok: true, cursor: session.end, cols: session.cols, rows: session.rows });
  }

  async function stop(req, res, body) {
    const id = typeof body?.id === 'string' ? body.id : '';
    const session = sessions.get(id);
    if (!session) return json(res, 404, { ok: false, code: 'terminal_missing', error: '终端会话不存在。' });
    // Every action, including stop, must prove that the session belongs to
    // this workspace.
    await verifyScope(req, session);
    if (FINISHED_STATES.has(session.state)) {
      return json(res, 200, { ok: true, session: publicSession(session) });
    }
    void stopSession(session, 'user');
    return json(res, 200, { ok: true, session: publicSession(session) });
  }

  /* Closing a tab is different from stopping a shell: stop leaves the exited
   * session visible so it can be restarted in place, close removes the tab and
   * its buffer for good. `close` is idempotent for a missing id — a repeated
   * click, a double request or a tab already cleaned up by another surface
   * must not surface an error. It still verifies workspace ownership before
   * touching a known id. */
  async function close(req, res, body) {
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!id || id.length > 128) {
      return json(res, 200, { ok: true, closed: true, missing: true });
    }
    const session = sessions.get(id);
    if (!session) return json(res, 200, { ok: true, closed: true, missing: true });
    await verifyScope(req, session);
    if (FINISHED_STATES.has(session.state)) {
      const snapshot = publicSession(session);
      removeSession(session);
      return json(res, 200, { ok: true, closed: true, session: snapshot });
    }
    if (session.state === 'closing') {
      session.retired = true;
      return json(res, 200, { ok: true, closed: true, session: publicSession(session) });
    }
    session.retired = true;
    void stopSession(session, 'closed');
    return json(res, 200, { ok: true, closed: true, session: publicSession(session) });
  }

  /* Mark the session retired and start the kill without blocking the sweep.
   * `stopSession` changes the state synchronously, so the next sweep's
   * `closing` branch can retry a wedged kill; awaiting the real exit here
   * would hold every other session behind a five-second timeout. */
  function retireInBackground(session, reason) {
    removeAndStop(session, reason).catch(() => {});
  }

  async function sweep() {
    if (sweeping || disposed) return;
    sweeping = true;
    try {
      for (const session of [...sessions.values()]) {
        if (session.state === 'closing') {
          /* A kill path that never produced an exit would otherwise leave the
           * session stuck in "closing" forever. Retry only while the identity
           * gate still allows it and the previous attempt has settled; after
           * the bounded budget the session stays closing instead of PID-killing
           * an unverified process. */
          if (session.killState === 'unconfirmed' || session.killInFlight) continue;
          if (Date.now() < (session.killNextAt || 0)) continue;
          attemptKill(session);
          continue;
        }
        if (session.state !== 'running') continue;
        try {
          const scope = typeof scopeForSession === 'function'
            ? await scopeForSession(session)
            : await scopeForRequest({
              headers: session.conversationId ? { 'x-pi-gui-conversation': session.conversationId } : {},
            });
          /* No scope means the registry could not answer (booting, invalidated,
           * or a race while it is being replaced). That is not evidence that
           * the workspace changed; keep the live PTY for the next sweep. */
          if (!scope) continue;
          const workspace = workspaceFor(scope);
          if (!workspace || workspace.id !== session.workspace.id) {
            retireInBackground(session, 'workspace');
          }
        } catch (error) {
          /* A deleted conversation or invalid workspace is confirmed state:
           * stop the PTY even if the shell keeps producing output. A transient
           * registry/filesystem failure is not proof of deletion; keep the
           * session for the next sweep instead of killing a healthy shell. */
          if (INVALID_SCOPE_CODES.has(error?.code)) {
            retireInBackground(session, 'conversation');
          }
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
        maxSessionsPerWorkspace: limits.maxSessionsPerWorkspace,
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
      if (body?.action === 'list') return await list(req, res);
      if (body?.action === 'create') return await create(req, res, body);
      if (body?.action === 'start') return await start(req, res, body);
      if (body?.action === 'input') return await input(req, res, body);
      if (body?.action === 'resize') return await resize(req, res, body);
      if (body?.action === 'keep-alive') return await setKeepAlive(req, res, body);
      if (body?.action === 'stop') return await stop(req, res, body);
      if (body?.action === 'close') return await close(req, res, body);
      return json(res, 400, { ok: false, code: 'invalid_action', error: '未知的终端操作。' });
    } catch (error) {
      return terminalError(res, error);
    }
  }

  function terminalError(res, error) {
    const code = error?.code || 'terminal_unavailable';
    const status = code === 'terminal_missing' ? 404
      : code === 'invalid_request' || code === 'invalid_input' || code === 'invalid_size'
        || code === 'invalid_cursor' || code === 'invalid_keep_alive' ? 400
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
            ? '终端数量已达上限，请先关闭一个终端。'
            : code === 'invalid_size'
              ? '终端尺寸不合法。'
              : code === 'invalid_cursor'
                ? '终端读取位置不合法。'
                : code === 'invalid_keep_alive'
                  ? '保持运行状态不合法。'
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
      clearIdleTimer(session);
      if (!FINISHED_STATES.has(session.state)) void stopSession(session, 'shutdown');
    }
    disposePromise = Promise.all(live
      .filter((session) => !FINISHED_STATES.has(session.state))
      .map((session) => waitForExit(session, 3000))).then(() => {
      for (const session of sessions.values()) disposeSessionHandles(session);
      sessions.clear();
      nextOrdinals.clear();
    });
    return disposePromise;
  }

  return { handle, dispose, _sessions: sessions };
}
