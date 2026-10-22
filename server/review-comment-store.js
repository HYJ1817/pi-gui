import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalPath, isInside, normalizeForCompare } from '../lib/safe-path.js';
import { REVIEW_DATA_LIMITS, sanitizeReviewComments, validReviewRevision } from '../lib/review-comment-data.js';

export const COMMENT_STORE_LIMITS = REVIEW_DATA_LIMITS;
const fail = code => { throw Object.assign(Error(code), { code }); };
const identity = s => `${s.dev}:${s.ino}:${s.birthtimeMs}`;
const same = (a, b) => normalizeForCompare(a) === normalizeForCompare(b);
const known = e => typeof e?.code === 'string' && e.code.startsWith('comment_');

/* Only synchronous, bounded filesystem operations run while the transaction
 * lock is held. No callbacks from a request can choose a filesystem path. */
export function createReviewCommentStore({ dataDir, protectedRoots = () => [], io = fs, checkpoint = () => {} } = {}) {
  const data = path.resolve(dataDir), root = path.join(data, 'review-comments');
  let dataIdentity = null, rootIdentity = null;
  const seen = new Set();
  function noLinks(target) {
    const parts = [];
    for (let p = path.resolve(target); ; p = path.dirname(p)) {
      parts.unshift(p); if (path.dirname(p) === p) break;
    }
    for (const p of parts) {
      const s = io.lstatSync(p);
      if (!s.isDirectory() || s.isSymbolicLink()) fail('comment_storage_unsafe');
    }
    if (!same(canonicalPath(target), target)) fail('comment_storage_unsafe');
  }
  function statMaybe(file) {
    try { return io.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  function guard(scope, create = false) {
    if (!scope || !/^[a-f0-9]{64}$/.test(scope.key) || typeof scope.projectRoot !== 'string'
      || typeof scope.assertCurrent !== 'function') fail('comment_scope_unavailable');
    scope.assertCurrent(); noLinks(data);
    const ds = identity(io.statSync(data));
    if (dataIdentity !== null && ds !== dataIdentity) fail('comment_storage_unsafe');
    dataIdentity = ds;
    const projects = [scope.projectRoot, scope.gitCommon, ...protectedRoots()].filter(p => typeof p === 'string' && p);
    for (const p of projects) {
      const resolved = canonicalPath(p);
      if (isInside(resolved, canonicalPath(data)) || isInside(resolved, canonicalPath(root))) fail('comment_storage_inside_project');
    }
    let rs = statMaybe(root);
    if (!rs && rootIdentity !== null) fail('comment_storage_unsafe');
    if (!rs && create) { io.mkdirSync(root, { mode: 0o700 }); rs = io.lstatSync(root); }
    if (!rs) return false;
    noLinks(root);
    const id = identity(rs);
    if (rootIdentity !== null && id !== rootIdentity) fail('comment_storage_unsafe');
    rootIdentity = id;
    return true;
  }
  function plainFile(file, max = REVIEW_DATA_LIMITS.fileBytes) {
    const s = statMaybe(file);
    if (!s) return null;
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || !same(canonicalPath(file), file)) fail('comment_storage_unsafe');
    if (s.size > max) fail('comment_storage_corrupt');
    return s;
  }
  function readDisk(scope) {
    if (!guard(scope)) return { version: 1, revision: null, comments: [] };
    const file = path.join(root, scope.key + '.json'), before = plainFile(file);
    if (!before) {
      if (seen.has(scope.key)) fail('comment_storage_corrupt');
      return { version: 1, revision: null, comments: [] };
    }
    const fd = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let text;
    try {
      const opened = io.fstatSync(fd);
      if (identity(opened) !== identity(before) || opened.nlink !== 1 || !opened.isFile()) fail('comment_storage_unsafe');
      const buf = Buffer.alloc(REVIEW_DATA_LIMITS.fileBytes + 1);
      let length = 0;
      while (length < buf.length) { const n = io.readSync(fd, buf, length, buf.length - length, length); if (!n) break; length += n; }
      if (length > REVIEW_DATA_LIMITS.fileBytes) fail('comment_storage_corrupt');
      const after = io.fstatSync(fd);
      if (identity(after) !== identity(before) || after.size !== length) fail('comment_storage_corrupt');
      text = buf.subarray(0, length).toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(buf.subarray(0, length))) fail('comment_storage_corrupt');
    } finally { io.closeSync(fd); }
    guard(scope);
    try {
      const v = JSON.parse(text);
      if (!v || Array.isArray(v) || Object.keys(v).length !== 4 || !Object.keys(v).every(k => ['version', 'scope', 'revision', 'comments'].includes(k))
        || ![1, 2].includes(v.version) || v.scope !== scope.key || v.revision === null || !validReviewRevision(v.revision)) fail('comment_storage_corrupt');
      const comments = sanitizeReviewComments(v.comments, { allowRanges: v.version === 2 });
      seen.add(scope.key);
      return { version: v.version, revision: v.revision, comments };
    } catch { fail('comment_storage_corrupt'); }
  }
  function read(scope) {
    try { const { revision, comments } = readDisk(scope); return { revision, comments }; }
    catch (e) { if (known(e)) throw e; fail('comment_storage_unavailable'); }
  }
  function removeOwned(file, expected) {
    try {
      const s = statMaybe(file);
      // Never unlink a replacement or follow a link during error cleanup.
      if (s?.isFile() && !s.isSymbolicLink() && s.nlink === 1 && identity(s) === expected) io.unlinkSync(file);
    } catch { /* Preserve uncertain files for explicit recovery. */ }
  }
  function write(scope, revision, values) {
    const comments = sanitizeReviewComments(values);
    if (!validReviewRevision(revision)) fail('comment_invalid');
    let lockFd, lockIdentity, temp, tempIdentity;
    const lock = path.join(root, '.writer.lock');
    try {
      guard(scope, true);
      try { lockFd = io.openSync(lock, 'wx', 0o600); }
      catch (e) { if (e.code === 'EEXIST') fail('comment_storage_busy'); throw e; }
      lockIdentity = identity(io.fstatSync(lockFd)); guard(scope);
      const names = io.readdirSync(root);
      if (names.length > 512) fail('comment_storage_limit');
      const files = names.filter(n => /^[a-f0-9]{64}\.json$/.test(n));
      const file = path.join(root, scope.key + '.json');
      if (!files.includes(path.basename(file)) && files.length >= REVIEW_DATA_LIMITS.scopes) fail('comment_storage_limit');
      const current = readDisk(scope);
      if (current.revision !== revision) fail('comment_conflict');
      const next = { revision: randomUUID(), comments };
      // Reading never migrates. Upgrade only as part of this locked CAS write;
      // once upgraded, keep v2 even after deleting the last range.
      const version = current.version === 2 || comments.some(c => c.anchor.range) ? 2 : 1;
      const bytes = Buffer.from(JSON.stringify({ version, scope: scope.key, ...next }) + '\n');
      if (bytes.length > REVIEW_DATA_LIMITS.fileBytes) fail('comment_storage_limit');
      temp = path.join(root, `.comment-${randomUUID()}.tmp`);
      const fd = io.openSync(temp, 'wx', 0o600);
      try { tempIdentity = identity(io.fstatSync(fd)); io.writeFileSync(fd, bytes); io.fsyncSync(fd); }
      finally { io.closeSync(fd); }
      checkpoint('temp-written'); guard(scope);
      if (identity(plainFile(temp)) !== tempIdentity || identity(plainFile(lock, 4096)) !== lockIdentity) fail('comment_storage_unsafe');
      if (readDisk(scope).revision !== revision) fail('comment_conflict');
      guard(scope); io.renameSync(temp, file); temp = null;
      guard(scope);
      if (identity(plainFile(file)) !== tempIdentity) fail('comment_storage_unsafe');
      seen.add(scope.key);
      return next;
    } catch (e) { if (known(e)) throw e; fail('comment_storage_write_failed'); }
    finally {
      if (temp && tempIdentity) removeOwned(temp, tempIdentity);
      if (lockFd !== undefined) { try { io.closeSync(lockFd); } catch {} }
      if (lockIdentity) removeOwned(lock, lockIdentity);
    }
  }
  return { read, write };
}
