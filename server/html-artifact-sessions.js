import fs from 'node:fs';
import path from 'node:path';
import { readSessionText } from './session-history.js';
import { activePath } from './session-edit-target.js';
import { htmlArtifactFromToolResult } from '../public/html-artifact-model.js';

const MAX_NATIVE_BYTES = 128 * 1024 * 1024;
const stamp = stat => [stat.dev, stat.ino, stat.birthtimeMs, stat.size, stat.mtimeMs, stat.ctimeMs];
const identity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });

// File/expected are supplied only by the existing native session resolver or
// Registry, never by a client. Unlike the legacy bounded tail this requires a
// complete, stable physical tree and reconstructs the persisted native leaf.
export function readHtmlArtifactSession(file, expected) {
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return null;
    const read = readSessionText(file, { expected, maxBytes: MAX_NATIVE_BYTES, stable: true });
    // Without an expected header, the retention reader still needs same-file
    // stability; its separate scan checks ancestry and the full inventory.
    if (!read.ok || read.truncated) return null;
    const lines = read.text.split('\n');
    const header = JSON.parse(lines.shift());
    if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || typeof header.cwd !== 'string') return null;
    const entries = [], ids = new Set();
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
        || !(entry.parentId === null || typeof entry.parentId === 'string')) return null;
      entries.push(entry); ids.add(entry.id);
    }
    // Pi 1.6 SessionManager._buildIndex restores a v3 file's leaf to its
    // last entry. This is ONLY a dormant/restorable branch, never evidence of
    // a live child's memory-only branch() navigation. Authority excludes live
    // sessions and uses readExecutionBranch for them instead.
    const leafId = entries.at(-1)?.id ?? null;
    const branch = entries.length ? activePath(entries, leafId) : [];
    if (!branch || JSON.stringify(stamp(before)) !== JSON.stringify(stamp(fs.lstatSync(file)))) return null;
    return { header, entries, branch, leafId };
  } catch { return null; }
}

// This is a retention scan, not read authorization. Every physical toolResult
// on every leaf (including recoverable trash and copied forks) retains bytes.
// Any unreadable/truncated/linked/unstable input makes the entire scan incomplete.
export function scanHtmlArtifactReferences(roots) {
  const referencedIds = new Set(), observed = new Map();
  let complete = true, files = 0;
  const observe = (target, list = true) => {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw Error();
      const entry = { stat: stamp(stat), directory: stat.isDirectory() };
      if (entry.directory) {
        if (list) entry.names = fs.readdirSync(target).sort();
        else if (observed.get(target)?.names) entry.names = observed.get(target).names;
      } else if (!stat.isFile()) throw Error();
      observed.set(target, entry);
      return { stat, entry };
    } catch (error) {
      if (error.code === 'ENOENT') { observed.set(target, null); return null; }
      complete = false; return null;
    }
  };
  const walk = (target, depth = 0) => {
    if (depth > 32) { complete = false; return; }
    const found = observe(target);
    if (!found) return;
    if (found.entry.directory) {
      for (const name of found.entry.names) walk(path.join(target, name), depth + 1);
      return;
    }
    if (!target.endsWith('.jsonl')) return;
    files++;
    const read = readHtmlArtifactSession(target);
    if (!read) { complete = false; return; }
    for (const row of read.entries) {
      if (row.type !== 'message' || row.message?.role !== 'toolResult') continue;
      const ref = htmlArtifactFromToolResult(row.message);
      if (ref) referencedIds.add(ref.id);
      else if (row.message.toolName === 'html_render' && row.message.details?.kind === 'html_artifact'
        && row.message.details?.ok !== false) complete = false; // Unknown/future typed references cannot authorize deletion.
    }
  };
  for (const root of new Set(roots)) {
    let safe = true;
    for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
      const found = observe(parent, false);
      if (!found?.entry.directory) { complete = false; safe = false; break; }
      if (path.dirname(parent) === parent) break;
    }
    if (safe) walk(root);
  }
  // Keep the exact inventory validator through scan -> store continuation ->
  // every delete. It detects observed external changes, not uncooperative native
  // exclusion; automatic GC still cannot be enabled using this check alone.
  const isCurrent = () => {
    for (const [target, before] of observed) {
      try {
        const stat = fs.lstatSync(target);
        if (!before || stat.isSymbolicLink() || JSON.stringify(stamp(stat)) !== JSON.stringify(before.stat)
          || before.names && JSON.stringify(fs.readdirSync(target).sort()) !== JSON.stringify(before.names)) return false;
      } catch (error) { if (before || error.code !== 'ENOENT') return false; }
    }
    return true;
  };
  complete = complete && isCurrent();
  return { complete, referencedIds, files, isCurrent };
}

export function htmlSessionIdentity(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('history_unavailable');
  return identity(stat);
}

export function createHtmlArtifactReconciler({ store, roots, graceMs = 10 * 60 * 1000,
  now = Date.now, scan = scanHtmlArtifactReferences, withNativeExclusion = null } = {}) {
  const inflight = new Set();
  let running = null, disposed = false, publicationRevision = 0;
  return {
    begin() {
      const record = {};
      publicationRevision++; inflight.add(record);
      return () => inflight.delete(record);
    },
    reconcile() {
      if (disposed) return Promise.resolve({ skipped: true, reason: 'disposed' });
      if (running) return running;
      // The store's wx lock excludes publish/read/collect, NOT Pi append, branch
      // or copied forks. A timestamp/mtime or final epoch check cannot close the
      // Promise-resolution gap. Production intentionally supplies no exclusion.
      if (typeof withNativeExclusion !== 'function') return Promise.resolve({ skipped: true, reason: 'native_mutation_unproven' });
      running = (async () => withNativeExclusion(async isCurrent => {
        const revision = publicationRevision;
        let reason = null, files;
        const current = () => !disposed && !inflight.size && revision === publicationRevision
          && typeof isCurrent === 'function' && isCurrent() === true;
        if (!current()) return { skipped: true, reason: disposed ? 'disposed' : 'native_mutation_unproven' };
        // The admission owner must hold exclusion until this await settles,
        // including scan -> store continuation -> synchronous deletion commit.
        const result = await store.collect({ scan: async () => {
          if (!current()) { reason = disposed ? 'disposed' : 'native_mutation_unproven'; return { complete: false }; }
          const startedAt = now(), snapshot = await scan(roots());
          files = snapshot?.files;
          if (!current() || snapshot?.complete !== true) {
            reason = disposed ? 'disposed' : !current() ? 'native_mutation_unproven' : 'native_scan_incomplete';
            return { complete: false };
          }
          // Only a fresh lock-held scan may supply reference/candidate sets.
          // Cutoff is a retention policy, never a concurrency proof.
          return { complete: true, referencedIds: snapshot.referencedIds,
            ...(snapshot.candidateIds ? { candidateIds: snapshot.candidateIds } : {}),
            beforeMs: Math.max(0, startedAt - graceMs) };
        } });
        return reason ? { skipped: true, reason, ...(files === undefined ? {} : { files }) } : result;
      }))().catch(() => ({ skipped: true, reason: 'reconcile_unavailable' })).finally(() => { running = null; });
      return running;
    },
    async dispose() { disposed = true; await running; inflight.clear(); },
  };
}
