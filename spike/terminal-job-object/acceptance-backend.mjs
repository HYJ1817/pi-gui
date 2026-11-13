/* P3-C local acceptance: real backend + real ConPTY Job mode.
 *
 * Drives the production backend (server/terminal.js) exactly as the HTTP
 * routes do, with two terminals in one temporary workspace. Each terminal
 * starts a long-running fixture child. One terminal is stopped, the other is
 * closed, and both shell+child are confirmed gone through handles opened
 * *before* the action (win32-spike.exe watch-child).
 *
 * Usage (from the repo root):
 *   PI_GUI_TERMINAL_JOB_OBJECT=1 node spike/terminal-job-object/acceptance-backend.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const exe = path.join(here, 'win32-spike.exe');
const resultsDir = path.join(here, 'results');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (process.env.PI_GUI_TERMINAL_JOB_OBJECT !== '1') {
  throw new Error('set PI_GUI_TERMINAL_JOB_OBJECT=1 for this acceptance run');
}
if (!fs.existsSync(exe)) throw new Error(`missing fixture: ${exe}`);
fs.mkdirSync(resultsDir, { recursive: true });

const world = fs.mkdtempSync(path.join(here, '.tmp', `accept-${process.pid}-`));
const workspace = path.join(world, 'project');
fs.mkdirSync(workspace, { recursive: true });

const load = (file) => import(pathToFileURL(path.join(repo, 'server', file)).href);
const { createTerminal } = await load('terminal.js');
const { defaultSpawnPty, defaultKillPty, jobObjectEnabled } = await load('terminal-process.js');
const { createRouter } = await load('router.js');
const { createAuth } = await load('auth.js');

const token = 'p3c-local-acceptance';
const terminal = createTerminal({
  scopeForRequest: async () => ({ root: workspace, scopeId: 'p3c-local', generation: '1' }),
  enabled: true,
  spawnPty: defaultSpawnPty,
  killPty: defaultKillPty,
  platform: process.platform,
  env: process.env,
});

const server = http.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const auth = createAuth({ port, token });
server.on('request', createRouter({
  auth,
  sse: { subscribe() {} },
  rpc: { send() {}, abortAndWait() { return { ok: true }; }, getState() { return {}; }, restart() {} },
  files: { handle() { return false; } },
  terminal,
}));

async function request(body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/terminal`, {
    method: 'POST',
    headers: { 'x-pi-gui-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const t0 = Date.now();
const log = (step, extra = '') => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${step}${extra ? ' ' + extra : ''}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(25);
  }
  if (!fn()) throw new Error(`timeout: ${label}`);
  return true;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const countLines = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
};

function watcher(tag, pid) {
  const openFile = path.join(world, `${tag}-open.json`);
  const resultFile = path.join(world, `${tag}-result.json`);
  const child = spawn(exe, ['watch-child', '--pid', String(pid),
    '--open-out', openFile, '--out', resultFile, '--timeout', '30000'], { stdio: 'ignore' });
  // Attach now: a short-lived watcher may exit before done() is called.
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    tag,
    pid,
    openFile,
    resultFile,
    child,
    exited,
    async ready() { await waitFor(() => fs.existsSync(openFile), 10000, `${tag} open`); return readJson(openFile); },
    async done() { await exited; return readJson(resultFile); },
  };
}

const started = Date.now();
const report = {
  test: 'p3c-local-backend',
  os: { release: os.release(), version: os.version(), arch: process.arch },
  runtime: { node: process.versions.node, electron: process.versions.electron || null },
  switch: { jobObjectEnabled: jobObjectEnabled(process.env), env: process.env.PI_GUI_TERMINAL_JOB_OBJECT },
  workspace,
  terminals: [],
  result: {},
};

setTimeout(() => {
  console.error(`hard timeout at ${Date.now() - t0}ms`);
  process.exit(3);
}, 60000).unref();

try {
  log('create A');
  const createdA = await request({ action: 'create', cols: 100, rows: 30 });
  log('create B');
  const createdB = await request({ action: 'create', cols: 100, rows: 30 });
  log('created', `A=${createdA.status} B=${createdB.status}`);
  if (createdA.status !== 200 || createdB.status !== 200) {
    throw new Error(`create failed: ${JSON.stringify({ a: createdA, b: createdB })}`);
  }
  const a = { id: createdA.body.session.id, ...createdA.body.session };
  const b = { id: createdB.body.session.id, ...createdB.body.session };
  if (a.jobMode !== true || b.jobMode !== true) throw new Error('terminal did not enter Job mode');
  const sessionA = terminal._sessions.get(a.id);
  const sessionB = terminal._sessions.get(b.id);
  if (sessionA.pty.jobStatus().jobAssigned !== true) throw new Error('shell was not assigned to the Job');

  const markerA = `marker_a_${Date.now()}`;
  const markerB = `marker_b_${Date.now()}`;
  sessionA.pty.write(`Write-Output ${markerA}\r`);
  sessionB.pty.write(`Write-Output ${markerB}\r`);
  await waitFor(() => sessionA.output.includes(markerA) && sessionB.output.includes(markerB), 10000, 'shell markers');
  log('shell markers seen');

  const tickA = path.join(world, 'a.ticks');
  const tickB = path.join(world, 'b.ticks');
  const pidA = path.join(world, 'a.pid');
  const pidB = path.join(world, 'b.pid');
  const cmd = (tick, pid) => `& '${exe}' child --seconds 60 --tick-file '${tick}' --tick-ms 100 --pidfile '${pid}'`;
  sessionA.pty.write(`${cmd(tickA, pidA)}\r`);
  sessionB.pty.write(`${cmd(tickB, pidB)}\r`);
  await waitFor(() => fs.existsSync(pidA) && fs.existsSync(pidB), 10000, 'child pid files');
  await waitFor(() => countLines(tickA) >= 3 && countLines(tickB) >= 3, 10000, 'child ticks');
  log('child ticks', `A=${countLines(tickA)} B=${countLines(tickB)}`);

  const shellPidA = sessionA.pty.pid;
  const shellPidB = sessionB.pty.pid;
  const childPidA = Number(fs.readFileSync(pidA, 'utf8').trim());
  const childPidB = Number(fs.readFileSync(pidB, 'utf8').trim());
  const watchAShell = watcher('a-shell', shellPidA);
  const watchAChild = watcher('a-child', childPidA);
  const watchBShell = watcher('b-shell', shellPidB);
  const watchBChild = watcher('b-child', childPidB);
  await Promise.all([watchAShell.ready(), watchAChild.ready(), watchBShell.ready(), watchBChild.ready()]);
  const statusABefore = sessionA.pty.jobStatus();
  const statusBBefore = sessionB.pty.jobStatus();
  log('status before stop', JSON.stringify({ A: statusABefore.activeProcesses, B: statusBBefore.activeProcesses }));
  if (statusABefore.activeProcesses !== 2 || statusBBefore.activeProcesses !== 2) {
    throw new Error(`expected 2 processes per Job, got A=${statusABefore.activeProcesses} B=${statusBBefore.activeProcesses}`);
  }

  const aTicksBefore = countLines(tickA);
  const stopA = await request({ action: 'stop', id: a.id });
  if (stopA.status !== 200) throw new Error(`stop A failed: ${JSON.stringify(stopA)}`);
  log('stop A accepted');
  await waitFor(() => terminal._sessions.get(a.id)?.state === 'exited', 10000, 'A exited');
  log('A session exited', JSON.stringify(sessionA.pty.jobStatus()));
  const [aShellResult, aChildResult] = await Promise.all([watchAShell.done(), watchAChild.done()]);
  log('A watchers done', JSON.stringify({ shell: aShellResult, child: aChildResult }));
  const aTicksAfter = countLines(tickA);
  await sleep(400);
  if (countLines(tickA) !== aTicksAfter) throw new Error('A child kept ticking after stop');

  const bTicksBefore = countLines(tickB);
  await sleep(1200);
  const bTicksAfter = countLines(tickB);
  const statusBAlive = sessionB.pty.jobStatus();
  if (terminal._sessions.get(b.id)?.state !== 'running') throw new Error('B was affected by stopping A');
  if (!(bTicksAfter > bTicksBefore)) throw new Error(`B did not keep producing: ${bTicksBefore} -> ${bTicksAfter}`);
  if (statusBAlive.shellExited || statusBAlive.activeProcesses !== 2) {
    throw new Error(`B Job changed after A stop: ${JSON.stringify(statusBAlive)}`);
  }

  const closeB = await request({ action: 'close', id: b.id });
  if (closeB.status !== 200) throw new Error(`close B failed: ${JSON.stringify(closeB)}`);
  log('close B accepted');
  await waitFor(() => terminal._sessions.get(b.id)?.state === 'exited'
    || !terminal._sessions.has(b.id), 10000, 'B exited');
  log('B session exited', JSON.stringify(sessionB.pty.jobStatus()));
  const [bShellResult, bChildResult] = await Promise.all([watchBShell.done(), watchBChild.done()]);
  log('B watchers done', JSON.stringify({ shell: bShellResult, child: bChildResult }));
  const bTicksFinal = countLines(tickB);
  await sleep(400);
  if (countLines(tickB) !== bTicksFinal) throw new Error('B child kept ticking after close');

  const statusAAfter = sessionA.pty.jobStatus();
  const statusBAfter = sessionB.pty.jobStatus();
  report.terminals = [
    {
      id: a.id, entry: 'stop', shellPid: shellPidA, childPid: childPidA,
      shellExit: aShellResult, childExit: aChildResult,
      ticks: { before: aTicksBefore, after: aTicksAfter },
      before: statusABefore, after: statusAAfter,
      marker: sessionA.output.includes(markerA),
    },
    {
      id: b.id, entry: 'close', shellPid: shellPidB, childPid: childPidB,
      shellExit: bShellResult, childExit: bChildResult,
      ticks: { before: bTicksBefore, after: bTicksAfter, final: bTicksFinal },
      before: statusBBefore, after: statusBAfter,
      marker: sessionB.output.includes(markerB),
    },
  ];
  const ok = aShellResult.wait === 0 && aChildResult.wait === 0
    && bShellResult.wait === 0 && bChildResult.wait === 0
    && aTicksAfter === aTicksBefore && bTicksFinal === bTicksAfter
    && bTicksAfter > bTicksBefore
    && statusAAfter.ptyDisposed === true && statusBAfter.ptyDisposed === true
    && sessionA.output.includes(markerA) && sessionB.output.includes(markerB);
  report.result = {
    ok,
    elapsedMs: Date.now() - started,
    aTicksFrozen: aTicksAfter === aTicksBefore,
    bTicksBeforeStop: bTicksAfter > bTicksBefore,
    bStayedRunning: true,
  };
  const file = path.join(resultsDir, `p3c-local-backend-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ file, result: report.result, terminals: report.terminals.map((t) => ({
    entry: t.entry, shell: t.shellExit, child: t.childExit, before: t.before, after: t.after,
  })) }, null, 2));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error('acceptance failed:', error);
  process.exitCode = 1;
} finally {
  log('cleanup');
  await Promise.race([terminal.dispose().catch(() => {}), sleep(4000)]);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(world, { recursive: true, force: true });
  log('cleanup done');
  /* node-pty's ConoutConnection worker thread is not unref'd; exit explicitly
   * after the report is on disk instead of waiting for the hard-timeout. */
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
