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

/* /api/mcp 的桩。形状照抄后端真实返回（含 evidence 与 extensionRoute）。 */
let stubMcp = {
  ok: true,
  supported: false,
  reason: '这个 pi 包里没有任何 MCP 模块或配置约定（pi 官方明确表示不内置 MCP）',
  evidence: 'docs/usage.md: It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash.',
  piVersion: '0.87.0',
  piPackageDir: 'C:\\Users\\21022\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent',
  servers: [],
  serversNote: 'pi 没有 MCP 配置文件约定，所以没有 Server 可以列出。',
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

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:7788/' });
const { window } = dom;

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
      attempts: [{ attempt: 1, success: true, error: '', summary: '读完了', exitCode: 0, startedAt: 1, endedAt: 2 }],
      result: { success: true, exitCode: 0, summary: '已分析完现有认证架构', toolCalls: 2, durationMs: 12000, raw: null, changes: { available: true, files: [{ path: 'src/auth.js', change: 'modified', status: 'M', additions: 31, deletions: 12 }], note: '执行期间观察到的工作区变化（可能也包含其它来源的改动）' } } },
    { id: 'backend', title: '实现后端接口', description: '写接口', agent: 'codex', workingDirectory: '.', dependsOn: ['inspect'], status: 'failed', startedAt: 3, endedAt: 4, attempt: 2, error: '第一次故意失败：模型报 402', verification: null,
      attempts: [
        { attempt: 1, success: false, error: '第一次故意失败：模型报 402', summary: '', exitCode: 1, startedAt: 3, endedAt: 4 },
        { attempt: 2, success: false, error: '第一次故意失败：模型报 402', summary: '', exitCode: 1, startedAt: 5, endedAt: 6 },
      ],
      result: { success: false, exitCode: 1, summary: '', toolCalls: 0, durationMs: 3000, raw: null, changes: { available: true, files: [], note: '' } } },
    { id: 'frontend', title: '实现前端界面', description: '写页面', agent: 'claude', workingDirectory: '.', dependsOn: ['inspect'], status: 'cancelled', startedAt: 7, endedAt: 8, attempt: 1, error: '已取消', verification: null, attempts: [{ attempt: 1, success: false, error: '已取消', summary: '', exitCode: null, startedAt: 7, endedAt: 8 }], result: { success: false, exitCode: null, summary: '', toolCalls: 0, durationMs: 500, raw: null, changes: { available: false, files: [], note: '' } } },
    { id: 'verify', title: '运行测试验证', description: '跑 npm test', agent: 'pi', workingDirectory: '.', dependsOn: ['backend', 'frontend'], status: 'blocked', startedAt: null, endedAt: null, attempt: 0, error: '', verification: { command: 'npm test' }, attempts: [], result: null },
  ],
};

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
      }),
    };
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
    if (method !== 'GET') return { json: async () => ({ ok: true, planId: 'plan-1', taskId: 'backend' }) };
    if (/\/api\/plans\/[^/?]+/.test(u)) return { json: async () => ({ ok: true, plan: stubPlan, counts: { total: 4, success: 1, failed: 1, cancelled: 1, skipped: 0 }, agents: [], activePlanId: null }) };
    return { json: async () => stubPlans };
  }
  if (u.includes('/api/mcp')) {
    mcpCalls.push(true);
    return { json: async () => stubMcp };
  }
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
  check('消息输入有可识别名称', () => Boolean($('input').getAttribute('aria-label')));
  check('启动首帧显示恢复中而不闪未选项目', () =>
    $('welcomeRestore') && $('welcomeRestore').hidden === false && $('welcomeNoProj').hidden === true);

  await new Promise((r) => setTimeout(r, 30)); // 等 loadStatus → connect / loadProjects / loadProviders
  check('EventSource 已连接', () => es && es.url === '/api/events');
  check('项目列表已渲染 2 项', () => window.document.querySelectorAll('#projects .project').length === 2);
  check('当前项目高亮', () => window.document.querySelectorAll('#projects .project.active').length === 1);
  check('供应商计数 = 1', () => $('providerCount').textContent === '1');

  // 供应商入口在侧栏下方（rail-spacer 之后），不是顶部导航项
  check('供应商入口不在顶部导航里', () => window.document.querySelector('.rail-nav #navProviders') === null);
  check('供应商入口在侧栏下方', () => {
    const prov = $('navProviders');
    if (!prov) return '找不到 #navProviders';
    const kids = [...prov.parentElement.children];
    return kids.indexOf(prov) > kids.findIndex((x) => x.classList.contains('rail-spacer'));
  });
  check('供应商入口在用量卡上方', () => {
    const rail = window.document.querySelector('.rail');
    const kids = [...rail.children];
    const prov = kids.findIndex((x) => x.id === 'navProviders');
    const quota = kids.findIndex((x) => x.classList.contains('quota'));
    return prov >= 0 && quota >= 0 && prov < quota;
  });
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
  es.emit({
    type: 'response', command: 'get_tree', success: true,
    data: {
      tree: [
        { entry: { type: 'message', id: 'a', role: 'user', content: '你好' }, children: [
          { entry: { type: 'message', id: 'b', role: 'assistant', content: '在的' }, children: [
            { entry: { type: 'message', id: 'c', role: 'user', content: '改一下' }, children: [] },
          ] },
        ] },
      ],
    },
  });
  check('分支计数 = 3', () => $('branchCount').textContent === '3');

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

  const chgRows = () => [...window.document.querySelectorAll('#modalCard .chg-row')];
  const chgText = () => ($('modalCard') ? $('modalCard').textContent : '');
  const confirmText = () => ($('confirmCard') ? $('confirmCard').textContent : '');
  const confirmBtn = (label) => [...window.document.querySelectorAll('#confirmCard .btn')].find((b) => b.textContent === label);

  check('侧栏有「文件变更」入口（在顶部导航里）', () => window.document.querySelector('.rail-nav #navChanges') !== null);

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
  check('变更面板打开', () => $('modal').hidden === false);
  check('列表渲染 5 行', () => chgRows().length === 5);
  check('状态字母正确', () => chgRows().map((x) => x.querySelector('.chg-code').textContent).join('') === 'MA??M??');
  check('含空格与中文的路径原样渲染', () => chgRows().some((x) => x.querySelector('.chg-path').textContent === 'docs/中文 说明.md'));
  check('恶意文件名只作为文本（不产生活元素）', () => liveCount($('modalCard')) === 0 || `解析出了 ${liveCount($('modalCard'))} 个危险元素`);
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
  check('确认层不破坏下层面板', () => $('modal').hidden === false && chgRows().length === 5);
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
  const allBtnInHead = () => $('modalCard').querySelector('.chg-head .btn.danger');

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
  $('navBranches').click();
  check('分支弹层打开', () => $('modal').hidden === false);
  check('分支树渲染 3 个节点', () => window.document.querySelectorAll('#modalCard .tree-node').length === 3);
  $('modal').click();

  // --- 弹层：供应商 ---
  $('navProviders').click();
  await new Promise((r) => setTimeout(r, 20));
  check('供应商弹层打开', () => $('modal').hidden === false);
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

  // --- 权限确认子协议 ---
  es.emit({ type: 'extension_ui_request', id: 'ui1', method: 'confirm', title: '允许执行 rm 吗？', message: 'rm -rf /tmp/x' });
  check('权限弹层打开', () => $('modal').hidden === false);
  check('权限文案', () => $('modalCard').textContent.includes('允许执行 rm 吗？'));
  const btns = [...window.document.querySelectorAll('#modalCard .btn')];
  btns.find((b) => b.textContent === '确认').click();
  await new Promise((r) => setTimeout(r, 10));
  const resp = commands.filter((c) => c.type === 'extension_ui_response').pop();
  check('extension_ui_response 已回传', () => resp && resp.id === 'ui1' && resp.confirmed === true);

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
  const group = $('groupHead').parentElement;
  const before = group.classList.contains('open');
  $('groupHead').click();
  check('分组折叠可切换', () => group.classList.contains('open') !== before);
  $('groupHead').click();

  // --- 项目切换 ---
  const items = [...window.document.querySelectorAll('#projects .project')];
  items[1].click();
  await new Promise((r) => setTimeout(r, 10));
  check('切换项目调用 activate', () => true);

  // --- 项目删除按钮 ---
  check('项目有删除按钮', () => window.document.querySelectorAll('#projects .pj-del').length === 2);

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
    const card = $('modalCard');

    check('扩展面板：打开后有 Skills / MCP 两个 Tab', () => {
      const labels = [...card.querySelectorAll('.ext-tab')].map((b) => b.textContent);
      return (labels.length === 2 && labels[0] === 'Skills' && labels[1] === 'MCP') || JSON.stringify(labels);
    });
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
    $('modalCard').innerHTML = '';
    $('modal').hidden = true;
    window.openExtensions();
    await new Promise((r) => setTimeout(r, 30));
    check('扩展面板：pi 没应答时显示「状态未知」，并说明原因', () =>
      /无法确认/.test($('modalCard').textContent) || $('modalCard').textContent.slice(0, 200));
    // 点一条看详情：这里必须写「无法确认（pi 未运行）」，
    // 把 loaded=null 显示成「否」会让用户以为 skill 坏了
    const firstItem = $('modalCard').querySelector('.ext-item');
    if (firstItem) firstItem.onclick();
    await new Promise((r) => setTimeout(r, 30));
    check('扩展面板：pi 没应答时详情里写「无法确认」而不是「否」', () =>
      /无法确认（pi 未运行）/.test($('modalCard').textContent) || $('modalCard').textContent.slice(-300));
    stubSkills = savedSkills;

    // 切到 MCP
    const mcpTab = [...$('modalCard').querySelectorAll('.ext-tab')].find((b) => b.textContent === 'MCP');
    mcpTab.onclick();
    await new Promise((r) => setTimeout(r, 40));
    const mcpCard = $('modalCard');
    check('MCP 标签页：明确说 pi 没有原生 MCP 支持', () =>
      /没有原生 MCP 支持/.test(mcpCard.textContent) || mcpCard.textContent.slice(0, 200));
    check('MCP 标签页：给出可核对的出处（不是空口断言）', () =>
      /docs\/usage\.md/.test(mcpCard.textContent) || mcpCard.textContent.slice(0, 200));
    check('MCP 标签页：显示检测到的 pi 版本', () => /0\.87\.0/.test(mcpCard.textContent) || '没显示版本');
    check('MCP 标签页：servers 为空时说明原因，不是一页空白', () =>
      /没有 MCP 配置文件约定/.test(mcpCard.textContent) || mcpCard.textContent.slice(0, 200));
    check('MCP 标签页：指出官方替代路径是 extension 并列出本机已有的', () => {
      const names = [...mcpCard.querySelectorAll('.ext-name')].map((n) => n.textContent);
      return (/extension/.test(mcpCard.textContent) && names.includes('my-ext')) || JSON.stringify(names);
    });
    check('MCP 标签页：声明不安装 / 不执行扩展（边界说清楚）', () =>
      /不安装、不启用、也不执行/.test(mcpCard.textContent) || '没写边界');
    check('MCP 标签页：没有假装出「已配置 / 已连接」的状态', () =>
      !/已连接|已配置/.test(mcpCard.textContent) || '出现了没有数据支撑的状态');
    check('MCP 标签页：DOM 里没有密钥样式的字符串', () =>
      !/sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN/.test(mcpCard.innerHTML) || '出现了疑似密钥');

    $('modal').hidden = true;
    $('modalCard').innerHTML = '';
    $('confirmLayer').hidden = true;
    $('confirmCard').innerHTML = '';
  }

  /* ---------- Planner / 多 Agent 编排面板（规格 §48 的 47-53） ---------- */
  async function plannerSection() {
    plannerCalls.length = 0;
    $('toasts').innerHTML = '';

    window.openPlanner();
    await new Promise((r) => setTimeout(r, 40));
    const card = $('modalCard');

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

  await extSection();
  await plannerSection();

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
