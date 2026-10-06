const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('  ok  ' + name); }
(async () => {
  const { createWorktrees } = await import('../server/worktrees.js');
  const { createProjects } = await import('../server/projects.js');
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-http-')), repo = path.join(world, 'repo'), data = path.join(world, 'data');
  fs.mkdirSync(repo); fs.mkdirSync(data);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(world, 'gitconfig') } }).trim();
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base'); git('add', '.'); git('commit', '-m', 'base');
  let cwd = repo, generation = 1, restarts = 0, sends = 0, manager;
  const projectFile = path.join(data, 'projects.json'); fs.writeFileSync(projectFile, JSON.stringify({ active: repo, items: [{ path: repo, name: 'Fixture' }] }));
  const projects = createProjects({ projectsFile: projectFile, isWin: process.platform === 'win32',
    runtime: { getCurrentCwd: () => cwd, setCurrentCwd: value => { cwd = value; generation++; } }, restartPi: () => { restarts++; },
    getWorkspaceProject: value => manager?.projectFor(value), withActivation: (value, action) => manager.withActivation(value, action) });
  manager = createWorktrees({ dataDir: data, getProjects: () => projects.read().items, getContext: () => ({ cwd, generation }),
    activate: value => projects.activatePath(value, { validated: true }), onMissing: () => { cwd = null; generation++; } });
  const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}`, token = 'fixture-only-token';
  const auth = createAuth({ port, token });
  server.on('request', createRouter({ auth, projects, worktrees: manager, rpc: { send: async () => { sends++; }, abortAndWait: async () => ({ ok: true }) } }));
  const get = async url => (await fetch(base + url, { headers: { 'x-pi-gui-token': token } })).json();
  const post = async body => (await fetch(base + '/api/worktrees', { method: 'POST', headers: { 'x-pi-gui-token': token, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })).json();
  try {
    await check('真实 router 对 Worktree API 保留 token 鉴权', async () => assert.equal((await fetch(base + '/api/worktrees?project=' + encodeURIComponent(repo))).status, 401));
    await check('跨站 Origin 无法创建', async () => assert.equal((await fetch(base + '/api/worktrees', { method: 'POST', headers: { Origin: 'https://evil.invalid', 'x-pi-gui-token': token }, body: '{}' })).status, 403));
    await check('非法 JSON/超限 body 结构化拒绝', async () => { assert.equal((await post('{')).code, 'invalid_request'); assert.equal((await post('a'.repeat(5000))).code, 'invalid_request'); });
    await check('未知参数/客户端 path 拒绝', async () => assert.equal((await post({ action: 'prepare', project: repo, path: '../', contextGeneration: generation })).code, 'invalid_request'));
    await check('缺失或 stale generation 拒绝', async () => { assert.equal((await post({ action: 'prepare', project: repo })).code, 'stale_workspace'); assert.equal((await post({ action: 'prepare', project: repo, contextGeneration: 0 })).code, 'stale_workspace'); });
    let result = await get('/api/worktrees?project=' + encodeURIComponent(repo));
    await check('GET 返回 authoritative generation，列表不重启 runtime', () => { assert.equal(result.contextGeneration, generation); assert.equal(restarts, 0); });
    const plan = await post({ action: 'prepare', project: repo, contextGeneration: generation });
    const created = await post({ action: 'create', nonce: plan.nonce, contextGeneration: generation }); const row = created.workspace;
    await check('真实 HTTP 创建受控 worktree', () => { assert.equal(created.ok, true); assert.ok(fs.existsSync(row.path)); });
    const opened = await post({ action: 'open', id: row.id, epoch: row.epoch, contextGeneration: generation });
    await check('open 复用 projects activation，只有一次 restart', () => { assert.equal(opened.ok, true); assert.equal(cwd, row.cwd); assert.equal(restarts, 1); });
    await check('父项目排序/数量稳定，active 映射主项目，保存实际 cwd', async () => { const p = await get('/api/projects'); assert.equal(p.items.length, 1); assert.equal(p.items[0].path, repo); assert.equal(p.active, repo); assert.equal(p.cwd, row.cwd); assert.equal(JSON.parse(fs.readFileSync(projectFile)).active, row.cwd); });
    await check('stale open/stop scope 不能控制新 generation', async () => assert.equal((await post({ action: 'remove', id: row.id, epoch: row.epoch, contextGeneration: generation - 1 })).code, 'stale_workspace'));
    await check('当前工作区 remove 拒绝', async () => assert.equal((await post({ action: 'remove', id: row.id, epoch: row.epoch, contextGeneration: generation })).code, 'workspace_in_use'));
    git('worktree', 'remove', row.path);
    await check('外部删除后 prompt 闸门拒绝，不调用 rpc.send', async () => { const response = await fetch(base + '/api/command', { method: 'POST', headers: { 'x-pi-gui-token': token }, body: JSON.stringify({ type: 'prompt', message: 'fixture' }) }); const payload = await response.json(); assert.equal(response.status, 503); assert.equal(payload.code, 'workspace_unavailable'); assert.equal(sends, 0); assert.equal(cwd, null); });
    await check('丢失工作区后主项目可重新激活', async () => { assert.equal((await projects.activatePath(repo)).ok, true); assert.equal(cwd, repo); });
    const second = (await manager.create({ nonce: (await manager.prepare({ project: repo })).nonce })).workspace; await manager.open({ id: second.id, epoch: second.epoch });
    await check('移除父项目关闭其 active worktree，不删除工作文件', async () => { const response = await fetch(base + '/api/projects?path=' + encodeURIComponent(repo), { method: 'DELETE', headers: { 'x-pi-gui-token': token } }); const payload = await response.json(); assert.equal(payload.closedWorkspace, true); assert.equal(cwd, null); assert.ok(fs.existsSync(second.path)); });
    console.log(`Worktree HTTP: ${checks}/${checks} passed`);
  } finally { manager.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(world, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
