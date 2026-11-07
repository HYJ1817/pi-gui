import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isModelId, isOpaqueId, isProviderId, validateModelValues } from '../public/provider-management/contract.js';

const LIMIT = 16 * 1024 * 1024;
const RECEIPT_LIMIT = 128;
const keys = ['models', 'metadata'];
const fileNames = new Set(['journal.json', 'journal.pending', 'models.install', 'models.before', 'models.after', 'metadata.before', 'metadata.after']);
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = s => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
const stamp = s => `${identity(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}`;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytes = v => Buffer.from(JSON.stringify(v, null, 2) + '\n');
const fail = code => { throw Object.assign(Error(code), { code }); };
const knownCodes = new Set(['config_conflict','request_id_conflict','config_invalid','config_unreadable',
  'config_unsupported','config_unsafe','config_busy','config_recovery_required','config_write_failed']);
const defaultMetadata = () => ({ schemaVersion: 1, services: {}, receipts: {} });

// Windows' mode argument does not set a DACL. Protect the empty journal
// directory before creating files, and the empty install file before writing.
// Ownership: an elevated process creates objects owned by the local
// Administrators group (S-1-5-32-544), not the user SID — staged files are
// therefore accepted under either owner, while the single full-control DACL
// rule for the current user keeps them private to this account either way.
const PRIVATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($item in @($request.targets)) {
  $info = if ($item.directory) { [IO.DirectoryInfo]::new($item.path) } else { [IO.FileInfo]::new($item.path) }
  if (-not $info.Exists -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
  if (-not $request.verifyOnly) {
    $acl = $info.GetAccessControl()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) }
    $inherit = if ($item.directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow'))
    $info.SetAccessControl($acl)
  }
  $check = $info.GetAccessControl()
  $rules = @($check.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $ownerSid = $check.GetOwner([Security.Principal.SecurityIdentifier])
  $owned = $ownerSid.Value -eq $sid.Value -or $ownerSid.Value -eq 'S-1-5-32-544'
  if (($item.directory -and -not $check.AreAccessRulesProtected) -or -not $owned -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow') { exit 1 }
}
`;
function windowsAcl(targets, verifyOnly = false) {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(shell, ['-NoLogo','-NoProfile','-NonInteractive','-Command',PRIVATE_ACL], {
    input: JSON.stringify({ targets, verifyOnly }), windowsHide: true, stdio: ['pipe','ignore','ignore'], timeout: 10000,
  });
  if (result.status !== 0) fail('config_unsafe');
}

function safeReceipt(value) {
  const id = v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v);
  if (!record(value) || value.ok !== true || !id(value.serviceId) || value.saved !== true || value.credentialSaved !== null ||
      value.credentialState !== 'none' || value.operationId !== null || value.sync?.state !== 'pending' ||
      value.sync?.reason !== 'runtime_sync_pending' || !/^[a-f0-9]{64}$/.test(value.revision)) fail('config_invalid');
  return { ok: true, serviceId: value.serviceId, saved: true, credentialSaved: null, credentialState: 'none', operationId: null,
    sync: { state: 'pending', reason: 'runtime_sync_pending' }, revision: value.revision };
}

function validateMetadata(value) {
  if (!record(value) || !record(value.services) || !record(value.receipts)) fail('config_invalid');
  if (value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion','services','receipts','syncRequired'].includes(key))) fail('config_unsupported');
  if (Object.hasOwn(value, 'syncRequired') && typeof value.syncRequired !== 'boolean') fail('config_invalid');
  for (const [id, service] of Object.entries(value.services)) {
    if (!isProviderId(id) || !record(service) || Object.keys(service).some(key => !['providerId','catalogId','displayName','enabled','selectedModelIds','modelOrder','kind','ownedOverrides'].includes(key))) fail('config_invalid');
    if (Object.hasOwn(service,'providerId') && service.providerId !== id) fail('config_invalid');
    if (Object.hasOwn(service,'catalogId') && !isOpaqueId(service.catalogId)) fail('config_invalid');
    if (Object.hasOwn(service,'displayName') && (typeof service.displayName !== 'string' || service.displayName.length > 200 || /[\u0000-\u001f\u007f]/u.test(service.displayName))) fail('config_invalid');
    if (Object.hasOwn(service,'enabled') && typeof service.enabled !== 'boolean') fail('config_invalid');
    if (Object.hasOwn(service,'kind') && !['custom','builtin'].includes(service.kind)) fail('config_invalid');
    for (const field of ['selectedModelIds','modelOrder']) {
      if (Object.hasOwn(service,field) && (!Array.isArray(service[field]) || service[field].length > 3000 || !service[field].every(isModelId) || new Set(service[field]).size !== service[field].length)) fail('config_invalid');
    }
    if (Object.hasOwn(service,'ownedOverrides')) {
      if (!record(service.ownedOverrides)) fail('config_invalid');
      for (const [modelId, fields] of Object.entries(service.ownedOverrides)) {
        if (!isModelId(modelId)) fail('config_invalid');
        try { validateModelValues(fields); } catch { fail('config_invalid'); }
      }
    }
  }
  const receipts = Object.entries(value.receipts);
  if (receipts.length > RECEIPT_LIMIT) fail('config_invalid');
  for (const [id, item] of receipts) {
    if (!isOpaqueId(id) || !record(item) || Object.keys(item).some(key => !['fingerprint','result'].includes(key)) || !/^[a-f0-9]{64}$/.test(item.fingerprint)) fail('config_invalid');
    const safe = safeReceipt(item.result);
    if (Object.keys(item.result).some(key => !Object.hasOwn(safe,key)) || Object.keys(item.result.sync).some(key => !Object.hasOwn(safe.sync,key))) fail('config_invalid');
  }
}

export function createProviderConfigStore({ modelsJson, metadataPath, fault = () => {}, io = fs }) {
  const files = { models: path.resolve(modelsJson), metadata: path.resolve(metadataPath) };
  const lockPath = files.models + '.pi-gui-lock';
  const txPath = files.models + '.pi-gui-transaction';
  const revisionKey = randomBytes(32);
  const pins = new Map();

  function stat(file) {
    try { return io.lstatSync(file, { bigint: true }); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  function parents(directory, create = false) {
    const chain = [];
    for (let p = directory; ; p = path.dirname(p)) { chain.unshift(p); if (p === path.dirname(p)) break; }
    for (const p of chain) {
      let s = stat(p);
      if (!s && create) {
        try { io.mkdirSync(p, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        s = stat(p);
      }
      if (!s) {
        if (pins.has(p)) fail('config_unsafe');
        return null;
      }
      if (!s.isDirectory() || s.isSymbolicLink()) fail('config_unsafe');
      const id = identity(s);
      if (pins.has(p) && pins.get(p) !== id) fail('config_unsafe');
      pins.set(p, id);
    }
    return pins.get(directory);
  }
  function plain(file) {
    const s = stat(file);
    if (s && (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n)) fail('config_unsafe');
    return s;
  }
  function snapshot(file, limit = LIMIT) {
    if (!parents(path.dirname(file))) return { data: null, digest: null, stamp: null };
    const before = plain(file);
    if (!before) return { data: null, digest: null, stamp: null };
    if (before.size > BigInt(limit)) fail('config_invalid');
    const fd = io.openSync(file, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW || 0));
    try {
      if (stamp(io.fstatSync(fd, { bigint: true })) !== stamp(before)) fail('config_conflict');
      const data = Buffer.alloc(Number(before.size));
      let read = 0;
      while (read < data.length) {
        const n = io.readSync(fd, data, read, data.length - read, read);
        if (!n) fail('config_conflict');
        read += n;
      }
      parents(path.dirname(file));
      const after = plain(file);
      if (!after || stamp(after) !== stamp(before) || stamp(io.fstatSync(fd, { bigint: true })) !== stamp(before)) fail('config_conflict');
      return { data, digest: hash(data), stamp: stamp(before), mode: before.mode };
    } finally { io.closeSync(fd); }
  }
  function parse(data) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch { return fail('config_invalid'); }
  }
  function readPair() {
    const states = Object.fromEntries(keys.map(key => [key, snapshot(files[key])]));
    const config = states.models.data === null ? {} : parse(states.models.data);
    if (!record(config) || (Object.hasOwn(config, 'providers') && !record(config.providers))) fail('config_invalid');
    const metadata = states.metadata.data === null ? defaultMetadata() : parse(states.metadata.data);
    validateMetadata(metadata);
    const revision = revisionFor(states.models.digest, metadata);
    config.providers ??= {};
    return { states, config, metadata, revision, exists: states.models.data !== null };
  }
  function revisionFor(digest, metadata) {
    const { receipts: _receipts, ...logical } = metadata;
    return createHmac('sha256', revisionKey).update(JSON.stringify([digest, logical])).digest('hex');
  }
  function syncDirectory(directory) {
    if (process.platform === 'win32') return; // Node cannot fsync Windows directory handles.
    const fd = io.openSync(directory, 'r');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  }
  function writeExclusive(file, data, privateFile = false) {
    if (data.length > LIMIT) fail('config_invalid');
    parents(path.dirname(file));
    const fd = io.openSync(file, 'wx', 0o600);
    const id = identity(io.fstatSync(fd, { bigint: true }));
    let ok = false;
    try {
      if (privateFile && process.platform === 'win32') windowsAcl([{ path: file, directory: false }]);
      parents(path.dirname(file));
      const s = plain(file);
      if (!s || identity(s) !== id) fail('config_unsafe');
      io.writeFileSync(fd, data);
      io.fsyncSync(fd);
      ok = true;
    } finally {
      io.closeSync(fd);
      if (!ok) {
        parents(path.dirname(file));
        const live = plain(file);
        if (live && identity(live) === id) io.unlinkSync(file);
      }
    }
  }
  function withLock(task) {
    parents(path.dirname(lockPath), true);
    function claim(file) {
      try { writeExclusive(file, bytes({ pid: process.pid, token: randomUUID() })); }
      catch (e) { if (e.code === 'EEXIST') return null; throw e; }
      return snapshot(file, 4096).stamp;
    }
    function remove(file, expected) {
      if (snapshot(file, 4096).stamp !== expected) fail('config_unsafe');
      io.unlinkSync(file);
    }
    function requireDead(prior) {
      let owner;
      try { owner = prior.data && parse(prior.data); } catch { fail('config_busy'); }
      if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || !/^[a-f0-9-]{36}$/.test(owner.token)) fail('config_busy');
      try { process.kill(owner.pid, 0); fail('config_busy'); }
      catch (e) { if (e.code !== 'ESRCH') fail('config_busy'); }
    }
    function reclaim(prior) {
      requireDead(prior);
      // Tickets belong to one exact dead lock. A dead reaper advances the
      // ticket index without deleting any live reaper's authority.
      const prefix = lockPath + '.recovery-' + hash(prior.stamp).slice(0, 24) + '-';
      const tickets = [];
      for (let index = 0; index < 16; index++) {
        const ticket = prefix + index;
        const current = claim(ticket);
        if (!current) {
          const old = snapshot(ticket, 4096);
          requireDead(old);
          tickets.push([ticket, old.stamp]);
          continue;
        }
        tickets.push([ticket, current]);
        try {
          fault('after-recovery-claim');
          remove(lockPath, prior.stamp);
        } finally {
          for (const [file, expected] of tickets.reverse()) if (snapshot(file, 4096).stamp === expected) remove(file, expected);
        }
        return claim(lockPath);
      }
      fail('config_busy');
    }
    let lock = claim(lockPath);
    if (!lock) {
      const prior = snapshot(lockPath, 4096);
      lock = prior.data ? reclaim(prior) : claim(lockPath);
      if (!lock) fail('config_busy');
    }
    try { return task(); } finally { remove(lockPath, lock); }
  }
  function cleanup() {
    parents(txPath);
    const names = io.readdirSync(txPath);
    if (names.some(name => !fileNames.has(name))) fail('config_unsafe');
    // Remove the publication marker first, after both live files are verified.
    for (const name of ['journal.json', ...names.filter(n => n !== 'journal.json')]) {
      const file = path.join(txPath, name);
      if (plain(file)) io.unlinkSync(file);
    }
    io.rmdirSync(txPath);
    pins.delete(txPath);
    syncDirectory(path.dirname(txPath));
  }
  function install(key, data, installId, guard) {
    const target = files[key];
    const temp = key === 'models' ? path.join(txPath, 'models.install') : target + `.pi-gui-${installId}.tmp`;
    // The published journal owns this installation path across restarts.
    if (plain(temp)) io.unlinkSync(temp);
    let staged;
    try {
      // The names are private/random. Exclusive creation prevents path reuse.
      writeExclusive(temp, data, key === 'models');
      staged = snapshot(temp);
      if (staged.digest !== hash(data)) fail('config_unsafe');
      guard();
      if (snapshot(temp).stamp !== staged.stamp) fail('config_unsafe');
      io.renameSync(temp, target);
      staged = null;
      syncDirectory(path.dirname(target));
    } finally { if (staged && snapshot(temp).stamp === staged.stamp) io.unlinkSync(temp); }
  }
  function recover(checkpoints = false) {
    if (!stat(txPath)) return;
    parents(txPath);
    const names = io.readdirSync(txPath);
    if (names.some(name => !fileNames.has(name))) fail('config_unsafe');
    const targets = [{ path: txPath, directory: true }, ...names.map(name => ({ path: path.join(txPath,name), directory: false }))];
    const witnesses = targets.map(target => {
      const s = target.directory ? stat(target.path) : plain(target.path);
      if (!s || (process.platform !== 'win32' && (s.uid !== BigInt(process.getuid()) || (s.mode & 0o077n) !== 0n))) fail('config_unsafe');
      return stamp(s);
    });
    if (process.platform === 'win32') windowsAcl(targets, true);
    if (targets.some((target, index) => stamp(stat(target.path)) !== witnesses[index])) fail('config_unsafe');
    const journal = snapshot(path.join(txPath, 'journal.json'));
    if (!journal.data) { cleanup(); return; }
    try {
      const manifest = parse(journal.data);
      if (manifest.version !== 1 || !/^[a-f0-9-]{36}$/.test(manifest.installId) || manifest.files?.models !== hash(files.models) || manifest.files?.metadata !== hash(files.metadata)) fail('config_recovery_required');
      const staged = {};
      for (const key of keys) {
        const expected = manifest.entries?.[key];
        if (!record(expected) || expected.directory !== parents(path.dirname(files[key]))) fail('config_recovery_required');
        const original = snapshot(path.join(txPath, `${key}.before`));
        staged[key] = snapshot(path.join(txPath, `${key}.after`));
        if (original.digest !== expected.before || staged[key].digest !== expected.after) fail('config_recovery_required');
      }
      function current() {
        if (snapshot(path.join(txPath, 'journal.json')).stamp !== journal.stamp) fail('config_recovery_required');
        return Object.fromEntries(keys.map(key => {
          const expected = manifest.entries[key], live = snapshot(files[key]);
          if (live.digest === expected.after) return [key, 'after'];
          if (live.digest !== expected.before || live.stamp !== expected.stamp) fail('config_recovery_required');
          return [key, 'before'];
        }));
      }
      for (const key of keys) {
        if (current()[key] === 'after') continue;
        if (checkpoints) fault(`before-${key}`);
        install(key, staged[key].data, manifest.installId, () => {
          if (current()[key] !== 'before') fail('config_recovery_required');
        });
        if (checkpoints) fault(`after-${key}`);
      }
      if (keys.some(key => current()[key] !== 'after')) fail('config_recovery_required');
      cleanup();
    } catch { fail('config_recovery_required'); }
  }
  function read() {
    try {
      parents(path.dirname(files.models));
      if (stat(txPath)) fail(stat(lockPath) ? 'config_busy' : 'config_recovery_required');
      const { states, ...result } = readPair();
      for (const key of keys) if (snapshot(files[key]).stamp !== states[key].stamp) fail('config_conflict');
      if (stat(txPath)) fail('config_busy');
      return result;
    } catch (e) { if (knownCodes.has(e.code)) throw e; return fail('config_unreadable'); }
  }
  function transact({ expectedRevision, requestId, fingerprint, apply }) {
    try {
      return withLock(() => {
        recover();
        parents(path.dirname(files.metadata), true);
        const { states, ...current } = readPair();
        const receipts = current.metadata.receipts;
        if (requestId && Object.hasOwn(receipts, requestId)) {
          const receipt = receipts[requestId];
          if (receipt?.fingerprint !== fingerprint) fail('request_id_conflict');
          return safeReceipt(receipt.result);
        }
        if (expectedRevision !== undefined && expectedRevision !== current.revision) fail('config_conflict');
        const configBefore = JSON.stringify(current.config);
        const fields = apply(current);
        const models = JSON.stringify(current.config) === configBefore ? states.models.data : bytes(current.config);
        const revision = revisionFor(models === null ? null : hash(models), current.metadata);
        const result = { ...fields, revision };
        if (requestId) {
          Object.defineProperty(receipts, requestId, { value: { fingerprint, result: safeReceipt(result) }, enumerable: true, configurable: true });
          for (const id of Object.keys(receipts).slice(0, Math.max(0, Object.keys(receipts).length - RECEIPT_LIMIT))) delete receipts[id];
        }
        validateMetadata(current.metadata);
        const next = { models, metadata: bytes(current.metadata) };
        for (const key of keys) {
          if (next[key]?.length > LIMIT) fail('config_invalid');
          if (!states[key].data || states[key].digest === (next[key] === null ? null : hash(next[key]))) continue;
          if ((states[key].mode & 0o200n) === 0n) fail('config_write_failed');
          const fd = io.openSync(files[key], io.constants.O_RDWR | (io.constants.O_NOFOLLOW || 0));
          try { if (stamp(io.fstatSync(fd, { bigint: true })) !== states[key].stamp) fail('config_conflict'); }
          finally { io.closeSync(fd); }
        }
        io.mkdirSync(txPath, { mode: 0o700 });
        parents(txPath);
        if (process.platform === 'win32') windowsAcl([{ path: txPath, directory: true }]);
        let published = false;
        try {
          const entries = {};
          for (const key of keys) {
            const before = states[key];
            if (before.data) writeExclusive(path.join(txPath, `${key}.before`), before.data);
            if (next[key]) writeExclusive(path.join(txPath, `${key}.after`), next[key]);
            entries[key] = { directory: parents(path.dirname(files[key])), before: before.digest, stamp: before.stamp, after: next[key] === null ? null : hash(next[key]) };
          }
          fault('before-publish');
          for (const key of keys) if (snapshot(files[key]).stamp !== states[key].stamp) fail('config_conflict');
          const pending = path.join(txPath, 'journal.pending');
          writeExclusive(pending, bytes({ version: 1, installId: randomUUID(), files: { models: hash(files.models), metadata: hash(files.metadata) }, entries }));
          parents(txPath);
          io.renameSync(pending, path.join(txPath, 'journal.json'));
          published = true;
          syncDirectory(txPath);
          syncDirectory(path.dirname(txPath));
          recover(true);
        } catch (e) {
          if (published) fail('config_recovery_required');
          cleanup();
          throw e;
        }
        return result;
      });
    } catch (e) {
      if (knownCodes.has(e.code) || e?.providerMutation === true) throw e;
      if (['EACCES','EPERM'].includes(e.code)) fail('config_unreadable');
      return fail('config_write_failed');
    }
  }
  function recoverPending() {
    if (!stat(txPath)) return;
    return withLock(() => recover());
  }
  return { read, transact, recoverPending };
}
