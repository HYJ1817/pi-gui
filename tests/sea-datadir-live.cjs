// Live integration verification for packaged Node SEA executable (Pi GUI.exe).
// Tests actual binary startup, directory calculation, read/write, and fault handling in isolated environments.
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');

(async () => {
  const ROOT = path.resolve(__dirname, '..');
  const BUILD_EXE = path.join(ROOT, 'build', 'Pi GUI.exe');
  if (!fs.existsSync(BUILD_EXE)) {
    console.log('Building Pi GUI.exe first...');
    execFileSync('node', ['scripts/build-exe.mjs'], { cwd: ROOT, stdio: 'inherit' });
  }
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

    console.log(`\nReal SEA packaged verification: ${checks}/${checks} passed\n`);
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
})();
