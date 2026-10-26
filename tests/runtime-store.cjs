const assert = require('node:assert/strict');
(async () => {
  let createRuntimeStore; try { ({ createRuntimeStore } = await import('../public/runtime-store.js')); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  assert.equal(typeof createRuntimeStore, 'function'); let checks = 1;
  const store = createRuntimeStore(), owner = id => ({ backendInstance: 'backend', conversationId: id, runtimeId: id, runtimeGeneration: 'one', sessionId: 'native-' + id });
  const A = owner('A'), B = owner('B'); store.seed({ backendInstance: 'backend', items: [{ conversationId: 'A', owner: A }, { conversationId: 'B', owner: B }] });
  const event = (o, seq, e) => ({ type: 'runtime_event', owner: o, eventSequence: seq, event: e });
  store.apply(event(A, 1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'only A' } }));
  store.apply(event(B, 1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'only B' } }));
  assert.equal(store.get('A').text, 'only A'); assert.equal(store.get('B').text, 'only B'); checks++;
  store.apply(event(A, 1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'duplicate' } })); assert.equal(store.get('A').text, 'only A'); checks++;
  store.apply(event({ ...A, runtimeGeneration: 'old' }, 2, { type: 'stop_state', pending: false })); assert.equal(store.get('A').cursor, 1); checks++;
  store.apply(event(A, 2, { type: 'tool_execution_start', toolCallId: 'same', toolName: 'write', args: { env: 'secret' } })); store.apply(event(B, 2, { type: 'tool_execution_start', toolCallId: 'same', toolName: 'bash' }));
  assert.equal(store.get('A').tools[0].name, 'write'); assert.equal(store.get('B').tools[0].name, 'bash'); assert.ok(!JSON.stringify(store.get('A')).includes('secret')); checks++;
  for (let i = 3; i < 210; i++) store.apply(event(A, i, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(8192) } }));
  assert.ok(store.get('A').text.length <= 1024 * 1024); assert.equal(store.get('A').truncated, true); checks++;
  store.seed({ backendInstance: 'new', items: [{ conversationId: 'A', owner: { ...A, backendInstance: 'new', runtimeGeneration: 'new' } }] });
  store.apply(event(A, 210, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'stale' } })); assert.equal(store.get('A').text, ''); checks++;
  const isolated = createRuntimeStore({ limit: 127 }), oldOwner = owner('history'), newOwner = { ...oldOwner, runtimeId: 'new-child', runtimeGeneration: 'two' };
  const seed = o => isolated.seed({ backendInstance: 'backend', items: [{ conversationId: 'history', owner: o }] });
  const closed = o => ({ type: 'runtime_closed', backendInstance: 'backend', conversationId: 'history', owner: o, item: { conversationId: 'history', owner: null } });
  seed(oldOwner);isolated.apply(event(oldOwner, 1, { type: 'extension_ui_request', id: 'old-approval', method: 'confirm', title: 'fixture approval' }));seed(newOwner);
  isolated.apply(event(newOwner, 1, { type: 'extension_ui_request', id: 'new-approval', method: 'confirm', title: 'fixture approval' }));
  assert.equal(isolated.apply(closed(oldOwner)), false);assert.equal(isolated.get('history').owner.runtimeId, 'new-child');assert.equal(isolated.get('history').approvals[0].id, 'new-approval');checks++;
  assert.equal(isolated.apply({ ...closed(newOwner), owner: undefined }), false);assert.equal(isolated.get('history').owner.runtimeId, 'new-child');checks++;
  const messages = text => [{ role: 'assistant', content: [{ type: 'text', text }] }];
  assert.equal(isolated.history('history', messages('old history'), oldOwner, 1), false);assert.equal(isolated.get('history').text, '');checks++;
  assert.equal(isolated.history('history', messages('valid history'), newOwner, 1), true);assert.equal(isolated.get('history').text, 'valid history');checks++;
  isolated.apply(event(newOwner, 2, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' + live' } }));
  assert.equal(isolated.history('history', messages('late readback'), newOwner, 1), false);assert.equal(isolated.get('history').text, 'valid history + live');checks++;
  assert.equal(isolated.history('history', messages('missing scope')), false);assert.equal(isolated.get('history').text, 'valid history + live');checks++;
  isolated.apply(event(newOwner, 3, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '中🙂'.repeat(200) } }));
  assert.ok(Buffer.byteLength(isolated.get('history').text, 'utf8') <= 127);assert.equal(isolated.get('history').truncated, true);assert.ok(!isolated.get('history').text.includes('\uFFFD'));checks++;
  assert.equal(isolated.history('history', messages('中🙂'.repeat(200)), newOwner, 3), true);assert.ok(Buffer.byteLength(isolated.get('history').text, 'utf8') <= 127);assert.ok(!isolated.get('history').text.includes('\uFFFD'));checks++;
  const boundedHistory = createRuntimeStore({ limit: 127 });boundedHistory.seed({ backendInstance: 'backend', items: [{ conversationId: 'history', owner: newOwner }] });
  assert.equal(boundedHistory.history('history', messages('中🙂'.repeat(200)), newOwner, 0), true);
  assert.ok(Buffer.byteLength(boundedHistory.get('history').text, 'utf8') <= 127);assert.equal(boundedHistory.get('history').truncated, true);checks++;
  assert.equal(isolated.apply(closed(newOwner)), true);assert.equal(isolated.get('history').owner, null);assert.equal(isolated.get('history').approvals.length, 0);checks++;
  const revisions = createRuntimeStore(), unbound = { ...A, sessionId: null };
  const revisionItem = (o, revision, activity = 'idle') => ({ conversationId: 'A', owner: o, revision, lifecycle: 'ready', activity });
  const snapshot = item => ({ backendInstance: 'backend', items: [item] });
  const state = item => ({ type: 'runtime_state', owner: item.owner, item });
  revisions.seed(snapshot(revisionItem(unbound, 1)));
  revisions.apply(state(revisionItem(A, 3)));
  revisions.seed(snapshot(revisionItem(unbound, 2)));
  assert.equal(revisions.get('A').owner.sessionId, A.sessionId);assert.equal(revisions.get('A').item.revision, 3);checks++;
  assert.equal(revisions.apply(event(A, 1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after native session binding' } })), true);
  assert.equal(revisions.get('A').text, 'after native session binding');checks++;
  revisions.apply(state(revisionItem(A, 5, 'stopping')));
  revisions.seed(snapshot(revisionItem(A, 4, 'running')));
  assert.equal(revisions.get('A').item.activity, 'stopping');assert.equal(revisions.get('A').item.revision, 5);checks++;
  revisions.apply(state(revisionItem(A, 6, 'idle')));
  revisions.apply(state(revisionItem(A, 5, 'stopping')));
  assert.equal(revisions.get('A').item.activity, 'idle');assert.equal(revisions.get('A').item.revision, 6);checks++;
  const resumedA = { ...A, runtimeId: 'resumed-child', runtimeGeneration: 'resumed-generation' };
  revisions.apply(state(revisionItem(resumedA, 8, 'running')));
  revisions.seed(snapshot(revisionItem(A, 7, 'idle')));
  assert.equal(revisions.get('A').owner.runtimeId, resumedA.runtimeId);assert.equal(revisions.get('A').item.activity, 'running');checks++;
  assert.equal(revisions.apply(state(revisionItem(A, 7, 'stopping'))), false);
  assert.equal(revisions.apply(event(A, 2, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late old owner' } })), false);
  assert.equal(revisions.apply(event(resumedA, 1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'new owner only' } })), true);
  assert.equal(revisions.get('A').text, 'new owner only');checks++;
  const dormant=createRuntimeStore(),dormantItem={conversationId:'closed',owner:null,revision:2,lifecycle:'dormant',activity:'idle'};
  dormant.seed(snapshot(dormantItem));dormant.get('closed').draft='retained draft';
  assert.doesNotThrow(()=>dormant.seed(snapshot({...dormantItem,revision:3})));
  assert.equal(dormant.get('closed').owner,null);assert.equal(dormant.get('closed').draft,'retained draft');checks++;
  dormant.seed(snapshot({...dormantItem,owner:{...A,conversationId:'closed'},revision:4,lifecycle:'ready'}));
  assert.doesNotThrow(()=>dormant.seed(snapshot({...dormantItem,revision:5})));
  assert.equal(dormant.get('closed').owner,null);assert.equal(dormant.get('closed').item.revision,5);checks++;

  // 验证同一 conversationId 下 Owner/sessionId/workspaceEpoch 变化的草稿继承隔离合同
  const storeA = createRuntimeStore();
  const baseOwnerA = {
    backendInstance: 'backend',
    projectId: 'p1',
    repoId: 'r1',
    workspaceId: 'w1',
    workspaceEpoch: 'e1',
    conversationId: 'conv-A',
    runtimeId: 'rt-1',
    runtimeGeneration: 'g1',
    sessionId: 'native-1'
  };
  const baseItemA = {
    conversationId: 'conv-A',
    nativeSessionId: 'native-1',
    workspace: { projectId: 'p1', workspaceId: 'w1', workspaceEpoch: 'e1' },
    owner: baseOwnerA,
    revision: 1
  };
  storeA.seed({ backendInstance: 'backend', items: [baseItemA] });
  storeA.get('conv-A').draft = 'draft before change';
  storeA.get('conv-A').draftRevision = 5;

  // 1. 同一 conversationId，仅 runtimeId/runtimeGeneration 变化（进程重启），稳定 locator 相同 -> 允许保留草稿
  const restartedOwnerA = { ...baseOwnerA, runtimeId: 'rt-2', runtimeGeneration: 'g2' };
  const restartedItemA = { ...baseItemA, owner: restartedOwnerA, revision: 2 };
  storeA.seed({ backendInstance: 'backend', items: [restartedItemA] });
  assert.equal(storeA.get('conv-A').draft, 'draft before change');
  assert.equal(storeA.get('conv-A').draftRevision, 5);
  checks++;

  // 2. 同一 conversationId，nativeSessionId 变化 -> 禁止继承旧草稿！
  const diffSessionOwner = { ...baseOwnerA, runtimeId: 'rt-3', runtimeGeneration: 'g3', sessionId: 'native-2' };
  const diffSessionItem = { ...baseItemA, nativeSessionId: 'native-2', owner: diffSessionOwner, revision: 3 };
  storeA.seed({ backendInstance: 'backend', items: [diffSessionItem] });
  assert.equal(storeA.get('conv-A').draft, '');
  assert.equal(storeA.get('conv-A').draftRevision, 0);
  checks++;

  // 3. 同一 conversationId，workspaceEpoch 变化 -> 禁止继承旧草稿！
  storeA.get('conv-A').draft = 'draft before epoch change';
  storeA.get('conv-A').draftRevision = 2;
  const diffEpochOwner = { ...diffSessionOwner, workspaceEpoch: 'epoch-2', runtimeId: 'rt-4', runtimeGeneration: 'g4' };
  const diffEpochItem = { ...diffSessionItem, workspace: { ...diffSessionItem.workspace, workspaceEpoch: 'epoch-2' }, owner: diffEpochOwner, revision: 4 };
  storeA.seed({ backendInstance: 'backend', items: [diffEpochItem] });
  assert.equal(storeA.get('conv-A').draft, '');
  assert.equal(storeA.get('conv-A').draftRevision, 0);
  checks++;

  // 4. 首次未绑定（sessionId 为 null）-> 首次获得已证明 sessionId：允许接续内存草稿
  const unboundItem = { conversationId: 'conv-unbound', workspace: { projectId: 'p1', workspaceId: 'w1', workspaceEpoch: 'e1' }, owner: null, revision: 1 };
  storeA.seed({ backendInstance: 'backend', items: [unboundItem] });
  storeA.get('conv-unbound').draft = 'unbound input';
  storeA.get('conv-unbound').draftRevision = 1;
  const boundItem = { ...unboundItem, nativeSessionId: 'native-bound', owner: { ...baseOwnerA, conversationId: 'conv-unbound', sessionId: 'native-bound' }, revision: 2 };
  storeA.seed({ backendInstance: 'backend', items: [boundItem] });
  assert.equal(storeA.get('conv-unbound').draft, 'unbound input');
  assert.equal(storeA.get('conv-unbound').draftRevision, 1);
  checks++;

  // 5. 身份冲突（item.nativeSessionId !== owner.sessionId）-> 拒绝继承
  storeA.get('conv-unbound').draft = 'text before conflict';
  const conflictItem = { ...boundItem, nativeSessionId: 'native-one', owner: { ...boundItem.owner, sessionId: 'native-two' }, revision: 3 };
  storeA.seed({ backendInstance: 'backend', items: [conflictItem] });
  assert.equal(storeA.get('conv-unbound').draft, '');
  checks++;

  console.log(`Runtime conversation store: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
