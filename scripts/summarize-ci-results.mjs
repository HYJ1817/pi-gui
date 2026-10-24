import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestGroupPlan, GROUPS, validateTestGroupPlan } from './test-group-plan.mjs';
import { STATES, planDigest, readRecord, atomicWriteJson } from './ci-results.mjs';

const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const elapsed = (start, end) => timestamp(start) && timestamp(end) && Date.parse(end) >= Date.parse(start) ? Date.parse(end) - Date.parse(start) : null;
const errorCode = value => value === null ? null : typeof value === 'string' && /^[A-Z][A-Z_0-9]{0,59}$/.test(value) ? value : 'unavailable';

export function summarizeResults(plan, records, identity = {}, selectedGroups = plan.groups) {
  const counts = Object.fromEntries(STATES.map(state => [state, 0]));
  const failures = [], timed = [], groups = [];
  let unexecuted = 0;
  const digest = planDigest(plan);
  for (const group of selectedGroups) {
    const expected = plan.byGroup.get(group);
    const record = records[group];
    const issues = [];
    if (!record) {
      groups.push({ group, status: 'missing', durationMs: null, planned: expected.length, completed: 0, issues: ['missing artifact'], valid: false });
      unexecuted += expected.length;
      continue;
    }
    for (const field of ['sha', 'runId', 'runAttempt', 'event']) {
      if (!identity[field] || record[field] !== identity[field]) issues.push(`${field} unavailable or mismatch`);
    }
    if (record.schemaVersion !== 2 || record.sourceSchemaVersion === 1) issues.push('legacy or unsupported schema');
    if (record.group !== group || record.planDigest !== digest || record.planTotal !== plan.leaves.length) issues.push('plan identity mismatch');
    if (issues.length) {
      groups.push({ group, status: 'interrupted', durationMs: null, planned: expected.length, completed: 0, issues, valid: false });
      unexecuted += expected.length;
      continue;
    }
    const rows = Array.isArray(record.results) ? record.results : [];
    if (rows.length !== expected.length) issues.push('command coverage mismatch');
    let completed = 0;
    for (const [index, command] of expected.entries()) {
      const row = rows[index];
      if (!row) { unexecuted++; continue; }
      if (row.command !== command || row.index !== index + 1) issues.push('command identity/order mismatch');
      const status = STATES.includes(row.status) ? row.status : 'interrupted';
      counts[status]++;
      if (status === 'pending') unexecuted++;
      else if (status !== 'running') completed++;
      if (status === 'passed' && (row.exitCode !== 0 || row.signal !== null || row.error !== null || !timestamp(row.startedAt) || !timestamp(row.finishedAt) || !numeric(row.durationMs))) issues.push('passed leaf lacks successful terminal proof');
      if (numeric(row.durationMs)) timed.push({ group, command, durationMs: row.durationMs });
      if (['failed', 'cancelled', 'interrupted'].includes(status)) failures.push({
        group, command, status, exitCode: Number.isInteger(row.exitCode) ? row.exitCode : null,
        signal: errorCode(row.signal), error: errorCode(row.error),
      });
    }
    let status = STATES.includes(record.status) ? record.status : 'interrupted';
    if (status === 'passed' && (!timestamp(record.finishedAt) || rows.some(row => row.status !== 'passed'))) issues.push('passed group has unfinished leaves');
    if (issues.length) status = 'interrupted';
    groups.push({ group, status, durationMs: elapsed(record.startedAt, record.finishedAt), planned: expected.length, completed, issues, valid: issues.length === 0 });
  }
  const allPassed = groups.every(group => group.valid && group.status === 'passed') && counts.passed === selectedGroups.reduce((total, group) => total + plan.byGroup.get(group).length, 0);
  const dataComplete = groups.every(group => group.valid && !['missing', 'pending', 'running', 'interrupted'].includes(group.status) && group.durationMs !== null);
  const saved = selectedGroups.map(group => records[group]).filter(Boolean);
  const starts = saved.map(record => record.startedAt).filter(timestamp).map(Date.parse);
  const ends = saved.map(record => record.finishedAt).filter(timestamp).map(Date.parse);
  return {
    schemaVersion: 1, ...identity, planDigest: digest,
    allPassed, dataComplete, hasUnfinishedRecords: groups.some(group => ['missing', 'running', 'pending', 'interrupted'].includes(group.status)) || counts.running > 0,
    counts, unexecuted, groups, failures,
    slowest: timed.sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
    timings: {
      // Group timestamps describe the tests' span, not Actions job wall time.
      testWallTimeMs: saved.length === selectedGroups.length && ends.length === saved.length && starts.length === saved.length ? Math.max(...ends) - Math.min(...starts) : null,
      testExecutionMs: timed.length === selectedGroups.reduce((total, group) => total + plan.byGroup.get(group).length, 0) ? timed.reduce((total, row) => total + row.durationMs, 0) : null,
      observedTestExecutionMs: timed.length ? timed.reduce((total, row) => total + row.durationMs, 0) : null,
      runnerTimeMs: null, queueWaitMs: null, retryWaitMs: null,
    },
  };
}

