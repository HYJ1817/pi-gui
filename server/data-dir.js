import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Detects the execution shape of the application.
 * Returns: 'electron' | 'portable-sea' | 'source-web'
 */
export function detectExecutionMode({ env = process.env, execPath = process.execPath } = {}) {
  if (Boolean(process.versions?.electron) || Boolean(env.ELECTRON_RUN_AS_NODE)) {
    return 'electron';
  }
  const isExe = process.platform === 'win32' && path.basename(execPath).toLowerCase() === 'pi gui.exe';
  if (Boolean(process.versions?.sea) || Boolean(env.PI_GUI_PORTABLE === '1') || Boolean(env.PI_GUI_EXE === '1') || isExe) {
    return 'portable-sea';
  }
  return 'source-web';
}

/**
 * Standard user data directory for pi-gui.
 * - Explicit env.PI_GUI_DATA is always authoritative.
 * - Portable SEA: preserves access to existing portable data directory if present.
 * - Source Web / Default: standard platform user application data directory outside repository trees:
 *   - Windows: %APPDATA%\pi-gui
 *   - macOS: ~/Library/Application Support/pi-gui
 *   - Linux / POSIX: $XDG_DATA_HOME/pi-gui or ~/.local/share/pi-gui
 */
export function defaultDataDir({ env = process.env, appRoot = null, execPath = process.execPath, io = fs } = {}) {
  if (env.PI_GUI_DATA) return path.resolve(env.PI_GUI_DATA);

  const mode = detectExecutionMode({ env, execPath });
  if (mode === 'portable-sea') {
    const exeDir = path.dirname(path.resolve(execPath));
    const isRepoBuild = appRoot && path.resolve(exeDir).startsWith(path.resolve(appRoot));
    if (!isRepoBuild) {
      // Check for legacy portable data adjacent to exe
      const exeDataDir = path.join(exeDir, 'data');
      if (io.existsSync(path.join(exeDir, 'projects.json'))) {
        return exeDir;
      }
      if (io.existsSync(path.join(exeDataDir, 'projects.json'))) {
        return exeDataDir;
      }
      if (env.PI_GUI_PORTABLE === '1') {
        return exeDataDir;
      }
    }
  }

  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'pi-gui');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'pi-gui');
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'pi-gui');
}

/**
 * Validates path security between source and destination directories.
 */
function validatePathSafety(srcRoot, dstRoot) {
  if (typeof srcRoot !== 'string' || typeof dstRoot !== 'string') {
    throw new Error('invalid_path_type');
  }
  if (srcRoot.includes('\0') || dstRoot.includes('\0')) {
    throw new Error('nul_byte_detected');
  }
  const resolvedSrc = path.resolve(srcRoot);
  const resolvedDst = path.resolve(dstRoot);
  if (resolvedSrc === resolvedDst) {
    throw new Error('source_and_destination_identical');
  }
  // Prevent destination from being inside source or source inside destination
  const srcPrefix = resolvedSrc.endsWith(path.sep) ? resolvedSrc : resolvedSrc + path.sep;
  const dstPrefix = resolvedDst.endsWith(path.sep) ? resolvedDst : resolvedDst + path.sep;
  if (resolvedDst.startsWith(srcPrefix) || resolvedSrc.startsWith(dstPrefix)) {
    throw new Error('nested_path_prohibited');
  }
  return { src: resolvedSrc, dst: resolvedDst };
}

/**
 * Safely copies a directory recursively, skipping any symlinks or non-regular items.
 */
function safeCopyDirRecursively(srcDir, dstDir, io) {
  io.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
  const entries = io.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = path.join(srcDir, entry.name);
    const dstChild = path.join(dstDir, entry.name);
    if (entry.isSymbolicLink()) {
      // Never follow symlinks for security
      continue;
    }
    if (entry.isDirectory()) {
      safeCopyDirRecursively(srcChild, dstChild, io);
    } else if (entry.isFile()) {
      io.copyFileSync(srcChild, dstChild);
    }
  }
}

/**
 * Safely migrates legacy standalone data files and directories from the repository root
 * to the independent data directory.
 * - Atomic: uses staging directories/files before final commit so partial copies never look complete.
 * - Idempotent: safe to run multiple times or after interruption.
 * - Non-destructive: never overwrites existing target data, never deletes source data.
 * - Symlink-safe: rejects symlinks.
 * - Transparent: returns complete migration ledger with sanitized error reporting.
 */
