/* 技能 / 扩展 / MCP 能力报告拆分后的边界与生命周期回归。
 *
 * 全部离线：不启动服务、不碰真 pi、不写盘（jsdom + 注入的 fetch，形状照抄服务端真实返回）。
 *   1. 静态边界：旧的混合模块已删除；三个入口之间没有 UI 互相 import；页面只经 api.js
 *      取数且各自只读自己的事实来源；页面状态不放模块全局、不写共享 store；
 *      插件市场占位没有安装路径；新模块的具名导出在整张模块图里唯一。
 *   2. 纯数据投影：未知保持未知（null 不折算成「否」），筛选 / 分组 / 计数不丢条目。
 *   3. 生命周期：迟到的异步结果丢弃、工作区换代给「项目已切换」提示、关闭后监听器净增为 0、
 *      页签面板复用不重复请求、展开项的 SKILL.md 不随筛选重复请求。
 * 设计见 docs/agent-capabilities.md。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const GEN = 'pi-gui:workspace-generation';
let passed = 0;
let failed = 0;
async function check(name, run) {
  try {
    await run();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    failed += 1;
    console.error('  FAIL ' + name + ': ' + (error && error.message ? error.message : error));
  }
}
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
const clone = (value) => JSON.parse(JSON.stringify(value));
const plain = (value) => JSON.parse(JSON.stringify(value)); // 跨 vm realm 比较前去掉原型差异
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');

const SKILLS_DIR = path.join(PUB, 'skills');
const EXT_DIR = path.join(PUB, 'extensions');
const SKILL_FILES = ['model.js', 'detail.js', 'editor.js', 'import.js', 'external.js', 'market.js', 'page.js']
  .map((name) => path.join(SKILLS_DIR, name));
const EXT_FILES = ['model.js', 'installed.js', 'market.js', 'page.js'].map((name) => path.join(EXT_DIR, name));
const REPORT = path.join(PUB, 'mcp-report.js');
const MCP_PAGE = path.join(PUB, 'mcp-settings.js');
const RESOURCE_DOM = path.join(PUB, 'ui', 'resource-dom.js');
const API = path.join(PUB, 'api.js');
const NEW_MODULES = [...SKILL_FILES, ...EXT_FILES, REPORT, RESOURCE_DOM];

const IMPORT_RE = /^[ \t]*import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/gm;
function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(IMPORT_RE)].map((match) => ({
    target: path.resolve(path.dirname(file), match[2]),
    names: match[1].split(',').map((part) => part.trim()).filter(Boolean).map((part) => part.split(/\s+as\s+/)[0].trim()),
  }));
}
const EXPORT_DECL_RE = /^[ \t]*export\s+(?:async\s+function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\}/gm;
function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = [...src.matchAll(EXPORT_DECL_RE)].map((match) => match[1]);
  for (const match of src.matchAll(EXPORT_LIST_RE)) {
    names.push(...match[1].split(',').map((part) => part.trim()).filter(Boolean).map((part) => part.split(/\s+as\s+/).pop().trim()));
  }
  return names;
}
function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const inside = (file, dir) => file.startsWith(dir + path.sep);
const isMcpUi = (file) => path.dirname(file) === PUB && path.basename(file).startsWith('mcp-');

/* ---------- fixture：形状照抄服务端 ----------
 * Skill 条目：server/skills.js 的 skills.push({...})；详情：同文件 GET /api/skills/<id>。
 * Registry：server/extension-registry.js（与 tests/smoke.cjs 的 stubExtensions 同形）。
 * MCP 报告：server/mcp.js（0.99.2 基线，与 tests/smoke.cjs 的 stubMcp 同形）。 */
const HOME = 'C:\\fixture\\home';
const AGENT = HOME + '\\.pi\\agent';
const PROJECT = 'C:\\fixture\\project';
function skill(over) {
  const scope = over.scope || 'user';
  const base = scope === 'project' ? PROJECT + '\\.pi' : AGENT;
  const relPath = `skills/${over.name}/SKILL.md`;
  return {
    description: `${over.name} fixture`, scope, source: 'auto', origin: 'top-level', mode: 'pi',
    rootLabel: scope === 'project' ? '<项目>/.pi/skills' : '~/.pi/agent/skills',
    path: `${base}\\skills\\${over.name}\\SKILL.md`, dir: `${base}\\skills\\${over.name}`, file: 'SKILL.md',
    rel: relPath, baseDir: base, loaded: true, state: 'enabled', stateNote: '', shadowedBy: null,
    disablePattern: '-' + relPath, settingsPath: `${base}\\settings.json`, toggleable: scope === 'user' || scope === 'project',
    blockedByTrust: false, disabledBy: '', disableModelInvocation: false, license: '', compatibility: '', bytes: 120, errors: [],
    ...over,
  };
}
const SKILLS = {
  ok: true, hasProject: true, cwd: PROJECT, agentDir: AGENT, homeDir: HOME,
  globalSettings: AGENT + '\\settings.json', projectSettings: PROJECT + '\\.pi\\settings.json',
  trust: { trusted: true, requiresTrust: true, reason: 'trusted', trustFile: AGENT + '\\trust.json' },
  piReachable: true,
  context: { project: 'c000000000000099', live: true },
  projects: [{ id: 'c000000000000099', name: 'Fixture project', path: PROJECT, active: true }],
  targets: [
    { key: 'user-pi', scope: 'user', mode: 'pi', dir: AGENT + '\\skills', label: '~/.pi/agent/skills', exists: true, writable: true, blockedCode: '', blockedReason: '', notice: '' },
    { key: 'project-pi', scope: 'project', mode: 'pi', dir: PROJECT + '\\.pi\\skills', label: '<项目>/.pi/skills', exists: true, writable: true, blockedCode: '', blockedReason: '', notice: '' },
  ],
  trashAvailable: true,
  roots: [
    { label: '~/.pi/agent/skills', dir: AGENT + '\\skills', scope: 'user', mode: 'pi', exists: true, blockedByTrust: false },
    { label: '<项目>/.pi/skills', dir: PROJECT + '\\.pi\\skills', scope: 'project', mode: 'pi', exists: true, blockedByTrust: false },
  ],
  diagnostics: [],
  counts: { total: 3, enabled: 2, project: 1, user: 2 },
  skills: [
    skill({ id: 'p000000000000001', name: 'proj-lint', scope: 'project', description: 'Project lint rules' }),
    skill({ id: 'a000000000000001', name: 'code-review', description: 'Review source code for bugs' }),
    skill({
      id: 'b000000000000001', name: 'pdf-tools', description: 'Work with PDF files', state: 'disabled', loaded: false,
      disabledBy: '-skills/pdf-tools/SKILL.md', stateNote: '被 settings 里的 -skills/pdf-tools/SKILL.md 关掉了',
    }),
  ],
};
const SKILL_DETAIL = {
  ok: true, skill: SKILLS.skills[1], readable: true, truncated: false,
  content: '---\nname: code-review\ndescription: Review source code for bugs\n---\nFixture body of code-review',
  files: [{ name: 'SKILL.md', dir: false, size: 120 }],
};
const EXT_OK = {
  id: 'ext-1', name: 'sample-extension', displayName: 'Sample Extension', version: '1.0.0', description: 'Fixture extension',
  source: { type: 'local', location: 'C:/fixture/extensions/sample.ts' }, scope: 'global',
  state: { installed: true, enabled: true, loaded: true, restartRequired: null, error: null },
  capabilities: [{ type: 'command', id: 'hello', displayName: 'hello' }], configurable: false,
};
const EXT_BROKEN = {
  id: 'ext-2', name: 'broken-extension', displayName: 'Broken Extension', version: null, description: null,
  source: { type: 'local', location: 'C:/fixture/extensions/broken.ts' }, scope: 'project',
  state: { installed: true, enabled: null, loaded: false, restartRequired: null, error: { extensionId: 'ext-2', phase: 'load', message: 'Pi 报告扩展加载错误' } },
  capabilities: [], configurable: false,
};
const registry = (extensions) => ({
  ok: true, piReachable: true, actions: { install: false, toggle: false, remove: false, refresh: true, restart: true },
  diagnostics: [], capabilityRegistry: { commands: [], tools: [], toolRegistryAvailable: false }, extensions,
});
const APPROVAL = {
  ok: true, piVersion: '0.99.2',
  checks: {
    toolCallHook: { supported: true, evidence: 'dist/core/extensions/types.d.ts: block?: boolean' },
    uiPromptDialog: { supported: true, evidence: 'docs/rpc.md: block until the client sends back an extension_ui_response' },
    coreApproval: { supported: false, evidence: 'docs/usage.md: no permission popups' },
    customUiOverRpc: { supported: false, evidence: 'dist/modes/rpc/rpc-mode.js: Custom UI not supported in RPC mode' },
  },
};
const MCP_REPORT = {
  ok: true, supported: true,
  reason: '这个 pi 包自带 built-in 扩展 `mcp`（配置走 pi 自己的 mcp.json，命令行是 pi mcp add / remove）',
  evidence: 'dist/extensions/index.js: { name: "mcp", factory: mcpExtension, replaceable: true, builtin: true }',
  piVersion: '0.99.2', version: { value: '0.99.2', source: 'package.json', status: 'known', updatedAt: '2026-10-01T03:00:00.000Z' },
  piPackageFound: true, servers: [],
  builtins: {
    known: true, source: 'dist/extensions/index.js',
    entries: [{ id: 'mcp', replaceable: true, hidden: false, evidence: '{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true }' }],
    evidence: 'export const builtInExtensions = [ … ]', note: 'built-in 扩展编译在 pi 包里。',
  },
  extensionApi: { available: true, registerMcpServer: true, getMcpServers: true, getAllTools: true, evidence: 'registerMcpServer(name: string, config: McpServerConfig): void;' },
  rpc: { commandCount: 33, commands: ['abort', 'prompt', 'get_state'], toolListCommand: false, note: 'Pi RPC 没有已注册工具清单命令。' },
  mcpConfig: { user: { exists: false }, project: { exists: true } },
  extensionRoute: {
    note: 'pi 官方建议把 MCP 这类能力做成 extension 或 package。',
    userDir: AGENT + '\\extensions', projectDir: PROJECT + '\\.pi\\extensions',
    user: { exists: false, entries: [], count: 0, error: '' },
    project: { exists: true, entries: [{ name: 'my-ext', kind: 'file', size: 1200, mtime: 1 }], count: 1, error: '' },
    fromSettings: [], packages: [],
  },
};

