'use strict';
// One owned npm test run. Logs survive chat/process-session interruptions.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const out = path.resolve(process.argv[2]);
const evidence = path.resolve(__dirname, '../evidence');
if (!out.startsWith(evidence + path.sep)) throw Error('Evidence directory must stay in this design package');
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'run.json'))) throw Error('Use a new evidence directory');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function snapshot() {
  const tracked = git('ls-files', '-z').split('\0');
  const added = git('ls-files', '--others', '--exclude-standard', '-z', '--', 'public', 'tests', 'electron', 'scripts', 'lib', 'server').split('\0');
  const files = [...new Set([...tracked, ...added])].filter(p => /^(public\/|tests\/|electron\/|scripts\/|lib\/|server\/|package(?:-lock)?\.json$|server\.js$)/.test(p)).sort();
  const rows = files.map(file => ({ file, sha256: fs.existsSync(path.join(root, file)) ? hash(fs.readFileSync(path.join(root, file))) : 'deleted' }));
  return { digest: hash(JSON.stringify(rows)), files: rows };
}
const started = new Date(), before = snapshot();
fs.writeFileSync(path.join(out, 'input-snapshot.json'), JSON.stringify(before, null, 2));
const record = { command: 'npm test', cwd: root, head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), node: process.version, platform: process.platform, started: started.toISOString(), pid: process.pid, state: 'running', inputDigest: before.digest };
const save = () => fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(record, null, 2));
save();
const log = fs.openSync(path.join(out, 'npm-test.log'), 'wx');
const child = spawn('cmd.exe', ['/d', '/s', '/c', 'npm.cmd test'], { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', log, log] });
record.launcherPid = child.pid; save();
child.on('error', error => { record.state = 'failed'; record.error = error.code || 'spawn_error'; record.ended = new Date().toISOString(); save(); fs.closeSync(log); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  const after = snapshot();
  Object.assign(record, { state: code === 0 ? 'passed' : 'failed', exitCode: code, signal, ended: new Date().toISOString(), elapsedSeconds: (Date.now() - started.getTime()) / 1000, finalDigest: after.digest, unchangedInputs: before.digest === after.digest });
  save(); fs.closeSync(log); process.exitCode = code ?? 1;
});
