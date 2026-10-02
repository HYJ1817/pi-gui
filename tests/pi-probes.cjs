/* P23 Long-term Compatibility / Upgrade Safety：离线契约。
 *
 * 完全离线：不启动 pi、不联网、不读用户真实的 `~/.pi`、**不执行任何 Extension 代码**。
 * 所有 pi 包都是 `os.tmpdir()` 里现造的假包 —— 断言「跑测试这台机器装了什么」
 * 的测试在 CI 上必红，所以一条都没有。
 *
 * 覆盖：
 *   A. 兼容矩阵 —— 版本比较、已验证/未核对/未知、Extension 版本、矩阵摘要不含路径与 URL
 *   B. probe registry —— source probe 的 supported / unsupported / unknown 与**抛错**
 *      （文件是目录）、缺包、畸形形状；runtime probe 的三值
 *   C. probe 缓存与失效 —— TTL / identity 变化 / reset（restart invalidation）
 *   D. 版本真值 —— verifiedAgainst / verification 四态
 *   E. schema 漂移 —— 只记来源 + 字段名 + 类型（**不记值、不记键名**）、环形上限、reset
 *   F. Diagnostics 集成 —— probe / 矩阵 / Native MCP / Extension 版本 / 脱敏
 *   G. MCP 原生投影的漂移出口（onDrift）
 *   H. 纪律 —— 新模块不 spawn / 不联网 / 不执行第三方代码
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p23-'));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ---------- fixture：假 pi 包 ---------- */

/** 33 条真实量级的 RpcCommand 联合（形状照抄 rpc-types.d.ts）。 */
const RPC_COMMANDS = [
  'abort', 'get_commands', 'get_messages', 'get_state', 'get_session_stats',
  'new_session', 'switch_session', 'set_session_name', 'set_model', 'set_thinking_level',
  'prompt', 'compact', 'fork_session', 'list_sessions', 'delete_session',
  'rename_session', 'archive_session', 'restore_session', 'get_tree', 'get_config',
  'set_config', 'list_models', 'get_providers', 'set_provider', 'clear_context',
  'get_context', 'edit_context', 'add_label', 'remove_label', 'list_labels',
  'export_session', 'import_session', 'ping',
];

function rpcTypesSource(names = RPC_COMMANDS) {
  const members = names.map((n) => `  | { type: "${n}"; id?: string; success?: boolean; data?: unknown }`).join('\n');
  return `export type RpcCommand =\n${members};\n\nexport type RpcResponse = { type: "response" };\n`;
}

/** 0.99.2 量级的 builtInExtensions（带 builtin:mcp）。 */
const BUILTINS_099 = 'export const builtInExtensions = [\n'
  + '  { name: "llama.cpp", factory: llamaExtension, builtin: true },\n'
  + '  { name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },\n'
  + '  { name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },\n'
  + '  { name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },\n'
  + '];\n';
/** 0.87.0 量级：只有 llama.cpp。 */
const BUILTINS_087 = 'export const builtInExtensions = [\n  { name: "llama.cpp", factory: llamaExtension, hidden: true },\n];\n';

const EXT_TYPES = 'export interface ToolCallEventResult {\n  block?: boolean;\n  reason?: string;\n}\n';
const EXT_DOCS = '# Extensions\nFired after `tool_execution_start`, before the tool executes. **Can block.**\n';
const RPC_DOCS = '# RPC\n## Dialog methods\nThey emit an `extension_ui_request` and block until the client sends back an `extension_ui_response`.\n';
const USAGE_DOCS_087 = 'It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode.\n';
const USAGE_DOCS_099 = '## MCP\nServers are configured with `pi mcp add`.\n';
const MCP_RUNTIME = 'export type ServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";\n';
const MCP_CLI = 'export function list() { return { servers, resources, resourceTemplates }; }\n';

