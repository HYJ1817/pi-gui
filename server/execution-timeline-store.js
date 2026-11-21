/* Program-owned history metadata only. Native content remains in the Pi session. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { activePath } from './session-edit-target.js';

const FILE = 'execution-timeline.json';
const MAX_SCOPES = 128;
const MAX_TURNS = 80;
const MAX_ENTRIES = 512;
const MAX_TOOLS = 256;
const MAX_NATIVE_ENTRIES = 4096;
const MAX_BYTES = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9_.:/#-]{1,160}$/;
const ROLES = new Set([null, 'user', 'assistant', 'toolResult']);
const STATES = new Set(['unknown', 'completed', 'failed', 'interrupted', 'cancelled']);
const TOOL_STATES = new Set([...STATES, 'incomplete']);
const id = value => typeof value === 'string' && ID.test(value);
const time = value => value === null || Number.isSafeInteger(value) && value >= 0;
const ownFile = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;

function scopeKey(identity) {
  if (!id(identity?.workspaceId) || !id(identity.sessionId)) return null;
  const fields = [identity.kind, identity.workspaceId, identity.sessionId];
  if (identity.kind === 'runtime') {
    if (!id(identity.projectId) || !id(identity.conversationId)) return null;
    fields.push(identity.projectId, identity.conversationId);
  } else if (identity.kind !== 'classic') return null;
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function toolShape(tool, entryById) {
  if (!id(tool?.callId) || entryById.get(tool.responseId)?.role !== 'assistant'
      || entryById.get(tool.resultId)?.role !== 'toolResult' || !TOOL_STATES.has(tool.status)
      || !time(tool.startedAt) || !time(tool.endedAt) || !time(tool.durationMs)
      || tool.startedAt !== null && tool.endedAt !== null && tool.startedAt > tool.endedAt) return null;
  return {
    callId: tool.callId, responseId: tool.responseId, resultId: tool.resultId,
    startedAt: tool.startedAt, endedAt: tool.endedAt, durationMs: tool.durationMs, status: tool.status,
    ...(id(tool.viewAlias) ? { viewAlias: tool.viewAlias } : {}),
  };
}

function turnShape(turn) {
  if (!id(turn?.inputId) || !id(turn.leafId) || turn.beforeLeafId !== null && !id(turn.beforeLeafId)
      || !STATES.has(turn.status) || !time(turn.timing?.startedAt) || !time(turn.timing?.endedAt)
      || turn.timing.startedAt !== null && turn.timing.endedAt !== null && turn.timing.startedAt > turn.timing.endedAt
      || !Array.isArray(turn.entries) || !turn.entries.length || turn.entries.length > MAX_ENTRIES
      || !Array.isArray(turn.tools) || turn.tools.length > MAX_TOOLS) return null;
  const entries = [];
  const entryById = new Map();
  for (const entry of turn.entries) {
    if (!id(entry?.id) || !ROLES.has(entry.role) || entryById.has(entry.id) || entry.id === turn.beforeLeafId) return null;
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
    const tool = toolShape(value, entryById);
    if (!tool || results.has(tool.resultId)) return null;
    tools.push(tool);
    results.add(tool.resultId);
  }
  return {
    inputId: turn.inputId, beforeLeafId: turn.beforeLeafId, leafId: turn.leafId, entries,
    status: turn.status, timing: { startedAt: turn.timing.startedAt, endedAt: turn.timing.endedAt },
    finalResponseId: turn.finalResponseId, tools,
    ...(id(turn.viewAlias) ? { viewAlias: turn.viewAlias } : {}),
  };
}

function indexShape(value) {
  if (value?.version !== 1 || !Array.isArray(value.buckets) || value.buckets.length > MAX_SCOPES) return null;
  const buckets = [];
  const keys = new Set();
  for (const bucket of value.buckets) {
    if (typeof bucket?.key !== 'string' || !/^[a-f0-9]{64}$/.test(bucket.key) || keys.has(bucket.key)
        || !Array.isArray(bucket.turns) || !bucket.turns.length || bucket.turns.length > MAX_TURNS) return null;
    const turns = bucket.turns.map(turnShape);
    if (turns.some(turn => turn === null)) return null;
    keys.add(bucket.key);
    buckets.push({ key: bucket.key, turns });
  }
  return { version: 1, buckets };
}

function containsTurn(long, short) {
  return long.inputId === short.inputId && long.beforeLeafId === short.beforeLeafId
    && short.entries.every((entry, n) => entry.id === long.entries[n]?.id && entry.role === long.entries[n]?.role);
}

export function createExecutionTimelineStore({ dataDir, io = fs, maxTurns = MAX_TURNS } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('execution timeline data directory required');
  const file = path.resolve(dataDir, FILE);
  const budget = Number.isSafeInteger(maxTurns) ? Math.max(1, Math.min(MAX_TURNS, maxTurns)) : MAX_TURNS;

  function read() {
    let fd;
    try {
      const prior = io.lstatSync(file);
      if (!prior.isFile() || prior.size > MAX_BYTES) return null;
      fd = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = io.fstatSync(fd);
      if (!ownFile(prior, stat) || stat.size > MAX_BYTES) return null;
      const data = Buffer.alloc(stat.size + 1);
      const n = io.readSync(fd, data, 0, data.length, 0);
      if (n !== stat.size || !ownFile(stat, io.lstatSync(file))) return null;
      return indexShape(JSON.parse(data.subarray(0, n).toString('utf8')));
    } catch (error) {
      return error?.code === 'ENOENT' && fd === undefined ? { version: 1, buckets: [] } : null;
    } finally {
      if (fd !== undefined) try { io.closeSync(fd); } catch { /* already closed */ }
    }
  }

  function replace(payload) {
    const temporary = file + '.tmp-' + randomUUID();
    let fd;
    let created = false;
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      fd = io.openSync(temporary, 'wx', 0o600);
      created = true;
      io.writeFileSync(fd, payload, 'utf8');
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      io.renameSync(temporary, file);
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) try { io.closeSync(fd); } catch { /* already closed */ }
      if (created) try { io.unlinkSync(temporary); } catch { /* atomically moved */ }
    }
  }

  return {
    list(identity) {
      const key = scopeKey(identity);
      return key ? read()?.buckets.find(bucket => bucket.key === key)?.turns ?? [] : [];
    },
    record(identity, value) {
      const key = scopeKey(identity), turn = turnShape(value);
      if (!key || !turn) return false;
      const index = read();
      if (!index) return false; // An unknown or corrupt version is never overwritten.
      const found = index.buckets.findIndex(bucket => bucket.key === key);
      const [bucket] = found < 0 ? [] : index.buckets.splice(found, 1);
      const prior = bucket?.turns ?? [];
      if (prior.some(entry => containsTurn(entry, turn) && (entry.leafId !== turn.leafId
          || entry.status !== 'unknown' && turn.status === 'unknown'))) return true;
      const turns = prior.filter(entry => !containsTurn(turn, entry));
      turns.push(turn);
      index.buckets.push({ key, turns: turns.slice(-budget) });
      index.buckets = index.buckets.slice(-MAX_SCOPES);
      let payload = JSON.stringify(index);
      while (Buffer.byteLength(payload) > MAX_BYTES) {
        if (index.buckets.length > 1) index.buckets.shift();
        else if (index.buckets[0].turns.length > 1) index.buckets[0].turns.shift();
        else return false;
        payload = JSON.stringify(index);
      }
      return replace(payload);
    },
  };
}

