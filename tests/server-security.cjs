/* 本地后端的访问控制回归测试。
 *
 * 为什么必须单独测：这个服务能驱动 pi 执行任意命令，安全边界就是它唯一的防线。
 * 而它的三条边界都**没有视觉表现** —— 令牌没生效、绑到了 0.0.0.0、令牌被打进日志，
 * 界面上一切照常，只有在出事的时候才知道。
 *
 * 覆盖：
 *   1. /api/health 的身份（免认证，因为 Electron 要靠它认亲）
 *   2. 令牌认证：缺失 / 错误 → 401，正确（两种头）→ 200
 *   3. 来源校验：跨站 Origin → 403，同源 → 放行
 *   4. 只监听 127.0.0.1（用本机非回环地址连一次，必须连不上）
 *   5. 令牌绝不出现在日志与错误响应里
 *   6. 开发模式（未配置令牌）仍然保留来源校验
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SEC_PORT || 7797);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'pi-gui-sec-data');

/* 一个足够显眼的令牌：一旦它出现在任何日志/响应里，grep 就能抓到。 */
const TOKEN = 'deadbeef'.repeat(8);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const ok = typeof cond === 'function' ? cond() : cond;
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok && typeof ok === 'string' ? '  → ' + ok : extra ? '  → ' + extra : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本机第一个非回环 IPv4。没有就返回 null（测试会跳过那一项）。 */
function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/** 从外部（非回环地址）连一下端口。连上返回 true。 */
function canReachFromLan(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

function startServer(env) {
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PI_GUI_OPEN: '0', PI_GUI_DATA: DATA, PI_CWD: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = { out: '' };
  srv.stdout.on('data', (d) => (state.out += d));
  srv.stderr.on('data', (d) => (state.out += d));
  state.srv = srv;
  return state;
}

function killServer(state) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(state.srv.pid), '/T', '/F'], { stdio: 'ignore' });
    else state.srv.kill();
  } catch {
    /* 已退出 */
  }
}

async function waitUp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(ORIGIN + '/api/health');
      const body = await r.json().catch(() => null);
      /* 必须确认应答的就是我们的服务。原来只判断「r.status 有值」，
       * 于是端口上任何一个还在跑的东西都能让它返回 true —— 见下面
       * killServerAndWait 的说明，那正是「假红」的帮凶。 */
      if (r.status && body?.app === 'pi-gui') return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  return false;
}

/** 这个端口现在能立刻 bind 上吗。 */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/* 关掉服务，并**等端口真的空出来**再返回。
 *
 * 不能 kill 完 sleep 一个固定时长就算了：Windows 上 `taskkill /T /F` 是异步的，
 * 实测端口要 **819–949ms** 才释放（.probe/race-server-kill.cjs 量了 6 轮）。
 * 原来这里写死 sleep(1000)，余量只剩 50–180ms —— 机器一忙就超时：下一个
 * server.js 启动时 EADDRINUSE 直接退出，而 waitUp() 又连到了**上一个还在跑的**
 * 服务上。症状是全链条跑时偶发假红：「开发模式无令牌可访问」拿到 401、
 * 「日志说明是开发模式」找不到文案；而「跨站 Origin → 403」那条反而照常通过
 * （旧服务确实要求令牌）—— 这个组合就是它的指纹。
 *
 * 改成轮询到端口真空出来，不再依赖时长。 */
async function killServerAndWait(state, timeoutMs = 15000) {
  killServer(state);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portFree(PORT)) return true;
    await sleep(100);
  }
  return false;
}

