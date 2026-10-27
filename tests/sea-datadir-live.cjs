// Live integration verification for packaged Node SEA executable (Pi GUI.exe).
// Tests actual binary startup, directory calculation, read/write, and fault handling in isolated environments.
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');

(async () => {
  const { createCollabStore } = await import('../server/collab-store.js');
  const { createReviewCommentStore } = await import('../server/review-comment-store.js');
  const { createCandidateStore } = await import('../server/candidate-store.js');
  const { createCandidateTransactions } = await import('../server/candidate-transactions.js');
  const { getProtectedRoots } = await import('../server/data-dir.js');

  const ROOT = path.resolve(__dirname, '..');
  const BUILD_EXE = path.join(ROOT, 'build', 'Pi GUI.exe');
  console.log('Building fresh Pi GUI.exe to ensure binary matches current commit...');
  execFileSync('node', ['scripts/build-exe.mjs'], { cwd: ROOT, stdio: 'inherit' });
  assert.ok(fs.existsSync(BUILD_EXE), 'Pi GUI.exe must exist in build/');

  let checks = 0;
  const ok = (name, cond) => {
    assert.ok(cond, name);
    checks++;
    console.log('  ok  ' + name);
  };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-sea-live-'));

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function killProc(proc) {
    if (!proc || proc.killed) return;
    try {
      if (process.platform === 'win32' && proc.pid) {
        execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        proc.kill('SIGKILL');
      }
    } catch {}
  }

  async function startSeaInstance(exePath, { port, env = {} } = {}) {
    const combinedEnv = {
      ...process.env,
      PORT: String(port),
      PI_GUI_OPEN: '0',
      PI_BIN: 'non-existent-pi-cmd-fixture',
      ...env,
    };

    let stdout = '';
    let stderr = '';
    let dataDir = null;
    let started = false;

    const proc = spawn(exePath, [], {
      env: combinedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    proc.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      const match = text.match(/→ 数据目录:\s*(.+)/);
      if (match) {
        dataDir = match[1].trim();
      }
      if (text.includes('Pi GUI 已启动')) {
        started = true;
      }
    });

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (started && dataDir) break;
      if (proc.exitCode !== null) break;
      await sleep(100);
    }

    if (proc.exitCode !== null && !started) {
      throw new Error(`Process exited prematurely with code ${proc.exitCode}: ${stderr || stdout}`);
    }

    return {
      proc,
      port,
      dataDir,
      stdout: () => stdout,
      stderr: () => stderr,
      close() {
        killProc(proc);
      },
    };
  }

  function httpGet(port, pathName) {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}${pathName}`, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, raw: body });
          }
        });
      });
      req.on('error', reject);
    });
  }

  function httpPost(port, pathName, payload) {
    return new Promise((resolve, reject) => {
      const dataStr = JSON.stringify(payload);
      const req = http.request(`http://127.0.0.1:${port}${pathName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr),
        },
      }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, raw: body });
          }
        });
      });
      req.on('error', reject);
      req.write(dataStr);
      req.end();
    });
  }

  try {
    // ================= Scenario 1: Brand new portable SEA =================
    console.log('\n--- Scenario 1: 全新便携版 ---');
    const freshDir = path.join(tempRoot, 'fresh-portable');
    fs.mkdirSync(freshDir, { recursive: true });
    const freshExe = path.join(freshDir, 'Pi GUI.exe');
    fs.copyFileSync(BUILD_EXE, freshExe);

    const inst1 = await startSeaInstance(freshExe, { port: 7811 });
    try {
      const expectedFreshDataDir = path.join(freshDir, 'data');
      ok('全新便携版启动成功并输出数据目录', inst1.dataDir !== null);
      ok('全新便携版默认使用 exeDir/data', path.resolve(inst1.dataDir) === path.resolve(expectedFreshDataDir));

      // Test writing project via API to confirm persistence
      const postRes = await httpPost(7811, '/api/projects', { path: freshDir, name: 'Fresh App Test' });
      ok('POST /api/projects 返回 200', postRes.status === 200 && postRes.data.ok === true);

      const savedProjectsPath = path.join(expectedFreshDataDir, 'projects.json');
      ok('数据正确持久化到 exeDir/data/projects.json', fs.existsSync(savedProjectsPath));
      const savedProjects = JSON.parse(fs.readFileSync(savedProjectsPath, 'utf8'));
      ok('projects.json 内容包含新增项目', savedProjects.items?.some(p => p.name === 'Fresh App Test'));
    } finally {
      inst1.close();
    }

    // ================= Scenario 2: Existing legacy portable data adjacent to exe (v1) =================
    console.log('\n--- Scenario 2: 同级已有 projects.json (v1 便携版) ---');
    const v1Dir = path.join(tempRoot, 'legacy-v1-portable');
    fs.mkdirSync(v1Dir, { recursive: true });
    const v1Exe = path.join(v1Dir, 'Pi GUI.exe');
    fs.copyFileSync(BUILD_EXE, v1Exe);
    fs.writeFileSync(path.join(v1Dir, 'projects.json'), JSON.stringify({
      version: 1,
      items: [{ path: v1Dir, name: 'Existing V1 Project' }],
    }), 'utf8');

    const inst2 = await startSeaInstance(v1Exe, { port: 7812 });
    try {
      ok('同级已有数据便携版启动成功', inst2.dataDir !== null);
      ok('同级已有数据保持原位置 (exeDir)', path.resolve(inst2.dataDir) === path.resolve(v1Dir));

      const getRes = await httpGet(7812, '/api/projects');
      ok('GET /api/projects 读出已有项目', getRes.data?.items?.some(p => p.name === 'Existing V1 Project'));
      ok('exeDir/data 未被意外创建为数据目录', !fs.existsSync(path.join(v1Dir, 'data', 'projects.json')));
    } finally {
      inst2.close();
    }

    // ================= Scenario 3: Existing data in data/ (v2) =================
    console.log('\n--- Scenario 3: data/ 下已有历史数据 (v2 便携版) ---');
    const v2Dir = path.join(tempRoot, 'legacy-v2-portable');
    const v2DataDir = path.join(v2Dir, 'data');
    fs.mkdirSync(v2DataDir, { recursive: true });
    const v2Exe = path.join(v2Dir, 'Pi GUI.exe');
    fs.copyFileSync(BUILD_EXE, v2Exe);
    fs.writeFileSync(path.join(v2DataDir, 'projects.json'), JSON.stringify({
      version: 1,
      items: [{ path: v2Dir, name: 'Existing V2 Project' }],
    }), 'utf8');

    const inst3 = await startSeaInstance(v2Exe, { port: 7813 });
    try {
      ok('data/ 已有数据便携版启动成功', inst3.dataDir !== null);
      ok('data/ 已有数据保持原位置 (exeDir/data)', path.resolve(inst3.dataDir) === path.resolve(v2DataDir));

      const getRes = await httpGet(7813, '/api/projects');
      ok('GET /api/projects 读出 v2 已有项目', getRes.data?.items?.some(p => p.name === 'Existing V2 Project'));
    } finally {
      inst3.close();
    }

    // ================= Scenario 4: Renamed SEA binary =================
    console.log('\n--- Scenario 4: 重命名后的 SEA ---');
    const renamedDir = path.join(tempRoot, 'renamed-portable');
    fs.mkdirSync(renamedDir, { recursive: true });
    // Completely arbitrary executable name with no 'Pi GUI' string
    const renamedExe = path.join(renamedDir, 'MyCustomStandaloneAssistant.exe');
    fs.copyFileSync(BUILD_EXE, renamedExe);

    const inst4 = await startSeaInstance(renamedExe, { port: 7814 });
    try {
      ok('重命名 SEA 启动成功', inst4.dataDir !== null);
      ok('重命名 SEA 仍能识别便携形态并使用 exeDir/data', path.resolve(inst4.dataDir) === path.resolve(path.join(renamedDir, 'data')));

      const postRes = await httpPost(7814, '/api/projects', { path: renamedDir, name: 'Renamed Assistant Project' });
      ok('重命名 SEA 写入项目成功', postRes.status === 200);
      ok('项目写入到 renamedDir/data/projects.json', fs.existsSync(path.join(renamedDir, 'data', 'projects.json')));
    } finally {
      inst4.close();
    }

    // ================= Scenario 5: Explicit PI_GUI_DATA =================
    console.log('\n--- Scenario 5: 显式 PI_GUI_DATA ---');
    const explicitHostDir = path.join(tempRoot, 'explicit-host');
    fs.mkdirSync(explicitHostDir, { recursive: true });
    const explicitExe = path.join(explicitHostDir, 'Pi GUI.exe');
    fs.copyFileSync(BUILD_EXE, explicitExe);

    const customDataDir = path.join(tempRoot, 'custom-explicit-storage');
    fs.mkdirSync(customDataDir, { recursive: true });
    fs.writeFileSync(path.join(customDataDir, 'projects.json'), JSON.stringify({
      version: 1,
      items: [{ path: explicitHostDir, name: 'Explicit Storage Project' }],
    }), 'utf8');

    const inst5 = await startSeaInstance(explicitExe, {
      port: 7815,
      env: { PI_GUI_DATA: customDataDir },
    });
    try {
      ok('显式 PI_GUI_DATA 启动成功', inst5.dataDir !== null);
      ok('显式 PI_GUI_DATA 始终优先', path.resolve(inst5.dataDir) === path.resolve(customDataDir));

      const getRes = await httpGet(7815, '/api/projects');
      ok('从显式指定目录读取 projects.json', getRes.data?.items?.some(p => p.name === 'Explicit Storage Project'));
      ok('exeDir/data 绝不被创建或污染', !fs.existsSync(path.join(explicitHostDir, 'data')));
    } finally {
      inst5.close();
    }

    // ================= Scenario 6: Fatal uncreatable target directory failure =================
    console.log('\n--- Scenario 6: 目标目录冲突/不可创建错误记录 ---');
    const blockedDir = path.join(tempRoot, 'blocked-portable');
    fs.mkdirSync(blockedDir, { recursive: true });
    const blockedExe = path.join(blockedDir, 'Pi GUI.exe');
    fs.copyFileSync(BUILD_EXE, blockedExe);

    // Create a regular file where the 'data' directory would need to be created
    fs.writeFileSync(path.join(blockedDir, 'data'), 'regular file blocking mkdirSync', 'utf8');

    let failStarted = false;
    let failErrorOutput = '';
    const failProc = spawn(blockedExe, [], {
      env: {
        ...process.env,
        PORT: '7816',
        PI_GUI_OPEN: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    failProc.stdout.on('data', chunk => { failErrorOutput += chunk.toString(); });
    failProc.stderr.on('data', chunk => { failErrorOutput += chunk.toString(); });

    const failDeadline = Date.now() + 10000;
    while (Date.now() < failDeadline) {
      if (failProc.exitCode !== null) break;
      await sleep(100);
    }
    killProc(failProc);

    ok('目标数据目录为冲突文件时启动失败退出', failProc.exitCode !== null && failProc.exitCode !== 0);
    ok('失败输出包含 TARGET_DATA_DIR_UNAVAILABLE 错误或清晰原因',
      failErrorOutput.includes('TARGET_DATA_DIR_UNAVAILABLE') || failErrorOutput.includes('Target data directory cannot be created'));
    ok('原始冲突文件未被盲目破坏', fs.readFileSync(path.join(blockedDir, 'data'), 'utf8') === 'regular file blocking mkdirSync');

    // ================= Scenario 7: Real SEA portable storage with external user project =================
    console.log('\n--- Scenario 7: 便携版 SEA 协同、评论与候选存储测试（项目在 EXE 外部） ---');
    const extStoreDir = path.join(tempRoot, 'sea-store-portable');
    fs.mkdirSync(extStoreDir, { recursive: true });
    const extStoreExe = path.join(extStoreDir, 'Pi GUI.exe');
    fs.copyFileSync(BUILD_EXE, extStoreExe);

    const extUserProject = path.join(tempRoot, 'external-sea-project');
    fs.mkdirSync(extUserProject, { recursive: true });
    fs.mkdirSync(path.join(extUserProject, '.git'), { recursive: true });

    const inst7 = await startSeaInstance(extStoreExe, { port: 7817 });
    try {
      const seaDataDir = inst7.dataDir;
      ok('便携版启动成功并分配 exeDir/data', seaDataDir === path.join(extStoreDir, 'data'));

      // Register external project
      const regRes = await httpPost(7817, '/api/projects', { path: extUserProject, name: 'External SEA Project' });
      ok('POST /api/projects 成功注册外部用户项目', regRes.status === 200 && regRes.data.ok === true);

      // Verify protectedRoots does not contain exeDir
      const roots = getProtectedRoots({
        isSea: true,
        execPath: extStoreExe,
        projects: [{ path: extUserProject }],
        activeCwd: extUserProject,
      });
      ok('getProtectedRoots 包含外部项目且不包含 exeDir', roots.includes(path.resolve(extUserProject)) && !roots.includes(path.resolve(extStoreDir)));

      // 1. Collab document write & read
      const collabScope = {
        key: 'a'.repeat(64),
        token: 'b'.repeat(64),
        sessionId: 'c'.repeat(64),
        projectRoot: extUserProject,
        workspaceCwd: extUserProject,
        gitCommon: path.join(extUserProject, '.git'),
        assertCurrent() {},
      };
      const cStore = createCollabStore({ dataDir: seaDataDir, protectedRoots: () => roots });
      const docToSave = {
        documentId: 'doc-sea-1',
        schemaVersion: 1,
        boundSessionId: collabScope.sessionId,
        revision: 1,
        title: 'SEA Collab Doc',
        graph: { nodes: [], edges: [] },
        appliedOps: [],
      };
      const savedDoc = cStore.write(collabScope, null, docToSave);
      ok('便携版协同文档写入成功', savedDoc.doc.revision === 1);
      const readDoc = cStore.read(collabScope);
      ok('便携版协同文档回读一致', readDoc.doc.title === 'SEA Collab Doc');
      ok('协同文档正确落盘在 exeDir/data/collab-documents 下', fs.existsSync(path.join(seaDataDir, 'collab-documents', collabScope.key + '.json')));

      // 2. Review comments write & read
      const reviewScope = {
        key: 'd'.repeat(64),
        token: 'e'.repeat(64),
        projectRoot: extUserProject,
        gitCommon: path.join(extUserProject, '.git'),
        assertCurrent() {},
      };
      const rStore = createReviewCommentStore({ dataDir: seaDataDir, protectedRoots: () => roots });
      const commentId = '00000000-0000-4000-8000-000000000001';
      const commentsToSave = [{
        id: commentId,
        path: 'src/a.js',
        text: 'SEA review comment test',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        anchor: {
          path: 'src/a.js',
          section: 'working',
          type: 'add',
          oldLine: null,
          newLine: 2,
          hunkIndex: 0,
          hunkHeader: '12345678',
          codeHash: 'abcdef01',
          diffFingerprint: '01234567',
        },
      }];
      const savedComments = rStore.write(reviewScope, null, commentsToSave);
      ok('便携版评论写入成功', typeof savedComments.revision === 'string');
      const readComments = rStore.read(reviewScope);
      ok('便携版评论回读一致', readComments.comments[0].text === 'SEA review comment test');
      ok('评论正确落盘在 exeDir/data/review-comments 下', fs.existsSync(path.join(seaDataDir, 'review-comments', reviewScope.key + '.json')));

      // 3. Candidate runs write & read
      const candStore = createCandidateStore({ dataDir: seaDataDir, protectedRoots: () => roots });
      candStore.acquire();
      const candRunId = '00000000-0000-4000-8000-000000000010';
      candStore.save({
        version: 1,
        run: {
          id: candRunId,
          sourceScope: 'f'.repeat(64),
          state: 'completed',
          rootIdentity: [1, 2, 3],
          gitIdentity: '0'.repeat(64),
          workspace: {
            id: '00000000-0000-4000-8000-000000000020',
            repoId: '1'.repeat(24),
            path: path.join(seaDataDir, 'worktrees', '1'.repeat(24), '00000000-0000-4000-8000-000000000020'),
          },
        },
        input: { files: [] },
        result: { files: [] },
      });
      candStore.release();
      const allCandRuns = candStore.readAll();
      ok('便携版候选任务记录写入并读取成功', allCandRuns.some(r => r.run.id === candRunId));
      ok('候选记录正确落盘在 exeDir/data/candidate-runs 下', fs.existsSync(path.join(seaDataDir, 'candidate-runs', candRunId + '.json')));

      const candTx = createCandidateTransactions({ dataDir: seaDataDir, protectedRoots: () => roots });
      const lease = candTx.acquire();
      ok('便携版候选事务顺利获取锁', lease !== null);
      lease.release();

      // 4. HTTP endpoint validation
      const candHttp = await httpGet(7817, '/api/candidate-runs');
      ok('便携版 HTTP GET /api/candidate-runs 正常响应 (409/401 权限校验拦截，非 503 存储故障)',
        candHttp.status === 409 || candHttp.status === 401);
    } finally {
      inst7.close();
    }

    // ================= Scenario 8: User places EXE inside user project directory =================
    console.log('\n--- Scenario 8: 便携版 EXE 放置于用户项目内部边界安全测试 ---');
    const insideProjectDir = path.join(tempRoot, 'inside-user-project');
    const toolsDir = path.join(insideProjectDir, 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(path.join(insideProjectDir, '.git'), { recursive: true });

    const toolsExe = path.join(toolsDir, 'Pi GUI.exe');
    fs.copyFileSync(BUILD_EXE, toolsExe);

    const insideDataDir = path.join(toolsDir, 'data');
    fs.mkdirSync(insideDataDir, { recursive: true });

    const insideRoots = getProtectedRoots({
      isSea: true,
      execPath: toolsExe,
      projects: [{ path: insideProjectDir }],
      activeCwd: insideProjectDir,
    });
    ok('getProtectedRoots 包含用户项目目录', insideRoots.includes(path.resolve(insideProjectDir)));

    const insideScope = {
      key: '2'.repeat(64),
      token: '3'.repeat(64),
      sessionId: '4'.repeat(64),
      projectRoot: insideProjectDir,
      workspaceCwd: insideProjectDir,
      gitCommon: path.join(insideProjectDir, '.git'),
      assertCurrent() {},
    };

    let collabInsideFailed = false;
    try {
      const cs = createCollabStore({ dataDir: insideDataDir, protectedRoots: () => insideRoots });
      cs.write(insideScope, null, {
        documentId: 'doc-danger',
        schemaVersion: 1,
        boundSessionId: insideScope.sessionId,
        revision: 1,
        title: 'Danger Doc',
        graph: { nodes: [], edges: [] },
        appliedOps: [],
      });
    } catch (e) {
      if (e.code === 'collab_storage_inside_project') collabInsideFailed = true;
    }
    ok('EXE 放置于项目内部时 collabStore 严格拦截拒绝 (collab_storage_inside_project)', collabInsideFailed);

    let reviewInsideFailed = false;
    try {
      const rs = createReviewCommentStore({ dataDir: insideDataDir, protectedRoots: () => insideRoots });
      rs.write(insideScope, null, []);
    } catch (e) {
      if (e.code === 'comment_storage_inside_project') reviewInsideFailed = true;
    }
    ok('EXE 放置于项目内部时 reviewCommentStore 严格拦截拒绝 (comment_storage_inside_project)', reviewInsideFailed);

    let candidateInsideFailed = false;
    try {
      const cand = createCandidateStore({ dataDir: insideDataDir, protectedRoots: () => insideRoots });
      cand.acquire();
    } catch (e) {
      if (e.code === 'candidate_storage_unsafe') candidateInsideFailed = true;
    }
    ok('EXE 放置于项目内部时 candidateStore 严格拦截拒绝 (candidate_storage_unsafe)', candidateInsideFailed);

    let txInsideFailed = false;
    try {
      const tx = createCandidateTransactions({ dataDir: insideDataDir, protectedRoots: () => insideRoots });
      tx.acquire();
    } catch (e) {
      if (e.code === 'candidate_storage_unsafe') txInsideFailed = true;
    }
    ok('EXE 放置于项目内部时 candidateTransactions 严格拦截拒绝 (candidate_storage_unsafe)', txInsideFailed);

    console.log(`\nReal SEA packaged verification: ${checks}/${checks} passed\n`);
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
})();
