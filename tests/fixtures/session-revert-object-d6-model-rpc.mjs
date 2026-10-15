// Private TEMP-only real-model child. Never imported by the product.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const fail=()=>{throw Error('d6_model_request_refused');};
const inside=(root,file)=>{const r=path.relative(path.resolve(root),path.resolve(file));return r!==''&&!r.startsWith('..')&&!path.isAbsolute(r);};
const send=value=>new Promise((resolve,reject)=>process.send?.(value,error=>error?reject(Error('d6_ipc_unavailable')):resolve())??reject(Error('d6_ipc_unavailable')));
const clean=message=>message?.stopReason==='error'?{...message,errorMessage:'D6 model request failed; no automatic retry.'}:message;

// Exported for offline mock checks. Counts actual fetch admissions, not turns.
export function createRequestGuard({projectId,permit,fetchImpl,model,onCount=()=>{}}){
 let count=0;
 if(!['openai-completions','openai-responses'].includes(model.api))fail();
 const base=new URL(model.baseUrl);if(base.protocol!=='https:'||base.username||base.password)fail();
 return {
  count:()=>count,
  forStream(){let fetched=false;return async(input,init={})=>{
   if(fetched||count>=4)fail();
   const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
   if(url.origin!==base.origin||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(base.pathname.replace(/\/$/,''))||!url.pathname.endsWith(model.api==='openai-completions'?'/chat/completions':'/responses')||init.method!=='POST'||typeof init.body!=='string')fail();
   let body;try{body=JSON.parse(init.body);}catch{fail();}
   if(body.model!==model.id||body.stream!==true)fail();
   const caps=['max_tokens','max_completion_tokens','max_output_tokens'].filter(k=>body[k]!==undefined);
   if(!caps.length||caps.some(k=>!Number.isInteger(body[k])||body[k]<1||body[k]>1024))fail();
   // A reserved permit is never returned, including network failure.
   fetched=true;count++;
   const grant=await permit({projectId,projectRequest:count});
   if(grant?.allowed!==true||!Number.isInteger(grant.totalReserved)||grant.totalReserved<1||grant.totalReserved>8)fail();
   onCount({projectId,projectRequests:count,totalReserved:grant.totalReserved});
   return fetchImpl(input,{...init,redirect:'error'});
  };},
 };
}

