/* Worker-thread fixture: owns a Job-mode PTY, reports its pids, then waits to
 * be terminated. Worker teardown (not a kill path) must reclaim the tree. */
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('worker_threads');
const pty = require('../../node_modules/node-pty');

const { world, stateFile, tickFile, pidFile } = workerData;
const exe = path.join(__dirname, 'win32-spike.exe');
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

const term = pty.spawn(shell, ['/d', '/q'], {
  cwd: world,
  env: process.env,
  cols: 100,
  rows: 30,
  useConpty: true,
  useJobObject: true,
});
term.onData(() => {});
term.write(`"${exe}" child --seconds 120 --tick-file "${tickFile}" --tick-ms 100 --pidfile "${pidFile}"\r\n`);

const started = Date.now();
const timer = setInterval(() => {
  let childPid = 0;
  let ticks = 0;
  try { childPid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { /* not yet */ }
  try { ticks = fs.readFileSync(tickFile, 'utf8').split('\n').filter(Boolean).length; } catch { /* not yet */ }
  const status = term.jobStatus();
  if (childPid > 0 && ticks >= 3 && status.activeProcesses === 2) {
    clearInterval(timer);
    fs.writeFileSync(stateFile, JSON.stringify({
      shellPid: term.pid,
      childPid,
      ticks,
      status,
      at: Date.now(),
    }, null, 2));
    parentPort.postMessage({ ready: true });
    // Keep the worker and its env alive until the parent terminates it.
    setInterval(() => {}, 1000);
  }
  if (Date.now() - started > 20000) process.exit(2);
}, 50);
