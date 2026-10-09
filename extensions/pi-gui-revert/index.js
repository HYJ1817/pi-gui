import http from 'node:http';
import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 2 * 1024 * 1024;
const OWN_SOURCE = fileURLToPath(import.meta.url);
const failure = code => Object.assign(new Error(code), { captureCode: code });
const equalBytes = (a,b) => a === null ? b === null : b !== null && a.equals(b);
const encode = bytes => bytes === null ? null : bytes.toString('base64');

// Private loopback transport: no response values or native network errors escape.
export function transport(connection, endpoint, body) {
  return new Promise((resolve,reject) => {
    let target;
    try { target = new URL(connection.url); if(target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !connection.token) throw Error(); }
    catch { reject(failure('capture_failed')); return; }
    const bytes = Buffer.from(JSON.stringify(body));
    if(bytes.length > 6 * MAX_BYTES) { reject(failure('capture_failed')); return; }
    const req = http.request(new URL(endpoint,target), {method:'POST',headers:{'content-type':'application/json','content-length':bytes.length,'x-pi-session-change-token':connection.token}}, res => {
      const chunks=[]; let size=0;
      res.on('data', chunk => { size+=chunk.length; if(size>65536) req.destroy(); else chunks.push(chunk); });
      res.on('error', () => reject(failure('capture_failed')));
      res.on('end', () => { try { const result=JSON.parse(Buffer.concat(chunks)); if(res.statusCode!==200 || result.ok!==true) throw Error(); resolve(result); } catch { reject(failure('capture_failed')); } });
    });
    req.on('error',()=>reject(failure('capture_failed')));
    req.setTimeout(45000,()=>req.destroy());
    req.end(bytes);
  });
}

