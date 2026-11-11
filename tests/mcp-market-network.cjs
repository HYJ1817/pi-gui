/* MCP 市场网络策略与 Electron 代理桥的纯单元测试。
 *
 * 不联网、不启动 Electron：DNS、session、IPC 全部注入假实现。
 * 这里覆盖两类最容易分叉的判定：
 *   1. `lib/market-network-policy.cjs` —— 后端 / 主进程 / 测试共用的唯一策略；
 *   2. `electron/market-network.cjs` 与 `server/market-network.js` —— 两侧的
 *      帧校验、固定请求头、超时 / 大小 / 错误码收敛与凭据脱敏。
 */
const assert = require('node:assert/strict');

const {
  blockedHostname, classifyAddress, classifyProxyRoute, hostnameOf,
  isAcceptableResolvedAddress, isFakeIpAddress, isPrivateIp,
} = require('../lib/market-network-policy.cjs');
const {
  createMarketNetworkBridge, parseMarketUrl, classifyFetchError, readBoundedBody,
} = require('../electron/market-network.cjs');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const checkAsync = async (name, fn) => { await fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

(async () => {
  const { createParentMarketNetwork } = await import('../server/market-network.js');

  section('A. 代理线路分类');
  check('A·DIRECT / 单代理 / 代理链 / 混合列表', () => {
    assert.equal(classifyProxyRoute('DIRECT'), 'direct');
    assert.equal(classifyProxyRoute('PROXY 127.0.0.1:7890'), 'proxied');
    assert.equal(classifyProxyRoute('SOCKS5 127.0.0.1:1080'), 'proxied');
    assert.equal(classifyProxyRoute('HTTPS proxy.example:443'), 'proxied');
    assert.equal(classifyProxyRoute('HTTP proxy.example:8080; SOCKS5 proxy.example:1080'), 'proxied');
    assert.equal(classifyProxyRoute('PROXY a:1; DIRECT'), 'unknown', '有 DIRECT 回退就不能声称一定走代理');
    assert.equal(classifyProxyRoute('DIRECT; PROXY a:1'), 'unknown');
  });
  check('A·空 / 非法 / 未知类型一律 unknown（fail closed）', () => {
    for (const value of ['', '   ', ';', null, undefined, 42, {}, 'QUIC a:1', 'PROXY', 'PROXY a:1; BOGUS b:2']) {
      assert.equal(classifyProxyRoute(value), 'unknown', String(value));
    }
  });

  section('B. 地址分类与线路可接受性');
  check('B·公网 / 私网 / 回环 / 链路本地 / 保留 / fake-IP', () => {
    assert.equal(classifyAddress('93.184.216.34'), 'public');
    assert.equal(classifyAddress('8.8.8.8'), 'public');
    assert.equal(classifyAddress('2606:4700::1111'), 'public');
    assert.equal(classifyAddress('198.18.4.17'), 'benchmark');
    assert.equal(classifyAddress('198.19.255.255'), 'benchmark');
    assert.equal(classifyAddress('2001:2::1'), 'benchmark');
    assert.equal(classifyAddress('2001:2:1::1'), 'reserved', 'fake-IP 只到 2001:2::/48，不能放宽到整个 /32');
    assert.equal(classifyAddress('10.0.0.1'), 'private');
    assert.equal(classifyAddress('172.16.0.1'), 'private');
    assert.equal(classifyAddress('192.168.1.1'), 'private');
    assert.equal(classifyAddress('127.0.0.1'), 'loopback');
    assert.equal(classifyAddress('::1'), 'loopback');
    assert.equal(classifyAddress('169.254.1.1'), 'link-local');
    assert.equal(classifyAddress('fe80::1'), 'link-local');
    assert.equal(classifyAddress('fc00::1'), 'ula');
    assert.equal(classifyAddress('fec0::1'), 'site-local');
    assert.equal(classifyAddress('ff02::1'), 'multicast');
    assert.equal(classifyAddress('100.64.0.1'), 'cgnat');
    assert.equal(classifyAddress('240.0.0.1'), 'reserved');
    assert.equal(classifyAddress('2001:db8::1'), 'documentation');
    assert.equal(classifyAddress('not-an-ip'), 'invalid');
  });
  check('B·IPv4 嵌入 IPv6 的写法不能藏住内网地址', () => {
    for (const ip of [
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:0:7f00:1',
      '64:ff9b::7f00:1', '2002:7f00:1::',
    ]) {
      assert.notEqual(classifyAddress(ip), 'public', ip);
    }
    assert.equal(classifyAddress('::ffff:93.184.216.34'), 'public');
    assert.equal(classifyAddress('2002:0808:0808::1'), 'public');
  });
  check('B·fake-IP 只在代理线路或显式允许的直连线路上可接受', () => {
    assert.equal(isAcceptableResolvedAddress('public', 'direct'), true);
    assert.equal(isAcceptableResolvedAddress('public', 'unknown'), true);
    assert.equal(isAcceptableResolvedAddress('benchmark', 'proxied'), true);
    assert.equal(isAcceptableResolvedAddress('benchmark', 'direct'), false);
    assert.equal(isAcceptableResolvedAddress('benchmark', 'direct', { allowFakeIp: true }), true);
    assert.equal(isAcceptableResolvedAddress('benchmark', 'unknown', { allowFakeIp: true }), false);
    for (const kind of ['private', 'loopback', 'link-local', 'ula', 'site-local', 'reserved', 'documentation', 'multicast', 'cgnat', 'invalid']) {
      assert.equal(isAcceptableResolvedAddress(kind, 'proxied'), false, kind);
      assert.equal(isAcceptableResolvedAddress(kind, 'direct', { allowFakeIp: true }), false, kind);
    }
  });
  check('B·isPrivateIp 保留旧的严格含义（含 fake-IP）', () => {
    assert.equal(isPrivateIp('198.18.4.17'), true);
    assert.equal(isPrivateIp('93.184.216.34'), false);
    assert.equal(isFakeIpAddress('198.18.4.17'), true);
    assert.equal(isFakeIpAddress('2001:2::1'), true);
    assert.equal(isFakeIpAddress('93.184.216.34'), false);
  });
  check('B·本机主机名与 URL hostname 规范化', () => {
    assert.equal(blockedHostname('localhost'), true);
    assert.equal(blockedHostname('foo.localhost'), true);
    assert.equal(blockedHostname('printer.local'), true);
    assert.equal(blockedHostname('metadata.internal'), true);
    assert.equal(blockedHostname('market.example'), false);
    assert.equal(blockedHostname('localhost.'), true);
    assert.equal(hostnameOf(new URL('https://[2606:4700::1111]/x')), '2606:4700::1111');
    assert.equal(hostnameOf(new URL('https://Market.Example/x')), 'market.example');
    assert.equal(hostnameOf(new URL('https://Market.Example./x')), 'market.example');
  });

  section('C. Electron 主进程桥：URL 与帧校验');
  check('C·只接受 HTTPS:443、无凭据、非本机 / 非内网 IP 字面量', () => {
    assert.ok(parseMarketUrl('https://market.example/x?q=1'));
    assert.equal(parseMarketUrl('http://market.example/x'), null);
    assert.equal(parseMarketUrl('https://user:pass@market.example/x'), null);
    assert.equal(parseMarketUrl('https://market.example:8443/x'), null);
    assert.equal(parseMarketUrl('https://localhost/x'), null);
    assert.equal(parseMarketUrl('https://127.0.0.1/x'), null);
    assert.equal(parseMarketUrl('https://10.0.0.1/x'), null);
    assert.equal(parseMarketUrl('https://198.18.4.17/x'), null, 'URL 字面量不能借 fake-IP 放行');
    assert.ok(parseMarketUrl('https://93.184.216.34/x'));
    assert.equal(parseMarketUrl('x'.repeat(3000)), null);
  });
  await checkAsync('C·非法帧返回 null / 稳定错误码，不抛穿', async () => {
    const session = { resolveProxy: async () => 'DIRECT', fetch: async () => jsonResponse({}) };
    const bridge = createMarketNetworkBridge({ session });
    assert.equal(await bridge.handle(null), null);
    assert.equal(await bridge.handle({ type: 'other', id: 1 }), null);
    assert.equal((await bridge.handle({ type: 'mcp-market-network', id: 1, action: 'nope', url: 'https://market.example/x' })).code, 'bad-action');
    assert.equal((await bridge.handle({ type: 'mcp-market-network', id: 2, action: 'fetch', url: 'http://market.example/x' })).code, 'blocked-url');
    assert.equal((await bridge.handle({ type: 'mcp-market-network', id: 3, action: 'resolve-route', url: 'https://127.0.0.1/x' })).code, 'blocked-url');
    bridge.dispose();
  });

  section('D. Electron 主进程桥：代理线路取数');
  await checkAsync('D·resolve-route 只回 direct / proxied / unknown', async () => {
    const session = { resolveProxy: async () => 'PROXY 127.0.0.1:7890', fetch: async () => jsonResponse({}) };
    const bridge = createMarketNetworkBridge({ session });
    const r = await bridge.handle({ type: 'mcp-market-network', id: 1, action: 'resolve-route', url: 'https://market.example/x' });
    assert.deepEqual(r, { type: 'mcp-market-network-result', id: 1, ok: true, route: 'proxied' });
    for (const raw of ['PROXY 127.0.0.1:7890; DIRECT', 'DIRECT; PROXY 127.0.0.1:7890', '', 'QUIC 127.0.0.1:7890']) {
      session.resolveProxy = async () => raw;
      const mixed = await bridge.handle({ type: 'mcp-market-network', id: 2, action: 'resolve-route', url: 'https://market.example/x' });
      assert.equal(mixed.route, 'unknown', raw);
    }
    session.resolveProxy = async () => { throw new Error('boom'); };
    const unknown = await bridge.handle({ type: 'mcp-market-network', id: 2, action: 'resolve-route', url: 'https://market.example/x' });
    assert.equal(unknown.route, 'unknown');
    bridge.dispose();
  });
  await checkAsync('D·代理线路 fetch：固定 GET / 不跟随重定向 / 不带凭据', async () => {
    const seen = [];
    const session = {
      resolveProxy: async () => 'SOCKS5 127.0.0.1:1080',
      fetch: async (url, opts) => { seen.push({ url, opts }); return jsonResponse({ ok: true }); },
    };
    const bridge = createMarketNetworkBridge({ session });
    const r = await bridge.handle({ type: 'mcp-market-network', id: 9, action: 'fetch', url: 'https://market.example/x', timeoutMs: 1000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"ok":true}');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].opts.method, 'GET');
    assert.equal(seen[0].opts.redirect, 'manual');
    assert.equal(seen[0].opts.credentials, 'omit');
    assert.equal(seen[0].opts.cache, 'no-store');
    assert.equal(seen[0].opts.headers.accept, 'application/json');
    assert.ok(seen[0].opts.signal, '必须有超时信号');
    bridge.dispose();
  });
  await checkAsync('D·请求前线路变成 DIRECT / unknown 时拒绝，不让桥变成通用取数器', async () => {
    let fetched = 0;
    const session = {
      resolveProxy: async () => 'DIRECT',
      fetch: async () => { fetched += 1; return jsonResponse({}); },
    };
    const bridge = createMarketNetworkBridge({ session });
    const r = await bridge.handle({ type: 'mcp-market-network', id: 1, action: 'fetch', url: 'https://market.example/x' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'blocked-route');
    assert.equal(fetched, 0);
    session.resolveProxy = async () => 'PROXY a:1; DIRECT';
    const mixed = await bridge.handle({ type: 'mcp-market-network', id: 2, action: 'fetch', url: 'https://market.example/x' });
    assert.equal(mixed.code, 'blocked-route');
    assert.equal(fetched, 0);
    bridge.dispose();
  });
  await checkAsync('D·407 / 代理错误 / 证书 / DNS 错误映射为稳定 code', async () => {
    const cases = [
      [() => new Response(null, { status: 407 }), 'proxy-auth-required'],
      [() => { throw new Error('ERR_PROXY_CONNECTION_FAILED'); }, 'proxy-unreachable'],
      [() => { throw new Error('ERR_TUNNEL_CONNECTION_FAILED'); }, 'proxy-unreachable'],
      [() => { throw new Error('ERR_CERT_AUTHORITY_INVALID'); }, 'tls-failed'],
      [() => { throw new Error('ERR_NAME_NOT_RESOLVED'); }, 'dns-failed'],
      [() => { throw new Error('some other failure'); }, 'network'],
    ];
    for (const [impl, expected] of cases) {
      const session = { resolveProxy: async () => 'PROXY a:1', fetch: async () => impl() };
      const bridge = createMarketNetworkBridge({ session });
      const r = await bridge.handle({ type: 'mcp-market-network', id: 1, action: 'fetch', url: 'https://market.example/x', timeoutMs: 1000 });
      assert.equal(r.ok, false, expected);
      assert.equal(r.code, expected);
      bridge.dispose();
    }
    assert.equal(classifyFetchError(Object.assign(new Error('x'), { name: 'AbortError' })), 'timeout');
  });
  await checkAsync('D·超时 / 声明大小 / 流式大小都收敛到固定 code', async () => {
    const timeoutSession = {
      resolveProxy: async () => 'PROXY a:1',
      fetch: async (url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    };
    const timeoutBridge = createMarketNetworkBridge({ session: timeoutSession });
    const timed = await timeoutBridge.handle({ type: 'mcp-market-network', id: 1, action: 'fetch', url: 'https://market.example/x', timeoutMs: 20 });
    assert.equal(timed.code, 'timeout');
    timeoutBridge.dispose();

    const declared = new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '999999' } });
    const declaredSession = { resolveProxy: async () => 'PROXY a:1', fetch: async () => declared };
    const declaredBridge = createMarketNetworkBridge({ session: declaredSession });
    const tooLarge = await declaredBridge.handle({ type: 'mcp-market-network', id: 1, action: 'fetch', url: 'https://market.example/x', maxBytes: 1024 });
    assert.equal(tooLarge.code, 'too-large');
    declaredBridge.dispose();

    const streamSession = { resolveProxy: async () => 'PROXY a:1', fetch: async () => new Response('x'.repeat(2048), { status: 200, headers: { 'content-type': 'application/json' } }) };
    const streamBridge = createMarketNetworkBridge({ session: streamSession });
    const streamed = await streamBridge.handle({ type: 'mcp-market-network', id: 1, action: 'fetch', url: 'https://market.example/x', maxBytes: 1024 });
    assert.equal(streamed.code, 'too-large');
    streamBridge.dispose();
  });
  await checkAsync('D·错误结果不携带代理地址 / 认证信息 / 原始 Chromium 错误', async () => {
    const secret = 'http://user:pass@127.0.0.1:7890';
    const session = {
      resolveProxy: async () => 'PROXY 127.0.0.1:7890',
      fetch: async () => { throw new Error(`ERR_PROXY_CONNECTION_FAILED ${secret}`); },
    };
    const bridge = createMarketNetworkBridge({ session });
    const r = await bridge.handle({ type: 'mcp-market-network', id: 1, action: 'fetch', url: 'https://market.example/x' });
    const text = JSON.stringify(r);
    assert.equal(r.code, 'proxy-unreachable');
    assert.ok(!text.includes('127.0.0.1'));
    assert.ok(!text.includes('user'));
    assert.ok(!text.includes('pass'));
    bridge.dispose();
  });
  await checkAsync('C·readBoundedBody 直接处理无 body 的响应', async () => {
    const response = new Response('ok', { status: 200 });
    assert.equal(await readBoundedBody(response, 1024), 'ok');
  });

  section('E. 后端 IPC 客户端');
  const makeBus = () => {
    const sent = [];
    const listeners = new Map();
    let autoReply = null;
    const send = (message, cb) => {
      sent.push(message);
      if (typeof cb === 'function') setImmediate(() => cb(null));
      if (autoReply) {
        setImmediate(() => {
          const reply = autoReply(message);
          if (reply) listeners.get('message')?.(reply);
        });
      }
    };
    const on = (event, fn) => { listeners.set(event, fn); };
    const off = (event, fn) => { if (listeners.get(event) === fn) listeners.delete(event); };
    return { sent, listeners, send, on, off, setAutoReply: (fn) => { autoReply = fn; } };
  };
  await checkAsync('E·resolve-route / fetch 走同一组请求帧，响应只取固定字段', async () => {
    const bus = makeBus();
    bus.setAutoReply((message) => (message.action === 'resolve-route'
      ? { type: 'mcp-market-network-result', id: message.id, ok: true, route: 'proxied' }
      : { type: 'mcp-market-network-result', id: message.id, ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":1}' }));
    const network = createParentMarketNetwork({ send: bus.send, on: bus.on, off: bus.off, routeTimeoutMs: 50 });
    assert.equal(await network.resolveRoute('https://market.example/x'), 'proxied');
    const fetched = await network.fetchProxied('https://market.example/x', { timeoutMs: 1000, maxBytes: 1024 });
    assert.deepEqual(fetched, { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":1}' });
    assert.equal(bus.sent[0].type, 'mcp-market-network');
    assert.equal(bus.sent[0].action, 'resolve-route');
    assert.equal(bus.sent[1].action, 'fetch');
    assert.equal(bus.sent[1].maxBytes, 1024);
    network.dispose();
  });
  await checkAsync('E·超时 / dispose 都收敛为稳定 code', async () => {
    const bus = makeBus();
    const network = createParentMarketNetwork({ send: bus.send, on: bus.on, off: bus.off, routeTimeoutMs: 20 });
    await assert.rejects(() => network.resolveRoute('https://market.example/x'), (err) => err.marketCode === 'timeout');
    const pending = network.fetchProxied('https://market.example/x', { timeoutMs: 5000 });
    network.dispose();
    await assert.rejects(() => pending, (err) => err.marketCode === 'unavailable');
    assert.equal(bus.listeners.has('message'), false, 'dispose 必须摘掉监听器');
  });
  check('E·没有父进程 IPC 时返回 null', () => {
    assert.equal(createParentMarketNetwork({ send: null, on: null, off: null }), null);
  });

  console.log(`\n${count} 条 MCP 市场网络断言全部通过`);
})().catch((err) => {
  console.error('\nMCP 市场网络测试失败：');
  console.error(err);
  process.exit(1);
});
