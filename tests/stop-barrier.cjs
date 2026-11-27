/* Stop 璇箟锛堟潈濞佸仠姝㈠睆闅滐級鍥炲綊 鈥斺€?**娴嬫暣涓椂搴忥紝涓嶆槸鍙祴銆宻tdin 鏀跺埌浜?abort銆?*銆? *
 * 鏃ф祴璇曞彧鐪嬨€屽啓杩?stdin 鐨勫瓧鑺傞噷鏈?abort銆嶅氨缁夸簡锛屼簬鏄紡鎺変簡鐪熸鐨?bug锛? *
 *     prompt A 鈫?Stop锛堝啓浜?abort锛夆啋 HTTP 绔嬪埢 200 鈫?鐢ㄦ埛鍙?B
 *     鈫?鍓嶇杩樿涓哄湪璺戯紙S.streaming 浠嶄负 true锛夆啋 B 琚綋鎴?steer 鎺掕繘**鏃?run**
 *     鈫?鏃т换鍔＄户缁窇瀹岋紝鏂颁换鍔′篃琚悶杩涘幓
 *
 * 鎵€浠ヨ繖閲岀敤涓€棰楁ā鎷?Pi 鐨勫亣 RPC child锛屾妸銆宎bort 鍐欎笅鍘讳簡浣?Pi 杩樻病纭銆? * 閭ｄ竴娈?*鍋滀綇**锛屽湪閭ｄ竴娈甸噷灏濊瘯鍙戦€侊紝鏂█锛? *
 *   1. 鍚庣蹇呴』鎷掔粷 prompt / steer / follow_up锛堢ǔ瀹氶敊璇?stop_in_progress锛夛紝
 *      杩欎簺鍛戒护**涓€涓瓧鑺傞兘涓嶈兘杩?Pi 鐨?stdin**锛? *   2. 鍙湁鎷垮埌 Pi 鐨勬潈濞?abort 搴旂瓟锛堟垨 agent_settled 鍚庡洖璇荤‘璁?idle锛夋墠瑙ｉ櫎锛? *   3. 瓒呮椂涓嶈В闄?鈥斺€?灞忛殰缁х画鎸＄潃锛屽畞鍙殏鏃朵笉璁╁彂銆? *
 * 瑕嗙洊瀹樻柟濂戠害锛堟湰鏈?pi 1.0.2 鐨?docs/rpc-commands.md锛夛細
 *   - `abort` = 銆屼腑姝㈠綋鍓嶆搷浣?*骞剁瓑浼氳瘽鍙樼┖闂蹭箣鍚?*鎵嶅簲绛斻€? *   - `clear_queue` 蹇呴』鍦?abort **涔嬪墠**锛歛bort 浼氭妸杩樺湪闃熷垪閲岀殑
 *     steering / follow-up 缁х画璺戝畬
 *   - `agent_settled` 鏄細璇濈骇鐪熸缁撴潫鐨勬潈濞佷簨浠讹紙瑙勫垯鍚?server/pi-activity.js锛? */
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
const PUB = path.join(ROOT, 'public');

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

/* ---------- 妯℃嫙 Pi 鐨?RPC child ----------
 *
 * 鍙疄鐜版湰娴嬭瘯鐢ㄥ埌鐨勯偅鍑犳潯鍛戒护鐨?*瀹樻柟搴旂瓟褰㈢姸**锛? *   get_state   鈫?data.isStreaming / isCompacting / pendingMessageCount
 *   clear_queue 鈫?data.{steering,followUp}锛涙棫 pi 璧?rpc-mode 鐨?default 鍒嗘敮鍥? *                 "Unknown command: clear_queue"
 *   abort       鈫?鐢辩敤渚嬪喅瀹氫綍鏃跺洖銆佹垚鍔熻繕鏄け璐ワ紙杩欐槸鏈枃浠剁殑涓昏锛? * 鍏朵綑涓€寰嬭杩?writes锛屼緵鏂█銆屾湁娌℃湁鐪熺殑鍐欒繘 pi銆嶃€? */
