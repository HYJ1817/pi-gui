'use strict';
// Explicit, local-installed-Pi contract. Not canonical; never a model/UI/security
// qualification. No user config/auth reads, SDK imports, Pi patches or downloads.
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const h = require('./fixtures/visual-replies-support.cjs');
async function run(piBin) {
  if (!piBin || !path.isAbsolute(piBin) || !fs.statSync(piBin).isFile()) throw Error('explicit_absolute_pi_bin_required');
  const world = h.createWorld(), started = Date.now();
  const report = { schemaVersion: 1, qualification: 'real-pi-no-model-tool-contract', completed: false,
    visualRepliesAcceptance: false, modelCalls: 0, syntheticAssistantSetup: true, checks: [], failed: 0,
    unverified: ['real-model-tool-selection', 'real-model-turn', 'Electron', 'security-matrix', 'final-packaged-app'] };
  console.log('Visual Replies contract fixture: ' + world);
  const file = path.join(world, 'evidence/real-pi-contract.json');
  const save = () => h.saveJson(file, report);
  const check = (id, pass) => { report.checks.push({ id, pass: Boolean(pass) }); save(); if (!pass) throw Error(id); };
  let child, bridge, exited, exit, input, timer, nativeReads = 0;
  const pending = new Map();
  const rpc = (type, body = {}) => {
    const id = require('node:crypto').randomUUID();
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { pending.delete(id); reject(Error('rpc_timeout')); }, 15000);
      pending.set(id, value => { clearTimeout(deadline); value.success ? resolve(value.data) : reject(Error('rpc_rejected')); });
      child.stdin.write(JSON.stringify({ id, type, ...body }) + '\n');
    });
  };
  const until = async fn => { const end = Date.now() + 40000; while (!await fn()) { if (exit || Date.now() > end) throw Error('contract_timeout'); await h.sleep(50); } };
  try {
    const env = h.childEnvironment(world);
    const { createPiLaunch } = await import('../server/pi-launch.js');
    const launch = createPiLaunch({ piBin, env, getCwd: () => path.join(world, 'project-a') });
    const entry = launch.cliEntry(), pkg = launch.packageDir();
    check('installed-launch-entry-proven', entry?.ok && entry.kind === 'node' && pkg);
    const sources = ['package.json', 'dist/core/extensions/types.d.ts', 'dist/core/session-manager.d.ts',
      'dist/modes/rpc/rpc-types.d.ts', 'dist/modes/rpc/rpc-mode.js', 'dist/core/agent-session.js'];
    report.identity = { head: h.git(h.ROOT, 'rev-parse', 'HEAD'), dirty: Boolean(h.git(h.ROOT, 'status', '--porcelain')),
      node: process.version, platform: process.platform, arch: process.arch,
      piVersion: JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version,
      piEntrySha256: h.digest(entry.entryPath), sourceDigests: Object.fromEntries(sources.map(name => [name, h.digest(path.join(pkg, name))])),
      adapterSha256: h.digest(path.join(__dirname, 'fixtures/visual-replies-contract-extension.mjs')) };
    const types = fs.readFileSync(path.join(pkg, sources[1]), 'utf8');
    const manager = fs.readFileSync(path.join(pkg, sources[2]), 'utf8');
    check('public-extension-contract-present', ['registerTool<', 'registerCommand(', 'getAllTools()', 'withSession?', 'setup?'].every(x => types.includes(x))
      && manager.includes('appendMessage('));
    const { createHtmlArtifactStore } = await import('../server/html-artifact-store.js');
    const { createHtmlRenderBridge } = await import('../server/html-render-bridge.js');
    const store = createHtmlArtifactStore({ dataDir: path.join(world, 'data') });
    bridge = createHtmlRenderBridge({ store, launch, getCwd: () => path.join(world, 'project-a'),
      readState: () => rpc('get_state'), readEntries: () => { nativeReads++; return rpc('get_entries'); },
      capture: sessionId => ({ sessionId }), isCurrent: () => Boolean(child && !exit),
      scopeForWitness: w => ({ kind: 'classic', sessionId: w.sessionId, bridgeInstance: 'contract', workspaceKey: 'temp', bridgeRun: 1, workspaceGeneration: 1 }) });
    const prepared = await bridge.prepare(); check('bundled-source-probe', prepared);
    const row = require('./fixtures/visual-replies-normal-samples.cjs').normalSample('filter-panel');
    input = { title: row.title, html: row.html, height: row.height };
    fs.writeFileSync(path.join(world, 'contract-input.json'), JSON.stringify(input), { flag: 'wx' });
    const adapter = path.join(world, 'contract-extension.mjs');
    fs.copyFileSync(path.join(__dirname, 'fixtures/visual-replies-contract-extension.mjs'), adapter, fs.constants.COPYFILE_EXCL);
    Object.assign(env, prepared.env, { VISUAL_REPLIES_BUNDLED_EXTENSION: prepared.args[1] });
    const args = [entry.entryPath, '--mode', 'rpc', '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
      '--session-dir', path.join(world, 'sessions'), '--extension', adapter];
    report.invocation = { mode: 'rpc', offline: true, explicitExtension: true, prompts: ['/vr-contract-setup', '/vr-contract', '/vr-contract-quit'], modelPrompts: 0 };
    save();
    child = spawn(process.execPath, args, { cwd: path.join(world, 'project-a'), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    report.stderrBytes = 0; report.eventTypes = {};
    exited = new Promise(resolve => { child.once('exit', (code, signal) => { exit = { code, signal }; resolve(); }); child.once('error', () => { exit = { code: null, signal: 'spawn-error' }; resolve(); }); });
    child.stderr.on('data', chunk => { report.stderrBytes += chunk.length; });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.type === 'response') { const done = pending.get(value.id); if (done) { pending.delete(value.id); done(value); } }
        else if (['agent_start', 'message_start', 'message_update', 'tool_execution_start', 'extension_error'].includes(value.type))
          report.eventTypes[value.type] = (report.eventTypes[value.type] || 0) + 1;
      } catch { report.nonJsonLines = (report.nonJsonLines || 0) + 1; }
    });
    const commands = await rpc('get_commands');
    check('real-rpc-extension-command-discovered', commands?.commands?.some(x => x.name === 'vr-contract'));
    const initial = await rpc('get_state'); check('real-rpc-idle-state', initial?.sessionId && initial.isStreaming === false);
    await rpc('prompt', { message: '/vr-contract-setup' });
    await until(async () => (await rpc('get_state'))?.sessionId !== initial.sessionId);
    await until(async () => (await rpc('get_entries'))?.entries?.some(x => x.message?.content?.some?.(p => p.id === 'vr-contract-call')));
    await rpc('prompt', { message: '/vr-contract' });
    await until(() => fs.existsSync(path.join(world, 'contract-result.json')));
    const result = JSON.parse(fs.readFileSync(path.join(world, 'contract-result.json'), 'utf8'));
    check('real-pi-tool-discovered', result.discovered);
    check('real-pi-preview-tool-discovered', result.previewDiscovered);
    check('bundled-handler-real-context-success', result.ok && result.details?.ok && result.details?.artifact);
    const artifact = result.details.artifact, stored = await store.read(artifact.id), state = await rpc('get_state'), entries = await rpc('get_entries');
    check('private-bridge-verified-native-rpc', nativeReads >= 2 && state.sessionId === artifact.sessionId && artifact.sessionId === result.nativeSessionId);
    check('actual-native-tree-tool-call', entries.entries.some(x => x.type === 'message' && x.id === artifact.messageId
      && x.message?.content?.some?.(part => part.type === 'toolCall' && part.id === artifact.toolCallId && part.name === 'html_render')));
    check('immutable-store-exact-benign-bytes', stored.html === input.html && artifact.digest === h.hashText(input.html));
    check('session-file-under-temp', h.inside(world, state.sessionFile) && fs.existsSync(state.sessionFile));
    report.artifact = artifact; report.nativeReads = nativeReads;
    check('zero-model-events', !Object.keys(report.eventTypes).length);
    void rpc('prompt', { message: '/vr-contract-quit' }).catch(() => {});
    await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('quit_timeout')), 12000); })]);
    check('real-pi-graceful-exit', exit.code === 0 && exit.signal === null);
    report.completed = true;
  } catch (error) { report.failed++; report.failure = { code: /^[a-z][a-z0-9-]+$/.test(error.message) ? error.message : 'contract_failed', name: error.name }; }
  finally {
    clearTimeout(timer);
    if (child && !exit) { child.stdin.end(); await Promise.race([exited, h.sleep(3000)]); if (!exit) { child.kill(); await exited; report.forcedCleanup = true; report.completed = false; } }
    for (const done of pending.values()) done({ success: false });
    await bridge?.dispose();
    report.exit = exit || null; report.passed = report.checks.filter(x => x.pass).length;
    report.failed = Math.max(report.failed, report.checks.filter(x => !x.pass).length);
    report.elapsedMs = Date.now() - started;
    report.privacy = { credentialsRead: false, credentialsCopied: false, userConfigRead: false, modelCalled: false,
      rawRpcSaved: false, writableRoots: 'new-os.tmpdir-fixture-only', installedPiModified: false };
    save();
  }
  console.log(`Real Pi benign contract: ${report.passed}/${report.passed + report.failed}; failed=${report.failed}; evidence=${file}`);
  return report.completed ? 0 : 1;
}
module.exports = { run };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--pi-bin') { console.error('usage: node tests/visual-replies-real-pi-contract.cjs --pi-bin <absolute installed Pi entry>'); process.exitCode = 2; }
  else run(args[1]).then(code => { process.exitCode = code; }).catch(() => { console.error('contract: explicit valid Pi path required'); process.exitCode = 2; });
}
