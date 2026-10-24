const assert = require('node:assert/strict');
(async () => {
  const { statistics, analyzeHistory } = await import('../scripts/report-ci-history.mjs');
  assert.deepEqual(statistics([]), { n: 0, meanMs: null, medianMs: null, maxMs: null, p90Ms: null, p95Ms: null });
  const values = statistics([100, 200, null, 300]);
  assert.equal(values.n, 3); assert.equal(values.meanMs, 200); assert.equal(values.medianMs, 200);
  assert.equal(values.p90Ms, null); assert.equal(values.maxMs, 300);
  const many = statistics(Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(many.p90Ms, 18); assert.equal(many.p95Ms, 19);
  const at = seconds => new Date(Date.UTC(2026, 9, 24, 0, 0, seconds)).toISOString();
  const job = (name, start, end, conclusion) => ({ name, startedAt: at(start), completedAt: at(end), conclusion });
  const report = analyzeHistory([
    { id: 1, sha: 'a', event: 'push', attempts: [
      { attempt: 1, startedAt: at(0), conclusion: 'failure', jobs: [job('Tests (core)', 0, 10, 'failure')] },
      { attempt: 2, startedAt: at(20), conclusion: 'success', jobs: [job('Tests (core)', 20, 25, 'success')] },
    ] },
    { id: 2, sha: 'b', event: 'pull_request', attempts: [{ attempt: 1, startedAt: at(0), conclusion: 'cancelled', jobs: [job('Tests (core)', 0, 4, 'cancelled')] }] },
  ]);
  assert.equal(report.uniqueRuns, 2); assert.equal(report.attempts, 3);
  assert.equal(report.firstAttempt.successRate, 0);
  assert.equal(report.firstAttempt.failureRate, 0.5);
  assert.equal(report.firstAttempt.cancelledRate, 0.5);
  assert.equal(report.rerunRuns, 1);
  assert.equal(report.runs[0].retryGapMs, 10000);
  assert.equal(report.runs[0].wallTimeMs, 25000);
  assert.equal(report.runs[0].runnerTimeMs, 15000);
  assert.equal(report.groups['Tests (core)'].n, 3);
  assert.equal(report.runs[0].attempts[0].cause, 'unknown');
  assert.equal(report.runs[1].attempts[0].cause, 'cancelled_source_unknown');
  const skipped = analyzeHistory([{ id: 3, attempts: [{ attempt: 1, conclusion: 'failure', startedAt: at(0), jobs: [job('Electron build check', 1, 2, 'skipped')] }] }]);
  assert.equal(skipped.groups['Electron build check'].n, 0, 'skipped job timestamps are not runner execution evidence');
  console.log('ci-history: 21 assertions passed (unique runs, attempts, timing and unavailable quantiles)');
})().catch(error => { console.error(error); process.exitCode = 1; });
