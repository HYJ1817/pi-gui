/* 技能页第二阶段的交互回归：创建 / 编辑 / 删除 / 导入 / 外部扫描 / 市场。
 *
 * 全部离线：jsdom + 注入的 fetch；返回形状照抄 server/skills-*.js 的真实响应。
 * 不启动服务、不碰真 pi、不写盘；上传用内存 File，FileReader 读出的也是内存里的字节。
 *
 * 重点不是「按钮存在」，而是：
 *   · 写入带对项目与目标，冲突 / 过期 / 只读有可见的恢复路径；
 *   · 市场打开只读本机缓存，联网只发生在明确的预览 / 刷新手势上，安装只认预览令牌；
 *   · 迟到的响应不会打开已经关掉的弹窗，也不会把旧项目的结果写进新页面。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const SKILLS_DIR = path.join(PUB, 'skills');
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
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (value) => JSON.parse(JSON.stringify(value));

/* ---------- fixture：形状照抄服务端 ---------- */
const HOME = 'C:\\fixture\\home';
const AGENT = HOME + '\\.pi\\agent';
const PROJECT = 'C:\\fixture\\project';
const PROJECT_ID = 'c000000000000099';
const UNDO = 'a'.repeat(24);
function skill(over) {
  const scope = over.scope || 'user';
  const base = scope === 'project' ? PROJECT + '\\.pi' : AGENT;
  const relPath = `skills/${over.name}/SKILL.md`;
  return {
    description: `${over.name} fixture`, scope, source: 'auto', origin: 'top-level', mode: 'pi',
    rootLabel: scope === 'project' ? '<项目>/.pi/skills' : '~/.pi/agent/skills',
    path: `${base}\\skills\\${over.name}\\SKILL.md`, dir: `${base}\\skills\\${over.name}`, file: 'SKILL.md',
    rel: relPath, baseDir: base, loaded: true, state: 'enabled', stateNote: '', shadowedBy: null,
    disablePattern: '-' + relPath, settingsPath: `${base}\\settings.json`, toggleable: true,
    blockedByTrust: false, disabledBy: '', disableModelInvocation: false, license: '', compatibility: '', bytes: 120, errors: [],
    manage: { target: scope === 'project' ? 'project-pi' : 'user-pi', editable: true, deletable: true, reason: '' },
    ...over,
  };
}
const SKILLS = {
  ok: true, hasProject: true, cwd: PROJECT, agentDir: AGENT, homeDir: HOME,
  globalSettings: AGENT + '\\settings.json', projectSettings: PROJECT + '\\.pi\\settings.json',
  trust: { trusted: true, requiresTrust: true, reason: 'trusted', trustFile: AGENT + '\\trust.json' },
  piReachable: true,
  context: { project: PROJECT_ID, live: true },
  projects: [{ id: PROJECT_ID, name: 'Fixture project', path: PROJECT, active: true }],
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
  counts: { total: 2, enabled: 2, project: 1, user: 1 },
  skills: [
    skill({ id: 'a000000000000001', name: 'code-review', description: 'Review source code for bugs' }),
    skill({ id: 'p000000000000001', name: 'proj-lint', scope: 'project', description: 'Project lint rules' }),
  ],
};
const SOURCE = {
  ok: true, id: 'a000000000000001', name: 'code-review', dirName: 'code-review', scope: 'user',
  target: 'user-pi', targetLabel: '~/.pi/agent/skills', path: AGENT + '\\skills\\code-review\\SKILL.md',
  content: '---\nname: code-review\ndescription: Review source code for bugs\n---\nOld body\n',
  hash: 'hash-1', eol: '\n', bom: false, bytes: 80,
  form: {
    available: true, generated: '', name: 'code-review', description: 'Review source code for bugs',
    body: 'Old body\n', extraKeys: [], reason: '',
  },
  limits: {},
};
const DETAIL = {
  ok: true, skill: SKILLS.skills[0], readable: true, truncated: false,
  content: SOURCE.content, files: [{ name: 'SKILL.md', dir: false, size: 80 }],
};
const CHECK_OK = { ok: true, errors: [], warnings: [], bytes: 90, content: '---\nname: demo-skill\ndescription: Demo\n---\nBody\n' };
const CREATE_OK = {
  ok: true, id: 'a0000000000000aa', name: 'demo-skill', requestedName: 'demo-skill', renamed: false, replaced: false,
  target: 'user-pi', targetLabel: '~/.pi/agent/skills', scope: 'user',
  path: AGENT + '\\skills\\demo-skill\\SKILL.md', fileCount: 1, warnings: [], notice: '已创建 demo-skill。',
  restartRequired: true, undo: UNDO,
};
const IMPORT_PLAN = {
  ok: true, stageId: 'b'.repeat(24),
  plan: {
    kind: 'file', suggestedName: 'imported-skill', declaredName: 'imported-skill', description: 'Imported fixture',
    fileCount: 1, totalBytes: 90, files: [{ path: 'SKILL.md', size: 90 }], skipped: [], problems: [],
  },
};
const IMPORT_OK = {
  ok: true, id: 'a0000000000000bb', name: 'imported-skill', target: 'user-pi', targetLabel: '~/.pi/agent/skills',
  fileCount: 1, warnings: [], notice: '已导入 imported-skill。', restartRequired: false, undo: 'c'.repeat(24),
};
const EXTERNAL = {
  ok: true,
  sources: [
    { id: 'claude-user', tool: 'Claude Code', label: '~/.claude/skills', dir: 'C:/fixture/home/.claude/skills', exists: true, count: 2, truncated: false, error: '' },
    { id: 'codex-user', tool: 'Codex', label: '~/.codex/skills', dir: 'C:/fixture/home/.codex/skills', exists: false, count: 0, truncated: false, error: '' },
  ],
  candidates: [
    {
      id: 'd000000000000001', sourceId: 'claude-user', tool: 'Claude Code', sourceLabel: '~/.claude/skills',
      dirName: 'portable', dir: 'C:/fixture/home/.claude/skills/portable', name: 'portable',
      description: 'Portable Claude skill', bytes: 128, suggestedName: 'portable',
      importable: true, reason: '', problems: [], present: 'none', presentIn: [],
    },
    {
      id: 'd000000000000002', sourceId: 'claude-user', tool: 'Claude Code', sourceLabel: '~/.claude/skills',
      dirName: 'already', dir: 'C:/fixture/home/.claude/skills/already', name: 'already',
      description: 'Same content already here', bytes: 64, suggestedName: 'already',
      importable: true, reason: '', problems: [], present: 'same', presentIn: ['user-pi'],
    },
  ],
};
const EXTERNAL_OK = {
  ok: true, imported: 1, skipped: 0, failed: 0, target: 'user-pi', targetLabel: '~/.pi/agent/skills',
  restartRequired: false, undo: 'e'.repeat(24), notice: '已导入 1 个技能。',
  results: [{ id: 'd000000000000001', name: 'portable', status: 'imported', error: '' }],
};
const MARKET_SOURCES = [
  { id: 'src1', repo: 'anthropics/skills', ref: 'main', builtin: true, removable: false, loaded: true, fetchedAt: 1, resolvedRef: 'abc1234567', mode: 'pinned', count: 25, truncated: false, error: '', errorCode: '' },
  { id: 'src2', repo: 'anthropics/claude-plugins-official', ref: 'main', builtin: false, removable: true, loaded: true, fetchedAt: 1, resolvedRef: 'def1234567', mode: 'pinned', count: 1, truncated: false, error: '', errorCode: '' },
];
function marketEntry(index) {
  const category = index % 3 === 0 ? 'docs' : index % 3 === 1 ? 'writing' : 'coding';
  return {
    id: `m${String(index).padStart(15, '0')}`, sourceId: index === 25 ? 'src2' : 'src1',
    repo: index === 25 ? 'anthropics/claude-plugins-official' : 'anthropics/skills',
    dir: `skills/entry-${index}`, slug: `entry-${index}`, title: `Entry ${index}`,
    description: `Market entry ${index} description`, categories: [category], official: index <= 2,
    listed: true, fileCount: 2, bytes: 200 + index, installable: true, reason: '', homepage: '',
  };
}
const MARKET = {
  ok: true,
  sources: MARKET_SOURCES,
  entries: Array.from({ length: 25 }, (_, index) => marketEntry(index + 1)),
  categories: [{ id: 'docs', label: '文档' }, { id: 'writing', label: '写作' }, { id: 'coding', label: '编程' }],
  hosts: ['api.github.com', 'cdn.jsdelivr.net', 'data.jsdelivr.com', 'raw.githubusercontent.com'],
  persistent: true,
  limits: { maxCustomSources: 20, pageSize: 24 },
};
const PREVIEW_ID = 'f'.repeat(24);
const PREVIEW = {
  ok: true, previewId: PREVIEW_ID,
  entry: { ...marketEntry(1), description: 'Full market description' },
  name: 'entry-1', suggestedName: 'entry-1', description: 'Full market description',
  content: '# Entry 1\n\nFull skill text.',
  files: [
    { path: 'SKILL.md', size: 100, status: 'ok', note: '' },
    { path: 'notes.md', size: 20, status: 'ok', note: '' },
  ],
  skipped: [], totalBytes: 120, problems: [], partial: false, installable: true, reason: '',
  source: { repo: 'anthropics/skills', dir: 'skills/entry-1', ref: 'abc1234567', mode: 'pinned', homepage: '' },
};
const INSTALL_OK = {
  ok: true, id: 'a0000000000000cc', name: 'entry-1', target: 'user-pi', targetLabel: '~/.pi/agent/skills',
  fileCount: 2, warnings: [], notice: '已安装 entry-1。', restartRequired: false, undo: '1'.repeat(24),
  source: PREVIEW.source, partial: false,
};

