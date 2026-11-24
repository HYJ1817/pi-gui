/* Read-only project file browser for the right-pane Files surface.
 *
 * The renderer never supplies an absolute path for workspace files. The backend
 * resolves the focused conversation's workspace root, then applies the same
 * `resolveProjectPath` guard used by the Git / Specs readers. Symlinks are
 * skipped rather than followed; directory listings and file previews are
 * bounded so a large repository cannot turn into an unbounded response.
 *
 * Identity binding: a request must say *which* workspace it believes it is
 * reading. Workspace files accept either the opaque workspace token used by the
 * Files tree, or the message's workspace root plus a backend-issued file id.
 * The backend resolves the conversation itself; the renderer's claim can only
 * make a request fail, never redirect it.
 *
 * Work-area-external files are a separate, explicitly authorized surface
 * (`/api/files/external/*`). Grants are created only through the trusted
 * Electron parent channel; this module merely verifies them.
 *
 * This surface has no write, delete, rename or upload action. Those need a
 * separate design and explicit authorization.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isInside, normalizeForCompare, realPathOrNull, resolveProjectPath } from '../lib/safe-path.js';
import { json, readBody } from './http-utils.js';

export const FILE_LIMITS = Object.freeze({
  maxEntries: 512,
  maxPreviewBytes: 256 * 1024,
  maxAssetBytes: 8 * 1024 * 1024,
  maxPathChars: 1024,
  maxFindEntries: 4000,
  maxFindDepth: 8,
  maxFindMatches: 24,
});

const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
});
const FIND_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'target', 'vendor', '.cache']);
/* 通用预览入口永远不会执行文件；但“用系统默认程序打开”会。可执行脚本、
 * 快捷方式与安装包不通过这条通用入口直接启动。外部编辑器仍然可以打开它们
 * （编辑器只是读取字节），文件管理器定位与复制路径也不受影响。 */
const DANGEROUS_OPEN_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.scr', '.pif', '.cpl', '.msc',
  '.hta', '.hjs', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.ps1', '.psm1', '.psd1',
  '.reg', '.lnk', '.url', '.scf', '.jar', '.class', '.application', '.appref-ms',
  /* 脚本源码本身不会“被预览执行”，但“用系统默认程序打开”可能落到 node/python/
   * shell 的解释器关联上。通用打开入口不赌用户机器上的文件关联；源码仍可用
   * 内置查看器或外部编辑器打开。 */
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.pyw',
  '.sh', '.bash', '.zsh', '.fish', '.ksh', '.rb', '.pl', '.pm', '.php', '.lua',
]);
const FIND_CACHE_TTL_MS = 15_000;
const FIND_CACHE_LIMIT = 200;

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

/** Backend-issued identity for one concrete file object. The renderer cannot
 *  compute it without already having asked this backend about that file. */
function fileIdFor(workspace, absolutePath, stat) {
  return createHash('sha256')
    .update(`${workspace.id}\0${normalizeForCompare(absolutePath)}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}`)
    .digest('base64url')
    .slice(0, 32);
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
  const conversationId = typeof scope.conversationId === 'string' && scope.conversationId
    ? scope.conversationId
    : null;
  return {
    root,
    id: hash(normalizeForCompare(root) + '\0' + scopeId + '\0' + generation),
    generation,
    conversationId,
    scope,
  };
}

const publicWorkspace = (workspace) => workspace ? { id: workspace.id, generation: workspace.generation } : null;

function validateWorkspaceIdentity(workspace, expectedId, expectedGeneration, required = false) {
  const id = String(expectedId ?? '');
  const generation = String(expectedGeneration ?? '');
  if (!id || !generation) {
    if (required) throw fail('invalid_request', '缺少工作区身份，请刷新文件树。');
    return false;
  }
  if (workspace.id !== id || workspace.generation !== generation) {
    throw fail('stale_workspace', '工作区已经变化，请刷新文件树。');
  }
  return true;
}

function validateWorkspaceToken(workspace, url, required = false) {
  return validateWorkspaceIdentity(
    workspace,
    url.searchParams.get('workspace'),
    url.searchParams.get('generation'),
    required,
  );
}