async function main(){
 if(!process.send)fail();
 const pending=new Map();
 process.on('message',row=>{if(row?.type==='d6-model-permit-result'&&pending.has(row.requestId)){const p=pending.get(row.requestId);pending.delete(row.requestId);p(row);}});
 const init=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('d6_init_timeout')),20000);const listen=row=>{if(row?.type==='d6-init'){clearTimeout(timer);process.off('message',listen);resolve(row);}};process.on('message',listen);});
 const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
 const workspace=path.resolve(init.workspace??process.cwd()),agentDir=path.resolve(init.agentDir),sessionDir=path.resolve(init.sessionDir??arg('--session-dir'));
 for(const dir of [workspace,agentDir,sessionDir]){if(!inside(os.tmpdir(),dir)||(await fs.lstat(dir)).isSymbolicLink()||!(await fs.stat(dir)).isDirectory())fail();}
 if(typeof init.apiKey!=='string'||!init.apiKey||!init.model||typeof init.projectId!=='string')fail();
 const pi=await import(pathToFileURL(path.join(init.packageDir,'dist/index.js')));
 const model={...init.model,samplingParams:{}};
 if(model.provider!==init.defaultProvider||model.id!==init.defaultModel)fail();
 const credentials={async read(){return undefined;},async list(){return [];},async modify(_id,fn){return fn(undefined);},async delete(){}};
 const runtime=await pi.ModelRuntime.create({credentials,modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
 runtime.registerProvider(model.provider,{api:model.api,baseUrl:model.baseUrl,headers:model.headers,models:[{...model}]});
 await runtime.setRuntimeApiKey(model.provider,init.apiKey);
 // Release our initialization object's credential reference; SDK retains it in memory.
 init.apiKey=null;
 const settings=pi.SettingsManager.inMemory({retry:{enabled:false,maxRetries:0,provider:{maxRetries:0,timeoutMs:60000}},compaction:{enabled:false},defaultProvider:model.provider,defaultModel:model.id});
 const extensionFile=init.extensionFile??arg('--extension');
 if(typeof extensionFile!=='string')fail();
 const captureUrl=new URL(process.env.PI_GUI_SESSION_CHANGE_URL);
 if(captureUrl.protocol!=='http:'||captureUrl.hostname!=='127.0.0.1'||!process.env.PI_GUI_SESSION_CHANGE_TOKEN||!process.env.PI_GUI_SESSION_CHANGE_API)fail();
 const sessionPath=arg('--session');if(sessionPath&&!inside(sessionDir,sessionPath))fail();
 const manager=sessionPath?pi.SessionManager.open(sessionPath,sessionDir,workspace):pi.SessionManager.create(workspace,sessionDir);
 const permit=details=>new Promise((resolve,reject)=>{const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('d6_permit_timeout'));},10000);pending.set(requestId,row=>{clearTimeout(timer);resolve(row);});send({type:'d6-model-permit',requestId,...details}).catch(()=>{clearTimeout(timer);pending.delete(requestId);reject(Error('d6_ipc_unavailable'));});});
 const guard=createRequestGuard({projectId:init.projectId,permit,fetchImpl:globalThis.fetch,model,onCount:row=>{void send({type:'d6-model-count',...row}).catch(()=>{});}});
 const streamFunction=(requested,context,options={})=>{
  if(requested.provider!==model.provider||requested.id!==model.id)fail();
  const stream=runtime.streamSimple(model,context,{signal:options.signal,maxTokens:1024,maxRetries:0,timeoutMs:60000,transport:'sse',reasoning:'off',fetch:guard.forStream()});
  return {async *[Symbol.asyncIterator](){for await(const event of stream){if(event.type==='error')yield {...event,error:clean(event.error)};else yield event;}},async result(){return clean(await stream.result());}};
 };
 const createRuntime=async({cwd,sessionManager,sessionStartEvent})=>{
  if(path.resolve(cwd)!==workspace||sessionManager.getCwd()!==workspace)fail();
  const services=await pi.createAgentSessionServices({cwd:workspace,agentDir,settingsManager:settings,modelRuntime:runtime,resourceLoaderOptions:{noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,additionalExtensionPaths:[extensionFile]}});
  if(services.resourceLoader.getExtensions().errors.length)fail();
  // No read tool: only synthetic prompt content and guarded write/edit.
  const result=await pi.createAgentSessionFromServices({services,sessionManager,sessionStartEvent,model,thinkingLevel:'off',tools:['write','edit']});
  result.session.agent.streamFunction=streamFunction;
  return {...result,services,diagnostics:services.diagnostics};
 };
 const first=await createRuntime({cwd:workspace,sessionManager:manager});
 const host=new pi.AgentSessionRuntime(first.session,first.services,createRuntime,first.diagnostics);
 // Keep SDK new_session/fork/rebind semantics; reject any path outside TEMP.
 const switchSession=host.switchSession.bind(host);
 host.switchSession=(file,options)=>{if(!inside(sessionDir,file)||options?.cwdOverride&&path.resolve(options.cwdOverride)!==workspace)fail();return switchSession(file,options);};
 host.importSession=async()=>fail();
 // IPC diagnostics contain identities/counts only; stdout belongs to real Pi JSONL RPC.
 await send({type:'d6-ready',sessionId:manager.getSessionId(),provider:model.provider,model:model.id,api:model.api,maxRequests:4,maxOutputTokens:1024,providerRetries:0,agentRetries:false});
 await pi.runRpcMode(host);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(async()=>{await send({type:'d6-failed',code:'d6_model_child_failed'}).catch(()=>{});process.exitCode=1;process.disconnect?.();});
}
