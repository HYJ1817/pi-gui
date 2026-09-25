/* Gemini CLI adapter（@google/gemini-cli）。
 *
 * 本机实测：0.50.0，包 `@google/gemini-cli`，bin 是 `bundle/gemini.js`（node 脚本）。
 *
 * 调用方式取自**已安装版本的 `gemini --help`**（不是印象）：
 *
 *   node <pkg>/bundle/gemini.js -p "<prompt>" \
 *     --approval-mode auto_edit \     # 自动批准文件编辑，但不 yolo 全部
 *     --skip-trust \                  # 信任当前工作区（否则会卡在信任确认）
 *     [-m <model>] [--session-id <id>]
 *
 * 与 pi / codex 的关键差别（这个差别必须如实暴露给 UI）：
 *   - **`--help` 里没有任何 `--output-format` / `--json`**，也就是**没有机器可解析的
 *     事件流**。所以这里只能把 stdout 当文本逐行推出去，`capabilities.toolEvents = false`。
 *     按规格 §20，此时**降级成「● Agent 正在执行 + stdout 摘要」，不伪造 read/edit/bash
 *     工具事件** —— 伪造出来的时间线比没有时间线更糟。
 *   - gemini 没有类似 pi `--session-dir` 的「会话目录」开关，会话落在它自己的存储里。
 *     第一版不额外做隔离（不是我们的目录，也不会污染 pi 的会话），但这一点在
 *     `notes` 里说明。
 *   - `-r/--resume` 与 `--session-id` 都在，所以 retry 可以续同一个会话。
 */
import { DEFAULT_MAX_STDOUT, DEFAULT_TIMEOUT_MS, resolveEntry, runCli } from './cli.js';

const PKG = '@google/gemini-cli';
const BIN = 'gemini';

export function createGeminiAdapter({ env = process.env } = {}) {
  let cache = null;

  function detect() {
    if (cache) return cache;
    const entry = resolveEntry({ pkgName: PKG, binName: BIN, env });
    if (!entry.ok) {
      cache = {
        id: 'gemini',
        name: 'Gemini CLI',
        description: 'Google Gemini CLI',
        available: false,
        version: entry.version || '',
        reason: entry.reason,
        detail: entry.detail,
        entry: null,
        capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false },
        notes: [],
      };
      return cache;
    }
    cache = {
      id: 'gemini',
      name: 'Gemini CLI',
      description: 'Google Gemini CLI',
      available: true,
      version: entry.version,
      reason: '',
      detail: '',
      entry,
      capabilities: {
        streaming: true,
        cancellation: true,
        resume: true,
        // 没有 --json，拿不到工具级事件 —— 这一条会直接影响 Timeline 的呈现粒度
        toolEvents: false,
      },
      notes: ['该 CLI 没有 JSON 事件流，Timeline 只能显示 stdout 文本摘要（不伪造工具事件）'],
    };
    return cache;
  }

  function buildArgs({ prompt, model, sessionId }) {
    const args = ['-p', prompt, '--approval-mode', 'auto_edit', '--skip-trust'];
    if (model) args.push('-m', model);
    if (sessionId) args.push('--session-id', sessionId);
    return args;
  }

  async function start({ prompt, cwd, signal = null, onEvent = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxStdoutBytes = DEFAULT_MAX_STDOUT, model = null, sessionId = null }) {
    const info = detect();
    if (!info.available) {
      return { success: false, exitCode: null, summary: '', error: `${info.name} 不可用：${info.detail}`, rawResult: null, toolCalls: 0, truncated: false, timedOut: false, cancelled: false };
    }

    let lineCount = 0;
    let lastLine = '';

    const handleLine = (line) => {
      lineCount++;
      const text = line.trim();
      if (!text) return;
      lastLine = text;
      // 没有结构化事件可解析：整行作为输出推出去（前端按不可信文本渲染）
      onEvent({ type: 'agent_output', data: { text, raw: true } });
    };

    const result = await runCli({
      entry: info.entry,
      args: buildArgs({ prompt, model, sessionId }),
      cwd,
      env: {},
      timeoutMs,
      maxStdoutBytes,
      signal,
      onLine: handleLine,
    });

    /* gemini 没有结构化错误字段，只能靠退出码 + stderr。
     * 这是它的能力上限，不是本适配器的偷懒 —— 所以 success 判据里不假装有更多信号。 */
    const success = result.ok;
    let error = '';
    if (result.timedOut) error = result.error || '超时';
    else if (result.cancelled) error = '已取消';
    else if (result.spawnFailed) error = result.error || '无法启动';
    else if (result.exitCode !== 0) error = `退出码 ${result.exitCode}${result.stderr ? '：' + result.stderr.slice(0, 300) : ''}`;

    return {
      success,
      exitCode: result.exitCode,
      summary: lastLine.slice(0, 2000),
      error,
      rawResult: { lines: lineCount, stdoutBytes: result.stdoutBytes, stderr: result.stderr.slice(0, 4000) },
      toolCalls: 0,
      truncated: result.truncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
    };
  }

  return {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI（无 JSON 事件流，仅文本摘要）',
    detect,
    start,
    _buildArgs: buildArgs,
  };
}
