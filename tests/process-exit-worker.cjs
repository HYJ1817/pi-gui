// Live-test-only fixture: deliberately exits without calling manager.dispose().
const path=require('node:path');
(async()=>{
  const {createManagedProcesses}=await import('../server/managed-processes.js');
  const cwd=process.argv[2],port=Number(process.argv[3]);const manager=createManagedProcesses({context:()=>({cwd,workspace:1,run:1})});const g=manager.snapshot().generation;manager.enable(true,g);
  const initial=await manager.action('start',{command:process.execPath,args:['exit-tree.cjs'],ready:{type:'http',url:`http://127.0.0.1:${port}/`,timeoutMs:15000}},g);
  const ready=await manager.action('status',{id:initial.process.id,revision:1,waitReady:true},g);
  if(!ready.process.ready)throw Error('fixture not ready');process.stdout.write('OWNED_READY\n');
  process.stdin.resume();process.stdin.on('end',()=>process.exit(0));
})().catch(()=>process.exit(1));
