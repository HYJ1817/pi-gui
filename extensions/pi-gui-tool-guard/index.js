import http from 'node:http';
import { randomUUID } from 'node:crypto';

// Tool arguments, command text and file contents never enter this transport.
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
    try {await post('begin',{callId:leaseId,toolCallId:event.toolCallId,readOnly});}
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
  const connection={url:process.env.PI_GUI_TOOL_URL,token:process.env.PI_GUI_TOOL_TOKEN};
  if(connection.url&&connection.token)installToolGuard(pi,connection);
}
