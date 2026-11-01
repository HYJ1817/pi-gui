// Resume the exact package.json canonical plan after its documented environment failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = path.resolve(root, 'designs/ui-ux-2026-10-31/evidence');
const out = path.join(evidence, 'production-canonical-continuation'); fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'run.json'))) throw Error('Use a new continuation directory');
const previous = JSON.parse(fs.readFileSync(path.join(evidence, 'production-canonical-frozen/run.json')));
if (previous.exitCode !== 1 || !previous.unchangedInputs) throw Error('Previous failure must be a fixed input run');
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
function snapshot() {
  const tracked = git('ls-files', '-z').split('\0');
  const added = git('ls-files', '--others', '--exclude-standard', '-z', '--', 'public', 'tests', 'electron', 'scripts', 'lib', 'server').split('\0');
  const files = [...new Set([...tracked, ...added])].filter(p => /^(public\/|tests\/|electron\/|scripts\/|lib\/|server\/|package(?:-lock)?\.json$|server\.js$)/.test(p)).sort();
  return hash(JSON.stringify(files.map(file => ({ file, sha256: fs.existsSync(path.join(root, file)) ? hash(fs.readFileSync(path.join(root, file))) : 'deleted' }))));
}
const { createTestGroupPlan, validateTestGroupPlan } = await import(pathToFileURL(path.join(root, 'scripts/test-group-plan.mjs')));
const plan = createTestGroupPlan({ root, packageJson: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))) }); validateTestGroupPlan(plan);
const start = plan.leaves.indexOf('node tests/session-revert-sacl-witness.cjs');
if (start !== 106 || snapshot() !== previous.inputDigest) throw Error('Canonical boundary or input state changed');
const started = Date.now();
const record = { state: 'running', mode: 'cumulative continuation, not a single successful npm test', previous: '../production-canonical-frozen/run.json', started: new Date().toISOString(), pid: process.pid, head: git('rev-parse', 'HEAD'), inputDigest: previous.inputDigest, planDigest: hash(JSON.stringify(plan.leaves)), totalCommands: plan.leaves.length, alreadyCompletedCommands: start, resumeIndex: start, environmentAdjustment: 'PSExecutionPolicyPreference=Bypass only in owned test subprocesses; no persisted policy modification; no privilege elevation', results: [] };
const save = () => fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(record, null, 2)); save();
const log = fs.openSync(path.join(out, 'continuation.log'), 'wx');
for (let index = start; index < plan.leaves.length; index++) {
  const command = plan.leaves[index]; const row = { index, command, state: 'running', started: new Date().toISOString() };
  record.results.push(row); record.currentCommand = command; save();
  fs.writeSync(log, '\nCanonical ' + (index + 1) + '/' + plan.leaves.length + ': ' + command + '\n');
  const exit = await new Promise(resolve => {
    const child = spawn(command, { cwd: root, env: { ...process.env, PSExecutionPolicyPreference: 'Bypass' }, shell: true, windowsHide: true, stdio: ['ignore', log, log] });
    child.on('error', e => resolve({ code: 1, error: e.code || 'spawn_error' })); child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  Object.assign(row, { ...exit, state: exit.code === 0 ? 'completed' : 'failed', ended: new Date().toISOString() }); save();
  if (exit.code !== 0) { record.state = 'failed'; break; }
}
record.finalDigest = snapshot(); record.unchangedInputs = record.finalDigest === record.inputDigest;
if (record.state === 'running') record.state = record.unchangedInputs ? 'completed' : 'input_changed';
record.completedCommands = start + record.results.filter(r => r.state === 'completed').length;
record.ended = new Date().toISOString(); record.elapsedSeconds = (Date.now() - started) / 1000; delete record.currentCommand; save(); fs.closeSync(log);
process.exitCode = record.state === 'completed' ? 0 : 1;
