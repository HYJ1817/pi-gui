/* Bounded native JSONL projection. No I/O, execution, arguments or output model.
 * Pi 1.4.0: agent-loop.createToolResultMessage + SessionManager.appendMessage.
 * Results prove recorded outcomes only, including hook errors/cancellation.
 */
const MAX_LINES = 4096;
const MAX_ITEMS = 100;
const NAMES = new Set(['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const safeName = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(value)
  && NAMES.has(value) ? value : 'unknown_tool';

/** lines and messageLines come from the same fd window; source positions stay private. */
export function projectHistoryTools(lines, { historyTruncated = false, messageLines = [], discardedMessages = 0 } = {}) {
  const end = lines.length - (lines.at(-1) === '' ? 1 : 0);
  const start = Math.max(1, end - MAX_LINES);
  const nodes = new Map(), calls = [], callCounts = new Map(), results = new Map();
  let invalid = false, foreignHeader = false;
  for (let index = start; index < end; index++) {
    if (!lines[index].trim()) continue;
    let entry;
    try { entry = JSON.parse(lines[index]); } catch { invalid = true; continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.type !== 'string') { invalid = true; continue; }
    if (entry.type === 'session') { foreignHeader = true; continue; }
    // Unlike the legacy text reader, only the audited nested message is evidence.
    const body = entry.type === 'message' ? entry.message : null;
    const native = body && typeof body === 'object' && !Array.isArray(body);
    if (entry.type === 'message' && !native) invalid = true;
    const node = { id: entry.id, parentId: entry.parentId, index,
      role: native ? body.role : null, message: entry.type === 'message' };
    if (validId(node.id)) {
      // Ambiguous entry identities poison every path through them, including earlier results.
      if (nodes.has(node.id)) { nodes.set(node.id, null); invalid = true; }
      else nodes.set(node.id, node);
    } else invalid = true;
    if (!native) continue;
    if (body.role === 'assistant' && !Array.isArray(body.content)) invalid = true;
    if (body.role === 'assistant' && Array.isArray(body.content)) {
      for (const part of body.content) {
        if (!part || part.type !== 'toolCall') continue;
        const id = validId(part.id) ? part.id : null;
        if (id) callCounts.set(id, (callCounts.get(id) || 0) + 1);
        calls.push({ id, name: typeof part.name === 'string' ? part.name : null, node });
      }
    } else if (body.role === 'toolResult') {
      const validContent = Array.isArray(body.content);
      if (!validContent) invalid = true;
      if (!validId(body.toolCallId)) { invalid = true; continue; }
      const previous = results.get(body.toolCallId);
      results.set(body.toolCallId, { count: (previous?.count || 0) + 1, node,
        name: typeof body.toolName === 'string' ? body.toolName : null, isError: validContent ? body.isError : null });
    }
  }

  const linked = (call, result) => {
    if (!validId(call.node.id) || nodes.get(call.node.id) !== call.node
      || nodes.get(result.node.id) !== result.node || result.node.index <= call.node.index) return false;
    let child = result.node;
    // A decreasing file index makes cycles/forward references fail without an unbounded walk.
    while (validId(child.parentId)) {
      const parent = nodes.get(child.parentId);
      if (!parent || parent.index >= child.index) return false;
      if (parent === call.node) return true;
      if (parent.message && parent.role !== 'toolResult') return false;
      child = parent;
    }
    return false;
  };
  const orphan = [...results.keys()].some(id => !callCounts.has(id));
  const truncated = start > 1 || calls.length > MAX_ITEMS;
  const messagePosition = line => {
    // Do not attach an old call to a newer turn after the 800-body-message cut.
    if (discardedMessages > 0 && line < messageLines[0]) return null;
    let low = 0, high = messageLines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (messageLines[middle] <= line) low = middle + 1;
      else high = middle;
    }
    return low; // Insert before messages[low], or append when low === messages.length.
  };
  const items = foreignHeader ? [] : calls.slice(-MAX_ITEMS).map(call => {
    const result = results.get(call.id);
    const confirmed = call.id && call.name && callCounts.get(call.id) === 1 && result?.count === 1
      && result.name === call.name && typeof result.isError === 'boolean' && linked(call, result);
    return { toolName: safeName(call.name), status: confirmed ? (result.isError ? 'error' : 'completed') : 'unknown',
      source: confirmed ? 'confirmed' : 'unconfirmed', messagePosition: messagePosition(call.node.index) };
  });
  return { items, returned: items.length, limit: MAX_ITEMS, truncated, historyTruncated,
    unavailableReason: items.length ? null : invalid || foreignHeader ? 'invalid_records'
      : orphan ? 'unmatched_results' : truncated ? 'summary_limit' : historyTruncated ? 'history_window' : 'no_tool_calls',
    uncertain: invalid || foreignHeader || orphan || truncated || historyTruncated || items.some(item => item.status === 'unknown') };
}
