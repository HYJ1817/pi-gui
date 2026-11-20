import { randomUUID } from 'node:crypto';
import { activePath } from './session-edit-target.js';
import { safeToolName } from '../public/runtime-timeline.js';
import { createExecutionCallIndex, diffStatOf, labelFor, summarize, subagentActivity } from '../lib/execution-tool-contract.js';

const MAX_NATIVE_ENTRIES = 4096;
const MAX_PARTS = 200;
const MAX_ACTIVITY_CALLS = 512;
const MAX_DETAIL_ENTRIES = 64;
const MAX_DETAIL_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const DETAIL_TTL_MS = 120_000;
const IDS = /^[A-Za-z0-9_.:/#-]{1,160}$/;
const SOURCE_ROLE = new Set(['assistant', 'user', 'toolResult']);
const CALL_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'glob', 'find', 'ls', 'bash', 'powershell', 'subagent']);
const SHELL_EXECUTABLES = new Set(['git', 'rg', 'grep', 'find', 'ls', 'cat', 'node', 'npm', 'pnpm', 'yarn', 'python', 'pytest', 'Get-Content', 'Get-ChildItem']);
const SENSITIVE_NAME = /(?:^|[/_. ():\s-])(?:token|secrets?|credentials?|password|passwd|private[-_]?key|auth|oauth|api[-_]?keys?|cookies?|id_rsa|id_ed25519)(?:[/_. ():\s-]|$)|^\.(?:env|netrc|npmrc|pypirc)(?:[./]|$)|\.(?:key|pem|pfx|p12)$/i;
const CREDENTIAL_VALUE = /(?:^|[/. ():\s_-])(?:sk-[\w-]{12,}|gh[pousr]_[\w-]{12,}|github_pat_[\w-]{12,}|AKIA[A-Z0-9]{16}|xox[baprs]-[\w-]{12,}|eyJ[\w-]{12,})/;
const RUNTIME_OWNER_KEYS = ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch',
  'conversationId', 'runtimeId', 'runtimeGeneration', 'sessionId'];
const CLASSIC_SCOPE_KEYS = ['kind', 'bridgeInstance', 'bridgeRun', 'workspaceKey', 'workspaceGeneration', 'sessionId'];
const witnessed = new WeakSet(), nativeDetails = new WeakMap();

const validId = value => typeof value === 'string' && IDS.test(value);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const limit = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, fallback) : fallback;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sessionOf = scope => scope?.kind === 'runtime' ? scope.owner?.sessionId : scope?.sessionId;

/* A copied, validated wire owner prevents arbitrary fields (paths/tokens etc.)
 * from surviving in a branch witness or cache. Native ID is mandatory here. */
