/* Opt-in after build:app -- --rebuild. Exercises App backend and SEA, no UI. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const os = require('node:os'), net = require('node:net');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const digest = value => createHash('sha256').update(value).digest('hex');
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('  ok  ' + name); };
(async () => {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'z53-packaged-'));
  const evidence = [];
  try {
    const script = path.join(world, 'fake-pi.cjs'), marker = path.join(world, 'unexpected-pi-start');
    fs.writeFileSync(script, 'require("node:fs").appendFileSync(process.env.Z53_PI_STARTED,"started");\n');
    const bin = path.join(world, 'fake-pi.cmd');
    fs.writeFileSync(bin, '@echo off\r\n"' + process.execPath + '" "' + script + '" %*\r\n');
    for (const form of ['app', 'sea']) {
      const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
      const data = path.join(world, form); fs.mkdirSync(data);
      const native = path.join(data, 'native.jsonl'), id = randomUUID(), sessionId = randomUUID();
      fs.writeFileSync(native, [
        { type: 'session', version: 3, id: sessionId, cwd: world },
        { type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: [
          { type: 'text', text: 'fixture answer' }, { type: 'toolCall', id: 'c', name: 'read', arguments: { token: 'PRIVATE_TOKEN' } },
        ] } },
        { type: 'message', id: 'r', parentId: 'a', message: { role: 'toolResult', toolCallId: 'c', toolName: 'read',
          isError: false, content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }] } },
      ].map(JSON.stringify).join('\n') + '\n');
      const nativeBytes = fs.readFileSync(native), stat = fs.statSync(native);
      fs.writeFileSync(path.join(data, 'conversations.json'), JSON.stringify({ version: 1, items: [{
        conversationId: id, sessionId, sessionLocator: fs.realpathSync(native), createdAt: '2026-10-27T00:00:00Z',
        sessionIdentity: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs },
        workspace: { projectId: 'fixture-project', repoId: 'fixture-repo', workspaceId: 'fixture-workspace',
          workspaceEpoch: 'fixture-epoch', cwd: world, root: world, branch: 'fixture' },
      }] }));
      const token = randomUUID(), env = {};
      for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
        if (process.env[key]) env[key] = process.env[key];
      }
      Object.assign(env, { PORT: String(port), PI_GUI_DATA: data, PI_GUI_OPEN: '0', PI_GUI_TOKEN: token,
        PI_CWD: '', PI_BIN: bin, Z53_PI_STARTED: marker, PI_CODING_AGENT_DIR: path.join(data, 'agent'),
        HOME: path.join(data, 'home'), USERPROFILE: path.join(data, 'home'),
        APPDATA: path.join(data, 'home/AppData/Roaming'), LOCALAPPDATA: path.join(data, 'home/AppData/Local') });
      const app = path.join(root, 'dist-app/Pi GUI-win32-x64');
      if (form === 'app') env.ELECTRON_RUN_AS_NODE = '1';
      const child = spawn(form === 'app' ? path.join(app, 'Pi GUI.exe') : path.join(root, 'build/Pi GUI.exe'),
        form === 'app' ? [path.join(app, 'resources/app/server.cjs')] : [],
        { cwd: world, env, windowsHide: true, stdio: 'ignore' });
      const exited = once(child, 'exit');
      try {
        const base = `http://127.0.0.1:${port}`, url = base + '/api/runtime-sessions?conversationId=' + id;
        let ready = false;
        for (let i = 0; i < 200; i++) {
          try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
          if (child.exitCode !== null) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        check(form + ' backend starts', ready);
        check(form + ' history retains authentication', (await fetch(url)).status === 401);
        const response = await fetch(url, { headers: { 'x-pi-gui-token': token } });
        const value = await response.json();
        check(form + ' authentic dormant summary records completion', response.status === 200
          && value.toolSummary?.items.length === 1 && value.toolSummary.items[0].toolName === 'read'
          && value.toolSummary.items[0].status === 'completed' && value.toolSummary.items[0].source === 'confirmed');
        check(form + ' original body order/identity retained', value.messages?.[0]?.text === 'fixture answer'
          && value.messages[0].messageId === 'a' && value.locator?.nativeSessionId === sessionId);
        const text = JSON.stringify(value);
        check(form + ' credentials/paths/raw data absent', !text.includes('PRIVATE') && !text.includes(world) && !text.includes('.jsonl'));
        const snap = await (await fetch(base + '/api/runtime-sessions', { headers: { 'x-pi-gui-token': token } })).json();
        check(form + ' read does not start Runtime or Pi', snap.liveCount === 0 && !fs.existsSync(marker));
        check(form + ' native session is byte-identical', fs.readFileSync(native).equals(nativeBytes));
        evidence.push({ form, responseBytes: Buffer.byteLength(text), summaryBytes: Buffer.byteLength(JSON.stringify(value.toolSummary)),
          nativeDigest: digest(nativeBytes), nativeUnchanged: true, liveCount: snap.liveCount, piStarts: 0 });
      } finally {
        if (child.exitCode === null) child.kill();
        await exited;
        check(form + ' backend process exited', child.exitCode !== null || child.signalCode !== null);
      }
    }
    if (process.env.Z53_PACKAGED_OUTPUT) fs.writeFileSync(process.env.Z53_PACKAGED_OUTPUT,
      JSON.stringify({ checks, failed: 0, mode: 'packaged-backend-only', evidence }, null, 2) + '\n');
  } finally {
    assert.equal(path.dirname(world), path.resolve(os.tmpdir())); fs.rmSync(world, { recursive: true, force: true, maxRetries: 3 });
  }
  console.log(`History summary packaged: ${checks}/${checks}; skipped=0`);
})().catch(error => { console.error(error); process.exitCode = 1; });
