'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG, JPEG, GIF, WEBP, resource } = require('./fixtures/html-resource-network.cjs');
const policy = import('../server/html-resource-policy.js');
const images = import('../server/html-resource-image.js');
const safeCode = code => error => {
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  return true;
};

for (const [label, raw, expected] of [
  ['ordinary HTTPS', 'https://cdn.example/p.png', 'https://cdn.example/p.png'],
  ['standard port', 'https://cdn.example:443/p.png', 'https://cdn.example/p.png'],
  ['canonical host', 'HTTPS://CDN.EXAMPLE./p.png', 'https://cdn.example/p.png'],
  ['query', 'https://cdn.example/p.png?a=1&b=2', 'https://cdn.example/p.png?a=1&b=2'],
  ['percent-encoded path', 'https://cdn.example/p%20q.png', 'https://cdn.example/p%20q.png'],
  ['public IPv4', 'https://1.1.1.1/p.png', 'https://1.1.1.1/p.png'],
  ['public IPv6', 'https://[2606:4700:4700::1111]/p.png', 'https://[2606:4700:4700::1111]/p.png'],
]) test(`URL accepts ${label}`, async () => assert.equal((await policy).checkHtmlResourceUrl(raw).href, expected));

for (const [label, raw, code] of [
  ['HTTP', 'http://cdn.example/a.png', 'url'], ['file', 'file:///secret.png', 'url'],
  ['data', 'data:image/png;base64,eA==', 'url'], ['javascript', 'javascript:alert(1)', 'url'],
  ['relative', '/a.png', 'url'], ['protocol relative', '//cdn.example/a.png', 'url'],
  ['missing authority', 'https:cdn.example/a.png', 'url'], ['nonstandard port', 'https://cdn.example:8443/a.png', 'url'],
  ['userinfo', 'https://name:secret@cdn.example/a.png', 'url'], ['username only', 'https://name@cdn.example/a.png', 'url'],
  ['empty userinfo', 'https://@cdn.example/a.png', 'url'],
  ['leading whitespace', ' https://cdn.example/a.png', 'url'], ['CRLF', 'https://cdn.example/a\r\n.png', 'url'],
  ['NUL', 'https://cdn.example/a\0.png', 'url'], ['C1', 'https://cdn.example/\u0085.png', 'url'],
  ['encoded NUL', 'https://cdn.example/%00.png', 'url'], ['encoded CRLF', 'https://cdn.example/%0d%0a.png', 'url'],
  ['encoded DEL', 'https://cdn.example/%7F.png', 'url'], ['markup delimiter', 'https://cdn.example/<x>.png', 'url'],
  ['quote', 'https://cdn.example/\"x.png', 'url'], ['backslash', 'https://cdn.example\\@other.example/a.png', 'url'],
  ['fragment', 'https://cdn.example/a.png#x', 'url'], ['empty fragment', 'https://cdn.example/a.png#', 'url'],
  ['long URL', 'https://cdn.example/' + 'x'.repeat(2048), 'url'], ['non-string', {}, 'url'],
  ['localhost', 'https://localhost/a.png', 'blocked'], ['localhost suffix', 'https://x.localhost./a.png', 'blocked'],
  ['local suffix', 'https://x.local/a.png', 'blocked'], ['internal suffix', 'https://x.internal/a.png', 'blocked'],
  ['LAN suffix', 'https://router.lan/a.png', 'blocked'], ['home.arpa', 'https://router.home.arpa/a.png', 'blocked'],
  ['single label', 'https://router/a.png', 'blocked'], ['loopback', 'https://127.0.0.1/a.png', 'blocked'],
  ['private', 'https://10.1.2.3/a.png', 'blocked'], ['linklocal', 'https://169.254.169.254/a.png', 'blocked'],
  ['decimal loopback', 'https://2130706433/a.png', 'blocked'], ['hex loopback', 'https://0x7f000001/a.png', 'blocked'],
  ['short loopback', 'https://127.1/a.png', 'blocked'], ['octal loopback', 'https://0177.0.0.1/a.png', 'blocked'],
  ['encoded host', 'https://%31%32%37.0.0.1/a.png', 'blocked'], ['IPv6 loopback', 'https://[::1]/a.png', 'blocked'],
  ['mapped hex', 'https://[::ffff:7f00:1]/a.png', 'blocked'], ['mapped dotted', 'https://[::ffff:127.0.0.1]/a.png', 'blocked'],
  ['NAT64 loopback', 'https://[64:ff9b::7f00:1]/a.png', 'blocked'], ['6to4 loopback', 'https://[2002:7f00:1::]/a.png', 'blocked'],
  ['fake-IP', 'https://198.18.0.1/a.png', 'blocked'], ['documentation', 'https://203.0.113.1/a.png', 'blocked'],
]) test(`URL rejects ${label}`, async () => {
  const p = await policy;
  assert.throws(() => p.checkHtmlResourceUrl(raw), safeCode(`html_resource_${code}`));
});

