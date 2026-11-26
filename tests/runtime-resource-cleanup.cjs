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
    const initial = registry.snapshot();
    ok('zero actual count and no numeric or sentinel quota fields', initial.totalCount === 0 && !Object.hasOwn(initial, 'limit') && !Object.hasOwn(initial, 'hardLimit'));
    external = 1; ok('classic external child is counted without reserving admission', registry.snapshot().totalCount === 1 && registry.snapshot().liveCount === 0);
    const a = await start('A'); await tick();
    ok('classic plus A has actual total count two', registry.snapshot().totalCount === 2);
    const b = await start('B'); await tick();
    ok('third total child starts without confirmation', children.length === 2);
    ok('actual total includes independent B', registry.snapshot().totalCount === 3 && registry.liveCount() === 2);
    ok('admitting B preserves both native owners', registry.getOwner(a.conversationId).sessionId === 'native-A' && registry.getOwner(b.conversationId).sessionId === 'native-B');
    const peer = registry.getOwner(b.conversationId);
    await reject(() => registry.close(registry.getOwner(a.conversationId)), 'cleanup_pending');
    const pending = registry.snapshot();
    ok('failed cleanup stays counted and visibly pending', pending.totalCount === 3 && pending.items.find(i => i.conversationId === a.conversationId).error === 'cleanup_pending');
    ok('failed cleanup retains workspace lease and owner', registry.inUse(spaces.get('A').root) && registry.getOwner(a.conversationId));
    await reject(() => registry.resume(a.conversationId), 'workspace_in_use');
    ok('failed cleanup cannot be replaced by resume', children.length === 2);
    await reject(() => start('A'), 'workspace_in_use');
    ok('failed cleanup cannot be bypassed by a fresh conversation on the same workspace', children.length === 2);
    const c = await start('C'); await tick();
    ok('unrelated C can start despite A cleanup failure and more than three total children', registry.snapshot().totalCount === 4 && children.length === 3);
    ok('new independent runtime cannot release the failed lease or mutate B owner', registry.inUse(spaces.get('A').root) && JSON.stringify(registry.getOwner(b.conversationId)) === JSON.stringify(peer));
    failA = false; barriers = true;
    const closing = registry.close(registry.getOwner(a.conversationId)); await tick();
    pi.release(); browser.release(); await tick();
    ok('Pi and Browser completion cannot release unfinished Process ownership', registry.snapshot().totalCount === 4 && registry.inUse(spaces.get('A').root));
    ok('no close event before all cleanup barriers complete', !events.some(e => e.type === 'runtime_closed' && e.conversationId === a.conversationId));
    process.release(); await closing;
    ok('all cleanup confirmations release only A count and lease', registry.snapshot().totalCount === 3 && !registry.inUse(spaces.get('A').root));
    ok('confirmed close keeps dormant conversation without owner', registry.snapshot().items.find(i => i.conversationId === a.conversationId).lifecycle === 'dormant' && !registry.getOwner(a.conversationId));
    ok('B and C remain owned after A completes cleanup', JSON.stringify(registry.getOwner(b.conversationId)) === JSON.stringify(peer) && registry.getOwner(c.conversationId).sessionId === 'native-C');
    await registry.dispose(); registry = createRuntimeRegistry(options);
    ok('app restart discovers every dormant record without children', registry.snapshot().liveCount === 0 && registry.snapshot().items.length === 3 && children.length === 3);
  } finally {
    failA = false; pi.release(); browser.release(); process.release();
    await registry.dispose(); fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`Runtime resource cleanup: ${checks}/${checks}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
