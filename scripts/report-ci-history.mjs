import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { atomicWriteJson } from './ci-results.mjs';

const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const duration = (start, end) => validTime(start) && validTime(end) && Date.parse(end) >= Date.parse(start) ? Date.parse(end) - Date.parse(start) : null;
export function statistics(input) {
  const values = input.filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const n = values.length;
  return {
    n, meanMs: n ? values.reduce((sum, value) => sum + value, 0) / n : null,
    medianMs: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
    maxMs: n ? values[n - 1] : null,
    // Conservative sample-size policy; empirical nearest rank, not an SLA.
    p90Ms: n >= 20 ? values[Math.ceil(n * 0.90) - 1] : null,
    p95Ms: n >= 20 ? values[Math.ceil(n * 0.95) - 1] : null,
  };
}

export function analyzeHistory(input) {
  const runs = input.map(run => {
    const attempts = run.attempts.map(attempt => {
      const jobs = attempt.jobs.map(job => ({ ...job, durationMs: job.conclusion === 'skipped' ? null : duration(job.startedAt, job.completedAt) }));
      const executed = jobs.filter(job => job.conclusion !== 'skipped');
      const ends = jobs.map(job => job.completedAt).filter(validTime).sort();
      const completedAt = ends.at(-1) || null;
      return { ...attempt, jobs, completedAt, wallTimeMs: duration(attempt.startedAt, completedAt),
        runnerTimeMs: executed.length && executed.every(job => job.durationMs !== null) ? executed.reduce((sum, job) => sum + job.durationMs, 0) : null,
        cause: attempt.conclusion === 'success' ? null : attempt.conclusion === 'timed_out' || jobs.some(job => job.conclusion === 'timed_out') ? 'timeout' : attempt.conclusion === 'cancelled' ? 'cancelled_source_unknown' : 'unknown',
      };
    });
    const gaps = attempts.slice(1).map((attempt, index) => duration(attempts[index].completedAt, attempt.startedAt));
    return { ...run, attempts, wallTimeMs: duration(attempts[0]?.startedAt, attempts.at(-1)?.completedAt),
      runnerTimeMs: attempts.every(attempt => attempt.runnerTimeMs !== null) ? attempts.reduce((sum, attempt) => sum + attempt.runnerTimeMs, 0) : null,
      retryGapMs: gaps.length ? gaps.every(value => value !== null) ? gaps.reduce((a, b) => a + b, 0) : null : 0,
      queueWaitMs: null,
    };
  });
  const all = runs.flatMap(run => run.attempts);
  const jobs = all.flatMap(attempt => attempt.jobs);
  const first = runs.map(run => run.attempts[0]);
  const ratio = outcome => first.length ? first.filter(attempt => attempt.conclusion === outcome).length / first.length : null;
  return {
    schemaVersion: 1, collectedAt: new Date().toISOString(), uniqueRuns: runs.length, attempts: all.length,
    rerunRuns: runs.filter(run => run.attempts.length > 1).length,
    firstAttempt: { successRate: ratio('success'), failureRate: ratio('failure'), cancelledRate: ratio('cancelled'), timedOutRate: ratio('timed_out') },
    wallTime: statistics(runs.map(run => run.wallTimeMs)),
    runnerTime: statistics(runs.map(run => run.runnerTimeMs)),
    groups: Object.fromEntries([...new Set(jobs.map(job => job.name))].sort().map(name => [name, statistics(jobs.filter(job => job.name === name).map(job => job.durationMs))])),
    firstAttemptGroups: Object.fromEntries([...new Set(jobs.map(job => job.name))].sort().map(name => [name, statistics(runs.flatMap(run => run.attempts[0].jobs).filter(job => job.name === name).map(job => job.durationMs))])),
    groupOutcomes: Object.fromEntries([...new Set(jobs.map(job => job.name))].sort().map(name => [name, Object.fromEntries(['success', 'failure', 'cancelled', 'skipped', 'timed_out', null].map(outcome => [outcome || 'unknown', jobs.filter(job => job.name === name && job.conclusion === outcome).length]))])),
    quantilePolicy: 'P90/P95 unavailable below 20 observations; empirical nearest rank otherwise; descriptive only, no stable-tail claim',
    timingPolicy: 'wall: first attempt run_started_at to latest observed job completion; runner: sum non-skipped job start/end spans across attempts; retryGap: observed inter-attempt gaps; queue unavailable; skipped job duration unavailable',
    runs,
  };
}

function api(route) {
  return JSON.parse(execFileSync('gh', ['api', route], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
}

function collect(repository, limit) {
  const list = api(`repos/${repository}/actions/workflows/ci.yml/runs?per_page=${limit}&status=completed`).workflow_runs;
  return list.map((run, index) => {
    console.error(`Reading run ${index + 1}/${list.length}: ${run.id} (${run.run_attempt} attempt(s))`);
    const attempts = [];
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      const metadata = api(`repos/${repository}/actions/runs/${run.id}/attempts/${attempt}`);
      const jobs = [];
      for (let page = 1; ; page++) {
        const response = api(`repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
        jobs.push(...response.jobs.map(job => ({ id: job.id, name: job.name, startedAt: job.started_at, completedAt: job.completed_at, conclusion: job.conclusion,
          testExecutionMs: (() => { const step = job.steps?.find(step => step.name === 'Run canonical test group'); return step ? duration(step.started_at, step.completed_at) : null; })(),
        })));
        if (jobs.length >= response.total_count) break;
        if (!response.jobs.length) throw new Error('incomplete job pagination');
      }
      attempts.push({ attempt, startedAt: metadata.run_started_at, conclusion: metadata.conclusion, jobs });
    }
    return { id: run.id, url: run.html_url, sha: run.head_sha, event: run.event, createdAt: run.created_at, attempts };
  });
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (!['--repo', '--limit', '--input', '--output'].includes(args[index]) || !args[index + 1]) throw new Error('use --input <JSON> or --repo <owner/repo> [--limit 15], and --output <JSON>');
    options[args[index].slice(2)] = args[++index];
  }
  if (!options.output) throw new Error('--output is required');
  const limit = Number(options.limit || 15);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('--limit must be 1..20');
  if (options.repo && !/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error('invalid repository');
  if (!options.input && !options.repo) throw new Error('--input or --repo is required');
  const input = options.input ? JSON.parse(fs.readFileSync(options.input, 'utf8')) : collect(options.repo, limit);
  const rows = Array.isArray(input) ? input : input.runs;
  const report = analyzeHistory(rows);
  atomicWriteJson(options.output, report);
  console.log(JSON.stringify({ uniqueRuns: report.uniqueRuns, attempts: report.attempts, firstAttempt: report.firstAttempt, wallTime: report.wallTime, groups: report.groups }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
