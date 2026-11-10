const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const entry = pathToFileURL(path.resolve(__dirname, '../server/provider-config-store.js')).href;
async function fixture(t, { fault, io } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { modelsJson: path.join(root, 'agent', 'models.json'), metadataPath: path.join(root, 'gui', 'provider-management.json') };
  fs.mkdirSync(path.dirname(options.modelsJson));
  fs.mkdirSync(path.dirname(options.metadataPath));
  const { createProviderConfigStore } = await import(entry);
  return { ...options, options, store: createProviderConfigStore({ ...options, fault, io }), open: () => createProviderConfigStore(options) };
}
function write(store, fields = {}) {
  return store.transact({ ...fields, apply({ config, metadata }) {
    config.providers.fixture = { baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'fixture' }] };
    metadata.services.fixture = { displayName: 'Fixture' };
    return { ok: true, serviceId: 'fixture', saved: true, credentialSaved: null, credentialState: 'none', operationId: null, sync: { state: 'pending', reason: 'runtime_sync_pending' } };
  } });
}

test('OAuth shares the config lock and missing stop evidence persists across stores', async t => {
  const f = await fixture(t);
  const done = f.store.acquireOAuthWrite('fixture');
  assert.throws(() => f.open().acquireOAuthWrite('fixture'), { code: 'config_busy' });
  await assert.rejects(f.open().withCredentialOperation(() => assert.fail('lease was bypassed')), { code: 'config_busy' });
  done(false);
  const reopened = f.open();
  assert.throws(() => reopened.acquireOAuthWrite('fixture'), { code: 'config_busy' });
  assert.throws(() => write(reopened), { code: 'config_busy' });
  const other = reopened.acquireOAuthWrite('unrelated');
  other(true);
  reopened.acquireOAuthWrite('unrelated')(true);
  await assert.rejects(reopened.withCredentialOperation(tx => tx.prepare({ requestId: 'native', fingerprint: 'a'.repeat(64),
    providerId: 'fixture', action: 'apply-staged' })), { code: 'config_busy' });
});

test('a confirmed standalone OAuth operation leaves no empty authority marker', async t => {
  const f = await fixture(t);
  f.store.acquireOAuthWrite('fixture')(true);
  assert.equal(fs.existsSync(f.modelsJson + '.pi-gui-operations.json'), false);
  const { createProviderConfigStore } = await import(entry);
  const second = createProviderConfigStore({ ...f.options, metadataPath: path.join(path.dirname(f.metadataPath), 'other.json') });
  second.acquireOAuthWrite('fixture')(true);
});

test('a completed OAuth mutation records a durable sync generation without changing the configuration revision', async t => {
  const f = await fixture(t);
  const before = f.store.read().revision;
  f.store.acquireOAuthWrite('fixture')(true, true);
  assert.equal(f.store.read().revision, before);
  const intent = f.open().readAuthSyncIntent();
  assert.match(intent.generation, /^[a-f0-9-]{36}$/);
  assert.equal(intent.unconfirmed, false);
  f.open().acquireOAuthWrite('fixture')(true, false);
  assert.deepEqual(f.open().readAuthSyncIntent(), intent);
  f.open().acquireOAuthWrite('fixture')(false, true);
  assert.deepEqual(f.open().readAuthSyncIntent(), { ...intent, unconfirmed: true });
});

test('sync evidence keeps removed custom models across reopening and never reads credential contents', async t => {
  const io = Object.create(fs);
  const f = await fixture(t, { io });
  const auth = path.join(path.dirname(f.modelsJson), 'auth.json');
  io.openSync = (file, ...args) => {
    assert.notEqual(file, auth);
    return fs.openSync(file, ...args);
  };
  fs.writeFileSync(auth, 'secret-fixture', { mode: 0o600 });
  f.store.transact({ apply({ config, metadata }) {
    config.providers.fixture = { models: [{ id: 'retired', name: 'Old' }] };
    metadata.services.fixture = { kind: 'custom' };
    metadata.syncRequired = true;
  } });
  const launch = f.store.readSyncEvidence();
  assert.deepEqual(launch.expected, [{ provider: 'fixture', id: 'retired', fields: { name: 'Old' } }]);
  assert.ok(!JSON.stringify(launch).includes('secret-fixture'));
  const first = f.store.read().metadata.syncGeneration;
  f.store.transact({ apply({ config, metadata }) { delete config.providers.fixture; delete metadata.services.fixture; } });
  const reopened = f.open();
  assert.notEqual(reopened.read().metadata.syncGeneration, first);
  assert.deepEqual(reopened.readSyncEvidence().removed, [['fixture', 'retired']]);
  assert.notEqual(reopened.readSyncEvidence().native, launch.native);
});

