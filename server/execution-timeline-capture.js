import { createExecutionStream } from '../public/execution-timeline-adapter.js';
import { MAX_CONTENT_SEGMENTS } from '../public/runtime-timeline.js';
import { bindExecutionEntries } from './execution-timeline.js';
import { executionLivePreferenceKey } from '../public/execution-view-preferences.js';

const SAVE_INTERVAL_MS = 1500;
const TERMINAL = new Set(['unknown', 'completed', 'failed', 'interrupted', 'cancelled']);
const ACK = new Set(['queued', 'started', 'handled', 'steer', 'follow_up']);
const scalarId = value => typeof value === 'string' && value.length <= 160 ? value : undefined;
const time = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function generationFact(value) {
  return value && {
    requestId: scalarId(value.requestId),
    outcome: ['failed', 'success'].includes(value.outcome) ? value.outcome : undefined,
    hasVisibleOutput: value.hasVisibleOutput === true ? true : value.hasVisibleOutput === false ? false : undefined,
  };
}

/* Reuse the event reducer without putting any actual message, arguments,
 * output, thinking, attachments or provider metadata in the observer. */
function structuralEvent(event) {
  const { type } = event;
  switch (type) {
    case 'execution_submission':
      return { type, id: scalarId(event.id), command: event.command,
        fallbackOf: scalarId(event.fallbackOf), editOf: scalarId(event.editOf) };
    case 'message_start':
      return { type, message: { role: event.message?.role }, requestId: scalarId(event.requestId) };
    case 'message_end': {
      const message = event.message;
      const content = message?.role === 'assistant' && Array.isArray(message.content)
        ? message.content.slice(0, MAX_CONTENT_SEGMENTS).map(part => {
          if (part?.type === 'toolCall') return { type: part.type, id: scalarId(part.id), name: scalarId(part.name) };
          if (part?.type === 'text' && typeof part.text === 'string' && part.text) return { type: 'text', text: 'x' };
          return null;
        }) : [];
      return { type, message: { role: message?.role, stopReason: message?.stopReason, content } };
    }
    case 'tool_execution_start':
    case 'tool_execution_end':
    case 'tool_wait_state':
      return { type, toolName: scalarId(event.toolName), toolCallId: scalarId(event.toolCallId),
        isError: event.isError === true, durationMs: time(event.durationMs), waiting: event.waiting === true };
    case 'agent_start':
      return { type, generationRequestId: scalarId(event.generationRequestId) };
    case 'agent_settled':
      return { type, aborted: event.aborted === true, generationResult: generationFact(event.generationResult) };
    case 'response':
      return { type, command: event.command, id: scalarId(event.id), success: event.success,
        data: ACK.has(event.data?.disposition) ? { disposition: event.data.disposition } : undefined,
        generationResult: generationFact(event.generationResult) };
    case 'stop_state':
      return { type, pending: event.pending === true, state: event.state };
    case 'auto_retry_start':
    case 'auto_retry_end':
      return { type, attempt: time(event.attempt), success: event.success };
    case 'compaction_start':
    case 'compaction_end':
      return { type, aborted: event.aborted === true, success: event.success };
    case 'message_edit':
      return { type, state: event.state, sessionId: scalarId(event.sessionId),
        requestId: scalarId(event.requestId), targetEntryId: scalarId(event.targetEntryId),
        newEntryId: scalarId(event.newEntryId) };
    case 'execution_stop':
      return { type };
    default:
      return { type: 'cursor-only' };
  }
}

function closeEvent(event) {
  return event.type === 'agent_settled' || event.type === 'execution_stop'
    || event.type === 'stop_state' && ['stopped', 'reset'].includes(event.state)
    || event.type === 'response' && event.command === 'prompt' && (event.success === false || event.data?.disposition === 'handled');
}

function boundTurn(branch, { checkpoint, turn, witnesses, items, finished }) {
  if (!turn?.input || !witnesses.length) return null;
  const binding = bindExecutionEntries(branch, { checkpoint, messages: witnesses });
  if (!binding) return null;
  const aliases = new Map(binding.aliases.map(({ from, to }) => [from, to]));
  const inputId = aliases.get(turn.input.id);
  if (!inputId || turn.additionalInputs.some(input => !aliases.has(input.id))) return null;
  const suffix = branch.entries.slice(checkpoint.entries.length);
  // Binding verified the whole ordered role sequence and exact tool shapes.
  // An anchored input fences all of these branch nodes to the same turn.
  const messages = suffix.filter(entry => ['assistant', 'user'].includes(entry.role));
  const mapped = new Map(witnesses.map((message, n) => [message.id, messages[n].id]));
  const pairs = new Map(binding.results.map(row => [JSON.stringify([row.responseEntryId, row.callId]), row]));
  const tools = [];
  for (const item of items) {
    const responseId = aliases.get(item.responseId);
    const pair = pairs.get(JSON.stringify([responseId, item.callId]));
    if (!pair) continue;
    tools.push({ callId: item.callId, responseId, resultId: pair.resultEntryId, viewAlias: item.id,
      startedAt: time(item.timing?.startedAt), endedAt: time(item.timing?.endedAt),
      durationMs: time(item.timing?.durationMs), status: TERMINAL.has(item.status) ? item.status : 'incomplete' });
  }
  const final = finished && [...turn.parts].reverse().find(part => part.kind === 'answer' || part.kind === 'partial-answer');
  const inputSequence = Number(turn.input.id.match(/:input:(\d+)$/)?.[1]);
  return {
    inputId, beforeLeafId: checkpoint.leafId, leafId: branch.leafId,
    entries: suffix.map(row => ({ id: row.id, role: row.role ?? null })), tools,
    status: finished && turn.completeness === 'complete' && TERMINAL.has(turn.status) ? turn.status : 'unknown',
    timing: { startedAt: time(turn.timing?.startedAt), endedAt: finished ? time(turn.timing?.endedAt) : null },
    finalResponseId: final ? mapped.get(final.message.id) ?? null : null,
    viewAlias: executionLivePreferenceKey({ ...branch.scope, branchEpoch: branch.branchEpoch }, inputSequence),
  };
}

