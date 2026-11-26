import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const failure = code => Object.assign(Error('Workspace tool coordination unavailable; restart this session before retrying.'), {code});
// No raw arguments, command text, source paths or contents enter this transport.
// begin may wait for another writer; hello/end/fault have a finite control budget.
export function toolTransport(connection, action, body, {signal,timeoutMs = action === 'begin' ? 0 : 8000} = {}) {
  return new Promise((resolve,reject) => {
    let target;
    try { target = new URL(connection.url); if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !connection.token) throw Error(); }
    catch { reject(failure('tool_guard_unavailable')); return; }
    if (signal?.aborted) { reject(failure('tool_wait_cancelled')); return; }
    const payload = Buffer.from(JSON.stringify(body));
    let done = false, timer;
    const finish = (error,value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort',abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { finish(failure('tool_wait_cancelled')); req.destroy(); };
    const req = http.request(new URL('/'+action,target),{method:'POST',headers:{'content-type':'application/json','content-length':payload.length,'x-pi-gui-tool-token':connection.token}},res => {
      const chunks = []; let size = 0;
      res.on('data',chunk => { size += chunk.length; if (size > 4096) { finish(failure('tool_guard_unavailable')); req.destroy(); } else chunks.push(chunk); });
      res.on('error',() => finish(failure('tool_guard_unavailable')));
      res.on('aborted',() => finish(failure('tool_guard_unavailable')));
      res.on('end',() => {
        try {
          const value = JSON.parse(Buffer.concat(chunks));
          if (res.statusCode !== 200 || value.ok !== true) {
            const code = ['stale_runtime','tool_guard_initializing','invalid_request','tool_wait_cancelled','unauthorized'].includes(value.code) ? value.code : 'tool_guard_unavailable';
            finish(failure(code)); return;
          }
          finish(null,value);
        } catch { finish(failure('tool_guard_unavailable')); }
      });
    });
    req.on('error',() => finish(failure('tool_guard_unavailable')));
    signal?.addEventListener('abort',abort,{once:true});
    if (timeoutMs > 0) timer = setTimeout(() => { finish(failure('tool_guard_unavailable')); req.destroy(); },timeoutMs);
    req.end(payload);
  });
}

