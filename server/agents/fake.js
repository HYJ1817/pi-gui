/* fake-agent —— 测试用适配器（规格 §49）。
 *
 * 存在的理由很具体：**Scheduler 的端到端行为不能靠真实模型来测**。真跑一次 pi/codex
 * 既慢、又花钱、还不确定（本机 pi 的 provider 余额就是 0，实测直接报 402）。
 * 而 Scheduler 要验的是「依赖解锁、失败暂停、重试 attempt++、取消语义、崩溃恢复」
 * 这些**与模型无关**的逻辑。所以给一个确定性的进程内适配器，让这些逻辑可以被
 * 完整、可重复地验证。
 *
 * 它同时是 §45「Planner ≠ Executor」的证明：即使一个 AI Planner 都没有，
 * 手工建 Plan + fake executor 也能跑完整条链路。
 *
 * 行为按 taskId 配置，每个 attempt 消耗一条：
 *
 *   createFakeAdapter({ behaviors: {
 *     'task-1': [{ ok: true, summary: '读完了', toolCalls: 2 }],
 *     'task-2': [{ ok: true, writes: [{ path: 'out.txt', content: 'hi' }] }],
 *     'task-3': [{ ok: false, error: '第一次故意失败' }, { ok: true, summary: '第二次成功' }],
 *     'task-4': [{ hang: true }],          // 一直等，直到被取消
 *     'task-5': [{ slowMs: 300, ok: true }],
 *   }})
 *
 * **刻意不 spawn 任何进程** —— 进程层面的东西（ENOENT / 超时 / 进程树 kill / stdout
 * 截断）由 tests/agents.cjs 直接打 server/agents/cli.js 来测，那里用的是真的子进程。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BEHAVIOR = { ok: true, summary: '（fake agent 默认成功）' };

export function createFakeAdapter({ behaviors = {}, env = process.env } = {}) {
  let behaviorsRef = behaviors;
  const attempts = new Map();
  const seen = [];

  function nextOutcome(taskId) {
    const n = (attempts.get(taskId) || 0) + 1;
    attempts.set(taskId, n);
    const list = behaviorsRef[taskId];
    if (!list || list.length === 0) return DEFAULT_BEHAVIOR;
    return list[Math.min(n - 1, list.length - 1)];
  }

  async function start({ task, cwd, signal = null, onEvent = () => {} }) {
    const taskId = task && task.id;
    const outcome = nextOutcome(taskId);
    seen.push({ taskId, cwd, attempt: attempts.get(taskId) });

    onEvent({ type: 'agent_output', data: { text: `fake-agent 开始执行 ${taskId}` } });

    if (outcome.hang) {
      // 一直等到被取消 —— 用来验证「停止 Plan 会真的把正在跑的 task 收成 cancelled」
      await new Promise((resolve) => {
        if (signal && signal.aborted) return resolve();
        const t = setTimeout(resolve, 60 * 1000);
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true }
          );
        }
      });
      onEvent({ type: 'agent_tool', data: { phase: 'end', toolName: 'fake', isError: false } });
      return { success: false, exitCode: null, summary: '', error: '已取消', rawResult: { fake: true }, toolCalls: 0, truncated: false, timedOut: false, cancelled: true };
    }

    if (outcome.slowMs) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, outcome.slowMs);
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true }
          );
        }
      });
      if (signal && signal.aborted) {
        return { success: false, exitCode: null, summary: '', error: '已取消', rawResult: { fake: true }, toolCalls: 0, truncated: false, timedOut: false, cancelled: true };
      }
    }

    // 工具事件：让「Timeline 联动」这条也有东西可断言
    const toolCalls = Number(outcome.toolCalls || 0);
    for (let i = 0; i < toolCalls; i++) {
      onEvent({ type: 'agent_tool', data: { phase: 'start', toolName: 'read', detail: `file-${i}.js` } });
      onEvent({ type: 'agent_tool', data: { phase: 'end', toolName: 'read', isError: false } });
    }

    if (Array.isArray(outcome.writes)) {
      for (const w of outcome.writes) {
        const target = path.resolve(cwd, w.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(w.content ?? ''), 'utf8');
        onEvent({ type: 'agent_tool', data: { phase: 'end', toolName: 'write', detail: w.path, isError: false } });
      }
    }

    if (outcome.ok === false) {
      const error = String(outcome.error || 'fake-agent 故意失败');
      onEvent({ type: 'agent_output', data: { text: error, level: 'error' } });
      return { success: false, exitCode: 1, summary: '', error, rawResult: { fake: true }, toolCalls, truncated: false, timedOut: false, cancelled: false };
    }

    const summary = String(outcome.summary || '（fake agent 成功）');
    onEvent({ type: 'agent_output', data: { text: summary } });
    return { success: true, exitCode: 0, summary, error: '', rawResult: { fake: true }, toolCalls, truncated: false, timedOut: false, cancelled: false };
  }

  return {
    id: 'fake',
    name: 'Fake Agent',
    description: '测试用适配器：确定性、进程内、不消耗任何额度',
    isTestOnly: true,
    detect: () => ({
      id: 'fake',
      name: 'Fake Agent',
      description: '测试用适配器：确定性、进程内、不消耗任何额度',
      available: true,
      version: 'test',
      reason: '',
      detail: '',
      entry: null,
      capabilities: { streaming: true, cancellation: true, resume: false, toolEvents: true },
      notes: ['这是测试用适配器，不是真实 Agent'],
      testOnly: true,
    }),
    start,
    /** 测试用：换一组行为并清空 attempt 计数（同一个 registry 复用多个场景时要用）。 */
    setBehaviors(next = {}) {
      behaviorsRef = next;
      attempts.clear();
      seen.length = 0;
    },
    /** 测试用：看过哪些 task 被真正执行过 */
    _seen: () => seen.slice(),
    _attempts: () => new Map(attempts),
  };
}