/* One capture instance follows one server-owned bridge. Asynchronous reads
 * may finish after a new generation or navigation, whose reset discards them. */
export function createExecutionTimelineCapture({ store, identity, readBranch }) {
  let baseline = null;
  let active = null;
  let epoch = 0;
  let cursor = 0;
  let changes = 0;
  let checking = null;
  let pending = null;
  let next = null;

  function reset() {
    epoch++;
    baseline = null;
    active = null;
    next = null;
    cursor = 0;
  }

  function checkpoint() {
    if (active) return Promise.resolve(false);
    if (baseline) return Promise.resolve(true);
    if (checking) return checking;
    if (pending) return pending.then(checkpoint);
    const generation = epoch, cut = changes;
    checking = Promise.resolve().then(readBranch).then(branch => {
      if (epoch !== generation || changes !== cut || active || !branch || !identity(branch.scope)) return false;
      baseline = branch;
      return true;
    }).catch(() => false).finally(() => { checking = null; });
    return checking;
  }

  function run(job) {
    pending = Promise.resolve().then(readBranch).then(branch => {
      if (epoch !== job.epoch || !branch) return;
      const scope = identity(branch.scope);
      if (!scope) return;
      if (job.finished && changes === job.cut && !active) baseline = branch;
      if (!job.checkpoint) return;
      const record = boundTurn(branch, job);
      if (record) store.record(scope, record);
    }).catch(() => {}).finally(() => {
      pending = null;
      if (next) {
        const queued = next;
        next = null;
        run(queued);
      }
    });
  }

  function sample(task, finished, snapshot = task.stream?.snapshot()) {
    const turn = snapshot?.turns.at(-1);
    const job = {
      epoch, cut: changes, finished, turn, checkpoint: task.checkpoint,
      witnesses: turn ? task.stream.nativeWitnesses(turn.id) : [],
      items: turn ? snapshot.items.filter(item => item.turnId === turn.id) : [],
    };
    if (!pending) run(job);
    else next = job;
  }

  function start(event, sequence) {
    const saved = baseline;
    const admitted = event.type === 'execution_submission' && event.command === 'prompt' && !event.fallbackOf;
    const stream = saved && admitted
      ? createExecutionStream({ ...saved.scope, branchEpoch: saved.branchEpoch }, { startSequence: sequence - 1 })
      : null;
    active = { stream, checkpoint: stream ? saved : null, submission: admitted ? event.id : null, nextSave: 0 };
    baseline = null;
  }

  function observe(event, { sequence = cursor + 1, observedAt = Date.now() } = {}) {
    if (!event || event._replay || !Number.isSafeInteger(sequence) || sequence <= cursor) return;
    cursor = sequence;
    if (event.type === 'execution_branch' || event.type === 'bridge_status' && event.state !== 'ready'
        || event.type === 'response' && event.success === true && ['switch_session', 'new_session', 'fork', 'clone'].includes(event.command)) {
      reset();
      return;
    }
    const prompt = event.type === 'execution_submission' && event.command === 'prompt';
    if (prompt || event.type === 'message_start' || event.type === 'agent_start') changes++;
    if (!active && (prompt || event.type === 'agent_start' || event.type === 'message_start' && event.message?.role === 'user')) start(event, sequence);
    if (!active) return;
    if (prompt && active.submission !== event.id) {
      active.stream = null;
      active.checkpoint = null; // Two independently submitted prompts cannot share an idle anchor.
    }
    active.stream?.observe(structuralEvent(event), { sequence, observedAt });
    if (closeEvent(event)) {
      if (event.type === 'response' && active.submission !== null && active.submission !== event.id) return;
      const snapshot = active.stream?.snapshot();
      const state = snapshot?.turns.at(-1)?.status;
      if (state && !TERMINAL.has(state)) return;
      const task = active;
      active = null;
      sample(task, true, snapshot);
    } else if (event.type === 'tool_execution_end' && active.stream && observedAt >= active.nextSave) {
      active.nextSave = observedAt + SAVE_INTERVAL_MS;
      sample(active, false);
    }
  }

  return {
    checkpoint, observe, reset,
    async idle() { while (checking || pending) await Promise.all([checking, pending]); },
  };
}
