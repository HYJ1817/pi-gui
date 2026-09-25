/* Pi adapter —— 当前唯一「主 Agent」，也是唯一能给出**工具级结构化事件**的适配器。
 *
 * ---------- 实测确定的调用方式（不要凭印象改） ----------
 *
 *   node <pkg>/dist/bundle/cli.js \
 *     --print --mode json \                     # 非交互 + JSONL 事件流
 *     --session-dir <PI_GUI_DATA>/planner-sessions \
 *     --session-id <planId>-<taskId> \          # 每个 task 一个独立会话
 *     --approve \                               # 信任项目本地资源（否则项目级 skill 不加载）
 *     [--provider P] [--model M] [--thinking L] \
 *     "<prompt>"
 *
 * 四条实测结论（都有运行时证据，别改回去）：
 *
 *   1. **stdin 必须关闭。** 不给 stdin 又让它空着，pi 会一直等输入 → 永久挂起。
 *      本模块的 runCli 用 `stdio:['ignore',...]`，stdin 立刻 EOF，所以正常。
 *
 *   2. **`--session-dir` 真的能隔离。** 实测：指定它之后，会话文件落在指定目录，
 *      `~/.pi/agent/sessions/` 里**没有**新增文件。这一点很重要 —— 主聊天用的是
 *      `--continue`（取该 cwd 下最近的会话），如果 Planner 的会话混进默认目录，
 *      用户下次聊天就会莫名其妙接上某个任务的上下文。
 *
 *   3. **退出码不可信。** 实测模型报 `402 Insufficient Balance` 时 pi 仍然 `exit 0`，
 *      失败只体现在事件里（`message_end.message.stopReason === "error"` +
 *      `errorMessage`）。所以判定成功必须同时看退出码和事件，只看退出码会把
 *      每一次失败都报成成功。
 *
 *   4. **`--mode json` 会把 system prompt 整段吐出来**（含工具定义、docs 路径、
 *      当前 cwd）。这些不能进 Timeline —— 既是噪音，也是不该展示给界面的东西。
 *      所以这里只认 `role === "assistant"` 的正文和工具事件。
 *
 * 事件映射（pi 的 JSONL → 本项目的统一执行事件）：
 *   tool_execution_start  → agent_tool（含 toolName / args）
 *   tool_execution_end    → agent_tool（含 toolName / isError）
 *   message_end(assistant)→ agent_output（正文）
 *   agent_settled         → 收尾信号
 *   message_end/…         → 记下 stopReason / errorMessage 用于判成败
 */
import path from 'node:path';
import { DEFAULT_MAX_STDOUT, DEFAULT_TIMEOUT_MS, resolveEntry, runCli } from './cli.js';

const PKG = '@earendil-works/pi-coding-agent';
const BIN = 'pi';

