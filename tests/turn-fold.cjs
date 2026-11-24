'use strict';

/* Turn-fold copy and work-summary counts are pure presentation rules. They must
 * not invent a duration, must not turn call counts into file counts, and must
 * keep stop/continued wording aligned with T3 Code's Worked / You stopped /
 * Continued semantics. */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const foldModule = import('../public/ui/turn-fold.js');
const workModule = import('../public/ui/work-presentation.js');

const timing = (startedAt, endedAt, evidence = 'observed') => ({ startedAt, endedAt, evidence });

test('formats wall-clock durations without rounding a short turn to zero', async () => {
  const { formatElapsed } = await foldModule;
  assert.equal(formatElapsed(0), '不到 1 秒');
  assert.equal(formatElapsed(999), '不到 1 秒');
  assert.equal(formatElapsed(1000), '1 秒');
  assert.equal(formatElapsed(1450), '1.5 秒');
  assert.equal(formatElapsed(9999), '10 秒');
  assert.equal(formatElapsed(60000), '1 分');
  assert.equal(formatElapsed(207000), '3 分 27 秒');
  assert.equal(formatElapsed(3600000), '1 小时');
  assert.equal(formatElapsed(3661000), '1 小时 1 分 1 秒');
  assert.equal(formatElapsed(-1), '');
  assert.equal(formatElapsed(NaN), '');
  assert.equal(formatElapsed(undefined), '');
});

test('resolves elapsed time only from trustworthy evidence', async () => {
  const { elapsedOf } = await foldModule;
  assert.equal(elapsedOf({ durationMs: 1500, evidence: 'observed' }), '1.5 秒');
  assert.equal(elapsedOf({ durationMs: 1500, evidence: 'estimated' }), '约 1.5 秒');
  assert.equal(elapsedOf({ durationMs: 1500, evidence: 'unknown' }), '');
  assert.equal(elapsedOf(timing(1000, null), { now: 4000, status: 'running' }), '3 秒');
  // A settled turn without an end is not "0s"; it has no duration at all.
  assert.equal(elapsedOf(timing(1000, null), { now: 4000, status: 'completed' }), '');
  assert.equal(elapsedOf(timing(5000, 1000), { now: 6000, status: 'completed' }), '');
  assert.equal(elapsedOf(null), '');
});

test('labels the primary fold with completion, stop and failure wording', async () => {
  const { turnFoldLabel } = await foldModule;
  assert.equal(turnFoldLabel({ status: 'completed', timing: timing(0, 207000) }), '执行了 3 分 27 秒');
  // No trustworthy time evidence: keep the work-log noun instead of a fake 0s.
  assert.equal(turnFoldLabel({ status: 'completed' }), '工作记录');
  assert.equal(turnFoldLabel({ status: 'completed', timing: timing(0, 5000, 'unknown') }), '工作记录');
  assert.equal(turnFoldLabel({ status: 'running', timing: timing(1000, null), now: 4000 }), '执行中 · 已运行 3 秒');
  assert.equal(turnFoldLabel({ status: 'running' }), '执行中');
  assert.equal(turnFoldLabel({ status: 'waiting', timing: timing(1000, null), now: 4000 }), '等待中 · 已运行 3 秒');
  assert.equal(turnFoldLabel({ status: 'failed', timing: timing(1000, 3000) }), '执行失败 · 用时 2 秒');
  assert.equal(turnFoldLabel({ status: 'interrupted', timing: timing(1000, 3000) }), '已中断 · 用时 2 秒');
  assert.equal(turnFoldLabel({ status: 'cancelled', timing: timing(1000, 2500) }), '你在 1.5 秒后停止');
  assert.equal(turnFoldLabel({ status: 'stopped', timing: timing(1000, 2500) }), '你在 1.5 秒后停止');
  assert.equal(turnFoldLabel({ status: 'cancelled' }), '你停止了这次执行');
  assert.equal(turnFoldLabel({ status: 'incomplete', timing: timing(1000, 3000) }), '未完成 · 用时 2 秒');
  assert.equal(turnFoldLabel({ status: 'unknown' }), '执行记录');
  assert.equal(turnFoldLabel({ status: 'completed', timing: { durationMs: 1500, evidence: 'estimated' } }),
    '执行了约 1.5 秒');
});

test('labels a post-steer fold as continued execution, not as a new turn', async () => {
  const { turnFoldLabel } = await foldModule;
  assert.equal(turnFoldLabel({ status: 'completed', timing: timing(2000, 3500), continued: true }),
    '继续执行了 1.5 秒');
  assert.equal(turnFoldLabel({ status: 'completed', continued: true }), '继续执行');
  assert.equal(turnFoldLabel({ status: 'running', timing: timing(2000, null), now: 4000, continued: true }),
    '继续执行中 · 已运行 2 秒');
  assert.equal(turnFoldLabel({ status: 'failed', timing: timing(2000, 3000), continued: true }),
    '继续执行失败 · 用时 1 秒');
});

test('summarizes only countable abnormal activity without declaring a whole-turn failure', async () => {
  const { activityNote } = await foldModule;
  assert.equal(activityNote([]), '');
  assert.equal(activityNote(['success', 'running']), '');
  assert.equal(activityNote(['error']), '1 项失败');
  assert.equal(activityNote(['error', 'failed', 'interrupted', 'cancelled', 'incomplete']),
    '2 项失败 · 1 项中断 · 1 项取消 · 1 项未完成');
});

test('uses distinct file counts only when every call carries a target identity', async () => {
  const { workSummary } = await workModule;
  assert.equal(workSummary([{ kind: 'read', targetId: '/a.js' }, { kind: 'read', targetId: '/b.js' }]),
    '读取 2 个文件');
  // Reading the same file twice is one file, not two files.
  assert.equal(workSummary([{ kind: 'read', targetId: '/a.js' }, { kind: 'read', targetId: '/a.js' }]),
    '读取 1 个文件');
  // Two different files must never be collapsed into one call count.
  assert.equal(workSummary([{ kind: 'read', targetId: '/a.js' }, { kind: 'read', targetId: '/b.js' },
    { kind: 'read', targetId: '/a.js' }]), '读取 2 个文件');
  // One unknown target poisons the whole distinct count for that kind.
  assert.equal(workSummary([{ kind: 'read', targetId: '/a.js' }, { kind: 'read' }]), '读取 2 次');
  assert.equal(workSummary(['read', 'read', 'read'].map(() => ({ kind: 'read' }))), '读取 3 次');
  assert.equal(workSummary([{ kind: 'read', targetId: '/a.js' }, { kind: 'search' }]), '读取 1 个文件 · 搜索 1 次');
  // Web activity has no authorized page identity, so it stays a call count.
  assert.equal(workSummary([{ kind: 'web' }, { kind: 'web' }]), '浏览 2 次');
  assert.equal(workSummary([{ name: 'bash' }, { name: 'bash' }]), '运行 2 条命令');
  assert.equal(workSummary([{ kind: 'thinking' }, { kind: 'thinking' }]), '思考 2 次');
  assert.equal(workSummary([{ name: 'mystery-tool' }]), '执行 1 项工具');
  assert.equal(workSummary([]), '');
});
