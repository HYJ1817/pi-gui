/* Backend contract for the read-only Files surface and the pipe-backed Terminal.
 * Fixtures live in os.tmpdir(); no real shell, pi process or user project is touched. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

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

function fakeShell(record) {
  return ({ cwd, env, platform }) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 424242;
    child.killed = false;
    child.exitCode = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.setEncoding('utf8');
    const writes = [];
    child.stdin.on('data', (chunk) => writes.push(String(chunk)));
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
    };
    record.push({ cwd, env: { ...env }, platform, writes, child });
    return { child, shell: 'fixture-shell' };
  };
}

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
    spawnShell: fakeShell(spawned),
    killTree: (child) => child.kill(),
    platform: 'fixture',
    env: { PATH: 'fixture', PI_GUI_TOKEN: 'must-not-leak', HOME: world },
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
    await check('terminal status advertises the pipe boundary', () => {
      assert.equal(status.status, 200);
      assert.equal(status.body.enabled, true);
      assert.equal(status.body.pipe, true);
    });

    const started = await app.request('/api/terminal', { method: 'POST', headers: scoped(), body: { action: 'start' } });
    await check('start reuses the focused project as cwd and withholds the GUI token', () => {
      assert.equal(started.status, 200);
      assert.equal(started.body.ok, true);
      assert.equal(started.body.session.cwd, rootA.replace(/\\/g, '/'));
      assert.equal(started.body.session.state, 'running');
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0].cwd, fs.realpathSync.native(rootA));
      assert.equal(spawned[0].env.PI_GUI_TOKEN, undefined);
      assert.equal(spawned[0].env.PATH, 'fixture');
    });
    const id = started.body.session.id;
    const fake = spawned[0];

    const input = await app.request('/api/terminal', { method: 'POST', headers: scoped(), body: { action: 'input', id, data: 'echo fixture\n' } });
    await tick();
    await check('input is delivered to the child stdin', () => {
      assert.equal(input.status, 200);
      assert.deepEqual(fake.writes, ['echo fixture\n']);
    });

    fake.child.stdout.write('hello\nworld\n');
    await tick();
    const firstRead = await app.request('/api/terminal?' + new URLSearchParams({ id, since: '0' }), { headers: scoped() });
    const secondRead = await app.request('/api/terminal?' + new URLSearchParams({ id, since: String(firstRead.body.cursor) }), { headers: scoped() });
    await check('reads return only new output and advance an opaque cursor', () => {
      assert.equal(firstRead.status, 200);
      assert.equal(firstRead.body.text, 'hello\nworld\n');
      assert.ok(firstRead.body.cursor > 0);
      assert.equal(secondRead.body.text, '');
    });

    const noAuthInput = await fetch(`http://127.0.0.1:${app.port}/api/terminal`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pi-gui-conversation': 'a' },
      body: JSON.stringify({ action: 'input', id, data: 'x\n' }),
    });
    const nul = await app.request('/api/terminal', { method: 'POST', headers: scoped(), body: { action: 'input', id, data: 'x\0y' } });
    await check('input rejects unauthenticated and NUL payloads', () => {
      assert.equal(noAuthInput.status, 401);
      assert.equal(nul.status, 400);
      assert.equal(nul.body.code, 'invalid_input');
    });

    scopes.a = { root: rootB, scopeId: 'fixture-b', generation: '9' };
    const stale = await app.request('/api/terminal?' + new URLSearchParams({ id, since: '0' }), { headers: scoped() });
    await check('a workspace change stops the old session instead of reading it', async () => {
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'stale_workspace');
      await tick();
      assert.equal(fake.child.killed, true);
    });
    scopes.a = { root: rootA, scopeId: 'fixture-a', generation: '1' };

    const restarted = await app.request('/api/terminal', { method: 'POST', headers: scoped(), body: { action: 'start' } });
    await check('a stopped workspace can start a fresh session', () => {
      assert.equal(restarted.status, 200);
      assert.notEqual(restarted.body.session.id, id);
    });
    const stopped = await app.request('/api/terminal', { method: 'POST', headers: scoped(), body: { action: 'stop', id: restarted.body.session.id } });
    await check('stop ends the session through the injected kill path', async () => {
      assert.equal(stopped.status, 200);
      await tick();
      assert.equal(spawned.at(-1).child.killed, true);
    });

    const noProjectTerminal = await app.request('/api/terminal', { method: 'POST', headers: scoped('none'), body: { action: 'start' } });
    await check('terminal start reports noProject without spawning', () => {
      assert.equal(noProjectTerminal.status, 200);
      assert.equal(noProjectTerminal.body.noProject, true);
      assert.equal(spawned.length, 2);
    });
    await check('terminal limits keep the surface bounded', () => {
      assert.equal(TERMINAL_LIMITS.maxSessions, 2);
      assert.equal(TERMINAL_LIMITS.maxBufferChars, 256 * 1024);
      assert.equal(TERMINAL_LIMITS.maxInputBytes, 16 * 1024);
    });
  } finally {
    terminal.dispose();
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
    limits: { ...TERMINAL_LIMITS, maxBufferChars: 64, idleMs: 30 },
    spawnShell: fakeShell(smallSpawned),
    killTree: (child) => child.kill(),
    platform: 'fixture',
  });
  const smallApp = await serve({ terminal: small });
  try {
    const started = await smallApp.request('/api/terminal', { method: 'POST', body: { action: 'start' } });
    const flood = '0123456789'.repeat(10);
    smallSpawned[0].child.stdout.write(flood);
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
    });
  } finally {
    small.dispose();
    await smallApp.close();
  }

  await check('files and terminal never write to the fixture tree', () => {
    assert.equal(fs.readFileSync(path.join(rootA, 'README.md'), 'utf8'), '# Project A\n');
    assert.equal(fs.readFileSync(path.join(rootA, 'src/app.js'), 'utf8'), "console.log('fixture');\n");
  });

  console.log(`\n${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
