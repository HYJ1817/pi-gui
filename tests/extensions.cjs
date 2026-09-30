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
    // Parity cases follow Pi 0.87.0 package-manager/loader path semantics.
    const parityAgent = path.join(root, 'parity/agent');
    const parityProject = path.join(root, 'parity/project');
    put('parity/agent/extensions/manifest/package.json', JSON.stringify({ pi: { extensions: ['src/tool.ts'] } }));
    const autoTool = put('parity/agent/extensions/manifest/src/tool.ts', 'throw new Error("NEVER_EXECUTE")');
    const experimental = put('parity/agent/extensions/experimental/index.ts', 'throw new Error("NEVER_EXECUTE")');
    const localDir = path.join(root, 'parity/local');
    put('parity/local/package.json', JSON.stringify({ pi: { extensions: ['src/a.ts', 'src/b.js'] } }));
    const localA = put('parity/local/src/a.ts', 'throw new Error("NEVER_EXECUTE")');
    const localB = put('parity/local/src/b.js', 'throw new Error("NEVER_EXECUTE")');
    const looseDir = path.join(root, 'parity/loose');
    const looseA = put('parity/loose/a.ts', '');
    const looseB = put('parity/loose/sub/index.js', '');
    const pkg = path.join(root, 'parity/package');
    put('parity/package/package.json', JSON.stringify({ name: 'parity-package', pi: { extensions: ['extensions/*.ts', 'src/**/*.ts', '!extensions/manifest-disabled.ts'] } }));
    const pkgMain = put('parity/package/extensions/main.ts', 'throw new Error("NEVER_EXECUTE")');
    const pkgLegacy = put('parity/package/extensions/legacy.ts', '');
    const pkgDisabled = put('parity/package/extensions/manifest-disabled.ts', '');
    const pkgNested = put('parity/package/src/nested/tool.ts', '');
    put('parity/package/src/.hidden/tool.ts', '');
    const outside = put('parity/outside.ts', '');
    const undeclared = put('parity/package/private.ts', '');
    const parityRegistry = createExtensionRegistry({ runtime: { getCurrentCwd: () => parityProject }, rpc: null,
      env: { HOME: root, PI_CODING_AGENT_DIR: parityAgent }, readTrust: async () => ({ trusted: true }) });
    const configure = async (settings) => {
      put('parity/agent/settings.json', JSON.stringify({ credential: 'SECRET123', ...settings }));
      return parityRegistry.readIndex();
    };
    const byFile = (report, file) => report.extensions.find(x => x.source.location === file);
    let parity = await configure({ extensions: [localDir, looseDir] });
    check('A auto directory manifest discovers entry without index', () => assert.ok(byFile(parity, autoTool)));
    check('B settings directory resolves all manifest entries', () => assert.ok(byFile(parity, localA) && byFile(parity, localB)));
    check('B settings directory without entry points uses one-level collection', () => assert.ok(byFile(parity, looseA) && byFile(parity, looseB)));
    parity = await configure({ extensions: ['!extensions/experimental/*'] });
    check('C auto discovery respects exclusion glob', () => assert.equal(byFile(parity, experimental).state.enabled, false));
    parity = await configure({ extensions: ['!extensions/experimental/*', '+extensions/experimental/index.ts'] });
    check('D exact force include overrides exclusion', () => assert.equal(byFile(parity, experimental).state.enabled, true));
    parity = await configure({ extensions: ['-extensions/experimental/index.ts', '+extensions/experimental/index.ts', path.dirname(experimental)] });
    check('E force exclude beats force include and plain directory include regardless of order', () => assert.equal(byFile(parity, experimental).state.enabled, false));
    parity = await configure({ packages: [{ source: pkg, extensions: ['extensions/*.ts', '!extensions/legacy.ts', '+src/nested/tool.ts', '-extensions/main.ts'] }] });
    check('F package filter handles include exclude and exact overrides', () => {
      assert.equal(byFile(parity, pkgMain).state.enabled, false);
      assert.equal(byFile(parity, pkgLegacy).state.enabled, false);
      assert.equal(byFile(parity, pkgNested).state.enabled, true);
    });
    check('F package filter cannot revive manifest-excluded resources', () => assert.ok(!byFile(parity, pkgDisabled)));
    parity = await configure({ packages: [{ source: pkg }] });
    check('F omitted package object filter keeps default manifest resource set', () => assert.ok(byFile(parity, pkgMain) && byFile(parity, pkgLegacy) && byFile(parity, pkgNested) && !byFile(parity, pkgDisabled)));
    parity = await configure({ packages: [{ source: pkg, extensions: ['extensions/*.ts', 42] }] });
    check('malformed filter cannot claim enabled=true', () => assert.ok(parity.extensions.filter(x => x.name === 'parity-package').every(x => x.state.enabled === null)));
    parity = await configure({ packages: [{ source: pkg, extensions: [] }] });
    check('G empty package filter explicitly disables all declared extensions', () => assert.ok(parity.extensions.filter(x => x.name === 'parity-package').length === 3 && parity.extensions.filter(x => x.name === 'parity-package').every(x => x.state.enabled === false)));
    parity = await configure({ packages: [pkg] });
    check('H package manifest expands flat and nested glob without hidden paths', () => { assert.ok(byFile(parity, pkgMain) && byFile(parity, pkgLegacy) && byFile(parity, pkgNested)); assert.ok(parity.extensions.every(x => !x.source.location.includes('.hidden'))); });
    parity = await configure({ packages: [{ source: pkg, extensions: ['+../outside.ts', '+private.ts'] }] });
    check('I filter cannot introduce undeclared or outside-root files', () => assert.ok(!byFile(parity, outside) && !byFile(parity, undeclared)));
    put('parity/package/package.json', JSON.stringify({ pi: { extensions: ['../outside.ts', '../*.ts', 'extensions/*.ts'] } }));
    parity = await configure({ packages: [pkg] });
    check('I literal and glob manifest traversal are rejected', () => { assert.ok(!byFile(parity, outside)); assert.ok(parity.diagnostics.some(x => x.code === 'outside-root')); });
    put('parity/agent/extensions/bad/package.json', '{bad');
    const badIndex = put('parity/agent/extensions/bad/index.ts', '');
    parity = await configure({});
    check('J malformed directory metadata falls back to index and isolates discovery error', () => assert.ok(byFile(parity, badIndex)?.state.error && byFile(parity, autoTool)));
    check('K disk discovery never invents loaded runtime evidence', () => assert.ok(parity.extensions.every(x => x.state.loaded === null)));
    check('M settings secrets and extension source never reach renderer report', () => assert.ok(!JSON.stringify(parity).includes('SECRET123') && !JSON.stringify(parity).includes('NEVER_EXECUTE')));
    const { applyExtensionPatterns, resolveExtensionPaths, resolvePackageExtensionPaths, containedExtensionPath } = await import('../lib/extension-paths.js');
    check('helper patterns match relative path basename and absolute path', () => {
      for (const pattern of ['extensions/*.ts', 'main.ts', pkgMain]) assert.equal(applyExtensionPatterns([pkgMain], [pattern], pkg).get(pkgMain), true);
    });
    check('helper exact overrides do not match basename or glob', () => {
      assert.equal(applyExtensionPatterns([pkgMain], ['!**/*.ts', '+main.ts', '+extensions/*.ts'], pkg).get(pkgMain), false);
      assert.equal(applyExtensionPatterns([pkgMain], ['!**/*.ts', '+./extensions/main.ts'], pkg).get(pkgMain), true);
    });
    check('helper invalid pattern list keeps eligibility unknown', () => assert.equal(applyExtensionPatterns([pkgMain], [42], pkg).get(pkgMain), null));
    const priorityRoot = path.join(root, 'parity/priority');
    const priorityIndex = put('parity/priority/index.ts', '');
    put('parity/priority/index.js', '');
    put('parity/priority/sibling.ts', '');
    check('directory root index.ts takes precedence over index.js and sibling discovery', () => assert.deepEqual(resolveExtensionPaths(priorityRoot).map(x => x.file), [priorityIndex]));
    put('parity/priority/package.json', JSON.stringify({ pi: { extensions: ['sibling.ts'] } }));
    check('directory root manifest takes precedence over index', () => assert.deepEqual(resolveExtensionPaths(priorityRoot).map(x => x.file), [path.join(priorityRoot, 'sibling.ts')]));
    put('parity/priority/package.json', JSON.stringify({ pi: { extensions: ['*.ts'] } }));
    check('ordinary directory manifest treats glob literally and falls back to index', () => assert.deepEqual(resolveExtensionPaths(priorityRoot).map(x => x.file), [priorityIndex]));
    put('parity/no-recursion/child/deep/tool.ts', '');
    check('directory conventional discovery does not recurse beyond child entry points', () => assert.deepEqual(resolveExtensionPaths(path.join(root, 'parity/no-recursion')), []));
    const conventional = path.join(root, 'parity/conventional');
    const conventionalFile = put('parity/conventional/extensions/tool.ts', '');
    check('package without pi manifest uses conventional discovery', () => assert.deepEqual(resolvePackageExtensionPaths(conventional, {}).map(x => x.file), [conventionalFile]));
    check('empty manifest differs from object resource-filter fallback exactly as Pi 0.87', () => {
      assert.deepEqual(resolvePackageExtensionPaths(conventional, { pi: { extensions: [] } }), []);
      assert.deepEqual(resolvePackageExtensionPaths(conventional, { pi: { extensions: [] } }, { objectForm: true }), []);
      assert.deepEqual(resolvePackageExtensionPaths(conventional, { pi: { extensions: [] } }, { objectForm: true, filtered: true }).map(x => x.file), [conventionalFile]);
    });
    put('parity/ignore/.gitignore', '*.ts\n');
    put('parity/ignore/tool.ts', '');
    const ignoreDiagnostics = [];
    check('unimplemented ignore-file rules carry unknown evidence and diagnostic', () => {
      assert.ok(resolveExtensionPaths(path.join(root, 'parity/ignore'), { diagnostics: ignoreDiagnostics }).every(x => x.uncertain));
      assert.ok(ignoreDiagnostics.some(x => x.code === 'ignore-unresolved'));
    });
    const symlink = path.join(root, 'parity/package/link');
    let linkCreated = false;
    try { fs.symlinkSync(path.join(root, 'parity/local'), symlink, process.platform === 'win32' ? 'junction' : 'dir'); linkCreated = true; }
    catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; console.log('  skip symlink fixture: unavailable'); }
    if (linkCreated) check('symlink escape and symlink-root metadata cannot be discovered', () => {
      assert.equal(containedExtensionPath(pkg, 'link/src/a.ts'), null);
      assert.deepEqual(resolveExtensionPaths(symlink), []);
      assert.deepEqual(resolvePackageExtensionPaths(pkg, { pi: { extensions: ['link/src/*.ts', 'link/src/a.ts'] } }), []);
    });
    put('parity/agent/settings.json', JSON.stringify({ extensions: ['-extensions/experimental/index.ts'] }));
    const runtimeRegistry = createExtensionRegistry({ runtime: { getCurrentCwd: () => parityProject },
      rpc: { request: async () => ({ commands: [{ name: 'experimental-command', source: 'extension', sourceInfo: { path: experimental } }] }) },
      env: { HOME: root, PI_CODING_AGENT_DIR: parityAgent }, readTrust: async () => ({ trusted: true }) });
    const stillLoaded = await runtimeRegistry.readIndex();
    check('disabled configuration and current RPC load evidence remain independent until restart', () => {
      assert.equal(byFile(stillLoaded, experimental).state.enabled, false);
      assert.equal(byFile(stillLoaded, experimental).state.loaded, true);
      assert.equal(stillLoaded.capabilityRegistry.commands[0].extensionId, byFile(stillLoaded, experimental).id);
    });
    console.log(`\n${passed}/${passed} 通过`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
