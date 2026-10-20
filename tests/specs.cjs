const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let checks = 0;
let skipped = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log('  ok  ' + name);
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

(async () => {
  const { createSpecs, SPEC_LIMITS } = await import('../server/specs.js');
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');

  const world = fs.mkdtempSync(path.join(os.tmpdir(), 't1-specs-'));
  const rootA = path.join(world, 'project-a');
  const rootB = path.join(world, 'project-b');
  const outside = path.join(world, 'outside');
  fs.mkdirSync(path.join(rootA, 'specs'), { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  write(rootA, 'SPEC.md', '# Project A\n\n[Overview](specs/overview.md)\n');
  write(rootA, 'README.md', '# Not discovered\n');
  write(rootA, 'docs/other.md', '# Also not discovered\n');
  write(rootA, 'specs/overview.md', '# Overview\n\n[Setup](guides/setup.markdown#install)\n');
  write(rootA, 'specs/guides/setup.markdown', '# Setup\n\n## Install\n\nRun it.\n');
  write(rootA, 'specs/notes.txt', 'not markdown');
  write(rootA, 'specs/malformed.md', '```js\nunterminated\n# still text\n');
  fs.writeFileSync(path.join(rootA, 'specs', 'huge.md'), Buffer.alloc(SPEC_LIMITS.maxDocumentBytes + 1, 0x61));
  fs.writeFileSync(path.join(rootA, 'specs', 'binary.md'), Buffer.from([0xff, 0xfe, 0xfd, 0x00]));
  write(outside, 'secret.md', '# Outside secret\n');
  fs.symlinkSync(outside, path.join(rootA, 'specs', 'escape'), 'junction');

  write(rootB, 'SPEC.md', '# Project B\n');
  write(rootB, 'specs/b-only.md', '# B only\n');

  const scopes = {
    'conv-a': { root: rootA, scopeId: 'project-a', generation: '1' },
    'conv-b': { root: rootB, scopeId: 'project-b', generation: '2' },
    classic: { root: rootA, scopeId: 'classic-a', generation: '3' },
    none: { root: null, scopeId: 'classic-none', generation: '4' },
  };
  let activeScope = 'conv-a';
  const specs = createSpecs({
    scopeForRequest: async (req) => {
      const scope = req.headers?.['x-pi-gui-conversation'];
      return scopes[scope || activeScope] || null;
    },
  });

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const token = 'specs-fixture-token';
  const auth = createAuth({ port, token });
  server.on('request', createRouter({
    auth,
    sse: { subscribe() {} },
    rpc: { send() {}, abortAndWait() {}, getState() { return {}; }, restart() {} },
    specs,
  }));

  const request = async (url, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { headers });
    return { status: response.status, body: await response.json() };
  };
  const scoped = (id) => ({ 'x-pi-gui-token': token, 'x-pi-gui-conversation': id });

  try {
    await check('Specs API keeps the router-wide token authentication', async () => {
      assert.equal((await request('/api/specs')).status, 401);
    });

    const indexed = await request('/api/specs', scoped('conv-a'));
    const documents = indexed.body.documents;
    const paths = documents.map((doc) => doc.path);
    await check('discovers root SPEC.md and Markdown recursively under specs/', () => {
      assert.equal(indexed.status, 200);
      assert.equal(indexed.body.ok, true);
      assert.deepEqual(paths, [
        'SPEC.md',
        'specs/binary.md',
        'specs/guides/setup.markdown',
        'specs/huge.md',
        'specs/malformed.md',
        'specs/overview.md',
      ]);
    });
    await check('does not discover README, docs/, or non-Markdown files', () => {
      assert.ok(!paths.includes('README.md'));
      assert.ok(!paths.includes('docs/other.md'));
      assert.ok(!paths.includes('specs/notes.txt'));
    });
    await check('does not follow a directory junction out of the project', () => {
      assert.ok(!paths.some((rel) => rel.includes('escape')));
      assert.ok(!JSON.stringify(indexed.body).includes('Outside secret'));
    });
    await check('returns opaque IDs and no absolute project path', () => {
      assert.ok(documents.every((doc) => /^[a-f0-9]{32}$/.test(doc.id)));
      assert.ok(!JSON.stringify(indexed.body).includes(rootA));
      assert.equal(indexed.body.workspace.generation, '1');
    });
    await check('marks oversized Markdown without reading it during indexing', () => {
      const huge = documents.find((doc) => doc.path === 'specs/huge.md');
      assert.equal(huge.oversized, true);
      assert.equal(huge.bytes, SPEC_LIMITS.maxDocumentBytes + 1);
    });

    const overview = documents.find((doc) => doc.path === 'specs/overview.md');
    const setup = documents.find((doc) => doc.path === 'specs/guides/setup.markdown');
    const malformed = documents.find((doc) => doc.path === 'specs/malformed.md');
    const binary = documents.find((doc) => doc.path === 'specs/binary.md');
    const workspace = indexed.body.workspace;
    const documentUrl = (doc, ws = workspace) => '/api/specs/document?' + new URLSearchParams({
      id: doc.id, workspace: ws.id, generation: ws.generation,
    });

    await check('reads only the indexed Markdown document', async () => {
      const result = await request(documentUrl(overview), scoped('conv-a'));
      assert.equal(result.status, 200);
      assert.equal(result.body.document.path, 'specs/overview.md');
      assert.equal(result.body.document.content, '# Overview\n\n[Setup](guides/setup.markdown#install)\n');
      assert.ok(!JSON.stringify(result.body).includes(rootA));
    });
    await check('serves .markdown siblings', async () => {
      const result = await request(documentUrl(setup), scoped('conv-a'));
      assert.equal(result.status, 200);
      assert.match(result.body.document.content, /## Install/);
    });
    await check('malformed Markdown remains readable text', async () => {
      const result = await request(documentUrl(malformed), scoped('conv-a'));
      assert.equal(result.status, 200);
      assert.match(result.body.document.content, /unterminated/);
    });
    await check('oversized files fail as a bounded document response', async () => {
      const result = await request(documentUrl(documents.find((doc) => doc.path === 'specs/huge.md')), scoped('conv-a'));
      assert.equal(result.status, 413);
      assert.equal(result.body.code, 'oversized');
    });
    await check('invalid UTF-8 and NUL content degrade safely', async () => {
      const result = await request(documentUrl(binary), scoped('conv-a'));
      assert.equal(result.status, 422);
      assert.equal(result.body.code, 'invalid_text');
    });
    await check('an arbitrary query path is never accepted as a document', async () => {
      const result = await request('/api/specs/document?path=' + encodeURIComponent(path.join(rootA, 'README.md')), scoped('conv-a'));
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'invalid_request');
    });
    await check('a deleted indexed document returns a safe not-found response', async () => {
      fs.rmSync(path.join(rootA, 'specs', 'overview.md'));
      const result = await request(documentUrl(overview), scoped('conv-a'));
      assert.equal(result.status, 404);
      assert.equal(result.body.code, 'document_missing');
    });
    await check('a stale workspace token cannot read another worktree checkout', async () => {
      const result = await request(documentUrl(setup), scoped('conv-b'));
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'stale_workspace');
    });
    await check('a stale generation is rejected even for the same conversation scope', async () => {
      const stale = { ...workspace, generation: '0' };
      const result = await request(documentUrl(setup, stale), scoped('conv-a'));
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'stale_workspace');
    });
    await check('another worktree index contains only its own documents', async () => {
      const result = await request('/api/specs', scoped('conv-b'));
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.documents.map((doc) => doc.path), ['SPEC.md', 'specs/b-only.md']);
      assert.notEqual(result.body.workspace.id, workspace.id);
    });
    await check('no project is an empty state, not a filesystem error', async () => {
      activeScope = 'none';
      const result = await request('/api/specs', { 'x-pi-gui-token': token });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(result.body.noProject, true);
      assert.deepEqual(result.body.documents, []);
    });
    await check('unknown deferred scope fails closed', async () => {
      activeScope = 'missing';
      const result = await request('/api/specs', { 'x-pi-gui-token': token });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'unknown_conversation');
    });

    console.log(`Specs: ${checks}/${checks}; skipped=${skipped}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(world, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
