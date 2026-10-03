/* P25 native auth boundary. Only the proven Pi package's PUBLIC export is used.
 * Credentials stay inside a worker; no SDK error, stdout or token is forwarded. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { nativeQuotaWorkerSource } from './quota.js';

export function safeAuthUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
    if ([...u.searchParams.keys()].some(k => /^(access_token|refresh_token|api[_-]?key|authorization|password|client_secret|id_token)$/i.test(k))) return null;
    if (/(?:access_token|refresh_token|api[_-]?key|authorization|client_secret|id_token)=/i.test(u.hash)) return null;
    return u.href;
  } catch { return null; }
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) : fallback;
}

export function authDescriptor(meta = {}) {
  const id = text(meta.providerId);
  const methods = (Array.isArray(meta.methods) ? meta.methods : []).filter(m => ['oauth', 'api-key', 'environment'].includes(m?.type)).map(m => ({
    type: m.type, label: text(m.label, m.type), canLogin: m.type === 'oauth' && m.canLogin === true, isSubscription: m.isSubscription === true,
  }));
  const oauth = methods.some(m => m.type === 'oauth');
  const stored = ['oauth', 'api_key'].includes(meta.storedType);
  const check = ['oauth', 'api_key'].includes(meta.checkType);
  const unknown = meta.unknown === true;
  const source = unknown ? (['extension', 'models-json', 'environment'].includes(meta.source) ? meta.source : 'unknown') : stored ? 'pi'
    : ['models-json', 'environment', 'extension'].includes(meta.source) ? meta.source : check ? 'environment' : 'pi';
  const type = unknown ? 'unknown' : meta.storedType === 'oauth' || meta.checkType === 'oauth' ? 'oauth'
    : source === 'environment' && meta.checkType === 'api_key' ? 'environment'
    : stored || meta.checkType === 'api_key' ? 'api-key' : methods.length === 1 && oauth ? 'oauth'
    : source === 'models-json' ? 'custom' : methods.some(m => m.type === 'api-key') ? 'api-key' : 'unknown';
  // API-key metadata is configuration evidence, not account authentication.
  const authenticated = unknown ? null : meta.checkType === 'oauth' ? true : oauth && !stored && !check && methods.length === 1 ? false : null;
  return {
    providerId: id, displayName: text(meta.displayName, id), authType: type, source,
    authenticated, credentialStored: unknown ? null : stored,
    authConfigured: unknown ? null : stored || check,
    modelAvailable: typeof meta.modelAvailable === 'boolean' ? meta.modelAvailable : null,
    canLogin: !unknown && methods.some(m => m.canLogin), canLogout: !unknown && stored,
    canConfigureKey: false, accountLabel: null,
    status: unknown ? 'unknown' : authenticated === true ? 'connected' : authenticated === false ? 'disconnected' : 'unknown',
    statusReason: unknown ? '未知（无法确认）；当前 Pi 无法提供此供应商的 GUI 认证状态'
      : authenticated === true ? 'Pi 确认已保存 OAuth 登录；远端有效性与 token 刷新由 Pi 在请求时处理'
      : stored ? 'Pi 已保存 API Key 认证；远端有效性未确认'
      : check ? 'Pi 确认存在认证配置；远端有效性未确认' : 'Pi 未发现已保存的认证或可用的环境认证',
    methods, models: [],
  };
}

/* Re-project the worker result: only normalized quota data and four facts.
 * No native SDK result, env, source hint, headers or cache identity escapes. */
