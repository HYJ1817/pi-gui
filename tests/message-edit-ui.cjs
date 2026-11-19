/* 历史消息编辑 UI：共享动作条、就地编辑器、Runtime 时间线替换。
 *
 * 纯 jsdom 契约测试：不 spawn Pi、不联网、不写用户数据。真实排版、明暗主题、
 * 窄窗口与真实 Electron 里的点击链路由视觉验收夹具覆盖 —— jsdom 不做布局，
 * 这里只证明 DOM / 键盘 / IME / 忙闲状态与 store 的替换语义。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="stream" style="overflow:auto"><article id="host"></article></div><textarea id="input"></textarea></body></html>', { url: 'http://127.0.0.1/' });
  global.document = dom.window.document;
  global.window = dom.window;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.Event = dom.window.Event;
  global.KeyboardEvent = dom.window.KeyboardEvent;
  global.HTMLElement = dom.window.HTMLElement;
  global.sessionStorage = dom.window.sessionStorage;

  const { messageActions } = await import('../public/ui/message-actions.js');
  const {
    openMessageEditor,
    closeMessageEditor,
    messageEditorBusy,
    messageEditErrorText,
    resolveEditAcceptance,
    readPendingMessageEdit,
    rememberPendingMessageEdit,
    clearPendingMessageEdit,
    resumePendingMessageEdit,
  } = await import('../public/ui/message-edit.js');
  const { S } = await import('../public/state.js');
  const { messageEditStatus } = await import('../public/api.js');
  const { createRuntimeStore } = await import('../public/runtime-store.js');

  let checks = 0;
  const pass = async (name, fn) => {
    try { await fn(); checks++; console.log('PASS ' + name); }
    catch (error) { console.error('FAIL ' + name + ': ' + (error.stack || error.message)); throw error; }
  };
  const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (predicate, timeout = 1500) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await tick(5);
    }
    return predicate();
  };
  const keydown = (target, { key, isComposing = false, keyCode = 0 } = {}) => {
    const event = new dom.window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value: key });
    Object.defineProperty(event, 'isComposing', { value: isComposing });
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    target.dispatchEvent(event);
    return event;
  };

  /* ---------------- 动作条 ---------------- */
  await pass('copy-only message keeps the original action bar', () => {
    const bar = messageActions('hello');
    assert.equal(bar.hidden, false);
    assert.equal(bar.querySelectorAll('.message-action-btn').length, 1);
    assert.ok(bar.querySelector('.message-copy'));
    assert.equal(bar.querySelector('.message-edit'), null);
    assert.equal(bar.querySelector('.message-regenerate'), null);
  });

  await pass('edit action uses the existing icon set, tooltip and accessible name', () => {
    let clicked = 0;
    const bar = messageActions('hello', { onEdit: () => { clicked++; } });
    const button = bar.querySelector('.message-edit');
    assert.ok(button, 'edit button');
    assert.equal(button.title, '编辑并重新发送');
    assert.equal(button.getAttribute('aria-label'), '编辑并重新发送');
    assert.equal(button.type, 'button');
    assert.ok(button.querySelector('svg'), 'uses the existing icon markup');
    button.click();
    assert.equal(clicked, 1);
  });

  await pass('regenerate action is rendered with its own tooltip', () => {
    const bar = messageActions('', { onRegenerate: () => {} });
    const button = bar.querySelector('.message-regenerate');
    assert.ok(button);
    assert.equal(button.title, '重新生成');
    assert.equal(button.getAttribute('aria-label'), '重新生成');
    assert.equal(bar.hidden, false, 'image-only messages still get the action bar');
    assert.equal(bar.querySelector('.message-copy'), null);
  });

  await pass('disabled actions stay visible but cannot fire', () => {
    let clicked = 0;
    const bar = messageActions('hello', { onEdit: () => { clicked++; }, editDisabled: true, onRegenerate: () => {}, regenerateDisabled: true });
    const edit = bar.querySelector('.message-edit');
    const regenerate = bar.querySelector('.message-regenerate');
    assert.equal(edit.disabled, true);
    assert.equal(regenerate.disabled, true);
    edit.click();
    regenerate.click();
    assert.equal(clicked, 0);
  });

  await pass('action bar click does not bubble into the message', () => {
    let bubbled = 0;
    const host = document.createElement('div');
    host.addEventListener('click', () => { bubbled++; });
    host.append(messageActions('hello', { onEdit: () => {} }));
    host.querySelector('.message-edit').click();
    assert.equal(bubbled, 0);
  });

  /* ---------------- 就地编辑器 ---------------- */
  const makeEditor = async (overrides = {}) => {
    const host = document.getElementById('host');
    host.innerHTML = '<div class="msg user"><div class="body">old message</div></div>';
    const original = host.firstElementChild;
    const calls = { preflight: 0, resend: 0, accepted: null, recovered: null, closed: 0 };
    const options = {
      text: 'old message',
      kind: 'edit',
      userIndex: 0,
      hasImages: false,
      mount: host,
      originals: [original],
      preflight: async () => ({ ok: true, canEdit: true, sessionId: 'native-1', userIndex: 0, entryId: 'u1', parentId: null, leafId: 'a1', text: 'old message', hasImages: options.hasImages === true, hasToolsAfter: false }),
      resend: async () => ({ ok: true, userIndex: 0, kind: 'edit', text: 'old message', newEntryId: 'n1' }),
      readStatus: async () => ({ ok: true, state: 'unknown' }),
      onAccepted: result => { calls.accepted = result; },
      onRecovered: result => { calls.recovered = result; },
      onClose: () => { calls.closed++; },
      ...overrides,
    };
    const wrappedPreflight = async input => { calls.preflight++; return options.preflight(input); };
    const wrappedResend = async input => { calls.resend++; return options.resend(input); };
    const editor = openMessageEditor({ ...options, preflight: wrappedPreflight, resend: wrappedResend });
    await tick(10);
    return { editor, host, original, calls };
  };

  await pass('editor opens in place, prefilled, focused, and hides the original message', async () => {
    const { editor, host, original, calls } = await makeEditor();
    assert.ok(editor);
    const wrap = host.querySelector('.message-edit');
    assert.ok(wrap);
    assert.equal(wrap.getAttribute('role'), 'group');
    assert.equal(wrap.getAttribute('aria-label'), '编辑消息');
    const textarea = wrap.querySelector('textarea.message-edit-input');
    assert.equal(textarea.value, 'old message');
    assert.equal(original.hidden, true);
    assert.equal(document.activeElement, textarea, 'textarea is autofocused');
    assert.equal(wrap.querySelector('.message-edit-cancel').textContent, '取消');
    assert.equal(wrap.querySelector('.message-edit-submit').textContent, '重新发送');
    assert.ok(wrap.querySelector('.message-edit-cancel').classList.contains('ghost'));
    assert.ok(wrap.querySelector('.message-edit-submit').classList.contains('primary'));
    assert.equal(calls.preflight, 1, 'opening preflights once');
    editor.close();
    assert.equal(original.hidden, false);
    assert.equal(host.querySelector('.message-edit'), null);
  });

  await pass('Cancel restores the original message without sending', async () => {
    const { editor, host, original, calls } = await makeEditor();
    host.querySelector('.message-edit-cancel').click();
    assert.equal(host.querySelector('.message-edit'), null);
    assert.equal(original.hidden, false);
    assert.equal(calls.resend, 0);
    assert.equal(calls.closed, 1);
    assert.equal(editor.isClosed(), true);
  });

  await pass('Escape cancels, but not during Chinese IME composition', async () => {
    const { editor, host, original } = await makeEditor();
    const textarea = host.querySelector('.message-edit-input');
    textarea.value = '正在输入';
    textarea.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true }));
    keydown(textarea, { key: 'Escape' });
    assert.ok(host.querySelector('.message-edit'), 'Escape is ignored while composing');
    keydown(textarea, { key: 'Escape', isComposing: true });
    assert.ok(host.querySelector('.message-edit'), 'isComposing keydown is ignored');
    keydown(textarea, { key: 'Escape', keyCode: 229 });
    assert.ok(host.querySelector('.message-edit'), 'keyCode 229 is ignored');
    textarea.dispatchEvent(new dom.window.Event('compositionend', { bubbles: true }));
    keydown(textarea, { key: 'Escape' });
    assert.equal(host.querySelector('.message-edit'), null);
    assert.equal(original.hidden, false);
    assert.equal(editor.isClosed(), true);
  });

  await pass('blank text cannot be submitted', async () => {
    const { host, calls } = await makeEditor();
    const textarea = host.querySelector('.message-edit-input');
    textarea.value = '   \n  ';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const submit = host.querySelector('.message-edit-submit');
    assert.equal(submit.disabled, true);
    submit.click();
    await tick(10);
    assert.equal(calls.resend, 0);
    assert.ok(host.querySelector('.message-edit'), 'editor stays open');
  });

  await pass('image-only messages may clear the text and still submit', async () => {
    const { host, calls } = await makeEditor({ hasImages: true });
    const textarea = host.querySelector('.message-edit-input');
    textarea.value = '';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    host.querySelector('.message-edit-submit').click();
    assert.equal(await waitFor(() => calls.resend === 1), true);
    assert.equal(host.querySelector('.message-edit'), null);
  });

  await pass('submitting re-preflights, sends the edited text and closes on success', async () => {
    let sent = null;
    const { host, original, calls } = await makeEditor({
      resend: async input => { sent = input; return { ok: true, userIndex: input.userIndex, kind: 'edit', text: input.text, newEntryId: 'n1' }; },
    });
    const textarea = host.querySelector('.message-edit-input');
    textarea.value = 'edited text';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    host.querySelector('.message-edit-submit').click();
    assert.equal(await waitFor(() => calls.accepted !== null), true);
    assert.equal(sent.text, 'edited text');
    assert.equal(sent.expectedEntryId, 'u1');
    assert.equal(sent.expectedParentId, null);
    assert.equal(sent.expectedLeafId, 'a1');
    assert.equal(sent.expectedSessionId, 'native-1');
    assert.equal(sent.kind, 'edit');
    assert.match(sent.requestId, /^[A-Za-z0-9-]{8,64}$/);
    assert.equal(calls.preflight, 2, 'submit preflights again');
    assert.equal(host.querySelector('.message-edit'), null);
    assert.equal(original.hidden, false);
    assert.equal(calls.accepted.text, 'edited text');
  });

  await pass('submit verifies the first preflight target and never replaces it', async () => {
    let call = 0;
    let sent = null;
    const base = { ok: true, canEdit: true, sessionId: 'native-1', userIndex: 0, entryId: 'u1', parentId: null, leafId: 'a1', text: 'old message', hasImages: false };
    const moved = { ...base, entryId: 'u2', parentId: 'a1', leafId: 'a2' };
    const { host, calls } = await makeEditor({
      preflight: async () => (++call === 1 ? base : moved),
      resend: async input => { sent = input; return { ok: true, userIndex: input.userIndex, kind: 'edit', text: input.text, newEntryId: 'n1' }; },
    });
    const textarea = host.querySelector('.message-edit-input');
    textarea.value = 'edited text';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    host.querySelector('.message-edit-submit').click();
    const status = host.querySelector('.message-edit-status');
    assert.equal(await waitFor(() => status.dataset.state === 'error'), true);
    assert.equal(calls.resend, 0, 'a changed target is not silently adopted');
    assert.equal(sent, null);
    assert.match(status.textContent, /历史已经变化/);
    assert.equal(textarea.value, 'edited text');
    assert.ok(host.querySelector('.message-edit'), 'editor stays open');
  });

  await pass('first preflight must match the clicked message text', async () => {
    const { host, calls } = await makeEditor({
      preflight: async () => ({ ok: true, canEdit: true, sessionId: 'native-1', userIndex: 0, entryId: 'u1', parentId: null, leafId: 'a1', text: 'a different message', hasImages: false }),
    });
    const status = host.querySelector('.message-edit-status');
    assert.match(status.textContent, /历史已经变化/);
    assert.equal(host.querySelector('.message-edit-submit').disabled, true);
    host.querySelector('.message-edit-submit').click();
    await tick(10);
    assert.equal(calls.resend, 0);
  });

  await pass('a late first preflight is awaited before the transaction starts', async () => {
    let resolveFirst = null;
    let call = 0;
    let sent = null;
    const base = { ok: true, canEdit: true, sessionId: 'native-1', userIndex: 0, entryId: 'u1', parentId: null, leafId: 'a1', text: 'old message', hasImages: false };
    const first = new Promise(resolve => { resolveFirst = resolve; });
    const { host, calls } = await makeEditor({
      preflight: async () => (++call === 1 ? first : base),
      resend: async input => { sent = input; return { ok: true, userIndex: input.userIndex, kind: 'edit', text: input.text, newEntryId: 'n1' }; },
    });
    host.querySelector('.message-edit-submit').click();
    await tick(5);
    assert.equal(calls.resend, 0, 'submit waits for the locked target');
    resolveFirst(base);
    assert.equal(await waitFor(() => calls.resend === 1), true);
    assert.equal(sent.expectedEntryId, 'u1');
    assert.equal(sent.expectedSessionId, 'native-1');
    assert.equal(host.querySelector('.message-edit'), null);
  });

  await pass('a first preflight failure blocks submit instead of using the current index', async () => {
    const { host, calls } = await makeEditor({
      preflight: async () => ({ ok: false, code: 'pi_timeout' }),
    });
    host.querySelector('.message-edit-submit').click();
    const status = host.querySelector('.message-edit-status');
    assert.equal(await waitFor(() => /无法确认要编辑的原始消息/.test(status.textContent)), true);
    assert.equal(calls.resend, 0);
    assert.ok(host.querySelector('.message-edit'), 'editor stays open');
    assert.equal(host.querySelector('.message-edit-submit').disabled, true);
  });

  await pass('a preflight transport failure before resend is not an unresolved transaction', async () => {
    const base = { ok: true, canEdit: true, sessionId: 'native-1', userIndex: 0, entryId: 'u1', parentId: null, leafId: 'a1', text: 'old message', hasImages: false };
    let call = 0;
    const { editor, host, calls } = await makeEditor({
      preflight: async () => { call++; if (call === 2) throw new Error('network'); return base; },
    });
    const textarea = host.querySelector('.message-edit-input');
    textarea.value = 'edited';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    host.querySelector('.message-edit-submit').click();
    await tick(800);
    assert.equal(calls.resend, 0, 'resend was never attempted');
    assert.equal(host.querySelector('.message-edit-recover'), null, 'no recovery entry for a request the server never saw');
    assert.ok(host.querySelector('.message-edit'), 'editor stays open');
    host.querySelector('.message-edit-cancel').click();
    assert.equal(host.querySelector('.message-edit'), null, 'cancel still works');
    assert.equal(editor.isClosed(), true);
  });

  await pass('truncated runtime projections still lock the server-side target', async () => {
    const base = { ok: true, canEdit: true, sessionId: 'native-1', userIndex: 0, entryId: 'u1', parentId: null, leafId: 'a1', text: 'old message and more that the runtime timeline truncated', hasImages: true };
    const { host } = await makeEditor({ textTruncated: true, imageStateKnown: false, preflight: async () => base });
    assert.equal(host.querySelector('.message-edit-submit').disabled, false);
    assert.equal(host.querySelector('.message-edit-status').textContent, '');
  });

  await pass('an unresolved result offers a resync entry and recovers an accepted transaction', async () => {
    const { host, calls } = await makeEditor({
      resend: async () => ({ ok: false, code: 'acceptance_unknown', unresolved: true }),
      recover: async () => ({ ok: true, state: 'accepted', result: { ok: true, userIndex: 0, kind: 'edit', newEntryId: 'n1' } }),
    });
    host.querySelector('.message-edit-submit').click();
    const recover = await waitFor(() => host.querySelector('.message-edit-recover'));
    assert.equal(recover, true);
    assert.match(host.querySelector('.message-edit-status').textContent, /提交结果未确认/);
    host.querySelector('.message-edit-cancel').click();
    assert.ok(host.querySelector('.message-edit'), 'cancel does not lose the only recovery entry');
    host.querySelector('.message-edit-recover').click();
    assert.equal(await waitFor(() => calls.recovered !== null), true);
    assert.equal(host.querySelector('.message-edit'), null);
    assert.equal(calls.recovered.newEntryId, 'n1');
  });

  await pass('a failed recovery re-enables retry with the typed text intact', async () => {
    const { host, calls } = await makeEditor({
      resend: async () => ({ ok: false, code: 'acceptance_unknown', unresolved: true }),
      recover: async () => ({ ok: true, state: 'failed', result: { ok: false, code: 'prompt_unconfirmed' } }),
    });
    const textarea = host.querySelector('.message-edit-input');
    textarea.value = 'must survive recovery';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    host.querySelector('.message-edit-submit').click();
    assert.equal(await waitFor(() => host.querySelector('.message-edit-recover')), true);
    host.querySelector('.message-edit-recover').click();
    assert.equal(await waitFor(() => /没有接受/.test(host.querySelector('.message-edit-status').textContent)), true);
    assert.equal(textarea.value, 'must survive recovery');
    assert.equal(host.querySelector('.message-edit-submit').disabled, false);
    assert.ok(host.querySelector('.message-edit'));
    assert.equal(calls.accepted, null);
  });

  await pass('failure keeps the editor open with the typed text intact', async () => {
    const { host, calls } = await makeEditor({ resend: async () => ({ ok: false, code: 'stale_history' }) });
    const textarea = host.querySelector('.message-edit-input');
    textarea.value = 'text that must survive';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    host.querySelector('.message-edit-submit').click();
    const status = host.querySelector('.message-edit-status');
    assert.equal(await waitFor(() => status.dataset.state === 'error'), true);
    assert.equal(textarea.value, 'text that must survive');
    assert.ok(host.querySelector('.message-edit'), 'editor is still open');
    assert.match(status.textContent, /历史已经变化/);
    assert.equal(host.querySelector('.message-edit-submit').disabled, false, 'can retry');
    assert.equal(calls.accepted, null);
  });

  await pass('a second click while in flight does not send twice', async () => {
    let resolveResend = null;
    let resendCalls = 0;
    const { host, editor } = await makeEditor({
      resend: async () => {
        resendCalls++;
        return new Promise(resolve => { resolveResend = resolve; });
      },
    });
    const submit = host.querySelector('.message-edit-submit');
    submit.click();
    await waitFor(() => resendCalls === 1);
    assert.equal(messageEditorBusy(), true);
    submit.click();
    editor.submit();
    await tick(20);
    assert.equal(resendCalls, 1);
    assert.equal(submit.disabled, true);
    assert.equal(host.querySelector('.message-edit-cancel').disabled, true);
    assert.equal(host.querySelector('.message-edit-input').readOnly, true);
    assert.equal(openMessageEditor({ mount: host, originals: [], preflight: async () => ({ ok: true }), resend: async () => ({ ok: true }) }), null, 'a busy editor cannot be replaced');
    resolveResend({ ok: true, userIndex: 0, kind: 'edit', text: 'old message' });
    await waitFor(() => host.querySelector('.message-edit') === null);
  });

  await pass('preflight can block editing with the backend reason', async () => {
    const { host, calls } = await makeEditor({
      preflight: async () => ({ ok: true, canEdit: false, reason: 'session_streaming', sessionId: 'native-1', userIndex: 0, entryId: 'u1', parentId: null, leafId: 'a1', text: 'old message', hasImages: false }),
    });
    const status = host.querySelector('.message-edit-status');
    assert.match(status.textContent, /正在生成/);
    assert.equal(host.querySelector('.message-edit-submit').disabled, true);
    host.querySelector('.message-edit-submit').click();
    await tick(10);
    assert.equal(calls.resend, 0);
  });

  await pass('the tool/file warning appears only when replaced history contains actions', async () => {
    const withTools = await makeEditor({ preflight: async () => ({ ok: true, canEdit: true, sessionId: 'native-1', userIndex: 0, entryId: 'u1', parentId: null, leafId: 'a1', text: 'old message', hasImages: false, hasToolsAfter: true }) });
    const warning = withTools.host.querySelector('.message-edit-warning');
    assert.equal(warning.hidden, false);
    assert.equal(warning.textContent, '重新发送会替换后续对话，之前已经执行的文件修改和命令操作不会自动撤销。');
    withTools.editor.close();

    const withoutTools = await makeEditor();
    assert.equal(withoutTools.host.querySelector('.message-edit-warning').hidden, true);
    withoutTools.editor.close();
  });

  await pass('a lost response resolves through requestId instead of blind retry', async () => {
    const statuses = { 'request-x': { ok: true, state: 'unknown' } };
    const { host, calls } = await makeEditor({
      resend: async () => { throw new Error('socket closed'); },
      readStatus: async () => statuses['request-x'],
    });
    host.querySelector('.message-edit-submit').click();
    const status = host.querySelector('.message-edit-status');
    assert.equal(await waitFor(() => status.dataset.state === 'error', 3000), true);
    assert.match(status.textContent, /提交结果未确认/);
    assert.ok(host.querySelector('.message-edit'), 'editor stays open');
    assert.equal(host.querySelector('.message-edit-input').value, 'old message');
    assert.equal(calls.resend, 1);
  });

  await pass('a lost response that the backend accepted is treated as success', async () => {
    const { host, calls } = await makeEditor({
      resend: async () => { throw new Error('socket closed'); },
      readStatus: async () => ({ ok: true, state: 'accepted', result: { ok: true, userIndex: 0, kind: 'edit', text: 'old message', newEntryId: 'n1' } }),
    });
    host.querySelector('.message-edit-submit').click();
    assert.equal(await waitFor(() => calls.accepted !== null), true);
    assert.equal(host.querySelector('.message-edit'), null);
  });

  await pass('a lost response that the backend rejected is shown as failure', async () => {
    const { host, calls } = await makeEditor({
      resend: async () => { throw new Error('socket closed'); },
      readStatus: async () => ({ ok: true, state: 'failed', result: { ok: false, code: 'prompt_rejected' } }),
    });
    host.querySelector('.message-edit-submit').click();
    const status = host.querySelector('.message-edit-status');
    assert.equal(await waitFor(() => status.dataset.state === 'error'), true);
    assert.match(status.textContent, /已尝试恢复原对话/);
    assert.ok(host.querySelector('.message-edit'));
    assert.equal(calls.accepted, null);
  });

  await pass('status lookup carries the owner header after a renderer reconnect', async () => {
    const previousOwner = S.legacyOwner;
    const previousFetch = global.fetch;
    const requests = [];
    S.legacyOwner = { backendInstance: 'be-1', sessionId: 'native-1' };
    global.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      return { status: 200, json: async () => ({ ok: true, state: 'accepted' }) };
    };
    try {
      const result = await messageEditStatus('req-owner');
      assert.equal(result.state, 'accepted');
      assert.equal(requests.length, 1);
      assert.match(requests[0].url, /requestId=req-owner/);
      assert.deepEqual(requests[0].options.headers, { 'X-Pi-Gui-Owner': JSON.stringify(S.legacyOwner) });
    } finally {
      global.fetch = previousFetch;
      S.legacyOwner = previousOwner;
    }
  });

  await pass('an unresolved submit persists its requestId and a reopened editor offers recovery', async () => {
    clearPendingMessageEdit();
    const first = await makeEditor({
      resend: async () => ({ ok: false, unresolved: true, state: 'acceptance_unknown' }),
      recover: async () => ({ state: 'recovery_pending' }),
    });
    first.host.querySelector('.message-edit-input').value = 'edited after reload';
    first.host.querySelector('.message-edit-submit').click();
    assert.ok(await waitFor(() => first.host.querySelector('.message-edit-recover')));
    const record = readPendingMessageEdit();
    assert.ok(record, 'unresolved requestId is persisted');
    assert.equal(record.text, 'edited after reload');
    assert.equal(record.scope.sessionId, 'native-1');
    assert.ok(record.requestId);
    first.editor.close({ restore: true });

    const second = await makeEditor({
      preflight: async () => ({ ok: false, code: 'edit_in_progress' }),
      recover: async requestId => {
        assert.equal(requestId, record.requestId);
        return { state: 'accepted', result: { ok: true, userIndex: 0, kind: 'edit', text: 'edited after reload', newEntryId: 'n1' } };
      },
    });
    const recover = second.host.querySelector('.message-edit-recover');
    assert.ok(recover, 'reopened editor exposes the persisted transaction');
    assert.equal(second.host.querySelector('.message-edit-input').value, 'edited after reload');
    recover.click();
    assert.equal(await waitFor(() => second.calls.recovered !== null), true);
    assert.equal(second.host.querySelector('.message-edit'), null);
    assert.equal(readPendingMessageEdit(), null, 'accepted recovery clears the persisted record');
  });

  await pass('the real Runtime preflight shape also reconnects the persisted transaction', async () => {
    clearPendingMessageEdit();
    rememberPendingMessageEdit({
      requestId: 'runtime-shape-1',
      text: 'persisted runtime text',
      userIndex: 0,
      kind: 'edit',
      scope: { kind: 'runtime', conversationId: 'conv-1', sessionId: 'native-1', backendInstance: 'be-1' },
    });
    const editor = await makeEditor({
      pendingScope: { kind: 'runtime', conversationId: 'conv-1', backendInstance: 'be-1' },
      /* Runtime 的 busyReason 走 canEdit:false + reason，而不是 ok:false code。
       * 测试必须用后端真实会返回的形状，否则“刷新后接回”只是 mock 的巧合。 */
      preflight: async () => ({
        ok: true, canEdit: false, reason: 'edit_in_progress',
        sessionId: 'native-1', userIndex: 0, entryId: 'u1', parentId: null, leafId: 'a1',
        text: 'old message', hasImages: false, hasToolsAfter: false,
      }),
      recover: async requestId => {
        assert.equal(requestId, 'runtime-shape-1');
        return { state: 'accepted', result: { ok: true, userIndex: 0, kind: 'edit', text: 'persisted runtime text', newEntryId: 'n3' } };
      },
    });
    const recover = editor.host.querySelector('.message-edit-recover');
    assert.ok(recover, 'canEdit:false must expose the persisted requestId, not just a blocked message');
    assert.equal(editor.host.querySelector('.message-edit-input').value, 'persisted runtime text');
    recover.click();
    assert.equal(await waitFor(() => editor.calls.recovered !== null), true);
    assert.equal(readPendingMessageEdit(), null, 'accepted recovery clears the persisted record');
  });

  await pass('a busy preflight on a different message still exposes the session recovery handle', async () => {
    clearPendingMessageEdit();
    rememberPendingMessageEdit({
      requestId: 'other-message-1', text: 'text for A', userIndex: 0, kind: 'edit',
      scope: { kind: 'classic', sessionId: 'native-1', backendInstance: 'be-1' },
    });
    const editor = await makeEditor({
      userIndex: 1,
      pendingScope: { kind: 'classic', backendInstance: 'be-1' },
      preflight: async () => ({ ok: false, code: 'edit_in_progress' }),
      recover: async () => ({ state: 'recovery_pending' }),
    });
    assert.ok(editor.host.querySelector('.message-edit-recover'), 'the lock is session-wide, not message-local');
    assert.equal(editor.host.querySelector('.message-edit-input').value, 'old message',
      'another message\'s edited text must not be injected into this editor');
    assert.equal(readPendingMessageEdit({ kind: 'classic' })?.requestId, 'other-message-1',
      'the record survives while the lock is unresolved');
    editor.editor.close({ restore: true });
    clearPendingMessageEdit();
  });

  await pass('an unknown requestId releases the editor instead of locking it forever', async () => {
    clearPendingMessageEdit();
    rememberPendingMessageEdit({
      requestId: 'unknown-1', text: 'persisted', userIndex: 0, kind: 'edit',
      scope: { kind: 'classic', sessionId: 'native-1', backendInstance: 'be-1' },
    });
    const editor = await makeEditor({
      pendingScope: { kind: 'classic', backendInstance: 'be-1' },
      preflight: async () => ({ ok: false, code: 'edit_in_progress' }),
      recover: async () => ({ ok: true, state: 'unknown' }),
    });
    const recover = editor.host.querySelector('.message-edit-recover');
    assert.ok(recover, 'the persisted handle is shown');
    recover.click();
    assert.equal(await waitFor(() => readPendingMessageEdit() === null), true);
    assert.equal(editor.host.querySelector('.message-edit-submit').disabled, false,
      'submit is usable again once the backend proves there is no transaction');
    editor.host.querySelector('.message-edit-cancel').click();
    assert.equal(editor.host.querySelector('.message-edit'), null, 'the editor can be closed');
  });

  await pass('pending records for different conversations do not overwrite each other', async () => {
    clearPendingMessageEdit();
    rememberPendingMessageEdit({
      requestId: 'classic-1', text: 'c', userIndex: 0, kind: 'edit',
      scope: { kind: 'classic', sessionId: 'native-1', backendInstance: 'be-1' },
    });
    rememberPendingMessageEdit({
      requestId: 'runtime-1', text: 'r', userIndex: 0, kind: 'edit',
      scope: { kind: 'runtime', conversationId: 'conv-1', sessionId: 'native-1', backendInstance: 'be-1' },
    });
    assert.equal(readPendingMessageEdit({ kind: 'classic' })?.requestId, 'classic-1');
    assert.equal(readPendingMessageEdit({ kind: 'runtime', conversationId: 'conv-1' })?.requestId, 'runtime-1');
    assert.equal(readPendingMessageEdit({ kind: 'runtime', conversationId: 'conv-2' }), null);
    const resumed = await resumePendingMessageEdit({
      scope: { kind: 'runtime', conversationId: 'conv-1', backendInstance: 'be-1' },
      status: async () => ({ state: 'accepted', result: { ok: true } }),
    });
    assert.equal(resumed.state, 'accepted');
    assert.equal(readPendingMessageEdit({ kind: 'runtime', conversationId: 'conv-1' }), null);
    assert.equal(readPendingMessageEdit({ kind: 'classic' })?.requestId, 'classic-1',
      'another conversation keeps its recovery handle');
    clearPendingMessageEdit();
  });

  await pass('a successful preflight only clears the record for the same native session', async () => {
    clearPendingMessageEdit();
    rememberPendingMessageEdit({ requestId: 'other-session-1', text: 'x', userIndex: 0, scope: { kind: 'classic', sessionId: 'other-session' } });
    const first = await makeEditor();
    assert.equal(readPendingMessageEdit()?.requestId, 'other-session-1', 'another session keeps its recovery handle');
    first.editor.close({ restore: true });

    rememberPendingMessageEdit({ requestId: 'same-session-1', text: 'x', userIndex: 0, scope: { kind: 'classic', sessionId: 'native-1' } });
    const second = await makeEditor();
    assert.equal(readPendingMessageEdit({ kind: 'classic', sessionId: 'native-1' }), null, 'the same session clears the stale record');
    assert.equal(readPendingMessageEdit({ kind: 'classic', sessionId: 'other-session' })?.requestId, 'other-session-1',
      'the other session record is not a single shared slot');
    second.editor.close({ restore: true });
    clearPendingMessageEdit();
  });

  await pass('resumePendingMessageEdit settles accepted/failed and drops records from an older backend', async () => {
    clearPendingMessageEdit();
    rememberPendingMessageEdit({ requestId: 'be-old-1', text: 'x', userIndex: 0, scope: { kind: 'classic', sessionId: 'native-1', backendInstance: 'be-1' } });
    const stale = await resumePendingMessageEdit({ scope: { kind: 'classic', sessionId: 'native-1', backendInstance: 'be-2' }, status: async () => ({ state: 'accepted' }) });
    assert.equal(stale.state, 'stale');
    assert.equal(readPendingMessageEdit(), null, 'an older backend instance cannot own the transaction');

    rememberPendingMessageEdit({ requestId: 'resume-1', text: 'x', userIndex: 0, scope: { kind: 'classic', sessionId: 'native-1', backendInstance: 'be-2' } });
    const pending = await resumePendingMessageEdit({ scope: { kind: 'classic', sessionId: 'native-1', backendInstance: 'be-2' }, status: async () => ({ state: 'recovery_pending' }) });
    assert.equal(pending.state, 'recovery_pending');
    assert.equal(readPendingMessageEdit()?.requestId, 'resume-1', 'unresolved keeps the record');

    let settled = null;
    const accepted = await resumePendingMessageEdit({
      scope: { kind: 'classic', sessionId: 'native-1', backendInstance: 'be-2' },
      status: async () => ({ state: 'accepted', result: { ok: true, userIndex: 0, kind: 'edit', text: 'x', newEntryId: 'n9' } }),
      onSettled: (result, record) => { settled = { result, record }; },
    });
    assert.equal(accepted.state, 'accepted');
    assert.equal(settled.result.newEntryId, 'n9');
    assert.equal(settled.record.requestId, 'resume-1');
    assert.equal(readPendingMessageEdit(), null);

    rememberPendingMessageEdit({ requestId: 'resume-2', text: 'x', userIndex: 0, scope: { kind: 'classic', sessionId: 'native-1', backendInstance: 'be-2' } });
    const failed = await resumePendingMessageEdit({ scope: { kind: 'classic', sessionId: 'native-1', backendInstance: 'be-2' }, status: async () => ({ state: 'failed', result: { ok: false, code: 'prompt_rejected' } }) });
    assert.equal(failed.state, 'failed');
    assert.equal(readPendingMessageEdit(), null);
  });

  await pass('resolveEditAcceptance polls until the backend settles', async () => {
    const replies = [{ ok: true, state: 'unknown' }, { ok: true, state: 'accepted', result: { ok: true, newEntryId: 'n1' } }];
    let calls = 0;
    const accepted = await resolveEditAcceptance(async () => replies[Math.min(calls++, replies.length - 1)], 'request-y', { attempts: 3, delayMs: 1 });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.duplicate, true);
    assert.equal(accepted.newEntryId, 'n1');

    const failed = await resolveEditAcceptance(async () => ({ ok: true, state: 'failed', result: { ok: false, code: 'stale_history' } }), 'request-z', { attempts: 3, delayMs: 1 });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'stale_history');

    const unknown = await resolveEditAcceptance(async () => ({ ok: true, state: 'unknown' }), 'request-u', { attempts: 2, delayMs: 1 });
    assert.equal(unknown, null);
    assert.equal(await resolveEditAcceptance(null, 'request-u'), null);
    assert.equal(await resolveEditAcceptance(async () => ({ ok: true, state: 'accepted' }), ''), null);
  });

  await pass('editor does not touch the composer draft or scroll position', async () => {
    const input = document.getElementById('input');
    const stream = document.getElementById('stream');
    input.value = 'unsent draft';
    stream.scrollTop = 120;
    const { editor, host } = await makeEditor();
    assert.equal(input.value, 'unsent draft');
    assert.equal(stream.scrollTop, 120);
    host.querySelector('.message-edit-input').value = 'changed';
    host.querySelector('.message-edit-input').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(input.value, 'unsent draft');
    assert.equal(stream.scrollTop, 120);
    editor.close();
    assert.equal(input.value, 'unsent draft');
    assert.equal(stream.scrollTop, 120);
  });

  await pass('openMessageEditor rejects incomplete options and reports no active editor', () => {
    assert.equal(openMessageEditor({ mount: document.body, originals: [], preflight: async () => ({ ok: true }) }), null);
    assert.equal(messageEditorBusy(), false);
    assert.equal(typeof messageEditErrorText('stale_history'), 'string');
    assert.match(messageEditErrorText('stale_history'), /历史/);
    closeMessageEditor();
  });

  /* ---------------- Runtime store：就地替换 ---------------- */
  const makeStore = () => {
    const store = createRuntimeStore();
    const owner = { backendInstance: 'b1', conversationId: 'c1', runtimeId: 'r1', runtimeGeneration: 1, sessionId: 's1' };
    const item = { conversationId: 'c1', owner, revision: 1 };
    assert.equal(store.seed({ backendInstance: 'b1', items: [item] }), true);
    assert.equal(store.history('c1', [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ], owner, 0), true);
    return { store, owner };
  };
  const event = (owner, sequence, value) => ({ type: 'runtime_event', owner, eventSequence: sequence, event: value });

  await pass('runtime pending edit replaces the target in place, never appends a duplicate', async () => {
    const { store, owner } = makeStore();
    const pending = store.beginUserEdit('c1', owner, 0);
    assert.ok(pending);
    assert.equal(store.apply(event(owner, 1, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'edited question' }] } })), true);
    const timeline = store.get('c1').timeline;
    assert.equal(timeline.filter(block => block.kind === 'user').length, 1);
    assert.equal(timeline.find(block => block.kind === 'user').text, 'edited question');
    assert.equal(timeline.some(block => block.kind === 'assistant' && block.text === 'old answer'), false, 'old reply left the timeline');
    assert.equal(store.get('c1').pendingEdit.eventApplied, true);
  });

  await pass('a late HTTP apply does not remove blocks from the new run', async () => {
    const { store, owner } = makeStore();
    const pending = store.beginUserEdit('c1', owner, 0);
    store.apply(event(owner, 1, { type: 'message_start', message: { role: 'assistant', content: [] } }));
    store.apply(event(owner, 2, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'new answer' } }));
    assert.equal(store.applyUserEdit('c1', owner, pending, { text: 'edited question', entryId: 'entry-1' }), true);
    const timeline = store.get('c1').timeline;
    assert.equal(timeline.filter(block => block.kind === 'user').length, 1);
    assert.equal(timeline.find(block => block.kind === 'user').text, 'edited question');
    assert.equal(timeline.find(block => block.kind === 'user').messageId, 'entry-1');
    assert.equal(timeline.some(block => block.kind === 'assistant' && block.text === 'new answer'), true, 'new run block survives');
    assert.equal(timeline.some(block => block.kind === 'assistant' && block.text === 'old answer'), false);
  });

  await pass('pending edit is bound to the owner and can be cancelled', async () => {
    const { store, owner } = makeStore();
    const pending = store.beginUserEdit('c1', owner, 0);
    assert.equal(store.beginUserEdit('c1', { ...owner, runtimeGeneration: 2 }, 0), null, 'other generation cannot begin');
    assert.equal(store.applyUserEdit('c1', { ...owner, runtimeGeneration: 2 }, pending, { text: 'x' }), false);
    assert.equal(store.cancelUserEdit('c1', owner, pending), true);
    assert.equal(store.get('c1').pendingEdit, null);
    assert.equal(store.applyUserEdit('c1', owner, pending, { text: 'x' }), false, 'cancelled pending cannot apply');
  });

  await pass('settled clears a pending edit left by an interrupted run', async () => {
    const { store, owner } = makeStore();
    store.beginUserEdit('c1', owner, 0);
    store.apply(event(owner, 1, { type: 'agent_settled' }));
    assert.equal(store.get('c1').pendingEdit, null);
  });

  /* ---------------- 样式契约 ---------------- */
  await pass('editor CSS reuses design tokens and the existing action-bar reveal', () => {
    const css = fs.readFileSync(path.join(__dirname, '../public/message-edit.css'), 'utf8');
    assert.match(css, /\.message-edit\s*\{/);
    assert.match(css, /var\(--ds-bg-secondary\)/);
    assert.match(css, /var\(--ds-focus\)/);
    assert.match(css, /\.message-edit-input:focus/);
    assert.match(css, /\.message-edit-warning\[hidden\]/);
    assert.match(css, /#runtimeView \.rtc-timeline-message/);
    assert.match(css, /:focus-within/);
    assert.equal(/--ds-[a-z-]+\s*:/.test(css), false, 'no new theme tokens are defined here');
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, 'no hard-coded colors');
  });

  console.log(`Message edit UI: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