/* ---------- 隔离的页面世界：每个入口一份 index.html + 自己的模块图 ---------- */
const pageErrors = [];
function createWorld(label, entry) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => pageErrors.push(`${label}: ${error && error.message ? error.message : error}`));
  virtualConsole.on('error', (...args) => pageErrors.push(`${label}: console.error ${args.map(String).join(' ')}`));
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://localhost:7788/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  const w = dom.window;
  const d = w.document;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.EventSource = class { close() {} };

  /* document 级监听账本：在模块执行前装上，模块顶层注册的也算进基线。 */
  const listeners = new Map();
  const add = d.addEventListener.bind(d);
  const remove = d.removeEventListener.bind(d);
  d.addEventListener = (type, fn, options) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return add(type, fn, options);
  };
  d.removeEventListener = (type, fn, options) => {
    listeners.get(type)?.delete(fn);
    return remove(type, fn, options);
  };

  /* 注入的 fetch：每个请求记账；路由可以立即应答，也可以挂起由用例决定何时、以什么结果放行。 */
  const calls = [];
  const routes = new Map();
  const pending = new Map();
  const matchRoute = (method, url) => {
    /* 路由只按路径匹配：页面现在会带 ?project=<id>，查询参数不该逼每个用例把 URL 抄全。 */
    const target = `${method} ${String(url).split('?')[0]}`;
    if (routes.has(target)) return target;
    for (const key of routes.keys()) {
      if (key.endsWith('*') && target.startsWith(key.slice(0, -1))) return key;
    }
    return null;
  };
  const respond = (value) => ({ ok: true, status: 200, json: async () => value });
  w.fetch = (url, options) => {
    const method = String(options?.method || 'GET').toUpperCase();
    const target = String(url);
    let body = null;
    if (typeof options?.body === 'string') { try { body = JSON.parse(options.body); } catch { body = options.body; } }
    calls.push({ method, url: target, body });
    const key = matchRoute(method, target);
    if (!key) return Promise.resolve(respond({ ok: false, error: 'fixture: not routed' }));
    const route = routes.get(key);
    if (route.hold) {
      let resolve;
      const gate = new Promise((done) => { resolve = done; });
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push(resolve);
      return gate.then(respond);
    }
    return Promise.resolve(respond(clone(typeof route.value === 'function' ? route.value({ method, url: target, body }) : route.value)));
  };

  w.eval(bundle(entry).code);
  return {
    w, d, calls,
    $: (id) => d.getElementById(id),
    answer(key, value) { routes.set(key, { value }); },
    hold(key) { routes.set(key, { hold: true }); },
    release(key, value) {
      const queue = pending.get(key) || [];
      assert.ok(queue.length, 'no pending request for ' + key);
      queue.shift()(clone(value));
    },
    pendingCount: (key) => (pending.get(key) || []).length,
    count(method, url) {
      const want = String(url).split('?')[0];
      return calls.filter((call) => call.method === method
        && (want.endsWith('*') ? call.url.split('?')[0].startsWith(want.slice(0, -1)) : call.url.split('?')[0] === want)).length;
    },
    listenerCount: (type) => listeners.get(type)?.size || 0,
    confirmButton(label) { return [...d.querySelectorAll('#confirmCard .btn')].find((button) => button.textContent === label); },
    /** 用例之间清场：上一条失败留下的挂起请求与确认框不能串到下一条。 */
    reset() {
      for (const queue of pending.values()) for (const resolve of queue.splice(0)) resolve({ ok: false, error: 'fixture: reset' });
      if (!d.getElementById('confirmLayer').hidden) this.confirmButton('取消')?.click();
    },
  };
}

