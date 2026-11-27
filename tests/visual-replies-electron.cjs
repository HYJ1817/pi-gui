'use strict';

/* Offline by default; no installation, real Pi or credential imports. Live mode
 * additionally requires an explicit flag and opt-in environment variable.
 * --preflight only qualifies production launch, never Visual Replies behavior.
 */
if (process.argv.includes('--live') && process.env.PI_GUI_VISUAL_REPLIES_LIVE !== '1') {
  console.error('Visual Replies live: not run (requires explicit PI_GUI_VISUAL_REPLIES_LIVE=1; no fixture/import/spawn)');
  process.exit(2);
}
if (process.argv.includes('--live')) {
  try { require('./fixtures/visual-replies-live.cjs').authorizeLive(); }
  catch (error) { console.error('Visual Replies live: not run (' + error.message + ')'); process.exit(2); }
}
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./fixtures/visual-replies-support.cjs');

function modeFor(argv) {
  const modes = argv.filter(arg => ['--preflight', '--offline', '--live', '--check-driver', '--check-safety'].includes(arg));
  if (modes.length > 1 || argv.some(arg => !modes.includes(arg))) throw Error('invalid_arguments');
  return modes[0]?.slice(2) || 'offline';
}
async function launch(mode) {
  if (mode === 'offline' || mode === 'live') return require('./visual-replies-functional.cjs').run(mode);
  if (mode !== 'preflight') throw Error('invalid_arguments');
  if (process.platform !== 'win32') throw Error('windows_required');
  const world = h.createWorld(), evidence = path.join(world, 'evidence');
  console.log('Visual Replies fixture: ' + world);
  const resultFile = path.join(evidence, 'results.json');
  const report = { schemaVersion: 1, mode, startedAt: new Date().toISOString(), qualification: 'unverified', completed: false,
    visualRepliesAcceptance: false, passed: 0, failed: 0, skipped: 0, checks: [], shots: [],
    unverified: ['visual-reply-tool-contract', 'iframe-security', 'lifecycle', 'real-model-turn'] };
  const save = () => h.saveJson(resultFile, report);
  let child, original, observed = [], exit, spawnError, fallback;
  save();
  try {
    h.prepareProjects(world);
    const shim = h.prepareFakePi(world), port = await h.freePort();
    const env = { ...h.childEnvironment(world), PI_BIN: shim, PORT: String(port),
      VISUAL_REPLIES_MODE: mode, VISUAL_REPLIES_OBSERVER: '1' };
    const executable = require('electron');
    report.identity = { head: h.git(h.ROOT, 'rev-parse', 'HEAD'), branch: h.git(h.ROOT, 'branch', '--show-current'),
      sourceDigests: Object.fromEntries(['electron/main.cjs', 'electron/preload.cjs', 'server.js', 'public/app.js', 'public/conversation.js']
        .filter(file => fs.existsSync(path.join(h.ROOT, file))).map(file => [file, h.digest(path.join(h.ROOT, file))])),
      driverDigests: Object.fromEntries([__filename, path.join(__dirname, 'fixtures/visual-replies-electron.cjs'),
        path.join(__dirname, 'fixtures/visual-replies-support.cjs')].map(file => [path.relative(h.ROOT, file), h.digest(file)])),
      electronVersion: require('electron/package.json').version, electronExecutableSha256: h.digest(executable),
      explicitRuntimeOverride: Boolean(process.env.ELECTRON_OVERRIDE_DIST_PATH), node: process.version, platform: process.platform,
      entry: 'observation-bootstrap-requires-unmodified-production-main', backend: 'spawned-by-production-main',
      fakePi: 'existing-candidate-pi-handshake-only', realPiOrModel: false, sandboxOverride: false };
    save();
    child = spawn(executable, [path.join(__dirname, 'fixtures/visual-replies-electron.cjs'),
      '--user-data-dir=' + path.join(world, 'profile'), '--disable-background-networking'], {
      cwd: world, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    report.output = { stdoutBytes: 0, stderrBytes: 0 };
    child.stdout.on('data', data => {
      report.output.stdoutBytes += data.length;
      for (const line of String(data).split(/\r?\n/)) if (/^(?:PASS|FAIL|STAGE) [a-z0-9-]+$/.test(line)) console.log(line);
    });
    child.stderr.on('data', data => { report.output.stderrBytes += data.length; });
    child.once('error', error => { spawnError = error.code === 'ENOENT' ? 'executable_missing' : 'spawn_error'; });
    child.once('exit', (code, signal) => { exit = { code, signal }; });
    original = h.processTable(world).find(item => item.pid === child.pid && item.marker);
    // A runtime that dies before its first JS instruction is an environment
    // failure with zero checks, not a synthetic passing or skipped scenario.
    const deadline = Date.now() + 150000;
    let observedAt;
    while (!exit && !spawnError && Date.now() < deadline) {
      if (!observedAt && fs.existsSync(path.join(world, 'ready-for-cleanup'))) {
        observedAt = new Date().toISOString();
        observed = original ? h.processFamily(h.processTable(world), original) : [];
        fs.writeFileSync(path.join(world, 'processes-observed'), observed.length >= 2 ? 'confirmed' : 'unconfirmed', { flag: 'wx' });
      }
      await h.sleep(100);
    }
    if (!exit) throw Error(spawnError || 'electron_timeout');
    const observerFile = path.join(evidence, 'observer.json');
    const observer = fs.existsSync(observerFile) ? JSON.parse(fs.readFileSync(observerFile, 'utf8')) : null;
    Object.assign(report, observer || { failure: { stage: 'before-observer', code: 'native_runtime_exit' }, failed: 1 });
    report.exit = exit;
    let residual = observed;
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = h.processTable(world);
      residual = observed.filter(item => current.some(candidate => h.sameProcess(item, candidate)));
      if (!residual.length) break;
      await h.sleep(250);
    }
    report.processCleanup = { observedAt: observedAt || null, observed: observed.length, residual: residual.length,
      confirmed: observed.length >= 2 && residual.length === 0, identities: observed };
    report.privacy = { verified: true, rawPayloadSaved: false, inheritedModelCredentials: false, realUserDataRead: false,
      credentialsCopied: false, allWritableRootsInOsTmpdir: true };
    report.completed = h.complete(report, [...h.PREFLIGHT_CHECKS, 'pointer-sidebar-roundtrip']);
    report.visualRepliesAcceptance = false;
    report.qualification = report.completed ? 'normal-sandbox-production-launch-only' : 'unverified';
    report.passed = report.checks.filter(item => item.pass === true).length;
    report.failed = Math.max(report.failed, report.checks.filter(item => item.pass !== true).length, report.completed ? 0 : 1);
  } catch (error) {
    report.completed = false; report.failed = Math.max(report.failed, 1);
    report.failure = { stage: report.stage || 'runner', code: ['invalid_fixture_root', 'port_unavailable', 'windows_required',
      'electron_timeout', 'executable_missing', 'spawn_error'].includes(error.message) ? error.message : 'runner_failed' };
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      try { fallback = h.terminateOwned(child, original, world); }
      catch { fallback = { attempted: false, reason: 'cleanup_query_failed' }; }
      report.completed = false; report.failed = Math.max(report.failed, 1); report.fallbackCleanup = fallback;
      if (fallback.attempted) await new Promise(resolve => child.once('exit', resolve));
    }
    report.endedAt = new Date().toISOString(); save();
  }
  console.log(`Visual Replies ${mode}: ${report.passed}/${report.passed + report.failed}; failed=${report.failed}; skipped=${report.skipped}; evidence=${evidence}`);
  console.log('Visual Replies acceptance: ' + (report.visualRepliesAcceptance ? 'qualified' : 'NOT qualified'));
  return report.completed ? 0 : 1;
}

