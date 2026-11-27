'use strict';
const fs = require('node:fs'), path = require('node:path');
const h = require('./visual-replies-support.cjs');
function prepareNormalPi(world) {
  const shim = h.prepareFakePi(world), pkg = path.join(world, 'node_modules/@earendil-works/pi-coding-agent');
  fs.copyFileSync(path.join(__dirname, 'visual-replies-normal-pi.cjs'), path.join(pkg, 'cli.cjs'));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.6.0', bin: { pi: 'cli.cjs' } }));
  // Excerpts from installed Pi 1.6 public declarations, not a pretend extra RPC.
  fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), `
export interface ExtensionAPI {
 on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
 on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
 on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
 on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
 on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
 getAllTools(): ToolInfo[];
 registerTool<T>(definition: ToolDefinition<T>): void;
}
export interface ToolDefinition<T> { promptSnippet?: string; promptGuidelines?: string[]; execute(toolCallId: string, params: T): Promise<unknown>; }
export interface ToolCallEventResult { block?: boolean; reason?: string; }
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
`);
  fs.writeFileSync(path.join(pkg, 'dist/core/session-manager.d.ts'), 'export declare class SessionManager { getSessionId(): string; getLeafId(): string | null; getBranch(leafId?: string): SessionEntry[]; }');
  const samplesFile = path.join(world, 'normal-samples.json');
  fs.writeFileSync(samplesFile, JSON.stringify(require('./visual-replies-normal-samples.cjs').getNormalSamples()), { flag: 'wx' });
  return { PI_BIN: shim, VISUAL_REPLIES_SAMPLES: samplesFile };
}
function copyElectron(world, sourceExecutable) {
  h.validateWorld(world);
  const target = path.join(world, 'electron-runtime');
  fs.cpSync(path.dirname(sourceExecutable), target, { recursive: true, errorOnExist: true, force: false });
  const executable = path.join(target, path.basename(sourceExecutable));
  const sourceSha256 = h.digest(sourceExecutable), copiedSha256 = h.digest(executable);
  if (sourceSha256 !== copiedSha256) throw Error('electron_copy_digest_mismatch');
  return { executable, sourceSha256, copiedSha256, strategy: 'complete-existing-offline-dist-copy-to-new-os.tmpdir' };
}
const MATRIX = Object.freeze({ widths: [700, 1320], themes: ['dark', 'light'], modes: ['inline', 'fullscreen', 'zoom'],
  behaviors: ['dynamic-height', 'scroll', 'multiple-artifacts', 'session-switch', 'restart'] });
function samplesFor(mode) {
  const samples = require('./visual-replies-normal-samples.cjs');
  if (mode === 'live') return [samples.normalSample('filter-panel')];
  if (mode === 'offline') return samples.getNormalSamples();
  throw Error('invalid_functional_mode');
}
function livePrompt(row) {
  return 'Create a small self-contained interactive Tasks panel using the actual html_render tool exactly once. '
    + 'Do not write files, use other tools, fetch external resources, or return a code block. '
    + 'Use title=' + JSON.stringify(row.title) + ', height=' + row.height + '. '
    + 'In the HTML use body data-sample="filter-panel", button id="sample-action", and output id="sample-state". '
    + 'Show Code, Tests, Docs tasks. Set document.documentElement.dataset.sampleReady="true" after setup. '
    + 'Clicking the button filters to Tests, sets output text to "1 matching task" and dataset.interacted="1". '
    + 'After html_render succeeds, stream a short text starting VR_LIVE_FOLLOWUP. Do not call any second tool.';
}
function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = result => { clearTimeout(timer); child.removeListener('exit', onExit); resolve(result); };
    const onExit = () => done(true), timer = setTimeout(() => done(false), ms);
    child.once('exit', onExit);
  });
}
const FAILURE_CODES = new Set(['invalid_functional_mode', 'live_opt_in_required', 'explicit_model_authorization_required',
  'explicit_live_selection_required', 'explicit_credential_authorization_required', 'explicit_fixture_credential_required',
  'invalid_explicit_endpoint', 'invalid_explicit_selection', 'explicit_absolute_pi_bin_required', 'pi_entry_unavailable',
  'windows_required', 'functional_phase_failed', 'real_model_evidence_missing', 'electron_copy_digest_mismatch']);
