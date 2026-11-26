/* Observation bootstrap: loads the unmodified production main, backend,
 * preload and renderer. No fake Pi, API replacement, SSE injection or registry
 * factory is used. Test driver calls only public HTTP/RPC/UI boundaries.
 */
// Offline syntax check for every literal renderer expression, including both
// API branches. This deliberately accepts only literal call arguments: adding
// a new dynamic expression requires extending the checker, not silently
// excluding it. No Electron/Pi/config/network is loaded by this mode.
function validateRendererScripts() {
  const vm = require('node:vm');
  const source = require('node:fs').readFileSync(__filename, 'utf8');
  const literals = [...source.matchAll(/\bread\s*\(\s*(`(?:\\[\s\S]|[^`])*`|'(?:\\.|[^'\\])*')/g)];
  const expected = [...source.matchAll(/\bread\s*\(/g)].length - 1; // declaration
  if (literals.length !== expected) throw Error('renderer_check_unsupported_call');
  const sample = { selector: '#runtimeView textarea[data-probe="a\\b"]', sendSelector: '#runtimeView .rtc-send',
    id: 'fixture-conversation', ids: ['fixture-B', 'fixture-C'], projects: ['C:/Temp/pi-parallel-live-fixture/project-one', 'C:/Temp/pi-parallel-live-fixture/project-two'], world: 'C:\\Temp\\pi-parallel-live-quote\'fixture',
    route: '/api/runtime-sessions', theme: 'dark', providerLabel: 'fixture-provider', beforeReload: [{ conversationId: 'fixture-B', runtimeId: 'fixture-runtime' }] };
  for (const body of [null, { action: 'read', owner: { sessionId: 'fixture-session' }, command: { type: 'get_state' } }]) {
    for (const [literal] of literals.map(match => [match[1]])) {
      const script = new vm.Script(literal).runInNewContext({ ...sample, body }, { timeout: 1000 });
      new vm.Script(script);
    }
  }
  return { templates: literals.length, variants: literals.length * 2 };
}
async function closeRuntimeOwners(call) {
  let confirmed = true; const codes = [];
  try {
    const snapshot = await call();
    if (!Array.isArray(snapshot.items)) confirmed = false;
    for (const item of snapshot.items || []) if (item.owner) {
      const closed = await call({ action: 'close', owner: item.owner });
      if (closed.ok !== true) { confirmed = false; codes.push(closed.code === 'cleanup_pending' ? 'cleanup_pending' : 'close_rejected'); }
    }
    const remaining = await call();
    if (!Array.isArray(remaining.items) || remaining.items.some(item => item.owner)) confirmed = false;
  } catch { confirmed = false; codes.push('close_exception'); }
  return { confirmed, codes };
}
async function runOfflineSafetyChecks() {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
  const assert = require('node:assert/strict'), cp = require('node:child_process'), { createHash } = require('node:crypto');
  const root = path.resolve(__dirname, '../..'), source = fs.readFileSync(path.join(root, 'tests/parallel-runtime-live.cjs'), 'utf8');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-parallel-driver-safety-'));
  const checks = [], verify = (name, fn) => { fn(); checks.push({ name, pass: true }); };
  const env = { ...process.env, GIT_DIR: path.join(temp, 'outside/.git'), GIT_WORK_TREE: path.join(temp, 'outside'),
    GIT_INDEX_FILE: path.join(temp, 'outside-index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: temp,
    git_config_parameters: "'core.hooksPath=hostile'", GIT_CONFIG: path.join(temp, 'outside-config') };
  const helpers = source.split('// SAFETY_HELPERS_BEGIN')[1].split('\n').slice(1).join('\n').split('// SAFETY_HELPERS_END')[0];
  const h = vm.runInNewContext(helpers + '\n({gitEnv,git,phaseValid,acceptanceComplete,requiredChecks,sameProcess,canTerminate,processFamily})',
    { process: { env }, path, execFileSync: cp.execFileSync, createHash });
  verify('default off exits before imports', () => {
    const stop = Symbol('exit'); let imports = 0, exit;
    try { vm.runInNewContext(source.slice(0, source.indexOf("const fs = require")), {
      process: { env: {}, exit(code) { exit = code; throw stop; } }, console: { log() {} }, require() { imports++; },
    }); } catch (error) { assert.equal(error, stop); }
    assert.equal(exit, 0); assert.equal(imports, 0);
  });
  verify('all inherited Git overrides cleared including mixed case', () => {
    const clean = h.gitEnv(temp, env);
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG', 'git_config_parameters']) assert.equal(clean[key], undefined);
    assert.equal(clean.GIT_ALLOW_PROTOCOL, ''); assert.equal(clean.GIT_CONFIG_NOSYSTEM, '1');
  });
  verify('real TEMP Git cannot redirect config/index or invoke hooks', () => {
    const outside = path.join(temp, 'outside'), inside = path.join(temp, 'inside'); fs.mkdirSync(outside); fs.mkdirSync(inside);
    h.git(outside, 'init', '-b', 'main'); h.git(outside, 'config', 'user.name', 'Outside Fixture');
    const before = fs.readFileSync(path.join(outside, '.git/config'));
    h.git(inside, 'init', '-b', 'main'); h.git(inside, 'config', 'user.name', 'Inside Fixture'); h.git(inside, 'config', 'user.email', 'fixture@example.invalid');
    const hook = path.join(inside, '.git/hooks/pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 97\n'); fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(inside, 'fixture.txt'), 'synthetic'); h.git(inside, 'add', '.'); h.git(inside, 'commit', '-m', 'fixture baseline');
    assert.deepEqual(fs.readFileSync(path.join(outside, '.git/config')), before);
    assert.equal(fs.existsSync(path.join(temp, 'outside-index')), false);
    assert.equal(h.git(inside, 'config', '--get', 'user.name'), 'Inside Fixture');
  });
  const valid = phase => ({ phase, completed: true, failed: 0, endedAt: new Date().toISOString(), exit: { code: 0, signal: null },
    cleanup: { confirmed: true }, processCleanup: { confirmed: true },
    checks: [...h.requiredChecks.common, ...h.requiredChecks[phase]].map(name => ({ name, pass: true })) });
  verify('complete explicit phase is accepted', () => assert.equal(h.phaseValid(valid('recovery'), 'recovery'), true));
  for (const [name, mutate] of [
    ['missing failed count', report => { delete report.failed; }], ['missing ended marker', report => { delete report.endedAt; }],
    ['unfinished phase', report => { report.completed = false; }], ['nonzero exit', report => { report.exit.code = 1; }],
    ['signal exit', report => { report.exit = { code: null, signal: 'SIGTERM' }; }], ['missing required check', report => { report.checks.pop(); }],
    ['failed check', report => { report.checks[0].pass = false; }], ['unconfirmed public close', report => { report.cleanup.confirmed = false; }],
    ['unconfirmed process exit', report => { report.processCleanup.confirmed = false; }],
  ]) verify('fail closed: ' + name, () => { const report = valid('recovery'); mutate(report); assert.equal(h.phaseValid(report, 'recovery'), false); });
  verify('missing recovery cannot qualify complete', () => assert.equal(h.acceptanceComplete([valid('exercise')], ['exercise', 'recovery'], true), false));
  verify('privacy scan failure cannot qualify complete', () => assert.equal(h.acceptanceComplete([valid('exercise'), valid('recovery')], ['exercise', 'recovery'], false), false));
  const original = { pid: 42, birth: '0001', exeSha256: 'fixture-exe', commandSha256: 'fixture-cmd', marker: true };
  const live = { pid: 42, exitCode: null, signalCode: null };
  verify('exact live process identity permits bounded fallback', () => assert.equal(h.canTerminate(live, original, original), true));
  verify('signal-exited handle never permits kill', () => assert.equal(h.canTerminate({ ...live, signalCode: 'SIGTERM' }, original, original), false));
  verify('reused PID never permits kill', () => assert.equal(h.canTerminate(live, original, { ...original, birth: '0002' }), false));
  verify('changed command line never permits kill', () => assert.equal(h.canTerminate(live, original, { ...original, commandSha256: 'other' }), false));
  verify('missing original witness never permits kill', () => assert.equal(h.canTerminate(live, null, original), false));
  verify('PID-reused root cannot own a process family', () => assert.equal(h.processFamily([{ ...original, birth: '0002' }], original).length, 0));
  const pending = await closeRuntimeOwners(async body => body ? { ok: false, code: 'cleanup_pending' } : { items: [{ owner: original }] });
  verify('cleanup_pending is acceptance failure', () => { assert.equal(pending.confirmed, false); assert.equal(pending.codes[0], 'cleanup_pending'); });
  const rejected = await closeRuntimeOwners(async () => { throw Error('synthetic'); });
  verify('cleanup exception is acceptance failure', () => assert.equal(rejected.confirmed, false));
  let closed = false;
  const clean = await closeRuntimeOwners(async body => { if (body) { closed = true; return { ok: true }; } return { items: closed ? [] : [{ owner: original }] }; });
  verify('confirmed close plus no live owner is accepted', () => assert.equal(clean.confirmed, true));
  verify('configured fixture key uses environment reference, never literal', () => assert.match(source, /apiKey: '\$PI_GUI_PARALLEL_KEY'/));
  if (process.env.PI_GUI_PARALLEL_RESOLVER) {
    const resolver = fs.readFileSync(process.env.PI_GUI_PARALLEL_RESOLVER, 'utf8');
    const pure = resolver.slice(resolver.indexOf('const ENV_VAR_NAME_RE'), resolver.indexOf('export function getConfigValueEnvVarName('));
    const parse = value => vm.runInNewContext(pure + '\nresolveTemplate(parseConfigValueTemplate(value), fixtureEnv)', { value,
      fixtureEnv: { PI_GUI_PARALLEL_KEY: 'synthetic-key' }, process: { env: {} } });
    verify('actual upstream pure parser rejects bare env name as reference', () => assert.equal(parse('PI_GUI_PARALLEL_KEY'), 'PI_GUI_PARALLEL_KEY'));
    verify('actual upstream pure parser resolves dollar env reference', () => assert.equal(parse('$PI_GUI_PARALLEL_KEY'), 'synthetic-key'));
  }
  const result = { kind: 'offline-driver-regressions-not-model-evidence', checks, passed: checks.length, failed: 0,
    sourceSha256: createHash('sha256').update(source).digest('hex'), endedAt: new Date().toISOString(), realUserDataTouched: false };
  fs.writeFileSync(path.join(temp, 'safety.json'), JSON.stringify(result, null, 2));
  console.log(`Parallel driver safety: ${checks.length}/${checks.length}; evidence=${temp}`);
}
const safetyOnly = process.argv.includes('--check-safety');
if (safetyOnly) runOfflineSafetyChecks().catch(error => { console.error('Parallel driver safety: failed (' + error.name + ')'); process.exitCode = 1; });
if (process.argv.includes('--check-driver')) {
  try { const checked = validateRendererScripts(); console.log(`Parallel renderer syntax: ${checked.variants}/${checked.variants} (${checked.templates} templates; no Electron/Pi/model)`); }
  catch { console.error('Parallel renderer syntax: failed'); process.exit(1); }
  process.exit(0);
}
if (!safetyOnly) {
if (process.env.PI_GUI_PARALLEL_LIVE !== '1' || !process.versions.electron) process.exit(2);
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');
const world = process.env.PARALLEL_WORLD;
const phase = process.env.PARALLEL_PHASE;
const providerLabel = process.env.PI_PROVIDER || '';
if (!world || !path.isAbsolute(world) || !path.basename(world).startsWith('pi-parallel-live-')) process.exit(2);
const out = path.join(world, 'evidence');
const projects = JSON.parse(process.env.PARALLEL_PROJECTS || 'null');
if (!Array.isArray(projects) || projects.length !== 2 || projects.some(cwd => typeof cwd !== 'string' || !path.isAbsolute(cwd))) process.exit(2);
app.setPath('userData', path.join(world, 'profile'));
app.setPath('logs', path.join(world, 'logs'));
require(process.env.PARALLEL_APP_MAIN);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, previousEvents = [], stage = 'startup';
const report = { phase, platform: process.platform, startedAt: new Date().toISOString(), checks: [], shots: [], facts: {}, events: [] };
function save() { fs.writeFileSync(path.join(out, phase + '.json'), JSON.stringify(report, null, 2)); }
function check(pass, name, details) {
  report.checks.push({ name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) }); save();
  console.log((pass ? 'PASS ' : 'FAIL ') + name);
  return Boolean(pass);
}
function requireCheck(pass, name, details) { if (!check(pass, name, details)) throw Error('check_failed'); }
function mark(name) { stage = name; report.stage = stage; save(); console.log('STAGE ' + name); }
async function read(source) {
  try {
    new (require('node:vm').Script)(source);
    return await win.webContents.executeJavaScript(source, true);
  }
  catch (error) {
    // Only classify our driver errors; never save Electron's arbitrary text.
    const code = /await is only valid|Unexpected reserved word/.test(error.message) ? 'renderer_await_syntax'
      : /missing_target/.test(error.message) ? 'missing_target'
        : /target_hidden/.test(error.message) ? 'target_hidden' : 'renderer_evaluation_failed';
    report.facts.driverFailure = { code, scriptSha256: require('node:crypto').createHash('sha256').update(source).digest('hex') };
    throw Object.assign(Error(code), { code });
  }
}
async function until(fn, name, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(100); }
  report.timeout = name; throw Error('condition_timeout');
}
async function api(body, route = '/api/runtime-sessions') {
  // main.cjs adds its own token header. Neither driver nor renderer receives it.
  return read(`(async()=>{const {S}=await import('/state.js');const options=${body ? JSON.stringify({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) : '{}'};
    if(options.method&&S.legacyOwner)options.headers['X-Pi-Gui-Owner']=JSON.stringify(S.legacyOwner);
    const response=await fetch(${JSON.stringify(route)},options);return response.json();})()`);
}
async function click(selector) {
  const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing_target');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(r.width<1||r.height<1)throw Error('target_hidden');return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function sendText(selector, text, sendSelector) {
  await click(selector);
  await win.webContents.debugger.sendCommand('Input.insertText', { text });
  await until(() => read(`!document.querySelector(${JSON.stringify(sendSelector)})?.disabled`), 'composer_ready');
  await click(sendSelector);
}
async function attachObserver() {
  await read(`(async()=>{
    const {classifyGenerationError,safeFallbackFailure}=await import('/model-fallback.js');
    const classes=['rate_limited','quota_exhausted','provider_unavailable','retryable_provider_error','model_unavailable','auth_error','request_incompatible','context_overflow','user_cancelled','unknown'];
    const failureClass=event=>{
      if(event.generationResult?.failure)return safeFallbackFailure(event.generationResult.failure).class;
      const message=event.message;
      if(message?.role!=='assistant'||!['error','aborted'].includes(message.stopReason))return null;
      // Production already normalizes error strings. Compare known public
      // reasons before trying the same classifier; never retain the string.
      return classes.find(value=>safeFallbackFailure({class:value}).reason===message.errorMessage)
        ||classifyGenerationError({message:message.errorMessage,source:'pi-assistant',stopReason:message.stopReason}).class;
    };
    window.__parallelEvents=[];window.__parallelOnline=false;
    window.__parallelStream=new EventSource('/api/events');
    __parallelStream.onopen=()=>{__parallelOnline=true;};
    __parallelStream.onmessage=message=>{
      let frame;try{frame=JSON.parse(message.data);}catch{return;}
      const event=frame.type==='runtime_event'?frame.event:frame;
      const allowed=['agent_start','agent_end','agent_settled','tool_execution_start','tool_execution_end','tool_wait_state','bridge_status','extension_error','message_end','generation_result'];
      const rejectedPrompt=event?.type==='response'&&['prompt','steer','follow_up'].includes(event.command)&&event.success===false;
      if(!allowed.includes(event?.type)&&!['runtime_state','runtime_closed'].includes(frame.type)&&!rejectedPrompt)return;
      const owner=frame.owner||frame.legacyOwner||null;
      __parallelEvents.push({at:Date.now(),seq:frame._seq,eventSequence:frame.eventSequence||null,
        kind:frame.type,type:event.type,owner,bridgeRun:frame.bridgeRun||null,
        lifecycle:frame.item?.lifecycle||null,activity:frame.item?.activity||null,
        toolName:event.toolName||null,toolCallId:event.toolCallId||null,isError:event.isError===true,
        waiting:event.type==='tool_wait_state'?event.waiting:null,
        outcome:['success','failed','unknown'].includes(event.generationResult?.outcome)?event.generationResult.outcome:rejectedPrompt?'failed':null,
        stopReason:['error','aborted','stop','length','toolUse'].includes(event.message?.stopReason)?event.message.stopReason:null,
        failureClass:failureClass(event)});
      if(__parallelEvents.length>20000)__parallelEvents.shift();
    };
  })()`);
  await until(() => read('__parallelOnline'), 'observer_sse_open');
}
async function events() {
  const list = await read('window.__parallelEvents||[]');
  const merged = new Map();
  // SSE reconnect replays earlier frames. Keep the FIRST observation time,
  // never overwrite it with the replay receipt after a renderer reload.
  for (const event of [...previousEvents, ...list]) if (!merged.has(event.seq)) merged.set(event.seq, event);
  report.events = [...merged.values()].sort((a, b) => a.seq - b.seq);
  return report.events;
}
async function untilTask(fn, name, owners, timeout = 120000) {
  await until(async () => {
    if (await fn()) return true;
    const observed = await events();
    for (const owner of owners) {
      const own = observed.filter(event => event.owner?.sessionId === owner.sessionId
        && event.owner?.runtimeId === owner.runtimeId);
      const lastStart = own.findLastIndex(event => event.type === 'agent_start');
      const turn = own.slice(Math.max(0, lastStart));
      const terminal = turn.findLast(event => event.type === 'agent_settled'
        || event.type === 'response' && event.outcome === 'failed');
      if (!terminal) continue;
      const failed = turn.findLast(event => event.failureClass || event.stopReason === 'error' || event.outcome === 'failed');
      report.facts.taskFailure = { expected: name, owner, seq: terminal.seq, at: terminal.at,
        outcome: failed ? 'failed' : terminal.outcome || 'unknown', failureClass: failed?.failureClass || null };
      throw Error(failed ? 'model_request_failed' : 'task_ended_before_expected');
    }
    return false;
  }, name, timeout);
}
async function state(owner) { return owner ? api({ action: 'read', owner, command: { type: 'get_state' } }) : api(null, '/api/status'); }
async function focus(id) {
  const selector = `.pj-runtime[data-conversation-id="${id}"] .pj-sess-primary`;
  if (await read(`!!document.querySelector(${JSON.stringify(selector)})`)) await click(selector);
  else await read(`(async()=>{await (await import('/runtime-nav.js')).focusRuntimeById(${JSON.stringify(id)});})()`);
  await until(() => read(`document.querySelector('#runtimeView .runtime-conversation')?.dataset.conversationId===${JSON.stringify(id)}&&!document.querySelector('#runtimeView').hidden`), 'runtime_visible');
}
async function recordProjection(ids) {
  return read(`(async()=>{const {runtimeStore}=await import('/runtime-state.js');return ${JSON.stringify(ids)}.map(id=>{const r=runtimeStore.get(id);return{id,owner:r?.owner,cursor:r?.cursor,lifecycle:r?.item?.lifecycle,activity:r?.item?.activity,
    hasA:r?.text?.includes('A_')||false,hasB:r?.text?.includes('B_')||false,hasC:r?.text?.includes('C_')||false,
    tools:(r?.tools||[]).map(t=>({name:t.toolName||t.name||null,state:t.status||null})),timelineKinds:(r?.timeline||[]).map(b=>b.kind)};});})()`);
}
async function shot(name, width = 1320, height = 820, theme = 'dark') {
  win.setContentSize(width, height); await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await sleep(250);
  const metrics = await read(`({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme,scrollWidth:document.documentElement.scrollWidth})`);
  // Find sensitive text rectangles without changing the DOM/layout, then mask
  // only those pixels in the real capture. Retain coordinates, never text.
  const rectangles = await read(`(()=>{const paths=${JSON.stringify([world, ...projects].flatMap(value => [value, value.replaceAll('\\', '/')]))};const provider=${JSON.stringify(providerLabel)};const needles=[...new Set(paths)].map(text=>({text,kind:'fixture-path'}));if(provider)needles.push({text:provider,kind:'provider-alias'});const found=[];const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;while(node=walk.nextNode()){if(node.parentElement?.closest('script,style'))continue;for(const {text,kind} of needles){let offset=0;while(text&&(offset=node.nodeValue.indexOf(text,offset))!==-1){const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+text.length);for(const r of range.getClientRects())if(r.width&&r.height)found.push({kind,x:r.x,y:r.y,width:r.width,height:r.height});offset+=text.length;}}}return found;})()`);
  const capture = await win.webContents.capturePage(), size = capture.getSize({ scaleFactor: 1 });
  const pixels = capture.toBitmap({ scaleFactor: 1 });
  if (pixels.length !== size.width * size.height * 4) throw Error('capture_bitmap_shape');
  const masked = rectangles.map(rect => {
    const left = Math.max(0, Math.floor(rect.x * size.width / metrics.width) - 2);
    const top = Math.max(0, Math.floor(rect.y * size.height / metrics.height) - 2);
    const right = Math.min(size.width, Math.ceil((rect.x + rect.width) * size.width / metrics.width) + 2);
    const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height) * size.height / metrics.height) + 2);
    return { kind: rect.kind, x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }).filter(rect => rect.width && rect.height);
  for (const rect of masked) for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const offset = (y * size.width + x) * 4; pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 24; pixels[offset + 3] = 255;
  }
  const file = name + '.png';
  fs.writeFileSync(path.join(out, file), nativeImage.createFromBitmap(pixels, { ...size, scaleFactor: 1 }).toPNG());
  report.shots.push({ file, metrics, pixelSize: size, masked, redaction: 'opaque pixel rectangles only; unchanged DOM/layout and all unmasked capture pixels' }); save();
}
function marker(cwd, label, suffix = '-started.flag') { return fs.existsSync(path.join(cwd, label + suffix)); }
function release(cwd, label) { fs.writeFileSync(path.join(cwd, 'release-' + label + '.flag'), 'release'); }
const task = label => `This is an authorized temporary fixture acceptance task. Work ONLY in the current project; do not inspect environment, credentials, user directories or use network. Use the native write tool to write ${label.toLowerCase()}-native.txt with exactly ${label}_NATIVE_WRITE. Use the native read tool to verify it. Then use bash to run exactly node hold.cjs ${label} and WAIT for the command to finish (do not background it). Then use the native write tool to write ${label.toLowerCase()}-done.txt with exactly ${label}_DONE, and the native read tool to verify it. Reply only ${label}_OK. Do not modify hold.cjs, flags, or any other files.`;
async function waitReady() {
  await until(async () => {
    try {
      const status = await state();
      report.facts.lastStatus = { state: status.state, hasProject: status.hasProject, legacyOwner: status.legacyOwner, error: status.error ? 'present' : null };
      return status.state === 'ready' && Boolean(status.legacyOwner?.sessionId);
    } catch { return false; }
  }, 'classic_pi_ready', 65000);
}
async function exercise() {
  mark('classic_ready'); await waitReady();
  const primary = await state(); const ownerA = primary.legacyOwner;
  report.facts.A = { owner: ownerA, kind: 'classic' };
  const initial = await api();
  requireCheck(initial.totalCount === 1 && initial.hardLimit === 3 && initial.limit === 2, 'production resource budget starts at classic 1; limit 2 hard cap 3', { totalCount: initial.totalCount, limit: initial.limit, hardLimit: initial.hardLimit });
  mark('start_A_real_tools');
  await sendText('#input', task('A'), '#btnSend');
  await untilTask(() => marker(projects[0], 'A'), 'A_real_shell_started', [ownerA]);
  requireCheck(fs.readFileSync(path.join(projects[0], 'a-native.txt'), 'utf8').trim() === 'A_NATIVE_WRITE', 'A native write/read reached the real delay shell');
  mark('open_B_same_project');
  await click('#navNew');
  let snapshot, ownerB;
  await until(async () => { snapshot = await api(); ownerB = snapshot.items.find(item => item.owner?.sessionId)?.owner; return Boolean(ownerB) && snapshot.items.find(item => item.conversationId === ownerB.conversationId)?.lifecycle === 'ready'; }, 'B_native_identity', 65000);
  report.facts.B = { owner: ownerB, kind: 'runtime', sameProjectAsA: true };
  requireCheck(ownerB.sessionId !== ownerA.sessionId && snapshot.totalCount === 2, 'B has a distinct native Pi identity without replacing A');
  await focus(ownerB.conversationId);
  await sendText('#runtimeView textarea', task('B'), '#runtimeView .rtc-send');
  await untilTask(async () => (await events()).some(event => event.owner?.conversationId === ownerB.conversationId && event.type === 'agent_start'), 'B_agent_start', [ownerB], 90000);
  requireCheck(!fs.existsSync(path.join(projects[0], 'b-native.txt')), 'same-project B write remains behind A shell write lease');
  mark('open_C_other_project_third_confirmation');
  const otherProject = `.project[data-project-path=${JSON.stringify(projects[1])}] .pj-header-action`;
  await click(otherProject);
  await until(() => read(`!document.querySelector('#confirmLayer')?.hidden&&document.querySelector('#confirmCard').textContent.includes('启动第三个会话')`), 'third_confirmation');
  requireCheck((await api()).totalCount === 2, 'third-session confirmation does not preempt or increase the budget');
  await read(`[...document.querySelectorAll('#confirmCard button')].find(button=>button.textContent==='继续启动').id='parallelConfirmThird'`);
  await click('#parallelConfirmThird');
  let ownerC;
  await until(async () => { snapshot = await api(); const item = snapshot.items.find(item => item.owner && item.conversationId !== ownerB.conversationId && item.workspace.cwd === projects[1]); ownerC = item?.owner; return Boolean(ownerC?.sessionId) && item.lifecycle === 'ready'; }, 'C_native_identity', 65000);
  report.facts.C = { owner: ownerC, kind: 'runtime', differentProject: true };
  requireCheck(snapshot.totalCount === 3 && snapshot.hardLimit === 3 && new Set([ownerA.sessionId, ownerB.sessionId, ownerC.sessionId]).size === 3, 'A/B/C occupy exactly three resources with three native identities');
  await focus(ownerC.conversationId);
  await sendText('#runtimeView textarea', task('C'), '#runtimeView .rtc-send');
  await untilTask(() => marker(projects[1], 'C'), 'C_real_shell_started', [ownerC]);
  const active = await read(`(async()=> (await import('/state.js')).S.streaming)()`);
  const bState = await state(ownerB), cState = await state(ownerC);
  requireCheck(active && bState.data?.isStreaming && cState.data?.isStreaming, 'three real model tasks overlap while A is still running');
  const aStart = (await events()).find(event => event.owner?.sessionId === ownerA.sessionId && event.type === 'agent_start');
  const bStart = report.events.find(event => event.owner?.conversationId === ownerB.conversationId && event.type === 'agent_start');
  const cStart = report.events.find(event => event.owner?.conversationId === ownerC.conversationId && event.type === 'agent_start');
  report.facts.overlap = { A: aStart?.at, B: bStart?.at, C: cStart?.at, observedAllActiveAt: Date.now(), eventObserved: Boolean(aStart && bStart && cStart) };
  requireCheck(Boolean(aStart && bStart && cStart), 'SSE records genuine agent_start for A/B/C');
  const deniedFourth = await api({ action: 'open-session', args: { project: projects[1], requestId: require('node:crypto').randomUUID(), allowThird: true } });
  requireCheck(deniedFourth.ok === false && deniedFourth.code === 'runtime_limit' && (await api()).totalCount === 3, 'fourth actual runtime admission is rejected without raising hard cap', { code: deniedFourth.code });
  mark('background_switching');
  for (let i = 0; i < 3; i++) { await focus(ownerB.conversationId); await focus(ownerC.conversationId); }
  const afterSwitch = [await state(ownerB), await state(ownerC)];
  const stillA = await read(`(async()=> (await import('/state.js')).S.streaming)()`);
  requireCheck(stillA && afterSwitch.every(result => result.data?.isStreaming) && marker(projects[0], 'A'), 'three B/C round trips preserve all real tasks and native owners');
  report.facts.runningProjection = await recordProjection([ownerB.conversationId, ownerC.conversationId]);
  requireCheck(report.facts.runningProjection.every((record, i) => record.owner.sessionId === [ownerB, ownerC][i].sessionId && record.cursor > 0), 'public runtime store consumes owner-scoped production SSE eventSequence');
  await shot('running-C-dark-wide');
  await focus(ownerB.conversationId); await shot('waiting-B-light-narrow', 700, 600, 'light');
  mark('stop_only_A');
  // Real classic sidebar row returns to its already-mounted conversation.
  win.setContentSize(1320, 820);
  const classic = await read(`(()=>{const rows=[...document.querySelectorAll('#pjSessionsBox .pj-sess:not(.pj-runtime) .pj-sess-primary')];const row=rows.find(row=>row.closest('.pj-sess').classList.contains('on'))||rows[0];if(row)row.id='parallelClassicA';return !!row;})()`);
  requireCheck(classic, 'classic A remains navigable during B/C execution');
  await click('#parallelClassicA');
  await until(() => read(`(async()=> (await import('/ui/workspace-surface.js')).workspaceView()!=='runtime'&&!document.querySelector('#btnStop').hidden)()`), 'classic_stop_visible');
  const stoppedAt = Date.now();
  await click('#btnStop');
  await until(() => read(`(async()=> !(await import('/state.js')).S.streaming)()`), 'A_abort_settled', 45000);
  await untilTask(() => marker(projects[0], 'B'), 'B_lease_released_after_A_stop', [ownerB]);
  const bAfterStop = await state(ownerB), cAfterStop = await state(ownerC);
  requireCheck(bAfterStop.data?.isStreaming && cAfterStop.data?.isStreaming && bAfterStop.data.sessionId === ownerB.sessionId && cAfterStop.data.sessionId === ownerC.sessionId, 'stopping A leaves B/C streaming and same native identities');
  requireCheck(fs.readFileSync(path.join(projects[0], 'b-native.txt'), 'utf8').trim() === 'B_NATIVE_WRITE', 'B actual write proceeds after A lease is released');
  requireCheck(!fs.existsSync(path.join(projects[0], 'a-done.txt')), 'aborted A does not execute its post-delay write');
  report.facts.stopA = { requestedAt: stoppedAt, BObservedRunningAt: Date.now(), BNativeUnchanged: true, CNativeUnchanged: true };
  const nativeATools = (await events()).filter(event => event.owner?.sessionId === ownerA.sessionId && event.type === 'tool_execution_start');
  requireCheck(nativeATools.some(event => event.toolName === 'write') && nativeATools.some(event => event.toolName === 'read'), 'A genuinely invoked native write and read tools (not only shell)');
  const waiting = report.events.filter(event => event.owner?.conversationId === ownerB.conversationId && event.type === 'tool_wait_state');
  report.facts.BLeaseWait = waiting.map(event => ({ at: event.at, seq: event.seq, eventSequence: event.eventSequence, waiting: event.waiting }));
  requireCheck(waiting.some(event => event.waiting === true) && waiting.some(event => event.waiting === false), 'real B tool_wait_state proves intentional same-root write coordination');
  mark('reload_while_B_C_running');
  await focus(ownerB.conversationId); await shot('running-B-dark-wide');
  const beforeReload = [ownerB, ownerC];
  previousEvents = await events();
  const didLoad = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.webContents.reload(); await didLoad;
  await until(() => read(`(async()=>{const {runtimeStore}=await import('/runtime-state.js');return ${JSON.stringify(beforeReload)}.every(owner=>runtimeStore.get(owner.conversationId)?.owner?.runtimeId===owner.runtimeId);})()`), 'reload_runtime_recovery', 45000);
  requireCheck((await state(ownerB)).data?.isStreaming && (await state(ownerC)).data?.isStreaming, 'real Electron reload recovers B/C owners without abort or auto-respawn');
  // Preserve prior structure, then attach a new read-only SSE observation stream.
  await attachObserver();
  await focus(ownerC.conversationId); await shot('running-C-dark-narrow', 700, 600, 'dark');
  await shot('running-C-light-wide', 1320, 820, 'light');
  mark('complete_B_C_real_files');
  release(projects[0], 'B'); release(projects[1], 'C');
  await untilTask(() => fs.existsSync(path.join(projects[0], 'b-done.txt')), 'B_final_native_write', [ownerB]);
  await untilTask(() => fs.existsSync(path.join(projects[1], 'c-done.txt')), 'C_final_native_write', [ownerC]);
  await until(async () => { const states = await Promise.all([state(ownerB), state(ownerC)]); return states.every(result => result.ok && result.data?.isStreaming === false); }, 'B_C_finished', 120000);
  requireCheck(fs.readFileSync(path.join(projects[0], 'b-done.txt'), 'utf8').trim() === 'B_DONE' && fs.readFileSync(path.join(projects[1], 'c-done.txt'), 'utf8').trim() === 'C_DONE', 'B/C completed real native write/read tasks with exact isolated outputs');
  requireCheck(!fs.existsSync(path.join(projects[0], 'c-done.txt')) && !fs.existsSync(path.join(projects[1], 'a-native.txt')) && !fs.existsSync(path.join(projects[1], 'b-native.txt')), 'file results do not cross project boundaries');
  await events();
  const ownerIds = [ownerB.conversationId, ownerC.conversationId];
  for (const [label, owner] of [['B', ownerB], ['C', ownerC]]) {
    const tools = report.events.filter(event => event.owner?.conversationId === owner.conversationId && event.type === 'tool_execution_start');
    const toolErrors = report.events.filter(event => event.owner?.conversationId === owner.conversationId && event.type === 'tool_execution_end' && event.isError);
    check(tools.some(event => event.toolName === 'write') && tools.some(event => event.toolName === 'read') && tools.some(event => event.toolName === 'bash'), label + ' real native write/read/bash tool invocation');
    check(toolErrors.length === 0, label + ' has no tool error', { errors: toolErrors.length });
  }
  const projection = await recordProjection(ownerIds); report.facts.completedProjection = projection;
  requireCheck(!projection[0].hasC && !projection[1].hasB && !projection[0].hasA && !projection[1].hasA, 'public runtime store text never mixes A/B/C completion markers');
  for (const [label, owner] of [['B', ownerB], ['C', ownerC]]) {
    const history = await api(null, '/api/runtime-sessions?conversationId=' + encodeURIComponent(owner.conversationId));
    const text = JSON.stringify(history.messages || []);
    check(history.ok && history.sessionId === owner.sessionId && text.includes(label + '_DONE'), label + ' production read-only history binds exact native session and tool result');
    report.facts[label].history = { ok: history.ok, count: history.messages?.length, sessionId: history.sessionId };
  }
  mark('runtime_restart_owner_safety');
  const restarted = await api({ action: 'restart', owner: ownerB });
  report.facts.restartResponse = { ok: restarted.ok === true, code: restarted.code || null };
  requireCheck(restarted.ok, 'explicit runtime restart accepted', report.facts.restartResponse);
  let newB;
  await until(async () => { const snap = await api(); const item = snap.items.find(item => item.conversationId === ownerB.conversationId); newB = item?.owner; return item?.lifecycle === 'ready' && newB?.sessionId; }, 'B_restarted_ready', 65000);
  requireCheck(newB.sessionId === ownerB.sessionId && newB.runtimeId !== ownerB.runtimeId && newB.runtimeGeneration !== ownerB.runtimeGeneration, 'restart preserves native session and rotates runtimeId/generation');
  const staleRead = await api({ action: 'read', owner: ownerB, command: { type: 'get_state' } });
  const staleEvents = await api({ action: 'events', owner: ownerB, cursor: 0 });
  requireCheck(staleRead.code === 'stale_runtime' && staleEvents.code === 'stale_runtime', 'old owner cannot read or replay after real runtime restart');
  requireCheck((await state(ownerC)).data?.sessionId === ownerC.sessionId, 'B restart does not replace C');
  report.facts.B.restartedOwner = newB;
  fs.writeFileSync(path.join(out, 'recovery-input.json'), JSON.stringify({ owners: { A: ownerA, B: newB, C: ownerC }, conversations: ownerIds }, null, 2));
  await focus(ownerB.conversationId); await shot('completed-B-light-wide', 1320, 820, 'light');
  report.facts.files = projects.map((cwd, index) => ({ project: index + 1,
    results: ['a-native.txt', 'a-done.txt', 'b-native.txt', 'b-done.txt', 'c-native.txt', 'c-done.txt'].filter(file => fs.existsSync(path.join(cwd, file))).map(file => {
      const bytes = fs.readFileSync(path.join(cwd, file)); return { file, bytes: bytes.length, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') };
    }) }));
}
async function ownerProbe() {
  mark('model_free_restart_probe'); await waitReady();
  const classic = await state(), before = await api();
  const held = before.items.find(item => !item.owner && item.nativeSessionId === classic.legacyOwner?.sessionId);
  requireCheck(Boolean(held), 'probe fixture contains dormant native session currently held by classic');
  const duplicate = await api({ action: 'resume', conversationId: held.conversationId });
  report.facts.classicNativeAdmission = { sessionId: classic.legacyOwner.sessionId, conversationId: held.conversationId,
    ok: duplicate.ok === true, code: duplicate.code || null, before: before.totalCount, after: (await api()).totalCount };
  requireCheck(duplicate.ok === false && duplicate.code === 'session_in_use' && report.facts.classicNativeAdmission.after === before.totalCount,
    'classic-held native session resume is rejected without spawning', report.facts.classicNativeAdmission);
  const prior = JSON.parse(fs.readFileSync(path.join(out, 'exercise.json'), 'utf8'));
  requireCheck(classic.legacyOwner.sessionId === prior.facts.B?.owner?.sessionId, 'classic holds the original real persisted B native session');
  const candidate = prior.facts.C?.owner;
  requireCheck(candidate?.sessionId !== classic.legacyOwner.sessionId
    && before.items.some(item => item.conversationId === candidate?.conversationId && !item.owner),
  'probe selects the original persisted C session not held by classic');
  const opened = await api({ action: 'resume', conversationId: candidate.conversationId });
  requireCheck(opened.ok, 'model-free probe resumes materialized ordinary project native session', { code: opened.code || null });
  let owner;
  await until(async () => { const snap = await api(); const item = snap.items.find(item => item.conversationId === opened.conversationId); owner = item?.owner; return item?.lifecycle === 'ready' && Boolean(owner?.sessionId); }, 'probe_native_identity', 65000);
  report.facts.probeOwner = owner;
  requireCheck((await state(owner)).data?.isStreaming === false, 'probe real Pi is idle before restart');
  const restarted = await api({ action: 'restart', owner });
  report.facts.restartResponse = { ok: restarted.ok === true, code: restarted.code || null };
  const snap = await api();
  report.facts.afterRestart = { totalCount: snap.totalCount, items: snap.items.map(item => ({ conversationId: item.conversationId, owner: item.owner, lifecycle: item.lifecycle })) };
  requireCheck(!(await events()).some(event => event.type === 'agent_start'), 'restart probe sends no prompt or model generation');
  requireCheck(restarted.ok, 'ordinary project restart accepted in model-free probe', report.facts.restartResponse);
  let next;
  await until(async () => { const snapshot = await api(); const item = snapshot.items.find(item => item.conversationId === owner.conversationId); next = item?.owner; return item?.lifecycle === 'ready' && Boolean(next?.sessionId); }, 'probe_restarted_native_identity', 65000);
  requireCheck(next.sessionId === owner.sessionId && next.runtimeId !== owner.runtimeId && next.runtimeGeneration !== owner.runtimeGeneration, 'model-free restart preserves native session and rotates runtime owner');
  const native = await state(next);
  requireCheck(native.ok && native.data?.sessionId === candidate.sessionId && native.data?.isStreaming === false,
    'restarted real Pi get_state confirms the original persisted C session and idle state');
  const rejected = await state(owner), staleEvents = await api({ action: 'events', owner, cursor: 0 });
  requireCheck(rejected.ok === false && rejected.code === 'stale_runtime' && staleEvents.code === 'stale_runtime',
    'model-free restart rejects prior owner reads and event replay', { readCode: rejected.code || null, eventCode: staleEvents.code || null });
  report.facts.restartedOwner = next;
  const history = await api(null, '/api/runtime-sessions?conversationId=' + encodeURIComponent(next.conversationId));
  requireCheck(history.ok && history.sessionId === candidate.sessionId && JSON.stringify(history.messages || []).includes('C_DONE'),
    'model-free resumed C history is from the original real persisted model task');
  requireCheck(!(await events()).some(event => event.type === 'agent_start'), 'entire resume and restart probe performs zero model generations');
  await focus(next.conversationId); await shot('model-free-C-restarted-dark-wide');
}
async function recovery() {
  mark('app_backend_restart_recovery'); await waitReady();
  const prior = JSON.parse(fs.readFileSync(path.join(out, 'recovery-input.json'), 'utf8'));
  const snap = await api();
  report.facts.recoveredSnapshot = { backendInstance: snap.backendInstance, totalCount: snap.totalCount, items: snap.items.map(item => ({ conversationId: item.conversationId, owner: item.owner, lifecycle: item.lifecycle, nativeSessionId: item.nativeSessionId })) };
  requireCheck(snap.backendInstance !== prior.owners.B.backendInstance && snap.totalCount === 1 && snap.items.every(item => item.lifecycle === 'dormant' && !item.owner), 'real app/backend restart restores dormant records without spawning B/C');
  for (const label of ['B', 'C']) {
    const owner = prior.owners[label];
    const hist = await api(null, '/api/runtime-sessions?conversationId=' + encodeURIComponent(owner.conversationId));
    check(hist.ok && hist.sessionId === owner.sessionId && JSON.stringify(hist.messages || []).includes(label + '_DONE'), label + ' persisted history survives actual Electron/backend restart');
    const stale = await api({ action: 'read', owner, command: { type: 'get_state' } });
    check(stale.ok === false && stale.code === 'stale_runtime', label + ' prior backend owner is rejected after restart', { code: stale.code });
  }
  await focus(prior.owners.B.conversationId);
  await until(() => read(`document.querySelector('#runtimeView .rtc-output')?.textContent.includes('B_DONE')`), 'dormant_B_history_render');
  requireCheck((await api()).totalCount === 1, 'opening dormant native history is read-only and consumes no runtime slot');
  await shot('restart-dormant-B-dark-wide');
  // Real Pi may continue its newest native session in classic on startup.
  // Identity, not a fixed B label or timestamp, decides which one may resume.
  const classicSession = (await state()).legacyOwner?.sessionId;
  const heldLabel = ['B', 'C'].find(label => prior.owners[label].sessionId === classicSession);
  const resumeLabel = ['B', 'C'].find(label => prior.owners[label].sessionId !== classicSession);
  report.facts.resumeSelection = { classicSession, heldLabel: heldLabel || null, resumeLabel };
  if (heldLabel) {
    const duplicate = await api({ action: 'resume', conversationId: prior.owners[heldLabel].conversationId });
    requireCheck(duplicate.ok === false && duplicate.code === 'session_in_use' && (await api()).totalCount === 1,
      'classic-held native session cannot be resumed as a second runtime', { label: heldLabel, code: duplicate.code || null });
  }
  const expected = prior.owners[resumeLabel];
  const resumed = await api({ action: 'resume', conversationId: expected.conversationId });
  report.facts.resumeResponse = { label: resumeLabel, ok: resumed.ok === true, code: resumed.code || null };
  requireCheck(resumed.ok, 'explicit non-classic native resume after backend restart is admitted within budget', report.facts.resumeResponse);
  let current;
  await until(async () => { const result = await api(); current = result.items.find(item => item.conversationId === expected.conversationId); return current?.owner?.sessionId && current.lifecycle === 'ready'; }, 'resumed_native_identity', 65000);
  requireCheck(current.owner.sessionId === expected.sessionId && current.owner.runtimeId !== expected.runtimeId && current.owner.backendInstance !== expected.backendInstance, 'resume binds persisted native session with new backend/runtime identity');
  const readback = await state(current.owner);
  requireCheck(readback.data?.sessionId === expected.sessionId && readback.data?.isStreaming === false, 'resumed real Pi get_state confirms same session and does not call model');
  requireCheck(!(await events()).some(event => event.type === 'agent_start'), 'recovery does not generate a model task');
  report.facts.resumedOwner = current.owner;
  await api({ action: 'close', owner: current.owner });
  requireCheck((await api()).totalCount === 1, 'explicit close returns resumed slot while preserving classic');
}
async function main() {
  const watchdog = setTimeout(() => { report.failure = { stage, name: 'watchdog_timeout' }; report.failed = report.checks.filter(check => !check.pass).length + 1; save(); app.exit(1); }, 500000);
  let failed = false;
  try {
    await app.whenReady(); report.electron = process.versions.electron;
    await until(() => { win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http://127.0.0.1:')); return Boolean(win); }, 'production_window', 60000);
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.debugger.attach('1.3');
    win.show(); win.focus();
    const prefs = win.webContents.getLastWebPreferences();
    requireCheck(!app.commandLine.hasSwitch('no-sandbox') && prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration, 'production main uses normal sandbox, context isolation and no nodeIntegration');
    requireCheck(await read('window.piGuiDesktop?.isDesktop===true'), 'production preload is active');
    await attachObserver();
    if (phase === 'exercise') await exercise();
    else if (phase === 'owner-probe') await ownerProbe();
    else if (phase === 'recovery') await recovery();
    else throw Error('unknown_phase');
  } catch (error) {
    failed = true; report.failure = { stage, name: error.name, code: ['condition_timeout', 'check_failed', 'model_request_failed', 'task_ended_before_expected'].includes(error.message) ? error.message : 'driver_exception' };
    check(false, 'runner completed ' + stage, report.failure);
    try {
      await events();
      const snap = await api(); report.facts.failureSnapshot = { totalCount: snap.totalCount, hardLimit: snap.hardLimit, items: snap.items?.map(item => ({ conversationId: item.conversationId, owner: item.owner, lifecycle: item.lifecycle, activity: item.activity, error: item.error })) };
      await shot('failure-' + stage);
    } catch { report.facts.failureSnapshotUnavailable = true; }
  } finally {
    clearTimeout(watchdog);
    // Release owned fixture shells even after failure, then close only the
    // exact production runtimes created in this isolated data directory.
    if (phase === 'exercise') for (const cwd of projects) for (const label of ['A', 'B', 'C']) release(cwd, label);
    let familyObserved = false;
    try {
      fs.writeFileSync(path.join(world, phase + '-ready-for-cleanup'), 'ready', { flag: 'wx' });
      const ack = path.join(world, phase + '-processes-observed');
      await until(() => fs.existsSync(ack), 'parent_process_observation', 30000);
      familyObserved = fs.readFileSync(ack, 'utf8') === 'confirmed';
    } catch { familyObserved = false; }
    check(familyObserved, 'parent observed this live process family before cleanup');
    report.cleanup = await closeRuntimeOwners(api);
    const cleanupConfirmed = report.cleanup.confirmed;
    check(cleanupConfirmed, 'cleanup public runtime closes are confirmed', report.cleanup);
    report.endedAt = new Date().toISOString(); report.failed = report.checks.filter(check => !check.pass).length;
    report.completed = !failed && report.failed === 0 && familyObserved && cleanupConfirmed;
    report.unverified = ['long-duration stress/real OS power loss', 'non-Windows platforms', 'other provider/model combinations', 'full canonical and independent security review (owned by main agent)'];
    if (failed) report.unverified.push('all stages following ' + stage);
    save();
    console.log(`Parallel Electron ${phase}: ${report.checks.length - report.failed}/${report.checks.length}; failed=${report.failed}`);
    process.exitCode = failed || report.failed ? 1 : 0;
    app.quit();
    // Production before-quit owns normal cleanup; only fall back if it hangs.
    setTimeout(() => app.exit(process.exitCode || 0), 10000).unref();
  }
}
main();
}
