/* P15: all discovery fixtures live in tmp; no real Pi, network, or user settings. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const { createExtensionRegistry, mapRegisteredTools } = await import('../server/extension-registry.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p15-'));
  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };
  const put = (rel, value) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return file;
  };
  try {
    const agent = path.join(root, 'agent');
    const project = path.join(root, 'project');
    put('agent/extensions/shared.ts', 'export default () => {}');
    put('project/.pi/extensions/shared.ts', 'export default () => {}');
    put('agent/extensions/broken/index.ts', 'export default () => {}');
    put('agent/extensions/broken/package.json', '{broken');
    put('agent/extensions/unknown.ts', 'export default () => {}');
    const local = put('local/custom.ts', 'export default () => {}');
    put('agent/npm/node_modules/@example/tools/package.json', JSON.stringify({ name: '@example/tools', version: '1.2.3', description: 'token=SECRET123', pi: { extensions: ['extensions/index.ts', '../escape.ts'] } }));
    put('agent/npm/node_modules/@example/tools/extensions/index.ts', 'export default () => {}');
    put('agent/npm/node_modules/@example/escape.ts', 'export default () => {}');
    put('agent/settings.json', JSON.stringify({ extensions: [local, local, path.join(root, 'missing.ts')], packages: ['npm:@example/tools@1.2.3', 'npm:missing-package@1.0.0'] }));
    put('project/.pi/settings.json', JSON.stringify({ extensions: ['./extensions/shared.ts'] }));
    let cwd = project;
    let reachable = true;
    const rpc = { request: async () => reachable ? { commands: [{ name: 'hello', source: 'extension', sourceInfo: { path: local } }] } : null, getState: () => ({ bridgeRun: 2 }) };
    const registry = createExtensionRegistry({
      runtime: { getCurrentCwd: () => cwd }, rpc,
      env: { HOME: root, PI_CODING_AGENT_DIR: agent },
      readTrust: async () => ({ trusted: true, requiresTrust: true }),
    });
    const report = await registry.readIndex();
    check('global and project candidates are separate', () => assert.deepEqual(new Set(report.extensions.filter(x => x.name === 'shared').map(x => x.scope)), new Set(['global', 'project'])));
    check('duplicate declarations collapse to one path', () => assert.equal(report.extensions.filter(x => x.source.location === local).length, 1));
    check('malformed metadata does not hide other extensions', () => assert.ok(report.extensions.some(x => x.name === 'broken' && x.state.error)));
    check('unknown extension keeps unknown load and tool states', () => { const x = report.extensions.find(x => x.name === 'unknown'); assert.equal(x.state.loaded, null); assert.deepEqual(x.capabilities, []); });
    check('missing declaration is explicit', () => assert.ok(report.extensions.some(x => x.state.installed === false)));
    check('missing managed npm package is diagnosed without installation', () => assert.ok(report.diagnostics.some(x => x.code === 'package-missing')));
    check('package metadata supplies only verified version', () => assert.ok(report.extensions.some(x => x.version === '1.2.3' && x.source.type === 'npm')));
    check('package manifest traversal is rejected', () => assert.ok(report.diagnostics.some(x => x.phase === 'discovery' && x.code === 'outside-root')));
    check('RPC command links to extension path', () => { const x = report.extensions.find(x => x.source.location === local); assert.equal(x.state.loaded, true); assert.ok(x.capabilities.some(c => c.type === 'command' && c.id === 'hello')); });
    check('no RPC tool registry means no invented tool owner', () => assert.equal(report.capabilityRegistry.tools.length, 0));
    check('installed and enabled are distinct from loaded', () => { const x = report.extensions.find(x => x.name === 'unknown'); assert.equal(x.state.installed, true); assert.equal(x.state.enabled, null); assert.equal(x.state.loaded, null); });
    check('future authoritative tool registry maps multiple tools by path', () => { const mapped = mapRegisteredTools(report.extensions, [{ name: 'web_search', sourceInfo: { path: local } }, { name: 'fetch_content', sourceInfo: { path: local } }]); assert.equal(mapped.tools.length, 2); assert.equal(mapped.tools[0].extensionId, mapped.tools[1].extensionId); });
    check('unknown tool falls back without an owner', () => { const mapped = mapRegisteredTools(report.extensions, [{ name: 'mystery' }]); assert.equal(mapped.tools[0].extensionId, null); assert.equal(mapped.tools[0].name, 'mystery'); });
    check('tool name does not infer capability from package name', () => assert.equal(report.extensions.find(x => x.version === '1.2.3').capabilities.length, 0));
    check('config and package metadata secrets are not sent to renderer', () => assert.ok(!JSON.stringify(report).includes('SECRET123')));
    check('read-only actions are explicit', () => assert.deepEqual(report.actions, { install: false, toggle: false, remove: false, refresh: true, restart: true }));
    registry.observe({ type: 'extension_error', extensionPath: local, event: 'load', error: 'token=SECRET123' });
    const errored = await registry.readIndex();
    check('extension error is scoped and redacted', () => { const x = errored.extensions.find(x => x.source.location === local); assert.equal(x.state.loaded, false); assert.ok(!JSON.stringify(errored).includes('SECRET123')); });
    registry.observe({ type: 'bridge_status', state: 'starting', cwd: project, bridgeRun: 3 });
    const fresh = await registry.readIndex();
    check('Pi restart clears old runtime evidence', () => assert.equal(fresh.extensions.find(x => x.source.location === local).state.loaded, true));
    put('project/.pi/extensions/only-project.ts', 'export default () => {}');
    const untrusted = createExtensionRegistry({ runtime: { getCurrentCwd: () => project }, rpc,
      env: { HOME: root, PI_CODING_AGENT_DIR: agent }, readTrust: async () => ({ trusted: false, requiresTrust: true }) });
    const untrustedReport = await untrusted.readIndex();
    check('untrusted project extension is present but not enabled or loaded', () => { const x = untrustedReport.extensions.find(x => x.name === 'only-project'); assert.equal(x.state.installed, true); assert.equal(x.state.enabled, false); assert.equal(x.state.loaded, false); });
    const blocked = { writeHead(code) { this.code = code; return this; }, end(value) { this.body = value; return this; } };
    await registry.handle({ method: 'PUT' }, blocked);
    check('unsupported mutation returns 405 without touching settings', () => assert.equal(blocked.code, 405));
    reachable = false;
    cwd = path.join(root, 'other');
    const other = await registry.readIndex();
    check('project switch excludes old project extensions and commands', () => { assert.ok(other.extensions.every(x => x.scope !== 'project')); assert.equal(other.capabilityRegistry.commands.length, 0); });
    check('discovery failure and missing RPC do not throw', () => assert.equal(other.piReachable, false));
    cwd = project;
    let completeRequest;
    const delayed = createExtensionRegistry({ runtime: { getCurrentCwd: () => cwd },
      rpc: { getState: () => ({ bridgeRun: 4 }), request: () => new Promise(resolve => { completeRequest = resolve; }) },
      env: { HOME: root, PI_CODING_AGENT_DIR: agent }, readTrust: async () => ({ trusted: true }) });
    const pending = delayed.readIndex();
    while (!completeRequest) await Promise.resolve();
    cwd = path.join(root, 'other');
    completeRequest({ commands: [{ name: 'stale', source: 'extension', sourceInfo: { path: local } }] });
    const stale = await pending;
    check('in-flight RPC response from old workspace cannot claim a loaded extension', () => {
      assert.equal(stale.piReachable, false);
      assert.equal(stale.capabilityRegistry.commands.length, 0);
      assert.equal(stale.extensions.find(x => x.source.location === local).state.loaded, null);
    });
    console.log(`\n${passed}/${passed} 通过`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
