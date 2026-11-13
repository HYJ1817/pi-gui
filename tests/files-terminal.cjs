/* Backend contract for the read-only Files surface and the PTY Terminal.
 * Fixtures live in os.tmpdir(); the PTY is a fake object with node-pty's
 * onData/onExit/write/resize/kill surface, so no real shell or user project is
 * touched. Real ConPTY acceptance lives in the Windows manual/packaged runs. */
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

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function serve({ files, terminal, token = 'surface-fixture-token' }) {
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
    files,
    terminal,
  }));
  const request = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'x-pi-gui-token': token, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  return { port, request, close: () => new Promise((resolve) => server.close(resolve)) };
}

function fakePty(record) {
  return (spawn) => {
    const dataListeners = [];
    const exitListeners = [];
    let exited = false;
    const pty = {
      pid: 424242 + record.length,
      cols: spawn.cols,
      rows: spawn.rows,
      writes: [],
      resizes: [],
      killed: false,
      onData(fn) {
        dataListeners.push(fn);
        return { dispose() { const i = dataListeners.indexOf(fn); if (i >= 0) dataListeners.splice(i, 1); } };
      },
      onExit(fn) {
        exitListeners.push(fn);
        return { dispose() { const i = exitListeners.indexOf(fn); if (i >= 0) exitListeners.splice(i, 1); } };
      },
      write(data) { pty.writes.push(data); },
      resize(cols, rows) {
        pty.resizes.push([cols, rows]);
        pty.cols = cols;
        pty.rows = rows;
      },
      kill() {
        if (exited) return;
        pty.killed = true;
        queueMicrotask(() => pty.emitExit(0, null));
      },
      emitData(data) { for (const fn of [...dataListeners]) fn(data); },
      emitExit(code, signal = null) {
        if (exited) return;
        exited = true;
        for (const fn of [...exitListeners]) fn({ exitCode: code, signal });
      },
    };
    record.push({ ...spawn, env: { ...spawn.env }, pty });
    return pty;
  };
}

const noSweep = (limits) => ({ ...limits, scopeSweepMs: 0 });

