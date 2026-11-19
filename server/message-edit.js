/* 历史用户消息“编辑并重新发送”/“重新生成”的后端事务。
 *
 * ---------- 原会话硬约束 ----------
 *
 * 只用 Pi 公开能力：
 *   1. GUI 注入的扩展命令 `/<random> <entryId> <requestId>` 调用
 *      `ctx.navigateTree`，把 leaf 移到目标用户消息的父节点（同一 session 文件）；
 *   2. 普通 RPC `prompt` 发送修改后的文本与原始 image parts。
 *
 * 不调用 `new_session` / `fork` / `switch_session`，不写 Pi 的 JSONL，不改
 * session schema。旧回复仍在 append-only 文件里，但不再位于 active path；
 * 模型上下文与 UI 都以 active path 为准。
 *
 * ---------- 为什么提交前要重新读 ----------
 *
 * 点击编辑与提交之间可能发生切换会话、压缩、新消息、停止。事务在提交时用
 * `get_state` + `get_entries` 重新解析 userIndex，并核对 entryId / leafId /
 * sessionId；任何一项变了就返回 `stale_history`，绝不按旧序号硬套。
 *
 * ---------- 失败恢复 ----------
 *
 * 导航成功、prompt 在 Agent 接受前失败时，导航回旧 leaf。若旧 leaf 本身是
 * 用户消息，扩展会先追加 custom guard entry，事务回滚到 guard，从而精确保留
 * 原路径。回滚后必须再用 `get_entries` 核对 leaf；核对失败返回
 * `restore_unconfirmed`，不谎称已恢复，也不盲目重试。
 *
 * ---------- 状态 ----------
 *
 * 同一 requestId 只执行一次；重复提交返回第一次的结果。不同 requestId 在同一
 * 会话同时只允许一个在飞事务。状态只保留 requestId / entry id / 错误码，不
 * 记录消息正文、图片或路径。
 */
import { randomUUID } from 'node:crypto';
import { commandConflict, userTargets } from './session-edit-target.js';

const MAX_TEXT_CHARS = 1_000_000;
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const STATUS_TTL_MS = 2 * 60 * 1000;
const MAX_STATUS = 32;
const DEFAULT_POLL_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 40;

const fail = (code, extra = null) => ({ ok: false, code, ...(extra && typeof extra === 'object' ? extra : {}) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
}

function imageBytes(images) {
  let total = 0;
  for (const image of images) total += image?.data?.length || 0;
  return total;
}

function normalizeRequestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const userIndex = input.userIndex;
  if (!Number.isInteger(userIndex) || userIndex < 0) return null;
  const kind = input.kind === 'regenerate' ? 'regenerate' : 'edit';
  const text = typeof input.text === 'string' ? input.text : '';
  const expectedEntryId = typeof input.expectedEntryId === 'string' && input.expectedEntryId ? input.expectedEntryId : null;
  const expectedLeafId = input.expectedLeafId === null ? null : typeof input.expectedLeafId === 'string' ? input.expectedLeafId : undefined;
  const requestId = normalizeRequestId(input.requestId) || randomUUID();
  return { userIndex, kind, text, expectedEntryId, expectedLeafId, requestId };
}

async function read(io, type) {
  try {
    const result = await io.request({ type });
    if (!result || result.ok !== true) return fail(result?.code || 'pi_request_failed');
    return { ok: true, data: result.data };
  } catch {
    return fail('pi_request_failed');
  }
}

function busyCode(state, io) {
  const external = typeof io.busyReason === 'function' ? io.busyReason() : null;
  if (external) return external;
  if (state.isStreaming === true) return 'session_streaming';
  if (state.isCompacting === true) return 'session_compacting';
  if (Number.isInteger(state.pendingMessageCount) && state.pendingMessageCount > 0) return 'session_queued';
  if (!state.model) return 'model_unavailable';
  return null;
}

function guardEntry(entries, requestId, oldLeafId) {
  return entries.find(entry => entry?.type === 'custom'
    && entry.customType === 'pi-gui-edit-guard'
    && entry.data?.requestId === requestId
    && (oldLeafId === null || entry.parentId === oldLeafId)) || null;
}

function newUserEntry(entries, beforeIds, parentId) {
  return entries.find(entry => !beforeIds.has(entry.id)
    && entry.type === 'message'
    && entry.message?.role === 'user'
    && (entry.parentId ?? null) === (parentId ?? null)) || null;
}

