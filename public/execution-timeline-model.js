import {
  boundText, MAX_BLOCKS, MAX_BLOCK_TEXT, MAX_CONTENT_SEGMENTS, MAX_THINKING_TEXT,
  MAX_TIMELINE_CHARS, MAX_USER_TEXT, safeToolName, usageProjection,
} from './runtime-timeline.js';
import { normalizePlan, PLAN_TOOL_NAME } from './plan-model.js';

const RUNTIME_KEYS = ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch',
  'conversationId', 'runtimeId', 'runtimeGeneration', 'sessionId'];
const CLASSIC_KEYS = ['bridgeInstance', 'bridgeRun', 'workspaceKey', 'workspaceGeneration', 'sessionId'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'unknown']);
const ACTIVE = new Set(['queued', 'running', 'waiting', 'stopping']);
const STATUS = new Set([...TERMINAL, ...ACTIVE, 'incomplete']);
const CHILD_STATUS = new Set([...STATUS, 'complete', 'stopped', 'detached']);
const ATTEMPT_KIND = new Set(['initial', 'auto-retry', 'fallback', 'continue']);
const ORIGIN = new Set(['classic-rpc', 'runtime-frame', 'native-entry', 'gui-metadata']);
const EVIDENCE = new Set(['verified', 'legacy', 'partial']);
const TIME_EVIDENCE = new Set(['observed', 'recorded', 'estimated', 'unknown']);
const PART_KIND = new Set(['thinking', 'progress-text', 'answer', 'partial-answer']);
const ITEM_KIND = new Set(['tool', 'subagent', 'compaction']);
const REF_STATE = new Set(['available', 'pending', 'unavailable', 'restricted']);
const REF_SOURCE = new Set(['live-buffer', 'native-entry']);
const MAX_EVENTS = 8192;
const MAX_ITEMS = 2000;
const MAX_PROPOSALS = 32;
const MAX_ALIASES = 4096;
const MAX_CHILDREN = 24;
let encoder;

function utf8Width(codePoint) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

export function executionTextBytes(value) {
  if (!value) return 0;
  if (typeof TextEncoder === 'function') return (encoder ??= new TextEncoder()).encode(value).byteLength;
  let length = 0;
  for (const character of value) length += utf8Width(character.codePointAt(0));
  return length;
}

export function executionBoundText(value, limit) {
  if (typeof TextEncoder === 'function' && typeof TextDecoder === 'function') return boundText(value, limit);
  let length = executionTextBytes(value);
  let offset = 0;
  for (const character of value) {
    if (length <= limit) break;
    length -= utf8Width(character.codePointAt(0));
    offset += character.length;
  }
  return { text: offset > 0 ? value.slice(offset).replace(/^�+/, '') : value, truncated: offset > 0 };
}

const count = value => Number.isSafeInteger(value) && value >= 0;
const integer = value => count(value) ? value : null;
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const key = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const member = (set, value, fallback) => set.has(value) ? value : fallback;

function scopeOf(scope) {
  const runtime = scope?.kind === 'runtime';
  if (!runtime && scope?.kind !== 'classic') return null;
  const input = runtime ? scope.owner : scope;
  if (!object(input)) return null;
  const result = {};
  for (const field of runtime ? RUNTIME_KEYS : CLASSIC_KEYS) {
    const value = input[field];
    if (field === 'sessionId' && value === null) result[field] = null;
    else if (field === 'bridgeRun' || field === 'workspaceGeneration') {
      if (!count(value)) return null;
      result[field] = value;
    } else if (key(value) || (field === 'workspaceEpoch' && count(value))) result[field] = value;
    else return null;
  }
  if (scope.branchEpoch !== undefined && !count(scope.branchEpoch)) return null;
  const branch = scope.branchEpoch === undefined ? {} : { branchEpoch: scope.branchEpoch };
  return runtime ? { kind: 'runtime', owner: result, ...branch } : { kind: 'classic', ...result, ...branch };
}

const fieldsOf = scope => scope.kind === 'runtime' ? scope.owner : scope;
const sessionOf = scope => fieldsOf(scope).sessionId;
function sameScope(a, b, ignoreSession = false) {
  if (!a || !b || a.kind !== b.kind || (a.branchEpoch ?? 0) !== (b.branchEpoch ?? 0)) return false;
  const left = fieldsOf(a);
  const right = fieldsOf(b);
  return Object.keys(left).every(field => field === 'branchEpoch' || (ignoreSession && field === 'sessionId') || left[field] === right[field]);
}

function positionOf(input) {
  if (!['live', 'history'].includes(input?.domain) || !key(input.stream)
      || !count(input.sequence) || !count(input.part)) return null;
  return { domain: input.domain, stream: input.stream, sequence: input.sequence, part: input.part };
}

function compare(a, b) {
  if (a.domain !== b.domain) return a.domain === 'history' ? -1 : 1;
  if (a.stream !== b.stream) return a.stream.localeCompare(b.stream);
  return a.sequence - b.sequence || a.part - b.part;
}

