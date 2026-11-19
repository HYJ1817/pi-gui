/* 历史用户消息“编辑并重新发送”/“重新生成”的后端事务。
 *
 * ---------- 原会话硬约束 ----------
 *
 * 只用 Pi 公开能力：
 *   1. GUI 注入的扩展命令 `/<random> <entryId> <leafId> <parentId> <sessionId>
 *      <requestId> <token>` 调用 `ctx.navigateTree`，把 leaf 移到目标用户消息的
 *      父节点（同一 session 文件）；
 *   2. 普通 RPC `prompt` 发送修改后的文本与原始 image parts。
 *
 * 不调用 `new_session` / `fork` / `switch_session`，不写 Pi 的 JSONL，不改
 * session schema。旧回复仍在 append-only 文件里，但不再位于 active path；
 * 模型上下文与 UI 都以 active path 为准。
 *
 * ---------- 三种结果，而不是“成功 / 失败” ----------
 *
 * RPC 超时、传输断开、bridge 应答丢失都**不能**直接等同于“没有发生”。事务把
 * 每个会改变历史的步骤归为：
 *   - 已确认执行；
 *   - 已确认未执行（Pi 明确拒绝，或回读证明路径未动且会话空闲）；
 *   - 无法确认。
 * 无法确认时保留 requestId 与事务身份，进入 `acceptance_unknown` /
 * `recovery_pending`，由状态查询或显式 recover 继续核对；不伪造“未发送”，
 * 也不释放事务锁。
 *
 * ---------- 失败恢复 ----------
 *
 * 导航成功、prompt 在 Agent 接受前失败时，导航回旧 leaf。若旧 leaf 本身是
 * 用户消息或 custom_message，扩展会先追加 custom guard entry，事务回滚到
 * guard，从而精确保留原路径。回滚后必须再用 `get_entries` 核对 leaf；核对
 * 失败返回 `restore_unconfirmed`，不谎称已恢复，也不盲目重试。
 *
 * ---------- 目标身份 ----------
 *
 * 正式提交必须携带首次预检锁定的 `expectedSessionId` / `expectedEntryId` /
 * `expectedParentId` / `expectedLeafId`。事务只核对，不按当前 userIndex 重新
 * 解析并替换目标；任一不匹配即 `stale_history`。
 *
 * ---------- 状态 ----------
 *
 * 同一 requestId 只执行一次；重复提交返回第一次的结果。不同 requestId 在同一
 * 会话同时只允许一个事务。状态只保留 requestId / entry id / 错误码，不记录
 * 消息正文、图片或路径到对外响应与日志。
 */
import { createHash, randomUUID } from 'node:crypto';
import { commandConflict, userTargets } from './session-edit-target.js';

const MAX_TEXT_CHARS = 1_000_000;
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const STATUS_TTL_MS = 2 * 60 * 1000;
const MAX_STATUS = 32;
const DEFAULT_POLL_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 40;
const ACCEPT_POLL_CAP_MS = 2000;

const READ_ONLY_COMMANDS = new Set([
  'get_state', 'get_messages', 'get_entries', 'get_tree', 'get_commands',
  'get_session_stats', 'get_available_models', 'get_available_thinking_levels',
]);
const ALLOWED_DURING_EDIT = new Set(['abort', 'extension_ui_response']);
const UNRESOLVED_STATES = new Set(['pending', 'acceptance_unknown', 'recovery_pending']);

const fail = (code, extra = null) => ({ ok: false, code, ...(extra && typeof extra === 'object' ? extra : {}) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
}

function imagesOfContent(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(part => part?.type === 'image' && typeof part.data === 'string');
}

function imageBytes(images) {
  let total = 0;
  for (const image of images) total += image?.data?.length || 0;
  return total;
}

function sameImages(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.type !== 'image' || b[i]?.type !== 'image') return false;
    if ((a[i]?.mimeType || '') !== (b[i]?.mimeType || '')) return false;
  }
  return true;
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
  const expectedParentId = input.expectedParentId === null ? null : typeof input.expectedParentId === 'string' ? input.expectedParentId : undefined;
  const expectedSessionId = typeof input.expectedSessionId === 'string' && input.expectedSessionId ? input.expectedSessionId : null;
  const requestId = normalizeRequestId(input.requestId) || randomUUID();
  return { userIndex, kind, text, expectedEntryId, expectedLeafId, expectedParentId, expectedSessionId, requestId };
}

/* 正式提交的必填身份契约。preflight 不要求这些字段，resend 必须全部携带。 */
function hasTargetIdentity(input) {
  return Boolean(input && input.expectedEntryId && typeof input.expectedLeafId === 'string'
    && input.expectedParentId !== undefined && input.expectedSessionId);
}

