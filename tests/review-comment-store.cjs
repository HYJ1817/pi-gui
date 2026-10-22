/* T3-B: real filesystem fixtures only; no user projects or native Pi. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

let checks = 0;
function check(name, action) { action(); checks++; console.log('  ok ' + name); }
const code = expected => error => error?.code === expected && error.message === expected;
const comment = (id = randomUUID(), text = '请确认边界') => ({
  id, path: 'src/a.js', text, createdAt: 1700000000000, updatedAt: 1700000000000,
  anchor: { path: 'src/a.js', section: 'working', type: 'add', oldLine: null, newLine: 2,
    hunkIndex: 0, hunkHeader: '12345678', codeHash: 'abcdef01', diffFingerprint: '01234567' },
});

(async () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../server/review-comment-store.js')),
    'T3-B must provide the persistent comment store');
  const { createReviewCommentStore, COMMENT_STORE_LIMITS } = await import('../server/review-comment-store.js');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-comment-store-'));
  const project = path.join(world, 'project'); fs.mkdirSync(project);
  let serial = 0;
  function fixture(extra = {}) {
    const dataDir = path.join(world, 'data-' + ++serial); fs.mkdirSync(dataDir);
    const scope = { key: 'a'.repeat(64), projectRoot: project, gitCommon: project, assertCurrent() {} };
    const options = { dataDir, ...extra };
    return { dataDir, options, scope, store: createReviewCommentStore(options),
      file: path.join(dataDir, 'review-comments', scope.key + '.json') };
  }
  try {
    let f = fixture(), saved;
    check('reading an absent scope is empty without creating a storage directory', () => {
      assert.deepEqual(f.store.read(f.scope), { revision: null, comments: [] });
      assert.equal(fs.existsSync(path.dirname(f.file)), false);
    });
    check('confirmed save is readable from a new store instance', () => {
      const comments = [comment()]; saved = f.store.write(f.scope, null, comments);
      assert.equal(typeof saved.revision, 'string'); assert.equal(saved.comments[0].text, comments[0].text);
      assert.deepEqual(createReviewCommentStore(f.options).read(f.scope), saved);
    });
    check('disk format has an explicit version and contains no absolute workspace path', () => {
      const bytes = fs.readFileSync(f.file, 'utf8'), disk = JSON.parse(bytes);
      assert.equal(disk.version, 1); assert.equal(disk.scope, f.scope.key);
      assert.equal(bytes.includes(project.replace(/\\/g, '\\\\')), false);
      assert.equal('scope' in disk.comments[0], false);
    });
    check('editing survives another store restart', () => {
      const next = structuredClone(saved.comments); next[0].text = '修改后的评论'; next[0].updatedAt++;
      saved = f.store.write(f.scope, saved.revision, next);
      assert.equal(createReviewCommentStore(f.options).read(f.scope).comments[0].text, '修改后的评论');
    });
    check('deleting persists a tombstone revision and never resurrects through an old write', () => {
      const old = saved; saved = f.store.write(f.scope, old.revision, []);
      assert.notEqual(saved.revision, old.revision);
      assert.deepEqual(createReviewCommentStore(f.options).read(f.scope).comments, []);
      assert.throws(() => f.store.write(f.scope, old.revision, old.comments), code('comment_conflict'));
    });
    check('other scopes cannot see the saved records', () => {
      assert.deepEqual(f.store.read({ ...f.scope, key: 'b'.repeat(64) }).comments, []);
    });
    check('two store instances cannot silently overwrite a newer disk revision', () => {
      const other = createReviewCommentStore(f.options), before = other.read(f.scope);
      f.store.write(f.scope, saved.revision, [comment()]);
      assert.throws(() => other.write(f.scope, before.revision, []), code('comment_conflict'));
    });

    const invalid = [
      { version: 9, scope: 'a'.repeat(64), revision: randomUUID(), comments: [] },
      { version: 1, scope: 'a'.repeat(64), revision: randomUUID(), comments: [{ ...comment(), extra: 'secret' }] },
      { version: 1, scope: 'b'.repeat(64), revision: randomUUID(), comments: [] },
      { version: 1, scope: 'a'.repeat(64), revision: 4, comments: [] },
      { version: 1, scope: 'a'.repeat(64), revision: randomUUID(), comments: [comment('x', 'x'.repeat(2001))] },
      { version: 1, scope: 'a'.repeat(64), revision: randomUUID(), comments: [{ ...comment(), path: '../escape' }] },
      { version: 1, scope: 'a'.repeat(64), revision: randomUUID(), comments: [{ ...comment(), anchor: { ...comment().anchor, snippet: 'raw source' } }] },
    ];
    for (const [index, disk] of invalid.entries()) check('invalid disk ' + index + ' is preserved and blocks empty overwrite', () => {
      const bad = fixture(); fs.mkdirSync(path.dirname(bad.file)); const bytes = JSON.stringify(disk);
      fs.writeFileSync(bad.file, bytes);
      assert.throws(() => bad.store.read(bad.scope), code('comment_storage_corrupt'));
      assert.throws(() => bad.store.write(bad.scope, null, []), code('comment_storage_corrupt'));
      assert.equal(fs.readFileSync(bad.file, 'utf8'), bytes);
    });
    for (const bytes of ['{"version":1', 'null', '{"__proto__":{"polluted":true}}', ' '.repeat(COMMENT_STORE_LIMITS.fileBytes + 1)]) {
      check('truncated/malicious/oversized disk remains untouched', () => {
        const bad = fixture(); fs.mkdirSync(path.dirname(bad.file)); fs.writeFileSync(bad.file, bytes);
        assert.throws(() => bad.store.read(bad.scope));
        assert.throws(() => bad.store.write(bad.scope, null, []));
        assert.equal(fs.readFileSync(bad.file, 'utf8'), bytes);
        assert.equal({}.polluted, undefined);
      });
    }
    for (const badComment of [
      { ...comment(), path: 'C:\\outside.txt' }, { ...comment(), path: '/outside.txt' },
      { ...comment(), path: 'src/../a.js' }, { ...comment(), text: '' },
      { ...comment(), text: 'x'.repeat(2001) }, { ...comment(), createdAt: NaN },
      { ...comment(), anchor: { ...comment().anchor, type: 'invented' } },
      { ...comment(), anchor: { ...comment().anchor, section: 'other' } },
      { ...comment(), anchor: { ...comment().anchor, newLine: -1 } },
      { ...comment(), anchor: { ...comment().anchor, codeHash: '<code>' } },
      { ...comment(), anchor: { ...comment().anchor, path: 'different.js' } },
    ]) check('invalid mutation cannot alter last valid data', () => {
      const current = f.store.read(f.scope), bytes = fs.readFileSync(f.file);
      assert.throws(() => f.store.write(f.scope, current.revision, [badComment]), code('comment_invalid'));
      assert.deepEqual(fs.readFileSync(f.file), bytes);
    });
    check('duplicate ids and duplicate line positions are rejected', () => {
      const current = f.store.read(f.scope), first = comment();
      assert.throws(() => f.store.write(f.scope, current.revision, [first, first]), code('comment_invalid'));
      assert.throws(() => f.store.write(f.scope, current.revision, [first, comment()]), code('comment_invalid'));
    });
    check('scope keys cannot select arbitrary filenames', () => {
      assert.throws(() => f.store.read({ ...f.scope, key: '../projects' }), code('comment_scope_unavailable'));
    });
    check('comment capacity refuses an oversized snapshot', () => {
      const comments = Array.from({ length: 201 }, (_, i) => {
        const c = comment(); c.anchor.newLine = i + 1; return c;
      });
      assert.throws(() => f.store.write(f.scope, f.store.read(f.scope).revision, comments), code('comment_invalid'));
    });
    check('storage inside a project is refused before creating directories', () => {
      const dataDir = path.join(project, 'data'); fs.mkdirSync(dataDir);
      const store = createReviewCommentStore({ dataDir });
      assert.throws(() => store.write(f.scope, null, []), code('comment_storage_inside_project'));
      assert.equal(fs.existsSync(path.join(dataDir, 'review-comments')), false);
    });
    check('all registered project roots protect application storage', () => {
      const g = fixture(); const store = createReviewCommentStore({ ...g.options, protectedRoots: () => [world] });
      assert.throws(() => store.write(g.scope, null, []), code('comment_storage_inside_project'));
    });
    for (const errCode of ['EACCES', 'EPERM', 'ENOSPC']) check('atomic replacement failure ' + errCode + ' preserves valid file and cleans owned temp', () => {
      const g = fixture(); const before = g.store.write(g.scope, null, [comment()]);
      const bytes = fs.readFileSync(g.file);
      const io = Object.create(fs); io.renameSync = () => { throw Object.assign(Error('sensitive path'), { code: errCode }); };
      const store = createReviewCommentStore({ ...g.options, io });
      assert.throws(() => store.write(g.scope, before.revision, []), code('comment_storage_write_failed'));
      assert.deepEqual(fs.readFileSync(g.file), bytes);
      assert.deepEqual(fs.readdirSync(path.dirname(g.file)), [g.scope.key + '.json']);
    });
    check('write interruption before commit preserves the previous valid revision', () => {
      const g = fixture(); const before = g.store.write(g.scope, null, [comment()]);
      const store = createReviewCommentStore({ ...g.options, checkpoint: stage => { if (stage === 'temp-written') throw Error('interrupted'); } });
      assert.throws(() => store.write(g.scope, before.revision, []), code('comment_storage_write_failed'));
      assert.deepEqual(g.store.read(g.scope), before);
      assert.equal(fs.readdirSync(path.dirname(g.file)).length, 1);
    });
    check('exclusive transaction rejects another writer and retains abandoned locks', () => {
      const g = fixture(); fs.mkdirSync(path.dirname(g.file));
      const lock = path.join(path.dirname(g.file), '.writer.lock'); fs.writeFileSync(lock, 'abandoned');
      assert.throws(() => g.store.write(g.scope, null, []), code('comment_storage_busy'));
      assert.equal(fs.readFileSync(lock, 'utf8'), 'abandoned');
    });
    check('a stale owner cannot commit after temp data was flushed', () => {
      const g = fixture(); const before = g.store.write(g.scope, null, [comment()]); let current = true;
      const store = createReviewCommentStore({ ...g.options, checkpoint: stage => { if (stage === 'temp-written') current = false; } });
      const scope = { ...g.scope, assertCurrent() { if (!current) throw Object.assign(Error('comment_scope_unavailable'), { code: 'comment_scope_unavailable' }); } };
      assert.throws(() => store.write(scope, before.revision, []), code('comment_scope_unavailable'));
      assert.deepEqual(g.store.read(g.scope), before);
    });
    check('hardlinked data files cannot cause source code replacement', () => {
      const g = fixture(); fs.mkdirSync(path.dirname(g.file)); const source = path.join(project, 'source.txt');
      fs.writeFileSync(source, 'keep source'); fs.linkSync(source, g.file);
      assert.throws(() => g.store.write(g.scope, null, [])); assert.equal(fs.readFileSync(source, 'utf8'), 'keep source');
    });
    check('junction/symlink storage roots are rejected', () => {
      const g = fixture(), outside = path.join(world, 'outside'); fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.dirname(g.file), process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => g.store.write(g.scope, null, [])); assert.deepEqual(fs.readdirSync(outside), []);
    });
    check('a replaced storage directory does not receive old writes', () => {
      const g = fixture(); const before = g.store.write(g.scope, null, [comment()]);
      const root = path.dirname(g.file); fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
      assert.throws(() => g.store.write(g.scope, before.revision, [])); assert.deepEqual(fs.readdirSync(root), []);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root + '-original', path.basename(g.file)), 'utf8')).revision, before.revision);
    });
    check('a junction in the data-directory ancestry is refused', () => {
      const g=fixture(),linked=path.join(world,'linked-'+serial);fs.symlinkSync(g.dataDir,linked,process.platform==='win32'?'junction':'dir');
      const store=createReviewCommentStore({dataDir:linked});assert.throws(()=>store.write(g.scope,null,[]));
      assert.deepEqual(fs.readdirSync(g.dataDir),[]);
    });
    check('directory replacement after flushing cannot redirect the commit',()=>{
      const g=fixture();const before=g.store.write(g.scope,null,[comment()]);const root=path.dirname(g.file);
      // Windows normally refuses renaming a directory containing the open lock.
      // Release the injected descriptor to also exercise the post-flush identity
      // guard; production never releases its lock before commit/cleanup.
      let lockFd;
      const io={...fs,openSync(file,...args){const fd=fs.openSync(file,...args);if(path.basename(file)==='.writer.lock')lockFd=fd;return fd;}};
      const replacement=createReviewCommentStore({...g.options,io,checkpoint(){fs.closeSync(lockFd);fs.renameSync(root,root+'-moved');fs.mkdirSync(root);}});
      assert.throws(()=>replacement.write(g.scope,before.revision,[]),code('comment_storage_unsafe'));
      assert.deepEqual(fs.readdirSync(root),[]);assert.equal(JSON.parse(fs.readFileSync(path.join(root+'-moved',path.basename(g.file)),'utf8')).revision,before.revision);
    });
    check('scope capacity includes empty revision tombstones and never evicts data', () => {
      const g = fixture();
      for (let i = 0; i < COMMENT_STORE_LIMITS.scopes; i++) g.store.write({ ...g.scope, key: i.toString(16).padStart(64, '0') }, null, []);
      assert.throws(() => g.store.write(g.scope, null, []), code('comment_storage_limit'));
      assert.equal(fs.readdirSync(path.dirname(g.file)).filter(n => n.endsWith('.json')).length, 20);
    });
    check('malformed UTF-8 is corruption rather than silently rewritten replacement characters', () => {
      const g = fixture(); g.store.write(g.scope, null, [comment('utf8', 'invalid-byte-marker')]);
      const bytes = fs.readFileSync(g.file), start = bytes.indexOf('invalid-byte-marker'); bytes[start] = 0xff; fs.writeFileSync(g.file, bytes);
      assert.throws(() => g.store.read(g.scope), code('comment_storage_corrupt'));
      assert.deepEqual(fs.readFileSync(g.file), bytes);
    });
    if (process.platform === 'win32') {
      const { spawn } = require('node:child_process');
      const g = fixture(); const before = g.store.write(g.scope, null, [comment()]);
      const ready = path.join(g.dataDir, 'ready'), release = path.join(g.dataDir, 'release');
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$f=[IO.File]::Open($env:COMMENT_HELD_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try {[IO.File]::WriteAllText($env:COMMENT_READY,"ready"); while(-not [IO.File]::Exists($env:COMMENT_RELEASE)){Start-Sleep -Milliseconds 20}} finally {$f.Dispose()}'],
        { windowsHide: true, stdio: 'ignore', env: {...process.env, COMMENT_HELD_FILE:g.file, COMMENT_READY:ready, COMMENT_RELEASE:release} });
      try {
        for (let i=0;i<200&&!fs.existsSync(ready);i++) await new Promise(resolve=>setTimeout(resolve,20));
        assert.ok(fs.existsSync(ready), 'real Windows file holder is ready');
        check('real Windows occupied target refuses replacement and preserves the last commit', () => {
          assert.throws(() => g.store.write(g.scope, before.revision, []), code('comment_storage_write_failed'));
          assert.deepEqual(g.store.read(g.scope), before);
          assert.equal(fs.readdirSync(path.dirname(g.file)).some(n=>n.endsWith('.tmp')||n==='.writer.lock'),false);
        });
      } finally { fs.writeFileSync(release,'release'); await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);}); }
      check('release of the occupied file permits a subsequent confirmed write',()=>assert.equal(g.store.write(g.scope,before.revision,[]).comments.length,0));
    }
    console.log(`Review comment store: ${checks}/${checks}; skipped=${process.platform === "win32" ? 0 : 2}`);
  } finally { fs.rmSync(world, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
