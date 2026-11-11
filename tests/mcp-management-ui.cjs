/* MCP 管理页 / 市场页的装配级 UI 契约。
 *
 * jsdom + 真实 bundler 产物，stub 掉 HTTP 边界：
 * 只验证「按钮真的发请求」「请求体不含明文凭据 / 客户端命令」「状态不混用」。
 * 不跑真 pi、不联网、不写真实 mcp.json。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');

let passed = 0;
let failed = 0;
async function check(name, run) {
  try {
    await run();
    passed++;
    console.log(' ok  ' + name);
  } catch (e) {
    failed++;
    console.error(' FAIL ' + name + ': ' + e.message);
  }
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pub = path.resolve(__dirname, '../public');
  const dom = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), {
    url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const d = w.document;
  const $ = (id) => d.getElementById(id);
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.EventSource = class { constructor() { w.fixtureEvents = this; } close() {} };

  const summary = {
    ok: true, fresh: true, at: new Date().toISOString(),
    native: { state: 'active', reason: '内置 MCP 生效中' },
    trust: { trusted: true, requiresTrust: false },
    servers: [
      { name: 'memory', scope: 'user', enabled: true, exposure: 'deferred', description: '长期记忆', transportType: 'stdio', argsCount: 2, hasSecrets: true, toolExposure: null, effective: { active: true, reason: '' } },
      { name: 'remote', scope: 'user', enabled: true, exposure: 'deferred', description: '远端服务', transportType: 'http', argsCount: 0, hasSecrets: true, toolExposure: null, effective: { active: true, reason: '' } },
      { name: 'proj', scope: 'project', enabled: true, exposure: 'deferred', description: '项目工具', transportType: 'stdio', argsCount: 1, hasSecrets: false, toolExposure: null, effective: { active: true, reason: '' } },
    ],
    configInvalid: [], configError: { user: '', project: '' },
    files: { user: { exists: true, path: '~/.pi/agent/mcp.json' }, project: { exists: true, path: 'C:/workspace/.pi/mcp.json' } },
    runtime: {
      ok: true, at: new Date().toISOString(), servers: [
        { name: 'memory', scope: 'user', state: 'connected', toolCount: 3, tools: [], resources: 0, resourceTemplates: 0, error: '' },
        { name: 'remote', scope: 'user', state: 'needs-auth', toolCount: 0, tools: [], resources: 0, resourceTemplates: 0, error: '' },
      ],
    },
  };
  const calls = [];
  let forceArgsProtected = false;
  let testResponse = null;
  const postBodies = (target) => calls.filter((c) => c.target === target && c.method === 'POST').map((c) => c.body);
  let customSources = [];
  let marketInstalls = [];

  const builtinItems = [
    { id: 'builtin:filesystem', source: 'builtin', sourceLabel: '内置精选', catalogId: 'filesystem', name: 'Filesystem', installName: 'filesystem', identifier: 'modelcontextprotocol/server-filesystem', version: '', category: '开发工具', trust: 'official', trustEvidence: 'Anthropic 官方仓库', description: '在明确授权的目录内读写文件。', transport: 'stdio', commandSummary: 'npx -y @modelcontextprotocol/server-filesystem <允许访问的目录>', commandTemplate: 'npx -y @modelcontextprotocol/server-filesystem {path}', urlPreview: '', homepage: 'https://github.com/modelcontextprotocol/servers', requires: ['node', 'npx'], fields: [{ key: 'path', label: '允许访问的目录', type: 'path', required: true, placeholder: 'C:/workspace' }], envFields: [{ key: 'env.FS_TOKEN', label: '访问令牌（环境变量名）', secret: true, required: false, help: '可选。' }], headerFields: [], warning: '只授予必要目录。', installable: true, installReason: '' },
    { id: 'builtin:memory', source: 'builtin', sourceLabel: '内置精选', catalogId: 'memory', name: 'Memory', installName: 'memory', identifier: 'modelcontextprotocol/server-memory', version: '', category: '效率', trust: 'official', trustEvidence: 'Anthropic 官方仓库', description: '长期记忆。', transport: 'stdio', commandSummary: 'npx -y @modelcontextprotocol/server-memory', urlPreview: '', homepage: '', requires: ['node', 'npx'], fields: [], envFields: [], headerFields: [], warning: '', installable: true, installReason: '' },
    { id: 'builtin:playwright', source: 'builtin', sourceLabel: '内置精选', catalogId: 'playwright', name: 'Playwright', installName: 'playwright', identifier: 'microsoft/playwright-mcp', version: '', category: '开发工具', trust: 'official', trustEvidence: 'Microsoft 官方仓库', description: '浏览器自动化。', transport: 'stdio', commandSummary: 'npx -y @playwright/mcp', urlPreview: '', homepage: '', requires: ['node', 'npx'], fields: [], envFields: [], headerFields: [], warning: '', installable: true, installReason: '' },
  ];
  const marketPayload = (target) => {
    const u = new URL(target, 'http://fixture');
    const source = u.searchParams.get('source') || 'builtin';
    const q = (u.searchParams.get('q') || '').toLowerCase();
    const category = u.searchParams.get('category') || '全部';
    const cursor = u.searchParams.get('cursor') || '';
    const offset = Number(u.searchParams.get('offset') || 0);
    if (source === 'registry') {
      const first = { ...builtinItems[1], id: 'registry:io.example/memory', source: 'registry', sourceLabel: '官方 Registry', trust: 'unverified', trustEvidence: '' };
      const second = { ...builtinItems[0], id: 'registry:io.example/filesystem', source: 'registry', sourceLabel: '官方 Registry', trust: 'unverified', trustEvidence: '' };
      return {
        ok: true, source, total: 2, hasMore: !cursor, nextCursor: cursor ? null : 'reg-next',
        categories: ['全部', '开发工具'], sources: { ok: true, builtin: { count: 10 }, registry: {}, custom: customSources },
        items: cursor ? [second] : [first],
      };
    }
    if (source.startsWith('custom:')) {
      return {
        ok: true, source, total: 1, hasMore: false, nextCursor: null,
        categories: ['全部'], sources: { ok: true, builtin: { count: 10 }, registry: {}, custom: customSources },
        items: [{ ...builtinItems[2], id: `${source}:fixture`, source, sourceLabel: 'Fixture Market', catalogId: 'fixture', name: 'Fixture Server', installName: 'fixture-server', trust: 'third-party', trustEvidence: '来源自述' }],
      };
    }
    const filtered = builtinItems.filter((i) => (!q || i.name.toLowerCase().includes(q) || i.description.includes(q))
      && (category === '全部' || i.category === category));
    const page = offset ? filtered.slice(offset) : filtered.slice(0, 2);
    const hasMore = filtered.length > offset + page.length;
    return {
      ok: true, source: 'builtin', total: filtered.length, hasMore, nextCursor: null,
      categories: ['全部', '开发工具', '效率'], sources: { ok: true, builtin: { count: 10 }, registry: {}, custom: customSources },
      items: page,
    };
  };

  w.fetch = async (url, opts = {}) => {
    const target = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    let body = null;
    if (typeof opts.body === 'string') {
      try { body = JSON.parse(opts.body); } catch { body = null; }
    }
    calls.push({ target, method, body });
    const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
    const pathOnly = target.split('?')[0];

    if (target === '/api/status') return ok({ ok: true, cwd: 'C:\\workspace', hasProject: true });
    if (target === '/api/projects') return ok({ ok: true, active: 'C:\\workspace', items: [{ name: 'Workspace', path: 'C:\\workspace' }] });
    if (target === '/api/mcp/servers' && method === 'GET') return ok(summary);
    if (target === '/api/mcp/servers' && method === 'POST') return ok({ ok: true, action: body?.action, name: body?.name });
    if (pathOnly === '/api/mcp/config' && method === 'POST') {
      const action = body?.action;
      if (action === 'save') return ok({ ok: true, scope: body.scope, name: body.name, revision: 'rev-next', revisions: { user: 'rev-next', project: 'rev-project' }, backup: null });
      if (action === 'test') return ok(testResponse || { ok: true, connected: true, loaded: null, server: { name: body.name, tools: 3 }, code: '', revisions: { user: 'rev-user', project: 'rev-project' } });
      if (action === 'set-enabled') {
        const server = summary.servers.find((s) => s.name === body.name);
        if (server) server.enabled = body.enabled;
        return ok({ ok: true, revisions: { user: 'rev-user', project: 'rev-project' } });
      }
      if (action === 'delete') {
        summary.servers = summary.servers.filter((s) => s.name !== body.name);
        return ok({ ok: true, revisions: { user: 'rev-user', project: 'rev-project' }, backup: null });
      }
      return ok({ ok: false, code: 'bad-action', error: '未知动作' });
    }
    if (target === '/api/mcp/config' && method === 'GET') return ok({ ok: true, revisions: { user: 'rev-user', project: 'rev-project' }, limits: {} });
    if (pathOnly === '/api/mcp/config' && method === 'GET') {
      const u = new URL(target, 'http://fixture');
      const name = u.searchParams.get('name');
      if (name === 'remote') {
        return ok({
          ok: true, scope: 'user', name: 'remote', revision: 'rev-user', trust: null, overrideOnly: false,
          entry: {
            type: 'http', command: null, args: [], url: 'https://example.com/mcp',
            env: [], headers: [{ key: 'Authorization', value: null, reference: false, secret: true }],
            description: '远端服务', timeout: null, exposure: 'deferred', enabled: true, oauth: true, auth: false,
          },
        });
      }
      return ok({
        ok: true, scope: 'user', name: 'memory', revision: 'rev-user', trust: null, overrideOnly: false,
        entry: {
          type: 'stdio', command: 'npx', url: null,
          ...(forceArgsProtected
            ? { args: [], argsProtected: true, argsCount: 2 }
            : { args: ['-y', '@modelcontextprotocol/server-memory'] }),
          env: [
            { key: 'MEMORY_FILE_PATH', value: 'C:/data/memory.json', reference: false, secret: false },
            { key: 'API_TOKEN', value: null, reference: false, secret: true },
          ],
          headers: [], description: '长期记忆', timeout: null, exposure: 'deferred', enabled: true,
        },
      });
    }
    if (pathOnly === '/api/mcp/market/sources') {
      return ok({ ok: true, builtin: { count: 10 }, registry: {}, custom: customSources, categories: ['全部', '开发工具', '效率'] });
    }
    if (pathOnly === '/api/mcp/market' && method === 'GET') return ok(marketPayload(target));
    if (pathOnly === '/api/mcp/market' && method === 'POST') {
      if (body?.action === 'install') {
        marketInstalls.push(body);
        return ok({
          ok: true, configured: true, connected: null, loaded: null, name: body.name, scope: body.scope,
          commandPreview: body.catalogId === 'filesystem' ? 'npx -y @modelcontextprotocol/server-filesystem C:/workspace' : '',
          dependencyProbe: [{ name: 'node', found: true }, { name: 'npx', found: true }], message: '配置已保存。',
        });
      }
      if (body?.action === 'add-source') {
        const source = { id: 'custom-1', name: 'Fixture Market', url: body.url };
        customSources = [source];
        return ok({ ok: true, source, count: 1 });
      }
      if (body?.action === 'remove-source') {
        customSources = customSources.filter((s) => s.id !== body.id);
        return ok({ ok: true });
      }
      return ok({ ok: false, code: 'bad-action', error: '未知动作' });
    }
    if (pathOnly === '/api/mcp/import' && method === 'GET') {
      return ok({
        ok: true,
        tools: [{ id: 'claude-desktop', name: 'Claude Desktop', path: '~/AppData/Claude/claude_desktop_config.json', detected: true, readable: true, count: 2, error: '' }],
        entries: [
          { id: 'claude-desktop:memory', source: 'claude-desktop', sourceLabel: 'Claude Desktop', name: 'memory', transport: 'stdio', commandSummary: 'npx -y @modelcontextprotocol/server-memory', urlPreview: '', argsCount: 2, envKeys: ['MEMORY_TOKEN'], headerKeys: [], status: 'importable', reason: '', code: '', conflicts: [{ kind: 'existing', scope: 'user', diff: [{ field: 'args', from: 1, to: 2 }, { field: 'env', added: ['MEMORY_TOKEN'], removed: [] }, { field: 'auth', from: '现有 OAuth / auth 配置', to: '会被移除', warn: true }] }] },
          { id: 'claude-desktop:leaky', source: 'claude-desktop', sourceLabel: 'Claude Desktop', name: 'leaky', transport: 'stdio', commandSummary: 'npx -y leaky', urlPreview: '', argsCount: 0, envKeys: ['API_KEY'], headerKeys: [], status: 'blocked', reason: '包含明文凭据', code: 'plaintext-secret', conflicts: [] },
        ],
        detected: 1, importable: 1, blocked: 1, trust: { trusted: true },
      });
    }
    if (pathOnly === '/api/mcp/import' && method === 'POST') {
      if (!body?.allowReplace) return ok({ ok: false, code: 'name-conflict', error: '“memory” 已经存在' });
      return ok({ ok: true, imported: [{ name: 'memory', scope: body.scope }], backup: null, revision: 'rev-next' });
    }
    if (target === '/api/sessions') return ok({ ok: true, sessions: [] });
    if (target === '/api/git/status') return ok({ ok: true, isRepo: true, files: [] });
    return ok({ ok: true, providers: [], counts: {}, plans: [], agents: [], models: [], sessions: [] });
  };
  w.piGuiDesktop = { browser: { open: async () => ({ ok: true }), close() {}, back() {}, forward() {}, stop() {}, reload() {}, openExternal() {}, setBounds() {}, setOccluded() {}, onState: () => () => {}, onNotice: () => () => {} } };
  w.eval(bundle(path.join(pub, 'app.js')).code);
  await tick(80);
  w.S.hasProject = true; w.S.bridgeState = 'ready'; w.S.restoring = false; w.applyProjectState();

  const page = () => d.querySelector('.mcp-page');
  const cards = () => [...d.querySelectorAll('.mcp-server')];
  const clickText = (root, selector, text) => {
    const btn = [...root.querySelectorAll(selector)].find((b) => b.textContent.trim() === text);
    assert.ok(btn, `找不到按钮 ${text}`);
    btn.click();
    return btn;
  };
  const confirmYes = (text) => {
    const btn = [...$('confirmCard').querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    assert.ok(btn, `确认框里找不到 ${text}`);
    btn.click();
  };

  $('navMcp').click();
  await tick(160);

  await check('管理页打开真实 MCP 页面而不是旧扩展标签', () => {
    assert.equal($('workspace').dataset.workspaceView, 'settings');
    assert.equal($('workViewTitle').textContent, 'MCP 服务器');
    assert.ok(page());
    assert.equal(d.querySelector('.ext-tab[aria-selected="true"]'), null);
  });

  await check('全局 / 项目分组、路径、状态与操作都来自真实摘要', () => {
    assert.equal(cards().length, 3);
    assert.ok(page().textContent.includes('~/.pi/agent/mcp.json'));
    assert.ok(page().textContent.includes('C:/workspace/.pi/mcp.json'));
    const status = (name) => d.querySelector(`.mcp-server[data-name="${name}"] .mcp-status-pill`).textContent.trim();
    assert.equal(status('memory'), '已连接');
    assert.equal(status('remote'), '需要授权');
    assert.equal(status('proj'), '未加载');
    assert.ok(d.querySelector('[data-focus-key="test:user:memory"]'));
    assert.ok(d.querySelector('[data-focus-key="edit:user:memory"]'));
    assert.ok(d.querySelector('[data-focus-key="delete:user:memory"]'));
    assert.ok(d.querySelector('[data-focus-key="auth:user:remote"]'));
  });

  await check('筛选计数、项目筛选与搜索保持一致', async () => {
    const counts = [...d.querySelectorAll('.mcp-filter-count')].map((n) => n.textContent);
    assert.deepEqual(counts, ['3', '2', '1']);
    d.querySelector('[data-focus-key="filter:user"]').click();
    await tick(20);
    assert.equal(cards().length, 2);
    d.querySelector('[data-focus-key="filter:project"]').click();
    await tick(20);
    assert.deepEqual(cards().map((c) => c.dataset.name), ['proj']);
    d.querySelector('[data-focus-key="filter:all"]').click();
    await tick(20);

    const input = d.querySelector('#mcpServerSearch');
    input.focus();
    input.value = 'remote';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick(20);
    assert.deepEqual(cards().map((c) => c.dataset.name), ['remote']);
    assert.equal(d.activeElement?.id, 'mcpServerSearch', '搜索后焦点必须留在输入框');
    assert.equal(d.activeElement.value, 'remote');

    d.querySelector('#mcpServerSearch').value = '';
    d.querySelector('#mcpServerSearch').dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick(20);
    assert.equal(cards().length, 3);
  });

  await check('新增表单拒绝空名称与明文凭据，不产生写请求', async () => {
    const before = postBodies('/api/mcp/config').length;
    const add = [...page().querySelectorAll('button')].find((b) => b.textContent.trim() === '新增');
    add.focus();
    add.click();
    await tick(20);
    let form = d.querySelector('.mcp-form-modal');
    assert.ok(form);
    form.querySelector('[data-field="save"]').click();
    await tick(20);
    assert.ok(form.textContent.includes('名称只能包含字母、数字、下划线和连字符'));

    clickText(form, 'button', 'HTTP 端点');
    await tick(20);
    form = d.querySelector('.mcp-form-modal');
    const name = form.querySelector('[data-field="name"]');
    name.value = 'leaky';
    name.dispatchEvent(new w.Event('input', { bubbles: true }));
    const url = form.querySelector('[data-field="url"]');
    url.value = 'https://example.com/mcp';
    url.dispatchEvent(new w.Event('input', { bubbles: true }));
    form.querySelector('[data-field="add-header"]').click();
    await tick(20);
    form = d.querySelector('.mcp-form-modal');
    const key = form.querySelector('[data-field="header-key-0"]');
    key.value = 'Authorization';
    key.dispatchEvent(new w.Event('input', { bubbles: true }));
    const value = form.querySelector('[data-field="header-value-0"]');
    value.value = 'Bearer sk-live-abcdef';
    value.dispatchEvent(new w.Event('input', { bubbles: true }));
    form.querySelector('[data-field="save"]').click();
    await tick(30);
    const after = d.querySelector('.mcp-form-modal');
    assert.ok(after.textContent.includes('看起来包含凭据'));
    assert.equal(postBodies('/api/mcp/config').length, before, '非法表单不能发写请求');
    clickText(after, 'button', '取消');
    await tick(30);
  });

  await check('stdio 新增发送结构化配置与 revision 守卫', async () => {
    const add = [...page().querySelectorAll('button')].find((b) => b.textContent.trim() === '新增');
    add.click();
    await tick(20);
    const form = d.querySelector('.mcp-form-modal');
    const set = (field, value) => {
      const el = form.querySelector(`[data-field="${field}"]`);
      assert.ok(el, field);
      el.value = value;
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
    };
    set('name', 'demo');
    set('description', 'Demo server');
    const exposure = form.querySelector('[data-field="exposure"]');
    assert.ok(exposure, '新增表单必须有 exposure 选择');
    assert.deepEqual([...exposure.options].map((o) => o.value), ['', 'codemode', 'deferred', 'direct', 'hidden']);
    assert.equal(exposure.value, 'codemode', '新条目默认 codemode');
    exposure.value = 'hidden';
    exposure.dispatchEvent(new w.Event('change', { bubbles: true }));
    form.querySelector('[data-field="add-arg"]').click();
    await tick(15);
    d.querySelector('.mcp-form-modal [data-field="args-0"]').value = '-y';
    d.querySelector('.mcp-form-modal [data-field="args-0"]').dispatchEvent(new w.Event('input', { bubbles: true }));
    d.querySelector('.mcp-form-modal [data-field="add-env"]').click();
    await tick(15);
    const f2 = d.querySelector('.mcp-form-modal');
    f2.querySelector('[data-field="env-key-0"]').value = 'DEMO_PATH';
    f2.querySelector('[data-field="env-key-0"]').dispatchEvent(new w.Event('input', { bubbles: true }));
    f2.querySelector('[data-field="env-value-0"]').value = 'C:/demo';
    f2.querySelector('[data-field="env-value-0"]').dispatchEvent(new w.Event('input', { bubbles: true }));
    f2.querySelector('[data-field="save"]').click();
    await tick(100);
    const posts = postBodies('/api/mcp/config').filter((b) => b.action === 'save');
    assert.equal(posts.length, 1, JSON.stringify(posts));
    const body = posts[0];
    assert.equal(body.scope, 'user');
    assert.equal(body.name, 'demo');
    assert.equal(body.transport, 'stdio');
    assert.equal(body.command, 'npx');
    assert.deepEqual(body.args, ['-y']);
    assert.deepEqual(body.env, [{ key: 'DEMO_PATH', value: 'C:/demo' }]);
    assert.equal(body.exposure, 'hidden');
    assert.equal(body.expectedRevision, 'rev-user');
    assert.equal(body.__expectedCwd, 'C:\\workspace');
    assert.equal(d.querySelector('.mcp-form-modal'), null);
    assert.ok(page().textContent.includes('配置已保存到'));
  });

  await check('新增弹窗：头部/正文/底部三段，正文独立滚动，窄窗口不溢出', async () => {
    const add = [...page().querySelectorAll('button')].find((b) => b.textContent.trim() === '新增');
    add.click();
    await tick(30);
    const form = d.querySelector('.mcp-form-modal');
    assert.ok(form.querySelector('.mcp-modal-head'));
    const body = form.querySelector('.mcp-modal-body');
    assert.ok(body, '正文必须是独立的滚动容器');
    const foot = form.querySelector('.mcp-modal-foot');
    assert.ok(foot, '保存 / 取消按钮在固定底部');
    assert.ok(foot.querySelector('[data-field="save"]'));
    assert.ok(body.contains(form.querySelector('[data-field="name"]')));
    assert.equal(foot.contains(form.querySelector('[data-field="name"]')), false);
    const css = fs.readFileSync(path.join(pub, 'mcp.css'), 'utf8');
    const bodyRule = css.match(/\.mcp-modal-body\s*\{[^}]*\}/);
    assert.ok(bodyRule && /overflow:\s*auto/.test(bodyRule[0]), '正文需要 overflow:auto');
    assert.ok(/\.modal-card\.mcp-form-modal[\s\S]*?max-height:\s*min\(88vh,\s*900px\)/.test(css));
    assert.ok(/width:\s*min\(640px,\s*calc\(100vw - 40px\)\)/.test(css), '窄窗口要按视口收缩');
    form.querySelector('.mcp-modal-head button')?.click();
    await tick(30);
    assert.equal(d.querySelector('.mcp-form-modal'), null);
  });

  await check('编辑回填非敏感值，敏感值只以 keep 回传', async () => {
    d.querySelector('[data-focus-key="edit:user:memory"]').click();
    await tick(80);
    const form = d.querySelector('.mcp-form-modal');
    assert.ok(form, '编辑表单应已打开');
    assert.equal(form.querySelector('[data-field="name"]').value, 'memory');
    assert.equal(form.querySelector('[data-field="description"]').value, '长期记忆');
    assert.equal(form.querySelector('[data-field="args-1"]').value, '@modelcontextprotocol/server-memory');
    assert.equal(form.querySelector('[data-field="env-key-0"]').value, 'MEMORY_FILE_PATH');
    assert.equal(form.querySelector('[data-field="env-value-0"]').value, 'C:/data/memory.json');
    assert.equal(form.querySelector('[data-field="env-key-1"]').value, 'API_TOKEN');
    assert.equal(form.querySelector('[data-field="env-value-1"]').value, '');
    assert.ok(form.querySelector('[data-field="env-value-1"]').placeholder.includes('已设置'));
    assert.equal(form.querySelector('[data-field="exposure"]').value, 'deferred', '编辑时必须回填原 exposure');
    const desc = form.querySelector('[data-field="description"]');
    desc.value = '更新后的记忆';
    desc.dispatchEvent(new w.Event('input', { bubbles: true }));
    form.querySelector('[data-field="save"]').click();
    await tick(100);
    const body = postBodies('/api/mcp/config').filter((b) => b.action === 'save').at(-1);
    assert.equal(body.originalName, 'memory');
    assert.equal(body.description, '更新后的记忆');
    assert.equal(body.exposure, 'deferred', '普通编辑不能把未改动的 exposure 冲掉');
    assert.deepEqual(body.env, [
      { key: 'MEMORY_FILE_PATH', value: 'C:/data/memory.json' },
      { key: 'API_TOKEN', keep: true },
    ]);
    assert.equal(body.expectedRevision, 'rev-user');
  });

  await check('含凭据的 args 不回填，保存时省略以免改写原值', async () => {
    forceArgsProtected = true;
    d.querySelector('[data-focus-key="edit:user:memory"]').click();
    await tick(80);
    const form = d.querySelector('.mcp-form-modal');
    assert.ok(form, '编辑表单应已打开');
    assert.equal(form.querySelector('[data-field="args-0"]'), null, '不应回填任何参数');
    assert.ok(form.textContent.includes('原有参数含疑似敏感值'));
    assert.ok(form.textContent.includes('清空并重写参数'));
    const desc = form.querySelector('[data-field="description"]');
    desc.value = '保持参数不变';
    desc.dispatchEvent(new w.Event('input', { bubbles: true }));
    form.querySelector('[data-field="save"]').click();
    await tick(100);
    const body = postBodies('/api/mcp/config').filter((b) => b.action === 'save').at(-1);
    assert.equal(body.description, '保持参数不变');
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'args'), false, '受保护时不应把空参数写回');
    forceArgsProtected = false;
  });

  await check('测试连接真的调用 test 动作并区分“已连接”', async () => {
    const before = postBodies('/api/mcp/config').filter((b) => b.action === 'test').length;
    d.querySelector('[data-focus-key="test:user:memory"]').click();
    await tick(100);
    const after = postBodies('/api/mcp/config').filter((b) => b.action === 'test');
    assert.equal(after.length, before + 1);
    assert.equal(after.at(-1).name, 'memory');
    assert.equal(after.at(-1).scope, 'user');
    assert.ok(page().textContent.includes('连接来自独立的 pi mcp list'));
  });

  await check('测试连接无法查询时显示未知，不冒充“未连接”', async () => {
    testResponse = { ok: false, code: 'list-timeout', error: 'pi mcp list 超时', connected: null, loaded: null };
    d.querySelector('[data-focus-key="test:user:memory"]').click();
    await tick(100);
    assert.ok(page().textContent.includes('连接状态未知'), page().textContent.slice(0, 200));
    assert.ok(!page().textContent.includes('未连接：'), '未知不能显示成连接失败');
    testResponse = null;
  });

  await check('启停写入 set-enabled 并提示需要重载', async () => {
    d.querySelector('[data-focus-key="toggle:user:memory"]').click();
    await tick(100);
    const body = postBodies('/api/mcp/config').filter((b) => b.action === 'set-enabled').at(-1);
    assert.equal(body.name, 'memory');
    assert.equal(body.enabled, false);
    assert.equal(body.expectedRevision, 'rev-user');
    assert.ok(page().textContent.includes('/reload'));
  });

  await check('详情不显示明文凭据，OAuth 登录走 Pi 原生动作', async () => {
    d.querySelector('[data-focus-key="detail:user:remote"]').click();
    await tick(100);
    const modal = d.querySelector('.mcp-detail-modal');
    assert.ok(modal);
    assert.ok(modal.textContent.includes('已设置（值不显示）'));
    assert.ok(!modal.textContent.includes('Bearer literal'));
    clickText(modal.querySelector('.mcp-modal-foot-actions'), 'button', '关闭');
    await tick(30);

    d.querySelector('[data-focus-key="auth:user:remote"]').click();
    await tick(40);
    assert.ok($('confirmCard').textContent.includes('通过 Pi 登录'));
    confirmYes('登录');
    await tick(100);
    const body = postBodies('/api/mcp/servers').at(-1);
    assert.equal(body.action, 'login');
    assert.equal(body.name, 'remote');
  });

  await check('外部扫描只读展示，冲突需要显式覆盖后才导入', async () => {
    clickText(page(), 'button', '从其他工具扫描');
    await tick(100);
    const modal = d.querySelector('.mcp-scan-modal');
    assert.ok(modal);
    assert.ok(modal.textContent.includes('Claude Desktop'));
    assert.ok(modal.textContent.includes('包含明文凭据'));
    assert.ok(modal.textContent.includes('与已存在的全局配置比较'));
    assert.ok(modal.textContent.includes('参数个数'));
    assert.ok(modal.textContent.includes('1 → 2'));
    assert.ok(modal.textContent.includes('授权配置'));
    assert.ok(modal.textContent.includes('会被移除'));
    const apply = modal.querySelector('[data-field="import-apply"]');
    assert.ok(apply.textContent.includes('1'));
    apply.click();
    await tick(80);
    assert.ok($('confirmCard').textContent.includes('已有同名条目'));
    confirmYes('覆盖并导入');
    await tick(120);
    const posts = postBodies('/api/mcp/import');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0].ids, ['claude-desktop:memory']);
    assert.deepEqual(posts[0].rename, {});
    assert.equal(posts[0].allowReplace, false);
    assert.equal(posts[1].allowReplace, true);
    assert.equal(posts[1].expectedRevision, 'rev-user');
  });

  await check('市场加载卡片、搜索、分类与分页都发真实查询', async () => {
    clickText(page(), 'button', '市场');
    await tick(120);
    assert.equal((d.querySelector('.mcp-market-page .settings-page-title') || {}).textContent, 'MCP 市场');
    assert.equal(d.querySelectorAll('.mcp-market-card').length, 2);
    assert.ok(d.querySelector('.mcp-market-page').textContent.includes('2 个市场源'));
    const marketCard = (name) => [...d.querySelectorAll('.mcp-market-card')]
      .find((c) => c.querySelector('h4')?.textContent === name);
    const memoryInstall = marketCard('Memory').querySelector('button.mcp-market-install');
    assert.ok(memoryInstall.textContent.includes('已配置'), '已在 mcp.json 里的 server 必须显示已配置');
    assert.equal(memoryInstall.disabled, true);
    assert.ok(marketCard('Memory').textContent.includes('已配置'));
    assert.equal(marketCard('Filesystem').querySelector('button.mcp-market-install').disabled, false);

    const search = d.querySelector('#mcpMarketSearch');
    search.focus();
    search.value = 'memory';
    search.dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick(420);
    assert.deepEqual([...d.querySelectorAll('.mcp-market-card h4')].map((h) => h.textContent), ['Memory']);
    assert.equal(d.activeElement?.id, 'mcpMarketSearch');

    d.querySelector('#mcpMarketSearch').value = '';
    d.querySelector('#mcpMarketSearch').dispatchEvent(new w.Event('input', { bubbles: true }));
    await tick(420);
    d.querySelector('[data-focus-key="category:效率"]').click();
    await tick(80);
    assert.deepEqual([...d.querySelectorAll('.mcp-market-card h4')].map((h) => h.textContent), ['Memory']);
    d.querySelector('[data-focus-key="category:全部"]').click();
    await tick(80);
    assert.equal(d.querySelectorAll('.mcp-market-card').length, 2);
    d.querySelector('[data-focus-key="load-more"]').click();
    await tick(100);
    assert.equal(d.querySelectorAll('.mcp-market-card').length, 3);
    const marketGets = calls.filter((c) => c.target.startsWith('/api/mcp/market?'));
    assert.ok(marketGets.some((c) => c.target.includes('q=memory')));
    assert.ok(marketGets.some((c) => c.target.includes('category=%E6%95%88%E7%8E%87')));
    assert.ok(marketGets.some((c) => c.target.includes('offset=2')));

    d.querySelector('[data-focus-key="source:registry"]').click();
    await tick(100);
    assert.equal(d.querySelectorAll('.mcp-market-card').length, 1);
    d.querySelector('[data-focus-key="load-more"]').click();
    await tick(100);
    assert.equal(d.querySelectorAll('.mcp-market-card').length, 2);
    assert.ok(calls.some((c) => c.target.includes('source=registry') && c.target.includes('cursor=reg-next')));
    d.querySelector('[data-focus-key="source:builtin"]').click();
    await tick(100);
    assert.equal(d.querySelectorAll('.mcp-market-card').length, 2);
  });

  await check('市场安装继承当前 scope 筛选：项目筛选 → 默认项目级', async () => {
    clickText(d.querySelector('.mcp-market-page'), 'button', '我的服务');
    await tick(100);
    d.querySelector('[data-focus-key="filter:project"]').click();
    await tick(40);
    assert.deepEqual(cards().map((c) => c.dataset.name), ['proj']);
    clickText(page(), 'button', '市场');
    await tick(120);
    const card = [...d.querySelectorAll('.mcp-market-card')].find((c) => c.querySelector('h4')?.textContent === 'Filesystem');
    card.querySelector('button.mcp-market-install').click();
    await tick(40);
    const scope = d.querySelector('.mcp-install-modal [data-field="install-scope"]');
    assert.equal(scope.value, 'project', '从项目筛选进入市场时默认安装到项目');
    assert.equal(scope.querySelector('option[value="project"]').disabled, false);
    clickText(d.querySelector('.mcp-install-modal'), '.mcp-modal-foot-actions button', '取消');
    await tick(30);
    clickText(d.querySelector('.mcp-market-page'), 'button', '我的服务');
    await tick(100);
    d.querySelector('[data-focus-key="filter:all"]').click();
    await tick(40);
    assert.equal(cards().length, 3, '回到全部筛选');
    clickText(page(), 'button', '市场');
    await tick(120);
  });

  await check('安装只送 catalogId，成功页区分保存 / 连接 / 会话加载', async () => {
    const card = [...d.querySelectorAll('.mcp-market-card')].find((c) => c.querySelector('h4')?.textContent === 'Filesystem');
    card.querySelector('button.mcp-market-install').click();
    await tick(40);
    const modal = d.querySelector('.mcp-install-modal');
    assert.ok(modal);
    assert.ok(modal.textContent.includes('Anthropic 官方仓库'));
    assert.ok(modal.textContent.includes('npx -y @modelcontextprotocol/server-filesystem'));
    const preview = modal.querySelector('[data-market-preview]');
    assert.ok(preview, '安装确认必须显示实际命令预览');
    assert.ok(preview.textContent.includes('<允许访问的目录>'), preview.textContent);
    assert.ok(modal.textContent.includes('敏感值不会显示'));
    assert.ok(modal.textContent.includes('不会在安装时执行命令'));
    assert.ok(modal.textContent.includes('填写系统环境变量名'));
    assert.ok(modal.querySelector('[data-field="install-env-env.FS_TOKEN"]'));
    const pathField = modal.querySelector('[data-field="install-field-path"]');
    pathField.value = 'C:/my docs';
    pathField.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.ok(preview.textContent.includes('"C:/my docs"'), '含空格的值必须加引号显示');
    pathField.value = 'C:/workspace';
    pathField.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.ok(preview.textContent.includes('npx -y @modelcontextprotocol/server-filesystem C:/workspace'));
    modal.querySelector('[data-field="install-submit"]').click();
    await tick(120);
    const posted = marketInstalls.at(-1);
    assert.deepEqual(posted, {
      action: 'install', source: 'builtin', catalogId: 'filesystem', scope: 'user',
      name: 'filesystem', values: { path: 'C:/workspace' },
      expectedRevision: 'rev-user', __expectedCwd: 'C:\\workspace',
    });
    assert.ok(!JSON.stringify(posted).includes('@modelcontextprotocol/server-filesystem'), '客户端不能注入命令');
    const success = d.querySelector('.mcp-install-modal');
    assert.ok(success.textContent.includes('配置已写入'));
    assert.ok(success.textContent.includes('连接未测试'));
    assert.ok(success.textContent.includes('尚未加载'));
    assert.ok(success.textContent.includes('已写入的实际启动命令 / 端点'));
    assert.ok(success.textContent.includes('npx -y @modelcontextprotocol/server-filesystem C:/workspace'));
    clickText(success, '.mcp-modal-foot-actions button', '完成');
    await tick(30);
  });

  await check('返回“我的服务”后仍能新增第三方市场源', async () => {
    clickText(d.querySelector('.mcp-market-page'), 'button', '我的服务');
    await tick(100);
    assert.ok(page(), '应返回 MCP 管理页');
    assert.equal($('workViewTitle').textContent, 'MCP 服务器');

    clickText(page(), 'button', '市场');
    await tick(100);
    clickText(d.querySelector('.mcp-market-page'), 'button', '管理来源');
    await tick(40);
    const modal = d.querySelector('.mcp-sources-modal');
    assert.ok(modal, '来源管理弹窗');
    const input = modal.querySelector('[data-field="source-url"]');
    input.value = 'https://market.example.com/catalog.json';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    modal.querySelector('[data-field="source-add"]').click();
    await tick(100);
    const body = postBodies('/api/mcp/market').filter((b) => b.action === 'add-source').at(-1);
    assert.deepEqual(body, { action: 'add-source', url: 'https://market.example.com/catalog.json', __expectedCwd: 'C:\\workspace' });
    assert.ok(d.querySelector('.mcp-sources-modal').textContent.includes('Fixture Market'));
    assert.ok([...d.querySelectorAll('.mcp-source-tab')].some((t) => t.textContent.includes('Fixture Market')));
    clickText(d.querySelector('.mcp-sources-modal'), '.mcp-modal-foot-actions button', '完成');
    await tick(30);
  });

  await check('删除需要确认并带 revision 守卫', async () => {
    clickText(d.querySelector('.mcp-market-page'), 'button', '我的服务');
    await tick(100);
    const before = postBodies('/api/mcp/config').filter((b) => b.action === 'delete').length;
    d.querySelector('[data-focus-key="delete:user:memory"]').click();
    await tick(40);
    assert.ok($('confirmCard').textContent.includes('删除 memory'));
    confirmYes('删除');
    await tick(120);
    const posts = postBodies('/api/mcp/config').filter((b) => b.action === 'delete');
    assert.equal(posts.length, before + 1);
    assert.equal(posts.at(-1).scope, 'user');
    assert.equal(posts.at(-1).name, 'memory');
    assert.equal(posts.at(-1).expectedRevision, 'rev-user');
    assert.equal(cards().length, 2);
  });

  await check('Escape 关闭表单并把焦点还给触发按钮', async () => {
    const add = [...page().querySelectorAll('button')].find((b) => b.textContent.trim() === '新增');
    add.focus();
    add.click();
    await tick(30);
    assert.equal($('modal').hidden, false);
    const active = d.activeElement;
    assert.ok(active && $('modal').contains(active));
    active.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(40);
    assert.equal($('modal').hidden, true);
    assert.equal(d.activeElement, add);
  });

  await check('项目未信任时禁止项目写入并如实标注', async () => {
    summary.trust = { trusted: false, requiresTrust: true };
    summary.servers.find((s) => s.name === 'proj').effective = { active: false, reason: '项目未信任' };
    $('navMcp').click();
    await tick(160);
    assert.ok(page().textContent.includes('当前项目未被信任'));
    const projRow = d.querySelector('.mcp-server[data-name="proj"]');
    assert.ok(projRow.textContent.includes('项目未信任'));
    assert.equal(projRow.querySelector('[data-focus-key="toggle:project:proj"]').disabled, true);
    const add = [...page().querySelectorAll('button')].find((b) => b.textContent.trim() === '新增');
    add.click();
    await tick(30);
    const scope = d.querySelector('.mcp-form-modal [data-field="scope"]');
    assert.equal(scope.value, 'user');
    assert.equal(scope.querySelector('option[value="project"]').disabled, true);
    d.querySelector('.mcp-form-modal button').click();
    await tick(30);

    /* 市场也必须遵守同一信任边界：从项目筛选进来时不能偷偷回退成可写。 */
    d.querySelector('[data-focus-key="filter:project"]').click();
    await tick(40);
    clickText(page(), 'button', '市场');
    await tick(120);
    const card = [...d.querySelectorAll('.mcp-market-card')].find((c) => c.querySelector('h4')?.textContent === 'Filesystem');
    card.querySelector('button.mcp-market-install').click();
    await tick(40);
    const install = d.querySelector('.mcp-install-modal');
    const installScope = install.querySelector('[data-field="install-scope"]');
    assert.equal(installScope.value, 'user', '未信任时必须回退到全局，而不是默认项目');
    assert.equal(installScope.querySelector('option[value="project"]').disabled, true);
    assert.ok(install.textContent.includes('当前项目未信任'));
    assert.ok(install.textContent.includes('已回退到全局'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
