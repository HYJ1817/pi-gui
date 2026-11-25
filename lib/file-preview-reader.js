/* Bounded reads of an already-authorized file, not a new authorization source.
 * The owner supplies assertAccess(), resolving its original scope/grant again.
 * Only checked chunks leave this module; handles/listeners/timers are per read. */
import fs from 'node:fs';
import path from 'node:path';
import { isAbsoluteAny, isInside, normalizeForCompare, realPathOrNull } from './safe-path.js';
import { sameFileIdentity } from './file-identity.js';

const fail = (code) => Object.assign(new Error(code), { code });
const samePath = (a, b) => normalizeForCompare(a) === normalizeForCompare(b);
export const PREVIEW_CHUNK_BYTES = 64 * 1024;

export function assertPreviewRelative(requested) {
  if (typeof requested !== 'string' || !requested || requested !== requested.trim()
    || isAbsoluteAny(requested) || /[\u0000-\u001f\u007f:<>"|?*]/.test(requested)) throw fail('unsafe_path');
  const parts = requested.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw fail('unsafe_path');
}

/** Check every lexical component too: realpath alone would hide a link pointing
 * back inside the allowed tree. Call again around each read, not only at open. */
export function assertPreviewPath(root, target) {
  if (!isInside(root, target)) throw fail('unsafe_path');
  const rootReal = realPathOrNull(root);
  if (!rootReal || !samePath(rootReal, root)) throw fail('unsafe_path');
  let current = root;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail('unsafe_path');
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw fail('unsafe_path');
  }
  const real = realPathOrNull(target);
  if (!real || !samePath(real, target) || !isInside(root, real)) throw fail('unsafe_path');
  return real;
}

export async function openPreviewReader({ abs, stat, assertPath, assertAccess }) {
  let handle;
  const checkObject = () => {
    assertPath();
    const current = fs.lstatSync(abs);
    const opened = fs.fstatSync(handle.fd);
    if (current.isSymbolicLink() || !current.isFile() || !opened.isFile()
      || !sameFileIdentity(stat, current) || !sameFileIdentity(stat, opened)) throw fail('file_changed');
  };
  const verify = async () => {
    // Let the authoritative grant ledger observe/evict replaced directories,
    // even when the file-object check would independently refuse this chunk.
    await assertAccess();
    checkObject();
  };
  try {
    assertPath();
    // NONBLOCK prevents a path swapped to a FIFO from hanging the server on POSIX.
    handle = await fs.promises.open(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    await verify();
    return {
      verify,
      async read(position, length) {
        if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0
          || length < 0 || length > PREVIEW_CHUNK_BYTES || position + length > stat.size) throw fail('invalid_request');
        await verify();
        const buffer = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
          const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
          if (!bytesRead) throw fail('file_changed');
          offset += bytesRead;
          await verify();
        }
        return buffer;
      },
      close: () => handle.close(),
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {}); // failed opens own this handle only
    throw error;
  }
}

function waitForDrain(res) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', done); res.off('close', closed); res.off('error', closed); };
    const done = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(fail('request_aborted')); };
    res.once('drain', done); res.once('close', closed); res.once('error', closed);
    if (res.destroyed) closed();
  });
}

export async function sendPreviewContent(req, res, reader, { start, length, headers, status }) {
  let stopped = false;
  let monitoring = false;
  let monitorTask = Promise.resolve();
  const abort = () => { stopped = true; };
  req.once('aborted', abort);
  res.once('close', abort);
  // A slow receiver may never emit drain. Revoke/scope/object checks must still
  // stop the response while blocked, rather than waiting for another read.
  const monitor = setInterval(() => {
    if (monitoring || stopped) return;
    monitoring = true;
    monitorTask = reader.verify()
      .catch(() => { if (!stopped) { stopped = true; res.destroy(); } })
      .finally(() => { monitoring = false; });
  }, 50);
  monitor.unref?.();
  try {
    let offset = 0;
    while (offset < length) {
      if (stopped || res.destroyed) throw fail('request_aborted');
      const chunk = await reader.read(start + offset, Math.min(PREVIEW_CHUNK_BYTES, length - offset));
      if (stopped || res.destroyed) throw fail('request_aborted');
      if (!res.headersSent) res.writeHead(status, headers);
      if (!res.write(chunk)) await waitForDrain(res);
      offset += chunk.length;
    }
    await reader.verify();
    if (stopped || res.destroyed) throw fail('request_aborted');
    if (!res.headersSent) res.writeHead(status, headers);
    res.end();
  } finally {
    stopped = true;
    clearInterval(monitor);
    await monitorTask; // do not close the descriptor under an in-flight monitor
    req.off('aborted', abort);
    res.off('close', abort);
  }
}
