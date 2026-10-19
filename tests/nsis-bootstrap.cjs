const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const { downloadVerified, installVerified, NSIS } = await import('../scripts/install-ci-nsis.mjs');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-nsis-'));
  const bytes = Buffer.from('fixture installer');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let passed = 0;
  async function check(name, fn) { await fn(); passed++; console.log(`ok ${name}`); }
  const response = () => new Response(bytes);
  try {
    await check('CLI refuses developer machines before downloading or installing', () => {
      const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/install-ci-nsis.mjs')], {
        encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' }, windowsHide: true,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /restricted to Windows GitHub Actions/);
    });
    await check('official installer and digest are pinned', () => {
      assert.equal(NSIS.version, '3.13');
      assert.match(NSIS.url, /^https:\/\/sourceforge.net\/projects\/nsis\/files\//);
      assert.equal(NSIS.sha256, 'db9a1038bbc0e53fef24f423fd609979bd578e942f1be1198db186d1c42652a3');
    });
    await check('verified bytes only are written', async () => {
      const dest = path.join(fixture, 'good.exe');
      await downloadVerified({ url: NSIS.url, sha256: digest, dest, fetchImpl: response, sleep: async () => {} });
      assert.deepEqual(fs.readFileSync(dest), bytes);
    });
    await check('transient HTTP failure retries then succeeds', async () => {
      let calls = 0;
      await downloadVerified({ url: NSIS.url, sha256: digest, dest: path.join(fixture, 'retry.exe'),
        fetchImpl: () => ++calls < 3 ? new Response('', { status: 503 }) : response(), sleep: async () => {} });
      assert.equal(calls, 3);
    });
    await check('network errors are bounded to three attempts', async () => {
      let calls = 0;
      await assert.rejects(downloadVerified({ url: NSIS.url, sha256: digest, dest: path.join(fixture, 'network.exe'),
        fetchImpl: () => { calls++; throw new Error('unavailable'); }, sleep: async () => {} }), /unavailable/);
      assert.equal(calls, 3);
    });
    await check('wrong digest fails without writing or retrying', async () => {
      let calls = 0;
      const dest = path.join(fixture, 'bad.exe');
      await assert.rejects(downloadVerified({ url: NSIS.url, sha256: '0'.repeat(64), dest,
        fetchImpl: () => { calls++; return response(); }, sleep: async () => {} }), /SHA256/);
      assert.equal(calls, 1);
      assert.equal(fs.existsSync(dest), false);
    });
    await check('oversized response is rejected', async () => {
      await assert.rejects(downloadVerified({ url: NSIS.url, sha256: digest, dest: path.join(fixture, 'large.exe'),
        maxBytes: 2, fetchImpl: response, sleep: async () => {} }), /size/i);
    });
    await check('installer failure never probes or exports a compiler', () => {
      let calls = 0;
      assert.throws(() => installVerified({ installer: 'fixture.exe', compiler: 'makensis.exe',
        run: () => { calls++; return { status: 5 }; } }), /installer/i);
      assert.equal(calls, 1);
    });
    await check('compiler must return expected version', () => {
      assert.throws(() => installVerified({ installer: 'fixture.exe', compiler: 'makensis.exe',
        run: (exe) => ({ status: 0, stdout: exe === 'makensis.exe' ? 'v3.12' : '' }) }), /version/i);
    });
    await check('compiler probe failure is fatal', () => {
      assert.throws(() => installVerified({ installer: 'fixture.exe', compiler: 'makensis.exe',
        run: (exe) => ({ status: exe === 'makensis.exe' ? 1 : 0, stdout: 'v3.13' }) }), /compiler/i);
    });
    await check('silent install and compiler probe succeed', () => {
      const calls = [];
      installVerified({ installer: 'fixture.exe', compiler: 'makensis.exe', run: (exe, args) => {
        calls.push([exe, args]); return { status: 0, stdout: exe === 'makensis.exe' ? 'v3.13\r\n' : '' };
      } });
      assert.deepEqual(calls, [['fixture.exe', ['/S']], ['makensis.exe', ['/VERSION']]]);
    });
    await check('verified compiler directory is exported only after success', () => {
      const homes = [];
      const compiler = path.join(fixture, 'NSIS', 'makensis.exe');
      const onVerified = home => homes.push(home);
      assert.throws(() => installVerified({ installer: 'fixture.exe', compiler, onVerified,
        run: () => ({ status: 0, stdout: 'v3.12' }) }), /version/);
      assert.deepEqual(homes, []);
      installVerified({ installer: 'fixture.exe', compiler, onVerified,
        run: () => ({ status: 0, stdout: 'v3.13' }) });
      assert.deepEqual(homes, [path.dirname(compiler)]);
    });
    console.log(`${passed}/${passed} passed`);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
