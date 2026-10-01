/* P20.6 Native MCP 状态与受控动作的离线契约（P20.6-Fix 版）。
 *
 * 完全离线：不启动 pi、不起真实 MCP server、不联网、不 OAuth、不读用户真实目录。
 * `pi mcp list --json` 与各动作的执行一律注入假 runCli；配置文件全在 os.tmpdir()。
 *
 * 契约核对对象：**pi 0.99.2** 发布包（`dist/core/mcp-servers.d.ts`、
 * `dist/extensions/mcp/{cli,config,runtime,tools}.d.ts`、`docs/mcp.md`）。
 *
 * 覆盖：
 *   A. cache / workspace isolation —— 缓存绑定 (cwd, launch identity)
 *   B. project trust —— project 写操作的闸门 + 项目 settings 的信任前提
 *   C. secret API contract —— 凭据值在 HTTP 边界即拒绝，永不进 argv
 *   D. Pi 0.99.2 fixture / schema —— 新字段、别名、note
 *   E. unknown enum / schema fallback —— 闭集外一律折成 unknown，不原样投影
 *   F. 配置安全解析、入口派生、状态机、refresh、动作 argv、前端语义（回归）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const checkAsync = async (name, fn) => { await fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

/** 契约基线：本轮核对的 pi 正式版。fixture 的包版本与它保持一致。 */
const PI_BASELINE = '0.99.2';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-mcpnat-'));
const AGENT = path.join(TMP, 'agent');
fs.mkdirSync(AGENT, { recursive: true });

/* ---------- fixture：假 pi 包 ---------- */
function mkPkg(name, version = PI_BASELINE) {
  const dir = path.join(TMP, name, 'pkg');
  fs.mkdirSync(path.join(dir, 'dist', 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version, bin: { pi: 'dist/bundle/cli.js' } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'dist', 'bundle', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  return dir;
}
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v), 'utf8');
const rmFile = (f) => { try { fs.rmSync(f, { force: true }); } catch { /* noop */ } };

/* ---------- 极简 req/res 替身（与 skills.cjs 同一写法） ---------- */
function mockRes() {
  return {
    code: null, chunks: [], ended: false,
    writeHead(code, headers) { this.code = code; return this; },
    write(s) { this.chunks.push(String(s)); return true; },
    end(s) { if (s) this.chunks.push(String(s)); this.ended = true; },
    body() { return this.chunks.join(''); },
    jsonBody() { try { return JSON.parse(this.body()); } catch { return null; } },
  };
}
function mockReq({ method = 'GET', body = '' } = {}) {
  const listeners = new Map();
  const req = {
    method,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); return this; },
    emit(ev, arg) { for (const fn of listeners.get(ev) || []) fn(arg); },
  };
  req._body = typeof body === 'string' ? body : JSON.stringify(body);
  return req;
}
async function callServers(mod, { method = 'GET', body = null } = {}) {
  const req = mockReq({ method, body: body === null ? '' : body });
  const res = mockRes();
  const p = mod.handleServers(req, res);
  setImmediate(() => { req.emit('data', Buffer.from(req._body)); req.emit('end'); });
  await p;
  await new Promise((r) => setImmediate(r));
  return res.jsonBody();
}
async function callStatus(mod, { method = 'GET', body = null } = {}) {
  const req = mockReq({ method, body: body === null ? '' : body });
  const res = mockRes();
  const p = mod.handleStatus(req, res);
  setImmediate(() => { req.emit('data', Buffer.from(req._body)); req.emit('end'); });
  await p;
  await new Promise((r) => setImmediate(r));
  return { code: res.code, json: res.jsonBody() };
}

/** 可变 cwd 的 runtime 替身（切项目测试要它）。 */
const mkRuntimeBox = (initial = null) => {
  const box = { cwd: initial };
  return { runtime: { getCurrentCwd: () => box.cwd }, box };
};
const mkRuntime = (cwd) => mkRuntimeBox(cwd).runtime;
const noTrust = async () => ({ trusted: true, requiresTrust: false });
const okRun = async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnFailed: false });

function mkNative(over = {}) {
  const calls = [];
  const runCli = over.runCli || okRun;
  const wrapped = async (entry, args, opts) => { calls.push({ entry, args, opts }); return runCli(entry, args, opts); };
  const mod = over.create({
    runtime: over.runtime || mkRuntime(over.cwd || null),
    env: over.env || { HOME: TMP, PI_CODING_AGENT_DIR: AGENT },
    resolvePackageDir: over.resolvePackageDir || (() => null),
    resolveLaunchIdentity: over.resolveLaunchIdentity || null,
    readTrust: over.readTrust || noTrust,
    rpc: over.rpc || null,
    runCli: wrapped,
    piBuiltins: over.piBuiltins || null,
    readSettingsExt: over.readSettingsExt || null,
    now: over.now || (() => 1000),
    ttlMs: over.ttlMs || 60000,
  });
  return { mod, calls };
}