function isUserEntry(entry) {
  return entry?.type === 'message' && entry.message?.role === 'user';
}

/* navigateTree 把 user message 与 custom_message 都解析成“父节点”，所以
 * 这两类 old leaf 都需要扩展先追加 guard 才能精确回滚。 */
function needsRestoreGuard(entry) {
  return isUserEntry(entry) || entry?.type === 'custom_message';
}

function statusView(result) {
  if (!result || typeof result !== 'object') return result;
  /* 状态端点与重复提交应答不返回消息正文：正文只出现在本次请求的直接应答里。 */
  const { text, ...rest } = result;
  return rest;
}

export function createMessageEditService({
  publish = () => {},
  logEvent = () => {},
  now = () => Date.now(),
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  statusTtlMs = STATUS_TTL_MS,
} = {}) {
  const statuses = new Map();
  const inFlightSessions = new Map();
  let disposed = false;

  const safeLog = (event, details = {}) => {
    try { logEvent(event, details); } catch { /* observation only */ }
  };

  function pruneStatuses() {
    const at = now();
    for (const [key, value] of statuses) {
      if (value.state !== 'pending' && at - value.at > statusTtlMs) statuses.delete(key);
    }
    while (statuses.size > MAX_STATUS) {
      const oldest = [...statuses.entries()].filter(([, value]) => value.state !== 'pending').sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      statuses.delete(oldest[0]);
    }
  }

  function publishResult(io, requestId, state, extra = {}) {
    try {
      publish({
        type: 'message_edit',
        scope: io.scope,
        sessionId: io.sessionId || null,
        ...(io.conversationId ? { conversationId: io.conversationId } : {}),
        requestId,
        state,
        ...extra,
      });
    } catch { /* observation only */ }
  }

  function status(requestId) {
    pruneStatuses();
    const value = statuses.get(normalizeRequestId(requestId));
    if (!value) return { ok: true, state: 'unknown' };
    return { ok: true, state: value.state, ...(value.result ? { result: value.result } : {}) };
  }

  async function preflight(io, input) {
    if (disposed) return fail('unavailable');
    if (!io || typeof io.request !== 'function' || typeof io.validate !== 'function') return fail('invalid_request');
    if (!input || !Number.isInteger(input.userIndex) || input.userIndex < 0) return fail('invalid_user_index');
    try {
      io.validate();
      const state = await read(io, 'get_state');
      if (!state.ok) return state;
      if (io.sessionId && state.data?.sessionId !== io.sessionId) return fail('stale_session');
      const reason = busyCode(state.data || {}, io);
      const entries = await read(io, 'get_entries');
      if (!entries.ok) return entries;
      const targets = userTargets(entries.data?.entries, entries.data?.leafId ?? null);
      if (!targets) return fail('history_unparsable');
      const target = targets[input.userIndex];
      if (!target) return fail('unknown_user_message');
      const commands = await read(io, 'get_commands');
      const commandName = typeof io.commandName === 'function' ? io.commandName() : null;
      const commandReady = Boolean(commandName && Array.isArray(commands.data?.commands)
        && commands.data.commands.some(command => command?.name === commandName));
      io.validate();
      return {
        ok: true,
        sessionId: state.data.sessionId,
        leafId: entries.data.leafId ?? null,
        entryCount: Array.isArray(entries.data.entries) ? entries.data.entries.length : 0,
        userIndex: target.userIndex,
        entryId: target.entryId,
        parentId: target.parentId,
        text: target.text,
        hasImages: target.images.length > 0,
        imageCount: target.images.length,
        hasToolsAfter: target.hasToolsAfter,
        commandReady,
        canEdit: !reason && commandReady,
        reason: reason || (commandReady ? null : 'navigate_unavailable'),
      };
    } catch (error) {
      return fail(error?.code || 'stale_runtime');
    }
  }

  async function resend(io, input) {
    if (disposed) return fail('unavailable');
    const normalized = normalizeInput(input);
    if (!normalized) return fail('invalid_request');
    if (!io || typeof io.request !== 'function' || typeof io.validate !== 'function') return fail('invalid_request');
    const { requestId, userIndex, kind } = normalized;

    pruneStatuses();
    const existing = statuses.get(requestId);
    if (existing) {
      /* requestId 只在自己的 native session 内幂等；跨会话复用同一个 id
       * 不能读到别的会话的事务结果。 */
      if (existing.sessionId !== io.sessionId) return fail('stale_session');
      if (existing.state === 'pending') return existing.promise;
      return { ...existing.result, duplicate: true };
    }
    if (inFlightSessions.has(io.sessionId)) return fail('edit_in_progress');
    if (normalized.text.length > MAX_TEXT_CHARS) return fail('message_too_large');

    const run = (async () => {
      let result;
      try {
        result = await execute(io, normalized);
      } catch (error) {
        result = fail(error?.code || 'internal');
      }
      if (disposed) result = fail('unavailable');
      statuses.set(requestId, { sessionId: io.sessionId, state: result.ok ? 'accepted' : 'failed', result: statusView(result), at: now() });
      inFlightSessions.delete(io.sessionId);
      publishResult(io, requestId, result.ok ? 'accepted' : 'failed', result.ok
        ? { targetEntryId: result.targetEntryId, newEntryId: result.newEntryId, newLeafId: result.newLeafId }
        : { code: result.code });
      safeLog('message_edit.result', { operation: kind, outcome: result.ok ? 'accepted' : result.code });
      return result;
    })();
    statuses.set(requestId, { sessionId: io.sessionId, state: 'pending', promise: run, at: now() });
    inFlightSessions.set(io.sessionId, requestId);
    return run;
  }

  async function execute(io, input) {
    const { requestId, userIndex, kind } = input;
    io.validate();
    const stateRead = await read(io, 'get_state');
    if (!stateRead.ok) return stateRead;
    const state = stateRead.data || {};
    if (io.sessionId && state.sessionId !== io.sessionId) return fail('stale_session');
    const reason = busyCode(state, io);
    if (reason) return fail(reason);
    io.validate();

    const entriesRead = await read(io, 'get_entries');
    if (!entriesRead.ok) return entriesRead;
    const entries = Array.isArray(entriesRead.data?.entries) ? entriesRead.data.entries : null;
    const leafId = entriesRead.data?.leafId ?? null;
    if (!entries) return fail('history_unparsable');
    const targets = userTargets(entries, leafId);
    if (!targets) return fail('history_unparsable');
    const target = targets[userIndex];
    if (!target) return fail('unknown_user_message');
    if (input.expectedEntryId && target.entryId !== input.expectedEntryId) return fail('stale_history');
    if (input.expectedLeafId !== undefined && leafId !== input.expectedLeafId) return fail('stale_history');
    if (target.hasUnsupportedParts) return fail('attachments_unsupported');

    const text = kind === 'regenerate' ? target.text : input.text;
    if (!text.trim() && target.images.length === 0) return fail('empty_message');
    if (text.length > MAX_TEXT_CHARS) return fail('message_too_large');
    if (imageBytes(target.images) > MAX_IMAGE_BYTES) return fail('attachments_unsupported');

    const commandsRead = await read(io, 'get_commands');
    if (!commandsRead.ok) return commandsRead;
    const commands = Array.isArray(commandsRead.data?.commands) ? commandsRead.data.commands : null;
    const commandName = typeof io.commandName === 'function' ? io.commandName() : null;
    if (!commands || !commandName || !commands.some(command => command?.name === commandName)) return fail('navigate_unavailable');
    if (kind === 'edit') {
      const conflict = commandConflict(text, commands);
      if (conflict) return fail('command_text_conflict', { command: conflict });
    }
    io.validate();

    /* 提交前最后一次核对：目标 entry、父节点、leaf 都必须还是 preflight 时
     * 看到的那一个。之后的导航命令只带 entryId，Pi 自己再解析一次。 */
    const freshRead = await read(io, 'get_entries');
    if (!freshRead.ok) return freshRead;
    const freshEntries = Array.isArray(freshRead.data?.entries) ? freshRead.data.entries : null;
    const freshLeaf = freshRead.data?.leafId ?? null;
    if (!freshEntries || freshLeaf !== leafId) return fail('stale_history');
    const freshTargets = userTargets(freshEntries, freshLeaf);
    const freshTarget = freshTargets?.[userIndex];
    if (!freshTarget || freshTarget.entryId !== target.entryId || freshTarget.parentId !== target.parentId) return fail('stale_history');
    if (freshTarget.hasUnsupportedParts) return fail('attachments_unsupported');

    /* 重新生成以**最新投影**里的原文与附件为准；编辑以用户输入为准。
     * 两者都必须再查一次命令冲突：以已注册命令开头的文本会被 Pi 当成命令
     * 执行，而不是一条新的用户消息。 */
    const sendText = kind === 'regenerate' ? freshTarget.text : text;
    if (!sendText.trim() && freshTarget.images.length === 0) return fail('empty_message');
    if (sendText.length > MAX_TEXT_CHARS) return fail('message_too_large');
    if (imageBytes(freshTarget.images) > MAX_IMAGE_BYTES) return fail('attachments_unsupported');
    const conflict = commandConflict(sendText, commands);
    if (conflict) return fail('command_text_conflict', { command: conflict });

    const oldLeafEntry = freshEntries.find(entry => entry.id === freshLeaf) || null;
    const needsGuard = needsRestoreGuard(oldLeafEntry);
    const beforeIds = new Set(freshEntries.map(entry => entry.id));
    const navResult = await io.request({ type: 'prompt', message: `/${commandName} ${target.entryId} ${requestId}`, __messageEditNav: true });
    if (!navResult || navResult.ok !== true) return fail('navigate_failed');
    io.validate();

    const afterNavRead = await read(io, 'get_entries');
    if (!afterNavRead.ok) return fail('navigate_unverified');
    const afterNavEntries = Array.isArray(afterNavRead.data?.entries) ? afterNavRead.data.entries : [];
    const afterNavLeaf = afterNavRead.data?.leafId ?? null;
    const expectedLeaf = target.parentId ?? null;
    const guard = needsGuard ? guardEntry(afterNavEntries, requestId, freshLeaf) : null;

    if (afterNavLeaf !== expectedLeaf || (needsGuard && !guard)) {
      const restored = await restore(io, commandName, needsGuard ? guard?.id || null : freshLeaf, requestId);
      if (!restored.ok) return fail('restore_unconfirmed');
      return fail('navigate_unverified');
    }

    io.validate();
    const sendResult = await io.request({
      type: 'prompt',
      message: sendText,
      ...(freshTarget.images.length ? { images: freshTarget.images } : {}),
    });
    const disposition = sendResult?.ok === true ? sendResult.data?.disposition : null;
    if (disposition !== 'started') {
      const restoreTarget = guard?.id || freshLeaf;
      const restored = await restore(io, commandName, restoreTarget, requestId);
      if (!restored.ok) return fail('restore_unconfirmed');
      return fail(sendResult?.code || (disposition === 'handled' ? 'prompt_handled' : 'prompt_rejected'));
    }

    /* `started` 是 Pi 在 Agent 接受之后、真正跑 run 之前发出的权威应答。
     * 用户消息 entry 紧随其后；有界等待它出现，拿到稳定 id 再返回。 */
    let accepted = null;
    const deadline = now() + pollTimeoutMs;
    while (!disposed && now() < deadline) {
      try { io.validate(); } catch { break; }
      const readBack = await read(io, 'get_entries');
      if (readBack.ok) {
        const entry = newUserEntry(readBack.data?.entries || [], beforeIds, target.parentId);
        if (entry) {
          accepted = {
            entryId: entry.id,
            leafId: readBack.data?.leafId ?? entry.id,
            text: textOfContent(entry.message?.content),
          };
          break;
        }
      }
      await sleep(pollIntervalMs);
    }

    const result = {
      ok: true,
      accepted: true,
      requestId,
      sessionId: state.sessionId,
      targetEntryId: target.entryId,
      targetParentId: target.parentId,
      userIndex,
      kind,
      text: accepted?.text || sendText,
      newEntryId: accepted?.entryId || null,
      newLeafId: accepted?.leafId || null,
      hasToolsAfter: freshTarget.hasToolsAfter,
      imagesPreserved: freshTarget.images.length,
    };
    return result;
  }

  async function restore(io, commandName, targetId, requestId) {
    if (!targetId) return fail('restore_unavailable');
    try {
      io.validate();
      const result = await io.request({ type: 'prompt', message: `/${commandName} ${targetId} ${requestId}-r`, __messageEditNav: true });
      if (!result || result.ok !== true) return fail('restore_unconfirmed');
      const entries = await read(io, 'get_entries');
      if (!entries.ok) return fail('restore_unconfirmed');
      if ((entries.data?.leafId ?? null) !== targetId) return fail('restore_unconfirmed');
      return { ok: true };
    } catch {
      return fail('restore_unconfirmed');
    }
  }

  function dispose() {
    disposed = true;
    statuses.clear();
    inFlightSessions.clear();
  }

  return { preflight, resend, status, busy: () => inFlightSessions.size > 0, dispose };
}
