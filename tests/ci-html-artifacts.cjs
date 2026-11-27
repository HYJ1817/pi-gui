// Canonical registration and opt-in boundaries only: no Electron/Pi/model run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const workflowDir = path.join(root, '.github/workflows');
const planner = import('../scripts/test-group-plan.mjs');
const offlineFiles = directory => fs.readdirSync(directory)
  .filter(name => /^(?:html-artifact-.*|visual-replies-normal-samples)\.cjs$/.test(name) && !/-electron\.cjs$/.test(name))
  .map(name => 'tests/' + name).sort();

function requireCoverage(files, leaves, filesForCommand) {
  const registered = leaves.flatMap(filesForCommand);
  for (const file of files) {
    assert.equal(registered.filter(value => value === file).length, 1,
      `${file} must execute exactly once in the canonical chain`);
  }
}

async function artifactPlan() {
  const { createTestGroupPlan } = await planner;
  // This alias view is for verification, never a second executable test list.
  return createTestGroupPlan({ root, packageJson: { scripts: {
    ...packageJson.scripts, pretest: '', test: 'npm run test:html-artifacts', posttest: '',
  } } });
}

test('backend and guardian/process regressions are reachable from the canonical Artifact alias', async () => {
  const { leaves } = await artifactPlan();
  for (const name of ['backend', 'process']) {
    assert.ok(leaves.includes(`node tests/html-artifact-${name}.cjs`), `${name} regression is missing from npm test`);
  }
});

test('all discovered offline Artifact suites are registered exactly once in npm test and its Artifact alias', async () => {
  const { createTestGroupPlan, testFilesForCommand } = await planner;
  assert.equal(typeof testFilesForCommand, 'function', 'planner must inspect node --test files too');
  const files = offlineFiles(path.join(root, 'tests'));
  assert.ok(files.length > 0);
  requireCoverage(files, createTestGroupPlan({ root, packageJson }).leaves, testFilesForCommand);
  requireCoverage(files, (await artifactPlan()).leaves, testFilesForCommand);
});

