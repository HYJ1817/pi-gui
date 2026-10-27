// Offline production-policy/controller tests. No model requests or user data.
const assert = require('node:assert/strict');
(async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="toasts"></div>', { url: 'http://127.0.0.1/' });
  global.window = dom.window; global.document = dom.window.document;
  const { thinkingAvailability: classic } = await import('../public/ui3-model-picker.js');
  const { createRuntimeModels } = await import('../public/runtime-models.js');
  const { createRuntimeStore } = await import('../public/runtime-store.js');
  let passed = 0, failed = 0;
  const check = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.error(' FAIL ' + name + ': ' + e.message); } };
  const model = reasoning => ({ provider: 'fixture', id: 'reason-conflict', reasoning });
  const levels = ['off', 'low', 'high'];
  for (const reasoning of [false, null, true]) {
    await check('native levels beat static reasoning=' + reasoning, () => {
      const m = model(reasoning), a = classic({ model: m, levels });
      assert.equal(a.state, 'ready'); assert.deepEqual(a.levels, levels); assert.deepEqual(a.usable, ['low', 'high']);
      assert.equal(m.reasoning, reasoning);
    });
  }
  for (const [name, input, expected] of [
    ['no model', { model: null, levels }, 'no-model'],
    ['pending', { model: model(false), levels, pending: true }, 'pending'],
    ['initial native read pending', { model: model(false), levels, readStatus: 'pending' }, 'pending'],
    ['read failed with old valid levels', { model: model(true), levels, readStatus: 'error' }, 'read-failed'],
    ['unconfirmed read', { model: model(true), levels, readStatus: 'unconfirmed' }, 'unconfirmed'],
    ['expired read', { model: model(true), levels, readStatus: 'stale' }, 'stale'],
    ['invalid model', { model: {}, levels }, 'no-model'],
    ['empty', { model: model(true), levels: [] }, 'unavailable'],
    ['only off', { model: model(true), levels: ['off'] }, 'unavailable'],
    ['malformed list', { model: model(true), levels: 'high' }, 'invalid'],
  ]) await check(name, () => {
    const a = classic(input); assert.equal(a.state, expected); assert.deepEqual(a.usable, []); assert.ok(a.detail);
  });
  await check('dedup/filter without inventing or repairing native tokens', () => {
    const a = classic({ model: model(false), levels: ['off', 'low', 'low', '', ' ', null, 3, {}, ' high', 'hi\ngh', 'quantum'] });
    assert.deepEqual(a.levels, ['off', 'low', 'quantum']); assert.deepEqual(a.usable, ['low', 'quantum']);
  });
  await check('invalid tokens cannot enable adjustment', () => {
    assert.notEqual(classic({ model: model(true), levels: [' ', '\n', '<x>', ' high'] }).state, 'ready');
  });
  const owner = (id, generation = 'one') => ({ backendInstance: 'backend', projectId: 'p', repoId: 'r', workspaceId: 'w', workspaceEpoch: 'e', conversationId: id, runtimeId: 'rt-' + id, runtimeGeneration: generation, sessionId: 's-' + id });
  const item = (id, generation = 'one', revision = 1) => ({ conversationId: id, owner: owner(id, generation), lifecycle: 'ready', activity: 'idle', revision });
  const store = createRuntimeStore(); store.seed({ backendInstance: 'backend', items: ['A', 'B'].map(id => item(id)) });
  const native = { A: { model: model(false), thinkingLevel: 'low' }, B: { model: model(null), thinkingLevel: 'high' } };
  const posts = [], listeners = new Set(); let failLevels = false, gateLevels = null, nativeLevels = levels;
  const request = async p => {
    posts.push(p);
    if (p.action === 'command') return { ok: true };
    if (p.command.type === 'get_state') return { ok: true, data: structuredClone(native[p.owner.conversationId]) };
    if (p.command.type === 'get_available_models') return { ok: true, data: { models: [] } };
    if (p.command.type === 'get_available_thinking_levels') {
      if (gateLevels) { const gate = gateLevels; gateLevels = null; return new Promise(resolve => { gate.resolve = resolve; }); }
      return failLevels ? { ok: false } : { ok: true, data: { levels: nativeLevels } };
    }
    throw Error('unexpected read');
  };
  const controller = createRuntimeModels({ store, request, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, timeoutMs: 200 });
  const until = async fn => { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(r => setImmediate(r)); } throw Error('fixture_timeout'); };
  let sequence = 0;
  const respond = (p, success = true) => {
    const frame = { type: 'runtime_event', owner: p.owner, eventSequence: ++sequence, event: { type: 'response', id: p.command.id, command: p.command.type, success } };
    if (store.apply(frame)) for (const fn of listeners) fn(frame);
  };
  const lastCommand = () => posts.filter(p => p.action === 'command').at(-1);
  try {
    await check('Classic/Runtime availability agrees for static false and unknown', async () => {
      await Promise.all([controller.refresh('A'), controller.refresh('B')]);
      for (const id of ['A', 'B']) {
        const data = controller.get(id);
        assert.deepEqual(data.availability, classic({ model: native[id].model, levels }));
        assert.equal(data.reasoning, native[id].model.reasoning);
      }
    });
    await check('failed native levels revoke adjustment without changing reliable model/value', async () => {
      failLevels = true; assert.equal(await controller.refresh('A'), false); failLevels = false;
      const data = controller.get('A'); assert.equal(data.availability.state, 'read-failed'); assert.equal(data.model.id, 'reason-conflict'); assert.equal(data.thinkingLevel, 'low');
      const count = posts.length; assert.equal(await controller.setThinking('A', 'high'), false); assert.equal(posts.length, count);
      await controller.refresh('A');
    });
    await check('pending rejects duplicate thinking writes and unlisted levels', async () => {
      await controller.refresh('B');
      const before = posts.length; assert.equal(await controller.setThinking('B', 'bogus'), false); assert.equal(posts.length, before);
      const setting = controller.setThinking('B', 'low');
      const p = lastCommand(); assert.equal(p.command.level, 'low'); assert.equal(controller.get('B').availability.state, 'pending');
      const count = posts.length; assert.equal(await controller.setThinking('B', 'high'), false); assert.equal(posts.length, count);
      native.B.thinkingLevel = 'low'; respond(p); assert.equal(await setting, true);
    });
    await check('native thinking failure preserves confirmed value', async () => {
      const setting = controller.setThinking('B', 'high'), p = lastCommand(); respond(p, false);
      assert.equal(await setting, false); assert.equal(controller.get('B').thinkingLevel, 'low'); assert.ok(controller.get('B').notice);
    });
    await check('HTTP ACK and native success wait for actual state/levels readback', async () => {
      const setting = controller.setThinking('B', 'high'), p = lastCommand();
      await new Promise(r => setImmediate(r)); assert.equal(controller.get('B').thinkingLevel, 'low'); assert.equal(controller.get('B').pending, true);
      const gate = {}; gateLevels = gate; native.B.thinkingLevel = 'high'; respond(p); await until(() => gate.resolve);
      assert.equal(controller.get('B').thinkingLevel, 'low'); assert.equal(controller.get('B').pending, true);
      gate.resolve({ ok: true, data: { levels } }); assert.equal(await setting, true); assert.equal(controller.get('B').thinkingLevel, 'high');
    });
    await check('clamped/ignored native thinking command cannot report success', async () => {
      const setting = controller.setThinking('B', 'low'), p = lastCommand(); respond(p);
      assert.equal(await setting, false); assert.equal(controller.get('B').thinkingLevel, 'high'); assert.ok(controller.get('B').notice);
    });
    await check('model mismatch after native success cannot confirm switch', async () => {
      const setting = controller.setModel('B', { provider: 'fixture', id: 'ignored' }), p = lastCommand(); respond(p);
      assert.equal(await setting, false); assert.equal(controller.get('B').model.id, 'reason-conflict');
    });
    await check('thinking confirmation requires the model captured before writing', async () => {
      const setting = controller.setThinking('B', 'low'), p = lastCommand();
      native.B = { model: { provider: 'fixture', id: 'external-change' }, thinkingLevel: 'low' }; respond(p);
      assert.equal(await setting, false); assert.ok(controller.get('B').notice);
    });
    await check('malformed current level is never repaired into native confirmation', async () => {
      const setting = controller.setThinking('B', 'high'), p = lastCommand();
      native.B.thinkingLevel = ' high'; respond(p); assert.equal(await setting, false);
      assert.notEqual(controller.get('B').thinkingLevel, 'high');
    });
    for (const [name, m, list] of [
      ['false valid', model(false), levels], ['unknown valid', model(null), levels],
      ['true empty', model(true), []], ['false empty', model(false), []], ['unknown empty', model(null), []],
      ['only off', model(false), ['off']], ['no model', null, levels],
      ['dedup and invalid', model(true), ['off', 'low', 'low', ' ', ' high', 5]],
    ]) await check('Classic/Runtime matrix: ' + name, async () => {
      native.A = { model: m, thinkingLevel: 'low' }; nativeLevels = list;
      assert.equal(await controller.refresh('A'), true);
      assert.deepEqual(controller.get('A').availability, classic({ model: m, levels: list }));
      nativeLevels = levels;
    });
    await check('A delayed levels cannot pollute B or overwrite a newer A read', async () => {
      const gate = {}; gateLevels = gate; const stale = controller.refresh('A'); await until(() => gate.resolve);
      native.B.model = { provider: 'fixture', id: 'B-new' }; await controller.refresh('B');
      native.A.model = { provider: 'fixture', id: 'A-new' }; await controller.refresh('A');
      gate.resolve({ ok: true, data: { levels: ['off', 'quantum'] } }); assert.equal(await stale, false);
      assert.equal(controller.get('B').model.id, 'B-new'); assert.equal(controller.get('A').model.id, 'A-new'); assert.deepEqual(controller.get('A').levels, levels);
    });
    await check('Owner/generation replacement rejects late levels and requires fresh evidence', async () => {
      const gate = {}; gateLevels = gate; const stale = controller.refresh('A'); await until(() => gate.resolve);
      store.seed({ backendInstance: 'backend', items: [item('A', 'two', 10), item('B', 'one', 10)] }); for (const fn of listeners) fn();
      gate.resolve({ ok: true, data: { levels } }); assert.equal(await stale, false);
      assert.equal(controller.get('A').model, null); assert.equal(controller.get('A').availability.state, 'no-model');
      assert.equal(await controller.setThinking('A', 'high'), false);
    });
  } finally { controller.dispose(); dom.window.close(); }
  console.log(`Thinking availability: ${passed}/${passed + failed} passed`); if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
