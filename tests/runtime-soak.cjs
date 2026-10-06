// Opt-in parallel runtime soak. No model is used: every Pi child is a local
// fixture that speaks the real RPC wire, writes real files and emits real tool
// events. Registry, HTTP routes, SSE, worktrees and managed dev processes are
// the production implementations. This is stability/isolation evidence only —
// it is NOT real-model coding evidence and cannot replace runtime-live.
//
//   PI_GUI_RUNTIME_SOAK=1 PI_GUI_SOAK_MS=1800000 npm run test:runtime-soak
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
if (process.env.PI_GUI_RUNTIME_SOAK !== '1') { console.log('Opt in: PI_GUI_RUNTIME_SOAK=1 npm run test:runtime-soak'); process.exit(0); }

const DURATION = Number(process.env.PI_GUI_SOAK_MS || 1800000);
const GIT = ['ignore', 'pipe', 'pipe'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const { createRuntimeRegistry } = await import('../server/runtime-registry.js');
  const { createRuntimeRoutes } = await import('../server/runtime-routes.js');
  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');
  const { createEventBus } = await import('../server/sse.js');
  const { createSessionRuntime } = await import('../server/session-runtime.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-soak-'));
  const out = process.env.P32_SOAK_OUT || root;
  fs.mkdirSync(out, { recursive: true });
  const report = { platform: process.platform, startedAt: new Date().toISOString(), durationMs: DURATION, rounds: [], samples: [], checks: 0, failures: [] };
  const save = () => fs.writeFileSync(path.join(out, 'runtime-soak.json'), JSON.stringify(report, null, 2));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: GIT }).trim();
  const check = (value, name) => { if (!value) { report.failures.push(name); throw Error('check failed: ' + name); } report.checks++; console.log('PASS ' + name); save(); };
  async function until(fn, timeout = 30000, label = 'soak_timeout') { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await sleep(50); } throw Error(label); }

  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  const mainHead = git(repo, 'rev-parse', 'HEAD');

  const dirs = {}, descriptors = {};
  for (const name of ['A', 'B', 'C', 'D']) {
    const cwd = path.join(root, name); git(repo, 'worktree', 'add', '-b', 'soak-' + name, cwd, 'HEAD');
    dirs[name] = cwd;
    descriptors[name] = { projectId: 'soak-project', repoId: 'soak-repo', workspaceId: 'ws-' + name, workspaceEpoch: 'epoch-1', cwd, root: cwd, branch: 'soak-' + name };
  }
  const agentDir = path.join(root, 'agent'); fs.mkdirSync(agentDir);
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);

  const pkg = path.join(root, 'node_modules/@earendil-works/pi-coding-agent'); fs.mkdirSync(path.join(pkg, 'dist/core/extensions'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.4', bin: { pi: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'dist/core/extensions/types.d.ts'), 'getAllTools() registerTool<');
  const cli = path.join(pkg, 'cli.cjs');
  fs.writeFileSync(cli, String.raw`
const fs=require('fs'),path=require('path'),crypto=require('crypto');
if(process.argv.includes('--version')){console.log('1.0.4');process.exit(0)}
const si=process.argv.indexOf('--session'),restored=si>=0?process.argv[si+1]:null;
const id=restored?JSON.parse(fs.readFileSync(restored,'utf8').split('\n')[0]).id:crypto.randomUUID();
const name=path.basename(process.cwd());
let streaming=false,timer=null;
const send=v=>console.log(JSON.stringify(v));
const folder=path.join(process.env.PI_CODING_AGENT_DIR,'sessions','--'+process.cwd().replace(/[\\/:]/g,'-')+'--');
fs.mkdirSync(folder,{recursive:true});
const file=restored||path.join(folder,new Date().toISOString().replace(/[:.]/g,'-')+'_'+encodeURIComponent(id)+'.jsonl');
if(!restored)fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id,cwd:process.cwd(),timestamp:new Date().toISOString()})+'\n');
require('readline').createInterface({input:process.stdin}).on('line',line=>{
  const c=JSON.parse(line);
  if(c.type==='prompt'&&c.message==='SOAK_CRASH')process.exit(7);
  if(c.type==='prompt'){
    streaming=true;send({type:'agent_start'});
    const m=/^SOAK_(\d+)_(\d+)$/.exec(c.message||'');
    const n=m?Number(m[1]):0,hold=m?Number(m[2]):600,marker='marker-'+name+'-'+n+'.txt';
    const steps=[
      ()=>send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'['+name+'] working '+n+' '}}),
      ()=>send({type:'tool_execution_start',toolCallId:'w-'+name+'-'+n,toolName:'write'}),
      ()=>fs.writeFileSync(path.join(process.cwd(),marker),name+' '+n+'\n'),
      ()=>send({type:'tool_execution_end',toolCallId:'w-'+name+'-'+n,toolName:'write',isError:false}),
      ()=>send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'wrote '+marker+' '}}),
      ()=>send({type:'tool_execution_start',toolCallId:'b-'+name+'-'+n,toolName:'bash'}),
      ()=>send({type:'tool_execution_end',toolCallId:'b-'+name+'-'+n,toolName:'bash',isError:false}),
      ()=>send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'done '+n}}),
    ];
    let i=0;
    const run=()=>{ if(!streaming)return; if(i>=steps.length){streaming=false;send({type:'agent_end'});send({type:'agent_settled'});return;} steps[i++]();timer=setTimeout(run,hold); };
    run();
  }
  if(c.type==='abort'){streaming=false;if(timer)clearTimeout(timer);send({type:'agent_settled'});}
  send({type:'response',id:c.id,command:c.type,success:true,data:c.type==='get_state'?{sessionId:id,sessionFile:file,isStreaming:streaming,messageCount:0,rss:process.memoryUsage().rss}:c.type==='get_messages'?{messages:[]}:c.type==='get_available_models'?{models:[]}:c.type==='get_commands'?{commands:[]}:c.type==='prompt'?{disposition:'started'}:{}});
});
`);

  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_NO_CONTINUE: '1' };
  const validateWorkspace = async ws => {
    const d = Object.values(descriptors).find(x => x.workspaceId === ws.workspaceId);
    if (!d || d.workspaceEpoch !== ws.workspaceEpoch || !fs.existsSync(d.root)) throw Object.assign(Error('stale_workspace'), { code: 'stale_workspace' });
  };
  const resolveWorkspace = async args => { const d = Object.values(descriptors).find(x => x.workspaceId === args.id); if (!d) throw Object.assign(Error('unknown_workspace'), { code: 'unknown_workspace' }); return { ...d }; };
  const bus = createEventBus({});
  const makeRegistry = () => createRuntimeRegistry({
    dataDir, publish: event => bus.publish(event), resolveWorkspace, validateWorkspace,
    factory: (context, emit) => createSessionRuntime({ context, emit, piBin: cli, env, dataDir: path.join(dataDir, 'rt-' + context.workspace.workspaceId) }),
  });

  let registry = makeRegistry();
  const auth = createAuth({ token: 'soak-auth', port: 7799, appId: 'pi-gui', protocol: 1, version: '0.22.0' });
  const legacy = { backendInstance: 'primary', runtimeId: 'classic', runtimeGeneration: '1' };
  const runtimeRoutes = createRuntimeRoutes({ registry, validateWorkspace: ws => validateWorkspace(ws) });
  const router = createRouter({ auth, sse: bus, rpc: { getState: () => ({ state: 'ready' }), send: () => {} },
    runtimeSessions: runtimeRoutes, requireLegacyScope: () => registry.liveCount() > 0, legacyScope: () => legacy });
  let server = http.createServer(router);
  const listen = () => new Promise(r => server.listen(0, '127.0.0.1', r));
  await listen();
  let base = 'http://127.0.0.1:' + server.address().port;
  const post = async (body, endpoint = '/api/runtime-sessions') => {
    const r = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Gui-Token': 'soak-auth' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const snapshot = async () => (await (await fetch(base + '/api/runtime-sessions', { headers: { 'X-Pi-Gui-Token': 'soak-auth' } })).json());

  // SSE client with reconnect; records frames and their sequence numbers.
  const frames = []; let sseAbort = null, sseConnects = 0;
  async function connectSse() {
    sseAbort?.abort(); const controller = new AbortController(); sseAbort = controller;
    const res = await fetch(base + '/api/events', { headers: { 'X-Pi-Gui-Token': 'soak-auth' }, signal: controller.signal });
    sseConnects++;
    (async () => {
      const reader = res.body.getReader(); let buffer = '';
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break;
          buffer += new TextDecoder().decode(value);
          let idx; while ((idx = buffer.indexOf('\n\n')) >= 0) { const chunk = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
            for (const line of chunk.split('\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6))); } }
      } catch { /* aborted on reconnect */ }
    })();
  }

  const startedAt = Date.now();
  const overlap = [];
  const rounds = { coding: 0, focus: 0, stop: 0, crash: 0, limit: 0, process: 0, sse: 0, recycle: 0 };
  let owners = null;

  try {
    await connectSse();
    // ---- start A and B through the real HTTP route ----
    const a = await post({ action: 'start', args: { id: 'ws-A', epoch: 'epoch-1' } });
    const b = await post({ action: 'start', args: { id: 'ws-B', epoch: 'epoch-1' } });
    check(a.body.ok && b.body.ok, 'HTTP start A/B accepted');
    await until(async () => (await snapshot()).items.every(i => i.lifecycle === 'ready' && i.owner?.sessionId), 30000, 'AB ready');
    let snap = await snapshot();
    owners = { A: snap.items.find(i => i.owner?.workspaceId === 'ws-A').owner, B: snap.items.find(i => i.owner?.workspaceId === 'ws-B').owner };
    check(owners.A.runtimeId !== owners.B.runtimeId && owners.A.sessionId !== owners.B.sessionId, 'A/B distinct runtimeId + native sessionId');
    check(owners.A.runtimeGeneration !== owners.B.runtimeGeneration, 'A/B distinct runtimeGeneration');

    const sample = async () => {
      const s = await snapshot();
      const rss = {};
      for (const [k, o] of Object.entries(owners)) { try { const st = await registry.read(o, { type: 'get_state' }); rss[k] = st?.rss ?? null; } catch { rss[k] = null; } }
      report.samples.push({ atMs: Date.now() - startedAt, backendRss: process.memoryUsage().rss, freeMem: os.freemem(), liveCount: s.liveCount, totalCount: s.totalCount, childRss: rss, managed: s.items.map(i => i.owner?.workspaceId || null) });
      save();
    };
    await sample();

    let round = 0;
    while (Date.now() - startedAt < DURATION) {
      round++;
      const t0 = Date.now();
      const kind = round % 8;
      const entry = { round, kind, startedAt: new Date().toISOString() };

      if (kind === 1 || kind === 0) {
        // real parallel work in two worktrees; both sides must be streaming at
        // the same instant at least once, which is the actual overlap evidence
        const n = round * 10;
        const tA = Date.now();
        let bothRunning = false;
        const [ra, rb] = await Promise.all([
          post({ action: 'command', owner: owners.A, command: { type: 'prompt', message: 'SOAK_' + n + '_400' } }),
          post({ action: 'command', owner: owners.B, command: { type: 'prompt', message: 'SOAK_' + (n + 1) + '_400' } }),
        ]);
        check(ra.body.ok && rb.body.ok, 'round ' + round + ': A/B prompt accepted');
        await until(async () => {
          const s = await snapshot();
          const ia = s.items.find(i => i.conversationId === owners.A.conversationId);
          const ib = s.items.find(i => i.conversationId === owners.B.conversationId);
          if (ia?.activity === 'running' && ib?.activity === 'running') bothRunning = true;
          return ia?.activity === 'idle' && ib?.activity === 'idle';
        }, 60000, 'AB settle');
        check(bothRunning, 'round ' + round + ': A and B were streaming at the same instant');
        overlap.push({ round, from: tA, to: Date.now(), bothRunning });
        check(fs.readFileSync(path.join(dirs.A, 'marker-A-' + n + '.txt'), 'utf8').includes('A ' + n), 'round ' + round + ': A wrote only in A worktree');
        check(fs.readFileSync(path.join(dirs.B, 'marker-B-' + (n + 1) + '.txt'), 'utf8').includes('B ' + (n + 1)), 'round ' + round + ': B wrote only in B worktree');
        check(!fs.existsSync(path.join(dirs.A, 'marker-B-' + (n + 1) + '.txt')) && !fs.existsSync(path.join(dirs.B, 'marker-A-' + n + '.txt')), 'round ' + round + ': no cross-worktree writes');
        check(git(repo, 'rev-parse', 'HEAD') === mainHead && git(repo, 'status', '--porcelain') === '', 'round ' + round + ': main HEAD/index/dirty unchanged');
        entry.git = { A: git(dirs.A, 'status', '--porcelain').split('\n').length, B: git(dirs.B, 'status', '--porcelain').split('\n').length };
        rounds.coding++;
      }

      if (kind === 2) {
        // focus switching while B keeps working in the background
        await post({ action: 'command', owner: owners.B, command: { type: 'prompt', message: 'SOAK_' + (round * 10 + 2) + '_900' } });
        for (const seq of ['A', 'B', 'A', 'B']) { const r = await post({ action: 'focus', owner: owners[seq] }); check(r.body.ok, 'round ' + round + ': focus ' + seq); await sleep(150); }
        const s = await snapshot();
        check(s.focusedConversationId === owners.B.conversationId, 'round ' + round + ': focus does not terminate background task');
        await until(async () => (await snapshot()).items.find(i => i.conversationId === owners.B.conversationId).activity === 'idle', 60000, 'B settle after focus churn');
        rounds.focus++;
      }

      if (kind === 3) {
        // authoritative Stop A; B must keep running and finish
        const n = round * 10 + 3;
        await post({ action: 'command', owner: owners.A, command: { type: 'prompt', message: 'SOAK_' + n + '_5000' } });
        await post({ action: 'command', owner: owners.B, command: { type: 'prompt', message: 'SOAK_' + (n + 1) + '_2000' } });
        await until(async () => (await snapshot()).items.find(i => i.conversationId === owners.A.conversationId).activity === 'running', 15000, 'A running');
        const stopped = await post({ action: 'command', owner: owners.A, command: { type: 'abort' } });
        check(stopped.body.ok, 'round ' + round + ': Stop A accepted');
        const s = await snapshot();
        check(s.items.find(i => i.conversationId === owners.A.conversationId).activity === 'idle', 'round ' + round + ': A idle after authoritative Stop');
        check(s.items.find(i => i.conversationId === owners.B.conversationId).activity === 'running', 'round ' + round + ': B still running during A Stop');
        check(!fs.existsSync(path.join(dirs.A, 'marker-A-' + n + '.txt')), 'round ' + round + ': Stop A produced no further tool side effect');
        const toolStarts = () => frames.filter(f => f.type === 'runtime_event' && f.owner?.runtimeId === owners.A.runtimeId && f.event?.type === 'tool_execution_start').length;
        const stoppedSeq = toolStarts();
        await sleep(1500);
        check(!fs.existsSync(path.join(dirs.A, 'marker-A-' + n + '.txt')), 'round ' + round + ': no late A tool write after the authoritative barrier');
        check(toolStarts() === stoppedSeq, 'round ' + round + ': no late A tool execution after Stop');
        await until(async () => (await snapshot()).items.find(i => i.conversationId === owners.B.conversationId).activity === 'idle', 60000, 'B settle after A stop');
        check(fs.readFileSync(path.join(dirs.B, 'marker-B-' + (n + 1) + '.txt'), 'utf8').includes('B'), 'round ' + round + ': B completed after A Stop');
        rounds.stop++;
      }

      if (kind === 4) {
        // single runtime crash + restart; the other must be unaffected
        const n = round * 10 + 4;
        await post({ action: 'command', owner: owners.B, command: { type: 'prompt', message: 'SOAK_' + (n + 1) + '_1500' } });
        await post({ action: 'command', owner: owners.A, command: { type: 'prompt', message: 'SOAK_CRASH' } });
        await until(async () => (await snapshot()).items.find(i => i.conversationId === owners.A.conversationId).lifecycle === 'error', 20000, 'A error after crash');
        const s = await snapshot();
        check(s.items.find(i => i.conversationId === owners.B.conversationId).activity !== 'error', 'round ' + round + ': A crash did not stop B');
        await until(async () => (await snapshot()).items.find(i => i.conversationId === owners.B.conversationId).activity === 'idle', 60000, 'B settle after A crash');
        check(fs.readFileSync(path.join(dirs.B, 'marker-B-' + (n + 1) + '.txt'), 'utf8').includes('B'), 'round ' + round + ': B finished while A crashed');
        const before = owners.A.sessionId;
        const restarted = await post({ action: 'restart', owner: owners.A });
        check(restarted.body.ok, 'round ' + round + ': restart A accepted');
        await until(async () => (await snapshot()).items.find(i => i.conversationId === owners.A.conversationId).lifecycle === 'ready', 30000, 'A ready after restart');
        const after = (await snapshot()).items.find(i => i.conversationId === owners.A.conversationId).owner;
        check(after.sessionId === before && after.runtimeId !== owners.A.runtimeId && after.runtimeGeneration !== owners.A.runtimeGeneration, 'round ' + round + ': restart keeps native session, fresh runtime identity');
        owners.A = after;
        rounds.crash++;
      }

      if (kind === 5) {
        // third runtime explicitly allowed, fourth refused by the hard cap
        const c = await post({ action: 'start', args: { id: 'ws-C', epoch: 'epoch-1', allowThird: true } });
        check(c.body.ok, 'round ' + round + ': explicit third runtime allowed');
        await until(async () => (await snapshot()).items.find(i => i.owner?.workspaceId === 'ws-C')?.lifecycle === 'ready', 30000, 'C ready');
        const cap = await post({ action: 'start', args: { id: 'ws-D', epoch: 'epoch-1', allowThird: true } });
        check(cap.body.ok === false && cap.body.code === 'runtime_limit', 'round ' + round + ': hard cap 3 enforced');
        check(await snapshot().then(s => s.totalCount === 3), 'round ' + round + ': total child count capped at 3');
        const owners3 = (await snapshot()).items;
        const cOwner = owners3.find(i => i.owner?.workspaceId === 'ws-C').owner;
        await post({ action: 'command', owner: cOwner, command: { type: 'prompt', message: 'SOAK_' + (round * 10 + 5) + '_300' } });
        await until(async () => (await snapshot()).items.find(i => i.conversationId === cOwner.conversationId).activity === 'idle', 30000, 'C settle');
        check(fs.readFileSync(path.join(dirs.C, 'marker-C-' + (round * 10 + 5) + '.txt'), 'utf8').includes('C'), 'round ' + round + ': third runtime did real work in its own worktree');
        check((await post({ action: 'close', owner: cOwner })).body.ok, 'round ' + round + ': close third runtime');
        await until(async () => (await snapshot()).liveCount === 2, 20000, 'third runtime released slot');
        rounds.limit++;
      }

      if (kind === 6) {
        // per-runtime managed dev process lifecycle, isolated
        const s = await snapshot();
        const ports = {}, started_ = {};
        for (const name of ['A', 'B']) {
          const owner = s.items.find(i => i.owner?.workspaceId === 'ws-' + name).owner;
          const adapter = registry.getAdapter(owner);
          const manager = adapter.managed.manager;
          const generation = manager.snapshot().generation;
          await manager.enable(true, generation);
          const cwd = dirs[name];
          fs.writeFileSync(path.join(cwd, 'worker.cjs'), 'const s=require("http").createServer((_q,r)=>r.end(' + JSON.stringify(name) + '));s.listen(0,"127.0.0.1",()=>console.log("READY "+s.address().port));');
          const started = await manager.action('start', { command: process.execPath, args: ['worker.cjs'], ready: { type: 'log', marker: 'READY', timeoutMs: 8000 } }, generation);
          check(started.ok, 'round ' + round + ': managed process ready ' + name);
          // Always resolve a process by id: earlier rounds leave exited records
          // behind, so index 0 is not necessarily this start.
          const stateOf = () => manager.snapshot().processes.find(p => p.id === started.process.id)?.state;
          await until(() => stateOf() === 'ready', 15000, 'process ready ' + name);
          const logs = await manager.action('logs', { id: started.process.id, revision: started.process.revision, cursor: 0 }, generation);
          const readyLine = logs.lines.find(l => /^READY \d+/.test(l.text));
          if (!readyLine) { report.processLogDump = logs.lines.slice(-8); save(); }
          ports[name] = Number(readyLine.text.split(' ')[1]);
          started_[name] = started.process;
        }
        check(ports.A !== ports.B, 'round ' + round + ': two runtimes own distinct ports');
        check(await (await fetch('http://127.0.0.1:' + ports.A)).text() === 'A' && await (await fetch('http://127.0.0.1:' + ports.B)).text() === 'B', 'round ' + round + ': dev servers serve their own workspace');
        const ownerA = s.items.find(i => i.owner?.workspaceId === 'ws-A').owner, managerA = registry.getAdapter(ownerA).managed.manager;
        const generationA = managerA.snapshot().generation, listA = started_.A;
        const stale = await managerA.action('stop', { id: listA.id, revision: listA.revision + 99 }, generationA).catch(e => ({ ok: false, code: e.code }));
        check(stale.ok === false && stale.code === 'stale_process', 'round ' + round + ': stale process revision refused');
        await managerA.action('stop', { id: listA.id, revision: listA.revision }, generationA);
        await until(async () => { try { await fetch('http://127.0.0.1:' + ports.A); return false; } catch { return true; } }, 15000, 'A process closed');
        check(await (await fetch('http://127.0.0.1:' + ports.B)).text() === 'B', 'round ' + round + ': stop A process leaves B serving');
        const ownerB = s.items.find(i => i.owner?.workspaceId === 'ws-B').owner, managerB = registry.getAdapter(ownerB).managed.manager;
        const generationB = managerB.snapshot().generation, listB = started_.B;
        await managerB.action('stop', { id: listB.id, revision: listB.revision }, generationB);
        await until(async () => { try { await fetch('http://127.0.0.1:' + ports.B); return false; } catch { return true; } }, 15000, 'B process closed');
        rounds.process++;
      }

      if (kind === 7) {
        // SSE reconnect under load: sequences must stay monotonic and gap-free
        await post({ action: 'command', owner: owners.A, command: { type: 'prompt', message: 'SOAK_' + (round * 10 + 7) + '_1200' } });
        await sleep(300);
        await connectSse();
        await until(async () => (await snapshot()).items.find(i => i.conversationId === owners.A.conversationId).activity === 'idle', 60000, 'A settle after SSE reconnect');
        const cur = owners.A;
        const live = frames.filter(f => !f._replay && f.type === 'runtime_event' && f.owner?.runtimeId === cur.runtimeId && f.owner?.runtimeGeneration === cur.runtimeGeneration);
        const seqs = live.map(f => f.eventSequence);
        let monotonic = true; for (let i = 1; i < seqs.length; i++) if (seqs[i] <= seqs[i - 1]) monotonic = false;
        check(monotonic && seqs.length >= 2, 'round ' + round + ': SSE reconnect kept live eventSequence monotonic (replays excluded)');
        check(frames.filter(f => f._replay).every(f => f.owner?.runtimeId), 'round ' + round + ': replayed frames are marked and still carry an owner');
        check(frames.filter(f => f.type === 'runtime_event').every(f => f.owner?.runtimeId && f.owner?.conversationId), 'round ' + round + ': every runtime event carries a full owner');
        rounds.sse++;
      }

      entry.elapsedMs = Date.now() - t0;
      report.rounds.push(entry); save();
      await sample();
      console.log('PROGRESS round=' + round + ' kind=' + kind + ' t=' + Math.round((Date.now() - startedAt) / 1000) + 's');
    }

    report.roundsRun = round;
    report.roundCounts = { ...rounds };
    // A full 30-minute run must exercise every dimension repeatedly; a short
    // validation run only has to touch each one once.
    const need = DURATION >= 1500000 ? 6 : 1;
    check(rounds.coding >= need && rounds.focus >= 1 && rounds.stop >= 1 && rounds.crash >= 1 && rounds.limit >= 1 && rounds.process >= 1 && rounds.sse >= 1, 'soak covered all required dimensions');
    const intervals = overlap.sort((x, y) => x.from - y.from);
    const overlapping = intervals.filter(iv => iv.bothRunning).length;
    report.overlapIntervals = intervals;
    check(overlapping >= (DURATION >= 1500000 ? 5 : 1), 'A/B work intervals actually overlapped');

    // ---- lease/slot recycling ----
    const ownerA = owners.A;
    await post({ action: 'close', owner: ownerA });
    await until(async () => (await snapshot()).liveCount === 1, 20000, 'close released slot');
    check(registry.inUse(dirs.A) === false, 'closed runtime released workspace lease');
    check(registry.liveCount() === 1, 'closed runtime released registry slot');
    rounds.recycle++;

    // ---- backend restart: native session rediscovery from disk ----
    const persisted = await snapshot();
    const bOwner = persisted.items.find(i => i.owner?.workspaceId === 'ws-B').owner;
    await registry.dispose();
    server.closeAllConnections(); await new Promise(r => server.close(r));
    registry = makeRegistry();
    const routes2 = createRuntimeRoutes({ registry, validateWorkspace });
    const router2 = createRouter({ auth, sse: bus, rpc: { getState: () => ({ state: 'ready' }), send: () => {} },
      runtimeSessions: routes2, requireLegacyScope: () => registry.liveCount() > 0, legacyScope: () => legacy });
    server = http.createServer(router2); await listen(); base = 'http://127.0.0.1:' + server.address().port;
    const after = await snapshot();
    const dormant = after.items.find(i => i.conversationId === bOwner.conversationId);
    check(after.liveCount === 0 && dormant && dormant.lifecycle === 'dormant' && dormant.owner === null, 'restart rediscovered conversations as dormant without spawning');
    const resumed = await post({ action: 'resume', conversationId: bOwner.conversationId, allowThird: true });
    check(resumed.body.ok, 'resume after backend restart accepted');
    await until(async () => (await snapshot()).items.find(i => i.conversationId === bOwner.conversationId)?.lifecycle === 'ready', 30000, 'resumed ready');
    const resumedOwner = (await snapshot()).items.find(i => i.conversationId === bOwner.conversationId).owner;
    check(resumedOwner.sessionId === bOwner.sessionId, 'resume rebound the same native Pi session');
    check(resumedOwner.runtimeGeneration !== bOwner.runtimeGeneration, 'resume allocated a fresh runtime generation');

    // ---- final cleanup ----
    await post({ action: 'close', owner: resumedOwner });
    await until(async () => (await snapshot()).liveCount === 0, 20000, 'all runtimes closed');
    await registry.dispose(); bus.closeAll(); server.closeAllConnections(); await new Promise(r => server.close(r));
    sseAbort?.abort();
    check(registry.liveCount() === 0, 'no live runtime after dispose');
    report.endedAt = new Date().toISOString(); report.elapsedMs = Date.now() - startedAt;
    report.sseConnects = sseConnects; report.frames = frames.length;
    report.ok = true;
  } catch (error) {
    report.ok = false; report.error = error.message; save();
    try { await registry.dispose(); } catch {}
    // The listening HTTP server (and SSE client) hold the event loop open; a
    // failure path that leaves them running would never let the process exit.
    try { sseAbort?.abort(); bus.closeAll(); server.closeAllConnections(); await new Promise(r => server.close(r)); } catch {}
    throw error;
  } finally {
    save();
    if (!process.env.P32_SOAK_KEEP) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  console.log('Soak evidence: ' + path.join(out, 'runtime-soak.json'));
})().catch(error => { console.error('Runtime soak failed: ' + (error.message || error)); process.exitCode = 1; });