function failureCode(error) { return FAILURE_CODES.has(error?.message) ? error.message : 'functional_runner_failed'; }
async function checkDriver() {
  const assert = require('node:assert/strict');
  const { authorizeLive, prepareLiveModel } = require('./visual-replies-live.cjs');
  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
  const valid = () => ({ PI_GUI_VISUAL_REPLIES_LIVE: '1', PI_GUI_VISUAL_REPLIES_AUTHORIZE_MODEL_CALLS: '1',
    PI_GUI_VISUAL_REPLIES_PROVIDER: 'fixture', PI_GUI_VISUAL_REPLIES_MODEL: 'no-model',
    PI_GUI_VISUAL_REPLIES_API: 'openai-completions', PI_GUI_VISUAL_REPLIES_ENDPOINT: 'http://127.0.0.1:1/v1',
    PI_GUI_VISUAL_REPLIES_PI_BIN: path.join(require('node:os').tmpdir(), 'not-an-installed-pi.cmd'),
    PI_GUI_VISUAL_REPLIES_AUTHORIZE_CREDENTIAL: 'PI_GUI_VISUAL_REPLIES_KEY', PI_GUI_VISUAL_REPLIES_KEY: 'fixture-not-a-real-key' });
  for (const [key, code] of [['LIVE', 'live_opt_in_required'], ['AUTHORIZE_MODEL_CALLS', 'explicit_model_authorization_required'],
    ...['PROVIDER', 'MODEL', 'PI_BIN', 'API', 'ENDPOINT'].map(key => [key, 'explicit_live_selection_required']),
    ['AUTHORIZE_CREDENTIAL', 'explicit_credential_authorization_required'], ['KEY', 'explicit_fixture_credential_required']]) {
    check('gate-required-' + key.toLowerCase(), () => {
      const env = valid(); delete env['PI_GUI_VISUAL_REPLIES_' + key]; assert.throws(() => authorizeLive(env), { message: code });
    });
  }
  check('explicit-selection-no-default-substitution', () => assert.equal(authorizeLive(valid()).model, 'no-model'));
  check('invalid-url-error-never-echoes-input', () => assert.throws(() => authorizeLive({ ...valid(), PI_GUI_VISUAL_REPLIES_ENDPOINT: 'invalid' }), { message: 'invalid_explicit_endpoint' }));
  check('endpoint-no-embedded-credentials', () => assert.throws(() => authorizeLive({ ...valid(), PI_GUI_VISUAL_REPLIES_ENDPOINT: 'http://fixture:fixture@127.0.0.1/' })));
  check('selected-env-reference-only', () => {
    const env = { ...valid(), PI_GUI_VISUAL_REPLIES_KEY_ENV: 'FIXTURE_API_KEY', PI_GUI_VISUAL_REPLIES_AUTHORIZE_CREDENTIAL: 'FIXTURE_API_KEY', FIXTURE_API_KEY: 'fixture' };
    assert.equal(authorizeLive(env).credentialVariable, 'FIXTURE_API_KEY'); delete env.FIXTURE_API_KEY; assert.throws(() => authorizeLive(env));
  });
  check('credential-variable-cannot-be-runtime-setting', () => assert.throws(() => authorizeLive({ ...valid(), PI_GUI_VISUAL_REPLIES_KEY_ENV: 'PATH', PI_GUI_VISUAL_REPLIES_AUTHORIZE_CREDENTIAL: 'PATH', PATH: 'fixture' })));
  check('offline-six-benign-samples', () => assert.equal(samplesFor('offline').length, 6));
  check('live-one-short-model-prompt-only', () => {
    assert.deepEqual(samplesFor('live').map(row => row.id), ['filter-panel']);
    assert.ok(livePrompt(samplesFor('live')[0]).includes('exactly once'));
    assert.ok(!livePrompt(samplesFor('live')[0]).includes('<html'));
  });
  check('direct-functional-entry-rejects-unknown-and-mixed-modes', () => {
    const { modeFor } = require('../visual-replies-functional.cjs');
    assert.equal(modeFor([]), 'offline'); assert.equal(modeFor(['--live']), 'live');
    assert.throws(() => modeFor(['--unknown'])); assert.throws(() => modeFor(['--offline', '--live']));
  });
  check('unknown-errors-project-to-constant', () => assert.equal(failureCode(Error('arbitrary_private_value')), 'functional_runner_failed'));
  await assert.rejects(prepareLiveModel('not-a-fixture', {}), { message: 'live_opt_in_required' });
  passed++; console.log('PASS gate-before-import-read-or-fixture-validation');
  check('unauthorized-live-entry-stops-before-imports', () => {
    let imports = 0, status;
    const stopped = Symbol('stopped');
    const prefix = fs.readFileSync(path.join(__dirname, '../visual-replies-electron.cjs'), 'utf8').split("const fs = require('node:fs');")[0];
    assert.throws(() => require('node:vm').runInNewContext(prefix, {
      process: { argv: ['node', 'entry', '--live'], env: {}, exit(code) { status = code; throw stopped; } },
      require() { imports++; }, console: { error() {} },
    }), value => value === stopped);
    assert.equal(status, 2); assert.equal(imports, 0);
  });
  check('live-helper-import-is-pure', () => {
    let imports = 0;
    require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, 'visual-replies-live.cjs'), 'utf8'), {
      module: { exports: {} }, require() { imports++; throw Error('unexpected_import'); },
    });
    assert.equal(imports, 0);
  });
  const world = h.createWorld();
  const env = valid(); env.PI_GUI_VISUAL_REPLIES_PI_BIN = h.prepareFakePi(world);
  const selected = await prepareLiveModel(world, env);
  check('authorized-fixture-keeps-key-out-of-disk-config', () => {
    const text = fs.readFileSync(path.join(world, 'agent/models.json'), 'utf8');
    assert.ok(!text.includes(env.PI_GUI_VISUAL_REPLIES_KEY));
    assert.equal(JSON.parse(text).providers.fixture.apiKey, '$PI_GUI_VISUAL_REPLIES_KEY');
    assert.equal(fs.existsSync(path.join(world, 'agent/auth.json')), false);
  });
  check('only-authorized-key-in-child-environment', () => {
    const clean = h.childEnvironment(world, { PATH: 'fixture', UNSELECTED_API_KEY: 'fixture' });
    assert.equal(clean.UNSELECTED_API_KEY, undefined);
    assert.equal(selected.env.PI_GUI_VISUAL_REPLIES_KEY, env.PI_GUI_VISUAL_REPLIES_KEY);
    assert.equal(selected.env.PI_GUI_OFFLINE, '1'); assert.equal(selected.env.PI_OFFLINE, '0');
    assert.equal(Object.hasOwn(clean, 'ELECTRON_RUN_AS_NODE'), false);
  });
  check('live-retry-disabled', () => assert.equal(JSON.parse(fs.readFileSync(path.join(world, 'agent/settings.json'), 'utf8')).retry.enabled, false));
  check('live-output-budget-bounded', () => assert.equal(JSON.parse(fs.readFileSync(path.join(world, 'agent/models.json'), 'utf8')).providers.fixture.models[0].maxTokens, 2048));
  check('normal-entry-dispatches-only-ordinary-modes', () => {
    const entry = require('../visual-replies-electron.cjs');
    assert.equal(entry.modeFor([]), 'offline'); assert.equal(entry.modeFor(['--live']), 'live');
    assert.throws(() => entry.modeFor(['--offline', '--live']));
  });
  const entryModule = { exports: {} }, dispatched = [];
  const entryRequire = name => name === './visual-replies-functional.cjs'
    ? { run(mode) { dispatched.push(mode); return 0; } } : name === './fixtures/visual-replies-support.cjs' ? h : require(name);
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../visual-replies-electron.cjs'), 'utf8'), {
    module: entryModule, require: entryRequire, process: { argv: ['node', 'entry'], env: {}, platform: 'win32' }, console,
  });
  await entryModule.exports.launch('offline'); await entryModule.exports.launch('live');
  check('normal-entry-actually-dispatches-functional-runner', () => assert.deepEqual(dispatched, ['offline', 'live']));
  const child = new (require('node:events').EventEmitter)(); child.exitCode = null; child.signalCode = null;
  assert.equal(await waitForExit(child, 1), false); assert.equal(child.listenerCount('exit'), 0);
  passed++; console.log('PASS bounded-exit-wait-removes-listener');
  h.saveJson(path.join(world, 'evidence/functional-driver-checks.json'), { passed, failed: 0,
    realPi: false, modelCalls: 0, userConfigRead: false, authRead: false, electronSpawned: false });
  console.log(`Visual Replies functional driver: ${passed}/${passed}; evidence=${path.join(world, 'evidence')}`);
  return passed;
}
module.exports = { prepareNormalPi, copyElectron, MATRIX, samplesFor, livePrompt, waitForExit, failureCode, checkDriver };
