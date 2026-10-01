/* P20.6 Native MCP 状态与受控动作的离线契约。
 *
 * 完全离线：不启动 pi、不起真实 MCP server、不联网、不 OAuth、不读用户真实目录。
 * `pi mcp list --json` 与各动作的执行一律注入假 runCli；配置文件全在 os.tmpdir()。
 *
 * 覆盖（对着 P20.6 规格逐条）：
 *   A. parseMcpServers：默认值、非法条目、secret 值不进报告
 *   B. buildPiEntry：identity 派生入口、证明不了就 null
 *   C. summary：scope 合并/覆盖、信任闸门、replaced/disabled/unsupported/unknown
 *   D. refresh：list --json 合并、脱敏、TTL、失败分类
 *   E. actions：add/remove/login/logout 的 argv、校验、stale、unsupported、secret 不回显
 *   F. 前端语义：mcp__ 解析、资源工具、运行观察聚合
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const checkAsync = async (name, fn) => { await fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-mcpnat-'));
const AGENT = path.join(TMP, 'agent');
fs.mkdirSync(AGENT, { recursive: true });

/* ---------- fixture：假 pi 包 ---------- */
function mkPkg(name, version = '0.99.1') {
  const dir = path.join(TMP, name, 'pkg');
  fs.mkdirSync(path.join(dir, 'dist', 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version, bin: { pi: 'dist/bundle/cli.js' } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'dist', 'bundle', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  return dir;
}
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v), 'utf8');

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

const mkRuntime = (cwd) => ({ getCurrentCwd: () => cwd });
const noTrust = async () => ({ trusted: true, requiresTrust: false });

function mkNative(over = {}) {
  const calls = [];
  const runCli = over.runCli || (async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnFailed: false }));
  const wrapped = async (entry, args, opts) => { calls.push({ entry, args, opts }); return runCli(entry, args, opts); };
  const mod = over.create({
    runtime: over.runtime || mkRuntime(over.cwd || null),
    env: over.env || { HOME: TMP, PI_CODING_AGENT_DIR: AGENT },
    resolvePackageDir: over.resolvePackageDir || (() => null),
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

  /* ================= A. 配置安全解析 ================= */
  section('A. parseMcpServers（只取结构）');
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

  /* ================= B. 入口派生 ================= */
  section('B. buildPiEntry（与 bridge 同一份包）');
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

  /* ================= C. 摘要与状态机 ================= */
  section('C. summary：scope / 信任 / native 状态机');
  const PROJ = path.join(TMP, 'proj');
  fs.mkdirSync(path.join(PROJ, '.pi'), { recursive: true });
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
  await checkAsync('项目未信任 → 项目条目 effective=false（untrusted）', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('sum-pkg'),
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => ({ commands: [] }) },
      readTrust: async () => ({ trusted: false, requiresTrust: true }),
    });
    const s = await mod.summary();
    assert.equal(s.servers.find((x) => x.name === 'ponly').effective.reason, 'untrusted');
    assert.equal(s.servers.find((x) => x.name === 'uonly').effective.active, true);
  });
  await checkAsync('替代扩展（get_commands 有 extension:mcp）→ replaced', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('sum-pkg'),
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => ({ commands: [{ name: 'mcp', source: 'extension', sourceInfo: {} }] }) },
    });
    const s = await mod.summary();
    assert.equal(s.native.state, 'replaced');
    assert.ok(s.servers.every((x) => x.effective.reason === 'replaced'));
  });
  await checkAsync('settings 关掉 builtin:mcp → disabled', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('sum-pkg'),
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      rpc: { request: async () => ({ commands: [] }) },
      readSettingsExt: () => ({ disabled: true }),
    });
    assert.equal((await mod.summary()).native.state, 'disabled');
  });
  await checkAsync('包里没有 builtin:mcp → unsupported（旧版本安全降级）', async () => {
    const { mod } = withCreate({
      cwd: PROJ,
      resolvePackageDir: () => mkPkg('sum-pkg'),
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

  /* ================= D. refresh（list --json） ================= */
  section('D. refresh：运行时真相合并');
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
    await checkAsync('GET status 看得到缓存视图', async () => {
      const st = await callStatus(mod, { method: 'GET' });
      assert.equal(st.json.status.cached, true);
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

  /* ================= E. 受控动作 ================= */
  section('E. actions：argv / 校验 / stale / unsupported');
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
  await checkAsync('secret 值透传但永不回显（pi stderr 外部文本只截断+脱敏路径）', async () => {
    const { mod, calls } = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('act-s') });
    const r = await callServers(mod, { method: 'POST', body: { action: 'add', name: 's', scope: 'user', transport: 'http', url: 'https://e.com/m', headers: [{ key: 'Authorization', value: 'Bearer TOP-SECRET-1' }], oauth: { clientSecret: 'TOP-SECRET-2' }, expectedCwd: PROJ } });
    assert.equal(r.ok, true);
    assert.ok(calls[0].args.includes('Authorization=Bearer TOP-SECRET-1'));
    // 成功响应里没有值（只回 name/scope）。
    assert.ok(!JSON.stringify(r).includes('TOP-SECRET'));
    // 失败的 error 做路径脱敏 + 截断。注意边界：GUI 从不存 secret 值，所以
    // pi 自己 stderr 里回显的外部文本认不出来 —— 含凭据的配置请走终端。
    const fail = withCreate({ cwd: PROJ, resolvePackageDir: () => mkPkg('act-s2'), runCli: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'boom at ' + PROJ + ' ' + 'x'.repeat(900), timedOut: false, spawnFailed: false }) });
    const rf = await callServers(fail.mod, { method: 'POST', body: { action: 'remove', name: 's', scope: 'user', expectedCwd: PROJ } });
    assert.ok(!JSON.stringify(rf).includes(PROJ));
    assert.ok(JSON.stringify(rf).includes('<project>'));
    assert.ok(rf.error.length <= 520);
  });

  /* ================= F. 前端语义 ================= */
  section('F. mcp-activity / capabilities（纯函数，可单测）');
  {
    const act = await import('../public/mcp-activity.js');
    const cap = await import('../public/mcp-capabilities.js');
    check('mcp__server__tool 解析（第一个 __ 是边界）', () => {
      assert.deepEqual(act.parseMcpToolName('mcp__fs__read'), { server: 'fs', tool: 'read' });
      assert.deepEqual(act.parseMcpToolName('mcp__s__t__u'), { server: 's', tool: 't__u' });
      assert.equal(act.parseMcpToolName('mcp_s__t'), null);
      assert.equal(act.parseMcpToolName('bash'), null);
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
  console.log(`\n${count}/${count} 通过`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
