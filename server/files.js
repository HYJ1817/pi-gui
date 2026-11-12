/* Read-only project file browser for the right-pane Files surface.
 *
 * The renderer never supplies an absolute path. The backend resolves the
 * focused conversation's workspace root, then applies the same
 * `resolveProjectPath` guard used by the Git / Specs readers. Symlinks are
 * skipped rather than followed; directory listings and file previews are
 * bounded so a large repository cannot turn into an unbounded response.
 *
 * This surface deliberately has no write, delete, rename or upload action.
 * Those need a separate design and explicit authorization.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isInside, normalizeForCompare, realPathOrNull, resolveProjectPath } from '../lib/safe-path.js';
import { json } from './http-utils.js';

export const FILE_LIMITS = Object.freeze({
  maxEntries: 512,
  maxPreviewBytes: 256 * 1024,
  maxPathChars: 1024,
});

const fail = (code, message) => Object.assign(new Error(message || code), { code });
const hash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
const toSlashes = (value) => String(value).replace(/\\/g, '/');

function statNoFollow(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

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
  const generation = String(scope.generation ?? '');
  return {
    root,
    id: hash(normalizeForCompare(root) + '\0' + scopeId + '\0' + generation),
    generation,
  };
}

const publicWorkspace = (workspace) => workspace ? { id: workspace.id, generation: workspace.generation } : null;

function validateWorkspaceToken(workspace, url, required = false) {
  const expectedWorkspace = String(url.searchParams.get('workspace') || '');
  const expectedGeneration = String(url.searchParams.get('generation') || '');
  if (!expectedWorkspace || !expectedGeneration) {
    if (required) throw fail('invalid_request', '缺少工作区身份，请刷新文件树。');
    return;
  }
  if (workspace.id !== expectedWorkspace || workspace.generation !== expectedGeneration) {
    throw fail('stale_workspace', '工作区已经变化，请刷新文件树。');
  }
}

function safeName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= FILE_LIMITS.maxPathChars
    && !name.includes('\0')
    && !name.includes('/')
    && !name.includes('\\');
}

export function createFiles({
  scopeForRequest = async () => null,
  limits = FILE_LIMITS,
} = {}) {
  if (typeof scopeForRequest !== 'function') throw new TypeError('scopeForRequest must be a function');

  function workspaceError(res, error) {
    const code = error?.code || 'files_unavailable';
    const status = code === 'invalid_request' ? 400 : code === 'stale_workspace' ? 409 : code === 'files_unavailable' ? 500 : 409;
    const message = code === 'unknown_conversation'
      ? '这个会话的工作区不可用，请刷新后重试。'
      : code === 'workspace_unavailable'
        ? '当前工作区不可用，请刷新后重试。'
        : code === 'stale_workspace'
          ? '工作区已经变化，请刷新文件树。'
          : code === 'invalid_request'
            ? error.message
            : '无法读取项目文件。';
    return json(res, status, { ok: false, code, error: message });
  }

  async function list(req, res, url) {
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) {
      return json(res, 200, { ok: true, noProject: true, workspace: null, dir: '', entries: [], truncated: false });
    }
    validateWorkspaceToken(workspace, url);

    const dir = String(url.searchParams.get('dir') || '');
    if (dir.length > limits.maxPathChars || dir.includes('\0')) {
      return json(res, 400, { ok: false, code: 'invalid_request', error: '目录路径不合法。' });
    }
    const guard = resolveProjectPath(workspace.root, dir || '.');
    if (!guard.ok) {
      const status = guard.code === 'empty' ? 400 : guard.code === 'no-root' ? 503 : 403;
      return json(res, status, { ok: false, code: 'unsafe_path', error: '目录不在当前项目内。' });
    }
    let stat;
    try {
      stat = fs.lstatSync(guard.abs);
    } catch {
      return json(res, 404, { ok: false, code: 'directory_missing', error: '目录不存在。' });
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return json(res, 403, { ok: false, code: 'unsafe_path', error: '目录不在当前项目内。' });
    }
    const real = realPathOrNull(guard.abs);
    if (!real || !isInside(workspace.root, real)) {
      return json(res, 403, { ok: false, code: 'unsafe_path', error: '目录不在当前项目内。' });
    }

    const showHidden = url.searchParams.get('hidden') === '1';
    const entries = [];
    let truncated = false;
    let dirents;
    try {
      dirents = fs.readdirSync(real, { withFileTypes: true });
    } catch {
      return json(res, 503, { ok: false, code: 'directory_unavailable', error: '无法读取目录。' });
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const entry of dirents) {
      if (!safeName(entry.name)) continue;
      if (!showHidden && entry.name.startsWith('.')) continue;
      if (entries.length >= limits.maxEntries) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(real, entry.name);
      let childStat;
      try {
        childStat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (childStat.isSymbolicLink() || (!childStat.isDirectory() && !childStat.isFile())) continue;
      const childReal = childStat.isDirectory() ? realPathOrNull(full) : null;
      if (childStat.isDirectory() && (!childReal || !isInside(workspace.root, childReal))) continue;
      entries.push({
        name: entry.name,
        path: toSlashes(dir ? dir.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + entry.name : entry.name),
        type: childStat.isDirectory() ? 'dir' : 'file',
        bytes: childStat.isFile() ? childStat.size : null,
        hidden: entry.name.startsWith('.'),
      });
    }
    entries.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh'));

    return json(res, 200, {
      ok: true,
      workspace: publicWorkspace(workspace),
      dir: toSlashes(dir),
      entries,
      truncated,
      limits: { maxEntries: limits.maxEntries, maxPreviewBytes: limits.maxPreviewBytes },
    });
  }

  async function document(req, res, url) {
    const requested = String(url.searchParams.get('path') || '');
    if (!requested || requested.length > limits.maxPathChars) {
      return json(res, 400, { ok: false, code: 'invalid_request', error: '缺少文件路径。' });
    }
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) return json(res, 409, { ok: false, code: 'workspace_unavailable', error: '当前工作区不可用。' });
    validateWorkspaceToken(workspace, url, true);

    const guard = resolveProjectPath(workspace.root, requested);
    if (!guard.ok) return json(res, 403, { ok: false, code: 'unsafe_path', error: '文件不在当前项目内。' });
    const stat = statNoFollow(guard.abs);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      return json(res, 404, { ok: false, code: 'file_missing', error: '文件不存在。' });
    }
    if (stat.size > limits.maxPreviewBytes) {
      return json(res, 413, { ok: false, code: 'oversized', error: '文件超过预览大小上限。' });
    }

    let fd = null;
    try {
      fd = fs.openSync(guard.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) throw fail('file_missing', '文件不存在。');
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw fail('unsafe_path', '文件对象已变化。');
      if (opened.size > limits.maxPreviewBytes) throw fail('oversized', '文件超过预览大小上限。');
      const reopened = statNoFollow(guard.abs);
      if (!reopened || reopened.isSymbolicLink() || !reopened.isFile()) throw fail('unsafe_path', '文件路径已变化。');
      const currentReal = realPathOrNull(guard.abs);
      if (!currentReal || !isInside(workspace.root, currentReal)) throw fail('unsafe_path', '文件不在当前项目内。');

      const cap = limits.maxPreviewBytes + 1;
      const buffer = Buffer.allocUnsafe(cap);
      const bytes = fs.readSync(fd, buffer, 0, cap, 0);
      if (bytes > limits.maxPreviewBytes) throw fail('oversized', '文件超过预览大小上限。');
      let content = '';
      let binary = false;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
        if (content.includes('\0')) binary = true;
      } catch {
        binary = true;
      }
      if (binary) content = '';
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      return json(res, 200, {
        ok: true,
        workspace: publicWorkspace(workspace),
        file: {
          path: toSlashes(path.relative(workspace.root, guard.abs)),
          bytes,
          binary,
          content,
        },
      });
    } catch (error) {
      const code = error.code || 'file_unavailable';
      const status = code === 'oversized' ? 413 : code === 'unsafe_path' ? 403 : code === 'file_missing' ? 404 : 503;
      return json(res, status, { ok: false, code, error: code === 'oversized' ? '文件超过预览大小上限。' : code === 'file_missing' ? '文件不存在。' : '无法读取文件。' });
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* result already decided */ }
      }
    }
  }

  async function handle(req, res, url) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
    try {
      if (url.pathname === '/api/files') return await list(req, res, url);
      if (url.pathname === '/api/files/document') return await document(req, res, url);
      return json(res, 404, { ok: false, code: 'not_found', error: '未知的文件接口。' });
    } catch (error) {
      return workspaceError(res, error);
    }
  }

  return { handle };
}
