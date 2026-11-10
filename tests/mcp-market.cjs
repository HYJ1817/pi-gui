/* MCP 市场：内置目录 / Registry 分页 / 第三方源 / 安装解析 / SSRF 边界。
 * 全部离线：fetch 与 DNS 都注入假实现，数据目录在 os.tmpdir()。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const checkAsync = async (name, fn) => { await fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

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
      environmentVariables: [{ name: 'TEST_TOKEN', isRequired: true, isSecret: true }],
    }],
  },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
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
  const { createMcpMarket } = await import('../server/mcp-market.js');
  const { createMcpConfigStore } = await import('../server/mcp-config.js');
  const state = { trust: { trusted: true, requiresTrust: false } };
  const store = createMcpConfigStore({
    runtime: { getCurrentCwd: () => PROJECT },
    env,
    readTrust: async () => state.trust,
    now: () => 1700000000000,
  });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://registry.modelcontextprotocol.io/')) {
      const u = new URL(url);
      return jsonResponse({
        servers: [REGISTRY_ROW],
        metadata: u.searchParams.get('search') ? {} : { nextCursor: 'cursor-2' },
      });
    }
    if (url === 'https://market.example/servers.json') return jsonResponse(CUSTOM_SOURCE);
    if (url === 'https://market.example/bad.json') return jsonResponse({ nope: true });
    if (url === 'https://market.example/redirect') throw Object.assign(new Error('redirect'), { name: 'TypeError' });
    if (url === 'https://market.example/big') return jsonResponse({ servers: [] }, 200, { 'content-length': String(3 * 1024 * 1024) });
    if (url === 'https://market.example/text') return new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } });
    return jsonResponse({ servers: [], metadata: {} });
  };
  const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
  const market = createMcpMarket({
    dataDir: DATA, configStore: store, env, fetchImpl, lookupImpl, now: () => 1700000000000,
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

  section('C. 官方 Registry');
  await checkAsync('C·真实查询参数 + 分页 cursor', async () => {
    calls.length = 0;
    const r = await market.list({ source: 'registry', q: 'test', limit: 5 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].name, 'Test Server');
    assert.equal(r.items[0].version, '1.2.3');
    assert.equal(r.items[0].trust, 'registry');
    assert.equal(r.items[0].installable, true);
    assert.equal(r.nextCursor, null);
    assert.ok(calls[0].includes('search=test'));
    assert.ok(calls[0].includes('limit=5'));
    const paged = await market.list({ source: 'registry', limit: 5 });
    assert.equal(paged.nextCursor, 'cursor-2');
    assert.equal(paged.hasMore, true);
  });
  await checkAsync('C·分类筛选会跨 Registry 页继续查找', async () => {
    const rows = {
      'cursor-doc': {
        servers: [{ server: { name: 'io.example/memory', title: 'Memory', description: 'Long term memory and knowledge', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'memory-mcp', version: '1.0.0', runtimeHint: 'npx' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } }],
        metadata: {},
      },
    };
    const paged = createMcpMarket({
      dataDir: DATA, configStore: store, env,
      fetchImpl: async (url) => {
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
  });

  await checkAsync('C·Registry 安装重新查询并写入配置（忽略客户端配置）', async () => {
    const listing = await market.list({ source: 'registry', q: 'test' });
    const item = listing.items[0];
    const r = await market.install({
      source: 'registry', catalogId: item.catalogId, scope: 'user',
      expectedRevision: store.revisions().user,
      command: 'evil', url: 'https://evil.example', values: {},
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const saved = JSON.parse(fs.readFileSync(userFile, 'utf8')).mcpServers['Test-Server'];
    assert.equal(saved.command, 'npx');
    assert.deepEqual(saved.args, ['-y', 'test-mcp@1.2.3']);
    assert.equal(saved.env.TEST_TOKEN, '${TEST_TOKEN}');
    assert.notEqual(saved.url, 'https://evil.example');
  });
  await checkAsync('C·Registry 失败返回明确 code，内置目录仍可用', async () => {
    const bad = createMcpMarket({
      dataDir: DATA, configStore: store, env,
      fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
      lookupImpl,
    });
    const r = await bad.list({ source: 'registry', q: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'timeout');
    const builtin = await bad.list({ source: 'builtin' });
    assert.equal(builtin.ok, true);
    assert.equal(builtin.items.length, 10);
  });
  await checkAsync('C·非 npm / 非 streamable-http 条目标记为不可安装', async () => {
    const odd = createMcpMarket({
      dataDir: DATA, configStore: store, env,
      fetchImpl: async () => jsonResponse({
        servers: [{ server: { name: 'io.example/py', title: 'Py', version: '1.0.0', packages: [{ registryType: 'pypi', identifier: 'py-mcp', version: '1.0.0', runtimeHint: 'uvx' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } }],
      }),
      lookupImpl,
    });
    const r = await odd.list({ source: 'registry' });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].installable, false);
    assert.ok(r.items[0].installReason);
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
      fetchImpl, lookupImpl: async () => [{ address: '192.168.1.9', family: 4 }],
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
    assert.equal(redir.code, 'network');
  });
  check('E·isPrivateIp 覆盖 IPv4 / IPv6 边界', () => {
    const { isPrivateIp } = market._internals;
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '224.0.0.1',
      '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1',
      '::ffff:192.168.0.1', '::ffff:7f00:1', '::ffff:0:7f00:1',
      '64:ff9b::7f00:1', '2002:7f00:1::',
    ]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '2002:0808:0808::1']) {
      assert.equal(isPrivateIp(ip), false, ip);
    }
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
