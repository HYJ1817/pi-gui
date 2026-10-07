/* Changes admission uses the real P32.2 lifecycle and real temporary Git worktrees. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
(async () => {
  let checks = 0;
  const check = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };
  const { createGitRoutes } = await import('../server/git-routes.js');
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const { createWorktrees } = await import('../server/worktrees.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p324-changes-'));
  const repo = path.join(root, 'repo'), data = path.join(root, 'data'); fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'fixture-config'), GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base-a\n'); fs.writeFileSync(path.join(repo, 'b.txt'), 'base-b\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const worktrees = createWorktrees({ dataDir: data, getProjects: () => [{ path: repo }], getContext: () => ({ cwd: repo, generation: 1 }) });
  const options = { dataDir: path.join(root, 'registry'),
    admission: (args, action) => worktrees.withWorkspace(args, action),
    factory: async (_context, emit) => ({ start() { emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }); },
      request: async () => null, dispose: async () => {}, getState: () => ({}), cleanupConfirmed: () => true }) };
  let registry = createRuntimeRegistry(options), classicReads = 0;
  const routes = createGitRoutes({ runtime: { getCurrentCwd() { classicReads++; return repo; } },
    withScopedWorkspace: (req, action) => {
      const id = req.headers?.['x-pi-gui-conversation'];
      if (id === undefined) return action(null);
      const identity = registry.workspaceIdentityOf(id);
      if (!identity) throw Object.assign(Error('unknown_conversation'), { code: 'unknown_conversation' });
      return worktrees.withWorkspace(identity, workspace => action(workspace.root));
    } });
  const response = () => ({ code: 0, writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } });
  const request = async (id, operation = 'status', payload = { path: 'a.txt', planned: true }) => {
    const req = new PassThrough(); req.method = operation === 'status' ? 'GET' : 'POST';
    req.headers = id === undefined ? {} : { 'x-pi-gui-conversation': id };
    const res = response(); const pending = routes.handle(req, res, new URL('http://127.0.0.1/api/git/' + operation));
    setImmediate(() => req.end(JSON.stringify(payload))); await pending; return res;
  };
  const create = async label => {
    const workspace = (await worktrees.create({ nonce: (await worktrees.prepare({ project: repo, branch: 'fixture/' + label })).nonce })).workspace;
    const conversation = await registry.start({ id: workspace.id, epoch: workspace.epoch });
    await registry.close(conversation.owner); return { workspace, id: conversation.conversationId };
  };
  const names = res => (res.body.files || []).map(f => f.path).sort().join(',');
  const denied = async (id, code, label) => {
    const before = classicReads;
    for (const operation of ['status', 'diff', 'open', 'restore', 'restore-all']) {
      const res = await request(id, operation);
      check(label + ': ' + operation + ' fails closed', res.code === 409 && res.body.code === code && !res.body.files);
    }
    check(label + ': never reads classic cwd', classicReads === before);
  };
  try {
    const a = await create('a'), b = await create('b');
    fs.writeFileSync(path.join(a.workspace.path, 'a.txt'), 'changed-A\n');
    fs.writeFileSync(path.join(b.workspace.path, 'b.txt'), 'changed-B\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'classic\n');
    check('classic remains available without conversation', names(await request(undefined)) === 'a.txt');
    check('A sees only A changes', names(await request(a.id)) === 'a.txt');
    check('B sees only B changes', names(await request(b.id)) === 'b.txt');
    check('registry gives identity only', JSON.stringify(registry.workspaceIdentityOf(a.id)) === JSON.stringify({ id: a.workspace.id, epoch: a.workspace.epoch }));
    check('unknown conversation has no workspace identity', registry.workspaceIdentityOf('00000000-0000-4000-8000-000000000000') === null);
    check('snapshot omits backend locator methods', !JSON.stringify(registry.snapshot()).includes('workspaceIdentityOf')
      && !JSON.stringify(registry.snapshot()).includes('sessionLocator'));
    check('status projectRoot is authoritative A root', path.resolve((await request(a.id)).body.projectRoot) === path.resolve(a.workspace.path));
    check('A diff is scoped', JSON.stringify((await request(a.id, 'diff')).body).includes('changed-A'));
    check('A open is scoped', (await request(a.id, 'open')).body.abs === path.join(a.workspace.path, 'a.txt'));
    check('restore A succeeds', (await request(a.id, 'restore')).body.ok);
    check('restore A changes only A', fs.readFileSync(path.join(a.workspace.path, 'a.txt'), 'utf8') === 'base-a\n'
      && fs.readFileSync(path.join(b.workspace.path, 'b.txt'), 'utf8') === 'changed-B\n' && fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'classic\n');
    fs.writeFileSync(path.join(a.workspace.path, 'a.txt'), 'again-A\n'); fs.writeFileSync(path.join(a.workspace.path, 'b.txt'), 'again-A-b\n');
    check('restore-all A succeeds', (await request(a.id, 'restore-all')).body.ok);
    check('restore-all affects only A', git(a.workspace.path, 'status', '--porcelain') === ''
      && fs.readFileSync(path.join(b.workspace.path, 'b.txt'), 'utf8') === 'changed-B\n' && fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'classic\n');
    await denied('00000000-0000-4000-8000-000000000000', 'unknown_conversation', 'unknown conversation');
    await denied('', 'unknown_conversation', 'empty scoped identity');
    await worktrees.archive({ id: a.workspace.id, epoch: a.workspace.epoch, archived: true });
    await denied(a.id, 'workspace_archived', 'archived workspace');
    await worktrees.archive({ id: a.workspace.id, epoch: a.workspace.epoch, archived: false });
    await worktrees.remove({ id: a.workspace.id, epoch: a.workspace.epoch });
    await denied(a.id, 'workspace_unavailable', 'removed workspace');
    // Branch mismatch is detected by lifecycle health; first request invalidates epoch.
    git(b.workspace.path, 'checkout', '-b', 'fixture/changed-b');
    const invalid = await request(b.id, 'restore');
    check('invalid health rejects before writing', invalid.code === 409 && invalid.body.code === 'workspace_unavailable'
      && fs.readFileSync(path.join(b.workspace.path, 'b.txt'), 'utf8') === 'changed-B\n');
    await denied(b.id, 'stale_workspace', 'stale epoch after health invalidation');
    const identityChanged = await create('identity');
    const displaced = identityChanged.workspace.path + '-old'; fs.renameSync(identityChanged.workspace.path, displaced);
    fs.mkdirSync(identityChanged.workspace.path); fs.cpSync(displaced, identityChanged.workspace.path, { recursive: true });
    const identityResult = await request(identityChanged.id, 'restore-all');
    check('filesystem identity replacement rejected', identityResult.code === 409 && identityResult.body.code === 'workspace_unavailable');
    const locked = await create('locked'); git(repo, 'worktree', 'lock', locked.workspace.path);
    await denied(locked.id, 'worktree_locked', 'invalid locked health'); git(repo, 'worktree', 'unlock', locked.workspace.path);
    // Registry persistence may outlive worktree metadata; unknown workspace must remain denied.
    await registry.dispose();
    const manifest = path.join(options.dataDir, 'conversations.json'), persisted = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    persisted.items.find(r => r.conversationId === locked.id).workspace.workspaceId = '00000000-0000-4000-8000-000000000001';
    fs.writeFileSync(manifest, JSON.stringify(persisted)); registry = createRuntimeRegistry(options);
    await denied(locked.id, 'unknown_workspace', 'unknown registered workspace');
    // Keep admission lock until the POST body and Git write finish, not just until validation.
    const held = await create('held'); fs.writeFileSync(path.join(held.workspace.path, 'a.txt'), 'held-change\n');
    const req = new PassThrough(); req.method = 'POST'; req.headers = { 'x-pi-gui-conversation': held.id }; const res = response();
    const readingBody = new Promise(resolve => req.on('newListener', event => { if (event === 'data') resolve(); }));
    const restoring = routes.handle(req, res, new URL('http://127.0.0.1/api/git/restore'));
    await readingBody;
    // A later withWorkspace callback can run only after the earlier admitted operation ends.
    let archiveFinished = false;
    const archiving = worktrees.archive({ id: held.workspace.id, epoch: held.workspace.epoch, archived: true }).then(() => { archiveFinished = true; });
    req.end(JSON.stringify({ path: 'a.txt' }));
    await restoring;
    check('restore completes while archive is still queued', res.body.ok && !archiveFinished && fs.readFileSync(path.join(held.workspace.path, 'a.txt'), 'utf8') === 'base-a\n');
    await archiving; check('archive runs after restore releases lifecycle lock', archiveFinished);
    check('all scoped failures preserve classic file', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'classic\n');
  } finally { await registry.dispose(); worktrees.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  console.log(`Runtime changes scope: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
