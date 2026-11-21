'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { absolute, fail, failureCode, StorageFault, digest, parseJson, exact, object, hexDigest, uuid, overlaps } = require('./system-storage-fs.cjs');
const { BOOT_FILE } = require('./system-storage-policy.cjs');

const VERSION = 1;
const LIMIT = 32 * 1024;
const PENDING = new Set(['intent', 'ready', 'staging', 'verified']);
const PHASES = new Set([...PENDING, 'committed', 'active', 'failed']);
const FAILURE_REASONS = new Set([
  'cancelled', 'shutdown_unconfirmed', 'interrupted_staging', 'start_failed', 'boot_write_failed', 'boot_changed',
  'unsafe_entry', 'native_check_unavailable', 'permission_denied', 'path_changed', 'directory_missing', 'source_missing',
  'target_missing', 'identity_unavailable', 'invalid_path', 'source_changed', 'runtime_binding_changed',
  'source_target_overlap', 'protected_overlap', 'protected_roots_unavailable', 'target_not_empty', 'inventory_changed',
  'insufficient_space', 'space_unavailable', 'name_collision', 'inventory_limit', 'unknown_data', 'unknown_transaction',
  'worktree_or_candidate_present', 'provider_authority_present', 'revert_evidence_present', 'invalid_projects',
  'provider_metadata_invalid', 'provider_metadata_unsupported', 'provider_metadata_format_unsupported', 'provider_metadata_unavailable', 'execution_timeline_invalid', 'execution_timeline_unavailable', 'pi_agent_path_relative',
  'invalid_conversations', 'runtime_locator_bound', 'invalid_environment', 'runtime_not_pinned',
  'copy_failed', 'verification_failed', 'storage_io_failed',
]);
const empty = () => ({ version: VERSION, managed: null, transaction: null });

function validPath(value) {
  try { return absolute(value) === value && path.dirname(value) !== value; }
  catch { return false; }
}
const validReference = value => exact(value, ['path', 'binding']) && validPath(value.path) && hexDigest(value.binding);
const validRuntime = value => value === null || validPath(value);
function validate(doc) {
  if (object(doc) && Number.isInteger(doc.version) && doc.version > VERSION) fail('boot_version_unsupported');
  if (!exact(doc, ['version', 'managed', 'transaction']) || doc.version !== VERSION) fail('boot_corrupt');
  const { managed, transaction: tx } = doc;
  if (managed !== null && (!exact(managed, ['path', 'binding', 'transactionId', 'backupDirectory', 'runtimeDirectory'])
      || !validPath(managed.path) || !hexDigest(managed.binding) || !uuid(managed.transactionId)
      || !validPath(managed.backupDirectory) || overlaps(managed.path, managed.backupDirectory) || !validRuntime(managed.runtimeDirectory))) fail('boot_corrupt');
  if (tx === null) {
    if (managed !== null) fail('boot_corrupt');
    return doc;
  }
  if (!exact(tx, ['id', 'phase', 'source', 'target', 'sourceDigest', 'targetDigest', 'runtimeDirectory', 'reason'])
      || !uuid(tx.id) || !PHASES.has(tx.phase) || !validReference(tx.source) || !validReference(tx.target)
      || overlaps(tx.source.path, tx.target.path) || tx.source.binding === tx.target.binding || !hexDigest(tx.sourceDigest)
      || !validRuntime(tx.runtimeDirectory) || !(tx.targetDigest === null || hexDigest(tx.targetDigest))
      || (tx.phase === 'failed' ? !FAILURE_REASONS.has(tx.reason) : tx.reason !== null)) fail('boot_corrupt');
  const switched = tx.id === managed?.transactionId;
  if ((switched || tx.phase === 'verified') && !tx.targetDigest) fail('boot_corrupt');
  if (['intent', 'ready', 'staging'].includes(tx.phase) && tx.targetDigest !== null) fail('boot_corrupt');
  if (switched) {
    if (!['committed', 'active', 'failed'].includes(tx.phase) || managed.path !== tx.target.path || managed.binding !== tx.target.binding
        || managed.backupDirectory !== tx.source.path || managed.runtimeDirectory !== tx.runtimeDirectory
        || (tx.phase === 'failed' && tx.reason !== 'start_failed')) fail('boot_corrupt');
  } else if (['committed', 'active'].includes(tx.phase) || tx.reason === 'start_failed'
      || (managed && (managed.path !== tx.source.path || managed.binding !== tx.source.binding))) fail('boot_corrupt');
  return doc;
}

function createStorageBoot(storage, anchor) {
  const file = path.join(anchor.path, BOOT_FILE);
  const guardAnchor = () => storage.guard(anchor);
  async function read({ native = true } = {}) {
    await guardAnchor();
    const entry = await storage.plain(file);
    if (native) await storage.native([{ path: anchor.path, directory: true }, ...(entry ? [{ path: file, directory: false }] : [])]);
    if (!entry) {
      await guardAnchor();
      if (await storage.plain(file)) fail('boot_changed');
      return { document: empty(), revision: null };
    }
    const bytes = await storage.readSmall(file, entry, guardAnchor, LIMIT, 'boot_corrupt');
    return { document: validate(parseJson(bytes, 'boot_corrupt')), revision: `${entry.stamp}:${digest(bytes)}` };
  }

  async function write(next, previous, { afterFlush, beforeRename } = {}) {
    validate(next);
    const text = Buffer.from(JSON.stringify(next) + '\n');
    if (text.length > LIMIT) fail('boot_write_failed');
    const temporary = path.join(anchor.path, `.system-storage-bootstrap-${randomUUID()}.tmp`);
    let tempEntry;
    try {
      await guardAnchor();
      const handle = await storage.io.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
        tempEntry = await storage.plain(temporary);
        const observed = await handle.stat({ bigint: true });
        if (!tempEntry?.stamp.startsWith(`${observed.dev}:${observed.ino}:${observed.birthtimeNs}:`)) fail('path_changed');
      } finally { await handle.close(); }
      await afterFlush?.();
      await storage.native([{ path: anchor.path, directory: true, writable: true }, { path: temporary, directory: false },
        ...(previous.revision !== null ? [{ path: file, directory: false }] : [])]);
      await beforeRename?.();
      const recorded = await read({ native: false });
      if (recorded.revision !== previous.revision) fail('boot_changed');
      const synced = await storage.readSmall(temporary, tempEntry, guardAnchor, LIMIT, 'boot_write_failed');
      if (!synced.equals(text)) fail('boot_write_failed');
      await storage.io.rename(temporary, file);
      await storage.syncDirectory(anchor);
      const saved = await read({ native: false });
      if (JSON.stringify(saved.document) !== JSON.stringify(next)) fail('boot_changed');
      return saved;
    } catch (error) {
      // Don't erase unrelated files or mask whether rename already happened.
      // The caller re-reads the pointer after an ambiguous result.
      if (error instanceof StorageFault) throw error;
      fail(failureCode(error, 'boot_write_failed'));
    } finally {
      if (tempEntry) {
        try {
          await guardAnchor();
          if ((await storage.plain(temporary))?.stamp === tempEntry.stamp) await storage.io.unlink(temporary);
        } catch { /* preserve uncertain temporary files */ }
      }
    }
  }
  return { read, write };
}

module.exports = { createStorageBoot, PENDING, FAILURE_REASONS };
