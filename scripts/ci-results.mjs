import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const STATES = Object.freeze(['pending', 'running', 'passed', 'failed', 'cancelled', 'interrupted', 'skipped']);
const TERMINAL = new Set(['passed', 'failed', 'cancelled', 'interrupted', 'skipped']);

export function planDigest(plan) {
  return createHash('sha256').update(JSON.stringify({
    commands: plan.leaves,
    groups: [...plan.byGroup].map(([group, commands]) => [group, commands]),
  })).digest('hex');
}

export function createGroupRecord(group, plan, env = process.env) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    group,
    sha: env.GITHUB_SHA || null,
    runId: env.GITHUB_RUN_ID || null,
    runAttempt: env.GITHUB_RUN_ATTEMPT || null,
    event: env.GITHUB_EVENT_NAME || null,
    nodeVersion: process.version,
    os: process.platform,
    arch: process.arch,
    planDigest: planDigest(plan),
    planTotal: plan.leaves.length,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    completedCount: 0,
    status: 'pending',
    results: plan.byGroup.get(group).map((command, index) => ({
      index: index + 1, command, startedAt: null, finishedAt: null,
      durationMs: null, exitCode: null, signal: null, error: null, status: 'pending',
    })),
  };
}

// Never unlink the previous evidence first: a locked Windows destination must
// fail while preserving the last valid JSON. Temporary files share its volume.
export function atomicWriteJson(file, value, io = fs) {
  io.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    io.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function saveRecord(file, record) {
  record.updatedAt = new Date().toISOString();
  record.completedCount = record.results.filter(row => TERMINAL.has(row.status)).length;
  if (file) atomicWriteJson(file, record);
}

export function readRecord(file) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.schemaVersion === 2) return record;
  if (record.schemaVersion !== 1 || !Array.isArray(record.results)) throw new Error('unsupported CI results schema');
  // v1 contains only completed leaves, with numeric `status`. It cannot prove
  // the plan was complete or the identity of the run attempt; retain unknowns.
  return {
    ...record, schemaVersion: 2, sourceSchemaVersion: 1,
    runId: null, runAttempt: null, event: null, planDigest: null, planTotal: null,
    updatedAt: record.finishedAt || record.startedAt || null,
    status: !record.finishedAt ? 'interrupted' : record.results.some(row => row.status !== 0) ? 'failed' : 'passed',
    completedCount: record.results.length,
    results: record.results.map(row => ({ ...row, exitCode: row.status,
      status: row.signal ? 'interrupted' : row.status === 0 ? 'passed' : 'failed',
      finishedAt: null,
    })),
  };
}