function roleOf(row) {
  const role = row?.type === undefined ? row?.role : row.type === 'message' ? row.message?.role : null;
  return ROLES.has(role) ? role : null;
}

function matchesTool(tool, byId, resultOwners) {
  if (resultOwners.get(tool.resultId) !== tool.responseId) return false;
  const response = byId.get(tool.responseId);
  const result = byId.get(tool.resultId);
  const shape = response.type === 'message' ? response.message.content : response.toolCalls;
  if (!Array.isArray(shape)) return false;
  const calls = shape.filter(call => call?.id === tool.callId
    && (response.type === 'message' ? call.type === 'toolCall' : call.type === undefined));
  const toolResult = result.type === 'message' ? result.message : result;
  return calls.length === 1 && calls[0].name === toolResult.toolName && toolResult.toolCallId === tool.callId;
}

/* The caller exclusively supplies a native tree from its authorized reader
 * and an observed leaf. Neither archived position nor text can create proof. */
export function matchExecutionTimelineRecords(records, nativeRows, leafId) {
  if (!Array.isArray(records) || !records.length || records.length > MAX_TURNS || !id(leafId)
      || !Array.isArray(nativeRows) || nativeRows.length > MAX_NATIVE_ENTRIES) return [];
  const branch = activePath(nativeRows, leafId);
  if (!branch) return [];
  const byId = new Map(branch.map(row => [row.id, row]));
  const positions = new Map(branch.map((row, n) => [row.id, n]));
  const resultOwners = new Map();
  let responseId = null;
  for (const row of branch) {
    const role = roleOf(row);
    if (role === 'assistant') responseId = row.id;
    if (role === 'user') responseId = null;
    if (role === 'toolResult') resultOwners.set(row.id, responseId);
  }
  const valid = [];
  for (const raw of records) {
    const turn = turnShape(raw);
    if (!turn) continue;
    const before = turn.beforeLeafId === null ? -1 : positions.get(turn.beforeLeafId);
    if (before === undefined || !turn.entries.every((row, n) => {
      const native = branch[before + 1 + n];
      return native?.id === row.id && roleOf(native) === row.role;
    }) || !turn.tools.every(tool => matchesTool(tool, byId, resultOwners))) continue;
    valid.push({ turn, start: before + 1, end: before + turn.entries.length });
  }
  valid.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted = [];
  let end = -1;
  for (const entry of valid) {
    if (entry.start <= end) continue;
    end = entry.end;
    accepted.push(entry.turn);
  }
  return accepted;
}
