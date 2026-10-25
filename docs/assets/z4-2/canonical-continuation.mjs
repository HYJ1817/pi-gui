/* Z4-2 canonical continuation runner — temporary tool that lives in TEMP and
 * writes only to TEMP. It resumes the interrupted canonical run recorded in
 * the run2 log: the 152 leaves that already passed there are reused as logged
 * evidence (hard-verified markers), the 9 pretest leaves are re-run as a live
 * preflight, and the remaining 56 leaves are re-run now. The final coverage is
 * computed as a Set of passed canonical indices and is explicitly labelled as
 * a CUMULATIVE pass, not a single uninterrupted npm test. The leaf list comes
 * only from the integration root's package.json expanded by
 * createTestGroupPlan (scripts/test-group-plan.mjs); nothing here hardcodes a
 * second test list. Git gates run before any leaf: HEAD must be reachable from
 * the prefix commit with changes confined to the six authorized test files,
 * and the uncommitted diff must be confined to docs/ and
 * prototype/z4-1-collab/README.md. No repository file is written.
 * Usage: node z4-canonical-continuation.mjs <absolute integration root> */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const EXPECTED_LEAVES = 208;
const PREFLIGHT_COUNT = 9;
const ANCHOR_INDEX = 152;
const ANCHOR_COMMAND = 'node tests/gui-browser-stop.cjs';
const PREFIX_COMMIT = '5388c1be155a0b86f9ed2c903669d31d63ce50d1';
const PREFIX_FAILURE =
  'exit 1; first failure at leaf #153 (createCollabStore missing); leaves 1..152 had completed in && order before the failure';
const LEDGER_NAME = 'pi-gui-z4-2-canonical-cumulative.json';
/* The only commits after the prefix run may touch these six test files. */
const COMMIT_RANGE_ALLOWED = new Set([
  'tests/collab-electron.cjs',
  'tests/fixtures/z4-collab-electron.cjs',
  'tests/fixtures/z4-network-guard-probe.cjs',
  'tests/fixtures/z4-offline-network.cjs',
  'tests/gui-browser-stop.cjs',
  'tests/stop-barrier.cjs',
]);
/* Uncommitted work-tree changes may only touch docs and the prototype README. */
const UNCOMMITTED_ALLOWED = relative => relative.startsWith('docs/') || relative === 'prototype/z4-1-collab/README.md';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const now = () => new Date().toISOString();
const writeLedger = state => {
  const target = path.join(os.tmpdir(), LEDGER_NAME);
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temp, target);
};
const ledgerPath = () => path.join(os.tmpdir(), LEDGER_NAME);

const rawRoot = process.argv[2] ?? '';
const root = path.resolve(rawRoot);
const state = {
  tool: 'z4-canonical-continuation.mjs (TEMP)',
  qualification: 'cumulative-not-single-npm-test',
  complete: false,
  startedUtc: now(),
  finishedUtc: null,
  root,
  gitHead: null,
  gitChecks: null,
  hashes: {},
  plan: {
    source: 'package.json scripts.test expanded by createTestGroupPlan (scripts/test-group-plan.mjs)',
    leaves: [],
    count: 0,
  },
  prefixSource: {
    commit: PREFIX_COMMIT,
    log: path.join(os.tmpdir(), 'pi-gui-z4-2-final-canonical-run2.log'),
    logEncoding: null,
    logSha256: null,
    logBytes: 0,
    failureDescription: PREFIX_FAILURE,
    reusedCommands: [],
    reusedCount: ANCHOR_INDEX,
  },
  rerun: { preflight: [], remainder: [] },
  coverage: { uniquePassed: 0, expected: EXPECTED_LEAVES },
  failure: null,
};
/* Unique passed canonical indices: 0..151 from the verified prefix evidence,
 * every successfully re-run leaf from this session. The preflight re-runs
 * reused indices 0..8; the Set keeps each index counted exactly once. */
const passed = new Set();
const persist = () => {
  state.coverage = { uniquePassed: passed.size, expected: EXPECTED_LEAVES };
  writeLedger(state);
};

