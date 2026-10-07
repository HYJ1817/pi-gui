/* Real temporary Git worktrees + native JSONL. No Pi/model or user-data writes. */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
(async () => {
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const { createWorktrees } = await import('../server/worktrees.js');
  const { createSessions } = await import('../server/sessions.js');
  const { createSessionSearch } = await import('../server/session-search.js');
  const { readSessionMessages, readSessionText } = await import('../server/session-history.js');
  const { createRuntimeRoutes } = await import('../server/runtime-routes.js');
  let checks = 0; const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('  ok  ' + name); };
  const tick = () => new Promise(r => setImmediate(r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p324-history-'));
  const repo = path.join(root, 'repo'), other = path.join(root, 'other'), agent = path.join(root, 'agent');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config') }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const dir of [repo, other]) { fs.mkdirSync(dir); git(dir, 'init', '-b', 'main'); git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid'); fs.writeFileSync(path.join(dir, 'base'), 'base'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'base'); }
  let cwd = repo, children = 0, registry;
  const worktrees = createWorktrees({ dataDir: path.join(root, 'wt'), getProjects: () => [{ path: repo }, { path: other }], getContext: () => ({ cwd, generation: 1 }) });
  const nativeRoot = path.join(agent, 'sessions', 'fixture'); fs.mkdirSync(nativeRoot, { recursive: true });
  const user = text => ({ type: 'message', id: 'user', timestamp: '2026-10-07T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text }] } });
  const write = (file, id, dir, text) => fs.writeFileSync(file, [JSON.stringify({ type: 'session', version: 3, id, cwd: dir, timestamp: '2026-10-07T00:00:00Z' }), JSON.stringify(user(text)), JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET_THINK' }, { type: 'toolCall', name: 'bash', arguments: { secret: 'SECRET_TOOL' } }, { type: 'text', text: 'answer needle' }] } })].join('\n') + '\n');
  const names = new Map(), files = new Map();
  const options = { dataDir: path.join(root, 'registry'), admission: (args, action) => worktrees.withWorkspace(args, action),
    factory: async (context, emit) => { children++; const id = 'native-' + context.workspace.workspaceId, file = path.join(nativeRoot, id + '.jsonl'); files.set(context.workspace.workspaceId, file);
      if (!fs.existsSync(file)) write(file, id, context.cwd, 'parallel needle');
      names.set(context.workspace.workspaceId, names.get(context.workspace.workspaceId) || 'Native title');
      return { start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }),
        request: async () => ({ sessionId: id, sessionName: names.get(context.workspace.workspaceId) }), sessionLocator: () => fs.realpathSync(file),
        getState: () => ({}), send() {}, dispose: async () => {}, cleanupConfirmed: () => true }; } };
  registry = createRuntimeRegistry(options);
  const make = async (project, branch) => { const workspace = (await worktrees.create({ nonce: (await worktrees.prepare({ project, branch })).nonce })).workspace;
    const started = await registry.start({ id: workspace.id, epoch: workspace.epoch }); await tick(); await tick(); return { workspace, id: started.conversationId }; };
  const runtime = { getCurrentCwd: () => cwd };
  const sessions = createSessions({ runtime, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, dataDir: path.join(root, 'classic-data') });
  const candidates = async dir => { const project = await worktrees.list({ project: worktrees.projectFor(dir) || dir }); return registry.searchTargets(project.projectId); };
  const search = createSessionSearch({ runtime, sessions, runtimeCandidates: candidates, readRuntimeCandidate: (target, maxBytes) => readSessionText(target.sessionLocator, { expected: target, maxBytes }) });
  const read = id => { const target = registry.historyTarget(id); return readSessionMessages(target.sessionLocator, { expected: target }); };
  try {
    const a = await make(repo, 'fixture/a'), b = await make(other, 'fixture/b');
    const ai = registry.snapshot().items.find(i => i.conversationId === a.id), target = registry.historyTarget(a.id);
    check('native get_state name proves title', ai.sessionName === 'Native title' && ai.title === 'Native title');
    check('native summary identity is explicit', ai.nativeSessionId === target.sessionId && target.locator.projectId === ai.workspace.projectId && target.locator.workspaceId === a.workspace.id);
    check('private file proof not exposed in snapshot', !JSON.stringify(registry.snapshot()).includes('sessionIdentity') && !JSON.stringify(registry.snapshot()).includes('.jsonl'));
    check('native file proof captured at binding', target.sessionIdentity.ino === fs.statSync(target.sessionLocator).ino);
    const created = ai.createdAt; names.set(a.workspace.id, 'Renamed native');
    await registry.read(ai.owner, { type: 'get_state' });
    check('readback title persists without reorder', registry.snapshot().items.find(i => i.conversationId === a.id).sessionName === 'Renamed native' && registry.snapshot().items.find(i => i.conversationId === a.id).createdAt === created);
    names.set(a.workspace.id, ''); await registry.read(ai.owner, { type: 'get_state' });
    check('empty native title has branch fallback', registry.snapshot().items.find(i => i.conversationId === a.id).title === 'fixture/a');
    check('history reads nested native text only', read(a.id).messages.length === 2 && !JSON.stringify(read(a.id)).includes('SECRET'));
    const classicFile = path.join(nativeRoot, 'classic.jsonl'); write(classicFile, 'classic-native', repo, 'classic needle');
    const result = await search.search('needle');
    check('classic and runtime search coexist', result.results.some(r => !r.locator && r.sessionId === 'classic-native') && result.results.some(r => r.locator?.conversationId === a.id));
    check('current authoritative project excludes other conversation', !result.results.some(r => r.locator?.conversationId === b.id));
    const hit = result.results.find(r => r.locator?.conversationId === a.id);
    check('search result has full explicit native locator', Object.keys(hit.locator).sort().join(',') === 'conversationId,nativeSessionId,projectId,workspaceEpoch,workspaceId');
    check('runtime search never exposes path or fileproof', !JSON.stringify(hit).includes(root) && !JSON.stringify(hit).includes('sessionIdentity') && !JSON.stringify(hit).includes('.jsonl'));
    check('search parser excludes thinking and raw tool args', (await search.search('SECRET')).results.length === 0);
    check('runtime body match retains user turn index', hit.matches.some(m => m.type === 'user' && m.userIndex === 0));
    check('classic archived scope remains separate', !(await search.search('needle', 'archived')).results.some(r => r.locator));
    await registry.close(registry.getOwner(a.id)); const before = children;
    check('dormant history consumes no child', read(a.id).ok && children === before && !registry.getOwner(a.id));
    await worktrees.remove({ id: a.workspace.id, epoch: a.workspace.epoch });
    check('removed workspace retains valid proven native history', read(a.id).ok && children === before);
    check('removed workspace history still searchable by project identity', (await search.search('needle')).results.some(r => r.locator?.conversationId === a.id));
    const routes = createRuntimeRoutes({ registry, readHistory: (file, expected) => readSessionMessages(file, { expected }) });
    const res = { writeHead(code) { this.code = code; }, end(text) { this.body = JSON.parse(text); } };
    await routes.handle({ method: 'GET', url: '/api/runtime-sessions?conversationId=' + a.id }, res);
    check('history HTTP carries validated captured locator', res.code === 200 && res.body.locator.nativeSessionId === target.sessionId && res.body.locator.conversationId === a.id && children === before);
    let currentTarget = target, finishRead, readEntered;
    const heldRead = new Promise(r => finishRead = r), enteredRead = new Promise(r => readEntered = r);
    const heldRoutes = createRuntimeRoutes({ registry: { ...registry, historyTarget: () => currentTarget },
      readHistory: async (file, expected) => { const body = readSessionMessages(file, { expected }); readEntered(); await heldRead; return body; } });
    const lateResponse = { writeHead(code) { this.code = code; }, end(text) { this.body = JSON.parse(text); } };
    const lateHistory = heldRoutes.handle({ method: 'GET', url: '/api/runtime-sessions?conversationId=' + a.id }, lateResponse);
    await enteredRead; currentTarget = { ...target, locator: { ...target.locator, workspaceEpoch: 'replacement' } }; finishRead(); await lateHistory;
    check('late HTTP body rejected after captured locator changes', lateResponse.code === 409 && !lateResponse.body.messages);
    const original = fs.readFileSync(target.sessionLocator, 'utf8');
    write(target.sessionLocator, 'foreign-native', target.cwd, 'foreign needle');
    check('native header identity replacement rejects body', read(a.id).code === 'history_unavailable');
    check('invalid native identity not searchable', !(await search.search('needle')).results.some(r => r.locator?.conversationId === a.id));
    write(target.sessionLocator, target.sessionId, other, 'foreign needle');
    check('native cwd header replacement rejects body', !read(a.id).ok);
    fs.writeFileSync(target.sessionLocator, original); fs.renameSync(target.sessionLocator, target.sessionLocator + '.original'); fs.writeFileSync(target.sessionLocator, original);
    check('same header new file identity rejects body', !read(a.id).ok);
    fs.unlinkSync(target.sessionLocator); fs.renameSync(target.sessionLocator + '.original', target.sessionLocator);
    check('original file identity remains readable', read(a.id).ok);
    const bytes = fs.readFileSync(target.sessionLocator); read(a.id); await search.search('needle');
    check('history and search never rewrite native file', fs.readFileSync(target.sessionLocator).equals(bytes));
    await registry.dispose(); const persistedCount = children; registry = createRuntimeRegistry(options);
    check('app restart history does not spawn', read(a.id).ok && children === persistedCount && registry.snapshot().liveCount === 0);
    check('fileproof/title optional manifest remains v1', JSON.parse(fs.readFileSync(path.join(options.dataDir, 'conversations.json'), 'utf8')).version === 1);
    const legacyManifest = JSON.parse(fs.readFileSync(path.join(options.dataDir, 'conversations.json'), 'utf8'));
    for (const r of legacyManifest.items) { delete r.sessionIdentity; delete r.sessionName; }
    await registry.dispose(); fs.writeFileSync(path.join(options.dataDir, 'conversations.json'), JSON.stringify(legacyManifest)); registry = createRuntimeRegistry(options);
    check('old v1 records compatible with same-fd header proof', read(a.id).ok && registry.snapshot().items.length === 2);
    cwd = other;
    check('switch project uses explicit different membership', (await search.search('needle')).results.some(r => r.locator?.conversationId === b.id) && !(await search.search('needle')).results.some(r => r.locator?.conversationId === a.id));
    cwd = repo; let release, entered; const gate = new Promise(r => release = r), ready = new Promise(r => entered = r);
    const delayed = createSessionSearch({ runtime, sessions, runtimeCandidates: async dir => { entered(); await gate; return candidates(dir); }, readRuntimeCandidate: (t, maxBytes) => readSessionText(t.sessionLocator, { expected: t, maxBytes }) });
    const pending = delayed.search('needle'); await ready; cwd = other; release();
    check('late previous project search does not publish results', (await pending).code === 'stale_workspace');
    const capped = createSessionSearch({ runtime, sessions, runtimeCandidates: candidates, readRuntimeCandidate: (t, maxBytes) => readSessionText(t.sessionLocator, { expected: t, maxBytes }), limits: { maxResults: 1 } });
    check('existing result budget also bounds runtime search', (await capped.search('needle')).results.length <= 1);
    const failedSearch = createSessionSearch({ runtime, sessions: { ...sessions, forSearch: { ...sessions.forSearch, ownedSessions() { throw Error(root + '/private.jsonl'); } } } });
    const safeResponse = { writeHead() {}, end(text) { this.body = text; } };
    failedSearch.handle({ method: 'GET' }, safeResponse, new URL('http://127.0.0.1/api/sessions/search?q=needle')); await tick();
    check('search errors omit private filesystem details', !safeResponse.body.includes(root) && JSON.parse(safeResponse.body).code === 'search_unavailable');
    const raceFile = path.join(root, 'native-read-race.jsonl');
    write(raceFile, 'native-A', repo, 'AAA');
    const raceOriginal = fs.readFileSync(raceFile, 'utf8'), raceReplacement = raceOriginal.replace('native-A', 'native-B').replace('AAA', 'BBB');
    assert.equal(Buffer.byteLength(raceOriginal), Buffer.byteLength(raceReplacement));
    const raceStat = fs.statSync(raceFile), raceExpected = { sessionId: 'native-A', cwd: repo,
      sessionIdentity: { dev: raceStat.dev, ino: raceStat.ino, birthtimeMs: raceStat.birthtimeMs } };
    const originalReadSync = fs.readSync;
    const atBodyRead = action => {
      let calls = 0;
      fs.readSync = function(...args) { if (++calls === 2) action(); return originalReadSync.apply(this, args); };
      try { return readSessionMessages(raceFile, { expected: raceExpected }); }
      finally { fs.readSync = originalReadSync; }
    };
    const raced = atBodyRead(() => fs.writeFileSync(raceFile, raceReplacement));
    check('same-inode native rewrite between proof and body fails closed', !raced.ok && raced.code === 'history_unavailable' && !raced.messages);
    fs.writeFileSync(raceFile, raceOriginal);
    const appended = atBodyRead(() => fs.appendFileSync(raceFile, JSON.stringify(user('APPENDED_NATIVE_A')) + '\n'));
    check('legitimate native append during body read remains valid', appended.ok && appended.messages.some(m => m.text === 'AAA'));
    check('next bounded read includes legitimate appended message', readSessionMessages(raceFile, { expected: raceExpected }).messages.some(m => m.text === 'APPENDED_NATIVE_A'));
    console.log(`Runtime history/search: ${checks}/${checks}`);
  } finally { await registry?.dispose(); worktrees.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