function normalizeScope(scope) {
  if (!object(scope) || !validId(sessionOf(scope))) return null;
  if (scope.kind === 'runtime') {
    const keys = RUNTIME_OWNER_KEYS;
    if (!object(scope.owner) || !keys.every(key => validId(scope.owner[key]))) return null;
    return Object.freeze({ kind: scope.kind, owner: Object.freeze(Object.fromEntries(keys.map(key => [key, scope.owner[key]]))) });
  }
  if (scope.kind !== 'classic' || !validId(scope.bridgeInstance) || !validId(scope.workspaceKey)
      || number(scope.bridgeRun) === undefined || number(scope.workspaceGeneration) === undefined) return null;
  return Object.freeze(Object.fromEntries(CLASSIC_SCOPE_KEYS.map(key => [key, scope[key]])));
}
function sameScope(scope, expected) {
  if (!scope || !expected || scope.kind !== expected.kind) return false;
  return scope.kind === 'runtime'
    ? RUNTIME_OWNER_KEYS.every(key => scope.owner?.[key] === expected.owner?.[key])
    : CLASSIC_SCOPE_KEYS.every(key => scope[key] === expected[key]);
}
function safeFileName(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const segments = value.split(/[\\/]/).filter(Boolean);
  const name = segments.at(-1);
  if (!name || segments.some(part => part === '..' || SENSITIVE_NAME.test(part) || CREDENTIAL_VALUE.test(part))) return undefined;
  return /^[\p{L}\p{N}_. ()-]{1,120}$/u.test(name) && !['.', '..'].includes(name) ? name : undefined;
}
function fileSummary(name, args) {
  const info = summarize(name, args);
  const fileName = safeFileName(info.path);
  const start = number(args?.offset), count = number(args?.limit);
  if (name !== 'read' || !fileName || !start) return fileName ? { fileName } : {};
  const end = count ? number(start + count - 1) : undefined;
  return { fileName, requestedRange: { start, ...(end === undefined ? {} : { end }) } };
}
function readTruncatedRange(details, requestedRange) {
  const truncation = details?.truncation;
  if (truncation?.truncated !== true || truncation.firstLineExceedsLimit === true) return undefined;
  const start = requestedRange?.start ?? 1;
  const count = number(truncation.outputLines);
  const end = count ? number(start + count - 1) : undefined;
  if (end !== undefined && (requestedRange?.end === undefined || end <= requestedRange.end)) return { start, end };
  return undefined;
}
/** New SSE metadata contains only narrow activity facts. Arguments and results
 * are inspected here; arbitrary command/query/output text never enters SSE. */
function activitySummary(name, event, previous = {}) {
  const kind = name === 'subagent' ? 'subagent' : 'tool';
  const title = name === 'subagent' ? '子代理' : CALL_TOOLS.has(name) ? labelFor(name).label : '执行工具';
  const args = event.args, result = event.type === 'tool_execution_update' ? event.partialResult : event.result;
  const details = result?.details;
  const summary = { ...previous, kind, title };
  if (['read', 'edit', 'write'].includes(name) && event.type === 'tool_execution_start') Object.assign(summary, fileSummary(name, args));
  if (name === 'read' && summary.fileName && event.type === 'tool_execution_end' && event.isError !== true) {
    const range = readTruncatedRange(details, summary.requestedRange);
    if (range) summary.lineRange = range;
  }
  if ((name === 'bash' || name === 'powershell') && event.type === 'tool_execution_start') {
    const command = typeof args?.command === 'string' ? args.command.slice(0, 64).trimStart().match(/^([a-zA-Z][a-zA-Z0-9-]*)(?=\s|$)/)?.[1] : undefined;
    if (SHELL_EXECUTABLES.has(command)) summary.command = command;
  }
  if (['grep', 'find', 'glob'].includes(name) && event.type === 'tool_execution_end' && event.isError !== true) {
    for (const [key, fact] of [['hitCount', details?.hitCount], ['fileCount', details?.fileCount]]) {
      if (number(fact) !== undefined) summary[key] = fact;
    }
  }
  if ((name === 'edit' || name === 'write') && event.type === 'tool_execution_end' && event.isError !== true
    && typeof details?.diff === 'string' && details.diff.length <= MAX_RESULT_BYTES && Buffer.byteLength(details.diff) <= MAX_RESULT_BYTES) {
    const diff = diffStatOf(details);
    if (diff) summary.diffStat = diff;
  }
  if (name === 'subagent' && object(details) && (!Array.isArray(details.results) || details.results.length <= MAX_PARTS)
    && (!Array.isArray(details.workflowChildren?.children) || details.workflowChildren.children.length <= MAX_PARTS)) {
    const status = event.type !== 'tool_execution_end' ? 'running' : event.isError === true ? 'error' : 'success';
    const projection = subagentActivity({ id: event.toolCallId, name, status, details });
    const rows = projection?.subagents?.rows;
    if (rows?.length) {
      summary.children = rows.filter(row => validId(row.key) && !CREDENTIAL_VALUE.test(row.key) && !SENSITIVE_NAME.test(row.key)).map(row => ({
        id: row.key, status: row.state,
        ...(validId(row.model) && !CREDENTIAL_VALUE.test(row.model) && !SENSITIVE_NAME.test(row.model) ? { model: row.model } : {}),
      }));
    }
  }
  return summary;
}