function timeOf(input, prior = {}) {
  const startedAt = integer(input?.startedAt) ?? prior.startedAt ?? null;
  const end = integer(input?.endedAt) ?? prior.endedAt ?? null;
  const endedAt = end !== null && startedAt !== null && end < startedAt ? null : end;
  const reportedDuration = input?.durationMs;
  const durationMs = (Number.isFinite(reportedDuration) && reportedDuration >= 0 ? reportedDuration : null) ?? prior.durationMs
    ?? (startedAt !== null && endedAt !== null ? endedAt - startedAt : null);
  return { startedAt, endedAt, durationMs, evidence: member(TIME_EVIDENCE, input?.evidence, prior.evidence ?? 'unknown') };
}

function issueOf(input) {
  if (typeof input?.code !== 'string' || !/^[a-z0-9_.-]{1,80}$/i.test(input.code)) return undefined;
  const displayText = text(input.displayText, 300);
  return { code: input.code, ...(displayText ? { displayText } : {}) };
}

function refOf(input) {
  if (!key(input?.id) || !REF_SOURCE.has(input.source) || !REF_STATE.has(input.state)) return null;
  return { id: input.id, source: input.source, state: input.state };
}

function messageOf(input) {
  const id = key(input?.id);
  const content = refOf(input?.content);
  if (!id || !content) return null;
  const out = { id, content };
  if (key(input.nativeEntryId)) out.nativeEntryId = input.nativeEntryId;
  if (count(input.userIndex)) out.userIndex = input.userIndex;
  const attachments = array(input.attachments).slice(0, MAX_CHILDREN).flatMap(attachment => {
    const mimeType = text(attachment?.mimeType, 80);
    return attachment?.kind === 'image' && /^image\/[a-z0-9+.-]+$/i.test(mimeType)
      ? [{ kind: 'image', mimeType }] : [];
  });
  if (attachments.length) out.attachments = attachments;
  return out;
}

function userMessageOf(input) {
  const message = messageOf(input);
  if (message && typeof input.preview?.text === 'string') {
    const preview = executionBoundText(input.preview.text.slice(0, MAX_USER_TEXT), MAX_USER_TEXT);
    message.preview = { text: preview.text, truncated: input.preview.truncated === true
      || preview.truncated || input.preview.text.length > MAX_USER_TEXT };
  }
  return message;
}

function modelOf(input) {
  const id = text(input?.id, 160);
  const provider = text(input?.provider, 80);
  return id ? { id, ...(provider ? { provider } : {}) } : undefined;
}

function usageOf(input, responseId, position) {
  const recorded = usageProjection(input?.recorded);
  if (!recorded) return null;
  const model = modelOf(input.model);
  return { responseId, recorded, position: positionOf(input.position) || position, ...(model ? { model } : {}) };
}

function partOf(input, message, position) {
  const ref = messageOf(input?.message) || message;
  if (!key(input?.id) || !ref || !PART_KIND.has(input.kind)) return null;
  const partIndices = [...new Set(array(input.partIndices).slice(0, MAX_CONTENT_SEGMENTS).filter(count))];
  if (!partIndices.length) return null;
  const limit = input.kind === 'thinking' ? MAX_THINKING_TEXT : MAX_BLOCK_TEXT;
  const bounded = executionBoundText(text(input.text, MAX_TIMELINE_CHARS), limit);
  return { id: input.id, message: ref, partIndices, position: positionOf(input.position) || position,
    kind: input.kind, ...(typeof input.text === 'string' ? { text: bounded.text } : {}),
    ...(bounded.truncated || input.truncated === true ? { truncated: true } : {}) };
}

function summaryOf(input) {
  if (!object(input)) return undefined;
  const result = {};
  for (const field of ['fileName', 'command', 'query', 'search', 'pattern']) {
    const value = text(input[field], 300);
    if (value) result[field] = value;
  }
  for (const field of ['hitCount', 'fileCount', 'exitCode']) {
    if (count(input[field])) result[field] = input[field];
  }
  for (const field of ['lineRange', 'requestedRange']) {
    const range = input[field];
    if (count(range?.start)) result[field] = {
      start: range.start, ...(count(range.end) && range.end >= range.start ? { end: range.end } : {}),
    };
  }
  if (count(input.diffStat?.added) && count(input.diffStat?.removed)) {
    result.diffStat = { added: input.diffStat.added, removed: input.diffStat.removed };
  }
  const children = array(input.children).slice(0, MAX_CHILDREN).flatMap(child => {
    if (!key(child?.id) || !CHILD_STATUS.has(child.status)) return [];
    const model = text(child.model, 160) || modelOf(child.model);
    return [{ id: child.id, status: child.status, ...(model ? { model } : {}) }];
  });
  if (children.length) result.children = children;
  return Object.keys(result).length ? result : undefined;
}

