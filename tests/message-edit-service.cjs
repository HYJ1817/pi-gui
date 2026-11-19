/* 历史消息编辑事务：用假的 RPC 会话验证状态机、身份核对、互斥与回滚。
 *
 * 这里不 spawn Pi。假会话只实现事务用到的 5 条命令（get_state / get_entries /
 * get_commands / 导航 prompt / 重发 prompt），并像 Pi 一样在导航时移动 leaf、
 * 在旧 leaf 是用户消息时追加 guard entry。真实 Pi 的验收在独立测试里。
 *
 * 故障注入是**真的执行命令、再丢掉应答**：导航/恢复真的移动了 leaf，prompt
 * 真的追加了用户 entry，只是返回值变成超时。这样才验证得了“应答丢失不等于
 * 操作没发生”。
 */
'use strict';
const assert = require('node:assert/strict');

const text = value => [{ type: 'text', text: value }];
const message = (id, parentId, role, content, timestamp = 1) => ({ type: 'message', id, parentId, message: { role, content }, timestamp });
const user = (id, parentId, value, extra = []) => message(id, parentId, 'user', [...text(value), ...extra]);
const assistant = (id, parentId, value) => message(id, parentId, 'assistant', text(value));

const identity = (overrides = {}) => ({
  userIndex: 1, kind: 'edit',
  expectedEntryId: 'u2', expectedParentId: 'a1', expectedLeafId: 'a2', expectedSessionId: 'native-1',
  ...overrides,
});

