import { createExecutionTimeline, executionBoundText as boundText, executionTextBytes } from './execution-timeline-model.js';
import { createExecutionCallIndex } from './execution-call-index.js';
import { normalizePlan, PLAN_TOOL_NAME } from './plan-model.js';
import { MAX_CONTENT_SEGMENTS, MAX_BLOCK_TEXT, MAX_THINKING_TEXT, MAX_USER_TEXT, safeToolName } from './runtime-timeline.js';

const MAX_PENDING = 200;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_TRACKED = 256;
const MAX_WAIT_MS = 2000;
const MAX_MESSAGES = 32;
const MAX_MESSAGE_BYTES = 512 * 1024;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TURN_COMMANDS = new Set(['prompt', 'steer', 'follow_up']);
const KNOWN_EVENTS = new Set([
  'execution_submission', 'response', 'message_start', 'message_update', 'message_end',
  'agent_start', 'agent_settled', 'tool_execution_start', 'tool_execution_update',
  'tool_execution_end', 'tool_wait_state', 'auto_retry_start', 'auto_retry_end',
  'compaction_start', 'compaction_end', 'stop_state', 'execution_stop', 'bridge_status', 'message_edit',
]);
const idOf = value => typeof value === 'string' && value && value.length <= 256 ? value : null;
const timeOf = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const durationOf = value => Number.isFinite(value) && value >= 0 ? value : null;

function sameRecord(left, right) {
  return Boolean(left && right && Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && left[key] === right[key]));
}

export function sameExecutionScope(left, right) {
  if (!left || !right || left.kind !== right.kind || (left.branchEpoch ?? 0) !== (right.branchEpoch ?? 0)) return false;
  return left.kind === 'runtime' ? sameRecord(left.owner, right.owner) : sameRecord(left, right);
}

const sessionOf = scope => scope.kind === 'runtime' ? scope.owner.sessionId : scope.sessionId;
const streamOf = scope => JSON.stringify(scope.kind === 'runtime'
  ? ['runtime', scope.owner.backendInstance, scope.owner.conversationId, scope.owner.runtimeId, scope.owner.runtimeGeneration, scope.branchEpoch ?? 0]
  : ['classic', scope.bridgeInstance, scope.bridgeRun, scope.workspaceKey, scope.workspaceGeneration, scope.branchEpoch ?? 0]);

function timing(startedAt = null, endedAt = null, duration = null) {
  return { startedAt, endedAt, durationMs: duration ?? (startedAt !== null && endedAt !== null && endedAt >= startedAt
    ? endedAt - startedAt : null), evidence: duration !== null ? 'recorded' : startedAt !== null ? 'observed' : 'unknown' };
}

function safePayloadRef(value) {
  if (idOf(value?.id) && ['live-buffer', 'native-entry'].includes(value.source)
      && ['available', 'pending', 'unavailable', 'restricted'].includes(value.state)) {
    return { id: value.id, source: value.source, state: value.state };
  }
  return null;
}

function planResult(event) {
  const details = event.result?.details;
  return normalizePlan(event.plan || (details?.tool === PLAN_TOOL_NAME && details.version === 1 ? details : null));
}

function planFact(source) {
  return source && {
    sourceTurnId: source.turnId, revision: source.revision, explanation: source.explanation,
    items: source.tasks.map(task => ({ ...task, producerId: task.id })),
  };
}

function outcome(event, active) {
  if (event.type === 'bridge_status') return 'interrupted';
  if (event.type === 'stop_state' && event.state === 'reset') return 'interrupted';
  if (event.aborted === true || event.state === 'stopped' || event.type === 'execution_stop'
      || (active.stop && active.stopReason === 'aborted')) return 'cancelled';
  if (active.stopReason === 'aborted') return 'interrupted';
  if (event.type === 'response' && event.success === false
      || event.generationResult?.outcome === 'failed' || active.stopReason === 'error') return 'failed';
  if (event.generationResult?.outcome === 'success' || ['stop', 'length'].includes(active.stopReason)) return 'completed';
  return 'unknown';
}