(async () => {
  console.log('agent capability pages: static boundaries');

  await check('the mixed Skills/Extensions module is gone and each entry owns its modules', () => {
    assert.equal(fs.existsSync(path.join(PUB, 'extensions.js')), false, 'public/extensions.js must stay removed');
    for (const file of [...NEW_MODULES, path.join(SKILLS_DIR, 'skills.css'), path.join(EXT_DIR, 'extensions.css')]) {
      assert.ok(fs.existsSync(file), rel(file) + ' is missing');
    }
  });

  await check('Skills, Extensions and the MCP pages never import each other', () => {
    for (const file of SKILL_FILES) {
      for (const { target } of importsOf(file)) assert.ok(!inside(target, EXT_DIR) && !isMcpUi(target), `${rel(file)} imports ${rel(target)}`);
    }
    for (const file of EXT_FILES) {
      for (const { target } of importsOf(file)) assert.ok(!inside(target, SKILLS_DIR) && !isMcpUi(target), `${rel(file)} imports ${rel(target)}`);
    }
    for (const file of [REPORT, MCP_PAGE]) {
      for (const { target } of importsOf(file)) assert.ok(!inside(target, SKILLS_DIR) && !inside(target, EXT_DIR), `${rel(file)} imports ${rel(target)}`);
    }
    const importers = (target) => listJs(PUB).filter((file) => importsOf(file).some((item) => item.target === target)).map(rel).sort();
    assert.deepEqual(importers(path.join(SKILLS_DIR, 'page.js')), ['public/app.js']);
    assert.deepEqual(importers(path.join(EXT_DIR, 'page.js')), ['public/app.js']);
    assert.deepEqual(importers(REPORT), ['public/mcp-settings.js']);
    assert.deepEqual(importsOf(RESOURCE_DOM), [], 'the shared DOM helper imports nothing');
    assert.deepEqual(exportsOf(RESOURCE_DOM).sort(), ['resourceEl', 'resourceNote', 'resourceRow']);
  });

  await check('each page reads only its own fact source, only through api.js', () => {
    const allowed = new Map([
      [path.join(SKILLS_DIR, 'page.js'), ['deleteSkill', 'fetchSkills', 'restartBackend', 'setSkillEnabled', 'undoSkillChange']],
      [path.join(SKILLS_DIR, 'detail.js'), ['fetchSkillDetail']],
      [path.join(SKILLS_DIR, 'editor.js'), ['checkSkill', 'createSkill', 'fetchSkillSource', 'saveSkill']],
      [path.join(SKILLS_DIR, 'import.js'), ['commitSkillImport', 'stageSkillImport']],
      [path.join(SKILLS_DIR, 'external.js'), ['importExternalSkills', 'scanExternalSkills']],
      [path.join(SKILLS_DIR, 'market.js'), ['fetchSkillMarket', 'fetchSkillMarketFile', 'installSkillMarketEntry', 'previewSkillMarketEntry', 'refreshSkillMarket', 'skillMarketSources']],
      [path.join(EXT_DIR, 'installed.js'), ['fetchApprovalCapability', 'fetchExtensions']],
      [REPORT, ['fetchMcp']],
    ]);
    for (const file of NEW_MODULES) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      assert.ok(!/\bfetch\s*\(/.test(code), `${rel(file)} calls fetch() directly`);
      assert.ok(!/['"`]\/api\//.test(code), `${rel(file)} hard-codes an /api/ URL`);
      assert.ok(!/\bimport\s*\(/.test(code), `${rel(file)} uses a dynamic import`);
      assert.ok(!/\b(localStorage|sessionStorage|indexedDB)\b/.test(code), `${rel(file)} keeps a second copy in browser storage`);
      const names = importsOf(file).filter((item) => item.target === API).flatMap((item) => item.names).sort();
      assert.deepEqual(names, allowed.get(file) || [], `${rel(file)} api imports`);
    }
  });

  await check('page state lives in the page instance: no module globals, no writes to the shared store', () => {
    for (const file of NEW_MODULES) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      assert.ok(!/^(let|var)\s/m.test(code), `${rel(file)} keeps mutable module-level state`);
      assert.ok(!/\bS\.[\w.]+\s*(=(?!=)|\+\+|--|\+=|-=)/.test(code), `${rel(file)} writes the shared store`);
    }
  });

  await check('the market placeholder has no installer path in phase 1', () => {
    const market = path.join(EXT_DIR, 'market.js');
    assert.deepEqual(importsOf(market).map((item) => rel(item.target)).sort(), ['public/ui/icons.js', 'public/ui/resource-dom.js']);
    const code = stripComments(fs.readFileSync(market, 'utf8'));
    assert.ok(!/\binstall/i.test(code), 'market.js mentions an install action');
    assert.ok(!/piplug/i.test(code), 'market.js handles .piplug packages');
    assert.ok(!/['"]button['"]|onclick|addEventListener/.test(code), 'market.js wires an action');
  });

  await check('split modules are reachable from app.js and their export names are unique in the module graph', () => {
    const graph = bundle(path.join(PUB, 'app.js')).files;
    for (const file of NEW_MODULES) assert.ok(graph.includes(file), `${rel(file)} is not reachable from app.js`);
    const owners = new Map();
    for (const file of graph) for (const name of exportsOf(file)) owners.set(name, [...(owners.get(name) || []), file]);
    for (const file of NEW_MODULES) {
      for (const name of exportsOf(file)) {
        const where = owners.get(name);
        assert.equal(where.length, 1, `${name} is exported by ${where.map(rel).join(', ')}`);
      }
    }
  });

  await check('the shell loads each page stylesheet once and npm test runs this suite', () => {
    const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    for (const href of ['/skills/skills.css', '/extensions/extensions.css', '/mcp.css']) {
      assert.equal(html.split(`href="${href}"`).length - 1, 1, href);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts.test.includes('node tests/agent-capability-pages.cjs'), 'missing from the npm test chain');
  });

  /* 真实画面由 shortcut-electron 量计算样式；这里守住规则本身，CI 的 npm test 也能发现它被删。 */
  await check('the 扩展 main-nav item paints aria-current as selected and the current session row yields it', () => {
    const css = stripComments(fs.readFileSync(path.join(PUB, 'app-shell.css'), 'utf8'));
    const rule = (selector) => {
      const at = css.indexOf(selector + ' {');
      assert.ok(at >= 0, `missing rule ${selector}`);
      return css.slice(at, css.indexOf('}', at));
    };
    assert.match(rule('.project-sidebar:not(.settings-mode) .rail-nav > .nav-item[aria-current="page"]'), /background:\s*var\(--ds-bg-active\)/);
    assert.match(rule('.project-sidebar .pj-sess.on'), /background:\s*var\(--ds-bg-active\)/, 'nav and session share one selected token');
    assert.match(rule('.project-sidebar:has(.rail-nav > .nav-item[aria-current="page"]) .pj-sess.on'), /background:\s*transparent/);
    const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    assert.match(html, /<nav class="rail-nav"[^>]*>(?:(?!<\/nav>)[\s\S])*?<button[^>]*id="navExtensions"/, '扩展 sits in the rail nav');
    assert.match(html, /<div class="sidebar-session-heading">\s*<button[^>]*id="navHome"/, '会话 heading is not a direct rail-nav item, so it never matches');
  });

  console.log('agent capability pages: data projections');
  const SM = vm.runInNewContext(bundle(path.join(SKILLS_DIR, 'model.js')).code, { window: {} });
  const EM = vm.runInNewContext(bundle(path.join(EXT_DIR, 'model.js')).code, { window: {} });

  await check('skill state and loaded stay three-valued: unknown is never shown as off', () => {
    assert.equal(SM.skillStateMeta('enabled').label, '已启用');
    assert.equal(SM.skillStateMeta('a-future-state').label, '状态未知');
    assert.equal(SM.skillStateMeta(undefined).label, '状态未知');
    assert.equal(SM.skillLoadedText({ loaded: null }), '无法确认（pi 未运行）');
    assert.equal(SM.skillLoadedText({}), '无法确认（pi 未运行）');
    assert.equal(SM.skillLoadedText({ loaded: true }), '是');
    assert.equal(SM.skillLoadedText({ loaded: false }), '否');
    assert.equal(SM.isSkillOn({ state: 'enabled' }), true);
    assert.equal(SM.isSkillOn({ state: 'unknown', loaded: true, disabledBy: '' }), true);
    assert.equal(SM.isSkillOn({ state: 'disabled', loaded: true, disabledBy: '-skills/x/SKILL.md' }), false);
    assert.equal(SM.isSkillOn({ state: 'unknown', loaded: null }), false);
  });

  await check('skill filters, counts and groups keep every entry and the server order', () => {
    const list = [
      { id: 1, name: 'alpha', scope: 'user', state: 'enabled', path: 'C:/home/.pi/agent/skills/alpha/SKILL.md', rootLabel: '~/.pi/agent/skills' },
      { id: 2, name: 'beta', scope: 'project', state: 'untrusted', path: 'C:/p/.pi/skills/beta/SKILL.md' },
      { id: 3, name: 'gamma', scope: 'temporary', state: 'disabled', path: '' },
      { id: 4, name: 'delta', scope: 'a-future-scope', state: 'invalid', path: '' },
    ];
    const ids = (items) => plain(items.map((item) => item.id));
    assert.deepEqual(ids(SM.filterSkills(list, { query: 'SKILLS/ALPHA' })), [1], 'query matches the path, case-insensitively');
    assert.deepEqual(ids(SM.filterSkills(list, { scope: 'project' })), [2]);
    assert.deepEqual(ids(SM.filterSkills(list, { state: 'problem' })), [2, 4]);
    assert.deepEqual(ids(SM.filterSkills(list, { state: 'off' })), [2, 3, 4]);
    assert.deepEqual(ids(SM.filterSkills(list, {})), [1, 2, 3, 4]);
    assert.deepEqual(plain(SM.skillScopeCounts(list)), { all: 4, project: 1, user: 1, temporary: 1 });
    const groups = SM.groupSkillsByScope(list);
    assert.deepEqual(plain(groups.map((group) => group.scope)), ['user', 'project', 'temporary', 'other'], 'global before project, like PI-Desktop');
    assert.deepEqual(ids(groups[3].items), [4], 'an unknown scope is grouped last, not dropped');
    assert.equal(SM.skillScopeLabel('user'), '全局');
    assert.equal(SM.skillScopeLabel('a-future-scope'), 'a-future-scope');
  });

  await check('a group header names the discovery dirs that exist, else the default one, never another scope', () => {
    const roots = [
      { label: '~/.pi/agent/skills', dir: 'C:/h/.pi/agent/skills', scope: 'user', exists: false },
      { label: '~/.agents/skills', dir: 'C:/h/.agents/skills', scope: 'user', exists: true },
      { label: '<项目>/.pi/skills', dir: 'C:/p/.pi/skills', scope: 'project', exists: false },
      { label: 'C:/p/.agents/skills', dir: 'C:/p/.agents/skills', scope: 'project', exists: false },
    ];
    assert.deepEqual(plain(SM.skillScopeRoots(roots, 'user')), [{ label: '~/.agents/skills', dir: 'C:/h/.agents/skills' }]);
    assert.deepEqual(plain(SM.skillScopeRoots(roots, 'project')), [{ label: '<项目>/.pi/skills', dir: 'C:/p/.pi/skills' }],
      'nothing exists yet: show where pi would look first');
    assert.deepEqual(plain(SM.skillScopeRoots(roots, 'temporary')), []);
    assert.deepEqual(plain(SM.skillScopeRoots(undefined, 'user')), [], 'an older answer without roots is not an error');
    assert.equal(SM.skillStateMeta('invalid').tone, 'error');
    assert.equal(SM.skillStateMeta('untrusted').tone, 'warning');
    assert.equal(SM.skillStateMeta('a-future-state').tone, 'neutral', 'unknown never borrows a warning colour');
  });

  await check('the toggle confirmation names the settings file and rule, never the skill file', () => {
    const target = { settingsPath: 'C:/p/.pi/settings.json', disablePattern: '-skills/a/SKILL.md' };
    const off = SM.skillToggleCopy(target, false);
    assert.equal(off.title, '停用这个 Skill？');
    assert.equal(off.okText, '停用');
    assert.ok(off.message.includes(target.settingsPath) && off.message.includes(target.disablePattern) && off.message.includes('不会删除或移动'));
    const on = SM.skillToggleCopy(target, true);
    assert.equal(on.okText, '启用');
    assert.ok(on.message.includes('删掉一条停用规则') && on.message.includes(target.disablePattern));
  });

  await check('extension facts keep installed / enabled / loaded / restartRequired separate and unknown', () => {
    const rows = Object.fromEntries(plain(EM.extensionFactRows({
      name: 'x', source: { type: 'local', location: 'C:/e.ts' }, scope: 'global',
      state: { installed: true, enabled: null, loaded: null, restartRequired: null, error: null },
    })));
    assert.deepEqual(rows, { 版本: '未知', 来源: 'local', 位置: 'C:/e.ts', 作用域: '全局', 已安装: '是', 已启用: '未知', 已加载: '无法确认', 需要重启: '未知' });
    assert.equal(EM.extensionStateLabel({ state: { error: { phase: 'discovery' } } }), '发现异常');
    assert.equal(EM.extensionStateLabel({ state: { error: { phase: 'load' }, loaded: true } }), '加载失败');
    assert.equal(EM.extensionStateLabel({ state: { loaded: true } }), '已加载');
    assert.equal(EM.extensionStateLabel({ state: { loaded: false } }), '未加载');
    assert.equal(EM.extensionStateLabel({ state: { loaded: null } }), '加载未知');
    assert.equal(EM.extensionScopeLabel('a-future-scope'), '未知');
  });

  await check('extension cards group by evidence: problems first, unknown never folded into 未加载', () => {
    const unknown = { ...EXT_OK, id: 'ext-3', state: { ...EXT_OK.state, loaded: null } };
    const unloaded = { ...EXT_OK, id: 'ext-4', state: { ...EXT_OK.state, loaded: false } };
    const groups = EM.groupExtensions([unknown, EXT_OK, unloaded, EXT_BROKEN]);
    assert.deepEqual(plain(groups.map((group) => [group.id, group.items.map((item) => item.id)])),
      [['problem', ['ext-2']], ['loaded', ['ext-1']], ['unloaded', ['ext-4']], ['unknown', ['ext-3']]]);
    assert.deepEqual(plain(EM.groupExtensions([])), []);
    assert.equal(EM.extensionCardMeta(EXT_OK), 'v1.0.0 · 本地 · 全局');
    assert.equal(EM.extensionCardMeta({ source: {}, scope: 'a-future-scope' }), '版本未知 · 未知来源 · 作用域未知');
    assert.deepEqual(plain(EM.extensionCardTags({ state: { enabled: false, restartRequired: true } })),
      [{ text: '已停用', tone: 'neutral' }, { text: '需要重启', tone: 'warning' }]);
    assert.deepEqual(plain(EM.extensionCardTags({ state: { enabled: null, restartRequired: null } })), [], 'null is not a tag');
  });

  await check('extension search uses the same state wording as the list', () => {
    const items = [EXT_OK, EXT_BROKEN];
    assert.deepEqual(plain(EM.filterExtensions(items, '加载失败').map((item) => item.id)), ['ext-2']);
    assert.deepEqual(plain(EM.filterExtensions(items, '  ').map((item) => item.id)), ['ext-1', 'ext-2']);
    assert.deepEqual(plain(EM.filterExtensions(items, 'PROJECT').map((item) => item.id)), ['ext-2']);
  });

  console.log('agent capability pages: Skills page lifecycle');
  const A = createWorld('skills', path.join(SKILLS_DIR, 'page.js'));
  const openSkillPages = [];
  /* 与 settings-surface.presentDetail 同一约定：build(card) 建页，关闭详情卡时调 onClose。 */
  const mountSkills = () => {
    let onClose = null;
    const card = A.d.createElement('section');
    A.d.body.append(card);
    A.w.openSkillsSettings({
      present: (build, close, options) => {
        card.className = 'modal-card settings-detail-card ' + ((options && options.className) || '');
        build(card);
        onClose = close;
      },
    });
    const page = { card, close() { onClose(); card.remove(); } };
    openSkillPages.push(page);
    return page;
  };
  const skillsCheck = (name, run) => check(name, async () => {
    try { await run(); } finally {
      for (const page of openSkillPages.splice(0)) page.close();
      A.reset();
      await tick();
    }
  });
  const rowOf = (card, name) => [...card.querySelectorAll('.skill-row')].find((row) => row.querySelector('.skill-name')?.textContent === name);
  const SKILL_GEN_BASE = A.listenerCount(GEN);

  await skillsCheck('Skills: one generation listener while open, none after close; a late list for a closed page is dropped', async () => {
    A.hold('GET /api/skills');
    const page = mountSkills();
    assert.equal(A.listenerCount(GEN), SKILL_GEN_BASE + 1);
    assert.equal(A.pendingCount('GET /api/skills'), 1);
    page.close();
    assert.equal(A.listenerCount(GEN), SKILL_GEN_BASE);
    A.release('GET /api/skills', SKILLS);
    await tick();
    assert.equal(page.card.querySelectorAll('.skill-row').length, 0, 'closed page must not render the late list');
    assert.match(page.card.textContent, /正在读取技能/);
    assert.equal(A.$('skillCount').textContent, '', 'closed page must not update the menu badge');
  });

  await skillsCheck('Skills: a project switch during the read shows the switched prompt, and 刷新 reads the current project', async () => {
    A.hold('GET /api/skills');
    const page = mountSkills();
    A.w.beginWorkspaceSwitch('C:\\fixture\\other');
    A.release('GET /api/skills', SKILLS);
    await tick();
    const body = page.card.querySelector('.skills-content');
    assert.equal(page.card.querySelectorAll('.skill-row').length, 0, 'old project rows must not render');
    assert.match(body.textContent, /项目已切换，刷新后查看当前项目的技能/);
    const refresh = [...body.querySelectorAll('button')].find((button) => button.textContent === '刷新');
    assert.ok(refresh, 'the prompt offers 刷新');
    A.answer('GET /api/skills', SKILLS);
    refresh.click();
    await tick();
    assert.equal(page.card.querySelectorAll('.skill-row').length, SKILLS.skills.length);
    assert.equal(A.$('skillCount').textContent, String(SKILLS.counts.total));
    page.close();
  });

  await skillsCheck('Skills: a project switch after loading hides rows and switches until refreshed', async () => {
    A.answer('GET /api/skills', SKILLS);
    const page = mountSkills();
    await tick();
    assert.equal(page.card.querySelectorAll('.skill-toggle').length, 3);
    A.w.beginWorkspaceSwitch('C:\\fixture\\third');
    assert.equal(page.card.querySelectorAll('.skill-row, .skill-toggle').length, 0, 'no switch may act on the old project');
    assert.match(page.card.querySelector('.skills-content').textContent, /项目已切换/);
    page.close();
  });

  await skillsCheck('Skills: filtering keeps the search box and listeners, and never re-reads the open SKILL.md', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/*', SKILL_DETAIL);
    const page = mountSkills();
    await tick();
    const detailReads = () => A.count('GET', '/api/skills/*');
    const before = detailReads();
    rowOf(page.card, 'code-review').querySelector('.skill-row-main').click();
    await tick();
    assert.equal(detailReads(), before + 1);
    const detail = page.card.querySelector('.skill-detail');
    assert.match(detail.textContent, /Fixture body of code-review/);
    const input = page.card.querySelector('.skills-search-input');
    for (const text of ['c', 'co', 'cod', 'code']) {
      input.value = text;
      input.dispatchEvent(new A.w.Event('input', { bubbles: true }));
    }
    await tick();
    assert.equal(page.card.querySelectorAll('.skill-row').length, 1);
    assert.equal(page.card.querySelector('.skill-detail'), detail, 'the open detail moves into the re-rendered row');
    assert.equal(page.card.querySelector('.skills-search-input'), input, 'the search box is not rebuilt');
    input.value = '';
    input.dispatchEvent(new A.w.Event('input', { bubbles: true }));
    page.card.querySelector('.ds-segment-item[data-value="project"]').click();
    assert.deepEqual([...page.card.querySelectorAll('.skill-name')].map((node) => node.textContent), ['proj-lint']);
    page.card.querySelector('.ds-segment-item[data-value=""]').click();
    await tick();
    assert.equal(page.card.querySelectorAll('.skill-row').length, 3);
    assert.equal(page.card.querySelector('.skill-detail'), detail);
    assert.equal(detailReads(), before + 1, 'filtering must not re-request SKILL.md');
    assert.equal(A.listenerCount(GEN), SKILL_GEN_BASE + 1, 'filters add no document listeners');
    page.close();
    assert.equal(A.listenerCount(GEN), SKILL_GEN_BASE);
  });

  await skillsCheck('Skills: expanding another skill while a detail is still reading never leaves a detail stuck on 读取中', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.hold('GET /api/skills/*');
    const page = mountSkills();
    await tick();
    const toggleRow = (name) => rowOf(page.card, name).querySelector('.skill-row-main').click();
    toggleRow('code-review');
    toggleRow('pdf-tools');
    toggleRow('pdf-tools');
    toggleRow('code-review');
    assert.equal(A.pendingCount('GET /api/skills/*'), 3, 're-expanding after another skill reads SKILL.md again');
    A.release('GET /api/skills/*', SKILL_DETAIL);
    A.release('GET /api/skills/*', { ...SKILL_DETAIL, skill: SKILLS.skills[2], content: 'Fixture body of pdf-tools' });
    await tick();
    const details = page.card.querySelectorAll('.skill-detail');
    assert.equal(details.length, 1);
    assert.match(details[0].textContent, /读取中…/, 'late answers for superseded expansions are dropped');
    assert.doesNotMatch(details[0].textContent, /pdf-tools/);
    A.release('GET /api/skills/*', SKILL_DETAIL);
    await tick();
    assert.match(details[0].textContent, /Fixture body of code-review/);
    assert.doesNotMatch(details[0].textContent, /读取中…/);
    page.close();
  });

  await skillsCheck('Skills: cancelling the confirmation restores the switch and writes nothing', async () => {
    A.answer('GET /api/skills', SKILLS);
    const page = mountSkills();
    await tick();
    const toggle = rowOf(page.card, 'code-review').querySelector('.skill-toggle');
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    toggle.click();
    await tick();
    assert.match(A.$('confirmCard').textContent, /停用这个 Skill/);
    A.confirmButton('取消').click();
    await tick();
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(A.count('PUT', '/api/skills/*'), 0);
    page.close();
  });

  await skillsCheck('Skills: a confirmation answered after closing the page or switching projects writes nothing', async () => {
    A.answer('GET /api/skills', SKILLS);
    let page = mountSkills();
    await tick();
    rowOf(page.card, 'code-review').querySelector('.skill-toggle').click();
    await tick();
    page.close();
    A.confirmButton('停用').click();
    await tick();
    assert.equal(A.count('PUT', '/api/skills/*'), 0, 'closed page must not write');

    page = mountSkills();
    await tick();
    rowOf(page.card, 'code-review').querySelector('.skill-toggle').click();
    await tick();
    A.w.beginWorkspaceSwitch('C:\\fixture\\fourth');
    A.confirmButton('停用').click();
    await tick();
    assert.equal(A.count('PUT', '/api/skills/*'), 0, 'a switch to another project must not write the old settings');
    assert.match(page.card.querySelector('.skills-content').textContent, /项目已切换/);
    page.close();
  });

  await skillsCheck('Skills: a confirmed toggle writes once, offers restart inline, then re-reads the list', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('PUT /api/skills/*', { ok: true, restartRequired: true, warnings: [] });
    A.answer('POST /api/restart', { ok: true });
    const page = mountSkills();
    await tick();
    const reads = A.count('GET', '/api/skills');
    rowOf(page.card, 'code-review').querySelector('.skill-toggle').click();
    await tick();
    A.confirmButton('停用').click();
    await tick();
    const puts = A.calls.filter((call) => call.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.equal(puts[0].url, '/api/skills/a000000000000001?project=c000000000000099');
    assert.deepEqual(puts[0].body, { enabled: false });
    const notice = page.card.querySelector('.skills-notice');
    assert.ok(notice, 'the result is inline, not a toast');
    assert.match(notice.textContent, /已停用 code-review/);
    assert.match(notice.textContent, /重启后生效/);
    assert.equal(A.count('POST', '/api/restart'), 0, 'restart waits for an explicit click');
    const restart = [...notice.querySelectorAll('button')].find((button) => button.textContent === '重启 pi');
    assert.ok(restart, 'the notice offers 重启 pi');
    restart.click();
    await tick();
    assert.equal(A.count('POST', '/api/restart'), 1, 'clicking 重启 pi sends the restart');
    assert.match(page.card.querySelector('.skills-notice').textContent, /已请求重启 pi/);
    assert.equal(A.count('GET', '/api/skills'), reads + 1, 'the list is re-read once after the write');
    page.close();
    assert.equal(A.listenerCount(GEN), SKILL_GEN_BASE);
  });

  await skillsCheck('Skills: one title and one toolbar, then 全局级 before 项目级, each with its discovery dir and count', async () => {
    A.answer('GET /api/skills', SKILLS);
    const page = mountSkills();
    await tick();
    assert.equal(page.card.querySelectorAll('h1, h2').length, 1, 'one page title');
    assert.equal(page.card.querySelector('.skills-title').textContent, '技能');
    assert.equal(page.card.querySelector('.settings-page-title'), null, 'the page uses its own title, not the 30px settings title');
    assert.equal(page.card.querySelector('.skills-head-count').textContent, '3 个技能');
    assert.equal(page.card.querySelectorAll('.ext-tabs, .ext-tab').length, 0, 'the old mixed tab strip is gone');
    assert.deepEqual([...page.card.querySelector('.skills-toolbar').children].map((node) => node.classList[0]),
      ['ds-segmented', 'skills-search', 'skills-project']);
    assert.deepEqual([...page.card.querySelectorAll('.skills-actions-bar .btn span')].map((node) => node.textContent),
      ['扫描', '新建', '市场']);
    assert.equal(page.card.querySelector('.skills-project-select').value, 'c000000000000099');
    const seg = (value) => page.card.querySelector(`.skills-scope .ds-segment-item[data-value="${value}"]`);
    const segText = (value) => [seg(value).querySelector('.ds-segment-label').textContent, seg(value).querySelector('.ds-segment-count').textContent];
    assert.deepEqual(['', 'user', 'project'].map(segText), [['全部', '3'], ['全局', '2'], ['项目', '1']]);
    assert.equal(seg('temporary').hidden, true, 'no --skill entries: the 临时 tab stays hidden');
    const groups = [...page.card.querySelectorAll('.skills-group')].map((group) => [
      group.dataset.scope,
      group.querySelector('.skills-group-title').textContent,
      group.querySelector('.skills-group-path').textContent,
      group.querySelector('.skills-group-path').title,
      group.querySelector('.skills-group-count').textContent,
      [...group.querySelectorAll('.skill-name')].map((node) => node.textContent),
    ]);
    assert.deepEqual(groups, [
      ['user', '全局级', '~/.pi/agent/skills', AGENT + '\\skills', '2', ['code-review', 'pdf-tools']],
      ['project', '项目级', '<项目>/.pi/skills', PROJECT + '\\.pi\\skills', '1', ['proj-lint']],
    ], 'server order inside each group; the group path is the discovery dir, its title the full dir');
    const badges = (name) => [...rowOf(page.card, name).querySelectorAll('.ds-badge')].map((node) => [node.textContent, node.className]);
    assert.deepEqual(badges('code-review'), [
      ['全局', 'ds-badge ds-badge-neutral'],
      ['已启用', 'ds-badge ds-badge-success'],
      ['已加载', 'ds-badge ds-badge-success'],
    ], 'scope, enabled and actually loaded stay separate');
    assert.deepEqual(badges('pdf-tools'), [['全局', 'ds-badge ds-badge-neutral'], ['已停用', 'ds-badge ds-badge-neutral']]);
    const pdf = rowOf(page.card, 'pdf-tools');
    assert.equal(pdf.querySelector('.skill-row-note'), null, 'why it is off is technical detail: it belongs in the expanded detail');
    assert.ok(pdf.querySelector('.skill-glyph .ext-dot').classList.contains('off'));
    const review = rowOf(page.card, 'code-review');
    assert.equal(review.querySelector('.skill-row-desc').textContent, 'Review source code for bugs');
    const main = review.querySelector('.skill-row-main');
    assert.equal(main.getAttribute('aria-expanded'), 'false');
    assert.equal(main.getAttribute('aria-controls'), 'skillDetail-a000000000000001');
    assert.equal(main.contains(review.querySelector('.skill-toggle')), false, 'the switch is not nested inside the row button');
    page.close();
  });

  await skillsCheck('Skills: an empty group says what is missing; a filter with no match shows one empty state, not one per group', async () => {
    const userOnly = { ...SKILLS, skills: SKILLS.skills.filter((item) => item.scope === 'user'), counts: { total: 2, enabled: 1, project: 0, user: 2 } };
    A.answer('GET /api/skills', userOnly);
    const page = mountSkills();
    await tick();
    const group = (scope) => page.card.querySelector(`.skills-group[data-scope="${scope}"]`);
    assert.equal(group('project').querySelector('.skills-empty').textContent, '此目录中没有技能');
    assert.equal(group('project').querySelector('.skills-group-count').textContent, '0');
    assert.equal(group('project').querySelector('.skills-group-path').textContent, '<项目>/.pi/skills', 'an empty group still says where pi looks');
    const input = page.card.querySelector('.skills-search-input');
    const type = (text) => { input.value = text; input.dispatchEvent(new A.w.Event('input', { bubbles: true })); };
    type('no-such-skill');
    assert.equal(page.card.querySelectorAll('.skills-group').length, 0);
    assert.deepEqual([...page.card.querySelectorAll('.skills-empty')].map((node) => node.textContent), ['没有符合筛选条件的技能']);
    type('pdf');
    assert.deepEqual([...page.card.querySelectorAll('.skills-group')].map((node) => node.dataset.scope), ['user'],
      'while searching only groups with matches remain');
    type('');
    assert.deepEqual([...page.card.querySelectorAll('.skills-group')].map((node) => node.dataset.scope), ['user', 'project']);
    page.close();

    A.answer('GET /api/skills', { ...userOnly, hasProject: false, cwd: '', projectSettings: null, roots: SKILLS.roots.filter((root) => root.scope === 'user') });
    const noProject = mountSkills();
    await tick();
    const project = noProject.card.querySelector('.skills-group[data-scope="project"]');
    assert.equal(project.querySelector('.skills-empty').textContent, '还没有打开项目');
    assert.equal(project.querySelector('.skills-group-path').textContent, '', 'no project: no made-up project dir');
    noProject.close();
  });

  await skillsCheck('Skills: --skill entries bring up the 临时 tab and group; the tab falls back to 全部 once they are gone', async () => {
    /* 形状照抄 server/skills.js 里「pi 报了但磁盘没枚举到」的补录分支（--skill 走这里）。 */
    const temporary = {
      id: 't000000000000001', name: 'one-off', description: 'Loaded with --skill', scope: 'temporary', source: 'auto',
      origin: 'top-level', mode: 'pi', rootLabel: 'C:\\fixture\\one-off', path: 'C:\\fixture\\one-off\\SKILL.md',
      dir: 'C:\\fixture\\one-off', file: 'SKILL.md', rel: '', baseDir: 'C:\\fixture\\one-off', loaded: true, state: 'enabled',
      stateNote: '由 pi 报告为已加载（Pi GUI 未在磁盘发现它，可能来自 package）', disablePattern: '', settingsPath: null,
      toggleable: false, blockedByTrust: false, disabledBy: '', disableModelInvocation: false, license: '', compatibility: '', bytes: null, errors: [],
    };
    A.answer('GET /api/skills', { ...SKILLS, skills: [...SKILLS.skills, temporary], counts: { ...SKILLS.counts, total: 4 } });
    const page = mountSkills();
    await tick();
    const seg = (value) => page.card.querySelector(`.skills-scope .ds-segment-item[data-value="${value}"]`);
    assert.equal(seg('temporary').hidden, false);
    assert.equal(seg('temporary').querySelector('.ds-segment-count').textContent, '1');
    const temp = page.card.querySelector('.skills-group[data-scope="temporary"]');
    assert.equal(temp.querySelector('.skills-group-title').textContent, '临时（--skill）');
    assert.equal(temp.querySelector('.skills-group-path').textContent, 'C:\\fixture\\one-off', "no discovery root: the entry's own root label");
    assert.equal(rowOf(page.card, 'one-off').querySelector('.skill-toggle'), null, 'a --skill entry has no switch');
    seg('temporary').click();
    assert.deepEqual([...page.card.querySelectorAll('.skills-group')].map((node) => node.dataset.scope), ['temporary']);
    A.answer('GET /api/skills', SKILLS);
    page.card.querySelector('.skills-head .skills-icon-btn[aria-label="刷新技能列表"]').click();
    await tick();
    assert.equal(seg('temporary').hidden, true);
    assert.equal(seg('').getAttribute('aria-checked'), 'true', 'a hidden tab cannot stay selected');
    assert.deepEqual([...page.card.querySelectorAll('.skills-group')].map((node) => node.dataset.scope), ['user', 'project']);
    page.close();
  });

  await skillsCheck('Skills: an untrusted project marks its rows with a warning badge and one trust note above the list', async () => {
    const untrusted = {
      ...SKILLS,
      trust: { ...SKILLS.trust, trusted: false, reason: 'untrusted' },
      roots: SKILLS.roots.map((root) => (root.scope === 'project' ? { ...root, blockedByTrust: true } : root)),
      skills: SKILLS.skills.map((item) => (item.scope === 'project'
        ? { ...item, state: 'untrusted', loaded: false, blockedByTrust: true, stateNote: '项目未被信任：pi 在非交互模式下不加载项目级资源' }
        : item)),
    };
    A.answer('GET /api/skills', untrusted);
    A.answer('GET /api/skills/*', { ...SKILL_DETAIL, skill: untrusted.skills[0], content: 'Fixture body of proj-lint' });
    const page = mountSkills();
    await tick();
    const notes = [...page.card.querySelectorAll('.skills-notes .cfg-note')].map((node) => node.textContent);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /当前项目未被信任/);
    const lint = rowOf(page.card, 'proj-lint');
    assert.deepEqual([...lint.querySelectorAll('.ds-badge')].map((node) => [node.textContent, node.className]),
      [['项目', 'ds-badge ds-badge-neutral'], ['未加载（项目未信任）', 'ds-badge ds-badge-warning']]);
    assert.equal(lint.querySelector('.skill-row-note'), null, 'the trust reason is technical detail, not row noise');
    lint.querySelector('.skill-row-main').click();
    await tick();
    assert.match(page.card.querySelector('.skill-detail').textContent, /项目未被信任：pi 在非交互模式下不加载项目级资源/);
    page.close();
  });

  console.log('agent capability pages: Extensions page lifecycle');
  const B = createWorld('extensions', path.join(EXT_DIR, 'page.js'));
  B.w.S.hasProject = true;
  B.answer('GET /api/approvals/capability', APPROVAL);
  const NOTICE_TYPES = ['pi-gui:extension-notices', GEN, 'pi-gui:feedback-context'];
  const EXT_BASE = Object.fromEntries(NOTICE_TYPES.map((type) => [type, B.listenerCount(type)]));
  const extItems = () => B.d.querySelectorAll('#extensionsTabPanel .ext-extension-item');
  const deltas = () => NOTICE_TYPES.map((type) => B.listenerCount(type) - EXT_BASE[type]);
  const extCheck = (name, run) => check(name, async () => {
    try { await run(); } finally {
      B.w.showChat();
      B.reset();
      await tick();
    }
  });

  await extCheck('Extensions: listeners are registered once per page, not per reopen, and all removed on 返回会话', async () => {
    B.answer('GET /api/extensions', registry([EXT_OK, EXT_BROKEN]));
    B.w.openExtensions();
    await tick();
    assert.deepEqual(deltas(), [1, 2, 1], 'notices listen to three events; the installed panel adds one generation listener');
    B.w.openExtensions();
    await tick();
    assert.deepEqual(deltas(), [1, 2, 1], 'reopening replaces the old page instead of stacking listeners');
    B.w.showChat();
    assert.deepEqual(deltas(), [0, 0, 0]);
    assert.equal(B.$('workSurface').childElementCount, 0);
  });

  await extCheck('Extensions: tabs reuse the installed panel without re-reading the Registry; the market sends nothing', async () => {
    B.answer('GET /api/extensions', registry([EXT_OK, EXT_BROKEN]));
    B.w.openExtensions();
    await tick();
    const reads = B.count('GET', '/api/extensions');
    const holder = B.d.querySelector('#extensionsTabPanel .extensions-tab-installed');
    assert.equal(extItems().length, 2);
    const callsBefore = B.calls.length;
    B.$('extensionsTabMarket').click();
    await tick();
    const panel = B.$('extensionsTabPanel');
    assert.ok(panel.querySelector('.extensions-market-empty'));
    assert.equal(B.calls.length, callsBefore, 'the market placeholder sends no request');
    assert.equal(panel.querySelectorAll('button').length, 0, 'the market has no install action in phase 1');
    B.$('extensionsTabInstalled').click();
    await tick();
    assert.equal(B.d.querySelector('#extensionsTabPanel .extensions-tab-installed'), holder, 'the installed panel is reused');
    assert.equal(B.count('GET', '/api/extensions'), reads, 'switching tabs does not re-read the Registry');
    const tablist = B.d.querySelector('.extensions-tabs');
    tablist.dispatchEvent(new B.w.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(B.$('extensionsTabMarket').getAttribute('aria-selected'), 'true');
    assert.equal(B.d.activeElement, B.$('extensionsTabMarket'));
    tablist.dispatchEvent(new B.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(B.$('extensionsTabInstalled').getAttribute('aria-selected'), 'true', 'arrow keys wrap around');
    assert.equal(B.count('GET', '/api/extensions'), reads);
    B.w.showChat();
  });

  await extCheck('Extensions: live extension notices render above the tabs and follow tab switches', async () => {
    B.w.S.switching = false; // 切换中的提示会被丢弃；这里验证的是正常运行时的提示
    B.answer('GET /api/extensions', registry([EXT_OK]));
    B.w.openExtensions();
    await tick();
    const notices = () => B.d.querySelector('#workSurface .extension-notices');
    assert.equal(notices().hidden, true, 'no notices yet: the section stays hidden');
    B.w.handleExtensionNotification({ message: 'memory_search requires qmd. Install qmd', notifyType: 'warning' });
    assert.equal(notices().hidden, false);
    assert.ok(notices().textContent.includes('memory_search requires qmd'), 'the notice reaches the open page');
    B.$('extensionsTabMarket').click();
    await tick();
    assert.ok(notices().textContent.includes('memory_search requires qmd'), 'notices sit above the tabs, not inside one panel');
    assert.equal(B.$('extensionsTabPanel').contains(notices()), false);
    B.w.handleExtensionNotification({ message: 'memory_search requires qmd. Install qmd', notifyType: 'warning' });
    assert.ok(notices().textContent.includes('重复 2 次'), 'a repeated notice updates the same row');
    B.w.showChat();
  });

  await extCheck('Extensions: legacy entry parameters land on 已安装; 插件市场 can be opened directly', async () => {
    B.answer('GET /api/extensions', registry([EXT_OK]));
    for (const [tab, expected] of [[undefined, 'installed'], ['extensions', 'installed'], ['skills', 'installed'], ['mcp', 'installed'], ['market', 'market']]) {
      B.w.openExtensions(tab === undefined ? undefined : { tab });
      await tick();
      const selected = [...B.d.querySelectorAll('.extensions-tab[aria-selected="true"]')].map((button) => button.dataset.tab);
      assert.deepEqual(selected, [expected], `tab ${tab}`);
      assert.equal(B.$('workViewTitle').textContent, '扩展');
      assert.equal(B.$('navExtensions').getAttribute('aria-current'), 'page');
    }
    B.w.showChat();
  });

  await extCheck('Extensions: a project switch during the Registry read shows the switched prompt, not the old list', async () => {
    B.hold('GET /api/extensions');
    B.w.openExtensions();
    const approvals = B.count('GET', '/api/approvals/capability');
    B.w.beginWorkspaceSwitch('C:\\fixture\\during');
    B.release('GET /api/extensions', registry([EXT_OK, EXT_BROKEN]));
    await tick();
    assert.equal(extItems().length, 0, 'the old project list must not render');
    assert.match(B.d.querySelector('#extensionsTabPanel .extensions-list').textContent, /项目已切换，刷新后查看当前项目的扩展/);
    assert.equal(B.d.querySelector('.extensions-tab-count').textContent, '');
    assert.equal(B.count('GET', '/api/approvals/capability'), approvals, 'no follow-up request for the old project');
  });

  await extCheck('Extensions: the installed panel honours its work-surface identity, not just its own dispose', async () => {
    /* 页面壳把 instance.isCurrent 交给面板；面板即使还没被 dispose，只要承载已不是当前实例，
     * 迟到的 Registry 也不能写进来（拆分要求保留的「实例身份」校验）。 */
    B.hold('GET /api/extensions');
    let current = true;
    const holder = B.d.createElement('div');
    B.d.body.append(holder);
    const counts = [];
    const panel = B.w.renderInstalledExtensions(holder, { isLive: () => current, onCount: (value) => counts.push(value) });
    try {
      current = false;
      B.release('GET /api/extensions', registry([EXT_OK]));
      await tick();
      assert.equal(holder.querySelectorAll('.ext-extension-item').length, 0);
      assert.deepEqual(counts, [], 'no count is reported for a surface that is gone');
    } finally {
      panel.dispose();
      holder.remove();
    }
  });

  await extCheck('Extensions: a project switch replaces the list with the switched prompt and clears the tab count', async () => {
    B.answer('GET /api/extensions', registry([EXT_OK, EXT_BROKEN]));
    B.w.openExtensions();
    await tick();
    const count = () => B.d.querySelector('.extensions-tab-count').textContent;
    assert.equal(count(), '2');
    B.w.beginWorkspaceSwitch('C:\\fixture\\other');
    const list = B.d.querySelector('#extensionsTabPanel .extensions-list');
    assert.match(list.textContent, /项目已切换，刷新后查看当前项目的扩展/);
    assert.equal(extItems().length, 0);
    assert.equal(count(), '', 'an unknown count is blank, not the old number');
    B.answer('GET /api/extensions', registry([EXT_OK]));
    [...list.querySelectorAll('button')].find((button) => button.textContent === '刷新').click();
    await tick();
    assert.equal(extItems().length, 1);
    assert.equal(count(), '1');
    B.w.showChat();
  });

  await extCheck('Extensions: a Registry answer for a closed page never reaches the reopened page', async () => {
    B.hold('GET /api/extensions');
    const approvals = B.count('GET', '/api/approvals/capability');
    B.w.openExtensions();
    B.w.showChat();
    B.w.openExtensions();
    assert.equal(B.pendingCount('GET /api/extensions'), 2);
    B.release('GET /api/extensions', registry([EXT_OK, EXT_BROKEN]));
    await tick();
    assert.equal(extItems().length, 0, 'the stale answer is dropped');
    assert.equal(B.count('GET', '/api/approvals/capability'), approvals, 'the closed page starts no follow-up request');
    B.release('GET /api/extensions', registry([EXT_OK]));
    await tick();
    assert.equal(extItems().length, 1);
    assert.equal(B.d.querySelector('.extensions-tab-count').textContent, '1');
    B.w.showChat();
    assert.deepEqual(deltas(), [0, 0, 0]);
  });

  await extCheck('Extensions: one 扩展 title; the tabs share a row with the search, 刷新 sits in the header; cards group by evidence', async () => {
    B.answer('GET /api/extensions', registry([EXT_OK, EXT_BROKEN]));
    B.w.openExtensions();
    await tick();
    const surface = B.$('workSurface');
    assert.deepEqual([...surface.querySelectorAll('h1, h2')].map((node) => node.textContent), ['扩展'], 'the page draws one title');
    assert.equal(surface.querySelectorAll('.ext-tabs, .ext-tab, .ext-body').length, 0, 'the old mixed tab strip is gone');
    const head = surface.querySelector('.extensions-head');
    const actions = head.querySelector('.extensions-head-actions');
    const refresh = actions.querySelector('.extensions-refresh');
    assert.ok(refresh, '刷新 sits in the page header');
    const slot = surface.querySelector('.extensions-toolbar-row > .extensions-toolbar-slot');
    const input = slot.querySelector('.extensions-search-input');
    assert.ok(input, 'the search shares the row with the tabs');
    assert.deepEqual([...surface.querySelectorAll('.extensions-tab')].map((button) => [
      button.querySelector('.extensions-tab-label').textContent, button.querySelector('.ds-segment-count')?.textContent ?? null,
    ]), [['已安装', '2'], ['插件市场', null]]);
    assert.deepEqual([...surface.querySelectorAll('.extensions-group')].map((group) => [
      group.dataset.group,
      group.querySelector('.extensions-group-title').textContent,
      group.querySelector('.extensions-group-count').textContent,
      [...group.querySelectorAll('.extensions-card')].map((card) => card.dataset.extensionId),
    ]), [['problem', '需要处理', '1', ['ext-2']], ['loaded', '已加载', '1', ['ext-1']]], 'a load error is listed first, never mixed into 未加载');
    const ok = surface.querySelector('.extensions-card[data-extension-id="ext-1"]');
    assert.equal(ok.querySelector('.ext-name').textContent, 'Sample Extension');
    assert.equal(ok.querySelector('.extensions-card-meta').textContent, 'v1.0.0 · 本地 · 全局');
    assert.equal(ok.querySelector('.extensions-card-desc').textContent, 'Fixture extension');
    assert.deepEqual([...ok.querySelectorAll('.extensions-cap')].map((chip) => [chip.textContent, chip.title]), [['hello', 'command: hello']]);
    assert.equal(ok.querySelectorAll('.ds-badge').length, 0, 'enabled: true and restartRequired: null add no tag');
    const broken = surface.querySelector('.extensions-card[data-extension-id="ext-2"]');
    assert.ok(broken.classList.contains('is-error'));
    assert.equal(broken.querySelector('.extensions-card-meta').textContent, '版本未知 · 本地 · 项目');
    assert.equal(broken.querySelector('.extensions-card-desc').textContent, '（没有简介）');
    assert.equal(broken.querySelector('.extensions-card-error').textContent, '加载失败：Pi 报告扩展加载错误');

    const toggle = ok.querySelector('.extensions-card-toggle');
    const details = B.$(toggle.getAttribute('aria-controls'));
    assert.ok(details && ok.contains(details), 'the toggle controls the details inside its own card');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(details.hidden, true);
    assert.equal(details.childElementCount, 0, 'facts are built on first open, not for every card up front');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(details.hidden, false);
    const facts = Object.fromEntries([...details.querySelectorAll('.ext-row')].map((node) => [node.firstChild.textContent, node.lastChild.textContent]));
    assert.equal(facts['位置'], 'C:/fixture/extensions/sample.ts');
    assert.equal(facts['需要重启'], '未知', 'null stays 未知 in the facts');
    assert.match(details.textContent, /已确认的能力.*command: hello/);
    assert.equal(details.textContent.includes('Fixture extension'), false, 'the description is on the card, not repeated in the details');
    assert.ok(ok.classList.contains('is-open'), 'an open card lifts the two-line clamp on its description');
    const brokenToggle = broken.querySelector('.extensions-card-toggle');
    brokenToggle.click();
    const brokenDetails = B.$(brokenToggle.getAttribute('aria-controls'));
    const brokenFacts = Object.fromEntries([...brokenDetails.querySelectorAll('.ext-row')].map((node) => [node.firstChild.textContent, node.lastChild.textContent]));
    assert.equal(brokenFacts['错误阶段'], 'load', 'the raw Registry phase stays visible');
    assert.equal(brokenDetails.textContent.includes('Pi 报告扩展加载错误'), false, 'the error message is on the card once, not repeated');
    brokenToggle.click();
    toggle.click();
    assert.equal(details.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    assert.equal(details.querySelectorAll('.ext-row').length, 8, 'reopening shows the same facts once, not appended again');

    input.value = 'sample';
    input.dispatchEvent(new B.w.Event('input', { bubbles: true }));
    assert.equal(slot.querySelector('.extensions-result-count').textContent, '找到 1 个，共 2 个');
    assert.deepEqual([...surface.querySelectorAll('.extensions-card')].map((card) => card.dataset.extensionId), ['ext-1']);
    const reopened = surface.querySelector('.extensions-card[data-extension-id="ext-1"] .extensions-card-toggle');
    assert.equal(reopened.getAttribute('aria-expanded'), 'true', 'an open card stays open across a search re-render');
    assert.equal(reopened.getAttribute('aria-controls'), toggle.getAttribute('aria-controls'), 'the details id is stable per extension');
    assert.equal(B.$(reopened.getAttribute('aria-controls')).hidden, false);

    B.$('extensionsTabMarket').click();
    assert.equal(slot.childElementCount, 0, 'the market tab has no search in phase 1');
    assert.equal(actions.childElementCount, 0, 'the market tab has no header action in phase 1');
    B.$('extensionsTabInstalled').click();
    assert.equal(slot.querySelector('.extensions-search-input'), input, 'the same search box comes back');
    assert.equal(input.value, 'sample', 'with its text');
    assert.equal(actions.querySelector('.extensions-refresh'), refresh);

    input.value = 'no-such-extension';
    input.dispatchEvent(new B.w.Event('input', { bubbles: true }));
    assert.equal(surface.querySelectorAll('.extensions-group').length, 0);
    assert.deepEqual([...surface.querySelectorAll('.extensions-list .extensions-empty-title')].map((node) => node.textContent), ['没有符合搜索条件的扩展']);
    assert.equal(slot.querySelector('.extensions-result-count').textContent, '找到 0 个，共 2 个');
    input.value = '';
    input.dispatchEvent(new B.w.Event('input', { bubbles: true }));
    assert.equal(slot.querySelector('.extensions-result-count').textContent, '', 'no count line without a search');

    const reads = B.count('GET', '/api/extensions');
    refresh.click();
    assert.equal(refresh.disabled, true, '刷新 is disabled while the Registry is read');
    await tick();
    assert.equal(B.count('GET', '/api/extensions'), reads + 1);
    assert.equal(refresh.disabled, false);
    B.w.showChat();
  });

  await extCheck('Extensions: an empty Registry and a failed read are tiles with a real next step; 已知能力 stays available', async () => {
    B.answer('GET /api/extensions', registry([{ ...EXT_OK, id: 'ext-3', state: { ...EXT_OK.state, loaded: null } }]));
    B.w.openExtensions();
    await tick();
    const list = () => B.d.querySelector('#extensionsTabPanel .extensions-list');
    assert.deepEqual([...list().querySelectorAll('.extensions-group')].map((group) => group.dataset.group), ['unknown'],
      'loaded: null is its own group, not 未加载');
    assert.equal(list().querySelector('.extensions-group-title').textContent, '加载状态未知');
    B.answer('GET /api/extensions', registry([]));
    const refresh = B.d.querySelector('.extensions-head-actions .extensions-refresh');
    refresh.click();
    await tick();
    assert.deepEqual([...list().querySelectorAll('.extensions-empty-title')].map((node) => node.textContent), ['还没有发现已安装的扩展']);
    assert.equal(B.d.querySelector('.extensions-tab-count').textContent, '0');
    B.answer('GET /api/extensions', { ok: false, error: 'fixture: registry failed' });
    refresh.click();
    await tick();
    assert.equal(list().querySelector('.extensions-empty-title').textContent, '扩展读取失败。');
    assert.equal(B.d.querySelector('.extensions-tab-count').textContent, '', 'a failed read leaves the count unknown, not 0');
    const retry = [...list().querySelectorAll('button')].find((button) => button.textContent === '重试');
    assert.ok(retry, 'the failure tile offers the real retry path');
    assert.deepEqual([...B.d.querySelectorAll('#extensionsTabPanel .ext-known-item > summary')].map((node) => node.textContent),
      ['Web Access', 'Subagents', 'Pi Memory', 'Browser Use', 'Approval / Permission'], 'known capabilities stay reachable after a failure');
    assert.equal(B.d.querySelector('#extensionsKnownTitle').textContent, '已知能力');
    B.answer('GET /api/extensions', registry([EXT_OK]));
    const reads = B.count('GET', '/api/extensions');
    retry.click();
    await tick();
    assert.equal(B.count('GET', '/api/extensions'), reads + 1);
    assert.equal(extItems().length, 1);
    B.w.showChat();
  });

  console.log('agent capability pages: MCP report lifecycle');
  const C = createWorld('mcp-report', REPORT);
  const REPORT_GEN_BASE = C.listenerCount(GEN);
  const openReports = [];
  const mountReport = () => {
    const report = C.w.createMcpReport();
    C.d.body.append(report.element);
    openReports.push(report);
    return report;
  };
  const reportCheck = (name, run) => check(name, async () => {
    try { await run(); } finally {
      for (const report of openReports.splice(0)) { report.dispose(); report.element.remove(); }
      C.reset();
      await tick();
    }
  });
  const reportBody = (report) => report.element.querySelector('.mcp-report-body');

  await reportCheck('MCP report: no request until expanded, and reopening does not re-read', async () => {
    C.hold('GET /api/mcp');
    const report = mountReport();
    await tick();
    assert.equal(C.count('GET', '/api/mcp'), 0, 'collapsed report sends nothing');
    report.element.open = true;
    await tick();
    assert.equal(C.count('GET', '/api/mcp'), 1);
    C.release('GET /api/mcp', MCP_REPORT);
    await tick();
    assert.match(reportBody(report).textContent, /这个 pi 带 MCP 能力/);
    report.element.open = false;
    await tick();
    report.element.open = true;
    await tick();
    assert.equal(C.count('GET', '/api/mcp'), 1, 'reopening keeps the loaded report');
    report.dispose();
    report.element.remove();
  });

  await reportCheck('MCP report: a project switch shows the switched prompt during and after a read; 刷新 reads again', async () => {
    C.hold('GET /api/mcp');
    const report = mountReport();
    report.element.open = true;
    await tick();
    C.w.beginWorkspaceSwitch('C:\\fixture\\other');
    C.release('GET /api/mcp', MCP_REPORT);
    await tick();
    assert.match(reportBody(report).textContent, /项目已切换，刷新后查看当前项目的 MCP 能力报告/);
    assert.doesNotMatch(reportBody(report).textContent, /带 MCP 能力/);
    C.answer('GET /api/mcp', MCP_REPORT);
    [...reportBody(report).querySelectorAll('button')].find((button) => button.textContent === '刷新').click();
    await tick();
    assert.match(reportBody(report).textContent, /这个 pi 带 MCP 能力/);
    C.w.beginWorkspaceSwitch('C:\\fixture\\third');
    assert.match(reportBody(report).textContent, /项目已切换/);
    assert.doesNotMatch(reportBody(report).textContent, /带 MCP 能力/, 'loaded evidence of the old project is replaced');
    report.dispose();
    report.element.remove();
  });

  await reportCheck('MCP report: dispose drops a late report and removes its listener', async () => {
    C.hold('GET /api/mcp');
    const report = mountReport();
    assert.equal(C.listenerCount(GEN), REPORT_GEN_BASE + 1);
    report.element.open = true;
    await tick();
    report.dispose();
    assert.equal(C.listenerCount(GEN), REPORT_GEN_BASE);
    C.release('GET /api/mcp', MCP_REPORT);
    await tick();
    assert.doesNotMatch(reportBody(report).textContent, /带 MCP 能力/);
    report.element.remove();
  });

  await reportCheck('MCP report: native state follows the MCP page without another request', async () => {
    C.answer('GET /api/mcp', MCP_REPORT);
    const report = mountReport();
    const reads = C.count('GET', '/api/mcp');
    report.setNative({ state: 'active', reason: 'fixture native reason' });
    report.element.open = true;
    await tick();
    const native = () => report.element.querySelector('.mcp-report-native').textContent;
    assert.match(native(), /原生 MCP 生效中/);
    assert.match(native(), /fixture native reason/);
    report.setNative({ state: 'a-future-state' });
    assert.match(native(), /原生状态未知/, 'an unknown native state is not guessed');
    report.setNative({ state: 'active' });
    report.setNative(undefined);
    assert.match(native(), /原生状态未知/, 'a summary without a native object stays unknown');
    report.setNative({ state: 'active' });
    report.setNative(null);
    assert.match(native(), /读不到原生 MCP 摘要/, 'a failed summary read says so');
    assert.equal(report.element.querySelector('.mcp-report-native h4'), null, 'no verdict headline is kept from the previous read');
    assert.equal(C.count('GET', '/api/mcp'), reads + 1, 'native updates reuse the MCP page data');
    report.dispose();
    report.element.remove();
  });

  await check('no uncaught errors or console errors in the three page worlds', () => {
    assert.deepEqual(pageErrors, []);
  });

  for (const world of [A, B, C]) world.w.close();
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