function createHarness(options = {}) {
  const entries = options.entries || [user('u1', null, 'first'), assistant('a1', 'u1', 'reply first'), user('u2', 'a1', 'second'), assistant('a2', 'u2', 'reply second')];
  let leafId = options.leafId ?? 'a2';
  const state = {
    sessionId: options.sessionId || 'native-1',
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    model: { provider: 'fixture', id: 'fixture' },
  };
  const calls = [];
  let seq = 0;
  const harness = {
    entries,
    state,
    calls,
    stale: false,
    navNoop: false,
    navThrows: false,
    guardNoop: false,
    rejectPrompt: false,
    handledPrompt: false,
    dropNavResponse: false,
    dropPromptResponse: false,
    promptNoop: false,
    promptThrows: false,
    entriesFailAfterNav: false,
    entriesFailAfterPrompt: false,
    stateFailAfterNav: false,
    validateAfterNav: false,
    dropRestoreResponse: false,
    restoreNoop: false,
    restoreThrows: false,
    navExecuted: false,
    navCount: 0,
    promptCount: 0,
    promptSent: false,
    guard: null,
    lastPromptEntry: null,
    onPrompt: null,
    initialLeaf: leafId,
    nav() { return calls.filter(call => call.__messageEditNav === true); },
    sends() { return calls.filter(call => call.type === 'prompt' && call.__messageEditNav !== true); },
  };
  Object.defineProperty(harness, 'leafId', {
    get: () => leafId,
    set: value => { leafId = value; },
  });

  function appendGuard(requestId) {
    const existing = entries.find(entry => entry.type === 'custom' && entry.data?.requestId === requestId);
    if (existing) return existing;
    const oldLeaf = entries.find(entry => entry.id === leafId) || null;
    if (!oldLeaf || !(oldLeaf.type === 'custom_message' || oldLeaf.type === 'message' && oldLeaf.message?.role === 'user')) return null;
    const guard = { type: 'custom', id: 'guard-' + (++seq), parentId: oldLeaf.id, customType: 'pi-gui-edit-guard', data: { requestId } };
    entries.push(guard);
    harness.leafId = guard.id;
    if (!harness.guard) harness.guard = guard;
    return guard;
  }

  harness.io = {
    scope: 'classic',
    sessionId: state.sessionId,
    commandName: () => 'edit-cmd',
    editToken: () => 'token-1',
    getBridgeRun: () => 1,
    busyReason: () => options.busyReason?.() || null,
    validate() {
      if (harness.stale) throw Object.assign(Error('stale_runtime'), { code: 'stale_runtime' });
      if (harness.validateAfterNav && harness.navExecuted) throw Object.assign(Error('stale_runtime'), { code: 'stale_runtime' });
    },
    async request(cmd) {
      calls.push({ ...cmd });
      if (cmd.type === 'get_state') {
        if (harness.stateFailAfterNav && harness.navExecuted) return { ok: false, code: 'pi_timeout', unknown: true };
        return { ok: true, data: { ...state } };
      }
      if (cmd.type === 'get_entries') {
        if ((harness.entriesFailAfterNav && harness.navExecuted)
          || (harness.entriesFailAfterPrompt && harness.promptSent)) return { ok: false, code: 'pi_timeout', unknown: true };
        return { ok: true, data: { entries: entries.slice(), leafId } };
      }
      if (cmd.type === 'get_commands') return { ok: true, data: { commands: options.commands || [{ name: 'edit-cmd' }, { name: 'help' }] } };
      if (cmd.type !== 'prompt') return { ok: false, code: 'invalid_request' };

      if (cmd.__messageEditNav === true) {
        const parts = String(cmd.message || '').split(/\s+/);
        if (parts.length !== 7) return { ok: true, data: { disposition: 'handled' } };
        const [rawName, targetId, rawLeaf, rawParent, expectedSession, requestId, suppliedToken] = parts;
        const nullId = value => value === '-' ? null : value;
        if (rawName !== '/edit-cmd' || suppliedToken !== 'token-1') return { ok: true, data: { disposition: 'handled' } };
        if (expectedSession !== state.sessionId) return { ok: false, code: 'stale_edit_session', unknown: false };
        if (nullId(rawLeaf) !== leafId) return { ok: false, code: 'stale_edit_leaf', unknown: false };
        const target = entries.find(entry => entry.id === targetId);
        if (!target || (target.parentId ?? null) !== nullId(rawParent)) return { ok: false, code: 'stale_edit_target', unknown: false };

        harness.navCount++;
        const restoring = harness.navCount > 1;
        const oldLeaf = entries.find(entry => entry.id === leafId) || null;
        if (oldLeaf && (oldLeaf.type === 'custom_message' || oldLeaf.type === 'message' && oldLeaf.message?.role === 'user')
          && !harness.guardNoop) {
          appendGuard(requestId);
        }
        harness.navExecuted = true;
        const editable = target.type === 'message' && target.message?.role === 'user';
        if (!(restoring ? harness.restoreNoop : harness.navNoop)) {
          harness.leafId = editable ? (target.parentId ?? null) : target.id;
        }
        if (restoring ? harness.restoreThrows : harness.navThrows) throw new Error('nav_exploded');
        if (restoring ? harness.dropRestoreResponse : harness.dropNavResponse) return { ok: false, code: 'pi_timeout', unknown: true };
        return { ok: true, data: { disposition: 'handled' } };
      }

      harness.promptCount++;
      harness.promptSent = true;
      if (harness.rejectPrompt) return { ok: true, data: { disposition: 'rejected' } };
      if (harness.handledPrompt) return { ok: true, data: { disposition: 'handled' } };
      if (harness.promptNoop) {
        if (harness.dropPromptResponse) return { ok: false, code: 'pi_timeout', unknown: true };
        return { ok: true, data: { disposition: 'started' } };
      }
      const content = [{ type: 'text', text: cmd.message }, ...(cmd.images || [])];
      const entry = message('new-' + (++seq), leafId, 'user', content, 2);
      entries.push(entry);
      harness.leafId = entry.id;
      harness.lastPromptEntry = entry;
      harness.onPrompt?.(entry);
      if (harness.promptThrows) throw new Error('prompt_exploded');
      if (harness.dropPromptResponse) return { ok: false, code: 'pi_timeout', unknown: true };
      return { ok: true, data: { disposition: 'started' } };
    },
  };
  return harness;
}

