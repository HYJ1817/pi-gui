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
const section = (text, start, end) => {
  const at = text.indexOf(start);
  const until = end ? text.indexOf(end, at + start.length) : text.length;
  assert.ok(at >= 0, `missing workflow section: ${start}`);
  return text.slice(at, until >= 0 ? until : text.length);
};
function permissionLines(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'permissions:');
  assert.ok(start >= 0, 'missing permissions block');
  const base = lines[start].match(/^\s*/)[0].length;
  const values = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= base) break;
    values.push(line.trim());
  }
  return values;
}

for (const [name, text] of Object.entries({ ci, release, releaseCheck, signpath })) {
  assert.match(text, /NODE_VERSION:\s*['"]24\.22\.1['"]/, `${name} must pin Node 24.22.1`);
  assert.doesNotMatch(text, /node-version:\s*22(?:\b|\.)|matrix:\s*\n\s+node:\s*\[22/s, `${name} still runs Node 22`);
}

assert.match(ci, /test-plan:[\s\S]*?node scripts\/run-test-group\.mjs --validate --github-output/);
assert.match(ci, /group:\s*\$\{\{\s*fromJSON\(needs\.test-plan\.outputs\.groups\)\s*\}\}/);
assert.match(ci, /fail-fast:\s*false/);
assert.match(ci, /max-parallel:\s*5/);
assert.match(ci, /node scripts\/run-test-group\.mjs --group/);
assert.match(ci, /\$tempBase = Join-Path \$env:USERPROFILE 'AppData\\Local\\Temp'/);
assert.match(ci, /TEMP=\$temp/);
assert.doesNotMatch(ci, /TEMP=\$[^\n]*RUNNER_TEMP/);
assert.match(ci, /PI_GUI_CI_RESULTS=\$results/);
const buildJob = section(ci, '  build-check:', '  ci-gate:');
assert.match(buildJob, /needs:\s*test-plan\s*\r?\n/, 'independent packaging should overlap canonical tests after plan validation');
assert.match(buildJob, /runs-on:\s*windows-latest/);
assert.doesNotMatch(buildJob, /download-artifact|needs\.test|continue-on-error|if:\s*\$\{\{/);
for (const command of ['npm ci', 'npm run fixtures', 'npm run build:app -- --rebuild', 'npm run test:app', 'npm run test:exe']) {
  assert.ok(buildJob.includes(command), `packaging proof missing ${command}`);
}
// Exercise scheduling from the actual job dependency, without sleeps, native
// fixtures or an independent production scheduler/configuration.
const buildNeeds = /^    needs: ([\w-]+)$/m.exec(buildJob)?.[1];
const buildReady = results => results[buildNeeds] === 'success';
assert.equal(buildReady({ 'test-plan': 'success', test: 'in_progress' }), true);
for (const result of ['failure', 'cancelled', 'skipped', '']) {
  assert.equal(buildReady({ 'test-plan': result, test: 'success' }), false);
}
assert.doesNotMatch(ci, /classify-doc-pr|docs-candidate|paths-ignore:|paths:\s*\[/, 'documentation classification must not reduce production CI');
for (const job of [section(ci, '  test-plan:', '  test:'), section(ci, '  test:', '  build-check:'), buildJob]) {
  assert.doesNotMatch(job, /^    if:/m, 'required job must not be conditionally skipped');
}
const gateNames = fs.readdirSync(workflowDir).filter(name => /\.ya?ml$/.test(name))
  .flatMap(name => read(name).split(/\r?\n/).filter(line => /^    name:\s*CI gate\s*$/.test(line)));
assert.equal(gateNames.length, 1, 'required CI gate name must be unique across workflows');
console.log('ci-workflow: independent build readiness 5/5; both code/docs retain full CI; gate name unique');
assert.match(ci, /ci-gate:[\s\S]*?needs:\s*\[test-plan,\s*test,\s*build-check\]/);
assert.match(ci, /ci-gate:[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/);
assert.match(ci, /PLAN_RESULT:\s*\$\{\{\s*needs\.test-plan\.result\s*\}\}/);
assert.match(ci, /TEST_RESULT:\s*\$\{\{\s*needs\.test\.result\s*\}\}/);
assert.match(ci, /BUILD_RESULT:\s*\$\{\{\s*needs\.build-check\.result\s*\}\}/);
assert.match(ci, /foreach \(\$entry in \$checks\.GetEnumerator\(\)\)[\s\S]*?if \(\$entry\.Value -ne 'success'\)/);
assert.doesNotMatch(ci, /continue-on-error:\s*true/);

assert.match(ci, /Summarize group evidence[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}[\s\S]*?summarize-ci-results\.mjs/);
assert.match(ci, /actions\/download-artifact@v8[\s\S]*?pattern: test-results-\*/);
assert.match(ci, /summarize-ci-results\.mjs[^\n]*--require-complete/);
assert.match(ci, /retention-days: 7/);
assert.doesNotMatch(ci, /paths-ignore:/);
assert.match(ci, /GITHUB_STEP_SUMMARY/);

// Execute the actual gate body; source guards alone do not prove fail-closed.
const { spawnSync } = require('node:child_process');
const gateBody = ci.slice(ci.indexOf('      - name: Require every upstream job to succeed'));
const gateScript = gateBody.slice(gateBody.indexOf('        run: |') + '        run: |'.length)
  .split('\n').map(line => line.replace(/^          /, '')).join('\n');
for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
  for (const field of ['PLAN_RESULT', 'TEST_RESULT', 'BUILD_RESULT']) {
    const env = { ...process.env, PLAN_RESULT: 'success', TEST_RESULT: 'success', BUILD_RESULT: 'success', [field]: result };
    const tested = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', gateScript], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(tested.status === 0, result === 'success', `${field}=${result}: ${tested.stderr}`);
  }
}
console.log('ci-workflow: actual gate fail-closed matrix 15/15');

assert.match(release, /npm run release:check -- --tag=.*--with-installer/);
assert.deepEqual(permissionLines(section(release, 'permissions:', 'env:')), ['contents: read'], 'workflow default must be read-only');
const verifyJob = section(release, '  verify:', '  publish:');
const publishJob = section(release, '  publish:');
assert.deepEqual(permissionLines(verifyJob), ['contents: read', 'actions: read'], 'verification must not hold write permission');
assert.deepEqual(permissionLines(publishJob), ['contents: write', 'actions: read'], 'publish job must use minimal write permission');
assert.match(release, /RELEASE_TAG:\s*\$\{\{\s*github\.ref_name\s*\}\}/);
assert.match(release, /EXPECTED_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
assert.match(release, /\$exactSha = \(git rev-parse HEAD\)\.Trim\(\)/);
assert.match(release, /npm run release:check -- --tag="\$env:RELEASE_TAG" --ci-sha="\$exactSha" --with-installer/);
assert.doesNotMatch(release, /release:check[^\n]*--skip-tests/);
assert.match(release, /GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
assert.match(release, /uses:\s*actions\/checkout@v5\s*\n\s*with:\s*\n(?:\s*#.*\n)*\s*fetch-depth:\s*1/);
assert.match(verifyJob, /persist-credentials:\s*false/);
assert.match(publishJob, /persist-credentials:\s*false/);
assert.match(verifyJob, /uses:\s*actions\/upload-artifact@v7/);
assert.match(verifyJob, /name:\s*release-dist/);
assert.match(verifyJob, /compression-level:\s*0/);
assert.match(publishJob, /needs:\s*verify/);
assert.match(publishJob, /uses:\s*actions\/download-artifact@v8/);
assert.doesNotMatch(publishJob, /npm ci\b/);
assert.doesNotMatch(publishJob, /npm run release:check/);
assert.match(publishJob, /npm run release:verify/);
assert.match(publishJob, /Re-check exact-SHA CI proof before draft[\s\S]*node scripts\/verify-ci-proof\.mjs/);
assert.match(publishJob, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
assert.match(publishJob, /GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
assert.match(publishJob, /publish-release\.mjs --tag="\$env:RELEASE_TAG" --expected-sha="\$env:EXPECTED_SHA"/);
assert.match(releaseCheck, /run:\s*npm test\b/);
assert.doesNotMatch(release, /run-test-group\.mjs/);
assert.doesNotMatch(releaseCheck, /run-test-group\.mjs/);

console.log('ci-workflow: Node pin, dynamic matrix, final CI gate, exact-SHA release proof and permissions verified');

for (const workflow of [release, releaseCheck]) {
  assert.match(workflow, /run: node scripts\/install-ci-nsis\.mjs/);
  assert.doesNotMatch(workflow, /run: choco install nsis/);
}
