/* Minimal project-scoped command terminal for the right-pane Terminal surface.
 *
 * This is a pipe-backed shell, not a PTY. It is honest about that boundary:
 * full-screen terminal programs (vim, top, ...) are not supported. Commands
 * run in the focused conversation's workspace, the renderer never supplies a
 * cwd, and the desktop/local-token boundary is checked by the router before
 * this module is reached.
 *
 * Output is bounded in memory and never written to logs. A session dies when
 * its panel is released, when the workspace changes, or after an idle timeout.
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { isInside, normalizeForCompare, realPathOrNull } from '../lib/safe-path.js';
import { json, readRawBody } from './http-utils.js';

export const TERMINAL_LIMITS = Object.freeze({
  maxSessions: 2,
  maxInputBytes: 16 * 1024,
  maxBufferChars: 256 * 1024,
  maxBodyBytes: 32 * 1024,
  idleMs: 30 * 60 * 1000,
});

const fail = (code, message) => Object.assign(new Error(message || code), { code });
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
const toSlashes = (value) => String(value).replace(/\\/g, '/');

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
    id: hash(normalizeForCompare(root) + '\0' + scopeId + '\0' + String(scope.generation ?? '')),
    generation: String(scope.generation ?? ''),
  };
}

function normalizeOutput(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function defaultSpawnShell({ cwd, env, platform = process.platform }) {
  if (platform === 'win32') {
    const winRoot = env.SystemRoot || 'C:\\Windows';
    const comspec = env.ComSpec || path.join(winRoot, 'System32', 'cmd.exe');
    const powershell = path.join(winRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const hasPowerShell = fs.existsSync(powershell);
    // `cmd /k` receives this whole string as one argument. Windows command
    // line quoting turns a quoted absolute executable path into a literal
    // quoted token that cmd cannot resolve, so do not embed quotes here.
    // `%SystemRoot%` expands without spaces in the standard Windows layout,
    // and naming the full System32 path also keeps cmd's current-directory
    // search from picking a project-local `powershell.exe` / `chcp.com`.
    const command = hasPowerShell
      ? '%SystemRoot%\\System32\\chcp.com 65001>nul && %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoProfile -NoExit -Command -'
      : '%SystemRoot%\\System32\\chcp.com 65001>nul';
    const child = spawn(comspec, ['/d', '/q', '/k', command], {
      cwd,
      // cmd expands %SystemRoot% from its environment; pin it even when the
      // caller's environment is unusually sparse.
      env: { ...env, SystemRoot: winRoot },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { child, shell: hasPowerShell ? 'PowerShell' : '命令提示符' };
  }
  const configured = typeof env.SHELL === 'string' && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/sh';
  const child = spawn(configured, [], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  return { child, shell: path.basename(configured) || 'shell' };
}

function defaultKillTree(child, platform = process.platform) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (platform === 'win32' && child.pid) {
      // Absolute path: do not let a project-local taskkill.exe win cmd's
      // current-directory search when the server itself runs inside the project.
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 2000);
      timer.unref?.();
    }
  } catch {
    try { child.kill(); } catch { /* already gone */ }
  }
}

