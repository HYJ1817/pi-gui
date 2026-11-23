/* Opt-in Windows acceptance using the installed Pi CLI and the production HTTP backend.
 * npm serves only two local fixture tarballs over loopback. No model call is made. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { createHash, randomBytes } = require('node:crypto');

const pi = process.env.PI_BIN;
if (process.platform !== 'win32' || !pi || !path.isAbsolute(pi)) {
  throw new Error('Set PI_BIN to the absolute installed pi.cmd path on Windows.');
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-capabilities-live-'));
const [home, agent, data, a, b] = ['home', 'agent', 'data', 'project-a', 'project-b'].map((name) => path.join(root, name));
const token = randomBytes(24).toString('hex');
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const json = (file, value) => write(file, JSON.stringify(value));
const extension = (name) => `export default function(pi) { pi.registerCommand(${JSON.stringify(name)}, { description: "Local test fixture", handler: async () => {} }); }`;
const skill = (dir, name) => write(path.join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Local test fixture\n---\n`);
const packageName = 'pi-memory'; // Existing built-in catalog ID, served exclusively by the fixture registry.
const versions = ['1.0.0', '1.1.0'];
let latest = versions[0];
let registryAvailable = true;
const packages = new Map();
const registry = http.createServer((req, res) => {
  if (!registryAvailable) { res.writeHead(503).end('{}'); return; }
  if (req.url === '/' + packageName) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: packageName, 'dist-tags': { latest }, versions: Object.fromEntries(
      versions.slice(0, versions.indexOf(latest) + 1).map((version) => [version, packages.get(version).manifest]),
    ) }));
    return;
  }
  const fixture = [...packages.values()].find((entry) => req.url === entry.url.pathname);
  if (fixture) { res.end(fixture.bytes); return; }
  res.writeHead(404).end('{}');
});
let backend;
let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log('ok ' + ++passed + ' ' + name);
}

async function address(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

async function until(label, read, test, timeout = 45_000) {
  const end = Date.now() + timeout;
  let last;
  do {
    try {
      last = await read();
      if (test(last)) return last;
    } catch (error) { last = { code: error.code || error.name }; }
    await sleep(250);
  } while (Date.now() < end);
  throw new Error(label + ' timed out (code ' + (last?.code || 'none') + ')');
}

async function main() {
  const npmOrigin = await address(registry);
  for (const version of versions) {
    const folder = path.join(root, version);
    const manifest = { name: packageName, version, type: 'module', pi: { extensions: ['./index.js'] } };
    json(path.join(folder, 'package', 'package.json'), manifest);
    write(path.join(folder, 'package', 'index.js'), extension(version === versions[0] ? 'phase3-fixture-v1' : 'phase3-fixture-v2'));
    const tarball = path.join(folder, 'package.tgz');
    // The system bsdtar by full path: under Git Bash a bare tar.exe is GNU tar, which reads C:\… as a remote host.
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
      ['-czf', tarball, '-C', folder, 'package'], { windowsHide: true });
    const bytes = fs.readFileSync(tarball);
    const url = new URL(`/${packageName}/-/${packageName}-${version}.tgz`, npmOrigin);
    manifest.dist = { tarball: url.href, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
    packages.set(version, { manifest, bytes, url });
  }
  for (const dir of [home, data, a, b]) fs.mkdirSync(dir, { recursive: true });
  for (const [dir, name] of [[a, 'fixture-a'], [b, 'fixture-b']]) {
    fs.mkdirSync(path.join(dir, '.git'));
    write(path.join(dir, '.pi', 'extensions', name + '.js'), extension(name));
  }
  json(path.join(data, 'projects.json'), { active: a, items: [{ path: a, name: 'A' }, { path: b, name: 'B' }] });
  json(path.join(agent, 'settings.json'), { defaultProjectTrust: 'always', theme: 'dark' });
  skill(agent, 'fixture-global');
  skill(path.join(b, '.pi'), 'fixture-project-b');
  const stdio = path.join(root, 'mcp-fixture.cjs');
  write(stdio, `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      const { id, method, params } = JSON.parse(line);
      if (id === undefined) return;
      const result = method === 'initialize'
        ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
        : method === 'tools/list'
          ? { tools: [{ name: 'fixture_ping', description: 'Local fixture', inputSchema: { type: 'object' } }] }
          : method === 'tools/call' ? { content: [{ type: 'text', text: 'fixture pong' }] } : {};
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  `);
  const npmrc = path.join(root, 'npmrc');
  write(npmrc, '');
  const globalNpmrc = path.join(root, 'npmrc-global');
  write(globalNpmrc, '');
  const reservation = http.createServer();
  const origin = await address(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|pathext|systemroot|systemdrive|windir|comspec|temp|tmp|processor_architecture|programfiles.*)$/i.test(name)));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home,
    PI_CODING_AGENT_DIR: agent, PI_GUI_DATA: data, PI_BIN: pi, PI_SKIP_VERSION_CHECK: '1',
    PI_GUI_TOKEN: token, PI_GUI_OPEN: '0', PORT: new URL(origin).port,
    npm_config_registry: npmOrigin, npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_userconfig: npmrc, npm_config_globalconfig: globalNpmrc,
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_fetch_retries: '0',
  });
  const entry = process.env.PI_GUI_LIVE_BACKEND || path.join(__dirname, '..', 'server.js');
  backend = spawn(process.execPath, [entry], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  function api(endpoint, input, method = input === undefined ? 'GET' : 'POST') {
    return fetch(origin + endpoint, {
      method, headers: { 'x-pi-gui-token': token, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    }).then((res) => res.json());
  }
  const skills = () => api('/api/skills');
  const extensions = () => api('/api/extensions');
  const activeCommand = (result, name) => result.capabilityRegistry?.commands.some((command) => command.name === name);
  const ready = (name) => until(name, skills, (result) => result.skills?.some((item) => item.name === name && item.loaded === true));
  const mcpServers = () => api('/api/mcp/servers');
  const mcpFile = path.join(agent, 'mcp.json');

  const baseline = await ready('fixture-global');
  check('Pi loads the isolated global skill and project A extension', activeCommand(await extensions(), 'fixture-a'));
  const create = await api('/api/skills/create?project=' + baseline.context.project, {
    target: 'project-pi', name: 'fixture-created', description: 'Created through the HTTP API', body: '# Fixture\n',
  });
  check('project skill creation succeeded and awaits Pi restart', create.ok && create.restartRequired);
  const config = await api('/api/mcp/config');
  const mcp = await api('/api/mcp/config', {
    action: 'save', scope: 'user', name: 'fixture-mcp', transport: 'stdio', command: process.execPath,
    args: [stdio], description: 'Local stdio fixture', expectedRevision: config.revisions?.user, __expectedCwd: a,
  });
  check('MCP config was saved (' + (mcp.code || 'ok') + ')', mcp.ok && fs.existsSync(mcpFile));
  const mcpBytes = fs.readFileSync(mcpFile);
  const market = await api('/api/extensions/market');
  check('built-in market provides the package ID without network consent', market.items?.some((item) => item.id === 'npm:' + packageName));
  const act = (action, id) => api('/api/extensions/packages', { action, id, confirm: true, __expectedCwd: a });
  registryAvailable = false;
  const failed = await act('install', 'npm:' + packageName);
  check('registry failure leaves the package unregistered', failed.ok === false && failed.commandStarted && failed.after?.configured === false);
  await ready('fixture-global');
  registryAvailable = true;
  const installed = await act('install', 'npm:' + packageName);
  check('Pi CLI registered and installed fixture 1.0.0 (' + (installed.code || 'unknown') + '/' + (installed.cause || 'none') + ')',
    installed.ok && installed.verified && installed.after?.version === versions[0]);
  await ready('fixture-created');
  await until('installed extension command', extensions, (result) => activeCommand(result, 'phase3-fixture-v1'));
  check('automatic restart loaded the new skill and extension command via Pi RPC', true);
  const duplicate = await act('install', 'npm:' + packageName);
  check('duplicate install is refused', duplicate.code === 'already-installed');
  const inventory = await api('/api/extensions/packages');
  const pkg = inventory.packages?.find((entry) => entry.name === packageName);
  check('package inventory records installation separately', pkg?.installed === true && pkg?.scope === 'global');

  const fixtureConnected = (servers) => servers?.some((server) =>
    server.name === 'fixture-mcp' && server.state === 'connected' && server.tools?.includes('fixture_ping')) === true;
  // "Cleared" only counts when an observation existed first, so each clearing step reads it back beforehand.
  const observed = async () => {
    const result = await mcpServers();
    return result.ok === true && fixtureConnected(result.runtime?.servers);
  };
  const cleared = async () => {
    const result = await mcpServers();
    return result.ok === true && Array.isArray(result.servers) && result.runtime === null;
  };
  const connected = await api('/api/mcp/status', { __expectedCwd: a });
  check('the same environment connects the fixture MCP server and discovers its tool', connected.ok && fixtureConnected(connected.servers));
  check('the connection observation is readable before the restart', await observed());
  const firstRun = (await api('/api/status')).bridgeRun;
  check('same-workspace restart is accepted', (await api('/api/restart', {})).ok);
  await until('same-workspace restart', () => api('/api/status'), (state) => state.bridgeRun > firstRun && state.bridgeState === 'ready');
  check('same-workspace restart discards the prior MCP connection observation', await cleared());
  const reconnected = await api('/api/mcp/status', { __expectedCwd: a });
  check('an explicit check after restarting connects the fixture MCP server again', reconnected.ok && fixtureConnected(reconnected.servers));
  check('workspace A holds a connection observation before the project switch', await observed());
  const activate = (dir) => api('/api/projects/activate', { path: dir });
  check('project B activates', (await activate(b)).ok);
  const projectB = await ready('fixture-project-b');
  const bExtensions = await extensions();
  check('project B has its own resources and retains global resources',
    projectB.skills.some((item) => item.name === 'fixture-global' && item.loaded) &&
    !projectB.skills.some((item) => item.name === 'fixture-created') &&
    activeCommand(bExtensions, 'fixture-b') && !activeCommand(bExtensions, 'fixture-a') &&
    activeCommand(bExtensions, 'phase3-fixture-v1'));
  const bMcp = await mcpServers();
  check('MCP persists in B without importing A runtime observations',
    bMcp.ok === true && bMcp.servers?.some((entry) => entry.name === 'fixture-mcp') && bMcp.runtime === null &&
    fs.readFileSync(mcpFile).equals(mcpBytes));
  check('project A activates again', (await activate(a)).ok);
  await ready('fixture-created');
  check('returning to A does not restore the earlier MCP observation', await cleared());
  latest = versions[1];
  const updated = await act('update', pkg.id);
  check('Pi updates the installed fixture to 1.1.0', updated.ok && updated.verified && updated.after?.version === latest);
  await until('updated extension command', extensions, (result) => activeCommand(result, 'phase3-fixture-v2'));
  const removed = await act('remove', pkg.id);
  check('Pi removes the package registration', removed.ok && removed.verified && removed.after?.configured === false);
  // Absence only counts on a populated command list: project A's own command is there, the removed one is not.
  await until('removed extension command', extensions, (result) =>
    result.piReachable && activeCommand(result, 'fixture-a') && !activeCommand(result, 'phase3-fixture-v2'));
  check('MCP bytes are unchanged after package install, update, removal and restarts', fs.readFileSync(mcpFile).equals(mcpBytes));
  check('unrelated user settings survive npm operations', JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'))).theme === 'dark');
  const edited = await api('/api/mcp/config', {
    action: 'save', scope: 'user', name: 'fixture-mcp', originalName: 'fixture-mcp',
    transport: 'stdio', command: process.execPath, args: [stdio], description: 'Updated fixture',
    expectedRevision: (await api('/api/mcp/config')).revisions.user, __expectedCwd: a,
  });
  check('MCP configuration edit preserves the server identity', edited.ok &&
    (await mcpServers()).servers?.some((entry) => entry.name === 'fixture-mcp' && entry.description === 'Updated fixture'));
  const deleted = await api('/api/mcp/config', {
    action: 'delete', scope: 'user', name: 'fixture-mcp', expectedRevision: edited.revisions.user, __expectedCwd: a,
  });
  // A failed read must not pass as "deleted": require a successful list first, then check the target is absent.
  const afterDelete = await mcpServers();
  check('MCP configuration deletion is visible from a successful backend read', deleted.ok &&
    afterDelete.ok === true && Array.isArray(afterDelete.servers) &&
    !afterDelete.servers.some((entry) => entry.name === 'fixture-mcp'));
  check('the deleted MCP server is gone from the configuration file',
    !fs.existsSync(mcpFile) || !fs.readFileSync(mcpFile, 'utf8').includes('fixture-mcp'));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (backend?.pid && backend.exitCode === null) {
    try { execFileSync('taskkill.exe', ['/PID', String(backend.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  registry.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  console.log(`${passed} passed, ${process.exitCode === 1 ? 1 : 0} failed`);
});
