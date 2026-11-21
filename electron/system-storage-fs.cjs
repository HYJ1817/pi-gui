'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { inspectWindowsPaths } = require('./system-storage-windows.cjs');

const WIN = process.platform === 'win32';
const CASE_FOLD = WIN || process.platform === 'darwin';
const MAX_PATH = 4096;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const componentOK = name => name && name !== '.' && name !== '..' && Buffer.byteLength(name) <= 255
  && !/[<>:"/\\|?*\x00-\x1f\x7f�]/u.test(name) && !/[ .]$/u.test(name)
  && !/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?:\.|$)/iu.test(name);
const digest = data => createHash('sha256').update(data).digest('hex');
const hashRows = rows => digest(JSON.stringify(rows));
const compareKey = value => CASE_FOLD ? value.normalize('NFC').toLowerCase() : value;
const samePath = (left, right) => compareKey(left) === compareKey(right);

class StorageFault extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new StorageFault(code); };
function failureCode(error, fallback = 'storage_io_failed') {
  if (error instanceof StorageFault) return error.code;
  switch (error?.code) {
    case 'EACCES': case 'EPERM': case 'EROFS': return 'permission_denied';
    case 'ENOSPC': case 'EDQUOT': return 'insufficient_space';
    case 'ELOOP': return 'unsafe_entry';
    default: return fallback;
  }
}

function absolute(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH || !path.isAbsolute(value)
      || (WIN ? !/^[A-Za-z]:[\\/]/u.test(value) : value.startsWith('//'))) fail('invalid_path');
  const tail = value.slice(path.parse(value).root.length);
  const parts = tail.split(WIN ? /[\\/]/u : '/').filter(Boolean);
  if (parts.length > 64 || !parts.every(componentOK)) fail('invalid_path');
  return path.resolve(value);
}

function overlaps(left, right) {
  const inside = (root, target) => {
    const normalized = compareKey(root);
    return compareKey(target).startsWith(normalized.endsWith(path.sep) ? normalized : normalized + path.sep);
  };
  return samePath(left, right) || inside(left, right) || inside(right, left);
}

function identity(stat) {
  if (!stat || typeof stat.ino !== 'bigint' || stat.ino === 0n) fail('identity_unavailable');
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
function fileStamp(stat) {
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('unsafe_entry');
  return `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function dirIdentity(stat) {
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_entry');
  return identity(stat);
}

function createStorageFs({ io: overrides, inspectWindows = inspectWindowsPaths } = {}) {
  const io = { ...fs, ...overrides };
  async function lstat(file) {
    try { return await io.lstat(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function directory(directoryPath, missingCode = 'directory_missing') {
    const paths = [];
    for (let current = directoryPath; ; current = path.dirname(current)) {
      paths.unshift(current);
      if (path.dirname(current) === current) break;
    }
    const ids = [];
    for (const current of paths) {
      const stat = await lstat(current);
      if (!stat) fail(missingCode);
      ids.push(dirIdentity(stat));
    }
    if (!samePath(await io.realpath(directoryPath), directoryPath)) fail('unsafe_entry');
    if (dirIdentity(await lstat(directoryPath)) !== ids.at(-1)) fail('path_changed');
    return { path: directoryPath, binding: hashRows(ids), ids };
  }

  async function guard(reference) {
    const current = await directory(reference.path, 'path_changed');
    if (current.binding !== reference.binding) fail('path_changed');
    return current;
  }

  // Only these paths are read/written; on Windows the additional fixed helper
  // queries attributes/streams Node does not expose, without reading payloads.
  async function native(entries) {
    if (!WIN) return;
    const result = await inspectWindows(entries);
    if (result !== 'ok') fail(result === 'unsafe' ? 'unsafe_entry' : result === 'permission'
      ? 'permission_denied' : 'native_check_unavailable');
  }

  async function plain(file) {
    const stat = await lstat(file);
    return stat ? { stamp: fileStamp(stat), size: stat.size } : null;
  }
  async function readBound(file, expected, guardParent, consume) {
    await guardParent();
    if ((await plain(file))?.stamp !== expected.stamp) fail('inventory_changed');
    const handle = await io.open(file, READ_FLAGS);
    let result;
    try {
      if (fileStamp(await handle.stat({ bigint: true })) !== expected.stamp) fail('inventory_changed');
      result = await consume(handle, Number(expected.size));
      if (fileStamp(await handle.stat({ bigint: true })) !== expected.stamp) fail('inventory_changed');
      await guardParent();
      if ((await plain(file))?.stamp !== expected.stamp) fail('inventory_changed');
    } finally { await handle.close(); }
    return result;
  }

  async function readSmall(file, entry, guardParent, max, limitCode) {
    if (entry.size > BigInt(max)) fail(limitCode);
    return readBound(file, entry, guardParent, async (handle, size) => {
      const bytes = Buffer.alloc(size);
      for (let offset = 0; offset < size;) {
        const result = await handle.read(bytes, offset, size - offset, offset);
        if (!result.bytesRead) fail('inventory_changed');
        offset += result.bytesRead;
      }
      return bytes;
    });
  }

  async function empty(reference) {
    await guard(reference);
    const cursor = await io.opendir(reference.path);
    try { if (await cursor.read()) fail('target_not_empty'); }
    finally { await cursor.close(); }
    await guard(reference);
  }

  async function freeSpace(target, inventory) {
    await guard(target);
    await io.access(target.path, constants.R_OK | constants.W_OK | constants.X_OK);
    // Windows statfs reports the caller's volume quota via bavail; never
    // infer capacity from the source drive or assume an unsupported query is OK.
    let stat;
    try { stat = await io.statfs(target.path, { bigint: true }); }
    catch (error) { fail(failureCode(error, 'space_unavailable')); }
    const unit = stat?.frsize || stat?.bsize;
    if (typeof unit !== 'bigint' || unit <= 0n || typeof stat.bavail !== 'bigint' || stat.bavail < 0n) fail('space_unavailable');
    const available = unit * stat.bavail;
    const required = BigInt(inventory.bytes) + BigInt(inventory.entries.length + 1) * unit + 1024n * 1024n;
    if (available < required) fail('insufficient_space');
    await guard(target);
  }

  async function syncDirectory(reference) {
    // Node cannot fsync a Windows directory. Regular files are flushed on both
    // platforms; atomic rename isn't a power-loss durability guarantee there.
    if (WIN) return;
    await guard(reference);
    const handle = await io.open(reference.path, READ_FLAGS | (constants.O_DIRECTORY || 0));
    try {
      const observed = await guard(reference);
      if (dirIdentity(await handle.stat({ bigint: true })) !== observed.ids.at(-1)) fail('path_changed');
      await handle.sync();
    } finally { await handle.close(); }
  }
  return { io, lstat, directory, guard, native, plain, readBound, readSmall, empty, freeSpace, syncDirectory };
}

function parseJson(bytes, code) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(code); }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const hexDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);

module.exports = { StorageFault, fail, failureCode, absolute, componentOK, samePath, overlaps, identity,
  dirIdentity, fileStamp, hashRows, digest, createStorageFs, parseJson, object, exact, hexDigest, uuid, MAX_PATH };