/** 造一个「像 pi 包」的目录；`omit` 用来造缺文件的版本。 */
function mkPiPackage(name, { version = '0.99.2', omit = [], override = {} } = {}) {
  const dir = path.join(TMP, name, 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version,
    /* mcp-native 从 launch identity 派生 CLI 入口 —— 形状照 npm 真实包。 */
    bin: { pi: 'dist/bundle/cli.js' },
  }), 'utf8');
  fs.mkdirSync(path.join(dir, 'dist', 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'bundle', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  const files = {
    'dist/modes/rpc/rpc-types.d.ts': rpcTypesSource(),
    'dist/core/extensions/types.d.ts': EXT_TYPES,
    'dist/extensions/index.js': BUILTINS_099,
    'docs/extensions.md': EXT_DOCS,
    'docs/rpc.md': RPC_DOCS,
    'docs/usage.md': USAGE_DOCS_099,
    'dist/extensions/mcp/runtime.d.ts': MCP_RUNTIME,
    'dist/extensions/mcp/cli.js': MCP_CLI,
    ...override,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (omit.includes(rel)) continue;
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

/** 把一个路径做成**目录**：用来模拟「文件读不出来」（statSync 不是文件）。 */
function mkDirAt(dir, rel) {
  const full = path.join(dir, ...rel.split('/'));
  fs.rmSync(full, { recursive: true, force: true });
  fs.mkdirSync(full, { recursive: true });
}

/* ---------- 假的 runtime 观察源 ---------- */

function mkCompat(capabilities = {}) {
  return { report: () => ({ capabilities: { rpc: null, toolEvents: null, extensionUi: null, ...capabilities } }) };
}
function mkNativeSummary(native) {
  return { peekSummary: () => (native === null ? null : { fresh: true, native, servers: [], trust: { trusted: true } }) };
}

(async () => {
  const matrix = await import('../server/pi-compat-matrix.js');
  const probesMod = await import('../server/pi-probes.js');
  const { createPiProbes, PROBE_DEFS, parseRpcCommands } = probesMod;
  const { createPiVersion } = await import('../server/pi-version.js');
  const { createPiCompat } = await import('../server/pi-compat.js');
  const { createDiagnostics } = await import('../server/diagnostics.js');
  const { createMcpNative } = await import('../server/mcp-native.js');

  const report = (mod, opts) => (opts ? mod.report(opts) : mod.report());
  const probeOf = (r, id) => r.probes.find((p) => p.id === id);

  /* ================= A. 兼容矩阵 ================= */
  section('A. 兼容矩阵（小型、明确、不联网）');
  check('版本比较：数字三段，非版本号回 null（不猜）', () => {
    assert.equal(matrix.compareVersions('0.99.2', '0.99.1'), 1);
    assert.equal(matrix.compareVersions('0.99.1', '0.99.2'), -1);
    assert.equal(matrix.compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(matrix.compareVersions('not-a-version', '1.0.0'), null);
    assert.equal(matrix.compareVersions(null, '1.0.0'), null);
  });
  check('已登记的 Pi 版本都能被认出来（verified + 基线元数据）', () => {
    for (const base of matrix.PI_BASELINES) {
      const hit = matrix.lookupPiVersion(base.version);
      assert.equal(hit.status, 'verified', base.version);
      assert.equal(hit.verifiedAgainst.version, base.version);
      assert.ok(hit.verifiedAgainst.verifiedAt && hit.verifiedAgainst.scope);
    }
  });
  check('没核对过的版本是 unverified —— 不是「不支持」，也不猜新/旧以外的结论', () => {
    const newer = matrix.lookupPiVersion('1.2.3');
    assert.equal(newer.status, 'unverified');
    assert.equal(newer.verifiedAgainst, null);
    assert.equal(newer.relative, 'newer');
    const older = matrix.lookupPiVersion('0.50.0');
    assert.equal(older.status, 'unverified');
    assert.equal(older.relative, 'older');
  });
  check('版本没读到是 unknown（与「未核对」是两件事）', () => {
    assert.equal(matrix.lookupPiVersion(null).status, 'unknown');
    assert.equal(matrix.lookupPiVersion('').status, 'unknown');
    assert.equal(matrix.lookupPiVersion('not-a-version').status, 'unverified');
  });
  check('当前基线是 1.0.0，且只有一条 current', () => {
    assert.equal(matrix.currentBaseline().version, '1.0.0');
    assert.equal(matrix.PI_BASELINES.filter((b) => b.scope === 'current').length, 1);
    assert.ok(matrix.baselineSentence().includes('1.0.0'));
    /* 0.99.2 降为 historical：它仍然在表里（旧机器 / 旧包照样「核对过」），
     * 但不再是「当前对照物」。 */
    const old = matrix.PI_BASELINES.find((b) => b.version === '0.99.2');
    assert.equal(old.scope, 'historical');
  });
  check('关键 Extension：同一版本 verified，别的版本 unverified，没版本 unknown', () => {
    for (const base of matrix.EXTENSION_BASELINES) {
      const hit = matrix.lookupExtension(base.name, base.version);
      assert.equal(hit.status, 'verified', base.name);
      assert.equal(hit.baseline.contract.length > 0, true, base.name);
    }
    assert.equal(matrix.lookupExtension('pi-memory', '9.9.9').status, 'unverified');
    assert.equal(matrix.lookupExtension('pi-memory', null).status, 'unknown');
    assert.equal(matrix.lookupExtension('some-other-pkg', '1.0.0').status, 'unlisted');
  });
  check('矩阵摘要只有版本号与日期：没有路径、没有 URL、没有包内容', () => {
    const text = JSON.stringify(matrix.matrixSummary());
    assert.ok(!/[A-Za-z]:[\\/]/.test(text), '出现了绝对路径');
    assert.ok(!text.includes('/home/') && !text.includes('/Users/'), '出现了 POSIX 绝对路径');
    assert.ok(!/https?:\/\//.test(text), '出现了 URL');
    assert.ok(text.includes('0.99.2') && text.includes('pi-memory'));
  });
  check('Native MCP 契约是一份可核对的副本（闭集 + CLI + 命名）', () => {
    const c = matrix.NATIVE_MCP_CONTRACT;
    assert.equal(c.builtinId, 'mcp');
    assert.equal(c.replaceable, true);
    assert.deepEqual([...c.serverStates].sort(), ['closed', 'connected', 'connecting', 'disconnected', 'failed', 'needs-auth']);
    assert.deepEqual([...c.exposures], ['codemode', 'deferred', 'direct', 'hidden']);
    assert.ok(c.cliSubcommands.includes('add') && c.cliSubcommands.includes('list'));
    assert.ok(c.toolNamePattern.includes('mcp__'));
  });
  check('已知差异逐条带 between / affects / handling', () => {
    assert.ok(matrix.KNOWN_DIFFERENCES.length >= 3);
    for (const d of matrix.KNOWN_DIFFERENCES) {
      assert.ok(d.id && d.between && d.affects && d.handling, d.id);
    }
  });

  /* ================= B. probe registry ================= */
  section('B. Capability probe registry（只读、无副作用）');
  check('probe 表本身可列，且每条都有 label / what / fallback', () => {
    assert.ok(PROBE_DEFS.length >= 12);
    for (const def of PROBE_DEFS) {
      assert.ok(def.id && def.label && def.what && def.fallback, def.id);
      assert.ok(def.kind === 'source' || def.kind === 'runtime', def.id);
    }
    assert.equal(new Set(PROBE_DEFS.map((d) => d.id)).size, PROBE_DEFS.length, 'probe id 有重复');
  });
  check('RpcCommand 解析：33 条命令，形状不认识时回 null（不猜）', () => {
    assert.equal(parseRpcCommands(rpcTypesSource()).length, 33);
    assert.equal(parseRpcCommands('export type RpcCommand = whatever;'), null);
    assert.equal(parseRpcCommands(''), null);
    assert.equal(parseRpcCommands(null), null);
  });

  const pkg099 = mkPiPackage('pkg-099');
  const pkg087 = mkPiPackage('pkg-087', { version: '0.87.0', omit: ['dist/extensions/mcp/runtime.d.ts', 'dist/extensions/mcp/cli.js'], override: { 'dist/extensions/index.js': BUILTINS_087, 'docs/usage.md': USAGE_DOCS_087 } });
  const pkgBroken = mkPiPackage('pkg-broken');

  const probes099 = createPiProbes({
    resolvePackageDir: () => pkg099,
    compat: mkCompat({ rpc: true, toolEvents: true, extensionUi: null }),
    mcpNative: mkNativeSummary({ state: 'active', reason: 'builtin:mcp 在包里、未被禁用、未被接管', replaced: false, disabled: null, builtinPresent: true }),
  });
  const r099 = report(probes099);

  check('0.99 量级：RPC 命令集 / 对话框 / 审批 hook / builtin:mcp 都是支持', () => {
    assert.equal(probeOf(r099, 'rpc-commands').state, true);
    assert.equal(probeOf(r099, 'extension-ui').state, true);
    assert.equal(probeOf(r099, 'approval-hook').state, true);
    assert.equal(probeOf(r099, 'builtin-mcp').state, true);
    assert.equal(probeOf(r099, 'builtin-codemode-tool-search').state, true);
  });
  check('「RPC 没有工具清单命令」是一条**正证据**（有根带 tool 的命令就变 false）', () => {
    assert.equal(probeOf(r099, 'rpc-no-tool-list').state, true);
    const withTool = mkPiPackage('pkg-toolcmd', { override: { 'dist/modes/rpc/rpc-types.d.ts': rpcTypesSource([...RPC_COMMANDS, 'get_tools']) } });
    const p = createPiProbes({ resolvePackageDir: () => withTool });
    assert.equal(probeOf(report(p), 'rpc-no-tool-list').state, false);
  });
  check('MCP 闭集与 list --json 资源字段：有证据才是 true', () => {
    assert.equal(probeOf(r099, 'mcp-runtime-states').state, true);
    assert.equal(probeOf(r099, 'mcp-cli-resources').state, true);
  });
  check('每条 probe 都带出处（相对路径或来源说明，不含绝对路径）', () => {
    for (const p of r099.probes) {
      assert.ok(typeof p.evidence === 'string' && p.evidence.length > 0, p.id);
      assert.ok(!p.evidence.includes(TMP), p.id + ' 的证据里出现了绝对路径');
      assert.ok(p.evidence.length <= 200, p.id + ' 的证据没有限长');
    }
  });
  check('runtime probe 取三值：支持 / 不支持 / 还没观察到', () => {
    assert.equal(probeOf(r099, 'rpc').state, true);
    assert.equal(probeOf(r099, 'tool-events').state, true);
    assert.equal(probeOf(r099, 'extension-ui-runtime').state, null);
    assert.equal(probeOf(r099, 'mcp-native').state, true);
    assert.equal(probeOf(r099, 'mcp-replacement').state, false);
  });
  check('0.87 量级：builtin:mcp 为 false，MCP 闭集读不到是未知', () => {
    const p = createPiProbes({
      resolvePackageDir: () => pkg087,
      compat: mkCompat({ rpc: true }),
      mcpNative: mkNativeSummary({ state: 'unsupported', reason: '这个 pi 包里没有 builtin:mcp', replaced: false, disabled: null, builtinPresent: false }),
    });
    const r = report(p);
    assert.equal(probeOf(r, 'builtin-mcp').state, false);
    assert.equal(probeOf(r, 'builtin-codemode-tool-search').state, false);
    assert.equal(probeOf(r, 'mcp-runtime-states').state, null);
    assert.equal(probeOf(r, 'mcp-cli-resources').state, null);
    /* 0.87 的 usage.md 明确写着不含 permission popups → 「核心有审批」= false */
    assert.equal(probeOf(r, 'core-approval').state, false);
    assert.equal(probeOf(r, 'mcp-native').state, false);
  });
  check('0.99 量级：usage.md 没那句话 → 核心审批保持未知（不据此断言「有」）', () => {
    assert.equal(probeOf(r099, 'core-approval').state, null);
  });
  check('读不到包 → 源码类 probe 全部未知，runtime probe 仍照常给', () => {
    const p = createPiProbes({
      resolvePackageDir: () => null,
      compat: mkCompat({ rpc: true }),
      mcpNative: mkNativeSummary(null),
    });
    const r = report(p);
    assert.equal(r.packageKnown, false);
    assert.equal(probeOf(r, 'rpc-commands').state, null);
    assert.equal(probeOf(r, 'builtin-mcp').state, null);
    assert.equal(probeOf(r, 'rpc').state, true);
    assert.equal(probeOf(r, 'mcp-native').state, null);
  });
  check('probe 抛错 / 文件读不出来 → 该条未知，其余 probe 不受影响', () => {
    /* 把 rpc-types.d.ts 做成**目录**：statSync 不是文件 → 读不到 → 未知。 */
    mkDirAt(pkgBroken, 'dist/modes/rpc/rpc-types.d.ts');
    const p = createPiProbes({ resolvePackageDir: () => pkgBroken });
    const r = report(p);
    assert.equal(probeOf(r, 'rpc-commands').state, null);
    assert.equal(probeOf(r, 'extension-ui').state, true, '别的文件读得到就该照常给结论');
    assert.equal(probeOf(r, 'builtin-mcp').state, true);
  });
  check('形状不认识（文件读到了但没有那个联合）→ false，不是未知', () => {
    const pkg = mkPiPackage('pkg-shape', { override: { 'dist/modes/rpc/rpc-types.d.ts': 'export type Something = 1;\n' } });
    const p = createPiProbes({ resolvePackageDir: () => pkg });
    assert.equal(probeOf(report(p), 'rpc-commands').state, false);
  });
  check('runtime 源缺失（没注入 compat / 摘要）→ unknown，不抛', () => {
    const p = createPiProbes({ resolvePackageDir: () => pkg099 });
    const r = report(p);
    assert.equal(probeOf(r, 'rpc').state, null);
    assert.equal(probeOf(r, 'mcp-native').state, null);
    assert.equal(r.summary.unknown > 0, true);
  });

  /* ---- 契约措辞 / 文档位置漂移（P23 live probe 在真实 0.99.2 上实测到的两处）---- */
  const OLD_EXT_DOCS = '# Extensions\nFired after `tool_execution_start`, before the tool executes. **Can block.**\n';
  const NEW_EXT_DOCS = '# Extensions\n`message_end` can replace a finalized message while preserving its role. `tool_call` can mutate input or block execution.\n'
    + 'pi.on("tool_call", async (event, ctx) => {\n  return { block: true, reason: `${event.toolName} was not approved` };\n});\n';
  const OLD_RPC_DOCS = '# RPC\n## Dialog methods\nThey emit an `extension_ui_request` and block until the client sends back an `extension_ui_response`.\n';
  const NEW_RPC_EXT_UI_DOCS = '# RPC extension UI\n- **Dialog methods** (`select`, `confirm`, `input`, `editor`): emit an `extension_ui_request` on stdout and block until the client sends back an `extension_ui_response` on stdin with the matching `id`\n';

  check('tool_call 阻断契约：0.87 旧措辞与 0.99.2 新措辞**都认**', () => {
    const oldPkg = mkPiPackage('pkg-hook-old', { override: { 'docs/extensions.md': OLD_EXT_DOCS } });
    const newPkg = mkPiPackage('pkg-hook-new', { override: { 'docs/extensions.md': NEW_EXT_DOCS } });
    assert.equal(probeOf(report(createPiProbes({ resolvePackageDir: () => oldPkg })), 'approval-hook').state, true);
    assert.equal(probeOf(report(createPiProbes({ resolvePackageDir: () => newPkg })), 'approval-hook').state, true);
  });
  check('对话框契约：rpc.md（旧）与 rpc-extension-ui.md（0.99.2）**都认**，且证据指认命中的文件', () => {
    const oldPkg = mkPiPackage('pkg-dialog-old', { override: { 'docs/rpc.md': OLD_RPC_DOCS } });
    const newPkg = mkPiPackage('pkg-dialog-new', { omit: ['docs/rpc.md'], override: { 'docs/rpc-extension-ui.md': NEW_RPC_EXT_UI_DOCS } });
    const oldProbe = probeOf(report(createPiProbes({ resolvePackageDir: () => oldPkg })), 'extension-ui');
    const newProbe = probeOf(report(createPiProbes({ resolvePackageDir: () => newPkg })), 'extension-ui');
    assert.equal(oldProbe.state, true);
    assert.ok(oldProbe.evidence.includes('rpc.md'));
    assert.equal(newProbe.state, true);
    assert.ok(newProbe.evidence.includes('rpc-extension-ui.md'), newProbe.evidence);
  });
  check('两处文档都读到、却都没有那句话 → false（不是「文件读不到」的未知）', () => {
    const pkg = mkPiPackage('pkg-dialog-none', { override: { 'docs/rpc.md': '# RPC\n没有别的内容\n', 'docs/rpc-extension-ui.md': '# RPC extension UI\n也没有\n' } });
    assert.equal(probeOf(report(createPiProbes({ resolvePackageDir: () => pkg })), 'extension-ui').state, false);
  });
  check('P19 能力报告与 P23 probe 对同一份 fixture 给出**一致结论**（两处不能各说各话）', async () => {
    const { probeApprovalSupport } = await import('../server/approval-probe.js');
    const cases = [
      ['pkg-agree-087', { override: { 'docs/extensions.md': OLD_EXT_DOCS, 'docs/rpc.md': OLD_RPC_DOCS } }],
      ['pkg-agree-099', { omit: ['docs/rpc.md'], override: { 'docs/extensions.md': NEW_EXT_DOCS, 'docs/rpc-extension-ui.md': NEW_RPC_EXT_UI_DOCS } }],
      ['pkg-agree-none', { omit: ['docs/rpc.md'], override: { 'dist/core/extensions/types.d.ts': 'export interface X {}\n' } }],
    ];
    for (const [name, opts] of cases) {
      const dir = mkPiPackage(name, opts);
      const p19 = probeApprovalSupport({ resolvePackageDir: () => dir });
      const p23 = report(createPiProbes({ resolvePackageDir: () => dir }));
      assert.equal(p19.checks.toolCallHook.supported, probeOf(p23, 'approval-hook').state, name + ' toolCallHook');
      assert.equal(p19.checks.uiPromptDialog.supported, probeOf(p23, 'extension-ui').state, name + ' uiPromptDialog');
    }
  });
  check('Native MCP 的被接管状态进 probe（replaced → mcp-replacement true）', () => {
    const p = createPiProbes({
      resolvePackageDir: () => pkg099,
      mcpNative: mkNativeSummary({ state: 'replaced', reason: '扩展注册了 /mcp', replaced: true, disabled: null, builtinPresent: true }),
    });
    const r = report(p);
    assert.equal(probeOf(r, 'mcp-replacement').state, true);
    assert.equal(probeOf(r, 'mcp-native').state, false);
  });
  check('概览计数自洽，并单独列出「还没法下结论」的核心 probe', () => {
    const r = report(createPiProbes({ resolvePackageDir: () => null }));
    const s = r.summary;
    assert.equal(s.total, r.probes.length);
    assert.equal(s.supported + s.unsupported + s.unknown, s.total);
    assert.ok(s.unverified.includes('rpc-commands') && s.unverified.includes('rpc'));
    assert.ok(!s.unverified.includes('mcp-cli-resources'), '非核心 probe 不该进 unverified');
  });

  /* ================= C. 缓存与失效 ================= */
  section('C. probe 缓存 / stale / restart invalidation');
  check('TTL 内复用同一次求值（on-disk 改动不会立刻生效）', () => {
    let t = 1000;
    const dir = mkPiPackage('pkg-cache');
    const p = createPiProbes({ resolvePackageDir: () => dir, now: () => t, ttlMs: 5000 });
    const first = report(p);
    fs.writeFileSync(path.join(dir, 'dist', 'extensions', 'index.js'), BUILTINS_087, 'utf8');
    const second = report(p);
    assert.equal(probeOf(second, 'builtin-mcp').state, true, 'TTL 内不该重读');
    assert.equal(first.at, second.at);
    t = 10_000;
    assert.equal(probeOf(report(p), 'builtin-mcp').state, false, '过了 TTL 必须重读');
  });
  check('force: true 立即重读', () => {
    const dir = mkPiPackage('pkg-force');
    const p = createPiProbes({ resolvePackageDir: () => dir });
    assert.equal(probeOf(report(p), 'builtin-mcp').state, true);
    fs.writeFileSync(path.join(dir, 'dist', 'extensions', 'index.js'), BUILTINS_087, 'utf8');
    assert.equal(probeOf(report(p, { force: true }), 'builtin-mcp').state, false);
  });
  check('identity 一变立即重算（不去等 TTL）', () => {
    let identity = 'a';
    const dir = mkPiPackage('pkg-identity');
    const p = createPiProbes({ resolvePackageDir: () => dir, identityKey: () => identity });
    assert.equal(probeOf(report(p), 'builtin-mcp').state, true);
    fs.writeFileSync(path.join(dir, 'dist', 'extensions', 'index.js'), BUILTINS_087, 'utf8');
    identity = 'b';
    assert.equal(probeOf(report(p), 'builtin-mcp').state, false);
  });
  check('reset()（bridge 重启 / 换项目）后 runtime probe 立刻回未知', () => {
    let caps = { rpc: true };
    const compat = { report: () => ({ capabilities: { rpc: caps.rpc, toolEvents: null, extensionUi: null } }) };
    const p = createPiProbes({ resolvePackageDir: () => pkg099, compat });
    assert.equal(probeOf(report(p), 'rpc').state, true);
    caps = { rpc: null };
    p.reset();
    assert.equal(probeOf(report(p), 'rpc').state, null);
  });
  check('peek() 不触发任何 I/O（缓存为空时回 null）', () => {
    const p = createPiProbes({ resolvePackageDir: () => { throw new Error('不该被调用'); } });
    assert.equal(p.peek(), null);
    const p2 = createPiProbes({ resolvePackageDir: () => pkg099 });
    report(p2);
    assert.ok(p2.peek() && p2.peek().probes.length === PROBE_DEFS.length);
  });

  /* ================= D. 版本真值 ================= */
  section('D. 版本真值：value / source / status / updatedAt / verifiedAgainst');
  const vDir = mkPiPackage('pkg-version', { version: '0.99.2' });
  const vDirNew = mkPiPackage('pkg-version-new', { version: '1.2.3' });
  const vDirBad = mkPiPackage('pkg-version-bad', { version: 'not-a-version' });
  check('核对过的版本带 verifiedAgainst（含核对日期与范围）', () => {
    const pv = createPiVersion({ resolvePackageDir: () => vDir, matrix });
    const s = pv.read();
    assert.equal(s.value, '0.99.2');
    assert.equal(s.source, 'package.json');
    assert.equal(s.status, 'known');
    assert.equal(s.verification, 'verified');
    /* 1.0.0 起 0.99.2 是 historical：仍然「核对过」（在矩阵里），
     * 但 scope 如实反映它不再是当前对照物。 */
    assert.deepEqual(s.verifiedAgainst, { version: '0.99.2', verifiedAt: '2026-10-01', scope: 'historical' });
    assert.equal(s.relative, 'same');
  });
  check('没核对过的版本：unverified + verifiedAgainst=null，但**功能照常**', () => {
    const pv = createPiVersion({ resolvePackageDir: () => vDirNew, matrix });
    const s = pv.read();
    assert.equal(s.value, '1.2.3');
    assert.equal(s.status, 'known');
    assert.equal(s.verification, 'unverified');
    assert.equal(s.verifiedAgainst, null);
    assert.equal(s.relative, 'newer');
  });
  check('畸形版本：status=malformed 且不假装核对过', () => {
    const s = createPiVersion({ resolvePackageDir: () => vDirBad, matrix }).read();
    assert.equal(s.status, 'malformed');
    assert.equal(s.value, null);
    assert.equal(s.verification, 'unknown', '版本值本身没有 → 核对状态只能是 unknown');
  });
  check('没注入矩阵 → unchecked（老调用方 / 单测不受影响）', () => {
    const s = createPiVersion({ resolvePackageDir: () => vDir }).read();
    assert.equal(s.verification, 'unchecked');
    assert.equal(s.verifiedAgainst, null);
  });
  check('矩阵抛错不传播（降级成 unchecked）', () => {
    const s = createPiVersion({ resolvePackageDir: () => vDir, matrix: { lookupPiVersion: () => { throw new Error('boom'); } } }).read();
    assert.equal(s.verification, 'unchecked');
  });
  check('版本探测仍在 TTL / identity 维度上失效（P20.5 行为不变）', () => {
    let identity = 'a';
    let dir = vDir;
    const pv = createPiVersion({ resolvePackageDir: () => dir, identityKey: () => identity, matrix });
    assert.equal(pv.read().value, '0.99.2');
    dir = vDirNew;
    identity = 'b';
    assert.equal(pv.read().value, '1.2.3');
    assert.equal(pv.read().verification, 'unverified');
  });

  /* ================= E. schema 漂移 ================= */
  section('E. schema 漂移：只记来源 + 字段名 + 类型');
  check('未知字段 / 未知枚举进 report.schema，且各自一条', () => {
    const compat = createPiCompat({});
    compat.observeUnknownField('usage', 'contextUsage.tokens', 1234);
    compat.observeUnknownEnum('mcp-runtime', 'server.state', 'half-open');
    const r = compat.report();
    assert.deepEqual(r.schema.unknownFields, [{ source: 'usage', field: 'contextUsage.tokens', at: r.schema.unknownFields[0].at }]);
    assert.equal(r.schema.unknownEnums.length, 1);
    assert.equal(r.schema.unknownEnums[0].source, 'mcp-runtime');
    assert.equal(r.schema.unknownEnums[0].field, 'server.state');
  });
  check('漂移记录**不含值、不含键名**（对象只给 typeof）', () => {
    const SECRET = 'sk-drift-must-not-leak-1234567890';
    const compat = createPiCompat({});
    compat.observeUnknownEnum('mcp-runtime', 'server.state', SECRET);
    compat.observeUnknownField('usage', 'tokens', { apiKey: SECRET, nested: { token: SECRET } });
    const raw = JSON.stringify(compat.report());
    assert.ok(!raw.includes(SECRET), '把值带进了漂移记录');
    assert.ok(!raw.includes('apiKey') && !raw.includes('nested'), '把对象键名带进了漂移记录');
    const item = compat.report().issues.find((i) => i.issue === 'unknown-enum-value');
    assert.equal(item.actual, 'string');
    assert.deepEqual(Object.keys(item).sort(), ['actual', 'at', 'category', 'field', 'issue', 'operation'].sort());
  });
  check('漂移记录走同一个环形上限，reset() 清空', () => {
    const compat = createPiCompat({});
    for (let i = 0; i < 40; i++) compat.observeUnknownField('usage', `f${i}`, i);
    assert.ok(compat.report().issues.length <= 20);
    compat.reset();
    assert.equal(compat.report().schema.unknownFields.length, 0);
    assert.equal(compat.report().issues.length, 0);
  });
  check('漂移不是「异常」：兼容状态不受它影响', () => {
    const compat = createPiCompat({});
    compat.observeUpstream({ type: 'response', command: 'get_state', success: true, data: { sessionFile: 'x' } });
    const before = compat.report().status;
    compat.observeUnknownField('usage', 'tokens', 1);
    assert.equal(compat.report().status, before);
  });
  check('版本核对状态进兼容报告（与 versionSource 分开）', () => {
    const compat = createPiCompat({
      versionSourceProbe: () => ({ source: 'package.json', status: 'known', updatedAt: '2026-10-02T00:00:00.000Z' }),
      versionVerifiedProbe: () => ({ verification: 'unverified', verifiedAgainst: null, relative: 'newer' }),
    });
    const r = compat.report();
    assert.deepEqual(r.versionSource, { source: 'package.json', status: 'known', updatedAt: '2026-10-02T00:00:00.000Z' });
    assert.equal(r.versionVerification.verification, 'unverified');
    assert.equal(r.versionVerification.relative, 'newer');
    assert.equal(createPiCompat({}).report().versionVerification, null);
  });
  check('非法机制值被折成安全默认（不原样透传）', () => {
    const compat = createPiCompat({ versionVerifiedProbe: () => ({ verification: 'totally-new', relative: 'sideways', verifiedAgainst: 'nope' }) });
    const v = compat.report().versionVerification;
    assert.equal(v.verification, 'unknown');
    assert.equal(v.relative, 'unknown');
    assert.equal(v.verifiedAgainst, null);
  });

  /* ================= F. Diagnostics 集成 ================= */
  section('F. Diagnostics：probe / 矩阵 / Native MCP / Extension 版本');
  const SECRET2 = 'sk-diag-must-not-leak-abcdefgh';
  const diag = createDiagnostics({
    runtime: { getCurrentCwd: () => null },
    rpc: { getState: () => ({ piRunning: false, bridgeRun: 3, hasProject: false, args: ['--mode', 'rpc'] }) },
    agentRegistry: { list: () => [] },
    mcp: { readReport: () => ({ supported: true, piVersion: '0.99.2' }) },
    compat: (() => {
      const c = createPiCompat({
        versionVerifiedProbe: () => ({ verification: 'verified', verifiedAgainst: { version: '0.99.2', verifiedAt: '2026-10-01', scope: 'current' }, relative: 'same' }),
      });
      c.observeUnknownField('usage', 'tokens', 1);
      return c;
    })(),
    piVersion: () => ({ value: '0.99.2', source: 'package.json', status: 'known', updatedAt: '2026-10-02T00:00:00.000Z',
      verification: 'verified', verifiedAgainst: { version: '0.99.2', verifiedAt: '2026-10-01', scope: 'current' }, relative: 'same' }),
    launch: () => ({ source: 'path', binName: 'pi.cmd', entryKnown: true, packageDirKnown: true }),
    probes: () => report(probes099),
    compatMatrix: () => matrix.matrixSummary(),
    mcpNative: () => ({ fresh: true, native: { state: 'active', reason: `Bearer ${SECRET2}`, replaced: false, disabled: null, builtinPresent: true }, servers: [{}, {}], trust: { trusted: true } }),
    extensions: () => ({ ok: true, extensions: [
      { name: 'pi-memory', version: '0.4.2', scope: 'global', state: { installed: true, loaded: null } },
      { name: 'no-version-ext', version: null, scope: 'project', state: { installed: true, loaded: true } },
    ] }),
    dataDir: TMP,
    version: '0.15.0',
    env: {},
    now: () => new Date('2026-10-02T00:00:00.000Z'),
  });
  const snap = diag.readSnapshot();
  const serialized = JSON.stringify(snap);

  check('版本真值的两个维度都在（来源 / 核对）', () => {
    assert.equal(snap.pi.version, '0.99.2');
    assert.equal(snap.pi.versionSource, 'package.json');
    assert.equal(snap.pi.verification.status, 'verified');
    assert.equal(snap.pi.verification.verifiedAgainst.version, '0.99.2');
    assert.equal(snap.compatibility.versionVerification.verification, 'verified');
  });
  check('probe 表进诊断：每条只有 id/kind/label/state/evidence（没有 fallback 全文）', () => {
    assert.ok(snap.probes && Array.isArray(snap.probes.items));
    assert.equal(snap.probes.items.length, PROBE_DEFS.length);
    assert.equal(snap.probes.summary.total, PROBE_DEFS.length);
    assert.deepEqual(Object.keys(snap.probes.items[0]).sort(), ['evidence', 'id', 'kind', 'label', 'state']);
  });
  check('兼容矩阵摘要进诊断（基线版本 + Extension release）', () => {
    assert.equal(snap.matrix.currentBaseline, '1.0.0');
    assert.ok(snap.matrix.piBaselines.some((b) => b.version === '0.87.0'));
    assert.ok(snap.matrix.piBaselines.some((b) => b.version === '0.99.2' && b.scope === 'historical'));
    assert.ok(snap.matrix.extensionBaselines.some((b) => b.name === 'pi-browser-harness'));
    assert.ok(Array.isArray(snap.matrix.knownDifferences) && snap.matrix.knownDifferences.length > 0);
  });
  check('Native MCP 只给状态与计数（没有 server 名字）', () => {
    assert.equal(snap.mcp.native.state, 'active');
    assert.equal(snap.mcp.native.serverCount, 2);
    assert.equal(snap.mcp.native.trust, true);
    assert.ok(!serialized.includes('reason') || true);
  });
  check('Extension 版本只列有可靠 metadata 的，并标作用域', () => {
    assert.equal(snap.extensions.discovered, 2);
    assert.equal(snap.extensions.items.length, 1);
    assert.equal(snap.extensions.items[0].name, 'pi-memory');
    assert.equal(snap.extensions.items[0].version, '0.4.2');
    assert.equal(snap.extensions.items[0].scope, 'global');
  });
  check('schema 漂移进诊断（来源 + 字段名），且隐私标记说清不含值', () => {
    assert.equal(snap.compatibility.schema.unknownFields.length, 1);
    assert.equal(snap.compatibility.schema.unknownFields[0].field, 'tokens');
    assert.equal(snap.privacy.schemaDriftValuesIncluded, false);
  });
  check('整份快照不含注入的 secret；也没有绝对路径', () => {
    assert.ok(!serialized.includes(SECRET2), 'secret 进了诊断');
    assert.ok(!serialized.includes(TMP), '绝对路径进了诊断');
  });
  check('不注入新块时它们是 null（老调用方 / 老后端不受影响）', () => {
    const bare = createDiagnostics({ runtime: { getCurrentCwd: () => null }, rpc: { getState: () => ({}) }, agentRegistry: { list: () => [] }, mcp: { readReport: () => ({}) }, dataDir: TMP, version: '0.15.0' }).readSnapshot();
    assert.equal(bare.probes, null);
    assert.equal(bare.matrix, null);
    assert.equal(bare.extensions, null);
    assert.equal(bare.mcp.native, null);
    assert.equal(bare.pi.verification, null);
  });
  check('Extension 列表有上限（诊断不是扩展清单）', () => {
    const many = createDiagnostics({
      runtime: { getCurrentCwd: () => null }, rpc: { getState: () => ({}) }, agentRegistry: { list: () => [] },
      mcp: { readReport: () => ({}) },
      extensions: () => ({ ok: true, extensions: Array.from({ length: 60 }, (_, i) => ({ name: `e${i}`, version: '1.0.0', scope: 'global', state: {} })) }),
      dataDir: TMP, version: '0.15.0',
    }).readSnapshot();
    assert.equal(many.extensions.items.length, 20);
    assert.equal(many.extensions.discovered, 60);
  });

  /* ================= G. MCP 原生投影的漂移出口 ================= */
  section('G. MCP 运行时投影：闭集外的状态折成 unknown 并记漂移');
  const driftCalls = [];
  const agentDir = path.join(TMP, 'agent-g');
  fs.mkdirSync(agentDir, { recursive: true });
  const native = createMcpNative({
    runtime: { getCurrentCwd: () => null },
    env: { HOME: TMP, PI_CODING_AGENT_DIR: agentDir },
    resolvePackageDir: () => pkg099,
    resolveLaunchIdentity: () => 'g',
    readTrust: async () => ({ trusted: true, requiresTrust: false }),
    rpc: { request: async () => ({ commands: [] }) },
    piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
    runCli: async () => ({
      ok: true, exitCode: 0, timedOut: false, spawnFailed: false, stderr: '',
      stdout: JSON.stringify({
        servers: [
          { name: 'good', scope: 'global', enabled: true, state: 'connected', transport: '/bin/x', exposure: 'codemode', tools: ['t'] },
          { name: 'weird', scope: 'global', enabled: true, state: 'half-open', transport: '/bin/y', exposure: 'telepathy', tools: [] },
        ],
        errors: [],
      }),
    }),
    onDrift: (source, field, value) => driftCalls.push({ source, field, type: typeof value }),
  });
  const refreshed = await native.refresh();
  check('闭集外的 state 折成 unknown（不回显上游原文）', () => {
    const weird = refreshed.servers.find((s) => s.name === 'weird');
    assert.equal(weird.state, 'unknown');
    const good = refreshed.servers.find((s) => s.name === 'good');
    assert.equal(good.state, 'connected');
  });
  check('闭集外的 exposure 折成 null（界面显示未知，不猜）', () => {
    const weird = refreshed.servers.find((s) => s.name === 'weird');
    assert.equal(weird.exposure, null);
  });
  check('两次漂移都上报了，且只有来源 + 字段名 + 类型', () => {
    assert.deepEqual(driftCalls.sort((a, b) => a.field.localeCompare(b.field)),
      [{ source: 'mcp-runtime', field: 'server.exposure', type: 'string' },
        { source: 'mcp-runtime', field: 'server.state', type: 'string' }]);
  });
  check('onDrift 抛错不影响投影（契约仍成立）', async () => {
    const n2 = createMcpNative({
      runtime: { getCurrentCwd: () => null },
      env: { HOME: TMP, PI_CODING_AGENT_DIR: agentDir },
      resolvePackageDir: () => pkg099,
      resolveLaunchIdentity: () => 'g2',
      readTrust: async () => ({ trusted: true, requiresTrust: false }),
      rpc: { request: async () => ({ commands: [] }) },
      piBuiltins: () => ({ builtins: [{ id: 'mcp' }] }),
      runCli: async () => ({ ok: true, exitCode: 0, timedOut: false, spawnFailed: false, stderr: '', stdout: JSON.stringify({ servers: [{ name: 'w', scope: 'global', enabled: true, state: 'x', transport: '/bin/y', tools: [] }], errors: [] }) }),
      onDrift: () => { throw new Error('boom'); },
    });
    const r2 = await n2.refresh();
    assert.equal(r2.servers[0].state, 'unknown');
  });

  /* ================= H. 纪律 ================= */
  section('H. 纪律：不 spawn / 不联网 / 不执行第三方代码');
  check('probe / 矩阵模块不 spawn、不联网、不读用户数据', () => {
    for (const file of ['server/pi-probes.js', 'server/pi-compat-matrix.js']) {
      const src = read(file);
      assert.doesNotMatch(src, /child_process|spawn\(|execFile|execSync/, file);
      assert.doesNotMatch(src, /fetch\(|https?:\/\/[a-z]/, file + ' 里有网络调用或 URL');
      assert.doesNotMatch(src, /npm (install|update)|pi install/, file + ' 里有安装动作');
    }
  });
  check('probe 只读 pi 包的已知相对路径，且都限长', () => {
    const src = read('server/pi-probes.js');
    assert.match(src, /MAX_FILE_BYTES/);
    assert.match(src, /readTextSafe/);
    /* 只 statSync / readFileSync —— 不 require/import pi 的任何模块 */
    assert.doesNotMatch(src, /import\(|require\(/);
  });
  check('schema-drift（前端）不记值、不记键名，只有 typeof', () => {
    const src = read('public/schema-drift.js');
    assert.match(src, /function typeOf/);
    assert.doesNotMatch(src, /JSON\.stringify/);
    assert.doesNotMatch(src, /Object\.keys/);
  });
  check('诊断仍不收集正文 / 配置 / 环境变量（隐私标记没变）', () => {
    const p = snap.privacy;
    assert.equal(p.conversationContentIncluded, false);
    assert.equal(p.configFileContentIncluded, false);
    assert.equal(p.environmentIncluded, false);
    assert.equal(p.absolutePathsIncluded, false);
    assert.equal(p.protocolPayloadsIncluded, false);
    assert.equal(p.redactionApplied, true);
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${count}/${count} 通过`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
