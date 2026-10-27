// Regression test for Bug 10: Standalone Web mode default data directory
// and safe-path isolation.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

(async () => {
  const { defaultDataDir, resolveDataDir, migrateLegacyData } = await import('../server/data-dir.js');
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
    // 1. Default data dir resolution (no PI_GUI_DATA)
    const emptyEnv = {};
    const defaultDir = defaultDataDir(emptyEnv);
    ok('default data dir is defined and non-empty', typeof defaultDir === 'string' && defaultDir.length > 0);
    ok('default data dir ends with pi-gui', path.basename(defaultDir) === 'pi-gui');
    if (process.platform === 'win32') {
      const expectedBase = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      ok('Windows default uses AppData/Roaming', defaultDir === path.join(expectedBase, 'pi-gui'));
    }

    // 2. Explicit PI_GUI_DATA override
    const customData = path.join(tempRoot, 'custom-data');
    const customEnv = { PI_GUI_DATA: customData };
    const resolvedCustom = resolveDataDir({ env: customEnv });
    ok('explicit PI_GUI_DATA is respected', resolvedCustom === path.resolve(customData));
    ok('explicit PI_GUI_DATA directory is created', fs.existsSync(resolvedCustom));

    // 3. Migration from legacy appRoot
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
    migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: fakeTargetData });

    ok('projects.json migrated', fs.existsSync(path.join(fakeTargetData, 'projects.json')));
    ok('projects.json content preserved', fs.readFileSync(path.join(fakeTargetData, 'projects.json'), 'utf8') === sampleProjects);
    ok('session-flags.json migrated', fs.existsSync(path.join(fakeTargetData, 'session-flags.json')));
    ok('plans directory migrated', fs.existsSync(path.join(fakeTargetData, 'plans', 'plan1.json')));

    // 4. Existing data is NEVER overwritten
    const existingTargetProjects = JSON.stringify({ items: [{ id: 'p2', name: 'Authoritative Target' }] });
    const targetWithData = path.join(tempRoot, 'target-with-data');
    fs.mkdirSync(targetWithData, { recursive: true });
    fs.writeFileSync(path.join(targetWithData, 'projects.json'), existingTargetProjects, 'utf8');

    migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: targetWithData });
    ok('existing destination data is not overwritten', fs.readFileSync(path.join(targetWithData, 'projects.json'), 'utf8') === existingTargetProjects);

    // 5. Safe-path boundary check:
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
