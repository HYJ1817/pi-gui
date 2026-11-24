/* DOM ownership for Classic turns. Live attribution comes from accepted
 * frames; restored turns use the same server-verified native message range. */
import { S, el } from './state.js';
import { createConversationFlow, nativeConversationChildren } from './conversation-work-log.js';
import { captureReadingPosition, restoreReadingPosition } from './reading-position.js';
import { classicExecutionFallbackEcho, getClassicExecutionTimeline } from './execution-timeline-state.js';
import { createExecutionTurnView, executionTurnForInput } from './execution-timeline-view.js';
import { executionLivePreferenceKey, executionViewPreferences } from './execution-view-preferences.js';
import { isPlanTool } from './plan-model.js';
import { safeToolName } from './runtime-timeline.js';

const UPDATE = new Set([
  'agent_start', 'agent_settled', 'message_start', 'message_end', 'tool_execution_start',
  'tool_execution_end', 'tool_wait_state', 'compaction_start', 'compaction_end', 'auto_retry_start',
  'auto_retry_end', 'execution_submission', 'execution_submission_result', 'stop_state',
]);
let pendingFrame = null;
let scopeKey = null;
let active = null;
const rounds = new Set();
const dirty = new Set();
const accepted = new WeakSet();
let nativeFlow = null;
let nativeHost = null;
let nativePreferences = null;

/** Native fallback has the same presentation without gaining P5 evidence. */
export function renderClassicConversationFlow(preferences) {
  if (!S.thread) return;
  if (preferences) nativePreferences = preferences;
  if (nativeHost !== S.thread) {
    nativeFlow?.restore();
    nativeHost = S.thread;
    nativeFlow = createConversationFlow({ document: S.thread.ownerDocument, preferences: {
      get: key => nativePreferences?.get(key), set: (key, value) => nativePreferences?.set(key, value),
    } });
  }
  const bookmark = el.stream?.clientHeight > 0
    ? captureReadingPosition(el.stream, S.thread, { pinnedThreshold: 24 }) : null;
  nativeFlow.render(S.thread);
  if (bookmark) restoreReadingPosition(el.stream, S.thread, bookmark);
}

function makeKey(instance, run, workspace, generation, branch, session) {
  return JSON.stringify([instance, run, workspace, generation, branch, session]);
}

function eventKey(event, sessionId = event.executionClassic?.sessionId ?? null) {
  const owner = event.legacyOwner;
  const meta = event.executionClassic;
  if (event._replay || !owner?.runtimeId || !owner.workspaceId
      || !Number.isSafeInteger(meta?.branchEpoch) || !Number.isSafeInteger(event._seq)) return null;
  return makeKey(owner.runtimeId, Number(owner.runtimeGeneration), owner.workspaceId,
    Number(owner.workspaceEpoch), meta.branchEpoch, sessionId);
}

function release(round) {
  for (const outcome of round.outcomes) outcome.hidden = false;
  for (const response of round.responses) response.usageLabel?.remove();
  for (const [node, marker] of round.markers) {
    if (node.parentNode) marker.replaceWith(node);
    else marker.remove();
  }
  round.markers.clear();
  for (const [group, marker] of round.groups) marker.replaceWith(group);
  round.groups.clear();
  round.view?.release();
  round.view = null;
}

export function resetClassicExecutionView({ restore = false } = {}) {
  nativeFlow?.restore();
  nativeFlow = nativeHost = nativePreferences = null;
  if (pendingFrame != null) cancelAnimationFrame(pendingFrame);
  pendingFrame = null;
  if (restore) for (const round of rounds) release(round);
  else for (const round of rounds) round.view?.release();
  rounds.clear();
  dirty.clear();
  active = null;
  scopeKey = null;
}

/** Read the original thread order without interrupting an in-flight editor. */
export function classicNativeThreadChildren(thread) {
  if (!thread) return [];
  const adopted = new Map();
  for (const round of rounds) {
    for (const [node, marker] of round.markers) {
      if (node.isConnected && marker.parentNode === thread) adopted.set(marker, node);
    }
    for (const [group, marker] of round.groups) {
      if (marker.parentNode === thread) adopted.set(marker, group);
    }
  }
  return nativeConversationChildren(thread).map(node => adopted.get(node) || node)
    .filter(node => node.nodeType === 1 && !node.hasAttribute('data-execution-turn'));
}

export function releaseClassicExecutionTail(article, oldTail) {
  nativeFlow?.restore();
  for (const round of rounds) {
    if (round.input !== article && !oldTail.has(round.input) && !round.additional.some(item => item.node === article)) continue;
    release(round);
    rounds.delete(round);
    dirty.delete(round);
    if (active === round) active = null;
  }
}

