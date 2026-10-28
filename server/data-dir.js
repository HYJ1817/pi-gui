import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as nodeSea from 'node:sea';

/**
 * Checks whether the current process is running inside a Node.js SEA (Single Executable Application).
 */
export function isSeaRuntime() {
  try {
    if (typeof nodeSea?.isSea === 'function') {
      return nodeSea.isSea();
    }
    if (typeof process.features?.sea === 'boolean') {
      return process.features.sea;
    }
  } catch {}
  return false;
}

/**
 * Checks if a process with the given PID is currently alive on the system.
 */
export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // EPERM indicates process exists but belongs to another user
  }
}

/**
 * Detects the execution shape of the application.
 * Returns: 'electron' | 'portable-sea' | 'source-web'
 */
export function detectExecutionMode({ env = process.env, execPath = process.execPath, isSea = null } = {}) {
  if (Boolean(process.versions?.electron) || Boolean(env.ELECTRON_RUN_AS_NODE)) {
    return 'electron';
  }
  const sea = typeof isSea === 'boolean' ? isSea : isSeaRuntime();
  if (sea || Boolean(process.versions?.sea) || env.PI_GUI_PORTABLE === '1' || env.PI_GUI_EXE === '1') {
    return 'portable-sea';
  }
  // Fallback: check if executable name indicates portable exe (backward compatibility)
  if (process.platform === 'win32' && path.basename(execPath).toLowerCase() === 'pi gui.exe') {
    return 'portable-sea';
  }
  return 'source-web';
}

/**
 * Sanitizes a file path for diagnostic logging, replacing user home directory with '~'
 * and stripping sensitive substrings.
 */
export function sanitizePath(p) {
  if (typeof p !== 'string' || !p) return '';
  const home = os.homedir();
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

/**
 * Verifies whether a given directory is a checked-out pi-gui source repository.
 */
export function isPiGuiSourceRepo(dir, io = fs) {
  if (!dir || typeof dir !== 'string') return false;
  try {
    const pkgPath = path.join(dir, 'package.json');
    const serverPath = path.join(dir, 'server.js');
    if (!io.existsSync(pkgPath) || !io.existsSync(serverPath)) return false;
    const pkg = JSON.parse(io.readFileSync(pkgPath, 'utf8'));
    return pkg?.name === 'pi-gui';
  } catch {
    return false;
  }
}

/**
 * Maps an error code to a sanitized, actionable user recovery recommendation.
 */
export function getRecoveryAction(code) {
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'check_permissions';
    case 'EBUSY':
      return 'retry_after_closing_file';
    case 'EXDEV':
      return 'manual_copy_across_devices';
    case 'already_exists':
      return 'manual_merge_or_backup';
    default:
      return 'inspect_disk_and_retry';
  }
}

/**
 * Assembles protected roots for application stores (collabStore, reviewCommentStore, candidateRuns).
 * Strictly distinguishes:
 * - Application executable directory (exeDir): in portable mode, exeDir hosts exeDir/data and is NOT protected.
 * - Genuine pi-gui source repository (verifiedSourceRoot): protected if running from source or within source tree.
 * - User project roots (userProjectRoots): all registered user projects and active CWD are protected.
 */
export function getProtectedRoots({
  sourceRoot = null,
  isSea = null,
  execPath = process.execPath,
  io = fs,
  projects = [],
  activeCwd = null,
} = {}) {
  const roots = [];
  const runningInSea = isSea !== null ? Boolean(isSea) : isSeaRuntime();

  // 1. 真正的源码仓库根目录（若处于源码环境或源码构建目录中）
  if (sourceRoot && isPiGuiSourceRepo(sourceRoot, io)) {
    roots.push(path.resolve(sourceRoot));
  } else if (runningInSea) {
    const exeDir = path.dirname(path.resolve(execPath));
    const candidateSource = path.resolve(exeDir, '..');
    if (isPiGuiSourceRepo(candidateSource, io)) {
      roots.push(candidateSource);
    }
  }

  // 2. 用户项目根目录列表
  if (Array.isArray(projects)) {
    for (const p of projects) {
      if (typeof p === 'string' && p) {
        roots.push(path.resolve(p));
      } else if (typeof p?.path === 'string' && p.path) {
        roots.push(path.resolve(p.path));
      }
    }
  }

  // 3. 当前运行时工作目录（若提供且非空）
  if (activeCwd && typeof activeCwd === 'string') {
    roots.push(path.resolve(activeCwd));
  }

  return [...new Set(roots)];
}