test('the auth storage qualifier rejects wrong authorities and hard-linked files without reading credentials', async t => {
  const io = Object.create(fs);
  const f = await fixture(t, { io });
  const authPath = path.join(path.dirname(f.modelsJson), 'auth.json');
  io.openSync = (file, ...args) => {
    assert.notEqual(file, authPath, 'storage qualification must not open auth data');
    return fs.openSync(file, ...args);
  };
  assert.equal(f.store.authorizeCredentialStorage({ authPath: path.join(path.dirname(authPath), 'elsewhere.json') }), false);
  fs.writeFileSync(authPath, 'fixture-only', { mode: 0o600 });
  fs.linkSync(authPath, authPath + '.linked');
  assert.equal(f.store.authorizeCredentialStorage({ authPath }), false);
  assert.equal(fs.readFileSync(authPath, 'utf8'), 'fixture-only');
});

/* P6 上线阻断修复：Windows 上 Pi 只用 mode 0600 写 auth.json，不设 DACL。
 * prepareCredentialStorage 必须在首次原生保存前建立受保护的单用户 DACL，
 * 否则正常机器上的密钥输入会一直被资格检查拒绝。 */
function readDacl(target) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$acl=Get-Acl -LiteralPath $env:PI_GUI_ACL_TEST_TARGET",
    "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
    "[ordered]@{protected=$acl.AreAccessRulesProtected;owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;sid=$sid;rules=@($rules|ForEach-Object{[ordered]@{identity=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString();inherited=$_.IsInherited}})}|ConvertTo-Json -Compress -Depth 5",
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, PI_GUI_ACL_TEST_TARGET: target },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('prepareCredentialStorage creates a protected single-user native credential file', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const directory = path.dirname(f.modelsJson);
  const authPath = path.join(directory, 'auth.json');
  assert.equal(fs.existsSync(authPath), false);
  assert.equal(f.store.prepareCredentialStorage({ authPath }), true, 'normal machine must qualify for native key input');
  assert.equal(fs.readFileSync(authPath, 'utf8'), '{}\n', 'Pi-compatible empty credential file, never a secret');
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith('.pi-gui-credential-')), [],
    'the staging directory is removed after the atomic publication');
  const acl = readDacl(authPath);
  assert.equal(acl.protected, true, 'inherited permissive rules must be removed');
  assert.equal(acl.owner, acl.sid, 'the current user must own the credential file');
  assert.equal(acl.rules.length, 1, 'exactly one explicit rule is allowed');
  assert.equal(acl.rules[0].identity, acl.sid);
  assert.equal(acl.rules[0].type, 'Allow');
  assert.equal(acl.rules[0].rights, 'FullControl');
  assert.equal(acl.rules[0].inherited, false);
  // 第二次准备必须幂等，且不改内容；已合格时不应重写 ACL（ctime 抖动会让
  // 同一保存流程里的 worker inspect 误判文件变化）。
  const before = fs.statSync(authPath, { bigint: true });
  assert.equal(f.store.prepareCredentialStorage({ authPath }), true);
  assert.equal(fs.readFileSync(authPath, 'utf8'), '{}\n');
  assert.equal(fs.statSync(authPath, { bigint: true }).ctimeNs, before.ctimeNs, 'a qualified file is verified, not re-ACLed');
});

