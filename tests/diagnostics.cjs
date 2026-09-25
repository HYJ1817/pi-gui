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

  const diagnostics = createDiagnostics({
    runtime,
    rpc,
    agentRegistry,
    mcp,
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
    assert.equal(snapshot.privacy.secretsRedacted, true);
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
