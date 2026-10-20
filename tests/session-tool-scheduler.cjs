const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
let passed = 0;
const tick = () => new Promise(r => setImmediate(r));
async function check(name, run) { await run(); passed++; console.log('PASS '+name); }
(async()=>{
  let createSessionToolScheduler;
  try { ({createSessionToolScheduler}=await import('../server/session-tool-scheduler.js')); } catch(e) { if(e.code!=='ERR_MODULE_NOT_FOUND')throw e; }
  assert.equal(typeof createSessionToolScheduler,'function','shared workspace tool scheduler is required');
  const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-tool-queue-'));
  const root=path.join(world,'project'), other=path.join(world,'other'); fs.mkdirSync(root);fs.mkdirSync(other);fs.mkdirSync(path.join(root,'nested'));
  const states=[],scheduler=createSessionToolScheduler();
  const a=scheduler.channel(root,{onState:s=>states.push(['A',s])}),b=scheduler.channel(root,{onState:s=>states.push(['B',s])}),c=scheduler.channel(other),nested=scheduler.channel(path.join(root,'nested'));
  try {
    await check('A write holds B write while another project can execute',async()=>{
      await a.acquire('write-A');let granted=false; const waiting=b.acquire('write-B').then(()=>{granted=true;});await tick();
      assert.equal(granted,false);await c.acquire('write-C');c.release('write-C');
      assert.ok(states.some(([id,s])=>id==='B'&&s.waiting));a.release('write-A');await waiting;assert.equal(granted,true);b.release('write-B');
    });
    await check('proven read-only tools do not wait on write coordination',async()=>{await a.acquire('shell-A');await b.acquire('read-B',{readOnly:true});b.release('read-B');a.release('shell-A');});
    await check('nested/same-child writes are reentrant without admitting another child',async()=>{
      await a.acquire('outer');await a.acquire('nested',{parent:'outer'});let granted=false;const waiting=b.acquire('B').then(()=>granted=true);await tick();
      a.release('outer');await tick();assert.equal(granted,false);a.release('nested');await waiting;b.release('B');
    });
    await check('Stop cancels only its own queued work, active writer remains held',async()=>{
      await a.acquire('active');const waiting=b.acquire('wait');const rejected=assert.rejects(waiting,e=>e.code==='tool_wait_cancelled');await tick();b.pause();await rejected;
      let granted=false;const next=nested.acquire('next').then(()=>granted=true);await tick();a.pause();await tick();assert.equal(granted,false);
      a.release('active');await next;nested.release('next');a.resume();b.resume();
    });
    await check('unconfirmed cleanup cannot release an active writer',async()=>{
      await a.acquire('crashed');a.close(false);let granted=false;const waiting=b.acquire('B-after-crash').then(()=>granted=true);await tick();assert.equal(granted,false);
      a.close(true);await waiting;b.release('B-after-crash');
    });
    await check('parent and child project paths share the same write exclusion',async()=>{
      await b.acquire('root');let granted=false;const waiting=nested.acquire('subdir').then(()=>granted=true);await tick();assert.equal(granted,false);b.release('root');await waiting;nested.release('subdir');
    });
    await check('pending queue is bounded and duplicate call IDs are rejected',async()=>{
      await b.acquire('one');await assert.rejects(()=>b.acquire('one'),e=>e.code==='invalid_tool_call');b.release('one');
    });
    await check('authoritative settled clears only that child and permits the next writer',async()=>{
      await b.acquire('last');const waiting=nested.acquire('after');await tick();b.settle();await waiting;nested.release('after');
    });
    await check('changed directory identity is refused before execution',async()=>{
      c.close(true);const d=scheduler.channel(other);fs.renameSync(other,other+'-old');fs.mkdirSync(other);
      await assert.rejects(()=>d.acquire('stale'),e=>e.code==='stale_workspace');d.close(true);
    });
    console.log(`Session tool scheduler: ${passed}/${passed}`);
  } finally {scheduler.dispose();fs.rmSync(world,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