for (const address of [
  '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.42.1.2', '169.254.1.1',
  '172.16.1.1', '172.31.255.255', '192.168.1.1', '192.0.0.9', '192.0.2.1', '192.88.99.1',
  '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
  '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:0:7f00:1', '::7f00:1',
  '::ffff:93.184.215.14', '64:ff9b::5db8:d70e', '64:ff9b:1::1', '100::1', '2001::1',
  '2001:2::1', '2001:10::1', '2001:db8::1', '2002:5db8:d70e::1', '3ffe::1', '3fff::1',
  'fc00::1', 'fdff::1', 'fe80::1', 'fe80::1%lo0', 'fec0::1', 'ff02::1', '4000::1',
  'not-an-address', '2130706433', '',
]) test(`address blocks ${address || 'empty'}`, async () => assert.equal((await policy).isPublicHtmlResourceAddress(address), false));

for (const address of ['1.1.1.1', '8.8.8.8', '93.184.215.14', '100.128.0.1', '172.32.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
  test(`address accepts public ${address}`, async () => assert.equal((await policy).isPublicHtmlResourceAddress(address), true));
}

test('limits and error codes are closed, bounded and consistent with the store', async () => {
  const p = await policy, { HTML_ARTIFACT_MAX_BYTES } = await import('../public/html-artifact-model.js');
  assert.equal(p.HTML_RESOURCE_LIMITS.htmlBytes, HTML_ARTIFACT_MAX_BYTES);
  assert.equal(p.HTML_RESOURCE_LIMITS.count, 8);
  assert.ok(Object.isFrozen(p.HTML_RESOURCE_LIMITS));
  assert.equal(new Set(p.HTML_RESOURCE_ERROR_CODES).size, p.HTML_RESOURCE_ERROR_CODES.length);
  assert.ok(p.HTML_RESOURCE_ERROR_CODES.every(code => /^html_resource_[a-z_]+$/.test(code)));
  assert.equal(p.htmlResourceLimits({ count: 1, redirects: 0 }).count, 1);
  for (const override of [{ count: 9 }, { redirects: 3 }, { count: 0 }, { count: 1.5 }, { other: 1 }, null, []]) {
    assert.throws(() => p.htmlResourceLimits(override), safeCode('html_resource_invalid'));
  }
});

test('optional declaration array is closed; duplicate canonical URLs and sparse entries fail', async () => {
  const p = await policy;
  assert.deepEqual(p.checkHtmlResourceDeclarations(undefined), []);
  assert.deepEqual(p.checkHtmlResourceDeclarations([]), []);
  const eight = Array.from({ length: 8 }, (_, i) => resource(`https://cdn.example/${i}.png`));
  assert.equal(p.checkHtmlResourceDeclarations(eight).length, 8);
  for (const invalid of [null, {}, 'url', [null], new Array(1), [...eight, resource()], [resource(), resource()],
    [resource(), resource('HTTPS://CDN.EXAMPLE:443/a.png')], [{ ...resource(), headers: {} }],
    [{ ...resource(), type: 'script' }], [{ url: resource().url }], [Object.create(resource())]]) {
    assert.throws(() => p.checkHtmlResourceDeclarations(invalid), safeCode('html_resource_invalid'));
  }
  assert.throws(() => p.checkHtmlResourceDeclarations([{ url: resource().url, type: 'font' }]), safeCode('html_resource_unsupported'));
});

test('offline and proxy intent fail closed; NO_PROXY does not waive address qualification', async () => {
  const p = await policy;
  p.checkHtmlResourceEnvironment({});
  p.checkHtmlResourceEnvironment({ PI_GUI_OFFLINE: '0', PI_OFFLINE: '0', NO_PROXY: '*' });
  for (const key of ['PI_GUI_OFFLINE', 'PI_OFFLINE']) assert.throws(() => p.checkHtmlResourceEnvironment({ [key]: '1' }), safeCode('html_resource_offline'));
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'PI_GUI_SYSTEM_PROXY']) {
    assert.throws(() => p.checkHtmlResourceEnvironment({ [key]: 'https://name:SECRET@proxy.example', NO_PROXY: '*' }), safeCode('html_resource_proxy'));
  }
  assert.throws(() => p.checkHtmlResourceEnvironment({ NODE_USE_ENV_PROXY: '1' }), safeCode('html_resource_proxy'));
  assert.throws(() => p.checkHtmlResourceEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), safeCode('html_resource_network'));
});

