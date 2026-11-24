/* 会话内文件引用的后端契约：metadata / asset / find / open-target。
 *
 * 这些端点只读、只返回工作区内的真实文件；fixture 全部在 os.tmpdir()，
 * 不碰用户项目。重点覆盖：
 *   - 同一相对路径在两个会话里解析到各自工作区；
 *   - 符号链接 / 绝对路径 / `..` 一律拒绝；
 *   - 纯文件名只在唯一时返回一个匹配，依赖目录被跳过；
 *   - 图片按真实字节返回，带 nosniff / CSP / no-store，且大小受限；
 *   - “用系统程序打开”的目标同样要经过后端授权。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log('  ok  ' + name);
}

const write = (root, rel, content) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const TOKEN = 'fixture-token';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function serve({ files }) {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const auth = createAuth({ port, token: TOKEN });
  server.on('request', createRouter({
    auth,
    sse: { subscribe() {} },
    rpc: { send() {}, abortAndWait() { return { ok: true }; }, getState() { return {}; }, restart() {} },
    files,
  }));
  const request = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'x-pi-gui-token': TOKEN, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = response.headers.get('content-type') || '';
    if (type.startsWith('image/')) {
      return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
    }
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { port, request, close: () => new Promise((resolve) => server.close(resolve)) };
}

(async () => {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-file-links-'));
  const rootA = path.join(world, 'project-a');
  const rootB = path.join(world, 'project-b');
  const outside = path.join(world, 'outside');
  fs.mkdirSync(path.join(rootA, 'src'), { recursive: true });
  fs.mkdirSync(path.join(rootA, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(rootA, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  write(rootA, 'README.md', '# A\n');
  write(rootA, 'src/app.js', "console.log('a');\n");
  write(rootA, 'src/deep/util.ts', 'export const a = 1;\n');
  write(rootA, 'docs/dup.txt', 'docs dup\n');
  write(rootA, 'src/dup.txt', 'src dup\n');
  write(rootA, 'node_modules/pkg/only-mod.txt', 'dependency\n');
  write(rootA, 'only-a.txt', 'only a\n');
  write(rootA, '.env', 'SECRET=must-not-leak\n');
  write(rootA, 'img.png', PNG);
  write(rootA, 'photo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  write(rootA, 'big.png', Buffer.concat([PNG, Buffer.alloc(128, 1)]));
  write(rootB, 'README.md', '# B\n');
  write(rootB, 'src/app.js', "console.log('b');\n");
  write(rootB, 'only-b.txt', 'only b\n');
  write(outside, 'secret.txt', 'outside secret\n');
  fs.symlinkSync(outside, path.join(rootA, 'escape'), 'junction');

  const { createFiles, FILE_LIMITS } = await import('../server/files.js');
  const scopes = {
    a: { root: rootA, scopeId: 'a', generation: '1' },
    b: { root: rootB, scopeId: 'b', generation: '1' },
  };
  const files = createFiles({
    scopeForRequest: async (req) => {
      const id = req.headers?.['x-pi-gui-conversation'];
      return id === undefined ? scopes.a : scopes[id] || null;
    },
    limits: { ...FILE_LIMITS, maxAssetBytes: 128 },
  });
  const app = await serve({ files });
  const scoped = (id = 'a') => ({ 'x-pi-gui-conversation': id });
  const metaUrl = (filePath) => '/api/files/metadata?' + new URLSearchParams({ path: filePath });
  const findUrl = (name) => '/api/files/find?' + new URLSearchParams({ name });
  const assetUrl = (filePath) => '/api/files/asset?' + new URLSearchParams({ path: filePath });

  try {
    await check('new file routes stay behind router token auth', async () => {
      for (const url of [metaUrl('README.md'), findUrl('README.md'), assetUrl('img.png')]) {
        const response = await fetch(`http://127.0.0.1:${app.port}${url}`);
        assert.equal(response.status, 401, url);
      }
      const post = await fetch(`http://127.0.0.1:${app.port}/api/files/open-target`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(post.status, 401);
    });

    const metaA = await app.request(metaUrl('src/app.js'), { headers: scoped('a') });
    const metaB = await app.request(metaUrl('src/app.js'), { headers: scoped('b') });
    await check('metadata resolves each conversation to its own workspace', () => {
      assert.equal(metaA.status, 200);
      assert.equal(metaA.body.ok, true);
      assert.equal(metaA.body.file.path, 'src/app.js');
      assert.equal(metaA.body.file.bytes, 18);
      assert.ok(path.isAbsolute(metaA.body.file.absolutePath));
      assert.equal(metaB.body.file.absolutePath.toLowerCase().includes('project-b'), true);
      assert.equal(metaA.body.file.absolutePath.toLowerCase().includes('project-b'), false);
      assert.equal(JSON.stringify(metaA.body).includes('console.log'), false);
    });

    const hiddenMeta = await app.request(metaUrl('.env'), { headers: scoped('a') });
    const missing = await app.request(metaUrl('not-here.txt'), { headers: scoped('a') });
    const escapeMeta = await app.request(metaUrl('../outside/secret.txt'), { headers: scoped('a') });
    const symlinkMeta = await app.request(metaUrl('escape/secret.txt'), { headers: scoped('a') });
    const absoluteMeta = await app.request(metaUrl(path.join(outside, 'secret.txt')), { headers: scoped('a') });
    await check('metadata accepts an explicitly named dotfile but refuses missing/traversal/symlink/absolute paths', () => {
      assert.equal(hiddenMeta.status, 200);
      assert.equal(hiddenMeta.body.file.name, '.env');
      assert.equal(missing.status, 404);
      assert.equal(missing.body.code, 'file_missing');
      assert.equal(escapeMeta.status, 403);
      assert.equal(symlinkMeta.status, 403);
      assert.equal(absoluteMeta.status, 403);
    });

    const findOne = await app.request(findUrl('only-a.txt'), { headers: scoped('a') });
    const findSibling = await app.request(findUrl('only-a.txt'), { headers: scoped('b') });
    const findDup = await app.request(findUrl('dup.txt'), { headers: scoped('a') });
    const findMod = await app.request(findUrl('only-mod.txt'), { headers: scoped('a') });
    const findMissing = await app.request(findUrl('no-such-name.txt'), { headers: scoped('a') });
    await check('a bare filename resolves only when unique and never walks dependency directories', () => {
      assert.deepEqual(findOne.body.matches, ['only-a.txt']);
      assert.equal(findOne.body.truncated, false);
      assert.deepEqual(findSibling.body.matches, []);
      assert.equal(findDup.body.matches.length, 2);
      assert.deepEqual(findMod.body.matches, []);
      assert.deepEqual(findMissing.body.matches, []);
    });

    const badFind = await app.request(findUrl('../escape'), { headers: scoped('a') });
    await check('find rejects names containing separators or traversal', () => {
      assert.equal(badFind.status, 400);
    });

    const asset = await app.request(assetUrl('img.png'), { headers: scoped('a') });
    const svg = await app.request(assetUrl('photo.svg'), { headers: scoped('a') });
    const big = await app.request(assetUrl('big.png'), { headers: scoped('a') });
    const notImage = await app.request(assetUrl('README.md'), { headers: scoped('a') });
    const assetEscape = await app.request(assetUrl('escape/secret.txt'), { headers: scoped('a') });
    await check('assets are real image bytes with defensive headers and a bounded size', () => {
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get('content-type'), 'image/png');
      assert.deepEqual(asset.bytes, PNG);
      assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
      assert.match(asset.headers.get('content-security-policy') || '', /default-src 'none'/);
      assert.equal(asset.headers.get('cache-control'), 'no-store');
      assert.equal(svg.status, 200);
      assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
      assert.equal(big.status, 413);
      assert.equal(big.body.code, 'oversized');
      assert.equal(notImage.status, 415);
      assert.equal(notImage.body.code, 'unsupported_type');
      assert.equal(assetEscape.status, 403);
    });

    const openTarget = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'src/app.js' },
    });
    const openTargetB = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('b'), body: { path: 'src/app.js' },
    });
    const openTraversal = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: '../outside/secret.txt' },
    });
    const openMissing = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'missing.txt' },
    });
    const openGet = await app.request('/api/files/open-target?' + new URLSearchParams({ path: 'src/app.js' }), { headers: scoped('a') });
    await check('open-target authorizes only an existing file in the conversation workspace', () => {
      assert.equal(openTarget.status, 200);
      assert.equal(openTarget.body.file.path, 'src/app.js');
      assert.ok(path.isAbsolute(openTarget.body.file.absolutePath));
      assert.ok(openTarget.body.file.absolutePath.includes('project-a'));
      assert.ok(openTargetB.body.file.absolutePath.includes('project-b'));
      assert.equal(openTraversal.status, 403);
      assert.equal(openMissing.status, 404);
      assert.equal(openGet.status, 405);
    });

    const unknown = await app.request(metaUrl('README.md'), { headers: scoped('unknown') });
    await check('an unknown conversation identity cannot fall back to another workspace', () => {
      assert.equal(unknown.status, 409);
      assert.equal(unknown.body.code, 'unknown_conversation');
    });

    const wrongMethod = await app.request(metaUrl('README.md'), { method: 'POST', headers: scoped('a'), body: {} });
    const unknownRoute = await app.request('/api/files/nope', { headers: scoped('a') });
    await check('file routes reject unsupported methods and unknown paths', () => {
      assert.equal(wrongMethod.status, 405);
      assert.equal(unknownRoute.status, 404);
    });

    const before = fs.readFileSync(path.join(rootA, 'src/app.js'), 'utf8');
    await app.request(metaUrl('src/app.js'), { headers: scoped('a') });
    await app.request(assetUrl('img.png'), { headers: scoped('a') });
    await app.request(findUrl('only-a.txt'), { headers: scoped('a') });
    await check('read-only endpoints never write to the workspace', () => {
      assert.equal(fs.readFileSync(path.join(rootA, 'src/app.js'), 'utf8'), before);
    });
  } finally {
    await app.close();
    fs.rmSync(world, { recursive: true, force: true });
  }

  console.log(`file-links-backend: ${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