export function installToolGuard(pi, connection) {
  let state = null, disposed = false, epoch = 0;
  const leases = new Map();
  const post = (s,action,body,options = {}) => connection.post
    ? connection.post(action,{sessionId:s.native,...body},options)
    : toolTransport(connection,action,{sessionId:s.native,...body},options);
  function valid(s,ctx) {
    return !disposed && state === s && !s.controller.signal.aborted && ctx.cwd === s.cwd && ctx.sessionManager.getSessionId() === s.native;
  }
  function check(s,ctx) { if (!valid(s,ctx)) throw failure('stale_runtime'); if (s.failed) throw failure('tool_guard_unavailable'); }
  function start(ctx) {
    state?.controller.abort();
    state = {native:ctx.sessionManager.getSessionId(),cwd:ctx.cwd,epoch:++epoch,controller:new AbortController(),failed:false,pending:null,verified:false};
    return state;
  }
  function delay(ms,signal) {
    return new Promise((resolve,reject) => {
      const finish = cancelled => { clearTimeout(timer); signal.removeEventListener('abort',abort); if (cancelled) reject(failure('stale_runtime')); else resolve(); };
      const abort = () => finish(true), timer = setTimeout(() => finish(false),ms);
      if (signal.aborted) abort(); else signal.addEventListener('abort',abort,{once:true});
    });
  }
  async function markFailed(s) {
    s.failed = true; s.verified = false;
    // session_start cannot await get_state: Pi binds extensions before attaching
    // stdin (1.6 rpc-mode.js:249,663). Report a fixed private terminal fault after
    // bounded initialization instead of swallowing the asynchronous exception.
    try { await post(s,'fault',{}, {signal:s.controller.signal,timeoutMs:1000}); }
    catch { s.faultUnconfirmed = true; } // backend initialization deadline also revokes
  }
  async function hello(ctx) {
    const s = state || start(ctx); check(s,ctx);
    if (!s.pending) {
      s.pending = (async () => {
        const deadline = Date.now() + 8000;
        for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
          check(s,ctx);
          try {
            await post(s,'hello',{}, {signal:s.controller.signal,timeoutMs:Math.max(1,deadline-Date.now())});
            check(s,ctx); if (Date.now() >= deadline) throw failure('tool_guard_unavailable');
            s.verified = true; return;
          } catch (error) {
            if (!valid(s,ctx)) throw failure('stale_runtime');
            if (['stale_runtime','invalid_request','unauthorized','tool_wait_cancelled'].includes(error?.code)) {
              await markFailed(s); throw failure(error.code);
            }
            // initializing is a non-authorizing hint, not a new session or a new
            // budget. Keep the same controller/native/cwd and the same 3 tries.
            if (attempt < 2 && Date.now() < deadline) await delay(Math.min((connection.retryDelayMs ?? 100) * (attempt+1),deadline-Date.now()),s.controller.signal);
          }
        }
        await markFailed(s);
        throw failure('tool_guard_unavailable');
      })().finally(() => { s.pending = null; });
    }
    await s.pending; check(s,ctx);
    return s;
  }
  pi.on('session_start',(_event,ctx) => {
    const s = start(ctx);
    // Do not clear outstanding leases on session replacement. Their execution
    // outcome is unknown until the owning end/settled or confirmed parent cleanup.
    void hello(ctx).catch(async () => { if (valid(s,ctx) && !s.failed) await markFailed(s); });
  });
  pi.on('session_shutdown',() => { state?.controller.abort(); });
  pi.on('tool_call',async(event,ctx) => {
    const s = await hello(ctx); check(s,ctx);
    if (ctx.signal?.aborted) throw failure('tool_wait_cancelled');
    if (leases.has(event.toolCallId)) throw failure('invalid_request');
    const sourceProof = () => { const s = pi.getAllTools().find(t => t.name === event.toolName)?.sourceInfo; return JSON.stringify(['source','path','scope','origin','baseDir','changelogPath'].map(key => s?.[key])); };
    const tools = pi.getAllTools(), source = tools.find(t => t.name === event.toolName)?.sourceInfo, sourceIdentity = sourceProof();
    const readOnly = ['read','ls','find','grep'].includes(event.toolName) && source?.source === 'builtin';
    const lease = {id:randomUUID(),state:s,submitted:false}; leases.set(event.toolCallId,lease);
    let audit;
    try {
      if (connection.audit) {
        audit = {kind:readOnly?'read':'unknown',path:null,expectedHash:null};
        const normalize = v => { let p = String(v||''); try { if (p.startsWith('file:')) p = fileURLToPath(p); } catch { return ''; } p = p.replaceAll('\\','/'); return process.platform === 'win32' ? p.toLowerCase() : p; };
        if (['write','edit'].includes(event.toolName) && (source?.source === 'builtin' || connection.revertSource && normalize(source?.path) === normalize(connection.revertSource)) && typeof event.input?.path === 'string') {
          const target = path.resolve(ctx.cwd,event.input.path), relative = path.relative(ctx.cwd,target).replaceAll('\\','/');
          audit.kind = event.toolName; audit.path = relative;
          if (relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) {
            if (event.toolName === 'write' && typeof event.input.content === 'string') audit.expectedHash = createHash('sha256').update(event.input.content).digest('hex');
            if (event.toolName === 'edit' && typeof event.input.oldText === 'string' && typeof event.input.newText === 'string') {
              try {
                const st = await fs.lstat(target); check(s,ctx);
                if (st.isFile() && !st.isSymbolicLink() && st.size <= 1024*1024) {
                  const before = await fs.readFile(target,'utf8'); check(s,ctx);
                  if (before.includes(event.input.oldText) && before.split(event.input.oldText).length === 2) audit.expectedHash = createHash('sha256').update(before.replace(event.input.oldText,event.input.newText)).digest('hex');
                }
              } catch { check(s,ctx); /* unknown intended bytes stays unconfirmed */ }
            }
          }
        }
      }
      check(s,ctx);
      if (sourceProof() !== sourceIdentity) throw failure('stale_runtime');
      lease.submitted = true;
      const signal = ctx.signal ? AbortSignal.any([s.controller.signal,ctx.signal]) : s.controller.signal;
      await post(s,'begin',{callId:lease.id,toolCallId:event.toolCallId,readOnly,...(audit?{audit}:{})},{signal});
      check(s,ctx);
      if (sourceProof() !== sourceIdentity || ctx.signal?.aborted) throw failure('stale_runtime');
    } catch (error) {
      if (!lease.submitted && leases.get(event.toolCallId) === lease) leases.delete(event.toolCallId);
      throw error;
    }
  });
  const end = async id => {
    const lease = leases.get(id); if (!lease) return;
    if (!lease.ending) lease.ending = post(lease.state,'end',{callId:lease.id},{timeoutMs:8000}).then(() => {
      if (leases.get(id) === lease) leases.delete(id);
    }).finally(() => { lease.ending = null; });
    await lease.ending;
  };
  // Parent execution_end follows all result hooks, including errors/blocked
  // calls. Nested calls retain their parent's lease until the parent ends.
  pi.on('tool_execution_end',event => end(event.toolCallId));
  pi.on('tool_result',event => event.parentToolCallId ? end(event.toolCallId) : undefined);
  pi.on('agent_settled',async () => { for (const id of [...leases.keys()]) await end(id); });
  return {dispose() { disposed = true; state?.controller.abort(); }, status:() => ({failed:state?.failed === true,verified:state?.verified === true,leases:leases.size})};
}

export default function toolGuardExtension(pi) {
  const connection = {url:process.env.PI_GUI_TOOL_URL,token:process.env.PI_GUI_TOOL_TOKEN,audit:process.env.PI_GUI_CANDIDATE_AUDIT === '1',revertSource:process.env.PI_GUI_TOOL_REVERT_SOURCE};
  if (connection.url && connection.token) installToolGuard(pi,connection);
}