/* ---------- jsdom world ---------- */
function createWorld(entry) {
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => pageErrors.push(error && error.message ? error.message : String(error)));
  virtualConsole.on('error', (...args) => pageErrors.push('console.error ' + args.map(String).join(' ')));
  const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), {
    url: 'http://localhost:7788/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  const w = dom.window;
  const d = w.document;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.EventSource = class { close() {} };

  const calls = [];
  const routes = new Map();
  const pending = new Map();
  const pathOf = (url) => String(url).split('?')[0];
  const matchRoute = (method, url) => {
    const exact = `${method} ${url}`;
    if (routes.has(exact)) return exact;
    const target = `${method} ${pathOf(url)}`;
    if (routes.has(target)) return target;
    for (const key of routes.keys()) if (key.endsWith('*') && target.startsWith(key.slice(0, -1))) return key;
    return null;
  };
  const response = (value) => {
    if (value && value.__http) return { ok: value.__http < 400, status: value.__http, json: async () => value.body };
    return { ok: true, status: 200, json: async () => value };
  };
  w.fetch = (url, options) => {
    const method = String(options?.method || 'GET').toUpperCase();
    const target = String(url);
    let body = null;
    if (typeof options?.body === 'string') { try { body = JSON.parse(options.body); } catch { body = options.body; } }
    calls.push({ method, url: target, body });
    const key = matchRoute(method, target);
    if (!key) return Promise.resolve(response({ ok: false, error: 'fixture: not routed ' + method + ' ' + pathOf(target) }));
    const route = routes.get(key);
    if (route.hold) {
      let release;
      const gate = new Promise((done) => { release = done; });
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push(release);
      return gate.then((value) => response(value));
    }
    const value = typeof route.value === 'function' ? route.value({ method, url: target, body }) : route.value;
    return Promise.resolve(response(JSON.parse(JSON.stringify(value))));
  };

  w.eval(bundle(entry).code);
  return {
    w, d, calls, pageErrors,
    $: (id) => d.getElementById(id),
    answer(key, value) { routes.set(key, { value }); },
    hold(key) { routes.set(key, { hold: true }); },
    release(key, value) {
      const queue = pending.get(key) || [];
      assert.ok(queue.length, 'no pending request for ' + key);
      queue.shift()(JSON.parse(JSON.stringify(value)));
    },
    pendingCount: (key) => (pending.get(key) || []).length,
    count(method, url) {
      const want = pathOf(url);
      return calls.filter((call) => call.method === method
        && (want.endsWith('*') ? pathOf(call.url).startsWith(want.slice(0, -1)) : pathOf(call.url) === want)).length;
    },
    lastCall(method, url) {
      const want = pathOf(url);
      return [...calls].reverse().find((call) => call.method === method
        && (want.endsWith('*') ? pathOf(call.url).startsWith(want.slice(0, -1)) : pathOf(call.url) === want));
    },
    confirmButton(label) { return [...d.querySelectorAll('#confirmCard .btn')].find((button) => button.textContent === label); },
    reset() {
      for (const queue of pending.values()) for (const release of queue.splice(0)) release({ ok: false, error: 'fixture: reset' });
      if (!d.getElementById('confirmLayer').hidden) this.confirmButton('取消')?.click();
      calls.length = 0;
    },
  };
}

