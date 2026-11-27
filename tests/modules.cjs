/* 鍚庣妯″潡鍖栵紙server/锛夌殑绾崟娴嬨€? *
 * 涓轰粈涔堝崟鐙竴浠斤細鎷嗘ā鍧椾箣鍚庯紝銆岃涓轰笉鍙樸€嶈繖浠朵簨鍙潬绔埌绔祴璇曪紙璧风湡鏈嶅姟銆? * 鍙戠湡璇锋眰锛夐獙璇佹槸涓嶅鐨?鈥斺€?閭ｄ簺鐢ㄤ緥瑕嗙洊闈㈠箍浣嗗畾浣嶅樊锛屼竴鏃︾孩浜嗚鑺卞緢涔? * 鎵嶈兘缂╁皬鍒板叿浣撴ā鍧椼€傝繖閲屽姣忎釜鏂版ā鍧楀仛**涓嶄緷璧栫綉缁溿€佷笉 spawn 杩涚▼**鐨? * 鐩存帴璋冪敤锛岀孩浜嗙珛鍒荤煡閬撴槸璋併€? *
 * 鍒绘剰涓嶆祴鐨勪笢瑗匡細鐪熷疄鐨?pi 瀛愯繘绋?spawn锛堥渶瑕佽 pi锛屼笖浼氱暀杩涚▼锛夈€? * 鐪熷疄鏂囦欢绯荤粺鍐欏叆锛坧roviders / projects 鐨勫啓璺緞浼氱鐢ㄦ埛閰嶇疆锛夈€? * 杩欎袱绫荤暀缁?server-security / dev-server / git 閭ｅ嚑涓鍒扮濂椾欢銆? */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  鈫?' + ok : extra ? '  鈫?' + extra : ''));
  }
}

/* ---------- 鏋佺畝鐨?req / res 鏇胯韩 ---------- */

function mockRes() {
  return {
    code: null,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers || {};
      return this;
    },
    write(s) {
      this.chunks.push(String(s));
      return true;
    },
    end(s) {
      if (s) this.chunks.push(String(s));
      this.ended = true;
    },
    body() {
      return this.chunks.join('');
    },
  };
}

function mockReq({ method = 'GET', url = '/', headers = {} } = {}) {
  const listeners = new Map();
  return {
    method,
    url,
    headers,
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return this;
    },
    emit(ev, arg) {
      for (const fn of listeners.get(ev) || []) fn(arg);
    },
  };
}

