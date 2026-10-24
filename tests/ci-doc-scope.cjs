const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

let checks = 0;
const check = (name, action) => { action(); checks++; console.log(`ok ${name}`); };

async function main() {
  const { classifyDocScope, DOC_ALLOWLIST } = await import('../scripts/classify-doc-pr.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-doc-scope-中文 空格-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const write = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  };
  const commit = () => { git('add', '-A'); git('-c', 'core.hooksPath=', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD').trim(); };
  try {
    git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.autocrlf', 'false');
    for (const name of DOC_ALLOWLIST) write(name, '# Historical layout evidence\n');
    for (const name of ['AGENTS.md', 'REVIEW.md', 'README.md', 'docs/testing.md', 'docs/usage-quota.md',
      'docs/releasing.md', 'docs/security.md', 'scripts/input.md', 'tests/fixtures/input.md',
      '.github/workflows/ci.yml', 'package-lock.json', 'public/app.js']) write(name, 'fixture\n');
    const base = commit();
    const doc = DOC_ALLOWLIST[0];
    write(doc, '# Historical layout evidence\n\n说明\n');
    const docsHead = commit();
    const run = (headSha = docsHead, extra = {}) => classifyDocScope({ cwd: root, event: 'pull_request', baseSha: base, headSha, ...extra });
    check('only an exact audited document modification is a candidate, production remains full', () => {
      const result = run();
      assert.equal(result.classification, 'docs-candidate'); assert.equal(result.requiredMode, 'full');
      assert.deepEqual(result.files, [doc]); assert.equal(result.baseSha, base); assert.equal(result.headSha, docsHead);
    });
    check('main push, dispatch and unknown events always require full CI', () => {
      for (const event of ['push', 'workflow_dispatch', 'pull_request_target', '', undefined]) {
        assert.equal(run(docsHead, { event }).classification, 'full');
      }
    });
    check('empty diff is not a documentation exemption', () => assert.equal(run(base).classification, 'full'));
    check('branch names, abbreviated SHAs and option-like revisions are refused', () => {
      for (const baseSha of ['main', base.slice(0, 7), '--help', 'f'.repeat(39), null]) {
        assert.throws(() => run(docsHead, { baseSha }), /full commit SHA/);
      }
      assert.throws(() => run('f'.repeat(40)), /Git/);
    });
    check('working tree and forged labels/environment cannot change Git object scope', () => {
      write('public/app.js', 'uncommitted product edit\n');
      const prior = process.env.DOCS_ONLY; process.env.DOCS_ONLY = 'true';
      try { assert.deepEqual(run().files, [doc]); assert.equal(run().requiredMode, 'full'); }
      finally { if (prior === undefined) delete process.env.DOCS_ONLY; else process.env.DOCS_ONLY = prior; }
    });
    const mixedHead = commit();
    check('mixed code and documentation uses full CI', () => assert.equal(run(mixedHead).classification, 'full'));
    check('every allowlisted document is classified using its own Git object', () => {
      for (const name of DOC_ALLOWLIST) {
        git('read-tree', docsHead); write(name, '# Another historical explanation\n');
        git('add', '--', name); git('-c', 'core.hooksPath=', 'commit', '-qm', 'whitelist');
        const result = run(git('rev-parse', 'HEAD').trim(), { baseSha: docsHead });
        assert.equal(result.classification, 'docs-candidate'); assert.deepEqual(result.files, [name]);
      }
    });
    for (const name of ['AGENTS.md', 'REVIEW.md', 'README.md', 'docs/testing.md', 'docs/usage-quota.md',
      'docs/releasing.md', 'docs/security.md', 'scripts/input.md', 'tests/fixtures/input.md',
      '.github/workflows/ci.yml', 'package-lock.json']) {
      write(name, 'changed fixture\n');
      const head = commit();
      check(`sensitive or unknown input ${name} stays full`, () => {
        assert.equal(run(head, { baseSha: git('rev-parse', `${head}^`).trim() }).classification, 'full');
      });
    }
    const beforeRename = git('rev-parse', 'HEAD').trim();
    git('mv', doc, 'docs/中文 空格.md'); const renamed = commit();
    check('rename and Chinese/spaced unknown path require full CI', () => assert.equal(run(renamed, { baseSha: beforeRename }).classification, 'full'));
    write(doc, '# Recreated document\n'); const added = commit();
    check('added document cannot impersonate an audited modification', () => assert.equal(run(added, { baseSha: renamed }).classification, 'full'));
    fs.unlinkSync(path.join(root, doc)); const deleted = commit();
    check('deleted document requires full CI', () => assert.equal(run(deleted, { baseSha: added }).classification, 'full'));
    check('nonancestor change range fails conservatively', () => assert.equal(run(base, { baseSha: docsHead }).classification, 'full'));
    write(doc, '# restored\n'); const modeBase = commit();
    git('update-index', '--chmod=+x', doc);
    git('-c', 'core.hooksPath=', 'commit', '-qm', 'mode'); const modeHead = git('rev-parse', 'HEAD').trim();
    check('file mode changes are not prose-only', () => assert.equal(run(modeHead, { baseSha: modeBase }).classification, 'full'));
    check('symlink Git blob is refused without following its target', () => {
      // Create the Git object directly: this does not require Windows symlink privileges.
      git('read-tree', docsHead);
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '/outside/user/file', encoding: 'utf8', windowsHide: true }).trim();
      git('update-index', '--cacheinfo', `120000,${blob},${doc}`);
      git('-c', 'core.hooksPath=', 'commit', '-qm', 'symlink');
      assert.equal(run(git('rev-parse', 'HEAD').trim(), { baseSha: docsHead }).reason, 'non_allowlisted_modification');
    });
    check('NUL bytes and malformed UTF-8 are not documentation candidates', () => {
      for (const [bytes, reason] of [[Buffer.from('binary\0data'), 'binary_document'], [Buffer.from([0xff, 0xfe]), 'invalid_utf8']]) {
        git('read-tree', docsHead);
        write(doc, bytes); git('add', '--', doc);
        git('-c', 'core.hooksPath=', 'commit', '-qm', 'binary');
        const head = git('rev-parse', 'HEAD').trim();
        assert.equal(run(head, { baseSha: docsHead }).reason, reason);
      }
    });
    check('empty and oversized documents conservatively require full CI', () => {
      for (const bytes of [Buffer.alloc(0), Buffer.alloc(256 * 1024 + 1, 65)]) {
        git('read-tree', docsHead); write(doc, bytes); git('add', '--', doc);
        git('-c', 'core.hooksPath=', 'commit', '-qm', 'size');
        assert.equal(run(git('rev-parse', 'HEAD').trim(), { baseSha: docsHead }).reason, 'document_size');
      }
    });
    check('CLI emits JSON, is read-only and rejects errors rather than certifying success', () => {
      const script = path.resolve(__dirname, '../scripts/classify-doc-pr.mjs');
      const args = [script, '--event', 'pull_request', '--base', base, '--head', docsHead];
      const options = { cwd: root, encoding: 'utf8', windowsHide: true };
      const before = git('status', '--porcelain=v1', '-z');
      const result = spawnSync(process.execPath, args, options);
      assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).classification, 'docs-candidate');
      assert.equal(spawnSync(process.execPath, [...args, '--label', 'docs'], options).status, 1);
      assert.equal(spawnSync(process.execPath, [script, '--base'], options).status, 1);
      assert.equal(spawnSync(process.execPath, args, { ...options, cwd: os.tmpdir() }).status, 1);
      assert.equal(git('status', '--porcelain=v1', '-z'), before);
    });
    check('all audited allowlist entries exist as ordinary tracked files in this checkout', () => {
      const checkout = path.resolve(__dirname, '..');
      for (const name of DOC_ALLOWLIST) assert.ok(fs.lstatSync(path.join(checkout, name)).isFile());
    });
    console.log(`ci-doc-scope: ${checks}/${checks} passed`);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
