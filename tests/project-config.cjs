/* 项目配置（server/project-config.js）的测试。
 *
 * 为什么单独一份：这个模块的绝大部分代码是**边界处理** —— 文件不存在、
 * 空文件、非法 JSON、类型错、超长、权限不足、version 不认识。这些分支在
 * 正常使用的路径上一条都不会走到，只有构造出来才测得到。
 *
 * 全部在 os.tmpdir() 里造临时项目，绝不碰真实项目（规格第 23 节）。
 * 不 spawn 进程、不联网。最后一节会真跑一次 esbuild 把 server.js 打成单文件，
 * 在**产物**里找本模块的指纹 —— 「开发能跑、装包缺模块」只有这一种测法。
 *
 * 用法：node tests/project-config.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

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
function section(t) {
  console.log('\n--- ' + t + ' ---');
}

/* ---------- 极简 req / res 替身 ----------
 *
 * readRawBody 走的是 req.on('data') / req.on('end')，所以桩必须有 emit；
 * 只给 asyncIterator 是读不到请求体的（第一版就是这么写错的，表现为
 * 所有 PUT 都静默什么都没发生 —— 正好也是这个桩要防的那类 bug）。 */

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
    jsonBody() {
      try {
        return JSON.parse(this.body());
      } catch {
        return null;
      }
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

/** 等 Promise 链跑完（readBody → then → json）。 */
const settle = () => new Promise((r) => setImmediate(r));

/**
 * 驱动一次 HTTP 处理。
 *
 * 顺序很关键：先调 handler（它同步注册 data/end 监听），再 emit 请求体 ——
 * 反了就什么都读不到。
 */
async function call(pc, method, url, { headers = {}, body = '' } = {}) {
  const req = mockReq({ method, url, headers });
  const res = mockRes();
  pc.handle(req, res, new URL(url, 'http://127.0.0.1:7788'));
  if (body) {
    req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  }
  await settle();
  await settle();
  return res;
}

const putJSON = (pc, payload) =>
  call(pc, 'PUT', '/api/project-config', { body: JSON.stringify(payload) });

/* ---------- 临时项目 ---------- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-cfg-'));
const created = [TMP];
function mkProject(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}
function cleanup() {
  for (const d of created.reverse()) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows 上偶发占用，忽略 */
    }
  }
}

