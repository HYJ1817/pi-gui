// D: count and lease release follow confirmed cleanup, including component barriers.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
(async () => {
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-resource-cleanup-'));
  const tick = () => new Promise(r => setImmediate(r));
  const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
  const pi = gate(), browser = gate(), process = gate();
  let checks = 0, external = 0, failA = true, barriers = false;
  const events = [], children = [];
  const ok = (label, value) => { assert.ok(value, label); checks++; console.log('  ok  ' + label); };
  const reject = (fn, code) => assert.rejects(fn, error => error.code === code);
  const spaces = new Map(['A', 'B', 'C'].map(id => {
    const cwd = path.join(dir, id); fs.mkdirSync(cwd);
    return [id, { projectId: 'p', repoId: 'r', workspaceId: id, workspaceEpoch: id, cwd, root: cwd, branch: id }];
  }));
  const options = { dataDir: path.join(dir, 'data'), externalCount: () => external, publish: e => events.push(e),
    resolveWorkspace: async args => ({ ...spaces.get(args.id) }), validateWorkspace: async () => {},
    factory: async (context, emit) => {
      let cleaned = false;
      const adapter = { context, start: () => emit({ type: 'bridge_status', state: 'ready', bridgeRun: 1 }),
        getState: () => ({ state: 'ready', stop: null }), request: async () => ({ sessionId: 'native-' + context.workspace.workspaceId }),
        async dispose() {
          if (context.workspace.workspaceId === 'A') {
            if (failA) throw Object.assign(Error('cleanup_pending'), { code: 'cleanup_pending' });
            if (barriers) await Promise.all([pi.promise, browser.promise, process.promise]);
          }
          cleaned = true;
        }, cleanupConfirmed: () => cleaned };
      children.push(adapter); return adapter;
    } };
  let registry = createRuntimeRegistry(options);
  const start = (id, extra = {}) => registry.start({ id, epoch: id, ...extra });
  try {
    ok('zero count and unchanged backend limits', registry.snapshot().totalCount === 0 && registry.snapshot().limit === 2 && registry.snapshot().hardLimit === 3);
    external = 1; ok('classic external child occupies one regular slot', registry.snapshot().totalCount === 1 && registry.snapshot().liveCount === 0);
    const a = await start('A'); await tick();
    ok('classic plus A fills regular slots', registry.snapshot().totalCount === 2);
    await reject(() => start('B'), 'runtime_limit');
    ok('unconfirmed third does not spawn', children.length === 1);
    const b = await start('B', { allowThird: true }); await tick();
    ok('confirmed third uses existing backend admission', registry.snapshot().totalCount === 3 && children.length === 2);
    await reject(() => start('C', { allowThird: true }), 'runtime_limit');
    ok('fourth reaches backend rejection without spawn', children.length === 2);
    ok('fourth rejection preserves A and B', registry.getOwner(a.conversationId) && registry.getOwner(b.conversationId));
    await reject(() => registry.close(registry.getOwner(a.conversationId)), 'cleanup_pending');
    const pending = registry.snapshot();
    ok('failed cleanup stays occupied and visibly pending', pending.totalCount === 3 && pending.items.find(i => i.conversationId === a.conversationId).error === 'cleanup_pending');
    ok('failed cleanup retains workspace lease and owner', registry.inUse(spaces.get('A').root) && registry.getOwner(a.conversationId));
    await reject(() => registry.resume(a.conversationId, { allowThird: true }), 'workspace_in_use');
    ok('failed cleanup cannot be replaced by resume', children.length === 2);
    await reject(() => start('C', { allowThird: true }), 'runtime_limit');
    ok('failed cleanup does not donate its slot to C', registry.snapshot().totalCount === 3);
    failA = false; barriers = true;
    const closing = registry.close(registry.getOwner(a.conversationId)); await tick();
    pi.release(); browser.release(); await tick();
    ok('Pi and Browser completion cannot release unfinished Process slot', registry.snapshot().totalCount === 3 && registry.inUse(spaces.get('A').root));
    ok('no close event before all cleanup barriers complete', !events.some(e => e.type === 'runtime_closed' && e.conversationId === a.conversationId));
    process.release(); await closing;
    ok('all cleanup confirmations release slot and lease', registry.snapshot().totalCount === 2 && !registry.inUse(spaces.get('A').root));
    ok('confirmed close keeps dormant conversation without owner', registry.snapshot().items.find(i => i.conversationId === a.conversationId).lifecycle === 'dormant' && !registry.getOwner(a.conversationId));
    await registry.dispose(); registry = createRuntimeRegistry(options);
    ok('app restart discovers dormant records without children', registry.snapshot().liveCount === 0 && registry.snapshot().items.length === 2 && children.length === 2);
  } finally {
    failA = false; pi.release(); browser.release(); process.release();
    await registry.dispose(); fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`Runtime resource cleanup: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