test('registration guard rejects a newly added offline suite until package.json includes it', async () => {
  const { testFilesForCommand } = await planner;
  assert.equal(typeof testFilesForCommand, 'function');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-canonical-'));
  try {
    fs.writeFileSync(path.join(fixture, 'html-artifact-future.cjs'), '// synthetic offline suite\n');
    fs.writeFileSync(path.join(fixture, 'html-artifact-electron.cjs'), '// explicit desktop suite\n');
    const files = offlineFiles(fixture);
    assert.deepEqual(files, ['tests/html-artifact-future.cjs']);
    assert.throws(() => requireCoverage(files, [], testFilesForCommand), /must execute exactly once/);
    const command = 'node --test tests/html-artifact-future.cjs';
    requireCoverage(files, [command], testFilesForCommand);
    assert.throws(() => requireCoverage(files, [command, command], testFilesForCommand), /must execute exactly once/);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('normal sample regression is discovered and rejects missing or duplicate registration', async () => {
  const { testFilesForCommand } = await planner;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-normal-canonical-'));
  try {
    fs.writeFileSync(path.join(fixture, 'visual-replies-normal-samples.cjs'), '// synthetic offline suite\n');
    fs.mkdirSync(path.join(fixture, 'fixtures'));
    for (const name of ['html-artifact-d-clock.cjs', 'visual-replies-normal-samples.cjs']) {
      fs.writeFileSync(path.join(fixture, 'fixtures', name), '// helper, not a suite\n');
    }
    const files = offlineFiles(fixture);
    assert.deepEqual(files, ['tests/visual-replies-normal-samples.cjs']);
    assert.throws(() => requireCoverage(files, [], testFilesForCommand), /must execute exactly once/);
    const command = 'node --test tests/visual-replies-normal-samples.cjs';
    requireCoverage(files, [command], testFilesForCommand);
    assert.throws(() => requireCoverage(files, [command, command], testFilesForCommand), /must execute exactly once/);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('new D and normal node:test suites retain explicit --test entrypoints', async () => {
  const { createTestGroupPlan, testFilesForCommand } = await planner;
  const files = offlineFiles(path.join(root, 'tests')).filter(file =>
    /tests\/(?:html-artifact-(?:layout|frame|reading)|visual-replies-normal-samples)\.cjs$/.test(file));
  assert.equal(files.length, 4);
  for (const leaves of [createTestGroupPlan({ root, packageJson }).leaves, (await artifactPlan()).leaves]) {
    for (const file of files) {
      const commands = leaves.filter(command => testFilesForCommand(command).includes(file));
      assert.equal(commands.length, 1, `${file} must have one runner entry`);
      assert.match(commands[0], /^node --test /, `${file} must use the Node test runner`);
    }
  }
});

test('B registrations preserve node:test branches and plain Node storage entrypoints', async () => {
  const { createTestGroupPlan, testFilesForCommand, classifyTestCommand } = await planner;
  const expected = new Map([
    ['branches', 'node --test tests/html-artifact-branches.cjs'],
    ['lock', 'node tests/html-artifact-lock.cjs'],
    ['maintenance', 'node tests/html-artifact-maintenance.cjs'],
    ['performance', 'node tests/html-artifact-performance.cjs'],
  ]);
  for (const leaves of [createTestGroupPlan({ root, packageJson }).leaves, (await artifactPlan()).leaves]) {
    for (const [name, command] of expected) {
      const file = `tests/html-artifact-${name}.cjs`;
      assert.deepEqual(leaves.filter(value => testFilesForCommand(value).includes(file)), [command],
        `${file} must keep its exact runner type and execute once`);
      assert.equal(classifyTestCommand(command), 'core');
    }
  }
});

test('coverage guard accepts mixed plain Node and node:test leaves but rejects missing or duplicate files', async () => {
  const { testFilesForCommand } = await planner;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-b-canonical-'));
  try {
    fs.writeFileSync(path.join(fixture, 'html-artifact-plain.cjs'), '// synthetic plain Node suite\n');
    fs.writeFileSync(path.join(fixture, 'html-artifact-runner.cjs'), '// synthetic node:test suite\n');
    fs.mkdirSync(path.join(fixture, 'fixtures'));
    fs.writeFileSync(path.join(fixture, 'fixtures/html-artifact-branches-fixture.cjs'), '// helper, not a suite\n');
    const files = offlineFiles(fixture);
    assert.deepEqual(files, ['tests/html-artifact-plain.cjs', 'tests/html-artifact-runner.cjs']);
    const leaves = ['node tests/html-artifact-plain.cjs', 'node --test tests/html-artifact-runner.cjs'];
    requireCoverage(files, leaves, testFilesForCommand);
    for (const command of leaves) {
      assert.throws(() => requireCoverage(files, leaves.filter(value => value !== command), testFilesForCommand), /must execute exactly once/);
      assert.throws(() => requireCoverage(files, [...leaves, command], testFilesForCommand), /must execute exactly once/);
    }
    assert.deepEqual(testFilesForCommand(leaves[0] + ' tests/fixtures/html-artifact-branches-fixture.cjs'), [files[0]],
      'plain Node script arguments are not additional test suites');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('performance benchmark and baseline remain opt-in, never canonical execution', async () => {
  const { createTestGroupPlan, testFilesForCommand } = await planner;
  for (const leaves of [createTestGroupPlan({ root, packageJson }).leaves, (await artifactPlan()).leaves]) {
    for (const command of leaves) {
      assert.doesNotMatch(command, /--(?:benchmark|baseline)\b/);
    }
    assert.deepEqual(leaves.filter(command => testFilesForCommand(command).includes('tests/html-artifact-performance.cjs')),
      ['node tests/html-artifact-performance.cjs']);
    assert.ok(!leaves.flatMap(testFilesForCommand).some(file => /^tests\/fixtures\/html-artifact-/.test(file)),
      'Artifact fixtures are helpers, not standalone canonical suites');
  }
});

test('clock and normal sample helpers never execute as standalone canonical suites', async () => {
  const { createTestGroupPlan, testFilesForCommand } = await planner;
  for (const leaves of [createTestGroupPlan({ root, packageJson }).leaves, (await artifactPlan()).leaves]) {
    const files = leaves.flatMap(testFilesForCommand);
    assert.ok(!files.includes('tests/fixtures/html-artifact-d-clock.cjs'));
    assert.ok(!files.includes('tests/fixtures/visual-replies-normal-samples.cjs'));
  }
});

test('Artifact UI/security/process boundaries get intentional groups, including node --test', async () => {
  const { classifyTestCommand } = await planner;
  for (const mode of ['node ', 'node --test ']) {
    for (const name of ['ui', 'frame', 'layout', 'reading', 'viewer']) {
      assert.equal(classifyTestCommand(`${mode}tests/html-artifact-${name}.cjs`), 'ui');
    }
    assert.equal(classifyTestCommand(`${mode}tests/html-artifact-security.cjs`), 'security');
    assert.equal(classifyTestCommand(`${mode}tests/html-artifact-process.cjs`), 'faults');
    assert.equal(classifyTestCommand(`${mode}tests/html-artifact-backend.cjs`), 'core');
  }
  assert.equal(classifyTestCommand('node --test tests/future-one.cjs tests/future-two.cjs'), 'core');
  assert.equal(classifyTestCommand('node --test tests/html-artifact-ui.cjs tests/html-artifact-security.cjs'), 'core',
    'a mixed multi-file invocation stays intact on one runner');
});

test('normal sandbox security, offline Electron and live model each have separate explicit entries', () => {
  assert.equal(packageJson.scripts['test:html-artifacts:security:electron'], 'node tests/html-artifact-electron.cjs');
  assert.equal(packageJson.scripts['test:html-artifacts:electron'], 'node tests/visual-replies-electron.cjs --offline');
  assert.equal(packageJson.scripts['test:html-artifacts:live'], 'node tests/visual-replies-electron.cjs --live');
});

test('canonical contains offline driver checks but no desktop, live, contract or packaged execution', async () => {
  const { createTestGroupPlan } = await planner;
  const { leaves } = createTestGroupPlan({ root, packageJson });
  const commands = leaves.filter(command => /tests\/(?:html-artifact|visual-replies)-/.test(command));
  assert.ok(commands.includes('node tests/visual-replies-electron.cjs --check-driver'));
  assert.ok(commands.includes('node tests/visual-replies-electron.cjs --check-safety'));
  for (const command of commands) {
    assert.doesNotMatch(command, /--(?:live|offline|preflight|contract|real-pi|packaged)\b/);
    assert.doesNotMatch(command, /(?:^|\s)tests\/html-artifact-\S*electron\.cjs\b/);
    assert.doesNotMatch(command, /PI_GUI_VISUAL_REPLIES_LIVE/);
    if (command.includes('tests/visual-replies-electron.cjs')) {
      assert.match(command, /^node tests\/visual-replies-electron\.cjs --check-(?:driver|safety)$/);
    } else if (command.includes('tests/visual-replies-')) {
      assert.equal(command, 'node --test tests/visual-replies-normal-samples.cjs');
    }
  }
});

test('live without opt-in exits nonzero before any real-model work', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-html-live-opt-out-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(?:SystemRoot|WINDIR|ComSpec|PATH|PATHEXT|TEMP|TMP|TMPDIR)$/i.test(key)));
    Object.assign(env, { HOME: fixture, USERPROFILE: fixture, APPDATA: fixture, LOCALAPPDATA: fixture,
      PI_CODING_AGENT_DIR: path.join(fixture, 'agent'), PI_BIN: path.join(fixture, 'unavailable-pi'),
      PI_GUI_DATA: fixture, PI_GUI_OFFLINE: '1', PI_OFFLINE: '1' });
    const result = spawnSync(process.execPath, [path.join(root, 'tests/visual-replies-electron.cjs'), '--live'], {
      cwd: fixture, env, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 2, 'missing model authorization is not a successful or skipped feature check');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('Artifact entries never enable unsafe runtime flags or supply live authorization', () => {
  for (const [name, command] of Object.entries(packageJson.scripts).filter(([key]) => key.startsWith('test:html-artifacts'))) {
    assert.doesNotMatch(command, /--no-sandbox|--disable-web-security|--allow-running-insecure-content/i, name);
    assert.doesNotMatch(command, /PI_GUI_VISUAL_REPLIES_LIVE\s*=\s*1/, name);
  }
  for (const file of fs.readdirSync(workflowDir).filter(name => /\.ya?ml$/.test(name))) {
    const content = fs.readFileSync(path.join(workflowDir, file), 'utf8');
    assert.doesNotMatch(content, /PI_GUI_VISUAL_REPLIES_LIVE\s*[:=]\s*['"]?1/, file);
  }
});

test('desktop security workflow is manual, read-only, fail-closed and never a model/live job', () => {
  const file = path.join(workflowDir, 'visual-replies-security.yml');
  assert.ok(fs.existsSync(file), 'normal-sandbox security needs a distinct opt-in CI entry');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(content, /^\s*(?:push|pull_request|schedule|workflow_call):/m);
  assert.match(content, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(content, /(?:contents|actions|id-token): write|secrets\.|continue-on-error|--no-sandbox|--live|--disable-web-security/);
  assert.match(content, /runs-on: windows-latest/);
  assert.match(content, /persist-credentials: false/);
  assert.doesNotMatch(content.slice(0, content.indexOf('    steps:')), /\$\{\{\s*runner\./,
    'runner context is unavailable in workflow/job-level env');
  assert.match(content, /steps:\s*\n\s+- name: Prepare fresh fixture evidence directory\s*\n\s+shell: pwsh\s*\n\s+env:\s*\n\s+FIXTURE_TEMP: \$\{\{ runner\.temp \}\}\/visual-replies-security-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
    assert.ok(content.includes(`"${name}=$env:FIXTURE_TEMP" >> $env:GITHUB_ENV`),
      `persist ${name} for subsequent steps through GITHUB_ENV`);
  }
  assert.match(content, /New-Item -ItemType Directory -Path "\$env:FIXTURE_TEMP"[^\n]*-ErrorAction Stop/);
  const prepareTemp = content.indexOf('New-Item -ItemType Directory');
  for (const dependent of ['uses: actions/checkout', 'uses: actions/setup-node', 'run: npm ci', 'run: node scripts/prepare-electron-ci.mjs']) {
    assert.ok(prepareTemp < content.indexOf(dependent), `create the job TEMP before ${dependent}`);
  }
  assert.match(content, /\$\{\{ env\.TEMP \}\}\/pi-html-artifact-security-\*\/report\.json/);
  assert.doesNotMatch(content, /HTML_ARTIFACT_EVIDENCE_ROOT/, 'do not depend on an unimplemented driver API');
  assert.match(content, /NODE_VERSION: '24\.22\.1'/);
  assert.match(content, /run: npm run test:html-artifacts:security:electron/);
  assert.match(content, /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.match(content, /if-no-files-found: error/);
  assert.match(content, /retention-days: 7/);
  assert.doesNotMatch(content, /run-test-group\.mjs|name: CI gate/);
});
