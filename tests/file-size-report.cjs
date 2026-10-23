'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REPORT = path.join(ROOT, 'scripts', 'report-file-size.mjs');
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

function run(cwd, args = []) {
  return spawnSync(process.execPath, [REPORT, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function lines(count, eol = '\n') {
  return Array.from({ length: count }, (_, index) => `line-${index + 1}`).join(eol) + eol;
}

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-file-size-'));
try {
  git(fixture, 'init');
  git(fixture, 'config', 'user.email', 'fixture@example.test');
  git(fixture, 'config', 'user.name', 'File size fixture');

  write(fixture, 'server/small.js', 'const small = true;\n');
  write(fixture, 'server/no-newline.js', 'const first = 1;\nconst second = 2;');
  write(fixture, 'server/crlf.js', 'const first = 1;\r\nconst second = 2;\r\n');
  write(fixture, 'server/utf8.js', 'const 名称 = "π";\n');
  write(fixture, 'server/legacy-large.js', lines(501));
  write(fixture, 'public/中文 空格.js', 'export const 名称 = "正常";\n');
  write(fixture, 'tests/large-test.cjs', lines(1200));
  write(fixture, 'public/styles.css', lines(900));
  write(fixture, 'build/generated.js', lines(1200));
  git(fixture, 'add', '.');
  git(fixture, 'commit', '-m', 'fixture baseline');
  const baseline = git(fixture, 'rev-parse', 'HEAD');

  const before = new Map([
    'server/small.js',
    'server/no-newline.js',
    'server/crlf.js',
    'server/utf8.js',
    'server/legacy-large.js',
    'public/中文 空格.js',
    'tests/large-test.cjs',
    'public/styles.css',
    'build/generated.js',
  ].map((relative) => [relative, fs.readFileSync(path.join(fixture, relative))]));

  const first = run(fixture);
  check('ordinary report succeeds despite a historical large file', () => assert.equal(first.status, 0, first.stderr));
  check('human output reports the scanned total and soft thresholds', () => {
    assert.match(first.stdout, /Tracked files scanned: 8/);
    assert.match(first.stdout, /Over 500 lines: 1/);
    assert.match(first.stdout, /soft warnings only/i);
  });

  const initial = parseJson(run(fixture, ['--json']));
  const byPath = new Map(initial.files.map((file) => [file.path, file]));
  check('ordinary files and missing final newline use physical line counts', () => {
    assert.equal(byPath.get('server/small.js').lines, 1);
    assert.equal(byPath.get('server/no-newline.js').lines, 2);
  });
  check('CRLF and LF files have the same physical line count', () => {
    assert.equal(byPath.get('server/crlf.js').lines, 2);
    assert.equal(byPath.get('server/no-newline.js').lines, 2);
  });
  check('UTF-8 and paths containing spaces or Chinese are preserved', () => {
    assert.equal(byPath.get('server/utf8.js').lines, 1);
    assert.equal(byPath.get('public/中文 空格.js').lines, 1);
  });
  check('generated directories are excluded while tests and CSS are classified separately', () => {
    assert.equal(byPath.has('build/generated.js'), false);
    assert.equal(byPath.get('tests/large-test.cjs').category, 'test');
    assert.equal(byPath.get('public/styles.css').category, 'style');
    assert.equal(byPath.get('tests/large-test.cjs').notice, null);
    assert.equal(byPath.get('public/styles.css').notice, null);
  });
  check('historical business files warn without blocking', () => {
    const legacy = byPath.get('server/legacy-large.js');
    assert.equal(legacy.lines, 501);
    assert.equal(legacy.notice, 'check-responsibility');
    assert.equal(initial.summary.thresholds.over500, 1);
    assert.equal(initial.summary.thresholds.over800, 0);
    assert.equal(initial.summary.thresholds.over1000, 0);
  });
  check('JSON output is parseable and reports all classifications', () => {
    assert.equal(initial.summary.scannedFiles, 8);
    assert.equal(initial.summary.categories.business.files, 6);
    assert.equal(initial.summary.categories.test.files, 1);
    assert.equal(initial.summary.categories.style.files, 1);
  });

  write(fixture, 'server/new-large.mjs', lines(801));
  git(fixture, 'add', 'server/new-large.mjs');
  const compared = parseJson(run(fixture, ['--json', '--base', baseline]));
  check('a newly added large business file reports a warning and explicit growth', () => {
    const added = compared.files.find((file) => file.path === 'server/new-large.mjs');
    const legacy = compared.files.find((file) => file.path === 'server/legacy-large.js');
    assert.equal(added.lines, 801);
    assert.equal(added.baselineLines, 0);
    assert.equal(added.growth, 801);
    assert.equal(added.notice, 'split-or-explain');
    assert.equal(legacy.historic, true);
    assert.equal(legacy.baselineLines, 501);
    assert.equal(legacy.growth, 0);
    assert.equal(compared.summary.thresholds.over800, 1);
  });
  check('invalid arguments and Git failures return nonzero', () => {
    assert.notEqual(run(fixture, ['--unknown']).status, 0);
    assert.notEqual(run(fixture, ['--base']).status, 0);
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-file-size-no-git-'));
    try {
      assert.notEqual(run(noGit).status, 0);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });
  check('the report never changes tracked fixture files', () => {
    for (const [relative, expected] of before) {
      assert.deepEqual(fs.readFileSync(path.join(fixture, relative)), expected, relative);
    }
  });

  console.log(`file-size-report: ${passed}/${passed} passed`);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
