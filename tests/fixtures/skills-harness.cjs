/* 技能管理各测试套件共用的夹具：断言计数、req/res 替身、临时世界、文件树快照。
 *
 * 纪律与 tests/skills.cjs 一致：
 *   1. 全部在 os.tmpdir() 里造世界，绝不碰真实项目、真实 ~/.pi、~/.agents、~/.claude、~/.codex；
 *   2. 不 spawn 进程、不联网；
 *   3. 每个 fixture 项目里都放一个 `.git` 目录，把「祖先 .agents/skills」的扫描钉在项目内。
 *
 * 不是测试套件，不进 npm test 链；由 tests/skills-*.cjs require。 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 断言计数。skip 的条目不计入通过 / 失败，结尾单独报数。 */
function createChecker() {
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  function check(name, cond, extra) {
    let ok;
    try {
      ok = typeof cond === 'function' ? cond() : cond;
    } catch (err) {
      ok = `断言抛了：${err && err.message}`;
    }
    if (ok === true) {
      pass += 1;
      console.log('  ok   ' + name);
    } else {
      fail += 1;
      console.log('  FAIL ' + name + (ok ? '  → ' + ok : extra ? '  → ' + extra : ''));
    }
  }
  function skip(name, why) {
    skipped += 1;
    console.log('  skip ' + name + '  → ' + why);
  }
  function section(title) {
    console.log('\n--- ' + title + ' ---');
  }
  function finish() {
    console.log(`\n${pass} passed, ${fail} failed` + (skipped ? `（另有 ${skipped} 条因环境跳过，未计入）` : ''));
    if (fail) process.exitCode = 1;
  }
  return { check, skip, section, finish };
}

/* ---------- req / res 替身 ----------
 * readRawBody 用的是 req.on('data') / req.on('end')，所以桩必须有 emit。 */
function mockRes() {
  return {
    code: null,
    headers: null,
    chunks: [],
    ended: false,
    get headersSent() {
      return this.code !== null;
    },
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
    listenerCount(ev) {
      return (listeners.get(ev) || []).length;
    },
  };
}

/**
 * 驱动一次 HTTP 处理：先调 handler（它必须同步注册请求体监听），紧接着 emit 请求体，
 * 然后等 handler 的 Promise 结束。body 不传就不 emit —— 不读请求体的路由也不该等它。
 */
async function call(mod, method, url, { headers = {}, body = undefined, timeoutMs = 30000 } = {}) {
  const req = mockReq({ method, url, headers });
  const res = mockRes();
  const done = Promise.resolve(mod.handle(req, res, new URL(url, 'http://127.0.0.1:7788')));
  if (body !== undefined) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    req.emit('data', bytes);
    req.emit('end');
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([done.then(() => 'done', (err) => err || new Error('handler rejected')), timeout]);
  clearTimeout(timer);
  res.timedOut = outcome === 'timeout';
  res.thrown = outcome instanceof Error ? outcome : null;
  return res;
}

/* ---------- 临时世界 ---------- */

function createWorlds(prefix) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const created = [TMP];

  /** 独立 home、独立 agentDir、独立项目、独立数据目录。 */
  function mkWorld(name) {
    const base = path.join(TMP, name);
    const home = path.join(base, 'home');
    const agent = path.join(base, 'agent');
    const proj = path.join(base, 'proj');
    const data = path.join(base, 'data');
    for (const dir of [home, agent, proj, data]) fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    created.push(base);
    return { base, home, agent, proj, data, env: { HOME: home, PI_CODING_AGENT_DIR: agent } };
  }

  function cleanup() {
    for (const dir of created.slice().reverse()) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Windows 上偶发占用，忽略 */
      }
    }
  }

  return { TMP, mkWorld, cleanup };
}

function mkRuntime(cwd) {
  let current = cwd;
  return {
    getCurrentCwd: () => current,
    setCurrentCwd: (value) => {
      current = value;
    },
  };
}

/**
 * 假 rpc。list：pi 报告已加载的技能 [{ name, description, path }]。
 * running：rpc.getState().piRunning（决定「要不要重启才生效」）。
 * calls.get_commands 记录 pi 被问了几次。
 */
function mkRpc(list = [], { running = true } = {}) {
  const calls = { get_commands: 0 };
  return {
    calls,
    getState: () => ({ piRunning: running }),
    request: async (cmd) => {
      if (!cmd || cmd.type !== 'get_commands') return null;
      calls.get_commands += 1;
      return {
        commands: list.map((skill) => ({
          name: 'skill:' + skill.name,
          description: skill.description || '',
          source: 'skill',
          sourceInfo: skill.sourceInfo || (skill.path ? { path: skill.path } : {}),
        })),
      };
    },
  };
}

/**
 * 在 root 下写一个目录形态的技能，返回 SKILL.md 的绝对路径。
 * files：附属资源 { 'scripts/a.py': 字符串或 Buffer }。
 */
function writeSkill(root, name, { description = 'description of ' + name, fmName = name, raw = null, files = {} } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const text = raw !== null ? raw : `---\nname: ${fmName}\ndescription: ${description}\n---\n\n# ${fmName}\n`;
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, text);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return file;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const b64 = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')).toString('base64');

