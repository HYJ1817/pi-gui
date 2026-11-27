/* Reconstruct a P5 view from an authorized native path and persisted metadata.
 * The sidecar proves boundaries; content is read from Pi every time. */
import { activePath } from './session-edit-target.js';
import { projectHtmlArtifacts } from './html-artifact-projection.js';
import { readSessionText } from './session-history.js';
import { sessionMessageBody } from './pi-compat.js';
import { matchExecutionTimelineRecords } from './execution-timeline-store.js';
import { createExecutionToolProjection } from './execution-timeline.js';
import { boundText, contentText, MAX_BLOCK_TEXT, MAX_CONTENT_SEGMENTS, MAX_USER_TEXT,
  safeToolName, timelineFromMessages, usageProjection } from '../public/runtime-timeline.js';
import { PLAN_TOOL_NAME } from '../lib/execution-timeline-contract.js';

const MAX_ENTRIES = 4096;
const MAX_MESSAGES = 800;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ROLES = new Set(['user', 'assistant', 'toolResult']);
const MODEL_KEY = /^[A-Za-z0-9_.:/-]{1,160}$/;

export function runtimeExecutionIdentity(owner) {
  return { kind: 'runtime', projectId: owner?.projectId, workspaceId: owner?.workspaceId,
    conversationId: owner?.conversationId, sessionId: owner?.sessionId || owner?.nativeSessionId };
}

function timing(startedAt, endedAt, durationMs) {
  return { startedAt: startedAt ?? null, endedAt: endedAt ?? null,
    durationMs: durationMs ?? (startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : null),
    evidence: durationMs != null ? 'recorded' : startedAt != null ? 'observed' : 'unknown' };
}

const position = (sequence, part = 0) => ({ domain: 'history', stream: 'native', sequence, part });

function activityItems(turnId, rows, recordedTools) {
  const records = new Map(recordedTools.map((tool, startOrder) => [turnId + ':tool:' + tool.resultId, { tool, startOrder }]));
  const items = [];
  let declarations = new Map();
  let projector = null;
  for (const row of rows) {
    const message = row.body;
    if (message.role === 'assistant') {
      declarations = new Map();
      projector = createExecutionToolProjection();
      for (const [part, call] of (Array.isArray(message.content) ? message.content : []).entries()) {
        if (part >= MAX_CONTENT_SEGMENTS || call?.type !== 'toolCall' || typeof call.id !== 'string') continue;
        if (declarations.has(call.id)) { declarations.set(call.id, null); continue; }
        declarations.set(call.id, { call, part, row });
        projector.observe({ type: 'tool_execution_start', toolCallId: call.id,
          toolName: safeToolName(call.name), args: call.arguments });
      }
    } else if (message.role === 'user') {
      declarations.clear();
    } else if (message.role === 'toolResult') {
      const declaration = declarations.get(message.toolCallId);
      declarations.delete(message.toolCallId);
      if (!declaration) continue;
      const { call, part, row: response } = declaration;
      const toolName = safeToolName(call.name);
      if (toolName === PLAN_TOOL_NAME || toolName !== safeToolName(message.toolName)) continue;
      const id = turnId + ':tool:' + row.id;
      const recorded = records.get(id)?.tool;
      const duration = recorded?.durationMs ?? (Number.isFinite(message.durationMs) && message.durationMs >= 0
        ? Math.min(message.durationMs, 24 * 60 * 60 * 1000) : undefined);
      const status = message.isError === true ? 'failed' : message.isError === false ? 'completed'
        : recorded?.status ?? 'unknown';
      const summary = projector?.observe({ type: 'tool_execution_end', toolCallId: call.id,
        toolName, isError: status === 'failed', result: { details: message.details } });
      items.push({
        id, turnId, parentId: turnId + ':activity', callId: call.id, toolName,
        kind: toolName === 'subagent' ? 'subagent' : 'tool',
        status, title: summary?.title || toolName, ...(summary ? { summary } : {}),
        position: position(response.index, part), timing: timing(recorded?.startedAt, recorded?.endedAt, duration),
        ...(recorded?.viewAlias ? { viewAlias: recorded.viewAlias } : {}),
        detailRef: { id, source: 'native-entry', state: 'restricted' },
      });
    }
  }
  if (items.every(item => records.has(item.id))) {
    for (const item of items) item.position.part = records.get(item.id).startOrder;
  }
  return items.sort((a, b) => a.position.sequence - b.position.sequence || a.position.part - b.position.part);
}

