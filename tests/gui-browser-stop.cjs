/* Stop锛堝仠姝級鍦ㄨ閰嶅眰銆丷outer銆乥ridge 涓庡墠绔箣闂寸殑瀹屾暣濂戠害 鈥斺€?鍖呭惈 P29 鐨? * 鍐呯疆娴忚鍣ㄥ彇娑堢‘璁ゃ€? *
 * 杩欎竴浠?*鍙娴忚鍣ㄩ偅涓€娈?*锛堝唴缃祻瑙堝櫒鑷姩鍔ㄤ綔蹇呴』鍏堝け鏁堛€佷笖蹇呴』鏈夌‘璁わ級锛? * Pi 渚х殑鏉冨▉鍋滄鏃跺簭锛坈lear_queue 鈫?abort 鈫?绛夊簲绛?鈫?灞忛殰锛夊湪 tests/stop-barrier.cjs銆? * 涓よ€呭悎璧锋潵鎵嶆槸瀹屾暣鐨?Stop锛?*browser cancellation confirmed + Pi cancellation confirmed**銆? *
 * 濂戠害锛堟崲杩囦竴鐗堬紝鍒寜鏃ц涓烘敼鍥炲幓锛夛細
 *   - 娴忚鍣ㄦ病纭涔嬪墠锛?*涓€涓瓧鑺傞兘涓嶈杩?pi**锛圚TTP 涔熷帇鐫€涓嶅洖锛夛紱
 *   - 娴忚鍣ㄧ‘璁ゅけ璐?鈮?涓嶅仠 Pi锛歛bort 鐓ф牱閫侊紝浣?*缁濅笉瀹ｇО鎴愬姛**锛? *     HTTP 503 + 鍥哄畾瀹夊叏鏂囨锛堜笉鍥炴樉浠讳綍鍘熷閿欒锛夛紱
 *   - 鏃堕棿杞翠笂姘歌繙 clear_queue 鍦?abort 涔嬪墠锛? *   - 鍓嶇锛氥€屾鍦ㄥ仠姝⑩€︺€嶆槸鐐瑰嚮閭ｄ竴鍒诲氨鍐欑殑锛堜笉鏄€屽凡璇锋眰鍋滄鈥︺€嶁€斺€? *     閭ｄ細璁╃敤鎴蜂互涓哄凡缁忓仠浜嗭級锛涘け璐ヤ笉瑕嗙洊鐘舵€佹爮銆佸彧寮逛竴鏉″畨鍏?toast銆? */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { bundle } = require('./esm-bundle.cjs');
const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log('  ok  ' + name); }
  catch (error) { failed++; console.error(' FAIL ' + name + ': ' + error.message); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, fn, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error('绛夊緟瓒呮椂锛? + what);
    await sleep(5);
  }
}

