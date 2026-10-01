/* P22 Capability 投影层：离线单测。
 *
 * 这一套**全是纯函数**（`public/capability-model.js` 与各 `*-capabilities.js`），
 * 不需要 jsdom、不 spawn、不联网、不碰用户文件。DOM 层的断言在 `smoke.cjs` 的 P22 段，
 * 视觉与布局断言在 `cdp-shot.cjs` 的场景里。
 *
 * 这一套要钉住的纪律（写错任何一条，界面就会开始撒谎）：
 *   1. `null` 只能显示「未知（无法确认）」，**绝不显示成 false**；
 *   2. Native MCP 的原生状态只搬运 P20.6 的结论，不重新判断；
 *   3. built-in / Native MCP **没有** npm 安装命令，也不伪装成普通 Extension；
 *   4. unknown Extension 必须留在表里（不因为我们不认识它就消失）；
 *   5. 运行观察只描述这次 bridge run 真的见过什么，且随 run 重置；
 *   6. 没有任何自动安装动作；
 *   7. `server/extension-registry.js` 保持 generic（没有 package-specific if）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

(async () => {
  const model = await import('../public/capability-model.js');
  const web = await import('../public/web-capabilities.js');
  const subagent = await import('../public/subagent-capabilities.js');
  const memory = await import('../public/memory-capabilities.js');
  const browser = await import('../public/browser-capabilities.js');
  const mcp = await import('../public/mcp-capabilities.js');

  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

  /* ---------------- fixture：照真实接口形状造 ---------------- */
  /* Registry 报告：一个装好并加载的 Web、一个装了但没启用也没加载证据的 Memory、
   * 一个**完全不认识**的第三方 Extension、一个发现阶段就坏掉的 Extension。 */
  const registry = {
    ok: true, hasProject: true, piReachable: true,
    extensions: [
      { id: 'ext-web', name: 'pi-web-access', displayName: 'pi-web-access', version: '1.2.3',
        description: 'web tools', source: { type: 'npm', location: 'C:/agent/npm/node_modules/pi-web-access' },
        scope: 'global', state: { installed: true, enabled: true, loaded: true, restartRequired: null, error: null },
        capabilities: [{ type: 'command', id: 'web' }] },
      { id: 'ext-memory', name: 'pi-memory', displayName: 'pi-memory', version: '0.4.2',
        description: 'memory tools', source: { type: 'npm', location: 'C:/agent/npm/node_modules/pi-memory' },
        scope: 'global', state: { installed: true, enabled: false, loaded: null, restartRequired: null, error: null },
        capabilities: [] },
      { id: 'ext-unknown', name: 'acme-toolkit', displayName: 'acme-toolkit', version: null,
        description: null, source: { type: 'local', location: 'C:/agent/extensions/acme.ts' },
        scope: 'global', state: { installed: true, enabled: null, loaded: null, restartRequired: null, error: null },
        capabilities: [] },
      { id: 'ext-broken', name: 'broken-things', displayName: 'broken-things', version: null,
        description: null, source: { type: 'local', location: 'C:/agent/extensions/broken/index.ts' },
        scope: 'global', state: { installed: true, enabled: null, loaded: false, restartRequired: null,
          error: { extensionId: 'ext-broken', phase: 'load', message: 'Pi 报告扩展执行或加载错误' } },
        capabilities: [] },
    ],
    capabilityRegistry: { commands: [], tools: [], toolRegistryAvailable: false },
    diagnostics: [],
    actions: { install: false, toggle: false, remove: false, refresh: true, restart: true },
  };

  /* P20.5 报告：0.99.2 那一档（带 builtin:mcp）。 */
  const mcpReport = {
    ok: true, supported: true,
    reason: '这个 pi 包自带 built-in 扩展 `mcp`',
    builtins: {
      known: true, source: 'dist/extensions/index.js',
      entries: [
        { id: 'llama.cpp', replaceable: false, hidden: false, evidence: '{ name: "llama.cpp", builtin: true }' },
        { id: 'mcp', replaceable: true, hidden: false, evidence: '{ name: "mcp", replaceable: true, builtin: true }' },
      ],
      note: 'built-in 扩展编译在 pi 包里，不由 Extension Registry 的目录扫描发现。',
    },
  };

  /* P20.6 摘要：原生状态机说 active，两个 server（一个用户级、一个项目级）。 */
  const mcpNative = {
    ok: true, fresh: true,
    native: { state: 'active', replaced: false, disabled: false, builtinPresent: true, reason: 'builtin:mcp 在包里、未被禁用、未被接管' },
    trust: { trusted: true, requiresTrust: true },
    servers: [
      { name: 'filesystem', scope: 'user', enabled: true, exposure: 'direct', transportType: 'stdio',
        hasSecrets: false, overridden: false, effective: { active: true, reason: '' } },
      { name: 'sentry', scope: 'project', enabled: false, exposure: 'codemode', transportType: 'http',
        hasSecrets: false, overridden: true, effective: { active: false, reason: 'overridden' } },
    ],
    configInvalid: [],
    runtime: { at: '2026-10-01T06:00:00.000Z', cached: false, ok: true, servers: [
      { name: 'filesystem', state: 'connected', toolCount: 12, error: '' },
    ] },
  };

  const skillsReport = {
    ok: true, piReachable: true, trust: { trusted: true, requiresTrust: true },
    counts: { total: 3, enabled: 1, project: 1, user: 2 },
    skills: [
      { id: 's1', name: 'code-review', loaded: true, state: 'enabled' },
      { id: 's2', name: 'pdf-tools', loaded: false, state: 'disabled' },
      { id: 's3', name: 'proj-only', loaded: false, state: 'untrusted' },
    ],
  };

  const approvalReport = {
    ok: true, piVersion: '0.99.2',
    checks: {
      toolCallHook: { supported: true, evidence: 'types.d.ts' },
      uiPromptDialog: { supported: true, evidence: 'rpc.md' },
      coreApproval: { supported: false, evidence: 'usage.md' },
      customUiOverRpc: { supported: false, evidence: 'rpc-mode.js' },
    },
  };

  const catalog = () => model.buildCapabilityCatalog({
    registry, mcp: mcpReport, mcpNative, skills: skillsReport,
    features: [
      web.webCapability(registry, { any: true, count: 1, names: ['web_search'] }),
      subagent.subagentCapability(registry, { any: false, count: 0, names: [] }),
      memory.memoryCapability(registry, { any: false, count: 0, names: [] }),
      browser.browserCapability(registry, { any: false, count: 0, names: [] }),
      mcp.mcpCapability(mcpReport, mcpNative, { any: true, count: 1, names: ['mcp__filesystem'] }),
      { id: 'approval', kind: 'capability', name: 'Approval', purpose: 'p', origin: 'pi',
        installCommand: null, installNote: '', state: { installed: model.NA, loaded: true }, notes: [], limits: [] },
      model.usageEntry(),
    ],
  });
  const rowById = (report, id) => report.rows.find((row) => row.id === id);

  /* ---------------- 1. 统一状态投影 ---------------- */
  console.log('\n--- 1. 统一状态投影 ---');
  check('三值 + 第四值「不适用」各有唯一文案', () => {
    assert.equal(model.triText(true, '是', '否'), '是');
    assert.equal(model.triText(false, '是', '否'), '否');
    assert.equal(model.triText(null, '是', '否'), model.TRI_UNKNOWN);
    assert.equal(model.triText(undefined, '是', '否'), model.TRI_UNKNOWN);
    assert.equal(model.triText(model.NA, '是', '否'), '不适用');
  });
  check('状态机：未安装 / 已安装未加载 / 已加载 / 加载未知', () => {
    assert.equal(model.statusOf({ installed: false }).key, 'absent');
    assert.equal(model.statusOf({ installed: true, loaded: false }).key, 'not-loaded');
    assert.equal(model.statusOf({ installed: true, loaded: true }).key, 'loaded');
    assert.equal(model.statusOf({ installed: true, loaded: null }).key, 'load-unknown');
    assert.equal(model.statusOf({ installed: null }).key, 'unknown');
  });
  check('结论行里 null 只有「未知（无法确认）」，没有「否」', () => {
    const label = model.statusOf({ installed: null, loaded: null }).label;
    assert.ok(label.includes('未知'));
    assert.ok(!label.includes('未安装'));
    assert.ok(!label.includes('未加载'));
  });
  check('统一的六个状态行顺序与名字固定', () => {
    const view = model.setupViewModel(model.normalizeRow({ id: 'x', name: 'X', state: {} }));
    assert.deepEqual(view.stateRows.map(([k]) => k),
      ['安装状态', '启用配置', '已加载', '运行观察', '需要重启', '诊断']);
  });

  /* ---------------- 2. null / false 不互相冒充 ---------------- */
  console.log('\n--- 2. null 与 false 不互相冒充 ---');
  check('发现失败 → 三值全是未知，不是 false', () => {
    const failed = model.registryEvidence({ ok: false }, 'pi-web-access');
    assert.equal(failed.installed, null);
    assert.equal(failed.configured, null);
    assert.equal(failed.loaded, null);
    assert.equal(web.webSetup({ ok: false }).installed, null);
    assert.equal(memory.memorySetup({ ok: false }).installed, null);
    assert.equal(browser.browserSetup({ ok: false }).installed, null);
    assert.equal(subagent.subagentSetup({ ok: false }).installed, null);
  });
  check('空 registry（没有诊断）才敢说「未安装」', () => {
    assert.equal(web.webSetup({ ok: true, extensions: [], diagnostics: [] }).installed, false);
    assert.equal(web.webSetup({ ok: true, extensions: [], diagnostics: [{ code: 'x' }] }).installed, null);
  });
  check('「存在」推不出「已启用」，也推不出「已加载」', () => {
    const setup = web.webSetup({ ok: true, extensions: [
      { name: 'pi-web-access', state: { installed: true, enabled: null, loaded: null } }] });
    assert.equal(setup.discovered, true);
    assert.equal(setup.configured, null);
    assert.equal(setup.loaded, null);
  });
  check('运行观察为 null 时显示「未知」，不是「尚未观察到」', () => {
    assert.equal(model.observationText(null), model.TRI_UNKNOWN);
    assert.equal(model.observationText(undefined), model.TRI_UNKNOWN);
    assert.equal(model.observationText({ any: false, count: 0, names: [] }), '本次 Pi 运行尚未观察到调用');
    assert.equal(model.observationText(model.NA), '不适用（不是工具型能力）');
  });

  /* ---------------- 3. built-in / Native MCP ---------------- */
  console.log('\n--- 3. built-in 与 Native MCP ---');
  check('native MCP 不显示 npm 安装命令，且说明来自 Pi 内置能力', () => {
    const cap = mcp.mcpCapability(mcpReport, mcpNative, null);
    assert.equal(cap.installCommand, null);
    assert.ok(cap.installNote.includes('没有安装命令'));
    assert.ok(cap.installNote.includes('built-in'));
    assert.equal(model.setupViewModel(model.normalizeRow(cap)).installCommand, null);
  });
  check('原生状态原样搬运 P20.6 的词汇，不重新判断', () => {
    for (const [state, key] of [['active', 'loaded'], ['replaced', 'replaced'],
      ['disabled', 'disabled'], ['unsupported', 'unsupported'], ['unknown', 'unknown']]) {
      const cap = mcp.mcpCapability(mcpReport, { fresh: true, native: { state }, servers: [] }, null);
      assert.equal(cap.state.nativeState, state);
      assert.equal(model.statusOf(cap.state).key, key);
    }
  });
  check('replaced / disabled 的结论优先于「装没装」', () => {
    const replaced = model.statusOf({ installed: true, loaded: true, nativeState: 'replaced' });
    assert.equal(replaced.key, 'replaced');
    assert.ok(replaced.label.includes('接管'));
    const disabled = model.statusOf({ installed: true, loaded: false, nativeState: 'disabled' });
    assert.equal(disabled.key, 'disabled');
  });
  check('built-in 行带前缀、有 origin、没有安装命令', () => {
    const row = rowById(catalog(), 'builtin:mcp');
    assert.ok(row);
    assert.equal(row.origin, 'builtin');
    assert.equal(row.kind, 'builtin');
    assert.equal(row.installCommand, null);
    assert.ok(row.installNote.includes('不由 Extension Registry'));
    assert.ok(row.notes.join(' ').includes('不等于'));
  });
  check('built-in 不在 filesystem Extension 发现里（id 前缀不同）', () => {
    const report = catalog();
    assert.ok(report.rows.filter((row) => row.kind === 'extension').every((row) => row.id.startsWith('extension:')));
    assert.ok(report.rows.filter((row) => row.kind === 'builtin').every((row) => row.id.startsWith('builtin:')));
  });
  check('built-in 的「启用 / 加载」是不适用，不是「否」', () => {
    const row = rowById(catalog(), 'builtin:mcp');
    const view = model.setupViewModel(row);
    const value = (name) => view.stateRows.find(([k]) => k === name)[1];
    assert.equal(value('启用配置'), '不适用');
    assert.equal(value('已加载'), '不适用');
  });
  check('读不到 built-in 清单时给诊断，不硬编码结论', () => {
    const report = model.buildCapabilityCatalog({ mcp: { builtins: { known: false } }, features: [] });
    assert.ok(report.diagnostics.some((d) => d.message.includes('built-in')));
    assert.equal(report.rows.filter((row) => row.kind === 'builtin').length, 0);
  });
  check('MCP server 行不把「生效」冒充成「已安装」', () => {
    const row = rowById(catalog(), 'mcp:user:filesystem');
    assert.ok(row);
    assert.equal(row.state.installed, model.NA);
    assert.equal(row.status.label, '生效中');
    const overridden = rowById(catalog(), 'mcp:project:sentry');
    assert.equal(overridden.status.key, 'not-loaded');
    assert.ok(overridden.status.label.includes('overridden'));
  });
  check('MCP server 的运行状态不混进「运行观察」那一格', () => {
    const row = rowById(catalog(), 'mcp:user:filesystem');
    assert.equal(model.setupViewModel(row).stateRows.find(([k]) => k === '运行观察')[1], model.TRI_UNKNOWN);
    assert.ok(row.notes.join(' ').includes('connected'));
  });

  /* ---------------- 4. feature setup ---------------- */
  console.log('\n--- 4. feature setup 统一布局 ---');
  const features = () => [
    web.webCapability(registry, null),
    subagent.subagentCapability(registry, null),
    memory.memoryCapability(registry, null),
    browser.browserCapability(registry, null),
  ];
  check('四个第三方 feature 各有一条固定官方安装命令', () => {
    const commands = features().map((f) => f.installCommand);
    assert.deepEqual(commands, [
      'pi install npm:pi-web-access',
      'pi install npm:pi-subagents',
      'pi install npm:pi-memory',
      'pi install npm:pi-browser-harness',
    ]);
  });
  check('每条 descriptor 都有名称 / 用途 / 出处 / 重启文案', () => {
    for (const feature of features()) {
      assert.ok(feature.name && feature.purpose, feature.id);
      assert.ok(feature.source, feature.id);
      assert.ok(feature.restart && feature.restart.message, feature.id);
      assert.equal(feature.origin, 'extension', feature.id);
    }
  });
  check('setup 视图模型含安装状态 / 命令 / 复制 / 重启 / 观察 / 限制', () => {
    const view = model.setupViewModel(model.normalizeRow(web.webCapability(registry, null)));
    assert.equal(view.installCommand, 'pi install npm:pi-web-access');
    assert.equal(view.copyLabel, '复制安装命令');
    assert.ok(view.restart);
    assert.ok(view.limits.length > 0);
    assert.equal(view.stateRows.find(([k]) => k === '运行观察')[1], model.TRI_UNKNOWN);
  });
  check('第三方 feature 的六个状态都来自 Registry 的四值', () => {
    const setup = web.webSetup(registry);
    assert.equal(setup.installed, true);
    assert.equal(setup.configured, true);
    assert.equal(setup.loaded, true);
    assert.equal(setup.restartRequired, null);
    assert.equal(setup.diagnostic, null);
    assert.equal(setup.automaticInstall, false);
  });
  check('功能级「加载未知」与「已加载」分得开', () => {
    const unknown = subagent.subagentSetup(registry);
    assert.equal(unknown.installed, false);
    assert.equal(unknown.loaded, null);
    assert.equal(model.statusOf(unknown).key, 'absent');
    assert.equal(model.statusOf({ installed: true, loaded: null }).key, 'load-unknown');
  });

  /* ---------------- 5. unknown extension ---------------- */
  console.log('\n--- 5. unknown Extension 不丢 ---');
  check('不认识的 Extension 仍在表里，状态是未知', () => {
    const row = rowById(catalog(), 'extension:ext-unknown');
    assert.ok(row);
    assert.equal(row.name, 'acme-toolkit');
    assert.equal(row.state.installed, true);
    assert.equal(row.state.configured, null);
    assert.equal(row.state.loaded, null);
    assert.equal(row.status.key, 'load-unknown');
  });
  check('坏掉的 Extension 带诊断，且只影响它自己', () => {
    const report = catalog();
    const broken = rowById(report, 'extension:ext-broken');
    assert.equal(broken.state.loaded, false);
    assert.equal(broken.status.key, 'not-loaded');
    assert.ok(broken.state.diagnostic.message.includes('错误'));
    assert.equal(rowById(report, 'extension:ext-unknown').state.diagnostic, null);
  });
  check('没有简介的 Extension 也照常显示', () => {
    const row = rowById(catalog(), 'extension:ext-unknown');
    assert.ok(row.purpose.length > 0);
  });
  check('发现接口失败时留下诊断，聊天不受影响', () => {
    const report = model.buildCapabilityCatalog({ registry: { ok: false }, features: [] });
    assert.ok(report.diagnostics.some((d) => d.message.includes('Extension 发现不可用')));
  });

  /* ---------------- 6. 搜索 / 过滤 ---------------- */
  console.log('\n--- 6. 搜索与过滤 ---');
  check('五个过滤器与需求里点名的一致，All 在最前', () => {
    assert.deepEqual(model.FILTERS.map((f) => f.label), ['All', 'Capabilities', 'Extensions', 'Skills', 'MCP']);
    assert.equal(model.FILTERS[0].id, 'all');
  });
  check('Capabilities 过滤只留已知能力', () => {
    const rows = model.filterRows(catalog().rows, 'capabilities');
    assert.ok(rows.some((row) => row.id === 'web'));
    assert.ok(rows.some((row) => row.id === 'mcp'));
    assert.ok(rows.some((row) => row.id === 'usage'));
    assert.ok(!rows.some((row) => row.kind === 'extension'));
  });
  check('Extensions 过滤含 registry 行与 built-in 行', () => {
    const rows = model.filterRows(catalog().rows, 'extensions');
    assert.ok(rows.some((row) => row.id === 'extension:ext-unknown'));
    assert.ok(rows.some((row) => row.id === 'builtin:mcp'));
    assert.ok(!rows.some((row) => row.id === 'web'));
  });
  check('Skills / MCP 过滤各归其位', () => {
    assert.ok(model.filterRows(catalog().rows, 'skills').some((row) => row.id === 'skills'));
    const mcpRows = model.filterRows(catalog().rows, 'mcp');
    assert.ok(mcpRows.some((row) => row.id === 'mcp'));
    assert.ok(mcpRows.some((row) => row.kind === 'server'));
    assert.ok(!mcpRows.some((row) => row.id === 'web'));
  });
  check('搜索覆盖名称 / 用途 / 状态', () => {
    const rows = catalog().rows;
    assert.deepEqual(model.filterRows(rows, 'all', 'web access').map((r) => r.id), ['web']);
    assert.ok(model.filterRows(rows, 'all', '长期记忆').some((r) => r.id === 'memory'));
    assert.ok(model.filterRows(rows, 'all', 'acme').some((r) => r.id === 'extension:ext-unknown'));
    assert.ok(model.filterRows(rows, 'all', '已加载').length > 0);
  });
  check('搜索与过滤器叠加，且空结果不是错误', () => {
    assert.equal(model.filterRows(catalog().rows, 'extensions', 'web access').length, 0);
    assert.equal(model.filterRows(catalog().rows, 'all', 'zzz-nothing').length, 0);
    assert.equal(model.filterRows([], 'all', '').length, 0);
  });
  check('未知的过滤器 id 退回 All，不抛错', () => {
    assert.equal(model.filterRows(catalog().rows, 'nope', '').length, catalog().rows.length);
  });
  check('概览计数与结论行一致', () => {
    const rows = catalog().rows;
    const counts = model.catalogCounts(rows);
    assert.equal(counts.total, rows.length);
    assert.equal(counts.available + counts.unavailable + counts.unknown, counts.total);
  });

  /* ---------------- 7. 运行观察随 run 重置 ---------------- */
  console.log('\n--- 7. 运行观察与重置 ---');
  check('观察快照 → 统一形状', () => {
    assert.deepEqual(model.observationFromMap({ b: true, a: true, c: false }), { any: true, count: 2, names: ['a', 'b'] });
    assert.deepEqual(model.observationFromMap({}), { any: false, count: 0, names: [] });
    assert.deepEqual(model.observationFromMap(null), { any: false, count: 0, names: [] });
  });
  check('web 观察在 bridge 重启后清空', () => {
    const observation = web.createWebObservation();
    observation.observe({ type: 'tool_execution_start', bridgeRun: 1, toolName: 'web_search' }, 0, 1);
    assert.equal(web.webObservationState(observation, 0, 1).any, true);
    observation.observe({ type: 'bridge_status', state: 'restarting', bridgeRun: 1 }, 0, 1);
    assert.equal(web.webObservationState(observation, 0, 1).any, false);
  });
  check('换 workspace generation 也不沿用旧观察', () => {
    const observation = memory.createMemoryObservation();
    observation.observe({ type: 'tool_execution_start', bridgeRun: 2, toolName: 'memory_search' }, 0, 2);
    assert.equal(memory.memoryObservationState(observation, 0, 2).any, true);
    assert.equal(memory.memoryObservationState(observation, 1, 2).any, false);
  });
  check('观察文案列出真的见过的工具，并给出总数', () => {
    const cap = browser.browserCapability(registry, { any: true, count: 2, names: ['browser_navigate', 'browser_fill'] });
    const value = model.setupViewModel(model.normalizeRow(cap)).stateRows.find(([k]) => k === '运行观察')[1];
    assert.ok(value.includes('browser_navigate'));
    assert.ok(value.includes('（共 2 个）'));
  });
  check('观察到调用不构成「已加载」的证据', () => {
    const cap = web.webCapability({ ok: true, extensions: [] }, { any: true, count: 1, names: ['web_search'] });
    const normalized = model.normalizeRow(cap);
    assert.equal(normalized.state.loaded, null);
    assert.equal(normalized.status.key, 'absent');
  });

  /* ---------------- 8. restartRequired ---------------- */
  console.log('\n--- 8. restartRequired ---');
  check('Registry 的 restartRequired 进入统一状态', () => {
    const evidence = model.registryEvidence({ ok: true, extensions: [
      { name: 'pi-web-access', state: { installed: true, enabled: true, loaded: true, restartRequired: true } }] }, 'pi-web-access');
    assert.equal(evidence.restartRequired, true);
    const normalized = model.normalizeRow(web.webCapability({ ok: true, extensions: [
      { name: 'pi-web-access', state: { installed: true, enabled: true, loaded: true, restartRequired: true } }] }, null));
    assert.equal(normalized.status.restartRequired, true);
    assert.ok(normalized.status.label.includes('需重启 Pi'));
    assert.equal(model.setupViewModel(normalized).stateRows.find(([k]) => k === '需要重启')[1], '是');
  });
  check('没有重启证据时保持未知，不写成「否」', () => {
    assert.equal(model.registryEvidence(registry, 'pi-web-access').restartRequired, null);
    assert.equal(model.statusOf({ installed: true, loaded: true, restartRequired: null }).restartRequired, undefined);
  });
  check('配置禁用与已加载证据可以同时存在（改完没重启）', () => {
    const setup = web.webSetup({ ok: true, extensions: [
      { name: 'pi-web-access', state: { installed: true, enabled: false, loaded: true, restartRequired: true } }] });
    assert.equal(setup.configured, false);
    assert.equal(setup.loaded, true);
    const view = model.setupViewModel(model.normalizeRow(web.webCapability({ ok: true, extensions: [
      { name: 'pi-web-access', state: { installed: true, enabled: false, loaded: true, restartRequired: true } }] }, null)));
    const value = (name) => view.stateRows.find(([k]) => k === name)[1];
    assert.equal(value('启用配置'), '已停用');
    assert.equal(value('已加载'), '已确认加载');
    assert.equal(value('需要重启'), '是');
  });

  /* ---------------- 9. stale workspace ---------------- */
  console.log('\n--- 9. stale workspace ---');
  check('投影层是纯函数：同样输入永远同样输出', () => {
    assert.deepEqual(catalog().rows.map((r) => r.id), catalog().rows.map((r) => r.id));
  });
  check('视图落地前同时过实例身份与 workspace generation', () => {
    const view = read('public/capability-view.js');
    assert.match(view, /ownsWorkspace\(generation\)/);
    assert.match(view, /if \(!isCurrent\(\)\) return;/);
    assert.ok(view.indexOf('!isCurrent()') < view.indexOf('catalog = buildCapabilityCatalog'), '身份守卫必须在落地之前');
  });
  check('视图不自己缓存观察（否则换项目会拿到旧 run 的结论）', () => {
    const view = read('public/capability-view.js');
    assert.doesNotMatch(view, /const\s+observed\s*=\s*\{/);
    assert.match(view, /webObservation\(\)/);
    assert.match(view, /snapshotMcpObservation\(\)/);
  });
  check('共享重启流程带 stale 守卫（切项目后不对着新项目重启）', () => {
    const setup = read('public/ui/capability-setup.js');
    assert.match(setup, /ownsWorkspace\(generation\)/);
    assert.match(setup, /await restartBackend\(\)/);
  });
  check('四个 feature 模块不再各自重启（唯一实现）', () => {
    for (const file of ['public/web-access.js', 'public/subagents.js', 'public/memory.js', 'public/browser.js']) {
      assert.doesNotMatch(read(file), /restartBackend/, file);
      assert.match(read(file), /ui\/capability-setup\.js/, file);
    }
  });

  /* ---------------- 10. 没有自动安装 ---------------- */
  console.log('\n--- 10. 没有自动安装 ---');
  check('四个 setup 都声明 automaticInstall=false', () => {
    for (const setup of [web.webSetup(registry), subagent.subagentSetup(registry),
      memory.memorySetup(registry), browser.browserSetup(registry)]) {
      assert.equal(setup.automaticInstall, false);
    }
  });
  check('投影层与视图层都不执行安装（无 spawn / exec / child_process）', () => {
    for (const file of ['public/capability-model.js', 'public/capability-view.js', 'public/ui/capability-setup.js']) {
      assert.doesNotMatch(read(file), /child_process|execFile|\bspawn\(|node:fs/, file);
    }
  });
  check('视图模型只有「复制 / 重启 / 打开」三类动作，没有安装动作', () => {
    const view = model.setupViewModel(model.normalizeRow(web.webCapability(registry, null)));
    assert.equal(typeof view.onInstall, 'undefined');
    assert.equal(view.installCommand.startsWith('pi install'), true);
  });
  check('Native MCP / built-in / Skills 都没有安装命令', () => {
    const report = catalog();
    for (const id of ['mcp', 'builtin:mcp', 'skills', 'usage']) {
      assert.equal(rowById(report, id).installCommand, null, id);
    }
  });

  /* ---------------- 11. Registry 保持 generic ---------------- */
  console.log('\n--- 11. Registry 不被特化 ---');
  check('extension-registry.js 里没有任何 package-specific 分支', () => {
    const source = read('server/extension-registry.js');
    for (const token of ['pi-web-access', 'pi-subagents', 'pi-memory', 'pi-browser-harness',
      'web_search', 'memory_search', 'browser_navigate', 'nativeState', 'capability-model']) {
      assert.ok(!source.includes(token), `${token} 不该出现在 Registry 里`);
    }
  });
  check('共享只读 resolver 同样没有 feature 分支', () => {
    const source = read('lib/extension-paths.js');
    for (const token of ['pi-web-access', 'pi-subagents', 'pi-memory', 'pi-browser-harness', 'nativeState']) {
      assert.ok(!source.includes(token), `${token} 不该出现在 resolver 里`);
    }
  });
  check('capability 层知道推荐包名 —— 那只是 setup metadata', () => {
    for (const file of ['public/web-capabilities.js', 'public/subagent-capabilities.js',
      'public/memory-capabilities.js', 'public/browser-capabilities.js']) {
      assert.match(read(file), /pi-(web-access|subagents|memory|browser-harness)/, file);
    }
    assert.match(read('server/extension-registry.js'), /unknown/);
  });
  check('Registry 的只读动作契约没变', () => {
    assert.deepEqual(registry.actions, { install: false, toggle: false, remove: false, refresh: true, restart: true });
  });

  /* ---------------- 12. 既有 feature 回归 ---------------- */
  console.log('\n--- 12. Web / Subagent / Memory / Browser / MCP / Usage 回归 ---');
  check('Web / Subagent / Memory / Browser 的三值仍与 Registry 一致', () => {
    const unknownRegistry = { ok: true, extensions: [
      { name: 'pi-web-access', state: { installed: true, enabled: null, loaded: null } },
      { name: 'pi-subagents', state: { installed: false, enabled: null, loaded: null } },
      { name: 'pi-memory', state: { installed: true, enabled: false, loaded: null } },
      { name: 'pi-browser-harness', state: { installed: true, enabled: true, loaded: null } },
    ] };
    assert.deepEqual(
      [web.webSetup(unknownRegistry).configured, subagent.subagentSetup(unknownRegistry).installed,
        memory.memorySetup(unknownRegistry).configured, browser.browserSetup(unknownRegistry).configured],
      [null, false, false, true]);
  });
  check('mcpSetup 的三值契约没被投影层改动', () => {
    assert.deepEqual(mcp.mcpSetup(null), { nativeActive: null, configured: null });
    assert.equal(mcp.mcpSetup({ fresh: true, native: { state: 'active' }, servers: [{}] }).nativeActive, true);
    assert.equal(mcp.mcpSetup({ fresh: true, native: { state: 'replaced' }, servers: [] }).nativeActive, false);
  });
  check('Skills 行说清它不是 Extension', () => {
    const row = rowById(catalog(), 'skills');
    assert.equal(row.installCommand, null);
    assert.ok(row.installNote.includes('不是 Extension'));
    assert.ok(row.notes.join(' ').includes('≠'));
  });
  check('pi 没应答时 Skills 行不硬说可用', () => {
    const row = model.normalizeRow(model.skillsCapability({ ok: true, piReachable: false, skills: [] }));
    assert.equal(row.state.installed, null);
    assert.equal(row.status.key, 'not-loaded');
  });
  check('Usage 入口不编造安装状态，且只给一个只读入口', () => {
    const row = model.normalizeRow(model.usageEntry());
    assert.equal(row.state.installed, model.NA);
    assert.equal(row.installCommand, null);
    assert.equal(row.status.label.includes('随会话提供'), true);
    const view = model.setupViewModel(row);
    assert.equal(view.openLabel, '打开上下文与额度');
    assert.equal(view.onOpen, null, 'handler 由视图注入，模型层不碰 DOM');
  });
  check('Approval 行的结论来自 tool_call hook 证据', () => {
    const cap = model.normalizeRow({
      id: 'approval', kind: 'capability', name: 'Approval', origin: 'pi',
      statusOverride: { dot: 'on', key: 'loaded', label: 'Extension 可以在工具执行前阻断' },
      state: { installed: model.NA, loaded: true }, notes: [], limits: [],
    });
    assert.ok(model.setupViewModel(cap).notes.length === 0);
    assert.equal(cap.status.key, 'loaded');
  });
  check('built-in 数量与 P20.5 报告一致（不硬编码 4 个）', () => {
    const report = catalog();
    assert.equal(report.rows.filter((row) => row.kind === 'builtin').length, mcpReport.builtins.entries.length);
  });

  console.log(`\n${passed}/${passed} 通过`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
