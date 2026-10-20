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
  fs.writeFileSync(cli, String.raw`
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});
const name=path.basename(process.cwd()),file=path.join(process.cwd(),'fixture-session.jsonl');let streaming=false;
const send=v=>console.log(JSON.stringify(v)),append=message=>fs.appendFileSync(file,JSON.stringify({type:'message',id:name+Date.now(),message})+'\n');
fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:name,cwd:process.cwd()})+'\n');
rl.on('line',line=>{const c=JSON.parse(line);
 if(c.type==='prompt'){
  streaming=true;append({role:'user',content:[{type:'text',text:c.message}]});send({type:'agent_start'});
  send({type:'message_start',message:{role:'assistant',content:[]}});
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'output-'+name}});
  const message={role:'assistant',content:[{type:'text',text:'output-'+name}],usage:{input:name==='A'?11:22,output:1,totalTokens:name==='A'?12:23}};
  append(message);send({type:'message_end',message});
  send({type:'tool_execution_start',toolCallId:'shared-tool',toolName:'read'});
  send({type:'extension_ui_request',id:'shared-approval',method:'confirm',title:'permission-'+name});
 }
 if(c.type==='extension_ui_response'&&c.id==='shared-approval'){
  append({role:'assistant',content:[{type:'text',text:'finished-'+name}]});
  send({type:'tool_execution_end',toolCallId:'shared-tool',toolName:'read',isError:false});streaming=false;send({type:'agent_settled'});
 }
 if(c.type==='abort'){streaming=false;send({type:'agent_settled'});}
 const data=c.type==='get_state'?{sessionId:name,sessionFile:file,isStreaming:streaming}:c.type==='get_messages'?{messages:fs.readFileSync(file,'utf8').trim().split('\n').slice(1).map(v=>JSON.parse(v).message)}:c.type==='prompt'?{disposition:'started'}:{};
 send({type:'response',id:c.id,command:c.type,success:true,data});
});`);
  const aDir = path.join(dir, 'A'), bDir = path.join(dir, 'B'), data = path.join(dir, 'data'); fs.mkdirSync(aDir); fs.mkdirSync(bDir); fs.mkdirSync(data);
  const aEvents = [], bEvents = [], options = { piBin: cli, env: { ...process.env, PI_NO_CONTINUE: '1' }, dataDir: data, browser: null };
  const a = await createSessionRuntime({ ...options, context: { cwd: aDir, owner: { conversationId: 'A' }, isCurrent: () => true }, emit: e => aEvents.push(e) });
  const b = await createSessionRuntime({ ...options, context: { cwd: bDir, owner: { conversationId: 'B' }, isCurrent: () => true }, emit: e => bEvents.push(e) });
  try {
    a.start(); b.start(); await until(() => a.getState().state === 'ready' && b.getState().state === 'ready');
    await check('真实 guardian 两颗 RPC child 独立 ready/sessionId', async () => { assert.equal((await a.request({ type: 'get_state' })).sessionId, 'A'); assert.equal((await b.request({ type: 'get_state' })).sessionId, 'B'); });
    await a.send({ type: 'prompt', id: 'same', message: 'A' }); await b.send({ type: 'prompt', id: 'same', message: 'B' }); await until(() => aEvents.some(e => e.type === 'agent_start') && bEvents.some(e => e.type === 'agent_start'));
    await check('同 id 事件仍在独立发布闭包', () => { assert.equal(aEvents.filter(e => e.type === 'response' && e.id === 'same').length, 1); assert.equal(bEvents.filter(e => e.type === 'response' && e.id === 'same').length, 1); });
    await until(() => aEvents.some(e => e.type === 'extension_ui_request') && bEvents.some(e => e.type === 'extension_ui_request'));
    await check('真实 RPC 两条输出、Token 与相同 tool/request ID 不串线', () => {
      assert.ok(aEvents.some(e => e.assistantMessageEvent?.delta === 'output-A'));
      assert.ok(!aEvents.some(e => e.assistantMessageEvent?.delta === 'output-B'));
      assert.equal(aEvents.find(e => e.type === 'message_end').message.usage.input, 11);
      assert.equal(bEvents.find(e => e.type === 'message_end').message.usage.input, 22);
      assert.equal(aEvents.find(e => e.type === 'extension_ui_request').title, 'permission-A');
      assert.equal(bEvents.find(e => e.type === 'extension_ui_request').title, 'permission-B');
    });
    const result = await a.abortAndWait({ type: 'abort' });
    await check('A 权威 Stop 后 B仍streaming', async () => { assert.equal(result.ok, true); assert.equal((await a.request({ type: 'get_state' })).isStreaming, false); assert.equal((await b.request({ type: 'get_state' })).isStreaming, true); });
    await check('Stop A 使旧审批失效而 B 的同 ID 审批仍可独立完成', async () => {
      await assert.rejects(() => a.send({ type: 'extension_ui_response', id: 'shared-approval', confirmed: true }), e => e.code === 'stale_approval');
      await b.send({ type: 'extension_ui_response', id: 'shared-approval', confirmed: true });
      await until(() => bEvents.some(e => e.type === 'agent_settled'));
      assert.equal((await b.request({ type: 'get_state' })).isStreaming, false);
      const messages = (await b.request({ type: 'get_messages' })).messages;
      assert.ok(messages.some(m => m.content?.some(p => p.text === 'finished-B')));
      assert.ok(!fs.readFileSync(path.join(aDir, 'fixture-session.jsonl'), 'utf8').includes('finished-B'));
    });
    await a.dispose();
    await check('A清理整树后 B继续RPC', async () => { assert.equal(a.cleanupConfirmed(), true); assert.equal((await b.request({ type: 'get_state' })).sessionId, 'B'); });
  } finally { await Promise.allSettled([a.dispose(), b.dispose()]); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`Session runtime: ${checks}/${checks}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
