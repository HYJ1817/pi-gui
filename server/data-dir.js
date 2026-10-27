import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Standard user data directory for pi-gui outside repository/project trees.
 * - Windows: %APPDATA%\pi-gui
 * - macOS: ~/Library/Application Support/pi-gui
 * - Linux / POSIX: $XDG_DATA_HOME/pi-gui or ~/.local/share/pi-gui
 */
export function defaultDataDir(env = process.env) {
  if (env.PI_GUI_DATA) return path.resolve(env.PI_GUI_DATA);
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pi-gui');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'pi-gui');
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'pi-gui');
}

/**
 * Resolves the active data directory, ensuring the directory exists and
 * safely migrating legacy data from appRoot (if present) to prevent data loss.
 */
export function resolveDataDir({ env = process.env, appRoot, io = fs } = {}) {
  const explicit = env.PI_GUI_DATA;
  if (explicit) {
    const resolved = path.resolve(explicit);
    try { io.mkdirSync(resolved, { recursive: true, mode: 0o700 }); } catch {}
    return resolved;
  }
  const targetDir = defaultDataDir(env);
  try { io.mkdirSync(targetDir, { recursive: true, mode: 0o700 }); } catch {}
  if (appRoot && path.resolve(appRoot) !== path.resolve(targetDir)) {
    migrateLegacyData({ sourceDir: appRoot, targetDir, io });
  }
  return targetDir;
}

/**
 * Safely migrates legacy standalone data files and directories from the repository root
 * to the independent data directory. Never overwrites existing destination data.
 */
export function migrateLegacyData({ sourceDir, targetDir, io = fs } = {}) {
  if (!sourceDir || !targetDir) return;
  const srcRoot = path.resolve(sourceDir);
  const dstRoot = path.resolve(targetDir);
  if (srcRoot === dstRoot) return;
  if (!io.existsSync(srcRoot)) return;
  try { io.mkdirSync(dstRoot, { recursive: true, mode: 0o700 }); } catch {}

  const legacyEntries = [
    'projects.json',
    'session-flags.json',
    'plans',
    'planner-sessions',
    'trash-sessions',
    'collab',
    'review-comments',
    'review-evidence',
    'candidate-runs',
    'uploads',
  ];

  for (const name of legacyEntries) {
    const src = path.join(srcRoot, name);
    const dst = path.join(dstRoot, name);
    try {
      if (!io.existsSync(src)) continue;
      if (io.existsSync(dst)) continue; // Keep destination data authoritative; do not overwrite
      const stat = io.lstatSync(src);
      if (stat.isSymbolicLink()) continue; // Do not follow or migrate symlinks
      if (stat.isDirectory()) {
        io.cpSync(src, dst, { recursive: true, errorOnExist: false });
      } else if (stat.isFile()) {
        io.copyFileSync(src, dst);
      }
    } catch {
      // Non-fatal migration failure, preserve runtime stability
    }
  }
}
