/* Workspace-only filename/path search. No content reads or external grants.
 * opendir bounds enumeration memory even for a single enormous directory. */
import fs from 'node:fs';
import path from 'node:path';
import { directoryIdentityOf, sameStatIdentity } from './file-identity.js';
import { assertPreviewPath } from './file-preview-reader.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'target', 'vendor', '.cache']);
const fail = (code) => Object.assign(new Error(code), { code });

export async function searchPreviewFiles({ root, query, hidden = false, assertAccess,
  maxEntries = 4000, maxDepth = 8, maxResults = 100 }) {
  const queue = [{ abs: root, rel: '', depth: 0 }];
  const entries = [];
  const wanted = query.toLocaleLowerCase();
  let visited = 0;
  let truncated = false;
  for (let head = 0; head < queue.length; head++) {
    await assertAccess();
    const current = queue[head];
    let dir;
    try {
      assertPreviewPath(root, current.abs);
      const before = directoryIdentityOf(fs.lstatSync(current.abs));
      dir = await fs.promises.opendir(current.abs, { bufferSize: 32 });
      assertPreviewPath(root, current.abs);
      if (!sameStatIdentity(before, fs.lstatSync(current.abs))) throw fail('unsafe_path');
      for (;;) {
        if (visited >= maxEntries) { truncated = true; break; }
        const entry = await dir.read();
        if (!entry) break;
        visited++;
        // Also check between asynchronous Dir.read calls: a queued directory may
        // have become a junction, including one pointing back inside the root.
        assertPreviewPath(root, current.abs);
        if (!sameStatIdentity(before, fs.lstatSync(current.abs))) throw fail('unsafe_path');
        if (!hidden && entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) continue;
        const rel = current.rel ? current.rel + '/' + entry.name : entry.name;
        const abs = path.join(current.abs, entry.name);
        let stat;
        try {
          assertPreviewPath(root, abs);
          stat = fs.lstatSync(abs);
        } catch { continue; } // disappeared/linked entries are never search results
        if (!stat.isDirectory() && !stat.isFile()) continue;
        if (stat.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        if (stat.isFile() && rel.toLocaleLowerCase().includes(wanted)) {
          entries.push({ name: entry.name, path: rel, type: stat.isDirectory() ? 'dir' : 'file', bytes: stat.isFile() ? stat.size : null });
          if (entries.length >= maxResults) { truncated = true; break; }
        }
        if (stat.isDirectory()) {
          if (current.depth >= maxDepth) { truncated = true; continue; }
          queue.push({ abs, rel, depth: current.depth + 1 });
        }
      }
      assertPreviewPath(root, current.abs);
      if (!sameStatIdentity(before, fs.lstatSync(current.abs))) throw fail('unsafe_path');
    } catch (error) {
      if (error?.code === 'unsafe_path') throw error;
      // Unreadable/missing directories give an explicitly incomplete search.
      truncated = true;
    } finally {
      if (dir) await dir.close().catch(() => {}); // only this traversal's handle
    }
    if (visited >= maxEntries || entries.length >= maxResults) break;
  }
  await assertAccess();
  entries.sort((a, b) => a.path.localeCompare(b.path, 'zh'));
  return { matches: entries, truncated, visited };
}
