/* Opt-in verification of rebuilt App and SEA: authenticated production HTTP,
 * exact renderer hashes, parser behavior and preserved ordinary-file bytes.
 * Does not invoke Pi or touch real projects/profile data. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash, randomBytes } = require('node:crypto');
const { documentFiles } = require('./fixtures/attachment-files.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.resolve(process.argv[2] || ROOT);
const resources = ['attachments.js', 'attachment-types.js', 'attachment-view.js', 'attachment-preview.js', 'attachments.css',
  'composer.js', 'rpc.js', 'styles.css', 'ui3-composer.css', 'index.html', 'ui/icons.js', 'ui/user-message-body.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-attachments-packaged-'));
  const results = [];
  try {
    for (const form of ['app', 'sea']) {
      const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
      const appDir = path.join(OUTPUT, 'dist-app/Pi GUI-win32-x64');
      const executable = form === 'app' ? path.join(appDir, 'Pi GUI.exe') : path.join(OUTPUT, 'build/Pi GUI.exe');
      const args = form === 'app' ? [path.join(appDir, 'resources/app/server.cjs')] : [];
      const data = path.join(world, form); fs.mkdirSync(data);
      const token = randomBytes(32).toString('hex');
      const env = { ...process.env, PORT: String(port), PI_GUI_OPEN: '0', PI_GUI_TOKEN: token, PI_GUI_DATA: data,
        PI_CWD: '', PI_BIN: path.join(world, 'no-pi.cmd'), PI_CODING_AGENT_DIR: path.join(world, 'no-agent'), PI_GUI_OFFLINE: '1' };
      if (form === 'app') env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, args, { cwd: world, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stopped = false, output = '';
      const exit = once(child, 'exit').then(() => { stopped = true; });
      child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', () => {});
      const origin = 'http://127.0.0.1:' + port, headers = { 'x-pi-gui-token': token };
      async function check(name, run) {
        try { await run(); results.push({ form, name, pass: true }); console.log('PASS ' + form + ': ' + name); }
        catch (error) { results.push({ form, name, pass: false, error: error.message }); console.error('FAIL ' + form + ': ' + name + ' ' + error.message); }
      }
      try {
        const until = Date.now() + 25000;
        while (!stopped && !output.includes('→ ' + origin) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(!stopped && output.includes('→ ' + origin), 'owned packaged server did not complete listen');
        await check('authentication and no-project isolation', async () => {
          assert.equal((await fetch(origin + '/api/status')).status, 401);
          const status = await (await fetch(origin + '/api/status', { headers })).json(); assert.equal(status.hasProject, false);
        });
        for (const resource of resources) await check('exact source digest ' + resource, async () => {
          const response = await fetch(origin + '/' + resource, { headers }); assert.equal(response.status, 200);
          assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(fs.readFileSync(path.join(ROOT, 'public', resource))));
        });
        for (const fixture of documentFiles()) await check('actual upload/parser ' + fixture.name, async () => {
          const response = await fetch(origin + '/api/upload?name=' + encodeURIComponent(fixture.name), { method: 'POST', headers, body: fixture.body });
          const result = await response.json(); assert.equal(result.ok, true, result.error); assert.equal(result.size, fixture.body.length);
          assert.ok(result.path.startsWith(data + path.sep)); assert.deepEqual(fs.readFileSync(result.path), fixture.body);
          if (/\.(pdf|docx|md)$/.test(fixture.name)) { assert.equal(result.kind, 'text'); assert.ok(result.text); }
          else { assert.equal(result.kind, 'binary'); assert.equal(result.error, undefined); }
        });
      } finally { if (!stopped) child.kill(); await exit; }
    }
  } finally {
    const failed = results.filter(result => !result.pass).length;
    fs.writeFileSync(path.join(world, 'results.json'), JSON.stringify({ passed: results.length - failed, failed, skipped: 0, results }, null, 2));
    console.log(`Attachment packaged: ${results.length - failed}/${results.length}; failed=${failed}; evidence=${world}`);
    if (failed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