test('prepareCredentialStorage replaces an existing permissive file with a private copy on a new inode', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const authPath = path.join(path.dirname(f.modelsJson), 'auth.json');
  const original = '{"fixture":"not-a-real-secret"}\n';
  fs.writeFileSync(authPath, original);
  const { execFileSync } = require('node:child_process');
  execFileSync('icacls', [authPath, '/grant', '*S-1-1-0:R'], { stdio: 'ignore', windowsHide: true });
  const permissive = readDacl(authPath);
  assert.ok(permissive.rules.length > 1, 'fixture starts with a foreign allow rule');
  /* 原位改 ACL 不能撤销已经打开的旧句柄。准备阶段必须把内容复制到新
   * inode 再替换路径，后续写入才不会出现在旧句柄里。 */
  const oldIdentity = fs.statSync(authPath, { bigint: true }).ino;
  assert.equal(f.store.prepareCredentialStorage({ authPath }), true);
  assert.equal(fs.readFileSync(authPath, 'utf8'), original, 'migration preserves credential data');
  assert.notEqual(fs.statSync(authPath, { bigint: true }).ino, oldIdentity,
    'the qualified file must be published on a new inode');
  const next = '{"fixture":"new-secret-after-hardening"}\n';
  fs.writeFileSync(authPath, next, { mode: 0o600 });
  assert.equal(fs.readFileSync(authPath, 'utf8'), next);
  const acl = readDacl(authPath);
  assert.equal(acl.protected, true);
  assert.equal(acl.rules.length, 1);
  assert.equal(acl.rules[0].identity, acl.sid);
  assert.ok(!acl.rules.some(rule => rule.identity === 'S-1-1-0'), 'the world-readable rule is removed');
});

test('prepareCredentialStorage fails closed when an existing file cannot be replaced atomically', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const authPath = path.join(path.dirname(f.modelsJson), 'auth.json');
  const original = '{"fixture":"not-a-real-secret"}\n';
  fs.writeFileSync(authPath, original);
  const { execFileSync } = require('node:child_process');
  execFileSync('icacls', [authPath, '/grant', '*S-1-1-0:R'], { stdio: 'ignore', windowsHide: true });
  // 不共享删除的旧句柄会阻止原子替换；此时必须 fail-closed，而不是退回
  // 原位改 ACL（旧句柄仍能读到之后写入的密钥）。
  const handle = fs.openSync(authPath, 'r');
  try {
    assert.equal(f.store.prepareCredentialStorage({ authPath }), false);
  } finally {
    fs.closeSync(handle);
  }
  assert.equal(fs.readFileSync(authPath, 'utf8'), original);
  assert.ok(readDacl(authPath).rules.some(rule => rule.identity === 'S-1-1-0'),
    'the unqualified DACL must not be presented as repaired');
});

test('prepareCredentialStorage never overwrites a credential file created concurrently', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const directory = path.dirname(f.modelsJson);
  const authPath = path.join(directory, 'auth.json');
  const sentinel = '{"fixture-provider":{"type":"api_key","key":"concurrent"}}\n';
  let armed = true;
  const io = Object.create(fs);
  io.writeFileSync = function writeFileSync(file, data, options) {
    const result = fs.writeFileSync(file, data, options);
    if (armed && String(file).includes('.pi-gui-credential-') && path.basename(String(file)) === 'auth.json') {
      armed = false;
      // Simulate Pi creating the real file while the GUI staged its empty one.
      fs.writeFileSync(authPath, sentinel, { mode: 0o600 });
    }
    return result;
  };
  const { createProviderConfigStore } = await import(entry);
  const store = createProviderConfigStore({ ...f.options, io });
  assert.equal(store.prepareCredentialStorage({ authPath }), true);
  assert.equal(fs.readFileSync(authPath, 'utf8'), sentinel, 'a concurrent native credential write must survive');
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith('.pi-gui-credential-')), []);
});

test('prepareCredentialStorage rejects foreign paths and hard-linked credential files', async t => {
  const f = await fixture(t);
  const directory = path.dirname(f.modelsJson);
  const authPath = path.join(directory, 'auth.json');
  assert.equal(f.store.prepareCredentialStorage({ authPath: path.join(directory, 'elsewhere.json') }), false,
    'only the exact Pi credential path may be prepared');
  assert.equal(fs.existsSync(path.join(directory, 'elsewhere.json')), false);
  fs.writeFileSync(authPath, '{"fixture":"keep"}\n');
  fs.linkSync(authPath, authPath + '.linked');
  assert.equal(f.store.prepareCredentialStorage({ authPath }), false, 'hard-linked files are never qualified');
  assert.equal(fs.readFileSync(authPath, 'utf8'), '{"fixture":"keep"}\n');
});