export function migrateLegacyData({ sourceDir, targetDir, io = fs, log = () => {} } = {}) {
  const report = {
    ok: true,
    migrated: [],
    skipped: [],
    errors: [],
  };

  if (!sourceDir || !targetDir) return report;

  let safePaths;
  try {
    safePaths = validatePathSafety(sourceDir, targetDir);
  } catch (err) {
    report.ok = false;
    report.errors.push({ entry: '*', code: err.message || 'path_validation_failed', message: 'Path validation failed' });
    return report;
  }

  const { src: srcRoot, dst: dstRoot } = safePaths;
  if (!io.existsSync(srcRoot)) return report;

  try {
    io.mkdirSync(dstRoot, { recursive: true, mode: 0o700 });
  } catch (err) {
    report.ok = false;
    report.errors.push({ entry: '*', code: 'target_mkdir_failed', message: 'Cannot create target directory' });
    return report;
  }

  // Clean up any dangling staging folders from previous interrupted runs
  try {
    const existingTargetFiles = io.readdirSync(dstRoot);
    for (const file of existingTargetFiles) {
      if (file.startsWith('.stage-')) {
        const stagePath = path.join(dstRoot, file);
        try {
          const st = io.lstatSync(stagePath);
          if (st.isDirectory()) io.rmSync(stagePath, { recursive: true, force: true });
          else io.unlinkSync(stagePath);
        } catch {}
      }
    }
  } catch {}

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
    'diff-comments',
  ];

  for (const name of legacyEntries) {
    const src = path.join(srcRoot, name);
    const dst = path.join(dstRoot, name);

    try {
      if (!io.existsSync(src)) continue;

      const stat = io.lstatSync(src);
      if (stat.isSymbolicLink()) {
        report.skipped.push({ entry: name, reason: 'symlink_rejected' });
        continue;
      }

      // If destination already exists, DO NOT OVERWRITE and DO NOT SILENTLY MERGE
      if (io.existsSync(dst)) {
        report.skipped.push({ entry: name, reason: 'already_exists' });
        continue;
      }

      const stageDst = path.join(dstRoot, `.stage-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

      if (stat.isFile()) {
        try {
          io.copyFileSync(src, stageDst);
          io.renameSync(stageDst, dst);
          report.migrated.push(name);
        } catch (copyErr) {
          try { if (io.existsSync(stageDst)) io.unlinkSync(stageDst); } catch {}
          throw copyErr;
        }
      } else if (stat.isDirectory()) {
        try {
          safeCopyDirRecursively(src, stageDst, io);
          io.renameSync(stageDst, dst);
          report.migrated.push(name);
        } catch (copyErr) {
          try { if (io.existsSync(stageDst)) io.rmSync(stageDst, { recursive: true, force: true }); } catch {}
          throw copyErr;
        }
      }
    } catch (entryErr) {
      report.ok = false;
      const code = entryErr.code || 'entry_migration_failed';
      report.errors.push({ entry: name, code, message: `Failed to migrate ${name}` });
      try { log('data_migration_error', { entry: name, code }); } catch {}
    }
  }

  // Record migration manifest if any migration was performed or attempted
  if (report.migrated.length > 0 || report.errors.length > 0) {
    try {
      const manifestPath = path.join(dstRoot, '.migration-manifest.json');
      const manifest = {
        updatedAt: new Date().toISOString(),
        migrated: report.migrated,
        skipped: report.skipped,
        errors: report.errors,
      };
      io.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    } catch {}
  }

  return report;
}

/**
 * Resolves the active data directory.
 * - Explicit env.PI_GUI_DATA is authoritative and NEVER auto-migrated into.
 * - In default mode, ensures safe independent data directory and performs safe migration from appRoot.
 */
export function resolveDataDir({ env = process.env, appRoot, execPath = process.execPath, io = fs, log = () => {} } = {}) {
  const explicit = env.PI_GUI_DATA;
  if (explicit) {
    const resolved = path.resolve(explicit);
    try { io.mkdirSync(resolved, { recursive: true, mode: 0o700 }); } catch {}
    return resolved;
  }

  const targetDir = defaultDataDir({ env, appRoot, execPath, io });
  try { io.mkdirSync(targetDir, { recursive: true, mode: 0o700 }); } catch {}

  if (appRoot && path.resolve(appRoot) !== path.resolve(targetDir)) {
    migrateLegacyData({ sourceDir: appRoot, targetDir, io, log });
  }

  return targetDir;
}