(async () => {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 't1-surfaces-'));
  const rootA = path.join(world, 'project-a');
  const rootB = path.join(world, 'project-b');
  const outside = path.join(world, 'outside');
  fs.mkdirSync(path.join(rootA, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  write(rootA, 'README.md', '# Project A\n');
  write(rootA, '.env', 'SECRET=1\n');
  write(rootA, 'empty.txt', '');
  write(rootA, 'src/app.js', "console.log('fixture');\n");
  write(rootA, 'src/nested/deep.txt', '深\n');
  write(rootA, 'BOM.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\n')]));
  write(rootA, 'binary.bin', Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  fs.writeFileSync(path.join(rootA, 'huge.txt'), Buffer.alloc(256 * 1024 + 1, 0x61));
  write(outside, 'secret.txt', 'outside secret\n');
  fs.symlinkSync(outside, path.join(rootA, 'escape'), 'junction');
  write(rootB, 'other.txt', 'B\n');

  const { createFiles, FILE_LIMITS } = await import('../server/files.js');
  const { createTerminal, TERMINAL_LIMITS } = await import('../server/terminal.js');
  const scopes = {
    a: { root: rootA, scopeId: 'fixture-a', generation: '1' },
    b: { root: rootB, scopeId: 'fixture-b', generation: '2' },
    none: { root: null, scopeId: 'fixture-none', generation: '3' },
  };
  const scopeFor = (req) => scopes[req.headers?.['x-pi-gui-conversation'] || 'a'];
  const files = createFiles({ scopeForRequest: async (req) => scopeFor(req) });
  const spawned = [];
  const terminal = createTerminal({
    scopeForRequest: async (req) => scopeFor(req),
    enabled: true,
    limits: noSweep(TERMINAL_LIMITS),
    spawnPty: fakePty(spawned),
    killPty: (pty) => pty.kill(),
    platform: 'fixture',
    env: {
      PATH: 'fixture',
      PI_GUI_TOKEN: 'must-not-leak',
      PI_GUI_BROWSER_BRIDGE_TOKEN: 'bridge-must-not-leak',
      PI_GUI_RUNTIME_BROWSER_TOKEN: 'runtime-must-not-leak',
      HOME: world,
    },
  });
  const app = await serve({ files, terminal });
  const scoped = (id = 'a') => ({ 'x-pi-gui-conversation': id });
  const listUrl = (dir, extra = '') => '/api/files?' + new URLSearchParams({ dir, ...extra });

  try {
    await check('Files and Terminal routes stay behind router-wide token auth', async () => {
      const bare = await fetch(`http://127.0.0.1:${app.port}/api/files`);
      assert.equal(bare.status, 401);
      const terminalBare = await fetch(`http://127.0.0.1:${app.port}/api/terminal/status`);
      assert.equal(terminalBare.status, 401);
    });

    const root = await app.request(listUrl(''), { headers: scoped() });
    await check('root listing hides dotfiles/junctions, puts directories first, and returns no absolute path', () => {
      assert.equal(root.status, 200);
      assert.equal(root.body.ok, true);
      assert.equal(root.body.workspace.generation, '1');
      assert.ok(!JSON.stringify(root.body).includes(rootA));
      assert.equal(root.body.entries[0].name, 'src');
      assert.deepEqual(root.body.entries.map((e) => e.name).sort(), ['BOM.txt', 'README.md', 'binary.bin', 'empty.txt', 'huge.txt', 'src']);
      assert.equal(root.body.entries[0].type, 'dir');
      assert.ok(!root.body.entries.some((e) => e.name === 'escape'));
      assert.ok(!root.body.entries.some((e) => e.name === '.env'));
    });
    const ws = root.body.workspace;

    const hidden = await app.request(listUrl('', { hidden: '1' }), { headers: scoped() });
    await check('hidden=1 includes dotfiles only when explicitly requested', () => {
      assert.ok(hidden.body.entries.some((e) => e.name === '.env' && e.hidden === true));
    });

    const src = await app.request(listUrl('src', { hidden: '0' }), { headers: scoped() });
    await check('directory listing is lazy and path-scoped', () => {
      assert.equal(src.status, 200);
      assert.equal(src.body.entries[0].name, 'nested');
      assert.deepEqual(src.body.entries.map((e) => e.name).sort(), ['app.js', 'nested']);
      assert.equal(src.body.entries[0].path, 'src/nested');
    });

    const escape = await app.request(listUrl('../outside'), { headers: scoped() });
    const absolute = await app.request(listUrl(path.join(world, 'outside')), { headers: scoped() });
    await check('relative and absolute escapes are rejected', () => {
      assert.equal(escape.status, 403);
      assert.equal(escape.body.code, 'unsafe_path');
      assert.equal(absolute.status, 403);
      assert.ok(!JSON.stringify(escape.body).includes('outside secret'));
    });

    const staleList = await app.request(listUrl('', { workspace: ws.id, generation: 'stale' }), { headers: scoped() });
    await check('a stale workspace token is rejected for directory reads', () => {
      assert.equal(staleList.status, 409);
      assert.equal(staleList.body.code, 'stale_workspace');
    });

    const readme = await app.request('/api/files/document?' + new URLSearchParams({ path: 'README.md', workspace: ws.id, generation: ws.generation }), { headers: scoped() });
    const bom = await app.request('/api/files/document?' + new URLSearchParams({ path: 'BOM.txt', workspace: ws.id, generation: ws.generation }), { headers: scoped() });
    const empty = await app.request('/api/files/document?' + new URLSearchParams({ path: 'empty.txt', workspace: ws.id, generation: ws.generation }), { headers: scoped() });
    await check('text preview returns UTF-8 content, strips BOM, and distinguishes empty files', () => {
      assert.equal(readme.status, 200);
      assert.equal(readme.body.file.content, '# Project A\n');
      assert.equal(readme.body.file.binary, false);
      assert.equal(bom.body.file.content, 'bom\n');
      assert.equal(empty.body.file.content, '');
    });

    const binary = await app.request('/api/files/document?' + new URLSearchParams({ path: 'binary.bin', workspace: ws.id, generation: ws.generation }), { headers: scoped() });
    const huge = await app.request('/api/files/document?' + new URLSearchParams({ path: 'huge.txt', workspace: ws.id, generation: ws.generation }), { headers: scoped() });
    await check('binary and oversized previews are reported without leaking bytes', () => {
      assert.equal(binary.status, 200);
      assert.equal(binary.body.file.binary, true);
      assert.equal(binary.body.file.content, '');
      assert.equal(huge.status, 413);
      assert.equal(huge.body.code, 'oversized');
      assert.equal(FILE_LIMITS.maxPreviewBytes, 256 * 1024);
      assert.ok(!JSON.stringify(binary.body).includes('\\u0000'));
    });

    const viaLink = await app.request('/api/files/document?' + new URLSearchParams({ path: 'escape/secret.txt', workspace: ws.id, generation: ws.generation }), { headers: scoped() });
    const missingToken = await app.request('/api/files/document?' + new URLSearchParams({ path: 'README.md' }), { headers: scoped() });
    await check('junction previews and reads without a workspace token are refused', () => {
      assert.equal(viaLink.status, 403);
      assert.equal(viaLink.body.code, 'unsafe_path');
      assert.equal(missingToken.status, 400);
      assert.equal(missingToken.body.code, 'invalid_request');
    });

    const noProject = await app.request(listUrl(''), { headers: scoped('none') });
    await check('a scope without a project returns an explicit noProject result', () => {
      assert.equal(noProject.status, 200);
      assert.equal(noProject.body.noProject, true);
      assert.equal(noProject.body.workspace, null);
    });

    const wrongMethod = await app.request('/api/files', { method: 'POST', headers: scoped(), body: {} });
    await check('the Files surface is GET-only', () => {
      assert.equal(wrongMethod.status, 405);
    });

    const status = await app.request('/api/terminal/status', { headers: scoped() });
    await check('terminal status advertises PTY, limits and the host platform', () => {
      assert.equal(status.status, 200);
      assert.equal(status.body.enabled, true);
      assert.equal(status.body.pty, true);
      assert.equal(status.body.platform, 'fixture');
      assert.equal(status.body.maxSessions, 12);
      assert.equal(status.body.maxSessionsPerWorkspace, 6);
      assert.equal(status.body.limits.maxInputBytes, 64 * 1024);
    });

    const started = await app.request('/api/terminal', {
      method: 'POST',
      headers: scoped(),
      body: {
        action: 'start', cols: 120, rows: 40,
        shell: 'evil.exe', cwd: outside, args: ['--evil'], env: { PI_GUI_TOKEN: 'leak' },
      },
    });
    await check('start uses the focused project cwd, requested size and server-owned shell', () => {
      assert.equal(started.status, 200);
      assert.equal(started.body.ok, true);
      assert.equal(started.body.reused, false);
      assert.equal(started.body.session.cwd, rootA.replace(/\\/g, '/'));
      assert.equal(started.body.session.state, 'running');
      assert.equal(started.body.session.pty, true);
      assert.equal(started.body.session.cols, 120);
      assert.equal(started.body.session.rows, 40);
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0].file, '/bin/sh');
      assert.deepEqual(spawned[0].args, []);
      assert.equal(spawned[0].cwd, fs.realpathSync.native(rootA));
      assert.equal(spawned[0].cols, 120);
      assert.equal(spawned[0].rows, 40);
      assert.equal(spawned[0].env.PI_GUI_TOKEN, undefined);
      assert.equal(spawned[0].env.PI_GUI_BROWSER_BRIDGE_TOKEN, undefined);
      assert.equal(spawned[0].env.PI_GUI_RUNTIME_BROWSER_TOKEN, undefined);
      assert.equal(spawned[0].env.TERM, 'xterm-256color');
      assert.equal(spawned[0].env.COLORTERM, 'truecolor');
      assert.equal(spawned[0].env.PATH, 'fixture');
    });
    const id = started.body.session.id;
    const fake = spawned[0];

    const reused = await app.request('/api/terminal', { method: 'POST', headers: scoped(), body: { action: 'start' } });
    await check('start reuses the running workspace session instead of spawning a second shell', () => {
      assert.equal(reused.status, 200);
      assert.equal(reused.body.reused, true);
      assert.equal(reused.body.session.id, id);
      assert.equal(spawned.length, 1);
    });

    const input = await app.request('/api/terminal', {
      method: 'POST', headers: scoped(), body: { action: 'input', id, data: 'echo 你好\r' },
    });
    await check('input is forwarded verbatim without an appended newline', () => {
      assert.equal(input.status, 200);
      assert.deepEqual(fake.pty.writes, ['echo 你好\r']);
    });

    const ctrlC = await app.request('/api/terminal', {
      method: 'POST', headers: scoped(), body: { action: 'input', id, data: '\x03' },
    });
    await check('Ctrl+C is a raw PTY byte, not a command string', () => {
      assert.equal(ctrlC.status, 200);
      assert.deepEqual(fake.pty.writes, ['echo 你好\r', '\x03']);
    });

    const raw = '\x1b[31mred\x1b[0m\r\nprogress 10%\rprogress 20%\r\n你好\r\n';
    fake.pty.emitData(raw);
    await tick();
    const firstRead = await app.request('/api/terminal?' + new URLSearchParams({ id, since: '0' }), { headers: scoped() });
    const secondRead = await app.request('/api/terminal?' + new URLSearchParams({ id, since: String(firstRead.body.cursor) }), { headers: scoped() });
    await check('reads preserve ANSI escapes, CR and Unicode, and advance an opaque cursor', () => {
      assert.equal(firstRead.status, 200);
      assert.equal(firstRead.body.text, raw);
      assert.equal(firstRead.body.cursor, raw.length);
      assert.equal(secondRead.body.text, '');
    });

    const resized = await app.request('/api/terminal', {
      method: 'POST', headers: scoped(), body: { action: 'resize', id, cols: 100, rows: 30 },
    });
    const badResize = await app.request('/api/terminal', {
      method: 'POST', headers: scoped(), body: { action: 'resize', id, cols: 0, rows: 30 },
    });
    const fractionalResize = await app.request('/api/terminal', {
      method: 'POST', headers: scoped(), body: { action: 'resize', id, cols: 100.5, rows: 30 },
    });
    await check('resize is validated and reaches the PTY only in range', () => {
      assert.equal(resized.status, 200);
      assert.deepEqual(fake.pty.resizes, [[100, 30]]);
      assert.equal(resized.body.cols, 100);
      assert.equal(resized.body.rows, 30);
      assert.equal(badResize.status, 400);
      assert.equal(badResize.body.code, 'invalid_size');
      assert.equal(fractionalResize.status, 400);
      assert.equal(fake.pty.resizes.length, 1);
    });

    const noAuthInput = await fetch(`http://127.0.0.1:${app.port}/api/terminal`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pi-gui-conversation': 'a' },
      body: JSON.stringify({ action: 'input', id, data: 'x\n' }),
    });
    const nul = await app.request('/api/terminal', { method: 'POST', headers: scoped(), body: { action: 'input', id, data: 'x\0y' } });
    const hugeInput = await app.request('/api/terminal', {
      method: 'POST', headers: scoped(), body: { action: 'input', id, data: 'x'.repeat(64 * 1024 + 1) },
    });
    await check('input rejects unauthenticated, NUL and oversized payloads', () => {
      assert.equal(noAuthInput.status, 401);
      assert.equal(nul.status, 400);
      assert.equal(nul.body.code, 'invalid_input');
      assert.equal(hugeInput.status, 400);
      assert.equal(fake.pty.writes.length, 2);
    });

    const foreignRead = await app.request('/api/terminal?' + new URLSearchParams({ id, since: '0' }), {
      headers: scoped('b'),
    });
    const foreignStop = await app.request('/api/terminal', {
      method: 'POST', headers: scoped('b'), body: { action: 'stop', id },
    });
    await check('another conversation can neither read nor stop this workspace session', () => {
      assert.equal(foreignRead.status, 409);
      assert.equal(foreignRead.body.code, 'stale_workspace');
      assert.equal(foreignStop.status, 409);
      assert.equal(foreignStop.body.code, 'stale_workspace');
      assert.equal(fake.pty.killed, false);
      assert.equal(spawned.length, 1);
    });

    scopes.a = { root: rootB, scopeId: 'fixture-b', generation: '9' };
    const wrongStop = await app.request('/api/terminal', {
      method: 'POST', headers: scoped(), body: { action: 'stop', id },
    });
    await check('stop verifies workspace identity instead of operating on a foreign session', () => {
      assert.equal(wrongStop.status, 409);
      assert.equal(wrongStop.body.code, 'stale_workspace');
      assert.equal(fake.pty.killed, true);
    });
    scopes.a = { root: rootA, scopeId: 'fixture-a', generation: '1' };

    const restarted = await app.request('/api/terminal', { method: 'POST', headers: scoped(), body: { action: 'start' } });
    await check('a new generation starts a fresh session after the stale one is stopped', () => {
      assert.equal(restarted.status, 200);
      assert.notEqual(restarted.body.session.id, id);
      assert.equal(spawned.length, 2);
    });
    const live = spawned[1];
    live.pty.emitExit(7, null);
    const exitedRead = await app.request('/api/terminal?' + new URLSearchParams({ id: restarted.body.session.id, since: '0' }), { headers: scoped() });
    await check('state follows the real PTY exit event and preserves the exit code', () => {
      assert.equal(exitedRead.status, 200);
      assert.equal(exitedRead.body.state, 'exited');
      assert.equal(exitedRead.body.exitCode, 7);
      assert.ok(exitedRead.body.text.includes('[进程已退出 (7)]'));
    });

    const restartedAgain = await app.request('/api/terminal', { method: 'POST', headers: scoped(), body: { action: 'start' } });
    const stopped = await app.request('/api/terminal', {
      method: 'POST', headers: scoped(), body: { action: 'stop', id: restartedAgain.body.session.id },
    });
    const stoppedRead = await app.request('/api/terminal?' + new URLSearchParams({ id: restartedAgain.body.session.id, since: String(restartedAgain.body.session.cursor) }), { headers: scoped() });
    await check('explicit stop reaches the injected kill path and the real exit state', () => {
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.session.state, 'closing');
      assert.equal(spawned.at(-1).pty.killed, true);
      assert.equal(stoppedRead.body.state, 'exited');
      assert.equal(stoppedRead.body.exitCode, 0);
    });

    const noProjectTerminal = await app.request('/api/terminal', { method: 'POST', headers: scoped('none'), body: { action: 'start' } });
    await check('terminal start reports noProject without spawning', () => {
      assert.equal(noProjectTerminal.status, 200);
      assert.equal(noProjectTerminal.body.noProject, true);
      assert.equal(spawned.length, 3);
    });
    await check('terminal limits keep native processes and buffers bounded', () => {
      assert.equal(TERMINAL_LIMITS.maxSessions, 12);
      assert.equal(TERMINAL_LIMITS.maxSessionsPerWorkspace, 6);
      assert.equal(TERMINAL_LIMITS.maxBufferChars, 256 * 1024);
      assert.equal(TERMINAL_LIMITS.maxInputBytes, 64 * 1024);
      assert.equal(TERMINAL_LIMITS.minCols, 20);
      assert.equal(TERMINAL_LIMITS.maxRows, 200);
    });
  } finally {
    await terminal.dispose();
    await app.close();
  }

  const disabled = createTerminal({ enabled: false, scopeForRequest: async () => scopes.a });
  const disabledApp = await serve({ terminal: disabled });
  try {
    const status = await disabledApp.request('/api/terminal/status');
    const start = await disabledApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    await check('the terminal is disabled unless the desktop/token boundary enables it', () => {
      assert.equal(status.body.enabled, false);
      assert.equal(start.status, 403);
      assert.equal(start.body.code, 'terminal_disabled');
    });
  } finally {
    await disabledApp.close();
  }

  const smallSpawned = [];
  const small = createTerminal({
    scopeForRequest: async () => ({ root: rootA, scopeId: 'small', generation: '1' }),
    enabled: true,
    limits: noSweep({ ...TERMINAL_LIMITS, maxBufferChars: 64, idleMs: 30 }),
    spawnPty: fakePty(smallSpawned),
    killPty: (pty) => pty.kill(),
    platform: 'fixture',
  });
  const smallApp = await serve({ terminal: small });
  try {
    const started = await smallApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    const flood = '0123456789'.repeat(10);
    smallSpawned[0].pty.emitData(flood);
    await tick();
    const read = await smallApp.request('/api/terminal?' + new URLSearchParams({ id: started.body.session.id, since: '0' }));
    await check('output buffers are capped and older text is marked truncated', () => {
      assert.equal(read.body.text, flood.slice(-64));
      assert.equal(read.body.truncated, true);
      assert.equal(read.body.cursor, 100);
    });
    await tick(70);
    const idle = await smallApp.request('/api/terminal?' + new URLSearchParams({ id: started.body.session.id, since: '100' }));
    await check('an idle session is stopped and says why', () => {
      assert.equal(idle.body.state, 'exited');
      assert.ok(idle.body.text.includes('空闲超时'));
      assert.equal(smallSpawned[0].pty.killed, true);
    });
  } finally {
    await small.dispose();
    await smallApp.close();
  }

  {
    /* Idle activity is server-side only: keyboard input and new PTY output
     * refresh it; read/list/resize and reused start do not. The short idleMs
     * keeps the test fast without waiting the production 30 minutes. */
    const idleSpawned = [];
    const idleTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'idle', generation: '1' }),
      /* Keep every "still running" assertion at least a few event-loop turns
       * away from the deadline; CI machines can stall well past 100 ms. */
      limits: noSweep({ ...TERMINAL_LIMITS, idleMs: 400 }),
      spawnPty: fakePty(idleSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const idleApp = await serve({ terminal: idleTerminal });
    const idleRequest = (body) => idleApp.request('/api/terminal', { method: 'POST', body });
    const idleRead = (id, since = 0) => idleApp.request('/api/terminal?' + new URLSearchParams({
      id, since: String(since),
    }));
    const idleCreate = async () => (await idleRequest({ action: 'create' })).body.session.id;
    const idleClose = async (id) => idleRequest({ action: 'close', id });
    const waitForState = async (id, state, timeout = 2000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeout) {
        const response = await idleRead(id);
        if (response.body.state === state) return response;
        await tick(10);
      }
      throw new Error(`terminal ${id} did not reach ${state}`);
    };
    try {
      const polled = await idleCreate();
      const pollStart = Date.now();
      let sawRunning = false;
      while (Date.now() - pollStart < 900) {
        const response = await idleRead(polled);
        sawRunning ||= response.body.state === 'running';
        await tick(15);
      }
      const polledEnd = await idleRead(polled);
      await check('continuous reads alone do not keep a silent terminal alive', () => {
        assert.equal(sawRunning, true);
        assert.equal(polledEnd.body.state, 'exited');
        assert.ok(polledEnd.body.text.includes('空闲超时'));
      });
      const restarted = await idleRequest({ action: 'start' });
      await check('an idle-stopped terminal stays exited but can be restarted', () => {
        assert.equal(restarted.body.ok, true);
        assert.notEqual(restarted.body.session.id, polled);
        assert.equal(restarted.body.session.state, 'running');
      });
      await idleClose(restarted.body.session.id);

      const typed = await idleCreate();
      await tick(160);
      await idleRequest({ action: 'input', id: typed, data: 'a' });
      await tick(160);
      const typedMid = await idleRead(typed);
      await tick(320);
      const typedEnd = await idleRead(typed);
      await check('real keyboard input refreshes the idle deadline', () => {
        assert.equal(typedMid.body.state, 'running');
        assert.equal(typedEnd.body.state, 'exited');
      });
      await idleClose(typed);

      const output = await idleCreate();
      await tick(160);
      idleTerminal._sessions.get(output).pty.emitData('progress');
      await tick(160);
      const outputMid = await idleRead(output);
      await tick(320);
      const outputEnd = await idleRead(output);
      await check('new PTY output refreshes the idle deadline', () => {
        assert.equal(outputMid.body.state, 'running');
        assert.equal(outputEnd.body.state, 'exited');
      });
      await idleClose(output);

      const history = await idleCreate();
      idleTerminal._sessions.get(history).pty.emitData('history-output');
      await tick(120);
      const historyStart = Date.now();
      while (Date.now() - historyStart < 520) {
        const response = await idleRead(history);
        assert.ok(response.body.text.includes('history-output'));
        await tick(15);
      }
      const historyEnd = await idleRead(history);
      await check('reading already-buffered output does not refresh idle', () => {
        assert.equal(historyEnd.body.state, 'exited');
      });
      await idleClose(history);

      const first = await idleCreate();
      const second = await idleCreate();
      await tick(300);
      await idleRequest({ action: 'input', id: first, data: 'x' });
      /* Reading first and listing the workspace must not refresh second. Wait
       * for second to expire on its own; first still has its post-input window. */
      await idleRead(first);
      await idleRequest({ action: 'list' });
      const secondEnd = await waitForState(second, 'exited');
      const firstMid = await idleRead(first);
      const firstEnd = await waitForState(first, 'exited');
      await check('terminals have independent idle clocks and observation does not reset a background one', () => {
        assert.equal(firstMid.body.state, 'running');
        assert.equal(secondEnd.body.state, 'exited');
        assert.equal(firstEnd.body.state, 'exited');
      });
      await idleClose(first);
      await idleClose(second);

      const background = await idleCreate();
      const backgroundPty = idleTerminal._sessions.get(background).pty;
      const outputTimer = setInterval(() => backgroundPty.emitData('tick'), 60);
      await tick(1000);
      clearInterval(outputTimer);
      const backgroundMid = await idleRead(background);
      await tick(600);
      const backgroundEnd = await idleRead(background);
      await check('a hidden panel does not stop a background PTY, and its output keeps it alive', () => {
        assert.equal(backgroundMid.body.state, 'running');
        assert.equal(backgroundEnd.body.state, 'exited');
      });
      await idleClose(background);

      const legacyStart = await idleRequest({ action: 'start' });
      const legacyId = legacyStart.body.session.id;
      const legacySession = idleTerminal._sessions.get(legacyId);
      const legacyActivity = legacySession.lastActivityAt;
      const legacyStartAt = Date.now();
      while (Date.now() - legacyStartAt < 240) {
        await idleRequest({ action: 'start' });
        await tick(20);
      }
      await tick(300);
      const legacyEnd = await idleRead(legacyId);
      await check('reusing a live session through start does not refresh idle', () => {
        assert.equal(legacySession.lastActivityAt, legacyActivity);
        assert.equal(legacyEnd.body.state, 'exited');
      });
      await idleClose(legacyId);

      const resizedId = await idleCreate();
      const resizedSession = idleTerminal._sessions.get(resizedId);
      const resizedActivity = resizedSession.lastActivityAt;
      const resizeStart = Date.now();
      while (Date.now() - resizeStart < 240) {
        await idleRequest({ action: 'resize', id: resizedId, cols: 90, rows: 30 });
        await tick(20);
      }
      await tick(300);
      const resizedEnd = await idleRead(resizedId);
      await check('resize is layout, not activity', () => {
        assert.equal(resizedSession.lastActivityAt, resizedActivity);
        assert.equal(resizedEnd.body.state, 'exited');
      });
      await idleClose(resizedId);

      const naturalId = await idleCreate();
      const naturalSession = idleTerminal._sessions.get(naturalId);
      naturalSession.pty.emitExit(0);
      await tick(10);
      const naturalTimer = naturalSession.idleTimer;
      await tick(600);
      const naturalEnd = await idleRead(naturalId);
      await check('a naturally exited terminal clears its idle timer and never gets an idle message', () => {
        assert.equal(naturalTimer, null);
        assert.equal(naturalEnd.body.state, 'exited');
        assert.equal(naturalEnd.body.exitCode, 0);
        assert.equal(naturalSession.pty.killed, false);
        assert.ok(!naturalEnd.body.text.includes('空闲超时'));
      });
      await idleClose(naturalId);
    } finally {
      await idleTerminal.dispose();
      await idleApp.close();
    }
  }

  {
    /* P3 Keep Alive: an explicit per-session exemption from the idle timer.
     * It must never be settable through create/start, never cross a workspace
     * boundary, and never bypass stop/close/sweep/dispose. */
    const p3Spawned = [];
    const p3Terminal = createTerminal({
      scopeForRequest: async (req) => scopeFor(req),
      limits: noSweep({ ...TERMINAL_LIMITS, idleMs: 1000 }),
      spawnPty: fakePty(p3Spawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const p3App = await serve({ terminal: p3Terminal });
    const p3Request = (body, headers = scoped()) => p3App.request('/api/terminal', { method: 'POST', headers, body });
    const p3Read = (id, since = 0) => p3App.request('/api/terminal?' + new URLSearchParams({
      id, since: String(since),
    }), { headers: scoped() });
    const p3Create = async () => (await p3Request({ action: 'create' })).body.session;
    const p3Close = async (id) => p3Request({ action: 'close', id });
    const p3Wait = async (id, expected, timeout = 2000) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeout) {
        const response = await p3Read(id);
        if (response.body.state === expected) return response;
        await tick(10);
      }
      throw new Error(`terminal ${id} did not reach ${expected}`);
    };
    try {
      const created = await p3Request({ action: 'create', keepAlive: true });
      await check('create ignores a renderer-supplied keepAlive field', () => {
        assert.equal(created.body.ok, true);
        assert.equal(created.body.session.keepAlive, false);
      });
      await p3Request({ action: 'keep-alive', id: created.body.session.id, enabled: true });
      const reused = await p3Request({ action: 'start', keepAlive: false });
      await check('start reuse cannot overwrite the server-owned Keep Alive flag', () => {
        assert.equal(reused.body.reused, true);
        assert.equal(reused.body.session.id, created.body.session.id);
        assert.equal(reused.body.session.keepAlive, true);
      });
      await p3Close(created.body.session.id);

      const silent = await p3Create();
      const enabled = await p3Request({ action: 'keep-alive', id: silent.id, enabled: true });
      await check('a user can enable Keep Alive for one running session', () => {
        assert.equal(enabled.body.ok, true);
        assert.equal(enabled.body.session.keepAlive, true);
      });
      await tick(1400);
      const stillRunning = await p3Read(silent.id);
      await check('Keep Alive prevents the idle stop for a silent session', () => {
        assert.equal(stillRunning.body.state, 'running');
        assert.equal(stillRunning.body.session.keepAlive, true);
      });

      const normal = await p3Create();
      const normalEnd = await p3Wait(normal.id, 'exited');
      const silentWhileNormalEnded = await p3Read(silent.id);
      await check('Keep Alive is independent per terminal', () => {
        assert.equal(normalEnd.body.session.keepAlive, false);
        assert.equal(silentWhileNormalEnded.body.state, 'running');
      });
      await p3Close(normal.id);

      const disabled = await p3Request({ action: 'keep-alive', id: silent.id, enabled: false });
      await tick(300);
      const justAfterDisable = await p3Read(silent.id);
      await tick(900);
      const expired = await p3Read(silent.id);
      await check('disabling Keep Alive starts a fresh full idle window', () => {
        assert.equal(disabled.body.ok, true);
        assert.equal(disabled.body.session.keepAlive, false);
        assert.equal(justAfterDisable.body.state, 'running');
        assert.equal(expired.body.state, 'exited');
      });
      await p3Close(silent.id);

      const natural = await p3Create();
      const naturalEnabled = await p3Request({ action: 'keep-alive', id: natural.id, enabled: true });
      p3Terminal._sessions.get(natural.id).pty.emitExit(0);
      const naturalEnd = await p3Wait(natural.id, 'exited');
      await check('a natural exit clears Keep Alive and bumps its revision', () => {
        assert.equal(naturalEnd.body.state, 'exited');
        assert.equal(naturalEnd.body.session.keepAlive, false);
        assert.ok(naturalEnd.body.session.keepAliveRevision
          > naturalEnabled.body.session.keepAliveRevision);
      });
      await p3Close(natural.id);

      const restartSource = await p3Create();
      await p3Request({ action: 'keep-alive', id: restartSource.id, enabled: true });
      await p3Request({ action: 'stop', id: restartSource.id });
      await p3Wait(restartSource.id, 'exited');
      const restarted = await p3Request({ action: 'start', keepAlive: true });
      await check('stop still works and restart resets Keep Alive to off', () => {
        assert.equal(restarted.body.ok, true);
        assert.notEqual(restarted.body.session.id, restartSource.id);
        assert.equal(restarted.body.session.keepAlive, false);
      });
      await p3Close(restartSource.id);
      await p3Close(restarted.body.session.id);

      const manuallyStopped = await p3Create();
      await p3Request({ action: 'keep-alive', id: manuallyStopped.id, enabled: true });
      const stopResult = await p3Request({ action: 'stop', id: manuallyStopped.id });
      const stoppedEnd = await p3Wait(manuallyStopped.id, 'exited');
      const revive = await p3Request({ action: 'keep-alive', id: manuallyStopped.id, enabled: true });
      await check('a Keep Alive terminal can still be stopped by the user', () => {
        assert.equal(stopResult.body.session.keepAlive, false);
        assert.equal(stoppedEnd.body.state, 'exited');
        assert.equal(stoppedEnd.body.session.keepAlive, false);
        assert.equal(revive.body.code, 'terminal_not_running');
        assert.equal(revive.body.session.keepAlive, false);
      });
      await p3Close(manuallyStopped.id);

      const closed = await p3Create();
      await p3Request({ action: 'keep-alive', id: closed.id, enabled: true });
      const closeResult = await p3Close(closed.id);
      await tick(30);
      const closedAgain = await p3Close(closed.id);
      await check('a Keep Alive terminal can still be closed and its tab removed', () => {
        assert.equal(closeResult.body.ok, true);
        assert.equal(closeResult.body.session.keepAlive, false);
        assert.equal(closedAgain.body.missing, true);
        assert.equal(p3Terminal._sessions.has(closed.id), false);
      });

      const owned = await p3Create();
      await p3Request({ action: 'keep-alive', id: owned.id, enabled: true });
      const foreign = await p3Request({ action: 'keep-alive', id: owned.id, enabled: false }, scoped('b'));
      const forged = await p3Request({ action: 'keep-alive', id: 'not-a-session', enabled: true });
      const invalid = await p3Request({ action: 'keep-alive', id: owned.id, enabled: 'yes' });
      const ownedAfter = await p3Read(owned.id);
      await check('forged, cross-workspace and malformed requests cannot change Keep Alive', () => {
        assert.equal(foreign.body.code, 'stale_workspace');
        assert.equal(forged.body.code, 'terminal_missing');
        assert.equal(invalid.body.code, 'invalid_keep_alive');
        assert.equal(ownedAfter.body.session.keepAlive, true);
      });
      await p3Close(owned.id);

      const rapid = await p3Create();
      /* Truly concurrent requests have no guaranteed completion order, but the
       * flag, the timer and the later state must still agree. */
      await Promise.all([true, false, true, false, true].map(
        (enabled) => p3Request({ action: 'keep-alive', id: rapid.id, enabled })
      ));
      const rapidSettled = await p3Read(rapid.id);
      await tick(1400);
      const rapidLater = await p3Read(rapid.id);
      await check('rapid concurrent enable/disable requests settle without a timer race', () => {
        assert.equal(rapidLater.body.session.keepAlive, rapidSettled.body.session.keepAlive);
        assert.equal(
          rapidLater.body.state,
          rapidSettled.body.session.keepAlive ? 'running' : 'exited'
        );
      });
      if (rapidLater.body.session.keepAlive) {
        await p3Request({ action: 'keep-alive', id: rapid.id, enabled: false });
        await p3Wait(rapid.id, 'exited');
      }
      await p3Close(rapid.id);

      const shutdown = await p3Create();
      await p3Request({ action: 'keep-alive', id: shutdown.id, enabled: true });
      const shutdownPty = p3Terminal._sessions.get(shutdown.id).pty;
      await p3Terminal.dispose();
      await check('app dispose still kills a Keep Alive terminal', () => {
        assert.equal(shutdownPty.killed, true);
        assert.equal(p3Terminal._sessions.size, 0);
      });
    } finally {
      await p3Terminal.dispose();
      await p3App.close();
    }
  }

  {
    /* Workspace invalidation must retire a Keep Alive session even while the
     * shell is silent; Keep Alive only suppresses the idle timer. */
    const sweepSpawned = [];
    const sweepScopes = { a: { root: rootA, scopeId: 'p3-sweep', generation: '1' } };
    const sweepTerminal = createTerminal({
      scopeForRequest: async (req) => sweepScopes[req.headers?.['x-pi-gui-conversation'] || 'a'],
      limits: { ...TERMINAL_LIMITS, idleMs: 10_000, scopeSweepMs: 20 },
      spawnPty: fakePty(sweepSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const sweepApp = await serve({ terminal: sweepTerminal });
    const sweepRequest = (body) => sweepApp.request('/api/terminal', { method: 'POST', body });
    try {
      const started = await sweepRequest({ action: 'create' });
      const id = started.body.session.id;
      await sweepRequest({ action: 'keep-alive', id, enabled: true });
      const pty = sweepTerminal._sessions.get(id).pty;
      sweepScopes.a = { root: rootB, scopeId: 'p3-sweep', generation: '1' };
      for (let i = 0; i < 100 && sweepTerminal._sessions.has(id); i++) await tick(10);
      await check('a confirmed workspace change still retires a Keep Alive terminal', () => {
        assert.equal(pty.killed, true);
        assert.equal(sweepTerminal._sessions.has(id), false);
      });
    } finally {
      await sweepTerminal.dispose();
      await sweepApp.close();
    }
  }

  {
    /* If the idle kill is wedged, the record stays tracked as closing and the
     * existing scope sweep retries; only the real exit changes the state. */
    let killCalls = 0;
    const exitListeners = [];
    const wedged = {
      pid: 991002,
      cols: 80,
      rows: 24,
      onData() { return { dispose() {} }; },
      onExit(fn) { exitListeners.push(fn); return { dispose() {} }; },
      write() {},
      resize() {},
      kill() { killCalls++; },
      emitExit() { for (const fn of [...exitListeners]) fn({ exitCode: 0, signal: null }); },
    };
    const wedgedTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'idle-wedged', generation: '1' }),
      limits: { ...TERMINAL_LIMITS, idleMs: 80, scopeSweepMs: 20, killBackoffMs: [0, 10, 20] },
      spawnPty: () => wedged,
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const wedgedApp = await serve({ terminal: wedgedTerminal });
    try {
      const started = await wedgedApp.request('/api/terminal', { method: 'POST', body: { action: 'create' } });
      const id = started.body.session.id;
      await waitUntil(() => wedgedTerminal._sessions.get(id)?.killState === 'unconfirmed');
      const firstKills = killCalls;
      const session = wedgedTerminal._sessions.get(id);
      assert.equal(session?.state, 'closing');
      assert.ok(firstKills >= 2, `bounded retries did not run: ${firstKills}`);
      await tick(100);
      await check('a wedged idle kill is retried a bounded number of times and stays closing', () => {
        assert.equal(killCalls, firstKills, 'kill kept retrying after the budget');
        assert.equal(session.killState, 'unconfirmed');
        assert.equal(wedgedTerminal._sessions.get(id)?.state, 'closing');
      });
      wedged.emitExit();
      await tick(10);
      await check('the idle-stopped session reaches exited only after the real exit event', () => {
        assert.equal(wedgedTerminal._sessions.get(id)?.state, 'exited');
      });
    } finally {
      await wedgedTerminal.dispose();
      await wedgedApp.close();
    }
  }

  {
    /* The cap is counted in UTF-16 code units because the xterm wire format
     * is a string. When the cut lands on the low half of an emoji, drop the
     * whole pair instead of leaving a lone surrogate in the replay tail. */
    const surrogateSpawned = [];
    const surrogateTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'surrogate', generation: '1' }),
      limits: noSweep({ ...TERMINAL_LIMITS, maxBufferChars: 4 }),
      spawnPty: fakePty(surrogateSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const surrogateApp = await serve({ terminal: surrogateTerminal });
    try {
      const started = await surrogateApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
      surrogateSpawned[0].pty.emitData('a😀bcd');
      await tick();
      const read = await surrogateApp.request('/api/terminal?' + new URLSearchParams({ id: started.body.session.id, since: '0' }));
      await check('truncating the buffer never splits a UTF-16 surrogate pair', () => {
        assert.equal(read.body.truncated, true);
        assert.equal(read.body.text, 'bcd');
        const firstUnit = read.body.text.charCodeAt(0);
        assert.ok(!(firstUnit >= 0xdc00 && firstUnit <= 0xdfff), 'retained text starts with a lone low surrogate');
        assert.equal(read.body.cursor, 6);
      });
    } finally {
      await surrogateTerminal.dispose();
      await surrogateApp.close();
    }
  }

  {
    const many = new Map([
      ['a', { root: rootA, scopeId: 'limit-a', generation: '1' }],
      ['b', { root: rootB, scopeId: 'limit-b', generation: '1' }],
      ['c', { root: outside, scopeId: 'limit-c', generation: '1' }],
    ]);
    const limitSpawned = [];
    const limited = createTerminal({
      scopeForRequest: async (req) => many.get(req.headers?.['x-pi-gui-conversation'] || 'a'),
      limits: noSweep({ ...TERMINAL_LIMITS, maxSessions: 2 }),
      spawnPty: fakePty(limitSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const limitApp = await serve({ terminal: limited });
    try {
      const a = await limitApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'start' } });
      const b = await limitApp.request('/api/terminal', { method: 'POST', headers: scoped('b'), body: { action: 'start' } });
      const c = await limitApp.request('/api/terminal', { method: 'POST', headers: scoped('c'), body: { action: 'start' } });
      await check('the session cap rejects a third shell without killing the user’s other terminals', () => {
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(c.status, 409);
        assert.equal(c.body.code, 'terminal_limit');
        assert.equal(limitSpawned.length, 2);
        assert.equal(limitSpawned[0].pty.killed, false);
        assert.equal(limitSpawned[1].pty.killed, false);
      });
    } finally {
      await limited.dispose();
      await limitApp.close();
    }
  }

  {
    const failed = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'spawn-fail', generation: '1' }),
      limits: noSweep(TERMINAL_LIMITS),
      spawnPty: () => { throw new Error('node-pty unavailable'); },
      killPty: () => {},
      platform: 'fixture',
    });
    const failedApp = await serve({ terminal: failed });
    try {
      const result = await failedApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
      await check('a native-module or spawn failure is explicit and leaks no session', () => {
        assert.equal(result.status, 503);
        assert.equal(result.body.code, 'pty_unavailable');
        assert.equal(failed._sessions.size, 0);
      });
    } finally {
      await failed.dispose();
      await failedApp.close();
    }
  }

  {
    const shutdownSpawned = [];
    const shutdownTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'shutdown', generation: '1' }),
      limits: noSweep(TERMINAL_LIMITS),
      spawnPty: fakePty(shutdownSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const shutdownApp = await serve({ terminal: shutdownTerminal });
    await shutdownApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    await check('app shutdown kills every live PTY and waits for real exits', async () => {
      const fake = shutdownSpawned[0];
      const promise = shutdownTerminal.dispose();
      assert.equal(fake.pty.killed, true);
      await promise;
      assert.equal(shutdownTerminal._sessions.size, 0);
      await shutdownApp.close();
    });
  }

  {
    let releaseScope = null;
    let scopeRequested = false;
    const racedSpawned = [];
    const racedTerminal = createTerminal({
      scopeForRequest: () => new Promise((resolve) => {
        scopeRequested = true;
        releaseScope = () => resolve({ root: rootA, scopeId: 'shutdown-race', generation: '1' });
      }),
      limits: noSweep(TERMINAL_LIMITS),
      spawnPty: fakePty(racedSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const racedApp = await serve({ terminal: racedTerminal });
    const pending = racedApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    while (!scopeRequested) await tick(5);
    await racedTerminal.dispose();
    releaseScope();
    const result = await pending;
    await check('shutdown during an async start leaves no untracked PTY', () => {
      assert.equal(result.status, 503);
      assert.equal(racedSpawned.length, 0);
      assert.equal(racedTerminal._sessions.size, 0);
    });
    await racedApp.close();
  }

  {
    let currentScope = { root: rootA, scopeId: 'sweep-a', generation: '1' };
    const sweptSpawned = [];
    const sweepTerminal = createTerminal({
      scopeForRequest: async () => currentScope,
      scopeForSession: async () => currentScope,
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 30 },
      spawnPty: fakePty(sweptSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const sweepApp = await serve({ terminal: sweepTerminal });
    await sweepApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    currentScope = { root: rootB, scopeId: 'sweep-b', generation: '2' };
    await tick(250);
    await check('scope sweep stops the old session after a workspace change with no request', () => {
      assert.equal(sweptSpawned.length, 1);
      assert.equal(sweptSpawned[0].pty.killed, true);
      assert.equal(sweepTerminal._sessions.size, 0);
    });
    await sweepTerminal.dispose();
    await sweepApp.close();
  }

  {
    let scopeAnswer = 'throw';
    const transientSpawned = [];
    const transientTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'transient', generation: '1' }),
      scopeForSession: async () => {
        if (scopeAnswer === 'throw') throw Object.assign(new Error('registry_unavailable'), { code: 'registry_unavailable' });
        return scopeAnswer;
      },
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 20 },
      spawnPty: fakePty(transientSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const transientApp = await serve({ terminal: transientTerminal });
    const started = await transientApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    const id = started.body.session.id;
    await tick(100);
    await check('a transient scope error does not kill a live shell', () => {
      assert.equal(transientSpawned[0].pty.killed, false);
      assert.equal(transientTerminal._sessions.get(id)?.state, 'running');
    });
    scopeAnswer = null;
    await tick(100);
    await check('an unavailable scope keeps the shell instead of guessing a workspace change', () => {
      assert.equal(transientSpawned[0].pty.killed, false);
      assert.equal(transientTerminal._sessions.get(id)?.state, 'running');
    });
    scopeAnswer = { root: rootB, scopeId: 'transient-b', generation: '2' };
    await tick(100);
    await check('a successfully resolved different workspace still stops the shell', () => {
      assert.equal(transientSpawned[0].pty.killed, true);
      assert.equal(transientTerminal._sessions.size, 0);
    });
    await transientTerminal.dispose();
    await transientApp.close();
  }

  {
    /* Registry resolution succeeded but the workspace stat failed. A network
     * share or AV/indexer can produce EACCES/EBUSY for one sweep; that is not
     * proof the workspace is gone, so the shell must survive it. */
    let currentScope = { root: rootA, scopeId: 'fs-transient', generation: '1' };
    const fsSpawned = [];
    const fsTerminal = createTerminal({
      scopeForRequest: async () => currentScope,
      scopeForSession: async () => currentScope,
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 20 },
      spawnPty: fakePty(fsSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const fsApp = await serve({ terminal: fsTerminal });
    const started = await fsApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    const id = started.body.session.id;
    const realStat = fs.statSync;
    fs.statSync = function patchedStat(target, ...args) {
      if (path.resolve(String(target)) === path.resolve(rootA)) {
        const error = new Error('fixture EACCES');
        error.code = 'EACCES';
        throw error;
      }
      return realStat.call(fs, target, ...args);
    };
    try {
      await tick(100);
    } finally {
      fs.statSync = realStat;
    }
    await check('a transient workspace stat failure keeps the shell alive', () => {
      assert.equal(fsSpawned[0].pty.killed, false);
      assert.equal(fsTerminal._sessions.get(id)?.state, 'running');
    });
    currentScope = { root: rootB, scopeId: 'fs-transient-b', generation: '2' };
    await tick(100);
    await check('a confirmed workspace change still retires the shell after the transient error', () => {
      assert.equal(fsSpawned[0].pty.killed, true);
      assert.equal(fsTerminal._sessions.size, 0);
    });
    await fsTerminal.dispose();
    await fsApp.close();
  }

  {
    const deletedSpawned = [];
    const deletedTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'deleted', generation: '1' }),
      scopeForSession: async () => {
        throw Object.assign(new Error('unknown_conversation'), { code: 'unknown_conversation' });
      },
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 20 },
      spawnPty: fakePty(deletedSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const deletedApp = await serve({ terminal: deletedTerminal });
    const started = await deletedApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    const id = started.body.session.id;
    /* The shell keeps producing output, which refreshes the idle timer. The
     * ownership sweep must still retire it once the conversation is gone. */
    const output = setInterval(() => deletedSpawned[0]?.pty.emitData('still running\r\n'), 5);
    await tick(120);
    clearInterval(output);
    await check('a deleted conversation stops its PTY even while output keeps arriving', () => {
      assert.equal(deletedSpawned[0].pty.killed, true);
      assert.equal(deletedTerminal._sessions.has(id), false);
    });
    await deletedTerminal.dispose();
    await deletedApp.close();
  }

  {
    let killCalls = 0;
    const exitListeners = [];
    const wedged = {
      pid: 990002,
      cols: 80,
      rows: 24,
      onData() { return { dispose() {} }; },
      onExit(fn) { exitListeners.push(fn); return { dispose() {} }; },
      write() {},
      resize() {},
      kill() { killCalls++; /* deliberately no exit event */ },
      emitExit() { for (const fn of [...exitListeners]) fn({ exitCode: 0, signal: null }); },
    };
    const wedgedTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'deleted-wedged', generation: '1' }),
      scopeForSession: async () => { throw Object.assign(new Error('unknown_conversation'), { code: 'unknown_conversation' }); },
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 20, killBackoffMs: [0, 10, 20] },
      spawnPty: () => wedged,
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const wedgedApp = await serve({ terminal: wedgedTerminal });
    const started = await wedgedApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    const id = started.body.session.id;
    await waitUntil(() => wedgedTerminal._sessions.get(id)?.killState === 'unconfirmed');
    const beforeRetry = killCalls;
    const wedgedRecord = wedgedTerminal._sessions.get(id);
    await tick(100);
    await check('a failed retirement keeps the session tracked and is retried within the bounded budget', () => {
      assert.ok(beforeRetry >= 2, `bounded retries did not run: ${beforeRetry}`);
      assert.equal(killCalls, beforeRetry, 'kill kept retrying after the budget');
      assert.equal(wedgedRecord.killState, 'unconfirmed');
      assert.equal(wedgedTerminal._sessions.get(id)?.state, 'closing');
    });
    wedged.emitExit();
    await tick(10);
    await check('the retired session disappears only after the real PTY exit', () => {
      assert.equal(wedgedTerminal._sessions.has(id), false);
    });
    await wedgedTerminal.dispose();
    await wedgedApp.close();
  }

  for (const code of ['unknown_workspace', 'workspace_unavailable', 'stale_workspace']) {
    const invalidSpawned = [];
    const invalidTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: `invalid-${code}`, generation: '1' }),
      scopeForSession: async () => { throw Object.assign(new Error(code), { code }); },
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 20 },
      spawnPty: fakePty(invalidSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const invalidApp = await serve({ terminal: invalidTerminal });
    const started = await invalidApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    const id = started.body.session.id;
    await tick(100);
    await check(`a confirmed ${code} retires the PTY`, () => {
      assert.equal(invalidSpawned[0].pty.killed, true);
      assert.equal(invalidTerminal._sessions.has(id), false);
    });
    await invalidTerminal.dispose();
    await invalidApp.close();
  }

  {
    /* Explicit stop and a workspace-generation switch arrive together. The old
     * PTY must be retired exactly once and the new workspace must get exactly
     * one shell, with no session left untracked in either order. */
    let currentScope = { root: rootA, scopeId: 'race-a', generation: '1' };
    const raceSpawned = [];
    const spawnWithSlowExit = fakePty(raceSpawned);
    const raceTerminal = createTerminal({
      scopeForRequest: async () => currentScope,
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 20 },
      spawnPty: (spawnArgs) => {
        const pty = spawnWithSlowExit(spawnArgs);
        pty.kill = () => {
          if (pty.killed) return;
          pty.killed = true;
          setTimeout(() => pty.emitExit(0, null), 30);
        };
        return pty;
      },
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const raceApp = await serve({ terminal: raceTerminal });
    try {
      const first = await raceApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
      const firstId = first.body.session.id;
      const stopPending = raceApp.request('/api/terminal', {
        method: 'POST', body: { action: 'stop', id: firstId },
      });
      currentScope = { root: rootB, scopeId: 'race-b', generation: '2' };
      const startPending = raceApp.request('/api/terminal', {
        method: 'POST', body: { action: 'start', cols: 90, rows: 25 },
      });
      const [stopResult, startResult] = await Promise.all([stopPending, startPending]);
      await tick(100);
      const secondId = startResult.body.session?.id;
      const again = await raceApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
      await check('stop racing a workspace switch leaks no process and spawns no duplicate', () => {
        assert.ok(stopResult.status === 200 || stopResult.body.code === 'stale_workspace');
        assert.equal(startResult.status, 200);
        assert.equal(startResult.body.reused, false);
        assert.equal(raceSpawned.length, 2);
        assert.equal(raceSpawned[0].pty.killed, true);
        assert.equal(raceSpawned[1].pty.killed, false);
        assert.equal(raceTerminal._sessions.has(firstId), false);
        assert.equal(raceTerminal._sessions.get(secondId)?.state, 'running');
        assert.equal(again.body.reused, true);
        assert.equal(raceSpawned.length, 2);
      });
    } finally {
      await raceTerminal.dispose();
      await raceApp.close();
    }
  }

  {
    let killCalls = 0;
    const exitListeners = [];
    const stubborn = {
      pid: 990001,
      cols: 80,
      rows: 24,
      onData() { return { dispose() {} }; },
      onExit(fn) { exitListeners.push(fn); return { dispose() {} }; },
      write() {},
      resize() {},
      kill() { killCalls++; /* deliberately no exit event */ },
      emitExit() { for (const fn of [...exitListeners]) fn({ exitCode: 0, signal: null }); },
    };
    const stubbornTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'stubborn', generation: '1' }),
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 20, killBackoffMs: [0, 10, 20] },
      spawnPty: () => stubborn,
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const stubbornApp = await serve({ terminal: stubbornTerminal });
    const started = await stubbornApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    const id = started.body.session.id;
    const stopResult = await stubbornApp.request('/api/terminal', { method: 'POST', body: { action: 'stop', id } });
    assert.equal(stopResult.body.session.state, 'closing');
    const beforeRetry = killCalls;
    await waitUntil(() => stubbornTerminal._sessions.get(id)?.killState === 'unconfirmed');
    await check('sweep retries a wedged stop within the bounded budget without faking exit', () => {
      assert.ok(killCalls > beforeRetry, `kill retried ${killCalls - beforeRetry} times`);
      assert.equal(killCalls, 3);
      assert.equal(stubbornTerminal._sessions.get(id).state, 'closing');
    });
    stubborn.emitExit();
    await tick(10);
    await stubbornTerminal.dispose();
    await stubbornApp.close();
  }

  {
    /* P3-B: an unverifiable kill must stop after a bounded budget instead of
     * retrying a bare pid forever. The public state stays `closing`; only the
     * real exit event may finish the session. */
    const wedgedSpawned = [];
    const wedgedExitListeners = [];
    const wedged = {
      pid: 990002,
      cols: 80,
      rows: 24,
      onData() { return { dispose() {} }; },
      onExit(fn) { wedgedExitListeners.push(fn); return { dispose() {} }; },
      write() {},
      resize() {},
      kill() { throw new Error('Windows must not fall back to pty.kill()'); },
    };
    const wedgedTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'bounded-kill', generation: '1' }),
      limits: {
        ...TERMINAL_LIMITS,
        scopeSweepMs: 10,
        killMaxAttempts: 3,
        killBackoffMs: [0, 10, 20],
      },
      spawnPty: () => wedged,
      killPty: () => { wedgedSpawned.push(Date.now()); return { result: 'failed' }; },
      platform: 'fixture',
    });
    const wedgedApp = await serve({ terminal: wedgedTerminal });
    try {
      const started = await wedgedApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
      const id = started.body.session.id;
      const stopped = await wedgedApp.request('/api/terminal', { method: 'POST', body: { action: 'stop', id } });
      assert.equal(stopped.body.session.state, 'closing');
      await waitUntil(() => wedgedTerminal._sessions.get(id)?.killState === 'unconfirmed');
      const record = wedgedTerminal._sessions.get(id);
      await check('an unconfirmed kill is retried only up to the bounded budget', () => {
        assert.equal(wedgedSpawned.length, 3, `kill attempts: ${wedgedSpawned.length}`);
        assert.equal(record.state, 'closing');
        assert.equal(record.killState, 'unconfirmed');
      });
      await tick(60);
      await check('the bounded budget stops further PID kills and never fakes an exit', () => {
        assert.equal(wedgedSpawned.length, 3, 'kill kept retrying after the budget');
        assert.equal(record.state, 'closing');
      });
    } finally {
      for (const fn of wedgedExitListeners) fn({ exitCode: 0, signal: null });
      await wedgedTerminal.dispose();
      await wedgedApp.close();
    }
  }

  {
    /* mismatch means the pid now belongs to another process. One attempt is
     * enough: retrying is both useless and unsafe. */
    let mismatchCalls = 0;
    const mismatchExitListeners = [];
    const mismatchPty = {
      pid: 990003,
      cols: 80,
      rows: 24,
      onData() { return { dispose() {} }; },
      onExit(fn) { mismatchExitListeners.push(fn); return { dispose() {} }; },
      write() {},
      resize() {},
      kill() { throw new Error('mismatch fell back to pty.kill()'); },
    };
    const mismatchTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'identity-mismatch', generation: '1' }),
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 10, killBackoffMs: [0, 10, 20] },
      spawnPty: () => mismatchPty,
      killPty: () => { mismatchCalls += 1; return { result: 'mismatch' }; },
      platform: 'fixture',
    });
    const mismatchApp = await serve({ terminal: mismatchTerminal });
    try {
      const started = await mismatchApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
      const id = started.body.session.id;
      await mismatchApp.request('/api/terminal', { method: 'POST', body: { action: 'stop', id } });
      await waitUntil(() => mismatchTerminal._sessions.get(id)?.killState === 'unconfirmed');
      const record = mismatchTerminal._sessions.get(id);
      await check('an identity mismatch is never retried', () => {
        assert.equal(mismatchCalls, 1);
        assert.equal(record.state, 'closing');
        assert.equal(record.killState, 'unconfirmed');
      });
    } finally {
      for (const fn of mismatchExitListeners) fn({ exitCode: 0, signal: null });
      await mismatchTerminal.dispose();
      await mismatchApp.close();
    }
  }

  {
    /* While one kill is awaiting the identity query, the sweep must not start
     * a second overlapping attempt. */
    let inFlightCalls = 0;
    let releaseKill = null;
    const inFlightExitListeners = [];
    const inFlightPty = {
      pid: 990004,
      cols: 80,
      rows: 24,
      onData() { return { dispose() {} }; },
      onExit(fn) { inFlightExitListeners.push(fn); return { dispose() {} }; },
      write() {},
      resize() {},
      kill() { throw new Error('in-flight test fell back to pty.kill()'); },
    };
    const inFlightTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'kill-in-flight', generation: '1' }),
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 5, killBackoffMs: [0, 10, 20] },
      spawnPty: () => inFlightPty,
      killPty: () => {
        inFlightCalls += 1;
        return new Promise((resolve) => { releaseKill = resolve; });
      },
      platform: 'fixture',
    });
    const inFlightApp = await serve({ terminal: inFlightTerminal });
    try {
      const started = await inFlightApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
      const id = started.body.session.id;
      await inFlightApp.request('/api/terminal', { method: 'POST', body: { action: 'stop', id } });
      await tick(80);
      const record = inFlightTerminal._sessions.get(id);
      await check('the sweep never overlaps an in-flight kill attempt', () => {
        assert.equal(inFlightCalls, 1, `kill attempts: ${inFlightCalls}`);
        assert.equal(record.killInFlight, true);
      });
      releaseKill({ result: 'failed' });
      await Promise.resolve();
      await Promise.resolve();
      await check('a settled attempt clears the in-flight guard', () => {
        assert.equal(record.killInFlight, false);
        assert.equal(record.killState, 'pending');
      });
    } finally {
      for (const fn of inFlightExitListeners) fn({ exitCode: 0, signal: null });
      await inFlightTerminal.dispose();
      await inFlightApp.close();
    }
  }

  {
    const { resolveTerminalShell } = await import('../server/terminal.js');
    const winRoot = 'C:\\Windows';
    const powerShell = path.win32.join(winRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const cmd = path.win32.join(winRoot, 'System32', 'cmd.exe');
    const withPowerShell = resolveTerminalShell({
      platform: 'win32',
      env: { SystemRoot: winRoot, ComSpec: cmd },
      exists: (file) => file === powerShell,
    });
    const fallback = resolveTerminalShell({
      platform: 'win32',
      env: { SystemRoot: winRoot, ComSpec: cmd },
      exists: (file) => file === cmd,
    });
    await check('Windows defaults to absolute PowerShell and falls back to absolute CMD', () => {
      assert.equal(withPowerShell.file, powerShell);
      assert.deepEqual(withPowerShell.args, ['-NoLogo', '-NoProfile']);
      assert.equal(withPowerShell.shell, 'PowerShell');
      assert.equal(fallback.file, cmd);
      assert.deepEqual(fallback.args, ['/d', '/q']);
      assert.equal(fallback.shell, '命令提示符');
    });
  }

  {
    /* P3-B: pid alone is not identity. Capture (pid, creation time, image)
     * right after spawn; before taskkill, re-query and compare. */
    const identity = require('../lib/process-identity.cjs');
    await check('identity parsing keeps FILETIME precision and rejects junk', () => {
      const parsed = identity.parseIdentityOutput(
        '133555555555555555|C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n'
      );
      assert.deepEqual(parsed, {
        creationTimeUtc: '133555555555555555',
        imagePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      });
      assert.equal(parsed.creationTimeUtc.length, 18);
      assert.equal(identity.parseIdentityOutput(''), null);
      assert.equal(identity.parseIdentityOutput('Warning: something'), null);
    });
    await check('identity comparison requires creation time and image path', () => {
      const expected = {
        state: 'captured',
        pid: 4321,
        creationTimeUtc: '133555555555555555',
        imagePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      };
      const found = (creationTimeUtc, imagePath) => ({ state: 'found', creationTimeUtc, imagePath });
      assert.equal(identity.classifyProcessIdentity(expected, found(expected.creationTimeUtc, expected.imagePath)), 'match');
      assert.equal(identity.classifyProcessIdentity(expected, found('133555555555555556', expected.imagePath)), 'mismatch');
      assert.equal(identity.classifyProcessIdentity(expected, found(expected.creationTimeUtc, 'C:\\Windows\\System32\\cmd.exe')), 'mismatch');
      assert.equal(identity.classifyProcessIdentity(expected, { state: 'gone' }), 'gone');
      assert.equal(identity.classifyProcessIdentity(expected, { state: 'unknown', reason: 'query_failed' }), 'unknown');
      assert.equal(identity.classifyProcessIdentity({ state: 'unknown' }, found(expected.creationTimeUtc, expected.imagePath)), 'unknown');
      assert.equal(
        identity.normalizeImagePath('C:\\Windows\\System32\\CMD.EXE'),
        identity.normalizeImagePath('c:/windows/system32/cmd.exe')
      );
    });
    await check('identity query distinguishes gone, empty output, and a failed probe', async () => {
      const gone = await identity.queryProcessIdentity(4321, {
        env: { SystemRoot: 'C:\\Windows' },
        execFile: (_file, _args, _opts, callback) => callback(Object.assign(new Error('exit'), { code: 3 })),
      });
      assert.equal(gone.state, 'gone');
      const failed = await identity.queryProcessIdentity(4321, {
        env: { SystemRoot: 'C:\\Windows' },
        execFile: (_file, _args, _opts, callback) => callback(Object.assign(new Error('no'), { code: 'ENOENT' })),
      });
      assert.equal(failed.state, 'unknown');
      /* Exit code 0 with no output is a broken probe, not proof of exit;
       * only the explicit exit 3 above means the pid is gone. */
      const empty = await identity.queryProcessIdentity(4321, {
        env: { SystemRoot: 'C:\\Windows' },
        execFile: (_file, _args, _opts, callback) => callback(null, ''),
      });
      assert.deepEqual(empty, { state: 'unknown', reason: 'empty_output' });
      const found = await identity.queryProcessIdentity(4321, {
        env: { SystemRoot: 'C:\\Windows' },
        execFile: (_file, _args, _opts, callback) => callback(null, '133555555555555555|C:\\Windows\\System32\\cmd.exe\n'),
      });
      assert.deepEqual(found, {
        state: 'found',
        creationTimeUtc: '133555555555555555',
        imagePath: 'C:\\Windows\\System32\\cmd.exe',
      });
    });
    await check('the synchronous Electron quit query fails closed', () => {
      const gone = identity.queryProcessIdentitySync(4321, {
        env: { SystemRoot: 'C:\\Windows' },
        execFileSync: () => { throw Object.assign(new Error('exit'), { status: 3 }); },
      });
      assert.equal(gone.state, 'gone');
      const failed = identity.queryProcessIdentitySync(4321, {
        env: { SystemRoot: 'C:\\Windows' },
        execFileSync: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
      });
      assert.equal(failed.state, 'unknown');
      const empty = identity.queryProcessIdentitySync(4321, {
        env: { SystemRoot: 'C:\\Windows' },
        execFileSync: () => '',
      });
      assert.deepEqual(empty, { state: 'unknown', reason: 'empty_output' });
    });
    await check('identity capture keeps the tight spawn-time budget', async () => {
      /* Capture starts immediately after spawn. Extending its budget would
       * widen the window in which a reused pid could be captured as the shell;
       * it must stay tighter than the stop-time re-query, whose result is
       * compared against this captured identity. */
      const image = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const seen = [];
      const capture = (options) => identity.captureProcessIdentity(4321, image, {
        env: { SystemRoot: 'C:\\Windows' },
        execFile: (_file, _args, opts, callback) => {
          seen.push(opts.timeout);
          callback(null, `133555555555555555|${image}\n`);
        },
        ...options,
      });
      const withDefault = await capture({});
      assert.equal(withDefault.state, 'captured');
      const withOverride = await capture({ timeoutMs: 123 });
      assert.equal(withOverride.state, 'captured');
      assert.deepEqual(seen, [identity.DEFAULT_CAPTURE_TIMEOUT_MS, 123]);
      assert.ok(
        identity.DEFAULT_CAPTURE_TIMEOUT_MS <= 2500,
        'spawn-time capture budget grew beyond the tight 2.5 s window'
      );
      assert.ok(
        identity.DEFAULT_CAPTURE_TIMEOUT_MS < identity.DEFAULT_QUERY_TIMEOUT_MS,
        'spawn-time capture no longer has a tighter budget than the kill re-query'
      );
      assert.ok(
        identity.DEFAULT_QUERY_TIMEOUT_MS >= 5000,
        'kill re-query fell back to the old 2.5 s window'
      );
      assert.ok(
        identity.DEFAULT_SYNC_QUERY_TIMEOUT_MS <= 2500,
        'the synchronous Electron quit probe can block for too long'
      );
    });
    await check('defaultKillPty refuses an unverified Windows pty but keeps POSIX pty.kill()', async () => {
      const { defaultKillPty } = await import('../server/terminal.js');
      const pty = { pid: 4321, kills: 0, kill() { this.kills += 1; } };
      const outcome = await defaultKillPty(pty, 'win32');
      assert.equal(outcome.result, 'unknown');
      assert.equal(pty.kills, 0, 'Windows reached pty.kill() without identity');
      defaultKillPty(pty, 'linux');
      assert.equal(pty.kills, 1, 'POSIX pty.kill() no longer runs');
    });
  }

  {
    const { createWindowsKillGate } = await import('../server/terminal.js');
    const captured = {
      state: 'captured',
      pid: 4321,
      creationTimeUtc: '133555555555555555',
      imagePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    };
    const makePty = () => ({
      pid: 4321,
      kills: 0,
      kill() { this.kills += 1; },
    });
    const makeGate = ({
      current,
      captureResult = captured,
      taskkillResult = { ok: true },
      captureTimeoutMs,
      timeoutMs = 20,
    } = {}) => {
      const calls = { query: 0, taskkill: 0, taskkillPid: null, captureOptions: null, queryOptions: null };
      const gate = createWindowsKillGate({
        capture: async (_pid, _imagePath, options) => { calls.captureOptions = options; return captureResult; },
        query: async (_pid, options) => { calls.query += 1; calls.queryOptions = options; return current; },
        taskkill: async (pid) => { calls.taskkill += 1; calls.taskkillPid = pid; return taskkillResult; },
        ...(captureTimeoutMs === undefined ? {} : { captureTimeoutMs }),
        timeoutMs,
        taskkillTimeoutMs: 20,
      });
      return { gate, calls };
    };
    const run = async (options) => {
      const { gate, calls } = makeGate(options);
      const pty = makePty();
      gate.capture(pty, captured.imagePath);
      const outcome = await gate.kill(pty);
      return { outcome, calls, pty };
    };

    await check('the identity gate taskkills only the original process', async () => {
      const { outcome, calls, pty } = await run({
        current: { state: 'found', creationTimeUtc: captured.creationTimeUtc, imagePath: captured.imagePath },
      });
      assert.deepEqual(outcome, { result: 'killed' });
      assert.equal(calls.query, 1);
      assert.equal(calls.taskkill, 1);
      assert.equal(calls.taskkillPid, 4321);
      assert.equal(pty.kills, 0, 'Windows must not fall back to pty.kill()');
    });

    await check('capture and kill re-query use separate timeout budgets', async () => {
      /* A cold PowerShell start is the expensive part. Capture keeps its own
       * tight budget; the re-query that gates a kill has a separate, larger
       * budget because it is compared against the captured identity. */
      const { outcome, calls } = await run({
        current: { state: 'found', creationTimeUtc: captured.creationTimeUtc, imagePath: captured.imagePath },
        captureTimeoutMs: 1234,
        timeoutMs: 5678,
      });
      assert.deepEqual(outcome, { result: 'killed' });
      assert.equal(calls.captureOptions.timeoutMs, 1234, 'capture did not get its own budget');
      assert.equal(calls.queryOptions.timeoutMs, 5678, 'kill re-query did not get its own budget');
    });

    await check('a reused or unverifiable pid is never taskkilled', async () => {
      const cases = [
        { name: 'gone', current: { state: 'gone' }, expected: 'gone' },
        {
          name: 'creation time',
          current: { state: 'found', creationTimeUtc: '133555555555555556', imagePath: captured.imagePath },
          expected: 'mismatch',
        },
        {
          name: 'image path',
          current: { state: 'found', creationTimeUtc: captured.creationTimeUtc, imagePath: 'C:\\Windows\\System32\\cmd.exe' },
          expected: 'mismatch',
        },
        { name: 'query failed', current: { state: 'unknown', reason: 'query_failed' }, expected: 'unknown' },
        { name: 'capture failed', current: { state: 'gone' }, captureResult: { state: 'unknown', reason: 'image_mismatch' }, expected: 'unknown' },
      ];
      for (const item of cases) {
        const { outcome, calls, pty } = await run(item);
        assert.equal(outcome.result, item.expected, `${item.name}: ${JSON.stringify(outcome)}`);
        assert.equal(calls.taskkill, 0, `${item.name} reached taskkill`);
        assert.equal(pty.kills, 0, `${item.name} fell back to pty.kill()`);
      }
      const noCapture = await (async () => {
        const { gate, calls } = makeGate({ current: { state: 'gone' } });
        const pty = makePty();
        const outcome = await gate.kill(pty);
        return { outcome, calls, pty };
      })();
      assert.equal(noCapture.outcome.result, 'unknown');
      assert.equal(noCapture.calls.query, 0);
      assert.equal(noCapture.calls.taskkill, 0);
      assert.equal(noCapture.pty.kills, 0);
    });

    await check('a failed taskkill is reported as failed for bounded retry', async () => {
      const { outcome, calls, pty } = await run({
        current: { state: 'found', creationTimeUtc: captured.creationTimeUtc, imagePath: captured.imagePath },
        taskkillResult: { ok: false, code: 5 },
      });
      assert.deepEqual(outcome, { result: 'failed', code: 5 });
      assert.equal(calls.taskkill, 1);
      assert.equal(pty.kills, 0);
    });
  }

  {
    /* P2: three sessions in one workspace, a forge from another workspace, and
     * close/stop affecting only their own PTY. */
    const multiSpawned = [];
    const multiScopes = {
      a: { root: rootA, scopeId: 'multi-a', generation: '1' },
      b: { root: rootB, scopeId: 'multi-b', generation: '1' },
    };
    const multi = createTerminal({
      scopeForRequest: async (req) => multiScopes[req.headers?.['x-pi-gui-conversation'] || 'a'],
      limits: noSweep(TERMINAL_LIMITS),
      spawnPty: fakePty(multiSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
      env: { PATH: 'fixture', HOME: world },
    });
    const multiApp = await serve({ terminal: multi });
    try {
      const created = [];
      for (const size of [{ cols: 100, rows: 30 }, { cols: 120, rows: 40 }, { cols: 80, rows: 24 }]) {
        created.push(await multiApp.request('/api/terminal', {
          method: 'POST',
          headers: scoped('a'),
          body: {
            action: 'create', ...size,
            shell: 'evil.exe', cwd: outside, args: ['--evil'], env: { PI_GUI_TOKEN: 'leak' },
          },
        }));
      }
      const ids = created.map((result) => result.body.session.id);
      const listed = await multiApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'list' } });
      await check('create opens three independent sessions with random ids and inherited cwd', () => {
        assert.ok(created.every((result) => result.status === 200 && result.body.ok && result.body.reused === false));
        assert.equal(new Set(ids).size, 3);
        for (const id of ids) {
          assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        }
        assert.deepEqual(created.map((result) => result.body.session.ordinal), [1, 2, 3]);
        assert.deepEqual(listed.body.sessions.map((session) => session.id), ids);
        assert.equal(listed.body.sessions.length, 3);
        assert.match(listed.body.workspace.id, /^[0-9a-f]{32}$/);
        assert.ok(!JSON.stringify(listed.body.workspace).includes(rootB));
        assert.equal(new Set(multiSpawned.map((spawn) => spawn.pty.pid)).size, 3);
        assert.ok(multiSpawned.every((spawn) => spawn.cwd === fs.realpathSync.native(rootA)));
        assert.ok(multiSpawned.every((spawn) => spawn.file === '/bin/sh' && spawn.args.length === 0));
        assert.ok(multiSpawned.every((spawn) => spawn.env.PI_GUI_TOKEN === undefined));
        assert.ok(!ids.includes(String(multiSpawned[0].pty.pid)));
      });

      const input = await multiApp.request('/api/terminal', {
        method: 'POST', headers: scoped('a'), body: { action: 'input', id: ids[0], data: 'echo one\r' },
      });
      multiSpawned[1].pty.emitData('only-two\r\n');
      for (const spawn of multiSpawned) spawn.pty.emitData('');
      const readZero = await multiApp.request('/api/terminal?' + new URLSearchParams({ id: ids[0], since: '0' }), { headers: scoped('a') });
      const readOne = await multiApp.request('/api/terminal?' + new URLSearchParams({ id: ids[1], since: '0' }), { headers: scoped('a') });
      const readOneTail = await multiApp.request('/api/terminal?' + new URLSearchParams({ id: ids[1], since: String(readOne.body.cursor) }), { headers: scoped('a') });
      await check('input and output stay isolated per terminal', () => {
        assert.equal(input.status, 200);
        assert.deepEqual(multiSpawned[0].pty.writes, ['echo one\r']);
        assert.deepEqual(multiSpawned[1].pty.writes, []);
        assert.deepEqual(multiSpawned[2].pty.writes, []);
        assert.equal(readZero.body.text, '');
        assert.equal(readOne.body.text, 'only-two\r\n');
        assert.equal(readOneTail.body.text, '');
        assert.equal(readOne.body.cursor, 'only-two\r\n'.length);
      });

      const foreign = await multiApp.request('/api/terminal', {
        method: 'POST', headers: scoped('b'), body: { action: 'create' },
      });
      const foreignId = foreign.body.session.id;
      const foreignCalls = await Promise.all([
        multiApp.request('/api/terminal?' + new URLSearchParams({ id: foreignId, since: '0' }), { headers: scoped('a') }),
        multiApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'input', id: foreignId, data: 'x' } }),
        multiApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'resize', id: foreignId, cols: 90, rows: 25 } }),
        multiApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'stop', id: foreignId } }),
        multiApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'close', id: foreignId } }),
      ]);
      const foreignList = await multiApp.request('/api/terminal', { method: 'POST', headers: scoped('b'), body: { action: 'list' } });
      await check('a forged id from another workspace cannot be read, written, resized, stopped or closed', () => {
        assert.ok(foreignCalls.every((result) => result.status === 409 && result.body.code === 'stale_workspace'));
        assert.equal(multiSpawned[3].pty.killed, false);
        assert.equal(multiSpawned[3].pty.writes.length, 0);
        assert.deepEqual(foreignList.body.sessions.map((session) => session.id), [foreignId]);
      });

      const stopped = await multiApp.request('/api/terminal', {
        method: 'POST', headers: scoped('a'), body: { action: 'stop', id: ids[2] },
      });
      const stoppedList = await multiApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'list' } });
      await check('stopping one tab keeps the other running terminals and their buffers', () => {
        assert.equal(stopped.body.ok, true);
        assert.equal(stopped.body.session.state, 'closing');
        assert.equal(multiSpawned[2].pty.killed, true);
        assert.equal(multiSpawned[0].pty.killed, false);
        assert.equal(multiSpawned[1].pty.killed, false);
        const states = Object.fromEntries(stoppedList.body.sessions.map((session) => [session.id, session.state]));
        assert.equal(states[ids[0]], 'running');
        assert.equal(states[ids[1]], 'running');
        assert.equal(states[ids[2]], 'exited');
        assert.equal(stoppedList.body.sessions.length, 3);
      });

      const closed = await multiApp.request('/api/terminal', {
        method: 'POST', headers: scoped('a'), body: { action: 'close', id: ids[1] },
      });
      const closedAgain = await multiApp.request('/api/terminal', {
        method: 'POST', headers: scoped('a'), body: { action: 'close', id: ids[1] },
      });
      await tick(20);
      const afterClose = await multiApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'list' } });
      await check('close removes one tab, is idempotent, and leaves the others alive', () => {
        assert.equal(closed.status, 200);
        assert.equal(closed.body.closed, true);
        assert.equal(closedAgain.status, 200);
        assert.equal(closedAgain.body.ok, true);
        assert.equal(closedAgain.body.missing, true);
        assert.equal(multiSpawned[1].pty.killed, true);
        assert.equal(multiSpawned[0].pty.killed, false);
        assert.equal(multi._sessions.has(ids[1]), false);
        assert.deepEqual(afterClose.body.sessions.map((session) => session.id), [ids[0], ids[2]]);
      });

      const closeForeign = await multiApp.request('/api/terminal', {
        method: 'POST', headers: scoped('b'), body: { action: 'close', id: foreignId },
      });
      const forgedId = await multiApp.request('/api/terminal', {
        method: 'POST', headers: scoped('a'), body: { action: 'close', id: 'x'.repeat(129) },
      });
      await check('close verifies ownership and treats an unknown id as idempotent', () => {
        assert.equal(closeForeign.status, 200);
        assert.equal(closeForeign.body.closed, true);
        assert.equal(forgedId.status, 200);
        assert.equal(forgedId.body.missing, true);
      });

      /* Legacy `start` replaces the focused workspace's finished tab. It must
       * not delete another workspace's exited tab, which is still restartable
       * when the user returns there. */
      const startB = await multiApp.request('/api/terminal', {
        method: 'POST', headers: scoped('b'), body: { action: 'start' },
      });
      const startBId = startB.body.session?.id;
      const listAAfterStartB = await multiApp.request('/api/terminal', {
        method: 'POST', headers: scoped('a'), body: { action: 'list' },
      });
      await check('a legacy start in workspace B does not prune workspace A exited tabs', () => {
        assert.equal(startB.status, 200);
        assert.ok(listAAfterStartB.body.sessions.some((session) => session.id === ids[2] && session.state === 'exited'));
      });

      const closeLast = await Promise.all([ids[0], ids[2], startBId].map((id) => multiApp.request('/api/terminal', {
        method: 'POST',
        headers: scoped(id === startBId ? 'b' : 'a'),
        body: { action: 'close', id },
      })));
      assert.ok(closeLast.every((result) => result.status === 200 && result.body.ok));
      await tick(30);
      await check('every terminal created in this block is gone after closing', () => {
        assert.equal(multi._sessions.size, 0);
        assert.ok(multiSpawned.every((spawn) => spawn.pty.killed));
      });
    } finally {
      await multi.dispose();
      await multiApp.close();
    }
  }

  {
    let failNext = false;
    const failSpawned = [];
    const baseSpawn = fakePty(failSpawned);
    const failTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'multi-start-fail', generation: '1' }),
      limits: noSweep(TERMINAL_LIMITS),
      spawnPty: (spawnArgs) => {
        if (failNext) throw Object.assign(new Error('node-pty unavailable'), { code: 'pty_unavailable' });
        return baseSpawn(spawnArgs);
      },
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const failApp = await serve({ terminal: failTerminal });
    try {
      const first = await failApp.request('/api/terminal', { method: 'POST', body: { action: 'create' } });
      const second = await failApp.request('/api/terminal', { method: 'POST', body: { action: 'create' } });
      failNext = true;
      const failed = await failApp.request('/api/terminal', { method: 'POST', body: { action: 'create' } });
      await check('a failed create removes only its own record and leaves the other terminals running', () => {
        assert.equal(failed.status, 503);
        assert.equal(failed.body.code, 'pty_unavailable');
        assert.equal(failTerminal._sessions.size, 2);
        assert.equal(failSpawned.length, 2);
        assert.equal(failTerminal._sessions.get(first.body.session.id).state, 'running');
        assert.equal(failTerminal._sessions.get(second.body.session.id).state, 'running');
      });
      failNext = false;
      const third = await failApp.request('/api/terminal', { method: 'POST', body: { action: 'create' } });
      await check('create recovers after a failed spawn without renumbering the surviving tabs', () => {
        assert.equal(third.status, 200);
        assert.equal(third.body.session.ordinal, 3);
        assert.equal(failTerminal._sessions.size, 3);
      });
    } finally {
      await failTerminal.dispose();
      await failApp.close();
    }
  }

  {
    /* Per-workspace and global caps count tabs, including exited tabs whose
     * buffers are still visible. Closing an exited tab frees its slot. */
    const capScopes = {
      a: { root: rootA, scopeId: 'cap-a', generation: '1' },
      b: { root: rootB, scopeId: 'cap-b', generation: '1' },
    };
    const capSpawned = [];
    const capTerminal = createTerminal({
      scopeForRequest: async (req) => capScopes[req.headers?.['x-pi-gui-conversation'] || 'a'],
      limits: noSweep({ ...TERMINAL_LIMITS, maxSessions: 3, maxSessionsPerWorkspace: 2 }),
      spawnPty: fakePty(capSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const capApp = await serve({ terminal: capTerminal });
    try {
      const a1 = await capApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'create' } });
      const a2 = await capApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'create' } });
      const a3 = await capApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'create' } });
      const b1 = await capApp.request('/api/terminal', { method: 'POST', headers: scoped('b'), body: { action: 'create' } });
      const b2 = await capApp.request('/api/terminal', { method: 'POST', headers: scoped('b'), body: { action: 'create' } });
      await check('per-workspace and global caps reject without killing existing terminals', () => {
        assert.equal(a1.status, 200);
        assert.equal(a2.status, 200);
        assert.equal(a3.status, 409);
        assert.equal(a3.body.code, 'terminal_limit');
        assert.equal(a3.body.limit, 'workspace');
        assert.equal(b1.status, 200);
        assert.equal(b2.status, 409);
        assert.equal(b2.body.limit, 'global');
        assert.equal(capSpawned.length, 3);
        assert.ok(capSpawned.every((spawn) => spawn.pty.killed === false));
      });

      capSpawned[0].pty.emitExit(0, null);
      await tick(10);
      const blockedByExited = await capApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'create' } });
      const closedExited = await capApp.request('/api/terminal', {
        method: 'POST', headers: scoped('a'), body: { action: 'close', id: a1.body.session.id },
      });
      const a4 = await capApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'create' } });
      const listA = await capApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'list' } });
      await check('an exited tab still occupies its slot until closed, then a new tab gets the next ordinal', () => {
        assert.equal(blockedByExited.status, 409);
        assert.equal(blockedByExited.body.code, 'terminal_limit');
        assert.equal(closedExited.status, 200);
        assert.equal(closedExited.body.closed, true);
        assert.equal(a4.status, 200);
        assert.equal(a4.body.session.ordinal, 3);
        assert.deepEqual(listA.body.sessions.map((session) => session.ordinal), [2, 3]);
      });

      const closeA = await Promise.all([a2, a4].map((result) => capApp.request('/api/terminal', {
        method: 'POST', headers: scoped('a'), body: { action: 'close', id: result.body.session.id },
      })));
      await tick(20);
      const a5 = await capApp.request('/api/terminal', { method: 'POST', headers: scoped('a'), body: { action: 'create' } });
      await check('closing every tab in a workspace resets its tab numbering', () => {
        assert.ok(closeA.every((result) => result.status === 200));
        assert.equal(a5.status, 200);
        assert.equal(a5.body.session.ordinal, 1);
      });
    } finally {
      await capTerminal.dispose();
      await capApp.close();
    }
  }

  {
    /* Classic chat switches folders by incrementing a generation; the folder
     * itself is the stable identity, so returning must find the same PTY. A
     * runtime workspace epoch is deliberately not stable. */
    let stableScope = { root: rootA, scopeId: 'classic-chat', generation: '1', stable: true };
    const stableSpawned = [];
    const stableTerminal = createTerminal({
      scopeForRequest: async () => stableScope,
      scopeForSession: async () => stableScope,
      limits: noSweep(TERMINAL_LIMITS),
      spawnPty: fakePty(stableSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const stableApp = await serve({ terminal: stableTerminal });
    try {
      const first = await stableApp.request('/api/terminal', { method: 'POST', body: { action: 'create' } });
      const id = first.body.session.id;
      stableScope = { ...stableScope, generation: '2' };
      stableSpawned[0].pty.emitData('still-here\r\n');
      const list = await stableApp.request('/api/terminal', { method: 'POST', body: { action: 'list' } });
      const read = await stableApp.request('/api/terminal?' + new URLSearchParams({ id, since: '0' }));
      const input = await stableApp.request('/api/terminal', { method: 'POST', body: { action: 'input', id, data: 'echo back\r' } });
      await check('a stable classic workspace reconnects to the same live PTY after a generation change', () => {
        assert.deepEqual(list.body.sessions.map((session) => session.id), [id]);
        assert.equal(read.body.ok, true);
        assert.equal(read.body.text, 'still-here\r\n');
        assert.equal(input.status, 200);
        assert.deepEqual(stableSpawned[0].pty.writes, ['echo back\r']);
        assert.equal(stableSpawned.length, 1);
      });
    } finally {
      await stableTerminal.dispose();
      await stableApp.close();
    }

    let runtimeScope = { root: rootA, scopeId: 'runtime-epoch', generation: '10' };
    const runtimeSpawned = [];
    const runtimeTerminal = createTerminal({
      scopeForRequest: async () => runtimeScope,
      limits: noSweep(TERMINAL_LIMITS),
      spawnPty: fakePty(runtimeSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const runtimeApp = await serve({ terminal: runtimeTerminal });
    try {
      const first = await runtimeApp.request('/api/terminal', { method: 'POST', headers: scoped('epoch'), body: { action: 'create' } });
      runtimeScope = { ...runtimeScope, generation: '11' };
      const read = await runtimeApp.request('/api/terminal?' + new URLSearchParams({ id: first.body.session.id, since: '0' }), { headers: scoped('epoch') });
      await check('a recreated runtime workspace epoch retires its old shell instead of resurrecting it', () => {
        assert.equal(read.status, 409);
        assert.equal(read.body.code, 'stale_workspace');
        assert.equal(runtimeSpawned[0].pty.killed, true);
      });
    } finally {
      await runtimeTerminal.dispose();
      await runtimeApp.close();
    }
  }

  {
    const floodSpawned = [];
    const floodTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'flood', generation: '1' }),
      limits: noSweep({ ...TERMINAL_LIMITS, maxBufferChars: 1024 }),
      spawnPty: fakePty(floodSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const floodApp = await serve({ terminal: floodTerminal });
    try {
      const created = [];
      for (let i = 0; i < 3; i++) {
        created.push(await floodApp.request('/api/terminal', { method: 'POST', body: { action: 'create' } }));
      }
      const ids = created.map((result) => result.body.session.id);
      for (let i = 0; i < 3; i++) {
        floodSpawned[i].pty.emitData(String.fromCharCode(65 + i).repeat(2000));
      }
      const reads = await Promise.all(ids.map((id) => floodApp.request('/api/terminal?' + new URLSearchParams({ id, since: '0' }))));
      await check('mass output in one terminal is bounded and never bleeds into another', () => {
        for (let i = 0; i < 3; i++) {
          const text = reads[i].body.text;
          assert.equal(reads[i].body.truncated, true);
          assert.equal(text.length, 1024);
          assert.equal(text, String.fromCharCode(65 + i).repeat(1024));
          assert.equal(reads[i].body.cursor, 2000);
        }
      });
    } finally {
      await floodTerminal.dispose();
      await floodApp.close();
    }
  }

  {
    const rapidSpawned = [];
    const rapidTerminal = createTerminal({
      scopeForRequest: async () => ({ root: rootA, scopeId: 'rapid', generation: '1' }),
      limits: noSweep(TERMINAL_LIMITS),
      spawnPty: fakePty(rapidSpawned),
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const rapidApp = await serve({ terminal: rapidTerminal });
    try {
      const created = await Promise.all([0, 1, 2].map(() => rapidApp.request('/api/terminal', {
        method: 'POST', body: { action: 'create' },
      })));
      const ids = created.map((result) => result.body.session.id);
      const closed = await Promise.all(ids.map((id) => rapidApp.request('/api/terminal', {
        method: 'POST', body: { action: 'close', id },
      })));
      await tick(30);
      await check('rapid create/close leaves no session or process behind', () => {
        assert.ok(created.every((result) => result.status === 200));
        assert.ok(closed.every((result) => result.status === 200 && result.body.ok));
        assert.equal(rapidSpawned.length, 3);
        assert.ok(rapidSpawned.every((spawn) => spawn.pty.killed));
        assert.equal(rapidTerminal._sessions.size, 0);
      });

      const live = await Promise.all([0, 1, 2].map(() => rapidApp.request('/api/terminal', {
        method: 'POST', body: { action: 'create' },
      })));
      assert.ok(live.every((result) => result.status === 200));
      const exitPromise = rapidTerminal.dispose();
      await check('app exit kills every workspace terminal and waits for their real exits', async () => {
        await exitPromise;
        assert.equal(rapidTerminal._sessions.size, 0);
        assert.ok(rapidSpawned.slice(-3).every((spawn) => spawn.pty.killed));
      });
    } finally {
      await rapidApp.close();
    }
  }

  await check('Windows kills are identity-gated and never fall back to pty.kill()', () => {
    /* P3-B: a taskkill failure used to retry through node-pty, whose ConPTY
     * agent attaches to the same bare pid and can kill a reused pid. Windows
     * must only ever reach taskkill after an identity match. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'terminal-process.js'), 'utf8');
    const from = src.indexOf('export function defaultKillPty');
    const to = src.indexOf('\n}', from);
    const body = src.slice(from, to);
    assert.ok(from > 0 && to > from, 'defaultKillPty not found');
    assert.match(body, /if \(platform === 'win32'\) return defaultWindowsKillGate\.kill\(pty\)/);
    assert.match(body, /try \{\s*pty\.kill\(\);\s*\}/, 'POSIX pty.kill() branch missing');
    assert.ok(!/fallbackToPty|ptyProcessAlive/.test(src), 'old Windows fallback is back');
    const gateFrom = src.indexOf('export function createWindowsKillGate');
    const gateTo = src.indexOf('const defaultWindowsKillGate', gateFrom);
    assert.ok(gateFrom > 0 && gateTo > gateFrom, 'identity gate not found');
    assert.ok(!/pty\.kill/.test(src.slice(gateFrom, gateTo)), 'identity gate calls pty.kill()');
    assert.match(src.slice(gateFrom, gateTo), /classifyProcessIdentity/);
    assert.match(src.slice(gateFrom, gateTo), /taskkill\(/);
    assert.match(src, /path\.isAbsolute\(envRoot\)/);

    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
    const mainFrom = mainSrc.indexOf('function killServer()');
    const mainBody = mainSrc.slice(mainFrom, mainSrc.indexOf('\n}', mainFrom));
    const clean = mainBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(clean, /classifyProcessIdentity/);
    assert.match(clean, /queryProcessIdentitySync/);
    assert.match(clean, /taskkill\.exe/);
    assert.ok(clean.indexOf('taskkill.exe') < clean.indexOf('server.kill()'), 'taskkill must run before server.kill()');
    assert.match(clean, /path\.isAbsolute\(envRoot\)/);
    /* Removing the match guard must fail this test: taskkill has to be inside
     * the `match` branch, and every other verdict has to log a skip. */
    assert.match(
      clean,
      /if \(verdict === 'match'\) \{[\s\S]*?execFileSync\(taskkill[\s\S]*?\} else \{[\s\S]*?backend_kill_skipped/,
      'taskkill is not conditional on an identity match'
    );
    assert.match(clean, /result: 'taskkill_failed'/, 'a failed taskkill is not distinguished from an identity skip');

    /* The capture callback must compare against the pid captured at spawn,
     * not the mutable module-level server object. The backend can exit before
     * the async query resolves, which would otherwise throw on null. */
    const captureAt = mainSrc.indexOf('processIdentity.captureProcessIdentity(');
    assert.ok(captureAt > 0, 'backend identity capture missing');
    const captureBlock = mainSrc.slice(Math.max(0, captureAt - 500), captureAt + 700);
    assert.match(captureBlock, /const spawnedPid = server\.pid;/, 'capture does not pin the spawned pid');
    assert.match(captureBlock, /serverIdentity\.pid === spawnedPid/, 'capture callback still reads mutable server state');
    assert.ok(!/serverIdentity\.pid === server\.pid/.test(captureBlock), 'capture callback dereferences server after exit');
    assert.match(captureBlock, /\.catch\(/, 'capture rejection is left unhandled');
    assert.match(captureBlock, /if \(process\.platform === 'win32'\)/, 'identity capture is not Windows-gated');

    const contract = require('../lib/log-contract.cjs');
    assert.ok(contract.EVENT_CATALOG['electron.backend_kill_skipped'], 'skip event is not declared in the log contract');
  });

  await check('node-pty is loaded only from app/source directories, never cwd', () => {
    /* The desktop backend's cwd is the user-writable data directory. If the
     * loader searched it, a planted node_modules/node-pty would run arbitrary
     * native code before any auth check. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'terminal-process.js'), 'utf8');
    const from = src.indexOf('function loadNodePty');
    const to = src.indexOf('export function defaultSpawnPty');
    assert.ok(from > 0 && to > from, 'loadNodePty not found');
    const body = src.slice(from, to);
    assert.ok(!/add\s*\(\s*process\.cwd\(\)/.test(body), 'process.cwd() candidate is back');
    assert.ok(/process\.resourcesPath/.test(body), 'packaged app candidate missing');
    assert.ok(/process\.execPath/.test(body), 'SEA executable candidate missing');
    assert.ok(/basename\(here\)\s*===\s*'server'/.test(body), 'parent repo candidate is not source-gated');
  });
  await check('files and terminal never write to the fixture tree', () => {
    assert.equal(fs.readFileSync(path.join(rootA, 'README.md'), 'utf8'), '# Project A\n');
    assert.equal(fs.readFileSync(path.join(rootA, 'src/app.js'), 'utf8'), "console.log('fixture');\n");
  });

  console.log(`\n${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
