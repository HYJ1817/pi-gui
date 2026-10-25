import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalPath, isInside, normalizeForCompare } from '../lib/safe-path.js';
import { LIMITS, validateDocument, serialize, deserialize } from '../lib/collab-doc.js';

export const COLLAB_STORE_LIMITS = Object.freeze({ fileBytes: LIMITS.serializedMaxBytes + 256, scopes: 20, entries: 512 });
const fail = code => { throw Object.assign(Error(code), { code }); };
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const samePath = (a, b) => normalizeForCompare(a) === normalizeForCompare(b);
const CODES = new Set(['collab_invalid', 'collab_conflict', 'collab_scope_unavailable', 'collab_storage_unsafe',
  'collab_storage_inside_project', 'collab_storage_corrupt', 'collab_storage_unavailable', 'collab_storage_write_failed',
  'collab_storage_busy', 'collab_storage_limit']);
const validRevision = value => Number.isSafeInteger(value) && value > 0;

/* The caller supplies backend authority, never a renderer locator. Synchronous,
 * bounded IO holds the single app-store lock across snapshot/CAS/rename. */
export function createCollabStore({ dataDir, protectedRoots = () => [], io = fs, checkpoint = () => {} } = {}) {
  const data = path.resolve(dataDir), root = path.join(data, 'collab-documents');
  let dataIdentity = null, rootIdentity = null;
  const seen = new Set();
  function statMaybe(file) {
    try { return io.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function noLinks(target) {
    const ancestors = [];
    for (let p = path.resolve(target); ; p = path.dirname(p)) {
      ancestors.unshift(p); if (path.dirname(p) === p) break;
    }
    for (const p of ancestors) {
      const stat = io.lstatSync(p);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('collab_storage_unsafe');
    }
    if (!samePath(canonicalPath(target), target)) fail('collab_storage_unsafe');
  }
  function guard(scope, create = false) {
    if (!scope || !/^[a-f0-9]{64}$/.test(scope.key) || !/^[a-f0-9]{64}$/.test(scope.token)
      || !/^[a-f0-9]{64}$/.test(scope.sessionId) || typeof scope.projectRoot !== 'string'
      || typeof scope.workspaceCwd !== 'string' || typeof scope.gitCommon !== 'string'
      || typeof scope.assertCurrent !== 'function') fail('collab_scope_unavailable');
    try { scope.assertCurrent(); } catch { fail('collab_scope_unavailable'); }
    noLinks(data);
    const ds = identity(io.lstatSync(data));
    if (dataIdentity !== null && ds !== dataIdentity) fail('collab_storage_unsafe');
    dataIdentity = ds;
    for (const project of [scope.projectRoot, scope.workspaceCwd, scope.gitCommon, ...protectedRoots()]) {
      if (typeof project !== 'string' || !project) continue;
      const resolved = canonicalPath(project);
      if (isInside(resolved, canonicalPath(data)) || isInside(resolved, canonicalPath(root))) fail('collab_storage_inside_project');
    }
    let stat = statMaybe(root);
    if (!stat && rootIdentity !== null) fail('collab_storage_unsafe');
    if (!stat && create) { io.mkdirSync(root, { mode: 0o700 }); stat = io.lstatSync(root); }
    if (!stat) return false;
    noLinks(root);
    const id = identity(stat);
    if (rootIdentity !== null && id !== rootIdentity) fail('collab_storage_unsafe');
    rootIdentity = id;
    return true;
  }
  function plainFile(file, max = COLLAB_STORE_LIMITS.fileBytes) {
    const stat = statMaybe(file);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(canonicalPath(file), file)) fail('collab_storage_unsafe');
    if (stat.size > max) fail('collab_storage_corrupt');
    return stat;
  }
  function encode(scope, doc) {
    return Buffer.from(`{"version":1,"scope":"${scope.key}","doc":${serialize(doc)}}\n`);
  }
  function readDisk(scope) {
    if (!guard(scope)) return { doc: null, bytes: null, identity: null };
    const file = path.join(root, scope.key + '.json'), before = plainFile(file);
    if (!before) {
      if (seen.has(scope.key)) fail('collab_storage_corrupt');
      return { doc: null, bytes: null, identity: null };
    }
    const fd = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes, contentChanged = false;
    try {
      const opened = io.fstatSync(fd);
      if (identity(opened) !== identity(before) || opened.nlink !== 1 || !opened.isFile()) fail('collab_storage_unsafe');
      const buffer = Buffer.alloc(COLLAB_STORE_LIMITS.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = io.readSync(fd, buffer, length, buffer.length - length, length);
        if (!n) break; length += n;
      }
      if (length > COLLAB_STORE_LIMITS.fileBytes) fail('collab_storage_corrupt');
      const after = io.fstatSync(fd);
      if (identity(after) !== identity(before) || after.nlink !== 1 || !after.isFile()) fail('collab_storage_unsafe');
      contentChanged = after.size !== length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs;
      bytes = buffer.subarray(0, length);
    } finally { io.closeSync(fd); }
    guard(scope);
    const afterPath = plainFile(file);
    if (!afterPath || identity(afterPath) !== identity(before)) fail('collab_storage_unsafe');
    if (contentChanged || afterPath.size !== bytes.length || afterPath.mtimeMs !== before.mtimeMs || afterPath.ctimeMs !== before.ctimeMs) fail('collab_storage_corrupt');
    try {
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) fail('collab_storage_corrupt');
      const value = JSON.parse(text);
      if (!value || Array.isArray(value) || Object.keys(value).length !== 3
        || !Object.keys(value).every(k => ['version', 'scope', 'doc'].includes(k))
        || value.version !== 1 || value.scope !== scope.key) fail('collab_storage_corrupt');
      const doc = deserialize(JSON.stringify(value.doc));
      if (doc.boundSessionId !== scope.sessionId || !encode(scope, doc).equals(bytes)) fail('collab_storage_corrupt');
      seen.add(scope.key);
      return { doc, bytes, identity: identity(before) };
    } catch { fail('collab_storage_corrupt'); }
  }
  function read(scope) {
    try { return { doc: readDisk(scope).doc }; }
    catch (error) { fail(CODES.has(error?.code) ? error.code : 'collab_storage_unavailable'); }
  }
  function verifyTemp(file, expectedIdentity, expectedBytes) {
    const before = plainFile(file);
    if (!before || identity(before) !== expectedIdentity || before.size !== expectedBytes.length) fail('collab_storage_unsafe');
    const fd = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = io.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || identity(opened) !== expectedIdentity) fail('collab_storage_unsafe');
      const actual = Buffer.alloc(expectedBytes.length + 1);
      let length = 0;
      while (length < actual.length) {
        const n = io.readSync(fd, actual, length, actual.length - length, length);
        if (!n) break; length += n;
      }
      const after = io.fstatSync(fd), current = plainFile(file);
      if (!current || identity(current) !== expectedIdentity || identity(after) !== expectedIdentity || after.nlink !== 1
        || after.size !== expectedBytes.length || current.size !== expectedBytes.length || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs || length !== expectedBytes.length || !actual.subarray(0, length).equals(expectedBytes)) fail('collab_storage_unsafe');
    } finally { io.closeSync(fd); }
  }
  function removeOwned(file, expected) {
    try {
      const stat = statMaybe(file);
      // Never remove a replacement, link, or uncertain abandoned artifact.
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && identity(stat) === expected) io.unlinkSync(file);
    } catch { /* Leave uncertain artifacts for explicit recovery. */ }
  }
  function write(scope, expectedRevision, value) {
    let doc;
    try { doc = validateDocument(value); }
    catch { fail('collab_invalid'); }
    if (expectedRevision !== null && !validRevision(expectedRevision)) fail('collab_invalid');
    let lockFd, lockIdentity, temp, tempIdentity;
    const lock = path.join(root, '.writer.lock');
    try {
      guard(scope, true);
      if (doc.boundSessionId !== scope.sessionId) fail('collab_invalid');
      try { lockFd = io.openSync(lock, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('collab_storage_busy'); throw error; }
      lockIdentity = identity(io.fstatSync(lockFd));
      io.closeSync(lockFd); lockFd = undefined;
      guard(scope);
      const names = io.readdirSync(root);
      if (names.length > COLLAB_STORE_LIMITS.entries) fail('collab_storage_limit');
      const files = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      const file = path.join(root, scope.key + '.json');
      if (!files.includes(path.basename(file)) && files.length >= COLLAB_STORE_LIMITS.scopes) fail('collab_storage_limit');
      const current = readDisk(scope), bytes = encode(scope, doc);
      if (bytes.length > COLLAB_STORE_LIMITS.fileBytes) fail('collab_storage_limit');
      if (current.doc && current.doc.documentId !== doc.documentId) fail('collab_invalid');
      if (current.bytes?.equals(bytes) && (expectedRevision === current.doc.revision
        || (expectedRevision === null ? current.doc.revision === 1 : expectedRevision + 1 === current.doc.revision))) return { doc };
      if ((current.doc?.revision ?? null) !== expectedRevision) fail('collab_conflict');
      if (doc.revision !== (expectedRevision === null ? 1 : expectedRevision + 1)) fail('collab_invalid');
      temp = path.join(root, `.collab-${randomUUID()}.tmp`);
      const fd = io.openSync(temp, 'wx', 0o600);
      try { tempIdentity = identity(io.fstatSync(fd)); io.writeFileSync(fd, bytes); io.fsyncSync(fd); }
      finally { io.closeSync(fd); }
      checkpoint('temp-written');
      guard(scope);
      const tempStat = plainFile(temp), lockStat = plainFile(lock, 4096);
      if (!tempStat || identity(tempStat) !== tempIdentity || !lockStat || identity(lockStat) !== lockIdentity) fail('collab_storage_unsafe');
      verifyTemp(temp, tempIdentity, bytes);
      const latest = readDisk(scope);
      if (latest.identity !== current.identity) fail('collab_storage_unsafe');
      if (latest.bytes === null ? current.bytes !== null : !latest.bytes.equals(current.bytes)) fail('collab_conflict');
      // No callbacks/awaits after the final identity+byte comparison. The rename
      // is the commit point; never report a later validation error as no write.
      io.renameSync(temp, file); temp = null;
      seen.add(scope.key);
      return { doc };
    } catch (error) { fail(CODES.has(error?.code) ? error.code : 'collab_storage_write_failed'); }
    finally {
      if (temp && tempIdentity) removeOwned(temp, tempIdentity);
      if (lockFd !== undefined) { try { io.closeSync(lockFd); } catch {} }
      if (lockIdentity) removeOwned(lock, lockIdentity);
    }
  }
  return { read, write };
}
