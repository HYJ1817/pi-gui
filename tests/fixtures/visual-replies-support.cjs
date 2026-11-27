'use strict';

/* Test-only launch/report primitives. Importing this file never loads Electron,
 * Pi, model settings or credentials. All mutation roots are newly minted TEMP.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const PREFIX = 'pi-visual-replies-';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashText = text => crypto.createHash('sha256').update(text).digest('hex');

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function validateWorld(world, tempRoot = os.tmpdir()) {
  const real = fs.realpathSync(world);
  if (!path.basename(real).startsWith(PREFIX) || path.dirname(real).toLowerCase() !== fs.realpathSync(tempRoot).toLowerCase()
    || inside(ROOT, real) || fs.lstatSync(world).isSymbolicLink()) throw Error('invalid_fixture_root');
  return real;
}
function createWorld() {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  validateWorld(world);
  for (const name of ['home', 'appdata', 'localappdata', 'tmp', 'profile', 'logs', 'agent', 'data', 'runtime', 'evidence', 'project-a', 'project-b']) {
    fs.mkdirSync(path.join(world, name));
  }
  return world;
}
function gitEnv(cwd, ambient = process.env) {
  const env = Object.fromEntries(Object.entries(ambient).filter(([key]) => !/^GIT_/i.test(key)));
  return { ...env, GIT_CONFIG_GLOBAL: path.join(cwd, '.no-global-config'), GIT_CONFIG_SYSTEM: path.join(cwd, '.no-system-config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_ATTR_NOSYSTEM: '1' };
}
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
    '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args], {
    cwd, env: gitEnv(cwd), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function childEnvironment(world, ambient = process.env) {
  validateWorld(world);
  const env = {};
  // Allowlist, rather than clearing a finite list of model/proxy/tool secrets.
  for (const [key, value] of Object.entries(ambient)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|ELECTRON_OVERRIDE_DIST_PATH)$/i.test(key)) env[key] = value;
  Object.assign(env, {
    HOME: path.join(world, 'home'), USERPROFILE: path.join(world, 'home'), APPDATA: path.join(world, 'appdata'), LOCALAPPDATA: path.join(world, 'localappdata'),
    TEMP: path.join(world, 'tmp'), TMP: path.join(world, 'tmp'), TMPDIR: path.join(world, 'tmp'),
    PI_GUI_DATA: path.join(world, 'data'), PI_GUI_RUNTIME_DIR: path.join(world, 'runtime'), PI_GUI_LOG_DIR: path.join(world, 'logs'),
    PI_CODING_AGENT_DIR: path.join(world, 'agent'), PI_CWD: path.join(world, 'project-a'),
    PI_GUI_OPEN: '0', PI_OFFLINE: '1', PI_GUI_OFFLINE: '1',
    VISUAL_REPLIES_WORLD: world, VISUAL_REPLIES_TEMP_ROOT: fs.realpathSync(os.tmpdir()), VISUAL_REPLIES_MAIN: path.join(ROOT, 'electron/main.cjs'),
  });
  return gitEnv(world, env);
}
function prepareProjects(world) {
  for (const name of ['project-a', 'project-b']) {
    const cwd = path.join(world, name);
    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.name', 'Visual Replies Fixture');
    git(cwd, 'config', 'user.email', 'fixture@example.invalid');
    git(cwd, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'VISUAL_REPLIES_OFFLINE_INPUT\n', { flag: 'wx' });
    git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'fixture baseline');
  }
  fs.writeFileSync(path.join(world, 'data/projects.json'), JSON.stringify({ active: path.join(world, 'project-a'),
    items: ['project-a', 'project-b'].map(name => ({ path: path.join(world, name), name: 'Visual Replies ' + name })) }), { flag: 'wx' });
  fs.writeFileSync(path.join(world, 'data/session-title-settings.json'), JSON.stringify({ version: 1, autoEnabled: false,
    enabledAt: new Date().toISOString(), revision: 1 }), { flag: 'wx' });
}
function prepareFakePi(world) {
  const pkg = path.join(world, 'node_modules/@earendil-works/pi-coding-agent');
  fs.mkdirSync(path.join(pkg, 'dist/core/extensions'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'dist/cli'), { recursive: true });
  // Baseline handshake only. candidate-pi is an existing upstream-shaped fixture;
  // it does NOT implement Visual Replies or qualify any new business contract.
  fs.copyFileSync(path.join(ROOT, 'tests/fixtures/candidate-pi.cjs'), path.join(pkg, 'cli.cjs'), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0', bin: { pi: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), '"tool_call" "tool_execution_end" getAllTools() registerTool<');
  fs.writeFileSync(path.join(pkg, 'dist/cli/args.js'), 'if (arg === "--extension") {}');
  const shim = path.join(world, 'pi.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${path.join(pkg, 'cli.cjs')}" %*\r\n`, { flag: 'wx' });
  return shim;
}
async function freePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = net.createServer(), port = crypto.randomInt(16000, 40000);
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      await new Promise(resolve => server.close(resolve)); return port;
    } catch (error) { if (!['EACCES', 'EADDRINUSE'].includes(error.code)) throw error; }
  }
  throw Error('port_unavailable');
}
function saveJson(file, value) {
  const tmp = file + '.pending';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function processTable(marker) {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; birth=$_.CreationDate.ToUniversalTime().Ticks.ToString(); exe=$_.ExecutablePath; command=$_.CommandLine } } | ConvertTo-Json -Compress";
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({ pid: item.pid, parent: item.parent, birth: item.birth,
    exeSha256: hashText(String(item.exe || '').toLowerCase()), commandSha256: hashText(String(item.command || '')),
    marker: typeof item.command === 'string' && item.command.includes(marker) }));
}
function sameProcess(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.birth === b.birth && a.exeSha256 === b.exeSha256 && a.commandSha256 === b.commandSha256);
}
function processFamily(all, original) {
  if (!all.some(item => sameProcess(item, original))) return [];
  const ids = new Set([original.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of all) if (ids.has(item.parent) && item.birth >= original.birth && !ids.has(item.pid)) { ids.add(item.pid); changed = true; }
  }
  return all.filter(item => ids.has(item.pid));
}
function canTerminate(handle, original, current) {
  return handle?.exitCode === null && handle?.signalCode === null && original?.marker === true && sameProcess(original, current);
}
function terminateOwned(handle, original, marker) {
  if (handle?.exitCode !== null || handle?.signalCode !== null) return { attempted: false, reason: 'already_exited' };
  const current = processTable(marker).find(item => item.pid === handle.pid);
  if (!canTerminate(handle, original, current)) return { attempted: false, reason: 'identity_unconfirmed' };
  const killed = spawnSync('taskkill.exe', ['/PID', String(handle.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  return { attempted: true, reason: 'fallback_kill_invalidates_acceptance', exitCode: killed.status };
}
function complete(report, required) {
  return Boolean(report && report.completed === true && report.failed === 0 && typeof report.endedAt === 'string'
    && Number.isFinite(Date.parse(report.endedAt)) && report.exit?.code === 0 && report.exit.signal === null
    && report.cleanup?.quitObserved === true && report.cleanup.runtimeOwners?.confirmed === true
    && report.processCleanup?.confirmed === true && report.privacy?.verified === true
    && Array.isArray(report.checks) && report.checks.every(item => item.pass === true)
    && required.every(id => report.checks.some(item => item.id === id && item.pass === true)));
}
const PREFLIGHT_CHECKS = ['production-main', 'normal-sandbox', 'production-preload', 'backend-health', 'temporary-owner',
  'renderer-no-node', 'theme-dark-wide', 'theme-dark-narrow', 'theme-light-wide', 'theme-light-narrow', 'parent-observed'];

module.exports = { ROOT, PREFIX, sleep, digest, hashText, inside, validateWorld, createWorld, gitEnv, git, childEnvironment,
  prepareProjects, prepareFakePi, freePort, saveJson, processTable, sameProcess, processFamily, canTerminate, terminateOwned, complete, PREFLIGHT_CHECKS };
