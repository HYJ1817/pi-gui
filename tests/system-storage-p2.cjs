'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSystemStorage } = require('../electron/system-storage-migration.cjs');
const { BOOT_FILE } = require('../electron/system-storage-policy.cjs');

const WIN = process.platform === 'win32';
const STOPPED = { writersStopped: true };
const SECRET = 'fixture-token-must-never-be-reported';
const PROJECTS = JSON.stringify({ active: '', items: [] });
const hash = value => createHash('sha256').update(value).digest('hex');
const shellGuardSubstitute = async () => 'ok'; // Real Win32 checks have their own tests below.
const succeeds = reply => { assert.equal(reply.ok, true, reply.code); return reply; };
function refuses(reply, code) {
  assert.equal(reply.ok, false);
  assert.equal(reply.code, code);
  assert.equal(JSON.stringify(reply).includes(SECRET), false);
  assert.equal(Object.hasOwn(reply, 'ticket'), false);
  return reply;
}

async function world(t, { separateLegacy = false, realWindows = false } = {}) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-gui-storage-p2-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const anchor = path.join(base, 'Electron 用户资料'), target = path.join(base, '新数据 目录');
  const source = separateLegacy ? path.join(base, 'legacy data') : anchor;
  const project = path.join(base, 'project'), install = path.join(base, 'install');
  const piAgentDirectory = path.join(base, '.pi', 'agent');
  const runtimeDirectory = path.join(source, 'runtime');
  const boot = path.join(anchor, BOOT_FILE);
  for (const directory of new Set([anchor, target, source, project, install, piAgentDirectory])) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(source, 'projects.json'), PROJECTS);
  const opts = { directory: anchor, defaultDataDirectory: source, protectedRoots: [install], runtimeDirectory, piAgentDirectory,
    ...(realWindows ? {} : { inspectWindows: shellGuardSubstitute }) };
  const make = options => createSystemStorage({ ...opts, ...options });
  const open = async options => { const store = make(options); succeeds(await store.initialize()); return store; };
  const write = async (relative, value, root = source) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
    return file;
  };
  return { base, anchor, source, target, project, install, runtimeDirectory, piAgentDirectory, boot, make, open, write };
}

async function schedule(store, target) {
  const { ticket } = succeeds(await store.preview(target));
  const { intentId } = succeeds(await store.commit({ ticket, confirm: true }));
  assert.equal(succeeds(await store.arm({ transactionId: intentId })).state.phase, 'ready');
  return intentId;
}

function conversation(project, file) {
  return JSON.stringify({ version: 1, items: [{ conversationId: '05020202-0202-0202-0202-020202020202',
    workspace: { projectId: 'proj', repoId: 'repo', workspaceId: 'project-proj', workspaceEpoch: 'epoch', cwd: project, root: project, branch: null },
    sessionId: '07020202-0202-0202-0202-020202020202', sessionLocator: file,
    sessionIdentity: { dev: 1, ino: 2, birthtimeMs: 3 }, sessionName: 'demo', nameSource: 'native', createdAt: '2026-11-20T00:00:00.000Z' }] });
}

test('UTF-8 BOM business files remain byte-exact while invalid UTF-8 still fails closed', async t => {
  const w = await world(t);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PROJECTS)]);
  await w.write('projects.json', bytes);
  const store = await w.open(); await schedule(store, w.target);
  succeeds(await store.runPendingCold(STOPPED));
  assert.deepEqual(await fs.readFile(path.join(w.target, 'projects.json')), bytes);
  const { parseJson } = require('../electron/system-storage-fs.cjs');
  assert.throws(() => parseJson(Buffer.from([0xff, 0xfe, 0x7b]), 'invalid_projects'), { code: 'invalid_projects' });
});