const req = (p, opts = {}) => fetch(ORIGIN + p, opts);
const jsonReq = async (p, opts) => {
  const r = await req(p, opts);
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, body };
};

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  /* ============ 有令牌（桌面版形态） ============ */
  let st = startServer({ PI_GUI_TOKEN: TOKEN });
  try {
    const up = await waitUp();
    check('后端能起来', () => up || st.out.slice(0, 300));

    /* ---- 1. health 身份 ---- */
    const h = await jsonReq('/api/health');
    check('/api/health 免认证可访问', () => h.status === 200 || `状态 ${h.status}`);
    check('health 声明 app = pi-gui', () => h.body?.app === 'pi-gui' || `app=${JSON.stringify(h.body?.app)}`);
    check('health 声明 protocol = 1', () => h.body?.protocol === 1 || `protocol=${JSON.stringify(h.body?.protocol)}`);
    check('health 带版本号', () => typeof h.body?.version === 'string' && h.body.version.length > 0 || `version=${h.body?.version}`);
    check('health 不泄露令牌', () => JSON.stringify(h.body || {}).includes(TOKEN) === false || '响应里出现了令牌');
    check('health 的字段是白名单（不含多余信息）', () => {
      const keys = Object.keys(h.body || {}).sort().join(',');
      return keys === 'app,ok,protocol,version' || `字段是 ${keys}`;
    });

    /* ---- 2. 令牌认证 ---- */
    const noTok = await jsonReq('/api/status');
    check('无令牌访问 /api/status → 401', () => noTok.status === 401 || `状态 ${noTok.status}`);
    check('401 不回显令牌、也不透露期望值', () => {
      const s = JSON.stringify(noTok.body || {});
      return s.includes(TOKEN) === false || '响应里出现了令牌';
    });

    const wrong = await jsonReq('/api/status', { headers: { 'X-Pi-Gui-Token': 'f'.repeat(64) } });
    check('错误令牌 → 401', () => wrong.status === 401 || `状态 ${wrong.status}`);

    const right = await jsonReq('/api/status', { headers: { 'X-Pi-Gui-Token': TOKEN } });
    check('正确令牌（X-Pi-Gui-Token）→ 200', () => right.status === 200 || `状态 ${right.status}`);

    const bearer = await jsonReq('/api/status', { headers: { Authorization: `Bearer ${TOKEN}` } });
    check('正确令牌（Authorization: Bearer）→ 200', () => bearer.status === 200 || `状态 ${bearer.status}`);

    const cmd = await jsonReq('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'prompt', message: 'hi' }),
    });
    check('无令牌写命令 → 401', () => cmd.status === 401 || `状态 ${cmd.status}`);

    const proj = await jsonReq('/api/projects');
    check('无令牌读项目列表 → 401', () => proj.status === 401 || `状态 ${proj.status}`);

    /* ---- 3. 来源校验 ---- */
    const cross = await jsonReq('/api/status', { headers: { 'X-Pi-Gui-Token': TOKEN, Origin: 'http://evil.example' } });
    check('跨站 Origin + 正确令牌 → 403', () => cross.status === 403 || `状态 ${cross.status}`);

    const same = await jsonReq('/api/status', { headers: { 'X-Pi-Gui-Token': TOKEN, Origin: ORIGIN } });
    check('同源 Origin + 正确令牌 → 200', () => same.status === 200 || `状态 ${same.status}`);

    const localhostOrigin = await jsonReq('/api/status', {
      headers: { 'X-Pi-Gui-Token': TOKEN, Origin: `http://localhost:${PORT}` },
    });
    check('localhost 同源也被放行', () => localhostOrigin.status === 200 || `状态 ${localhostOrigin.status}`);

    /* ---- 4. 只监听回环 ---- */
    const lan = lanIPv4();
    if (lan) {
      const reachable = await canReachFromLan(lan, PORT);
      check(`非回环地址 ${lan}:${PORT} 连不上（只监听 127.0.0.1）`, () => reachable === false || '从局域网地址也能连上，服务暴露了');
    } else {
      check('（跳过）本机没有非回环 IPv4，无法验证监听范围', () => true);
    }

    /* ---- 5. 日志与响应不泄露令牌 ---- */
    check('启动日志里没有令牌', () => st.out.includes(TOKEN) === false || '日志里出现了令牌');
    check('启动日志明确是 127.0.0.1', () => st.out.includes(`http://127.0.0.1:${PORT}`) || '日志没写明回环地址');
    check('启动日志不出现 0.0.0.0', () => st.out.includes('0.0.0.0') === false || '日志暗示可从任意地址访问');
    check('启动日志说明令牌校验已启用', () => /令牌校验已启用/.test(st.out) || '没看到令牌状态提示');

    /* ---- 6. 静态检查：listen 显式绑定回环 + 令牌不进 pi 环境 ----
     *
     * 后端已拆成 server.js + server/*.js。守卫跟着代码走 ——
     * 扫「整个后端源码集合」而不是只扫 server.js，这样以后再把某段逻辑挪到
     * 别的模块里，守卫仍然拦得住；反过来只盯一个文件，就会出现
     * 「代码搬走了、守卫还在原地空转」这种假绿。
     *
     * 令牌那条的正则放宽成任意变量名：rpc-bridge.js 里是
     * `const childEnv = { ...env }; delete childEnv.PI_GUI_TOKEN;`，
     * 写死 `env.` 会漏掉。 */
    /* 递归收集 —— 早先只看 server/ 顶层，加了 agents/ 与 planner/ 之后
     * 这两个子目录整个漏出了扫描范围。源码搬进子目录而守卫没跟上，
     * 会得到一条没有意义的绿灯。 */
    const collectBackend = (dir) => {
      const out = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...collectBackend(full));
        else if (e.name.endsWith('.js')) out.push(full);
      }
      return out;
    };
    const backendSrc = [
      fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'),
      ...collectBackend(path.join(ROOT, 'server')).map((f) => fs.readFileSync(f, 'utf8')),
    ].join('\n');

    check('后端显式 listen 到 127.0.0.1', () => /server\.listen\(\s*PORT\s*,\s*'127\.0\.0\.1'/.test(backendSrc) || '没有显式绑定回环地址');
    check('后端不把令牌交给 pi 子进程', () => /delete\s+[A-Za-z_$][\w$]*\.PI_GUI_TOKEN/.test(backendSrc) || '令牌可能被传给 pi 子进程');

    /* ---- 7. API Key 不得出现在错误响应或日志里 ----
     *
     * 注意：这里**只走校验失败路径**。合法的 POST 会写 ~/.pi/agent/models.json，
     * 那是用户真实的 pi 配置，测试绝不能碰。好在这几条错误分支都在读配置之前
     * 就返回了，既能验到「错误路径不回显密钥」，又没有任何副作用。 */
    const KEY = 'sk-LIVE-0123456789abcdef-DO-NOT-LEAK';
    const withTok = { 'X-Pi-Gui-Token': TOKEN, 'Content-Type': 'application/json' };

    const badName = await jsonReq('/api/providers', {
      method: 'POST',
      headers: withTok,
      body: JSON.stringify({ name: 'bad name!', config: { baseUrl: 'https://x', apiKey: KEY, models: [] } }),
    });
    check('非法供应商名 → 400', () => badName.status === 400 || `状态 ${badName.status}`);
    check('该错误响应不回显 apiKey', () => JSON.stringify(badName.body || {}).includes(KEY) === false || '响应里出现了 apiKey');

    const badModels = await jsonReq('/api/providers', {
      method: 'POST',
      headers: withTok,
      body: JSON.stringify({ name: 'ok-name', config: { baseUrl: 'https://x', api: 'openai-completions', apiKey: KEY, models: 'nope' } }),
    });
    check('models 不是数组 → 400', () => badModels.status === 400 || `状态 ${badModels.status}`);
    check('该错误响应不回显 apiKey', () => JSON.stringify(badModels.body || {}).includes(KEY) === false || '响应里出现了 apiKey');

    const badJson = await req('/api/providers', {
      method: 'POST',
      headers: withTok,
      body: `{"name":"x","config":{"apiKey":"${KEY}"`, // 故意截断
    });
    const badJsonBody = await badJson.text();
    check('请求体不是合法 JSON → 400', () => badJson.status === 400 || `状态 ${badJson.status}`);
    check('该错误响应不回显 apiKey', () => badJsonBody.includes(KEY) === false || '响应里出现了 apiKey');

    check('错误路径全程没有把 apiKey 写进日志', () => st.out.includes(KEY) === false || '日志里出现了 apiKey');
    check('日志语句不引用请求体（结构上避免整包打日志）', () => {
      const lines = backendSrc.split('\n').filter((l) => /console\.(log|error|warn)/.test(l));
      const leaky = lines.filter((l) => /\b(payload|raw|apiKey|body)\b/.test(l));
      return leaky.length === 0 || `可疑行：${leaky[0].trim()}`;
    });
  } finally {
    await killServerAndWait(st);
  }

  /* ============ 无令牌（浏览器开发模式） ============ */
  st = startServer({ PI_GUI_TOKEN: '' });
  try {
    const up = await waitUp();
    check('开发模式后端能起来', () => up || st.out.slice(0, 300));

    const s = await jsonReq('/api/status');
    check('开发模式无令牌可访问（npm start 体验不变）', () => s.status === 200 || `状态 ${s.status}`);

    const cross = await jsonReq('/api/status', { headers: { Origin: 'http://evil.example' } });
    check('开发模式仍然拦跨站 Origin', () => cross.status === 403 || `状态 ${cross.status}`);

    check('开发模式日志说明是开发模式', () => /开发模式/.test(st.out) || '没看到开发模式提示');
  } finally {
    await killServerAndWait(st);
  }

  try {
    fs.rmSync(DATA, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了 */
  }

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 800);
}

main().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
