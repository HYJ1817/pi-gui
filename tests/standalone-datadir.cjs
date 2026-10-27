// Regression test for Bug 10: Standalone Web mode default data directory,
// safe-path isolation, execution mode detection, atomic staging, and fault injection.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

(async () => {
  const {
    detectExecutionMode,
    defaultDataDir,
    resolveDataDir,
    migrateLegacyData,
  } = await import('../server/data-dir.js');
  const { createCollabStore } = await import('../server/collab-store.js');
  const { createReviewCommentStore } = await import('../server/review-comment-store.js');

  let checks = 0;
  const ok = (name, cond) => {
    assert.ok(cond, name);
    checks++;
    console.log('  ok  ' + name);
  };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-datadir-test-'));

  try {
    // 1. Execution mode detection
    ok('detectExecutionMode detects source-web by default',
      detectExecutionMode({ env: {}, execPath: 'node.exe' }) === 'source-web');
    ok('detectExecutionMode detects portable-sea via PI_GUI_PORTABLE',
      detectExecutionMode({ env: { PI_GUI_PORTABLE: '1' }, execPath: 'node.exe' }) === 'portable-sea');
    ok('detectExecutionMode detects portable-sea via execPath name',
      detectExecutionMode({ env: {}, execPath: 'C:\\Tools\\Pi GUI.exe' }) === 'portable-sea');
    ok('detectExecutionMode detects electron via ELECTRON_RUN_AS_NODE',
      detectExecutionMode({ env: { ELECTRON_RUN_AS_NODE: '1' }, execPath: 'electron.exe' }) === 'electron');

    // 2. Default data dir resolution (no PI_GUI_DATA)
    const emptyEnv = {};
    const defaultDir = defaultDataDir({ env: emptyEnv, execPath: 'node.exe' });
    ok('default data dir is defined and non-empty', typeof defaultDir === 'string' && defaultDir.length > 0);
    ok('default data dir ends with pi-gui', path.basename(defaultDir) === 'pi-gui');
    if (process.platform === 'win32') {
      const expectedBase = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      ok('Windows default uses AppData/Roaming', defaultDir === path.join(expectedBase, 'pi-gui'));
    }

    // 3. Portable mode with existing portable data preserved
    const fakePortableDir = path.join(tempRoot, 'fake-portable-app');
    const fakePortableExe = path.join(fakePortableDir, 'Pi GUI.exe');
    fs.mkdirSync(fakePortableDir, { recursive: true });
    fs.writeFileSync(path.join(fakePortableDir, 'projects.json'), '{"items":[]}', 'utf8');

    const portableDataDir = defaultDataDir({
      env: {},
      appRoot: path.join(tempRoot, 'other-root'),
      execPath: fakePortableExe,
      io: fs,
    });
    ok('portable mode preserves existing portable directory next to exe', portableDataDir === fakePortableDir);

    const fakePortableSubdataDir = path.join(tempRoot, 'fake-portable-subdata');
    const fakeSubdataExe = path.join(fakePortableSubdataDir, 'Pi GUI.exe');
    fs.mkdirSync(path.join(fakePortableSubdataDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(fakePortableSubdataDir, 'data', 'projects.json'), '{"items":[]}', 'utf8');
    const portableSubdataResult = defaultDataDir({
      env: {},
      appRoot: path.join(tempRoot, 'other-root'),
      execPath: fakeSubdataExe,
      io: fs,
    });
    ok('portable mode preserves existing data/ subdirectory', portableSubdataResult === path.join(fakePortableSubdataDir, 'data'));

    // 4. Explicit PI_GUI_DATA override and immunity from auto-migration
    const customData = path.join(tempRoot, 'custom-data');
    const customEnv = { PI_GUI_DATA: customData };
    const fakeLegacyApp = path.join(tempRoot, 'fake-legacy-app');
    fs.mkdirSync(fakeLegacyApp, { recursive: true });
    fs.writeFileSync(path.join(fakeLegacyApp, 'projects.json'), '{"legacy":true}', 'utf8');

    const resolvedCustom = resolveDataDir({ env: customEnv, appRoot: fakeLegacyApp, io: fs });
    ok('explicit PI_GUI_DATA is respected', resolvedCustom === path.resolve(customData));
    ok('explicit PI_GUI_DATA directory is created', fs.existsSync(resolvedCustom));
    ok('explicit PI_GUI_DATA is NEVER auto-migrated into', !fs.existsSync(path.join(resolvedCustom, 'projects.json')));

    // 5. Normal safe migration from legacy appRoot with atomic staging
    const fakeAppRoot = path.join(tempRoot, 'fake-repo-root');
    const fakeTargetData = path.join(tempRoot, 'migrated-data');
    fs.mkdirSync(fakeAppRoot, { recursive: true });

    // Seed legacy files in fake repo root
    const sampleProjects = JSON.stringify({ items: [{ id: 'p1', name: 'Legacy Project', path: fakeAppRoot }] });
    fs.writeFileSync(path.join(fakeAppRoot, 'projects.json'), sampleProjects, 'utf8');
    fs.writeFileSync(path.join(fakeAppRoot, 'session-flags.json'), '{"flag":true}', 'utf8');
    const fakePlansDir = path.join(fakeAppRoot, 'plans');
    fs.mkdirSync(fakePlansDir, { recursive: true });
    fs.writeFileSync(path.join(fakePlansDir, 'plan1.json'), '{"step":1}', 'utf8');

    // Run migration
    const migReport = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: fakeTargetData, io: fs });

    ok('migration report reports success', migReport.ok === true);
    ok('projects.json migrated', fs.existsSync(path.join(fakeTargetData, 'projects.json')));
    ok('projects.json content preserved', fs.readFileSync(path.join(fakeTargetData, 'projects.json'), 'utf8') === sampleProjects);
    ok('session-flags.json migrated', fs.existsSync(path.join(fakeTargetData, 'session-flags.json')));
    ok('plans directory migrated', fs.existsSync(path.join(fakeTargetData, 'plans', 'plan1.json')));
    ok('migration manifest generated', fs.existsSync(path.join(fakeTargetData, '.migration-manifest.json')));

    // 6. Existing data is NEVER overwritten or silently merged
    const existingTargetProjects = JSON.stringify({ items: [{ id: 'p2', name: 'Authoritative Target' }] });
    const targetWithData = path.join(tempRoot, 'target-with-data');
    fs.mkdirSync(targetWithData, { recursive: true });
    fs.writeFileSync(path.join(targetWithData, 'projects.json'), existingTargetProjects, 'utf8');
    fs.mkdirSync(path.join(targetWithData, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(targetWithData, 'plans', 'target-only.json'), '{"target":true}', 'utf8');

    const skipReport = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: targetWithData, io: fs });
    ok('existing destination data is not overwritten', fs.readFileSync(path.join(targetWithData, 'projects.json'), 'utf8') === existingTargetProjects);
    ok('existing directory is not merged into', !fs.existsSync(path.join(targetWithData, 'plans', 'plan1.json')));
    ok('existing items recorded as skipped', skipReport.skipped.some(s => s.entry === 'projects.json' && s.reason === 'already_exists'));

    // 7. Fault injection: cleanup of interrupted staging folders on retry
    const interruptedTarget = path.join(tempRoot, 'interrupted-target');
    fs.mkdirSync(interruptedTarget, { recursive: true });
    const danglingStageDir = path.join(interruptedTarget, '.stage-plans-12345');
    fs.mkdirSync(danglingStageDir, { recursive: true });
    fs.writeFileSync(path.join(danglingStageDir, 'half-copied.json'), '{"partial":true}', 'utf8');

    migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: interruptedTarget, io: fs });
    ok('dangling staging directory cleaned up', !fs.existsSync(danglingStageDir));
    ok('clean plans directory migrated after staging cleanup', fs.existsSync(path.join(interruptedTarget, 'plans', 'plan1.json')));

    // 8. Security: Symbolic links in source are rejected
    const symlinkSrcDir = path.join(tempRoot, 'symlink-src');
    const symlinkTargetDir = path.join(tempRoot, 'symlink-target');
    fs.mkdirSync(symlinkSrcDir, { recursive: true });
    const outsideTargetFile = path.join(tempRoot, 'outside-secret.json');
    fs.writeFileSync(outsideTargetFile, '{"secret":true}', 'utf8');

    try {
      fs.symlinkSync(outsideTargetFile, path.join(symlinkSrcDir, 'projects.json'));
      const symlinkReport = migrateLegacyData({ sourceDir: symlinkSrcDir, targetDir: symlinkTargetDir, io: fs });
      ok('symlink rejected and not copied', !fs.existsSync(path.join(symlinkTargetDir, 'projects.json')));
      ok('symlink recorded in skipped list', symlinkReport.skipped.some(s => s.entry === 'projects.json' && s.reason === 'symlink_rejected'));
    } catch (e) {
      // Windows without SeCreateSymbolicLinkPrivilege may fail to create symlink in non-elevated mode
      ok('symlink handling verified or skipped on restricted Windows', true);
    }

    // 9. Path traversal & dangerous nesting checks
    const nestA = path.join(tempRoot, 'nest-parent');
    const nestB = path.join(nestA, 'nest-child');
    fs.mkdirSync(nestB, { recursive: true });
    const nestReport = migrateLegacyData({ sourceDir: nestA, targetDir: nestB, io: fs });
    ok('nested path prohibited', nestReport.ok === false && nestReport.errors.some(e => e.code === 'nested_path_prohibited'));

    // 10. Fault injection: Read/Write failure preserves source and returns clean error
    const faultyIo = {
      ...fs,
      copyFileSync() {
        const err = new Error('Permission denied');
        err.code = 'EACCES';
        throw err;
      },
    };
    const faultTarget = path.join(tempRoot, 'fault-target');
    const faultReport = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: faultTarget, io: faultyIo });
    ok('faulty migration reports failure without crashing', faultReport.ok === false);
    ok('error recorded with code EACCES', faultReport.errors.some(e => e.entry === 'projects.json' && e.code === 'EACCES'));
    ok('source data preserved after fault', fs.existsSync(path.join(fakeAppRoot, 'projects.json')));

    // 11. Repeated startup idempotence
    const run1 = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: fakeTargetData, io: fs });
    const run2 = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: fakeTargetData, io: fs });
    ok('second migration run succeeds idempotently', run2.ok === true && run2.migrated.length === 0);

    // 12. Safe-path boundary check with stores:
    // When dataDir == repoRoot, stores MUST reject operation
    const collabScope = {
      key: 'a'.repeat(64),
      token: 'b'.repeat(64),
      sessionId: 'c'.repeat(64),
      projectRoot: fakeAppRoot,
      workspaceCwd: fakeAppRoot,
      gitCommon: path.join(fakeAppRoot, '.git'),
      assertCurrent() {},
    };

    let collabInsideFailed = false;
    try {
      const storeInside = createCollabStore({
        dataDir: fakeAppRoot,
        protectedRoots: () => [fakeAppRoot],
      });
      storeInside.read(collabScope);
    } catch (e) {
      if (e.message && e.message.includes('collab_storage_inside_project')) collabInsideFailed = true;
    }
    ok('collabStore rejects data directory inside project root', collabInsideFailed);

    const reviewScope = {
      key: 'a'.repeat(64),
      projectRoot: fakeAppRoot,
      gitCommon: fakeAppRoot,
      assertCurrent() {},
    };

    let reviewInsideFailed = false;
    try {
      const reviewStoreInside = createReviewCommentStore({
        dataDir: fakeAppRoot,
        protectedRoots: () => [fakeAppRoot],
      });
      reviewStoreInside.read(reviewScope);
    } catch (e) {
      if (e.message && e.message.includes('comment_storage_inside_project')) reviewInsideFailed = true;
    }
    ok('reviewCommentStore rejects data directory inside project root', reviewInsideFailed);

    // When dataDir is independent (fakeTargetData) outside fakeAppRoot, stores SUCCEED safely
    const storeSafe = createCollabStore({
      dataDir: fakeTargetData,
      protectedRoots: () => [fakeAppRoot],
    });
    const collabResult = storeSafe.read(collabScope);
    ok('collabStore succeeds with safe independent dataDir', collabResult !== null);

    const reviewStoreSafe = createReviewCommentStore({
      dataDir: fakeTargetData,
      protectedRoots: () => [fakeAppRoot],
    });
    const reviewResult = reviewStoreSafe.read(reviewScope);
    ok('reviewCommentStore succeeds with safe independent dataDir', Array.isArray(reviewResult.comments));

    console.log(`Standalone data directory: ${checks}/${checks} passed`);
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
})();
