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
      assert.equal(status.body.maxSessions, 2);
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
      assert.equal(stopped.body.session.state, 'stopping');
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
      assert.equal(TERMINAL_LIMITS.maxSessions, 2);
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
        if (scopeAnswer === 'throw') throw Object.assign(new Error('unknown_conversation'), { code: 'unknown_conversation' });
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
      limits: { ...TERMINAL_LIMITS, scopeSweepMs: 20 },
      spawnPty: () => stubborn,
      killPty: (pty) => pty.kill(),
      platform: 'fixture',
    });
    const stubbornApp = await serve({ terminal: stubbornTerminal });
    const started = await stubbornApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    const id = started.body.session.id;
    const stopResult = await stubbornApp.request('/api/terminal', { method: 'POST', body: { action: 'stop', id } });
    assert.equal(stopResult.body.session.state, 'stopping');
    const beforeRetry = killCalls;
    await tick(150);
    await check('sweep retries a wedged stop without faking the exit state', () => {
      assert.ok(killCalls > beforeRetry, `kill retried ${killCalls - beforeRetry} times`);
      assert.equal(stubbornTerminal._sessions.get(id).state, 'stopping');
    });
    stubborn.emitExit();
    await tick(10);
    await stubbornTerminal.dispose();
    await stubbornApp.close();
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
    /* Regression for the ConPTY helper crash: once the shell is gone,
     * node-pty's pty.kill() forks conpty_console_list_agent.js, which calls
     * AttachConsole on the dead pid and prints an "AttachConsole failed" stack
     * trace. defaultKillPty only falls back to the PTY handle when this probe
     * says the shell is still alive, so the probe itself must be honest. */
    const { ptyProcessAlive } = await import('../server/terminal.js');
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await check('ptyProcessAlive separates a live shell from a dead pid', async () => {
      try {
        assert.equal(ptyProcessAlive({ pid: child.pid }), true);
        assert.equal(ptyProcessAlive({ pid: 0 }), false);
        assert.equal(ptyProcessAlive(null), false);
        const gone = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await gone;
        for (let i = 0; i < 50 && ptyProcessAlive({ pid: child.pid }); i++) await tick(20);
        assert.equal(ptyProcessAlive({ pid: child.pid }), false, 'exited pid still reads alive');
      } finally {
        try { child.kill(); } catch { /* already gone */ }
      }
    });
  }

  await check('the Windows tree-kill fallback is one-shot and ignores a relative SystemRoot', () => {
    /* spawn() emits both `error` and a non-zero `close` when taskkill is
     * missing. Without a one-shot guard the second signal calls pty.kill()
     * again after the ConPTY agent already attached; with a relative
     * SystemRoot the executable would even be resolved against cwd. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'terminal.js'), 'utf8');
    const from = src.indexOf('export function defaultKillPty');
    const to = src.indexOf('export function createTerminal');
    const body = src.slice(from, to);
    assert.ok(from > 0 && to > from, 'defaultKillPty not found');
    assert.match(body, /let fellBack = false;/);
    assert.match(body, /if \(fellBack\) return;/);
    assert.match(body, /path\.isAbsolute\(envRoot\)/);
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
    const mainFrom = mainSrc.indexOf('function killServer()');
    const mainBody = mainSrc.slice(mainFrom, mainSrc.indexOf('\n}', mainFrom));
    assert.match(mainBody, /path\.isAbsolute\(envRoot\)/);
  });

  await check('node-pty is loaded only from app/source directories, never cwd', () => {
    /* The desktop backend's cwd is the user-writable data directory. If the
     * loader searched it, a planted node_modules/node-pty would run arbitrary
     * native code before any auth check. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'terminal.js'), 'utf8');
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
