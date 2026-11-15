/* 轮次终态：Classic 与 Runtime 共用的纯模型 + 小视图。
 *
 * 只回答一个问题：这一轮**根据真实证据**是怎么结束的。
 * 它不读取 store、不发请求、不写会话文件；调用方把证据传进来。
 *
 * 证据边界（审计文档 5.4 / O-02）：
 *   - 轮次 failed 只接受轮次级证据（assistant 的 stopReason/errorMessage）；
 *   - 工具结果 isError 只计入 toolFailures，不能把整轮判成 failed；
 *   - 没有证据就不返回结果，不伪造 completed；
 *   - 时长只在起止都真实存在时显示，缺就省略。
 */

const STATE_LABEL = {
  completed: '已完成',
  stopped: '已停止',
  failed: '失败',
  unsettled: '未完成',
};

const UNFINISHED_TOOL_STATES = new Set(['running', 'waiting', 'incomplete', 'cancelled', 'unknown']);

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** 与 tool-model.formatDuration 同一格式；缺值返回空串。 */
export function formatTurnDuration(ms) {
  if (!finite(ms) || ms < 0) return '';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * @param {{
 *   tools?: Array<{status?: string}>,
 *   lastAssistant?: {failed?: boolean, stopped?: boolean, interrupted?: boolean}|null,
 *   contentUnsettled?: boolean,
 *   interruptedToolTerminal?: boolean|null, // 中断是否发生在最后一次成功内容之后
 *   startedAt?: number|null,
 *   endedAt?: number|null
 * }} evidence
 * @returns {null|{
 *   state: 'completed'|'stopped'|'failed'|'unsettled',
 *   label: string,
 *   durationMs: number|null,
 *   toolCount: number,
 *   toolFailures: number,
 *   toolInterruptions: number,
 *   unfinishedTools: number
 * }}
 */
export function deriveTurnOutcome({
  tools = [],
  lastAssistant = null,
  contentUnsettled = false,
  interruptedToolTerminal = null,
  startedAt = null,
  endedAt = null,
} = {}) {
  const states = Array.isArray(tools)
    ? tools.map(tool => String(tool?.status ?? tool?.state ?? ''))
    : [];
  const toolCount = states.length;
  const toolFailures = states.filter(status => status === 'error').length;
  const toolInterruptions = states.filter(status => status === 'interrupted').length;
  const unfinishedTools = states.filter(status => UNFINISHED_TOOL_STATES.has(status)).length;
  const interruptedTool = toolInterruptions > 0;
  const hasEvidence = Boolean(lastAssistant) || toolCount > 0 || contentUnsettled;
  if (!hasEvidence) return null;

  /* 一个较早被中断、随后又成功完成的工具不能把整轮判成“已停止”。
   * 只有中断发生在最后一次成功内容之后（或根本没有最终内容）才作为轮次终态；
   * 调用方有顺序证据时应显式传入，缺省只保守处理“没有最终内容”的情况。 */
  const terminalInterruption = interruptedToolTerminal === true
    || (interruptedToolTerminal == null && interruptedTool && !lastAssistant
      && states.length > 0 && states[states.length - 1] === 'interrupted');

  let state;
  if (lastAssistant?.failed) state = 'failed';
  else if (lastAssistant?.stopped || lastAssistant?.interrupted || terminalInterruption) state = 'stopped';
  else if (contentUnsettled || unfinishedTools > 0) state = 'unsettled';
  else state = 'completed';

  const interrupted = state === 'stopped'
    && lastAssistant?.stopped !== true
    && (lastAssistant?.interrupted === true || terminalInterruption);
  const label = interrupted ? '已中断' : STATE_LABEL[state];
  const durationMs = finite(startedAt) && finite(endedAt) && endedAt >= startedAt
    ? endedAt - startedAt
    : null;

  return { state, label, durationMs, toolCount, toolFailures, toolInterruptions, unfinishedTools };
}

function span(className, text = '') {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/** 画一行轮次终态。文本一律走 textContent，不解析任何外部 HTML。 */
export function renderTurnOutcome(outcome) {
  if (!outcome) return null;
  const root = document.createElement('div');
  root.className = 'turn-outcome';
  const line = document.createElement('div');
  line.className = 'turn-outcome-line';
  line.setAttribute('role', 'status');
  const dot = span('turn-outcome-dot');
  dot.setAttribute('aria-hidden', 'true');
  const label = span('turn-outcome-label');
  const meta = span('turn-outcome-meta');
  line.append(dot, label, meta);
  root.append(line);
  root._turnOutcome = { line, dot, label, meta };
  updateTurnOutcome(root, outcome);
  return root;
}

/** 就地更新，不重建节点。 */
export function updateTurnOutcome(node, outcome) {
  const p = node?._turnOutcome;
  if (!p || !outcome) return false;
  node.dataset.state = outcome.state;
  if (p.label.textContent !== outcome.label) p.label.textContent = outcome.label;

  const parts = [];
  const duration = formatTurnDuration(outcome.durationMs);
  if (duration) parts.push(duration);
  if (outcome.toolCount > 0) parts.push(`${outcome.toolCount} 次工具`);
  if (outcome.toolFailures > 0) parts.push(`${outcome.toolFailures} 次工具失败`);
  if (outcome.toolInterruptions > 0) parts.push(`${outcome.toolInterruptions} 次工具中断`);
  if (outcome.unfinishedTools > 0) parts.push(`${outcome.unfinishedTools} 次工具未完成`);
  const meta = parts.length ? ' · ' + parts.join(' · ') : '';
  if (p.meta.textContent !== meta) p.meta.textContent = meta;
  return true;
}
