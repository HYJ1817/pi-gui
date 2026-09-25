/* Skills（server/skills.js）与 MCP 能力报告（server/mcp.js）的测试。
 *
 * 为什么单独一份：这两个模块的代码绝大部分是**边界与安全**，正常路径上一条都走不到 ——
 * 目录不存在、frontmatter 缺失或损坏、同名冲突、项目未被信任、settings 不是数组、
 * 写盘失败、前端传路径、ID 猜不出来、secret 不能泄露。只有构造出来才测得到。
 *
 * 三条纪律（与 project-config.cjs 一致）：
 *   1. 全部在 os.tmpdir() 里造世界，绝不碰真实项目、真实 ~/.pi、真实 ~/.agents；
 *   2. 不 spawn 进程、不联网 —— 真 pi 的运行时验证在 tests/skills-live.cjs 里；
 *   3. 每个 fixture 项目里都放一个 `.git` 目录，把 pi 的「祖先 .agents/skills」
 *      扫描钉死在项目内。否则它会一路扫到真实用户主目录，测试结果就跟着
 *      「这台机器上装了哪个 skill」变了 —— 那不是测试，是碰运气。
 *
 * 用法：node tests/skills.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
 * 所有 PUT 都静默什么都没发生）。 */
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

const settle = () => new Promise((r) => setImmediate(r));

/** 驱动一次 HTTP 处理。先调 handler（同步注册监听），再 emit 请求体。 */
async function call(mod, method, url, { headers = {}, body = '' } = {}) {
  const req = mockReq({ method, url, headers });
  const res = mockRes();
  mod.handle(req, res, new URL(url, 'http://127.0.0.1:7788'));
  if (body) {
    req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  }
  await settle();
  await settle();
  return res;
}
const putJSON = (mod, url, payload) => call(mod, 'PUT', url, { body: JSON.stringify(payload) });

/* ---------- 临时世界 ---------- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-skills-'));
const created = [TMP];
function cleanup() {
  for (const d of created.reverse()) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows 上偶发占用，忽略 */
    }
  }
}

/**
 * 造一个隔离世界：独立 home、独立 agentDir、独立项目目录。
 * 项目里放 `.git` 是为了把祖先扫描钉住（见文件头注释第 3 条）。
 */
function mkWorld(name) {
  const base = path.join(TMP, name);
  const home = path.join(base, 'home');
  const agent = path.join(base, 'agent');
  const proj = path.join(base, 'proj');
  for (const d of [home, agent, proj]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  created.push(base);
  return { base, home, agent, proj, env: { HOME: home, PI_CODING_AGENT_DIR: agent } };
}

function mkRuntime(cwd) {
  let cur = cwd;
  return {
    getCurrentCwd: () => cur,
    setCurrentCwd: (v) => {
      cur = v;
    },
  };
}

/**
 * 假 rpc。
 *   mkRpc([...])   → pi 在跑，get_commands 返回这些 skill
 *   mkRpc('error') → pi 在跑但命令报错
 *   mkRpc('down')  → pi 没起
 *   mkRpc()        → 不传 rpc（等价于 pi 没起）
 */
function mkRpc(list) {
  if (list === undefined) return null;
  if (list === 'error') return { request: async () => ({ __error: 'boom' }) };
  if (list === 'down') return { request: async () => null };
  return {
    request: async (cmd) =>
      cmd && cmd.type === 'get_commands'
        ? {
            commands: list.map((s) => ({
              name: 'skill:' + s.name,
              description: s.description || '',
              source: 'skill',
              sourceInfo: s.sourceInfo || {},
            })),
          }
        : null,
  };
}

/** 在 root 下写一个目录形态的 skill，返回 SKILL.md 的绝对路径。 */
function writeSkill(root, name, { description = 'description of ' + name, fmName = name, raw = null, extra = '' } = {}) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  const text = raw !== null ? raw : `---\nname: ${fmName}\ndescription: ${description}${extra}\n---\n\n# ${fmName}\n`;
  const file = path.join(d, 'SKILL.md');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
function writeMd(root, name, text) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
const listTmp = (dir) => {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  } catch {
    return [];
  }
};

