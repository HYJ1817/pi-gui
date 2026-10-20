const assert = require('node:assert/strict'); let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
(async () => {
  const { createRuntimeRecovery } = await import('../public/runtime-recovery.js');
  const { createRuntimeStore } = await import('../public/runtime-store.js');
  const owner = id => ({ backendInstance: 'backend', projectId: 'project', repoId: 'repo', workspaceId: id,
    workspaceEpoch: 'epoch', conversationId: id, runtimeId: 'runtime-' + id, runtimeGeneration: 'generation', sessionId: 'native-' + id });
  const A = owner('A'), B = owner('B');
  const item = o => ({ conversationId: o.conversationId, owner: o, revision: 1, lifecycle: 'ready', activity: 'running', workspace: { branch: o.conversationId } });
  const frame = (o, n, event) => ({ type: 'runtime_event', owner: o, eventSequence: n, event });
  const store = createRuntimeStore(), requests = [];
  const approval = { type: 'extension_ui_request', id: 'shared-request', method: 'confirm', title: 'Confirm A only' };
  const events = o => [frame(o, 1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: o.conversationId + ' output' } }),
    frame(o, 2, { type: 'tool_execution_start', toolCallId: 'shared-tool', toolName: 'read' }), frame(o, 3, approval)];
  const recover = createRuntimeRecovery({ store, seed: snapshot => store.seed(snapshot), observe: f => store.apply(f),
    readSnapshot: async () => ({ ok: true, backendInstance: 'backend', items: [item(A), item(B)] }),
    read: async request => {
      requests.push(request);
      if (request.action === 'events') return { ok: true, owner: request.owner, cursor: 3, events: events(request.owner), approvals: request.owner.conversationId === 'A' ? [approval] : [] };
      return { ok: true, data: { messages: [{ role: 'user', content: request.owner.conversationId + ' native prompt' }, { role: 'assistant', content: [{ type: 'text', text: request.owner.conversationId + ' persisted result' }] }] } };
    } });
  await recover();
  await check('reload hydrates A/B persisted text and tool state without mixing equal IDs', () => {
    assert.equal(store.get('A').text, 'A native prompt\n\nA persisted result'); assert.equal(store.get('B').text, 'B native prompt\n\nB persisted result');
    assert.notEqual(store.get('A').tools[0], store.get('B').tools[0]);
  });
  await check('recovery retains only authoritative pending approvals and sends no decisions', () => {
    assert.equal(store.get('A').approvals.length, 1); assert.equal(store.get('B').approvals.length, 0);
    assert.ok(requests.every(r => r.action === 'events' || r.action === 'read'));
  });
  await check('an older approvals snapshot cannot clear a newer live request', () => {
    store.apply(frame(A, 4, { ...approval, id: 'new-A' }));
    assert.equal(store.reconcileApprovals(A, [], 3), false);
    assert.ok(store.get('A').approvals.some(a => a.id === 'new-A'));
  });
  await check('interrupted tasks are never left with running tool labels', () => {
    store.apply(frame(A, 5, { type: 'bridge_status', state: 'exited' }));
    assert.equal(store.get('A').tools[0].state, 'interrupted'); assert.equal(store.get('B').tools[0].state, 'running');
  });
  await check('late history cannot overwrite newer streaming or a replaced owner', () => {
    assert.equal(store.history('A', [], A, 3), false);
    assert.equal(store.history('A', [], { ...A, runtimeGeneration: 'old' }, 5), false);
  });
  await check('confirmed Stop settles only its own remaining approvals and tools', () => {
    store.apply(frame(B, 4, approval)); store.apply(frame(B, 5, { type: 'stop_state', pending: false }));
    assert.equal(store.get('B').approvals.length, 0); assert.equal(store.get('B').tools[0].state, 'interrupted');
  });
  console.log(`Session background recovery: ${passed}/${passed}; failed=0`);
})().catch(e => { console.error(e); process.exitCode = 1; });