/**
 * 一棵目录树的指纹：每个条目的相对路径、类型、大小、内容哈希、修改时间。
 * 用来证明「这棵树一个字节都没被动过」（连 mtime 都没变）。目录不存在时返回 null。
 */
function snapshotTree(root, { withMtime = true } = {}) {
  if (!fs.existsSync(root)) return null;
  const rows = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      const mtime = withMtime ? `@${stat.mtimeMs}` : '';
      if (stat.isSymbolicLink()) {
        rows.push(`${childRel}|link|${fs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        rows.push(`${childRel}|dir${mtime}`);
        walk(full, childRel);
      } else {
        rows.push(`${childRel}|file|${stat.size}|${sha256(fs.readFileSync(full))}${mtime}`);
      }
    }
  };
  walk(root, '');
  return rows.join('\n');
}

/** 目录链接：Windows 上用 junction（不需要管理员权限），其余平台用符号链接。 */
function linkDir(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** 文件符号链接。Windows 上没有开发者模式 / 管理员权限时建不出来 —— 返回 false，由调用方跳过。 */
function tryLinkFile(target, linkPath) {
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/* ---------- 服务端模块与常用动作 ---------- */

/** 与 server/skills.js 的 pathKey 同语义（Windows 上大小写不敏感）。 */
function pathKey(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 载入服务端模块（ESM 只能动态 import），返回绑定好的造物函数：
 *   mkSkills(world, cwd, opts)  一个 createSkills 实例，home / agentDir / dataDir 都指向这个世界；
 *   realCore(sk, opts)          用真实实现拼出来的 core，给「直接测 manager」用；
 *   fakeCore(world, opts)       信任判定完全由参数决定的 core，给「逐分支测信任闸」用。
 */
async function loadSkillsServer() {
  const skillsModule = await import('../../server/skills.js');
  const manageModule = await import('../../server/skills-manage.js');
  const { createSkills, MAX_SKILL_BYTES } = skillsModule;
  // 只为拿纯函数（skillId / validateName …）：不带数据目录、不带项目，不会读写任何东西
  const internals = createSkills({ runtime: mkRuntime(null), env: {}, homeDir: os.tmpdir() })._internals;

  function mkSkills(world, cwd, { rpc = null, approve = null, projects = null, dataDir = world.data, marketFetcher = null, env = world.env } = {}) {
    return createSkills({
      runtime: mkRuntime(cwd),
      rpc,
      env,
      homeDir: world.home,
      approve,
      dataDir,
      getProjects: typeof projects === 'function' ? projects : projects ? () => projects : null,
      marketFetcher,
    });
  }

  function realCore(sk, { running = false, approve = null } = {}) {
    return {
      paths: sk._internals.paths,
      buildIndex: () => sk.readIndex(),
      readTrustState: sk._internals.readTrustState,
      approve,
      isPiRunning: () => running,
      skillId: internals.skillId,
      pathKey,
      validateName: internals.validateName,
      maxSkillBytes: MAX_SKILL_BYTES,
      maxDescriptionLength: 1024,
    };
  }

  function fakeCore(world, { current, after, running = false, skills = [], seen = null } = {}) {
    return {
      paths: (cwd) => ({ cwd, agentDir: world.agent, homeDir: world.home }),
      buildIndex: async () => ({ skills, index: new Map(skills.map((skill) => [skill.id, skill])) }),
      readTrustState: (args) => {
        if (seen) seen.push(args);
        return args.assumeResources ? after : current;
      },
      approve: null,
      isPiRunning: () => running,
      skillId: internals.skillId,
      pathKey,
      validateName: internals.validateName,
      maxSkillBytes: MAX_SKILL_BYTES,
      maxDescriptionLength: 1024,
    };
  }

  return { ...skillsModule, ...manageModule, internals, skillId: internals.skillId, mkSkills, realCore, fakeCore };
}

/** 带 JSON 请求体的调用。读请求体的路由必须给 body（哪怕是 {}），否则会一直等到超时。 */
const api = (mod, method, url, body) => call(mod, method, url, body === undefined ? {} : { body });

async function getList(mod, project) {
  const res = await api(mod, 'GET', '/api/skills' + (project === undefined ? '' : `?project=${project}`));
  return res.jsonBody();
}

const findSkill = (payload, name, scope) => ((payload && payload.skills) || []).find((skill) => skill.name === name && (!scope || skill.scope === scope));

/** 回收站里的条目名（可按前缀筛：del- 是删除 / 覆盖 / 撤销安装，edit- 是编辑前的备份）。 */
const trashEntries = (world, prefix = '') => listDir(path.join(world.data, 'skills-trash')).filter((name) => name.startsWith(prefix));

function readTrashMeta(world, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(world.data, 'skills-trash', id, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

const trashPayload = (world, id) => path.join(world.data, 'skills-trash', id, 'payload');

module.exports = {
  createChecker, mockRes, mockReq, call, createWorlds, mkRuntime, mkRpc, writeSkill, writeJson,
  sha256, b64, snapshotTree, linkDir, tryLinkFile, listDir,
  pathKey, loadSkillsServer, api, getList, findSkill, trashEntries, readTrashMeta, trashPayload,
};
