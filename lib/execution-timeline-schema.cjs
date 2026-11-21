'use strict';

const MAX_SCOPES = 128;
const MAX_TURNS = 80;
const MAX_ENTRIES = 512;
const MAX_TOOLS = 256;
const MAX_EXECUTION_TIMELINE_BYTES = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9_.:/#-]{1,160}$/;
const ROLES = new Set([null, 'user', 'assistant', 'toolResult']);
const STATES = new Set(['unknown', 'completed', 'failed', 'interrupted', 'cancelled']);
const TOOL_STATES = new Set([...STATES, 'incomplete']);
const isId = value => typeof value === 'string' && ID.test(value);
const time = value => value === null || Number.isSafeInteger(value) && value >= 0;

function executionTimelineTurnShape(turn) {
  if (!isId(turn?.inputId) || !isId(turn?.leafId) || turn.beforeLeafId !== null && !isId(turn.beforeLeafId)
      || !STATES.has(turn.status) || !time(turn.timing?.startedAt) || !time(turn.timing?.endedAt)
      || turn.timing.startedAt !== null && turn.timing.endedAt !== null && turn.timing.startedAt > turn.timing.endedAt
      || !Array.isArray(turn.entries) || !turn.entries.length || turn.entries.length > MAX_ENTRIES
      || !Array.isArray(turn.tools) || turn.tools.length > MAX_TOOLS) return null;
  const entries = [];
  const entryById = new Map();
  for (const entry of turn.entries) {
    if (!isId(entry?.id) || !ROLES.has(entry.role) || entryById.has(entry.id) || entry.id === turn.beforeLeafId) return null;
    const row = { id: entry.id, role: entry.role };
    entries.push(row);
    entryById.set(row.id, row);
  }
  if (entries.at(-1).id !== turn.leafId || entries.find(row => row.role !== null)?.id !== turn.inputId
      || entryById.get(turn.inputId)?.role !== 'user'
      || turn.finalResponseId !== null && entryById.get(turn.finalResponseId)?.role !== 'assistant') return null;
  const tools = [];
  const results = new Set();
  for (const value of turn.tools) {
    const tool = value;
    if (!isId(tool?.callId) || entryById.get(tool.responseId)?.role !== 'assistant'
        || entryById.get(tool.resultId)?.role !== 'toolResult' || !TOOL_STATES.has(tool.status)
        || !time(tool.startedAt) || !time(tool.endedAt) || !time(tool.durationMs)
        || tool.startedAt !== null && tool.endedAt !== null && tool.startedAt > tool.endedAt
        || results.has(tool.resultId)) return null;
    const normalized = {
      callId: tool.callId, responseId: tool.responseId, resultId: tool.resultId,
      startedAt: tool.startedAt, endedAt: tool.endedAt, durationMs: tool.durationMs, status: tool.status,
      ...(isId(tool.viewAlias) ? { viewAlias: tool.viewAlias } : {}),
    };
    tools.push(normalized);
    results.add(normalized.resultId);
  }
  return {
    inputId: turn.inputId, beforeLeafId: turn.beforeLeafId, leafId: turn.leafId, entries,
    status: turn.status, timing: { startedAt: turn.timing.startedAt, endedAt: turn.timing.endedAt },
    finalResponseId: turn.finalResponseId, tools,
    ...(isId(turn.viewAlias) ? { viewAlias: turn.viewAlias } : {}),
  };
}

function normalizeExecutionTimelineIndex(value) {
  if (value?.version !== 1 || !Array.isArray(value.buckets) || value.buckets.length > MAX_SCOPES) return null;
  const buckets = [];
  const keys = new Set();
  for (const bucket of value.buckets) {
    if (typeof bucket?.key !== 'string' || !/^[a-f0-9]{64}$/.test(bucket.key) || keys.has(bucket.key)
        || !Array.isArray(bucket.turns) || !bucket.turns.length || bucket.turns.length > MAX_TURNS) return null;
    const turns = bucket.turns.map(executionTimelineTurnShape);
    if (turns.some(turn => turn === null)) return null;
    keys.add(bucket.key);
    buckets.push({ key: bucket.key, turns });
  }
  return { version: 1, buckets };
}

function validateExecutionTimelineBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_EXECUTION_TIMELINE_BYTES) return false;
  let text, parsed;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch { return false; }
  const normalized = normalizeExecutionTimelineIndex(parsed);
  return normalized !== null && Buffer.from(JSON.stringify(normalized), 'utf8').equals(bytes);
}

module.exports = {
  MAX_EXECUTION_TIMELINE_BYTES,
  MAX_EXECUTION_TIMELINE_SCOPES: MAX_SCOPES,
  MAX_EXECUTION_TIMELINE_TURNS: MAX_TURNS,
  isExecutionTimelineId: isId,
  isExecutionTimelineRole: value => ROLES.has(value),
  executionTimelineTurnShape,
  normalizeExecutionTimelineIndex,
  validateExecutionTimelineBytes,
};