/** pi 的正文在 message.content 里；不同版本可能是字符串或 [{type,text}]。 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
    .map((c) => String(c.text || ''))
    .join('');
}

export function createPiAdapter({ env = process.env, sessionDir = null } = {}) {
  let cache = null;

  function detect() {
    if (cache) return cache;
    const entry = resolveEntry({ pkgName: PKG, binName: BIN, env });
    if (!entry.ok) {
      cache = {
        id: 'pi',
        name: 'Pi',
        description: 'pi coding agent（本机主 Agent）',
        available: false,
        version: entry.version || '',
        reason: entry.reason,
        detail: entry.detail,
        entry: null,
        capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false },
      };
      return cache;
    }
    cache = {
      id: 'pi',
      name: 'Pi',
      description: 'pi coding agent（本机主 Agent）',
      available: true,
      version: entry.version,
      reason: '',
      detail: '',
      entry,
      capabilities: {
        streaming: true,
        cancellation: true,
        // --session-id / --session-dir 已实测可用，同一 task 重试可以续上同一个会话
        resume: true,
        // pi 的 --mode json 会给 tool_execution_start/end —— 是唯一能出工具级时间线的
        toolEvents: true,
      },
    };
    return cache;
  }

  /** 构造 pi 的参数。**全部走 args 数组**，没有任何字符串拼接。 */
  function buildArgs({ task, prompt, sessionId, provider, model, thinking }) {
    const args = ['--print', '--mode', 'json', '--approve'];
    if (sessionDir) {
      args.push('--session-dir', sessionDir);
      if (sessionId) args.push('--session-id', sessionId);
    } else {
      // 没有可用的会话目录时宁可不落盘，也不要污染默认会话目录
      args.push('--no-session');
    }
    if (provider) args.push('--provider', provider);
    if (model) args.push('--model', model);
    if (thinking) args.push('--thinking', thinking);
    args.push(prompt);
    return args;
  }

  /**
   * 跑一个 task。
   * @returns {{success, exitCode, summary, error, rawResult, toolCalls, truncated, timedOut, cancelled}}
   */
  async function start({ task, prompt, cwd, signal = null, onEvent = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxStdoutBytes = DEFAULT_MAX_STDOUT, model = null, provider = null, thinking = null, sessionId = null }) {
    const info = detect();
    if (!info.available) {
      return { success: false, exitCode: null, summary: '', error: `${info.name} 不可用：${info.detail}`, rawResult: null, toolCalls: 0, truncated: false, timedOut: false, cancelled: false };
    }

    const args = buildArgs({ task, prompt, sessionId, provider, model, thinking });

    let assistantText = '';
    let lastAssistantText = '';
    let errorMessage = '';
    let stopReason = '';
    let toolCalls = 0;
    let sessionIdSeen = '';
    let events = 0;

    const handleLine = (line) => {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        // 非 JSON 行（极少见）当普通输出，不丢
        onEvent({ type: 'agent_output', data: { text: line, raw: true } });
        return;
      }
      events++;
      switch (evt.type) {
        case 'session':
          sessionIdSeen = String(evt.id || '');
          break;
        case 'tool_execution_start':
          toolCalls++;
          onEvent({
            type: 'agent_tool',
            data: { phase: 'start', toolName: String(evt.toolName || ''), toolCallId: String(evt.toolCallId || ''), args: evt.args ?? null },
          });
          break;
        case 'tool_execution_end':
          onEvent({
            type: 'agent_tool',
            data: { phase: 'end', toolName: String(evt.toolName || ''), toolCallId: String(evt.toolCallId || ''), isError: Boolean(evt.isError) },
          });
          break;
        case 'message_end': {
          const msg = evt.message || {};
          if (msg.role !== 'assistant') break; // system / user 一律不进 Timeline
          const text = textOf(msg.content);
          if (text) {
            assistantText += (assistantText ? '\n' : '') + text;
            lastAssistantText = text;
            onEvent({ type: 'agent_output', data: { text } });
          }
          if (msg.stopReason === 'error' || msg.errorMessage) {
            stopReason = String(msg.stopReason || 'error');
            errorMessage = String(msg.errorMessage || errorMessage);
          }
          break;
        }
        case 'agent_settled':
          onEvent({ type: 'agent_output', data: { text: '', settled: true } });
          break;
        default:
          break;
      }
    };

    const result = await runCli({
      entry: info.entry,
      args,
      cwd,
      env: {},
      timeoutMs,
      maxStdoutBytes,
      signal,
      onLine: handleLine,
    });

    /* 判定成败：退出码 **和** 事件都要看。
     * 只看退出码会把「模型报错但 pi 正常退出」判成成功（实测过 402 那次）。 */
    const failedByEvent = Boolean(errorMessage) || stopReason === 'error';
    const success = result.ok && !failedByEvent && events > 0;

    let error = '';
    if (result.timedOut) error = result.error || '超时';
    else if (result.cancelled) error = '已取消';
    else if (result.spawnFailed) error = result.error || '无法启动';
    else if (failedByEvent) error = errorMessage || '模型返回了错误';
    else if (result.exitCode !== 0) error = `退出码 ${result.exitCode}${result.stderr ? '：' + result.stderr.slice(0, 300) : ''}`;
    else if (events === 0) error = '没有收到任何事件（可能启动就失败了）';

    return {
      success,
      exitCode: result.exitCode,
      summary: lastAssistantText || assistantText.slice(-2000),
      error,
      rawResult: {
        events,
        toolCalls,
        stopReason,
        sessionId: sessionIdSeen,
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
    id: 'pi',
    name: 'Pi',
    description: 'pi coding agent（本机主 Agent，唯一提供工具级事件）',
    detect,
    start,
    /** 供测试用 */
    _buildArgs: buildArgs,
  };
}