const historyStatus = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'incomplete', 'unknown']);
const historyId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Select complete native ranges from the authorized response. A malformed
 * or unconfirmed range remains in the regular history renderer. */
export function indexClassicHistoryTurns(p5, messages, items, sessionId) {
  const owners = new Map();
  if (!sessionId || p5?.version !== 1 || p5.sessionId !== sessionId || !historyId(p5.leafId)
      || !Array.isArray(p5.turns) || p5.turns.length > 240) return owners;
  const toolCounts = new Map();
  for (const item of items) {
    if (item.kind !== 'tools') continue;
    for (const { id } of item.entries) toolCounts.set(id, (toolCounts.get(id) ?? 0) + 1);
  }
  const toolsByPosition = new Map(items.filter(item => item.kind === 'tools').map(item => [item.sourceIndex, item.entries]));
  const ordinals = new Map();
  const toolResults = new Map();
  let userIndex = 0;
  for (const [index, message] of messages.entries()) {
    if (message?.role === 'user') ordinals.set(index, userIndex++);
    if (message?.role === 'toolResult' && historyId(message.toolCallId)) {
      toolResults.set(message.toolCallId, toolResults.has(message.toolCallId) ? -1 : index);
    }
  }
  const seen = new Set();
  const seenEntries = new Set();
  let end = -1;
  for (const turn of p5.turns) {
    const { from, through, input, additionalInputs, entryIds, finalResponseId, group, items: activities } = turn ?? {};
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from <= end || through < from
        || through >= messages.length || !historyId(turn.id) || seen.has(turn.id)
        || turn.sessionId !== sessionId || !historyStatus.has(turn.status)
        || !Array.isArray(entryIds) || entryIds.length !== through - from + 1
        || !entryIds.every(id => historyId(id) && !seenEntries.has(id)) || new Set(entryIds).size !== entryIds.length
        || input?.id !== entryIds[0] || !ordinals.has(from) || ordinals.get(from) !== input.userIndex
        || !Array.isArray(additionalInputs) || !Array.isArray(activities)
        || !Array.isArray(turn.usage)
        || finalResponseId != null && (!entryIds.includes(finalResponseId)
          || messages[from + entryIds.indexOf(finalResponseId)]?.role !== 'assistant')) continue;
    const groupedUsers = [];
    const allTools = new Map();
    let ambiguousTool = false;
    for (let index = from; index <= through; index++) {
      if (index > from && ordinals.has(index)) groupedUsers.push({ id: entryIds[index - from], userIndex: ordinals.get(index) });
      for (const entry of toolsByPosition.get(index) ?? []) {
        const resultIndex = toolResults.get(entry.id);
        if (toolCounts.get(entry.id) !== 1
          || resultIndex !== undefined && (resultIndex < from || resultIndex > through)) ambiguousTool = true;
        if (!isPlanTool(entry.name)) allTools.set(entry.id, { index, name: safeToolName(entry.name) });
      }
    }
    const activityTools = activities.filter(item => item?.callId).map(item => item.callId);
    if (ambiguousTool || groupedUsers.length !== additionalInputs.length
        || !groupedUsers.every((user, index) => user.id === additionalInputs[index]?.id
          && user.userIndex === additionalInputs[index].userIndex)
        || activities.length && (!group || group.turnId !== turn.id || !historyStatus.has(group.status))
        || activities.some(item => !item || item.turnId !== turn.id || item.parentId !== group.id
          || item.position?.domain !== 'history' || !Number.isSafeInteger(item.position.sequence) || !historyStatus.has(item.status)
          || item.callId && (allTools.get(item.callId)?.index !== item.position.sequence
            || allTools.get(item.callId)?.name !== item.toolName))
        || activityTools.length !== allTools.size || new Set(activityTools).size !== activityTools.length
        || activityTools.some(callId => !allTools.has(callId))) continue;
    seen.add(turn.id);
    for (const id of entryIds) seenEntries.add(id);
    end = through;
    for (let index = from; index <= through; index++) owners.set(index, turn);
  }
  return owners;
}

export function mountClassicHistoryTurn(turn, nodes) {
  const round = { ...nodes, historical: true, settled: true, markers: new Map(), groups: new Map(), view: null };
  try {
    if (renderRound(round, turn, turn.group, turn.items)) {
      rounds.add(round);
      return;
    }
  } catch { /* The verified read is optional for the existing native UI. */ }
  release(round);
}

