const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
let checks = 0;
function ok(value) { assert.ok(value); checks++; }
(async () => {
  const {createManagedProcesses,redactProcessLine} = await import('../server/managed-processes.js');
  ok(redactProcessLine('\x1b[32mAuthorization: Bearer hidden\x1b[0m')==='[redacted secret line]');
  ok(redactProcessLine('\x1b[32mVITE ready\x1b[0m')==='VITE ready');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'p31-unit-'));
  let workspace = root, epoch = 1, handles = [];
  const launch = () => {
    const h = new EventEmitter(); h.stop = async () => {h.emit('close',0);};
    handles.push(h); return h;
  };
  const manager = createManagedProcesses({context:()=>({cwd:workspace,workspace:epoch,run:1}),launch});
  try {
    let state = manager.snapshot();
    await assert.rejects(manager.action('start',{command:'node',args:[]},state.generation),/disabled/);checks++;
    manager.enable(true,state.generation);
    const spec={command:'node',args:['fixture.js'],ready:{type:'log',marker:'READY',timeoutMs:1000}};
    const result=await manager.action('start',spec,state.generation);
    ok(result.process.state==='starting'); ok(result.process.revision===1);
    const id=result.process.id;
    handles[0].emit('started');handles[0].emit('log',Buffer.from('Authorization: Bearer very-secret\nREADY\n'));
    const ready=await manager.action('status',{id,revision:1,waitReady:true},state.generation);
    ok(ready.process.state==='ready');
    const duplicate=await manager.action('start',spec,state.generation);ok(duplicate.duplicate);ok(handles.length===1);
    let logs=await manager.action('logs',{id,revision:1},state.generation);ok(!JSON.stringify(logs).includes('very-secret'));
    handles[0].emit('log',Buffer.from('TOKEN=top-secret\nCookie: session=private\n'+'x'.repeat(10000)+'\n'));
    for(let i=0;i<500;i++)handles[0].emit('log',Buffer.from(`line ${i}\n`));
    logs=await manager.action('logs',{id,revision:1,cursor:0},state.generation);ok(logs.truncated);ok(logs.lines.length<=256);ok(!JSON.stringify(logs).includes('top-secret'));
    const restarted=await manager.action('restart',{id,revision:1},state.generation);ok(restarted.process.revision===2);
    await assert.rejects(manager.action('stop',{id,revision:1},state.generation),/stale/);checks++;
    await manager.action('stop',{id,revision:2},state.generation);
    const again=await manager.action('stop',{id,revision:2},state.generation);ok(again.process.state==='exited');
    const a=await manager.action('start',{command:'node',args:[]},state.generation);
    workspace=fs.mkdtempSync(path.join(os.tmpdir(),'p31-other-'));epoch++;
    const next=manager.snapshot();ok(next.generation!==state.generation);ok(!next.enabled);ok(next.processes.length===0);
    await assert.rejects(manager.action('stop',{id:a.process.id,revision:1},state.generation),/stale/);checks++;
    manager.enable(true,next.generation);
    await assert.rejects(manager.action('start',{command:'node',args:[],cwd:root},next.generation),/cwd/);checks++;
    await assert.rejects(manager.action('start',{command:'node',args:[],env:{API_KEY:'private'}},next.generation),/env/);checks++;
    await assert.rejects(manager.action('start',{command:'node',args:[],ready:{type:'http',url:'https://example.com'}},next.generation),/ready/);checks++;
    const pending=await manager.action('start',spec,next.generation);
    const wait=manager.action('status',{id:pending.process.id,revision:1,waitReady:true},next.generation);
    await manager.cancelActions();await assert.rejects(wait,/cancelled/);checks++;
    ok(manager.snapshot().processes.every(p=>!['starting','stopping'].includes(p.state)));
    const retry=await manager.action('start',{command:'node',args:['retry.js']},next.generation);
    const handle=handles.at(-1);handle.emit('started');let attempts=0;
    handle.stop=async()=>{attempts++;if(attempts===1)throw Error('temporary fixture failure');handle.emit('close',0);};
    await assert.rejects(manager.action('stop',{id:retry.process.id,revision:1},next.generation),/stop_unconfirmed/);checks++;
    const stopped=await manager.action('stop',{id:retry.process.id,revision:1},next.generation);ok(attempts===2);ok(stopped.process.state==='exited');
    const resumed=await manager.action('restart',{id:retry.process.id,revision:1},next.generation);ok(resumed.process.revision===2);
    console.log(`Managed processes: ${checks}/${checks}`);
  } finally {await manager.dispose();fs.rmSync(root,{recursive:true,force:true});if(workspace!==root)fs.rmSync(workspace,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
