const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url');
let passed=0;async function check(name,run){await run();passed++;console.log('PASS '+name);}
async function until(fn){const end=Date.now()+30000;while(!await fn()){if(Date.now()>end)throw Error('sdk_fixture_timeout');await new Promise(r=>setTimeout(r,20));}}
(async()=>{
 const {createPiLaunch}=await import('../server/pi-launch.js');
 const packageDir=createPiLaunch().packageDir();assert.ok(packageDir,'opt-in SDK evidence requires the proven local Pi package');
 const {createSessionToolScheduler}=await import('../server/session-tool-scheduler.js'),{createSessionRuntime}=await import('../server/session-runtime.js');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-ordinary-sdk-')),workspace=path.join(world,'project'),agentDir=path.join(world,'agent'),sessionDir=path.join(agentDir,'sessions');
 for(const dir of [workspace,agentDir,sessionDir])fs.mkdirSync(dir,{recursive:true});
 const fakePackage=path.join(world,'node_modules/@earendil-works/pi-coding-agent');fs.mkdirSync(path.join(fakePackage,'dist/core/extensions'),{recursive:true});
 fs.writeFileSync(path.join(fakePackage,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.3.0',bin:{pi:'cli.mjs'}}));
 fs.copyFileSync(path.join(packageDir,'dist/core/extensions/types.d.ts'),path.join(fakePackage,'dist/core/extensions/types.d.ts'));
 const cli=path.join(fakePackage,'cli.mjs');fs.writeFileSync(cli,`import ${JSON.stringify(pathToFileURL(path.resolve('tests/fixtures/ordinary-session-sdk-rpc.mjs')).href)};`);
 const toolFile=path.join(world,'fixture-tool.mjs');
 fs.writeFileSync(toolFile,`import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
 const {createWriteToolDefinition}=await import(${JSON.stringify(pathToFileURL(path.join(packageDir,'dist/index.js')).href)});
 export default function(pi){pi.registerTool({name:'fixture_write',label:'Fixture write',description:'TEMP only',parameters:createWriteToolDefinition(process.cwd()).parameters,
 async execute(id,args,signal,update,ctx){const label=process.env.PI_ORDINARY_FIXTURE_LABEL;await fs.appendFile(path.join(ctx.cwd,'tool-starts.txt'),label+'\\n');
 if(label==='A'){if(!await ctx.ui.confirm('A fixture approval','Only A may approve'))throw Error('fixture denied');
  while(true){if(signal?.aborted)throw Error('aborted');try{await fs.stat(path.join(ctx.cwd,'release-A'));break;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,20));}}
 return createWriteToolDefinition(ctx.cwd).execute(id,args,signal,update,ctx);}});}`);
 const config=path.join(world,'config.json');fs.writeFileSync(config,JSON.stringify({packageDir,workspace,agentDir,sessionDir,toolFile}));
 const scheduler=createSessionToolScheduler(),events={A:[],B:[]},runtimes={};
 try{
  for(const label of ['A','B'])runtimes[label]=await createSessionRuntime({piBin:cli,env:{...process.env,PI_ORDINARY_SDK_CONFIG:config,PI_CODING_AGENT_DIR:agentDir},dataDir:path.join(world,'data'),toolScheduler:scheduler,extraArgs:['--fixture-label',label],
    context:{cwd:workspace,workspace:{root:workspace,workspaceId:'project-fixture'},owner:{conversationId:label},isCurrent:()=>true},emit:e=>events[label].push(e)});
  runtimes.A.start();runtimes.B.start();await until(()=>runtimes.A.getState().state==='ready'&&runtimes.B.getState().state==='ready');
  await check('real SDK children prove different native IDs at the same working directory',async()=>{const a=await runtimes.A.request({type:'get_state'}),b=await runtimes.B.request({type:'get_state'});assert.notEqual(a.sessionId,b.sessionId);assert.equal(runtimes.A.toolGuard.ready(workspace,a.sessionId),true);assert.equal(runtimes.B.toolGuard.ready(workspace,b.sessionId),true);});
  await runtimes.A.send({type:'prompt',message:'task-A'});await until(()=>events.A.some(e=>e.type==='extension_ui_request'&&e.method==='confirm'));
  const approval=events.A.find(e=>e.type==='extension_ui_request'&&e.method==='confirm');
  await runtimes.B.send({type:'prompt',message:'task-B-waiting'});await until(()=>events.B.some(e=>e.type==='tool_wait_state'&&e.waiting));
  await check('B model runs concurrently while its write waits for A; no B file operation executes',async()=>{assert.equal((await runtimes.A.request({type:'get_state'})).isStreaming,true);assert.equal((await runtimes.B.request({type:'get_state'})).isStreaming,true);assert.ok(fs.readFileSync(path.join(workspace,'model-starts.txt'),'utf8').includes('B'));assert.equal(fs.readFileSync(path.join(workspace,'tool-starts.txt'),'utf8'),'A\n');assert.equal(fs.existsSync(path.join(workspace,'shared.txt')),false);});
  const stopped=await runtimes.B.abortAndWait({type:'abort'});
  await check('stopping queued B completes without interrupting A or approving its request',async()=>{assert.equal(stopped.ok,true);assert.equal((await runtimes.A.request({type:'get_state'})).isStreaming,true);assert.equal((await runtimes.B.request({type:'get_state'})).isStreaming,false);assert.equal(fs.readFileSync(path.join(workspace,'tool-starts.txt'),'utf8'),'A\n');});
  await runtimes.B.send({type:'prompt',message:'task-B-resumed'});await until(()=>events.B.filter(e=>e.type==='tool_wait_state'&&e.waiting).length>=2);
  await runtimes.A.send({type:'extension_ui_response',id:approval.id,confirmed:true});fs.writeFileSync(path.join(workspace,'release-A'),'ready');
  await until(()=>events.A.some(e=>e.type==='agent_settled')&&events.B.filter(e=>e.type==='agent_settled').length>=2);
  await check('after A releases, resumed B writes in order and both retain independent usage',async()=>{assert.equal(fs.readFileSync(path.join(workspace,'tool-starts.txt'),'utf8'),'A\nB\n');assert.equal(fs.readFileSync(path.join(workspace,'shared.txt'),'utf8'),'B result');assert.equal(events.A.find(e=>e.type==='message_end'&&e.message.role==='assistant').message.usage.input,11);assert.equal(events.B.find(e=>e.type==='message_end'&&e.message.role==='assistant').message.usage.input,22);});
  await check('both persisted native histories remain independently readable',async()=>{const a=await runtimes.A.request({type:'get_messages'}),b=await runtimes.B.request({type:'get_messages'});assert.ok(JSON.stringify(a.messages).includes('A completed'));assert.ok(!JSON.stringify(a.messages).includes('B completed'));assert.ok(JSON.stringify(b.messages).includes('B completed'));assert.notEqual((await runtimes.A.request({type:'get_state'})).sessionFile,(await runtimes.B.request({type:'get_state'})).sessionFile);});
  console.log(`Ordinary session real SDK/RPC: ${passed}/${passed}; modelRequests=0`);
 }finally{await Promise.allSettled(Object.values(runtimes).map(r=>r.dispose()));scheduler.dispose();fs.rmSync(world,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