function expectedRootOf(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > FILE_LIMITS.maxPathChars || raw.includes('\0')) return null;
  return realPathOrNull(raw);
}

function assertExpectedRoot(workspace, expectedRoot) {
  if (!expectedRoot) return;
  if (normalizeForCompare(workspace.root) !== normalizeForCompare(expectedRoot)) {
    throw fail('workspace_changed', '工作区已经变化，请重新打开会话。');
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

/** Read one already-guarded file. The caller must have verified that `abs` is
 *  an allowed real path. Identity is re-checked around the open/read window. */
function readFileBytes(abs, expected, maxBytes) {
  let fd = null;
  try {
    const stat = expected?.stat || statNoFollow(abs);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw fail('file_missing', '文件不存在。');
    if (stat.size > maxBytes) throw fail('oversized', '文件超过预览大小上限。');
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw fail('file_missing', '文件不存在。');
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw fail('unsafe_path', '文件对象已变化。');
    if (opened.size > maxBytes) throw fail('oversized', '文件超过预览大小上限。');
    const reopened = statNoFollow(abs);
    if (!reopened || reopened.isSymbolicLink() || !reopened.isFile()) throw fail('unsafe_path', '文件路径已变化。');
    const cap = maxBytes + 1;
    const buffer = Buffer.allocUnsafe(cap);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset > maxBytes) throw fail('oversized', '文件超过预览大小上限。');
    return buffer.subarray(0, offset);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* result already decided */ }
    }
  }
}

function decodeText(buffer) {
  let content = '';
  let binary = false;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (content.includes('\0')) binary = true;
  } catch {
    binary = true;
  }
  if (binary) content = '';
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return { content, binary };
}