(async () => {
  const { createSkills, MAX_SKILL_BYTES } = await import('../server/skills.js');
  const { createMcp } = await import('../server/mcp.js');

  const mkSkills = (world, cwd, { rpc = null, approve = null } = {}) =>
    createSkills({ runtime: mkRuntime(cwd), rpc, env: world.env, homeDir: world.home, approve });

  const I = createSkills({ runtime: mkRuntime(null), rpc: null, env: {}, homeDir: TMP })._internals;

  /* ================= A. 内部解析与匹配 ================= */
  section('A. frontmatter / glob / 校验 / ID（纯函数）');

  {
    const p = I.parseFrontmatter;
    check('A1. 正常 frontmatter 解析出 name / description', () => {
      const r = p('---\nname: code-review\ndescription: Review source code\n---\n# T\n');
      return (r && r.name === 'code-review' && r.description === 'Review source code') || JSON.stringify(r);
    });
    check('A2. 引号包裹的 description 去掉引号', () => {
      const r = p('---\nname: a\ndescription: "a: b"\n---\n');
      return (r && r.description === 'a: b') || JSON.stringify(r);
    });
    check('A3. 块标量 | 能读多行', () => {
      const r = p('---\nname: a\ndescription: |\n  line one\n  line two\n---\n');
      return (r && r.description === 'line one\nline two') || JSON.stringify(r);
    });
    check('A4. BOM + CRLF 不影响解析', () => {
      const r = p('\uFEFF---\r\nname: a\r\ndescription: hi\r\n---\r\n');
      return (r && r.name === 'a' && r.description === 'hi') || JSON.stringify(r);
    });
    check('A5. 没有 frontmatter → null（不抛）', () => p('# just markdown\n') === null || 'not null');
    check('A6. frontmatter 没闭合 → null（不抛）', () => p('---\nname: a\n') === null || 'not null');
    check('A7. 非字符串输入 → null（不抛）', () => (p(null) === null && p(42) === null && p(undefined) === null) || 'not null');
    check('A8. 缩进的子键被忽略（只认顶层键）', () => {
      const r = p('---\nname: a\ndescription: hi\nmetadata:\n  description: nested\n---\n');
      return (r && r.description === 'hi' && r.metadata === '') || JSON.stringify(r);
    });
  }

  {
    const vn = I.validateName;
    check('A9. 合法名字无告警', () => vn('code-review').length === 0 || vn('code-review').join(','));
    check('A10. 大写 / 下划线 / 首尾连字符 / 连续连字符都被指出', () => {
      const bad = ['Bad', 'a_b', '-a', 'a-', 'a--b'].every((n) => vn(n).length > 0);
      return bad || ['Bad', 'a_b', '-a', 'a-', 'a--b'].map((n) => n + ':' + vn(n).join('/')).join(' | ');
    });
    check('A11. 超长名字被指出', () => vn('a'.repeat(65)).length > 0 || '没指出');
    const vd = I.validateDescription;
    check('A12. 空 description 被指出 / 正常 description 通过', () =>
      (vd('').length > 0 && vd('   ').length > 0 && vd('ok').length === 0) || '错');
    check('A13. 超长 description 被指出', () => vd('x'.repeat(2000)).length > 0 || '没指出');
  }

  {
    const mp = I.matchesAnyPattern;
    const me = I.matchesAnyExactPattern;
    const base = path.join(TMP, 'glob-base');
    const skillFile = path.join(base, 'skills', 'foo', 'SKILL.md');
    const plainFile = path.join(base, 'skills', 'foo', 'bar.md');

    check('A14. glob ** 跨目录命中', () => mp(plainFile, ['**/bar.md'], base) === true || '没命中');
    check('A15. glob 命中 SKILL.md 的父目录名（pi 的行为）', () => mp(skillFile, ['foo'], base) === true || '没命中');
    check('A16. glob 单星不跨 /（普通文件上验证）', () => mp(plainFile, ['skills/*'], base) === false || '竟然命中了');
    check('A17. glob 不匹配就是 false', () => mp(skillFile, ['*nope*'], base) === false || '竟然命中了');

    check('A18. exact 命中「相对 baseDir 的 posix 路径」', () => me(skillFile, ['skills/foo/SKILL.md'], base) === true || '没命中');
    check('A19. exact 命中父目录（靠 parentRel）', () => me(skillFile, ['skills/foo'], base) === true || '没命中');
    check('A20. exact 去掉 ./ 前缀后命中', () => me(skillFile, ['./skills/foo/SKILL.md'], base) === true || '没命中');
    check('A21. exact **不比 name** —— 裸名字不命中（这是最容易踩的坑）', () =>
      me(skillFile, ['foo'], base) === false || '竟然命中了：说明实现退回了 glob 语义');
  }

  {
    const d = I.disabledByPatterns;
    const base = path.join(TMP, 'glob-base');
    const f = path.join(base, 'skills', 'foo', 'SKILL.md');
    check('A22. -exact 关掉它，并回报是哪条模式', () => {
      const r = d(f, ['-skills/foo/SKILL.md'], base);
      return (r.disabled === true && r.pattern === '-skills/foo/SKILL.md') || JSON.stringify(r);
    });
    check('A23. !glob 关掉它', () => {
      const r = d(f, ['!*foo*'], base);
      return (r.disabled === true && r.pattern === '!*foo*') || JSON.stringify(r);
    });
    check('A24. +exact 能盖过 !glob（强制包含）', () => d(f, ['!*foo*', '+skills/foo/SKILL.md'], base).disabled === false || '仍然关着');
    check('A25. -exact 能盖过 +exact（强制排除优先级最高）', () => {
      const r = d(f, ['+skills/foo/SKILL.md', '-skills/foo/SKILL.md'], base);
      return (r.disabled === true && r.pattern === '-skills/foo/SKILL.md') || JSON.stringify(r);
    });
    check('A26. 不带 !/+/ 前缀的普通条目不是 override（settings 里的路径条目）', () =>
      d(f, ['skills/foo/SKILL.md'], base).disabled === false || '被当成 override 了');
    check('A27. 空数组 / undefined 都不关', () =>
      (d(f, [], base).disabled === false && d(f, undefined, base).disabled === false) || '错');
  }

  {
    const sid = I.skillId;
    const a = sid(path.join(TMP, 'x', 'SKILL.md'));
    const b = sid(path.join(TMP, 'x', 'SKILL.md'));
    const c = sid(path.join(TMP, 'y', 'SKILL.md'));
    check('A28. ID 稳定（同一路径两次一致）', () => a === b || a + ' vs ' + b);
    check('A29. ID 是 16 位十六进制', () => /^[0-9a-f]{16}$/.test(a) || a);
    check('A30. 不同路径 ID 不同', () => a !== c || '撞了');
    check('A31. ID 里不含路径分隔符或盘符（不泄露路径）', () => !/[:\\/]/.test(a) || a);
  }

  /* ================= B. collectSkillEntries / 祖先扫描 ================= */
  section('B. 目录收集（pi 的两种模式）');

  {
    const w = mkWorld('collect');
    const tree = path.join(w.base, 'tree');
    const piMode = path.join(tree, 'pi-mode');
    writeSkill(piMode, 'one', { description: 'd' });
    writeMd(piMode, 'root.md', '---\nname: r\ndescription: d\n---\n');
    writeMd(piMode, '.hidden.md', '---\nname: h\ndescription: d\n---\n');
    fs.mkdirSync(path.join(piMode, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(piMode, 'node_modules', 'x', 'SKILL.md'), '---\nname: nm\ndescription: d\n---\n');
    writeSkill(path.join(piMode, 'nested'), 'deep', { description: 'd' });

    const agentsMode = path.join(tree, 'agents-mode');
    writeSkill(agentsMode, 'one', { description: 'd' });
    writeMd(agentsMode, 'root.md', '---\nname: r\ndescription: d\n---\n');

    const stop = path.join(tree, 'stop');
    writeSkill(stop, 'outer', { description: 'd' });
    writeSkill(path.join(stop, 'outer'), 'inner', { description: 'd' });

    const rels = (arr, root) => arr.map((f) => path.relative(root, f).split(path.sep).join('/')).sort().join(',');

    const piGot = I.collectSkillEntries(piMode, 'pi');
    check('B1. pi 模式：根级 .md + 子目录 SKILL.md 都收，跳过点开头与 node_modules', () =>
      rels(piGot, piMode) === 'nested/deep/SKILL.md,one/SKILL.md,root.md' || rels(piGot, piMode));
    check('B2. pi 模式收到 3 个文件（one / nested/deep / root.md）', () => piGot.length === 3 || rels(piGot, piMode));

    const agGot = I.collectSkillEntries(agentsMode, 'agents');
    check('B3. agents 模式：忽略根级 .md，只认子目录', () => rels(agGot, agentsMode) === 'one/SKILL.md' || rels(agGot, agentsMode));

    const stopGot = I.collectSkillEntries(stop, 'pi');
    check('B4. 目录里有 SKILL.md 就当成一个 skill，不再往里递归', () =>
      (stopGot.length === 1 && rels(stopGot, stop) === 'outer/SKILL.md') || rels(stopGot, stop));

    check('B5. 目录不存在 → 空数组（不抛）', () => I.collectSkillEntries(path.join(w.base, 'nope'), 'pi').length === 0 || '有东西');

    const anc = I.ancestorAgentsSkillDirs(w.proj);
    check('B6. 祖先扫描被 .git 钉在项目内', () => (anc.length === 1 && anc[0] === path.join(w.proj, '.agents', 'skills')) || JSON.stringify(anc));
    check('B7. cwd 为空 → 没有祖先目录', () => I.ancestorAgentsSkillDirs(null).length === 0 || '有东西');
  }

  /* ================= C. settings 读写与原子写 ================= */
  section('C. settings 读 / 原子写');

  {
    const w = mkWorld('settings');
    const missing = path.join(w.base, 'none.json');
    check('C1. 文件不存在 → exists=false、data={}、无错误', () => {
      const r = I.readSettings(missing);
      return (r.exists === false && r.error === '' && typeof r.data === 'object') || JSON.stringify(r);
    });
    const bad = path.join(w.base, 'bad.json');
    fs.writeFileSync(bad, '{ not json', 'utf8');
    check('C2. 非法 JSON → error 非空、不抛', () => I.readSettings(bad).error !== '' || '没报错');
    const arr = path.join(w.base, 'arr.json');
    fs.writeFileSync(arr, '[1,2]', 'utf8');
    check('C3. 顶层是数组 → 报「不是一个 JSON 对象」', () => /不是一个 JSON 对象/.test(I.readSettings(arr).error) || I.readSettings(arr).error);
    const okf = path.join(w.base, 'sub', 'ok.json');
    I.writeSettingsAtomic(okf, { skills: ['-a'], keep: { x: 1 } });
    check('C4. 原子写会建出父目录', () => fs.existsSync(okf) || '没写出来');
    check('C5. 原子写产出格式化 JSON 且以换行结尾', () => {
      const t = fs.readFileSync(okf, 'utf8');
      return (t.endsWith('\n') && JSON.parse(t).keep.x === 1) || JSON.stringify(t.slice(0, 120));
    });
    check('C6. 原子写不留 .tmp 残渣', () => listTmp(path.dirname(okf)).length === 0 || listTmp(path.dirname(okf)).join(','));
    check('C7. 原子写失败时抛出（父路径是文件）', () => {
      const blocked = path.join(w.base, 'a-file');
      fs.writeFileSync(blocked, 'x', 'utf8');
      try {
        I.writeSettingsAtomic(path.join(blocked, 'settings.json'), { a: 1 });
        return '竟然成功了';
      } catch {
        return true;
      }
    });
  }

  /* ================= D. 信任判定 ================= */
  section('D. 项目信任判定');

  {
    const w = mkWorld('trust');
    const withPi = { cwd: w.proj, agentDir: w.agent, homeDir: w.home, trustOverride: null };
    fs.mkdirSync(path.join(w.proj, '.pi', 'skills'), { recursive: true });

    check('D1. 没有项目 → trusted=false / reason=no-project', () => {
      const r = I.readTrustState({ cwd: null, agentDir: w.agent, homeDir: w.home, trustOverride: null });
      return (r.trusted === false && r.reason === 'no-project' && r.requiresTrust === false) || JSON.stringify(r);
    });
    check('D2. 项目有 .pi/skills → requiresTrust=true（闸门合上了）', () => I.readTrustState(withPi).requiresTrust === true || '没合上');
    check('D3. 默认（RPC 非交互、无 UI）→ trusted=false / reason=ask-no-ui', () => {
      const r = I.readTrustState(withPi);
      return (r.trusted === false && r.reason === 'ask-no-ui') || JSON.stringify(r);
    });
    check('D4. --approve → trusted=true / reason=approve-flag', () => {
      const r = I.readTrustState({ ...withPi, trustOverride: true });
      return (r.trusted === true && r.reason === 'approve-flag') || JSON.stringify(r);
    });
    check('D5. --no-approve → trusted=false / reason=no-approve-flag', () => {
      const r = I.readTrustState({ ...withPi, trustOverride: false });
      return (r.trusted === false && r.reason === 'no-approve-flag') || JSON.stringify(r);
    });

    writeJson(path.join(w.agent, 'trust.json'), { [w.proj]: true });
    check('D6. trust.json 里记了 true → trusted=true / reason=trust-file', () => {
      const r = I.readTrustState(withPi);
      return (r.trusted === true && r.reason === 'trust-file') || JSON.stringify(r);
    });
    fs.rmSync(path.join(w.agent, 'trust.json'));
    writeJson(path.join(w.agent, 'settings.json'), { defaultProjectTrust: 'always' });
    check('D7. defaultProjectTrust=always → trusted=true', () => {
      const r = I.readTrustState(withPi);
      return (r.trusted === true && r.reason === 'default-always') || JSON.stringify(r);
    });
    writeJson(path.join(w.agent, 'settings.json'), { defaultProjectTrust: 'never' });
    check('D8. defaultProjectTrust=never → trusted=false', () => {
      const r = I.readTrustState(withPi);
      return (r.trusted === false && r.reason === 'default-never') || JSON.stringify(r);
    });
  }

  /* ================= E. 发现与状态（主链路） ================= */
  section('E. 发现 / 状态判定');

  const basic = mkWorld('basic');
  const agentSkills = path.join(basic.agent, 'skills');
  const homeAgentsSkills = path.join(basic.home, '.agents', 'skills');
  const projPiSkills = path.join(basic.proj, '.pi', 'skills');
  const projAgentsSkills = path.join(basic.proj, '.agents', 'skills');

  writeSkill(agentSkills, 'u-one', { description: 'User one' });
  writeSkill(agentSkills, 'u-two', { raw: '---\nname: u-two\n---\n\n# no description\n' });
  writeMd(agentSkills, 'u-root.md', '---\nname: u-root\ndescription: Root level md\n---\n');
  writeSkill(homeAgentsSkills, 'ua-one', { description: 'Agents one' });
  writeMd(homeAgentsSkills, 'ua-root.md', '---\nname: ua-root\ndescription: should be ignored\n---\n');
  writeSkill(projPiSkills, 'p-one', { description: 'Project one' });
  writeSkill(projPiSkills, 'p-broken', { raw: '---\nname: p-broken\n---\n\n# no description\n' });
  writeSkill(projAgentsSkills, 'anc-one', { description: 'Ancestor one' });

  /** pi 只报了 user 级（模拟「项目未被信任」时 pi 的真实行为）。 */
  const piUserOnly = [{ name: 'u-one', description: 'User one' }, { name: 'u-root', description: 'Root level md' }, { name: 'ua-one', description: 'Agents one' }];

  {
    const sk = mkSkills(basic, basic.proj, { rpc: mkRpc(piUserOnly) });
    const res = await call(sk, 'GET', '/api/skills');
    const b = res.jsonBody();
    const byName = (n) => (b.skills || []).find((s) => s.name === n);

    check('E1. GET /api/skills → 200 / ok=true', () => (res.code === 200 && b && b.ok === true) || JSON.stringify(b));
    check('E2. 四个发现根都在（agent / ~/.agents / 项目 .pi / 项目 .agents）', () => {
      const labels = (b.roots || []).map((r) => r.label).join(' | ');
      return (
        (b.roots || []).length === 4 &&
        labels.includes('~/.pi/agent/skills') &&
        labels.includes('~/.agents/skills') &&
        labels.includes('<项目>/.pi/skills') &&
        labels.includes(projAgentsSkills)
      ) || labels;
    });
    check('E3. 根级 .md 在 pi 模式被收到、在 agents 模式被忽略', () =>
      (Boolean(byName('u-root')) && !byName('ua-root')) || 'u-root=' + Boolean(byName('u-root')) + ' ua-root=' + Boolean(byName('ua-root')));
    check('E4. counts.total=7 / enabled=3 / project=3 / user=4', () => {
      const c = b.counts || {};
      return (c.total === 7 && c.enabled === 3 && c.project === 3 && c.user === 4) || JSON.stringify(c);
    });
    check('E5. 排序：project 排在最前，user 在后', () =>
      (b.skills[0].scope === 'project' && b.skills[b.skills.length - 1].scope === 'user') || b.skills.map((s) => s.scope).join(','));

    check('E6. u-one：user / auto / 根 ~/.pi/agent/skills / loaded=true / enabled', () => {
      const s = byName('u-one');
      return (
        s &&
        s.scope === 'user' &&
        s.source === 'auto' &&
        s.rootLabel === '~/.pi/agent/skills' &&
        s.loaded === true &&
        s.state === 'enabled'
      ) || JSON.stringify(s);
    });
    check('E7. u-one 的 rel 与停用模式带 skills/ 前缀（实测裸文件名不生效）', () => {
      const s = byName('u-one');
      return (s && s.rel === 'skills/u-one/SKILL.md' && s.disablePattern === '-skills/u-one/SKILL.md') || JSON.stringify(s && { rel: s.rel, p: s.disablePattern });
    });
    check('E8. u-one 的 settingsPath 指向全局 settings', () =>
      byName('u-one').settingsPath === path.join(basic.agent, 'settings.json') || byName('u-one').settingsPath);
    check('E9. ua-one：来自 ~/.agents/skills，baseDir 是 ~/.agents', () => {
      const s = byName('ua-one');
      return (s && s.rootLabel === '~/.agents/skills' && s.rel === 'skills/ua-one/SKILL.md' && s.baseDir === path.join(basic.home, '.agents')) || JSON.stringify(s);
    });
    check('E10. u-two 没有 description → state=invalid 且带 error', () => {
      const s = byName('u-two');
      return (s && s.state === 'invalid' && s.errors.some((e) => e.level === 'error')) || JSON.stringify(s && { state: s.state, errors: s.errors });
    });
    check('E11. p-one（项目级 + 未信任）→ state=untrusted / blockedByTrust=true', () => {
      const s = byName('p-one');
      return (s && s.scope === 'project' && s.state === 'untrusted' && s.blockedByTrust === true) || JSON.stringify(s && { scope: s.scope, state: s.state, bt: s.blockedByTrust });
    });
    check('E12. p-one 的 settingsPath 指向项目 .pi/settings.json（作用域必须配对）', () =>
      byName('p-one').settingsPath === path.join(basic.proj, '.pi', 'settings.json') || byName('p-one').settingsPath);
    check('E13. anc-one（项目 .agents）→ project 作用域，settingsPath 仍是项目 settings', () => {
      const s = byName('anc-one');
      return (s && s.scope === 'project' && s.settingsPath === path.join(basic.proj, '.pi', 'settings.json')) || JSON.stringify(s && { scope: s.scope, sp: s.settingsPath });
    });
    check('E14. p-broken 没有 description → invalid（优先级高于 untrusted）', () => byName('p-broken').state === 'invalid' || byName('p-broken').state);
    check('E15. 项目根的 blockedByTrust 标记为 true，用户根为 false', () => {
      const root = (label) => (b.roots || []).find((r) => r.label === label);
      return (root('<项目>/.pi/skills').blockedByTrust === true && root('~/.pi/agent/skills').blockedByTrust === false) || JSON.stringify(b.roots);
    });
    check('E16. trust 在列表里如实报未信任（ask-no-ui）', () =>
      (b.trust && b.trust.trusted === false && b.trust.reason === 'ask-no-ui' && b.trust.requiresTrust === true) || JSON.stringify(b.trust));
    check('E17. 每条 skill 的 id 都不同且形如 16 位 hex', () => {
      const ids = b.skills.map((s) => s.id);
      return (new Set(ids).size === ids.length && ids.every((i) => /^[0-9a-f]{16}$/.test(i))) || ids.join(',');
    });
    check('E18. 每条 skill 都不含绝对路径以外的敏感字段（没有 secret 类字段）', () => {
      const json = JSON.stringify(b);
      return !/apiKey|password|secret|token/i.test(json) || 'payload 里出现了敏感词';
    });
  }

  {
    // 同样一份磁盘，换成 --approve 且 pi 报了项目级 —— 状态应当全部翻过来
    const sk = mkSkills(basic, basic.proj, {
      rpc: mkRpc([...piUserOnly, { name: 'p-one', description: 'Project one' }, { name: 'anc-one', description: 'Ancestor one' }]),
      approve: true,
    });
    const b = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const byName = (n) => (b.skills || []).find((s) => s.name === n);
    check('E19. --approve 后 trust.trusted=true / reason=approve-flag', () =>
      (b.trust.trusted === true && b.trust.reason === 'approve-flag') || JSON.stringify(b.trust));
    check('E20. --approve 后 p-one → enabled（不再 untrusted）', () => byName('p-one').state === 'enabled' || byName('p-one').state);
    check('E21. --approve 后 blockedByTrust 全部为 false', () => (b.skills.every((s) => s.blockedByTrust === false) ? true : JSON.stringify(b.skills.map((s) => [s.name, s.blockedByTrust]))) || '');
    check('E22. counts.enabled 变成 5（3 个用户级 + 2 个项目级）', () => b.counts.enabled === 5 || JSON.stringify(b.counts));
  }

  {
    // pi 没运行 → 一律 unknown，绝不猜成「已启用」
    const sk = mkSkills(basic, basic.proj, { rpc: mkRpc('down') });
    const b = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const u1 = (b.skills || []).find((s) => s.name === 'u-one');
    check('E23. pi 没起 → piReachable=false、loaded=null', () =>
      (b.piReachable === false && u1.loaded === null) || JSON.stringify({ r: b.piReachable, l: u1.loaded }));
    check('E24. pi 没起 → 状态是 unknown，且说明写「无法确认」而不是「否」', () =>
      (u1.state === 'unknown' && /无法确认|pi 未运行/.test(u1.stateNote)) || JSON.stringify({ state: u1.state, note: u1.stateNote }));

    const sk2 = mkSkills(basic, basic.proj, { rpc: mkRpc('error') });
    const b2 = (await call(sk2, 'GET', '/api/skills')).jsonBody();
    check('E25. rpc 返回 __error → piReachable=false（不崩）', () => b2.piReachable === false || JSON.stringify(b2.piReachable));

    const sk3 = mkSkills(basic, basic.proj, {});
    const b3 = (await call(sk3, 'GET', '/api/skills')).jsonBody();
    check('E26. rpc 完全没传 → piReachable=false', () => b3.piReachable === false || JSON.stringify(b3.piReachable));
  }

  {
    // 磁盘上有、pi 却没报、也没被信任/停用拦着 → not-loaded（如实说「没加载」）
    const w = mkWorld('notloaded');
    writeSkill(path.join(w.agent, 'skills'), 'u-one', { description: 'User one' });
    const sk = mkSkills(w, w.proj, { rpc: mkRpc([]) });
    const b = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const s = b.skills[0];
    check('E27. 磁盘上有但 pi 没报 → state=not-loaded（不是 enabled）', () =>
      (s && s.state === 'not-loaded' && s.loaded === false) || JSON.stringify({ state: s && s.state, loaded: s && s.loaded }));
    check('E28. not-loaded 的说明点出「磁盘上有，但 pi 没加载」', () => /磁盘上有/.test(s.stateNote) || s.stateNote);
  }

  /* ================= F. 同名覆盖 ================= */
  section('F. 同名覆盖（project 胜出）');

  {
    const w = mkWorld('clash');
    const userFile = writeSkill(path.join(w.agent, 'skills'), 'clash-skill', { description: 'CLASH from USER' });
    const projFile = writeSkill(path.join(w.proj, '.pi', 'skills'), 'clash-skill', { description: 'CLASH from PROJECT' });
    const sk = mkSkills(w, w.proj, {
      rpc: mkRpc([{ name: 'clash-skill', description: 'CLASH from PROJECT', sourceInfo: { path: projFile, scope: 'project', source: 'auto', origin: 'top-level', baseDir: path.join(w.proj, '.pi') } }]),
      approve: true,
    });
    const b = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const proj = (b.skills || []).find((s) => s.scope === 'project');
    const user = (b.skills || []).find((s) => s.scope === 'user');

    check('F1. 同名两条都列出来（不静默丢掉一条）', () => b.skills.length === 2 || JSON.stringify(b.skills.map((s) => s.scope)));
    check('F2. project 那条 state=enabled 且描述来自 pi 报的项目版本', () =>
      (proj.state === 'enabled' && proj.description === 'CLASH from PROJECT') || JSON.stringify({ s: proj.state, d: proj.description }));
    check('F3. user 那条 state=shadowed 且 shadowedBy 指向项目文件', () =>
      (user.state === 'shadowed' && user.shadowedBy === projFile) || JSON.stringify({ s: user.state, by: user.shadowedBy }));
    check('F4. shadowed 的说明里点出「同名」与赢家', () => /同名/.test(user.stateNote) && user.stateNote.includes(projFile) || user.stateNote);
    check('F5. user 那条仍然 toggleable（能被用户自己关掉，免得一直被抢）', () => user.toggleable === true || '不可切换');
    check('F6. 两条的 path 各自指向自己的文件', () => (proj.path === projFile && user.path === userFile) || JSON.stringify({ p: proj.path, u: user.path }));
  }

  /* ================= G. 被 settings 关掉 ================= */
  section('G. 被 settings 关掉');

  {
    const w = mkWorld('disabled');
    writeSkill(path.join(w.agent, 'skills'), 'u-one', { description: 'User one' });
    writeJson(path.join(w.agent, 'settings.json'), { skills: ['!*u-one*'], unknownField: { keep: true } });
    const sk = mkSkills(w, w.proj, { rpc: mkRpc([]) });
    const b = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const s = b.skills[0];
    check('G1. 被 !glob 关掉 → state=disabled', () => (s && s.state === 'disabled') || JSON.stringify(s && s.state));
    check('G2. disabledBy 回报是哪条模式', () => s.disabledBy === '!*u-one*' || s.disabledBy);
    check('G3. stateNote 里带出那条模式', () => s.stateNote.includes('!*u-one*') || s.stateNote);
    check('G4. 仍然 toggleable（用户可以自己打开）', () => s.toggleable === true || '不可切换');
  }

  /* ================= H. 详情 ================= */
  section('H. 详情（内容 / 文件 / 未知 ID / 逃逸）');

  {
    const sk = mkSkills(basic, basic.proj, { rpc: mkRpc(piUserOnly) });
    const list = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const uOne = list.skills.find((s) => s.name === 'u-one');

    const res = await call(sk, 'GET', '/api/skills/' + uOne.id);
    const b = res.jsonBody();
    check('H1. GET 详情 → 200 / ok=true / skill 对得上', () => (res.code === 200 && b.ok === true && b.skill.name === 'u-one') || JSON.stringify(b && b.skill));
    check('H2. 详情带出正文（readable=true）', () => (b.readable === true && /description:/.test(b.content)) || JSON.stringify({ r: b.readable, c: (b.content || '').slice(0, 40) }));
    check('H3. 详情列出同目录文件（含 SKILL.md）', () =>
      (b.files || []).some((f) => f.name === 'SKILL.md') || JSON.stringify(b.files));
    check('H4. 详情里没有 secret 类字段', () => !/apiKey|password|secret/i.test(JSON.stringify(b)) || '有敏感词');

    const unknown = await call(sk, 'GET', '/api/skills/' + '0'.repeat(16));
    check('H5. 未知 ID → 404（不是 500、不是空 200）', () => (unknown.code === 404 && unknown.jsonBody().ok === false) || JSON.stringify(unknown.jsonBody()));

    // 用「已知根之外的真实路径」算出的 ID 也必须是 404 —— 索引里没有它就查不到
    const outsideId = I.skillId(path.join(os.tmpdir(), 'not-a-skill', 'SKILL.md'));
    const outside = await call(sk, 'GET', '/api/skills/' + outsideId);
    check('H6. 索引外的路径算出的 ID → 404（拿不到任何文件）', () => outside.code === 404 || outside.code);

    const trav = await call(sk, 'GET', '/api/skills/' + encodeURIComponent('../../../../etc/passwd'));
    check('H7. 路径穿越 ID → 404（不会被当成路径去读）', () => trav.code === 404 || trav.code);
    const trav2 = await call(sk, 'GET', '/api/skills/' + encodeURIComponent('C:\\Windows\\win.ini'));
    check('H8. 绝对路径 ID → 404', () => trav2.code === 404 || trav2.code);
    check('H9. 响应体里不包含被请求的那个路径（没有回显路径）', () => !trav2.body().includes('win.ini') || trav2.body());

    const tooLong = await call(sk, 'GET', '/api/skills/' + 'a'.repeat(80));
    check('H10. 超长 ID → 400', () => tooLong.code === 400 || tooLong.code);

    const post = await call(sk, 'POST', '/api/skills');
    check('H11. POST /api/skills → 405', () => post.code === 405 || post.code);
    const del = await call(sk, 'DELETE', '/api/skills/' + uOne.id);
    check('H12. DELETE → 405（第一版不提供删除）', () => del.code === 405 || del.code);
  }

  {
    // 由 pi 报告、但 Pi GUI 在磁盘上没枚举到的 skill（package / --skill 临时加载）
    const w = mkWorld('pi-only');
    writeSkill(path.join(w.agent, 'skills'), 'u-one', { description: 'User one' });
    const outsideFile = path.join(w.base, 'elsewhere', 'tmp-one', 'SKILL.md');
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.writeFileSync(outsideFile, '---\nname: tmp-one\ndescription: Temporary\n---\n', 'utf8');

    const sk = mkSkills(w, w.proj, {
      rpc: mkRpc([
        { name: 'u-one', description: 'User one' },
        { name: 'tmp-one', description: 'Temporary', sourceInfo: { path: outsideFile, scope: 'temporary', source: 'local', origin: 'top-level', baseDir: path.dirname(outsideFile) } },
        { name: 'pkg-skill', description: 'From a package' },
      ]),
    });
    const b = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const byName = (n) => (b.skills || []).find((s) => s.name === n);
    check('H13. pi 报了但磁盘没枚举到的 skill 会被补进列表（不丢信息）', () =>
      (Boolean(byName('pkg-skill')) && byName('pkg-skill').state === 'enabled') || JSON.stringify(b.skills.map((s) => s.name)));
    check('H14. 补进来的那条 toggleable=false（没有 settings 条目可写）', () => byName('pkg-skill').toggleable === false || '竟然可切换');
    check('H15. 临时（--skill）加载的 → scope=temporary', () => byName('tmp-one').scope === 'temporary' || byName('tmp-one').scope);
    check('H16. 临时 skill 的 disablePattern 为空（不假装能写 settings）', () => byName('tmp-one').disablePattern === '' || byName('tmp-one').disablePattern);

    const det = await call(sk, 'GET', '/api/skills/' + byName('tmp-one').id);
    check('H17. 详情：路径在已知根之外 → 403（纵深防御，不读它）', () => (det.code === 403 && det.jsonBody().ok === false) || JSON.stringify(det.jsonBody()));
    const det2 = await call(sk, 'GET', '/api/skills/' + byName('pkg-skill').id);
    check('H18. 详情：pi 没给路径 → 200 但 readable=false，并说明只能看元数据', () =>
      (det2.code === 200 && det2.jsonBody().readable === false && /没有定位到/.test(det2.jsonBody().note)) || JSON.stringify(det2.jsonBody()));
    const tog = await putJSON(sk, '/api/skills/' + byName('tmp-one').id, { enabled: false });
    check('H19. 对临时 skill 启停 → 400 且说明是 --skill 临时加载', () =>
      (tog.code === 400 && /--skill/.test(tog.jsonBody().error)) || JSON.stringify(tog.jsonBody()));
    const tog2 = await putJSON(sk, '/api/skills/' + byName('pkg-skill').id, { enabled: false });
    check('H20. 对 package skill 启停 → 400（没有可写文件）', () => (tog2.code === 400 && tog2.jsonBody().ok === false) || JSON.stringify(tog2.jsonBody()));
  }

  /* ================= I. 启停与写盘 ================= */
  section('I. 启停（只增删自己那条模式）');

  {
    const w = mkWorld('toggle');
    writeSkill(path.join(w.proj, '.pi', 'skills'), 'p-one', { description: 'Project one' });
    const settingsPath = path.join(w.proj, '.pi', 'settings.json');
    writeJson(settingsPath, { unknownField: { keep: 1 }, other: 'x', skills: ['!*nope*'] });

    const sk = mkSkills(w, w.proj, { rpc: mkRpc([{ name: 'p-one', description: 'Project one' }]), approve: true });
    const list = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const pOne = list.skills.find((s) => s.name === 'p-one');
    check('I1. 起始状态 enabled（项目已信任、无停用规则）', () => pOne.state === 'enabled' || pOne.state);

    const off = await putJSON(sk, '/api/skills/' + pOne.id, { enabled: false });
    const offB = off.jsonBody();
    check('I2. PUT enabled=false → 200 / changed=true / restartRequired=true', () =>
      (off.code === 200 && offB.ok === true && offB.changed === true && offB.restartRequired === true) || JSON.stringify(offB));
    check('I3. 回传的 pattern 就是 -skills/p-one/SKILL.md', () => offB.pattern === '-skills/p-one/SKILL.md' || offB.pattern);
    check('I4. 回传的 path 是项目 settings（作用域配对）', () => offB.path === settingsPath || offB.path);
    check('I5. 说明里写了「需要重启 pi 才生效」', () => /重启/.test(offB.note) || offB.note);

    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    check('I6. 盘上新增了那条 - 模式', () => (onDisk.skills || []).includes('-skills/p-one/SKILL.md') || JSON.stringify(onDisk.skills));
    check('I7. 未知字段 unknownField / other 原样保留', () =>
      (onDisk.unknownField && onDisk.unknownField.keep === 1 && onDisk.other === 'x') || JSON.stringify(onDisk));
    check('I8. 用户自己的 !*nope* 没被碰', () => (onDisk.skills || []).includes('!*nope*') || JSON.stringify(onDisk.skills));
    check('I9. 写盘后没有 .tmp 残渣', () => listTmp(path.dirname(settingsPath)).length === 0 || listTmp(path.dirname(settingsPath)).join(','));

    const list2 = (await call(sk, 'GET', '/api/skills')).jsonBody();
    check('I10. 重新读列表 → state=disabled（写盘真的生效了）', () => list2.skills.find((s) => s.name === 'p-one').state === 'disabled' || list2.skills.find((s) => s.name === 'p-one').state);

    const again = await putJSON(sk, '/api/skills/' + pOne.id, { enabled: false });
    const againB = again.jsonBody();
    check('I11. 重复关闭 → changed=false / restartRequired=false（不做无意义重启）', () =>
      (againB.changed === false && againB.restartRequired === false) || JSON.stringify(againB));
    check('I12. 重复关闭会说明「设置本来就是这样」', () => againB.warnings.some((x) => /没有改动文件/.test(x)) || JSON.stringify(againB.warnings));

    const on = await putJSON(sk, '/api/skills/' + pOne.id, { enabled: true });
    const onB = on.jsonBody();
    check('I13. PUT enabled=true → changed=true / restartRequired=true', () => (onB.changed === true && onB.restartRequired === true) || JSON.stringify(onB));
    const onDisk2 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    check('I14. 我们那条模式被删掉，用户那条与未知字段还在', () =>
      (!(onDisk2.skills || []).includes('-skills/p-one/SKILL.md') && (onDisk2.skills || []).includes('!*nope*') && onDisk2.other === 'x') ||
      JSON.stringify(onDisk2));
    const list3 = (await call(sk, 'GET', '/api/skills')).jsonBody();
    check('I15. 重新读列表 → 回到 enabled', () => list3.skills.find((s) => s.name === 'p-one').state === 'enabled' || list3.skills.find((s) => s.name === 'p-one').state);
  }

  {
    // 用户自己还有一条通配在关着它 → 删掉我们那条不会生效，必须如实警告
    const w = mkWorld('toggle-glob');
    writeSkill(path.join(w.proj, '.pi', 'skills'), 'p-one', { description: 'Project one' });
    const settingsPath = path.join(w.proj, '.pi', 'settings.json');
    writeJson(settingsPath, { skills: ['-skills/p-one/SKILL.md', '!*p-one*'] });
    const sk = mkSkills(w, w.proj, { rpc: mkRpc([]), approve: true });
    const list = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const pOne = list.skills.find((s) => s.name === 'p-one');
    check('I16. - 模式优先级最高，disabledBy 报的是 - 那条', () => pOne.disabledBy === '-skills/p-one/SKILL.md' || pOne.disabledBy);

    const on = await putJSON(sk, '/api/skills/' + pOne.id, { enabled: true });
    const onB = on.jsonBody();
    check('I17. 打开时删掉我们那条，并警告还有 !*p-one* 在关着它', () =>
      (onB.changed === true && onB.warnings.some((x) => x.includes('!*p-one*'))) || JSON.stringify(onB.warnings));
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    check('I18. 盘上只剩用户那条通配（没动它）', () => JSON.stringify(onDisk.skills) === JSON.stringify(['!*p-one*']) || JSON.stringify(onDisk.skills));
    const list2 = (await call(sk, 'GET', '/api/skills')).jsonBody();
    check('I19. 状态仍然是 disabled（因为通配还在）', () => list2.skills.find((s) => s.name === 'p-one').state === 'disabled' || list2.skills.find((s) => s.name === 'p-one').state);
  }

  {
    // 未信任的项目：写盘允许，但要警告「信任之后才生效」
    const w = mkWorld('toggle-untrusted');
    writeSkill(path.join(w.proj, '.pi', 'skills'), 'p-one', { description: 'Project one' });
    const sk = mkSkills(w, w.proj, { rpc: mkRpc([]) });
    const list = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const pOne = list.skills.find((s) => s.name === 'p-one');
    check('I20. 未信任时 state=untrusted', () => pOne.state === 'untrusted' || pOne.state);
    const off = await putJSON(sk, '/api/skills/' + pOne.id, { enabled: false });
    const offB = off.jsonBody();
    check('I21. 未信任时仍可写（写的是用户自己的偏好），但带警告', () =>
      (off.code === 200 && offB.ok === true && offB.warnings.some((x) => /未被信任/.test(x))) || JSON.stringify(offB));
  }

  /* ================= J. 写盘失败 / 非法 settings 的降级 ================= */
  section('J. 写盘失败与非法 settings 的降级');

  {
    const w = mkWorld('bad-skills-field');
    writeSkill(path.join(w.proj, '.pi', 'skills'), 'p-one', { description: 'Project one' });
    const settingsPath = path.join(w.proj, '.pi', 'settings.json');
    writeJson(settingsPath, { skills: 'oops', keep: 1 });
    const sk = mkSkills(w, w.proj, { rpc: mkRpc([]), approve: true });
    const list = (await call(sk, 'GET', '/api/skills')).jsonBody();
    check('J1. skills 不是数组时列表仍能出来（该项视为无停用规则）', () =>
      (list.ok === true && list.skills.some((s) => s.name === 'p-one')) || JSON.stringify(list.skills && list.skills.map((s) => s.name)));
    const pOne = list.skills.find((s) => s.name === 'p-one');
    const res = await putJSON(sk, '/api/skills/' + pOne.id, { enabled: false });
    check('J2. 启停时发现 skills 不是数组 → 409（不擅自改用户的字段）', () =>
      (res.code === 409 && /不是数组/.test(res.jsonBody().error)) || JSON.stringify(res.jsonBody()));
    check('J3. 409 之后盘上文件一字未改', () => {
      const t = fs.readFileSync(settingsPath, 'utf8');
      return (JSON.parse(t).skills === 'oops' && JSON.parse(t).keep === 1) || t;
    });
  }

  {
    const w = mkWorld('bad-json');
    writeSkill(path.join(w.proj, '.pi', 'skills'), 'p-one', { description: 'Project one' });
    const settingsPath = path.join(w.proj, '.pi', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ broken json', 'utf8');
    const sk = mkSkills(w, w.proj, { rpc: mkRpc([]), approve: true });
    const list = (await call(sk, 'GET', '/api/skills')).jsonBody();
    check('J4. settings 是坏 JSON 时列表不崩，且带一条诊断', () =>
      (list.ok === true && (list.diagnostics || []).some((d) => /读不出来/.test(d.message))) || JSON.stringify(list.diagnostics));
    const pOne = list.skills.find((s) => s.name === 'p-one');
    const res = await putJSON(sk, '/api/skills/' + pOne.id, { enabled: false });
    check('J5. 坏 JSON 时启停 → 409（不覆盖用户的文件）', () => (res.code === 409 && /没有做任何改动/.test(res.jsonBody().error)) || JSON.stringify(res.jsonBody()));
    check('J6. 409 之后坏文件仍是原样（没被格式化掉）', () => fs.readFileSync(settingsPath, 'utf8') === '{ broken json' || fs.readFileSync(settingsPath, 'utf8'));
  }

  {
    // 请求体层面的校验
    const w = mkWorld('bad-body');
    writeSkill(path.join(w.agent, 'skills'), 'u-one', { description: 'User one' });
    const sk = mkSkills(w, w.proj, { rpc: mkRpc([]) });
    const list = (await call(sk, 'GET', '/api/skills')).jsonBody();
    const id = list.skills[0].id;

    const noBool = await putJSON(sk, '/api/skills/' + id, { enabled: 'yes' });
    check('J7. enabled 不是布尔 → 400', () => (noBool.code === 400 && /布尔/.test(noBool.jsonBody().error)) || JSON.stringify(noBool.jsonBody()));
    const badJson = await call(sk, 'PUT', '/api/skills/' + id, { body: '{ nope' });
    check('J8. 请求体不是合法 JSON → 400', () => (badJson.code === 400 && /合法 JSON/.test(badJson.jsonBody().error)) || JSON.stringify(badJson.jsonBody()));
    const unknown = await putJSON(sk, '/api/skills/' + 'f'.repeat(16), { enabled: false });
    check('J9. 对未知 ID 启停 → 404', () => unknown.code === 404 || unknown.code);
  }

  /* ================= K. 项目隔离 ================= */
  section('K. 项目级与用户级隔离');

  {
    const w = mkWorld('isolation');
    const a = path.join(w.base, 'proj-a');
    const b = path.join(w.base, 'proj-b');
    for (const d of [a, b]) {
      fs.mkdirSync(path.join(d, '.git'), { recursive: true });
      fs.mkdirSync(path.join(d, '.pi', 'skills'), { recursive: true });
    }
    writeSkill(path.join(a, '.pi', 'skills'), 'a-skill', { description: 'A' });
    writeSkill(path.join(b, '.pi', 'skills'), 'b-skill', { description: 'B' });
    writeSkill(path.join(w.agent, 'skills'), 'u-skill', { description: 'U' });

    const runtime = mkRuntime(a);
    // pi 是按当前项目加载 skill 的 —— 桩也要跟着 cwd 变，否则会「补进来」另一个项目的 skill
    const rpc = {
      request: async (cmd) => {
        if (!cmd || cmd.type !== 'get_commands') return null;
        const cur = runtime.getCurrentCwd();
        const names = cur === a ? ['a-skill', 'u-skill'] : cur === b ? ['b-skill', 'u-skill'] : ['u-skill'];
        return { commands: names.map((n) => ({ name: 'skill:' + n, description: '', source: 'skill', sourceInfo: {} })) };
      },
    };
    const sk = createSkills({ runtime, rpc, env: w.env, homeDir: w.home, approve: true });

    const la = (await call(sk, 'GET', '/api/skills')).jsonBody();
    runtime.setCurrentCwd(b);
    const lb = (await call(sk, 'GET', '/api/skills')).jsonBody();

    check('K1. 切到 A 只看到 A 的项目 skill + 用户 skill', () => {
      const names = la.skills.map((s) => s.name).sort().join(',');
      return names === 'a-skill,u-skill' || names;
    });
    check('K2. 切到 B 只看到 B 的项目 skill + 用户 skill', () => {
      const names = lb.skills.map((s) => s.name).sort().join(',');
      return names === 'b-skill,u-skill' || names;
    });
    check('K3. 两个项目各自的 settingsPath 不同', () => {
      const pa = la.skills.find((s) => s.name === 'a-skill').settingsPath;
      const pb = lb.skills.find((s) => s.name === 'b-skill').settingsPath;
      return (pa === path.join(a, '.pi', 'settings.json') && pb === path.join(b, '.pi', 'settings.json')) || pa + ' / ' + pb;
    });

    // 关掉 A 的项目 skill，不能影响 B，也不能影响用户级
    const idA = la.skills.find((s) => s.name === 'a-skill').id;
    runtime.setCurrentCwd(a);
    await putJSON(sk, '/api/skills/' + idA, { enabled: false });
    check('K4. 关 A 的项目 skill 只写进 A 的 settings', () =>
      (fs.existsSync(path.join(a, '.pi', 'settings.json')) && !fs.existsSync(path.join(b, '.pi', 'settings.json'))) || '写错地方了');

    runtime.setCurrentCwd(b);
    const lb2 = (await call(sk, 'GET', '/api/skills')).jsonBody();
    check('K5. 切回 B 时 b-skill 仍是 enabled（互不影响）', () => lb2.skills.find((s) => s.name === 'b-skill').state === 'enabled' || lb2.skills.find((s) => s.name === 'b-skill').state);
    check('K6. 用户级 skill 也没被牵连', () => lb2.skills.find((s) => s.name === 'u-skill').state === 'enabled' || lb2.skills.find((s) => s.name === 'u-skill').state);

    runtime.setCurrentCwd(null);
    const ln = (await call(sk, 'GET', '/api/skills')).jsonBody();
    check('K7. 没有项目时只剩用户级 skill', () => {
      const scopes = new Set(ln.skills.map((s) => s.scope));
      return (ln.hasProject === false && !scopes.has('project')) || JSON.stringify([...scopes]);
    });
    check('K8. 没有项目时 trust.reason=no-project', () => ln.trust.reason === 'no-project' || ln.trust.reason);
  }

  /* ================= L. MCP 能力报告 ================= */
  section('L. MCP 能力报告');

  {
    const w = mkWorld('mcp-none');
    const mcp = createMcp({ runtime: mkRuntime(w.proj), env: { HOME: w.home, PI_CODING_AGENT_DIR: w.agent }, piBin: null });
    const res = await call(mcp, 'GET', '/api/mcp');
    const b = res.jsonBody();
    check('L1. GET /api/mcp → 200 / ok=true', () => (res.code === 200 && b && b.ok === true) || JSON.stringify(b));
    check('L2. 找不到 pi 包时 supported=null（不猜成 false）', () => b.supported === null || JSON.stringify(b.supported));
    check('L3. reason 说明「无法检测」', () => /无法检测|没有找到/.test(b.reason) || b.reason);
    check('L4. servers 永远是空数组（没有原生 MCP 就没有 Server 可列）', () => Array.isArray(b.servers) && b.servers.length === 0 || JSON.stringify(b.servers));
    const post = await call(mcp, 'POST', '/api/mcp');
    check('L5. POST /api/mcp → 405（只读）', () => post.code === 405 || post.code);
  }

  {
    // 造一个「没有 MCP」的假 pi 包 —— 结构和真 pi 一样
    const w = mkWorld('mcp-nosupport');
    const pkg = path.join(w.base, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
    fs.mkdirSync(path.join(pkg, 'dist', 'core'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'docs'), { recursive: true });
    writeJson(path.join(pkg, 'package.json'), { name: '@earendil-works/pi-coding-agent', version: '0.87.0', bin: { pi: 'dist/cli.js' } });
    fs.writeFileSync(
      path.join(pkg, 'docs', 'usage.md'),
      '# Usage\n\nIt intentionally does not include built-in MCP, sub-agents, or plan mode.\n',
      'utf8'
    );
    const binPath = path.join(w.base, 'prefix', 'bin', 'pi');
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, '#!/usr/bin/env node\n', 'utf8');

    const env = { HOME: w.home, PI_CODING_AGENT_DIR: w.agent, PI_BIN: binPath };
    const mcp = createMcp({ runtime: mkRuntime(w.proj), env, piBin: binPath });
    const b = mcp.readReport();

    check('L6. 定位到 pi 包并读出真实版本号', () => b.piVersion === '0.87.0' || b.piVersion);
    check('L7. 包里没有 MCP 模块 → supported=false', () => b.supported === false || JSON.stringify(b.supported));
    check('L8. 从 docs 里截出提到 MCP 的原文当证据', () => /docs[\\/]usage\.md/.test(b.evidence) && /MCP/.test(b.evidence) || b.evidence);
    check('L9. reason 说明「官方明确不内置」', () => /没有内置|没有任何 MCP/.test(b.reason) || b.reason);
    check('L10. serversNote 说明为什么列不出 Server', () => /没有 MCP 配置|没有 Server/.test(b.serversNote) || b.serversNote);
    check('L11. piPackageDir 指向我们造的包', () => b.piPackageDir === pkg || b.piPackageDir);
  }

  {
    // 假如将来的 pi 真带了 MCP 模块 —— 检测要能翻过去（不硬编码结论）
    const w = mkWorld('mcp-support');
    const pkg = path.join(w.base, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
    fs.mkdirSync(path.join(pkg, 'dist', 'core'), { recursive: true });
    writeJson(path.join(pkg, 'package.json'), { name: '@earendil-works/pi-coding-agent', version: '9.9.9' });
    fs.writeFileSync(path.join(pkg, 'dist', 'core', 'mcp-manager.js'), 'export const x = 1;\n', 'utf8');
    const binPath = path.join(w.base, 'prefix', 'bin', 'pi');
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, 'x', 'utf8');

    const mcp = createMcp({ runtime: mkRuntime(w.proj), env: { HOME: w.home, PI_CODING_AGENT_DIR: w.agent, PI_BIN: binPath }, piBin: binPath });
    const b = mcp.readReport();
    check('L12. 包里有 mcp 模块 → supported=true（检测不硬编码版本）', () => b.supported === true || JSON.stringify(b.supported));
    check('L13. supported=true 时 serversNote 说「检测到但 Pi GUI 还没适配」', () => /还没有适配/.test(b.serversNote) || b.serversNote);
    check('L14. supported=true 时 servers 仍然是空（不编造 Server）', () => b.servers.length === 0 || JSON.stringify(b.servers));
  }

  {
    // 扩展清单：只列名字，不读内容 —— 文件里的 secret 绝不能出现在响应里
    const w = mkWorld('mcp-ext');
    const extDir = path.join(w.agent, 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'my-ext.js'), 'const GITHUB_TOKEN = "ghp_LEAK_ME_1234";\n', 'utf8');
    fs.writeFileSync(path.join(extDir, '.hidden.js'), 'x', 'utf8');
    fs.mkdirSync(path.join(extDir, 'a-dir'), { recursive: true });
    writeJson(path.join(w.agent, 'settings.json'), { extensions: ['./my-ext.js'], packages: ['some-pkg@1.0.0'] });
    const projExt = path.join(w.proj, '.pi', 'extensions');
    fs.mkdirSync(projExt, { recursive: true });
    fs.writeFileSync(path.join(projExt, 'proj-ext.js'), 'x', 'utf8');

    const mcp = createMcp({ runtime: mkRuntime(w.proj), env: { HOME: w.home, PI_CODING_AGENT_DIR: w.agent }, piBin: null });
    const b = mcp.readReport();
    const body = JSON.stringify(b);
    check('L15. 列出用户级扩展目录里的条目', () => {
      const names = b.extensionRoute.user.entries.map((e) => e.name).sort().join(',');
      return names === 'a-dir,my-ext.js' || names;
    });
    check('L16. 跳过点开头文件', () => !b.extensionRoute.user.entries.some((e) => e.name.startsWith('.')) || '列出了隐藏文件');
    check('L17. 列出项目级扩展目录（与用户级分开）', () =>
      (b.extensionRoute.project.entries.length === 1 && b.extensionRoute.project.entries[0].name === 'proj-ext.js') || JSON.stringify(b.extensionRoute.project.entries));
    check('L18. 目录不存在 → exists=false 而不是报错', () => {
      const w2 = mkWorld('mcp-ext-missing');
      const m2 = createMcp({ runtime: mkRuntime(w2.proj), env: { HOME: w2.home, PI_CODING_AGENT_DIR: w2.agent }, piBin: null });
      const r2 = m2.readReport();
      return (r2.extensionRoute.user.exists === false && r2.extensionRoute.user.error === '') || JSON.stringify(r2.extensionRoute.user);
    });
    check('L19. 关键：扩展文件里的 secret **绝不出现在响应里**（只读名字，不读内容）', () =>
      !/ghp_LEAK_ME/.test(body) || '泄露了！');
    check('L20. 条目只带名字/类型/大小/时间，没有内容字段', () => {
      const e = b.extensionRoute.user.entries.find((x) => x.name === 'my-ext.js');
      return (e && !('content' in e) && 'size' in e && 'kind' in e) || JSON.stringify(e);
    });
    check('L21. settings 里的 extensions / packages 被如实列出（不解析、不执行）', () =>
      (b.extensionRoute.fromSettings.length === 1 && b.extensionRoute.fromSettings[0].value === './my-ext.js' && b.extensionRoute.packages[0].value === 'some-pkg@1.0.0') ||
      JSON.stringify({ s: b.extensionRoute.fromSettings, p: b.extensionRoute.packages }));
    check('L22. 报告里没有任何「已配置 / 已连接」这类没数据支撑的状态', () =>
      !/已连接|connected|已配置的 Server/i.test(body) || '出现了不该有的状态词');
  }

  /* ================= M. 访问控制（经真实 router） ================= */
  section('M. 访问控制（真实 router）');

  {
    const { createRouter } = await import('../server/router.js');
    const { createAuth } = await import('../server/auth.js');
    const { createRuntime } = await import('../server/runtime.js');

    const w = mkWorld('auth');
    writeSkill(path.join(w.agent, 'skills'), 'u-one', { description: 'User one' });
    const runtime = createRuntime({ initialCwd: w.proj });
    const skills = createSkills({ runtime, rpc: mkRpc([{ name: 'u-one', description: 'User one' }]), env: w.env, homeDir: w.home });
    const mcp = createMcp({ runtime, env: w.env, piBin: null });
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
      projectConfig: { handle: passthrough('projectConfig') },
      skills,
      mcp,
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

    const noTok = await hit('GET', '/api/skills');
    check('M1. GET /api/skills 不带令牌 → 401', () => noTok.code === 401 || noTok.code);
    const putNoTok = await hit('PUT', '/api/skills/' + 'a'.repeat(16), {}, '{"enabled":false}');
    check('M2. PUT /api/skills/<id> 不带令牌 → 401', () => putNoTok.code === 401 || putNoTok.code);
    const mcpNoTok = await hit('GET', '/api/mcp');
    check('M3. GET /api/mcp 不带令牌 → 401', () => mcpNoTok.code === 401 || mcpNoTok.code);

    const cross = await hit('GET', '/api/skills', { 'x-pi-gui-token': 'T', origin: 'https://evil.example' });
    check('M4. 跨站 Origin + 正确令牌 → 403（Origin 先判）', () => cross.code === 403 || cross.code);

    const listRes = await hit('GET', '/api/skills', { 'x-pi-gui-token': 'T' });
    check('M5. 带令牌同源 GET /api/skills → 200 且来自 skills', () =>
      (listRes.code === 200 && listRes.jsonBody().ok === true && Array.isArray(listRes.jsonBody().skills)) || listRes.body().slice(0, 200));

    const id = listRes.jsonBody().skills[0].id;
    const putRes = await hit('PUT', '/api/skills/' + id, { 'x-pi-gui-token': 'T' }, '{"enabled":false}');
    check('M6. PUT 不被 405 兜底吃掉（路由顺序正确）→ 200', () =>
      (putRes.code === 200 && putRes.jsonBody().ok === true && putRes.jsonBody().changed === true) || JSON.stringify(putRes.jsonBody()));

    const mcpRes = await hit('GET', '/api/mcp', { 'x-pi-gui-token': 'T' });
    check('M7. 带令牌同源 GET /api/mcp → 200 且来自 mcp', () =>
      (mcpRes.code === 200 && mcpRes.jsonBody().ok === true && 'supported' in mcpRes.jsonBody()) || mcpRes.body().slice(0, 200));

    const proj = await hit('GET', '/api/projects', { 'x-pi-gui-token': 'T' });
    check('M8. 新增两条路由没有遮蔽 /api/projects', () => (proj.jsonBody() && proj.jsonBody().handler === 'projects') || proj.body());
  }

  /* ================= N. 装配（静态） ================= */
  section('N. 装配与打包');

  {
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('N1. server.js 真的装配了 skills / mcp 并传给 router', () =>
      /createSkills\(/.test(serverSrc) && /createMcp\(/.test(serverSrc) && /createRouter\(\{[\s\S]*?skills[\s\S]*?mcp[\s\S]*?\}\)/.test(serverSrc) || '没接上');
    const routerSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'router.js'), 'utf8');
    check('N2. router 里 /api/skills 与 /api/mcp 的转发都在 405 兜底之前', () => {
      const iSkill = routerSrc.indexOf("'/api/skills'");
      const iMcp = routerSrc.indexOf("'/api/mcp'");
      // 找真正的代码行，不是注释里提到的那句
      const i405 = routerSrc.indexOf("if (req.method !== 'GET')");
      return (iSkill > -1 && iMcp > -1 && i405 > -1 && iSkill < i405 && iMcp < i405) || JSON.stringify({ iSkill, iMcp, i405 });
    });
    check('N3. MAX_SKILL_BYTES 被导出（UI 需要说明截断）', () => Number.isFinite(MAX_SKILL_BYTES) && MAX_SKILL_BYTES > 0 || MAX_SKILL_BYTES);
  }

  /* ---------- 收尾 ---------- */
  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})().catch((err) => {
  console.error('\n测试自身崩了：', err);
  cleanup();
  process.exitCode = 1;
});