const A = createWorld(path.join(SKILLS_DIR, 'page.js'));

function mount() {
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
  return { card, close() { onClose(); card.remove(); } };
}
const rowOf = (card, name) => [...card.querySelectorAll('.skill-row')]
  .find((row) => row.querySelector('.skill-name')?.textContent === name);
const modal = () => A.$('modalCard');
const modalButton = (label) => [...modal().querySelectorAll('button')].find((button) => button.textContent === label);
const cardButton = (card, label) => [...card.querySelectorAll('.btn')].find((button) => button.textContent === label);
const fieldValue = (card, aria) => card.querySelector(`[aria-label="${aria}"]`);
const change = (control) => control.dispatchEvent(new A.w.Event('input', { bubbles: true }));

(function modelChecks() {
  const M = vm.runInNewContext(bundle(path.join(SKILLS_DIR, 'model.js')).code, { window: {} });
  check('market model: filters, pagination window, installed names and page items agree with the server limits', () => {
    const entries = [{ slug: 'a', title: 'Alpha', repo: 'o/r', dir: 'skills/a', categories: ['docs'] },
      { slug: 'b', title: 'Beta', repo: 'o/r', dir: 'skills/b', categories: ['writing'] }];
    assert.deepEqual(plain(M.filterMarketEntries(entries, { query: 'beta' }).map((item) => item.slug)), ['b']);
    assert.deepEqual(plain(M.filterMarketEntries(entries, { category: 'docs' }).map((item) => item.slug)), ['a']);
    const many = Array.from({ length: 67 }, (_, index) => ({ slug: 's' + index }));
    assert.deepEqual(plain(M.marketPageWindow(1, 67)), [1, 2, '…', 67]);
    assert.deepEqual(plain(M.marketPageWindow(5, 67)), [1, '…', 4, 5, 6, '…', 67]);
    assert.equal(M.marketPageCount(0, 24), 1);
    assert.equal(M.marketPageItems(many, 3, 24).length, 19);
    assert.equal(M.marketEntryInstalled({ slug: 'alpha', title: 'Alpha' }, M.marketInstalledNames([{ name: 'Alpha' }])), true);
    assert.equal(M.marketEntryInstalled({ slug: 'beta' }, M.marketInstalledNames([{ name: 'Alpha' }])), false);
    assert.equal(M.marketSourceName({ repo: 'o/r', ref: 'main' }), 'o/r@main');
    assert.equal(M.marketCategoryLabel([{ id: 'docs', label: '文档' }], 'docs'), '文档');
    assert.equal(M.formatSkillBytes(1536), '1.5 KB');
  });
  check('market model: project options, writable targets and external badges keep uncertainty visible', () => {
    const data = {
      context: { project: 'p1' },
      projects: [{ id: 'p1', name: 'One', active: true }, { id: 'p2', name: 'Two', active: false }],
      targets: [
        { key: 'user-pi', scope: 'user', writable: true, label: 'global' },
        { key: 'project-pi', scope: 'project', writable: false, label: 'project' },
        { key: 'project-agents', scope: 'project', writable: true, label: 'project agents' },
      ],
      skills: [{ name: 'Alpha', path: 'C:/s/alpha/SKILL.md' }],
    };
    assert.equal(M.skillContextProject(data), 'p1');
    assert.deepEqual(plain(M.skillProjectOptions(data)), [
      { value: 'p1', label: 'One（当前）' }, { value: 'p2', label: 'Two' }, { value: 'none', label: '不指定项目（只看全局）' },
    ]);
    assert.deepEqual(plain(M.skillWritableTargets(data, 'project').map((item) => item.key)), ['project-agents']);
    assert.equal(M.skillDefaultTarget(data, 'project'), 'project-agents');
    assert.deepEqual([...M.marketInstalledNames(data.skills)].sort(), ['alpha']);
    assert.equal(M.externalPresentMeta('same').tone, 'neutral');
    assert.equal(M.externalPresentMeta('different').tone, 'warning');
    assert.equal(M.externalPresentMeta('future').label, '未导入');
  });
})();

