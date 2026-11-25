/* 视觉核对用的独立夹具服务。
 *
 * 为什么需要它：jsdom 不做布局（getBoundingClientRect 恒为 0），
 * 而真实会话里塞测试消息会污染用户的对话、还要花 token。
 * 所以这里起一个自己的服务，静态托管 public/，把 /api/* 全部换成脚本数据，
 * 并推一段固定的对话事件流 —— 页面代码一行都不用改，渲染路径却是真的。
 *
 * 用法：node tests/visual-harness.cjs   然后打开 http://127.0.0.1:7789/
 * 只用于开发期，不属于产品代码。 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/* 规范化成绝对路径：UI4_ASSETS_ROOT 从环境变量进来时可能是正斜杠，
 * 而 path.join 产出反斜杠；下面的 startsWith 包含检查会因此恒假。
 * 默认值本来就是绝对路径，不受影响。 */
const PUB = path.resolve(process.env.VISUAL_PUBLIC_ROOT || path.join(__dirname, '..', 'public'));
const UPLOAD_DIR = process.env.VISUAL_UPLOAD_DIR || path.join(__dirname, '..', '.uploads');
const PORT = Number(process.env.HARNESS_PORT || 7789);
const uxMode = process.env.UX_STATE_HARNESS === '1';
/* 文件引用截图专用：真实 createFiles + os.tmpdir() 里两个工作区。 */
const fileLinksMode = process.env.FILE_LINKS_HARNESS === '1';
const fileLinkWorld = fileLinksMode ? require('./file-links-fixture.cjs').createFileLinksWorld() : null;
const fileLinkFiles = fileLinksMode ? import('../server/files.js').then(({ createFiles }) => createFiles({
  scopeForRequest: async (req) => {
    const id = req.headers?.['x-pi-gui-conversation'];
    const scope = (root, name) => ({ root, scopeId: name, generation: '1' });
    if (id === 'fixture-b') return scope(fileLinkWorld.rootB, 'fixture-b');
    if (!id || id === 'fixture-a') return scope(fileLinkWorld.rootA, 'fixture-a');
    return null;
  },
})) : null;
/* ui4-pane matrix evidence: the harness cwd IS a writable temp world, so the
 * real createFiles implementation can serve it directly. This gives the Files
 * surface a truthful tree/metadata/content path without a second fixture. */
const ui4FilesMode = process.env.UI4_FILES_HARNESS === '1';
const ui4Files = ui4FilesMode ? import('../server/files.js').then(({ createFiles }) => createFiles({
  scopeForRequest: async () => ({ root: process.cwd(), scopeId: 'ui4-pane', generation: '1' }),
})) : null;
/* 视觉取证专用：让 Registry 源返回一条“系统代理线路”的固定结果，
 * 用来截取代理状态说明；不影响默认离线夹具。 */
const marketProxyMode = process.env.MCP_MARKET_PROXY === '1';
const marketStaleMode = process.env.MCP_MARKET_STALE === '1';
/* 视觉取证专用：用 209 条固定条目模拟完整 Registry 目录，按真实后端的
 * page / pageSize 语义切片，用于截取分页导航的排版。 */
const marketPaginationMode = process.env.MCP_MARKET_PAGINATION === '1';
const marketProgressMode = process.env.MCP_MARKET_PROGRESS === '1';
/* 边加载边显示的夹具：第一次 partial 请求返回快照，之后模拟完整目录到手。 */
let marketPartialServed = false;
let uxSwitchCount = 0;
const uxWarnings = [
  { type: 'extension_ui_request', method: 'notify', notifyType: 'warning', message: 'memory_search requires qmd historical warning', _replay: true },
  { type: 'extension_error', error: 'historical extension error', _replay: true },
  { type: 'response', command: 'fixture_failure', success: false, error: 'historical tool error', _replay: true },
];
const uxHistory = [
  { role: 'user', content: '历史警告验收会话 A' },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'ux-memory', name: 'memory_search', arguments: { query: 'fixture' } }] },
  { role: 'toolResult', toolCallId: 'ux-memory', toolName: 'memory_search', isError: true, content: [{ type: 'text', text: 'memory_search requires qmd' }] },
];
let hotfixNoProject = false;
const recoveryMode = process.env.P25_2_HARNESS === '1';
let recoveryState = 'ready', recoveryRevision = 1;
const recoverySnapshot = () => ({ bridgeState: recoveryState, bridgeInstance: 'offline-recovery-harness', bridgeRun: 1,
  bridgeRevision: recoveryRevision, cwd: process.cwd(), hasProject: true,
  piRunning: true, bridgeError: '', bridgeHint: '', maintenance: null });
const recoveryBus = recoveryMode ? import('../server/sse.js').then(({ createEventBus }) => {
  const bus = createEventBus({ getBridgeSnapshot: recoverySnapshot });
  bus.publish({ type: 'bridge_status', state: 'ready', bridgeRun: 1 });
  for (let i = 0; i < 805; i++) bus.publish({ type: 'fixture_event', bridgeRun: 1, i });
  return bus;
}) : null;

/* /api/skills 的夹具：字段照抄 server/skills.js 的 listPayload 与 skills.push({...})，
 * 附加字段（context / projects / targets / manage）照抄 server/skills-routes.js 的 listExtras。
 * 默认 3 条：全局已启用 / 全局被 settings 停用 / 项目级（项目未信任）—— cdp-shot 依赖这三条与未信任说明。
 * 技能视觉脚本（tests/skills-visual.cjs）用 /api/__skills/mode 改成受信任 / 空列表 / 读取失败，
 * 只改内存里的夹具，不写任何真实目录。 */
const SKILL_HOME = 'C:\\Users\\me';
const SKILL_AGENT = SKILL_HOME + '\\.pi\\agent';
const SKILL_PROJECT = 'C:\\fixture\\project';
const SKILL_PROJECT_ID = 'c000000000000099';
const skillsMode = { trusted: false, empty: false, error: false, restartPending: false };
function harnessSkill(over) {
  const project = over.scope === 'project';
  const baseDir = project ? SKILL_PROJECT + '\\.pi' : SKILL_AGENT;
  const rel = `skills/${over.name}/SKILL.md`;
  return {
    description: '', scope: 'user', source: 'auto', origin: 'top-level', mode: 'pi',
    rootLabel: project ? '<项目>/.pi/skills' : '~/.pi/agent/skills',
    path: `${baseDir}\\skills\\${over.name}\\SKILL.md`, dir: `${baseDir}\\skills\\${over.name}`, file: 'SKILL.md', rel, baseDir,
    loaded: true, state: 'enabled', stateNote: '', shadowedBy: null, disablePattern: '-' + rel,
    settingsPath: baseDir + '\\settings.json', toggleable: true, blockedByTrust: false, disabledBy: '',
    disableModelInvocation: false, license: '', compatibility: '', bytes: 412, errors: [],
    ...over,
  };
}
const HARNESS_SKILLS = Object.freeze([
  harnessSkill({ id: 'a1c0de0000000001', name: 'code-review', description: '审查源代码中的问题，给出可执行的修改建议' }),
  harnessSkill({
    id: 'b2bdf00000000002', name: 'pdf-tools', description: '读取与整理 PDF', state: 'disabled', loaded: false,
    disabledBy: '-skills/pdf-tools/SKILL.md', stateNote: '被 settings 里的 -skills/pdf-tools/SKILL.md 关掉了',
  }),
  harnessSkill({
    id: 'c3a0be0000000003', name: 'proj-only', description: '当前项目的技能', scope: 'project', state: 'untrusted', loaded: false,
    blockedByTrust: true, stateNote: '项目未被信任：pi 在非交互模式下不加载项目级资源',
  }),
]);
function harnessTargets(trusted) {
  return [
    { key: 'user-pi', scope: 'user', mode: 'pi', dir: SKILL_AGENT + '\\skills', label: '~/.pi/agent/skills', exists: true, writable: true, blockedCode: '', blockedReason: '', notice: '' },
    { key: 'user-agents', scope: 'user', mode: 'agents', dir: SKILL_HOME + '\\.agents\\skills', label: '~/.agents/skills', exists: false, writable: true, blockedCode: '', blockedReason: '', notice: '' },
    trusted
      ? { key: 'project-pi', scope: 'project', mode: 'pi', dir: SKILL_PROJECT + '\\.pi\\skills', label: '<项目>/.pi/skills', exists: true, writable: true, blockedCode: '', blockedReason: '', notice: '项目技能只对当前项目生效；pi 重启后加载。' }
      : { key: 'project-pi', scope: 'project', mode: 'pi', dir: SKILL_PROJECT + '\\.pi\\skills', label: '<项目>/.pi/skills', exists: true, writable: false, blockedCode: 'project-untrusted', blockedReason: '项目未被信任：pi 不加载项目级资源', notice: '' },
  ];
}
function harnessManage(skill, trusted) {
  if (skill.scope === 'project' && !trusted) {
    return { target: null, editable: false, deletable: false, reason: '项目未被信任：pi 不加载项目级资源' };
  }
  return { target: skill.scope === 'project' ? 'project-pi' : 'user-pi', editable: true, deletable: true, reason: '' };
}
function harnessSkillsPayload() {
  const trusted = skillsMode.trusted === true;
  /* 停用刚写进 settings、pi 还没重启：配置已停用，运行时仍加载着它。 */
  const withPending = skillsMode.restartPending
    ? HARNESS_SKILLS.map((skill) => (skill.name === 'pdf-tools' ? { ...skill, state: 'disabled', loaded: true } : skill))
    : HARNESS_SKILLS;
  const base = withPending.map((skill) => (trusted && skill.scope === 'project'
    ? { ...skill, state: 'enabled', loaded: true, blockedByTrust: false, stateNote: '' }
    : skill));
  const skills = skillsMode.empty ? [] : base;
  return {
    ok: true, hasProject: true, cwd: SKILL_PROJECT, agentDir: SKILL_AGENT, homeDir: SKILL_HOME,
    globalSettings: SKILL_AGENT + '\\settings.json', projectSettings: SKILL_PROJECT + '\\.pi\\settings.json',
    trust: { trustFile: SKILL_AGENT + '\\trust.json', trustOverride: null, trusted, reason: trusted ? 'trusted' : 'default-never', requiresTrust: true },
    piReachable: true,
    context: { project: SKILL_PROJECT_ID, live: true },
    projects: [
      { id: SKILL_PROJECT_ID, name: 'fixture-project', path: SKILL_PROJECT, active: true },
      { id: 'c000000000000098', name: 'pi-gui', path: 'C:\\pi-GUI', active: false },
    ],
    targets: harnessTargets(trusted),
    trashAvailable: true,
    roots: [
      { label: '~/.pi/agent/skills', dir: SKILL_AGENT + '\\skills', scope: 'user', mode: 'pi', exists: true, blockedByTrust: false },
      { label: '~/.agents/skills', dir: SKILL_HOME + '\\.agents\\skills', scope: 'user', mode: 'agents', exists: false, blockedByTrust: false },
      { label: '<项目>/.pi/skills', dir: SKILL_PROJECT + '\\.pi\\skills', scope: 'project', mode: 'pi', exists: true, blockedByTrust: !trusted },
    ],
    diagnostics: [],
    counts: {
      total: skills.length,
      enabled: skills.filter((skill) => skill.state === 'enabled').length,
      project: skills.filter((skill) => skill.scope === 'project').length,
      user: skills.filter((skill) => skill.scope === 'user').length,
    },
    /* 服务端排序：项目级 → 全局 → 其它，同组按名称。 */
    skills: [...skills].sort((a, b) => {
      const rank = (skill) => (skill.scope === 'project' ? 0 : skill.scope === 'user' ? 1 : 2);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    }).map((skill) => ({ ...skill, manage: harnessManage(skill, trusted) })),
  };
}

/* 编辑器读取的源文件：形状照抄 server/skills-manage.js 的 readSource。 */
function harnessSkillSource(rec) {
  const description = rec.description || '';
  const body = `# ${rec.name}\n\n## 什么时候用\n\n${description}\n\n## 步骤\n\n1. 先确认改动范围与涉及的文件。\n2. 逐项对照仓库约定，标出与本次改动相关的风险。\n3. 给出可以执行的修改建议，并注明验证方式。\n`;
  const content = `---\nname: ${rec.name}\ndescription: ${description}\nlicense: MIT\n---\n${body}`;
  return {
    ok: true, id: rec.id, name: rec.name, dirName: rec.name, scope: rec.scope,
    target: rec.scope === 'project' ? 'project-pi' : 'user-pi', targetLabel: rec.rootLabel,
    path: rec.path, content, hash: 'sha256:4f2a9c1e77b3d0a5', eol: '\n', bom: false, bytes: Buffer.byteLength(content),
    form: {
      available: true, generated: '', name: rec.name, description,
      body, extraKeys: ['license'], reason: '',
    },
    limits: { maxBytes: 262144, maxDescription: 1024 },
  };
}

/* ---------- 技能市场夹具（形状照抄 server/skills-market.js 的 state() / preview()） ---------- */
const MARKET_CATEGORIES = Object.freeze([
  { id: 'coding', label: '编程' }, { id: 'writing', label: '写作' }, { id: 'docs', label: '文档' },
  { id: 'data', label: '数据' }, { id: 'workflow', label: '工作流' },
]);
const MARKET_SHA = '4f9c1d2e8a7b6c5d4e3f20112233445566778899';
const MARKET_ENTRY_SEEDS = [
  ['code-review', 'coding', '对改动做一次结构化的代码审查：先划范围，再列风险，最后给可执行的修改建议。'],
  ['pdf-tools', 'docs', '读取、拆分与整理 PDF，把表格和批注提取成 Markdown。'],
  ['commit-messages', 'coding', '根据改动内容写提交信息：一句话说清动机，正文只放必要的背景。'],
  ['changelog-writer', 'docs', '把一段提交历史整理成面向用户的更新日志，按影响分组。'],
  ['meeting-notes', 'writing', '把会议记录整理成结论、待办与负责人，去掉重复的讨论过程。'],
  ['api-designer', 'coding', '设计 HTTP 接口前先对齐资源、状态码和错误形状，输出可评审的契约。'],
  ['data-cleaning', 'data', '检查表格里的缺失值、重复行和类型不一致，给出可复现的清洗步骤。'],
  ['release-notes', 'docs', '从 PR 与 Issue 里挑出用户能感知的变化，写成发布说明。'],
  ['test-planner', 'coding', '为一段改动列出该补的测试：边界、失败路径、回归面。'],
  ['doc-translator', 'writing', '在保留术语表的前提下翻译技术文档，标记无法确定的译法。'],
  ['sql-explainer', 'data', '逐段解释 SQL 在做什么，指出可能的全表扫描和索引失效。'],
  ['incident-postmortem', 'writing', '把故障时间线整理成复盘：影响、根因、处置、后续动作。'],
  ['refactor-guide', 'coding', '在保持行为不变的前提下拆解重构步骤，每一步都可以单独验证。'],
  ['spreadsheet-formulas', 'data', '写表格公式并解释每个参数，优先用不依赖易失函数的写法。'],
  ['pr-description', 'coding', '把一次改动写成评审者能快速读懂的 PR 描述：改了什么、为什么、怎么验证。'],
  ['onboarding-guide', 'docs', '为新同事写一篇可执行的入门文档：环境、运行、常见坑。'],
  ['prompt-review', 'writing', '审查提示词的歧义、缺失的约束与失败时的降级路径。'],
  ['log-triage', 'data', '从日志里按时间线还原一次请求，区分噪音与真正的错误。'],
  ['dependency-audit', 'coding', '核对新增依赖的必要性、体积与许可证，给出替代方案。'],
  ['migration-plan', 'docs', '把一次数据或接口迁移拆成可回滚的阶段，写清每一步的验证。'],
  ['slide-outline', 'writing', '把材料整理成演示大纲：每页一个观点，证据与结论分开。'],
  ['chart-picker', 'data', '按数据类型和分析目的推荐图表，说明为什么不用别的类型。'],
  ['regex-helper', 'coding', '写正则并给出它能匹配与不能匹配的例子，避免灾难性回溯。'],
  ['glossary-builder', 'writing', '从文档里收集术语，统一中英文写法并生成术语表。'],
  ['repo-tour', 'docs', '给一个陌生仓库画导览：入口、模块边界、数据流和测试入口。'],
];
const MARKET_SOURCES = Object.freeze([
  { id: 'src-anthropics', repo: 'anthropics/skills', ref: 'main', builtin: true, removable: false, loaded: true, fetchedAt: 1764000000000, resolvedRef: MARKET_SHA, mode: 'pinned', count: 12, truncated: false, error: '', errorCode: '' },
  { id: 'src-official', repo: 'anthropics/claude-plugins-official', ref: 'main', builtin: true, removable: false, loaded: true, fetchedAt: 1764000000000, resolvedRef: '9a8b7c6d5e4f30211203344556677889900aabbc', mode: 'pinned', count: 8, truncated: false, error: '', errorCode: '' },
  { id: 'src-team', repo: 'HYJ1817/team-skills', ref: 'main', builtin: false, removable: true, loaded: true, fetchedAt: 1764000000000, resolvedRef: '3c2b1a0f9e8d7c6b5a4938271605142332415060', mode: 'pinned', count: 5, truncated: false, error: '', errorCode: '' },
]);
const MARKET_ENTRIES = Object.freeze(MARKET_ENTRY_SEEDS.map(([slug, category, description], index) => {
  const source = MARKET_SOURCES[index < 12 ? 0 : index < 20 ? 1 : 2];
  const dir = index < 12 ? `skills/${slug}` : index < 20 ? `plugins/${slug}` : `team/${slug}`;
  const blocked = index === 19;
  return {
    id: 'e' + String(index + 1).padStart(15, '0'),
    sourceId: source.id,
    repo: source.repo,
    dir,
    slug,
    title: slug,
    description,
    categories: [category],
    official: source.repo.startsWith('anthropics/'),
    listed: true,
    fileCount: 2 + (index % 4),
    bytes: 1200 + index * 340,
    installable: !blocked,
    reason: blocked ? 'SKILL.md 超过 256 KB，不能在这里安装' : '',
    homepage: `https://github.com/${source.repo}/tree/${encodeURIComponent(source.ref)}/${dir}`,
  };
}));
const MARKET_PREVIEW_ID = 'f'.repeat(24);
function harnessMarketPreview(entryId) {
  const entry = MARKET_ENTRIES.find((item) => item.id === entryId) || MARKET_ENTRIES[0];
  const content = [
    '# code-review', '',
    '对改动做一次结构化的代码审查。先划范围，再列风险，最后给可执行的修改建议。', '',
    '## 什么时候用', '',
    '- 用户要求审查一次改动、一个 PR 或一段实现；',
    '- 改动涉及权限、文件写入或并发时，先看这些边界。', '',
    '## 步骤', '',
    '1. 用 `git diff --stat` 确认改动范围，读完整的相关文件而不是只看 diff。',
    '2. 对照仓库约定检查：状态由谁持有、错误怎么恢复、失败路径是否可观测。',
    '3. 每条发现都写清位置、触发条件和影响；没有证据的猜测不列为问题。',
    '4. 最后给出验证方式：跑哪个测试、看哪个日志、怎么回滚。', '',
    '## 输出', '',
    '按严重程度排序，先说阻断项；格式偏好不阻塞验收。',
  ].join('\n');
  const files = [
    { path: 'SKILL.md', size: Buffer.byteLength(content), status: 'ok', note: '' },
    { path: 'references/checklist.md', size: 1820, status: 'ok', note: '' },
    { path: 'scripts/report.mjs', size: 640, status: 'ok', note: '' },
  ];
  return {
    ok: true, previewId: MARKET_PREVIEW_ID, entry,
    name: entry.title, suggestedName: entry.slug, description: entry.description,
    content, files, skipped: [], totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    problems: [], partial: false, installable: entry.installable, reason: entry.reason,
    source: { repo: entry.repo, dir: entry.dir, ref: MARKET_SHA, mode: 'pinned', homepage: entry.homepage },
  };
}