export function createTerminal({
  scopeForRequest = async () => null,
  enabled = true,
  limits = TERMINAL_LIMITS,
  spawnShell = defaultSpawnShell,
  killTree = defaultKillTree,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (typeof scopeForRequest !== 'function') throw new TypeError('scopeForRequest must be a function');
  if (typeof spawnShell !== 'function') throw new TypeError('spawnShell must be a function');

  const sessions = new Map();

  function append(session, text) {
    if (!text) return;
    const next = normalizeOutput(text);
    if (!next) return;
    session.output += next;
    session.end += next.length;
    if (session.output.length > limits.maxBufferChars) {
      const drop = session.output.length - limits.maxBufferChars;
      session.output = session.output.slice(drop);
      session.start += drop;
      session.dropped = true;
    }
    session.lastAt = Date.now();
    touch(session);
  }

  function publicSession(session) {
    return {
      id: session.id,
      workspace: { id: session.workspace.id, generation: session.workspace.generation },
      cwd: toSlashes(session.workspace.root),
      shell: session.shell,
      state: session.state,
      exitCode: session.exitCode,
      cursor: session.end,
      createdAt: session.createdAt,
      pipe: true,
    };
  }

  function touch(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (sessions.get(session.id) !== session) return;
      append(session, '\n[空闲超时，终端已停止]\n');
      stopSession(session);
    }, limits.idleMs);
    session.timer.unref?.();
  }

  function stopSession(session) {
    if (!session || session.state === 'exited' || session.state === 'failed') return;
    session.state = 'stopping';
    clearTimeout(session.timer);
    try {
      killTree(session.child, platform);
    } catch {
      try { session.child.kill(); } catch { /* already gone */ }
    }
    const force = setTimeout(() => {
      if (session.state === 'stopping') {
        session.state = 'exited';
        session.exitCode = null;
        append(session, '\n[终端已停止]\n');
      }
    }, 2500);
    force.unref?.();
  }

  function dropOldest(except) {
    const finished = [...sessions.values()]
      .filter((session) => ['exited', 'failed'].includes(session.state))
      .sort((a, b) => a.lastAt - b.lastAt);
    while (sessions.size >= limits.maxSessions && finished.length) sessions.delete(finished.shift().id);
    const live = [...sessions.values()]
      .filter((session) => session !== except && !['exited', 'failed'].includes(session.state))
      .sort((a, b) => a.createdAt - b.createdAt);
    while (sessions.size >= limits.maxSessions && live.length) {
      const victim = live.shift();
      stopSession(victim);
      sessions.delete(victim.id);
    }
  }

  async function start(req, res) {
    if (!enabled) {
      return json(res, 403, { ok: false, code: 'terminal_disabled', error: '终端仅在桌面版可用。' });
    }
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) {
      return json(res, 200, { ok: true, noProject: true, enabled: true, session: null });
    }
    for (const session of sessions.values()) {
      if (session.workspace.id === workspace.id && !['exited', 'failed', 'stopping'].includes(session.state)) {
        return json(res, 200, { ok: true, enabled: true, session: publicSession(session) });
      }
    }
    dropOldest();
    const childEnv = { ...env };
    delete childEnv.PI_GUI_TOKEN;
    let spawned;
    try {
      spawned = spawnShell({ cwd: workspace.root, env: childEnv, platform });
    } catch {
      return json(res, 503, { ok: false, code: 'terminal_unavailable', error: '无法启动终端。' });
    }
    const { child, shell } = spawned || {};
    if (!child || !child.stdin || !child.stdout) {
      try { child?.kill?.(); } catch { /* noop */ }
      return json(res, 503, { ok: false, code: 'terminal_unavailable', error: '无法启动终端。' });
    }

    const session = {
      id: crypto.randomUUID(),
      workspace,
      child,
      shell: typeof shell === 'string' && shell ? shell : 'shell',
      output: '',
      start: 0,
      end: 0,
      dropped: false,
      state: 'running',
      exitCode: null,
      createdAt: Date.now(),
      lastAt: Date.now(),
      timer: null,
    };
    sessions.set(session.id, session);
    touch(session);

    child.stdout.setEncoding('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => append(session, chunk));
    child.stderr?.on?.('data', (chunk) => append(session, chunk));
    child.stdin.on?.('error', () => { /* the exit handler reports the real state */ });
    child.on?.('error', () => {
      session.state = 'failed';
      clearTimeout(session.timer);
      append(session, '\n[终端进程启动失败]\n');
    });
    child.on?.('exit', (code, signal) => {
      if (session.state === 'exited' || session.state === 'failed') return;
      session.state = 'exited';
      session.exitCode = Number.isInteger(code) ? code : null;
      clearTimeout(session.timer);
      const suffix = session.exitCode === null ? (signal ? ` (${signal})` : '') : ` (${session.exitCode})`;
      append(session, `\n[进程已退出${suffix}]\n`);
    });

    return json(res, 200, { ok: true, enabled: true, session: publicSession(session) });
  }

  async function verifyScope(req, session) {
    if (!session) throw fail('terminal_missing', '终端会话不存在。');
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace || workspace.id !== session.workspace.id) {
      stopSession(session);
      throw fail('stale_workspace', '工作区已经变化，终端已停止。');
    }
  }

  async function read(req, res, url) {
    const id = String(url.searchParams.get('id') || '');
    const session = sessions.get(id);
    if (!session) return json(res, 404, { ok: false, code: 'terminal_missing', error: '终端会话不存在。' });
    await verifyScope(req, session);
    const sinceRaw = Number(url.searchParams.get('since'));
    const since = Number.isSafeInteger(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0;
    const cursor = session.end;
    let text;
    let truncated = false;
    if (since < session.start) {
      text = session.output;
      truncated = true;
    } else if (since > cursor) {
      text = '';
    } else {
      text = session.output.slice(since - session.start);
    }
    session.lastAt = Date.now();
    touch(session);
    return json(res, 200, {
      ok: true,
      text,
      cursor,
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
      session.child.stdin.write(data);
    } catch {
      return json(res, 503, { ok: false, code: 'terminal_unavailable', error: '无法写入终端。' });
    }
    touch(session);
    return json(res, 200, { ok: true, cursor: session.end });
  }

  function stop(req, res, body) {
    const id = typeof body?.id === 'string' ? body.id : '';
    const session = sessions.get(id);
    if (!session) return json(res, 404, { ok: false, code: 'terminal_missing', error: '终端会话不存在。' });
    stopSession(session);
    return json(res, 200, { ok: true });
  }

  async function handle(req, res, url) {
    if (url.pathname === '/api/terminal/status') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
      return json(res, 200, { ok: true, enabled, platform, pipe: true });
    }
    if (url.pathname !== '/api/terminal') {
      return json(res, 404, { ok: false, code: 'not_found', error: '未知的终端接口。' });
    }
    if (req.method === 'GET') {
      try {
        return await read(req, res, url);
      } catch (error) {
        return terminalError(res, error);
      }
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
    let body;
    try {
      body = JSON.parse((await readRawBody(req, limits.maxBodyBytes)).toString('utf8') || '{}');
    } catch {
      return json(res, 400, { ok: false, code: 'invalid_request', error: '请求不是合法 JSON。' });
    }
    try {
      if (body?.action === 'start') return await start(req, res);
      if (body?.action === 'input') return await input(req, res, body);
      if (body?.action === 'stop') return stop(req, res, body);
      return json(res, 400, { ok: false, code: 'invalid_action', error: '未知的终端操作。' });
    } catch (error) {
      return terminalError(res, error);
    }
  }

  function terminalError(res, error) {
    const code = error?.code || 'terminal_unavailable';
    const status = code === 'terminal_missing' ? 404
      : code === 'stale_workspace' || code === 'terminal_not_running' ? 409
        : code === 'unknown_conversation' || code === 'workspace_unavailable' ? 409
          : 503;
    const message = code === 'stale_workspace'
      ? '工作区已经变化，终端已停止。'
      : code === 'terminal_not_running'
        ? '终端已经停止，请重新启动。'
        : code === 'terminal_missing'
          ? '终端会话不存在。'
          : '终端暂时不可用。';
    return json(res, status, { ok: false, code, error: message });
  }

  function dispose() {
    for (const session of sessions.values()) {
      clearTimeout(session.timer);
      stopSession(session);
    }
    sessions.clear();
  }

  return { handle, dispose, _sessions: sessions };
}
