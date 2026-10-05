import http from 'node:http';
import {randomUUID} from 'node:crypto';

export const PROCESS_ACTIONS=['start','status','logs','stop','restart'];
export function transport(connection,endpoint,body,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>req.destroy(Error('cancelled'));
    let target;try{target=new URL(connection.url);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1')throw Error();}catch{return reject(Error('process_unavailable'));}
    if(signal?.aborted)return reject(Error('cancelled'));
    const req=http.request(new URL(endpoint,target),{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Process-Token':connection.token}},res=>{
      let bytes=0;const chunks=[];res.on('data',chunk=>{bytes+=chunk.length;if(bytes>131072)req.destroy(Error('process_unavailable'));else chunks.push(chunk);});
      res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('process_unavailable'));}});res.on('error',reject);
    });
    signal?.addEventListener('abort',abort,{once:true});req.once('close',()=>signal?.removeEventListener('abort',abort));req.once('error',reject);req.setTimeout(135000,()=>req.destroy(Error('timeout')));req.end(JSON.stringify(body));
  });
}
export default function processExtension(pi){
  const connection={url:process.env.PI_GUI_PROCESS_URL,token:process.env.PI_GUI_PROCESS_TOKEN};
  if(!connection.url||!connection.token)return;
  let registered=false;
  // Authoritative names are available only after Pi binds the extension runtime.
  pi.on('session_start',()=>{
    if(registered)return;
    const names=new Set(pi.getAllTools().map(t=>t.name));
    if(PROCESS_ACTIONS.some(a=>names.has(`gui_process_${a}`))){pi.ui?.notify?.('Managed process tools could not load: tool name conflict.','warning');return;}
    for(const action of PROCESS_ACTIONS){
      const identity={id:{type:'string',maxLength:128},revision:{type:'integer',minimum:1}};
      const properties=action==='start'?{command:{type:'string',maxLength:1024},args:{type:'array',items:{type:'string',maxLength:4096},maxItems:64},cwd:{type:'string',maxLength:2048},env:{type:'object',properties:Object.fromEntries(['NODE_ENV','PORT','HOST','BROWSER','CI','PYTHONUNBUFFERED','FLASK_APP','FLASK_ENV','VITE_PORT'].map(k=>[k,{type:'string',maxLength:1024}])),additionalProperties:false,maxProperties:8},ready:{type:'object',properties:{type:{type:'string',enum:['tcp','http','log']},host:{type:'string',enum:['127.0.0.1','::1']},port:{type:'integer',minimum:1,maximum:65535},url:{type:'string',maxLength:2048},marker:{type:'string',maxLength:128},timeoutMs:{type:'integer',minimum:100,maximum:120000}},required:['type'],additionalProperties:false}}
        :action==='status'?{...identity,waitReady:{type:'boolean'}}:action==='logs'?{...identity,cursor:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:256}}:identity;
      pi.registerTool({name:`gui_process_${action}`,label:`Managed process ${action}`,description:`${action} a workspace-owned local dev process. User must enable Process control separately from Browser control. Start uses command and args, never a shell string. Readiness supports literal loopback TCP/HTTP or a log marker with timeout. Start returns id/revision; status(waitReady:true) waits for readiness; reuse current revision for logs/stop/restart. Restart returns a new revision. No shell launchers or remote processes.`,
        parameters:{type:'object',properties,required:action==='start'?['command','args']:action==='status'?[]:['id','revision'],additionalProperties:false},
        async execute(callId,args,signal){
          const requestId=randomUUID();const cancel=()=>{transport(connection,'/cancel',{requestId}).catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
          let result;
          try{
            const state=await transport(connection,'/state',{requestId},signal);
            result=state.ok?await transport(connection,'/action',{requestId,action,args,generation:state.generation},signal):state;
          }catch(e){result={ok:false,code:['cancelled','timeout'].includes(e.message)?e.message:'process_unavailable'};}
          finally{signal?.removeEventListener('abort',cancel);}
          return {content:[{type:'text',text:JSON.stringify(result)}],details:result,isError:result.ok===false};
        },
      });
    }
    registered=true;
  });
}