(async () => {
  const { createMessageEditService } = await import('../server/message-edit.js');
  let checks = 0;
  const pass = async (name, fn) => {
    try { await fn(); checks++; console.log('PASS ' + name); }
    catch (error) { console.error('FAIL ' + name + ': ' + (error.stack || error.message)); throw error; }
  };
  const service = (options = {}) => createMessageEditService({ pollTimeoutMs: 200, pollIntervalMs: 5, ...options });

  await pass('preflight binds the visible index to a native entry id and leaf', async () => {
    const h = createHarness(), s = service();
    const result = await s.preflight(h.io, { userIndex: 1, kind: 'edit' });
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, 'native-1');
    assert.equal(result.entryId, 'u2');
    assert.equal(result.parentId, 'a1');
    assert.equal(result.leafId, 'a2');
    assert.equal(result.text, 'second');
    assert.equal(result.commandReady, true);
    assert.equal(result.canEdit, true);
    s.dispose();
  });

  await pass('preflight reports a tool warning for the turn', async () => {
    const tool = assistant('a1', 'u1', 'reply');
    tool.message.content.push({ type: 'toolCall', id: 'call', name: 'write', arguments: {} });
    const h = createHarness({ entries: [user('u1', null, 'first'), tool, user('u2', 'a1', 'second'), assistant('a2', 'u2', 'reply')] });
    const s = service();
    const result = await s.preflight(h.io, { userIndex: 0, kind: 'edit' });
    assert.equal(result.hasToolsAfter, true);
    s.dispose();
  });

  await pass('streaming / compacting / queued sessions cannot edit', async () => {
    for (const [field, code] of [['isStreaming', 'session_streaming'], ['isCompacting', 'session_compacting'], ['pendingMessageCount', 'session_queued']]) {
      const h = createHarness();
      h.state[field] = field === 'pendingMessageCount' ? 1 : true;
      const s = service();
      const pre = await s.preflight(h.io, { userIndex: 1, kind: 'edit' });
      assert.equal(pre.canEdit, false);
      assert.equal(pre.reason, code);
      const result = await s.resend(h.io, { ...identity(), text: 'changed', requestId: 'request-' + field });
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      assert.equal(h.nav().length, 0);
      s.dispose();
    }
  });

  await pass('external busy reason is surfaced before touching history', async () => {
    const h = createHarness({ busyReason: () => 'stop_in_progress' }), s = service();
    const pre = await s.preflight(h.io, { userIndex: 1, kind: 'edit' });
    assert.equal(pre.reason, 'stop_in_progress');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('missing navigation command fails closed', async () => {
    const h = createHarness({ commands: [{ name: 'help' }] }), s = service();
    const pre = await s.preflight(h.io, { userIndex: 1, kind: 'edit' });
    assert.equal(pre.canEdit, false);
    assert.equal(pre.reason, 'navigate_unavailable');
    const result = await s.resend(h.io, { ...identity(), text: 'changed', requestId: 'no-command' });
    assert.equal(result.code, 'navigate_unavailable');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('edit navigates to the target parent then sends the edited text', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { ...identity(), text: 'edited second', requestId: 'edit-one' });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.sessionId, 'native-1');
    assert.equal(result.targetEntryId, 'u2');
    assert.equal(result.targetParentId, 'a1');
    assert.equal(result.newEntryId, 'new-1');
    assert.equal(result.text, 'edited second');
    assert.equal(h.nav().length, 1);
    assert.equal(h.sends().length, 1);
    assert.equal(h.nav()[0].message, '/edit-cmd u2 a2 a1 native-1 edit-one token-1');
    assert.equal(h.sends()[0].message, 'edited second');
    assert.equal(h.leafId, 'new-1');
    const active = h.entries.find(entry => entry.id === h.leafId);
    assert.equal(active.parentId, 'a1');
    s.dispose();
  });

  await pass('images are carried into the new prompt', async () => {
    const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
    const h = createHarness({ entries: [user('u1', null, 'first', [image]), assistant('a1', 'u1', 'reply')], leafId: 'a1' });
    const s = service();
    const result = await s.resend(h.io, { ...identity({ userIndex: 0, expectedEntryId: 'u1', expectedParentId: null, expectedLeafId: 'a1' }), text: 'first edited', requestId: 'edit-image' });
    assert.equal(result.ok, true);
    assert.equal(result.imagesPreserved, 1);
    assert.deepEqual(h.sends()[0].images, [image]);
    s.dispose();
  });

  await pass('unsupported attachment parts are rejected before navigation', async () => {
    const file = { type: 'file', path: '/tmp/secret.txt' };
    const h = createHarness({ entries: [user('u1', null, 'first', [file]), assistant('a1', 'u1', 'reply')], leafId: 'a1' });
    const s = service();
    const result = await s.resend(h.io, { ...identity({ userIndex: 0, expectedEntryId: 'u1', expectedParentId: null, expectedLeafId: 'a1' }), text: 'changed', requestId: 'edit-file' });
    assert.equal(result.code, 'attachments_unsupported');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('regenerate uses the target text, never caller-supplied text', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { ...identity({ kind: 'regenerate' }), text: 'ignored', requestId: 'regen-one' });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'regenerate');
    assert.equal(h.sends()[0].message, 'second');
    assert.equal(result.text, 'second');
    s.dispose();
  });

  await pass('resend requires the full stable target identity', async () => {
    const h = createHarness(), s = service();
    for (const missing of ['expectedEntryId', 'expectedLeafId', 'expectedSessionId']) {
      const input = { ...identity(), text: 'changed', requestId: 'missing-' + missing };
      delete input[missing];
      const result = await s.resend(h.io, input);
      assert.equal(result.code, 'missing_target_identity');
    }
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('expected entry id mismatch is stale and does not navigate', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { ...identity({ expectedEntryId: 'u1' }), text: 'changed', requestId: 'stale-entry' });
    assert.equal(result.code, 'stale_history');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('expected parent mismatch is stale and does not navigate', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { ...identity({ expectedParentId: 'wrong' }), text: 'changed', requestId: 'stale-parent' });
    assert.equal(result.code, 'stale_history');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('expected leaf mismatch is stale and does not navigate', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { ...identity({ expectedLeafId: 'a1' }), text: 'changed', requestId: 'stale-leaf' });
    assert.equal(result.code, 'stale_history');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('expected session mismatch is stale and does not navigate', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { ...identity({ expectedSessionId: 'native-2' }), text: 'changed', requestId: 'stale-session-target' });
    assert.equal(result.code, 'stale_session');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('session id mismatch is stale', async () => {
    const h = createHarness(), s = service();
    h.state.sessionId = 'native-2';
    const result = await s.preflight(h.io, { userIndex: 1, kind: 'edit' });
    assert.equal(result.code, 'stale_session');
    s.dispose();
  });

  await pass('bridge/workspace validation failure is stale and does not navigate', async () => {
    const h = createHarness(), s = service();
    h.stale = true;
    const result = await s.resend(h.io, { ...identity(), text: 'changed', requestId: 'stale-runtime' });
    assert.equal(result.code, 'stale_runtime');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('blank text and oversized text are rejected', async () => {
    const h = createHarness(), s = service();
    assert.equal((await s.resend(h.io, { ...identity(), text: '   ', requestId: 'empty-text' })).code, 'empty_message');
    assert.equal((await s.resend(h.io, { ...identity(), text: 'x'.repeat(1_000_001), requestId: 'huge-text' })).code, 'message_too_large');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('registered command text is rejected instead of being dispatched', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { ...identity(), text: '/help me', requestId: 'command-text' });
    assert.equal(result.code, 'command_text_conflict');
    assert.equal(result.command, 'help');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('a navigation that does not move the leaf is restored and reported', async () => {
    const h = createHarness(), s = service();
    h.navNoop = true;
    const result = await s.resend(h.io, { ...identity(), text: 'changed', requestId: 'nav-noop' });
    assert.equal(result.code, 'navigate_unverified');
    assert.equal(h.sends().length, 0);
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('a rejected prompt restores the old assistant leaf', async () => {
    const h = createHarness(), s = service();
    h.rejectPrompt = true;
    const result = await s.resend(h.io, { ...identity(), text: 'changed', requestId: 'reject-prompt' });
    assert.equal(result.code, 'prompt_rejected');
    assert.equal(h.sends().length, 1);
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('a handled prompt restores the old assistant leaf', async () => {
    const h = createHarness(), s = service();
    h.handledPrompt = true;
    const result = await s.resend(h.io, { ...identity(), text: 'changed', requestId: 'handled-prompt' });
    assert.equal(result.code, 'prompt_handled');
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('a user leaf is guarded and restored exactly on failure', async () => {
    const h = createHarness({ entries: [user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), user('u2', 'a1', 'second')], leafId: 'u2' });
    h.rejectPrompt = true;
    const s = service();
    const result = await s.resend(h.io, { ...identity({ userIndex: 0, expectedEntryId: 'u1', expectedParentId: null, expectedLeafId: 'u2' }), text: 'changed first', requestId: 'guard-restore' });
    assert.equal(result.code, 'prompt_rejected');
    assert.ok(h.guard);
    assert.equal(h.leafId, h.guard.id);
    assert.equal(h.entries.find(entry => entry.id === h.guard.id).parentId, 'u2');
    s.dispose();
  });

  await pass('a custom_message leaf is also guarded and restored', async () => {
    const custom = { type: 'custom_message', id: 'cm', parentId: 'a1', content: text('extension message') };
    const h = createHarness({ entries: [user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), custom], leafId: 'cm' });
    h.rejectPrompt = true;
    const s = service();
    const result = await s.resend(h.io, { ...identity({ userIndex: 0, expectedEntryId: 'u1', expectedParentId: null, expectedLeafId: 'cm' }), text: 'changed', requestId: 'custom-guard' });
    assert.equal(result.code, 'prompt_rejected');
    assert.ok(h.guard);
    assert.equal(h.leafId, h.guard.id);
    s.dispose();
  });

  await pass('duplicate requestId is idempotent and does not send twice', async () => {
    const h = createHarness(), s = service();
    const first = s.resend(h.io, { ...identity(), text: 'edited', requestId: 'same-request' });
    const second = s.resend(h.io, { ...identity(), text: 'edited', requestId: 'same-request' });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(h.nav().length, 1);
    assert.equal(h.sends().length, 1);
    const third = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'same-request' });
    assert.equal(third.duplicate, true);
    assert.equal(h.sends().length, 1);
    s.dispose();
  });

  await pass('duplicate requestId with a different target or operation is rejected', async () => {
    const h = createHarness(), s = service();
    const first = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'same-target' });
    assert.equal(first.ok, true);
    const otherTarget = await s.resend(h.io, { ...identity({ expectedEntryId: 'u1', expectedParentId: null, expectedLeafId: 'a2' }), text: 'edited', requestId: 'same-target' });
    assert.equal(otherTarget.code, 'stale_history');
    const otherText = await s.resend(h.io, { ...identity(), text: 'different body', requestId: 'same-target' });
    assert.equal(otherText.code, 'stale_history');
    assert.equal(h.sends().length, 1);
    s.dispose();
  });

  await pass('a different requestId while one is in flight is rejected', async () => {
    const h = createHarness(), s = service();
    const first = s.resend(h.io, { ...identity(), text: 'edited', requestId: 'first-request' });
    const second = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'second-request' });
    assert.equal(second.code, 'edit_in_progress');
    const result = await first;
    assert.equal(result.ok, true);
    s.dispose();
  });

  await pass('preflight reports edit_in_progress while a transaction owns the session', async () => {
    const h = createHarness(), s = service();
    const first = s.resend(h.io, { ...identity(), text: 'edited', requestId: 'preflight-busy' });
    const busy = await s.preflight(h.io, { userIndex: 1, kind: 'edit' });
    assert.equal(busy.ok, false);
    assert.equal(busy.code, 'edit_in_progress');
    assert.equal((await first).ok, true);
    const after = await s.preflight(h.io, { userIndex: 1, kind: 'edit' });
    assert.equal(after.ok, true, 'accepted transaction releases the preflight gate');
    s.dispose();
  });

  await pass('status is sanitized and does not contain message text', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { ...identity(), text: 'private body', requestId: 'status-request' });
    assert.equal(result.text, 'private body');
    const status = await s.status('status-request');
    assert.equal(status.state, 'accepted');
    assert.equal(Object.hasOwn(status.result, 'text'), false);
    assert.equal(JSON.stringify(status).includes('private body'), false);
    assert.equal((await s.status('missing-request')).state, 'unknown');
    s.dispose();
  });

  await pass('requestId from another native session cannot read the result', async () => {
    const h = createHarness(), s = service();
    await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'cross-session' });
    const other = createHarness({ sessionId: 'native-2' });
    const result = await s.resend(other.io, { ...identity({ expectedSessionId: 'native-2' }), text: 'edited', requestId: 'cross-session' });
    assert.equal(result.code, 'stale_session');
    s.dispose();
  });

  await pass('disposed service rejects new transactions', async () => {
    const h = createHarness(), s = service();
    s.dispose();
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'after-dispose' });
    assert.equal(result.code, 'unavailable');
    assert.equal(h.nav().length, 0);
  });

  await pass('navigation executed but its response was lost continues on the new path', async () => {
    const h = createHarness(), s = service();
    h.dropNavResponse = true;
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'nav-lost-ok' });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(h.nav().length, 1);
    assert.equal(h.sends().length, 1);
    assert.equal(h.leafId, result.newEntryId);
    s.dispose();
  });

  await pass('navigation not executed and its response was lost fails closed', async () => {
    const h = createHarness(), s = service();
    h.dropNavResponse = true;
    h.navNoop = true;
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'nav-lost-noop' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'pi_timeout');
    assert.equal(h.sends().length, 0);
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('navigation executed but readback failed enters recovery_pending and holds the lock', async () => {
    const h = createHarness(), s = service();
    h.dropNavResponse = true;
    h.entriesFailAfterNav = true;
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'nav-readback-fail' });
    assert.equal(result.ok, false);
    assert.equal(result.unresolved, true);
    assert.equal(result.state, 'recovery_pending');
    assert.equal(h.nav().length, 1);
    assert.equal(h.sends().length, 0);
    const blocked = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'nav-readback-blocked' });
    assert.equal(blocked.code, 'edit_in_progress');
    h.entriesFailAfterNav = false;
    const status = await s.status(h.io, 'nav-readback-fail');
    assert.equal(status.state, 'recovery_pending');
    const recovered = await s.recover(h.io, 'nav-readback-fail');
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.result.code, 'navigate_failed');
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('guard + lost nav response + failed readback still recovers the original path', async () => {
    const h = createHarness({ entries: [user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), user('u2', 'a1', 'second')], leafId: 'u2' });
    const s = service();
    h.dropNavResponse = true;
    h.entriesFailAfterNav = true;
    const result = await s.resend(h.io, {
      ...identity({ userIndex: 0, expectedEntryId: 'u1', expectedParentId: null, expectedLeafId: 'u2' }),
      text: 'changed first', requestId: 'guard-readback-fail',
    });
    assert.equal(result.unresolved, true);
    assert.equal(result.state, 'recovery_pending');
    assert.ok(h.guard, 'guard was appended before navigation');
    h.entriesFailAfterNav = false;
    const recovered = await s.recover(h.io, 'guard-readback-fail');
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.result.code, 'navigate_failed');
    assert.equal(recovered.result.restored, true);
    assert.equal(h.leafId, h.guard.id, 'restored to the guard; original path is intact');
    assert.equal(h.sends().length, 0);
    s.dispose();
  });

  await pass('guard + unexecuted nav + failed readback resolves without a restore command', async () => {
    const h = createHarness({ entries: [user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), user('u2', 'a1', 'second')], leafId: 'u2' });
    const s = service();
    h.dropNavResponse = true;
    h.navNoop = true;
    h.entriesFailAfterNav = true;
    const result = await s.resend(h.io, {
      ...identity({ userIndex: 0, expectedEntryId: 'u1', expectedParentId: null, expectedLeafId: 'u2' }),
      text: 'changed first', requestId: 'guard-readback-noop',
    });
    assert.equal(result.unresolved, true);
    assert.equal(result.state, 'recovery_pending');
    h.entriesFailAfterNav = false;
    const recovered = await s.recover(h.io, 'guard-readback-noop');
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.result.restored, true);
    assert.equal(h.leafId, h.guard.id);
    assert.equal(h.nav().length, 1, 'reconcile recognized the guard instead of issuing a restore');
    s.dispose();
  });

  await pass('a needed guard missing after successful readback converges to recovery_required', async () => {
    const h = createHarness({ entries: [user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), user('u2', 'a1', 'second')], leafId: 'u2' });
    h.guardNoop = true;
    const s = service();
    const result = await s.resend(h.io, {
      ...identity({ userIndex: 0, expectedEntryId: 'u1', expectedParentId: null, expectedLeafId: 'u2' }),
      text: 'changed first', requestId: 'guard-missing',
    });
    assert.equal(result.unresolved, true);
    assert.equal(result.state, 'recovery_pending');
    const recovered = await s.recover(h.io, 'guard-missing');
    assert.equal(recovered.state, 'recovery_required');
    assert.equal(recovered.result.code, 'restore_unavailable');
    assert.equal(h.sends().length, 0, 'no prompt was sent on the unconfirmed path');
    assert.equal(s.busyForSession('native-1'), false, 'an unrecoverable transaction releases its lock');
    const after = await s.preflight(h.io, { userIndex: 0, kind: 'edit' });
    assert.equal(after.code, 'unknown_user_message', 'the lock is gone; the empty active path has no editable target');
    s.dispose();
  });

  await pass('guard appended then navigation failed leaves the original path intact', async () => {
    const h = createHarness({ entries: [user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), user('u2', 'a1', 'second')], leafId: 'u2' });
    h.navNoop = true;
    const s = service();
    const result = await s.resend(h.io, { ...identity({ userIndex: 0, expectedEntryId: 'u1', expectedParentId: null, expectedLeafId: 'u2' }), text: 'changed first', requestId: 'guard-nav-fail' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'navigate_unverified');
    assert.equal(result.restored, true);
    assert.ok(h.guard);
    assert.equal(h.leafId, h.guard.id);
    assert.equal(h.sends().length, 0);
    s.dispose();
  });

  await pass('validation failure after navigation restores the old path', async () => {
    const h = createHarness(), s = service();
    h.validateAfterNav = true;
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'validate-after-nav' });
    assert.equal(result.ok, false);
    assert.equal(result.restored, true);
    assert.equal(h.sends().length, 0);
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('prompt accepted but its response was lost keeps the new path', async () => {
    const h = createHarness(), s = service();
    h.dropPromptResponse = true;
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'prompt-lost-ok' });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.newEntryId, h.lastPromptEntry.id);
    assert.equal(h.sends().length, 1);
    assert.equal(h.leafId, h.lastPromptEntry.id);
    s.dispose();
  });

  await pass('prompt explicitly rejected restores and is not reported as accepted', async () => {
    const h = createHarness(), s = service();
    h.rejectPrompt = true;
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'prompt-rejected-confirmed' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'prompt_rejected');
    assert.equal(result.restored, true);
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('prompt accepted then the run fails stays accepted and is not resent', async () => {
    const h = createHarness(), s = service();
    h.dropPromptResponse = true;
    h.onPrompt = () => { h.state.isStreaming = true; };
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'prompt-run-fails' });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(h.sends().length, 1);
    assert.equal(h.leafId, h.lastPromptEntry.id);
    s.dispose();
  });

  await pass('prompt accepted with lost response is confirmed by event evidence', async () => {
    const h = createHarness(), s = service();
    h.dropPromptResponse = true;
    h.entriesFailAfterPrompt = true;
    h.onPrompt = entry => {
      s.observe({ type: 'message_start', message: { role: 'user', id: entry.id, content: entry.message.content } }, 'native-1');
    };
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'prompt-event' });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.newEntryId, h.lastPromptEntry.id);
    assert.equal(h.sends().length, 1);
    s.dispose();
  });

  await pass('event evidence from another session is not claimed', async () => {
    const h = createHarness(), s = service();
    h.dropPromptResponse = true;
    h.entriesFailAfterPrompt = true;
    h.onPrompt = entry => {
      s.observe({ type: 'message_start', message: { role: 'user', id: entry.id, content: entry.message.content } }, 'native-2');
    };
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'prompt-event-other' });
    assert.equal(result.ok, false);
    assert.equal(result.unresolved, true);
    assert.equal(result.state, 'acceptance_unknown');
    s.dispose();
  });

  await pass('restore response lost but readback proves the old leaf', async () => {
    const h = createHarness(), s = service();
    h.rejectPrompt = true;
    h.dropRestoreResponse = true;
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'restore-lost-ok' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'prompt_rejected');
    assert.equal(result.restored, true);
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('restore unconfirmable enters recovery_pending and can be recovered later', async () => {
    const h = createHarness(), s = service();
    h.rejectPrompt = true;
    h.restoreNoop = true;
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'restore-unconfirmed' });
    assert.equal(result.ok, false);
    assert.equal(result.unresolved, true);
    assert.equal(result.state, 'recovery_pending');
    assert.equal(s.busyForSession('native-1'), true);
    h.restoreNoop = false;
    const recovered = await s.recover(h.io, 'restore-unconfirmed');
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.result.code, 'prompt_unconfirmed');
    assert.equal(h.leafId, 'a2');
    assert.equal(s.busyForSession('native-1'), false);
    s.dispose();
  });

  await pass('unresolved transactions are not removed by the status TTL', async () => {
    let clock = 0;
    const h = createHarness();
    h.dropNavResponse = true;
    h.entriesFailAfterNav = true;
    const s = service({ now: () => clock, statusTtlMs: 1 });
    const result = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'ttl-unresolved' });
    assert.equal(result.unresolved, true);
    clock = 10_000;
    const status = await s.status('ttl-unresolved');
    assert.equal(status.state, 'recovery_pending');
    assert.equal(s.busyForSession('native-1'), true);
    s.dispose();
  });

  await pass('status from another native session marks recovery_required and releases the lock', async () => {
    const h = createHarness();
    h.dropNavResponse = true;
    h.entriesFailAfterNav = true;
    const s = service();
    await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'cross-session-status' });
    const other = createHarness({ sessionId: 'native-2' });
    const status = await s.status(other.io, 'cross-session-status');
    assert.equal(status.state, 'stale_session');
    assert.equal(s.busyForSession('native-1'), false);
    s.dispose();
  });

  await pass('unresolved duplicate returns the unresolved state without sending again', async () => {
    const h = createHarness();
    h.dropNavResponse = true;
    h.entriesFailAfterNav = true;
    const s = service();
    await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'unresolved-duplicate' });
    const duplicate = await s.resend(h.io, { ...identity(), text: 'edited', requestId: 'unresolved-duplicate' });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.unresolved, true);
    assert.equal(h.nav().length, 1);
    assert.equal(h.sends().length, 0);
    s.dispose();
  });

  await pass('transaction lock blocks every history/identity/runtime command for its session only', async () => {
    const h = createHarness(), s = service();
    let releaseNav;
    const gate = new Promise(resolve => { releaseNav = resolve; });
    const inner = h.io.request;
    h.io.request = async cmd => {
      if (cmd.__messageEditNav === true) await gate;
      return inner(cmd);
    };
    const pending = s.resend(h.io, { ...identity(), text: 'edited', requestId: 'mutex-command-1' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(s.busy('native-1', 1), true);
    for (const type of ['prompt', 'steer', 'follow_up', 'new_session', 'switch_session', 'fork', 'compact',
      'set_session_name', 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level']) {
      assert.equal(s.blocksCommand('native-1', type, { bridgeRun: 1 }), true, type);
    }
    for (const type of ['get_state', 'get_messages', 'get_entries', 'get_tree', 'get_commands',
      'get_session_stats', 'get_available_models', 'get_available_thinking_levels', 'abort', 'extension_ui_response']) {
      assert.equal(s.blocksCommand('native-1', type, { bridgeRun: 1 }), false, type);
    }
    assert.equal(s.blocksCommand('native-2', 'prompt', { bridgeRun: 1 }), false, 'other session unaffected');
    assert.equal(s.blocksCommand('native-1', 'prompt', { bridgeRun: 2 }), false, 'other bridge generation unaffected');
    assert.equal(s.busyForSession('native-2'), false);
    assert.equal(s.busyForSession('native-1'), true);
    releaseNav();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(s.busy('native-1', 1), false);
    assert.equal(s.blocksCommand('native-1', 'prompt', { bridgeRun: 1 }), false);
    s.dispose();
  });

  console.log(`Message edit service: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