async function checkSafety() {
  const assert = require('node:assert/strict');
  const { validateRendererScripts } = require('./fixtures/visual-replies-electron.cjs');
  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
  const world = h.createWorld();
  try {
    check('renderer functions all compile without Electron imports', () => assert.ok(validateRendererScripts() >= 1));
    check('modes are exclusive and unknown flags fail closed', () => {
      assert.equal(modeFor([]), 'offline'); assert.equal(modeFor(['--preflight']), 'preflight');
      assert.throws(() => modeFor(['--live', '--offline'])); assert.throws(() => modeFor(['--no-sandbox']));
    });
    check('child env clears credential proxy Node and mixed-case Git overrides', () => {
      const env = h.childEnvironment(world, { Path: 'fixture-path', SystemRoot: 'C:/Windows', ANTHROPIC_API_KEY: 'never-inherit',
        OPENAI_API_KEY: 'never-inherit', PI_BIN: 'ambient-pi', PI_CODING_AGENT_DIR: 'real-agent', PI_GUI_TOKEN: 'never-inherit',
        ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=untrusted', HTTP_PROXY: 'http://untrusted', git_config_parameters: 'hostile' });
      for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PI_GUI_TOKEN', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'HTTP_PROXY', 'git_config_parameters', 'PI_BIN']) assert.equal(env[key], undefined);
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'PI_GUI_DATA', 'PI_GUI_RUNTIME_DIR', 'PI_GUI_LOG_DIR', 'PI_CODING_AGENT_DIR', 'PI_CWD']) assert.ok(h.inside(world, env[key]), key);
    });
    check('all fixture mutation roots are direct children of os tmpdir', () => {
      assert.equal(h.validateWorld(world), fs.realpathSync(world)); assert.throws(() => h.validateWorld(h.ROOT));
    });
    const root = { pid: 10, parent: 1, birth: '100', exeSha256: 'exe', commandSha256: 'command', marker: true };
    const child = { pid: 11, parent: 10, birth: '101', exeSha256: 'node', commandSha256: 'child', marker: false };
    const handle = { exitCode: null, signalCode: null };
    check('live matching creation image and command authorize fallback kill only', () => assert.equal(h.canTerminate(handle, root, { ...root }), true));
    for (const [name, original, current, tracked] of [
      ['PID reuse', root, { ...root, birth: '200' }, handle], ['changed image', root, { ...root, exeSha256: 'different' }, handle],
      ['changed command', root, { ...root, commandSha256: 'different' }, handle], ['missing marker', { ...root, marker: false }, root, handle],
      ['missing witness', null, root, handle], ['already exited', root, root, { exitCode: 0, signalCode: null }],
      ['signal exited', root, root, { exitCode: null, signalCode: 'SIGTERM' }],
    ]) check(name + ' never authorizes kill', () => assert.equal(h.canTerminate(tracked, original, current), false));
    check('family traversal ignores an old process and rejects a reused root', () => {
      assert.equal(h.processFamily([root, child, { ...child, pid: 12, birth: '099' }], root).length, 2);
      assert.equal(h.processFamily([{ ...root, birth: '200' }, child], root).length, 0);
    });
    const valid = () => ({ completed: true, failed: 0, endedAt: new Date().toISOString(), exit: { code: 0, signal: null },
      cleanup: { quitObserved: true, runtimeOwners: { confirmed: true } }, processCleanup: { confirmed: true }, privacy: { verified: true },
      checks: h.PREFLIGHT_CHECKS.map(id => ({ id, pass: true })) });
    check('complete phase qualifies only with all explicit checks', () => assert.equal(h.complete(valid(), h.PREFLIGHT_CHECKS), true));
    for (const [name, mutate] of [
      ['incomplete', value => { value.completed = false; }], ['failed', value => { value.failed = 1; }],
      ['missing check', value => { value.checks.pop(); }], ['failed check', value => { value.checks[0].pass = false; }],
      ['no end marker', value => { delete value.endedAt; }], ['nonzero exit', value => { value.exit.code = 1; }],
      ['signal exit', value => { value.exit.signal = 'SIGTERM'; }], ['no quit', value => { value.cleanup.quitObserved = false; }],
      ['unconfirmed family', value => { value.processCleanup.confirmed = false; }], ['unconfirmed public close', value => { value.cleanup.runtimeOwners.confirmed = false; }],
      ['privacy failure', value => { value.privacy.verified = false; }],
    ]) check('phase fails closed for ' + name, () => { const value = valid(); mutate(value); assert.equal(h.complete(value, h.PREFLIGHT_CHECKS), false); });
    check('real TEMP Git ignores ambient config index and hooks', () => {
      h.prepareProjects(world);
      assert.equal(h.git(path.join(world, 'project-a'), 'status', '--porcelain'), '');
      assert.equal(h.git(path.join(world, 'project-b'), 'status', '--porcelain'), '');
      const clean = h.gitEnv(world, { GIT_DIR: 'foreign', GIT_INDEX_FILE: 'foreign', Git_work_tree: 'foreign' });
      assert.equal(clean.GIT_DIR, undefined); assert.equal(clean.GIT_INDEX_FILE, undefined); assert.equal(clean.Git_work_tree, undefined);
    });
    check('hostile and interactive payload scripts compile as data only', () => {
      assert.equal(require('./fixtures/visual-replies-payloads.cjs').validatePayloadScripts(), 3);
    });
    const sinks = await require('./fixtures/visual-replies-sinks.cjs').createSinks();
    try {
      const witness = await sinks.positiveControl();
      check('local HTTP TCP and UDP sinks detect actual packets', () => assert.deepEqual(witness, { httpObserved: true, tcpObserved: true, udpObserved: true }));
      sinks.reset();
      check('sink counters can reset before an actual iframe attack', () => assert.ok(Object.values(sinks.snapshot()).every(value => value === 0)));
      check('sink helper does not claim iframe security from listener self tests', () => {
        assert.equal(sinks.coverage.productionNetworkInterceptionInstalled, false);
        assert.equal(sinks.coverage.externalNetworkContacted, false);
      });
    } finally { await sinks.close(); }
    await assert.rejects(require('./fixtures/visual-replies-live.cjs').prepareLiveModel(world, {}), { message: 'live_opt_in_required' });
    check('live model resolver refuses before reading source settings without opt in', () => assert.equal(fs.existsSync(path.join(world, 'agent/models.json')), false));
    check('live opt-in exits before imports or fixture creation', () => {
      const prefix = fs.readFileSync(__filename, 'utf8').split("const fs = require('node:fs');")[0];
      let imports = 0, code; const stopped = Symbol('stopped');
      assert.throws(() => require('node:vm').runInNewContext(prefix, {
        process: { argv: ['node', 'runner', '--live'], env: {}, exit(value) { code = value; throw stopped; } },
        console: { error() {} }, require() { imports++; },
      }), value => value === stopped);
      assert.equal(code, 2); assert.equal(imports, 0);
    });
    h.saveJson(path.join(world, 'evidence/safety.json'), { passed, failed: 0, qualification: 'offline-driver-only',
      downloaded: false, realUserDataRead: false, electronSpawned: false, modelCalled: false });
    console.log(`Visual Replies driver safety: ${passed}/${passed}; evidence=${path.join(world, 'evidence')}`);
  } catch (error) { console.error('Visual Replies driver safety failed: ' + error.name); return 1; }
  return 0;
}
module.exports = { modeFor, launch, checkSafety };
if (require.main === module) (async () => {
  const mode = modeFor(process.argv.slice(2));
  if (mode === 'check-driver') {
    const count = require('./fixtures/visual-replies-electron.cjs').validateRendererScripts()
      + require('./fixtures/visual-replies-functional-electron.cjs').validate();
    console.log(`Visual Replies renderer syntax: ${count}/${count}; no Electron/Pi/model`);
    await require('./fixtures/visual-replies-functional-support.cjs').checkDriver(); return 0;
  }
  return mode === 'check-safety' ? checkSafety() : launch(mode);
})().then(code => { process.exitCode = code; }).catch(error => {
  console.error('Visual Replies: not completed (' + (['invalid_arguments', 'live_tool_contract_pending', 'windows_required'].includes(error.message) ? error.message : error.name) + ')');
  process.exitCode = 1;
});
