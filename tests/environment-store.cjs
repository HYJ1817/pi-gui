const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function fixture(t) {
  const { createEnvironmentStore, NODE_LTS, GIT_MINIGIT } = await import('../server/environment-store.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-environment-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PATH: 'fixture-system-path', PI_GUI_RUNTIME_DIR: path.join(root, 'runtime') };
  const options = { dataDir: path.join(root, 'data'), env };
  return { root, options, store: createEnvironmentStore(options), createEnvironmentStore, NODE_LTS, GIT_MINIGIT };
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fixture');
}

test('managed versions survive reopening and only the supplied PATH is updated', async t => {
  const { options, store, createEnvironmentStore, NODE_LTS, GIT_MINIGIT } = await fixture(t);
  const paths = store.paths();
  assert.equal(store.managedNodeDir(), null);
  touch(path.join(paths.nodeDir(NODE_LTS.version), 'node.exe'));
  touch(paths.gitBin(GIT_MINIGIT.version));
  touch(paths.piBin);
  assert.equal(store.recordManaged({ nodeVersion: NODE_LTS.version, gitVersion: GIT_MINIGIT.version, piVersion: '1.5.2' }), true);
  const reopened = createEnvironmentStore(options);
  assert.equal(reopened.managedNodeDir(), paths.nodeDir(NODE_LTS.version));
  assert.equal(reopened.effectivePiBin().source, 'managed');
  assert.equal(reopened.managedGitBin(), paths.gitBin(GIT_MINIGIT.version));
  const target = { ...options.env };
  const original = process.env.PATH;
  assert.deepEqual(reopened.applyManagedPath(target), { changed: true, count: 2 });
  assert.deepEqual(reopened.applyManagedPath(target), { changed: false, count: 2 });
  assert.equal(options.env.PATH, 'fixture-system-path');
  assert.equal(process.env.PATH, original);
});

test('startup recovers interrupted state and preserves explicit Pi precedence', async t => {
  const { root, options, store, createEnvironmentStore } = await fixture(t);
  const manual = path.join(root, 'manual', process.platform === 'win32' ? 'pi.cmd' : 'pi');
  touch(manual);
  touch(store.paths().piBin);
  assert.equal(store.setPiBinOverride(manual).ok, true);
  assert.equal(store.recordJob({ id: 'fixture-job', state: 'running' }), true);
  const reopened = createEnvironmentStore(options);
  assert.equal(reopened.read().lastJob.state, 'interrupted');
  assert.equal(reopened.effectivePiBin().bin, manual);
  assert.deepEqual(reopened.effectivePiBin({ envPiBin: 'external' }), { bin: 'external', source: 'env', locked: true });
  const projection = reopened.redactPath(store.paths().piBin);
  assert.ok(!projection.includes(root));
});
