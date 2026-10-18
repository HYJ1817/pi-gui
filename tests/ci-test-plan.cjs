const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

  console.log(`ci-test-plan: ${plan.leaves.length} leaves across ${plan.groups.length} groups; coverage exact`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
