import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// No raw arguments, command text or contents enter this transport. Candidate
// evidence adds only a validated target and an intended-result hash.
export function toolTransport(connection, action, body) {
  return new Promise((resolve,reject) => {
    let target; try {target=new URL(connection.url);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!connection.token)throw Error();}
    catch {reject(Error('Workspace tool coordination unavailable'));return;}
    const payload=Buffer.from(JSON.stringify(body));
    const req=http.request(new URL('/'+action,target),{method:'POST',headers:{'content-type':'application/json','content-length':payload.length,'x-pi-gui-tool-token':connection.token}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>4096)req.destroy();else chunks.push(chunk);});
      res.on('error',()=>reject(Error('Workspace tool coordination unavailable')));
      res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks));if(res.statusCode!==200||value.ok!==true)throw Error();resolve(value);}catch{reject(Error('Workspace tool coordination unavailable or cancelled'));}});
    });
    req.on('error',()=>reject(Error('Workspace tool coordination unavailable')));
    // Waiting is explicitly cancelled by the owning Stop/retire path. A fixed
    // timeout would incorrectly turn another session's long tool into a failure.
    req.end(payload);
  });
}

export function installToolGuard(pi, connection) {
  let native = null;
  const leases = new Map();
  const post = (action,body) => connection.post ? connection.post(action,{sessionId:native,...body}) : toolTransport(connection,action,{sessionId:native,...body});
  const hello = async ctx => {native=ctx.sessionManager.getSessionId();await post('hello',{});};
  pi.on('session_start',(_event,ctx)=>{native=ctx.sessionManager.getSessionId();leases.clear();void hello(ctx).catch(()=>{});});
  pi.on('tool_call',async(event,ctx)=>{
    await hello(ctx);
    const readOnly=['read','ls','find','grep'].includes(event.toolName) && pi.getAllTools().find(t=>t.name===event.toolName)?.sourceInfo?.source==='builtin';
    const leaseId=randomUUID();leases.set(event.toolCallId,leaseId);
    let audit;
    if(connection.audit){
      audit={kind:readOnly?'read':'unknown',path:null,expectedHash:null};
      const source=pi.getAllTools().find(t=>t.name===event.toolName)?.sourceInfo;
      const normalize=v=>{let p=String(v||'');try{if(p.startsWith('file:'))p=fileURLToPath(p);}catch{return'';}p=p.replaceAll('\\','/');return process.platform==='win32'?p.toLowerCase():p;};
      if(['write','edit'].includes(event.toolName)&&(source?.source==='builtin'||connection.revertSource&&normalize(source?.path)===normalize(connection.revertSource))&&typeof event.input?.path==='string'){
        const target=path.resolve(ctx.cwd,event.input.path),relative=path.relative(ctx.cwd,target).replaceAll('\\','/');
        audit.kind=event.toolName;audit.path=relative;
        if(relative&&relative!=='..'&&!relative.startsWith('../')&&!path.isAbsolute(relative)){
          if(event.toolName==='write'&&typeof event.input.content==='string')audit.expectedHash=createHash('sha256').update(event.input.content).digest('hex');
          if(event.toolName==='edit'&&typeof event.input.oldText==='string'&&typeof event.input.newText==='string'){
            try{const s=await fs.lstat(target);if(s.isFile()&&!s.isSymbolicLink()&&s.size<=1024*1024){const before=await fs.readFile(target,'utf8');if(before.includes(event.input.oldText)&&before.split(event.input.oldText).length===2)audit.expectedHash=createHash('sha256').update(before.replace(event.input.oldText,event.input.newText)).digest('hex');}}catch{/* unknown intended bytes stays unconfirmed */}
          }
        }
      }
    }
    try {await post('begin',{callId:leaseId,toolCallId:event.toolCallId,readOnly,...(audit?{audit}:{})});}
    catch(error){leases.delete(event.toolCallId);throw error;}
  });
  const end = async id => {const lease=leases.get(id);if(!lease)return;await post('end',{callId:lease});leases.delete(id);};
  // Parent execution_end occurs after all result hooks, including errors and
  // blocked calls. Nested calls retain the parent lease until the parent ends.
  pi.on('tool_execution_end',event=>end(event.toolCallId));
  pi.on('tool_result',event=>event.parentToolCallId ? end(event.toolCallId) : undefined);
  pi.on('agent_settled',async()=>{for(const id of [...leases.keys()])await end(id);});
}

export default function toolGuardExtension(pi) {
  const connection={url:process.env.PI_GUI_TOOL_URL,token:process.env.PI_GUI_TOOL_TOKEN,audit:process.env.PI_GUI_CANDIDATE_AUDIT==='1',revertSource:process.env.PI_GUI_TOOL_REVERT_SOURCE};
  if(connection.url&&connection.token)installToolGuard(pi,connection);
}