/* 从其他工具扫描的夹具：形状照抄 server/skills-external.js 的 scan()。 */
const EXTERNAL_SCAN = Object.freeze({
  ok: true,
  sources: [
    { id: 'claude-user', tool: 'Claude Code', label: '~/.claude/skills', dir: SKILL_HOME + '\\.claude\\skills', exists: true, count: 3, truncated: false, error: '' },
    { id: 'claude-project', tool: 'Claude Code', label: '<项目>/.claude/skills', dir: SKILL_PROJECT + '\\.claude\\skills', exists: true, count: 1, truncated: false, error: '' },
    { id: 'codex-user', tool: 'Codex', label: '~/.codex/skills', dir: SKILL_HOME + '\\.codex\\skills', exists: false, count: 0, truncated: false, error: '' },
  ],
  candidates: [
    {
      id: 'd000000000000001', sourceId: 'claude-user', tool: 'Claude Code', sourceLabel: '~/.claude/skills',
      dirName: 'portable', dir: SKILL_HOME + '\\.claude\\skills\\portable', name: 'portable',
      description: 'Portable Claude skill', bytes: 128, suggestedName: 'portable',
      importable: true, reason: '', problems: [], present: 'none', presentIn: '',
    },
    {
      id: 'd000000000000002', sourceId: 'claude-user', tool: 'Claude Code', sourceLabel: '~/.claude/skills',
      dirName: 'code-review', dir: SKILL_HOME + '\\.claude\\skills\\code-review', name: 'code-review',
      description: '审查源代码中的问题，给出可执行的修改建议', bytes: 96, suggestedName: 'code-review',
      importable: true, reason: '', problems: [], present: 'same', presentIn: '~/.pi/agent/skills',
    },
    {
      id: 'd000000000000003', sourceId: 'claude-user', tool: 'Claude Code', sourceLabel: '~/.claude/skills',
      dirName: 'legacy-notes', dir: SKILL_HOME + '\\.claude\\skills\\legacy-notes', name: 'legacy-notes',
      description: '旧版会议笔记整理', bytes: 240, suggestedName: 'legacy-notes',
      importable: true, reason: '', problems: [], present: 'different', presentIn: '~/.pi/agent/skills',
    },
    {
      id: 'd000000000000004', sourceId: 'claude-project', tool: 'Claude Code', sourceLabel: '<项目>/.claude/skills',
      dirName: 'release-notes', dir: SKILL_PROJECT + '\\.claude\\skills\\release-notes', name: 'release-notes',
      description: '从提交历史整理发布说明', bytes: 180, suggestedName: 'release-notes',
      importable: false, reason: '它已经链接在 pi 的技能目录里，不需要导入', problems: [], present: 'linked', presentIn: '',
    },
  ],
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------- 脚本数据 ---------------- */

/* 1000 字的审阅说明（§四十七的压力项）—— 中文按 1 字计，正好卡在上限。 */
const LONG_NOTE = '这段实现把重连窗口里的过期响应丢掉了，但我对边界条件仍有疑问：高并发下 bridgeRun 的自增与读取之间还有一个窗口，需要补一个针对性的用例。'.repeat(20).slice(0, 1000);
/* 超长路径（§四十八）—— 必须被截断 + title 提示，不能把卡片撑爆。 */
const LONG_PATH = 'packages/something/really/really/really/long/path/to/generated/adapter/implementation.js';
/* P9 压力项（§十二.22「长命令 / 长输出布局」）：
 * 一条带满参数的长命令 + 一段含超长无空格行的输出 —— 两者都不许把卡片撑破。 */
const LONG_COMMAND = 'npm run test -- --reporter=spec --grep "reconnect|stale|bridgeRun|sse-backlog" --timeout=30000 --reporter-options maxDiffSize=200000';
const LONG_OUTPUT = ('not ok 42 - reconnect keeps the newest run\n  AssertionError: expected 2 to equal 1' + 'Z'.repeat(180) + '\n').repeat(6);

/* P7 计划详情夹具：四种「会话」状态各一条，外加两次尝试。
 * 形状照抄后端 `planView()` 的输出（attempt 上带 sessionAvailable / sessionTitle）。
 *
 * P8-C 在同一份夹具上补齐审阅场景（§五十七 Scene 1–5）：
 *   analyze  成功 + 已接受 + 说明 + verificationSnapshot(command)  → Scene 2
 *   backend  Attempt1 失败、Attempt2 失败 + 需修改 + 说明           → Scene 3 / Scene 5
 *   tests    成功 + 待审阅 + snapshot(description)                 → Scene 1
 *   docs     成功 + 待审阅 + 没有快照 + changeCaptureIncomplete     → 「没有历史验证要求」
 *   live     Attempt1 已接受、Attempt2 执行中（运行期不给审阅操作）  → Scene 4 / §九
 *   hub      被中断 → 汇总必须单列「中断」，**不并进「失败」**       → P8 收口 blocker
 *
 * 【审阅状态字段名】`review.status` 只有 pending / accepted / needs_changes 三态，
 * 与后端 REVIEW_STATUS 一致 —— 夹具不能自己发明 `verified` / `stale`。
 * 【形状】attempt 上的 review 就是后端 `normalizeReview` 的形状：
 * `{status, note, reviewedAt, revision}`；pending 时 note 为空串、reviewedAt 为 null。 */
const PLAN_DETAIL = {
  id: 'plan-1',
  title: '修复 SSE 重连问题',
  goal: '让 bridgeRun 的过期响应不再覆盖新状态',
  status: 'paused',
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  endedAt: null,
  projectRoot: 'C:/pi-GUI',
  concurrency: 1,
  recoveryNotes: [],
  /* P9 收口：夹具里 `live` 任务确实有一条验证在跑（见它自己的 attempt），
   * 所以**全 workspace 级**的锁本来就该显示 —— 摆出来界面才是一致的。 */
  verificationActive: { planId: 'plan-1', taskId: 'live', attempt: 1 },
  tasks: [
    {
      id: 'analyze', title: '分析原因', description: '读 rpc-bridge 的重连路径', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 1, endedAt: 2, attempt: 1, error: '', verification: null,
      attempts: [{
        attempt: 1, success: true, error: '', summary: '读完了', exitCode: 0, startedAt: 1, endedAt: 2,
        sessionId: 'pi-gui-plan-1-analyze-a1', sessionAvailable: true, sessionTitle: 'SSE race analysis',
        filesChanged: ['src/auth.js'], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
        review: { status: 'accepted', note: '第一次实现已确认', reviewedAt: 1758800000000, revision: 2 },
        /* P9：Pi GUI 自己跑过一遍的真实证据 → Scene「验证通过」 */
        /* P10：历史变更证据（可用）→ Scene「历史 Diff」 */
        changeEvidence: {
          status: 'available',
          capturedAt: 1758800050000,
          truncated: false,
          note: '',
          files: [
            { path: 'src/auth.js', change: 'modified', oldPath: null, binary: false, additions: 2, deletions: 1, patch: 'diff --git a/src/auth.js b/src/auth.js\nindex 1111111..2222222 100644\n--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1,3 +1,4 @@\n const token = read();\n-const stale = true;\n+const stale = false;\n+const run = next();\n', truncated: false },
          ],
        },
        verificationResult: { status: 'passed', command: 'npm test', workingDirectory: '.', workingDirectorySource: 'attempt-snapshot', exitCode: 0, startedAt: 1758800001000, finishedAt: 1758800042000, durationMs: 41000, outputSummary: 'ok 740/740 通过\ntests 12 passed, 0 failed\n\n（退出码 0）', truncated: false, error: '' },
      }],
      result: { success: true, exitCode: 0, summary: '重连时 bridgeRun 会自增，但过期响应仍会写回状态', toolCalls: 4, durationMs: 42000, raw: null, sessionId: 'pi-gui-plan-1-analyze-a1', changes: { available: true, files: [], note: '' } },
    },
    {
      id: 'backend', title: '修复后端', description: '丢掉过期响应', agent: 'pi',
      workingDirectory: '.', dependsOn: ['analyze'], status: 'failed', startedAt: 3, endedAt: 6, attempt: 2, error: '第一次故意失败：模型报 402',
      verification: null,
      attempts: [
        { attempt: 1, success: false, error: '第一次故意失败：模型报 402', summary: '', exitCode: 1, startedAt: 3, endedAt: 4, sessionId: 'pi-gui-plan-1-backend-a1', sessionAvailable: true, sessionTitle: 'bridge reconnect fix（第一次）', filesChanged: ['server/rpc-bridge.js'], changeCaptureIncomplete: false, outcomeStatus: 'failed', verificationSnapshot: { command: 'npm test' }, review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
          /* P9：失败 + 输出被截断（要能看出「输出已截断」这句）→ Scene「验证失败」 */
          /* P10：binary + 截断 → Scene「历史 Diff：二进制 / 截断」 */
          changeEvidence: {
            status: 'partial',
            capturedAt: 1758800060000,
            truncated: true,
            note: '部分 diff 已截断',
            files: [
              { path: 'assets/logo.png', change: 'modified', oldPath: null, binary: true, additions: null, deletions: null, patch: '', truncated: false },
              { path: 'server/rpc-bridge.js', change: 'modified', oldPath: null, binary: false, additions: 12, deletions: 3, patch: 'diff --git a/server/rpc-bridge.js b/server/rpc-bridge.js\n--- a/server/rpc-bridge.js\n+++ b/server/rpc-bridge.js\n@@ -1,2 +1,2 @@\n-const run = 1;\n+const run = 2;\n', truncated: true },
            ],
          },
          verificationResult: { status: 'failed', command: 'npm test', workingDirectory: 'src', workingDirectorySource: 'attempt-snapshot', exitCode: 1, startedAt: 1758800050000, finishedAt: 1758800068400, durationMs: 18400, outputSummary: 'not ok 118 - bridge drops stale response\n  AssertionError: expected 2 to equal 1\n    at tests/reliability.cjs:88:7\nnot ok 119 - reconnect keeps the newest run\nnpm ERR! Test failed. See above for more details.', truncated: true, error: '' } },
        { attempt: 2, success: false, error: '第二次也失败：模型报 402', summary: '', exitCode: 1, startedAt: 5, endedAt: 6, sessionId: 'pi-gui-plan-1-backend-a2', sessionAvailable: true, sessionTitle: 'bridge reconnect fix（第二次）', filesChanged: ['server/rpc-bridge.js', 'server/sse.js'], changeCaptureIncomplete: false, outcomeStatus: 'failed', verificationSnapshot: { command: 'npm test' }, review: { status: 'needs_changes', note: '两次都报 402，先把 provider 配额确认了再重试', reviewedAt: 1758800100000, revision: 1 } },
      ],
      result: { success: false, exitCode: 1, summary: '', toolCalls: 0, durationMs: 3000, raw: null, sessionId: 'pi-gui-plan-1-backend-a2', changes: { available: true, files: [{ path: 'server/rpc-bridge.js', change: 'modified', status: 'M', additions: 12, deletions: 3 }, { path: 'server/sse.js', change: 'modified', status: 'M', additions: 4, deletions: 0 }], note: '执行期间观察到的工作区变化（可能也包含其它来源的改动）' } },
    },
    {
      id: 'tests', title: '补测试', description: '加可靠性用例', agent: 'codex',
      workingDirectory: '.', dependsOn: ['backend'], status: 'blocked', startedAt: 7, endedAt: 8, attempt: 1, error: '', verification: null,
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 7, endedAt: 8,
        sessionId: null, sessionAvailable: false, sessionTitle: '',
        filesChanged: ['tests/reliability.cjs'], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { description: '确认登录错误提示' },
        /* P10：added + deleted（Scene「历史 Diff：新增 / 删除」） */
        changeEvidence: {
          status: 'available',
          capturedAt: 1758800080000,
          truncated: false,
          note: '',
          files: [
            { path: 'tests/login.test.js', change: 'added', oldPath: null, binary: false, additions: 40, deletions: 0, patch: 'diff --git a/tests/login.test.js b/tests/login.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/tests/login.test.js\n@@ -0,0 +1,2 @@\n+test("login", () => {});\n+test("logout", () => {});\n', truncated: false },
            { path: 'tests/legacy.test.js', change: 'deleted', oldPath: null, binary: false, additions: 0, deletions: 18, patch: 'diff --git a/tests/legacy.test.js b/tests/legacy.test.js\ndeleted file mode 100644\n--- a/tests/legacy.test.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-test("old", () => {});\n', truncated: false },
          ],
        },
        review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
      }],
      result: null,
    },
    {
      id: 'docs', title: '更新文档', description: '把语义写清楚', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 9, endedAt: 10, attempt: 1, error: '',
      verification: { command: 'npm run test:unit' },
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 9, endedAt: 10,
        sessionId: 'pi-gui-plan-1-docs-a1', sessionAvailable: false, sessionTitle: '',
        filesChanged: [], changeCaptureIncomplete: true,
        outcomeStatus: 'success', verificationSnapshot: null,
        review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
      }],
      result: null,
    },
    {
      /* 正在执行的任务：历史里有一次已接受的尝试，第 2 次正在跑（历史里还没有它）。
       * 用来核对 §九「运行期不给审阅操作」与 §二十四「历史 accepted 不被隐藏」。 */
      id: 'live', title: '正在跑的任务', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'running', startedAt: 11, endedAt: null, attempt: 2, error: '',
      verification: null,
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 11, endedAt: 12,
        sessionId: 'pi-gui-plan-1-live-a1', sessionAvailable: true, sessionTitle: '第一轮（已接受）',
        filesChanged: ['server/sse.js'], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
        review: { status: 'accepted', note: '第一轮的实现保留', reviewedAt: 1758800200000, revision: 1 },
        /* P9：**正在跑**的那一次验证（`verificationRunning` 是后端注入的视图字段，
         * 表示「本进程正在跑」，夹具里手动置上）→ Scene「正在验证…」+ 停止按钮 */
        verificationResult: { status: 'running', command: 'npm test', workingDirectory: '.', workingDirectorySource: 'attempt-snapshot', exitCode: null, startedAt: 1758800300000, finishedAt: null, durationMs: null, outputSummary: '', truncated: false, error: '' },
        verificationRunning: true,
      }],
      result: null,
    },
    {
      /* 被中断的任务：用来核对 Plan 汇总把 interrupted **单列**成「中断」，
       * 而不是并进「失败」（P8 最终收口的两个 blocker 之一）。
       * 没有它，汇总里那个新 token 在截图里根本不会出现。 */
      id: 'hub', title: '被中断的任务', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'interrupted', startedAt: 13, endedAt: 14, attempt: 1,
      error: '应用关闭时被中断', verification: null,
      attempts: [{
        attempt: 1, success: false, error: '应用关闭时被中断', summary: '', exitCode: null, startedAt: 13, endedAt: 14,
        sessionId: 'pi-gui-plan-1-hub-a1', sessionAvailable: true, sessionTitle: '被中断的那次',
        filesChanged: [], changeCaptureIncomplete: true,
        outcomeStatus: 'interrupted', verificationSnapshot: { command: 'npm run build' },
        review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
        /* P9：被中断的验证（命令跑着，应用被关掉）→ Scene「已中断」 */
        verificationResult: { status: 'interrupted', command: 'npm run build', workingDirectory: 'packages/legacy', workingDirectorySource: 'current-task-fallback', exitCode: null, startedAt: 1758800070000, finishedAt: 1758800075000, durationMs: 5000, outputSummary: '', truncated: false, error: '应用关闭时被中断' },
        /* P10：中断 → 没有结束状态采集，如实说（Scene「历史 Diff：不可用」） */
        changeEvidence: { status: 'unavailable', capturedAt: null, files: [], truncated: false, note: '应用关闭时被中断，未完成结束状态采集' },
      }],
      result: null,
    },
  ],
};

/* 压力夹具（§五十八）：1000 字说明 / 20 个变更文件 / 超长路径 / 10 次尝试。
 * 单独一个计划是为了让上面的默认场景保持干净 —— 组合在一起截图会糊成一片。 */
const PLAN_STRESS = {
  id: 'plan-stress',
  title: '压力场景：长说明 / 多文件 / 多次尝试',
  goal: '验证极端内容不破布局',
  status: 'completed',
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  endedAt: 9,
  projectRoot: 'C:/pi-GUI',
  concurrency: 1,
  recoveryNotes: [],
  tasks: [
    {
      id: 'longnote', title: '带 1000 字说明的任务', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 1, endedAt: 2, attempt: 1, error: '', verification: null,
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 1, endedAt: 2,
        sessionId: 'pi-gui-plan-stress-a1', sessionAvailable: true, sessionTitle: '长说明',
        filesChanged: Array.from({ length: 20 }, (_, i) => (i === 3 ? LONG_PATH : `src/generated/module-${i}.js`)),
        changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: LONG_COMMAND },
        review: { status: 'accepted', note: LONG_NOTE, reviewedAt: 1758800300000, revision: 1 },
        /* 长命令 + 长输出（且被截断）—— 排版压力项 */
        verificationResult: { status: 'failed', command: LONG_COMMAND, workingDirectory: 'packages/something/really/really/really/long/path/to/generated/adapter', workingDirectorySource: 'attempt-snapshot', exitCode: 1, startedAt: 1758800310000, finishedAt: 1758800331800, durationMs: 21800, outputSummary: LONG_OUTPUT, truncated: true, error: '' },
        /* P10：超长路径 + 超长单行 patch（Scene「历史 Diff：长内容」） */
        changeEvidence: {
          status: 'available',
          capturedAt: 1758800330000,
          truncated: false,
          note: '',
          files: [
            { path: LONG_PATH, change: 'modified', oldPath: null, binary: false, additions: 120, deletions: 8, patch: 'diff --git a/' + LONG_PATH + ' b/' + LONG_PATH + '\n--- a/' + LONG_PATH + '\n+++ b/' + LONG_PATH + '\n@@ -1 +1 @@\n-' + 'a'.repeat(300) + '\n+' + 'b'.repeat(300) + '\n', truncated: false },
          ],
        },
      }],
      result: null,
    },
    {
      id: 'manyattempts', title: '跑了 10 次的任务', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'failed', startedAt: 1, endedAt: 9, attempt: 10, error: '第十次仍然失败：断言超时',
      verification: null,
      attempts: Array.from({ length: 10 }, (_, i) => ({
        attempt: i + 1,
        success: i === 9 ? false : i % 2 === 0,
        error: i === 9 ? '第十次仍然失败：断言超时' : i % 2 === 0 ? '' : `第 ${i + 1} 次失败：连接超时`,
        summary: '', exitCode: i % 2 === 0 ? 0 : 1,
        startedAt: i * 10 + 1, endedAt: i * 10 + 5,
        sessionId: `pi-gui-plan-stress-many-a${i + 1}`, sessionAvailable: true, sessionTitle: `第 ${i + 1} 次尝试的会话`,
        filesChanged: [`src/try-${i + 1}.js`], changeCaptureIncomplete: false,
        outcomeStatus: i === 9 ? 'failed' : i % 2 === 0 ? 'success' : 'failed',
        verificationSnapshot: { command: 'npm test' },
        review: i === 0 ? { status: 'accepted', note: '第一次曾经通过', reviewedAt: 1758800400000, revision: 1 } : { status: 'pending', note: '', reviewedAt: null, revision: 0 },
      })),
      result: null,
    },
  ],
};


