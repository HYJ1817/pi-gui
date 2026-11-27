'use strict';
// Ordinary branch/clone/edit authorization. No real Pi, model or Electron.
// Production renderer/API/HTTP/Store proof, not pixel layout or sandbox proof.
// Every write is in os.tmpdir(); HTTP is authenticated process-local loopback.
//
// Native fixture contract read ONLY from Pi 1.6.0 (never imported by tests):
// dist/core/session-manager.js:706-722 (v3 header),742-751 (restore leaf),
// 848-856 (nested message),1182-1194 (memory-only branch/resetLeaf),
// 1226-1305 (fork/clone keeps entries, new header.id and parentSession).
// dist/core/agent-session.js:3473-3507 (edit moves before the user entry).
// dist/modes/rpc/rpc-mode.js:501-511,517-531 (fork/clone/native read shapes).
const { test } = require('node:test');
const strict = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, waitFor, loaded, entry, text, digest } = require('./fixtures/html-artifact-branches-fixture.cjs');
let assertions = 0;
const assert = new Proxy(strict, { get(target, key) {
  const value = target[key];
  return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value;
} });

async function edit(surface, mode, native, userIndex) {
  const owner = mode === 'runtime' ? surface.w.runtimeStore.get('runtime-inherited').owner : null;
  const preflight = mode === 'classic' ? await surface.w.messageEditPreflight({ userIndex })
    : await surface.w.runtimeEditPreflight(owner, { userIndex });
  assert.equal(preflight.ok, true); assert.equal(preflight.canEdit, true);
  const input = { requestId: 'branches-edit-' + mode, userIndex, kind: 'edit', text: 'edited question offline',
    expectedSessionId: preflight.sessionId, expectedEntryId: preflight.entryId,
    expectedParentId: preflight.parentId, expectedLeafId: preflight.leafId };
  const response = mode === 'classic' ? await surface.w.messageEditResend(input)
    : await surface.w.runtimeEditResend(owner, input);
  assert.equal(response.ok, true); assert.equal(response.sessionId, native.sessionId);
  assert.equal(native.rows.at(-1).message.role, 'user');
  assert.equal(native.rows.at(-1).parentId, preflight.parentId);
  assert.deepEqual(native.rows.at(-1).message.content, text(input.text));
  assert.equal(native.calls.filter(call => call.type === 'prompt').length, 2, 'one navigation and one offline prompt append');
  return response;
}

