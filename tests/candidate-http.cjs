const assert=require('node:assert/strict'),http=require('node:http');let count=0;
const check=async(name,fn)=>{await fn();count++;console.log('ok '+name);};
(async()=>{
 const {createCandidateRoutes}=await import('../server/candidate-routes.js');
 const {createRouter}=await import('../server/router.js'),{createAuth}=await import('../server/auth.js');
 let handled=0,started=0;
 const routes=createCandidateRoutes({withAuthority:async(req,action)=>{if(req.headers['x-pi-gui-owner']!==JSON.stringify({id:'A'}))throw Error('private /outside/path task text');handled++;return action({key:'a',assertCurrent(){}});},
  runs:{list:()=>({ok:true,runs:[]}),prepare:async()=>({ok:true,nonce:'one'}),confirm:async()=>{started++;return{ok:true,run:{id:'run'}};},get:()=>({ok:true,run:{id:'run'}}),stop:async()=>{throw Error('secret raw error');}}});
 const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,base=`http://127.0.0.1:${port}`;
 server.on('request',createRouter({auth:createAuth({port,token:'fixture'}),candidateRuns:routes}));
 const send=async(body,headers={},suffix='')=>{const response=await fetch(base+'/api/candidate-runs'+suffix,{method:body===undefined?'GET':'POST',headers:{'x-pi-gui-token':'fixture','x-pi-gui-owner':JSON.stringify({id:'A'}),...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 try{
  await check('auth precedes candidate authority',async()=>{const r=await send(undefined,{'x-pi-gui-token':'wrong'});assert.equal(r.status,401);assert.equal(handled,0);});
  await check('cross origin write denied',async()=>assert.equal((await send({action:'confirm',nonce:'one'},{origin:'https://evil.invalid'})).status,403));
  await check('wrong owner denied without private error',async()=>{const r=await send({action:'prepare'},{'x-pi-gui-owner':'wrong'});assert.equal(r.body.ok,false);assert(!JSON.stringify(r.body).includes('/outside'));});
  await check('read has no execution side effect',async()=>{assert.equal((await send()).body.ok,true);assert.equal(started,0);});
  await check('preflight does not imply consent',async()=>{assert.equal((await send({action:'prepare',selectedIds:['x']})).body.nonce,'one');assert.equal(started,0);});
  await check('arbitrary path or command fields refused',async()=>{for(const extra of [{path:'../x'},{cwd:'x'},{command:'shell'},{prompt:'ignore rules'}])assert.equal((await send({action:'confirm',nonce:'one',...extra})).body.ok,false);assert.equal(started,0);});
  await check('malformed and oversize body refused',async()=>{assert.equal((await send('{')).body.ok,false);assert.equal((await send(' '.repeat(17000))).body.ok,false);});
  await check('unknown action and query rejected',async()=>{assert.equal((await send({action:'apply'})).body.ok,false);assert.equal((await send(undefined,{},'?path=x')).body.ok,false);});
  await check('explicit confirmation reaches controller once',async()=>{assert.equal((await send({action:'confirm',nonce:'one'})).body.ok,true);assert.equal(started,1);});
  await check('failure response never contains upstream text',async()=>{const r=await send({action:'stop',id:'run'});assert.equal(r.body.ok,false);assert(!JSON.stringify(r.body).includes('secret'));});
 }finally{await new Promise(r=>server.close(r));}
 console.log(`Candidate HTTP: ${count}/${count}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
