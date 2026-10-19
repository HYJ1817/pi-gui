// Opt-in verification of rebuilt App and SEA upload/parser/static resources.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process'), { randomBytes, createHash } = require('node:crypto');
const { once } = require('node:events');
const build = process.argv[2];
if (!build || !path.isAbsolute(build)) throw Error('usage: node tests/review-packaged.cjs <absolute output root>');
// A stored ZIP with one fixed XML entry; no external archive tools or Office.
function fixtureDocx() {
  const name = Buffer.from('word/document.xml'), body = Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>C</w:t><w:br/><w:t>D</w:t></w:r></w:p></w:body></w:document>');
  const crc = require('../lib/zip.cjs').crc32(body), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}
(async () => {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-review-packaged-'));
  let passed = 0;
  for (const form of ['app', 'sea']) {
    const portProbe = net.createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
    const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
    const data = path.join(world, form); fs.mkdirSync(data);
    const token = randomBytes(32).toString('hex');
    const appDir = path.join(build, 'dist-app/Pi GUI-win32-x64');
    const executable = form === 'app' ? path.join(appDir, 'Pi GUI.exe') : path.join(build, 'build/Pi GUI.exe');
    const args = form === 'app' ? [path.join(appDir, 'resources/app/server.cjs')] : [];
    const env = { ...process.env, PORT: String(port), PI_GUI_OPEN: '0', PI_GUI_TOKEN: token, PI_GUI_DATA: data, PI_CWD: '', PI_BIN: path.join(world, 'absent-pi.cmd'), PI_CODING_AGENT_DIR: path.join(world, 'absent-agent') };
    if (form === 'app') env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, args, { cwd: world, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let exited = false; const exit = once(child, 'exit').then(() => { exited = true; });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', () => {});
    const origin = `http://127.0.0.1:${port}`, headers = { 'x-pi-gui-token': token };
    try {
      const until = Date.now() + 20000;
      while (!exited && !output.includes(`→ http://127.0.0.1:${port}`) && Date.now() < until) await new Promise(r => setTimeout(r, 30));
      assert.equal(exited, false); assert.ok(output.includes(`→ http://127.0.0.1:${port}`), 'owned child completed listen');
      assert.equal((await fetch(origin + '/api/status')).status, 401);
      const status = await fetch(origin + '/api/status', { headers }); assert.equal(status.status, 200); assert.equal((await status.json()).hasProject, false);
      const response = await fetch(origin + '/api/upload?name=review.docx', { method: 'POST', headers, body: fixtureDocx() });
      const upload = await response.json(); assert.equal(upload.ok, true); assert.equal(upload.text, 'A&B\tC\nD');
      assert.ok(path.resolve(upload.path).startsWith(path.resolve(data) + path.sep)); passed++; console.log('PASS ' + form + ' actual DOCX parsing preserves tabs/breaks/entities');
      for (const file of ['attachments.js', 'composer.js', 'draft.js', 'usage.js', 'rpc.js', 'runtime-conversation.js', 'runtime-sessions.js', 'runtime-state.js', 'runtime-store.js']) {
        const actual = Buffer.from(await (await fetch(origin + '/' + file, { headers })).arrayBuffer());
        assert.equal(createHash('sha256').update(actual).digest('hex'), createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../public', file))).digest('hex'), form + ': ' + file);
      }
      passed++; console.log('PASS ' + form + ' all nine changed renderer modules match source digests');
    } finally { if (!exited) child.kill(); await exit; }
  }
  const report = { passed, failed: 0, skipped: 0, world, layer: 'actual rebuilt App/SEA; no project or Pi; private fixture token' };
  fs.writeFileSync(path.join(world, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Review packaged: ${passed}/${passed}; evidence=${world}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