/* P13：「下一步」的 **ready 态** 场景夹具。
 *
 * 现有三个计划都截不到这一态：plan-1 有失败任务（优先级 3 先命中）、plan-gate 在
 * 等人工验收（优先级 5）、plan-stress 已完成（优先级 6）。要看到「可以执行」+ 一个
 * 「开始执行」按钮，必须有一个**没有失败 / 没有门控 / 没有阻塞 / 没有独立验证**
 * 的计划 —— 而且 `status` 得是 `ready` 或 `paused`（`running` 会先命中「不给 CTA」那支）。
 *
 * 任务刻意给两条：上游成功且被接受、下游依赖它并已就绪 —— 这样「有 1 个任务可以执行」
 * 里的 1 是数出来的，不是写死的。 */
const PLAN_UX = {
  id: 'plan-ux',
  title: 'P13 下一步：可执行',
  goal: '核对「下一步」在有一条就绪任务时给什么',
  status: 'ready',
  createdAt: 1,
  updatedAt: 2,
  startedAt: null,
  endedAt: null,
  projectRoot: 'C:/pi-GUI',
  concurrency: 1,
  recoveryNotes: [],
  tasks: [
    {
      id: 'done', title: '第一阶段：已收尾', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 1, endedAt: 2, attempt: 1, error: '',
      verification: null,
      attempts: [{
        attempt: 1, success: true, error: '', summary: '按计划完成', exitCode: 0, startedAt: 1, endedAt: 2,
        sessionId: null, sessionAvailable: false, sessionTitle: '',
        filesChanged: [], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: null,
        review: { status: 'accepted', note: '第一阶段没问题', reviewedAt: 1758801000000, revision: 2 },
      }],
      result: { success: true, exitCode: 0, summary: '按计划完成', toolCalls: 2, durationMs: 1200, raw: null, sessionId: null, changes: { available: false, files: [], note: '' } },
    },
    {
      id: 'todo', title: '第二阶段：还没开跑', description: '上游已完成，依赖已就绪', agent: 'pi',
      workingDirectory: '.', dependsOn: ['done'], status: 'ready', startedAt: null, endedAt: null, attempt: 1,
      error: '', verification: null, blockedReason: null, waitingOn: [],
      attempts: [],
      result: null,
    },
  ],
};


/* P13：「下一步」的 **waiting-review 态** 场景夹具。
 *
 * plan-gate 截不到这一支：它里面还有一条 `blockedReason: 'dependency-failed'` 的
 * 任务（P11 专门用来核对「被依赖失败挡住」那行），而「被阻塞」排在「等验收」前面 ——
 * 那是设计好的优先级，不该为了让截图好看去改 P11 的夹具。所以单独给一个干干净净、
 * 只有一条待验收门控的计划。
 *
 * 视图字段（`reviewGateSummary` / `workflowReason` / `gateState` / `blockedReason`）
 * 仍然是真后端 `planView` 会注入的那几个 —— 夹具照真实形状给。 */
const PLAN_WAIT = {
  id: 'plan-wait',
  title: 'P13 下一步：等人工验收',
  goal: '核对「下一步」在有门控待验收时给什么',
  status: 'paused',
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  endedAt: null,
  projectRoot: 'C:/pi-GUI',
  concurrency: 1,
  recoveryNotes: [],
  reviewGateSummary: { gated: 2, satisfied: 1, waiting: 1 },
  workflowReason: 'waiting-review',
  tasks: [
    {
      id: 'gated-main', title: '接口改完了，等人验收', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 1, endedAt: 2, attempt: 1, error: '',
      verification: null, reviewGate: true,
      gateState: { enabled: true, required: true, satisfied: false, reason: 'pending', attempt: 1 },
      blockedReason: null, waitingOn: [],
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 1, endedAt: 2,
        sessionId: null, sessionAvailable: false, sessionTitle: '',
        filesChanged: ['server/export.js'], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
        review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
      }],
      result: null,
    },
    {
      id: 'gated-sub', title: '下游在等它验收', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: ['gated-main'], status: 'blocked', startedAt: null, endedAt: null, attempt: 0, error: '',
      verification: null, reviewGate: false,
      gateState: { enabled: false, required: false, satisfied: true, reason: 'disabled', attempt: null },
      blockedReason: 'waiting-review', waitingOn: ['gated-main'],
      attempts: [],
      result: null,
    },
  ],
};


/* P11：人工验收门控的场景夹具。
 * 视图字段（`gateState` / `blockedReason` / `waitingOn` / `reviewGateSummary` /
 * `workflowReason`）真后端由 `planView` 注入，这里照真实形状给出来。 */
const LONG_GATE_TITLE = '把订单导出接口的分页游标改成稳定排序并补齐并发写入的回归用例（这个标题刻意很长，用来核对门控那一行与等待原因在窄窗口下不会挤坏）';
const PLAN_GATE = {
  id: 'plan-gate',
  title: '人工验收门控：等待 / 通过 / 需修改',
  goal: '核对门控的五种状态与下游等待原因',
  status: 'paused',
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  endedAt: null,
  projectRoot: 'C:/pi-GUI',
  concurrency: 1,
  recoveryNotes: [],
  reviewGateSummary: { gated: 5, satisfied: 1, waiting: 3 },
  workflowReason: 'waiting-review',
  tasks: [
    {
      id: 'gated-a', title: '改导出接口', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 1, endedAt: 2, attempt: 1, error: '',
      verification: null, reviewGate: true,
      gateState: { enabled: true, required: true, satisfied: false, reason: 'pending', attempt: 1 },
      blockedReason: null, waitingOn: [],
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 1, endedAt: 2,
        sessionId: 'pi-gui-plan-gate-a1', sessionAvailable: true, sessionTitle: '改导出接口',
        filesChanged: ['src/api/export.js'], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
        review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
      }],
      result: null,
    },
    {
      id: 'gated-ok', title: '补回归用例', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 3, endedAt: 4, attempt: 1, error: '',
      verification: null, reviewGate: true,
      gateState: { enabled: true, required: true, satisfied: true, reason: 'accepted', attempt: 1 },
      blockedReason: null, waitingOn: [],
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 3, endedAt: 4,
        sessionId: null, sessionAvailable: false, sessionTitle: '',
        filesChanged: [], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
        review: { status: 'accepted', note: '用例覆盖到位', reviewedAt: 1758800600000, revision: 2 },
      }],
      result: null,
    },
    {
      id: 'gated-need', title: '重写鉴权中间件', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 5, endedAt: 6, attempt: 2, error: '',
      verification: null, reviewGate: true,
      gateState: { enabled: true, required: true, satisfied: false, reason: 'needs_changes', attempt: 2 },
      blockedReason: null, waitingOn: [],
      attempts: [{
        attempt: 2, success: true, error: '', summary: '', exitCode: 0, startedAt: 5, endedAt: 6,
        sessionId: null, sessionAvailable: false, sessionTitle: '',
        filesChanged: [], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
        review: { status: 'needs_changes', note: '缺少 token 过期的边界用例', reviewedAt: 1758800700000, revision: 1 },
      }],
      result: null,
    },
    {
      id: 'gated-long', title: LONG_GATE_TITLE, description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'success', startedAt: 7, endedAt: 8, attempt: 1, error: '',
      verification: null, reviewGate: true,
      gateState: { enabled: true, required: true, satisfied: false, reason: 'pending', attempt: 1 },
      blockedReason: null, waitingOn: [],
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 7, endedAt: 8,
        sessionId: null, sessionAvailable: false, sessionTitle: '',
        filesChanged: [], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
        review: { status: 'pending', note: '', reviewedAt: null, revision: 0 },
      }],
      result: null,
    },
    {
      /* Retry 之后：attempt1 曾被接受（历史），当前这次还没跑 ——
       * `required=false, satisfied=true`，文案必须是「执行未成功 · 门控未开始」，
       * 不能是「门控已通过」（P12 blocker 的前端那一半，smoke G17 钉住）。 */
      id: 'gated-retry', title: '重跑导出接口（第 2 次尝试排队中）', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: [], status: 'pending', startedAt: null, endedAt: null, attempt: 1, error: '',
      verification: null, reviewGate: true,
      gateState: { enabled: true, required: false, satisfied: true, reason: 'accepted', attempt: 1 },
      blockedReason: null, waitingOn: [],
      attempts: [{
        attempt: 1, success: true, error: '', summary: '', exitCode: 0, startedAt: 9, endedAt: 10,
        sessionId: null, sessionAvailable: false, sessionTitle: '',
        filesChanged: [], changeCaptureIncomplete: false,
        outcomeStatus: 'success', verificationSnapshot: { command: 'npm test' },
        review: { status: 'accepted', note: '第一次通过了', reviewedAt: 1758800800000, revision: 1 },
      }],
      result: null,
    },
    {
      /* 多上游：一个在等验收、一个失败 —— 必须说「上游任务失败」（失败优先） */
      id: 'gated-down', title: '合并上游结果', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: ['gated-a', 'gated-ok'], status: 'blocked', startedAt: null, endedAt: null, attempt: 0, error: '',
      verification: null, reviewGate: false,
      gateState: { enabled: false, required: false, satisfied: true, reason: 'disabled', attempt: null },
      blockedReason: 'waiting-review', waitingOn: ['gated-a'],
      attempts: [],
      result: null,
    },
    {
      id: 'gated-faildown', title: '下游被上游失败挡住', description: '', agent: 'pi',
      workingDirectory: '.', dependsOn: ['gated-need'], status: 'blocked', startedAt: null, endedAt: null, attempt: 0, error: '',
      verification: null, reviewGate: false,
      gateState: { enabled: false, required: false, satisfied: true, reason: 'disabled', attempt: null },
      blockedReason: 'dependency-failed', waitingOn: ['gated-need'],
      attempts: [],
      result: null,
    },
  ],
};


const MODELS = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', contextWindow: 1000000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', reasoning: true, contextWindow: 200000 },
  /* 跨供应商同名/不同容量：截图要能证明容量跟着 (provider, model) 走。 */
  { id: 'grok-4.7', name: 'Grok 4.7 · OpenCode Go', provider: 'opencode-go', contextWindow: 256000 },
  /* 没有 contextWindow 的模型：容量必须显示「未知」，不能回退成旧值或 1M。 */
  { id: 'mystery-model', name: 'Mystery Model', provider: 'mystery' },
];
/* 视觉验收可临时换掉模型清单（P4 需要多供应商 + 大量模型）；
 * 每轮结束用 /api/__composer-reset 恢复，下一轮 P3 才还能看到 Grok / Mystery。 */
const BASE_MODELS = MODELS.map((model) => ({ ...model }));
let composerModel = MODELS[0];
let composerThinking = 'high';
/* 真实拖动/失败回读验收用：只拒绝指定档位，不改变其他夹具行为。 */
let thinkingFailLevel = null;

// 实测 pi 只返回这三档（medium 会被静默映射成 high，所以不要放进夹具）
const LEVELS = ['off', 'high', 'max'];

const DOC_TEXT =
  '发酵罐空气分布器的设计参数核算\n' +
  '一、设计依据\n' +
  '依据《发酵工程设备设计手册》第 3 版，通风发酵罐采用单管式空气分布器，\n' +
  '出口气速取 10～15 m/s，管口距罐底 40 mm，罐底设置防冲刷钢板。\n' +
  '二、结构参数\n' +
  '罐体公称容积 V = 50 m³，装料系数 η = 0.75，实际装液量 37.5 m³。\n' +
  '通气量 Q = 1.2 vvm，则标准状态下空气流量为 0.75 m³/s。\n' +
  '空气分布器出口内径 d = √(4Q / (π·v))，取 v = 12 m/s，计算得 d ≈ 0.282 m。\n' +
  '圆整后取 DN300 无缝钢管，壁厚 6 mm。\n' +
  '三、结论\n' +
  '轴承与联轴器仅保留选用及布置说明，删去具体设计计算；\n' +
  '空气分布器补全结构、尺寸和通气核算，并检查其与下层叶轮、蛇管及排料口的位置关系。';

// 1×1 的琥珀色 PNG，只为了让缩略图有东西可显示
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const MESSAGES = [
  {
    role: 'user',
    content: [
      { type: 'text', text: `帮我核对一下这份设计说明里的通气量和管径，另外这张是现场照片。\n\n<pi-file name="发酵罐空气分布器设计.pdf" meta="1 页 · 386 字">\n${DOC_TEXT}\n</pi-file>` },
      { type: 'image', data: TINY_PNG, mimeType: 'image/png' },
    ],
  },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先按手册第 3 版的公式核算出口内径，再检查通气量是否落在推荐区间内。' },
      {
        type: 'text',
        text:
          '核对结果如下：\n\n' +
          '**1. 通气量** 罐体 50 m³、装料系数 0.75，实际装液量 37.5 m³。按 1.2 vvm 计，标准状态空气流量 0.75 m³/s，与文档一致。\n\n' +
          '**2. 出口内径** 取 v = 12 m/s 时代入 `d = √(4Q / (π·v))`：\n\n' +
          '```\nd = sqrt(4 × 0.75 / (3.1416 × 12)) = 0.2821 m\n```\n\n' +
          '计算值与文档的 0.282 m 吻合，圆整取 DN300 合适。\n\n' +
          '**3. 需要补充的地方**\n\n' +
          '- 出口气速取 12 m/s 落在 10～15 m/s 区间内，但没有说明该值的选取依据；\n' +
          '- 管口距罐底 40 mm 与下层叶轮的相对位置未给出，建议补一张布置简图；\n' +
          '- 防冲刷钢板的尺寸和固定方式缺失。',
      },
    ],
  },
  /* 一段真实的工具执行：多调用 + 成功 + 失败（带退出码）+ 写文件。
   * 走的是 get_messages 重建这条路 —— 和刷新页面之后看到的是同一条路径，
   * 所以这里能同时核对「时间线长什么样」和「历史重建对不对」。 */
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先把文档里的数字和仓库里的实现对一遍。' },
      { type: 'text', text: '我核对一下仓库里的实现。' },
      { type: 'toolCall', id: 'fx1', name: 'read', arguments: { path: 'src/fermenter/sizing.js' } },
      { type: 'toolCall', id: 'fx2', name: 'bash', arguments: { command: 'npm test -- fermenter' } },
      { type: 'toolCall', id: 'fx3', name: 'edit', arguments: { path: 'src/fermenter/sizing.js' } },
    ],
    timestamp: 1787125575000,
    stopReason: 'toolUse',
  },
  {
    role: 'toolResult',
    toolCallId: 'fx1',
    toolName: 'read',
    content: [{ type: 'text', text: 'export function outletDiameter(q, v) {\n  return Math.sqrt((4 * q) / (Math.PI * v));\n}\n\nexport function airFlow(vvm, volume, fill) {\n  return vvm * volume * fill;\n}\n' }],
    isError: false,
    timestamp: 1787125575300,
  },
  {
    role: 'toolResult',
    toolCallId: 'fx2',
    toolName: 'bash',
    content: [{ type: 'text', text: '> fermenter@1.0.0 test\n> node --test tests/fermenter\n\n✔ airFlow 用装料系数折算 (1.2ms)\n✔ outletDiameter 取 v=12 得 0.282 (0.8ms)\n✖ 圆整到 DN 系列 (2.1ms)\n\n  AssertionError: expected DN250 to equal DN300\n\n1 failing\nCommand exited with code 1' }],
    isError: true,
    timestamp: 1787125585000,
  },
  {
    role: 'toolResult',
    toolCallId: 'fx3',
    toolName: 'edit',
    content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in src/fermenter/sizing.js' }],
    details: {
      diff: '  11   const table = [200, 250, 300, 350];\n- 12   return table.find((d) => d >= mm);\n+ 12   return table.find((d) => d >= mm) ?? table[table.length - 1];\n  13 }\n',
      patch: '',
      firstChangedLine: 12,
    },
    isError: false,
    timestamp: 1787125586400,
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '对完了：\n\n- `airFlow` / `outletDiameter` 与文档公式一致；\n- 单测挂在圆整这一步：`find()` 找不到比 0.282 m 大的 DN 时返回 `undefined`，已补上兜底并重新跑通。',
      },
    ],
    timestamp: 1787125587000,
    stopReason: 'stop',
  },
];

/* P14-B 的独立对话夹具。由测试端点在 P14-A 场景之后注入，避免改变既有截图。 */
const P14B_MESSAGES = MESSAGES.concat([
  { role: 'user', content: '好，继续。' },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: '先核对步骤，再用现有工具检查结果。' },
    { type: 'text', text: '我会沿着现有实现继续检查。\n\n## 当前结论\n\n段落、列表和 `inlineCode` 都保持原有 Markdown 语义。' },
  ] },
  { role: 'user', content: '请保留完整路径、换行和长链接。\n' + 'public/very-long-conversation-example/'.repeat(10) + '\nhttps://example.test/' + 'unbroken-segment'.repeat(24) },
  { role: 'assistant', content: [{ type: 'text', text: '下面是长代码块，仅代码区横向滚动：\n\n```js\nconst veryLongLine = "' + 'Z'.repeat(420) + '";\n```\n\n| 文件 | 状态 |\n| --- | --- |\n| app.js | 已读取 |' }] },
  { role: 'user', content: '<pi-file name="设备图全套_6张A2.pdf" meta="文档 · PDF">附件一正文</pi-file>\n\n<pi-file name="核对记录.docx" meta="文档 · Word">附件二正文</pi-file>' },
  { role: 'assistant', content: [{ type: 'text', text: '两份附件已列在上方，仍可展开查看已有文本内容。' }] },
]);

/* ---------------- 工具 ---------------- */

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
};

const safeName = (name) =>
  path.basename(String(name || 'file')).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';

/* ---------------- SSE ---------------- */

const clients = new Set();
let holdNextComposerUpload = false;
/* P30：扣住下一条 abort 的 HTTP 应答，用来取「停止未确认」那一帧。 */
let holdNextStop = false;
let heldStop = null;
let workSurfaceGitClean = false;
/* P22：让 /api/extensions 返回「发现失败」，用来截「未知（无法确认）」而不是「未安装」。 */
let capabilityRegistryFail = false;
/* P24：一键安装的夹具状态。
 *   - `capabilityInstallHold` 打开时 POST 会挂住，直到 release / 15s 兜底 ——
 *     用来截「安装中…」那一帧（真实安装可能要几分钟，截图不能真等）。
 *   - `capabilityInstallCalls` 只记 capabilityId（**不记包名**：包名由服务端
 *     allowlist 决定，夹具也不该出现第二个映射表）。
 * 这里**不执行任何命令**，只回一个形状正确的响应。 */