test('credential dispatch holds the existing config lock and survives reopening', async t => {
  const f = await fixture(t);
  const request = { requestId: 'native-dispatch', fingerprint: 'a'.repeat(64) };
  let receipt;
  await f.store.withCredentialOperation(async tx => {
    tx.prepare({ ...request, providerId: 'fixture', action: 'apply-staged' });
    assert.throws(() => tx.dispatch(request.requestId), { code: 'config_recovery_required' });
    receipt = write(tx, request);
    tx.dispatch(request.requestId);
    await Promise.resolve();
    assert.throws(() => write(f.open()), { code: 'config_busy' });
  });
  await f.open().withCredentialOperation(tx => {
    assert.equal(tx.lookup(request.requestId, request.fingerprint).operation.phase, 'dispatching');
    assert.deepEqual(tx.lookup(request.requestId, request.fingerprint).receipt, receipt);
    assert.throws(() => tx.dispatch(request.requestId), { code: 'config_recovery_required' });
    assert.throws(() => tx.lookup(request.requestId, 'b'.repeat(64)), { code: 'request_id_conflict' });
  });
});

test('an unresolved native operation protects its exact P1 receipt from legacy eviction', async t => {
  const f = await fixture(t);
  const request = { requestId: 'protected-receipt', fingerprint: 'a'.repeat(64) };
  await f.store.withCredentialOperation(tx => {
    tx.prepare({ ...request, providerId: 'fixture', action: 'clear-native' });
    write(tx, request);
  });
  const metadata = JSON.parse(fs.readFileSync(f.metadataPath, 'utf8'));
  for (let i = 0; i < 127; i++) metadata.receipts[`historical-${i}`] = metadata.receipts[request.requestId];
  fs.writeFileSync(f.metadataPath, JSON.stringify(metadata));
  const reopened = f.open();
  write(reopened, { requestId: 'unrelated-request', fingerprint: 'b'.repeat(64) });
  const receipts = reopened.read().metadata.receipts;
  assert.equal(Object.keys(receipts).length, 128);
  assert.equal(receipts[request.requestId].fingerprint, request.fingerprint);
  assert.equal(Object.hasOwn(receipts, 'historical-0'), false);
});

test('a prepared operation abandoned before P1 publication cannot pin its provider indefinitely', async t => {
  const f = await fixture(t);
  const first = { requestId: 'abandoned-request', fingerprint: 'a'.repeat(64), providerId: 'fixture', action: 'apply-staged' };
  const next = { ...first, requestId: 'new-request' };
  await f.store.withCredentialOperation(tx => tx.prepare(first));
  await f.open().withCredentialOperation(tx => {
    tx.prepare(next);
    assert.equal(tx.lookup(first.requestId, first.fingerprint).operation, undefined);
    assert.equal(tx.lookup(next.requestId, next.fingerprint).operation.phase, 'prepared');
  });
});

test('missing files initialize lazily; external edits conflict and durable request replay stays idempotent', async t => {
  const f = await fixture(t);
  const before = f.store.read();
  assert.equal(before.exists, false);
  assert.equal(fs.existsSync(f.metadataPath), false);
  const request = { expectedRevision: before.revision, requestId: 'fixture-request', fingerprint: 'a'.repeat(64) };
  const receipt = write(f.store, request);
  const first = fs.readFileSync(f.modelsJson);
  const reopened = f.open();
  assert.deepEqual(write(reopened, request), receipt);
  assert.deepEqual(fs.readFileSync(f.modelsJson), first);
  assert.throws(() => write(reopened, { ...request, fingerprint: 'b'.repeat(64) }), { code: 'request_id_conflict' });
  fs.writeFileSync(f.modelsJson, '{"providers":{},"external":true}');
  assert.throws(() => write(reopened, { expectedRevision: receipt.revision }), { code: 'config_conflict' });
  assert.equal(reopened.read().config.external, true);
});

test('malformed and unreadable inputs are never overwritten', async t => {
  let denied = false;
  const io = Object.create(fs);
  io.openSync = (...args) => {
    if (denied && args[0] === f.modelsJson) throw Object.assign(new Error('private-path'), { code: 'EACCES' });
    return fs.openSync(...args);
  };
  const f = await fixture(t, { io });
  fs.writeFileSync(f.modelsJson, '{bad');
  assert.throws(() => write(f.store), { code: 'config_invalid' });
  assert.equal(fs.readFileSync(f.modelsJson, 'utf8'), '{bad');
  fs.writeFileSync(f.modelsJson, '{"providers":{}}');
  denied = true;
  assert.throws(() => write(f.store), { code: 'config_unreadable' });
  assert.equal(fs.readFileSync(f.modelsJson, 'utf8'), '{"providers":{}}');
});

