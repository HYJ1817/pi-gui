'use strict';

/* Windows process identity is (pid, creation time, image path), not the pid.
 *
 * taskkill /T and node-pty's pty.kill() both address the shell by a bare pid.
 * Once the shell exits that pid can be reused by an unrelated process; a late
 * kill then terminates the wrong tree. This module captures the identity of
 * the shell right after spawn and re-queries it before every kill.
 *
 * The re-query is still a check-then-act sequence: the process can exit and
 * its pid be reused between the query and taskkill. This narrows the window,
 * it does not eliminate the race. See
 * docs/terminal-p3-process-termination-design.md.
 *
 * FILETIME is kept as a decimal string. It is ~1.3e17 at current dates, well
 * above Number.MAX_SAFE_INTEGER, so converting it to a JS number would lose
 * the precision the comparison depends on. It is never logged or persisted.
 */

const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const DEFAULT_QUERY_TIMEOUT_MS = 2500;

function windowsPowerShellPath(env = process.env) {
  const root = typeof env.SystemRoot === 'string' && path.isAbsolute(env.SystemRoot)
    ? env.SystemRoot
    : 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

/* Windows paths are case-insensitive and accept both separators. Reduce both
 * sides to the same form before comparing; never use the normalized value as
 * a path to execute. */
function normalizeImagePath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return path.win32.normalize(value.trim()).replace(/[\\/]+$/, '').toLowerCase();
}

/* One line of `CreationTimeUtc|ImagePath`. Warns or banners from PowerShell
 * would make this unparseable; the caller treats that as "unknown" rather
 * than silently deciding the process is gone. */
function parseIdentityOutput(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^\s*(\d{10,20})\|(.*)$/.exec(line);
    if (match) return { creationTimeUtc: match[1], imagePath: match[2].trim() };
  }
  return null;
}

function queryScript(pid) {
  return [
    "$ErrorActionPreference='Stop'",
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop`,
    'if ($null -eq $p) { exit 3 }',
    "$t = ([datetime]$p.CreationDate).ToUniversalTime().ToFileTimeUtc()",
    "Write-Output ('{0}|{1}' -f $t, [string]$p.ExecutablePath)",
  ].join('; ');
}

function queryArgs(pid) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', queryScript(pid)];
}

/* `state` is one of:
 *   found   — pid exists; creationTimeUtc + imagePath are available
 *   gone    — no process with that pid
 *   missing — the caller gave no usable pid
 *   unknown — the probe failed, timed out or produced unusable output
 * Only `found` can take part in an identity comparison. Everything else must
 * fail closed at the kill site. */
function queryProcessIdentity(pid, options = {}) {
  const env = options.env || process.env;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_QUERY_TIMEOUT_MS;
  const run = typeof options.execFile === 'function' ? options.execFile : execFile;
  return new Promise((resolve) => {
    if (!validPid(pid)) return resolve({ state: 'missing' });
    try {
      run(windowsPowerShellPath(env), queryArgs(pid), {
        windowsHide: true,
        timeout,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }, (error, stdout) => {
        if (error) {
          if (error.code === 3 || error.status === 3) return resolve({ state: 'gone' });
          return resolve({
            state: 'unknown',
            reason: error.code === 'ENOENT' ? 'powershell_missing' : 'query_failed',
          });
        }
        const text = String(stdout || '');
        /* A successful exit with no output is not proof the process is gone:
         * only `exit 3` (handled above) is. Treat an empty/unparseable probe
         * as unknown so a broken PowerShell can never look like a clean exit. */
        if (!text.trim()) return resolve({ state: 'unknown', reason: 'empty_output' });
        const parsed = parseIdentityOutput(text);
        if (!parsed) return resolve({ state: 'unknown', reason: 'unparseable_output' });
        resolve({ state: 'found', ...parsed });
      });
    } catch {
      resolve({ state: 'unknown', reason: 'query_threw' });
    }
  });
}

/* Synchronous variant for the Electron quit path, which cannot await. The
 * query has its own timeout; a timeout is `unknown` and therefore no kill. */
function queryProcessIdentitySync(pid, options = {}) {
  const env = options.env || process.env;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_QUERY_TIMEOUT_MS;
  const run = typeof options.execFileSync === 'function' ? options.execFileSync : execFileSync;
  if (!validPid(pid)) return { state: 'missing' };
  try {
    const stdout = run(windowsPowerShellPath(env), queryArgs(pid), {
      windowsHide: true,
      timeout,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const text = String(stdout || '');
    if (!text.trim()) return { state: 'unknown', reason: 'empty_output' };
    const parsed = parseIdentityOutput(text);
    if (!parsed) return { state: 'unknown', reason: 'unparseable_output' };
    return { state: 'found', ...parsed };
  } catch (error) {
    if (error.status === 3 || error.code === 3) return { state: 'gone' };
    return { state: 'unknown', reason: error.code === 'ENOENT' ? 'powershell_missing' : 'query_failed' };
  }
}

/* Capture is probabilistic in one direction only: a process found under the
 * spawned pid whose image is not the shell we asked for is not the shell
 * (its pid was already reused, or the query raced). Treat that as unknown,
 * never as that process's identity. */
async function captureProcessIdentity(pid, expectedImagePath, options = {}) {
  const current = await queryProcessIdentity(pid, options);
  if (current.state !== 'found') {
    return { state: 'unknown', reason: current.reason || current.state };
  }
  const expected = normalizeImagePath(expectedImagePath);
  if (!expected || normalizeImagePath(current.imagePath) !== expected) {
    return { state: 'unknown', reason: 'image_mismatch' };
  }
  return {
    state: 'captured',
    pid,
    creationTimeUtc: current.creationTimeUtc,
    imagePath: expected,
  };
}

/* match     — current pid still is the process captured at spawn
 * gone      — no process under that pid now
 * mismatch  — pid exists but creation time or image differs: do not kill
 * unknown   — not enough information: do not kill */
function classifyProcessIdentity(expected, current) {
  if (!expected || expected.state !== 'captured') return 'unknown';
  if (!current || current.state === 'missing' || current.state === 'gone') return 'gone';
  if (current.state !== 'found') return 'unknown';
  if (String(expected.creationTimeUtc) !== String(current.creationTimeUtc)) return 'mismatch';
  const expectedImage = normalizeImagePath(expected.imagePath);
  if (!expectedImage || normalizeImagePath(current.imagePath) !== expectedImage) return 'mismatch';
  return 'match';
}

module.exports = {
  DEFAULT_QUERY_TIMEOUT_MS,
  windowsPowerShellPath,
  normalizeImagePath,
  parseIdentityOutput,
  queryProcessIdentity,
  queryProcessIdentitySync,
  captureProcessIdentity,
  classifyProcessIdentity,
};
