import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import processIdentity from '../lib/process-identity.cjs';

const busy = () => { throw Object.assign(Error('html_artifact_storage_busy'), { code: 'html_artifact_storage_busy' }); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
let self = null;

function validIdentity(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const parts = JSON.parse(value);
    if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== process.platform
      || JSON.stringify(parts) !== value) return false;
    if (parts[0] === 'win32') return typeof parts[1] === 'string' && /^\d{10,20}$/.test(parts[1])
      && typeof parts[2] === 'string' && path.win32.isAbsolute(parts[2])
      && processIdentity.normalizeImagePath(parts[2]) === parts[2];
    if (parts[0] === 'linux') return typeof parts[1] === 'string'
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(parts[1])
      && typeof parts[2] === 'string' && /^\d+$/.test(parts[2]);
  } catch { /* Unrecognized/torn/foreign identities never authorize recovery. */ }
  return false;
}

function windowsIdentity(value) {
  if (value.state !== 'found') return { state: value.state === 'gone' ? 'gone' : 'unknown' };
  const identity = JSON.stringify(['win32', value.creationTimeUtc, processIdentity.normalizeImagePath(value.imagePath)]);
  return validIdentity(identity) ? { state: 'found', identity } : { state: 'unknown' };
}

// Never infer identity from PID existence, wall-clock age, or a caller's string.
// Windows reuses the reviewed creation-time/image probe. Linux adds boot ID and
// /proc start ticks; unsupported/denied probes remain unknown (including ESRCH
// from a failed query, unless the OS explicitly reported a missing process).
export function queryHtmlArtifactProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  if (process.platform === 'win32') {
    try {
      return windowsIdentity(processIdentity.queryProcessIdentitySync(pid));
    } catch { return { state: 'unknown' }; }
  }
  if (process.platform === 'linux') {
    let stat;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) { return { state: error.code === 'ENOENT' ? 'gone' : 'unknown' }; }
    try {
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const identity = JSON.stringify(['linux', boot, fields[19]]);
      return validIdentity(identity) ? { state: 'found', identity } : { state: 'unknown' };
    } catch { return { state: 'unknown' }; } // Missing boot evidence is NOT a missing process.
  }
  return { state: 'unknown' };
}

export async function htmlArtifactLockOwner(query = queryHtmlArtifactProcess) {
  if (!self || query !== queryHtmlArtifactProcess) {
    let value;
    try {
      // A live process cannot reuse its OWN PID while awaiting this read. Use
      // the existing bounded async query, not the 2.5 s synchronous quit probe:
      // cold PowerShell startup must not block RPC/HTTP or need a quit budget.
      value = query === queryHtmlArtifactProcess && process.platform === 'win32'
        ? windowsIdentity(await processIdentity.queryProcessIdentity(process.pid))
        : await query(process.pid);
    } catch { busy(); }
    if (value?.state !== 'found' || !validIdentity(value.identity)) busy();
    const owner = { version: 2, pid: process.pid, processIdentity: value.identity, nonce: randomUUID() };
    if (query !== queryHtmlArtifactProcess) return owner;
    self = owner;
  }
  return { ...self, nonce: randomUUID() };
}

export function htmlArtifactOwnerDead(owner, query = queryHtmlArtifactProcess) {
  if (!record(owner) || Object.keys(owner).sort().join(',') !== 'nonce,pid,processIdentity,version'
    || owner.version !== 2 || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || !validIdentity(owner.processIdentity)
    || typeof owner.nonce !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner.nonce)) return false;
  try {
    const current = query(owner.pid);
    return current?.state === 'gone' || current?.state === 'found'
      && validIdentity(current.identity) && current.identity !== owner.processIdentity;
  } catch { return false; }
}

// One kernel-owned gate for EVERY writer/read/collector/recoverer, not merely
// recovery contenders. Crash releases the kernel object, not a PID/age guess.
// Windows named pipes and Linux abstract sockets leave no stale filesystem
// socket to unlink. No HTTP, network proxy, or client commands are exposed.
// Other platforms fail closed rather than inventing a stale-socket protocol.
export async function acquireHtmlArtifactGate(root) {
  // Bind the kernel name to the physical directory, not its spelling. Case,
  // short-path aliases or a renamed root must not create independent recoverers.
  let key;
  try {
    const stat = fs.lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) busy();
    key = createHash('sha256').update(JSON.stringify([process.platform,
      stat.dev.toString(), stat.ino.toString(), stat.birthtimeNs.toString()])).digest('hex');
  } catch { busy(); }
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\pi-gui-html-${key}`
    : process.platform === 'linux' ? `\0pi-gui-html-${key}` : null;
  if (!endpoint) busy();
  const server = net.createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: endpoint, exclusive: true }, resolve);
    });
  } catch { server.close(); busy(); }
  server.unref();
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await new Promise(resolve => server.close(resolve));
  };
}
