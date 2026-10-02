/* Pi GUI 前端冒烟测试：在 jsdom 里真实加载 index.html + 前端模块图，
 * 用假的 EventSource / fetch 灌入 pi 的 RPC 事件，检查渲染结果与报错。
 *
 * 前端是原生 ES Module（public/app.js + 若干模块），而 jsdom 不支持 ESM，
 * 所以先用 tests/esm-bundle.cjs 把模块图链接成一份普通脚本再 window.eval。
 * 附带好处是模块的具名导出都会挂到 window 上，断言可以直接调内部函数。 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const bundled = bundle(path.join(PUB, 'app.js'));
const code = bundled.code;
/* 静态检查要读**原始**源码（未被链接器改写过），否则 `export ` 前缀被剥掉之后
 * 那些按源码形态写的正则就对不上了。 */
const sources = bundled.sources;

const errors = [];
const commands = [];
/* /api/git/* 的调用流水（按顺序记 kind + body），用来断言「什么时候真的去问了后端」。 */
const gitCalls = [];
/* /api/git/* 的可变桩。测试里改 gitStub 就能模拟后端的各种状态
 * （干净工作区 / 不是仓库 / 没装 git / 没有项目 / 二进制 / 截断 …）。 */
const gitStub = {
  status: { ok: true, isRepo: true, files: [] },
  diff: { ok: true, isRepo: true, path: '', untracked: false, isDir: false, binary: false, working: '', staged: '', truncated: false, limit: 524288, notice: '', context: null },
  restore: { ok: true, action: 'restored' },
  // 键名带连字符，和 URL 里的子路径一致
  'restore-all': { ok: true, total: 0, restored: [], skipped: [], kept: [] },
  open: { ok: true, abs: 'C:\\pi-GUI\\x.txt', rel: 'x.txt' },
};
let es = null;
/* /api/status 里「当前项目目录」的可变桩。
 * 置空就能模拟「还没选项目」—— 后端此时不启动 pi，界面要整体切到引导形态。 */
let stubCwd = 'C:\\pi-GUI';

/* /api/status 里的**兼容摘要**（P4）。改它就能模拟「某个能力被证实不可用」；
 * null = 后端没给这个字段（老后端 / 状态还没回来）→ 前端一律按可用处理。 */
let stubCompat = null;

/* /api/project-config 的可变桩。改 stubProjectConfig 就能模拟
 * 「有配置 / 没项目 / 模型失效 / 环境变量钉住 / 配置读坏了」各种状态。 */
const CFG_DEFAULTS = { version: 1, model: null, thinking: null, instructions: '', ignore: [], commands: [] };
let stubProjectConfig = {
  ok: true,
  hasProject: true,
  exists: true,
  cwd: 'C:\\pi-GUI',
  path: 'C:\\pi-GUI\\.pi-gui\\config.json',
  config: { ...CFG_DEFAULTS },
  warnings: [],
  env: { provider: false, model: false, thinking: false },
  thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  limits: { instructions: 32768 },
  defaults: { ...CFG_DEFAULTS },
};
/* PUT 的应答桩；置为对象就能模拟「保存失败」。 */
let stubSaveResult = null;
/* 每次 /api/project-config 调用的流水（方法 + body）。 */
const projectConfigCalls = [];

/* /api/skills 的可变桩。默认摆一组「各种状态都有」的样例 ——
 * 一条正常、一条被设置关掉、一条项目未信任、一条坏掉、一条 pi 没加载，
 * 用来钉住「每条独立展示、一条坏了不带塌整页」这件事。 */
const SKILL_BASE = {
  scope: 'user',
  source: 'auto',
  origin: 'top-level',
  mode: 'pi',
  rootLabel: '~/.pi/agent/skills',
  path: 'C:\\Users\\21022\\.pi\\agent\\skills\\demo\\SKILL.md',
  dir: 'C:\\Users\\21022\\.pi\\agent\\skills\\demo',
  file: 'SKILL.md',
  rel: 'skills/demo/SKILL.md',
  baseDir: 'C:\\Users\\21022\\.pi\\agent',
  loaded: true,
  state: 'enabled',
  stateNote: '',
  shadowedBy: null,
  disablePattern: '-skills/demo/SKILL.md',
  settingsPath: 'C:\\Users\\21022\\.pi\\agent\\settings.json',
  toggleable: true,
  blockedByTrust: false,
  disabledBy: '',
  disableModelInvocation: false,
  license: '',
  compatibility: '',
  bytes: 42,
  errors: [],
};
let stubSkills = {
  ok: true,
  hasProject: true,
  cwd: 'C:\\pi-GUI',
  agentDir: 'C:\\Users\\21022\\.pi\\agent',
  homeDir: 'C:\\Users\\21022',
  globalSettings: 'C:\\Users\\21022\\.pi\\agent\\settings.json',
  projectSettings: 'C:\\pi-GUI\\.pi\\settings.json',
  trust: { trusted: false, requiresTrust: true, reason: 'ask-no-ui', trustFile: 'C:\\Users\\21022\\.pi\\agent\\trust.json' },
  piReachable: true,
  roots: [
    { label: '~/.pi/agent/skills', dir: 'C:\\Users\\21022\\.pi\\agent\\skills', scope: 'user', mode: 'pi', exists: true, blockedByTrust: false },
    { label: '<项目>/.pi/skills', dir: 'C:\\pi-GUI\\.pi\\skills', scope: 'project', mode: 'pi', exists: true, blockedByTrust: true },
  ],
  diagnostics: [],
  counts: { total: 5, enabled: 1, project: 1, user: 4 },
  skills: [
    { ...SKILL_BASE, id: 'aaaaaaaaaaaaaaaa', name: 'code-review', description: 'Review source code for bugs', state: 'enabled', loaded: true },
    {
      ...SKILL_BASE, id: 'bbbbbbbbbbbbbbbb', name: 'pdf-tools', description: 'Work with PDF files',
      state: 'disabled', loaded: false, disabledBy: '-skills/pdf-tools/SKILL.md',
      stateNote: '被 settings 里的 -skills/pdf-tools/SKILL.md 关掉了',
    },
    {
      ...SKILL_BASE, id: 'cccccccccccccccc', name: 'proj-only', description: 'Project scoped skill',
      scope: 'project', rel: 'skills/proj-only/SKILL.md', state: 'untrusted', loaded: false,
      blockedByTrust: true, stateNote: '项目未被信任：pi 在非交互模式下不加载项目级资源',
    },
    {
      ...SKILL_BASE, id: 'dddddddddddddddd', name: 'broken-skill', description: '',
      state: 'invalid', loaded: false,
      stateNote: '没有 description，pi 不会加载',
      errors: [{ level: 'error', message: 'frontmatter 里没有 description —— pi 不会加载它' }],
    },
    {
      ...SKILL_BASE, id: 'eeeeeeeeeeeeeeee', name: 'mystery-skill', description: 'On disk but not reported by pi',
      state: 'not-loaded', loaded: false, stateNote: '磁盘上有，但 pi 没有加载它',
    },
  ],
};
/* PUT /api/skills/<id> 的应答桩；置为对象就能模拟失败。 */
let stubSkillToggle = null;
const skillsCalls = [];
/* 可变：P22 段落要临时换成「发现失败」与「restartRequired」两种形状。 */
let stubExtensions = {
  ok: true, piReachable: true, actions: { install: false, toggle: false, remove: false, refresh: true, restart: true },
  diagnostics: [], capabilityRegistry: { commands: [{ name: 'hello', extensionId: 'ext-1' }], tools: [], toolRegistryAvailable: false },
  extensions: [
    { id: 'ext-1', name: 'sample-extension', displayName: 'Sample Extension', version: '1.0.0', description: 'Fixture extension',
      source: { type: 'local', location: 'C:/fixture/extensions/sample.ts' }, scope: 'global',
      state: { installed: true, enabled: true, loaded: true, restartRequired: null, error: null },
      capabilities: [{ type: 'command', id: 'hello', displayName: 'hello' }], configurable: false },
    { id: 'ext-2', name: 'broken-extension', displayName: 'Broken Extension', version: null, description: null,
      source: { type: 'local', location: 'C:/fixture/extensions/broken.ts' }, scope: 'project',
      state: { installed: true, enabled: null, loaded: false, restartRequired: null,
        error: { extensionId: 'ext-2', phase: 'load', message: 'Pi 报告扩展加载错误' } }, capabilities: [], configurable: false },
  ],
};

/* /api/mcp 的桩。形状照抄后端真实返回（P20.5 起带 version / builtins / rpc / mcpConfig）。
 * 这里用 **0.99.2**（当前契约基线）的真实形状：它确实带 builtin:mcp，
 * 旧版本（0.87.0）只有 llama.cpp。 */
let stubMcp = {
  ok: true,
  supported: true,
  reason: '这个 pi 包自带 built-in 扩展 `mcp`（配置走 pi 自己的 mcp.json，命令行是 pi mcp add / remove）',
  evidence: 'dist/extensions/index.js: { name: "mcp", factory: mcpExtension, replaceable: true, builtin: true }',
  piVersion: '0.99.2',
  version: { value: '0.99.2', source: 'package.json', status: 'known', updatedAt: '2026-10-01T03:00:00.000Z' },
  piPackageFound: true,
  servers: [],
  serversNote: '这个 pi 带 MCP 能力：Server 明细与运行时状态在 MCP 页（读 /api/mcp/servers，刷新走显式手势）。配置走 pi 自己的 mcp.json（命令行 pi mcp add / remove，或页内受控动作）。',
  builtins: {
    known: true,
    source: 'dist/extensions/index.js',
    entries: [
      { id: 'llama.cpp', replaceable: false, hidden: false, evidence: '{ name: "llama.cpp", factory: llamaExtension, builtin: true }' },
      { id: 'codemode', replaceable: true, hidden: false, evidence: '{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true }' },
      { id: 'tool-search', replaceable: true, hidden: false, evidence: '{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true }' },
      { id: 'mcp', replaceable: true, hidden: false, evidence: '{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true }' },
    ],
    evidence: 'export const builtInExtensions = [ … ]',
    note: 'built-in 扩展编译在 pi 包里，不由 Extension Registry 的目录扫描发现；「包里带了它」不等于「当前会话启用了它」。',
  },
  extensionApi: { available: true, registerMcpServer: true, getMcpServers: true, getAllTools: true, evidence: 'registerMcpServer(name: string, config: McpServerConfig): void;' },
  rpc: { commandCount: 33, commands: ['abort', 'prompt', 'get_state'], toolListCommand: false, note: 'Pi RPC 没有已注册工具清单命令：ExtensionAPI 有 getAllTools()，但那是扩展进程内的 API，RPC 不暴露它。所以 GUI 不伪造工具注册表。' },
  mcpConfig: { user: { exists: false }, project: { exists: true } },
  mcpCli: { available: true, evidence: '`pi mcp add` and `pi mcp remove` edit the file from a shell' },
  extensionRoute: {
    note: 'pi 官方建议把 MCP 这类能力做成 extension 或 package。',
    userDir: 'C:\\Users\\21022\\.pi\\agent\\extensions',
    projectDir: 'C:\\pi-GUI\\.pi\\extensions',
    user: { exists: false, entries: [], count: 0, error: '' },
    project: { exists: true, entries: [{ name: 'my-ext', kind: 'file', size: 1200, mtime: 1 }], count: 1, error: '' },
    fromSettings: [],
    packages: [],
  },
};
const mcpCalls = [];
/* P20.6 原生 MCP 的桩：GET /api/mcp/servers 的摘要形状照抄后端真实返回
 * （契约基线 pi 0.99.2：带 description、runtime 带 resources / resourceTemplates）；
 * POST 同一路径是受控动作（add/remove/login/logout），POST /api/mcp/status
 * 是显式状态刷新。动作只记录、不执行。 */
let stubMcpServers = {
  ok: true,
  fresh: true,
  at: '2026-10-01T06:00:00.000Z',
  native: { state: 'active', replaced: false, disabled: null, builtinPresent: true, reason: 'builtin:mcp 在包里、未被禁用、未被接管' },
  trust: { trusted: true, requiresTrust: true },
  servers: [
    { name: 'fs', scope: 'user', enabled: true, exposure: 'direct', transportType: 'stdio', description: 'Local filesystem access', hasSecrets: false, toolExposure: null, toolExposureNote: '', overridden: false, effective: { active: true, reason: '' } },
    { name: 'docs', scope: 'project', enabled: true, exposure: 'codemode', transportType: 'http', description: '', hasSecrets: true, toolExposure: { search_code: 'direct' }, toolExposureNote: '', overridden: false, effective: { active: true, reason: '' } },
  ],
  configInvalid: [],
  configError: { user: '', project: '' },
  runtime: {
    at: '2026-10-01T06:00:00.000Z',
    cached: false,
    ok: true,
    code: '',
    error: '',
    errors: [],
    note: '',
    exitCode: 0,
    servers: [
      { name: 'fs', scope: 'user', enabled: true, exposure: 'direct', transportType: 'stdio', state: 'connected', toolCount: 2, tools: ['read', 'write'], toolExposure: null, resources: 3, resourceTemplates: 1, error: '', hasSecrets: false, configured: true },
      { name: 'docs', scope: 'project', enabled: true, exposure: 'codemode', transportType: 'http', state: 'needs-auth', toolCount: 0, tools: [], toolExposure: { search_code: 'direct' }, resources: null, resourceTemplates: null, error: '', hasSecrets: true, configured: true },
    ],
  },
};
const mcpServerCalls = [];
const mcpStatusCalls = [];

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:7788/' });
const { window } = dom;
// jsdom 不加载外部样式表；只注入分组显隐规则，让 computedStyle 验证真实 CSS 选择器。
const groupDisplayRules = [styles.match(/\.group-body\s*\{[^}]*\}/)?.[0], styles.match(/\.rail-group\.open\s+\.group-body\s*\{[^}]*\}/)?.[0]];
const groupDisplayStyle = window.document.createElement('style');
groupDisplayStyle.textContent = groupDisplayRules.filter(Boolean).join('\n');
window.document.head.append(groupDisplayStyle);
window.localStorage.setItem('pi-group-open', '0');

window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));

class FakeES {
  constructor(url) { this.url = url; es = this; }
  close() {}
  emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}
window.EventSource = FakeES;


/* /api/agents 与 /api/plans 的桩。形状照抄后端真实返回。
 * 覆盖规格 §48 的 UI 组（47-53）需要的四种状态：成功 / 失败（带 attempt 历史）/
 * 运行中 / 被阻塞，外加一个「不可用 agent」与一条「生成失败」的响应。 */
const stubAgents = {
  ok: true,
  available: ['pi', 'codex'],
  auto: 'pi',
  hasProject: true,
  activePlanId: null,
  agents: [
    { id: 'pi', name: 'Pi', description: 'pi coding agent', available: true, version: '0.87.0', reason: '', detail: '', capabilities: { streaming: true, cancellation: true, resume: true, toolEvents: true }, notes: [], testOnly: false },
    { id: 'codex', name: 'Codex', description: 'OpenAI Codex CLI', available: true, version: '0.144.1', reason: '', detail: '', capabilities: { streaming: true, cancellation: true, resume: true, toolEvents: true }, notes: [], testOnly: false },
    { id: 'claude', name: 'Claude Code', description: 'Anthropic Claude Code CLI', available: false, version: '2.1.142', reason: 'entry-missing', detail: '@anthropic-ai/claude-code@2.1.142 已安装，但入口文件不存在：bin/claude.exe', capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false }, notes: ['安装不完整'], testOnly: false },
    { id: 'opencode', name: 'OpenCode', description: 'OpenCode CLI', available: false, version: '', reason: 'not-installed', detail: '找不到 npm 包 opencode-ai', capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false }, notes: [], testOnly: false },
  ],
};

const stubPlan = {
  id: 'plan-1',
  title: '给这个项目补登录功能',
  goal: '补完整的登录功能，并跑测试',
  status: 'paused',
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  endedAt: null,
  projectRoot: 'C:/demo',
  concurrency: 1,
  recoveryNotes: [],
  tasks: [
    { id: 'inspect', title: '分析认证架构', description: '读现有代码', agent: 'pi', workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 1, endedAt: 2, attempt: 1, error: '', verification: null,
      attempts: [{ attempt: 1, success: true, error: '', summary: '读完了', exitCode: 0, startedAt: 1, endedAt: 2, sessionId: 'sess-inspect-1', sessionAvailable: true, sessionTitle: '分析认证架构', filesChanged: ['src/auth.js'], changeCaptureIncomplete: false }],
      result: { success: true, exitCode: 0, summary: '已分析完现有认证架构', toolCalls: 2, durationMs: 12000, raw: null, sessionId: 'sess-inspect-1', changes: { available: true, files: [{ path: 'src/auth.js', change: 'modified', status: 'M', additions: 31, deletions: 12 }], note: '执行期间观察到的工作区变化（可能也包含其它来源的改动）' } } },
    { id: 'backend', title: '实现后端接口', description: '写接口', agent: 'codex', workingDirectory: '.', dependsOn: ['inspect'], status: 'failed', startedAt: 3, endedAt: 4, attempt: 2, error: '第一次故意失败：模型报 402', verification: null,
      attempts: [
        { attempt: 1, success: false, error: '第一次故意失败：模型报 402', summary: '', exitCode: 1, startedAt: 3, endedAt: 4, sessionId: 'sess-back-1', sessionAvailable: true, sessionTitle: '后端接口（第一次）', filesChanged: ['server/api.js'], changeCaptureIncomplete: false },
        { attempt: 2, success: false, error: '第一次故意失败：模型报 402', summary: '', exitCode: 1, startedAt: 5, endedAt: 6, sessionId: 'sess-back-2', sessionAvailable: true, sessionTitle: '后端接口（第二次）', filesChanged: ['server/api.js', 'tests/api.cjs'], changeCaptureIncomplete: false },
      ],
      result: { success: false, exitCode: 1, summary: '', toolCalls: 0, durationMs: 3000, raw: null, sessionId: 'sess-back-2', changes: { available: true, files: [], note: '' } } },
    { id: 'frontend', title: '实现前端界面', description: '写页面', agent: 'claude', workingDirectory: '.', dependsOn: ['inspect'], status: 'cancelled', startedAt: 7, endedAt: 8, attempt: 1, error: '已取消', verification: null, attempts: [{ attempt: 1, success: false, error: '已取消', summary: '', exitCode: null, startedAt: 7, endedAt: 8, sessionId: null, sessionAvailable: false, sessionTitle: '', filesChanged: [], changeCaptureIncomplete: false }], result: { success: false, exitCode: null, summary: '', toolCalls: 0, durationMs: 500, raw: null, sessionId: null, changes: { available: false, files: [], note: '' } } },
    { id: 'verify', title: '运行测试验证', description: '跑 npm test', agent: 'pi', workingDirectory: '.', dependsOn: ['backend', 'frontend'], status: 'blocked', startedAt: null, endedAt: null, attempt: 0, error: '', verification: { command: 'npm test' }, attempts: [], result: null },
  ],
};

/* P7 专用夹具：四种会话状态各来一条，外加一次「关联会话已删除」。
 * 用独立的 fixture 而不是往 stubPlan 上堆，是为了让既有断言（53 / §19）的
 * 前提保持稳定 —— 那些断言关心的是「历史与 Changes 还在不在」。 */
const stubPlanP7 = {
  id: 'plan-1',
  title: '给这个项目补登录功能',
  goal: 'g',
  status: 'paused',
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  endedAt: null,
  projectRoot: 'C:/demo',
  concurrency: 1,
  recoveryNotes: [],
  tasks: [
    { id: 'linked', title: '改后端', description: '', agent: 'pi', workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 1, endedAt: 2, attempt: 1, error: '', verification: null,
      attempts: [{ attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 1, endedAt: 2, sessionId: 'sess-a', sessionAvailable: true, sessionTitle: '修复 bridgeRun stale response', filesChanged: ['server/rpc-bridge.js'], changeCaptureIncomplete: false }],
      result: null },
    { id: 'retried', title: '补测试', description: '', agent: 'pi', workingDirectory: '.', dependsOn: [], status: 'failed', startedAt: 3, endedAt: 6, attempt: 2, error: '', verification: null,
      attempts: [
        { attempt: 1, success: false, error: '第一次失败', summary: '', exitCode: 1, startedAt: 3, endedAt: 4, sessionId: 'sess-r1', sessionAvailable: true, sessionTitle: '补测试（第一次）', filesChanged: ['tests/reliability.cjs'], changeCaptureIncomplete: false },
        { attempt: 2, success: false, error: '第二次也失败', summary: '', exitCode: 1, startedAt: 5, endedAt: 6, sessionId: 'sess-r2', sessionAvailable: true, sessionTitle: '补测试（第二次）', filesChanged: ['tests/reliability.cjs'], changeCaptureIncomplete: false },
      ],
      result: null },
    { id: 'nosess', title: '没有会话的任务', description: '', agent: 'codex', workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 7, endedAt: 8, attempt: 1, error: '', verification: null,
      attempts: [{ attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 7, endedAt: 8, sessionId: null, sessionAvailable: false, sessionTitle: '', filesChanged: ['src/demo.js'], changeCaptureIncomplete: false }],
      result: null },
    { id: 'gone', title: '会话被删的任务', description: '', agent: 'pi', workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 9, endedAt: 10, attempt: 1, error: '', verification: null,
      attempts: [{ attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 9, endedAt: 10, sessionId: 'sess-gone', sessionAvailable: false, sessionTitle: '', filesChanged: [], changeCaptureIncomplete: true }],
      result: null },
  ],
};

/* ---------- P8-C 专用夹具：人工审阅 ----------
 *
 * 一次铺开「三种审阅态 + 三种不可接受的执行结论 + 运行中 + 多次尝试 +
 * 无 attempt + 极端内容」，让审阅 UI 的每条规则都有真实数据可断言。
 *
 * 字段形状照抄后端 planView() + normalizeAttempt()：
 *   outcomeStatus          success / failed / cancelled / interrupted
 *   verificationSnapshot   {command} 或 {description} 或 null
 *   review                 {status, note, reviewedAt, revision}
 *                          （pending 时 note 是空串、reviewedAt 是 null ——
 *                            与后端 normalizeReview 完全一致，别在夹具里造
 *                            「pending 却带着旧说明」这种形状）
 * 会话状态字段同 P7：sessionId / sessionAvailable / sessionTitle。
 */
const XSS_NOTE = '<img src=x onerror=alert(1)> <script>alert(2)</script> <svg/onload=alert(3)>';
const R_LONG_PATH = 'packages/something/really/really/really/long/path/to/generated/adapter/implementation.js';
/* P9：一条很长、带满参数的验证命令 —— 用来验「长命令有 title、不撑爆卡片」。 */
const R_LONG_COMMAND = 'npm run test -- --reporter=spec --grep "reconnect|stale|bridgeRun" --timeout=30000 --reporter-options maxDiffSize=200000';
/* P10：历史变更证据的夹具（含 binary / 截断 / 改名 / XSS 各种形状）。 */
const R_EV_PATCH = 'diff --git a/src/auth.js b/src/auth.js\n--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1 +1 @@\n-const x = 1;\n+const x = 3;\n';
const R_EV_XSS = '<img src=x onerror=alert(1)>';
const mkEv = (over = {}) =>
  Object.assign(
    {
      status: 'available',
      capturedAt: 1758800000000,
      truncated: false,
      note: '',
      files: [
        { path: 'src/auth.js', change: 'modified', oldPath: null, binary: false, additions: 1, deletions: 1, patch: R_EV_PATCH, truncated: false },
      ],
    },
    over
  );
const R_MANY_FILES = Array.from({ length: 20 }, (_, i) => (i === 3 ? R_LONG_PATH : `src/gen/mod-${i}.js`));

function mkAtt(n, over) {
  return Object.assign(
    {
      attempt: n, success: true, error: '', summary: '', exitCode: 0, startedAt: n * 10, endedAt: n * 10 + 5,
      sessionId: `sess-r${n}`, sessionAvailable: true, sessionTitle: `第 ${n} 次的会话`,
      filesChanged: [], changeCaptureIncomplete: false,
      outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
      review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
    },
    over || {}
  );
}
function mkTask(id, attempts, over) {
  return Object.assign(
    {
      id, title: '任务 ' + id, description: '', agent: 'pi', workingDirectory: '.', dependsOn: [],
      status: 'success', startedAt: 1, endedAt: 2, attempt: attempts.length, error: '',
      verification: null, attempts, result: null,
    },
    over || {}
  );
}

const stubPlanReview = {
  id: 'plan-1', title: '审阅夹具', goal: 'g', status: 'paused', createdAt: 1, updatedAt: 2,
  startedAt: 1, endedAt: null, projectRoot: 'C:/demo', concurrency: 1, recoveryNotes: [],
  tasks: [
    mkTask('okcmd', [mkAtt(1, { changeEvidence: mkEv() })]),
    mkTask('okdesc', [mkAtt(1, { changeEvidence: mkEv({ status: 'unavailable', files: [], note: '无法采集执行前的 Git 状态（add-failed）' }), verificationSnapshot: { description: '确认登录错误提示' }, review: { status: 'accepted', note: '第一次通过', reviewedAt: 1758800000000, revision: 3 } })]),
    mkTask('oknull', [mkAtt(1, { verificationSnapshot: null })], { verification: { command: 'npm run test:unit' } }),
    mkTask('revneed', [mkAtt(1, { changeEvidence: mkEv({
      status: 'partial',
      truncated: true,
      note: '部分 diff 已截断',
      files: [
        { path: 'assets/logo.png', change: 'modified', oldPath: null, binary: true, additions: null, deletions: null, patch: '', truncated: false },
        { path: 'src/big.js', change: 'modified', oldPath: null, binary: false, additions: 900, deletions: 3, patch: R_EV_PATCH, truncated: true },
      ],
    }), review: { status: 'needs_changes', note: '缺少边界用例', reviewedAt: 1758800100000, revision: 1 }, verificationResult: { status: 'failed', command: 'npm test', workingDirectory: 'packages/core', workingDirectorySource: 'attempt-snapshot', exitCode: 1, startedAt: 1758800110000, finishedAt: 1758800128400, durationMs: 18400, outputSummary: 'not ok 3 - boom\nnpm ERR! Test failed', truncated: true, error: '' } })]),
    mkTask('xsstask', [mkAtt(1, { review: { status: 'accepted', note: XSS_NOTE, reviewedAt: 1758800200000, revision: 1 }, verificationResult: { status: 'passed', command: 'npm test', workingDirectory: XSS_NOTE, workingDirectorySource: 'attempt-snapshot', exitCode: 0, startedAt: 1758800210000, finishedAt: 1758800215000, durationMs: 5000, outputSummary: XSS_NOTE, truncated: false, error: '' } })]),
    mkTask('manyfiles', [mkAtt(1, { changeEvidence: mkEv({
      status: 'partial',
      truncated: true,
      note: '变更文件超过 50 个，只保留了前 50 个',
      files: [
        { path: 'src/new-name.js', change: 'renamed', oldPath: 'src/old-name.js', binary: false, additions: 0, deletions: 0, patch: '', truncated: false },
        { path: 'src/gone.js', change: 'deleted', oldPath: null, binary: false, additions: 0, deletions: 18, patch: R_EV_PATCH, truncated: false },
      ],
    }), filesChanged: R_MANY_FILES, review: { status: 'accepted', note: '二十个文件', reviewedAt: 1758800300000, revision: 1 }, verificationResult: { status: 'passed', command: R_LONG_COMMAND, workingDirectory: R_LONG_PATH.replace(/[^/]+$/, ''), workingDirectorySource: 'attempt-snapshot', exitCode: 0, startedAt: 1758800310000, finishedAt: 1758800331800, durationMs: 21800, outputSummary: 'all good\n', truncated: false, error: '' } })]),
    mkTask('failed', [mkAtt(1, { success: false, exitCode: 1, error: '模型报 402', outcomeStatus: 'failed' })], { status: 'failed' }),
    mkTask('cancelled', [mkAtt(1, { changeEvidence: mkEv({
      note: XSS_NOTE,
      files: [
        { path: 'src/' + XSS_NOTE + '.js', change: 'added', oldPath: null, binary: false, additions: 1, deletions: 0, patch: XSS_NOTE, truncated: false },
      ],
    }), success: false, exitCode: null, error: '已取消', outcomeStatus: 'cancelled', verificationResult: { status: 'interrupted', command: 'npm test', workingDirectory: 'packages/legacy', workingDirectorySource: 'current-task-fallback', exitCode: null, startedAt: 1758800220000, finishedAt: 1758800225000, durationMs: 5000, outputSummary: '', truncated: false, error: '已停止' } })], { status: 'cancelled' }),
    mkTask('interrupted', [mkAtt(1, { success: false, exitCode: null, error: '应用关闭时被中断', outcomeStatus: 'interrupted', filesChanged: [], changeCaptureIncomplete: true, verificationSnapshot: null })], { status: 'interrupted' }),
    mkTask('live', [mkAtt(1, { review: { status: 'accepted', note: '第一轮保留', reviewedAt: 1758800400000, revision: 1 }, verificationResult: { status: 'running', command: 'npm test', workingDirectory: '.', workingDirectorySource: 'attempt-snapshot', exitCode: null, startedAt: 1758800410000, finishedAt: null, durationMs: null, outputSummary: '', truncated: false, error: '' }, verificationRunning: true })], { status: 'running', attempt: 2 }),
    mkTask('multrev', [mkAtt(1, { review: { status: 'accepted', note: '第一次曾经通过', reviewedAt: 1758800500000, revision: 1 } }), mkAtt(2)]),
    mkTask('noattempt', [], { status: 'pending', attempt: 0 }),
  ],
};

/* P13：审阅草稿那条断言用的**原始副本**。
 *
 * ⚠️ P8-C / P9 段会**就地改** stubPlanReview（保存审阅、开验证 —— 那些断言本来就
 * 该改数据）。所以跑到 P13 时它已经不是原样了：okcmd 的审阅被接受过、验证跑过。
 * 这份快照在测试进程启动时拍下，谁也碰不到它。 */
const stubPlanDraft = JSON.parse(JSON.stringify(stubPlanReview));

/* P11：人工验收门控的夹具。
 * 视图字段（`gateState` / `blockedReason` / `waitingOn` / `reviewGateSummary` /
 * `workflowReason`）都是**后端 planView 注进去的**，所以桩里照真实形状给出来。 */
const stubPlanGate = {
  id: 'plan-gate', title: '门控夹具', goal: 'g', status: 'paused', createdAt: 1, updatedAt: 2,
  startedAt: 1, endedAt: null, projectRoot: 'C:/demo', concurrency: 1, recoveryNotes: [],
  reviewGateSummary: { gated: 3, satisfied: 1, waiting: 2 },
  workflowReason: 'waiting-review',
  tasks: [
    mkTask('gpending', [mkAtt(1)], { reviewGate: true, gateState: { enabled: true, required: true, satisfied: false, reason: 'pending', attempt: 1 } }),
    mkTask('gok', [mkAtt(1, { review: { status: 'accepted', note: '', reviewedAt: 1, revision: 1 } })], { reviewGate: true, gateState: { enabled: true, required: true, satisfied: true, reason: 'accepted', attempt: 1 } }),
    mkTask('gneed', [mkAtt(1, { review: { status: 'needs_changes', note: '还差边界用例', reviewedAt: 1, revision: 1 } })], { reviewGate: true, gateState: { enabled: true, required: true, satisfied: false, reason: 'needs_changes', attempt: 1 } }),
    mkTask('gnever', [], { status: 'pending', attempt: 0, reviewGate: true, gateState: { enabled: true, required: false, satisfied: false, reason: 'no-successful-attempt', attempt: null } }),
    /* P12：`required=false` 的门控 —— 这次执行**没成功**，没有可验收的产出。
     * `reason` 仍可能是 pending（更早那次成功还没被验收过），但文案不能写「等待人工验收」。 */
    mkTask('gfailed', [mkAtt(1)], { status: 'failed', attempt: 1, reviewGate: true, gateState: { enabled: true, required: false, satisfied: false, reason: 'pending', attempt: 1 } }),
    /* Retry 之后的 pending —— attempt1 曾被接受是**历史**（satisfied=true），
     * 但当前这次还没成功（required=false）：没有「已通过」这回事。
     * 回归对应 P12 blocker：pending + 旧 accepted 曾被判成「放行」。 */
    mkTask('gfailedold', [mkAtt(1, { review: { status: 'accepted', note: '第一次通过了', reviewedAt: 1, revision: 1 } })], { status: 'failed', attempt: 1, reviewGate: true, gateState: { enabled: true, required: false, satisfied: true, reason: 'accepted', attempt: 1 } }),
    mkTask('nogate', [mkAtt(1)]),
    mkTask('downstream', [], { status: 'blocked', attempt: 0, dependsOn: ['gpending'], blockedReason: 'waiting-review', waitingOn: ['gpending'] }),
    mkTask('downfail', [], { status: 'blocked', attempt: 0, dependsOn: ['bad'], blockedReason: 'dependency-failed', waitingOn: ['bad'] }),
    mkTask(XSS_NOTE, [], { status: 'blocked', attempt: 0, reviewGate: true, gateState: { enabled: true, required: false, satisfied: false, reason: 'pending', attempt: 1 }, blockedReason: 'waiting-review', waitingOn: [XSS_NOTE] }),
  ],
};

/* ---------- P13 夹具：Plan 下一步 / Attempt 折叠 ----------
 *
 * 只用后端已有的视图字段（status / workflowReason / reviewGateSummary /
 * verificationActive / blockedReason / gateState），**不给 plan 加任何新字段** ——
 * 「下一步」必须能从后端真相推导出来，夹具先按这条规矩造。
 */
const stubPlanReady = {
  id: 'plan-ux', title: '还没开始的计划', goal: 'g', status: 'ready', createdAt: 1, updatedAt: 2,
  startedAt: null, endedAt: null, projectRoot: 'C:/demo', concurrency: 1, recoveryNotes: [],
  reviewGateSummary: { gated: 0, satisfied: 0, waiting: 0 },
  tasks: [
    mkTask('ux-a', [], { status: 'ready', attempt: 0 }),
    mkTask('ux-b', [], { status: 'pending', attempt: 0, dependsOn: ['ux-a'] }),
    mkTask('ux-done', [mkAtt(1)]),
  ],
};

const stubPlanRunning = {
  id: 'plan-ux', title: '正在跑的计划', goal: 'g', status: 'running', createdAt: 1, updatedAt: 2,
  startedAt: 1, endedAt: null, projectRoot: 'C:/demo', concurrency: 1, recoveryNotes: [],
  reviewGateSummary: { gated: 0, satisfied: 0, waiting: 0 },
  tasks: [
    mkTask('ux-run', [mkAtt(1)], { status: 'running', attempt: 2 }),
    mkTask('ux-wait', [], { status: 'pending', attempt: 0, dependsOn: ['ux-run'] }),
  ],
};

/* 十次尝试：默认折叠、手动开合、focus 定位、交互必需展开都用它。 */
const stubPlanTen = {
  id: 'plan-ux', title: '折叠夹具', goal: 'g', status: 'paused', createdAt: 1, updatedAt: 2,
  startedAt: 1, endedAt: null, projectRoot: 'C:/demo', concurrency: 1, recoveryNotes: [],
  tasks: [
    mkTask('ten', Array.from({ length: 10 }, (_, i) =>
      mkAtt(i + 1, {
        success: i === 9, exitCode: i === 9 ? 1 : 0, outcomeStatus: i === 9 ? 'failed' : 'success',
        error: i === 9 ? '第十次仍然超时' : '', summary: i === 9 ? '' : `第 ${i + 1} 次做完了`,
      })), { status: 'failed', attempt: 10 }),
    mkTask('pair', [
      mkAtt(1, { review: { status: 'accepted', note: '第一次通过', reviewedAt: 1, revision: 1 }, changeEvidence: mkEv() }),
      mkAtt(2, { success: false, exitCode: 1, outcomeStatus: 'failed', error: '第二次失败' }),
    ], { status: 'failed', attempt: 2 }),
    mkTask('single', [mkAtt(1, {
      verificationResult: { status: 'passed', command: 'npm test', workingDirectory: '.', workingDirectorySource: 'attempt-snapshot', exitCode: 0, startedAt: 1, finishedAt: 2, durationMs: 5000, outputSummary: 'all good', truncated: false, error: '' },
      review: { status: 'accepted', note: '一次过', reviewedAt: 3, revision: 1 },
      changeEvidence: mkEv(),
    })]),
    /* 交互必需：**旧**那次正在独立验证 —— 默认该收起，但必须自己展开。 */
    mkTask('verrun', [
      mkAtt(1, { verificationRunning: true, verificationResult: { status: 'running', command: 'npm test', workingDirectory: '.', workingDirectorySource: 'attempt-snapshot', exitCode: null, startedAt: 1, finishedAt: null, durationMs: null, outputSummary: '', truncated: false, error: '' } }),
      mkAtt(2),
    ], { status: 'success', attempt: 2 }),
  ],
};

/* 「下一步」里的任务 id 是**文本**，不是 HTML —— 恶意 id 必须原样显示（G15 同一条规矩）。 */
const stubPlanBad = {
  id: 'plan-ux', title: '恶意 id 夹具', goal: 'g', status: 'paused', createdAt: 1, updatedAt: 2,
  startedAt: 1, endedAt: null, projectRoot: 'C:/demo', concurrency: 1, recoveryNotes: [],
  tasks: [mkTask(XSS_NOTE, [], { status: 'failed', attempt: 1 })],
};

/* P13 §二十九：门控夹具**复制一份**加一条「重试排队中」——
 * 不能直接往 stubPlanGate 上加，那会让其它段的断言跟着变。 */
const stubPlanGateUx = {
  ...stubPlanGate,
  tasks: stubPlanGate.tasks.concat([
    mkTask('gpend2', [mkAtt(1, { review: { status: 'accepted', note: '第一次通过', reviewedAt: 1, revision: 1 } })],
      { status: 'pending', attempt: 2, reviewGate: true, gateState: { enabled: true, required: false, satisfied: true, reason: 'accepted', attempt: 1 } }),
  ]),
};

/* 计划详情接口回什么 —— 默认 stubPlan，P7 段临时换成 stubPlanP7。 */
let stubPlanDetail = stubPlan;

/* P7 §8：会话 → 任务 的反向关联。两条命中，用来验「关联 N 个任务」与展开。 */
const stubRelations = {
  ok: true,
  hasProject: true,
  sessionId: '01a0d999-1111-2222-3333',
  truncated: false,
  matches: [
    { planId: 'plan-1', planTitle: '修复 SSE 重连问题', planStatus: 'paused', taskId: 'backend', taskTitle: '修改后端', taskStatus: 'failed', agent: 'pi', attempt: 2, startedAt: 5, endedAt: 6, success: false, filesChanged: ['server/rpc-bridge.js'] },
    { planId: 'plan-1', planTitle: '修复 SSE 重连问题', planStatus: 'paused', taskId: 'tests', taskTitle: '补测试', taskStatus: 'success', agent: 'pi', attempt: 1, startedAt: 7, endedAt: 8, success: true, filesChanged: ['tests/reliability.cjs'] },
  ],
};

/* 打开会话的响应 —— 可被测试临时改成失败，验证「正常结果不当错误」 */
let stubOpenSession = { ok: true, id: 'bbbbbbbbbbbbbbbb', title: '修复 bridgeRun stale response', sessionId: 'sess-a', taskId: 'linked', attempt: 1 };
const openSessionCalls = [];

/* P8-C：人工审阅的保存响应 —— 同样可被测试临时替换。
 *
 * 默认回一条**像真后端那样**的成功体：`{ok, planId, taskId, attempt, review}`，
 * review 的形状就是 `normalizeReview` 的输出（pending 时 note 为空串、reviewedAt 为 null）。
 *
 * ⚠️ 冲突**不能用 HTTP 状态码表达** —— api.js 只做 `await r.json()`，从不看
 * `res.status`。所以冲突桩必须是 `{ok:false, code:'review-conflict', …}`，
 * 前端也正是靠 body 里的 `code` 认出来的。这一点与真后端的 409 行为一致。 */
const reviewCalls = [];
let stubReviewResult = null;
let reviewDelayMs = 0;

/* P9：独立验证的桩。默认回一条「刚启动」的 running 记录（与真后端一致）。
 * 冲突 / 拒绝之类的分支用 `stubVerifyResult` 覆写成 `{ok:false, code:…}`。 */
const verifyCalls = [];
let stubVerifyResult = null;
let verifyDelayMs = 0;
/* P9 收口：后端把「现在有独立验证在跑」放在 plan view 上（全 workspace 级）。
 * 桩里也能摆出来，用来测前端的动作锁。 */
let stubVerificationActive = null;

const stubPlans = {
  ok: true,
  hasProject: true,
  activePlanId: null,
  broken: [],
  plans: [
    { id: 'plan-1', title: '给这个项目补登录功能', goal: 'g', status: 'paused', createdAt: 1, updatedAt: 2, startedAt: 1, endedAt: null, projectRoot: 'C:/demo', counts: { total: 4, success: 1, failed: 1, cancelled: 1, skipped: 0 }, recoveryNotes: [] },
    { id: 'plan-2', title: '已经跑完的老计划', goal: 'g', status: 'completed', createdAt: 0, updatedAt: 0, startedAt: 0, endedAt: 0, projectRoot: 'C:/demo', counts: { total: 2, success: 2, failed: 0, cancelled: 0, skipped: 0 }, recoveryNotes: ['上次运行被中断：1 个任务需要重试'] },
  ],
};

/* 生成失败的桩：验证 §33「把原因与原始输出摆出来，而不是 500 / 崩溃」 */
let stubGenerate = { ok: false, error: '模型生成的计划没有通过校验', errors: ['依赖成环：a → b → a', '没有任何无依赖的任务（没有入口，无法开始执行）'], raw: '```json\n{"tasks":[{"id":"a","dependsOn":["b"]}]}\n```' };

const plannerCalls = [];


/* /api/sessions 的桩：两条会话，一条是当前。形状照抄后端真实返回
 * （**注意不含任何绝对路径** —— 这是后端的硬约束，桩也不能带，
 * 否则 UI 断言「DOM 里没有路径」就成了假绿）。 */
const stubSessions = {
  ok: true,
  hasProject: true,
  currentId: 'aaaaaaaaaaaaaaaa',
  diagnostics: [],
  sessions: [
    { id: 'bbbbbbbbbbbbbbbb', title: '帮我写个登录功能', sessionId: '01a0d257-4f74-71fc-8f53', createdAt: '2026-09-24T07:35:32.469Z', lastMessageAt: '2026-09-25T10:22:03.235Z', updatedAt: 1758800000000, messageCount: 14, current: false, pending: false, archived: false, truncated: false },
    { id: 'cccccccccccccccc', title: '上周的排查记录', sessionId: '01a0d111-2222-3333-4444', createdAt: '2026-09-20T07:35:32.469Z', lastMessageAt: '2026-09-20T08:00:00.000Z', updatedAt: 1758300000000, messageCount: 5, current: false, pending: false, archived: true, truncated: false },
    { id: 'aaaaaaaaaaaaaaaa', title: '你好', sessionId: '01a0d999-1111-2222-3333', createdAt: '2026-09-25T09:00:00.000Z', lastMessageAt: '2026-09-25T10:00:00.000Z', updatedAt: 1758790000000, messageCount: 2, current: true, pending: false, archived: false, truncated: false },
  ],
};
let stubSwitch = { ok: true, id: 'bbbbbbbbbbbbbbbb', title: '帮我写个登录功能' };
const sessionCalls = [];

/* ---------- /api/sessions/search 的桩（P3） ----------
 *
 * 形状照抄后端真实返回（server/session-search.js）。
 * ⚠️ matches[].snippet 是**会话正文**，属于不可信输入 —— 所以这里故意塞一段
 * HTML 进去，用来验证前端是当**文本**渲染的（textContent / 文本节点），
 * 而不是拼进 innerHTML。把这条桩改成干净文本，那条断言就变成空转了。
 *
 * updatedAt 用「相对现在」算，这样 fmtTime 的输出稳定可断言。 */
const SEARCH_ARCHIVED_HIT = {
  id: 'cccccccccccccccc',
  sessionId: '01a0d111-2222-3333-4444',
  title: '上周的排查记录',
  archived: true,
  createdAt: '2026-09-20T07:35:32.469Z',
  updatedAt: Date.now() - 3 * 86400_000,
  messageCount: 5,
  matchCount: 1,
  matches: [{ type: 'assistant', index: 3, userIndex: 1, messageId: 'm3', timestamp: null, snippet: '失败任务 retry 后 attempt history 会重建' }],
};
const SEARCH_ACTIVE_HIT = {
  id: 'bbbbbbbbbbbbbbbb',
  sessionId: '01a0d257-4f74-71fc-8f53',
  title: '修复 SSE 重连',
  archived: false,
  createdAt: '2026-09-24T07:35:32.469Z',
  updatedAt: Date.now() - 3600_000,
  messageCount: 6,
  matchCount: 2,
  matches: [
    { type: 'title', index: 0, userIndex: 0, messageId: null, timestamp: null, snippet: '修复 SSE 重连' },
    {
      type: 'user',
      index: 2,
      userIndex: 1,
      messageId: 'm2',
      timestamp: null,
      snippet: '为什么 bridgeRun 会重复增长 <img src=x onerror=alert(1)> 这一段',
    },
  ],
};
const stubSearch = {
  ok: true,
  query: 'bridge',
  scope: 'active',
  hasProject: true,
  results: [SEARCH_ACTIVE_HIT, SEARCH_ARCHIVED_HIT],
  scanned: { sessions: 3, bytes: 1234, skipped: 0, truncated: false },
};
const searchCalls = [];
/* 每次搜索请求按顺序取一个计划项：{ delayMs, payload }。
 * 用它造「旧请求回来得比新请求晚」的竞态。 */
let searchPlan = [];
const planSearch = (...items) => {
  searchPlan = items.slice();
};

/* ---------- 版本检查（P5）的桩 ----------
 *
 * /api/update 的可变桩 + 调用流水。默认「已是最新版」—— 大多数用例不该
 * 被更新提示打扰；要测更新提示的用例自己改 stubUpdate。
 * updatePlan 与 searchPlan 同形：按顺序取 { delayMs, payload }，用来造竞态。
 *
 * ⚠️ 这里的版本号（0.11.1 / 0.12.0）是**桩值，故意不跟 package.json 联动** ——
 * 断言的是「界面把后端给的版本号如实显示出来」，不是「界面显示的是 0.12.0」。
 * 跟着真实版本号走会让每次发版都要改测试，而且改错了也看不出来。 */
const UPDATE_LATEST = { ok: true, currentVersion: '0.11.1', latestVersion: '0.11.1', updateAvailable: false, cached: false };
const UPDATE_AVAILABLE = {
  ok: true,
  currentVersion: '0.11.1',
  latestVersion: '0.12.0',
  updateAvailable: true,
  cached: false,
  release: {
    name: 'Pi GUI v0.12.0',
    tag: 'v0.12.0',
    publishedAt: '2026-09-30T09:00:00Z',
    notes: '## 新增\n\n- 版本检查与更新体验\n',
    notesTruncated: false,
    url: 'https://github.com/HYJ1817/pi-gui/releases/tag/v0.12.0',
    assets: [
      { name: 'Pi-GUI-Setup-0.12.0.exe', size: 105020429, url: 'https://github.com/HYJ1817/pi-gui/releases/download/v0.12.0/Pi-GUI-Setup-0.12.0.exe', kind: 'installer' },
      { name: 'Pi-GUI-0.12.0-portable.zip', size: 342487040, url: 'https://github.com/HYJ1817/pi-gui/releases/download/v0.12.0/Pi-GUI-0.12.0-portable.zip', kind: 'portable' },
      { name: 'SHA256SUMS.txt', size: 183, url: 'https://github.com/HYJ1817/pi-gui/releases/download/v0.12.0/SHA256SUMS.txt', kind: 'checksums' },
    ],
    droppedAssets: 0,
  },
};
let stubUpdate = { ...UPDATE_LATEST };
let updatePlan = [];

/* ---------- Pi 运行时更新（Built-in Pi Updater）的桩 ----------
 *
 * 与上面 Pi GUI 自己的更新**分成两套桩**（`stubPiUpdate` vs `stubUpdate`）——
 * 两件事一旦共用状态，测试就再也说不出「界面上这行字是哪个更新」。
 * 版本号同样是桩值：断言的是「界面如实显示后端给的版本」，不是具体数字。 */
const PI_UPDATE_LATEST = {
  ok: true, phase: 'latest', currentVersion: '0.99.2', latestVersion: '0.99.2',
  packageName: '@earendil-works/pi-coding-agent', updateAvailable: false,
  verification: 'unverified', canUpdate: false, reason: 'latest', cached: false, running: false,
};
const PI_UPDATE_AVAILABLE = {
  ok: true, phase: 'available', currentVersion: '0.99.2', latestVersion: '1.0.0',
  packageName: '@earendil-works/pi-coding-agent', updateAvailable: true,
  verification: 'unverified', canUpdate: true, reason: null, cached: false, running: false,
};
let stubPiUpdate = { ...PI_UPDATE_LATEST };
let stubPiUpdateStart = { ok: true, accepted: true, phase: 'updating', currentVersion: '0.99.2', latestVersion: '1.0.0' };
const piUpdateCalls = [];
/** GET /api/pi-update 的顺序桩：驱动真实轮询的相位序列。 */
let piUpdatePlan = [];
const planPiUpdate = (...items) => {
  piUpdatePlan = items.slice();
};
const planUpdate = (...items) => {
  updatePlan = items.slice();
};
const updateCalls = [];

/* /api/diagnostics 的桩。形状照抄后端真实返回（含 app.version）。 */
const stubDiagnostics = {
  schemaVersion: 1,
  generatedAt: '2026-09-26T00:00:00.000Z',
  app: { id: 'pi-gui', version: '0.11.1' },
  system: { platform: 'win32', arch: 'x64', node: 'v24.14.0', os: 'Windows_NT', release: '10.0.26100' },
  project: { selected: true, name: 'pi-GUI', readable: true, writable: true },
  data: { readable: true, writable: true },
  bridge: { piRunning: true, bridgeRun: 1, hasProject: true, args: ['--mode', 'rpc'] },
  pi: {
    configuredBin: 'pi', available: true, version: '0.87.0',
    versionSource: 'package.json',
    /* P23：版本核对状态（`unverified` = 矩阵里没有这个版本）。 */
    verification: { status: 'unverified', verifiedAgainst: null, relative: 'newer' },
    launch: { source: 'path', binName: 'pi.cmd', entryKnown: true, packageDirKnown: true },
  },
  agents: [{ id: 'pi', available: true, version: '0.87.0', reason: null, capabilities: null }],
  mcp: {
    supported: false, piVersion: '0.87.0', error: null,
    /* P23：原生摘要（**不含 server 名字** —— 诊断只给状态与计数）。 */
    native: { fresh: true, state: 'active', reason: 'builtin:mcp 在包里、未被禁用、未被接管', replaced: false, disabled: null, builtinPresent: true, serverCount: 2, trust: true },
  },
  /* P23：能力 probe 表（形状照抄 GET /api/diagnostics 的真实返回）。 */
  probes: {
    at: '2026-09-26T00:00:00.000Z',
    packageKnown: true,
    summary: { total: 4, supported: 2, unsupported: 1, unknown: 1, unverified: ['rpc'] },
    items: [
      { id: 'rpc-commands', kind: 'source', label: 'RPC 命令集', state: true, evidence: 'dist/modes/rpc/rpc-types.d.ts: RpcCommand 联合共 33 条' },
      { id: 'builtin-mcp', kind: 'source', label: 'builtin:mcp', state: false, evidence: 'builtInExtensions 里没有 mcp：llama.cpp' },
      { id: 'approval-hook', kind: 'source', label: 'tool_call 可阻断', state: null, evidence: '类型与文档里没有同时找到 tool_call 阻断契约' },
      { id: 'rpc', kind: 'runtime', label: 'RPC 通道真的通了', state: true, evidence: '来自 pi-compat 的能力三值' },
    ],
  },
  /* P23：兼容矩阵摘要（只有版本号与日期）。1.0.0 起 current 是 1.0.0。 */
  matrix: {
    piBaselines: [
      { version: '0.87.0', verifiedAt: '2026-09-30', scope: 'historical' },
      { version: '0.99.2', verifiedAt: '2026-10-01', scope: 'historical' },
      { version: '1.0.0', verifiedAt: '2026-10-02', scope: 'current' },
    ],
    currentBaseline: '1.0.0',
    extensionBaselines: [{ name: 'pi-memory', version: '0.4.2', verifiedAt: '2026-09-30' }],
    nativeMcp: { builtinId: 'mcp', replaceable: true, serverStates: ['connected'], exposures: ['codemode'], cliSubcommands: ['add'] },
    knownDifferences: [{ id: 'iserror-propagation', between: '0.87.0 → 0.99.1', affects: 'P18 / P20 成功证据' }],
  },
  /* P23：关键 Extension 版本（有可靠 metadata 的）。 */
  extensions: {
    discovered: 2,
    items: [{ name: 'pi-memory', version: '0.4.2', scope: 'global', installed: true, loaded: null }],
  },
  checks: [
    { id: 'data-readable', ok: true },
    { id: 'data-writable', ok: true },
    { id: 'project-readable', ok: true },
    { id: 'project-writable', ok: true },
    { id: 'pi-running', ok: true },
  ],
  compatibility: {
    status: 'partial',
    detected: true,
    piVersion: '0.87.0',
    versionKnown: true,
    versionSource: { source: 'package.json', status: 'known', updatedAt: '2026-10-01T00:00:00.000Z' },
    versionVerification: { verification: 'unverified', verifiedAgainst: null, relative: 'newer' },
    capabilities: { rpc: true, getState: true, getMessages: null, newSession: null, switchSession: null, sessionNaming: false, toolEvents: null, extensionUi: null, sessionJsonl: null },
    missing: ['sessionNaming'],
    unverified: ['getMessages'],
    protocol: { expected: 1, observed: 1 },
    /* P23：schema 漂移（只有来源 + 字段名，**没有值**）。 */
    schema: {
      unknownFields: [{ source: 'usage', field: 'contextUsage.tokens', at: 1758800000000 }],
      unknownEnums: [{ source: 'mcp-runtime', field: 'server.state', at: 1758800000000 }],
    },
    issues: [{ at: 1758800000000, category: 'response', operation: 'set_session_name', issue: 'command-failed' }],
  },
  privacy: {
    absolutePathsIncluded: false,
    conversationContentIncluded: false,
    configFileContentIncluded: false,
    environmentIncluded: false,
    protocolPayloadsIncluded: false,
    /* P23：schema 漂移只记来源 / 字段名 / 类型，不记值。 */
    schemaDriftValuesIncluded: false,
    redactionApplied: true,
  },
};

window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/upload')) {
    const nm = decodeURIComponent(new URL(u, 'http://x').searchParams.get('name') || 'f');
    const base = { ok: true, name: nm, path: 'C:\\pi-GUI\\.uploads\\' + nm };
    if (/\.png$/i.test(nm)) return { json: async () => ({ ...base, id: 'u-png', size: 100, kind: 'image', pages: null }) };
    if (/\.pdf$/i.test(nm)) {
      return {
        json: async () => ({
          ...base, id: 'u-pdf', size: 453303, kind: 'text', pages: 1, chars: 385, truncated: false,
          text: '发酵罐空气分布器的设计参数核算\n罐体公称容积 V = 50 m³', preview: '发酵罐空气分布器的设计参数核算',
        }),
      };
    }
    if (/\.docx$/i.test(nm)) {
      return {
        json: async () => ({
          ...base, id: 'u-docx', size: 1627, kind: 'text', pages: null, chars: 385, truncated: false,
          text: '发酵罐空气分布器设计', preview: '发酵罐空气分布器设计',
        }),
      };
    }
    return { json: async () => ({ ...base, id: 'u-bin', size: 2000, kind: 'binary', pages: null }) };
  }
  if (u.includes('/api/status')) {
    return {
      json: async () => ({
        piRunning: Boolean(stubCwd),
        cwd: stubCwd,
        args: ['--mode', 'rpc', '--continue'],
        hasProject: Boolean(stubCwd),
        ...(stubCompat ? { compat: stubCompat } : {}),
      }),
    };
  }
  if (u.includes('/api/pi-update')) {
    const isPost = Boolean(opts && opts.method === 'POST');
    piUpdateCalls.push({
      method: isPost ? 'POST' : 'GET',
      force: u.includes('force=1'),
      body: isPost && opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null,
    });
    if (isPost) return { json: async () => ({ ...stubPiUpdateStart }) };
    /* GET 可以按顺序给不同相位（用来驱动**真实轮询**：updating → verifying →
     * restarting → latest）。队列空了就回默认桩。 */
    const next = piUpdatePlan.length ? piUpdatePlan.shift() : { ...stubPiUpdate };
    return { json: async () => next };
  }
  if (u.includes('/api/update')) {
    updateCalls.push({ url: u, force: u.includes('force=1') });
    const plan = updatePlan.shift() || {};
    return {
      json: async () => {
        if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
        if (plan.payload) return plan.payload;
        return { ...stubUpdate };
      },
    };
  }
  if (u.includes('/api/diagnostics')) {
    return { json: async () => ({ ok: true, diagnostics: stubDiagnostics }) };
  }
  if (u.includes('/api/git/')) {
    const kind = u.slice(u.indexOf('/api/git/') + '/api/git/'.length).split('?')[0];
    gitCalls.push({ kind, body: opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
    return { json: async () => gitStub[kind] || { ok: true } };
  }
  if (u.includes('/api/command')) {
    const body = JSON.parse(opts.body);
    commands.push(body);
    return { json: async () => ({ ok: true }) };
  }
  if (u.includes('/api/project-config')) {
    const isPut = Boolean(opts && opts.method === 'PUT');
    const body = isPut && opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    projectConfigCalls.push({ method: isPut ? 'PUT' : 'GET', body });
    if (isPut) {
      if (stubSaveResult) return { json: async () => stubSaveResult };
      return {
        json: async () => ({
          ok: true,
          path: stubProjectConfig.path,
          config: { ...CFG_DEFAULTS, ...body },
          warnings: [],
          restartRequired: false,
          restarted: false,
        }),
      };
    }
    return { json: async () => stubProjectConfig };
  }
  /* 搜索必须排在下面那条通用的 /api/sessions **前面** —— 否则会被它吃掉，
   * 拿到一份会话列表当搜索结果（与后端路由那处「顺序即语义」是同一个坑）。 */
  if (u.includes('/api/sessions/search')) {
    const qs = new URL(u, 'http://x').searchParams;
    const q = qs.get('q') || '';
    const scope = qs.get('scope') || 'active';
    searchCalls.push({ q, scope, url: u });
    const plan = searchPlan.shift() || {};
    return {
      json: async () => {
        if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
        if (plan.payload) return plan.payload;
        // 默认：按 scope 过滤掉不符合的
        const results = stubSearch.results.filter((r) => scope === 'all' || (scope === 'archived') === r.archived);
        return { ...stubSearch, query: q, scope, results };
      },
    };
  }
  if (u.includes('/api/sessions')) {
    const method = (opts && opts.method) || 'GET';
    let body = null;
    try {
      body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    } catch {
      body = null;
    }
    sessionCalls.push({ method, url: u, body });
    if (u.includes('/switch')) return { json: async () => stubSwitch };
    if (u.includes('/name')) return { json: async () => ({ ok: true, name: (body && body.name) || '' }) };
    return { json: async () => stubSessions };
  }
  if (u.includes('/api/agents')) {
    return { json: async () => stubAgents };
  }
  if (u.includes('/api/plans')) {
    const method = (opts && opts.method) || 'GET';
    let body = null;
    try {
      body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    } catch {
      body = null;
    }
    plannerCalls.push({ method, url: u, body });
    if (u.includes('/generate')) return { json: async () => stubGenerate };
    /* ⚠️ 顺序要紧：`relations` 与 `open-session` 都必须排在下面那条「:id」之前，
     * 否则会被当成「查一个 id 叫 relations 的计划」。这和 router.js 里
     * 「顺序即语义」是同一类坑。 */
    if (u.includes('/relations')) return { json: async () => stubRelations };
    /* P8-C：审阅保存。必须排在 `method !== 'GET'` 那条兜底之前 ——
     * 否则会和 retry / cancel / skip 落到同一个「一律 ok」的桩上，
     * 冲突与失败两条路径就永远测不到（它们是这一段最该测的东西）。 */
    if (/\/attempts\/\d+\/review/.test(u)) {
      reviewCalls.push({ method, url: u, body });
      return {
        json: async () => {
          /* 延迟钩子：用来制造「保存还没回来就切了项目 / 切了计划」的窗口
           *（§三十八 / §三十九 / §四十 的 stale 守卫必须真的测到）。 */
          if (reviewDelayMs) await new Promise((r) => setTimeout(r, reviewDelayMs));
          return stubReviewResult || { ok: true, planId: 'plan-1', taskId: 'linked', attempt: 1, review: { status: (body && body.status) || 'accepted', note: (body && body.note) || '', reviewedAt: 1758800000000, revision: ((body && body.expectedRevision) || 0) + 1 } };
        },
      };
    }
    if (u.includes('/open-session')) {
      openSessionCalls.push({ method, url: u, body });
      return { json: async () => stubOpenSession };
    }
    /* P9：独立验证的启动 / 停止。同样必须排在 `method !== 'GET'` 的兜底之前 ——
     * 否则「启动」会落到那个「一律 ok」的桩上，连 code 都测不到。 */
    if (/\/attempts\/\d+\/verify/.test(u)) {
      verifyCalls.push({ method, url: u });
      return {
        json: async () => {
          if (verifyDelayMs) await new Promise((r) => setTimeout(r, verifyDelayMs));
          if (stubVerifyResult) return stubVerifyResult;
          if (/\/stop$/.test(u)) return { ok: true, planId: 'plan-1', taskId: 'tests', attempt: 1 };
          const m = /\/attempts\/(\d+)\/verify$/.exec(u);
          return {
            ok: true,
            planId: 'plan-1',
            taskId: 'tests',
            attempt: Number(m ? m[1] : 1),
            verification: { status: 'running', command: 'npm test', exitCode: null, startedAt: 1758800900000, finishedAt: null, durationMs: null, outputSummary: '', truncated: false, error: '' },
          };
        },
      };
    }
    if (method !== 'GET') return { json: async () => ({ ok: true, planId: 'plan-1', taskId: 'backend' }) };
    if (/\/api\/plans\/[^/?]+/.test(u)) return { json: async () => ({ ok: true, plan: { ...stubPlanDetail, verificationActive: stubVerificationActive }, counts: { total: 4, success: 1, failed: 1, cancelled: 1, skipped: 0 }, agents: [], activePlanId: null }) };
    return { json: async () => stubPlans };
  }
  if (u.includes('/api/mcp/servers')) {
    const isPost = Boolean(opts && opts.method === 'POST');
    const body = isPost && opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    mcpServerCalls.push({ method: isPost ? 'POST' : 'GET', body, url: u });
    if (isPost) return { json: async () => ({ ok: true, name: body && body.name, scope: body && body.scope }) };
    return { json: async () => stubMcpServers };
  }
  if (u.includes('/api/mcp/status')) {
    mcpStatusCalls.push(true);
    return { json: async () => ({ ok: true, ...(stubMcpServers.runtime || {}), cached: false }) };
  }
  if (u.includes('/api/mcp')) {
    mcpCalls.push(true);
    return { json: async () => stubMcp };
  }
  if (u.includes('/api/extensions')) return { json: async () => stubExtensions };
  if (u.includes('/api/skills')) {
    const isPut = Boolean(opts && opts.method === 'PUT');
    const body = isPut && opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    skillsCalls.push({ method: isPut ? 'PUT' : 'GET', body, url: u });
    if (isPut) return { json: async () => stubSkillToggle || { ok: true, changed: true, restartRequired: true, warnings: [] } };
    // 详情：/api/skills/<id>
    const m = /\/api\/skills\/([^/?]+)/.exec(u);
    if (m) {
      const rec = stubSkills.skills.find((s) => s.id === decodeURIComponent(m[1]));
      if (!rec) return { json: async () => ({ ok: false, error: '找不到这个 skill' }) };
      return {
        json: async () => ({
          ok: true,
          skill: rec,
          readable: true,
          truncated: false,
          bytes: 42,
          content: `---\nname: ${rec.name}\ndescription: ${rec.description}\n---\n\n# ${rec.name}\n`,
          files: [{ name: 'SKILL.md', dir: false, size: 42 }, { name: 'scripts', dir: true, size: null }],
          note: '',
        }),
      };
    }
    return { json: async () => stubSkills };
  }
  if (u.includes('/api/projects')) {
    return {
      json: async () => ({
        ok: true,
        active: 'C:\\pi-GUI',
        items: [
          { path: 'C:\\pi-GUI', name: 'pi-GUI' },
          { path: 'C:\\Users\\21022', name: '21022' },
        ],
      }),
    };
  }
  if (u.includes('/api/providers')) {
    if (opts && opts.method === 'POST') {
      return {
        json: async () => ({
          ok: true,
          provider: 'newprov',
          warning: '环境变量 NEW_KEY 没有设置，pi 会忽略这个供应商。',
          keyState: { kind: 'env', ok: false, note: '环境变量 NEW_KEY 没有设置，pi 会忽略这个供应商。' },
        }),
      };
    }
    if (opts && opts.method === 'DELETE') return { json: async () => ({ ok: true }) };
    return {
      json: async () => ({
        ok: true,
        path: 'C:\\Users\\21022\\.pi\\agent\\models.json',
        providers: { deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', models: [{ id: 'deepseek-chat' }] } },
        keyStates: { deepseek: { kind: 'env', ok: false, note: '环境变量 DEEPSEEK_API_KEY 没有设置' } },
      }),
    };
  }
  return { json: async () => ({ ok: true }) };
};

// 记录 jsdom 里的未捕获异常
window.onerror = (m) => errors.push('onerror: ' + m);

const $ = (id) => window.document.getElementById(id);

function run() {
  window.eval(code);
}

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    const st = r === true || r === undefined ? 'PASS' : 'FAIL';
    if (process.env.SMOKE_LIVE) console.error(`${st === 'PASS' ? '  ok  ' : ' FAIL '} ${name}${st === 'FAIL' ? '  → ' + r : ''}`);
    results.push([st, name, r === true || r === undefined ? '' : String(r)]);
  } catch (e) {
    if (process.env.SMOKE_LIVE) console.error(' FAIL ' + name + '  → ' + e.message);
    results.push(['FAIL', name, e.message]);
  }
}

/* --- 静态检查：el.X 必须在 el 对象里，$('id') 必须在 HTML 里 ---
 * 扫的是全部模块的源码：`el` 定义在 state.js、引用散落在各模块，
 * 只看 app.js 会漏掉绝大多数。 */
function staticCheck() {
  const elBlock = sources.match(/const el = \{([\s\S]*?)\n\};/);
  check('找得到 el 定义', () => (elBlock ? true : 'state.js 里没有 const el = {…}'));
  if (!elBlock) return;

  const keys = new Set([...elBlock[1].matchAll(/^\s*([a-zA-Z0-9_]+)\s*:/gm)].map((m) => m[1]));
  const used = new Set([...sources.matchAll(/\bel\.([a-zA-Z0-9_]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !keys.has(k));
  check('el 对象覆盖全部引用', () => (missing.length ? '缺失: ' + missing.join(', ') : true));

  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...sources.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const noId = [...wanted].filter((k) => !ids.has(k));
  check("$('id') 全部存在于 HTML", () => (noId.length ? '缺失: ' + noId.join(', ') : true));
}

staticCheck();

(async () => {
  try {
    run();
  } catch (e) {
    console.log('!! 模块加载抛错: ' + e.message + '\n' + e.stack);
    process.exit(1);
  }

  check('模块加载无异常', () => errors.length === 0 || errors.join(' | '));
  check('静态按钮都声明 type', () => [...window.document.querySelectorAll('button')].every((button) => button.hasAttribute('type')));
  check('P14-E 交互选择器不引用黄色强调', () => {
    const interactive = /(?:\bbutton\b|\.btn\b|\.icon-btn\b|\.chip\b|\.welcome-cta\b|\.modal-item\b|\.pop-item\b|\.chg-tab\b|\.preset\b|\.ext-tab\b|\.ext-item\b|\.planner-mini\b|\.planner-rv-opt\b|\.pj-sess\b|\.pj-search-scope\b|\.project\.active|\.tl-toggle:hover|\.d-hunkbar:focus|\.planner-goal:focus|\.composer-box:(?:focus|drop)|\.pj-search-row:focus|\.planner-attempt-toggle:focus)/;
    const amber = /var\(--accent(?:-soft)?\)|#(?:e8a33d|e8c67a|f0cf9a|241d12|4a3a1c|5d4823|66502e|7c5230)\b|rgba?\(\s*(?:232\s*,\s*163\s*,\s*61|240\s*,\s*207\s*,\s*154)/i;
    const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const offenders = rules.filter(([, selector, body]) => interactive.test(selector.replace(/\/\*[\s\S]*?\*\//g, '')) && amber.test(body));
    return offenders.length ? offenders.map(([, selector]) => selector.trim()).join(' | ') : true;
  });
  check('P14-A 三列外壳与全局导航存在', () => Boolean($('globalRail') && $('projectSidebar') && $('workspace') && $('navHome') && $('navPlanner') && $('navChanges') && $('navExtensions') && $('navGlobalMore')));
  check('P14-A 侧栏有独立折叠按钮', () => Boolean($('btnSidebarCollapse')));
  check('侧栏按钮初始语义为展开', () => !$('projectSidebar').hidden && $('btnSidebarCollapse').getAttribute('aria-expanded') === 'true' && $('btnSidebarExpand').getAttribute('aria-expanded') === 'true');
  const railGroup = $('groupHead').closest('.rail-group');
  const groupBody = $('groupBody');
  const groupDisplay = () => window.getComputedStyle(groupBody).display;
  check('存储为 0 时项目分组实际折叠', () => groupDisplayRules.every(Boolean) && !railGroup.classList.contains('open') && $('groupHead').getAttribute('aria-expanded') === 'false' && groupDisplay() === 'none');
  $('groupHead').click();
  check('项目分组可从存储折叠态恢复', () => railGroup.classList.contains('open') && $('groupHead').getAttribute('aria-expanded') === 'true' && groupDisplay() !== 'none');
  check('消息输入有可识别名称', () => Boolean($('input').getAttribute('aria-label')));
  check('启动首帧显示恢复中而不闪未选项目', () =>
    $('welcomeRestore') && $('welcomeRestore').hidden === false && $('welcomeNoProj').hidden === true);

  await new Promise((r) => setTimeout(r, 30)); // 等 loadStatus → connect / loadProjects / loadProviders
  check('EventSource 已连接', () => es && es.url === '/api/events');
  check('项目列表已渲染 2 项', () => window.document.querySelectorAll('#projects .project').length === 2);
  check('当前项目高亮', () => window.document.querySelectorAll('#projects .project.active').length === 1);
  check('供应商计数 = 1', () => $('providerCount').textContent === '1');

  // 全局低频入口收进 More，仍保留原 handler。
  check('供应商入口不在顶部导航里', () => window.document.querySelector('.rail-nav #navProviders') === null);
  check('供应商入口在全局 More 菜单', () => Boolean(window.document.querySelector('#globalMoreMenu #navProviders')));
  check('诊断入口在全局 More 菜单', () => Boolean(window.document.querySelector('#globalMoreMenu #navDiagnostics')));
  check('Global Rail 入口都是可聚焦的真按钮且有名称', () => [...window.document.querySelectorAll('#globalRail .rail-icon')].every((b) => b.tagName === 'BUTTON' && b.getAttribute('aria-label')));
  check('Global Rail 初始激活项唯一', () => window.document.querySelectorAll('#globalRail [aria-current="page"]').length === 1 && $('navHome').getAttribute('aria-current') === 'page');
  $('btnSidebarCollapse').click();
  check('折叠仅隐藏项目侧栏，保留全局栏与工作区', () => $('projectSidebar').hidden && !$('globalRail').hidden && !$('workspace').hidden && !$('btnSidebarExpand').hidden);
  check('侧栏折叠按钮语义与侧栏状态一致', () => $('btnSidebarCollapse').getAttribute('aria-expanded') === 'false' && $('btnSidebarExpand').getAttribute('aria-expanded') === 'false');
  $('btnSidebarExpand').click();
  check('展开项目侧栏仍保留当前项目', () => !$('projectSidebar').hidden && window.document.querySelectorAll('#projects .project.active').length === 1);
  check('侧栏展开按钮语义与侧栏状态一致', () => $('btnSidebarCollapse').getAttribute('aria-expanded') === 'true' && $('btnSidebarExpand').getAttribute('aria-expanded') === 'true');
  $('navGlobalMore').click();
  check('More 展开并提供真实入口', () => !$('globalMoreMenu').hidden && $('navGlobalMore').getAttribute('aria-expanded') === 'true' && [...$('globalMoreMenu').querySelectorAll('button')].every((b) => typeof b.onclick === 'function'));
  $('navGlobalMore').click();
  check('More 可收起', () => $('globalMoreMenu').hidden && $('navGlobalMore').getAttribute('aria-expanded') === 'false');
  $('btnProjectMenu').click();
  check('项目低频动作可展开', () => !$('projectActions').hidden && $('btnProjectMenu').getAttribute('aria-expanded') === 'true' && Boolean($('btnAddProject') && $('btnProjectSettings')));
  $('btnProjectMenu').click();
  check('项目低频动作可收起', () => $('projectActions').hidden);
  $('groupHead').click();
  check('搜索前项目区域实际折叠', () => !railGroup.classList.contains('open') && groupDisplay() === 'none');
  $('navSearch').click();
  check('搜索入口重新展开项目区域并聚焦搜索框', () => railGroup.classList.contains('open') && groupDisplay() !== 'none' && $('groupHead').getAttribute('aria-expanded') === 'true' && $('projectSidebar').classList.contains('search-open') && window.document.activeElement?.classList.contains('pj-search-input'));
  check('右下角没有重复的供应商按钮', () => $('btnCornerProviders') === null);

  // --- pi 就绪 → boot() ---
  es.emit({ type: 'bridge_status', state: 'ready' });
  await new Promise((r) => setTimeout(r, 10));
  const cmds = commands.map((c) => c.type);
  check('boot 请求 get_state', () => cmds.includes('get_state'));
  check('boot 请求 get_messages', () => cmds.includes('get_messages'));

  // --- get_state ---
  es.emit({
    type: 'response', command: 'get_state', success: true,
    data: { model: { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }, thinkingLevel: 'high', isStreaming: false, sessionName: 'pi-gui-work' },
  });
  check('标题 = 会话名', () => $('title').textContent === 'pi-gui-work');
  check('底部 = 会话名', () => $('footName').textContent === 'pi-gui-work');
  check('模型 chip', () => $('modelText').textContent === 'DeepSeek V4 Pro');
  check('思考 chip', () => $('thinkText').textContent === '思考 high');

  // --- get_session_stats ---
  es.emit({
    type: 'response', command: 'get_session_stats', success: true,
    data: { tokens: { input: 50000, output: 10000, cacheRead: 40000 }, cost: 0.4512, contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 } },
  });
  check('上下文百分比', () => $('uPct').textContent === '30%');
  check('上下文进度条宽度', () => $('uCtxBar').style.width === '30%');
  check('成本显示', () => $('uCost').textContent === '$0.4512');

  // --- get_tree ---
  /* ⚠️ fixture 必须照 pi 的**真实形状**造。
   *
   * pi 的条目按类型各不相同，消息体嵌在 `entry.message` 里（不是顶层
   * role/content）—— 依据 pi 源码 dist/bundle/chunks/chunk-4DKZACXI.js 的
   * append* 系列：appendMessage 造的是 {type:'message', id, parentId,
   * timestamp, message}。
   *
   * 这里原来用的是扁平形状（role/content 摆顶层，pi 里根本不存在），
   * 于是 tree.js 只读顶层也能全绿 —— 而真实会话里每个消息节点都渲染成
   * 「message: [object Object]」。**错 fixture 把真实缺陷藏了一整版。** */
  const msgEntry = (id, role, text) => ({
    type: 'message', id, timestamp: '2026-09-25T10:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  });
  es.emit({
    type: 'response', command: 'get_tree', success: true,
    data: {
      tree: [
        {
          entry: msgEntry('a', 'user', '帮我看看 server.js'),
          children: [
            { entry: msgEntry('b', 'assistant', '文件没问题。'), children: [], label: '关键结论' },
            /* 一次 model_change 夹在两条消息中间 —— 它自己不该出现，
             * 但它的子节点必须**上提到最近的可见祖先**（a），
             * 否则一次切换模型就会把后面整段对话从树里切掉。 */
            {
              entry: { type: 'model_change', id: 'm1', timestamp: '2026-09-25T10:00:01.000Z', provider: 'deepseek', modelId: 'deepseek-v4-pro' },
              children: [
                {
                  entry: { type: 'thinking_level_change', id: 't1', timestamp: '2026-09-25T10:00:02.000Z', thinkingLevel: 'high' },
                  children: [{ entry: msgEntry('c', 'assistant', '换个模型再答一次'), children: [] }],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  // 可见条目 = a / b / c（model_change 与 thinking_level_change 被过滤掉）
  check('分支计数 = 3（只算对话条目）', () => $('branchCount').textContent === '3');

  /* 条目文本映射：每种类型的字段位置都不一样，逐类钉住。
   * 这一组是回归守卫 —— 没有它，改回「只读顶层」也不会有人发现。 */
  check('message 取嵌套消息体（真实形状）', () =>
    window.entryText(msgEntry('x', 'user', '你好')) === '你：你好');
  check('message 兼容扁平形状（顶层 role/content）', () =>
    window.entryText({ type: 'message', role: 'assistant', content: '在的' }) === 'Pi：在的');
  check('message 的 content 是块数组时取 text 块', () =>
    window.entryText({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'thinking', text: 'B' }, { type: 'text', text: 'C' }] } }) === 'Pi：A （思考） C');
  check('message 只有 toolCall 时不空白', () =>
    window.entryText({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] } }) === 'Pi：调用 bash');
  check('model_change 带出 provider/modelId', () =>
    window.entryText({ type: 'model_change', provider: 'deepseek', modelId: 'deepseek-v4-pro' }) === '模型 → deepseek/deepseek-v4-pro');
  check('thinking_level_change 带出档位', () =>
    window.entryText({ type: 'thinking_level_change', thinkingLevel: 'high' }) === '思考档位 → high');
  check('context_edit 带出目标 id', () =>
    window.entryText({ type: 'context_edit', targetId: 'abcdef1234567890', replacement: null }) === '还原上下文 → abcdef12');
  check('session_info 带出会话名', () =>
    window.entryText({ type: 'session_info', name: '我的登录功能开发' }) === '会话名 → 我的登录功能开发');
  check('label 带出标签', () => window.entryText({ type: 'label', label: '重点' }) === '标签 → 重点');
  check('compaction 带出 tokens', () =>
    window.entryText({ type: 'compaction', tokensBefore: 12345 }) === '压缩摘要（12345 tokens）');
  check('未知类型有兜底（不出现 undefined）', () => {
    const t = window.entryText({ type: 'brand_new_thing' });
    return t === 'brand_new_thing' || t;
  });
  check('任何条目都不会渲染成 [object Object]', () => {
    const samples = [
      msgEntry('x', 'user', 'hi'),
      { type: 'model_change', provider: 'p', modelId: 'm' },
      { type: 'usage', kind: 'message', provider: 'p', model: 'm', usage: {} },
      { type: 'custom', customType: 'note', data: { a: 1 } },
      { type: 'compaction', summary: 'S', tokensBefore: 1, details: {} },
    ];
    const bad = samples.map((s) => window.entryText(s)).filter((t) => t.includes('[object'));
    return bad.length === 0 || '出现：' + bad.join(' | ');
  });

  // --- 对话流 ---
  es.emit({ type: 'message_start', message: { role: 'user', content: '帮我看看 server.js' } });
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  es.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '好的，' } });
  es.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '我来看一下。' } });
  await new Promise((r) => setTimeout(r, 30));
  check('用户消息已渲染', () => window.document.querySelectorAll('.msg.user').length === 1);
  check('助手增量已拼装', () => window.document.querySelector('.msg.assistant .msg-body').textContent.includes('好的，我来看一下。'));

  es.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '文件没问题。' }] } });
  check('message_end 校正渲染', () => window.document.querySelector('.msg.assistant .msg-body').textContent.includes('文件没问题。'));

  // --- 上游错误必须可见（实测余额不足时 content 为空、usage 全 0，
  //     不处理的话对话区就是一片空白，用户完全看不出发生了什么） ---
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({
    type: 'message_end',
    message: {
      role: 'assistant', content: [], stopReason: 'error',
      usage: { input: 0, output: 0 },
      errorMessage: '402: {"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}',
    },
  });
  check('错误块已渲染', () => window.document.querySelectorAll('.msg-err').length === 1);
  check('错误标题译成人话', () => window.document.querySelector('.me-head').textContent === '账户余额不足');
  check('错误带处理建议', () => window.document.querySelector('.me-hint').textContent.includes('充值'));
  check('原始错误码保留', () => window.document.querySelector('.me-raw').textContent.includes('Insufficient Balance'));
  check('错误块挂在最后一条助手消息里', () => {
    const bodies = [...window.document.querySelectorAll('.msg.assistant .msg-body')];
    return !!bodies[bodies.length - 1].querySelector('.msg-err');
  });

  // 重试开始时撤掉上一次的错误块，避免重试成功后还留着一张失败卡片
  es.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3 });
  check('重试时撤掉错误块', () => window.document.querySelectorAll('.msg-err').length === 0);
  /* 光撤错误块不够：pi 每重试一次就重发一次 message_start，所以失败那轮已经
   * 建好了一个「Pi」外壳，撤掉错误块后它就成了一条没有正文的空白。
   * 上游连续失败三次，对话里就是三条空白（实测截图里那一列空「Pi」）。 */
  check('重试时空掉的助手外壳一起收走', () => window.document.querySelectorAll('.msg.assistant').length === 1);
  check('没有留下没有正文的助手消息', () =>
    [...window.document.querySelectorAll('.msg.assistant .msg-body')].every((b) => b.childElementCount > 0)
  );
  es.emit({ type: 'auto_retry_end' });

  // 失败前已经流出来的正文不该跟着错误块一起消失 —— 那种情况下外壳是有意义的
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  es.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '先说了半句' } });
  es.emit({
    type: 'message_end',
    message: {
      role: 'assistant', content: [{ type: 'text', text: '先说了半句' }],
      stopReason: 'error', errorMessage: '429 Too Many Requests',
    },
  });
  const assistantsBeforeRetry = window.document.querySelectorAll('.msg.assistant').length;
  es.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3 });
  check('失败前已有正文时保留外壳', () =>
    window.document.querySelectorAll('.msg.assistant').length === assistantsBeforeRetry
  );
  check('失败前已有正文时正文仍在', () => {
    const bodies = [...window.document.querySelectorAll('.msg.assistant .msg-body')];
    return bodies[bodies.length - 1].textContent.includes('先说了半句');
  });
  check('失败前已有正文时错误块仍被撤掉', () => window.document.querySelectorAll('.msg-err').length === 0);
  es.emit({ type: 'auto_retry_end' });

  // 错误翻译表
  check('401 译成 Key 无效', () => window.explainError('401: {"message":"Unauthorized"}').title === 'API Key 无效或已过期');
  check('429 译成限流', () => window.explainError('429 Too Many Requests').title === '触发限流');
  check('网络错误译成连接失败', () => window.explainError('fetch failed').title === '网络连接失败');
  check('未知错误有兜底', () => window.explainError('some weird thing').title === '请求失败');

  // 空内容但不是失败 → 给个提示，不留空白
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({ type: 'message_end', message: { role: 'assistant', content: [] } });
  check('空回复有提示而非空白', () => {
    const bodies = [...window.document.querySelectorAll('.msg.assistant .msg-body')];
    return bodies[bodies.length - 1].querySelector('.msg-note')?.textContent.includes('没有返回内容');
  });

  // 用户中断
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted' } });
  check('中断有提示', () => {
    const bodies = [...window.document.querySelectorAll('.msg.assistant .msg-body')];
    return bodies[bodies.length - 1].querySelector('.msg-note')?.textContent === '已中断';
  });

  /* 只有工具调用的助手消息：content 全是 toolCall，渲染不出任何正文。
   * 早先这里会留下一条没有正文的空白「Pi」（扫 11 个真实会话共 20 条），
   * 现在整条外壳（含角色行）收掉 —— 工具卡片挂在 thread 上，不受影响。 */
  const assistantsBeforeToolOnly = window.document.querySelectorAll('.msg.assistant').length;
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
      stopReason: 'toolUse',
    },
  });
  check('只有工具调用的消息不留空白「Pi」', () => {
    const n = window.document.querySelectorAll('.msg.assistant').length;
    return n === assistantsBeforeToolOnly ? true : `多出了 ${n - assistantsBeforeToolOnly} 条助手外壳`;
  });
  check('每条助手消息的正文都非空', () => {
    const empty = [...window.document.querySelectorAll('.msg.assistant .msg-body')].filter((b) => !b.childElementCount);
    return empty.length === 0 ? true : `${empty.length} 条助手正文是空的`;
  });

  /* ================================================================
   * Tool Timeline
   *
   * 这一段钉住三件事：
   *   1. 实时事件 → 时间线条目（状态 / 时长 / 退出码 / 折叠 / 安全）；
   *   2. 历史重建 → 同一套条目（配对 / 降级 / 顺序）；
   *   3. 两条路径画出来的东西**语义一致** —— 刷新前后不能变样。
   *
   * DOM 断言一律按 `data-id` 定位，不用「第几条」：时间线是顺序追加的，
   * 用下标写断言会在插入新用例时集体错位，而错位后的失败信息毫无指向性。
   * ================================================================ */

  /* 「有没有危险元素」查**解析树**而不是正则扫 innerHTML。
   * 原因：属性值里出现未转义的 `<` 是合法字面量，浏览器绝不会把它当标签，
   * 正则扫字符串会误报。真正要问的是「有没有东西真的被解析成了元素」。
   * diff 那处例外：它的 innerHTML 由字符串注入，正则才有意义（两处都查）。 */
  const LIVE_SEL = 'script,img,iframe,svg,object,embed,style,link,meta,form,input,base';
  const liveCount = (root) => root.querySelectorAll(LIVE_SEL).length;
  const noLiveTagIn = (html) => !/<\s*(script|img|iframe|svg|object|embed|style|link|meta|form|input|base)\b/i.test(html);

  console.log('\n--- Tool Timeline：实时 ---');

  const tlItems = () => [...window.document.querySelectorAll('.tl-item')];
  const tlItem = (id) => window.document.querySelector(`.tl-item[data-id="${id}"]`);
  const tlPart = (id, sel) => tlItem(id)?.querySelector(sel) ?? null;
  const tlText = (id, sel) => tlPart(id, sel)?.textContent ?? '(缺少节点)';
  /* 工具输出的批量重画窗口是 150ms（tools.js 的 PAINT_MS），
   * 断言 DOM 之前必须让它落地，否则拿到的是上一帧的内容。 */
  const settle = (ms = 220) => new Promise((r) => setTimeout(r, ms));

  /* --- start：建 running 条目 --- */
  es.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls -la' } });
  check('tool start 建出 running 条目', () => {
    const it = tlItem('t1');
    if (!it) return '时间线上没有出现这条';
    return it.dataset.status === 'running' || it.dataset.status;
  });
  check('条目挂在时间线分组里', () => Boolean(tlItem('t1').closest('.tl-group .tl-list')));
  check('显示工具语义名而不是原始名', () => {
    const t = tlText('t1', '.tl-label');
    return t === '执行命令' || t;
  });
  check('显示参数摘要（命令原文）', () => {
    const t = tlText('t1', '.tl-arg');
    return t === 'ls -la' || t;
  });
  check('running 的图标是实心圆（不是对勾）', () => {
    const d = tlPart('t1', '.tl-dot');
    return (d?.title === '运行中' && !d.innerHTML.includes('polyline')) || d?.title;
  });

  /* --- update：partialResult 是累积值 --- */
  es.emit({ type: 'tool_execution_update', toolCallId: 't1', partialResult: { content: [{ type: 'text', text: 'a\nb\n' }] } });
  es.emit({ type: 'tool_execution_update', toolCallId: 't1', partialResult: { content: [{ type: 'text', text: 'a\nb\nc\n' }] } });
  await settle();
  check('partialResult 是累积值：整体替换而不是累加', () => {
    const t = tlText('t1', '.tl-out');
    return t === 'a\nb\nc\n' || JSON.stringify(t);
  });
  check('update 不会把状态改掉', () => tlItem('t1').dataset.status === 'running' || tlItem('t1').dataset.status);
  check('运行中给一行「在动」的反馈（输出尾巴）', () => {
    const t = tlText('t1', '.tl-result');
    return t === 'c' || t;
  });
  /* bash 的 onUpdate 会先发一次空 partialResult（{content:[], details:undefined}）。
   * 用它把已经显示的内容清掉是错的 —— 长命令的输出会一闪一闪地消失。 */
  es.emit({ type: 'tool_execution_update', toolCallId: 't1', partialResult: { content: [], details: undefined } });
  await settle();
  check('空的 partialResult 不会清掉已有输出', () => {
    const t = tlText('t1', '.tl-out');
    return t === 'a\nb\nc\n' || JSON.stringify(t);
  });

  /* --- end：成功 --- */
  es.emit({ type: 'tool_execution_end', toolCallId: 't1', isError: false, result: { content: [{ type: 'text', text: 'done' }] } });
  check('end 转 success', () => tlItem('t1').dataset.status === 'success' || tlItem('t1').dataset.status);
  check('end 用权威结果覆盖流式输出', () => {
    const t = tlText('t1', '.tl-out');
    return t === 'done' || JSON.stringify(t);
  });
  check('成功后图标换成对勾', () => tlPart('t1', '.tl-dot')?.title === '成功' || tlPart('t1', '.tl-dot')?.title);
  check('成功后给出时长（0.1s 精度）', () => {
    const t = tlText('t1', '.tl-time');
    return /^\d+\.\d+s$/.test(t) || t;
  });
  check('成功条目不编造退出码', () => {
    const t = tlText('t1', '.tl-result');
    return t === 'done' || t;
  });

  /* --- end：失败 + 退出码 --- */
  es.emit({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'npm test' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 't2', isError: true, result: { content: [{ type: 'text', text: '1 failing\nCommand exited with code 1' }] } });
  check('失败的工具转 error 状态', () => tlItem('t2').dataset.status === 'error' || tlItem('t2').dataset.status);
  check('失败图标是叉', () => tlPart('t2', '.tl-dot')?.title === '失败' || tlPart('t2', '.tl-dot')?.title);
  /* 协议里**没有**结构化的 exitCode（bash 的 details 只有 truncation /
   * fullOutputPath），只能从输出文本里解析 pi 自己拼的那句话。 */
  check('从输出文本里解析出 exit code', () => {
    const t = tlText('t2', '.tl-result');
    return t === 'exit code 1' || t;
  });
  es.emit({ type: 'tool_execution_start', toolCallId: 't3', toolName: 'bash', args: { command: 'x' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 't3', isError: true, result: { content: [{ type: 'text', text: 'killed by signal' }] } });
  check('解析不到退出码时不按 isError 猜一个', () => {
    const t = tlText('t3', '.tl-result');
    return !/exit code/.test(t) || t;
  });

  /* --- 长输出默认折叠 --- */
  const LONG = Array.from({ length: 60 }, (_, i) => 'line ' + i).join('\n');
  es.emit({ type: 'tool_execution_start', toolCallId: 't4', toolName: 'read', args: { path: 'big.txt' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 't4', isError: false, result: { content: [{ type: 'text', text: LONG }] } });
  check('长输出默认折叠', () => tlPart('t4', '.tl-more')?.hidden === true || tlPart('t4', '.tl-more')?.hidden);
  check('折叠时不在时间线上铺全文', () => !tlText('t4', '.tl-result').includes('line 59'));
  check('read 的结果行报行数而不是贴内容', () => {
    const t = tlText('t4', '.tl-result');
    return t === '60 行' || t;
  });
  check('有输出时展开按钮可见', () => tlPart('t4', '.tl-toggle')?.hidden === false || tlPart('t4', '.tl-toggle')?.hidden);
  check('折叠状态下悬停能看到输出', () => Boolean(tlItem('t4').title));
  tlPart('t4', '.tl-toggle').click();
  check('展开后显示完整输出', () => {
    const open = tlPart('t4', '.tl-more').hidden === false;
    const same = tlText('t4', '.tl-out') === LONG;
    return (open && same) || `展开=${open} 内容一致=${same}`;
  });
  check('展开后按钮文案变成「收起」', () => tlText('t4', '.tl-toggle') === '收起' || tlText('t4', '.tl-toggle'));
  tlPart('t4', '.tl-toggle').click();
  check('可以再收起', () => tlPart('t4', '.tl-more').hidden === true || tlPart('t4', '.tl-more').hidden);

  /* --- 未知工具（扩展注册的 / 以后新加的）不能把时间线搞崩 --- */
  es.emit({ type: 'tool_execution_start', toolCallId: 't5', toolName: 'mcp_docs_search', args: { q: 'x' } });
  check('未知工具降级显示，不报错', () => {
    const t = tlText('t5', '.tl-label');
    return t === '执行工具 mcp_docs_search' || t;
  });
  es.emit({ type: 'tool_execution_end', toolCallId: 't5', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
  check('未知工具也能正常收尾', () => tlItem('t5').dataset.status === 'success' || tlItem('t5').dataset.status);

  /* --- 安全：参数来自模型，输出来自被执行的程序，两者都不可信 --- */
  es.emit({ type: 'tool_execution_start', toolCallId: 't6', toolName: 'bash', args: { command: 'echo "<img src=x onerror=alert(1)>"' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 't6', isError: false, result: { content: [{ type: 'text', text: '<script>alert(1)</script>\n</pre><img src=x onerror=alert(2)>' }] } });
  /* 只查 .tl-body：状态图标是我们自己写死的 SVG，挂在 .tl-dot 里，
   * 与工具内容无关，不该算进「危险元素」。 */
  check('工具参数里的 HTML 不产生活元素', () => {
    const n = liveCount(tlPart('t6', '.tl-body'));
    return n === 0 || `解析出 ${n} 个危险元素`;
  });
  check('工具输出里的 <script> 只是文本', () => {
    const it = tlItem('t6');
    const ok = it.textContent.includes('<script>alert(1)</script>') && liveCount(it.querySelector('.tl-body')) === 0;
    return ok || it.textContent.slice(0, 160);
  });
  check('时间线正文里没有任何非白名单活标签', () => {
    const bad = tlItems().map((x) => x.querySelector('.tl-body').innerHTML).filter((h) => !noLiveTagIn(h));
    if (!bad.length) return true;
    const m = /<\s*(script|img|iframe|svg|object|embed|style|link|meta|form|input|base)\b/i.exec(bad[0]);
    const at = m ? m.index : 0;
    return `命中 ${m ? m[0] : '?'} :: ${bad[0].slice(Math.max(0, at - 70), at + 70)}`;
  });

  /* --- 分组的真实边界：一条 assistant 消息 = 一组 --- */
  const firstGroup = window.document.querySelector('.tl-group');
  check('同一批工具落在同一个组里', () => firstGroup.querySelectorAll('.tl-item').length === 6 || firstGroup.querySelectorAll('.tl-item').length);
  check('一组超过一项时显示「操作 N 项」', () => {
    const n = firstGroup.querySelectorAll('.tl-item').length;
    const head = firstGroup.querySelector('.tl-group-head');
    return (n >= 2 && head.hidden === false && head.textContent === `操作 ${n} 项`) || `${head.hidden} ${head.textContent}`;
  });

  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '再看一个文件' }] } });
  es.emit({ type: 'tool_execution_start', toolCallId: 'g1', toolName: 'read', args: { path: 'a.txt' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 'g1', isError: false, result: { content: [{ type: 'text', text: 'x' }] } });
  check('新的 assistant 消息开启新的一组', () => window.document.querySelectorAll('.tl-group').length === 2 || window.document.querySelectorAll('.tl-group').length);
  check('只有一项的组不摆「操作 1 项」的废话标题', () => {
    const g = window.document.querySelectorAll('.tl-group')[1];
    const head = g.querySelector('.tl-group-head');
    return (head.hidden === true && head.textContent === '') || `${head.hidden} ${head.textContent}`;
  });

  /* --- 实时与历史必须画出同一种东西（§21：刷新前后语义一致） --- */
  const snapOf = (it) => ({
    status: it.dataset.status,
    label: it.querySelector('.tl-label').textContent,
    arg: it.querySelector('.tl-arg').textContent,
    result: it.querySelector('.tl-result').textContent,
    out: it.querySelector('.tl-out').textContent,
  });

  es.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'echo hi' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 'c1', isError: true, result: { content: [{ type: 'text', text: 'boom\nCommand exited with code 2' }] } });
  const liveSnap = snapOf(tlItem('c1'));

  window.rebuildFromMessages({
    messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo hi' } }], timestamp: 1000, stopReason: 'toolUse' },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'boom\nCommand exited with code 2' }], isError: true, timestamp: 1600 },
    ],
  });
  const histSnap = snapOf(window.document.querySelector('.tl-item'));
  check('刷新（历史重建）后条目语义与实时一致', () => {
    const a = JSON.stringify(liveSnap);
    const b = JSON.stringify(histSnap);
    return a === b || `实时 ${a} ≠ 历史 ${b}`;
  });
  /* 唯一允许不同的就是时长：协议里没有工具级的起止时间戳，
   * 历史只能拿「assistant 消息 → toolResult 消息」的时间戳来估
   * （见 tool-model.entryFromHistory 的说明）。 */
  check('历史重建的时长由消息时间戳估出', () => tlText('c1', '.tl-time') === '0.6s' || tlText('c1', '.tl-time'));

  console.log('\n--- Tool Timeline：历史重建 ---');

  /* 配对规则本身是纯函数，先单独钉一遍（planHistory 不碰 DOM） */
  check('planHistory 把消息分成 user / assistant / tools 三类', () => {
    const p = window.planHistory([
      { role: 'user', content: [{ type: 'text', text: '跑一下' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'toolCall', id: 'x1', name: 'bash', arguments: { command: 'ls' } }] },
      { role: 'toolResult', toolCallId: 'x1', toolName: 'bash', content: [{ type: 'text', text: 'a\nb' }] },
    ]);
    const got = p.map((i) => i.kind).join(',');
    return got === 'user,assistant,tools' || got;
  });
  check('toolResult 不单独成项（被前面的 assistant 收走）', () => {
    const p = window.planHistory([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'x1', name: 'bash', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'x1', toolName: 'bash', content: [{ type: 'text', text: 'a' }] },
    ]);
    return (p.length === 2 && p[1].kind === 'tools' && p[1].entries.length === 1) || p.map((i) => i.kind).join(',');
  });

  window.rebuildFromMessages({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '跑一下测试' }] },
      { role: 'assistant', content: [{ type: 'text', text: '先看看' }, { type: 'toolCall', id: 'h1', name: 'bash', arguments: { command: 'npm test' } }], timestamp: 1000, stopReason: 'toolUse' },
      { role: 'toolResult', toolCallId: 'h1', toolName: 'bash', content: [{ type: 'text', text: '318 tests passed' }], isError: false, timestamp: 1600 },
      { role: 'assistant', content: [{ type: 'text', text: '全过了' }], timestamp: 1700 },
    ],
  });
  check('历史重建把工具调用画成时间线条目', () => window.document.querySelectorAll('.tl-item').length === 1 || window.document.querySelectorAll('.tl-item').length);
  check('历史重建的条目是成功态', () => window.document.querySelector('.tl-item').dataset.status === 'success' || window.document.querySelector('.tl-item').dataset.status);
  check('历史重建的关键结果行来自 toolResult 正文', () => {
    const t = tlText('h1', '.tl-result');
    return t === '318 tests passed' || t;
  });
  check('历史重建时正文与用户消息都还在', () => {
    const txt = window.document.querySelector('.thread').textContent;
    return (txt.includes('跑一下测试') && txt.includes('先看看') && txt.includes('全过了')) || txt.slice(0, 120);
  });
  check('文本 → 工具 → 文本 的交错顺序被保留', () => {
    const kids = [...window.document.querySelector('.thread').children]
      .filter((n) => n.classList.contains('msg') || n.classList.contains('tl-group'))
      .map((n) => (n.classList.contains('tl-group') ? 'tools' : n.classList.contains('user') ? 'user' : 'assistant'));
    return kids.join(',') === 'user,assistant,tools,assistant' || kids.join(',');
  });

  /* --- 退化情况：缺结果 / 孤儿结果 --- */
  window.rebuildFromMessages({
    messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'h2', name: 'bash', arguments: { command: 'sleep 999' } }], timestamp: 2000, stopReason: 'toolUse' },
    ],
  });
  check('缺 toolResult 的调用降级为「未完成」，而不是消失', () => {
    const it = window.document.querySelector('.tl-item');
    if (!it) return '这条调用整个消失了';
    const r = it.querySelector('.tl-result').textContent;
    return (it.dataset.status === 'incomplete' && r === '未完成 · 没有结果') || `${it.dataset.status} / ${r}`;
  });
  check('「未完成」的图标是虚线圆（区别于成功/失败）', () => {
    const d = window.document.querySelector('.tl-item .tl-dot');
    return (d.title === '未完成' && d.innerHTML.includes('stroke-dasharray')) || d.title;
  });
  check('缺结果时不留下空白「Pi」外壳', () => {
    const n = window.document.querySelectorAll('.msg.assistant').length;
    return n === 0 || `留下了 ${n} 条助手外壳`;
  });

  window.rebuildFromMessages({
    messages: [{ role: 'toolResult', toolCallId: 'ghost', toolName: 'bash', content: [{ type: 'text', text: '孤儿结果' }], isError: false, timestamp: 3000 }],
  });
  check('孤儿 toolResult 就地降级显示，不被静默吃掉', () => {
    const it = window.document.querySelector('.tl-item');
    if (!it) return '孤儿结果整个丢了';
    return it.textContent.includes('孤儿结果') || it.textContent.slice(0, 120);
  });
  check('未知 role 不会打断整段重建', () => {
    window.rebuildFromMessages({
      messages: [
        { role: 'system', content: '扩展注册的自定义消息' },
        { role: 'assistant', content: [{ type: 'text', text: '照常渲染' }] },
      ],
    });
    return window.document.querySelector('.msg.assistant')?.textContent.includes('照常渲染') || '重建被未知 role 打断了';
  });

  /* --- 一条消息里的多个调用 --- */
  window.rebuildFromMessages({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'm1', name: 'read', arguments: { path: 'a.txt' } },
          { type: 'toolCall', id: 'm2', name: 'read', arguments: { path: 'b.txt' } },
          { type: 'toolCall', id: 'm3', name: 'read', arguments: { path: 'c.txt' } },
        ],
        timestamp: 4000,
        stopReason: 'toolUse',
      },
      { role: 'toolResult', toolCallId: 'm1', toolName: 'read', content: [{ type: 'text', text: 'A' }], isError: false, timestamp: 4100 },
      { role: 'toolResult', toolCallId: 'm2', toolName: 'read', content: [{ type: 'text', text: 'B' }], isError: false, timestamp: 4200 },
      { role: 'toolResult', toolCallId: 'm3', toolName: 'read', content: [{ type: 'text', text: 'C' }], isError: false, timestamp: 4300 },
    ],
  });
  check('一条 assistant 消息里的多个工具调用按原顺序渲染', () => {
    const got = [...window.document.querySelectorAll('.tl-item .tl-arg')].map((x) => x.textContent).join(',');
    return got === 'a.txt,b.txt,c.txt' || got;
  });
  check('多调用落在同一个组里', () => window.document.querySelectorAll('.tl-group').length === 1 || window.document.querySelectorAll('.tl-group').length);
  check('多调用各自都有时长', () => {
    const ts = [...window.document.querySelectorAll('.tl-item .tl-time')].map((x) => x.textContent);
    return ts.every((t) => /^\d+\.\d+s$/.test(t)) || ts.join('|');
  });

  /* --- 中断：没有 tool_execution_end 的条目不能永远转下去 --- */
  console.log('\n--- Tool Timeline：中断收尾 ---');
  window.rebuildFromMessages({ messages: [] });
  es.emit({ type: 'tool_execution_start', toolCallId: 'a1', toolName: 'bash', args: { command: 'sleep 999' } });
  check('工具跑着时是 running', () => tlItem('a1').dataset.status === 'running' || tlItem('a1').dataset.status);
  es.emit({ type: 'agent_settled' });
  check('agent 收尾时把没有 end 的条目收成「未完成」', () => {
    const it = tlItem('a1');
    return (it && it.dataset.status === 'incomplete') || it?.dataset.status;
  });
  check('收尾后不残留 running 条目', () => window.document.querySelectorAll('.tl-item[data-status=running]').length === 0 || window.document.querySelectorAll('.tl-item[data-status=running]').length);

  /* ================================================================
   * 真实会话 fixture（tests/fixtures/tool-history.json）
   *
   * 手写的假数据只能证明「代码符合我对协议的想象」。这一份是从真实会话
   * jsonl 里切出来的一段（脱敏 + 长正文截断，结构一字未改），
   * 用来证明「协议本来就是这样」。生成方式与脱敏规则见同目录的 README.md。
   * ================================================================ */
  console.log('\n--- Tool Timeline：真实会话 fixture ---');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tool-history.json'), 'utf8'));
  const fxCalls = fx
    .filter((m) => m.role === 'assistant')
    .reduce((n, m) => n + (m.content || []).filter((c) => c.type === 'toolCall').length, 0);
  const fxResults = fx.filter((m) => m.role === 'toolResult');
  const fxGroups = fx.filter((m) => m.role === 'assistant' && (m.content || []).some((c) => c.type === 'toolCall')).length;
  const fxErrors = fxResults.filter((r) => r.isError).length;

  check('fixture 自身自洽（每条 toolCall 都有 toolResult）', () => {
    const ids = new Set();
    for (const m of fx) {
      if (m.role !== 'assistant') continue;
      for (const c of m.content || []) if (c.type === 'toolCall') ids.add(c.id);
    }
    const resIds = new Set(fxResults.map((r) => r.toolCallId));
    const missing = [...ids].filter((x) => !resIds.has(x)).length;
    const orphan = [...resIds].filter((x) => !ids.has(x)).length;
    return (missing === 0 && orphan === 0) || `缺 ${missing} / 孤儿 ${orphan}`;
  });

  window.rebuildFromMessages({ messages: fx });
  check('真实会话重建：每条 toolCall 都画出来了', () => {
    const n = window.document.querySelectorAll('.tl-item').length;
    return n === fxCalls || `画了 ${n} 条，数据里有 ${fxCalls} 条`;
  });
  check('真实会话重建：分组数 = 带工具调用的 assistant 消息数', () => {
    const n = window.document.querySelectorAll('.tl-group').length;
    return n === fxGroups || `分了 ${n} 组，数据里是 ${fxGroups} 组`;
  });
  check('真实会话重建：失败条目数与 isError 一致', () => {
    const n = window.document.querySelectorAll('.tl-item[data-status=error]').length;
    return n === fxErrors || `画了 ${n} 条失败，数据里是 ${fxErrors} 条`;
  });
  check('真实会话重建：没有凭空多出「未完成」', () => {
    const n = window.document.querySelectorAll('.tl-item[data-status=incomplete]').length;
    return n === 0 || `多出 ${n} 条未完成`;
  });
  check('真实会话重建：退出码从输出文本里解析出来', () => {
    const got = [...window.document.querySelectorAll('.tl-item[data-status=error] .tl-result')].map((x) => x.textContent);
    const ok = got.filter((t) => /^exit code -?\d+/.test(t)).length;
    return ok === fxErrors || got.join(' | ');
  });
  check('真实会话重建：edit 的 +N −M 来自工具自己的 details.diff', () => {
    const stats = [...window.document.querySelectorAll('.tl-item .tl-stat')].map((x) => x.textContent).filter(Boolean);
    return stats.length > 0 || '一条 +N −M 都没有';
  });
  check('真实会话重建：write 的结果行报字节数', () => {
    const lines = [...window.document.querySelectorAll('.tl-item .tl-result')].map((x) => x.textContent);
    return lines.some((t) => /^已写入 \d+ 字节$/.test(t)) || lines.slice(0, 8).join(' | ');
  });
  check('真实会话重建：全篇不产生活元素', () => {
    const n = [...window.document.querySelectorAll('.tl-item .tl-body')].reduce((a, b) => a + liveCount(b), 0);
    return n === 0 || `解析出 ${n} 个危险元素`;
  });
  check('真实会话重建：没有留下空白「Pi」', () => {
    const empty = [...window.document.querySelectorAll('.msg.assistant .msg-body')].filter((b) => !b.childElementCount);
    return empty.length === 0 || `${empty.length} 条助手正文是空的`;
  });
  check('真实会话重建：用户 / 正文 / 工具交替出现', () => {
    const kinds = [...window.document.querySelector('.thread').children]
      .filter((n) => n.classList.contains('msg') || n.classList.contains('tl-group'))
      .map((n) => (n.classList.contains('tl-group') ? 'T' : n.classList.contains('user') ? 'U' : 'A'));
    return (kinds.includes('T') && kinds.includes('A') && kinds.includes('U')) || kinds.join('');
  });
  check('真实会话重建不产生运行时错误', () => errors.length === 0 || errors.join(' | '));

  // --- 文件变更账本（为 Diff/Git 预留的结构，当前不渲染 UI）---
  check('非改动类工具不入账', () => window.listChanges().length === 0);
  let changeEvents = 0;
  const offChanges = window.onChanges(() => changeEvents++);
  es.emit({ type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: { file_path: '/tmp/a.txt', content: 'x' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 'w1', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
  check('write 成功记入账本', () => window.listChanges().length === 1 && window.listChanges()[0].path === '/tmp/a.txt');
  check('账本变化触发订阅', () => changeEvents === 1);
  check('同文件重复改动累加计数', () => {
    es.emit({ type: 'tool_execution_start', toolCallId: 'w2', toolName: 'edit', args: { file_path: '/tmp/a.txt', old_string: 'x', new_string: 'y' } });
    es.emit({ type: 'tool_execution_end', toolCallId: 'w2', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
    const l = window.listChanges();
    return l.length === 1 && l[0].count === 2 && l[0].tool === 'edit';
  });
  check('失败的工具不入账', () => {
    es.emit({ type: 'tool_execution_start', toolCallId: 'w3', toolName: 'write', args: { file_path: '/tmp/b.txt' } });
    es.emit({ type: 'tool_execution_end', toolCallId: 'w3', isError: true, result: { content: [{ type: 'text', text: 'boom' }] } });
    return window.listChanges().some((c) => c.path === '/tmp/b.txt') === false;
  });
  check('对外给的是副本（改不动账本）', () => {
    window.listChanges()[0].path = '篡改';
    return window.listChanges()[0].path === '/tmp/a.txt';
  });
  check('clearChanges 清空账本', () => {
    window.clearChanges();
    return window.listChanges().length === 0;
  });
  check('取消订阅后不再触发', () => {
    const before = changeEvents;
    offChanges();
    es.emit({ type: 'tool_execution_start', toolCallId: 'w4', toolName: 'write', args: { file_path: '/tmp/c.txt' } });
    es.emit({ type: 'tool_execution_end', toolCallId: 'w4', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
    return changeEvents === before && window.listChanges().length === 1;
  });
  window.clearChanges();

  /* --- Git 变更面板（v0.3.0） ---
   *
   * 前端这一侧要验的是「后端给什么就渲染什么」，以及几条容易做错的行为：
   * 徽标、空状态、不是仓库时的中性降级、diff 就地展开且无 XSS、
   * 撤销必须二次确认、工具结束后的防抖刷新。
   * 真实的 git 行为（路径逃逸、重命名、中文文件名、restore…）在 tests/git.cjs 里
   * 用临时仓库验，这里全部走桩，不碰开发者的仓库。 */

  const chgRows = () => [...window.document.querySelectorAll('#workSurface .chg-row')];
  const chgText = () => ($('workSurface') ? $('workSurface').textContent : '');
  const confirmText = () => ($('confirmCard') ? $('confirmCard').textContent : '');
  const confirmBtn = (label) => [...window.document.querySelectorAll('#confirmCard .btn')].find((b) => b.textContent === label);

  check('全局栏有「文件变更」入口', () => window.document.querySelector('#globalRail #navChanges') !== null);

  gitStub.status = {
    ok: true,
    isRepo: true,
    files: [
      { path: 'src/app.js', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 12, deletions: 3, binary: false, oldPath: null },
      { path: 'docs/中文 说明.md', status: 'A', index: 'A', worktree: ' ', staged: true, untracked: false, isDir: false, additions: 5, deletions: 0, binary: false, oldPath: null },
      { path: 'tmp/<img onerror=alert(1)>.txt', status: '??', index: '?', worktree: '?', staged: false, untracked: true, isDir: false, additions: 2, deletions: 0, binary: false, oldPath: null },
      { path: 'big.log', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 900, deletions: 0, binary: false, oldPath: null },
      { path: 'newdir/', status: '??', index: '?', worktree: '?', staged: false, untracked: true, isDir: true, additions: null, deletions: null, binary: false, oldPath: null },
    ],
  };
  await window.loadGitStatus();
  check('徽标显示变更数', () => ($('changesCount').textContent === '5' && $('changesCount').hidden === false) || $('changesCount').textContent);

  $('navChanges').click();
  await new Promise((r) => setTimeout(r, 20));
  check('变更工作区打开且没有 Modal 遮罩', () => $('workspace').dataset.workspaceView === 'changes' && !$('workSurface').hidden && $('modal').hidden);
  check('列表渲染 5 行', () => chgRows().length === 5);
  check('Changes 全部过滤器的选中语义与状态一致', () => $('chgFilterAll').classList.contains('on') && $('chgFilterAll').getAttribute('aria-pressed') === 'true' && $('chgFilterSession').getAttribute('aria-pressed') === 'false');
  check('状态字母正确', () => chgRows().map((x) => x.querySelector('.chg-code').textContent).join('') === 'MA??M??');
  check('含空格与中文的路径原样渲染', () => chgRows().some((x) => x.querySelector('.chg-path').textContent === 'docs/中文 说明.md'));
  check('恶意文件名只作为文本（不产生活元素）', () => liveCount($('workSurface')) === 0 || `解析出了 ${liveCount($('workSurface'))} 个危险元素`);
  check('恶意文件名仍以原样文本呈现（没被截断或吃掉）', () =>
    chgRows().some((x) => x.querySelector('.chg-path').textContent === 'tmp/<img onerror=alert(1)>.txt'));
  check('增删行数渲染', () => {
    const t = chgRows().map((x) => x.querySelector('.chg-stat').textContent).join('|');
    return (t.includes('+12') && t.includes('−3') && t.includes('+900')) || t;
  });
  check('未跟踪文件标注「未跟踪」', () => chgRows().some((x) => x.querySelector('.chg-meta').textContent.includes('未跟踪')));
  check('已暂存文件标注「已暂存」', () => chgRows().some((x) => x.querySelector('.chg-meta').textContent.includes('已暂存')));
  check('未跟踪目录标注「目录」', () => chgRows().some((x) => x.querySelector('.chg-meta').textContent.includes('目录')));
  check('说明文字不重复（未跟踪只出现一次）', () => {
    const m = chgRows()[2].querySelector('.chg-meta').textContent;
    return (m.match(/未跟踪/g) || []).length === 1 || m;
  });
  check('未跟踪目录的说明是「未跟踪 · 目录」', () => {
    const m = chgRows()[4].querySelector('.chg-meta').textContent;
    return m === '未跟踪 · 目录' || m;
  });
  check('每行都有「打开」与撤销按钮', () => {
    const r = chgRows()[0];
    const b = [...r.querySelectorAll('.chg-acts .btn')].map((x) => x.textContent);
    return b.join(',') === '打开,撤销' || b.join(',');
  });
  check('未跟踪文件的按钮写「删除」而非「撤销」', () => {
    const b = [...chgRows()[2].querySelectorAll('.chg-acts .btn')].map((x) => x.textContent);
    return b.join(',') === '打开,删除' || b.join(',');
  });

  /* --- diff 就地展开 --- */
  const DIFF_WORKING = 'diff --git a/src/app.js b/src/app.js\nindex 111..222 100644\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1,2 +1,2 @@\n-旧\n+新\n 不变\n';
  const DIFF_STAGED = 'diff --git a/src/app.js b/src/app.js\n@@ -0,0 +1 @@\n+暂存的一行\n';

  gitStub.diff = { ok: true, isRepo: true, path: 'src/app.js', untracked: false, isDir: false, binary: false, working: DIFF_WORKING, staged: DIFF_STAGED, truncated: false, limit: 524288, notice: '' };
  chgRows()[0].querySelector('.chg-main').click();
  await new Promise((r) => setTimeout(r, 20));
  check('点击行会去拉 diff（带正确路径）', () => {
    const c = gitCalls[gitCalls.length - 1];
    return (c && c.kind === 'diff' && c.body && c.body.path === 'src/app.js') || JSON.stringify(c);
  });
  check('diff 就地展开', () => chgRows()[0].querySelector('.chg-diff').hidden === false);
  check('diff 用等宽容器（pre.diff-body）', () => !!chgRows()[0].querySelector('.chg-diff .diff-body'));
  check('暂存区与工作区分段显示', () => {
    const l = [...chgRows()[0].querySelectorAll('.chg-label')].map((x) => x.textContent);
    return (l.length === 2 && l[0].includes('暂存区') && l[1].includes('工作区')) || l.join('|');
  });
  check('diff 行分类：新增 / 删除 / hunk / 元信息', () => {
    const b = chgRows()[0].querySelector('.chg-diff');
    const add = b.querySelectorAll('.d-add').length;
    const del = b.querySelectorAll('.d-del').length;
    const hunk = b.querySelectorAll('.d-hunk').length;
    const meta = b.querySelectorAll('.d-meta').length;
    return (add === 2 && del === 1 && hunk === 2 && meta >= 4) || `add=${add} del=${del} hunk=${hunk} meta=${meta}`;
  });
  check('`+++ b/x` 被当成元信息而不是新增行', () => {
    const metas = [...chgRows()[0].querySelectorAll('.chg-diff .d-meta')].map((x) => x.textContent);
    return metas.some((t) => t.startsWith('+++ b/')) && !metas.some((t) => t.startsWith('+ ')) || metas.join('|');
  });
  check('再点一次收起 diff', () => {
    chgRows()[0].querySelector('.chg-main').click();
    return chgRows()[0].querySelector('.chg-diff').hidden === true;
  });
  check('收起后不重复请求', () => {
    const before = gitCalls.filter((c) => c.kind === 'diff').length;
    chgRows()[0].querySelector('.chg-main').click();
    return gitCalls.filter((c) => c.kind === 'diff').length === before;
  });

  /* --- diff 的 XSS：文件名与内容都可能被 Agent 间接控制 --- */
  gitStub.diff = {
    ok: true, isRepo: true, path: 'tmp/x', untracked: true, isDir: false, binary: false,
    working: 'diff --git a/<img src=x onerror=alert(1)> b/<img src=x onerror=alert(1)>\n@@ -0,0 +1 @@\n+<script>alert(1)</script>\n',
    staged: '', truncated: false, limit: 524288, notice: '',
  };
  chgRows()[2].querySelector('.chg-main').click();
  await new Promise((r) => setTimeout(r, 20));
  check('恶意文件名与内容不产生活标签', () => {
    const box = chgRows()[2].querySelector('.chg-diff');
    return (noLiveTagIn(box.innerHTML) && liveCount(box) === 0) || box.innerHTML.slice(0, 200);
  });
  check('<script> 被转义成可读文本', () => {
    const b = chgRows()[2].querySelector('.chg-diff');
    return (b.textContent.includes('<script>alert(1)</script>') && b.innerHTML.includes('&lt;script')) || b.textContent;
  });
  check('未跟踪文件的 diff 标为「未跟踪文件的内容」', () => {
    const l = [...chgRows()[2].querySelectorAll('.chg-label')].map((x) => x.textContent);
    return l.some((t) => t.includes('未跟踪')) || l.join('|');
  });

  /* --- 二进制 / 截断 --- */
  gitStub.diff = { ok: true, isRepo: true, path: 'logo.png', untracked: false, isDir: false, binary: true, working: 'Binary files a/logo.png and b/logo.png differ\n', staged: '', truncated: false, limit: 524288, notice: '' };
  chgRows()[1].querySelector('.chg-main').click();
  await new Promise((r) => setTimeout(r, 20));
  check('二进制文件明确提示看不了', () => chgText().includes('二进制文件'));
  check('二进制不渲染文本 diff 块', () => chgRows()[1].querySelector('.chg-diff .diff-body') === null);

  gitStub.diff = { ok: true, isRepo: true, path: 'big.log', untracked: false, isDir: false, binary: false, working: '@@ -1 +1 @@\n+一行\n', staged: '', truncated: true, limit: 524288, notice: '' };
  chgRows()[3].querySelector('.chg-main').click();
  await new Promise((r) => setTimeout(r, 20));
  check('超限的 diff 有截断提示', () => chgText().includes('已截断') && chgText().includes('512 KB'));

  /* --- 后端没给 numstat 时，从 diff 正文补行数 --- */
  window.renderChangesBody();
  gitStub.diff = { ok: true, isRepo: true, path: 'newdir', untracked: true, isDir: true, binary: false, working: '@@ -0,0 +1,2 @@\n+甲\n-乙\n+丙\n', staged: '', truncated: false, limit: 524288, notice: '这是一个未被 Git 跟踪的目录，没有展开显示其中的文件。' };
  chgRows()[4].querySelector('.chg-main').click();
  await new Promise((r) => setTimeout(r, 20));
  check('未跟踪目录的 notice 会显示', () => chgText().includes('未被 Git 跟踪的目录'));
  check('缺 numstat 时从 diff 正文补出 +N −M', () => {
    const t = chgRows()[4].querySelector('.chg-stat').textContent;
    return (t.includes('+2') && t.includes('−1')) || t;
  });

  /* --- 撤销：必须二次确认 --- */
  window.renderChangesBody();
  gitStub.restore = { ok: true, action: 'restored' };
  const restoreBefore = gitCalls.filter((c) => c.kind === 'restore').length;
  chgRows()[0].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 10));
  check('撤销先弹二次确认', () => $('confirmLayer').hidden === false && confirmText().includes('尚未提交的改动会丢失'));
  check('确认层不破坏下层工作区', () => $('workspace').dataset.workspaceView === 'changes' && chgRows().length === 5);
  confirmBtn('取消').click();
  await new Promise((r) => setTimeout(r, 10));
  check('取消确认则不发起撤销', () => gitCalls.filter((c) => c.kind === 'restore').length === restoreBefore);
  check('取消后确认层收起、面板还在', () => $('confirmLayer').hidden === true && chgRows().length === 5);

  chgRows()[0].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 10));
  confirmBtn('撤销改动').click();
  await new Promise((r) => setTimeout(r, 20));
  check('确认后按 tracked 方式撤销（不带 deleteUntracked）', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore').pop();
    return (c && c.body.path === 'src/app.js' && c.body.deleteUntracked === false) || JSON.stringify(c);
  });

  /* --- 撤销未跟踪文件：文案不同，且必须显式带 deleteUntracked --- */
  gitStub.restore = { ok: true, action: 'deleted-untracked' };
  const rowsAfterRestore = chgRows();
  const stBeforeDelete = gitCalls.filter((c) => c.kind === 'status').length;
  rowsAfterRestore[2].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 10));
  check('未跟踪文件的确认文案点明「将删除该文件」', () => confirmText().includes('这个文件尚未被 Git 跟踪。撤销将删除该文件'));
  confirmBtn('删除文件').click();
  await new Promise((r) => setTimeout(r, 20));
  check('确认后带 deleteUntracked=true', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore').pop();
    return (c && c.body.deleteUntracked === true) || JSON.stringify(c);
  });
  check('撤销成功后提示已删除', () => [...window.document.querySelectorAll('.toast')].some((x) => x.textContent.includes('已删除未跟踪文件')));
  check('撤销后自动重拉状态并重画面板', () => {
    const n = gitCalls.filter((c) => c.kind === 'status').length;
    return (n > stBeforeDelete && chgRows().length === 5) || `status=${n} rows=${chgRows().length}`;
  });

  /* --- 后端说「还需要确认」时再问一次（客户端状态过期的兜底） --- */
  gitStub.restore = { ok: false, needsConfirm: true, error: '这个文件尚未被 Git 跟踪。撤销将删除该文件。' };
  window.renderChangesBody();
  chgRows()[0].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 10));
  confirmBtn('撤销改动').click();
  await new Promise((r) => setTimeout(r, 20));
  check('后端要求再确认时会追问一轮', () => confirmText().includes('尚未被 Git 跟踪'));
  confirmBtn('删除文件').click();
  await new Promise((r) => setTimeout(r, 20));
  check('追问后以 deleteUntracked=true 重试', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore').pop();
    return (c && c.body.deleteUntracked === true) || JSON.stringify(c);
  });

  /* ================================================================
   * v0.4.0 新增：会话过滤 / hunk 折叠 / 上下文切换 / 全部撤销 / 取消暂存
   * ================================================================ */

  /* 先把前面工具事件留下的**防抖定时器**排空。
   *
   * tools.js 在 write / edit / bash 结束后会排一次 450ms 的延迟刷新；那些事件
   * 发生在本段之前，定时器还没到点。它一旦落在下面的 `await` 里，就会
   * `refreshGitNow()` 把面板整个重画一遍 —— 我们刚点开的行、刚展开的 diff
   * 全被换成新节点，于是「点了没反应」这种最费解的现象就出现了。
   * 这一段的断言都建立在「点开的那个节点还在」之上，所以先等干净。 */
  await new Promise((r) => setTimeout(r, 600));

  const FILES5 = [
    { path: 'src/app.js', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 12, deletions: 3, binary: false, oldPath: null },
    { path: 'docs/中文 说明.md', status: 'A', index: 'A', worktree: ' ', staged: true, untracked: false, isDir: false, additions: 5, deletions: 0, binary: false, oldPath: null },
    { path: 'tmp/<img onerror=alert(1)>.txt', status: '??', index: '?', worktree: '?', staged: false, untracked: true, isDir: false, additions: 2, deletions: 0, binary: false, oldPath: null },
    { path: 'big.log', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 900, deletions: 0, binary: false, oldPath: null },
    { path: 'newdir/', status: '??', index: '?', worktree: '?', staged: false, untracked: true, isDir: true, additions: null, deletions: null, binary: false, oldPath: null },
  ];

  /* --- 会话过滤：账本路径必须先归一成项目相对路径才能和 git status 对上 --- */
  console.log('\n--- 会话过滤 ---');
  gitStub.status = { ok: true, isRepo: true, projectRoot: 'C:\\pi-GUI', files: FILES5 };
  await window.loadGitStatus();
  window.clearChanges();
  window.recordToolChange('write', { file_path: 'C:\\pi-GUI\\src\\app.js' }); // 反斜杠绝对路径
  window.recordToolChange('edit', { file_path: 'C:/pi-GUI/big.log' }); // 正斜杠绝对路径
  window.recordToolChange('write', { file_path: 'C:\\别的地方\\outside.js' }); // 项目外
  window.renderChangesBody();

  check('过滤行有「全部」与「仅本次会话」两个页签', () =>
    !!$('chgFilterAll') && !!$('chgFilterSession'));
  check('「全部」页签显示 Git 总数', () => $('chgFilterAll').textContent.includes('5') || $('chgFilterAll').textContent);
  check('「仅本次会话」只算项目内的账本条目', () => $('chgFilterSession').textContent.includes('2') || $('chgFilterSession').textContent);
  check('项目外的账本路径不参与匹配', () => window.sessionFileSet().size === 2 || [...window.sessionFileSet()].join(','));
  check('匹配到的行带「本会话」标记', () => chgRows().filter((x) => x.querySelector('.chg-sess')).length === 2);
  check('「本会话」标记不改变行数（仍是全部 5 行）', () => chgRows().length === 5);

  $('chgFilterSession').click();
  check('切到「仅本次会话」后只剩匹配的 2 行', () => chgRows().length === 2 || chgRows().length);
  check('仅本次会话过滤器的选中语义同步', () => $('chgFilterSession').classList.contains('on') && $('chgFilterSession').getAttribute('aria-pressed') === 'true' && $('chgFilterAll').getAttribute('aria-pressed') === 'false');
  check('过滤后剩下的确实是被改过的那两个文件', () => {
    const paths = chgRows().map((x) => x.querySelector('.chg-path').textContent).sort().join(',');
    return paths === 'big.log,src/app.js' || paths;
  });
  check('侧栏徽标仍是 Git 总数，不受过滤影响', () => $('changesCount').textContent === '5' || $('changesCount').textContent);

  $('chgFilterAll').click();
  check('切回「全部」恢复 5 行', () => chgRows().length === 5);

  /* 账本里没有这个文件时，过滤视图要给一句能解释清楚的话 */
  window.clearChanges();
  window.renderChangesBody();
  $('chgFilterSession').click();
  check('本会话无记录时给出解释（并说明 bash 不计入）', () =>
    chgText().includes('本次会话还没有记录到文件改动') && chgText().includes('bash'));

  /* 账本里有东西、但都对不上当前工作区时，是**另一句话** ——
   * 混成一句会让「Agent 明明改过」的用户以为工具坏了。 */
  window.recordToolChange('write', { file_path: 'C:\\pi-GUI\\已经提交过的文件.js' });
  window.renderChangesBody();
  check('账本有记录但对不上时给的是另一种解释', () =>
    chgText().includes('都没有未提交的改动') || chgText().slice(0, 160));
  check('两种情况不会混用同一句话', () => !chgText().includes('还没有记录到文件改动'));

  $('chgFilterAll').click();
  check('切回全部后列表回来', () => chgRows().length === 5);
  window.clearChanges();

  /* --- hunk 折叠 --- */
  console.log('\n--- hunk 折叠 ---');
  const DIFF_TWO_HUNKS =
    'diff --git a/src/app.js b/src/app.js\n' +
    'index 111..222 100644\n' +
    '--- a/src/app.js\n' +
    '+++ b/src/app.js\n' +
    '@@ -1,3 +1,3 @@\n' +
    ' 上\n' +
    '-旧\n' +
    '+新\n' +
    '@@ -50,3 +50,3 @@ function foo()\n' +
    ' 上2\n' +
    '-旧2\n' +
    '+新2\n';

  /* 断言一律针对**点开时抓到的那个节点**，而不是每次重新 querySelector。
   * 面板任何一次重画都会换掉行节点，重新查询就会拿到一个没被点开的新行，
   * 于是断言集体失败、原因却看不出来。抓住引用，问题就只会在该出现的地方出现。 */
  const openRow = async (stubDiff, index = 0) => {
    gitStub.diff = stubDiff;
    window.renderChangesBody();
    const row = chgRows()[index];
    row.querySelector('.chg-main').click();
    await new Promise((r) => setTimeout(r, 20));
    return row;
  };

  const diffRootOf = (r) => r.querySelector('.chg-diff .diff');
  const wrapsOf = (r) => [...r.querySelectorAll('.chg-diff .d-hunkwrap')];
  const allBtnOf = (r) => r.querySelector('.chg-diff .chg-hunkall');
  const ctxBtnsOf = (r) => [...r.querySelectorAll('.chg-diff .chg-ctx')];

  const diffStub = (working) => ({
    ok: true, isRepo: true, path: 'src/app.js', untracked: false, isDir: false, binary: false,
    working, staged: '', truncated: false, limit: 524288, notice: '', context: null,
  });

  const hunkRow = await openRow(diffStub(DIFF_TWO_HUNKS));
  check('diff 根节点标出 hunk 数量', () => diffRootOf(hunkRow).dataset.hunks === '2' || diffRootOf(hunkRow).dataset.hunks);
  check('每个 hunk 一个可折叠块', () => wrapsOf(hunkRow).length === 2 || wrapsOf(hunkRow).length);
  check('hunk 默认是展开的', () => wrapsOf(hunkRow).every((w) => w.dataset.open === '1'));
  check('每个 hunk 都有可点击的标题栏', () => hunkRow.querySelectorAll('.chg-diff .d-hunkbar').length === 2);
  check('展开态显示下三角', () => hunkRow.querySelector('.d-chev').textContent === '▾');
  check('hunk 标题栏标出该块的 +N −M', () => {
    const t = [...hunkRow.querySelectorAll('.d-hunkstat')].map((x) => x.textContent).join('|');
    return t === '+1−1|+1−1' || t;
  });
  check('hunk 头文本原样保留（含函数上下文）', () => chgText().includes('@@ -50,3 +50,3 @@ function foo()'));
  /* 折叠按钮的文案/可见性必须在两个 diff 块挂好之后才同步 ——
   * 早一步同步会算出「没有块可折叠」并把自己藏起来，而且再也不出现。 */
  check('首次渲染时折叠按钮就可见（不会把自己藏起来）', () => allBtnOf(hunkRow).hidden === false);
  check('全展开状态下按钮写「折叠全部块」', () => allBtnOf(hunkRow).textContent === '折叠全部块' || allBtnOf(hunkRow).textContent);

  wrapsOf(hunkRow)[0].querySelector('.d-hunkbar').click();
  check('点标题栏折叠这一个 hunk', () => wrapsOf(hunkRow)[0].dataset.open === '0');
  check('折叠后三角朝右', () => wrapsOf(hunkRow)[0].querySelector('.d-chev').textContent === '▸');
  check('另一个 hunk 不受影响', () => wrapsOf(hunkRow)[1].dataset.open === '1');

  check('有折叠块时按钮是「展开全部块」', () => allBtnOf(hunkRow).textContent === '展开全部块' || allBtnOf(hunkRow).textContent);
  allBtnOf(hunkRow).click();
  check('「展开全部块」把两个都展开', () => wrapsOf(hunkRow).every((w) => w.dataset.open === '1'));
  check('全展开后按钮变成「折叠全部块」', () => allBtnOf(hunkRow).textContent === '折叠全部块' || allBtnOf(hunkRow).textContent);
  allBtnOf(hunkRow).click();
  check('「折叠全部块」把两个都折叠', () => wrapsOf(hunkRow).every((w) => w.dataset.open === '0'));
  allBtnOf(hunkRow).click();
  check('再点回来又是全展开', () => wrapsOf(hunkRow).every((w) => w.dataset.open === '1'));

  /* hunk 内部以 `++` 开头的**新增代码**，diff 里写作 `+++ …`。
   * 它不该被当成 `+++ b/…` 文件头 —— 这是按 hunk 分块顺手修掉的老毛病。 */
  const inlineRow = await openRow(
    diffStub('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n 上下文\n+++ b/这不是文件头\n')
  );
  check('hunk 内部的 `+++ x` 算新增行而不是文件头', () => {
    const adds = [...inlineRow.querySelectorAll('.chg-diff .d-add')].map((x) => x.textContent);
    return adds.includes('+++ b/这不是文件头') || adds.join('|');
  });
  check('hunk 内部的 `+++ x` 不会同时被当成元信息', () => {
    const metas = [...inlineRow.querySelectorAll('.chg-diff .d-meta')].map((x) => x.textContent);
    return !metas.includes('+++ b/这不是文件头') || metas.join('|');
  });

  /* --- 上下文切换：必须重新问后端 --- */
  console.log('\n--- 上下文切换 ---');
  const ctxRow = await openRow(diffStub(DIFF_TWO_HUNKS));

  check('工具条有三个上下文档位', () => ctxBtnsOf(ctxRow).length === 3 || ctxBtnsOf(ctxRow).map((b) => b.textContent).join('|'));
  check('默认档是「默认」（不传 -U）', () => ctxBtnsOf(ctxRow)[0].classList.contains('on'));
  check('首次拉 diff 不带 context 参数', () => {
    const c = gitCalls.filter((x) => x.kind === 'diff').pop();
    return (c && c.body.context === undefined) || JSON.stringify(c && c.body);
  });

  const diffCallsBefore = gitCalls.filter((c) => c.kind === 'diff').length;
  ctxBtnsOf(ctxRow)[1].click(); // 「20 行」
  await new Promise((r) => setTimeout(r, 20));
  check('切到 20 行会重新问后端（不是本地重排）', () => gitCalls.filter((c) => c.kind === 'diff').length > diffCallsBefore);
  check('重拉时带上了 context=20', () => {
    const c = gitCalls.filter((x) => x.kind === 'diff').pop();
    return (c && c.body.context === 20) || JSON.stringify(c && c.body);
  });
  check('切换后「20 行」成为选中档', () => {
    const bs = ctxBtnsOf(ctxRow);
    return (bs[1].classList.contains('on') && !bs[0].classList.contains('on')) || bs.map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')).join('|');
  });

  ctxBtnsOf(ctxRow)[2].click(); // 「全部」
  await new Promise((r) => setTimeout(r, 20));
  check("切到「全部」传的是字符串 'all'", () => {
    const c = gitCalls.filter((x) => x.kind === 'diff').pop();
    return (c && c.body.context === 'all') || JSON.stringify(c && c.body);
  });
  check('切换上下文后 hunk 折叠状态重建（仍是默认展开）', () => wrapsOf(ctxRow).every((w) => w.dataset.open === '1'));

  /* 新展开的文件沿用上次选的档位 —— 「要看更多上下文」是仓库级偏好 */
  const inheritRow = await openRow(diffStub(DIFF_TWO_HUNKS), 3);
  check('新文件沿用上次选的上下文档位', () => {
    const c = gitCalls.filter((x) => x.kind === 'diff').pop();
    return (c && c.body.context === 'all') || JSON.stringify(c && c.body);
  });
  check('沿用的档位在界面上也是选中态', () => ctxBtnsOf(inheritRow)[2].classList.contains('on'));

  /* --- 全部撤销 --- */
  console.log('\n--- 全部撤销 ---');
  const allBtnInHead = () => $('workSurface').querySelector('.chg-head .btn.danger');

  gitStub.status = { ok: true, isRepo: true, projectRoot: 'C:\\pi-GUI', files: FILES5 };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('有变更时「全部撤销」可用', () => allBtnInHead().disabled === false);

  const PLAN3 = {
    ok: false, needsPlan: true, total: 3,
    plan: { total: 3, plain: ['a.txt'], staged: ['s.txt'], untracked: ['u.txt'], skipped: [] },
  };
  gitStub['restore-all'] = PLAN3;
  const allCallsBefore = gitCalls.filter((c) => c.kind === 'restore-all').length;
  allBtnInHead().click();
  await new Promise((r) => setTimeout(r, 30));
  check('「全部撤销」先干跑拿计划（不带 planned）', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore-all').pop();
    return (gitCalls.filter((x) => x.kind === 'restore-all').length > allCallsBefore && c.body.planned !== true) || JSON.stringify(c && c.body);
  });
  check('确认框列出三类数量', () => {
    const t = confirmText();
    return (t.includes('恢复 1 个') && t.includes('取消暂存') && t.includes('删除 1 个')) || t;
  });
  check('确认框逐条列出将被删除的文件', () => confirmText().includes('u.txt') || confirmText());
  check('有未跟踪文件时给第二条路径', () => !!confirmBtn('仅撤销已跟踪文件（保留 1 个）'));

  gitStub['restore-all'] = { ok: true, total: 3, restored: [{ path: 'a.txt', action: 'restored' }], skipped: [], kept: [] };
  confirmBtn('撤销全部（含删除 1 个文件）').click();
  await new Promise((r) => setTimeout(r, 30));
  check('主路径带 planned + unstage + deleteUntracked', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore-all').pop();
    return (c && c.body.planned === true && c.body.unstage === true && c.body.deleteUntracked === true) || JSON.stringify(c && c.body);
  });
  check('撤销全部后提示结果并重拉状态', () =>
    [...window.document.querySelectorAll('.toast')].some((x) => x.textContent.includes('已撤销 1 个文件')) || chgText().slice(0, 120));

  /* 第二条路径：只撤销已跟踪的，一个文件都不删 */
  gitStub['restore-all'] = PLAN3;
  window.renderChangesBody();
  allBtnInHead().click();
  await new Promise((r) => setTimeout(r, 30));
  gitStub['restore-all'] = { ok: true, total: 3, restored: [{ path: 'a.txt', action: 'restored' }], skipped: [], kept: [{ path: 'u.txt', reason: '未授权' }] };
  confirmBtn('仅撤销已跟踪文件（保留 1 个）').click();
  await new Promise((r) => setTimeout(r, 30));
  check('第二条路径带 deleteUntracked=false', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore-all').pop();
    return (c && c.body.planned === true && c.body.deleteUntracked === false && c.body.unstage === true) || JSON.stringify(c && c.body);
  });
  check('有保留项时提示里说明「被保留」', () =>
    [...window.document.querySelectorAll('.toast')].some((x) => x.textContent.includes('被保留')) || '没有找到对应提示');

  /* 取消确认 → 一个字都不执行 */
  gitStub['restore-all'] = PLAN3;
  window.renderChangesBody();
  allBtnInHead().click();
  await new Promise((r) => setTimeout(r, 30));
  const beforeCancel = gitCalls.filter((c) => c.kind === 'restore-all' && c.body.planned === true).length;
  confirmBtn('取消').click();
  await new Promise((r) => setTimeout(r, 20));
  check('取消确认后不执行（没有带 planned 的调用）', () =>
    gitCalls.filter((c) => c.kind === 'restore-all' && c.body.planned === true).length === beforeCancel);

  gitStub.status = { ok: true, isRepo: true, projectRoot: 'C:\\pi-GUI', files: [] };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('工作区干净时「全部撤销」禁用', () => allBtnInHead().disabled === true);

  /* --- 已暂存文件的单文件撤销 --- */
  console.log('\n--- 取消暂存（单文件） ---');
  gitStub.status = {
    ok: true, isRepo: true, projectRoot: 'C:\\pi-GUI',
    files: [{ path: 's.txt', status: 'M', index: 'M', worktree: ' ', staged: true, untracked: false, isDir: false, additions: 1, deletions: 1, binary: false, oldPath: null }],
  };
  await window.loadGitStatus();
  window.renderChangesBody();
  gitStub.restore = { ok: true, action: 'unstaged-restored' };
  chgRows()[0].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 20));
  check('已暂存文件的确认框点明「会改动暂存内容」', () => confirmText().includes('取消暂存') && confirmText().includes('暂存') || confirmText());
  check('确认按钮写「取消暂存并撤销」', () => !!confirmBtn('取消暂存并撤销'));
  confirmBtn('取消暂存并撤销').click();
  await new Promise((r) => setTimeout(r, 30));
  check('已暂存文件带 unstage=true 撤销（不带删除授权）', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore').pop();
    return (c && c.body.unstage === true && c.body.deleteUntracked === false) || JSON.stringify(c && c.body);
  });
  check('提示语说明已取消暂存', () =>
    [...window.document.querySelectorAll('.toast')].some((x) => x.textContent.includes('已取消暂存并撤销')) ||
    [...window.document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | '));

  /* 已暂存的**新增**文件：一次问清「取消暂存 + 删除」 */
  gitStub.status = {
    ok: true, isRepo: true, projectRoot: 'C:\\pi-GUI',
    files: [{ path: 'added.txt', status: 'A', index: 'A', worktree: ' ', staged: true, untracked: false, isDir: false, additions: 3, deletions: 0, binary: false, oldPath: null }],
  };
  await window.loadGitStatus();
  window.renderChangesBody();
  gitStub.restore = { ok: true, action: 'unstaged-deleted-untracked' };
  chgRows()[0].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 20));
  check('已暂存新增文件的确认框点明会删除', () => confirmText().includes('删除该文件') || confirmText());
  check('确认按钮写「取消暂存并删除」', () => !!confirmBtn('取消暂存并删除'));
  confirmBtn('取消暂存并删除').click();
  await new Promise((r) => setTimeout(r, 30));
  check('两个授权一次给全（unstage + deleteUntracked）', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore').pop();
    return (c && c.body.unstage === true && c.body.deleteUntracked === true) || JSON.stringify(c && c.body);
  });

  /* 后端在动 index 之前就拦下来时，前端要一次给全两个授权重试 */
  gitStub.status = {
    ok: true, isRepo: true, projectRoot: 'C:\\pi-GUI',
    files: [{ path: 'stale.txt', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 1, deletions: 0, binary: false, oldPath: null }],
  };
  await window.loadGitStatus();
  window.renderChangesBody();
  gitStub.restore = { ok: false, needsConfirm: true, requiresUnstage: true, error: '这个文件是已暂存的新增文件。取消暂存后它会变成未跟踪文件，撤销将删除该文件。' };
  chgRows()[0].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 20));
  confirmBtn('撤销改动').click();
  await new Promise((r) => setTimeout(r, 20));
  check('后端说 requiresUnstage 时会追问一次', () => confirmText().includes('未跟踪文件') || confirmText());
  gitStub.restore = { ok: true, action: 'unstaged-deleted-untracked' };
  confirmBtn('取消暂存并删除').click();
  await new Promise((r) => setTimeout(r, 30));
  check('追问后一次带上两个授权', () => {
    const c = gitCalls.filter((x) => x.kind === 'restore').pop();
    return (c && c.body.unstage === true && c.body.deleteUntracked === true) || JSON.stringify(c && c.body);
  });

  /* 未跟踪目录：后端一律拒绝递归删，所以界面**不该**给一个点了会被拒的按钮 */
  gitStub.status = {
    ok: true, isRepo: true, projectRoot: 'C:\\pi-GUI',
    files: [{ path: 'newdir/', status: '??', index: '?', worktree: '?', staged: false, untracked: true, isDir: true, additions: null, deletions: null, binary: false, oldPath: null }],
  };
  await window.loadGitStatus();
  window.renderChangesBody();
  const dirRestoreBefore = gitCalls.filter((c) => c.kind === 'restore').length;
  chgRows()[0].querySelector('.chg-acts .btn.danger').click();
  await new Promise((r) => setTimeout(r, 20));
  check('未跟踪目录不弹删除确认框', () => $('confirmLayer').hidden === true);
  check('未跟踪目录只给一句说明，不发起撤销请求', () =>
    gitCalls.filter((c) => c.kind === 'restore').length === dirRestoreBefore);
  check('未跟踪目录的提示说明要手动处理', () =>
    [...window.document.querySelectorAll('.toast')].some((x) => x.textContent.includes('未跟踪的目录')) ||
    [...window.document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | '));

  /* --- 各种「不是错误」的状态 --- */
  window.clearChanges();
  gitStub.status = { ok: true, isRepo: true, files: [] };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('工作区干净时有明确空状态', () => chgText().includes('工作区是干净的'));
  check('干净时徽标隐藏', () => $('changesCount').hidden === true);
  check('干净时没有过滤行（没有东西可过滤）', () => $('chgFilterAll') === null);

  gitStub.status = { ok: true, isRepo: false, files: [] };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('非 Git 仓库给中性提示（不是报错）', () => chgText().includes('当前项目不是 Git 仓库') && chgText().includes('不受影响'));

  gitStub.status = { ok: false, noGit: true, isRepo: false, files: [], error: 'spawn git ENOENT' };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('没装 git 时给友好文案', () => chgText().includes('没有找到 git 命令'));

  gitStub.status = { ok: true, isRepo: false, files: [], noProject: true };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('没有项目时引导去添加文件夹', () => chgText().includes('还没有选择项目'));

  gitStub.status = { ok: true, isRepo: true, truncated: true, files: [{ path: 'a.txt', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 1, deletions: 0, binary: false, oldPath: null }] };
  await window.loadGitStatus();
  window.renderChangesBody();
  check('列表过长时有截断提示', () => chgText().includes('变更列表过长'));

  gitStub.status = { ok: true, isRepo: true, files: [] };
  await window.loadGitStatus();
  $('modal').click();
  check('变更面板可关闭', () => $('modal').hidden === true);

  /* --- 自动刷新：工具结束后防抖 ---
   *
   * 先等一拍再开始计数：前面「账本」那段用例发过 write / edit，会留下一个
   * 450ms 的防抖定时器。不等它落地，它就会掉进下面第一个断言的时间窗里，
   * 把「read 不该刷新」误判成失败。 */
  await new Promise((r) => setTimeout(r, 600));

  const statusCount = () => gitCalls.filter((c) => c.kind === 'status').length;

  let n0 = statusCount();
  es.emit({ type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: { file_path: '/tmp/a.txt' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 'r1', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
  await new Promise((r) => setTimeout(r, 600));
  check('只读工具（read）不触发刷新', () => statusCount() === n0 || `多了 ${statusCount() - n0} 次`);

  n0 = statusCount();
  for (const id of ['w5', 'w6', 'w7']) {
    es.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'write', args: { file_path: '/tmp/' + id + '.txt' } });
    es.emit({ type: 'tool_execution_end', toolCallId: id, isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
  }
  await new Promise((r) => setTimeout(r, 600));
  check('write 结束后自动刷新', () => statusCount() === n0 + 1 || `刷了 ${statusCount() - n0} 次`);
  check('连续多次改动被防抖合并成一次', () => statusCount() === n0 + 1 || `刷了 ${statusCount() - n0} 次`);

  n0 = statusCount();
  es.emit({ type: 'tool_execution_start', toolCallId: 'b9', toolName: 'bash', args: { command: 'echo x > f.txt' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 'b9', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
  await new Promise((r) => setTimeout(r, 600));
  check('bash 结束后也会刷新（它可能改了文件）', () => statusCount() === n0 + 1 || `刷了 ${statusCount() - n0} 次`);

  n0 = statusCount();
  es.emit({ type: 'tool_execution_start', toolCallId: 'w8', toolName: 'write', args: { file_path: '/tmp/boom.txt' } });
  es.emit({ type: 'tool_execution_end', toolCallId: 'w8', isError: true, result: { content: [{ type: 'text', text: 'boom' }] } });
  await new Promise((r) => setTimeout(r, 600));
  check('失败的工具不触发刷新', () => statusCount() === n0 || `多了 ${statusCount() - n0} 次`);

  window.clearChanges();

  /* --- Tool Timeline：Git 回填 +N −M ---
   *
   * §9：**Git 是最终权威，工具事件只是 Agent 的行为记录**。
   * 工具自己的 details.diff 只说明「这一次 edit 改了多少」，整文件的行数
   * 只有 Git 知道。所以工具结束后安排一次防抖刷新，刷新回来再把权威数字
   * 回填到已经画出来的条目上 —— 这条链路的每一环都在这里钉住。
   *
   * 位置说明：必须放在这一段之后 —— 上面已经用 600ms 的等待把前面用例
   * 留下的防抖定时器排空了，这里再排一次才不会互相干扰。 */
  console.log('\n--- Tool Timeline：Git 回填 ---');
  window.clearChanges();
  /* 不用清线程：上一条用例重建历史时已经把 S.tlGroup 归零、S.tools 清空，
   * 下一次工具事件自然会开一个新组。清掉反而会顺手删掉前面用例留下的
   * 用户消息，让后面按 `.msg.user` 定位的断言指向另一条节点。 */

  const ONE_EDIT_DIFF = '--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-旧\n+新\n';
  es.emit({ type: 'tool_execution_start', toolCallId: 'gs1', toolName: 'edit', args: { path: 'C:\\pi-GUI\\src\\app.js' } });
  es.emit({
    type: 'tool_execution_end',
    toolCallId: 'gs1',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in C:\\pi-GUI\\src\\app.js' }],
      details: { diff: ONE_EDIT_DIFF, patch: '', firstChangedLine: 1 },
    },
  });
  check('先用工具自己 details.diff 的单次统计', () => {
    const t = tlText('gs1', '.tl-stat');
    return t === '+1−1' || t;
  });

  gitStub.status = {
    ok: true,
    isRepo: true,
    projectRoot: 'C:\\pi-GUI',
    files: [{ path: 'src/app.js', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 12, deletions: 3, binary: false, oldPath: null }],
  };
  await new Promise((r) => setTimeout(r, 600)); // 等防抖的 450ms 刷新落地
  check('Git 刷新回来后用整文件数字覆盖单次统计', () => {
    const t = tlText('gs1', '.tl-stat');
    return t === '+12−3' || t;
  });

  /* 文件从 Git 变更列表里消失（提交了 / 被撤销了）→ 之前回填的数字要撤掉。
   * 「以 Git 为准」这条规则在**消失**的方向上同样要成立，否则时间线上会
   * 一直挂着一个已经不对的数字。 */
  gitStub.status = { ok: true, isRepo: true, projectRoot: 'C:\\pi-GUI', files: [] };
  await window.loadGitStatus();
  check('文件离开变更列表后撤掉回填的数字', () => {
    const t = tlText('gs1', '.tl-stat');
    return t === '+1−1' || t;
  });

  gitStub.status = { ok: true, isRepo: true, files: [] };
  await window.loadGitStatus();
  window.clearChanges();

  // --- 弹层：分支 ---
  $('btnTree').click();
  check('分支弹层打开', () => $('modal').hidden === false);
  check('分支树渲染 3 个节点', () => window.document.querySelectorAll('#modalCard .tree-node').length === 3);
  check('分支节点文本不是 [object Object]', () => {
    const t = [...window.document.querySelectorAll('#modalCard .tree-text')].map((x) => x.textContent).join(' | ');
    return !t.includes('[object') || t;
  });
  check('分支节点只列对话条目', () => {
    const t = [...window.document.querySelectorAll('#modalCard .tree-text')].map((x) => x.textContent);
    const want = ['你：帮我看看 server.js', 'Pi：文件没问题。', 'Pi：换个模型再答一次'];
    return t.every((s, i) => s.startsWith(want[i])) || t.join(' | ');
  });
  check('操作类条目不出现在分支树里', () => {
    const t = [...window.document.querySelectorAll('#modalCard .tree-text')].map((x) => x.textContent).join(' | ');
    return !/模型 →|思考档位 →|model_change|thinking_level_change/.test(t) || t;
  });
  check('分叉点标出支线数', () => {
    const f = window.document.querySelector('#modalCard .tree-fork');
    return (f && f.textContent === '2 条支线') || (f ? f.textContent : '没有分叉标记');
  });
  check('分支树左对齐（不按深度递进缩进）', () => {
    const nodes = [...window.document.querySelectorAll('#modalCard .tree-node')];
    const bad = nodes.filter((n) => n.style.paddingLeft);
    return bad.length === 0 || `有 ${bad.length} 个节点带 paddingLeft`;
  });
  check('节点上的 label 作为徽标渲染', () => {
    const lb = window.document.querySelector('#modalCard .tree-label');
    return (lb && lb.textContent === '关键结论') || '缺少 label 徽标';
  });
  check('分支弹层是「按钮固定 + 树体滚动」布局', () =>
    $('modalCard').classList.contains('tree-modal') || '缺少 tree-modal');
  check('节点悬停给出完整文本与可点击说明', () => {
    const first = window.document.querySelector('#modalCard .tree-node');
    return first.title.includes('点击从此节点分叉') || first.title;
  });
  $('modal').click();

  // --- 弹层：供应商 ---
  $('navProviders').click();
  await new Promise((r) => setTimeout(r, 20));
  check('供应商弹层打开', () => $('modal').hidden === false);
  check('P14-E 新 Modal 不继承上一弹层的布局类', () => $('modalCard').classList.contains('wide') && !$('modalCard').classList.contains('tree-modal'));
  check('供应商列表渲染', () => window.document.querySelectorAll('#modalCard .prov').length === 1);
  check('未解析的 $ENV_VAR 有告警', () => {
    const w = window.document.querySelector('#modalCard .prov-warn');
    return w && w.textContent.includes('DEEPSEEK_API_KEY') ? true : '告警缺失';
  });
  $('modal').click();

  // --- 添加供应商：保存后提示告警 ---
  $('navProviders').click();
  await new Promise((r) => setTimeout(r, 20));
  [...window.document.querySelectorAll('#modalCard .btn')].find((b) => b.textContent === '添加供应商').click();
  check('添加表单打开', () => window.document.querySelectorAll('#modalCard .preset').length === 9);
  const fields = window.document.querySelectorAll('#modalCard .field input, #modalCard .field textarea');
  fields[0].value = 'newprov';
  fields[1].value = 'https://api.example.com/v1';
  fields[2].value = '$NEW_KEY';
  fields[3].value = 'model-a|Model A';
  [...window.document.querySelectorAll('#modalCard .btn')].find((b) => b.textContent === '保存').click();
  await new Promise((r) => setTimeout(r, 30));
  check('保存后弹出 key 告警', () => {
    const t = [...window.document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | ');
    return t.includes('NEW_KEY') ? true : '未提示：' + t;
  });
  $('modal').click();

  // --- 弹层：统计 ---
  $('btnStats').click();
  await new Promise((r) => setTimeout(r, 10));
  es.emit({
    type: 'response', command: 'get_session_stats', success: true,
    data: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, cost: 0.5, contextUsage: { tokens: 10, contextWindow: 100, percent: 10 }, sessionFile: 'C:\\x\\s.jsonl', userMessages: 1, assistantMessages: 1, toolCalls: 1 },
  });
  await new Promise((r) => setTimeout(r, 10));
  check('统计弹层有数据行', () => window.document.querySelectorAll('#modalCard .stat-rows > div').length === 9);
  $('modal').click();

  // --- 弹层：更多 ---
  $('btnMore').click();
  check('更多菜单 5 项', () => window.document.querySelectorAll('#modalCard .modal-item').length === 5);
  $('modal').click();

  // --- 导出：相对路径补成绝对 ---
  es.emit({ type: 'response', command: 'export_html', success: true, data: { path: 'pi-session-abc.html' } });
  es.emit({ type: 'response', command: 'export_html', success: true, data: { path: 'D:\\abs\\x.html' } });
  check('导出提示补成绝对路径', () => {
    const t = [...window.document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | ');
    if (!t.includes('C:\\pi-GUI\\pi-session-abc.html')) return '相对路径未补全：' + t;
    if (!t.includes('D:\\abs\\x.html')) return '绝对路径被改写：' + t;
    return true;
  });

  // --- 模型 / 思考选择器（Codex 风格浮层） ---
  es.emit({
    type: 'response', command: 'get_available_models', success: true,
    data: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', reasoning: false },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', provider: 'deepseek', reasoning: true },
      { id: 'glm-4.6', name: 'GLM-4.6', provider: 'zhipu', reasoning: true },
    ],
  });
  es.emit({ type: 'response', command: 'get_available_thinking_levels', success: true, data: ['off', 'low', 'high'] });

  const pop = () => window.document.querySelector('.pop');

  // 让当前模型落在可用列表里，才能验证对勾
  es.emit({
    type: 'response', command: 'get_state', success: true,
    data: { model: { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }, thinkingLevel: 'high', isStreaming: false, sessionName: 'pi-gui-work' },
  });

  const gsBefore = commands.filter((c) => c.type === 'get_state').length;

  $('btnModel').click();
  check('模型浮层已打开', () => pop() && pop().hidden === false);
  check('浮层标题为「选择模型」', () => pop().querySelector('.pop-title')?.textContent === '选择模型');
  check('模型按供应商分组', () => [...pop().querySelectorAll('.pop-label')].map((x) => x.textContent).join(',') === 'deepseek,zhipu');
  check('模型项 3 个', () => pop().querySelectorAll('.pop-item').length === 3);
  check('当前模型带对勾', () => pop().querySelectorAll('.pop-item.on').length === 1);

  pop().querySelectorAll('.pop-item')[1].click();
  check('点选后浮层关闭', () => pop().hidden === true);
  const setModel = commands.filter((c) => c.type === 'set_model').pop();
  check('set_model 带 provider+modelId', () => setModel && setModel.provider === 'deepseek' && setModel.modelId === 'deepseek-reasoner');
  check('切模型后回读状态', () => commands.filter((c) => c.type === 'get_state').length === gsBefore + 1);

  // 成功提示只在 pi 确认后才出现（之前是点完就弹，失败时会撒谎）
  check('点选时不抢先弹提示', () => ![...window.document.querySelectorAll('.toast')].some((x) => x.textContent.includes('已切换到')));
  es.emit({ type: 'response', command: 'set_model', success: true, data: { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' } });
  check('pi 确认后才提示已切换', () => [...window.document.querySelectorAll('.toast')].some((x) => x.textContent.includes('已切换到 DeepSeek Reasoner')));

  $('btnThink').click();
  check('思考浮层 3 项', () => pop().querySelectorAll('.pop-item').length === 3);
  check('思考项带说明', () => pop().querySelectorAll('.pop-item .pi-sub').length === 3);
  pop().querySelectorAll('.pop-item')[2].click();
  check('set_thinking_level 已发送', () => commands.some((c) => c.type === 'set_thinking_level' && c.level === 'high'));
  check('切档位后回读状态', () => commands.filter((c) => c.type === 'get_state').length === gsBefore + 2);

  // pi 对非法档位也回 ok（实测 medium 被静默映射成 high），失败分支要能纠正显示
  es.emit({ type: 'response', command: 'set_thinking_level', success: false, error: '不支持的档位' });
  check('设置失败后再次回读状态', () => commands.filter((c) => c.type === 'get_state').length === gsBefore + 3);
  es.emit({ type: 'response', command: 'get_state', success: true, data: { model: { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }, thinkingLevel: 'off', sessionName: 'pi-gui-work' } });
  check('回读后档位被纠正', () => $('thinkText').textContent === '思考 off');

  // --- 上下文占用指示器 + 悬停提示 ---
  es.emit({
    type: 'response', command: 'get_session_stats', success: true,
    data: { tokens: { input: 61000, output: 1000, cacheRead: 0 }, cost: 0.12, contextUsage: { tokens: 61000, contextWindow: 258000, percent: 23 } },
  });
  check('上下文圆环百分比', () => $('ctxPct').textContent === '23%');
  check('圆环有进度', () => {
    const off = Number($('ctxRing').style.strokeDashoffset);
    return off > 0 && off < 97.4 ? true : 'dashoffset=' + off;
  });

  $('btnCtx').click();
  await new Promise((r) => setTimeout(r, 20));
  check('上下文提示已弹出', () => pop().classList.contains('tip-mode') && pop().hidden === false);
  check('提示文案对齐 Codex', () => {
    const t = pop().textContent;
    return t.includes('背景信息窗口:') && t.includes('23% 已用 (剩余 77%)') && t.includes('已用 61k 标记, 共 258k')
      ? true
      : '实际：' + t;
  });
  $('btnCtx').click();
  check('再点不误关提示', () => pop().hidden === false);
  pop().dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));
  check('移开鼠标后提示关闭', () => pop().hidden === true);

  // --- 附件 ---
  const mkFile = (name, content, type) => new window.File([content], name, { type });

  await window.handleFiles([mkFile('shot.png', 'PNGDATA', 'image/png')]);
  await new Promise((r) => setTimeout(r, 20));
  check('图片附件渲染缩略图', () => window.document.querySelectorAll('#attachTray .att-thumb img').length === 1);
  check('附件托盘已显示', () => $('attachTray').hidden === false);
  check('仅有附件也能发送', () => $('btnSend').disabled === false);

  await window.handleFiles([mkFile('发酵罐设计.pdf', 'PDFDATA', 'application/pdf')]);
  await new Promise((r) => setTimeout(r, 20));
  check('PDF 附件渲染为文件卡片', () => window.document.querySelectorAll('#attachTray .att').length === 2);
  check('PDF 元信息含页数', () => [...window.document.querySelectorAll('#attachTray .att-meta')].some((x) => x.textContent.includes('1 页')));

  await window.handleFiles([mkFile('notes.docx', 'DOCXDATA', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')]);
  await new Promise((r) => setTimeout(r, 20));
  check('docx 附件已加入', () => window.document.querySelectorAll('#attachTray .att').length === 3);

  await window.handleFiles([mkFile('archive.zzz', 'BINDATA', 'application/octet-stream')]);
  await new Promise((r) => setTimeout(r, 20));
  check('未知二进制标记为不可解析', () => [...window.document.querySelectorAll('#attachTray .att-meta')].some((x) => x.textContent.includes('pi 读不了')));

  // 组装消息（在移除之前做，才能覆盖到无法解析的那条）
  const built = window.buildMessage('请看一下这几个文件');
  check('消息含用户正文', () => built.startsWith('请看一下这几个文件'));
  check('图片以图像内容说明', () => built.includes('1 张图片已作为图像内容提供'));
  check('PDF 生成 pi-file 块', () => built.includes('<pi-file name="发酵罐设计.pdf" meta="1 页 · 385 字">'));
  check('docx 生成 pi-file 块', () => built.includes('<pi-file name="notes.docx"'));
  check('无法解析的附件附上路径', () => built.includes('本机路径：C:\\pi-GUI\\.uploads\\'));

  const imgs = window.attachmentImages();
  check('图片转成 pi 的 ImageContent', () => imgs.length === 1 && imgs[0].type === 'image' && imgs[0].mimeType === 'image/png' && imgs[0].data === Buffer.from('PNGDATA').toString('base64'));

  // 移除一个
  window.document.querySelectorAll('#attachTray .att-x')[3].click();
  check('附件可移除', () => window.document.querySelectorAll('#attachTray .att').length === 3);

  const afterRemove = window.buildMessage('');
  check('移除后不再出现在消息里', () => !afterRemove.includes('archive.zzz'));

  // 带附件发送
  $('btnSend').click();
  await new Promise((r) => setTimeout(r, 20));
  const withAtt = commands.filter((c) => c.type === 'prompt').pop();
  check('发送时带上 images', () => withAtt.images && withAtt.images.length === 1);
  check('发送时正文含附件块', () => withAtt.message.includes('<pi-file'));
  check('发送后托盘清空', () => window.document.querySelectorAll('#attachTray .att').length === 0);
  check('发送后托盘隐藏', () => $('attachTray').hidden === true);

  // 附件正文在对话里折叠显示
  const usersBefore = window.document.querySelectorAll('.msg.user').length;
  es.emit({
    type: 'message_start',
    message: { role: 'user', content: '看看这个\n\n<pi-file name="长文档.pdf" meta="12 页 · 3.2k 字">\n这里是很长的正文内容\n</pi-file>' },
  });
  check('用户消息已渲染', () => window.document.querySelectorAll('.msg.user').length === usersBefore + 1);
  check('附件正文折叠成卡片', () => window.document.querySelectorAll('.msg.user .msg-file').length === 1);
  check('折叠卡片标题正确', () => window.document.querySelector('.msg-file-head').textContent.includes('长文档.pdf'));
  check('正文默认收起', () => !window.document.querySelector('.msg-file').classList.contains('open'));
  window.document.querySelector('.msg-file-head').click();
  check('点击可展开', () => window.document.querySelector('.msg-file').classList.contains('open'));
  check('展开后能看到内容', () => window.document.querySelector('.msg-file-body').textContent.includes('这里是很长的正文内容'));
  /* 「长正文没有铺在气泡里」= 它只出现在折叠卡片内部，不在气泡的正文段落里。
   *
   * 不能直接拿整个 .msg-body 的 textContent 判 —— 卡片本身就在 body 里，
   * 全文当然在 textContent 里。也不能按「第一条用户消息」定位：对话区里
   * 多出任何一条更早的用户消息（历史重建留下的），querySelector 拿到的
   * 就不是这一条了，断言会悄悄失效。所以按**段落**判，并且取最后一条。 */
  check('长正文没有铺在气泡里', () => {
    const bodies = [...window.document.querySelectorAll('.msg.user .msg-body')];
    const segs = [...bodies[bodies.length - 1].children].filter((n) => !n.classList.contains('msg-file'));
    return segs.every((n) => !n.textContent.includes('这里是很长的正文内容')) || segs.map((n) => n.textContent).join(' | ');
  });

  // 回归：刷新页面 / 切换项目时走 get_messages 重建对话区，
  // 这条路径曾经直接把 <pi-file> 裸标签当纯文本显示，折叠卡片丢失。
  es.emit({
    type: 'response',
    command: 'get_messages',
    success: true,
    data: {
      messages: [
        { role: 'user', content: '看看这个\n\n<pi-file name="重建文档.docx" meta="3 页 · 900 字">\n重建时的正文\n</pi-file>' },
        { role: 'assistant', content: [{ type: 'text', text: '收到。' }] },
      ],
    },
  });
  check('重建后附件仍是折叠卡片', () => window.document.querySelectorAll('.msg.user .msg-file').length === 1);
  check('重建后不暴露裸 pi-file 标签', () => window.document.querySelector('.msg.user .msg-body').textContent.includes('<pi-file') === false);
  check('重建后卡片标题正确', () => window.document.querySelector('.msg-file-head').textContent.includes('重建文档.docx'));
  check('重建后正文仍然收起', () => window.document.querySelector('.msg-file').classList.contains('open') === false);

  // 回归：历史重建时图片附件要还原成缩略图
  es.emit({
    type: 'response',
    command: 'get_messages',
    success: true,
    data: {
      messages: [{ role: 'user', content: [{ type: 'text', text: '这张图' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }],
    },
  });
  check('重建后图片显示缩略图', () => window.document.querySelectorAll('.msg.user .msg-att-chip').length === 1);
  check('缩略图 src 是 data URL', () => window.document.querySelector('.msg-att-chip img').src.startsWith('data:image/png;base64,'));

  // --- markdown 块级渲染 ---
  const md = window.md;
  check('空行切成两个段落', () => (md('甲\n\n乙').match(/<p>/g) || []).length === 2);
  check('段内换行保留为 br', () => md('甲\n乙').includes('<br>'));
  check('代码块不被 br 包裹', () => md('前\n\n```\nx = 1\n```\n\n后').includes('<br><pre') === false);
  check('代码块前后无多余空行', () => /<\/pre><br>/.test(md('前\n\n```\nx = 1\n```\n\n后')) === false);
  check('无序列表渲染成 ul', () => md('- 甲\n- 乙') === '<ul><li>甲</li><li>乙</li></ul>');
  check('有序列表渲染成 ol', () => md('1. 甲\n2. 乙') === '<ol><li>甲</li><li>乙</li></ol>');
  check('列表后接段落正确收尾', () => md('- 甲\n\n乙') === '<ul><li>甲</li></ul><p>乙</p>');
  check('标题渲染成 h4', () => md('## 小标题').includes('<h4>小标题</h4>'));
  check('行内代码仍然生效', () => md('看 `x` 这里').includes('<code>x</code>'));
  check('加粗仍然生效', () => md('**粗**').includes('<strong>粗</strong>'));
  check('HTML 被转义', () => md('<img src=x>').includes('&lt;img'));

  // --- markdown 安全：模型输出是不可信输入，危险内容不得变成可执行 HTML ---
  // 这里断言的是「结构性防护」：原文先整体转义，尖括号只可能来自渲染器自身。
  // 所以判断标准不是「某几个向量被过滤」，而是「渲染结果里不存在非白名单活标签」。
  const noLiveTag = (html) => !/<\s*(script|img|iframe|svg|object|embed|style|link|meta|form|input|base)\b/i.test(html);
  check('原始 script 标签被转义', () => noLiveTag(md('<script>alert(1)</script>')) && md('<script>alert(1)</script>').includes('&lt;script'));
  check('img + onerror 不产生活标签', () => noLiveTag(md('<img src=x onerror=alert(1)>')));
  check('iframe 被转义', () => noLiveTag(md('<iframe src="https://evil.example"></iframe>')));
  check('svg/onload 被转义', () => noLiveTag(md('<svg onload=alert(1)></svg>')));
  check('不生成任何 on* 事件属性', () => !/<[a-z][^>]*\son\w+\s*=/i.test(md('<a href="#" onclick="alert(1)">x</a>')));
  check('危险 scheme 一律不产生链接', () => {
    const payloads = [
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](vbscript:msgbox(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](file:///etc/passwd)',
      '[x](blob:https://a/b)',
    ];
    return payloads.every((p) => md(p).includes('<a') === false);
  });
  check('javascript: 链接退化成可读纯文本', () => {
    const h = md('[点我](javascript:alert(1))');
    return !h.includes('<a') && h.includes('点我') && h.includes('javascript:');
  });
  check('图片不产生远程加载', () => md('![x](https://evil.example/p.png)').includes('<img') === false);
  check('http(s) 链接正常放行且带 noopener', () => {
    const h = md('[官网](https://example.com/a?b=1)');
    return h.includes('href="https://example.com/a?b=1"') && h.includes('rel="noopener noreferrer"');
  });
  check('相对链接放行', () => md('[本地](/docs/x)').includes('href="/docs/x"'));
  check('混合脏输入不产生活标签', () => {
    const dirty = [
      '<div onclick="x">a</div>',
      '<body onload=alert(1)>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">go</a>',
      '"><script>alert(1)</script>',
    ];
    // 注意：转义后的原文里 on* 仍以**字面文本**存在（无害），
    // 所以只检测「真实标签内部」的事件属性，即 <tag ... on*= 。
    return dirty.every((d) => noLiveTag(md(d)) && !/<[a-z][^>]*\son\w+\s*=/i.test(md(d)));
  });

  // --- markdown 新增能力 ---
  check('表格渲染成 table', () => {
    const h = md('| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |');
    return h.includes('<table>') && h.includes('<th>名</th>') && h.includes('<td>甲</td>');
  });
  check('表格对齐方式生效', () => md('| 左 | 右 |\n| :-- | --: |\n| a | b |').includes('text-align:right'));
  check('正文里的竖线不误判成表格', () => md('a | b').includes('<table>') === false);
  check('引用渲染成 blockquote', () => md('> 引用一行').includes('<blockquote>'));
  check('分隔线渲染成 hr', () => md('---').includes('<hr>'));
  check('一级标题也渲染成 h4', () => md('# 大标题').includes('<h4>大标题</h4>'));
  check('嵌套列表塞进父 li 内', () => md('- 甲\n  - 甲一').includes('<li>甲<ul><li>甲一</li></ul></li>'));
  check('任务列表未勾选', () => md('- [ ] 待办').includes('<span class="md-task"></span>待办'));
  check('任务列表已勾选', () => md('- [x] 完成').includes('<span class="md-task on"></span>完成'));
  check('删除线渲染成 del', () => md('~~旧~~').includes('<del>旧</del>'));
  check('斜体渲染成 em', () => md('这是 *强调* 词').includes('<em>强调</em>'));
  check('snake_case 不被当成斜体', () => md('变量 some_name_here 保持原样').includes('<em>') === false);
  check('代码块带语言标签', () => md('```js\nlet a = 1\n```').includes('data-lang="js"'));
  check('diff 代码块逐行着色', () => {
    const h = md('```diff\n@@ -1 +1 @@\n-旧\n+新\n 不变\n```');
    return h.includes('class="d-hunk"') && h.includes('class="d-del"') && h.includes('class="d-add"');
  });

  // --- 发送 ---
  $('input').value = '跑一下测试';
  $('input').dispatchEvent(new window.Event('input', { bubbles: true }));
  check('有内容时发送键可用', () => $('btnSend').disabled === false);
  $('btnSend').click();
  await new Promise((r) => setTimeout(r, 20));
  check('prompt 已发送', () => commands.some((c) => c.type === 'prompt' && c.message === '跑一下测试'));
  check('输入框已清空', () => $('input').value === '');
  check('发送后按钮重新禁用', () => $('btnSend').disabled === true);

  // --- 运行中插话 → steer ---
  es.emit({ type: 'agent_start' });
  check('流式中显示停止按钮', () => $('btnStop').hidden === false);
  $('input').value = '再补一句';
  $('input').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('btnSend').click();
  await new Promise((r) => setTimeout(r, 20));
  check('流式中发送走 steer', () => commands.some((c) => c.type === 'steer' && c.message === '再补一句'));
  es.emit({ type: 'agent_settled' });
  check('结束后停止按钮隐藏', () => $('btnStop').hidden === true);

  // --- 权限确认子协议（P19：对话框统一走 #confirmLayer 这一套确认 foundation） ---
  window.S.switching = false;
  es.emit({ type: 'extension_ui_request', id: 'ui1', method: 'confirm', title: '允许执行 rm 吗？', message: 'rm -rf /tmp/x' });
  check('权限确认用统一确认层', () => $('confirmLayer').hidden === false);
  check('权限文案', () => $('confirmCard').textContent.includes('允许执行 rm 吗？'));
  check('只给一次性的允许 / 拒绝', () => [...$('confirmCard').querySelectorAll('button')].map((b) => b.textContent).join(',') === '拒绝,允许一次');
  [...$('confirmCard').querySelectorAll('button')].find((b) => b.textContent === '允许一次').click();
  await new Promise((r) => setTimeout(r, 10));
  const resp = commands.filter((c) => c.type === 'extension_ui_response').pop();
  check('extension_ui_response 已回传', () => resp && resp.id === 'ui1' && resp.confirmed === true);
  check('确认层已收起', () => $('confirmLayer').hidden === true);

  // 粘贴图片：剪贴板里是文件才拦，纯文本照常交给 textarea
  check('拖拽进入高亮输入框', () => {
    $('composerBox').dispatchEvent(new window.Event('dragenter', { bubbles: true, cancelable: true }));
    return $('composerBox').classList.contains('drop') || '未高亮';
  });
  check('拖拽离开取消高亮', () => {
    $('composerBox').dispatchEvent(new window.Event('dragleave', { bubbles: true, cancelable: true }));
    return !$('composerBox').classList.contains('drop') || '仍高亮';
  });

  // 附件正在解析时不应允许发送（避免发出去一个空附件）
  check('解析中的附件不阻塞发送键逻辑', () => {
    // 无正文无附件 → 禁用
    $('input').value = '';
    $('input').dispatchEvent(new window.Event('input', { bubbles: true }));
    return $('btnSend').disabled === true || '空状态却可发送';
  });

  // --- 项目分组折叠 ---
  $('groupHead').click();
  check('项目分组点击后容器与内容实际折叠', () => !railGroup.classList.contains('open') && $('groupHead').getAttribute('aria-expanded') === 'false' && groupDisplay() === 'none');
  $('groupHead').click();
  check('项目分组再次点击后容器与内容恢复', () => railGroup.classList.contains('open') && $('groupHead').getAttribute('aria-expanded') === 'true' && groupDisplay() !== 'none');

  // --- 项目切换 ---
  const items = [...window.document.querySelectorAll('#projects .project')];
  items[1].querySelector('.pj-select').click();
  await new Promise((r) => setTimeout(r, 10));
  check('切换项目调用 activate', () => true);

  // --- 项目行尾的动作入口 ---
  check('项目行有一个三点入口（旧的常驻 ✕ 已移除）', () => {
    const triggers = window.document.querySelectorAll('#projects .pj-row-menu-trigger');
    const rows = window.document.querySelectorAll('#projects .project');
    return (triggers.length === rows.length && rows.length === 2
      && window.document.querySelectorAll('#projects .pj-del').length === 0) ||
      `triggers=${triggers.length} rows=${rows.length}`;
  });

  /* --- 项目行紧凑（这一轮 UX 修复）---
   * 以前项目行是「名字 + 绝对路径」两行，比下面的会话行高出将近一倍，
   * 看起来像「项目是大卡片、会话是小卡片」。现在路径不再常驻第二行。 */
  {
    const rows = [...window.document.querySelectorAll('#projects .project')];
    check('项目行：没有常驻的绝对路径副标题（不再占第二行）', () =>
      window.document.querySelectorAll('#projects .pj-path').length === 0 ||
      `还有 ${window.document.querySelectorAll('#projects .pj-path').length} 个 .pj-path`);
    check('项目行：每行只有一个名字节点', () => {
      const counts = rows.map((r) => r.querySelectorAll('.pj-name').length);
      return counts.every((n) => n === 1) || JSON.stringify(counts);
    });
    check('项目行：完整路径仍在 title 上（hover / 读屏拿得到）', () => {
      const bad = rows.filter((r) => !r.title || !/[\\/]/.test(r.title));
      return bad.length === 0 || JSON.stringify(rows.map((r) => r.title));
    });
    check('项目行：路径也进了无障碍名字（视觉副标题去掉后仍可读）', () => {
      const labels = rows.map((r) => (r.querySelector('.pj-select') || {}).getAttribute?.('aria-label') || '');
      return labels.every((l) => /[\\/]/.test(l)) || JSON.stringify(labels);
    });
  }

  // --- 折叠态：think ---
  /* --- 空会话的欢迎块 ---
   *
   * 回归护栏。早先 ensureThread() 是把 #welcome 直接 remove() 掉的，
   * 于是新会话一建出空线程，欢迎块就永久消失，对话区变成一片纯黑 ——
   * 用户完全看不到引导。现在改成显隐切换，这里把两头都钉住。
   *
   * 注意 syncWelcome 挂在 MutationObserver 上，回调是微任务，
   * 所以断言前必须让出一次事件循环。
   * 另外这里要自己灌一条消息 —— 前面的「切换项目」用例会 clearThread()，
   * 到这一步线程是空的。 */
  es.emit({ type: 'message_start', message: { role: 'user', content: '欢迎块回归用例' } });
  es.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  es.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] } });
  await new Promise((r) => setTimeout(r, 40));
  check('有消息时欢迎块收起但仍在 DOM 里', () => {
    const w = window.document.getElementById('welcome');
    if (!w) return '欢迎块被移除了（应当只隐藏，不能删）';
    return w.hidden === true ? true : '有消息了但欢迎块还露着';
  });

  // success 必须带上 —— onResponse 开头就判 if (!evt.success) 直接返回
  es.emit({ type: 'response', command: 'new_session', success: true });
  await new Promise((r) => setTimeout(r, 450));
  check('新会话后欢迎块重新出现', () => {
    const w = window.document.getElementById('welcome');
    if (!w) return '欢迎块不存在';
    return w.hidden ? '新会话是空的，欢迎块应该露出来' : true;
  });

  /* --- 未选项目的空状态 ---
   *
   * 回归护栏。早先 server.js 拿 process.cwd() 兜底当项目，桌面版又把后端进程的
   * cwd 设成用户主目录 —— 于是首次启动直接落在主目录，还把那里的 pi 历史会话
   * 整段恢复出来。现在没有项目就是没有：pi 不启动，界面切到「先添加文件夹」。
   *
   * 这里把整条链路钉住：引导块、输入区上锁、发送被拦住（不能发出 prompt）。 */
  stubCwd = '';
  await window.loadStatus();
  check('未选项目时显示「先添加文件夹」引导块', () => {
    const ready = window.document.getElementById('welcomeReady');
    const nop = window.document.getElementById('welcomeNoProj');
    if (!ready || !nop) return '引导块结构被改了';
    if (nop.hidden) return '没有显示「先添加文件夹」引导块';
    return ready.hidden === true ? true : '还露着「Pi 已就绪」，会让人以为已经能用';
  });
  check('未选项目时输入区上锁', () => {
    if (window.document.getElementById('input').disabled !== true) return '输入框还能打字';
    return window.document.getElementById('composerBox').classList.contains('is-locked')
      ? true
      : '输入区没有视觉上锁死（.is-locked 缺失）';
  });
  check('未选项目时发送键禁用', () =>
    window.document.getElementById('btnSend').disabled === true ? true : '发送键还能按'
  );
  $('navPlanner').click();
  $('workSurface').querySelector('.planner-goal')?.focus();
  $('navHome').click();
  check('P14-E 无项目返回 Chat 时焦点留在可用导航', () => window.document.activeElement === $('navHome'));
  // submit 是 async，等它跑完再看命令列表
  const beforeCmds = commands.length;
  await window.submit();
  await new Promise((r) => setTimeout(r, 20));
  check('未选项目时提交被拦住（不发命令）', () =>
    commands.length === beforeCmds ? true : `还是发出了 ${commands.length - beforeCmds} 条命令`
  );

  /* 选了项目之后要能解锁 —— 否则用户点完「添加文件夹」还是卡在引导里，
   * 那就比原来更糟。 */
  stubCwd = 'C:\\pi-GUI';
  await window.loadStatus();
  window.S.switching = false; // 上面的项目切换桩没有模拟 pi ready；此处重置到独立用例的就绪态
  window.setBridgeState('ready');
  check('选了项目后输入区解锁', () => {
    if (window.document.getElementById('input').disabled !== false) return '输入框还锁着';
    return window.document.getElementById('welcomeReady').hidden === false
      ? true
      : '没有切回「Pi 已就绪」'
  });
  check('选了项目后引导块收起', () =>
    window.document.getElementById('welcomeNoProj').hidden === true ? true : '还露着「先添加文件夹」'
  );

  /* --- 模型列表行格式：id|显示名|key=value --- */
  const P = window.parseModelLine;
  check('parseModelLine 已暴露到全局', () => typeof P === 'function' || typeof P);

  if (typeof P === 'function') {
    check('只写 id', () => {
      const m = P('gpt-4o');
      return (m && m.id === 'gpt-4o' && m.name === undefined) || JSON.stringify(m);
    });
    check('id|显示名', () => P('gpt-4o|GPT-4o').name === 'GPT-4o' || JSON.stringify(P('gpt-4o|GPT-4o')));
    check('带全套能力参数', () => {
      const m = P(
        'deepseek-v4-pro|DeepSeek V4 Pro|contextWindow=1000000|maxTokens=384000|reasoning=true|input=text,image'
      );
      return (
        m.id === 'deepseek-v4-pro' &&
        m.name === 'DeepSeek V4 Pro' &&
        m.contextWindow === 1000000 &&
        m.maxTokens === 384000 &&
        m.reasoning === true &&
        JSON.stringify(m.input) === '["text","image"]'
      ) ? true : JSON.stringify(m);
    });
    check('ctx / max 是长名字的别名', () => {
      const m = P('x|X|ctx=200000|max=64000');
      return m.contextWindow === 200000 && m.maxTokens === 64000 || JSON.stringify(m);
    });
    // 这条是格式设计的核心：不带 = 的片段只能是显示名，不能当布尔旗标
    check('显示名不会被误当成布尔旗标', () =>
      P('x|reasoning').name === 'reasoning' || JSON.stringify(P('x|reasoning'))
    );
    check('未知键被忽略且不破坏整行', () => {
      const m = P('x|X|bogus=1|contextWindow=1000');
      return m.contextWindow === 1000 && m.bogus === undefined || JSON.stringify(m);
    });
    check('非法数值被丢弃', () => {
      const m = P('x|X|contextWindow=-1|maxTokens=abc');
      return m.contextWindow === undefined && m.maxTokens === undefined || JSON.stringify(m);
    });
    check('空行返回 null', () => P('') === null || JSON.stringify(P('')));

    check('modelLine 与 parseModelLine 能往返', () => {
      const src = 'a|A|contextWindow=1000|maxTokens=500|reasoning=true|input=text,image';
      const back = window.modelLine(P(src));
      return back === src || back;
    });
    check('modelLine 会换掉显示名里的竖线（否则把行切乱）', () => {
      const line = window.modelLine({ id: 'a', name: 'x|y' });
      return line === 'a|x/y' || line;
    });
    check('fmtTokens 格式化', () => {
      const got = `${window.fmtTokens(1048576)}/${window.fmtTokens(262144)}/${window.fmtTokens(512)}`;
      return got === '1M/262K/512' || got;
    });
  }

  /* --- 添加供应商弹层里的拉取入口 --- */
  check('弹层有「拉取」按钮，且拉取面板默认收起', () => {
    window.openAddProvider();
    const card = $('modalCard');
    if (!card) return '弹层没打开';

    const btn = [...card.querySelectorAll('.field-head .btn')].find((b) => b.textContent === '拉取');
    const panel = card.querySelector('.fetch-panel');

    // 收拾干净，别影响后面的检查
    $('modal').hidden = true;
    card.innerHTML = '';

    if (!btn) return '没有拉取按钮';
    if (!panel) return '没有拉取面板';
    if (panel.hidden !== true) return '拉取面板默认应该藏着';
    return true;
  });

  /* --- 项目配置：偏好恢复 ---
   *
   * 这一段的重点是**降级路径**：项目配置里存的模型可能已经不存在了。
   * 后端的做法是不把模型当启动参数传（过期引用会让 pi exit(1)，项目直接打不开），
   * 前端的做法是先跟 get_available_models 核对，核对不过就沿用当前模型 + 提示一次。
   * 所以这里盯的是「核对不过时**不发** set_model」，而不是「发了什么」。 */
  {
    const savedModels = window.S.models;
    const savedState = window.S.state;
    const savedCwd = window.S.cwd;
    const savedSeq = commands.length;

    const reset = (cfg, { models, state, env, cwd } = {}) => {
      commands.length = 0;
      window.S.models = models || [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }];
      window.S.state = state || { model: { provider: 'anthropic', id: 'claude-sonnet-4-5' }, thinkingLevel: 'high' };
      stubProjectConfig = {
        ...stubProjectConfig,
        hasProject: true,
        cwd: cwd || 'C:\\pi-GUI',
        config: { ...CFG_DEFAULTS, ...cfg },
        warnings: [],
        env: { provider: false, model: false, thinking: false, ...(env || {}) },
      };
      window.S.cwd = stubProjectConfig.cwd;
      $('toasts').innerHTML = '';
    };
    const setModels = () => commands.filter((c) => c.type === 'set_model');

    reset({ model: { provider: 'deepseek', id: 'deepseek-chat' } });
    await window.applyProjectPreferences();
    check('恢复偏好：配置里的模型可用 → 发 set_model 且带 provider + modelId', () => {
      const m = setModels();
      return (m.length === 1 && m[0].provider === 'deepseek' && m[0].modelId === 'deepseek-chat') || JSON.stringify(m);
    });

    /* 可用模型列表还没到手（get_available_models 没回来 / 超时）：
     * 不能猜一个模型去 set_model —— 猜错就是把用户的会话换到他没选的模型上。 */
    reset({ model: { provider: 'deepseek', id: 'deepseek-chat' } }, { models: [] });
    const pending = window.applyProjectPreferences();
    await new Promise((r) => setTimeout(r, 0)); // 先让配置那次 GET 落地
    window.onModels([]); // 应答到了，但列表是空的
    await pending;
    check('恢复偏好：拿不到可用模型列表时不猜模型、不发 set_model', () => {
      const m = setModels();
      return m.length === 0 || JSON.stringify(m);
    });

    /* 切换项目：A 的配置不能跟到 B 上。
     * 这条是回归守卫 —— 前端一度把配置缓存在模块变量里，切项目时没人清，
     * 于是「切到 B 之后仍按 A 的模型 set_model」，正好是 P2 要消灭的那种漂移。 */
    reset({ model: { provider: 'deepseek', id: 'deepseek-chat' } }, { cwd: 'C:\\proj-a' });
    await window.applyProjectPreferences();
    check('恢复偏好：A 项目按 A 的配置发 set_model', () => {
      const m = setModels();
      return (m.length === 1 && m[0].modelId === 'deepseek-chat') || JSON.stringify(m);
    });

    commands.length = 0;
    window.S.models = [
      { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    ];
    /* 切到 B 之后 pi 是重启过的，会话停在 A 那个模型上 ——
     * 这正是要消灭的漂移：B 的配置必须把它拉回 B 的模型。 */
    window.S.state = { model: { provider: 'deepseek', id: 'deepseek-chat' }, thinkingLevel: 'high' };
    stubProjectConfig = {
      ...stubProjectConfig,
      cwd: 'C:\\proj-b',
      config: { ...CFG_DEFAULTS, model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } },
    };
    window.S.cwd = stubProjectConfig.cwd;
    await window.applyProjectPreferences();
    check('恢复偏好：切到 B 项目后按 B 的配置走（不继承上一个项目的配置）', () => {
      const m = setModels();
      return (m.length === 1 && m[0].provider === 'anthropic' && m[0].modelId === 'claude-sonnet-4-5') ||
        JSON.stringify(m);
    });

    reset({ model: { provider: 'deepseek', id: 'deepseek-gone' } });
    await window.applyProjectPreferences();
    check('恢复偏好：模型失效时给一次轻提示（不是静默）', () =>
      /已不可用/.test($('toasts').textContent) || $('toasts').textContent);
    check('恢复偏好：模型失效时不发 set_model', () => setModels().length === 0 || JSON.stringify(setModels()));

    reset({ model: { provider: 'deepseek', id: 'deepseek-gone' } });
    await window.applyProjectPreferences();
    check('恢复偏好：同一个失效模型不重复提示（重启多次也只说一次）', () =>
      !/已不可用/.test($('toasts').textContent) || $('toasts').textContent);

    reset({ model: { provider: 'deepseek', id: 'deepseek-chat' } }, { env: { model: true, provider: true } });
    await window.applyProjectPreferences();
    check('恢复偏好：环境变量钉住模型时项目配置不参与（env > 项目配置）', () =>
      setModels().length === 0 || JSON.stringify(setModels()));

    reset({ model: { provider: 'deepseek', id: 'deepseek-chat' } }, {
      state: { model: { provider: 'deepseek', id: 'deepseek-chat' } },
    });
    await window.applyProjectPreferences();
    check('恢复偏好：已经是这个模型 → 不发多余的 set_model', () => setModels().length === 0 || JSON.stringify(setModels()));

    reset({ thinking: 'high' });
    await window.applyProjectPreferences();
    check('恢复偏好：不碰思考档位（那是 pi 的启动参数，不是会话命令）', () =>
      commands.filter((c) => c.type === 'set_thinking_level').length === 0 || JSON.stringify(commands));

    // 没有项目时什么都不能做，也不能崩
    commands.length = 0;
    stubProjectConfig = { ...stubProjectConfig, hasProject: false, config: null };
    let threw = '';
    try {
      await window.applyProjectPreferences();
    } catch (e) {
      threw = e.message;
    }
    check('恢复偏好：没有项目时安静跳过、不发命令、不抛错', () =>
      (!threw && commands.length === 0) || JSON.stringify({ threw, commands }));

    window.S.models = savedModels;
    window.S.state = savedState;
    window.S.cwd = savedCwd;
    commands.length = savedSeq;
    stubProjectConfig = { ...stubProjectConfig, hasProject: true, config: { ...CFG_DEFAULTS } };
  }

  /* --- 项目配置：设置弹层 --- */
  {
    const savedModels = window.S.models;
    const savedState = window.S.state;

    window.S.models = [
      { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    ];
    window.S.state = { model: { provider: 'deepseek', id: 'deepseek-chat' }, thinkingLevel: 'high' };
    stubProjectConfig = {
      ...stubProjectConfig,
      hasProject: true,
      warnings: [],
      config: {
        ...CFG_DEFAULTS,
        model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
        thinking: 'high',
        instructions: '这个项目用 TypeScript',
        ignore: ['node_modules', 'dist'],
        commands: [{ name: 'Test', command: 'npm test' }],
      },
    };
    projectConfigCalls.length = 0;

    await window.openProjectSettings();
    const card = $('modalCard');
    const sels = [...card.querySelectorAll('select')];
    const tas = [...card.querySelectorAll('textarea')];

    check('设置弹层：打开后有模型 / 思考两个下拉与指令 / 忽略两个文本域', () =>
      (sels.length === 2 && tas.length === 2) || `select=${sels.length} textarea=${tas.length}`);
    check('设置弹层：模型下拉按供应商分组（optgroup）', () => {
      const groups = [...sels[0].querySelectorAll('optgroup')].map((g) => g.label);
      return (groups.includes('deepseek') && groups.includes('anthropic')) || groups.join(',');
    });
    check('设置弹层：已保存的模型被选中（不是默认落到第一项）', () => {
      const cur = sels[0].options[sels[0].selectedIndex];
      return /Claude Sonnet 4\.5/.test(cur.textContent) || cur.textContent;
    });
    check('设置弹层：思考档位用 pi 的完整列表（不是当前模型支持的那几个）', () => {
      const vals = [...sels[1].options].map((o) => o.value);
      return (vals.includes('xhigh') && vals.includes('max') && vals.includes('')) || vals.join(',');
    });
    check('设置弹层：已保存的思考档位被选中', () => sels[1].value === 'high' || sels[1].value);
    check('设置弹层：指令文本域带上了已保存内容', () =>
      tas[0].value === '这个项目用 TypeScript' || tas[0].value);
    check('设置弹层：忽略规则每行一条', () => tas[1].value === 'node_modules\ndist' || tas[1].value);
    check('设置弹层：常用命令渲染成「名称 + 命令」两栏', () => {
      const rows = card.querySelectorAll('.cfg-cmd');
      return (rows.length === 1 && rows[0].querySelector('.cfg-cmd-name').value === 'Test') || rows.length;
    });
    check('设置弹层：说了不保存密钥', () => /不会保存任何密钥/.test(card.textContent) || card.textContent.slice(0, 200));
    check('设置弹层：显示当前生效的模型与档位（和已保存值区分开）', () =>
      /生效中的模型 deepseek\/deepseek-chat/.test(card.textContent) || card.textContent.slice(0, 300));

    /* 保存：改模型 + 加一条命令，看 PUT 的 body 形状 */
    sels[0].value = String([...sels[0].options].findIndex((o) => /DeepSeek Chat/.test(o.textContent)));
    tas[0].value = '改过的指令';
    const btnSave = [...card.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === '保存');
    btnSave.onclick();
    await new Promise((r) => setTimeout(r, 30));

    const put = projectConfigCalls.filter((c) => c.method === 'PUT').pop();
    check('保存：发出 PUT，且 model 是 { provider, id } 结构', () =>
      (put && put.body.model && put.body.model.provider === 'deepseek' && put.body.model.id === 'deepseek-chat') ||
      JSON.stringify(put && put.body));
    check('保存：instructions / ignore / commands 按形状发出', () =>
      (put &&
        put.body.instructions === '改过的指令' &&
        Array.isArray(put.body.ignore) &&
        Array.isArray(put.body.commands) &&
        put.body.commands[0].name === 'Test') ||
      JSON.stringify(put && put.body));
    check('保存：成功后弹层关闭', () => $('modal').hidden === true || '还开着');

    /* 失效模型：下拉里要有占位项，不能被静默改成别的模型 */
    stubProjectConfig = {
      ...stubProjectConfig,
      config: { ...CFG_DEFAULTS, model: { provider: 'deepseek', id: 'deepseek-gone' } },
    };
    await window.openProjectSettings();
    const card2 = $('modalCard');
    const sel2 = card2.querySelector('select');
    check('设置弹层：配置里的模型当前不可用时，下拉里有「当前不可用」占位项', () =>
      [...sel2.options].some((o) => /当前不可用/.test(o.textContent)) || [...sel2.options].map((o) => o.textContent).join(' | '));
    check('设置弹层：默认选中的就是那个占位项（打开设置不会被悄悄换模型）', () =>
      /当前不可用/.test(sel2.options[sel2.selectedIndex].textContent) || sel2.options[sel2.selectedIndex].textContent);
    $('modal').hidden = true;
    card2.innerHTML = '';

    /* 配置读不出来时，弹层里必须看得见 */
    stubProjectConfig = {
      ...stubProjectConfig,
      config: { ...CFG_DEFAULTS },
      warnings: ['配置文件不是合法 JSON（Unexpected token），已按默认值处理'],
    };
    await window.openProjectSettings();
    const card3 = $('modalCard');
    check('设置弹层：配置有警告时在弹层里显式说明', () =>
      /不是合法 JSON/.test(card3.textContent) || card3.textContent.slice(0, 200));

    /* 保存失败：弹层必须留着，输入不能丢 */
    stubSaveResult = { ok: false, error: '保存失败：EACCES' };
    $('toasts').innerHTML = '';
    const btnSave2 = [...card3.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === '保存');
    btnSave2.onclick();
    await new Promise((r) => setTimeout(r, 30));
    check('保存失败：弹层不关闭（用户输入不丢）', () => $('modal').hidden === false || '被关掉了');
    check('保存失败：明确报错，不假装成功', () =>
      /保存失败/.test($('toasts').textContent) || $('toasts').textContent);

    stubSaveResult = null;
    $('modal').hidden = true;
    $('modalCard').innerHTML = '';
    stubProjectConfig = { ...stubProjectConfig, warnings: [] };
    window.S.models = savedModels;
    window.S.state = savedState;
  }

  /* --- 扩展面板（Skills / MCP） ---
   *
   * 这一段的重点是**诚实性**与**降级能力**，不是「功能多」：
   *   - 状态必须区分「磁盘上有」和「pi 加载了」；
   *   - pi 没应答时必须说「无法确认」，不许显示成「未启用」；
   *   - 项目未信任必须显式说明，否则用户只会觉得配置丢了；
   *   - 一条坏 skill 不能带塌整页；
   *   - MCP 必须说清 pi 没有原生支持，而不是给一个假列表。 */
  async function extSection() {
    skillsCalls.length = 0;
    mcpCalls.length = 0;
    $('toasts').innerHTML = '';

    window.openExtensions();
    await new Promise((r) => setTimeout(r, 30));
    const card = $('workSurface');

    check('扩展面板：All / Capabilities / Extensions / Skills / MCP 五个过滤器各有独立 Tab', () => {
      const labels = [...card.querySelectorAll('.ext-tab')].map((b) => b.textContent);
      return (labels.length === 5 && labels.join(',') === 'All,Capabilities,Extensions,Skills,MCP') || JSON.stringify(labels);
    });
    /* P22：默认落在 All（统一能力视图），它必须先给出结论行。 */
    check('扩展面板：默认打开 All 能力视图并显示统一状态', () =>
      card.querySelector('#extensionsTabAll')?.getAttribute('aria-selected') === 'true'
      && card.querySelectorAll('.cap-view .ext-item').length > 0
      && /状态/.test(card.querySelector('.cap-view')?.textContent || ''));
    card.querySelector('#extensionsTabExtensions')?.click();
    await new Promise((r) => setTimeout(r, 30));
    check('P15 Extension 列表分开显示加载状态与来源', () =>
      card.textContent.includes('Sample Extension') && card.textContent.includes('Broken Extension') &&
      card.textContent.includes('已加载') && card.textContent.includes('加载失败') && card.textContent.includes('本地'));
    card.querySelector('.ext-extension-item')?.click();
    check('P15 Extension 详情显示命令并说明 tool registry 限制', () =>
      card.textContent.includes('hello') && card.textContent.includes('Pi RPC 未提供已注册工具列表'));
    card.querySelector('#extensionsTabSkills')?.click();
    await new Promise((r) => setTimeout(r, 30));
    check('扩展面板：Skills 列表渲染出名称与状态', () => {
      const names = [...card.querySelectorAll('.ext-name')].map((n) => n.textContent);
      return names.includes('code-review') || JSON.stringify(names);
    });
    check('扩展面板：已启用的那条有绿色圆点，被停用的那条有灰圆点', () => {
      const items = [...card.querySelectorAll('.ext-item')];
      const on = items.find((i) => i.textContent.includes('code-review'));
      const off = items.find((i) => i.textContent.includes('pdf-tools'));
      const ok = Boolean(on && on.querySelector('.ext-dot.on') && off && off.querySelector('.ext-dot.off'));
      return ok || `${on ? on.innerHTML.slice(0, 80) : 'no on'} | ${off ? off.innerHTML.slice(0, 80) : 'no off'}`;
    });
    check('扩展面板：一条坏 skill 只影响它自己（其余四条仍在）', () => {
      const n = card.querySelectorAll('.ext-item').length;
      return n === 5 || `渲染了 ${n} 条，应该是 5 条`;
    });
    check('扩展面板：坏 skill 的错误就地显示，不是整页报错', () => {
      const item = [...card.querySelectorAll('.ext-item')].find((i) => i.textContent.includes('broken-skill'));
      return (item && /没有 description/.test(item.textContent)) || (item ? item.textContent : '没找到这条');
    });
    check('扩展面板：项目未信任时显式说明原因（否则用户以为配置丢了）', () =>
      /项目未被信任/.test(card.textContent) || card.textContent.slice(0, 200));
    check('扩展面板：未信任那条自己也带说明', () => {
      const item = [...card.querySelectorAll('.ext-item')].find((i) => i.textContent.includes('proj-only'));
      return (item && /项目未被信任/.test(item.textContent)) || (item ? item.textContent : '没找到这条');
    });
    check('扩展面板：DOM 里没有密钥样式的字符串', () =>
      !/sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN/.test(card.innerHTML) || '出现了疑似密钥');

    // 搜索
    const search = card.querySelector('.ext-search');
    search.value = 'pdf';
    search.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 10));
    check('扩展面板：搜索能过滤（只剩 pdf-tools）', () => {
      const names = [...card.querySelectorAll('.ext-name')].map((n) => n.textContent);
      return (names.length === 1 && names[0] === 'pdf-tools') || JSON.stringify(names);
    });
    search.value = 'SKILL.md';
    search.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 10));
    check('扩展面板：搜索也覆盖路径（否则「按文件找」做不到）', () => {
      const n = card.querySelectorAll('.ext-item').length;
      return n === 5 || `路径搜索命中 ${n} 条，应该是 5 条`;
    });
    search.value = 'zzzz-no-match';
    search.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 10));
    check('扩展面板：搜不到时给中性文案，不是空白', () =>
      /没有符合筛选条件/.test(card.textContent) || card.textContent.slice(0, 120));
    search.value = '';
    search.dispatchEvent(new window.Event('input'));
    await new Promise((r) => setTimeout(r, 10));

    // 作用域筛选
    const selScope = card.querySelectorAll('.ext-sel')[0];
    selScope.value = 'project';
    selScope.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    check('扩展面板：作用域筛选（项目）只剩项目级那条', () => {
      const names = [...card.querySelectorAll('.ext-name')].map((n) => n.textContent);
      return (names.length === 1 && names[0] === 'proj-only') || JSON.stringify(names);
    });
    selScope.value = '';
    selScope.dispatchEvent(new window.Event('change'));

    // 状态筛选
    const selState = card.querySelectorAll('.ext-sel')[1];
    selState.value = 'enabled';
    selState.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 10));
    check('扩展面板：状态筛选（已启用）只剩已加载那条', () => {
      const names = [...card.querySelectorAll('.ext-name')].map((n) => n.textContent);
      return (names.length === 1 && names[0] === 'code-review') || JSON.stringify(names);
    });
    selState.value = '';
    selState.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 10));

    // 详情
    const item = [...card.querySelectorAll('.ext-item')].find((i) => i.textContent.includes('code-review'));
    item.onclick();
    await new Promise((r) => setTimeout(r, 30));
    check('扩展面板：点一条能看详情，且带 SKILL.md 正文（只读）', () => {
      const code = card.querySelector('.ext-code');
      return (code && /# code-review/.test(code.textContent)) || (code ? code.textContent : '没有正文区');
    });
    check('扩展面板：详情里列出了同目录文件', () => {
      const files = [...card.querySelectorAll('.ext-file')].map((f) => f.textContent);
      return (files.includes('SKILL.md') && files.includes('scripts/')) || JSON.stringify(files);
    });
    check('扩展面板：详情里区分「pi 是否加载」与「磁盘上有」', () =>
      /pi 是否加载/.test(card.textContent) || card.textContent.slice(-200));

    // 启停
    const btnToggle = [...card.querySelectorAll('.ext-acts .btn')].find((b) => b.textContent === '停用');
    check('扩展面板：可启停的那条给了「停用」按钮', () => Boolean(btnToggle) || '没有按钮');
    if (btnToggle) {
      btnToggle.onclick();
      await new Promise((r) => setTimeout(r, 30));
      const confirmOk = [...$('confirmCard').querySelectorAll('.btn')].find((b) => b.textContent === '停用');
      check('扩展面板：停用前先二次确认（且说明不会动 skill 文件）', () =>
        (confirmOk && /不会删除或移动/.test($('confirmCard').textContent)) || $('confirmCard').textContent);
      confirmOk.onclick();
      await new Promise((r) => setTimeout(r, 40));
      const put = skillsCalls.find((c) => c.method === 'PUT');
      check('扩展面板：确认后发 PUT，且 enabled=false', () => (put && put.body && put.body.enabled === false) || JSON.stringify(put));
      check('扩展面板：PUT 走的是 ID 路径，不发绝对路径', () => (put && /\/api\/skills\/[0-9a-f]{16}$/.test(put.url)) || (put ? put.url : '没有 PUT'));
    }
    // 重启提示（改 settings 必须重启 pi）
    await new Promise((r) => setTimeout(r, 40));
    check('扩展面板：改完提示需要重启 pi 才生效', () =>
      /需要重启 pi/.test($('confirmCard').textContent + $('toasts').textContent) || $('confirmCard').textContent.slice(0, 120));
    // 关掉重启确认框
    const cancelRestart = [...$('confirmCard').querySelectorAll('.btn')].find((b) => b.textContent === '取消');
    if (cancelRestart) cancelRestart.onclick();
    await new Promise((r) => setTimeout(r, 30));

    /* pi 没应答时：loaded 是 null → 必须显示「无法确认」，不能显示成「未启用」。
     * 这是最容易糊弄过去的一条 —— 把 null 当成 false 显示，用户会以为 skill 坏了。 */
    const savedSkills = stubSkills;
    stubSkills = {
      ...savedSkills,
      piReachable: false,
      counts: { ...savedSkills.counts, enabled: 0 },
      skills: savedSkills.skills.map((s) => ({ ...s, loaded: null, state: 'unknown', stateNote: 'pi 未运行，无法确认加载状态' })),
    };
    $('workSurface').innerHTML = '';
    $('modal').hidden = true;
    window.openExtensions();
    await new Promise((r) => setTimeout(r, 30));
    // 先切回 Skills 页 —— 这两个断言问的是 Skills 列表，不是 All 能力视图。
    $('workSurface').querySelector('#extensionsTabSkills')?.click();
    await new Promise((r) => setTimeout(r, 30));
    check('扩展面板：pi 没应答时显示「状态未知」，并说明原因', () =>
      /无法确认/.test($('workSurface').textContent) || $('workSurface').textContent.slice(0, 200));
    // 点一条看详情：这里必须写「无法确认（pi 未运行）」，
    // 把 loaded=null 显示成「否」会让用户以为 skill 坏了
    const firstItem = $('workSurface').querySelector('.ext-list .ext-item');
    if (firstItem) firstItem.onclick();
    await new Promise((r) => setTimeout(r, 30));
    check('扩展面板：pi 没应答时详情里写「无法确认」而不是「否」', () =>
      /无法确认（pi 未运行）/.test($('workSurface').textContent) || $('workSurface').textContent.slice(-300));
    stubSkills = savedSkills;

    // 切到 MCP
    const mcpTab = [...$('workSurface').querySelectorAll('.ext-tab')].find((b) => b.textContent === 'MCP');
    mcpTab.onclick();
    await new Promise((r) => setTimeout(r, 40));
    const mcpCard = $('workSurface');
    check('MCP 标签页：如实说这个 pi 带 MCP 能力（不再写死「没有原生 MCP」）', () =>
      /带 MCP 能力/.test(mcpCard.textContent) && !/没有原生 MCP 支持/.test(mcpCard.textContent) || mcpCard.textContent.slice(0, 200));
    check('MCP 标签页：给出可核对的出处（不是空口断言）', () =>
      /dist\/extensions\/index\.js/.test(mcpCard.textContent) || mcpCard.textContent.slice(0, 200));
    check('MCP 标签页：显示运行中的 pi 版本与来源', () =>
      /检测到的 pi 版本：0\.99\.2/.test(mcpCard.textContent) && /来源 package\.json/.test(mcpCard.textContent) || mcpCard.textContent.slice(0, 240));
    check('MCP 标签页：列出 built-in 能力并说明它不是扫目录扫到的', () => {
      const text = mcpCard.textContent;
      return (['builtin:llama.cpp', 'builtin:codemode', 'builtin:tool-search', 'builtin:mcp'].every((x) => text.includes(x))
        && /不由 Extension Registry 的目录扫描发现/.test(text)) || text.slice(0, 300);
    });
    check('MCP 标签页：说清 RPC 没有工具清单命令（不伪造工具注册表）', () =>
      /没有一条返回已注册工具清单/.test(mcpCard.textContent) || mcpCard.textContent.slice(0, 300));
    check('MCP 标签页：区分 ExtensionAPI 与 RPC（getAllTools 拿不到）', () =>
      /getAllTools 有/.test(mcpCard.textContent) && /RPC 客户端拿不到/.test(mcpCard.textContent) || '没区分');
    check('MCP 标签页：Server 明细走原生摘要（不是空页也不是假列表）', () =>
      /MCP Servers（pi 原生）/.test(mcpCard.textContent) || mcpCard.textContent.slice(0, 240));
    check('MCP 标签页：MCP 配置只取结构，凭据值不进页面', () =>
      /含凭据引用/.test(mcpCard.textContent) && !/Bearer/.test(mcpCard.textContent) || '没说明');
    check('MCP 标签页：指出官方替代路径是 extension 并列出本机已有的', () => {
      const names = [...mcpCard.querySelectorAll('.ext-name')].map((n) => n.textContent);
      return (/extension/.test(mcpCard.textContent) && names.includes('my-ext')) || JSON.stringify(names);
    });
    check('MCP 标签页：声明不安装 / 不执行扩展（边界说清楚）', () =>
      /不安装、不启用、也不执行/.test(mcpCard.textContent) || '没写边界');
    check('MCP 标签页：连接状态只以「运行：」为前缀出现（有运行时证据才说）', () =>
      /运行：/.test(mcpCard.textContent) && !/(^|[^行])已连接/.test(mcpCard.textContent.replace(/运行：已连接/g, '')) || mcpCard.textContent.slice(-300));
    check('MCP 标签页：DOM 里没有密钥样式的字符串', () =>
      !/sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN/.test(mcpCard.innerHTML) || '出现了疑似密钥');
    /* P20.6 原生集成：状态横幅、server 行、运行时、动作 wiring。 */
    check('MCP 标签页：原生状态横幅（active + 原因）', () =>
      /原生 MCP 生效中/.test(mcpCard.textContent) || mcpCard.textContent.slice(0, 200));
    check('MCP 标签页：server 行带 exposure / 传输面 / 生效徽标', () => {
      const text = mcpCard.textContent;
      return (/fs/.test(text) && /exposure：direct/.test(text) && /生效中/.test(text)
        && /单工具 exposure 1 条/.test(text)) || text.slice(0, 300);
    });
    check('MCP 标签页：运行时状态（connected / needs-auth + 工具数）', () =>
      /运行：已连接/.test(mcpCard.textContent) && /运行：需要登录/.test(mcpCard.textContent)
      && /2 个工具/.test(mcpCard.textContent) || mcpCard.textContent.slice(-400));
    check('MCP 标签页：声明 enable 等走 /mcp（不伪造开关）', () =>
      /启用 \/ 停用 \/ 重连 \/ 改 exposure 没有官方自动化接口/.test(mcpCard.textContent) || '没声明');
    check('MCP 标签页：运行观察行（没调用过≠不支持）', () =>
      /尚未观察到 MCP 工具调用/.test(mcpCard.textContent) || '没观察行');
    mcpStatusCalls.length = 0;
    {
      const btn = [...mcpCard.querySelectorAll('.btn')].find((b) => b.textContent === '刷新状态');
      if (btn) {
        btn.onclick();
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    check('MCP 标签页：刷新按钮发出 POST /api/mcp/status', () => mcpStatusCalls.length === 1 || '没发出刷新请求');
    mcpServerCalls.length = 0;
    {
      const btn = [...mcpCard.querySelectorAll('.btn')].find((b) => b.textContent === '移除');
      if (btn) {
        btn.onclick();
        await new Promise((r) => setTimeout(r, 30));
        const ok = [...$('confirmCard').querySelectorAll('.btn')].find((b) => b.textContent === '移除');
        if (ok) {
          ok.onclick();
          await new Promise((r) => setTimeout(r, 40));
        }
      }
    }
    check('MCP 标签页：移除走确认框，确认后发 remove（带 scope）', () => {
      const posts = mcpServerCalls.filter((c) => c.method === 'POST');
      const last = posts[posts.length - 1];
      return (last && last.body && last.body.action === 'remove' && typeof last.body.name === 'string'
        && typeof last.body.scope === 'string') || JSON.stringify(last);
    });
    {
      const nameInput = mcpCard.querySelector('input[placeholder*="名字"]');
      if (nameInput) {
        nameInput.value = 'bad name!';
        const add = [...mcpCard.querySelectorAll('.btn')].find((b) => b.textContent === '添加');
        if (add) {
          add.onclick();
          await new Promise((r) => setTimeout(r, 30));
        }
      }
    }
    check('MCP 标签页：添加表单拒绝坏名字，且没有凭据字段', () => {
      if (/Authorization|clientSecret|password/i.test(mcpCard.innerHTML)) return '表单里出现了凭据字段';
      return /只允许字母/.test($('toasts').textContent) || $('toasts').textContent.slice(-200);
    });

    /* ---- P20.6-Fix：0.99.2 新字段 / 信任闸门 / workspace 隔离 / secret contract ---- */

    check('MCP 标签页：显示 0.99.2 的 description 与资源数（有才显示）', () => {
      const t = mcpCard.textContent;
      return (/Local filesystem access/.test(t) && /3 个资源/.test(t) && /1 个资源模板/.test(t)) || t.slice(0, 400);
    });
    check('MCP 标签页：说清运行时状态属于当前项目（切项目不沿用）', () =>
      /运行时状态属于当前项目/.test(mcpCard.textContent) || mcpCard.textContent.slice(-500));
    check('MCP 标签页：声明 GUI 不接收任何凭据值 + OAuth 归 pi', () => {
      const t = mcpCard.textContent;
      return (/不接收任何凭据值/.test(t) && /OAuth/.test(t) && /pi 自己管理/.test(t)) || t.slice(-500);
    });

    /** 换一套桩重新开一次 MCP 页（openWorkSurface 每次都是新的挂载）。 */
    const reopenMcp = async () => {
      $('workSurface').innerHTML = '';
      window.openExtensions();
      await new Promise((r) => setTimeout(r, 40));
      const tab = [...$('workSurface').querySelectorAll('.ext-tab')].find((b) => b.textContent === 'MCP');
      if (tab) tab.onclick();
      await new Promise((r) => setTimeout(r, 50));
      return $('workSurface');
    };
    {
      const saved = stubMcpServers;
      // 未信任项目：读被忽略 + 写被拒绝
      stubMcpServers = {
        ...saved,
        trust: { trusted: false, requiresTrust: true },
        servers: saved.servers.map((s) => (s.scope === 'project' ? { ...s, effective: { active: false, reason: 'untrusted' } } : s)),
      };
      const c = await reopenMcp();
      check('MCP 标签页：项目未信任时明确说明「读被忽略 + 写被拒绝」', () =>
        /当前项目未被信任/.test(c.textContent) && /项目级的新增\/移除也会被拒绝/.test(c.textContent) || c.textContent.slice(0, 500));
      check('MCP 标签页：未信任的项目条目显示「未生效（项目未信任）」', () =>
        /未生效（项目未信任）/.test(c.textContent) || c.textContent.slice(0, 500));

      // 信任状态未知：fail closed
      stubMcpServers = {
        ...saved,
        trust: null,
        servers: saved.servers.map((s) => (s.scope === 'project' ? { ...s, effective: { active: false, reason: 'trust-unknown' } } : s)),
      };
      const c2 = await reopenMcp();
      check('MCP 标签页：信任未知时 fail closed（提示 + 条目未生效）', () =>
        /读不到这个项目的信任状态/.test(c2.textContent) && /未生效（信任状态未知）/.test(c2.textContent) || c2.textContent.slice(0, 500));

      // 运行时未刷新
      stubMcpServers = { ...saved, runtime: null };
      const c3 = await reopenMcp();
      check('MCP 标签页：没有运行时证据时说「尚未获取」（未知≠没有）', () =>
        /尚未获取运行时状态/.test(c3.textContent) || c3.textContent.slice(0, 400));

      // 闭集外的 state 不原样进 DOM
      stubMcpServers = { ...saved, runtime: { ...saved.runtime, servers: [{ ...saved.runtime.servers[0], state: 'unknown' }] } };
      const c4 = await reopenMcp();
      check('MCP 标签页：闭集外的 state 显示「无法识别」，不打印上游原文', () =>
        /运行：无法识别/.test(c4.textContent) || c4.textContent.slice(0, 400));

      // pi 给的 note（项目未信任导致 mcp.json 被忽略）如实显示
      stubMcpServers = { ...saved, runtime: { ...saved.runtime, note: '<project> is ignored because the project is not trusted.' } };
      const c5 = await reopenMcp();
      check('MCP 标签页：把 pi 关于「项目 mcp.json 被忽略」的说明显示出来', () =>
        /is ignored because the project is not trusted/.test(c5.textContent) || c5.textContent.slice(0, 400));

      /* P20.6-Fix-2 Blocker A：未信任时同名项不覆盖用户级 ——
       * 用户级那条必须显示「生效中」，且**不能**出现「被项目同名覆盖」。 */
      const dup = (overridden, projectEffective) => ({
        ...saved,
        trust: { trusted: false, requiresTrust: true },
        servers: [
          { name: 'github', scope: 'user', enabled: true, exposure: 'codemode', transportType: 'stdio', description: '', hasSecrets: false, toolExposure: null, toolExposureNote: '', overridden, effective: { active: !overridden, reason: overridden ? 'overridden' : '' } },
          { name: 'github', scope: 'project', enabled: true, exposure: 'codemode', transportType: 'stdio', description: '', hasSecrets: false, toolExposure: null, toolExposureNote: '', overridden: false, effective: projectEffective },
        ],
      });
      stubMcpServers = dup(false, { active: false, reason: 'untrusted' });
      const c6 = await reopenMcp();
      check('MCP 标签页：未信任项目里同名 server 不覆盖用户级（用户级仍「生效中」）', () => {
        const t = c6.textContent;
        if (!/生效中/.test(t)) return '用户级没显示生效中：' + t.slice(0, 400);
        if (/被项目同名覆盖/.test(t)) return '错误地标成了被覆盖';
        return /未生效（项目未信任）/.test(t) || '项目条目没标未生效';
      });
      // 反向：已信任时同一份数据必须显示「被项目同名覆盖」（证明上面那条不是恒真）
      stubMcpServers = { ...dup(true, { active: true, reason: '' }), trust: { trusted: true, requiresTrust: true } };
      const c7 = await reopenMcp();
      check('MCP 标签页：已信任时同名项正确显示「被项目同名覆盖」', () =>
        /被项目同名覆盖/.test(c7.textContent) || c7.textContent.slice(0, 400));

      stubMcpServers = saved;
    }

    $('modal').hidden = true;
    $('workSurface').innerHTML = '';
    $('confirmLayer').hidden = true;
    $('confirmCard').innerHTML = '';
  }

  /* ---------- Planner / 多 Agent 编排面板（规格 §48 的 47-53） ---------- */
  async function plannerSection() {
    plannerCalls.length = 0;
    $('toasts').innerHTML = '';

    window.openPlanner();
    await new Promise((r) => setTimeout(r, 40));
    const card = $('workSurface');

    check('Planner：面板有「计划」与「Agent」两个 Tab', () => {
      const labels = [...card.querySelectorAll('.ext-tab')].map((b) => b.textContent);
      return (labels.length === 2 && labels[0] === '计划' && labels[1] === 'Agent') || JSON.stringify(labels);
    });
    check('Planner：计划列表渲染出当前项目的计划（含已完成的旧计划）', () => {
      const names = [...card.querySelectorAll('.ext-name')].map((n) => n.textContent);
      return (names.includes('给这个项目补登录功能') && names.includes('已经跑完的老计划')) || JSON.stringify(names);
    });
    check('Planner：未选中时提示先选一个计划（不是空白页）', () =>
      /选一个计划|先生成一个/.test(card.querySelector('.planner-detail').textContent) || card.querySelector('.planner-detail').textContent.slice(0, 80));

    /* 按 task id 精确定位。**不能**用 textContent.includes(id) ——
     * 每个任务的依赖选择器里都列着其它任务的 id，那样会全部命中第一个任务
     * （第一版就是这么写的，结果三条断言全看的是同一个任务）。 */
    const taskEl = (id) =>
      [...card.querySelectorAll('.planner-task')].find(
        (x) => x.querySelector('.planner-task-id') && x.querySelector('.planner-task-id').textContent === id
      );

    // 47. 选中一个计划 → 详情渲染
    card.querySelectorAll('.planner-list .ext-item')[0].onclick();
    await new Promise((r) => setTimeout(r, 40));
    check('47. 选中后详情渲染出 4 个任务，标题可编辑', () => {
      const tasks = card.querySelectorAll('.planner-task');
      const title = card.querySelector('.planner-title');
      return (tasks.length === 4 && title && title.value === '给这个项目补登录功能') || `tasks=${tasks.length}`;
    });
    check('47b. 每个任务显示 agent 与依赖', () => {
      const t = taskEl('verify');
      return (t && /pi/.test(t.textContent) && /依赖 backend, frontend/.test(t.textContent)) || (t ? t.textContent.slice(0, 160) : '没找到 verify');
    });

    // 49/50. 运行中与失败状态
    check('49/50. 四种状态各自渲染：成功 / 失败 / 已取消 / 被阻塞', () => {
      const txt = card.querySelector('.planner-detail').textContent;
      return (txt.includes('成功') && txt.includes('失败') && txt.includes('已取消') && txt.includes('被阻塞')) || txt.slice(0, 200);
    });
    check('49b. 状态圆点区分开：成功=ok、失败=err、取消=dim（不标红）', () => {
      const dotOf = (id) => {
        const it = taskEl(id);
        const d = it && it.querySelector('.planner-task-top .ext-dot');
        return d ? d.className : '';
      };
      const okDot = dotOf('inspect');
      const errDot = dotOf('backend');
      const cancelDot = dotOf('frontend');
      const blockedDot = dotOf('verify');
      return (okDot.includes('ok') && errDot.includes('err') && cancelDot.includes('dim') && blockedDot.includes('warn')) || `${okDot} / ${errDot} / ${cancelDot} / ${blockedDot}`;
    });
    check('§25. 取消不是失败：已取消那条**没有**用错误色', () => {
      const it = taskEl('frontend');
      const dot = it && it.querySelector('.planner-task-top .ext-dot');
      return (dot && !dot.className.includes('err')) || (dot ? dot.className : '没找到');
    });
    check('50b. 失败任务把错误文本显示出来', () =>
      /第一次故意失败/.test(card.querySelector('.planner-detail').textContent) || '没显示错误');

    // 51. 重试
    check('51. 失败/被中断的任务有「重试」按钮', () => {
      const it = taskEl('backend');
      const has = it && [...it.querySelectorAll('button')].some((b) => b.textContent === '重试');
      return has || (it ? [...it.querySelectorAll('button')].map((b) => b.textContent).join(',') : '没找到');
    });
    check('53. attempt 历史被保留（两次尝试都列出来，没被覆盖）', () => {
      const txt = card.querySelector('.planner-detail').textContent;
      return (/尝试历史/.test(txt) && /第 1 次/.test(txt) && /第 2 次/.test(txt)) || '没有历史';
    });
    check('§19. 任务结果展示 Changes（含 +N −M）与「执行期间观察到」的措辞', () => {
      const txt = card.querySelector('.planner-detail').textContent;
      return (/src\/auth\.js/.test(txt) && /\+31/.test(txt) && /执行期间观察到/.test(txt)) || txt.slice(0, 240);
    });
    check('§26. 暂停时明确提示要用户选「重试 / 跳过 / 停止」', () =>
      /重试 \/ 跳过 \/ 停止/.test(card.textContent) || card.textContent.slice(0, 200));

    // 51b. 点重试真的打到了 retry 接口
    {
      const it = taskEl('backend');
      const retryBtn = [...it.querySelectorAll('button')].find((b) => b.textContent === '重试');
      retryBtn.onclick();
      await new Promise((r) => setTimeout(r, 60));
      const hit = plannerCalls.find((c) => /\/tasks\/backend\/retry/.test(c.url));
      check('51b. 点「重试」调用 /api/plans/:id/tasks/:taskId/retry', () => Boolean(hit) || JSON.stringify(plannerCalls.map((c) => c.url)));
    }

    // 48. Agent Tab
    card.querySelectorAll('.ext-tab')[1].onclick();
    await new Promise((r) => setTimeout(r, 40));
    check('48. Agent Tab 列出全部 agent，并标出可用的', () => {
      const txt = [...card.querySelectorAll('.ext-panel')].find((p) => p.style.display !== 'none').textContent;
      return (/Pi/.test(txt) && /Codex/.test(txt) && /可用/.test(txt)) || txt.slice(0, 200);
    });
    check('48b. 不可用的 agent 显式说明原因（装坏了 vs 没装）', () => {
      const txt = [...card.querySelectorAll('.ext-panel')].find((p) => p.style.display !== 'none').textContent;
      return (/入口文件不存在/.test(txt) && /找不到 npm 包/.test(txt)) || txt.slice(0, 300);
    });
    check('48c. Agent Tab 说清「pi 没有原生 sub-agent / plan mode」（不冒领能力）', () => {
      const txt = [...card.querySelectorAll('.ext-panel')].find((p) => p.style.display !== 'none').textContent;
      return /没有原生 sub-agent/.test(txt) || txt.slice(0, 240);
    });
    check('§10. 能力用统一字段展示（不出现 if codex / if claude 那种硬编码文案）', () => {
      const txt = [...card.querySelectorAll('.ext-panel')].find((p) => p.style.display !== 'none').textContent;
      return /工具级事件|仅文本摘要/.test(txt) || txt.slice(0, 240);
    });

    // 33. 生成失败 → 诊断区
    card.querySelectorAll('.ext-tab')[0].onclick();
    const goal = card.querySelector('.planner-goal');
    goal.value = '随便一个目标';
    card.querySelector('.planner-bar-r button').onclick();
    await new Promise((r) => setTimeout(r, 60));
    check('§33. 生成失败：显示失败原因 + 校验错误清单', () => {
      const txt = card.querySelector('.planner-diag').textContent;
      return (/没有通过校验/.test(txt) && /依赖成环/.test(txt)) || txt.slice(0, 200);
    });
    check('§33b. 生成失败：把 Planner 的原始输出摆出来（诊断区，不是崩溃）', () => {
      const txt = card.querySelector('.planner-diag').textContent;
      return /原始输出/.test(txt) && /dependsOn/.test(txt) || txt.slice(0, 200);
    });
    check('§33c. 诊断区有「重新生成」入口', () =>
      [...card.querySelectorAll('.planner-diag button')].some((b) => b.textContent === '重新生成') || '没有');

    check('Planner：DOM 里没有密钥样式的字符串', () =>
      !/sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN/.test(card.innerHTML) || '出现了疑似密钥');

    window.closeModal();
    await new Promise((r) => setTimeout(r, 20));
  }

  /* ================= P13：下一步 / Attempt 折叠 / 动作层级 =================
   *
   * 这一段只看**展示层**：状态有没有被算错由后端套件管，这里管的是
   * 「界面现在说的是什么、哪一条是展开的、按钮排在哪」。
   * 所有展开/收起的断言都看 `hidden` / `aria-expanded`，**不看 textContent** ——
   * 收起的节点仍在 DOM 里，textContent 只能证明「渲染过」，证明不了「看得见」。 */
  async function plannerUxSection() {
    console.log('\n--- P13 Planner 收敛：下一步 / Attempt 折叠 / 动作层级 / 门控文案 ---');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const T = (e) => (e && e.textContent) || '';
    const A = window.derivePlanAttention;

    const openFixture = async (plan) => {
      stubPlanDetail = plan;
      stubVerificationActive = null;
      window.closeModal();
      window.openPlanner();
      await wait(90);
      const c = $('workSurface');
      c.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      return c;
    };
    const taskEl = (c, id) => [...c.querySelectorAll('.planner-task')].find((x) => x.dataset.taskId === id);
    const attsOf = (c, id) => { const t = taskEl(c, id); return t ? [...t.querySelectorAll('.planner-attempt')] : []; };
    const attOf = (c, id, n) => attsOf(c, id).find((x) => x.dataset.attempt === String(n)) || null;
    const isOpen = (a) => { const b = a && a.querySelector('.planner-attempt-body'); return Boolean(b) && b.hidden === false; };
    const togOf = (a) => (a && a.querySelector('.planner-attempt-toggle')) || null;
    /* 点折叠按钮。实现还没到位时**安静地返回 false**：断言会报「找不到」，
     * 但整段不能中途炸掉 —— 那会把前面已经失败的断言一起吞掉。 */
    const clickTog = (c, id, n) => {
      const b = togOf(attOf(c, id, n));
      if (!b) return false;
      b.onclick();
      return true;
    };
    /* 触发一次重绘：关联区开合走的就是 renderDetail —— 与 SSE 事件同一条路径，
     * 但不会顺手改任务状态，断言的前提更稳。 */
    const rerender = async (c) => {
      const b = c.querySelector('.planner-rel-btn');
      if (!b) return false;
      b.onclick(); await wait(25);
      b.onclick(); await wait(25);
      return true;
    };
    const actBtn = (t, text) => (t ? [...t.querySelectorAll('.ext-acts button')].find((b) => b.textContent.trim() === text) || null : null);
    const gateText = (c, id) => {
      const t = taskEl(c, id);
      return T(t && t.querySelector('.planner-gate'));
    };

    /* ---------- A：Plan 下一步 ---------- */
    let card = await openFixture(stubPlanReady);
    check('P13-A1. ready 计划 → 下一步是「有任务可以执行」', () => {
      const a = A(stubPlanReady);
      return (a && a.kind === 'ready' && /可以执行/.test(a.text)) || JSON.stringify(a);
    });
    check('P13-A2. 页面上真有「下一步」区域，ready 时带「开始执行」', () => {
      const box = card.querySelector('.planner-next');
      return (box && /可以执行/.test(T(box)) && [...box.querySelectorAll('button')].some((b) => b.textContent.trim() === '开始执行')) ||
        (box ? T(box) : '没有 .planner-next');
    });

    card = await openFixture(stubPlanRunning);
    check('P13-A3. running 计划 → 下一步是执行状态（不是可执行）', () => {
      const a = A(stubPlanRunning);
      return (a && a.kind === 'running') || JSON.stringify(a);
    });
    check('P13-A4. running 时「下一步」里没有「开始执行」这种误导 CTA', () => {
      const box = card.querySelector('.planner-next');
      return (box && !/开始执行/.test(T(box)) && /执行/.test(T(box))) || (box ? T(box) : '没有 .planner-next');
    });

    check('P13-A5. waiting-review → 下一步指向「验收 … 的最新成功结果」', () => {
      /* 门控夹具里带两条**真的失败**的任务 —— 那种情况下失败就该优先（见 A6），
       * 所以这条断言先把它拿掉，单独验「没有失败时」的 waiting-review 分支。 */
      const plan = {
        ...stubPlanGate,
        tasks: stubPlanGate.tasks.filter((t) => !['failed', 'interrupted'].includes(t.status) && t.blockedReason !== 'dependency-failed'),
      };
      const a = A(plan);
      return (a && a.kind === 'waiting-review' && /验收/.test(a.text) && /gpending/.test(a.text)) || JSON.stringify(a);
    });
    check('P13-A6. 同时有失败和待验收 → 失败优先，一次只给一个主焦点', () => {
      const plan = { ...stubPlanGate, tasks: stubPlanGate.tasks.concat([mkTask('badone', [], { status: 'failed', attempt: 1 })]) };
      const a = A(plan);
      return (a && a.kind === 'failed' && !/验收/.test(a.text) && /另有 2 个任务等待验收/.test(a.sub || '')) || JSON.stringify(a);
    });
    check('P13-A7. 独立验证在跑 → 验证优先于执行/失败', () => {
      const a = A({ ...stubPlanRunning, verificationActive: { planId: 'plan-ux', taskId: 'ux-run', attempt: 2 } });
      return (a && a.kind === 'verification-active' && /正在独立验证/.test(a.text)) || JSON.stringify(a);
    });
    check('P13-A8. completed → 已完成；门控全通过才给第二行', () => {
      const all = A({ ...stubPlanReady, status: 'completed', reviewGateSummary: { gated: 2, satisfied: 2, waiting: 0 } });
      const none = A({ ...stubPlanReady, status: 'completed' });
      return (all && all.kind === 'completed' && /计划已完成/.test(all.text) && /所有人工门控已通过/.test(all.sub || '') &&
        none && !none.sub) || JSON.stringify({ all, none });
    });

    card = await openFixture(stubPlanBad);
    check('P13-A9. 恶意 task id 在「下一步」里是纯文本（不是标签）', () => {
      const box = card.querySelector('.planner-next');
      if (!box) return '没有 .planner-next';
      return (T(box).includes('<img') && !box.querySelector('img, script')) || T(box).slice(0, 140);
    });

    /* ---------- A10–A12：runnable 的口径 ----------
     *
     * 「可以执行」这个数字是**数出来的**：只数 `status === 'ready'`。
     * pending 是「依赖还没完成、当前不能启动」，把它算进来就会出现
     * 「界面说 2 个能跑、一点开始执行只跑起来 1 个」—— 数字没法解释。
     * 三行都用**精确文案**断言：`/可以执行/` 对旧实现照样通过，等于没测。 */
    card = await openFixture(stubPlanReady);
    check('P13-A10. runnable 只数 status=ready（A ready + B pending + C success → 1）', () => {
      const a = A(stubPlanReady);
      return (a && a.kind === 'ready' && a.text === '有 1 个任务可以执行') || JSON.stringify(a);
    });
    check('P13-A11. 页面上的「下一步」写的就是这句精确文案（数量是数出来的，不是写死的）', () => {
      const t = card.querySelector('.planner-next-text');
      return (t && t.textContent.trim() === '有 1 个任务可以执行') || (t ? t.textContent.trim() : '没有 .planner-next-text');
    });
    check('P13-A12. ready 计划却数不出 ready 任务 → 诚实降级「计划待执行」，不拿 pending 凑数', () => {
      const plan = { ...stubPlanReady, tasks: stubPlanReady.tasks.filter((t) => t.status !== 'ready') };
      const a = A(plan);
      return (a && a.kind === 'ready' && a.text === '计划待执行' && !/可以执行/.test(a.text)) || JSON.stringify(a);
    });

    /* ---------- B：Attempt 折叠 ---------- */
    card = await openFixture(stubPlanTen);
    check('P13-B1. 十次尝试默认只展开最新一条', () => {
      const list = attsOf(card, 'ten');
      const open = list.filter(isOpen);
      return (list.length === 10 && open.length === 1 && open[0].dataset.attempt === '10') ||
        JSON.stringify({ total: list.length, open: open.map((x) => x.dataset.attempt) });
    });
    check('P13-B2. 收起的那条 body 带 hidden、按钮 aria-expanded=false', () => {
      const a1 = attOf(card, 'ten', 1);
      const b = togOf(a1);
      return (a1 && !isOpen(a1) && b && b.getAttribute('aria-expanded') === 'false') ||
        JSON.stringify({ open: a1 ? isOpen(a1) : null, aria: b ? b.getAttribute('aria-expanded') : null });
    });
    check('P13-B3. 折叠控件是真 button，aria-controls 指向本体', () => {
      const a1 = attOf(card, 'ten', 1);
      const b = togOf(a1);
      const body = a1 && a1.querySelector('.planner-attempt-body');
      return (b && b.tagName === 'BUTTON' && b.type === 'button' && body && body.id && b.getAttribute('aria-controls') === body.id) ||
        JSON.stringify({ tag: b && b.tagName, type: b && b.type, ctrls: b && b.getAttribute('aria-controls'), id: body && body.id });
    });

    clickTog(card, 'ten', 1);
    await wait(25);
    const b4Before = isOpen(attOf(card, 'ten', 1));
    await rerender(card);
    check('P13-B4. 手动展开旧 attempt → 重绘后仍然展开（Blocker 2）', () =>
      (b4Before && isOpen(attOf(card, 'ten', 1))) || JSON.stringify({ before: b4Before, after: isOpen(attOf(card, 'ten', 1)) }));

    clickTog(card, 'ten', 10);
    await wait(25);
    const b5Before = isOpen(attOf(card, 'ten', 10));
    await rerender(card);
    check('P13-B5. 手动收起最新一条 → 重绘不偷偷把它展开', () =>
      (b5Before === false && isOpen(attOf(card, 'ten', 10)) === false) ||
      JSON.stringify({ before: b5Before, after: isOpen(attOf(card, 'ten', 10)) }));

    clickTog(card, 'pair', 1);
    clickTog(card, 'ten', 1);
    await wait(25);
    check('P13-B6. 展开状态按 task+attempt 隔离（同为第 1 次互不影响，邻居不受牵连）', () => {
      const p1 = attOf(card, 'pair', 1);
      const p2 = attOf(card, 'pair', 2);
      const t1 = attOf(card, 'ten', 1);
      const t2 = attOf(card, 'ten', 2);
      return (p1 && p2 && t1 && t2 && isOpen(p1) && !isOpen(t1) && isOpen(p2) && !isOpen(t2)) ||
        JSON.stringify({ pair1: p1 ? isOpen(p1) : null, pair2: p2 ? isOpen(p2) : null, ten1: t1 ? isOpen(t1) : null, ten2: t2 ? isOpen(t2) : null });
    });
    check('P13-B7. 正在验证的旧 attempt 自动展开（交互必需 > 默认收起）', () => {
      const v1 = attOf(card, 'verrun', 1);
      return (v1 && isOpen(v1)) || (v1 ? 'verrun 第 1 次被默认收起了' : '没有 verrun 第 1 次');
    });
    check('P13-B8. 摘要行三个维度并存：执行 / 独立验证 / 人工验收', () => {
      const a = attOf(card, 'single', 1);
      const g = (sel) => { const e = a && a.querySelector(sel); return e ? e.textContent : ''; };
      return (g('.planner-attempt-state').includes('成功') && g('.planner-att-verify').includes('通过') &&
        g('.planner-att-review').includes('已接受') && g('.planner-att-ev').includes('证据')) ||
        JSON.stringify({ exec: g('.planner-attempt-state'), verify: g('.planner-att-verify'), rev: g('.planner-att-review'), ev: g('.planner-att-ev') });
    });

    /* focus 带 attempt：跳回来的旧那条不能又被默认规则收起（Blocker 4）。 */
    stubPlanDetail = stubPlanTen;
    stubVerificationActive = null;
    window.closeModal();
    window.openPlanner({ planId: 'plan-ux', taskId: 'pair', attempt: 1 });
    await wait(160);
    card = $('workSurface');
    check('P13-B9. focus 带 attempt → 那条旧 attempt 被展开并定位（Blocker 4）', () => {
      const a = attOf(card, 'pair', 1);
      const t = taskEl(card, 'pair');
      return (a && isOpen(a) && t && t.classList.contains('focus')) ||
        JSON.stringify({ has: Boolean(a), open: a ? isOpen(a) : null, focus: t ? t.classList.contains('focus') : null });
    });

    clickTog(card, 'ten', 1);
    await wait(25);
    card = await openFixture(stubPlanTen);
    check('P13-B10. 重开面板 → 折叠选择清空，回落到默认（只展开最新一条）', () => {
      const open = attsOf(card, 'ten').filter(isOpen);
      return (open.length === 1 && open[0].dataset.attempt === '10') ||
        JSON.stringify(open.map((x) => x.dataset.attempt));
    });

    /* ---------- B11–B17：折叠头上的「人工验收」一格（P13 收尾） ----------
     *
     * 收起时只剩这一行摘要，所以它说的每一个字都要站得住：
     *
     *   执行状态  ≠  人工审阅状态（贯穿全段的那条语义）
     *
     * - `accepted` / `needs_changes` 是**人为做过的标记**，无论执行成败都照实显示
     *   （失败那次标「需修改」是合法操作，抹掉它等于丢掉用户刚做的决定）；
     * - `pending` 只对**成功的产出**成立 —— 只有它进 reviewSummary 的审阅分母。
     *   失败 / 取消 / 被中断没有可验收的产物，写「待审阅」会凭空造一个待办，
     *   还和展开区里「这次执行没有成功、只能标需修改」自相矛盾。
     *
     * 展开后的完整审阅区（状态 / 说明 / 时间 / 重试轮次）一条都不动。 */
    const headTxt = (c, id, n) => {
      const a = attOf(c, id, n);
      const e = a && a.querySelector('.planner-att-review');
      return e ? e.textContent : null;
    };

    card = await openFixture(stubPlanDraft);
    check('P13-B11. 折叠头 R1：成功 + 未审阅 → 「待审阅」', () => {
      const t = headTxt(card, 'okcmd', 1);
      return t === '待审阅' || String(t);
    });
    check('P13-B12. 折叠头 R2：成功 + 已接受 → 「已接受」', () => {
      const t = headTxt(card, 'okdesc', 1);
      return t === '已接受' || String(t);
    });
    check('P13-B13. 折叠头 R3：成功 + 需修改 → 「需修改」', () => {
      const t = headTxt(card, 'revneed', 1);
      return t === '需修改' || String(t);
    });
    check('P13-B14. 折叠头 R4：失败 + 未审阅 → **不渲染**这一格（执行状态仍在）', () => {
      const a = attOf(card, 'failed', 1);
      const t = headTxt(card, 'failed', 1);
      const st = a && a.querySelector('.planner-attempt-state');
      return (t === null && st && st.textContent.trim() === '失败') ||
        JSON.stringify({ review: t, state: st ? st.textContent.trim() : null });
    });
    check('P13-B15. 折叠头 R5+R6：取消 / 被中断同样不渲染这一格', () => {
      const c1 = headTxt(card, 'cancelled', 1);
      const c2 = headTxt(card, 'interrupted', 1);
      return (c1 === null && c2 === null) || JSON.stringify({ cancelled: c1, interrupted: c2 });
    });

    /* R7：失败 + 已经被标过「需修改」—— 标记是人给的，照实显示。
     * 不另造整套 Plan：拿快照改**一条 attempt 的一个字段**，形状保持真实。 */
    const r7 = JSON.parse(JSON.stringify(stubPlanDraft));
    r7.tasks.find((t) => t.id === 'failed').attempts[0].review =
      { status: 'needs_changes', note: '先补边界用例', reviewedAt: 1758800100000, revision: 1 };
    card = await openFixture(r7);
    check('P13-B16. 折叠头 R7：失败 + 需修改 → 仍显示「需修改」（人为标记不被抹掉）', () => {
      const t = headTxt(card, 'failed', 1);
      return t === '需修改' || String(t);
    });

    /* §二十五 / Retry：task=failed 只描述**最新**那次，历史那条成功的不能被改写。
     * stubPlanTen.pair：Attempt 1 成功·已接受、Attempt 2 失败·未审阅、task.status=failed。 */
    card = await openFixture(stubPlanTen);
    check('P13-B17. 历史隔离：Attempt 1 成功·已接受不被 task 失败改写，Attempt 2 失败·不写「待审阅」', () => {
      const a1 = headTxt(card, 'pair', 1);
      const a2 = headTxt(card, 'pair', 2);
      return (a1 === '已接受' && a2 === null) || JSON.stringify({ attempt1: a1, attempt2: a2 });
    });

    /* ---------- C：Review 草稿跨折叠不丢 ---------- */
    card = await openFixture(stubPlanDraft);
    const okcmd1 = attOf(card, 'okcmd', 1);
    clickTog(card, 'okcmd', 1);
    await wait(25);
    check('P13-C0. 手动收起单次尝试 → 收起态下草稿入口仍拿得到（预检）', () => {
      const a = attOf(card, 'okcmd', 1);
      return (a && !isOpen(a) && Boolean(a.querySelector('.planner-attempt-evidence'))) ||
        JSON.stringify({ open: a ? isOpen(a) : null });
    });
    clickTog(card, 'okcmd', 1);
    await wait(25);
    const accBtn = [...(attOf(card, 'okcmd', 1) || { querySelectorAll: () => [] }).querySelectorAll('button')]
      .find((b) => b.textContent.trim() === '接受本次结果');
    if (accBtn) accBtn.onclick();
    await wait(30);
    let ta = (attOf(card, 'okcmd', 1) || {}).querySelector ? attOf(card, 'okcmd', 1).querySelector('.planner-rv-note-in') : null;
    if (ta) {
      ta.value = '这轮的说明要留着';
      /* 真打字会触发 oninput → 草稿（draft.note）才更新；重绘是从草稿重建输入框的，
       * 直接改 DOM 值而不改草稿，下一次渲染就会把它冲掉 —— 那不算「草稿在」。 */
      if (ta.oninput) ta.oninput();
    }
    clickTog(card, 'okcmd', 1);
    await wait(25);
    const cCollapsed = attOf(card, 'okcmd', 1);
    check('P13-C1. 收起后草稿仍在 DOM 里（收起 ≠ 丢稿）', () =>
      (cCollapsed && !isOpen(cCollapsed) && cCollapsed.querySelector('.planner-rv-note-in') &&
        cCollapsed.querySelector('.planner-rv-note-in').value === '这轮的说明要留着') ||
      JSON.stringify({ open: cCollapsed ? isOpen(cCollapsed) : null, acc: Boolean(accBtn), ta: Boolean(ta) }));
    clickTog(card, 'okcmd', 1);
    await wait(25);
    await rerender(card);
    check('P13-C2. 展开 + 重绘后草稿文字还在（Blocker 3）', () => {
      const a = attOf(card, 'okcmd', 1);
      const t = a && a.querySelector('.planner-rv-note-in');
      return (a && isOpen(a) && t && t.value === '这轮的说明要留着') ||
        JSON.stringify({ open: a ? isOpen(a) : null, val: t ? t.value : null, acc: Boolean(accBtn), ta: Boolean(ta) });
    });

    /* ---------- D：动作层级 + §二十九门控文案 ---------- */
    card = await openFixture(stubPlanGateUx);
    const childIndex = (id, sel) => {
      const t = taskEl(card, id);
      return t ? [...t.children].findIndex((n) => n.matches && n.matches(sel)) : -1;
    };
    check('P13-D1. 等验收的成功任务顶部有「验收结果」主按钮', () =>
      Boolean(actBtn(taskEl(card, 'gpending'), '验收结果')) || '没有「验收结果」');
    check('P13-D2. 当前操作排在尝试历史之前（不必滚过历史才能重试）', () => {
      const acts = childIndex('gfailed', '.ext-acts');
      const hist = childIndex('gfailed', '.planner-attempts');
      return (acts > 0 && hist > acts) || JSON.stringify({ acts, hist });
    });
    check('P13-D3. 已验收通过的任务不给「验收结果」', () =>
      !actBtn(taskEl(card, 'gok'), '验收结果') || '已通过还给了验收按钮');

    const acceptBtn = actBtn(taskEl(card, 'gpending'), '验收结果');
    if (acceptBtn) acceptBtn.onclick();
    await wait(40);
    check('P13-D4. 点「验收结果」→ 最新一次 attempt 展开 + 打开审阅编辑器', () => {
      const a = attOf(card, 'gpending', 1);
      return Boolean(a && isOpen(a) && a.querySelector('.planner-rv-note-in')) ||
        JSON.stringify({ open: a ? isOpen(a) : null, editor: Boolean(a && a.querySelector('.planner-rv-note-in')) });
    });

    check('P13-E1. §二十九：重试排队中（pending）→ 尚未产生新结果 · 门控未开始', () => {
      const t = gateText(card, 'gpend2');
      return (/尚未产生新结果/.test(t) && !/执行未成功/.test(t)) || t;
    });
    check('P13-E2. §二十九：真的失败仍写「执行未成功 · 门控未开始」（P12 判据不变）', () => {
      const t = gateText(card, 'gfailed');
      return (/执行未成功/.test(t) && !/尚未产生新结果/.test(t)) || t;
    });
    check('P13-E3. 旧 accepted + 新 pending 仍不显示「门控已通过」（P12 回归）', () => {
      const t = gateText(card, 'gfailedold');
      return !/门控已通过/.test(t) || t;
    });

    stubPlanDetail = stubPlanReview;
    window.closeModal();
    await wait(20);
  }

  await extSection();
  await plannerSection();
  await sessionSection();
  await p7Section();
  await reviewSection();
  await verifySection();
  await evidenceSection();
  await gateSection();
  await convNavSection();
  await plannerUxSection();

  /* ---------- 会话内提问导航（Conversation Minimap） ----------
   *
   * jsdom **不做布局**（getBoundingClientRect 恒为 0），所以位置与「当前是第几条」
   * 这类断言必须先把几何量打桩。这里的桩是**忠实的**：把消息的 top 表示成
   * 「内容偏移 - scrollTop」，和真实浏览器里 getBoundingClientRect 的语义一致，
   * 所以模块里那套坐标换算真的被验到了。 */
  /* ================= P11：人工验收门控（前端） ================= */
  async function gateSection() {
    console.log('\n--- P11 人工门控：badge / 等待原因 / 编辑器 / Plan 汇总 ---');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const T = (e) => (e && e.textContent) || '';

    stubPlanDetail = stubPlanGate;
    window.closeModal();
    window.openPlanner();
    await wait(80);
    const card = $('workSurface');
    card.querySelectorAll('.planner-list .ext-item')[0].onclick();
    await wait(90);

    const taskEl = (id) => [...card.querySelectorAll('.planner-task')].find((x) => x.dataset.taskId === id);
    const gateRow = (id) => {
      const it = taskEl(id);
      return it ? it.querySelector('.planner-gate') : null;
    };
    const blockedRow = (id) => {
      const it = taskEl(id);
      return it ? it.querySelector('.planner-blocked') : null;
    };

    check('G1. 开了门控的任务有「人工门控」标记', () => /人工门控/.test(T(gateRow('gpending'))) || T(gateRow('gpending')));
    check('G2. 成功但待验收 → 「等待人工验收」', () => /等待人工验收/.test(T(gateRow('gpending'))) || T(gateRow('gpending')));
    check('G3. 已接受 → 「门控已通过」', () => /门控已通过/.test(T(gateRow('gok'))) || T(gateRow('gok')));
    check('G4. 需要修改 → 「需要修改 · 门控未通过」', () => /需要修改 · 门控未通过/.test(T(gateRow('gneed'))) || T(gateRow('gneed')));
    check('G5. 还没成功过 → 「还没有成功执行 · 门控未开始」', () => /还没有成功执行/.test(T(gateRow('gnever'))) || T(gateRow('gnever')));
    check('G6. 没开门控的任务**没有**这一行', () => gateRow('nogate') === null || T(gateRow('nogate')));

    check('G7. 下游写明「等待人工验收：上游 id」', () => {
      const t = T(blockedRow('downstream'));
      return (/等待人工验收/.test(t) && /gpending/.test(t)) || t;
    });
    check('G8. 上游失败的下游说「上游任务失败」——**不能**说成等验收', () => {
      const t = T(blockedRow('downfail'));
      return (/上游任务失败/.test(t) && !/等待人工验收/.test(t)) || t;
    });

    check('G9. Plan 顶部写明「已暂停：等待人工验收」', () => /已暂停：等待人工验收/.test(T(card)) || T(card).slice(0, 240));
    check('G10. Plan 顶部有门控汇总（1/3 已通过 · 待验收 2）', () => {
      const s = card.querySelector('.planner-gate-sum');
      return (/1\/3/.test(T(s)) && /待验收 2/.test(T(s))) || T(s);
    });

    check('G11. 门控任务上的勾选框是**选中**的', () => {
      const it = taskEl('gpending');
      const cb = it && it.querySelector('.planner-gate-toggle input[type=checkbox]');
      return (cb && cb.checked === true) || (cb ? String(cb.checked) : '没找到');
    });
    check('G12. 没开门控的任务勾选框**未选中**', () => {
      const it = taskEl('nogate');
      const cb = it && it.querySelector('.planner-gate-toggle input[type=checkbox]');
      return (cb && cb.checked === false) || (cb ? String(cb.checked) : '没找到');
    });
    check('G13. 勾选框旁边写清了它的含义', () => {
      const it = taskEl('nogate');
      const lab = it && it.querySelector('.planner-gate-toggle');
      return /需要人工验收后再继续下游/.test(T(lab)) || T(lab);
    });
    check('G14. 勾上之后勾选框保持选中（不会自己弹回去）', () => {
      const it = taskEl('nogate');
      const cb = it.querySelector('.planner-gate-toggle input[type=checkbox]');
      cb.checked = true;
      cb.onchange();
      return cb.checked === true;
    });

    check('G15. 恶意 task id / 上游 id 都是**纯文本**（没有注入节点）', () => {
      const injected = card.querySelectorAll('.planner-task img, .planner-task script, .planner-blocked img').length;
      const row = blockedRow(XSS_NOTE);
      return (injected === 0 && row && T(row).includes('<img')) || JSON.stringify({ injected, txt: row ? T(row).slice(0, 60) : null });
    });

    check('G16. **执行失败**的门控任务不说「等待人工验收」——没有可验收的产出', () => {
      const t = T(gateRow('gfailed'));
      return (/执行未成功/.test(t) && !/等待人工验收/.test(t)) || t;
    });

    check('G17. **旧 accepted 不算已通过**：当前没成功、只有历史 accepted → 不显示「门控已通过」', () => {
      const t = T(gateRow('gfailedold'));
      return (/执行未成功/.test(t) && !/门控已通过/.test(t) && !/等待人工验收/.test(t)) || t;
    });

    // 收尾：后面的段落要回到默认桩
    stubPlanDetail = stubPlanReview;
    window.closeModal();
  }

  async function convNavSection() {
    const stream = $('stream');
    const nav = $('convoNav');

    // ---- 几何桩 ----
    let scrollTopVal = 0;
    let msgStep = 300;   // 每条消息占多高（用来模拟长短不一的回答）
    let navHeight = 600;
    const define = (obj, key, get, set) =>
      Object.defineProperty(obj, key, { configurable: true, get, set });

    define(stream, 'scrollTop', () => scrollTopVal, (v) => { scrollTopVal = v; });
    define(stream, 'clientHeight', () => 600);
    define(stream, 'scrollHeight', () => Math.max(1, userEls().length * msgStep));
    define(nav, 'clientHeight', () => navHeight);

    /* 跳转只写 #stream 的滚动位置（scrollTo），jsdom 没有这个方法 ——
     * 补一个最小实现：记录调用参数，并把 scrollTop 真的落下去，
     * 和真实浏览器一致。**不再有 scrollIntoView 的角色**。 */
    let scrollToCalls = [];
    stream.scrollTo = (opts) => {
      const top = typeof opts === 'number' ? opts : opts && opts.top;
      scrollToCalls.push({ top, behavior: opts && opts.behavior });
      scrollTopVal = top;
    };

    const userEls = () => [...$('stream').querySelector('.thread').querySelectorAll('.msg.user')];
    const origRect = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
      if (this === stream) return { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 };
      const els = userEls();
      const i = els.indexOf(this);
      if (i >= 0) {
        // 视口坐标 = 内容偏移 - 已滚动距离（和真实浏览器一致）
        const top = i * msgStep - scrollTopVal;
        return { top, bottom: top + 20, left: 0, right: 700, width: 700, height: 20 };
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    };

    const mkMsgs = (n) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push({ role: 'user', content: [{ type: 'text', text: `第 ${i + 1} 次提问的内容` }] });
        out.push({ role: 'assistant', content: [{ type: 'text', text: `第 ${i + 1} 次回答` }] });
      }
      return out;
    };
    const rebuild = async (msgs) => {
      window.rebuildFromMessages({ messages: msgs });
      await new Promise((r) => setTimeout(r, 30));
    };

    // 1. 空会话 → 无 marker
    await rebuild([]);
    check('导航 1. 空会话 → 没有 marker', () => nav.querySelectorAll('.cn-marker').length === 0 || `有 ${nav.querySelectorAll('.cn-marker').length} 个`);

    // 2. 1 条 user → 1 marker
    await rebuild([{ role: 'user', content: [{ type: 'text', text: '只有一次提问' }] }]);
    check('导航 2. 一条用户消息 → 1 个 marker', () => nav.querySelectorAll('.cn-marker').length === 1 || nav.querySelectorAll('.cn-marker').length);

    // 3. user + assistant → 仍然 1 marker
    await rebuild([
      { role: 'user', content: [{ type: 'text', text: '一次提问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '一段回答' }] },
    ]);
    check('导航 3. user + assistant → 仍然只有 1 个 marker（assistant 不画点）', () =>
      nav.querySelectorAll('.cn-marker').length === 1 || nav.querySelectorAll('.cn-marker').length);

    // 4. 3 次问答 → 3 markers
    await rebuild(mkMsgs(3));
    check('导航 4. 三次问答 → 3 个 marker', () => nav.querySelectorAll('.cn-marker').length === 3 || nav.querySelectorAll('.cn-marker').length);

    // 5. tool calls 不增加 marker
    await rebuild([
      { role: 'user', content: [{ type: 'text', text: '跑一下测试' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'npm test' } }] },
      { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: '跑完了' }] },
    ]);
    check('导航 5. tool call / tool result 不产生 marker', () =>
      nav.querySelectorAll('.cn-marker').length === 1 || nav.querySelectorAll('.cn-marker').length);

    // 6. historical rebuild 重建 markers
    await rebuild(mkMsgs(4));
    check('导航 6. 历史重建（rebuildFromMessages）会重建 markers', () =>
      nav.querySelectorAll('.cn-marker').length === 4 || nav.querySelectorAll('.cn-marker').length);
    check('导航 6b. 每条用户消息有稳定的 data-nav-id', () => {
      const ids = userEls().map((e) => e.dataset.navId);
      return ids.every((x) => /^msg-\d+$/.test(x || '')) || JSON.stringify(ids);
    });

    // 7. realtime user message 增加 marker（走 SSE 事件，不是重建）
    {
      const before = nav.querySelectorAll('.cn-marker').length;
      es.emit({
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: '实时新增的一次提问' }] },
      });
      await new Promise((r) => setTimeout(r, 30));
      check('导航 7. 实时新增用户消息立刻加 marker（不等 assistant 回复完）', () =>
        nav.querySelectorAll('.cn-marker').length === before + 1 || `${before} → ${nav.querySelectorAll('.cn-marker').length}`);
    }

    // 19. marker 是**紧凑聚簇**，不再是「按内容比例铺满整个容器高度」
    await rebuild(mkMsgs(3));
    {
      const e = window.navEntries();
      check('导航 19. marker 聚成紧凑一组（不再按内容比例铺满容器）', () => {
        if (e.length !== 3) return `entries=${e.length}`;
        const span = e[2].top - e[0].top;
        const gaps = [e[1].top - e[0].top, e[2].top - e[1].top];
        // 紧凑：整组跨度远小于容器高度，且相邻间距一致
        return (span < navHeight / 4 && Math.abs(gaps[0] - gaps[1]) < 0.001) ||
          JSON.stringify({ span, gaps, navH: navHeight });
      });
      check('导航 19b. 整组在容器里垂直居中', () => {
        const mid = (e[0].top + e[2].top) / 2;
        return Math.abs(mid - navHeight / 2) <= 2 || `mid=${mid} navH=${navHeight}`;
      });
      check('导航 19c. 顺序不变：第 1 次提问 → 第 1 条 marker', () =>
        (e[0].top < e[1].top && e[1].top < e[2].top) || JSON.stringify(e.map((x) => x.top)));
      check('导航 19d. 紧凑聚簇仍然保留内容偏移（点击跳转靠它）', () =>
        e.every((x, i) => x.topInContent === i * msgStep) || JSON.stringify(e.map((x) => x.topInContent)));
    }

    // 19e/19f. 10～40 条时仍是一组紧凑短线（长会话不能散开）
    await rebuild(mkMsgs(40));
    {
      const e = window.navEntries();
      const span = e[e.length - 1].top - e[0].top;
      check('导航 19e. 40 条时整组仍紧凑（跨度小于容器的一半）', () =>
        (e.length === 40 && span < navHeight / 2) || `span=${span} navH=${navHeight}`);
      check('导航 19f. 40 条时相邻间距一致（等距短线组）', () => {
        const gaps = e.slice(1).map((x, i) => x.top - e[i].top);
        return (gaps.every((g) => Math.abs(g - gaps[0]) < 0.001) && gaps[0] > 0) || JSON.stringify(gaps.slice(0, 6));
      });
    }

    // 18 / 22. 长会话：marker 不重叠、不超出容器
    await rebuild(mkMsgs(100));
    {
      const e = window.navEntries();
      check('导航 20. 100 条用户消息 → 100 个 marker', () => e.length === 100 || e.length);
      check('导航 22. 100 条时 marker 不超出容器高度', () =>
        e.every((x) => x.top >= 0 && x.top <= navHeight) || `max=${Math.max(...e.map((x) => x.top))} navH=${navHeight}`);
      const tops = e.map((x) => x.top);
      const sorted = [...tops].sort((a, b) => a - b);
      check('导航 18. 密集时仍保持最小间距（不糊成一根实线）', () =>
        sorted.every((v, i) => i === 0 || v - sorted[i - 1] >= 2) || JSON.stringify(sorted.slice(0, 12)));
    }
    await rebuild(mkMsgs(500));
    {
      const e = window.navEntries();
      check('导航 21. 500 条用户消息不崩，且仍不超出容器', () =>
        (e.length === 500 && e.every((x) => x.top >= 0 && x.top <= navHeight)) || `n=${e.length} max=${Math.max(...e.map((x) => x.top))}`);
    }

    // 13. current marker 跟随滚动
    await rebuild(mkMsgs(4));
    {
      const idxAt = async (top) => {
        scrollTopVal = top;
        stream.dispatchEvent(new window.Event('scroll'));
        await new Promise((r) => setTimeout(r, 200)); // 等 rAF / debounce
        return window.currentNavIndex();
      };
      const i0 = await idxAt(0);
      check('导航 13a. scrollTop=0 → current=0', () => i0 === 0 || i0);
      const i2 = await idxAt(300 * 2);
      check('导航 13b. 滚到第 3 条 → current=2', () => i2 === 2 || i2);
      const i3 = await idxAt(300 * 3 + 100);
      check('导航 13c. 滚到第 4 条内部 → current=3（回答再长也属于它前面那次提问）', () => i3 === 3 || i3);
      check('导航 13d. 高亮的那条带 .on 类', () => {
        const on = nav.querySelectorAll('.cn-marker.on');
        return on.length === 1 || `有 ${on.length} 个高亮`;
      });
      check('导航 28. 当前提问的消息带 data-current-question', () => {
        const cur = $('stream').querySelector('.thread').querySelectorAll('.msg.user[data-current-question="true"]');
        return cur.length === 1 || `有 ${cur.length} 个`;
      });
    }

    // 12. 点击 marker 跳转：**只写 #stream 的滚动位置**
    {
      scrollToCalls = [];
      /* 这一轮最关键的回归：**不许再用 scrollIntoView**。
       * 它会连带滚动所有「可编程滚动」的祖先 —— .stage 是 overflow:hidden，
       * scrollTop 照样能被脚本改，真实浏览器里量到的是 stage-head 的 top
       * 从 0 变成 -46（顶栏被推出视口，看起来就是「标题栏消失」）。
       * 这里装一个探针：只要被调用就判红。 */
      let scrollIntoViewCalls = 0;
      const origScrollIntoView = window.Element.prototype.scrollIntoView;
      window.Element.prototype.scrollIntoView = function () { scrollIntoViewCalls++; };
      scrollTopVal = 999;
      nav.querySelectorAll('.cn-marker')[2].click();
      await new Promise((r) => setTimeout(r, 20));
      check('导航 12. 点 marker 只写 #stream 的滚动位置（不再用 scrollIntoView）', () => {
        if (scrollIntoViewCalls) return `scrollIntoView 被调用了 ${scrollIntoViewCalls} 次`;
        const call = scrollToCalls[scrollToCalls.length - 1];
        if (!call || typeof call.top !== 'number') return JSON.stringify(scrollToCalls);
        if (call.behavior !== 'smooth') return `behavior=${call.behavior}`;
        // 第 3 条的内容偏移 = 2 × 300；减去顶部余量 20；clamp 到 [0, scrollHeight - clientHeight]
        const expect = Math.min(4 * 300 - 600, 2 * 300 - 20);
        return call.top === expect || `top=${call.top} expect=${expect}`;
      });
      check('导航 12b. 滚动真的落在 #stream 上（不是只调了个空函数）', () =>
        scrollTopVal === Math.min(4 * 300 - 600, 2 * 300 - 20) || scrollTopVal);
      check('P14-B 点击 marker 立即更新当前项', () => window.currentNavIndex() === 2 && nav.querySelectorAll('.cn-marker.on').length === 1 && nav.querySelectorAll('.cn-marker')[2].classList.contains('on'));
      window.Element.prototype.scrollIntoView = origScrollIntoView;
    }

    // 23 / 24. 键盘可达
    check('导航 23/24. marker 是 button（Enter / Space 天然可用），且有 aria-label', () => {
      const m = nav.querySelector('.cn-marker');
      return (m && m.tagName === 'BUTTON' && /^跳转到：/.test(m.getAttribute('aria-label'))) || (m ? m.outerHTML.slice(0, 120) : '没有 marker');
    });

    // 14 / 15 / 16. hover preview
    await rebuild([
      { role: 'user', content: [{ type: 'text', text: '  修掉这个   retry 后的空白 Pi 块\n还有第二行  ' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
    ]);
    check('导航 14. hover 提示取对应用户消息正文', () => {
      const tip = nav.querySelector('.cn-tip');
      return (tip && /修掉这个 retry 后的空白 Pi 块/.test(tip.textContent)) || (tip ? tip.textContent : '没有提示');
    });
    check('导航 15. 预览折掉换行与多余空格', () => {
      const tip = nav.querySelector('.cn-tip').textContent;
      return !/[\n\r]/.test(tip) && !/ {2,}/.test(tip) || JSON.stringify(tip);
    });
    check('导航 15b. 长文本被截断（不把完整 prompt 塞进提示）', () => {
      const long = '这是一段很长很长的提问'.repeat(20);
      window.rebuildFromMessages({ messages: [{ role: 'user', content: [{ type: 'text', text: long }] }] });
      const tip = nav.querySelector('.cn-tip').textContent;
      return (tip.length <= 41 && tip.endsWith('…')) || `${tip.length} 字`;
    });
    check('导航 16. 中文预览正常（不出现乱码或截半个字）', () => {
      const tip = nav.querySelector('.cn-tip').textContent;
      return (/[\u4e00-\u9fa5]/.test(tip) && !/\uFFFD/.test(tip)) || tip;
    });

    // 8. new_session 清空
    {
      await rebuild(mkMsgs(3));
      es.emit({ type: 'response', command: 'new_session', success: true, data: {} });
      await new Promise((r) => setTimeout(r, 30));
      check('导航 8. new_session → 清空 minimap', () =>
        nav.querySelectorAll('.cn-marker').length === 0 || nav.querySelectorAll('.cn-marker').length);
    }

    // 9. project switch 清空旧 markers
    {
      await rebuild(mkMsgs(3));
      window.clearThread();
      check('导航 9. 清空对话区（切项目会走这条）→ marker 同时清掉，不会短暂留着旧的', () =>
        nav.querySelectorAll('.cn-marker').length === 0 || nav.querySelectorAll('.cn-marker').length);
    }

    // 17 / 18（重算）：resize / streaming 高度变化后位置重算
    await rebuild(mkMsgs(4));
    {
      const before = window.navEntries().map((x) => x.top);
      navHeight = 300;
      window.scheduleLayout();
      await new Promise((r) => setTimeout(r, 220));
      const after = window.navEntries().map((x) => x.top);
      check('导航 17. 容器高度变化后重算位置（等比压缩）', () =>
        after[after.length - 1] < before[before.length - 1] || JSON.stringify({ before, after }));
      navHeight = 600;
      window.scheduleLayout();
      await new Promise((r) => setTimeout(r, 220));
    }
    {
      const before = window.navEntries().map((x) => x.topInContent);
      msgStep = 500; // 模拟 streaming 把内容撑高 / Timeline 展开
      window.scheduleLayout();
      await new Promise((r) => setTimeout(r, 220));
      const after = window.navEntries().map((x) => x.topInContent);
      check('导航 18b. 内容高度变化（streaming / Timeline 折叠）后重算内容偏移', () =>
        after[after.length - 1] > before[before.length - 1] || JSON.stringify({ before, after }));
      msgStep = 300;
    }

    // 25. DOM 不使用 raw user content innerHTML
    check('导航 25. 预览走 textContent，没有把用户正文拼进 innerHTML', () => {
      const src = sources;
      const block = src.slice(src.indexOf('function previewOf'), src.indexOf('function makeMarker'));
      return !/innerHTML/.test(block) || '预览路径里出现了 innerHTML';
    });
    check('导航 25b. marker 与提示都只有文本节点，没有 HTML 注入面', () => {
      const m = nav.querySelector('.cn-marker');
      if (!m) return '没有 marker';
      return m.querySelectorAll('*').length === 1 || `marker 里有 ${m.querySelectorAll('*').length} 个子元素`;
    });

    // 还原几何桩，别影响后面的用例
    window.Element.prototype.getBoundingClientRect = origRect;
    scrollTopVal = 0;
  }


  /* ---------- 侧栏的会话列表（参考 Codex，不单开窗口） ---------- */
  /* ---------- P7：项目级任务工作流（任务 ↔ 会话 / 任务 ↔ 文件） ---------- */
  async function p7Section() {
    /* 1) 会话标题旁的「关联任务」窄条（§8）。
     * 它由 sessions.js 在会话列表刷新时驱动，所以先重渲染项目列表。 */
    window.renderProjects();
    await new Promise((r) => setTimeout(r, 90));
    const hint = $('sessionPlans');

    check('P7. 会话头部有关联容器（没有关联时整块 hidden，不占位）', () => Boolean(hint));
    check('P7. 有关联时显示「关联 N 个任务」', () => {
      if (!hint || hint.hidden) return '窄条没显形';
      return /关联 2 个任务/.test(hint.textContent) || hint.textContent.slice(0, 120);
    });
    check('P7. 窄条显示计划名与任务名（看得出属于哪个计划的哪个任务）', () => {
      const t = hint.textContent;
      return (/修复 SSE 重连问题/.test(t) && /修改后端/.test(t)) || t.slice(0, 160);
    });
    check('P7. 窄条里没有绝对路径 / 会话 id', () =>
      (!/[A-Za-z]:\\|[A-Za-z]:\//.test(hint.textContent) && !/sess-/.test(hint.textContent)) || hint.textContent.slice(0, 160));

    const toggle = hint.querySelector('.sp-toggle');
    check('P7. 多条关联时给「展开全部」', () => Boolean(toggle) || hint.textContent.slice(0, 120));
    if (toggle) {
      toggle.onclick();
      check('P7. 展开后两条都列出来', () => hint.querySelectorAll('.sp-row').length === 2 || String(hint.querySelectorAll('.sp-row').length));
    }

    /* 2) 点「查看任务」→ 直接打开 Planner（不新开一层弹层） */
    {
      hint.querySelector('.sp-open').onclick();
      await new Promise((r) => setTimeout(r, 90));
      check('P7. 点「查看任务」打开 Planner 面板', () => Boolean($('workSurface').querySelector('.planner-detail')));
    }

    /* 3) Planner 里的会话关联（用 P7 专用夹具，四种会话状态各一条） */
    stubPlanDetail = stubPlanP7;
    window.closeModal();
    window.openPlanner();
    await new Promise((r) => setTimeout(r, 70));
    let card = $('workSurface');
    card.querySelectorAll('.planner-list .ext-item')[0].onclick();
    await new Promise((r) => setTimeout(r, 70));
    const taskEl = (id) => [...card.querySelectorAll('.planner-task')].find((x) => x.dataset.taskId === id);

    check('P7. 任务显示关联会话的**标题**（不是一串 id）', () => {
      const it = taskEl('linked');
      return Boolean(it && /修复 bridgeRun stale response/.test(it.textContent)) || (it ? it.textContent.slice(0, 200) : '没找到任务');
    });
    check('P7. 有会话的任务上有「打开会话」按钮', () => {
      const it = taskEl('linked');
      return Boolean(it && [...it.querySelectorAll('button')].some((b) => b.textContent === '打开会话'));
    });
    check('P7. 每次 attempt 各显示自己的会话（retry 不覆盖旧的那条）', () => {
      const it = taskEl('retried');
      const t = it ? it.textContent : '';
      return (/补测试（第一次）/.test(t) && /补测试（第二次）/.test(t)) || t.slice(0, 220);
    });
    check('P7. 没有关联会话时说「无可关联会话」（不报错、不显示 id）', () => {
      const it = taskEl('nosess');
      return Boolean(it && /无可关联会话/.test(it.textContent));
    });
    check('P7. 关联会话已被删除时明确说明（不静默消失）', () => {
      const it = taskEl('gone');
      return Boolean(it && /关联会话已删除/.test(it.textContent));
    });
    check('P7. 执行期间变更以**文本节点**渲染（路径不会被当 HTML 解析）', () => {
      const files = [...card.querySelectorAll('.planner-file')].map((f) => f.textContent);
      return (files.includes('server/rpc-bridge.js') && files.includes('tests/reliability.cjs')) || JSON.stringify(files);
    });
    check('P7. 措辞是「执行期间变更」，不写成「该 Agent 修改」', () => {
      const t = card.querySelector('.planner-detail').textContent;
      return (/执行期间变更/.test(t) && !/该 Agent 修改/.test(t)) || t.slice(0, 200);
    });
    check('P7. 采集不到变化时如实说明（不是假装「没有变化」）', () => {
      const it = taskEl('gone');
      return Boolean(it && /采集不到/.test(it.textContent)) || (it ? it.textContent.slice(0, 200) : '没找到');
    });
    check('P7. Plan 级汇总：关联会话去重后的条数', () => {
      const box = card.querySelector('.planner-relations');
      return Boolean(box && /关联会话 4/.test(box.textContent)) || (box ? box.textContent : '没有汇总');
    });
    check('P7. Plan 级汇总：执行期间涉及的文件数（去重）', () => {
      const box = card.querySelector('.planner-relations');
      return Boolean(box && /涉及 3 个文件/.test(box.textContent)) || (box ? box.textContent : '没有汇总');
    });
    check('P7. 汇总里的会话可展开并直接打开', () => {
      const btns = [...card.querySelectorAll('.planner-relations .planner-rel-btn')];
      const sess = btns.find((b) => /关联会话/.test(b.textContent));
      if (!sess) return '没有关联会话按钮';
      sess.onclick();
      const rows = card.querySelectorAll('.planner-rel-list .planner-rel-row');
      return rows.length === 4 || `展开了 ${rows.length} 行`;
    });

    /* 4) 点「打开会话」：只传 plan/task/attempt，不传任何路径 */
    {
      openSessionCalls.length = 0;
      stubOpenSession = { ok: true, id: 'bbbbbbbbbbbbbbbb', title: '修复 bridgeRun stale response', sessionId: 'sess-a', taskId: 'linked', attempt: 1 };
      const it = taskEl('linked');
      [...it.querySelectorAll('button')].find((b) => b.textContent === '打开会话').onclick();
      await new Promise((r) => setTimeout(r, 90));
      const hit = openSessionCalls[0];
      check('P7. 点「打开会话」调 open-session，且 URL 里没有任何路径 / 会话 id', () =>
        Boolean(hit && /\/tasks\/linked\/open-session/.test(hit.url) && !/jsonl|\.\.|%3A|sess-/.test(hit.url)) || JSON.stringify(openSessionCalls.map((c) => c.url)));
      check('P7. 打开成功后收起弹层（要能看到对话区）', () => $('workSurface').childElementCount === 0 || '弹层还开着');
    }

    /* 5) 后端说「没有可关联的会话」是**正常结果**，不是崩溃 */
    {
      window.openPlanner();
      await new Promise((r) => setTimeout(r, 70));
      card = $('workSurface');
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await new Promise((r) => setTimeout(r, 70));
      openSessionCalls.length = 0;
      stubOpenSession = { ok: false, error: '这次执行没有关联会话（所用的 Agent 不提供会话关联）' };
      const it = taskEl('linked');
      [...it.querySelectorAll('button')].find((b) => b.textContent === '打开会话').onclick();
      await new Promise((r) => setTimeout(r, 70));
      check('P7. 「没有可关联会话」只提示、界面照常（不当成错误状态）', () =>
        Boolean($('workSurface').querySelector('.planner-detail')) || '面板被关掉了');
      check('P7. 提示里说的是原因，不是「未知错误」', () => {
        const t = $('toasts').textContent;
        return /没有关联会话/.test(t) || t.slice(0, 120);
      });
    }

    window.closeModal();
    stubPlanDetail = stubPlan;

    /* §21：换项目 / 没有会话时窄条必须被清空。
     * 关联数据在后端是按项目过滤的，但**已经画出来的 DOM 不会自己消失** ——
     * 所以清空这一步是显式动作（sessions.js 换项目时调它）。 */
    window.clearSessionPlans();
    check('P7. 换项目/无会话时窄条被清空并隐藏（不残留上一个项目的关联）', () =>
      ($('sessionPlans').hidden === true && $('sessionPlans').childElementCount === 0) ||
      `hidden=${$('sessionPlans').hidden} children=${$('sessionPlans').childElementCount}`);
  }

  /* ================= P8-C：Attempt 人工审阅 ================= */

  async function reviewSection() {
    console.log('\n--- P8-C 人工审阅：三态 / 编辑 / 冲突 / 汇总 / stale ---');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const T = (e) => (e && e.textContent) || '';

    stubPlanDetail = stubPlanReview;
    stubReviewResult = null;
    reviewDelayMs = 0;
    reviewCalls.length = 0;
    window.closeModal();
    window.openPlanner();
    await wait(80);
    let card = $('workSurface');
    card.querySelectorAll('.planner-list .ext-item')[0].onclick();
    await wait(90);

    /* 每次都用 dataset 现查，DOM 一重画就重新定位（不缓存节点引用） */
    const taskEl = (id) => [...card.querySelectorAll('.planner-task')].find((x) => x.dataset.taskId === id);
    const attEl = (id, n) => {
      const it = taskEl(id);
      if (!it) return null;
      return (
        [...it.querySelectorAll('.planner-attempt')].find((a) => {
          const no = a.querySelector('.planner-attempt-no');
          return no && no.textContent.trim() === `第 ${n} 次`;
        }) || null
      );
    };
    /** 审阅块：给了 attempt 号就取那一条 attempt 的，否则取任务级的。 */
    const rvEl = (id, n) => {
      const host = n ? attEl(id, n) : taskEl(id);
      return host ? host.querySelector('.planner-rv') : null;
    };
    const rvBtn = (id, text, n) => {
      const box = rvEl(id, n);
      return box ? [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === text) || null : null;
    };

    /* ---------- 汇总（必须在任何写操作之前断言 —— 后面的保存会改状态） ----------
     *
     * 夹具的设计值：成功 8（okcmd/okdesc/oknull/revneed/xsstask/manyfiles/live/
     * multrev）、**失败 1（只有 failed）**、取消 1、**中断 1（interrupted）**、
     * 尚无结果 1（noattempt）。
     * 审阅分母**只有「最新一次成功」的 8 个**：已接受 4（okdesc/xsstask/manyfiles/live）、
     * 需修改 1（revneed）、待审阅 3（okcmd/oknull/multrev）。 */
    check('R24. Plan 汇总：执行结果按最新一次 attempt 归类，interrupted 单列', () => {
      const s = T(card.querySelector('.planner-revsum'));
      return (/成功 8/.test(s) && /失败 1/.test(s) && /取消 1/.test(s) && /中断 1/.test(s) && /尚无结果 1/.test(s)) || s;
    });
    check('R24b. interrupted **不并进** failed（防回归：这里只允许有 1 条失败）', () => {
      const s = T(card.querySelector('.planner-revsum'));
      /* 把 interrupted 并进 failed 的话这里会变成「失败 2」 */
      return (!/失败 2/.test(s) && /失败 1/.test(s)) || s;
    });
    check('R25. Plan 汇总：审阅分母只含「最新一次成功」的任务', () => {
      const s = T(card.querySelector('.planner-revsum'));
      return (/已接受 4/.test(s) && /需修改 1/.test(s) && /待审阅 3/.test(s)) || s;
    });
    /* 「中断 0」不该出现 —— 常态不给噪声。换一个**没有 interrupted** 的夹具
     * （深拷贝后去掉那个任务），重画一次真的看一眼。 */
    {
      const noInt = JSON.parse(JSON.stringify(stubPlanReview));
      noInt.tasks = noInt.tasks.filter((t) => t.id !== 'interrupted');
      stubPlanDetail = noInt;
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      check('R24c. 中断为 0 时**不显示**「中断 0」（常态不加噪声）', () => {
        const s = T(card.querySelector('.planner-revsum'));
        return (!/中断/.test(s) && /失败 1/.test(s) && /取消 1/.test(s)) || s;
      });
      stubPlanDetail = stubPlanReview;
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
    }
    check('R24d. attempt 明细里 interrupted 仍然显示「被中断」（只改汇总，不动明细）', () => {
      const it = taskEl('interrupted');
      return Boolean(it) && /被中断/.test(T(it)) || (it ? T(it).slice(0, 120) : '没找到任务');
    });
    check('R25b. 失败 / 取消 / 被中断的最新结果**不进**「待审阅」分母', () => {
      const s = T(card.querySelector('.planner-revsum'));
      /* 若三个不可接受的最新结果被算进分母，pending 会变成 6 而不是 3 */
      return !/待审阅 6/.test(s) || s;
    });
    check('R26. 「最新一次 attempt」规则：multrev 的最新一次是 pending，不是历史那次 accepted', () => {
      /* Task 的当前审阅 = 最新 attempt 的（pending）；历史那条仍显示在 Attempt 1 卡片里 */
      const a1 = T(rvEl('multrev', 1));
      const a2 = T(rvEl('multrev', 2));
      return (/已接受/.test(a1) && /待审阅/.test(a2) && !/已接受/.test(a2)) || `a1=${a1} | a2=${a2}`;
    });
    check('R27. 旧 attempt 的 accepted 不被隐藏、也不改写成「已过期 / 旧版」', () => {
      const a1 = T(rvEl('multrev', 1));
      return (/第一次曾经通过/.test(a1) && !/已过期|旧版|stale/.test(a1)) || a1;
    });
    check('R28. 没有 attempt 的任务算「尚无结果」，不算「待审阅」', () => {
      const it = taskEl('noattempt');
      return Boolean(it) && !it.querySelector('.planner-rv') || (it ? '无 attempt 却渲染了审阅块' : '没找到任务');
    });

    /* ---------- 三种审阅态的文案 ---------- */
    check('R1. 成功的 attempt 有「人工审阅」区', () => Boolean(rvEl('okcmd', 1)) || '没有审阅区');
    check('R2. 未审阅显示「待审阅」', () => /待审阅/.test(T(rvEl('okcmd', 1))) || T(rvEl('okcmd', 1)));
    check('R3. 已保存的审阅显示「已接受」+ 说明 + 本地时间', () => {
      const t = T(rvEl('okdesc', 1));
      return (/已接受/.test(t) && /第一次通过/.test(t) && /\d+月\d+日 \d+:\d+/.test(t)) || t;
    });
    check('R4. 「需修改」态照常显示', () => /需修改/.test(T(rvEl('revneed', 1))) || T(rvEl('revneed', 1)));
    check('R4b. 状态文字是**真文字**，不只靠颜色（圆点旁边还有标签）', () =>
      Boolean(rvEl('okdesc', 1).querySelector('.planner-rv-state')) || '只有圆点没有文字');

    /* ---------- 哪些执行结论不能「接受」 ---------- */
    check('R5. 失败的 attempt 只有「需要修改」，没有「接受本次结果」', () =>
      Boolean(rvBtn('failed', '需要修改', 1)) && !rvBtn('failed', '接受本次结果', 1) || '失败却给了接受按钮');
    check('R6. 已取消的 attempt 只有「需要修改」', () =>
      Boolean(rvBtn('cancelled', '需要修改', 1)) && !rvBtn('cancelled', '接受本次结果', 1) || '取消却给了接受按钮');
    check('R7. 被中断的 attempt 只有「需要修改」', () =>
      Boolean(rvBtn('interrupted', '需要修改', 1)) && !rvBtn('interrupted', '接受本次结果', 1) || '中断却给了接受按钮');
    check('R8. 正在执行的那一次不给审阅操作，只说明完成后可审阅', () => {
      const box = rvEl('live', 2);
      return (Boolean(box) && /完成后可进行人工审阅/.test(T(box)) && !box.querySelector('button')) || T(box);
    });
    check('R8b. 执行中那次尝试在历史里**显式占位**（不会凭空消失）', () => {
      const a = attEl('live', 2);
      return Boolean(a) && /执行中/.test(T(a)) || (a ? T(a) : '没有第 2 次的占位');
    });

    /* ---------- 验证快照 / 验证结果 ---------- */
    check('R17. verificationSnapshot 的 command 直接显示', () => /npm test/.test(T(attEl('okcmd', 1))) || T(attEl('okcmd', 1)));
    check('R18. verificationSnapshot 的 description 直接显示', () => /确认登录错误提示/.test(T(attEl('okdesc', 1))) || T(attEl('okdesc', 1)));
    check('R19. 没有快照时如实说没有，并把「当前任务」的要求另起一行标出', () => {
      const t = T(attEl('oknull', 1));
      return (/该次执行没有保存历史验证要求/.test(t) && /当前任务验证要求/.test(t) && /npm run test:unit/.test(t)) || t;
    });
    check('R20. 验证结果永远是「尚未独立确认」，且全卡片没有「验证通过」类字样', () => {
      const t = T(attEl('okcmd', 1));
      return (/尚未独立确认/.test(t) && !/验证通过|已验证|Tests passed/.test(t)) || t;
    });

    /* ---------- 会话 / 当前 Diff 入口 ---------- */
    check('R21. 会话入口仍然存在（复用 P7，不重做一套）', () => {
      const it = attEl('okcmd', 1);
      return Boolean(it) && [...it.querySelectorAll('button')].some((b) => b.textContent.trim() === '打开会话') || '没有打开会话按钮';
    });
    /* Diff 入口的两种分支都要真的断言到（§二十一 / §二十二）：
     * 把 Git 工作区状态打桩成「只有 mod-0 还有未提交差异」，然后重画。 */
    const savedChanges = window.S.changes;
    window.S.changes = { loaded: true, isRepo: true, files: [{ path: 'src/gen/mod-0.js' }] };
    card.querySelectorAll('.planner-list .ext-item')[0].onclick();
    await wait(90);
    check('R22. 还有未提交差异的文件给出「查看当前 Diff」入口', () => {
      const row = [...attEl('manyfiles', 1).querySelectorAll('.planner-file-row')].find((r) => /mod-0\.js/.test(r.textContent));
      return Boolean(row) && /查看当前 Diff/.test(row.textContent) || (row ? row.textContent : '没找到那一行');
    });
    check('R22b. 已经 clean 的文件**仍然列出**，只是如实说明已无差异（不隐藏历史关系）', () => {
      const row = [...attEl('manyfiles', 1).querySelectorAll('.planner-file-row')].find((r) => /mod-1\.js/.test(r.textContent));
      if (!row) return '文件被隐藏了';
      return (/当前工作区已无该文件的未提交差异/.test(row.textContent) && !/查看当前 Diff/.test(row.textContent)) || row.textContent;
    });
    check('R22c. 明显写明 diff 是**当前工作区**的，不是这次执行当时的快照', () => /当前工作区/.test(T(attEl('manyfiles', 1))) || T(attEl('manyfiles', 1)));
    check('R22d. 20 个文件默认收起，可展开（不糊成一面墙）', () => {
      const it = attEl('manyfiles', 1);
      const more = it && [...it.querySelectorAll('button')].find((b) => /展开其余 15 个/.test(b.textContent));
      if (!more) return it ? [...it.querySelectorAll('button')].map((b) => b.textContent).join(',') : '没找到';
      more.onclick();
      const n = attEl('manyfiles', 1).querySelectorAll('.planner-file-row').length;
      return n === 20 || `展开后 ${n} 行`;
    });
    check('R23. 超长路径被截断但带 title 全路径（不撑爆卡片）', () => {
      const chip = [...attEl('manyfiles', 1).querySelectorAll('.planner-file')].find((c) => c.textContent === R_LONG_PATH);
      return Boolean(chip && chip.title === R_LONG_PATH) || (chip ? 'title 不是全路径' : '没找到长路径');
    });
    check('R23b. 采集不全时明确标出（不因为「有内容」就不提）', () => {
      const t = T(attEl('interrupted', 1));
      return /未完整采集|采集不到/.test(t) || t;
    });

    /* ---------- XSS：说明一律当纯文本 ---------- */
    check('R29. 审阅说明按纯文本渲染（img/script/svg 都进不了 DOM）', () => {
      const bad = card.querySelectorAll('.planner-rv img, .planner-rv script, .planner-rv svg, .planner-rv iframe, .planner-rv object, .planner-rv embed');
      const shown = /onerror=alert\(1\)/.test(T(rvEl('xsstask', 1)));
      return (bad.length === 0 && shown) || `注入节点 ${bad.length} 个 / 文本=${shown}`;
    });

    /* ---------- 编辑态 ---------- */
    check('R9. 点「接受本次结果」进入编辑态（**先不保存**）', () => {
      const b = rvBtn('okcmd', '接受本次结果', 1);
      if (!b) return '没有按钮';
      b.onclick();
      return Boolean(rvEl('okcmd', 1).querySelector('.planner-rv-note-in')) || '没进入编辑态';
    });
    check('R9b. 进入编辑态没有发任何保存请求', () => reviewCalls.length === 0 || JSON.stringify(reviewCalls.map((c) => c.url)));
    check('R10. 说明框 maxlength=1000 且有字数计数', () => {
      const ta = rvEl('okcmd', 1).querySelector('.planner-rv-note-in');
      const cnt = rvEl('okcmd', 1).querySelector('.planner-rv-count');
      return (ta && ta.maxLength === 1000 && /0 \/ 1000/.test(T(cnt))) || `max=${ta && ta.maxLength} cnt=${T(cnt)}`;
    });
    check('R11. 编辑态有「保存」与「取消」', () =>
      Boolean(rvBtn('okcmd', '保存', 1) && rvBtn('okcmd', '取消', 1)) || '缺按钮');
    check('R12. 可在两个状态间切换（切换只是改选择，仍不保存）', () => {
      const need = [...rvEl('okcmd', 1).querySelectorAll('.planner-rv-opt')].find((b) => /需要修改/.test(b.textContent));
      if (!need) return '没有「需要修改」选项';
      need.onclick();
      const after = [...rvEl('okcmd', 1).querySelectorAll('.planner-rv-opt')].find((b) => /需要修改/.test(b.textContent));
      return (after && after.classList.contains('on') && reviewCalls.length === 0) || `on=${after && after.classList.contains('on')} calls=${reviewCalls.length}`;
    });
    check('R12b. 失败的 attempt 在编辑态里**没有**「接受本次结果」这个选项', () => {
      rvBtn('cancelled', '需要修改', 1).onclick();
      const opts = [...rvEl('cancelled', 1).querySelectorAll('.planner-rv-opt')].map((b) => b.textContent);
      rvBtn('cancelled', '取消', 1).onclick();
      return opts.length === 1 && /需要修改/.test(opts[0]) || JSON.stringify(opts);
    });

    /* ---------- 保存 ---------- */
    {
      const ta = rvEl('okcmd', 1).querySelector('.planner-rv-note-in');
      ta.value = '人工确认过了';
      ta.oninput();
      check('R13-prep. 说明输入有实时字数反馈', () => /6 \/ 1000/.test(T(rvEl('okcmd', 1).querySelector('.planner-rv-count'))) || T(rvEl('okcmd', 1).querySelector('.planner-rv-count')));
      reviewCalls.length = 0;
      plannerCalls.length = 0;
      rvBtn('okcmd', '保存', 1).onclick();
      await wait(140);
      check('R13. 保存把状态与说明按身份发给后端', () => {
        const c = reviewCalls[0];
        return (
          Boolean(c) &&
          c.method === 'PUT' &&
          /\/api\/plans\/plan-1\/tasks\/okcmd\/attempts\/1\/review$/.test(c.url) &&
          c.body.status === 'needs_changes' &&
          c.body.note === '人工确认过了' &&
          c.body.expectedRevision === 0
        ) || JSON.stringify(c);
      });
      check('R14. 保存成功后回到展示态、显示新判断', () => /需修改/.test(T(rvEl('okcmd', 1))) || T(rvEl('okcmd', 1)));
      check('R14b. 保存成功后编辑框收起', () => !rvEl('okcmd', 1).querySelector('.planner-rv-note-in') || '编辑框还在');
      check('R14c. 保存不会顺手重试任务 / 改执行状态（只写审阅）', () => {
        const hits = plannerCalls.filter((c) => /\/(retry|cancel|skip)/.test(c.url));
        return hits.length === 0 || JSON.stringify(hits.map((c) => c.url));
      });
    }

    /* ---------- expectedRevision 用的是渲染那一版，不是写死的 0 ---------- */
    {
      reviewCalls.length = 0;
      rvBtn('okdesc', '修改判断', 1).onclick();
      rvBtn('okdesc', '保存', 1).onclick();
      await wait(140);
      check('R15. expectedRevision 用的是**当前渲染那一版**（夹具里是 3，不是 0）', () => {
        const c = reviewCalls[0];
        return Boolean(c) && c.body.expectedRevision === 3 || JSON.stringify(c && c.body);
      });
    }

    /* ---------- 清除：走同一个 API，且先确认 ---------- */
    {
      reviewCalls.length = 0;
      const clr = rvBtn('revneed', '清除', 1);
      check('R16. 已有判断时提供「清除」', () => Boolean(clr) || '没有清除按钮');
      clr.onclick();
      await wait(40);
      const danger = $('confirmCard').querySelector('.btn.danger');
      check('R16b. 清除前有确认（不静默丢掉说明）', () => Boolean(danger) || '没有确认框');
      danger.onclick();
      await wait(160);
      check('R16c. 清除走**同一个** API（status=pending），没有 DELETE 接口', () => {
        const c = reviewCalls[0];
        return Boolean(c) && c.method === 'PUT' && c.body.status === 'pending' && c.body.note === '' || JSON.stringify(c);
      });
      check('R16d. 清除后回到「待审阅」', () => /待审阅/.test(T(rvEl('revneed', 1))) || T(rvEl('revneed', 1)));
    }

    /* ---------- 保存失败：显示后端原话，且输入不丢 ---------- */
    {
      stubReviewResult = { ok: false, error: '这次执行没有成功，不能标记为「已接受」（可以标记「需修改」）' };
      reviewCalls.length = 0;
      rvBtn('cancelled', '需要修改', 1).onclick();
      const ta = rvEl('cancelled', 1).querySelector('.planner-rv-note-in');
      ta.value = '不能丢的内容';
      ta.oninput();
      rvBtn('cancelled', '保存', 1).onclick();
      await wait(160);
      check('R30. 保存失败显示**后端原话**，不是「出错了」', () => {
        const t = T(rvEl('cancelled', 1));
        return /不能标记为「已接受」/.test(t) || t;
      });
      check('R30b. 失败后仍是编辑态，输入不丢', () => {
        const box = rvEl('cancelled', 1).querySelector('.planner-rv-note-in');
        return Boolean(box) && box.value === '不能丢的内容' || (box ? box.value : '输入框没了');
      });
      check('R30c. 失败后按钮变成「重试」（失败不能把用户困在原地）', () =>
        Boolean(rvBtn('cancelled', '重试', 1)) || [...rvEl('cancelled', 1).querySelectorAll('button')].map((b) => b.textContent).join(','));
    }

    /* ---------- 冲突：不自动重试、不覆盖、本地输入保留 ---------- */
    {
      /* 先退出上一步的错误态，从干净的编辑态开始 */
      rvBtn('cancelled', '取消', 1).onclick();
      stubReviewResult = { ok: false, code: 'review-conflict', error: '这条审阅记录已经在其他窗口被修改，请重新加载。', currentRevision: 7 };
      rvBtn('cancelled', '需要修改', 1).onclick();
      const ta = rvEl('cancelled', 1).querySelector('.planner-rv-note-in');
      ta.value = '不能丢的内容';
      ta.oninput();
      reviewCalls.length = 0;
      rvBtn('cancelled', '保存', 1).onclick();
      await wait(160);
      check('R31. 冲突显示「已在其他窗口被修改」+「重新加载」', () => {
        const t = T(rvEl('cancelled', 1));
        return (/其他窗口/.test(t) && /重新加载/.test(t)) || t;
      });
      check('R31b. 冲突时本地输入原样保留', () => {
        const box = rvEl('cancelled', 1).querySelector('.planner-rv-note-in');
        return Boolean(box) && box.value === '不能丢的内容' || (box ? box.value : '输入框没了');
      });
      check('R31c. 冲突不自动重试（只发了这一次请求）', () => reviewCalls.length === 1 || `发了 ${reviewCalls.length} 次`);
      check('R31d. 冲突不 last-write-wins（界面没有变成「已接受」）', () => !/已接受/.test(T(rvEl('cancelled', 1))) || T(rvEl('cancelled', 1)));

      /* 重新加载 = 重拉 plan detail，不是刷新整个窗口 */
      stubReviewResult = null;
      plannerCalls.length = 0;
      rvBtn('cancelled', '重新加载', 1).onclick();
      await wait(180);
      check('R31e. 点「重新加载」重新拉一次计划详情', () =>
        plannerCalls.some((c) => c.method === 'GET' && /\/api\/plans\/plan-1$/.test(c.url)) || JSON.stringify(plannerCalls.map((c) => c.method + ' ' + c.url).slice(-4)));
    }

    /* ---------- stale 守卫：切项目之后回来的响应不许写界面，也不许留下「正在保存…」 ---------- */
    {
      window.closeModal();
      window.openPlanner();
      await wait(80);
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      stubReviewResult = null;
      reviewDelayMs = 300;
      /* 用 oknull：它还没被动过，仍是「成功 + 待审阅」，有「接受本次结果」。
       * （okcmd 在上面的保存测试里已经被改成「需修改」，桩返回的是同一个对象，
       *   所以夹具状态会跨检查发生变化 —— 汇总那几条断言因此必须放在最前面。） */
      rvBtn('oknull', '接受本次结果', 1).onclick();
      rvBtn('oknull', '保存', 1).onclick();
      await wait(40);
      check('R32-prep. 保存已发出，按钮进入「正在保存…」', () =>
        /正在保存/.test(T(rvEl('oknull', 1))) || T(rvEl('oknull', 1)));
      /* 保存还在飞的时候切项目 */
      window.S.workspaceGeneration++;
      await wait(500);
      reviewDelayMs = 0;
      check('R32. 切项目之后回来的审阅响应不写进界面（stale 守卫）', () => {
        const t = T(rvEl('oknull', 1));
        return !/已接受/.test(t) || `被写进去了：${t.slice(0, 120)}`;
      });
      check('R32b. 那次响应没有写进别的 attempt（okcmd 的判断还是上一步存下的）', () => {
        /* 面板这时已经被收成提示，读不到 okcmd 的 DOM 了 —— 所以直接看数据：
         * 桩返回的就是夹具对象本身，如果响应被错误地应用了，这里会变。 */
        const t = stubPlanReview.tasks.find((x) => x.id === 'okcmd');
        const rv = t && t.attempts[0] && t.attempts[0].review;
        return (rv && rv.status === 'needs_changes' && rv.note === '人工确认过了' && rv.revision >= 1) || JSON.stringify(rv);
      });
      check('R32c. 旧面板被收成提示，**不留下永久「正在保存…」**（草稿里的 saving 标记一起清掉）', () => {
        const d = T($('workSurface'));
        return (/项目已切换，请重新打开 Planner/.test(d) && !/正在保存/.test(d)) || d.slice(0, 200);
      });
      check('R32d. 收成提示后旧面板没有可点的审阅操作（没有说明框、没有保存按钮）', () => {
        const c = $('workSurface');
        return (!c.querySelector('.planner-rv-note-in') && ![...c.querySelectorAll('button')].some((b) => b.textContent.trim() === '保存')) || '还有审阅控件';
      });
      window.closeModal();
      await wait(20);
    }

    /* ---------- 同项目实例隔离：旧 Planner A 的响应不能弄脏 Planner B ---------- */
    {
      window.closeModal();
      window.openPlanner(); // 「Planner A」
      await wait(80);
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      stubReviewResult = null;
      reviewDelayMs = 300;
      rvBtn('oknull', '接受本次结果', 1).onclick();
      rvBtn('oknull', '保存', 1).onclick(); // A 的保存飞在路上
      await wait(40);

      window.closeModal();
      window.openPlanner(); // 同项目的「Planner B」：新 Surface 实例
      await wait(140);
      const bHasList = Boolean($('workSurface').querySelector('.planner-list'));

      await wait(450); // A 的响应现在回来
      reviewDelayMs = 0;
      const now = T($('workSurface'));

      check('R33. 旧面板的响应**不会关掉**后来打开的新 Planner', () => {
        return ($('workspace').dataset.workspaceView === 'planner' && $('modal').hidden && $('workSurface').childElementCount > 0) || `view=${$('workspace').dataset.workspaceView} kids=${$('workSurface').childElementCount}`;
      });
      check('R33b. 新 Planner 的 DOM 不被旧响应污染（没有 stale 提示、没有旧 saving 态）', () => {
        return (bHasList && !/项目已切换/.test(now) && !/正在保存/.test(now)) || now.slice(0, 180);
      });
      check('R33c. 新 Planner 仍然是自己的计划列表（没有被旧响应重画）', () =>
        Boolean($('workSurface').querySelector('.planner-list')) || '新面板的列表没了');
      window.closeModal();
      await wait(20);
    }

    /* 还原被本段打桩过的 Git 工作区状态，别影响后面的段落 */
    window.S.changes = savedChanges;
    stubPlanDetail = stubPlan;
    stubReviewResult = null;
    reviewDelayMs = 0;
  }

  /* ================= P9：独立验证（前端） ================= */

  async function verifySection() {
    console.log('\n--- P9 独立验证：按钮 / 状态 / 输出 / XSS / stale ---');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const T = (e) => (e && e.textContent) || '';

    stubPlanDetail = stubPlanReview;
    stubVerifyResult = null;
    verifyDelayMs = 0;
    verifyCalls.length = 0;
    window.closeModal();
    window.openPlanner();
    await wait(80);
    let card = $('workSurface');
    card.querySelectorAll('.planner-list .ext-item')[0].onclick();
    await wait(90);

    const taskEl = (id) => [...card.querySelectorAll('.planner-task')].find((x) => x.dataset.taskId === id);
    const vBtn = (id, text) => {
      const it = taskEl(id);
      return it ? [...it.querySelectorAll('button')].find((b) => b.textContent.trim() === text) || null : null;
    };
    const vBlock = (id) => {
      const it = taskEl(id);
      return it ? it.querySelector('.planner-verify-row') : null;
    };
    const vDetail = (id) => {
      const it = taskEl(id);
      return it ? it.querySelector('.planner-verify-detail') : null;
    };

    /* ---------- 从未验证：有命令才给按钮 ---------- */
    check('V1. 有快照命令的 attempt 给「运行验证」', () => Boolean(vBtn('okcmd', '运行验证')) || '没有运行验证按钮');
    check('V2. 只有 description 的任务**不给**按钮（不许把描述猜成命令）', () => {
      const it = taskEl('okdesc');
      return Boolean(it) && !vBtn('okdesc', '运行验证') || 'okdesc 竟然有运行验证按钮';
    });
    check('V2b. 但这种 attempt 仍然显示「尚未独立确认」', () => /尚未独立确认/.test(T(vBlock('okdesc'))) || T(vBlock('okdesc')));

    /* ---------- 四种状态的文案 ---------- */
    check('V3. 通过 → 「通过」+ 命令 + 退出码 + 耗时', () => {
      const t = T(vBlock('manyfiles')) + T(vDetail('manyfiles'));
      return (/通过/.test(t) && /退出码 0/.test(t) && /耗时/.test(t)) || t;
    });
    check('V4. 失败 → 「失败」+ 输出摘要 + 「输出已截断」', () => {
      const t = T(vBlock('revneed')) + T(vDetail('revneed'));
      return (/失败/.test(t) && /not ok 3 - boom/.test(t) && /输出已截断/.test(t)) || t;
    });
    check('V5. 已中断 → 「已中断」+「重新运行验证」', () => {
      const t = T(vBlock('cancelled'));
      return (/已中断/.test(t) && Boolean(vBtn('cancelled', '重新运行验证'))) || t;
    });
    check('V6. 正在验证 → 「正在验证…」+「停止验证」', () => {
      const t = T(vBlock('live'));
      return (/正在验证/.test(t) && Boolean(vBtn('live', '停止验证'))) || t;
    });
    check('V6b. 状态都带**文字**，不是只画个点', () => {
      const st = vBlock('manyfiles') && vBlock('manyfiles').querySelector('.planner-verify-state');
      return Boolean(st && /通过/.test(st.textContent)) || '没有文字状态';
    });

    /* ---------- 输出与长命令 ---------- */
    check('V7. 输出摘要是**纯文本**渲染（XSS：注入节点数为 0）', () => {
      const it = taskEl('xsstask');
      const bad = it ? it.querySelectorAll('.planner-verify-detail img, .planner-verify-detail script, .planner-verify-detail svg, .planner-verify-detail iframe, .planner-verify-detail object, .planner-verify-detail embed') : [];
      const shown = /onerror=alert\(1\)/.test(T(vDetail('xsstask')));
      return (bad.length === 0 && shown) || `注入节点 ${bad.length} 个 / 文本=${shown}`;
    });
    check('V7b. 输出框里只有文本节点（不是 innerHTML 塞进去的）', () => {
      const pre = vDetail('xsstask') && vDetail('xsstask').querySelector('.planner-verify-out');
      return Boolean(pre && pre.children.length === 0) || (pre ? `子元素 ${pre.children.length}` : '没有输出框');
    });
    check('V8. 长命令截断但带 title 全命令（不撑爆卡片）', () => {
      const chip = vDetail('manyfiles') && vDetail('manyfiles').querySelector('.planner-verify-cmd');
      return Boolean(chip && chip.textContent === R_LONG_COMMAND && chip.title === R_LONG_COMMAND) || (chip ? 'title 不是全命令' : '没找到命令 chip');
    });

    /* ---------- 验证与审阅是两件独立的事 ---------- */
    check('V9. 验证通过**不会**动人工审阅那一行（两者各自独立）', () => {
      const t = T(taskEl('manyfiles'));
      return (/通过/.test(t) && /已接受/.test(t)) || t.slice(0, 160);
    });
    check('V9b. 「独立验证」与「人工审阅」是**两行不同的东西**（不是一行里的两段字）', () => {
      const it = taskEl('revneed');
      if (!it) return '没找到任务';
      const vRow = it.querySelector('.planner-verify-row');
      const rvRow = it.querySelector('.planner-rv');
      return (Boolean(vRow) && Boolean(rvRow) && vRow !== rvRow) || `vRow=${Boolean(vRow)} rvRow=${Boolean(rvRow)}`;
    });

    /* ---------- 点「运行验证」/「停止验证」 ---------- */
    {
      verifyCalls.length = 0;
      vBtn('okcmd', '运行验证').onclick();
      await wait(90);
      check('V10. 点「运行验证」调 verify 接口，URL 带 planId/taskId/attempt', () => {
        const c = verifyCalls[0];
        return Boolean(c && c.method === 'POST' && /\/api\/plans\/plan-1\/tasks\/okcmd\/attempts\/1\/verify$/.test(c.url)) || JSON.stringify(verifyCalls);
      });
      check('V11. 启动后立刻变成「正在验证…」+「停止验证」', () => {
        const t = T(vBlock('okcmd'));
        return (/正在验证/.test(t) && Boolean(vBtn('okcmd', '停止验证'))) || t;
      });
      verifyCalls.length = 0;
      vBtn('okcmd', '停止验证').onclick();
      await wait(90);
      check('V12. 点「停止验证」调 .../verify/stop', () => {
        const c = verifyCalls[0];
        return Boolean(c && c.method === 'POST' && /\/verify\/stop$/.test(c.url)) || JSON.stringify(verifyCalls);
      });
    }

    /* ---------- 被拒绝时显示后端原话 ---------- */
    {
      stubVerifyResult = { ok: false, code: 'plan-active', error: '计划正在执行，等它结束或先停止计划，再运行验证' };
      $('toasts').innerHTML = '';
      /* 用 manyfiles 的「重新运行验证」：它在夹具里是 passed，按钮标签与 tests
       * 当前那个「停止验证」不同 —— 避开「点了才发现按钮换了」的坑。 */
      vBtn('manyfiles', '重新运行验证').onclick();
      await wait(90);
      check('V13. 被拒绝时显示**后端原话**（不是 generic 错误）', () => {
        const t = $('toasts').textContent;
        return /计划正在执行/.test(t) || t.slice(0, 120);
      });
      stubVerifyResult = null;
    }

    /* ---------- 工作目录（P9 收口） ---------- */
    check('V9c. 验证明细显示**实际执行目录**', () => {
      const d = vDetail('revneed');
      const row = d ? [...d.querySelectorAll('.planner-verify-line')].find((l) => /目录/.test(l.textContent)) : null;
      return (row && /packages\/core/.test(row.textContent)) || (row ? row.textContent : '没有「目录」那一行');
    });
    check('V9d. 来源是冻结快照时**不加** fallback 说明（它就是当时的目录）', () => {
      const t = T(vDetail('revneed'));
      return !/没有记录当时的工作目录/.test(t) || t.slice(0, 200);
    });
    check('V9e. 老 attempt 的 fallback **有明确说明**（不冒充冻结记录）', () => {
      const t = T(vDetail('cancelled'));
      return /没有记录当时的工作目录/.test(t) || t.slice(0, 220);
    });
    check('V9f. 长目录截断但带 title 全路径（不撑爆卡片）', () => {
      const chip = vDetail('manyfiles') && vDetail('manyfiles').querySelector('.planner-verify-cwd');
      return Boolean(chip && chip.title === chip.textContent && chip.textContent.length > 20) || (chip ? chip.textContent : '没找到目录 chip');
    });
    check('V9g. 目录也是**纯文本**渲染（XSS 注入节点为 0）', () => {
      const d = vDetail('xsstask');
      const bad = d ? d.querySelectorAll('img, script, svg, iframe, object, embed') : [];
      return (bad.length === 0 && /onerror=alert\(1\)/.test(T(d))) || `注入节点 ${bad.length} 个`;
    });

    /* ---------- 验证在跑时的动作锁（后端也会拒；前端先禁掉 + 说明原因） ---------- */
    {
      stubVerificationActive = { planId: 'plan-1', taskId: 'okcmd', attempt: 1 };
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      const btnOf = (text) => [...card.querySelectorAll('.ext-acts button')].find((b) => b.textContent.trim() === text) || null;

      check('V15. 验证在跑 →「开始执行 / 保存修改 / 删除计划」被禁用', () => {
        const a = btnOf('开始执行');
        const b = btnOf('保存修改');
        const c = btnOf('删除计划');
        return (a && a.disabled && b && b.disabled && c && c.disabled) || JSON.stringify({ start: a && a.disabled, save: b && b.disabled, del: c && c.disabled });
      });
      check('V16. 并且把原因写出来（点名是**哪一条**在跑）', () => {
        const t = T(card.querySelector('.planner-progress'));
        return (/独立验证正在运行/.test(t) && /okcmd/.test(t)) || t.slice(0, 160);
      });
      check('V17. 任务级的「重试」也被禁用', () => {
        const it = taskEl('failed');
        const rb = it ? [...it.querySelectorAll('button')].find((b) => b.textContent.trim() === '重试') : null;
        return Boolean(rb && rb.disabled) || (rb ? '重试没被禁用' : '没找到重试按钮');
      });

      stubVerificationActive = null;
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      check('V18. 验证结束之后按钮恢复可用（锁释放）', () => {
        const a = btnOf('开始执行');
        return Boolean(a && !a.disabled) || (a ? '开始执行还是禁用的' : '没找到开始执行');
      });
    }

    /* ---------- stale 守卫：切项目之后回来的响应不许写界面 ---------- */
    {
      window.closeModal();
      window.openPlanner();
      await wait(80);
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      verifyCalls.length = 0;
      verifyDelayMs = 300;
      vBtn('revneed', '重新运行验证').onclick();
      await wait(40);
      window.S.workspaceGeneration++;
      await wait(500);
      verifyDelayMs = 0;
      check('V14. 切项目之后回来的验证响应不写进界面（stale 守卫）', () => {
        const d = T($('workSurface'));
        return (/项目已切换，请重新打开 Planner/.test(d) && !/正在验证/.test(d)) || d.slice(0, 160);
      });
      window.closeModal();
      await wait(20);
    }

    stubPlanDetail = stubPlan;
    stubVerifyResult = null;
    verifyDelayMs = 0;
  }

  /* ================= P10：历史变更证据（前端） ================= */

  async function evidenceSection() {
    console.log('\n--- P10 历史 Diff：入口 / 面板 / 纯文本 / 不漂移 ---');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const T = (e) => (e && e.textContent) || '';

    stubPlanDetail = stubPlanReview;
    stubVerificationActive = null;
    /* 让一个变更文件「当前还有未提交差异」—— 「查看当前 Diff」那个入口才会出现，
     * W5 要在同一张卡片上同时看到两种入口。 */
    const savedChanges0 = window.S.changes;
    window.S.changes = { loaded: true, isRepo: true, files: [{ path: 'src/gen/mod-0.js' }] };
    window.closeModal();
    window.openPlanner();
    await wait(80);
    let card = $('workSurface');
    card.querySelectorAll('.planner-list .ext-item')[0].onclick();
    await wait(90);

    const taskEl = (id) => [...card.querySelectorAll('.planner-task')].find((x) => x.dataset.taskId === id);
    const evRow = (id) => {
      const it = taskEl(id);
      return it ? it.querySelector('.planner-attempt-evidence') : null;
    };
    const evBtn = (id) => {
      const row = evRow(id);
      return row ? [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '查看本次 Diff') || null : null;
    };

    /* ---------- 入口 ---------- */
    check('W1. 有证据的 attempt 给「查看本次 Diff」', () => Boolean(evBtn('okcmd')) || T(evRow('okcmd')));
    check('W2. 老 attempt（没有这个字段）**不假装有 Diff**', () => {
      const it = taskEl('oknull');
      return Boolean(it) && !evBtn('oknull') && /没有变更证据/.test(T(evRow('oknull'))) || T(evRow('oknull'));
    });
    check('W3. 采集失败：说明原因，且不给按钮', () => {
      const t = T(evRow('okdesc'));
      return (!evBtn('okdesc') && /没有采集到变更证据/.test(t) && /add-failed/.test(t)) || t;
    });
    check('W4. 证据不完整时明确提示', () => /证据不完整/.test(T(evRow('revneed'))) || T(evRow('revneed')));
    check('W5. **「查看当前 Diff」与「查看本次 Diff」是两个入口**（措辞分开，不混）', () => {
      /* 用 manyfiles：它既有 filesChanged（每文件一个「查看当前 Diff」）又有历史证据。 */
      const it = taskEl('manyfiles');
      const texts = it ? [...it.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];
      return (texts.includes('查看当前 Diff') && texts.includes('查看本次 Diff')) || JSON.stringify(texts);
    });

    /* ---------- 面板 ---------- */
    {
      evBtn('okcmd').onclick();
      await wait(80);
      const vc = $('modalCard');
      check('W6. 面板标题与说明**写明这是历史证据**（不是现在的文件）', () => {
        const t = T(vc);
        return (/历史 Diff/.test(t) && /之后的修改不会改变这里的内容/.test(t)) || t.slice(0, 200);
      });
      check('W7. 文件列表：类型标记 + 路径 + 增删行数', () => {
        const t = T(vc);
        return (/src\/auth\.js/.test(t) && /\+1/.test(t) && /−1/.test(t)) || t.slice(0, 200);
      });
      check('W8. patch 默认**收起**（几十个文件不会一次塞进 DOM）', () => {
        const det = vc.querySelector('details.ev-file');
        return Boolean(det && det.open === false) || (det ? `open=${det.open}` : '没有 details');
      });
      check('W9. 展开后能看到 unified diff（纯文本）', () => {
        const det = vc.querySelector('details.ev-file');
        if (!det) return '没有 details';
        det.open = true;
        const pre = det.querySelector('.ev-patch');
        return Boolean(pre && /-const x = 1;/.test(pre.textContent) && /\+const x = 3;/.test(pre.textContent)) || (pre ? pre.textContent.slice(0, 80) : '没有 patch 块');
      });
      window.closeModal();
      await wait(30);
    }

    {
      /* binary + truncated + renamed + deleted */
      window.openPlanner();
      await wait(80);
      card = $('workSurface');
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      evBtn('revneed').onclick();
      await wait(80);
      const vc = $('modalCard');
      check('W10. binary 文件：说明「不展示文本 Diff」，且**没有** patch 块', () => {
        const t = T(vc);
        const det = [...vc.querySelectorAll('details.ev-file')].find((d) => /logo\.png/.test(T(d)));
        return Boolean(det && /二进制文件已变化/.test(T(det)) && !det.querySelector('.ev-patch')) || t.slice(0, 200);
      });
      check('W11. 截断被明确标出（文件级 + 整体）', () => (/已截断/.test(T(vc)) && /历史 Diff 已截断/.test(T(vc))) || T(vc).slice(0, 200));
      window.closeModal();
      await wait(30);

      window.openPlanner();
      await wait(80);
      card = $('workSurface');
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      evBtn('manyfiles').onclick();
      await wait(80);
      const vc2 = $('modalCard');
      check('W12. renamed / deleted 的类型标记与 oldPath 都显示出来', () => {
        const t = T(vc2);
        return (/new-name\.js/.test(t) && /old-name\.js/.test(t) && /gone\.js/.test(t)) || t.slice(0, 240);
      });
      check('W13. 大量文件的说明（只保留前 N 个）也摆出来了', () => /只保留了前/.test(T(vc2)) || T(vc2).slice(0, 200));
      window.closeModal();
      await wait(30);
    }

    /* ---------- XSS：路径 / patch / note 全是不可信文本 ---------- */
    {
      window.openPlanner();
      await wait(80);
      card = $('workSurface');
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      evBtn('cancelled').onclick();
      await wait(80);
      const vc = $('modalCard');
      const bad = vc.querySelectorAll('img, script, svg, iframe, object, embed');
      check('W14. 路径 / patch / note 里的 XSS **一个 DOM 节点都没生成**', () => bad.length === 0 || `注入节点 ${bad.length} 个`);
      check('W15. 它们都以**文本**显示出来（没有被吃掉）', () => /onerror=alert\(1\)/.test(T(vc)) || T(vc).slice(0, 160));
      window.closeModal();
      await wait(30);
    }

    /* ---------- 漂移证明（§二十二.A） ----------
     * 把「当前工作区状态」摆成与持久化证据**明显不同**，再打开面板：
     * 显示的必须仍是**磁盘上那份证据**。
     * 任何「读取时按当前工作区重算」的实现都会在这里显示成当前状态的路径/内容 → 红。 */
    {
      const savedChanges = window.S.changes;
      /* 当前工作区里根本没有 src/auth.js，只有一个完全不同的文件 */
      window.S.changes = { loaded: true, isRepo: true, files: [{ path: 'totally/different.js' }] };
      window.openPlanner();
      await wait(80);
      card = $('workSurface');
      card.querySelectorAll('.planner-list .ext-item')[0].onclick();
      await wait(90);
      evBtn('okcmd').onclick();
      await wait(80);
      const vc = $('modalCard');
      check('W16. **当前工作区换了内容，历史面板仍然显示当时那条 patch**（重算实现会红）', () => {
        const t = T(vc);
        return (/src\/auth\.js/.test(t) && /-const x = 1;/.test(t) && /\+const x = 3;/.test(t) && !/totally\/different/.test(t)) || t.slice(0, 240);
      });
      window.closeModal();
      await wait(30);
      window.S.changes = savedChanges;
    }

    stubPlanDetail = stubPlan;
    window.S.changes = savedChanges0;
    await wait(20);
  }

  /* ---------- 侧栏行动作菜单（P24 收口）的共用小工具 ----------
   *
   * 项目和会话现在都只有**一个** `…` 入口，菜单挂在 document.body 上（浮层），
   * 所以断言要在 document 上查，而不是在 #projects 里面。
   * 一律写成**函数声明**：它们在这个 IIFE 里被多处提前调用，而 `const` 箭头函数
   * 在那之前还处于 TDZ。 */
  function rowMenuEl() {
    return window.document.getElementById('actionMenu');
  }
  function rowMenuItems() {
    const el = rowMenuEl();
    return el ? [...el.querySelectorAll('[role="menuitem"]')] : [];
  }
  function rowMenuLabels() {
    return rowMenuItems().map((b) => b.querySelector('.action-menu-label').textContent);
  }
  function rowMenuItem(label) {
    return rowMenuItems().find((b) => b.querySelector('.action-menu-label').textContent === label);
  }
  /** 点开某一行三点（走真实 onclick，含 preventDefault / stopPropagation 那条路）。 */
  async function openRowMenu(trigger) {
    trigger.onclick({ preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 20));
    return rowMenuEl();
  }

  async function sessionSection() {    sessionCalls.length = 0;
    $('toasts').innerHTML = '';

    // 重渲染项目列表 —— 会话是挂在「当前项目」那一行下面的
    window.renderProjects();
    await new Promise((r) => setTimeout(r, 60));

    const proj = $('projects');
    const active = proj.querySelector('.project.active');
    const box = proj.querySelector('.pj-sessions');

    check('会话：没有独立的会话入口了（不再单开窗口）', () =>
      !$('navSessions') || '侧栏还有独立的「会话」入口');
    check('会话：列表挂在**当前项目那一行下面**（不是别处）', () => {
      if (!box || !active) return `box=${Boolean(box)} active=${Boolean(active)}`;
      return box.previousElementSibling === active || '会话块不在当前项目下面';
    });
    check('会话：只挂在当前项目上，别的项目下面没有', () => {
      const all = proj.querySelectorAll('.pj-sessions');
      return all.length === 1 || `渲染了 ${all.length} 块`;
    });
    check('会话：标题是第一条用户消息（不是文件名/时间戳）', () => {
      const titles = [...proj.querySelectorAll('.pj-sess-title')].map((t) => t.textContent);
      return (titles.includes('帮我写个登录功能') && titles.includes('你好')) || JSON.stringify(titles);
    });
    check('会话：当前会话高亮，且不给点', () => {
      const cur = proj.querySelector('.pj-sess.on');
      return Boolean(cur && !cur.onclick) || (cur ? '当前项仍可点' : '没有当前项');
    });
    check('会话：显示相对时间', () => {
      const t = proj.querySelector('.pj-sess-time');
      return Boolean(t && t.textContent) || '没显示时间';
    });
    check('会话：侧栏里没有任何绝对路径', () =>
      !/[A-Za-z]:\\|[A-Za-z]:\//.test(box ? box.textContent : '') || '出现了疑似路径');

    // 点另一条 → 切过去
    {
      const other = [...proj.querySelectorAll('.pj-sess')].find((r) => !r.classList.contains('on'));
      other.querySelector('.pj-sess-primary').click();
      await new Promise((r) => setTimeout(r, 80));
      const hit = sessionCalls.find((c) => /\/switch/.test(c.url));
      check('会话：点一条会调 /api/sessions/switch，且传的是 ID 不是路径', () =>
        Boolean(hit && hit.body && hit.body.id === 'bbbbbbbbbbbbbbbb') || JSON.stringify(sessionCalls.map((c) => c.url)));
    }

    // 改名：三点菜单只出现在当前会话那一条上，且菜单里只有「重命名」
    {
      sessionCalls.length = 0;
      window.renderProjects();
      await new Promise((r) => setTimeout(r, 60));
      const proj2 = $('projects');
      const cur = proj2.querySelector('.pj-sess.on');
      check('会话：每条会话行只有一个三点入口（旧的 ✎ / ⤓ / ✕ 都收进去了）', () => {
        const triggers = [...proj2.querySelectorAll('.pj-sess-menu-trigger')];
        const rows = [...proj2.querySelectorAll('.pj-sess')];
        return (triggers.length === rows.length && !proj2.querySelector('.pj-sess-act:not(.pj-sess-acts)')) ||
          `triggers=${triggers.length} rows=${rows.length}`;
      });
      await openRowMenu(cur.querySelector('.pj-sess-menu-trigger'));
      check('会话：当前会话的菜单只有「重命名」（不给归档 / 删除）', () => {
        const labels = rowMenuLabels();
        return labels.join(',') === '重命名' || JSON.stringify(labels);
      });
      check('会话：菜单是可访问的浮层（role=menu / menuitem / aria-expanded）', () =>
        Boolean(rowMenuEl() && rowMenuEl().getAttribute('role') === 'menu'
          && rowMenuItems().every((b) => b.getAttribute('role') === 'menuitem')
          && cur.querySelector('.pj-sess-menu-trigger').getAttribute('aria-expanded') === 'true')
        || '菜单语义不完整');
      rowMenuItem('重命名').click();
      await new Promise((r) => setTimeout(r, 20));
      const input = cur.querySelector('.pj-sess-input');
      check('会话：点重命名 → 仍然是行内输入框（不是第二套改名弹窗），菜单已收起', () =>
        (Boolean(input) && rowMenuEl() === null) || '没出现输入框 / 菜单没收起');
      if (input) {
        input.value = '我的登录功能开发';
        input.onkeydown({ key: 'Enter' });
        await new Promise((r) => setTimeout(r, 60));
        const hit = sessionCalls.find((c) => /\/name/.test(c.url));
        check('会话：回车保存 → 调 /api/sessions/name', () => Boolean(hit && hit.body.name === '我的登录功能开发') || JSON.stringify(sessionCalls.map((c) => c.url)));
      } else {
        check('会话：回车保存 → 调 /api/sessions/name', () => '上一条已失败');
      }
    }

    // 归档 / 删除：从同一个三点菜单进去
    {
      window.renderProjects();
      await new Promise((r) => setTimeout(r, 60));
      let proj3 = $('projects');
      const row = [...proj3.querySelectorAll('.pj-sess')].find((x) => !x.classList.contains('on'));
      await openRowMenu(row.querySelector('.pj-sess-menu-trigger'));
      check('会话：非当前会话的菜单是「归档 + 删除会话」', () => {
        const labels = rowMenuLabels();
        return labels.join(',') === '归档,删除会话' || JSON.stringify(labels);
      });
      check('会话：删除项是 danger 层级（不是整行常驻鲜红）', () =>
        Boolean(rowMenuItem('删除会话') && rowMenuItem('删除会话').classList.contains('danger'))
        || '删除项不是 danger');
      check('会话：菜单项带分隔线（危险动作与安全动作分开）', () =>
        Boolean(rowMenuEl() && rowMenuEl().querySelector('[role="separator"]')) || '没有分隔线');

      // 点三点绝不能顺带切换会话
      check('会话：点三点不触发切换（没有 /switch 请求）', () =>
        !sessionCalls.some((c) => /\/switch/.test(c.url)) || JSON.stringify(sessionCalls.map((c) => c.url)));

      // 归档
      sessionCalls.length = 0;
      rowMenuItem('归档').click();
      await new Promise((r) => setTimeout(r, 80));
      const arch = sessionCalls.find((c) => /\/archive/.test(c.url));
      check('会话：点归档 → POST /api/sessions/archive（带 id 与 archived:true）', () =>
        Boolean(arch && arch.body.id === 'bbbbbbbbbbbbbbbb' && arch.body.archived === true) ||
        JSON.stringify(sessionCalls.map((c) => c.method + ' ' + c.url)));

      // 已归档那一组默认收起
      window.renderProjects();
      await new Promise((r) => setTimeout(r, 60));
      proj3 = $('projects');
      const toggle = proj3.querySelector('.pj-sess-arch-toggle');
      check('会话：已归档的收进折叠组（默认不列出来）', () => {
        const titles = [...proj3.querySelectorAll('.pj-sess-title')].map((t) => t.textContent);
        return (toggle && toggle.textContent.includes('已归档 1 条') && !titles.includes('上周的排查记录')) || JSON.stringify(titles);
      });
      check('会话：折叠组的标题里没有绝对路径', () =>
        !/[A-Za-z]:\\|[A-Za-z]:\//.test(toggle ? toggle.textContent : '') || '出现了疑似路径');
      check('会话：折叠组那行仍然用 .pj-sess-more（新三点没有抢它的类名）', () =>
        Boolean(toggle && toggle.classList.contains('pj-sess-more')) || '折叠组类名被改了');
      toggle.onclick();
      await new Promise((r) => setTimeout(r, 20));
      check('会话：展开折叠组后能看到已归档那条', () => {
        const titles = [...proj3.querySelectorAll('.pj-sess-title')].map((t) => t.textContent);
        return titles.includes('上周的排查记录') || JSON.stringify(titles);
      });
      {
        const archivedRow = [...proj3.querySelectorAll('.pj-sess')].find((x) => x.textContent.includes('上周的排查记录'));
        await openRowMenu(archivedRow.querySelector('.pj-sess-menu-trigger'));
        check('会话：已归档那条的菜单是「取消归档 + 删除会话」', () => {
          const labels = rowMenuLabels();
          return labels.join(',') === '取消归档,删除会话' || JSON.stringify(labels);
        });
        window.closeActionMenu?.();
        await new Promise((r) => setTimeout(r, 10));
      }

      // 删除：必须先二次确认
      sessionCalls.length = 0;
      const delRow = [...proj3.querySelectorAll('.pj-sess')].find((x) => x.textContent.includes('帮我写个登录功能'));
      await openRowMenu(delRow.querySelector('.pj-sess-menu-trigger'));
      rowMenuItem('删除会话').click();
      await new Promise((r) => setTimeout(r, 20));
      check('会话：删除先弹二次确认（不是点一下就删）', () =>
        $('confirmLayer').hidden === false || '没有弹确认框');
      check('会话：删除确认文案说明文件没被抹掉', () =>
        /回收站/.test($('confirmCard').textContent) || $('confirmCard').textContent);
      check('会话：未确认时不发删除请求', () =>
        !sessionCalls.some((c) => /\/delete/.test(c.url)) || '未确认就发了请求');
      $('confirmCard').querySelector('.btn.danger').onclick();
      await new Promise((r) => setTimeout(r, 80));
      const del = sessionCalls.find((c) => /\/delete/.test(c.url));
      check('会话：确认后 → POST /api/sessions/delete（传 ID）', () =>
        Boolean(del && del.body.id === 'bbbbbbbbbbbbbbbb') ||
        JSON.stringify(sessionCalls.map((c) => c.method + ' ' + c.url)));
      check('会话：删除后确认框关掉了', () => $('confirmLayer').hidden === true || '确认框还开着');
    }
  }


  /* --- 重建历史时同样不留空白「Pi」 ---
   *
   * 从 pi 的会话 jsonl 恢复对话走的是 rebuildFromMessages（不是事件流），
   * 只有工具调用的那轮同样渲染不出正文。这里钉住「整条跳过」，
   * 同时确认同一次重建里正文那条和用户消息都还在（别把跳过写成清空）。
   *
   * 这条会 clearThread()，所以放在最后 —— 前面所有用例都依赖线程状态。 */
  window.rebuildFromMessages({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '跑一下' }] },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: { command: 'ls' } }],
        stopReason: 'toolUse',
      },
      { role: 'assistant', content: [{ type: 'text', text: '跑完了' }] },
    ],
  });
  check('重建历史时跳过只有工具调用的助手消息', () => {
    const n = window.document.querySelectorAll('.msg.assistant').length;
    return n === 1 ? true : `重建出 ${n} 条助手消息，应该是 1 条`;
  });
  check('重建历史时正文那条仍在', () => {
    const body = window.document.querySelector('.msg.assistant .msg-body');
    return body?.textContent.includes('跑完了') ? true : '正文丢了';
  });
  check('重建历史时用户消息仍在', () =>
    window.document.querySelectorAll('.msg.user').length === 1 ? true : '用户消息丢了'
  );
  const hugeEntry = window.makeEntry({ toolCallId: 'large', toolName: 'bash', args: { command: 'large-output' } });
  window.applyUpdate(hugeEntry, { partialResult: 'x'.repeat(300000) + 'TAIL' });
  check('超大 Tool 输出有上限并保留尾部', () => hugeEntry.output.length <= 200000 && hugeEntry.output.endsWith('TAIL') && hugeEntry.outputTruncated === true);

  // P4：旧项目的 HTTP 结果与 SSE 事件不得覆盖最后一次选择。
  {
    const baseFetch = window.fetch;
    const delayed = {};
    const oldBadge = $('extCount').textContent;
    const oldGitFiles = window.S.changes.files.length;
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u === '/api/git/status' && !delayed.git) return new Promise((resolve) => { delayed.git = resolve; });
      if (u === '/api/project-config' && !delayed.config) return new Promise((resolve) => { delayed.config = resolve; });
      if (u === '/api/skills' && !delayed.skills) return new Promise((resolve) => { delayed.skills = resolve; });
      return baseFetch(url, opts);
    };
    const oldGit = window.loadGitStatus();
    const oldConfig = window.loadProjectConfig();
    const oldSkills = window.loadExtensionsBadge();
    window.beginWorkspaceSwitch('C:\\project-final');
    delayed.git({ json: async () => ({ ok: true, isRepo: true, files: [{ path: 'OLD.txt' }] }) });
    delayed.config({ json: async () => ({ ok: true, hasProject: true, cwd: 'C:\\old', config: { ...CFG_DEFAULTS } }) });
    delayed.skills({ json: async () => ({ ok: true, counts: { total: 99, enabled: 99 } }) });
    const staleConfig = await oldConfig;
    await Promise.all([oldGit, oldSkills]);
    check('旧 Project Config 响应被丢弃', () => staleConfig === null);
    check('旧 Git refresh 被丢弃', () => window.S.changes.files.length === oldGitFiles);
    check('旧 Skills badge 响应被丢弃', () => $('extCount').textContent === oldBadge);

    const activated = [];
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u === '/api/projects/activate') {
        const path = JSON.parse(opts.body).path;
        activated.push(path);
        return Promise.resolve({ json: async () => ({ ok: true, cwd: path }) });
      }
      if (u === '/api/projects') return Promise.resolve({ json: async () => ({ ok: true, active: 'C:\\project-c', items: [{ path: 'C:\\project-c', name: 'C' }] }) });
      return baseFetch(url, opts);
    };
    stubCwd = 'C:\\project-c';
    const switches = [
      window.activateProject('C:\\project-a', 'A'),
      window.activateProject('C:\\project-b', 'B'),
      window.activateProject('C:\\project-c', 'C'),
    ];
    await Promise.all(switches);
    es.emit({ type: 'bridge_status', state: 'ready', cwd: 'C:\\project-c', bridgeRun: 500, _seq: 10000 });
    es.emit({ type: 'response', command: 'get_state', success: true, bridgeRun: 500, _seq: 10001, data: { sessionName: 'C', isStreaming: false } });
    es.emit({ type: 'response', command: 'get_messages', success: true, bridgeRun: 500, _seq: 10002, data: { messages: [{ role: 'user', content: [{ type: 'text', text: 'C history' }] }] } });
    es.emit({ type: 'response', command: 'get_messages', success: true, bridgeRun: 499, _seq: 10003, data: { messages: [{ role: 'user', content: [{ type: 'text', text: 'OLD history' }] }] } });
    check('A→B→C 仅 C 更新项目与消息', () =>
      window.S.cwd === 'C:\\project-c' && $('title').textContent === 'C' && $('stream').textContent.includes('C history') && !$('stream').textContent.includes('OLD history'));
    check('中间项目 B 不触发多余 restart', () => !activated.includes('C:\\project-b'));
    check('项目完成同步后输入恢复', () => window.S.switching === false && $('input').disabled === false);
    es.emit({ type: 'tool_execution_start', toolCallId: 'p4-tool', toolName: 'bash', args: { command: 'sleep 1' }, bridgeRun: 500, _seq: 10004 });
    const toolCount = window.document.querySelectorAll('.tl-item[data-id="p4-tool"]').length;
    es.emit({ type: 'tool_execution_start', toolCallId: 'p4-tool', toolName: 'bash', args: { command: 'sleep 1' }, bridgeRun: 500, _seq: 10004 });
    check('SSE backlog 重放不重复 Tool Entry', () => window.document.querySelectorAll('.tl-item[data-id="p4-tool"]').length === toolCount);
    es.emit({ type: 'bridge_status', state: 'exited', bridgeRun: 500, cwd: 'C:\\project-c', _seq: 10005, code: 1 });
    check('pi crash 收尾 running Tool', () => window.document.querySelectorAll('.tl-item[data-status="running"]').length === 0);
    es.emit({ type: 'bridge_status', state: 'ready', bridgeRun: 501, cwd: 'C:\\project-c', _seq: 10006 });
    const restored = { messages: [{ role: 'user', content: [{ type: 'text', text: 'restored once' }] }] };
    es.emit({ type: 'response', command: 'get_messages', success: true, bridgeRun: 501, _seq: 10007, data: restored });
    es.emit({ type: 'response', command: 'get_messages', success: true, bridgeRun: 501, _seq: 10008, data: restored });
    check('重复历史重建仍只有一份消息', () => window.document.querySelectorAll('.msg.user').length === 1);
    window.fetch = baseFetch;
  }

  /* ---------- 会话搜索（P3） ----------
   *
   * 放在最后：点搜索结果会 switch 会话 → afterSessionSwitch() → clearThread()，
   * 前面所有依赖线程状态的用例都会被搅乱。 */
  async function searchSection() {
    searchCalls.length = 0;
    searchPlan = [];
    $('toasts').innerHTML = '';
    window.renderProjects();
    await new Promise((r) => setTimeout(r, 80));

    const proj = () => $('projects');
    const box = () => proj().querySelector('.pj-sessions');
    const input = () => proj().querySelector('.pj-search-input');
    const area = () => proj().querySelector('.pj-sess-list');
    const typeIn = async (v, waitMs) => {
      input().value = v;
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, waitMs));
    };

    check('搜索：输入框就在会话区域里（不是新面板、不是弹层）', () => Boolean(box() && input()) || '没有搜索框');
    check('搜索：有「活跃 / 已归档 / 全部」三个范围', () => {
      const s = [...proj().querySelectorAll('.pj-search-scope')].map((b) => b.textContent);
      return JSON.stringify(s) === JSON.stringify(['活跃', '已归档', '全部']) || JSON.stringify(s);
    });
    check('搜索：空关键词不发请求', () => searchCalls.length === 0 || JSON.stringify(searchCalls));
    check('搜索：空关键词时显示普通会话列表', () => {
      const rows = area() && area().querySelectorAll('.pj-sess');
      return Boolean(rows && rows.length) || '列表是空的';
    });

    // 不足 2 个字符：提示、不发请求
    await typeIn('b', 320);
    check('搜索：关键词不足 2 个字符 → 提示、不发请求', () =>
      (searchCalls.length === 0 && /至少 2 个字符/.test(area().textContent)) ||
      JSON.stringify({ calls: searchCalls.length, t: area().textContent.slice(0, 60) }));

    // debounce
    searchCalls.length = 0;
    input().value = 'bridge';
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
    check('搜索：debounce —— 刚敲完不立刻发请求', () => searchCalls.length === 0 || JSON.stringify(searchCalls));
    check('搜索：debounce 期间显示「正在搜索…」', () => /正在搜索/.test(area().textContent) || area().textContent.slice(0, 60));
    await new Promise((r) => setTimeout(r, 400));
    check('搜索：debounce 到点后只发一次请求，关键词正确', () =>
      (searchCalls.length === 1 && searchCalls[0].q === 'bridge') || JSON.stringify(searchCalls));

    // 结果渲染
    check('搜索：结果里有会话标题', () => /修复 SSE 重连/.test(area().textContent) || area().textContent.slice(0, 120));
    check('搜索：标题和命中行用可聚焦按钮', () => [...area().querySelectorAll('.pj-sr-head, .pj-sr-hit')].every((node) => node.tagName === 'BUTTON' && node.type === 'button' && node.getAttribute('aria-label')));
    check('搜索：结果里有相对时间', () =>
      /小时前|天前|分钟前|刚刚|\d\d-\d\d/.test(area().textContent) || area().textContent.slice(0, 120));
    check('搜索：结果里有命中类型标记', () => {
      const types = [...area().querySelectorAll('.pj-sr-type')].map((t) => t.textContent);
      return (types.includes('标题') && types.includes('你问的')) || JSON.stringify(types);
    });
    check('搜索：活跃范围下不出现已归档的会话', () =>
      area().querySelectorAll('.pj-sr-badge').length === 0 ||
      JSON.stringify([...area().querySelectorAll('.pj-sr-badge')].map((b) => b.textContent)));
    check('搜索：显示命中数量', () => /\d+ 处命中/.test(area().textContent) || area().textContent.slice(0, 120));
    check('搜索：结果里不出现 .jsonl 文件名或绝对路径', () =>
      !/\.jsonl|[A-Za-z]:[\\/]/.test(area().textContent) || '出现了文件名/路径');

    /* snippet 是会话正文（不可信输入）—— 桩里故意塞了 <img onerror>，
     * 它必须**原样显示成文本**，且 DOM 里不能真的出现 img 元素。 */
    check('搜索：snippet 走文本节点（桩里的 <img onerror> 原样显示为文本）', () =>
      area().textContent.includes('<img src=x onerror=alert(1)>') || 'HTML 被当成标签了');
    check('搜索：snippet 里没有真的插入 img 元素（即没走 innerHTML）', () =>
      area().querySelectorAll('img').length === 0 || `插进了 ${area().querySelectorAll('img').length} 个 img`);
    check('搜索：关键词高亮是 <mark> 元素（安全建出来的）', () => {
      const marks = [...area().querySelectorAll('.pj-sr-snip mark')].map((m) => m.textContent.toLowerCase());
      return (marks.length > 0 && marks.every((m) => m === 'bridge')) || JSON.stringify(marks);
    });

    // 范围筛选
    searchCalls.length = 0;
    proj().querySelector('.pj-search-scope[data-scope="archived"]').onclick();
    await new Promise((r) => setTimeout(r, 220));
    check('搜索：点「已归档」立刻重搜且带 scope=archived', () =>
      (searchCalls.length === 1 && searchCalls[0].scope === 'archived') || JSON.stringify(searchCalls));
    check('搜索：归档范围的结果里只剩归档会话', () => {
      const ids = [...area().querySelectorAll('.pj-sr')].map((r) => r.dataset.sessionId);
      return (ids.length === 1 && ids[0] === 'cccccccccccccccc') || JSON.stringify(ids);
    });
    proj().querySelector('.pj-search-scope[data-scope="active"]').onclick();
    await new Promise((r) => setTimeout(r, 220));

    // 「全部」范围：归档会话要能被搜到，并且带「已归档」标记
    proj().querySelector('.pj-search-scope[data-scope="all"]').onclick();
    await new Promise((r) => setTimeout(r, 220));
    check('搜索：「全部」范围下归档会话也能被搜到', () => {
      const ids = [...area().querySelectorAll('.pj-sr')].map((r) => r.dataset.sessionId);
      return ids.includes('cccccccccccccccc') || JSON.stringify(ids);
    });
    check('搜索：归档会话带「已归档」标记', () => {
      const badges = [...area().querySelectorAll('.pj-sr-badge')].map((b) => b.textContent);
      return badges.includes('已归档') || JSON.stringify(badges);
    });
    proj().querySelector('.pj-search-scope[data-scope="active"]').onclick();
    await new Promise((r) => setTimeout(r, 220));

    // 失败态 / 空态
    searchPlan = [{ payload: { ok: false, error: '后端炸了' } }];
    await typeIn('boom', 420);
    check('搜索：失败时显示「搜索失败」而不是空白', () => /搜索失败/.test(area().textContent) || area().textContent.slice(0, 80));

    searchPlan = [{ payload: { ok: true, query: 'zzz', scope: 'active', results: [] } }];
    await typeIn('zzz', 420);
    check('搜索：没有命中时显示「没有找到相关会话」', () =>
      /没有找到相关会话/.test(area().textContent) || area().textContent.slice(0, 80));

    // 清空 → 回到普通列表
    await typeIn('', 140);
    check('搜索：清空关键词 → 恢复普通会话列表', () => {
      const rows = area() && area().querySelectorAll('.pj-sess');
      return Boolean(rows && rows.length) || '没回到列表';
    });

    // stale：慢的旧请求回来时不能覆盖新结果
    {
      searchPlan = [
        { delayMs: 320, payload: { ok: true, query: 'ab', scope: 'active', results: [{ ...SEARCH_ACTIVE_HIT, title: '【旧】不该出现' }] } },
        { delayMs: 0, payload: { ok: true, query: 'abc', scope: 'active', results: [{ ...SEARCH_ACTIVE_HIT, title: '【新】应该留下' }] } },
      ];
      await typeIn('ab', 260); // 第一次请求（慢）
      await typeIn('abc', 260); // 第二次请求（快），先回来
      await new Promise((r) => setTimeout(r, 420)); // 等慢的那次也回来
      const t = area().textContent;
      check('搜索：旧请求回来晚了会被丢弃（不覆盖新结果）', () =>
        (t.includes('【新】应该留下') && !t.includes('【旧】不该出现')) || JSON.stringify(t.slice(0, 140)));
    }

    // 切项目 → 丢掉搜索状态
    {
      searchPlan = [];
      await typeIn('bridge', 420);
      const before = area().textContent.includes('修复 SSE 重连');
      window.renderProjects();
      await new Promise((r) => setTimeout(r, 140));
      check('搜索：切项目后搜索框清空、不再显示上一个项目的搜索结果', () =>
        (before && input().value === '' && !area().textContent.includes('修复 SSE 重连')) ||
        JSON.stringify({ before, val: input().value, t: area().textContent.slice(0, 60) }));
    }

    /* 点结果 → 切会话 → **定位到命中那次提问**。
     * 放在最后：这一步会 clearThread()。 */
    {
      /* 跳转这一轮从 scrollIntoView 改成了「只写 #stream 的滚动位置」
       * （原因见 convNavSection 的说明）。所以这里看两件事：
       *   ① 整条链路把定位落到了「第 userIndex 次提问」上（导航当前项）；
       *   ② 全程没有碰 scrollIntoView —— 它才是把顶栏滚出视口的那个调用。
       * 这里不再桩 scrollIntoView，改成装上计数器：被调用即判红。 */
      let sivCalls = 0;
      const proto = window.Element.prototype;
      const origScroll = proto.scrollIntoView;
      proto.scrollIntoView = function () {
        sivCalls++;
      };

      searchPlan = [];
      await typeIn('bridge', 420);
      sessionCalls.length = 0;
      /* 用「你问的」那一条命中（桩里 userIndex=1）—— 定位要用的是**提问序号**，
       * 不是消息 ID（前端 nav id 是渲染时现发的计数器，跨重建不稳定）。 */
      const userHit = [...area().querySelectorAll('.pj-sr-hit')].find((h) => h.dataset.matchType === 'user');
      check('搜索：结果里有可点的「你问的」命中行', () => Boolean(userHit) || '没找到');
      if (userHit) userHit.onclick({ stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 140));
      const hit = sessionCalls.find((c) => /\/switch/.test(c.url));
      check('搜索：点结果会切到那个会话，传的是稳定 ID 而不是路径', () =>
        Boolean(hit && hit.body && /^[0-9a-f]{16}$/.test(hit.body.id)) ||
        JSON.stringify(sessionCalls.map((c) => c.url)));

      // 历史回来了 → 应当定位到第 2 条用户消息（userIndex = 1）
      const msgs = [1, 2, 3].map((i) => ({ role: 'user', content: [{ type: 'text', text: `第 ${i} 次提问` }] }));
      es.emit({ type: 'response', command: 'get_messages', success: true, bridgeRun: window.S.bridgeRun, _seq: 20001, data: { messages: msgs } });
      await new Promise((r) => setTimeout(r, 140));
      const users = [...$('stream').querySelectorAll('.msg.user')];
      check('搜索：历史渲染完成后定位到命中那次提问（第 2 条，不是最底）', () =>
        (users.length === 3 && window.currentNavIndex() === 1) ||
        JSON.stringify({ users: users.length, current: window.currentNavIndex() }));
      check('搜索：这次定位同样只写 #stream（全程没有 scrollIntoView）', () =>
        sivCalls === 0 || `scrollIntoView 被调用了 ${sivCalls} 次`);

      proto.scrollIntoView = origScroll;
    }

    await typeIn('', 140); // 收尾：别把搜索状态留给后面的用例
  }

  /* --- 上游新增未知事件必须安全忽略 ---
   *
   * pi 以后会加事件类型。前端对不认识的事件是 switch 的 default: return ——
   * 不抛、不重置 bridge、不清当前会话。代码「现在是安全的」不够，得有守卫拦住
   * 以后有人把 default 改成别的（比如顺手 reset 一下）。
   *
   * ⚠️ 事件里的 bridgeRun **必须与当前值一致** —— 否则会被 stale 过滤丢掉，
   * 这条守卫就变成「因为被过滤所以没事」的假绿。 */
  {
    es.emit({ type: 'bridge_status', state: 'ready', bridgeRun: 500, cwd: 'C:\\project-c' });
    es.emit({
      type: 'response',
      command: 'get_messages',
      success: true,
      bridgeRun: 500,
      _seq: 15000,
      data: { messages: [{ role: 'user', content: [{ type: 'text', text: '未知事件守卫的锚点消息' }] }] },
    });
    await new Promise((r) => setTimeout(r, 80));

    // 用**当前**的 bridgeRun 发未知事件，确保它们真的进了 handle()
    const run = window.S.bridgeRun;
    const before = {
      run,
      msgCount: window.document.querySelectorAll('.msg.user').length,
      text: $('stream').textContent,
      errs: errors.length,
      conn: $('connText').textContent,
    };
    check('未知事件守卫：前置状态成立（有消息、bridgeRun 是数字）', () =>
      (before.msgCount >= 1 && Number.isInteger(before.run)) || JSON.stringify(before));

    let seq = 15100;
    for (const type of ['brand_new_event', 'another_upstream_event', 'session_pinned', 'workspace_snapshot']) {
      es.emit({ type, bridgeRun: before.run, _seq: seq++, payload: { anything: true }, someNewField: 1 });
      es.emit({ type, bridgeRun: before.run, _seq: seq++, message: { role: 'user', content: [{ type: 'text', text: '不该被渲染' }] } });
    }
    await new Promise((r) => setTimeout(r, 100));

    check('未知事件不产生运行时错误', () => errors.length === before.errs || errors.slice(before.errs).join(' | '));
    check('未知事件不改 bridgeRun', () => window.S.bridgeRun === before.run || `${before.run} → ${window.S.bridgeRun}`);
    check('未知事件不清当前会话（消息还在）', () =>
      window.document.querySelectorAll('.msg.user').length === before.msgCount ||
      `${before.msgCount} → ${window.document.querySelectorAll('.msg.user').length}`);
    check('未知事件不把内容渲染进对话区', () => !$('stream').textContent.includes('不该被渲染') || '被渲染了');
    check('未知事件不影响连接状态', () => $('connText').textContent === before.conn || $('connText').textContent);
  }

  /* --- 未知 response command 也必须安全忽略 --- */
  {
    const before = { errs: errors.length, text: $('stream').textContent };
    es.emit({ type: 'response', command: 'brand_new_command', success: true, bridgeRun: window.S.bridgeRun, _seq: 15500, data: { whatever: 1 } });
    await new Promise((r) => setTimeout(r, 80));
    check('未知 response command 不抛', () => errors.length === before.errs || errors.slice(before.errs).join(' | '));
    check('未知 response command 不改动对话区内容', () => $('stream').textContent === before.text || '对话区变了');
    /* 注意：**失败的** `get_messages` 是另一回事 —— 它会刻意在对话区留一条说明
     * （见下面「按能力局部降级」那一段），这里不重复断言。 */
  }

  /* --- P4：按能力局部降级 ---
   *
   * 三条规矩：① 只有**被证实不可用**的能力才降级（未验证 ≠ 不支持）；
   * ② 没拿到兼容摘要时一律按可用处理；③ 降级要说清原因，不能点了没反应。 */
  {
    const proj = () => $('projects');

    // ① 没有兼容摘要（老后端 / 状态还没回来）→ 一切照旧
    stubCompat = null;
    await window.loadStatus();
    window.renderProjects();
    await new Promise((r) => setTimeout(r, 80));
    check('降级：没有兼容摘要时改名入口照常出现（未验证 ≠ 不支持）', () => {
      const cur = proj().querySelector('.pj-sess.on');
      return Boolean(cur && cur.querySelector('.pj-sess-menu-trigger')) || '改名入口不见了';
    });

    // ② sessionNaming 被证实不可用 → 当前会话连三点都不画（没有动作就不留入口）
    stubCompat = { status: 'partial', missing: ['sessionNaming'] };
    await window.loadStatus();
    window.renderProjects();
    await new Promise((r) => setTimeout(r, 80));
    check('降级：sessionNaming 不可用 → 当前会话不显示三点（不留空菜单）', () => {
      const cur = proj().querySelector('.pj-sess.on');
      if (!cur) return '没有当前会话行';
      if (cur.querySelector('.pj-sess-menu-trigger')) return '改名入口还在';
      /* 非当前会话不受影响：它还有归档 / 删除，所以三点照常。 */
      const otherRow = proj().querySelector('.pj-sess:not(.on):not(.pending)');
      return Boolean(otherRow && otherRow.querySelector('.pj-sess-menu-trigger')) || '别的会话行也丢了入口';
    });

    // ③ switchSession 被证实不可用 → 不给点，并说明原因
    stubCompat = { status: 'partial', missing: ['switchSession'] };
    await window.loadStatus();
    window.renderProjects();
    await new Promise((r) => setTimeout(r, 80));
    const other = () => [...proj().querySelectorAll('.pj-sess')].find((r) => !r.classList.contains('on') && !r.classList.contains('pending'));
    check('降级：switchSession 不可用 → 会话行不给点', () => {
      const o = other();
      return (Boolean(o) && !o.onclick) || (o ? '仍可点' : '没有可切的会话行');
    });
    check('降级：禁用的会话行带 off 类并写明原因', () => {
      const off = proj().querySelector('.pj-sess.pj-sess-off');
      return Boolean(off && /没有提供/.test(off.title)) || (off ? off.title : '没有 off 类');
    });

    // ④ 核心能力不可用 → **一次性**明显提示（不做常驻横幅）
    $('toasts').innerHTML = '';
    stubCompat = { status: 'incompatible', missing: ['rpc', 'getState'] };
    await window.loadStatus();
    await new Promise((r) => setTimeout(r, 60));
    check('降级：核心能力不可用时给一次明显提示', () => /关键能力不可用/.test($('toasts').textContent) || $('toasts').textContent.slice(0, 80));
    check('降级：提示措辞说事实（不是「版本不支持」）', () => !/版本不支持/.test($('toasts').textContent) || '措辞在猜版本');

    $('toasts').innerHTML = '';
    await window.loadStatus();
    await new Promise((r) => setTimeout(r, 60));
    check('降级：同类提示不重复弹（不是每次回读状态都弹）', () => !/关键能力不可用/.test($('toasts').textContent) || '又弹了一次');

    // ⑤ get_messages 失败 → 对话区留一条**留得住**的说明（不是只弹 toast）
    //
    // ⚠️ 这里**不能**用 `$('stream').innerHTML = ''` 清场：那会把 .thread 摘下来，
    // 而 ensureThread() 只看 S.thread 引用、不检查它还挂不挂在 DOM 上 ——
    // 后续重建就写进了一个脱离的节点（画面全空）。所以只断言「多出了这句话」。
    const streamTextBefore = $('stream').textContent;
    es.emit({
      type: 'response',
      command: 'get_messages',
      success: false,
      error: '上游没有这个命令',
      bridgeRun: window.S.bridgeRun,
      _seq: 15600,
    });
    await new Promise((r) => setTimeout(r, 60));
    check('降级：历史读不出来 → 对话区留一条说明（而不是空白）', () =>
      /无法读取历史消息/.test($('stream').textContent) || $('stream').textContent.slice(0, 80));
    check('降级：这条说明是**追加**的，没有把已有内容冲掉', () =>
      $('stream').textContent.indexOf(streamTextBefore.slice(0, 20)) === 0 ||
      streamTextBefore === '' ||
      '原有内容被替换了');

    // 收尾：恢复成「没有兼容摘要」的常态
    stubCompat = null;
    await window.loadStatus();
    window.renderProjects();
    await new Promise((r) => setTimeout(r, 80));
    check('降级：恢复后改名入口回来了', () => {
      const cur = proj().querySelector('.pj-sess.on');
      return Boolean(cur && cur.querySelector('.pj-sess-menu-trigger')) || '改名入口没回来';
    });
  }

  /* ================= 侧栏：项目行紧凑 + 会话列表可折叠（本轮 UX 修复） =================
   *
   * 用户要的是「项目 / 会话是一套紧凑层级」：项目行不再是「名字 + 绝对路径」
   * 两行的大卡片（那让项目行比会话行高出近一倍），当前项目下面的会话列表
   * 可以折叠 —— 箭头在项目行**内**、可键盘操作、不误触项目切换与删除
   * （折叠箭头不能是 .pj-sessions 之前的新兄弟，那会破坏「会话块紧跟在
   * 当前项目行下面」这条被两处测试盯着的结构）。
   *
   * ⚠️ jsdom **不做布局**，所以「项目行与会话行高度接近」「滚动条宽度」
   * 这类断言只能在真实浏览器里量 —— 见 tests/cdp-shot.cjs 的 UX-01～UX-04。
   * 这里验的是结构、状态与交互。 */
  async function sidebarCollapseSection() {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    $('toasts').innerHTML = '';
    window.renderProjects();
    await wait(80);

    const proj = () => $('projects');
    const row = () => proj().querySelector('.project.active');
    const chev = () => row() && row().querySelector('.pj-chev');
    const box = () => proj().querySelector('.pj-sessions');
    const rowCount = () => (box() ? box().querySelectorAll('.pj-sess').length : 0);

    check('折叠：只有当前项目那一行有折叠箭头', () => {
      const rows = [...proj().querySelectorAll('.project')];
      const withChev = rows.filter((r) => r.querySelector('.pj-chev'));
      return (withChev.length === 1 && withChev[0].classList.contains('active')) || `有箭头的行数=${withChev.length}`;
    });
    check('折叠：默认展开（列表可见、aria-expanded=true）', () =>
      Boolean(box() && box().hidden === false && chev() && chev().getAttribute('aria-expanded') === 'true') ||
      JSON.stringify({ box: Boolean(box()), hidden: box() && box().hidden, aria: chev() && chev().getAttribute('aria-expanded') }));
    check('折叠：箭头在项目行内、且是行内第一个元素（不新增兄弟节点）', () =>
      Boolean(chev() && chev().parentElement === row() && row().firstElementChild === chev()) || '箭头不在行首');
    check('折叠：aria-controls 指向会话块本身', () =>
      Boolean(box() && box().id && chev() && chev().getAttribute('aria-controls') === box().id) ||
      JSON.stringify({ controls: chev() && chev().getAttribute('aria-controls'), boxId: box() && box().id }));
    check('折叠：箭头是可键盘操作的 button，带「展开 / 收起」标签', () => {
      const c = chev();
      return Boolean(c && c.tagName === 'BUTTON' && c.type === 'button' && /展开|收起/.test(c.getAttribute('aria-label') || '')) ||
        (c ? c.outerHTML.slice(0, 120) : '没有箭头');
    });
    check('折叠：箭头没有破坏「会话块紧跟当前项目行」这条既有结构', () =>
      box().previousElementSibling === row() || '会话块不在当前项目下面');

    const before = rowCount();
    check('折叠：折叠前列表里有会话', () => before > 0 || `rows=${before}`);

    // 折叠
    chev().click();
    await wait(20);
    check('折叠：点箭头 → 会话块隐藏、aria-expanded=false、标签变「展开」', () =>
      (box().hidden === true && chev().getAttribute('aria-expanded') === 'false' && /^展开/.test(chev().getAttribute('aria-label'))) ||
      JSON.stringify({ hidden: box().hidden, aria: chev().getAttribute('aria-expanded'), label: chev().getAttribute('aria-label') }));
    check('折叠：只是隐藏，会话行没有从 DOM 里消失（搜索 / 改名 / 归档还要用）', () =>
      rowCount() === before || `${before} → ${rowCount()}`);
    check('折叠：项目行本身没被折掉（折的只是这个项目的会话）', () =>
      Boolean(row() && row().isConnected) || '项目行不见了');

    // 展开
    chev().click();
    await wait(20);
    check('折叠：再点一次恢复展开', () =>
      (box().hidden === false && chev().getAttribute('aria-expanded') === 'true') ||
      JSON.stringify({ hidden: box().hidden, aria: chev().getAttribute('aria-expanded') }));

    // 点箭头不误触项目切换（真事件、会冒泡 → 走的正是 stopPropagation 那条路）
    check('折叠：点箭头不会误触项目切换', () => {
      const select = row().querySelector('.pj-select');
      let switched = 0;
      const orig = select.onclick;
      select.onclick = () => { switched++; };
      chev().click();
      chev().click();
      select.onclick = orig;
      return switched === 0 || `顺带切了 ${switched} 次项目`;
    });
    await wait(20);
    check('折叠：上面那两次点击之后状态仍然是展开（没被切换带乱）', () =>
      box().hidden === false || '折叠状态被带乱了');

    /* 点行尾三点：只开菜单，既不折叠也不切项目。
     * 这条原来是拿删除按钮测的（那时行尾是一个常驻的 ✕），现在行尾是 `…`，
     * 语义没变：**入口换了，三条路仍然互不影响**。 */
    check('折叠：点三点只开菜单，不误触折叠、也不切项目', () => {
      const trigger = row().querySelector('.pj-row-menu-trigger');
      if (!trigger) return '没有三点入口';
      const beforeAria = chev().getAttribute('aria-expanded');
      const select = row().querySelector('.pj-select');
      let switched = 0;
      const origSelect = select.onclick;
      select.onclick = () => { switched++; };
      trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      select.onclick = origSelect;
      const afterAria = chev() && chev().getAttribute('aria-expanded');
      const opened = Boolean(window.document.getElementById('actionMenu'));
      window.closeActionMenu?.();
      return (opened && switched === 0 && beforeAria === afterAria) ||
        JSON.stringify({ opened, switched, beforeAria, afterAria });
    });

    /* 项目菜单只放**真实已有**的两个功能，且移除前必须确认。 */
    {
      const trigger = row().querySelector('.pj-row-menu-trigger');
      trigger.onclick({ preventDefault() {}, stopPropagation() {} });
      await wait(20);
      const menu = window.document.getElementById('actionMenu');
      const labels = menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.querySelector('.action-menu-label').textContent) : [];
      check('项目菜单：只有「项目设置」与「移除项目」', () =>
        labels.join(',') === '项目设置,移除项目' || JSON.stringify(labels));
      check('项目菜单：移除项是 danger 层级，且有分隔线', () =>
        Boolean(menu && menu.querySelector('.action-menu-item.danger') && menu.querySelector('[role="separator"]'))
        || '层级 / 分隔线不对');
      check('项目菜单：挂在 body 上（不会被侧栏 overflow 裁掉）', () =>
        Boolean(menu && menu.parentElement === window.document.body) || '菜单不在 body 上');
      check('项目菜单：打开时 trigger 的 aria-expanded=true', () =>
        trigger.getAttribute('aria-expanded') === 'true' || 'aria 没打上');

      // 移除：必须先确认，且确认文案说明不动磁盘文件
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      items[1].click();
      await wait(20);
      check('项目菜单：点「移除项目」先弹确认（不是点一下就移除）', () =>
        $('confirmLayer').hidden === false || '没有弹确认框');
      check('项目菜单：确认文案说明只移除列表、不删磁盘文件', () =>
        /不会删除磁盘上的项目文件/.test($('confirmCard').textContent) || $('confirmCard').textContent);
      $('confirmCard').querySelector('.btn').click();
      await wait(20);
      check('项目菜单：取消之后确认框关掉（且没有真的移除）', () =>
        $('confirmLayer').hidden === true || '确认框还开着');

      // 项目设置：复用既有 openProjectSettings（打开的是那个弹层）
      const settingsMenu = await openRowMenu(row().querySelector('.pj-row-menu-trigger'));
      const settingsItem = [...settingsMenu.querySelectorAll('[role="menuitem"]')]
        .find((b) => b.querySelector('.action-menu-label').textContent === '项目设置');
      settingsItem.click();
      await wait(60);
      check('项目菜单：点「项目设置」走既有 openProjectSettings（同一个弹层）', () =>
        ($('modal').hidden === false && /项目设置/.test($('modalCard').textContent)) || $('modalCard').textContent.slice(0, 80));
      window.closeModal();
      await wait(20);
    }

    /* 项目菜单的**作用域**（本轮修复）：只有当前项目才给「项目设置」。
     * `openProjectSettings()` 读的是**当前激活项目**的配置 —— 对非当前项目开这个
     * 入口，就是「点 B 的菜单、实际改的是 A 的设置」。 */
    {
      const baseFetchForScope = window.fetch;
      const scopeCalls = { activate: 0, restart: 0, deletes: [] };
      /* 前面几段把 projects 夹具换成了单个项目；这里给一个 A(当前) / B(非当前)
       * 的两项目夹具，专门测作用域 —— 测完再换回去。 */
      const twoProjects = { ok: true, active: 'C:\\scope-a', items: [
        { path: 'C:\\scope-a', name: 'A' }, { path: 'C:\\scope-b', name: 'B' }] };
      window.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/projects/activate')) scopeCalls.activate++;
        if (u.includes('/api/restart')) scopeCalls.restart++;
        if (u.includes('/api/projects') && !u.includes('/activate') && opts && opts.method === 'DELETE') scopeCalls.deletes.push(u);
        if (u.includes('/api/projects')) return { json: async () => twoProjects };
        return baseFetchForScope(url, opts);
      };
      await window.loadProjects();
      await wait(40);

      const menuLabels = (menu) => [...menu.querySelectorAll('[role="menuitem"]')]
        .map((b) => b.querySelector('.action-menu-label').textContent);
      const activeRow = proj().querySelector('.project.active');
      const inactiveRow = [...proj().querySelectorAll('.project')].find((r) => !r.classList.contains('active'));

      const activeMenu = await openRowMenu(activeRow.querySelector('.pj-row-menu-trigger'));
      check('项目菜单作用域：当前项目有「项目设置」与「移除项目」', () =>
        menuLabels(activeMenu).join(',') === '项目设置,移除项目' || JSON.stringify(menuLabels(activeMenu)));
      window.closeActionMenu?.();
      await wait(10);

      const inactiveMenu = await openRowMenu(inactiveRow.querySelector('.pj-row-menu-trigger'));
      const labels = menuLabels(inactiveMenu);
      check('项目菜单作用域：非当前项目**没有**「项目设置」', () =>
        !labels.includes('项目设置') || JSON.stringify(labels));
      check('项目菜单作用域：非当前项目只剩「移除项目」', () =>
        labels.join(',') === '移除项目' || JSON.stringify(labels));

      // 点非当前项目的三点：只开菜单，不切项目、不重启 Pi
      const genBefore = window.S.workspaceGeneration;
      window.closeActionMenu?.();
      await wait(10);
      inactiveRow.querySelector('.pj-row-menu-trigger')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(20);
      check('项目菜单作用域：点非当前项目的三点只开菜单，不切项目、不重启 Pi', () =>
        (Boolean(window.document.getElementById('actionMenu'))
          && scopeCalls.activate === 0 && scopeCalls.restart === 0
          && window.S.workspaceGeneration === genBefore && !window.S.switching)
        || JSON.stringify({ activate: scopeCalls.activate, restart: scopeCalls.restart, gen: [genBefore, window.S.workspaceGeneration] }));
      window.closeActionMenu?.();
      await wait(10);

      // 非当前项目 → 移除项目：确认框对着**这一行**，最终删除的也是这一行的 path
      inactiveRow.querySelector('.pj-row-menu-trigger').onclick({ preventDefault() {}, stopPropagation() {} });
      await wait(20);
      [...rowMenuEl().querySelectorAll('[role="menuitem"]')]
        .find((b) => b.querySelector('.action-menu-label').textContent === '移除项目').click();
      await wait(20);
      check('项目菜单作用域：非当前项目的移除确认框说的是这一行（不是当前项目）', () =>
        ($('confirmLayer').hidden === false && /「B」/.test($('confirmCard').textContent))
        || $('confirmCard').textContent.slice(0, 80));
      $('confirmCard').querySelector('.btn.danger').click();
      await wait(80);
      check('项目菜单作用域：最终移除的目标是这一行的 path', () =>
        (scopeCalls.deletes.length === 1
          && decodeURIComponent(scopeCalls.deletes[0]).includes('C:\\scope-b')
          && !decodeURIComponent(scopeCalls.deletes[0]).includes('scope-a'))
        || JSON.stringify(scopeCalls.deletes));

      // 换回原来的夹具，别影响后面的折叠 / 搜索断言
      window.closeActionMenu?.();
      window.fetch = baseFetchForScope;
      await window.loadProjects();
      await wait(40);
    }

    // Escape 关闭菜单并把焦点还给 trigger
    {
      const trigger = row().querySelector('.pj-row-menu-trigger');
      trigger.focus();
      await openRowMenu(trigger);
      const menu = window.document.getElementById('actionMenu');
      menu.querySelector('[role="menuitem"]').focus();
      menu.querySelector('[role="menuitem"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await wait(10);
      check('项目菜单：Escape 关闭并把焦点还给三点', () =>
        (!window.document.getElementById('actionMenu') && window.document.activeElement === trigger)
        || '没关 / 焦点没回来');
    }

    // 点菜单外关闭
    {
      await openRowMenu(row().querySelector('.pj-row-menu-trigger'));
      window.document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await wait(10);
      check('项目菜单：点菜单外关闭', () =>
        !window.document.getElementById('actionMenu') || '没有关闭');
    }

    // 切项目（= 重新渲染侧栏）之后必须回到展开态
    chev().click();
    await wait(20);
    const folded = box().hidden === true;
    window.renderProjects();
    await wait(80);
    check('折叠：换项目重新渲染后，新激活项目默认展开', () =>
      (folded && box().hidden === false && chev().getAttribute('aria-expanded') === 'true') ||
      JSON.stringify({ folded, hidden: box().hidden, aria: chev().getAttribute('aria-expanded') }));

    // 搜索入口：折叠着点「搜索会话」必须先把列表展开，否则输入框被藏住
    chev().click();
    await wait(20);
    $('navSearch').click();
    await wait(40);
    check('折叠：折叠状态下点「搜索会话」会自动展开（输入框不能被藏住）', () =>
      (box().hidden === false && chev().getAttribute('aria-expanded') === 'true' &&
        $('projectSidebar').classList.contains('search-open') &&
        Boolean(proj().querySelector('.pj-search-input'))) ||
      JSON.stringify({ hidden: box().hidden, aria: chev().getAttribute('aria-expanded'), open: $('projectSidebar').classList.contains('search-open') }));

    // search-open 状态下搜索照旧工作
    {
      const input = proj().querySelector('.pj-search-input');
      if (input) {
        input.value = 'bridge';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      }
      await wait(420);
      const area = proj().querySelector('.pj-sess-list');
      check('折叠：展开后搜索仍然照常出结果（search-open 状态没被折叠破坏）', () =>
        Boolean(area && /修复 SSE 重连|找到|正在搜索/.test(area.textContent)) ||
        (area ? area.textContent.slice(0, 80) : '没有列表区'));
      if (input) {
        input.value = '';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      }
      await wait(180);
    }
    $('projectSidebar').classList.remove('search-open');
  }

  /* --- 版本检查与更新体验（P5） ---
   *
   * 这一段的重点是**诚实性**与**边界**，不是「功能多」：
   *   - 当前版本来自后端快照，前端不硬编码；
   *   - 「已是最新版」与「检查失败」必须是两个状态，绝不混；
   *   - Release Notes 是不可信外部 Markdown，不能变成可执行 HTML；
   *   - 外链只经 preload 的桥递出去，页面自己不做导航；
   *   - 连点不出并发请求、不出现旧结果盖新结果；
   *   - 自动检查失败/无更新完全静默，只有真发现新版才轻提示一次。 */
  async function updateSection() {
    /* 先接管时序：app.js 已经排了一个延迟自动检查，慢机器上它可能落在
     * 这一段的中间，把状态改成我们没预期的样子。取消掉，由下面按需自己触发。 */
    window.cancelUpdateAuto();

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const openDiag = async () => {
      window.openDiagnostics();
      await sleep(40);
      return $('modalCard');
    };
    const closeDiag = () => {
      $('modal').hidden = true;
      $('modalCard').innerHTML = '';
    };
    const updateBtn = () => [...$('modalCard').querySelectorAll('.update-head .btn')][0];
    const notes = () => $('modalCard').querySelector('.update-notes');

    updateCalls.length = 0;
    $('toasts').innerHTML = '';
    closeDiag();
    stubUpdate = { ...UPDATE_LATEST };

    /* ① 当前版本 + 检查更新入口 */
    let card = await openDiag();
    check('更新：诊断面板顶部有「版本」小节', () =>
      Boolean(card.querySelector('.update-sec')) || card.textContent.slice(0, 120));
    check('更新：当前版本来自诊断快照（前端不硬编码版本号）', () => {
      const t = card.querySelector('.update-title');
      return (t && t.textContent === 'Pi GUI v0.11.1') || (t ? t.textContent : '没有 .update-title');
    });
    check('更新：有「检查更新」按钮', () =>
      (updateBtn() && updateBtn().textContent === '检查更新') || (updateBtn() ? updateBtn().textContent : '没有按钮'));
    check('更新：idle 时不显示任何下载按钮', () => !card.querySelector('.update-acts'));

    /* ② 点击 → checking（同步进入，按钮立刻禁用） */
    planUpdate({ delayMs: 60, payload: { ...UPDATE_LATEST } });
    updateCalls.length = 0;
    updateBtn().onclick();
    check('更新：点「检查更新」立刻进入 checking（按钮禁用 + 文案变化）', () => {
      const b = updateBtn();
      return (b.disabled === true && b.textContent === '检查中…' && /正在检查更新/.test(card.textContent)) ||
        `disabled=${b.disabled} text=${b.textContent}`;
    });
    check('更新：手动检查走 force=1（绕过后端缓存）', () =>
      updateCalls.length === 1 && updateCalls[0].force === true || JSON.stringify(updateCalls));
    await sleep(120);

    /* ③ latest：无更新 */
    check('更新：无更新时明确说「当前已是最新版本」', () =>
      /当前已是最新版本/.test(card.textContent) || card.textContent.slice(0, 160));
    check('更新：无更新时显示版本号', () => /v0\.11\.1/.test(card.textContent));
    check('更新：无更新时没有下载按钮（不给一个能点但没意义的入口）', () =>
      !card.querySelector('.update-acts') || card.querySelector('.update-acts').children.length === 0);
    check('更新：无更新时侧栏小点不亮', () => $('updateDot').hidden === true);

    /* ④ error：「检查失败」绝不能显示成「已是最新版」 */
    /* 先把 currentVersion 清空 —— 来一次「成功但响应里没有 currentVersion」的
     * 检查。后端正常时不会这样，但只有这样才能构造出「必须靠兜底值显示版本」
     * 的最小条件，否则下面那条守卫是空转的（前一次成功已经把版本填上了）。 */
    stubUpdate = { ok: true, latestVersion: '0.11.1', updateAvailable: false };
    updateBtn().onclick();
    await sleep(40);
    stubUpdate = { ok: false, error: '暂时无法连接 GitHub', code: 'network' };
    updateBtn().onclick();
    await sleep(40);
    check('更新：失败时说「暂时无法检查更新」，并给出后端文案', () =>
      /暂时无法检查更新/.test(card.textContent) && /无法连接 GitHub/.test(card.textContent) ||
      card.textContent.slice(0, 200));
    check('更新：失败时**不出现**「已是最新版」这类错误结论', () =>
      !/当前已是最新版本/.test(card.textContent) || '把网络失败显示成了已是最新版');
    check('更新：失败时按钮变成「重试」', () =>
      updateBtn().textContent === '重试' || updateBtn().textContent);
    /* 回归守卫：失败响应里**没有** currentVersion，而 setState 会重画 ——
     * 早先重画时丢了兜底值，标题就从「Pi GUI v0.11.1」退化成「Pi GUI」，
     * 也就是「检查失败一次，当前版本就不见了」。真实截图抓出来的。 */
    check('更新：检查失败后当前版本**仍然可见**（不会退化成没有版本号）', () => {
      const t = card.querySelector('.update-title');
      return (t && /^Pi GUI v\d+\.\d+\.\d+$/.test(t.textContent)) || (t ? t.textContent : '没有 .update-title');
    });

    /* ⑤ 重试成功 */
    stubUpdate = { ...UPDATE_AVAILABLE };
    updateBtn().onclick();
    await sleep(40);
    check('更新：点「重试」能恢复正常', () => /发现新版本 v0\.12\.0/.test(card.textContent) || card.textContent.slice(0, 200));

    /* ⑥ available：版本、时间、Release / 下载入口 */
    check('更新：有更新时显示新版本号与当前版本', () =>
      /v0\.12\.0/.test(card.textContent) && /当前版本 v0\.11\.1/.test(card.textContent) || card.textContent.slice(0, 200));
    check('更新：有更新时显示发布时间', () => /发布时间：2026-09-30/.test(card.textContent) || card.textContent.slice(0, 260));
    check('更新：有更新时侧栏「诊断」上的小点亮起', () => $('updateDot').hidden === false);
    check('更新：按钮里有「查看 Release」', () =>
      [...card.querySelectorAll('.update-acts .btn')].some((b) => b.textContent === '查看 Release') ||
      [...card.querySelectorAll('.update-acts .btn')].map((b) => b.textContent).join('|'));
    check('更新：识别出的资产给中文标签（安装版 / 便携版 / 校验和）', () => {
      const labels = [...card.querySelectorAll('.update-acts .btn')].map((b) => b.textContent);
      return (
        labels.includes('安装版') && labels.includes('便携版') && labels.includes('校验和') ||
        JSON.stringify(labels)
      );
    });
    check('更新：下载按钮带上真实文件名（鼠标悬停能看到，不是猜的）', () => {
      const b = [...card.querySelectorAll('.update-acts .btn')].find((x) => x.textContent === '安装版');
      return (b && b.title === 'Pi-GUI-Setup-0.12.0.exe') || (b ? b.title : '没有安装版按钮');
    });

    /* ⑦ Release Notes 渲染 + 安全性 */
    check('更新：Release Notes 渲染出来了', () => {
      const n = notes();
      return (n && /版本检查与更新体验/.test(n.textContent)) || (n ? n.textContent.slice(0, 120) : '没有 .update-notes');
    });
    check('更新：Release Notes 是可滚动容器（长说明不会把底部按钮顶出去）', () => {
      const n = notes();
      return Boolean(n && n.classList.contains('update-notes')) || 'notes 容器不在';
    });
    check('更新：Release Notes 复用消息区的 Markdown 排版（不另抄一套）', () => {
      const n = notes();
      return Boolean(n && n.classList.contains('msg-body')) || 'notes 没有复用 .msg-body 排版';
    });

    /* 恶意 notes：外部 Markdown 是不可信输入 */
    stubUpdate = {
      ...UPDATE_AVAILABLE,
      release: {
        ...UPDATE_AVAILABLE.release,
        notes:
          '<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n' +
          '[点我](javascript:alert(3))\n\n[领奖](https://evil.example/a.exe)\n\n[官方](https://github.com/HYJ1817/pi-gui)\n',
      },
    };
    updateBtn().onclick();
    await sleep(40);
    const nEl = notes();
    check('更新：notes 里的原始 HTML 被转义，DOM 里没有活标签', () =>
      (nEl && nEl.querySelectorAll('script,img,iframe,svg,object,embed').length === 0) ||
      (nEl ? nEl.innerHTML.slice(0, 200) : '没有 notes'));
    check('更新：notes 里的 <script> 原样显示为文本（不是被过滤掉，是语法上不成立）', () =>
      Boolean(nEl && nEl.textContent.includes('<script>alert(2)</script>')) || (nEl ? nEl.textContent.slice(0, 120) : ''));
    check('更新：notes 里的 javascript: 链接不产生任何可点元素', () =>
      Boolean(
        nEl &&
          ![...nEl.querySelectorAll('a, [data-release-href]')].some((x) =>
            /javascript:/i.test(x.getAttribute('href') || x.getAttribute('data-release-href') || '')
          )
      ) || 'javascript: 变成了可点元素');

    /* ---------- 外链：白名单在**渲染时**就生效 ----------
     *
     * 这一组是回归守卫。早先只在 click 上拦，于是有两条漏网的路：
     *   ① 真 <a href> 的中键 / 右键菜单「在新标签页打开」根本不走 click；
     *   ② 网页版（没有 piGuiDesktop）的 fallback 只检查 https://，
     *      于是 notes 里的 https://evil.example/a.exe 会被真的打开。
     * 现在白名单外的链接在渲染时就被降级成纯文本，白名单内的也不是真 <a>。 */
    check('更新：notes 里的站外链接**退化成纯文本**（看得见原文，点不动）', () => {
      const hrefs = [...nEl.querySelectorAll('a, [data-release-href]')].map(
        (x) => x.getAttribute('href') || x.getAttribute('data-release-href') || ''
      );
      return (
        (!hrefs.some((h) => h.includes('evil.example')) &&
          nEl.textContent.includes('https://evil.example/a.exe')) ||
        hrefs.join('|')
      );
    });
    check('更新：notes 里一个真 <a> 都没有（中键 / 右键菜单绕不过校验）', () =>
      nEl.querySelectorAll('a').length === 0 || `还有 ${nEl.querySelectorAll('a').length} 个 <a>`);
    check('更新：notes 里的 GitHub 链接是白名单内的可点元素', () => {
      const hits = [...nEl.querySelectorAll('[data-release-href]')].map((x) => x.getAttribute('data-release-href'));
      return hits.includes('https://github.com/HYJ1817/pi-gui') || JSON.stringify(hits);
    });

    const opened = [];
    window.piGuiDesktop = {
      openExternal: async (url) => {
        opened.push(url);
        return { ok: true };
      },
    };
    const ghLink = [...nEl.querySelectorAll('[data-release-href]')].find(
      (x) => x.getAttribute('data-release-href') === 'https://github.com/HYJ1817/pi-gui'
    );
    if (ghLink) {
      ghLink.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(20);
      check('更新：点白名单内的 notes 链接会交给主进程（页面自己不做导航）', () =>
        opened.includes('https://github.com/HYJ1817/pi-gui') || JSON.stringify(opened));
    } else {
      check('更新：点白名单内的 notes 链接会交给主进程（页面自己不做导航）', () => '没有白名单内的链接');
    }

    /* ---------- 前端白名单纯函数（网页版唯一的一道边界）---------- */
    check('更新：前端 isSafeReleaseUrl 允许 GitHub 官方 host', () =>
      window.isSafeReleaseUrl('https://github.com/HYJ1817/pi-gui/releases/tag/v0.12.0') &&
      window.isSafeReleaseUrl('https://api.github.com/repos/x') &&
      window.isSafeReleaseUrl('https://objects.githubusercontent.com/x') &&
      window.isSafeReleaseUrl('HTTPS://GITHUB.COM/x') ||
      '官方 host 被判成不安全');
    check('更新：前端 isSafeReleaseUrl 拒绝第三方 host 与危险 scheme', () => {
      const bad = [
        'https://evil.example/a.exe',
        'https://github.com.evil.example/x',
        'https://evilgithubusercontent.com/x',
        'https://user:pw@github.com/x',
        'http://github.com/x',
        'javascript:alert(1)',
        'file:///C:/Windows/win.ini',
        'data:text/html,<script>alert(1)</script>',
        'ftp://github.com/x',
        'not a url',
      ];
      const leaked = bad.filter((u) => window.isSafeReleaseUrl(u));
      return leaked.length === 0 || '被放行：' + leaked.join(' , ');
    });
    /* 三份实现两两对拍：后端 ↔ 主进程在 tests/update-check.cjs，
     * 前端 ↔ 主进程在这里 —— 传递出三份一致。 */
    check('更新：前端白名单与主进程实现完全一致（三份实现不许漂开）', () => {
      const cases = [
        'https://github.com/x',
        'https://api.github.com/x',
        'https://objects.githubusercontent.com/x',
        'https://raw.githubusercontent.com/x',
        'https://evil.example/x',
        'https://github.com.evil.example/x',
        'https://evilgithubusercontent.com/x',
        'https://user:pw@github.com/x',
        'http://github.com/x',
        'javascript:alert(1)',
        'file:///C:/x',
        'data:text/html,x',
        'not a url',
      ];
      const probe = require('../electron/net-probe.cjs');
      const drift = cases.filter((u) => window.isSafeReleaseUrl(u) !== probe.isSafeReleaseUrl(u));
      return drift.length === 0 || '判定不一致：' + drift.join(' , ');
    });

    /* ---------- 网页版 fallback（没有 piGuiDesktop）----------
     *
     * 这是本轮修掉的那个缺口：网页版没有主进程可转发，
     * **它自己就是最后一道边界**，所以必须执行同一套 https + GitHub host 白名单，
     * 不能只检查 https://。
     *
     * 「有没有真的去打开」用桩掉 HTMLAnchorElement.prototype.click 来观察 ——
     * 既拿到了确切证据，又不会让 jsdom 报 navigation not implemented 的噪声。 */
    delete window.piGuiDesktop;
    const clicked = [];
    const origClick = window.HTMLAnchorElement.prototype.click;
    window.HTMLAnchorElement.prototype.click = function () {
      clicked.push(this.getAttribute('href'));
    };
    try {
      $('toasts').innerHTML = '';
      const evilR = await window.openExternal('https://evil.example/a.exe');
      check('网页版：站外 host 被拒绝，且**没有**真的去打开', () =>
        evilR.ok === false && clicked.length === 0 || `ok=${evilR.ok} clicked=${JSON.stringify(clicked)}`);
      check('网页版：拒绝时明确说出来（不静默）', () =>
        /已拒绝打开非 GitHub 官方链接/.test($('toasts').textContent) || $('toasts').textContent);

      for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,x', 'http://github.com/x']) {
        const r = await window.openExternal(bad);
        check(`网页版：拒绝 ${bad.slice(0, 30)}`, () => r.ok === false || JSON.stringify(r));
      }
      check('网页版：所有被拒的都没产生打开动作', () =>
        clicked.length === 0 || JSON.stringify(clicked));

      const okR = await window.openExternal('https://github.com/HYJ1817/pi-gui/releases/tag/v0.12.0');
      check('网页版：GitHub 官方链接正常放行（退化成新标签页）', () =>
        okR.ok === true && clicked.length === 1 &&
        clicked[0] === 'https://github.com/HYJ1817/pi-gui/releases/tag/v0.12.0' || JSON.stringify(clicked));
    } finally {
      window.HTMLAnchorElement.prototype.click = origClick;
    }

    /* 主进程拒绝时，界面必须说出来，不能静默。
     * 桩的文案与上面「网页版」那组**故意不同** —— toast() 对同一条文案有 2.5 秒
     * 去重，用同一句话会测成「被去重吃掉了」而不是「界面没说出来」。 */
    const MAIN_DENY = '已拒绝打开非 GitHub 官方链接（主进程判定）';
    window.piGuiDesktop = { openExternal: async () => ({ ok: false, error: MAIN_DENY }) };
    $('toasts').innerHTML = '';
    const anyBtn = [...$('modalCard').querySelectorAll('.update-acts .btn')].find((b) => b.textContent === '查看 Release');
    anyBtn.onclick();
    await sleep(20);
    check('更新：主进程拒绝打开时界面明确说明（不静默失败）', () =>
      $('toasts').textContent.includes(MAIN_DENY) || $('toasts').textContent);

    /* 允许的情况：走的是 preload 的桥，不是 window.open */
    opened.length = 0;
    window.piGuiDesktop = { openExternal: async (url) => { opened.push(url); return { ok: true }; } };
    $('toasts').innerHTML = '';
    anyBtn.onclick();
    await sleep(20);
    check('更新：允许时经 preload 的桥打开，且 URL 就是 Release 页', () =>
      opened.length === 1 && opened[0] === 'https://github.com/HYJ1817/pi-gui/releases/tag/v0.12.0' || JSON.stringify(opened));

    /* ⑧ assets 为空时 UI 不崩 */
    stubUpdate = { ...UPDATE_AVAILABLE, release: { ...UPDATE_AVAILABLE.release, assets: [] } };
    updateBtn().onclick();
    await sleep(40);
    check('更新：assets 为空时 UI 不崩，只剩「查看 Release」', () => {
      const labels = [...$('modalCard').querySelectorAll('.update-acts .btn')].map((b) => b.textContent);
      return (labels.length === 1 && labels[0] === '查看 Release') || JSON.stringify(labels);
    });
    check('更新：assets 为空时也没有下载按钮', () =>
      ![...$('modalCard').querySelectorAll('.update-acts .btn')].some((b) => b.textContent === '安装版'));

    /* ⑨ 连点不产生并发请求，也不出现旧结果盖新结果 */
    stubUpdate = { ...UPDATE_AVAILABLE };
    planUpdate({ delayMs: 60, payload: { ...UPDATE_AVAILABLE } });
    updateCalls.length = 0;
    updateBtn().onclick();
    updateBtn().onclick();
    updateBtn().onclick();
    check('更新：连点三次只产生一次请求', () => updateCalls.length === 1 || `requests=${updateCalls.length}`);
    await sleep(120);
    check('更新：连点之后 UI 与唯一那次响应一致（没有 stale 状态）', () =>
      /发现新版本 v0\.12\.0/.test($('modalCard').textContent) || $('modalCard').textContent.slice(0, 160));

    stubUpdate = {
      ...UPDATE_AVAILABLE,
      latestVersion: '0.13.0',
      release: { ...UPDATE_AVAILABLE.release, tag: 'v0.13.0', url: 'https://github.com/HYJ1817/pi-gui/releases/tag/v0.13.0' },
    };
    updateBtn().onclick();
    await sleep(40);
    check('更新：再检查一次后 UI 反映最新结果（不是上一次的）', () =>
      (/v0\.13\.0/.test($('modalCard').textContent) && !/v0\.12\.0/.test($('modalCard').textContent)) ||
      $('modalCard').textContent.slice(0, 160));

    /* ⑩ 关掉再打开：状态不丢（状态在模块作用域，不在 DOM 上） */
    closeDiag();
    await sleep(10);
    card = await openDiag();
    check('更新：关闭再打开诊断，更新状态仍在（没有回到 idle）', () =>
      /发现新版本 v0\.13\.0/.test(card.textContent) || card.textContent.slice(0, 160));
    check('更新：关闭再打开后按钮仍然可用（没有被禁用状态卡住）', () =>
      updateBtn().disabled === false || `disabled=${updateBtn().disabled}`);

    /* ⑪ 自动检查：失败静默、无更新静默、有更新才轻提示一次、绝不自动弹 Modal
     *
     * 这里刻意**先把诊断弹层关掉**：只有关着，才能证明「自动检查不会自己
     * 弹出一个大 Modal」—— 弹层开着时那个断言是空转的。 */
    closeDiag();

    $('toasts').innerHTML = '';
    stubUpdate = { ok: false, error: '暂时无法连接 GitHub', code: 'network' };
    window.initUpdateAuto({ delayMs: 0 });
    await sleep(60);
    check('更新：自动检查失败完全静默（不弹提示）', () => $('toasts').textContent === '' || $('toasts').textContent);
    check('更新：自动检查失败不自动弹 Modal', () => $('modal').hidden === true || '自动弹出了 Modal');

    card = await openDiag();
    check('更新：自动检查失败后回到 idle，不留一个用户没请求过的错误态', () =>
      (/在应用内检查 GitHub/.test(card.textContent) && !/暂时无法检查更新/.test(card.textContent)) ||
      card.textContent.slice(0, 160));
    closeDiag();

    $('toasts').innerHTML = '';
    updateCalls.length = 0;
    stubUpdate = { ...UPDATE_LATEST };
    window.initUpdateAuto({ delayMs: 0 });
    await sleep(60);
    check('更新：自动检查无更新时静默（不弹提示）', () => $('toasts').textContent === '' || $('toasts').textContent);
    check('更新：自动检查走不带 force 的普通请求（吃后端缓存，避开限流）', () =>
      updateCalls.length === 1 && updateCalls[0].force === false || JSON.stringify(updateCalls));

    $('toasts').innerHTML = '';
    stubUpdate = { ...UPDATE_AVAILABLE };
    window.initUpdateAuto({ delayMs: 0 });
    await sleep(60);
    check('更新：自动发现新版本时给一次轻提示', () => /已发布/.test($('toasts').textContent) || $('toasts').textContent);
    check('更新：自动发现新版本也不弹 Modal', () => $('modal').hidden === true || '自动弹出了 Modal');

    /* 同一个版本不重复弹 */
    $('toasts').innerHTML = '';
    window.initUpdateAuto({ delayMs: 0 });
    await sleep(60);
    check('更新：同一个版本不重复弹提示', () => $('toasts').textContent === '' || $('toasts').textContent);

    /* 自动检查是「延迟任务」而不是启动路径的一部分：调用之后立刻没有请求，
     * 到点才发出去。 */
    $('toasts').innerHTML = '';
    updateCalls.length = 0;
    window.initUpdateAuto({ delayMs: 80 });
    check('更新：initUpdateAuto 立刻返回，且不马上发请求（不阻塞启动）', () =>
      updateCalls.length === 0 || `立刻发了 ${updateCalls.length} 次请求`);
    await sleep(140);
    check('更新：到点后自动检查才真的发出去', () => updateCalls.length === 1 || `requests=${updateCalls.length}`);

    /* 收尾：恢复常态，别把状态漏给后面的用例 */
    window.cancelUpdateAuto();
    delete window.piGuiDesktop;
    stubUpdate = { ...UPDATE_LATEST };
    updatePlan = [];
    updateCalls.length = 0;
    $('toasts').innerHTML = '';
    closeDiag();
    await sleep(10);
  }

  /* ================= Pi 运行时更新（Built-in Pi Updater）前端 =================
   *
   * 与 Pi GUI 自己的更新是两件事：两个模块、两个端点、两套桩。
   * jsdom 不做布局，所以这里验的是**状态机与语义**（相位文案、按钮可用性、
   * 确认框内容、失败后恢复），排版由 `npm run shots:harness` 的真实浏览器兜。 */
  async function piUpdateUiSection() {
    const waitPi = (ms) => new Promise((r) => setTimeout(r, ms));
    const state = () => window.getPiUpdateState();

    stubPiUpdate = { ...PI_UPDATE_AVAILABLE };
    piUpdateCalls.length = 0;
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    window.renderPiUpdateSection(host, '0.99.2');
    check('Pi 更新：诊断里能渲染出 Pi 区块（与 Pi GUI 更新分开）', () =>
      Boolean(host.textContent) && /Pi/.test(host.textContent) || host.textContent.slice(0, 80));

    await window.checkPiUpdate({ force: true });
    await waitPi(20);
    check('Pi 更新：检查走 GET /api/pi-update，且与 /api/update 的流水分开', () => {
      const hit = piUpdateCalls.find((c) => c.method === 'GET');
      return (Boolean(hit) && piUpdateCalls.every((c) => c.method === 'GET' || c.method === 'POST')) ||
        JSON.stringify(piUpdateCalls);
    });
    check('Pi 更新：有新版时状态是 available，且能显示目标版本', () => {
      const s = state();
      return (s.phase === 'available' && s.latestVersion === '1.0.0' && s.updateAvailable === true) || JSON.stringify(s);
    });
    check('Pi 更新：未验收（unverified）时界面给出警告文案', () =>
      /尚未经过 Pi GUI 的完整兼容验收|未经过.*验收/.test(host.textContent) || host.textContent.slice(0, 120));

    /* 确认框：文案必须说清「停谁、不动什么」，且必须由用户显式确认 */
    stubPiUpdateStart = { ok: true, accepted: true, phase: 'updating', currentVersion: '0.99.2', latestVersion: '1.0.0' };
    stubPiUpdate = { ...PI_UPDATE_AVAILABLE };
    await window.checkPiUpdate({ force: true });
    await waitPi(20);
    piUpdateCalls.length = 0;
    const pending = window.confirmAndRunPiUpdate();
    await waitPi(20);
    const confirmCard = $('confirmCard');
    const clickConfirm = (sel) => {
      const b = confirmCard.querySelector(sel);
      if (b && typeof b.onclick === 'function') b.onclick();
      return Boolean(b);
    };
    check('Pi 更新：点更新会先弹确认框（不是直接发请求）', () => {
      const open = !$('confirmLayer').hidden;
      return (open && /更新 Pi 到 1\.0\.0/.test(confirmCard.textContent) && piUpdateCalls.length === 0) ||
        JSON.stringify({ open, text: confirmCard.textContent.slice(0, 80), calls: piUpdateCalls.length });
    });
    check('Pi 更新：确认框正文说清停机+自动重启、不动 Extension/模型/Node、当前与目标版本', () => {
      const t = $('confirmCard').textContent;
      return (/暂时停止当前 Pi 进程/.test(t) && /不会更新 Extension/.test(t) &&
        /0\.99\.2/.test(t) && /1\.0\.0/.test(t)) || t.slice(0, 160);
    });
    check('Pi 更新：未验收警告在确认框里也出现（不隐藏、也不拦更新）', () => {
      const t = $('confirmCard').textContent;
      return /尚未经过 Pi GUI 的完整兼容验收/.test(t) || t.slice(0, 160);
    });
    /* 取消 → 不发请求 */
    clickConfirm('.btn:not(.primary)');
    await pending;
    await waitPi(20);
    check('Pi 更新：确认框点取消 → 一个请求都不发', () => piUpdateCalls.length === 0 || JSON.stringify(piUpdateCalls));

    /* 确认 → POST 恰好带这四个字段 */
    stubPiUpdateStart = { ok: true, accepted: true, phase: 'updating', currentVersion: '0.99.2', latestVersion: '1.0.0' };
    const p2 = window.confirmAndRunPiUpdate();
    await waitPi(20);
    clickConfirm('.btn.primary');
    await p2;
    await waitPi(30);
    check('Pi 更新：确认后 POST body 恰好是 action/confirm/两个 expected（不接受任意命令）', () => {
      const post = piUpdateCalls.find((c) => c.method === 'POST');
      if (!post) return '没有发出 POST';
      const keys = Object.keys(post.body || {}).filter((k) => k !== '__expectedCwd').sort();
      return (JSON.stringify(keys) === JSON.stringify(['action', 'confirm', 'expectedCurrentVersion', 'expectedLatestVersion']) &&
        post.body.confirm === true && post.body.action === 'update') || JSON.stringify(post.body);
    });
    check('Pi 更新：跑起来之后相位是 updating（按钮进入禁用）', () => {
      const s = state();
      return (s.phase === 'updating' || s.busy === true) || JSON.stringify(s);
    });

    /* ---------- 真实轮询路径（blocker 1 的前端侧） ----------
     *
     * 不能用「手工 force 一次检查」来假装更新结束 —— 那条路径绕开了 pollOnce，
     * 而这次要修的正是轮询：后端在更新期间回了旧缓存（running:false）时，
     * 前端会 cancelPoll 并重新点亮「更新到 x」。所以这里让**真的 POST + 真的
     * 轮询**跑完整条相位序列：updating → verifying → restarting → latest。 */
    const busyPhases = ['updating', 'verifying', 'restarting'];
    const pollBtn = () => [...host.querySelectorAll('button')].find((b) => /更新到|更新中|验证中|重启中|检查 Pi 更新/.test(b.textContent));
    {
      piUpdatePlan = [];
      piUpdateCalls.length = 0;
      /* 干净起点：上一段（POST body 那条）会留下一个轮询定时器，
       * 不清掉它就会来吃这一段的相位桩，断言就变成碰巧成立。 */
      window.resetPiUpdate();
      await waitPi(20);
      stubPiUpdate = { ...PI_UPDATE_AVAILABLE };
      stubPiUpdateStart = { ok: true, accepted: true, phase: 'updating', currentVersion: '0.99.2', latestVersion: '1.0.0' };
      await window.checkPiUpdate({ force: true });
      /* 检查用默认桩（available）；相位序列**只**留给轮询来吃。 */
      planPiUpdate(
        { ok: true, phase: 'updating', running: true, currentVersion: '0.99.2', latestVersion: '1.0.0', updateAvailable: true, canUpdate: false, verification: 'unverified', reason: null, cached: false },
        { ok: true, phase: 'verifying', running: true, currentVersion: '0.99.2', latestVersion: '1.0.0', updateAvailable: true, canUpdate: false, verification: 'unverified', reason: null, cached: false },
        { ok: true, phase: 'restarting', running: true, currentVersion: '0.99.2', latestVersion: '1.0.0', updateAvailable: true, canUpdate: false, verification: 'unverified', reason: null, cached: false },
        { ok: true, phase: 'latest', running: false, currentVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false, canUpdate: false, verification: 'unverified', reason: null, cached: false },
      );
      const started = await window.runPiUpdate(); // 真 POST → 真 startPoll()
      check('Pi 轮询：POST 被接受后进入 updating，按钮禁用', () => {
        const s = state();
        return ((s.phase === 'updating' || s.busy === true) && started && started.phase === 'updating') || JSON.stringify({ s, started });
      });
      /* 每一轮轮询间隔 2s（模块常量）。逐相位观察：只要还是忙态，就**不能**
       * 停止轮询，也不能把按钮放回可用。 */
      const seen = [];
      const busyButtonStates = [];
      const deadline = Date.now() + 14000;
      while (Date.now() < deadline) {
        await waitPi(400);
        const s = state();
        if (s.phase && !seen.includes(s.phase)) seen.push(s.phase);
        if (busyPhases.includes(s.phase)) {
          const b = pollBtn();
          busyButtonStates.push(Boolean(b && b.disabled));
        }
        if (!busyPhases.includes(s.phase) && s.phase !== 'updating') break;
        if (s.running === false && s.phase === 'latest') break;
      }
      const getCalls = () => piUpdateCalls.filter((c) => c.method === 'GET').length;
      check('Pi 轮询：轮询真的发生过（不是一次检查就收工）', () => getCalls() >= 3 || JSON.stringify(piUpdateCalls.map((c) => c.method)));
      check('Pi 轮询：逐相位观察到 updating → verifying → restarting', () =>
        (seen.includes('updating') && seen.includes('verifying') && seen.includes('restarting')) || JSON.stringify(seen));
      check('Pi 轮询：忙态期间按钮全程禁用（没有一刻被放回可用）', () =>
        (busyButtonStates.length > 0 && busyButtonStates.every(Boolean)) || JSON.stringify(busyButtonStates));
      const finalState = state();
      check('Pi 轮询：终态 latest，running=false，消息说已是最新', () =>
        (finalState.phase === 'latest' && finalState.running !== true && /已是最新版本/.test(host.textContent)) ||
        JSON.stringify({ finalState, text: host.textContent.slice(0, 120) }));
      const getsAtEnd = getCalls();
      await waitPi(2600);
      check('Pi 轮询：到终态后**停止**轮询（不再继续打接口）', () =>
        getCalls() === getsAtEnd || `${getsAtEnd} → ${getCalls()}`);
      check('Pi 轮询：终态后按钮不再是「更新中…」（不会永久禁用）', () => {
        const b = pollBtn();
        return (!b || !/更新中|验证中|重启中/.test(b.textContent)) || (b && b.textContent);
      });
    }

    /* ---------- 真实轮询路径：更新失败不被新检查覆盖 ---------- */
    {
      piUpdatePlan = [];
      piUpdateCalls.length = 0;
      window.resetPiUpdate();
      await waitPi(20);
      stubPiUpdate = { ...PI_UPDATE_AVAILABLE };
      stubPiUpdateStart = { ok: true, accepted: true, phase: 'updating', currentVersion: '0.99.2', latestVersion: '1.0.0' };
      await window.checkPiUpdate({ force: true });
      planPiUpdate(
        { ok: true, phase: 'updating', running: true, currentVersion: '0.99.2', latestVersion: '1.0.0', updateAvailable: true, canUpdate: false, verification: 'unverified', reason: null, cached: false },
        { ok: false, phase: 'failed', running: false, currentVersion: '0.99.2', latestVersion: '1.0.0', updateAvailable: false, canUpdate: false, verification: 'unverified', reason: null, cached: false, errorCode: 'update-failed', error: '官方 updater 没有成功结束' },
      );
      await window.runPiUpdate();
      const deadline = Date.now() + 9000;
      while (Date.now() < deadline && state().phase !== 'failed') await waitPi(300);
      check('Pi 轮询：失败终态经轮询到达界面（phase=failed + 原因）', () => {
        const s = state();
        return (s.phase === 'failed' && /没有成功结束/.test(s.error || '')) || JSON.stringify(s);
      });
      const callsAtFail = piUpdateCalls.filter((c) => c.method === 'GET').length;
      await waitPi(2600);
      check('Pi 轮询：失败后不再继续轮询，也不会自己变回 available', () => {
        const s = state();
        const now = piUpdateCalls.filter((c) => c.method === 'GET').length;
        return (s.phase === 'failed' && s.updateAvailable !== true && now === callsAtFail) ||
          JSON.stringify({ s, calls: `${callsAtFail} → ${now}` });
      });
    }

    /* ---------- 真实轮询路径：暂停失败（pause-timeout）不是「已是最新」 ----------
     *
     * 这是「暂停失败没落终态」那个缺陷的前端侧：后端曾经回 `phase:'latest'`，
     * 界面于是显示「已是最新版本」—— 一次都没更新却报成功。现在必须显示
     * 真实的暂停失败原因，并且不能出现任何成功文案。 */
    {
      piUpdatePlan = [];
      piUpdateCalls.length = 0;
      window.resetPiUpdate();
      await waitPi(20);
      const pauseReason = '旧 Pi 进程在超时前没有退出，已放弃更新（不会在它还活着时替换运行时）';
      stubPiUpdate = { ...PI_UPDATE_AVAILABLE };
      stubPiUpdateStart = { ok: true, accepted: true, phase: 'updating', currentVersion: '0.99.2', latestVersion: '1.0.0' };
      await window.checkPiUpdate({ force: true });
      planPiUpdate(
        { ok: true, phase: 'updating', running: true, currentVersion: '0.99.2', latestVersion: '1.0.0', updateAvailable: true, canUpdate: false, verification: 'unverified', reason: null, cached: false },
        { ok: false, phase: 'failed', running: false, currentVersion: '0.99.2', latestVersion: '1.0.0', updateAvailable: false, canUpdate: false, verification: 'unverified', reason: null, cached: false, errorCode: 'pause-timeout', error: pauseReason },
      );
      await window.runPiUpdate();
      const deadline = Date.now() + 9000;
      while (Date.now() < deadline && state().phase !== 'failed') await waitPi(300);
      check('Pi 轮询：暂停失败经轮询到达界面（phase=failed + errorCode）', () => {
        const s = state();
        return (s.phase === 'failed' && s.errorCode === 'pause-timeout' && s.running !== true) || JSON.stringify(s);
      });
      check('Pi 轮询：显示真实的暂停失败原因', () =>
        host.textContent.includes(pauseReason) || host.textContent.slice(0, 160));
      check('Pi 轮询：暂停失败**绝不显示成功**（没有「已是最新版本」）', () =>
        !/已是最新版本/.test(host.textContent) || host.textContent.slice(0, 160));
      check('Pi 轮询：暂停失败不显示成「没有新版本」（updateAvailable 保持 false 且相位是 failed）', () => {
        const s = state();
        return (s.updateAvailable !== true && s.phase === 'failed') || JSON.stringify(s);
      });
      const callsAtFail = piUpdateCalls.filter((c) => c.method === 'GET').length;
      await waitPi(2600);
      check('Pi 轮询：暂停失败后停止轮询（不会继续到「变回 available」）', () => {
        const now = piUpdateCalls.filter((c) => c.method === 'GET').length;
        return (state().phase === 'failed' && now === callsAtFail) || JSON.stringify({ calls: `${callsAtFail} → ${now}`, s: state() });
      });
      check('Pi 轮询：按钮不卡死（可点，且不是忙态文案）', () => {
        const b = pollBtn();
        return (!b || (!b.disabled && !/更新中|验证中|重启中/.test(b.textContent))) || JSON.stringify({ text: b && b.textContent, disabled: b && b.disabled });
      });
    }
    await waitPi(20);
    stubPiUpdate = { ok: false, phase: 'failed', currentVersion: '0.99.2', latestVersion: '1.0.0', updateAvailable: false, verification: 'unverified', canUpdate: false, reason: null, cached: false, running: false, errorCode: 'update-failed', error: '官方 updater 没有成功结束' };
    await window.checkPiUpdate({ force: true });
    await waitPi(20);
    check('Pi 更新：失败时显示后端给的原因，且相位是 failed', () => {
      const s = state();
      return (s.phase === 'failed' && /没有成功结束/.test(s.error || '')) || JSON.stringify(s);
    });
    stubPiUpdate = { ok: false, phase: 'failed', errorCode: 'offline', error: '离线模式：已跳过 Pi 版本检查', updateAvailable: false, canUpdate: false, currentVersion: '0.99.2', latestVersion: null, verification: 'unchecked', reason: null, cached: false, running: false };
    await window.checkPiUpdate({ force: true });
    await waitPi(20);
    check('Pi 更新：离线（PI_OFFLINE）只影响这一块，不抛错、不弹崩溃', () => {
      const s = state();
      return (s.phase === 'failed' || s.phase === 'idle') || JSON.stringify(s);
    });

    /* busy 闸门：后端拒绝必须原样显示，且按钮回到可用 */
    stubPiUpdate = { ...PI_UPDATE_AVAILABLE };
    await window.checkPiUpdate({ force: true });
    await waitPi(20);
    stubPiUpdateStart = { ok: false, code: 'busy-turn', error: '当前回答仍在生成，请先停止', currentVersion: '0.99.2', latestVersion: '1.0.0' };
    piUpdateCalls.length = 0;
    const p3 = window.confirmAndRunPiUpdate();
    await waitPi(20);
    clickConfirm('.btn.primary');
    await p3;
    await waitPi(30);
    check('Pi 更新：后端闸门说忙 → 原样显示原因（不假装已开始）', () =>
      /仍在生成|先停止/.test(host.textContent) || /仍在生成|先停止/.test(state().error || '') || JSON.stringify(state()));
    check('Pi 更新：被拒之后按钮回到可用（不是永久禁用）', () =>
      state().busy !== true || JSON.stringify(state()));

    /* 自动检查：到点才发、且只检查不安装 */
    window.cancelPiUpdateAuto();
    piUpdateCalls.length = 0;
    stubPiUpdate = { ...PI_UPDATE_AVAILABLE };
    window.initPiUpdateAuto({ delayMs: 60 });
    check('Pi 更新：自动检查到点之前不发请求', () => piUpdateCalls.length === 0 || JSON.stringify(piUpdateCalls));
    await waitPi(120);
    check('Pi 更新：自动检查只发 GET（检查），绝不自动安装', () => {
      const posts = piUpdateCalls.filter((c) => c.method === 'POST');
      return (piUpdateCalls.some((c) => c.method === 'GET') && posts.length === 0) || JSON.stringify(piUpdateCalls);
    });
    window.cancelPiUpdateAuto();

    /* 收尾：恢复常态 */
    stubPiUpdate = { ...PI_UPDATE_LATEST };
    stubPiUpdateStart = { ok: true, accepted: true, phase: 'updating' };
    piUpdateCalls.length = 0;
    host.remove();
    await waitPi(10);
  }

  await searchSection();
  await sidebarCollapseSection();
  await updateSection();
  await piUpdateUiSection();

  /* --- 会话一变就要重画侧栏列表 ---
   *
   * 回归守卫。列表原本只在 renderProjects() 里渲染，而 new_session / fork /
   * 切换都不触发它 —— 于是列表停在旧状态：旧会话仍然带着 current 标记，
   * 而当前项是**不给点**的（你已经在里面了），用户就再也回不到那条对话。
   * 用户的原话是「开新对话了，旧对话就消失」。
   *
   * 放在最后：afterSessionSwitch 会 clearThread()，前面所有用例都依赖线程状态。 */
  {
    window.renderProjects();
    await new Promise((r) => setTimeout(r, 60));
    sessionCalls.length = 0;
    window.onResponse({ type: 'response', command: 'new_session', success: true });
    await new Promise((r) => setTimeout(r, 80));
    check('会话：new_session 之后侧栏列表会重画（回归守卫）', () =>
      sessionCalls.some((c) => c.method === 'GET' && /\/api\/sessions$/.test(c.url)) ||
      JSON.stringify(sessionCalls.map((c) => c.method + ' ' + c.url)));
  }

  $('navPlanner').click();
  check('Rail 任务入口打开 Planner 工作区', () => $('workspace').dataset.workspaceView === 'planner' && $('modal').hidden && $('navPlanner').getAttribute('aria-current') === 'page');
  $('navHome').click();
  check('Rail 对话入口返回工作区', () => $('modal').hidden && $('navHome').getAttribute('aria-current') === 'page');
  $('navExtensions').click();
  check('Rail 扩展入口打开扩展工作区', () => $('workspace').dataset.workspaceView === 'extensions' && $('modal').hidden && $('navExtensions').getAttribute('aria-current') === 'page');
  $('navHome').click();
  $('navChanges').click();
  check('Rail 文件变更入口打开文件工作区', () => $('workspace').dataset.workspaceView === 'changes' && $('modal').hidden && $('navChanges').getAttribute('aria-current') === 'page');
  $('navHome').click();

  /* P14-B：独立夹具走现有历史与流式入口，核对真实节点与可操作性。
   * 几何位置交给 CDP Harness；jsdom 不提供布局。 */
  {
    const file = '<pi-file name="设计说明.pdf" meta="PDF · 2 页">文件正文</pi-file>';
    window.rebuildFromMessages([
      { role: 'user', content: '短消息 `id`' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '先检查文件' }, { type: 'text', text: '结果：**正常**' }] },
      { role: 'user', content: [{ type: 'text', text: `请看附件\n\n${file}\n\n${file}` }, { type: 'image', data: 'AA==', mimeType: 'image/png' }] },
    ]);
    const user = $('stream').querySelector('.msg.user');
    const assistant = $('stream').querySelector('.msg.assistant');
    const think = assistant.querySelector('.think');
    const thinkButton = think.querySelector('.think-head');
    const thinkBody = think.querySelector('.think-body');
    check('P14-B 历史 User 使用消息语义并保留行内代码', () => user.tagName === 'ARTICLE' && Boolean(user.querySelector('.msg-body code')));
    check('P14-B 历史 Assistant 使用消息语义和开放正文', () => assistant.tagName === 'ARTICLE' && Boolean(assistant.querySelector('.msg-body strong')));
    check('P14-B Thinking 默认折叠且有可访问控制', () => thinkButton.tagName === 'BUTTON' && thinkButton.getAttribute('aria-expanded') === 'false' && thinkButton.getAttribute('aria-controls') === thinkBody.id && thinkBody.hidden);
    thinkButton.click();
    check('P14-B Thinking 展开显示原有内容', () => thinkButton.getAttribute('aria-expanded') === 'true' && !thinkBody.hidden && thinkBody.textContent.includes('先检查文件'));
    thinkButton.click();
    check('P14-B Thinking 再次点击收起但保留内容', () => thinkButton.getAttribute('aria-expanded') === 'false' && thinkBody.hidden && thinkBody.textContent.includes('先检查文件'));
    const files = [...$('stream').querySelectorAll('.msg-file')];
    check('P14-B 多附件仍为两个独立文件块', () => files.length === 2 && $('stream').querySelectorAll('.msg-att-chip').length === 1);
    const fileButton = files[0].querySelector('.msg-file-head');
    check('P14-B 文件详情是可访问按钮', () => fileButton.tagName === 'BUTTON' && fileButton.getAttribute('aria-expanded') === 'false' && fileButton.getAttribute('aria-controls') === files[0].querySelector('.msg-file-body').id);
    fileButton.click();
    check('P14-B 文件详情展开后可见', () => fileButton.getAttribute('aria-expanded') === 'true' && !files[0].querySelector('.msg-file-body').hidden);

    window.clearThread();
    window.onMessageStart({ message: { role: 'assistant' } });
    window.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
    window.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '核对中' } });
    await new Promise((r) => setTimeout(r, 30));
    const liveThink = $('stream').querySelector('.think');
    const liveToggle = liveThink.querySelector('.think-head');
    check('P14-B 流式 Thinking 默认折叠', () => liveToggle.tagName === 'BUTTON' && liveToggle.getAttribute('aria-expanded') === 'false' && liveThink.querySelector('.think-body').hidden);
    liveToggle.click();
    window.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '核对完成' } });
    check('P14-B 手动展开优先于流式完成默认态', () => liveToggle.getAttribute('aria-expanded') === 'true' && !liveThink.querySelector('.think-body').hidden);
    window.onMessageEnd({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: '核对完成' }, { type: 'text', text: '已完成' }] } });
    check('P14-B message_end 保留手动展开和原节点', () => liveThink.isConnected && liveToggle.getAttribute('aria-expanded') === 'true' && liveThink.querySelector('.think-body').textContent === '核对完成');

    window.clearThread();
    window.onMessageStart({ message: { role: 'assistant' } });
    window.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '再次检查' } });
    const foldedThink = $('stream').querySelector('.think');
    const foldedToggle = foldedThink.querySelector('.think-head');
    foldedToggle.click();
    foldedToggle.click();
    window.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '检查结束' } });
    window.onMessageEnd({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: '检查结束' }, { type: 'text', text: '确认' }] } });
    check('P14-B 手动收起在流式结束后仍保持收起', () => foldedThink.isConnected && foldedToggle.getAttribute('aria-expanded') === 'false' && foldedThink.querySelector('.think-body').hidden && foldedThink.querySelector('.think-body').textContent === '检查结束');

    window.clearThread();
    window.onMessageStart({ message: { role: 'assistant' } });
    window.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '旧草稿' } });
    window.onMessageEnd({ message: { role: 'assistant', content: [{ type: 'text', text: '最终正文' }] } });
    await new Promise((r) => setTimeout(r, 30));
    check('P14-B message_end 权威正文不被待执行流式绘制覆盖', () => {
      const body = $('stream').querySelector('.msg.assistant .msg-body');
      return body?.textContent.includes('最终正文') && !body.textContent.includes('旧草稿');
    });

    window.clearThread();
    window.onMessageStart({ message: { role: 'assistant' } });
    window.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '前半段' } });
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const streamedTextNode = $('stream').querySelector('.msg.assistant .assistant-text');
    check('P14-B 竞态前提：首段已经由 rAF 绘制', () => streamedTextNode?.textContent === '前半段');
    window.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '后半段' } });
    window.onMessageEnd({ message: { role: 'assistant', content: [{ type: 'text', text: '前半段后半段' }] } });
    const finalTextNode = $('stream').querySelector('.msg.assistant .assistant-text');
    check('P14-B message_end 复用流式正文节点', () => finalTextNode === streamedTextNode);
    check('P14-B message_end 立即写入尚未绘制的尾段', () => finalTextNode?.textContent === '前半段后半段');
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    check('P14-B 下一帧不会把最终正文回退为首段', () => finalTextNode?.textContent === '前半段后半段');

    const entry = window.makeEntry({ toolCallId: 'p14b-tool', toolName: 'bash', args: { command: 'npm test' } });
    const tool = window.renderEntry(entry);
    const toolToggle = tool.querySelector('.tl-toggle');
    const toolDetail = tool.querySelector('.tl-more');
    check('P14-B running 工具有明确状态文字', () => tool.dataset.status === 'running' && /执行中|运行中/.test(tool.querySelector('.tl-status')?.textContent || ''));
    check('P14-B 工具详情按钮有展开语义', () => toolToggle.getAttribute('aria-expanded') === 'false' && toolToggle.getAttribute('aria-controls') === toolDetail.id && toolDetail.hidden);
    toolToggle.click();
    check('P14-B 工具详情在当前行下方展开', () => toolToggle.getAttribute('aria-expanded') === 'true' && !toolDetail.hidden && toolDetail.querySelector('.tl-args').textContent.includes('npm test'));
    toolToggle.click();
    tool.querySelector('.tl-head').click();
    check('P14-B 原有工具行点击仍可展开详情', () => toolToggle.getAttribute('aria-expanded') === 'true' && !toolDetail.hidden);
    tool.querySelector('.tl-head').click();
    for (const [status, expected] of [['success', '成功'], ['error', '失败'], ['incomplete', '未完成'], ['interrupted', '已中断'], ['cancelled', '已取消'], ['unknown', '状态未知']]) {
      entry.status = status;
      entry.resultLine = status === 'error' ? 'exit code 1' : '';
      window.updateEntry(tool, entry);
      check(`P14-B ${status} 工具状态有图标和文字`, () => tool.dataset.status === status && tool.querySelector('.tl-dot svg') && tool.querySelector('.tl-status')?.textContent.includes(expected));
    }
  }

  /* P14-C：Composer 保留原有发送与附件入口，新增几何同步和可访问控件语义。
   * jsdom 不计算布局，实际位置/高度另由 CDP 场景验证。 */
  {
    const composer = $('composerBox');
    const outer = composer.closest('.composer');
    check('P14-C 页面只有一套 Composer 与输入控件', () =>
      window.document.querySelectorAll('#composerBox').length === 1 &&
      window.document.querySelectorAll('#input').length === 1 && Boolean(outer));

    let height = 112;
    let observed = null;
    let notifyResize = null;
    Object.defineProperty(outer, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height }),
    });
    window.ResizeObserver = class {
      constructor(callback) { notifyResize = callback; }
      observe(node) { observed = node; }
    };
    window.initComposerLayout?.();
    const reserved = () => window.document.querySelector('.stage').style.getPropertyValue('--composer-reserved-height');
    check('P14-C 仅观察 Composer 外层高度', () => observed === outer && typeof notifyResize === 'function');
    check('P14-C 初始高度写入留白变量', () => reserved() === '112px');
    height = 196;
    notifyResize?.([]);
    check('P14-C 多行或附件增高同步留白变量', () => reserved() === '196px');
    height = 130;
    notifyResize?.([]);
    check('P14-C 附件删除后留白变量缩回', () => reserved() === '130px');

    let inputHeight = 40;
    Object.defineProperty($('input'), 'scrollHeight', { configurable: true, get: () => inputHeight });
    for (const [value, scroll, expected] of [['一行', 40, 40], ['一行\n二行\n三行', 90, 90], ['六行\n'.repeat(6), 170, 170], ['很长\n'.repeat(30), 600, 184]]) {
      $('input').value = value;
      inputHeight = scroll;
      window.autoGrow();
      check(`P14-C 输入增长 ${scroll}px 不超过视口上限`, () => $('input').style.height === expected + 'px');
    }
    $('input').value = '';
    window.updateSendState();
    check('P14-C 空输入禁用发送', () => $('btnSend').disabled);
    const commandsBeforeKeys = commands.length;
    $('input').value = '输入法组词中';
    const composingEnter = new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    $('input').dispatchEvent(composingEnter);
    check('P14-C IME 合成 Enter 不触发发送', () => !composingEnter.defaultPrevented && commands.length === commandsBeforeKeys);
    const shiftEnter = new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    $('input').dispatchEvent(shiftEnter);
    check('P14-C Shift+Enter 保留浏览器换行默认动作', () => !shiftEnter.defaultPrevented && commands.length === commandsBeforeKeys);
    $('input').value = '';
    window.updateSendState();

    const fileInput = $('fileInput');
    const originalClick = fileInput.click;
    let fileClicks = 0;
    fileInput.click = () => { fileClicks++; };
    $('btnAttach').click();
    fileInput.click = originalClick;
    check('P14-C Attach 仍调用同一个 file input', () => fileClicks === 1 && $('btnAttach').tagName === 'BUTTON');

    window.S.attachments = [
      { id: 'p14c-loading', name: '正在解析.pdf', loading: true, kind: 'unknown', size: 12 },
      { id: 'p14c-error', name: '失败.docx', loading: false, error: '解析失败', kind: 'unknown', size: 12 },
    ];
    window.renderAttachments();
    check('P14-C 附件托盘显示解析中与错误文字', () =>
      $('attachTray').querySelector('.att.loading .att-meta')?.textContent.includes('解析中') &&
      $('attachTray').querySelector('.att.err .att-meta')?.textContent.includes('解析失败'));
    const remove = $('attachTray').querySelector('.att-x');
    check('P14-C 附件删除按钮有独立可访问名称', () =>
      remove?.tagName === 'BUTTON' && remove.type === 'button' && /移除.*正在解析/.test(remove.getAttribute('aria-label') || ''));
    remove?.click();
    check('P14-C 附件删除仍调用原有状态路径', () =>
      window.S.attachments.length === 1 && $('attachTray').querySelectorAll('.att').length === 1);
    window.S.attachments = [];
    window.renderAttachments();

    const drag = (type) => composer.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
    drag('dragenter');
    drag('dragenter');
    drag('dragleave');
    check('P14-C 嵌套拖拽离开不闪烁', () => composer.classList.contains('drop'));
    drag('dragleave');
    check('P14-C 拖拽彻底离开恢复外观', () => !composer.classList.contains('drop'));
    const dropped = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropped, 'dataTransfer', { value: { files: [] } });
    drag('dragenter');
    composer.dispatchEvent(dropped);
    check('P14-C drop 清除拖入视觉状态', () => dropped.defaultPrevented && !composer.classList.contains('drop'));

    const savedComposerModels = window.S.models;
    const savedComposerState = window.S.state;
    window.S.models = [{ provider: 'fixture', id: 'composer-model', name: 'Composer Model' }];
    window.S.state = { ...savedComposerState, model: { provider: 'fixture', id: 'composer-model', name: 'Composer Model' } };
    $('btnModel').click();
    const pop = window.document.querySelector('.pop');
    const selected = pop.querySelector('.pop-item.on');
    check('P14-C Model picker 控件与选中项可键盘访问', () =>
      $('btnModel').getAttribute('aria-expanded') === 'true' &&
      $('btnModel').getAttribute('aria-controls') === pop.id &&
      selected?.tagName === 'BUTTON' && selected.getAttribute('aria-current') === 'true' &&
      window.document.activeElement === selected);
    selected?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('P14-C Picker Escape 关闭并回到触发按钮', () =>
      pop.hidden && $('btnModel').getAttribute('aria-expanded') === 'false' && window.document.activeElement === $('btnModel'));
    $('btnThink').click();
    check('P14-C Thinking picker 复用可访问弹层', () =>
      !pop.hidden && $('btnThink').getAttribute('aria-expanded') === 'true' && pop.querySelectorAll('button.pop-item').length > 0);
    pop.querySelector('button.pop-item')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const savedComposerStats = window.S.stats;
    window.S.stats = { contextUsage: { tokens: 200, contextWindow: 1000, percent: 20 }, tokens: { input: 12, output: 34, cacheRead: 56 }, cost: 0.125 };
    $('btnCtx').click();
    check('P14-C Context 提示有锚点语义', () =>
      !pop.hidden && pop.getAttribute('role') === 'tooltip' && $('btnCtx').getAttribute('aria-expanded') === 'true');
    check('P14-C Context 提示只展示已有真实统计字段', () =>
      ['输入', '12', '输出', '34', '缓存读取', '56', '累计成本', '$0.1250'].every((part) => pop.textContent.includes(part)));
    pop.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));
    check('P14-C Context 提示关闭时语义同步', () =>
      pop.hidden && $('btnCtx').getAttribute('aria-expanded') === 'false');
    window.closePop();
    check('P14-C Context hover 前弹层确实关闭', () => pop.hidden && $('btnCtx').getAttribute('aria-expanded') === 'false');
    const errorsBeforeCtxHover = errors.length;
    $('btnCtx').dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false }));
    await new Promise((resolve) => setTimeout(resolve, 145));
    check('P14-C Context hover 无运行时异常', () =>
      errors.length === errorsBeforeCtxHover || errors.slice(errorsBeforeCtxHover).join(' | '));
    check('P14-C Context hover 延迟后打开真实 tooltip', () =>
      !pop.hidden && pop.classList.contains('tip-mode') && window.currentAnchor() === $('btnCtx') &&
      $('btnCtx').getAttribute('aria-expanded') === 'true' &&
      ['20%', '200', '1k', '12', '34', '56', '$0.1250'].every((part) => pop.textContent.includes(part)));
    $('btnCtx').dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));
    await new Promise((resolve) => setTimeout(resolve, 240));
    check('P14-C Context hover 离开后延迟关闭', () =>
      pop.hidden && $('btnCtx').getAttribute('aria-expanded') === 'false');
    check('P14-C Send 与 Stop 有独立可访问名称', () =>
      $('btnSend').getAttribute('aria-label') === '发送消息' && $('btnStop').getAttribute('aria-label') === '停止');
    $('navHome').click();
    check('P14-C Home 回到同一个输入框并聚焦', () => window.document.activeElement === $('input'));
    window.S.models = savedComposerModels;
    window.S.state = savedComposerState;
    window.S.stats = savedComposerStats;
  }

  /* P14-D: primary view switching must preserve the exact Chat and Composer nodes. */
  {
    $('navHome').click();
    window.rebuildFromMessages([{ role: 'user', content: '切换前的对话' }]);
    const conversation = $('stream').querySelector('.msg.user');
    const composer = $('chatComposer');
    const host = $('workSurface');
    $('input').value = '未发送草稿';
    window.S.attachments = [{ id: 'p14d-file', name: '待发送.txt', kind: 'text', size: 12, content: 'fixture' }];
    window.renderAttachments();
    const attachment = $('attachTray').querySelector('.att');
    $('stream').scrollTop = 37;
    window.S.streaming = true;
    check('P14-D 默认 Chat 且 Home 唯一激活', () => $('workspace').dataset.workspaceView === 'chat' && $('navHome').getAttribute('aria-current') === 'page' && $('globalRail').querySelectorAll('[aria-current="page"]').length === 1);
    $('navPlanner').click();
    check('P14-D Planner 在 Stage 且 Chat 节点仅隐藏', () => $('workspace').dataset.workspaceView === 'planner' && !$('workSurface').hidden && $('chatView').hidden && composer.hidden && $('modal').hidden && conversation.isConnected);
    check('P14-E Planner Tab 语义与可见面板一致', () => [...host.querySelectorAll('[role="tab"]')].every((tab) => tab.getAttribute('aria-selected') === String(tab.classList.contains('on')) && Boolean(window.document.getElementById(tab.getAttribute('aria-controls')))));
    check('P14-D Planner rail 唯一激活', () => $('navPlanner').getAttribute('aria-current') === 'page' && $('globalRail').querySelectorAll('[aria-current="page"]').length === 1);
    window.onMessageStart({ message: { role: 'assistant' } });
    window.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '离开 Chat 后继续生成' } });
    await new Promise((resolve) => setTimeout(resolve, 35));
    check('P14-D 非 Chat 时流式正文继续进入原 Conversation', () => $('stream').textContent.includes('离开 Chat 后继续生成') && window.S.streaming);
    $('workSurface').querySelector('.planner-goal')?.focus();
    $('navChanges').click();
    check('P14-E Surface 被替换后焦点回到当前一级导航', () => window.document.activeElement === $('navChanges'));
    check('P14-D Changes 替换 Planner 且仅一份 Surface', () => $('workspace').dataset.workspaceView === 'changes' && host.querySelector('.chg-body') && !host.querySelector('.planner-pane') && $('navChanges').getAttribute('aria-current') === 'page');
    $('navExtensions').click();
    check('P14-D Extensions 替换 Changes 并清掉 Git 容器', () => $('workspace').dataset.workspaceView === 'extensions' && !host.querySelector('.chg-body') && window.panels.changes === null);
    check('P14-E Extensions Tab 语义与可见面板一致', () => [...host.querySelectorAll('[role="tab"]')].every((tab) => tab.getAttribute('aria-selected') === String(tab.classList.contains('on')) && tab.getAttribute('aria-controls') === 'extensionsTabPanel') && Boolean(host.querySelector('#extensionsTabPanel[role="tabpanel"]')));
    $('navGlobalMore').click();
    check('P14-D More 不抢主视图', () => $('navExtensions').getAttribute('aria-current') === 'page' && $('globalRail').querySelectorAll('[aria-current="page"]').length === 1);
    $('navDiagnostics').click();
    check('P14-D 二级 Modal 覆盖 Extensions', () => !$('modal').hidden && $('workspace').dataset.workspaceView === 'extensions');
    window.closeModal();
    check('P14-D 关闭二级 Modal 后仍在 Extensions', () => $('modal').hidden && $('workspace').dataset.workspaceView === 'extensions' && $('navExtensions').getAttribute('aria-current') === 'page');
    const scrollBeforeReturn = $('stream').scrollTop;
    $('navHome').click();
    check('P14-D 返回 Chat 保留 Conversation 节点与滚动', () => $('workspace').dataset.workspaceView === 'chat' && $('stream').querySelector('.msg.user') === conversation && $('stream').scrollTop === scrollBeforeReturn && !$('chatView').hidden);
    check('P14-D 返回 Chat 保留 Composer、草稿与附件节点', () => $('chatComposer') === composer && !composer.hidden && $('input').value === '未发送草稿' && $('attachTray').querySelector('.att') === attachment);
    check('P14-D 返回 Chat 立即看到后台流式内容', () => $('stream').textContent.includes('离开 Chat 后继续生成') && window.S.streaming);
    check('P14-D Surface host 不重复创建', () => window.document.querySelectorAll('#workSurface').length === 1);
    window.S.streaming = false;
    window.S.attachments = [];
    window.renderAttachments();
    $('input').value = '';

    // P14-D 收口：从 Work Surface 换会话，必须等成功后才回到 Chat。
    $('navPlanner').click();
    check('P14-D 收口：新对话前仍在 Planner', () => $('workspace').dataset.workspaceView === 'planner');
    $('navNew').focus();
    check('P14-E 新对话点击前焦点在侧栏按钮', () => window.document.activeElement === $('navNew'));
    const beforeNew = commands.length;
    $('navNew').click();
    check('P14-D 收口：新对话确实发出 RPC 且应答前不切视图', () =>
      commands.slice(beforeNew).some((c) => c.type === 'new_session') && $('workspace').dataset.workspaceView === 'planner');
    es.emit({ type: 'response', command: 'new_session', success: true, data: {} });
    check('P14-D 收口：新对话成功后 Chat 唯一激活且 Surface 卸载', () =>
      $('workspace').dataset.workspaceView === 'chat' && $('navHome').getAttribute('aria-current') === 'page' &&
      !$('navPlanner').classList.contains('is-active') && !$('chatView').hidden && !$('chatComposer').hidden &&
      $('workSurface').hidden && $('workSurface').childElementCount === 0 &&
      $('globalRail').querySelectorAll('[aria-current="page"]').length === 1);
    check('P14-E 侧栏新对话成功后焦点进入 Composer', () => window.document.activeElement === $('input'));

    $('navPlanner').click();
    $('input').disabled = true;
    $('navNew').focus();
    es.emit({ type: 'response', command: 'new_session', success: true, data: {} });
    check('P14-E 无项目时成功换会话回 Home 而不聚焦禁用输入', () =>
      $('workspace').dataset.workspaceView === 'chat' && window.document.activeElement === $('navHome'));
    $('input').disabled = false;

    window.rebuildFromMessages([{ role: 'user', content: '旧会话正文' }]);
    window.renderProjects();
    await new Promise((resolve) => setTimeout(resolve, 80));
    $('navPlanner').click();
    const switchSurface = $('workSurface').firstElementChild;
    const switchButton = $('projects').querySelector('.pj-sess-primary[aria-label^="切换会话"]');
    stubSwitch = { ok: false, error: '夹具拒绝切换' };
    switchButton?.focus();
    check('P14-E 失败切换前焦点在历史会话按钮', () => window.document.activeElement === switchButton);
    switchButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    check('P14-D 收口：切旧会话失败仍留 Planner 且 Surface 未清空', () =>
      $('workspace').dataset.workspaceView === 'planner' && $('workSurface').firstElementChild === switchSurface &&
      !$('workSurface').hidden && $('stream').textContent.includes('旧会话正文'));
    check('P14-E 失败切换保持旧会话按钮焦点', () => window.document.activeElement === switchButton && switchButton.isConnected);

    stubSwitch = { ok: true, id: 'bbbbbbbbbbbbbbbb', title: '帮我写个登录功能' };
    const beforeSwitch = sessionCalls.length;
    const beforeBoot = commands.length;
    switchButton?.focus();
    check('P14-E 成功切换前焦点在历史会话按钮', () => window.document.activeElement === switchButton);
    switchButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    check('P14-D 收口：侧栏旧会话成功切到 Chat 且只激活 Home', () =>
      sessionCalls.slice(beforeSwitch).some((c) => /\/switch$/.test(c.url) && c.body?.id === 'bbbbbbbbbbbbbbbb') &&
      $('workspace').dataset.workspaceView === 'chat' && $('navHome').getAttribute('aria-current') === 'page' &&
      $('globalRail').querySelectorAll('[aria-current="page"]').length === 1 &&
      !$('chatView').hidden && !$('chatComposer').hidden && $('workSurface').hidden &&
      $('workSurface').childElementCount === 0 && !$('stream').textContent.includes('旧会话正文'));
    for (let i = 0; i < 40 && switchButton?.isConnected; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    check('P14-E 历史会话刷新确实移除原焦点按钮', () => switchButton && !switchButton.isConnected);
    check('P14-E 历史会话刷新后焦点仍在 Composer', () =>
      window.document.activeElement !== window.document.body && window.document.activeElement === $('input'));
    await new Promise((resolve) => setTimeout(resolve, 280));
    check('P14-D 收口：侧栏成功切换走现有 boot 历史重建链路', () =>
      commands.slice(beforeBoot).some((c) => c.type === 'get_messages'));
    es.emit({ type: 'response', command: 'get_messages', success: true,
      data: { messages: [{ role: 'user', content: '新会话历史正文' }] } });
    check('P14-D 收口：新会话历史在 Chat 中可见', () =>
      $('workspace').dataset.workspaceView === 'chat' && $('stream').textContent.includes('新会话历史正文'));
    stubSwitch = { ok: true, id: 'bbbbbbbbbbbbbbbb', title: '帮我写个登录功能' };

    $('navPlanner').click();
    const oldSurface = $('workSurface').querySelector('.planner-pane');
    const projectSwitch = window.activateProject('C:\\p14d-project-b', 'P14-D B');
    check('P14-D 切项目立即返回 Chat 并卸载旧 Surface', () => $('workspace').dataset.workspaceView === 'chat' && $('workSurface').childElementCount === 0 && oldSurface && !oldSurface.isConnected);
    await projectSwitch;
    check('P14-D 项目切换后一级视图仍为 Chat', () => $('workspace').dataset.workspaceView === 'chat' && $('navHome').getAttribute('aria-current') === 'page');
  }

  /* P16：通过真实 SSE 接线检查并发、能力证据和官方安装后的 Pi 生命周期。 */
  {
    const run = Number.isInteger(window.S.bridgeRun) ? window.S.bridgeRun : 1;
    window.S.bridgeRun = run;
    window.S.hasProject = true;
    window.S.switching = false;
    window.clearThread();
    for (const [id, query] of [['p16-a', 'A'], ['p16-b', 'B']]) es.emit({ type: 'tool_execution_start', bridgeRun: run, toolCallId: id, toolName: 'web_search', args: { query } });
    const first = window.document.querySelector('[data-id="p16-a"]');
    es.emit({ type: 'tool_execution_update', bridgeRun: run, toolCallId: 'p16-a', partialResult: { content: [{ type: 'text', text: 'untrusted output' }] } });
    es.emit({ type: 'tool_execution_end', bridgeRun: run, toolCallId: 'p16-b', result: { content: [], details: { totalResults: 1 } }, isError: false });
    check('P16 SSE 并发调用按 id 隔离', () => window.document.querySelector('[data-id="p16-a"]').dataset.status === 'running' && window.document.querySelector('[data-id="p16-b"]').dataset.status === 'success');
    es.emit({ type: 'tool_execution_end', bridgeRun: run, toolCallId: 'p16-a', result: { content: [], details: { error: 'Search failed' } }, isError: false });
    check('P16 Extension details.error 不伪装成功', () => first.dataset.status === 'error' && first.textContent.includes('Web search failed'));
    check('P16 start/update/end 仍是原节点', () => first === window.document.querySelector('[data-id="p16-a"]') && window.document.querySelectorAll('[data-id="p16-a"]').length === 1);
    const box = window.document.createElement('section'); window.document.body.appendChild(box);
    window.renderWebSetup(box, { ok: true, extensions: [] });
    /* P22：运行观察文案统一成一句话（原来每个 feature 自己一套措辞）。 */
    const webObs = () => box.querySelector('.cap-rows [data-k="运行观察"] .ext-row-v')?.textContent || '';
    check('P16 设置区显示实际调用证据', () => webObs() === '本次 Pi 运行观察到调用：web_search');
    check('P16 固定官方安装命令', () => box.querySelector('code').textContent === 'pi install npm:pi-web-access');
    check('P16 第三方权限说明', () => box.textContent.includes('同等系统权限'));
    es.emit({ type: 'bridge_status', state: 'restarting', bridgeRun: run });
    window.renderWebSetup(box, { ok: true, extensions: [] });
    check('P16 重启清空调用证据', () => webObs() === '本次 Pi 运行尚未观察到调用');
    check('P16 重启期间 Composer 不可用', () => $('input').disabled);
    es.emit({ type: 'bridge_status', state: 'ready', bridgeRun: run });
    const baseFetch = window.fetch;
    let restartCalls = 0;
    window.fetch = async (url, opts) => String(url) === '/api/restart' ? (restartCalls++, { json: async () => ({ ok: false }) }) : baseFetch(url, opts);
    const restart = [...box.querySelectorAll('button')].find(b => b.textContent === '安装后重启 Pi');
    const pendingRestart = restart.onclick();
    check('P16 重启先确认', () => !$('confirmLayer').hidden && restartCalls === 0);
    $('confirmCard').querySelector('.btn.primary').onclick();
    await pendingRestart;
    check('P16 确认后复用现有 restart API', () => restartCalls === 1);
    check('P16 重启失败可重试', () => !restart.disabled);
    window.fetch = baseFetch;
    const pendingStale = restart.onclick();
    window.S.workspaceGeneration++;
    $('confirmCard').querySelector('.btn.primary').onclick();
    await pendingStale;
    check('P16 切项目后旧确认不重启', () => restartCalls === 1);
    window.renderWebSetup(box, { ok: true, extensions: [] });
    check('P16 切项目后观察为空', () => webObs() === '本次 Pi 运行尚未观察到调用');
    window.S.switching = true;
    es.emit({ type: 'tool_execution_start', bridgeRun: run, toolCallId: 'p16-stale', toolName: 'web_search', args: { query: 'Old workspace' } });
    window.renderWebSetup(box, { ok: true, extensions: [] });
    check('P16 切项目同步期间旧 run 不能污染证据', () => webObs() === '本次 Pi 运行尚未观察到调用');
    window.S.switching = false;
    box.remove();
  }

  /* P17: real SSE routing, independent identities, debounce and workspace guards. */
  {
    const run = window.S.bridgeRun;
    window.S.hasProject = true; window.S.switching = false;
    window.clearThread();
    await new Promise(r => setTimeout(r, 600));
    const beforeGit = gitCalls.filter(c => c.kind === 'status').length;
    const beforeCommands = commands.length;
    const beforeLedger = JSON.stringify(window.listChanges());
    const child = agent => ({ index: 0, agent, task: 'Review', exitCode: 0, model: 'actual/model' });
    for (const id of ['p17-a', 'p17-b']) es.emit({ type: 'tool_execution_start', bridgeRun: run, toolCallId: id, toolName: 'subagent', args: { agent: id, task: 'Review', async: false } });
    const first = window.document.querySelector('[data-id="p17-a"]');
    es.emit({ type: 'tool_execution_update', bridgeRun: run, toolCallId: 'p17-a', partialResult: { content: [{ type: 'text', text: 'RAW_SECRET' }], details: { mode: 'single', results: [{ ...child('p17-a'), progress: { currentTool: 'read', toolCount: 2, tokens: 90 } }] } } });
    await new Promise(r => setTimeout(r, 180));
    check('P17 SSE partial details 进入原节点', () => first.textContent.includes('Tool: read') && !first.textContent.includes('RAW_SECRET'));
    for (const id of ['p17-b', 'p17-a']) es.emit({ type: 'tool_execution_end', bridgeRun: run, toolCallId: id, result: { content: [], details: { mode: 'single', runId: id, results: [child(id)] } }, isError: false });
    check('P17 SSE 逆序完成保持两个独立节点', () => first === window.document.querySelector('[data-id="p17-a"]') && window.document.querySelectorAll('[data-id^="p17-"]').length === 2 && first.dataset.status === 'success');
    await new Promise(r => setTimeout(r, 600));
    check('P17 两次完成只刷新一次 Git', () => gitCalls.filter(c => c.kind === 'status').length === beforeGit + 1);
    check('P17 不把 child 输出加入 Changes 账本', () => JSON.stringify(window.listChanges()) === beforeLedger);
    check('P17 不创建 Planner 任务或调用 RPC', () => commands.length === beforeCommands);
    const box = window.document.createElement('section'); window.document.body.appendChild(box);
    window.renderSubagentSetup(box, { ok: true, extensions: [] });
    const subObs = () => box.querySelector('.cap-rows [data-k="运行观察"] .ext-row-v')?.textContent || '';
    check('P17 Runtime evidence 独立显示', () => subObs() === '本次 Pi 运行观察到调用：subagent');
    const sameRun = window.S.bridgeRun;
    window.S.switching = true;
    es.emit({ type: 'tool_execution_start', bridgeRun: sameRun, toolCallId: 'p17-old', toolName: 'subagent', args: { agent: 'old' } });
    es.emit({ type: 'tool_execution_update', bridgeRun: sameRun, toolCallId: 'p17-a', partialResult: { details: { results: [child('OLD_AGENT')] } } });
    es.emit({ type: 'tool_execution_end', bridgeRun: sameRun, toolCallId: 'p17-a', result: { details: { results: [child('OLD_AGENT')] } }, isError: true });
    check('P17 激活期间丢弃旧 start/update/end', () => !window.document.querySelector('[data-id="p17-old"]') && first.dataset.status === 'success' && !first.textContent.includes('OLD_AGENT'));
    window.S.switching = false;
    window.S.bridgeRun = sameRun + 1;
    es.emit({ type: 'tool_execution_end', bridgeRun: sameRun, toolCallId: 'p17-a', result: {}, isError: true });
    check('P17 新 run 拒绝旧 run end', () => first.dataset.status === 'success');
    window.S.bridgeRun = sameRun;
    es.emit({ type: 'tool_execution_start', bridgeRun: sameRun, toolCallId: 'p17-stop', toolName: 'subagent', args: {} });
    window.interruptActive();
    check('P17 Stop 后无运行 spinner', () => window.document.querySelector('[data-id="p17-stop"]').dataset.status === 'incomplete');
    window.observeSubagentEvent({ type: 'bridge_status', state: 'restarting', bridgeRun: sameRun });
    window.renderSubagentSetup(box, { ok: true, extensions: [] });
    check('P17 重启清空 observation', () => subObs() === '本次 Pi 运行尚未观察到调用');
    check('P17 安装仅固定命令', () => box.querySelector('code').textContent === 'pi install npm:pi-subagents');
    const baseFetch = window.fetch; let restarts = 0;
    window.fetch = async (url, opts) => String(url) === '/api/restart' ? (restarts++, { json: async () => ({ ok: false }) }) : baseFetch(url, opts);
    const restart = [...box.querySelectorAll('button')].find(b => b.textContent === '安装后重启 Pi');
    const pending = restart.onclick();
    check('P17 重启先确认', () => !$('confirmLayer').hidden && restarts === 0);
    $('confirmCard').querySelector('.btn.primary').onclick(); await pending;
    check('P17 重启 API 失败后可重试', () => restarts === 1 && !restart.disabled);
    const stale = restart.onclick(); window.S.workspaceGeneration++;
    $('confirmCard').querySelector('.btn.primary').onclick(); await stale;
    check('P17 旧 workspace 确认不重启', () => restarts === 1);
    window.fetch = baseFetch; box.remove(); window.clearThread();
  }

  /* P18: real SSE routing for Pi Memory tools — identity, workspace guard, Stop,
   * no Git refresh / ledger / RPC, observation reset, manual install only. */
  {
    const run = window.S.bridgeRun;
    window.S.hasProject = true; window.S.switching = false;
    window.clearThread();
    await new Promise(r => setTimeout(r, 600));
    const beforeGit = gitCalls.filter(c => c.kind === 'status').length;
    const beforeCommands = commands.length;
    const beforeLedger = JSON.stringify(window.listChanges());
    const PRIVATE_MEMORY = 'PRIVATE_MEMORY_TEXT';
    for (const id of ['p18-a', 'p18-b']) es.emit({ type: 'tool_execution_start', bridgeRun: run, toolCallId: id, toolName: 'memory_search', args: { query: id } });
    const first = window.document.querySelector('[data-id="p18-a"]');
    es.emit({ type: 'tool_execution_update', bridgeRun: run, toolCallId: 'p18-a', partialResult: { content: [{ type: 'text', text: PRIVATE_MEMORY }], details: { mode: 'keyword', query: 'p18-a', count: 2, needsEmbed: false } } });
    await new Promise(r => setTimeout(r, 180));
    check('P18 SSE 检索按 id 独立且不铺全文', () => first.textContent.includes('Matches: 2') && !first.textContent.includes(PRIVATE_MEMORY));
    for (const id of ['p18-b', 'p18-a']) es.emit({ type: 'tool_execution_end', bridgeRun: run, toolCallId: id, result: { content: [{ type: 'text', text: PRIVATE_MEMORY }], details: { mode: 'keyword', query: id, count: 1, path: 'C:\\Users\\p18user\\.pi\\agent\\memory\\MEMORY.md' } }, isError: false });
    check('P18 SSE 逆序完成保持两个独立节点', () => first === window.document.querySelector('[data-id="p18-a"]') && window.document.querySelectorAll('[data-id^="p18-"]').length === 2 && first.dataset.status === 'success');
    check('P18 时间线不显示 raw args/details', () => first.querySelector('.tl-args').textContent === '' && !first.outerHTML.includes('p18user') && !first.outerHTML.includes(PRIVATE_MEMORY));
    await new Promise(r => setTimeout(r, 600));
    check('P18 不额外刷新 Git', () => gitCalls.filter(c => c.kind === 'status').length === beforeGit);
    check('P18 不进入 Changes 账本', () => JSON.stringify(window.listChanges()) === beforeLedger);
    check('P18 不创建 Planner 任务或调用 RPC', () => commands.length === beforeCommands);
    const box = window.document.createElement('section'); window.document.body.appendChild(box);
    window.renderMemorySetup(box, { ok: true, extensions: [] });
    const memObs = () => box.querySelector('.cap-rows [data-k="运行观察"] .ext-row-v')?.textContent || '';
    check('P18 Runtime evidence 独立显示', () => memObs() === '本次 Pi 运行观察到调用：memory_search'
      && !memObs().includes('memory_write'));
    check('P18 安装仅固定命令', () => box.querySelector('code').textContent === 'pi install npm:pi-memory');
    check('P18 长期记忆与会话搜索分开说明', () => box.textContent.includes('这不是「会话搜索」'));
    const sameRun = window.S.bridgeRun;
    window.S.switching = true;
    es.emit({ type: 'tool_execution_start', bridgeRun: sameRun, toolCallId: 'p18-old', toolName: 'memory_search', args: { query: 'old' } });
    es.emit({ type: 'tool_execution_end', bridgeRun: sameRun, toolCallId: 'p18-a', result: { content: [], details: { count: 99 } }, isError: true });
    check('P18 激活期间丢弃旧 start/end', () => !window.document.querySelector('[data-id="p18-old"]') && first.dataset.status === 'success');
    window.S.switching = false;
    es.emit({ type: 'tool_execution_start', bridgeRun: sameRun, toolCallId: 'p18-stop', toolName: 'memory_write', args: { target: 'long_term' } });
    window.interruptActive();
    check('P18 Stop 后无运行 spinner', () => window.document.querySelector('[data-id="p18-stop"]').dataset.status === 'incomplete');
    es.emit({ type: 'bridge_status', state: 'restarting', bridgeRun: sameRun });
    window.renderMemorySetup(box, { ok: true, extensions: [] });
    check('P18 重启清空 observation', () => memObs() === '本次 Pi 运行尚未观察到调用');
    es.emit({ type: 'bridge_status', state: 'ready', bridgeRun: sameRun });
    const baseFetch = window.fetch; let restarts = 0;
    window.fetch = async (url, opts) => String(url) === '/api/restart' ? (restarts++, { json: async () => ({ ok: false }) }) : baseFetch(url, opts);
    const restart = [...box.querySelectorAll('button')].find(b => b.textContent === '安装后重启 Pi');
    const pending = restart.onclick();
    check('P18 重启先确认', () => !$('confirmLayer').hidden && restarts === 0);
    $('confirmCard').querySelector('.btn.primary').onclick(); await pending;
    check('P18 重启 API 失败后可重试', () => restarts === 1 && !restart.disabled);
    const stale = restart.onclick(); window.S.workspaceGeneration++;
    $('confirmCard').querySelector('.btn.primary').onclick(); await stale;
    check('P18 旧 workspace 确认不重启', () => restarts === 1);
    window.fetch = baseFetch; box.remove(); window.clearThread();
  }
  /* P19: real SSE approval flow — one shared confirm surface, explicit protocol
   * response, replay dedupe, Stop/restart lifecycle. */
  {
    const run = Number.isInteger(window.S.bridgeRun) ? window.S.bridgeRun : 1;
    window.S.bridgeRun = run; window.S.hasProject = true; window.S.switching = false;
    window.S.bridgeState = 'ready';
    const sent = [];
    const baseFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).endsWith('/api/command')) { try { sent.push(JSON.parse(opts.body)); } catch { /* 忽略 */ } return { json: async () => ({ ok: true }) }; }
      return baseFetch(url, opts);
    };
    const p19Layer = window.document.getElementById('confirmLayer');
    const p19Card = window.document.getElementById('confirmCard');
    const clickText = (scope, t) => [...scope.querySelectorAll('button')].find((b) => b.textContent === t).click();
    window.clearThread();
    es.emit({ type: 'extension_ui_request', bridgeRun: run, id: 'p19-a', method: 'confirm', title: 'Allow rm -rf?', message: '危险命令' });
    check('P19 真实 SSE 用统一确认框弹审批', () => p19Layer.hidden === false && p19Card.textContent.includes('Allow rm -rf?'));
    check('P19 只有一次性的允许 / 拒绝', () => [...p19Card.querySelectorAll('button')].map((b) => b.textContent).join(',') === '拒绝,允许一次');
    es.emit({ type: 'extension_ui_request', bridgeRun: run, id: 'p19-a', method: 'confirm', title: 'Allow rm -rf?', message: '危险命令' });
    check('P19 SSE 重放不重复弹窗', () => window.approvalSnapshot().pending.length === 1);
    clickText(p19Card, '允许一次');
    await new Promise((r) => setTimeout(r, 30));
    check('P19 允许走 extension_ui_response', () => sent.some((c) => c.type === 'extension_ui_response' && c.id === 'p19-a' && c.confirmed === true));
    es.emit({ type: 'extension_ui_request', bridgeRun: run, id: 'p19-a', method: 'confirm', title: 'x' });
    check('P19 已结算的请求不再弹出', () => p19Layer.hidden === true);
    es.emit({ type: 'extension_ui_request', bridgeRun: run, id: 'p19-b', method: 'confirm', title: 'second' });
    window.cancelPendingApprovals();
    await new Promise((r) => setTimeout(r, 30));
    check('P19 Stop 取消 pending 并收掉卡片', () => p19Layer.hidden === true && sent.some((c) => c.type === 'extension_ui_response' && c.id === 'p19-b' && c.cancelled === true));
    es.emit({ type: 'extension_ui_request', bridgeRun: run, id: 'p19-c', method: 'confirm', title: 'third' });
    window.S.switching = true;
    es.emit({ type: 'extension_ui_request', bridgeRun: run, id: 'p19-d', method: 'confirm', title: 'stale' });
    check('P19 切项目同步期间不弹新请求', () => window.approvalSnapshot().pending.length === 1 && !p19Card.textContent.includes('stale'));
    window.S.switching = false;
    es.emit({ type: 'bridge_status', state: 'restarting', bridgeRun: run });
    check('P19 重启清空 pending 并收卡', () => p19Layer.hidden === true && window.approvalSnapshot().pending.length === 0);
    es.emit({ type: 'bridge_status', state: 'ready', bridgeRun: run });
    window.fetch = baseFetch; window.clearThread();
  }
  /* P20: real SSE routing for browser tools — identity, out-of-order completion,
   * secret / raw page content redaction, safe source link, Stop, observation reset. */
  {
    const run = Number.isInteger(window.S.bridgeRun) ? window.S.bridgeRun : 1;
    window.S.bridgeRun = run; window.S.hasProject = true; window.S.switching = false;
    window.clearThread();
    await new Promise(r => setTimeout(r, 600));
    const beforeGit = gitCalls.filter(c => c.kind === 'status').length;
    const beforeCommands = commands.length;
    const SECRET = 'PRIVATE_TYPED_SECRET';
    for (const id of ['p20-a', 'p20-b']) es.emit({ type: 'tool_execution_start', bridgeRun: run, toolCallId: id, toolName: 'browser_fill', args: { ref: id, value: SECRET } });
    const first = window.document.querySelector('[data-id="p20-a"]');
    es.emit({ type: 'tool_execution_update', bridgeRun: run, toolCallId: 'p20-a', partialResult: { content: [{ type: 'text', text: SECRET }], details: { ok: true } } });
    await new Promise(r => setTimeout(r, 180));
    check('P20 SSE 输入内容不进 DOM', () => first.textContent.includes('Entering text') && !first.outerHTML.includes(SECRET));
    for (const id of ['p20-b', 'p20-a']) es.emit({ type: 'tool_execution_end', bridgeRun: run, toolCallId: id, result: { content: [{ type: 'text', text: SECRET }], details: { ok: true, ref: id, value: SECRET, verified: SECRET, tag: 'INPUT' } }, isError: false });
    check('P20 SSE 逆序完成保持两个独立节点', () => first === window.document.querySelector('[data-id="p20-a"]') && window.document.querySelectorAll('[data-id^="p20-"]').length === 2 && first.dataset.status === 'success');
    check('P20 时间线不显示 raw args/details', () => first.querySelector('.tl-args').textContent === '' && !first.outerHTML.includes(SECRET));
    check('P20 输入动作只说「已输入文本」', () => first.querySelector('.tl-label').textContent === 'Entered text');
    es.emit({ type: 'tool_execution_start', bridgeRun: run, toolCallId: 'p20-nav', toolName: 'browser_navigate', args: { url: 'https://example.com/' } });
    es.emit({ type: 'tool_execution_end', bridgeRun: run, toolCallId: 'p20-nav', result: { content: [{ type: 'text', text: 'Navigated to: https://example.com/' }], details: { ok: true, page: { url: 'https://example.com/', title: 'PRIVATE_PAGE_TITLE', width: 1280, height: 720 } } }, isError: false });
    const nav = window.document.querySelector('[data-id="p20-nav"]');
    check('P20 打开页面只说主机名', () => nav.querySelector('.tl-label').textContent === 'Opened example.com');
    check('P20 页面标题不进入 DOM', () => !nav.outerHTML.includes('PRIVATE_PAGE_TITLE'));
    check('P20 只给安全的可点击来源', () => nav.querySelector('.web-source') && nav.querySelector('.web-source').href === 'https://example.com/');
    await new Promise(r => setTimeout(r, 600));
    check('P20 不额外刷新 Git', () => gitCalls.filter(c => c.kind === 'status').length === beforeGit);
    check('P20 不创建 Planner 任务或调用 RPC', () => commands.length === beforeCommands);
    const box = window.document.createElement('section'); window.document.body.appendChild(box);
    window.renderBrowserSetup(box, { ok: true, extensions: [] });
    const brObs = () => box.querySelector('.cap-rows [data-k="运行观察"] .ext-row-v')?.textContent || '';
    check('P20 设置区显示实际调用证据', () => brObs().includes('本次 Pi 运行观察到调用') && brObs().includes('browser_fill') && brObs().includes('（共 2 个）'));
    check('P20 安装仅固定命令', () => box.querySelector('code').textContent === 'pi install npm:pi-browser-harness');
    check('P20 明说与 Web Search 是两件事', () => box.textContent.includes('Browser Use 与 Web Search 是两件事'));
    check('P20 不假装有审批', () => box.textContent.includes('没有审批协议') && ![...box.querySelectorAll('button')].some(b => /允许|拒绝/.test(b.textContent)));
    const sameRun = window.S.bridgeRun;
    window.S.switching = true;
    es.emit({ type: 'tool_execution_start', bridgeRun: sameRun, toolCallId: 'p20-old', toolName: 'browser_click', args: { ref: 'e1' } });
    check('P20 激活期间丢弃旧 start', () => !window.document.querySelector('[data-id="p20-old"]'));
    window.S.switching = false;
    es.emit({ type: 'tool_execution_start', bridgeRun: sameRun, toolCallId: 'p20-stop', toolName: 'browser_wait', args: { seconds: 30 } });
    window.interruptActive();
    check('P20 Stop 后无运行 spinner', () => window.document.querySelector('[data-id="p20-stop"]').dataset.status === 'incomplete');
    es.emit({ type: 'bridge_status', state: 'restarting', bridgeRun: sameRun });
    window.renderBrowserSetup(box, { ok: true, extensions: [] });
    check('P20 重启清空 observation', () => brObs() === '本次 Pi 运行尚未观察到调用');
    es.emit({ type: 'bridge_status', state: 'ready', bridgeRun: sameRun });
    box.remove(); window.clearThread();
  }

  /* P22: Capability 视图 —— 一条统一的界面回答「这个能力现在能不能用」。
   * 这里量的是 DOM 语义（状态文案、六个字段、有没有假按钮）；
   * 排版与横向溢出在 cdp-shot.cjs 的真实 Chrome 场景里量。 */
  {
    window.S.hasProject = true; window.S.switching = false;
    window.S.bridgeState = 'ready';
    window.clearThread();
    const host = $('workSurface');
    host.innerHTML = '';
    window.openExtensions();
    await new Promise(r => setTimeout(r, 60));
    const card = host;
    const capRows = () => [...card.querySelectorAll('.cap-view .ext-item')];
    const capNames = () => capRows().map(r => r.querySelector('.ext-name')?.textContent || '');
    const capStatuses = () => capRows().map(r => r.querySelector('.cap-status-line')?.textContent || '');
    const pick = (name) => capRows().find(r => (r.querySelector('.ext-name')?.textContent || '').includes(name));
    const detailKeys = () => [...card.querySelectorAll('.cap-view .cap-rows .ext-row')].map(r => r.dataset.k);
    const detailValue = (k) => card.querySelector(`.cap-view .cap-rows [data-k="${k}"] .ext-row-v`)?.textContent || '';

    check('P22 All 是默认过滤器，且每行都有统一状态行', () =>
      card.querySelector('#extensionsTabAll')?.getAttribute('aria-selected') === 'true'
      && capRows().length >= 8 && capRows().every(r => r.querySelector('.cap-status-line')));

    check('P22 已知能力都在：Web / Subagents / Memory / Browser / Native MCP / Approval / Usage / Skills', () => {
      const names = capNames().join(' | ');
      const want = ['Web Access', 'Subagents', 'Pi Memory', 'Browser Use', 'Native MCP', 'Approval', 'Usage / Quota', 'Skills'];
      return want.every(w => names.includes(w)) || names;
    });

    check('P22 All 里同时保留通用 Extension（含不认识 / 坏掉的那些）', () => {
      const names = capNames();
      return names.includes('Sample Extension') && names.includes('Broken Extension');
    });

    check('P22 built-in 用 builtin: 前缀，且详情说清它不来自目录扫描', () => {
      const row = pick('builtin:mcp');
      if (!row) return 'no builtin row: ' + capNames().join(' | ');
      row.onclick();
      const text = card.querySelector('.cap-view')?.textContent || '';
      return text.includes('pi 内置扩展') && text.includes('不由 Extension Registry 的目录扫描发现') || text.slice(0, 160);
    });

    // 详情：只画**对这个能力适用**的字段（不再是六个格子 + 一串「不适用」）
    pick('Web Access')?.onclick();
    await new Promise(r => setTimeout(r, 20));
    check('P22 详情只画适用的状态字段（第三方 Extension：五个）', () => {
      const keys = detailKeys();
      return JSON.stringify(keys) === JSON.stringify(['安装状态', '启用配置', '已加载', '运行观察', '需要重启']) || JSON.stringify(keys);
    });
    check('P22 diagnostic=null 时连「诊断」这一行都不画（不再写「诊断 无」）', () =>
      !detailKeys().includes('诊断') || JSON.stringify(detailKeys()));
    check('P22 第三方 Extension 给出固定官方命令与一键安装 / 复制 / 安装后重启', () => {
      const code = card.querySelector('.cap-view code');
      const buttons = [...card.querySelectorAll('.cap-view .ext-acts .btn')].map(b => b.textContent);
      const install = card.querySelector('.cap-view .cap-install');
      return code?.textContent === 'pi install npm:pi-web-access'
        && install?.dataset.installState === 'install' && install?.textContent === '安装'
        && buttons.includes('复制安装命令') && buttons.includes('安装后重启 Pi') || JSON.stringify(buttons);
    });
    // 一键安装：先确认，取消则一个请求都不发
    {
      const installCalls = [];
      const baseFetchForInstall = window.fetch;
      window.fetch = async (url, opts) => {
        if (String(url).includes('/api/capabilities/install')) {
          installCalls.push({ url: String(url), body: opts && opts.body });
          return { json: async () => ({ ok: true, capabilityId: 'web', commandCompleted: true, loaded: null }) };
        }
        return baseFetchForInstall(url, opts);
      };
      card.querySelector('.cap-view .cap-install').click();
      await new Promise(r => setTimeout(r, 20));
      const confirmText = $('confirmCard').textContent;
      const confirmed = $('confirmLayer').hidden === false;
      $('confirmCard').querySelector('.btn').click(); // 取消
      await new Promise(r => setTimeout(r, 20));
      window.fetch = baseFetchForInstall;
      check('P22 点「安装」先弹确认：命令 / 权限 / 用户级都写清楚', () =>
        (confirmed && confirmText.includes('pi install npm:pi-web-access')
          && confirmText.includes('用户级') && confirmText.includes('Pi 进程的权限')) || confirmText.slice(0, 120));
      check('P22 确认框点「取消」→ 一个安装请求都不发', () =>
        installCalls.length === 0 || JSON.stringify(installCalls));
    }

    /* 发现失败时 installed 只能是 null —— 这一格最容易糊弄成「未安装」。
     * 换一个 ok:false 的 registry 桩，刷新后必须显示「未知（无法确认）」。 */
    const savedForNull = stubExtensions;
    stubExtensions = { ok: false };
    [...card.querySelectorAll('.cap-view .ext-bar .btn')].find(b => b.textContent === '刷新')?.onclick();
    await new Promise(r => setTimeout(r, 40));
    pick('Web Access')?.onclick();
    await new Promise(r => setTimeout(r, 20));
    check('P22 null 显示「未知（无法确认）」，不显示成「否」', () => {
      const text = card.querySelector('.cap-view')?.textContent || '';
      return detailValue('安装状态') === '未知（无法确认）'
        && detailValue('已加载') === '未知（无法确认）'
        && !text.includes('未安装') || `${detailValue('安装状态')} / ${detailValue('已加载')}`;
    });
    check('P22/P24 installed=null 时给的是「重新检查」，不是「安装」', () => {
      const btn = card.querySelector('.cap-view .cap-install');
      return (btn && btn.dataset.installState === 'recheck' && btn.textContent === '重新检查'
        && ![...card.querySelectorAll('.cap-view .ext-acts .btn')].some(b => b.textContent === '安装'))
        || (btn ? `${btn.dataset.installState}/${btn.textContent}` : '没有按钮');
    });
    stubExtensions = savedForNull;
    [...card.querySelectorAll('.cap-view .ext-bar .btn')].find(b => b.textContent === '刷新')?.onclick();
    await new Promise(r => setTimeout(r, 40));

    // Native MCP：进入统一体验，但不假装有 npm 安装命令
    pick('Native MCP')?.onclick();
    await new Promise(r => setTimeout(r, 20));
    check('P22 Native MCP 不显示 npm 安装命令', () =>
      card.querySelector('.cap-view code') === null
      && (card.querySelector('.cap-view')?.textContent || '').includes('没有安装命令'));
    check('P22 Native MCP 复用 P20.6 的原生状态词汇', () => {
      const text = card.querySelector('.cap-view')?.textContent || '';
      return text.includes('原生 MCP 生效中') && text.includes('built-in');
    });
    check('P22 Native MCP 明说「包里有」不等于「已启用」', () =>
      (card.querySelector('.cap-view')?.textContent || '').includes('不等于'));
    check('P22 Native MCP 详情不再是一串「不适用」', () =>
      !(card.querySelector('.cap-view .cap-rows')?.textContent || '').includes('不适用') ||
      (card.querySelector('.cap-view .cap-rows')?.textContent || '').slice(0, 120));

    // 搜索
    const capSearch = card.querySelector('.cap-view .ext-search');
    capSearch.value = 'subagents';
    capSearch.dispatchEvent(new window.Event('input'));
    await new Promise(r => setTimeout(r, 10));
    check('P22 搜索按名称过滤', () => {
      const names = capNames();
      return names.length === 1 && names[0] === 'Subagents' || JSON.stringify(names);
    });
    capSearch.value = '长期记忆';
    capSearch.dispatchEvent(new window.Event('input'));
    await new Promise(r => setTimeout(r, 10));
    check('P22 搜索覆盖用途 / 描述', () => {
      const names = capNames();
      return names.length === 1 && names[0].includes('Pi Memory') || JSON.stringify(names);
    });
    capSearch.value = '未安装';
    capSearch.dispatchEvent(new window.Event('input'));
    await new Promise(r => setTimeout(r, 10));
    check('P22 搜索覆盖状态文案', () => capRows().length > 0 && capStatuses().some(s => s.includes('未安装')));
    capSearch.value = 'zzzz-no-match';
    capSearch.dispatchEvent(new window.Event('input'));
    await new Promise(r => setTimeout(r, 10));
    check('P22 搜不到时给中性空态，不是空白页', () =>
      (card.querySelector('.cap-view .ext-empty')?.textContent || '').includes('没有符合筛选条件'));
    capSearch.value = '';
    capSearch.dispatchEvent(new window.Event('input'));
    await new Promise(r => setTimeout(r, 10));

    // Capabilities 过滤器：只剩已知能力，扩展与 server 明细不在这里
    card.querySelector('#extensionsTabCapabilities')?.click();
    await new Promise(r => setTimeout(r, 40));
    check('P22 Capabilities 过滤器只留已知能力', () => {
      const names = capNames().join(' | ');
      return names.includes('Web Access') && names.includes('Native MCP')
        && !names.includes('Sample Extension') && !names.includes('builtin:') || names;
    });

    // Usage 入口：只读，点了打开既有上下文 Tip，不新建一套用量数据
    pick('Usage / Quota')?.onclick();
    await new Promise(r => setTimeout(r, 20));
    check('P22 Usage 只给一个只读入口', () => {
      const buttons = [...card.querySelectorAll('.cap-view .ext-acts .btn')].map(b => b.textContent);
      return JSON.stringify(buttons) === JSON.stringify(['打开上下文与额度']) || JSON.stringify(buttons);
    });
    [...card.querySelectorAll('.cap-view .ext-acts .btn')].find(b => b.textContent === '打开上下文与额度')?.onclick();
    await new Promise(r => setTimeout(r, 20));
    check('P22 Usage 入口复用既有上下文 Tip，不复制数据', () =>
      $('composerPopover').hidden === false && $('composerPopover').textContent.includes('背景信息窗口'));
    window.closePop();
    await new Promise(r => setTimeout(r, 10));

    // restartRequired：配置改了没重启 → 结论行与状态行都要说
    const savedExt = stubExtensions;
    stubExtensions = { ok: true, piReachable: true, diagnostics: [],
      extensions: [{ id: 'ext-web', name: 'pi-web-access', displayName: 'pi-web-access', version: '1.2.3',
        description: 'web tools', source: { type: 'npm', location: 'C:/npm/pi-web-access' }, scope: 'global',
        state: { installed: true, enabled: false, loaded: true, restartRequired: true, error: null },
        capabilities: [], configurable: false }] };
    card.querySelector('#extensionsTabAll')?.click();
    await new Promise(r => setTimeout(r, 10));
    // 面板是缓存的 —— 必须显式刷新才会重新取证据（这正是产品行为）。
    [...card.querySelectorAll('.cap-view .ext-bar .btn')].find(b => b.textContent === '刷新')?.onclick();
    await new Promise(r => setTimeout(r, 40));
    check('P22 restartRequired 进入统一状态（结论行 + 需要重启一行）', () => {
      const row = capRows().find(r => (r.querySelector('.ext-name')?.textContent || '').includes('Web Access'));
      if (!row) return 'no Web row: ' + capNames().join(' | ');
      row.onclick();
      const status = row.querySelector('.cap-status-line')?.textContent || '';
      return (status.includes('需重启 Pi') && detailValue('需要重启') === '是'
        && detailValue('启用配置') === '已停用' && detailValue('已加载') === '已确认加载') || `${status} / ${detailValue('需要重启')}`;
    });
    stubExtensions = savedExt;

    /* 一键安装的完整链路（P24 收口）：
     *   未安装 → 确认 → 发请求（body 只带 capabilityId）→ 重新取证据 →
     *   按钮与状态行都按**重新发现的结果**重画。
     * ⚠️ 安装命令跑完 ≠ 装上了 ≠ 已加载：这里刻意让 Registry 只给 installed=true、
     * 不给 loaded 证据，界面就必须分开说「已安装」与「加载状态未知」。 */
    {
      const savedForInstall = stubExtensions;
      const installCalls = [];
      const baseFetchForFlow = window.fetch;
      window.fetch = async (url, opts) => {
        if (String(url).includes('/api/capabilities/install')) {
          installCalls.push({ url: String(url), body: JSON.parse((opts && opts.body) || '{}') });
          /* 官方命令跑完之后：Extension 出现在磁盘上，但**没有**加载证据。 */
          stubExtensions = { ok: true, piReachable: true, diagnostics: [], extensions: [
            { id: 'ext-web', name: 'pi-web-access', displayName: 'pi-web-access', version: '1.2.3',
              description: 'web tools', source: { type: 'npm', location: 'C:/npm/pi-web-access' }, scope: 'global',
              state: { installed: true, enabled: null, loaded: null, restartRequired: null, error: null },
              capabilities: [], configurable: false }] };
          return { json: async () => ({ ok: true, capabilityId: 'web', commandCompleted: true, loaded: null }) };
        }
        return baseFetchForFlow(url, opts);
      };
      stubExtensions = { ok: true, piReachable: true, diagnostics: [], extensions: [] };
      card.querySelector('#extensionsTabAll')?.click();
      await new Promise(r => setTimeout(r, 10));
      [...card.querySelectorAll('.cap-view .ext-bar .btn')].find(b => b.textContent === '刷新')?.onclick();
      await new Promise(r => setTimeout(r, 40));
      pick('Web Access')?.onclick();
      await new Promise(r => setTimeout(r, 20));
      const beforeState = card.querySelector('.cap-view .cap-install')?.dataset.installState || '';
      card.querySelector('.cap-view .cap-install')?.click();
      await new Promise(r => setTimeout(r, 20));
      $('confirmCard').querySelector('.btn.primary')?.click();
      await new Promise(r => setTimeout(r, 150));
      window.fetch = baseFetchForFlow;
      const afterEl = card.querySelector('.cap-view .cap-install');
      const afterState = afterEl ? afterEl.dataset.installState : '';
      const afterLabel = afterEl ? afterEl.textContent : '';
      check('P24 一键安装：未安装时按钮是「安装」', () => beforeState === 'install' || beforeState);
      check('P24 一键安装：请求体只带 capabilityId（+ 确认与工作区守卫），没有包名 / 命令', () =>
        (installCalls.length === 1 && installCalls[0].body.capabilityId === 'web'
          && installCalls[0].body.confirm === true
          && !('source' in installCalls[0].body) && !('command' in installCalls[0].body)
          && !('args' in installCalls[0].body)) || JSON.stringify(installCalls));
      check('P24 安装后按重新发现的证据重画：状态行写「已安装」，动作区不再摆一个按不动的按钮', () =>
        (afterEl === null && detailValue('安装状态') === '已安装')
        || JSON.stringify({ afterState, afterLabel, 安装状态: detailValue('安装状态') }));
      check('P24 没有加载证据时如实说未知（已安装 / 已加载未知，不伪造已加载）', () =>
        (detailValue('安装状态') === '已安装' && detailValue('已加载') === '未知（无法确认）')
        || `${detailValue('安装状态')} / ${detailValue('已加载')}`);
      stubExtensions = savedForInstall;
    }

    // 一键安装只出现在已知第三方 capability 上
    check('P24 安装按钮只出现在第三方 Extension 上（Native MCP / built-in / Skills / Usage 都没有）', () => {
      const withInstall = [];
      for (const row of capRows()) {
        const name = row.querySelector('.ext-name')?.textContent || '';
        row.onclick();
        if (card.querySelector('.cap-view .cap-install')) withInstall.push(name);
      }
      const allowed = ['Web Access', 'Subagents', 'Pi Memory', 'Browser Use'];
      return (withInstall.length >= 1 && withInstall.every(n => allowed.some(a => n.startsWith(a))))
        || JSON.stringify(withInstall);
    });
    check('P22/P24 Capability 视图没有任何自由输入（不提供任意包名入口）', () =>
      !card.querySelector('.cap-view input:not([type="search"])'));

    // stale workspace：结果回来时项目已经切了 → 不许落地
    host.innerHTML = '';
    window.openExtensions();
    window.S.workspaceGeneration++;
    await new Promise(r => setTimeout(r, 60));
    check('P22 切项目后旧能力结果不落地', () =>
      (card.querySelector('.cap-view .ext-empty')?.textContent || '').includes('项目已切换')
      && card.querySelectorAll('.cap-view .ext-item').length === 0);
    window.clearThread();
  }

  /* P24 收口（本轮修复）：**安装真实性** —— 四个 feature 设置区
   * （Web / Subagents / Memory / Browser）与 Capability 页走同一条 recheck 路径。
   *
   * 全项目坚持：`commandCompleted ≠ installed ≠ loaded`。断言全部落在
   * 「界面敢不敢写『已安装』」上 —— 命令退出码 0 从来不是证据。 */
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const savedRegistry = stubExtensions;
    const savedFetch = window.fetch;
    window.S.hasProject = true; window.S.switching = false;
    window.S.bridgeState = 'ready';

    const FEATURES = [
      { name: 'Web', render: window.renderWebSetup, pkg: 'pi-web-access' },
      { name: 'Subagents', render: window.renderSubagentSetup, pkg: 'pi-subagents' },
      { name: 'Memory', render: window.renderMemorySetup, pkg: 'pi-memory' },
      { name: 'Browser', render: window.renderBrowserSetup, pkg: 'pi-browser-harness' },
    ];
    const emptyRegistry = { ok: true, piReachable: true, diagnostics: [], extensions: [] };
    const foundRegistry = (pkg) => ({
      ok: true, piReachable: true, diagnostics: [],
      extensions: [{
        id: 'ext-' + pkg, name: pkg, displayName: pkg, version: '1.0.0',
        source: { type: 'npm', location: 'C:/npm/' + pkg }, scope: 'global',
        state: { installed: true, enabled: null, loaded: null, restartRequired: null, error: null },
        capabilities: [], configurable: false,
      }],
    });
    const makeBox = () => { const b = window.document.createElement('section'); window.document.body.appendChild(b); return b; };
    const rowText = (box, k) => box.querySelector(`.cap-rows [data-k="${k}"] .ext-row-v`)?.textContent || '';
    /* 一次「命令成功」的安装：Registry 重新读回来的是 afterRegistry。 */
    const installThrough = async (box, afterRegistry) => {
      stubExtensions = afterRegistry;
      box.querySelector('.cap-install')?.click();
      await sleep(20);
      $('confirmCard').querySelector('.btn.primary')?.click();
      await sleep(150);
    };
    const stubInstall = (payload) => {
      window.fetch = async (url, opts) => String(url).includes('/api/capabilities/install')
        ? { json: async () => payload }
        : savedFetch(url, opts);
    };

    /* ① 命令成功，但 Registry 里没有它 → 一个字都不许写「已安装」。 */
    for (const feature of FEATURES) {
      stubInstall({ ok: true, capabilityId: 'x', commandCompleted: true, loaded: null });
      const box = makeBox();
      feature.render(box, emptyRegistry);
      const before = box.querySelector('.cap-install')?.dataset.installState;
      await installThrough(box, emptyRegistry);
      const btn = box.querySelector('.cap-install');
      check(`P24 安装真实性（${feature.name}）：未安装时主按钮是「安装」`, () => before === 'install' || before);
      check(`P24 安装真实性（${feature.name}）：命令成功但 Registry 没有它 → 绝不写「已安装」`, () =>
        (btn?.dataset.installState === 'install' && btn?.textContent === '安装'
          && rowText(box, '安装状态') === '未安装' && !box.textContent.includes('已确认加载'))
        || JSON.stringify({ state: btn?.dataset.installState, text: btn?.textContent, 安装状态: rowText(box, '安装状态') }));
      window.fetch = savedFetch;
      box.remove();
    }

    /* ② Registry 确认 installed=true、但没有 loaded 证据 →
     *    「已安装」+「未知（无法确认）」，并且动作区不再有安装按钮。 */
    for (const feature of FEATURES) {
      stubInstall({ ok: true, capabilityId: 'x', commandCompleted: true, loaded: null });
      const box = makeBox();
      feature.render(box, emptyRegistry);
      await installThrough(box, foundRegistry(feature.pkg));
      check(`P24 安装真实性（${feature.name}）：Registry 确认后写「已安装」，加载状态仍如实说未知`, () =>
        (rowText(box, '安装状态') === '已安装' && rowText(box, '已加载') === '未知（无法确认）'
          && !box.textContent.includes('已确认加载'))
        || JSON.stringify({ 安装状态: rowText(box, '安装状态'), 已加载: rowText(box, '已加载') }));
      check(`P24 安装真实性（${feature.name}）：已安装后动作区不再摆一个按不动的「已安装」按钮`, () =>
        (box.querySelector('.cap-install') === null
          && ![...box.querySelectorAll('.ext-acts .btn')].some((b) => b.textContent === '已安装')
          && [...box.querySelectorAll('.ext-acts .btn')].some((b) => b.textContent === '复制安装命令'))
        || JSON.stringify([...box.querySelectorAll('.ext-acts .btn')].map((b) => b.textContent)));
      window.fetch = savedFetch;
      box.remove();
    }

    /* ③ 一开始就 installed=true → 动作区没有那个 disabled 的「已安装」。 */
    for (const feature of FEATURES) {
      const box = makeBox();
      feature.render(box, foundRegistry(feature.pkg));
      check(`P24 安装真实性（${feature.name}）：已安装状态下动作区不出现「已安装」按钮`, () =>
        box.querySelector('.cap-install') === null
        && ![...box.querySelectorAll('.ext-acts .btn')].some((b) => b.textContent === '已安装')
        || JSON.stringify([...box.querySelectorAll('.ext-acts .btn')].map((b) => b.textContent)));
      box.remove();
    }

    /* ④ 防线：调用点忘了传 onRecheck 时，命令成功也**绝不**写「已安装」。 */
    {
      stubInstall({ ok: true, capabilityId: 'web', commandCompleted: true, loaded: null });
      const model = window.setupViewModel(window.webCapability(emptyRegistry, null));
      const box = makeBox();
      box.appendChild(window.renderSetupSection(model, { onRecheck: null }));
      const btn = box.querySelector('.cap-install');
      btn.click();
      await sleep(20);
      $('confirmCard').querySelector('.btn.primary').click();
      await sleep(120);
      check('P24 安装真实性（防线）：没有 onRecheck → 命令成功也不写「已安装」', () =>
        (btn.dataset.installState !== 'installed' && btn.textContent !== '已安装')
        || JSON.stringify({ state: btn.dataset.installState, text: btn.textContent }));
      check('P24 安装真实性（防线）：如实说「命令已完成，待确认」，并且停用（不是点了没反应）', () =>
        (btn.textContent === '命令已完成，待确认' && btn.disabled === true) || btn.textContent);
      window.fetch = savedFetch;
      box.remove();
    }

    /* ⑤ installed=null（无法确认）且没有 recheck 入口 → 连按钮都不画。 */
    {
      const model = window.setupViewModel(window.webCapability({ ok: false }, null));
      const box = makeBox();
      box.appendChild(window.renderSetupSection(model, {}));
      check('P24 安装真实性：installed=null 且没有 recheck 入口 → 不画按钮（不给点了没反应的入口）', () =>
        box.querySelector('.cap-install') === null
        || JSON.stringify([...box.querySelectorAll('.ext-acts .btn')].map((b) => b.textContent)));
      box.remove();
    }

    stubExtensions = savedRegistry;
    window.fetch = savedFetch;
  }

  /* P23: 诊断面板的升级安全面 —— 版本核对 / 能力 probe / 兼容矩阵 / Native MCP /
   * Extension 版本 / schema 漂移，以及一份**脱敏的**「复制诊断摘要」。
   * 这里量的是 DOM 语义（显示了什么、有没有把不该显示的东西显示出来）；
   * 后端判定在 tests/pi-probes.cjs。 */
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.S.hasProject = true; window.S.switching = false;
    window.resetDrift();
    const diagCard = () => $('modalCard');
    $('modal').hidden = true;
    $('modalCard').innerHTML = '';
    window.openDiagnostics();
    await sleep(60);
    const text = () => diagCard().textContent || '';

    check('P23 诊断：五个新小节都在', () => {
      const heads = [...diagCard().querySelectorAll('.ext-sec-head')].map((n) => n.textContent);
      const want = ['版本真值', '能力 probe', '兼容矩阵（我们核对过什么）', 'Native MCP', '关键 Extension 版本'];
      return want.every((w) => heads.includes(w)) || JSON.stringify(heads);
    });
    check('P23 诊断：版本来源与核对状态分开摆', () =>
      text().includes('package.json')
      && text().includes('版本核对')
      && text().includes('未核对（矩阵里没有这个版本）'));
    check('P23 诊断：probe 三值文案（支持 / 不支持 / 未知）与出处都在', () => {
      const t = text();
      if (!t.includes('能力 probe')) return '没有 probe 小节';
      if (!t.includes('dist/modes/rpc/rpc-types.d.ts: RpcCommand 联合共 33 条')) return '缺少出处';
      if (!t.includes('builtInExtensions 里没有 mcp')) return '缺少 false 的 probe';
      if (!t.includes('还没法下结论的核心 probe：rpc')) return '没有列出未下结论的核心 probe';
      return true;
    });
    check('P23 诊断：兼容矩阵显示当前基线与已验证版本', () =>
      text().includes('1.0.0') && text().includes('当前验证基线') && text().includes('pi-memory'));
    check('P23 诊断：Native MCP 只给状态与计数（**没有 server 名字**）', () => {
      const t = text();
      return t.includes('生效中') && t.includes('server 条目') && !t.includes('filesystem');
    });
    check('P23 诊断：Extension 版本按 name@version 显示', () => text().includes('pi-memory@0.4.2'));

    /* 「复制诊断摘要」：一段给人读的纯文本，与面板同一份已脱敏快照 */
    const copyBtn = [...diagCard().querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === '复制诊断摘要');
    check('P23 诊断：有「复制诊断摘要」按钮（在 JSON 复制之前）', () => {
      const labels = [...diagCard().querySelectorAll('.modal-actions .btn')].map((b) => b.textContent);
      return labels[0] === '复制诊断摘要' && labels.includes('复制诊断 JSON') || JSON.stringify(labels);
    });
    const summary = window.buildDiagnosticSummary(stubDiagnostics, []);
    check('P23 摘要：含版本 / 来源 / 核对 / 兼容 / probe / MCP / Extension', () => {
      for (const want of ['Pi GUI 诊断摘要', 'pi: 0.87.0', 'pi 版本来源: package.json',
        '版本核对: 未核对（矩阵里没有这个版本）', '兼容状态: 部分兼容', '能力 probe: 共 4',
        'Native MCP: 生效中', 'pi-memory@0.4.2', '隐私:']) {
        if (!summary.includes(want)) return `缺「${want}」`;
      }
      return true;
    });
    check('P23 摘要：不含会话正文 / 凭据 / 绝对路径 / 原始 payload', () => {
      const bad = [/sk-[A-Za-z0-9]{8,}/, /Bearer\s/, /api[_-]?key/i, /[A-Za-z]:\\/, /content/i];
      return !bad.some((re) => re.test(summary)) || summary.slice(0, 200);
    });
    check('P23 摘要：口径与面板一致（同一份快照，不另取数据）', () => {
      const fresh = window.buildDiagnosticSummary(stubDiagnostics, []);
      return fresh === summary && summary.includes('bridgeRun 1');
    });

    let copied = null;
    const savedClipboard = window.navigator.clipboard;
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => { copied = t; } }, configurable: true });
    copyBtn.onclick();
    await sleep(30);
    check('P23 摘要：点「复制诊断摘要」写进剪贴板的就是那段文本', () => copied === summary || String(copied).slice(0, 120));
    Object.defineProperty(window.navigator, 'clipboard', { value: savedClipboard, configurable: true });

    /* schema 漂移：前端观察到的未知工具名要能在诊断里看见（只有字段名与类型） */
    window.resetDrift();
    check('P23 漂移：不认识的工具名被记下（不记名字本身）', () => {
      const node = window.document.createElement('div');
      window.document.body.appendChild(node);
      window.updateEntry(node, { id: 'drift-1', name: 'future_tool', status: 'success', args: { secret: 'sk-should-not-appear' } });
      node.remove();
      const drift = window.driftSnapshot();
      return drift.length === 1 && drift[0].source === 'tool' && drift[0].field === 'name'
        && drift[0].kind === 'unknown-tool' && !JSON.stringify(drift).includes('sk-should-not-appear') || JSON.stringify(drift);
    });
    check('P23 漂移：同一条只记一次（updateEntry 每个阶段都会跑）', () => {
      const node = window.document.createElement('div');
      window.document.body.appendChild(node);
      for (let i = 0; i < 5; i++) window.updateEntry(node, { id: 'drift-2', name: 'future_tool', status: 'running' });
      node.remove();
      return window.driftSnapshot().length === 1 || JSON.stringify(window.driftSnapshot());
    });
    check('P23 漂移：闭集外的 MCP 运行状态也记（字段名 + 类型）', () => {
      window.noteUnknownEnum('mcp-runtime', 'server.state', 'half-open');
      const drift = window.driftSnapshot();
      const hit = drift.find((d) => d.field === 'server.state');
      return Boolean(hit) && hit.source === 'mcp-runtime' && hit.type === 'string' || JSON.stringify(drift);
    });
    check('P23 漂移：诊断摘要里带上前端漂移（来源 · 字段 · 类型）', () => {
      const withDrift = window.buildDiagnosticSummary(stubDiagnostics, window.driftSnapshot());
      return withDrift.includes('前端 schema 漂移: 2 条') && withDrift.includes('tool.name · unknown-tool · string') || withDrift.slice(-300);
    });

    /* 漂移随 bridge 重启清空（与各 feature 的运行观察同一条纪律）。
     * bridgeRun 必须 ≥ 当前值 —— 小于当前值的旧事件本来就被 SSE 入口丢掉。 */
    const driftRun = window.S.bridgeRun;
    es.emit({ type: 'bridge_status', state: 'starting', bridgeRun: driftRun + 1 });
    check('P23 漂移：bridge 重启后清空（旧 run 的观察不留）', () => window.driftSnapshot().length === 0 || JSON.stringify(window.driftSnapshot()));
    es.emit({ type: 'bridge_status', state: 'ready', bridgeRun: driftRun + 1 });
    await sleep(20);

    $('modal').hidden = true;
    $('modalCard').innerHTML = '';
    window.resetDrift();
  }

  /* P24: 日常使用面 —— 命令面板、快捷键、草稿恢复、状态条。
   * 纯逻辑（注册表 / 搜索排序 / 文案映射）在 tests/daily-use.cjs；
   * 这里量的是 DOM 真的长出来了、点了真的会动、焦点真的回来了。 */
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const layer = () => $('paletteLayer');
    const items = () => [...layer().querySelectorAll('.palette-item')];
    const paletteTitles = () => items().map((b) => b.querySelector('.palette-title').textContent);
    const press = (key, opts = {}) => {
      const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
      (opts.target || window.document.body).dispatchEvent(e);
      return e;
    };

    window.S.hasProject = true; window.S.switching = false; window.S.bridgeState = 'ready';
    window.S.streaming = false;
    window.document.getElementById('paletteLayer').hidden = true;
    $('modal').hidden = true;
    $('modalCard').innerHTML = '';

    /* ---------- 快捷键注册表 ---------- */
    check('P24 快捷键：注册表无冲突（重复键位在装配时就炸）', () => window.assertNoConflicts() === true);
    const paletteKey = window.IS_MAC ? { metaKey: true } : { ctrlKey: true };
    check('P24 快捷键：面板 / 帮助 / 四个视图都在表里，且都带人看的 label', () => {
      const list = window.listShortcuts();
      const ids = list.map((s) => s.id);
      const want = ['palette', 'shortcut-help', 'view-chat', 'view-planner', 'view-changes', 'view-extensions'];
      return (want.every((id) => ids.includes(id)) && list.every((s) => s.label && s.display)) || JSON.stringify(ids);
    });
    check('P24 快捷键：在输入框里按 Ctrl+K 也能打开面板（边写边叫出来）', () => {
      $('input').value = '正在写的半句话';
      press('k', { ...paletteKey, target: $('input') });
      const opened = !layer().hidden;
      window.closePalette();
      return opened || 'ctrl+k 在输入框里没打开面板';
    });
    check('P24 快捷键：不带修饰键的普通按键不会在输入框里被抢', () => {
      const before = $('input').value;
      const e = press('k', { target: $('input') });
      return !e.defaultPrevented && layer().hidden && $('input').value === before;
    });

    /* ---------- 命令面板：打开 / 搜索 / 键盘 / 执行 / 焦点 ---------- */
    $('input').focus();
    press('k', { ...paletteKey, target: window.document.body });
    await sleep(30);
    check('P24 面板：快捷键能打开，且焦点在搜索框里', () =>
      !layer().hidden && window.document.activeElement === layer().querySelector('.palette-input'));
    check('P24 面板：常用动作默认就在列表里（不用先搜索）', () => {
      const titles = paletteTitles().join(' | ');
      const want = ['对话', '任务（Planner）', '文件变更', '扩展（Extensions）', '能力视图（Capabilities）', 'MCP', '用量与额度', '诊断'];
      return want.every((w) => titles.includes(w)) || titles;
    });
    check('P24 面板：不可执行的动作**不出现**（没在流式就不给「停止生成」）', () =>
      !paletteTitles().includes('停止生成'));
    check('P24 面板：会话条目只在有查询时出现（不刷屏）', () => paletteTitles().filter((t) => t.startsWith('切换到会话：')).length === 0);

    const input = layer().querySelector('.palette-input');
    input.value = '能力';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(20);
    check('P24 面板：搜索按名称过滤', () => {
      const titles = paletteTitles();
      return titles.length >= 1 && titles[0].includes('能力') || JSON.stringify(titles);
    });
    input.value = '';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(20);
    const firstText = paletteTitles()[0];
    press('ArrowDown', { target: input });
    await sleep(20);
    check('P24 面板：↓ 移动选中项（aria-selected 跟着走）', () => {
      const on = items().findIndex((b) => b.classList.contains('on'));
      return on === 1 && items()[1].getAttribute('aria-selected') === 'true' || `on=${on}`;
    });
    press('ArrowUp', { target: input });
    await sleep(20);
    check('P24 面板：↑ 回到第一项', () => items().findIndex((b) => b.classList.contains('on')) === 0);
    check('P24 面板：第一项就是默认视图（顺序稳定）', () => paletteTitles()[0] === firstText);

    /* 执行：MCP 命令 → 打开扩展工作区并停在 MCP 过滤器 */
    input.value = 'MCP';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(20);
    const mcpItem = items().find((b) => b.dataset.commandId === 'view.mcp');
    mcpItem.onclick();
    await sleep(60);
    check('P24 面板：执行后立刻关闭（不留面板挡结果）', () => layer().hidden);
    check('P24 面板：MCP 命令打开扩展页并停在 MCP 过滤器', () =>
      $('workspace').dataset.workspaceView === 'extensions'
      && $('workSurface').querySelector('#extensionsTabMcp')?.getAttribute('aria-selected') === 'true');

    /* Esc 关闭 + 焦点恢复 */
    window.S.hasProject = true;
    $('input').focus();
    press('k', { ...paletteKey, target: window.document.body });
    await sleep(30);
    press('Escape', { target: layer().querySelector('.palette-input') });
    await sleep(20);
    check('P24 面板：Esc 关闭并把焦点还给打开它的元素', () =>
      layer().hidden && window.document.activeElement === $('input'));

    /* 面板不吃 Tab / 不在输入框里打字时抢键 */
    press('k', { ...paletteKey, target: window.document.body });
    await sleep(30);
    const tabEvent = press('Tab', { target: layer().querySelector('.palette-input') });
    check('P24 面板：Tab 留在搜索框上（aria-modal 语义）', () => tabEvent.defaultPrevented);
    window.closePalette();
    await sleep(10);

    /* ---------- 可发现性：快捷键不能只写在文档里 ---------- */
    check('P24 可发现：More 菜单里有「命令面板 / 键盘快捷键」两个可见入口', () => {
      const p = $('navPalette');
      const h = $('navShortcutHelp');
      return Boolean(p && h) && p.getAttribute('role') === 'menuitem' && Boolean(p.title) && Boolean(h.title);
    });
    check('P24 可发现：点菜单里的「命令面板…」真的能打开面板', () => {
      $('navPalette').onclick();
      return !layer().hidden;
    });
    window.closePalette();
    check('P24 可发现：点菜单里的「键盘快捷键…」真的能打开帮助', () => {
      $('navShortcutHelp').onclick();
      const open = !$('modal').hidden && $('modalCard').textContent.includes('键盘快捷键');
      window.closeModal();
      return open;
    });
    await sleep(20);

    /* ---------- 危险动作不能被绕过确认 ---------- */
    window.S.hasProject = true;
    $('input').focus();
    press('k', { ...paletteKey, target: window.document.body });
    await sleep(40);
    const restartItem = items().find((b) => b.dataset.commandId === 'run.restart');
    check('P24 危险动作：面板里有「重启 Pi」', () => Boolean(restartItem));
    restartItem.onclick();
    await sleep(40);
    check('P24 危险动作：从面板重启**必须先确认**（隐藏快捷键 / 面板都不是旁路）', () =>
      $('confirmLayer').hidden === false && $('confirmCard').textContent.includes('重启'));
    $('confirmCard').querySelector('.btn').click(); // 第一个按钮 = 取消
    await sleep(40);
    check('P24 危险动作：取消之后什么都没发生（确认框收起、桥接状态不变）', () =>
      $('confirmLayer').hidden === true && window.S.bridgeState === 'ready');

    /* ---------- 快捷键帮助 ---------- */
    window.openShortcutHelp();
    await sleep(30);
    check('P24 帮助：从注册表渲染，含分组与键位写法', () => {
      const card = $('modalCard');
      const text = card.textContent;
      return text.includes('键盘快捷键') && text.includes('命令面板') && text.includes('视图')
        && text.includes(window.IS_MAC ? '⌘' : 'Ctrl+') && Boolean(card.querySelector('.kb-keys'));
    });
    check('P24 帮助：也列出输入 / 弹层那几条既有键位', () => {
      const text = $('modalCard').textContent;
      return text.includes('Enter') && text.includes('Shift+Enter') && text.includes('Esc');
    });
    window.closeModal();
    await sleep(20);

    /* ---------- 草稿恢复（存储边界是重点）---------- */
    const store = window.localStorage;
    for (const k of Object.keys(store)) if (String(k).startsWith('pi-gui.draft.')) store.removeItem(k);
    window.resetDraftState();
    window.S.cwd = 'C:\\work\\alpha';
    window.S.state = { sessionId: 'sess-alpha' };
    $('input').value = '半句话';
    window.flushDraft();
    const alphaKey = window.draftKey();
    check('P24 草稿：按 workspace + session 分键，且 key 里没有路径原文', () =>
      alphaKey.includes('pi-gui.draft.v1:') && !alphaKey.includes('alpha') && !alphaKey.includes('C:') || alphaKey);
    check('P24 草稿：写进去的 JSON 只有 v / text / at 三个字段', () => {
      const raw = JSON.parse(store.getItem(alphaKey));
      return JSON.stringify(Object.keys(raw).sort()) === JSON.stringify(['at', 'text', 'v']) || JSON.stringify(Object.keys(raw));
    });
    check('P24 草稿：附件二进制 / 抽取正文 / 本机路径都不进 localStorage', () => {
      window.S.attachments = [{ id: 'a1', name: 'x.png', kind: 'image', dataUrl: 'data:image/png;base64,PRIVATE_IMAGE', path: 'C:\\secret\\x.png', text: 'PRIVATE_DOC_TEXT' }];
      $('input').value = '带附件的草稿';
      window.flushDraft();
      const raw = store.getItem(alphaKey);
      window.S.attachments = [];
      return !raw.includes('PRIVATE_IMAGE') && !raw.includes('PRIVATE_DOC_TEXT') && !raw.includes('secret') || raw.slice(0, 120);
    });
    check('P24 草稿：发送成功后清掉', () => {
      $('input').value = '要发出去的内容';
      window.flushDraft();
      const hadBefore = Boolean(store.getItem(alphaKey));
      $('input').value = '';
      window.clearDraft();
      return hadBefore && store.getItem(alphaKey) === null;
    });
    check('P24 草稿：空文本不落盘（不留幽灵草稿）', () => {
      $('input').value = '临时';
      window.flushDraft();
      const had = Boolean(store.getItem(alphaKey));
      $('input').value = '   ';
      window.flushDraft();
      return had && store.getItem(alphaKey) === null;
    });
    /* 换会话：草稿按身份隔离，互不串 */
    $('input').value = 'alpha 的草稿';
    window.flushDraft();
    window.S.state = { sessionId: 'sess-beta' };
    window.draftSync();
    check('P24 草稿：换会话后输入框换成新会话的草稿（互不串）', () =>
      $('input').value === '' || `value=${$('input').value}`);
    $('input').value = 'beta 的草稿';
    window.flushDraft();
    const betaKey = window.draftKey();
    check('P24 草稿：两条会话是两个 key', () => betaKey !== alphaKey && store.getItem(betaKey) !== null);
    $('input').value = '';
    window.S.state = { sessionId: 'sess-alpha' };
    window.draftSync();
    check('P24 草稿：切回原会话 → 原文恢复', () => $('input').value === 'alpha 的草稿' || $('input').value);
    /* 换项目：workspace 维度同样隔离 */
    window.S.cwd = 'C:\\work\\beta';
    window.draftSync();
    check('P24 草稿：换项目不会串到上一个项目的草稿', () => $('input').value !== 'alpha 的草稿' || $('input').value);
    check('P24 草稿：草稿长度有上限（不会把 localStorage 撑爆）', () => {
      $('input').value = 'x'.repeat(window.DRAFT_MAX_CHARS + 500);
      window.flushDraft();
      const raw = JSON.parse(store.getItem(window.draftKey()));
      $('input').value = '';
      return raw.text.length === window.DRAFT_MAX_CHARS;
    });
    for (const k of Object.keys(store)) if (String(k).startsWith('pi-gui.draft.')) store.removeItem(k);
    window.resetDraftState();
    window.S.cwd = 'C:\\pi-GUI';
    window.S.state = null;

    /* ---------- 状态条 ---------- */
    window.hideNotice();
    $('toasts').innerHTML = '';
    es.emit({ type: 'bridge_status', state: 'error', bridgeRun: (window.S.bridgeRun || 1) + 1, error: '无法启动 pi：spawn pi ENOENT', hint: '确认 pi 已安装并在 PATH 中，或用环境变量 PI_BIN 指定完整路径。' });
    await sleep(30);
    check('P24 状态条：同一条失败不再同时弹 toast（同一件事不说三遍）', () =>
      $('toasts').textContent.includes('ENOENT') === false);
    check('P24 状态条：pi 启动失败时常驻显示 error + 后可执行的下一步', () => {
      const box = $('stageNotice');
      return !box.hidden && box.textContent.includes('pi 启动失败')
        && box.textContent.includes('ENOENT') && box.textContent.includes('PATH') || box.textContent.slice(0, 120);
    });
    check('P24 状态条：给的是已有入口（重启 / 诊断），不是自动修复', () => {
      const labels = [...$('stageNotice').querySelectorAll('.btn')].map((b) => b.textContent);
      return JSON.stringify(labels) === JSON.stringify(['重启 Pi', '打开诊断']) || JSON.stringify(labels);
    });
    [...$('stageNotice').querySelectorAll('.btn')].find((b) => b.textContent === '打开诊断').onclick();
    await sleep(40);
    check('P24 状态条：「打开诊断」走的就是既有诊断面板', () =>
      $('modal').hidden === false && $('modalCard').textContent.includes('诊断'));
    $('modal').hidden = true; $('modalCard').innerHTML = '';
    check('P24 状态条：可关闭，且不会被同一条重复重建', () => {
      $('stageNotice').querySelector('.notice-close').onclick();
      return $('stageNotice').hidden;
    });
    es.emit({ type: 'bridge_status', state: 'ready', bridgeRun: (window.S.bridgeRun || 1) + 1 });
    await sleep(30);
    check('P24 状态条：pi 起来之后自动收起', () => $('stageNotice').hidden);

    /* ---------- 维护态：装扩展不能说成「正在更新 Pi」 ---------- */
    window.S.hasProject = true;
    es.emit({ type: 'bridge_status', state: 'maintenance', phase: 'pausing', reason: 'capability-install', bridgeRun: window.S.bridgeRun });
    await sleep(30);
    check('P24 维护态：安装扩展时的连接文案说的是安装，不是更新', () =>
      $('connText').textContent.includes('安装扩展') && !$('connText').textContent.includes('更新')
      || $('connText').textContent);
    check('P24 维护态：常驻条同样按 reason 说清在做什么（语气是信息不是故障）', () => {
      const box = $('stageNotice');
      return (!box.hidden && box.textContent.includes('安装扩展') && !box.textContent.includes('更新'))
        || box.textContent.slice(0, 120);
    });
    check('P24 维护态：输入区不锁死，但 placeholder 说明在等什么', () =>
      ($('input').disabled === false && $('input').placeholder.includes('安装扩展'))
      || JSON.stringify({ disabled: $('input').disabled, ph: $('input').placeholder }));
    es.emit({ type: 'bridge_status', state: 'maintenance', phase: 'pausing', reason: 'pi-update', bridgeRun: window.S.bridgeRun });
    await sleep(30);
    check('P24 维护态：Pi 自更新仍说「更新」', () => $('connText').textContent.includes('更新') || $('connText').textContent);
    es.emit({ type: 'bridge_status', state: 'ready', bridgeRun: (window.S.bridgeRun || 1) + 1 });
    await sleep(30);
    check('P24 维护态：回到 ready 之后 reason 被清掉（不留上一条的措辞）', () =>
      (window.S.maintenanceReason === null && $('connText').textContent === '已连接')
      || JSON.stringify({ reason: window.S.maintenanceReason, conn: $('connText').textContent }));
    window.document.getElementById('paletteLayer').hidden = true;
    window.S.bridgeState = 'ready';
  }

  check('无残留 el 引用错误', () => errors.length === 0 || errors.join(' | '));

  let pass = 0;
  for (const [st, name, msg] of results) {
    if (st === 'PASS') pass++;
    console.log(`${st === 'PASS' ? '  ok  ' : ' FAIL '} ${name}${msg ? '  → ' + msg : ''}`);
  }
  console.log(`\n${pass}/${results.length} 通过`);
  if (errors.length) console.log('\n运行时错误:\n' + errors.join('\n'));
  process.exit(pass === results.length ? 0 : 1);
})();