export function createFiles({
  scopeForRequest = async () => null,
  /* 桌面版的长期授权由 Electron 主进程的系统设置文件持有；HTTP 撤销只能
   * 移除运行期副本，重启后主进程会把它恢复。显式拒绝，避免“撤销了但重启又回来”。 */
  mainOwnedPersistence = false,
  limits = FILE_LIMITS,
  grants = null,
  publish = () => {},
} = {}) {
  if (typeof scopeForRequest !== 'function') throw new TypeError('scopeForRequest must be a function');
  const findCache = new Map();

  function workspaceError(res, error) {
    const code = error?.code || 'files_unavailable';
    const status = code === 'invalid_request' ? 400 : code === 'stale_workspace' || code === 'workspace_changed' ? 409 : code === 'files_unavailable' ? 500 : 409;
    const message = code === 'unknown_conversation'
      ? '这个会话的工作区不可用，请刷新后重试。'
      : code === 'workspace_unavailable'
        ? '当前工作区不可用，请刷新后重试。'
        : code === 'stale_workspace'
          ? '工作区已经变化，请刷新文件树。'
          : code === 'workspace_changed'
            ? '工作区已经变化，请重新打开会话。'
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
    const hasToken = validateWorkspaceToken(workspace, url);
    const expectedRoot = expectedRootOf(url.searchParams.get('root'));
    if (!hasToken && !expectedRoot) {
      return json(res, 400, { ok: false, code: 'binding_required', error: '缺少工作区身份，请重新打开会话。' });
    }
    try {
      assertExpectedRoot(workspace, expectedRoot);
    } catch (error) {
      return workspaceError(res, error);
    }
    const expectedFileId = String(url.searchParams.get('fileId') || '');
    if (!hasToken && !expectedFileId) {
      return json(res, 428, { ok: false, code: 'file_identity_required', error: '缺少文件身份，请先读取文件信息。' });
    }

    const guard = resolveProjectPath(workspace.root, requested);
    if (!guard.ok) return json(res, 403, { ok: false, code: 'unsafe_path', error: '文件不在当前项目内。' });
    const stat = statNoFollow(guard.abs);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      return json(res, 404, { ok: false, code: 'file_missing', error: '文件不存在。' });
    }
    if (stat.size > limits.maxPreviewBytes) {
      return json(res, 413, { ok: false, code: 'oversized', error: '文件超过预览大小上限。' });
    }
    const fileId = fileIdFor(workspace, guard.abs, stat);
    if (expectedFileId && expectedFileId !== fileId) {
      return json(res, 409, { ok: false, code: 'file_changed', error: '文件已经变化，请重新打开。' });
    }

    try {
      const bytes = readFileBytes(guard.abs, { stat }, limits.maxPreviewBytes);
      const currentReal = realPathOrNull(guard.abs);
      if (!currentReal || !isInside(workspace.root, currentReal)) throw fail('unsafe_path', '文件不在当前项目内。');
      const { content, binary } = decodeText(bytes);
      return json(res, 200, {
        ok: true,
        workspace: publicWorkspace(workspace),
        file: {
          path: toSlashes(path.relative(workspace.root, guard.abs)),
          absolutePath: guard.abs,
          bytes: bytes.length,
          binary,
          fileId,
          content,
        },
      });
    } catch (error) {
      const code = error.code || 'file_unavailable';
      const status = code === 'oversized' ? 413 : code === 'unsafe_path' ? 403 : code === 'file_missing' ? 404 : 503;
      return json(res, status, { ok: false, code, error: code === 'oversized' ? '文件超过预览大小上限。' : code === 'file_missing' ? '文件不存在。' : '无法读取文件。' });
    }
  }

  /* 消息内文件引用只需要“这条相对路径现在是什么”，不读内容。
   * 工作区身份由调用方显式给出（消息自己的 cwd）或文件树令牌验证；
   * 后端只在自己的解析结果上比较，不接受渲染进程指定实际读取根。 */
  function guardWorkspaceFile(workspace, requested, { expectedRoot = null, expectedFileId = '', requireFileId = false } = {}) {
    if (!requested || requested.length > limits.maxPathChars || requested.includes('\0')) {
      return { code: 'invalid_request' };
    }
    assertExpectedRoot(workspace, expectedRoot);
    const guard = resolveProjectPath(workspace.root, requested);
    if (!guard.ok) return { code: 'unsafe_path' };
    const stat = statNoFollow(guard.abs);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return { code: 'file_missing' };
    const real = realPathOrNull(guard.abs);
    if (!real || !isInside(workspace.root, real)) return { code: 'unsafe_path' };
    const fileId = fileIdFor(workspace, real, stat);
    if (requireFileId && !expectedFileId) return { code: 'file_identity_required' };
    if (expectedFileId && expectedFileId !== fileId) return { code: 'file_changed' };
    return { abs: real, stat, path: toSlashes(path.relative(workspace.root, real)), fileId };
  }

  const guardError = (res, code) => {
    const status = code === 'invalid_request' ? 400
      : code === 'workspace_changed' || code === 'file_changed' ? 409
        : code === 'file_identity_required' ? 428
          : code === 'unsafe_path' ? 403
            : code === 'file_missing' ? 404 : 503;
    const message = code === 'invalid_request' ? '文件路径不合法。'
      : code === 'unsafe_path' ? '文件不在当前项目内。'
        : code === 'file_missing' ? '文件不存在。'
          : code === 'workspace_changed' ? '工作区已经变化，请重新打开会话。'
            : code === 'file_changed' ? '文件已经变化，请重新打开。'
              : code === 'file_identity_required' ? '缺少文件身份，请先读取文件信息。'
                : '无法读取文件。';
    return json(res, status, { ok: false, code, error: message });
  };

  async function metadata(req, res, url) {
    const requested = String(url.searchParams.get('path') || '');
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) return json(res, 409, { ok: false, code: 'workspace_unavailable', error: '当前工作区不可用。' });
    const expectedRoot = expectedRootOf(url.searchParams.get('root'));
    const hasToken = validateWorkspaceToken(workspace, url);
    if (!hasToken && !expectedRoot) {
      return json(res, 400, { ok: false, code: 'binding_required', error: '缺少工作区身份，请重新打开会话。' });
    }
    const guarded = guardWorkspaceFile(workspace, requested, {
      expectedRoot,
      expectedFileId: String(url.searchParams.get('fileId') || ''),
      requireFileId: false,
    });
    if (guarded.code) return guardError(res, guarded.code);
    const ext = path.extname(guarded.abs).toLowerCase();
    return json(res, 200, {
      ok: true,
      file: {
        path: guarded.path,
        absolutePath: guarded.abs,
        name: path.basename(guarded.abs),
        bytes: guarded.stat.size,
        image: Boolean(IMAGE_TYPES[ext]),
        fileId: guarded.fileId,
      },
    });
  }

  /* 图片是唯一在右栏内联渲染的二进制。只放行图片扩展名，读前先看大小，
   * 读的时候依旧 O_NOFOLLOW + fstat 身份复核，并带上禁止脚本执行的 CSP。 */
  async function asset(req, res, url) {
    const requested = String(url.searchParams.get('path') || '');
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) return json(res, 409, { ok: false, code: 'workspace_unavailable', error: '当前工作区不可用。' });
    const hasToken = validateWorkspaceToken(workspace, url);
    const expectedRoot = expectedRootOf(url.searchParams.get('root'));
    if (!hasToken && !expectedRoot) {
      return json(res, 400, { ok: false, code: 'binding_required', error: '缺少工作区身份，请重新打开会话。' });
    }
    try {
      assertExpectedRoot(workspace, expectedRoot);
    } catch (error) {
      return workspaceError(res, error);
    }
    const expectedFileId = String(url.searchParams.get('fileId') || '');
    if (!hasToken && !expectedFileId) {
      return json(res, 428, { ok: false, code: 'file_identity_required', error: '缺少文件身份，请先读取文件信息。' });
    }
    const guarded = guardWorkspaceFile(workspace, requested, {
      expectedRoot,
      expectedFileId,
      requireFileId: !hasToken,
    });
    if (guarded.code) return guardError(res, guarded.code);
    const ext = path.extname(guarded.abs).toLowerCase();
    const type = IMAGE_TYPES[ext];
    if (!type) return json(res, 415, { ok: false, code: 'unsupported_type', error: '这个格式不支持内联预览。' });
    if (guarded.stat.size > limits.maxAssetBytes) {
      return json(res, 413, { ok: false, code: 'oversized', error: '图片超过预览大小上限。' });
    }

    try {
      const buffer = readFileBytes(guarded.abs, guarded, limits.maxAssetBytes);
      const currentReal = realPathOrNull(guarded.abs);
      if (!currentReal || !isInside(workspace.root, currentReal)) throw fail('unsafe_path', '文件不在当前项目内。');
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Content-Disposition': 'inline',
      });
      res.end(buffer);
      return;
    } catch (error) {
      const code = error.code || 'file_unavailable';
      const status = code === 'oversized' ? 413 : code === 'unsafe_path' ? 403 : code === 'file_missing' ? 404 : 503;
      return json(res, status, { ok: false, code, error: code === 'oversized' ? '图片超过预览大小上限。' : code === 'file_missing' ? '文件不存在。' : '无法读取图片。' });
    }
  }

  /* 纯文件名只有在“唯一存在”时才升级为链接。遍历有深度与条目预算，
   * 跳过依赖/构建目录 —— 同名文件在 node_modules 里出现不算歧义。 */
  async function find(req, res, url) {
    const name = String(url.searchParams.get('name') || '');
    if (!safeName(name) || name === '.' || name === '..') {
      return json(res, 400, { ok: false, code: 'invalid_request', error: '文件名不合法。' });
    }
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) return json(res, 200, { ok: true, name, matches: [], truncated: false });
    const expectedRoot = expectedRootOf(url.searchParams.get('root'));
    if (!expectedRoot) {
      return json(res, 400, { ok: false, code: 'binding_required', error: '缺少工作区身份，请重新打开会话。' });
    }
    try {
      assertExpectedRoot(workspace, expectedRoot);
    } catch (error) {
      return workspaceError(res, error);
    }

    const cacheKey = `${workspace.id}\0${normalizeForCompare(name)}`;
    const cached = findCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FIND_CACHE_TTL_MS) {
      return json(res, 200, { ok: true, name, ...cached.value });
    }

    const queue = [{ abs: workspace.root, rel: '', depth: 0 }];
    const matches = [];
    let visited = 0;
    let truncated = false;
    const wanted = normalizeForCompare(name);
    for (let head = 0; head < queue.length && matches.length < limits.maxFindMatches; head++) {
      const current = queue[head];
      let dirents;
      try {
        dirents = await fs.promises.readdir(current.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      for (const entry of dirents) {
        if (visited >= limits.maxFindEntries) { truncated = true; break; }
        visited++;
        if (entry.isSymbolicLink()) continue;
        const rel = current.rel ? current.rel + '/' + entry.name : entry.name;
        if (entry.isFile()) {
          if (normalizeForCompare(entry.name) === wanted) matches.push(rel);
          if (matches.length >= limits.maxFindMatches) { truncated = true; break; }
          continue;
        }
        if (entry.name.startsWith('.')) continue;
        if (!entry.isDirectory()) continue;
        if (current.depth >= limits.maxFindDepth || FIND_SKIP_DIRS.has(entry.name)) continue;
        queue.push({ abs: path.join(current.abs, entry.name), rel, depth: current.depth + 1 });
      }
      if (truncated) break;
    }
    const value = { matches, truncated };
    if (findCache.size >= FIND_CACHE_LIMIT) {
      const oldest = findCache.keys().next().value;
      if (oldest !== undefined) findCache.delete(oldest);
    }
    findCache.set(cacheKey, { at: Date.now(), value });
    return json(res, 200, { ok: true, name, ...value });
  }

  function openTargetError(res, code, extra = {}) {
    if (code === 'unsafe_type') {
      return json(res, 415, { ok: false, code, error: '这个文件类型不会通过通用打开入口直接执行。', ...extra });
    }
    return guardError(res, code);
  }

  /* 授权“用系统默认程序打开 / 在文件管理器中显示 / 复制完整路径”的目标。
   * 返回后端认可的绝对路径；真正的 shell 调用在 Electron 主进程。
   *
   * 绑定规则：
   *   - 文件树：opaque workspace token + generation；
   *   - 会话内文件引用：消息工作区根 + 后端签发的 fileId；
   *   - 外部文件：走 /api/files/external/open-target + 授权令牌。 */
  async function openTarget(req, res) {
    let payload;
    try {
      payload = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
    } catch {
      return json(res, 400, { ok: false, code: 'invalid_request', error: '请求体不是合法 JSON。' });
    }
    const requested = String(payload?.path ?? '');
    const action = ['open', 'reveal', 'copy', 'editor'].includes(payload?.action) ? payload.action : 'open';
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) return json(res, 409, { ok: false, code: 'workspace_unavailable', error: '当前工作区不可用。' });

    const workspaceToken = payload?.workspace && typeof payload.workspace === 'object' ? payload.workspace : null;
    const hasToken = Boolean(workspaceToken?.id && payload?.generation !== undefined);
    if (hasToken) {
      try {
        validateWorkspaceIdentity(workspace, workspaceToken.id, payload.generation, true);
      } catch (error) {
        return workspaceError(res, error);
      }
    }
    const expectedRoot = expectedRootOf(payload?.root);
    if (payload?.root && !expectedRoot) {
      return json(res, 409, { ok: false, code: 'workspace_changed', error: '工作区已经变化，请重新打开会话。' });
    }
    if (!hasToken && !expectedRoot) {
      return json(res, 400, { ok: false, code: 'binding_required', error: '缺少工作区身份，请重新打开会话。' });
    }
    const expectedFileId = typeof payload?.fileId === 'string' ? payload.fileId : '';
    if (!hasToken && !expectedFileId) {
      return json(res, 428, { ok: false, code: 'file_identity_required', error: '缺少文件身份，请先读取文件信息。' });
    }

    let guarded;
    try {
      guarded = guardWorkspaceFile(workspace, requested, {
        expectedRoot,
        expectedFileId,
        requireFileId: !hasToken,
      });
    } catch (error) {
      return workspaceError(res, error);
    }
    if (guarded.code) return openTargetError(res, guarded.code);

    const ext = path.extname(guarded.abs).toLowerCase();
    if (action === 'open' && DANGEROUS_OPEN_EXTENSIONS.has(ext)) {
      return openTargetError(res, 'unsafe_type');
    }
    return json(res, 200, {
      ok: true,
      file: {
        path: guarded.path,
        absolutePath: guarded.abs,
        name: path.basename(guarded.abs),
        bytes: guarded.stat.size,
        fileId: guarded.fileId,
      },
    });
  }

  /* ---------- 工作区外文件（显式授权后） ---------- */

  const externalUnavailable = (res) => json(res, 503, {
    ok: false, code: 'external_unavailable', error: '外部文件授权只在桌面应用中可用。',
  });

  async function externalScope(req) {
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) throw fail('workspace_unavailable', '当前工作区不可用。');
    return {
      root: workspace.root,
      scopeId: workspace.scope?.scopeId,
      generation: workspace.generation,
      conversationId: workspace.conversationId,
    };
  }

  function externalError(res, error) {
    const code = error?.code || 'external_unavailable';
    const status = code === 'invalid_request' || code === 'invalid_path' || code === 'grant_required' || code === 'persistent_requires_directory'
      ? 400
      : code === 'grant_invalid' || code === 'grant_scope' || code === 'grant_changed' || code === 'sensitive_path' || code === 'scope_too_broad'
        ? 403
        : code === 'file_changed' || code === 'workspace_changed' ? 409
          : code === 'file_missing' || code === 'not_a_file' ? 404
            : code === 'oversized' ? 413
              : code === 'unsafe_path' ? 403
                : 503;
    const message = code === 'grant_required' ? '需要先授权访问这个文件。'
      : code === 'grant_invalid' ? '授权不存在、已撤销或不属于当前会话。'
        : code === 'grant_scope' ? '这个授权不覆盖该文件。'
          : code === 'grant_changed' ? '授权状态已经变化，请重新打开文件。'
            : code === 'file_changed' ? '授权的文件已经被替换，请重新授权。'
              : code === 'sensitive_path' ? '这个位置不能授权访问。'
                : code === 'scope_too_broad' ? '这个目录范围过大，请选择更具体的目录。'
                  : code === 'file_missing' ? '文件不存在。'
                    : code === 'oversized' ? '文件超过预览大小上限。'
                      : code === 'unsafe_path' ? '文件路径不安全。'
                        : error?.message || '无法读取外部文件。';
    return json(res, status, { ok: false, code, error: message });
  }

  async function authorizeExternal(req, url) {
    if (!grants) throw fail('external_unavailable');
    const grantId = String(url.searchParams.get('grant') || '');
    const requested = String(url.searchParams.get('path') || '');
    const scope = await externalScope(req);
    return { grantId, requested, scope, state: grants.authorizeRead({ grantId, rawPath: requested, scope }) };
  }

  async function externalMetadata(req, res, url) {
    if (!grants) return externalUnavailable(res);
    try {
      const { state } = await authorizeExternal(req, url);
      const ext = path.extname(state.real).toLowerCase();
      return json(res, 200, {
        ok: true,
        external: true,
        file: {
          path: state.real,
          absolutePath: state.real,
          name: path.basename(state.real),
          bytes: state.stat.size,
          image: Boolean(IMAGE_TYPES[ext]),
          grantId: state.grant.id,
        },
      });
    } catch (error) {
      return externalError(res, error);
    }
  }

  async function externalDocument(req, res, url) {
    if (!grants) return externalUnavailable(res);
    try {
      const { state } = await authorizeExternal(req, url);
      if (state.stat.size > limits.maxPreviewBytes) throw fail('oversized');
      const bytes = readFileBytes(state.real, state, limits.maxPreviewBytes);
      const again = realPathOrNull(state.real);
      if (!again || normalizeForCompare(again) !== normalizeForCompare(state.real)) throw fail('file_changed');
      grants.assertStillValid(state);
      const { content, binary } = decodeText(bytes);
      return json(res, 200, {
        ok: true,
        external: true,
        file: {
          path: state.real,
          absolutePath: state.real,
          bytes: bytes.length,
          binary,
          content,
          grantId: state.grant.id,
        },
      });
    } catch (error) {
      return externalError(res, error);
    }
  }

  async function externalAsset(req, res, url) {
    if (!grants) return externalUnavailable(res);
    try {
      const { state } = await authorizeExternal(req, url);
      const ext = path.extname(state.real).toLowerCase();
      const type = IMAGE_TYPES[ext];
      if (!type) return json(res, 415, { ok: false, code: 'unsupported_type', error: '这个格式不支持内联预览。' });
      if (state.stat.size > limits.maxAssetBytes) throw fail('oversized', '图片超过预览大小上限。');
      const buffer = readFileBytes(state.real, state, limits.maxAssetBytes);
      grants.assertStillValid(state);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Content-Disposition': 'inline',
      });
      res.end(buffer);
      return;
    } catch (error) {
      return externalError(res, error);
    }
  }

  async function externalOpenTarget(req, res) {
    if (!grants) return externalUnavailable(res);
    let payload;
    try {
      payload = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
    } catch {
      return json(res, 400, { ok: false, code: 'invalid_request', error: '请求体不是合法 JSON。' });
    }
    try {
      const scope = await externalScope(req);
      const state = grants.authorizeRead({
        grantId: typeof payload?.grant === 'string' ? payload.grant : '',
        rawPath: typeof payload?.path === 'string' ? payload.path : '',
        scope,
      });
      const action = ['open', 'reveal', 'copy', 'editor'].includes(payload?.action) ? payload.action : 'open';
      const ext = path.extname(state.real).toLowerCase();
      if (action === 'open' && DANGEROUS_OPEN_EXTENSIONS.has(ext)) {
        return json(res, 415, { ok: false, code: 'unsafe_type', error: '这个文件类型不会通过通用打开入口直接执行。' });
      }
      return json(res, 200, {
        ok: true,
        external: true,
        file: {
          path: state.real,
          absolutePath: state.real,
          name: path.basename(state.real),
          bytes: state.stat.size,
          grantId: state.grant.id,
        },
      });
    } catch (error) {
      return externalError(res, error);
    }
  }

  async function grantList(req, res) {
    if (!grants) return externalUnavailable(res);
    try {
      const scope = await externalScope(req);
      return json(res, 200, grants.list(scope));
    } catch (error) {
      return workspaceError(res, error);
    }
  }

  async function grantRevoke(req, res) {
    if (!grants) return externalUnavailable(res);
    let payload;
    try {
      payload = JSON.parse((await readBody(req, 8 * 1024)) || '{}');
    } catch {
      return json(res, 400, { ok: false, code: 'invalid_request', error: '请求体不是合法 JSON。' });
    }
    try {
      const scope = await externalScope(req);
      const id = typeof payload?.id === 'string' ? payload.id : '';
      if (mainOwnedPersistence) {
        const target = grants.list(scope).grants.find((grant) => grant.id === id);
        if (target?.scope === 'persistent') {
          return json(res, 409, {
            ok: false,
            code: 'desktop_required',
            error: '长期授权请通过桌面应用的设置页撤销。',
          });
        }
      }
      const result = grants.revoke({ id, scope });
      /* 渲染进程不能靠“撤销后不刷新”继续展示已加载内容；SSE 会关闭对应
       * 外部标签并清空元数据/授权缓存。 */
      try { publish({ type: 'external_grants', detail: { revoked: result.id } }); } catch { /* push is best-effort */ }
      return json(res, 200, result);
    } catch (error) {
      return externalError(res, error);
    }
  }

  async function handle(req, res, url) {
    try {
      if (url.pathname === '/api/files/open-target') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
        return await openTarget(req, res);
      }
      if (url.pathname === '/api/files/grants/revoke') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
        return await grantRevoke(req, res);
      }
      if (url.pathname === '/api/files/external/open-target') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
        return await externalOpenTarget(req, res);
      }
      if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
      if (url.pathname === '/api/files') return await list(req, res, url);
      if (url.pathname === '/api/files/document') return await document(req, res, url);
      if (url.pathname === '/api/files/metadata') return await metadata(req, res, url);
      if (url.pathname === '/api/files/asset') return await asset(req, res, url);
      if (url.pathname === '/api/files/find') return await find(req, res, url);
      if (url.pathname === '/api/files/grants') return await grantList(req, res);
      if (url.pathname === '/api/files/external/metadata') return await externalMetadata(req, res, url);
      if (url.pathname === '/api/files/external/document') return await externalDocument(req, res, url);
      if (url.pathname === '/api/files/external/asset') return await externalAsset(req, res, url);
      return json(res, 404, { ok: false, code: 'not_found', error: '未知的文件接口。' });
    } catch (error) {
      return workspaceError(res, error);
    }
  }

  return { handle };
}
