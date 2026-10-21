/* Read-only project Specs index and document reader.
 *
 * The renderer never supplies a path. It receives opaque, recomputable document
 * IDs from this module and asks for one of those IDs inside an opaque workspace
 * token. Every request resolves the current workspace scope on the backend.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isInside, normalizeForCompare, realPathOrNull, resolveProjectPath } from '../lib/safe-path.js';
import { json } from './http-utils.js';

export const SPEC_LIMITS = Object.freeze({
  maxDocuments: 256,
  maxScanEntries: 4096,
  maxDepth: 16,
  maxDocumentBytes: 256 * 1024,
});

const HASH_HEX = 32;
const fail = (code, message) => Object.assign(new Error(message || code), { code });
const hash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, HASH_HEX);
const toSlashes = (value) => String(value).replace(/\\/g, '/');
const isMarkdown = (name) => /\.(?:md|markdown)$/i.test(name);
const isAllowedRel = (rel) => rel === 'SPEC.md' || (rel.startsWith('specs/') && isMarkdown(rel));
const docId = (rel) => hash(toSlashes(rel));

function statNoFollow(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function discover(root, limits = SPEC_LIMITS) {
  const rootReal = realPathOrNull(root);
  if (!rootReal) return { documents: [], truncated: false, incomplete: false, root: null };
  let rootStat;
  try {
    rootStat = fs.statSync(rootReal);
  } catch {
    return { documents: [], truncated: false, incomplete: true, root: null };
  }
  if (!rootStat.isDirectory()) {
    return { documents: [], truncated: false, incomplete: true, root: null };
  }

  const documents = [];
  let scanned = 0;
  let truncated = false;
  let incomplete = false;

  const add = (rel, full) => {
    if (documents.length >= limits.maxDocuments) {
      truncated = true;
      return;
    }
    const stat = statNoFollow(full);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
    const renderedRel = toSlashes(rel);
    if (!isAllowedRel(renderedRel)) return;
    documents.push({
      id: docId(renderedRel),
      path: renderedRel,
      bytes: stat.size,
      oversized: stat.size > limits.maxDocumentBytes,
      main: renderedRel === 'SPEC.md',
    });
  };

  const walk = (dir, relDir, depth) => {
    if (truncated || incomplete) return;
    if (depth > limits.maxDepth) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      incomplete = true;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (scanned >= limits.maxScanEntries) {
        truncated = true;
        return;
      }
      scanned++;
      const full = path.join(dir, entry.name);
      const stat = statNoFollow(full);
      if (!stat || stat.isSymbolicLink()) continue;
      const rel = relDir + '/' + entry.name;
      if (stat.isDirectory()) {
        const childReal = realPathOrNull(full);
        if (!childReal || !isInside(rootReal, childReal)) continue;
        walk(full, rel, depth + 1);
      } else if (stat.isFile() && isMarkdown(entry.name)) {
        add(rel, full);
      }
    }
  };

  try {
    const rootEntries = fs.readdirSync(rootReal, { withFileTypes: true });
    const spec = rootEntries.find((entry) => entry.name === 'SPEC.md');
    if (spec) add('SPEC.md', path.join(rootReal, 'SPEC.md'));
    const specs = rootEntries.find((entry) => entry.name === 'specs');
    if (specs) {
      const specsDir = path.join(rootReal, 'specs');
      const specsStat = statNoFollow(specsDir);
      const specsReal = specsStat && !specsStat.isSymbolicLink() && specsStat.isDirectory()
        ? realPathOrNull(specsDir) : null;
      if (specsReal && isInside(rootReal, specsReal)) walk(specsDir, 'specs', 0);
    }
  } catch {
    incomplete = true;
  }

  documents.sort((a, b) => {
    if (a.main !== b.main) return a.main ? -1 : 1;
    return a.path.localeCompare(b.path, 'zh');
  });
  return { documents, truncated, incomplete, root: rootReal };
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

function publicWorkspace(workspace) {
  return workspace ? { id: workspace.id, generation: workspace.generation } : null;
}

function readBoundedDocument(root, document, limits = SPEC_LIMITS) {
  if (document.oversized) throw fail('oversized', '文档超过大小上限');
  const guard = resolveProjectPath(root, document.path);
  if (!guard.ok) throw fail('unsafe_path', '文档路径不在当前项目内');
  const rootReal = realPathOrNull(root);
  if (!rootReal || !isInside(rootReal, guard.abs)) throw fail('unsafe_path', '文档路径不在当前项目内');
  if (!isAllowedRel(toSlashes(path.relative(rootReal, guard.abs)))) throw fail('unsafe_path', '文档不在允许的 Specs 范围');
  const stat = statNoFollow(guard.abs);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw fail('document_missing', '文档不存在');
  if (stat.size > limits.maxDocumentBytes) throw fail('oversized', '文档超过大小上限');

  let fd = null;
  try {
    fd = fs.openSync(guard.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw fail('document_missing', '文档不存在');
    if (stat.dev !== opened.dev || stat.ino !== opened.ino) throw fail('unsafe_path', '文档对象已变化');
    if (opened.size > limits.maxDocumentBytes) throw fail('oversized', '文档超过大小上限');
    /* Re-check after opening. This catches a path that changed to a symlink
     * between resolveProjectPath() and openSync(), and O_NOFOLLOW is used when
     * the platform provides it. */
    const reopened = statNoFollow(guard.abs);
    if (!reopened || reopened.isSymbolicLink() || !reopened.isFile()) throw fail('unsafe_path', '文档路径已变化');
    const currentReal = realPathOrNull(guard.abs);
    if (!currentReal || !isInside(rootReal, currentReal)) throw fail('unsafe_path', '文档路径不在当前项目内');
    /* Always read one byte past the public limit. Sizing the buffer from the
     * earlier fstat value would silently truncate a file that grows between
     * fstat and read, and the oversize refusal would be missed. */
    const cap = limits.maxDocumentBytes + 1;
    const buffer = Buffer.allocUnsafe(cap);
    const bytes = fs.readSync(fd, buffer, 0, cap, 0);
    if (bytes > limits.maxDocumentBytes) throw fail('oversized', '文档超过大小上限');
    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    } catch {
      throw fail('invalid_text', '文档不是有效的 UTF-8 文本');
    }
    if (content.includes('\0')) throw fail('invalid_text', '文档包含二进制内容');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return { ...document, content };
  } catch (error) {
    if (error.code) throw error;
    throw fail('document_unavailable', '无法读取文档');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* read result is already decided */ }
    }
  }
}

