/* P25: all credentials and SDK modules here are disposable offline fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { Readable } = require('node:stream');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok  ' + name); }
const tick = () => new Promise(r => setTimeout(r, 5));
const until = async fn => { for (let n = 0; n < 200; n++) { if (fn()) return; await tick(); } throw Error('fixture did not settle'); };
const importFile = name => import(pathToFileURL(path.resolve(__dirname, '..', name)).href);
const SECRET = 'fixture-credential-MUST-NEVER-LEAVE-BACKEND';
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-auth-'));
  try {
    const { createProviders } = await importFile('server/providers.js');
    const file = path.join(dir, 'models.json');
    fs.writeFileSync(file, JSON.stringify({providers:{example:{apiKey:SECRET,headers:{Authorization:SECRET},baseUrl:'https://example.test/v1',models:[{id:'m',headers:{Authorization:SECRET}}]}}}));
    let body;
    createProviders({modelsJson:file}).handle({method:'GET'}, {writeHead(){return this;},end(s){body=JSON.parse(s);}}, new URL('http://local/api/providers'));
    check('models.json GET never returns stored key/header values',()=>assert.ok(!JSON.stringify(body).includes(SECRET)));
    check('safe configuration still contains model id',()=>assert.equal(body.providers.example.models[0].id,'m'));
    const providersService = createProviders({ modelsJson: file });
    const providerRequest = (method, payload) => new Promise(resolve => {
      const req = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []); req.method = method;
      providersService.handle(req, { writeHead(){ return this; }, end(s){ resolve(JSON.parse(s)); } }, new URL('http://local/api/providers'));
    });
    const savedConfig = await providerRequest('POST', { name: 'example', config: { baseUrl: 'https://example.test/v2', api: 'openai-responses', models: [{ id: 'm', name: 'Renamed' }, { id: 'new-model' }] } });
    const savedDisk = JSON.parse(fs.readFileSync(file, 'utf8')).providers.example;
    check('safe metadata POST preserves existing disk credential', () => { assert.equal(savedConfig.ok, true); assert.equal(savedDisk.apiKey, SECRET); assert.equal(savedDisk.baseUrl, 'https://example.test/v2'); });
    check('safe metadata POST preserves provider and same-id model headers only on disk', () => { assert.deepEqual(savedDisk.headers, { Authorization: SECRET }); assert.deepEqual(savedDisk.models.find(m => m.id === 'm').headers, { Authorization: SECRET }); assert.equal(savedDisk.models.find(m => m.id === 'm').name, 'Renamed'); assert.equal(savedDisk.models.find(m => m.id === 'new-model').headers, undefined); });
    const readSaved = await providerRequest('GET');
    check('POST response and subsequent GET never expose preserved keys or headers', () => { assert.ok(!JSON.stringify(savedConfig).includes(SECRET)); assert.ok(!JSON.stringify(readSaved).includes(SECRET)); assert.equal(readSaved.providers.example.models[0].name, 'Renamed'); });
    const sdk = await importFile('server/provider-auth-sdk.js');
    const unsafeModel = { id: 'safe-model', provider: 'openai', name: 'Safe Model', api: 'openai-responses', contextWindow: 1000, headers: { Authorization: SECRET }, apiKey: SECRET, credentials: { access: SECRET }, unknownAuth: SECRET, cost: { input: 1, apiKey: SECRET } };
    for (const command of ['get_state', 'get_available_models', 'set_model', 'cycle_model']) {
      const data = command === 'get_available_models' ? { models: [unsafeModel], apiKey: SECRET } : command === 'set_model' ? unsafeModel : { model: unsafeModel, thinkingLevel: 'high', auth: { apiKey: SECRET }, unknownAuth: SECRET };
      const safe = sdk.sanitizeModelEvent({ type: 'response', command, id: 'fixture-response', success: true, data });
      check(command + ' model projection strips keys, headers and unknown auth fields', () => { assert.ok(!JSON.stringify(safe).includes(SECRET)); assert.equal(safe.id, 'fixture-response'); const model = command === 'get_available_models' ? safe.data.models[0] : command === 'set_model' ? safe.data : safe.data.model; assert.equal(model.id, 'safe-model'); assert.equal(model.contextWindow, 1000); assert.deepEqual(model.cost, { input: 1 }); });
      const failure = sdk.sanitizeModelEvent({ type: 'response', command, success: false, data: { apiKey: SECRET }, error: SECRET });
      check(command + ' failed model operation strips native error and credential body', () => { assert.ok(!JSON.stringify(failure).includes(SECRET)); assert.equal(failure.success, false); assert.match(failure.error, /认证/); });
    }
    const stateWithoutModel = sdk.sanitizeModelEvent({ type: 'response', command: 'get_state', success: true, data: { model: null, sessionId: 'fixture-session', auth: SECRET } });
    check('get_state null model preserved while unknown auth state omitted', () => assert.deepEqual(stateWithoutModel.data, { model: null, sessionId: 'fixture-session' }));
    const stderr = sdk.sanitizeModelEvent({ type: 'bridge_stderr', text: SECRET, credentials: { access: SECRET }, raw: SECRET });
    check('bridge stderr has closed safe diagnostic shape', () => { assert.deepEqual(Object.keys(stderr).sort(), ['text', 'type']); assert.ok(!JSON.stringify(stderr).includes(SECRET)); });
    const parseError = sdk.sanitizeModelEvent({ type: 'bridge_parse_error', line: SECRET, error: SECRET, credentials: { access: SECRET } });
    check('bridge parse error has closed safe diagnostic shape', () => { assert.deepEqual(Object.keys(parseError).sort(), ['reason', 'type']); assert.ok(!JSON.stringify(parseError).includes(SECRET)); });
    const flow = await importFile('server/provider-auth.js');
    const malformedController = flow.createProviderAuth({ adapter: { list: async () => ({ capability: {}, providers: [] }) } });
    for (const payload of [null, [], 'string', 1, true]) {
      let status, response;
      await malformedController.handle(Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { method: 'POST' }),
        { writeHead(code) { status = code; return this; }, end(value) { response = JSON.parse(value); } }, new URL('http://fixture/api/provider-auth/login'));
      check('malformed JSON shape returns safe HTTP 400: ' + JSON.stringify(payload), () => { assert.equal(status, 400); assert.equal(response.code, 'input'); });
    }
    malformedController.dispose();
    check('HTTPS OAuth URL accepted',()=>assert.equal(sdk.safeAuthUrl('https://auth.example.test/login?state=fixture'),'https://auth.example.test/login?state=fixture'));
    for (const value of ['javascript:alert(1)','file:///tmp/x','http://auth.example.test','https://u:p@auth.example.test','https://auth.example.test/?access_token='+SECRET])
      check('unsafe OAuth URL rejected: '+value.split(':')[0],()=>assert.equal(sdk.safeAuthUrl(value),null));
    const meta = {providerId:'openai',displayName:'OpenAI',methods:[{type:'oauth',label:'ChatGPT subscription',canLogin:true,isSubscription:true},{type:'api-key',label:'OpenAI API key',canLogin:false,isSubscription:false}],storedType:'oauth',checkType:'oauth'};
    const d = sdk.authDescriptor(meta);
    check('ChatGPT OAuth native metadata',()=>assert.equal(d.authType,'oauth'));
    check('Pi-confirmed OAuth credential is locally connected',()=>assert.equal(d.authenticated,true));
    check('account label never derived from raw credential',()=>assert.equal(sdk.authDescriptor({...meta,access:SECRET,refresh:SECRET,accountLabel:SECRET}).accountLabel,null));
    const key = sdk.authDescriptor({...meta,methods:[meta.methods[1]],storedType:'api_key',checkType:null});
    check('stored API key is separate from authenticated',()=>assert.equal(key.authenticated,null));
    check('API provider has no OAuth login',()=>assert.equal(key.canLogin,false));
    check('API key is managed outside renderer',()=>assert.equal(key.canConfigureKey,false));
    const unknown = sdk.authDescriptor({providerId:'extension',unknown:true});
    check('unknown is null, not logged out',()=>assert.equal(unknown.authenticated,null));
    check('environment remains its own source',()=>assert.equal(sdk.authDescriptor({...meta,storedType:null,checkType:'api_key',source:'environment'}).source,'environment'));
    let identity='pi-one'; let request; let starts=0; let exits=0; let refreshes=0; let busy=false; let lateResolve;
    let descriptors=[d];
    const adapter={identityKey:()=>identity, async list(){return {capability:{sdkAvailable:true,reason:null,piVersion:'fixture'},providers:descriptors};},
      async login(provider,type,callbacks){ starts++; request=callbacks; await new Promise((resolve,reject)=>{ lateResolve=resolve; callbacks.signal.addEventListener('abort',()=>reject(Error(SECRET)),{once:true}); }); },
      async logout(){exits++;descriptors=[sdk.authDescriptor({...meta,storedType:null,checkType:null})];}};
    const controller=flow.createProviderAuth({adapter,busyReason:()=>busy?'busy':null,synchronize:async()=>{refreshes++;return {ok:true};},timeoutMs:5000});
    await controller.read();
    const start=await controller.start('openai','oauth'); await until(()=>!!request);
    check('login enters a real single flight',()=>assert.equal(starts,1));
    const second=await controller.start('openai','oauth'); check('duplicate login rejected',()=>assert.equal(second.code,'busy'));
    const competing=await controller.logout('openai'); check('logout blocked until login drains',()=>assert.equal(competing.code,'busy'));
    request.notify({type:'auth_url',url:'https://auth.example.test/login',instructions:SECRET});
    check('browser phase from Pi event',()=>assert.equal(controller.snapshot().flow.state,'waiting-browser'));
    check('untrusted progress/instructions not echoed',()=>assert.ok(!JSON.stringify(controller.snapshot()).includes(SECRET)));
    request.notify({type:'device_code',verificationUri:'https://auth.example.test/device',userCode:'ABCD-EFGH'});
    check('device code state',()=>assert.equal(controller.snapshot().flow.state,'waiting-device-code'));
    const prompt=request.prompt({type:'select',message:SECRET,options:[{id:'browser',label:'Browser'},{id:'device',label:'Device code'}]});
    const p=controller.snapshot().flow.prompt;
    check('select interaction uses native option ids',()=>assert.equal(p.options[1].id,'device'));
    const accepted=controller.respond(start.flow.id,p.id,'device'); check('answer accepted',()=>assert.equal(accepted.ok,true));
    const reply = await prompt;
    check('native promise gets selected id',()=>assert.equal(reply,'device'));
    check('duplicate callback rejected',()=>assert.equal(controller.respond(start.flow.id,p.id,'device').code,'stale'));
    controller.observeRuntime({type:'bridge_status',state:'starting',cwd:'project-B'});
    check('workspace switch does not restart auth',()=>assert.equal(starts,1));
    check('same Pi restart does not cancel auth',()=>assert.equal(controller.snapshot().flow.state,'verifying'));
    busy=true; lateResolve(); await until(()=>controller.snapshot().flow.state==='success');
    check('success verified through Pi readback',()=>assert.equal(controller.snapshot().providers[0].authenticated,true));
    check('busy chat defers model reload',()=>assert.equal(refreshes,0));
    busy=false; await controller.sync(); check('idle chat refreshes real models',()=>assert.equal(refreshes,1));
    const out=await controller.logout('openai'); check('logout operation started',()=>assert.equal(out.ok,true));
    await until(()=>controller.snapshot().flow.state==='success');
    check('logout refreshes native credential metadata',()=>assert.equal(controller.snapshot().providers[0].credentialStored,false));
    check('logout calls native API only once',()=>assert.equal(exits,1));
    descriptors=[d]; await controller.read();
    request=null; const cancel=await controller.start('openai','oauth'); await until(()=>!!request);
    controller.cancel(cancel.flow.id); await until(()=>!controller.inFlight());
    check('cancel state retained',()=>assert.equal(controller.snapshot().flow.state,'cancelled'));
    check('cancel error never carries credentials',()=>assert.ok(!JSON.stringify(controller.snapshot()).includes(SECRET)));
    request=null; await controller.start('openai','oauth'); await until(()=>!!request);
    identity='pi-two'; controller.observeRuntime({type:'bridge_status',state:'starting'}); await until(()=>!controller.inFlight());
    check('changed Pi identity invalidates old login',()=>assert.equal(controller.snapshot().flow.state,'cancelled'));
    controller.dispose();
    await controllerEdgeCases(flow, sdk, meta, d);
    await actualWorkerCases(dir, flow, sdk);
    if (process.env.PI_GUI_AUTH_PACKAGED_SERVER) await packagedServerCases(dir);
    console.log(`\n${passed}/${passed} 通过`);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}

async function controllerEdgeCases(flow, sdk, meta, descriptor) {
  const make = (login, logout = async () => {}, options = {}) => {
    let reads = 0;
    const adapter = { identityKey: () => 'fixture', list: async () => { reads++; return { capability: { sdkAvailable: true, reason: null, piVersion: 'fixture' }, providers: [descriptor] }; }, login, logout };
    return { controller: flow.createProviderAuth({ adapter, timeoutMs: 1000, ...options }), reads: () => reads };
  };
  {
    let maintenance = true; let nativeCalls = 0;
    const fx = make(async () => { nativeCalls++; }, async () => { nativeCalls++; }, { startBlocked: () => maintenance, busyReason: () => 'chat task' });
    try {
      const login = await fx.controller.start('openai', 'oauth'); const logout = await fx.controller.logout('openai');
      check('maintenance rejects both login and logout before creating any flow', () => { assert.equal(login.code, 'busy'); assert.equal(logout.code, 'busy'); assert.equal(fx.controller.snapshot().flow, null); assert.equal(nativeCalls, 0); });
      maintenance = false;
      const allowed = await fx.controller.start('openai', 'oauth'); await until(() => !fx.controller.inFlight());
      check('maintenance release permits login while chat task remains busy', () => { assert.equal(allowed.ok, true); assert.equal(nativeCalls, 1); assert.equal(fx.controller.snapshot().flow.state, 'success'); });
      check('busy chat defers model synchronization after maintenance release', () => assert.equal(fx.controller.snapshot().sync.state, 'pending'));
    } finally { fx.controller.dispose(); }
  }
  {
    let stored = false; let holdNext = false; let releaseOldPoll; let finishLogin; let listCalls = 0; let loginStarted = false;
    const snapshot = () => ({ capability: { sdkAvailable: true, reason: null, piVersion: 'fixture' }, providers: [sdk.authDescriptor({ ...meta, storedType: stored ? 'oauth' : null, checkType: stored ? 'oauth' : null })] });
    const adapter = { identityKey: () => 'serialized-reads', list: async () => { listCalls++; const captured = snapshot(); if (holdNext) { holdNext = false; return new Promise(resolve => { releaseOldPoll = () => resolve(captured); }); } return captured; },
      login: async () => { loginStarted = true; await new Promise(resolve => { finishLogin = resolve; }); }, logout: async () => {} };
    const native = flow.createProviderAuth({ adapter, busyReason: () => 'busy chat', timeoutMs: 2000 });
    try {
      await native.start('openai', 'oauth'); await until(() => loginStarted);
      holdNext = true; const oldPoll = native.read(); await until(() => !!releaseOldPoll);
      const readsBeforeCommit = listCalls; stored = true; finishLogin(); await tick();
      check('post-native credential read waits behind older pending status poll', () => { assert.equal(listCalls, readsBeforeCommit); assert.equal(native.inFlight(), true); });
      releaseOldPoll(); await oldPoll; await until(() => !native.inFlight());
      check('post-commit fresh read supersedes pre-commit poll credential snapshot', () => { assert.ok(listCalls > readsBeforeCommit); assert.equal(native.snapshot().providers[0].authenticated, true); assert.equal(native.snapshot().providers[0].credentialStored, true); assert.equal(native.snapshot().flow.state, 'success'); });
      const confirmed = await native.read();
      check('later status polling retains native-confirmed credential after commit', () => { assert.equal(confirmed.providers[0].authenticated, true); assert.equal(confirmed.flow.state, 'success'); });
    } finally { native.dispose(); }
  }
  {
    let callbacks;
    const fx = make(async (_p, _t, cb) => { callbacks = cb; await new Promise((_resolve, reject) => { cb.signal.addEventListener('abort', () => reject(Error(SECRET)), { once: true }); }); }, undefined, { timeoutMs: 25 });
    try {
      const started = await fx.controller.start('openai', 'oauth');
      await until(() => !!callbacks);
      const pending = callbacks.prompt({ type: 'manual_code', message: SECRET }).then(() => 'resolved', () => 'rejected');
      const promptId = fx.controller.snapshot().flow.prompt.id;
      await until(() => !fx.controller.inFlight());
      check('timeout aborts native login and ends failed', () => { assert.equal(callbacks.signal.aborted, true); assert.equal(fx.controller.snapshot().flow.errorCode, 'timeout'); });
      check('timeout rejects pending native prompt', () => assert.equal(fx.controller.snapshot().flow.prompt, null));
      const promptOutcome = await pending;
      check('timeout prompt settles rejected rather than hanging', () => assert.equal(promptOutcome, 'rejected'));
      check('late response after timeout rejected as stale', () => assert.equal(fx.controller.respond(started.flow.id, promptId, 'late-code').code, 'stale'));
      check('timeout performs native status readback and safe error projection', () => { assert.ok(fx.reads() >= 2); assert.ok(!JSON.stringify(fx.controller.snapshot()).includes(SECRET)); });
    } finally { fx.controller.dispose(); }
  }
  for (const operation of ['login', 'logout']) {
    const fx = make(async () => { throw Error(SECRET); }, async () => { throw Error(SECRET); });
    try {
      await (operation === 'login' ? fx.controller.start('openai', 'oauth') : fx.controller.logout('openai'));
      await until(() => !fx.controller.inFlight());
      check(operation + ' rejection produces fixed native-auth-failed', () => { assert.equal(fx.controller.snapshot().flow.state, 'failed'); assert.equal(fx.controller.snapshot().flow.errorCode, 'native-auth-failed'); });
      check(operation + ' failure still re-reads credential state', () => { assert.ok(fx.reads() >= 2); assert.equal(fx.controller.snapshot().providers[0].credentialStored, true); assert.ok(!JSON.stringify(fx.controller.snapshot()).includes(SECRET)); });
    } finally { fx.controller.dispose(); }
  }
  {
    let callbacks; let resolveLogin;
    const fx = make(async (_p, _t, cb) => { callbacks = cb; await new Promise(resolve => { resolveLogin = resolve; }); });
    try {
      const started = await fx.controller.start('openai', 'oauth'); await until(() => !!callbacks);
      fx.controller.cancel(started.flow.id);
      const before = fx.controller.snapshot().flow.revision;
      callbacks.notify({ type: 'auth_url', url: 'https://auth.example.test/late' });
      resolveLogin(); await until(() => !fx.controller.inFlight());
      check('late native success cannot resurrect cancelled flow', () => { assert.equal(fx.controller.snapshot().flow.state, 'cancelled'); assert.equal(fx.controller.snapshot().flow.revision, before); });
      check('late progress does not expose cancelled URL', () => assert.equal(fx.controller.snapshot().flow.url, null));
    } finally { fx.controller.dispose(); }
  }
  {
    let callbacks;
    const fx = make(async (_p, _t, cb) => { callbacks = cb; await new Promise((_resolve, reject) => cb.signal.addEventListener('abort', () => reject(Error(SECRET)), { once: true })); });
    try {
      await fx.controller.start('openai', 'oauth'); await until(() => !!callbacks);
      callbacks.notify({ type: 'auth_url', url: 'https://auth.example.test/?access_token=' + SECRET });
      await until(() => !fx.controller.inFlight());
      check('unsafe native URL aborts controller flight', () => { assert.equal(callbacks.signal.aborted, true); assert.equal(fx.controller.snapshot().flow.errorCode, 'unsafe-url'); assert.equal(fx.controller.snapshot().flow.url, null); });
      check('unsafe native URL credential absent from safe snapshot', () => assert.ok(!JSON.stringify(fx.controller.snapshot()).includes(SECRET)));
    } finally { fx.controller.dispose(); }
  }
  {
    let callbacks; let finish;
    const fx = make(async (_p, _t, cb) => { callbacks = cb; await new Promise(resolve => { finish = resolve; }); });
    try {
      const started = await fx.controller.start('openai', 'oauth'); await until(() => !!callbacks);
      const nativeSignal = new AbortController();
      const pending = callbacks.prompt({ type: 'text', signal: nativeSignal.signal }).then(() => 'resolved', () => 'rejected');
      const promptId = fx.controller.snapshot().flow.prompt.id;
      nativeSignal.abort();
      const outcome = await pending;
      check('native prompt abort rejects only that prompt', () => { assert.equal(outcome, 'rejected'); assert.equal(callbacks.signal.aborted, false); assert.equal(fx.controller.snapshot().flow.state, 'verifying'); });
      check('native prompt abort invalidates old prompt response', () => assert.equal(fx.controller.respond(started.flow.id, promptId, 'late').code, 'stale'));
      finish(); await until(() => !fx.controller.inFlight());
      check('native browser callback may complete after prompt abort', () => assert.equal(fx.controller.snapshot().flow.state, 'success'));
    } finally { fx.controller.dispose(); }
  }
}

async function actualWorkerCases(dir, flow, sdk) {
  const packageDir = path.join(dir, 'fake-public-sdk'); fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }));
  fs.writeFileSync(path.join(packageDir, 'index.js'), `
const secret=${JSON.stringify(SECRET)};
const providerIds=['browser','device','manual','select','native-abort','failure','secret-input','unsafe'];
const stored=new Set(['browser']);
export class ModelRuntime {
 static async create(options) { if(options.allowModelNetwork!==false||options.refreshOnCreate!==false) throw Error('unexpected network policy'); if(process.env.PI_GUI_TOKEN) throw Error('renderer token leaked into worker'); console.log(secret); console.error(secret); return new ModelRuntime(); }
 constructor(){this.stored=stored;}
 getProviders(){return [...providerIds.map(id=>({id,name:id,auth:{oauth:{name:'Subscription',isSubscription:true,login(){}}}})),{id:'key-only',name:'API Key',auth:{apiKey:{name:'API Key',login(){}}}},{id:'env-only',name:'Environment',auth:{apiKey:{name:'Environment'}}}];}
 async listCredentials(){return [...this.stored].map(providerId=>({providerId,type:'oauth',access:secret,refresh:secret,account:secret})).concat([{providerId:'key-only',type:'api_key',key:secret}]);}
 async checkAuth(id){if(id==='key-only')throw Error('stored API key must not be resolved'); return this.stored.has(id)?{type:'oauth',access:secret,refresh:secret}:id==='env-only'?{type:'api_key',key:secret}:null;}
 getProviderAuthStatus(id){return {source:id==='env-only'?'environment':'pi',apiKey:secret};}
 async login(id,type,{signal,notify,prompt}) {
  console.log(secret);console.error(secret);notify({type:'progress',message:secret,credentials:{access:secret}});
  if(id==='failure')throw Error(secret);
  if(id==='secret-input'){await prompt({type:'password',message:secret});return;}
  if(id==='unsafe'){notify({type:'auth_url',url:'https://auth.example.test/?access_token='+secret});await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error(secret)),{once:true});if(signal.aborted)reject(Error(secret));});return;}
  if(id==='browser')notify({type:'auth_url',url:'https://auth.example.test/oauth?state=fixture',instructions:secret});
  if(id==='device')notify({type:'device_code',verificationUri:'https://auth.example.test/device',userCode:'ABCD-EFGH',message:secret});
  if(id==='manual'){const value=await prompt({type:'manual_code',message:secret});if(value!=='fixture-code')throw Error(secret);}
  if(id==='select'){const value=await prompt({type:'select',message:secret,options:[{id:'browser',label:'Browser',secret},{id:'device',label:'Device',secret}]});if(value!=='device')throw Error(secret);}
  if(id==='native-abort'){const c=new AbortController();setTimeout(()=>c.abort(),10);try{await prompt({type:'text',signal:c.signal,message:secret});throw Error('prompt unexpectedly resolved');}catch(error){if(signal.aborted)throw error;}notify({type:'progress',message:secret});await new Promise(resolve=>setTimeout(resolve,25));}
  signal.throwIfAborted();this.stored.add(id);return {access:secret,refresh:secret};
 }
 async logout(id,{signal}){signal.throwIfAborted();console.log(secret);console.error(secret);if(id==='failure')throw Error(secret);this.stored.delete(id);return {oldCredential:secret};}
}
`);
  const privateStreams = []; const wireMessages = []; let workerEnv;
  const adapter = sdk.createAuthSdk({ resolvePackageDir: () => packageDir, identityKey: () => 'actual-worker-fixture', env: { ...process.env, PI_GUI_TOKEN: SECRET }, workerFactory(source, entry, env) {
    workerEnv = env;
    const worker = new Worker(source, { eval: true, workerData: entry, env, stdout: true, stderr: true });
    worker.on('message', m => wireMessages.push(m));
    worker.stdout.on('data', b => privateStreams.push(String(b))); worker.stderr.on('data', b => privateStreams.push(String(b)));
    return worker;
  } });
  const parentOutput = [];
  const stdoutWrite = process.stdout.write; const stderrWrite = process.stderr.write;
  let listed;
  try {
    process.stdout.write = function(chunk, ...args) { parentOutput.push(String(chunk)); return stdoutWrite.call(this, chunk, ...args); };
    process.stderr.write = function(chunk, ...args) { parentOutput.push(String(chunk)); return stderrWrite.call(this, chunk, ...args); };
    listed = await adapter.list();
    const events = [];
    await adapter.login('browser', 'oauth', { notify: e => events.push(e), prompt: async () => 'unused' });
    await tick();
    check('actual public SDK worker discovers native OAuth and API methods', () => { assert.equal(listed.capability.sdkAvailable, true); assert.equal(listed.providers.find(p => p.providerId === 'browser').methods[0].type, 'oauth'); assert.equal(listed.providers.find(p => p.providerId === 'key-only').canLogin, false); });
    check('actual public SDK enumeration never resolves stored API key', () => assert.equal(listed.providers.find(p => p.providerId === 'key-only').credentialStored, true));
    check('actual worker environment excludes renderer HTTP credential', () => assert.ok(!Object.hasOwn(workerEnv, 'PI_GUI_TOKEN')));
    check('actual public SDK credentials omitted from descriptors and worker messages', () => { assert.ok(!JSON.stringify(listed).includes(SECRET)); assert.ok(!JSON.stringify(wireMessages).includes(SECRET)); });
    check('actual stdout/stderr contain fixture secrets only on private streams', () => { assert.ok(privateStreams.join('').includes(SECRET)); assert.ok(!parentOutput.join('').includes(SECRET)); });
    check('actual progress and browser instructions projected before worker exit', () => { assert.ok(events.some(e => e.type === 'progress')); assert.ok(events.some(e => e.url === 'https://auth.example.test/oauth?state=fixture')); assert.ok(!JSON.stringify(events).includes(SECRET)); });
    for (const id of ['device', 'manual', 'select']) {
      let promptData; const received = [];
      await adapter.login(id, 'oauth', { notify: e => received.push(e), prompt: async p => { promptData = p; return id === 'manual' ? 'fixture-code' : 'device'; } });
      const after = await adapter.list();
      check('actual worker ' + id + ' native interaction confirms stored credential', () => { assert.equal(after.providers.find(p => p.providerId === id).authenticated, true); assert.ok(!JSON.stringify(after).includes(SECRET)); });
      if (id === 'device') check('actual worker device callback preserves safe device code', () => assert.equal(received.find(e => e.type === 'device_code').userCode, 'ABCD-EFGH'));
      else check('actual worker ' + id + ' prompt omits native message and extra fields', () => { assert.ok(!JSON.stringify(promptData).includes(SECRET)); assert.equal(promptData.type, id === 'manual' ? 'manual_code' : 'select'); if (id === 'select') assert.deepEqual(promptData.options, [{ id: 'browser', label: 'Browser' }, { id: 'device', label: 'Device' }]); });
    }
    let nativePromptId; let abortedPromptId; let rejectPrompt;
    await adapter.login('native-abort', 'oauth', { notify() {}, prompt: p => { nativePromptId = p.id; return new Promise((_resolve, reject) => { rejectPrompt = reject; }); }, abortPrompt: id => { abortedPromptId = id; rejectPrompt(Error('native cancelled')); } });
    check('actual worker native abort signals matching prompt ID without aborting OAuth', () => { assert.equal(abortedPromptId, nativePromptId); assert.equal(typeof nativePromptId, 'string'); });
    const afterAbort = await adapter.list();
    check('actual worker browser callback success survives native prompt abort', () => assert.equal(afterAbort.providers.find(p => p.providerId === 'native-abort').authenticated, true));
    for (const [id, expected] of [['failure', 'native-auth-failed'], ['secret-input', 'secret-input-not-supported']]) {
      let error;
      try { await adapter.login(id, 'oauth', { notify() {}, prompt: async () => SECRET }); } catch (e) { error = e; }
      check('actual worker ' + id + ' errors use safe fixed code', () => { assert.equal(error?.code, expected); assert.ok(!String(error?.stack).includes(SECRET)); });
    }
    let logoutError; try { await adapter.logout('failure'); } catch (e) { logoutError = e; }
    check('actual worker logout error never exposes native exception', () => { assert.equal(logoutError?.code, 'native-auth-failed'); assert.ok(!String(logoutError?.stack).includes(SECRET)); });
    await adapter.logout('browser');
    const afterLogout = await adapter.list();
    check('actual worker logout re-enumeration confirms removed stored OAuth', () => assert.equal(afterLogout.providers.find(p => p.providerId === 'browser').credentialStored, false));
    const controller = flow.createProviderAuth({ adapter, timeoutMs: 1000 });
    try {
      await controller.start('unsafe', 'oauth'); await until(() => !controller.inFlight());
      check('actual worker unsafe URL flow fails closed and aborts native SDK', () => { assert.equal(controller.snapshot().flow.errorCode, 'unsafe-url'); assert.ok(!JSON.stringify(controller.snapshot()).includes(SECRET)); });
    } finally { controller.dispose(); }
    for (const operation of ['cancel', 'timeout']) {
      const native = flow.createProviderAuth({ adapter, timeoutMs: operation === 'timeout' ? 500 : 1500 });
      try {
        const begun = await native.start('manual', 'oauth');
        await until(() => native.snapshot().flow?.state === 'waiting-input');
        const promptId = native.snapshot().flow.prompt.id;
        if (operation === 'cancel') native.cancel(begun.flow.id);
        await until(() => !native.inFlight());
        check('actual worker ' + operation + ' drains native prompt and operation', () => { assert.equal(native.snapshot().flow.state, operation === 'cancel' ? 'cancelled' : 'failed'); assert.equal(native.snapshot().flow.prompt, null); if (operation === 'timeout') assert.equal(native.snapshot().flow.errorCode, 'timeout'); });
        check('actual worker ' + operation + ' rejects late authorization response', () => assert.equal(native.respond(begun.flow.id, promptId, 'fixture-code').code, 'stale'));
        check('actual worker ' + operation + ' native metadata re-read is secret-free', () => { assert.ok(native.snapshot().providers.length > 0); assert.ok(!JSON.stringify(native.snapshot()).includes(SECRET)); });
      } finally { native.dispose(); }
    }
  } finally { process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite; adapter.dispose(); }
  const unsupported = path.join(dir, 'unsupported-public-sdk'); fs.mkdirSync(unsupported);
  fs.writeFileSync(path.join(unsupported, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }));
  fs.writeFileSync(path.join(unsupported, 'index.js'), 'export class ModelRuntime { static async create(){throw Error("must not run when public methods absent");} }');
  const missing = sdk.createAuthSdk({ resolvePackageDir: () => unsupported, identityKey: () => 'unsupported' });
  try {
    const result = await missing.list();
    check('actual unsupported public SDK returns unknown fallback capability', () => { assert.equal(result.capability.sdkAvailable, false); assert.deepEqual(result.providers, []); assert.match(result.capability.reason, /\/login/); });
    let error; try { await missing.login('browser', 'oauth', { notify() {}, prompt: async () => 'code' }); } catch(e) { error = e; }
    check('actual unsupported public SDK login fails with unsupported code', () => assert.equal(error?.code, 'unsupported'));
  } finally { missing.dispose(); }
}
/* Opt-in: exercise the built Electron backend against the same offline public
 * SDK fixture. No build requirement or skipped assertions in normal npm test. */
