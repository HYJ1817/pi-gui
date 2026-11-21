'use strict';

// Read-only, bounded metadata for the two Chromium-owned cache trees. This is
// NOT a deletion API. In particular, never rm a live Cache / Code Cache tree.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const LIMITS = Object.freeze({ entries: 2048, depth: 8, milliseconds: 12000, pathBytes: 1024 * 1024 });
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const validBytes = value => Number.isSafeInteger(value) && value >= 0;

// Node's Windows Stats has neither FILE_ATTRIBUTE_REPARSE_POINT nor allocated
// bytes. Do not guess from size or isSymbolicLink alone (unknown reparse tags
// exist). A fixed, offline metadata probe supplies those two missing facts.
// Paths travel as JSON on stdin, never interpolated into PowerShell/code/argv.
const WINDOWS_PROBE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CacheFileMetadata {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetCompressedFileSizeW(string path, out uint high);
}
'@
$paths = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$result = @()
foreach ($p in $paths) {
  $attributes = [CacheFileMetadata]::GetFileAttributesW([string]$p)
  if ($attributes -eq [uint32]::MaxValue -or ($attributes -band 1024) -ne 0) { throw 'unsafe_metadata' }
  $allocated = $null
  if (($attributes -band 16) -eq 0) {
    [uint32]$high = 0
    $low = [CacheFileMetadata]::GetCompressedFileSizeW([string]$p, [ref]$high)
    if ($low -eq [uint32]::MaxValue -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 0) { throw 'unknown_allocation' }
    $allocated = [double]$high * 4294967296 + [double]$low
  }
  $result += @{ reparse = $false; allocatedBytes = $allocated }
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($result) -Compress))
`;
const WINDOWS_COMMAND = Buffer.from(WINDOWS_PROBE, 'utf16le').toString('base64');

async function inspectWindowsPaths(paths) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  if (!/^[a-z]:\\[^\0]*$/i.test(systemRoot)) throw Error('cache_metadata_unavailable');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const input = JSON.stringify(paths);
  if (Buffer.byteLength(input) > LIMITS.pathBytes) throw Error('cache_scan_limit');
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_COMMAND],
      { windowsHide: true, timeout: 5000, maxBuffer: 512 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) return reject(Error('cache_metadata_unavailable'));
        try {
          const rows = JSON.parse(stdout.replace(/^\uFEFF/, ''));
          if (!Array.isArray(rows) || rows.length !== paths.length) throw Error('invalid_metadata');
          resolve(rows);
        } catch { reject(Error('cache_metadata_unavailable')); }
      });
    child.stdin.on('error', () => {}); // execFile's callback owns the failure.
    child.stdin.end(input);
  });
}

function normalizedStoragePath(session) {
  const raw = session.getStoragePath();
  if (session.isPersistent() !== true || typeof raw !== 'string' || !path.isAbsolute(raw)
    || raw.includes('\0') || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(raw) || raw.slice(2).includes(':')))) {
    throw Error('cache_storage_unavailable');
  }
  return path.resolve(raw);
}

function createSessionDiskRoot(session, { io = fs, inspectPaths = process.platform === 'win32' ? inspectWindowsPaths : null,
  clock = Date.now, limits = LIMITS } = {}) {
  let root = null, initial = null;
  try { root = normalizedStoragePath(session); } catch { /* Remain unavailable. */ }
  // Only lower limits in a fixture/embedding; never silently widen authority.
  const bounds = Object.fromEntries(Object.keys(LIMITS).map(key => [key,
    Number.isInteger(limits[key]) && limits[key] > 0 ? Math.min(limits[key], LIMITS[key]) : LIMITS[key]]));
  function qualified() {
    try { return root !== null && samePath(normalizedStoragePath(session), root); } catch { return false; }
  }
  function ensureTime(start) { if (clock() - start > bounds.milliseconds) throw Error('cache_scan_limit'); }
  async function node(target, directory) {
    const stat = await io.lstat(target);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isDirectory() && !stat.isFile())
      || (stat.isFile() && stat.nlink !== 1) || !stat.ino || !validBytes(stat.size)) throw Error('cache_unsafe_path');
    if (!samePath(await io.realpath(target), target)) throw Error('cache_unsafe_path');
    return { path: target, id: identity(stat), stat };
  }
  async function check(nodes, start) {
    ensureTime(start);
    let metadata = null;
    if (inspectPaths) {
      metadata = await inspectPaths(nodes.map(n => n.path));
      if (!Array.isArray(metadata) || metadata.length !== nodes.length) throw Error('cache_metadata_unknown');
    }
    for (let i = 0; i < nodes.length; i++) {
      const old = nodes[i], current = await node(old.path, old.stat.isDirectory());
      if (current.id !== old.id || (old.stat.isFile() && current.stat.size !== old.stat.size)
        || (old.stableContents !== false && current.stat.mtimeMs !== old.stat.mtimeMs)) throw Error('cache_directory_changed');
      if (metadata && metadata[i]?.reparse !== false) throw Error('cache_unsafe_path');
      if (old.stat.isFile()) {
        const allocated = metadata ? metadata[i].allocatedBytes : current.stat.blocks * 512;
        if (!validBytes(allocated)) throw Error('cache_allocation_unknown');
        if (old.allocatedBytes !== undefined && old.allocatedBytes !== allocated) throw Error('cache_directory_changed');
        old.allocatedBytes = allocated;
      }
    }
    ensureTime(start);
  }
  async function ancestors(start) {
    if (!qualified()) throw Error('cache_storage_changed');
    const nodes = [];
    for (let current = root; ; current = path.dirname(current)) {
      // Other owners (and the Windows compiler's TEMP files) can legitimately
      // update ancestors. Their identity must be stable, not their contents.
      nodes.push({ ...await node(current, true), stableContents: false });
      if (path.dirname(current) === current) break;
      if (nodes.length > 64) throw Error('cache_scan_limit');
    }
    await check(nodes, start);
    const ids = nodes.map(n => n.id);
    if (initial && ids.some((id, i) => initial[i] !== id) || initial && ids.length !== initial.length) {
      throw Error('cache_directory_changed');
    }
    initial ??= ids;
    if (!qualified()) throw Error('cache_storage_changed');
    return nodes;
  }
  async function scan(name, expected = null) {
    if (!['Cache', 'Code Cache'].includes(name)) throw Error('cache_scope_invalid');
    const start = clock(), chain = await ancestors(start), target = path.join(root, name);
    let frontier = [], nodes = [], missing = false;
    try { frontier = [await node(target, true)]; }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; }
    const directories = new Map(chain.map(n => [n.path, n.id]));
    let diskBytes = 0, contentBytes = 0, count = 0, pathBytes = 0;
    for (let depth = 0; frontier.length; depth++) {
      if (depth > bounds.depth) throw Error('cache_scan_limit');
      await check(frontier, start); // Reject reparse points BEFORE descending.
      const next = [];
      for (const item of frontier) {
        if (++count > bounds.entries || (pathBytes += Buffer.byteLength(item.path)) > bounds.pathBytes) throw Error('cache_scan_limit');
        nodes.push(item);
        if (item.stat.isFile()) {
          diskBytes += item.allocatedBytes; contentBytes += item.stat.size;
          if (!validBytes(diskBytes) || !validBytes(contentBytes)) throw Error('cache_size_unknown');
          continue;
        }
        directories.set(item.path, item.id);
        const handle = await io.opendir(item.path);
        try {
          while (true) {
            ensureTime(start);
            const entry = await handle.read();
            if (!entry) break;
            if (count + next.length >= bounds.entries) throw Error('cache_scan_limit');
            if (entry.name === '.' || entry.name === '..' || /[\\/\0:]/.test(entry.name)) throw Error('cache_unsafe_path');
            next.push(await node(path.join(item.path, entry.name), false));
          }
        } finally { await handle.close(); }
      }
      frontier = next;
    }
    // No truncated enumeration, links, read/metadata failures or replaced nodes
    // can be interpreted as 0 B. Cache churn is allowed between scans, not inside
    // an unverifiable scan. All failures are projected by the caller as unknown.
    await check([...chain, ...nodes], start);
    if (missing) {
      try { await io.lstat(target); throw Error('cache_directory_changed'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!qualified()) throw Error('cache_storage_changed');
    if (expected) {
      for (const [directory, id] of directories) {
        if (expected.directories.has(directory) && expected.directories.get(directory) !== id) throw Error('cache_directory_changed');
      }
      // A previously absent cache tree is a new target, not the confirmed tree.
      if (expected.missing && !missing) throw Error('cache_directory_changed');
    }
    return { diskBytes, contentBytes, directories, missing, files: nodes.filter(n => n.stat.isFile()).length };
  }
  return { qualified, scan };
}

module.exports = { createSessionDiskRoot, inspectWindowsPaths, LIMITS, validBytes };