export function installSessionChangeExtension(pi, {createWriteToolDefinition, createEditToolDefinition, connection, fs=nativeFs, ownSource=OWN_SOURCE}) {
  const factories={write:createWriteToolDefinition,edit:createEditToolDefinition};
  const calls=new Map();
  const remember = (callId, value) => {
    calls.set(callId,value);
    while(calls.size>128) calls.delete(calls.keys().next().value);
  };
  let sessionId=null;
  const post = async (endpoint, body={}) => {
    try { const result=await (connection.post ? connection.post(endpoint,{nativeSessionId:sessionId,...body}) : transport(connection,endpoint,{nativeSessionId:sessionId,...body})); if(result?.ok!==true) throw Error(); return result; }
    catch { throw failure('capture_failed'); }
  };
  const sourceOf = name => {
    const info=pi.getAllTools().find(tool=>tool.name===name)?.sourceInfo;
    if(info?.source==='builtin') return 'builtin';
    const normalizeSource = value => process.platform==='win32' ? value.toLowerCase().replaceAll('\\','/') : value;
    if(info?.path && (normalizeSource(info.path)===normalizeSource(ownSource) || info.path===import.meta.url)) return 'own';
    return 'conflict';
  };
  const sources = () => ({write:sourceOf('write'),edit:sourceOf('edit')});
  const announce = () => post('/hello',{version:1,sources:sources()});
  const state = () => post('/state');
  const gap = reason => post('/gap',{reason});
  async function synchronize(ctx) {
    const nativeId=ctx.sessionManager.getSessionId();
    if(nativeId!==sessionId) { sessionId=nativeId; calls.clear(); }
  }

  async function guardedSnapshot(cwd, absolutePath) {
    const root=path.resolve(cwd), target=path.resolve(absolutePath), rel=path.relative(root,target);
    if(!rel || rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw failure('capture_path');
    const lineage=[];
    // Check root and every ancestor too: a lexical workspace can itself traverse a link.
    const parsed=path.parse(target); let cursor=parsed.root;
    for(const part of target.slice(parsed.root.length).split(path.sep)) {
      cursor=path.join(cursor,part);
      try {
        const stat=await fs.lstat(cursor);
        if(stat.isSymbolicLink() || (cursor===target && (!stat.isFile() || stat.nlink>1))) throw failure('capture_path');
        if(cursor!==target && !stat.isDirectory()) throw failure('capture_path');
        lineage.push([cursor,stat.dev,stat.ino]);
      } catch(error) { if(error.code!=='ENOENT') throw error; lineage.push([cursor,null,null]); }
    }
    let data=null, identity=null;
    try {
      // Opening by descriptor prevents a large replacement from causing an unbounded read.
      const handle=await fs.open(target,'r');
      try {
        const stat=await handle.stat();
        if(!stat.isFile() || stat.nlink>1 || stat.size>MAX_BYTES) throw failure('capture_path');
        const buffer=Buffer.alloc(MAX_BYTES+1); let length=0;
        while(length<buffer.length) { const result=await handle.read(buffer,length,buffer.length-length,null); if(!result.bytesRead) break; length+=result.bytesRead; }
        if(length>MAX_BYTES) throw failure('capture_path');
        const current=await fs.lstat(target);
        if(current.isSymbolicLink() || current.dev!==stat.dev || current.ino!==stat.ino || current.nlink>1) throw failure('capture_conflict');
        data=buffer.subarray(0,length); identity=[stat.dev,stat.ino];
      } finally { await handle.close(); }
    } catch(error) { if(error.code!=='ENOENT') throw error; }
    // A swapped ancestor can redirect an otherwise ordinary-looking final file.
    for(const [p,dev,ino] of lineage) {
      try { const stat=await fs.lstat(p); if(dev===null || stat.isSymbolicLink() || stat.dev!==dev || stat.ino!==ino) throw failure('capture_conflict'); }
      catch(error) { if(error.code!=='ENOENT' || dev!==null) throw error; }
    }
    return {data,identity,lineage};
  }
  async function recheck(cwd,target,before) {
    const now=await guardedSnapshot(cwd,target);
    if(JSON.stringify(now.identity)!==JSON.stringify(before.identity) || JSON.stringify(now.lineage)!==JSON.stringify(before.lineage) || !equalBytes(now.data,before.data)) throw failure('capture_conflict');
  }

  async function execute(name, callId, args, signal, update, ctx) {
    await synchronize(ctx);
    const ioId = randomUUID(), nativeSessionId = sessionId;
    await post('/begin-io', { ioId, nativeSessionId });
    try { return await executeCaptured(name, callId, args, signal, update, ctx); }
    finally { await post('/end-io', { ioId, nativeSessionId }); }
  }
  async function executeCaptured(name, callId, args, signal, update, ctx) {
    await synchronize(ctx);
    const nativeSessionId=sessionId;
    let current=await state();
    if(!current.enabled) {
      // Explicit disable must remain usable when the evidence store is broken.
      await gap('disabled').catch(()=>{});
      try { return await factories[name](ctx.cwd).execute(callId,args,signal,update,ctx); }
      finally { calls.delete(callId); }
    }
    await announce();
    current=await state();
    if(Object.values(sources()).some(source=>source!=='own') || current.sourceVerified!==true) { await announce(); await gap('source_changed'); throw failure('capture_source_conflict'); }
    const operationId=randomUUID(), parentCallId=calls.get(callId)?.parentToolCallId;
    const parentOperationId=parentCallId ? calls.get(parentCallId)?.operationId || null : null;
    remember(callId,{...calls.get(callId),operationId,nativeSessionId,settled:false});
    if(parentCallId && !parentOperationId) await gap('incomplete');
    let target=null, before=null, intended=null, captured=false, prepared=false, attempted=false, completed=false, newDirectories=false;
    const payload=()=>({nativeSessionId,operationId,parentOperationId,toolCallId:callId,path:target,effectiveToolSource:'pi-gui-revert'});
    const capture = async absolutePath => {
      target=absolutePath;
      try { await post('/policy',{nativeSessionId,path:target}); before=await guardedSnapshot(ctx.cwd,target); await post('/before',{...payload(),before:encode(before.data)}); }
      catch(error) { await gap('capture_failed'); throw error.captureCode ? error : failure('capture_path'); }
      captured=true;
      return before.data;
    };
    const operations={
      // Official write calls mkdir before writeFile. Delay side effects until A is durable.
      mkdir: async () => {},
      access: async absolutePath => { await post('/policy',{nativeSessionId,path:absolutePath}); await fs.access(absolutePath,6); },
      readFile: async absolutePath => { const bytes=await capture(absolutePath); if(bytes===null) { const err=Error('File not found'); err.code='ENOENT'; throw err; } return bytes; },
      writeFile: async (absolutePath,content) => {
        if(!captured) await capture(absolutePath);
        if(target!==absolutePath) throw failure('capture_conflict');
        intended=Buffer.from(content,'utf8');
        if(intended.length>MAX_BYTES) throw failure('capture_path');
        await post('/prepare',{...payload(),before:encode(before.data),intendedAfter:encode(intended)});
        prepared=true;
        await recheck(ctx.cwd,target,before);
        newDirectories=before.lineage.some(([p,dev])=>p!==target && dev===null);
        if(newDirectories) await gap('incomplete');
        if(name==='write') await fs.mkdir(path.dirname(target),{recursive:true});
        // Revalidate existing parents after mkdir; created parents must still be directories.
        const parentCheck=await guardedSnapshot(ctx.cwd,target);
        if(!equalBytes(parentCheck.data,before.data) || JSON.stringify(parentCheck.identity)!==JSON.stringify(before.identity)) throw failure('capture_conflict');
        for(const [p,dev,ino] of before.lineage) {
          if(p===target || dev===null) continue;
          const info=await fs.lstat(p); if(info.isSymbolicLink() || info.dev!==dev || info.ino!==ino) throw failure('capture_conflict');
        }
        attempted=true;
        await fs.writeFile(target,content,'utf8');
        completed=true;
      },
    };
    let result, upstreamError;
    try { result=await factories[name](ctx.cwd,{operations}).execute(callId,args,signal,update,ctx); }
    catch(error) { upstreamError=error; }
    finally {
      if(captured) {
        let observed=null, observedKnown=false;
        try { observed=(await guardedSnapshot(ctx.cwd,target)).data; observedKnown=true; } catch { /* Evidence remains incomplete; never infer absence. */ }
        const mutationOutcome=observedKnown ? equalBytes(observed,before.data) ? 'unchanged' : attempted ? 'written' : 'unknown' : 'unknown';
        const verified=prepared && completed && observedKnown && equalBytes(observed,intended) && !newDirectories;
        try {
          await post('/settle',{nativeSessionId,operationId,observedAfter:encode(observed),toolOutcome:signal?.aborted?'aborted':upstreamError?'error':'success',mutationOutcome,evidenceLevel:verified?'intent_verified':'incomplete'});
          remember(callId,{...calls.get(callId),operationId,nativeSessionId,settled:true,wasAborted:signal?.aborted===true});
        } catch(error) { await post('/gap',{nativeSessionId,reason:'incomplete'}); throw error; }
      }
      if(!captured && attempted) await gap('incomplete');
    }
    if(upstreamError) throw upstreamError;
    return result;
  }

  pi.on('session_start',async (_event,ctx) => {
    sessionId=ctx.sessionManager.getSessionId(); calls.clear();
    for(const name of ['write','edit']) {
      if(sourceOf(name)==='builtin') { const official=factories[name](ctx.cwd); pi.registerTool({...official,execute:(...args)=>execute(name,...args)}); }
    }
    // RPC stdin is not listening yet during session_start. Bridge authority may
    // itself request get_state, so awaiting the handshake here would deadlock.
    // Every actual call repeats and awaits it once dispatch is available.
    void announce().catch(()=>{});
  });
  const track = async (event,ctx) => {
    await synchronize(ctx);
    const current=await state();
    if(!calls.has(event.toolCallId)) remember(event.toolCallId,{parentToolCallId:event.parentToolCallId});
    if(!current.enabled) { await gap('disabled').catch(()=>{}); return; }
    await announce();
    if(['write','edit'].includes(event.toolName)) {
      if(Object.values(sources()).some(source=>source!=='own')) { await announce(); await gap('source_changed'); if((await state()).enabled) return {block:true,reason:'capture_source_conflict'}; }
    } else if(!(['read','ls','find','grep'].includes(event.toolName) && sourceOf(event.toolName)==='builtin')) await gap('unknown_tool');
  };
  pi.on('tool_call',track);
  pi.on('tool_execution_start', event => { if(!calls.has(event.toolCallId)) remember(event.toolCallId,{parentToolCallId:event.parentToolCallId}); });
  pi.on('tool_execution_end', async event => {
    const call=calls.get(event.toolCallId);
    try {
      if(call?.settled) {
        try { await post('/outcome',{nativeSessionId:call.nativeSessionId,operationId:call.operationId,toolOutcome:event.isError ? call.wasAborted ? 'aborted' : 'error' : 'success'}); }
        catch(error) { await post('/gap',{nativeSessionId:call.nativeSessionId,reason:'incomplete'}); throw error; }
      }
    } finally { calls.delete(event.toolCallId); }
  });
  pi.registerCommand('gui-capture',{description:'Enable/disable private session file capture, or exclude a path prefix.',handler:async (args,ctx) => {
    await synchronize(ctx);
    const command=String(args||'').trim();
    if(command==='disable') {
      const result=await post('/configure',{enabled:false});
      if(result.persisted===false) ctx.ui?.notify?.('Capture is disabled for this launch. The setting could not be saved; disable it again after restarting Pi.','warning');
      return;
    }
    if(command==='enable') {
      await announce();
      const current=await state();
      if(!ctx.ui?.confirm || !await ctx.ui.confirm('Enable private file capture?', 'Capture stores private before/after file contents for at least 7 days, up to 2 MiB per file. This version does not automatically delete snapshots. Only guarded built-in write/edit calls are covered; shell and other tools are not covered. Exclude sensitive paths before enabling.')) return;
      await post('/configure',{enabled:true,acknowledged:true,exclusions:current.exclusions||[]});
    } else if(command.startsWith('exclude ')) { const current=await state(); if(current.enabled) await announce(); const prefix=command.slice(8).trim(); if(prefix) await post('/configure',{enabled:current.enabled,acknowledged:current.enabled===true,exclusions:[...(current.exclusions||[]),prefix]}); }
  }});
}

export default async function sessionChangeExtension(pi) {
  const connection={url:process.env.PI_GUI_SESSION_CHANGE_URL,token:process.env.PI_GUI_SESSION_CHANGE_TOKEN};
  if(!connection.url || !connection.token) return;
  // The parent binds this exact public package entry to the actual launched Pi.
  // Bare imports resolve relative to this bundled file, not Pi's installation.
  let createWriteToolDefinition, createEditToolDefinition;
  try {
    const entry=new URL(process.env.PI_GUI_SESSION_CHANGE_API);
    if(entry.protocol!=='file:' || entry.search || entry.hash) throw Error();
    ({createWriteToolDefinition,createEditToolDefinition}=await import(entry.href));
    if(typeof createWriteToolDefinition!=='function' || typeof createEditToolDefinition!=='function') throw Error();
  } catch { throw failure('pi_api_unavailable'); }
  installSessionChangeExtension(pi,{createWriteToolDefinition,createEditToolDefinition,connection});
}