export function scheduleClassicExecutionView(event) {
  const key = eventKey(event);
  if (!key) return;
  const firstBinding = event.executionClassic.sessionBound === true
    && event.executionClassic.sessionId && scopeKey === eventKey(event, null);
  if (scopeKey && scopeKey !== key && !firstBinding) resetClassicExecutionView({ restore: true });
  scopeKey = key;
  accepted.add(event);
  if (!UPDATE.has(event.type) && !firstBinding) return;
  if (active && !active.settled && event.type === 'agent_settled') {
    const generation = event.generationResult;
    active.fallbackPending = S.fallbackActive === true && generation?.outcome === 'failed'
      && generation.hasVisibleOutput === false;
  }
  refreshClassicExecutionView();
}

export function refreshClassicExecutionView() {
  if (!active) return;
  dirty.add(active);
  if (pendingFrame != null) return;
  pendingFrame = requestAnimationFrame(flush);
}

export function trackClassicExecutionMessage(node, event) {
  if (!node || !accepted.has(event) || eventKey(event) !== scopeKey) return;
  const role = event.message?.role;
  if (role === 'user') {
    if (!active || active.settled) {
      active = { input: node, sequence: event._seq, additional: [], responses: [], tools: new Map(),
        plan: null, outcomes: [], settled: false, view: null, markers: new Map(), groups: new Map() };
      rounds.add(active);
    } else active.additional.push({ node, sequence: event._seq });
  } else if (role === 'assistant' && active) {
    active.responses.push({ node, sequence: event._seq });
  }
  refreshClassicExecutionView();
}

export function resumeClassicExecutionFallback(event) {
  if (!accepted.has(event) || eventKey(event) !== scopeKey) return null;
  const witness = classicExecutionFallbackEcho(event);
  if (!witness || !active || active.sequence !== witness.inputSequence || !active.input.isConnected) return null;
  if (active.view && active.view.node.dataset.executionTurn !== witness.turnId) return null;
  for (const node of active.outcomes) {
    node.remove();
    active.markers.get(node)?.remove();
    active.markers.delete(node);
  }
  active.outcomes = [];
  active.settled = false;
  active.fallbackPending = false;
  dirty.add(active);
  return active.input;
}

export function trackClassicExecutionTool(node, group, event) {
  if (!active || active.settled || !accepted.has(event) || eventKey(event) !== scopeKey) return;
  active.tools.set(event._seq, { node, group, callId: event.toolCallId });
  dirty.add(active);
}

export function trackClassicExecutionPlan(node, event) {
  if (!active || active.settled || !accepted.has(event) || eventKey(event) !== scopeKey) return;
  active.plan = node;
  dirty.add(active);
}

export function settleClassicExecutionView(outcome) {
  if (!active || active.settled) return;
  if (outcome) active.outcomes.push(outcome);
  active.settled = true;
  dirty.add(active);
}

function rememberPosition(round, node) {
  if (!node || round.markers.has(node)) return;
  const marker = node.ownerDocument.createComment('execution node');
  node.before(marker);
  round.markers.set(node, marker);
}

function flush() {
  pendingFrame = null;
  if (!dirty.size || !S.thread) return;
  const changed = [...dirty];
  dirty.clear();
  const snapshot = getClassicExecutionTimeline();
  const scope = snapshot?.scope;
  const actual = scope && makeKey(scope.bridgeInstance, scope.bridgeRun, scope.workspaceKey,
    scope.workspaceGeneration, scope.branchEpoch, scope.sessionId);
  if (actual !== scopeKey) return;
  // The model bounds its live window. Completed DOM outside that window can
  // remain readable, with the same native nodes and disclosure state.
  const groups = new Map(snapshot.groups.map(group => [group.turnId, group]));
  const itemsByTurn = new Map();
  for (const item of snapshot.items) {
    if (!itemsByTurn.has(item.turnId)) itemsByTurn.set(item.turnId, []);
    itemsByTurn.get(item.turnId).push(item);
  }
  for (const round of changed) {
    if (!round.input.isConnected) {
      release(round);
      rounds.delete(round);
      continue;
    }
    const turn = executionTurnForInput(snapshot, round.sequence);
    const items = turn && (itemsByTurn.get(turn.id) || []);
    if (!turn || items.filter(item => item.callId).length !== round.tools.size
        || turn.additionalInputs.length !== round.additional.length) {
      release(round);
      continue;
    }
    try {
      if (!renderRound(round, turn, groups.get(turn.id), items, scope)) release(round);
    } catch {
      // A failed presentation must return all adopted native nodes.
      release(round);
    }
  }
  renderClassicConversationFlow();
}

