// Real formal process checks only; no private service or writer imports.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
async function freePort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function productionBoundary(file,args,root,env={}){
 const port=await freePort(),data=await fs.mkdtemp(path.join(root,'formal data ')),child=spawn(file,args,{env:{...process.env,...env,PORT:String(port),PI_GUI_DATA:data,PI_GUI_OPEN:'0',PI_GUI_OBJECT_APPROVED:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stdout='';child.stdout.on('data',b=>stdout+=b.toString());child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify({version:1,command:'run',nonce:'a'.repeat(64),root:'client-root',bytes:'evil'})+'\n');
 try{let health=false;for(let i=0;i<200;i++){try{if((await fetch('http://127.0.0.1:'+port+'/api/health')).ok){health=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.equal(health,true,'formal process ready');
  const statuses=[];for(const name of ['prepare','apply','prepare-recovery','export']){const response=await fetch('http://127.0.0.1:'+port+'/api/session-revert-object/'+name,{method:'POST',body:JSON.stringify({approved:true,proofId:'p33-d2-isolated',path:'client-path',bytes:'evil'})});assert.equal(response.status,405);assert.equal(await response.text(),'Method not allowed');statuses.push(response.status);}
  assert.equal(stdout.includes('"phase":"challenge"'),false);return {formalProcess:true,routesAbsent:4,statuses,stdinIssuer:false};
 }finally{if(child.exitCode===null){const ended=new Promise(r=>child.once('close',r));child.kill();await ended;}}
}
module.exports={productionBoundary};
