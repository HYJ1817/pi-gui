/* P3-C acceptance: normal close keeps the output reader until EOF and the
 * trailing bytes survive both an explicit kill and a natural shell exit.
 *
 * Uses the production node-pty wrapper (patched windowsPtyAgent/WindowsTerminal)
 * with a real ConPTY Job-mode terminal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const require = createRequire(path.join(repo, 'package.json'));
const pty = require('node-pty');
const resultsDir = path.join(here, 'results');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync(resultsDir, { recursive: true });

const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'p3c-close-output-'));
const terms = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  throw new Error(`timeout: ${label}`);
}

function makeTerm() {
  const term = pty.spawn(shell, ['/d', '/q'], {
    cwd,
    env: process.env,
    cols: 100,
    rows: 30,
    useConpty: true,
    useJobObject: true,
  });
  const box = { term, data: '', exit: null, eof: false, eofAt: 0 };
  terms.push(term);
  term.onData((chunk) => { box.data += chunk; });
  term.onEof(() => { box.eof = true; box.eofAt = Date.now(); });
  term.onExit((event) => { box.exit = event; });
  return box;
}

async function caseKill() {
  const box = makeTerm();
  const marker = `tail_kill_${Date.now()}`;
  box.term.write(`echo ${marker}\r\n`);
  await waitFor(() => box.data.includes(marker), 10000, 'kill marker echo');
  const activeSince = Date.now();
  await sleep(15500);
  const activeAfterMs = Date.now() - activeSince;
  const live = box.term.jobStatus();
  if (box.exit || live.shellExited || live.ptyDisposed || live.activeProcesses !== 1) {
    throw new Error(`active terminal did not survive ${activeAfterMs} ms: ${JSON.stringify(live)}`);
  }
  const liveMarker = `alive_after_wait_${Date.now()}`;
  const separator = liveMarker.lastIndexOf('_') + 1;
  box.term.write(`echo ${liveMarker.slice(0, separator)}^${liveMarker.slice(separator)}\r\n`);
  await waitFor(() => box.data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').includes(liveMarker),
    5000, 'shell executed a command after the active wait');
  const before = box.term.jobStatus();
  const started = Date.now();
  let resizeCalls = 0;
  const resizeTimer = setInterval(() => {
    try {
      box.term.resize(80 + (resizeCalls % 10), 25);
      resizeCalls++;
    } catch {
      // The agent can reject resize after it receives the native exit.
    }
  }, 2);
  try {
    await waitFor(() => resizeCalls >= 3, 1000, 'resize before stop');
    box.term.kill();
    await waitFor(() => box.exit !== null && box.eof, 10000, 'kill exit+eof');
  } finally {
    clearInterval(resizeTimer);
  }
  const status = box.term.jobStatus();
  return {
    kind: 'kill',
    marker,
    markerSeen: box.data.includes(marker),
    activeAfterMs,
    liveMarker,
    resizeCalls,
    exit: box.exit,
    eof: box.eof,
    elapsedMs: Date.now() - started,
    before,
    after: status,
    bytes: box.data.length,
    tail: box.data.slice(-160),
  };
}

async function caseNatural() {
  const box = makeTerm();
  const marker = `tail_natural_${Date.now()}`;
  box.term.write(`echo ${marker}\r\n`);
  await waitFor(() => box.data.includes(marker), 10000, 'natural marker echo');
  const before = box.term.jobStatus();
  const started = Date.now();
  box.term.write('exit\r\n');
  await waitFor(() => box.exit !== null && box.eof, 10000, 'natural exit+eof');
  const status = box.term.jobStatus();
  return {
    kind: 'natural-exit',
    marker,
    markerSeen: box.data.includes(marker),
    exit: box.exit,
    eof: box.eof,
    elapsedMs: Date.now() - started,
    before,
    after: status,
    bytes: box.data.length,
    tail: box.data.slice(-160),
  };
}

const results = [];
try {
  results.push(await caseKill());
  results.push(await caseNatural());
  const ok = results.every((r) => r.markerSeen && r.eof && r.exit !== null
    && r.after.ptyDisposed === true && r.after.activeProcesses === 0
    && r.after.lostEvents === 0);
  const report = {
    test: 'p3c-local-close-output',
    os: { release: os.release(), version: os.version(), arch: process.arch },
    runtime: { node: process.versions.node },
    results,
    result: { ok },
  };
  const file = path.join(resultsDir, `p3c-local-close-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  // Even a failed assertion must retire its fixture shell before removing cwd.
  for (const term of terms) {
    if (term.jobStatus().ptyDisposed !== true) term.killJob();
  }
  await waitFor(() => terms.every((term) => term.jobStatus().ptyDisposed === true),
    5000, 'fixture terminal cleanup');
  try {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  } catch (error) {
    console.warn(`fixture cleanup: ${error.message}`);
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