export function createSpecs({
  scopeForRequest = async () => null,
  limits = SPEC_LIMITS,
} = {}) {
  if (typeof scopeForRequest !== 'function') throw new TypeError('scopeForRequest must be a function');

  function workspaceError(res, error) {
    const code = error?.code || 'specs_unavailable';
    const message = code === 'unknown_conversation'
      ? '这个会话的工作区不可用，请刷新后重试。'
      : code === 'workspace_unavailable'
        ? '当前工作区不可用，请刷新后重试。'
        : '无法读取项目文档。';
    return json(res, code === 'specs_unavailable' ? 500 : 409, { ok: false, code, error: message });
  }

  async function index(req, res) {
    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) {
      return json(res, 200, { ok: true, noProject: true, workspace: null, documents: [], truncated: false, incomplete: false });
    }
    const found = discover(workspace.root, limits);
    if (!found.root) return json(res, 200, { ok: true, noProject: true, workspace: null, documents: [], truncated: false, incomplete: true });
    return json(res, 200, {
      ok: true,
      workspace: publicWorkspace(workspace),
      documents: found.documents,
      truncated: found.truncated,
      incomplete: found.incomplete,
      limits: { maxDocuments: limits.maxDocuments, maxDocumentBytes: limits.maxDocumentBytes },
    });
  }

  async function document(req, res, url) {
    const id = String(url.searchParams.get('id') || '');
    const expectedWorkspace = String(url.searchParams.get('workspace') || '');
    const expectedGeneration = String(url.searchParams.get('generation') || '');
    if (!/^[a-f0-9]{32}$/.test(id) || !expectedWorkspace || !expectedGeneration) {
      return json(res, 400, { ok: false, code: 'invalid_request', error: '缺少有效的文档身份。' });
    }

    const scope = await scopeForRequest(req);
    const workspace = workspaceFor(scope);
    if (!workspace) return json(res, 409, { ok: false, code: 'workspace_unavailable', error: '当前工作区不可用，请刷新后重试。' });
    if (workspace.id !== expectedWorkspace || workspace.generation !== expectedGeneration) {
      return json(res, 409, { ok: false, code: 'stale_workspace', error: '工作区已经变化，请刷新文档树。' });
    }

    const found = discover(workspace.root, limits);
    const entry = found.documents.find((item) => item.id === id);
    if (!entry) return json(res, 404, { ok: false, code: 'document_missing', error: '文档不存在或已移出 Specs 范围。' });
    try {
      const read = readBoundedDocument(workspace.root, entry, limits);
      return json(res, 200, { ok: true, workspace: publicWorkspace(workspace), document: read });
    } catch (error) {
      const code = error.code || 'document_unavailable';
      const status = code === 'oversized' ? 413 : code === 'invalid_text' ? 422 : code === 'document_missing' ? 404 : 503;
      const message = code === 'oversized'
        ? '文档超过预览大小上限。'
        : code === 'invalid_text'
          ? '文档不是可安全显示的文本。'
          : code === 'document_missing'
            ? '文档不存在或已删除。'
            : '当前无法读取文档，请刷新后重试。';
      return json(res, status, { ok: false, code, error: message });
    }
  }

  async function handle(req, res, url) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
    try {
      if (url.pathname === '/api/specs') return await index(req, res);
      if (url.pathname === '/api/specs/document') return await document(req, res, url);
      return json(res, 404, { ok: false, code: 'not_found', error: '未知的 Specs 接口。' });
    } catch (error) {
      return workspaceError(res, error);
    }
  }

  return { handle };
}
