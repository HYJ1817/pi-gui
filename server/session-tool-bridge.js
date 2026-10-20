import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { materializeDir } from '../lib/assets.js';
import { json, readRawBody } from './http-utils.js';

const fail = code => { throw Object.assign(Error(code), { code }); };
const closed = (v, keys) => v && !Array.isArray(v) && typeof v === 'object' && Object.keys(v).every(k => keys.includes(k));
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 256;
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const canonical = p => { const v = fs.realpathSync.native(p); return process.platform === 'win32' ? v.toLowerCase() : v; };

// One private capability per launched child. Renderer never chooses a root or
// supplies a lock owner. A failed/unknown cleanup retains active write leases.
export function createSessionToolBridge({ scheduler, launch, getCwd, getRoot = getCwd, readState, supported, onEvent = () => {} } = {}) {
  let server = null, token = null, channel = null, root = null, native = null, disposed = false;
  const channels = new Set(), calls = new Map();
  async function capable() {
    if (supported !== undefined) return supported;
    try {
      const dir = launch.packageDir(), pkg = JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
      const types = fs.readFileSync(path.join(dir,'dist/core/extensions/types.d.ts'),'utf8');
      return ['1.2.0','1.3.0'].includes(pkg.version) && types.includes('"tool_call"') && types.includes('"tool_execution_end"');
    } catch { return false; }
  }
  async function current(expected) {
    const state = await readState();
    if (!text(expected) || state?.sessionId !== expected || state.__error) fail('stale_runtime');
  }
  async function route(req,res) {
    if (req.method !== 'POST' || req.headers.origin || !token || !same(req.headers['x-pi-gui-tool-token'],token)) return json(res,403,{ok:false,code:'unauthorized'});
    const admitted = token, target = channel;
    try {
      const body = JSON.parse((await readRawBody(req,4096)).toString('utf8'));
      if (!channel || disposed || admitted !== token) fail('tool_guard_unavailable');
      if (req.url === '/hello') {
        if (!closed(body,['sessionId'])) fail('invalid_request');
        await current(body.sessionId);
        if (admitted !== token) fail('stale_runtime');
        native = body.sessionId; return json(res,200,{ok:true});
      }
      if (body.sessionId !== native || !text(native)) fail('stale_runtime');
      if (req.url === '/begin') {
        if (!closed(body,['sessionId','callId','toolCallId','readOnly']) || !text(body.callId) || !text(body.toolCallId) || typeof body.readOnly !== 'boolean') fail('invalid_request');
        await current(native);
        if (admitted !== token) fail('stale_runtime');
        calls.set(body.callId,body.toolCallId);
        const disconnected = () => target.cancel(body.callId);
        res.once('close',disconnected);
        try { await target.acquire(body.callId,{readOnly:body.readOnly}); }
        catch (e) { calls.delete(body.callId); throw e; }
        finally { res.off('close',disconnected); }
        if (admitted !== token) fail('stale_runtime');
      } else if (req.url === '/end') {
        if (!closed(body,['sessionId','callId']) || !text(body.callId)) fail('invalid_request');
        target.release(body.callId); calls.delete(body.callId);
      } else fail('invalid_request');
      return json(res,200,{ok:true});
    } catch(e) { return json(res,409,{ok:false,code:['stale_runtime','invalid_request','tool_wait_cancelled','stale_workspace','workspace_revert_busy'].includes(e.code)?e.code:'tool_guard_unavailable'}); }
  }
  return {
    available: () => true,
    async prepare() {
      native = null; token = null; channel?.close(false); calls.clear();
      if (disposed || !await capable()) return null;
      root = canonical(getCwd());
      channel = scheduler.channel(await getRoot(),{onState: state => onEvent({type:'tool_wait_state',toolCallId:calls.get(state.callId),waiting:state.waiting})});
      channels.add(channel);
      if (!server) {
        server = http.createServer((req,res) => { void route(req,res); }); server.requestTimeout = 10000; server.headersTimeout = 10000;
        await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      }
      token = randomUUID();
      return {args:['--extension',path.join(materializeDir('extensions/pi-gui-tool-guard'),'index.js')],env:{PI_GUI_TOOL_URL:`http://127.0.0.1:${server.address().port}`,PI_GUI_TOOL_TOKEN:token}};
    },
    ready(cwd = getCwd(), sessionId = native) { try { return Boolean(token && native && sessionId === native && root === canonical(cwd)); } catch { return false; } },
    status: () => ({installed:Boolean(token),verified:Boolean(native)}),
    async assertReady() {
      for (let i=0;i<100 && token && !native;i++) await new Promise(resolve=>setTimeout(resolve,20));
      if (!token || !native) fail('tool_guard_unavailable');
      await current(native);
    },
    resume() { channel?.resume(); },
    pause() { channel?.pause(); },
    observe(event) {
      if (event.type === 'agent_settled') { channel?.settle(); calls.clear(); }
      if (event.type === 'extension_error') { native = null; channel?.pause(); }
    },
    invalidate() { native = null; channel?.pause(); },
    confirmCleanup() { for (const c of channels) c.close(true); channels.clear(); },
    async dispose() {
      disposed = true; token = null; native = null;
      for (const c of channels) c.close(false);
      if (server) { server.closeIdleConnections?.(); await new Promise(resolve=>server.close(resolve)); server = null; }
    },
  };
}
