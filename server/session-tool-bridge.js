import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { materializeDir } from '../lib/assets.js';
import { json, readRawBody } from './http-utils.js';
import { probeSessionToolGuard } from './pi-probes.js';

const fail = code => { throw Object.assign(Error('Workspace tool coordination unavailable; restart this session before retrying.'), { code }); };
const closed = (v, keys) => v && !Array.isArray(v) && typeof v === 'object' && Object.keys(v).every(k => keys.includes(k));
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 256;
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const canonical = p => { const v = fs.realpathSync.native(p); return process.platform === 'win32' ? v.toLowerCase() : v; };
const stamp = p => {
  const s = fs.statSync(p); if (!s.isFile() || s.size > 512*1024) throw Error();
  const bytes = fs.readFileSync(p);
  return JSON.stringify([canonical(p),s.dev,s.ino,s.birthtimeMs,s.mtimeMs,s.size,createHash('sha256').update(bytes).digest('hex')]);
};
const directory = p => { const s = fs.statSync(p); return JSON.stringify([canonical(p),s.dev,s.ino,s.birthtimeMs]); };

// One private capability per launched child. Renderer never chooses a root or
// supplies a lock owner. Revocation/Stop cancel waiting calls, never active writers.
// The existing RPC owner supplies the synchronous session-mutation witness; it is
// not reconstructed from a possibly stale get_state response.
export function createSessionToolBridge({ scheduler, launch, getCwd, getRoot = getCwd, readState, supported,
  capture = () => null, isCurrent = () => true, canRevalidate = () => false, isInitializing = () => false, onEvent = () => {}, audit = null,
  initializationMs = 30000, readTimeoutMs = 1000, retryDelayMs = 50 } = {}) {
  let server = null, binding = null, disposed = false, preparing = null, revision = 0;
  const bindings = new Set();
  const sourceKey = () => launch.identityKey?.() ?? launch.packageDir?.() ?? null;
  function sourceStamp() {
    if (supported !== undefined) return null; // explicit offline-fixture contract
    const pkg = launch.packageDir();
    return [stamp(path.join(pkg,'dist/core/extensions/types.d.ts')),stamp(path.join(pkg,'dist/core/session-manager.d.ts'))].join('|');
  }
  function valid(b) {
    try {
      return !disposed && binding === b && !b.revoked && b.cwd === directory(getCwd()) && b.rootIdentity === directory(b.rootPath)
        && b.source === sourceKey() && b.contract === sourceStamp() && b.guardStamp === stamp(b.guardPath);
    } catch { return false; }
  }
  function check(b, witness, epoch = b.epoch, revalidating = false) {
    if (!valid(b)) fail('tool_guard_unavailable');
    if (b.epoch !== epoch || !isCurrent(witness)) fail('stale_runtime');
    if (b.witness && !isCurrent(b.witness)
      && !(revalidating && !b.paused && !b.calls.size && canRevalidate(b.witness,witness))) fail('stale_runtime');
  }
  function revalidation(b, witness) {
    // Only the owner may prove that the original child's session epoch advanced
    // and its existing RPC ledger settled. A fresh capture alone proves nothing.
    return Boolean(b.witness && !isCurrent(b.witness) && !b.paused && !b.calls.size && canRevalidate(b.witness,witness));
  }
  function cancelWaits(b) { for (const cancel of [...b.waits]) cancel(); }
  function retire(b) {
    if (b.revoked && !b.calls.size) { b.channel.close(false); bindings.delete(b); }
  }
  function revoke(b) {
    if (!b || b.revoked) return;
    revision++; b.revoked = true; b.epoch++; b.channel.pause(); cancelWaits(b); b.finishInitial(false); retire(b);
  }
  // All timers/listeners belong to this exact binding. RPC reads cannot be
  // cancelled remotely; their late result is ignored and never changes readiness.
  function bounded(b, operation, timeoutMs) {
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; clearTimeout(timer); b.waits.delete(cancel); resolve(value); };
      const cancel = () => finish(null), timer = setTimeout(cancel, timeoutMs);
      b.waits.add(cancel);
      if (operation) Promise.resolve().then(() => done ? null : operation()).then(finish, () => finish(null));
    });
  }
  async function current(b, expected, witness, epoch = b.epoch, revalidating = false) {
    const verify = () => check(b,witness,epoch,revalidating);
    verify();
    if (!text(expected)) fail('stale_runtime');
    // Concurrent hello/assertReady readers share verification, not separate
    // initialization attempts. Every caller still checks its own full witness.
    if (!b.reading || b.reading.sessionId !== expected || b.reading.epoch !== epoch || !isCurrent(b.reading.witness)) {
      const reading = { sessionId:expected, epoch, witness };
      reading.promise = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          verify();
          const state = await bounded(b,readState,readTimeoutMs);
          verify();
          if (state && !Object.hasOwn(state,'__error')) {
            if (state.sessionId !== expected) {
              // A fresh proof for the old native may race the real new hello.
              // Reject it, but do not poison that hello's bounded recovery. No
              // native is rebound here; ordinary unexplained drift still revokes.
              if (b.native && !revalidating) revoke(b);
              fail('stale_runtime');
            }
            return;
          }
          if (attempt < 2) { await bounded(b,null,retryDelayMs); verify(); }
        }
        if (b.native) revoke(b);
        fail('tool_guard_unavailable');
      })().finally(() => { if (b.reading === reading) b.reading = null; });
      b.reading = reading;
    }
    await b.reading.promise;
    verify();
  }
  function unrelated(b, event) {
    // Pi 1.6 rpc-mode.js forwards runner ext.path as extensionPath. loader.js
    // retains the supplied full path; command:*, <boundary>, missing/relative
    // paths are not proven extension identities. Never guess by basename.
    try {
      let source = event.extensionPath;
      if (typeof source !== 'string' || !source || /[\x00-\x1f\x7f]/.test(source)) return false;
      if (source.startsWith('file:')) { const url = new URL(source); if (url.search || url.hash) return false; source = fileURLToPath(url); }
      if (!path.isAbsolute(source) || !fs.statSync(source).isFile()) return false;
      return canonical(source) !== canonical(b.guardPath);
    } catch { return false; }
  }
  async function route(req,res) {
    const b = [...bindings].find(candidate => same(req.headers['x-pi-gui-tool-token'],candidate.token));
    if (req.method !== 'POST' || req.headers.origin || !b) return json(res,403,{ok:false,code:'unauthorized'});
    try {
      const body = JSON.parse((await readRawBody(req,4096)).toString('utf8'));
      if (disposed) fail('tool_guard_unavailable');
      if (req.url === '/end') {
        if (!closed(body,['sessionId','callId']) || !text(body.callId)) fail('invalid_request');
        const call = b.calls.get(body.callId);
        // A queued begin cancelled by Stop never acquired a writer. Pi still
        // emits execution_end/settled for that blocked call; ending an absent
        // lease is an idempotent no-op, not a new guard failure or a lock release.
        if (!call && body.sessionId === b.native && text(b.native)) return json(res,200,{ok:true});
        if (!call || call.sessionId !== body.sessionId) fail('stale_runtime');
        // A genuine execution_end remains usable after revocation/Stop. Only
        // this record's end or authoritative settled/cleanup may release it.
        await audit?.({phase:'end',callId:body.callId});
        if (disposed || b.calls.get(body.callId) !== call) fail('stale_runtime');
        b.channel.release(body.callId); b.calls.delete(body.callId); retire(b);
        return json(res,200,{ok:true});
      }
      if (b !== binding || !valid(b)) fail('tool_guard_unavailable');
      const witness = capture(body.sessionId); let epoch = b.epoch;
      if (req.url === '/fault') {
        if (!closed(body,['sessionId']) || !text(body.sessionId)) fail('invalid_request');
        // Exhausting a real session_start's transition budget is terminal too.
        // Revocation never releases its outstanding/unknown writer leases.
        const advancing = isInitializing(b.witness,witness) || canRevalidate(b.witness,witness);
        if (b.native && body.sessionId !== b.native) {
          if (!advancing) fail('stale_runtime');
        } else if (!advancing) check(b,witness,epoch);
        revoke(b); return json(res,200,{ok:true});
      }
      if (req.url === '/hello') {
        if (!closed(body,['sessionId']) || !text(body.sessionId)) fail('invalid_request');
        const changingNative = Boolean(b.native && body.sessionId !== b.native);
        // This is only a non-authorizing retry hint for an actual in-flight RPC
        // mutation. It must not bind a native, finish initialization or touch leases.
        if (changingNative && !b.paused && !b.calls.size && isInitializing(b.witness,witness)) fail('tool_guard_initializing');
        if (b.paused || !isCurrent(witness)) fail('stale_runtime');
        const refreshing = revalidation(b,witness), previousNative = b.native;
        check(b,witness,epoch,refreshing);
        if (changingNative) {
          if (b.calls.size || !refreshing) fail('stale_runtime');
          // Retire old reads/proofs, but retain the original child's hello fact
          // until both the owner and a new strict native read have been proved.
          revision++; b.epoch++; epoch = b.epoch;
        }
        try {
          await current(b,body.sessionId,witness,epoch,refreshing);
          check(b,witness,epoch,refreshing);
          if (b.paused || b.native !== previousNative && b.native !== body.sessionId) fail('stale_runtime');
          b.native = body.sessionId; b.witness = witness; b.finishInitial(true);
        } catch (error) { if (changingNative && b.epoch === epoch) revoke(b); throw error; }
        return json(res,200,{ok:true});
      }
      if (body.sessionId !== b.native || !text(b.native)) fail('stale_runtime');
      if (req.url !== '/begin') fail('invalid_request');
      if (!closed(body,['sessionId','callId','toolCallId','readOnly',...(audit?['audit']:[])]) || !text(body.callId) || !text(body.toolCallId) || typeof body.readOnly !== 'boolean' || b.calls.has(body.callId)) fail('invalid_request');
      if (body.audit !== undefined && (!closed(body.audit,['kind','path','expectedHash']) || !['read','write','edit','unknown'].includes(body.audit.kind)
        || body.audit.path !== null && (typeof body.audit.path !== 'string' || body.audit.path.length > 512)
        || body.audit.expectedHash !== null && !/^[a-f0-9]{64}$/.test(body.audit.expectedHash))) fail('invalid_request');
      if (b.paused) fail('tool_wait_cancelled');
      const refreshing = revalidation(b,witness);
      await current(b,b.native,witness,epoch,refreshing);
      check(b,witness,epoch,refreshing);
      b.witness = witness;
      if (b.paused || b.calls.has(body.callId)) fail('tool_wait_cancelled');
      const call = {toolCallId:body.toolCallId,sessionId:body.sessionId,granted:false};
      b.calls.set(body.callId,call);
      const disconnected = () => b.channel.cancel(body.callId);
      res.once('close',disconnected);
      try {
        await b.channel.acquire(body.callId,{readOnly:body.readOnly}); call.granted = true;
        check(b,witness,epoch);
        await audit?.({phase:'begin',callId:body.callId,audit:body.audit});
        check(b,witness,epoch);
        if (b.paused || res.destroyed || b.calls.get(body.callId) !== call) fail('tool_wait_cancelled');
      } catch (error) {
        // Acquisition failure never owned a writer. Once granted, loss of an ACK
        // is unknown execution, not permission to release another session's lock.
        if (!call.granted && b.calls.get(body.callId) === call) b.calls.delete(body.callId);
        retire(b);
        throw error;
      } finally { res.off('close',disconnected); }
      return json(res,200,{ok:true});
    } catch(e) { return json(res,409,{ok:false,code:['stale_runtime','tool_guard_initializing','invalid_request','tool_wait_cancelled','stale_workspace','workspace_revert_busy'].includes(e.code)?e.code:'tool_guard_unavailable'}); }
  }
  return {
    available: () => true,
    revision: () => revision,
    prepare() {
      if (preparing) return preparing;
      preparing = (async () => {
        revoke(binding);
        const capable = supported !== undefined ? supported : probeSessionToolGuard(launch.packageDir()).state === true;
        if (disposed || !await capable) return null;
        const cwd = directory(getCwd()), source = sourceKey(), contract = sourceStamp();
        const guardPath = path.join(materializeDir('extensions/pi-gui-tool-guard'),'index.js'), guardStamp = stamp(guardPath);
        const rootPath = await getRoot(), rootIdentity = directory(rootPath);
        if (disposed || cwd !== directory(getCwd()) || source !== sourceKey() || contract !== sourceStamp()) return null;
        const b = {token:randomUUID(),cwd,source,contract,guardPath,guardStamp,rootPath,rootIdentity,native:null,epoch:0,revoked:false,paused:false,calls:new Map(),waits:new Set()};
        b.initial = new Promise(resolve => {
          let done = false;
          b.finishInitial = value => { if (done) return; done = true; clearTimeout(b.initialTimer); resolve(value); };
        });
        b.channel = scheduler.channel(rootPath,{onState:state => onEvent({type:'tool_wait_state',toolCallId:b.calls.get(state.callId)?.toolCallId,waiting:state.waiting})});
        binding = b; bindings.add(b);
        b.initialTimer = setTimeout(() => revoke(b),initializationMs);
        if (!server) {
          server = http.createServer((req,res) => { void route(req,res); }); server.requestTimeout = 10000; server.headersTimeout = 10000;
          await new Promise((resolve,reject) => { const error = e => { server.off('listening',ready); reject(e); }; const ready = () => { server.off('error',error); resolve(); }; server.once('error',error); server.once('listening',ready); server.listen(0,'127.0.0.1'); });
        }
        if (!valid(b)) { revoke(b); return null; }
        b.installed = true;
        return {args:['--extension',guardPath],env:{PI_GUI_TOOL_URL:`http://127.0.0.1:${server.address().port}`,PI_GUI_TOOL_TOKEN:b.token,
          ...(audit?{PI_GUI_CANDIDATE_AUDIT:'1',PI_GUI_TOOL_REVERT_SOURCE:path.join(materializeDir('extensions/pi-gui-revert'),'index.js')}:{})}};
      })().finally(() => { preparing = null; });
      return preparing;
    },
    ready(cwd = getCwd(), sessionId = binding?.native) {
      try { const b = binding; return Boolean(b && valid(b) && b.native && b.native === sessionId && b.cwd === directory(cwd) && b.witness !== undefined && isCurrent(b.witness)); }
      catch { return false; }
    },
    status: () => ({installed:Boolean(binding?.installed && !disposed),verified:Boolean(binding?.native && !binding.revoked && !disposed)}),
    async assertReady() {
      const b = binding, expectedRevision = revision;
      if (!b || !valid(b)) fail('tool_guard_unavailable');
      if (!b.native) await bounded(b,() => b.initial,initializationMs);
      if (!valid(b) || !b.native) fail('tool_guard_unavailable');
      if (revision !== expectedRevision) fail('stale_runtime');
      const witness = capture(b.native), epoch = b.epoch, refreshing = revalidation(b,witness);
      await current(b,b.native,witness,epoch,refreshing);
      check(b,witness,epoch,refreshing);
      b.witness = witness;
      return () => revision === expectedRevision && b.epoch === epoch && valid(b) && isCurrent(witness);
    },
    resume() {
      const b = binding;
      if (!b || !valid(b) || !b.native || b.witness === undefined || !isCurrent(b.witness)) return false;
      b.paused = false; b.channel.resume(); return true;
    },
    pause() { revision++; const b = binding; if (!b) return; b.paused = true; b.epoch++; b.channel.pause(); cancelWaits(b); },
    observe(event) {
      const b = binding; if (!b) return;
      if (event.type === 'agent_settled') { b.channel.settle(); b.calls.clear(); }
      if (event.type === 'extension_error' && !unrelated(b,event)) revoke(b);
    },
    invalidate() { revoke(binding); },
    confirmCleanup() { for (const b of bindings) { revoke(b); b.channel.close(true); } bindings.clear(); },
    async dispose() {
      disposed = true;
      for (const b of bindings) { revoke(b); b.channel.close(false); }
      if (server) { server.closeIdleConnections?.(); await new Promise(resolve=>server.close(resolve)); server = null; }
    },
  };
}
