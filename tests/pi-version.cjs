/* P20.5：Pi 版本真值与 built-in 能力探测的离线契约。
 *
 * 完全离线：不启动 pi、不联网、不读用户的真实 `~/.pi`、不执行任何 Extension。
 * 所有 pi 包都用 `os.tmpdir()` 里现造的假包 —— 断言「跑测试这台机器装了什么」
 * 的测试在 CI 上必红，所以一个都不许有。
 *
 * 覆盖（对着 P20.5 规格逐条）：
 *   - version：known / unknown / malformed，两种来源（package.json / pi --version）
 *   - probe：supported / unsupported / 抛错
 *   - 0.87 legacy 与 0.99 built-in capability 两种真实形状
 *   - MCP：unavailable / disabled(false) / unknown(null)
 *   - get_commands ≠ tool registry
 *   - schema drift：pi-compat 的异常记录只留结构
 *   - stale：缓存按 cwd 分键，切项目不会返回上一个项目的结论
 *   - 脱敏：mcp.json 的内容与绝对路径都不进报告
 *   - **launch identity（Blocker A）**：spawn 的命令、`--version` 与能力探测
 *     读的包必须同源；PATH vs「常见全局位置」两份清单分叉时绑 PATH 那份；
 *     证明不了就 null、绝不回退去捡另一份；`formatLaunch` 两侧共用。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p205-'));

/** 造一个「像 pi 包」的目录。返回 { dir, binPath, env }。 */
function mkPiPackage(name, { version = '0.99.1', builtins = null, apiTypes = null, rpcTypes = null, mcpDoc = null, files = {} } = {}) {
  const base = path.join(TMP, name);
  const dir = path.join(base, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(path.join(dir, 'dist', 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist', 'core', 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist', 'modes', 'rpc'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }), 'utf8');
  if (builtins !== null) fs.writeFileSync(path.join(dir, 'dist', 'extensions', 'index.js'), builtins, 'utf8');
  if (apiTypes !== null) fs.writeFileSync(path.join(dir, 'dist', 'core', 'extensions', 'types.d.ts'), apiTypes, 'utf8');
  if (rpcTypes !== null) fs.writeFileSync(path.join(dir, 'dist', 'modes', 'rpc', 'rpc-types.d.ts'), rpcTypes, 'utf8');
  if (mcpDoc !== null) fs.writeFileSync(path.join(dir, 'docs', 'mcp.md'), mcpDoc, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  const binPath = path.join(base, 'prefix', 'bin', 'pi');
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n', 'utf8');
  const home = path.join(base, 'home');
  const agent = path.join(base, 'agent');
  const proj = path.join(base, 'proj');
  for (const d of [home, agent, proj]) fs.mkdirSync(d, { recursive: true });
  return { base, dir, binPath, home, agent, proj, env: { HOME: home, PI_CODING_AGENT_DIR: agent, PI_BIN: binPath } };
}

/* 两个**真实版本**的原文（取自 npm 发布包，逐字节）。 */
const BUILTINS_087 = 'export const builtInExtensions = [{ name: "llama.cpp", factory: llamaExtension, hidden: true }];\n';
const BUILTINS_099 = [
  'export const builtInExtensions = [',
  '    { name: "llama.cpp", factory: llamaExtension, builtin: true },',
  '    // Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party',
  '    // MCP extension) takes over instead of running alongside the built-in one.',
  '    { name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },',
  '    { name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },',
  '    { name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },',
  '];',
  '',
].join('\n');
const API_087 = 'export interface ExtensionAPI {\n    getActiveTools(): string[];\n    getAllTools(): ToolInfo[];\n}\n';
const API_099 = 'export interface ExtensionAPI {\n    getAllTools(): ToolInfo[];\n    registerMcpServer(name: string, config: McpServerConfig): void;\n    getMcpServers(): RegisteredMcpServer[];\n}\n';
const RPC_TYPES = 'export type RpcCommand = {\n    type: "prompt";\n} | {\n    type: "get_commands";\n};\n\nexport type RpcResponse = {\n    type: "response";\n};\n';
const MCP_DOC = '# MCP Servers\n\n```bash\npi mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .\n```\n';

(async () => {
const { createPiVersion, createPiVersionProbe, parsePiVersion, parseVersionOutput } = await import('../server/pi-version.js');
const { createPiBuiltins, parseBuiltInExtensions } = await import('../server/pi-builtins.js');
const { createMcp } = await import('../server/mcp.js');
const { createPiCompat } = await import('../server/pi-compat.js');
const { createPiLaunch, formatLaunch } = await import('../server/pi-launch.js');
const { createDiagnostics } = await import('../server/diagnostics.js');

  /* ================= A. 版本号解析（纯函数） ================= */
  section('A. 版本号解析');
  for (const v of ['0.99.1', '0.87.0', '1.0.0', '0.99.1-beta.2', '10.20.30+build.7']) {
    check('known: ' + v, () => assert.deepEqual(parsePiVersion(v), { value: v, status: 'known' }));
  }
  for (const v of ['not-a-version', 'v0.99.1', '0.99', '0.99.1.2', '>=0.90', '0.99.1 x', 'x'.repeat(80)]) {
    check('malformed: ' + v.slice(0, 20), () => assert.equal(parsePiVersion(v).status, 'malformed'));
  }
  for (const v of [null, undefined, '', '   ', 123, {}, []]) {
    check('unknown: ' + JSON.stringify(v), () => assert.deepEqual(parsePiVersion(v), { value: null, status: 'unknown' }));
  }
  check('probe 输出带噪声也能抠出版本', () => assert.equal(parseVersionOutput('pi 0.99.1\n').value, '0.99.1'));
  check('probe 输出纯版本号', () => assert.equal(parseVersionOutput('0.99.1').value, '0.99.1'));
  check('probe 输出是垃圾 → malformed（不是 known）', () => assert.equal(parseVersionOutput('command not found').status, 'malformed'));
  check('probe 输出为空 → unknown', () => assert.equal(parseVersionOutput('  ').status, 'unknown'));

  /* ================= B. 版本真值 ================= */
  section('B. 版本真值（value / source / status / updatedAt）');
  {
    const w = mkPiPackage('v-known', { version: '0.99.1' });
    let probes = 0;
    const pv = createPiVersion({
      resolvePackageDir: () => w.dir,
      probeVersion: () => { probes++; return 'pi 9.9.9'; },
      now: () => 1700000000000,
    });
    const r = pv.read();
    check('package.json 是首选来源', () => assert.equal(r.source, 'package.json'));
    check('值就是包里的版本号', () => assert.equal(r.value, '0.99.1'));
    check('状态 known', () => assert.equal(r.status, 'known'));
    check('updatedAt 是 ISO 时间戳', () => assert.equal(r.updatedAt, '2023-11-14T22:13:20.000Z'));
    check('首选来源命中时不跑兜底探测', () => assert.equal(probes, 0));
    check('TTL 内第二次读走缓存（不重复读文件）', () => { pv.read(); assert.equal(probes, 0); });
  }
  {
    const w = mkPiPackage('v-malformed', { version: 'not-a-version' });
    let probes = 0;
    const pv = createPiVersion({ resolvePackageDir: () => w.dir, probeVersion: () => { probes++; return '0.99.1'; } });
    const r = pv.read();
    check('包里的 version 畸形 → status=malformed', () => assert.equal(r.status, 'malformed'));
    check('畸形时 value 保持 null（不把垃圾当版本号）', () => assert.equal(r.value, null));
    check('畸形是**有信息**的结果：不退回兜底探测', () => assert.equal(probes, 0));
    check('畸形时仍记来源', () => assert.equal(r.source, 'package.json'));
  }
  {
    const w = mkPiPackage('v-no-pkg', { version: '0.99.1' });
    let probes = 0;
    const pv = createPiVersion({
      resolvePackageDir: () => path.join(w.base, 'does-not-exist'),
      probeVersion: () => { probes++; return 'pi 0.99.1'; },
      now: () => 1700000000000,
    });
    const r = pv.read();
    check('包读不到 → 落到 pi --version', () => assert.equal(r.source, 'pi --version'));
    check('兜底探测的值被解析出来', () => assert.equal(r.value, '0.99.1'));
    check('兜底探测确实跑了', () => assert.equal(probes, 1));
  }
  {
    const pv = createPiVersion({ resolvePackageDir: () => null, probeVersion: () => null });
    const r = pv.read();
    check('两个来源都拿不到 → unknown / source=none', () => {
      assert.equal(r.status, 'unknown');
      assert.equal(r.value, null);
      assert.equal(r.source, 'none');
    });
  }
  {
    const pv = createPiVersion({ resolvePackageDir: () => { throw new Error('boom'); }, probeVersion: () => { throw new Error('boom'); } });
    check('探测抛错不传播，降级成 unknown', () => assert.equal(pv.read().status, 'unknown'));
  }
  {
    const pv = createPiVersion({ resolvePackageDir: () => null, probeVersion: null });
    check('没注入任何来源 → unknown（不猜）', () => assert.equal(pv.read().status, 'unknown'));
  }
  {
    const w = mkPiPackage('v-ttl', { version: '0.99.1' });
    let t = 1000;
    let reads = 0;
    const pv = createPiVersion({
      resolvePackageDir: () => { reads++; return w.dir; },
      now: () => t,
      ttlMs: 5000,
    });
    pv.read();
    t = 3000;
    pv.read();
    check('TTL 内不重读', () => assert.equal(reads, 1));
    t = 9000;
    pv.read();
    check('过了 TTL 会重读', () => assert.equal(reads, 2));
    pv.read({ force: true });
    check('force 强制重读', () => assert.equal(reads, 3));
  }
  {
    /* 兜底探测：入口解析与 spawn 都注入，验证 shell:false + args 数组的形状 */
    const calls = [];
    const probe = createPiVersionProbe({
      resolveEntry: () => ({ cmd: 'C:/fake/node.exe', baseArgs: ['C:/fake/pi.js'] }),
      run: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { stdout: 'pi 0.99.1\n', stderr: '' }; },
    });
    check('probe 用 args 数组调 --version（不拼 shell）', () => {
      const out = probe();
      assert.equal(out.trim(), 'pi 0.99.1');
      assert.deepEqual(calls[0].args, ['C:/fake/pi.js', '--version']);
      assert.equal(calls[0].cmd, 'C:/fake/node.exe');
    });
    check('probe 有超时与输出上限', () => assert.ok(calls[0].opts.timeout > 0));
    check('probe 无入口 → null（不猜）', () => assert.equal(createPiVersionProbe({ resolveEntry: () => null })(), null));
    check('probe 抛错 → null', () => assert.equal(createPiVersionProbe({ resolveEntry: () => { throw new Error('x'); } })(), null));
    check('probe 报 error → null', () => assert.equal(createPiVersionProbe({ resolveEntry: () => ({ cmd: 'x' }), run: () => ({ error: new Error('nope') }) })(), null));
    check('probe 空输出 → null', () => assert.equal(createPiVersionProbe({ resolveEntry: () => ({ cmd: 'x' }), run: () => ({ stdout: '   ' }) })(), null));
  }

  /* ================= C. builtInExtensions 解析（真实原文） ================= */
  section('C. builtInExtensions 解析');
  {
    const p87 = parseBuiltInExtensions(BUILTINS_087);
    check('0.87 原文 → 只有 llama.cpp', () => assert.deepEqual(p87.entries.map((e) => e.id), ['llama.cpp']));
    check('0.87 原文 → hidden:true、不可替换', () => {
      assert.equal(p87.entries[0].hidden, true);
      assert.equal(p87.entries[0].replaceable, false);
    });
    const p99 = parseBuiltInExtensions(BUILTINS_099);
    check('0.99 原文 → 四个 built-in', () => assert.deepEqual(p99.entries.map((e) => e.id), ['llama.cpp', 'codemode', 'tool-search', 'mcp']));
    check('0.99 原文 → 后三个可被替换', () => assert.deepEqual(p99.entries.filter((e) => e.replaceable).map((e) => e.id), ['codemode', 'tool-search', 'mcp']));
    check('证据是那一行的原文（可核对）', () => assert.match(p99.entries[3].evidence, /name: "mcp".*builtin: true/));
    check('形状不认识 → null（不返回空数组冒充「没有」）', () => {
      assert.equal(parseBuiltInExtensions('export const other = [];'), null);
      assert.equal(parseBuiltInExtensions(''), null);
      assert.equal(parseBuiltInExtensions(null), null);
    });
  }

  /* ================= D. built-in 探测 ================= */
  section('D. built-in 能力探测');
  {
    const w = mkPiPackage('b-099', { version: '0.99.1', builtins: BUILTINS_099, apiTypes: API_099, rpcTypes: RPC_TYPES, mcpDoc: MCP_DOC });
    const b = createPiBuiltins({ resolvePackageDir: () => w.dir, env: w.env }).read({ cwd: w.proj });
    check('known=true 且给出出处文件', () => {
      assert.equal(b.known, true);
      assert.equal(b.source, 'dist/extensions/index.js');
    });
    check('四个 built-in 都在', () => assert.deepEqual(b.builtins.map((x) => x.id), ['llama.cpp', 'codemode', 'tool-search', 'mcp']));
    check('ExtensionAPI：registerMcpServer / getMcpServers / getAllTools 都读到', () => {
      assert.equal(b.extensionApi.registerMcpServer, true);
      assert.equal(b.extensionApi.getMcpServers, true);
      assert.equal(b.extensionApi.getAllTools, true);
    });
    check('RPC 命令表读出来，且没有工具清单命令', () => {
      assert.deepEqual(b.rpc.commands, ['get_commands', 'prompt']);
      assert.equal(b.rpc.toolListCommand, false);
    });
    check('MCP 命令行出处来自 docs/mcp.md', () => {
      assert.equal(b.mcpCli.available, true);
      assert.match(b.mcpCli.evidence, /pi mcp add/);
    });
    check('updatedAt 是 ISO', () => assert.match(b.updatedAt, /^\d{4}-\d{2}-\d{2}T/));
  }
  {
    const w = mkPiPackage('b-087', { version: '0.87.0', builtins: BUILTINS_087, apiTypes: API_087, rpcTypes: RPC_TYPES });
    const b = createPiBuiltins({ resolvePackageDir: () => w.dir, env: w.env }).read({ cwd: w.proj });
    check('0.87：只有 llama.cpp', () => assert.deepEqual(b.builtins.map((x) => x.id), ['llama.cpp']));
    check('0.87：没有 registerMcpServer / getMcpServers', () => {
      assert.equal(b.extensionApi.registerMcpServer, false);
      assert.equal(b.extensionApi.getMcpServers, false);
    });
    check('0.87：getAllTools **早就有**（不是新能力）', () => assert.equal(b.extensionApi.getAllTools, true));
    check('0.87：没有 docs/mcp.md → mcpCli 未知（不是 false）', () => assert.equal(b.mcpCli.available, null));
  }
  {
    const b = createPiBuiltins({ resolvePackageDir: () => null, env: { HOME: TMP, PI_CODING_AGENT_DIR: path.join(TMP, 'nope') } }).read({ cwd: null });
    check('包找不到 → known=false、builtins=null（不写成空数组）', () => {
      assert.equal(b.known, false);
      assert.equal(b.builtins, null);
    });
    check('包找不到时 ExtensionAPI / RPC 都是未知', () => {
      assert.equal(b.extensionApi.registerMcpServer, null);
      assert.equal(b.rpc.toolListCommand, null);
    });
    check('包找不到**不影响** mcp.json 的存在性探测', () => assert.equal(b.mcpConfig.user.exists, false));
  }
  {
    /* stale：缓存按 cwd 分键 —— 切项目不能拿到上一个项目的结论 */
    const w = mkPiPackage('b-stale', { version: '0.99.1', builtins: BUILTINS_099, apiTypes: API_099 });
    const projA = path.join(w.base, 'projA');
    const projB = path.join(w.base, 'projB');
    fs.mkdirSync(path.join(projA, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(projA, '.pi', 'mcp.json'), '{"mcpServers":{}}', 'utf8');
    fs.mkdirSync(projB, { recursive: true });
    const bi = createPiBuiltins({ resolvePackageDir: () => w.dir, env: w.env, ttlMs: 60000 });
    check('项目 A 有 mcp.json → exists=true', () => assert.equal(bi.read({ cwd: projA }).mcpConfig.project.exists, true));
    check('切到项目 B 立刻变 false（缓存不串项目）', () => assert.equal(bi.read({ cwd: projB }).mcpConfig.project.exists, false));
    check('切回 A 又对了', () => assert.equal(bi.read({ cwd: projA }).mcpConfig.project.exists, true));
  }

  /* ================= E. /api/mcp 报告 ================= */
  section('E. MCP 报告三态');
  const mkRuntime = (cwd) => ({ getCurrentCwd: () => cwd });
  {
    const w = mkPiPackage('r-099', { version: '0.99.1', builtins: BUILTINS_099, apiTypes: API_099, rpcTypes: RPC_TYPES, mcpDoc: MCP_DOC });
    const b = createMcp({ runtime: mkRuntime(w.proj), env: w.env, piBin: w.binPath }).readReport();
    check('0.99 形态 → supported=true', () => assert.equal(b.supported, true));
    check('reason 指出 built-in:mcp 这条判据', () => assert.match(b.reason, /built-in 扩展 `mcp`/));
    check('evidence 是可核对的原文', () => assert.match(b.evidence, /dist\/extensions\/index\.js/));
    check('servers 仍是空（不编造 Server）', () => assert.deepEqual(b.servers, []));
    check('serversNote 指向原生明细（/api/mcp/servers）', () => assert.match(b.serversNote, /api\/mcp\/servers/));
    check('builtins 如实列出四个', () => assert.deepEqual(b.builtins.entries.map((x) => x.id), ['llama.cpp', 'codemode', 'tool-search', 'mcp']));
    check('built-in 说明写清「不是扫目录扫到的」', () => assert.match(b.builtins.note, /不由 Extension Registry 的目录扫描发现/));
    check('RPC：没有工具清单命令', () => assert.equal(b.rpc.toolListCommand, false));
    check('RPC：note 明说「不伪造工具注册表」', () => assert.match(b.rpc.note, /不伪造工具注册表/));
    check('get_commands 存在 ≠ 它是工具注册表', () => {
      // get_commands 在命令表里，但它返回的是 slash command / skill，不是 tool
      assert.ok(b.rpc.commands.includes('get_commands'));
      assert.equal(b.rpc.toolListCommand, false);
    });
  }
  {
    const w = mkPiPackage('r-087', { version: '0.87.0', builtins: BUILTINS_087, apiTypes: API_087, rpcTypes: RPC_TYPES });
    const b = createMcp({ runtime: mkRuntime(w.proj), env: w.env, piBin: w.binPath }).readReport();
    check('0.87 legacy → supported=false（旧版本安全降级保留）', () => assert.equal(b.supported, false));
    check('0.87 legacy → 仍然不列 Server', () => assert.deepEqual(b.servers, []));
  }
  {
    const w = mkPiPackage('r-unknown', { version: '9.9.9', builtins: 'export const nope = [];\n' });
    const b = createMcp({ runtime: mkRuntime(w.proj), env: w.env, piBin: w.binPath }).readReport();
    check('built-ins 形状不认识 → supported=null（不猜成 false）', () => assert.equal(b.supported, null));
    check('形状不认识时 builtins.entries=null', () => assert.equal(b.builtins.entries, null));
  }
  {
    const b = createMcp({ runtime: mkRuntime(null), env: { HOME: TMP, PI_CODING_AGENT_DIR: path.join(TMP, 'nope') }, piBin: null }).readReport();
    check('找不到 pi 包 → supported=null（unavailable）', () => assert.equal(b.supported, null));
    check('找不到包时 piPackageFound=false', () => assert.equal(b.piPackageFound, false));
  }
  {
    /* 版本真值注入与兜底 */
    const w = mkPiPackage('r-ver', { version: '0.99.1', builtins: BUILTINS_099, apiTypes: API_099 });
    const pv = createPiVersion({ resolvePackageDir: () => w.dir });
    const b = createMcp({ runtime: mkRuntime(w.proj), env: w.env, piBin: w.binPath, piVersion: () => pv.read() }).readReport();
    check('报告带规范版本状态（value/source/status/updatedAt）', () => {
      assert.equal(b.version.value, '0.99.1');
      assert.equal(b.version.source, 'package.json');
      assert.equal(b.version.status, 'known');
      assert.match(b.version.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    });
    check('piVersion 字符串字段保持向后兼容', () => assert.equal(b.piVersion, '0.99.1'));
    const b2 = createMcp({ runtime: mkRuntime(w.proj), env: w.env, piBin: w.binPath }).readReport();
    check('没注入时兜底也给完整状态（updatedAt 不为 null）', () => assert.match(b2.version.updatedAt, /^\d{4}-\d{2}-\d{2}T/));
  }

  /* ================= F. 脱敏 ================= */
  section('F. 脱敏');
  {
    const w = mkPiPackage('redact', {
      version: '0.99.1',
      builtins: BUILTINS_099,
      apiTypes: API_099,
      rpcTypes: RPC_TYPES,
      mcpDoc: MCP_DOC,
      files: {},
    });
    fs.writeFileSync(
      path.join(w.agent, 'mcp.json'),
      JSON.stringify({ mcpServers: { 'work-jira': { url: 'https://mcp.example.com', headers: { Authorization: 'Bearer ghp_MCP_SECRET_777' }, env: { API_KEY: 'sk-live-SECRET-888' } } } }),
      'utf8'
    );
    const b = createMcp({ runtime: mkRuntime(w.proj), env: w.env, piBin: w.binPath }).readReport();
    const body = JSON.stringify(b);
    check('mcp.json 的密钥不进报告', () => assert.ok(!/ghp_MCP_SECRET|sk-live-SECRET/.test(body)));
    check('mcp.json 的 Server 名与内容不进报告', () => assert.ok(!/work-jira|mcpServers|Authorization/.test(body)));
    check('只报存在与否', () => assert.equal(b.mcpConfig.user.exists, true));
    check('报告里没有 pi 包绝对路径', () => assert.ok(!body.includes(w.dir.replace(/\\/g, '\\\\')) && !body.includes(w.dir)));
    check('诊断级的字段不含 payload（evidence 只有一行原文）', () => assert.ok(String(b.evidence).length < 400));
  }

  /* ================= G. schema drift（pi-compat） ================= */
  section('G. schema drift 与异常记录');
  {
    const c = createPiCompat({
      piVersionProbe: () => '0.99.1',
      versionSourceProbe: () => ({ source: 'package.json', status: 'known', updatedAt: '2026-10-01T00:00:00.000Z' }),
      now: () => 1700000000000,
    });
    c.observeUpstream({ type: 'response', command: 'get_state', success: true, data: { sessionId: 's1' } });
    const rep = c.report();
    check('缺 sessionFile → 记一条 missing-field（形状漂移可见）', () =>
      rep.issues.some((i) => i.category === 'response' && i.issue === 'missing-field' && i.field === 'sessionFile'));
    check('版本状态出处进了报告', () => {
      assert.equal(rep.version, '0.99.1');
      assert.equal(rep.versionSource.source, 'package.json');
      assert.equal(rep.versionSource.status, 'known');
    });
    check('异常里不含任何值（只有字段名与类型）', () => {
      const s = JSON.stringify(rep.issues);
      assert.ok(!s.includes('s1'));
    });
  }
  {
    const c = createPiCompat({ now: () => 1700000000000 });
    c.observeUpstream({ type: 'some_brand_new_event', payload: 'PRIVATE_PAYLOAD' });
    const rep = c.report();
    check('未知事件被安全忽略但留痕', () => rep.issues.some((i) => i.issue === 'unknown-event'));
    check('未知事件的 payload 不进异常记录', () => assert.ok(!JSON.stringify(rep.issues).includes('PRIVATE_PAYLOAD')));
    check('没注入版本源时 versionSource 为 null（不编造）', () => assert.equal(rep.versionSource, null));
  }
  {
    const c = createPiCompat({ versionSourceProbe: () => ({ source: 'weird', status: 'nonsense', updatedAt: 42 }) });
    check('版本源的未知枚举被归一（不回显原值）', () => {
      const vs = c.report().versionSource;
      assert.equal(vs.status, 'unknown');
      assert.equal(vs.updatedAt, null);
    });
  }
  {
    const c = createPiCompat({ versionSourceProbe: () => { throw new Error('boom'); } });
    check('版本源抛错 → null，不影响报告', () => assert.equal(c.report().versionSource, null));
  }

  /* ================= H. launch identity（P20.5 Blocker A） ================= */
  section('H. launch identity：spawn 的命令与探测读的包同源');
  {
    /* 明确路径的入口：包就在它上面几层，必须绑到**它自己**的包。 */
    const w = mkPiPackage('h-path', { version: '0.99.1', builtins: BUILTINS_099, apiTypes: API_099 });
    const L = createPiLaunch({ piBin: w.binPath, env: w.env });
    const id = L.identity();
    check('明确路径的入口 → source=env、包目录绑到它自己那份', () => {
      assert.equal(id.source, 'env');
      assert.equal(id.entryKnown, true);
      assert.equal(id.packageDir, w.dir);
      assert.equal(id.packageDirKnown, true);
    });
    check('summary 只给脱敏字段，绝对路径一个字节都不出', () => {
      const s = L.summary();
      assert.deepEqual(Object.keys(s).sort(), ['binName', 'entryKnown', 'packageDirKnown', 'source']);
      assert.equal(s.binName, path.basename(w.binPath));
      const text = JSON.stringify(s);
      assert.ok(!text.includes(w.base));
      assert.ok(!text.includes(TMP));
    });

    /* 入口不存在 → 证明不了，宁可 null；**旁边躺着一个真包也不许去捡。** */
    const other = mkPiPackage('h-other', { version: '0.87.0', builtins: BUILTINS_087, apiTypes: API_087 });
    const miss = createPiLaunch({
      piBin: path.join(TMP, 'h-missing', 'pi'),
      env: { ...other.env, APPDATA: other.base, PATH: '' },
    }).identity();
    check('入口不存在 → packageDir=null（不退到「常见全局位置」去捡一份）', () => {
      assert.equal(miss.source, 'env');
      assert.equal(miss.entryKnown, false);
      assert.equal(miss.packageDir, null);
      assert.equal(miss.packageDirKnown, false);
    });

    /* 裸命令：真正解析靠 PATH / PATHEXT，不靠清单。 */
    const p = mkPiPackage('h-pathenv', { version: '0.99.1', builtins: BUILTINS_099, apiTypes: API_099 });
    const found = createPiLaunch({
      piBin: 'pi',
      env: { PATH: path.dirname(p.binPath), PATHEXT: '' },
      isWin: false,
    }).identity();
    check('POSIX：裸命令按 PATH 解析并绑上包', () => {
      assert.equal(found.source, 'path');
      assert.equal(found.entryKnown, true);
      assert.equal(found.packageDir, p.dir);
    });
    const winFound = createPiLaunch({
      piBin: 'pi',
      env: { PATH: path.dirname(p.binPath), PATHEXT: '' },
      isWin: true,
    }).identity();
    check('Windows：先试精确名（cmd 的规则），同样绑上包', () => assert.equal(winFound.packageDir, p.dir));

    const c = mkPiPackage('h-cmd', { version: '0.99.1', builtins: BUILTINS_099, apiTypes: API_099 });
    fs.writeFileSync(c.binPath + '.cmd', '@echo off\r\n', 'utf8');
    fs.rmSync(c.binPath); // 只留 .cmd —— 逼出 PATHEXT 补后缀这条路
    const byExt = createPiLaunch({
      piBin: 'pi',
      env: { PATH: path.dirname(c.binPath), PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      isWin: true,
    }).identity();
    check('PATHEXT 补后缀也能找到 pi.cmd 并绑上包', () => assert.equal(byExt.packageDir, c.dir));

    const noPath = createPiLaunch({ piBin: 'pi', env: {}, isWin: false }).identity();
    check('没有 PATH → packageDir=null（不猜）', () => {
      assert.equal(noPath.source, 'path');
      assert.equal(noPath.entryKnown, false);
      assert.equal(noPath.packageDir, null);
    });

    /* ★ 核心回归：PATH 指向 A，「常见全局位置」里躺着一份 B。
     * 旧的 `locatePiPackage()` 只认 APPDATA / LOCALAPPDATA / HOME 那几张清单、
     * **不看 PATH**，而 bridge spawn 看 PATH —— 于是探测会读 B、启动的是 A。
     * 现在两件事只能是同一个答案。 */
    const A = mkPiPackage('h-A', { version: '0.87.0', builtins: BUILTINS_087, apiTypes: API_087 });
    const bDir = path.join(TMP, 'h-B', 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent');
    const bBin = path.join(TMP, 'h-B', 'npm', 'pi');
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(path.dirname(bBin), { recursive: true });
    fs.writeFileSync(path.join(bDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.99.1' }), 'utf8');
    fs.writeFileSync(bBin, '#!/usr/bin/env node\n', 'utf8');
    const diverged = createPiLaunch({
      piBin: 'pi',
      env: { PATH: path.dirname(A.binPath), APPDATA: path.join(TMP, 'h-B'), HOME: path.join(TMP, 'h-B'), PATHEXT: '' },
      isWin: false,
    });
    const d = diverged.identity();
    check('★ PATH 指向 A、B 藏在「常见全局位置」→ 绑的是 A，不是 B', () => {
      assert.equal(d.packageDir, A.dir);
      assert.ok(d.packageDir !== bDir, '绑到了另一份 pi 的包（这正是 Blocker A）');
    });
    check('版本真值跟着 launch identity 走（读 A 的 package.json，不是 B 的）', () => {
      const pv = createPiVersion({ resolvePackageDir: diverged.packageDir });
      assert.equal(pv.read().value, '0.87.0');
      assert.equal(pv.read().source, 'package.json');
    });
    check('能力探测读的也是 A（不是 B 那份 0.99 built-ins）', () => {
      const bi = createPiBuiltins({ resolvePackageDir: diverged.packageDir, env: A.env }).read({ cwd: null });
      assert.deepEqual(bi.builtins.map((x) => x.id), ['llama.cpp']);
    });
    check('summary 只暴露 basename，不暴露 A 的路径', () => {
      const s = diverged.summary();
      assert.equal(s.binName, 'pi');
      assert.ok(!JSON.stringify(s).includes(A.base));
    });
    check('显式指向 B 时就绑 B（身份跟 PI_BIN 走，不跟 PATH 走）', () => {
      const lb = createPiLaunch({ piBin: bBin, env: { PATH: path.dirname(A.binPath) } });
      assert.equal(lb.identity().packageDir, bDir);
    });

    /* Windows 下 cwd 参与命令搜索（cmd 的规则）—— 缓存按 cwd 分键，
     * 所以「切项目」会重新解析，不会把上一个项目的结论带过来。 */
    const rel = mkPiPackage('h-cwd', { version: '0.99.1', builtins: BUILTINS_099, apiTypes: API_099 });
    check('Windows 下先按 cwd 找，切 cwd 后结论跟着变', () => {
      let cur = path.dirname(rel.binPath);
      const Lr = createPiLaunch({ piBin: 'pi', env: { PATH: '' }, isWin: true, getCwd: () => cur });
      assert.equal(Lr.packageDir(), rel.dir);
      cur = TMP; // 这里没有 pi
      assert.equal(Lr.packageDir(), null);
    });
  }

  section('H2. formatLaunch：bridge 与 --version 用同一份成形规则');
  {
    const posix = formatLaunch('/usr/local/bin/pi', ['--mode', 'rpc', '--continue'], false);
    check('POSIX：参数走数组、不拼串、不加 shell', () => {
      assert.deepEqual(posix, { command: '/usr/local/bin/pi', spawnArgs: ['--mode', 'rpc', '--continue'], shell: false });
    });
    const win = formatLaunch('C:\\x\\pi.cmd', ['--mode', 'rpc'], true);
    check('Windows：拼成一条命令串、空 args、shell:true（绕开 DEP0190）', () => {
      assert.equal(win.command, '"C:\\x\\pi.cmd" "--mode" "rpc"');
      assert.deepEqual(win.spawnArgs, []);
      assert.equal(win.shell, true);
    });
    const L = createPiLaunch({ piBin: 'pi', env: {}, isWin: true });
    check('launcher("--version") 走的就是 formatLaunch（同一份代码）', () => {
      assert.deepEqual(L.launcher(['--version']), formatLaunch('pi', ['--version'], true));
      assert.equal(L.launcher(['--version']).command, '"pi" "--version"');
    });
    check('version probe 按 launcher 拼出来的命令执行（注入的 run 收到同一份 spec）', () => {
      const seen = [];
      const probe = createPiVersionProbe({
        launcher: L.launcher,
        run: (cmd, args, opts) => { seen.push({ cmd, args, shell: opts.shell }); return { stdout: '0.99.1\n', stderr: '' }; },
      });
      assert.equal(probe(), '0.99.1');
      assert.deepEqual(seen, [{ cmd: '"pi" "--version"', args: [], shell: true }]);
    });
  }

  /* ================= I. version cache 绑定 launch identity（不等 TTL） ================= */
  section('I. version cache 以 launch identity 为 key');
  {
    const wA = mkPiPackage('i-A', { version: '0.87.0', builtins: BUILTINS_087, apiTypes: API_087 });
    const wB = mkPiPackage('i-B', { version: '0.99.1', builtins: BUILTINS_099, apiTypes: API_099 });
    let t = 1000;
    let key = 'A';
    let reads = 0;
    const pv = createPiVersion({
      resolvePackageDir: () => { reads++; return key === 'A' ? wA.dir : wB.dir; },
      identityKey: () => key,
      now: () => t,
      ttlMs: 5000,
    });
    check('I1 同一 identity、TTL 未过 → 不重复 probe', () => {
      assert.equal(pv.read().value, '0.87.0');
      t = 2000;
      assert.equal(pv.read().value, '0.87.0');
      assert.equal(reads, 1);
    });
    check('I2 同一 identity、TTL 过期 → 重新 probe', () => {
      t = 9000;
      assert.equal(pv.read().value, '0.87.0');
      assert.equal(reads, 2);
    });
    check('I3 identity 改变、TTL 未过 → 立即重新 probe（不等 TTL）', () => {
      t = 9100; // 距上次仅 100ms，TTL 内
      key = 'B';
      const r = pv.read();
      assert.equal(r.value, '0.99.1');
      assert.equal(r.source, 'package.json');
      assert.equal(reads, 3);
    });
    check('I4 A→B：0.87→0.99 立即更新', () => assert.equal(pv.read().value, '0.99.1'));
    check('I5 B→A：切回去立即更新（不残留 B 的值）', () => {
      key = 'A';
      assert.equal(pv.read().value, '0.87.0');
      assert.equal(reads, 4);
    });
    check('I10 malformed 不跨 identity 泄漏（A 畸形→B 正常）', () => {
      const wM = mkPiPackage('i-M', { version: 'not-a-version' });
      let k2 = 'M';
      const pv2 = createPiVersion({
        resolvePackageDir: () => (k2 === 'M' ? wM.dir : wB.dir),
        identityKey: () => k2,
        now: () => 50000,
        ttlMs: 60000,
      });
      const m = pv2.read();
      assert.equal(m.status, 'malformed');
      assert.equal(m.value, null);
      k2 = 'B';
      const b = pv2.read();
      assert.equal(b.status, 'known');
      assert.equal(b.value, '0.99.1');
      k2 = 'M';
      assert.equal(pv2.read().status, 'malformed');
    });
    check('I0 没注入 identityKey 时保持纯 TTL 行为（老调用方不受影响）', () => {
      let tt = 0;
      let rr = 0;
      const legacy = createPiVersion({ resolvePackageDir: () => { rr++; return wA.dir; }, now: () => tt, ttlMs: 5000 });
      legacy.read();
      tt = 1000;
      legacy.read();
      assert.equal(rr, 1);
      assert.equal(legacy.read().value, '0.87.0');
    });
    check('I0b peek 不把内部 key 泄漏出去', () => {
      const p = pv.peek();
      assert.ok(p && typeof p === 'object');
      assert.ok(!('key' in p), 'peek 把内部 cache key 带出来了');
    });
  }
  {
    /* identityKey 本身的稳定性：cwd 变 ≠ Pi 变；target 变才变。 */
    check('I6 cwd 变化但解析到同一个 Pi → key 不变（可复用 cache）', () => {
      const w = mkPiPackage('i-same', { version: '0.99.1' });
      let cur = path.join(TMP, 'i-cwd-a');
      fs.mkdirSync(cur, { recursive: true });
      const other = path.join(TMP, 'i-cwd-b');
      fs.mkdirSync(other, { recursive: true });
      const L = createPiLaunch({
        piBin: 'pi',
        env: { PATH: path.dirname(w.binPath), PATHEXT: '' },
        isWin: false,
        getCwd: () => cur,
      });
      const k1 = L.identityKey();
      cur = other; // POSIX 下 cwd 不参与搜索，结论应相同
      const k2 = L.identityKey();
      assert.equal(k1, k2);
      assert.equal(L.packageDir(), w.dir);
    });
    check('I6b 同一 Pi、cwd 变了 → version 不重探（复用 TTL）', () => {
      const w = mkPiPackage('i-reuse', { version: '0.99.1' });
      let cur = path.join(TMP, 'i-reuse-a');
      fs.mkdirSync(cur, { recursive: true });
      const other = path.join(TMP, 'i-reuse-b');
      fs.mkdirSync(other, { recursive: true });
      const L = createPiLaunch({
        piBin: 'pi',
        env: { PATH: path.dirname(w.binPath), PATHEXT: '' },
        isWin: false,
        getCwd: () => cur,
      });
      let reads = 0;
      const orig = L.packageDir.bind(L);
      const pv = createPiVersion({
        resolvePackageDir: () => { reads++; return orig(); },
        identityKey: L.identityKey,
        now: () => 1000,
        ttlMs: 60000,
      });
      assert.equal(pv.read().value, '0.99.1');
      cur = other;
      assert.equal(pv.read().value, '0.99.1');
      assert.equal(reads, 1);
    });
    check('I7 cwd 变化且解析成不同 Pi → key 改变', () => {
      const A = mkPiPackage('i-diff-A', { version: '0.87.0' });
      const B = mkPiPackage('i-diff-B', { version: '0.99.1' });
      // Windows 规则：cwd 优先。每个包的 bin 目录本身就是一个「项目目录」，
      // 上面恰好躺着可执行的 `pi`，向上正好绑到它自己的包。
      let cur = path.dirname(A.binPath);
      const L = createPiLaunch({ piBin: 'pi', env: { PATH: '', PATHEXT: '' }, isWin: true, getCwd: () => cur });
      const kA = L.identityKey();
      assert.equal(L.packageDir(), A.dir);
      cur = path.dirname(B.binPath);
      const kB = L.identityKey();
      assert.equal(L.packageDir(), B.dir);
      assert.ok(kA !== kB, '不同 launch target 的 key 必须不同');
    });
    check('I8 packageDir unknown、但 target 路径变了 → key 仍改变', () => {
      const fA = path.join(TMP, 'i-unk-a', 'pi.exe');
      const fB = path.join(TMP, 'i-unk-b', 'pi.exe');
      for (const f of [fA, fB]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x', 'utf8'); }
      // 这两个文件都不在任何 pi 包里 → packageDir 都是 null，但 target 不同
      const LA = createPiLaunch({ piBin: fA, env: {}, isWin: false });
      const LB = createPiLaunch({ piBin: fB, env: {}, isWin: false });
      assert.equal(LA.packageDir(), null);
      assert.equal(LB.packageDir(), null);
      assert.ok(LA.identityKey() !== LB.identityKey(), 'target 不同就不能共用 version 缓存');
    });
    check('I9 packageDir unknown、同一 target → 可复用（key 稳定）', () => {
      const f = path.join(TMP, 'i-unk-same', 'pi.exe');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'x', 'utf8');
      const L = createPiLaunch({ piBin: f, env: {}, isWin: false });
      assert.equal(L.packageDir(), null);
      assert.equal(L.identityKey(), L.identityKey());
    });
    check('I9b identityKey 是不透明串（不含绝对路径，可进不了 Diagnostics）', () => {
      const w = mkPiPackage('i-opaque', { version: '0.99.1' });
      const L = createPiLaunch({ piBin: w.binPath, env: w.env });
      const k = L.identityKey();
      assert.match(k, /^v1-[0-9a-f]+$/);
      assert.ok(!k.includes(w.base) && !k.includes(TMP));
      assert.deepEqual(Object.keys(L.summary()).sort(), ['binName', 'entryKnown', 'packageDirKnown', 'source']);
    });
  }
  {
    /* 集成：Project A（0.87 / llama.cpp only）→ Project B（0.99 / 四 built-in + mcp）。
     * Windows-like 解析（PI_BIN='pi'，cwd 优先），不推进 fake clock，
     * 切项目后立即读 —— version 与 capability 必须是同一 identity 的证据。 */
    section('I-int. 切项目集成：version / builtins / MCP 同源立即一致');
    const A = mkPiPackage('int-A', { version: '0.87.0', builtins: BUILTINS_087, apiTypes: API_087, rpcTypes: RPC_TYPES });
    const B = mkPiPackage('int-B', { version: '0.99.1', builtins: BUILTINS_099, apiTypes: API_099, rpcTypes: RPC_TYPES, mcpDoc: MCP_DOC });
    let cur = path.dirname(A.binPath);
    const t0 = 7770000000000;
    const launch = createPiLaunch({ piBin: 'pi', env: { PATH: '', PATHEXT: '' }, isWin: true, getCwd: () => cur, now: () => t0 });
    const pv = createPiVersion({
      resolvePackageDir: launch.packageDir,
      probeVersion: () => null, // 包能证明，不走 --version
      identityKey: launch.identityKey,
      now: () => t0, // 切项目时**不**推进时钟 —— 断言靠 key 失效，不是靠 TTL
      ttlMs: 30000,
    });
    const { createPiBuiltins: mkBuiltins } = await import('../server/pi-builtins.js');
    const bi = mkBuiltins({ resolvePackageDir: launch.packageDir, env: { HOME: TMP, PI_CODING_AGENT_DIR: path.join(TMP, 'int-agent') }, now: () => t0, ttlMs: 30000 });
    const runtime = { getCurrentCwd: () => cur };
    const mcp = createMcp({
      runtime,
      env: { HOME: TMP, PI_CODING_AGENT_DIR: path.join(TMP, 'int-agent') },
      resolvePackageDir: launch.packageDir,
      piVersion: () => pv.read(),
      piBuiltins: (cwd) => bi.read({ cwd }),
    });
    check('集成 A：version=0.87.0、builtin:mcp 缺席', () => {
      const v = pv.read();
      assert.equal(v.value, '0.87.0');
      assert.equal(v.source, 'package.json');
      const rep = mcp.readReport();
      assert.equal(rep.piVersion, '0.87.0');
      assert.equal(rep.supported, false);
      assert.deepEqual(rep.builtins.entries.map((e) => e.id), ['llama.cpp']);
    });
    cur = path.dirname(B.binPath); // ← 切项目：runtime cwd 已是 B，clock 不动
    check('集成 B：不等 TTL，version 立即 0.99.1、builtin:mcp=true', () => {
      const v = pv.read();
      assert.equal(v.value, '0.99.1');
      const rep = mcp.readReport();
      assert.equal(rep.piVersion, '0.99.1');
      assert.equal(rep.version.value, '0.99.1');
      assert.equal(rep.supported, true);
      assert.ok(rep.builtins.entries.some((e) => e.id === 'mcp'));
    });
    check('集成 Diagnostics 侧：同一 pv 读到的就是诊断用的版本（切项目立即同步）', () => {
      const d = createDiagnostics({
        runtime,
        rpc: { getState: () => ({ piRunning: true, bridgeRun: 1, hasProject: true, args: [] }) },
        agentRegistry: { list: () => [] },
        mcp,
        piVersion: () => pv.read(),
        launch: launch.summary,
        dataDir: TMP,
        version: '0.0.0-test',
        env: {},
      }).readSnapshot();
      assert.equal(d.pi.version, '0.99.1');
      assert.equal(d.mcp.piVersion, '0.99.1');
    });
  }

  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  console.log(`\n${count}/${count} 通过`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
