/* TEMP-only maintenance/diagnostics. No real Pi, model, network, or user data. */
const strict = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
let assertions = 0, checks = 0;
const assert = new Proxy(strict, { get(target, key) {
  const value = target[key];
  return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value;
} });
const input = extra => ({ sessionId: 'session', messageId: 'message', toolCallId: 'call',
  title: 'Fixture', html: '<p>fixture</p>', ...extra });
const snapshot = root => fs.readdirSync(root).sort().map(name => {
  const file = path.join(root, name), stat = fs.lstatSync(file);
  return [name, stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('hex')];
});
async function check(name, action) { await action(); checks++; console.log('  ok ' + name); }
(async () => {
  const { createHtmlArtifactStore } = await import('../server/html-artifact-store.js');
  const { createHtmlArtifactMaintenance } = await import('../server/html-artifact-maintenance.js');
  const { runHtmlArtifactMaintenanceCli } = await import('../server/html-artifact-maintenance-cli.js');
  const { scanHtmlArtifactReferences, createHtmlArtifactReconciler } = await import('../server/html-artifact-sessions.js');
  const { createSystemStorage } = await import('../server/system-storage.js');
  if (process.argv[2] === '--release-fault-cli') {
    const [dataDir, agentDir, action] = process.argv.slice(3), unlink = fs.unlinkSync;
    const lock = path.join(dataDir, 'html-artifacts', '.writer.lock');
    fs.unlinkSync = (file, ...args) => {
      if (file === lock) throw Object.assign(Error('PRIVATE ' + dataDir), { code: 'EACCES' });
      return unlink(file, ...args);
    };
    try {
      const result = await runHtmlArtifactMaintenanceCli(['--data-dir', dataDir, '--agent-dir', agentDir, '--action', action]);
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!result.ok) process.exitCode = 1;
    } finally { fs.unlinkSync = unlink; }
    return;
  }
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-maintenance-'));
  let serial = 0;
  async function fixture() {
    const dataDir = path.join(world, String(++serial)), agentDir = path.join(dataDir, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const root = path.join(dataDir, 'html-artifacts'), store = createHtmlArtifactStore({ dataDir });
    const ref = await store.publish(input());
    const roots = () => [path.join(agentDir, 'sessions')];
    const options = { store, roots, graceMs: 0 };
    return { dataDir, agentDir, root, store, ref, roots, options,
      run: options => runHtmlArtifactMaintenanceCli(['--data-dir', dataDir, '--agent-dir', agentDir, ...options]) };
  }
  function native(f, rows) {
    const dir = path.join(f.agentDir, 'sessions'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'fixture.jsonl');
    fs.writeFileSync(file, [JSON.stringify({ type: 'session', version: 3, id: 'native', cwd: f.dataDir }),
      ...rows.map(row => JSON.stringify(row))].join('\n') + '\n');
    return file;
  }
  async function response(options) {
    let body, status, headers = {};
    const res = { setHeader: (key, value) => { headers[key] = value; },
      writeHead: (code, value) => { status = code; Object.assign(headers, value); },
      end: value => { body = JSON.parse(value); } };
    await createSystemStorage({ dataDir: '/fixture-data', piAgentDir: '/fixture-agent', env: {},
      executionMode: 'source-web', ...options }).handle({ method: 'GET' }, res);
    return { status, body, headers };
  }
  try {
    await check('a claimed offline stop NEVER authorizes native snapshot deletion', async () => {
      const f = await fixture(), before = snapshot(f.root);
      const owner = createHtmlArtifactMaintenance({ ...f.options, offline: true });
      for (const confirmed of [false, true]) {
        assert.deepEqual(await owner.run({ action: 'collect', confirmNativeWritersStopped: confirmed }),
          { ok: false, code: 'native_mutation_unproven' });
        assert.deepEqual(snapshot(f.root), before);
      }
    });
    await check('default plan enumerates candidates but keeps pending, HTML and reference bytes', async () => {
      const f = await fixture(), before = snapshot(f.root);
      const result = await createHtmlArtifactMaintenance(f.options).run();
      assert.equal(result.ok, true); assert.equal(result.mode, 'candidates-only');
      assert.equal(result.nativeExclusionProven, false); assert.equal(result.removed, 0);
      assert.deepEqual(result.candidates, [f.ref.id]); assert.ok(result.reclaimableBytes > f.ref.bytes);
      assert.deepEqual(snapshot(f.root), before);
    });
    await check('physical inactive branches, deleted-session trash and copied forks all retain bytes', async () => {
      const f = await fixture();
      const details = { kind: 'html_artifact', schemaVersion: 1, ok: true, artifact: f.ref };
      // Native v3 message envelope, including a sibling leaf not on the restored branch.
      const row = { type: 'message', id: 'artifact-node', parentId: null,
        message: { role: 'toolResult', toolName: 'html_render', toolCallId: 'call', details } };
      const source = native(f, [row, { type: 'message', id: 'other-leaf', parentId: null,
        message: { role: 'user', content: [{ type: 'text', text: 'fixture' }] } }]);
      const trash = path.join(f.dataDir, 'trash-sessions'), fork = path.join(f.dataDir, 'forks');
      fs.mkdirSync(trash); fs.mkdirSync(fork);
      fs.copyFileSync(source, path.join(trash, 'deleted.jsonl')); fs.copyFileSync(source, path.join(fork, 'copy.jsonl'));
      const roots = () => [...f.roots(), trash, fork];
      const scan = scanHtmlArtifactReferences(roots());
      assert.equal(scan.complete, true); assert.equal(scan.files, 3);
      assert.ok(scan.referencedIds.has(f.ref.id)); assert.equal(scan.isCurrent(), true);
      const before = snapshot(f.root);
      const plan = await createHtmlArtifactMaintenance({ ...f.options, roots }).run();
      assert.equal(plan.ok, true); assert.deepEqual(plan.candidates, []);
      assert.equal(plan.retained, 1); assert.deepEqual(snapshot(f.root), before);
    });
    await check('unknown native references and truncated JSONL reject a complete plan', async () => {
      for (const damage of ['future', 'truncated']) {
        const f = await fixture();
        const file = native(f, [{ type: 'message', id: 'unknown', parentId: null,
          message: { role: 'toolResult', toolName: 'html_render', details: { kind: 'html_artifact', ok: true, artifact: { schemaVersion: 99 } } } }]);
        if (damage === 'truncated') fs.appendFileSync(file, '{');
        const before = snapshot(f.root), plan = await createHtmlArtifactMaintenance(f.options).run();
        assert.equal(plan.ok, false); assert.equal(plan.complete, false); assert.equal(plan.removed, 0);
        assert.deepEqual(snapshot(f.root), before);
      }
    });
    await check('scan inventory changes in the await gap keep pending and snapshots intact', async () => {
      const f = await fixture(), before = snapshot(f.root);
      const result = await createHtmlArtifactMaintenance({ ...f.options,
        scan: () => ({ complete: true, referencedIds: new Set(), isCurrent: () => false }) }).run();
      assert.equal(result.ok, false); assert.equal(result.complete, false);
      assert.deepEqual(snapshot(f.root), before);
    });
    await check('a referenced ID does not clear its pending marker during a dry-run plan', async () => {
      const f = await fixture(), before = snapshot(f.root);
      const plan = await createHtmlArtifactMaintenance({ ...f.options,
        scan: () => ({ complete: true, referencedIds: new Set([f.ref.id]), isCurrent: () => true }) }).run();
      assert.equal(plan.ok, true); assert.equal(plan.retained, 1);
      assert.deepEqual(plan.candidates, []); assert.deepEqual(snapshot(f.root), before);
    });
    await check('no production native exclusion means automatic reconciliation never invokes store GC', async () => {
      let calls = 0;
      const r = createHtmlArtifactReconciler({ store: { collect: () => { calls++; } }, roots: () => [] });
      assert.deepEqual(await r.reconcile(), { skipped: true, reason: 'native_mutation_unproven' });
      assert.equal(calls, 0); await r.dispose();
      assert.deepEqual(await r.reconcile(), { skipped: true, reason: 'disposed' });
    });
    await check('live admission is single-flight and releases only its own successful maintenance', async () => {
      const f = await fixture(); let release, releases = 0, prepared = 0;
      const waiting = new Promise(resolve => { release = resolve; });
      const owner = createHtmlArtifactMaintenance({ ...f.options, maintenance: {
        async prepare(scope) { assert.equal(scope, 'storage'); prepared++; await waiting; return { ok: true }; },
        async release(scope) { assert.equal(scope, 'storage'); releases++; return { ok: true }; },
      } });
      const pending = owner.run();
      assert.deepEqual(await owner.run(), { ok: false, code: 'html_artifact_storage_busy' });
      release(); assert.equal((await pending).ok, true); assert.equal(prepared, 1); assert.equal(releases, 1);
    });
    await check('busy or failed admission does not scan, repair, delete or release another owner', async () => {
      const f = await fixture(); let scans = 0, releases = 0;
      const before = snapshot(f.root), owner = createHtmlArtifactMaintenance({ ...f.options,
        scan: () => { scans++; }, maintenance: { prepare: () => ({ ok: false }), release: () => { releases++; } } });
      assert.deepEqual(await owner.run(), { ok: false, code: 'maintenance_busy' });
      assert.equal(scans, 0); assert.equal(releases, 0); assert.deepEqual(snapshot(f.root), before);
    });
    await check('explicit temporary cleanup removes only fixed uncommitted inventory, never native snapshots', async () => {
      const f = await fixture(), temp = path.join(f.root, '.tmp-' + randomUUID());
      fs.mkdirSync(temp); fs.writeFileSync(path.join(temp, 'document.html'), 'uncommitted');
      const owner = createHtmlArtifactMaintenance({ ...f.options, offline: true });
      assert.deepEqual(await owner.run({ action: 'cleanup-temporary' }), { ok: true, removed: 1, retained: 0 });
      assert.deepEqual((await f.store.read(f.ref.id)).artifact, f.ref);
      assert.deepEqual(fs.readdirSync(f.root), [f.ref.id]);
    });
    await check('unknown/torn lock refuses every writing action without deleting evidence', async () => {
      const f = await fixture(), lock = path.join(f.root, '.writer.lock');
      fs.writeFileSync(lock, '{torn-owner'); const before = snapshot(f.root);
      const owner = createHtmlArtifactMaintenance({ ...f.options, offline: true });
      for (const action of ['plan', 'recover-lock', 'cleanup-temporary', 'collect']) {
        const result = await owner.run({ action, confirmNativeWritersStopped: true });
        assert.equal(result.ok, false);
        assert.ok(['html_artifact_storage_busy', 'native_mutation_unproven'].includes(result.code));
        assert.deepEqual(snapshot(f.root), before);
      }
    });
    await check('stats count checked physical metadata + HTML + marker + temporary bytes', async () => {
      const f = await fixture(), temp = path.join(f.root, '.tmp-' + randomUUID());
      fs.mkdirSync(temp); fs.writeFileSync(path.join(temp, 'document.html'), '1234567');
      const before = snapshot(f.root), stats = await f.store.stats();
      const physical = fs.readdirSync(path.join(f.root, f.ref.id)).reduce((sum, name) =>
        sum + fs.lstatSync(path.join(f.root, f.ref.id, name)).size, 0);
      assert.equal(stats.count, 1); assert.equal(stats.bytes, physical + 7);
      assert.equal(stats.htmlBytes, f.ref.bytes); assert.equal(stats.pending, 1);
      assert.equal(stats.temporary, 1); assert.equal(stats.temporaryBytes, 7);
      assert.deepEqual(snapshot(f.root), before);
    });
    await check('stats API projects numeric fields only; errors stay unknown, not false zero', async () => {
      const f = await fixture(), stats = await f.store.stats();
      const res = await response({ artifactStats: () => ({ ...stats, html: 'PRIVATE', path: f.root,
        limits: { ...stats.limits, secret: 'PRIVATE' } }) });
      assert.equal(res.status, 200); assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.deepEqual(res.body.storage.htmlArtifacts, { status: 'known', ...stats });
      assert.equal(JSON.stringify(res.body).includes('PRIVATE'), false);
      for (const value of [() => { throw Error('PRIVATE ' + f.root); }, () => ({ count: 0 }),
        () => ({ ...stats, bytes: -1 }), () => ({ ...stats, pending: NaN })]) {
        const result = await response({ artifactStats: value });
        assert.equal(result.body.storage.htmlArtifacts.status, 'unknown');
        assert.equal('count' in result.body.storage.htmlArtifacts, false);
        assert.equal(JSON.stringify(result.body).includes('PRIVATE'), false);
      }
    });
    await check('CLI defaults to plan, never launches Pi or writes registry/session state', async () => {
      const f = await fixture(), before = snapshot(f.dataDir);
      const result = await f.run([]);
      assert.equal(result.ok, true); assert.equal(result.mode, 'candidates-only');
      assert.deepEqual(snapshot(f.dataDir), before);
      const real = spawnSync(process.execPath, [path.resolve(__dirname, '../server/html-artifact-maintenance-cli.js'),
        '--data-dir', f.dataDir, '--agent-dir', f.agentDir], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.equal(real.status, 0); assert.equal(JSON.parse(real.stdout).mode, 'candidates-only');
      assert.deepEqual(snapshot(f.dataDir), before);
    });
    await check('CLI offline claim cannot enable GC; malformed/missing inputs cannot create paths', async () => {
      const f = await fixture(), before = snapshot(f.dataDir);
      const result = await f.run(['--action', 'collect', '--confirm-offline-native-writers-stopped']);
      assert.deepEqual(result, { ok: false, code: 'native_mutation_unproven' });
      assert.deepEqual(snapshot(f.dataDir), before);
      for (const args of [[], ['--data-dir', 'relative', '--agent-dir', f.agentDir],
        ['--data-dir', f.dataDir, '--agent-dir'], ['--data-dir', f.dataDir, '--agent-dir', f.agentDir, '--force'],
        ['--data-dir', f.dataDir, '--agent-dir', f.agentDir, '--action', 'unknown']]) {
        assert.equal((await runHtmlArtifactMaintenanceCli(args)).ok, false);
      }
      assert.deepEqual(snapshot(f.dataDir), before);
    });
    await check('default inspection of an absent store does not create it or any metadata', async () => {
      const dataDir = path.join(world, 'absent'), agentDir = path.join(dataDir, 'agent');
      fs.mkdirSync(agentDir, { recursive: true }); const before = snapshot(dataDir);
      const result = await runHtmlArtifactMaintenanceCli(['--data-dir', dataDir, '--agent-dir', agentDir]);
      assert.equal(result.ok, true); assert.equal(result.mode, 'candidates-only');
      assert.deepEqual(result.candidates, []); assert.equal(result.reclaimableBytes, 0);
      assert.deepEqual(snapshot(dataDir), before);
    });
    await check('live maintenance cannot request lock recovery or temporary deletion', async () => {
      const f = await fixture(), before = snapshot(f.root);
      const owner = createHtmlArtifactMaintenance(f.options);
      for (const action of ['recover-lock', 'cleanup-temporary']) {
        assert.deepEqual(await owner.run({ action, confirmNativeWritersStopped: true }),
          { ok: false, code: 'offline_maintenance_required' });
      }
      assert.deepEqual(snapshot(f.root), before);
    });
    await check('release errors return a closed failure, not raw output or a false successful plan', async () => {
      const f = await fixture();
      for (const release of [() => { throw Error('PRIVATE ' + f.dataDir); }, () => ({ ok: false }), () => undefined]) {
        const owner = createHtmlArtifactMaintenance({ ...f.options,
          maintenance: { prepare: () => ({ ok: true }), release } });
        assert.deepEqual(await owner.run(), { ok: false, code: 'maintenance_release_unconfirmed' });
        assert.deepEqual(await owner.run(), { ok: false, code: 'maintenance_release_unconfirmed' });
      }
    });
    await check('manual non-destructive escape uses a NEW data root and preserves an unknown locked store', async () => {
      const f = await fixture(); fs.writeFileSync(path.join(f.root, '.writer.lock'), '{unknown');
      const evidence = snapshot(f.dataDir);
      assert.equal((await f.run(['--action', 'recover-lock'])).ok, false);
      const replacement = path.join(world, 'manual-new-root'); fs.mkdirSync(replacement);
      const fresh = createHtmlArtifactStore({ dataDir: replacement });
      const reference = await fresh.publish(input());
      assert.equal((await fresh.read(reference.id)).html, input().html);
      assert.deepEqual(snapshot(f.dataDir), evidence);
      assert.equal(fs.readFileSync(path.join(f.root, '.writer.lock'), 'utf8'), '{unknown');
    });
    await check('CLI preserves damaged registry instead of scanning an incomplete set of roots', async () => {
      const f = await fixture();
      // Same canonical path used by createRuntimeRegistry; no second manifest schema.
      fs.writeFileSync(path.join(f.dataDir, 'conversations.json'), '{');
      const before = snapshot(f.dataDir), result = await f.run([]);
      assert.equal(result.ok, false); assert.deepEqual(snapshot(f.dataDir), before);
    });
    for (const action of ['recover-lock', 'stats', 'plan', 'cleanup-temporary']) await check('maintenance preserves release failure and allows an exact-instance retry: ' + action, async () => {
      const f = await fixture(), io = Object.create(fs), lock = path.join(f.root, '.writer.lock');
      let failures = 1, attempts = 0;
      io.unlinkSync = (file, ...args) => {
        if (file === lock) {
          attempts++;
          if (failures-- > 0) throw Object.assign(Error('PRIVATE ' + f.dataDir), { code: 'EACCES' });
        }
        return fs.unlinkSync(file, ...args);
      };
      const store = createHtmlArtifactStore({ dataDir: f.dataDir, io }), before = snapshot(f.root);
      const owner = createHtmlArtifactMaintenance({ ...f.options, store, offline: true });
      assert.deepEqual(await owner.run({ action }), { ok: false, code: 'html_artifact_storage_release_failed' });
      assert.equal(attempts, 1); assert.equal(fs.existsSync(lock), true);
      assert.equal((await owner.run({ action })).ok, true);
      assert.deepEqual(snapshot(f.root), before);
      assert.equal((await store.read(f.ref.id)).html, input().html);
    });
    for (const action of ['recover-lock', 'stats', 'plan', 'cleanup-temporary']) await check('real CLI failure exits nonzero, keeps snapshots and permits proven-dead recovery: ' + action, async () => {
      const f = await fixture(), before = snapshot(f.root), lock = path.join(f.root, '.writer.lock');
      const result = spawnSync(process.execPath, [__filename, '--release-fault-cli', f.dataDir, f.agentDir, action],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.equal(result.status, 1); assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'html_artifact_storage_release_failed' });
      assert.equal(fs.existsSync(lock), true);
      assert.deepEqual(snapshot(path.join(f.root, f.ref.id)), before.find(([name]) => name === f.ref.id)[1]);
      const recovered = spawnSync(process.execPath, [path.resolve(__dirname, '../server/html-artifact-maintenance-cli.js'),
        '--data-dir', f.dataDir, '--agent-dir', f.agentDir, '--action', 'recover-lock'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.equal(recovered.status, 0);
      assert.deepEqual(JSON.parse(recovered.stdout), { ok: true, exists: true });
      assert.deepEqual(snapshot(f.root), before);
      assert.equal((await f.store.read(f.ref.id)).html, input().html);
    });
    await check('storage stats API reports unknown on release failure, then the same Store can return known', async () => {
      const f = await fixture(), io = Object.create(fs); let failures = 1;
      io.unlinkSync = (file, ...args) => {
        if (file === path.join(f.root, '.writer.lock') && failures-- > 0) {
          throw Object.assign(Error('PRIVATE ' + f.dataDir), { code: 'EACCES' });
        }
        return fs.unlinkSync(file, ...args);
      };
      const store = createHtmlArtifactStore({ dataDir: f.dataDir, io });
      const failed = await response({ artifactStats: () => store.stats() });
      assert.deepEqual(failed.body.storage.htmlArtifacts, { status: 'unknown', code: 'html_store_unavailable' });
      assert.equal(JSON.stringify(failed.body).includes('PRIVATE'), false);
      assert.equal(fs.existsSync(path.join(f.root, '.writer.lock')), true);
      const retried = await response({ artifactStats: () => store.stats() });
      assert.equal(retried.body.storage.htmlArtifacts.status, 'known');
      assert.equal(retried.body.storage.htmlArtifacts.count, 1);
      assert.equal(fs.existsSync(path.join(f.root, '.writer.lock')), false);
    });
    await check('startup recovery reports only fixed failure codes instead of an empty catch', async () => {
      const vm = require('node:vm'), source = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
      // Execute the actual narrow startup expression, without launching the
      // server, Pi, user configuration or any other startup side effects.
      const expression = source.match(/void htmlArtifactStore\.recoverLock\(\)\.catch\([\s\S]*?\n\}\);/);
      assert.ok(expression);
      for (const code of ['html_artifact_storage_release_failed', 'html_artifact_storage_busy', 'PRIVATE /fixture/path']) {
        const warnings = [], error = Object.assign(Error('PRIVATE /fixture/path <p>payload</p>'), { code });
        vm.runInNewContext(expression[0], { htmlArtifactStore: { recoverLock: () => Promise.reject(error) },
          console: { warn: (...values) => warnings.push(values) } });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(warnings, [[code.startsWith('html_artifact_storage_') ? code : 'html_artifact_storage_failed']]);
      }
    });
    console.log(`HTML artifact maintenance: ${checks}/${checks} scenarios; assertions=${assertions}; skipped=0`);
  } finally { fs.rmSync(world, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
