/* P32.4-C：Changes 必须跟随 focused 的**并行会话**，而不是全局 currentCwd。
 *
 * 这一节盯住的是一条硬契约：**带会话身份但解析不出工作区时，必须明确拒绝，
 * 绝不能悄悄回落到经典 cwd** —— 那会把 A 的改动画成 B 的。所有 Git 都是
 * os.tmpdir() 里的临时真实仓库；registry 用真实实现（只注入 factory）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');

(async () => {
  let checks = 0;
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };
  const { createGitRoutes } = await import('../server/git-routes.js');
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');

  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p324-changes-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base-a\n'); fs.writeFileSync(path.join(repo, 'b.txt'), 'base-b\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const dirs = { A: path.join(root, 'A'), B: path.join(root, 'B'), classic: path.join(root, 'classic') };
  git(repo, 'worktree', 'add', '-b', 'p324-a', dirs.A, 'HEAD');
  git(repo, 'worktree', 'add', '-b', 'p324-b', dirs.B, 'HEAD');
  fs.mkdirSync(dirs.classic); git(dirs.classic, 'init', '-b', 'main');
  git(dirs.classic, 'config', 'user.name', 'F'); git(dirs.classic, 'config', 'user.email', 'f@example.invalid');
  fs.writeFileSync(path.join(dirs.classic, 'classic.txt'), 'base\n'); git(dirs.classic, 'add', '.'); git(dirs.classic, 'commit', '-m', 'c');
  /* A/B/经典各改各的，才能区分「用错了工作区」。 */
  fs.writeFileSync(path.join(dirs.A, 'a.txt'), 'changed-by-A\n');
  fs.writeFileSync(path.join(dirs.B, 'b.txt'), 'changed-by-B\n');
  fs.writeFileSync(path.join(dirs.classic, 'classic.txt'), 'changed-by-classic\n');

  /* 真实 registry：workspaceRootOf 必须来自**记录**里的 workspace.root。 */
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
  const registry = createRuntimeRegistry({ dataDir,
    resolveWorkspace: async args => ({ projectId: 'p', repoId: 'r', workspaceId: args.id, workspaceEpoch: args.epoch, cwd: dirs[args.id], root: dirs[args.id], branch: 'p324-' + args.id.toLowerCase() }),
    factory: async (context, emit) => ({ start() { emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }); }, send() {},
      request: async () => ({ sessionId: 'native-' + context.owner.workspaceId }), sessionLocator: async () => null,
      abortAndWait: async () => ({ ok: true }), getState: () => ({ state: 'ready' }), dispose: async () => {}, cleanupConfirmed: () => true }) });
  const startedA = await registry.start({ id: 'A', epoch: 'e' });
  const startedB = await registry.start({ id: 'B', epoch: 'e' });

  ok('registry 按会话给出 workspace root（来自记录，不是路径推断）', registry.workspaceRootOf(startedA.conversationId) === fs.realpathSync(dirs.A)
    || registry.workspaceRootOf(startedA.conversationId) === dirs.A);
  ok('未知会话不给 root（null，而不是兜底成别的目录）', registry.workspaceRootOf('00000000-0000-4000-8000-000000000000') === null);
  /* 快照按设计**含** workspace 描述符（侧栏要用 branch/projectId）。要守的是：
   * 后端专用的定位能力（sessionLocator / workspaceRootOf）不出现在快照里。 */
  const snapshotText = JSON.stringify(registry.snapshot());
  ok('快照不含后端专用定位字段（sessionLocator / workspaceRootOf）',
    !snapshotText.includes('sessionLocator') && !snapshotText.includes('workspaceRootOf'));

  /* 路由：完全照 server.js 的接线方式（只给 conversationId，根由 registry 解析）。 */
  const routes = createGitRoutes({ runtime: { getCurrentCwd: () => dirs.classic },
    resolveScopedCwd: (req) => {
      const id = req.headers?.['x-pi-gui-conversation'];
      if (typeof id !== 'string' || !id) return null;
      const cwd = registry.workspaceRootOf(id);
      return cwd ? { cwd } : { error: 'unknown_conversation' };
    } });
  const res = () => ({ code: 0, headers: {}, writeHead(c, h) { this.code = c; this.headers = h || {}; }, end(b) { this.body = b; } });
  const status = async headers => { const r = res(); await routes.handle({ method: 'GET', headers }, r, new URL('http://127.0.0.1/api/git/status')); return { code: r.code, body: JSON.parse(r.body) }; };
  const names = body => (body.files || []).map(f => f.path.split(/[\\/]/).pop()).sort().join(',');

  const classic = await status({});
  ok('不带会话身份 = 经典单工作区（行为不变）', classic.code === 200 && names(classic.body) === 'classic.txt');
  const scopedA = await status({ 'x-pi-gui-conversation': startedA.conversationId });
  ok('带 A 的身份 → 看到 A 工作区的改动', scopedA.code === 200 && names(scopedA.body) === 'a.txt');
  const scopedB = await status({ 'x-pi-gui-conversation': startedB.conversationId });
  ok('带 B 的身份 → 看到 B 工作区的改动', scopedB.code === 200 && names(scopedB.body) === 'b.txt');
  ok('A/B 的 Changes 不互相串', names(scopedA.body) !== names(scopedB.body));

  const unknown = await status({ 'x-pi-gui-conversation': '00000000-0000-4000-8000-000000000000' });
  ok('未知会话明确拒绝（409 + unknown_conversation）', unknown.code === 409 && unknown.body.code === 'unknown_conversation');
  ok('未知会话**不回落**到经典 cwd（否则会把经典/A 的改动画成它的）',
    names(unknown.body) !== 'classic.txt' && (unknown.body.files || []).length === 0);

  const noProject = await status({ 'x-pi-gui-conversation': startedA.conversationId });
  ok('解析成功后返回的 projectRoot 属于该工作区', path.resolve(scopedA.body.projectRoot) === path.resolve(fs.realpathSync(dirs.A)) || path.resolve(scopedA.body.projectRoot) === path.resolve(dirs.A),
    'A 的 projectRoot 应为 A 的工作区');

  await registry.dispose();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  console.log(`Runtime changes scope: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
