/* Codex adapter（OpenAI Codex CLI）。
 *
 * ---------- 实测确定的调用方式 ----------
 *
 *   node <pkg>/bin/codex.js exec \
 *     --json \                       # 事件流走 stdout，JSONL
 *     --skip-git-repo-check \        # 任务目录未必是 git 仓库
 *     -C <cwd> \                     # codex 自己的「工作根」
 *     --sandbox workspace-write \    # 显式指定，不吃用户 ~/.codex/config.toml 的默认值
 *     [-m <model>] \
 *     "<prompt>"
 *
 * 本机实测（codex-cli 0.144.1）：包 `@openai/codex`，bin 是 `bin/codex.js`（node 脚本，
 * 内部再拉起 Rust 二进制），所以走 `process.execPath` 跑它，**不需要 shell**。
 *
 * ---------- `--json` 的真实事件形状（实测拿到，不是猜的） ----------
 *
 *   {"type":"thread.started","thread_id":"01a0d7c0-…"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"error","message":"…"}}
 *   {"type":"turn.started"}
 *
 * 也就是说 codex 给的是 **item 级**事件（`item.type` 区分 agent_message /
 * command_execution / file_change / error …），比纯文本强，但不是 pi 那种
 * 工具调用级别的完整结构。所以这里做**保守映射**：
 *   - 认得出的 item 类型 → 映射成 agent_output / agent_tool
 *   - 认不出的 → 原样降级成一行 agent_output，**绝不伪造**工具事件（规格 §20）
 *
 * 失败判定同样不能只看退出码：本机实测 codex 在模型元数据缺失、网络失败等情况下
 * 会把错误放进 `item.type === "error"` 的 item 里，而进程可能仍以 0 退出。
 */
import { DEFAULT_MAX_STDOUT, DEFAULT_TIMEOUT_MS, resolveEntry, runCli } from './cli.js';

const PKG = '@openai/codex';
const BIN = 'codex';

/** codex 的 item.type → 我们的处理方式。认不出的走 fallback。 */
const ITEM_TEXT_TYPES = new Set(['agent_message', 'assistant_message', 'message', 'reasoning']);
const ITEM_TOOL_TYPES = new Set(['command_execution', 'file_change', 'patch_apply', 'mcp_tool_call', 'tool_call']);

function brief(value, max = 300) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function createCodexAdapter({ env = process.env } = {}) {
  let cache = null;

  function detect() {
    if (cache) return cache;
    const entry = resolveEntry({ pkgName: PKG, binName: BIN, env });
    const caps = { streaming: true, cancellation: true, resume: true, toolEvents: true };
    if (!entry.ok) {
      cache = {
        id: 'codex',
        name: 'Codex',
        description: 'OpenAI Codex CLI',
        available: false,
        version: entry.version || '',
        reason: entry.reason,
        detail: entry.detail,
        entry: null,
        capabilities: { ...caps, streaming: false, toolEvents: false },
      };
      return cache;
    }
    cache = {
      id: 'codex',
      name: 'Codex',
      description: 'OpenAI Codex CLI',
      available: true,
      version: entry.version,
      reason: '',
      detail: '',
      entry,
      capabilities: caps,
    };
    return cache;
  }

  function buildArgs({ prompt, cwd, model }) {
    // 全部走 args 数组；没有任何一处把 prompt 拼进命令行字符串
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '--sandbox', 'workspace-write'];
    if (model) args.push('-m', model);
    args.push(prompt);
    return args;
  }

  async function start({ prompt, cwd, signal = null, onEvent = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxStdoutBytes = DEFAULT_MAX_STDOUT, model = null }) {
    const info = detect();
    if (!info.available) {
      return { success: false, exitCode: null, summary: '', error: `${info.name} 不可用：${info.detail}`, rawResult: null, toolCalls: 0, truncated: false, timedOut: false, cancelled: false };
    }

    let summary = '';
    let errorMessage = '';
    let threadId = '';
    let toolCalls = 0;
    let events = 0;
    const unknown = [];

    const handleLine = (line) => {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        onEvent({ type: 'agent_output', data: { text: line, raw: true } });
        return;
      }
      events++;
      const type = String(evt.type || '');

      if (type === 'thread.started') {
        threadId = String(evt.thread_id || '');
        return;
      }
      if (type === 'turn.failed' || type === 'error') {
        errorMessage = brief(evt.message || evt.error || evt);
        onEvent({ type: 'agent_output', data: { text: errorMessage, level: 'error' } });
        return;
      }
      if (type !== 'item.completed' && type !== 'item.started' && type !== 'item.updated') {
        // 其它生命周期事件（turn.started / turn.completed / …）不往 Timeline 里塞噪音
        return;
      }

      const item = evt.item || {};
      const itemType = String(item.type || '');

      if (itemType === 'error') {
        errorMessage = brief(item.message || item.error || item);
        onEvent({ type: 'agent_output', data: { text: errorMessage, level: 'error' } });
        return;
      }
      if (ITEM_TEXT_TYPES.has(itemType)) {
        const text = brief(item.text || item.message || '', 8000);
        if (text) {
          if (itemType === 'agent_message' || itemType === 'assistant_message' || itemType === 'message') summary = text;
          onEvent({ type: 'agent_output', data: { text } });
        }
        return;
      }
      if (ITEM_TOOL_TYPES.has(itemType)) {
        toolCalls++;
        const label = brief(item.command || item.path || item.name || itemType, 200);
        onEvent({
          type: 'agent_tool',
          data: { phase: type === 'item.completed' ? 'end' : 'start', toolName: itemType, detail: label, isError: Boolean(item.error) },
        });
        return;
      }
      /* 认不出的 item 类型：降级成一行输出，并记进 rawResult 供排查。
       * 不猜、不编成工具事件 —— 编出来的时间线比没有更糟。 */
      unknown.push(itemType || type);
      onEvent({ type: 'agent_output', data: { text: brief(item, 500), raw: true } });
    };

    const result = await runCli({
      entry: info.entry,
      args: buildArgs({ prompt, cwd, model }),
      cwd,
      env: {},
      timeoutMs,
      maxStdoutBytes,
      signal,
      onLine: handleLine,
    });

    const success = result.ok && !errorMessage && events > 0;
    let error = '';
    if (result.timedOut) error = result.error || '超时';
    else if (result.cancelled) error = '已取消';
    else if (result.spawnFailed) error = result.error || '无法启动';
    else if (errorMessage) error = errorMessage;
    else if (result.exitCode !== 0) error = `退出码 ${result.exitCode}${result.stderr ? '：' + result.stderr.slice(0, 300) : ''}`;
    else if (events === 0) error = '没有收到任何事件';

    return {
      success,
      exitCode: result.exitCode,
      summary,
      error,
      rawResult: {
        events,
        toolCalls,
        threadId,
        unknownItemTypes: [...new Set(unknown)].slice(0, 10),
        stdoutBytes: result.stdoutBytes,
        stderr: result.stderr.slice(0, 4000),
      },
      toolCalls,
      truncated: result.truncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
    };
  }

  return {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex CLI（非交互 exec --json，item 级事件）',
    detect,
    start,
    _buildArgs: buildArgs,
  };
}