function activityOf(input, turnId, context) {
  const id = key(input?.id);
  const position = positionOf(input?.position) || context.position;
  if (!id || !position || !ITEM_KIND.has(input.kind) || input.toolName === PLAN_TOOL_NAME) return null;
  const issue = issueOf(input.issue);
  const summary = summaryOf(input.summary);
  const detailRef = refOf(input.detailRef);
  return {
    id, turnId, parentId: key(input.parentId) || turnId + ':activity',
    sessionId: context.sessionId, position, source: member(ORIGIN, input.source, context.source),
    evidence: member(EVIDENCE, input.evidence, context.evidence), status: member(STATUS, input.status, 'unknown'),
    kind: input.kind, timing: timeOf(input.timing, context.timing), title: text(input.title, 300) || '执行活动',
    ...(input.kind !== 'compaction' ? { toolName: safeToolName(input.toolName) } : {}),
    ...(key(input.callId) ? { callId: input.callId } : {}),
    ...(key(input.responseId) ? { responseId: input.responseId } : {}),
    attemptId: key(input.attemptId), childIds: [...new Set(array(input.childIds).slice(0, MAX_CHILDREN).filter(key))],
    ...(summary ? { summary } : {}), ...(issue ? { issue } : {}), ...(detailRef ? { detailRef } : {}),
  };
}

function planOf(input, turn, context, prior) {
  if (!object(input) || !Array.isArray(input.items) || input.items.length > 100) return null;
  const originals = new Map(input.items.map(item => [item?.producerId, item]));
  if (originals.size !== input.items.length) return null;
  const plan = normalizePlan({
    tasks: [...originals].map(([id, item]) => ({ id, title: item?.title, status: item?.status, retained: item?.retained })),
    revision: input.revision, turnId: input.sourceTurnId, explanation: input.explanation,
  });
  if (!plan) return null;
  const previous = new Map(array(prior?.items).map(item => [item.producerId, item]));
  return {
    sourceTurnId: plan.turnId, revision: plan.revision, state: input.state,
    ...(plan.explanation ? { explanation: plan.explanation } : {}),
    items: plan.tasks.map((task, order) => {
      const old = previous.get(task.id);
      const original = originals.get(task.id);
      const issue = issueOf(original?.issue);
      return {
        id: old?.id || key(original?.id) || turn.id + ':plan:' + task.id,
        sessionId: context.sessionId, turnId: turn.id, parentId: turn.id,
        position: old?.position || positionOf(original?.position) || context.position,
        source: member(ORIGIN, original?.source, context.source),
        evidence: member(EVIDENCE, original?.evidence, context.evidence), timing: timeOf(original?.timing, old?.timing),
        producerId: task.id, title: task.title, status: task.status, order, planRevision: plan.revision,
        ...(task.retained ? { retained: true } : {}), ...(issue ? { issue } : {}),
      };
    }),
  };
}

function attemptOf(input, prior) {
  if (!key(input?.id) || !ATTEMPT_KIND.has(input.kind) || !STATUS.has(input.status)) return null;
  return { id: input.id, kind: input.kind, status: input.status, timing: timeOf(input.timing, prior?.timing) };
}

function makeTurn(id, context, input) {
  const { sessionId, position, source, evidence } = context;
  return {
    value: { id, sessionId, turnId: id, parentId: null, position, source, evidence,
      timing: timeOf(context.timing), status: 'queued', input, additionalInputs: [], attempts: [],
      plan: null, activityGroupId: null, completeness: 'complete' },
    latest: position, responses: new Map(), proposals: new Map(), planCalls: new Map(),
    confirmed: null, inputPosition: null,
  };
}

function putBounded(map, id, value, limit) {
  const trimmed = !map.has(id) && map.size >= limit;
  if (trimmed) map.delete(map.keys().next().value);
  map.set(id, value);
  return trimmed;
}

function newestPlan(turn) {
  let selected = turn.confirmed;
  for (const proposal of turn.proposals.values()) {
    if (!selected || compare(proposal.position, selected.position) > 0) selected = proposal;
  }
  turn.value.plan = selected?.plan ?? null;
}

function updatePlan(turn, fact, context) {
  const callId = key(fact.callId);
  const { position } = context;
  if (!callId || !['proposed', 'applied', 'rejected'].includes(fact.state)) return false;
  const latest = turn.planCalls.get(callId);
  if (latest && compare(position, latest) <= 0) return false;
  if (fact.state === 'rejected') {
    if (!turn.proposals.delete(callId)) return false;
  } else {
    const state = fact.state === 'applied' ? 'confirmed' : 'provisional';
    const plan = planOf({ ...fact.plan, state }, turn.value, context, turn.value.plan);
    if (!plan) return false;
    const entry = { position, plan };
    if (state === 'confirmed') {
      const old = turn.confirmed;
      if (old && (compare(position, old.position) <= 0 || (old.plan.sourceTurnId === plan.sourceTurnId
          && old.plan.revision !== null && (plan.revision === null || plan.revision <= old.plan.revision)))) return false;
      turn.confirmed = entry;
      for (const [id, proposal] of turn.proposals) {
        if (id === callId || compare(proposal.position, position) <= 0) turn.proposals.delete(id);
      }
    } else if (putBounded(turn.proposals, callId, entry, MAX_PROPOSALS)) {
      turn.value.completeness = 'partial';
    }
  }
  putBounded(turn.planCalls, callId, position, MAX_BLOCKS);
  newestPlan(turn);
  return true;
}