(async () => {
  const native = await import('../server/mcp-native.js');
  const { createMcpNative, parseMcpServers, buildPiEntry } = native;
  const withCreate = (over) => mkNative({ ...over, create: createMcpNative });

  const PROJ = path.join(TMP, 'proj');
  const PROJ_B = path.join(TMP, 'proj-b');
  fs.mkdirSync(path.join(PROJ, '.pi'), { recursive: true });
  fs.mkdirSync(path.join(PROJ_B, '.pi'), { recursive: true });

  /* ===================================================================
   * A. cache / workspace isolation（P20.6-Fix §一）
   * =================================================================== */
  section('A. cache 绑定 workspace：切项目不串状态');
  {
    const A = mkRuntimeBox(PROJ);
    const identity = { v: 'id-1' };
    let listRuns = 0;
    const { mod } = withCreate({
      runtime: A.runtime,
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('iso-pkg'),
      resolveLaunchIdentity: () => identity.v,
      rpc: { request: async () => ({ commands: [] }) },
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      runCli: async () => {
        listRuns++;
        return { ok: true, exitCode: 0, stdout: JSON.stringify({ servers: [{ name: 'a-only', scope: 'global', enabled: true, state: 'connected', transport: '/bin/a', tools: ['t'] }], errors: [] }), stderr: '', timedOut: false, spawnFailed: false };
      },
    });

    const r1 = await mod.refresh();
    check('A1. A 项目刷新拿到 runtime（a-only / connected）', () => {
      assert.equal(r1.ok, true);
      assert.equal(r1.servers[0].name, 'a-only');
      assert.equal(r1.servers[0].state, 'connected');
      assert.equal(listRuns, 1);
    });
    check('A2. 同一 workspace 的 GET 看得到缓存视图', async () => {
      const st = await callStatus(mod, { method: 'GET' });
      assert.equal(st.json.status.cached, true);
      assert.equal(st.json.status.servers[0].name, 'a-only');
    });

    // —— 切到 B ——
    A.box.cwd = PROJ_B;
    check('A3. 切到 B 后 runtime 回到「未刷新」（绝不出现 A 的 server）', () => {
      assert.equal(mod.peekStatus(), null);
    });
    await checkAsync('A4. 切到 B 后 GET /status 也不给 A 的状态', async () => {
      const st = await callStatus(mod, { method: 'GET' });
      assert.equal(st.json.ok, true);
      assert.equal(st.json.status, null);
    });
    await checkAsync('A5. 切到 B 后 B 的摘要里没有 A 的 runtime 状态', async () => {
      const j = await callServers(mod, { method: 'GET' });
      assert.equal(j.runtime, null);
    });
    await checkAsync('A6. 切到 B 后刷新会重新跑 list（不复用 A 的 TTL 缓存）', async () => {
      const r2 = await mod.refresh();
      assert.equal(listRuns, 2);
      assert.notEqual(r2.cached, true);
    });
    check('A7. 切回 A 也不复用（A 的缓存已被 B 覆盖，键不同即失效）', async () => {
      A.box.cwd = PROJ;
      assert.equal(mod.peekStatus(), null);
    });
  }
  await checkAsync('A8. A replaced=true → 切 B → B 重新 probe（replaced 不串过去）', async () => {
    const A = mkRuntimeBox(PROJ);
    let probes = 0;
    let extensionRegistered = true;
    const { mod } = withCreate({
      runtime: A.runtime,
      resolvePackageDir: () => mkPkg('iso-rep'),
      resolveLaunchIdentity: () => 'id-x',
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => { probes++; return extensionRegistered ? { commands: [{ name: 'mcp', source: 'extension' }] } : { commands: [] }; } },
    });
    assert.equal((await mod.summary()).native.state, 'replaced');
    const afterA = probes;
    assert.ok(afterA >= 1);
    // 切到 B：B 的 session 里没有扩展接管 /mcp
    A.box.cwd = PROJ_B;
    extensionRegistered = false;
    const sB = await mod.summary();
    assert.ok(probes > afterA, 'B 必须重新 probe get_commands');
    assert.equal(sB.native.state, 'active', 'B 不能继承 A 的 replaced=true');
  });
  await checkAsync('A9. 同 cwd + 同 identity，TTL 内复用（不重复跑 list）', async () => {
    let runs = 0;
    let t = 1000;
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('ttl-pkg'),
      resolveLaunchIdentity: () => 'id-t',
      now: () => t,
      ttlMs: 60000,
      runCli: async () => { runs++; return { ok: true, exitCode: 0, stdout: '{"servers":[],"errors":[]}', stderr: '', timedOut: false, spawnFailed: false }; },
    });
    await mod.refresh();
    t += 30_000;
    const second = await mod.refresh();
    assert.equal(second.cached, true);
    assert.equal(runs, 1);
    // 过期后重跑
    t += 40_000;
    await mod.refresh();
    assert.equal(runs, 2);
  });
  await checkAsync('A10. launch identity 变化 → 不复用旧 cache', async () => {
    const identity = { v: 'pi-install-A' };
    let runs = 0;
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('id-pkg'),
      resolveLaunchIdentity: () => identity.v,
      runCli: async () => { runs++; return { ok: true, exitCode: 0, stdout: '{"servers":[],"errors":[]}', stderr: '', timedOut: false, spawnFailed: false }; },
    });
    await mod.refresh();
    assert.equal(runs, 1);
    assert.equal(mod.peekStatus().cached, true);
    // 换了 pi 实例（PI_BIN 变了 / 换了包）→ 旧结论作废
    identity.v = 'pi-install-B';
    assert.equal(mod.peekStatus(), null, '换 pi 实例后旧 runtime 状态必须不可见');
    await mod.refresh();
    assert.equal(runs, 2, '换 pi 实例后必须重新跑 list');
  });
  await checkAsync('A11. reset() 同时清空 runtime 与 command probe', async () => {
    let probes = 0;
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('reset-pkg'),
      resolveLaunchIdentity: () => 'id-r',
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => { probes++; return { commands: [] }; } },
      runCli: async () => ({ ok: true, exitCode: 0, stdout: '{"servers":[],"errors":[]}', stderr: '', timedOut: false, spawnFailed: false }),
    });
    await mod.summary();
    await mod.refresh();
    assert.equal(probes, 1);
    assert.ok(mod.peekStatus() !== null);
    assert.ok(mod.peekSummary() !== null);
    mod.reset();
    assert.equal(mod.peekStatus(), null, 'reset 清 runtime');
    assert.equal(mod.peekSummary(), null, 'reset 清摘要');
    await mod.summary();
    assert.equal(probes, 2, 'reset 后 command probe 必须重跑');
  });
  await checkAsync('A12. 没有 launch identity 注入时，缓存仍按 cwd 隔离（不塌成全局）', async () => {
    const A = mkRuntimeBox(PROJ);
    const { mod } = withCreate({
      runtime: A.runtime,
      resolvePackageDir: () => mkPkg('noid-pkg'),
      runCli: async () => ({ ok: true, exitCode: 0, stdout: '{"servers":[{"name":"a-only","scope":"global","enabled":true,"state":"connected","transport":"/bin/a","tools":[]}],"errors":[]}', stderr: '', timedOut: false, spawnFailed: false }),
    });
    await mod.refresh();
    assert.ok(mod.peekStatus() !== null);
    A.box.cwd = PROJ_B;
    assert.equal(mod.peekStatus(), null);
  });

  /* ===================================================================
   * B. project trust（P20.6-Fix §二）
   * =================================================================== */
  section('B. project trust：写操作闸门 + 项目 settings 前提');
  const untrusted = async () => ({ trusted: false, requiresTrust: true });
  const trusted = async () => ({ trusted: true, requiresTrust: true });
  const unknownTrust = async () => null; // readTrust 拿不到 → 三值里的 null

  await checkAsync('B1. 未信任项目 + project add → 拒绝，runCli 0 次', async () => {
    const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('t1'), readTrust: untrusted });
    const r = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'x', scope: 'project', transport: 'stdio', command: 'npx', expectedCwd: PROJ } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'project-untrusted');
    assert.equal(calls.length, 0);
  });
  await checkAsync('B2. 未信任项目 + project remove → 拒绝，runCli 0 次', async () => {
    const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('t2'), readTrust: untrusted });
    const r = await callServers(mod, { method: 'POST', body: { action: 'remove', name: 'x', scope: 'project', expectedCwd: PROJ } });
    assert.equal(r.code, 'project-untrusted');
    assert.equal(calls.length, 0);
  });
  await checkAsync('B3. 已信任项目 → project add / remove 正常落到 pi CLI', async () => {
    const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('t3'), readTrust: trusted });
    const add = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'x', scope: 'project', transport: 'stdio', command: 'npx', expectedCwd: PROJ } });
    assert.equal(add.ok, true);
    assert.deepEqual(calls[0].args, ['mcp', 'add', 'x', '-l', '--', 'npx']);
    const rm = await callServers(mod, { method: 'POST', body: { action: 'remove', name: 'x', scope: 'project', expectedCwd: PROJ } });
    assert.equal(rm.ok, true);
    assert.deepEqual(calls[1].args, ['mcp', 'remove', 'x', '-l']);
  });
  await checkAsync('B4. 未信任项目下 user scope add / remove 仍可用', async () => {
    const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('t4'), readTrust: untrusted });
    const add = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'u', scope: 'user', transport: 'stdio', command: 'npx', expectedCwd: PROJ } });
    assert.equal(add.ok, true);
    assert.deepEqual(calls[0].args, ['mcp', 'add', 'u', '--', 'npx']);
    const rm = await callServers(mod, { method: 'POST', body: { action: 'remove', name: 'u', scope: 'user', expectedCwd: PROJ } });
    assert.equal(rm.ok, true);
    assert.deepEqual(calls[1].args, ['mcp', 'remove', 'u']);
  });
  await checkAsync('B5. trust 拿不到（null）→ project 写操作 fail closed', async () => {
    const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('t5'), readTrust: unknownTrust });
    const add = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'x', scope: 'project', transport: 'stdio', command: 'npx', expectedCwd: PROJ } });
    assert.equal(add.code, 'project-untrusted');
    assert.equal(calls.length, 0);
    const rm = await callServers(mod, { method: 'POST', body: { action: 'remove', name: 'x', scope: 'project', expectedCwd: PROJ } });
    assert.equal(rm.code, 'project-untrusted');
    assert.equal(calls.length, 0);
    // 同一状态下 user scope 照常
    const u = await callServers(mod, { method: 'POST', body: { action: 'remove', name: 'u', scope: 'user', expectedCwd: PROJ } });
    assert.equal(u.ok, true);
    assert.equal(calls.length, 1);
  });
  await checkAsync('B6. trust 抛异常 → 也 fail closed（不当成 true）', async () => {
    const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('t6'), readTrust: async () => { throw new Error('boom'); } });
    const r = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'x', scope: 'project', transport: 'stdio', command: 'npx', expectedCwd: PROJ } });
    assert.equal(r.code, 'project-untrusted');
    assert.equal(calls.length, 0);
  });
  await checkAsync('B7. 未信任项目的 .pi/settings.json 里 -builtin:mcp 不影响 native 状态', async () => {
    writeJson(path.join(PROJ_B, '.pi', 'settings.json'), { extensions: ['-builtin:mcp'] });
    rmFile(path.join(AGENT, 'settings.json'));
    const { mod } = withCreate({
      cwd: PROJ_B,
      resolvePackageDir: () => mkPkg('t7'),
      readTrust: untrusted,
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => ({ commands: [] }) },
    });
    const s = await mod.summary();
    assert.equal(s.native.state, 'active', '未信任项目的 settings 不该被读进来');
    assert.equal(s.native.disabled, null);
  });
  await checkAsync('B8. 已信任项目的 .pi/settings.json 里 -builtin:mcp → disabled', async () => {
    const { mod } = withCreate({
      cwd: PROJ_B,
      resolvePackageDir: () => mkPkg('t8'),
      readTrust: trusted,
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => ({ commands: [] }) },
    });
    const s = await mod.summary();
    assert.equal(s.native.state, 'disabled');
    assert.equal(s.native.disabled, true);
  });
  await checkAsync('B9. trust 未知 → 项目 settings 同样不参与（不下结论）', async () => {
    const { mod } = withCreate({
      cwd: PROJ_B,
      resolvePackageDir: () => mkPkg('t9'),
      readTrust: unknownTrust,
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => ({ commands: [] }) },
    });
    const s = await mod.summary();
    assert.equal(s.native.state, 'active');
    assert.equal(s.native.disabled, null);
  });
  await checkAsync('B10. user settings 与 trusted project settings 的覆盖关系正确', async () => {
    // 用户级：关掉；项目级（已信任）：打开 → 项目覆盖用户
    writeJson(path.join(AGENT, 'settings.json'), { extensions: ['-builtin:mcp'] });
    writeJson(path.join(PROJ_B, '.pi', 'settings.json'), { extensions: ['+builtin:mcp'] });
    const base = { resolvePackageDir: () => mkPkg('t10'), piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }), rpc: { request: async () => ({ commands: [] }) } };
    const trustedMod = withCreate({ ...base, cwd: PROJ_B, readTrust: trusted }).mod;
    assert.equal((await trustedMod.summary()).native.state, 'active', '项目 +builtin:mcp 覆盖用户 -builtin:mcp');
    // 同一份文件，项目未信任 → 只剩用户级结论（disabled）
    const untrustedMod = withCreate({ ...base, cwd: PROJ_B, readTrust: untrusted }).mod;
    assert.equal((await untrustedMod.summary()).native.state, 'disabled', '未信任时退回用户级设置');
    // 项目 settings 里没有 mcp 条目时，退回用户级
    writeJson(path.join(PROJ_B, '.pi', 'settings.json'), { extensions: ['+other-ext'] });
    assert.equal((await trustedMod.summary()).native.state, 'disabled', '项目没写 mcp → 用用户级');
    writeJson(path.join(AGENT, 'settings.json'), { extensions: [] });
    rmFile(path.join(PROJ_B, '.pi', 'settings.json'));
  });
  await checkAsync('B11. 未信任 / 未知信任时，项目条目一律不标成「生效」', async () => {
    writeJson(path.join(PROJ, '.pi', 'mcp.json'), { mcpServers: { ponly: { command: 'c' } } });
    const base = { cwd: PROJ, resolvePackageDir: () => mkPkg('t11'), piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }), rpc: { request: async () => ({ commands: [] }) } };
    const un = await withCreate({ ...base, readTrust: untrusted }).mod.summary();
    assert.equal(un.servers.find((x) => x.name === 'ponly').effective.reason, 'untrusted');
    assert.equal(un.trust.trusted, false);
    const unk = await withCreate({ ...base, readTrust: unknownTrust }).mod.summary();
    assert.equal(unk.servers.find((x) => x.name === 'ponly').effective.reason, 'trust-unknown');
    assert.equal(unk.servers.find((x) => x.name === 'ponly').effective.active, false);
    assert.equal(unk.trust, null, 'trust 三值里的 null 要如实透出，不能塌成 false');
    const tr = await withCreate({ ...base, readTrust: trusted }).mod.summary();
    assert.equal(tr.servers.find((x) => x.name === 'ponly').effective.active, true);
    rmFile(path.join(PROJ, '.pi', 'mcp.json'));
  });

  /* ===================================================================
   * C. secret API contract（P20.6-Fix §三）
   * =================================================================== */
  section('C. secret contract：凭据值在 HTTP 边界即拒绝');
  const SECRETS = ['TOP-SECRET-HDR', 'TOP-SECRET-OAUTH', 'TOP-SECRET-ENV', 'TOP-SECRET-BEARER', 'TOP-SECRET-TOKEN'];
  {
    const httpBase = { action: 'add', name: 's', scope: 'user', transport: 'http', url: 'https://e.com/m', expectedCwd: PROJ };
    const stdioBase = { action: 'add', name: 's', scope: 'user', transport: 'stdio', command: 'npx', expectedCwd: PROJ };

    await checkAsync('C1. header value → reject（不调 runCli、不回显值）', async () => {
      const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s1') });
      const r = await callServers(mod, { method: 'POST', body: { ...httpBase, headers: [{ key: 'Authorization', value: `Bearer ${SECRETS[0]}` }] } });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'secret-input-unsupported');
      assert.equal(r.field, 'headers[].value');
      assert.equal(calls.length, 0);
      assert.ok(!JSON.stringify(r).includes('TOP-SECRET'));
    });
    await checkAsync('C2. oauth.clientSecret → reject', async () => {
      const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s2') });
      const r = await callServers(mod, { method: 'POST', body: { ...httpBase, oauth: { clientSecret: SECRETS[1] } } });
      assert.equal(r.code, 'secret-input-unsupported');
      assert.equal(r.field, 'oauth.clientSecret');
      assert.equal(calls.length, 0);
      assert.ok(!JSON.stringify(r).includes('TOP-SECRET'));
    });
    await checkAsync('C3. oauth 整块（含 clientId / callbackPort）→ reject', async () => {
      const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s3') });
      const r = await callServers(mod, { method: 'POST', body: { ...httpBase, oauth: { clientId: 'cid', callbackPort: 1234 } } });
      assert.equal(r.code, 'secret-input-unsupported');
      assert.equal(r.field, 'oauth');
      assert.equal(calls.length, 0);
    });
    await checkAsync('C4. env value → reject', async () => {
      const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s4') });
      const r = await callServers(mod, { method: 'POST', body: { ...stdioBase, env: [{ key: 'API_KEY', value: SECRETS[2] }] } });
      assert.equal(r.code, 'secret-input-unsupported');
      assert.equal(r.field, 'env[].value');
      assert.equal(calls.length, 0);
      assert.ok(!JSON.stringify(r).includes('TOP-SECRET'));
    });
    await checkAsync('C5. Authorization 明文（换名字直传）→ reject', async () => {
      const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s5') });
      for (const k of ['authorization', 'Authorization', 'token', 'accessToken', 'refreshToken', 'apiKey', 'secret', 'password']) {
        const r = await callServers(mod, { method: 'POST', body: { ...httpBase, [k]: SECRETS[3] } });
        assert.equal(r.code, 'secret-input-unsupported', `${k} 必须被拒`);
        assert.ok(!JSON.stringify(r).includes('TOP-SECRET'), `${k} 的值不能回显`);
      }
      assert.equal(calls.length, 0);
    });
    await checkAsync('C6. auth（0.99.2 的 provider token 引用）→ reject', async () => {
      const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s6') });
      const r = await callServers(mod, { method: 'POST', body: { ...httpBase, auth: { provider: 'anthropic' } } });
      assert.equal(r.code, 'secret-input-unsupported');
      assert.equal(r.field, 'auth');
      assert.equal(calls.length, 0);
    });
    await checkAsync('C7. 原始 headers 对象 / env 对象 → reject', async () => {
      const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s7') });
      const h = await callServers(mod, { method: 'POST', body: { ...httpBase, headers: { Authorization: `Bearer ${SECRETS[0]}` } } });
      assert.equal(h.code, 'secret-input-unsupported');
      const e = await callServers(mod, { method: 'POST', body: { ...stdioBase, env: { API_KEY: SECRETS[2] } } });
      assert.equal(e.code, 'secret-input-unsupported');
      assert.equal(calls.length, 0);
    });
    await checkAsync('C8. bearerTokenEnvVar 只传变量名 → 允许，且 argv 里没有 secret value', async () => {
      const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s8') });
      const r = await callServers(mod, { method: 'POST', body: { ...httpBase, bearerTokenEnvVar: 'GITHUB_TOKEN' } });
      assert.equal(r.ok, true);
      assert.deepEqual(calls[0].args, ['mcp', 'add', 's', '--url', 'https://e.com/m', '--bearer-token-env-var', 'GITHUB_TOKEN']);
      assert.ok(!JSON.stringify(calls[0].args).includes('TOP-SECRET'));
      assert.ok(!JSON.stringify(r).includes('TOP-SECRET'));
    });
    await checkAsync('C9. bearerTokenEnvVar 不是合法环境变量名 → reject', async () => {
      const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s9') });
      const r = await callServers(mod, { method: 'POST', body: { ...httpBase, bearerTokenEnvVar: `Bearer ${SECRETS[3]}` } });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'bad-env-var');
      assert.equal(calls.length, 0);
      assert.ok(!JSON.stringify(r).includes('TOP-SECRET'));
    });
    await checkAsync('C10. 干净 payload 的 success 响应不含配置原文', async () => {
      const { mod } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s10') });
      const r = await callServers(mod, { method: 'POST', body: { ...stdioBase, args: ['-y', 'pkg'], description: 'A demo server' } });
      assert.equal(r.ok, true);
      assert.deepEqual(Object.keys(r).sort(), ['code', 'error', 'name', 'ok', 'scope']);
      assert.ok(!JSON.stringify(r).includes('npx'));
      assert.ok(!JSON.stringify(r).includes('A demo server'));
    });
    await checkAsync('C11. 被拒 payload 的 secret 不出现在任何响应字段里', async () => {
      const { mod } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('s11') });
      const bodies = [
        { ...httpBase, headers: [{ key: 'Authorization', value: SECRETS[0] }] },
        { ...httpBase, oauth: { clientSecret: SECRETS[1] } },
        { ...stdioBase, env: [{ key: 'K', value: SECRETS[2] }] },
        { ...httpBase, token: SECRETS[4] },
      ];
      for (const b of bodies) {
        const r = await callServers(mod, { method: 'POST', body: b });
        assert.ok(!JSON.stringify(r).includes('TOP-SECRET'), JSON.stringify(r));
      }
    });
  }
  await checkAsync('C12. mcp-auth.json 从不读取（含 token 的文件一个字节都不进报告）', async () => {
    const authFile = path.join(AGENT, 'mcp-auth.json');
    writeJson(authFile, { tokens: { docs: { access_token: 'AUTH-FILE-SECRET-1', refresh_token: 'AUTH-FILE-SECRET-2' } } });
    writeJson(path.join(AGENT, 'mcp.json'), { mcpServers: { docs: { url: 'https://e.com/m', headers: { Authorization: 'Bearer HDR-SECRET-3' }, oauth: { clientId: 'cid', clientSecret: 'OAUTH-SECRET-4' }, description: 'docs server' } } });
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('s12'),
      readTrust: trusted,
      runCli: async () => ({
        ok: true, exitCode: 0,
        stdout: JSON.stringify({
          servers: [{ name: 'docs', scope: 'global', source: path.join(AGENT, 'mcp.json'), enabled: true, exposure: 'codemode', transport: 'https://e.com/m', state: 'needs-auth', tools: [], error: 'auth needed at ' + AGENT }],
          errors: [`bad entry in ${path.join(AGENT, 'mcp.json')}`],
          note: `${path.join(PROJ, '.pi', 'mcp.json')} is ignored because the project is not trusted.`,
        }),
        stderr: '', timedOut: false, spawnFailed: false,
      }),
    });
    const s = await mod.summary();
    const r = await mod.refresh();
    const blob = JSON.stringify(s) + JSON.stringify(r);
    for (const secret of ['AUTH-FILE-SECRET-1', 'AUTH-FILE-SECRET-2', 'HDR-SECRET-3', 'OAUTH-SECRET-4']) {
      assert.ok(!blob.includes(secret), `${secret} 泄漏了`);
    }
    assert.ok(!blob.includes(AGENT), 'agent 目录绝对路径不能出报告');
    assert.ok(!blob.includes(PROJ), '项目绝对路径不能出报告');
    assert.ok(blob.includes('<agent-dir>') || blob.includes('<project>'), '错误/note 文本要脱敏');
    rmFile(authFile);
    rmFile(path.join(AGENT, 'mcp.json'));
  });

  /* ===================================================================
   * D. Pi 0.99.2 fixture / schema
   * =================================================================== */
  section('D. Pi 0.99.2 契约：新字段、别名、note');
  {
    const r = parseMcpServers({ mcpServers: {
      legacy: { command: 'x', exposure: 'codemode-deferred' },
      desc: { command: 'y', description: '  A   multi\nline   description  ' },
      provider: { url: 'https://e.com/m', auth: { provider: 'anthropic' } },
      withRes: { command: 'z', timeout: 30 },
    } });
    check('D1. `codemode-deferred` 是 codemode 的别名（0.99.2 归一）', () => {
      assert.equal(r.servers.find((s) => s.name === 'legacy').exposure, 'codemode');
    });
    check('D2. description 单行化 + 截断', () => {
      assert.equal(r.servers.find((s) => s.name === 'desc').description, 'A multi line description');
    });
    check('D3. `auth`（provider token 引用）计入 hasSecrets', () => {
      assert.equal(r.servers.find((s) => s.name === 'provider').hasSecrets, true);
    });
    check('D4. 未知顶层键（timeout）不改变解析结果', () => {
      const s = r.servers.find((x) => x.name === 'withRes');
      assert.equal(s.enabled, true);
      assert.equal(s.transportType, 'stdio');
      assert.ok(!JSON.stringify(s).includes('timeout'));
    });
    check('D5. 别名在 toolExposure 值里同样归一', () => {
      const t = parseMcpServers({ mcpServers: { x: { command: 'a', toolExposure: { 't*': 'codemode-deferred', k: 'direct' } } } });
      assert.deepEqual(t.servers[0].toolExposure, { 't*': 'codemode', k: 'direct' });
    });
  }
  await checkAsync('D6. refresh 接受 0.99.2 的 resources / resourceTemplates / toolExposure / note', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('d6'),
      runCli: async () => ({
        ok: true, exitCode: 0,
        stdout: JSON.stringify({
          servers: [{
            name: 'r', scope: 'global', source: '/x/mcp.json', enabled: true, exposure: 'codemode',
            transport: '/bin/r', state: 'connected', tools: ['read_file'],
            toolExposure: { read_file: 'direct' }, resources: 3, resourceTemplates: 1,
          }],
          errors: [],
          note: `ignored at ${PROJ}`,
        }),
        stderr: '', timedOut: false, spawnFailed: false,
      }),
    });
    const j = await mod.refresh();
    const s = j.servers[0];
    assert.equal(s.resources, 3);
    assert.equal(s.resourceTemplates, 1);
    assert.deepEqual(s.toolExposure, { read_file: 'direct' });
    assert.equal(s.state, 'connected');
    assert.ok(!JSON.stringify(j).includes(PROJ), 'note 必须脱敏');
    assert.ok(j.note.includes('<project>'));
  });
  await checkAsync('D7. `pi mcp add --description` 支持（非凭据字段），且**必须在 `--` 之前**', async () => {
    const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('d7') });
    const r = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'd', scope: 'user', transport: 'stdio', command: 'npx', description: 'docs\nserver', expectedCwd: PROJ } });
    assert.equal(r.ok, true);
    // pi 的 parseOptions 遇到 `--` 就把剩下的全当 positionals（command + args），
    // 所以选项必须全部排在 `--` 之前 —— 放到后面会被当成命令参数。
    assert.deepEqual(calls[0].args, ['mcp', 'add', 'd', '--description', 'docs server', '--', 'npx']);
    const sep = calls[0].args.indexOf('--');
    assert.ok(sep > 0, 'stdio add 必须有 -- 分隔符');
    assert.ok(
      calls[0].args.slice(0, sep).every((a, i) => i === 0 || !a.startsWith('--') || i % 2 === 1 || a.startsWith('--')),
      'options 必须都在 -- 之前',
    );
    assert.ok(!calls[0].args.slice(sep + 1).some((a) => a.startsWith('--')), '`--` 之后不能再出现选项');
    const http = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'h', scope: 'user', transport: 'http', url: 'https://e.com/m', description: 'x', expectedCwd: PROJ } });
    assert.equal(http.ok, true);
    assert.deepEqual(calls[1].args, ['mcp', 'add', 'h', '--description', 'x', '--url', 'https://e.com/m']);
    const empty = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'z', scope: 'user', transport: 'stdio', command: 'npx', description: '   ', expectedCwd: PROJ } });
    assert.equal(empty.code, 'bad-description');
    assert.equal(calls.length, 2);
  });
  await checkAsync('D8. exposure 别名从 API 进来也会归一成规范值', async () => {
    const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('d8') });
    await callServers(mod, { method: 'POST', body: { action: 'add', name: 'e', scope: 'user', transport: 'stdio', command: 'npx', exposure: 'codemode-deferred', expectedCwd: PROJ } });
    assert.deepEqual(calls[0].args, ['mcp', 'add', 'e', '--exposure', 'codemode', '--', 'npx']);
    const bad = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'e', scope: 'user', transport: 'stdio', command: 'npx', exposure: 'sse', expectedCwd: PROJ } });
    assert.equal(bad.code, 'bad-exposure');
  });

  /* ===================================================================
   * E. unknown enum / schema fallback（P20.6-Fix §五）
   * =================================================================== */
  section('E. runtime parser：闭集外一律折成 unknown');
  {
    const { projectRuntimeServer } = withCreate({ cwd: PROJ }).mod._internals;
    const f = { cwd: PROJ, agentDir: AGENT, homeDir: TMP };
    const p = projectRuntimeServer({
      name: 'x',
      scope: 'galaxy',
      enabled: true,
      exposure: 'turbo',
      transport: 'C:\\secret\\path\\server.exe --token LEAK',
      state: 'exploded',
      tools: ['ok_tool', 'bad tool', 'a-b', 'x'.repeat(200), 42, 'fine'],
      toolExposure: { good: 'direct', bad: 'turbo', ['y'.repeat(200)]: 'hidden' },
      resources: -1,
      resourceTemplates: 2.5,
      error: 'boom at ' + PROJ,
      source: 'C:\\secret\\path\\mcp.json',
      command: 'C:\\secret\\path\\server.exe',
      url: 'https://internal.example/token',
      headers: { Authorization: 'Bearer LEAK' },
      env: { K: 'LEAK' },
      brandNewUpstreamField: { whatever: 'LEAK' },
    }, f);
    check('E1. 未知 state → "unknown"（不回显上游字符串）', () => assert.equal(p.state, 'unknown'));
    check('E2. 未知 scope → null（不认识就不猜）', () => assert.equal(p.scope, null));
    check('E3. 未知 exposure → null', () => assert.equal(p.exposure, null));
    check('E4. transport 只留类型面，原文（路径/URL）不进报告', () => {
      assert.equal(p.transportType, 'stdio');
      assert.ok(!JSON.stringify(p).includes('secret'));
    });
    check('E5. tools 只留标识符面（非法字符 / 非字符串 / 超长被丢）', () => {
      assert.deepEqual(p.tools, ['ok_tool', 'fine']);
      assert.equal(p.toolCount, 2);
    });
    check('E6. toolExposure 只留合法枚举与合法键', () => {
      assert.deepEqual(p.toolExposure, { good: 'direct' });
    });
    check('E7. resources / resourceTemplates 只接受非负整数', () => {
      assert.equal(p.resources, null);
      assert.equal(p.resourceTemplates, null);
    });
    check('E8. error 脱敏；source/command/url/headers/env/未知字段一个都不取', () => {
      assert.ok(p.error.includes('<project>'));
      const keys = Object.keys(p);
      for (const k of ['source', 'command', 'url', 'headers', 'env', 'brandNewUpstreamField']) {
        assert.ok(!keys.includes(k), `${k} 不该出现在投影里`);
      }
      assert.ok(!JSON.stringify(p).includes('LEAK'));
    });
    check('E9. scope=extension 如实映射（扩展注册的 server）', () => {
      assert.equal(projectRuntimeServer({ name: 'e', scope: 'extension' }, f).scope, 'extension');
    });
    check('E10. state 闭集内的值原样保留（含 0.99.2 的 closed）', () => {
      for (const st of ['connecting', 'connected', 'needs-auth', 'disconnected', 'disabled', 'failed', 'closed']) {
        assert.equal(projectRuntimeServer({ name: 'x', state: st }, f).state, st);
      }
    });
    check('E11. 非法 server 名 / 非对象条目被整条丢弃', () => {
      assert.equal(projectRuntimeServer(null, f), null);
      assert.equal(projectRuntimeServer({ name: 'bad name!' }, f), null);
      assert.equal(projectRuntimeServer('x', f), null);
    });
  }
  await checkAsync('E12. refresh 里出现闭集外 state 时，报告给的是 unknown 而不是原文', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('e12'),
      runCli: async () => ({
        ok: true, exitCode: 0,
        stdout: JSON.stringify({ servers: [{ name: 'w', scope: 'global', enabled: true, state: 'NEEDS-REAUTH-NOW', transport: '/bin/w', tools: [] }], errors: [] }),
        stderr: '', timedOut: false, spawnFailed: false,
      }),
    });
    const r = await mod.refresh();
    assert.equal(r.servers[0].state, 'unknown');
    assert.ok(!JSON.stringify(r).includes('NEEDS-REAUTH-NOW'));
  });

  /* ===================================================================
   * F. 回归：解析 / 入口 / 状态机 / refresh / 动作 / 前端语义
   * =================================================================== */
  section('F1. parseMcpServers（只取结构）');
  {
    const r = parseMcpServers({ mcpServers: {
      a: { command: 'npx', args: ['-y', 'x'] },
      b: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer SECRET-1' }, oauth: { clientId: 'c', clientSecret: 'SECRET-2' } },
      c: { command: 'y', env: { K: 'SECRET-3' }, enabled: false, exposure: 'direct', toolExposure: { foo: 'direct', 'del_*': 'hidden' } },
    } });
    check('三条都解析出来', () => assert.equal(r.servers.length, 3));
    check('缺省 enabled=true / exposure=codemode', () => {
      assert.equal(r.servers[0].enabled, true);
      assert.equal(r.servers[0].exposure, 'codemode');
    });
    check('transport 类型只留面子', () => assert.deepEqual(r.servers.map((s) => s.transportType), ['stdio', 'http', 'stdio']));
    check('secret 面只记有无', () => assert.deepEqual(r.servers.map((s) => s.hasSecrets), [false, true, true]));
    check('secret 值一个字节都不进报告', () => assert.ok(!JSON.stringify(r).includes('SECRET')));
    check('toolExposure 键值保留（枚举面）', () => assert.deepEqual(r.servers[2].toolExposure, { foo: 'direct', 'del_*': 'hidden' }));
  }
  {
    const r = parseMcpServers({ mcpServers: {
      'bad name!': { command: 'x' },
      both: { command: 'x', url: 'https://e.com' },
      neither: {},
      badexp: { command: 'x', exposure: 'super' },
      baden: { command: 'x', enabled: 'yes' },
      badtype: { command: 'x', type: 'sse' },
      badtool: { command: 'x', toolExposure: { ok: 'direct', no: 'super' } },
      notobj: 'x',
    } });
    check('非法条目进 invalid（7 条里 6 条坏 + 1 条好）', () => {
      assert.equal(r.servers.length, 1);
      assert.equal(r.servers[0].name, 'badtool');
      assert.equal(r.invalid.length, 7);
    });
    check('toolExposure 坏值只丢键、条目保留', () => assert.deepEqual(r.servers[0].toolExposure, { ok: 'direct' }));
  }
  check('mcpServers 缺失 → 空（不是错）', () => assert.deepEqual(parseMcpServers({}).servers, []));
  check('非对象 → error（不抛）', () => assert.equal(parseMcpServers(null).error, 'not-an-object'));

  section('F2. buildPiEntry（与 bridge 同一份包）');
  {
    const dir = mkPkg('entry-ok');
    const e = buildPiEntry(dir);
    check('入口派生成功：process.execPath + 真 js（无 PATH、无 shim）', () => {
      assert.equal(e.ok, true);
      assert.equal(e.cmd, process.execPath);
      assert.deepEqual(e.baseArgs, [path.join(dir, 'dist', 'bundle', 'cli.js')]);
    });
    check('packageDir=null → null（不退回裸 pi）', () => assert.equal(buildPiEntry(null), null));
    check('包坏了 → null', () => assert.equal(buildPiEntry(path.join(TMP, 'nope')), null));
    const bad = mkPkg('entry-badbin');
    writeJson(path.join(bad, 'package.json'), { name: 'x', version: '1', bin: { pi: 'dist/bundle/cli.exe' } });
    check('入口不是 js → null', () => assert.equal(buildPiEntry(bad), null));
  }

  section('F3. summary：scope / 状态机');
  {
    writeJson(path.join(AGENT, 'mcp.json'), { mcpServers: { shared: { command: 'a' }, uonly: { url: 'https://u.example/m' } } });
    writeJson(path.join(PROJ, '.pi', 'mcp.json'), { mcpServers: { shared: { command: 'b' }, ponly: { command: 'c', enabled: false } } });
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('sum-pkg'),
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => ({ commands: [] }) },
    });
    const s = await mod.summary();
    check('项目同名覆盖用户级（shared 只生效项目那条）', () => {
      const shared = s.servers.filter((x) => x.name === 'shared');
      assert.equal(shared.length, 2);
      assert.equal(shared.find((x) => x.scope === 'user').effective.reason, 'overridden');
      assert.equal(shared.find((x) => x.scope === 'project').effective.active, true);
    });
    check('disabled 条目 effective=false', () => {
      assert.equal(s.servers.find((x) => x.name === 'ponly').effective.reason, 'disabled');
    });
    check('证据齐 → native=active', () => assert.equal(s.native.state, 'active'));
    check('command/en transport 原文不进摘要', () => assert.ok(!JSON.stringify(s).includes('example')));
  }
  await checkAsync('替代扩展（get_commands 有 extension:mcp）→ replaced', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('sum-rep'),
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => ({ commands: [{ name: 'mcp', source: 'extension', sourceInfo: {} }] }) },
    });
    const s = await mod.summary();
    assert.equal(s.native.state, 'replaced');
    assert.ok(s.servers.every((x) => x.effective.reason === 'replaced'));
  });
  await checkAsync('settings 关掉 builtin:mcp → disabled（注入判定）', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('sum-dis'),
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => ({ commands: [] }) },
      readSettingsExt: () => ({ disabled: true }),
    });
    assert.equal((await mod.summary()).native.state, 'disabled');
  });
  await checkAsync('包里没有 builtin:mcp → unsupported（旧版本安全降级）', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('sum-uns'),
      piBuiltins: () => ({ builtins: [{ id: 'llama.cpp' }] }),
      rpc: { request: async () => ({ commands: [] }) },
    });
    assert.equal((await mod.summary()).native.state, 'unsupported');
  });
  await checkAsync('证据不足 → unknown（不猜成 false）', async () => {
    const { mod } = withCreate({ cwd: PROJ, resolvePackageDir: () => null });
    assert.equal((await mod.summary()).native.state, 'unknown');
  });
  await checkAsync('坏的 mcp.json → invalid 进报告、不炸摘要', async () => {
    fs.writeFileSync(path.join(AGENT, 'mcp.json'), '{broken', 'utf8');
    const { mod } = withCreate({ cwd: PROJ, resolvePackageDir: () => null });
    const s = await mod.summary();
    assert.ok(s.servers.every((x) => x.scope === 'project'));
    assert.ok(s.configError.user.length > 0);
  });

  section('F4. refresh：运行时真相合并');
  const listOut = {
    servers: [
      { name: 'shared', scope: 'global', source: '/x/mcp.json', enabled: true, exposure: 'direct', transport: '/bin/a', state: 'connected', tools: ['t1', 't2'] },
      { name: 'ponly', scope: 'project', source: '/x/.pi/mcp.json', enabled: false, exposure: 'codemode', transport: '/bin/c', state: 'disabled', tools: [] },
      { name: 'ghost', scope: 'global', source: '/x/mcp.json', enabled: true, exposure: 'codemode', transport: 'http://h.example/mcp', state: 'failed', tools: [], error: 'fetch failed at ' + PROJ },
    ],
    errors: ['bad entry at ' + AGENT],
  };
  writeJson(path.join(AGENT, 'mcp.json'), { mcpServers: { shared: { command: 'a' }, ghost: { url: 'http://h.example/mcp', headers: { A: 'SECRET-9' } } } });
  writeJson(path.join(PROJ, '.pi', 'mcp.json'), { mcpServers: { ponly: { command: 'c', enabled: false } } });
  {
    let runs = 0;
    const { mod, calls } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('ref-pkg'),
      runCli: async () => { runs++; return { ok: true, exitCode: 0, stdout: JSON.stringify(listOut), stderr: '', timedOut: false, spawnFailed: false }; },
    });
    const r = await mod.refresh();
    check('entry 派生自包目录（process.execPath 跑真 js）', () => {
      assert.equal(calls[0].entry.cmd, process.execPath);
      assert.deepEqual(calls[0].args, ['mcp', 'list', '--json']);
    });
    check('exposure 以运行时为准（direct 覆盖配置的 codemode）', () => {
      assert.equal(r.servers.find((x) => x.name === 'shared').exposure, 'direct');
    });
    check('tools 只留名字（≤200），count 对得上', () => {
      const g = r.servers.find((x) => x.name === 'ghost');
      assert.equal(g.toolCount, 0);
      assert.equal(r.servers.find((x) => x.name === 'shared').toolCount, 2);
    });
    check('transport 原文（命令路径/URL）不进报告，只留类型', () => {
      assert.ok(!JSON.stringify(r).includes('h.example'));
      assert.equal(r.servers.find((x) => x.name === 'ghost').transportType, 'http');
    });
    check('错误文本脱敏（绝对路径折掉）+ 截断', () => {
      assert.ok(!JSON.stringify(r).includes(PROJ));
      assert.ok(!JSON.stringify(r).includes(AGENT));
      assert.ok(JSON.stringify(r).includes('<project>') || JSON.stringify(r).includes('<agent-dir>'));
    });
    check('secret 值不进 refresh 报告', () => assert.ok(!JSON.stringify(r).includes('SECRET-9')));
    check('TTL 内第二次走缓存（不重跑 list）', async () => {
      assert.equal((await mod.refresh()).cached, true);
      assert.equal(runs, 1);
    });
  }
  await checkAsync('packageDir=null → refresh 报 no-proven-entry（不跑裸 pi）', async () => {
    let runs = 0;
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => null,
      runCli: async () => { runs++; return { ok: true, exitCode: 0, stdout: '{}', stderr: '', timedOut: false, spawnFailed: false }; },
    });
    const r = await mod.refresh();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'no-proven-entry');
    assert.equal(runs, 0);
  });
  await checkAsync('list 输出非 JSON → bad-json（不解析人类文本）', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('ref-bad'),
      runCli: async () => ({ ok: true, exitCode: 0, stdout: 'shared: connected (codemode)', stderr: '', timedOut: false, spawnFailed: false }),
    });
    assert.equal((await mod.refresh()).code, 'bad-json');
  });
  await checkAsync('list 超时 → list-timeout（不挂死）', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('ref-to'),
      runCli: async () => ({ ok: true, exitCode: null, stdout: '', stderr: '', timedOut: true, spawnFailed: false }),
    });
    assert.equal((await mod.refresh()).code, 'list-timeout');
  });

  section('F5. actions：argv / 校验 / stale / unsupported');
  {
    const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('act-pkg') });
    const add = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'fs', scope: 'user', transport: 'stdio', command: 'npx', args: ['-y', 'x'], exposure: 'direct', expectedCwd: PROJ } });
    check('add stdio argv 精确（-- 打头，shell:false 由执行层保证）', () => {
      assert.equal(add.ok, true);
      assert.deepEqual(calls[0].args, ['mcp', 'add', 'fs', '--exposure', 'direct', '--', 'npx', '-y', 'x']);
    });
    const addH = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'docs', scope: 'project', transport: 'http', url: 'https://e.com/mcp', expectedCwd: PROJ } });
    check('add http argv 精确（-l + --url）', () => {
      assert.equal(addH.ok, true);
      assert.deepEqual(calls[1].args, ['mcp', 'add', 'docs', '-l', '--url', 'https://e.com/mcp']);
    });
    const rm = await callServers(mod, { method: 'POST', body: { action: 'remove', name: 'fs', scope: 'user', expectedCwd: PROJ } });
    check('remove argv 精确 + 凭据保留提示', () => {
      assert.deepEqual(calls[2].args, ['mcp', 'remove', 'fs']);
      assert.match(rm.note, /OAuth/);
    });
    const login = await callServers(mod, { method: 'POST', body: { action: 'login', name: 'docs', timeoutSec: 30, expectedCwd: PROJ } });
    check('login argv 带 --timeout', () => assert.deepEqual(calls[3].args, ['mcp', 'login', 'docs', '--timeout', '30']));
    const logout = await callServers(mod, { method: 'POST', body: { action: 'logout', name: 'docs', expectedCwd: PROJ } });
    check('logout argv 精确', () => assert.deepEqual(calls[4].args, ['mcp', 'logout', 'docs']));
  }
  {
    const { mod } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('act-v') });
    const bad1 = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'bad name!', scope: 'user', transport: 'stdio', command: 'x', expectedCwd: PROJ } });
    check('坏名字被拒（注入面关掉）', () => assert.equal(bad1.code, 'bad-name'));
    const bad2 = await callServers(mod, { method: 'POST', body: { action: 'add', name: 'ok', scope: 'user', transport: 'http', url: 'ftp://e.com', expectedCwd: PROJ } });
    check('非 http(s) url 被拒', () => assert.equal(bad2.code, 'bad-url'));
    const bad3 = await callServers(mod, { method: 'POST', body: { action: 'enable', name: 'ok', scope: 'user', expectedCwd: PROJ } });
    check('enable → unsupported-action（指引 /mcp，不编假动作）', () => assert.equal(bad3.code, 'unsupported-action'));
    const stale = await callServers(mod, { method: 'POST', body: { action: 'remove', name: 'ok', scope: 'user', expectedCwd: path.join(TMP, 'other') } });
    check('cwd 对不上 → workspace-stale（409 语义由 json 状态码承载）', () => assert.equal(stale.code, 'workspace-stale'));
    const loginTo = await callServers(withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('act-t'), runCli: async () => ({ ok: true, exitCode: null, stdout: '', stderr: '', timedOut: true, spawnFailed: false }) }).mod, { method: 'POST', body: { action: 'login', name: 'd', expectedCwd: PROJ } });
    check('login 等待超时 → login-timeout + 终端指引', () => {
      assert.equal(loginTo.code, 'login-timeout');
      assert.match(loginTo.error, /pi mcp login/);
    });
  }
  await checkAsync('pi 失败时 stderr 尾巴仍脱敏 + 截断（GUI 已不传任何 secret，故无值可泄）', async () => {
    const fail = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('act-s2'), runCli: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'boom at ' + PROJ + ' ' + 'x'.repeat(900), timedOut: false, spawnFailed: false }) });
    const rf = await callServers(fail.mod, { method: 'POST', body: { action: 'remove', name: 's', scope: 'user', expectedCwd: PROJ } });
    assert.ok(!JSON.stringify(rf).includes(PROJ));
    assert.ok(JSON.stringify(rf).includes('<project>'));
    assert.ok(rf.error.length <= 520);
  });

  section('F6. 前端语义：mcp-activity / capabilities（纯函数，可单测）');
  {
    const act = await import('../public/mcp-activity.js');
    const cap = await import('../public/mcp-capabilities.js');
    check('mcp__server__tool 解析（第一个 __ 是边界）', () => {
      assert.deepEqual(act.parseMcpToolName('mcp__fs__read'), { server: 'fs', tool: 'read' });
      assert.deepEqual(act.parseMcpToolName('mcp__s__t__u'), { server: 's', tool: 't__u' });
      assert.equal(act.parseMcpToolName('mcp_s__t'), null);
      assert.equal(act.parseMcpToolName('bash'), null);
    });
    check('0.99.2 下划线化的名字仍能解析（my-server → my_server）', () => {
      assert.deepEqual(act.parseMcpToolName('mcp__my_server__read_file'), { server: 'my_server', tool: 'read_file' });
      // 0.99.1 的连字符形态也要认（两版并集的超集）
      assert.deepEqual(act.parseMcpToolName('mcp__my-server__read-file'), { server: 'my-server', tool: 'read-file' });
      // 重名时的 8 位 sha256 后缀
      assert.deepEqual(act.parseMcpToolName('mcp__s__tool_deadbeef'), { server: 's', tool: 'tool_deadbeef' });
    });
    check('工具调用投影：server/tool/状态，无 args 全文', () => {
      const r = act.mcpActivity({ name: 'mcp__fs__read', status: 'running', args: { path: '/secret' } });
      assert.equal(r.label, '调用 MCP 工具…');
      assert.match(r.facts, /Server: fs/);
      assert.ok(!JSON.stringify(r).includes('/secret'));
    });
    check('error 态 + 未知工具 null（generic fallback 接管）', () => {
      assert.equal(act.mcpActivity({ name: 'mcp__g__rm', status: 'error' }).label, 'MCP 调用失败');
      assert.equal(act.mcpActivity({ name: 'bash', status: 'success' }), null);
    });
    check('资源工具投影（server/uri 摘要）', () => {
      const r = act.mcpActivity({ name: 'read_mcp_resource', status: 'success', args: { server: 'd', uri: 'file:///x.md' } });
      assert.match(r.facts, /URI: file:\/\/\/x\.md/);
    });
    check('运行观察按 server 聚合、切 run 清零', () => {
      const ob = cap.createMcpObservation();
      ob.observe({ type: 'tool_execution_start', toolName: 'mcp__fs__a', bridgeRun: 1 }, 1, 1);
      ob.observe({ type: 'tool_execution_start', toolName: 'mcp__fs__b', bridgeRun: 1 }, 1, 1);
      ob.observe({ type: 'tool_execution_start', toolName: 'bash', bridgeRun: 1 }, 1, 1);
      const s1 = ob.snapshot(1, 1);
      assert.deepEqual(s1, { any: true, count: 1, names: ['mcp__fs'] });
      assert.deepEqual(ob.snapshot(1, 2), { any: false, count: 0, names: [] });
    });
    check('mcpSetup 三值（缺证据不写 false）', () => {
      assert.deepEqual(cap.mcpSetup(null), { nativeActive: null, configured: null });
      assert.equal(cap.mcpSetup({ fresh: true, native: { state: 'active' }, servers: [{}, {}] }).nativeActive, true);
      assert.equal(cap.mcpSetup({ fresh: true, native: { state: 'replaced' }, servers: [] }).nativeActive, false);
    });
  }

  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  console.log(`\n${count}/${count} 通过（Pi 契约基线 ${PI_BASELINE}）`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