(async () => {
  const {
    createProjectConfig,
    defaultConfig,
    DEFAULT_CONFIG,
    normalizeConfig,
    CONFIG_VERSION,
    LIMITS,
    THINKING_LEVELS,
    configPath,
    instructionsPath,
    DIR_NAME,
  } = await import('../server/project-config.js');

  /** 假 runtime。只实现 project-config 用到的那一个方法。 */
  const mkRuntime = (cwd = null) => {
    let cur = cwd;
    return {
      getCurrentCwd: () => cur,
      setCurrentCwd: (v) => {
        cur = v;
      },
    };
  };

  const mk = (cwd, env = {}, restartPi = null) =>
    createProjectConfig({ runtime: mkRuntime(cwd), env, restartPi });

  /* ================= 1 / 2 / 3：无项目、无配置、默认值 ================= */
  section('无项目 / 无配置 / 默认值');

  {
    const pc = mk(null);
    const r = pc.read();
    check('1. 无项目时 read() 报 hasProject=false 且 config=null', () =>
      (r.hasProject === false && r.config === null && r.path === null) || JSON.stringify(r));

    const res = await call(pc, 'GET', '/api/project-config');
    const b = res.jsonBody();
    check('1. 无项目 GET → 200 且 ok=true（不是 500）', () => (res.code === 200 && b && b.ok === true) || JSON.stringify(b));
    check('1. 无项目 GET 的 config 为 null、hasProject 为 false', () =>
      (b && b.hasProject === false && b.config === null) || JSON.stringify(b));

    const putRes = await putJSON(pc, { thinking: 'high' });
    check('1. 无项目 PUT → 200 且明确说没项目（不假装成功、不 500）', () =>
      (putRes.code === 200 &&
        putRes.jsonBody() &&
        putRes.jsonBody().ok === false &&
        /没有选择项目/.test(putRes.jsonBody().error)) ||
      JSON.stringify(putRes.jsonBody()));

    check('1. 无项目时 launchArgs() 返回空参数', () => pc.launchArgs().args.length === 0 || JSON.stringify(pc.launchArgs()));
  }

  {
    const dir = mkProject('empty-proj');
    const pc = mk(dir);
    const r = pc.read();
    check('2. 项目存在但无配置文件 → exists=false、path 指向 .pi-gui/config.json', () =>
      (r.exists === false && r.path === configPath(dir) && r.hasProject === true) || JSON.stringify(r));
    check('2. 无配置文件时读到的就是默认配置', () => JSON.stringify(r.config) === JSON.stringify(defaultConfig()) || JSON.stringify(r.config));
    check('2. 无配置文件不产生任何警告', () => r.warnings.length === 0 || JSON.stringify(r.warnings));
    check('2. 读一次不会把 .pi-gui 目录创建出来', () => !fs.existsSync(path.join(dir, DIR_NAME)) || '目录被创建了');

    const res = await call(pc, 'GET', '/api/project-config');
    const b = res.jsonBody();
    check('2. GET 无配置 → 200 / ok=true / exists=false / 返回默认配置', () =>
      (res.code === 200 && b.ok === true && b.hasProject === true && b.exists === false && b.config.thinking === null) ||
      JSON.stringify(b));
  }

  check('3. DEFAULT_CONFIG 被冻结（改不动）', () => Object.isFrozen(DEFAULT_CONFIG) || '没冻结');
  check('3. defaultConfig() 每次返回新对象（改一个不影响另一个）', () => {
    const a = defaultConfig();
    const b = defaultConfig();
    a.ignore.push('x');
    a.model = { provider: 'p', id: 'i' };
    return (b.ignore.length === 0 && b.model === null) || JSON.stringify(b);
  });
  check('3. 默认配置的字段集合固定', () =>
    JSON.stringify(Object.keys(defaultConfig()).sort()) ===
      JSON.stringify(['commands', 'ignore', 'instructions', 'model', 'thinking', 'version'].sort()) ||
    Object.keys(defaultConfig()).join(','));
  check('3. 默认 version 等于 CONFIG_VERSION', () => defaultConfig().version === CONFIG_VERSION || defaultConfig().version);

  /* ================= 4 / 8：正常读取与未知字段 ================= */
  section('正常读取 / 未知字段');

  {
    const dir = mkProject('read-ok');
    fs.mkdirSync(path.join(dir, DIR_NAME), { recursive: true });
    fs.writeFileSync(
      configPath(dir),
      JSON.stringify({
        version: 1,
        model: { provider: 'deepseek', id: 'deepseek-chat', apiKey: 'sk-LEAK-1' },
        thinking: 'high',
        instructions: '这个项目用 TypeScript',
        ignore: ['node_modules', 'dist'],
        commands: [{ name: 'Test', command: 'npm test' }],
        // 未知字段：既不该进内存也不该被写回去
        apiKey: 'sk-LEAK-2',
        token: 'T-LEAK',
        projectPath: 'C:/elsewhere',
        foo: { bar: 1 },
      }) + '\n',
      'utf8'
    );

    const pc = mk(dir);
    const r = pc.read();
    check('4. 正常读取：模型 / 思考 / 指令 / 忽略 / 命令都对得上', () =>
      (r.config.model.provider === 'deepseek' &&
        r.config.model.id === 'deepseek-chat' &&
        r.config.thinking === 'high' &&
        r.config.instructions === '这个项目用 TypeScript' &&
        r.config.ignore.join(',') === 'node_modules,dist' &&
        r.config.commands.length === 1 &&
        r.config.commands[0].command === 'npm test') ||
      JSON.stringify(r.config));

    check('8. 未知顶层字段被丢弃（apiKey / token / projectPath / foo 都不在结果里）', () => {
      const keys = Object.keys(r.config);
      return keys.every((k) => ['version', 'model', 'thinking', 'instructions', 'ignore', 'commands'].includes(k)) || keys.join(',');
    });
    check('8. 模型对象里的多余字段（apiKey）也被丢弃', () =>
      JSON.stringify(Object.keys(r.config.model).sort()) === JSON.stringify(['id', 'provider']) ||
      Object.keys(r.config.model).join(','));

    await putJSON(pc, { ignore: ['build'] });
    const onDisk = fs.readFileSync(configPath(dir), 'utf8');
    check('8. 保存后盘上不再残留未知字段', () => !/sk-LEAK|T-LEAK|projectPath|"foo"/.test(onDisk) || onDisk.slice(0, 300));
    check('4/8. 合并式保存：只改 ignore 不会把 model / instructions 抹掉', () => {
      const r2 = pc.read();
      return (
        r2.config.ignore.join(',') === 'build' &&
        r2.config.model.id === 'deepseek-chat' &&
        r2.config.instructions === '这个项目用 TypeScript'
      ) || JSON.stringify(r2.config);
    });
  }

  /* ================= 5 / 6：正常写入与原子写 ================= */
  section('写入与原子写');

  {
    const dir = mkProject('write-ok');
    const pc = mk(dir);
    const res = await putJSON(pc, {
      model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
      thinking: 'medium',
      instructions: '不要改 generated/',
      ignore: ['node_modules'],
      commands: [{ name: 'Build', command: 'npm run build' }],
    });
    const b = res.jsonBody();
    check('5. PUT 成功 → 200 / ok=true / 回传路径与配置', () =>
      (res.code === 200 && b.ok === true && b.path === configPath(dir) && b.config.model.provider === 'anthropic') || JSON.stringify(b));
    check('5. 盘上文件是格式化 JSON 且以换行结尾', () => {
      const text = fs.readFileSync(configPath(dir), 'utf8');
      return (/\n$/.test(text) && text.includes('\n  "thinking"')) || JSON.stringify(text.slice(0, 120));
    });
    await putJSON(pc, { version: 99, thinking: 'low' });
    check('5. version 由后端定，客户端指定不了', () =>
      JSON.parse(fs.readFileSync(configPath(dir), 'utf8')).version === CONFIG_VERSION ||
      fs.readFileSync(configPath(dir), 'utf8'));

    check('6. 写入后 .pi-gui 里不留临时文件', () => {
      const files = fs.readdirSync(path.join(dir, DIR_NAME));
      return files.every((f) => !f.endsWith('.tmp')) || files.join(',');
    });

    // 失败路径：把 config.json 换成目录，rename 一定失败
    const dir2 = mkProject('write-fail');
    const gdir = path.join(dir2, DIR_NAME);
    fs.mkdirSync(path.join(gdir, 'config.json'), { recursive: true });
    const pc2 = mk(dir2);
    const failRes = await putJSON(pc2, { thinking: 'high' });
    check('6/21. 目标不可写 → 500 且 ok=false（不假装保存成功）', () =>
      (failRes.code === 500 && failRes.jsonBody() && failRes.jsonBody().ok === false) || JSON.stringify(failRes.jsonBody()));
    check('6/21. 写失败时错误信息说清了「保存失败」', () =>
      /保存失败/.test(String(failRes.jsonBody() && failRes.jsonBody().error)) || JSON.stringify(failRes.jsonBody()));
    check('6. 写失败后不留临时文件（临时文件被清掉）', () => {
      const files = fs.readdirSync(gdir);
      return files.every((f) => !f.endsWith('.tmp')) || files.join(',');
    });
    check('6. 写失败不会破坏原有内容（原目录还在）', () => fs.statSync(path.join(gdir, 'config.json')).isDirectory() || '被覆盖了');
  }

  /* ================= 7 / 21：损坏与异常 ================= */
  section('损坏 / 异常 / 版本');

  {
    const dir = mkProject('bad-json');
    fs.mkdirSync(path.join(dir, DIR_NAME), { recursive: true });
    const broken = '{ "thinking": "high", oops }';
    fs.writeFileSync(configPath(dir), broken, 'utf8');
    const pc = mk(dir);
    const r = pc.read();
    check('7. 非法 JSON → 退回默认配置，不抛', () => (r.config && r.config.thinking === null) || JSON.stringify(r.config));
    check('7. 非法 JSON → 有一条说明性警告', () => r.warnings.some((w) => /不是合法 JSON/.test(w)) || JSON.stringify(r.warnings));
    check('7. 非法 JSON 时**不自动覆盖**损坏文件（用户没保存就不动它）', () =>
      fs.readFileSync(configPath(dir), 'utf8') === broken || '文件被改写了');

    const res = await call(pc, 'GET', '/api/project-config');
    check('7. 损坏配置下 GET 仍 200（不因为配置坏了打不开项目）', () => res.code === 200 || res.code);
    check('7. GET 把警告透出来（前端能提示用户）', () =>
      (res.jsonBody().warnings || []).some((w) => /不是合法 JSON/.test(w)) || JSON.stringify(res.jsonBody().warnings));
  }

  {
    const dir = mkProject('empty-file');
    fs.mkdirSync(path.join(dir, DIR_NAME), { recursive: true });
    fs.writeFileSync(configPath(dir), '   \n', 'utf8');
    const r = mk(dir).read();
    check('21. 空文件 → 默认配置 + 警告', () => (r.config.thinking === null && r.warnings.some((w) => /空文件/.test(w))) || JSON.stringify(r));
  }

  {
    const dir = mkProject('future-version');
    fs.mkdirSync(path.join(dir, DIR_NAME), { recursive: true });
    const future = JSON.stringify({ version: 99, thinking: 'high', somethingNew: true });
    fs.writeFileSync(configPath(dir), future, 'utf8');
    const r = mk(dir).read();
    check('21. version 高于支持 → 不崩、退回默认值', () => r.config.thinking === null || JSON.stringify(r.config));
    check('21. version 高于支持 → 警告里点明版本号与备份建议', () =>
      r.warnings.some((w) => /version=99/.test(w) && /备份/.test(w)) || JSON.stringify(r.warnings));
    check('21. version 高于支持 → 不动原文件', () => fs.readFileSync(configPath(dir), 'utf8') === future || '被改写了');
  }

  {
    const r = normalizeConfig({ version: 'abc', thinking: 'high' });
    check('21. version 不是数字 → 按当前版本处理 + 警告', () =>
      (r.config.thinking === 'high' && r.warnings.some((w) => /version/.test(w))) || JSON.stringify(r));
  }
  {
    const r = normalizeConfig({ thinking: 'low' });
    check('3. 缺少 version 字段 → 按当前版本处理，无警告', () => (r.config.thinking === 'low' && r.warnings.length === 0) || JSON.stringify(r));
  }
  {
    const r = normalizeConfig([1, 2, 3]);
    check('21. 顶层是数组 → 默认值 + 警告', () => (r.config.model === null && r.warnings.length > 0) || JSON.stringify(r));
  }
  {
    const r = normalizeConfig({ model: { provider: 'p', id: 'i' } });
    check('3. 只给一部分字段时，其余字段用默认值', () =>
      (r.config.thinking === null && r.config.instructions === '' && r.config.ignore.length === 0 && r.config.commands.length === 0) ||
      JSON.stringify(r.config));
  }

  /* ================= 9：类型错误 ================= */
  section('类型错误');

  {
    const cases = [
      ['model 是字符串', { model: 'deepseek/chat' }, (c) => c.model === null],
      ['model 缺 id', { model: { provider: 'p' } }, (c) => c.model === null],
      ['model 是数组', { model: [{ provider: 'p', id: 'i' }] }, (c) => c.model === null],
      ['thinking 是数字', { thinking: 5 }, (c) => c.thinking === null],
      ['thinking 不在 pi 的档位里', { thinking: 'bogus' }, (c) => c.thinking === null],
      ['instructions 是数字', { instructions: 42 }, (c) => c.instructions === ''],
      ['ignore 是字符串', { ignore: 'node_modules' }, (c) => c.ignore.length === 0],
      ['ignore 里混了非字符串', { ignore: ['ok', 3, null, '  ', 'ok'] }, (c) => c.ignore.join(',') === 'ok'],
      ['commands 是对象', { commands: { a: 1 } }, (c) => c.commands.length === 0],
      ['commands 条目缺 command', { commands: [{ name: 'X' }] }, (c) => c.commands.length === 0],
      ['commands 条目是字符串', { commands: ['npm test'] }, (c) => c.commands.length === 0],
    ];
    for (const [label, input, test] of cases) {
      const r = normalizeConfig(input);
      check('9. ' + label + ' → 退回默认值且有警告', () =>
        (test(r.config) && r.warnings.length > 0) || JSON.stringify({ config: r.config, warnings: r.warnings }));
    }
  }

  /* ================= 10 / 11 / 12：上限 ================= */
  section('长度与数量上限');

  {
    const big = 'x'.repeat(40 * 1024);
    const r = normalizeConfig({ instructions: big });
    check('10. 超长 instructions 被截到上限', () => r.config.instructions.length === LIMITS.instructions || r.config.instructions.length);
    check('10. 超长 instructions 有警告', () => r.warnings.some((w) => /KB/.test(w)) || JSON.stringify(r.warnings));

    const dir = mkProject('big-instr');
    const pc = mk(dir);
    await putJSON(pc, { instructions: big });
    const saved = JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
    check('10. 写盘时也截断（不是只在响应里截断）', () => saved.instructions.length === LIMITS.instructions || saved.instructions.length);
  }

  {
    const many = Array.from({ length: LIMITS.ignore + 60 }, (_, i) => 'dir' + i);
    const r = normalizeConfig({ ignore: many });
    check('11. ignore 数量超上限被截断', () => r.config.ignore.length === LIMITS.ignore || r.config.ignore.length);
    check('11. ignore 截断有警告', () => r.warnings.some((w) => /ignore 超过/.test(w)) || JSON.stringify(r.warnings));
  }

  {
    const many = Array.from({ length: LIMITS.commands + 20 }, (_, i) => ({ name: 'c' + i, command: 'echo ' + i }));
    const r = normalizeConfig({ commands: many });
    check('12. commands 数量超上限被截断', () => r.config.commands.length === LIMITS.commands || r.config.commands.length);
    check('12. commands 截断有警告', () => r.warnings.some((w) => /commands 超过/.test(w)) || JSON.stringify(r.warnings));
  }

  {
    const r = normalizeConfig({ ignore: ['a'.repeat(1000)], commands: [{ name: 'n'.repeat(500), command: 'c'.repeat(2000) }] });
    check('12. 单项过长被截断（ignore 单项 / 命令名 / 命令体）', () =>
      (r.config.ignore[0].length === LIMITS.ignoreItem &&
        r.config.commands[0].name.length === LIMITS.commandName &&
        r.config.commands[0].command.length === LIMITS.commandText) ||
      JSON.stringify(r.config));
  }

  /* ================= 13 / 14：鉴权与来源 ================= */
  section('访问控制（经真实 router）');

  {
    const { createRouter } = await import('../server/router.js');
    const { createAuth } = await import('../server/auth.js');
    const { createRuntime } = await import('../server/runtime.js');

    const dir = mkProject('auth-proj');
    const runtime = createRuntime({ initialCwd: dir });
    const projectConfig = createProjectConfig({ runtime, env: {} });
    const passthrough = (name) => (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, handler: name }));
    };
    const router = createRouter({
      auth: createAuth({ token: 'T', port: 7788, appId: 'pi-gui', protocol: 1, version: '0.0.0' }),
      sse: { subscribe: passthrough('sse') },
      rpc: { send: passthrough('rpc.send'), restart: passthrough('rpc.restart'), getState: () => ({ ok: true }) },
      providers: { handle: passthrough('providers'), handleModels: passthrough('providers.models') },
      projects: { handle: passthrough('projects'), handleFs: passthrough('projects.fs') },
      projectConfig,
      gitRoutes: { handle: passthrough('git') },
      uploads: { handle: passthrough('uploads') },
    });
    const hit = async (method, url, headers = {}, body = '') => {
      const req = mockReq({ method, url, headers });
      const res = mockRes();
      router(req, res);
      if (body) {
        req.emit('data', Buffer.from(body, 'utf8'));
        req.emit('end');
      }
      await settle();
      await settle();
      return res;
    };

    const noTok = await hit('GET', '/api/project-config');
    check('13. GET 不带令牌 → 401', () => noTok.code === 401 || noTok.code);
    const putNoTok = await hit('PUT', '/api/project-config', {}, '{"thinking":"high"}');
    check('13. PUT 不带令牌 → 401', () => putNoTok.code === 401 || putNoTok.code);

    const cross = await hit('GET', '/api/project-config', { 'x-pi-gui-token': 'T', origin: 'https://evil.example' });
    check('14. 跨站 Origin + 正确令牌 → 403（Origin 先判）', () => cross.code === 403 || cross.code);

    const okRes = await hit('GET', '/api/project-config', { 'x-pi-gui-token': 'T' });
    check('13/14. 带令牌且同源 → 200 且来自 projectConfig', () =>
      (okRes.code === 200 && okRes.jsonBody().ok === true && 'hasProject' in okRes.jsonBody()) || okRes.body());

    // 顺带确认没有把 /api/projects 的分发吃掉
    const proj = await hit('GET', '/api/projects', { 'x-pi-gui-token': 'T' });
    check('/api/project-config 独立成路由后，/api/projects 仍命中 projects', () =>
      (proj.jsonBody() && proj.jsonBody().handler === 'projects') || proj.body());
  }

  /* ================= 15 / 16 / 17 / 18：项目隔离与路径安全 ================= */
  section('项目隔离 / 路径安全');

  {
    const a = mkProject('proj-a');
    const b = mkProject('proj-b');
    const runtime = mkRuntime(a);
    const pc = createProjectConfig({ runtime, env: {} });

    await putJSON(pc, { thinking: 'high', instructions: 'A 的指令' });
    runtime.setCurrentCwd(b);
    await putJSON(pc, { thinking: 'low', instructions: 'B 的指令' });

    runtime.setCurrentCwd(a);
    const ra = pc.read();
    runtime.setCurrentCwd(b);
    const rb = pc.read();

    check('15. 切到 A 读到 A 的配置', () => (ra.config.thinking === 'high' && ra.config.instructions === 'A 的指令') || JSON.stringify(ra.config));
    check('15. 切到 B 读到 B 的配置', () => (rb.config.thinking === 'low' && rb.config.instructions === 'B 的指令') || JSON.stringify(rb.config));
    check('16. A / B 两份文件都在各自项目里，互不覆盖', () =>
      (fs.existsSync(configPath(a)) && fs.existsSync(configPath(b)) && configPath(a) !== configPath(b)) || '文件缺失');
    check('16. A 的盘上内容没有被 B 的写入改动', () => {
      const onA = JSON.parse(fs.readFileSync(configPath(a), 'utf8'));
      return onA.instructions === 'A 的指令' || JSON.stringify(onA);
    });

    // 18：客户端塞路径一律无效
    runtime.setCurrentCwd(a);
    await call(pc, 'PUT', '/api/project-config?projectPath=' + encodeURIComponent(b) + '&path=' + encodeURIComponent(b), {
      body: JSON.stringify({ thinking: 'medium', projectPath: b, absolutePath: b, cwd: b, path: b }),
    });
    const onA2 = JSON.parse(fs.readFileSync(configPath(a), 'utf8'));
    const onB = JSON.parse(fs.readFileSync(configPath(b), 'utf8'));
    check('18. PUT 里带 projectPath / absolutePath / cwd / path → 只写当前项目', () =>
      (onA2.thinking === 'medium' && onB.thinking === 'low') || JSON.stringify({ a: onA2.thinking, b: onB.thinking }));
    check('18. 那些路径字段本身不会被写进配置文件', () =>
      !/projectPath|absolutePath/.test(fs.readFileSync(configPath(a), 'utf8')) || fs.readFileSync(configPath(a), 'utf8'));
    runtime.setCurrentCwd(b);
    const staleSave = await call(pc, 'PUT', '/api/project-config', {
      body: JSON.stringify({ thinking: 'max', __expectedCwd: a }),
    });
    check('18. 旧项目的延迟保存返回 409，不能写到新项目', () =>
      staleSave.code === 409 && JSON.parse(fs.readFileSync(configPath(b), 'utf8')).thinking === 'low');

    // 17：currentCwd 是唯一来源 —— 改 runtime 之外没有任何办法影响读写目标
    runtime.setCurrentCwd(null);
    check('17. cwd 置空后立刻变成「没有项目」', () => pc.read().hasProject === false || JSON.stringify(pc.read()));
    const noProjRes = await call(pc, 'GET', '/api/project-config?path=' + encodeURIComponent(a));
    check('17. cwd 为空时即使 URL 上带了路径也读不到任何项目配置', () =>
      (noProjRes.jsonBody().hasProject === false && noProjRes.jsonBody().config === null) || noProjRes.body());
  }

  /* ================= 19 / 20：模型与思考档位的降级 ================= */
  section('模型 / 思考档位的降级');

  {
    const dir = mkProject('degrade');
    const pc = mk(dir);
    await putJSON(pc, { model: { provider: 'deepseek', id: 'deepseek-chat' }, thinking: 'high' });
    const l = pc.launchArgs();
    check('19. 项目配置里的模型**绝不**进 pi 启动参数（过期模型会让 pi exit(1)）', () =>
      (!l.args.includes('--provider') && !l.args.includes('--model')) || JSON.stringify(l.args));
    check('19. 模型仍被保存下来（降级的是启动方式，不是数据）', () => pc.read().config.model.id === 'deepseek-chat' || JSON.stringify(pc.read().config));
    check('20. 支持的思考档位进启动参数', () =>
      JSON.stringify(l.args) === JSON.stringify(['--thinking', 'high']) || JSON.stringify(l.args));

    // 不支持的档位：归一化阶段就被丢掉，且不会进启动参数
    const pc2 = mk(mkProject('degrade2'));
    const r2 = (await putJSON(pc2, { thinking: 'ultra' })).jsonBody();
    check('20. 不在 pi 支持列表里的档位被丢弃 + 警告', () =>
      (r2.config.thinking === null && (r2.warnings || []).some((w) => /不在 pi 支持的档位/.test(w))) || JSON.stringify(r2));
    check('20. 档位被丢弃后启动参数里没有 --thinking（pi 用它自己的默认）', () =>
      pc2.launchArgs().args.length === 0 || JSON.stringify(pc2.launchArgs().args));
    check('20. THINKING_LEVELS 与 pi 自己报的合法值一致（off/minimal/low/medium/high/xhigh/max）', () =>
      THINKING_LEVELS.join(',') === 'off,minimal,low,medium,high,xhigh,max' || THINKING_LEVELS.join(','));
  }

  /* ================= 环境变量优先级 ================= */
  section('环境变量 > 项目配置');

  {
    const dir = mkProject('env-pin');
    const pc = mk(dir, { PI_THINKING: 'minimal' });
    await putJSON(pc, { thinking: 'high' });
    const l = pc.launchArgs();
    check('环境变量钉住 thinking 时，项目配置不再给 --thinking', () => l.args.length === 0 || JSON.stringify(l.args));

    const pc2 = mk(mkProject('env-pin2'), { PI_MODEL: 'gpt-x', PI_PROVIDER: 'openai' });
    await putJSON(pc2, { thinking: 'high' });
    check('环境变量钉住模型时，thinking 仍能生效（两者互不影响）', () =>
      JSON.stringify(pc2.launchArgs().args) === JSON.stringify(['--thinking', 'high']) || JSON.stringify(pc2.launchArgs().args));

    const res = await call(pc2, 'GET', '/api/project-config');
    const b = res.jsonBody();
    check('env 只回布尔、不回值（模型名不泄露到前端）', () =>
      (b.env.provider === true && b.env.model === true && b.env.thinking === false) || JSON.stringify(b.env));
    check('env 里没有任何字符串值', () => Object.values(b.env).every((v) => typeof v === 'boolean') || JSON.stringify(b.env));
  }

  /* ================= 密钥绝不落盘 ================= */
  section('密钥边界');

  {
    const dir = mkProject('secrets');
    const pc = mk(dir);
    await putJSON(pc, {
      thinking: 'high',
      apiKey: 'sk-SHOULD-NOT-APPEAR',
      token: 'TOKEN-SHOULD-NOT-APPEAR',
      PI_GUI_TOKEN: 'GUI-TOKEN-SHOULD-NOT-APPEAR',
      model: { provider: 'p', id: 'i', apiKey: 'sk-NESTED-SHOULD-NOT-APPEAR' },
      providers: { p: { apiKey: 'sk-DEEP' } },
    });
    const text = fs.readFileSync(configPath(dir), 'utf8');
    check('密钥：PUT 里的 apiKey / token / PI_GUI_TOKEN 一个都没写进配置', () => !/SHOULD-NOT-APPEAR|sk-DEEP/.test(text) || text);
    check('密钥：模型对象里只剩 provider 与 id', () => {
      const m = JSON.parse(text).model;
      return JSON.stringify(Object.keys(m).sort()) === JSON.stringify(['id', 'provider']) || JSON.stringify(m);
    });
    check('密钥：整个配置文件里没有出现 apiKey 这个键', () => !/apiKey/.test(text) || text);

    const res = await call(pc, 'GET', '/api/project-config');
    check('密钥：GET 响应里也没有 apiKey 字段', () => !/apiKey/i.test(res.body()) || res.body().slice(0, 300));
  }

  /* ================= 指令注入 ================= */
  section('项目指令的注入载体');

  {
    const dir = mkProject('instructions');
    const pc = mk(dir);
    await putJSON(pc, { instructions: '优先运行 npm test\n不要改 generated/' });
    const gen = instructionsPath(dir);
    check('指令：保存后生成了 pi 能读的指令文件', () => fs.existsSync(gen) || gen);
    check('指令：产物内容与配置一致', () =>
      fs.readFileSync(gen, 'utf8') === '优先运行 npm test\n不要改 generated/' || JSON.stringify(fs.readFileSync(gen, 'utf8')));
    check('指令：launchArgs 里带上 --append-system-prompt 指向该文件', () =>
      JSON.stringify(pc.launchArgs().args) === JSON.stringify(['--append-system-prompt', gen]) ||
      JSON.stringify(pc.launchArgs().args));
    check('指令：产物文件名带 .generated（明确是产物，不是输入）', () => /\.generated\.md$/.test(gen) || gen);

    // 内容没变就不重写（避免每次激活都动 mtime）
    const before = fs.statSync(gen).mtimeMs;
    const sync = pc.syncInstructionsFile();
    check('指令：内容未变时不重写文件', () => (sync.changed === false && fs.statSync(gen).mtimeMs === before) || JSON.stringify(sync));

    // 清空指令 → 产物必须删掉，否则 pi 会继续注入用户已经删掉的内容
    await putJSON(pc, { instructions: '' });
    check('指令：清空后产物被删除（不留旧指令继续注入）', () => !fs.existsSync(gen) || '文件还在');
    check('指令：清空后 launchArgs 不再带 --append-system-prompt', () =>
      !pc.launchArgs().args.includes('--append-system-prompt') || JSON.stringify(pc.launchArgs().args));

    // 只有文件真的存在才传参数（不存在时 pi 会把路径当字面量文本注入）
    await putJSON(pc, { instructions: 'x' });
    fs.unlinkSync(gen);
    const l = pc.launchArgs();
    check('指令：产物缺失时不传参数，并给出警告（避免把路径当指令注进去）', () =>
      (!l.args.includes('--append-system-prompt') && l.warnings.some((w) => /指令文件缺失/.test(w))) || JSON.stringify(l));

    // prepareLaunch 会先把文件同步出来，所以那条路是自愈的
    const prep = pc.prepareLaunch();
    check('指令：prepareLaunch 会重建缺失的产物并带上参数', () =>
      (fs.existsSync(gen) && JSON.stringify(prep.args) === JSON.stringify(['--append-system-prompt', gen])) || JSON.stringify(prep));
  }

  /* ================= 重启判定 ================= */
  section('保存后是否需要重启 pi');

  {
    const dir = mkProject('restart');
    let restarts = 0;
    const pc = createProjectConfig({ runtime: mkRuntime(dir), env: {}, restartPi: () => restarts++ });

    const r1 = (await putJSON(pc, { ignore: ['node_modules'] })).jsonBody();
    check('只改 ignore / commands → 不需要重启 pi', () => (r1.restartRequired === false && restarts === 0) || JSON.stringify({ r1, restarts }));

    const r2 = (await putJSON(pc, { thinking: 'high' })).jsonBody();
    check('改 thinking → 需要重启 pi 且真的重启了', () => (r2.restartRequired === true && restarts === 1) || JSON.stringify({ r2, restarts }));

    const r3 = (await putJSON(pc, { instructions: '第一版' })).jsonBody();
    check('首次写指令 → 需要重启', () => (r3.restartRequired === true && restarts === 2) || JSON.stringify({ r3, restarts }));

    const r4 = (await putJSON(pc, { instructions: '第二版' })).jsonBody();
    check('指令内容变了（路径没变）→ 仍然需要重启', () => (r4.restartRequired === true && restarts === 3) || JSON.stringify({ r4, restarts }));

    const r5 = (await putJSON(pc, { instructions: '第二版' })).jsonBody();
    check('指令内容没变 → 不需要重启', () => (r5.restartRequired === false && restarts === 3) || JSON.stringify({ r5, restarts }));

    const r6 = (await putJSON(pc, { model: { provider: 'p', id: 'i' } })).jsonBody();
    check('只改模型 → 不需要重启（由前端用 set_model 落下去，不重启进程）', () =>
      (r6.restartRequired === false && restarts === 3) || JSON.stringify({ r6, restarts }));
  }

  /* ================= 22：非 Git 项目 ================= */
  section('非 Git 项目');

  {
    const dir = mkProject('plain-dir');
    const pc = mk(dir);
    const res = await putJSON(pc, { thinking: 'low' });
    check('22. 非 Git 目录照样能读写项目配置', () =>
      (res.jsonBody().ok === true && pc.read().config.thinking === 'low') || JSON.stringify(pc.read()));
    check('22. 配置不写进 .git/，也不创建 .git/', () => !fs.existsSync(path.join(dir, '.git')) || '.git 被创建了');
    check('22. 配置放在 .pi-gui/ 而不是 .git/', () => (fs.existsSync(configPath(dir)) && configPath(dir).includes(DIR_NAME)) || configPath(dir));
  }

  /* ================= 打包相关 =================
   *
   * 光断言「server.js 里有一行 import」是个弱代理 —— 模块文件写错路径、
   * 或者在别处被条件分支绕开，那行 import 依然在。这里真的跑一次 esbuild，
   * 在**产物**里找指纹：模块的字符串常量、路由、桥接事件名。
   * 这是「开发能跑、装包缺模块」唯一拦得住的检查方式。 */
  section('打包兼容性（真实 bundle）');

  {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'project-config.js'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    check('打包：只 import node 内建模块与同目录兄弟（无新增运行时依赖）', () =>
      imports.every((i) => i.startsWith('node:') || i === './http-utils.js') || imports.join(','));
    check('打包：不读 package.json、不依赖 __PI_GUI_VERSION__ 之类的构建期注入', () =>
      (!/package\.json/.test(src) && !/__PI_GUI_VERSION__/.test(src)) || '有构建期依赖');

    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('装配：server.js 把 projectConfig 注入了 router 与 rpc-bridge', () =>
      (/projectLaunch:\s*projectConfig/.test(serverSrc) && /^\s*projectConfig,$/m.test(serverSrc)) || '装配缺项');

    /* 真 bundle。参数与 scripts/build-exe.mjs 保持一致 —— 不一致的话这里绿了、
     * 真打包挂了，等于没测。 */
    let bundle = '';
    let buildErr = '';
    try {
      const esbuild = require('esbuild');
      const out = path.join(os.tmpdir(), `pi-gui-bundle-${process.pid}.cjs`);
      const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
      esbuild.buildSync({
        entryPoints: [path.join(ROOT, 'server.js')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        outfile: out,
        define: {
          'import.meta.url': '__SEA_URL__',
          __PI_GUI_VERSION__: JSON.stringify(pkgVersion),
        },
        banner: { js: 'var __SEA_URL__=require("url").pathToFileURL(__filename).href;' },
        logLevel: 'silent',
      });
      bundle = fs.readFileSync(out, 'utf8');
      fs.unlinkSync(out);
    } catch (e) {
      buildErr = e.message;
    }

    check('打包：server.js 能被 esbuild 打成单文件（SEA exe / Electron 共用这份产物）', () =>
      (bundle.length > 100000 && !buildErr) || '构建失败：' + buildErr);

    if (bundle) {
      check('打包：产物里有 server/project-config.js 的指纹（模块真的进包了）', () =>
        (bundle.includes('instructions.generated.md') && bundle.includes('.pi-gui')) ||
        '产物里找不到该模块');
      check('打包：产物里有 /api/project-config 路由（接线真的进包了）', () =>
        bundle.includes('/api/project-config') || '产物里没有该路由');
      check('打包：产物里有 project_config_notice 事件名（桥接真的进包了）', () =>
        bundle.includes('project_config_notice') || '产物里没有该事件名');
      check('打包：产物里有 --append-system-prompt（指令注入路径进包了）', () =>
        bundle.includes('--append-system-prompt') || '产物里没有该参数');
    }
  }

  /* ================= 结构性护栏 ================= */
  section('结构性护栏');

  {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'project-config.js'), 'utf8');
    check('护栏：launchArgs 里没有出现 --provider / --model（防止有人「顺手」加回来）', () =>
      (!/['"]--provider['"]/.test(src) && !/['"]--model['"]/.test(src)) || '出现了 --provider / --model');
    check('护栏：config.json 的字段白名单里没有任何密钥类字段', () => {
      const m = src.match(/CONFIG_FIELDS\s*=\s*Object\.freeze\(\[([^\]]+)\]\)/);
      if (!m) return '找不到 CONFIG_FIELDS';
      return !/key|token|secret|password/i.test(m[1]) || m[1];
    });
  }

  cleanup();
  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  cleanup();
  console.error('失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
