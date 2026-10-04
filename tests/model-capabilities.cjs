const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error(' FAIL ' + name + ': ' + e.message); } }
async function main() {
  const core = await import('../lib/model-capabilities.js').catch(() => ({}));
  const { normalizeModelCapability: normalize, mergeModelCapabilities: merge, modelIdentity } = core;
  await check('unknown stays null without name guessing', () => {
    const m = normalize({ provider: 'openai', id: 'gpt-claude-gemini' });
    assert.equal(m.contextWindow, null); assert.equal(m.maxOutputTokens, null);
    assert.ok(Object.values(m.capabilities).every(v => v === null));
    assert.equal(m.reasoning.levels, null);
  });
  for (const value of [true, false, null]) {
    await check('reasoning and explicit capabilities: ' + value, () => {
      const m = normalize({ provider: 'a', id: 'm', reasoning: value, capabilities: { imageInput: value, toolCalling: value, streaming: value } });
      assert.equal(m.capabilities.reasoning, value); assert.equal(m.reasoning.supported, value);
      assert.equal(m.capabilities.imageInput, value); assert.equal(m.capabilities.toolCalling, value); assert.equal(m.capabilities.streaming, value);
      assert.equal(m.reasoning.levels, null);
    });
  }
  await check('input text is explicit false for images; absent or empty input is unknown', () => {
    assert.equal(normalize({ input: ['text'] }).capabilities.imageInput, false);
    assert.equal(normalize({ input: ['image'] }).capabilities.imageInput, true);
    assert.equal(normalize({ input: [] }).capabilities.imageInput, null);
    assert.equal(normalize({ input: ['audio'] }).capabilities.imageInput, null);
  });
  await check('token limits accept positive finite numbers without defaults', () => {
    assert.equal(normalize({ contextWindow: 400000, maxTokens: 12000 }).maxOutputTokens, 12000);
    for (const value of [0, -1, Infinity, '4000', null]) assert.equal(normalize({ contextWindow: value, maxTokens: value }).contextWindow, null);
  });
  await check('structured identity preserves slash IDs and isolates providers', () => {
    assert.deepEqual(modelIdentity({ providerId: 'router', modelId: 'vendor/model' }), { providerId: 'router', modelId: 'vendor/model' });
    assert.notDeepEqual(modelIdentity({ provider: 'a', id: 'same' }), modelIdentity({ provider: 'b', id: 'same' }));
    assert.equal(modelIdentity({ id: 'vendor/model' }).providerId, null);
  });
  await check('field merge Pi > user > provider including false and invalid fallthrough', () => {
    const m = merge({ runtime: { provider: 'a', id: 'm', reasoning: false, contextWindow: 0 }, user: { provider: 'a', id: 'm', reasoning: true, contextWindow: 8000 }, provider: { provider: 'a', id: 'm', contextWindow: 4000, maxTokens: 1000, capabilities: { toolCalling: true } } });
    assert.equal(m.capabilities.reasoning, false); assert.equal(m.contextWindow, 8000); assert.equal(m.maxOutputTokens, 1000);
    assert.equal(m.evidence.reasoning, 'pi-runtime'); assert.equal(m.evidence.contextWindow, 'user-config'); assert.equal(m.evidence.toolCalling, 'provider-metadata');
    assert.equal(m.reasoning.levels, null);
  });
  await check('merge never crosses Provider/model identity', () => {
    const m = merge({ runtime: { provider: 'a', id: 'm' }, user: { provider: 'b', id: 'm', input: ['image'] }, provider: { provider: 'a', id: 'other', contextWindow: 9000 } });
    assert.equal(m.capabilities.imageInput, null); assert.equal(m.contextWindow, null);
  });
  await check('capability allowlist strips secrets and untrusted evidence/levels', () => {
    const m = normalize({ id: 'm', apiKey: 'SECRET', headers: { Authorization: 'SECRET' }, cost: { token: 'SECRET' }, reasoning: true, levels: ['high'], evidence: { imageInput: 'SECRET' }, capabilities: { imageInput: true, token: 'SECRET' } });
    assert.ok(!JSON.stringify(m).includes('SECRET')); assert.equal(m.reasoning.levels, null);
  });
  const { normalize: normalizeApi } = await import('../lib/models-api.js');
  await check('Provider metadata retains false and text-only evidence', () => {
    const m = normalizeApi({ id: 'm', reasoning: false, architecture: { input_modalities: ['text'] }, supported_parameters: ['tools'] }, 'openai');
    assert.equal(m.capability.capabilities.reasoning, false); assert.equal(m.capability.capabilities.imageInput, false);
    assert.equal(m.capability.capabilities.toolCalling, true); assert.equal(m.capability.capabilities.streaming, null);
  });
  const { publicModel, sanitizeModelEvent } = await import('../server/provider-auth-sdk.js');
  await check('runtime safe projection retains identity and capability, no credentials', () => {
    const m = publicModel({ provider: 'a', id: 'm', input: ['text'], headers: { key: 'SECRET' }, apiKey: 'SECRET' });
    assert.equal(m.providerId, 'a'); assert.equal(m.modelId, 'm'); assert.equal(m.capability.capabilities.imageInput, false); assert.ok(!JSON.stringify(m).includes('SECRET'));
  });
  await check('SSE model merge uses explicit same-identity user metadata', () => {
    const event = sanitizeModelEvent({ type: 'response', command: 'get_state', success: true, data: { model: { provider: 'a', id: 'm' } } }, { providers: { a: { models: [{ id: 'm', contextWindow: 9000 }] } } });
    assert.equal(event.data.model.capability.contextWindow, 9000); assert.equal(event.data.model.capability.evidence.contextWindow, 'user-config');
  });
  await check('malformed user metadata cannot break otherwise valid Pi events', () => {
    for (const models of [{}, 'invalid', 42, [null], [null, 'invalid', {}]]) {
      const event = sanitizeModelEvent({ type: 'response', command: 'get_state', success: true, data: { model: { provider: 'a', id: 'm' } } }, { providers: { a: { models } } });
      assert.equal(event.data.model.modelId, 'm'); assert.equal(event.data.model.capability.contextWindow, null);
    }
  });
  const { publicProviderConfig, createProviders } = await import('../server/providers.js');
  await check('safe Provider config uses user evidence and excludes secrets', () => {
    const cfg = publicProviderConfig({ apiKey: 'SECRET', models: [{ id: 'm', capabilities: { toolCalling: false, streaming: true, token: 'SECRET' }, headers: { key: 'SECRET' } }] }, 'custom');
    assert.equal(cfg.models[0].capability.providerId, 'custom'); assert.equal(cfg.models[0].capability.evidence.streaming, 'user-config');
    assert.equal(cfg.models[0].capabilities.toolCalling, false); assert.ok(!JSON.stringify(cfg).includes('SECRET'));
  });
  await check('old disk models.json is read without migration or writes', () => {
    const os = require('node:os'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-capability-'));
    const file = path.join(dir, 'models.json'), raw = JSON.stringify({ providers: { legacy: { apiKey: '$KEY', models: [{ id: 'm' }] } } });
    try { fs.writeFileSync(file, raw); const cfg = createProviders({ modelsJson: file }).readModelsConfig();
      assert.equal(cfg.providers.legacy.models[0].id, 'm'); assert.equal(fs.readFileSync(file, 'utf8'), raw);
      assert.equal(publicProviderConfig(cfg.providers.legacy, 'legacy').models[0].capability.capabilities.imageInput, null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await runUiChecks();
  console.log(`\nModel capabilities: ${pass}/${pass + fail} 通过`); process.exitCode = fail ? 1 : 0;
}
async function runUiChecks() {
  const pub = path.resolve(__dirname, '../public');
  const dom = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), { url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [];
  w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.EventSource = class { close() {} };
  w.fetch = async (url, options = {}) => { if (url === '/api/command') calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, items: [], sessions: [] }) }; };
  w.eval(bundle(path.join(pub, 'app.js')).code);
  await new Promise(r => setTimeout(r, 40));
  w.S.hasProject = true; w.S.bridgeState = 'ready'; w.S.switching = false;
  const state = model => w.applyState({ model, thinkingLevel: 'high' });
  await check('old models.json line roundtrip preserves false and text-only input', () => {
    const line = w.modelLine({ id: 'm', reasoning: false, input: ['text'] }); const m = w.parseModelLine(line);
    assert.equal(m.reasoning, false); assert.equal(m.input.join(','), 'text'); assert.equal(w.parseModelLine('legacy').id, 'legacy');
  });
  await check('S.models has structured identities and capability projection', () => {
    w.onModels({ models: [{ provider: 'a', id: 'm', reasoning: true, input: ['text', 'image'], contextWindow: 400000, maxTokens: 8000 }, { provider: 'b', id: 'm' }] });
    assert.equal(w.S.models[0].providerId, 'a'); assert.equal(w.S.models[0].modelId, 'm');
    state(w.S.models[0]); w.applyProjectState(); w.document.getElementById('btnModel').click();
    const text = w.document.querySelector('.pop-provider-models .pi-sub').textContent;
    assert.ok(text.includes('图片') && text.includes('推理') && text.includes('400K'));
    assert.ok(!w.document.querySelector('.pop-model-group[data-provider="b"]').textContent.includes('不支持')); w.closePop();
  });
  await check('empty thinking response disables UI and clears old High', () => {
    w.onThinkingLevels({ levels: [] }); assert.equal(w.document.getElementById('btnThink').disabled, true);
    assert.equal(w.document.getElementById('thinkText').textContent, '思考不可用');
  });
  await check('metadata reasoning=true does not synthesize selectable levels', () => {
    state({ provider: 'a', id: 'reasoning', reasoning: true }); w.setThinkingLevel('high');
    assert.equal(w.S.thinkingLevels.length, 0); assert.ok(!calls.some(c => c.type === 'set_thinking_level'));
  });
  await check('off-only Pi levels are unavailable; Pi list beats static reasoning=false', () => {
    w.onThinkingLevels({ levels: ['off'] }); assert.equal(w.document.getElementById('btnThink').disabled, true);
    state({ provider: 'a', id: 'm', reasoning: false }); w.onThinkingLevels({ levels: ['off', 'low'] });
    assert.equal(w.document.getElementById('btnThink').disabled, false); assert.equal(w.S.thinkingLevels.join(','), 'off,low');
  });
  await check('image=false blocks image upload but permits normal files', async () => {
    state({ provider: 'a', id: 'text', input: ['text'] });
    w.applyProjectState(); assert.equal(w.document.getElementById('btnAttach').disabled, false);
    assert.ok(w.document.getElementById('btnAttach').title.includes('不支持图片'));
    assert.equal(w.document.getElementById('fileInput').accept, '');
    await w.handleFiles([new w.File(['image'], 'a.png', { type: 'image/png' }), new w.File(['text'], 'a.txt', { type: 'text/plain' })]);
    assert.ok(!w.S.attachments.some(a => a.kind === 'image')); assert.ok(w.S.attachments.some(a => a.name === 'a.txt'));
  });
  await check('unknown/true image capability does not block image entry', () => {
    for (const model of [{ provider: 'b', id: 'unknown' }, { provider: 'b', id: 'image', input: ['text', 'image'] }]) {
      state(model); assert.equal(w.imageInputBlocked(), false); assert.ok(!w.document.getElementById('btnAttach').title.includes('不支持图片'));
    }
  });
  await check('unknown image model really accepts image selection', async () => {
    state({ provider: 'b', id: 'unknown' });
    await w.handleFiles([new w.File(['image'], 'allowed.png', { type: 'image/png' })]);
    assert.ok(w.S.attachments.some(a => a.name === 'allowed.png' && a.kind === 'image'));
  });
  await check('repeated model ID on another Provider never inherits images or tools', () => {
    state({ providerId: 'a', modelId: 'same', input: ['text'], capabilities: { toolCalling: true } }); assert.equal(w.imageInputBlocked(), true);
    state({ providerId: 'b', modelId: 'same' }); assert.equal(w.imageInputBlocked(), false);
    assert.equal(w.S.state.model.capability.capabilities.toolCalling, null); assert.equal(w.S.localUsage.providerId, 'b');
  });
  await check('switch to image=false blocks existing image submission without losing draft', async () => {
    state({ provider: 'a', id: 'text', input: ['text'] }); w.S.attachments = [{ id: 'img', kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,YQ==' }];
    w.document.getElementById('input').value = 'draft'; const count = calls.length; await w.submit();
    assert.equal(calls.length, count); assert.equal(w.S.attachments.length, 1); assert.equal(w.document.getElementById('input').value, 'draft');
  });
  await check('model pending clears old capability restrictions and thinking display', () => {
    w.setModel('b', 'new'); assert.equal(w.S.thinkingLevels.length, 0);
    assert.ok(!w.document.getElementById('thinkText').textContent.includes('high')); assert.equal(w.document.getElementById('btnThink').disabled, true);
  });
  await check('stale state/levels never override final model capabilities', () => {
    const cmd = calls.filter(c => c.type === 'set_model').at(-1);
    w.onResponse({ command: 'set_model', id: cmd.id, success: true });
    const oldState = calls.filter(c => c.type === 'get_state').at(-1), oldLevels = calls.filter(c => c.type === 'get_available_thinking_levels').at(-1);
    w.setModel('c', 'new'); const next = calls.filter(c => c.type === 'set_model').at(-1);
    w.onResponse({ command: 'set_model', id: next.id, success: true });
    const currentState = calls.filter(c => c.type === 'get_state').at(-1), currentLevels = calls.filter(c => c.type === 'get_available_thinking_levels').at(-1);
    w.onResponse({ command: 'get_state', id: currentState.id, success: true, data: { model: { provider: 'c', id: 'new', input: ['text', 'image'] }, thinkingLevel: 'off' } });
    w.onResponse({ command: 'get_available_thinking_levels', id: currentLevels.id, success: true, data: { levels: [] } });
    w.onResponse({ command: 'get_state', id: oldState.id, success: true, data: { model: { provider: 'b', id: 'new', input: ['text'] } } });
    w.onResponse({ command: 'get_available_thinking_levels', id: oldLevels.id, success: true, data: { levels: ['high'] } });
    assert.equal(w.S.state.model.providerId, 'c'); assert.equal(w.imageInputBlocked(), false); assert.equal(w.S.thinkingLevels.length, 0);
  });
  await check('failed thinking readback leaves unavailable and no stale High', () => {
    w.refreshModelState(); const st = calls.filter(c => c.type === 'get_state').at(-1), lv = calls.filter(c => c.type === 'get_available_thinking_levels').at(-1);
    w.onResponse({ command: 'get_state', id: st.id, success: true, data: { model: { provider: 'a', id: 'm', reasoning: true }, thinkingLevel: 'high' } });
    w.onResponse({ command: 'get_available_thinking_levels', id: lv.id, success: false });
    assert.equal(w.S.modelSwitchPending, false); assert.equal(w.S.thinkingLevels.length, 0); assert.equal(w.document.getElementById('thinkText').textContent, '思考不可用');
  });
  await check('current-model Pi-only levels allow only that selection and await state', () => {
    w.onThinkingLevels({ levels: ['off', 'low'] }); const before = calls.filter(c => c.type === 'set_thinking_level').length;
    w.setThinkingLevel('high'); assert.equal(calls.filter(c => c.type === 'set_thinking_level').length, before);
    w.setThinkingLevel('low'); assert.equal(calls.filter(c => c.type === 'set_thinking_level').length, before + 1);
    assert.ok(!w.document.getElementById('thinkText').textContent.endsWith('low'));
    const st = calls.filter(c => c.type === 'get_state').at(-1);
    w.onResponse({ command: 'get_state', id: st.id, success: true, data: { model: { provider: 'a', id: 'm' }, thinkingLevel: 'off' } });
    assert.equal(w.document.getElementById('thinkText').textContent, '思考 off');
  });
  await check('workspace generation rejects prior-model readback', () => {
    w.refreshModelState(); const st = calls.filter(c => c.type === 'get_state').at(-1), lv = calls.filter(c => c.type === 'get_available_thinking_levels').at(-1);
    w.beginWorkspaceSwitch('fixture-next');
    w.onResponse({ command: 'get_state', id: st.id, success: true, data: { model: { provider: 'old', id: 'old', input: ['text'] } } });
    w.onResponse({ command: 'get_available_thinking_levels', id: lv.id, success: true, data: { levels: ['high'] } });
    assert.notEqual(w.S.state.model.providerId, 'old'); assert.equal(w.S.thinkingLevels.length, 0);
  });
  await check('boot after restart replaces capabilities from actual Pi state', () => {
    w.S.switching = false; w.S.bridgeState = 'ready'; w.boot(); const st = calls.filter(c => c.type === 'get_state').at(-1), lv = calls.filter(c => c.type === 'get_available_thinking_levels').at(-1);
    w.onResponse({ command: 'get_available_thinking_levels', id: lv.id, success: true, data: { levels: ['off', 'low'] } });
    w.onResponse({ command: 'get_state', id: st.id, success: true, data: { model: { provider: 'restart', id: 'new', input: ['text'] }, thinkingLevel: 'low' } });
    assert.equal(w.S.state.model.providerId, 'restart'); assert.equal(w.imageInputBlocked(), true); assert.equal(w.S.thinkingLevels.join(','), 'off,low');
  });
  await check('session state change drops prior thinking levels immediately', () => {
    w.applyState({ model: { provider: 'restart', id: 'new' }, sessionId: 'one', thinkingLevel: 'low' });
    w.onThinkingLevels({ levels: ['off', 'low'] });
    w.applyState({ model: { provider: 'restart', id: 'new' }, sessionId: 'two', thinkingLevel: 'high' });
    assert.equal(w.S.thinkingLevels.length, 0); assert.equal(w.document.getElementById('thinkText').textContent, '思考不可用');
  });
  await check('session-switch entry invalidates in-flight state and choices before delayed boot', () => {
    w.onThinkingLevels({ levels: ['off', 'high'] }); w.refreshModelState();
    const st = calls.filter(c => c.type === 'get_state').at(-1), lv = calls.filter(c => c.type === 'get_available_thinking_levels').at(-1);
    w.afterSessionSwitch();
    w.onResponse({ command: 'get_state', id: st.id, success: true, data: { model: { provider: 'old-session', id: 'old' } } });
    w.onResponse({ command: 'get_available_thinking_levels', id: lv.id, success: true, data: { levels: ['high'] } });
    assert.notEqual(w.S.state.model.providerId, 'old-session'); assert.equal(w.S.thinkingLevels.length, 0); assert.equal(w.S.modelSwitchPending, true);
  });
  dom.window.close();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