test('cold switch copies exact GUI data with Unicode paths, leaves old bytes and anchors in place', async t => {
  const w = await world(t);
  const session = await w.write('sessions/demo.jsonl', '{"type":"session","id":"external"}\n', w.piAgentDirectory);
  const catalog = Buffer.from([0x1f, 0x8b, 0x00, 0x00]);
  const files = {
    'projects.json': JSON.stringify({ active: w.project, items: [{ path: w.project, name: 'demo' }] }),
    'session-flags.json': '{"archived":[],"deleted":[]}', 'session-titles.json': '{"version":1}',
    'session-title-settings.json': '{"version":1}', 'plans/sample-plan.json': '{"version":1}',
    'planner-sessions/--fixture--/2026-11-20T00-00-00-000Z_plan.jsonl': '{"type":"session","id":"plan"}\n',
    'trash-sessions/session-id.jsonl': '{"type":"session","id":"trash"}\n',
    [`review-comments/${'a'.repeat(64)}.json`]: '{"version":2}',
    [`collab-documents/${'b'.repeat(64)}.json`]: '{"version":1}',
    'conversations.json': conversation(w.project, session), 'mcp-market-sources.json': '{"version":1,"sources":[]}',
    'mcp-registry-catalog.json.gz': catalog,
    'environment.json': '{"version":1,"managed":{"nodeVersion":"24.22.3"},"lastJob":{"state":"completed"}}',
    '.uploads/123456789012345678901234_中文 附件.bin': Buffer.from([0, 99, 0, 255]),
  };
  const exclusions = ['system-settings.json', 'theme-preferences.json', 'app-update-preferences.json', 'window-state.json',
    'Local Storage/user-content', 'Partitions/pi-gui/cache', 'logs/app-0.log', 'runtime/node-v24.22.3-win-x64/node.exe'];
  for (const [name, value] of Object.entries(files)) await w.write(name, value);
  for (const name of exclusions) await w.write(name, SECRET);
  await w.write('unrelated.txt', SECRET, w.project);
  const store = await w.open();
  assert.equal(store.state().source, 'electron-user-data');
  const selection = succeeds(await store.preview(w.target));
  assert.deepEqual(await fs.readdir(w.target), []);
  await assert.rejects(fs.stat(w.boot), { code: 'ENOENT' });
  assert.equal(selection.summary.files, Object.keys(files).length);
  assert.equal(selection.summary.bytes, Object.values(files).reduce((n, value) => n + Buffer.byteLength(value), 0));
  assert.ok(selection.summary.excluded.includes('electron_chromium'));
  assert.ok(selection.summary.excluded.includes('installation_runtime'));
  const intent = succeeds(await store.commit({ ticket: selection.ticket, confirm: true }));
  assert.equal(intent.state.phase, 'intent');
  assert.equal(JSON.stringify(JSON.parse(await fs.readFile(w.boot, 'utf8'))).includes(selection.ticket), false);
  refuses(await store.runPendingCold({ writersStopped: false }), 'writers_not_confirmed');
  assert.deepEqual(await fs.readdir(w.target), []);

  refuses(await store.arm({ transactionId: 'unrelated' }), 'pending_identity_mismatch');
  assert.equal(succeeds(await store.arm({ transactionId: intent.intentId })).state.phase, 'ready');
  assert.deepEqual(await fs.readdir(w.target), []);
  const cold = succeeds(await store.runPendingCold(STOPPED));
  assert.equal(cold.state.phase, 'committed');
  assert.equal(cold.state.dataDirectory, w.target);
  assert.equal(cold.state.backupDirectory, w.source);
  assert.equal(cold.state.transactionId, intent.state.transactionId);
  for (const [name, value] of Object.entries(files)) {
    const left = await fs.readFile(path.join(w.source, name)), right = await fs.readFile(path.join(w.target, name));
    assert.equal(hash(left), hash(value));
    assert.equal(hash(right), hash(value));
  }
  for (const name of exclusions) {
    assert.equal(await fs.readFile(path.join(w.source, name), 'utf8'), SECRET);
    await assert.rejects(fs.stat(path.join(w.target, name)), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(path.join(w.project, 'unrelated.txt'), 'utf8'), SECRET);
  assert.equal(await fs.readFile(session, 'utf8'), '{"type":"session","id":"external"}\n');
  await assert.rejects(fs.stat(path.join(w.target, BOOT_FILE)), { code: 'ENOENT' });
  const reopened = await w.open();
  refuses(await reopened.markStarted({ transactionId: cold.state.transactionId, dataDirectory: w.source, ok: true }), 'startup_identity_mismatch');
  const marked = succeeds(await reopened.markStarted({ transactionId: cold.state.transactionId, dataDirectory: w.target, ok: true }));
  assert.equal(marked.state.phase, 'active');
  assert.equal((await w.open()).state().phase, 'active');
  t.diagnostic(`copied ${selection.summary.files} files, ${selection.summary.bytes} bytes; binary sample SHA-256 ${hash(catalog)}`);
});

test('same, both nestings, occupied targets, traversal and protected roots are refused', async t => {
  const w = await world(t, { separateLegacy: true });
  const nested = path.join(w.source, 'nested'), installChild = path.join(w.install, 'child');
  const alias = path.join(w.base, 'project-alias');
  await fs.symlink(w.project, alias, WIN ? 'junction' : 'dir');
  await w.write('projects.json', JSON.stringify({ active: alias, items: [{ path: alias }] }));
  await fs.mkdir(nested);
  await fs.mkdir(installChild);
  const store = await w.open();
  for (const directory of [w.source, nested, w.base]) refuses(await store.preview(directory), 'source_target_overlap');
  await fs.rmdir(nested); // The later project check should not encounter unrelated unknown source data.
  for (const directory of [w.anchor, installChild, w.piAgentDirectory, w.project]) refuses(await store.preview(directory), 'protected_overlap');
  refuses(await store.preview(w.target + path.sep + '..'), 'invalid_path');
  refuses(await store.preview(w.target + ':ads'), 'invalid_path');
  refuses(await store.preview(path.join(w.target, 'missing')), 'target_missing');
  await w.write('existing', SECRET, w.target);
  refuses(await store.preview(w.target), 'target_not_empty');
  assert.equal(await fs.readFile(path.join(w.target, 'existing'), 'utf8'), SECRET);
});

test('failed preflights redact fail-closed business refusals and do not omit unknown data', async t => {
  const cases = [
    ['worktrees.json', 'worktree_or_candidate_present'], ['candidate-runs', 'worktree_or_candidate_present'],
    ['candidate-transactions', 'worktree_or_candidate_present'], ['provider-management.json', 'provider_metadata_invalid'],
    ['models.json.pi-gui-operations.json', 'provider_authority_present', true],
    ['models.json.pi-gui-transaction', 'provider_authority_present', true],
    ['revert-evidence/v1/journal.jsonl', 'revert_evidence_present'],
    ['.unknown-transaction.json', 'unknown_transaction'], ['review-comments/.writer.lock', 'unknown_transaction'],
    ['plans/.unrecognized-name', 'unknown_data'], [`${SECRET}.json`, 'unknown_data'],
    ['conversations.json', 'invalid_conversations'], ['projects.json', 'invalid_projects'], ['environment.json', 'invalid_environment'],
  ];
  for (const [index, [filename, code, external]] of cases.entries()) await t.test(`closed refusal ${index + 1}: ${code}`, async sub => {
    const w = await world(sub);
    await w.write(filename, SECRET, external ? w.piAgentDirectory : w.source);
    refuses(await (await w.open()).preview(w.target), code);
    assert.deepEqual(await fs.readdir(w.target), []);
    await assert.rejects(fs.stat(w.boot), { code: 'ENOENT' });
  });
});

test('normal empty recovery skeleton and fixed Chromium profile files do not prevent migration; any evidence still blocks', async t => {
  const w = await world(t);
  await fs.mkdir(path.join(w.source, 'revert-evidence/v1/objects'), { recursive: true });
  for (const name of ['lockfile', 'declarative_performance_observer.db', 'declarative_performance_observer.db-journal']) await w.write(name, SECRET);
  const store = await w.open();
  succeeds(await store.preview(w.target));
  await w.write('revert-evidence/v1/journal.jsonl', '');
  refuses(await store.preview(w.target), 'revert_evidence_present');
  await fs.unlink(path.join(w.source, 'revert-evidence/v1/journal.jsonl'));
  await w.write('revert-evidence/v1/objects/object', SECRET);
  refuses(await store.preview(w.target), 'revert_evidence_present');
  await fs.unlink(path.join(w.source, 'revert-evidence/v1/objects/object'));
  const tx = await schedule(store, w.target);
  succeeds(await store.runPendingCold(STOPPED));
  assert.equal(store.state().transactionId, tx);
  assert.deepEqual(await fs.readdir(w.target), ['projects.json']);
  for (const name of ['lockfile', 'declarative_performance_observer.db', 'declarative_performance_observer.db-journal']) assert.equal(await fs.readFile(path.join(w.source, name), 'utf8'), SECRET);
});

test('runtime locator inside planner tree blocks; environment payload needs a fixed runtime root', async t => {
  const w = await world(t);
  const file = await w.write('planner-sessions/task_plan.jsonl', 'fixture\n');
  await w.write('conversations.json', conversation(w.project, file));
  refuses(await (await w.open()).preview(w.target), 'runtime_locator_bound');
  await w.write('conversations.json', conversation(w.project, null));
  await w.write('environment.json', '{"version":1,"managed":{"gitVersion":"2.56.1"}}');
  refuses(await (await w.open({ runtimeDirectory: null })).preview(w.target), 'runtime_not_pinned');
  succeeds(await (await w.open()).preview(w.target));
});

test('symbolic links or junctions, hardlinks and unsafe ancestors are not accepted', async t => {
  const w = await world(t);
  const external = await w.write('private', SECRET, w.project);
  const upload = path.join(w.source, '.uploads');
  await fs.mkdir(upload);
  const link = path.join(upload, 'hardlink');
  await fs.link(external, link);
  const store = await w.open();
  refuses(await store.preview(w.target), 'unsafe_entry');
  await fs.unlink(link);
  await fs.symlink(w.project, path.join(upload, 'linked'), WIN ? 'junction' : 'dir');
  refuses(await store.preview(w.target), 'unsafe_entry');
  const alias = path.join(w.base, 'target-parent-alias');
  await fs.symlink(w.base, alias, WIN ? 'junction' : 'dir');
  refuses(await store.preview(path.join(alias, path.basename(w.target))), 'unsafe_entry');
  assert.equal(await fs.readFile(external, 'utf8'), SECRET);
});

test('preflight fails safely on insufficient space, unknown space, permissions and oversized inventory', async t => {
  const w = await world(t);
  let queried;
  const noSpace = await w.open({ io: { statfs: async directory => { queried = directory; return { bsize: 4096n, bavail: 0n }; } } });
  refuses(await noSpace.preview(w.target), 'insufficient_space');
  assert.equal(queried, w.target);
  const unknown = await w.open({ io: { statfs: async () => ({}) } });
  refuses(await unknown.preview(w.target), 'space_unavailable');
  const denied = await w.open({ io: { access: async directory => {
    if (directory === w.target) throw Object.assign(Error(SECRET), { code: 'EACCES' });
  } } });
  refuses(await denied.preview(w.target), 'permission_denied');
  await w.write('projects.json', Buffer.alloc(1024 ** 2 + 1));
  refuses(await (await w.open()).preview(w.target), 'inventory_limit');
  assert.deepEqual(await fs.readdir(w.target), []);
});

test('ticket is short-lived, one-shot, and cannot change the selected path or stop contract', async t => {
  const w = await world(t);
  let now = 11;
  const store = await w.open({ now: () => now });
  const first = succeeds(await store.preview(w.target));
  refuses(await store.commit({ ticket: first.ticket, confirm: true, target: w.project }), 'invalid_request');
  refuses(await store.commit({ ticket: first.ticket, confirm: false }), 'confirm_required');
  refuses(await store.commit({ ticket: first.ticket, confirm: true }), 'ticket_invalid');
  const expiring = succeeds(await store.preview(w.target));
  now += 120_000;
  refuses(await store.commit({ ticket: expiring.ticket, confirm: true }), 'ticket_invalid');
  const superseded = succeeds(await store.preview(w.target));
  const id = await schedule(store, w.target);
  refuses(await store.commit({ ticket: superseded.ticket, confirm: true }), 'ticket_invalid');
  refuses(await store.cancelPending({ transactionId: 'old-id' }), 'pending_identity_mismatch');
  const cancelled = succeeds(await store.cancelPending({ transactionId: id }));
  assert.equal(cancelled.state.reason, 'cancelled');
  assert.equal(cancelled.state.dataDirectory, w.source);
  assert.equal(succeeds(await store.runPendingCold(STOPPED)).state.phase, 'failed');
  assert.deepEqual(await fs.readdir(w.target), []);
});

test('replacement before confirmation and after intent cannot bind a different empty directory', async t => {
  const w = await world(t);
  const store = await w.open();
  const first = succeeds(await store.preview(w.target));
  await fs.rename(w.target, path.join(w.base, 'old-target-1'));
  await fs.mkdir(w.target);
  refuses(await store.commit({ ticket: first.ticket, confirm: true }), 'path_changed');
  await schedule(store, w.target);
  await fs.rename(w.target, path.join(w.base, 'old-target-2'));
  await fs.mkdir(w.target);
  const failed = refuses(await store.runPendingCold(STOPPED), 'path_changed');
  assert.equal(failed.state.dataDirectory, w.source);
  assert.equal(failed.state.reason, 'path_changed');
  assert.deepEqual(await fs.readdir(w.target), []);
});

test('an unavailable previously bound legacy root cannot become an empty startup', async t => {
  const w = await world(t, { separateLegacy: true });
  const store = await w.open();
  await schedule(store, w.target);
  await fs.rename(w.source, path.join(w.base, 'removed source'));
  const failure = refuses(await store.runPendingCold(STOPPED), 'source_missing');
  assert.equal(failure.startupCode, 'path_changed');
  assert.equal(failure.state.dataDirectory, null);
  assert.equal(refuses(await w.make().initialize(), 'path_changed').state.dataDirectory, null);
  await assert.rejects(fs.stat(w.source), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(w.target), []);
});

test('late destination collisions never overwrite another file or follow a hardlink', async t => {
  const w = await world(t);
  const elsewhere = await w.write('private-file', SECRET, w.project);
  const destination = path.join(w.target, 'projects.json');
  const kernel = await w.open({ hook: async name => { if (name === 'before_copy_file') await fs.link(elsewhere, destination); } });
  await schedule(kernel, w.target);
  refuses(await kernel.runPendingCold(STOPPED), 'copy_failed');
  assert.equal(await fs.readFile(elsewhere, 'utf8'), SECRET);
  assert.equal(await fs.readFile(destination, 'utf8'), SECRET);
  assert.equal(await fs.readFile(path.join(w.source, 'projects.json'), 'utf8'), PROJECTS);
});

test('registered roots are refreshed at confirmation and cold time', async t => {
  const w = await world(t);
  let roots = [];
  const store = await w.open({ getProtectedRoots: () => roots });
  const { ticket } = succeeds(await store.preview(w.target));
  roots = [w.target];
  refuses(await store.commit({ ticket, confirm: true }), 'protected_overlap');
  roots = [];
  await schedule(store, w.target);
  roots = [w.target];
  refuses(await store.runPendingCold(STOPPED), 'protected_overlap');
  assert.deepEqual(await fs.readdir(w.target), []);
});

test('cold write failures retain the old dataset, partial target and fixed reason', async t => {
  const w = await world(t);
  const body = Buffer.alloc(512 * 1024, 7);
  const old = await w.write('.uploads/body.bin', body);
  const store = await w.open({ hook: point => { if (point === 'after_copy_chunk') throw Error(SECRET); } });
  await schedule(store, w.target);
  const failure = refuses(await store.runPendingCold(STOPPED), 'copy_failed');
  assert.equal(failure.state.reason, 'copy_failed');
  assert.equal((await w.open()).state().dataDirectory, w.source);
  assert.deepEqual(await fs.readFile(old), body);
  assert.equal((await fs.stat(path.join(w.target, '.uploads', 'body.bin'))).size, 256 * 1024);
  const record = JSON.parse(await fs.readFile(w.boot, 'utf8'));
  assert.equal(record.managed, null);
  assert.equal(record.transaction.phase, 'failed');
});

test('post-copy digest, complete set and same-byte object replacement all gate the switch', async t => {
  for (const variant of ['source_digest', 'target_digest', 'target_extra', 'target_identity']) await t.test(variant, async sub => {
    const w = await world(sub);
    await w.write('.uploads/one.bin', 'old!');
    const store = await w.open({ hook: async point => {
      if (point !== 'after_copy') return;
      switch (variant) {
        case 'source_digest': await w.write('.uploads/one.bin', 'new!'); break;
        case 'target_digest': await w.write('.uploads/one.bin', 'new!', w.target); break;
        case 'target_extra': await w.write('session-flags.json', '{}', w.target); break;
        case 'target_identity':
          await fs.rename(path.join(w.target, '.uploads', 'one.bin'), path.join(w.base, 'copied-object'));
          await w.write('.uploads/one.bin', 'old!', w.target);
          break;
      }
    } });
    await schedule(store, w.target);
    refuses(await store.runPendingCold(STOPPED), variant === 'source_digest' ? 'source_changed' : 'verification_failed');
    assert.equal((await w.open()).state().dataDirectory, w.source);
    assert.equal(await fs.readFile(path.join(w.source, '.uploads', 'one.bin'), 'utf8'), variant === 'source_digest' ? 'new!' : 'old!');
  });
});

test('boot rename failure retains both roots; lost acknowledgement never rolls back', async t => {
  for (const renamed of [false, true]) await t.test(renamed ? 'rename happened' : 'rename refused', async sub => {
    const w = await world(sub);
    const store = await w.open({ io: { rename: async (from, to) => {
      const payload = JSON.parse(await fs.readFile(from, 'utf8'));
      if (payload.transaction.phase !== 'committed') return fs.rename(from, to);
      if (renamed) await fs.rename(from, to);
      throw Error(SECRET);
    } } });
    await schedule(store, w.target);
    const failed = refuses(await store.runPendingCold(STOPPED), 'boot_write_failed');
    assert.equal(failed.state.switched, renamed);
    assert.equal(failed.state.phase, renamed ? 'committed' : 'failed');
    assert.equal((await w.open()).state().dataDirectory, renamed ? w.target : w.source);
    for (const root of [w.source, w.target]) assert.equal(await fs.readFile(path.join(root, 'projects.json'), 'utf8'), PROJECTS);
  });
});

test('bootstrap corruption/future schema or a replaced/missing managed directory never falls back', async t => {
  const w = await world(t, { separateLegacy: true });
  await w.write(BOOT_FILE, `{broken ${SECRET}`, w.anchor);
  refuses(await w.make().initialize(), 'boot_corrupt');
  await w.write(BOOT_FILE, '{"version":2}', w.anchor);
  const future = refuses(await w.make().initialize(), 'boot_version_unsupported');
  assert.equal(future.state.dataDirectory, null);
  const override = path.join(w.base, 'env override');
  assert.equal(succeeds(await w.make({ explicitDataDirectory: override }).initialize()).state.dataDirectory, override);
  assert.equal(await fs.readFile(w.boot, 'utf8'), '{"version":2}');
  await fs.unlink(w.boot);
  const store = await w.open();
  await schedule(store, w.target);
  succeeds(await store.runPendingCold(STOPPED));
  const envStore = await w.open({ explicitDataDirectory: override });
  assert.equal(envStore.state().source, 'environment');
  refuses(await envStore.preview(w.source), 'environment_override');
  await fs.rename(w.target, path.join(w.base, 'prior managed'));
  refuses(await w.make().initialize(), 'managed_directory_missing');
  await assert.rejects(fs.stat(w.target), { code: 'ENOENT' });
  await fs.mkdir(w.target);
  refuses(await w.make().initialize(), 'managed_directory_changed');
  assert.deepEqual(await fs.readdir(w.target), []);
  assert.equal(await fs.readFile(path.join(w.source, 'projects.json'), 'utf8'), PROJECTS);
});

test('managed root lost after publish blocks startup without reverting the pointer', async t => {
  const w = await world(t);
  const moved = path.join(w.base, 'preserved destination');
  const kernel = await w.open({ hook: async name => { if (name === 'after_committed') await fs.rename(w.target, moved); } });
  const tx = await schedule(kernel, w.target);
  assert.equal(refuses(await kernel.runPendingCold(STOPPED), 'path_changed').state.dataDirectory, null);
  const record = JSON.parse(await fs.readFile(w.boot, 'utf8'));
  assert.equal(record.transaction.phase, 'committed');
  assert.equal(record.managed.transactionId, tx);
  refuses(await w.make().initialize(), 'managed_directory_missing');
  for (const root of [w.source, moved]) assert.equal(await fs.readFile(path.join(root, 'projects.json'), 'utf8'), PROJECTS);
});

test('reported startup failure never reverts; a new preview uses current managed bytes, not backup', async t => {
  const w = await world(t);
  const next = path.join(w.base, 'recovery target');
  await fs.mkdir(next);
  const store = await w.open();
  const id = await schedule(store, w.target);
  succeeds(await store.runPendingCold(STOPPED));
  const failed = succeeds(await store.markStarted({ transactionId: id, dataDirectory: w.target, ok: false }));
  assert.equal(failed.state.reason, 'start_failed');
  assert.equal(failed.state.dataDirectory, w.target);
  refuses(await store.cancelPending({ transactionId: id }), 'pending_identity_mismatch');
  await w.write('session-flags.json', '{"archived":["new"]}', w.target);
  const reopened = await w.open();
  assert.equal(reopened.state().reason, 'start_failed');
  refuses(await reopened.preview(w.source), 'protected_overlap');
  const recovery = await schedule(reopened, next);
  assert.notEqual(recovery, id);
  const migrated = succeeds(await reopened.runPendingCold(STOPPED));
  assert.equal(migrated.state.backupDirectory, w.target);
  assert.equal(await fs.readFile(path.join(next, 'session-flags.json'), 'utf8'), '{"archived":["new"]}');
  assert.equal(await fs.readFile(path.join(w.target, 'session-flags.json'), 'utf8'), '{"archived":["new"]}');
});

test('Windows production guard rejects real ADS on a file, an empty folder, and bootstrap', { skip: !WIN }, async t => {
  const w = await world(t, { realWindows: true });
  const store = await w.open();
  succeeds(await store.preview(w.target));
  const file = path.join(w.source, 'projects.json');
  await fs.writeFile(file + ':invisible', SECRET);
  refuses(await store.preview(w.target), 'unsafe_entry');
  assert.equal(await fs.readFile(file + ':invisible', 'utf8'), SECRET);
  await fs.unlink(file + ':invisible');
  await fs.writeFile(w.target + ':invisible', SECRET);
  refuses(await store.preview(w.target), 'unsafe_entry');
  await fs.unlink(w.target + ':invisible');
  await schedule(store, w.target);
  succeeds(await store.runPendingCold(STOPPED));
  await fs.writeFile(w.boot + ':invisible', SECRET);
  refuses(await w.make().initialize(), 'unsafe_entry');
});
