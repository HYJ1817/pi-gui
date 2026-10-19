// Remaining October review defects. Production modules, offline/TEMP fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const pause = ms => new Promise(r => setTimeout(r, ms));
function docx(xml) {
  const name = Buffer.from('word/document.xml'), body = Buffer.from(xml);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(zlib.crc32(body), 14);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(zlib.crc32(body), 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
  const start = local.length + name.length + body.length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(start, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}
(async () => {
  let passed = 0, failed = 0;
  const check = async (label, fn) => { try { await fn(); passed++; console.log('PASS ' + label); } catch (e) { failed++; console.error('FAIL ' + label + ': ' + e.stack); } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-review-regressions-'));
  const { extractDocx } = await import('../lib/extract.js');
  const { readSessionMessages } = await import('../server/session-history.js');
  try {
    for (const [label, xml, text] of [
      ['tabs and soft breaks', '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>', 'A\tB\nC'],
      ['runs, paragraphs and entities', '<w:p><w:r><w:t>A&amp;B</w:t></w:r><w:r><w:tab /><w:t>&lt;w:br/&gt;</w:t><w:br w:type="textWrapping"/><w:t>C</w:t></w:r></w:p><w:p><w:r><w:t>D&#x1f600;</w:t></w:r></w:p>', 'A&B\t<w:br/>\nC\nD😀'],
    ]) await check('DOCX preserves ' + label, () => assert.equal(extractDocx(docx(xml)).text, text));
    for (const count of [799, 800, 805]) await check('history keeps latest 800 of ' + count + ' and exact truncation', () => {
      const file = path.join(root, 'history-' + count + '.jsonl');
      fs.writeFileSync(file, [JSON.stringify({ type: 'session', id: 's' }), ...Array.from({ length: count }, (_, i) => JSON.stringify({ type: 'message', id: 'm-' + i, message: { role: 'user', content: [{ type: 'text', text: 'turn-' + i }] } }))].join('\n') + '\n');
      const result = readSessionMessages(file);
      assert.equal(result.ok, true); assert.equal(result.messages.length, Math.min(count, 800));
      assert.equal(result.messages[0].text, 'turn-' + Math.max(0, count - 800));
      assert.equal(result.messages.at(-1).text, 'turn-' + (count - 1));
      assert.equal(result.truncated, count > 800);
    });
    await check('history tail byte limit keeps final messages and never invents absolute turn indices', () => {
      const file = path.join(root, 'byte-tail.jsonl');
      fs.writeFileSync(file, [JSON.stringify({ type: 'session', id: 's' }), ...Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: 'message', id: 'm-' + i, message: { role: 'user', content: [{ type: 'text', text: '中文'.repeat(20) + i }] } }))].join('\n') + '\n');
      const result = readSessionMessages(file, { maxBytes: 1000, maxMessages: 3 });
      assert.equal(result.messages.length, 3); assert.ok(result.messages.at(-1).text.endsWith('19'));
      assert.equal(result.truncated, true); assert.equal(result.messages[0].userIndex, null);
      assert.equal(result.messages.at(-1).messageId, 'm-19');
    });
    await check('message cap preserves search turn indices across empty user and assistant messages', () => {
      const file = path.join(root, 'indices.jsonl');
      const message = (id, role, text) => JSON.stringify({ type: 'message', id, message: { role, content: [{ type: 'text', text }] } });
      fs.writeFileSync(file, [JSON.stringify({ type: 'session' }), message('empty', 'user', ''), message('u1', 'user', 'first'), message('a1', 'assistant', 'answer'), message('u2', 'user', 'second')].join('\n'));
      const result = readSessionMessages(file, { maxMessages: 2 });
      assert.deepEqual(result.messages.map(m => [m.messageId, m.userIndex]), [['a1', 1], ['u2', 2]]);
    });

    const classic = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://fixture.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = classic.window;
    w.eval(bundle(path.join(__dirname, '../public/rpc.js')).code);
    Object.assign(w.S, { hasProject: true, bridgeState: 'ready', switching: false, submitting: false, modelSwitchPending: false, fallbackActive: false, stopping: false, streaming: true, attachments: [], cwd: root, state: { sessionId: 'A', model: { input: ['text', 'image'] } } });
    w.S.localUsage.sessionId = 'A';
    const input = w.document.getElementById('input'), send = w.document.getElementById('btnSend');
    let commands = [];
    w.fetch = async (_url, opts = {}) => ({ json: async () => { if (opts.body) commands.push(JSON.parse(opts.body)); return { ok: true }; } });
    await check('loading attachments disable button and direct/keyboard submit without clearing draft', async () => {
      input.value = 'unsent'; w.S.attachments = [{ id: 'pending', name: 'slow.docx', loading: true, kind: 'unknown' }];
      w.updateSendState(); assert.equal(send.disabled, true);
      await w.submit(); assert.equal(commands.length, 0); assert.equal(input.value, 'unsent'); assert.equal(w.S.attachments.length, 1);
    });
    await check('direct submit cannot bypass pending attachment guard', async () => {
      commands = []; input.value = 'keep direct draft'; w.S.attachments = [{ id: 'pending-direct', name: 'pending.pdf', loading: true }];
      await w.submit(); assert.equal(commands.length, 0); assert.equal(input.value, 'keep direct draft'); assert.equal(w.S.attachments.length, 1);
    });
    await check('image FileReader stage blocks submission before upload starts', async () => {
      w.S.attachments = []; input.value = 'image question'; let reader, finish;
      const OriginalReader = w.FileReader;
      w.FileReader = class { constructor() { reader = this; } readAsDataURL() {} };
      w.fetch = async () => ({ json: () => new Promise(r => { finish = r; }) });
      const upload = w.handleFiles([new w.File(['image'], 'image.png', { type: 'image/png' })]);
      try {
        assert.equal(w.S.attachments.length, 1); assert.equal(send.disabled, true);
      } finally {
        reader.result = 'data:image/png;base64,YQ=='; reader.onload(); await tick();
        finish({ ok: true, kind: 'image', id: 'image-ready' }); await upload; w.FileReader = OriginalReader;
      }
    });
    await check('actual upload completion restores sending with parsed content', async () => {
      commands = []; w.S.attachments = []; input.value = 'question';
      let resolve;
      w.fetch = async (_url, opts = {}) => ({ json: async () => {
        if (String(_url).startsWith('/api/upload')) return new Promise(r => { resolve = r; });
        commands.push(JSON.parse(opts.body)); return { ok: true };
      } });
      const upload = w.handleFiles([new w.File(['body'], 'slow.docx')]); await tick();
      assert.equal(send.disabled, true); await w.submit(); assert.equal(commands.length, 0);
      resolve({ ok: true, id: 'ready', name: 'slow.docx', kind: 'text', text: 'parsed body', chars: 11 }); await upload;
      assert.equal(send.disabled, false); await w.submit(); assert.equal(commands.length, 1); assert.ok(commands[0].message.includes('parsed body'));
    });
    await check('failed parse is distinct from loading and remains explicitly sendable', async () => {
      commands = []; w.fetch = async (_url, opts) => ({ json: async () => { commands.push(JSON.parse(opts.body)); return { ok: true }; } });
      w.S.attachments = [{ id: 'failed', name: 'bad.pdf', loading: false, error: 'parse failed', kind: 'binary', path: path.join(root, 'bad.pdf') }];
      input.value = 'explain'; w.updateSendState(); assert.equal(send.disabled, false); await w.submit();
      assert.equal(commands.length, 1); assert.ok(commands[0].message.includes('parse failed'));
    });
    for (const delayed of [false, true]) await check('classic applyState isolates A/B drafts ' + (delayed ? 'before debounce' : 'after debounce'), async () => {
      w.resetDraftState(); w.localStorage.clear(); w.S.state = { sessionId: 'A' }; w.S.localUsage.sessionId = 'A'; input.value = ''; w.initDraft();
      const keyA = w.draftKey(); w.writeDraftText(w.draftKey(w.workspaceHash(), w.hashKey('B')), 'B saved draft');
      input.value = 'A unfinished draft'; input.dispatchEvent(new w.Event('input'));
      if (!delayed) await pause(450);
      w.applyState({ sessionId: 'B', isStreaming: false });
      assert.equal(input.value, 'B saved draft'); assert.equal(w.readDraftText(keyA), 'A unfinished draft');
      input.value = 'B edited draft'; input.dispatchEvent(new w.Event('input'));
      w.applyState({ sessionId: 'A', isStreaming: false });
      assert.equal(input.value, 'A unfinished draft');
      w.applyState({ sessionId: 'B', isStreaming: false }); assert.equal(input.value, 'B edited draft');
      await pause(450); assert.equal(w.readDraftText(keyA), 'A unfinished draft');
    });
    await check('classic identity switch retains unsent text when storage write is denied', async () => {
      w.resetDraftState(); w.localStorage.clear(); w.S.state = { sessionId: 'A' }; w.S.localUsage.sessionId = 'A'; input.value = ''; w.initDraft();
      const setItem = w.Storage.prototype.setItem;
      try {
        w.Storage.prototype.setItem = () => { throw Error('fixture quota denied'); };
        input.value = 'A draft despite storage denial'; input.dispatchEvent(new w.Event('input'));
        w.applyState({ sessionId: 'B', isStreaming: false }); assert.equal(input.value, '');
        input.value = 'B independent draft'; input.dispatchEvent(new w.Event('input'));
        w.applyState({ sessionId: 'A', isStreaming: false }); assert.equal(input.value, 'A draft despite storage denial');
        w.applyState({ sessionId: 'B', isStreaming: false }); assert.equal(input.value, 'B independent draft');
      } finally { w.Storage.prototype.setItem = setItem; w.resetDraftState(); }
    });
    w.resetDraftState(); classic.window.close();

    const dom = new JSDOM('<div id="host"></div><div id="modal" hidden><div id="modalCard"></div></div><div id="confirmLayer" hidden><div id="confirmCard"></div></div><div id="toasts"></div>', { url: 'http://fixture.invalid/' });
    global.window = dom.window; global.document = dom.window.document; global.localStorage = dom.window.localStorage;
    const { runtimeStore: store, seedRuntimeSnapshot, observeRuntimeFrame, respondToRuntimeApproval } = await import('../public/runtime-state.js');
    const { createRuntimeConversation } = await import('../public/runtime-conversation.js');
    const { openRuntimeSessions } = await import('../public/runtime-sessions.js');
    const { closeModal } = await import('../public/ui/modal.js');
    const owner = gen => ({ backendInstance: 'fixture', projectId: 'p', repoId: 'r', workspaceId: 'w', workspaceEpoch: 'e', conversationId: 'A', runtimeId: 'rt', runtimeGeneration: gen, sessionId: 's' });
    const item = (gen = null, revision = 1) => ({ conversationId: 'A', owner: gen ? owner(gen) : null, workspace: { branch: 'A', projectId: 'p' }, lifecycle: gen ? 'ready' : 'dormant', activity: 'idle', revision });
    const reset = records => { store.seed({ backendInstance: 'reset-' + Math.random(), items: [] }); seedRuntimeSnapshot({ ok: true, backendInstance: 'fixture', items: records }); };
    const btn = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text);
    await check('approval native-owner enrichment during submission releases only the old pending marker', async () => {
      const oldOwner = { ...owner('one'), sessionId: '' }; reset([{ ...item('one'), owner: oldOwner }]);
      observeRuntimeFrame({ type: 'runtime_event', owner: oldOwner, eventSequence: 1, event: { type: 'extension_ui_request', id: 'binding', method: 'confirm', title: 'binding' } });
      const approval = store.get('A').approvals[0]; let finish;
      const pending = respondToRuntimeApproval(oldOwner, approval, () => new Promise(r => { finish = r; }));
      seedRuntimeSnapshot({ ok: true, backendInstance: 'fixture', items: [item('one', 2)] });
      finish({ ok: true }); await pending;
      assert.equal(store.get('A').approvals.length, 1, 'old owner success cannot consume current owner request');
      assert.notEqual(approval.submitting, true, 'owner binding must not leave controls permanently pending');
    });
    await check('history reload after resume/new messages/close never reuses stale body', async () => {
      reset([item()]); let reads = 0;
      global.fetch = async (url, opts = {}) => ({ json: async () => opts.body ? { ok: true } : String(url).includes('conversationId=') ? { ok: true, messages: [{ role: 'user', text: 'history-' + (++reads) }] } : { ok: true, backendInstance: 'fixture', items: [store.get('A').item] } });
      const host = document.getElementById('host'), view = createRuntimeConversation({ host });
      try {
        view.show('A'); btn(host, '打开历史').click(); await tick(); assert.ok(host.textContent.includes('history-1'));
        seedRuntimeSnapshot({ ok: true, backendInstance: 'fixture', items: [item('one', 2)] });
        observeRuntimeFrame({ type: 'runtime_event', owner: owner('one'), eventSequence: 1, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'new body' } } });
        seedRuntimeSnapshot({ ok: true, backendInstance: 'fixture', items: [item(null, 3)] });
        btn(host, '打开历史').click(); await tick(); assert.equal(reads, 2); assert.ok(host.textContent.includes('history-2')); assert.ok(!host.textContent.includes('history-1'));
      } finally { view.dispose(); }
    });
    await check('late history response cannot reopen old history after runtime identity changes', async () => {
      reset([item()]); let resolve;
      global.fetch = async () => ({ json: () => new Promise(r => { resolve = r; }) });
      const host = document.getElementById('host'), view = createRuntimeConversation({ host });
      try {
        view.show('A'); btn(host, '打开历史').click(); await tick();
        seedRuntimeSnapshot({ ok: true, backendInstance: 'fixture', items: [item('two', 2)] });
        resolve({ ok: true, messages: [{ role: 'user', text: 'stale history' }] }); await tick();
        assert.ok(!host.textContent.includes('stale history')); assert.equal(host.querySelector('textarea').disabled, false);
      } finally { view.dispose(); }
    });
    await check('resume acknowledgement invalidates in-flight history before lifecycle SSE arrives', async () => {
      reset([item()]); let resolve;
      global.fetch = async (url, opts = {}) => ({ json: async () => opts.body ? { ok: true } : String(url).includes('conversationId=')
        ? new Promise(r => { resolve = r; }) : { ok: true, backendInstance: 'fixture', items: [item()] } });
      const host = document.getElementById('host'), view = createRuntimeConversation({ host });
      try {
        view.show('A'); btn(host, '打开历史').click(); await tick(); btn(host, '恢复会话').click(); await tick();
        resolve({ ok: true, messages: [{ role: 'user', text: 'before resume' }] }); await tick();
        assert.ok(!host.textContent.includes('before resume'));
      } finally { view.dispose(); }
    });
    for (const byId of [false, true]) await check('history search locates retained message by ' + (byId ? 'native ID with byte-tail unknown index' : 'absolute user index after cap'), async () => {
      const locator = { conversationId: 'A', nativeSessionId: 's', projectId: 'p', workspaceId: 'w', workspaceEpoch: 'e' };
      const record = { ...item(), nativeSessionId: 's', workspace: { projectId: 'p', workspaceId: 'w', workspaceEpoch: 'e' } }; reset([record]);
      global.fetch = async () => ({ json: async () => ({ ok: true, locator, truncated: true, messages: [
        { role: 'user', text: 'last retained question', userIndex: byId ? null : 804, messageId: 'target-id' },
      ] }) });
      let scrolled = '';
      dom.window.HTMLElement.prototype.scrollIntoView = function() { scrolled = this.textContent; };
      const host = document.getElementById('host'), view = createRuntimeConversation({ host });
      try {
        await view.openHistory(locator, { userIndex: 804, ...(byId ? { messageId: 'target-id' } : {}) });
        assert.ok(scrolled.includes('last retained question'));
        if (byId) assert.equal(host.querySelector('[data-history-user-index]'), null);
      } finally { view.dispose(); delete dom.window.HTMLElement.prototype.scrollIntoView; }
    });
    for (const surface of ['central', 'modal']) for (const result of ['success', 'failure', 'owner change']) await check(surface + ' approval ' + result + ': settles only captured request; failure retries', async () => {
      let records = [item('one')], finish, calls = 0; reset(records);
      global.fetch = async (_url, opts = {}) => ({ json: async () => {
        if (!opts.body) return { ok: true, backendInstance: 'fixture', items: records };
        const body = JSON.parse(opts.body);
        if (body.command?.type === 'extension_ui_response') { calls++; return new Promise(r => { finish = r; }); }
        return { ok: true, data: { messages: [] } };
      } });
      const host = document.getElementById(surface === 'central' ? 'host' : 'modalCard'); let view;
      try {
        if (surface === 'central') { view = createRuntimeConversation({ host }); view.show('A'); }
        else { openRuntimeSessions({}); await tick(); host.querySelector('[data-conversation-id="A"]').click(); await tick(); }
        const approval = (id, seq, gen = 'one') => observeRuntimeFrame({ type: 'runtime_event', owner: owner(gen), eventSequence: seq, event: { type: 'extension_ui_request', id, method: 'confirm', title: id } });
        approval('first', 1); approval('second', 2);
        const captured = btn(host, '确认'); captured.click(); await tick(); assert.equal(calls, 1);
        assert.equal(captured.disabled, true, 'pending control must be disabled'); captured.click(); await tick(); assert.equal(calls, 1);
        if (result === 'owner change') { records = [item('two', 2)]; seedRuntimeSnapshot({ ok: true, backendInstance: 'fixture', items: records }); approval('first', 1, 'two'); }
        finish({ ok: result !== 'failure', error: 'fixture failure' }); await tick();
        if (result === 'success') { assert.deepEqual(store.get('A').approvals.map(a => a.id), ['second']); captured.click(); await tick(); assert.equal(calls, 1); }
        else { assert.ok(host.querySelector('.runtime-approval,.rtc-approval')); assert.equal(btn(host, '确认').disabled, false); if (result === 'failure') assert.equal(store.get('A').approvals.length, 2); }
      } finally { if (view) view.dispose(); else closeModal(); await tick(); }
    });
    await check('shared approval blocks duplicate across central/modal and survives sender disposal', async () => {
      const records = [item('one')]; reset(records); let finish, calls = 0;
      global.fetch = async (_url, opts = {}) => ({ json: async () => {
        if (!opts.body) return { ok: true, backendInstance: 'fixture', items: records };
        const body = JSON.parse(opts.body);
        if (body.command?.type === 'extension_ui_response') { calls++; return new Promise(r => { finish = r; }); }
        return { ok: true, data: { messages: [] } };
      } });
      const host = document.getElementById('host'), view = createRuntimeConversation({ host }); view.show('A');
      openRuntimeSessions({}); await tick(); document.querySelector('[data-conversation-id="A"]').click(); await tick();
      observeRuntimeFrame({ type: 'runtime_event', owner: owner('one'), eventSequence: 1, event: { type: 'extension_ui_request', id: 'shared', method: 'confirm', title: 'Shared' } });
      try {
        const capturedModal = btn(document.getElementById('modalCard'), '确认');
        btn(host, '确认').click(); await tick(); capturedModal.click(); await tick(); assert.equal(calls, 1);
        assert.equal(btn(document.getElementById('modalCard'), '确认').disabled, true);
        view.dispose(); finish({ ok: true }); await tick(); assert.equal(store.get('A').approvals.length, 0);
        assert.equal(btn(document.getElementById('modalCard'), '确认'), undefined);
      } finally { view.dispose(); closeModal(); await tick(); }
    });
    for (const surface of ['central', 'modal']) await check(surface + ' responding to one approval preserves another approval input', async () => {
      const records = [item('one')]; reset(records); let finish;
      global.fetch = async (_url, opts = {}) => ({ json: async () => {
        if (!opts.body) return { ok: true, backendInstance: 'fixture', items: records };
        const body = JSON.parse(opts.body);
        if (body.command?.type === 'extension_ui_response') return new Promise(r => { finish = r; });
        return { ok: true, data: { messages: [] } };
      } });
      const host = document.getElementById(surface === 'central' ? 'host' : 'modalCard'); let view;
      try {
        if (surface === 'central') { view = createRuntimeConversation({ host }); view.show('A'); }
        else { openRuntimeSessions({}); await tick(); host.querySelector('[data-conversation-id="A"]').click(); await tick(); }
        for (const [id, method, sequence] of [['first', 'confirm', 1], ['second', 'input', 2]]) observeRuntimeFrame({ type: 'runtime_event', owner: owner('one'), eventSequence: sequence, event: { type: 'extension_ui_request', id, method, title: id } });
        host.querySelector('[aria-label="second"]').value = 'Unsubmitted approval input';
        btn(host, '确认').click(); await tick();
        assert.equal(host.querySelector('[aria-label="second"]').value, 'Unsubmitted approval input');
        finish({ ok: true }); await tick();
        assert.equal(host.querySelector('[aria-label="second"]').value, 'Unsubmitted approval input');
      } finally { if (view) view.dispose(); else closeModal(); await tick(); }
    });
    for (const surface of ['central', 'modal']) await check(surface + ' approval captures enriched native owner instead of retaining stale controls', async () => {
      let records = [{ ...item('one'), owner: { ...owner('one'), sessionId: '' } }], calls = []; reset(records);
      global.fetch = async (_url, opts = {}) => ({ json: async () => {
        if (!opts.body) return { ok: true, backendInstance: 'fixture', items: records };
        const body = JSON.parse(opts.body); calls.push(body); return { ok: true, data: { messages: [] } };
      } });
      const host = document.getElementById(surface === 'central' ? 'host' : 'modalCard'); let view;
      try {
        if (surface === 'central') { view = createRuntimeConversation({ host }); view.show('A'); }
        else { openRuntimeSessions({}); await tick(); host.querySelector('[data-conversation-id="A"]').click(); await tick(); }
        observeRuntimeFrame({ type: 'runtime_event', owner: records[0].owner, eventSequence: 1, event: { type: 'extension_ui_request', id: 'enriched', method: 'confirm', title: 'enriched' } });
        records = [item('one', 2)]; seedRuntimeSnapshot({ ok: true, backendInstance: 'fixture', items: records });
        btn(host, '确认').click(); await tick();
        assert.equal(calls.filter(c => c.command?.type === 'extension_ui_response' && c.owner.sessionId === 's').length, 1);
      } finally { if (view) view.dispose(); else closeModal(); await tick(); }
    });
    dom.window.close();
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  console.log(`Review regressions: ${passed}/${passed + failed}; failed=${failed}; skipped=0`); process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
