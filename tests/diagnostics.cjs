const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  let pass = 0;
  const ok = (name, fn) => {
    try {
      fn();
      pass += 1;
      console.log('✓', name);
    } catch (err) {
      console.error('✗', name);
      throw err;
    }
  };

  const { createDiagnostics, redactDiagnosticValue } = await import('../server/diagnostics.js');
  const { createPiCompat } = await import('../server/pi-compat.js');

  ok('递归脱敏 secret key 与 Bearer/sk token', () => {
    const v = redactDiagnosticValue({
      apiKey: 'abc',
      nested: {
        authorization: 'Bearer real-secret-token',
        note: 'Authorization: Bearer top-secret and sk-abcdefghijklmnop',
        env: 'OPENAI_API_KEY=hello-world',
      },
    });
    const text = JSON.stringify(v);
    assert.equal(v.apiKey, '[REDACTED]');
    assert.equal(v.nested.authorization, '[REDACTED]');
    assert.ok(!text.includes('real-secret-token'));
    assert.ok(!text.includes('top-secret'));
    assert.ok(!text.includes('abcdefghijklmnop'));
    assert.ok(!text.includes('hello-world'));
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-diag-'));
  const project = path.join(root, 'my-project');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(project);
  fs.mkdirSync(dataDir);

  const runtime = { getCurrentCwd: () => project };
  const rpc = {
    getState: () => ({
      piRunning: true,
      pid: 4242,
      bridgeRun: 7,
      cwd: project,
      hasProject: true,
      args: ['--mode', 'rpc', '--append-system-prompt', path.join(project, '.pi-gui', 'instructions.generated.md')],
    }),
  };
  const agentRegistry = {
    list: () => [
      {
        id: 'pi',
        available: true,
        version: '0.87.0',
        reason: null,
        detail: 'Bearer ultra-secret',
        capabilities: { toolEvents: true },
      },
      {
        id: 'codex',
        available: false,
        version: null,
        reason: 'not-installed',
        detail: 'OPENAI_API_KEY=do-not-leak',
      },
    ],
  };
  const mcp = {
    readReport: () => ({
      supported: false,
      piVersion: '0.87.0',
      evidence: path.join(os.homedir(), '.pi', 'agent', 'package.json'),
    }),
  };

  /* 兼容层（P4）：喂一套「部分兼容」的证据。
   * 里面**故意塞一个 secret 和一条绝对路径** —— 兼容报告绝不能带出它们
   * （它本来就不存 payload；这条断言是防止以后有人往异常里塞原始值）。 */
  const SECRET_VALUE = 'sk-live-should-never-appear-1234567890';
  const compat = createPiCompat({ piVersionProbe: () => '0.87.0' });
  compat.observeBridge({ state: 'ready' });
  compat.observeUpstream({
    type: 'response',
    command: 'get_state',
    success: true,
    data: { sessionFile: path.join(root, 'sess.jsonl'), sessionId: 'sid-1' },
  });
  compat.observeUpstream({ type: 'response', command: 'set_session_name', success: false, error: SECRET_VALUE });
  compat.observeUpstream({ type: 'some_future_event', payload: SECRET_VALUE });
  compat.observeSessionScan({ attempted: 1, headerOk: 1, cwdOk: 1 });

  const diagnostics = createDiagnostics({
    runtime,
    rpc,
    agentRegistry,
    mcp,
    compat,
    dataDir,
    version: '0.10.0',
    env: {
      PI_BIN: path.join(root, 'bin', 'pi.cmd'),
      PI_GUI_TOKEN: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak-either',
    },
    now: () => new Date('2026-09-26T00:00:00.000Z'),
  });

  const snapshot = diagnostics.readSnapshot();
  const serialized = JSON.stringify(snapshot);

  ok('诊断快照包含稳定 schema 与基础版本信息', () => {
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.generatedAt, '2026-09-26T00:00:00.000Z');
    assert.equal(snapshot.app.id, 'pi-gui');
    assert.equal(snapshot.app.version, '0.10.0');
    assert.equal(snapshot.bridge.piRunning, true);
    assert.equal(snapshot.bridge.bridgeRun, 7);
    assert.equal(snapshot.pi.version, '0.87.0');
  });

  ok('项目只暴露目录名，不暴露绝对路径或 PID', () => {
    assert.equal(snapshot.project.selected, true);
    assert.equal(snapshot.project.name, 'my-project');
    assert.equal(snapshot.bridge.pid, undefined);
    assert.ok(!serialized.includes(project));
    assert.ok(!serialized.includes(dataDir));
    assert.ok(!serialized.includes(os.homedir()));
    assert.ok(serialized.includes('<project>'));
  });

  ok('诊断快照不包含环境变量或 secret', () => {
    assert.ok(!serialized.includes('must-not-leak'));
    assert.ok(!serialized.includes('ultra-secret'));
    assert.ok(!serialized.includes('do-not-leak'));
    assert.equal(snapshot.privacy.environmentIncluded, false);
    assert.equal(snapshot.privacy.redactionApplied, true);
  });

  /* ---------- P4：Pi 兼容性 ---------- */

  ok('兼容性块存在，且状态与三值能力正确', () => {
    const c = snapshot.compatibility;
    assert.ok(c, '没有 compatibility 块');
    assert.equal(c.status, 'partial');
    assert.equal(c.piVersion, '0.87.0');
    assert.equal(c.versionKnown, true);
    assert.equal(c.detected, true);
    assert.equal(c.capabilities.rpc, true);
    assert.equal(c.capabilities.getState, true);
    // 明确失败过的才是 false
    assert.equal(c.capabilities.sessionNaming, false);
    // 还没用到的一律是 null（未验证 ≠ 不支持）
    assert.equal(c.capabilities.toolEvents, null);
    assert.deepEqual(c.missing, ['sessionNaming']);
    assert.ok(c.missing.indexOf('toolEvents') === -1, '未验证的能力不该进 missing');
    assert.ok(c.unverified.includes('toolEvents'));
    assert.equal(c.protocol.expected, 1);
    assert.equal(c.protocol.observed, 1);
    assert.ok(Array.isArray(c.issues) && c.issues.length > 0);
  });

  ok('兼容性异常只记结构：不带 secret、不带绝对路径、不带 payload 值', () => {
    const raw = JSON.stringify(snapshot.compatibility);
    assert.ok(!raw.includes(SECRET_VALUE), '把 secret 带进兼容报告了');
    assert.ok(!raw.includes(root), '把绝对路径带进兼容报告了');
    assert.ok(!raw.includes(os.homedir()), '把 HOME 带进兼容报告了');
    /* 钉住异常对象的**字段白名单** —— 以后谁往异常里加 payload / 原始值字段，
     * 这条会当场红。 */
    const allowed = new Set(['at', 'category', 'operation', 'issue', 'field', 'expected', 'actual']);
    for (const i of snapshot.compatibility.issues) {
      for (const k of Object.keys(i)) assert.ok(allowed.has(k), '异常里出现了计划外的字段：' + k);
    }
    // 异常里该有的是操作名与问题类型
    assert.ok(raw.includes('set_session_name') && raw.includes('command-failed'));
    assert.ok(raw.includes('some_future_event') && raw.includes('unknown-event'));
    assert.equal(snapshot.privacy.protocolPayloadsIncluded, false);
  });

  ok('未注入兼容层时该块为 null（老调用方不受影响）', () => {
    const bare = createDiagnostics({ runtime, rpc, agentRegistry, mcp, dataDir, version: '0.10.0', env: {} }).readSnapshot();
    assert.equal(bare.compatibility, null);
  });

  ok('目录健康检查是只读 access 检查', () => {
    assert.equal(snapshot.data.readable, true);
    assert.equal(snapshot.data.writable, true);
    assert.equal(snapshot.project.readable, true);
    assert.equal(snapshot.project.writable, true);
    assert.equal(snapshot.checks.find((x) => x.id === 'pi-running').ok, true);
  });

  ok('PI_BIN 只暴露 basename', () => {
    assert.equal(snapshot.pi.configuredBin, 'pi.cmd');
    assert.ok(!serialized.includes(path.join(root, 'bin')));
  });

  const noProject = createDiagnostics({
    runtime: { getCurrentCwd: () => null },
    rpc: { getState: () => ({ piRunning: false, bridgeRun: 0, hasProject: false, args: ['--mode', 'rpc'] }) },
    agentRegistry: { list: () => [] },
    mcp: { readReport: () => ({ supported: null }) },
    dataDir,
    version: '0.10.0',
  }).readSnapshot();

  ok('无项目时项目与 pi-running 检查返回不可适用', () => {
    assert.equal(noProject.project.selected, false);
    assert.equal(noProject.project.name, null);
    assert.equal(noProject.project.readable, null);
    assert.equal(noProject.project.writable, null);
    assert.equal(noProject.checks.find((x) => x.id === 'pi-running').ok, null);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`diagnostics: ${pass} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