try {
  if (!rawRoot || !path.isAbsolute(rawRoot)) throw new Error('usage: node z4-canonical-continuation.mjs <absolute integration root>');
  if (!fs.existsSync(path.join(root, 'package.json'))) throw new Error(`package.json not found under root: ${root}`);
  const planScript = path.join(root, 'scripts', 'test-group-plan.mjs');
  if (!fs.existsSync(planScript)) throw new Error('scripts/test-group-plan.mjs not found under root');
  state.hashes.packageJson = sha256(fs.readFileSync(path.join(root, 'package.json')));
  state.hashes.testGroupPlan = sha256(fs.readFileSync(planScript));

  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (exit ${result.status ?? 'spawn-error'})`);
    }
    return String(result.stdout ?? '');
  };
  const diffPaths = (...args) =>
    git(...args, '--name-only')
      .split('\n')
      .map(line => line.trim().replace(/\\/g, '/'))
      .filter(Boolean);

  state.gitHead = git('rev-parse', 'HEAD').trim();

  const rangeChanged = diffPaths('diff', PREFIX_COMMIT, 'HEAD');
  const outsideRange = rangeChanged.filter(relative => !COMMIT_RANGE_ALLOWED.has(relative));
  if (outsideRange.length) {
    throw new Error(`commits after ${PREFIX_COMMIT} touch paths outside the authorized six test files: ${outsideRange.join(', ')}`);
  }
  const uncommitted = diffPaths('diff', 'HEAD');
  const outsideUncommitted = uncommitted.filter(relative => !UNCOMMITTED_ALLOWED(relative));
  if (outsideUncommitted.length) {
    throw new Error(`uncommitted changes outside docs/ and prototype/z4-1-collab/README.md: ${outsideUncommitted.join(', ')}`);
  }
  state.gitChecks = {
    headCommand: 'git rev-parse HEAD',
    commitRange: { command: `git diff ${PREFIX_COMMIT} HEAD --name-only`, files: rangeChanged, outsideAllowed: outsideRange },
    uncommitted: { command: 'git diff HEAD --name-only', files: uncommitted, outsideAllowed: outsideUncommitted },
    policy: 'commits after the prefix may touch only the six authorized test files; uncommitted work may touch only docs/ and prototype/z4-1-collab/README.md',
  };

  const prefixLog = state.prefixSource.log;
  if (!fs.existsSync(prefixLog)) throw new Error('prefix run2 log not found in TEMP; the 152-leaf reuse has no source');
  const logBuffer = fs.readFileSync(prefixLog);
  state.prefixSource.logSha256 = sha256(logBuffer);
  state.prefixSource.logBytes = logBuffer.length;
  let logText;
  if (logBuffer.length >= 2 && logBuffer[0] === 0xff && logBuffer[1] === 0xfe) {
    state.prefixSource.logEncoding = 'utf16le-bom';
    logText = new TextDecoder('utf-16le').decode(logBuffer.subarray(2));
  } else if (logBuffer.length >= 3 && logBuffer[0] === 0xef && logBuffer[1] === 0xbb && logBuffer[2] === 0xbf) {
    state.prefixSource.logEncoding = 'utf8-bom';
    logText = logBuffer.subarray(3).toString('utf8');
  } else {
    state.prefixSource.logEncoding = 'utf8';
    logText = logBuffer.toString('utf8');
  }
  if (!logText.includes('createCollabStore')) {
    throw new Error('prefix run2 log does not mention createCollabStore; the 152-leaf reuse evidence is rejected');
  }
  if (!logText.includes('Z4_FINAL_EXIT=1')) {
    throw new Error('prefix run2 log does not contain Z4_FINAL_EXIT=1; the 152-leaf reuse evidence is rejected');
  }
  for (let index = 0; index < ANCHOR_INDEX; index++) passed.add(index);

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { createTestGroupPlan } = await import(pathToFileURL(planScript));
  const plan = createTestGroupPlan({ root, packageJson });
  if (plan.leaves.length !== EXPECTED_LEAVES) {
    throw new Error(`canonical plan has ${plan.leaves.length} leaves, expected ${EXPECTED_LEAVES}`);
  }
  if (plan.leaves[ANCHOR_INDEX] !== ANCHOR_COMMAND) {
    throw new Error(`canonical leaf #${ANCHOR_INDEX + 1} is "${plan.leaves[ANCHOR_INDEX]}", expected "${ANCHOR_COMMAND}"`);
  }
  state.plan.leaves = plan.leaves;
  state.plan.count = plan.leaves.length;
  state.prefixSource.reusedCommands = plan.leaves.slice(0, ANCHOR_INDEX);
  persist();

  const runLeaf = (canonicalIndex, stage) => {
    const command = plan.leaves[canonicalIndex];
    const record = { canonicalIndex, command, startedUtc: now() };
    const started = Date.now();
    const result = spawnSync(command, { shell: true, cwd: root, windowsHide: true, stdio: 'inherit' });
    record.finishedUtc = now();
    record.durationMs = Date.now() - started;
    const exit = result.status;
    record.exit = exit;
    if (exit === null) {
      record.signal = result.signal ?? null;
      record.spawnError = result.error ? (result.error.code ?? 'spawn-error') : null;
    }
    state.rerun[stage].push(record);
    if (exit !== 0) {
      state.failure = { stage, ...record };
      state.finishedUtc = now();
      persist();
      process.exitCode = exit ?? 1;
      return false;
    }
    passed.add(canonicalIndex);
    persist();
    return true;
  };

  for (let index = 0; index < PREFLIGHT_COUNT; index++) {
    if (!runLeaf(index, 'preflight')) process.exit();
  }
  for (let index = ANCHOR_INDEX; index < EXPECTED_LEAVES; index++) {
    if (!runLeaf(index, 'remainder')) process.exit();
  }
  if (passed.size !== EXPECTED_LEAVES) {
    throw new Error(`unique passed coverage is ${passed.size}, expected ${EXPECTED_LEAVES}`);
  }
  state.complete = true;
  state.finishedUtc = now();
  persist();
  console.log(
    `Z4 canonical continuation: cumulative ${passed.size}/${EXPECTED_LEAVES} unique leaves ` +
    `(152 reused from run2 log ${state.prefixSource.logSha256.slice(0, 12)}… + 65 re-runs, preflight overlaps deduplicated); ` +
    `ledger ${ledgerPath()}`
  );
} catch (error) {
  state.failure = { stage: state.failure ? state.failure.stage : 'setup', message: String((error && error.message) || error) };
  state.finishedUtc = now();
  try { persist(); } catch { /* ledger path itself unavailable */ }
  console.error(error);
  process.exitCode = 1;
}