async function packagedServerCases(dir) {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const serverFile = path.resolve(process.env.PI_GUI_AUTH_PACKAGED_SERVER);
  const executable = process.env.PI_GUI_AUTH_PACKAGED_EXE || process.execPath;
  assert.ok(fs.statSync(serverFile).isFile(), 'packaged backend must exist');
  const home = path.join(dir, 'packaged-home');
  const data = path.join(dir, 'packaged-data');
  const binDir = path.join(dir, 'packaged-npm');
  const packageDir = path.join(binDir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  for (const p of [home, data, packageDir]) fs.mkdirSync(p, { recursive: true });
  for (const name of ['package.json', 'index.js']) fs.copyFileSync(path.join(dir, 'fake-public-sdk', name), path.join(packageDir, name));
  // Existing launch identity resolves this shim to its adjacent installed package.
  // No project is activated, so the shim never runs and no real Pi is invoked.
  const shim = path.join(binDir, 'pi.cmd');
  fs.writeFileSync(shim, '@echo off\r\nexit /b 0\r\n');
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const token = 'fixture-packaged-http-token';
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), PI_BIN: shim,
    PI_GUI_DATA: data, PI_CODING_AGENT_DIR: home, HOME: home, USERPROFILE: home,
    PI_GUI_TOKEN: token, PI_GUI_OPEN: '0', PI_GUI_CWD: '', PI_CWD: '' };
  const child = spawn(executable, [serverFile], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let childError;
  const capture = chunk => { output = (output + String(chunk)).slice(-1024 * 1024); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.on('error', error => { childError = error; });
  const request = (route, body) => new Promise((resolve, reject) => {
    const wire = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: wire === null ? 'GET' : 'POST',
      headers: { 'x-pi-gui-token': token, ...(wire === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire) }) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
      res.on('end', () => { try { assert.ok(!text.includes(SECRET), 'packaged HTTP must omit credential sentinel'); resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (e) { reject(e); } });
    });
    req.setTimeout(20_000, () => req.destroy(Error('packaged HTTP timeout')));
    req.on('error', reject); req.end(wire || undefined);
  });
  async function poll(predicate) {
    for (let n = 0; n < 200; n++) {
      if (childError) throw childError;
      if (child.exitCode !== null) throw Error('packaged backend exited before fixture settled: ' + output);
      try { const result = await request('/api/provider-auth'); if (predicate(result.body)) return result.body; } catch (error) { if (error.code !== 'ECONNREFUSED') throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('packaged backend fixture did not settle: ' + output);
  }
  try {
    const listed = await poll(j => j.capability?.sdkAvailable === true);
    check('packaged Electron backend loads proven package public native auth SDK', () => { assert.equal(listed.capability.piVersion, '1.0.0'); assert.equal(listed.providers.find(p => p.providerId === 'manual').canLogin, true); });
    const malformed = await request('/api/provider-auth/login', null);
    check('packaged auth malformed body returns 400 without terminating backend', () => assert.equal(malformed.status, 400));
    const begun = await request('/api/provider-auth/login', { providerId: 'manual', authType: 'oauth' });
    check('packaged native login route accepts offline OAuth flow', () => assert.equal(begun.status, 200));
    const waiting = await poll(j => j.flow?.state === 'waiting-input');
    check('packaged worker forwards native callback as safe manual prompt', () => { assert.equal(waiting.flow.prompt.type, 'manual_code'); assert.deepEqual(waiting.flow.prompt.options, []); });
    const answered = await request('/api/provider-auth/respond', { flowId: waiting.flow.id, promptId: waiting.flow.prompt.id, value: 'fixture-code' });
    check('packaged native callback route accepts matching reply', () => assert.equal(answered.status, 200));
    const loggedIn = await poll(j => j.flow?.state === 'success' && j.sync?.state === 'synced');
    check('packaged native login readback confirms locally stored OAuth', () => { const p = loggedIn.providers.find(p => p.providerId === 'manual'); assert.equal(p.credentialStored, true); assert.equal(p.authenticated, true); });
    const loggedOut = await request('/api/provider-auth/logout', { providerId: 'manual' });
    check('packaged native logout route accepts stored credential removal', () => assert.equal(loggedOut.status, 200));
    const removed = await poll(j => j.flow?.operation === 'logout' && j.flow.state === 'success' && j.sync?.state === 'synced');
    check('packaged native logout re-enumerates removed local credential', () => assert.equal(removed.providers.find(p => p.providerId === 'manual').credentialStored, false));
    check('packaged worker stdout stderr and HTTP never expose credential sentinel', () => assert.ok(!output.includes(SECRET)));
    check('packaged fixture never activates a project or spawns real Pi', () => assert.equal(fs.existsSync(path.join(data, 'projects.json')), false));
  } finally {
    if (child.exitCode === null && !childError) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill(); await closed;
    }
  }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
