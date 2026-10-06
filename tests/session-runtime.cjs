const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
let checks = 0; const check = async (name, fn) => { await fn(); checks++; console.log('  ok  ' + name); };
async function until(fn) { const end = Date.now() + 25000; while (!fn()) { if (Date.now() > end) throw Error('fixture_timeout'); await new Promise(r => setTimeout(r, 20)); } }
(async () => {
  let createSessionRuntime; try { ({ createSessionRuntime } = await import('../server/session-runtime.js')); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  await check('固定 workspace runtime factory 可用', () => assert.equal(typeof createSessionRuntime, 'function'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-session-runtime-'));
  const packageDir = path.join(dir, 'node_modules/@earendil-works/pi-coding-agent'); fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.4', bin: { pi: 'cli.cjs' } }));
  const cli = path.join(packageDir, 'cli.cjs');
  fs.writeFileSync(cli, `const rl=require('node:readline').createInterface({input:process.stdin});let streaming=false;const send=v=>console.log(JSON.stringify(v));rl.on('line',line=>{const c=JSON.parse(line);if(c.type==='prompt'){streaming=true;send({type:'agent_start'});}if(c.type==='abort'){streaming=false;send({type:'agent_settled'});}send({type:'response',id:c.id,command:c.type,success:true,data:c.type==='get_state'?{sessionId:require('node:path').basename(process.cwd()),isStreaming:streaming}:c.type==='get_messages'?{messages:[]}:c.type==='prompt'?{disposition:'started'}:{}});});`);
  const aDir = path.join(dir, 'A'), bDir = path.join(dir, 'B'), data = path.join(dir, 'data'); fs.mkdirSync(aDir); fs.mkdirSync(bDir); fs.mkdirSync(data);
  const aEvents = [], bEvents = [], options = { piBin: cli, env: { ...process.env, PI_NO_CONTINUE: '1' }, dataDir: data, browser: null };
  const a = await createSessionRuntime({ ...options, context: { cwd: aDir, owner: { conversationId: 'A' }, isCurrent: () => true }, emit: e => aEvents.push(e) });
  const b = await createSessionRuntime({ ...options, context: { cwd: bDir, owner: { conversationId: 'B' }, isCurrent: () => true }, emit: e => bEvents.push(e) });
  try {
    a.start(); b.start(); await until(() => a.getState().state === 'ready' && b.getState().state === 'ready');
    await check('真实 guardian 两颗 RPC child 独立 ready/sessionId', async () => { assert.equal((await a.request({ type: 'get_state' })).sessionId, 'A'); assert.equal((await b.request({ type: 'get_state' })).sessionId, 'B'); });
    await a.send({ type: 'prompt', id: 'same', message: 'A' }); await b.send({ type: 'prompt', id: 'same', message: 'B' }); await until(() => aEvents.some(e => e.type === 'agent_start') && bEvents.some(e => e.type === 'agent_start'));
    await check('同 id 事件仍在独立发布闭包', () => { assert.equal(aEvents.filter(e => e.type === 'response' && e.id === 'same').length, 1); assert.equal(bEvents.filter(e => e.type === 'response' && e.id === 'same').length, 1); });
    const result = await a.abortAndWait({ type: 'abort' });
    await check('A 权威 Stop 后 B仍streaming', async () => { assert.equal(result.ok, true); assert.equal((await a.request({ type: 'get_state' })).isStreaming, false); assert.equal((await b.request({ type: 'get_state' })).isStreaming, true); });
    await a.dispose();
    await check('A清理整树后 B继续RPC', async () => { assert.equal(a.cleanupConfirmed(), true); assert.equal((await b.request({ type: 'get_state' })).sessionId, 'B'); });
  } finally { await Promise.allSettled([a.dispose(), b.dispose()]); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`Session runtime: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
