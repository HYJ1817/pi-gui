import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalPath } from '../lib/safe-path.js';
import {
  HTML_ARTIFACT_VERSION, HTML_ARTIFACT_MAX_BYTES, normalizeHtmlArtifactHeight,
  isHtmlArtifactId, projectHtmlArtifactReference,
} from '../public/html-artifact-model.js';

// Byte quotas count the physical HTML + reference + pending marker bytes;
// reaching a bound rejects publication, never evicts an older snapshot.
export const HTML_ARTIFACT_STORE_LIMITS = Object.freeze({
  totalBytes: 64 * 1024 * 1024, sessionBytes: 16 * 1024 * 1024,
  totalCount: 4096, sessionCount: 256,
});
const META_BYTES = 16 * 1024;
const TEMP = /^\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FILES = ['document.html', 'reference.json', '.pending'];
const INPUT_KEYS = ['sessionId', 'messageId', 'toolCallId', 'title', 'html', 'height'];
const CODES = new Set(['html_artifact_invalid', 'html_artifact_not_found', 'html_artifact_conflict',
  'html_artifact_storage_unsafe', 'html_artifact_storage_corrupt', 'html_artifact_storage_busy',
  'html_artifact_storage_failed', 'html_artifact_quota']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// JSON array framing is unambiguous even when native IDs contain punctuation.
const artifactId = ({ sessionId, messageId, toolCallId }) => sha256(JSON.stringify([
  'pi-gui:html-artifact:v1', sessionId, messageId, toolCallId,
]));
const encode = value => Buffer.from(JSON.stringify(value) + '\n', 'utf8');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Backend-private immutable snapshots. The caller alone proves native session /
 * branch ownership. This store never reads sessions and exposes no HTTP delete.
 *
 * Publish/read use bounded synchronous IO. Collection additionally holds the
 * exclusive wx lock across its awaited reference scan AND synchronous commit,
 * excluding other store calls and backend processes. Native reference writers
 * require separate caller admission. An abandoned lock is NEVER stolen: stop all writers,
 * back up the store and explicitly recover the lock before using it again.
 * Node path checks are not an OS sandbox against a same-user malicious process,
 * nor does file fsync promise power-loss durability of directory metadata. */
export function createHtmlArtifactStore({ dataDir, limits = {}, io = fs, checkpoint = () => {} } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || !record(limits)
    || Object.keys(limits).some(key => !Object.hasOwn(HTML_ARTIFACT_STORE_LIMITS, key))) fail('html_artifact_invalid');
  const quota = { ...HTML_ARTIFACT_STORE_LIMITS, ...limits };
  if (Object.values(quota).some(value => !Number.isSafeInteger(value) || value < 1)) fail('html_artifact_invalid');
  const data = path.resolve(dataDir), root = path.join(data, 'html-artifacts');
  const remembered = new Map();

  function statMaybe(file) {
    try { return io.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function directory(dir, remember = false) {
    const stat = statMaybe(dir);
    if (!stat) fail('html_artifact_storage_unsafe');
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || identity(io.lstatSync(canonicalPath(dir))) !== identity(stat)) fail('html_artifact_storage_unsafe');
    if (remembered.has(dir) && remembered.get(dir) !== identity(stat)) fail('html_artifact_storage_unsafe');
    if (remember) remembered.set(dir, identity(stat));
    return stat;
  }
  function guard(create = false) {
    // Inspect every ancestor even when the requested ID/file does not exist.
    const ancestors = [];
    for (let dir = data; ; dir = path.dirname(dir)) {
      ancestors.unshift(dir); if (path.dirname(dir) === dir) break;
    }
    for (const dir of ancestors) directory(dir, true);
    let stat = statMaybe(root);
    if (!stat && remembered.has(root)) fail('html_artifact_storage_unsafe');
    if (!stat && create) {
      try { io.mkdirSync(root, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = io.lstatSync(root);
    }
    if (!stat) return false;
    const actual = directory(root, true);
    if (process.platform !== 'win32' && (actual.mode & 0o077)) fail('html_artifact_storage_unsafe');
    return true;
  }
  function plain(file, max) {
    const stat = io.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || identity(io.lstatSync(canonicalPath(file))) !== identity(stat)) fail('html_artifact_storage_unsafe');
    if (stat.size > max) fail('html_artifact_storage_corrupt');
    return stat;
  }
  function readBytes(dir, name, max) {
    const file = path.join(dir, name), before = plain(file, max);
    const fd = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const opened = io.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || identity(opened) !== identity(before)) fail('html_artifact_storage_unsafe');
      const buffer = Buffer.alloc(Math.min(max, before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = io.readSync(fd, buffer, length, buffer.length - length, length);
        if (!n) break;
        length += n;
      }
      const after = io.fstatSync(fd);
      if (identity(after) !== identity(before) || !after.isFile() || after.nlink !== 1) fail('html_artifact_storage_unsafe');
      if (length !== before.size || after.size !== length || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs) fail('html_artifact_storage_corrupt');
      bytes = buffer.subarray(0, length);
    } finally { io.closeSync(fd); }
    guard(); directory(dir);
    const after = plain(file, max);
    if (identity(after) !== identity(before)) fail('html_artifact_storage_unsafe');
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) fail('html_artifact_storage_corrupt');
    return { bytes, stat: after };
  }
  function utf8(bytes) {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('html_artifact_storage_corrupt');
    return text;
  }
  function disk(id) {
    guard();
    const dir = path.join(root, id), stat = statMaybe(dir);
    if (!stat) fail('html_artifact_not_found');
    directory(dir, true);
    const names = io.readdirSync(dir);
    if (!names.includes('document.html') || !names.includes('reference.json')
      || names.some(name => !FILES.includes(name))) fail('html_artifact_storage_corrupt');
    const meta = readBytes(dir, 'reference.json', META_BYTES);
    let value;
    try { value = JSON.parse(utf8(meta.bytes)); } catch { fail('html_artifact_storage_corrupt'); }
    const artifact = projectHtmlArtifactReference(value);
    if (!artifact || !encode(artifact).equals(meta.bytes) || artifact.id !== id
      || artifactId(artifact) !== id || /[\x80-\x9f]/.test(artifact.title)) fail('html_artifact_storage_corrupt');
    const snapshot = readBytes(dir, 'document.html', HTML_ARTIFACT_MAX_BYTES);
    const html = utf8(snapshot.bytes);
    if (snapshot.bytes.length !== artifact.bytes || sha256(snapshot.bytes) !== artifact.digest) fail('html_artifact_storage_corrupt');
    let pending = false, pendingBytes = 0;
    if (names.includes('.pending')) {
      const marker = readBytes(dir, '.pending', 2);
      if (!marker.bytes.equals(Buffer.from('1\n'))) fail('html_artifact_storage_corrupt');
      pending = true; pendingBytes = marker.bytes.length;
    }
    const after = directory(dir);
    if (identity(after) !== identity(stat)) fail('html_artifact_storage_unsafe');
    return { artifact, html, pending, dir, identity: identity(stat),
      storedBytes: meta.bytes.length + snapshot.bytes.length + pendingBytes,
      modifiedMs: Math.max(Date.parse(artifact.createdAt), after.mtimeMs, after.ctimeMs,
        snapshot.stat.mtimeMs, snapshot.stat.ctimeMs, meta.stat.mtimeMs, meta.stat.ctimeMs) };
  }
  function names() {
    guard();
    const entries = io.readdirSync(root);
    // No second list of session IDs and no global session-count admission cap.
    if (entries.some(name => name !== '.writer.lock' && !isHtmlArtifactId(name) && !TEMP.test(name))) fail('html_artifact_storage_unsafe');
    if (entries.length > quota.totalCount + 1024) fail('html_artifact_quota');
    return entries;
  }
  function ownedUnlink(file, expected) {
    const stat = plain(file, Math.max(HTML_ARTIFACT_MAX_BYTES, META_BYTES));
    if (identity(stat) !== expected) fail('html_artifact_storage_unsafe');
    io.unlinkSync(file);
  }
  function acquireLock(create) {
    let fd, expected;
    const file = path.join(root, '.writer.lock');
    const release = () => {
      if (fd !== undefined) { try { io.closeSync(fd); } catch { /* Identity checks below still refuse a foreign lock. */ } }
      if (expected) {
        try { guard(); ownedUnlink(file, expected); }
        catch { /* Never unlink through a replaced directory or remove another lock. */ }
      }
    };
    try {
      if (!guard(create)) return { exists: false, release };
      try { fd = io.openSync(file, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('html_artifact_storage_busy'); throw error; }
      expected = identity(io.fstatSync(fd));
      const assertLock = () => {
        guard();
        if (identity(plain(file, 4096)) !== expected) fail('html_artifact_storage_unsafe');
      };
      assertLock();
      return { exists: true, assertLock, release };
    } catch (error) { release(); throw error; }
  }
  function lock(create, action) {
    const held = acquireLock(create);
    try { return action(held.exists, held.assertLock); }
    finally { held.release(); }
  }
  function safe(action) {
    try { return action(); }
    catch (error) { fail(CODES.has(error?.code) ? error.code : 'html_artifact_storage_failed'); }
  }
  function inputSnapshot(input) {
    if (!record(input) || Object.keys(input).some(key => !INPUT_KEYS.includes(key))
      || typeof input.html !== 'string') fail('html_artifact_invalid');
    const html = input.html, bytes = Buffer.from(html, 'utf8');
    if (!bytes.length || bytes.length > HTML_ARTIFACT_MAX_BYTES || bytes.toString('utf8') !== html) fail('html_artifact_invalid');
    const placeholder = '0'.repeat(64);
    const artifact = projectHtmlArtifactReference({
      schemaVersion: HTML_ARTIFACT_VERSION, kind: 'html', id: placeholder, contentRef: placeholder,
      sessionId: input.sessionId, messageId: input.messageId, toolCallId: input.toolCallId,
      title: input.title, height: normalizeHtmlArtifactHeight(input.height),
      bytes: bytes.length, digest: sha256(bytes), createdAt: new Date().toISOString(),
    });
    if (!artifact || /[\x80-\x9f]/.test(artifact.title)) fail('html_artifact_invalid');
    artifact.id = artifactId(artifact); artifact.contentRef = artifact.id;
    return { artifact, bytes };
  }
  function checkQuota(artifact, incomingBytes, incomingCount = 1) {
    let totalBytes = 0, totalCount = 0, sessionBytes = 0, sessionCount = 0;
    for (const name of names()) {
      if (name === '.writer.lock') continue;
      // Interrupted snapshots cannot be ignored to admit more disk usage.
      if (TEMP.test(name)) fail('html_artifact_storage_busy');
      const item = disk(name);
      totalBytes += item.storedBytes; totalCount++;
      if (item.artifact.sessionId === artifact.sessionId) { sessionBytes += item.storedBytes; sessionCount++; }
    }
    if (totalBytes + incomingBytes > quota.totalBytes || sessionBytes + incomingBytes > quota.sessionBytes
      || totalCount + incomingCount > quota.totalCount || sessionCount + incomingCount > quota.sessionCount) fail('html_artifact_quota');
  }
  // Removal uses a checked, fixed inventory, never recursive rm on a caller path.
  function removeDirectory(dir, expected, assertLock) {
    assertLock();
    if (identity(directory(dir)) !== expected) fail('html_artifact_storage_unsafe');
    const entries = io.readdirSync(dir);
    if (entries.some(name => !FILES.includes(name))) fail('html_artifact_storage_unsafe');
    const inventory = entries.map(name => ({ name, identity: identity(plain(path.join(dir, name), Math.max(META_BYTES, HTML_ARTIFACT_MAX_BYTES))) }));
    for (const entry of inventory) {
      assertLock();
      if (identity(directory(dir)) !== expected) fail('html_artifact_storage_unsafe');
      ownedUnlink(path.join(dir, entry.name), entry.identity);
    }
    assertLock();
    if (identity(directory(dir)) !== expected) fail('html_artifact_storage_unsafe');
    io.rmdirSync(dir); remembered.delete(dir);
  }
  async function publish(input) {
    return safe(() => {
      const { artifact, bytes } = inputSnapshot(input), meta = encode(artifact);
      return lock(true, (_exists, assertLock) => {
        const target = path.join(root, artifact.id);
        if (statMaybe(target)) {
          const item = disk(artifact.id), current = item.artifact;
          if (current.digest !== artifact.digest || current.bytes !== artifact.bytes
            || current.title !== artifact.title || current.height !== artifact.height) fail('html_artifact_conflict');
          // A retry is a new publication intent even when the immutable tuple is
          // unchanged. Protect the native append/ack gap again, including after
          // restart, without rewriting HTML, reference bytes or stable IDs.
          if (!item.pending) {
            checkQuota(current, 2, 0); assertLock();
            const marker = path.join(target, '.pending');
            const fd = io.openSync(marker, 'wx', 0o600);
            try {
              io.writeFileSync(fd, Buffer.from('1\n')); checkpoint('republish-pending-written');
              io.fsyncSync(fd); checkpoint('republish-pending-flushed');
            } finally { io.closeSync(fd); }
            assertLock();
            if (!readBytes(target, '.pending', 2).bytes.equals(Buffer.from('1\n'))) fail('html_artifact_storage_corrupt');
          } else {
            // A previous duplicate may have written a valid marker but lost
            // fsync/ack. Do not acknowledge the retry without flushing it.
            const marker = path.join(target, '.pending'), before = plain(marker, 2);
            const fd = io.openSync(marker, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
            try {
              if (identity(io.fstatSync(fd)) !== identity(before)) fail('html_artifact_storage_unsafe');
              io.fsyncSync(fd);
            } finally { io.closeSync(fd); }
            assertLock();
            const after = readBytes(target, '.pending', 2);
            if (identity(after.stat) !== identity(before)) fail('html_artifact_storage_unsafe');
            if (!after.bytes.equals(Buffer.from('1\n'))) fail('html_artifact_storage_corrupt');
          }
          return current;
        }
        if (remembered.has(target)) fail('html_artifact_storage_unsafe');
        checkQuota(artifact, bytes.length + meta.length + 2);
        const temp = path.join(root, '.tmp-' + randomUUID());
        io.mkdirSync(temp, { mode: 0o700 });
        const expected = identity(directory(temp, true));
        let committed = false;
        try {
          checkpoint('temp-created');
          for (const [name, content, stage] of [['document.html', bytes, 'html'], ['reference.json', meta, 'meta'], ['.pending', Buffer.from('1\n'), 'pending']]) {
            assertLock(); directory(temp);
            const fd = io.openSync(path.join(temp, name), 'wx', 0o600);
            try {
              io.writeFileSync(fd, content); checkpoint(stage + '-written');
              io.fsyncSync(fd); checkpoint(stage + '-flushed');
            } finally { io.closeSync(fd); }
          }
          checkpoint('before-rename'); assertLock();
          // Re-read flushed bytes; fault injection / replacement cannot forge success.
          for (const [name, content] of [['document.html', bytes], ['reference.json', meta], ['.pending', Buffer.from('1\n')]]) {
            if (!readBytes(temp, name, Math.max(META_BYTES, content.length)).bytes.equals(content)) fail('html_artifact_storage_corrupt');
          }
          assertLock(); directory(temp);
          if (statMaybe(target)) fail('html_artifact_conflict');
          io.renameSync(temp, target); committed = true; remembered.delete(temp);
          // A lost acknowledgement may leave a full committed snapshot. Pending
          // persists across restart until a complete scan proves a native ref.
          checkpoint('renamed'); assertLock();
          return disk(artifact.id).artifact;
        } finally {
          if (!committed) {
            try { removeDirectory(temp, expected, assertLock); }
            catch { /* Uncertain temporary files remain for explicit cleanup. */ }
          }
        }
      });
    });
  }
  async function read(id) {
    return safe(() => {
      if (!isHtmlArtifactId(id)) fail('html_artifact_invalid');
      return lock(false, exists => {
        if (!exists) fail('html_artifact_not_found');
        const { artifact, html } = disk(id);
        return { artifact, html };
      });
    });
  }
  function idSet(value) {
    if (!Array.isArray(value) && !(value instanceof Set)) fail('html_artifact_invalid');
    const ids = new Set(value);
    if ([...ids].some(id => !isHtmlArtifactId(id))) fail('html_artifact_invalid');
    return ids;
  }
  function collectProof({ referencedIds, candidateIds, complete, beforeMs } = {}, assertLock) {
    // Incomplete native ownership/branch evidence never grants deletion or
    // even clears pending. A cutoff is an age policy, NOT a concurrency fence.
    if (complete !== true) return { removed: 0, retained: 0, complete: false, skipped: true };
    if (!Number.isSafeInteger(beforeMs) || beforeMs < 0 || beforeMs > Date.now()) fail('html_artifact_invalid');
    const referenced = idSet(referencedIds), candidates = candidateIds === undefined ? null : idSet(candidateIds);
    const result = { removed: 0, retained: 0, pending: 0, temporary: 0, complete: true };
    // Validate the entire inventory BEFORE any destructive operation.
    const entries = names(), items = entries.filter(isHtmlArtifactId).map(disk);
    result.temporary = entries.filter(name => TEMP.test(name)).length;
    for (const item of items) {
      const id = item.artifact.id;
      if (referenced.has(id)) {
        if (item.pending) {
          assertLock();
          const marker = path.join(item.dir, '.pending');
          ownedUnlink(marker, identity(plain(marker, 2)));
        }
        result.retained++; continue;
      }
      if (item.pending || (candidates && !candidates.has(id)) || item.modifiedMs >= beforeMs) {
        result.retained++; if (item.pending) result.pending++;
        continue;
      }
      // Atomically unpublish first. Interrupted GC leaves a TEMP inventory
      // that cleanupTemporary can finish, never a half-readable artifact ID.
      assertLock();
      if (identity(directory(item.dir)) !== item.identity) fail('html_artifact_storage_unsafe');
      const temp = path.join(root, '.tmp-' + randomUUID());
      io.renameSync(item.dir, temp); remembered.delete(item.dir);
      removeDirectory(temp, item.identity, assertLock); result.removed++;
    }
    return result;
  }
  /** Backend-private scan capability. The callback must obtain fresh, complete
   * all-branch native evidence INSIDE this call; cached/pre-scanned sets are not
   * valid. The caller must also exclude native reference mutations (including
   * branch copies that do not republish) until collect settles. This file lock
   * serializes stores/processes, not Pi/native session writers. If that external
   * admission cannot be proved, return complete:false. Never call a store API
   * from scan: reentry fails busy rather than waiting on its own lock. */
  async function collect({ scan, complete } = {}) {
    let held;
    try {
      if (typeof scan !== 'function') {
        if (complete === true) fail('html_artifact_invalid'); // Reject the unsafe pre-scan API.
        return { removed: 0, retained: 0, complete: false, skipped: true };
      }
      // Even an empty store needs a real lock before scan starts: another
      // process must not publish between an absent-root check and this commit.
      held = acquireLock(true);
      checkpoint('scan-locked');
      const proof = await scan();
      held.assertLock();
      checkpoint('scan-complete');
      held.assertLock();
      return collectProof(proof, held.assertLock);
    } catch (error) { fail(CODES.has(error?.code) ? error.code : 'html_artifact_storage_failed'); }
    finally { held?.release(); }
  }
  async function cleanupTemporary() {
    return safe(() => lock(false, (exists, assertLock) => {
      const result = { removed: 0, retained: 0 };
      if (!exists) return result;
      for (const name of names().filter(entry => TEMP.test(entry))) {
        const dir = path.join(root, name);
        try { removeDirectory(dir, identity(directory(dir)), assertLock); result.removed++; }
        catch { result.retained++; }
      }
      return result;
    }));
  }
  return { publish, read, collect, cleanupTemporary };
}
