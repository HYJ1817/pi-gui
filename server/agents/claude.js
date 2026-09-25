/* Claude Code adapter（Anthropic）。
 *
 * ⚠️ **本机不可用，且本适配器的调用方式未在本机执行验证。**
 *
 * 实测：npm 包 `@anthropic-ai/claude-code@2.1.142` **装着**，但它的入口
 * `bin/claude.exe` 不存在 —— 目录里只有 `claude.exe.old.1786171336951`（228 MB）。
 * 这是「安装损坏」（更新中断 / 二进制被杀软隔离），和「压根没装」是两回事，
 * 所以 detect() 会区分 `entry-missing` 并把缺失路径报出来，而不是笼统说「未安装」。
 * 用户修好之后不需要改这里的代码。
 *
 * 调用方式取自**已安装版本的官方 CLI 文档**（`claude --help` 本身不完整，官方明确
 * 说明「a flag's absence from --help does not mean it is unavailable」，所以查的是
 * 官方 cli-reference）：
 *
 *   claude -p --output-format stream-json --verbose \
 *     --permission-mode acceptEdits \
 *     --permission-prompts none \
 *     --no-session-persistence \
 *     [--model M] \
 *     "<prompt>"
 *
 * 几个刻意的选择：
 *   - **没有 `--cwd` 这个通用标志**（只有 `claude agents --cwd`）。工作目录只能靠
 *     进程的 cwd 决定，所以 spawn 时必须显式传 cwd —— 本模块正是这么做的。
 *   - `--permission-prompts none`：非交互场景没有人能应答权限提示。官方语义是
 *     「无人可应答时直接拒绝」，于是**不会挂死**。这比 `bypassPermissions` 安全得多，
 *     代价是没被自动批准的操作会被拒 —— 对第一版「可控优先」是合适的取舍。
 *   - `--no-session-persistence`：print 模式专用，不落盘、不可 resume。
 *     这样 Planner 任务不会往默认会话目录里塞东西（和 pi 的 `--session-dir` 同一个目的）。
 *     代价是 `capabilities.resume = false`。
 *
 * `--verbose` 与 `--output-format stream-json` 的搭配、以及 `--permission-prompts`
 * 的可用版本，都需要在 claude 修好后**真跑一次确认**（见 notes）。
 */
import { DEFAULT_MAX_STDOUT, DEFAULT_TIMEOUT_MS, resolveEntry, runCli } from './cli.js';

const PKG = '@anthropic-ai/claude-code';
const BIN = 'claude';

function brief(value, max = 400) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function createClaudeAdapter({ env = process.env } = {}) {
  let cache = null;

  function detect() {
    if (cache) return cache;
    const entry = resolveEntry({ pkgName: PKG, binName: BIN, env });
    if (!entry.ok) {
      cache = {
        id: 'claude',
        name: 'Claude Code',
        description: 'Anthropic Claude Code CLI',
        available: false,
        version: entry.version || '',
        reason: entry.reason,
        detail: entry.detail,
        entry: null,
        capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false },
        notes: entry.reason === 'entry-missing' ? ['安装不完整：包在但可执行入口缺失，重装 @anthropic-ai/claude-code 即可恢复'] : [],
      };
      return cache;
    }
    cache = {
      id: 'claude',
      name: 'Claude Code',
      description: 'Anthropic Claude Code CLI',
      available: true,
      version: entry.version,
      reason: '',
      detail: '',
      entry,
      capabilities: { streaming: true, cancellation: true, resume: false, toolEvents: true },
      notes: ['调用方式按官方 cli-reference 实现，但未在本机执行验证过'],
    };
    return cache;
  }

  function buildArgs({ prompt, model }) {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      // 非交互场景没有人应答权限提示 —— 显式声明「无人应答」而不是挂死等输入
      '--permission-prompts',
      'none',
      '--no-session-persistence',
    ];
    if (model) args.push('--model', model);
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
    let sessionId = '';
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

      if (evt.session_id) sessionId = String(evt.session_id);
      if (type === 'result') {
        if (evt.is_error) {
          errorMessage = brief(evt.result || evt.error || '执行失败');
          onEvent({ type: 'agent_output', data: { text: errorMessage, level: 'error' } });
        } else if (typeof evt.result === 'string' && evt.result) {
          summary = brief(evt.result, 8000);
          onEvent({ type: 'agent_output', data: { text: summary } });
        }
        return;
      }
      if (type === 'assistant') {
        const content = evt.message && evt.message.content;
        const parts = Array.isArray(content) ? content : [];
        for (const part of parts) {
          if (part && part.type === 'text' && part.text) {
            summary = brief(part.text, 8000);
            onEvent({ type: 'agent_output', data: { text: part.text } });
          } else if (part && part.type === 'tool_use') {
            toolCalls++;
            onEvent({ type: 'agent_tool', data: { phase: 'start', toolName: String(part.name || ''), detail: brief(part.input, 200) } });
          }
        }
        return;
      }
      if (type === 'user') {
        // 工具结果回灌：只记数量，不把结果正文塞进 Timeline（可能很大）
        const content = evt.message && evt.message.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part && part.type === 'tool_result') {
              onEvent({ type: 'agent_tool', data: { phase: 'end', toolName: String(part.tool_use_id || 'tool'), isError: Boolean(part.is_error) } });
            }
          }
        }
        return;
      }
      unknown.push(type || '(无 type)');
      onEvent({ type: 'agent_output', data: { text: brief(evt, 500), raw: true } });
    };

    const result = await runCli({
      entry: info.entry,
      args: buildArgs({ prompt, model }),
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
      rawResult: { events, toolCalls, sessionId, unknownTypes: [...new Set(unknown)].slice(0, 10), stdoutBytes: result.stdoutBytes, stderr: result.stderr.slice(0, 4000) },
      toolCalls,
      truncated: result.truncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
    };
  }

  return {
    id: 'claude',
    name: 'Claude Code',
    description: 'Anthropic Claude Code CLI（-p --output-format stream-json）',
    detect,
    start,
    _buildArgs: buildArgs,
  };
}
