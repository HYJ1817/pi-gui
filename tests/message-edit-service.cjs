/* 历史消息编辑事务：用假的 RPC 会话验证状态机、身份核对与回滚。
 *
 * 这里不 spawn Pi。假会话只实现事务用到的 5 条命令（get_state / get_entries /
 * get_commands / 导航 prompt / 重发 prompt），并像 Pi 一样在导航时移动 leaf、
 * 在旧 leaf 是用户消息时追加 guard entry。真实 Pi 的验收在独立测试里。
 */
'use strict';
const assert = require('node:assert/strict');

const text = value => [{ type: 'text', text: value }];
const message = (id, parentId, role, content, timestamp = 1) => ({ type: 'message', id, parentId, message: { role, content }, timestamp });
const user = (id, parentId, value, extra = []) => message(id, parentId, 'user', [...text(value), ...extra]);
const assistant = (id, parentId, value) => message(id, parentId, 'assistant', text(value));

function createHarness(options = {}) {
  const entries = options.entries || [user('u1', null, 'first'), assistant('a1', 'u1', 'reply first'), user('u2', 'a1', 'second'), assistant('a2', 'u2', 'reply second')];
  const leafId = options.leafId ?? 'a2';
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
    leafId,
    state,
    calls,
    stale: false,
    navNoop: false,
    rejectPrompt: false,
    handledPrompt: false,
    guard: null,
    nav() { return calls.filter(call => call.__messageEditNav === true); },
    sends() { return calls.filter(call => call.type === 'prompt' && call.__messageEditNav !== true); },
  };

  function appendGuard(requestId) {
    const oldLeaf = entries.find(entry => entry.id === harness.leafId) || null;
    if (!oldLeaf || !(oldLeaf.type === 'custom_message' || oldLeaf.type === 'message' && oldLeaf.message?.role === 'user')) return null;
    const guard = { type: 'custom', id: 'guard-' + (++seq), parentId: oldLeaf.id, customType: 'pi-gui-edit-guard', data: { requestId } };
    entries.push(guard);
    harness.leafId = guard.id;
    harness.guard = guard;
    return guard;
  }

  harness.io = {
    scope: 'classic',
    sessionId: state.sessionId,
    commandName: () => 'edit-cmd',
    busyReason: () => options.busyReason?.() || null,
    validate() {
      if (harness.stale) throw Object.assign(Error('stale_runtime'), { code: 'stale_runtime' });
    },
    async request(cmd) {
      calls.push({ ...cmd });
      if (cmd.type === 'get_state') return { ok: true, data: { ...state } };
      if (cmd.type === 'get_entries') return { ok: true, data: { entries: entries.slice(), leafId: harness.leafId } };
      if (cmd.type === 'get_commands') return { ok: true, data: { commands: options.commands || [{ name: 'edit-cmd' }, { name: 'help' }] } };
      if (cmd.type !== 'prompt') return { ok: false, code: 'invalid_request' };

      if (cmd.__messageEditNav === true) {
        const match = /^\/(\S+) (\S+) (\S+)$/.exec(String(cmd.message || ''));
        if (!match) return { ok: true, data: { disposition: 'handled' } };
        const [, name, targetId, requestId] = match;
        if (name !== 'edit-cmd') return { ok: true, data: { disposition: 'handled' } };
        const target = entries.find(entry => entry.id === targetId);
        if (!target) return { ok: true, data: { disposition: 'handled' } };
        appendGuard(requestId);
        if (!harness.navNoop) {
          const targetIsEditable = target.type === 'message' && target.message?.role === 'user';
          harness.leafId = targetIsEditable ? (target.parentId ?? null) : target.id;
        }
        return { ok: true, data: { disposition: 'handled' } };
      }

      if (harness.rejectPrompt) return { ok: true, data: { disposition: 'rejected' } };
      if (harness.handledPrompt) return { ok: true, data: { disposition: 'handled' } };
      const content = [{ type: 'text', text: cmd.message }, ...(cmd.images || [])];
      const entry = message('new-' + (++seq), harness.leafId, 'user', content, 2);
      entries.push(entry);
      harness.leafId = entry.id;
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
  const service = () => createMessageEditService({ pollTimeoutMs: 200, pollIntervalMs: 5 });

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
      const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'changed', requestId: 'request-' + field });
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
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'changed', requestId: 'no-command' });
    assert.equal(result.code, 'navigate_unavailable');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('edit navigates to the target parent then sends the edited text', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'edited second', expectedEntryId: 'u2', expectedLeafId: 'a2', requestId: 'edit-one' });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.sessionId, 'native-1');
    assert.equal(result.targetEntryId, 'u2');
    assert.equal(result.targetParentId, 'a1');
    assert.equal(result.newEntryId, 'new-1');
    assert.equal(result.text, 'edited second');
    assert.equal(h.nav().length, 1);
    assert.equal(h.sends().length, 1);
    assert.equal(h.nav()[0].message, '/edit-cmd u2 edit-one');
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
    const result = await s.resend(h.io, { userIndex: 0, kind: 'edit', text: 'first edited', requestId: 'edit-image' });
    assert.equal(result.ok, true);
    assert.equal(result.imagesPreserved, 1);
    assert.deepEqual(h.sends()[0].images, [image]);
    s.dispose();
  });

  await pass('unsupported attachment parts are rejected before navigation', async () => {
    const file = { type: 'file', path: '/tmp/secret.txt' };
    const h = createHarness({ entries: [user('u1', null, 'first', [file]), assistant('a1', 'u1', 'reply')], leafId: 'a1' });
    const s = service();
    const result = await s.resend(h.io, { userIndex: 0, kind: 'edit', text: 'changed', requestId: 'edit-file' });
    assert.equal(result.code, 'attachments_unsupported');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('regenerate uses the target text, never caller-supplied text', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { userIndex: 1, kind: 'regenerate', text: 'ignored', requestId: 'regen-one' });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'regenerate');
    assert.equal(h.sends()[0].message, 'second');
    assert.equal(result.text, 'second');
    s.dispose();
  });

  await pass('expected entry id mismatch is stale and does not navigate', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'changed', expectedEntryId: 'u1', requestId: 'stale-entry' });
    assert.equal(result.code, 'stale_history');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('expected leaf mismatch is stale and does not navigate', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'changed', expectedEntryId: 'u2', expectedLeafId: 'a1', requestId: 'stale-leaf' });
    assert.equal(result.code, 'stale_history');
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
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'changed', requestId: 'stale-runtime' });
    assert.equal(result.code, 'stale_runtime');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('blank text and oversized text are rejected', async () => {
    const h = createHarness(), s = service();
    assert.equal((await s.resend(h.io, { userIndex: 1, kind: 'edit', text: '   ', requestId: 'empty-text' })).code, 'empty_message');
    assert.equal((await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'x'.repeat(1_000_001), requestId: 'huge-text' })).code, 'message_too_large');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('registered command text is rejected instead of being dispatched', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: '/help me', requestId: 'command-text' });
    assert.equal(result.code, 'command_text_conflict');
    assert.equal(result.command, 'help');
    assert.equal(h.nav().length, 0);
    s.dispose();
  });

  await pass('a navigation that does not move the leaf is restored and reported', async () => {
    const h = createHarness(), s = service();
    h.navNoop = true;
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'changed', requestId: 'nav-noop' });
    assert.equal(result.code, 'navigate_unverified');
    assert.equal(h.sends().length, 0);
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('a rejected prompt restores the old assistant leaf', async () => {
    const h = createHarness(), s = service();
    h.rejectPrompt = true;
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'changed', requestId: 'reject-prompt' });
    assert.equal(result.code, 'prompt_rejected');
    assert.equal(h.sends().length, 1);
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('a handled prompt restores the old assistant leaf', async () => {
    const h = createHarness(), s = service();
    h.handledPrompt = true;
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'changed', requestId: 'handled-prompt' });
    assert.equal(result.code, 'prompt_handled');
    assert.equal(h.leafId, 'a2');
    s.dispose();
  });

  await pass('a user leaf is guarded and restored exactly on failure', async () => {
    const h = createHarness({ entries: [user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), user('u2', 'a1', 'second')], leafId: 'u2' });
    h.rejectPrompt = true;
    const s = service();
    const result = await s.resend(h.io, { userIndex: 0, kind: 'edit', text: 'changed first', requestId: 'guard-restore' });
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
    const result = await s.resend(h.io, { userIndex: 0, kind: 'edit', text: 'changed', requestId: 'custom-guard' });
    assert.equal(result.code, 'prompt_rejected');
    assert.ok(h.guard);
    assert.equal(h.leafId, h.guard.id);
    s.dispose();
  });

  await pass('duplicate requestId is idempotent and does not send twice', async () => {
    const h = createHarness(), s = service();
    const first = s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'edited', requestId: 'same-request' });
    const second = s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'edited', requestId: 'same-request' });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(h.nav().length, 1);
    assert.equal(h.sends().length, 1);
    const third = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'edited', requestId: 'same-request' });
    assert.equal(third.duplicate, true);
    assert.equal(h.sends().length, 1);
    s.dispose();
  });

  await pass('a different requestId while one is in flight is rejected', async () => {
    const h = createHarness(), s = service();
    const first = s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'edited', requestId: 'first-request' });
    const second = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'edited', requestId: 'second-request' });
    assert.equal(second.code, 'edit_in_progress');
    const result = await first;
    assert.equal(result.ok, true);
    s.dispose();
  });

  await pass('status is sanitized and does not contain message text', async () => {
    const h = createHarness(), s = service();
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'private body', requestId: 'status-request' });
    assert.equal(result.text, 'private body');
    const status = s.status('status-request');
    assert.equal(status.state, 'accepted');
    assert.equal(Object.hasOwn(status.result, 'text'), false);
    assert.equal(JSON.stringify(status).includes('private body'), false);
    assert.equal(s.status('missing-request').state, 'unknown');
    s.dispose();
  });

  await pass('requestId from another native session cannot read the result', async () => {
    const h = createHarness(), s = service();
    await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'edited', requestId: 'cross-session' });
    const other = createHarness({ sessionId: 'native-2' });
    const result = await s.resend(other.io, { userIndex: 1, kind: 'edit', text: 'edited', requestId: 'cross-session' });
    assert.equal(result.code, 'stale_session');
    s.dispose();
  });

  await pass('disposed service rejects new transactions', async () => {
    const h = createHarness(), s = service();
    s.dispose();
    const result = await s.resend(h.io, { userIndex: 1, kind: 'edit', text: 'edited', requestId: 'after-dispose' });
    assert.equal(result.code, 'unavailable');
    assert.equal(h.nav().length, 0);
  });

  console.log(`Message edit service: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