function groupOf(turn, items, id, sessionId) {
  const roots = items.filter(item => item.parentId === id);
  if (!roots.length) return null;
  const active = roots.filter(item => ACTIVE.has(item.status));
  const first = roots[0];
  const starts = roots.map(item => item.timing.startedAt).filter(count);
  const ends = roots.map(item => item.timing.endedAt).filter(count);
  const startedAt = starts.length ? Math.min(...starts) : null;
  const running = ACTIVE.has(turn.status);
  const terminalEnd = turn.timing.endedAt ?? (ends.length === roots.length ? Math.max(...ends) : null);
  const endedAt = running ? null : terminalEnd;
  const terminal = ['failed', 'interrupted', 'cancelled', 'incomplete', 'unknown']
    .find(value => roots.some(item => item.status === value));
  const status = running ? active.at(-1)?.status ?? turn.status : terminal ?? 'completed';
  const evidence = roots.some(item => item.timing.evidence === 'estimated') ? 'estimated' : first.timing.evidence;
  return {
    id, sessionId, parentId: turn.id, turnId: turn.id, position: first.position, source: first.source,
    evidence: first.evidence, status, timing: timeOf({ startedAt, endedAt, evidence }),
    activeItemId: active.at(-1)?.id ?? null, itemIds: roots.map(item => item.id), completeness: turn.completeness,
  };
}

function responseProjection(turn, toolResponses) {
  const responses = [...turn.responses.values()].sort((a, b) => compare(a.position, b.position));
  const tail = responses.at(-1);
  const settled = TERMINAL.has(turn.value.status);
  let tailKind = 'progress-text';
  if (tail && tail.stopReason !== 'toolUse' && !toolResponses.has(tail.message.id)) {
    if (settled && (turn.value.status !== 'completed' || ['length', 'error', 'aborted'].includes(tail.stopReason))) {
      tailKind = 'partial-answer';
    } else if ((!settled && !tail.done) || tail.stopReason === 'stop' || (settled && tail.done && !tail.stopReason)) {
      tailKind = 'answer';
    }
  }
  return {
    parts: responses.flatMap(response => response.parts.map(part => ({
      ...part, kind: part.kind === 'thinking' ? 'thinking' : response === tail ? tailKind : 'progress-text',
    }))),
    usage: responses.flatMap(response => response.usage ? [response.usage] : []),
  };
}

const bytes = executionTextBytes;
const partBytes = parts => parts.reduce((total, part) => total + bytes(part.text), 0);
const inputBytes = input => bytes(input?.preview?.text);
const turnBytes = turn => inputBytes(turn.value.input)
  + turn.value.additionalInputs.reduce((total, input) => total + inputBytes(input), 0)
  + [...turn.responses.values()].reduce((total, response) => total + partBytes(response.parts), 0);