test('first-file interruption recovers the same receipt after restart', async t => {
  const f = await fixture(t, { fault(stage) { if (stage === 'after-models') throw new Error('interrupted'); } });
  const request = { requestId: 'interrupted', fingerprint: 'f'.repeat(64) };
  assert.throws(() => write(f.store, request), { code: 'config_recovery_required' });
  assert.equal(fs.existsSync(f.metadataPath), false);
  const recovered = f.open();
  const receipt = write(recovered, request);
  assert.equal(receipt.saved, true);
  assert.equal(recovered.read().metadata.services.fixture.displayName, 'Fixture');
  assert.notEqual(recovered.read().revision, receipt.revision); // A restarted process issues its own opaque revisions.
});

test('recovery leaves an external edit intact and reports the conflict', async t => {
  const f = await fixture(t, { fault(stage) { if (stage === 'after-models') throw new Error('interrupted'); } });
  assert.throws(() => write(f.store), { code: 'config_recovery_required' });
  const external = '{"providers":{},"external":true}';
  fs.writeFileSync(f.modelsJson, external);
  assert.throws(() => f.open().read(), { code: 'config_recovery_required' });
  assert.equal(fs.readFileSync(f.modelsJson, 'utf8'), external);
  assert.equal(fs.existsSync(f.metadataPath), false);
});

test('another GUI process cannot write while a transaction holds the lock', async t => {
  const f = await fixture(t);
  const script = `const {createProviderConfigStore}=await import(process.argv[1]);
    const store=createProviderConfigStore({...JSON.parse(process.argv[2]),fault(stage){
      if(stage===process.argv[3]){process.stdout.write('locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);}
    }});
    store.transact({apply({config}){config.external='child';return {saved:true};}});`;
  for (const checkpoint of ['before-publish', 'after-recovery-claim']) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, entry, JSON.stringify(f.options), checkpoint], { stdio: ['ignore','pipe','pipe'] });
    const exit = new Promise(resolve => child.once('exit', resolve));
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('exit', () => reject(new Error('fixture exited before lock')));
      });
      assert.throws(() => write(f.store), { code: 'config_busy' });
    } finally {
      child.kill();
      await exit;
    }
  }
  assert.equal(write(f.open()).saved, true);
});

test('unprotected recovery files cannot publish a forged journal', async t => {
  const f = await fixture(t);
  const transaction = f.modelsJson + '.pi-gui-transaction';
  fs.mkdirSync(transaction, { mode: 0o755 });
  if (process.platform !== 'win32') fs.chmodSync(transaction, 0o755);
  const digest = data => createHash('sha256').update(data).digest('hex');
  const files = { models: f.modelsJson, metadata: f.metadataPath };
  const values = {
    models: { providers: { fixture: { apiKey: '!fixture-must-never-install' } } },
    metadata: { schemaVersion: 1, services: {}, receipts: {} },
  };
  const manifest = { version: 1, installId: randomUUID(), files: {}, entries: {} };
  for (const [key, file] of Object.entries(files)) {
    const data = JSON.stringify(values[key]);
    const s = fs.statSync(path.dirname(file), { bigint: true });
    manifest.files[key] = digest(file);
    manifest.entries[key] = { directory: `${s.dev}:${s.ino}:${s.birthtimeNs}`, before: null, stamp: null, after: digest(data) };
    fs.writeFileSync(path.join(transaction, key + '.after'), data);
  }
  fs.writeFileSync(path.join(transaction, 'journal.json'), JSON.stringify(manifest));
  assert.throws(() => f.open().recoverPending(), { code: 'config_unsafe' });
  assert.equal(fs.existsSync(f.modelsJson), false);
  assert.equal(fs.existsSync(f.metadataPath), false);
});

test('hardlinked models file is rejected', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.modelsJson, '{"providers":{}}');
  fs.linkSync(f.modelsJson, path.join(path.dirname(f.modelsJson), 'other.json'));
  assert.throws(() => write(f.store), { code: 'config_unsafe' });
});
