const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
let checks = 0;
const check = (name, action) => { action(); checks++; console.log('ok ' + name); };
async function main() {
  const { createGroupRecord } = await import('../scripts/ci-results.mjs');
  const { summarizeResults, renderSummary } = await import('../scripts/summarize-ci-results.mjs');
  const groups = ['core', 'ui', 'security', 'native', 'faults'];
  const plan = { groups, leaves: groups.map(group => `node tests/${group}.cjs`), byGroup: new Map(groups.map(group => [group, [`node tests/${group}.cjs`]])) };
  const env = { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_EVENT_NAME: 'pull_request' };
  const identity = { sha: env.GITHUB_SHA, runId: '123', runAttempt: '2', event: 'pull_request' };
  function records() {
    return Object.fromEntries(groups.map((group, index) => {
      const record = createGroupRecord(group, plan, env);
      Object.assign(record, { status: 'passed', startedAt: '2026-10-24T00:00:00Z', finishedAt: '2026-10-24T00:00:05Z' });
      Object.assign(record.results[0], { status: 'passed', startedAt: record.startedAt, finishedAt: record.finishedAt, durationMs: 1000 + index, exitCode: 0 });
      return [group, record];
    }));
  }
  const summarize = (input = records()) => summarizeResults(plan, input, identity);
  check('all required groups with exact provenance pass and preserve counts', () => {
    const summary = summarize();
    assert.equal(summary.allPassed, true); assert.equal(summary.dataComplete, true);
    assert.equal(summary.counts.passed, 5); assert.equal(summary.unexecuted, 0);
  });
  for (const state of ['failed', 'cancelled', 'skipped', 'interrupted', 'running', 'pending']) {
    check(`${state} is never promoted to success`, () => {
      const input = records(); input.core.status = state; input.core.results[0].status = state;
      if (state !== 'passed') input.core.results[0].exitCode = state === 'failed' ? 17 : null;
      if (state === 'running' || state === 'pending') input.core.finishedAt = null;
      const summary = summarize(input);
      assert.equal(summary.allPassed, false);
      assert.equal(summary.counts[state], 1);
      if (state === 'pending') assert.equal(summary.unexecuted, 1);
      if (state === 'skipped') assert.equal(summary.unexecuted, 0);
    });
  }
  check('missing artifacts and commands are explicit incomplete evidence', () => {
    const input = records(); delete input.native;
    const summary = summarize(input);
    assert.equal(summary.allPassed, false); assert.equal(summary.dataComplete, false);
    assert.equal(summary.unexecuted, 1); assert.equal(summary.groups.find(row => row.group === 'native').status, 'missing');
    input.native = records().native; input.native.results = [];
    assert.equal(summarize(input).allPassed, false);
  });
  for (const field of ['sha', 'runId', 'runAttempt', 'event', 'planDigest']) {
    check(`mismatched ${field} cannot prove this execution`, () => {
      const input = records(); input.ui[field] = 'mismatch';
      assert.equal(summarize(input).allPassed, false);
      assert.equal(summarize(input).dataComplete, false);
      assert.equal(summarize(input).counts.passed, 4);
      assert.notEqual(summarize(input).groups.find(row => row.group === 'ui').status, 'passed');
    });
  }
  check('lying passed status with a nonzero exit, missing finish, signal or error is rejected', () => {
    for (const change of [{ exitCode: 17 }, { finishedAt: null }, { signal: 'SIGTERM' }, { error: 'EIO' }, { durationMs: null }]) {
      const input = records(); Object.assign(input.core.results[0], change);
      assert.equal(summarize(input).allPassed, false);
    }
  });
  check('slowest commands are sorted by actual duration, unknown time remains unavailable', () => {
    const input = records(); input.core.results[0].durationMs = null;
    const summary = summarize(input);
    assert.equal(summary.slowest[0].group, 'faults');
    assert.equal(summary.timings.testExecutionMs, null);
    assert.equal(summary.timings.runnerTimeMs, null);
    assert.equal(summary.timings.queueWaitMs, null);
    assert.match(renderSummary(summary), /unavailable/);
  });
  check('failure details are structural and never include arbitrary payload or environment', () => {
    const input = records(); input.core.status = 'failed';
    Object.assign(input.core.results[0], { status: 'failed', exitCode: 17, error: 'SECRET_TOKEN_VALUE=do-not-emit' });
    const summary = summarize(input);
    assert.equal(summary.failures[0].exitCode, 17);
    assert.ok(!JSON.stringify(summary).includes('SECRET_TOKEN_VALUE'));
    assert.ok(!renderSummary(summary).includes('SECRET_TOKEN_VALUE'));
  });
  check('legacy evidence is readable but cannot prove run attempt or exact plan', () => {
    const input = records(); input.core.sourceSchemaVersion = 1; input.core.planDigest = null;
    assert.equal(summarize(input).allPassed, false);
  });
  check('duplicate or reordered commands cannot replace canonical coverage', () => {
    const input = records(); input.core.results.push({ ...input.core.results[0] });
    assert.equal(summarize(input).allPassed, false);
  });
  check('CLI writes parseable JSON and fails closed for a missing artifact', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ci-summary-中文 空格-'));
    try {
      fs.mkdirSync(path.join(fixture, 'tests'));
      const names = ['core.cjs', 'ui-fixture.cjs', 'session-revert-fixture.cjs', 'session-revert-object-runtime.cjs', 'stop-barrier.cjs'];
      const pkg = { scripts: { test: names.map(name => `node tests/${name}`).join(' && ') } };
      fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg));
      for (const name of names) fs.writeFileSync(path.join(fixture, 'tests', name), '');
      // The fixture plan is generated by the same public canonical entry;
      // no second hand-maintained test manifest feeds the CLI.
      const { execFileSync } = require('node:child_process');
      const digestAndGroups = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {createTestGroupPlan} from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../scripts/test-group-plan.mjs')).href)};const p=createTestGroupPlan({packageJson:${JSON.stringify(pkg)}});console.log(JSON.stringify([...p.byGroup]));`], { encoding: 'utf8', windowsHide: true }));
      const fixturePlan = { groups, leaves: names.map(name => `node tests/${name}`), byGroup: new Map(digestAndGroups) };
      for (const group of groups) {
        const record = createGroupRecord(group, fixturePlan, env);
        record.status = 'passed'; record.finishedAt = record.startedAt;
        Object.assign(record.results[0], { status: 'passed', startedAt: record.startedAt, finishedAt: record.finishedAt, durationMs: 1, exitCode: 0 });
        const dir = path.join(fixture, 'artifacts', 'test-results-' + group);
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(record));
      }
      const args = [path.resolve(__dirname, '../scripts/summarize-ci-results.mjs'), '--input', path.join(fixture, 'artifacts'), '--json', 'summary.json', '--summary', 'summary.md', '--require-complete'];
      const options = { cwd: fixture, env: { ...process.env, ...env, SECRET_TEST: 'DO_NOT_RECORD_ME' }, encoding: 'utf8', windowsHide: true };
      assert.equal(spawnSync(process.execPath, args, options).status, 0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'summary.json'))).allPassed, true);
      fs.unlinkSync(path.join(fixture, 'artifacts/test-results-native/results.json'));
      assert.equal(spawnSync(process.execPath, args, options).status, 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'summary.json'))).allPassed, false);
      assert.ok(!fs.readFileSync(path.join(fixture, 'summary.md'), 'utf8').includes('DO_NOT_RECORD_ME'));
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });
  console.log(`ci-summary: ${checks}/${checks} passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
