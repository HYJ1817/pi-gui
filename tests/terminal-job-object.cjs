/* P3-C Job Object backend contract (local trial).
 *
 * These tests never create a shell. They use a fake node-pty surface to cover
 * capability refusal, the PID-kill boundary, lost-exit reconciliation and the
 * trailing-output path. Real ConPTY/Job evidence is produced by
 * spike/terminal-job-object/acceptance-*.mjs. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log('  ok  ' + name);
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate, timeoutMs = 3000, stepMs = 10) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick(stepMs);
  }
  return predicate();
};

async function serve({ terminal, token = 'job-object-fixture-token' }) {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const auth = createAuth({ port, token });
  server.on('request', createRouter({
    auth,
    sse: { subscribe() {} },
    rpc: { send() {}, abortAndWait() { return { ok: true }; }, getState() { return {}; }, restart() {} },
    files: { handle() { return false; } },
    terminal,
  }));
  const request = async (url, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        'x-pi-gui-token': token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, close: () => new Promise((resolve) => server.close(resolve)) };
}

function fakeJobPty() {
  const dataListeners = [];
  const exitListeners = [];
  const eofListeners = [];
  let status = {
    present: true,
    gone: false,
    final: false,
    jobMode: true,
    jobAssigned: true,
    jobState: 'active',
    treeState: 'active',
    shellExited: false,
    ptyDisposed: false,
    closeUnconfirmed: false,
    shellExitCode: 0,
    activeProcesses: 1,
  };
  let killed = 0;
  let pidKills = 0;
  const pty = {
    pid: 61001,
    jobMode: true,
    onData(fn) {
      dataListeners.push(fn);
      return { dispose() { const i = dataListeners.indexOf(fn); if (i >= 0) dataListeners.splice(i, 1); } };
    },
    onExit(fn) {
      exitListeners.push(fn);
      return { dispose() { const i = exitListeners.indexOf(fn); if (i >= 0) exitListeners.splice(i, 1); } };
    },
    onEof(fn) {
      eofListeners.push(fn);
      return { dispose() { const i = eofListeners.indexOf(fn); if (i >= 0) eofListeners.splice(i, 1); } };
    },
    write() {},
    resize() {},
    kill() { pidKills++; },
    killJob() {
      killed++;
      return { requested: true, terminateAccepted: true, final: false, jobMode: true };
    },
    jobStatus() { return { ...status }; },
    emitData(text) { for (const fn of [...dataListeners]) fn(text); },
    emitEof() { for (const fn of [...eofListeners]) fn(); },
    finish({ exitCode = 1, eof = true, close = true } = {}) {
      status = {
        ...status,
        final: close,
        shellExited: true,
        ptyDisposed: close,
        jobState: close ? 'drained' : 'draining',
        treeState: close ? 'drained' : 'draining',
        shellExitCode: exitCode,
        activeProcesses: 0,
      };
      if (eof) pty.emitEof();
      // Deliberately no exit event: this simulates a lost notification.
    },
    get killed() { return killed; },
    get pidKills() { return pidKills; },
  };
  return pty;
}

async function main() {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'p3c-job-object-'));
  const root = path.join(world, 'project');
  fs.mkdirSync(root, { recursive: true });
  const { createTerminal, TERMINAL_LIMITS } = await import('../server/terminal.js');
  const {
    resolvePtyOptions,
    defaultKillPty,
    jobObjectEnabled,
  } = await import('../server/terminal-process.js');

  await check('switch defaults off', async () => {
    assert.equal(jobObjectEnabled({}), false);
    assert.equal(jobObjectEnabled({ PI_GUI_TERMINAL_JOB_OBJECT: '0' }), false);
    assert.equal(jobObjectEnabled({ PI_GUI_TERMINAL_JOB_OBJECT: '1' }), true);
  });

  await check('off keeps the existing ConPTY options', async () => {
    const options = resolvePtyOptions({
      platform: 'win32',
      file: 'cmd.exe',
      cwd: root,
      env: {},
      cols: 80,
      rows: 24,
      nodePty: {},
      jobObject: false,
    });
    assert.equal(options.useConpty, true);
    assert.equal(options.useJobObject, undefined);
  });

  await check('on refuses before spawn when the capability is missing', async () => {
    let spawned = 0;
    const nodePty = {
      supportsJobObject: () => false,
      spawn() { spawned++; return {}; },
    };
    assert.throws(() => resolvePtyOptions({
      platform: 'win32', file: 'cmd.exe', cwd: root, env: {}, cols: 80, rows: 24,
      nodePty, jobObject: true,
    }), (error) => error.code === 'pty_job_unavailable');
    assert.equal(spawned, 0);
  });

  await check('on sets useJobObject when the capability is present', async () => {
    const options = resolvePtyOptions({
      platform: 'win32', file: 'cmd.exe', cwd: root, env: {}, cols: 80, rows: 24,
      nodePty: { supportsJobObject: () => true }, jobObject: true,
    });
    assert.equal(options.useConpty, true);
    assert.equal(options.useJobObject, true);
  });

  await check('Job kill never falls back to a PID kill', async () => {
    const pty = fakeJobPty();
    const originalKill = process.kill;
    let pidKillCalls = 0;
    process.kill = () => { pidKillCalls++; };
    try {
      const outcome = defaultKillPty(pty, 'win32');
      assert.equal(outcome.result, 'killed');
      assert.equal(outcome.job, true);
      assert.equal(pty.killed, 1);
      assert.deepEqual(defaultKillPty({ jobMode: true }, 'win32'), { result: 'failed', job: true });
      assert.equal(pidKillCalls, 0);
    } finally {
      process.kill = originalKill;
    }
  });

  const pty = fakeJobPty();
  const terminal = createTerminal({
    scopeForRequest: async () => ({ root, scopeId: 'job-fixture', generation: '1' }),
    enabled: true,
    limits: { ...TERMINAL_LIMITS, scopeSweepMs: 0, idleMs: 0 },
    spawnPty: () => pty,
    killPty: (value) => defaultKillPty(value, 'win32'),
    platform: 'win32',
    env: {},
  });
  const server = await serve({ terminal });
  try {
    const created = await server.request('/api/terminal', {
      method: 'POST',
      body: { action: 'create', cols: 80, rows: 24 },
    });
    assert.equal(created.status, 200);
    const id = created.body.session.id;
    assert.equal(created.body.session.jobMode, true);

    await check('lost exit is reconciled from native final state', async () => {
      pty.emitData('tail-marker-before-exit');
      const stopped = await server.request('/api/terminal', {
        method: 'POST',
        body: { action: 'stop', id },
      });
      assert.equal(stopped.status, 200);
      assert.equal(pty.killed, 1, 'stop must use killJob');
      assert.equal(pty.pidKills, 0, 'stop must never call the PID kill');
      // Native says shell exited and HPCON closed; no onExit is ever fired.
      pty.finish({ exitCode: 7, eof: true, close: true });
      const exited = await waitUntil(() => terminal._sessions.get(id)?.state === 'exited', 3000);
      assert.equal(exited, true, 'reconciliation must finish a running/closing session');
      const session = terminal._sessions.get(id);
      assert.equal(session.exitCode, 7);
      assert.equal(session.output.includes('tail-marker-before-exit'), true);
    });

    await check('lost EOF still finishes after the grace window', async () => {
      const pty2 = fakeJobPty();
      const terminal2 = createTerminal({
        scopeForRequest: async () => ({ root, scopeId: 'job-fixture-2', generation: '1' }),
        enabled: true,
        limits: { ...TERMINAL_LIMITS, scopeSweepMs: 0, idleMs: 0 },
        spawnPty: () => pty2,
        killPty: (value) => defaultKillPty(value, 'win32'),
        platform: 'win32',
        env: {},
      });
      const server2 = await serve({ terminal: terminal2 });
      try {
        const created2 = await server2.request('/api/terminal', {
          method: 'POST',
          body: { action: 'create', cols: 80, rows: 24 },
        });
        const id2 = created2.body.session.id;
        await server2.request('/api/terminal', { method: 'POST', body: { action: 'stop', id: id2 } });
        pty2.finish({ exitCode: 9, eof: false, close: true });
        const exited2 = await waitUntil(() => terminal2._sessions.get(id2)?.state === 'exited', 3000);
        assert.equal(exited2, true);
        assert.equal(terminal2._sessions.get(id2).exitCode, 9);
      } finally {
        await terminal2.dispose();
        await server2.close();
      }
    });

    await check('capability refusal surfaces before a session exists', async () => {
      const refused = createTerminal({
        scopeForRequest: async () => ({ root, scopeId: 'job-refused', generation: '1' }),
        enabled: true,
        limits: { ...TERMINAL_LIMITS, scopeSweepMs: 0, idleMs: 0 },
        spawnPty: () => {
          const error = new Error('terminal Job Object capability is unavailable');
          error.code = 'pty_job_unavailable';
          throw error;
        },
        killPty: () => undefined,
        platform: 'win32',
        env: {},
      });
      const server3 = await serve({ terminal: refused });
      try {
        const response = await server3.request('/api/terminal', {
          method: 'POST',
          body: { action: 'create', cols: 80, rows: 24 },
        });
        assert.equal(response.status, 503);
        assert.equal(response.body.code, 'pty_job_unavailable');
        assert.equal(refused._sessions.size, 0);
      } finally {
        await refused.dispose();
        await server3.close();
      }
    });
  } finally {
    await terminal.dispose();
    await server.close();
    fs.rmSync(world, { recursive: true, force: true });
  }

  console.log(`\n${checks} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
