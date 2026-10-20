const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
test('private maintenance refuses active work, drains and freezes atomically',async()=>{
  const {createAppUpdateMaintenance}=await import('../server/app-update-maintenance.js');
  const order=[];let busy={code:'busy-runtime'},releaseClose;
  const gate=createAppUpdateMaintenance({busyReason:()=>busy,pause:async()=>{order.push('pause');return {ok:true};},
    closeSessions:async()=>{order.push('close');await new Promise(r=>releaseClose=r);},resume:()=>order.push('resume')});
  assert.equal((await gate.prepare()).code,'busy-runtime');assert.deepEqual(order,[]);
  busy=null;const request=new EventEmitter();gate.track({method:'POST'},request);
  assert.equal((await gate.prepare()).code,'busy');request.emit('finish');request.emit('close');
  const p=gate.prepare();assert.equal(gate.locked(),true);assert.equal((await gate.prepare()).ok,false);
  releaseClose();assert.equal((await p).ok,true);assert.deepEqual(order,['close','pause']);
  await gate.release();assert.equal(gate.locked(),false);assert.deepEqual(order,['close','pause','resume']);
});
test('cleanup failure unlocks and resumes without claiming shutdown',async()=>{
  const {createAppUpdateMaintenance}=await import('../server/app-update-maintenance.js');let resumed=0;
  const gate=createAppUpdateMaintenance({busyReason:()=>null,pause:async()=>({ok:false}),closeSessions:async()=>{},resume:()=>resumed++});
  assert.equal((await gate.prepare()).ok,false);assert.equal(gate.locked(),false);assert.equal(resumed,1);
});
