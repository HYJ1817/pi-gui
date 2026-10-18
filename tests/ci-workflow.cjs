const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowDir = path.join(root, '.github/workflows');
const read = (name) => fs.readFileSync(path.join(workflowDir, name), 'utf8');
const ci = read('ci.yml');
const release = read('release.yml');
const releaseCheck = read('release-check.yml');
const signpath = read('signpath-sign.yml');

for (const [name, text] of Object.entries({ ci, release, releaseCheck, signpath })) {
  assert.match(text, /NODE_VERSION:\s*['"]24\.14\.0['"]/, `${name} must pin Node 24.14.0`);
  assert.doesNotMatch(text, /node-version:\s*22(?:\b|\.)|matrix:\s*\n\s+node:\s*\[22/s, `${name} still runs Node 22`);
}

assert.match(ci, /test-plan:[\s\S]*?node scripts\/run-test-group\.mjs --validate --github-output/);
assert.match(ci, /group:\s*\$\{\{\s*fromJSON\(needs\.test-plan\.outputs\.groups\)\s*\}\}/);
assert.match(ci, /fail-fast:\s*false/);
assert.match(ci, /max-parallel:\s*4/);
assert.match(ci, /node scripts\/run-test-group\.mjs --group/);
assert.match(ci, /build-check:[\s\S]*?needs:\s*test\b/);
assert.match(ci, /ci-gate:[\s\S]*?needs:\s*\[test-plan,\s*test,\s*build-check\]/);
assert.match(ci, /ci-gate:[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/);
assert.match(ci, /PLAN_RESULT:\s*\$\{\{\s*needs\.test-plan\.result\s*\}\}/);
assert.match(ci, /TEST_RESULT:\s*\$\{\{\s*needs\.test\.result\s*\}\}/);
assert.match(ci, /BUILD_RESULT:\s*\$\{\{\s*needs\.build-check\.result\s*\}\}/);
assert.match(ci, /foreach \(\$entry in \$checks\.GetEnumerator\(\)\)[\s\S]*?if \(\$entry\.Value -ne 'success'\)/);
assert.doesNotMatch(ci, /continue-on-error:\s*true/);

assert.match(release, /npm run release:check -- --tag=.*--with-installer/);
assert.match(releaseCheck, /run:\s*npm test\b/);
assert.doesNotMatch(release, /run-test-group\.mjs/);
assert.doesNotMatch(releaseCheck, /run-test-group\.mjs/);

console.log('ci-workflow: Node pin, dynamic matrix, build gating and final gate verified');