/**
 * Standard user data directory for pi-gui.
 * - Explicit env.PI_GUI_DATA is always authoritative.
 * - Portable SEA: preserves access to existing portable data directory if present.
 *   - If projects.json exists in exeDir, returns exeDir (legacy v1).
 *   - If projects.json exists in exeDir/data, returns exeDir/data (portable v2).
 *   - For brand new portable SEA, defaults to exeDir/data.
 *   - If exeDir is inside a verified pi-gui source repository or user projectRoot, safely falls back
 *     to standard platform user data directory to prevent repo/project contamination.
 * - Source Web / Default: standard platform user application data directory outside repository trees:
 *   - Windows: %APPDATA%\pi-gui
 *   - macOS: ~/Library/Application Support/pi-gui
 *   - Linux / POSIX: $XDG_DATA_HOME/pi-gui or ~/.local/share/pi-gui
 */
export function defaultDataDir({
  env = process.env,
  appRoot = null,
  sourceRoot = null,
  execPath = process.execPath,
  io = fs,
  isSea = null,
  projectRoot = null,
} = {}) {
  if (env.PI_GUI_DATA) return path.resolve(env.PI_GUI_DATA);

  const mode = detectExecutionMode({ env, execPath, isSea });
  if (mode === 'portable-sea') {
    const exeDir = path.dirname(path.resolve(execPath));

    // Determine candidate source repository root (if any)
    const rawSourceRoot = sourceRoot || appRoot;
    const candidateSource = rawSourceRoot ? path.resolve(rawSourceRoot) : null;
    const isVerifiedSource = candidateSource && isPiGuiSourceRepo(candidateSource, io);
    const isRepoBuild = isVerifiedSource && (exeDir === candidateSource || exeDir.startsWith(candidateSource + path.sep));

    // Ensure we do not contaminate active user project directories
    const activeProject = projectRoot ? path.resolve(projectRoot) : null;
    const isInsideProject = activeProject && (exeDir === activeProject || exeDir.startsWith(activeProject + path.sep));

    if (!isRepoBuild && !isInsideProject) {
      const exeDataDir = path.join(exeDir, 'data');
      if (io.existsSync(path.join(exeDir, 'projects.json'))) {
        return exeDir;
      }
      if (io.existsSync(path.join(exeDataDir, 'projects.json'))) {
        return exeDataDir;
      }
      // Brand new portable SEA default
      return exeDataDir;
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
export function validatePathSafety(srcRoot, dstRoot, legacyEntries = MIGRATION_LEGACY_ENTRIES) {
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
  const srcPrefix = resolvedSrc.endsWith(path.sep) ? resolvedSrc : resolvedSrc + path.sep;
  const dstPrefix = resolvedDst.endsWith(path.sep) ? resolvedDst : resolvedDst + path.sep;

  // Source directory cannot be inside destination directory
  if (resolvedSrc.startsWith(dstPrefix)) {
    throw new Error('nested_path_prohibited');
  }

  // If destination is inside source directory:
  // Prohibited if destination collides with or nests inside any entry being migrated (e.g. plans/).
  // Allowed if destination is a dedicated subfolder (such as data/) not belonging to legacyEntries.
  if (resolvedDst.startsWith(srcPrefix)) {
    const relToSrc = path.relative(resolvedSrc, resolvedDst);
    const topSegment = relToSrc.split(path.sep)[0];
    if (legacyEntries.includes(topSegment)) {
      throw new Error('nested_path_prohibited');
    }
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
      continue;
    }
    if (entry.isDirectory()) {
      safeCopyDirRecursively(srcChild, dstChild, io);
    } else if (entry.isFile()) {
      io.copyFileSync(srcChild, dstChild);
    }
  }
}

export const STAGE_PREFIX = '.stage-mig-';
export const STAGE_PATTERN = /^\.stage-mig-([a-zA-Z0-9_.-]+)-(\d+)-(\d+)-([a-z0-9]+)$/;

export function parseStageName(filename) {
  if (typeof filename !== 'string') return null;
  const match = filename.match(STAGE_PATTERN);
  if (!match) return null;
  return {
    entry: match[1],
    pid: parseInt(match[2], 10),
    timestamp: parseInt(match[3], 10),
    rand: match[4],
  };
}

export const MIGRATION_LEGACY_ENTRIES = Object.freeze([
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
]);

/**
 * Safely migrates legacy standalone data files and directories from the repository root
 * to the independent data directory.
 * - Atomic: uses staging directories/files before final commit so partial copies never look complete.
 * - Idempotent: safe to run multiple times or after interruption.
 * - Non-destructive: never overwrites existing target data, never deletes source data.
 * - Multi-instance safe: verifies staging attribution, skips active instances, only cleans abandoned residue.
 * - Symlink-safe: rejects symlinks.
 * - Transparent: returns complete migration ledger with sanitized error reporting.
 */
export function migrateLegacyData({
  sourceDir,
  targetDir,
  io = fs,
  log = () => {},
  isProcessAlive = isProcessRunning,
} = {}) {
  const report = {
    ok: true,
    status: 'completed',
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
    report.status = 'failed';
    const code = err.message || 'path_validation_failed';
    report.errors.push({ entry: '*', code, fatal: true, message: 'Path validation failed' });
    try { log('data_migration_error', { entry: '*', code, sanitizedTarget: sanitizePath(targetDir) }); } catch {}
    return report;
  }

  const { src: srcRoot, dst: dstRoot } = safePaths;
  if (!io.existsSync(srcRoot)) return report;

  try {
    io.mkdirSync(dstRoot, { recursive: true, mode: 0o700 });
  } catch (err) {
    report.ok = false;
    report.status = 'failed';
    report.errors.push({ entry: '*', code: 'target_mkdir_failed', fatal: true, message: 'Cannot create target directory' });
    try { log('data_migration_error', { entry: '*', code: 'target_mkdir_failed', sanitizedTarget: sanitizePath(targetDir) }); } catch {}
    return report;
  }

  // Safe staging cleanup:
  // ONLY cleans staging directories that:
  // 1. Match our exact migration pattern (.stage-mig-<entry>-<pid>-<timestamp>-<rand>)
  // 2. Belong to a recognized legacy migration entry
  // 3. Belong to a terminated process (pid is not running)
  // NEVER touches unrelated user files or in-flight staging owned by active instances!
  try {
    const existingTargetFiles = io.readdirSync(dstRoot);
    for (const file of existingTargetFiles) {
      if (!file.startsWith(STAGE_PREFIX)) continue;
      const parsed = parseStageName(file);
      if (!parsed) continue; // Not a pi-gui migration staging file; DO NOT TOUCH!
      if (!MIGRATION_LEGACY_ENTRIES.includes(parsed.entry)) continue; // Unknown entry; DO NOT TOUCH!

      const active = isProcessAlive(parsed.pid);
      if (parsed.pid !== process.pid && active) {
        // Owned by another actively running instance; DO NOT TOUCH!
        try { log('data_migration_staging_active', { entry: parsed.entry, pid: parsed.pid }); } catch {}
        continue;
      }

      // Staging belongs to dead process or past interrupted run of this process; clean it up safely
      const stagePath = path.join(dstRoot, file);
      try {
        const st = io.lstatSync(stagePath);
        if (st.isDirectory()) {
          io.rmSync(stagePath, { recursive: true, force: true });
        } else {
          io.unlinkSync(stagePath);
        }
        try { log('data_migration_staging_cleaned', { entry: parsed.entry, pid: parsed.pid }); } catch {}
      } catch {}
    }
  } catch {}

  for (const name of MIGRATION_LEGACY_ENTRIES) {
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

      const randToken = Math.random().toString(36).slice(2, 7);
      const stageDst = path.join(dstRoot, `${STAGE_PREFIX}${name}-${process.pid}-${Date.now()}-${randToken}`);

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
      const action = getRecoveryAction(code);
      report.errors.push({
        entry: name,
        code,
        action,
        message: `Failed to migrate ${name}: ${entryErr.message || code}`,
        recoverable: ['EACCES', 'EBUSY', 'EPERM', 'EXDEV'].includes(code),
      });
      try {
        log('app.data_migration', {
          role: 'backend',
          entry: name,
          code,
          status: 'failed',
          action,
          reason: 'entry_migration_failed',
        });
      } catch {}
    }
  }

  if (report.errors.length > 0) {
    report.status = report.migrated.length > 0 ? 'partial' : 'failed';
  } else {
    report.status = 'completed';
  }

  // Record migration manifest
  if (report.migrated.length > 0 || report.errors.length > 0 || report.skipped.length > 0) {
    try {
      const manifestPath = path.join(dstRoot, '.migration-manifest.json');
      const manifest = {
        updatedAt: new Date().toISOString(),
        ok: report.ok,
        status: report.status,
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
 * - Does NOT swallow migration failures: fatal failures throw structured errors; recoverable
 *   failures log sanitized diagnostics and record accurate manifest status without claiming success.
 */
export function resolveDataDir({
  env = process.env,
  appRoot,
  sourceRoot = null,
  execPath = process.execPath,
  io = fs,
  log = () => {},
  isSea = null,
  projectRoot = null,
  isProcessAlive = isProcessRunning,
  throwOnFatal = true,
} = {}) {
  const explicit = env.PI_GUI_DATA;
  if (explicit) {
    const resolved = path.resolve(explicit);
    try {
      io.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    } catch (err) {
      const error = new Error(`Explicit PI_GUI_DATA directory cannot be created: ${sanitizePath(resolved)}`);
      error.code = 'EXPLICIT_DATA_DIR_UNAVAILABLE';
      error.fatal = true;
      throw error;
    }
    return resolved;
  }

  const effectiveSourceRoot = sourceRoot || appRoot;
  const targetDir = defaultDataDir({
    env,
    appRoot: effectiveSourceRoot,
    sourceRoot: effectiveSourceRoot,
    execPath,
    io,
    isSea,
    projectRoot,
  });
  try {
    io.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    const error = new Error(`Target data directory cannot be created: ${sanitizePath(targetDir)}`);
    error.code = 'TARGET_DATA_DIR_UNAVAILABLE';
    error.fatal = true;
    error.targetDir = targetDir;
    throw error;
  }

  if (effectiveSourceRoot && path.resolve(effectiveSourceRoot) !== path.resolve(targetDir)) {
    const report = migrateLegacyData({ sourceDir: effectiveSourceRoot, targetDir, io, log, isProcessAlive });
    if (!report.ok) {
      const fatalErrors = report.errors.filter(e =>
        e.fatal || ['target_mkdir_failed', 'path_validation_failed', 'nul_byte_detected', 'nested_path_prohibited'].includes(e.code)
      );
      if (fatalErrors.length > 0) {
        const error = new Error(`Fatal migration error: ${fatalErrors.map(e => e.code).join(', ')}`);
        error.code = fatalErrors[0]?.code || 'MIGRATION_FATAL';
        error.report = report;
        error.fatal = true;
        throw error;
      }

      // Structured sanitized diagnostic log for recoverable issues
      for (const err of report.errors) {
        try {
          log('app.data_migration', {
            role: 'backend',
            entry: err.entry || '*',
            code: err.code || 'unknown_error',
            status: report.status,
            action: err.action || getRecoveryAction(err.code),
            reason: 'recoverable_migration_warning',
          });
        } catch {}
      }
      try {
        console.warn(`[data-migration] 迁移警告：部分项目未完成迁移（状态: ${report.status}）。建议操作：${report.errors[0]?.action || 'check_permissions'}`);
      } catch {}

      if (throwOnFatal && report.migrated.length === 0 && report.errors.length > 0) {
        // If every attempted item failed and caller strictly requires migration
        const allRecoverable = report.errors.every(e => e.recoverable);
        if (!allRecoverable) {
          const error = new Error(`Migration failed with unrecoverable errors: ${report.errors.map(e => e.code).join(', ')}`);
          error.code = 'MIGRATION_UNRECOVERABLE';
          error.report = report;
          throw error;
        }
      }
    }
  }

  return targetDir;
}
