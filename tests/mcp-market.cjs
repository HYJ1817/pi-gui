/* MCP 市场：内置目录 / Registry 分页 / 第三方源 / 安装解析 / SSRF 边界。
 * 全部离线：fetch 与 DNS 都注入假实现，数据目录在 os.tmpdir()。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { classifyProxyRoute } = require('../lib/market-network-policy.cjs');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const checkAsync = async (name, fn) => { await fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

/** 等后台刷新真正收尾（不是按墙钟时间猜）。 */
const waitForRegistryRefresh = async (market) => {
  for (let i = 0; i < 500; i += 1) {
    if (market.registryStatus().active !== true) {
      await new Promise((resolve) => setImmediate(resolve));
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Registry 后台刷新没有在预期内结束');
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-mcp-mkt-'));
const AGENT = path.join(TMP, 'agent');
const PROJECT = path.join(TMP, 'project');
const DATA = path.join(TMP, 'data');
const ALLOWED = path.join(PROJECT, 'allowed');
fs.mkdirSync(AGENT, { recursive: true });
fs.mkdirSync(path.join(PROJECT, '.pi'), { recursive: true });
fs.mkdirSync(ALLOWED, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
const env = { HOME: TMP, USERPROFILE: TMP, PI_CODING_AGENT_DIR: AGENT, PATH: process.env.PATH || '' };
const userFile = path.join(AGENT, 'mcp.json');
const sourcesFile = path.join(DATA, 'mcp-market-sources.json');
const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});
const REGISTRY_ROW = {
  server: {
    name: 'io.example/test-server',
    title: 'Test Server',
    description: 'A test MCP server for the market contract.',
    version: '1.2.3',
    packages: [{
      registryType: 'npm',
      identifier: 'test-mcp',
      version: '1.2.3',
      runtimeHint: 'npx',
      transport: { type: 'stdio' },
      packageArguments: [{ type: 'positional', valueHint: 'root', isRequired: true, description: 'Root directory' }],
      environmentVariables: [{ name: 'TEST_TOKEN', isRequired: true, isSecret: true }],
    }],
  },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
};
function makeRegistryRow(name, {
  version = '1.0.0', title = '', description = '', isLatest = true, status = 'active',
} = {}) {
  return {
    server: {
      name,
      title: title || name.split('/').pop(),
      description: description || `Fixture MCP server ${name}`,
      version,
      packages: [{
        registryType: 'npm',
        identifier: 'fixture-mcp',
        version,
        runtimeHint: 'npx',
        transport: { type: 'stdio' },
      }],
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status, isLatest } },
  };
}
/* 100 + 100 + 9 条最新版本；分类由描述驱动，用来验证完整目录上的本地筛选。 */
const BIG_REGISTRY_ROWS = Array.from({ length: 209 }, (_, i) => {
  const index = String(i).padStart(3, '0');
  const description = i % 3 === 0
    ? 'developer code repository tools'
    : i % 3 === 1 ? 'database sql data tools' : 'knowledge documentation wiki';
  return makeRegistryRow(`io.example/server-${index}`, { description });
});
const BIG_REGISTRY_PAGES = (cursor) => {
  if (!cursor) return { servers: BIG_REGISTRY_ROWS.slice(0, 100), metadata: { count: 100, nextCursor: 'cursor-2' } };
  if (cursor === 'cursor-2') return { servers: BIG_REGISTRY_ROWS.slice(100, 200), metadata: { count: 100, nextCursor: 'cursor-3' } };
  if (cursor === 'cursor-3') return { servers: BIG_REGISTRY_ROWS.slice(200, 209), metadata: { count: 9 } };
  return { servers: [], metadata: {} };
};
const CUSTOM_SOURCE = {
  name: 'Example Market',
  servers: [
    { id: 'hello', name: 'hello', title: 'Hello', description: 'Hello server', transport: 'stdio', command: 'npx', args: ['-y', 'hello-mcp'], env: { HELLO_TOKEN: '${HELLO_TOKEN}' } },
    { id: 'bad-command', name: 'bad-command', command: 'bash', args: ['-c', 'whoami'] },
    { id: 'plain-secret', name: 'plain-secret', command: 'npx', args: ['-y', 'x'], env: { API_KEY: 'sk-live-123' } },
    { id: 'v6-local', name: 'v6-local', url: 'https://[::1]/mcp' },
    { id: 'v4-mapped', name: 'v4-mapped', url: 'https://[::ffff:7f00:1]/mcp' },
    { id: 'port-8443', name: 'port-8443', url: 'https://market.example:8443/mcp' },
  ],
};

(async () => {
  const { createMcpMarket: createMcpMarketRaw } = await import('../server/mcp-market.js');
  /* 绝大多数用例只关心内存行为；默认关掉磁盘缓存，避免共享 DATA 目录
   * 让上一条用例的目录泄漏到下一条。缓存专项用例直接用 Raw 版本。 */
  const createMcpMarket = (opts = {}) => createMcpMarketRaw({ registryCache: false, ...opts });
  const { createMcpConfigStore } = await import('../server/mcp-config.js');
  const state = { trust: { trusted: true, requiresTrust: false } };
  const store = createMcpConfigStore({
    runtime: { getCurrentCwd: () => PROJECT },
    env,
    readTrust: async () => state.trust,
    now: () => 1700000000000,
  });
  const calls = [];
  const requestImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://registry.modelcontextprotocol.io/')) {
      /* 完整目录夹具：单页一条；分页/去重另用专门夹具验证。 */
      return jsonResponse({ servers: [REGISTRY_ROW], metadata: { count: 1 } });
    }
    if (url === 'https://market.example/servers.json') return jsonResponse(CUSTOM_SOURCE);
    if (url === 'https://market.example/bad.json') return jsonResponse({ nope: true });
    if (url === 'https://market.example/redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    if (url === 'https://market.example/big') return jsonResponse({ servers: [] }, 200, { 'content-length': String(3 * 1024 * 1024) });
    if (url === 'https://market.example/text') return new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } });
    return jsonResponse({ servers: [], metadata: {} });
  };
  const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
  const market = createMcpMarket({
    dataDir: DATA, configStore: store, env, requestImpl, lookupImpl, now: () => 1700000000000,
  });

  section('A. 内置精选目录（离线）');
  await checkAsync('A·十条内置条目、分类与来源标记', async () => {
    const r = await market.list({ source: 'builtin' });
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 10);
    assert.equal(r.total, 10);
    assert.ok(r.items.every((i) => i.trust === 'official' || i.trust === 'verified' || i.trust === 'community'));
    assert.ok(r.items.every((i) => i.trustEvidence));
    assert.ok(r.items.some((i) => i.name === 'Memory'));
    assert.ok(r.items.some((i) => i.name === 'Serena'));
    assert.deepEqual(r.categories, ['全部', '开发工具', '网络', '文档', '数据', '效率']);
  });
  await checkAsync('A·搜索与分类过滤', async () => {
    const r = await market.list({ source: 'builtin', q: 'playwright', category: '全部' });
    assert.deepEqual(r.items.map((i) => i.name), ['Playwright']);
    const d = await market.list({ source: 'builtin', category: '文档' });
    assert.ok(d.items.length >= 1 && d.items.every((i) => i.category === '文档'));
    const none = await market.list({ source: 'builtin', q: 'no-such-thing' });
    assert.equal(none.items.length, 0);
    assert.equal(none.hasMore, false);
  });
  await checkAsync('A·分页 hasMore / offset', async () => {
    const p1 = await market.list({ source: 'builtin', limit: 4 });
    assert.equal(p1.items.length, 4);
    assert.equal(p1.hasMore, true);
    const p3 = await market.list({ source: 'builtin', limit: 4, offset: 8 });
    assert.equal(p3.items.length, 2);
    assert.equal(p3.hasMore, false);
  });

  section('B. 安装内置条目（服务端模板）');
  await checkAsync('B·Filesystem 缺必填 path 被拒', async () => {
    const files = (await market.list({ source: 'builtin' })).items.find((i) => i.catalogId === 'filesystem');
    const r = await market.install({ source: 'builtin', catalogId: files.catalogId, scope: 'user', expectedRevision: store.revisions().user, values: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'missing-field');
    assert.equal(fs.existsSync(userFile), false);
  });
  await checkAsync('B·Filesystem 安装写入固定模板，客户端无法改 command', async () => {
    const files = (await market.list({ source: 'builtin' })).items.find((i) => i.catalogId === 'filesystem');
    const r = await market.install({
      source: 'builtin', catalogId: files.catalogId, scope: 'user',
      expectedRevision: store.revisions().user,
      values: { path: ALLOWED },
      command: 'evil', args: ['--evil'],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.configured, true);
    assert.equal(r.connected, null);
    assert.equal(r.loaded, null);
    const saved = JSON.parse(fs.readFileSync(userFile, 'utf8')).mcpServers.filesystem;
    assert.equal(saved.command, 'npx');
    assert.deepEqual(saved.args, ['-y', '@modelcontextprotocol/server-filesystem', ALLOWED]);
    assert.notEqual(saved.command, 'evil');
    assert.ok(r.dependencyProbe.every((d) => typeof d.found === 'boolean'));
  });
  await checkAsync('B·同名安装要求确认，allowReplace 后覆盖', async () => {
    const files = (await market.list({ source: 'builtin' })).items.find((i) => i.catalogId === 'filesystem');
    const again = await market.install({
      source: 'builtin', catalogId: files.catalogId, scope: 'user',
      expectedRevision: store.revisions().user, values: { path: ALLOWED },
    });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'name-conflict');
    assert.equal(again.canReplace, true);
    const replaced = await market.install({
      source: 'builtin', catalogId: files.catalogId, scope: 'user',
      expectedRevision: store.revisions().user, values: { path: ALLOWED }, allowReplace: true,
    });
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
  });

  await checkAsync('B·覆盖安装不把旧条目的 env 带到新配置', async () => {
    const seeded = await store.save({
      scope: 'user', name: 'filesystem', originalName: 'filesystem',
      expectedRevision: store.revisions().user,
      transport: 'stdio', command: 'npx', args: ['-y', 'old-package'],
      env: [{ key: 'OLD_TOKEN', value: '${OLD_TOKEN}' }],
    });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    const files = (await market.list({ source: 'builtin' })).items.find((i) => i.catalogId === 'filesystem');
    const replaced = await market.install({
      source: 'builtin', catalogId: files.catalogId, scope: 'user',
      expectedRevision: store.revisions().user, values: { path: ALLOWED }, allowReplace: true,
    });
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    const saved = JSON.parse(fs.readFileSync(userFile, 'utf8')).mcpServers.filesystem;
    assert.equal(saved.env, undefined, '旧凭据不应被新安装继承');
    assert.deepEqual(saved.args, ['-y', '@modelcontextprotocol/server-filesystem', ALLOWED]);
  });

  section('C. 官方 Registry');
  await checkAsync('C·完整目录请求使用 latest + limit=100，搜索在本地完成', async () => {
    calls.length = 0;
    const r = await market.list({ source: 'registry', q: 'test', pageSize: 5 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].name, 'Test Server');
    assert.equal(r.items[0].version, '1.2.3');
    assert.equal(r.items[0].trust, 'registry');
    assert.equal(r.items[0].installable, true);
    assert.equal(r.total, 1, '总数来自完整目录，不是 metadata.count');
    assert.equal(r.page, 1);
    assert.equal(r.pageSize, 5);
    assert.equal(r.totalPages, 1);
    assert.equal(r.hasMore, false);
    assert.equal(r.nextCursor, null);
    assert.ok(calls[0].includes('version=latest'));
    assert.ok(calls[0].includes('limit=100'), '单页请求必须用官方上限 100');
    assert.ok(!calls[0].includes('search='), '短搜索词不能发到会 422 的上游 search');
    assert.equal(r.cached, false, '首次加载不能冒充缓存命中');
    const cached = await market.list({ source: 'registry', q: 'test', pageSize: 5 });
    assert.equal(cached.ok, true);
    assert.equal(cached.cached, true);
    assert.equal(calls.length, 1, '缓存命中和翻页都不能重新请求完整 Registry');
  });
  await checkAsync('C·分类筛选会基于完整 Registry 目录', async () => {
    const rows = {
      'cursor-doc': {
        servers: [{ server: { name: 'io.example/memory', title: 'Memory', description: 'Long term memory and knowledge', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'memory-mcp', version: '1.0.0', runtimeHint: 'npx', transport: { type: 'stdio' } }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } }],
        metadata: {},
      },
    };
    const docCalls = [];
    const paged = createMcpMarket({
      dataDir: DATA, configStore: store, env,
      requestImpl: async (url) => {
        docCalls.push(url);
        const u = new URL(url);
        if (u.searchParams.get('cursor') === 'cursor-doc') return jsonResponse(rows['cursor-doc']);
        return jsonResponse({ servers: [REGISTRY_ROW], metadata: { nextCursor: 'cursor-doc' } });
      },
      lookupImpl,
    });
    const r = await paged.list({ source: 'registry', category: '文档', limit: 5 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.items.map((i) => i.name), ['Memory']);
    assert.ok(r.items.every((i) => i.category === '文档'));
    assert.equal(r.total, 1);
    assert.ok(docCalls.some((c) => c.includes('cursor=cursor-doc')), '分类筛选必须基于完整目录');
  });

  await checkAsync('C·Registry 安装重新查询并写入配置（忽略客户端配置）', async () => {
    const listing = await market.list({ source: 'registry', q: 'test' });
    const item = listing.items[0];
    const r = await market.install({
      source: 'registry', catalogId: item.catalogId, scope: 'user',
      expectedRevision: store.revisions().user,
      command: 'evil', url: 'https://evil.example', values: { arg0: ALLOWED },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const saved = JSON.parse(fs.readFileSync(userFile, 'utf8')).mcpServers['Test-Server'];
    assert.equal(saved.command, 'npx');
    assert.deepEqual(saved.args, ['-y', 'test-mcp@1.2.3', ALLOWED]);
    assert.equal(saved.env.TEST_TOKEN, '${TEST_TOKEN}');
    assert.notEqual(saved.url, 'https://evil.example');
    assert.ok(r.commandPreview.includes(ALLOWED));
    assert.deepEqual(r.requiredEnvKeys, ['TEST_TOKEN']);
  });
  await checkAsync('C·Registry 失败返回明确 code，内置目录仍可用', async () => {
    const bad = createMcpMarket({
      dataDir: DATA, configStore: store, env,
      requestImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError', marketCode: 'timeout' }); },
      lookupImpl,
    });
    const r = await bad.list({ source: 'registry', q: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'timeout');
    const builtin = await bad.list({ source: 'builtin' });
    assert.equal(builtin.ok, true);
    assert.equal(builtin.items.length, 10);
  });
  await checkAsync('C·PyPI 包用 uvx 与具体版本转换', async () => {
    const py = createMcpMarket({
      dataDir: DATA, configStore: store, env,
      requestImpl: async () => jsonResponse({
        servers: [{ server: { name: 'io.example/py', title: 'Py', version: '1.0.0', packages: [{ registryType: 'pypi', identifier: 'py-mcp', version: '1.0.0', runtimeHint: 'uvx', transport: { type: 'stdio' } }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } }],
      }),
      lookupImpl,
    });
    const r = await py.list({ source: 'registry' });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].installable, true, JSON.stringify(r.items[0]));
    assert.equal(r.items[0].commandSummary, 'uvx py-mcp==1.0.0');
  });
  await checkAsync('C·不支持的包类型 / SSE / 版本范围标记为不可安装', async () => {
    const odd = createMcpMarket({
      dataDir: DATA, configStore: store, env,
      requestImpl: async () => jsonResponse({
        servers: [
          { server: { name: 'io.example/oci', title: 'OCI', version: '1.0.0', packages: [{ registryType: 'oci', identifier: 'docker.io/x', version: '1.0.0', transport: { type: 'stdio' } }] }, _meta: {} },
          { server: { name: 'io.example/sse', title: 'SSE', version: '1.0.0', remotes: [{ type: 'sse', url: 'https://x.example/sse' }] }, _meta: {} },
          { server: { name: 'io.example/range', title: 'Range', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'range-mcp', version: '^1.0.0', runtimeHint: 'npx', transport: { type: 'stdio' } }] }, _meta: {} },
        ],
      }),
      lookupImpl,
    });
    const r = await odd.list({ source: 'registry' });
    assert.equal(r.items.length, 3);
    for (const item of r.items) {
      assert.equal(item.installable, false, item.name);
      assert.ok(item.installReason, item.name);
    }
    assert.match(r.items.find((i) => i.name === 'SSE').installReason, /SSE/);
    assert.match(r.items.find((i) => i.name === 'Range').installReason, /版本/);
  });

  section('C2. Registry 完整目录 / 分页 / 缓存');

  await checkAsync('C2·100+100+9 三页游标合并，209 条 = 9 页', async () => {
    const catalogCalls = [];
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env,
      requestImpl: async (url) => {
        catalogCalls.push(url);
        const u = new URL(url);
        return jsonResponse(BIG_REGISTRY_PAGES(u.searchParams.get('cursor') || ''));
      },
      lookupImpl,
    });
    const p1 = await m.list({ source: 'registry', page: 1, pageSize: 24 });
    assert.equal(p1.ok, true, JSON.stringify(p1));
    assert.equal(p1.total, 209);
    assert.equal(p1.totalPages, 9);
    assert.equal(p1.page, 1);
    assert.equal(p1.pageSize, 24);
    assert.equal(p1.items.length, 24);
    assert.equal(p1.hasMore, true);
    assert.equal(p1.cached, false);
    assert.equal(catalogCalls.length, 3);
    assert.ok(catalogCalls.every((url) => url.includes('version=latest') && url.includes('limit=100')));
    assert.ok(!catalogCalls[0].includes('cursor='), '第一页不能带 cursor');
    assert.ok(catalogCalls[1].includes('cursor=cursor-2'), '必须沿用上一页 nextCursor');
    assert.ok(catalogCalls[2].includes('cursor=cursor-3'));
    assert.ok(!catalogCalls.some((url) => url.includes('search=')));

    const p2 = await m.list({ source: 'registry', page: 2, pageSize: 24 });
    assert.equal(p2.page, 2);
    assert.equal(p2.items.length, 24);
    assert.equal(p2.cached, true);
    assert.equal(p2.items[0].identifier, 'io.example/server-024');
    const p9 = await m.list({ source: 'registry', page: 9, pageSize: 24 });
    assert.equal(p9.page, 9);
    assert.equal(p9.items.length, 17, '最后一页不足 24 条');
    assert.equal(p9.hasMore, false);
    assert.equal(p9.items[0].identifier, 'io.example/server-192');
    assert.equal(p9.items.at(-1).identifier, 'io.example/server-208');
    assert.equal(catalogCalls.length, 3, '翻页不能重新请求完整 Registry');

    const all = [];
    for (const page of [1, 2, 3]) {
      const r = await m.list({ source: 'registry', page, pageSize: 100 });
      all.push(...r.items);
    }
    assert.equal(all.length, 209);
    assert.equal(new Set(all.map((item) => item.identifier)).size, 209);
  });

  await checkAsync('C2·页码 / 每页大小边界收敛到缓存目录', async () => {
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async (url) => jsonResponse(BIG_REGISTRY_PAGES(new URL(url).searchParams.get('cursor') || '')),
    });
    const beyond = await m.list({ source: 'registry', page: 999, pageSize: 24 });
    assert.equal(beyond.page, 9, '超出末页必须夹到最后一页');
    assert.equal(beyond.items.length, 17);
    assert.equal(beyond.hasMore, false);
    for (const value of [0, '', '  ', -5, 'nope']) {
      const r = await m.list({ source: 'registry', pageSize: value });
      assert.equal(r.pageSize, 24, `pageSize=${JSON.stringify(value)} 应回落到 24`);
      assert.equal(r.totalPages, 9);
    }
    const huge = await m.list({ source: 'registry', pageSize: 1000 });
    assert.equal(huge.pageSize, 100, 'pageSize 上限是 100');
    assert.equal(huge.totalPages, 3);
  });

  await checkAsync('C2·非空页全无 server 形状 → invalid-response，不缓存空目录', async () => {
    let calls = 0;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => {
        calls += 1;
        return jsonResponse({ servers: [{}, { name: 'io.example/not-wrapped' }], metadata: { count: 2 } });
      },
    });
    const r = await m.list({ source: 'registry' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'invalid-response');
    assert.deepEqual(r.items, []);
    const again = await m.list({ source: 'registry' });
    assert.equal(again.ok, false);
    assert.equal(calls, 2, '非法页不能留下 5 分钟空缓存');
  });

  await checkAsync('C2·按 server name 去重并优先 isLatest，count 不当总数', async () => {
    const rows = [
      makeRegistryRow('io.example/dup', { version: '1.0.0', isLatest: false }),
      makeRegistryRow('io.example/dup', { version: '2.0.0', isLatest: true }),
      makeRegistryRow('io.example/dup', { version: '2.0.0', isLatest: true }),
      makeRegistryRow('io.example/other', { version: '1.0.0' }),
    ];
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => jsonResponse({ servers: rows, metadata: { count: 100 } }),
    });
    const r = await m.list({ source: 'registry' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.total, 2, '总数必须是去重后的完整目录，不是 metadata.count');
    assert.equal(r.items.length, 2);
    const dup = r.items.find((item) => item.identifier === 'io.example/dup');
    assert.equal(dup.version, '2.0.0');
    assert.equal(dup.isLatest, true);
    assert.equal(r.items.find((item) => item.identifier === 'io.example/other').version, '1.0.0');
  });

  await checkAsync('C2·完整目录复用同一个 keep-alive agent，其它请求仍逐请求建连', async () => {
    const seenAgents = [];
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async (url, opts) => {
        seenAgents.push(opts.agent);
        return jsonResponse(BIG_REGISTRY_PAGES(new URL(url).searchParams.get('cursor') || ''));
      },
    });
    const r = await m.list({ source: 'registry' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(seenAgents.length, 3, '209 条完整目录应请求 3 页');
    assert.ok(seenAgents[0] instanceof https.Agent, '目录抓取必须使用专用 agent');
    assert.equal(seenAgents[0].keepAlive, true);
    assert.equal(seenAgents[0].maxSockets, 1);
    assert.equal(new Set(seenAgents).size, 1, '同一轮目录抓取必须复用同一个 agent');

    const seen = [];
    const plain = await market._internals.fetchJson('https://market.example/x', {
      env: {},
      lookupImpl,
      requestImpl: async (url, opts) => { seen.push(opts); return jsonResponse({ ok: 1 }); },
    });
    assert.equal(plain.ok, true, JSON.stringify(plain));
    assert.equal('agent' in seen[0], false, '普通市场请求不携带 agent，保持逐请求建连');

    const custom = new https.Agent({ keepAlive: true, maxSockets: 1 });
    seen.length = 0;
    const passed = await market._internals.fetchJson('https://market.example/x', {
      env: {},
      lookupImpl,
      requestImpl: async (url, opts) => { seen.push(opts); return jsonResponse({ ok: 1 }); },
      agent: custom,
    });
    assert.equal(passed.ok, true, JSON.stringify(passed));
    assert.equal(seen[0].agent, custom, '显式 agent 必须原样传给直连请求');
    custom.destroy();
  });

  await checkAsync('C2·目录抓取失败也销毁专用 agent，不留空闲连接', async () => {
    const originalDestroy = https.Agent.prototype.destroy;
    let destroys = 0;
    https.Agent.prototype.destroy = function patchedDestroy(...args) {
      destroys += 1;
      return originalDestroy.apply(this, args);
    };
    try {
      const m = createMcpMarket({
        dataDir: DATA, configStore: store, env, lookupImpl,
        requestImpl: async () => { throw Object.assign(new Error('down'), { marketCode: 'network' }); },
      });
      const r = await m.list({ source: 'registry' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'network');
    } finally {
      https.Agent.prototype.destroy = originalDestroy;
    }
    assert.equal(destroys, 1, '失败路径也必须销毁目录专用 agent');
  });

  await checkAsync('C2·搜索 / 分类在完整目录本地组合，短词不触发 422', async () => {
    const catalogCalls = [];
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env,
      requestImpl: async (url) => {
        catalogCalls.push(url);
        const u = new URL(url);
        return jsonResponse(BIG_REGISTRY_PAGES(u.searchParams.get('cursor') || ''));
      },
      lookupImpl,
    });
    const q0 = await m.list({ source: 'registry', q: 'server-0', pageSize: 24 });
    assert.equal(q0.ok, true, JSON.stringify(q0));
    assert.equal(q0.total, 100);
    assert.equal(q0.totalPages, 5);
    const combo = await m.list({ source: 'registry', q: 'server-0', category: '数据', pageSize: 24 });
    assert.equal(combo.total, 33);
    assert.equal(combo.totalPages, 2);
    assert.equal(combo.items.length, 24);
    assert.ok(combo.items.every((item) => item.category === '数据'));
    const short = await m.list({ source: 'registry', q: 'io' });
    assert.equal(short.total, 209, '两字符搜索也在本地完成，不发上游 search');
    const none = await m.list({ source: 'registry', q: 'no-such-server' });
    assert.equal(none.ok, true);
    assert.equal(none.total, 0);
    assert.equal(none.totalPages, 0);
    assert.equal(none.page, 1);
    assert.deepEqual(none.items, []);
    assert.equal(none.hasMore, false);
    assert.ok(!catalogCalls.some((url) => url.includes('search=')));
  });

  await checkAsync('C2·并发请求共享同一次完整目录加载', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const rows = [makeRegistryRow('io.example/a'), makeRegistryRow('io.example/b')];
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => {
        calls += 1;
        await gate;
        return jsonResponse({ servers: rows, metadata: { count: 2 } });
      },
    });
    const p1 = m.list({ source: 'registry', page: 1, pageSize: 1 });
    const p2 = m.list({ source: 'registry', page: 2, pageSize: 1 });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(calls, 1, '并发列表请求只能触发一次完整目录加载');
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r1.total, 2);
    assert.equal(r1.page, 1);
    assert.equal(r1.items.length, 1);
    assert.equal(r2.page, 2);
    assert.equal(r2.items.length, 1);
  });

  await checkAsync('C2·中途分页失败不缓存半份目录；重复 / 非法游标明确报错', async () => {
    let failSecond = true;
    let calls = 0;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async (url) => {
        calls += 1;
        const u = new URL(url);
        if (u.searchParams.get('cursor') === 'p2') {
          if (failSecond) throw Object.assign(new Error('page 2 down'), { marketCode: 'network' });
          return jsonResponse({ servers: [makeRegistryRow('io.example/second')], metadata: {} });
        }
        return jsonResponse({ servers: [makeRegistryRow('io.example/first')], metadata: { nextCursor: 'p2' } });
      },
    });
    const failed = await m.list({ source: 'registry' });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'network');
    assert.deepEqual(failed.items, []);
    assert.equal(calls, 2);
    failSecond = false;
    const recovered = await m.list({ source: 'registry' });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.total, 2);
    assert.equal(recovered.cached, false, '失败请求不能留下半份缓存');
    assert.equal(calls, 4);

    let loopCalls = 0;
    const loop = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => {
        loopCalls += 1;
        return jsonResponse({ servers: [REGISTRY_ROW], metadata: { nextCursor: 'same-cursor' } });
      },
    });
    const looped = await loop.list({ source: 'registry' });
    assert.equal(looped.ok, false);
    assert.equal(looped.code, 'registry-cursor-loop');
    assert.equal(loopCalls, 2, '重复游标必须在第二次出现时停止');

    const invalid = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => jsonResponse({ servers: [REGISTRY_ROW], metadata: { nextCursor: 42 } }),
    });
    const bad = await invalid.list({ source: 'registry' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'invalid-response');

    const down = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => { throw Object.assign(new Error('down'), { marketCode: 'network' }); },
    });
    const failedFirst = await down.list({ source: 'registry' });
    assert.equal(failedFirst.ok, false);
    assert.equal(failedFirst.code, 'network');
    assert.deepEqual(failedFirst.items, []);
  });

  check('C2·cursor 原样传递：特殊字符 / 4096 上限 / 非法值明确失败', () => {
    const { registryCatalogUrl, registryQueryUrl } = market._internals;
    const special = 'tok+/=&%? 空格/中文/😀';
    for (const url of [registryCatalogUrl({ cursor: special }), registryQueryUrl({ cursor: special })]) {
      assert.equal(new URL(url).searchParams.get('cursor'), special);
    }
    const max = 'x'.repeat(4096);
    assert.equal(new URL(registryCatalogUrl({ cursor: max })).searchParams.get('cursor'), max);
    /* 首尾空格是合法内容的一部分，只能校验，不能 trim 后回传。 */
    const spaced = '  tok  ';
    for (const url of [registryCatalogUrl({ cursor: spaced }), registryQueryUrl({ cursor: spaced })]) {
      assert.equal(new URL(url).searchParams.get('cursor'), spaced);
    }
    assert.throws(
      () => registryCatalogUrl({ cursor: 'x'.repeat(4097) }),
      (err) => err.marketCode === 'invalid-response' && /4096/.test(err.message),
    );
    assert.throws(
      () => registryCatalogUrl({ cursor: '   ' }),
      (err) => err.marketCode === 'invalid-response' && /空白/.test(err.message),
    );
    assert.throws(() => registryQueryUrl({ cursor: 42 }), (err) => err.marketCode === 'invalid-response');
    assert.throws(() => registryCatalogUrl({ cursor: 'bad\u0000cursor' }), (err) => err.marketCode === 'invalid-response');
    assert.throws(() => registryCatalogUrl({ cursor: 'bad\uD800cursor' }), (err) => err.marketCode === 'invalid-response');
  });

  await checkAsync('C2·上游 cursor 含特殊字符时原样用于下一页', async () => {
    const special = 'tok+/=&%? 空格/中文/😀';
    const seen = [];
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async (url) => {
        const cursor = new URL(url).searchParams.get('cursor') || '';
        seen.push(cursor);
        if (!cursor) {
          return jsonResponse({ servers: [makeRegistryRow('io.example/special-a')], metadata: { nextCursor: special } });
        }
        return jsonResponse({ servers: [makeRegistryRow('io.example/special-b')], metadata: {} });
      },
    });
    const r = await m.list({ source: 'registry' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(seen, ['', special], '下一页必须收到未改写的原始 cursor');
    assert.equal(r.total, 2);
  });

  await checkAsync('C2·超长上游 cursor 明确失败且不缓存半份目录', async () => {
    let calls = 0;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => {
        calls += 1;
        return jsonResponse({ servers: [REGISTRY_ROW], metadata: { nextCursor: 'x'.repeat(4097) } });
      },
    });
    const first = await m.list({ source: 'registry' });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'invalid-response');
    assert.match(first.error, /4096/);
    assert.deepEqual(first.items, []);
    const second = await m.list({ source: 'registry' });
    assert.equal(second.ok, false);
    assert.equal(calls, 2, '失败不能留下半份目录缓存');
  });

  await checkAsync('C2·只含空白的上游 cursor 明确失败且不缓存半份目录', async () => {
    let calls = 0;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => {
        calls += 1;
        return jsonResponse({ servers: [REGISTRY_ROW], metadata: { nextCursor: '   ' } });
      },
    });
    const first = await m.list({ source: 'registry' });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'invalid-response');
    assert.match(first.error, /空白/);
    assert.deepEqual(first.items, []);
    const second = await m.list({ source: 'registry' });
    assert.equal(second.ok, false);
    assert.equal(calls, 2, '空白 cursor 不能当成正常结束并缓存目录');
  });

  await checkAsync('C2·空串 nextCursor 表示正常结束并缓存完整目录', async () => {
    let calls = 0;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => {
        calls += 1;
        return jsonResponse({ servers: [REGISTRY_ROW], metadata: { nextCursor: '' } });
      },
    });
    const first = await m.list({ source: 'registry' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.total, 1);
    assert.equal(calls, 1);
    const second = await m.list({ source: 'registry' });
    assert.equal(second.ok, true);
    assert.equal(calls, 1, '完整目录应缓存，不能重复抓取');
  });

  await checkAsync('C2·过期目录先返回旧缓存并后台刷新，失败后退避', async () => {
    let nowMs = 1700000000000;
    let fail = false;
    let calls = 0;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      now: () => nowMs,
      requestImpl: async (url) => {
        calls += 1;
        if (fail) throw Object.assign(new Error('registry down'), { marketCode: 'network' });
        const u = new URL(url);
        return jsonResponse(BIG_REGISTRY_PAGES(u.searchParams.get('cursor') || ''));
      },
    });
    const first = await m.list({ source: 'registry', page: 1, pageSize: 24 });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.total, 209);
    assert.equal(first.stale, undefined);
    assert.equal(first.cached, false);
    assert.equal(calls, 3);
    nowMs += 61 * 60_000;
    fail = true;
    const stale = await m.list({ source: 'registry', page: 2, pageSize: 24 });
    assert.equal(stale.ok, true, JSON.stringify(stale));
    assert.equal(stale.stale, true);
    assert.equal(stale.refreshing, true, '过期后先返回旧目录，刷新在后台');
    assert.equal(stale.cached, true);
    assert.equal(stale.total, 209);
    assert.equal(stale.items.length, 24);
    assert.equal(stale.page, 2);
    assert.equal(stale.refreshError, undefined, '后台刷新还没结束');
    assert.equal(calls, 4, '过期后只发起一轮后台刷新');
    await waitForRegistryRefresh(m);
    const failed = await m.list({ source: 'registry', page: 3, pageSize: 24 });
    assert.equal(failed.ok, true);
    assert.equal(failed.stale, true);
    assert.equal(failed.refreshing, undefined);
    assert.equal(failed.refreshError.code, 'network');
    assert.equal(calls, 4, '退避窗口内不能每次翻页都重试');
    fail = false;
    nowMs += 31_000;
    const again = await m.list({ source: 'registry', page: 4, pageSize: 24 });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.stale, true, '刷新完成前仍先返回旧目录');
    assert.equal(again.refreshing, true);
    assert.equal(again.total, 209);
    await waitForRegistryRefresh(m);
    const refreshed = await m.list({ source: 'registry', page: 4, pageSize: 24 });
    assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
    assert.equal(refreshed.stale, undefined);
    assert.equal(refreshed.cached, true);
    assert.equal(refreshed.total, 209);
    assert.equal(refreshed.page, 4);
    assert.equal(calls, 7, '退避结束后重新完整拉取三页');
  });

  await checkAsync('C2·完整目录落盘缓存：新实例一小时内不再请求 Registry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-reg-cache-'));
    const fetchPages = async (url) => jsonResponse(BIG_REGISTRY_PAGES(new URL(url).searchParams.get('cursor') || ''));
    const first = createMcpMarketRaw({
      dataDir: dir, configStore: store, env, lookupImpl, registryCache: true,
      requestImpl: fetchPages,
    });
    const r1 = await first.list({ source: 'registry' });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.total, 209);
    assert.equal(r1.cached, false);
    const cacheFile = path.join(dir, 'mcp-registry-catalog.json.gz');
    assert.ok(fs.existsSync(cacheFile), '成功抓取后必须写磁盘缓存');
    assert.ok(fs.statSync(cacheFile).size > 0);

    let calls = 0;
    const second = createMcpMarketRaw({
      dataDir: dir, configStore: store, env, lookupImpl, registryCache: true,
      requestImpl: async () => { calls += 1; throw new Error('must not fetch'); },
    });
    await second.warmRegistryCatalog();
    assert.equal(calls, 0, '启动预取命中新鲜磁盘缓存时只读盘');
    assert.equal(second.registryStatus().active, false);
    const r2 = await second.list({ source: 'registry', page: 9 });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.total, 209);
    assert.equal(r2.page, 9);
    assert.equal(r2.items.length, 17);
    assert.equal(r2.cached, true);
    assert.equal(calls, 0, '一小时内命中磁盘缓存，不再请求 Registry');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await checkAsync('C2·损坏 / 未来时间 / 非法条目的磁盘缓存被忽略并重新抓取', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-reg-cache-bad-'));
    const cacheFile = path.join(dir, 'mcp-registry-catalog.json.gz');
    fs.writeFileSync(cacheFile, 'not a gzip file');
    let calls = 0;
    const fetchPages = async (url) => {
      calls += 1;
      return jsonResponse(BIG_REGISTRY_PAGES(new URL(url).searchParams.get('cursor') || ''));
    };
    const m = createMcpMarketRaw({
      dataDir: dir, configStore: store, env, lookupImpl, registryCache: true, requestImpl: fetchPages,
    });
    const r = await m.list({ source: 'registry' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.total, 209);
    assert.equal(calls, 3, '损坏缓存必须重新走网络');

    fs.writeFileSync(cacheFile, zlib.gzipSync(JSON.stringify({
      version: 1, at: Date.now() + 3_600_000, pages: 1, items: [{ id: 'x' }],
    })));
    calls = 0;
    const m2 = createMcpMarketRaw({
      dataDir: dir, configStore: store, env, lookupImpl, registryCache: true, requestImpl: fetchPages,
    });
    const r2 = await m2.list({ source: 'registry' });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(calls, 3, '未来时间 / 非法条目的缓存不可信');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await checkAsync('C2·过期磁盘缓存先返回，后台刷新完成后替换', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-reg-cache-swr-'));
    const t0 = 1700000000000;
    const fetchPages = async (url) => jsonResponse(BIG_REGISTRY_PAGES(new URL(url).searchParams.get('cursor') || ''));
    const first = createMcpMarketRaw({
      dataDir: dir, configStore: store, env, lookupImpl, registryCache: true,
      now: () => t0, requestImpl: fetchPages,
    });
    const r0 = await first.list({ source: 'registry' });
    assert.equal(r0.ok, true, JSON.stringify(r0));
    assert.equal(r0.total, 209);

    let calls = 0;
    const nowMs = t0 + 61 * 60_000;
    const second = createMcpMarketRaw({
      dataDir: dir, configStore: store, env, lookupImpl, registryCache: true,
      now: () => nowMs,
      requestImpl: async () => {
        calls += 1;
        return jsonResponse({ servers: [makeRegistryRow('io.example/fresh')], metadata: {} });
      },
    });
    const stale = await second.list({ source: 'registry' });
    assert.equal(stale.ok, true, JSON.stringify(stale));
    assert.equal(stale.stale, true);
    assert.equal(stale.refreshing, true);
    assert.equal(stale.total, 209, '先返回磁盘里的旧目录');
    await waitForRegistryRefresh(second);
    const fresh = await second.list({ source: 'registry' });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(fresh.stale, undefined);
    assert.equal(fresh.cached, true);
    assert.equal(fresh.total, 1);
    assert.equal(calls, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await checkAsync('C2·加载进度只暴露页数 / 条目数，结束后标记 done', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async (url) => {
        calls += 1;
        if (calls === 1) await gate;
        return jsonResponse(BIG_REGISTRY_PAGES(new URL(url).searchParams.get('cursor') || ''));
      },
    });
    const pending = m.list({ source: 'registry' });
    await new Promise((resolve) => setImmediate(resolve));
    const during = m.registryStatus();
    assert.equal(during.active, true);
    assert.equal(during.done, false);
    assert.equal(during.pages, 0);
    assert.equal(during.items, 0);
    release();
    const r = await pending;
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = m.registryStatus();
    assert.equal(after.active, false);
    assert.equal(after.done, true);
    assert.equal(after.pages, 3);
    assert.equal(after.items, 209);
  });

  await checkAsync('C2·启动预取在后台拉完整目录，不阻塞打开市场', async () => {
    let calls = 0;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async (url) => {
        calls += 1;
        return jsonResponse(BIG_REGISTRY_PAGES(new URL(url).searchParams.get('cursor') || ''));
      },
    });
    const warmed = m.warmRegistryCatalog();
    assert.equal(calls, 0, '预取必须异步开始，不能阻塞调用方');
    await warmed;
    assert.equal(calls, 3);
    const status = m.registryStatus();
    assert.equal(status.done, true);
    assert.equal(status.items, 209);
    const r = await m.list({ source: 'registry', page: 9 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.total, 209);
    assert.equal(r.items.length, 17);
    assert.equal(calls, 3, '预取完成后打开市场不再请求 Registry');
  });

  await checkAsync('C2·启动预取失败不抛错，打开市场时重试', async () => {
    let calls = 0;
    let fail = true;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async (url) => {
        calls += 1;
        if (fail) throw Object.assign(new Error('down'), { marketCode: 'network' });
        return jsonResponse(BIG_REGISTRY_PAGES(new URL(url).searchParams.get('cursor') || ''));
      },
    });
    await m.warmRegistryCatalog();
    assert.equal(calls, 1);
    assert.equal(m.registryStatus().done, true);
    fail = false;
    const r = await m.list({ source: 'registry' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.total, 209);
    assert.equal(calls, 4, '预取失败不能进入退避，打开市场必须重试');
  });

  await checkAsync('C2·边加载边显示：partial 返回已获取条目，完成后换成真实总数', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async (url) => {
        calls += 1;
        const cursor = new URL(url).searchParams.get('cursor') || '';
        /* 卡住第二页：第一页已经进快照，但完整目录还没到手。 */
        if (cursor === 'cursor-2') await gate;
        return jsonResponse(BIG_REGISTRY_PAGES(cursor));
      },
    });
    const initial = await m.list({ source: 'registry', partial: '1' });
    assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.equal(initial.partial, true);
    assert.equal(initial.loading, true);
    assert.equal(initial.items.length, 0);
    assert.equal(initial.total, undefined, 'partial 响应不能带 total');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const midway = await m.list({ source: 'registry', partial: '1', pageSize: 24 });
    assert.equal(midway.ok, true, JSON.stringify(midway));
    assert.equal(midway.partial, true);
    assert.equal(midway.loading, true);
    assert.equal(midway.loaded, 100, '第一页的 100 条应先显示');
    assert.equal(midway.loadedPages, 5);
    assert.equal(midway.items.length, 24);
    assert.equal(midway.total, undefined);
    const searched = await m.list({ source: 'registry', partial: '1', q: 'server-00' });
    assert.equal(searched.partial, true);
    assert.equal(searched.loaded, 10, '搜索也要能在已加载快照上工作');
    assert.equal(searched.items.length, 10);
    release();
    await waitForRegistryRefresh(m);
    const done = await m.list({ source: 'registry', partial: '1', pageSize: 24 });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.partial, undefined, '完整目录到手后不再返回 partial');
    assert.equal(done.total, 209);
    assert.equal(done.totalPages, 9);
    assert.equal(calls, 3);
  });

  await checkAsync('C2·partial 失败后明确报错，retry=1 重新开始抓取', async () => {
    let calls = 0;
    let fail = true;
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async (url) => {
        calls += 1;
        if (fail) throw Object.assign(new Error('down'), { marketCode: 'network' });
        return jsonResponse(BIG_REGISTRY_PAGES(new URL(url).searchParams.get('cursor') || ''));
      },
    });
    const started = await m.list({ source: 'registry', partial: '1' });
    assert.equal(started.ok, true, '第一次请求只是启动抓取');
    assert.equal(started.partial, true);
    await waitForRegistryRefresh(m);
    const failed = await m.list({ source: 'registry', partial: '1' });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'network');
    assert.equal(calls, 1, '失败后轮询不能反复重启抓取');
    fail = false;
    const retried = await m.list({ source: 'registry', partial: '1', retry: '1' });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(retried.partial, true);
    assert.equal(retried.loading, true);
    await waitForRegistryRefresh(m);
    const full = await m.list({ source: 'registry' });
    assert.equal(full.ok, true, JSON.stringify(full));
    assert.equal(full.total, 209);
    assert.equal(calls, 4);
  });

  await checkAsync('C2·完整目录守卫：1200 页 / 100000 条 / 600 秒明确报错', async () => {
    let pageCalls = 0;
    const tooManyPages = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => {
        pageCalls += 1;
        return jsonResponse({
          servers: [makeRegistryRow(`io.example/page-${pageCalls}`)],
          metadata: { nextCursor: `cursor-${pageCalls}` },
        });
      },
    });
    const pagesResult = await tooManyPages.list({ source: 'registry' });
    assert.equal(pagesResult.ok, false);
    assert.equal(pagesResult.code, 'registry-too-large');
    assert.equal(pageCalls, 1_200, '超过 1200 页必须停止请求');

    /* 每页 1000 条最小形状（约 50KB），101 页后越过 100000 条上限。 */
    let entryCalls = 0;
    const tooManyEntries = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      requestImpl: async () => {
        entryCalls += 1;
        const rows = Array.from({ length: 1_000 }, (_, i) => ({
          server: { name: `io.example/e${entryCalls}-${i}`, version: '1.0.0' },
        }));
        return jsonResponse({ servers: rows, metadata: { count: rows.length, nextCursor: `cursor-${entryCalls}` } });
      },
    });
    const entriesResult = await tooManyEntries.list({ source: 'registry' });
    assert.equal(entriesResult.ok, false);
    assert.equal(entriesResult.code, 'registry-too-large');
    assert.equal(entryCalls, 101, '超过 100000 条必须在当前页停止');

    let nowMs = 1_700_000_000_000;
    let timeoutCalls = 0;
    const timedOut = createMcpMarket({
      dataDir: DATA, configStore: store, env, lookupImpl,
      now: () => nowMs,
      requestImpl: async () => {
        timeoutCalls += 1;
        nowMs += 600_001;
        return jsonResponse({ servers: [makeRegistryRow('io.example/slow')], metadata: { nextCursor: 'next-page' } });
      },
    });
    const timeoutResult = await timedOut.list({ source: 'registry' });
    assert.equal(timeoutResult.ok, false);
    assert.equal(timeoutResult.code, 'timeout');
    assert.equal(timeoutCalls, 1, '总时限耗尽后不能再请求下一页');
  });

  section('D. 第三方市场源');
  await checkAsync('D·添加源：拉取、过滤非法条目、持久化', async () => {
    const r = await market.addSource({ url: 'https://market.example/servers.json' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.count, 1, '只保留 npx 且无明文凭据的 hello');
    const file = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));
    assert.equal(file.sources.length, 1);
    assert.equal(file.sources[0].url, 'https://market.example/servers.json');
    assert.ok(file.sources[0].id.startsWith('src-'));
    const sources = market.sources();
    assert.equal(sources.custom.length, 1);
  });
  await checkAsync('D·列出自定义源 / 安装', async () => {
    const src = market.sources().custom[0];
    const listing = await market.list({ source: `custom:${src.id}` });
    assert.equal(listing.ok, true, JSON.stringify(listing));
    assert.equal(listing.items.length, 1);
    const item = listing.items[0];
    assert.equal(item.name, 'Hello');
    assert.equal(item.trust, 'community');
    assert.match(item.trustEvidence, /未审核安全性/);
    const r = await market.install({
      source: item.source, catalogId: item.catalogId, scope: 'user',
      expectedRevision: store.revisions().user,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const saved = JSON.parse(fs.readFileSync(userFile, 'utf8')).mcpServers.hello;
    assert.deepEqual(saved.args, ['-y', 'hello-mcp']);
    assert.equal(saved.env.HELLO_TOKEN, '${HELLO_TOKEN}');
  });
  await checkAsync('D·重复源 / 非 JSON 源 / 无可用条目被拒', async () => {
    const dup = await market.addSource({ url: 'https://market.example/servers.json' });
    assert.equal(dup.code, 'source-exists');
    const bad = await market.addSource({ url: 'https://market.example/bad.json' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'invalid-source');
    const text = await market.addSource({ url: 'https://market.example/text' });
    assert.equal(text.ok, false);
    assert.equal(text.code, 'invalid-content-type');
  });
  await checkAsync('D·删除源', async () => {
    const src = market.sources().custom[0];
    const r = await market.removeSource({ id: src.id });
    assert.equal(r.ok, true);
    assert.equal(market.sources().custom.length, 0);
  });

  section('E. SSRF / 响应体边界');
  await checkAsync('E·http / localhost / 私网 IP 被拒', async () => {
    for (const url of [
      'http://market.example/mcp.json', 'https://127.0.0.1/x', 'https://10.0.0.5/x',
      'https://localhost/x', 'https://[::1]/x',
      'https://[::ffff:7f00:1]/x', 'https://[::ffff:0:7f00:1]/x',
      'https://[64:ff9b::7f00:1]/x', 'https://[2002:7f00:1::]/x',
    ]) {
      const r = await market.addSource({ url });
      assert.equal(r.ok, false, url);
      assert.ok(['blocked-url', 'blocked-host'].includes(r.code), `${url} -> ${r.code}`);
    }
  });
  await checkAsync('E·DNS 解析到内网被拒', async () => {
    const m = createMcpMarket({
      dataDir: DATA, configStore: store, env,
      requestImpl, lookupImpl: async () => [{ address: '192.168.1.9', family: 4 }],
    });
    const r = await m.addSource({ url: 'https://market.example/servers.json' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'blocked-host');
  });
  await checkAsync('E·超大响应 / 错误 content-type / 网络异常', async () => {
    const big = await market.addSource({ url: 'https://market.example/big' });
    assert.equal(big.ok, false);
    assert.equal(big.code, 'too-large');
    const redir = await market.addSource({ url: 'https://market.example/redirect' });
    assert.equal(redir.ok, false);
    assert.equal(redir.code, 'redirect-blocked');
  });
  check('E·isPrivateIp 覆盖 IPv4 / IPv6 边界', () => {
    const { isPrivateIp } = market._internals;
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '224.0.0.1',
      '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1',
      '2001:1::1', '3fff::1', '100::1',
      '::ffff:192.168.0.1', '::ffff:7f00:1', '::ffff:0:7f00:1',
      '64:ff9b::7f00:1', '2002:7f00:1::',
    ]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '2002:0808:0808::1']) {
      assert.equal(isPrivateIp(ip), false, ip);
    }
  });
  check('E·远端非法状态码不会让 Response 构造抛穿', () => {
    const { pinnedResponse } = market._internals;
    assert.equal(pinnedResponse(600, null, {}).status, 502);
    assert.equal(pinnedResponse(0, null, {}).status, 502);
    assert.equal(pinnedResponse(204, Buffer.from('x'), {}).status, 204);
    assert.equal(pinnedResponse(205, Buffer.from('x'), {}).status, 205);
    assert.equal(pinnedResponse(200, 'ok', {}).status, 200);
  });
  await checkAsync('E·市场源 URL 查询串里的凭据被拒绝且不落盘', async () => {
    const before = fs.existsSync(sourcesFile) ? fs.readFileSync(sourcesFile, 'utf8') : null;
    const r = await market.addSource({ url: 'https://market.example/servers.json?token=abc' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'blocked-url');
    assert.equal(fs.existsSync(sourcesFile) ? fs.readFileSync(sourcesFile, 'utf8') : null, before);
  });

  section('G. DNS 固定 / 代理 / 重定向边界');
  const fetchJson = market._internals.fetchJson;
  await checkAsync('G·DNS 只解析一次，连接目标使用已校验地址', async () => {
    let lookups = 0;
    const seen = [];
    const r = await fetchJson('https://market.example/x', {
      env: {},
      lookupImpl: async () => {
        lookups += 1;
        return lookups === 1
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }];
      },
      requestImpl: async (url, opts) => {
        seen.push(opts);
        return jsonResponse({ ok: true });
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(lookups, 1, '只允许解析一次；第二次解析就是 rebinding 窗口');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].address, '93.184.216.34');
    assert.equal(seen[0].hostname, 'market.example', 'TLS 仍按原域名校验');
  });
  await checkAsync('G·双栈地址逐个尝试，全部来自已校验列表', async () => {
    const attempts = [];
    const r = await fetchJson('https://market.example/x', {
      env: {},
      lookupImpl: async () => [
        { address: '2606:4700::1111', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ],
      requestImpl: async (url, opts) => {
        attempts.push(opts);
        if (opts.family === 6) throw Object.assign(new Error('unreachable'), { code: 'ENETUNREACH' });
        return jsonResponse({ ok: 1 });
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((a) => a.address), ['2606:4700::1111', '93.184.216.34']);
  });
  await checkAsync('G·重定向被拒绝且不发起第二次请求', async () => {
    let calls = 0;
    const r = await fetchJson('https://market.example/x', {
      env: {},
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'redirect-blocked');
    assert.equal(calls, 1);
  });
  await checkAsync('G·无代理桥时环境代理 fail closed，不假装已完成地址校验', async () => {
    let calls = 0;
    const r = await fetchJson('https://market.example/x', {
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: async () => { calls += 1; return jsonResponse({}); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'proxy-unsupported');
    assert.equal(r.network.route, 'unsupported');
    assert.equal(calls, 0);
  });
  await checkAsync('G·NO_PROXY 命中目标域名时走直连并固定 IP', async () => {
    const seen = [];
    const r = await fetchJson('https://market.example/x', {
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '.example' },
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: async (url, opts) => { seen.push(opts); return jsonResponse({ ok: 1 }); },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(seen[0].address, '93.184.216.34');
  });
  await checkAsync('G·无代理桥时 fake-IP 代理网段明确拒绝', async () => {
    let calls = 0;
    const r = await fetchJson('https://market.example/x', {
      env: {},
      lookupImpl: async () => [{ address: '198.18.4.17', family: 4 }],
      requestImpl: async () => { calls += 1; return jsonResponse({}); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'proxy-blocked');
    assert.match(r.error, /fake-IP/);
    assert.equal(calls, 0);
  });
  await checkAsync('G·系统代理线路交给可信代理栈，不冒充固定 IP 校验', async () => {
    const proxied = [];
    let directCalls = 0;
    const r = await fetchJson('https://market.example/x', {
      env: {},
      network: {
        resolveRoute: async () => 'proxied',
        fetchProxied: async (url, opts) => {
          proxied.push({ url, opts });
          return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: 1 }) };
        },
      },
      lookupImpl: async () => [{ address: '198.18.4.17', family: 4 }],
      requestImpl: async () => { directCalls += 1; return jsonResponse({}); },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(directCalls, 0, '代理线路不能偷偷走直连');
    assert.equal(proxied.length, 1);
    assert.equal(proxied[0].url, 'https://market.example/x');
    assert.deepEqual(r.network, {
      route: 'proxied', source: 'system-proxy', addressVerified: false, dns: 'proxy', fakeIp: true,
    });
  });
  await checkAsync('G·桌面直连 + TUN fake-IP 仍固定地址并按原域名校验证书', async () => {
    const seen = [];
    const r = await fetchJson('https://market.example/x', {
      env: {},
      network: { resolveRoute: async () => 'direct', fetchProxied: async () => { throw new Error('must not proxy'); } },
      lookupImpl: async () => [{ address: '198.18.4.17', family: 4 }],
      requestImpl: async (url, opts) => { seen.push(opts); return jsonResponse({ ok: 1 }); },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].address, '198.18.4.17', 'TUN fake-IP 仍必须被固定');
    assert.equal(seen[0].hostname, 'market.example', 'TLS / Host 仍使用原域名');
    assert.deepEqual(r.network, {
      route: 'direct', source: 'system-proxy', addressVerified: true, dns: 'local', fakeIp: true,
    });
  });
  await checkAsync('G·线路 unknown 一律 fail closed：不解析 DNS、不直连、不放行 fake-IP', async () => {
    let calls = 0;
    let lookups = 0;
    const r = await fetchJson('https://market.example/x', {
      env: {},
      network: { resolveRoute: async () => 'unknown', fetchProxied: async () => { calls += 1; } },
      lookupImpl: async () => { lookups += 1; return [{ address: '198.18.4.17', family: 4 }]; },
      requestImpl: async () => { calls += 1; return jsonResponse({}); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'proxy-blocked');
    assert.equal(r.network.route, 'unknown');
    assert.equal(r.network.addressVerified, false, 'unknown 不能标记为已验证');
    assert.equal(r.network.dns, 'none', 'unknown 不应发起 DNS');
    assert.equal(lookups, 0, 'unknown 必须在 DNS 之前拒绝');
    assert.equal(calls, 0);
    const halfBridge = await fetchJson('https://market.example/x', {
      env: {},
      network: { resolveRoute: async () => 'direct' },
      lookupImpl: async () => { lookups += 1; return [{ address: '198.18.4.17', family: 4 }]; },
      requestImpl: async () => { calls += 1; return jsonResponse({}); },
    });
    assert.equal(halfBridge.code, 'proxy-unsupported', '缺少代理取数能力时不能回退直连');
    assert.equal(halfBridge.network.route, 'unsupported');
    assert.equal(halfBridge.network.addressVerified, false);
    assert.equal(lookups, 0);
    assert.equal(calls, 0);
  });
  await checkAsync('G·空 / 非法 / 异常代理解析结果统一按 unknown 拒绝', async () => {
    for (const value of ['', 'DIRECT', 'weird', null, undefined]) {
      let lookups = 0;
      let requests = 0;
      const r = await fetchJson('https://market.example/x', {
        env: {},
        network: { resolveRoute: async () => value, fetchProxied: async () => { requests += 1; } },
        lookupImpl: async () => { lookups += 1; return [{ address: '93.184.216.34', family: 4 }]; },
        requestImpl: async () => { requests += 1; return jsonResponse({}); },
      });
      assert.equal(r.ok, false, String(value));
      assert.equal(r.code, 'proxy-blocked', String(value));
      assert.equal(r.network.route, 'unknown', String(value));
      assert.equal(r.network.addressVerified, false, String(value));
      assert.equal(r.network.dns, 'none', String(value));
      assert.equal(lookups, 0, String(value));
      assert.equal(requests, 0, String(value));
    }
    let lookups = 0;
    let requests = 0;
    const thrown = await fetchJson('https://market.example/x', {
      env: {},
      network: {
        resolveRoute: async () => { throw Object.assign(new Error('resolve timeout'), { marketCode: 'timeout' }); },
        fetchProxied: async () => { requests += 1; },
      },
      lookupImpl: async () => { lookups += 1; return [{ address: '93.184.216.34', family: 4 }]; },
      requestImpl: async () => { requests += 1; return jsonResponse({}); },
    });
    assert.equal(thrown.code, 'proxy-blocked');
    assert.equal(thrown.network.route, 'unknown');
    assert.equal(thrown.network.addressVerified, false);
    assert.equal(lookups, 0);
    assert.equal(requests, 0);
  });
  await checkAsync('G·混合代理线路 PROXY; DIRECT / DIRECT; PROXY 不降级直连', async () => {
    for (const raw of ['PROXY proxy:7890; DIRECT', 'DIRECT; PROXY proxy:7890']) {
      let lookups = 0;
      let requests = 0;
      const r = await fetchJson('https://market.example/x', {
        env: {},
        network: {
          resolveRoute: async () => classifyProxyRoute(raw),
          fetchProxied: async () => { requests += 1; },
        },
        lookupImpl: async () => { lookups += 1; return [{ address: '93.184.216.34', family: 4 }]; },
        requestImpl: async () => { requests += 1; return jsonResponse({}); },
      });
      assert.equal(r.ok, false, raw);
      assert.equal(r.code, 'proxy-blocked', raw);
      assert.equal(r.network.route, 'unknown', raw);
      assert.equal(r.network.addressVerified, false, raw);
      assert.equal(lookups, 0, raw);
      assert.equal(requests, 0, raw);
    }
  });
  await checkAsync('G·环境变量代理与系统 DIRECT 冲突时拒绝，不解析 DNS / 不直连', async () => {
    const secret = 'http://user:pass@127.0.0.1:7890';
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
      let lookups = 0;
      let requests = 0;
      const r = await fetchJson('https://market.example/x', {
        env: { [key]: secret },
        network: { resolveRoute: async () => 'direct', fetchProxied: async () => { requests += 1; } },
        lookupImpl: async () => { lookups += 1; return [{ address: '93.184.216.34', family: 4 }]; },
        requestImpl: async () => { requests += 1; return jsonResponse({}); },
      });
      assert.equal(r.ok, false, key);
      assert.equal(r.code, 'proxy-blocked', key);
      assert.equal(r.network.route, 'unknown', key);
      assert.equal(r.network.source, 'env-proxy', key);
      assert.equal(r.network.addressVerified, false, key);
      assert.equal(r.network.dns, 'none', key);
      assert.equal(lookups, 0, key);
      assert.equal(requests, 0, key);
      const serialized = JSON.stringify(r);
      assert.ok(!serialized.includes('127.0.0.1'), key);
      assert.ok(!serialized.includes('user'), key);
      assert.ok(!serialized.includes('pass'), key);
    }
  });
  await checkAsync('G·环境变量代理 + 已验证系统代理线路时仍走桥', async () => {
    let proxied = 0;
    let requests = 0;
    const r = await fetchJson('https://market.example/x', {
      env: { HTTPS_PROXY: 'http://user:pass@127.0.0.1:7890' },
      network: {
        resolveRoute: async () => 'proxied',
        fetchProxied: async () => {
          proxied += 1;
          return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":1}' };
        },
      },
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: async () => { requests += 1; return jsonResponse({}); },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(proxied, 1);
    assert.equal(requests, 0, '有环境变量代理时不能偷偷直连');
    assert.equal(r.network.route, 'proxied');
    assert.equal(r.network.addressVerified, false);
    assert.equal(r.network.dns, 'proxy');
  });
  await checkAsync('G·NO_PROXY 优先于系统代理判定，但仍做完整地址校验', async () => {
    const seen = [];
    const network = { resolveRoute: async () => 'proxied', fetchProxied: async () => { throw new Error('must not proxy'); } };
    const r = await fetchJson('https://market.example/x', {
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '.example' },
      network,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: async (url, opts) => { seen.push(opts); return jsonResponse({ ok: 1 }); },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(seen[0].address, '93.184.216.34');
    assert.equal(r.network.route, 'direct');
    assert.equal(r.network.source, 'no-proxy');
    const privateR = await fetchJson('https://market.example/x', {
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '.example' },
      network,
      lookupImpl: async () => [{ address: '192.168.1.9', family: 4 }],
      requestImpl: async () => jsonResponse({}),
    });
    assert.equal(privateR.ok, false);
    assert.equal(privateR.code, 'blocked-host', 'NO_PROXY 不能绕过地址安全检查');
  });
  await checkAsync('G·代理线路仍拒绝内网 URL 字面量', async () => {
    let calls = 0;
    const r = await fetchJson('https://10.0.0.5/x', {
      env: {},
      network: { resolveRoute: async () => 'proxied', fetchProxied: async () => { calls += 1; } },
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'blocked-host');
    assert.equal(calls, 0);
  });
  await checkAsync('G·代理失败映射为稳定错误且不回显代理地址 / 凭据', async () => {
    const cases = [
      ['proxy-auth-required', 'proxy-auth-required'],
      ['proxy-unreachable', 'proxy-unreachable'],
      ['tls-failed', 'tls-failed'],
      ['dns-failed', 'dns-failed'],
      ['timeout', 'timeout'],
      ['network', 'network'],
      ['blocked-route', 'proxy-blocked'],
    ];
    for (const [marketCode, expected] of cases) {
      const secret = 'http://user:pass@127.0.0.1:7890';
      const r = await fetchJson('https://market.example/x', {
        env: {},
        network: {
          resolveRoute: async () => 'proxied',
          fetchProxied: async () => { throw Object.assign(new Error(`failed via ${secret}`), { marketCode }); },
        },
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      });
      assert.equal(r.ok, false, marketCode);
      assert.equal(r.code, expected, marketCode);
      assert.equal(r.network.route, 'proxied');
      assert.equal(r.network.addressVerified, false);
      assert.ok(!r.error.includes('127.0.0.1'), marketCode);
      assert.ok(!r.error.includes('user'), marketCode);
      assert.ok(!r.error.includes('pass'), marketCode);
    }
  });
  await checkAsync('G·代理响应的重定向 / 大小 / content-type 边界仍然生效', async () => {
    const base = {
      env: {},
      network: { resolveRoute: async () => 'proxied' },
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    };
    const redir = await fetchJson('https://market.example/x', {
      ...base,
      network: { resolveRoute: async () => 'proxied', fetchProxied: async () => ({ ok: true, status: 302, headers: { location: 'https://evil.example/' }, body: '' }) },
    });
    assert.equal(redir.code, 'redirect-blocked');
    const text = await fetchJson('https://market.example/x', {
      ...base,
      network: { resolveRoute: async () => 'proxied', fetchProxied: async () => ({ ok: true, status: 200, headers: { 'content-type': 'text/plain' }, body: 'x' }) },
    });
    assert.equal(text.code, 'invalid-content-type');
    const big = await fetchJson('https://market.example/x', {
      ...base,
      maxBytes: 8,
      network: { resolveRoute: async () => 'proxied', fetchProxied: async () => ({ ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"long":"body"}' }) },
    });
    assert.equal(big.code, 'too-large');
    const auth = await fetchJson('https://market.example/x', {
      ...base,
      network: { resolveRoute: async () => 'proxied', fetchProxied: async () => ({ ok: true, status: 407, headers: {}, body: '' }) },
    });
    assert.equal(auth.code, 'proxy-auth-required');
  });
  await checkAsync('G·Registry 完整目录与第三方源也能走代理线路', async () => {
    const proxied = createMcpMarket({
      dataDir: DATA,
      configStore: store,
      env: {},
      lookupImpl: async () => [{ address: '198.18.4.17', family: 4 }],
      network: {
        resolveRoute: async () => 'proxied',
        fetchProxied: async (url) => {
          const u = new URL(url);
          if (u.hostname === 'registry.modelcontextprotocol.io') {
            return {
              ok: true, status: 200, headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ servers: [REGISTRY_ROW], metadata: { count: 1 } }),
            };
          }
          return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(CUSTOM_SOURCE) };
        },
      },
    });
    const registry = await proxied.list({ source: 'registry', q: 'test', limit: 12 });
    assert.equal(registry.ok, true, JSON.stringify(registry));
    assert.equal(registry.items.length, 1);
    assert.equal(registry.items[0].identifier, 'io.example/test-server');
    assert.equal(registry.network.route, 'proxied');
    const added = await proxied.addSource({ url: 'https://market.example/servers.json' });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.network.route, 'proxied');
    const custom = await proxied.list({ source: `custom:${added.source.id}`, limit: 12 });
    assert.equal(custom.ok, true, JSON.stringify(custom));
    assert.ok(custom.items.length >= 1);
    assert.equal(custom.network.route, 'proxied');
    const removed = await proxied.removeSource({ id: added.source.id });
    assert.equal(removed.ok, true);
  });
  check('G·连接参数保留 hostname / SNI，lookup 只返回固定 IP', () => {
    const opts = market._internals.pinnedRequestOptions(
      new URL('https://market.example:443/path?q=1'), '93.184.216.34', 4, { accept: 'application/json' },
    );
    assert.equal(opts.hostname, 'market.example');
    assert.equal(opts.servername, 'market.example');
    assert.equal(opts.agent, false);
    assert.equal(opts.rejectUnauthorized, true);
    assert.equal(opts.path, '/path?q=1');
    assert.equal(opts.headers.host, 'market.example');
    let all;
    opts.lookup('market.example', { all: true }, (err, rows) => { assert.equal(err, null); all = rows; });
    assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);
    let one;
    opts.lookup('market.example', {}, (err, address, family) => { assert.equal(err, null); one = { address, family }; });
    assert.deepEqual(one, { address: '93.184.216.34', family: 4 });
    const v6 = market._internals.pinnedRequestOptions(new URL('https://[2606:4700::1111]/x'), '2606:4700::1111', 6);
    assert.equal(v6.hostname, '2606:4700::1111');
    assert.equal(v6.servername, undefined, 'IP 字面量不能作为 TLS ServerName');
  });

  section('H. Registry schema 适配（参数 / 环境变量 / 远程模板）');
  const { buildRegistryConfig } = market._internals;
  const RICH = {
    name: 'io.example/weather', title: 'Weather', description: 'Weather tools', version: '1.2.3',
    packages: [{
      registryType: 'npm', identifier: '@acme/weather-mcp', version: '1.2.3', runtimeHint: 'npx',
      transport: { type: 'stdio' },
      runtimeArguments: [{ type: 'named', name: '--yes' }],
      packageArguments: [
        { type: 'positional', valueHint: 'city', isRequired: true, description: 'City name' },
        { type: 'named', name: '--units', value: '{unit}', variables: { unit: { default: 'metric', choices: ['metric', 'imperial'] } } },
        { type: 'named', name: '--region', valueHint: 'region' },
      ],
      environmentVariables: [
        { name: 'WEATHER_KEY', isRequired: true, isSecret: true, description: 'API key' },
        { name: 'WEATHER_REGION', isRequired: true, description: 'Region' },
        { name: 'WEATHER_HOME', default: 'C:/data' },
      ],
    }],
  };
  await checkAsync('H·npm 参数模板、必填值、环境变量与命令预览', async () => {
    const item = market._internals.normalizeRegistryEntry({ server: RICH, _meta: {} });
    assert.equal(item.installable, true, JSON.stringify(item));
    assert.match(item.commandSummary, /--yes/);
    assert.match(item.commandSummary, /--units=metric/);
    assert.match(item.commandSummary, /<City name>/);
    assert.deepEqual(item.fields.map((f) => f.key), ['arg0', 'arg2']);
    assert.ok(item.envFields.some((f) => f.key === 'env.WEATHER_KEY' && f.secret === true && f.default === 'WEATHER_KEY'));
    assert.deepEqual(item.requiredEnvKeys, ['WEATHER_KEY']);
    const built = buildRegistryConfig(RICH, { arg0: 'Paris', arg2: 'eu', 'env.WEATHER_REGION': 'eu' });
    assert.equal(built.ok, true, JSON.stringify(built));
    assert.deepEqual(built.config.args, ['--yes', '@acme/weather-mcp@1.2.3', 'Paris', '--units=metric', '--region=eu']);
    assert.deepEqual(built.config.env, {
      WEATHER_HOME: 'C:/data', WEATHER_KEY: '${WEATHER_KEY}', WEATHER_REGION: 'eu',
    });
    assert.ok(built.commandPreview.includes('Paris'));
  });
  await checkAsync('H·可选 named 参数留空时整项省略，不生成空值开关', async () => {
    for (const values of [
      { arg0: 'Paris', 'env.WEATHER_REGION': 'eu' },
      { arg0: 'Paris', arg2: '   ', 'env.WEATHER_REGION': 'eu' },
    ]) {
      const built = buildRegistryConfig(RICH, values);
      assert.equal(built.ok, true, JSON.stringify(built));
      assert.deepEqual(built.config.args, ['--yes', '@acme/weather-mcp@1.2.3', 'Paris', '--units=metric']);
      assert.ok(!built.commandPreview.includes('--region='), built.commandPreview);
    }
  });
  await checkAsync('H·缺少必填参数 / 凭据型参数 / 不支持的 runtime 被拒', async () => {
    const missing = buildRegistryConfig(RICH, {});
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'missing-field');
    const secretArg = { ...RICH, packages: [{ ...RICH.packages[0], packageArguments: [{ type: 'named', name: '--api-key', valueHint: 'key', isRequired: true }] }] };
    const sec = market._internals.normalizeRegistryEntry({ server: secretArg, _meta: {} });
    assert.equal(sec.installable, false);
    assert.match(sec.installReason, /凭据/);
    const badRuntime = { ...RICH, packages: [{ ...RICH.packages[0], runtimeHint: 'docker' }] };
    const rt = market._internals.normalizeRegistryEntry({ server: badRuntime, _meta: {} });
    assert.equal(rt.installable, false);
    const registryFlag = { ...RICH, packages: [{ ...RICH.packages[0], runtimeArguments: [{ type: 'named', name: '--registry', value: 'https://evil.example' }] }] };
    const rf = market._internals.normalizeRegistryEntry({ server: registryFlag, _meta: {} });
    assert.equal(rf.installable, false, 'runtimeArguments 不能改写包来源');
    assert.match(rf.installReason, /包来源|不支持/);
    const shellFlag = { ...RICH, packages: [{ ...RICH.packages[0], runtimeArguments: [{ type: 'positional', value: '-c' }] }] };
    assert.equal(market._internals.normalizeRegistryEntry({ server: shellFlag, _meta: {} }).installable, false);
    const runtimeField = { ...RICH, packages: [{ ...RICH.packages[0], runtimeArguments: [{ type: 'positional', valueHint: 'extra' }] }] };
    const injected = buildRegistryConfig(runtimeField, { rt0: '--registry=https://evil.example', arg0: 'Paris', 'env.WEATHER_REGION': 'eu' });
    assert.equal(injected.ok, false, '用户填写的 runtime 参数也不能改写包来源');
    assert.equal(injected.code, 'unsupported');
  });
  await checkAsync('H·远程 URL 变量、请求头引用与 SSE / 敏感变量边界', async () => {
    const remote = {
      name: 'io.example/remote', title: 'Remote', description: 'r', version: '2.0.0',
      remotes: [{
        type: 'streamable-http',
        url: 'https://api.example.com/{tenant}/mcp?region={region}',
        variables: { tenant: { isRequired: true, description: 'Tenant' }, region: { default: 'eu', choices: ['eu', 'us'] } },
        headers: [
          { name: 'Authorization', isRequired: true, isSecret: true },
          { name: 'X-Tenant', value: '{tenant}', variables: { tenant: { value: 'fixed' } } },
        ],
      }],
    };
    const item = market._internals.normalizeRegistryEntry({ server: remote, _meta: {} });
    assert.equal(item.installable, true, JSON.stringify(item));
    assert.match(item.urlPreview, /<Tenant>/);
    assert.equal(item.headerFields[0].secret, true);
    const built = buildRegistryConfig(remote, { 'url.tenant': 'acme', 'header.Authorization': 'REMOTE_TOKEN' });
    assert.equal(built.ok, true, JSON.stringify(built));
    assert.equal(built.config.url, 'https://api.example.com/acme/mcp?region=eu');
    assert.deepEqual(built.config.headers, { 'X-Tenant': 'fixed', Authorization: '${REMOTE_TOKEN}' });
    const sse = { ...remote, remotes: [{ type: 'sse', url: 'https://api.example.com/sse' }] };
    assert.equal(market._internals.normalizeRegistryEntry({ server: sse, _meta: {} }).installable, false);
    const secretUrlVar = { ...remote, remotes: [{ ...remote.remotes[0], variables: { tenant: { isRequired: true, isSecret: true } } }] };
    assert.equal(market._internals.normalizeRegistryEntry({ server: secretUrlVar, _meta: {} }).installable, false);
    const secretQuery = { ...remote, remotes: [{ type: 'streamable-http', url: 'https://api.example.com/mcp?api_key=sk-live-123456' }] };
    const q = market._internals.normalizeRegistryEntry({ server: secretQuery, _meta: {} });
    assert.equal(q.installable, false, '静态 URL 里的凭据必须标为不可安装');
    assert.match(q.installReason, /凭据/);
    const dynamicSecret = buildRegistryConfig(remote, { 'url.tenant': 'sk-live-1234567890', 'header.Authorization': 'REMOTE_TOKEN' });
    assert.equal(dynamicSecret.ok, false);
    assert.equal(dynamicSecret.code, 'bad-url', '用户填进 URL 的凭据形态值也必须拒绝');
  });

  section('F. 目录数据校验');
  check('F·内置条目占位符必须是完整参数', () => {
    for (const e of market._internals.BUILTIN) {
      for (const a of e.args || []) {
        if (/^\{[^}]+\}$/.test(a)) continue;
        assert.ok(!/^\{/.test(a) || !/\}$/.test(a), `${e.id} 的占位符必须独占一个参数`);
      }
    }
  });
  check('F·Registry 描述被限长，HTML 不当结构', () => {
    const item = market._internals.normalizeRegistryEntry({ server: { name: 'x/y', title: '<b>x</b>', description: '<script>alert(1)</script>', version: '1.0.0' }, _meta: {} });
    assert.ok(item.description.length <= 400);
  });

  console.log(`\n${count} assertions passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