async function main() {
  const { createRpcBridge } = await import('../server/rpc-bridge.js');
  const { createRouter } = await import('../server/router.js');
  const { createSystemStorage } = await import('../server/system-storage.js');
  const { createEnvironmentRoutes } = await import('../server/environment-routes.js');
  const { createReviewCommentStore } = await import('../server/review-comment-store.js');
  const { createReviewCommentAuthority } = await import('../server/review-comment-authority.js');
  const { createReviewCommentRoutes } = await import('../server/review-comment-routes.js');
  const { createSessionRevertRoutes } = await import('../server/session-revert-routes.js');
  const { createSessionRevertAuthority, createSessionRevertMutationAuthority } = await import('../server/session-revert-authority.js');
  const { createSessionRevertAdmission } = await import('../server/session-revert-admission.js');
  const { createSessionRevertStopAndDrain } = await import('../server/session-revert-object-runtime-authority.js');
  const { createCollabStore } = await import('../server/collab-store.js');
  const { createCollabAuthority } = await import('../server/collab-authority.js');
  const { createCollabService } = await import('../server/collab-service.js');
  const { createCollabProposalSource } = await import('../server/collab-proposal-source.js');
  const { createProposalQueue } = await import('../server/collab-proposal-queue.js');
  const { createCollabRoutes } = await import('../server/collab-routes.js');
  const { createMessageEditRoutes } = await import('../server/message-edit-routes.js');
  const { createMessageEditService } = await import('../server/message-edit.js');
  let ack, entered, stopped = false, writeError = null, lastSendResult;
  let abortReply = true;
  const writes = [], guarded = [], modelAccepted = [], activityAccepted = [];
  const raw = createRpcBridge({
    runtime: { getCurrentCwd: () => os.tmpdir(), isShuttingDown: () => stopped },
    publish() {}, piBin: 'fixture-pi', isWin: false, env: {},
    stopTimeoutMs: 300,
    browserLaunch: {
      available: () => true,
      prepare: async () => ({ args: [], env: {} }),
      invalidate: (options) => {
        if (!options?.strict) return Promise.resolve();
        entered.resolve();
        return ack.promise;
      },
    },
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      const reply = (command) => {
        const ok = { id: command.id, type: 'response', command: command.type, success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } };
        child.stdout.emit('data', JSON.stringify(ok) + '\n');
      };
      child.stdin = { on() {}, end() {}, write(line) {
        if (writeError) throw writeError;
        const command = JSON.parse(line);
        writes.push(command);
        /* 娴忚鍣ㄧ‘璁ゅけ璐ョ殑閭ｆ潯璺緞涔熺収鏍疯鍋?Pi 鈥斺€?鐢ㄤ緥閫氳繃 abortReply 鍐冲畾
         * 杩欐潯 abort 搴旂瓟鏄笉鏄細鍥炴潵銆?*/
        if (command.type === 'abort') { if (abortReply) setImmediate(() => reply(command)); }
        else if (command.id !== undefined) setImmediate(() => reply(command));
      } };
      child.kill = () => {};
      return child;
    },
  });
  await raw.start();
  // Evaluate the production composition block verbatim: do not copy its send wrapper.
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = source.indexOf('const environmentRoutes = createEnvironmentRoutes({');
  // The update maintenance wrapper now sits between Router composition and HTTP.
  // Evaluate only the real Router facade, keeping every Stop assertion below.
  const end = source.indexOf('\nconst updateMaintenance = createAppUpdateMaintenance({', start);
  assert.ok(start >= 0 && end > start, 'server.js Router assembly must be found');
  let syncing = false, guardError = null, wrapped = null, captureError = null, disabled = 0;
  const environmentReport = { requiredReady: false };
  const environmentJob = { id: 'fixture-environment-job', state: 'running' };
  const context = {
    // Keep the real composition dependency shape. This Stop fixture never
    // calls comment routes, so constructing the lazy store performs no I/O.
    createReviewCommentStore, createReviewCommentAuthority, createReviewCommentRoutes,
    createCollabStore, createCollabAuthority, createCollabService, createCollabRoutes,
    createCollabProposalSource, createProposalQueue,
    createEnvironmentRoutes,
    /* 瑁呴厤鐗囨鐜板湪涔熸瀯閫犲巻鍙叉秷鎭紪杈戣矾鐢变笌 collab 鐨勭紪杈戦椄闂ㄣ€傛湰 fixture
     * 涓嶈繘鍏ョ紪杈戞垨 collab 鐢熸垚锛屼絾鐢ㄧ湡瀹炴湇鍔′笌鐪熷疄璺敱宸ュ巶淇濇寔鐢熶骇褰㈢姸锛?     * 涓嶇敤闅愬紡鍏ㄥ眬鎴栫┖瀵硅薄鎺╃洊瑁呴厤寮曠敤婕傜Щ銆?*/
    createMessageEditRoutes,
    messageEditService: createMessageEditService(),
    messageEditLaunch: { command: () => null, token: () => null },
    primaryNativeSession: null,
    desktopEnvironment: false,
    environmentSetup: { check: async () => environmentReport },
    environmentInstall: { getJob: (id) => id === environmentJob.id ? environmentJob : null },
    invalidatePiCaches() {},
    // This fixture has no candidate run. Preserve the production facade shape
    // without scanning a shared TEMP data directory; candidate Stop has its own
    // isolated lifecycle and real Electron coverage.
    createCandidateRuns: () => ({busy: () => false}), createCandidateRoutes: () => null, candidateRunsRef: null,
    DATA_DIR: os.tmpdir(), MODELS_JSON: path.join(os.tmpdir(), 'fixture-agent', 'models.json'), __dirname: ROOT,
    path, process: { env: {} }, runningInSea: false, createSystemStorage,
    withWorkspaceIdentity: (...args) => context.conversationWorkspaces.withWorkspace(...args),
    createSessionRevertRoutes, createSessionRevertAuthority, createSessionRevertMutationAuthority, createSessionRevertStopAndDrain,
    mutationAdmission: createSessionRevertAdmission(), getEvidenceStore: async () => { throw Error('fixture evidence unavailable'); },
    createRouter(options) { wrapped = options.rpc; return createRouter(options); },
    rpc: { ...raw, send(command) {
      lastSendResult = raw.send(command);
      // Observe without replacing the Promise; also avoid an unhandled rejection.
      lastSendResult?.catch(() => {});
      return lastSendResult;
    }, abortAndWait(command) {
      /* 鍋滄璧扮殑鏄繖涓叆鍙ｏ紙涓嶆槸 send锛夆€斺€?鍚屾牱鍙瀵熴€佷笉鏇挎崲銆?*/
      lastSendResult = raw.abortAndWait(command);
      lastSendResult?.catch(() => {});
      return lastSendResult;
    } },
    auth: { denyRequest: () => null }, sse: {}, managedProcesses: { manager: null }, worktrees: null,
    specs: null, extensionPackages: null, extensionMarket: null,
    /* This Stop fixture never enters the Files or Terminal routes; their real
     * handlers have isolated suites. The Router facade still needs the
     * composition identifiers to exist. */
    files: null,
    terminal: null,
    /* 瑁呴厤鐗囨鐜板湪鎶婄粡鍏镐細璇濆拰鏅€氶」鐩粺涓€浜ょ粰 conversationWorkspaces銆?     * 鏈敤渚嬩笉杩涘叆 revert 璺敱锛屼絾蹇呴』鎻愪緵鐪熷疄褰㈢姸鐨勪緷璧栵紝閬垮厤 VM 瑁呴厤
     * 鐢ㄩ殣寮忓叏灞€鎴?null 鎺╃洊鐢熶骇寮曠敤宸茬粡婕傜Щ銆?*/
    conversationWorkspaces: { withWorkspace: () => {
      throw Object.assign(Error('fixture_workspace_unavailable'), { code: 'unknown_workspace' });
    } },
    logging: null,
    sessionChanges: { assertReady: async () => { if (captureError) throw captureError; }, disable: async () => { disabled++; } },
    providerAuth: { snapshot: () => ({ sync: { state: syncing ? 'syncing' : 'idle' } }) },
    providerManagement: null,
    modelGeneration: {
      guardCommand(command) { if (guardError) throw guardError; guarded.push(command); },
      noteCommandAccepted: (command) => modelAccepted.push(command),
    },
    piActivity: { noteCommandAccepted: (command) => activityAccepted.push(command) },
    primaryToolGuard: { resume() {} },
    observeClassicSubmission() {},
    serveClassicExecutionHistory() { assert.fail('Stop test routed to execution history'); },
    createSessionExport: () => null,
    runtime: { getCurrentCwd: () => os.tmpdir() }, piLaunch: { packageDir: () => null },
  };
  for (const name of ['providers', 'projects', 'projectConfig', 'skills', 'mcp', 'mcpNative', 'mcpManager',
    'approvalProbe', 'extensions', 'sessions', 'sessionSearch', 'sessionTitles', 'planner', 'gitRoutes',
    'uploads', 'diagnostics', 'updateCheck', 'piUpdate', 'capabilityInstall', 'quota', 'piCompat']) context[name] = {};
  Object.assign(context, { runtimeRoutes: null, htmlArtifacts: null, primaryOwner: () => null, runtimeRegistry: { liveCount: () => 0 } });
  const route = vm.runInNewContext(source.slice(start, end) + '\nroute;', context);
  let responseFinished = false;
  const server = http.createServer((req, res) => {
    res.once('finish', () => { responseFinished = true; });
    route(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/command`;
  const post = async (command) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await check('瑁呴厤锛氱幆澧冩娴嬪拰瀹夎浠诲姟閫氳繃鐢熶骇 Router 鍒嗗彂', async () => {
      const report = await fetch(new URL('/api/environment', url));
      assert.equal(report.status, 200);
      assert.deepEqual(await report.json(), { ok: true, environment: environmentReport });

      const jobUrl = new URL('/api/environment/job', url);
      jobUrl.searchParams.set('id', environmentJob.id);
      const job = await fetch(jobUrl);
      assert.equal(job.status, 200);
      assert.deepEqual(await job.json(), { ok: true, job: environmentJob });
    });
    await check('A 娴忚鍣ㄦ湭纭鏃讹紝HTTP 涓?Pi 閮藉帇鐫€锛涚‘璁ゅ悗鎸?clear_queue 鈫?abort 鐨勯『搴忓彂鍑猴紝abort 搴旂瓟鍥炴潵鎵嶇畻鎴愬姛', async () => {
      ack = deferred(); entered = deferred(); responseFinished = false;
      const before = writes.length;
      const response = post({ type: 'abort' });
      await entered.promise;
      try {
        assert.ok(lastSendResult instanceof Promise);
        await sleep(30);
        assert.equal(responseFinished, false, 'HTTP 涓嶈兘鍦ㄦ祻瑙堝櫒鍙栨秷纭涔嬪墠缁撴潫');
        assert.equal(writes.length, before, 'Pi 涓嶈兘鎻愬墠鏀跺埌浠讳綍鍛戒护');
      } finally { ack.resolve(); }
      const result = await response;
      assert.deepEqual(result, { status: 200, body: { ok: true, stop: { evidence: 'abort-response', queue: 'cleared' } } });
      assert.deepEqual(writes.slice(before).map((c) => c.type), ['clear_queue', 'abort']);
    });
    await check('B 娴忚鍣ㄧ‘璁ゅけ璐ワ細abort 鐓ф牱閫佸嚭鍘伙紝HTTP 503 鍙湁瀹夊叏鏂囨锛屼笖涓嶅绉版垚鍔?, async () => {
      ack = deferred(); entered = deferred();
      const before = writes.length;
      const response = post({ type: 'abort' });
      await entered.promise;
      ack.reject(new Error('token=fixture-secret raw bridge error stack'));
      const result = await response;
      /* 鎶ュ憡鍏堜簬銆屾妸鍛戒护鍐欒繘 pi銆嶈繑鍥烇紝鎵€浠ヨ繖閲岀瓑鍐欏叆钀藉湴鍐嶆柇瑷€椤哄簭銆?*/
      await waitFor('abort 鍐欒繘 Pi', () => writes.some((c) => c.type === 'abort'));
      assert.deepEqual(writes.slice(before).map((c) => c.type), ['clear_queue', 'abort']);
      assert.equal(result.status, 503);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.code, 'browser_cancel_unconfirmed');
      assert.equal(result.body.error, 'Pi 宸叉敹鍒板仠姝㈣姹傦紝浣嗗唴缃祻瑙堝櫒鍙栨秷纭涓嶅彲鐢ㄣ€?);
      assert.ok(!/token|fixture-secret|stack|raw bridge error/.test(JSON.stringify(result.body)));
      /* 娴忚鍣ㄧ‘璁ゅけ璐ュ彧鏄?*鎶ュ憡**澶辫触锛汸i 渚х収鏃ф湁鏉冨▉纭 鈫?灞忛殰蹇呴』瑙ｉ櫎銆?*/
      await waitFor('灞忛殰瑙ｉ櫎', () => !raw.stopState());
      assert.ok(!JSON.stringify(raw.getState()).includes('fixture-secret'));
    });
    await check('C prompt 涓?steer 浠嶆槸鍚屾鍙戦€侊紝鍓ユ帀澶囩敤鏍囪骞朵繚鎸佹帴鍙楅『搴?, async () => {
      assert.ok(wrapped, '鐢熶骇瑁呴厤灞傜殑 rpc facade 蹇呴』琚彇鍒?);
      for (const type of ['prompt', 'steer']) {
        const command = { type, message: 'fixture', __fallbackOwner: 'owner' };
        const before = writes.length;
        assert.equal(wrapped.send(command), undefined);
        assert.equal(writes.length, before + 1);
        assert.deepEqual(writes.at(-1), { type, message: 'fixture' });
        assert.equal(guarded.at(-1), command);
        assert.equal(modelAccepted.at(-1), command);
        assert.equal(activityAccepted.at(-1), command);
        assert.deepEqual(await post({ type, message: 'fixture' }), { status: 200, body: { ok: true } });
      }
    });
    await check('C 鍚屾鍐欏け璐ヤ繚鎸侀敊璇韩浠斤紝涓斾笉鏍囪銆屽凡鎺ュ彈銆?, () => {
      const before = [modelAccepted.length, activityAccepted.length];
      writeError = new Error('fixture synchronous failure');
      try { assert.throws(() => wrapped.send({ type: 'prompt' }), error => error === writeError); }
      finally { writeError = null; }
      assert.deepEqual([modelAccepted.length, activityAccepted.length], before);
    });
    await check('P33 capture admission rejects before synchronous Pi send', async () => {
      const before = writes.length; captureError = Error('source_unverified');
      try { assert.equal((await post({ type: 'prompt', message: 'fixture' })).status, 503); assert.equal(writes.length, before); }
      finally { captureError = null; }
    });
    await check('P33 explicit disable works without forwarding a model prompt', async () => {
      const before = writes.length; captureError = Error('capture_unavailable');
      try { assert.equal((await post({ type: 'prompt', message: '/gui-capture disable' })).status, 200); assert.equal(disabled, 1); assert.equal(writes.length, before); }
      finally { captureError = null; }
    });
    await check('P33.4 retained workspace lease rejects every new turn before Pi stdin or acceptance bookkeeping', async () => {
      const lease = context.mutationAdmission.acquire(os.tmpdir());
      const before = [writes.length, modelAccepted.length, activityAccepted.length];
      try {
        for (const type of ['prompt', 'steer', 'follow_up']) {
          assert.throws(() => wrapped.send({ type, message: 'blocked' }), { code: 'workspace_revert_busy' });
          assert.equal((await post({ type, message: 'blocked' })).status, 503);
        }
        assert.deepEqual([writes.length, modelAccepted.length, activityAccepted.length], before);
      } finally { lease.release(); }
      wrapped.send({ type: 'prompt', message: 'released' });
      assert.equal(writes.length, before[0] + 1);
    });
    await check('C 渚涘簲鍟嗗彧璇诲悓姝ヤ笉闃绘柇 prompt锛屾ā鍨嬪畧鍗嫆缁濇椂浠嶄笉鍐欎笉璁拌处', () => {
      const initial = [writes.length, modelAccepted.length, activityAccepted.length];
      syncing = true;
      try { assert.equal(wrapped.send({ type: 'prompt', message: 'sync is read only' }), undefined); }
      finally { syncing = false; }
      const before = initial.map(count => count + 1);
      assert.deepEqual([writes.length, modelAccepted.length, activityAccepted.length], before);
      guardError = new Error('fixture guard');
      try { assert.throws(() => wrapped.send({ type: 'steer' }), error => error === guardError); }
      finally { guardError = null; }
      assert.deepEqual([writes.length, modelAccepted.length, activityAccepted.length], before);
    });
    await check('D 鍖呰灞傛妸 bridge 鐨勫仠姝?Promise 鍘熸牱杩斿洖锛堜笉鍚炪€佷笉鏇挎崲锛夛紝纭鍓嶄笉鍐?Pi', async () => {
      ack = deferred(); entered = deferred();
      const before = writes.length;
      const result = wrapped.send({ type: 'abort' });
      try {
        assert.equal(result, lastSendResult, '鍖呰灞備笉璁告崲鎺?Promise 韬唤');
        await entered.promise;
        assert.equal(writes.length, before, '娴忚鍣ㄦ病纭涔嬪墠涓€涓瓧鑺傞兘涓嶅啓');
      } finally { ack.resolve(); }
      assert.equal((await result).ok, true);
      assert.deepEqual(writes.slice(before).map((c) => c.type), ['clear_queue', 'abort']);
    });
  } finally {
    ack?.resolve(); stopped = true; raw.stop(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  const pub = path.join(ROOT, 'public');
  const dom = new JSDOM(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'),
    { url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, commands = [];
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  let commandReply;
  w.fetch = async (target, options) => {
    assert.equal(target, '/api/command');
    commands.push(JSON.parse(options.body));
    const body = await commandReply;
    return { ok: body.ok !== false, status: body.ok === false ? 503 : 200, json: async () => body };
  };
  // Real rpc.js -> api.sendCommand -> existing toast / shell status functions.
  const frontend = w.eval(bundle(path.join(pub, 'rpc.js')).code);
  const reset = () => {
    frontend.S.streaming = true; frontend.S.stopping = false; frontend.S.stopOwnedTurn = false;
    frontend.S.bridgeRun = 1; frontend.S.hasProject = true; frontend.S.bridgeState = 'ready';
    frontend.el.statusText.textContent = '姝ｅ湪澶勭悊'; frontend.el.toasts.replaceChildren(); commands.length = 0;
  };
  try {
    await check('鍓嶇锛氭祻瑙堝櫒纭澶辫触鏃剁姸鎬佹爮鍋滃湪銆屾鍦ㄥ仠姝⑩€︺€嶏紝鍙湁涓€鏉″畨鍏?toast', async () => {
      reset(); commandReply = { ok: false, code: 'browser_cancel_unconfirmed', error: '鍐呯疆娴忚鍣ㄥ彇娑堢‘璁や笉鍙敤' };
      const changes = [];
      const observer = new w.MutationObserver(records => changes.push(...records));
      observer.observe(frontend.el.statusText, { childList: true, characterData: true, subtree: true });
      try {
        await frontend.stop();
        /* 鐐瑰嚮閭ｄ竴鍒诲啓鐨勬槸銆屾鍦ㄥ仠姝⑩€︺€嶏紱澶辫触璺緞**涓嶈**鍐嶆敼瀹冿紙涔熸病鏈夈€屽凡璇锋眰鍋滄鈥︺€嶏級銆?*/
        assert.equal(frontend.el.statusText.textContent, '姝ｅ湪鍋滄鈥?);
        assert.equal(changes.length + observer.takeRecords().length, 1, '鐘舵€佹爮鍙琚啓涓€娆★紙鐐瑰嚮鏃讹級');
      } finally { observer.disconnect(); }
      assert.equal(frontend.S.stopping, true, 'Pi 渚ц繕娌＄‘璁わ紝蹇呴』淇濇寔淇濇姢');
      assert.equal(frontend.el.toasts.querySelectorAll('.toast.error').length, 1);
      assert.equal(frontend.el.toasts.textContent, '鍐呯疆娴忚鍣ㄥ彇娑堢‘璁や笉鍙敤');
      assert.equal(commands.length, 1); assert.equal(commands[0].type, 'abort');
    });
    await check('鍓嶇锛氭垚鍔熸椂鏄剧ず銆屽凡鍋滄銆嶈€屼笉鏄€屽凡璇锋眰鍋滄鈥︺€嶏紝涓斾笉鍐嶅寮?toast', async () => {
      reset(); commandReply = { ok: true, stop: { evidence: 'abort-response' } };
      await frontend.stop();
      assert.equal(frontend.el.statusText.textContent, '宸插仠姝?);
      assert.equal(frontend.S.stopping, false);
      assert.equal(frontend.S.streaming, false);
      assert.equal(frontend.el.toasts.children.length, 0);
      assert.equal(commands.length, 1);
    });
    await check('鍓嶇锛氱瓑寰呯‘璁ゆ湡闂村氨鏄剧ず銆屾鍦ㄥ仠姝⑩€︺€嶏紙涓嶆槸銆屽凡璇锋眰鍋滄鈥︺€嶏級', async () => {
      reset(); const pending = deferred(); commandReply = pending.promise;
      const stopping = frontend.stop();
      assert.equal(commands.length, 1);
      assert.equal(frontend.el.statusText.textContent, '姝ｅ湪鍋滄鈥?);
      assert.equal(frontend.S.stopping, true);
      pending.resolve({ ok: true, stop: { evidence: 'abort-response' } });
      await stopping;
      assert.equal(frontend.el.statusText.textContent, '宸插仠姝?);
    });
  } finally { w.close(); }
  console.log(`gui-browser-stop: ${passed}/${passed + failed} cases passed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
