// Lifetime guardian is the session/process-group leader, never a recycled PID.
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const rl=readline.createInterface({input:process.stdin});
let launched=false,identity;
function stop(){try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}}
rl.on('line',line=>{
  if(launched)return;launched=true;
  let spec;try{spec=JSON.parse(line);identity=spec.identity;}catch{return stop();}
  const child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,stdio:['ignore','pipe','pipe'],shell:false});
  const send=(type,code)=>process.stdout.write(JSON.stringify({type,identity,code})+'\n');
  child.stdout.pipe(process.stderr,{end:false});child.stderr.pipe(process.stderr,{end:false});
  child.on('spawn',()=>send('started'));child.on('exit',code=>send('exit',code));child.on('error',()=>{send('failure');stop();});
});
rl.on('close',stop);process.stdout.on('error',stop);process.stderr.on('error',stop);
