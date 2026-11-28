'use strict';
// Opt-in acceptance only. No imports/setup until a requested live run is authorized.
function modeFor(args) {
  if (!args.length || args.length === 1 && args[0] === '--check-driver') return 'check-driver';
  if (args.length === 1 && ['--offline', '--live'].includes(args[0])) return args[0].slice(2);
  throw Error('invalid_mode');
}
function packagedRoot(env) {
  const root = env.PI_GUI_VISUAL_REPLIES_PACKAGED_ROOT;
  if (root && !require('node:path').isAbsolute(root)) throw Error('packaged_root_must_be_absolute');
  return root || null;
}
async function checkDriver() {
  const assert = require('node:assert/strict'), path = require('node:path');
  const live = require('./fixtures/visual-replies-live.cjs'); let passed = 0;
  const check = fn => { fn(); passed++; };
  const valid = { PI_GUI_VISUAL_REPLIES_LIVE: '1', PI_GUI_VISUAL_REPLIES_AUTHORIZE_MODEL_CALLS: '1',
    PI_GUI_VISUAL_REPLIES_PROVIDER: 'fixture', PI_GUI_VISUAL_REPLIES_MODEL: 'no-model', PI_GUI_VISUAL_REPLIES_API: 'openai-responses',
    PI_GUI_VISUAL_REPLIES_ENDPOINT: 'http://127.0.0.1:1/v1', PI_GUI_VISUAL_REPLIES_PI_BIN: path.join(require('node:os').tmpdir(), 'fixture-pi.cmd'),
    PI_GUI_VISUAL_REPLIES_AUTHORIZE_CREDENTIAL: 'PI_GUI_VISUAL_REPLIES_KEY', PI_GUI_VISUAL_REPLIES_KEY: 'synthetic-driver-only' };
  check(() => assert.equal(require('./fixtures/html-preview-live-electron.cjs').validate(), 12));
  for (const [args, mode] of [[[], 'check-driver'], [['--check-driver'], 'check-driver'], [['--offline'], 'offline'], [['--live'], 'live']])
    check(() => assert.equal(modeFor(args), mode));
  for (const args of [['--unknown'], ['--offline', '--live']]) check(() => assert.throws(() => modeFor(args), { message: 'invalid_mode' }));
  for (const suffix of ['LIVE', 'AUTHORIZE_MODEL_CALLS', 'PROVIDER', 'MODEL', 'API', 'ENDPOINT', 'PI_BIN', 'AUTHORIZE_CREDENTIAL', 'KEY'])
    check(() => { const env = { ...valid }; delete env['PI_GUI_VISUAL_REPLIES_' + suffix]; assert.throws(() => live.authorizeLive(env)); });
  check(() => assert.equal(live.authorizeLive(valid).model, 'no-model'));
  check(() => assert.throws(() => packagedRoot({ PI_GUI_VISUAL_REPLIES_PACKAGED_ROOT: 'relative' }), { message: 'packaged_root_must_be_absolute' }));
  let setupImports = 0;
  await assert.rejects(require('node:vm').runInNewContext('(' + run.toString() + ')(["--live"], {})', {
    modeFor, require(name) { if (name === './fixtures/visual-replies-live.cjs') return live; setupImports++; throw Error('unexpected_setup'); },
  }), { message: 'live_opt_in_required' });
  check(() => assert.equal(setupImports, 0));
  return passed;
}
function nativeSummary(h, world, sessionId) {
  const fs = require('node:fs'), path = require('node:path'); let file;
  const visit = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name); if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) visit(name);
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && JSON.parse(fs.readFileSync(name, 'utf8').split('\n', 1)[0]).id === sessionId) file = name;
  } };
  visit(path.join(world, 'agent', 'sessions')); if (!file) throw Error('native_session_missing');
  const raw = fs.readFileSync(file, 'utf8'), rows = raw.trim().split('\n').map(JSON.parse), entries = new Map(rows.map(row => [row.id, row]));
  const calls = new Map(), linked = new Set(), toolCalls = {}, toolResults = {}, toolOrder = [], toolErrors = [];
  let persistedPreviewImages = 0;
  const previewModes = { static: 0, interactive: 0 };
  let toolResultCount = 0;
  const safeName = name => ['html_preview', 'html_render'].includes(name) ? name : 'other';
  const count = (map, name) => { map[name] = (map[name] || 0) + 1; };
  const reported = new Set(); let previewSeen = false, randomCanvasDeclared = false, reportedCodeFrozen = false, formalPublishes = 0;
  for (const row of rows) {
    const message = row.message; if (!Array.isArray(message?.content)) continue;
    if (message.role === 'assistant') for (const part of message.content) {
      if (part.type === 'text' && previewSeen) for (const code of String(part.text).match(/\b\d{4}\b/g) || []) reported.add(code);
      if (part.type !== 'toolCall') continue;
      const name = safeName(part.name); count(toolCalls, name); toolOrder.push(name); calls.set(part.id, { name, messageId: row.id });
      const html = part.arguments?.html;
      if (name === 'html_preview' && typeof html === 'string' && /<canvas\b/i.test(html) && /crypto\.getRandomValues/.test(html)) randomCanvasDeclared = true;
      if (name === 'html_render' && previewSeen && typeof html === 'string') {
        const frozen = html.match(/\bdata-vision-code=["'](\d{4})["']/i)?.[1];
        reportedCodeFrozen ||= Boolean(frozen && reported.has(frozen));
      }
    }
    if (message.role !== 'toolResult') continue;
    toolResultCount++;
    const name = safeName(message.toolName), call = calls.get(message.toolCallId); count(toolResults, name);
    let ancestor = row.parentId;
    for (let n = 0; ancestor && n < rows.length; n++) {
      if (call?.name === name && ancestor === call.messageId) { linked.add(message.toolCallId); break; }
      ancestor = entries.get(ancestor)?.parentId;
    }
    if (message.isError === true) {
      const code = message.details?.code || message.content.find(p => p?.type === 'text')?.text?.match(/\b(html_resource_blocked|html_cancelled|html_too_large|html_bridge_unavailable|html_store_unavailable)\b/)?.[1];
      toolErrors.push({ tool: name, code: ['html_preview_unavailable', 'html_resource_blocked', 'html_cancelled', 'html_too_large', 'html_bridge_unavailable', 'html_store_unavailable'].includes(code) ? code : 'other' });
    }
    const ref = message.details?.artifact;
    if (name === 'html_render' && message.isError !== true && message.details?.kind === 'html_artifact'
      && message.details.schemaVersion === 1 && message.details.ok === true
      && /^[a-f0-9]{64}$/.test(ref?.id || '') && ref.sessionId === sessionId && ref.messageId === call?.messageId
      && ref.toolCallId === message.toolCallId) formalPublishes++;
    if (name !== 'html_preview') continue;
    persistedPreviewImages += message.content.filter(part => part?.type === 'image').length;
    if (message.isError !== true && message.details?.ok === true) {
      previewSeen = true;
      if (message.details.mode === 'static' || message.details.mode === 'interactive') previewModes[message.details.mode]++;
    }
  }
  const contextProof = path.join(world, 'evidence', `context-${sessionId}.jsonl`);
  const contextImages = fs.existsSync(contextProof) ? fs.readFileSync(contextProof, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { entries: rows.length, sessionSha256: h.hashText(raw), toolCalls, toolResults, toolOrder, toolErrors, persistedPreviewImages, previewModes, contextImages,
    contextLinksValidated: calls.size > 0 && toolResultCount === calls.size && linked.size === calls.size
      && [...calls.keys()].every(id => linked.has(id)), formalPublishes,
    visionChallenge: { randomCanvasDeclared, reportedCodeFrozen, pixelsIndependentlyVerified: false } };
}
function copyPackaged(h, world, root) {
  const fs = require('node:fs'), path = require('node:path'), source = fs.realpathSync(root), target = path.join(world, 'packaged-app');
  fs.cpSync(source, target, { recursive: true, dereference: true, errorOnExist: true, force: false });
  const appDir = path.join(target, 'resources', 'app'), main = path.join(appDir, 'main.cjs'), packageFile = path.join(appDir, 'package.json');
  if (!fs.existsSync(main) || !fs.existsSync(packageFile)) throw Error('packaged_app_shape_invalid');
  const digests = {};
  for (const name of ['main.cjs', 'preload.cjs', 'server.cjs', 'public/html-artifact-viewer.js', 'extensions/pi-gui-html/index.js']) {
    const from = path.join(source, 'resources', 'app', name), to = path.join(appDir, name); if (!fs.existsSync(from)) continue;
    digests[name] = { original: h.digest(from), copied: h.digest(to) };
    if (digests[name].original !== digests[name].copied) throw Error('packaged_copy_digest_mismatch');
  }
  fs.writeFileSync(path.join(appDir, 'html-preview-live-bootstrap.cjs'), `'use strict';\nrequire(${JSON.stringify(path.join(__dirname, 'fixtures/html-preview-live-electron.cjs'))});\n`, { flag: 'wx' });
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')); pkg.main = 'html-preview-live-bootstrap.cjs'; fs.writeFileSync(packageFile, JSON.stringify(pkg) + '\n');
  return { name: 'packaged', executable: path.join(target, 'Pi GUI.exe'), root: target, main, mainSha256: h.digest(main), digests,
    entry: 'copy-only-observer-entry-requires-unchanged-resources-app-main', appSha256: h.digest(path.join(target, 'Pi GUI.exe')) };
}
async function launchPhase(h, helper, world, target, piEnv, mode, phase) {
  const fs = require('node:fs'), path = require('node:path');
  const marker = suffix => path.join(world, 'html-preview-' + suffix + '-' + target.name + '-' + phase);
  const profile = path.join(world, 'profile', target.name); fs.mkdirSync(profile, { recursive: true });
  const env = { ...h.childEnvironment(world), ...piEnv, PORT: String(await h.freePort()), HTML_PREVIEW_OBSERVER: '1',
    VISUAL_REPLIES_TARGET: target.name, VISUAL_REPLIES_MODE: mode, VISUAL_REPLIES_PHASE: phase, VISUAL_REPLIES_MAIN: target.main,
    VISUAL_REPLIES_PACKAGED_COPY: target.root || '', VISUAL_REPLIES_EXPECTED_MAIN_SHA256: target.mainSha256 || '' };
  for (const key of Object.keys(env)) if (/^ELECTRON_OVERRIDE_DIST_PATH$/i.test(key)) delete env[key];
  const args = target.name === 'source' ? [path.join(__dirname, 'fixtures/html-preview-live-electron.cjs')] : [];
  args.push('--user-data-dir=' + profile, '--disable-background-networking');
  const child = require('node:child_process').spawn(target.executable, args, { cwd: world, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { target: target.name, phase, stdoutBytes: 0, stderrBytes: 0 }; let exit = null, original = null, observed = [];
  child.once('exit', (code, signal) => { exit = { code, signal }; }); child.once('error', () => { exit = { code: null, signal: 'spawn-error' }; });
  child.stdout.on('data', data => { result.stdoutBytes += data.length; }); child.stderr.on('data', data => { result.stderrBytes += data.length; });
  try {
    for (let i = 0; i < 5 && !exit && !original; i++) { original = h.processTable(world).find(p => p.pid === child.pid && p.marker); if (!original) await h.sleep(150); }
    const end = Date.now() + (mode === 'live' && phase === 'generate' ? 600000 : 240000);
    while (!exit && Date.now() < end) {
      if (!fs.existsSync(marker('processes')) && fs.existsSync(marker('ready'))) {
        observed = original ? h.processFamily(h.processTable(world), original) : [];
        fs.writeFileSync(marker('processes'), observed.length >= 2 ? 'confirmed' : 'unconfirmed', { flag: 'wx' });
      }
      await h.sleep(150);
    }
    if (!exit) result.timeout = true;
  } catch { result.failure = { code: 'process_identity_probe_failed' }; }
  finally {
    if (!exit) {
      try { result.fallbackCleanup = h.terminateOwned(child, original, world); await helper.waitForExit(child, 5000); }
      catch { result.fallbackCleanup = { attempted: false, reason: 'identity_unconfirmed' }; }
    }
  }
  const file = path.join(world, 'evidence', target.name + '-' + phase + '.json');
  if (fs.existsSync(file)) Object.assign(result, JSON.parse(fs.readFileSync(file, 'utf8')));
  let residual = observed;
  for (let i = 0; i < 6 && residual.length; i++) { const now = h.processTable(world); residual = observed.filter(p => now.some(q => h.sameProcess(p, q))); if (residual.length) await h.sleep(250); }
  result.exit = exit; result.processCleanup = { confirmed: observed.length >= 2 && !residual.length, observed: observed.length, residual: residual.length, identities: observed };
  result.completed = result.completed === true && exit?.code === 0 && exit.signal === null && !result.timeout && !result.fallbackCleanup
    && result.quitObserved === true && result.cleanup?.confirmed === true && result.processCleanup.confirmed;
  return result;
}
async function run(args = process.argv.slice(2), ambient = process.env) {
  const mode = modeFor(args);
  if (mode === 'live') {
    const selected = require('./fixtures/visual-replies-live.cjs').authorizeLive(ambient);
    if (!require('node:path').isAbsolute(selected.piBin)) throw Error('explicit_absolute_pi_bin_required');
  }
  if (mode === 'check-driver') { const count = await checkDriver(); console.log(`HTML preview driver: ${count}/${count}; no Electron/Pi/model/fixture`); return 0; }
  const root = packagedRoot(ambient), fs = require('node:fs'), path = require('node:path'), h = require('./fixtures/visual-replies-support.cjs');
  const helper = require('./fixtures/visual-replies-functional-support.cjs'), world = h.createWorld(), started = Date.now();
  const report = { schemaVersion: 1, mode, completed: false, passed: 0, failed: 0, targets: [],
    qualification: 'benign-functional-only-not-overall-visual-or-security-acceptance',
    unverified: ['security-qualification', 'external-resource-success', 'independent-pixel-code-verification', ...(!root ? ['packaged-app'] : [])],
    privacy: { realUserSettingsRead: false, realUserSessionsRead: false, credentialDiskCopy: false,
      explicitlySelectedCredentialInjected: mode === 'live', rawPayloadInReport: false, writableRoot: 'new-os.tmpdir-fixture' } };
  const resultFile = path.join(world, 'evidence/acceptance.json'), save = () => h.saveJson(resultFile, report);
  console.log('HTML preview acceptance fixture: ' + world);
  try {
    if (process.platform !== 'win32') throw Error('windows_required');
    h.prepareProjects(world); const normalPi = helper.prepareNormalPi(world);
    const samples = JSON.parse(fs.readFileSync(normalPi.VISUAL_REPLIES_SAMPLES, 'utf8')); samples.find(row => row.id === 'filter-panel').preview = true;
    fs.writeFileSync(normalPi.VISUAL_REPLIES_SAMPLES, JSON.stringify(samples));
    const selected = mode === 'live' ? await require('./fixtures/visual-replies-live.cjs').prepareLiveModel(world, ambient) : null;
    if (selected) {
      const file = path.join(world, 'agent/models.json'), config = JSON.parse(fs.readFileSync(file, 'utf8')), model = config.providers[selected.identity.provider].models[0];
      model.input = ['text', 'image']; model.maxTokens = 8192; fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
      Object.assign(selected.identity, { promptBudget: 2, fixtureOverride: { input: model.input, maxTokens: model.maxTokens, source: 'created-temp-models-json-only' } });
    }
    const runtime = helper.copyElectron(world, require('electron')), packaged = root ? copyPackaged(h, world, root) : null;
    report.identity = { head: h.git(h.ROOT, 'rev-parse', 'HEAD'), dirty: Boolean(h.git(h.ROOT, 'status', '--porcelain')), node: process.version,
      platform: process.platform, arch: process.arch, runtime, packaged, model: selected?.identity || { called: false, fakePi: true },
      sourceDigests: Object.fromEntries(['electron/main.cjs', 'electron/preload.cjs', 'server.js', 'public/html-artifact-viewer.js', 'extensions/pi-gui-html/index.js'].map(p => [p, h.digest(path.join(h.ROOT, p))])) };
    for (const target of [{ name: 'source', executable: runtime.executable, main: path.join(h.ROOT, 'electron/main.cjs') }, ...(packaged ? [packaged] : [])]) {
      const targetMode = target.name === 'source' ? mode : 'offline', row = { target: target.name, mode: targetMode, phases: [] }; report.targets.push(row); save();
      let before;
      for (const phase of ['generate', 'restore']) {
        const result = await launchPhase(h, helper, world, target, targetMode === 'live' ? selected.env : normalPi, targetMode, phase);
        row.phases.push(result); report.passed += result.checks?.filter(x => x.pass).length || 0;
        report.failed += result.checks?.filter(x => !x.pass).length || (result.completed ? 0 : 1); save();
        if (!result.completed) {
          let sessionId = result.sessionId;
          const checkpointFile = path.join(world, 'evidence/checkpoint-' + target.name + '.json');
          try { sessionId ||= JSON.parse(fs.readFileSync(checkpointFile, 'utf8')).sessionId; } catch {}
          if (sessionId) {
            try { row.failedNative = nativeSummary(h, world, sessionId); }
            catch { row.failedNativeSummary = 'unavailable'; }
            save();
          }
          throw Error('acceptance_phase_failed');
        }
        const saved = JSON.parse(fs.readFileSync(path.join(world, 'evidence/checkpoint-' + target.name + '.json'), 'utf8'));
        row.native = nativeSummary(h, world, saved.sessionId); save();
        if (row.native.persistedPreviewImages !== 0 || !row.native.contextLinksValidated
          || row.native.formalPublishes !== saved.artifactIds.length) throw Error('native_evidence_missing');
        if (targetMode === 'offline' && (row.native.toolOrder.join(',') !== 'html_preview,html_render' || row.native.formalPublishes !== 1)) throw Error('offline_native_order_mismatch');
        if (before) { row.restartNoReplay = before === row.native.sessionSha256; if (!row.restartNoReplay) throw Error('restart_native_session_changed'); }
        if (phase === 'generate') {
          row.previewQualified = targetMode === 'offline' ? row.native.contextImages.some(image => image.mode === 'interactive') && row.native.previewModes.interactive > 0
            : row.native.previewModes.interactive > 0 && row.native.visionChallenge.randomCanvasDeclared && row.native.visionChallenge.reportedCodeFrozen;
          row.staticPreviewObserved = row.native.previewModes.static > 0;
          row.staticPreviewQualified = targetMode === 'offline' && row.staticPreviewObserved && row.native.contextImages.some(image => image.mode === 'static');
          row.previewUnavailable = row.native.toolErrors.some(error => error.tool === 'html_preview' && error.code === 'html_preview_unavailable');
          if (!row.previewQualified && !row.staticPreviewQualified && !row.previewUnavailable
            && !(targetMode === 'live' && row.staticPreviewObserved)) throw Error('native_evidence_missing');
        }
        before = row.native.sessionSha256; save();
      }
    }
    report.completed = report.targets.every(target => target.previewQualified);
    if (!report.completed) throw Error('interactive_preview_qualification_missing');
  } catch (error) { report.failed = Math.max(report.failed, 1); report.failure = { code: ['windows_required', 'packaged_app_shape_invalid', 'packaged_copy_digest_mismatch',
    'native_session_missing', 'native_evidence_missing', 'offline_native_order_mismatch', 'restart_native_session_changed', 'interactive_preview_qualification_missing', 'acceptance_phase_failed'].includes(error.message) ? error.message : 'acceptance_failed' }; }
  finally { report.elapsedMs = Date.now() - started; save(); }
  console.log(`HTML preview ${mode}: ${report.passed}/${report.passed + report.failed}; completed=${report.completed}; evidence=${resultFile}`);
  console.log('Source/packaged are separate; external-resource success, pixel-code correctness and security acceptance are NOT qualified.');
  return report.completed ? 0 : 1;
}
module.exports = { modeFor, packagedRoot, checkDriver, run, nativeSummary };
if (require.main === module) Promise.resolve().then(() => run()).then(code => { process.exitCode = code; }).catch(error => {
  const safe = ['live_opt_in_required', 'explicit_model_authorization_required', 'explicit_live_selection_required', 'explicit_credential_authorization_required',
    'explicit_fixture_credential_required', 'invalid_explicit_endpoint', 'invalid_explicit_selection', 'explicit_absolute_pi_bin_required', 'pi_entry_unavailable', 'invalid_mode', 'packaged_root_must_be_absolute'];
  console.error('HTML preview acceptance not run: ' + (safe.includes(error.message) ? error.message : 'driver_not_run')); process.exitCode = 2;
});
