/* P3-C acceptance regressions for the native connecting path:
 *   - cancellation before connect (killJob while still Connecting)
 *   - startup failure after the Job/pipes exist (CreateProcessW fails)
 * Both must release the Job/HPCON/pipes and leave a final, gone snapshot.
 * The module is then proven usable again with a fresh terminal.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const require = createRequire(path.join(repo, 'package.json'));
const faultAddon = process.env.P3C_TEST_RESUME_ADDON;
const addon = require(faultAddon || path.join(repo, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'));
const world = fs.mkdtempSync(path.join(os.tmpdir(), 'p3c-connect-'));
const resultsDir = path.join(here, 'results');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync(resultsDir, { recursive: true });

const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const env = [
  `SystemRoot=${process.env.SystemRoot || 'C:\\Windows'}`,
  `PATH=${process.env.SystemRoot || 'C:\\Windows'}\\System32;${process.env.SystemRoot || 'C:\\Windows'}`,
  'TERM=xterm-256color',
];

function startJobTerminal(file = shell) {
  const name = `p3c-connect-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const term = addon.startProcess(file, 80, 24, false, name, false, false, true);
  return term;
}

function connectTerm(term, commandline, cwd) {
  return new Promise((resolve) => {
    let fd = null;
    let sock = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { if (fd !== null) fs.closeSync(fd); } catch { /* closed by native */ }
      try { sock?.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    try {
      fd = fs.openSync(term.conin, 'w');
    } catch (error) {
      finish({ ok: false, stage: 'conin', error: String(error) });
      return;
    }
    sock = new net.Socket();
    sock.on('error', () => { /* native closes the server side */ });
    sock.connect(term.conout, () => {
      try {
        const pid = addon.connect(term.pty, commandline, cwd, env, false, true, () => {});
        finish({ ok: true, pid });
      } catch (error) {
        finish({ ok: false, stage: 'connect', error: String(error) });
      }
    });
    setTimeout(() => finish({ ok: false, stage: 'timeout' }), 10000).unref();
  });
}

const results = {};
try {
  results.supportsJobObject = addon.supportsJobObject();

  {
    const term = startJobTerminal();
    const cancelled = addon.killJob(term.pty);
    const outcome = await connectTerm(term, `${shell} /d /q`, world);
    results.connectingCancel = {
      cancelled,
      outcome,
      status: addon.jobStatus(term.pty),
    };
  }

  {
    /* The file must exist for startProcess to create the Job/pipes; it is not
     * a valid image, so CreateProcessW fails after those resources exist. */
    const missing = path.join(world, 'invalid.exe');
    fs.writeFileSync(missing, 'not a PE image');
    const term = startJobTerminal(missing);
    const outcome = await connectTerm(term, `"${missing}"`, world);
    try { fs.rmSync(missing, { force: true }); } catch { /* best effort */ }
    results.startupFailure = {
      outcome,
      status: addon.jobStatus(term.pty),
    };
  }

  if (faultAddon) {
    const term = startJobTerminal();
    process.env.P3C_TEST_RESUME_FAILURE = '1';
    try {
      const outcome = await connectTerm(term, `${shell} /d /q`, world);
      results.resumeFailure = { outcome, status: addon.jobStatus(term.pty) };
    } finally {
      delete process.env.P3C_TEST_RESUME_FAILURE;
    }
  }

  {
    const term = startJobTerminal();
    const outcome = await connectTerm(term, `${shell} /d /q`, world);
    results.recovery = { outcome, status: addon.jobStatus(term.pty) };
    if (outcome.ok) {
      addon.killJob(term.pty);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const status = addon.jobStatus(term.pty);
        if (status.gone || (status.final && status.activeProcesses === 0)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      results.recovery.afterKill = addon.jobStatus(term.pty);
    }
  }

  const cancelStatus = results.connectingCancel.status;
  const failStatus = results.startupFailure.status;
  const resumeFailure = results.resumeFailure;
  const resumeOk = !faultAddon || (resumeFailure.outcome.ok === false
    && /job_resume_failed/.test(resumeFailure.outcome.error || '')
    && resumeFailure.status.final === true && resumeFailure.status.shellExited === true
    && resumeFailure.status.resumeReturned === false && resumeFailure.status.ptyDisposed === true);
  const ok = resumeOk && results.supportsJobObject === true
    && results.connectingCancel.outcome.ok === false
    && /pty_aborted/.test(results.connectingCancel.outcome.error || '')
    && cancelStatus.final === true && cancelStatus.gone === true
    && cancelStatus.activeProcesses === 0
    && results.startupFailure.outcome.ok === false
    && /Cannot create process/.test(results.startupFailure.outcome.error || '')
    && failStatus.final === true && failStatus.gone === true
    && failStatus.activeProcesses === 0
    && results.recovery.outcome.ok === true
    && results.recovery.status.jobAssigned === true
    && results.recovery.afterKill?.ptyDisposed === true;

  const report = {
    test: 'p3c-local-connect-errors',
    os: { release: os.release(), version: os.version(), arch: process.arch },
    runtime: { node: process.versions.node },
    results,
    result: { ok },
  };
  const file = path.join(resultsDir, `p3c-local-connect-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  fs.rmSync(world, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
