/* P25.2 native quota: public SDK and HTTP fixtures only, real private Worker. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const SECRET = 'native-quota-private-key-fixture';
let pass = 0;
function check(name, fn) { fn(); pass++; console.log('  ok ' + name); }
(async () => {
  const { createQuotaManager } = await import('../server/quota.js');
  const { createAuthSdk, publicNativeQuota } = await import('../server/provider-auth-sdk.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-quota-'));
  const wires = [], streams = [], parentLogs = [];
  let adapter;
  const originalStdout = process.stdout.write, originalStderr = process.stderr.write;
  process.stdout.write = function(chunk, ...args) { parentLogs.push(String(chunk)); return originalStdout.call(this, chunk, ...args); };
  process.stderr.write = function(chunk, ...args) { parentLogs.push(String(chunk)); return originalStderr.call(this, chunk, ...args); };
  const unsupported = ['openai','anthropic','google','moonshotai','moonshotai-cn','minimax','minimax-cn','mistral','groq','xai','siliconflow'];
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }));
    fs.writeFileSync(path.join(dir, 'index.js'), `
import fs from 'node:fs';
const secret=${JSON.stringify(SECRET)};
const stateFile=${JSON.stringify(path.join(dir, 'state.json'))};
function state(){return JSON.parse(fs.readFileSync(stateFile,'utf8'));}
globalThis.fetch=async(url,options)=>{
 const s=state(); if(options.headers.Authorization!=='Bearer '+(s.key||secret))throw Error(secret);
 if(!['https://api.deepseek.com/user/balance','https://openrouter.ai/api/v1/key'].includes(url))throw Error('wrong endpoint');
 fs.appendFileSync(${JSON.stringify(path.join(dir, 'requests'))},url+'\\n');
 console.log(secret); console.error(secret);
 if(s.delay)await new Promise(r=>setTimeout(r,s.delay));
 if(s.error){const e=Error(secret);e.name=s.error;throw e;}
 return {ok:(s.status||200)===200,status:s.status||200,json:async()=>{if(s.invalidJson)throw Error(secret);return s.payload;}};
};
export class ModelRuntime{
 static async create(options){if(options.allowModelNetwork!==false||options.refreshOnCreate!==false)throw Error('network enabled');if(process.env.PI_GUI_TOKEN)throw Error(secret);return new ModelRuntime();}
 getProviders(){return [{id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com',auth:{apiKey:{name:'Key'}}},{id:'openrouter',name:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',auth:{apiKey:{name:'Key'}}},...${JSON.stringify(unsupported)}.map(id=>({id,name:id,auth:{apiKey:{name:'Key'}}}))];}
 async listCredentials(){return [];}
 async checkAuth(id,{signal}={}){const s=state();if(s.checkHang)await new Promise((r,j)=>{signal.addEventListener('abort',()=>j(Error(secret)),{once:true});});if(s.checkError)throw Error(secret);return s.missing?undefined:{type:s.other?'other':s.oauth?'oauth':'api_key'};}
 async getAuth(){const s=state();if(s.authError)throw Error(secret);return {auth:{apiKey:s.key||secret},env:{SECRET:secret},source:secret};}
 async login(id,type,{notify}){notify({type:'progress'});await new Promise(r=>setTimeout(r,150));} async logout(){}
}
`);
    function state(s = {}) { fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ payload: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0' }, { currency: 'USD', total_balance: '2' }] }, ...s })); }
    state();
    adapter = createAuthSdk({ resolvePackageDir: () => dir, identityKey: () => 'fixture', env: { ...process.env, PI_GUI_TOKEN: SECRET }, workerFactory(source, entry, env) {
      const instrumented = source.replace('quotaCache.set(identity,{providerId,time:Date.now(),result:out});', `parentPort.postMessage({type:'fixture-cache',hashed:/^[a-f0-9]{64}$/.test(identity),containsSecret:JSON.stringify({identity,result:out}).includes(${JSON.stringify(SECRET)})});quotaCache.set(identity,{providerId,time:Date.now(),result:out});`);
      const worker = new Worker(instrumented, { eval: true, workerData: entry, env, stdout: true, stderr: true });
      worker.on('message', m => wires.push(m)); worker.stdout.on('data', b => streams.push(String(b))); worker.stderr.on('data', b => streams.push(String(b))); return worker;
    } });
    const manager = createQuotaManager({ readModelsConfig: () => ({ providers: {} }), nativeAdapter: adapter });
    const native = await manager.getQuota('deepseek');
    check('native DeepSeek exists without models.json and queries in worker', () => { assert.equal(native.ok, true); assert.equal(native.quota.status, 'ok'); assert.equal(native.providerExists, true); assert.equal(native.quotaSupported, true); assert.equal(native.credentialAvailable, true); assert.equal(native.quotaQuerySucceeded, true); });
    check('native real zero and currencies stay separate', () => { assert.equal(native.quota.balance.amount, 0); assert.equal(native.quota.balances.length, 2); });
    const cached = await manager.getQuota('deepseek'); check('private native cache hit', () => assert.equal(cached.cached, true));
    state({ key: SECRET + '-rotated', payload: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '9' }] } });
    const rotated = await manager.getQuota('deepseek'); check('native resolved credential identity invalidates cache', () => { assert.equal(rotated.cached, false); assert.equal(rotated.quota.balance.amount, 9); });
    state({ key: SECRET + '-parallel', delay: 25 });
    const beforeCount = fs.readFileSync(path.join(dir, 'requests'), 'utf8').trim().split('\n').length;
    await Promise.all([manager.getQuota('deepseek', { force: true }), manager.getQuota('deepseek', { force: true })]);
    const afterCount = fs.readFileSync(path.join(dir, 'requests'), 'utf8').trim().split('\n').length;
    check('native same credential concurrent requests share private fetch', () => assert.equal(afterCount - beforeCount, 1));
    for (const id of unsupported) { const result = await manager.getQuota(id); check(id + ' exists but has no verified adapter', () => { assert.equal(result.ok, true); assert.equal(result.quota.status, 'unsupported'); assert.equal(result.providerExists, true); assert.equal(result.quotaSupported, false); assert.equal(result.quotaQuerySucceeded, false); }); }
    const unknown = await manager.getQuota('not-a-provider'); check('unknown provider is not found', () => { assert.equal(unknown.ok, false); assert.equal(unknown.providerExists, false); });
    check('unsupported and unknown states do not query HTTP', () => assert.equal(fs.readFileSync(path.join(dir, 'requests'), 'utf8').trim().split('\n').length, afterCount));
    for (const [name, s, expected] of [
      ['401', { status: 401 }, 'auth_error'], ['403', { status: 403 }, 'auth_error'],
      ['500', { status: 500 }, 'unavailable'], ['timeout', { error: 'AbortError' }, 'unavailable'],
      ['network', { error: 'TypeError' }, 'unavailable'], ['invalid JSON', { invalidJson: true }, 'error'],
      ['malformed object', { payload: {} }, 'error'], ['missing credential', { missing: true }, 'auth_error'],
      ['OAuth unsuitable', { oauth: true }, 'unsupported'], ['auth failure', { authError: true }, 'auth_error'],
      ['unknown auth type unsuitable', { other: true }, 'unsupported'],
    ]) { state(s); const result = await manager.getQuota('deepseek', { force: true }); check(name + ' native state is safe', () => { assert.equal(result.quota.status, expected); assert.equal(result.quotaQuerySucceeded, false); assert.ok(!JSON.stringify(result).includes(SECRET)); }); }
    state({ payload: { data: { limit: null, limit_remaining: null, usage: 0 } } });
    const router = await manager.getQuota('openrouter', { force: true }); check('OpenRouter key usage with no limit is not account balance', () => { assert.equal(router.quota.status, 'ok'); assert.equal(router.quota.balance, null); assert.equal(router.quota.windows.limit, null); assert.equal(router.quota.windows.used, 0); assert.equal(router.quota.kind, 'key-quota'); });
    state({ payload: { is_available: true, balance_infos: [{ currency: SECRET, total_balance: '1' }] } });
    const reflected = await manager.getQuota('deepseek', { force: true }); check('provider response cannot reflect native key across boundary', () => assert.ok(!JSON.stringify(reflected).includes(SECRET)));
    state({ key: SECRET + '"\\quoted', payload: { is_available: true, balance_infos: [{ currency: SECRET + '"\\quoted', total_balance: '1' }] } });
    const quoted = await manager.getQuota('deepseek', { force: true }); check('quoted credential is scrubbed before worker serialization', () => assert.ok(!JSON.stringify(quoted).includes(SECRET)));
    let requests = 0;
    const custom = createQuotaManager({ readModelsConfig: () => ({ providers: { custom: { apiKey: '$P25_QUOTA_FIXTURE', baseUrl: 'https://custom.test', quotaAdapter: 'newapi' }, moonshot: {} } }), nativeAdapter: adapter, fetchFn: async url => { requests++; return { ok: true, status: 200, json: async () => url.endsWith('subscription') ? { hard_limit_usd: 10 } : { total_usage: 0 } }; } });
    process.env.P25_QUOTA_FIXTURE = SECRET;
    const cq = await custom.getQuota('custom'); check('custom explicit NewAPI and env key remain supported', () => { assert.equal(cq.quota.status, 'ok'); assert.equal(requests, 2); assert.equal(cq.quota.balance.currency, null); });
    const cm = await custom.getQuota('moonshot'); check('custom legacy moonshot ID is preserved', () => { assert.equal(cm.ok, true); assert.equal(cm.quota.status, 'unsupported'); });
    check('main projects normalized fields and drops worker extras', () => {
      const projected = publicNativeQuota({ ok: true, providerExists: true, quotaSupported: true, credentialAvailable: true, quotaQuerySucceeded: false, secret: SECRET, quota: { status: 'error', message: SECRET, source: SECRET, headers: { Authorization: SECRET }, windows: { used: Infinity, unit: SECRET }, balance: { amount: 0, currency: SECRET }, rateLimit: { requests: 1, interval: SECRET } } }, 'deepseek');
      assert.ok(!JSON.stringify(projected).includes(SECRET)); assert.equal(projected.quota.balance.amount, 0); assert.equal(projected.quota.windows.used, null); assert.equal(projected.quota.balance.currency, null);
    });
    const unavailable = createAuthSdk({ resolvePackageDir: () => null });
    try { const q = await unavailable.quota('deepseek'); check('missing public SDK is unknown capability, not not-found', () => { assert.equal(q.quota.status, 'unavailable'); assert.equal(q.providerExists, null); assert.equal(q.quotaSupported, null); }); } finally { unavailable.dispose(); }
    // Same esbuild CJS bundling as the packaged backend; worker has no source
    // imports and must survive bundler-renamed adapter/helper bindings.
    require('esbuild').buildSync({ entryPoints: [path.resolve(__dirname, '../server/provider-auth-sdk.js')], outfile: path.join(dir, 'bundled-sdk.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const bundled = require(path.join(dir, 'bundled-sdk.cjs')).createAuthSdk({ resolvePackageDir: () => dir, identityKey: () => 'bundled' });
    try { state(); const q = await bundled.quota('deepseek'); check('packaged CJS adapters run inside actual native Worker', () => { assert.equal(q.quota.status, 'ok'); assert.equal(q.quota.balance.amount, 0); }); } finally { bundled.dispose(); }
    const bounded = createAuthSdk({ resolvePackageDir: () => dir, identityKey: () => 'bounded', quotaTimeoutMs: 50 });
    try {
      state(); await bounded.list();
      let started; const ready = new Promise(r => { started = r; });
      const login = bounded.login('openai', 'oauth', { notify: started }); await ready;
      state({ checkHang: true });
      const timed = await bounded.quota('deepseek');
      check('real private quota timeout settles unavailable safely', () => { assert.equal(timed.quota.status, 'unavailable'); assert.ok(!JSON.stringify(timed).includes(SECRET)); });
      await login;
      state(); const still = await bounded.list();
      check('quota timeout does not terminate concurrent native OAuth worker', () => assert.equal(still.capability.sdkAvailable, true));
      const controller = new AbortController(); state({ checkHang: true });
      const waiting = bounded.quota('deepseek', { signal: controller.signal }); controller.abort();
      const cancelled = await waiting; check('quota cancellation settles without disposing native auth', () => assert.equal(cancelled.quota.status, 'unavailable'));
      state(); const afterCancel = await bounded.list(); check('same SDK remains usable after quota cancellation', () => assert.equal(afterCancel.capability.sdkAvailable, true));
    } finally { bounded.dispose(); }
    await new Promise(r => setTimeout(r, 30));
    check('real worker messages never contain credential or SDK env', () => assert.ok(!JSON.stringify(wires).includes(SECRET)));
    check('private cache stores hashed identities and normalized secret-free values', () => { const entries = wires.filter(m => m.type === 'fixture-cache'); assert.ok(entries.length > 0); assert.ok(entries.every(e => e.hashed && !e.containsSecret)); });
    check('fixture diagnostics are private streams', () => assert.ok(streams.join('').includes(SECRET)));
    check('parent stdout and stderr never receive native credentials', () => assert.ok(!parentLogs.join('').includes(SECRET)));
    console.log(pass + '/' + pass + ' native-provider-quota assertions passed');
  } finally { process.stdout.write = originalStdout; process.stderr.write = originalStderr; delete process.env.P25_QUOTA_FIXTURE; adapter?.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
