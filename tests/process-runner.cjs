const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');let checks=0;const ok=v=>{assert.ok(v);checks++;};
(async()=>{
  const {launchOwnedProcess,resolveExecutable}=await import('../server/process-runner.js');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'p31-runner-'));const executable=path.join(fixture,'fixture.exe');fs.writeFileSync(executable,'not executed');
  try {
  fs.writeFileSync(path.join(fixture,'npm'),'unix shim');fs.writeFileSync(path.join(fixture,'npm.cmd'),'windows shim');fs.writeFileSync(path.join(fixture,'node.exe'),'node fixture');fs.mkdirSync(path.join(fixture,'node_modules/npm/bin'),{recursive:true});fs.writeFileSync(path.join(fixture,'node_modules/npm/bin/npm-cli.js'),'not executed');
  const npm=resolveExecutable('npm',['run','dev'],{PATH:fixture},'win32');ok(npm.command===path.join(fixture,'node.exe'));ok(npm.args[0].endsWith('npm-cli.js'));ok(npm.args.slice(1).join(' ')==='run dev');
  for(const platform of ['win32','linux']){
    let captured,written;const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();let ended=0;
    child.stdin.write=value=>{written=value;};child.stdin.end=()=>{ended++;setImmediate(()=>child.emit('close',0));};child.kill=()=>{throw Error('PID fallback forbidden');};
    const identity='owned-'+platform;
    const h=launchOwnedProcess({command:executable,args:['--version'],cwd:fixture,env:{PORT:'1234'}},{identity,platform,spawnProcess:(command,args,opts)=>{captured={command,args,opts};return child;},envSource:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,GUI_SECRET:'secret',PI_GUI_PROCESS_TOKEN:'secret'}});
    ok(!JSON.stringify(captured).includes('secret'));ok(!captured.args.includes('--version'));ok(!captured.opts.shell);
    const payload=JSON.parse(written);ok(payload.args[0]==='--version'&&payload.env.PORT==='1234'&&payload.identity===identity);ok(!('GUI_SECRET' in payload.env));
    let started=false;h.on('started',()=>started=true);child.stdout.emit('data',Buffer.from(JSON.stringify({type:'started',identity:'foreign'})+'\n'));ok(!started);child.stdout.emit('data',Buffer.from(JSON.stringify({type:'started',identity})+'\n'));ok(started);
    if(platform==='linux'){ok(captured.opts.detached===true);ok(captured.opts.env.ELECTRON_RUN_AS_NODE==='1');ok(!('ELECTRON_RUN_AS_NODE' in payload.env));}
    await Promise.all([h.stop(),h.stop()]);ok(ended===2); // Both use the same owned pipe, no PID signalling.
    await h.stop();ok(ended===2);
  }
  } finally {fs.rmSync(fixture,{recursive:true,force:true});}
  console.log(`Process runner protocol Windows/POSIX: ${checks}/${checks}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
