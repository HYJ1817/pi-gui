const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
async function main() {
  const { createRpcBridge } = await import('../server/rpc-bridge.js');
  const { createEventBus } = await import('../server/sse.js');
  let cwd = 'fixture-workspace', shutdown = false, child;
  const events = [];
  const rpc = createRpcBridge({ runtime: { getCurrentCwd: () => cwd, isShuttingDown: () => shutdown },
    publish: e => events.push(e), piBin: 'fixture-pi', isWin: false,
    spawnProcess: () => {
      child = new EventEmitter(); child.pid = 42;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.stdin = { on() {}, write(line) { child.command = JSON.parse(line); }, end() {} };
      child.kill = () => {};
      return child;
    } });
  let n = 0;
  function check(value, label) { assert.ok(value, label); n++; console.log('ok', label); }
  rpc.start();
  check(rpc.getState().bridgeState === 'starting', 'authoritative starting snapshot');
  child.emit('spawn');
  check(rpc.getState().bridgeState === 'starting', 'shell spawn and PID do not prove Pi ready');
  child.stdout.emit('data', JSON.stringify({ type: 'response', id: child.command.id, command: 'get_state', success: true, data: { sessionId: 'fixture' } }) + '\n');
  await new Promise(r => setImmediate(r));
  check(rpc.getState().bridgeState === 'ready', 'private RPC handshake proves ready');
  check(!events.some(e => e.type === 'response'), 'internal handshake never enters Renderer stream');
  const bus = createEventBus({ getBridgeSnapshot: () => rpc.getState() });
  bus.publish(events.at(-1));
  for (let i = 0; i < 805; i++) bus.publish({ type: 'fixture_event', i });
  check(!bus.backlog().some(e => e.state === 'ready'), 'original ready evicted from bounded backlog');
  const req = new EventEmitter(), frames = [];
  bus.subscribe(req, { writeHead() {}, write(s) { if (s.startsWith('data:')) frames.push(JSON.parse(s.slice(6))); }, end() {} });
  check(frames.at(-1).type === 'bridge_snapshot' && frames.at(-1).bridgeState === 'ready', 'fresh SSE gets current ready after replay');
  check(frames.length === 801 && !('_seq' in frames.at(-1)), 'snapshot is not a historical business event');
  req.emit('close'); bus.closeAll();
  rpc.restart();
  check(rpc.getState().piRunning && rpc.getState().bridgeState === 'restarting', 'child presence during restart does not mean ready');
  shutdown = true; child.emit('exit', 0, null);
  check(rpc.getState().bridgeState === 'exited', 'exited snapshot survives refresh');
  cwd = ''; shutdown = false; rpc.start();
  check(rpc.getState().bridgeState === 'no-project' && !rpc.getState().hasProject, 'no-project snapshot');
  const broken = createRpcBridge({ runtime: { getCurrentCwd: () => 'fixture', isShuttingDown: () => false }, publish() {}, piBin: 'fixture', isWin: false,
    spawnProcess() { throw Error('SECRET fixture launch path'); } });
  broken.start();
  check(broken.getState().bridgeState === 'error' && !JSON.stringify(broken.getState()).includes('SECRET'), 'launch error snapshot uses safe fixed fields');
  function outputFixture(limit) {
    let worker, stopped = 0;
    const observed = [], bridge = createRpcBridge({ runtime: { getCurrentCwd: () => 'fixture', isShuttingDown: () => false },
      publish: e => observed.push(e), piBin: 'fixture', isWin: false, autoRestart: false,
      ...(limit === undefined ? {} : { maxOutputLineBytes: limit }),
      spawnProcess() {
        worker = new EventEmitter();worker.stdout = new EventEmitter();worker.stderr = new EventEmitter();
        worker.stdout.setEncoding = worker.stderr.setEncoding = () => {};
        worker.stdin = { on() {}, write(line) { worker.command = JSON.parse(line); }, end() {} };
        worker.kill = () => { stopped++;worker.emit('exit', 0, null); };return worker;
      } });
    bridge.start();worker.emit('spawn');
    worker.stdout.emit('data', JSON.stringify({ type: 'response', id: worker.command.id, command: 'get_state', success: true, data: {} }) + '\n');
    return { bridge, worker, observed, stopped: () => stopped };
  }
  const packed = outputFixture(256);
  packed.worker.stdout.emit('data', Array.from({ length: 6 }, (_, i) => JSON.stringify({ type: 'fixture_output', i, text: '中🙂'.repeat(5) }) + '\n').join(''));
  check(packed.stopped() === 0 && packed.observed.filter(e => e.type === 'fixture_output').length === 6, 'stdout limit applies per line, not aggregate transport chunk');packed.bridge.stop();
  const exact = outputFixture(256), base = JSON.stringify({ type: 'fixture_output', text: '中🙂' });
  const exactLine = JSON.stringify({ type: 'fixture_output', text: '中🙂' + 'x'.repeat(256 - Buffer.byteLength(base)) });
  check(Buffer.byteLength(exactLine) === 256, 'Unicode stdout fixture uses byte-exact boundary');
  exact.worker.stdout.emit('data', exactLine.slice(0, 100));exact.worker.stdout.emit('data', exactLine.slice(100) + '\n');
  check(exact.stopped() === 0 && exact.observed.some(e => e.type === 'fixture_output'), 'byte-limit JSON line accepts LF delimiter outside payload budget');exact.bridge.stop();
  const crlf = outputFixture(256);crlf.worker.stdout.emit('data', exactLine + '\r\n');
  check(crlf.stopped() === 0 && crlf.observed.some(e => e.type === 'fixture_output'), 'byte-limit JSON line accepts complete CRLF outside payload budget');crlf.bridge.stop();
  const splitCrlf = outputFixture(256);splitCrlf.worker.stdout.emit('data', exactLine + '\r');splitCrlf.worker.stdout.emit('data', '\n');
  check(splitCrlf.stopped() === 0 && splitCrlf.observed.some(e => e.type === 'fixture_output'), 'split CRLF transport preserves exact payload boundary');splitCrlf.bridge.stop();
  const flooded = outputFixture(256);flooded.worker.stdout.emit('data', 'PRIVATE_FIXTURE_' + 'x'.repeat(256 - Buffer.byteLength('PRIVATE_FIXTURE_')));
  check(flooded.stopped() === 0, 'stdout incomplete line remains accepted at exact byte limit');
  flooded.worker.stdout.emit('data', 'x');
  check(flooded.stopped() === 1 && flooded.observed.some(e => e.type === 'bridge_status' && e.state === 'error'), 'stdout no-LF overflow fails closed and terminates owned child');
  check(!JSON.stringify(flooded.observed).includes('PRIVATE_FIXTURE'), 'stdout overflow emits fixed safe error, never buffered payload');
  const completeOverflow = outputFixture(256);completeOverflow.worker.stdout.emit('data', exactLine.replace('中🙂', '中🙂x') + '\n');
  check(completeOverflow.stopped() === 1 && !completeOverflow.observed.some(e => e.type === 'fixture_output'), 'complete oversized JSON line is rejected before publish');
  const larger = outputFixture();larger.worker.stdout.emit('data', JSON.stringify({ type: 'fixture_output', text: '中🙂'.repeat(170000) }) + '\n');
  check(larger.stopped() === 0 && larger.observed.some(e => e.type === 'fixture_output' && e.text.length === 510000), 'default stdout budget accepts existing responses above one MiB');larger.bridge.stop();
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs'), path = require('node:path');
  const { bundle } = require('./esm-bundle.cjs');
  const pub = path.resolve(__dirname, '../public');
  const app = bundle(path.join(pub, 'app.js')).code;
  async function browser(state) {
    const dom = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), { url: 'http://fixture', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window, calls = [], recoveryTimers = [];
    const nativeTimer = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...args) => {
      if (ms === 10000 || ms === 20000) { recoveryTimers.push(fn); return nativeTimer(() => {}, 60000); }
      return nativeTimer(fn, ms, ...args);
    };
    let current = { ok: true, cwd: 'C:\\fixture', hasProject: true, bridgeInstance: 'fixture-server-1', bridgeRun: 5, bridgeRevision: 10,
      bridgeState: state, piRunning: true, maintenance: state === 'maintenance' ? { reason: 'pi-update' } : null,
      bridgeError: state === 'error' ? 'safe launch failure' : '', bridgeHint: 'safe hint' };
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.ResizeObserver = class { observe() {} disconnect() {} };
    w.HTMLElement.prototype.scrollIntoView = () => {};
    w.EventSource = class { constructor() { w.events = this; } close() {} emit(e) { this.onmessage({ data: JSON.stringify(e) }); } };
    w.fetch = async (url, opts = {}) => {
      calls.push([String(url), opts]);
      let value = { ok: true };
      if (url === '/api/status') value = current;
      else if (url === '/api/projects') value = { ok: true, active: current.cwd, items: [] };
      else if (url === '/api/sessions') value.sessions = [];
      else if (url === '/api/provider-auth') value = { ok: true, capability: {}, providers: [], sync: {} };
      return { ok: true, json: async () => value };
    };
    w.eval(app); await new Promise(r => setTimeout(r, 20));
    return { dom, w, calls, recoveryTimers, setStatus: x => { current = { ...current, ...x }; } };
  }
  for (const state of ['ready', 'starting', 'restarting', 'maintenance', 'exited', 'error']) {
    const b = await browser(state);
    check(b.w.S.bridgeState === state, `refresh independently restores ${state}`);
    check(b.w.el.input.disabled === !['ready', 'maintenance'].includes(state), `composer follows authoritative ${state}, not piRunning`);
    b.w.events.onopen();
    check(state === 'ready' ? b.w.el.connText.textContent === '已连接' : b.w.el.connText.textContent !== '已连接', `SSE open does not invent ready during ${state}`);
    b.dom.window.close();
  }
  const b = await browser('ready');
  check(b.w.el.input.placeholder !== '等待 pi 就绪…', 'fresh ready Browser needs no historical ready');
  const commands = () => b.calls.filter(([u]) => u === '/api/command').length;
  const before = commands(); b.w.el.input.value = '正在输入的草稿';
  b.w.events.emit({ type: 'bridge_snapshot', bridgeState: 'ready', cwd: 'C:\\fixture', hasProject: true, bridgeRun: 5, bridgeRevision: 10 });
  check(commands() === before && b.w.el.input.value === '正在输入的草稿', 'duplicate ready does not reboot or overwrite draft');
  b.w.events.emit({ type: 'bridge_status', state: 'exited', bridgeRun: 4, bridgeRevision: 9 });
  check(b.w.S.bridgeState === 'ready', 'stale run rejected');
  b.w.events.emit({ type: 'bridge_status', state: 'exited', bridgeRun: 5, bridgeRevision: 9 });
  check(b.w.S.bridgeState === 'ready', 'stale same-run revision rejected');
  b.w.events.emit({ type: 'bridge_status', state: 'exited', bridgeRun: 5, _replay: true });
  check(b.w.S.bridgeState === 'ready', 'historical lifecycle never overwrites status');
  b.w.events.onerror();
  check(b.w.S.bridgeState === 'ready' && b.w.S.transportOnline === false && b.w.el.connText.textContent.includes('后端连接断开'), 'transport loss preserves Pi lifecycle');
  b.w.events.onopen(); b.w.events.emit({ type: 'bridge_snapshot', bridgeState: 'ready', bridgeRun: 5, bridgeRevision: 10 });
  check(b.w.el.connText.textContent === '已连接' && commands() === before, 'reconnect restores ready idempotently');
  b.w.events.emit({ type: 'bridge_snapshot', bridgeState: 'ready', cwd: 'C:\\fixture', hasProject: true, bridgeInstance: 'fixture-server-2', bridgeRun: 1, bridgeRevision: 2 });
  check(b.w.S.bridgeRun === 1 && commands() > before, 'new backend instance accepts reset counters and boots once');
  b.w.events.emit({ type: 'bridge_status', state: 'exited', bridgeInstance: 'fixture-server-1', bridgeRun: 6, bridgeRevision: 12 });
  check(b.w.S.bridgeState === 'ready' && b.w.S.bridgeInstance === 'fixture-server-2', 'old instance live event cannot revive previous epoch');
  await new Promise(r => setTimeout(r, 20));
  b.dom.window.close();
  const delayedBrowser = await browser('starting');
  delayedBrowser.recoveryTimers[0](); await new Promise(r => setTimeout(r, 20));
  check(delayedBrowser.w.document.querySelector('#stageNotice').textContent.includes('Pi 状态同步时间过长'), 'overdue notice is visible in real Renderer state machine');
  const buttons = [...delayedBrowser.w.document.querySelectorAll('#stageNotice button')];
  const readBefore = delayedBrowser.calls.filter(([u]) => u === '/api/status').length;
  delayedBrowser.setStatus({ bridgeState: 'ready', bridgeRevision: 11 });
  buttons.find(e => e.textContent === '重新同步状态').click(); await new Promise(r => setTimeout(r, 20));
  check(delayedBrowser.w.S.bridgeState === 'ready' && delayedBrowser.calls.filter(([u]) => u === '/api/status').length === readBefore + 1 && !delayedBrowser.calls.some(([u]) => u === '/api/restart'), 'resync button restores ready without restart');
  buttons.find(e => e.textContent === '重启 Pi').click();
  check(!delayedBrowser.w.document.querySelector('#confirmLayer').hidden && !delayedBrowser.calls.some(([u]) => u === '/api/restart'), 'recovery restart uses existing confirmed restartPi');
  delayedBrowser.dom.window.close();
  const { createBridgeRecovery } = await import('../public/bridge-recovery.js');
  let status = { state: 'ready', hasProject: true, bridgeRun: 2 }, reads = 0, reconciled, delayed = false;
  const jobs = new Map(); let id = 0;
  const recovery = createBridgeRecovery({ readStatus: async () => { reads++; return status; }, reconcile: s => { reconciled = s; recovery.observe(s); }, overdue: v => { delayed = v; }, schedule: fn => { jobs.set(++id, fn); return id; }, cancel: i => jobs.delete(i) });
  recovery.observe({ state: 'starting', hasProject: true, bridgeRun: 2 });
  recovery.observe({ state: 'starting', hasProject: true, bridgeRun: 2 });
  check(jobs.size === 2, 'duplicates do not extend watchdog or add polling');
  [...jobs.values()][0](); await new Promise(r => setImmediate(r));
  check(reads === 1 && reconciled.state === 'ready' && !delayed && jobs.size === 0, 'watchdog status ready self-heals without restart');
  status = { state: 'starting', hasProject: true, bridgeRun: 3 }; recovery.observe(status);
  const callbacks = [...jobs.values()]; callbacks[0](); await new Promise(r => setImmediate(r)); callbacks[1](); await new Promise(r => setImmediate(r));
  check(reads === 3 && reconciled.state === 'starting' && delayed, 'two bounded probes never fake ready');
  await recovery.probe(); check(reads === 4, 'manual resync only reads status'); recovery.dispose();
  console.log(`${n}/${n} bridge-state-recovery passed`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
