'use strict';

const path = require('node:path');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { fail, componentOK, dirIdentity, fileStamp, hashRows, MAX_PATH } = require('./system-storage-fs.cjs');
const { classifyTop, classifyChild } = require('./system-storage-policy.cjs');

const MAX_ENTRIES = 12_000;
const MAX_BYTES = 16 * 1024 ** 3;
const MAX_FILE_BYTES = 2 * 1024 ** 3;
let executionTimelineSchema;
try { executionTimelineSchema = require('./execution-timeline-schema.cjs'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  executionTimelineSchema = require('../lib/execution-timeline-schema.cjs');
}
const { MAX_EXECUTION_TIMELINE_BYTES } = executionTimelineSchema;
const FACT_LIMITS = new Map([['projects.json', 1024 ** 2], ['conversations.json', 1024 ** 2], ['environment.json', 64 * 1024],
  ['provider-management.json', 16 * 1024 ** 2], ['worktrees.json', 1024 ** 2], ['execution-timeline.json', MAX_EXECUTION_TIMELINE_BYTES]]);
const BLOCK_SIZE = 256 * 1024;
const sortRelative = (a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0;
const shapeRows = entries => entries.map(row => [row.relative, row.kind, row.binding || row.stamp]);
const destinationCheck = (entries, root) => entries.map(entry => ({ path: path.join(root, entry.relative), directory: entry.kind === 'directory' }));

function createStorageInventory(storage) {
  async function collect(root, options) {
    let visited = 0, bytes = 0, hasRuntime = false;
    const entries = [];
    const rootStat = await storage.lstat(root.path);
    const rootObject = await storage.guard(root);
    if (dirIdentity(rootStat) !== rootObject.ids.at(-1)) fail('path_changed');
    let next = [{ parent: rootObject, store: '', depth: 0 }];

    async function emptySkeleton(file, parent, store, depth = 0) {
      // Only these exact owner skeletons may be recreated at the new root.
      // No UUID worktree, run, transaction, lock, or even 0-byte evidence is
      // ignored. Check every level before enumerating it, not just its name.
      const reason = store === 'revert-evidence' ? 'revert_evidence_present' : 'worktree_or_candidate_present';
      const stat = await storage.lstat(file);
      if (!stat) fail('inventory_changed');
      if (stat.isSymbolicLink() || stat.dev !== rootStat.dev) fail('unsafe_entry');
      if (!stat.isDirectory()) fail(reason);
      const id = dirIdentity(stat);
      const reference = await storage.directory(file);
      if (reference.ids.at(-1) !== id || reference.ids.at(-2) !== parent.ids.at(-1)) fail('path_changed');
      await storage.native([{ path: file, directory: true }]);
      const cursor = await storage.io.opendir(file);
      try {
        for (let item; (item = await cursor.read());) {
          if (++visited > MAX_ENTRIES) fail('inventory_limit');
          const allowed = store === 'revert-evidence' ? item.name === ['v1', 'objects'][depth]
            : store === 'worktrees' && depth === 0 && /^[a-f0-9]{24}$/u.test(item.name);
          if (!allowed) fail(reason);
          await emptySkeleton(path.join(file, item.name), reference, store, depth + 1);
        }
      } finally { await cursor.close(); }
      await storage.guard(reference);
      await storage.guard(parent);
    }

    async function walk({ parent, store, depth }) {
      await storage.guard(parent);
      const cursor = await storage.io.opendir(parent.path, { bufferSize: 32 });
      const names = new Set();
      try {
        for (let item; (item = await cursor.read());) {
          if (++visited > MAX_ENTRIES) fail('inventory_limit');
          const name = item.name;
          // Case/normalization collisions cannot be committed to another volume.
          const key = name.normalize('NFC').toLowerCase();
          if (names.has(key)) fail('name_collision');
          names.add(key);
          const topKind = depth === 0 ? classifyTop(name, options.mixed, options.destination) : null;
          if (depth === 0 && ['empty-evidence', 'empty-worktree'].includes(topKind)) {
            await emptySkeleton(path.join(parent.path, name), parent, name);
            continue;
          }
          if (depth === 0 && topKind === null) {
            if (name === 'runtime') hasRuntime = true;
            continue; // Deliberately don't inspect Chromium, logs or install contents.
          }
          if (!componentOK(name)) fail('unsafe_entry');
          const file = path.join(parent.path, name);
          if (file.length > MAX_PATH) fail('inventory_limit');
          const stat = await storage.lstat(file);
          if (!stat) fail('inventory_changed');
          if (stat.isSymbolicLink() || stat.dev !== rootStat.dev) fail('unsafe_entry');
          const kind = topKind || classifyChild(store, name, depth, stat.isDirectory());
          if (!kind) fail(options.destination ? 'verification_failed' : 'unknown_data');
          const relative = path.relative(root.path, file);
          if (kind === 'directory') {
            const id = dirIdentity(stat);
            const child = await storage.directory(file);
            if (child.ids.at(-1) !== id || child.ids.at(-2) !== parent.ids.at(-1)) fail('path_changed');
            entries.push({ relative, kind, binding: child.binding });
            next.push({ parent: child, store: store || name, depth: depth + 1 });
          } else {
            const plain = await storage.plain(file);
            if (!plain || plain.size !== stat.size) fail('inventory_changed');
            if (plain.size < 0n || plain.size > BigInt(MAX_FILE_BYTES)) fail('inventory_limit');
            bytes += Number(plain.size);
            if (bytes > MAX_BYTES) fail('inventory_limit');
            entries.push({ relative, kind, ...plain, parent });
          }
        }
      } finally { await cursor.close(); }
      await storage.guard(parent);
    }
    while (next.length) {
      const batch = next;
      next = [];
      // Windows can expose reparse directories as ordinary directories to
      // Node. Check each depth before enumerating any of its children.
      await storage.native(batch.map(({ parent }) => ({ path: parent.path, directory: true })));
      for (const item of batch) await walk(item);
    }
    entries.sort(sortRelative);
    return { bytes, entries, hasRuntime, shape: hashRows(shapeRows(entries)) };
  }

  async function stream(handle, size, use) {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(BLOCK_SIZE, size));
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) fail('inventory_changed');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await use?.(chunk, offset);
      offset += bytesRead;
    }
    return hash.digest('hex');
  }

  async function scan(root, { mixed = false, destination = false } = {}) {
    const options = { mixed, destination };
    const result = await collect(root, options);
    const facts = new Map();
    await storage.native([{ path: root.path, directory: true }, ...destinationCheck(result.entries, root.path)]);
    const manifest = [];
    for (const entry of result.entries) {
      const row = [entry.relative, entry.kind];
      if (entry.kind === 'file') {
        const file = path.join(root.path, entry.relative);
        const max = !destination && FACT_LIMITS.get(entry.relative);
        if (max && entry.size > BigInt(max)) fail('inventory_limit');
        const content = max ? Buffer.alloc(Number(entry.size)) : null;
        entry.sha256 = await storage.readBound(file, entry, () => storage.guard(entry.parent), (handle, size) =>
          stream(handle, size, content && ((chunk, offset) => { chunk.copy(content, offset); })));
        if (content) facts.set(entry.relative, content);
        row.push(Number(entry.size), entry.sha256);
      }
      manifest.push(row);
    }
    const after = await collect(root, options);
    if (result.shape !== after.shape || result.hasRuntime !== after.hasRuntime) fail('inventory_changed');
    const contentDigest = hashRows(manifest);
    return { ...result, facts, contentDigest, fingerprint: hashRows([root.binding, result.shape, contentDigest, result.hasRuntime]) };
  }

  async function copyFile(source, target, entry, parent, step) {
    const input = path.join(source.path, entry.relative), output = path.join(target.path, entry.relative);
    const guardParent = () => storage.guard(parent);
    await step('before_copy_file', { relative: entry.relative });
    await guardParent();
    // Exclusive creation, even if a conflicting name appeared after preflight.
    const handle = await storage.io.open(output, 'wx', 0o600);
    let writtenStamp;
    try {
      const opened = fileStamp(await handle.stat({ bigint: true }));
      if ((await storage.plain(output))?.stamp !== opened) fail('path_changed');
      await guardParent();
      const copied = await storage.readBound(input, entry, () => storage.guard(entry.parent), (inputHandle, size) =>
        stream(inputHandle, size, async (chunk, offset) => {
          for (let written = 0; written < chunk.length;) {
            const { bytesWritten } = await handle.write(chunk, written, chunk.length - written, offset + written);
            if (!bytesWritten) fail('copy_failed');
            written += bytesWritten;
          }
          await step('after_copy_chunk', { relative: entry.relative });
        }));
      if (copied !== entry.sha256) fail('source_changed');
      await handle.sync();
      writtenStamp = fileStamp(await handle.stat({ bigint: true }));
    } finally { await handle.close(); }
    await guardParent();
    if ((await storage.plain(output))?.stamp !== writtenStamp) fail('path_changed');
    return { ...entry, stamp: writtenStamp };
  }

  async function copy(source, target, inventory, step) {
    await storage.empty(target);
    const created = new Map([['.', await storage.guard(target)]]), written = [];
    for (const entry of inventory.entries) {
      const parent = created.get(path.dirname(entry.relative));
      if (!parent) fail('copy_failed');
      if (entry.kind === 'directory') {
        const output = path.join(target.path, entry.relative);
        await storage.guard(parent);
        await storage.io.mkdir(output, { mode: 0o700 });
        const child = await storage.directory(output);
        if (child.ids.at(-2) !== parent.ids.at(-1)) fail('path_changed');
        created.set(entry.relative, child);
        written.push({ ...entry, binding: child.binding });
      } else written.push(await copyFile(source, target, entry, parent, step));
    }
    for (const dir of [...created.values()].reverse()) await storage.syncDirectory(dir);
    return hashRows(shapeRows(written));
  }
  return { scan, copy };
}

module.exports = { createStorageInventory, MAX_EXECUTION_TIMELINE_BYTES };
