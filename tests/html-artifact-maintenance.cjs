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
      const { capacity, maintenance, ...reported } = res.body.storage.htmlArtifacts;
      assert.deepEqual(reported, { status: 'known', ...stats });
      assert.equal(capacity.code, 'within_reported_limits'); assert.equal(maintenance.snapshotDeletion, false);
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
      const { maintenance, ...unknown } = failed.body.storage.htmlArtifacts;
      assert.deepEqual(unknown, { status: 'unknown', code: 'html_store_unavailable' });
      assert.equal(maintenance.snapshotDeletion, false);
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
    await check('capacity statistics expose session high-water numbers without native session identities', async () => {
      const f = await fixture();
      await f.store.publish(input({ messageId: 'second' }));
      await f.store.publish(input({ sessionId: 'other-private-session', html: '<p>' + 'x'.repeat(2048) + '</p>' }));
      const stats = await f.store.stats(), usage = new Map();
      for (const name of fs.readdirSync(f.root)) {
        const dir = path.join(f.root, name), ref = JSON.parse(fs.readFileSync(path.join(dir, 'reference.json')));
        const previous = usage.get(ref.sessionId) || { count: 0, bytes: 0 };
        previous.count++;
        previous.bytes += fs.readdirSync(dir).reduce((sum, file) => sum + fs.statSync(path.join(dir, file)).size, 0);
        usage.set(ref.sessionId, previous);
      }
      assert.equal(stats.sessionMaxCount, 2);
      assert.equal(stats.sessionMaxBytes, Math.max(...[...usage.values()].map(value => value.bytes)));
      assert.equal(JSON.stringify(stats).includes('other-private-session'), false);
      assert.equal(JSON.stringify(stats).includes(f.ref.id), false);
      const emptyDir = path.join(world, 'empty-capacity'); fs.mkdirSync(emptyDir);
      const empty = await createHtmlArtifactStore({ dataDir: emptyDir }).stats();
      assert.equal(empty.sessionMaxBytes, 0); assert.equal(empty.sessionMaxCount, 0);
      assert.deepEqual(fs.readdirSync(emptyDir), []);
    });
    await check('production stats and CLI truthfully advertise disabled snapshot GC and existing explicit maintenance', async () => {
      const f = await fixture(), before = snapshot(f.root);
      const result = await f.run(['--action', 'stats']);
      assert.equal(result.ok, true);
      const policy = result.maintenance;
      assert.equal(policy.mode, 'candidates-only');
      assert.equal(policy.automaticCollection, false); assert.equal(policy.snapshotDeletion, false);
      assert.equal(policy.code, 'native_mutation_unproven');
      assert.deepEqual(policy.inspectionActions, ['stats', 'plan']);
      assert.deepEqual(policy.offlineActions, ['recover-lock', 'cleanup-temporary']);
      assert.equal(policy.sourceEntry, 'server/html-artifact-maintenance-cli.js');
      assert.match(policy.message, /正式快照.*未开放/);
      assert.match(policy.recovery, /保留.*新.*数据/);
      assert.deepEqual((await f.run([])).maintenance, policy);
      for (const artifactStats of [() => result.storage, () => { throw Error('PRIVATE'); }]) {
        const res = await response({ artifactStats });
        assert.deepEqual(res.body.storage.htmlArtifacts.maintenance, policy);
        if (res.body.storage.htmlArtifacts.status === 'known') assert.deepEqual(res.body.storage.htmlArtifacts.capacity, result.capacity);
      }
      assert.deepEqual(snapshot(f.root), before);
      assert.deepEqual(await f.run(['--action', 'collect']), { ok: false, code: 'native_mutation_unproven' });
    });
    await check('capacity feedback distinguishes global, per-session and temporary blocks without evicting snapshots', async () => {
      const f = await fixture(), physical = (await f.store.stats()).bytes, before = snapshot(f.root);
      for (const key of ['totalBytes', 'totalCount', 'sessionBytes', 'sessionCount']) {
        const store = createHtmlArtifactStore({ dataDir: f.dataDir, limits: { [key]: key.endsWith('Count') ? 1 : physical } });
        const res = await response({ artifactStats: () => store.stats() }), capacity = res.body.storage.htmlArtifacts.capacity;
        assert.equal(capacity.code, 'html_artifact_quota');
        assert.equal(capacity.globalLimitReached, key.startsWith('total'));
        assert.equal(capacity.sessionLimitReached, key.startsWith('session'));
        assert.equal(capacity.publicationBlockedByTemporary, false);
        assert.match(capacity.message, /不会自动.*快照/);
        await assert.rejects(store.publish(input({ messageId: 'over-quota' })), error => error.code === 'html_artifact_quota');
        assert.deepEqual(snapshot(f.root), before);
      }
      const store = createHtmlArtifactStore({ dataDir: f.dataDir, limits: { sessionCount: 1 } });
      const other = await store.publish(input({ sessionId: 'other' }));
      assert.equal((await store.read(other.id)).html, input().html);
      const temp = path.join(f.root, '.tmp-' + randomUUID()); fs.mkdirSync(temp);
      fs.writeFileSync(path.join(temp, 'document.html'), 'uncommitted');
      const blocked = (await response({ artifactStats: () => store.stats() })).body.storage.htmlArtifacts.capacity;
      assert.equal(blocked.code, 'temporary_cleanup_required'); assert.equal(blocked.publicationBlockedByTemporary, true);
      assert.match(blocked.message, /cleanup-temporary/);
      const owner = createHtmlArtifactMaintenance({ ...f.options, store, offline: true });
      assert.deepEqual(await owner.run({ action: 'cleanup-temporary' }), { ok: true, removed: 1, retained: 0 });
      assert.equal((await store.read(f.ref.id)).html, input().html);
      assert.equal((await store.read(other.id)).html, input().html);
    });
    await check('capacity projection never claims publication admission or trusts supplied policy and private fields', async () => {
      const f = await fixture(), stats = await f.store.stats();
      const res = await response({ artifactStats: () => ({ ...stats, sessionIds: ['PRIVATE'],
        capacity: { message: 'PRIVATE', canPublish: true }, maintenance: { snapshotDeletion: true, message: 'PRIVATE' } }) });
      const info = res.body.storage.htmlArtifacts;
      assert.equal(info.capacity.code, 'within_reported_limits');
      assert.equal(info.capacity.remainingBytes, stats.limits.totalBytes - stats.bytes);
      assert.equal(info.capacity.remainingCount, stats.limits.totalCount - stats.count);
      assert.match(info.capacity.message, /不保证.*发布/);
      assert.equal('canPublish' in info.capacity, false);
      assert.equal(info.maintenance.snapshotDeletion, false);
      assert.equal(JSON.stringify(info).includes('PRIVATE'), false);
      const { limits, sessionMaxBytes, sessionMaxCount, ...legacy } = stats;
      const unknown = (await response({ artifactStats: () => legacy })).body.storage.htmlArtifacts;
      assert.equal('capacity' in unknown, false);
      const partial = (await response({ artifactStats: () => ({ ...legacy, limits }) })).body.storage.htmlArtifacts;
      assert.equal(partial.capacity.sessionLimitReached, null);
      const over = (await response({ artifactStats: () => ({ ...stats, count: stats.limits.totalCount + 1,
        bytes: stats.limits.totalBytes + 1 }) })).body.storage.htmlArtifacts;
      assert.equal(over.capacity.remainingBytes, 0); assert.equal(over.capacity.remainingCount, 0);
      assert.equal(over.capacity.globalLimitReached, true);
    });
    await check('existing authenticated storage GET reports policy but cannot invoke maintenance or accept paths', async () => {
      const { createRouter } = await import('../server/router.js');
      const { createAuth } = await import('../server/auth.js');
      const http = require('node:http'), f = await fixture(), before = snapshot(f.dataDir), token = randomUUID();
      let router, calls = 0;
      const server = http.createServer((req, res) => router(req, res));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port, origin = `http://127.0.0.1:${port}`, headers = { 'x-pi-gui-token': token };
      router = createRouter({ auth: createAuth({ token, port }), systemStorage: createSystemStorage({
        dataDir: f.dataDir, piAgentDir: f.agentDir, env: {}, executionMode: 'source-web',
        artifactStats: () => { calls++; return f.store.stats(); },
      }) });
      try {
        assert.equal((await fetch(origin + '/api/system/storage')).status, 401);
        assert.equal((await fetch(origin + '/api/system/storage', { headers: { ...headers, origin: 'https://untrusted.invalid' } })).status, 403);
        assert.equal(calls, 0);
        const response = await fetch(origin + '/api/system/storage?action=collect&path=PRIVATE', { headers });
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        const info = (await response.json()).storage.htmlArtifacts;
        assert.equal(info.maintenance.snapshotDeletion, false); assert.equal(info.capacity.code, 'within_reported_limits');
        assert.equal(JSON.stringify(info).includes('PRIVATE'), false);
        for (const method of ['POST', 'DELETE']) {
          assert.equal((await fetch(origin + '/api/system/storage', { method, headers,
            body: JSON.stringify({ action: 'collect', path: 'PRIVATE', confirm: true }) })).status, 405);
        }
        assert.equal(calls, 1); assert.deepEqual(snapshot(f.dataDir), before);
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    });
    console.log(`HTML artifact maintenance: ${checks}/${checks} scenarios; assertions=${assertions}; skipped=0`);
  } finally { fs.rmSync(world, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
