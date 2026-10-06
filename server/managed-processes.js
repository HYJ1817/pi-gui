import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {stripVTControlCharacters} from 'node:util';
import {launchOwnedProcess} from './process-runner.js';

const ACTIVE = new Set(['starting','running','ready','stopping']);
const ENV_KEYS = new Set(['NODE_ENV','PORT','HOST','BROWSER','CI','PYTHONUNBUFFERED','FLASK_APP','FLASK_ENV','VITE_PORT']);
const fail = code => Object.assign(new Error(code),{code});
function closed(value,keys,code) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw fail(code);
}
const str = (s,max=2048) => typeof s==='string' && s.length<=max && !/[\0\r\n]/.test(s);
export function redactProcessLine(line) {
  line=stripVTControlCharacters(line);
  // Redact before storage, including split chunks and oversized logical lines.
  if(/authorization|proxy-authorization|cookie|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)\s*["']?\s*[:=]/i.test(line))return '[redacted secret line]';
  return line.replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g,'[redacted]')
    .replace(/https?:\/\/[^\s]+/g,s=>{try{const u=new URL(s);u.username='';u.password='';if(u.search)u.search='?[redacted]';return u.href;}catch{return '[redacted URL]';}})
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
}
export function validateProcessSpec(input,workspace) {
  closed(input,['command','args','cwd','env','ready'],'invalid_spec');
  if(!str(input.command,1024)||!input.command||!Array.isArray(input.args)||input.args.length>64||input.args.some(a=>!str(a,4096)))throw fail('invalid_spec');
  if(/^(cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|sh|bash|zsh)$/i.test(path.basename(input.command)))throw fail('shell_launcher_unsupported');
  const root=fs.realpathSync(workspace);
  if(input.cwd!==undefined&&!str(input.cwd))throw fail('invalid_cwd');
  let cwd;try{cwd=fs.realpathSync(path.resolve(root,input.cwd||'.'));}catch{throw fail('invalid_cwd');}
  const rel=path.relative(root,cwd);
  if(rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel)||!fs.statSync(cwd).isDirectory())throw fail('invalid_cwd');
  const env=input.env===undefined?{}:input.env;closed(env,[...ENV_KEYS],'invalid_env');
  if(Object.keys(env).length>8||Object.values(env).some(v=>!str(v,1024)))throw fail('invalid_env');
  let ready=null;
  if(input.ready!==undefined){
    const r=input.ready;closed(r,['type','host','port','url','marker','timeoutMs'],'invalid_ready');
    const timeoutMs=r.timeoutMs??30000;
    if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw fail('invalid_ready');
    if(r.type==='log'){
      if(!str(r.marker,128)||!r.marker||r.url!==undefined||r.port!==undefined||r.host!==undefined)throw fail('invalid_ready');
      ready={type:'log',marker:r.marker,timeoutMs};
    }else if(r.type==='tcp'){
      if(!['127.0.0.1','::1'].includes(r.host||'127.0.0.1')||!Number.isInteger(r.port)||r.port<1||r.port>65535||r.marker!==undefined||r.url!==undefined)throw fail('invalid_ready');
      ready={type:'tcp',host:r.host||'127.0.0.1',port:r.port,timeoutMs};
    }else if(r.type==='http'){
      let u;try{u=new URL(r.url);}catch{throw fail('invalid_ready');}
      if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||r.marker!==undefined||r.port!==undefined||r.host!==undefined)throw fail('invalid_ready');
      ready={type:'http',url:u.href,host:u.hostname==='[::1]'?'::1':u.hostname,port:Number(u.port||80),timeoutMs};
    }else throw fail('invalid_ready');
  }
  return {command:input.command,args:[...input.args],cwd,env:Object.fromEntries(Object.keys(env).sort().map(k=>[k,env[k]])),ready};
}
export function probeReady(ready,signal) {
  return new Promise(resolve=>{
    let socket,done=false;
    const finish=value=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);socket?.destroy();resolve(value);};
    const abort=()=>finish(false);
    if(signal?.aborted)return finish(false);
    if(ready.type==='http'){
      socket=http.get(ready.url,{timeout:400},res=>{res.resume();finish(res.statusCode>=200&&res.statusCode<300);});
    }else{
      socket=net.connect({host:ready.host,port:ready.port});socket.setTimeout(400);socket.once('connect',()=>finish(true));
    }
    socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));signal?.addEventListener('abort',abort,{once:true});
  });
}
export function createManagedProcesses({context,launch=launchOwnedProcess,blockedPorts=()=>[],isBlocked=()=>false,canStart=()=>true}={}) {
  let ownerKey='',generation=randomUUID(),enabled=false,cancelEpoch=0,disposed=false;
  const records=new Map(),waiters=new Set();
  function current() {
    const owner=context();const key=JSON.stringify(owner);
    if(key!==ownerKey){
      ownerKey=key;generation=randomUUID();enabled=false;cancelEpoch++;
      for(const r of records.values())if(ACTIVE.has(r.state))void terminate(r).catch(()=>{});
      notify();
    }
    return owner;
  }
  function notify(){for(const fn of [...waiters])fn();}
  function guard(g,permission=true){const owner=current();if(disposed||!owner.cwd||g!==generation)throw fail('stale_generation');if(permission&&(!enabled||isBlocked()))throw fail(!enabled?'process_control_disabled':'cancelled');return owner;}
  function summary(r){return {id:r.id,revision:r.revision,command:path.basename(r.spec.command),argCount:r.spec.args.length,state:r.state,ready:r.state==='ready',cleanupConfirmed:r.closed,endpoint:r.spec.ready?.type==='http'?r.spec.ready.url:r.spec.ready?.type==='tcp'?`http://${r.spec.ready.host==='::1'?'[::1]':r.spec.ready.host}:${r.spec.ready.port}/`:null,uptimeMs:Math.max(0,(r.endedAt||Date.now())-r.startedAt),exitCode:r.exitCode??null,code:r.code||null};}
  function snapshot(){current();return {ok:true,generation,enabled,activeCount:[...records.values()].filter(r=>ACTIVE.has(r.state)||!r.closed||r.restarting).length,cleanupPending:[...records.values()].some(r=>r.generation!==generation&&!r.closed),processes:[...records.values()].filter(r=>r.generation===generation).map(summary)};}
  function lookup(args,g){guard(g,false);const r=records.get(args.id);if(!r||r.generation!==g||r.revision!==args.revision)throw fail('stale_process');return r;}
  function append(r,line){const text=redactProcessLine(line);r.lines.push({cursor:++r.cursor,text});r.bytes+=Buffer.byteLength(text);while(r.lines.length>256||r.bytes>65536){r.bytes-=Buffer.byteLength(r.lines.shift().text);} }
  function settleReady(r){if(r.state!=='starting'||r.generation!==generation)return;r.state='ready';clearTimeout(r.timeout);r.probeAbort.abort();notify();}
  async function terminate(r,{failed=false,code=null}={}){
    if(r.stopPromise)return r.stopPromise;
    if(!ACTIVE.has(r.state)&&r.closed){if(r.code==='stop_unconfirmed'){r.state='exited';r.code=null;notify();}return;}
    r.state='stopping';r.probeAbort?.abort();clearTimeout(r.timeout);clearTimeout(r.probeTimer);notify();
    r.stopPromise=(async()=>{
      try{await r.handle?.stop();if(!r.closed)throw fail('stop_unconfirmed');r.state=failed?'failed':'exited';r.code=code;r.endedAt=Date.now();}
      catch{r.state='failed';r.code='stop_unconfirmed';throw fail('stop_unconfirmed');}
      finally{r.stopPromise=null;notify();}
    })();return r.stopPromise;
  }
  async function run(r){
    const revision=r.revision;r.spawnIdentity=randomUUID();r.probeAbort=new AbortController();r.closed=false;r.stopPromise=null;r.state='starting';r.startedAt=Date.now();r.endedAt=null;r.code=null;r.exitCode=null;
    const decoder=new StringDecoder('utf8');let partial='',oversize=false;
    const accept=line=>{if(r.spec.ready?.type==='log'&&line.includes(r.spec.ready.marker))settleReady(r);append(r,line);};
    try{
      r.handle=launch(r.spec,{identity:r.spawnIdentity});
      r.handle.on('log',chunk=>{
        const s=decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
        for(const part of s.split(/(?<=\n)/)){
          if(!oversize){partial+=part;if(Buffer.byteLength(partial)>8192){partial='';oversize=true;}}
          if(part.endsWith('\n')){if(oversize)append(r,'[oversized log line omitted]');else accept(partial.replace(/[\r\n]+$/,''));partial='';oversize=false;}
        }
      });
      r.handle.once('started',()=>{if(r.revision!==revision||r.state!=='starting')return;if(!r.spec.ready){r.state='running';notify();}});
      r.handle.once('exit',exitCode=>{r.exitCode=Number.isInteger(exitCode)?exitCode:null;if(ACTIVE.has(r.state)&&r.state!=='stopping')void terminate(r,{failed:exitCode!==0,code:exitCode!==0?'child_exit':null}).catch(()=>{});});
      r.handle.once('failure',()=>{r.code='spawn_failed';void terminate(r,{failed:true,code:'spawn_failed'}).catch(()=>{});});
      r.handle.once('close',()=>{r.closed=true;r.endedAt=Date.now();if(partial&&!oversize)accept(partial+decoder.end());if(r.state!=='stopping'){r.state=r.code?'failed':'exited';r.probeAbort.abort();clearTimeout(r.timeout);clearTimeout(r.probeTimer);}notify();});
      if(r.spec.ready){
        r.timeout=setTimeout(()=>{void terminate(r,{failed:true,code:'ready_timeout'}).catch(()=>{});},r.spec.ready.timeoutMs);
        if(r.spec.ready.type!=='log'){
          const poll=async()=>{if(r.state!=='starting'||r.revision!==revision)return;if(await probeReady(r.spec.ready,r.probeAbort.signal))settleReady(r);else if(r.state==='starting')r.probeTimer=setTimeout(poll,100);};
          r.probeTimer=setTimeout(poll,100);
        }
      }
    }catch{r.closed=true;r.state='failed';r.code='spawn_failed';r.endedAt=Date.now();notify();}
  }
  function waitReady(r,g,signal,epoch){return new Promise((resolve,reject)=>{
    const check=()=>{try{guard(g);if(epoch!==cancelEpoch||signal?.aborted)throw fail('cancelled');if(!['starting','stopping'].includes(r.state)){cleanup();resolve();}}catch(e){cleanup();reject(e);}};
    const abort=()=>{if(g===generation&&r.state==='starting')void terminate(r).catch(()=>{});check();};
    const cleanup=()=>{waiters.delete(check);signal?.removeEventListener('abort',abort);};waiters.add(check);signal?.addEventListener('abort',abort,{once:true});check();
  });}
  async function action(action,args,g,{signal}={}){
    const owner=guard(g);const epoch=cancelEpoch;
    if(signal?.aborted)throw fail('cancelled');
    if(action==='start'){
      const spec=validateProcessSpec(args,owner.cwd);
      if(spec.ready?.port&&blockedPorts().includes(spec.ready.port))throw fail('reserved_port');
      const fingerprint=createHash('sha256').update(JSON.stringify(spec)).digest('hex');
      const duplicate=[...records.values()].find(r=>r.generation===g&&r.fingerprint===fingerprint&&(ACTIVE.has(r.state)||r.restarting));
      if(duplicate)return {ok:true,duplicate:true,process:summary(duplicate)};
      if([...records.values()].filter(r=>ACTIVE.has(r.state)||!r.closed).length>=8)throw fail('process_limit');
      // Reserve ownership before asynchronous preflight so concurrent starts deduplicate.
      const r={id:randomUUID(),generation:g,revision:1,spec,fingerprint,state:'starting',startedAt:Date.now(),lines:[],bytes:0,cursor:0,closed:true,probeAbort:new AbortController()};records.set(r.id,r);
      if(!canStart()){r.state='failed';r.code='process_limit';throw fail('process_limit');}
      for(const old of records.values())if(records.size>64&&!ACTIVE.has(old.state)&&old.closed)records.delete(old.id);
      if(spec.ready&&spec.ready.type!=='log'&&await probeReady({...spec.ready,type:'tcp'},signal)){
        r.state='failed';r.code='port_in_use';throw fail('port_in_use');
      }
      try{guard(g);if(epoch!==cancelEpoch||signal?.aborted||r.state!=='starting')throw fail('cancelled');await run(r);}catch(e){r.state='failed';r.code=e.code||'cancelled';throw e;}
      return {ok:true,process:summary(r)};
    }
    const keys=action==='logs'?['id','revision','cursor','limit']:action==='status'?['id','revision','waitReady']:['id','revision'];closed(args,keys,'invalid_args');
    if(action==='status'&&((args.waitReady!==undefined&&typeof args.waitReady!=='boolean')||(args.id===undefined&&args.revision!==undefined)))throw fail('invalid_args');
    if(action==='status'&&args.id===undefined)return snapshot();
    const r=lookup(args,g);
    if(action==='status'){
      if(args.waitReady){if(!r.spec.ready)throw fail('ready_strategy_required');await waitReady(r,g,signal,epoch);}return {ok:true,process:summary(r)};
    }
    if(action==='logs'){
      const cursor=args.cursor??0,limit=args.limit??100;
      if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(limit)||limit<1||limit>256)throw fail('invalid_cursor');
      const lines=r.lines.filter(l=>l.cursor>cursor).slice(0,limit);
      return {ok:true,id:r.id,revision:r.revision,lines,cursor:lines.at(-1)?.cursor??cursor,truncated:r.lines.length>0&&cursor<r.lines[0].cursor-1};
    }
    if(action==='stop'){r.controlEpoch=(r.controlEpoch||0)+1;await terminate(r);guard(g,false);if(epoch!==cancelEpoch)throw fail('cancelled');return {ok:true,process:summary(r)};}
    if(action==='restart'){
      if(r.restarting)throw fail('restart_in_progress');r.restarting=true;const controlEpoch=r.controlEpoch=(r.controlEpoch||0)+1;
      try{
        await terminate(r);guard(g);if(epoch!==cancelEpoch||signal?.aborted||r.controlEpoch!==controlEpoch)throw fail('cancelled');
        if(r.spec.ready&&r.spec.ready.type!=='log'&&await probeReady({...r.spec.ready,type:'tcp'},signal))throw fail('port_in_use');
        guard(g);if(epoch!==cancelEpoch||signal?.aborted||r.controlEpoch!==controlEpoch)throw fail('cancelled');if(!canStart())throw fail('process_limit');r.revision++;await run(r);return {ok:true,process:summary(r)};
      }finally{r.restarting=false;}
    }
    throw fail('unknown_action');
  }
  async function cancelActions(){cancelEpoch++;notify();await Promise.all([...records.values()].filter(r=>r.state==='starting'||r.restarting).map(r=>terminate(r)));}
  async function invalidate(){enabled=false;generation=randomUUID();cancelEpoch++;notify();await Promise.all([...records.values()].filter(r=>ACTIVE.has(r.state)||!r.closed).map(r=>terminate(r)));}
  return {snapshot,action,enable(value,g){guard(g,false);if(typeof value!=='boolean')throw fail('invalid_permission');if(value&&snapshot().cleanupPending)throw fail('cleanup_pending');enabled=value;if(!value)return invalidate().then(snapshot);return snapshot();},cancelActions,invalidate,async dispose(){await invalidate();disposed=true;}};
}