test('HTML artifact branch/copy/edit production read chains', async t => {
  for (const mode of ['classic', 'runtime']) {
    await t.test(mode + ': native fork inherits an immutable original-session reference through the production viewer', async sub => {
      const w = await fixture(sub, assert), inherited = w.source.fork('40000001');
      const scope = w.bind(mode, inherited), surface = w.surface(mode);
      assert.notEqual(inherited.sessionId, w.artifacts[0].sessionId);
      assert.equal(inherited.header.parentSession, w.source.file);
      const before = w.snapshots();
      await surface.hydrate(inherited); await loaded(surface, [w.artifacts[0]], assert);
      assert.equal(surface.document.querySelectorAll('.html-artifact').length, 1);
      assert.deepEqual(surface.reads[0].request.scope, scope, 'authorize the displayed branch, never the snapshot session');
      assert.equal(surface.reads[0].body.artifact.sessionId, w.source.sessionId);
      assert.deepEqual(w.snapshots(), before, 'opening an inherited artifact never republishes or mutates identity');
      assert.equal((mode === 'classic' ? surface.document.querySelector('.thread') : surface.host).textContent.includes('BRANCH_EARLY'), false);
    });

    await t.test(mode + ': clone keeps multiple original entries and bytes after source session deletion', async sub => {
      const w = await fixture(sub, assert), copy = w.source.fork();
      w.bind(mode, copy);
      const originalText = fs.readFileSync(w.source.file, 'utf8');
      const list = await w.sessions.list(w.cwd), sourceId = list.sessions.find(item => item.sessionId === w.source.sessionId).id;
      // The production soft-delete route must see another current Classic session.
      w.classic = copy;
      const deletion = await w.request('/api/sessions/delete', { id: sourceId });
      assert.equal(deletion.status, 200); assert.equal(deletion.body.ok, true);
      assert.equal(fs.existsSync(w.source.file), false);
      const trash = path.join(w.data, 'trash-sessions', w.source.sessionId + '.jsonl');
      assert.equal(fs.readFileSync(trash, 'utf8'), originalText);
      const surface = w.surface(mode);
      await surface.hydrate(copy); await loaded(surface, w.artifacts, assert);
      assert.deepEqual(surface.reads.map(read => read.body.artifact.id).sort(), w.artifacts.map(ref => ref.id).sort());
      for (let index = 0; index < w.artifacts.length; index++) {
        const snapshot = await w.store.read(w.artifacts[index].id);
        assert.equal(snapshot.html, w.html[index]);
        assert.equal(snapshot.artifact.sessionId, w.source.sessionId);
      }
      assert.equal(w.snapshots().length, 2);
      assert.equal(copy.calls.some(call => call.type === 'prompt'), false, 'clone recovery does not re-run a tool or model');
    });

    await t.test(mode + ': real edit-resend transaction preserves earlier HTML and revokes the abandoned reply', async sub => {
      const w = await fixture(sub, assert), inherited = w.source.fork();
      const scope = w.bind(mode, inherited), surface = w.surface(mode);
      await surface.hydrate(inherited); await loaded(surface, w.artifacts, assert);
      const before = fs.readFileSync(inherited.file), physicalCount = inherited.rows.length;
      await edit(surface, mode, inherited, 1);
      assert.equal(inherited.rows.length, physicalCount + 1);
      assert.equal(fs.readFileSync(inherited.file).subarray(0, before.length).equals(before), true, 'old append-only bytes remain intact');
      assert.ok(inherited.rows.some(row => row.id === w.artifacts[1].messageId));
      assert.equal((await w.read(w.artifacts[0], scope)).status, 200);
      const denied = await w.read(w.artifacts[1], scope);
      assert.equal(denied.status, 409); assert.deepEqual(denied.body, { ok: false, code: 'reference_pending' });
      assert.equal((await w.store.read(w.artifacts[1].id)).html, w.html[1], 'revocation is branch-specific, never snapshot deletion');
      surface.clear(); await surface.hydrate(inherited); await loaded(surface, [w.artifacts[0]], assert);
      assert.equal(surface.document.querySelectorAll('.html-artifact').length, 1);
      assert.equal(surface.document.querySelector(`[data-artifact-id="${w.artifacts[1].id}"]`), null);
      assert.equal(surface.releases.length, 2, 'old branch viewers release their registrations');
    });

    await t.test(mode + ': live branch switches use the memory leaf, not the physical JSONL tail', async sub => {
      const w = await fixture(sub, assert), copy = w.source.fork();
      const scope = w.bind(mode, copy), surface = w.surface(mode);
      const bytes = fs.readFileSync(copy.file), oldLeaf = copy.leafId;
      copy.branch('40000001');
      assert.equal(w.readHtmlArtifactSession(copy.file).leafId, oldLeaf, 'dormant restoration has a deliberately different leaf');
      assert.equal(fs.readFileSync(copy.file).equals(bytes), true);
      await surface.hydrate(copy); await loaded(surface, [w.artifacts[0]], assert);
      assert.equal((await w.read(w.artifacts[1], scope)).body.code, 'reference_pending');
      surface.clear(); copy.branch(oldLeaf); await surface.hydrate(copy); await loaded(surface, w.artifacts, assert);
      assert.equal((await w.read(w.artifacts[1], scope)).status, 200);
      assert.equal(fs.readFileSync(copy.file).equals(bytes), true);
      assert.deepEqual(w.snapshots(), w.artifacts.map(ref => ref.id).sort());
    });

    await t.test(mode + ': inherited read is revoked when the native branch changes during storage IO', async sub => {
      const w = await fixture(sub, assert), copy = w.source.fork();
      const scope = w.bind(mode, copy), originalLeaf = copy.leafId;
      w.readHook = () => { copy.branch('10000001'); w.readHook = null; };
      const stale = await w.read(w.artifacts[0], scope);
      assert.equal(stale.status, 409); assert.deepEqual(stale.body, { ok: false, code: 'reference_pending' });
      assert.equal(Object.hasOwn(stale.body, 'html'), false);
      copy.branch(originalLeaf);
      const restored = await w.read(w.artifacts[0], scope);
      assert.equal(restored.status, 200); assert.equal(restored.body.html, w.html[0]);
      assert.deepEqual(restored.body.artifact, w.artifacts[0]);
    });

    await t.test(mode + ': a foreign session cannot use a known ID or copied result without matching native call identity', async sub => {
      const w = await fixture(sub, assert);
      const foreign = new w.Native([
        entry('f0000001', null, 'user', text('unrelated session')),
        entry('f0000002', 'f0000001', 'assistant', [{ type: 'toolCall', id: w.artifacts[0].toolCallId, name: 'html_render', arguments: {} }]),
        // Even a persisted typed result cannot grant a different assistant identity.
        entry('f0000003', 'f0000002', 'toolResult', text('copied reference'), {
          toolName: 'html_render', toolCallId: w.artifacts[0].toolCallId,
          details: { kind: 'html_artifact', schemaVersion: 1, ok: true, artifact: w.artifacts[0] } }),
      ]);
      const scope = w.bind(mode, foreign), surface = w.surface(mode);
      const denied = await w.read(w.artifacts[0], scope);
      assert.equal(denied.status, 409); assert.deepEqual(denied.body, { ok: false, code: 'reference_pending' });
      await surface.hydrate(foreign);
      await waitFor(() => surface.document.querySelector('.html-artifact')?.dataset.state === 'error', 'foreign native reference denied by actual HTTP');
      assert.equal(surface.reads.length, 4, 'bounded pending retries do not turn a foreign ID into authorization');
      assert.ok(surface.reads.every(read => read.status === 409 && read.body.code === 'reference_pending' && !Object.hasOwn(read.body, 'html')));
      assert.equal(surface.document.querySelector('.html-artifact iframe'), null);
      assert.equal(surface.document.body.textContent.includes('BRANCH_EARLY'), false);
      assert.equal((await w.store.read(w.artifacts[0].id)).html, w.html[0]);
    });
  }
  await t.test('Classic historical list ID restores inherited bytes without equating native session IDs', async sub => {
    const w = await fixture(sub, assert), inherited = w.source.fork('40000001');
    const surface = w.surface('classic');
    const list = await surface.w.fetchSessions(w.cwd);
    const listed = list.sessions.find(item => item.sessionId === inherited.sessionId);
    assert.match(listed.id, /^[a-f0-9]{16}$/);
    assert.notEqual(listed.id, inherited.sessionId);
    assert.notEqual(inherited.sessionId, w.artifacts[0].sessionId);
    const history = await surface.w.fetchSessionHistory(listed.id, w.cwd);
    assert.equal(history.ok, true);
    const ref = history.execution.timeline.find(block => block.kind === 'html_artifact').artifact;
    assert.deepEqual(ref, w.artifacts[0]);
    // The production Classic read-only navigation currently displays text only.
    // Exercise its separate supported historical scope using the shared viewer;
    // do not pretend messages.js can render a non-active Classic session scope.
    const viewer = surface.w.createHtmlArtifactViewer(ref, { scope: { sessionId: listed.id } });
    surface.document.body.append(viewer.node); viewer.mount();
    await loaded(surface, [ref], assert);
    assert.deepEqual(surface.reads[0].request.scope, { sessionId: listed.id });
    for (const id of [inherited.sessionId, w.source.sessionId]) {
      const response = await w.read(ref, { sessionId: id });
      assert.equal(response.status, 400); assert.deepEqual(response.body, { ok: false, code: 'invalid_request' });
    }
    viewer.dispose();
    const unrelated = new w.Native([entry('f0000001', null, 'user', text('unrelated historical native session'))]);
    const other = (await w.sessions.list(w.cwd)).sessions.find(item => item.sessionId === unrelated.sessionId);
    assert.equal((await w.read(ref, { sessionId: other.id })).body.code, 'reference_pending');
  });

  await t.test('dormant Runtime restores inherited history after original deletion with ownerless scoped reads', async sub => {
    const w = await fixture(sub, assert), inherited = w.source.fork();
    const locator = w.retire('history-inherited', inherited);
    w.classic = new w.Native();
    const original = (await w.sessions.list(w.cwd)).sessions.find(item => item.sessionId === w.source.sessionId);
    const deletion = await w.request('/api/sessions/delete', { id: original.id });
    assert.equal(deletion.body.ok, true); assert.equal(fs.existsSync(w.source.file), false);
    const surface = w.surface('runtime');
    assert.equal(await surface.view.openHistory(locator), true);
    await loaded(surface, w.artifacts, assert);
    assert.ok(surface.reads.every(read => JSON.stringify(read.request.scope) === JSON.stringify({ conversationId: locator.conversationId })));
    assert.equal(surface.host.querySelectorAll('.html-artifact').length, 2);
    assert.equal(inherited.calls.some(call => call.type === 'prompt'), false);
    assert.deepEqual(w.snapshots(), w.artifacts.map(ref => ref.id).sort());
    const snapshot = await w.store.read(w.artifacts[0].id);
    assert.equal(snapshot.artifact.sessionId, w.source.sessionId);
    assert.equal(digest(snapshot.html), w.artifacts[0].digest);
  });

  await t.test('switching Runtime read-only histories releases and rereads shared inherited IDs in the new scope', async sub => {
    const w = await fixture(sub, assert), first = w.source.fork('40000001'), second = w.source.fork();
    const a = w.retire('history-first', first), b = w.retire('history-second', second), surface = w.surface('runtime');
    assert.equal(await surface.view.openHistory(a), true); await loaded(surface, [w.artifacts[0]], assert);
    const oldFrame = surface.host.querySelector('iframe');
    assert.equal(await surface.view.openHistory(b), true); await loaded(surface, w.artifacts, assert);
    assert.equal(oldFrame.isConnected, false); assert.equal(surface.releases.length, 1);
    assert.deepEqual(surface.reads.map(read => read.request.scope.conversationId), [a.conversationId, b.conversationId, b.conversationId]);
    assert.equal(await surface.view.openHistory(a), true);
    await waitFor(() => surface.reads.length === 4, 'return to first historical scope performs a new HTTP read');
    await loaded(surface, [w.artifacts[0]], assert);
    assert.equal(surface.host.querySelectorAll('.html-artifact').length, 1);
    // show() may briefly remount A's cached reference while loadHistory() starts;
    // that registration must also be released, even if its read is aborted.
    assert.ok(surface.releases.length >= 3);
    assert.equal(surface.registered.length - surface.releases.length, 1, 'only the current historical frame remains registered');
    assert.equal(surface.reads[3].request.scope.conversationId, a.conversationId);
  });

  await t.test('a restored file never grants the live child hidden branch through a historical alias', async sub => {
    const w = await fixture(sub, assert), inherited = w.source.fork();
    const locator = w.retire('history-alias', inherited);
    w.bind('runtime', inherited, 'live-child'); inherited.branch('40000001');
    const list = await w.sessions.list(w.cwd), listed = list.sessions.find(item => item.sessionId === inherited.sessionId);
    for (const scope of [{ conversationId: locator.conversationId }, { sessionId: listed.id }]) {
      const result = await w.read(w.artifacts[1], scope);
      assert.equal(result.status, 409); assert.deepEqual(result.body, { ok: false, code: 'reference_pending' });
    }
    assert.equal((await w.read(w.artifacts[1], w.scope('runtime', 'live-child'))).body.code, 'reference_pending');
    assert.equal(w.readHtmlArtifactSession(inherited.file).leafId, '40000002');
    assert.equal((await w.store.read(w.artifacts[1].id)).html, w.html[1]);
  });
  t.diagnostic(`html-artifact-branches assertions=${assertions}; explicit skips=0`);
});
