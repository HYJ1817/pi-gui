'use strict';

const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { constants } = require('node:fs');
const { performance } = require('node:perf_hooks');
const { createStorageFs, absolute, samePath, exact, fail, failureCode } = require('./system-storage-fs.cjs');
const { createStoragePolicy, EXCLUDED } = require('./system-storage-policy.cjs');
const { createStorageInventory } = require('./system-storage-inventory.cjs');
const { createStorageBoot, PENDING, FAILURE_REASONS } = require('./system-storage-boot.cjs');

const TICKET_TTL_MS = 120_000;
const reference = ({ path, binding }) => ({ path, binding });
const unavailable = reason => ({ dataDirectory: null, source: null, phase: 'unavailable', reason,
  pending: false, switched: false, transactionId: null, backupDirectory: null, canMigrate: false });

// Main-process only. The caller owns Electron's single-instance lock and
// excludes all old/new backend writers throughout the cold call. A true
// `writersStopped` is an assertion by that trusted host, not a PID probe or
// authorization supplied by renderer. There is no HTTP/IPC in this module.
function createSystemStorage({ directory, defaultDataDirectory = directory, explicitDataDirectory,
  protectedRoots = [], getProtectedRoots = () => [], piAgentDirectory = process.env.PI_CODING_AGENT_DIR || null,
  runtimeDirectory = null, io, inspectWindows, hook = () => {}, now = () => performance.now() } = {}) {
  // Honor the existing operator override, including Windows UNC, without
  // opening or validating any managed path. Native migration stays stricter.
  const explicit = explicitDataDirectory ? path.resolve(explicitDataDirectory) : null;
  const anchorPath = explicit ? directory : absolute(directory), legacy = explicit ? defaultDataDirectory : absolute(defaultDataDirectory);
  // Resolve only at the policy boundary. A relative Pi override must disable
  // migration, not guess Main's cwd or prevent an unchanged idle root opening.
  const piAgent = piAgentDirectory;
  const runtime = runtimeDirectory == null ? null : path.resolve(runtimeDirectory);
  if ([anchorPath, legacy, runtime].some(value => value && path.dirname(value) === value)) fail('invalid_path');
  const storage = createStorageFs({ io, inspectWindows });
  const policy = createStoragePolicy({ storage, anchor: anchorPath, legacy, piAgent, protectedRoots, getProtectedRoots, runtimeDirectory: runtime });
  const inventory = createStorageInventory(storage);
  let boot, anchor, loaded, ticket, busy = false;
  let current = unavailable('not_initialized');

  function state() { return { ...current, excluded: [...EXCLUDED] }; }
  const result = (ok, details) => ({ ok, ...details, state: state() });
  function adopt(next) {
    loaded = next;
    const { managed, transaction: tx } = next.document;
    const pending = PENDING.has(tx?.phase);
    current = {
      dataDirectory: managed?.path || legacy, source: managed ? 'managed' : 'electron-user-data',
      phase: tx?.phase || 'idle', reason: tx?.reason || null, pending,
      transactionId: tx?.id || null, switched: Boolean(managed && tx?.id === managed.transactionId),
      backupDirectory: managed?.backupDirectory || null, canMigrate: !pending && tx?.phase !== 'committed',
    };
  }
  function block(code) { ticket = null; loaded = null; current = unavailable(code); }
  async function single(action) {
    if (busy) return result(false, { code: 'storage_busy' });
    busy = true;
    try { return await action(); }
    catch (error) { return result(false, { code: failureCode(error) }); }
    finally { busy = false; }
  }

  async function initialize() {
    return single(async () => {
      block('not_initialized');
      // An explicit operator override shadows (and does not rewrite or validate)
      // managed configuration. Without it, every invalid boot record blocks.
      if (explicit) {
        current = { ...unavailable(null), dataDirectory: explicit, source: 'environment', phase: 'idle' };
        return result(true);
      }
      try {
        anchor = await storage.directory(anchorPath, 'boot_directory_missing');
        boot = createStorageBoot(storage, anchor);
        const read = await boot.read();
        const { managed, transaction: tx } = read.document;
        if (managed) {
          await policy.guardManaged(managed.path);
          const root = await storage.directory(managed.path, 'managed_directory_missing');
          if (root.binding !== managed.binding) fail('managed_directory_changed');
          await storage.native([{ path: managed.path, directory: true }]);
          if (managed.runtimeDirectory !== runtime) fail('runtime_binding_changed');
        } else if (tx) {
          if (!samePath(tx.source.path, legacy)) fail('boot_corrupt');
          await storage.guard(tx.source);
          if (!samePath(legacy, anchorPath)) await storage.native([{ path: legacy, directory: true }]);
        }
        adopt(read);
        return result(true);
      } catch (error) {
        const code = failureCode(error, 'boot_unavailable');
        block(code);
        return result(false, { code });
      }
    });
  }

  function requireManagedMode() {
    if (explicit) fail('environment_override');
    if (!loaded) fail(current.reason || 'not_initialized');
  }
  async function confirmDisk() {
    const next = await boot.read();
    if (next.revision !== loaded.revision) fail('boot_changed');
  }
  async function currentDisk() {
    try { await confirmDisk(); }
    catch (error) { block(failureCode(error, 'boot_unavailable')); throw error; }
  }
  async function guardSelectedRoot() {
    const selected = loaded?.document.managed || loaded?.document.transaction?.source;
    if (!selected) return;
    try {
      await storage.guard(selected);
      await storage.native([{ path: selected.path, directory: true }]);
    } catch (error) {
      block(failureCode(error, 'storage_io_failed'));
      throw error;
    }
  }

  async function step(name, tx, detail = {}) {
    await hook(name, { transactionId: tx.id, phase: tx.phase, sourceDirectory: tx.source.path, targetDirectory: tx.target.path, ...detail });
  }
  async function checkpoint(document, beforeRename) {
    const tx = document.transaction;
    const previous = loaded;
    try {
      adopt(await boot.write(document, previous, { afterFlush: () => step('before_boot_rename', tx), beforeRename }));
    } catch (error) {
      // In particular, an error after rename is not evidence of rollback.
      // The boot file is the single authority on both sides of that syscall.
      try {
        const observed = await boot.read();
        if (JSON.stringify(observed.document) === JSON.stringify(document)) adopt(observed);
        else if (observed.revision !== previous.revision) block('boot_changed');
      } catch (readError) { block(failureCode(readError, 'boot_unavailable')); }
      throw error;
    }
    await step(`after_${tx.phase}`, tx);
  }

  function checkRoots(source, target) {
    if (source.ids.includes(target.ids.at(-1)) || target.ids.includes(source.ids.at(-1))) fail('source_target_overlap');
  }
  const scanSource = source => inventory.scan(source, { mixed: samePath(source.path, anchorPath) });

  async function prepare(sourcePath, targetPath, expected) {
    if (path.dirname(targetPath) === targetPath) fail('protected_overlap');
    await policy.guardRoots(sourcePath, targetPath);
    const source = await storage.directory(sourcePath, 'source_missing');
    const target = await storage.directory(targetPath, 'target_missing');
    if (expected && (source.binding !== expected.source.binding || target.binding !== expected.target.binding)) fail('path_changed');
    if (loaded.document.managed && source.binding !== loaded.document.managed.binding) fail('path_changed');
    checkRoots(source, target);
    await storage.native([{ path: anchor.path, directory: true, writable: true },
      { path: target.path, directory: true, writable: true }]);
    await storage.io.access(anchor.path, constants.W_OK | constants.X_OK);
    await storage.empty(target);
    const sourceSet = await scanSource(source);
    await policy.verifyBusiness(source.path, target.path, sourceSet);
    await storage.freeSpace(target, sourceSet);
    await storage.empty(target);
    if (expected && sourceSet.fingerprint !== expected.sourceDigest) fail('source_changed');
    return { source, target, sourceSet };
  }

  async function preview(selectedPath) {
    return single(async () => {
      ticket = null;
      requireManagedMode();
      if (!current.canMigrate) fail('migration_pending');
      const target = absolute(selectedPath);
      await currentDisk();
      const plan = await prepare(current.dataDirectory, target);
      await currentDisk();
      ticket = {
        value: randomBytes(32).toString('hex'), expires: now() + TICKET_TTL_MS,
        source: reference(plan.source), target: reference(plan.target), sourceDigest: plan.sourceSet.fingerprint,
      };
      const { entries, bytes } = plan.sourceSet;
      return result(true, { ticket: ticket.value, summary: {
        targetDirectory: target, files: entries.filter(entry => entry.kind === 'file').length,
        directories: entries.filter(entry => entry.kind === 'directory').length, bytes,
        included: entries.filter(entry => path.dirname(entry.relative) === '.').map(entry => entry.relative), excluded: [...EXCLUDED],
      } });
    });
  }

  async function commit(request) {
    let id, checkpointAttempted = false;
    const outcome = await single(async () => {
      requireManagedMode();
      if (!exact(request, ['ticket', 'confirm']) || typeof request.ticket !== 'string') fail('invalid_request');
      if (!ticket || request.ticket !== ticket.value) fail('ticket_invalid');
      const { expires, source, target, sourceDigest } = ticket;
      ticket = null;
      if (request.confirm !== true) fail('confirm_required');
      if (now() >= expires) fail('ticket_invalid');
      await currentDisk();
      if (!current.canMigrate || current.dataDirectory !== source.path) fail('migration_pending');
      const tx = { id: randomUUID(), phase: 'intent', source, target, sourceDigest, targetDigest: null, runtimeDirectory: runtime, reason: null };
      id = tx.id;
      await prepare(source.path, target.path, tx);
      if (now() >= expires) fail('ticket_invalid');
      checkpointAttempted = true;
      await checkpoint({ ...loaded.document, transaction: tx }, async () => {
        await storage.guard(source);
        await storage.empty(target);
      });
      return result(true);
    });
    // A post-rename failure can leave our intent durable. The operation may
    // cancel only the record it actually created, not another stored intent.
    // Preserve identity even if both the post-rename write and its reread fail.
    // The parent then cannot resume writers/update admission over an ambiguous
    // durable transaction: cancellation will fail closed and retain the barrier.
    const ambiguousDurability = outcome.state.phase === 'unavailable';
    return id && (outcome.state.transactionId === id || checkpointAttempted && ambiguousDurability)
      ? { ...outcome, intentId: id } : outcome;
  }

  async function arm(request) {
    return single(async () => {
      requireManagedMode();
      if (!exact(request, ['transactionId']) || current.phase !== 'intent'
          || request.transactionId !== current.transactionId) fail('pending_identity_mismatch');
      await currentDisk();
      const tx = loaded.document.transaction;
      // Main calls this only after the same prepared backend acknowledged
      // graceful shutdown and actually exited. Cold boot never upgrades intent.
      await checkpoint({ ...loaded.document, transaction: { ...tx, phase: 'ready' } }, async () => {
        await storage.guard(tx.source);
        await storage.empty(tx.target);
      });
      return result(true);
    });
  }

  async function verifyTransfer(tx, copiedShape) {
    await policy.guardRoots(tx.source.path, tx.target.path);
    const source = await scanSource(tx.source);
    if (source.fingerprint !== tx.sourceDigest) fail('source_changed');
    await policy.verifyBusiness(tx.source.path, tx.target.path, source);
    const target = await inventory.scan(tx.target, { destination: true });
    if (source.bytes !== target.bytes || source.contentDigest !== target.contentDigest
        || (copiedShape && copiedShape !== target.shape)
        || (tx.targetDigest && target.fingerprint !== tx.targetDigest)) fail('verification_failed');
    return target.fingerprint;
  }

  async function copyPending(tx) {
    const plan = await prepare(tx.source.path, tx.target.path, tx);
    const staging = { ...tx, phase: 'staging' };
    await checkpoint({ ...loaded.document, transaction: staging }, () => storage.empty(tx.target));
    await storage.native([{ path: tx.target.path, directory: true, writable: true }]);
    const copiedShape = await inventory.copy(plan.source, plan.target, plan.sourceSet, (name, detail) => step(name, staging, detail));
    await step('after_copy', staging);
    const targetDigest = await verifyTransfer(staging, copiedShape);
    const verified = { ...staging, phase: 'verified', targetDigest };
    await checkpoint({ ...loaded.document, transaction: verified });
    return verified;
  }

  async function switchRoot(tx) {
    const managed = { ...tx.target, transactionId: tx.id, backupDirectory: tx.source.path, runtimeDirectory: tx.runtimeDirectory };
    const committed = { ...tx, phase: 'committed' };
    await step('before_switch', tx);
    await checkpoint({ ...loaded.document, managed, transaction: committed }, () => verifyTransfer(tx));
  }

  async function runPendingCold(request) {
    return single(async () => {
      if (!exact(request, ['writersStopped']) || request.writersStopped !== true) fail('writers_not_confirmed');
      if (explicit && current.source === 'environment') return result(true);
      requireManagedMode();
      await currentDisk();
      const tx = loaded.document.transaction;
      if (!PENDING.has(tx?.phase)) {
        await guardSelectedRoot();
        return result(true);
      }
      try {
        if (tx.runtimeDirectory !== runtime) fail('runtime_binding_changed');
        // A crashed writer may have left a partial directory (even if empty).
        // Never resume that copy, replace it, or look for directories to delete.
        if (tx.phase === 'intent') fail('shutdown_unconfirmed');
        if (tx.phase === 'staging') fail('interrupted_staging');
        await switchRoot(tx.phase === 'ready' ? await copyPending(tx) : tx);
        await guardSelectedRoot();
        return result(true);
      } catch (error) {
        const observed = loaded?.document.transaction;
        const code = failureCode(error, observed?.phase === 'staging' ? 'copy_failed' : 'storage_io_failed');
        let persistenceCode, startupCode;
        if (observed?.id === tx.id && PENDING.has(observed.phase)) {
          const reason = FAILURE_REASONS.has(code) ? code : 'storage_io_failed';
          try { await checkpoint({ ...loaded.document, transaction: { ...observed, phase: 'failed', reason } }); }
          catch (persistError) { persistenceCode = failureCode(persistError, 'boot_write_failed'); }
        }
        try { await guardSelectedRoot(); }
        catch (startupError) { startupCode = failureCode(startupError); }
        return result(false, { code, ...(persistenceCode && { persistenceCode }), ...(startupCode && { startupCode }) });
      }
    });
  }

  async function markStarted(request) {
    return single(async () => {
      requireManagedMode();
      if (!exact(request, ['transactionId', 'dataDirectory', 'ok']) || typeof request.ok !== 'boolean'
          || request.transactionId !== current.transactionId || request.dataDirectory !== current.dataDirectory || !current.switched) fail('startup_identity_mismatch');
      await currentDisk();
      const tx = loaded.document.transaction;
      await storage.guard(tx.target);
      if (tx.phase === 'active' && request.ok) return result(true);
      if (tx.phase === 'active') fail('startup_not_pending');
      await checkpoint({ ...loaded.document, transaction: { ...tx, phase: request.ok ? 'active' : 'failed',
        reason: request.ok ? null : 'start_failed' } }, () => storage.guard(tx.target));
      return result(true);
    });
  }

  async function cancelPending(request) {
    return single(async () => {
      requireManagedMode();
      if (!exact(request, ['transactionId']) || !current.pending || request.transactionId !== current.transactionId) fail('pending_identity_mismatch');
      await currentDisk();
      const tx = loaded.document.transaction;
      await checkpoint({ ...loaded.document, transaction: { ...tx, phase: 'failed', reason: 'cancelled' } });
      return result(true);
    });
  }
  return { initialize, state, preview, commit, arm, runPendingCold, markStarted, cancelPending };
}

module.exports = { createSystemStorage };
