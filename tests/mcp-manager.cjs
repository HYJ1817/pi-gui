/* MCP 管理 HTTP 层的离线契约：stale 守卫 / 三态语义 / 路由装配。
 * 不启动 server、不跑 pi、不联网；req / res 都是本地假对象。
 */
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const checkAsync = async (name, fn) => { await fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

function req(method, body = null) {
  const r = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
  r.method = method;
  return r;
}
function res() {
  return {
    code: 0,
    text: '',
    writeHead(code) { this.code = code; },
    end(text) { this.text = text; },
    get body() { return JSON.parse(this.text || '{}'); },
  };
}

(async () => {
  const { createMcpManager } = await import('../server/mcp-manager.js');
  const CWD = 'C:\\fixture-project';

  const calls = { save: [], remove: [], setEnabled: [], reset: 0, install: [], scan: 0, apply: [], addSource: [], removeSource: [] };
  const configStore = {
    revisions: () => ({ user: 'rev-u', project: 'rev-p' }),
    getDetail: async ({ scope, name }) => {
      if (name === 'never-saved') return { ok: false, code: 'not-found' };
      if (name === 'broken-config') throw new Error('config store unavailable');
      /* 项目文件里只有 fixture 明确列出的条目；其余只在用户级存在。
       * 否则“没指定 scope”会先命中项目级，把运行时行也按项目 scope 去找。 */
      if (scope === 'project' && !['proj', 'dup', 'off'].includes(name)) {
        return { ok: false, code: 'not-found' };
      }
      return { ok: true, scope, name, entry: { type: 'stdio', command: 'npx' } };
    },
    save: async (input) => { calls.save.push(input); return { ok: true, name: input.name, scope: input.scope }; },
    remove: async (input) => { calls.remove.push(input); return { ok: true }; },
    setEnabled: async (input) => { calls.setEnabled.push(input); return { ok: true }; },
  };
  const native = {
    reset: () => { calls.reset++; },
    refresh: async () => ({
      ok: true, at: '2026-01-01T00:00:00.000Z', servers: [
        { name: 'memory', scope: 'global', state: 'connected', tools: ['a', 'b'], resources: 2, resourceTemplates: 1, transportType: 'stdio' },
        { name: 'remote', scope: 'global', state: 'needs-auth', tools: [], error: 'login required' },
        { name: 'proj', scope: 'project', state: 'connected', tools: 1, resources: 0 },
      ],
    }),
  };
  const market = {
    sources: () => ({ ok: true, builtin: { count: 10 }, registry: {}, custom: [] }),
    list: async (params) => ({ ok: true, source: params.source || 'builtin', items: [], categories: ['全部'] }),
    install: async (input) => { calls.install.push(input); return { ok: true, configured: true, connected: null, loaded: null, name: input.name }; },
    addSource: async (input) => { calls.addSource.push(input); return { ok: true, source: { id: 's1' } }; },
    removeSource: async (input) => { calls.removeSource.push(input); return { ok: true }; },
  };
  const importer = {
    scan: async () => { calls.scan++; return { ok: true, tools: [], entries: [] }; },
    apply: async (input) => { calls.apply.push(input); return { ok: true, imported: [{ name: 'x' }] }; },
  };
  const manager = createMcpManager({
    runtime: { getCurrentCwd: () => CWD }, mcpNative: native, configStore, market, importer,
  });
  const { staleGuard, sanitizeRuntimeServer } = manager._internals;

  section('A. stale 守卫 / 运行时投影');
  check('A·缺少 __expectedCwd 一律拒绝', () => {
    assert.equal(staleGuard({ getCurrentCwd: () => CWD }, {}).code, 'workspace-stale');
    assert.equal(staleGuard({ getCurrentCwd: () => CWD }, { __expectedCwd: '' }).code, 'workspace-stale');
  });
  check('A·工作区一致才放行', () => {
    assert.equal(staleGuard({ getCurrentCwd: () => CWD }, { __expectedCwd: CWD }), null);
    assert.equal(staleGuard({ getCurrentCwd: () => CWD }, { expectedCwd: CWD }), null);
    assert.equal(staleGuard({ getCurrentCwd: () => 'D:\\other' }, { __expectedCwd: CWD }).code, 'workspace-stale');
  });
  check('A·运行时投影同时接受数组与计数，不把数字当 0', () => {
    const s = sanitizeRuntimeServer({ name: 'x', scope: 'global', state: 'connected', tools: ['a', 'b'], resources: 3, resourceTemplates: 1 });
    assert.equal(s.tools, 2);
    assert.equal(s.resources, 3);
    assert.equal(s.resourceTemplates, 1);
    const t = sanitizeRuntimeServer({ name: 'y', state: 'connected', tools: 5, resources: ['r'], resourceTemplates: 0 });
    assert.equal(t.tools, 5);
    assert.equal(t.resources, 1);
    assert.equal(t.resourceTemplates, 0);
  });
  check('A·transport 读取 mcpNative 真实投影字段 transportType', () => {
    assert.equal(sanitizeRuntimeServer({ name: 'x', transportType: 'stdio' }).transport, 'stdio');
    assert.equal(sanitizeRuntimeServer({ name: 'x', transportType: 'http' }).transport, 'http');
    assert.equal(sanitizeRuntimeServer({ name: 'x', transport: 'stdio' }).transport, 'stdio');
    assert.equal(sanitizeRuntimeServer({ name: 'x' }).transport, '');
  });
  await checkAsync('A·超大请求体被收成 413，不产生未处理拒绝', async () => {
    const req = Readable.from([Buffer.alloc(600 * 1024, 0x61)]);
    req.method = 'POST';
    const r = res();
    await manager.handle(req, r, new URL('http://x/api/mcp/config'));
    assert.equal(r.code, 413);
    assert.equal(r.body.code, 'body-too-large');
  });

  section('B. 测试连接三态');
  await checkAsync('B·connected 才返回 connected=true，loaded 保持未知', async () => {
    const r = await manager._internals.testConnection({ name: 'memory' });
    assert.equal(r.configured, true);
    assert.equal(r.connected, true);
    assert.equal(r.loaded, null);
    assert.equal(r.server.tools, 2);
    assert.equal(r.server.resources, 2);
    assert.ok(r.loadNote.includes('/reload'));
  });
  await checkAsync('B·needs-auth 映射为明确 code，不冒充连接失败', async () => {
    const r = await manager._internals.testConnection({ name: 'remote' });
    assert.equal(r.ok, false);
    assert.equal(r.connected, false);
    assert.equal(r.code, 'needs-auth');
  });
  await checkAsync('B·同名条目按行 scope 取结果，不串用另一 scope', async () => {
    const dual = createMcpManager({
      runtime: { getCurrentCwd: () => CWD },
      configStore, market, importer,
      mcpNative: {
        reset() {},
        refresh: async () => ({
          ok: true, at: '2026-01-01T00:00:00.000Z',
          servers: [
            { name: 'dup', scope: 'global', state: 'connected', tools: ['a'] },
            { name: 'dup', scope: 'project', state: 'failed', tools: [], error: 'project down' },
          ],
        }),
      },
    });
    const user = await dual._internals.testConnection({ name: 'dup', scope: 'user' });
    assert.equal(user.connected, true);
    assert.equal(user.server.scope, 'global');
    const project = await dual._internals.testConnection({ name: 'dup', scope: 'project' });
    assert.equal(project.connected, false);
    assert.equal(project.state, 'failed');
    assert.equal(project.server.scope, 'project');
  });
  await checkAsync('B·未指定 scope 时按配置实际所在 scope 取运行时行，不串到同名项目行', async () => {
    const scoped = createMcpManager({
      runtime: { getCurrentCwd: () => CWD },
      configStore, market, importer,
      mcpNative: {
        reset() {},
        refresh: async () => ({
          ok: true, at: '2026-01-01T00:00:00.000Z',
          servers: [
            { name: 'only-global', scope: 'user', state: 'connected', tools: ['a'] },
            { name: 'only-global', scope: 'project', state: 'failed', tools: [], error: 'project down' },
          ],
        }),
      },
    });
    const r = await scoped._internals.testConnection({ name: 'only-global' });
    assert.equal(r.configured, true);
    assert.equal(r.connected, true);
    assert.equal(r.server.scope, 'user', '用户级配置不能被同名项目行覆盖成失败');
  });
  await checkAsync('B·config 有、runtime 没有 → configured，connected/loaded 均未知', async () => {
    const r = await manager._internals.testConnection({ name: 'ghost' });
    assert.equal(r.ok, false);
    assert.equal(r.configured, true);
    assert.equal(r.connected, null, '列表里没有不等于连接失败');
    assert.equal(r.loaded, null, '不得用 CLI 列表缺失推断当前 Agent 会话未加载');
    assert.equal(r.code, 'not-loaded');
  });
  await checkAsync('B·config 明确没有、runtime 也没有 → not-configured，不谎称已配置', async () => {
    const r = await manager._internals.testConnection({ name: 'never-saved' });
    assert.equal(r.ok, false);
    assert.equal(r.configured, false);
    assert.equal(r.connected, null);
    assert.equal(r.loaded, null);
    assert.equal(r.code, 'not-configured');
  });
  await checkAsync('B·配置读取失败 → configured=null，保持未知而不是未配置', async () => {
    const r = await manager._internals.testConnection({ name: 'broken-config' });
    assert.equal(r.configured, null);
    assert.equal(r.connected, null);
    assert.equal(r.loaded, null);
    assert.equal(r.code, 'not-loaded');
  });
  await checkAsync('B·runtime 有行、config 明确没有 → configured 仍为 false，不被 CLI 列表带跑', async () => {
    const stale = createMcpManager({
      runtime: { getCurrentCwd: () => CWD },
      configStore, market, importer,
      mcpNative: {
        reset() {},
        refresh: async () => ({
          ok: true, at: '2026-01-01T00:00:00.000Z',
          servers: [{ name: 'never-saved', scope: 'global', state: 'connected', tools: ['a'] }],
        }),
      },
    });
    const r = await stale._internals.testConnection({ name: 'never-saved' });
    assert.equal(r.configured, false, 'configured 只来自真实 mcp.json');
    assert.equal(r.connected, true, '连接状态只来自本次 runtime 投影');
    assert.equal(r.loaded, null);
  });
  await checkAsync('B·显式失败状态才算 connected=false，未知状态保持 null', async () => {
    const states = createMcpManager({
      runtime: { getCurrentCwd: () => CWD },
      configStore, market, importer,
      mcpNative: {
        reset() {},
        refresh: async () => ({
          ok: true, at: '2026-01-01T00:00:00.000Z',
          servers: [
            { name: 'down', scope: 'global', state: 'failed', error: 'crash' },
            { name: 'off', scope: 'project', state: 'disabled' },
            { name: 'weird', scope: 'global', state: 'starting-up' },
          ],
        }),
      },
    });
    const down = await states._internals.testConnection({ name: 'down' });
    assert.equal(down.connected, false);
    assert.equal(down.code, 'connect-failed');
    const off = await states._internals.testConnection({ name: 'off', scope: 'project' });
    assert.equal(off.connected, false);
    assert.equal(off.code, 'state-disabled');
    const weird = await states._internals.testConnection({ name: 'weird' });
    assert.equal(weird.connected, null, '未知状态不能当成连接失败');
    assert.equal(weird.loaded, null);
    assert.equal(weird.code, 'state-starting-up');
  });
  await checkAsync('B·refresh 抛错 → connected=null（不是 false）', async () => {
    const bad = createMcpManager({
      runtime: { getCurrentCwd: () => CWD },
      mcpNative: { refresh: async () => { throw new Error('boom'); }, reset() {} },
      configStore, market, importer,
    });
    const r = await bad._internals.testConnection({ name: 'memory' });
    assert.equal(r.ok, false);
    assert.equal(r.connected, null);
    assert.equal(r.loaded, null);
  });
  await checkAsync('B·refresh 返回失败（非抛错）同样是 connected=null', async () => {
    const bad = createMcpManager({
      runtime: { getCurrentCwd: () => CWD },
      mcpNative: {
        refresh: async () => ({ ok: false, code: 'list-timeout', error: 'pi mcp list 超时', servers: [] }),
        reset() {},
      },
      configStore, market, importer,
    });
    const r = await bad._internals.testConnection({ name: 'memory' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'list-timeout');
    assert.equal(r.connected, null);
    assert.equal(r.loaded, null);
  });

  section('C. HTTP 路由');
  await checkAsync('C·GET 配置返回 revision 与 limits', async () => {
    const r = res();
    await manager.handle(req('GET'), r, new URL('http://x/api/mcp/config'));
    assert.equal(r.code, 200);
    assert.deepEqual(r.body.revisions, { user: 'rev-u', project: 'rev-p' });
    assert.equal(r.body.limits.nameMax, 64);
  });
  await checkAsync('C·GET 单条详情带 revisions', async () => {
    const r = res();
    await manager.handle(req('GET'), r, new URL('http://x/api/mcp/config?scope=user&name=memory'));
    assert.equal(r.code, 200);
    assert.equal(r.body.name, 'memory');
    assert.equal(r.body.revisions.user, 'rev-u');
  });
  await checkAsync('C·POST save 无工作区守卫 → 409，且不写配置', async () => {
    const before = calls.save.length;
    const r = res();
    await manager.handle(req('POST', { action: 'save', name: 'x', transport: 'stdio', command: 'npx' }), r, new URL('http://x/api/mcp/config'));
    assert.equal(r.code, 409);
    assert.equal(r.body.code, 'workspace-stale');
    assert.equal(calls.save.length, before);
  });
  await checkAsync('C·POST save 带守卫 → 委托 configStore 并拆掉运行时缓存', async () => {
    const beforeReset = calls.reset;
    const r = res();
    await manager.handle(req('POST', {
      action: 'save', __expectedCwd: CWD, scope: 'user', name: 'x',
      transport: 'stdio', command: 'npx', env: [{ key: 'TOKEN', value: '${TOKEN}' }],
      toolExposure: { search: 'hidden' },
    }), r, new URL('http://x/api/mcp/config'));
    assert.equal(r.code, 200);
    assert.equal(r.body.ok, true);
    assert.equal(calls.save.at(-1).env[0].value, '${TOKEN}');
    assert.deepEqual(calls.save.at(-1).toolExposure, { search: 'hidden' });
    assert.equal(calls.reset, beforeReset + 1);
  });
  await checkAsync('C·POST test 走独立 refresh，不写配置', async () => {
    const before = calls.save.length;
    const r = res();
    await manager.handle(req('POST', { action: 'test', __expectedCwd: CWD, name: 'memory' }), r, new URL('http://x/api/mcp/config'));
    assert.equal(r.code, 200);
    assert.equal(r.body.connected, true);
    assert.equal(r.body.loaded, null);
    assert.equal(calls.save.length, before);
  });
  await checkAsync('C·未知配置动作 400', async () => {
    const r = res();
    await manager.handle(req('POST', { action: 'run-anything', __expectedCwd: CWD }), r, new URL('http://x/api/mcp/config'));
    assert.equal(r.code, 400);
    assert.equal(r.body.code, 'unsupported-action');
  });
  await checkAsync('C·市场安装带守卫、返回 revisions；来源管理不要求守卫', async () => {
    const r = res();
    await manager.handle(req('POST', {
      action: 'install', __expectedCwd: CWD, source: 'builtin', catalogId: 'memory', name: 'memory',
    }), r, new URL('http://x/api/mcp/market'));
    assert.equal(r.code, 200);
    assert.equal(r.body.configured, true);
    assert.equal(r.body.revisions.user, 'rev-u');
    assert.equal(calls.install.at(-1).catalogId, 'memory');

    const add = res();
    await manager.handle(req('POST', { action: 'add-source', url: 'https://m.example/c.json' }), add, new URL('http://x/api/mcp/market'));
    assert.equal(add.code, 200);
    assert.equal(calls.addSource.at(-1).url, 'https://m.example/c.json');

    const stale = res();
    await manager.handle(req('POST', { action: 'install', source: 'builtin', catalogId: 'memory' }), stale, new URL('http://x/api/mcp/market'));
    assert.equal(stale.code, 409);
  });
  await checkAsync('C·导入 GET / POST 装配', async () => {
    const scan = res();
    await manager.handle(req('GET'), scan, new URL('http://x/api/mcp/import'));
    assert.equal(scan.code, 200);
    assert.equal(calls.scan, 1);

    const apply = res();
    await manager.handle(req('POST', { action: 'apply', __expectedCwd: CWD, ids: ['a:1'], scope: 'user' }), apply, new URL('http://x/api/mcp/import'));
    assert.equal(apply.code, 200);
    assert.deepEqual(calls.apply.at(-1).ids, ['a:1']);
    assert.equal(apply.body.revisions.project, 'rev-p');

    const stale = res();
    await manager.handle(req('POST', { action: 'apply', ids: ['a:1'] }), stale, new URL('http://x/api/mcp/import'));
    assert.equal(stale.code, 409);
  });

  console.log(`\n${count} assertions passed`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
