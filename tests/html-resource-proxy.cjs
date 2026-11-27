'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { PNG, GIF, JPEG, WEBP, resourceNetwork, resource, image } = require('./fixtures/html-resource-network.cjs');
const api = import('../server/html-resource-preparer.js');
const uri = (bytes = PNG, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
const safeCode = code => error => {
  assert.equal(error.code, code); assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(JSON.stringify(error) + error.stack, /UPSTREAM_SECRET|QUERY_SECRET|COOKIE_SECRET/);
  return true;
};
async function fixture(responses, config) {
  const network = resourceNetwork(responses, config);
  const { createHtmlResourcePreparer } = await api;
  return { network, prepare: createHtmlResourcePreparer(network.options).prepare };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('self-contained HTML remains exactly unchanged with no network, even offline or behind a proxy', async () => {
  const { createHtmlResourcePreparer } = await api;
  let calls = 0;
  const forbidden = () => { calls++; throw Error('unexpected network'); };
  const { prepare } = createHtmlResourcePreparer({
    env: { PI_GUI_OFFLINE: '1', PI_OFFLINE: '1', HTTPS_PROXY: 'https://proxy.example', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    lookupImpl: forbidden, requestImpl: forbidden, networkInterfaces: forbidden,
  });
  const html = '<style>p{color:red}</style><p>原样 &amp; offline</p><script>"https://unlisted.example/a.png"</script>';
  assert.equal(await prepare(html), html);
  assert.equal(await prepare(html, []), html);
  assert.equal(calls, 0);
});

for (const key of ['PI_GUI_OFFLINE', 'PI_OFFLINE', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'ALL_PROXY', 'PI_GUI_SYSTEM_PROXY', 'NODE_USE_ENV_PROXY']) {
  test(`${key} refuses declared resources before DNS or HTTPS`, async () => {
    const network = resourceNetwork();
    network.options.env[key] = key.includes('OFFLINE') || key === 'NODE_USE_ENV_PROXY' ? '1' : 'https://proxy.example';
    const { prepare } = (await api).createHtmlResourcePreparer(network.options);
    await assert.rejects(prepare(image(resource().url), [resource()]), safeCode(key.includes('OFFLINE') ? 'html_resource_offline' : 'html_resource_proxy'));
    assert.equal(network.requests.length, 0); assert.equal(network.lookups.length, 0);
  });
}

for (const [mime, bytes] of [['image/png', PNG], ['image/jpeg', JPEG], ['image/gif', GIF], ['image/webp', WEBP]]) {
  test(`declared ${mime} becomes an immutable self-contained byte string`, async t => {
    const { prepare, network } = await fixture([{ type: mime, body: bytes }]);
    const html = await prepare(image(resource().url), [resource()]);
    assert.equal(typeof html, 'string'); assert.equal(html, image(uri(bytes, mime)));
    assert.equal(network.requests.length, 1); assert.equal(network.lookups.length, 1);
    assert.deepEqual(network.lookups[0].options, { all: true, verbatim: true });
    const embedded = Buffer.from(html.match(/base64,([^\"]+)/)[1], 'base64');
    assert.deepEqual(embedded, bytes);
    t.diagnostic(`binaryBytes=${bytes.length}; htmlBytes=${Buffer.byteLength(html)}; sha256=${createHash('sha256').update(embedded).digest('hex')}`);
  });
}

test('quoted attributes, URL canonicalization, CSS and HTML ampersand spellings rewrite only whole declared literals', async () => {
  const url = 'https://cdn.example/a.png?a=1&b=2', escaped = url.replace('&', '&amp;');
  const spellings = [url, escaped, url.replace('&', '&#38;'), url.replace('&', '&#x26;'), url.replace('&', '&#X00026;')];
  const html = spellings.map(value => `<img src="${value}">`).join('')
    + `<div style="background:URL('${escaped}')"></div><style>.a{background:url( ${url} )}</style>`
    + '<img src="HTTPS://CDN.EXAMPLE:443/sub/../a.png?a=1&amp;b=2">'
    + '<img src="https://cdn.example/a.png?a=1&b=2&unlisted=1">';
  const { prepare, network } = await fixture();
  const out = await prepare(html, [resource(url)]);
  assert.equal(out.split(uri()).length - 1, 8);
  assert.ok(out.endsWith('<img src="https://cdn.example/a.png?a=1&b=2&unlisted=1">'));
  assert.ok(out.includes(`URL('${uri()}')`));
  assert.ok(out.includes(`url( ${uri()} )`));
  assert.equal(network.requests.length, 1);
});

test('replacement is data-only: markup, scripts, unknown URLs and surrounding bytes are not reparsed', async () => {
  const html = '<script>const s="https://unlisted.example/code.js"; const p="' + resource().url + '";</script>'
    + image(resource().url) + '<img src="https://127.0.0.1/secret"><img src="https://other.example/a.png">';
  const { prepare, network } = await fixture();
  const out = await prepare(html, [resource()]);
  assert.equal(out, html.split(resource().url).join(uri()));
  assert.equal(network.requests.length, 1); assert.equal(network.lookups[0].host, 'cdn.example');
});

for (const [label, html] of [
  ['absent', '<p>No image</p>'], ['URL prefix only', image(resource().url + '?extra=1')],
  ['unquoted HTML attribute', `<img src=${resource().url}>`],
  ['srcset', `<img srcset="${resource().url} 1x, https://other.example/b.png 2x">`],
  ['JS escape', '<script>const a="https:\\/\\/cdn.example/a.png"</script>'],
  ['encoded HTML slash', '<img src="https:&#47;&#47;cdn.example/a.png">'],
]) test(`unsupported authored reference (${label}) fails explicitly without network`, async () => {
  const { prepare, network } = await fixture();
  await assert.rejects(prepare(html, [resource()]), safeCode('html_resource_reference'));
  assert.equal(network.requests.length, 0); assert.equal(network.lookups.length, 0);
});

test('the complete declaration list is validated before any fetch', async () => {
  const { prepare, network } = await fixture();
  for (const declarations of [[resource(), resource('https://127.0.0.1/private')], [{ ...resource(), headers: { cookie: 'COOKIE_SECRET' } }],
    [{ url: 'https://cdn.example/a.woff2', type: 'font' }], Array.from({ length: 9 }, (_, i) => resource(`https://cdn.example/${i}.png`))]) {
    await assert.rejects(prepare(image(resource().url), declarations), error => /^html_resource_/.test(error.code));
  }
  assert.equal(network.requests.length, 0); assert.equal(network.lookups.length, 0);
});

test('eight explicit images are supported and fetched sequentially', async () => {
  const resources = Array.from({ length: 8 }, (_, i) => resource(`https://cdn.example/${i}.png`));
  const { prepare, network } = await fixture();
  assert.equal((await prepare(resources.map(row => image(row.url)).join(''), resources)).split(uri()).length - 1, 8);
  assert.equal(network.requests.length, 8);
});

for (const [label, rows, code = 'html_resource_blocked'] of [
  ['mixed private answer', [{ address: '93.184.215.14', family: 4 }, { address: '10.1.1.1', family: 4 }]],
  ['mixed fake-IP answer', [{ address: '93.184.215.14', family: 4 }, { address: '198.18.1.1', family: 4 }]],
  ['mixed IPv6 loopback', [{ address: '93.184.215.14', family: 4 }, { address: '::1', family: 6 }]],
  ['mapped IPv4 private', [{ address: '::ffff:7f00:1', family: 6 }]],
  ['ULA', [{ address: 'fd00::1', family: 6 }]], ['reserved IPv6', [{ address: '4000::1', family: 6 }]],
  ['documentation', [{ address: '203.0.113.1', family: 4 }]], ['fake-IP only', [{ address: '198.18.1.1', family: 4 }]],
  ['mismatched family', [{ address: '127.0.0.1', family: 6 }]],
  ['invalid address', [{ address: '93.184.215.14\n', family: 4 }]],
  ['DNS decimal address', [{ address: '2130706433', family: 4 }]],
  ['non-numeric family', [{ address: '93.184.215.14', family: 'IPv4' }]],
  ['empty DNS', [], 'html_resource_dns'], ['wrong DNS shape', { address: '93.184.215.14', family: 4 }, 'html_resource_dns'],
  ['DNS capacity', Array.from({ length: 65 }, () => ({ address: '93.184.215.14', family: 4 })), 'html_resource_dns'],
]) test(`DNS refuses ${label} before any connection`, async () => {
  const { prepare, network } = await fixture([], { lookup: async () => rows });
  await assert.rejects(prepare(image(resource().url), [resource()]), safeCode(code));
  assert.equal(network.requests.length, 0);
});

test('every address is vetted, then the actual TLS lookup stays pinned despite rebinding', async () => {
  const { prepare, network } = await fixture([], { lookup: async (_host, _opts, attempt) => attempt === 1
    ? [{ address: '2606:4700:4700::1111', family: 6 }, { address: '93.184.215.14', family: 4 }]
    : [{ address: '127.0.0.1', family: 4 }] });
  await prepare(image(resource().url), [resource()]);
  const request = network.requests[0];
  assert.deepEqual(request.pinned, [{ address: '93.184.215.14', family: 4 }]);
  assert.equal(network.lookups.length, 1);
  request.options.lookup('cdn.example', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '93.184.215.14'); assert.equal(family, 4);
  });
  const options = request.options;
  assert.equal(options.hostname, 'cdn.example'); assert.equal(options.servername, 'cdn.example');
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
  assert.equal(options.autoSelectFamily, false); assert.equal(options.maxHeaderSize, 8192);
  assert.equal(options.method, 'GET'); assert.equal(options.port, 443); assert.equal(options.protocol, 'https:');
  assert.equal(options.headers.host, 'cdn.example'); assert.equal(options.headers['accept-encoding'], 'identity');
  for (const key of ['auth', 'ca', 'checkServerIdentity', 'createConnection', 'body', 'socketPath']) assert.equal(options[key], undefined);
  assert.equal(Object.keys(options.headers).some(key => /cookie|authorization|referer|origin/i.test(key)), false);
});

test('public IPv6 and IPv4 literals have no DNS lookup and retain certificate verification', async () => {
  for (const url of ['https://1.1.1.1/a.png', 'https://[2606:4700:4700::1111]/a.png']) {
    const { prepare, network } = await fixture();
    await prepare(image(url), [resource(url)]);
    assert.equal(network.lookups.length, 0); assert.equal(network.requests.length, 1);
    assert.equal(network.requests[0].options.servername, undefined);
    assert.equal(network.requests[0].options.rejectUnauthorized, true);
  }
});

test('the machine own public addresses are rejected as literals and DNS answers', async () => {
  const publicV4 = '93.184.215.14', publicV6 = '2606:4700:4700::1111';
  for (const address of [publicV4, publicV6]) {
    const { prepare, network } = await fixture([], {
      lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      interfaces: () => ({ fixture: [{ address, family: address.includes(':') ? 'IPv6' : 'IPv4', internal: false }] }),
    });
    await assert.rejects(prepare(image(resource().url), [resource()]), safeCode('html_resource_blocked'));
    const literal = `https://${address.includes(':') ? '[' + address + ']' : address}/a.png`;
    await assert.rejects(prepare(image(literal), [resource(literal)]), safeCode('html_resource_blocked'));
    assert.equal(network.requests.length, 0);
  }
});

test('failed DNS and interface inspection are controlled and do not disclose upstream errors', async () => {
  const { prepare, network } = await fixture([], { lookup: () => { throw Error('UPSTREAM_SECRET'); } });
  await assert.rejects(prepare(image(resource().url), [resource()]), safeCode('html_resource_dns'));
  assert.equal(network.requests.length, 0);
  const second = await fixture([], { interfaces: () => { throw Error('UPSTREAM_SECRET'); } });
  await assert.rejects(second.prepare(image(resource().url), [resource()]), safeCode('html_resource_blocked'));
  assert.equal(second.network.requests.length, 0);
});

test('redirects revalidate HTTPS, all DNS addresses and host-bound TLS options on every hop', async () => {
  const { prepare, network } = await fixture([
    { status: 302, headers: { location: 'https://other.example/next.png?x=1' } },
    { status: 307, headers: { location: '/final.png' } }, {},
  ]);
  assert.equal(await prepare(image(resource().url), [resource()]), image(uri()));
  assert.deepEqual(network.lookups.map(row => row.host), ['cdn.example', 'other.example', 'other.example']);
  assert.deepEqual(network.requests.map(row => row.options.path), ['/a.png', '/next.png?x=1', '/final.png']);
  assert.deepEqual(network.requests.map(row => row.options.servername), ['cdn.example', 'other.example', 'other.example']);
  assert.ok(network.requests.slice(0, 2).every(row => row.destroyed && row.response.destroyed));
});

for (const [label, location, code] of [
  ['downgrade', 'http://other.example/a.png', 'html_resource_url'],
  ['private literal', 'https://10.1.1.1/a.png', 'html_resource_blocked'],
  ['decimal loopback', 'https://2130706433/a.png', 'html_resource_blocked'],
  ['mapped IPv6', 'https://[::ffff:7f00:1]/a.png', 'html_resource_blocked'],
  ['userinfo', 'https://name:{{PASSWORD_oorlegan}}@other.example/a.png', 'html_resource_url'],
  ['port', 'https://other.example:8443/a.png', 'html_resource_url'],
  ['file scheme', 'file:///a.png', 'html_resource_url'],
  ['control', 'https://other.example/a\n.png', 'html_resource_response'],
  ['space', ' https://other.example/a.png', 'html_resource_redirect'],
  ['backslash', 'https://other.example\\x/a.png', 'html_resource_redirect'],
  ['empty Location', '', 'html_resource_redirect'],
  ['missing Location', undefined, 'html_resource_redirect'],
]) test(`redirect refuses ${label} without another request`, async () => {
  const { prepare, network } = await fixture([{ status: 302, headers: { location } }]);
  await assert.rejects(prepare(image(resource().url), [resource()]), safeCode(code));
  assert.equal(network.requests.length, 1); assert.equal(network.lookups.length, 1);
});

test('a redirect to an all-or-partly private DNS answer never connects', async () => {
  const { prepare, network } = await fixture([{ status: 302, headers: { location: '/next.png' } }], {
    lookup: async (_host, _opts, attempt) => attempt === 1 ? [{ address: '93.184.215.14', family: 4 }]
      : [{ address: '93.184.215.14', family: 4 }, { address: '127.0.0.1', family: 4 }],
  });
  await assert.rejects(prepare(image(resource().url), [resource()]), safeCode('html_resource_blocked'));
  assert.equal(network.lookups.length, 2); assert.equal(network.requests.length, 1);
});

test('redirect cycles and redirect count exhaustion are bounded', async () => {
  for (const responses of [
    [{ status: 302, headers: { location: '/next.png' } }, { status: 302, headers: { location: '/a.png' } }],
    Array.from({ length: 3 }, (_, i) => ({ status: 302, headers: { location: `/${i}.png` } })),
  ]) {
    const { prepare, network } = await fixture(responses);
    await assert.rejects(prepare(image(resource().url), [resource()]), safeCode('html_resource_redirect'));
    assert.ok(network.requests.length <= 3);
  }
});

for (const [label, response, code] of [
  ['HTTP denial', { status: 403 }, 'html_resource_response'],
  ['auth challenge', { status: 401, headers: { 'www-authenticate': 'COOKIE_SECRET' } }, 'html_resource_response'],
  ['proxy challenge', { status: 407 }, 'html_resource_response'],
  ['missing type', { type: undefined }, 'html_resource_type'],
  ['HTML type', { type: 'text/html' }, 'html_resource_type'],
  ['SVG type', { type: 'image/svg+xml' }, 'html_resource_type'],
  ['type prefix confusion', { type: 'image/pngevil' }, 'html_resource_type'],
  ['duplicate type', { type: ['image/png', 'text/html'] }, 'html_resource_response'],
  ['SVG disguised as PNG', { body: Buffer.from('<svg onload="UPSTREAM_SECRET"/>') }, 'html_resource_type'],
  ['HTML disguised as PNG', { body: Buffer.from('<!doctype html><script>UPSTREAM_SECRET</script>') }, 'html_resource_type'],
  ['magic mismatch', { type: 'image/jpeg' }, 'html_resource_type'],
  ['gzip', { headers: { 'content-encoding': 'gzip' } }, 'html_resource_encoding'],
  ['br', { headers: { 'content-encoding': 'br' } }, 'html_resource_encoding'],
  ['unknown encoding', { headers: { 'content-encoding': 'UPSTREAM_SECRET' } }, 'html_resource_encoding'],
  ['huge Content-Length', { headers: { 'content-length': '524289' } }, 'html_resource_too_large'],
  ['malformed Content-Length', { headers: { 'content-length': '4x' } }, 'html_resource_response'],
  ['duplicate Content-Length', { headers: { 'content-length': ['68', '1'] } }, 'html_resource_response'],
  ['truncated Content-Length', { headers: { 'content-length': String(PNG.length + 1) } }, 'html_resource_network'],
  ['aborted response', { abortResponse: true }, 'html_resource_network'],
  ['incomplete response', { complete: false }, 'html_resource_network'],
  ['early close', { prematureClose: true }, 'html_resource_network'],
  ['response error', { responseError: Error('UPSTREAM_SECRET') }, 'html_resource_network'],
  ['request error', { error: Error('UPSTREAM_SECRET') }, 'html_resource_network'],
  ['synchronous request error', { throw: Error('UPSTREAM_SECRET') }, 'html_resource_network'],
]) test(`resource failure ${label} is explicit, bounded and sanitized`, async () => {
  const { prepare } = await fixture([response]);
  await assert.rejects(prepare(image(resource().url), [resource()]), safeCode(code));
});

test('identity encoding and exact Content-Length are accepted', async () => {
  const { prepare } = await fixture([{ headers: { 'content-encoding': 'IDENTITY', 'content-length': String(PNG.length) } }]);
  assert.equal(await prepare(image(resource().url), [resource()]), image(uri()));
});

test('chunked and declared per-resource overflow destroy the response', async () => {
  for (const response of [{ chunks: [PNG.subarray(0, 20), PNG.subarray(20)] }, { headers: { 'content-length': String(PNG.length) } }]) {
    const network = resourceNetwork([response]);
    const { prepare } = (await api).createHtmlResourcePreparer({ ...network.options, limits: { resourceBytes: PNG.length - 1 } });
    await assert.rejects(prepare(image(resource().url), [resource()]), safeCode('html_resource_too_large'));
    assert.equal(network.requests[0].destroyed, true); assert.equal(network.requests[0].response.destroyed, true);
  }
});

test('aggregate raw resource and repeated-inline HTML byte amplification are bounded', async () => {
  const network = resourceNetwork();
  let { prepare } = (await api).createHtmlResourcePreparer({ ...network.options, limits: { totalResourceBytes: PNG.length * 2 - 1 } });
  const resources = [resource(), resource('https://cdn.example/b.png')];
  await assert.rejects(prepare(resources.map(row => image(row.url)).join(''), resources), safeCode('html_resource_too_large'));
  assert.equal(network.requests.length, 2);
  const repeated = resourceNetwork();
  ({ prepare } = (await api).createHtmlResourcePreparer({ ...repeated.options, limits: { htmlBytes: 1500 } }));
  await assert.rejects(prepare(image(resource().url).repeat(30), [resource()]), safeCode('html_resource_too_large'));
  assert.equal(repeated.requests.length, 1);
});

test('HTML byte limit includes UTF-8 and base64 overhead, and its exact boundary succeeds', async () => {
  const html = '中文' + image(resource().url), expected = '中文' + image(uri());
  for (const delta of [0, -1]) {
    const network = resourceNetwork();
    const { prepare } = (await api).createHtmlResourcePreparer({ ...network.options, limits: { htmlBytes: Buffer.byteLength(expected) + delta } });
    if (!delta) assert.equal(await prepare(html, [resource()]), expected);
    else await assert.rejects(prepare(html, [resource()]), safeCode('html_resource_too_large'));
  }
  const { prepare, network } = await fixture();
  await assert.rejects(prepare('x'.repeat(2 * 1024 * 1024 + 1)), safeCode('html_resource_too_large'));
  await assert.rejects(prepare(''), safeCode('html_resource_invalid'));
  assert.equal(network.requests.length, 0);
});

for (const stage of ['DNS', 'headers', 'body']) test(`cancellation during ${stage} promptly rejects and prevents late publication`, { timeout: 1000 }, async () => {
  let releaseDns;
  const network = resourceNetwork([stage === 'headers' ? { holdResponse: true, lateError: Error('UPSTREAM_SECRET') } : { holdBody: true }],
    stage === 'DNS' ? { lookup: () => new Promise(resolve => { releaseDns = resolve; }) } : undefined);
  const { prepare } = (await api).createHtmlResourcePreparer(network.options), controller = new AbortController();
  const requested = stage === 'DNS' ? null : once(network.events, 'request');
  const pending = prepare(image(resource().url), [resource()], { signal: controller.signal });
  if (requested) { await requested; await tick(); } else await tick();
  controller.abort(Error('QUERY_SECRET'));
  await assert.rejects(pending, safeCode('html_resource_cancelled'));
  releaseDns?.([{ address: '93.184.215.14', family: 4 }]);
  await tick();
  if (stage === 'DNS') assert.equal(network.requests.length, 0);
  else assert.equal(network.requests[0].destroyed, true);
});

test('already-aborted callers never perform DNS or HTTPS and cannot leak their reason', async () => {
  const { prepare, network } = await fixture(), controller = new AbortController();
  controller.abort(Error('QUERY_SECRET'));
  await assert.rejects(prepare(image(resource().url), [resource()], { signal: controller.signal }), safeCode('html_resource_cancelled'));
  assert.equal(network.lookups.length, 0); assert.equal(network.requests.length, 0);
});

for (const [label, limits, responses, lookup] of [
  ['DNS deadline', { resourceTimeoutMs: 15 }, [], () => new Promise(() => {})],
  ['resource headers deadline', { resourceTimeoutMs: 15 }, [{ holdResponse: true }]],
  ['resource body deadline', { resourceTimeoutMs: 15 }, [{ holdBody: true }]],
  ['whole operation deadline', { totalTimeoutMs: 15, resourceTimeoutMs: 100 }, [{ holdBody: true }]],
]) test(`${label} terminates without waiting for cooperative network code`, { timeout: 1000 }, async () => {
  const network = resourceNetwork(responses, { lookup });
  const { prepare } = (await api).createHtmlResourcePreparer({ ...network.options, limits });
  await assert.rejects(prepare(image(resource().url), [resource()]), safeCode('html_resource_timeout'));
  assert.ok(network.requests.every(request => request.destroyed));
});

test('admission bounds concurrent resource preparations and releases on success', { timeout: 1000 }, async () => {
  const network = resourceNetwork(Array.from({ length: 4 }, () => ({ holdResponse: true })));
  const { prepare } = (await api).createHtmlResourcePreparer(network.options);
  const pending = Array.from({ length: 4 }, () => prepare(image(resource().url), [resource()]));
  await tick();
  assert.equal(network.requests.length, 4);
  await assert.rejects(prepare(image(resource().url), [resource()]), safeCode('html_resource_busy'));
  assert.equal(network.lookups.length, 4);
  for (const request of network.requests) request.deliver();
  assert.deepEqual(await Promise.all(pending), Array(4).fill(image(uri())));
  assert.equal(await prepare(image(resource().url), [resource()]), image(uri()));
});

test('failed and cancelled work releases admission; resources and HTML are not cached', async () => {
  const network = resourceNetwork([{ error: Error('UPSTREAM_SECRET') }, { holdResponse: true }, {}, { type: 'image/gif', body: GIF }]);
  const { prepare } = (await api).createHtmlResourcePreparer({ ...network.options, limits: { concurrentPreparations: 1 } });
  await assert.rejects(prepare(image(resource().url), [resource()]), safeCode('html_resource_network'));
  const controller = new AbortController(), requested = once(network.events, 'request');
  const pending = prepare(image(resource().url), [resource()], { signal: controller.signal });
  await requested; controller.abort();
  await assert.rejects(pending, safeCode('html_resource_cancelled'));
  const first = await prepare(image(resource().url), [resource()]), second = await prepare(image(resource().url), [resource()]);
  assert.equal(first, image(uri())); assert.equal(second, image(uri(GIF, 'image/gif')));
  assert.equal(network.requests.length, 4); assert.equal(network.lookups.length, 4);
});

for (const key of ['PI_GUI_OFFLINE', 'PI_OFFLINE', 'HTTPS_PROXY']) test(`a ${key} change during DNS prevents the subsequent connection`, async () => {
  const network = resourceNetwork([], { lookup: async () => {
    network.options.env[key] = key === 'HTTPS_PROXY' ? 'https://proxy.example' : '1';
    return [{ address: '93.184.215.14', family: 4 }];
  } });
  const { prepare } = (await api).createHtmlResourcePreparer(network.options);
  await assert.rejects(prepare(image(resource().url), [resource()]), safeCode(key === 'HTTPS_PROXY' ? 'html_resource_proxy' : 'html_resource_offline'));
  assert.equal(network.requests.length, 0);
});

test('declarations are snapshotted before awaits and cannot change an in-flight target', async () => {
  const network = resourceNetwork([{ holdResponse: true }, {}]);
  const { prepare } = (await api).createHtmlResourcePreparer(network.options);
  const declarations = [resource(), resource('https://second.example/b.png')], requested = once(network.events, 'request');
  const pending = prepare(declarations.map(row => image(row.url)).join(''), declarations);
  await requested;
  declarations[1].url = 'https://127.0.0.1/private'; declarations.push(resource('https://10.0.0.1/private'));
  network.requests[0].deliver();
  assert.equal(await pending, image(uri()).repeat(2));
  assert.deepEqual(network.lookups.map(row => row.host), ['cdn.example', 'second.example']);
});

test('query strings never become request headers or failure diagnostics', async () => {
  const url = 'https://cdn.example/a.png?token=QUERY_SECRET';
  const { prepare, network } = await fixture([{ error: Error('UPSTREAM_SECRET COOKIE_SECRET') }]);
  await assert.rejects(prepare(image(url), [resource(url)]), safeCode('html_resource_network'));
  assert.equal(network.requests[0].options.path, '/a.png?token=QUERY_SECRET');
  assert.doesNotMatch(JSON.stringify(network.requests[0].options.headers), /QUERY_SECRET|COOKIE_SECRET/);
});
