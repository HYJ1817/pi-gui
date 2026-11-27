'use strict';
// --live never infers permission from an available key/configured host model.
function modeFor(args) {
  if (args.length === 0 || args.length === 1 && args[0] === '--offline') return 'offline';
  if (args.length === 1 && args[0] === '--live') return 'live';
  throw Error('invalid_functional_mode');
}
async function run(mode) {
  if (!['offline', 'live'].includes(mode)) throw Error('invalid_functional_mode');
  if (mode === 'live') require('./fixtures/visual-replies-live.cjs').authorizeLive();
  const fs = require('node:fs'), path = require('node:path');
  const { spawn } = require('node:child_process');
  const h = require('./fixtures/visual-replies-support.cjs');
  const helper = require('./fixtures/visual-replies-functional-support.cjs');
  const world = h.createWorld(), started = Date.now();
  const report = { schemaVersion: 1, mode, completed: false, visualRepliesAcceptance: false, realModelVerified: false,
    qualification: mode === 'live' ? 'authorized-real-pi-model-pending' : 'offline-fake-pi-production-electron-only',
    phases: [], failed: 0, passed: 0, skipped: 0, unverified: ['original-A-security-unresolved', 'final-integrated-packaged-app'] };
  const resultFile = path.join(world, 'evidence/functional-results.json');
  const save = () => h.saveJson(resultFile, report);
  console.log('Visual Replies functional fixture: ' + world);
  let active;
  try {
    if (process.platform !== 'win32') throw Error('windows_required');
    h.prepareProjects(world);
    const selected = mode === 'live' ? await require('./fixtures/visual-replies-live.cjs').prepareLiveModel(world) : null;
    const piEnv = selected?.env || helper.prepareNormalPi(world);
    const runtime = helper.copyElectron(world, require('electron'));
    report.identity = { head: h.git(h.ROOT, 'rev-parse', 'HEAD'), dirty: Boolean(h.git(h.ROOT, 'status', '--porcelain')),
      node: process.version, platform: process.platform, arch: process.arch, osRelease: require('node:os').release(),
      electronVersion: require('electron/package.json').version, runtime,
      sourceDigests: Object.fromEntries(['electron/main.cjs', 'electron/preload.cjs', 'server.js', 'public/html-artifact-viewer.js',
        'public/html-artifact-frame.js', 'extensions/pi-gui-html/index.js'].map(p => [p, h.digest(path.join(h.ROOT, p))])),
      driverDigests: Object.fromEntries([__filename, path.join(__dirname, 'fixtures/visual-replies-functional-electron.cjs'),
        path.join(__dirname, 'fixtures/visual-replies-functional-support.cjs'), path.join(__dirname, 'fixtures/visual-replies-live.cjs'),
        path.join(__dirname, 'fixtures/visual-replies-normal-samples.cjs'), path.join(__dirname, 'fixtures/visual-replies-normal-pi.cjs')]
        .map(p => [path.relative(h.ROOT, p), h.digest(p)])), model: selected?.identity || { called: false, fakePi: true } };
    save();
    for (const phase of ['generate', 'restore']) {
      const env = { ...h.childEnvironment(world), ...piEnv, PORT: String(await h.freePort()),
        VISUAL_REPLIES_MODE: mode, VISUAL_REPLIES_OBSERVER: 'functional', VISUAL_REPLIES_PHASE: phase,
        VISUAL_REPLIES_VIEWER_ACTIONS: process.env.PI_GUI_VISUAL_REPLIES_VIEWER_ACTIONS || '{}' };
      const child = spawn(runtime.executable, [path.join(__dirname, 'fixtures/visual-replies-functional-electron.cjs'),
        '--user-data-dir=' + path.join(world, 'profile'), '--disable-background-networking'],
      { cwd: world, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
      active = { child, original: null };
      let exit, observed = [], witnessed = false;
      child.once('exit', (code, signal) => { exit = { code, signal }; });
      child.once('error', () => { exit = { code: null, signal: 'spawn-error' }; });
      const phaseReport = { phase, stdoutBytes: 0, stderrBytes: 0 };
      child.stdout.on('data', data => { phaseReport.stdoutBytes += data.length;
        for (const line of String(data).split(/\r?\n/)) if (/^(PASS|FAIL) [a-z0-9-]+$/.test(line)) console.log(line); });
      child.stderr.on('data', data => { phaseReport.stderrBytes += data.length; });
      const original = h.processTable(world).find(p => p.pid === child.pid && p.marker);
      active.original = original;
      const end = Date.now() + (mode === 'live' ? 480000 : 240000);
      while (!exit && Date.now() < end) {
        if (!witnessed && fs.existsSync(path.join(world, 'functional-ready-for-cleanup-' + phase))) {
          observed = original ? h.processFamily(h.processTable(world), original) : [];
          witnessed = true;
          fs.writeFileSync(path.join(world, 'functional-processes-' + phase), String(observed.length), { flag: 'wx' });
        }
        await h.sleep(100);
      }
      if (!exit) {
        phaseReport.fallbackCleanup = h.terminateOwned(child, original, world);
        if (phaseReport.fallbackCleanup.attempted) await helper.waitForExit(child, 5000);
        phaseReport.timeout = true;
      }
      const observerFile = path.join(world, 'evidence/functional-' + phase + '.json');
      const observer = fs.existsSync(observerFile) ? JSON.parse(fs.readFileSync(observerFile, 'utf8')) : null;
      Object.assign(phaseReport, observer || { completed: false, failed: 1, failure: { code: 'native_exit_before_observer' } });
      phaseReport.exit = exit || null;
      let residual = observed;
      for (let i = 0; i < 6; i++) {
        const current = h.processTable(world); residual = observed.filter(p => current.some(q => h.sameProcess(p, q)));
        if (!residual.length) break; await h.sleep(250);
      }
      phaseReport.processCleanup = { confirmed: observed.length >= 2 && !residual.length, observed: observed.length, residual: residual.length, identities: observed };
      phaseReport.completed = phaseReport.completed && exit?.code === 0 && exit.signal === null && !phaseReport.timeout
        && phaseReport.quitObserved && phaseReport.cleanup?.confirmed && phaseReport.processCleanup.confirmed;
      report.phases.push(phaseReport); save();
      if (!phaseReport.completed) throw Error('functional_phase_failed');
    }
    report.realModelVerified = mode === 'live' && report.phases[0]?.realModelVerified === true;
    if (mode === 'live' && !report.realModelVerified) throw Error('real_model_evidence_missing');
    report.completed = true;
    report.qualification = mode === 'live' ? 'explicitly-authorized-real-model-benign-functional-only' : report.qualification;
  } catch (error) { report.failed = 1; report.failure = { code: helper.failureCode(error), name: error.name }; }
  finally {
    if (active?.child.exitCode === null && active.child.signalCode === null) {
      try {
        report.fallbackCleanup = h.terminateOwned(active.child, active.original, world);
        if (report.fallbackCleanup.attempted) await helper.waitForExit(active.child, 5000);
      } catch { report.fallbackCleanup = { attempted: false, reason: 'identity_query_failed' }; }
      report.completed = false; report.failed = Math.max(report.failed, 1);
    }
    report.passed = report.phases.reduce((sum, p) => sum + (p.passed || 0), 0);
    report.failed = Math.max(report.failed, report.phases.reduce((sum, p) => sum + (p.failed || 0), 0));
    report.elapsedMs = Date.now() - started;
    report.privacy = { realUserSettingsRead: false, credentialsCopied: false, rawOutputSaved: false,
      ambientCredentialsInherited: false, explicitlySelectedCredentialInjected: mode === 'live', writableRoots: 'new-os.tmpdir-fixture' };
    save();
  }
  console.log(`Visual Replies ${mode}: ${report.passed}/${report.passed + report.failed}; completed=${report.completed}; evidence=${resultFile}`);
  console.log('Overall Visual Replies/security acceptance: NOT qualified');
  return report.completed ? 0 : 1;
}
module.exports = { run, modeFor };
if (require.main === module) Promise.resolve().then(() => run(modeFor(process.argv.slice(2)))).then(code => { process.exitCode = code; }).catch(error => {
  console.error('Visual Replies not run: ' + require('./fixtures/visual-replies-functional-support.cjs').failureCode(error)); process.exitCode = 2;
});
