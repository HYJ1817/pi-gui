/* 后端模块化（server/）的纯单测。
 *
 * 为什么单独一份：拆模块之后，「行为不变」这件事只靠端到端测试（起真服务、
 * 发真请求）验证是不够的 —— 那些用例覆盖面广但定位差，一旦红了要花很久
 * 才能缩小到具体模块。这里对每个新模块做**不依赖网络、不 spawn 进程**的
 * 直接调用，红了立刻知道是谁。
 *
 * 刻意不测的东西：真实的 pi 子进程 spawn（需要装 pi，且会留进程）、
 * 真实文件系统写入（providers / projects 的写路径会碰用户配置）。
 * 这两类留给 server-security / dev-server / git 那几个端到端套件。
 */
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
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}

/* ---------- 极简的 req / res 替身 ---------- */

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

  check('无令牌 → isDevMode', () => dev.isDevMode === true);
  check('有令牌 → 不是 devMode', () => tok.isDevMode === false);

  check('开发模式：不带 Origin 放行', () => dev.denyRequest(mockReq({})) === null);
  check('开发模式：跨站 Origin → 403', () => {
    const d = dev.denyRequest(mockReq({ headers: { origin: 'https://evil.example' } }));
    return (d && d.code === 403) || JSON.stringify(d);
  });
  check('开发模式：127.0.0.1 同源放行', () =>
    dev.denyRequest(mockReq({ headers: { origin: 'http://127.0.0.1:7788' } })) === null);
  check('开发模式：localhost 同源放行', () =>
    dev.denyRequest(mockReq({ headers: { origin: 'http://localhost:7788' } })) === null);
  check('开发模式：端口不同视为跨站 → 403', () => {
    const d = dev.denyRequest(mockReq({ headers: { origin: 'http://127.0.0.1:9999' } }));
    return (d && d.code === 403) || JSON.stringify(d);
  });

  check('有令牌：没带 → 401', () => {
    const d = tok.denyRequest(mockReq({}));
    return (d && d.code === 401) || JSON.stringify(d);
  });
  check('有令牌：X-Pi-Gui-Token 正确 → 放行', () =>
    tok.denyRequest(mockReq({ headers: { [TOKEN_HEADER]: 'secret-token-abc' } })) === null);
  check('有令牌：Bearer 正确 → 放行', () =>
    tok.denyRequest(mockReq({ headers: { authorization: 'Bearer secret-token-abc' } })) === null);
  check('有令牌：错误令牌 → 401', () => {
    const d = tok.denyRequest(mockReq({ headers: { [TOKEN_HEADER]: 'wrong' } }));
    return (d && d.code === 401) || JSON.stringify(d);
  });
  /* timingSafeEqual 对长度不等的 Buffer 会抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH，
   * 所以 tokenEquals 必须先比长度。这条防的就是「拆模块时把长度检查弄丢」。 */
  check('长度不同的令牌不抛异常、判 401', () => {
    const d = tok.denyRequest(mockReq({ headers: { [TOKEN_HEADER]: 'x' } }));
    return (d && d.code === 401) || JSON.stringify(d);
  });
  check('401 响应不回显收到的令牌', () => {
    const d = tok.denyRequest(mockReq({ headers: { [TOKEN_HEADER]: 'leak-me-please' } }));
    return String(d.error).includes('leak-me-please') === false || '错误信息里出现了令牌';
  });
  check('403 响应不回显 Origin', () => {
    const d = dev.denyRequest(mockReq({ headers: { origin: 'https://evil.example' } }));
    return String(d.error).includes('evil.example') === false || '错误信息里出现了 Origin';
  });
  /* 跨站 Origin 必须排在令牌检查**之前** —— 否则一个跨站请求带上偷来的令牌
   * 就能过。这里用一个「Origin 非法 + 令牌正确」的组合来钉住顺序。 */
  check('跨站 Origin 优先于令牌判定（令牌对也拒）', () => {
    const d = tok.denyRequest(
      mockReq({ headers: { origin: 'https://evil.example', [TOKEN_HEADER]: 'secret-token-abc' } })
    );
    return (d && d.code === 403) || JSON.stringify(d);
  });

  {
    const res = mockRes();
    tok.handleHealth(res);
    const payload = JSON.parse(res.body());
    check('health 回 200', () => res.code === 200 || res.code);
    check('health 带 app / protocol / version', () =>
      (payload.app === 'pi-gui' && payload.protocol === 1 && payload.version === '9.9.9') || JSON.stringify(payload));
    check('health 不带任何令牌信息', () => JSON.stringify(payload).includes('secret-token') === false || '响应里出现了令牌');
  }

  /* ================= runtime ================= */
  console.log('\n--- server/runtime.js ---');
  const { createRuntime } = await import('../server/runtime.js');

  const rt = createRuntime({ initialCwd: 'C:\\start' });
  check('初始 cwd 来自构造参数', () => rt.getCurrentCwd() === 'C:\\start' || rt.getCurrentCwd());
  rt.setCurrentCwd('D:\\next');
  check('setCurrentCwd 生效（同一份状态）', () => rt.getCurrentCwd() === 'D:\\next' || rt.getCurrentCwd());
  check('shuttingDown 默认 false', () => rt.isShuttingDown() === false);
  rt.setShuttingDown(true);
  check('setShuttingDown 生效', () => rt.isShuttingDown() === true);
  check('不传 initialCwd 时为 null', () => createRuntime().getCurrentCwd() === null);

  /* ================= sse ================= */
  console.log('\n--- server/sse.js ---');
  const { createEventBus, DEFAULT_BACKLOG_MAX } = await import('../server/sse.js');

  check('backlog 默认上限 = 800', () => DEFAULT_BACKLOG_MAX === 800 || DEFAULT_BACKLOG_MAX);

  {
    const bus = createEventBus();
    bus.publish({ type: 'a' });
    bus.publish({ type: 'b' });
    const bl = bus.backlog();
    check('publish 给事件挂上 _seq', () => bl[0]._seq === 1 && bl[1]._seq === 2 || JSON.stringify(bl.map((e) => e._seq)));
    check('_seq 单调递增', () => bl[1]._seq > bl[0]._seq);
  }

  {
    const bus = createEventBus({ backlogMax: 3 });
    for (let i = 1; i <= 5; i++) bus.publish({ type: 'e', i });
    const bl = bus.backlog();
    check('backlog 超上限后从头丢', () => bl.length === 3 || bl.length);
    check('丢掉的是最老的（留下最后 3 条）', () =>
      bl.map((e) => e.i).join(',') === '3,4,5' || bl.map((e) => e.i).join(','));
    check('_seq 不因丢弃而回退', () => bl[0]._seq === 3 || bl[0]._seq);
  }

  {
    const bus = createEventBus();
    bus.publish({ type: 'before-connect' });
    const req = mockReq();
    const res = mockRes();
    bus.subscribe(req, res);
    check('subscribe 回 200', () => res.code === 200 || res.code);
    check('subscribe 用 text/event-stream', () =>
      String(res.headers['Content-Type']).startsWith('text/event-stream') || res.headers['Content-Type']);
    check('subscribe 关掉缓存与代理缓冲', () =>
      (res.headers['Cache-Control'] === 'no-cache, no-transform' && res.headers['X-Accel-Buffering'] === 'no') ||
      JSON.stringify(res.headers));
    check('连接先补发 backlog', () => res.body().includes('"before-connect"') || res.body().slice(0, 200));
    check('客户端计数 +1', () => bus.clientCount() === 1 || bus.clientCount());
    bus.publish({ type: 'after-connect' });
    check('连上之后的新事件立刻推给客户端', () => res.body().includes('"after-connect"') || res.body().slice(-200));
    check('SSE 帧格式是 data: …\\n\\n', () => /^data: \{.*\}\n\n$/m.test(res.body()) || res.body().slice(0, 80));
    req.emit('close');
    check('连接关闭后从 clients 摘掉', () => bus.clientCount() === 0 || bus.clientCount());
  }

  {
    const bus = createEventBus();
    const req = mockReq();
    const res = mockRes();
    bus.subscribe(req, res);
    bus.closeAll();
    check('closeAll 收掉所有连接', () => (bus.clientCount() === 0 && res.ended) || `count=${bus.clientCount()} ended=${res.ended}`);
    /* subscribe 会起一个 25s 的 ping 定时器。真实服务里它由 req 的 close 事件
     * 清掉（shutdown 之后进程立刻 exit，所以原实现没有在 closeAll 里清）。
     * 测试里必须自己触发一次，否则事件循环挂着，node 永远不退出。 */
    req.emit('close');
  }

  /* ================= http-utils ================= */
  console.log('\n--- server/http-utils.js ---');
  const { json, readRawBody, readBody } = await import('../server/http-utils.js');

  {
    const res = mockRes();
    json(res, 418, { ok: false, error: '茶壶' });
    check('json 设置状态码', () => res.code === 418 || res.code);
    check('json 声明 utf-8 JSON', () =>
      res.headers['Content-Type'] === 'application/json; charset=utf-8' || res.headers['Content-Type']);
    check('json 序列化载荷', () => JSON.parse(res.body()).error === '茶壶' || res.body());
  }

  {
    // 中文切成两半：3 字节字符被 chunk 边界切开，必须靠「先 concat 再解码」还原
    const req = mockReq();
    const p = readRawBody(req, 1024);
    const full = Buffer.from('发酵罐空气分布器', 'utf8');
    req.emit('data', full.subarray(0, 4));
    req.emit('data', full.subarray(4));
    req.emit('end');
    const buf = await p;
    check('readRawBody 按 Buffer 累积（中文不被切坏）', () => buf.toString('utf8') === '发酵罐空气分布器' || buf.toString('utf8'));
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
    check('readRawBody 超限 → reject', () => Boolean(msg) || '没有拒绝');
    check('超限文案含上限（MB）', () => /超过上限/.test(msg) || msg);
  }

  {
    const req = mockReq();
    const p = readBody(req);
    req.emit('data', Buffer.from('{"a":1}', 'utf8'));
    req.emit('end');
    const text = await p;
    check('readBody 返回字符串', () => text === '{"a":1}' || text);
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
    check('无项目时 start 不 spawn，只发 no-project', () =>
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
    check('无项目时 send 抛错', () => Boolean(msg) || '没有抛错');
    check('无项目时 send 的提示给出可执行指引（不是「子进程未运行」）', () =>
      (/添加文件夹/.test(msg) && !/子进程未运行/.test(msg)) || msg);
  }

  {
    const { bridge } = mkBridge('C:\\proj');
    let msg = '';
    try {
      bridge.send({ type: 'prompt' });
    } catch (e) {
      msg = e.message;
    }
    check('有项目但 pi 未起时 send 抛「pi 子进程未运行」', () => /pi 子进程未运行/.test(msg) || msg);
  }

  {
    const { bridge } = mkBridge('C:\\proj', {});
    check('buildArgs 默认带 --mode rpc 与 --continue', () =>
      bridge.buildArgs().join(' ') === '--mode rpc --continue' || bridge.buildArgs().join(' '));
  }
  {
    const { bridge } = mkBridge('C:\\proj', { PI_NO_CONTINUE: '1' });
    check('PI_NO_CONTINUE=1 时不带 --continue', () => bridge.buildArgs().join(' ') === '--mode rpc' || bridge.buildArgs().join(' '));
  }
  {
    const { bridge } = mkBridge('C:\\proj', {
      PI_PROVIDER: 'deepseek',
      PI_MODEL: 'deepseek-chat',
      PI_THINKING: 'high',
      PI_NO_SESSION: '1',
    });
    const a = bridge.buildArgs().join(' ');
    check('provider / model / thinking / no-session 都透传', () =>
      a === '--mode rpc --continue --provider deepseek --model deepseek-chat --thinking high --no-session' || a);
  }

  {
    const { bridge } = mkBridge('C:\\proj');
    const st = bridge.getState();
    check('getState 报 piRunning=false（未启动）', () => st.piRunning === false || st.piRunning);
    check('getState 的 pid 为 null', () => st.pid === null || st.pid);
    check('getState 带 cwd 与 hasProject', () => (st.cwd === 'C:\\proj' && st.hasProject === true) || JSON.stringify(st));
    check('getState 带 args', () => Array.isArray(st.args) && st.args.length > 0 || JSON.stringify(st.args));
  }

  /* ---------- projectLaunch 注入 ----------
   *
   * rpc-bridge 不知道项目配置里有什么，只认 prepareLaunch()（spawn 前，允许写文件）
   * 与 launchArgs()（纯读）两个方法。这一段盯住的就是这两条契约：
   * 参数有没有被追加、抛错会不会带塌启动、纯读路径会不会被误当成写路径。
   * 真正的「写文件」由 tests/project-config.cjs 覆盖。 */
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
      check('projectLaunch 的参数被追加到启动参数末尾', () =>
        b.buildArgs().join(' ') === '--mode rpc --continue --thinking high' || b.buildArgs().join(' '));
      check('projectLaunch 的参数出现在 getState().args 里（界面能看到真实启动参数）', () =>
        b.getState().args.join(' ').includes('--thinking high') || b.getState().args.join(' '));
    }
    {
      // 环境变量已经给了 --thinking 时，项目配置不该再给一份（否则后者覆盖前者）
      const b = mkWithLaunch(
        'C:\\proj',
        { launchArgs: () => ({ args: [], warnings: [] }) },
        { PI_THINKING: 'low' }
      );
      check('环境变量与项目配置不会给出两份 --thinking', () => {
        const a = b.buildArgs();
        return a.filter((x) => x === '--thinking').length === 1 || a.join(' ');
      });
    }
    {
      const b = mkWithLaunch('C:\\proj', {
        launchArgs: () => {
          throw new Error('配置读坏了');
        },
      });
      check('projectLaunch 抛错时不带塌 buildArgs（退回不带项目参数）', () =>
        b.buildArgs().join(' ') === '--mode rpc --continue' || b.buildArgs().join(' '));
    }
    {
      /* 无项目 → start() 在拿到 cwd 之前就返回了，所以既不会 spawn pi，
       * 也不会走到 prepareLaunch。这一条的价值是：确认「没有项目时后端
       * 不往任何目录写东西」—— prepareLaunch 是会写文件的。 */
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
      check('无项目时 start() 不调 prepareLaunch（不启动 pi，也不写任何文件）', () =>
        (prepared === 0 && events.length === 1 && events[0].state === 'no-project') || JSON.stringify({ prepared, events }));
    }

    // 顺序契约：prepareLaunch（可能写文件）必须在 buildArgs 之前调用，
    // 否则刚同步出来的指令文件不会被带上参数。用源码顺序守住它 ——
    // 这条顺序错了的表现是「指令保存了但这次启动没生效」，很难从外部看出来。
    const src = fs.readFileSync(path.join(SERVER_DIR, 'rpc-bridge.js'), 'utf8');
    check('rpc-bridge 里 prepareLaunch() 排在 buildArgs(extra) 之前', () => {
      const p = src.indexOf('projectLaunch.prepareLaunch()');
      const b = src.indexOf('buildArgs(extra)');
      return (p !== -1 && b !== -1 && p < b) || `prepareLaunch@${p} buildArgs@${b}`;
    });
    check('rpc-bridge 不 import 任何业务模块（只靠注入认识项目配置）', () => {
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      return imports.every((i) => i.startsWith('node:')) || imports.join(',');
    });
  }
  {
    const { bridge } = mkBridge(null);
    const st = bridge.getState();
    check('无项目时 hasProject=false', () => st.hasProject === false || JSON.stringify(st));
  }

  /* ================= router ================= */
  console.log('\n--- server/router.js ---');
  const { createRouter } = await import('../server/router.js');

  /* 用真的 auth / sse / runtime，其余处理器用替身 ——
   * 这一段的重点是**分发顺序**，不是各处理器的业务。 */
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
    skills: { handle: stub('skills') },
    mcp: { handle: stub('mcp') },
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

  check('/api/health 免认证（不带令牌也 200）', () => {
    const res = hit('GET', '/api/health');
    return res.code === 200 || res.code;
  });
  check('/api/health 走的是 auth 自己的处理器', () => {
    const res = hit('GET', '/api/health');
    return JSON.parse(res.body()).app === 'pi-gui' || res.body();
  });
  check('其余 /api/* 不带令牌 → 401', () => {
    const res = hit('GET', '/api/status');
    return res.code === 401 || res.code;
  });
  check('/api/status 带令牌 → 200 且来自 rpc.getState', () => {
    const res = hit('GET', '/api/status', authHeaders);
    return (res.code === 200 && JSON.parse(res.body()).handler === 'rpc.getState') || res.body();
  });
  check('跨站 Origin + 正确令牌仍被 403（Origin 先判）', () => {
    const res = hit('GET', '/api/status', { ...authHeaders, origin: 'https://evil.example' });
    return res.code === 403 || res.code;
  });

  /* 顺序：/api/providers/models 必须命中 handleModels，
   * 而不是被 /api/providers 前缀吞掉当成「保存一个叫 models 的供应商」。 */
  check('/api/providers/models 命中 handleModels（不被前缀吞掉）', () => {
    calls.length = 0;
    hit('POST', '/api/providers/models', authHeaders);
    return calls[0] === 'providers.models' || calls.join(',');
  });
  check('/api/providers 命中 providers', () => {
    calls.length = 0;
    hit('GET', '/api/providers', authHeaders);
    return calls[0] === 'providers' || calls.join(',');
  });
  check('/api/providers/foo 命中 providers（前缀）', () => {
    calls.length = 0;
    hit('DELETE', '/api/providers/foo', authHeaders);
    return calls[0] === 'providers' || calls.join(',');
  });
  check('/api/projects/activate 命中 projects（前缀）', () => {
    calls.length = 0;
    hit('POST', '/api/projects/activate', authHeaders);
    return calls[0] === 'projects' || calls.join(',');
  });
  check('/api/fs 命中 projects.handleFs', () => {
    calls.length = 0;
    hit('GET', '/api/fs', authHeaders);
    return calls[0] === 'projects.fs' || calls.join(',');
  });
  check('/api/git/status 命中 gitRoutes', () => {
    calls.length = 0;
    hit('GET', '/api/git/status', authHeaders);
    return calls[0] === 'git' || calls.join(',');
  });
  check('/api/git 命中 gitRoutes（不带子路径）', () => {
    calls.length = 0;
    hit('POST', '/api/git', authHeaders);
    return calls[0] === 'git' || calls.join(',');
  });
  check('/api/upload 命中 uploads', () => {
    calls.length = 0;
    hit('POST', '/api/upload', authHeaders);
    return calls[0] === 'uploads' || calls.join(',');
  });
  check('/api/events 命中 sse.subscribe', () => {
    calls.length = 0;
    hit('GET', '/api/events', authHeaders);
    return calls[0] === 'sse' || calls.join(',');
  });
  check('/api/restart 命中 rpc.restart', () => {
    calls.length = 0;
    hit('POST', '/api/restart', authHeaders);
    return calls[0] === 'rpc.restart' || calls.join(',');
  });

  /* 项目配置刻意用了独立的顶层路径而不是 /api/projects/config ——
   * 后者会被上面那条 /api/projects/ 前缀匹配吃掉（前缀在它之前），
   * 而且症状是静默的：GET 返回项目列表、PUT 落进 405，都不是报错。 */
  check('/api/project-config 命中 projectConfig（不被 /api/projects 前缀吃掉）', () => {
    calls.length = 0;
    hit('GET', '/api/project-config', authHeaders);
    return calls[0] === 'projectConfig' || calls.join(',');
  });
  check('/api/project-config 的 PUT 也命中 projectConfig', () => {
    calls.length = 0;
    hit('PUT', '/api/project-config', authHeaders);
    return calls[0] === 'projectConfig' || calls.join(',');
  });
  check('/api/projects 仍然命中 projects（两条路径不互相遮蔽）', () => {
    calls.length = 0;
    hit('GET', '/api/projects', authHeaders);
    return calls[0] === 'projects' || calls.join(',');
  });

  /* 扩展能力：Skills 有 PUT（启停），所以必须排在「非 GET → 405」之前。 */
  check('GET /api/skills 命中 skills', () => {
    calls.length = 0;
    hit('GET', '/api/skills', authHeaders);
    return calls[0] === 'skills' || calls.join(',');
  });
  check('PUT /api/skills/<id> 命中 skills（不被 405 兜底吃掉）', () => {
    calls.length = 0;
    const res = hit('PUT', '/api/skills/abcdef0123456789', authHeaders);
    return (calls[0] === 'skills' && res.code !== 405) || calls.join(',') + '/' + res.code;
  });
  check('GET /api/skills/<id> 命中 skills', () => {
    calls.length = 0;
    hit('GET', '/api/skills/abcdef0123456789', authHeaders);
    return calls[0] === 'skills' || calls.join(',');
  });
  check('GET /api/mcp 命中 mcp', () => {
    calls.length = 0;
    hit('GET', '/api/mcp', authHeaders);
    return calls[0] === 'mcp' || calls.join(',');
  });
  check('/api/skills 不带令牌 → 401（和其余 /api/* 一样过访问控制）', () => {
    const res = hit('GET', '/api/skills');
    return res.code === 401 || res.code;
  });
  check('/api/mcp 不带令牌 → 401', () => {
    const res = hit('GET', '/api/mcp');
    return res.code === 401 || res.code;
  });
  check('/api/skills 不遮蔽 /api/projects（前缀不重叠）', () => {
    calls.length = 0;
    hit('GET', '/api/projects/abc', authHeaders);
    return calls[0] === 'projects' || calls.join(',');
  });

  /* ---- Planner / Agent 编排（P5） ---- */

  check('GET /api/agents 命中 planner', () => {
    const res = hit('GET', '/api/agents', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('GET /api/plans 命中 planner', () => {
    const res = hit('GET', '/api/plans', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('POST /api/plans 命中 planner（不被 405 兜底吃掉）', () => {
    const res = hit('POST', '/api/plans', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('POST /api/plans/<id>/start 命中 planner', () => {
    const res = hit('POST', '/api/plans/plan-1/start', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('POST /api/plans/<id>/tasks/<tid>/retry 命中 planner', () => {
    const res = hit('POST', '/api/plans/plan-1/tasks/t1/retry', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('GET /api/plans/<id> 命中 planner', () => {
    const res = hit('GET', '/api/plans/plan-1', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('PUT /api/plans/<id> 命中 planner（不被 405 兜底吃掉）', () => {
    const res = hit('PUT', '/api/plans/plan-1', authHeaders);
    return JSON.parse(res.body()).handler === 'planner' || res.body();
  });
  check('/api/plans 不带令牌 → 401', () => {
    const res = hit('GET', '/api/plans');
    return res.code === 401 || res.code;
  });
  check('/api/agents 不带令牌 → 401', () => {
    const res = hit('GET', '/api/agents');
    return res.code === 401 || res.code;
  });
  check('/api/plans 不遮蔽 /api/projects（前缀不重叠）', () => {
    const res = hit('GET', '/api/projects', authHeaders);
    return JSON.parse(res.body()).handler === 'projects' || res.body();
  });
  check('/api/agents 不遮蔽 /api/plans（两者是独立路径）', () => {
    const a = hit('GET', '/api/agents', authHeaders);
    const b = hit('GET', '/api/plans', authHeaders);
    return (JSON.parse(a.body()).handler === 'planner' && JSON.parse(b.body()).handler === 'planner') || a.body() + ' / ' + b.body();
  });

  /* Git 前缀必须排在「非 GET → 405」之前，否则 /api/git/status 会被 405 掉。 */
  check('GET /api/git/status 不被 405 兜底吃掉', () => {
    const res = hit('GET', '/api/git/status', authHeaders);
    return res.code !== 405 || res.code;
  });
  check('未知非 GET 路径 → 405', () => {
    const res = hit('POST', '/definitely-not-a-route');
    return res.code === 405 || res.code;
  });
  check('未知 GET 路径 → 404（静态兜底）', () => {
    const res = hit('GET', '/nope-does-not-exist.js');
    return res.code === 404 || res.code;
  });

  /* 静态资源：真的读 public/，确认 router 没把这条链路弄丢 */
  check('根路径能取到 index.html', () => {
    const res = hit('GET', '/');
    return (res.code === 200 && res.body().includes('<title>Pi GUI</title>')) || res.code;
  });
  check('静态资源声明 no-store', () => {
    const res = hit('GET', '/');
    return res.headers['Cache-Control'] === 'no-store' || res.headers['Cache-Control'];
  });
  /* 目录穿越要挑**真能抵达守卫**的向量。
   *
   * 实测（WHATWG URL 的路径归一化）：
   *   '/../server.js'       → pathname '/server.js'      ← 被 URL 自己吃掉了
   *   '/%2e%2e/server.js'   → pathname '/server.js'      ← %2e 也当点段处理
   *   '/..%5cserver.js'     → pathname 原样保留           ← 这条才到得了守卫
   * %5c 是反斜杠，URL 不把它当分隔符，但 serveStatic 会先把 \ 换成 / 再归一化，
   * 于是 '../server.js' 露出来被拦。所以下面用这个形式测，不是随便挑一个。 */
  check('目录穿越（..%5c）被 403 挡住', () => {
    const res = hit('GET', '/..%5cserver.js');
    return res.code === 403 || res.code;
  });
  check('穿越被挡住时不留任何文件内容', () => {
    const res = hit('GET', '/..%5cserver.js');
    return res.body().includes('createRpcBridge') === false || '响应里漏出了源码';
  });
  check('编码的点段形式被 URL 归一化后落到 404（不报错、不漏文件）', () => {
    const res = hit('GET', '/%2e%2e/server.js');
    return res.code === 404 || res.code;
  });
  check('静态资源的 Content-Type 按扩展名给', () => {
    const res = hit('GET', '/styles.css');
    return String(res.headers['Content-Type']).startsWith('text/css') || res.headers['Content-Type'];
  });

  /* ================= 模块边界 ================= */
  console.log('\n--- 依赖方向（不许成环） ---');

  /* 递归收集 server/ 下**所有** .js。
   *
   * 早先是 `readdirSync(SERVER_DIR).filter(.js)` —— 只看顶层。加了
   * server/agents/ 与 server/planner/ 之后，这两个子目录**完全没被扫到**，
   * 守卫仍然全绿但已经不覆盖新代码了。这种「代码搬走了、守卫还在原地空转」
   * 的假绿比没有守卫更危险，所以改成递归。 */
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

  check(`server/ 递归扫到 ${files.length} 个模块（含 agents/ 与 planner/）`, () => files.length >= 15 || files.length);
  check('server/ 下的模块只 import 同目录兄弟、http-utils 或 lib', () => {
    /* 规则：
     *   - 同一个目录里的兄弟 → 允许（agents/ 内部、planner/ 内部）
     *   - lib/（仓库根的共享库）→ 允许
     *   - server/http-utils.js → **显式放行**：它是被五条链路共用的 HTTP 工具，
     *     不是一个业务模块。和已有的「git-routes → lib/git.js」是同一类例外。
     *   - 其它跨目录 import → 不允许。跨子系统协作一律走 server.js 装配 + 依赖注入。 */
    const bad = [];
    for (const f of files) {
      const rel = relOf(f);
      for (const spec of rawImports.get(rel)) {
        if (!spec.startsWith('.')) continue;
        const abs = path.resolve(path.dirname(f), spec);
        if (serverSet.has(abs)) {
          const sameDir = path.dirname(abs) === path.dirname(f);
          if (!sameDir && abs !== HTTP_UTILS) bad.push(`${rel} → ${spec}`);
          continue;
        }
        if (!abs.startsWith(LIB_DIR)) bad.push(`${rel} → ${spec}`);
      }
    }
    return bad.length === 0 || bad.join(', ');
  });

  check('没有任何模块 import server.js（否则成环）', () => {
    const bad = [];
    for (const f of files) {
      for (const spec of rawImports.get(relOf(f))) {
        if (!spec.startsWith('.')) continue;
        if (path.resolve(path.dirname(f), spec) === SERVER_JS) bad.push(relOf(f));
      }
    }
    return bad.length === 0 || bad.join(', ');
  });

  check('模块之间无循环依赖', () => {
    const cycles = [];
    const seen = new Set();
    const keys = [...deps.keys()];
    const walk = (node, stack) => {
      if (stack.includes(node)) {
        cycles.push([...stack, node].join(' → '));
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

  check('router.js 不 import 任何业务模块（只依赖 http-utils 与 lib）', () => {
    const d = deps.get('server/router.js') || [];
    const bad = d.filter((x) => x !== 'server/http-utils.js');
    return bad.length === 0 || bad.join(', ');
  });

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