function createFakePi() {
  const writes = [];
  const child = new EventEmitter();
  child.pid = 5150;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  const state = {
    streaming: false,
    queueMode: 'ok',      // ok | unsupported | silent
    abortMode: 'manual',  // manual | respond | settle-then-respond | respond-then-settle | fail | silent
    pendingAbort: null,
  };
  const emit = (msg) => child.stdout.emit('data', JSON.stringify(msg) + '\n');
  const respond = (cmd, data, success = true, error = undefined) => {
    const msg = { id: cmd.id, type: 'response', command: cmd.type, success };
    if (success) msg.data = data ?? {};
    else msg.error = error;
    emit(msg);
  };
  const settle = () => { state.streaming = false; emit({ type: 'agent_settled' }); };

  function handle(cmd) {
    switch (cmd.type) {
      case 'get_state':
        return respond(cmd, { isStreaming: state.streaming, isCompacting: false, pendingMessageCount: 0, sessionId: 'fixture' });
      case 'clear_queue':
        if (state.queueMode === 'unsupported') return respond(cmd, null, false, 'Unknown command: clear_queue');
        if (state.queueMode === 'silent') return undefined;
        return respond(cmd, { steering: [], followUp: [] });
      case 'abort':
        switch (state.abortMode) {
          case 'silent': return undefined;
          case 'fail': return respond(cmd, null, false, 'fixture abort failure');
          case 'respond': state.streaming = false; return respond(cmd, {});
          case 'settle-then-respond':
            /* 瀹樻柟瀹炵幇閲?agent_settled 閭ｆ潯 stdout 璁板綍**鍏?*浜?abort 搴旂瓟鍐欏嚭
             * 锛坅gent-session.ts 鐨?_emitAgentSettled 鍏?emit 浜嬩欢銆佸啀 resolve idle锛夈€?*/
            settle();
            return setTimeout(() => respond(cmd, {}), 5);
          case 'respond-then-settle':
            respond(cmd, {});
            return setTimeout(settle, 5);
          default:
            state.pendingAbort = cmd;
            return undefined;
        }
      case 'prompt':
        state.streaming = true;
        emit({ type: 'agent_start' });
        return undefined;
      case 'steer':
      case 'follow_up':
        return undefined;
      default:
        return respond(cmd, null, false, 'Unknown command: ' + cmd.type);
    }
  }

  child.stdin = {
    destroyed: false,
    writable: true,
    writableEnded: false,
    on() {},
    end() { this.writableEnded = true; },
    write(line) {
      const cmd = JSON.parse(line);
      writes.push(cmd);
      setImmediate(() => handle(cmd));
      return true;
    },
  };
  return {
    child, writes, state,
    settle,
    /** 鑴氭湰鍖栨ā寮忎箣澶栫殑鐢ㄤ緥鑷繁鍐冲畾浣曟椂鍥?abort銆?*/
    respondAbort() {
      const cmd = state.pendingAbort;
      assert.ok(cmd, 'fake pi 娌℃湁寰呭洖鐨?abort');
      state.pendingAbort = null;
      state.streaming = false;
      respond(cmd, {});
    },
    // Re-deliver an already acknowledged abort to simulate a delayed/duplicate
    // RPC frame from an older Stop while a newer Stop is pending.
    emitAbortResponse(cmd) { respond(cmd, {}); },
  };
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
  const { createSessionRevertStopAndDrain } = await import('../server/session-revert-object-runtime-authority.js');
  const { createSessionRevertAdmission } = await import('../server/session-revert-admission.js');
  const { createCollabStore } = await import('../server/collab-store.js');
  const { createCollabAuthority } = await import('../server/collab-authority.js');
  const { createCollabService } = await import('../server/collab-service.js');
  const { createCollabProposalSource } = await import('../server/collab-proposal-source.js');
  const { createProposalQueue } = await import('../server/collab-proposal-queue.js');
  const { createCollabRoutes } = await import('../server/collab-routes.js');
  const { createMessageEditRoutes } = await import('../server/message-edit-routes.js');
  const { createMessageEditService } = await import('../server/message-edit.js');

  const cwd = os.tmpdir();
  const pi = createFakePi();
  let serverStopped = false;
  const published = [];
  const raw = createRpcBridge({
    runtime: { getCurrentCwd: () => cwd, isShuttingDown: () => serverStopped },
    publish: (evt) => published.push(evt),
    piBin: 'fixture-pi', isWin: false, env: {},
    spawnProcess: () => pi.child,
    /* 缂╃煭绛夊緟锛氱敓浜ф槸 30s锛岃繖閲?120ms 鈥斺€?璇箟涓€妯′竴鏍凤紝鍙槸鍒娴嬭瘯鐧界瓑銆?*/
    stopTimeoutMs: 120,
  });
  await raw.start();

  /* 璺敱鐢?*鐢熶骇鐨勯偅涓€娈佃閰?*锛堜粠 server.js 閲屽師鏍峰彇鍑烘潵璺戯級锛屼笉鍙︽妱涓€浠?wrapper
   * 鈥斺€?鎶勪竴浠藉氨绛変簬娴嬩簡涓豢鍒跺搧銆傝繖涓€娈甸噷鐜板湪鏈?abortAndWait 鐨勫墠缃畧鍗笌璁拌处銆?*/
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = source.indexOf('const environmentRoutes = createEnvironmentRoutes({');
  // Router composition ends before the independent app-update HTTP wrapper.
  const end = source.indexOf('\nconst updateMaintenance = createAppUpdateMaintenance({', start);
  assert.ok(start >= 0 && end > start, 'server.js Router assembly must be found');
  let syncing = false, workspaceGate = null, captureGate = null, admissionEntered = false;
  const guarded = [], modelAccepted = [], activityAccepted = [];
  const context = {
    // Construct the actual lazy comment dependencies; this Stop-only fixture
    // never enters their routes and must not hide production assembly drift.
    createReviewCommentStore, createReviewCommentAuthority, createReviewCommentRoutes,
    createCollabStore, createCollabAuthority, createCollabService, createCollabRoutes,
    createCollabProposalSource, createProposalQueue,
    createEnvironmentRoutes,
    /* 鐢熶骇瑁呴厤鐜板湪涔熸瀯閫犲巻鍙叉秷鎭紪杈戣矾鐢变笌 collab 鐨勭紪杈戦椄闂ㄣ€傛湰 fixture
     * 涓嶈繘鍏ョ紪杈戞垨 collab 鐢熸垚锛屼絾浣跨敤鐪熷疄宸ュ巶淇濇寔鐢熶骇褰㈢姸锛屼笉璁?VM 鐨?     * 闅愬紡鍏ㄥ眬鎺╃洊瑁呴厤寮曠敤婕傜Щ銆?*/
    createMessageEditRoutes,
    messageEditService: createMessageEditService(),
    messageEditLaunch: { command: () => null, token: () => null },
    primaryNativeSession: null,
    desktopEnvironment: false,
    environmentSetup: { check: async () => ({ requiredReady: false }) },
    environmentInstall: { getJob: () => null },
    invalidatePiCaches() {},
    // No candidate exists in this Stop facade fixture. Its independent real
    // lifecycle is covered by candidate-runs and normal-sandbox Electron.
    createCandidateRuns: () => ({busy: () => false}), createCandidateRoutes: () => null, candidateRunsRef: null,
    DATA_DIR: os.tmpdir(), MODELS_JSON: path.join(os.tmpdir(), 'fixture-agent', 'models.json'), __dirname: ROOT,
    path, process: { env: {} }, runningInSea: false, createSystemStorage,
    withWorkspaceIdentity: (...args) => context.conversationWorkspaces.withWorkspace(...args),
    createSessionRevertRoutes, createSessionRevertAuthority, createSessionRevertMutationAuthority, createSessionRevertStopAndDrain,
    mutationAdmission: createSessionRevertAdmission(), getEvidenceStore: async () => { throw Error('fixture evidence unavailable'); },
    managedProcesses: { manager: null }, worktrees: { async validateCurrent() { if (workspaceGate) { admissionEntered = true; await workspaceGate; } } }, specs: null,
    extensionPackages: null, extensionMarket: null,
    /* Stop-only facade fixture; Files/Terminal have their own route suites. */
    files: null, terminal: null,
    /* 璺敱瑁呴厤鎶婄粡鍏镐細璇濆拰鏅€氶」鐩粺涓€浜ょ粰 conversationWorkspaces銆?     * 鏈敤渚嬩笉杩涘叆 revert 璺敱锛屼絾蹇呴』鎻愪緵鐪熷疄褰㈢姸锛岄伩鍏嶇敓浜у紩鐢ㄦ紓绉昏
     * VM 鐨勯殣寮忓叏灞€鎺╃洊銆?*/
    conversationWorkspaces: { withWorkspace: () => {
      throw Object.assign(Error('fixture_workspace_unavailable'), { code: 'unknown_workspace' });
    } },
    logging: null,
    createRouter(options) { return createRouter(options); },
    rpc: raw,
    auth: { denyRequest: () => null },
    sse: {},
    providerAuth: { snapshot: () => ({ sync: { state: syncing ? 'syncing' : 'idle' } }) },
    providerManagement: null,
    modelGeneration: {
      guardCommand(command) { guarded.push(command); },
      noteCommandAccepted: (command) => modelAccepted.push(command),
    },
    piActivity: { noteCommandAccepted: (command) => activityAccepted.push(command) },
    primaryToolGuard: { resume() {} },
    observeClassicSubmission() {},
    serveClassicExecutionHistory() { assert.fail('Stop test routed to execution history'); },
    createSessionExport: () => null,
    runtime: { getCurrentCwd: () => cwd },
    sessionChanges: { assertReady: async () => { if (captureGate) { admissionEntered = true; await captureGate; } }, disable: async () => ({ ok: true }) },
    piLaunch: { packageDir: () => null },
  };
  for (const name of ['providers', 'projects', 'projectConfig', 'skills', 'mcp', 'mcpNative', 'mcpManager',
    'approvalProbe', 'extensions', 'sessions', 'sessionSearch', 'sessionTitles', 'planner', 'gitRoutes',
    'uploads', 'diagnostics', 'updateCheck', 'piUpdate', 'capabilityInstall', 'quota', 'piCompat']) context[name] = {};
  Object.assign(context, { runtimeRoutes: null, htmlArtifacts: null, primaryOwner: () => null, runtimeRegistry: { liveCount: () => 0 } });
  const route = vm.runInNewContext(source.slice(start, end) + '\nroute;', context);

  const server = http.createServer(route);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (command) => {
    const response = await fetch(origin + '/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    });
    return { status: response.status, body: await response.json() };
  };
  const status = async () => (await fetch(origin + '/api/status')).json();
  const has = (predicate) => pi.writes.some(predicate);
  const resetLog = () => { pi.writes.length = 0; };

  try {
    /* ================= 鏍稿績鏃跺簭锛氬睆闅滅湡鐨勬尅浣忔柊鍛戒护 ================= */

    await check('1. 鍋滄鏈‘璁ゆ湡闂达紝prompt / steer / follow_up 鍏ㄩ儴琚悗绔嫆缁濓紝涓斾笉杩?Pi stdin', async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      assert.deepEqual(await post({ type: 'prompt', message: 'A' }), { status: 200, body: { ok: true } });
      await waitFor('prompt A 鍒拌揪 Pi', () => has((c) => c.type === 'prompt'));

      /* 闀夸换鍔℃鍦ㄨ窇锛岀敤鎴风偣 Stop銆俛bort 搴旂瓟**鏁呮剰鎵ｄ綇**锛屾ā鎷熴€屽啓涓嬪幓浜嗕絾杩樻病鍋溿€嶃€?*/
      const stopping = post({ type: 'abort' });
      await waitFor('clear_queue / abort 鍒拌揪 Pi', () => has((c) => c.type === 'abort'));

      const before = pi.writes.length;
      for (const type of ['prompt', 'steer', 'follow_up']) {
        const result = await post({ type, message: 'B' });
        assert.equal(result.status, 503, `${type} 蹇呴』琚嫆缁漙);
        assert.equal(result.body.ok, false);
        assert.equal(result.body.code, 'stop_in_progress', `${type} 蹇呴』鏄ǔ瀹氶敊璇爜`);
      }
      assert.equal(pi.writes.length, before, '琚嫆缁濈殑鍛戒护涓€涓瓧鑺傞兘涓嶈杩?Pi 鐨?stdin');
      assert.ok(!has((c) => c.message === 'B'), 'Pi 涓嶈兘鐪嬪埌 B');
      assert.equal((await status()).stop?.pending, true, '灞忛殰蹇呴』鍦?/api/status 閲岀湅寰楄');

      /* 绛夎繃 abort 搴旂瓟瓒呮椂锛欻TTP 鎶?stop_unconfirmed锛屼絾**灞忛殰涓嶈瑙ｉ櫎**銆?*/
      const timedOut = await stopping;
      assert.equal(timedOut.status, 503);
      assert.equal(timedOut.body.code, 'stop_unconfirmed');
      assert.match(timedOut.body.error, /鍋滄灏氭湭寰楀埌 Pi 纭/);
      assert.equal((await status()).stop?.pending, true, '瓒呮椂鍚庡睆闅滀粛鍦?);
      const late = await post({ type: 'prompt', message: 'B' });
      assert.equal(late.body.code, 'stop_in_progress', '瓒呮椂鍚庝粛鐒朵笉璁稿彂');
      assert.ok(!has((c) => c.message === 'B'));

      /* 鏉冨▉ abort 搴旂瓟姝ゅ埢鎵嶅埌 鈥斺€?瀹冨悓鏍锋槸缁堟淇″彿锛屼笉鑳藉洜涓烘湰鍦版斁寮冧簡灏变笉璁ゃ€?*/
      pi.respondAbort();
      await waitFor('灞忛殰瑙ｉ櫎', () => !raw.stopState());
      assert.equal(raw.stopState(), null);

      const after = await post({ type: 'prompt', message: 'B' });
      assert.deepEqual(after, { status: 200, body: { ok: true } });
      const sent = pi.writes.filter((c) => c.message === 'B');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'prompt', 'Stop 涔嬪悗鐨勬柊浠诲姟蹇呴』鏄湡姝ｇ殑 prompt锛屼笉鑳芥槸 steer');
      assert.ok(!has((c) => c.type === 'steer'), '鏁存鏃跺簭閲屼笉璇ュ嚭鐜颁换浣?steer');
    });

    await check('2. clear_queue 鎺掑湪 abort 涔嬪墠锛堝畼鏂归『搴忥細鍏堟竻闃熷垪鍐嶄腑姝級', async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      await post({ type: 'prompt', message: 'A' });
      /* Stop 涔嬪墠宸茬粡鏈夋帓闃熺殑 steering / follow-up锛坅bort 浼氭妸瀹冧滑缁х画璺戝畬锛夈€?*/
      await post({ type: 'steer', message: '鏀规柟鍚? });
      await post({ type: 'follow_up', message: '鍋氬畬鍐嶈' });
      const stopping = post({ type: 'abort' });
      await waitFor('abort 鍒拌揪 Pi', () => has((c) => c.type === 'abort'));
      const order = pi.writes.map((c) => c.type);
      assert.ok(order.indexOf('steer') < order.indexOf('clear_queue'), 'clear_queue 蹇呴』鍦ㄦ帓闃熸秷鎭箣鍚?);
      assert.ok(order.indexOf('clear_queue') < order.indexOf('abort'), 'clear_queue 蹇呴』鍦?abort 涔嬪墠');
      assert.equal(raw.stopState().queue, 'cleared', 'clear_queue 鐨勫缃濡傚疄璁板綍');
      pi.respondAbort();
      const result = await stopping;
      assert.equal(result.status, 200);
      await waitFor('灞忛殰瑙ｉ櫎', () => !raw.stopState());
    });

    await check('3. abort 搴旂瓟鍏堝埌 鈫?浠?abort-response 瑙ｉ櫎锛涢殢鍚庣殑 agent_settled 涓嶄骇鐢熼敊璇姸鎬?, async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      const stopping = post({ type: 'abort' });
      await waitFor('abort 鍒拌揪 Pi', () => has((c) => c.type === 'abort'));
      pi.respondAbort();
      const result = await stopping;
      assert.deepEqual(result, { status: 200, body: { ok: true, stop: { evidence: 'abort-response', queue: 'cleared' } } });
      /* 搴旂瓟涔嬪悗鎵嶅埌鐨?agent_settled锛氬彧鏄櫘閫氫簨浠讹紝涓嶈鍐嶆敼浠€涔堛€?*/
      pi.settle();
      await sleep(20);
      assert.equal(raw.stopState(), null);
      assert.deepEqual(await post({ type: 'prompt', message: 'C' }), { status: 200, body: { ok: true } });
    });

    await check('4. agent_settled 鍏堝埌 鈫?鍥炶 get_state 纭 idle 鎵嶈В闄わ紙evidence = agent-settled-idle锛?, async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      const stopping = post({ type: 'abort' });
      await waitFor('abort 鍒拌揪 Pi', () => has((c) => c.type === 'abort'));
      /* 鍙彂 agent_settled銆?*涓嶅洖** abort 搴旂瓟锛氬繀椤昏兘闈犮€屼簨浠?+ 鍥炶銆嶆敹鍙ｃ€?*/
      pi.settle();
      const result = await stopping;
      assert.equal(result.status, 200);
      assert.equal(result.body.stop.evidence, 'agent-settled-idle', 'abort 搴旂瓟娌℃潵锛屽彧鍙兘鏄洖璇荤‘璁ょ殑');
      assert.ok(has((c) => c.type === 'get_state'), '蹇呴』鍥炶涓€娆?get_state 鎵嶆暍瑙ｉ櫎');
      assert.equal(published.filter((e) => e.type === 'stop_state' && e.evidence === 'agent-settled-idle').length, 1,
        '杩欐潯璺緞鐨勮В闄や篃瑕佸箍鎾嚭鍘伙紙SSE锛?);
    });

    await check('5. abort 搴旂瓟澶辫触 鈫?涓嶅绉版垚鍔燂紝灞忛殰缁х画鎸＄潃', async () => {
      resetLog();
      pi.state.abortMode = 'fail';
      const result = await post({ type: 'abort' });
      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'stop_unconfirmed');
      assert.equal(raw.stopState()?.pending, true, 'abort 鏄庣‘澶辫触涔熶笉鑳借В闄?);
      const blocked = await post({ type: 'prompt', message: 'B' });
      assert.equal(blocked.body.code, 'stop_in_progress');
      /* 鎭㈠锛歅i 鑷繁 settle 浜嗭紙鍥炶纭 idle锛夋墠鏀捐銆?*/
      pi.state.abortMode = 'manual';
      pi.settle();
      await waitFor('灞忛殰瑙ｉ櫎', () => !raw.stopState());
      assert.deepEqual(await post({ type: 'prompt', message: 'B' }), { status: 200, body: { ok: true } });
    });

    await check('6. clear_queue 涓嶈鏀寔锛堟棫 Pi锛夆啋 鏄庣‘闄嶇骇锛宎bort 涓庡睆闅滅収鏃?, async () => {
      resetLog();
      pi.state.queueMode = 'unsupported';
      pi.state.abortMode = 'manual';
      const stopping = post({ type: 'abort' });
      await waitFor('abort 鍒拌揪 Pi', () => has((c) => c.type === 'abort'));
      assert.equal(raw.stopState().queue, 'unsupported', '涓嶈璇嗚繖鏉″懡浠よ濡傚疄璁颁负 unsupported');
      const blocked = await post({ type: 'steer', message: 'B' });
      assert.equal(blocked.body.code, 'stop_in_progress');
      pi.respondAbort();
      const result = await stopping;
      assert.equal(result.status, 200);
      assert.equal(result.body.stop.queue, 'unsupported');
      pi.state.queueMode = 'ok';
    });

    await check('7. 杩炵画鐐?Stop锛氬彧鍐欏嚭涓€娆?clear_queue / abort锛岀浜屾澶嶇敤鍚屼竴涓瓑寰?, async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      const first = post({ type: 'abort' });
      await waitFor('abort 鍒拌揪 Pi', () => has((c) => c.type === 'abort'));
      const second = post({ type: 'abort' });
      await sleep(30);
      assert.equal(pi.writes.filter((c) => c.type === 'abort').length, 1, '涓嶈兘鏈夌浜屾潯 abort');
      assert.equal(pi.writes.filter((c) => c.type === 'clear_queue').length, 1, '涓嶈兘鏈夌浜屾潯 clear_queue');
      pi.respondAbort();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200, '绗簩娆?Stop 涔熻鎷垮埌鏉冨▉缁撹锛堝鐢ㄥ悓涓€娆″仠姝級');
      assert.equal(raw.stopState(), null);
    });

    await check('7b. 鏃?Stop 鐨勮繜鍒?abort 鎴愬姛搴旂瓟涓嶅緱瑙ｉ櫎鏂?Stop 鐨勫睆闅?, async () => {
      resetLog();
      pi.state.abortMode = 'manual';
      const first = post({ type: 'abort' });
      await waitFor('绗竴杞?abort 鍒拌揪 Pi', () => has(c => c.type === 'abort'));
      const firstAbort = pi.writes.find(c => c.type === 'abort');
      pi.respondAbort();
      assert.equal((await first).status, 200);

      const second = post({ type: 'abort' });
      await waitFor('绗簩杞?abort 鍒拌揪 Pi', () => pi.writes.filter(c => c.type === 'abort').length === 2);
      const secondAbort = pi.writes.filter(c => c.type === 'abort')[1];
      assert.notEqual(secondAbort.id, firstAbort.id, '涓ゆ鍋滄蹇呴』鏈変笉鍚岀殑鍐呴儴璇锋眰 ID');

      // First abort has already completed. Its duplicate acknowledgement
      // cannot prove that the newly pending abort has finished.
      pi.emitAbortResponse(firstAbort);
      await sleep(20);
      assert.equal(raw.stopState()?.pending, true, '鏃у洖澶嶄笉寰楄В闄ゆ柊灞忛殰');
      const blocked = await post({ type: 'prompt', message: 'blocked after old abort reply' });
      assert.equal(blocked.body.code, 'stop_in_progress');
      assert.ok(!has(c => c.message === 'blocked after old abort reply'));
      pi.respondAbort();
      assert.equal((await second).status, 200);
      await waitFor('绗簩杞睆闅滄甯歌В闄?, () => !raw.stopState());
    });

    await check('8. 渚涘簲鍟嗗彧璇诲悓姝ユ湡闂翠粛鑳藉畬鎴愭潈濞佸仠姝㈠睆闅?, async () => {
      resetLog();
      const before = [guarded.length, modelAccepted.length, activityAccepted.length];
      syncing = true;
      try {
        pi.state.abortMode = 'manual';
        const stopping = post({ type: 'abort' });
        await waitFor('鍚屾鏈熼棿鐨?abort 鍒拌揪 Pi', () => has(c => c.type === 'abort'));
        assert.equal(raw.stopState()?.pending, true);
        pi.respondAbort();
        const result = await stopping;
        assert.equal(result.status, 200);
        assert.equal(result.body.stop.evidence, 'abort-response');
      } finally { syncing = false; }
      assert.equal(raw.stopState(), null, 'Pi 纭鍚庡簲瑙ｉ櫎灞忛殰');
      assert.deepEqual(pi.writes.map(command => command.type), ['clear_queue', 'abort']);
      assert.deepEqual([guarded.length, modelAccepted.length, activityAccepted.length], before.map(count => count + 1));
    });

    for (const phase of ['workspace', 'capture']) await check('8b. 瀹屾暣 Stop 璺ㄨ繃 Classic ' + phase + ' 绛夊緟鍚庯紝鏃ц緭鍏ヤ笉澶嶆椿锛屾柊杈撳叆鍙彂閫佷竴娆?, async () => {
      resetLog(); const gate = deferred(); admissionEntered = false;
      if (phase === 'workspace') workspaceGate = gate.promise; else captureGate = gate.promise;
      const input = { type: 'prompt', message: 'KEEP_AFTER_STOP_' + phase };
      let waiting;
      try {
        waiting = post(input); await waitFor('寮傛鍑嗗叆宸茶繘鍏?, () => admissionEntered);
        pi.state.abortMode = 'respond'; const stopped = await post({ type: 'abort' });
        assert.equal(stopped.status, 200); assert.equal(raw.stopState(), null);
        workspaceGate = captureGate = null; gate.resolve();
        const rejected = await waiting; assert.equal(rejected.status, 503); assert.equal(rejected.body.code, 'stale_runtime');
        assert.equal(pi.writes.filter(cmd => cmd.message === input.message).length, 0);
        const fresh = await post(input); assert.equal(fresh.status, 200);
        assert.equal(pi.writes.filter(cmd => cmd.message === input.message).length, 1);
        assert.equal((await post({ type: 'abort' })).status, 200);
      } finally { workspaceGate = captureGate = null; gate.resolve(); await waiting; }
    });

    /* 鏀惧湪鏈€鍚庯細瀹冪湡鐨勪細鎶?bridge 鎵撴崲浠ｏ紝涔嬪悗鐨勭敤渚嬩笉鍐嶄緷璧栬繖棰?child銆?*/
    await check('9. bridge 鎹唬锛堥噸鍚?Pi / 鎹㈠伐浣滃尯锛夆啋 灞忛殰闅忔墜浣滃簾锛屼笉浼氭妸鐣岄潰姘镐箙閿佹', async () => {
      resetLog();
      pi.state.abortMode = 'silent';
      const stopping = post({ type: 'abort' });
      await waitFor('abort 鍒拌揪 Pi', () => has((c) => c.type === 'abort'));
      assert.equal((await post({ type: 'prompt', message: 'B' })).body.code, 'stop_in_progress');
      raw.restart();
      const result = await stopping;
      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'stop_reset', '鎹唬涓嶆槸銆孭i 纭鍋滄銆嶏紝瑕佸瀹炲垎寮€');
      assert.equal(raw.stopState(), null, '灞忛殰蹇呴』闅忔崲浠ｈВ闄?);
    });

    /* ================= 鍓嶇锛歴topping 鏄嫭绔嬩簬 streaming 鐨勭涓夋€?=================
     *
     * 杩欓噷鍙埌 rpc.js 閭ｄ竴灞傦紙stop / submit / state / messages锛夈€俛pp.js 鐨勮閰?     * 锛堟寜閽?onclick銆丒nter 閿€乻top_state 鐨?SSE 鍒嗗彂锛夊湪 tests/smoke.cjs 閲屾祴 鈥斺€?     * 閭ｄ竴浠芥墠鏈夌湡瀹炵殑 index.html + app.js銆?*/

    const dom = new JSDOM(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'),
      { url: 'http://localhost:7788', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.ResizeObserver = class { observe() {} disconnect() {} };
    const commands = [];
    let reply = { ok: true };
    w.fetch = async (target, options) => {
      commands.push({ target, body: JSON.parse(options.body) });
      const body = await (typeof reply === 'function' ? reply() : reply);
      if (body?.__network) throw new Error('fixture network down');
      return { ok: body.ok !== false, status: body.ok === false ? 503 : 200, json: async () => body };
    };
    const frontend = w.eval(bundle(path.join(PUB, 'rpc.js')).code);

    const ready = (streaming = true) => {
      frontend.S.streaming = streaming;
      frontend.S.stopping = false;
      frontend.S.stopOwnedTurn = false;
      frontend.S.bridgeRun = 1;
      frontend.S.hasProject = true;
      frontend.S.switching = false;
      frontend.S.bridgeState = 'ready';
      frontend.S.submitting = false;
      frontend.S.attachments = [];
      frontend.el.input.value = '鍑嗗鍙戦€?;
      frontend.el.statusText.textContent = '姝ｅ湪澶勭悊';
      frontend.el.toasts.replaceChildren();
      frontend.updateSendState();
      commands.length = 0;
    };
    const abortCalls = () => commands.filter((c) => c.body?.type === 'abort').length;
    const sentOf = (type) => commands.filter((c) => c.body?.type === type);

    try {
      await check('10. 鐐?Stop 绔嬪嵆杩涘叆 stopping锛氬彂閫侀敭绂佺敤銆佺姸鎬佹槸銆屾鍦ㄥ仠姝⑩€︺€?, async () => {
        ready(); const pending = deferred(); reply = pending.promise;
        assert.equal(frontend.el.btnSend.disabled, false, '鍓嶆彁锛氬仠姝箣鍓嶅彂閫侀敭鏄彲鐢ㄧ殑');
        const stopping = frontend.stop();
        assert.equal(frontend.S.stopping, true);
        assert.equal(frontend.el.btnSend.disabled, true);
        assert.equal(frontend.el.statusText.textContent, '姝ｅ湪鍋滄鈥?);
        assert.equal(abortCalls(), 1);
        pending.resolve({ ok: true, stop: { evidence: 'abort-response' } });
        await stopping;
      });

      await check('11. 鍋滄鏈畬鎴愭椂锛歴ubmit 涓嶅彂閫併€佸啀鐐?Stop 涓嶉噸鍙戙€佽緭鍏ョ殑瀛楃暀鐫€', async () => {
        ready(); const pending = deferred(); reply = pending.promise;
        const stopping = frontend.stop();
        const before = commands.length;
        frontend.el.input.value = 'B';
        await frontend.submit();
        await frontend.stop();
        assert.equal(commands.length, before, '鍋滄鏈熼棿涓€涓懡浠ら兘涓嶈鍙戝嚭鍘?);
        assert.equal(abortCalls(), 1, '绗簩娆?Stop 涓嶈兘閲嶅彂 abort');
        pending.resolve({ ok: true, stop: { evidence: 'abort-response' } });
        await stopping;
        assert.equal(frontend.el.input.value, 'B', '杈撳叆妗嗛噷鐨勫瓧瑕佺暀鐫€锛堝彧鏄笉璁╂彁浜わ級');
      });

      await check('12. agent_settled 鍏堝埌涓嶈В闄?stopping锛泂top_state 浜嬩欢鎵嶆敹鍙?, async () => {
        ready(); const pending = deferred(); reply = pending.promise;
        const stopping = frontend.stop();
        frontend.onSettled();
        assert.equal(frontend.S.stopping, true, 'agent_settled 涓嶆槸鍋滄纭');
        assert.equal(frontend.el.statusText.textContent, '姝ｅ湪鍋滄鈥?);
        /* HTTP 瓒呮椂锛氱晫闈㈡槑璇磋繕娌″緱鍒扮‘璁わ紝**淇濇寔淇濇姢**銆?*/
        pending.resolve({ ok: false, code: 'stop_unconfirmed', error: '鍋滄灏氭湭寰楀埌 Pi 纭锛岃绛夊緟鎴栭噸鍚?Pi銆? });
        await stopping;
        assert.equal(frontend.S.stopping, true);
        assert.match(frontend.el.statusText.textContent, /鍋滄灏氭湭寰楀埌 Pi 纭/);
        assert.equal(frontend.el.btnSend.disabled, true);
        /* 灞忛殰绋嶅悗鎵嶈В闄?鈥斺€?鐢卞悗绔箍鎾殑 stop_state 鏀跺彛銆?*/
        frontend.onStopState({ state: 'stopped', evidence: 'abort-response' });
        assert.equal(frontend.S.stopping, false);
        assert.equal(frontend.S.streaming, false);
        assert.equal(frontend.el.statusText.textContent, '宸插仠姝?);
        /* SSE 骞挎挱 pending:true 鍚屾牱杩涘叆 stopping 淇濇姢骞剁敱 stopped 鏀跺彛 */
        frontend.onStopState({ state: 'stopping', pending: true });
        assert.equal(frontend.S.stopping, true);
        assert.equal(frontend.el.statusText.textContent, '姝ｅ湪鍋滄鈥?);
        frontend.onStopState({ state: 'stopped', evidence: 'abort-response' });
        assert.equal(frontend.S.stopping, false);
        assert.equal(frontend.el.statusText.textContent, '宸插仠姝?);
        /* 鏂嚎閲嶈繛琛ュ彂鐨勫巻鍙蹭簨浠朵笉璁稿啓鐘舵€併€?*/
        frontend.el.statusText.textContent = '';
        frontend.onStopState({ state: 'stopped', evidence: 'abort-response', _replay: true });
        assert.equal(frontend.el.statusText.textContent, '');
      });

      await check('13. HTTP 搴旂瓟鍏堝埌锛歛bort 搴旂瓟淇濊瘉宸茬┖闂诧紝涓嬩竴鏉℃秷鎭蛋 prompt 鑰屼笉鏄?steer', async () => {
        ready(); reply = { ok: true, stop: { evidence: 'abort-response' } };
        await frontend.stop();
        assert.equal(frontend.S.stopping, false);
        assert.equal(frontend.S.streaming, false, 'abort 搴旂瓟 = 浼氳瘽宸茬┖闂诧紝涓嶅繀绛?agent_settled');
        assert.equal(frontend.el.statusText.textContent, '宸插仠姝?);
        commands.length = 0;
        frontend.el.input.value = '鍦ㄩ」鐩噷鍒涘缓涓€涓?hello.txt';
        await frontend.submit();
        const sent = sentOf('prompt');
        assert.equal(sent.length, 1, 'Stop 瀹屾垚鍚庡繀椤绘槸 prompt');
        assert.equal(sentOf('steer').length, 0);
      });

      await check('14. 鎹㈠伐浣滃尯 / bridge 鎹唬锛氭棫鍋滄浣滃簾锛岃繜鍒板簲绛斾笉鍐嶅啓鐘舵€?, async () => {
        ready(); const pending = deferred(); reply = pending.promise;
        const stopping = frontend.stop();
        frontend.beginWorkspaceSwitch('/other');
        assert.equal(frontend.S.stopping, false, '鎹㈠伐浣滃尯蹇呴』瑙ｉ櫎 stopping');
        pending.resolve({ ok: true, stop: { evidence: 'abort-response' } });
        await stopping;
        assert.notEqual(frontend.el.statusText.textContent, '宸插仠姝?, '杩熷埌鐨勬棫鍋滄涓嶈鍐欐柊宸ヤ綔鍖虹殑鐘舵€?);

        ready(); const second = deferred(); reply = second.promise;
        const again = frontend.stop();
        frontend.invalidateStop();
        assert.equal(frontend.S.stopping, false, 'bridge 鐢熷懡鍛ㄦ湡鍙樹簡瑕佽В闄?stopping');
        second.resolve({ ok: true, stop: { evidence: 'abort-response' } });
        await again;
      });

      await check('15. 缃戠粶澶辫触 = 娌￠棶鍒帮紝涓嶇畻鍋滄瀹屾垚', async () => {
        ready(); reply = { __network: true };
        await frontend.stop();
        assert.equal(frontend.S.stopping, true, '娌￠棶鍒板悗绔氨蹇呴』淇濇寔淇濇姢');
        assert.equal(frontend.el.btnSend.disabled, true);
      });

      await check('16. 鐢ㄦ埛涓诲姩鍋滄鐨勪腑鏂秷鎭寜涓€х姸鎬佸憟鐜帮紱闈炴湰娆″仠姝㈢殑鍙栨秷鐓ф棫鎶ラ敊', async () => {
        const render = (msg) => {
          const body = w.document.createElement('div');
          frontend.rebuildAssistant(body, msg);
          return body;
        };
        frontend.S.stopOwnedTurn = true;
        const owned = render({ role: 'assistant', content: [{ type: 'text', text: '鍗婂彞' }], stopReason: 'aborted', errorMessage: '璇锋眰宸插彇娑? });
        assert.equal(owned.querySelector('.msg-note')?.textContent, '宸茬敱鐢ㄦ埛鍙栨秷');
        assert.equal(owned.querySelector('.msg-err'), null, '鏈鍋滄涓嶈兘娓叉煋鎴愰敊璇?);

        /* 褰掑睘鍙睘浜庨偅涓€杞?run锛氭柊涓€杞竴寮€濮嬪氨澶辨晥銆?*/
        frontend.setStreaming(true);
        assert.equal(frontend.S.stopOwnedTurn, false);
        const unowned = render({ role: 'assistant', content: [{ type: 'text', text: '鍗婂彞' }], stopReason: 'aborted', errorMessage: '璇锋眰宸插彇娑? });
        assert.ok(unowned.querySelector('.msg-err'), '涓嶆槸鏈鍋滄鐨勫彇娑堝繀椤荤収甯告樉绀洪敊璇?);
        assert.equal(unowned.querySelector('.msg-note'), null);

        /* 娌℃湁褰掑睘銆佷篃娌℃湁 errorMessage 鏃讹紝鏃ц涓轰笉鍙樸€?*/
        const plain = render({ role: 'assistant', content: [], stopReason: 'aborted' });
        assert.equal(plain.querySelector('.msg-note')?.textContent, '宸蹭腑鏂?);
      });
    } finally { w.close(); }
  } finally {
    serverStopped = true;
    raw.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(published.some((e) => e.type === 'stop_state'), true, '鍋滄鐘舵€佸繀椤诲箍鎾嚭鍘伙紙SSE锛?);
  }

  console.log(`stop-barrier: ${passed}/${passed + failed} cases passed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
