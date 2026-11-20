import { createExecutionStream, sameExecutionScope } from './execution-timeline-adapter.js';

const MAX_RUNTIME_TIMELINES = 12;
const runtime = new Map();
let classic = null;

function runtimeScope(owner, branchEpoch = 0) {
  return owner && { kind: 'runtime', owner, branchEpoch };
}

function isFirstBinding(previous, next, meta) {
  return Number.isSafeInteger(meta?.sessionBoundAtSequence)
    && next.sessionId && previous?.sessionId === null
    && sameExecutionScope(runtimeScope({ ...previous, sessionId: next.sessionId }), runtimeScope(next));
}

// A runtime_state frame may establish authority only after the old store
// validates it. An event frame is accepted only for that captured owner.
export function seedRuntimeExecution(item) {
  const owner = item?.owner;
  if (!owner) return;
  const id = owner.conversationId;
  const prior = runtime.get(id);
  const scope = runtimeScope(owner, item.execution?.branchEpoch);
  if (sameExecutionScope(prior?.scope, scope)) return;
  if (prior && isFirstBinding(prior.scope.owner, owner, item.execution)
      && prior.stream.rebind(scope, { observedAt: item.execution.observedAt })) {
    prior.scope = scope;
    prior.stream.noteUnavailableGap(item.execution.sessionBoundAtSequence, item.execution.observedAt, true);
    return;
  }
  if (!Number.isSafeInteger(item.execution?.startSequence) || item.execution.startSequence < 0) return;
  if (!prior && runtime.size >= MAX_RUNTIME_TIMELINES) runtime.delete(runtime.keys().next().value);
  const stream = createExecutionStream(scope, { startSequence: item.execution.startSequence });
  stream.noteUnavailableGap(item.execution.sessionBoundAtSequence, item.execution.observedAt, true);
  runtime.set(id, { scope, stream });
}

export function observeRuntimeExecution(frame, current) {
  const scope = runtimeScope(frame.owner, frame.execution?.branchEpoch);
  if (frame._replay || frame.type !== 'runtime_event'
      || !sameExecutionScope(scope, runtimeScope(current?.owner, current?.item?.execution?.branchEpoch))) return;
  seedRuntimeExecution(current.item);
  const record = runtime.get(frame.owner.conversationId);
  if (sameExecutionScope(record?.scope, scope) && frame.execution?.startSequence === current.item.execution?.startSequence) {
    record.stream.observe(frame.event, { sequence: frame.eventSequence, observedAt: frame.execution?.observedAt });
  }
}

export function retireRuntimeExecution(owner) {
  const record = runtime.get(owner?.conversationId);
  if (sameExecutionScope(record?.scope, runtimeScope(owner, record?.scope.branchEpoch))) {
    record.stream.retire(record.stream.cursor() + 1);
    runtime.delete(owner.conversationId);
  }
}

export function runtimeExecutionCursor(owner) {
  const record = runtime.get(owner?.conversationId);
  return sameExecutionScope(record?.scope, runtimeScope(owner, record?.scope.branchEpoch)) ? record.stream.cursor() : null;
}

export function acknowledgeRuntimeExecutionReplay(result) {
  if (!result?.historyRequired) return;
  const record = runtime.get(result.owner?.conversationId);
  if (sameExecutionScope(record?.scope, runtimeScope(result.owner, result.item?.execution?.branchEpoch))) {
    record.stream.noteUnavailableGap(result.cursor, result.item?.execution?.observedAt);
  }
}

export function getRuntimeExecutionTimeline(owner) {
  const record = runtime.get(owner?.conversationId);
  return sameExecutionScope(record?.scope, runtimeScope(owner, record?.scope.branchEpoch)) ? record.stream.snapshot() : null;
}

export function resolveRuntimeExecutionMessage(scope, ref) {
  const record = runtime.get(scope?.owner?.conversationId);
  return sameExecutionScope(record?.scope, scope) ? record.stream.resolveMessage(ref) : null;
}

function classicScope(owner, meta) {
  const bridgeRun = Number(owner?.runtimeGeneration);
  const workspaceGeneration = Number(owner?.workspaceEpoch);
  if (!owner?.runtimeId || !owner.workspaceId || !Number.isSafeInteger(bridgeRun)
      || !Number.isSafeInteger(workspaceGeneration) || !Number.isSafeInteger(meta?.branchEpoch)) return null;
  return { kind: 'classic', bridgeInstance: owner.runtimeId, bridgeRun,
    workspaceKey: owner.workspaceId, workspaceGeneration, branchEpoch: meta.branchEpoch, sessionId: meta.sessionId };
}

export function observeClassicExecution(event) {
  const scope = classicScope(event.legacyOwner, event.executionClassic);
  if (event._replay || !scope || !Number.isSafeInteger(event._seq)) return;
  const { observedAt, sessionBound } = event.executionClassic;
  if (classic && !sameExecutionScope(classic.scope, scope)) {
    if (sessionBound === true && classic.scope.sessionId === null && scope.sessionId
        && sameExecutionScope({ ...classic.scope, sessionId: scope.sessionId }, scope)
        && classic.stream.rebind(scope, { observedAt })) {
      classic.scope = scope;
    } else {
      classic.stream.retire(classic.stream.cursor() + 1, observedAt);
      classic = null;
    }
  }
  classic ||= { scope, stream: createExecutionStream(scope) };
  classic.stream.observe(event, { sequence: event._seq, observedAt });
}

export function retireClassicExecution() {
  if (!classic) return;
  classic.stream.retire(classic.stream.cursor() + 1);
  classic = null;
}

export function markClassicExecutionDisconnected() {
  classic?.stream.loseCoverage();
}

export function getClassicExecutionTimeline() {
  return classic?.stream.snapshot() || null;
}

export function resolveClassicExecutionMessage(scope, ref) {
  return sameExecutionScope(classic?.scope, scope) ? classic.stream.resolveMessage(ref) : null;
}