export function createExecutionToolProjection() {
  let bridgeRun = null;
  const calls = createExecutionCallIndex(MAX_ACTIVITY_CALLS);
  return {
    observe(event) {
      if (Number.isSafeInteger(event?.bridgeRun) && event.bridgeRun !== bridgeRun) {
        if (bridgeRun !== null && event.bridgeRun < bridgeRun) return null;
        bridgeRun = event.bridgeRun; calls.reset();
      }
      if (event?.type === 'execution_branch') calls.reset();
      if (['agent_settled', 'auto_retry_start'].includes(event?.type)
          || event?.type === 'bridge_status' && event.state !== 'ready'
          || event?.type === 'stop_state' && event.pending === false && ['stopped', 'reset'].includes(event.state)) {
        calls.retireAll();
      }
      if (['compaction_start', 'compaction_end'].includes(event?.type)) return { kind: 'compaction', title: '上下文压缩' };
      if (!['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event?.type) || !validId(event.toolCallId)) return null;
      const callId = event.toolCallId;
      if (event.type === 'tool_execution_start') {
        const current = { name: safeToolName(event.toolName) };
        if (calls.begin(callId, current) !== 'started' || current.name === 'gui_plan') return null;
        current.summary = activitySummary(current.name, event);
        return current.summary;
      }
      const current = calls.get(callId);
      if (!current || event.toolName != null && event.toolName !== current.name) return null;
      if (event.type === 'tool_execution_end') calls.retire(callId);
      if (current.name === 'gui_plan') return null;
      current.summary = activitySummary(current.name, event, current.summary);
      return current.summary;
    },
  };
}

/* Closed intra-server branch witness. get_entries is the private Pi read;
 * callers never supply a locator, and any identity drift returns null. */
export async function readExecutionBranch({ scope, readState, readEntries, isCurrent, branchEpoch = 0, detailTarget = null }) {
  const expected = normalizeScope(scope);
  if (!expected || number(branchEpoch) === undefined || typeof isCurrent !== 'function') return null;
  try {
    if (!await isCurrent(expected)) return null;
    const first = await readState();
    if (first?.__error || first?.sessionId !== sessionOf(expected)) return null;
    const native = await readEntries();
    if (!native || native.__error || !Array.isArray(native.entries) || native.entries.length > MAX_NATIVE_ENTRIES
      || !Object.hasOwn(native, 'leafId') || native.leafId !== null && !validId(native.leafId)) return null;
    // A null leaf with entries is not a useful active path; it must prove an empty native tree.
    if (native.leafId === null && native.entries.length) return null;
    const path = activePath(native.entries, native.leafId);
    if (!path) return null;
    const entries = [];
    for (const entry of path) {
      if (!validId(entry.id) || !(entry.parentId === null || validId(entry.parentId))) return null;
      const row = { id: entry.id, parentId: entry.parentId };
      if (entry.type === 'message') {
        const message = entry.message;
        if (SOURCE_ROLE.has(message?.role)) row.role = message.role;
        if (row.role === 'assistant') {
          if (!Array.isArray(message.content) || message.content.length > MAX_PARTS) return null;
          const calls = [];
          for (const [index, part] of message.content.entries()) {
            if (part?.type !== 'toolCall') continue;
            const name = safeToolName(part.name);
            if (!validId(part.id) || calls.some(call => call.id === part.id)) return null;
            calls.push(Object.freeze({ id: part.id, index, name }));
          }
          row.toolCalls = Object.freeze(calls);
        }
        if (row.role === 'toolResult') {
          if (!validId(message.toolCallId)) return null;
          row.toolCallId = message.toolCallId;
          row.toolName = safeToolName(message.toolName);
        }
      }
      entries.push(Object.freeze(row));
    }
    const again = await readEntries();
    if (!again || again.__error || again.leafId !== native.leafId) return null;
    const last = await readState();
    if (last?.__error || last?.sessionId !== sessionOf(expected) || !await isCurrent(expected)) return null;
    const branch = Object.freeze({ scope: expected, branchEpoch, leafId: native.leafId, entries: Object.freeze(entries) });
    witnessed.add(branch);
    if (detailTarget) {
      const detail = projectNativeDetail(branch, path, detailTarget);
      if (detail) nativeDetails.set(branch, detail);
    }
    return branch;
  } catch { return null; }
}

/* The caller supplies the ordered, already attributed message witnesses for
 * one exact run. The native suffix must agree in order, role and tool IDs at
 * the original content indices. No repair using timestamps or text equality. */
export function bindExecutionEntries(branch, { checkpoint, beforeLeafId = checkpoint?.leafId, messages } = {}) {
  if (!witnessed.has(branch) || !witnessed.has(checkpoint) || !sameScope(branch.scope, checkpoint.scope)
    || branch.branchEpoch !== checkpoint.branchEpoch || beforeLeafId !== checkpoint.leafId
    || !Array.isArray(messages) || !messages.length || messages.length > MAX_NATIVE_ENTRIES) return null;
  const after = checkpoint.entries.length;
  if (after >= branch.entries.length || !checkpoint.entries.every((entry, index) => branch.entries[index]?.id === entry.id)) return null;
  const suffix = branch.entries.slice(after);
  const actual = suffix.filter(entry => entry.role === 'user' || entry.role === 'assistant');
  if (actual.length !== messages.length || actual[0]?.role !== 'user') return null;
  const ids = new Set(), aliases = [], frequencies = new Map();
  for (const entry of branch.entries) {
    for (const call of entry.toolCalls || []) frequencies.set(call.id, (frequencies.get(call.id) || 0) + 1);
  }
  const firstUser = actual.find(entry => entry.role === 'user');
  const soleUser = actual.filter(entry => entry.role === 'user').length === 1;
  let anchored = false;
  for (let i = 0; i < messages.length; i++) {
    const e = actual[i], m = messages[i];
    if (e.role !== m?.role || !validId(m.id) || ids.has(m.id)) return null;
    if (e.role === 'assistant' && (!Array.isArray(m.toolCalls) || m.toolCalls.length !== e.toolCalls.length
      || !e.toolCalls.every((call, index) => ['id', 'name', 'index'].every(key => m.toolCalls[index]?.[key] === call[key])))) return null;
    if (m.nativeEntryId !== undefined && m.nativeEntryId !== e.id) return null;
    ids.add(m.id);
    if (m.nativeEntryId === e.id || e.toolCalls?.some(call => frequencies.get(call.id) === 1)) {
      aliases.push({ from: m.id, to: e.id });
      if (e.role === 'assistant') anchored = true;
    }
  }
  let available = new Map();
  const results = [];
  for (const e of suffix) {
    if (e.role === 'assistant') available = new Map(e.toolCalls.map(call => [call.id, { ...call, responseEntryId: e.id }]));
    else if (e.role === 'toolResult') {
      const call = available.get(e.toolCallId);
      if (!call || e.toolName !== call.name) return null;
      available.delete(e.toolCallId);
      results.push({ responseEntryId: call.responseEntryId, callId: e.toolCallId, resultEntryId: e.id });
    }
  }
  // A single admitted initial input between the authenticated checkpoint
  // and a uniquely anchored assistant response can be paired in order.
  if (soleUser && anchored && !aliases.some(alias => alias.to === firstUser.id)) aliases.unshift({ from: messages[0].id, to: firstUser.id });
  return { branch: { leafId: branch.leafId, beforeLeafId }, aliases,
    results: results.filter(result => aliases.some(alias => alias.to === result.responseEntryId)),
    partial: aliases.length !== messages.length };
}

function ownsCall(branch, responseEntryId, resultEntryId, callId, toolName) {
  if (!witnessed.has(branch)) return false;
  const start = branch.entries.findIndex(row => row.id === responseEntryId);
  if (start < 0 || !branch.entries[start].toolCalls?.some(call => call.id === callId && call.name === toolName)) return false;
  const matches = [];
  for (const row of branch.entries.slice(start + 1)) {
    if (row.role === 'assistant' || row.role === 'user') break;
    if (row.role === 'toolResult' && row.toolCallId === callId && row.toolName === toolName) matches.push(row.id);
  }
  return matches.length === 1 && matches[0] === resultEntryId;
}

function projectNativeDetail(branch, path, { responseEntryId, resultEntryId, callId }) {
  const response = path.find(entry => entry.id === responseEntryId);
  const result = path.find(entry => entry.id === resultEntryId)?.message;
  const part = Array.isArray(response?.message?.content)
    ? response.message.content.find(value => value?.type === 'toolCall' && value.id === callId) : null;
  const toolName = part?.name;
  if (!CALL_TOOLS.has(toolName) || !ownsCall(branch, responseEntryId, resultEntryId, callId, toolName)) return null;
  const { kind, title, ...parameters } = activitySummary(toolName, { type: 'tool_execution_start', toolCallId: callId, args: part.arguments });
  const summary = activitySummary(toolName, { type: 'tool_execution_end', toolCallId: callId, result, isError: result.isError === true }, parameters);
  const data = { ok: true, toolName, parameters, ...(summary.diffStat ? { diffStat: summary.diffStat } : {}), omitted: 'restricted' };
  for (const key of ['lineRange', 'hitCount', 'fileCount']) {
    if (summary[key] !== undefined) data[key] = summary[key];
  }
  return { responseEntryId, resultEntryId, callId, toolName, data };
}

/* P5-A controlled reader only. The ref is a lookup key, not authority.
 * There is intentionally no arbitrary stdout or file content capability in
 * this interface; P5-A can verify provenance and budget without publishing it. */
export function createExecutionDetailIndex({
  maxEntries = MAX_DETAIL_ENTRIES, maxBytes = MAX_DETAIL_BYTES, ttlMs = DETAIL_TTL_MS,
  now = Date.now, isCurrent, readBranch,
} = {}) {
  const entries = new Map();
  let bytes = 0;
  maxEntries = limit(maxEntries, MAX_DETAIL_ENTRIES);
  maxBytes = limit(maxBytes, MAX_DETAIL_BYTES);
  ttlMs = limit(ttlMs, DETAIL_TTL_MS);
  const unavailable = () => ({ ok: false, code: 'execution_detail_unavailable' });
  function remove(id) {
    const entry = entries.get(id);
    if (entry) bytes -= entry.weight;
    entries.delete(id);
  }
  function purge() {
    for (const [id, entry] of entries) if (entry.expires <= now()) remove(id);
  }
  return {
    capture({ scope, branch, responseEntryId, resultEntryId, callId }) {
      purge();
      const detail = nativeDetails.get(branch);
      if (!maxEntries || !ttlMs || !detail || !sameScope(scope, branch.scope)
        || detail.responseEntryId !== responseEntryId || detail.resultEntryId !== resultEntryId || detail.callId !== callId) return null;
      const id = randomUUID();
      const entry = { scope: branch.scope, leafId: branch.leafId, branchEpoch: branch.branchEpoch, ...detail, expires: now() + ttlMs };
      const weight = Buffer.byteLength(JSON.stringify([id, entry]));
      if (weight > maxBytes) return null;
      while (entries.size >= maxEntries || bytes + weight > maxBytes) remove(entries.keys().next().value);
      entries.set(id, { ...entry, weight }); bytes += weight;
      return { id, source: 'native-entry', state: 'available' };
    },
    async read({ scope, ref, callId } = {}) {
      purge();
      const entry = entries.get(ref);
      if (!entry || callId !== entry.callId || !sameScope(scope, entry.scope) || !isCurrent || !readBranch) return unavailable();
      try {
        if (!await isCurrent(entry.scope, entry.branchEpoch)) return unavailable();
        const branch = await readBranch(entry.scope);
        if (!sameScope(branch?.scope, entry.scope) || branch.branchEpoch !== entry.branchEpoch || branch.leafId !== entry.leafId
          || !ownsCall(branch, entry.responseEntryId, entry.resultEntryId, entry.callId, entry.toolName)
          || !await isCurrent(entry.scope, entry.branchEpoch)) return unavailable();
        purge();
        return entries.get(ref) === entry ? structuredClone(entry.data) : unavailable();
      } catch { return unavailable(); }
    },
    invalidate(scope) {
      for (const [id, entry] of entries) if (sameScope(scope, entry.scope)) remove(id);
    },
    size() { purge(); return { entries: entries.size, bytes }; },
    clear() { entries.clear(); bytes = 0; },
  };
}

/** Public branch shape used by established tree/entry reads. Native content and
 * private witnesses stay in the separate server-only reader above. */
export function projectRuntimeEntry(entry) {
  if (!object(entry) || !validId(entry.id)) return null;
  const out = { id: entry.id };
  if (entry.parentId === null || validId(entry.parentId)) out.parentId = entry.parentId;
  if (['message', 'branch_summary', 'compaction', 'label', 'model_change', 'thinking_level_change', 'custom', 'custom_message', 'session_info'].includes(entry.type)) out.type = entry.type;
  if (entry.type === 'message' && SOURCE_ROLE.has(entry.message?.role)) {
    const message = entry.message;
    out.message = { role: message.role };
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      out.message.content = message.content.slice(0, MAX_PARTS).filter(part => part?.type === 'toolCall' && validId(part.id))
        .map(part => ({ type: 'toolCall', id: part.id, name: safeToolName(part.name) }));
    }
    if (message.role === 'toolResult' && validId(message.toolCallId)) {
      out.message.toolCallId = message.toolCallId;
      out.message.toolName = safeToolName(message.toolName);
      out.message.isError = message.isError === true;
      out.message.content = [];
    }
  }
  return out;
}

/** Only the backend's admitted command paths call this after transport write. */
export function executionSubmission(command, editOf = null) {
  if (!['prompt', 'steer', 'follow_up'].includes(command?.type) || !validId(command.id)) return null;
  return { type: 'execution_submission', id: command.id, command: command.type,
    ...(validId(command.__fallbackOwner) ? { fallbackOf: command.__fallbackOwner } : {}),
    ...(validId(editOf) ? { editOf } : {}) };
}

export function projectRuntimeTree(tree) {
  if (!Array.isArray(tree)) return [];
  const result = [], stack = [{ entries: tree, target: result, depth: 0 }];
  let remaining = MAX_NATIVE_ENTRIES;
  while (stack.length && remaining > 0) {
    const { entries, target, depth } = stack.pop();
    for (const node of entries) {
      if (remaining-- <= 0) break;
      const entry = projectRuntimeEntry(node?.entry || node);
      if (!entry) continue;
      if (node.entry) {
        const children = [];
        target.push({ entry, children });
        if (Array.isArray(node.children) && depth < 256) stack.push({ entries: node.children, target: children, depth: depth + 1 });
      } else target.push(entry);
    }
  }
  return result;
}

export function projectRuntimeEntryRead(command, data) {
  return {
    leafId: validId(data?.leafId) ? data.leafId : null,
    ...(command === 'get_tree' ? { tree: projectRuntimeTree(data?.tree) } : {
      entries: Array.isArray(data?.entries) ? data.entries.slice(0, MAX_NATIVE_ENTRIES).map(projectRuntimeEntry).filter(Boolean) : [],
    }),
  };
}
