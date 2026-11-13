/* Fixture backend for the P3-C crash-reclaim acceptance.
 *
 * Runs the production node-pty Job path, starts a long-running child through
 * the shell, publishes the pids/status, then aborts itself when the parent
 * asks. The parent holds process handles opened before the abort, so the
 * verdict does not depend on PID lookups after the tree is gone.
 */
const fs = require('node:fs');
const path = require('node:path');
const pty = require('../../node_modules/node-pty');

const [world, stateFile, crashFile, tickFile, pidFile] = process.argv.slice(2);
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
let data = '';
term.onData((chunk) => { data += chunk; });
if (term.jobMode !== true) throw new Error('driver did not enter Job mode');

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
      role: 'node-pty-job-driver',
      shellPid: term.pid,
      childPid,
      ticks,
      status,
      outputHasShellEcho: data.length > 0,
      at: Date.now(),
    }, null, 2));
    const waitCrash = setInterval(() => {
      if (!fs.existsSync(crashFile)) return;
      clearInterval(waitCrash);
      // Abnormal termination: no JS cleanup, no killJob, no dispose.
      process.abort();
    }, 25);
  }
  if (Date.now() - started > 20000) {
    clearInterval(timer);
    process.exit(2);
  }
}, 50);
