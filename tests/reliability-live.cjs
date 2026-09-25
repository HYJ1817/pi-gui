// 真实 pi + 真实 HTTP/SSE 的 P4 压力流程；不调用模型，不属于 npm test。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(test, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await sleep(100);
  }
  throw new Error(`超时：${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function watch(url, events) {
  const controller = new AbortController();
  const done = fetch(url, { signal: controller.signal }).then(async (response) => {
    assert.equal(response.status, 200);
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += new TextDecoder().decode(chunk);
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const line = frame.split('\n').find((item) => item.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  }).catch((error) => { if (!controller.signal.aborted) throw error; });
  return { close: () => controller.abort(), done };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-p4-'));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const data = path.join(root, 'data');
  const agent = path.join(root, 'agent');
  for (const dir of [a, b, data, agent]) fs.mkdirSync(dir);
  const skillDir = path.join(agent, 'skills', 'p4-smoke');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: p4-smoke\ndescription: Isolated reliability test\n---\n', 'utf8');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PI_CWD: a, PI_GUI_DATA: data, PI_CODING_AGENT_DIR: agent, PI_NO_CONTINUE: '1', PI_GUI_OPEN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const get = async (endpoint) => (await fetch(base + endpoint)).json();
  const post = async (endpoint, body) => (await fetch(base + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  })).json();
  const events = [];
  let stream;
  try {
    await waitFor(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } }, 'HTTP 启动');
    stream = watch(base + '/api/events', events);
    await waitFor(async () => (await get('/api/status')).piRunning, 'pi 启动');
    await post('/api/projects/activate', { path: b });
    await post('/api/projects/activate', { path: a });
    await waitFor(async () => {
      const state = await get('/api/status');
      return state.cwd === a && state.piRunning;
    }, 'A→B→A');
    const before = (await get('/api/status')).bridgeRun;
    const save = await fetch(base + '/api/project-config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thinking: 'low', __expectedCwd: a }),
    }).then((r) => r.json());
    assert.equal(save.ok, true, JSON.stringify(save));
    await waitFor(async () => (await get('/api/status')).bridgeRun > before, '项目配置触发重启');
    const beforeManual = (await get('/api/status')).bridgeRun;
    await Promise.all([post('/api/restart'), post('/api/restart')]);
    await waitFor(async () => (await get('/api/status')).bridgeRun > beforeManual, '连续手动重启');
    const skills = await get('/api/skills');
    assert.equal(skills.ok, true, JSON.stringify(skills));
    const skill = skills.skills.find((item) => item.name === 'p4-smoke');
    assert.ok(skill?.toggleable, 'isolated test skill is toggleable');
    const off = await fetch(base + '/api/skills/' + encodeURIComponent(skill.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    }).then((r) => r.json());
    assert.equal(off.restartRequired, true, JSON.stringify(off));
    const beforeSkillRestart = (await get('/api/status')).bridgeRun;
    await post('/api/restart');
    await waitFor(async () => (await get('/api/status')).bridgeRun > beforeSkillRestart, 'Skill 切换后重启');
    const disabled = await get('/api/skills');
    assert.equal(disabled.skills.find((item) => item.name === 'p4-smoke')?.state, 'disabled');
    const git = await get('/api/git/status');
    assert.equal(git.isRepo, false, JSON.stringify(git));

    const lastSeq = Math.max(0, ...events.map((event) => event._seq || 0));
    stream.close();
    await stream.done;
    const replay = [];
    stream = watch(base + '/api/events', replay);
    await waitFor(() => replay.some((event) => event._seq >= lastSeq), 'SSE backlog 补发');
    const unique = new Set(replay.filter((event) => event._seq > lastSeq).map((event) => event._seq));
    assert.equal(unique.size, replay.filter((event) => event._seq > lastSeq).length, 'new events have unique sequence');
    console.log(`live reliability: passed (bridgeRun=${(await get('/api/status')).bridgeRun}, events=${events.length}, replay=${replay.length})`);
  } finally {
    stream?.close();
    await stream?.done.catch(() => {});
    if (process.platform === 'win32' && child.exitCode === null) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else if (child.exitCode === null) {
      child.kill('SIGTERM');
    }
    if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
    const resolvedRoot = path.resolve(root);
    assert.ok(resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep), 'cleanup target is inside temp');
    fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
    if (process.exitCode) console.error(output.slice(-1200));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