// One state machine for both transports. This owns shadow state only; all host
// lifecycle, approval, fallback and notification consumers keep their old paths.
export function createExecutionStream(initialScope, { startSequence = 0, maxPending = MAX_PENDING,
  maxPendingBytes = MAX_PENDING_BYTES, waitMs = MAX_WAIT_MS } = {}) {
  const model = createExecutionTimeline(initialScope);
  let scope = initialScope;
  const stream = streamOf(scope);
  const source = scope.kind === 'runtime' ? 'runtime-frame' : 'classic-rpc';
  const continuous = scope.kind === 'runtime';
  const submissions = new Map();
  const calls = createExecutionCallIndex(MAX_TRACKED);
  const earlyEnd = new Map();
  const pending = new Map();
  const messages = new Map();
  const nativeWitnesses = new Map();
  let cursor = startSequence;
  let pendingBytes = 0;
  let messageBytes = 0;
  let holeSince = null;
  let active = null;
  let recentUnattributed = null;
  let response = null;
  let responseEnded = false;
  let userEcho = null;
  let frame = null;

  function messageRef(id, message) {
    const content = { id, source: 'live-buffer', state: 'unavailable' };
    if (message?.role !== 'user') return { id, content };
    if (messages.has(id)) {
      messageBytes -= messages.get(id).bytes;
      messages.delete(id);
    }
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const selected = Array.isArray(parts) ? parts.slice(0, MAX_CONTENT_SEGMENTS) : [];
    let previewText = '', previewTruncated = false, bytes = 0;
    const stored = [], attachments = [];
    for (const part of selected) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        const preview = boundText(part.text.slice(-MAX_USER_TEXT), MAX_USER_TEXT);
        previewTruncated ||= preview.truncated || part.text.length > MAX_USER_TEXT;
        const next = boundText((previewText ? previewText + '\n' : '') + preview.text, MAX_USER_TEXT);
        previewText = next.text;
        previewTruncated ||= next.truncated;
        bytes += part.text.length > MAX_MESSAGE_BYTES ? MAX_MESSAGE_BYTES + 1 : executionTextBytes(part.text);
        stored.push({ type: 'text', text: part.text });
      } else if (part?.type === 'image' && IMAGE_MIME.has(part.mimeType) && typeof part.data === 'string') {
        attachments.push({ kind: 'image', mimeType: part.mimeType });
        bytes += part.data.length + part.mimeType.length;
        if (bytes <= MAX_MESSAGE_BYTES && /^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) {
          stored.push({ type: 'image', mimeType: part.mimeType, data: part.data });
        }
      }
    }
    if (Array.isArray(parts) && stored.length && stored.length === parts.length && bytes <= MAX_MESSAGE_BYTES) {
      bytes += stored.length * 96;
      if (bytes <= MAX_MESSAGE_BYTES) {
        while (messages.size >= MAX_MESSAGES || messageBytes + bytes > MAX_MESSAGE_BYTES) {
          const oldest = messages.keys().next().value;
          messageBytes -= messages.get(oldest).bytes;
          messages.delete(oldest);
        }
        messages.set(id, { bytes, content: stored });
        messageBytes += bytes;
        content.state = 'available';
      }
    }
    return { id, content, attachments, preview: { text: previewText, truncated: previewTruncated } };
  }

  function position() {
    return { domain: 'live', stream, sequence: frame.sequence, part: frame.part };
  }
  function fact(value, turnId = active?.id, extra) {
    const pos = position();
    frame.part++;
    return model.apply({ scope, turnId, eventId: JSON.stringify([stream, pos.sequence, pos.part]),
      position: pos, observedAt: frame.at, fact: value, ...extra });
  }
  function partial(turnId) {
    fact({ type: 'coverage.partial' }, turnId);
  }
  function boundedSet(map, key, value) {
    if (!map.has(key) && map.size >= MAX_TRACKED) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
      if (map === earlyEnd) calls.retire(oldest);
      partial();
    }
    map.set(key, value);
  }
  function scoped(id, parentId, status, span, evidence = 'verified') {
    return { id, sessionId: sessionOf(scope), turnId: active.id, parentId, position: position(),
      source, evidence, timing: span, status };
  }
  function locate(event, command) {
    const requestId = idOf(event.generationRequestId) || idOf(event.id);
    const exact = requestId && submissions.get(requestId);
    if (exact && (!command || exact.command === command)) return exact;
    const candidates = [...submissions.values()].filter(entry => !entry.delivered && !entry.rejected
      && (!command || entry.command === command));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) partial();
    return null;
  }
  function attempt(kind, id, status = 'running') {
    active.attempt = { id, kind, status, timing: timing(frame.at) };
    fact({ type: 'attempt', attempt: active.attempt });
  }
  function closeAttempt(status) {
    if (!active.attempt || active.attempt.status !== 'running') return;
    active.attempt = { ...active.attempt, status, timing: timing(active.attempt.timing.startedAt, frame.at) };
    fact({ type: 'attempt', attempt: active.attempt });
  }
  function open(entry = null) {
    if (active) return;
    const id = entry?.turnId || 'turn:' + frame.sequence;
    const fallback = Boolean(entry?.fallbackOf && entry.turnId);
    active = { id, startedAt: frame.at, input: fallback, stop: false, stopReason: null,
      attempt: null, compaction: null, retryId: null, hadFallback: fallback, submissions: new Set() };
    response = null;
    responseEnded = false;
    userEcho = null;
    recentUnattributed = null;
    if (entry) { entry.turnId = id; active.submissions.add(entry.id); }
    if (!fallback) fact({ type: 'turn.open', submissionId: entry?.id || id });
    attempt(fallback ? 'fallback' : 'initial', id + ':attempt:' + frame.sequence);
  }
  function submit(event) {
    const id = idOf(event.id);
    if (!id || !TURN_COMMANDS.has(event.command) || submissions.has(id)) return;
    const fallbackOf = idOf(event.fallbackOf);
    const previous = fallbackOf && submissions.get(fallbackOf);
    const entry = { id, command: event.command, fallbackOf: previous?.settled && previous.canFallback ? fallbackOf : null,
      turnId: previous?.settled && previous.canFallback ? previous.turnId : null, delivered: false, replied: false,
      editOf: idOf(event.editOf), inputId: null };
    // Private edit RPC replies may resolve after their user echo in the same
    // stdout chunk. The successful navigation created a fresh branch stream;
    // only its one otherwise unattributed initial input is eligible.
    if (entry.editOf && recentUnattributed) {
      entry.inputId = recentUnattributed.id;
      entry.turnId = recentUnattributed.turnId;
      entry.delivered = true;
      if (active?.id === entry.turnId) active.submissions.add(entry.id);
      recentUnattributed = null;
    }
    boundedSet(submissions, id, entry);
  }
  function receiveUser(event) {
    const entry = locate(event);
    if (!active) open(entry);
    if (entry && entry.turnId && entry.turnId !== active.id) { partial(); return; }
    if (entry) {
      entry.delivered = true;
      entry.turnId = active.id;
      active.submissions.add(entry.id);
    }
    const id = active.id + ':input:' + frame.sequence;
    userEcho = { id, skipped: Boolean(entry?.fallbackOf && active.input) };
    if (userEcho.skipped) return;
    const role = active.input ? 'additional' : 'initial';
    active.input = true;
    userEcho.role = role;
    boundedSet(nativeWitnesses, id, { id, role: 'user', turnId: active.id });
    if (role === 'initial' && entry?.editOf) entry.inputId = id;
    if (role === 'initial' && !entry && active.submissions.size === 0) recentUnattributed = { id, turnId: active.id };
    fact({ type: 'turn.input', input: messageRef(id, event.message), role });
  }
  function assistantStart(message) {
    const id = active.id + ':response:' + frame.sequence;
    response = { id, message: messageRef(id, message), calls: new Set() };
    responseEnded = false;
    userEcho = null;
    fact({ type: 'message.start', message: response.message });
  }
  function assistantDelta(event) {
    const update = event.assistantMessageEvent;
    if (!update || !['thinking_delta', 'text_delta'].includes(update.type)
        || !Number.isSafeInteger(update.contentIndex) || update.contentIndex < 0 || update.contentIndex >= MAX_CONTENT_SEGMENTS
        || typeof update.delta !== 'string') return;
    if (!response || responseEnded) { partial(); assistantStart(event.message); }
    const bounded = boundText(update.delta, update.type === 'thinking_delta' ? MAX_THINKING_TEXT : MAX_BLOCK_TEXT);
    fact({ type: 'message.delta', responseId: response.id, partIndex: update.contentIndex,
      kind: update.type === 'thinking_delta' ? 'thinking' : 'text',
      delta: bounded.text, truncated: bounded.truncated });
  }
  function assistantEnd(message) {
    if (!response) { partial(); assistantStart(message); }
    if (responseEnded) { partial(); return; }
    responseEnded = true;
    response.message = messageRef(response.id, message);
    const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    const reportedStop = ['stop', 'toolUse', 'length', 'aborted', 'error'].includes(message.stopReason) ? message.stopReason : undefined;
    const stopReason = content.some(part => part?.type === 'toolCall') && reportedStop === 'stop' ? 'toolUse' : reportedStop;
    active.stopReason = stopReason;
    const parts = [];
    const declaredCalls = [];
    content.slice(0, MAX_CONTENT_SEGMENTS).forEach((part, index) => {
      if (part?.type === 'toolCall' && idOf(part.id)) {
        response.calls.add(part.id);
        declaredCalls.push({ id: part.id, index, name: safeToolName(part.name) });
      }
      const thinking = part?.type === 'thinking';
      const text = thinking ? part.thinking : part?.type === 'text' ? part.text : null;
      if (typeof text !== 'string' || !text) return;
      const bounded = boundText(text, thinking ? MAX_THINKING_TEXT : MAX_BLOCK_TEXT);
      parts.push({ id: response.id + ':part:' + index, message: response.message, partIndices: [index],
        position: { ...position(), part: index }, kind: thinking ? 'thinking' : 'progress-text',
        text: bounded.text, truncated: bounded.truncated });
    });
    boundedSet(nativeWitnesses, response.id, { id: response.id, role: 'assistant', turnId: active.id, toolCalls: declaredCalls });
    fact({ type: 'message.end', responseId: response.id, parts, stopReason, usage: message.usage && {
      responseId: response.id, model: idOf(message.model) ? { id: message.model, provider: idOf(message.provider) || undefined } : undefined,
      recorded: message.usage, position: position(),
    } });
  }
  function commandResponse(event) {
    if (!TURN_COMMANDS.has(event.command)) return;
    const exact = submissions.get(idOf(event.id));
    const candidates = event.id == null && !exact
      ? [...submissions.values()].filter(entry => entry.command === event.command && !entry.replied && !entry.settled) : [];
    const entry = exact || (candidates.length === 1 ? candidates[0] : null);
    if (!entry || entry.command !== event.command) return;
    entry.replied = true;
    if (event.success === true && event.data?.disposition === 'handled') {
      entry.rejected = true;
      return;
    }
    if (event.success === false) {
      entry.rejected = true;
      if (entry.command === 'prompt' && (!event.generationResult || event.generationResult.requestId === entry.id)) {
        if (!active) open(entry);
        if (active.id === entry.turnId) settle(event);
      }
    }
  }
  function callStart(event) {
    const callId = idOf(event.toolCallId);
    if (!callId) return;
    const toolName = safeToolName(event.toolName);
    const itemId = active.id + ':tool:' + frame.sequence;
    const call = { id: itemId, name: toolName, time: frame.at, turnId: active.id };
    const previous = calls.get(callId);
    const decision = calls.begin(callId, call);
    const end = earlyEnd.get(callId);
    earlyEnd.delete(callId);
    if (decision !== 'started') partial();
    if (decision === 'conflict') {
      calls.claimRetired(callId, active.id);
      abandonCall(callId, previous);
      return;
    }
    if (decision === 'overflow' || (decision === 'retired' && !calls.claimRetired(callId, active.id))) return;
    if (toolName === PLAN_TOOL_NAME) {
      if (decision !== 'started') return;
      const plan = normalizePlan(event.plan || event.args);
      if (plan) fact({ type: 'plan', callId, plan: planFact(plan), state: 'proposed' });
    } else {
      const summary = decision === 'started' ? event.activity : null;
      fact({ type: 'activity.start', item: { ...scoped(itemId, active.id + ':activity',
        decision === 'started' ? 'running' : 'incomplete', timing(frame.at)),
        kind: summary?.kind === 'subagent' ? 'subagent' : 'tool', toolName, callId, attemptId: active.attempt.id,
        responseId: response?.calls.has(callId) ? response.id : undefined, childIds: [],
        title: summary?.title || toolName, summary, detailRef: (decision === 'started' && safePayloadRef(event.detailRef)) || {
          id: itemId, source: 'live-buffer', state: scope.kind === 'runtime' ? 'restricted' : 'unavailable',
        } } });
    }
    if (end && decision === 'started') finishCall(end.event, end.at);
  }
  function finishCall(event, at = frame.at) {
    const callId = idOf(event.toolCallId);
    if (!callId) return;
    const call = calls.get(callId);
    if (!call) {
      if (calls.isRetired(callId)) return;
      if (earlyEnd.has(callId)) {
        earlyEnd.delete(callId);
        calls.retire(callId);
        partial();
        return;
      }
      boundedSet(earlyEnd, callId, { event: {
        toolCallId: callId, toolName: idOf(event.toolName), isError: event.isError === true, durationMs: durationOf(event.durationMs),
        plan: planResult(event), activity: event.activity, detailRef: safePayloadRef(event.detailRef),
      }, at });
      return;
    }
    // An end frame carries no response identifier in older Pi. A reused ID
    // can be recovered from an authoritative native result, not this frame.
    if (call.turnId !== active.id || (event.toolName != null && event.toolName !== call.name)) {
      partial();
      return;
    }
    calls.retire(callId);
    if (call.name === PLAN_TOOL_NAME) {
      const plan = planResult(event);
      fact({ type: 'plan', callId, plan: planFact(plan), state: event.isError || !plan ? 'rejected' : 'applied' });
      return;
    }
    const duration = durationOf(event.durationMs);
    const detailRef = safePayloadRef(event.detailRef);
    fact({ type: 'activity.update', itemId: call.id, patch: {
      status: event.isError ? 'failed' : 'completed',
      timing: timing(call.time, call.time !== null && at !== null && at < call.time ? null : at, duration),
      ...(event.activity ? { summary: event.activity, title: event.activity.title } : {}),
      ...(detailRef ? { detailRef } : {}),
      ...(event.isError ? { issue: { code: 'tool_failed' } } : {}),
    } });
  }
  function updateCall(event) {
    const call = calls.get(idOf(event.toolCallId));
    if (!call || call.turnId !== active.id || call.name === PLAN_TOOL_NAME) return;
    if (event.toolName != null && event.toolName !== call.name) { partial(); return; }
    const detailRef = safePayloadRef(event.detailRef);
    const patch = {
      ...(event.type === 'tool_wait_state' ? { status: event.waiting === true ? 'waiting' : 'running' } : {}),
      ...(event.activity ? { summary: event.activity, title: event.activity.title } : {}),
      ...(detailRef ? { detailRef } : {}),
    };
    if (Object.keys(patch).length) fact({ type: 'activity.update', itemId: call.id, patch });
  }
  function compact(event) {
    if (event.type === 'compaction_start') {
      if (active.compaction) return;
      const id = active.id + ':compaction:' + frame.sequence;
      active.compaction = { id, time: frame.at };
      fact({ type: 'activity.start', item: { ...scoped(id, active.id + ':activity', 'running', timing(frame.at)),
        kind: 'compaction', attemptId: active.attempt.id, childIds: [], title: 'compaction' } });
    } else if (active.compaction) {
      fact({ type: 'activity.update', itemId: active.compaction.id,
        patch: { status: event.aborted ? 'cancelled' : event.error || event.errorMessage || event.success === false ? 'failed' : 'completed',
          timing: timing(active.compaction.time, frame.at) } });
      active.compaction = null;
    }
  }
  function settle(event) {
    if (!active) return;
    const status = outcome(event, active);
    if (event.type === 'agent_settled' && active.stop && status === 'unknown') return;
    const issue = status === 'failed' ? { code: 'generation_failed' } : status === 'interrupted' ? { code: 'run_interrupted' } : undefined;
    closeAttempt(status);
    retireCalls();
    for (const id of active.submissions) {
      const entry = submissions.get(id);
      if (!entry) continue;
      entry.settled = true;
      entry.canFallback = status === 'failed' && event.generationResult?.requestId === id
        && event.generationResult?.hasVisibleOutput === false;
    }
    if (active.stop || status === 'interrupted') {
      for (const entry of submissions.values()) if (!entry.delivered) entry.rejected = true;
    }
    fact({ type: 'turn.settle', status, issue });
    active = null;
    response = null;
    userEcho = null;
  }

  function abandonCall(callId, call) {
    if (call.name === PLAN_TOOL_NAME) {
      fact({ type: 'plan', callId, plan: null, state: 'rejected' });
    } else {
      fact({ type: 'activity.update', itemId: call.id, patch: { status: 'incomplete' } });
    }
  }

  function retireCalls(onRetire) {
    if (earlyEnd.size) partial();
    calls.retireAll(onRetire);
    for (const id of earlyEnd.keys()) calls.retire(id);
    earlyEnd.clear();
  }

  function consume(event) {
    if (event.type === 'execution_submission') return submit(event);
    if (event.type === 'response') return commandResponse(event);
    if (event.type === 'bridge_status' && event.state !== 'ready') {
      settle(event);
      submissions.clear();
      recentUnattributed = null;
      return;
    }
    if (event.type === 'agent_start') {
      const entry = locate(event, 'prompt');
      if (entry) open(entry);
      else if (!active) partial();
      return;
    }
    if (event.type === 'message_start' && event.message?.role === 'user') return receiveUser(event);
    if (event.type === 'message_edit' && event.state === 'accepted') {
      if (event.sessionId !== sessionOf(scope) || !idOf(event.newEntryId)) return;
      const entry = submissions.get(idOf(event.requestId));
      const input = entry?.inputId && nativeWitnesses.get(entry.inputId);
      if (input && entry.editOf === event.targetEntryId && input.turnId === entry.turnId) {
        input.nativeEntryId = event.newEntryId;
      } else {
        partial(recentUnattributed?.turnId);
        recentUnattributed = null;
      }
      return;
    }
    if (!active) return;
    if (event.type === 'message_end' && event.message?.role === 'user' && userEcho) {
      if (!userEcho.skipped) fact({ type: 'turn.input', input: messageRef(userEcho.id, event.message), role: userEcho.role });
      userEcho = null;
      return;
    }
    if (event.type === 'message_start' && event.message?.role === 'assistant') return assistantStart(event.message);
    if (event.type === 'message_update') return assistantDelta(event);
    if (event.type === 'message_end' && event.message?.role === 'assistant') return assistantEnd(event.message);
    if (event.type === 'tool_execution_start') return callStart(event);
    if (event.type === 'tool_execution_end') return finishCall(event);
    if (event.type === 'tool_execution_update' || event.type === 'tool_wait_state') return updateCall(event);
    if (event.type === 'compaction_start' || event.type === 'compaction_end') return compact(event);
    if (event.type === 'auto_retry_start') {
      const retryId = Number.isSafeInteger(event.attempt) ? event.attempt : frame.sequence;
      if (active.retryId === retryId) return;
      active.retryId = retryId;
      retireCalls(abandonCall);
      closeAttempt('failed');
      active.stopReason = null;
      return attempt('auto-retry', active.id + ':retry:' + frame.sequence);
    }
    if (event.type === 'auto_retry_end') {
      if (event.success === false) closeAttempt('failed');
      return;
    }
    if (event.type === 'stop_state') {
      if (event.pending) {
        active.stop = true;
        fact({ type: 'turn.state', status: 'stopping' });
      } else if (event.state === 'stopped' || event.state === 'reset') settle(event);
      return;
    }
    if (event.type === 'agent_settled' || event.type === 'execution_stop') settle(event);
  }

  function process(event, sequence, at) {
    cursor = sequence;
    if (!KNOWN_EVENTS.has(event.type)) return;
    frame = { sequence, at, part: 0 };
    consume(event);
  }
  function overflow(sequence, at) {
    pending.clear();
    pendingBytes = 0;
    holeSince = null;
    frame = { sequence, at, part: 0 };
    partial();
    if (active) settle({ type: 'coverage_gap' });
    submissions.clear();
    cursor = sequence;
  }
  function drain() {
    while (pending.has(cursor + 1)) {
      const next = pending.get(cursor + 1);
      pending.delete(cursor + 1);
      pendingBytes -= next.bytes;
      process(next.event, cursor + 1, next.at);
    }
    if (!pending.size) holeSince = null;
  }

  return {
    observe(event, { sequence, observedAt } = {}) {
      if (!event || typeof event.type !== 'string' || !Number.isSafeInteger(sequence) || sequence <= cursor) return false;
      const at = timeOf(observedAt);
      if (!continuous || sequence === cursor + 1) {
        process(event, sequence, at);
        drain();
        return true;
      }
      if (pending.has(sequence)) return false;
      const relevant = KNOWN_EVENTS.has(event.type) ? event : { type: 'cursor-only' };
      const serialized = JSON.stringify(relevant);
      const bytes = executionTextBytes(serialized);
      if (pending.size >= maxPending || pendingBytes + bytes > maxPendingBytes
          || (holeSince !== null && at !== null && at - holeSince >= waitMs)) {
        overflow(Math.max(sequence, ...pending.keys()), at);
        return false;
      }
      holeSince ??= at;
      pending.set(sequence, { event: JSON.parse(serialized), at, bytes });
      pendingBytes += bytes;
      return true;
    },
    rebind(next, { sequence = cursor, observedAt } = {}) {
      if (sessionOf(scope) !== null || !sessionOf(next)) return false;
      const previousScope = scope;
      scope = next;
      frame = { sequence, at: timeOf(observedAt), part: 0 };
      const applied = fact({ type: 'scope.bind' }, undefined, { previousScope, eventId: stream + ':session-bound' });
      if (!applied) scope = previousScope;
      return applied;
    },
    retire(sequence, observedAt) {
      frame = { sequence, at: timeOf(observedAt), part: 0 };
      settle({ type: 'bridge_status' });
      pending.clear();
      pendingBytes = 0;
      holeSince = null;
      submissions.clear();
      recentUnattributed = null;
      messages.clear();
      messageBytes = 0;
      nativeWitnesses.clear();
    },
    loseCoverage(observedAt) {
      frame = { sequence: cursor, at: timeOf(observedAt), part: MAX_CONTENT_SEGMENTS };
      partial();
      if (active) settle({ type: 'coverage_gap' });
      submissions.clear();
      recentUnattributed = null;
    },
    missing: () => pending.size ? { cursor, pending: pending.size, bytes: pendingBytes } : null,
    noteUnavailableGap(sequence, observedAt, checkpoint = false) {
      if (!Number.isSafeInteger(sequence) || sequence <= cursor || (!checkpoint && !pending.size)) return;
      overflow(sequence, timeOf(observedAt));
    },
    cursor: () => cursor,
    nativeWitnesses(turnId) {
      return [...nativeWitnesses.values()].filter(entry => entry.turnId === turnId)
        .map(({ turnId: _turnId, toolCalls, ...entry }) => ({
          ...entry, ...(toolCalls ? { toolCalls: toolCalls.map(call => ({ ...call })) } : {}),
        }));
    },
    mergeHistory: cut => model.mergeHistory(cut),
    resolveMessage(ref) {
      if (ref?.source !== 'live-buffer' || ref.state !== 'available') return null;
      const message = messages.get(ref.id);
      return message ? { role: 'user', content: message.content.map(part => ({ ...part })) } : null;
    },
    snapshot() {
      const snapshot = model.snapshot();
      if (pending.size) snapshot.completeness = 'partial';
      for (const turn of snapshot.turns) {
        for (const input of [turn.input, ...turn.additionalInputs]) {
          if (input?.content?.source === 'live-buffer' && !messages.has(input.content.id)) input.content.state = 'unavailable';
          const witness = input && nativeWitnesses.get(input.id);
          if (witness?.nativeEntryId) input.nativeEntryId = witness.nativeEntryId;
        }
      }
      return snapshot;
    },
  };
}
