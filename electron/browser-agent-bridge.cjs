'use strict';
// Dedicated loopback capability. The lifecycle credential never enters Pi.
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const ACTIONS = new Set(['open','snapshot','click','fill','press','reload','back','forward','screenshot','console','network','status']);
const CODES = new Set(['desktop_required','agent_control_disabled','browser_closed','remote_origin_not_allowed','cdp_unavailable','cdp_attach_failed','navigation_failed','timeout','stale_browser_generation','stale_element_ref','element_not_found','element_not_interactable','unsupported_element','invalid_key','cancelled','invalid_request','internal']);
function equal(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); }
function createBrowserAgentBridge({ agent, onAvailability = () => {}, timeoutMs = 15000, bodyTimeoutMs = 5000, maxPayloadBytes = 65536 }) {
  const master = randomBytes(32).toString('hex');
  let session = '', epoch = 0, server = null, url = '', chain = Promise.resolve();
  const pending = new Map(); const seen = new Set(); const cancelledIds = new Set();
  function invalidate(disable = false) {
    epoch++;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    agent.invalidate?.();
    if (disable) return agent.setEnabled(false);
  }
  function reply(res, status, value) { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }); res.end(JSON.stringify(value)); } }
  function error(res, status, code) { reply(res, status, { ok:false, code, message:code }); }
  async function handle(req, res) {
    if (req.headers.origin || req.method !== 'POST') return error(res, 403, 'unauthorized');
    const lifecycle = req.url === '/session' || req.url === '/invalidate';
    const authorizedSession = session;
    if (!equal(req.headers['x-pi-browser-token'], lifecycle ? master : session) || (!lifecycle && !session)) return error(res, 403, 'unauthorized');
    let body;
    const bodyTimer=setTimeout(() => { error(res,408,'timeout'); req.destroy(); },bodyTimeoutMs);
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > maxPayloadBytes) { error(res, 413, 'payload_too_large'); req.resume(); return; } chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || Array.isArray(body) || typeof body !== 'object') throw Error();
    } catch { return error(res, 400, 'invalid_request'); }
    finally { clearTimeout(bodyTimer); }
    if (typeof body.requestId !== 'string' || !/^[\w.-]{1,128}$/.test(body.requestId)) return error(res,400,'invalid_request');
    if (!lifecycle && (authorizedSession !== session || !session)) return error(res,403,'unauthorized');
    if (lifecycle) {
      const disabling = invalidate(body.disable === true || req.url === '/session');
      if (req.url === '/session') { session = randomBytes(32).toString('hex'); seen.clear(); cancelledIds.clear(); }
      if (body.revoke === true) session = '';
      await disabling;
      onAvailability(Boolean(session));
      return reply(res, 200, { ok:true, token: req.url === '/session' ? session : undefined, epoch });
    }
    if (req.url === '/state') return reply(res, 200, { ok:true, epoch, generation:agent.status().generation });
    if (req.url === '/cancel') { if (cancelledIds.size >= 10000) { invalidate(); cancelledIds.clear(); } cancelledIds.add(body.requestId); pending.get(body.requestId)?.abort(); return reply(res, 200, {ok:true}); }
    if (req.url !== '/action' || !ACTIONS.has(body.action)) return error(res, 400, 'unknown_action');
    if (typeof body.requestId !== 'string' || !/^[\w.-]{1,128}$/.test(body.requestId) || !body.args || Array.isArray(body.args) || typeof body.args !== 'object') return error(res, 400, 'invalid_request');
    if (body.epoch !== epoch) return error(res, 409, 'cancelled');
    if (cancelledIds.has(body.requestId)) return error(res,409,'cancelled');
    const allowed = body.action === 'open' ? ['url'] : body.action === 'click' ? ['ref'] : body.action === 'fill' ? ['ref','text'] : body.action === 'press' ? ['key'] : ['console','network'].includes(body.action) ? ['limit'] : [];
    if (Object.keys(body.args).some(key => !allowed.includes(key))) return error(res,400,'invalid_request');
    if (seen.has(body.requestId) || pending.size >= 64 || seen.size >= 10000) return error(res, 409, 'busy');
    seen.add(body.requestId);
    const controller = new AbortController(); const captured = epoch; const token = session;
    const generation = agent.status().generation;
    pending.set(body.requestId, controller);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    let timer, timedOut = false;
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(Object.assign(Error(), {code:timedOut?'timeout':'cancelled'})), {once:true});
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    });
    const task = chain.catch(() => {}).then(async () => {
      if (controller.signal.aborted || captured !== epoch || token !== session) throw Object.assign(Error(), {code:'cancelled'});
      if (body.generation !== generation || generation !== agent.status().generation) throw Object.assign(Error(), {code:'stale_browser_generation'});
      const result = await agent.execute({requestId:body.requestId, action:body.action, args:body.args}, {signal:controller.signal});
      if (controller.signal.aborted || captured !== epoch || token !== session) throw Object.assign(Error(), {code:'cancelled'});
      return result;
    });
    // Retain serial ownership until the controller actually settles, even after transport cancellation.
    chain = task.catch(() => {});
    try { const result = await Promise.race([task, cancelled]); if (Buffer.byteLength(JSON.stringify(result)) > 12 * 1024 * 1024) error(res,200,'payload_too_large'); else reply(res, 200, result); }
    catch (err) { error(res, 200, CODES.has(err.code) ? err.code : 'internal'); }
    finally { clearTimeout(timer); if (pending.get(body.requestId) === controller) pending.delete(body.requestId); }
  }
  return {
    async start() { if (server) return; server = http.createServer((req,res) => { handle(req,res).catch(() => error(res,500,'internal')); }); server.requestTimeout = 20000; server.headersTimeout = 10000; await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); }); url = `http://127.0.0.1:${server.address().port}`; },
    connection() { return {url,token:master}; },
    isSessionActive() { return Boolean(session); },
    invalidate,
    async stop() { await invalidate(true); session = ''; onAvailability(false); const old = server; server = null; url = ''; if (old) { old.closeAllConnections(); await new Promise(resolve => old.close(resolve)); } },
  };
}
module.exports = { createBrowserAgentBridge };