export function renderSummary(summary) {
  const duration = value => value === null ? 'unavailable' : `${(value / 1000).toFixed(3)} s`;
  const escape = text => String(text).replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
  return [
    '# CI test evidence',
    `Run ${summary.runId || 'unavailable'} / attempt ${summary.runAttempt || 'unavailable'} / SHA ${summary.sha || 'unavailable'}`,
    `Complete evidence: ${summary.dataComplete}; all required tests passed: ${summary.allPassed}; unfinished records: ${summary.hasUnfinishedRecords}`,
    `Passed ${summary.counts.passed}; failed ${summary.counts.failed}; cancelled ${summary.counts.cancelled}; interrupted ${summary.counts.interrupted}; skipped ${summary.counts.skipped}; running ${summary.counts.running}; unexecuted ${summary.unexecuted}.`,
    '', '| Group | Status | Completed/planned | Test span | Evidence issues |', '| --- | --- | --- | --- | --- |',
    ...summary.groups.map(group => `| ${group.group} | ${group.status} | ${group.completed}/${group.planned} | ${duration(group.durationMs)} | ${group.issues.map(escape).join('; ')} |`),
    '', `Test wall span: ${duration(summary.timings.testWallTimeMs)}; total test execution: ${duration(summary.timings.testExecutionMs)}; observed test execution: ${duration(summary.timings.observedTestExecutionMs)}.`,
    'Actions wall time, runner occupancy, queue and retry wait: unavailable from leaf artifacts; use Actions job timestamps (historical baseline reports them separately).',
    '', '## Slowest observed commands', '| Group | Command | Duration |', '| --- | --- | --- |',
    ...summary.slowest.map(row => `| ${row.group} | ${escape(row.command)} | ${duration(row.durationMs)} |`),
    '', '## Failed or interrupted commands',
    ...summary.failures.map(row => `- ${row.group}: ${escape(row.command)}; ${row.status}; exit=${row.exitCode ?? 'unavailable'}; signal=${row.signal ?? 'unavailable'}; error=${row.error ?? 'unavailable'}`),
    '', summary.allPassed ? 'Retry guidance: none needed; all required test evidence is complete.' : summary.failures.length ? 'Retry guidance: inspect the listed failure/interruption before any manual rerun; this tool never retries.' : 'Retry guidance: diagnose missing/incomplete evidence first; absence of a failure is not success.',
    '', 'This is diagnostic evidence; the CI gate also requires every upstream job to succeed. Missing or unfinished evidence cannot certify success.', '',
  ].join('\n');
}

function main() {
  const options = { input: null, json: null, summary: null, group: null, requireComplete: false };
  for (let index = 0; index < process.argv.slice(2).length; index++) {
    const args = process.argv.slice(2), arg = args[index];
    if (arg === '--require-complete') options.requireComplete = true;
    else if (['--input', '--json', '--summary', '--group'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.input || (options.group && !GROUPS.includes(options.group))) throw new Error('provide --input and an optional valid --group');
  const plan = createTestGroupPlan({ packageJson: JSON.parse(fs.readFileSync('package.json', 'utf8')) });
  validateTestGroupPlan(plan);
  const selected = options.group ? [options.group] : plan.groups;
  const records = {};
  for (const group of selected) {
    const file = options.group ? path.join(options.input, 'results.json') : path.join(options.input, `test-results-${group}`, 'results.json');
    if (!fs.existsSync(file)) continue;
    try { records[group] = readRecord(file); }
    catch { records[group] = { status: 'interrupted', results: [], group }; }
  }
  const identity = { sha: process.env.GITHUB_SHA || null, runId: process.env.GITHUB_RUN_ID || null, runAttempt: process.env.GITHUB_RUN_ATTEMPT || null, event: process.env.GITHUB_EVENT_NAME || null };
  const report = summarizeResults(plan, records, identity, selected);
  const markdown = renderSummary(report);
  if (options.json) atomicWriteJson(options.json, report);
  if (options.summary) fs.appendFileSync(options.summary, markdown, 'utf8');
  console.log(markdown);
  if (options.requireComplete && !report.allPassed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
