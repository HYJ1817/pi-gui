// Opt-in feasibility experiment, not a candidate executor or a canonical suite.
// Every write (including the benign Git filter) is confined to an owned TEMP fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWorktrees } from '../../../server/worktrees.js';
import { dirtyStatus } from '../../../lib/git-worktree.js';
import { worktreeTree, treeDiff, treeNumstat } from '../../../lib/git.js';
import { captureEvidence } from '../../../server/planner/evidence.js';
import { createSessionToolScheduler } from '../../../server/session-tool-scheduler.js';
import { resolveProjectPath } from '../../../lib/safe-path.js';

if (!process.argv.includes('--temporary-fixtures')) {
  console.error('Explicit --temporary-fixtures is required. No project path is accepted.');
  process.exit(2);
}
const temp = fs.realpathSync(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(temp, 'pi-gui-t4b-feasibility-'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^GIT_/i.test(k)) delete env[k];
Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(fixture, 'empty-config') });
const digest = v => createHash('sha256').update(v).digest('hex');
const checks = [];
const managers = [];
let scheduler;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false', ...args], { cwd, env, encoding: 'utf8',
  windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const read = (root, name) => fs.readFileSync(path.join(root, name));
const write = (root, name, value) => fs.writeFileSync(path.join(root, name), value);
function check(id, fn) { fn(); checks.push({ id, outcome: 'observed' }); }
function repo(name) {
  const root = path.join(fixture, name); fs.mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Temporary fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  write(root, 'file.txt', 'base\n'); write(root, '.gitignore', '*.private\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture baseline');
  return root;
}
function manager(root, name) {
  const dataDir = path.join(fixture, name); fs.mkdirSync(dataDir);
  const m = createWorktrees({ dataDir, getProjects: () => [{ path: root }],
    getContext: () => ({ cwd: root, generation: 1 }) });
  managers.push(m); return m;
}
try {
  const root = repo('source 中文');
  const m = manager(root, 'data');
  write(root, 'file.txt', 'first dirty value\n');
  write(root, 'extra.txt', 'untracked input\n');
  write(root, 'token.private', 'fixture only\n');
  const beforeStatus = await dirtyStatus(root);
  const prepared = await m.prepare({ project: root, branch: 'fixture/candidate' });
  write(root, 'file.txt', 'different dirty value\n');
  const afterStatus = await dirtyStatus(root);
  check('P01-status-does-not-bind-dirty-bytes', () => assert.equal(beforeStatus, afterStatus));
  check('P02-preflight-reports-dirty', () => assert.equal(prepared.plan.mainDirty, true));
  const sourceBefore = digest(read(root, 'file.txt'));
  const indexBefore = digest(read(root, '.git/index'));
  const candidate = (await m.create({ nonce: prepared.nonce })).workspace;
  check('P03-existing-create-accepts-same-status-content-drift', () => assert.equal(candidate.health, 'healthy'));
  check('P04-candidate-excludes-initial-dirty-input', () => assert.equal(read(candidate.path, 'file.txt').toString(), 'base\n'));
  check('P05-create-does-not-copy-untracked-or-ignored', () => {
    assert.equal(fs.existsSync(path.join(candidate.path, 'extra.txt')), false);
    assert.equal(fs.existsSync(path.join(candidate.path, 'token.private')), false);
  });
  check('P06-source-bytes-and-index-unchanged-by-create', () => {
    assert.equal(digest(read(root, 'file.txt')), sourceBefore);
    assert.equal(digest(read(root, '.git/index')), indexBefore);
  });
  await assert.rejects(m.create({ nonce: prepared.nonce }), e => e.code === 'confirmation_expired');
  check('P07-existing-nonce-replay-is-rejected', () => {});

  const snapRoot = repo('snapshot');
  write(snapRoot, 'file.txt', 'staged input\n'); git(snapRoot, 'add', 'file.txt');
  write(snapRoot, 'file.txt', 'working input\n');
  write(snapRoot, 'extra.txt', 'unselected untracked input\n');
  write(snapRoot, 'token.private', 'ignored fixture input\n');
  const originalIndex = digest(read(snapRoot, '.git/index'));
  const pre = await worktreeTree(snapRoot); assert.equal(pre.ok, true);
  check('P08-tree-snapshot-preserves-real-index', () => assert.equal(digest(read(snapRoot, '.git/index')), originalIndex));
  const treeFile = git(snapRoot, 'show', `${pre.tree}:file.txt`);
  const stagedFile = git(snapRoot, 'show', ':file.txt');
  check('P09-one-tree-is-working-not-separate-staged-input', () => {
    assert.equal(treeFile, 'working input\n'); assert.equal(stagedFile, 'staged input\n');
  });
  check('P10-tree-adds-unselected-untracked-by-default', () => {
    assert.equal(git(snapRoot, 'show', `${pre.tree}:extra.txt`), 'unselected untracked input\n');
  });
  check('P11-tree-excludes-ignored-input', () => {
    assert.equal(git(snapRoot, 'ls-tree', '--name-only', pre.tree).includes('token.private'), false);
  });

  scheduler = createSessionToolScheduler();
  const lease = scheduler.channel(snapRoot);
  await lease.acquire('candidate-call', { readOnly: false });
  // A second real process writes despite the cooperating GUI write lease.
  execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'external process value\\n')",
    path.join(snapRoot, 'file.txt')], { env, windowsHide: true, timeout: 10000, stdio: 'pipe' });
  check('P12-external-process-is-not-blocked-by-tool-lease', () => {
    assert.equal(scheduler.busy(), true); assert.equal(read(snapRoot, 'file.txt').toString(), 'external process value\n');
  });
  const evidence = await captureEvidence({ worktreeTree, treeDiff, treeNumstat }, snapRoot, { preTree: pre.tree });
  check('P13-time-window-evidence-accepts-external-only-write', () => {
    assert.equal(evidence.status, 'available'); assert.equal(evidence.files.length, 1);
    assert.equal(evidence.files[0].path, 'file.txt');
  });
  check('P14-before-after-diff-excludes-initial-dirty-baseline', () => {
    assert.match(evidence.files[0].patch, /-working input/);
    assert.doesNotMatch(evidence.files[0].patch, /-base\n/);
  });
  write(snapRoot, 'file.txt', 'working input\n');
  const restored = await worktreeTree(snapRoot); assert.equal(restored.ok, true);
  check('P15-return-to-input-has-empty-diff', () => assert.equal(restored.tree, pre.tree));
  lease.release('candidate-call'); lease.close(true);

  const filterRoot = repo('filter');
  write(filterRoot, '.gitattributes', 'file.txt filter=t4bFixture\n');
  write(filterRoot, 'file.txt', 'UPPER\n'); git(filterRoot, 'add', '.'); git(filterRoot, 'commit', '-m', 'fixture attributes');
  const filterScript = path.join(fixture, 'benign-filter.cjs');
  write(fixture, 'benign-filter.cjs', "const fs=require('node:fs'); const input=fs.readFileSync(0); fs.writeFileSync(process.argv[2],'observed'); process.stdout.write(process.argv[3]==='clean'?input.toString().toLowerCase():input);\n");
  const cleanMarker = path.join(fixture, 'clean.marker'), smudgeMarker = path.join(fixture, 'smudge.marker');
  const command = marker => `\"${process.execPath.replaceAll('\\', '/')}\" \"${filterScript.replaceAll('\\', '/')}\" \"${marker.replaceAll('\\', '/')}\"`;
  git(filterRoot, 'config', 'filter.t4bFixture.clean', `${command(cleanMarker)} clean`);
  git(filterRoot, 'config', 'filter.t4bFixture.smudge', `${command(smudgeMarker)} smudge`);
  const filtered = await worktreeTree(filterRoot); assert.equal(filtered.ok, true);
  check('P16-git-snapshot-can-execute-clean-filter', () => assert.equal(fs.existsSync(cleanMarker), true));
  check('P17-tree-bytes-can-differ-from-disk-bytes', () => {
    assert.equal(git(filterRoot, 'show', `${filtered.tree}:file.txt`), 'upper\n');
    assert.equal(read(filterRoot, 'file.txt').toString(), 'UPPER\n');
  });
  const filterManager = manager(filterRoot, 'filter-data');
  const fp = await filterManager.prepare({ project: filterRoot, branch: 'fixture/filtered-candidate' });
  const fc = (await filterManager.create({ nonce: fp.nonce })).workspace;
  check('P18-controlled-checkout-still-runs-smudge-filter', () => {
    assert.equal(fc.health, 'healthy'); assert.equal(fs.existsSync(smudgeMarker), true);
  });

  const outside = path.join(fixture, 'outside'); fs.mkdirSync(outside); write(outside, 'file.txt', 'fixture only');
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  check('P19-existing-path-boundary-rejects-link-escape', () => {
    const target = resolveProjectPath(root, 'escape/file.txt');
    assert.equal(target.ok, false); assert.equal(target.code, 'symlink');
  });
} catch (error) {
  // Failures never print fixture source, stderr or absolute paths.
  checks.push({ id: 'probe-interrupted', outcome: 'failed', code: error?.code || 'assertion_failed' });
} finally {
  for (const m of managers) m.dispose(); scheduler?.dispose();
  const real = fs.realpathSync(fixture), relative = path.relative(temp, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(real).startsWith('pi-gui-t4b-feasibility-')) throw Error('fixture_cleanup_refused');
  fs.rmSync(real, { recursive: true, force: true });
}
const failed = checks.filter(c => c.outcome === 'failed').length;
console.log(JSON.stringify({ kind: 'T4-B feasibility observations; NOT feature acceptance',
  platform: process.platform, node: process.version, passed: checks.length - failed,
  failed, skip: 0, checks }, null, 2));
process.exitCode = failed ? 1 : 0;
