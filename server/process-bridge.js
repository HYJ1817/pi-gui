import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {createManagedProcesses} from './managed-processes.js';
import {processAssets} from './process-runner.js';
import {json,readRawBody} from './http-utils.js';

const ACTIONS=new Set(['start','status','logs','stop','restart']);
const same=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
const closed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
export function createProcessBridge({runtime,launch,getRpcState=()=>({}),guiPort=()=>null,runner,processAdmission=()=>true,mutationAdmission=null}={}){
  let server=null,token=null,url=null,session=0,disposed=false,supported=false;
  const pending=new Map(),seen=new Set();
  const manager=createManagedProcesses({context:()=>({cwd:runtime.getCurrentCwd(),workspace:runtime.getWorkspaceGeneration?.()??0,run:getRpcState().bridgeRun??0,session}),launch:runner,
    canStart:processAdmission,isBlocked:()=>{try{if(runtime.getCurrentCwd())mutationAdmission?.assertAllowed(runtime.getCurrentCwd());}catch{return true;}return Boolean(getRpcState().stop?.pending||runtime.isShuttingDown());},blockedPorts:()=>[guiPort(),server?.address()?.port].filter(Boolean)});
  try{const types=fs.readFileSync(path.join(launch.packageDir(),'dist/core/extensions/types.d.ts'),'utf8');supported=types.includes('getAllTools()')&&types.includes('registerTool<');}catch{/* unknown API: no tool injection */}
  function authorized(req){return !req.headers.origin&&same(req.headers['x-pi-process-token'],token);}
  async function privateRoute(req,res){
    if(!authorized(req))return json(res,403,{ok:false,code:'unauthorized'});
    const admittedToken=token;
    try{
      const body=JSON.parse((await readRawBody(req,16384)).toString('utf8'));
      if(!authorized(req)||admittedToken!==token)return json(res,409,{ok:false,code:'stale_generation'});
      if(req.method!=='POST'||!closed(body,['requestId','action','args','generation'])||typeof body.requestId!=='string'||body.requestId.length>128)return json(res,400,{ok:false,code:'invalid_request'});
      if(req.url==='/cancel'){
        const work=pending.get(body.requestId);
        if(work&&work.generation===manager.snapshot().generation)work.controller.abort();
        return json(res,200,{ok:true});
      }
      if(req.url==='/state')return json(res,200,manager.snapshot());
      if(req.url!=='/action'||!ACTIONS.has(body.action)||typeof body.generation!=='string')return json(res,400,{ok:false,code:'invalid_request'});
      if(seen.has(body.requestId)||pending.size>=32)return json(res,409,{ok:false,code:'duplicate_request'});
      seen.add(body.requestId);if(seen.size>256)seen.delete(seen.values().next().value);
      const controller=new AbortController();pending.set(body.requestId,{controller,generation:body.generation});
      const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.once('close',disconnect);
      try{
        const result=await manager.action(body.action,body.args||{},body.generation,{signal:controller.signal});
        if(admittedToken!==token||controller.signal.aborted)return json(res,409,{ok:false,code:'cancelled'});
        return json(res,200,result);
      }finally{pending.delete(body.requestId);res.removeListener('close',disconnect);}
    }catch(e){return json(res,400,{ok:false,code:safeCode(e)});}
  }
  async function ensureServer(){
    if(server)return;
    server=http.createServer(privateRoute);server.requestTimeout=5000;server.headersTimeout=5000;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});url=`http://127.0.0.1:${server.address().port}`;
  }
  async function invalidate({revoke=false,disable=false}={}){
    for(const work of pending.values())work.controller.abort();
    if(revoke||disable){token=null;session++;await manager.invalidate();}else await manager.cancelActions();
  }
  return {manager,available:()=>supported,report:()=>({bundled:true,configured:supported,bridgeReady:Boolean(token)}),
    async prepare(){if(!supported||disposed)return null;await invalidate({revoke:true});await ensureServer();token=randomUUID();return {args:['--extension',path.join(processAssets(),'index.js')],env:{PI_GUI_PROCESS_URL:url,PI_GUI_PROCESS_TOKEN:token}};},
    invalidate,
    observe(event){if(event?.type==='response'&&event.success===true&&['new_session','switch_session','fork'].includes(event.command)){session++;void manager.invalidate().catch(()=>{});}},
    async handle(req,res,parsed){
      try{
        if(req.method==='GET'){
          if(parsed.searchParams.has('id'))return json(res,200,await manager.action('logs',{id:parsed.searchParams.get('id'),revision:Number(parsed.searchParams.get('revision')),cursor:Number(parsed.searchParams.get('cursor')||0)},parsed.searchParams.get('generation')));
          return json(res,200,{...manager.snapshot(),available:supported});
        }
        if(req.method!=='POST')return json(res,405,{ok:false,code:'method_not_allowed'});
        const body=JSON.parse((await readRawBody(req,4096)).toString('utf8'));
        if(!closed(body,['action','generation','id','revision','enabled']))throw Error('invalid_request');
        if(body.action==='permission')return json(res,200,await manager.enable(body.enabled,body.generation));
        if(!['stop','restart'].includes(body.action))throw Error('invalid_request');
        return json(res,200,await manager.action(body.action,{id:body.id,revision:body.revision},body.generation));
      }catch(e){return json(res,400,{ok:false,code:safeCode(e)});}
    },
    async dispose(){disposed=true;token=null;for(const work of pending.values())work.controller.abort();await manager.dispose();if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});},
  };
}
const CODES=new Set(['unauthorized','invalid_request','invalid_spec','invalid_args','invalid_cwd','invalid_env','invalid_ready','invalid_cursor','invalid_permission','shell_launcher_unsupported','stale_generation','stale_process','process_control_disabled','cancelled','ready_strategy_required','reserved_port','process_limit','port_in_use','restart_in_progress','stop_unconfirmed','cleanup_pending']);
export function safeCode(e){return CODES.has(e?.code||e?.message)?e.code||e.message:'process_unavailable';}