export function createExecutionTimeline(initialScope) {
  let scope = scopeOf(initialScope);
  if (!scope) throw new TypeError('invalid execution timeline scope');
  const turns = new Map();
  const responseOwners = new Map();
  const items = new Map();
  const events = new Map();
  const evictedEvents = new Map();
  const aliases = new Map();
  const submissions = new Map();
  let partial = false;
  let contentBytes = 0;
  let coveredThrough = -1;
  let leafId = null;

  function canonical(id) {
    while (aliases.has(id)) id = aliases.get(id);
    return id;
  }

  function context(position, observedAt = null) {
    const history = position.domain === 'history';
    return {
      sessionId: sessionOf(scope), position,
      source: history ? 'native-entry' : scope.kind === 'runtime' ? 'runtime-frame' : 'classic-rpc',
      evidence: history ? 'legacy' : 'verified',
      timing: { startedAt: integer(observedAt), evidence: integer(observedAt) === null ? 'unknown' : 'observed' },
    };
  }

  function trimTurns() {
    if (turns.size <= MAX_BLOCKS) return;
    const [id, turn] = [...turns].find(([, turn]) => TERMINAL.has(turn.value.status)) || turns.entries().next().value;
    contentBytes -= turnBytes(turn);
    for (const response of turn.responses.values()) responseOwners.delete(response);
    turns.delete(id);
    for (const [itemId, item] of items) if (item.value.turnId === id) items.delete(itemId);
    for (const [submission, owner] of submissions) if (owner === id) submissions.delete(submission);
    partial = true;
  }

  function trimResponses() {
    while (responseOwners.size > MAX_BLOCKS) {
      let earliest = null;
      for (const response of responseOwners.keys()) {
        if (!earliest || compare(response.position, earliest.position) < 0) earliest = response;
      }
      const owner = responseOwners.get(earliest);
      responseOwners.delete(earliest);
      owner.responses.delete(earliest.message.id);
      owner.value.completeness = 'partial';
      contentBytes -= partBytes(earliest.parts);
    }
  }

  function trimContent() {
    if (contentBytes <= MAX_TIMELINE_CHARS) return;
    const retained = [];
    for (const turn of turns.values()) {
      const { value } = turn;
      for (const input of [value.input, ...value.additionalInputs]) {
        if (input?.preview?.text) retained.push({ content: input.preview, position: value.position, turn });
      }
      for (const response of turn.responses.values()) {
        for (const part of response.parts) {
          if (part.text) retained.push({ content: part, position: part.position, turn });
        }
      }
    }
    retained.sort((a, b) => compare(a.position, b.position));
    for (const { content, turn } of retained) {
      if (contentBytes <= MAX_TIMELINE_CHARS) break;
      contentBytes -= bytes(content.text);
      content.text = '';
      content.truncated = true;
      turn.value.completeness = 'partial';
    }
  }

  function remember(eventId, position) {
    if (events.size >= MAX_EVENTS) {
      const [oldId, oldPosition] = events.entries().next().value;
      events.delete(oldId);
      const previous = evictedEvents.get(oldPosition.stream);
      if (!previous || compare(oldPosition, previous) > 0) {
        putBounded(evictedEvents, oldPosition.stream, oldPosition, MAX_PROPOSALS);
      }
    }
    events.set(eventId, position);
  }

  function responseFor(turn, input, position) {
    const id = canonical(input.id);
    let response = turn.responses.get(id);
    if (!response) {
      response = { message: { ...input, id }, position, latest: position, parts: [], usage: null, done: false };
      turn.responses.set(id, response);
      responseOwners.set(response, turn);
    }
    return response;
  }

  function applyMessage(turn, fact, position) {
    if (fact.type === 'message.start') {
      const message = messageOf(fact.message);
      if (!message || turn.responses.has(canonical(message.id))) return false;
      responseFor(turn, message, position);
      return true;
    }
    if (!key(fact.responseId)) return false;
    const id = canonical(fact.responseId);
    let response = turn.responses.get(id);
    if (response?.done || (response && compare(position, response.latest) < 0)) return false;
    if (fact.type === 'message.delta') {
      if (!response || !count(fact.partIndex) || !['thinking', 'text'].includes(fact.kind)
          || typeof fact.delta !== 'string' || !fact.delta) return false;
      let part = response.parts.find(candidate => candidate.partIndices.includes(fact.partIndex));
      if (!part) {
        if (response.parts.length >= MAX_CONTENT_SEGMENTS) { turn.value.completeness = 'partial'; return true; }
        part = { id: id + ':part:' + fact.partIndex, message: response.message, partIndices: [fact.partIndex],
          position, kind: fact.kind === 'thinking' ? 'thinking' : 'progress-text', text: '' };
        response.parts.push(part);
      }
      const limit = part.kind === 'thinking' ? MAX_THINKING_TEXT : MAX_BLOCK_TEXT;
      const bounded = executionBoundText((part.text || '') + text(fact.delta, MAX_TIMELINE_CHARS), limit);
      contentBytes += bytes(bounded.text) - bytes(part.text);
      part.text = bounded.text;
      if (bounded.truncated || fact.truncated === true || fact.delta.length > MAX_TIMELINE_CHARS) part.truncated = true;
    } else {
      if (!Array.isArray(fact.parts)) return false;
      if (!response) {
        const message = messageOf(fact.parts[0]?.message) || {
          id, content: { id, source: 'live-buffer', state: 'unavailable' },
        };
        response = responseFor(turn, { ...message, id }, position);
      }
      contentBytes -= partBytes(response.parts);
      response.parts = fact.parts.slice(0, MAX_CONTENT_SEGMENTS).flatMap(input => {
        const part = partOf(input, response.message, position);
        if (!part || canonical(part.message.id) !== id) return [];
        part.message.id = id;
        return [part];
      });
      contentBytes += partBytes(response.parts);
      if (fact.parts.length !== response.parts.length) turn.value.completeness = 'partial';
      response.done = true;
      response.stopReason = text(fact.stopReason, 32) || undefined;
      response.usage = usageOf(fact.usage, id, position);
    }
    response.latest = position;
    trimContent();
    return true;
  }

  function applyActivity(turn, fact, provenance) {
    const { value } = turn;
    if (fact.type === 'activity.start') {
      if (fact.item?.turnId && canonical(fact.item.turnId) !== value.id) return false;
      const item = activityOf(fact.item, value.id, provenance);
      if (!item) return false;
      item.id = canonical(item.id);
      item.parentId = canonical(item.parentId);
      if (items.has(item.id) || item.id === item.parentId) return false;
      const parent = items.get(item.parentId)?.value;
      if (parent ? parent.turnId !== value.id : value.activityGroupId && value.activityGroupId !== item.parentId) return false;
      if (!parent) value.activityGroupId = item.parentId;
      if (putBounded(items, item.id, { value: item, latest: provenance.position }, MAX_ITEMS)) partial = true;
      return true;
    }
    if (!key(fact.itemId) || !object(fact.patch)) return false;
    const stored = items.get(canonical(fact.itemId));
    if (stored?.value.turnId !== value.id || compare(provenance.position, stored.latest) <= 0) return false;
    const item = stored.value;
    const patch = fact.patch;
    const status = member(STATUS, patch.status, item.status);
    if (!ACTIVE.has(item.status) && status !== item.status) return false;
    const endedAt = ACTIVE.has(status) ? null : provenance.timing.startedAt;
    const summary = summaryOf(patch.summary);
    stored.value = activityOf({
      ...item, status, title: text(patch.title, 300) || item.title,
      timing: timeOf(patch.timing, { ...item.timing, endedAt: item.timing.endedAt ?? endedAt }),
      issue: issueOf(patch.issue) || item.issue, detailRef: refOf(patch.detailRef) || item.detailRef,
      summary: summary ? { ...item.summary, ...summary } : item.summary,
      childIds: Array.isArray(patch.childIds) ? patch.childIds : item.childIds,
    }, value.id, provenance);
    stored.latest = provenance.position;
    return true;
  }

  function settle(turn, fact, provenance) {
    if (!TERMINAL.has(fact.status)) return false;
    const { value } = turn;
    const endedAt = provenance.timing.startedAt;
    value.status = fact.status;
    value.timing = timeOf({ endedAt }, value.timing);
    const issue = issueOf(fact.issue);
    if (issue) value.issue = issue;
    for (const attempt of value.attempts) {
      if (!ACTIVE.has(attempt.status)) continue;
      attempt.status = fact.status;
      attempt.timing = timeOf({ endedAt }, attempt.timing);
    }
    for (const entry of items.values()) {
      const item = entry.value;
      if (item.turnId !== value.id || !ACTIVE.has(item.status)) continue;
      item.status = ['cancelled', 'interrupted'].includes(fact.status) ? 'interrupted' : 'incomplete';
      item.timing = timeOf({ endedAt }, item.timing);
      entry.latest = provenance.position;
    }
    if (value.plan?.items.some(item => ['pending', 'in_progress'].includes(item.status))) {
      value.plan = { ...value.plan, state: 'stalled' };
    }
    return true;
  }

  function applyTurn(turn, fact, provenance) {
    const { value } = turn;
    const terminal = TERMINAL.has(value.status);
    if (fact.type === 'attempt') {
      const index = value.attempts.findIndex(attempt => attempt.id === fact.attempt?.id);
      const prior = value.attempts[index];
      const attempt = attemptOf(fact.attempt, prior);
      if (!attempt || (prior && !ACTIVE.has(prior.status) && attempt.status !== prior.status)
          || (terminal && (prior || attempt.kind !== 'fallback' || attempt.status !== 'running'))) return false;
      if (prior) value.attempts[index] = attempt;
      else if (value.attempts.length < MAX_BLOCKS) value.attempts.push(attempt);
      else { value.completeness = 'partial'; return true; }
      if (terminal) {
        value.status = 'running';
        value.timing = { ...value.timing, endedAt: null, durationMs: null };
        delete value.issue;
        newestPlan(turn);
      }
      if (value.status === 'queued') value.status = 'running';
      return true;
    }
    if (terminal) return false;
    switch (fact.type) {
      case 'turn.state':
        if (!ACTIVE.has(fact.status) || compare(provenance.position, turn.latest) < 0) return false;
        value.status = fact.status;
        return true;
      case 'turn.input': {
        const input = userMessageOf(fact.input);
        if (!input) return false;
        if (fact.role === 'initial') {
          if (turn.inputPosition && compare(provenance.position, turn.inputPosition) <= 0) return false;
          contentBytes += inputBytes(input) - inputBytes(value.input);
          value.input = input;
          turn.inputPosition = provenance.position;
        } else if (fact.role === 'additional') {
          if (value.input?.id === input.id) return false;
          const index = value.additionalInputs.findIndex(previous => previous.id === input.id);
          if (index !== -1) {
            contentBytes += inputBytes(input) - inputBytes(value.additionalInputs[index]);
            value.additionalInputs[index] = input;
          } else if (value.additionalInputs.length < MAX_BLOCKS) {
            contentBytes += inputBytes(input);
            value.additionalInputs.push(input);
          } else value.completeness = 'partial';
        } else return false;
        trimContent();
        return true;
      }
      case 'message.start':
      case 'message.delta':
      case 'message.end':
        return applyMessage(turn, fact, provenance.position);
      case 'activity.start':
      case 'activity.update':
        return applyActivity(turn, fact, provenance);
      case 'plan':
        return updatePlan(turn, fact, provenance);
      case 'turn.settle':
        return settle(turn, fact, provenance);
      default: return false;
    }
  }

  function apply(event) {
    const position = positionOf(event?.position);
    const eventId = key(event?.eventId);
    const incoming = scopeOf(event?.scope);
    const fact = event?.fact;
    if (position?.domain !== 'live' || !eventId || !incoming || !object(fact) || events.has(eventId)) return false;
    const evicted = evictedEvents.get(position.stream);
    if (evicted && compare(position, evicted) <= 0) return false;
    const matches = sameScope(scope, incoming);
    if (!matches && (sessionOf(scope) !== null || sessionOf(incoming) === null
        || !sameScope(scope, incoming, true) || !sameScope(scope, scopeOf(event.previousScope)))) return false;
    if (fact.type === 'scope.bind') {
      if (matches) return false;
      scope = incoming;
      remember(eventId, position);
      return true;
    }
    const turnId = key(event.turnId) ? canonical(event.turnId) : null;
    const turn = turns.get(turnId);
    if (position.domain === 'live' && position.sequence <= coveredThrough) return false;
    const provenance = { ...context(position, event.observedAt), sessionId: sessionOf(incoming) };
    if (fact.type === 'coverage.partial') {
      partial = true;
      if (turn) turn.value.completeness = 'partial';
    } else if (fact.type === 'turn.open') {
      const submission = key(fact.submissionId);
      if (!turnId || !submission || turn || submissions.has(submission)) return false;
      const input = userMessageOf(fact.input);
      turns.set(turnId, makeTurn(turnId, provenance, input));
      contentBytes += inputBytes(input);
      trimContent();
      submissions.set(submission, turnId);
      trimTurns();
    } else {
      if (!turn || !applyTurn(turn, fact, provenance)) return false;
      if (['message.start', 'message.end', 'activity.start'].includes(fact.type) && turn.value.status === 'queued') {
        turn.value.status = 'running';
      }
      if (compare(position, turn.latest) > 0) turn.latest = position;
    }
    trimResponses();
    scope = incoming;
    remember(eventId, position);
    return true;
  }


  function promote(pairs) {
    const additions = new Map();
    const targets = new Set();
    for (const pair of pairs) {
      if (!key(pair?.from) || !key(pair.to)) return false;
      const from = canonical(pair.from);
      const to = canonical(pair.to);
      if (from === to) continue;
      if (additions.has(from) || additions.has(to) || targets.has(from) || targets.has(to)) return false;
      if ((turns.has(from) && turns.has(to)) || (items.has(from) && items.has(to))
          || (turns.has(from) && items.has(to)) || (items.has(from) && turns.has(to))) return false;
      additions.set(from, to);
      targets.add(to);
    }
    if (!additions.size) return true;
    if (aliases.size + additions.size > MAX_ALIASES) return false;
    for (const [from, to] of additions) aliases.set(from, to);

    const remap = value => value ? canonical(value) : value;
    const remapMessage = message => message && { ...message, id: remap(message.id) };
    const oldTurns = [...turns];
    turns.clear();
    for (const [id, turn] of oldTurns) {
      const next = remap(id);
      const { value } = turn;
      const group = value.activityGroupId;
      if (group === id + ':activity' && next !== id && !aliases.has(group) && aliases.size < MAX_ALIASES) {
        aliases.set(group, next + ':activity');
      }
      value.id = next;
      value.turnId = next;
      value.activityGroupId = remap(group);
      value.input = remapMessage(value.input);
      value.additionalInputs = value.additionalInputs.map(remapMessage);
      for (const attempt of value.attempts) attempt.id = remap(attempt.id);
      const plans = new Set([value.plan, turn.confirmed?.plan, ...[...turn.proposals.values()].map(entry => entry.plan)]);
      for (const plan of plans) {
        if (!plan) continue;
        plan.items = plan.items.map(item => ({ ...item, id: remap(item.id), turnId: next, parentId: next }));
      }
      turn.responses = new Map([...turn.responses].map(([responseId, response]) => {
        const nextResponse = remap(responseId);
        response.message = remapMessage(response.message);
        response.parts = response.parts.map(part => ({
          ...part, id: remap(part.id), message: remapMessage(part.message),
        }));
        if (response.usage) response.usage.responseId = nextResponse;
        return [nextResponse, response];
      }));
      turns.set(next, turn);
    }
    const oldItems = [...items.values()];
    items.clear();
    for (const item of oldItems) {
      const { value } = item;
      item.value = { ...value, id: remap(value.id), turnId: remap(value.turnId),
        parentId: remap(value.parentId), attemptId: remap(value.attemptId), childIds: value.childIds.map(remap),
        ...(value.responseId ? { responseId: remap(value.responseId) } : {}) };
      items.set(item.value.id, item);
    }
    for (const [submission, turnId] of submissions) submissions.set(submission, remap(turnId));
    return true;
  }

  function canReplace(entry, certified, through) {
    return certified && !ACTIVE.has(entry.value.status)
      && (entry.latest.domain !== 'live' || entry.latest.sequence <= through);
  }

  function restoreTurn(input, position, id, groupId, certified) {
    const provenance = { ...context(position), evidence: certified ? 'verified' : 'partial' };
    const turn = makeTurn(id, provenance, userMessageOf(input.input));
    contentBytes += inputBytes(turn.value.input);
    const { value } = turn;
    value.status = !certified || ACTIVE.has(input.status) ? 'unknown' : member(STATUS, input.status, 'unknown');
    value.timing = timeOf(input.timing);
    value.completeness = !certified || input.completeness === 'partial' ? 'partial' : 'complete';
    const issue = issueOf(input.issue);
    if (issue) value.issue = issue;
    value.additionalInputs = array(input.additionalInputs).slice(0, MAX_BLOCKS).map(userMessageOf).filter(Boolean);
    contentBytes += value.additionalInputs.reduce((total, message) => total + inputBytes(message), 0);
    value.attempts = array(input.attempts).slice(0, MAX_BLOCKS).map(attempt => attemptOf(attempt)).filter(Boolean);
    value.activityGroupId = groupId || null;
    const plan = planOf(input.plan, value, provenance);
    if (plan) {
      plan.state = certified && ['confirmed', 'provisional', 'stalled'].includes(input.plan?.state)
        ? input.plan.state : 'stalled';
      turn.confirmed = { position, plan };
      value.plan = plan;
    }
    for (const raw of array(input.parts).slice(-MAX_CONTENT_SEGMENTS)) {
      const part = partOf(raw, null, position);
      if (!part) continue;
      const response = responseFor(turn, part.message, part.position);
      response.parts.push(part);
      contentBytes += bytes(part.text);
      response.done = true;
      if (part.kind === 'answer') response.stopReason = 'stop';
      else if (part.kind === 'partial-answer') response.stopReason = 'length';
      else if (!response.stopReason) response.stopReason = 'toolUse';
    }
    for (const row of array(input.usage).slice(-MAX_BLOCKS)) {
      const responseId = key(row?.responseId);
      if (!responseId) continue;
      const rowPosition = positionOf(row.position) || position;
      const response = responseFor(turn, { id: responseId,
        content: { id: responseId, source: 'native-entry', state: 'unavailable' } }, rowPosition);
      response.usage = usageOf(row, response.message.id, rowPosition);
      response.done = true;
    }
    return turn;
  }

  function mergeHistory(cut) {
    if (!sameScope(scope, scopeOf(cut?.scope))) return false;
    const enteringLeaf = key(cut.branch?.leafId);
    const certified = cut.verified === true && enteringLeaf !== null && count(cut.coveredThrough);
    if (leafId && enteringLeaf !== leafId && (!certified || cut.branch.previousLeafId !== leafId)) return false;
    if (certified && cut.coveredThrough < coveredThrough) return false;
    if (certified && (array(cut.aliases).length > MAX_ALIASES || !promote(array(cut.aliases)))) return false;
    const listedTurns = array(cut.turns).slice(-MAX_BLOCKS);
    const groupByTurn = new Map(array(cut.groups).slice(-MAX_BLOCKS)
      .filter(group => key(group?.turnId) && key(group.id))
      .map(group => [canonical(group.turnId), canonical(group.id)]));
    if (!certified || cut.completeness === 'partial' || listedTurns.length < array(cut.turns).length) partial = true;
    for (const input of listedTurns) {
      const position = positionOf(input?.position);
      const id = key(input?.id) ? canonical(input.id) : null;
      if (!id || position?.domain !== 'history' || (input.sessionId !== undefined && input.sessionId !== sessionOf(scope))) continue;
      const prior = turns.get(id);
      if (prior && !canReplace(prior, certified, cut.coveredThrough)) continue;
      if (prior) {
        contentBytes -= turnBytes(prior);
        for (const response of prior.responses.values()) responseOwners.delete(response);
      }
      const groupId = groupByTurn.get(id) ?? prior?.value.activityGroupId;
      turns.set(id, restoreTurn(input, position, id, groupId, certified));
      trimResponses();
      trimTurns();
    }
    for (const input of array(cut.items).slice(-MAX_ITEMS)) {
      const id = key(input?.id) ? canonical(input.id) : null;
      const turnId = key(input?.turnId) ? canonical(input.turnId) : null;
      const turn = turns.get(turnId);
      const position = positionOf(input?.position);
      if (!id || !turn || position?.domain !== 'history' || (input.sessionId !== undefined && input.sessionId !== sessionOf(scope))) continue;
      const prior = items.get(id);
      if (prior && (prior.value.turnId !== turnId || !canReplace(prior, certified, cut.coveredThrough))) continue;
      const parentId = key(input.parentId) ? canonical(input.parentId) : turnId + ':activity';
      const parent = items.get(parentId)?.value;
      if (id === parentId || (parent ? parent.turnId !== turnId
        : turn.value.activityGroupId && turn.value.activityGroupId !== parentId)) continue;
      const item = activityOf({ ...input, id, parentId }, turnId, context(position));
      if (!item) continue;
      if (!certified || ACTIVE.has(item.status)) {
        item.status = 'unknown';
        item.evidence = 'partial';
      }
      if (!parent) turn.value.activityGroupId = parentId;
      if (putBounded(items, id, { value: item, latest: position }, MAX_ITEMS)) partial = true;
    }
    if (certified) {
      coveredThrough = cut.coveredThrough;
      leafId = enteringLeaf;
    }
    trimContent();
    return true;
  }

  function snapshot() {
    const ordered = [...turns.values()].sort((a, b) => compare(a.value.position, b.value.position));
    const rows = [];
    const groups = [];
    const activities = [];
    const byTurn = new Map();
    const sessionId = sessionOf(scope);
    for (const { value } of items.values()) {
      if (!byTurn.has(value.turnId)) byTurn.set(value.turnId, []);
      byTurn.get(value.turnId).push({ ...value, sessionId });
    }
    for (const turn of ordered) {
      const { value } = turn;
      const turnItems = byTurn.get(value.id) ?? [];
      turnItems.sort((a, b) => compare(a.position, b.position));
      const group = groupOf(value, turnItems, value.activityGroupId, sessionId);
      if (group) groups.push(group);
      activities.push(...turnItems);
      const toolResponses = new Set(turnItems.map(item => item.responseId).filter(Boolean));
      const projection = responseProjection(turn, toolResponses);
      const plan = value.plan && { ...value.plan, items: value.plan.items.map(item => ({ ...item, sessionId })) };
      rows.push({ ...value, ...projection, sessionId, plan, activityGroupId: group?.id ?? null });
    }
    const completeness = partial || rows.some(turn => turn.completeness === 'partial') ? 'partial' : 'complete';
    const projection = { scope, turns: rows, groups, items: activities, completeness };
    return typeof structuredClone === 'function' ? structuredClone(projection) : JSON.parse(JSON.stringify(projection));
  }

  return { apply, mergeHistory, snapshot };
}
