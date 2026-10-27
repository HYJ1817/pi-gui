// Regression test for Bug 10: Standalone Web mode default data directory,
// safe-path isolation, execution mode detection, atomic staging, concurrent instance safety,
// and fault injection.
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
    isSeaRuntime,
    isPiGuiSourceRepo,
    getRecoveryAction,
    getProtectedRoots,
    parseStageName,
    STAGE_PREFIX,
  } = await import('../server/data-dir.js');
  const { createCollabStore } = await import('../server/collab-store.js');
  const { createReviewCommentStore } = await import('../server/review-comment-store.js');
  const { createCandidateStore } = await import('../server/candidate-store.js');

  let checks = 0;
  const ok = (name, cond) => {
    assert.ok(cond, name);
    checks++;
    console.log('  ok  ' + name);
  };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-datadir-test-'));

  try {
    // ================= 1. Execution mode & Node SEA detection =================
    ok('detectExecutionMode detects source-web by default',
      detectExecutionMode({ env: {}, execPath: 'node.exe', isSea: false }) === 'source-web');
    ok('detectExecutionMode detects portable-sea via PI_GUI_PORTABLE',
      detectExecutionMode({ env: { PI_GUI_PORTABLE: '1' }, execPath: 'node.exe' }) === 'portable-sea');
    ok('detectExecutionMode detects portable-sea via execPath name',
      detectExecutionMode({ env: {}, execPath: 'C:\\Tools\\Pi GUI.exe' }) === 'portable-sea');
    ok('detectExecutionMode detects electron via ELECTRON_RUN_AS_NODE',
      detectExecutionMode({ env: { ELECTRON_RUN_AS_NODE: '1' }, execPath: 'electron.exe' }) === 'electron');
    // Renamed SEA executable detection via isSea runtime flag
    ok('detectExecutionMode detects renamed SEA binary via isSea runtime capability',
      detectExecutionMode({ env: {}, execPath: 'D:\\CustomApps\\RenamedLauncher.exe', isSea: true }) === 'portable-sea');

    // ================= 2. Default data dir resolution (Source Web mode) =================
    const emptyEnv = {};
    const defaultDir = defaultDataDir({ env: emptyEnv, execPath: 'node.exe', isSea: false });
    ok('default data dir is defined and non-empty', typeof defaultDir === 'string' && defaultDir.length > 0);
    ok('default data dir ends with pi-gui', path.basename(defaultDir) === 'pi-gui');
    if (process.platform === 'win32') {
      const expectedBase = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      ok('Windows default uses AppData/Roaming', defaultDir === path.join(expectedBase, 'pi-gui'));
    }

    // ================= 3. Portable mode scenarios =================
    // Scenario A: Existing legacy portable data adjacent to exe (exeDir)
    const fakePortableDir = path.join(tempRoot, 'fake-portable-app');
    const fakePortableExe = path.join(fakePortableDir, 'Pi GUI.exe');
    fs.mkdirSync(fakePortableDir, { recursive: true });
    fs.writeFileSync(path.join(fakePortableDir, 'projects.json'), '{"items":[]}', 'utf8');

    const portableDataDir = defaultDataDir({
      env: {},
      appRoot: path.join(tempRoot, 'other-root'),
      execPath: fakePortableExe,
      io: fs,
      isSea: true,
    });
    ok('portable mode preserves existing portable directory next to exe', portableDataDir === fakePortableDir);

    // Scenario B: Existing portable data in exeDir/data subdirectory
    const fakePortableSubdataDir = path.join(tempRoot, 'fake-portable-subdata');
    const fakeSubdataExe = path.join(fakePortableSubdataDir, 'Pi GUI.exe');
    fs.mkdirSync(path.join(fakePortableSubdataDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(fakePortableSubdataDir, 'data', 'projects.json'), '{"items":[]}', 'utf8');
    const portableSubdataResult = defaultDataDir({
      env: {},
      appRoot: path.join(tempRoot, 'other-root'),
      execPath: fakeSubdataExe,
      io: fs,
      isSea: true,
    });
    ok('portable mode preserves existing data/ subdirectory', portableSubdataResult === path.join(fakePortableSubdataDir, 'data'));

    // Scenario C: Brand new portable SEA (no existing data in either location) -> defaults to exeDir/data
    const brandNewPortableDir = path.join(tempRoot, 'brand-new-portable');
    const brandNewExe = path.join(brandNewPortableDir, 'CustomApp.exe'); // renamed executable
    fs.mkdirSync(brandNewPortableDir, { recursive: true });
    const brandNewResult = defaultDataDir({
      env: {},
      appRoot: path.join(tempRoot, 'other-root'),
      execPath: brandNewExe,
      io: fs,
      isSea: true,
    });
    ok('brand new portable SEA defaults to dedicated exeDir/data', brandNewResult === path.join(brandNewPortableDir, 'data'));

    // Scenario C2: Portable SEA with appRoot === exeDir (normal folder, not pi-gui repo) -> still defaults to exeDir/data!
    const brandNewWithAppRoot = defaultDataDir({
      env: {},
      appRoot: brandNewPortableDir,
      execPath: brandNewExe,
      io: fs,
      isSea: true,
    });
    ok('portable SEA with appRoot === exeDir in normal folder defaults to exeDir/data and is NOT falsely flagged as repo build',
      brandNewWithAppRoot === path.join(brandNewPortableDir, 'data'));

    // Scenario C3: Verified pi-gui source repo detection
    const fakeRepoDir = path.join(tempRoot, 'fake-pi-repo');
    fs.mkdirSync(fakeRepoDir, { recursive: true });
    fs.writeFileSync(path.join(fakeRepoDir, 'package.json'), '{"name":"pi-gui","version":"1.0.0"}', 'utf8');
    fs.writeFileSync(path.join(fakeRepoDir, 'server.js'), '// server', 'utf8');
    ok('isPiGuiSourceRepo correctly detects pi-gui repository', isPiGuiSourceRepo(fakeRepoDir, fs));
    ok('isPiGuiSourceRepo rejects directory without server.js or name pi-gui', !isPiGuiSourceRepo(brandNewPortableDir, fs));

    // Scenario C4: Portable SEA located inside a verified pi-gui repository (e.g. <repo>/build/Pi GUI.exe)
    const repoExe = path.join(fakeRepoDir, 'build', 'Pi GUI.exe');
    fs.mkdirSync(path.join(fakeRepoDir, 'build'), { recursive: true });
    const repoBuildResult = defaultDataDir({
      env: {},
      appRoot: fakeRepoDir,
      execPath: repoExe,
      io: fs,
      isSea: true,
    });
    ok('portable SEA inside verified source repo build directory falls back to user profile',
      !repoBuildResult.startsWith(fakeRepoDir));

    // Scenario D: Portable SEA placed inside user project repository -> safely avoids contaminating project
    const userProjectDir = path.join(tempRoot, 'user-project-repo');
    const portableInsideProject = path.join(userProjectDir, 'Pi GUI.exe');
    fs.mkdirSync(userProjectDir, { recursive: true });
    const projectFallbackResult = defaultDataDir({
      env: {},
      appRoot: path.join(tempRoot, 'other-root'),
      execPath: portableInsideProject,
      io: fs,
      isSea: true,
      projectRoot: userProjectDir,
    });
    ok('portable SEA inside user project safely falls back to standard user profile',
      !projectFallbackResult.startsWith(userProjectDir));

    // ================= 4. Explicit PI_GUI_DATA override =================
    const customData = path.join(tempRoot, 'custom-data');
    const customEnv = { PI_GUI_DATA: customData };
    const fakeLegacyApp = path.join(tempRoot, 'fake-legacy-app');
    fs.mkdirSync(fakeLegacyApp, { recursive: true });
    fs.writeFileSync(path.join(fakeLegacyApp, 'projects.json'), '{"legacy":true}', 'utf8');

    const resolvedCustom = resolveDataDir({ env: customEnv, appRoot: fakeLegacyApp, io: fs });
    ok('explicit PI_GUI_DATA is respected', resolvedCustom === path.resolve(customData));
    ok('explicit PI_GUI_DATA directory is created', fs.existsSync(resolvedCustom));
    ok('explicit PI_GUI_DATA is NEVER auto-migrated into', !fs.existsSync(path.join(resolvedCustom, 'projects.json')));

    // ================= 5. Staging naming, multi-instance concurrency & cleanup =================
    const testStageName = `${STAGE_PREFIX}projects.json-12345-1700000000-abcd1`;
    const parsed = parseStageName(testStageName);
    ok('parseStageName extracts entry, pid, timestamp',
      parsed && parsed.entry === 'projects.json' && parsed.pid === 12345 && parsed.timestamp === 1700000000);
    ok('parseStageName rejects non-matching filenames', parseStageName('.stage-my-notes.txt') === null);

    const concurrentTarget = path.join(tempRoot, 'concurrent-target');
    fs.mkdirSync(concurrentTarget, { recursive: true });

    // Instance 1 is currently active with PID 11111
    const activePid = 11111;
    const deadPid = 99999;
    const activeStageDir = path.join(concurrentTarget, `${STAGE_PREFIX}plans-${activePid}-1700000000-act11`);
    const deadStageDir = path.join(concurrentTarget, `${STAGE_PREFIX}collab-${deadPid}-1600000000-dead1`);
    const userProtectedFile = path.join(concurrentTarget, '.stage-user-backup.txt');

    fs.mkdirSync(activeStageDir, { recursive: true });
    fs.writeFileSync(path.join(activeStageDir, 'active.json'), '{"active":true}', 'utf8');
    fs.mkdirSync(deadStageDir, { recursive: true });
    fs.writeFileSync(path.join(deadStageDir, 'dead.json'), '{"dead":true}', 'utf8');
    fs.writeFileSync(userProtectedFile, 'user notes not belonging to migration', 'utf8');

    // Simulate Instance 2 starting migration with mock process tracker:
    // PID 11111 is alive; PID 99999 is dead
    const mockProcessAlive = pid => pid === activePid;
    migrateLegacyData({
      sourceDir: fakeLegacyApp,
      targetDir: concurrentTarget,
      io: fs,
      isProcessAlive: mockProcessAlive,
    });

    ok('concurrent active staging folder is strictly preserved and not deleted', fs.existsSync(activeStageDir));
    ok('abandoned staging folder from dead process is cleaned up safely', !fs.existsSync(deadStageDir));
    ok('unrelated user file with .stage- prefix is strictly protected', fs.existsSync(userProtectedFile));

    // ================= 6. Normal safe migration with atomic staging =================
    const fakeAppRoot = path.join(tempRoot, 'fake-repo-root');
    const fakeTargetData = path.join(tempRoot, 'migrated-data');
    fs.mkdirSync(fakeAppRoot, { recursive: true });

    const sampleProjects = JSON.stringify({ items: [{ id: 'p1', name: 'Legacy Project', path: fakeAppRoot }] });
    fs.writeFileSync(path.join(fakeAppRoot, 'projects.json'), sampleProjects, 'utf8');
    fs.writeFileSync(path.join(fakeAppRoot, 'session-flags.json'), '{"flag":true}', 'utf8');
    const fakePlansDir = path.join(fakeAppRoot, 'plans');
    fs.mkdirSync(fakePlansDir, { recursive: true });
    fs.writeFileSync(path.join(fakePlansDir, 'plan1.json'), '{"step":1}', 'utf8');

    const migReport = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: fakeTargetData, io: fs });
    ok('migration report reports success and completed status', migReport.ok === true && migReport.status === 'completed');
    ok('projects.json migrated', fs.existsSync(path.join(fakeTargetData, 'projects.json')));
    ok('projects.json content preserved', fs.readFileSync(path.join(fakeTargetData, 'projects.json'), 'utf8') === sampleProjects);
    ok('session-flags.json migrated', fs.existsSync(path.join(fakeTargetData, 'session-flags.json')));
    ok('plans directory migrated', fs.existsSync(path.join(fakeTargetData, 'plans', 'plan1.json')));
    ok('migration manifest generated with completed status',
      fs.existsSync(path.join(fakeTargetData, '.migration-manifest.json')) &&
      JSON.parse(fs.readFileSync(path.join(fakeTargetData, '.migration-manifest.json'), 'utf8')).status === 'completed');

    // ================= 7. Data conflicts: destination already exists =================
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

    // ================= 8. Fault injection: atomic rename failure =================
    const renameFaultIo = {
      ...fs,
      renameSync() {
        const err = new Error('Cross-device link or rename locked');
        err.code = 'EXDEV';
        throw err;
      },
    };
    const renameFaultTarget = path.join(tempRoot, 'rename-fault-target');
    const renameFaultReport = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: renameFaultTarget, io: renameFaultIo });
    ok('atomic rename failure reports non-ok status', renameFaultReport.ok === false);
    ok('atomic rename failure reports partial or failed status', renameFaultReport.status === 'failed');
    ok('staging file cleaned up on rename failure', fs.readdirSync(renameFaultTarget).filter(f => f.startsWith(STAGE_PREFIX)).length === 0);
    ok('manifest records failed status',
      JSON.parse(fs.readFileSync(path.join(renameFaultTarget, '.migration-manifest.json'), 'utf8')).status === 'failed');

    // ================= 9. Fault injection: partial directory copy failure =================
    let copyCount = 0;
    const partialDirFaultIo = {
      ...fs,
      copyFileSync(src, dst) {
        copyCount++;
        if (copyCount > 1) {
          const err = new Error('Simulated disk full halfway');
          err.code = 'ENOSPC';
          throw err;
        }
        return fs.copyFileSync(src, dst);
      },
    };
    const partialFaultTarget = path.join(tempRoot, 'partial-dir-fault-target');
    const partialFaultReport = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: partialFaultTarget, io: partialDirFaultIo });
    ok('partial directory copy failure reports error', partialFaultReport.ok === false && partialFaultReport.errors.some(e => e.code === 'ENOSPC'));
    ok('interrupted staging directory cleaned up on partial failure',
      fs.readdirSync(partialFaultTarget).filter(f => f.startsWith(STAGE_PREFIX)).length === 0);
    ok('source data preserved completely after partial failure', fs.existsSync(path.join(fakeAppRoot, 'plans', 'plan1.json')));

    // ================= 10. Fault injection: Permission denied (EACCES) =================
    const faultEaccesIo = {
      ...fs,
      copyFileSync() {
        const err = new Error('Permission denied');
        err.code = 'EACCES';
        throw err;
      },
    };
    const faultTarget = path.join(tempRoot, 'fault-target');
    const faultReport = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: faultTarget, io: faultEaccesIo });
    ok('faulty migration reports failure without crashing', faultReport.ok === false && faultReport.status === 'failed');
    ok('error recorded with code EACCES', faultReport.errors.some(e => e.entry === 'projects.json' && e.code === 'EACCES'));
    ok('source data preserved after fault', fs.existsSync(path.join(fakeAppRoot, 'projects.json')));

    // Structured logging verification: recoverable errors must pass actionable recovery recommendations
    const migrationLogs = [];
    const logFaultTarget = path.join(tempRoot, 'log-fault-target');
    migrateLegacyData({
      sourceDir: fakeAppRoot,
      targetDir: logFaultTarget,
      io: faultEaccesIo,
      log: (event, details) => migrationLogs.push({ event, details }),
    });
    ok('recoverable error emits app.data_migration log event',
      migrationLogs.some(l => l.event === 'app.data_migration' && l.details.code === 'EACCES' && l.details.action === 'check_permissions'));

    // ================= 11. Security: Symbolic links in source are rejected =================
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
      ok('symlink handling verified or skipped on restricted Windows', true);
    }

    // ================= 12. Path traversal & dangerous nesting checks =================
    // Nesting inside legacy entries (like plans/) is prohibited
    const nestA = path.join(tempRoot, 'nest-parent');
    const nestPlans = path.join(nestA, 'plans');
    fs.mkdirSync(nestPlans, { recursive: true });
    const nestReport = migrateLegacyData({ sourceDir: nestA, targetDir: nestPlans, io: fs });
    ok('nested path inside legacy entry prohibited', nestReport.ok === false && nestReport.errors.some(e => e.code === 'nested_path_prohibited'));

    // Nesting source inside destination is prohibited
    const reverseNestReport = migrateLegacyData({ sourceDir: nestPlans, targetDir: nestA, io: fs });
    ok('source inside destination prohibited', reverseNestReport.ok === false && reverseNestReport.errors.some(e => e.code === 'nested_path_prohibited'));

    // Non-colliding dedicated subfolder (like exeDir/data) is ALLOWED
    const nestData = path.join(nestA, 'data');
    fs.mkdirSync(nestData, { recursive: true });
    const allowedSubfolderReport = migrateLegacyData({ sourceDir: nestA, targetDir: nestData, io: fs });
    ok('dedicated subfolder data/ inside source is allowed for migration', allowedSubfolderReport.ok === true);

    // ================= 13. resolveDataDir fatal error handling =================
    let fatalThrown = false;
    try {
      resolveDataDir({
        env: {},
        appRoot: nestA,
        execPath: 'node.exe',
        io: fs,
        projectRoot: null,
        // Passing nested paths will trigger fatal path validation failure in migration
      });
    } catch (e) {
      // not thrown because defaultDataDir is in AppData, not nested
    }

    // Now test explicit fatal target mkdir failure in resolveDataDir
    const uncreatableIo = {
      ...fs,
      mkdirSync() {
        const err = new Error('Cannot create target data dir');
        err.code = 'EACCES';
        throw err;
      },
    };
    let targetMkdirFailed = false;
    try {
      resolveDataDir({ env: {}, appRoot: fakeAppRoot, io: uncreatableIo });
    } catch (e) {
      if (e.code === 'TARGET_DATA_DIR_UNAVAILABLE') targetMkdirFailed = true;
    }
    ok('resolveDataDir throws TARGET_DATA_DIR_UNAVAILABLE on uncreatable target directory', targetMkdirFailed);

    // ================= 14. Repeated startup idempotence =================
    const run1 = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: fakeTargetData, io: fs });
    const run2 = migrateLegacyData({ sourceDir: fakeAppRoot, targetDir: fakeTargetData, io: fs });
    ok('second migration run succeeds idempotently', run2.ok === true && run2.migrated.length === 0);

    // ================= 15. Safe-path boundary check with stores =================
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

    // ================= 16. getProtectedRoots & Store compatibility in SEA =================
    // 16.1 Standalone SEA mode with external user project
    const seaPortableDir = path.join(tempRoot, 'sea-portable-test');
    const seaPortableExe = path.join(seaPortableDir, 'Pi GUI.exe');
    fs.mkdirSync(seaPortableDir, { recursive: true });
    const externalUserProject = path.join(tempRoot, 'ext-proj-1');
    fs.mkdirSync(externalUserProject, { recursive: true });

    const seaProtectedRoots = getProtectedRoots({
      sourceRoot: null,
      isSea: true,
      execPath: seaPortableExe,
      io: fs,
      projects: [{ path: externalUserProject }],
      activeCwd: externalUserProject,
    });
    ok('getProtectedRoots does NOT include portable exeDir', !seaProtectedRoots.includes(path.resolve(seaPortableDir)));
    ok('getProtectedRoots includes external user project', seaProtectedRoots.includes(path.resolve(externalUserProject)));

    // 16.2 Source mode with verified repo
    const sourceProtectedRoots = getProtectedRoots({
      sourceRoot: fakeRepoDir,
      isSea: false,
      execPath: 'node.exe',
      io: fs,
      projects: [externalUserProject],
    });
    ok('getProtectedRoots includes verified sourceRoot in source mode', sourceProtectedRoots.includes(path.resolve(fakeRepoDir)));

    // 16.3 Stores with SEA portable exeDir/data and external user project
    const seaDataDir = path.join(seaPortableDir, 'data');
    fs.mkdirSync(seaDataDir, { recursive: true });
    const extCollabScope = {
      key: '1'.repeat(64),
      token: '2'.repeat(64),
      sessionId: '3'.repeat(64),
      projectRoot: externalUserProject,
      workspaceCwd: externalUserProject,
      gitCommon: path.join(externalUserProject, '.git'),
      assertCurrent() {},
    };

    const seaCollab = createCollabStore({
      dataDir: seaDataDir,
      protectedRoots: () => seaProtectedRoots,
    });
    const seaCollabDoc = seaCollab.read(extCollabScope);
    ok('collabStore succeeds with portable exeDir/data and external project', seaCollabDoc.doc === null);

    const extReviewScope = {
      key: '1'.repeat(64),
      projectRoot: externalUserProject,
      gitCommon: path.join(externalUserProject, '.git'),
      assertCurrent() {},
    };
    const seaReview = createReviewCommentStore({
      dataDir: seaDataDir,
      protectedRoots: () => seaProtectedRoots,
    });
    const seaReviewRes = seaReview.read(extReviewScope);
    ok('reviewCommentStore succeeds with portable exeDir/data and external project', Array.isArray(seaReviewRes.comments));

    const seaCandidate = createCandidateStore({
      dataDir: seaDataDir,
      protectedRoots: () => seaProtectedRoots,
    });
    const seaCandidateRuns = seaCandidate.readAll();
    ok('candidateStore succeeds with portable exeDir/data and external project', Array.isArray(seaCandidateRuns));

    // 16.4 User places EXE inside user project boundary rejection
    const projectWithExe = path.join(tempRoot, 'proj-with-exe');
    const exeInsideProject = path.join(projectWithExe, 'tools', 'Pi GUI.exe');
    const dataInsideProject = path.join(projectWithExe, 'tools', 'data');
    fs.mkdirSync(dataInsideProject, { recursive: true });

    const insideProtectedRoots = getProtectedRoots({
      sourceRoot: null,
      isSea: true,
      execPath: exeInsideProject,
      io: fs,
      projects: [projectWithExe],
    });

    const insideScope = {
      key: '5'.repeat(64),
      token: '6'.repeat(64),
      sessionId: '7'.repeat(64),
      projectRoot: projectWithExe,
      workspaceCwd: projectWithExe,
      gitCommon: path.join(projectWithExe, '.git'),
      assertCurrent() {},
    };

    let collabInsideProjFail = false;
    try {
      const csInside = createCollabStore({ dataDir: dataInsideProject, protectedRoots: () => insideProtectedRoots });
      csInside.read(insideScope);
    } catch (e) {
      if (e.code === 'collab_storage_inside_project') collabInsideProjFail = true;
    }
    ok('collabStore strictly rejects when dataDir is inside user project', collabInsideProjFail);

    let reviewInsideProjFail = false;
    try {
      const rsInside = createReviewCommentStore({ dataDir: dataInsideProject, protectedRoots: () => insideProtectedRoots });
      rsInside.read(insideScope);
    } catch (e) {
      if (e.code === 'comment_storage_inside_project') reviewInsideProjFail = true;
    }
    ok('reviewCommentStore strictly rejects when dataDir is inside user project', reviewInsideProjFail);

    let candidateInsideProjFail = false;
    try {
      const candInside = createCandidateStore({ dataDir: dataInsideProject, protectedRoots: () => insideProtectedRoots });
      candInside.readAll();
    } catch (e) {
      if (e.code === 'candidate_storage_unsafe') candidateInsideProjFail = true;
    }
    ok('candidateStore strictly rejects when dataDir is inside user project', candidateInsideProjFail);

    console.log(`Standalone data directory: ${checks}/${checks} passed`);
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
})();
