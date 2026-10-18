const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

async function main() {
  const planModule = await import(pathToFileURL(path.join(root, 'scripts/test-group-plan.mjs')));
  const plan = planModule.createTestGroupPlan({ root, packageJson });

  assert.deepEqual(plan.groups, ['core', 'ui', 'security', 'native', 'faults']);
  assert.equal(plan.leaves.length, new Set(plan.leaves).size, 'canonical test chain contains duplicate leaf commands');
  assert.equal(
    plan.groups.reduce((sum, group) => sum + plan.byGroup.get(group).length, 0),
    plan.leaves.length,
    'group union differs from canonical test chain',
  );

  const union = [...plan.byGroup.values()].flat();
  assert.equal(union.length, plan.leaves.length);
  assert.deepEqual(new Set(union), new Set(plan.leaves));

  for (const command of plan.leaves) {
    if (command.startsWith('node tests/')) {
      const file = command.split(/\s+/)[1];
      assert.ok(fs.existsSync(path.join(root, file)), `test file is missing: ${file}`);
    }
  }

  const groupOf = (name) => plan.groupByCommand.get(`node tests/${name}`);
  const expected = {
    'session-revert-object-writer.cjs': 'native',
    'session-revert-object-runtime.cjs': 'native',
    'session-revert-inplace.cjs': 'security',
    'session-revert-sacl-witness.cjs': 'security',
    'session-revert-object-faults.cjs': 'faults',
    'session-revert-windows-faults.cjs': 'faults',
    'session-change-store.cjs': 'faults',
    'smoke.cjs': 'ui',
    'approvals.cjs': 'core',
    'browser.cjs': 'core',
    'logging-leaks.cjs': 'core',
  };
  for (const [name, group] of Object.entries(expected)) {
    assert.equal(groupOf(name), group, `${name} assigned to the wrong CI group`);
  }

  assert.equal(planModule.classifyTestCommand('node tests/new-future-test.cjs'), 'core');
  assert.throws(() => planModule.classifyTestCommand('node tests/new-test.cjs', ['unknown']), /unknown test group/);

  // npm runs lifecycle hooks for both the root test and nested npm-run aliases.
  // A newly added hook must not disappear from CI while running locally.
  const lifecycle = planModule.createTestGroupPlan({ root, packageJson: { scripts: {
    pretest: 'node tests/before.cjs',
    test: 'npm run contract',
    posttest: 'node tests/after.cjs',
    precontract: 'node tests/before-contract.cjs',
    contract: 'node tests/future-contract.cjs',
    postcontract: 'node tests/after-contract.cjs',
  } } });
  assert.deepEqual(lifecycle.leaves, [
    'node tests/before.cjs', 'node tests/before-contract.cjs',
    'node tests/future-contract.cjs', 'node tests/after-contract.cjs',
    'node tests/after.cjs',
  ]);
  assert.deepEqual(lifecycle.byGroup.get('core'), lifecycle.leaves);

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ci-failure-'));
  try {
    fs.mkdirSync(path.join(fixture, 'tests'));
    const names = ['fail.cjs', 'must-not-run.cjs', 'ui-fake.cjs',
      'session-revert-fake.cjs', 'session-revert-object-runtime.cjs', 'stop-barrier.cjs'];
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ scripts: {
      test: names.map((name) => `node tests/${name}`).join(' && '),
    } }));
    for (const name of names) {
      fs.writeFileSync(path.join(fixture, 'tests', name), name === 'fail.cjs'
        ? 'process.exitCode = 17;'
        : "require('node:fs').writeFileSync('unexpected-execution', 'ran');");
    }
    const resultFile = path.join(fixture, 'results.json');
    const failed = spawnSync(process.execPath, [path.join(root, 'scripts/run-test-group.mjs'),
      '--group', 'core', '--results', resultFile], { cwd: fixture, encoding: 'utf8', windowsHide: true });
    assert.equal(failed.status, 1, failed.stderr);
    const recorded = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(recorded.results.length, 1, 'failure must stop the group');
    assert.equal(recorded.results[0].status, 17, 'preserve the failing child exit code');
    assert.equal(fs.existsSync(path.join(fixture, 'unexpected-execution')), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  console.log(`ci-test-plan: ${plan.leaves.length} leaves across ${plan.groups.length} groups; coverage exact`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