let capabilityInstallHold = false;
let capabilityInstallRelease = null;
const capabilityInstallCalls = [];
let harnessSessionId = 'aaaaaaaaaaaaaaaa';
/* 真实 Pi 的 sessionName 只在用户明确命名后才有值；自动标题来自会话文件。
 * 夹具默认保留原来的 'pi-GUI'，P2 取证时可显式清空，走列表标题投影。 */
let harnessSessionName = 'pi-GUI';
/* AI 会话标题（自动 / 手动）：设置页与侧栏菜单的真实排版取证需要一份
 * 能力已确认的响应，否则入口按「未知」降级、截图里看不出按钮的常态。
 * 只存在内存里，不读写任何文件。 */
let harnessAutoTitle = true;
let harnessTitleSettingsFail = false;
/* 视觉取证里手动改名的内存结果：按原生 sessionId / conversationId 记录，
 * 列表和 Runtime 摘要都读它，这样 reload 后仍能看到改名后的标题。
 * 只存在内存里，不读写任何文件。 */
const harnessTitleOverrides = new Map();
let harnessTitleRevision = 5;
const harnessSessionIdFor = (id) => (id === 'bbbbbbbbbbbbbbbb' ? 'sid-b'
  : id === 'dddddddddddddddd' ? 'sid-d' : 'sid-cur');
/* 仅视觉取证：给 Runtime 并行会话行一份离线记录，验证新增的标题入口
 * 与共用行/菜单排版。默认关闭，不影响其它既有截图。 */
let harnessRuntimeTitleRow = false;
const HARNESS_RUNTIME_TITLE_ID = '12121212-1212-4212-8212-121212121212';

/* 真实 SSE 会给事件带上 bridgeRun：前端靠它丢弃旧 bridge run 的事件，
 * 也靠它认定「这次调用真的发生在当前 workspace / run」。
 * harness 以前不带这个字段，于是 Extensions 页的 runtimeObserved 在
 * 真实浏览器里**永远**显示「尚未观察到调用」—— 那是 fixture 不照真实形状造
 * 造成的假绿。这里按真实形状补上（只补这两个前缀，不动 response/message）。 */
const BRIDGE_RUN = 1;

function push(evt) {
  const needsRun = /^tool_execution_/.test(evt?.type || '') || evt?.type === 'bridge_status';
  const stamped = needsRun && !Number.isInteger(evt.bridgeRun) ? { ...evt, bridgeRun: BRIDGE_RUN } : evt;
  if (recoveryMode) { void recoveryBus.then(bus => bus.publish(stamped)); return; }
  const line = 'data: ' + JSON.stringify(stamped) + '\n\n';
  for (const c of clients) {
    try {
      c.write(line);
    } catch {
      /* 客户端已断开 */
    }
  }
}