export function publicNativeQuota(result, providerId) {
  const tri = value => typeof value === 'boolean' ? value : null;
  const facts = { providerExists: tri(result?.providerExists), quotaSupported: tri(result?.quotaSupported), credentialAvailable: tri(result?.credentialAvailable), quotaQuerySucceeded: result?.quotaQuerySucceeded === true };
  if (result?.ok !== true) return { ok: false, error: '供应商不存在', quota: null, ...facts };
  const q = result.quota || {};
  const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
  const balance = b => b && typeof b === 'object' ? { amount: num(b.amount), currency: currency(b.currency), granted: num(b.granted), toppedUp: num(b.toppedUp) } : null;
  const status = ['ok', 'unsupported', 'auth_error', 'unavailable', 'error'].includes(q.status) ? q.status : 'error';
  const messages = {
    unsupported: facts.quotaSupported === true ? '当前认证类型不适用于此额度接口' : '该供应商当前没有已验证的远端额度接口',
    auth_error: facts.credentialAvailable === false ? '未认证：Pi 未发现可用的 API Key' : 'API Key 无效或未授权查询额度',
    unavailable: '额度服务暂时不可用', error: '额度查询失败',
  };
  const source = providerId === 'deepseek' ? 'https://api.deepseek.com/user/balance' : providerId === 'openrouter' ? 'https://openrouter.ai/api/v1/key' : 'none';
  return { ok: true, ...facts, cached: result.cached === true, quota: {
    providerId, status, ...(providerId === 'openrouter' ? { kind: 'key-quota' } : {}),
    balance: balance(q.balance), balances: Array.isArray(q.balances) ? q.balances.slice(0, 50).map(balance).filter(Boolean) : null,
    windows: q.windows && typeof q.windows === 'object' ? { used: num(q.windows.used), limit: num(q.windows.limit), remaining: num(q.windows.remaining), unit: currency(q.windows.unit) } : null,
    rateLimit: q.rateLimit && typeof q.rateLimit === 'object' ? { requests: num(q.rateLimit.requests), interval: typeof q.rateLimit.interval === 'string' && /^\d+\s*(seconds?|minutes?|hours?|days?)$/.test(q.rateLimit.interval) ? q.rateLimit.interval : null } : null,
    resetAt: typeof q.resetAt === 'string' && q.resetAt.length <= 40 && !Number.isNaN(Date.parse(q.resetAt)) ? q.resetAt : null,
    source, updatedAt: typeof q.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(q.updatedAt) ? q.updatedAt : new Date().toISOString(),
    message: status === 'ok' ? null : messages[status], ...facts,
  } };
}

/* No arbitrary module paths from HTTP. Resolve only the root public export. */
export function resolveAuthSdk(packageDir) {
  try {
    if (typeof packageDir !== 'string' || !packageDir) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    if (pkg.name !== '@earendil-works/pi-coding-agent') return null;
    const root = pkg.exports?.['.'];
    const relative = typeof root === 'string' ? root : root?.import || pkg.main;
    if (typeof relative !== 'string' || path.isAbsolute(relative)) return null;
    const entry = path.resolve(packageDir, relative);
    const rel = path.relative(packageDir, entry);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(entry).isFile()) return null;
    return { entry: pathToFileURL(entry).href, version: /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version) ? pkg.version : null };
  } catch { return null; }
}