function usageRows(rows) {
  const usage = [];
  for (const row of rows) {
    const message = row.body;
    if (message.role !== 'assistant') continue;
    const recorded = usageProjection(message.usage);
    if (!recorded) continue;
    const model = typeof message.model === 'string' && MODEL_KEY.test(message.model) ? {
      id: message.model,
      ...(typeof message.provider === 'string' && MODEL_KEY.test(message.provider) ? { provider: message.provider } : {}),
    } : null;
    usage.push({ responseId: row.id, recorded, position: position(row.index), ...(model ? { model } : {}) });
  }
  return usage;
}

function declaredIds(body) {
  if (body.role !== 'assistant' || !Array.isArray(body.content)) return [];
  return body.content.filter(part => part?.type === 'toolCall' && typeof part.id === 'string').map(part => part.id);
}

function repeatedCalls(messages) {
  const seen = new Set(), repeated = new Set();
  for (const body of messages) {
    for (const id of declaredIds(body)) {
      if (seen.has(id)) repeated.add(id);
      seen.add(id);
    }
  }
  return repeated;
}

export function projectExecutionHistory(entries, records, { sessionId, leafId, classic = false, editable = false } = {}) {
  if (typeof sessionId !== 'string' || !sessionId || typeof leafId !== 'string'
      || !Array.isArray(entries) || !entries.length || entries.length > MAX_ENTRIES || !records?.length) return null;
  const branch = activePath(entries, leafId);
  if (!branch) return null;
  // Native edit ordinals are relative to Pi's effective context, not the
  // full branch. On modified context the original authorized reader owns it.
  if (editable && branch.some(entry => entry.type === 'compaction' || entry.type === 'context_edit')) return null;
  const matched = matchExecutionTimelineRecords(records, branch, leafId);
  if (!matched.length) return null;
  const rows = [];
  const rowById = new Map();
  let userIndex = -1;
  for (const entry of branch) {
    const body = sessionMessageBody(entry);
    if (entry.type !== 'message' || !ROLES.has(body?.role)) continue;
    if (body.role === 'user') userIndex++;
    const row = { id: entry.id, body, userIndex: Math.max(0, userIndex), index: rows.length, timestamp: entry.timestamp || null };
    rows.push(row);
    rowById.set(row.id, row);
  }
  const raw = rows.map(row => projectHtmlArtifacts(row.body));
  if (classic && Buffer.byteLength(JSON.stringify(raw)) > MAX_BODY_BYTES) return null;
  const ambiguous = classic ? repeatedCalls(raw) : null;
  const sourceById = new Map();
  const execution = timelineFromMessages(raw, {
    nativePath: true,
    messageMeta: rows.map(row => ({ messageId: row.id, userIndex: row.userIndex })),
    onBlock: (id, index) => sourceById.set(id, index),
  });
  const blocksBySource = new Map();
  for (const block of execution.blocks) {
    const index = sourceById.get(block.id);
    if (!blocksBySource.has(index)) blocksBySource.set(index, []);
    blocksBySource.get(index).push(block);
  }

  const turns = [];
  for (const record of matched) {
    const members = record.entries.map(entry => rowById.get(entry.id)).filter(Boolean);
    const first = members[0];
    const last = members.at(-1);
    if (first?.body.role !== 'user' || first.id !== record.inputId || !last) continue;
    // Classic's existing native tool DOM uses a session-wide result lookup.
    // A repeated call ID cannot be adopted as an authoritative detail there.
    if (ambiguous?.size && members.some(row => declaredIds(row.body).some(id => ambiguous.has(id)))) continue;
    const blocks = members.flatMap(row => blocksBySource.get(row.index) || []);
    const firstBlock = blocks[0];
    if (!classic && (firstBlock?.kind !== 'user' || firstBlock.messageId !== first.id
        || blocks.length === 0 || blocks.some(block => block.truncated))) continue;
    const id = 'native-turn:' + first.id;
    const items = activityItems(id, members, record.tools);
    const itemTimes = items.map(item => item.timing);
    const starts = itemTimes.map(value => value.startedAt).filter(Number.isFinite);
    const ends = itemTimes.map(value => value.endedAt).filter(Number.isFinite);
    const group = items.length ? {
      id: id + ':activity', turnId: id, status: items.some(item => item.status === 'failed') ? 'failed'
        : items.every(item => item.status === 'completed') ? 'completed' : 'incomplete',
      timing: timing(starts.length && starts.length === itemTimes.length ? Math.min(...starts) : null,
        ends.length && ends.length === itemTimes.length ? Math.max(...ends) : null),
      itemIds: items.map(item => item.id),
    } : null;
    turns.push({
      id, sessionId, status: record.status, timing: timing(record.timing.startedAt, record.timing.endedAt),
      position: position(first.index), completeness: record.status === 'unknown' ? 'partial' : 'complete',
      input: { id: first.id, userIndex: first.userIndex },
      additionalInputs: members.slice(1).filter(row => row.body.role === 'user')
        .map(row => ({ id: row.id, userIndex: row.userIndex })),
      from: first.index, through: last.index, entryIds: members.map(row => row.id),
      finalResponseId: record.finalResponseId, blockIds: blocks.map(block => block.id),
      ...(record.viewAlias ? { viewAlias: record.viewAlias } : {}),
      usage: usageRows(members), group, items,
    });
  }
  if (!turns.length) return null;
  const shown = [];
  let bytes = 0;
  let truncated = execution.truncated;
  for (let index = rows.length - 1; index >= 0; index--) {
    const { body, id, userIndex, timestamp } = rows[index];
    if (body.role === 'toolResult') continue;
    const text = boundText(contentText(body.content), body.role === 'user' ? MAX_USER_TEXT : MAX_BLOCK_TEXT);
    if (!text.text) continue;
    bytes += Buffer.byteLength(text.text);
    if (shown.length >= MAX_MESSAGES || bytes > MAX_BODY_BYTES) { truncated = true; break; }
    shown.push({ role: body.role, text: text.text, messageId: id, userIndex, timestamp });
    truncated ||= text.truncated;
  }
  const p5 = { version: 1, sessionId, leafId, completeness: truncated || turns.some(turn => turn.completeness === 'partial')
    ? 'partial' : 'complete', turns };
  return { ok: true, sessionId, messages: classic ? raw : shown.reverse(), truncated,
    execution: { timeline: execution.blocks, planBoundary: execution.planBoundary, truncated, p5 } };
}

/* Closed Runtime history has no live manager to prove the leaf. A persisted
 * checkpoint is used only if it also reaches the last persisted native node.
 * A newer or ambiguous branch continues through the existing history reader. */
export function readStoredExecutionHistory(file, target, records) {
  if (!target?.sessionIdentity || !target.sessionId || !records?.length) return null;
  const result = readSessionText(file, { expected: target, maxBytes: MAX_BODY_BYTES, stable: true });
  if (!result.ok || result.truncated) return null;
  try {
    const [, ...body] = result.text.split('\n');
    const entries = [];
    for (const line of body) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (!row || typeof row.id !== 'string') return null;
      entries.push(row);
      if (entries.length > MAX_ENTRIES) return null;
    }
    const leafId = entries.at(-1)?.id;
    if (!records.some(record => record.leafId === leafId)) return null;
    return projectExecutionHistory(entries, records, { sessionId: target.sessionId, leafId });
  } catch { return null; }
}
