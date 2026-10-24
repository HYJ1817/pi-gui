/* Supplementary real Electron crash matrix; all writes are TEMP fixtures.
 * Run after test:candidates using the existing offline Electron runtime.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.T4B_EVIDENCE_DIR || path.join(ROOT, '.probe/t4c-crash'));
const electron = require('electron');
const phases = ['before_write', 'after_native_write', 'first_verified', 'last_verified', 'recovering'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let child, checks = 0;
function check(name, ok) { assert(ok, name); checks++; console.log('ok ' + name); }
function launch(dir, phase, restart = false) {
  fs.mkdirSync(dir, {recursive: true});
  const env = {...process.env, T4C_APPLY_ADOPTION: '1', T4B_EVIDENCE_DIR: dir, CANDIDATE_CRASH_PHASE: phase, CANDIDATE_CRASH_RESTART: restart ? '1' : '0'};
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(dir, restart ? 'restart.log' : 'app.log'), 'w');
  child = spawn(electron, [path.join(ROOT, 'tests/fixtures/candidate-crash-app.cjs')], {cwd: ROOT, env, windowsHide: true, stdio: ['ignore', log, log]});
  fs.closeSync(log);
  return child;
}
async function until(predicate, label) {
  for (let i = 0; i < 1800; i++) {
    if (predicate()) return;
    if (child.exitCode !== null) throw Error(label + ': app exited ' + child.exitCode);
    await sleep(100);
  }
  throw Error('timeout: ' + label);
}
async function killTree() {
  if (!child || child.exitCode !== null) return;
  // This is the still-live child handle, never a stored/reused PID.
  execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'pipe'});
  await until(() => child.exitCode !== null, 'forced app exit');
}
function journal(dir) {
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => [n, fs.readFileSync(path.join(dir, n)).toString('base64')]);
}
async function main() {
  assert.equal(process.platform, 'win32', 'Windows NTFS crash matrix');
  fs.mkdirSync(OUT, {recursive: true});
  for (const phase of phases) {
    console.log('stage ' + phase);
    const dir = path.join(OUT, phase);
    assert(!fs.existsSync(path.join(dir, 'checkpoint.json')), 'use a new evidence directory');
    launch(dir, phase);
    await until(() => fs.existsSync(path.join(dir, 'checkpoint.json')), 'persisted ' + phase);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json')));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'world.json')));
    const repo = path.join(meta.world, 'source'), data = path.join(meta.world, 'data');
    const txDir = path.join(data, 'candidate-transactions', checkpoint.id);
    const before = journal(txDir), events = before.map(([, raw]) => JSON.parse(Buffer.from(raw, 'base64')).event);
    const last = events.at(-1);
    check(phase + ': checkpoint has expected durable transaction phase', last.state === ({before_write: 'prepared', after_native_write: 'applying', first_verified: 'step_verified', last_verified: 'step_verified', recovering: 'recovery_step_verified'})[phase]);
    check(phase + ': checkpoint verified file count', events.filter(e => e.state === 'step_verified').length === ({before_write: 0, after_native_write: 0, first_verified: 1, last_verified: 2, recovering: 1})[phase]);
    await killTree();
    const readFiles = () => ['second.txt', 'src/app.js'].map(name => fs.readFileSync(path.join(repo, name), 'utf8'));
    const expected = phase === 'last_verified' ? ['changed\n', 'export const value = 3;\n'] : ['first_verified', 'after_native_write'].includes(phase) ? ['changed\n', 'export const value = 2;\n'] : ['base\n', 'export const value = 2;\n'];
    check(phase + ': OS kill preserves checkpoint source bytes and original raw index', JSON.stringify(readFiles()) === JSON.stringify(expected) && Buffer.from(meta.index, 'base64').equals(fs.readFileSync(path.join(repo, '.git/index'))));
    check(phase + ': OS kill preserves journal bytes and intent', JSON.stringify(journal(txDir)) === JSON.stringify(before));
    const lock = path.join(data, 'candidate-transactions/execute.lock'), lockBytes = fs.readFileSync(lock);
    const trace = fs.readFileSync(path.join(meta.world, 'trace.jsonl'), 'utf8');
    const prompts = trace.split('"prompt"').length;
    launch(dir, phase, true);
    await until(() => fs.existsSync(path.join(dir, 'results.json')) || child.exitCode !== null, 'restart result');
    await until(() => child.exitCode !== null, 'restart exit');
    const restart = JSON.parse(fs.readFileSync(path.join(dir, 'results.json')));
    check(phase + ': production server and sandboxed UI restart and refuse stale lock', child.exitCode === 0 && restart.failed === 0 && restart.sandbox === true && restart.checks === 3);
    check(phase + ': restart never clears the lock or changes transaction evidence', lockBytes.equals(fs.readFileSync(lock)) && JSON.stringify(journal(txDir)) === JSON.stringify(before));
    const staged = execFileSync('git', ['ls-files', '--stage', '-z'], {cwd: repo, encoding: 'utf8', windowsHide: true});
    const indexCacheRefreshed = !Buffer.from(meta.index, 'base64').equals(fs.readFileSync(path.join(repo, '.git/index')));
    // A restored clean file has a new mtime. Ordinary GUI Diff queries can
    // refresh that stat cache; paths, blob IDs, modes and stage must stay exact.
    check(phase + ': restart preserves source and every staged entry', JSON.stringify(readFiles()) === JSON.stringify(expected) && staged === meta.staged && (phase === 'recovering' || !indexCacheRefreshed));
    check(phase + ': restart never resends candidate prompt', fs.readFileSync(path.join(meta.world, 'trace.jsonl'), 'utf8').split('"prompt"').length === prompts);
    results.push({phase, transaction: checkpoint.id, lastState: last.state, verifiedFiles: events.filter(e => e.state === 'step_verified').length, indexCacheRefreshed, restart, world: meta.world});
  }
}
main().then(() => {
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({checks, failed: 0, phases: results}, null, 2));
  console.log(`Candidate Electron crash matrix: ${checks}/${checks}; failed=0; skipped=0`);
}).catch(async error => {
  console.error(error);
  await killTree().catch(() => {});
  fs.mkdirSync(OUT, {recursive: true});
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({checks, failed: 1, error: error.message, phases: results}, null, 2));
  process.exitCode = 1;
});
