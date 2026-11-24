/* 会话内文件引用的后端契约：metadata / document / asset / find / open-target，
 * 以及工作区外文件的授权读取。
 *
 * 这些端点只读、只返回真实文件；fixture 全部在 os.tmpdir()，
 * 不碰用户项目。重点覆盖：
 *   - 同一相对路径在两个会话里解析到各自工作区；
 *   - 请求必须显式给出工作区身份（root + fileId 或文件树令牌），
 *     渲染进程不能靠“当前焦点”让后端猜；
 *   - 符号链接 / 绝对路径 / `..` 一律拒绝；
 *   - 纯文件名只在唯一时返回一个匹配，依赖目录被跳过；
 *   - 图片按真实字节返回，带 nosniff / CSP / no-store，且大小受限；
 *   - 文件树令牌、消息根 + fileId、外部授权令牌是三条独立通道；
 *   - 撤销授权后外部读取立即失效。 */
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
const CONV_A = '11111111-2222-3333-4444-555555555555';
const CONV_B = '99999999-8888-7777-6666-555555555555';
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
  const dataDir = path.join(world, 'data');
  fs.mkdirSync(path.join(rootA, 'src'), { recursive: true });
  fs.mkdirSync(path.join(rootA, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(rootA, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
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
  write(rootA, 'run.cmd', '@echo off\n');
  /* 系统打开策略的对抗 fixture：白名单扩展名但 PE 头、伪装扩展名、
   * 无扩展名可执行文件、双扩展名 —— 都必须被拒绝。 */
  write(rootA, 'disguised.md', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]));
  write(rootA, 'invoice.pdf.exe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]));
  write(rootA, 'noext-binary', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]));
  write(rootA, 'plain-md.md', '# safe\n');
  write(rootB, 'README.md', '# B\n');
  write(rootB, 'src/app.js', "console.log('b');\n");
  write(rootB, 'only-b.txt', 'only b\n');
  write(outside, 'secret.txt', 'outside secret\n');
  write(outside, '报告 v1.md', '# external report\n');
  write(outside, 'nested/日志.txt', 'log\n');
  write(outside, 'picture.png', PNG);
  write(world, 'elsewhere/secret.txt', 'outside the grant\n');
  fs.symlinkSync(outside, path.join(rootA, 'escape'), 'junction');
  fs.symlinkSync(path.join(world, 'elsewhere'), path.join(outside, 'escape-link'), 'junction');

  const { createFiles, FILE_LIMITS } = await import('../server/files.js');
  const { createExternalGrants } = await import('../server/external-grants.js');
  const scopes = {
    a: { root: rootA, scopeId: 'a', generation: '1' },
    b: { root: rootB, scopeId: 'b', generation: '1' },
    'runtime-a': { root: rootA, scopeId: 'runtime-a', generation: '1', conversationId: CONV_A },
    'runtime-b': { root: rootB, scopeId: 'runtime-b', generation: '1', conversationId: CONV_B },
  };
  const grants = createExternalGrants({
    onEvict: (grant) => published.push({ type: 'external_grants', detail: { revoked: grant.id } }),
  });
  const createApproved = ({ rawPath, scopeKind = 'file', persistent = false, scope }) => {
    const inspected = grants.inspect({ rawPath, scopeKind, scope });
    assert.ok(inspected.approval);
    return grants.create({ approval: inspected.approval, scopeKind, persistent, scope });
  };
  const published = [];
  const files = createFiles({
    scopeForRequest: async (req) => {
      const id = req.headers?.['x-pi-gui-conversation'];
      return id === undefined ? scopes.a : scopes[id] || null;
    },
    limits: { ...FILE_LIMITS, maxAssetBytes: 128 },
    grants,
    mainOwnedPersistence: true,
    publish: event => published.push(event),
  });
  const app = await serve({ files });
  const scoped = (id = 'a') => ({ 'x-pi-gui-conversation': id });
  const metaUrl = (filePath, root = rootA, extra = {}) => '/api/files/metadata?' + new URLSearchParams({
    path: filePath, root, ...extra,
  });
  const findUrl = (name, root = rootA) => '/api/files/find?' + new URLSearchParams({ name, root });
  const assetUrl = (filePath, token, extra = {}) => '/api/files/asset?' + new URLSearchParams({
    path: filePath,
    ...(token ? { workspace: token.id, generation: token.generation } : {}),
    ...extra,
  });

  try {
    await check('new file routes stay behind router token auth', async () => {
      for (const url of [metaUrl('README.md'), findUrl('README.md'), assetUrl('img.png')]) {
        const response = await fetch(`http://127.0.0.1:${app.port}${url}`);
        assert.equal(response.status, 401, url);
      }
      for (const url of ['/api/files/open-target', '/api/files/grants/revoke', '/api/files/external/open-target']) {
        const post = await fetch(`http://127.0.0.1:${app.port}${url}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        assert.equal(post.status, 401, url);
      }
    });

    const listA = await app.request('/api/files', { headers: scoped('a') });
    const tokenA = listA.body.workspace;
    const metaA = await app.request(metaUrl('src/app.js'), { headers: scoped('a') });
    const metaB = await app.request(metaUrl('src/app.js', rootB), { headers: scoped('b') });
    await check('metadata resolves each conversation to its own workspace and returns a file identity', () => {
      assert.equal(metaA.status, 200);
      assert.equal(metaA.body.ok, true);
      assert.equal(metaA.body.file.path, 'src/app.js');
      assert.equal(metaA.body.file.bytes, 18);
      assert.match(metaA.body.file.fileId, /^[\w-]{32}$/);
      assert.ok(path.isAbsolute(metaA.body.file.absolutePath));
      assert.equal(metaB.body.file.absolutePath.toLowerCase().includes('project-b'), true);
      assert.equal(metaA.body.file.absolutePath.toLowerCase().includes('project-b'), false);
      assert.equal(JSON.stringify(metaA.body).includes('console.log'), false);
    });

    const noBinding = await app.request('/api/files/metadata?' + new URLSearchParams({ path: 'src/app.js' }), { headers: scoped('a') });
    const wrongRoot = await app.request(metaUrl('src/app.js', rootB), { headers: scoped('a') });
    const tokenMeta = await app.request('/api/files/metadata?' + new URLSearchParams({
      path: 'src/app.js', workspace: tokenA.id, generation: tokenA.generation,
    }), { headers: scoped('a') });
    const staleToken = await app.request('/api/files/metadata?' + new URLSearchParams({
      path: 'src/app.js', workspace: tokenA.id, generation: '999',
    }), { headers: scoped('a') });
    await check('metadata refuses to guess a workspace: root/fileId or a live tree token is required', () => {
      assert.equal(noBinding.status, 400);
      assert.equal(noBinding.body.code, 'binding_required');
      assert.equal(wrongRoot.status, 409);
      assert.equal(wrongRoot.body.code, 'workspace_changed');
      assert.equal(tokenMeta.status, 200);
      assert.equal(staleToken.status, 409);
      assert.equal(staleToken.body.code, 'stale_workspace');
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

    const docWithToken = await app.request('/api/files/document?' + new URLSearchParams({
      path: 'src/app.js', workspace: tokenA.id, generation: tokenA.generation,
    }), { headers: scoped('a') });
    const docNoFileId = await app.request('/api/files/document?' + new URLSearchParams({
      path: 'src/app.js', root: rootA,
    }), { headers: scoped('a') });
    const docWithId = await app.request('/api/files/document?' + new URLSearchParams({
      path: 'src/app.js', root: rootA, fileId: metaA.body.file.fileId,
    }), { headers: scoped('a') });
    const docWrongId = await app.request('/api/files/document?' + new URLSearchParams({
      path: 'src/app.js', root: rootA, fileId: 'x'.repeat(32),
    }), { headers: scoped('a') });
    await check('document reads content only with a live token or the backend-issued file identity', () => {
      assert.equal(docWithToken.status, 200);
      assert.equal(docWithToken.body.file.content, "console.log('a');\n");
      assert.equal(docNoFileId.status, 428);
      assert.equal(docNoFileId.body.code, 'file_identity_required');
      assert.equal(docWithId.status, 200);
      assert.equal(docWrongId.status, 409);
      assert.equal(docWrongId.body.code, 'file_changed');
    });

    const findOne = await app.request(findUrl('only-a.txt'), { headers: scoped('a') });
    const findSibling = await app.request(findUrl('only-a.txt', rootB), { headers: scoped('b') });
    const findDup = await app.request(findUrl('dup.txt'), { headers: scoped('a') });
    const findMod = await app.request(findUrl('only-mod.txt'), { headers: scoped('a') });
    const findMissing = await app.request(findUrl('no-such-name.txt'), { headers: scoped('a') });
    const findNoRoot = await app.request('/api/files/find?' + new URLSearchParams({ name: 'only-a.txt' }), { headers: scoped('a') });
    const findWrongRoot = await app.request(findUrl('only-a.txt', rootB), { headers: scoped('a') });
    await check('a bare filename resolves only in the message workspace, only when unique, and never in dependency dirs', () => {
      assert.deepEqual(findOne.body.matches, ['only-a.txt']);
      assert.equal(findOne.body.truncated, false);
      assert.deepEqual(findSibling.body.matches, []);
      assert.equal(findDup.body.matches.length, 2);
      assert.deepEqual(findMod.body.matches, []);
      assert.deepEqual(findMissing.body.matches, []);
      assert.equal(findNoRoot.status, 400);
      assert.equal(findNoRoot.body.code, 'binding_required');
      assert.equal(findWrongRoot.status, 409);
    });

    const badFind = await app.request(findUrl('../escape'), { headers: scoped('a') });
    await check('find rejects names containing separators or traversal', () => {
      assert.equal(badFind.status, 400);
    });

    const asset = await app.request(assetUrl('img.png', tokenA), { headers: scoped('a') });
    const imgMeta = await app.request(metaUrl('img.png'), { headers: scoped('a') });
    const assetById = await app.request(assetUrl('img.png', null, { root: rootA, fileId: imgMeta.body.file.fileId }), { headers: scoped('a') });
    const assetNoId = await app.request(assetUrl('img.png', null, { root: rootA }), { headers: scoped('a') });
    const svg = await app.request(assetUrl('photo.svg', tokenA), { headers: scoped('a') });
    const big = await app.request(assetUrl('big.png', tokenA), { headers: scoped('a') });
    const notImage = await app.request(assetUrl('README.md', tokenA), { headers: scoped('a') });
    const assetEscape = await app.request(assetUrl('escape/secret.txt', tokenA), { headers: scoped('a') });
    await check('assets are real image bytes with defensive headers, bounded size and identity binding', () => {
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get('content-type'), 'image/png');
      assert.deepEqual(asset.bytes, PNG);
      assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
      assert.match(asset.headers.get('content-security-policy') || '', /default-src 'none'/);
      assert.equal(asset.headers.get('cache-control'), 'no-store');
      assert.equal(assetById.status, 200);
      assert.deepEqual(assetById.bytes, PNG);
      assert.equal(assetNoId.status, 428);
      assert.equal(svg.status, 200);
      assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
      assert.equal(big.status, 413);
      assert.equal(big.body.code, 'oversized');
      assert.equal(notImage.status, 415);
      assert.equal(notImage.body.code, 'unsupported_type');
      assert.equal(assetEscape.status, 403);
    });

    const readmeA = await app.request(metaUrl('README.md'), { headers: scoped('a') });
    const readmeB = await app.request(metaUrl('README.md', rootB), { headers: scoped('b') });
    const openTarget = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'README.md', root: rootA, fileId: readmeA.body.file.fileId },
    });
    const openTargetB = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('b'), body: { path: 'README.md', root: rootB, fileId: readmeB.body.file.fileId },
    });
    const openToken = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'README.md', workspace: { id: tokenA.id }, generation: tokenA.generation },
    });
    const openNoBinding = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'README.md' },
    });
    const openNoId = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'README.md', root: rootA },
    });
    const openWrongId = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'src/dup.txt', root: rootA, fileId: metaA.body.file.fileId },
    });
    await check('open-target authorizes only a file bound to the message workspace or tree token', () => {
      assert.equal(openTarget.status, 200);
      assert.equal(openTarget.body.file.path, 'README.md');
      assert.ok(path.isAbsolute(openTarget.body.file.absolutePath));
      assert.ok(openTarget.body.file.absolutePath.includes('project-a'));
      assert.ok(openTargetB.body.file.absolutePath.includes('project-b'));
      assert.equal(openToken.status, 200);
      assert.equal(openNoBinding.status, 400);
      assert.equal(openNoBinding.body.code, 'binding_required');
      assert.equal(openNoId.status, 428);
      assert.equal(openNoId.body.code, 'file_identity_required');
      assert.equal(openWrongId.status, 409);
      assert.equal(openWrongId.body.code, 'file_changed');
    });

    const openTraversal = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: '../outside/secret.txt', root: rootA, fileId: metaA.body.file.fileId },
    });
    const openMissing = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'missing.txt', root: rootA, fileId: metaA.body.file.fileId },
    });
    const openGet = await app.request('/api/files/open-target?' + new URLSearchParams({ path: 'src/app.js' }), { headers: scoped('a') });
    const openDangerous = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'run.cmd', workspace: { id: tokenA.id }, generation: tokenA.generation, action: 'open' },
    });
    const editDangerous = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'run.cmd', workspace: { id: tokenA.id }, generation: tokenA.generation, action: 'editor' },
    });
    const copyDangerous = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'run.cmd', workspace: { id: tokenA.id }, generation: tokenA.generation, action: 'copy' },
    });
    const openScript = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'src/app.js', workspace: { id: tokenA.id }, generation: tokenA.generation, action: 'open' },
    });
    const editScript = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'src/app.js', workspace: { id: tokenA.id }, generation: tokenA.generation, action: 'editor' },
    });
    const disguisedOpen = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'disguised.md', workspace: { id: tokenA.id }, generation: tokenA.generation, action: 'open' },
    });
    const doubleExtOpen = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'invoice.pdf.exe', workspace: { id: tokenA.id }, generation: tokenA.generation, action: 'open' },
    });
    const noExtOpen = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'noext-binary', workspace: { id: tokenA.id }, generation: tokenA.generation, action: 'open' },
    });
    const plainOpen = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'plain-md.md', workspace: { id: tokenA.id }, generation: tokenA.generation, action: 'open' },
    });
    const disguisedEdit = await app.request('/api/files/open-target', {
      method: 'POST', headers: scoped('a'), body: { path: 'disguised.md', workspace: { id: tokenA.id }, generation: tokenA.generation, action: 'editor' },
    });
    await check('system open is whitelist-first: safe extensions pass, disguised/extensionless executables are refused', () => {
      assert.equal(disguisedOpen.status, 415);
      assert.match(disguisedOpen.body.code, /executable_header|unsafe_type/);
      assert.equal(doubleExtOpen.status, 415);
      assert.equal(doubleExtOpen.body.code, 'unsafe_type');
      assert.equal(noExtOpen.status, 415);
      assert.equal(noExtOpen.body.code, 'unknown_type');
      assert.equal(plainOpen.status, 200);
      /* 同一个伪装文件经“编辑器”动作不受影响：编辑器读的是字节，不执行。 */
      assert.equal(disguisedEdit.status, 200);
    });

    await check('open-target refuses traversal/missing files and never launches executables or scripts through the generic open action', () => {
      assert.equal(openTraversal.status, 403);
      assert.equal(openMissing.status, 404);
      assert.equal(openGet.status, 405);
      assert.equal(openDangerous.status, 415);
      assert.equal(openDangerous.body.code, 'unsafe_type');
      assert.equal(editDangerous.status, 200);
      assert.equal(copyDangerous.status, 200);
      assert.equal(openScript.status, 415);
      assert.equal(openScript.body.code, 'unsafe_type');
      assert.equal(editScript.status, 200);
    });

    const changedFile = path.join(rootA, 'src/changing.txt');
    write(rootA, 'src/changing.txt', 'one\n');
    const changedMeta = await app.request(metaUrl('src/changing.txt'), { headers: scoped('a') });
    write(rootA, 'src/changing.txt', 'two with different length\n');
    const staleDocument = await app.request('/api/files/document?' + new URLSearchParams({
      path: 'src/changing.txt', root: rootA, fileId: changedMeta.body.file.fileId,
    }), { headers: scoped('a') });
    fs.rmSync(changedFile);
    await check('a file replaced after its identity was issued is rejected', () => {
      assert.equal(staleDocument.status, 409);
      assert.equal(staleDocument.body.code, 'file_changed');
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

    /* ---------- 工作区外文件 ---------- */

    const externalMetaUrl = (filePath, grantId = '', conv = 'runtime-a') =>
      '/api/files/external/metadata?' + new URLSearchParams({ path: filePath, grant: grantId });
    const report = path.join(outside, '报告 v1.md');

    const noGrant = await app.request(externalMetaUrl(report), { headers: scoped('runtime-a') });
    await check('external reads without a grant token are refused', () => {
      assert.equal(noGrant.status, 400);
      assert.equal(noGrant.body.code, 'grant_required');
    });

    const fileGrant = createApproved({
      rawPath: report,
      scopeKind: 'file',
      scope: { root: rootA, conversationId: CONV_A },
    }).grant;
    const externalMeta = await app.request(externalMetaUrl(report, fileGrant.id), { headers: scoped('runtime-a') });
    const externalDoc = await app.request('/api/files/external/document?' + new URLSearchParams({
      path: report, grant: fileGrant.id,
    }), { headers: scoped('runtime-a') });
    const externalDocB = await app.request('/api/files/external/document?' + new URLSearchParams({
      path: report, grant: fileGrant.id,
    }), { headers: scoped('runtime-b') });
    const externalSibling = await app.request(externalMetaUrl(path.join(outside, 'secret.txt'), fileGrant.id), { headers: scoped('runtime-a') });
    await check('a single-file grant enables metadata and content only for that file in its own conversation', () => {
      assert.equal(externalMeta.status, 200);
      assert.equal(externalMeta.body.external, true);
      assert.equal(externalMeta.body.file.grantId, fileGrant.id);
      assert.equal(externalMeta.body.file.path.toLowerCase().includes('报告 v1.md'), true);
      assert.equal(externalDoc.status, 200);
      assert.equal(externalDoc.body.file.content, '# external report\n');
      assert.equal(externalDocB.status, 403);
      assert.equal(externalDocB.body.code, 'grant_invalid');
      assert.equal(externalSibling.status, 403);
      assert.equal(externalSibling.body.code, 'grant_scope');
    });

    const dirGrant = createApproved({
      rawPath: outside,
      scopeKind: 'directory',
      scope: { root: rootA, conversationId: CONV_A },
    }).grant;
    const nestedExternal = await app.request(externalMetaUrl(path.join(outside, 'nested/日志.txt'), dirGrant.id), { headers: scoped('runtime-a') });
    const escapedExternal = await app.request(externalMetaUrl(path.join(outside, 'escape-link/secret.txt'), dirGrant.id), { headers: scoped('runtime-a') });
    await check('a directory grant stays inside the real directory even through a junction', () => {
      assert.equal(nestedExternal.status, 200);
      assert.equal(nestedExternal.body.file.name, '日志.txt');
      assert.equal(escapedExternal.status, 403);
      assert.equal(escapedExternal.body.code, 'grant_scope');
    });

    const externalImage = await app.request('/api/files/external/asset?' + new URLSearchParams({
      path: path.join(outside, 'picture.png'), grant: dirGrant.id,
    }), { headers: scoped('runtime-a') });
    await check('external images use the same defensive asset headers', () => {
      assert.equal(externalImage.status, 200);
      assert.deepEqual(externalImage.bytes, PNG);
      assert.equal(externalImage.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(externalImage.headers.get('cache-control'), 'no-store');
    });

    const listed = await app.request('/api/files/grants', { headers: scoped('runtime-a') });
    const listedOther = await app.request('/api/files/grants', { headers: scoped('runtime-b') });
    await check('grant listing is scoped to the asking conversation', () => {
      assert.equal(listed.status, 200);
      assert.equal(listed.body.grants.length, 2);
      assert.equal(listedOther.body.grants.length, 0);
    });

    const upgradeScope = { root: rootA, conversationId: CONV_A };
    const nestedDir = path.join(outside, 'nested');
    const sessionFolder = createApproved({ rawPath: nestedDir, scopeKind: 'directory', scope: upgradeScope });
    const upgradeInspect = grants.inspect({ rawPath: nestedDir, scopeKind: 'directory', scope: upgradeScope });
    await check('an explicit folder request can upgrade a session grant to persistent', async () => {
      assert.equal(sessionFolder.grant.scope, 'session');
      assert.ok(upgradeInspect.existing);
      assert.ok(upgradeInspect.approval);
      const upgraded = grants.create({
        approval: upgradeInspect.approval,
        scopeKind: 'directory',
        persistent: true,
        scope: upgradeScope,
      });
      assert.equal(upgraded.grant.id, sessionFolder.grant.id);
      assert.equal(upgraded.grant.scope, 'persistent');
      /* 桌面版主进程持有长期存储；HTTP 撤销不能只删运行期副本，否则重启复活。 */
      const viaHttp = await app.request('/api/files/grants/revoke', {
        method: 'POST', headers: scoped('runtime-a'), body: { id: upgraded.grant.id },
      });
      assert.equal(viaHttp.status, 409);
      assert.equal(viaHttp.body.code, 'desktop_required');
    });

    const externalOpen = await app.request('/api/files/external/open-target', {
      method: 'POST', headers: scoped('runtime-a'),
      body: { grant: fileGrant.id, path: report, action: 'copy' },
    });
    const revoked = await app.request('/api/files/grants/revoke', {
      method: 'POST', headers: scoped('runtime-a'), body: { id: fileGrant.id },
    });
    const afterRevoke = await app.request(externalMetaUrl(report, fileGrant.id), { headers: scoped('runtime-a') });
    await check('revoking a grant invalidates it immediately for metadata, content and open-target', () => {
      assert.equal(externalOpen.status, 200);
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.ok, true);
      assert.equal(afterRevoke.status, 403);
      assert.equal(afterRevoke.body.code, 'grant_invalid');
      assert.equal(published.some((event) => event.type === 'external_grants'
        && event.detail?.revoked === fileGrant.id), true);
    });

    /* 授权目录被替换时，账本自动逐出授权并经 onEvict 发布同一个
     * external_grants 事件 —— 渲染进程收到后与显式撤销一样关闭外部标签。 */
    const swapDir = path.join(world, 'swap-dir');
    fs.mkdirSync(swapDir, { recursive: true });
    write(swapDir, 'inside.md', 'i\n');
    const swapMetaUrl = (filePath, grantId) => '/api/files/external/metadata?' + new URLSearchParams({ path: filePath, grant: grantId });
    const swapGrant = createApproved({
      rawPath: swapDir, scopeKind: 'directory', scope: { root: rootA, conversationId: CONV_A },
    }).grant;
    const swapMeta = await app.request(swapMetaUrl(path.join(swapDir, 'inside.md'), swapGrant.id), { headers: scoped('runtime-a') });
    const swapGrantId = swapGrant.id;
    fs.rmSync(swapDir, { recursive: true, force: true });
    fs.mkdirSync(swapDir);
    write(swapDir, 'inside.md', 'i\n');
    const afterSwap = await app.request(swapMetaUrl(path.join(swapDir, 'inside.md'), swapGrantId), { headers: scoped('runtime-a') });
    const listedAfterSwap = await app.request('/api/files/grants', { headers: scoped('runtime-a') });
    await check('a replaced grant directory auto-evicts and publishes the revoked event like an explicit revoke', () => {
      assert.equal(swapMeta.status, 200);
      assert.equal(afterSwap.status, 403);
      assert.equal(afterSwap.body.code, 'grant_changed');
      assert.equal(published.some((event) => event.type === 'external_grants'
        && event.detail?.revoked === swapGrantId), true);
      assert.equal(listedAfterSwap.body.grants.some((grant) => grant.id === swapGrantId), false);
    });

    const before = fs.readFileSync(path.join(rootA, 'src/app.js'), 'utf8');
    await app.request(metaUrl('src/app.js'), { headers: scoped('a') });
    await app.request(assetUrl('img.png', tokenA), { headers: scoped('a') });
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
