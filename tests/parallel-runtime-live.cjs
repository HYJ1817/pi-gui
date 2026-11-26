/* Explicit opt-in only. Real installed Pi/model + production Windows Electron.
 * Default execution exits before imports, fixture creation, or child launch.
 * Never register an opt-in environment variable in the canonical npm test chain.
 */
if (process.env.PI_GUI_PARALLEL_LIVE !== '1') {
  console.log('Parallel runtime live: skipped (set PI_GUI_PARALLEL_LIVE=1 explicitly)');
  process.exit(0);
}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let world, child, childIdentity, probeSource, probeSourceBefore;
function probeFingerprint(root) {
  const entries = [];
  function walk(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Error('invalid_probe_fixture');
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    else if (stat.isFile()) entries.push([relative, stat.size, digest(file)]);
    else throw Error('invalid_probe_fixture');
  }
  for (const relative of ['project-one', 'project-two', 'agent/sessions', 'data/conversations.json', 'data/projects.json', 'evidence']) walk(relative);
  return { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry[1], 0),
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
function cloneProbeState(source, target) {
  // Preserve native header cwd and UUID verbatim. The old TEMP project roots
  // are read-only control-plane inputs; every mutable agent/data/app lives in
  // the new TEMP. No auth, model config, logs or raw evidence is copied.
  fs.cpSync(path.join(source, 'agent/sessions'), path.join(target, 'agent/sessions'), { recursive: true });
  const projects = JSON.parse(fs.readFileSync(path.join(source, 'data/projects.json'), 'utf8'));
  const expected = ['project-one', 'project-two'].map(name => path.join(source, name));
  if (projects.items.length !== 2 || projects.items.some((item, index) => path.resolve(item.path) !== expected[index])
    || path.resolve(projects.active) !== expected[0]) throw Error('invalid_probe_fixture');
  fs.writeFileSync(path.join(target, 'data/projects.json'), JSON.stringify(projects), { flag: 'wx' });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'data/conversations.json'), 'utf8'));
  for (const record of manifest.items) if (record.sessionLocator) {
    const relative = path.relative(path.join(source, 'agent/sessions'), record.sessionLocator);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('invalid_probe_fixture');
    const copied = fs.realpathSync(path.join(target, 'agent/sessions', relative));
    if (digest(copied) !== digest(record.sessionLocator)) throw Error('invalid_probe_fixture');
    const stat = fs.statSync(copied);
    record.sessionLocator = copied;
    record.sessionIdentity = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
  }
  fs.writeFileSync(path.join(target, 'data/conversations.json'), JSON.stringify(manifest), { flag: 'wx' });
  fs.copyFileSync(path.join(source, 'evidence/exercise.json'), path.join(target, 'evidence/exercise.json'), fs.constants.COPYFILE_EXCL);
}
// SAFETY_HELPERS_BEGIN (also exercised by fixture --check-safety, no live imports)
function gitEnv(cwd, ambient = process.env) {
  const env = Object.fromEntries(Object.entries(ambient).filter(([key]) => !/^GIT_/i.test(key)));
  return { ...env, GIT_CONFIG_GLOBAL: path.join(cwd, '.no-global-config'), GIT_CONFIG_SYSTEM: path.join(cwd, '.no-system-config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_ATTR_NOSYSTEM: '1' };
}
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args], { cwd, windowsHide: true,
  env: gitEnv(cwd), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const requiredChecks = {
  common: ['production main uses normal sandbox, context isolation and no nodeIntegration', 'production preload is active',
    'cleanup public runtime closes are confirmed', 'parent observed this live process family before cleanup'],
  exercise: ['three real model tasks overlap while A is still running', 'SSE records genuine agent_start for A/B/C',
    'fourth actual runtime admission is rejected without raising hard cap', 'stopping A leaves B/C streaming and same native identities',
    'real B tool_wait_state proves intentional same-root write coordination', 'real Electron reload recovers B/C owners without abort or auto-respawn',
    'B/C completed real native write/read tasks with exact isolated outputs', 'B real native write/read/bash tool invocation',
    'C real native write/read/bash tool invocation', 'explicit runtime restart accepted',
    'restart preserves native session and rotates runtimeId/generation', 'old owner cannot read or replay after real runtime restart',
    'B production read-only history binds exact native session and tool result', 'C production read-only history binds exact native session and tool result'],
  recovery: ['real app/backend restart restores dormant records without spawning B/C',
    'B persisted history survives actual Electron/backend restart', 'C persisted history survives actual Electron/backend restart',
    'B prior backend owner is rejected after restart', 'C prior backend owner is rejected after restart',
    'explicit non-classic native resume after backend restart is admitted within budget',
    'resume binds persisted native session with new backend/runtime identity', 'recovery does not generate a model task',
    'explicit close returns resumed slot while preserving classic'],
  'owner-probe': ['classic-held native session resume is rejected without spawning', 'classic holds the original real persisted B native session',
    'model-free probe resumes materialized ordinary project native session', 'ordinary project restart accepted in model-free probe',
    'model-free restart preserves native session and rotates runtime owner', 'model-free restart rejects prior owner reads and event replay',
    'model-free resumed C history is from the original real persisted model task', 'entire resume and restart probe performs zero model generations'],
};
function phaseValid(report, phase) {
  return Boolean(requiredChecks[phase]) && report?.phase === phase && report.completed === true && report.failed === 0 && typeof report.endedAt === 'string'
    && Number.isFinite(Date.parse(report.endedAt)) && report.exit?.code === 0 && report.exit.signal === null
    && report.cleanup?.confirmed === true && report.processCleanup?.confirmed === true
    && Array.isArray(report.checks) && report.checks.every(check => check.pass === true)
    && [...requiredChecks.common, ...requiredChecks[phase]].every(name => report.checks.some(check => check.name === name && check.pass === true));
}
function acceptanceComplete(phases, expected, privacyVerified) { return privacyVerified === true && phases.length === expected.length
  && phases.every((report, index) => phaseValid(report, expected[index])); }
function sameProcess(a, b) { return Boolean(a && b && a.pid === b.pid && a.birth === b.birth
  && a.exeSha256 === b.exeSha256 && a.commandSha256 === b.commandSha256); }
function canTerminate(handle, original, current) { return handle?.exitCode === null && handle?.signalCode === null
  && original?.marker === true && sameProcess(original, current); }
function processTable(marker) {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; birth=$_.CreationDate.ToUniversalTime().Ticks.ToString(); exe=$_.ExecutablePath; command=$_.CommandLine } } | ConvertTo-Json -Compress";
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
  const value = JSON.parse(output);
  return (Array.isArray(value) ? value : [value]).map(item => ({ pid: item.pid, parent: item.parent, birth: item.birth,
    exeSha256: createHash('sha256').update(String(item.exe || '').toLowerCase()).digest('hex'),
    commandSha256: createHash('sha256').update(String(item.command || '')).digest('hex'),
    marker: typeof item.command === 'string' && item.command.includes(marker) }));
}
function processFamily(all, original) {
  const root = all.find(item => sameProcess(item, original));
  if (!root) return [];
  const owned = new Set([root.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of all) if (owned.has(item.parent) && item.birth >= root.birth && !owned.has(item.pid)) { owned.add(item.pid); changed = true; }
  }
  return all.filter(item => owned.has(item.pid));
}
// SAFETY_HELPERS_END
function gitEvidence(cwd) {
  const status = git(cwd, 'status', '--porcelain=v1', '--untracked-files=all');
  return { head: git(cwd, 'rev-parse', 'HEAD'), statusEntries: status ? status.split(/\r?\n/) : [],
    index: { bytes: fs.statSync(path.join(cwd, '.git/index')).size, sha256: digest(path.join(cwd, '.git/index')) },
    tracked: ['seed.txt', 'hold.cjs'].map(file => ({ file, bytes: fs.statSync(path.join(cwd, file)).size, sha256: digest(path.join(cwd, file)) })) };
}
async function freePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = net.createServer();
    const chosen = require('node:crypto').randomInt(16000, 40000);
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(chosen, '127.0.0.1', resolve); });
      const port = server.address().port;
      await new Promise(resolve => server.close(resolve));
      return port;
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw Error('port_unavailable');
}
async function run() {
  if (process.platform !== 'win32') throw Error('windows_required');
  execFileSync(process.execPath, [path.join(ROOT, 'tests/fixtures/parallel-runtime-electron.cjs'), '--check-driver'], {
    cwd: ROOT, env: { ...process.env, PI_GUI_PARALLEL_LIVE: '0' }, windowsHide: true, stdio: ['ignore', 'inherit', 'ignore'],
  });
  const probe = Boolean(process.env.PI_GUI_PARALLEL_PROBE_WORLD);
  const probePhase = process.env.PI_GUI_PARALLEL_PROBE_PHASE || 'owner-probe';
  if (probe && (process.env.PI_GUI_PARALLEL_PACKAGED !== '1' || probePhase !== 'owner-probe')) throw Error('invalid_probe_fixture');
  if (probe) {
    probeSource = fs.realpathSync(process.env.PI_GUI_PARALLEL_PROBE_WORLD);
    if (!path.basename(probeSource).startsWith('pi-parallel-live-')
      || path.dirname(probeSource).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase()
      || !fs.existsSync(path.join(probeSource, 'evidence/exercise.json'))) throw Error('invalid_probe_fixture');
    probeSourceBefore = probeFingerprint(probeSource);
  }
  world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-parallel-live-'));
  if (path.relative(ROOT, world).split(path.sep)[0] !== '..') throw Error('fixture_inside_repository');
  const out = path.join(world, 'evidence');
  const dirs = ['home', 'appdata', 'localappdata', 'agent', 'tmp', 'data', 'profile', 'logs', 'project-one', 'project-two', 'evidence'];
  for (const dir of dirs) fs.mkdirSync(path.join(world, dir), { recursive: true });
  if (probe) cloneProbeState(probeSource, world);
  console.log('Parallel live fixture: ' + world);
  const sourceAgent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const agent = path.join(world, 'agent');
  const { createPiLaunch } = await import('../server/pi-launch.js');
  const launch = createPiLaunch({ getCwd: () => ROOT });
  const entry = launch.cliEntry();
  if (!entry.ok) throw Error('pi_entry_unavailable');
  const sdk = await import(pathToFileURL(path.join(launch.packageDir(), 'dist/index.js')).href);
  const settings = JSON.parse(fs.readFileSync(path.join(sourceAgent, 'settings.json'), 'utf8'));
  const provider = process.env.PI_GUI_PARALLEL_PROVIDER || settings.defaultProvider;
  const modelId = process.env.PI_GUI_PARALLEL_MODEL || settings.defaultModel;
  const models = await sdk.ModelRuntime.create({ authPath: path.join(agent, 'auth.json'),
    modelsPath: path.join(sourceAgent, 'models.json'), modelsStorePath: path.join(agent, 'models-store.json'),
    allowModelNetwork: false, refreshOnCreate: false });
  if (models.isUsingOAuth(provider)) throw Error('oauth_requires_fixture_credentials');
  const model = models.getModel(provider, modelId);
  if (!model) throw Error('model_unavailable');
  const auth = await models.getAuth(model);
  if (!auth?.auth?.apiKey) throw Error('fixture_key_unavailable');
  if (Object.keys(auth.auth.headers || {}).some(key => !['authorization', 'content-type'].includes(key.toLowerCase()))) throw Error('custom_auth_headers_unsupported');
  const config = models.getRegisteredProviderConfig(provider) || {};
  const sourceModel = (config.models || []).find(item => item.id === modelId) || model;
  const selected = Object.fromEntries(['id', 'name', 'api', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'compat']
    .filter(key => sourceModel[key] !== undefined).map(key => [key, sourceModel[key]]));
  const baseUrl = auth.auth.baseUrl || config.baseUrl || model.baseUrl;
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw Error('endpoint_contains_private_fields');
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { [provider]: {
    baseUrl, api: config.api || model.api, apiKey: '$PI_GUI_PARALLEL_KEY', models: [{ ...selected, headers: undefined }],
  } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: provider, defaultModel: modelId,
    defaultThinkingLevel: 'off', packages: [], extensions: [], skills: [], promptTemplates: [], themes: [],
    retry: { enabled: false }, quietStartup: true }));
  const data = path.join(world, 'data');
  const projects = probe ? JSON.parse(fs.readFileSync(path.join(data, 'projects.json'), 'utf8')).items.map(item => item.path)
    : ['project-one', 'project-two'].map(name => path.join(world, name));
  for (const cwd of probe ? [] : projects) {
    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.name', 'Parallel Fixture');
    git(cwd, 'config', 'user.email', 'fixture@example.invalid');
    git(cwd, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(cwd, 'seed.txt'), 'PARALLEL_FIXTURE_INPUT\n');
    // This real shell child is deliberately a writer. On the same project its
    // lease must queue B, not be interpreted as model/global runtime serialism.
    fs.writeFileSync(path.join(cwd, 'hold.cjs'), [
      "const fs=require('node:fs'),path=require('node:path');",
      "const label=process.argv[2];if(!['A','B','C'].includes(label))process.exit(2);",
      "const root=fs.realpathSync(process.cwd());if(!root.includes('pi-parallel-live-'))process.exit(3);",
      "fs.writeFileSync(path.join(root,label+'-started.flag'),'started');",
      "const end=Date.now()+420000;const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'release-'+label+'.flag'))||Date.now()>end){clearInterval(timer);console.log(label+'_HOLD_RELEASED');}},100);",
      '',
    ].join('\n'));
    git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'fixture baseline');
  }
  if (!probe) fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ active: projects[0], items: projects.map((cwd, index) => ({ path: cwd, name: 'Fixture Project ' + (index + 1) })) }));
  fs.writeFileSync(path.join(data, 'session-title-settings.json'), JSON.stringify({ version: 1, autoEnabled: false, enabledAt: new Date().toISOString(), revision: 1 }));
  const files = ['server/pi-probes.js', 'server/session-tool-bridge.js', 'server/session-runtime.js', 'server/runtime-registry.js',
    'extensions/pi-gui-tool-guard/index.js', 'electron/main.cjs', 'public/runtime-store.js', 'public/runtime-conversation.js'];
  const identity = { head: git(ROOT, 'rev-parse', 'HEAD'), branch: git(ROOT, 'branch', '--show-current'),
    sourceDigests: Object.fromEntries(files.map(file => [file, digest(path.join(ROOT, file))])),
    pi: entry.version, provider: 'selected-existing-provider (redacted)', model: modelId, node: process.version, platform: process.platform,
    qualification: 'production-source-main-backend-normal-sandbox', optIn: true,
    mode: probe ? 'model-free-restart-probe' : 'full-live-exercise',
    driverDigests: { runner: digest(__filename), fixture: digest(path.join(ROOT, 'tests/fixtures/parallel-runtime-electron.cjs')) },
    ...(probe ? {} : { gitBefore: projects.map(gitEvidence) }) };
  let executable = require('electron');
  let main = path.join(ROOT, 'electron/main.cjs');
  let launchArgs = [path.join(ROOT, 'tests/fixtures/parallel-runtime-electron.cjs')];
  if (process.env.PI_GUI_PARALLEL_PACKAGED === '1') {
    const build = process.env.PI_GUI_PARALLEL_BUILD_ROOT || path.join(ROOT, 'dist-app/Pi GUI-win32-x64');
    if (!fs.existsSync(path.join(build, 'resources/app/server.cjs'))) throw Error('packaged_build_missing');
    const appCopy = path.join(world, 'application');
    fs.cpSync(build, appCopy, { recursive: true });
    const appRoot = path.join(appCopy, 'resources/app');
    main = path.join(appRoot, 'main.cjs');
    const manifestFile = path.join(appRoot, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.main = 'parallel-observer.cjs';
    fs.writeFileSync(path.join(appRoot, manifest.main), `require(${JSON.stringify(launchArgs[0])});\n`, { flag: 'wx' });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    executable = path.join(appCopy, 'Pi GUI.exe'); launchArgs = [];
    identity.qualification = 'packaged-production-bytes-observation-bootstrap-normal-sandbox';
    identity.packaged = { version: manifest.version, executable: digest(executable), backend: digest(path.join(appRoot, 'server.cjs')),
      main: digest(main), manifestBootstrapOverride: true,
      mainMatchesSource: digest(main) === digest(path.join(ROOT, 'electron/main.cjs')),
      publicMatchesSource: ['app.js', 'runtime-store.js', 'runtime-conversation.js'].every(file => digest(path.join(appRoot, 'public', file)) === digest(path.join(ROOT, 'public', file))) };
  }
  fs.writeFileSync(path.join(out, probe ? 'owner-probe-identity.json' : 'identity.json'), JSON.stringify(identity, null, 2));
  const env = { ...gitEnv(world), PARALLEL_WORLD: world, PARALLEL_PROJECTS: JSON.stringify(projects), PARALLEL_APP_MAIN: main,
    PI_GUI_PARALLEL_KEY: auth.auth.apiKey, PI_CODING_AGENT_DIR: agent,
    HOME: path.join(world, 'home'), USERPROFILE: path.join(world, 'home'), APPDATA: path.join(world, 'appdata'), LOCALAPPDATA: path.join(world, 'localappdata'),
    TEMP: path.join(world, 'tmp'), TMP: path.join(world, 'tmp'), TMPDIR: path.join(world, 'tmp'),
    PI_GUI_DATA: data, PI_GUI_RUNTIME_DIR: path.join(world, 'runtime'), PI_GUI_LOG_DIR: path.join(world, 'logs'),
    // Classic Windows RPC launches the same PATH shim as the real app; a bare
    // .js CLI entry is only valid when explicitly passed as a Node argument.
    PI_CWD: projects[0], PI_BIN: launch.identity().bin, PI_PROVIDER: provider, PI_MODEL: modelId, PI_THINKING: 'off',
    PI_GUI_OPEN: '0', PI_OFFLINE: '1', PI_GUI_OFFLINE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(world, 'no-global-config') };
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|PI_GUI_TOKEN|PI_GUI_BROWSER_|PI_GUI_RUNTIME_BROWSER_)/.test(key)) delete env[key];
  const phases = [];
  for (const phase of probe ? [probePhase] : ['exercise', 'recovery']) {
    if (phase === 'recovery' && !fs.existsSync(path.join(out, 'recovery-input.json'))) break;
    const port = await freePort();
    child = spawn(executable, [...launchArgs, '--user-data-dir=' + path.join(world, 'profile'), '--disable-background-networking'], {
      cwd: world, env: { ...env, PARALLEL_PHASE: phase, PORT: String(port) }, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBytes = 0, stderrBytes = 0, phaseExit = null, spawnError = false;
    child.stdout.on('data', chunk => { stdoutBytes += chunk.length; for (const line of String(chunk).split(/\r?\n/)) if (/^(PASS|FAIL|STAGE|Parallel Electron)/.test(line)) console.log(line); });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    child.once('error', () => { spawnError = true; });
    child.once('exit', (code, signal) => { phaseExit = { code, signal }; });
    childIdentity = processTable(world).find(item => item.pid === child.pid && item.marker);
    if (!childIdentity) throw Error('process_identity_unavailable');
    let observed = [], observedAt = null;
    const readyFile = path.join(world, phase + '-ready-for-cleanup');
    const deadline = Date.now() + 540000;
    while (!phaseExit && !spawnError && Date.now() < deadline) {
      if (!observedAt && fs.existsSync(readyFile)) {
        observed = processFamily(processTable(world), childIdentity); observedAt = new Date().toISOString();
        fs.writeFileSync(path.join(world, phase + '-processes-observed'), observed.length >= 2 ? 'confirmed' : 'unconfirmed', { flag: 'wx' });
      }
      await sleep(100);
    }
    if (!phaseExit) throw Error(spawnError ? 'electron_spawn_failed' : 'electron_timeout');
    const exit = phaseExit;
    let residual = observed;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = processTable(world);
      residual = observed.filter(item => current.some(candidate => sameProcess(item, candidate)));
      if (!residual.length) break;
      await sleep(250);
    }
    const resultFile = path.join(out, phase + '.json');
    const report = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { checks: [], failed: 1, failure: { stage: 'before_report' } };
    Object.assign(report, { exit, stdoutBytes, stderrBytes, processCleanup: { observedAt, observed: observed.length,
      identities: observed, residual: residual.length, confirmed: observed.length >= 2 && residual.length === 0 } });
    fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
    phases.push(report);
    // The next app must not overlap the preceding backend's process cleanup.
    if (exit.code !== 0) break;
    await sleep(500);
  }
  const expectedPhases = probe ? [probePhase] : ['exercise', 'recovery'];
  const passed = phases.reduce((sum, phase) => sum + (phase.checks || []).filter(check => check.pass === true).length, 0);
  const failed = phases.reduce((sum, phase, index) => sum + Math.max((phase.checks || []).filter(check => check.pass !== true).length,
    phaseValid(phase, expectedPhases[index]) ? 0 : 1), 0) + Math.max(0, expectedPhases.length - phases.length);
  // Scan BEFORE creating a green summary. The live key never appears in stdout.
  let privacyVerified = true;
  for (const name of fs.readdirSync(out).filter(name => name.endsWith('.json'))) {
    if (fs.readFileSync(path.join(out, name), 'utf8').includes(auth.auth.apiKey)) privacyVerified = false;
  }
  const completed = acceptanceComplete(phases, expectedPhases, privacyVerified);
  const summary = { identity, passed, failed: failed + (privacyVerified ? 0 : 1), phases: phases.map(phase => ({ phase: phase.phase, exit: phase.exit,
    passed: (phase.checks || []).filter(check => check.pass === true).length, failed: phase.failed, valid: phaseValid(phase, phase.phase) })),
    completed, fullLiveAcceptance: !probe && completed,
    privacy: { verified: privacyVerified, rawPayloadSaved: false, credentialsInEnvironmentOnly: true, sourceUserDataReadOnly: true, fixturesInOsTmpdir: true },
    ...(probe ? {} : { gitAfter: projects.map(gitEvidence) }) };
  if (probe) {
    const after = probeFingerprint(probeSource);
    summary.sourceFixture = { before: probeSourceBefore, after, unchanged: JSON.stringify(after) === JSON.stringify(probeSourceBefore),
      nativeSessionCopy: 'byte-identical; real copied file locator/stat; original header cwd and UUID retained',
      projects: 'original TEMP roots read-only; no prompt or shell; originals verified by digest' };
    if (!summary.sourceFixture.unchanged) { summary.completed = false; summary.failed++; }
  }
  fs.writeFileSync(path.join(out, probe ? 'owner-probe-summary.json' : 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`Parallel runtime live: ${passed}/${passed + summary.failed}; failed=${summary.failed}; evidence=${out}`);
  if (!summary.completed) process.exitCode = 1;
}
run().catch(error => {
  const safe = new Set(['windows_required', 'fixture_inside_repository', 'pi_entry_unavailable', 'oauth_requires_fixture_credentials', 'model_unavailable',
    'fixture_key_unavailable', 'custom_auth_headers_unsupported', 'endpoint_contains_private_fields', 'port_unavailable', 'packaged_build_missing', 'electron_timeout', 'evidence_secret_leak', 'invalid_probe_fixture']);
  console.error('Parallel live failed: ' + (safe.has(error.message) ? error.message : error.name));
  if (world) console.error('Evidence fixture: ' + world);
  process.exitCode = 1;
}).finally(() => {
  if (child?.exitCode === null && child?.signalCode === null && childIdentity) {
    // A reused PID, signal-exited handle, missing CIM witness or changed command
    // line never authorizes a kill. A fallback kill is always failed acceptance.
    try {
      const current = processTable(world).find(item => item.pid === child.pid);
      if (canTerminate(child, childIdentity, current)) {
        require('node:child_process').spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        process.exitCode = 1;
      }
    } catch { process.exitCode = 1; }
  }
});