(async () => {
  console.log('skills UI: create / edit / delete');

  await check('create: the editor checks without writing, then creates with the explicit project and target', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('POST /api/skills/check', CHECK_OK);
    A.answer('POST /api/skills/create', CREATE_OK);
    A.answer('POST /api/skills/undo/*', { ok: true, name: 'demo-skill', restartRequired: false, warnings: [] });
    const page = mount();
    await tick();
    cardButton(page.card, '新建').click();
    await tick();
    assert.ok(modal().classList.contains('skills-editor-dialog'));
    assert.equal(fieldValue(modal(), '技能名称').value, '');
    const name = fieldValue(modal(), '技能名称');
    name.value = 'demo-skill';
    const description = fieldValue(modal(), '描述');
    description.value = 'Demo description';
    const body = fieldValue(modal(), '正文');
    body.value = 'Body\nwith LF';
    modalButton('创建').click();
    await tick(80);
    const check = A.lastCall('POST', '/api/skills/check');
    assert.ok(check, 'a create is checked before it is written');
    assert.deepEqual(check.body, {
      kind: 'create', name: 'demo-skill', description: 'Demo description', body: 'Body\nwith LF', target: 'user-pi',
    });
    const create = A.lastCall('POST', '/api/skills/create');
    assert.ok(create);
    assert.equal(create.url, '/api/skills/create?project=' + PROJECT_ID);
    assert.deepEqual(create.body, {
      name: 'demo-skill', description: 'Demo description', body: 'Body\nwith LF', target: 'user-pi',
    });
    assert.equal(A.$('modal').hidden, true, 'the editor closes only after a successful create');
    const notice = page.card.querySelector('.skills-notice');
    assert.match(notice.textContent, /已创建 demo-skill/);
    assert.match(notice.textContent, /重启后生效/);
    assert.equal(A.count('POST', '/api/skills'), 0, 'creating never falls through to the toggle endpoint');
    const undo = [...notice.querySelectorAll('button')].find((button) => button.textContent === '撤销');
    undo.click();
    await tick();
    assert.ok(A.lastCall('POST', '/api/skills/undo/' + UNDO));
    assert.match(page.card.querySelector('.skills-notice').textContent, /已撤销：demo-skill/);
    page.close();
    A.reset();
    await tick();
  });

  await check('edit: a file changed on disk is refused, then 重新载入 picks up the new hash without closing the editor', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/a000000000000001', DETAIL);
    A.answer('GET /api/skills/a000000000000001/source', SOURCE);
    let putCount = 0;
    A.answer('PUT /api/skills/a000000000000001/source', () => {
      putCount += 1;
      if (putCount === 1) {
        return { __http: 409, body: { ok: false, code: 'changed-on-disk', error: '这个文件在你编辑期间被别的程序改过了。' } };
      }
      return { ok: true, id: 'a000000000000001', name: 'code-review', restartRequired: false, warnings: [], notice: '已保存 code-review。' };
    });
    A.answer('POST /api/skills/check', { ok: true, errors: [], warnings: [], bytes: 90, content: '' });
    const page = mount();
    await tick();
    rowOf(page.card, 'code-review').querySelector('.skill-row-main').click();
    await tick();
    cardButton(page.card.querySelector('.skill-detail'), '编辑').click();
    await tick(60);
    assert.ok(modal().classList.contains('skills-editor-dialog'));
    const description = fieldValue(modal(), '描述');
    description.value = 'Changed description';
    change(description);
    modalButton('保存').click();
    await tick(80);
    assert.ok(A.lastCall('PUT', '/api/skills/a000000000000001/source'), 'editing saves through the source endpoint, not the toggle endpoint');
    assert.deepEqual(A.lastCall('PUT', '/api/skills/a000000000000001/source').body, {
      mode: 'form', description: 'Changed description', body: 'Old body\n', baseHash: 'hash-1',
    });
    assert.equal(A.$('modal').hidden, false, 'a conflict keeps the editor open');
    assert.match(modal().textContent, /被别的程序改过/);
    const reload = modalButton('重新载入');
    assert.ok(reload, 'the conflict offers a real recovery path');
    A.answer('GET /api/skills/a000000000000001/source', { ...SOURCE, hash: 'hash-2', form: { ...SOURCE.form, description: 'New disk description' } });
    reload.click();
    await tick(60);
    assert.equal(A.count('GET', '/api/skills/a000000000000001/source'), 2);
    assert.equal(fieldValue(modal(), '描述').value, 'New disk description');
    modalButton('保存').click();
    await tick(80);
    assert.equal(putCount, 2);
    assert.equal(A.lastCall('PUT', '/api/skills/a000000000000001/source').body.baseHash, 'hash-2');
    page.close();
    A.reset();
    await tick();
  });

  await check('delete: confirmation names the skill, then the inline notice offers undo', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/a000000000000001', DETAIL);
    A.answer('DELETE /api/skills/a000000000000001', {
      ok: true, name: 'code-review', scope: 'user', restartRequired: true, undo: '2'.repeat(24), warnings: [],
    });
    A.answer('POST /api/skills/undo/*', { ok: true, name: 'code-review', restartRequired: false, warnings: [] });
    const page = mount();
    await tick();
    rowOf(page.card, 'code-review').querySelector('.skill-row-main').click();
    await tick();
    cardButton(page.card.querySelector('.skill-detail'), '删除').click();
    await tick();
    assert.match(A.$('confirmCard').textContent, /删除技能「code-review」/);
    assert.match(A.$('confirmCard').textContent, /回收站/);
    assert.match(A.$('confirmCard').textContent, /重启/);
    A.confirmButton('删除').click();
    await tick();
    const call = A.lastCall('DELETE', '/api/skills/a000000000000001');
    assert.equal(call.url, '/api/skills/a000000000000001?project=' + PROJECT_ID);
    assert.match(page.card.querySelector('.skills-notice').textContent, /已删除 code-review/);
    const undo = [...page.card.querySelectorAll('.skills-notice button')].find((button) => button.textContent === '撤销');
    undo.click();
    await tick();
    assert.ok(A.lastCall('POST', '/api/skills/undo/' + '2'.repeat(24)));
    page.close();
    A.reset();
    await tick();
  });

  console.log('skills UI: import / external scan');

  await check('import: one SKILL.md is staged, shown as a plan, then committed with the chosen name and target', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('POST /api/skills/import/stage', IMPORT_PLAN);
    A.answer('POST /api/skills/import/commit', IMPORT_OK);
    const page = mount();
    await tick();
    cardButton(page.card.querySelector('.skills-group[data-scope="user"]'), '导入文件').click();
    await tick();
    assert.ok(modal().classList.contains('skills-import-dialog'));
    const file = new A.w.File(['---\nname: imported-skill\ndescription: Imported fixture\n---\nhello'], 'SKILL.md', { type: 'text/markdown' });
    const input = modal().querySelectorAll('.skills-file-input')[0];
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new A.w.Event('change', { bubbles: true }));
    await tick(100);
    const stage = A.lastCall('POST', '/api/skills/import/stage');
    assert.ok(stage);
    assert.equal(stage.body.kind, 'file');
    assert.equal(stage.body.files.length, 1);
    assert.equal(stage.body.files[0].path, 'SKILL.md');
    assert.ok(stage.body.files[0].data.length > 0, 'the bytes travel as base64');
    assert.match(modal().textContent, /技能目录|单个文件/);
    assert.match(modal().textContent, /imported-skill/);
    assert.equal(fieldValue(modal(), '导入后的名称').value, 'imported-skill');
    modalButton('导入').click();
    await tick(60);
    const commit = A.lastCall('POST', '/api/skills/import/commit');
    assert.equal(commit.url, '/api/skills/import/commit?project=' + PROJECT_ID);
    assert.deepEqual(commit.body, { stageId: 'b'.repeat(24), target: 'user-pi', name: 'imported-skill', onConflict: 'fail' });
    assert.equal(A.$('modal').hidden, true);
    assert.match(page.card.querySelector('.skills-notice').textContent, /已导入 imported-skill/);
    page.close();
    A.reset();
    await tick();
  });

  await check('import: a conflict offers 保留两者 and re-submits the same stage with onConflict=rename', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('POST /api/skills/import/stage', IMPORT_PLAN);
    A.answer('POST /api/skills/import/commit', ({ body }) => (body.onConflict === 'rename'
      ? { ...IMPORT_OK, name: 'imported-skill-2' }
      : {
        __http: 409,
        body: {
          ok: false, code: 'exists', error: '目标目录里已经有同名技能。',
          conflict: { name: 'imported-skill', target: 'user-pi', replaceable: true, suggestion: 'imported-skill-2' },
        },
      }));
    const page = mount();
    await tick();
    cardButton(page.card.querySelector('.skills-group[data-scope="user"]'), '导入文件').click();
    await tick();
    const file = new A.w.File(['---\nname: imported-skill\n---\nhello'], 'SKILL.md');
    const input = modal().querySelectorAll('.skills-file-input')[0];
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new A.w.Event('change', { bubbles: true }));
    await tick(100);
    modalButton('导入').click();
    await tick(60);
    assert.match(modal().textContent, /已经有同名技能/);
    const keep = [...modal().querySelectorAll('button')].find((button) => button.textContent.startsWith('保留两者'));
    assert.ok(keep);
    keep.click();
    await tick(60);
    const commits = A.calls.filter((call) => call.method === 'POST' && call.url.startsWith('/api/skills/import/commit'));
    assert.equal(commits.length, 2);
    assert.equal(commits[1].body.onConflict, 'rename');
    assert.equal(commits[1].body.stageId, 'b'.repeat(24), 'the same staged bytes are reused');
    assert.equal(A.$('modal').hidden, true);
    page.close();
    A.reset();
    await tick();
  });

  await check('import: a directory without a top-level SKILL.md is rejected before any upload', async () => {
    A.answer('GET /api/skills', SKILLS);
    const page = mount();
    await tick();
    cardButton(page.card.querySelector('.skills-group[data-scope="user"]'), '导入目录').click();
    await tick();
    const input = modal().querySelectorAll('.skills-file-input')[1];
    const file = new A.w.File(['not a skill'], 'README.md');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'folder/README.md' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new A.w.Event('change', { bubbles: true }));
    await tick(60);
    assert.match(modal().textContent, /顶层没有 SKILL\.md/);
    assert.equal(A.count('POST', '/api/skills/import/stage'), 0, 'bad selection never reaches the server');
    page.close();
    A.reset();
    await tick();
  });

  await check('external scan: read-only scan, explicit selection, then import to the chosen target', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/external', EXTERNAL);
    A.answer('POST /api/skills/external/import', EXTERNAL_OK);
    const page = mount();
    await tick();
    cardButton(page.card, '从其他工具扫描').click();
    await tick();
    assert.equal(A.lastCall('GET', '/api/skills/external').url, '/api/skills/external?project=' + PROJECT_ID);
    assert.ok(modal().classList.contains('skills-external-dialog'));
    assert.match(modal().textContent, /Claude Code/);
    assert.match(modal().textContent, /已有同名（内容相同）/);
    const checkboxes = [...modal().querySelectorAll('.skills-external-row .skills-checkbox')];
    assert.equal(checkboxes.length, 2);
    checkboxes[0].click();
    await tick();
    modalButton('导入所选').click();
    await tick(60);
    const call = A.lastCall('POST', '/api/skills/external/import');
    assert.equal(call.url, '/api/skills/external/import?project=' + PROJECT_ID);
    assert.deepEqual(call.body, { ids: ['d000000000000001'], target: 'user-pi', onConflict: 'skip' });
    assert.match(modal().textContent, /已导入 1 个，跳过 0 个，失败 0 个/);
    assert.equal(modalButton('完成').textContent, '完成');
    modalButton('完成').click();
    await tick();
    assert.equal(A.$('modal').hidden, true);
    assert.match(page.card.querySelector('.skills-notice').textContent, /已导入 1 个技能/);
    page.close();
    A.reset();
    await tick();
  });

  console.log('skills UI: market');

  await check('market: opening reads only the local cache; search / category / paging never touch the network', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/market', MARKET);
    const page = mount();
    await tick();
    cardButton(page.card, '市场').click();
    await tick();
    assert.equal(A.count('GET', '/api/skills/market'), 1);
    assert.equal(A.count('POST', '/api/skills/market/refresh'), 0, 'opening the market is not a refresh gesture');
    assert.equal(page.card.querySelector('.skills-market-title').textContent, '技能市场');
    assert.deepEqual([...page.card.querySelectorAll('h2')].map((heading) => heading.textContent), ['技能市场']);
    assert.equal(page.card.querySelector('.skills-head'), null);
    assert.equal(A.d.activeElement, page.card.querySelector('.skills-market-back'));
    assert.equal(page.card.querySelectorAll('.skills-market-card').length, 24);
    assert.match(page.card.querySelector('.skills-market-pagination').textContent, /第 1 \/ 2 页/);
    const search = page.card.querySelector('.skills-market-search-input');
    search.value = 'entry-3';
    search.dispatchEvent(new A.w.Event('input', { bubbles: true }));
    assert.equal(page.card.querySelectorAll('.skills-market-card').length, 1);
    assert.equal(A.calls.length, 2, 'the only requests are the list and the local market state');
    search.value = '';
    search.dispatchEvent(new A.w.Event('input', { bubbles: true }));
    page.card.querySelector('.skills-market-filters .ds-segment-item[data-value="docs"]').click();
    assert.ok(page.card.querySelectorAll('.skills-market-card').length < 25);
    page.card.querySelector('.skills-market-filters .ds-segment-item[data-value=""]').click();
    page.card.querySelector('.skills-page-number[aria-label="第 2 页"]').click();
    assert.equal(page.card.querySelectorAll('.skills-market-card').length, 1);
    assert.equal(page.card.querySelector('.skills-market-card-title').textContent, 'Entry 25');
    assert.equal(A.calls.length, 2, 'filters and pagination stay local');
    page.card.querySelector('.skills-market-back').click();
    await tick();
    assert.ok(page.card.querySelector('.skills-toolbar'), 'back returns to the list');
    assert.deepEqual([...page.card.querySelectorAll('h2')].map((heading) => heading.textContent), ['技能']);
    assert.equal(A.d.activeElement, cardButton(page.card, '市场'));
    page.close();
    A.reset();
    await tick();
  });

  await check('market: failed cache read has one recovery action; refreshing preserves the category control and selection', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/market', { ok: false, error: 'fixture: cache unavailable' });
    const page = mount();
    await tick();
    cardButton(page.card, '市场').click();
    await tick();
    const retries = [...page.card.querySelectorAll('.skills-market .btn')].filter((b) => b.textContent === '重试');
    assert.equal(retries.length, 1);
    assert.match(page.card.querySelector('.skills-market-grid').textContent, /fixture: cache unavailable/);
    assert.equal(cardButton(page.card, '加载目录').disabled, true);
    A.answer('GET /api/skills/market', MARKET);
    retries[0].click();
    await tick();
    const filter = (value) => page.card.querySelector(`.skills-market-filters [data-value="${value}"]`);
    const docs = filter('docs');
    docs.click();
    A.answer('POST /api/skills/market/refresh', { ok: true });
    const refresh = cardButton(page.card, '刷新目录');
    refresh.click();
    assert.equal(refresh.disabled, true);
    assert.equal(refresh.getAttribute('aria-busy'), 'true');
    await tick(80);
    assert.equal(filter('docs'), docs);
    assert.equal(docs.getAttribute('aria-checked'), 'true');
    assert.equal(filter('').getAttribute('aria-checked'), 'false');
    assert.equal(page.card.querySelectorAll('.skills-market-card').length, MARKET.entries.filter((item) => item.categories.includes('docs')).length);
    assert.equal(refresh.disabled, false);
    page.close();
    A.reset();
    await tick();
  });

  await check('market: preview shows the full text and files; install uses the preview token, then marks the card installed', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/market', MARKET);
    A.answer('POST /api/skills/market/preview', PREVIEW);
    A.answer('GET /api/skills/market/preview/' + PREVIEW_ID + '/file', { ok: true, path: 'notes.md', size: 20, binary: false, text: 'Note body', truncated: false });
    A.answer('POST /api/skills/market/install', INSTALL_OK);
    const page = mount();
    await tick();
    cardButton(page.card, '市场').click();
    await tick();
    const firstCard = page.card.querySelector('.skills-market-card');
    assert.equal(cardButton(firstCard, '安装').textContent.trim(), '安装');
    cardButton(firstCard, '安装').click();
    await tick();
    const preview = A.lastCall('POST', '/api/skills/market/preview');
    assert.deepEqual(preview.body, { entryId: marketEntry(1).id });
    assert.ok(modal().classList.contains('skills-preview-dialog'));
    assert.match(modal().textContent, /Full skill text/);
    assert.equal(modal().querySelectorAll('.skills-preview-file').length, 2);
    const notes = [...modal().querySelectorAll('.skills-preview-file')].find((button) => button.textContent.includes('notes.md'));
    notes.click();
    await tick();
    assert.equal(A.lastCall('GET', '/api/skills/market/preview/' + PREVIEW_ID + '/file').url,
      '/api/skills/market/preview/' + PREVIEW_ID + '/file?path=notes.md');
    assert.match(modal().querySelector('.skills-preview-pre').textContent, /Note body/);
    const install = [...modal().querySelectorAll('.skills-preview-install button')].find((button) => button.textContent === '安装');
    install.click();
    await tick(60);
    const call = A.lastCall('POST', '/api/skills/market/install');
    assert.equal(call.url, '/api/skills/market/install?project=' + PROJECT_ID);
    assert.deepEqual(call.body, {
      previewId: PREVIEW_ID, target: 'user-pi', name: 'entry-1', onConflict: 'fail', allowPartial: false,
    });
    assert.equal(A.$('modal').hidden, true);
    assert.match(page.card.querySelector('.skills-market-banner.is-success').textContent, /已安装 entry-1/);
    const updated = page.card.querySelector('.skills-market-card');
    assert.match(updated.textContent, /已安装/);
    assert.equal(cardButton(updated, '查看').textContent.trim(), '查看');
    page.card.querySelector('.skills-market-back').click();
    await tick();
    assert.ok(A.count('GET', '/api/skills') >= 2, 'returning after an install re-reads the installed list');
    page.close();
    A.reset();
    await tick();
  });

  await check('market: install conflict offers replace / keep both and reuses the same preview', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/market', MARKET);
    A.answer('POST /api/skills/market/preview', PREVIEW);
    A.answer('POST /api/skills/market/install', ({ body }) => (body.onConflict === 'replace'
      ? { ...INSTALL_OK, notice: '已覆盖 entry-1。' }
      : {
        __http: 409,
        body: {
          ok: false, code: 'exists', error: '目标目录里已经有同名技能。',
          conflict: { name: 'entry-1', target: 'user-pi', replaceable: true, suggestion: 'entry-1-2' },
        },
      }));
    const page = mount();
    await tick();
    cardButton(page.card, '市场').click();
    await tick();
    cardButton(page.card.querySelector('.skills-market-card'), '安装').click();
    await tick();
    const install = [...modal().querySelectorAll('.skills-preview-install button')].find((button) => button.textContent === '安装');
    install.click();
    await tick(60);
    assert.match(modal().textContent, /已经有同名技能/);
    const replace = [...modal().querySelectorAll('button')].find((button) => button.textContent === '覆盖已有的');
    assert.ok(replace);
    replace.click();
    await tick(60);
    const calls = A.calls.filter((call) => call.method === 'POST' && call.url.startsWith('/api/skills/market/install'));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.previewId, PREVIEW_ID);
    assert.equal(calls[1].body.onConflict, 'replace');
    assert.equal(A.$('modal').hidden, true);
    page.close();
    A.reset();
    await tick();
  });

  await check('market: 加载目录 is the explicit networked gesture; a failed preview is recoverable', async () => {
    const unloaded = {
      ...MARKET,
      sources: MARKET_SOURCES.map((source) => ({ ...source, loaded: false, count: 0, error: '', fetchedAt: null })),
    };
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/market', unloaded);
    A.answer('POST /api/skills/market/refresh', { ok: true, refreshed: true, source: MARKET_SOURCES[0] });
    A.answer('POST /api/skills/market/preview', { __http: 502, body: { ok: false, code: 'network', error: '读不到这个技能的 SKILL.md' } });
    const page = mount();
    await tick();
    cardButton(page.card, '市场').click();
    await tick();
    assert.match(page.card.textContent, /还有 2 个目录没有加载/);
    assert.equal(A.count('POST', '/api/skills/market/refresh'), 0, 'opening does not auto-download the catalog');
    [...page.card.querySelectorAll('.skills-market-head-actions .btn')]
      .find((button) => button.textContent.includes('加载目录')).click();
    await tick(80);
    assert.equal(A.count('POST', '/api/skills/market/refresh'), 2, 'the click refreshes each source');
    cardButton(page.card.querySelector('.skills-market-card'), '安装').click();
    await tick();
    assert.match(page.card.querySelector('.skills-market-banner.is-error').textContent, /读不到这个技能的 SKILL.md/);
    const button = page.card.querySelector('.skills-market-card .btn');
    assert.equal(button.disabled, false, 'a failed preview leaves the card usable for a retry');
    page.close();
    A.reset();
    await tick();
  });

  await check('market: a preview answered after the page closes never opens a dialog', async () => {
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/market', MARKET);
    A.hold('POST /api/skills/market/preview');
    const page = mount();
    await tick();
    cardButton(page.card, '市场').click();
    await tick();
    cardButton(page.card.querySelector('.skills-market-card'), '安装').click();
    await tick();
    assert.equal(A.pendingCount('POST /api/skills/market/preview'), 1);
    page.close();
    A.release('POST /api/skills/market/preview', PREVIEW);
    await tick();
    assert.equal(A.$('modal').hidden, true, 'a late preview must not open over a closed page');
  });

  await check('market sources: add and remove go through the source endpoint with explicit actions', async () => {
    const state = {
      ...MARKET,
      sources: [...MARKET_SOURCES, { id: 'src3', repo: 'me/mine', ref: 'main', builtin: false, removable: true, loaded: false, fetchedAt: null, resolvedRef: '', mode: '', count: 0, truncated: false, error: '', errorCode: '' }],
    };
    A.answer('GET /api/skills', SKILLS);
    A.answer('GET /api/skills/market', state);
    A.answer('POST /api/skills/market/sources', ({ body }) => ({ ok: true, sources: state.sources, action: body.action }));
    const page = mount();
    await tick();
    cardButton(page.card, '市场').click();
    await tick();
    page.card.querySelector('.skills-market-head-actions .btn').click();
    await tick();
    assert.ok(modal().classList.contains('skills-market-sources-dialog'));
    assert.ok(modal().textContent.includes(MARKET.hosts.join('、')), 'the dialog renders the server whitelist in full');
    assert.doesNotMatch(modal().textContent, /data\.jsdelivr\.net/);
    assert.equal(modal().querySelectorAll('.skills-sources-row').length, 3);
    assert.equal([...modal().querySelectorAll('.skills-sources-row')][0].querySelectorAll('.btn').length, 1, 'built-in sources have no remove action');
    const add = modal().querySelector('.skills-sources-add input');
    add.value = 'owner/repo';
    modalButton('添加').click();
    await tick(80);
    assert.deepEqual(A.lastCall('POST', '/api/skills/market/sources').body, { action: 'add', repo: 'owner/repo' });
    assert.equal(modal().querySelector('.skills-sources-add input').value, '');
    const remove = [...modal().querySelectorAll('.skills-sources-row')][2].querySelector('.btn.danger');
    remove.click();
    await tick();
    assert.match(A.$('confirmCard').textContent, /移除这个目录源/);
    A.confirmButton('移除').click();
    await tick(80);
    assert.deepEqual(A.lastCall('POST', '/api/skills/market/sources').body, { action: 'remove', id: 'src3' });
    page.close();
    A.reset();
    await tick();
  });

  const projectB = 'c000000000000098';
  const projectAList = { ...SKILLS, projects: [...SKILLS.projects, { id: projectB, name: 'Project B' }] };
  const projectBList = {
    ...projectAList, context: { project: projectB, live: false }, skills: [skill({ id: 'b001', name: 'only-b', scope: 'project' })],
  };
  const listFor = (project) => 'GET /api/skills?project=' + project;
  function switchView(page, project) {
    const select = fieldValue(page.card, '查看哪个项目的技能');
    select.value = project;
    select.dispatchEvent(new A.w.Event('change', { bubbles: true }));
  }
  async function projectPage() {
    A.answer('GET /api/skills', projectAList);
    A.answer(listFor(PROJECT_ID), projectAList);
    A.answer(listFor(projectB), projectBList);
    A.answer('GET /api/skills/a000000000000001', DETAIL);
    A.answer('GET /api/skills/a000000000000001/source', SOURCE);
    A.answer('POST /api/skills/check', CHECK_OK);
    A.answer('POST /api/skills/import/stage', IMPORT_PLAN);
    A.answer('GET /api/skills/external', EXTERNAL);
    A.answer('GET /api/skills/market', MARKET);
    A.answer('POST /api/skills/market/preview', PREVIEW);
    const page = mount();
    await tick();
    return page;
  }
  async function openDetail(page) {
    rowOf(page.card, 'code-review').querySelector('.skill-row-main').click();
    await tick();
  }
  function closeProjectPage(page) {
    page.close();
    A.reset();
  }

  for (const action of ['删除', '停用']) {
    await check(`project switch while confirming ${action} cancels the old action`, async () => {
      const page = await projectPage();
      try {
        if (action === '删除') {
          await openDetail(page);
          cardButton(page.card.querySelector('.skill-detail'), action).click();
        } else {
          rowOf(page.card, 'code-review').querySelector('.skill-toggle').click();
        }
        assert.ok(A.confirmButton(action));
        switchView(page, projectB);
        await tick();
        A.confirmButton(action)?.click();
        await tick();
        assert.equal(A.$('confirmLayer').hidden, true);
        assert.equal(A.count(action === '删除' ? 'DELETE' : 'PUT', '/api/skills/a000000000000001'), 0);
        assert.ok(rowOf(page.card, 'only-b'));
      } finally {
        closeProjectPage(page);
      }
    });
  }

  const inFlight = [
    ['create', 'POST /api/skills/create', CREATE_OK, async (page) => {
      cardButton(page.card, '新建').click();
      fieldValue(modal(), '技能名称').value = 'demo-skill';
      fieldValue(modal(), '描述').value = 'Demo';
      modalButton('创建').click();
    }],
    ['edit', 'PUT /api/skills/a000000000000001/source', { ok: true, changed: true }, async (page) => {
      await openDetail(page);
      cardButton(page.card.querySelector('.skill-detail'), '编辑').click();
      await tick();
      fieldValue(modal(), '描述').value = 'Updated description';
      modalButton('保存').click();
    }],
    ['delete', 'DELETE /api/skills/a000000000000001', { ok: true, name: 'code-review' }, async (page) => {
      await openDetail(page);
      cardButton(page.card.querySelector('.skill-detail'), '删除').click();
      A.confirmButton('删除').click();
    }],
    ['toggle', 'PUT /api/skills/a000000000000001', { ok: true }, async (page) => {
      rowOf(page.card, 'code-review').querySelector('.skill-toggle').click();
      A.confirmButton('停用').click();
    }],
    ['import', 'POST /api/skills/import/commit', IMPORT_OK, async (page) => {
      cardButton(page.card.querySelector('.skills-group[data-scope="user"]'), '导入文件').click();
      const input = modal().querySelector('.skills-file-input');
      const file = new A.w.File(['fixture'], 'SKILL.md');
      Object.defineProperty(input, 'files', { value: [file] });
      input.dispatchEvent(new A.w.Event('change', { bubbles: true }));
      await tick(100);
      modalButton('导入').click();
    }],
    ['scan', 'GET /api/skills/external', EXTERNAL, async (page) => cardButton(page.card, '从其他工具扫描').click()],
    ['scan import', 'POST /api/skills/external/import', EXTERNAL_OK, async (page) => {
      cardButton(page.card, '从其他工具扫描').click();
      await tick();
      modal().querySelector('.skills-external-row .skills-checkbox').click();
      modalButton('导入所选').click();
    }],
    ['market install', 'POST /api/skills/market/install', INSTALL_OK, async (page) => {
      cardButton(page.card, '市场').click();
      await tick();
      cardButton(page.card.querySelector('.skills-market-card'), '安装').click();
      await tick();
      cardButton(modal().querySelector('.skills-preview-install'), '安装').click();
    }],
  ];
  for (const [label, route, result, launch] of inFlight) {
    for (const [order, responseFirst, reply] of [
      ['old success before B', true, result],
      ['old success after return to A', false, result],
      ['old error after return to A', false, { ok: false, error: 'late A error' }],
    ]) {
      await check(`project switch isolates ${label} (${order})`, async () => {
        const page = await projectPage();
        const request = route + '?project=' + PROJECT_ID;
        A.hold(request);
        try {
          await launch(page);
          await tick(80);
          assert.equal(A.pendingCount(request), 1, 'the pending request is bound to A');
          A.hold(listFor(projectB));
          if (label === 'market install') page.card.querySelector('.skills-market-back').click();
          switchView(page, projectB);
          if (!responseFirst) {
            A.release(listFor(projectB), projectBList);
            await tick();
            assert.ok(rowOf(page.card, 'only-b'));
            switchView(page, PROJECT_ID);
            await tick();
            assert.ok(rowOf(page.card, 'proj-lint'));
          }
          const reads = A.count('GET', '/api/skills');
          A.release(request, reply);
          await tick();
          assert.equal(A.count('GET', '/api/skills'), reads, 'old completion must not trigger a list reload');
          assert.equal(page.card.querySelector('.skills-notice'), null);
          assert.equal(A.$('modal').hidden, true);
          if (responseFirst) {
            A.release(listFor(projectB), projectBList);
            await tick();
            assert.ok(rowOf(page.card, 'only-b'));
          } else {
            assert.ok(rowOf(page.card, 'proj-lint'));
          }
        } finally {
          A.answer(request, result);
          closeProjectPage(page);
        }
      });
    }
  }

  await check('no uncaught errors or console errors in the skills UI world', async () => {
    assert.deepEqual(A.pageErrors, []);
  });

  console.log('\nskills UI: ' + passed + '/' + (passed + failed) + ' passed');
  if (failed) process.exitCode = 1;
})();