for (const [mime, bytes] of [['image/png', PNG], ['image/jpeg', JPEG], ['image/gif', GIF], ['image/webp', WEBP]]) {
  test(`${mime} accepts binary magic and bounded container, not its extension`, async () => {
    assert.equal((await images).htmlResourceImageMime(bytes, mime.toUpperCase() + '; charset=binary'), mime);
  });
  test(`${mime} refuses mismatched MIME, HTML, SVG, scripts and truncated magic`, async () => {
    const { htmlResourceImageMime: inspect } = await images;
    for (const body of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'),
      Buffer.from('<!doctype html><script>x</script>'), Buffer.from('alert("SECRET")'), bytes.subarray(0, 8),
      Buffer.concat([bytes.subarray(0, 8), Buffer.from('<html>not an image</html>')])]) {
      assert.throws(() => inspect(body, mime), safeCode('html_resource_type'));
    }
    assert.throws(() => inspect(bytes, 'text/html'), safeCode('html_resource_type'));
    assert.throws(() => inspect(bytes, 'image/svg+xml'), safeCode('html_resource_type'));
    assert.throws(() => inspect(bytes, 'constructor'), safeCode('html_resource_type'));
    assert.throws(() => inspect(PNG, mime === 'image/png' ? 'image/jpeg' : mime), safeCode('html_resource_type'));
  });
}

test('image dimensions, frame count and unsupported animated containers are bounded', async () => {
  const { htmlResourceImageMime: inspect } = await images;
  const huge = Buffer.from(PNG); huge.writeUInt32BE(0x7fffffff, 16);
  assert.throws(() => inspect(huge, 'image/png'), safeCode('html_resource_too_large'));
  const gifFrames = GIF.subarray(27, GIF.length - 1);
  const manyFrames = Buffer.concat([GIF.subarray(0, 27), ...Array(33).fill(gifFrames), Buffer.from([59])]);
  assert.throws(() => inspect(manyFrames, 'image/gif'), safeCode('html_resource_too_large'));
  const apng = Buffer.from(PNG); apng.write('acTL', 37, 'ascii');
  assert.throws(() => inspect(apng, 'image/png'), safeCode('html_resource_type'));
  const extended = Buffer.alloc(18); extended.write('VP8X'); extended.writeUInt32LE(10, 4); extended[8] = 2;
  const animatedWebp = Buffer.concat([WEBP.subarray(0, 12), extended, WEBP.subarray(12)]);
  animatedWebp.writeUInt32LE(animatedWebp.length - 8, 4);
  assert.throws(() => inspect(animatedWebp, 'image/webp'), safeCode('html_resource_type'));
});