(async () => {
  /* ================= auth ================= */
  console.log('\n--- server/auth.js ---');
  const { createAuth, TOKEN_HEADER } = await import('../server/auth.js');

  const dev = createAuth({ token: '', port: 7788, appId: 'pi-gui', protocol: 1, version: '9.9.9' });
  const tok = createAuth({ token: 'secret-token-abc', port: 7788, appId: 'pi-gui', protocol: 1, version: '9.9.9' });

  check('鏃犱护鐗?鈫?isDevMode', () => dev.isDevMode === true);
  check('鏈変护鐗?鈫?涓嶆槸 devMode', () => tok.isDevMode === false);

  check('寮€鍙戞ā寮忥細涓嶅甫 Origin 鏀捐', () => dev.denyRequest(mockReq({})) === null);
  check('寮€鍙戞ā寮忥細璺ㄧ珯 Origin 鈫?403', () => {
    const d = dev.denyRequest(mockReq({ headers: { origin: 'https://evil.example' } }));
    return (d && d.code === 403) || JSON.stringify(d);
  });
  check('寮€鍙戞ā寮忥細127.0.0.1 鍚屾簮鏀捐', () =>
    dev.denyRequest(mockReq({ headers: { origin: 'http://127.0.0.1:7788' } })) === null);
  check('寮€鍙戞ā寮忥細localhost 鍚屾簮鏀捐', () =>
    dev.denyRequest(mockReq({ headers: { origin: 'http://localhost:7788' } })) === null);
  check('寮€鍙戞ā寮忥細绔彛涓嶅悓瑙嗕负璺ㄧ珯 鈫?403', () => {
    const d = dev.denyRequest(mockReq({ headers: { origin: 'http://127.0.0.1:9999' } }));
    return (d && d.code === 403) || JSON.stringify(d);
  });

  check('鏈変护鐗岋細娌″甫 鈫?401', () => {
    const d = tok.denyRequest(mockReq({}));
    return (d && d.code === 401) || JSON.stringify(d);
  });
  check('鏈変护鐗岋細X-Pi-Gui-Token 姝ｇ‘ 鈫?鏀捐', () =>
    tok.denyRequest(mockReq({ headers: { [TOKEN_HEADER]: 'secret-token-abc' } })) === null);
  check('鏈変护鐗岋細Bearer 姝ｇ‘ 鈫?鏀捐', () =>
    tok.denyRequest(mockReq({ headers: { authorization: 'Bearer secret-token-abc' } })) === null);
  check('鏈変护鐗岋細閿欒浠ょ墝 鈫?401', () => {
    const d = tok.denyRequest(mockReq({ headers: { [TOKEN_HEADER]: 'wrong' } }));
    return (d && d.code === 401) || JSON.stringify(d);
  });
  /* timingSafeEqual 瀵归暱搴︿笉绛夌殑 Buffer 浼氭姏 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH锛?   * 鎵€浠?tokenEquals 蹇呴』鍏堟瘮闀垮害銆傝繖鏉￠槻鐨勫氨鏄€屾媶妯″潡鏃舵妸闀垮害妫€鏌ュ紕涓€嶃€?*/
  check('闀垮害涓嶅悓鐨勪护鐗屼笉鎶涘紓甯搞€佸垽 401', () => {
    const d = tok.denyRequest(mockReq({ headers: { [TOKEN_HEADER]: 'x' } }));
    return (d && d.code === 401) || JSON.stringify(d);
  });
  check('401 鍝嶅簲涓嶅洖鏄炬敹鍒扮殑浠ょ墝', () => {
    const d = tok.denyRequest(mockReq({ headers: { [TOKEN_HEADER]: 'leak-me-please' } }));
    return String(d.error).includes('leak-me-please') === false || '閿欒淇℃伅閲屽嚭鐜颁簡浠ょ墝';
  });
  check('403 鍝嶅簲涓嶅洖鏄?Origin', () => {
    const d = dev.denyRequest(mockReq({ headers: { origin: 'https://evil.example' } }));
    return String(d.error).includes('evil.example') === false || '閿欒淇℃伅閲屽嚭鐜颁簡 Origin';
  });
  /* 璺ㄧ珯 Origin 蹇呴』鎺掑湪浠ょ墝妫€鏌?*涔嬪墠** 鈥斺€?鍚﹀垯涓€涓法绔欒姹傚甫涓婂伔鏉ョ殑浠ょ墝
   * 灏辫兘杩囥€傝繖閲岀敤涓€涓€孫rigin 闈炴硶 + 浠ょ墝姝ｇ‘銆嶇殑缁勫悎鏉ラ拤浣忛『搴忋€?*/
  check('璺ㄧ珯 Origin 浼樺厛浜庝护鐗屽垽瀹氾紙浠ょ墝瀵逛篃鎷掞級', () => {
    const d = tok.denyRequest(
      mockReq({ headers: { origin: 'https://evil.example', [TOKEN_HEADER]: 'secret-token-abc' } })
    );
    return (d && d.code === 403) || JSON.stringify(d);
  });

  {
    const res = mockRes();
    tok.handleHealth(res);
    const payload = JSON.parse(res.body());
    check('health 鍥?200', () => res.code === 200 || res.code);
    check('health 甯?app / protocol / version', () =>
      (payload.app === 'pi-gui' && payload.protocol === 1 && payload.version === '9.9.9') || JSON.stringify(payload));
    check('health 涓嶅甫浠讳綍浠ょ墝淇℃伅', () => JSON.stringify(payload).includes('secret-token') === false || '鍝嶅簲閲屽嚭鐜颁簡浠ょ墝');
  }

  /* ================= runtime ================= */
  console.log('\n--- server/runtime.js ---');
  const { createRuntime } = await import('../server/runtime.js');

  const rt = createRuntime({ initialCwd: 'C:\\start' });
  check('鍒濆 cwd 鏉ヨ嚜鏋勯€犲弬鏁?, () => rt.getCurrentCwd() === 'C:\\start' || rt.getCurrentCwd());
  rt.setCurrentCwd('D:\\next');
  check('setCurrentCwd 鐢熸晥锛堝悓涓€浠界姸鎬侊級', () => rt.getCurrentCwd() === 'D:\\next' || rt.getCurrentCwd());
  check('shuttingDown 榛樿 false', () => rt.isShuttingDown() === false);
  rt.setShuttingDown(true);
  check('setShuttingDown 鐢熸晥', () => rt.isShuttingDown() === true);
  check('涓嶄紶 initialCwd 鏃朵负 null', () => createRuntime().getCurrentCwd() === null);

  /* ================= sse ================= */
  console.log('\n--- server/sse.js ---');
  const { createEventBus, DEFAULT_BACKLOG_MAX } = await import('../server/sse.js');

  check('backlog 榛樿涓婇檺 = 800', () => DEFAULT_BACKLOG_MAX === 800 || DEFAULT_BACKLOG_MAX);

  {
    const bus = createEventBus();
    bus.publish({ type: 'a' });
    bus.publish({ type: 'b' });
    const bl = bus.backlog();
    check('publish 缁欎簨浠舵寕涓?_seq', () => bl[0]._seq === 1 && bl[1]._seq === 2 || JSON.stringify(bl.map((e) => e._seq)));
    check('_seq 鍗曡皟閫掑', () => bl[1]._seq > bl[0]._seq);
  }

  {
    const bus = createEventBus({ backlogMax: 3 });
    for (let i = 1; i <= 5; i++) bus.publish({ type: 'e', i });
    const bl = bus.backlog();
    check('backlog 瓒呬笂闄愬悗浠庡ご涓?, () => bl.length === 3 || bl.length);
    check('涓㈡帀鐨勬槸鏈€鑰佺殑锛堢暀涓嬫渶鍚?3 鏉★級', () =>
      bl.map((e) => e.i).join(',') === '3,4,5' || bl.map((e) => e.i).join(','));
    check('_seq 涓嶅洜涓㈠純鑰屽洖閫€', () => bl[0]._seq === 3 || bl[0]._seq);
  }

  {
    const bus = createEventBus();
    bus.publish({ type: 'before-connect' });
    const req = mockReq();
    const res = mockRes();
    bus.subscribe(req, res);
    check('subscribe 鍥?200', () => res.code === 200 || res.code);
    check('subscribe 鐢?text/event-stream', () =>
      String(res.headers['Content-Type']).startsWith('text/event-stream') || res.headers['Content-Type']);
    check('subscribe 鍏虫帀缂撳瓨涓庝唬鐞嗙紦鍐?, () =>
      (res.headers['Cache-Control'] === 'no-cache, no-transform' && res.headers['X-Accel-Buffering'] === 'no') ||
      JSON.stringify(res.headers));
    check('杩炴帴鍏堣ˉ鍙?backlog', () => res.body().includes('"before-connect"') || res.body().slice(0, 200));
    check('瀹㈡埛绔鏁?+1', () => bus.clientCount() === 1 || bus.clientCount());
    bus.publish({ type: 'after-connect' });
    check('杩炰笂涔嬪悗鐨勬柊浜嬩欢绔嬪埢鎺ㄧ粰瀹㈡埛绔?, () => res.body().includes('"after-connect"') || res.body().slice(-200));
    check('SSE 甯ф牸寮忔槸 data: 鈥\n\\n', () => /^data: \{.*\}\n\n$/m.test(res.body()) || res.body().slice(0, 80));
    req.emit('close');
    check('杩炴帴鍏抽棴鍚庝粠 clients 鎽樻帀', () => bus.clientCount() === 0 || bus.clientCount());
  }

  {
    const bus = createEventBus();
    const req = mockReq();
    const res = mockRes();
    bus.subscribe(req, res);
    bus.closeAll();
    check('closeAll 鏀舵帀鎵€鏈夎繛鎺?, () => (bus.clientCount() === 0 && res.ended) || `count=${bus.clientCount()} ended=${res.ended}`);
    /* subscribe 浼氳捣涓€涓?25s 鐨?ping 瀹氭椂鍣ㄣ€傜湡瀹炴湇鍔￠噷瀹冪敱 req 鐨?close 浜嬩欢
     * 娓呮帀锛坰hutdown 涔嬪悗杩涚▼绔嬪埢 exit锛屾墍浠ュ師瀹炵幇娌℃湁鍦?closeAll 閲屾竻锛夈€?     * 娴嬭瘯閲屽繀椤昏嚜宸辫Е鍙戜竴娆★紝鍚﹀垯浜嬩欢寰幆鎸傜潃锛宯ode 姘歌繙涓嶉€€鍑恒€?*/
    req.emit('close');
  }

  /* ================= http-utils ================= */
  console.log('\n--- server/http-utils.js ---');
  const { json, readRawBody, readBody } = await import('../server/http-utils.js');

  {
    const res = mockRes();
    json(res, 418, { ok: false, error: '鑼跺６' });
    check('json 璁剧疆鐘舵€佺爜', () => res.code === 418 || res.code);
    check('json 澹版槑 utf-8 JSON', () =>
      res.headers['Content-Type'] === 'application/json; charset=utf-8' || res.headers['Content-Type']);
    check('json 搴忓垪鍖栬浇鑽?, () => JSON.parse(res.body()).error === '鑼跺６' || res.body());
  }

  {
    // 涓枃鍒囨垚涓ゅ崐锛? 瀛楄妭瀛楃琚?chunk 杈圭晫鍒囧紑锛屽繀椤婚潬銆屽厛 concat 鍐嶈В鐮併€嶈繕鍘?    const req = mockReq();
    const p = readRawBody(req, 1024);
    const full = Buffer.from('鍙戦叺缃愮┖姘斿垎甯冨櫒', 'utf8');
    req.emit('data', full.subarray(0, 4));
    req.emit('data', full.subarray(4));
    req.emit('end');
    const buf = await p;
    check('readRawBody 鎸?Buffer 绱Н锛堜腑鏂囦笉琚垏鍧忥級', () => buf.toString('utf8') === '鍙戦叺缃愮┖姘斿垎甯冨櫒' || buf.toString('utf8'));
  }

  {
    const req = mockReq();
    const p = readRawBody(req, 8);
    req.emit('data', Buffer.alloc(4));
    req.emit('data', Buffer.alloc(8));
    req.emit('end');
    let msg = '';
    try {
      await p;
    } catch (e) {
      msg = e.message;
    }
    check('readRawBody 瓒呴檺 鈫?reject', () => Boolean(msg) || '娌℃湁鎷掔粷');
    check('瓒呴檺鏂囨鍚笂闄愶紙MB锛?, () => /瓒呰繃涓婇檺/.test(msg) || msg);
  }

  {
    const req = mockReq();
    const p = readBody(req);
    req.emit('data', Buffer.from('{"a":1}', 'utf8'));
    req.emit('end');
    const text = await p;
    check('readBody 杩斿洖瀛楃涓?, () => text === '{"a":1}' || text);
  }

  /* ================= rpc-bridge ================= */
  console.log('\n--- server/rpc-bridge.js ---');
  const { createRpcBridge } = await import('../server/rpc-bridge.js');

  const mkBridge = (cwd, env = {}) => {
    const events = [];
    const bridge = createRpcBridge({
      runtime: createRuntime({ initialCwd: cwd }),
      publish: (e) => events.push(e),
      piBin: 'pi',
      isWin: false,
      env,
    });
    return { bridge, events };
  };

  {
    const { bridge, events } = mkBridge(null);
    bridge.start();
    check('鏃犻」鐩椂 start 涓?spawn锛屽彧鍙?no-project', () =>
      (events.length === 1 && events[0].type === 'bridge_status' && events[0].state === 'no-project') ||
      JSON.stringify(events));
  }

  {
    const { bridge } = mkBridge(null);
    let msg = '';
    try {
      bridge.send({ type: 'prompt' });
    } catch (e) {
      msg = e.message;
    }
    check('鏃犻」鐩椂 send 鎶涢敊', () => Boolean(msg) || '娌℃湁鎶涢敊');
    check('鏃犻」鐩椂 send 鐨勬彁绀虹粰鍑哄彲鎵ц鎸囧紩锛堜笉鏄€屽瓙杩涚▼鏈繍琛屻€嶏級', () =>
      (/娣诲姞鏂囦欢澶?.test(msg) && !/瀛愯繘绋嬫湭杩愯/.test(msg)) || msg);
  }

  {
    const { bridge } = mkBridge('C:\\proj');
    let msg = '';
    try {
      bridge.send({ type: 'prompt' });
    } catch (e) {
      msg = e.message;
    }
    check('鏈夐」鐩絾 pi 鏈捣鏃?send 鎶涖€宲i 瀛愯繘绋嬫湭杩愯銆?, () => /pi 瀛愯繘绋嬫湭杩愯/.test(msg) || msg);
  }

  {
    const { bridge } = mkBridge('C:\\proj', {});
    check('buildArgs 榛樿甯?--mode rpc 涓?--continue', () =>
      bridge.buildArgs().join(' ') === '--mode rpc --continue' || bridge.buildArgs().join(' '));
  }
  {
    const { bridge } = mkBridge('C:\\proj', { PI_NO_CONTINUE: '1' });
    check('PI_NO_CONTINUE=1 鏃朵笉甯?--continue', () => bridge.buildArgs().join(' ') === '--mode rpc' || bridge.buildArgs().join(' '));
  }
  {
    const { bridge } = mkBridge('C:\\proj', {
      PI_PROVIDER: 'deepseek',
      PI_MODEL: 'deepseek-chat',
      PI_THINKING: 'high',
      PI_NO_SESSION: '1',
    });
    const a = bridge.buildArgs().join(' ');
    check('provider / model / thinking / no-session 閮介€忎紶', () =>
      a === '--mode rpc --continue --provider deepseek --model deepseek-chat --thinking high --no-session' || a);
  }

  {
    const { bridge } = mkBridge('C:\\proj');
    const st = bridge.getState();
    check('getState 鎶?piRunning=false锛堟湭鍚姩锛?, () => st.piRunning === false || st.piRunning);
    check('getState 鐨?pid 涓?null', () => st.pid === null || st.pid);
    check('getState 甯?cwd 涓?hasProject', () => (st.cwd === 'C:\\proj' && st.hasProject === true) || JSON.stringify(st));
    check('getState 甯?args', () => Array.isArray(st.args) && st.args.length > 0 || JSON.stringify(st.args));
  }

  /* ---------- projectLaunch 娉ㄥ叆 ----------
   *
   * rpc-bridge 涓嶇煡閬撻」鐩厤缃噷鏈変粈涔堬紝鍙 prepareLaunch()锛坰pawn 鍓嶏紝鍏佽鍐欐枃浠讹級
   * 涓?launchArgs()锛堢函璇伙級涓や釜鏂规硶銆傝繖涓€娈电洴浣忕殑灏辨槸杩欎袱鏉″绾︼細
   * 鍙傛暟鏈夋病鏈夎杩藉姞銆佹姏閿欎細涓嶄細甯﹀鍚姩銆佺函璇昏矾寰勪細涓嶄細琚褰撴垚鍐欒矾寰勩€?   * 鐪熸鐨勩€屽啓鏂囦欢銆嶇敱 tests/project-config.cjs 瑕嗙洊銆?*/
  {
    const mkWithLaunch = (cwd, launch, env = {}) =>
      createRpcBridge({
        runtime: createRuntime({ initialCwd: cwd }),
        publish: () => {},
        piBin: 'pi',
        isWin: false,
        env,
        projectLaunch: launch,
      });

    {
      const b = mkWithLaunch('C:\\proj', { launchArgs: () => ({ args: ['--thinking', 'high'], warnings: [] }) });
      check('projectLaunch 鐨勫弬鏁拌杩藉姞鍒板惎鍔ㄥ弬鏁版湯灏?, () =>
        b.buildArgs().join(' ') === '--mode rpc --continue --thinking high' || b.buildArgs().join(' '));
      check('projectLaunch 鐨勫弬鏁板嚭鐜板湪 getState().args 閲岋紙鐣岄潰鑳界湅鍒扮湡瀹炲惎鍔ㄥ弬鏁帮級', () =>
        b.getState().args.join(' ').includes('--thinking high') || b.getState().args.join(' '));
    }
    {
      // 鐜鍙橀噺宸茬粡缁欎簡 --thinking 鏃讹紝椤圭洰閰嶇疆涓嶈鍐嶇粰涓€浠斤紙鍚﹀垯鍚庤€呰鐩栧墠鑰咃級
      const b = mkWithLaunch(
        'C:\\proj',
        { launchArgs: () => ({ args: [], warnings: [] }) },
        { PI_THINKING: 'low' }
      );
      check('鐜鍙橀噺涓庨」鐩厤缃笉浼氱粰鍑轰袱浠?--thinking', () => {
        const a = b.buildArgs();
        return a.filter((x) => x === '--thinking').length === 1 || a.join(' ');
      });
    }
    {
      const b = mkWithLaunch('C:\\proj', {
        launchArgs: () => {
          throw new Error('閰嶇疆璇诲潖浜?);
        },
      });
      check('projectLaunch 鎶涢敊鏃朵笉甯﹀ buildArgs锛堥€€鍥炰笉甯﹂」鐩弬鏁帮級', () =>
        b.buildArgs().join(' ') === '--mode rpc --continue' || b.buildArgs().join(' '));
    }
    {
      /* 鏃犻」鐩?鈫?start() 鍦ㄦ嬁鍒?cwd 涔嬪墠灏辫繑鍥炰簡锛屾墍浠ユ棦涓嶄細 spawn pi锛?       * 涔熶笉浼氳蛋鍒?prepareLaunch銆傝繖涓€鏉＄殑浠峰€兼槸锛氱‘璁ゃ€屾病鏈夐」鐩椂鍚庣
       * 涓嶅線浠讳綍鐩綍鍐欎笢瑗裤€嶁€斺€?prepareLaunch 鏄細鍐欐枃浠剁殑銆?*/
      let prepared = 0;
      const events = [];
      const b2 = createRpcBridge({
        runtime: createRuntime({ initialCwd: null }),
        publish: (e) => events.push(e),
        piBin: 'pi',
        isWin: false,
        env: {},
        projectLaunch: {
          prepareLaunch: () => {
            prepared++;
            return { args: [], warnings: [] };
          },
          launchArgs: () => ({ args: [], warnings: [] }),
        },
      });
      b2.start();
      check('鏃犻」鐩椂 start() 涓嶈皟 prepareLaunch锛堜笉鍚姩 pi锛屼篃涓嶅啓浠讳綍鏂囦欢锛?, () =>
        (prepared === 0 && events.length === 1 && events[0].state === 'no-project') || JSON.stringify({ prepared, events }));
    }

    // 椤哄簭濂戠害锛歱repareLaunch锛堝彲鑳藉啓鏂囦欢锛夊繀椤诲湪 buildArgs 涔嬪墠璋冪敤锛?    // 鍚﹀垯鍒氬悓姝ュ嚭鏉ョ殑鎸囦护鏂囦欢涓嶄細琚甫涓婂弬鏁般€傜敤婧愮爜椤哄簭瀹堜綇瀹?鈥斺€?    // 杩欐潯椤哄簭閿欎簡鐨勮〃鐜版槸銆屾寚浠や繚瀛樹簡浣嗚繖娆″惎鍔ㄦ病鐢熸晥銆嶏紝寰堥毦浠庡閮ㄧ湅鍑烘潵銆?    const src = fs.readFileSync(path.join(SERVER_DIR, 'rpc-bridge.js'), 'utf8');
    check('rpc-bridge 閲?prepareLaunch() 鎺掑湪 buildArgs(extra) 涔嬪墠', () => {
      const p = src.indexOf('projectLaunch.prepareLaunch()');
      const b = src.indexOf('buildArgs(extra)');
      return (p !== -1 && b !== -1 && p < b) || `prepareLaunch@${p} buildArgs@${b}`;
    });
    check('rpc-bridge 涓?import 浠讳綍涓氬姟妯″潡锛堝彧闈犳敞鍏ヨ璇嗛」鐩厤缃級', () => {
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      /* 鐧藉悕鍗曞彧鏈変袱涓彾瀛愬師璇細
       * - `./pi-launch.js` 鍐冲畾**鍚姩鍛戒护鎬庝箞鎴愬舰**锛堝彧渚濊禆 node:fs / node:path锛夛紝
       *   rpc-bridge 蹇呴』涓?`--version` 鎺㈡祴鐢ㄥ悓涓€浠?`formatLaunch()`锛圥20.5 Blocker A锛夛紱
       * - `./child-env.js` 鏄浂渚濊禆鐨勫唴閮ㄧ幆澧冨彉閲忔竻鍗曚笌 scrub锛岀粓绔笌 rpc-bridge
       *   蹇呴』鍏辩敤鍚屼竴浠斤紝婕忎竴涓敭灏辨槸闈欓粯鐨勬潈闄愭硠婕忋€?       * 鐧藉悕鍗曞鐨勬ā鍧楋紙projects / providers / sessions / mcp 鈥︼級涓€寰嬩笉璁歌繘銆?*/
      const ALLOWED = new Set(['./pi-launch.js', './child-env.js']);
      return imports.every((i) => i.startsWith('node:') || ALLOWED.has(i)) || imports.join(',');
    });
  }
  {
    const { bridge } = mkBridge(null);
    const st = bridge.getState();
    check('鏃犻」鐩椂 hasProject=false', () => st.hasProject === false || JSON.stringify(st));
  }

  /* ================= router ================= */
  console.log('\n--- server/router.js ---');
  const { createRouter } = await import('../server/router.js');

  /* 鐢ㄧ湡鐨?auth / sse / runtime锛屽叾浣欏鐞嗗櫒鐢ㄦ浛韬?鈥斺€?   * 杩欎竴娈电殑閲嶇偣鏄?*鍒嗗彂椤哄簭**锛屼笉鏄悇澶勭悊鍣ㄧ殑涓氬姟銆?*/
  const calls = [];
  const stub = (name) => (...args) => {
    calls.push(name);
    const res = args.find((a) => a && typeof a.writeHead === 'function');
    if (res) res.writeHead(200, { 'Content-Type': 'application/json' });
    if (res) res.end(JSON.stringify({ ok: true, handler: name }));
  };

  const router = createRouter({
    auth: createAuth({ token: 'T', port: 7788, appId: 'pi-gui', protocol: 1, version: '0.0.0' }),
    sse: { subscribe: stub('sse') },
    rpc: { send: stub('rpc.send'), restart: stub('rpc.restart'), getState: () => ({ ok: true, handler: 'rpc.getState' }) },
    providers: { handle: stub('providers'), handleModels: stub('providers.models') },
    projects: { handle: stub('projects'), handleFs: stub('projects.fs') },
    projectConfig: { handle: stub('projectConfig') },
    specs: { handle: stub('specs') },
    skills: { handle: stub('skills') },
    mcp: { handle: stub('mcp') },
    mcpNative: { handleServers: stub('mcp.servers'), handleStatus: stub('mcp.status') },
    planner: { handle: stub('planner') },
    gitRoutes: { handle: stub('git') },
    uploads: { handle: stub('uploads') },
  });

  const hit = (method, url, headers = {}) => {
    const req = mockReq({ method, url, headers });
    const res = mockRes();
    router(req, res);
    return res;
  };
  const authHeaders = { 'x-pi-gui-token': 'T' };
  /* 渚涘簲鍟嗚矾鐢卞湪浠ょ墝涔嬪杩樿姹?Host 鎭颁负鏈満鍥炵幆锛坅uth.denyLocalHost锛夛紝
   * 鎵€浠ヨ繖鍑犳潯鏂█蹇呴』甯︿笂涓?createAuth 鐩稿悓绔彛鐨?Host銆?*/
  const providerHeaders = { ...authHeaders, host: '127.0.0.1:7788' };

  check('/api/health 鍏嶈璇侊紙涓嶅甫浠ょ墝涔?200锛?, () => {
    const res = hit('GET', '/api/health');
    return res.code === 200 || res.code;
  });
  check('/api/health 璧扮殑鏄?auth 鑷繁鐨勫鐞嗗櫒', () => {
    const res = hit('GET', '/api/health');
    return JSON.parse(res.body()).app === 'pi-gui' || res.body();
  });
  check('鍏朵綑 /api/* 涓嶅甫浠ょ墝 鈫?401', () => {
    const res = hit('GET', '/api/status');
    return res.code === 401 || res.code;
  });
  check('/api/status 甯︿护鐗?鈫?200 涓旀潵鑷?rpc.getState', () => {
    const res = hit('GET', '/api/status', authHeaders);
    return (res.code === 200 && JSON.parse(res.body()).handler === 'rpc.getState') || res.body();
  });
  check('璺ㄧ珯 Origin + 姝ｇ‘浠ょ墝浠嶈 403锛圤rigin 鍏堝垽锛?, () => {
    const res = hit('GET', '/api/status', { ...authHeaders, origin: 'https://evil.example' });
    return res.code === 403 || res.code;
  });

  /* 椤哄簭锛?api/providers/models 蹇呴』鍛戒腑 handleModels锛?   * 鑰屼笉鏄 /api/providers 鍓嶇紑鍚炴帀褰撴垚銆屼繚瀛樹竴涓彨 models 鐨勪緵搴斿晢銆嶃€?*/
  check('/api/providers/models 鍛戒腑 handleModels锛堜笉琚墠缂€鍚炴帀锛?, () => {
    calls.length = 0;
    hit('POST', '/api/providers/models', providerHeaders);
    return calls[0] === 'providers.models' || calls.join(',');
  });
  check('/api/providers 鍛戒腑 providers', () => {
    calls.length = 0;
    hit('GET', '/api/providers', providerHeaders);
    return calls[0] === 'providers' || calls.join(',');
  });
  check('/api/providers/foo 鍛戒腑 providers锛堝墠缂€锛?, () => {
    calls.length = 0;
    hit('DELETE', '/api/providers/foo', providerHeaders);
    return calls[0] === 'providers' || calls.join(',');
  });
  check('/api/projects/activate 鍛戒腑 projects锛堝墠缂€锛?, () => {
    calls.length = 0;
    hit('POST', '/api/projects/activate', authHeaders);
    return calls[0] === 'projects' || calls.join(',');
  });
  check('/api/fs 鍛戒腑 projects.handleFs', () => {
    calls.length = 0;
    hit('GET', '/api/fs', authHeaders);
    return calls[0] === 'projects.fs' || calls.join(',');
  });
  check('/api/git/status 鍛戒腑 gitRoutes', () => {
    calls.length = 0;
    hit('GET', '/api/git/status', authHeaders);
    return calls[0] === 'git' || calls.join(',');
  });
  check('/api/git 鍛戒腑 gitRoutes锛堜笉甯﹀瓙璺緞锛?, () => {
    calls.length = 0;
    hit('POST', '/api/git', authHeaders);
    return calls[0] === 'git' || calls.join(',');
  });
  check('/api/upload 鍛戒腑 uploads', () => {
    calls.length = 0;
    hit('POST', '/api/upload', authHeaders);
    return calls[0] === 'uploads' || calls.join(',');
  });
  check('/api/events 鍛戒腑 sse.subscribe', () => {
    calls.length = 0;
    hit('GET', '/api/events', authHeaders);
    return calls[0] === 'sse' || calls.join(',');
  });
  /* /api/restart 鍏?await restartGuard 鍐嶈皟鐢?rpc.restart锛堢紪杈戜簨鍔′簰鏂ワ級锛?   * 鍥犳蹇呴』绛変竴涓簨浠跺惊鐜紝涓嶈兘鎸夊悓姝ュ垎鍙戞柇瑷€銆?*/
  calls.length = 0;
  hit('POST', '/api/restart', authHeaders);
  await new Promise(resolve => setImmediate(resolve));
  check('/api/restart 鍛戒腑 rpc.restart', () => calls[0] === 'rpc.restart' || calls.join(','));

  /* 椤圭洰閰嶇疆鍒绘剰鐢ㄤ簡鐙珛鐨勯《灞傝矾寰勮€屼笉鏄?/api/projects/config 鈥斺€?   * 鍚庤€呬細琚笂闈㈤偅鏉?/api/projects/ 鍓嶇紑鍖归厤鍚冩帀锛堝墠缂€鍦ㄥ畠涔嬪墠锛夛紝
   * 鑰屼笖鐥囩姸鏄潤榛樼殑锛欸ET 杩斿洖椤圭洰鍒楄〃銆丳UT 钀借繘 405锛岄兘涓嶆槸鎶ラ敊銆?*/
  check('/api/project-config 鍛戒腑 projectConfig锛堜笉琚?/api/projects 鍓嶇紑鍚冩帀锛?, () => {
    calls.length = 0;
    hit('GET', '/api/project-config', authHeaders);
    return calls[0] === 'projectConfig' || calls.join(',');
  });
  check('/api/project-config 鐨?PUT 涔熷懡涓?projectConfig', () => {
    calls.length = 0;
    hit('PUT', '/api/project-config', authHeaders);
    return calls[0] === 'projectConfig' || calls.join(',');
  });
  check('/api/projects 浠嶇劧鍛戒腑 projects锛堜袱鏉¤矾寰勪笉浜掔浉閬斀锛?, () => {
    calls.length = 0;
    hit('GET', '/api/projects', authHeaders);
    return calls[0] === 'projects' || calls.join(',');
  });
  check('GET /api/specs 鍛戒腑 specs', () => {
    calls.length = 0;
    hit('GET', '/api/specs', authHeaders);
    return calls[0] === 'specs' || calls.join(',');
  });
  check('GET /api/specs/document 鍛戒腑 specs锛屼笉琚?405 鍏滃簳鍚冩帀', () => {
    calls.length = 0;
    const res = hit('GET', '/api/specs/document', authHeaders);
    return (calls[0] === 'specs' && res.code !== 405) || calls.join(',') + '/' + res.code;
  });

  /* 鎵╁睍鑳藉姏锛歋kills 鏈?PUT锛堝惎鍋滐級锛屾墍浠ュ繀椤绘帓鍦ㄣ€岄潪 GET 鈫?405銆嶄箣鍓嶃€?*/
  check('GET /api/skills 鍛戒腑 skills', () => {
    calls.length = 0;
    hit('GET', '/api/skills', authHeaders);
    return calls[0] === 'skills' || calls.join(',');
  });
  check('PUT /api/skills/<id> 鍛戒腑 skills锛堜笉琚?405 鍏滃簳鍚冩帀锛?, () => {
    calls.length = 0;
    const res = hit('PUT', '/api/skills/abcdef0123456789', authHeaders);
    return (calls[0] === 'skills' && res.code !== 405) || calls.join(',') + '/' + res.code;
  });
  check('GET /api/skills/<id> 鍛戒腑 skills', () => {
    calls.length = 0;
    hit('GET', '/api/skills/abcdef0123456789', authHeaders);
    return calls[0] === 'skills' || calls.join(',');
  });
  check('GET /api/mcp 鍛戒腑 mcp', () => {
    calls.length = 0;
    hit('GET', '/api/mcp', authHeaders);
    return calls[0] === 'mcp' || calls.join(',');
  });
  /* P20.6锛氬師鐢?MCP 鐙珛椤跺眰璺緞锛堜笉鎸?/api/mcp 鍓嶇紑锛屼笉琚?405 鍏滃簳鍚冩帀锛夈€?*/
  check('GET /api/mcp/servers 鍛戒腑 mcpNative锛堜笉琚?405 鍏滃簳鍚冩帀锛?, () => {
    calls.length = 0;
    const res = hit('GET', '/api/mcp/servers', authHeaders);
    return (calls[0] === 'mcp.servers' && res.code !== 405) || calls.join(',') + '/' + res.code;
  });
  check('POST /api/mcp/servers 鍛戒腑 mcpNative锛堝姩浣滀笉琚?405 鍏滃簳鍚冩帀锛?, () => {
    calls.length = 0;
    const res = hit('POST', '/api/mcp/servers', authHeaders);
    return (calls[0] === 'mcp.servers' && res.code !== 405) || calls.join(',') + '/' + res.code;
  });
  check('POST /api/mcp/status 鍛戒腑 mcpNative', () => {
    calls.length = 0;
    hit('POST', '/api/mcp/status', authHeaders);
    return calls[0] === 'mcp.status' || calls.join(',');
  });
  check('/api/skills 涓嶅甫浠ょ墝 鈫?401锛堝拰鍏朵綑 /api/* 涓€鏍疯繃璁块棶鎺у埗锛?, () => {
    const res = hit('GET', '/api/skills');
    return res.code === 401 || res.code;
  });
  check('/api/mcp 涓嶅甫浠ょ墝 鈫?401', () => {
    const res = hit('GET', '/api/mcp');
    return res.code === 401 || res.code;
  });
  check('/api/skills 涓嶉伄钄?/api/projects锛堝墠缂€涓嶉噸鍙狅級', () => {
    calls.length = 0;
    hit('GET', '/api/projects/abc', authHeaders);
    return calls[0] === 'projects' || calls.join(',');
  });

  /* ---- Planner / Agent 缂栨帓锛圥5锛?---- */

  check('GET /api/agents 鍛戒腑 planner', () => {
    const res = hit('GET', '/api/agents', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('GET /api/plans 鍛戒腑 planner', () => {
    const res = hit('GET', '/api/plans', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('POST /api/plans 鍛戒腑 planner锛堜笉琚?405 鍏滃簳鍚冩帀锛?, () => {
    const res = hit('POST', '/api/plans', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('POST /api/plans/<id>/start 鍛戒腑 planner', () => {
    const res = hit('POST', '/api/plans/plan-1/start', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('POST /api/plans/<id>/tasks/<tid>/retry 鍛戒腑 planner', () => {
    const res = hit('POST', '/api/plans/plan-1/tasks/t1/retry', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('GET /api/plans/<id> 鍛戒腑 planner', () => {
    const res = hit('GET', '/api/plans/plan-1', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('PUT /api/plans/<id> 鍛戒腑 planner锛堜笉琚?405 鍏滃簳鍚冩帀锛?, () => {
    const res = hit('PUT', '/api/plans/plan-1', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('/api/plans 涓嶅甫浠ょ墝 鈫?401', () => {
    const res = hit('GET', '/api/plans');
    return res.code === 401 || res.code;
  });
  check('/api/agents 涓嶅甫浠ょ墝 鈫?401', () => {
    const res = hit('GET', '/api/agents');
    return res.code === 401 || res.code;
  });
  check('/api/plans 涓嶉伄钄?/api/projects锛堝墠缂€涓嶉噸鍙狅級', () => {
    const res = hit('GET', '/api/projects', authHeaders);
    return JSON.parse(res.body()).handler === 'projects' || res.body();
  });
  check('/api/agents 涓嶉伄钄?/api/plans锛堜袱鑰呮槸鐙珛璺緞锛?, () => {
    const a = hit('GET', '/api/agents', authHeaders);
    const b = hit('GET', '/api/plans', authHeaders);
    return (JSON.parse(a.body()).handler === 'planner' && JSON.parse(b.body()).handler === 'planner') || a.body() + ' / ' + b.body();
  });

  /* Git 鍓嶇紑蹇呴』鎺掑湪銆岄潪 GET 鈫?405銆嶄箣鍓嶏紝鍚﹀垯 /api/git/status 浼氳 405 鎺夈€?*/
  check('GET /api/git/status 涓嶈 405 鍏滃簳鍚冩帀', () => {
    const res = hit('GET', '/api/git/status', authHeaders);
    return res.code !== 405 || res.code;
  });
  check('鏈煡闈?GET 璺緞 鈫?405', () => {
    const res = hit('POST', '/definitely-not-a-route');
    return res.code === 405 || res.code;
  });
  check('鏈煡 GET 璺緞 鈫?404锛堥潤鎬佸厹搴曪級', () => {
    const res = hit('GET', '/nope-does-not-exist.js');
    return res.code === 404 || res.code;
  });

  /* 闈欐€佽祫婧愶細鐪熺殑璇?public/锛岀‘璁?router 娌℃妸杩欐潯閾捐矾寮勪涪 */
  check('鏍硅矾寰勮兘鍙栧埌 index.html', () => {
    const res = hit('GET', '/');
    return (res.code === 200 && res.body().includes('<title>Pi GUI</title>')) || res.code;
  });
  check('闈欐€佽祫婧愬０鏄?no-store', () => {
    const res = hit('GET', '/');
    return res.headers['Cache-Control'] === 'no-store' || res.headers['Cache-Control'];
  });
  /* 鐩綍绌胯秺瑕佹寫**鐪熻兘鎶佃揪瀹堝崼**鐨勫悜閲忋€?   *
   * 瀹炴祴锛圵HATWG URL 鐨勮矾寰勫綊涓€鍖栵級锛?   *   '/../server.js'       鈫?pathname '/server.js'      鈫?琚?URL 鑷繁鍚冩帀浜?   *   '/%2e%2e/server.js'   鈫?pathname '/server.js'      鈫?%2e 涔熷綋鐐规澶勭悊
   *   '/..%5cserver.js'     鈫?pathname 鍘熸牱淇濈暀           鈫?杩欐潯鎵嶅埌寰椾簡瀹堝崼
   * %5c 鏄弽鏂滄潬锛孶RL 涓嶆妸瀹冨綋鍒嗛殧绗︼紝浣?serveStatic 浼氬厛鎶?\ 鎹㈡垚 / 鍐嶅綊涓€鍖栵紝
   * 浜庢槸 '../server.js' 闇插嚭鏉ヨ鎷︺€傛墍浠ヤ笅闈㈢敤杩欎釜褰㈠紡娴嬶紝涓嶆槸闅忎究鎸戜竴涓€?*/
  check('鐩綍绌胯秺锛?.%5c锛夎 403 鎸′綇', () => {
    const res = hit('GET', '/..%5cserver.js');
    return res.code === 403 || res.code;
  });
  check('绌胯秺琚尅浣忔椂涓嶇暀浠讳綍鏂囦欢鍐呭', () => {
    const res = hit('GET', '/..%5cserver.js');
    return res.body().includes('createRpcBridge') === false || '鍝嶅簲閲屾紡鍑轰簡婧愮爜';
  });
  check('缂栫爜鐨勭偣娈靛舰寮忚 URL 褰掍竴鍖栧悗钀藉埌 404锛堜笉鎶ラ敊銆佷笉婕忔枃浠讹級', () => {
    const res = hit('GET', '/%2e%2e/server.js');
    return res.code === 404 || res.code;
  });
  check('闈欐€佽祫婧愮殑 Content-Type 鎸夋墿灞曞悕缁?, () => {
    const res = hit('GET', '/styles.css');
    return String(res.headers['Content-Type']).startsWith('text/css') || res.headers['Content-Type'];
  });

  /* ================= 妯″潡杈圭晫 ================= */
  console.log('\n--- 渚濊禆鏂瑰悜锛堜笉璁告垚鐜級 ---');

  /* 閫掑綊鏀堕泦 server/ 涓?*鎵€鏈?* .js銆?   *
   * 鏃╁厛鏄?`readdirSync(SERVER_DIR).filter(.js)` 鈥斺€?鍙湅椤跺眰銆傚姞浜?   * server/agents/ 涓?server/planner/ 涔嬪悗锛岃繖涓や釜瀛愮洰褰?*瀹屽叏娌¤鎵埌**锛?   * 瀹堝崼浠嶇劧鍏ㄧ豢浣嗗凡缁忎笉瑕嗙洊鏂颁唬鐮佷簡銆傝繖绉嶃€屼唬鐮佹惉璧颁簡銆佸畧鍗繕鍦ㄥ師鍦扮┖杞€?   * 鐨勫亣缁挎瘮娌℃湁瀹堝崼鏇村嵄闄╋紝鎵€浠ユ敼鎴愰€掑綊銆?*/
  const collectServerFiles = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...collectServerFiles(full));
      else if (e.name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  const files = collectServerFiles(SERVER_DIR);
  const relOf = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  const serverSet = new Set(files.map((f) => path.resolve(f)));
  const LIB_DIR = path.join(ROOT, 'lib') + path.sep;
  const HTTP_UTILS = path.resolve(path.join(SERVER_DIR, 'http-utils.js'));
  const SERVER_JS = path.resolve(path.join(ROOT, 'server.js'));
  /* 绮剧‘鍏佽 server 鐩存帴 import 鐨?public/ 绾ā鍧楋紙鐞嗙敱瑙佷笅鏂逛緷璧栬鍒欙級銆?*/
  const SHARED_PROVIDER_CONTRACT = path.resolve(path.join(ROOT, 'public', 'provider-management', 'contract.js'));
  const SHARED_RUNTIME_TIMELINE = path.resolve(path.join(ROOT, 'public', 'runtime-timeline.js'));
  const SHARED_HTML_ARTIFACT_MODEL = path.resolve(path.join(ROOT, 'public', 'html-artifact-model.js'));

  const rawImports = new Map();
  const deps = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const found = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    rawImports.set(relOf(f), found);
    const inside = [];
    for (const spec of found) {
      if (!spec.startsWith('.')) continue;
      const abs = path.resolve(path.dirname(f), spec);
      if (serverSet.has(abs)) inside.push(relOf(abs));
    }
    deps.set(relOf(f), inside);
  }

  check(`server/ 閫掑綊鎵埌 ${files.length} 涓ā鍧楋紙鍚?agents/ 涓?planner/锛塦, () => files.length >= 15 || files.length);
  check('server/ 涓嬬殑妯″潡鍙?import 鍚岀洰褰曞厔寮熴€乭ttp-utils 鎴?lib', () => {
    /* 瑙勫垯锛?     *   - 鍚屼竴涓洰褰曢噷鐨勫厔寮?鈫?鍏佽锛坅gents/ 鍐呴儴銆乸lanner/ 鍐呴儴锛?     *   - lib/锛堜粨搴撴牴鐨勫叡浜簱锛夆啋 鍏佽
     *   - server/http-utils.js 鈫?**鏄惧紡鏀捐**锛氬畠鏄浜旀潯閾捐矾鍏辩敤鐨?HTTP 宸ュ叿锛?     *     涓嶆槸涓€涓笟鍔℃ā鍧椼€傚拰宸叉湁鐨勩€実it-routes 鈫?lib/git.js銆嶆槸鍚屼竴绫讳緥澶栥€?     *   - public/provider-management/contract.js 鈫?**鏄惧紡鏀捐**锛氫緵搴斿晢绠＄悊鐨勫墠鍚庣
     *     鍏变韩鍚堝悓锛堢函鏍￠獙涓庣姸鎬佹灇涓撅紝鏃?IO銆佹棤鍓綔鐢級銆傛祻瑙堝櫒闈欐€佽祫婧愬彧鏈嶅姟
     *     public/锛坙ib/assets.js 鐨?readPublic锛夛紝server 涓?renderer 蹇呴』寮曠敤鍚屼竴浠?     *     鏂囦欢锛屾斁 lib/ 鍙嶈€屼細璁╂祻瑙堝櫒 import 涓嶅埌銆傚畠涓嶆槸涓氬姟妯″潡锛屾斁琛岃寖鍥?     *     绮剧‘鍒拌繖涓€涓枃浠讹紝server 浠嶄笉寰?import public/ 涓嬬殑鍏朵粬鍐呭銆?     *   - public/runtime-timeline.js 鈫?**鏄惧紡鏀捐**锛歊untime 鎵ц鏃堕棿绾跨殑绾暟鎹姇褰?     *     锛堟棤 DOM銆佹棤 I/O锛屽彧 import 鍚屾牱绾殑 plan-model/html-artifact-model锛夈€傚巻鍙叉仮澶嶅繀椤?     *     鍦?server 渚у畬鎴愮獎鎶曞奖鍚庢墠鎶?block 鍙戠粰 renderer锛堜笉鑳藉洖浼犲師濮嬪伐鍏?args/
     *     result锛夛紝鑰屽疄鏃朵笌 get_messages 鎭㈠鍙堝繀椤讳娇鐢ㄥ悓涓€浠界函鍑芥暟锛涙祻瑙堝櫒闈欐€?     *     璧勬簮鍙湇鍔?public/锛屾斁 lib/ 鍙嶈€屼細璁╂祻瑙堝櫒 import 涓嶅埌銆傛斁琛岃寖鍥寸簿纭埌
     *     杩欎竴涓枃浠讹紝server 浠嶄笉寰?import public/ 涓嬬殑鍏朵粬鍐呭銆?     *   - public/html-artifact-model.js 鈫?**鏄惧紡鏀捐**锛氬墠鍚庣蹇呴』鐢ㄥ悓涓€浠?HTML
     *     寮曠敤鐧藉悕鍗曞強瀹归噺甯搁噺锛涘畠涓嶅惈 HTML 姝ｆ枃銆丏OM銆両O 鎴栦换浣?import銆傝寖鍥村彧鍒版
     *     绾悎鍚屾枃浠讹紝涓嶆斁琛?renderer/iframe 瀹炵幇銆備笅鏂瑰崟鐙畧鍗叾绾害銆?     *   - 鍏跺畠璺ㄧ洰褰?import 鈫?涓嶅厑璁搞€傝法瀛愮郴缁熷崗浣滀竴寰嬭蛋 server.js 瑁呴厤 + 渚濊禆娉ㄥ叆銆?*/
    const bad = [];
    for (const f of files) {
      const rel = relOf(f);
      for (const spec of rawImports.get(rel)) {
        if (!spec.startsWith('.')) continue;
        const abs = path.resolve(path.dirname(f), spec);
        if (serverSet.has(abs)) {
          const sameDir = path.dirname(abs) === path.dirname(f);
          if (!sameDir && abs !== HTTP_UTILS) bad.push(`${rel} 鈫?${spec}`);
          continue;
        }
        if (!abs.startsWith(LIB_DIR) && abs !== SHARED_PROVIDER_CONTRACT && abs !== SHARED_RUNTIME_TIMELINE
          && abs !== SHARED_HTML_ARTIFACT_MODEL) bad.push(`${rel} 鈫?${spec}`);
      }
    }
    return bad.length === 0 || bad.join(', ');
  });

  /* 鏀捐 public/runtime-timeline.js 鐨勫墠鎻愭槸瀹冨缁堟槸绾姇褰憋細涓€鏃﹀畠寮€濮嬬
   * DOM銆両/O 鎴栧紩鍏ュ叾浠?renderer 妯″潡锛宻erver 渚х殑鍘嗗彶鎶曞奖灏变笉鍐嶅畨鍏紝杩欓噷
   * 蹇呴』鍙樼孩锛岃€屼笉鏄户缁潤榛樺叡浜€?*/
  check('鍏变韩缁?server 鐨?runtime-timeline 淇濇寔绾姇褰憋紙鏃?DOM/IO锛屽彧渚濊禆绾暟鎹ā鍨嬶級', () => {
    const src = fs.readFileSync(SHARED_RUNTIME_TIMELINE, 'utf8');
    const foreign = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1]).filter((spec) => !['./plan-model.js', './html-artifact-model.js'].includes(spec));
    const io = /\b(document|window|localStorage|node:fs|node:http|node:child_process|process\.)\b/.test(src);
    return (foreign.length === 0 && !io) || `imports=${foreign.join(',') || 'ok'} io=${io}`;
  });
  check('鍏变韩 HTML Artifact 鍚堝悓淇濇寔鏃?import銆佹棤 DOM銆佹棤 IO 鐨勭函鐧藉悕鍗曟姇褰?, () => {
    const src = fs.readFileSync(SHARED_HTML_ARTIFACT_MODEL, 'utf8');
    return !/(?:\bimport\s*(?:\(|["'{*])|\bfrom\s*["'])/.test(src)
      && !/\b(?:document|window|localStorage|fetch|XMLHttpRequest)\s*[.(]|\b(?:process|require)\s*[.(]|node:/.test(src);
  });

  check('娌℃湁浠讳綍妯″潡 import server.js锛堝惁鍒欐垚鐜級', () => {
    const bad = [];
    for (const f of files) {
      for (const spec of rawImports.get(relOf(f))) {
        if (!spec.startsWith('.')) continue;
        if (path.resolve(path.dirname(f), spec) === SERVER_JS) bad.push(relOf(f));
      }
    }
    return bad.length === 0 || bad.join(', ');
  });

  check('妯″潡涔嬮棿鏃犲惊鐜緷璧?, () => {
    const cycles = [];
    const seen = new Set();
    const keys = [...deps.keys()];
    const walk = (node, stack) => {
      if (stack.includes(node)) {
        cycles.push([...stack, node].join(' 鈫?'));
        return;
      }
      const key = stack.join('>') + '|' + node;
      if (seen.has(key)) return;
      seen.add(key);
      for (const next of deps.get(node) || []) {
        if (keys.includes(next)) walk(next, [...stack, node]);
      }
    };
    for (const f of keys) walk(f, []);
    return cycles.length === 0 || cycles.join(' | ');
  });

  check('router.js 涓?import 浠讳綍涓氬姟妯″潡锛堝彧渚濊禆 http-utils 涓?lib锛?, () => {
    const d = deps.get('server/router.js') || [];
    const bad = d.filter((x) => x !== 'server/http-utils.js');
    return bad.length === 0 || bad.join(', ');
  });
  check('鍗忓悓鏂囨。鍗忚鐙珛浜庡師鍨嬨€乑3銆乻erver 鍜?DOM/IO 妯″潡', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/collab-doc.js'), 'utf8');
    return !/^\s*import\s|\brequire\s*\(/m.test(src)
      && !/from\s*['"][^'"]*(?:prototype|viz-schema|server\/|public\/)/.test(src);
  });

  console.log('');
  console.log(`${pass}/${pass + fail} 閫氳繃`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('澶辫触锛? + (e && e.stack ? e.stack : e));
  process.exit(1);
});