async function read(io, type) {
  try {
    const result = await io.request({ type });
    if (!result) return fail('pi_timeout', { unknown: true });
    if (result.ok !== true) return fail(result.code || 'pi_request_failed', { unknown: result.unknown === true });
    return { ok: true, data: result.data };
  } catch (error) {
    /* 抛异常通常意味着 bridge 已换代或请求根本没拿到应答；两者都不能证明
     * 命令没有执行。 */
    return fail(error?.code || 'pi_request_failed', { unknown: true });
  }
}

function busyCode(state, io) {
  const external = typeof io.busyReason === 'function' ? io.busyReason() : null;
  if (external) return external;
  if (state?.isStreaming === true) return 'session_streaming';
  if (state?.isCompacting === true) return 'session_compacting';
  if (Number.isInteger(state?.pendingMessageCount) && state.pendingMessageCount > 0) return 'session_queued';
  if (!state?.model) return 'model_unavailable';
  return null;
}

function guardEntry(entries, requestId, oldLeafId) {
  return entries.find(entry => entry?.type === 'custom'
    && entry.customType === 'pi-gui-edit-guard'
    && entry.data?.requestId === requestId
    && (oldLeafId === null || entry.parentId === oldLeafId)) || null;
}

function newUserEntry(entries, beforeIds, parentId, text, images) {
  return entries.find(entry => !beforeIds.has(entry.id)
    && entry.type === 'message'
    && entry.message?.role === 'user'
    && (entry.parentId ?? null) === (parentId ?? null)
    && textOfContent(entry.message?.content) === text
    && sameImages(imagesOfContent(entry.message?.content), images)) || null;
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

function statusResponse(record) {
  return {
    ok: true,
    state: record.state,
    ...(record.result ? { result: statusView(record.result) } : {}),
  };
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
  /* 按 native sessionId 的事务锁。与 statuses 分开：状态记录可以按 TTL 清理，
   * 但未解决事务的锁不能因为 TTL 被悄悄释放。 */
  const sessionLocks = new Map();
  let disposed = false;

  const safeLog = (event, details = {}) => {
    try { logEvent(event, details); } catch { /* observation only */ }
  };

  const currentBridgeRun = io => (typeof io?.getBridgeRun === 'function' ? io.getBridgeRun() : null);

  function pruneStatuses() {
    const at = now();
    for (const [key, value] of statuses) {
      if (!UNRESOLVED_STATES.has(value.state) && at - value.at > statusTtlMs) statuses.delete(key);
    }
    while (statuses.size > MAX_STATUS) {
      const oldest = [...statuses.entries()]
        .filter(([, value]) => !UNRESOLVED_STATES.has(value.state))
        .sort((a, b) => a[1].at - b[1].at)[0];
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

  function releaseLock(sessionId, requestId) {
    const lock = sessionLocks.get(sessionId);
    if (lock && lock.requestId === requestId) sessionLocks.delete(sessionId);
  }

  function lockSession(sessionId, requestId, bridgeRun) {
    if (!sessionId) return;
    sessionLocks.set(sessionId, { requestId, bridgeRun: bridgeRun ?? null });
  }

  function busy(sessionId = undefined, bridgeRun = undefined) {
    for (const [sid, lock] of sessionLocks) {
      if (sessionId && sid !== sessionId) continue;
      if (bridgeRun !== undefined && lock.bridgeRun !== null && lock.bridgeRun !== bridgeRun) continue;
      return true;
    }
    return false;
  }

  function blocksCommand(sessionId, commandType, { bridgeRun = undefined } = {}) {
    if (!commandType || READ_ONLY_COMMANDS.has(commandType) || ALLOWED_DURING_EDIT.has(commandType)) return false;
    return busy(sessionId, bridgeRun);
  }

  function activeSessionId() {
    return sessionLocks.keys().next().value || null;
  }

  function markAccepted(record, entry, source) {
    const tx = record.tx;
    /* accepted 只能发生在 tx 建立之后；没有 tx 说明内部状态已被破坏，
     * 不能把一次无法归属的成功当成已提交。 */
    if (!tx) { markFailed(record, 'internal'); return; }
    record.state = 'accepted';
    record.result = statusView(acceptedResult(tx, entry, source));
    record.at = now();
    releaseLock(record.sessionId, record.requestId);
    publishResult({ scope: record.scope, sessionId: record.sessionId, conversationId: record.conversationId }, record.requestId, 'accepted', {
      targetEntryId: record.result.targetEntryId,
      newEntryId: record.result.newEntryId,
      newLeafId: record.result.newLeafId,
    });
    safeLog('message_edit.result', { operation: tx?.kind || 'edit', outcome: 'accepted' });
  }

  function markFailed(record, code, extra = {}) {
    const tx = record.tx;
    record.state = 'failed';
    record.result = statusView(fail(code, extra));
    record.at = now();
    releaseLock(record.sessionId, record.requestId);
    publishResult({ scope: record.scope, sessionId: record.sessionId, conversationId: record.conversationId }, record.requestId, 'failed', { code });
    safeLog('message_edit.result', { operation: tx?.kind || 'edit', outcome: code });
  }

  function keepUnresolved(record, code, state = null) {
    const tx = record.tx;
    record.state = state || (tx?.phase === 'navigating' ? 'recovery_pending' : 'acceptance_unknown');
    record.result = statusView(fail(code, { unresolved: true }));
    record.at = now();
    publishResult({ scope: record.scope, sessionId: record.sessionId, conversationId: record.conversationId }, record.requestId, record.state, { code });
    safeLog('message_edit.unresolved', { operation: tx?.kind || 'edit', phase: tx?.phase || 'unknown', code });
  }

  function markRecoveryRequired(record, code) {
    record.state = 'recovery_required';
    record.result = statusView(fail(code, { unresolved: true, recoveryRequired: true }));
    record.at = now();
    releaseLock(record.sessionId, record.requestId);
    publishResult({ scope: record.scope, sessionId: record.sessionId, conversationId: record.conversationId }, record.requestId, record.state, { code });
    safeLog('message_edit.recovery_required', { operation: record.tx?.kind || 'edit', code });
  }

  async function status(ioOrRequestId, maybeRequestId) {
    pruneStatuses();
    const io = ioOrRequestId && typeof ioOrRequestId === 'object' ? ioOrRequestId : null;
    const requestId = normalizeRequestId(typeof ioOrRequestId === 'string' ? ioOrRequestId : maybeRequestId);
    if (!requestId) return { ok: true, state: 'unknown' };
    const record = statuses.get(requestId);
    if (!record) return { ok: true, state: 'unknown' };

    /* 状态查询也必须核对 native session：A 会话的 requestId 不能读到 B 的结果。 */
    if (io && record.sessionId && io.sessionId && io.sessionId !== record.sessionId) {
      if (UNRESOLVED_STATES.has(record.state)) markRecoveryRequired(record, 'stale_session');
      return { ok: true, state: 'stale_session', result: { ok: false, code: 'stale_session' } };
    }
    if (io && UNRESOLVED_STATES.has(record.state) && record.state !== 'pending') {
      await reconcile(io, record, { restore: false });
    }
    return statusResponse(record);
  }

  async function recover(io, requestId) {
    pruneStatuses();
    const id = normalizeRequestId(requestId);
    if (!id) return { ok: false, code: 'invalid_request' };
    const record = statuses.get(id);
    if (!record) return { ok: true, state: 'unknown' };
    if (record.state === 'pending') return { ...statusResponse(record), ok: false, code: 'edit_in_progress' };
    if (!UNRESOLVED_STATES.has(record.state)) return statusResponse(record);
    if (record.sessionId && io?.sessionId && io.sessionId !== record.sessionId) {
      markRecoveryRequired(record, 'stale_session');
      return { ok: true, state: 'stale_session', result: { ok: false, code: 'stale_session' } };
    }
    if (!record.tx) {
      markRecoveryRequired(record, 'recovery_unavailable');
      return statusResponse(record);
    }
    await reconcile(io, record, { restore: true });
    return statusResponse(record);
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
      /* 未解决事务（导航中 / 结果未知 / 恢复中）拥有这个 native session。
       * 预检必须明确返回 edit_in_progress，前端才能接回持久化的 requestId；
       * 若返回 canEdit:true，用户会走到提交才被拒，刷新后只剩一个无法解除
       * 的忙状态。 */
      if (sessionLocks.has(io.sessionId)) return fail('edit_in_progress');
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
    if (!hasTargetIdentity(normalized)) return fail('missing_target_identity');
    const { requestId, kind } = normalized;

    pruneStatuses();
    const existing = statuses.get(requestId);
    if (existing) {
      /* requestId 只在自己的 native session / conversation / 操作目标内幂等。
       * 同一个 id 换了目标、换了会话，不能读到别的事务的结果。 */
      if (existing.sessionId !== io.sessionId) return fail('stale_session');
      if ((existing.conversationId ?? null) !== (io.conversationId ?? null)) return fail('stale_session');
      const identity = {
        entryId: normalized.expectedEntryId,
        parentId: normalized.expectedParentId ?? null,
        leafId: normalized.expectedLeafId,
        userIndex: normalized.userIndex,
        kind: normalized.kind,
        /* 只存操作内容的摘要，不存正文；同一个 requestId 不能被另一个
         * 编辑内容复用。重新生成以目标原文为准，内容摘要固定为空。 */
        operationHash: createHash('sha256')
          .update(normalized.kind === 'edit' ? normalized.text : '')
          .digest('hex'),
      };
      if (!existing.identity || existing.identity.entryId !== identity.entryId
        || existing.identity.parentId !== identity.parentId
        || existing.identity.leafId !== identity.leafId
        || existing.identity.userIndex !== identity.userIndex
        || existing.identity.kind !== identity.kind
        || existing.identity.operationHash !== identity.operationHash) return fail('stale_history');
      if (existing.state === 'pending') return existing.promise;
      if (UNRESOLVED_STATES.has(existing.state)) {
        return { ...(existing.result || {}), duplicate: true, unresolved: true, state: existing.state };
      }
      return { ...existing.result, duplicate: true };
    }
    if (sessionLocks.has(io.sessionId)) return fail('edit_in_progress');
    if (normalized.text.length > MAX_TEXT_CHARS) return fail('message_too_large');

    const record = {
      sessionId: io.sessionId,
      requestId,
      scope: io.scope,
      conversationId: io.conversationId || null,
      identity: {
        entryId: normalized.expectedEntryId,
        parentId: normalized.expectedParentId ?? null,
        leafId: normalized.expectedLeafId,
        userIndex: normalized.userIndex,
        kind: normalized.kind,
        operationHash: createHash('sha256')
          .update(normalized.kind === 'edit' ? normalized.text : '')
          .digest('hex'),
      },
      state: 'pending',
      at: now(),
      bridgeRun: currentBridgeRun(io),
      tx: null,
      promise: null,
    };
    statuses.set(requestId, record);
    lockSession(io.sessionId, requestId, record.bridgeRun);

    const run = (async () => {
      let result;
      try {
        result = await execute(io, normalized, tx => { record.tx = tx; });
      } catch (error) {
        result = fail(error?.code || 'internal');
      }
      if (disposed) result = fail('unavailable');
      if (record.state === 'pending') {
        if (result.ok) markAccepted(record, result.newEntryId ? {
          entryId: result.newEntryId,
          leafId: result.newLeafId,
          text: result.text,
        } : null, result.acceptance || 'started');
        else if (result.unresolved) keepUnresolved(record, result.code, result.state);
        else markFailed(record, result.code, result.restored ? { restored: true } : {});
      }
      return result;
    })();
    record.promise = run;
    return run;
  }

  async function execute(io, input, onTx) {
    const { userIndex, kind } = input;
    io.validate();
    const stateRead = await read(io, 'get_state');
    if (!stateRead.ok) return stateRead;
    const state = stateRead.data || {};
    if (io.sessionId && state.sessionId !== io.sessionId) return fail('stale_session');
    if (input.expectedSessionId && state.sessionId !== input.expectedSessionId) return fail('stale_session');
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
    if (target.entryId !== input.expectedEntryId) return fail('stale_history');
    if (leafId !== input.expectedLeafId) return fail('stale_history');
    if ((target.parentId ?? null) !== (input.expectedParentId ?? null)) return fail('stale_history');
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
    if (typeof io.editToken !== 'function' || !io.editToken()) return fail('navigate_unavailable');
    if (kind === 'edit') {
      const conflict = commandConflict(text, commands);
      if (conflict) return fail('command_text_conflict', { command: conflict });
    }
    io.validate();

    /* 提交前最后一次核对：目标 entry、父节点、leaf 都必须还是 preflight 时
     * 看到的那一个。之后的导航命令只带稳定 ID，Pi 自己再解析一次。 */
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
    const tx = {
      requestId: input.requestId,
      userIndex,
      kind,
      sessionId: state.sessionId,
      expectedSessionId: input.expectedSessionId,
      targetEntryId: target.entryId,
      targetParentId: target.parentId ?? null,
      expectedLeaf: freshLeaf,
      oldLeafId: freshLeaf,
      oldLeafParentId: oldLeafEntry?.parentId ?? null,
      guardNeeded: needsRestoreGuard(oldLeafEntry),
      guardId: null,
      beforeIds: new Set(freshEntries.map(entry => entry.id)),
      sendText,
      images: freshTarget.images,
      hasToolsAfter: freshTarget.hasToolsAfter,
      phase: 'navigating',
      historyTouched: false,
      observedLeaf: null,
      evidence: { agentStarts: 0, userMessages: 0, userMessageId: null, settled: 0 },
    };
    onTx?.(tx);

    const message = navMessage(io, tx, {
      targetId: tx.targetEntryId,
      targetParentId: tx.targetParentId,
      currentLeaf: tx.oldLeafId,
      requestId: tx.requestId,
    });
    if (!message) return fail('navigate_unavailable');

    /* 从这里开始，历史可能已经改变。任何异常都必须经过恢复核对，不能直接
     * 当成普通失败释放事务。 */
    tx.historyTouched = true;
    let navResult;
    try {
      navResult = await io.request({ type: 'prompt', message, __messageEditNav: true });
    } catch (error) {
      return await recoverUnexpected(io, tx, error);
    }
    return await afterNavigation(io, tx, navResult);
  }

  function navMessage(io, tx, { targetId, targetParentId, currentLeaf, requestId }) {
    const commandName = typeof io.commandName === 'function' ? io.commandName() : null;
    const token = typeof io.editToken === 'function' ? io.editToken() : null;
    if (!commandName || !token) return null;
    const leaf = currentLeaf === null || currentLeaf === undefined ? '-' : currentLeaf;
    const parent = targetParentId === null || targetParentId === undefined ? '-' : targetParentId;
    return `/${commandName} ${targetId} ${leaf} ${parent} ${tx.sessionId} ${requestId} ${token}`;
  }

  async function readEntriesWithRetry(io) {
    let result = await read(io, 'get_entries');
    if (!result.ok && result.unknown) {
      await sleep(Math.min(100, pollIntervalMs * 2));
      result = await read(io, 'get_entries');
    }
    return result;
  }

  async function inspectNavigation(io, tx, navResult) {
    const entriesRead = await readEntriesWithRetry(io);
    if (!entriesRead.ok) return { kind: 'unknown', code: 'navigate_unverified' };
    const entries = Array.isArray(entriesRead.data?.entries) ? entriesRead.data.entries : [];
    const leaf = entriesRead.data?.leafId ?? null;
    tx.observedLeaf = leaf;
    const guard = tx.guardNeeded ? guardEntry(entries, tx.requestId, tx.oldLeafId) : null;
    if (guard) tx.guardId = guard.id;

    if (leaf === tx.targetParentId && (!tx.guardNeeded || guard)) {
      return { kind: 'executed', leaf, guard };
    }
    if (leaf === tx.oldLeafId || (guard && leaf === guard.id)) {
      const definitive = Boolean(navResult && navResult.ok !== true && navResult.unknown !== true)
        || Boolean(navResult && navResult.ok === true);
      let idle = false;
      if (!definitive) {
        const stateRead = await read(io, 'get_state');
        idle = stateRead.ok && stateRead.data?.sessionId === tx.sessionId && !busyCode(stateRead.data, io);
      }
      return { kind: 'not_executed', leaf, guard, confirmed: definitive || idle };
    }
    return { kind: 'unknown', leaf, guard };
  }

  async function afterNavigation(io, tx, navResult) {
    const observed = await inspectNavigation(io, tx, navResult);
    if (observed.kind === 'unknown') return unresolved(io, tx, 'navigate_unverified', { state: 'recovery_pending' });
    if (observed.kind === 'not_executed') {
      if (!observed.confirmed) return unresolved(io, tx, 'navigate_unverified', { state: 'recovery_pending' });
      /* guard 已追加但导航没执行：leaf 停在 guard，原路径本身仍然有效。 */
      return fail(navResult?.ok === true ? 'navigate_unverified' : (navResult?.code || 'navigate_failed'),
        observed.guard ? { restored: true } : {});
    }
    return await sendEditedPrompt(io, tx);
  }

  async function sendEditedPrompt(io, tx) {
    tx.phase = 'sending';
    /* 导航已经改变历史。发 prompt 之前再核对一次运行时代次：bridge 换代、
     * 工作区切换或 owner 变化时，这条 prompt 不能再被当成当前会话的提交。
     * 失败也走统一恢复，不能普通失败后把历史留在回滚点。 */
    try {
      io.validate();
    } catch (error) {
      return await recoverUnexpected(io, tx, error);
    }
    let sendResult;
    try {
      sendResult = await io.request({
        type: 'prompt',
        message: tx.sendText,
        ...(tx.images.length ? { images: tx.images } : {}),
      });
    } catch (error) {
      return await recoverAfterUnknown(io, tx, error?.code || 'pi_request_failed');
    }

    if (sendResult && sendResult.ok === true) {
      const disposition = sendResult.data?.disposition;
      if (disposition === 'started') {
        /* `started` 是 Pi 在 Agent 接受之后、真正跑 run 之前发出的权威应答。
         * 有界等待用户 entry 出现，拿到稳定 id；等不到也仍是已接受。 */
        const entry = await waitForAcceptedEntry(io, tx, Math.min(pollTimeoutMs, ACCEPT_POLL_CAP_MS));
        return acceptedResult(tx, entry, 'started');
      }
      /* handled / rejected 都是**没有开新 run** 的确定结果；恢复原路径。 */
      const restored = await restoreAfterFailure(io, tx, tx.observedLeaf);
      if (!restored.ok) return unresolved(io, tx, 'restore_unconfirmed', { state: 'recovery_pending' });
      return fail(disposition === 'handled' ? 'prompt_handled' : 'prompt_rejected', { restored: true });
    }

    if (sendResult && sendResult.ok !== true && sendResult.unknown !== true) {
      /* Pi 明确拒绝（命令未执行）。仍回读并恢复，防止导航已移动 leaf。 */
      const restored = await restoreAfterFailure(io, tx, tx.observedLeaf);
      if (!restored.ok) return unresolved(io, tx, 'restore_unconfirmed', { state: 'recovery_pending' });
      return fail(sendResult.code || 'prompt_rejected', { restored: true });
    }

    /* 超时 / 传输断开 / bridge 换代：结果未知，必须用 entry + 事件证据确认。 */
    return await recoverAfterUnknown(io, tx, 'acceptance_unknown');
  }

  function acceptedResult(tx, entry, source) {
    return {
      ok: true,
      accepted: true,
      requestId: tx.requestId,
      sessionId: tx.sessionId,
      targetEntryId: tx.targetEntryId,
      targetParentId: tx.targetParentId,
      userIndex: tx.userIndex,
      kind: tx.kind,
      text: entry?.text || tx.sendText,
      newEntryId: entry?.entryId || tx.evidence.userMessageId || null,
      newLeafId: entry?.leafId || null,
      hasToolsAfter: tx.hasToolsAfter,
      imagesPreserved: tx.images.length,
      acceptance: source,
    };
  }

  function unresolved(io, tx, code, extra = {}) {
    return {
      ok: false,
      code,
      unresolved: true,
      state: extra.state || (tx.phase === 'navigating' ? 'recovery_pending' : 'acceptance_unknown'),
      requestId: tx.requestId,
      sessionId: tx.sessionId,
      targetEntryId: tx.targetEntryId,
      targetParentId: tx.targetParentId,
      userIndex: tx.userIndex,
      kind: tx.kind,
    };
  }

  function findAccepted(entries, tx) {
    const entry = newUserEntry(entries, tx.beforeIds, tx.targetParentId, tx.sendText, tx.images);
    if (!entry) return null;
    return { entryId: entry.id, leafId: null, text: textOfContent(entry.message?.content) };
  }

  async function waitForAcceptedEntry(io, tx, timeoutMs) {
    const deadline = now() + Math.max(0, timeoutMs);
    while (!disposed) {
      const entries = await read(io, 'get_entries');
      if (entries.ok) {
        const entry = findAccepted(entries.data?.entries || [], tx);
        if (entry) {
          /* 新 entry 必须属于同一个 native session；否则宁可只保留
           * “started 已接受”这一事实，也不把别的会话的 entry id 绑进来。 */
          const state = await read(io, 'get_state');
          if (state.ok && state.data?.sessionId === tx.sessionId) {
            entry.leafId = entries.data?.leafId ?? null;
            return entry;
          }
        }
      }
      if (now() >= deadline) break;
      await sleep(pollIntervalMs);
    }
    if (tx.evidence.userMessageId) {
      return { entryId: tx.evidence.userMessageId, leafId: null, text: tx.sendText };
    }
    return null;
  }

  /* 结果未知时用**可核对的证据**确认归属：新的 user entry 必须同时满足
   * parentId、文本与附件数量，且不在事务开始前的 id 集合里；事件只作为补充，
   * 不能仅凭“出现一条 user entry”就认领。 */
  async function waitForAcceptance(io, tx) {
    const deadline = now() + pollTimeoutMs;
    let lastState = null;
    let lastLeaf = null;
    let iterations = 0;
    const sessionConfirmed = async () => {
      const state = await read(io, 'get_state');
      if (!state.ok) return { ok: false, unknown: true };
      if (state.data?.sessionId !== tx.sessionId) return { ok: false, stale: true };
      lastState = state.data;
      return { ok: true };
    };
    while (!disposed) {
      const entries = await read(io, 'get_entries');
      if (entries.ok) {
        const entry = findAccepted(entries.data?.entries || [], tx);
        if (entry) {
          /* 即使 entry 文本/父节点匹配，也必须先证明它属于同一个 native
           * session，不能把别的会话里同文的消息认成这次提交。 */
          const confirmed = await sessionConfirmed();
          if (!confirmed.ok) return { kind: 'unknown', reason: confirmed.stale ? 'stale_session' : 'state_unconfirmed' };
          entry.leafId = entries.data?.leafId ?? null;
          return { kind: 'accepted', entry, source: tx.evidence.userMessages > 0 ? 'event' : 'entry' };
        }
        lastLeaf = entries.data?.leafId ?? null;
        if (iterations % 4 === 0) {
          const state = await read(io, 'get_state');
          if (state.ok) {
            if (state.data?.sessionId !== tx.sessionId) return { kind: 'unknown', reason: 'stale_session' };
            lastState = state.data;
          }
        }
      }
      if (tx.evidence.userMessages > 0 && tx.evidence.userMessageId) {
        const confirmed = await sessionConfirmed();
        if (!confirmed.ok) return { kind: 'unknown', reason: confirmed.stale ? 'stale_session' : 'state_unconfirmed' };
        return {
          kind: 'accepted',
          entry: { entryId: tx.evidence.userMessageId, leafId: lastLeaf, text: tx.sendText },
          source: 'event',
        };
      }
      if (now() >= deadline) break;
      await sleep(pollIntervalMs);
      iterations++;
    }
    if (tx.evidence.userMessages > 0) {
      /* 事件已经证明出现了一条与本次事务文本/附件一致的新用户消息，但回读
       * 暂时没拿到它的 id。仍按已接受处理，不能因为 id 缺失就恢复旧路径；
       * 前提同样是 session 身份可核对。 */
      const confirmed = await sessionConfirmed();
      if (confirmed.ok) {
        return {
          kind: 'accepted',
          entry: { entryId: tx.evidence.userMessageId || null, leafId: lastLeaf, text: tx.sendText },
          source: 'event',
        };
      }
      if (confirmed.stale) return { kind: 'unknown', reason: 'stale_session' };
    }
    if (lastState && !busyCode(lastState, io)) {
      /* 导航成功后、prompt 未被接受时，leaf 停在 targetParentId；它既不是
       * 提交前的 expectedLeaf，也不是回滚后的 oldLeaf。两者都必须算
       * “没有新消息、可以回滚”的确定状态。 */
      if (lastLeaf === tx.expectedLeaf || lastLeaf === tx.oldLeafId
        || lastLeaf === tx.targetParentId || (tx.guardId && lastLeaf === tx.guardId)) {
        return { kind: 'not_accepted', leaf: lastLeaf, code: 'prompt_unconfirmed' };
      }
      return { kind: 'unknown', reason: 'leaf_changed' };
    }
    return { kind: 'unknown', reason: 'unconfirmed' };
  }

  async function recoverAfterUnknown(io, tx, fallbackCode) {
    const evidence = await waitForAcceptance(io, tx);
    if (evidence.kind === 'accepted') return acceptedResult(tx, evidence.entry, evidence.source);
    if (evidence.kind === 'not_accepted') {
      if (evidence.leaf === tx.oldLeafId || (tx.guardId && evidence.leaf === tx.guardId)) {
        return fail(evidence.code || fallbackCode, { restored: true });
      }
      const restored = await restoreAfterFailure(io, tx, evidence.leaf);
      if (restored.ok) return fail(evidence.code || fallbackCode, { restored: true });
      return unresolved(io, tx, 'restore_unconfirmed', { state: 'recovery_pending' });
    }
    return unresolved(io, tx, fallbackCode || 'acceptance_unknown', { state: 'acceptance_unknown' });
  }

  async function restoreAfterFailure(io, tx, currentLeaf) {
    const targetId = tx.guardNeeded ? tx.guardId : tx.oldLeafId;
    if (!targetId) return fail('restore_unavailable');
    const targetParentId = tx.guardNeeded ? tx.oldLeafId : tx.oldLeafParentId;
    return await restore(io, tx, targetId, targetParentId, currentLeaf);
  }

  async function restore(io, tx, targetId, targetParentId, currentLeaf) {
    if (!targetId) return fail('restore_unavailable');
    const message = navMessage(io, tx, {
      targetId,
      targetParentId,
      currentLeaf,
      requestId: randomUUID(),
    });
    if (!message) return fail('restore_unavailable');
    try {
      await io.request({ type: 'prompt', message, __messageEditNav: true });
      /* 恢复命令的应答本身也可能丢失；leaf 回读才是判据。 */
      const entries = await read(io, 'get_entries');
      if (!entries.ok) return fail('restore_unconfirmed');
      if ((entries.data?.leafId ?? null) !== targetId) return fail('restore_unconfirmed');
      return { ok: true };
    } catch {
      return fail('restore_unconfirmed');
    }
  }

  async function recoverUnexpected(io, tx, error) {
    if (!tx.historyTouched) return fail(error?.code || 'internal');
    if (tx.phase === 'sending') {
      return await recoverAfterUnknown(io, tx, error?.code || 'acceptance_unknown');
    }
    /* 导航阶段的异常：先核对实际 leaf，能确认未执行就普通失败；能确认
     * 已执行就恢复；无法确认则进入恢复保护。 */
    const observed = await inspectNavigation(io, tx, null);
    if (observed.kind === 'not_executed' && observed.confirmed) {
      return fail(error?.code || 'navigate_failed', observed.guard ? { restored: true } : {});
    }
    if (observed.kind === 'executed') {
      const restored = await restoreAfterFailure(io, tx, observed.leaf);
      if (restored.ok) return fail(error?.code || 'navigate_unverified', { restored: true });
      return unresolved(io, tx, 'restore_unconfirmed', { state: 'recovery_pending' });
    }
    return unresolved(io, tx, 'navigate_unverified', { state: 'recovery_pending' });
  }

  async function reconcile(io, record, { restore: canRestore }) {
    const tx = record.tx;
    if (!tx) { markRecoveryRequired(record, 'recovery_unavailable'); return; }
    try { io.validate(); } catch (error) {
      /* bridge 已换代：事务的原通道消失，保留状态但释放锁，避免永久忙。 */
      markRecoveryRequired(record, error?.code || 'stale_runtime');
      return;
    }
    const stateRead = await read(io, 'get_state');
    if (!stateRead.ok) {
      if (stateRead.unknown && typeof io.validate === 'function') {
        try { io.validate(); } catch (error) { markRecoveryRequired(record, error?.code || 'stale_runtime'); return; }
      }
      keepUnresolved(record, stateRead.code || 'pi_timeout');
      return;
    }
    if (stateRead.data?.sessionId !== record.sessionId) {
      markRecoveryRequired(record, 'stale_session');
      return;
    }
    const entriesRead = await read(io, 'get_entries');
    if (!entriesRead.ok) { keepUnresolved(record, entriesRead.code || 'pi_timeout'); return; }
    const entries = Array.isArray(entriesRead.data?.entries) ? entriesRead.data.entries : [];
    const leaf = entriesRead.data?.leafId ?? null;

    /* 初次导航回读失败时 guard 还没被认领；reconcile 现在拿到了 entries，
     * 必须补做认领。否则 restoreAfterFailure 的 guardId 永远是 null，
     * 事务会一直停在 recovery_pending，恢复入口无法收敛。 */
    if (tx.guardNeeded && !tx.guardId) {
      const guard = guardEntry(entries, tx.requestId, tx.oldLeafId);
      if (guard) tx.guardId = guard.id;
    }

    const accepted = findAccepted(entries, tx);
    if (accepted) {
      accepted.leafId = leaf;
      markAccepted(record, accepted, 'reconcile');
      return;
    }
    if (busyCode(stateRead.data, io)) { keepUnresolved(record, 'acceptance_unknown'); return; }
    if (leaf === tx.oldLeafId || (tx.guardId && leaf === tx.guardId)) {
      markFailed(record, tx.phase === 'navigating' ? 'navigate_failed' : 'prompt_unconfirmed', { restored: true });
      return;
    }
    if (leaf === tx.expectedLeaf) {
      if (!canRestore) { keepUnresolved(record, tx.phase === 'navigating' ? 'navigate_unverified' : 'acceptance_unknown'); return; }
      const restored = await restoreAfterFailure(io, tx, leaf);
      if (restored.ok) {
        markFailed(record, tx.phase === 'navigating' ? 'navigate_failed' : 'prompt_unconfirmed', { restored: true });
      } else {
        keepUnresolved(record, 'restore_unconfirmed', 'recovery_pending');
      }
      return;
    }
    if (leaf === tx.targetParentId) {
      /* 导航已执行、但 prompt 没有被接受：历史停在导航点。只有显式 recover
       * 才回滚；普通 status 查询保持未确认，不擅自改动会话。 */
      if (!canRestore) { keepUnresolved(record, 'acceptance_unknown'); return; }
      /* guard 是恢复原 leaf 的唯一锚点。回读成功却找不到它，说明会话文件
       * 已被外部改写/压缩，继续发恢复命令只会永远停在 recovery_pending；
       * 按无法恢复收口并释放锁，明确要求用户刷新检查历史。 */
      if (tx.guardNeeded && !tx.guardId) {
        markRecoveryRequired(record, 'restore_unavailable');
        return;
      }
      const restored = await restoreAfterFailure(io, tx, leaf);
      if (restored.ok) {
        markFailed(record, tx.phase === 'navigating' ? 'navigate_failed' : 'prompt_unconfirmed', { restored: true });
      } else {
        keepUnresolved(record, 'restore_unconfirmed', 'recovery_pending');
      }
      return;
    }
    keepUnresolved(record, 'recovery_pending', 'recovery_pending');
  }

  /* bridge 事件只作为补充证据：agent_start 单独不能认领，必须同时看到与
   * 事务文本一致的 user message 事件或回读到的 entry。`sessionId` 由调用方
   * 提供当前 Pi 的 native session；能核对时必须一致，不能把另一个会话里
   * 同文的消息认成这次提交。 */
  function observe(event, sessionId = null) {
    if (!event || typeof event.type !== 'string') return;
    for (const record of statuses.values()) {
      /* pending 期间也要收集：prompt 的应答可能先于状态落定丢失，事件是
       * 之后确认归属的补充证据。 */
      if (!record.tx || (record.state !== 'pending' && record.state !== 'acceptance_unknown')) continue;
      if (sessionId && record.sessionId && sessionId !== record.sessionId) continue;
      const tx = record.tx;
      if (event.type === 'message_start' && event.message?.role === 'user') {
        if (textOfContent(event.message.content) !== tx.sendText) continue;
        if (!sameImages(imagesOfContent(event.message.content), tx.images)) continue;
        if (event.message.id && tx.beforeIds.has(event.message.id)) continue;
        tx.evidence.userMessages++;
        if (event.message.id) tx.evidence.userMessageId = event.message.id;
      }
    }
  }

  function dispose() {
    disposed = true;
    statuses.clear();
    sessionLocks.clear();
  }

  return {
    preflight,
    resend,
    status,
    recover,
    observe,
    busy,
    busyForSession: sessionId => Boolean(sessionId && sessionLocks.has(sessionId)),
    blocksCommand,
    activeSessionId,
    dispose,
  };
}