// This is a fixed helper program, not user-supplied code. SDK return credentials
// are deliberately discarded BEFORE crossing the worker message boundary.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
` + nativeQuotaWorkerSource() + String.raw`
let sdk, runtime, initialization;
const operations = new Map(); const answers = new Map(); let promptSequence = 0;
const quotaCache = new Map(), quotaInFlight = new Map();
function emptyQuota(providerId,status,message,credentialAvailable=null,quotaSupported=false) {
  const facts={providerExists:true,quotaSupported,credentialAvailable,quotaQuerySucceeded:false};
  return {ok:true,...facts,cached:false,quota:{providerId,status,balance:null,balances:null,windows:null,rateLimit:null,resetAt:null,source:'none',updatedAt:new Date().toISOString(),message,...facts}};
}
async function quota(providerId, options, signal) {
  const snapshot=await sdk.ModelRuntime.create({allowModelNetwork:false,refreshOnCreate:false});
  const p=snapshot.getProviders().find(p=>p.id===providerId);
  if(!p)return {ok:false,error:'供应商不存在',quota:null,providerExists:false,quotaSupported:false,credentialAvailable:null,quotaQuerySucceeded:false};
  const adapter=nativeAdapters.resolve(providerId,{baseUrl:p.baseUrl});
  let check;
  try{check=await snapshot.checkAuth(providerId,{signal});}catch{return emptyQuota(providerId,adapter?'auth_error':'unsupported',adapter?'Pi 无法解析额度查询认证':'该供应商当前没有已验证的远端额度接口',null,Boolean(adapter));}
  const available=Boolean(check);
  if(!['deepseek','openrouter'].includes(adapter))return emptyQuota(providerId,'unsupported','该供应商当前没有已验证的远端额度接口',available,false);
  if(!check)return emptyQuota(providerId,'auth_error','未认证：Pi 未发现可用的 API Key',false,true);
  if(typeof snapshot.getAuth!=='function')return emptyQuota(providerId,'unsupported','当前 Pi 不支持私有额度凭据解析',available,false);
  // Storage type is not the request credential. Pi owns OAuth toAuth conversion.
  let key;
  try{const resolved=await snapshot.getAuth(providerId,{signal});key=resolved?.auth?.apiKey;}catch{return emptyQuota(providerId,'auth_error','Pi 无法解析额度查询认证',null,true);}
  if(typeof key!=='string'||!key)return emptyQuota(providerId,'unsupported','当前认证类型不适用于此额度接口',available,true);
  signal.throwIfAborted();
  const identity=createHash('sha256').update(providerId+'|'+adapter+'|'+key).digest('hex');
  const hit=quotaCache.get(identity);
  if(!options.force&&hit&&Date.now()-hit.time<options.ttlMs)return {...hit.result,cached:true};
  if(quotaInFlight.has(identity))return quotaInFlight.get(identity);
  const task=(async()=>{
    const result=await nativeAdapters[adapter]({apiKey:key,fetchFn:fetch,now:Date.now});
    signal.throwIfAborted();
    // Response-controlled strings can reflect secrets; scrub before crossing.
    const safe=nativeAdapters.scrub(result,key);
    const facts={providerExists:true,quotaSupported:true,credentialAvailable:true,quotaQuerySucceeded:safe.status==='ok'};
    const out={ok:true,...facts,cached:false,quota:{providerId,...safe,...facts}};
    quotaCache.set(identity,{providerId,time:Date.now(),result:out});return out;
  })().finally(()=>quotaInFlight.delete(identity));
  quotaInFlight.set(identity,task);return task;
}
async function initialize() {
  sdk = await import(workerData.entry);
  const M = sdk.ModelRuntime;
  const required = ['getProviders', 'listCredentials', 'checkAuth', 'login', 'logout'];
  if (!M || typeof M.create !== 'function' || required.some(k => typeof M.prototype[k] !== 'function')) throw Error('unsupported');
  runtime = await M.create({ allowModelNetwork:false, refreshOnCreate:false });
}
function ready() { return initialization || (initialization = initialize()); }
function methods(p) {
  const out=[];
  if (p.auth?.oauth) out.push({type:'oauth',label:p.auth.oauth.name,canLogin:typeof p.auth.oauth.login==='function',isSubscription:p.auth.oauth.isSubscription===true});
  if (p.auth?.apiKey) out.push({type:typeof p.auth.apiKey.login==='function'?'api-key':'environment',label:p.auth.apiKey.name,canLogin:false,isSubscription:false});
  return out;
}
async function list(signal) {
  // Refresh composition without catalog network calls. Pi performs its own
  // auth checks and key resolution; those values never leave this worker.
  // Stored key enumeration skips resolution in the descriptor pass.
  const snapshot = await sdk.ModelRuntime.create({ allowModelNetwork:false, refreshOnCreate:false });
  const credentials = await snapshot.listCredentials({signal});
  const stored = new Map(credentials.map(c=>[c.providerId,c.type]));
  const providers=[];
  for (const p of snapshot.getProviders()) {
    signal.throwIfAborted();
    let check, unknown=false;
    try { if (stored.get(p.id) !== 'api_key') check = await snapshot.checkAuth(p.id,{signal}); }
    catch { unknown=true; }
    let source='pi';
    const configured = snapshot.getProviderAuthStatus?.(p.id);
    if (configured?.source==='environment') source='environment';
    if (['models_json_key','models_json_command'].includes(configured?.source)) source='models-json';
    providers.push({providerId:p.id,displayName:p.name,methods:methods(p),storedType:stored.get(p.id)||null,checkType:check?.type||null,source,unknown});
  }
  return providers;
}
parentPort.on('message', async m => {
  if (m.type==='answer') {
    const pending=answers.get(m.promptId);
    if (pending && pending.requestId===m.id) { answers.delete(m.promptId); pending.resolve(m.value); }
    return;
  }
  if (m.type==='abort') { operations.get(m.id)?.abort(); return; }
  const controller=new AbortController(); operations.set(m.id,controller);
  const signal=controller.signal;
  try {
    await ready(); signal.throwIfAborted();
    if (m.type==='quota') {
      parentPort.postMessage({id:m.id,type:'result',ok:true,result:await quota(m.providerId,m.options,signal)});
    } else if(m.type==='clear-quota') {
      for(const [key,entry] of quotaCache)if(!m.providerId||entry.providerId===m.providerId)quotaCache.delete(key);
      parentPort.postMessage({id:m.id,type:'result',ok:true});
    } else if (m.type==='list') {
      parentPort.postMessage({id:m.id,type:'result',ok:true,providers:await list(signal)});
    } else if (m.type==='login') {
      await runtime.login(m.providerId,'oauth',{
        signal,
        notify(event) {
          if (signal.aborted) return;
          // No raw info/progress message or instructions: provider error/progress
          // strings may contain response bodies or credentials.
          const data = event.type==='auth_url' ? {type:'auth_url',url:event.url}
            : event.type==='device_code' ? {type:'device_code',verificationUri:event.verificationUri,userCode:event.userCode}
            : {type:'progress'};
          parentPort.postMessage({id:m.id,type:'event',data});
        },
        prompt(prompt) {
          if (!['text','manual_code','select'].includes(prompt.type)) throw Error('secret-input-not-supported');
          const promptId='sdk-prompt-'+(++promptSequence);
          const data={type:prompt.type,id:promptId,options:prompt.type==='select'?prompt.options.map(o=>({id:o.id,label:o.label})):[]};
          return new Promise((resolve,reject)=>{
            let done=false;
            const signals=[signal,prompt.signal].filter(Boolean);
            const finish=(fn,value)=>{if(done)return;done=true;answers.delete(promptId);for(const s of signals)s.removeEventListener('abort',abort);fn(value);};
            const abort=()=>{parentPort.postMessage({id:m.id,type:'prompt-aborted',promptId});finish(reject,Error('cancelled'));};
            answers.set(promptId,{requestId:m.id,resolve:v=>finish(resolve,v)});
            for (const s of signals) s.addEventListener('abort',abort,{once:true});
            if (signals.some(s=>s.aborted)) abort(); else parentPort.postMessage({id:m.id,type:'prompt',data});
          });
        }
      }, typeof sdk.SettingsManager?.create==='function' && typeof sdk.getAgentDir==='function' ? {getDeviceId:()=>sdk.SettingsManager.create(sdk.getAgentDir(),sdk.getAgentDir()).getOrCreateDeviceId()} : undefined);
      parentPort.postMessage({id:m.id,type:'result',ok:true});
    } else if (m.type==='logout') {
      await runtime.logout(m.providerId,{signal}); parentPort.postMessage({id:m.id,type:'result',ok:true});
    }
  } catch (error) {
    const code=signal.aborted?'cancelled':error?.message==='secret-input-not-supported'?'secret-input-not-supported':!runtime?'unsupported':'native-auth-failed';
    parentPort.postMessage({id:m.id,type:'result',ok:false,code});
  } finally { operations.delete(m.id); }
});
`;

export function createAuthSdk({ resolvePackageDir, identityKey = () => '', env = process.env, workerFactory = null, quotaTimeoutMs = 15_000 } = {}) {
  let worker = null, workerKey = null, sequence = 0, capability = { sdkAvailable: false, reason: '当前 Pi 不支持 GUI 登录；请在 Pi 交互终端使用 /login、/logout', piVersion: null };
  const pending = new Map();
  function dispose() {
    const old = worker; worker = null; workerKey = null;
    for (const p of pending.values()) { p.finish({ ok: false, code: 'cancelled' }); }
    if (old) void old.terminate();
  }
  function ensure() {
    const key = identityKey();
    if (worker && workerKey === key) return true;
    dispose();
    const entry = resolveAuthSdk(resolvePackageDir?.());
    capability = { sdkAvailable: false, reason: '当前 Pi 不支持 GUI 登录；请在 Pi 交互终端使用 /login、/logout', piVersion: entry?.version || null };
    if (!entry) return false;
    // Workers do not get Electron's HTTP token. SDK diagnostics are private,
    // drained immediately and never copied to the backend log or SSE backlog.
    const childEnv = { ...env }; delete childEnv.PI_GUI_TOKEN;
    worker = workerFactory ? workerFactory(WORKER_SOURCE, entry, childEnv) : new Worker(WORKER_SOURCE, { eval: true, workerData: entry, env: childEnv, stdout: true, stderr: true });
    workerKey = key;
    worker.stdout?.resume(); worker.stderr?.resume();
    const instance = worker;
    worker.on('message', msg => {
      if (worker !== instance) return;
      const p = pending.get(msg?.id); if (!p) return;
      if (msg.type === 'result') p.finish(msg);
      else if (msg.type === 'event') p.notify?.(msg.data);
      else if (msg.type === 'prompt') {
        Promise.resolve().then(() => p.prompt(msg.data)).then(value => {
          if (pending.has(msg.id) && worker === instance) worker.postMessage({ type: 'answer', id: msg.id, promptId: msg.data.id, value });
        }, () => { if (worker === instance && !p.abortedPrompts.has(msg.data.id)) worker.postMessage({ type: 'abort', id: msg.id }); });
      } else if (msg.type === 'prompt-aborted') { p.abortedPrompts.add(msg.promptId); p.abortPrompt?.(msg.promptId); }
    });
    worker.on('error', () => { if (worker === instance) dispose(); });
    worker.on('exit', () => { if (worker === instance) dispose(); });
    return true;
  }
  function call(type, args = {}, callbacks = {}) {
    if (!ensure()) return Promise.resolve({ ok: false, code: 'unsupported' });
    const id = 'auth-sdk-' + (++sequence);
    return new Promise(resolve => {
      let timer; const signal = callbacks.signal;
      const abort = () => {
        worker?.postMessage({ type: 'abort', id });
        clearTimeout(timer);
        if(type==='quota'){finish({ok:false,code:'unavailable'});return;}
        timer = setTimeout(() => dispose(), 2000); timer.unref?.();
      };
      const finish = result => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); resolve(result); };
      pending.set(id, { finish, abortedPrompts: new Set(), ...callbacks });
      if (type === 'list' || type === 'quota') { timer = setTimeout(() => { worker?.postMessage({ type: 'abort', id }); finish({ ok: false, code: 'unavailable' }); }, type === 'quota' ? quotaTimeoutMs : 15_000); timer.unref?.(); }
      worker.postMessage({ id, type, ...args });
      if (signal) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
    });
  }
  return {
    identityKey,
    async quota(providerId, { force = false, ttlMs = 60_000, signal } = {}) {
      const result = await call('quota', { providerId, options: { force: force === true, ttlMs: Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : 60_000 } }, { signal });
      if (result.ok && result.result) return publicNativeQuota(result.result, providerId);
      // SDK capability failure does not establish nonexistence.
      const facts = { providerExists: null, quotaSupported: null, credentialAvailable: null, quotaQuerySucceeded: false };
      return { ok: true, ...facts, cached: false, quota: { providerId, status: 'unavailable', balance: null, balances: null, windows: null, rateLimit: null, resetAt: null, source: 'none', updatedAt: new Date().toISOString(), message: '无法读取 Pi 原生额度能力（未知）', ...facts } };
    },
    clearQuotaCache(providerId = null) { void call('clear-quota', { providerId }); },
    async list() {
      const result = await call('list');
      capability = { ...capability, sdkAvailable: result.ok === true, reason: result.ok ? null : result.code === 'unsupported' ? '当前 Pi 不支持 GUI 登录；请在 Pi 交互终端使用 /login、/logout' : '无法读取 Pi 认证状态（未知）' };
      return { capability, providers: result.ok ? (result.providers || []).map(authDescriptor) : [] };
    },
    async login(providerId, type, callbacks) {
      const result = await call('login', { providerId }, callbacks);
      if (!result.ok) { const error = new Error('Pi 原生认证未完成'); error.code = result.code; throw error; }
    },
    async logout(providerId, { signal } = {}) {
      const result = await call('logout', { providerId }, { signal });
      if (!result.ok) { const error = new Error('Pi 原生退出未完成'); error.code = result.code; throw error; }
    },
    dispose,
  };
}

export function publicModel(model) {
  if (!model || typeof model !== 'object') return null;
  const out = {};
  for (const key of ['id', 'provider', 'name', 'api', 'reasoning', 'contextWindow', 'maxTokens', 'input', 'cost', 'thinkingLevelMap']) {
    const value = model[key];
    if (['id', 'provider', 'name', 'api'].includes(key)) { if (typeof value === 'string') out[key] = value.slice(0, 300); }
    else if (key === 'input') { if (Array.isArray(value)) out.input = value.filter(v => v === 'text' || v === 'image'); }
    else if (key === 'cost') {
      if (value && typeof value === 'object') out.cost = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].filter(k => Number.isFinite(value[k])).map(k => [k, value[k]]));
    } else if (key === 'thinkingLevelMap') {
      if (value && typeof value === 'object') out[key] = Object.fromEntries(Object.entries(value).filter(([k, v]) => ['off','minimal','low','medium','high','xhigh','max'].includes(k) && (v === null || typeof v === 'string' || Number.isFinite(v))));
    } else if (typeof value === 'boolean' || Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export function sanitizeModelEvent(event) {
  if (event?.type === 'bridge_parse_error') return { type: 'bridge_parse_error', reason: 'Pi 返回了非 JSONL 输出；原文未转发' };
  if (event?.type === 'bridge_stderr') return { type: 'bridge_stderr', text: 'Pi 输出诊断消息；原文未转发以保护凭据。' };
  if (event?.type === 'response' && !event.success && ['get_state','get_available_models','set_model','cycle_model'].includes(event.command)) return { ...event, data: undefined, error: 'Pi 未能完成模型操作；请检查认证与模型配置。' };
  if (event?.type !== 'response' || !event.success) return event;
  if (event.command === 'get_available_models') return { ...event, data: { models: (event.data?.models || []).map(publicModel).filter(Boolean) } };
  if (event.command === 'get_state') {
    const data = { model: publicModel(event.data?.model) };
    for (const key of ['thinkingLevel','isStreaming','isCompacting','steeringMode','followUpMode','sessionFile','sessionId','sessionName','autoCompactionEnabled','messageCount','pendingMessageCount']) {
      const value = event.data?.[key];
      if (['string','boolean','number'].includes(typeof value)) data[key] = value;
    }
    return { ...event, data };
  }
  if (event.command === 'set_model') return { ...event, data: publicModel(event.data) };
  if (event.command === 'cycle_model') return { ...event, data: event.data ? { model: publicModel(event.data.model), thinkingLevel: typeof event.data.thinkingLevel === 'string' ? event.data.thinkingLevel : undefined } : null };
  return event;
}