// 每个命令都回一条对应的 response，模拟 pi 的应答。
// 注意必须带 type:'response' —— 前端是按 evt.type 分发的，只有 command 会被丢掉。
function replyFor(cmd) {
  switch (cmd.type) {
    case 'get_state':
      return {
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: composerModel,
          thinkingLevel: composerThinking,
          sessionName: harnessSessionName,
          isStreaming: false,
        },
      };
    case 'get_session_stats': {
      /* 容量跟当前模型走：切模型后夹具也必须换 contextWindow，
       * 否则截图会把「旧容量」证明成正确行为。 */
      const window = composerModel?.contextWindow ?? null;
      return {
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          contextUsage: {
            tokens: 61234,
            contextWindow: window,
            percent: window ? (61234 / window) * 100 : null,
          },
          tokens: { input: 18420, output: 3110, cacheRead: 40200 },
          cost: 0.0842,
        },
      };
    }
    case 'get_tree':
      /* 照 pi 的真实条目形状造（消息体嵌在 entry.message 里，各类型字段不同），
       * 并且刻意混入操作类条目（model_change / thinking_level_change）+ 一个分叉点
       * —— 桩形状不对，截图就证明不了用户会看到什么。 */
      return {
        type: 'response', command: 'get_tree', success: true,
        data: {
          tree: [
            {
              entry: { type: 'message', id: 'a', timestamp: '2026-09-25T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '帮我看看 server.js 的路由顺序' }] } },
              children: [
                {
                  entry: { type: 'message', id: 'b', timestamp: '2026-09-25T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '路由顺序没问题，但静态资源那段建议排在 API 之后。' }] } },
                  children: [],
                  label: '关键结论',
                },
                {
                  entry: { type: 'model_change', id: 'm1', timestamp: '2026-09-25T10:00:04.000Z', provider: 'deepseek', modelId: 'deepseek-v4-pro' },
                  children: [
                    {
                      entry: { type: 'thinking_level_change', id: 't1', timestamp: '2026-09-25T10:00:05.000Z', thinkingLevel: 'high' },
                      children: [
                        { entry: { type: 'message', id: 'c', timestamp: '2026-09-25T10:00:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '换个模型重答一次，结论一致。' }] } }, children: [] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
    case 'get_messages':
      return { type: 'response', command: 'get_messages', success: true, data: { messages:
        harnessSessionId === 'bbbbbbbbbbbbbbbb'
          ? [{ role: 'user', content: '请补全 README 的测试说明' },
            { role: 'assistant', content: [{ type: 'text', text: '这是 README 会话的历史消息：测试说明已整理完成。' }] }]
          : uxMode ? uxHistory : MESSAGES,
      } };
    case 'get_available_models':
      return { type: 'response', command: 'get_available_models', success: true, data: { models: MODELS } };
    case 'get_available_thinking_levels':
      return { type: 'response', command: 'get_available_thinking_levels', success: true, data: { levels: composerModel.provider === 'zhipu' ? ['off', 'low', 'medium', 'high'] : LEVELS } };
    case 'set_model': {
      const model = MODELS.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
      if (!model) return { type: 'response', command: cmd.type, success: false, error: 'Model not found' };
      composerModel = model;
      composerThinking = model.provider === 'zhipu' ? 'medium' : 'high';
      return { type: 'response', command: cmd.type, success: true, data: model };
    }
    case 'set_thinking_level':
      if (thinkingFailLevel && cmd.level === thinkingFailLevel) {
        return { type: 'response', command: cmd.type, success: false, error: '不支持的档位' };
      }
      composerThinking = cmd.level;
      return { type: 'response', command: cmd.type, success: true, data: {} };
    default:
      return { type: 'response', command: cmd.type, success: true, data: {} };
  }
}

/* ---------------- 服务 ---------------- */

/* P25: public backend snapshot only. These phases never load an SDK, open an
 * authorization URL, persist credentials, or alter the Composer model. */
let authPhase = 'native-list', authRevision = 0;
function providerAuthSnapshot() {
  const unknown = authPhase === 'unknown', connected = authPhase === 'connected';
  const descriptor = (providerId, displayName, methods) => ({
    providerId, displayName, authType: unknown ? 'unknown' : connected ? 'oauth' : 'unknown',
    source: unknown ? 'unknown' : 'pi', authenticated: unknown ? null : connected ? true : null,
    credentialStored: unknown ? null : connected, authConfigured: unknown ? null : connected,
    modelAvailable: null, canLogin: !unknown && methods.some(m => m.canLogin), canLogout: !unknown && connected,
    canConfigureKey: false, accountLabel: null, status: unknown ? 'unknown' : connected ? 'connected' : 'unknown',
    statusReason: unknown ? '未知（无法确认）' : connected ? 'Pi 确认已保存 OAuth 登录；远端有效性未确认' : 'Pi 未确认认证状态',
    methods, models: [],
  });
  const oauth = { type: 'oauth', label: 'ChatGPT 订阅', canLogin: true, isSubscription: true };
  const providers = [descriptor('openai', 'OpenAI', [oauth, { type: 'api-key', label: 'API Key', canLogin: false, isSubscription: false }]),
    descriptor('openai-codex', 'OpenAI Codex（legacy）', [oauth])];
  if (uxMode) {
    providers[0] = { ...providers[0], authenticated: true, authConfigured: true, credentialStored: true, authType: 'oauth', status: 'connected' };
    providers.push(descriptor('amazon-bedrock', 'Amazon Bedrock', []), descriptor('anthropic', 'Anthropic', []));
  }
  let flow = null;
  if (['browser', 'device', 'select'].includes(authPhase)) {
    flow = { id: 'offline-auth-flow', generation: 1, revision: authRevision, providerId: 'openai', operation: 'login',
      state: authPhase === 'browser' ? 'waiting-browser' : authPhase === 'device' ? 'waiting-device-code' : 'waiting-input',
      url: authPhase === 'select' ? null : 'https://auth.example.test/authorize?state=offline-fixture',
      userCode: authPhase === 'device' ? 'DEMO-2048' : null,
      prompt: authPhase === 'select' ? { id: 'offline-auth-prompt', type: 'select', options: [{ id: 'browser', label: '浏览器授权' }, { id: 'device', label: '设备码授权' }] } : null,
      errorCode: null, notice: authPhase === 'select' ? '请选择 Pi 提供的登录方式' : '离线视觉夹具：仅展示安全认证状态' };
  }
  return { ok: true, capability: { sdkAvailable: !unknown, reason: unknown ? '无法读取 Pi 认证状态（未知）' : null, piVersion: '1.0.0' }, providers, flow, sync: { state: 'idle', reason: null } };
}

/* P20.7 配置详情夹具：形状照抄 mcp-config.getDetail()。
 * 敏感值只以引用或 `secret:true` 出现，绝不写明文。 */
const MCP_CONFIG_DETAILS = {
  filesystem: {
    type: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\projects\\demo'],
    cwd: null, env: [], headers: [], oauth: false, auth: false,
    description: '在授权目录内读写文件，权限边界由你填写的目录决定。',
    timeout: null, exposure: 'direct', toolExposure: null, enabled: true,
  },
  github: {
    type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    cwd: null, oauth: false, auth: false,
    env: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '${GITHUB_TOKEN}', reference: true, secret: false }],
    headers: [], description: '浏览仓库、Issue 与 Pull Request；写操作仍由你明确发起。',
    timeout: 30, exposure: 'codemode', toolExposure: null, enabled: true,
  },
  linear: {
    type: 'http', command: null, args: [], cwd: null, env: [], headers: [],
    url: 'https://mcp.linear.app/mcp', urlPreview: 'https://mcp.linear.app/mcp', urlProtected: false,
    oauth: true, auth: false, description: '查询团队 Issue 与项目进度。',
    timeout: null, exposure: 'direct', toolExposure: null, enabled: false,
  },
  sentry: {
    type: 'http', command: null, args: [], cwd: null, env: [],
    headers: [{ key: 'Authorization', value: null, reference: false, secret: true }],
    url: 'https://mcp.sentry.dev/mcp', urlPreview: 'https://mcp.sentry.dev/mcp', urlProtected: false,
    oauth: true, auth: false, description: '检索错误事件与版本发布记录。',
    timeout: null, exposure: 'codemode', toolExposure: { search_issues: 'direct' }, enabled: true,
  },
};

let marketFixturePromise = null;
function mcpMarketFixture() {
  if (!marketFixturePromise) {
    marketFixturePromise = import('../server/mcp-market.js').then(({ createMcpMarket }) => createMcpMarket({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-mcp-visual-')),
      configStore: null,
    }));
  }
  return marketFixturePromise;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (p === '/api/extensions/packages' || p === '/api/extensions/market' || p === '/api/extensions/market/item') {
    return json(res, 200, await require('./fixtures/extension-market-ui.cjs')(req, url));
  }
  if (uxMode && p === '/api/__ux/stats') return json(res, 200, { ok: true, switchCount: uxSwitchCount, sessionId: harnessSessionId });
  if (uxMode && p === '/api/__ux/live-warning' && req.method === 'POST') {
    push({ type: 'extension_ui_request', method: 'notify', notifyType: 'warning', message: '实时验收警告，仅出现一次' });
    return json(res, 200, { ok: true });
  }
  if (recoveryMode && p === '/api/__recovery') {
    if (url.searchParams.has('state')) { recoveryState = url.searchParams.get('state'); recoveryRevision++; }
    const bus = await recoveryBus;
    if (url.searchParams.get('disconnect') === '1') bus.closeAll();
    return json(res, 200, { ...recoverySnapshot(), backlog: bus.backlog().length,
      historicalReady: bus.backlog().some(e => e.state === 'ready') });
  }
  if (p === '/api/__hotfix/no-project' && req.method === 'POST') {
    hotfixNoProject = url.searchParams.get('value') === '1';
    return json(res, 200, { ok: true });
  }

  if (p.startsWith('/api/__provider-auth/') && req.method === 'POST') {
    const phase = p.slice('/api/__provider-auth/'.length);
    if (!['native-list', 'browser', 'device', 'select', 'unknown', 'connected'].includes(phase)) return json(res, 400, { ok: false });
    authPhase = phase; authRevision++;
    return json(res, 200, providerAuthSnapshot());
  }
  if (p === '/api/provider-auth' && req.method === 'GET') return json(res, 200, providerAuthSnapshot());
  if (p.startsWith('/api/provider-auth/') && req.method === 'POST') {
    let payload; try { payload = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, code: 'input', error: '请输入当前 Pi 登录步骤要求的内容' }); }
    const action = p.slice('/api/provider-auth/'.length);
    if (['login', 'logout'].includes(action) && !['openai', 'openai-codex'].includes(payload.providerId)) return json(res, 400, { ok: false, code: 'unsupported', error: '离线夹具不支持此供应商' });
    if (action === 'login') authPhase = 'browser';
    else if (action === 'logout' || action === 'cancel') authPhase = 'native-list';
    else if (action === 'respond') {
      if (payload.flowId !== 'offline-auth-flow' || payload.promptId !== 'offline-auth-prompt' || !['browser', 'device'].includes(payload.value)) return json(res, 409, { ok: false, code: 'stale', error: '这条认证交互已失效，请读取当前状态' });
      authPhase = payload.value;
    } else if (action !== 'sync') return json(res, 400, { ok: false, code: 'unsupported', error: '离线夹具不支持此操作' });
    authRevision++;
    return json(res, 200, providerAuthSnapshot());
  }

  // Composer 视觉夹具：仅内存，不访问 Pi 或用户模型配置。
  if (p === '/api/__composer-models' && req.method === 'POST') {
    MODELS.splice(2, MODELS.length,
      { provider: 'zhipu', id: 'glm', name: 'GLM', reasoning: true },
      ...Array.from({ length: 100 }, (_, i) => ({ provider: 'openrouter', id: `router-${i}-` + 'long-model-id-'.repeat(12) })));
    composerModel = MODELS[0];
    composerThinking = 'high';
    for (const type of ['get_available_models', 'get_state', 'get_available_thinking_levels']) push(replyFor({ type }));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/__composer-reset' && req.method === 'POST') {
    MODELS.splice(0, MODELS.length, ...BASE_MODELS.map((model) => ({ ...model })));
    composerModel = MODELS[0];
    composerThinking = 'high';
    thinkingFailLevel = null;
    for (const type of ['get_available_models', 'get_state', 'get_available_thinking_levels']) push(replyFor({ type }));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/__thinking-mode' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { /* 默认清空 */ }
    thinkingFailLevel = typeof body.failLevel === 'string' && body.failLevel ? body.failLevel : null;
    return json(res, 200, { ok: true, failLevel: thinkingFailLevel });
  }

  if (process.env.HARNESS_VERBOSE && p.startsWith('/api/')) console.log(`${req.method} ${p}`);

  if (p === '/api/events') {
    if (recoveryMode) return (await recoveryBus).subscribe(req, res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': harness\n\n');
    if (res.flushHeaders) res.flushHeaders();
    clients.add(res);
    if (uxMode) for (const warning of uxWarnings) res.write('data: ' + JSON.stringify(warning) + '\n\n');
    req.on('close', () => clients.delete(res));

    // 等前端把 onopen/onmessage 挂好，再推 bridge_status 触发 boot()
    /* HARNESS_BOOT_DELAY_MS 只用于复现「boot 重建落在断言中间」的竞态
     * （P4-D 慢机偶发），默认值不变。 */
    setTimeout(() => push({ type: 'bridge_status', state: 'ready' }), Number(process.env.HARNESS_BOOT_DELAY_MS) || 250);
    return;
  }

  if (fileLinksMode && p === '/api/__file-links/info') {
    return json(res, 200, { ok: true, rootA: fileLinkWorld.rootA, rootB: fileLinkWorld.rootB });
  }
  if (fileLinksMode && (p === '/api/files' || p.startsWith('/api/files/'))) {
    return (await fileLinkFiles).handle(req, res, url);
  }
  if (ui4FilesMode && (p === '/api/files' || p.startsWith('/api/files/'))) {
    return (await ui4Files).handle(req, res, url);
  }

  if (p === '/api/status') {
    if (recoveryMode) return json(res, 200, { ok: true, ...recoverySnapshot() });
    if (hotfixNoProject) return json(res, 200, { ok: true, piRunning: false, cwd: null, hasProject: false });
    if (fileLinksMode) return json(res, 200, { ok: true, piRunning: true, pid: 0, args: ['--mode', 'rpc'], cwd: fileLinkWorld.rootA });
    return json(res, 200, { ok: true, piRunning: true, pid: 0, args: ['--mode', 'rpc'], cwd: process.cwd() });
  }

  /* Pi 运行时更新（Built-in Pi Updater）的夹具。**与 /api/update 分开**：
   * 那个是 Pi GUI 自己的更新。这里造「有新版本、但目标版本还没进兼容矩阵」——
   * 正是界面要显示未验收警告的那种真实状态。 */
  if (p === '/api/pi-update') {
    return json(res, 200, {
      ok: true, phase: 'available',
      currentVersion: '0.99.2', latestVersion: '1.0.0',
      packageName: '@earendil-works/pi-coding-agent',
      updateAvailable: true, verification: 'unverified',
      canUpdate: true, reason: null, cached: false, running: false,
      checkedAt: '2026-10-02T00:00:00.000Z',
    });
  }

  /* P21: 远端额度夹具。get_state 里的 provider 是 deepseek，所以启动后前端会拉这个端点。
   * 造的是 DeepSeek 真实形状（balance_infos 多币种）。 */
  if (p.startsWith('/api/quota/')) {
    const id = decodeURIComponent(p.slice('/api/quota/'.length));
    /* P21-Fix-4：单位未知的夹具（NewAPI 样式）——数值齐全，但没有单位证据。 */
    if (id === 'unknown-unit') {
      return json(res, 200, {
        ok: true,
        cached: false,
        quota: {
          providerId: 'unknown-unit',
          status: 'ok',
          balance: { amount: 75, currency: null, granted: null, toppedUp: null },
          balances: null,
          windows: { used: 25, limit: 100, remaining: 75, unit: null },
          rateLimit: null,
          resetAt: null,
          source: 'https://newapi.example.com/dashboard/billing/subscription',
          updatedAt: '2026-10-01T00:00:00.000Z',
          message: null,
        },
      });
    }
    if (id !== 'deepseek') return json(res, 200, { ok: false, error: 'unknown provider' });
    return json(res, 200, {
      ok: true,
      cached: false,
      quota: {
        providerId: 'deepseek',
        status: 'ok',
        balance: { amount: 110, currency: 'CNY', granted: 10, toppedUp: 100 },
        balances: [
          { amount: 110, currency: 'CNY', granted: 10, toppedUp: 100 },
          { amount: 15, currency: 'USD', granted: null, toppedUp: null },
        ],
        windows: null,
        rateLimit: null,
        resetAt: null,
        source: 'https://api.deepseek.com/user/balance',
        updatedAt: '2026-10-01T00:00:00.000Z',
        message: null,
      },
    });
  }

  /* P14-D Stage surfaces use deterministic fixtures, never the developer's repository. */
  if (p === '/api/__work-surface/git-clean') {
    workSurfaceGitClean = url.searchParams.get('value') === '1';
    return json(res, 200, { ok: true, clean: workSurfaceGitClean });
  }
  if (p === '/api/git/restore-all' && req.method === 'POST') return json(res, 200, {
    ok: false, needsPlan: true, total: 3,
    plan: { total: 3, plain: ['public/app.js'], staged: ['docs/说明.md'], untracked: ['new/fixture.txt'], skipped: [] },
  });
  if (p === '/api/git/status') return json(res, 200, {
    ok: true, isRepo: true, projectRoot: 'C:\\pi-GUI', files: workSurfaceGitClean ? [] : [
      { path: 'public/app.js', status: 'M', index: ' ', worktree: 'M', staged: false, untracked: false, isDir: false, additions: 12, deletions: 3, binary: false, oldPath: null },
      { path: 'docs/说明.md', status: 'A', index: 'A', worktree: ' ', staged: true, untracked: false, isDir: false, additions: 4, deletions: 0, binary: false, oldPath: null },
      { path: 'new/fixture.txt', status: '??', index: '?', worktree: '?', staged: false, untracked: true, isDir: false, additions: 2, deletions: 0, binary: false, oldPath: null },
    ],
  });
  if (p === '/api/git/diff' && req.method === 'POST') return json(res, 200, {
    ok: true, isRepo: true, path: 'public/app.js', untracked: false, isDir: false, binary: false,
    working: 'diff --git a/public/app.js b/public/app.js\n@@ -1,2 +1,2 @@\n-old line\n+new line\n',
    staged: '', truncated: false, limit: 524288, notice: '', context: null,
  });
  /* 技能视觉验收的形态开关：只改内存夹具，不写任何目录。 */
  if (p === '/api/__skills/mode' && req.method === 'POST') {
    let mode = {};
    try { mode = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { mode = {}; }
    for (const key of ['trusted', 'empty', 'error', 'restartPending']) if (typeof mode[key] === 'boolean') skillsMode[key] = mode[key];
    return json(res, 200, { ok: true, ...skillsMode });
  }
  if (p === '/api/skills' && req.method === 'GET') {
    if (skillsMode.error) return json(res, 500, { ok: false, code: 'fixture', error: '读取技能失败（视觉夹具模拟）' });
    return json(res, 200, harnessSkillsPayload());
  }
  if (p === '/api/skills/check' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { body = {}; }
    const content = body.kind === 'create'
      ? `---\nname: ${String(body.name || 'new-skill')}\ndescription: ${String(body.description || '')}\n---\n${String(body.body || '')}`
      : '';
    return json(res, 200, {
      ok: true, errors: [], warnings: [], content,
      bytes: Buffer.byteLength(content || String(body.content || '')),
    });
  }
  if (p === '/api/skills/create' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { body = {}; }
    const name = String(body.name || 'new-skill');
    return json(res, 200, {
      ok: true, id: 'a0000000000000aa', name, requestedName: name, renamed: false, replaced: false,
      target: body.target || 'user-pi', targetLabel: '~/.pi/agent/skills', scope: 'user',
      path: SKILL_AGENT + '\\skills\\' + name + '\\SKILL.md', fileCount: 1, warnings: [],
      notice: `已创建 ${name}。`, restartRequired: true, undo: 'a'.repeat(24),
    });
  }
  if (p === '/api/skills/import/stage' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { body = {}; }
    const files = Array.isArray(body.files) && body.files.length ? body.files : [{ path: 'SKILL.md', data: '' }];
    const sizeOf = (file) => Math.max(1, Math.round(String((file && file.data) || '').length * 3 / 4));
    return json(res, 200, {
      ok: true, stageId: 'b'.repeat(24),
      plan: {
        kind: body.kind === 'dir' ? 'dir' : 'file',
        suggestedName: 'claude-notes', declaredName: 'claude-notes',
        description: '把会议记录整理成结构化笔记：结论、待办、负责人。',
        fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + sizeOf(file), 0),
        files: files.map((file) => ({ path: String(file.path || 'SKILL.md'), size: sizeOf(file) })),
        skipped: body.kind === 'dir' ? [{ path: '.DS_Store', reason: '隐藏文件' }] : [],
        problems: [],
      },
    });
  }
  if (p === '/api/skills/import/commit' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { body = {}; }
    const name = String(body.name || 'claude-notes');
    return json(res, 200, {
      ok: true, id: 'a0000000000000bb', name, target: body.target || 'user-pi', targetLabel: '~/.pi/agent/skills',
      fileCount: 1, warnings: [], notice: `已导入 ${name}。`, restartRequired: false, undo: 'c'.repeat(24),
    });
  }
  if (p === '/api/skills/external' && req.method === 'GET') return json(res, 200, EXTERNAL_SCAN);
  if (p === '/api/skills/external/import' && req.method === 'POST') {
    await readBody(req);
    return json(res, 200, {
      ok: true, imported: 1, skipped: 0, failed: 0, target: 'user-pi', targetLabel: '~/.pi/agent/skills',
      restartRequired: false, undo: 'e'.repeat(24), notice: '已导入 1 个技能。',
      results: [{ id: 'd000000000000001', name: 'portable', status: 'imported', error: '' }],
    });
  }
  if (p === '/api/skills/market' && req.method === 'GET') {
    return json(res, 200, {
      ok: true, sources: MARKET_SOURCES, entries: MARKET_ENTRIES, categories: MARKET_CATEGORIES,
      hosts: ['api.github.com', 'cdn.jsdelivr.net', 'data.jsdelivr.com', 'raw.githubusercontent.com'],
      persistent: true, limits: { maxCustomSources: 20, pageSize: 24 },
    });
  }
  if (p === '/api/skills/market/refresh' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { body = {}; }
    const source = MARKET_SOURCES.find((item) => item.id === body.sourceId) || MARKET_SOURCES[0];
    return json(res, 200, { ok: true, refreshed: true, source });
  }
  if (p === '/api/skills/market/sources' && req.method === 'POST') {
    await readBody(req);
    return json(res, 200, { ok: true, sources: MARKET_SOURCES });
  }
  if (p === '/api/skills/market/preview' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { body = {}; }
    return json(res, 200, harnessMarketPreview(body.entryId));
  }
  if (p.startsWith('/api/skills/market/preview/') && req.method === 'GET') {
    const rest = p.slice('/api/skills/market/preview/'.length).split('/');
    if (rest.length === 2 && rest[1] === 'file') {
      const relPath = url.searchParams.get('path') || 'SKILL.md';
      const text = relPath === 'SKILL.md' ? harnessMarketPreview('').content
        : relPath.endsWith('.md') ? '# 审查清单\n\n- 边界与失败路径\n- 状态由谁持有\n- 回滚方式\n'
          : 'export const report = () => {};\n';
      return json(res, 200, { ok: true, path: relPath, binary: false, text, size: Buffer.byteLength(text), truncated: false });
    }
    return json(res, 404, { ok: false, error: '找不到这个预览' });
  }
  if (p === '/api/skills/market/install' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { body = {}; }
    const name = String(body.name || 'code-review');
    return json(res, 200, {
      ok: true, id: 'a0000000000000cc', name, target: body.target || 'user-pi', targetLabel: '~/.pi/agent/skills',
      fileCount: 3, warnings: [], notice: `已安装 ${name}。`, restartRequired: false,
      undo: '1'.repeat(24), partial: false,
    });
  }
  if (p.startsWith('/api/skills/undo/') && req.method === 'POST') {
    return json(res, 200, { ok: true, name: 'code-review', warnings: [], restartRequired: false });
  }
  if (p.startsWith('/api/skills/') && p.endsWith('/source') && (req.method === 'GET' || req.method === 'PUT')) {
    const id = decodeURIComponent(p.slice('/api/skills/'.length, p.length - '/source'.length)).replace(/\/$/, '');
    const rec = HARNESS_SKILLS.find((skill) => skill.id === id);
    if (!rec) return json(res, 404, { ok: false, error: '找不到这个 skill，刷新一下列表' });
    if (req.method === 'GET') return json(res, 200, harnessSkillSource(rec));
    await readBody(req);
    return json(res, 200, {
      ok: true, id: rec.id, name: rec.name, notice: `已保存 ${rec.name}。`,
      warnings: [], restartRequired: true, undo: 'a'.repeat(24),
    });
  }
  if (p.startsWith('/api/skills/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/skills/'.length));
    const rec = HARNESS_SKILLS.find((skill) => skill.id === id);
    return json(res, 200, {
      ok: true, id, name: rec ? rec.name : 'skill', notice: `已删除 ${rec ? rec.name : '技能'}。`,
      warnings: [], restartRequired: true, undo: 'd'.repeat(24),
    });
  }
  if (p.startsWith('/api/skills/') && req.method === 'GET') {
    /* 详情形状照抄 server/skills.js 的 handleDetail；只读。 */
    const rec = HARNESS_SKILLS.find((skill) => skill.id === decodeURIComponent(p.slice('/api/skills/'.length)));
    if (!rec) return json(res, 404, { ok: false, error: '找不到这个 skill，刷新一下列表' });
    const content = `---\nname: ${rec.name}\ndescription: ${rec.description}\n---\n# ${rec.name}\n\n这是可复现的 SKILL.md 详情。\n`;
    return json(res, 200, {
      ok: true, skill: rec, readable: true, truncated: false, bytes: Buffer.byteLength(content), content,
      files: [{ name: 'SKILL.md', dir: false, size: Buffer.byteLength(content) }, { name: 'scripts', dir: true, size: 0 }], note: '',
    });
  }
  /* P22：Capability 视图的夹具。三种证据同时存在才有意义：
   * 装好且已加载的 Web、装了但被停用的 Memory、以及一个**完全不认识**的 Extension
   * —— 最后这条是「unknown Extension 不能丢」的视觉证据。 */
  if (p === '/api/__capability/registry-fail') {
    capabilityRegistryFail = url.searchParams.get('value') === '1';
    return json(res, 200, { ok: true, registryFail: capabilityRegistryFail });
  }
  /* P24：一键安装的控制面。夹具**不执行任何命令**，只模拟官方命令的两种结局：
   * 立刻完成、或挂住（截图期间用）。响应形状照抄后端契约：
   * `commandCompleted` 表示「命令跑完了」，`loaded` 恒为 null（装没装由 Registry 回答）。 */
  if (p === '/api/__capability/install-hold') {
    capabilityInstallHold = url.searchParams.get('value') === '1';
    if (!capabilityInstallHold && capabilityInstallRelease) {
      capabilityInstallRelease();
      capabilityInstallRelease = null;
    }
    return json(res, 200, { ok: true, hold: capabilityInstallHold });
  }
  if (p === '/api/__capability/install-release') {
    if (capabilityInstallRelease) {
      capabilityInstallRelease();
      capabilityInstallRelease = null;
    }
    return json(res, 200, { ok: true });
  }
  if (p === '/api/capabilities/install' && req.method === 'POST') {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      body = {};
    }
    capabilityInstallCalls.push({ capabilityId: typeof body.capabilityId === 'string' ? body.capabilityId : null });
    if (capabilityInstallHold) {
      await new Promise((resolve) => {
        capabilityInstallRelease = resolve;
        setTimeout(resolve, 15000);
      });
      capabilityInstallRelease = null;
    }
    return json(res, 200, {
      ok: true, code: 'installed', phase: 'installed',
      capabilityId: typeof body.capabilityId === 'string' ? body.capabilityId : null,
      commandCompleted: true, exitCode: 0, restarted: true, loaded: null,
    });
  }
  if (p === '/api/extensions' && capabilityRegistryFail) return json(res, 200, {
    ok: false, error: '扩展发现失败', extensions: [], diagnostics: [],
  });
  if (p === '/api/extensions') return json(res, 200, {
    ok: true, hasProject: true, piReachable: true, diagnostics: [],
    extensions: [
      { id: 'ext-web', name: 'pi-web-access', displayName: 'pi-web-access', version: '1.4.0',
        description: '联网搜索与抓取网页正文', source: { type: 'npm', location: 'C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\pi-web-access' },
        scope: 'global', state: { installed: true, enabled: true, loaded: true, restartRequired: null, error: null },
        capabilities: [{ type: 'command', id: 'web' }], configurable: false, declarations: 1 },
      { id: 'ext-memory', name: 'pi-memory', displayName: 'pi-memory', version: '0.4.2',
        description: '跨会话长期记忆', source: { type: 'npm', location: 'C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\pi-memory' },
        scope: 'global', state: { installed: true, enabled: false, loaded: null, restartRequired: true, error: null },
        capabilities: [], configurable: false, declarations: 1 },
      { id: 'fixture-extension', name: 'example-tools', displayName: 'example-tools',
        version: '1.2.3', description: '夹具扩展，仅用于展示', source: { type: 'local', location: 'C:\\fixture\\.pi\\extensions\\example-tools.ts' },
        scope: 'project', state: { installed: true, enabled: true, loaded: true, restartRequired: null, error: null },
        capabilities: [{ type: 'command', id: 'example', displayName: 'example' }], configurable: false, declarations: 1 },
      { id: 'ext-unknown', name: 'acme-toolkit', displayName: 'acme-toolkit', version: null,
        description: null, source: { type: 'local', location: 'C:\\fixture\\.pi\\extensions\\acme.ts' },
        scope: 'project', state: { installed: true, enabled: null, loaded: null, restartRequired: null, error: null },
        capabilities: [], configurable: false, declarations: 1 },
      { id: 'ext-broken', name: 'broken-extension', displayName: 'broken-extension', version: null,
        description: null, source: { type: 'local', location: 'C:\\fixture\\.pi\\extensions\\broken.ts' },
        scope: 'global', state: { installed: true, enabled: null, loaded: false, restartRequired: null,
          error: { extensionId: 'ext-broken', phase: 'load', message: 'Pi 报告扩展执行或加载错误' } },
        capabilities: [], configurable: false, declarations: 1 },
    ],
    capabilityRegistry: { commands: [{ name: 'example', extensionId: 'fixture-extension' }], tools: [], toolRegistryAvailable: false },
    actions: { install: false, toggle: false, remove: false, refresh: true, restart: true },
  });
  /* P19 能力报告：形状照抄 server/approval-probe.js 的输出。 */
  if (p === '/api/approvals/capability') return json(res, 200, {
    ok: true, piVersion: '0.99.2',
    checks: {
      toolCallHook: { supported: true, evidence: 'dist/core/extensions/types.d.ts: block?: boolean' },
      uiPromptDialog: { supported: true, evidence: 'docs/rpc.md: block until the client sends back an extension_ui_response' },
      coreApproval: { supported: false, evidence: 'docs/usage.md: no permission popups' },
      customUiOverRpc: { supported: false, evidence: 'dist/modes/rpc/rpc-mode.js: Custom UI not supported in RPC mode' },
    },
  });
  if (p === '/api/mcp') return json(res, 200, {
    /* P20.5：形状照抄 0.99.1 的真实报告 —— 它确实带 builtin:mcp。
     * （0.87.0 的形态见 tests/pi-version.cjs 的 fixture。） */
    ok: true,
    supported: true,
    piVersion: '0.99.1',
    version: { value: '0.99.1', source: 'package.json', status: 'known', updatedAt: '2026-10-01T03:00:00.000Z' },
    reason: '这个 pi 包自带 built-in 扩展 `mcp`（配置走 pi 自己的 mcp.json，命令行是 pi mcp add / remove）',
    evidence: 'dist/extensions/index.js: { name: "mcp", factory: mcpExtension, replaceable: true, builtin: true }',
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
    rpc: { commandCount: 33, commands: ['abort', 'get_commands', 'prompt'], toolListCommand: false, note: 'Pi RPC 没有已注册工具清单命令：ExtensionAPI 有 getAllTools()，但那是扩展进程内的 API，RPC 不暴露它。所以 GUI 不伪造工具注册表。' },
    mcpConfig: { user: { exists: false }, project: { exists: false } },
    mcpCli: { available: true, evidence: '`pi mcp add` and `pi mcp remove` edit the file from a shell' },
    extensionRoute: { note: '请通过 pi extension 提供能力。', user: { exists: false, count: 0, entries: [] }, project: { exists: false, count: 0, entries: [] }, fromSettings: [], packages: [] },
  });
  /* P20.6 原生 MCP 的截图夹具：给一幅有代表性的摘要（active + 两个 server +
     一次运行时状态），形状照抄后端真实返回。 */
  if (p === '/api/mcp/servers') return json(res, 200, {
    ok: true,
    fresh: true,
    at: '2026-10-01T06:00:00.000Z',
    native: { state: 'active', replaced: false, disabled: false, builtinPresent: true, reason: 'builtin:mcp 在包里、未被禁用、未被接管' },
    trust: { trusted: true, requiresTrust: true },
    files: {
      user: { exists: true, path: '~/.pi/agent/mcp.json' },
      project: { exists: true, path: '.pi/mcp.json' },
    },
    servers: [
      { name: 'filesystem', scope: 'user', enabled: true, exposure: 'direct', transportType: 'stdio', description: '在授权目录内读写文件，权限边界由你填写的目录决定。', argsCount: 3, hasSecrets: false, toolExposure: null, toolExposureNote: '', overridden: false, effective: { active: true, reason: '' } },
      { name: 'github', scope: 'user', enabled: true, exposure: 'codemode', transportType: 'stdio', description: '浏览仓库、Issue 与 Pull Request；写操作仍由你明确发起。', argsCount: 2, hasSecrets: true, toolExposure: null, toolExposureNote: '', overridden: false, effective: { active: true, reason: '' } },
      { name: 'linear', scope: 'user', enabled: false, exposure: 'direct', transportType: 'http', description: '查询团队 Issue 与项目进度。', argsCount: 0, hasSecrets: true, toolExposure: null, toolExposureNote: '', overridden: false, effective: { active: false, reason: 'disabled' } },
      { name: 'sentry', scope: 'project', enabled: true, exposure: 'codemode', transportType: 'http', description: '检索错误事件与版本发布记录。', argsCount: 0, hasSecrets: false, toolExposure: { search_issues: 'direct' }, toolExposureNote: '', overridden: false, effective: { active: true, reason: '' } },
    ],
    configInvalid: [],
    configError: { user: '', project: '' },
    runtime: {
      at: '2026-10-01T06:00:00.000Z', cached: false, ok: true, code: '', error: '', errors: [], exitCode: 0,
      servers: [
        { name: 'filesystem', scope: 'user', enabled: true, exposure: 'direct', transportType: 'stdio', state: 'connected', toolCount: 12, tools: [], error: '', hasSecrets: false, toolExposure: null, configured: true },
        { name: 'github', scope: 'user', enabled: true, exposure: 'codemode', transportType: 'stdio', state: 'failed', toolCount: 0, tools: [], error: 'connection closed during initialize', hasSecrets: true, toolExposure: null, configured: true },
        { name: 'sentry', scope: 'project', enabled: true, exposure: 'codemode', transportType: 'http', state: 'needs-auth', toolCount: 0, tools: [], error: '', hasSecrets: false, toolExposure: { search_issues: 'direct' }, configured: true },
      ],
    },
  });
  if (p === '/api/mcp/status') return json(res, 200, { ok: true, at: '2026-10-01T06:00:00.000Z', cached: false, servers: [], errors: [] });

  /* P20.7 配置管理夹具：GET /api/mcp/config 与详情。只用于视觉核对，
   * 不写任何 mcp.json。 */
  if (p === '/api/mcp/config' && req.method === 'GET') {
    const scope = url.searchParams.get('scope') || 'user';
    const name = url.searchParams.get('name') || '';
    const revisions = { user: 'sha256-visual-user', project: 'sha256-visual-project' };
    const limits = { nameMax: 64, commandMax: 512, argsMax: 32, argMax: 1024, descriptionMax: 200, timeoutMax: 3600, envMax: 64, headersMax: 32 };
    if (!name) return json(res, 200, { ok: true, revisions, limits });
    const entry = MCP_CONFIG_DETAILS[name];
    if (!entry) return json(res, 200, { ok: false, code: 'not-found', error: `mcp.json 里没有 “${name}”`, revisions });
    return json(res, 200, { ok: true, scope, name, revision: revisions[scope] || revisions.user, trust: { trusted: true, requiresTrust: true }, overrideOnly: false, entry, revisions });
  }
  if (p === '/api/mcp/market' && req.method === 'GET') {
    const fixture = await mcpMarketFixture();
    const params = Object.fromEntries(url.searchParams.entries());
    if (marketProgressMode && params.progress === '1') {
      return json(res, 200, {
        ok: true, active: true, done: false, pages: 2, items: 144,
        startedAt: Date.now(), finishedAt: null,
      });
    }
    if (marketProxyMode && params.source === 'registry') {
      const base = await fixture.list({ source: 'builtin', limit: 1 });
      return json(res, 200, {
        ok: true, source: 'registry', total: 1, hasMore: false, nextCursor: null,
        categories: ['全部', '开发工具'], sources: fixture.sources(),
        items: [{ ...base.items[0], id: 'registry:io.example/proxy', source: 'registry', sourceLabel: '官方 Registry', trust: 'unverified' }],
        network: { route: 'proxied', source: 'system-proxy', addressVerified: false, dns: 'proxy', fakeIp: true },
      });
    }
    if (marketStaleMode && params.source === 'registry') {
      const base = await fixture.list({ source: 'builtin', limit: 1 });
      const all = Array.from({ length: 48 }, (_, i) => {
        const id = `registry:io.example/stale-${String(i).padStart(2, '0')}`;
        return {
          ...base.items[0], id, source: 'registry', sourceLabel: '官方 Registry',
          catalogId: id, name: `Cached Registry ${i}`, installName: `cached-${i}`,
          identifier: `io.example/stale-${i}`, version: '1.0.0', category: '开发工具',
          trust: 'registry', trustEvidence: 'MCP 官方 Registry 收录；收录不代表安全性审核',
          description: `Last successfully loaded registry server ${i}`,
        };
      });
      const pageSize = Math.max(1, Number(params.pageSize || 24));
      const page = Math.max(1, Number(params.page || 1));
      return json(res, 200, {
        ok: true, source: 'registry', total: all.length, page, pageSize,
        totalPages: Math.ceil(all.length / pageSize), hasMore: false, nextCursor: null,
        categories: ['全部', '开发工具'], sources: fixture.sources(),
        items: all.slice((page - 1) * pageSize, page * pageSize),
        stale: true,
        refreshError: { code: 'network', error: '无法连接市场源（fixture 诊断细节，不应出现在界面）' },
        network: { route: 'direct', source: 'direct', addressVerified: true, dns: 'system', fakeIp: false },
      });
    }
    if (marketPaginationMode && params.source === 'registry') {
      const base = await fixture.list({ source: 'builtin', limit: 1 });
      const all = Array.from({ length: 209 }, (_, i) => {
        const index = String(i).padStart(3, '0');
        const id = `registry:io.example/server-${index}`;
        return {
          ...base.items[0], id, source: 'registry', sourceLabel: '官方 Registry',
          catalogId: id, name: `Registry ${index}`, installName: `registry-${index}`,
          identifier: `io.example/server-${index}`, version: '1.0.0',
          category: i % 2 === 0 ? '开发工具' : '效率',
          trust: 'registry', trustEvidence: 'MCP 官方 Registry 收录；收录不代表安全性审核',
          description: `Fixture registry server ${index}`,
        };
      }).filter((item) => {
        if (params.category && params.category !== '全部' && item.category !== params.category) return false;
        const q = String(params.q || '').trim().toLowerCase();
        return !q || `${item.name} ${item.identifier} ${item.description}`.toLowerCase().includes(q);
      });
      const pageSize = Math.max(1, Number(params.pageSize || 24));
      /* 边加载边显示截图：先只返回前 144 条（6 页），不拖慢；等前端轮询
       * 到下一次（非 partial）时再拖 2.5s 返回完整 209 条。 */
      if (marketProgressMode && params.partial === '1' && !marketPartialServed) {
        marketPartialServed = true;
        const loaded = all.slice(0, 144);
        const loadedPages = Math.ceil(loaded.length / pageSize);
        const page = loadedPages ? Math.min(Math.max(1, Number(params.page || 1)), loadedPages) : 1;
        const start = (page - 1) * pageSize;
        return json(res, 200, {
          ok: true, source: 'registry', partial: true, loading: true,
          loaded: loaded.length, loadedPages,
          progress: { pages: 2, items: 144 },
          page, pageSize,
          categories: ['全部', '开发工具', '效率'], sources: fixture.sources(),
          items: loaded.slice(start, start + pageSize),
          network: { route: 'proxied', source: 'system-proxy', addressVerified: false, dns: 'proxy', fakeIp: true },
        });
      }
      if (marketProgressMode) await new Promise((resolve) => setTimeout(resolve, 2500));
      const total = all.length;
      const totalPages = total ? Math.ceil(total / pageSize) : 0;
      const page = totalPages ? Math.min(Math.max(1, Number(params.page || 1)), totalPages) : 1;
      const start = (page - 1) * pageSize;
      return json(res, 200, {
        ok: true, source: 'registry', total, page, pageSize, totalPages,
        hasMore: page < totalPages, nextCursor: null,
        categories: ['全部', '开发工具', '效率'], sources: fixture.sources(),
        items: all.slice(start, start + pageSize),
        network: { route: 'proxied', source: 'system-proxy', addressVerified: false, dns: 'proxy', fakeIp: true },
      });
    }
    const result = await fixture.list(params);
    return json(res, 200, { ...result, sources: fixture.sources() });
  }
  if (p === '/api/mcp/market/sources' && req.method === 'GET') {
    const fixture = await mcpMarketFixture();
    return json(res, 200, fixture.sources());
  }


  /* P23：诊断面板的夹具（形状照抄 GET /api/diagnostics 的真实返回）。
   * 这里刻意让**三种核对状态**同时出现：已核对的 pi、未核对的 Extension、
   * 以及一条 false 的 probe —— 截图要能看出三值分得开。 */
  if (p === '/api/diagnostics') return json(res, 200, {
    ok: true,
    diagnostics: {
      schemaVersion: 1,
      generatedAt: '2026-10-02T00:00:00.000Z',
      app: { id: 'pi-gui', version: '0.15.0' },
      system: { platform: 'win32', arch: 'x64', node: 'v24.14.0', os: 'Windows_NT', release: '10.0.26100' },
      project: { selected: true, name: 'pi-GUI', readable: true, writable: true },
      data: { readable: true, writable: true },
      bridge: { piRunning: true, bridgeRun: 12, hasProject: true, args: ['--mode', 'rpc'] },
      pi: {
        configuredBin: 'pi', available: true, version: '0.99.2',
        versionSource: 'package.json',
        verification: { status: 'verified', verifiedAgainst: { version: '0.99.2', verifiedAt: '2026-10-01', scope: 'historical' }, relative: 'same' },
        launch: { source: 'path', binName: 'pi.cmd', entryKnown: true, packageDirKnown: true },
      },
      agents: [{ id: 'pi', available: true, version: '0.99.2', reason: null, capabilities: null }],
      mcp: {
        supported: true, piVersion: '0.99.2', error: null,
        native: { fresh: true, state: 'active', reason: 'builtin:mcp 在包里、未被禁用、未被接管', replaced: false, disabled: null, builtinPresent: true, serverCount: 2, trust: true },
      },
      probes: {
        at: '2026-10-02T00:00:00.000Z',
        packageKnown: true,
        summary: { total: 14, supported: 8, unsupported: 0, unknown: 6, unverified: ['rpc'] },
        items: [
          { id: 'rpc-commands', kind: 'source', label: 'RPC 命令集', state: true, evidence: 'dist/modes/rpc/rpc-types.d.ts: RpcCommand 联合共 33 条' },
          { id: 'rpc-no-tool-list', kind: 'source', label: 'RPC 无工具清单命令', state: true, evidence: '33 条里没有 *tool*' },
          { id: 'extension-ui', kind: 'source', label: '扩展 UI 对话框子协议', state: true, evidence: 'docs/rpc-extension-ui.md: block until the client sends back an extension_ui_response' },
          { id: 'approval-hook', kind: 'source', label: 'tool_call 可阻断', state: true, evidence: 'block?: boolean;；tool_call can mutate input or block execution.' },
          { id: 'core-approval', kind: 'source', label: '核心自带审批闸门', state: null, evidence: 'docs/usage.md 里没有明确说法，不能据此断言核心有没有审批' },
          { id: 'builtin-mcp', kind: 'source', label: 'builtin:mcp', state: true, evidence: 'builtInExtensions: llama.cpp / codemode / tool-search / mcp' },
          { id: 'mcp-runtime-states', kind: 'source', label: 'MCP 运行时状态闭集', state: true, evidence: 'closed / connected / connecting / disconnected / failed / needs-auth' },
          { id: 'rpc', kind: 'runtime', label: 'RPC 通道真的通了', state: true, evidence: '来自 pi-compat 的能力三值' },
          { id: 'mcp-native', kind: 'runtime', label: 'Native MCP 生效', state: true, evidence: '原生状态：active' },
        ],
      },
      matrix: {
        piBaselines: [
          { version: '0.87.0', verifiedAt: '2026-09-30', scope: 'historical' },
          { version: '0.99.1', verifiedAt: '2026-10-01', scope: 'historical' },
          { version: '0.99.2', verifiedAt: '2026-10-01', scope: 'historical' },
          { version: '1.0.0', verifiedAt: '2026-10-02', scope: 'current' },
        ],
        currentBaseline: '1.0.0',
        extensionBaselines: [
          { name: 'pi-web-access', version: '0.33.0', verifiedAt: '2026-09-30' },
          { name: 'pi-subagents', version: '0.73.1', verifiedAt: '2026-09-30' },
          { name: 'pi-memory', version: '0.4.2', verifiedAt: '2026-09-30' },
          { name: 'pi-browser-harness', version: '0.11.0', verifiedAt: '2026-10-01' },
        ],
        nativeMcp: { builtinId: 'mcp', replaceable: true, serverStates: [], exposures: [], cliSubcommands: [] },
        knownDifferences: [
          { id: 'approval-doc-wording', between: '0.87.0 / 0.99.1 → 0.99.2', affects: 'P19 Approval 能力报告' },
          { id: 'dialog-doc-moved', between: '0.87.0 / 0.99.1 → 0.99.2', affects: 'P19 / P23 契约 probe' },
          { id: 'iserror-propagation', between: '0.87.0 → 0.99.1', affects: 'P18 / P20 成功证据' },
        ],
      },
      extensions: {
        discovered: 5,
        items: [
          { name: 'pi-web-access', version: '1.4.0', scope: 'global', installed: true, loaded: true },
          { name: 'pi-memory', version: '0.4.2', scope: 'global', installed: true, loaded: null },
        ],
      },
      checks: [
        { id: 'data-readable', ok: true },
        { id: 'data-writable', ok: true },
        { id: 'project-readable', ok: true },
        { id: 'project-writable', ok: true },
        { id: 'pi-running', ok: true },
      ],
      compatibility: {
        status: 'compatible', detected: true, piVersion: '0.99.2', versionKnown: true,
        versionSource: { source: 'package.json', status: 'known', updatedAt: '2026-10-02T00:00:00.000Z' },
        versionVerification: { verification: 'verified', verifiedAgainst: { version: '0.99.2', verifiedAt: '2026-10-01', scope: 'historical' }, relative: 'same' },
        capabilities: { rpc: true, getState: true, getMessages: true, newSession: true, switchSession: true, sessionNaming: true, toolEvents: true, extensionUi: true, sessionJsonl: true },
        missing: [], unverified: [],
        protocol: { expected: 1, observed: 1 },
        schema: { unknownFields: [], unknownEnums: [] },
        issues: [],
      },
      privacy: {
        absolutePathsIncluded: false, conversationContentIncluded: false, configFileContentIncluded: false,
        environmentIncluded: false, protocolPayloadsIncluded: false, schemaDriftValuesIncluded: false, redactionApplied: true,
      },
    },
  });

  /* UI-5：日志与故障报告的离线夹具。只用于界面/截图，不是用户日志。 */
  if (p === '/api/logs/status') return json(res, 200, {
    ok: true,
    status: {
      ok: true, version: 1, role: 'backend', appVersion: '0.25.0',
      enabled: true, mode: 'standard', verboseUntil: null, verboseExpired: false,
      retentionDays: 7, maxTotalMB: 20, maxFileBytes: 4194304,
      dirWritable: true, degraded: false, lastErrorCode: null, writeFailures: 0, droppedRecords: 0,
      settingsCorrupt: false, usageBytes: 73728, fileCount: 3, crashFileCount: 1,
      files: [
        { name: 'app-20261017.jsonl', role: 'app', kind: 'normal', size: 58368, date: '2026-10-17' },
        { name: 'main-20261017.jsonl', role: 'main', kind: 'normal', size: 7168, date: '2026-10-17' },
        { name: 'app-crash-20261017.jsonl', role: 'app', kind: 'crash', size: 8192, date: '2026-10-17' },
      ],
      session: { startedAt: '2026-10-17T11:30:00.000Z', previousUnclean: null },
      recentErrors: [
        { timestamp: '2026-10-17T11:59:00.000Z', level: 'ERROR', source: 'pi-bridge', event: 'bridge.request_timeout', code: 'BRIDGE_TIMEOUT', details: { operation: 'get_state', durationMs: 1200 } },
        { timestamp: '2026-10-17T11:58:00.000Z', level: 'WARN', source: 'runtime', event: 'runtime.owner_rejected', code: 'OWNER_STALE', details: { operation: 'resolve', reason: 'owner_stale' } },
      ],
    },
  });
  if (p === '/api/logs/entries') {
    const entries = [
      { v: 1, timestamp: '2026-10-17T11:59:00.000Z', level: 'ERROR', source: 'pi-bridge', event: 'bridge.request_timeout', code: 'BRIDGE_TIMEOUT', correlationId: 'corr-demo-1001', durationMs: 1200, process: 'backend', details: { operation: 'get_state', durationMs: 1200 }, cursor: 'fixture-1' },
      { v: 1, timestamp: '2026-10-17T11:58:00.000Z', level: 'WARN', source: 'runtime', event: 'runtime.owner_rejected', code: 'OWNER_STALE', correlationId: 'corr-demo-1002', process: 'backend', details: { operation: 'resolve', reason: 'owner_stale' }, cursor: 'fixture-2' },
      { v: 1, timestamp: '2026-10-17T11:57:00.000Z', level: 'INFO', source: 'renderer', event: 'network.sse_reconnect', process: 'renderer', details: { durationMs: 800 }, cursor: 'fixture-3' },
      { v: 1, timestamp: '2026-10-17T11:56:00.000Z', level: 'DEBUG', source: 'electron', event: 'electron.browser_view_state', process: 'main', details: { operation: 'attach', state: 'already_attached' }, cursor: 'fixture-4' },
    ];
    return json(res, 200, { ok: true, entries, nextCursor: null, truncated: false, scannedFiles: 3 });
  }
  if (p === '/api/logs/settings' && req.method === 'POST') {
    return json(res, 200, { ok: true, status: { ok: true, enabled: true, mode: 'standard', retentionDays: 7, maxTotalMB: 20, usageBytes: 73728, fileCount: 3, crashFileCount: 1, degraded: false, files: [], session: {}, recentErrors: [] } });
  }
  if (p === '/api/logs/export/preview' && req.method === 'POST') {
    return json(res, 200, { ok: true, windowMinutes: 30, entryCount: 24, errorCount: 2, truncated: false, filesIncluded: ['README.txt', 'report.md', 'diagnostics.json', 'events.jsonl', 'errors.jsonl'], files: [] });
  }
  if (p === '/api/logs/clear' && req.method === 'POST') return json(res, 200, { ok: true, fileCount: 3, bytes: 73728 });
  if (p === '/api/logs/events' && req.method === 'POST') return json(res, 200, { ok: true, accepted: 0 });

  if (p === '/api/projects') {
    if (req.method === 'DELETE') {
      hotfixNoProject = true;
      return json(res, 200, { ok: true, closedWorkspace: true });
    }
    if (hotfixNoProject) return json(res, 200, { ok: true, active: '', items: [] });
    return json(res, 200, {
      ok: true,
      active: 'C:\\pi-GUI',
      items: [
        { name: 'pi-GUI', path: 'C:\\pi-GUI' },
        { name: 'fermenter-notes', path: 'C:\\work\\fermenter-notes' },
      ],
    });
  }

  /* 会话列表（侧栏挂在当前项目那一行下面）。
   * 形状照抄后端真实返回 —— **不含任何绝对路径**，否则截图就没法用来看
   * 「界面上会不会漏出路径」。刻意混入一条已归档的，好让折叠组也出现在图里。 */
  /* 会话改名：只用于 P2 的渲染验收，内存中回显名字，不写任何文件。 */
  if (p === '/api/sessions/name' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    return json(res, 200, { ok: true, name: body.name || '' });
  }
  if (p === '/api/sessions/switch' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (body.id !== 'bbbbbbbbbbbbbbbb' && !(uxMode && body.id === 'aaaaaaaaaaaaaaaa')) return json(res, 200, { ok: false, error: '夹具中没有该会话' });
    harnessSessionId = body.id;
    if (uxMode) uxSwitchCount++;
    if (uxMode) for (const warning of uxWarnings) push(warning);
    return json(res, 200, { ok: true, id: body.id, title: '帮我把 README 的测试那节补全' });
  }
  if (p === '/api/__work-surface/session-reset') {
    harnessSessionId = 'aaaaaaaaaaaaaaaa';
    return json(res, 200, { ok: true });
  }
  /* AI 会话标题：只回内存状态，供设置页与菜单截图。 */
  if (p === '/api/session-titles/settings' && (req.method === 'GET' || req.method === 'PUT')) {
    if (req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      /* 真实磁盘写入不是瞬时的；留一个短延迟，让「保存中开关禁用」
       * 这个状态能被真实截图看到。 */
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (harnessTitleSettingsFail) {
        harnessTitleSettingsFail = false;
        return json(res, 200, { ok: false, code: 'io_error', error: '设置未能保存，请重试' });
      }
      if (typeof body.autoEnabled === 'boolean') harnessAutoTitle = body.autoEnabled;
    }
    return json(res, 200, {
      ok: true,
      settings: { autoEnabled: harnessAutoTitle },
      capability: { supported: true, reason: null },
      model: { mode: 'current-session', label: '跟随当前会话' },
    });
  }
  /* 仅供视觉取证：下一次标题设置保存失败，验证开关回滚与错误提示。 */
  if (p === '/api/__title-settings-fail' && req.method === 'POST') {
    harnessTitleSettingsFail = true;
    return json(res, 200, { ok: true });
  }
  /* 仅供视觉取证：推一条自动标题事件，走真实 SSE → 就地更新链路。
   * 用来在窄窗看英文/长标题在侧栏与顶部标题里的换行，不改会话夹具。 */
  /* 手动改名：视觉取证走真实的「接口 → 修订 → 就地更新」链路。
   * 只回内存结果，不写盘、不激活会话。 */
  if (p === '/api/session-titles/rename' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
    if (!title) return json(res, 200, { ok: false, code: 'invalid_title', error: '标题不能为空' });
    const runtime = body.scope === 'runtime';
    const sessionId = runtime ? null : harnessSessionIdFor(body.id);
    const key = runtime ? 'runtime:' + String(body.conversationId || '') : sessionId;
    const previousRevision = harnessTitleOverrides.get(key)?.revision || 0;
    const revision = Math.max(previousRevision + 1, (Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision : 0) + 1);
    harnessTitleOverrides.set(key, { title, revision });
    return json(res, 200, {
      ok: true, applied: true, title, source: 'manual', revision,
      sessionId, ...(runtime ? { conversationId: body.conversationId } : {}),
    });
  }
  if (p === '/api/__title' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const title = typeof body.title === 'string' ? body.title : '';
    if (!title) return json(res, 400, { ok: false });
    const revision = harnessTitleRevision++;
    push({ type: 'session_title', scope: 'classic', sessionId: String(body.sessionId || ''), title, source: 'auto', revision, at: new Date().toISOString() });
    return json(res, 200, { ok: true, title, revision });
  }
  /* 仅供 P2 取证：把 Pi 的实时 sessionName 置空，验证自动标题来自会话列表。 */
  if (p === '/api/__session-name' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    harnessSessionName = String(body.name || '');
    return json(res, 200, { ok: true, name: harnessSessionName });
  }
  /* 仅视觉取证：打开 Runtime 标题行夹具（之后才返回 worktrees / runtime 行）。 */
  if (p === '/api/__runtime-title-row' && req.method === 'POST') {
    harnessRuntimeTitleRow = true;
    return json(res, 200, { ok: true });
  }
  if (harnessRuntimeTitleRow && p === '/api/worktrees' && req.method === 'GET') {
    return json(res, 200, { ok: true, projectId: 'project-title-row', contextGeneration: 1, items: [] });
  }
  if (harnessRuntimeTitleRow && p === '/api/runtime-sessions' && req.method === 'GET') {
    const override = harnessTitleOverrides.get('runtime:' + HARNESS_RUNTIME_TITLE_ID);
    return json(res, 200, {
      ok: true,
      backendInstance: 'backend',
      items: [{
        conversationId: HARNESS_RUNTIME_TITLE_ID,
        createdAt: '2026-09-26T08:00:00.000Z',
        kind: 'project',
        workspace: { projectId: 'project-title-row', cwd: 'C:\\pi-GUI', branch: 'title-row' },
        nativeSessionId: 'native-title-row',
        sessionName: null,
        title: '修复登录接口超时',
        titleSource: 'auto',
        revision: 1,
        ...(override ? { title: override.title, titleSource: 'manual', titleRevision: override.revision } : {}),
        owner: null,
        lifecycle: 'dormant',
        activity: 'idle',
        attention: false,
        focused: false,
        error: null,
        stop: null,
      }],
    });
  }
  if (p === '/api/sessions') {
    if (url.searchParams.get('project') === 'C:\\work\\fermenter-notes') return json(res, 200, {
      ok: true, hasProject: true, currentId: null, diagnostics: [], sessions: [
        { id: 'eeeeeeeeeeeeeeee', title: '简单问候', current: false, archived: false, messageCount: 2, updatedAt: Date.now() },
        { id: 'ffffffffffffffff', title: '完全访问权限设置', current: false, archived: false, messageCount: 4, updatedAt: Date.now() },
        { id: '9999999999999999', title: '你好', current: false, archived: false, messageCount: 2, updatedAt: Date.now() },
      ],
    });
    const titled = (s) => {
      const value = harnessTitleOverrides.get(s.sessionId);
      return value ? { ...s, title: value.title, titleSource: 'manual', titleRevision: value.revision } : s;
    };
    return json(res, 200, {
      ok: true,
      hasProject: true,
      currentId: harnessSessionId,
      diagnostics: [],
      sessions: [
        { id: 'aaaaaaaaaaaaaaaa', title: '发酵罐空气分布器设计核算', sessionId: 'sid-cur', createdAt: '2026-09-25T10:00:00.000Z', lastMessageAt: '2026-09-25T10:30:00.000Z', updatedAt: Date.now() - 120000, messageCount: 12, current: harnessSessionId === 'aaaaaaaaaaaaaaaa', pending: false, archived: false, truncated: false },
        { id: 'bbbbbbbbbbbbbbbb', title: '帮我把 README 的测试那节补全', sessionId: 'sid-b', createdAt: '2026-09-25T08:00:00.000Z', lastMessageAt: '2026-09-25T09:00:00.000Z', updatedAt: Date.now() - 5400000, messageCount: 8, current: harnessSessionId === 'bbbbbbbbbbbbbbbb', pending: false, archived: false, truncated: false },
        { id: 'dddddddddddddddd', title: '检查 server.js 的路由顺序', sessionId: 'sid-d', createdAt: '2026-09-25T07:00:00.000Z', lastMessageAt: '2026-09-25T07:30:00.000Z', updatedAt: Date.now() - 9000000, messageCount: 21, current: false, pending: false, archived: false, truncated: false },
        { id: 'cccccccccccccccc', title: '上周的排查记录', sessionId: 'sid-c', createdAt: '2026-09-20T07:00:00.000Z', lastMessageAt: '2026-09-20T08:00:00.000Z', updatedAt: Date.now() - 400000000, messageCount: 5, current: false, pending: false, archived: true, truncated: false },
      ].map(titled),
    });
  }

  /* ---------- P7：Planner 与任务工作流 ----------
   *
   * 夹具服务原本没有桩这两个接口，于是「任务面板」与「会话头部的关联任务」
   * 在截图里都是空的 —— 那等于没验。这里补上，让 P7 的排版能被真看到。
   *
   * ⚠️ 顺序要紧：`/api/plans/relations` 必须排在 `/api/plans/` 前缀之前，
   * 否则会被当成「查一个 id 叫 relations 的计划」（与 router.js 同一类坑）。 */
  if (p === '/api/agents') {
    return json(res, 200, {
      ok: true,
      auto: 'pi',
      available: ['pi', 'codex'],
      activePlanId: null,
      hasProject: true,
      agents: [
        { id: 'pi', name: 'Pi', description: 'pi coding agent（本机主 Agent）', available: true, version: '0.87.0', reason: '', detail: '', capabilities: { streaming: true, cancellation: true, resume: true, toolEvents: true, sessionLinking: true }, notes: [], testOnly: false },
        { id: 'codex', name: 'Codex', description: 'OpenAI Codex CLI', available: true, version: '0.30.0', reason: '', detail: '', capabilities: { streaming: true, cancellation: true, resume: true, toolEvents: true, sessionLinking: false }, notes: [], testOnly: false },
        { id: 'claude', name: 'Claude Code', description: 'Anthropic Claude Code CLI', available: false, version: '', reason: 'not-installed', detail: '找不到 npm 包 @anthropic-ai/claude-code', capabilities: { streaming: false, cancellation: true, resume: false, toolEvents: false, sessionLinking: false }, notes: [], testOnly: false },
      ],
    });
  }

  if (p === '/api/plans/relations') {
    const sid = url.searchParams.get('sessionId') || '';
    return json(res, 200, {
      ok: true,
      hasProject: true,
      sessionId: sid,
      truncated: false,
      matches: sid === 'sid-cur'
        ? [
            { planId: 'plan-1', planTitle: '修复 SSE 重连问题', planStatus: 'running', taskId: 'backend', taskTitle: '修改后端', taskStatus: 'running', agent: 'pi', attempt: 2, startedAt: Date.now() - 60000, endedAt: null, success: false, filesChanged: ['server/rpc-bridge.js'] },
            { planId: 'plan-1', planTitle: '修复 SSE 重连问题', planStatus: 'running', taskId: 'tests', taskTitle: '补测试', taskStatus: 'pending', agent: 'pi', attempt: 1, startedAt: null, endedAt: null, success: false, filesChanged: [] },
          ]
        : [],
    });
  }

  if (p === '/api/plans') {
    return json(res, 200, {
      ok: true,
      hasProject: true,
      activePlanId: null,
      broken: [],
      plans: [
        { id: 'plan-1', title: '修复 SSE 重连问题', goal: '让 bridgeRun 的过期响应不再覆盖新状态', status: 'paused', createdAt: 1, updatedAt: 2, startedAt: 1, endedAt: null, projectRoot: 'C:/pi-GUI', counts: { total: 6, success: 4, failed: 1, cancelled: 0, skipped: 0 }, recoveryNotes: [] },
        { id: 'plan-stress', title: '压力场景：长说明 / 多文件 / 多次尝试', goal: '验证极端内容不破布局', status: 'completed', createdAt: 0, updatedAt: 9, startedAt: 1, endedAt: 9, projectRoot: 'C:/pi-GUI', counts: { total: 2, success: 1, failed: 1, cancelled: 0, skipped: 0 }, recoveryNotes: [] },
        { id: 'plan-gate', title: '人工验收门控：等待 / 通过 / 需修改', goal: '核对门控的五种状态与下游等待原因', status: 'paused', createdAt: 3, updatedAt: 4, startedAt: 1, endedAt: null, projectRoot: 'C:/pi-GUI', counts: { total: 7, success: 4, failed: 0, cancelled: 0, skipped: 0 }, recoveryNotes: [] },
        /* P13：排第 4 —— cdp-shot 里 pickPlan(3) 就是它。改动顺序会打乱所有场景号。 */
        { id: 'plan-ux', title: 'P13 下一步：可执行', goal: '核对「下一步」在有一条就绪任务时给什么', status: 'ready', createdAt: 1, updatedAt: 2, startedAt: null, endedAt: null, projectRoot: 'C:/pi-GUI', counts: { total: 2, success: 1, failed: 0, cancelled: 0, skipped: 0 }, recoveryNotes: [] },
        /* P13：排第 5 —— pickPlan(4)。 */
        { id: 'plan-wait', title: 'P13 下一步：等人工验收', goal: '核对「下一步」在有门控待验收时给什么', status: 'paused', createdAt: 1, updatedAt: 2, startedAt: 1, endedAt: null, projectRoot: 'C:/pi-GUI', counts: { total: 2, success: 1, failed: 0, cancelled: 0, skipped: 0 }, recoveryNotes: [] },
      ],
    });
  }

  /* 人工审阅的保存（P8-C）。真后端是 `PUT …/attempts/:attempt/review`。
   * 这里按 taskId 分流三种结果，好让视觉核对能截到**冲突**与**业务失败**两种 UI：
   *   tests → 409 冲突（别的窗口已经改过这条审阅）
   *   docs  → 200 但业务失败（状态与执行结论不符）
   *   其它  → 正常保存，回 revision + 1
   * ⚠️ 冲突在这里是**真 409**，但前端只能靠 body 里的 `code` 认出来 ——
   *    api.js 只读 `r.json()`，从不看状态码。 */
  const reviewHit = /^\/api\/plans\/([^/]+)\/tasks\/([^/]+)\/attempts\/(\d+)\/review$/.exec(p);
  if (reviewHit && req.method === 'PUT') {
    const planId = reviewHit[1];
    const taskId = reviewHit[2];
    const attempt = Number(reviewHit[3]);
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const expected = Number.isInteger(body.expectedRevision) ? body.expectedRevision : 0;
    if (taskId === 'tests' && body.status !== 'pending') {
      return json(res, 409, { ok: false, code: 'review-conflict', error: '这条审阅记录已经在其他窗口被修改，请重新加载。', currentRevision: expected + 1 });
    }
    if (taskId === 'docs' && body.status !== 'pending') {
      return json(res, 200, { ok: false, error: '这次执行没有成功，不能标记为「已接受」（可以标记「需修改」）' });
    }
    return json(res, 200, {
      ok: true,
      planId,
      taskId,
      attempt,
      review: {
        status: body.status,
        note: body.status === 'pending' ? '' : String(body.note || ''),
        reviewedAt: body.status === 'pending' ? null : Date.now(),
        revision: expected + 1,
      },
      /* P11：审阅的**工作流后果**（真后端由 planWorkflowState 算）。
       * 视觉核对要看到「验收已通过，N 个后续任务已可执行」那句反馈。 */
      gate: {
        planStatus: body.status === 'accepted' ? 'ready' : 'paused',
        reason: body.status === 'accepted' ? 'ready' : 'waiting-review',
        ready: body.status === 'accepted' ? ['gated-down'] : [],
      },
    });
  }

  if (p === '/api/plans/plan-1') {
    if (req.method === 'POST') return json(res, 200, { ok: true, planId: 'plan-1' });
    return json(res, 200, { ok: true, plan: PLAN_DETAIL, counts: { total: 6, success: 4, failed: 1, cancelled: 0, skipped: 0 }, agents: [], activePlanId: null });
  }
  if (p === '/api/plans/plan-gate') {
    if (req.method === 'POST') return json(res, 200, { ok: true, planId: 'plan-gate' });
    return json(res, 200, { ok: true, plan: PLAN_GATE, counts: { total: 7, success: 4, failed: 0, cancelled: 0, skipped: 0 }, agents: [], activePlanId: null });
  }
  if (p === '/api/plans/plan-stress') {
    if (req.method === 'POST') return json(res, 200, { ok: true, planId: 'plan-stress' });
    return json(res, 200, { ok: true, plan: PLAN_STRESS, counts: { total: 2, success: 1, failed: 1, cancelled: 0, skipped: 0 }, agents: [], activePlanId: null });
  }
  if (p === '/api/plans/plan-ux') {
    if (req.method === 'POST') return json(res, 200, { ok: true, planId: 'plan-ux' });
    return json(res, 200, { ok: true, plan: PLAN_UX, counts: { total: 2, success: 1, failed: 0, cancelled: 0, skipped: 0 }, agents: [], activePlanId: null });
  }
  if (p === '/api/plans/plan-wait') {
    if (req.method === 'POST') return json(res, 200, { ok: true, planId: 'plan-wait' });
    return json(res, 200, { ok: true, plan: PLAN_WAIT, counts: { total: 2, success: 1, failed: 0, cancelled: 0, skipped: 0 }, agents: [], activePlanId: null });
  }
  if (p.startsWith('/api/plans/')) {
    return json(res, 200, { ok: true, planId: 'plan-1', taskId: 'backend', title: '修复 bridgeRun stale response' });
  }

  if (p === '/api/providers') {
    return json(res, 200, {
      ok: true,
      path: path.join(process.env.USERPROFILE || '', '.pi', 'agent', 'models.json'),
      providers: {
        deepseek: { api: 'openai-completions', baseUrl: 'https://api.deepseek.com', models: MODELS },
      },
      keyStates: { deepseek: { kind: 'literal', ok: true, note: '' } },
    });
  }

  if (p === '/api/command' && req.method === 'POST') {
    const buf = await readBody(req);
    let cmd = {};
    try {
      cmd = JSON.parse(buf.toString('utf8') || '{}');
    } catch {
      return json(res, 400, { ok: false, error: '命令不是合法 JSON' });
    }
    /* P30：真实停止要等 Pi 的权威确认 —— 夹具这里把那条 abort 应答**扣住**，
     * 界面才会停在「正在停止…」（而不可能实现的状态）。由
     * `/api/__composer?what=release-stop` 放行。 */
    if (cmd.type === 'abort' && holdNextStop) {
      holdNextStop = false;
      heldStop = res;
      return;
    }
    json(res, 200, { ok: true });
    // 稍等一下再回，模拟真实往返，让加载态有机会被截到
    setTimeout(() => push({ ...replyFor(cmd), id: cmd.id }), 30);
    return;
  }

  if (p === '/api/upload' && req.method === 'POST') {
    if (holdNextComposerUpload) {
      holdNextComposerUpload = false;
      await new Promise((resolve) => setTimeout(resolve, 1250));
    }
    const buf = await readBody(req);
    const name = safeName(url.searchParams.get('name') || 'file');
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(UPLOAD_DIR, `${stamp}_${name}`);
    fs.writeFileSync(dest, buf);

    try {
      const { extract } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'extract.js')).href);
      const r = await extract(dest, name);
      return json(res, 200, {
        ok: true,
        id: stamp,
        name,
        size: buf.length,
        path: dest,
        kind: r.kind,
        pages: r.pages,
        note: r.note,
        chars: r.text ? r.text.length : undefined,
        text: r.text,
        preview: r.text ? r.text.slice(0, 200) : undefined,
      });
    } catch (err) {
      return json(res, 200, { ok: true, id: stamp, name, size: buf.length, path: dest, kind: 'binary', error: err.message });
    }
  }

  if (p === '/api/restart') return json(res, 200, { ok: true });

  if (p === '/api/__composer' && url.searchParams.get('what') === 'hold-upload') {
    holdNextComposerUpload = true;
    return json(res, 200, { ok: true });
  }

  if (p === '/api/__composer' && url.searchParams.get('what') === 'hold-stop') {
    holdNextStop = true;
    return json(res, 200, { ok: true });
  }

  if (p === '/api/__composer' && url.searchParams.get('what') === 'release-stop') {
    const held = heldStop;
    heldStop = null;
    /* 权威停止的应答形状与真后端一致（evidence 来自 server/rpc-bridge.js）。 */
    if (held) json(held, 200, { ok: true, stop: { evidence: 'abort-response', queue: 'cleared' } });
    return json(res, 200, { ok: true, released: Boolean(held) });
  }

  // 排查用：手动往事件流里推一条，确认前端到底收没收到
  if (p === '/api/__push') {
    const what = url.searchParams.get('what') || 'user';
    if (what === 'user') {
      push({ type: 'message_start', message: { role: 'user', content: '手动推一条\n\n<pi-file name="推.pdf" meta="1 页">\n正文\n</pi-file>' } });
    } else if (what === 'state') {
      push(replyFor({ type: 'get_state' }));
    } else if (what === 'stats') {
      push(replyFor({ type: 'get_session_stats' }));
    } else if (what === 'models') {
      push(replyFor({ type: 'get_available_models' }));
    } else if (what === 'running') {
      push({ type: 'agent_start' });
    } else if (what === 'settled') {
      push({ type: 'agent_settled' });
    } else if (what === 'offline') {
      /* P24：连接断开的两种形态。exited = 子进程没了；startup-error = 起不来。
       * 两者都要能给出**可执行的下一步**（重启 / 诊断），而不是一句「失败了」。 */
      push({ type: 'bridge_status', state: 'exited', code: 1 });
    } else if (what === 'startup-error') {
      push({
        type: 'bridge_status',
        state: 'error',
        error: '无法启动 pi：spawn pi ENOENT',
        hint: '确认 pi 已安装并在 PATH 中，或用环境变量 PI_BIN 指定完整路径。',
      });
    } else if (what === 'online') {
      push({ type: 'bridge_status', state: 'ready' });
    }
    return json(res, 200, { ok: true, pushed: what, clients: clients.size });
  }

  if (p === '/api/__conversation') {
    const what = url.searchParams.get('what') || 'fixture';
    if (what === 'supervisor-activity') {
      for (const action of ['status', 'pending', 'list', 'reply', 'something-new']) {
        const details = action === 'status' ? { active: true, pending: 2, root: 'PRIVATE_ROOT' }
          : action === 'pending' || action === 'list' ? { pending: [{ id: 'req-1', runId: 'run-1', agent: 'worker', childIndex: 0, reason: 'need_decision', expectsReply: true, message: 'PRIVATE_QUESTION', requestFile: 'PRIVATE_REQUEST' }] }
          : { replyTo: 'req-1', runId: 'run-1', agent: 'worker', channelDir: 'PRIVATE_CHANNEL' };
        push({ type: 'tool_execution_start', toolCallId: 'supervisor-' + action, toolName: 'subagent_supervisor', args: { action, replyTo: 'req-1', message: 'PRIVATE_ANSWER' } });
        push({ type: 'tool_execution_end', toolCallId: 'supervisor-' + action, result: { content: [{ type: 'text', text: 'PRIVATE_RAW_OUTPUT' }], details }, isError: false });
      }
    } else if (what === 'subagent-activity') {
      push({ type: 'tool_execution_start', toolCallId: 'p17-enable', toolName: 'subagents_enable', args: {} });
      push({ type: 'tool_execution_end', toolCallId: 'p17-enable', result: { content: [], details: { enabled: ['subagent'] } }, isError: false });
      push({ type: 'tool_execution_start', toolCallId: 'p17-single', toolName: 'subagent', args: { agent: 'custom-reviewer', task: 'Review the module safely', async: false } });
      push({ type: 'tool_execution_end', toolCallId: 'p17-single', result: { content: [{ type: 'text', text: 'RAW_CHILD_SECRET' }], details: { mode: 'single', runId: 'fg-run', results: [{ index: 0, agent: 'custom-reviewer', task: 'Review the module safely', model: 'actual/model', exitCode: 0 }] } }, isError: false });
      push({ type: 'tool_execution_start', toolCallId: 'p17-workflow', toolName: 'subagent', args: { workflowScript: 'return runs.all(...)', async: false } });
      push({ type: 'tool_execution_update', toolCallId: 'p17-workflow', partialResult: { content: [], details: { mode: 'workflow', runId: 'workflow-run', results: [], workflowChildren: { version: 1, parentToolCallId: 'p17-workflow', workflowRunId: 'workflow-run', inventoryComplete: true, workflowState: 'running', children: [{ childId: 'review-ui', agent: 'custom-ui', runId: 'child-ui', state: 'completed', model: 'actual/ui' }, { childId: 'review-api', agent: 'custom-api', runId: 'child-api', state: 'running', activity: { currentTool: 'read', toolCount: 2 } }] } } } });
      push({ type: 'tool_execution_start', toolCallId: 'p17-bg', toolName: 'subagent', args: { agent: 'worker', task: 'Independent background work', async: true } });
      push({ type: 'tool_execution_end', toolCallId: 'p17-bg', result: { content: [], details: { mode: 'single', runId: 'bg-run', asyncId: 'bg-run', results: [] } }, isError: false });
    } else if (what === 'memory-activity') {
      /* P18: fixtures 照 pi-memory 0.4.2 的真实 details 形状；
       * PRIVATE_* 用来证明正文 / 路径 / recovery ID 都不进 DOM。 */
      const MEM = 'C:\\Users\\p18user\\.pi\\agent\\memory\\MEMORY.md';
      push({ type: 'tool_execution_start', toolCallId: 'p18-write', toolName: 'memory_write', args: { target: 'long_term', content: 'This project uses pnpm, not npm.' } });
      push({ type: 'tool_execution_end', toolCallId: 'p18-write', isError: false, result: { content: [{ type: 'text', text: 'Appended to MEMORY.md\n\nExisting MEMORY.md preview\n\nPRIVATE_MEMORY_TEXT' }], details: { path: MEM, target: 'long_term', mode: 'append', sessionId: 'p18sess', timestamp: '2026-09-30 12:00:00', qmdUpdateMode: 'background', existingPreview: { preview: 'PRIVATE_MEMORY_TEXT', truncated: false, totalLines: 3, totalChars: 120, previewLines: 3, previewChars: 120 } } } });
      push({ type: 'tool_execution_start', toolCallId: 'p18-search', toolName: 'memory_search', args: { query: 'package manager decision', mode: 'semantic', limit: 5 } });
      push({ type: 'tool_execution_end', toolCallId: 'p18-search', isError: false, result: { content: [{ type: 'text', text: '### Result 1\n**File:** ' + MEM + '\n**Score:** 0.82\nPRIVATE_MEMORY_TEXT' }], details: { mode: 'semantic', query: 'package manager decision', count: 4, needsEmbed: false } } });
      push({ type: 'tool_execution_start', toolCallId: 'p18-forget', toolName: 'memory_forget', args: { match: 'uses npm' } });
      push({ type: 'tool_execution_end', toolCallId: 'p18-forget', isError: false, result: { content: [{ type: 'text', text: 'Removed 1 entry from ' + MEM + '. Recovery ID: 0f0e6b3c-1a2b-4c3d-8e4f-5a6b7c8d9e0f.' }], details: { path: MEM, target: 'long_term', removed: 1, recoveryId: '0f0e6b3c-1a2b-4c3d-8e4f-5a6b7c8d9e0f', recoveryPath: 'C:\\Users\\p18user\\.pi\\agent\\memory\\recovery\\0f0e6b3c-1a2b-4c3d-8e4f-5a6b7c8d9e0f.json', removedPreview: { preview: 'PRIVATE_MEMORY_TEXT' } } } });
      push({ type: 'tool_execution_start', toolCallId: 'p18-status', toolName: 'memory_status', args: {} });
      push({ type: 'tool_execution_end', toolCallId: 'p18-status', isError: false, result: { content: [{ type: 'text', text: '# Memory status\n- Memory dir: C:\\Users\\p18user\\.pi\\agent\\memory' }], details: { dir: 'C:\\Users\\p18user\\.pi\\agent\\memory', longTermChars: 1200, scratchpadOpen: 2, scratchpadTotal: 5, dailyCount: 12, latestDaily: '2026-09-30', qmd: true, collection: true, embeddings: 'ready', snapshotMode: 'stable', qmdUpdateMode: 'background' } } });
      push({ type: 'tool_execution_start', toolCallId: 'p18-scratchpad', toolName: 'scratchpad', args: { action: 'add', text: 'PRIVATE_SCRATCHPAD_ITEM' } });
      push({ type: 'tool_execution_end', toolCallId: 'p18-scratchpad', isError: false, result: { content: [{ type: 'text', text: 'Added: - [ ] PRIVATE_SCRATCHPAD_ITEM' }], details: { action: 'add', sessionId: 'p18sess', timestamp: '2026-09-30 12:00:00', qmdUpdateMode: 'background', preview: { preview: 'PRIVATE_SCRATCHPAD_ITEM' } } } });
      return json(res, 200, { ok: true });
    } else if (what === 'memory-soft-failure') {
      /* P18-Fix: soft-failure 的真实形状 —— details 是 {}，而 raw result 文本里
       * 既有文案也有路径。GUI 必须降级，且不得把这些文本当证据或铺进 DOM。 */
      push({ type: 'tool_execution_start', toolCallId: 'p18sf-read', toolName: 'memory_read', args: { target: 'daily', date: '2026-09-29' } });
      push({ type: 'tool_execution_end', toolCallId: 'p18sf-read', isError: false, result: { content: [{ type: 'text', text: 'No daily log for 2026-09-29. C:\\Users\\p18user\\.pi\\agent\\memory\\daily' }], details: {} } });
      push({ type: 'tool_execution_start', toolCallId: 'p18sf-sp', toolName: 'scratchpad', args: { action: 'done', text: 'fix later' } });
      push({ type: 'tool_execution_end', toolCallId: 'p18sf-sp', isError: false, result: { content: [{ type: 'text', text: 'No matching open item found for: "fix later" PRIVATE_SCRATCHPAD_ITEM' }], details: {} } });
      push({ type: 'tool_execution_start', toolCallId: 'p18sf-write', toolName: 'memory_write', args: { target: 'long_term', content: 'PRIVATE_MEMORY_TEXT' } });
      push({ type: 'tool_execution_end', toolCallId: 'p18sf-write', isError: false, result: { content: [{ type: 'text', text: 'PRIVATE_MEMORY_TEXT' }], details: {} } });
      push({ type: 'tool_execution_start', toolCallId: 'p18sf-status', toolName: 'memory_status', args: {} });
      push({ type: 'tool_execution_end', toolCallId: 'p18sf-status', isError: false, result: { content: [{ type: 'text', text: 'PRIVATE_MEMORY_TEXT' }], details: { longTermChars: 1200, snapshotMode: 'refresh' } } });
      return json(res, 200, { ok: true });
    } else if (what === 'quota-unknown-unit') {
      /* P21-Fix-4：把当前模型切到一个「单位未知」的 provider（NewAPI 样式：
       * quota 数值有、currency/unit 都是 null）。 */
      const reply = replyFor({ type: 'get_state' });
      reply.data.model = { id: 'newapi-custom', name: 'NewAPI（单位未知）', provider: 'unknown-unit' };
      push(reply);
      return json(res, 200, { ok: true });
    } else if (what === 'quota-restore-model') {
      push(replyFor({ type: 'get_state' }));
      return json(res, 200, { ok: true });
    } else if (what === 'approval-request') {
      /* P19: 权限扩展经 extension_ui_request 发来的对话框。
       * PRIVATE_* 用来证明额外字段（token / 原始 payload）不进 DOM。 */
      push({ type: 'extension_ui_request', id: 'p19-shot', method: 'confirm', title: 'Allow rm -rf build/?', message: 'A permission extension wants to run a destructive command.', timeout: 30000, token: 'PRIVATE_TOKEN', rawArgs: 'PRIVATE_RAW' });
      return json(res, 200, { ok: true });
    } else if (what === 'web-activity') {
      push({ type: 'tool_execution_start', toolCallId: 'p16-search', toolName: 'web_search', args: { queries: ['Pi coding agent official documentation'] } });
      push({ type: 'tool_execution_end', toolCallId: 'p16-search', isError: false, result: { content: [{ type: 'text', text: 'Offline fixture search result' }], details: { queries: ['Pi coding agent official documentation'], totalResults: 1, queryProviders: [{ query: 'Pi coding agent official documentation', providers: ['exa'] }], curatedQueries: [{ sources: [{ title: 'Pi documentation', url: 'https://pi.dev/' }] }] } } });
      push({ type: 'tool_execution_start', toolCallId: 'p16-fetch', toolName: 'fetch_content', args: { url: 'https://pi.dev/' } });
      push({ type: 'tool_execution_end', toolCallId: 'p16-fetch', isError: false, result: { content: [{ type: 'text', text: 'Offline page body '.repeat(1000) }], details: { urls: ['https://pi.dev/'], title: 'Pi documentation', mimeType: 'text/html', status: 200, successful: 1 } } });
      return json(res, 200, { ok: true });
    } else if (what === 'browser-activity') {
      /* P20：details 形状照抄 pi-browser-harness 0.11.0 的真实返回。
       * PRIVATE_* 用来证明：输入内容、页面正文、页面标题、本机路径、上游错误原文
       * 一个都不进 DOM。 */
      push({ type: 'tool_execution_start', toolCallId: 'p20-nav', toolName: 'browser_navigate', args: { url: 'https://example.com/' } });
      push({ type: 'tool_execution_end', toolCallId: 'p20-nav', isError: false, result: { content: [{ type: 'text', text: 'Navigated to: https://example.com/\nTitle: PRIVATE_PAGE_TITLE' }], details: { ok: true, outcome: { kind: 'new_tab_created', targetId: 'A1B2C3' }, page: { url: 'https://example.com/', title: 'PRIVATE_PAGE_TITLE', width: 1280, height: 720 } } } });
      push({ type: 'tool_execution_start', toolCallId: 'p20-click', toolName: 'browser_click', args: { ref: 'e12' } });
      push({ type: 'tool_execution_end', toolCallId: 'p20-click', isError: false, result: { content: [{ type: 'text', text: 'Clicked at a[href="https://iana.org"] PRIVATE_ELEMENT_TEXT' }], details: { ok: true, x: 320, y: 240, ref: 'e12' } } });
      push({ type: 'tool_execution_start', toolCallId: 'p20-fill', toolName: 'browser_fill', args: { ref: 'e7', value: 'PRIVATE_TYPED_SECRET' } });
      push({ type: 'tool_execution_end', toolCallId: 'p20-fill', isError: false, result: { content: [{ type: 'text', text: 'Filled e7 = "PRIVATE_TYPED_SECRET"' }], details: { ok: true, ref: 'e7', value: 'PRIVATE_TYPED_SECRET', verified: 'PRIVATE_TYPED_SECRET', tag: 'INPUT' } } });
      push({ type: 'tool_execution_start', toolCallId: 'p20-read', toolName: 'browser_read_page', args: { url: 'https://example.com/' } });
      push({ type: 'tool_execution_end', toolCallId: 'p20-read', isError: false, result: { content: [{ type: 'text', text: 'PRIVATE_PAGE_BODY' }], details: { ok: true, title: 'PRIVATE_PAGE_TITLE', url: 'https://example.com/', wordCount: 42, render: { body: 'PRIVATE_PAGE_BODY' } } } });
      push({ type: 'tool_execution_start', toolCallId: 'p20-shot', toolName: 'browser_screenshot', args: { format: 'jpeg' } });
      push({ type: 'tool_execution_end', toolCallId: 'p20-shot', isError: false, result: { content: [{ type: 'text', text: 'Screenshot saved: C:\\PRIVATE\\shot.jpeg' }], details: { ok: true, path: 'C:\\PRIVATE\\shot.jpeg', format: 'jpeg', attached: false } } });
      push({ type: 'tool_execution_start', toolCallId: 'p20-timeout', toolName: 'browser_wait_for_load', args: { timeout: 15 } });
      push({ type: 'tool_execution_end', toolCallId: 'p20-timeout', isError: true, result: { content: [{ type: 'text', text: 'browser_wait_for_load failed (timeout): PRIVATE_UPSTREAM_MESSAGE' }], details: { ok: false, kind: 'timeout', message: 'PRIVATE_UPSTREAM_MESSAGE' } } });
      return json(res, 200, { ok: true });
    }
    if (what === 'empty') {
      push({ type: 'response', command: 'get_messages', success: true, data: { messages: [] } });
    } else if (what === 'fixture' || what === 'reset') {
      push({ type: 'response', command: 'get_messages', success: true, data: { messages: what === 'fixture' ? P14B_MESSAGES : MESSAGES } });
    } else if (what === 'long-thread') {
      /* 长会话夹具（UX 场景用）：N 次「提问 + 回答」，每次回答长度差异很大，
       * 专门用来验 conversation minimap 的**紧凑聚簇**与跳转落点。
       *
       * 为什么单独一个 what= 而不是改 P14B_MESSAGES：场景 80-minimap 钉死了
       * 「4 个用户 Turn」；夹具是有状态的，动它会把别的场景一起带偏。
       * 用完记得 ?what=fixture / ?what=reset 还原。 */
      const turns = Math.max(1, Math.min(200, Number(url.searchParams.get('turns') || 24)));
      const messages = [];
      for (let i = 1; i <= turns; i++) {
        messages.push({ role: 'user', content: [{ type: 'text', text: `第 ${i} 个问题：请检查模块 #${i} 的实现` }] });
        // 第 7 条之后放一段特别长的回答 —— 老实现会因此把后面的 marker 推得很远
        const body = i === 7 ? `第 ${i} 个回答（很长）。`.repeat(90) : `第 ${i} 个回答。`;
        messages.push({ role: 'assistant', content: [{ type: 'text', text: body }] });
      }
      push({ type: 'response', command: 'get_messages', success: true, data: { messages } });
      return json(res, 200, { ok: true, pushed: what, turns });
    } else if (what === 'tool-running') {
      push({ type: 'tool_execution_start', toolCallId: 'p14b-running', toolName: 'read', args: { path: 'public/messages.js' } });
    } else if (what === 'tool-success') {
      push({ type: 'tool_execution_end', toolCallId: 'p14b-running', result: { content: [{ type: 'text', text: '已读取 640 行' }] }, isError: false });
    } else if (what === 'tool-failed') {
      push({ type: 'tool_execution_start', toolCallId: 'p14b-failed', toolName: 'bash', args: { command: 'npm test' } });
      push({ type: 'tool_execution_end', toolCallId: 'p14b-failed', result: { content: [{ type: 'text', text: 'Command exited with code 1' }] }, isError: true });
    } else if (what === 'work-stream') {
      push({ type: 'message_start', message: { role: 'assistant' } });
      push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '离开 Chat 时继续生成的正文' } });
      push({ type: 'tool_execution_start', toolCallId: 'p14d-write', toolName: 'write', args: { file_path: 'C:\\pi-GUI\\public\\app.js' } });
      push({ type: 'tool_execution_end', toolCallId: 'p14d-write', result: { content: [{ type: 'text', text: 'fixture' }] }, isError: false });
    }
    return json(res, 200, { ok: true, pushed: what });
  }

  if (p === '/api/fs') return json(res, 200, { ok: true, items: [] });

  // 静态文件
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`视觉夹具已启动: http://127.0.0.1:${server.address().port}/`);
});
if (fileLinkWorld) {
  process.on('exit', () => {
    try { fs.rmSync(fileLinkWorld.world, { recursive: true, force: true }); } catch { /* 临时目录已不存在 */ }
  });
}