function renderRound(round, turn, group, items, scope = null) {
  const details = new Map();
  for (const item of items) {
    if (!item.callId) continue;
    const tool = round.tools.get(round.historical ? item.callId : item.position.sequence);
    if (tool?.callId !== item.callId) return false;
    details.set(item.id, tool.node);
  }

  const plan = round.historical ? round.plan : turn.plan && round.plan?.isConnected ? round.plan : null;
  if (!round.historical && (Boolean(turn.plan) !== Boolean(plan) || (!plan && round.plan?.isConnected))) return false;
  const progress = [];
  const answer = [];
  const usage = [];
  const nativeUsageIds = new Set();
  const recordedUsage = new Map(turn.usage.map(row => [row.responseId, row]));
  const kindsByResponse = new Map();
  for (const part of turn.parts ?? []) {
    if (!kindsByResponse.has(part.message.id)) kindsByResponse.set(part.message.id, new Set());
    kindsByResponse.get(part.message.id).add(part.kind);
  }
  const tail = round.responses.at(-1);
  const waitingForFallback = round.fallbackPending && S.fallbackActive === true;
  const ordered = [...round.additional];
  for (const response of round.responses) {
    const { node, sequence } = response;
    if (round.historical ? !node.parentNode : !node.isConnected) continue;
    const responseId = response.responseId ?? turn.id + ':response:' + sequence;
    const kinds = kindsByResponse.get(responseId);
    const meta = response.meta || node.querySelector(':scope > .ui2-msg-meta');
    if (meta) {
      response.meta = meta;
      usage.push(meta);
      nativeUsageIds.add(responseId);
      const model = recordedUsage.get(responseId)?.model;
      if (model) {
        if (!response.usageLabel) {
          response.usageLabel = meta.ownerDocument.createElement('span');
          response.usageLabel.className = 'execution-usage-model';
        }
        response.usageLabel.textContent = [model.provider, model.id].filter(Boolean).join(' / ');
        if (response.usageLabel.parentNode !== meta) meta.prepend(response.usageLabel);
      }
    }
    // A streaming block may still be empty at its first frame. Leave that
    // original host visible until the model can classify its public parts.
    if (round.historical ? responseId === turn.finalResponseId : kinds?.has('answer') || kinds?.has('partial-answer')
        || (!waitingForFallback && tail === response && node.querySelector('.msg-err'))
        || (!round.settled && (!kinds || !kinds.has('progress-text')) && tail === response)) {
      answer.push(node);
    } else ordered.push(response);
  }
  ordered.sort((a, b) => a.sequence - b.sequence);
  for (const response of ordered) progress.push(response.node);

  // Native display wrappers cannot become P5's original-order marker owner.
  // Restore them before the first verified adoption; fallback remains recoverable.
  if (!round.view && round.input.isConnected) nativeFlow?.restore();
  if (!round.view) {
    const preferenceId = round.historical ? turn.id + ':' + turn.entryIds.at(-1)
      : executionLivePreferenceKey(scope, round.sequence);
    const preferences = executionViewPreferences({
      kind: 'classic', workspaceId: scope?.workspaceKey ?? S.legacyOwner?.workspaceId, sessionId: turn.sessionId,
    }, preferenceId, { alias: turn.viewAlias, items });
    round.view = createExecutionTurnView({ document: round.input.ownerDocument, preferences });
    round.input.before(round.view.node);
  }
  for (const node of [round.input, plan, ...progress, ...answer, ...usage, ...round.outcomes]) {
    rememberPosition(round, node);
  }
  for (const tool of round.tools.values()) {
    if (round.groups.has(tool.group)) continue;
    const marker = tool.group.ownerDocument.createComment('execution tool group');
    tool.group.replaceWith(marker);
    round.groups.set(tool.group, marker);
  }
  for (const outcome of round.outcomes) outcome.hidden = waitingForFallback;
  round.view.update({
    turn: { ...turn, status: waitingForFallback ? 'waiting' : turn.status,
      usage: turn.usage.filter(row => !nativeUsageIds.has(row.responseId)) },
    group, items, input: round.input, plan, progress, answer, outcomes: round.outcomes, details, usage,
    workOrder: [
      ...ordered.map(entry => ({ node: entry.node, sequence: entry.sequence, part: -1 })),
      ...items.map(item => ({ activityId: item.id, ...item.position })),
    ].sort((first, second) => first.sequence - second.sequence || first.part - second.part),
  });
  const firstGroup = round.tools.values().next().value?.group;
  if (firstGroup?.dataset.anchorId) {
    round.view.node.querySelector('[data-execution-part="activity"]').dataset.anchorId = firstGroup.dataset.anchorId;
  }
  return true;
}
