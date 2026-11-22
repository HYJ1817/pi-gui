/* 已安装的 Pi 包：只读清单 + 受控的安装 / 卸载 / 更新（第二阶段 B）的离线回归测试。
 *
 * ---------- 这一套要钉住什么 ----------
 *
 *   1. **清单只读盘、三值**：装上了 / 没装 / 不知道，各有各的判据；
 *      「托管目录里没有」≠「没装」（用户级的包 Pi 还会去别处找、下次启动会补装）。
 *   2. **与 Registry 用同一条 id 规则**：清单里的 `extensionIds` 必须就是真实
 *      Registry 给出的那些 id —— 用真实的 `createExtensionRegistry` 交叉核对。
 *   3. **renderer 只送受控 id**：市场条目 `npm:<包名>` 或清单里的 `pkg_<hash>`；
 *      服务端自己解析成 source，请求体里的 source / name / args 一概不读。
 *   4. **只装目录里此刻真有的包**；npm 标记为不安全的不装；已经配置过的不重复装。
 *   5. **只管理用户级的 npm 包**：项目级、Git、本地目录、固定了精确版本的更新 ——
 *      一律禁用并说明原因，不出现假按钮。
 *   6. **命令退出码 0 只说明命令结束了**：装没装上 / 卸没卸掉 / 版本变没变，
 *      由命令之后**在锁里重新读盘**回答（`verified`）；`loaded` 恒为 null。
 *   7. **失败要能恢复**：每个结果都带操作前后的盘上事实、原因分类、
 *      下一步提示和可以手动执行的命令原文。
 *
 * ---------- 离线纪律 ----------
 *
 * 所有会写盘的东西都在 `os.tmpdir()` 的 fixture 里（假的 agentDir、假的项目）。
 * 「Pi」是一个按 Pi 1.6.0 的行为改 fixture 的替身（settings.json 的 `packages`
 * 数组 + `<agentDir>/npm/node_modules/<包名>`），**测试绝不真的跑 pi / npm**，
 * 也不读写这台机器真实的 `~/.pi`。执行器用的是真实的 `createCapabilityInstall`，
 * 所以锁、闸门、暂停与恢复走的是生产代码，不是另一份替身。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
async function check(name, cond) {
  let ok;
  try {
    ok = typeof cond === 'function' ? await cond() : cond;
  } catch (err) {
    ok = '抛错：' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
  }
  if (ok === true) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (ok ? '  → ' + ok : ''));
  }
}
function section(title) {
  console.log('\n--- ' + title + ' ---');
}
/** 深比较；不等时回一段可读的差异（而不是 false）。 */
function same(got, want) {
  try {
    assert.deepEqual(got, want);
    return true;
  } catch {
    return `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
  }
}

/* ---------- HTTP 替身 ---------- */

function mockReq(method = 'GET') {
  const listeners = new Map();
  const req = {
    method,
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return req;
    },
    emit(ev, arg) {
      for (const fn of listeners.get(ev) || []) fn(arg);
    },
  };
  return req;
}
function mockRes() {
  return {
    code: null,
    body: null,
    writeHead(code) {
      this.code = code;
      return this;
    },
    end(value) {
      this.body = value;
      return this;
    },
    get payload() {
      return JSON.parse(this.body);
    },
  };
}
/** 走一遍 handle：请求体在 handler 挂好监听之后再喂（与真实的 IncomingMessage 一样）。 */
async function http(handle, method, body, url) {
  const req = mockReq(method);
  const res = mockRes();
  const pending = handle(req, res, url);
  await new Promise((resolve) => setImmediate(resolve));
  if (body !== undefined && body !== null) req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
  req.emit('end');
  await pending;
  return res;
}

(async () => {
  const { createExtensionPackages, parsePackageSource } = await import('../server/extension-packages.js');
  const { createCapabilityInstall } = await import('../server/capability-install.js');
  const { createExtensionRegistry } = await import('../server/extension-registry.js');
  const { createExtensionMarket } = await import('../server/extension-market.js');

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-2b-packages-')));
  const ENTRY = { kind: 'node', cmd: process.execPath, baseArgs: ['/pkg/dist/bundle/cli.js'], ok: true };

  /* ---------- fixture：一个「世界」= 一个假的 home + agentDir + 项目 ---------- */

  let worlds = 0;
  function world() {
    const base = path.join(root, `w${++worlds}`);
    const home = path.join(base, 'home');
    const agent = path.join(home, '.pi', 'agent');
    const project = path.join(base, 'project');
    fs.mkdirSync(agent, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    const write = (file, value) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      return file;
    };
    const w = {
      base, home, agent, project,
      env: { HOME: home, PI_CODING_AGENT_DIR: agent },
      write,
      settingsFile: path.join(agent, 'settings.json'),
      settings: (data) => write(path.join(agent, 'settings.json'), data),
      projectSettings: (data) => write(path.join(project, '.pi', 'settings.json'), data),
      readSettings: () => JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')),
      pkgDir: (name, scope = 'global') => path.join(scope === 'global' ? agent : path.join(project, '.pi'), 'npm', 'node_modules', name),
      /** 在托管目录里放一个包：package.json + 若干文件。 */
      pkg(name, manifest = {}, scope = 'global', files = {}) {
        const dir = w.pkgDir(name, scope);
        write(path.join(dir, 'package.json'), { name, version: '1.0.0', ...manifest });
        for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
        return dir;
      },
    };
    return w;
  }

  /**
   * 「Pi」的替身：按 Pi 1.6.0 `package-manager-cli.js` 的可观察行为改 fixture。
   *   install <source> --no-approve          → 装进托管目录 + 登记进 settings.packages
   *   remove  <source> --no-approve          → 按包身份摘掉登记 + 删目录；没登记 → exit 1
   *   update  --extension <source> --no-approve → 换成 registry 里的版本
   * `script` 可以整段接管某一次调用（造失败 / 半成品 / 什么都没做）。
   */
  function fakePi(w, { registry = {}, script = null } = {}) {
    const log = [];
    const nameOf = (entry) => {
      const source = typeof entry === 'string' ? entry : entry && entry.source;
      const m = /^npm:(@?[^@]+)(?:@.+)?$/.exec(typeof source === 'string' ? source : '');
      return m ? m[1] : null;
    };
    const load = () => {
      try {
        return JSON.parse(fs.readFileSync(w.settingsFile, 'utf8'));
      } catch {
        return {};
      }
    };
    const tools = { w, load, save: (data) => w.settings(data), nameOf };
    async function run(args, opts) {
      log.push({ args, opts });
      if (script) {
        const scripted = await script(args, tools);
        if (scripted) return scripted;
      }
      const command = args[0];
      const source = command === 'update' ? args[2] : args[1];
      const name = source.slice('npm:'.length);
      const data = load();
      const entries = Array.isArray(data.packages) ? data.packages : [];
      if (command === 'install') {
        if (!registry[name]) {
          return { ok: false, exitCode: 1, stdout: '', stderr: `npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/${name}` };
        }
        w.pkg(name, { version: registry[name] });
        data.packages = [...entries.filter((entry) => nameOf(entry) !== name), source];
        w.settings(data);
        return { ok: true, exitCode: 0, stdout: `Installed ${source}\n`, stderr: '' };
      }
      if (command === 'remove') {
        const kept = entries.filter((entry) => nameOf(entry) !== name);
        if (kept.length === entries.length) return { ok: false, exitCode: 1, stdout: '', stderr: `No matching package found for ${source}` };
        fs.rmSync(w.pkgDir(name), { recursive: true, force: true });
        data.packages = kept;
        w.settings(data);
        return { ok: true, exitCode: 0, stdout: `Removed ${source}\n`, stderr: '' };
      }
      if (command === 'update') {
        if (!entries.some((entry) => nameOf(entry) === name)) {
          return { ok: false, exitCode: 1, stdout: '', stderr: `No matching package found for ${source}` };
        }
        let current = null;
        try {
          current = JSON.parse(fs.readFileSync(path.join(w.pkgDir(name), 'package.json'), 'utf8')).version;
        } catch {
          current = null;
        }
        if (current === registry[name]) return { ok: true, exitCode: 0, stdout: `${source} is already up to date\n`, stderr: '' };
        w.pkg(name, { version: registry[name] });
        return { ok: true, exitCode: 0, stdout: `Updated 1 package:\n  ${source}\n`, stderr: '' };
      }
      return { ok: false, exitCode: 2, stdout: '', stderr: 'unknown command' };
    }
    return { run, log };
  }

  /** 目录的替身：只有安装闸门与「最新版本」用得到的四个只读方法。 */
  function stubCatalog(items = {}, { remote = true, at = 1700000000000 } = {}) {
    const calls = { warm: 0 };
    return {
      calls,
      has: (id) => Object.prototype.hasOwnProperty.call(items, id),
      flagged: (id) => Boolean(items[id] && items[id].flagged),
      latestVersion: (name) => (items[`npm:${name}`] && items[`npm:${name}`].version) || null,
      warm: async () => {
        calls.warm += 1;
      },
      status: () => ({ remote, at }),
    };
  }

  /** 真实执行器 + 假 Pi + 被测模块。 */
  function make(w, {
    cwd = () => w.project, catalog = stubCatalog(), registry = {}, script = null,
    busy = null, pause = { ok: true }, resolveOk = true, withOperations = true,
  } = {}) {
    const pi = fakePi(w, { registry, script });
    const state = { paused: [], resumed: 0, invalidated: 0 };
    const getCwd = () => (typeof cwd === 'function' ? cwd() : cwd);
    const operations = createCapabilityInstall({
      currentCwd: () => getCwd() || '',
      busyReason: () => (typeof busy === 'function' ? busy() : busy),
      resolveInstallTarget: () => (resolveOk ? { ok: true, entry: ENTRY } : { ok: false, code: 'no-proven-entry' }),
      runInstall: pi.run,
      pauseBridge: async (reason) => {
        state.paused.push(reason);
        return pause;
      },
      resumeBridge: () => {
        state.resumed += 1;
      },
      invalidateCaches: () => {
        state.invalidated += 1;
      },
    });
    const packages = createExtensionPackages({
      runtime: { getCurrentCwd: getCwd },
      env: w.env,
      operations: withOperations ? operations : null,
      catalog,
    });
    return { packages, operations, pi, state, catalog };
  }

  const find = (inventory, name, scope = 'global') => inventory.packages.find((pkg) => pkg.name === name && pkg.scope === scope);
  const idOf = (packages, name, scope = 'global') => {
    const record = find(packages.readInventory(), name, scope);
    return record ? record.id : null;
  };

  try {
    /* ================= A. 来源解析（与 Pi 的 parseSource 同一套分流） ================= */
    section('A. 来源解析');

    await check('A1. npm：不带版本 / 精确版本 / 区间 / 标签', () => {
      const cases = [
        ['npm:foo', { kind: 'npm', name: 'foo', version: null, pin: 'none' }],
        ['npm:@scope/foo', { kind: 'npm', name: '@scope/foo', version: null, pin: 'none' }],
        ['npm:foo@1.2.3', { kind: 'npm', name: 'foo', version: '1.2.3', pin: 'exact' }],
        ['npm:@scope/foo@1.0.0-beta.1+build.5', { kind: 'npm', name: '@scope/foo', version: '1.0.0-beta.1+build.5', pin: 'exact' }],
        ['npm:foo@^1.0.0', { kind: 'npm', name: 'foo', version: '^1.0.0', pin: 'range' }],
        ['npm:foo@~1.2', { kind: 'npm', name: 'foo', version: '~1.2', pin: 'range' }],
        ['npm:foo@latest', { kind: 'npm', name: 'foo', version: 'latest', pin: 'range' }],
        ['npm:foo@1.2', { kind: 'npm', name: 'foo', version: '1.2', pin: 'range' }],
        ['npm:foo@>=1 <2', { kind: 'npm', name: 'foo', version: '>=1 <2', pin: 'range' }],
      ];
      for (const [source, want] of cases) {
        const verdict = same(parsePackageSource(source), want);
        if (verdict !== true) return `${source}: ${verdict}`;
      }
      return true;
    });
    await check('A2. 「精确版本」的判据与 Pi 一致（semver.valid：可带一个 v，数字段不带前导零）', () => {
      const exact = ['1.2.3', 'v1.2.3', '0.0.0', '10.20.30', '1.2.3-rc.1', '1.2.3+sha.abc', ' 1.2.3 '];
      const notExact = ['01.2.3', '1.02.3', '1.2.03', 'vv1.2.3', '=1.2.3', '1.2', '1', '1.2.3.4', 'latest', '^1.2.3', '1.2.x', '*', ''];
      const wrongExact = exact.filter((version) => parsePackageSource(`npm:foo@${version}`).pin !== 'exact');
      const wrongRange = notExact.filter((version) => parsePackageSource(`npm:foo@${version}`).pin === 'exact');
      return (wrongExact.length === 0 && wrongRange.length === 0)
        || `该是精确的：${wrongExact.join(' | ')}；不该是精确的：${wrongRange.join(' | ')}`;
    });
    await check('A3. Git：各种写法都收敛成 host/path，凭据进不了标签', () => {
      const cases = [
        ['git:github.com/acme/pi-thing', 'github.com/acme/pi-thing'],
        ['git:github.com/acme/pi-thing@v1.2.0', 'github.com/acme/pi-thing'],
        ['https://github.com/acme/pi-thing.git', 'github.com/acme/pi-thing'],
        ['https://user:tok3n-SECRET@gitlab.example/x/y.git', 'gitlab.example/x/y'],
        ['https://ghp_abcdef0123456789@github.com/acme/private', 'github.com/acme/private'],
        ['ssh://git@github.com/acme/pi-thing.git', 'github.com/acme/pi-thing'],
        ['git:git@github.com:acme/pi-thing.git', 'github.com/acme/pi-thing'],
        ['github:acme/pi-thing', 'github.com/acme/pi-thing'],
        ['http://git.internal/team/repo', 'git.internal/team/repo'],
      ];
      for (const [source, label] of cases) {
        const parsed = parsePackageSource(source);
        if (parsed.kind !== 'git' || parsed.label !== label) return `${source} → ${JSON.stringify(parsed)}`;
        if (JSON.stringify(parsed).includes('SECRET') || JSON.stringify(parsed).includes('ghp_')) return `${source} 泄了凭据`;
      }
      return true;
    });
    await check('A4. Git 标签认不出安全的形状 → null（界面只说「Git 仓库」，原文不出后端）', () => {
      const odd = ['git:', 'https://', 'git:github.com', 'https://exa mple.com/a/b', 'git:host/pa th', 'https://h/' + 'a'.repeat(200)];
      const leaked = odd.filter((source) => {
        const parsed = parsePackageSource(source);
        return parsed.kind !== 'git' || parsed.label !== null;
      });
      return leaked.length === 0 || leaked.join(' | ');
    });
    await check('A5. 本地路径 / builtin：其余一律是本地路径（与 Pi 的 isLocalPath 相同）', () => {
      const local = ['./local/pkg', '../x', '/abs/pkg', 'C:\\abs\\pkg', 'plain-name', 'git@github.com:acme/x.git'];
      for (const source of local) {
        const parsed = parsePackageSource(source);
        if (parsed.kind !== 'local' || parsed.path !== source) return `${source} → ${JSON.stringify(parsed)}`;
      }
      return same(parsePackageSource('builtin:core'), { kind: 'unknown' });
    });

    /* ================= B. 清单：种类、作用域、三值 ================= */
    section('B. 清单：种类、作用域、三值');

    const inv = world();
    inv.pkg('pi-memory', { version: '0.4.2', description: 'Memory for Pi', pi: { extensions: ['extensions/index.ts'], skills: ['skills/a', 'skills/b'] } },
      'global', { 'extensions/index.ts': 'export default () => {}' });
    inv.pkg('@scope/tool', { version: '1.2.3', pi: { extensions: ['src/main.ts'] } }, 'global', { 'src/main.ts': '' });
    inv.pkg('ranged', { version: '1.4.0' });
    inv.pkg('ranged2', { version: '1.4.0' });
    inv.pkg('filtered', { version: '1.0.0' }, 'global', { 'extensions/a.ts': '', 'extensions/b.ts': '' });
    inv.pkg('Bad_Name', { version: '3.0.0' });
    inv.write(path.join(inv.pkgDir('mismatch'), 'package.json'), { name: 'other-name', version: '9.9.9', description: 'should not be shown' });
    inv.write(path.join(inv.pkgDir('broken-json'), 'package.json'), '{broken');
    inv.pkg('secret-desc', { version: '1.0.0', description: 'configure with api_key=abc123' });
    inv.write(path.join(inv.home, '.pi', 'local-pkg', 'package.json'), { name: 'local-pkg', version: '0.0.1', pi: { extensions: ['index.ts'] } });
    inv.write(path.join(inv.home, '.pi', 'local-pkg', 'index.ts'), '');
    const absLocal = path.join(inv.base, 'abs-local');
    fs.mkdirSync(absLocal, { recursive: true });
    inv.settings({
      theme: 'dark',
      packages: [
        'npm:pi-memory',
        'npm:@scope/tool@1.2.3',
        'npm:ranged@^1.0.0',
        'npm:ranged2@^1.0.0',
        'npm:missing-files',
        { source: 'npm:filtered', extensions: ['extensions/a.ts'] },
        'git:github.com/acme/pi-thing',
        'https://user:tok3n-SECRET@gitlab.example/x/y.git',
        '../local-pkg',
        'npm:Bad_Name',
        'npm:../escape',
        'npm:pi-memory@0.1.0',
        42,
        { nope: true },
        'builtin:core',
        'npm:mismatch',
        'npm:broken-json',
        'npm:secret-desc',
        'npm:',
        '   ',
        absLocal,
        './gone-local',
        'npm:tagged@beta',
        'npm:vpinned@v2.0.0',
      ],
    });
    inv.pkg('proj-only', { version: '0.2.0' }, 'project');
    inv.write(path.join(inv.project, '.pi', 'vendor', 'thing', 'package.json'), { name: 'thing', version: '0.0.9' });
    inv.projectSettings({ packages: ['npm:pi-memory', { source: 'npm:ranged', autoload: false }, 'npm:proj-only', './vendor/thing'] });
    const invCatalog = stubCatalog({
      'npm:pi-memory': { version: '0.5.0' },
      'npm:@scope/tool': { version: '1.3.0' },
      'npm:ranged': { version: '2.0.0' },
      'npm:ranged2': { version: '1.9.0' },
      'npm:filtered': { version: '1.0.0' },
      'npm:secret-desc': { version: '0.9.0' },
      'npm:proj-only': { version: '0.3.0' },
    });
    const invMade = make(inv, { catalog: invCatalog });
    const settingsBefore = fs.readFileSync(inv.settingsFile, 'utf8');
    const inventory = invMade.packages.readInventory();
    const G = (name) => find(inventory, name, 'global');
    const P = (name) => find(inventory, name, 'project');

    /* 用户级登记了 24 条：1 条同级重复 + 4 条无效进诊断，剩 19 条记录；项目级 4 条。 */
    await check('B1. 顶层形状：ok / hasProject / packages / diagnostics / operations / installRoot / catalog', () =>
      same({ ...inventory, packages: inventory.packages.length, diagnostics: inventory.diagnostics.length }, {
        ok: true, hasProject: true, packages: 23, diagnostics: 5,
        operations: { available: true, running: false },
        installRoot: path.join(inv.agent, 'npm', 'node_modules'),
        catalog: { remote: true, at: 1700000000000 },
      }));
    await check('B2. 项目级排在用户级前面（与 Pi 的解析次序一致）', () => {
      const scopes = inventory.packages.map((pkg) => pkg.scope);
      const firstGlobal = scopes.indexOf('global');
      return (firstGlobal === 4 && scopes.slice(0, 4).every((scope) => scope === 'project')
        && scopes.slice(4).every((scope) => scope === 'global')) || scopes.join(',');
    });
    await check('B3. 装好的 npm 包：完整记录（版本 / 描述 / 资源 / 位置 / 已知能力 / 动作 / 手动命令）', () => {
      const record = { ...G('pi-memory') };
      const ids = record.extensionIds;
      delete record.id;
      delete record.extensionIds;
      const verdict = same(record, {
        kind: 'npm', name: 'pi-memory', scope: 'global', source: 'npm:pi-memory', spec: null, pin: 'none',
        installed: true, version: '0.4.2', description: 'Memory for Pi',
        location: inv.pkgDir('pi-memory'), capabilityId: 'memory',
        resources: { declared: true, extensions: 1, skills: 2, prompts: null, themes: null },
        filtered: false, shadowed: true, latest: '0.5.0', updateAvailable: true, problem: null,
        actions: { update: { allowed: true, reason: '', repair: false }, remove: { allowed: true, reason: '' } },
        manual: { update: 'pi update --extension npm:pi-memory', remove: 'pi remove npm:pi-memory', unpin: null },
      });
      return verdict === true ? (ids.length === 1 && /^[0-9a-f]{20}$/.test(ids[0])) || JSON.stringify(ids) : verdict;
    });
    await check('B4. id 是 pkg_ + 20 位十六进制；清单里唯一；重读不变；同名不同级的 id 不同', () => {
      const ids = inventory.packages.map((pkg) => pkg.id);
      const again = invMade.packages.readInventory().packages.map((pkg) => pkg.id);
      return (ids.every((id) => /^pkg_[0-9a-f]{20}$/.test(id)) && new Set(ids).size === ids.length
        && same(ids, again) === true && G('pi-memory').id !== P('pi-memory').id) || ids.join(',');
    });
    await check('B5. 固定了精确版本：pin=exact，更新禁用并说明原因，给出解除固定的命令', () => {
      const record = G('@scope/tool');
      const vpinned = G('vpinned');
      return (record.spec === '1.2.3' && record.pin === 'exact' && record.installed === true && record.version === '1.2.3'
        && record.actions.update.allowed === false && record.actions.update.reason === '已固定在 1.2.3，Pi 不会更新固定了精确版本的包'
        && record.actions.remove.allowed === true && record.manual.unpin === 'pi install npm:@scope/tool'
        /* 有新版本是事实（1.3.0 > 1.2.3），能不能更新是另一回事 */
        && record.latest === '1.3.0' && record.updateAvailable === false
        && vpinned.pin === 'exact' && vpinned.spec === 'v2.0.0' && vpinned.actions.update.allowed === false)
        || JSON.stringify({ record, vpinned });
    });
    await check('B6. 区间 / 标签：pin=range，可以更新；最新版不在区间里 → 有没有更新是「未知」', () => {
      const out = G('ranged');
      const within = G('ranged2');
      const tagged = G('tagged');
      return (out.pin === 'range' && out.spec === '^1.0.0' && out.actions.update.allowed === true && out.manual.unpin === null
        && out.latest === '2.0.0' && out.updateAvailable === null
        && within.latest === '1.9.0' && within.updateAvailable === true
        && tagged.pin === 'range' && tagged.spec === 'beta') || JSON.stringify({ out, within, tagged });
    });
    await check('B7. 用户级 npm 包在托管目录里没有文件 → installed=null（不是 false），更新标成「修复」', () => {
      const record = G('missing-files');
      return (record.installed === null && record.version === null && record.problem.code === 'files-unconfirmed'
        && record.actions.update.allowed === true && record.actions.update.repair === true
        && record.actions.remove.allowed === true && record.updateAvailable === null) || JSON.stringify(record);
    });
    await check('B8. 项目级 npm 包没有文件 → installed=false（项目级没有别处可找）', () => {
      const record = P('pi-memory');
      return (record.installed === false && record.problem.code === 'package-missing' && record.location === inv.pkgDir('pi-memory', 'project'))
        || JSON.stringify(record);
    });
    await check('B9. 项目级一律只展示：动作禁用并说明原因，手动命令带 -l', () => {
      const record = P('proj-only');
      const reason = '这是项目级配置。Pi GUI 只管理用户级的包，请在项目目录里用 pi 命令管理';
      return (record.installed === true && record.version === '0.2.0'
        && same(record.actions, { update: { allowed: false, reason }, remove: { allowed: false, reason } }) === true
        && record.manual.remove === 'pi remove npm:proj-only -l' && record.manual.update === 'pi update --extension npm:proj-only')
        || JSON.stringify(record);
    });
    await check('B10. 同一个包两级都登记 → 用户级那条 shadowed；autoload:false 的项目条目是增量，不算覆盖', () =>
      (G('pi-memory').shadowed === true && G('ranged').shadowed === false && P('ranged').filtered === true
        && inventory.packages.filter((pkg) => pkg.shadowed).length === 1) || JSON.stringify(inventory.packages.filter((pkg) => pkg.shadowed)));
    await check('B11. 对象形式且带筛选 → filtered=true（启用状态以 Registry 逐项结论为准）', () =>
      (G('filtered').filtered === true && G('pi-memory').filtered === false && G('filtered').installed === true)
        || JSON.stringify(G('filtered')));
    await check('B12. Git 来源：只有 host/path 标签，状态未知，动作禁用，没有手动命令', () => {
      const a = G('pi-thing');
      const b = G('y');
      const reason = 'Git 来源的包请在终端用 pi 命令管理';
      return (a.kind === 'git' && a.source === 'github.com/acme/pi-thing' && a.installed === null && a.location === null
        && a.manual === null && a.actions.update.reason === reason && a.actions.remove.allowed === false
        && b.kind === 'git' && b.source === 'gitlab.example/x/y') || JSON.stringify({ a, b });
    });
    await check('B13. 清单里没有 Git 凭据的任何痕迹', () => {
      const text = JSON.stringify(inventory);
      return (!text.includes('tok3n') && !text.includes('SECRET') && !text.includes('user:')) || '凭据出了后端';
    });
    await check('B14. 本地目录：相对路径相对 settings 所在目录解析；动作禁用', () => {
      const rel = G('local-pkg');
      const abs = G('abs-local');
      const gone = G('gone-local');
      const proj = P('thing');
      return (rel.kind === 'local' && rel.location === path.join(inv.home, '.pi', 'local-pkg') && rel.installed === true
        && rel.version === '0.0.1' && rel.actions.remove.reason === '本地目录里的包由你自己维护，Pi GUI 不改动它' && rel.manual === null
        /* 没有 package.json 的本地目录也算在（Pi 按约定目录收集资源） */
        && abs.installed === true && abs.version === null && abs.location === absLocal
        && gone.installed === false && gone.problem.code === 'package-missing'
        && proj.location === path.join(inv.project, '.pi', 'vendor', 'thing') && proj.version === '0.0.9')
        || JSON.stringify({ rel, abs, gone, proj });
    });
    await check('B15. 包名不过严格规则（大写）→ 看得到、定位得到，但不可操作、不查目录', () => {
      const record = G('Bad_Name');
      return (record.kind === 'npm' && record.installed === true && record.version === '3.0.0' && record.manual === null
        && record.capabilityId === null && record.latest === null && record.updateAvailable === null
        && record.actions.update.allowed === false && record.actions.remove.allowed === false
        && record.actions.remove.reason === '这个来源不在 Pi GUI 的受控范围内，请在终端用 pi 命令管理') || JSON.stringify(record);
    });
    await check('B16. 包名带路径段 → 不拿它拼路径：location=null、状态未知、给出原因', () => {
      const record = G('../escape');
      return (record.kind === 'npm' && record.location === null && record.installed === null
        && record.problem.code === 'unlocatable' && record.actions.remove.allowed === false && record.extensionIds.length === 0)
        || JSON.stringify(record);
    });
    await check('B17. 托管目录里的包名字对不上 / package.json 坏了 → 状态未知，不采信其中任何字段', () => {
      const mismatch = G('mismatch');
      const broken = G('broken-json');
      return (mismatch.installed === null && mismatch.problem.code === 'metadata-mismatch' && mismatch.version === null
        && mismatch.description === null && broken.installed === null && broken.problem.code === 'metadata-invalid'
        && !JSON.stringify(inventory).includes('should not be shown')) || JSON.stringify({ mismatch, broken });
    });
    await check('B18. 描述里出现凭据字样 → 整段不展示', () =>
      (G('secret-desc').description === null && G('secret-desc').installed === true && !JSON.stringify(inventory).includes('abc123'))
        || JSON.stringify(G('secret-desc')));
    await check('B19. builtin: 之类认不出的来源 → kind=unknown，只占一行', () => {
      const record = inventory.packages.find((pkg) => pkg.kind === 'unknown');
      return (record && record.name === '未识别的来源' && record.source === '未识别的来源' && record.installed === null
        && record.actions.update.allowed === false && !JSON.stringify(inventory).includes('builtin:core')) || JSON.stringify(record);
    });
    await check('B20. 无效条目 / 同级重复登记：进诊断，不进清单（Pi 只认第一条）', () => {
      const codes = inventory.diagnostics.map((d) => `${d.scope}:${d.code}`).sort();
      return (same(codes, ['global:duplicate-entry', 'global:entry-invalid', 'global:entry-invalid', 'global:entry-invalid', 'global:entry-invalid']) === true
        && inventory.packages.filter((pkg) => pkg.name === 'pi-memory' && pkg.scope === 'global').length === 1
        && G('pi-memory').spec === null) || codes.join(',');
    });
    await check('B21. 有没有更新：最新版不比本机新 → false；任一边未知 → null', () =>
      (G('filtered').updateAvailable === false && G('secret-desc').updateAvailable === false
        && G('mismatch').updateAvailable === null && P('proj-only').latest === '0.3.0' && P('proj-only').updateAvailable === false)
        || JSON.stringify([G('filtered').updateAvailable, G('secret-desc').updateAvailable, G('mismatch').updateAvailable, P('proj-only')]));
    await check('B22. 读清单不写盘（settings.json 一个字节都没变）', () =>
      fs.readFileSync(inv.settingsFile, 'utf8') === settingsBefore || 'settings.json 被改了');
    await check('B23. light 模式只给身份与安装事实：不解析入口、不查目录版本', () => {
      const light = invMade.packages.readInventory({ light: true });
      return (light.packages.length === inventory.packages.length
        && light.packages.every((pkg) => pkg.extensionIds.length === 0 && pkg.latest === null && pkg.updateAvailable === null)
        && find(light, 'pi-memory').version === '0.4.2' && find(light, 'pi-memory').actions.remove.allowed === true) || '不是轻量形状';
    });
    await check('B24. 内部用的 identity 不出现在任何记录里', () =>
      inventory.packages.every((pkg) => !('identity' in pkg)) || 'identity 泄到了响应里');

    section('B′. 清单：边界');

    await check('B25. 没有项目 → 只有用户级；hasProject=false', () => {
      const { packages } = make(inv, { cwd: () => null, catalog: invCatalog });
      const report = packages.readInventory();
      return (report.hasProject === false && report.packages.length === 19 && report.packages.every((pkg) => pkg.scope === 'global')
        && find(report, 'pi-memory').shadowed === false) || JSON.stringify({ n: report.packages.length });
    });
    await check('B26. 切换项目后清单跟着走（不缓存上一个项目的条目）', () => {
      const other = world();
      other.projectSettings({ packages: ['npm:other-proj'] });
      let cwd = inv.project;
      const { packages } = make(inv, { cwd: () => cwd, catalog: invCatalog });
      const first = packages.readInventory().packages.filter((pkg) => pkg.scope === 'project').map((pkg) => pkg.name);
      cwd = other.project;
      const second = packages.readInventory().packages.filter((pkg) => pkg.scope === 'project').map((pkg) => pkg.name);
      return (first.includes('proj-only') && same(second, ['other-proj']) === true) || JSON.stringify({ first, second });
    });
    await check('B27. settings.json 坏了 → 这一级读不出来，进诊断；另一级照常', () => {
      const w = world();
      w.write(w.settingsFile, '{broken');
      w.projectSettings({ packages: ['npm:still-here'] });
      const report = make(w).packages.readInventory();
      return (same(report.diagnostics.map((d) => `${d.scope}:${d.code}`), ['global:settings-invalid']) === true
        && same(report.packages.map((pkg) => pkg.name), ['still-here']) === true) || JSON.stringify(report);
    });
    await check('B28. 缺省配置为空清单，无法识别的 packages 产生诊断', () => {
      const a = world();
      const b = world();
      b.settings({ theme: 'dark' });
      const c = world();
      c.settings({ packages: { 'npm:x': true } });
      const reports = [a, b, c].map((w) => make(w).packages.readInventory());
      return (reports.every((report) => report.ok === true && report.packages.length === 0)
        && reports[0].diagnostics.length === 0 && reports[1].diagnostics.length === 0
        && reports[2].diagnostics.some(({ code }) => code === 'settings-invalid'))
        || JSON.stringify(reports);
    });
    await check('B29. 超过 300 个条目 → 只读前 300 个，并说明', () => {
      const w = world();
      w.settings({ packages: Array.from({ length: 305 }, (_, index) => `npm:p${index}`) });
      const report = make(w).packages.readInventory();
      return (report.packages.length === 300 && report.diagnostics.some((d) => d.code === 'limit')
        && !report.packages.some((pkg) => pkg.name === 'p300')) || report.packages.length;
    });
    await check('B30. 没有可证明的 CLI 入口 → 所有动作禁用并说明（不出现假按钮）', () => {
      const { packages } = make(inv, { resolveOk: false, catalog: invCatalog });
      const report = packages.readInventory();
      const record = find(report, 'missing-files');
      return (report.operations.available === false && report.packages.every((pkg) => !pkg.actions.update.allowed && !pkg.actions.remove.allowed)
        && record.actions.remove.reason === '当前这份 Pi 没有可证明的官方 CLI 入口，无法执行包操作') || JSON.stringify(record.actions);
    });
    await check('B31. 没有执行器 / 没有目录 → 清单仍然读得出来（少的只是动作与最新版本）', () => {
      const report = createExtensionPackages({ runtime: { getCurrentCwd: () => inv.project }, env: inv.env }).readInventory();
      const record = find(report, 'pi-memory');
      return (report.ok === true && report.operations.available === false && record.installed === true && record.latest === null
        && record.updateAvailable === null && same(report.catalog, { remote: false, at: null }) === true) || JSON.stringify(record);
    });
    await check('B32. 目录自己抛错不影响清单', () => {
      const broken = { latestVersion: () => { throw new Error('x'); }, status: () => { throw new Error('y'); }, has: () => false, warm: async () => {} };
      const report = make(inv, { catalog: broken }).packages.readInventory();
      return (report.ok === true && find(report, 'pi-memory').latest === null && same(report.catalog, { remote: false, at: null }) === true)
        || JSON.stringify(report.catalog);
    });

    /* ================= C. 与真实 Registry 交叉核对 id ================= */
    section('C. 与真实 Registry 交叉核对');

    const cross = world();
    cross.pkg('alpha', { pi: { extensions: ['extensions/index.ts', 'src/extra.ts'] } }, 'global', { 'extensions/index.ts': '', 'src/extra.ts': '' });
    cross.pkg('beta', {}, 'global', { 'extensions/one.ts': '', 'extensions/two.ts': '' });
    cross.pkg('@sc/gamma', { version: '2.0.0', pi: { extensions: ['./main.ts'] } }, 'global', { 'main.ts': '' });
    cross.write(path.join(cross.home, '.pi', 'local-ext', 'package.json'), { name: 'local-ext', pi: { extensions: ['ext.ts'] } });
    cross.write(path.join(cross.home, '.pi', 'local-ext', 'ext.ts'), '');
    cross.pkg('delta', {}, 'project', { 'extensions/d.ts': '' });
    cross.settings({ packages: ['npm:alpha', { source: 'npm:beta', extensions: ['extensions/one.ts'] }, 'npm:@sc/gamma@2.0.0', '../local-ext', 'npm:not-there'] });
    cross.projectSettings({ packages: ['npm:delta'] });
    const crossInventory = make(cross).packages.readInventory();
    const crossRegistry = await createExtensionRegistry({
      runtime: { getCurrentCwd: () => cross.project }, rpc: null, env: cross.env, readTrust: async () => ({ trusted: true }),
    }).readIndex();

    await check('C1. 清单里所有 extensionIds 的并集 = Registry 发现的全部入口 id', () => {
      const mine = new Set(crossInventory.packages.flatMap((pkg) => pkg.extensionIds));
      const theirs = new Set(crossRegistry.extensions.map((ext) => ext.id));
      return (mine.size >= 6 && same([...mine].sort(), [...theirs].sort()) === true) || JSON.stringify({ mine: [...mine], theirs: [...theirs] });
    });
    await check('C2. 逐包核对：每个包的 extensionIds 就是 Registry 里落在这个包目录下的那些入口', () => {
      for (const pkg of crossInventory.packages) {
        if (!pkg.location) continue;
        const prefix = pkg.location.toLowerCase() + path.sep;
        const theirs = crossRegistry.extensions.filter((ext) => ext.source.location.toLowerCase().startsWith(prefix)).map((ext) => ext.id).sort();
        const verdict = same([...pkg.extensionIds].sort(), theirs);
        if (verdict !== true) return `${pkg.name}: ${verdict}`;
      }
      return true;
    });
    await check('C3. 具体数目没有被「两边都漏」掩盖：alpha 2 个、gamma 1 个、local 1 个、delta 1 个', () => {
      const count = (name, scope = 'global') => find(crossInventory, name, scope).extensionIds.length;
      return (count('alpha') === 2 && count('@sc/gamma') === 1 && count('local-ext') === 1 && count('delta', 'project') === 1
        && count('beta') >= 1 && count('not-there') === 0)
        || JSON.stringify(crossInventory.packages.map((pkg) => [pkg.name, pkg.extensionIds.length]));
    });

    /* ================= D. 给市场用的安装摘要 ================= */
    section('D. installedIndex（给插件市场标「已安装 / 可更新」）');

    const index = invMade.packages.installedIndex();
    await check('D1. 只有 npm 包；键是包名', () =>
      (index instanceof Map && !index.has('local-pkg') && !index.has('pi-thing') && !index.has('未识别的来源')
        && index.has('pi-memory') && index.has('@scope/tool') && index.has('proj-only')) || [...index.keys()].join(','));
    await check('D2. 两级都登记 → 取用户级那条（市场里的操作只作用于用户级）', () =>
      same(index.get('pi-memory'), {
        installed: true, version: '0.4.2', scope: 'global', packageId: G('pi-memory').id, pinned: false, canUpdate: true, canRemove: true,
      }));
    await check('D3. 固定版本 / 项目级 / 文件未确认：摘要如实', () =>
      (same(index.get('@scope/tool'), { installed: true, version: '1.2.3', scope: 'global', packageId: G('@scope/tool').id, pinned: true, canUpdate: false, canRemove: true }) === true
        && same(index.get('proj-only'), { installed: true, version: '0.2.0', scope: 'project', packageId: P('proj-only').id, pinned: false, canUpdate: false, canRemove: false }) === true
        && index.get('missing-files').installed === null && index.get('missing-files').canUpdate === true
        && index.get('ranged').scope === 'global') || JSON.stringify([...index.entries()]));

    /* ================= E. 计划闸门：受控 id → 执行计划 ================= */
    section('E. 计划闸门');

    const gateWorld = world();
    gateWorld.pkg('have-it', { version: '1.0.0' });
    gateWorld.pkg('pinned', { version: '1.0.0' });
    gateWorld.pkg('proj-pkg', { version: '1.0.0' }, 'project');
    gateWorld.settings({ packages: ['npm:have-it', 'npm:pinned@1.0.0', 'git:github.com/acme/thing', '../some-local', 'npm:Weird_Name'] });
    gateWorld.projectSettings({ packages: ['npm:proj-pkg', 'npm:proj-configured'] });
    const gateCatalog = stubCatalog({
      'npm:new-ext': { version: '1.2.0' }, 'npm:have-it': { version: '1.0.0' }, 'npm:flagged-ext': { version: '1.0.0', flagged: true },
      'npm:proj-configured': { version: '1.0.0' }, 'npm:@scope/new': { version: '0.1.0' },
    });
    const gate = (options = {}) => make(gateWorld, { catalog: gateCatalog, registry: { 'new-ext': '1.2.0', '@scope/new': '0.1.0' }, ...options });
    const body = (action, id, extra = {}) => ({ action, id, confirm: true, __expectedCwd: gateWorld.project, ...extra });
    const idle = (made) => made.pi.log.length === 0 && made.state.paused.length === 0 && made.state.resumed === 0;

    await check('E1. 未知动作（含原型键、缺省、开关）→ unknown-action', async () => {
      for (const action of ['toggle', 'enable', 'disable', 'config', '__proto__', 'constructor', '', null, undefined, 7]) {
        const made = gate();
        const r = await made.packages.act({ action, id: 'npm:new-ext', confirm: true });
        if (!(r.ok === false && r.code === 'unknown-action')) return `${String(action)} → ${JSON.stringify(r)}`;
        if (!idle(made)) return `${String(action)} 竟然动了 Pi`;
      }
      const made = gate();
      const results = [await made.packages.act(null), await made.packages.act('x'), await made.packages.act([]), await made.packages.act()];
      return (results.every((r) => r.code === 'unknown-action') && idle(made)) || JSON.stringify(results);
    });
    await check('E2. id 不是字符串 / 空 / 超长 → bad-id', async () => {
      for (const id of [null, undefined, 42, {}, ['npm:new-ext'], '', 'npm:' + 'a'.repeat(240)]) {
        const made = gate();
        const r = await made.packages.act({ action: 'install', id, confirm: true });
        if (!(r.ok === false && r.code === 'bad-id' && r.action === 'install')) return `${JSON.stringify(id)} → ${JSON.stringify(r)}`;
        if (!idle(made)) return `${JSON.stringify(id)} 竟然动了 Pi`;
      }
      return true;
    });
    await check('E3. 安装：恶意 / 畸形 id 一律 bad-id（版本、穿越、选项、空白、别的来源、清单 id）', async () => {
      const bad = ['npm:new-ext@1.2.0', 'npm:new-ext@latest', 'npm:../x', 'npm:@a/../b', 'npm:--registry=https://evil.example',
        'npm:-l', 'npm:new ext', 'npm:new-ext\n', ' npm:new-ext', 'npm:New-Ext', 'new-ext', 'git:github.com/a/b',
        'https://github.com/a/b', './local', 'C:\\x', 'pkg_0123456789abcdef0123', 'npm:new-ext;calc', 'npm:$(calc)', 'npm:'];
      for (const id of bad) {
        const made = gate();
        const r = await made.packages.act(body('install', id));
        if (!(r.ok === false && r.code === 'bad-id')) return `${JSON.stringify(id)} → ${JSON.stringify(r)}`;
        if (!idle(made)) return `${JSON.stringify(id)} 竟然动了 Pi`;
      }
      return true;
    });
    await check('E4. 安装：目录里没有这个包 → unknown-item（renderer 不能凭名字装任意 npm 包）', async () => {
      const made = gate();
      const r = await made.packages.act(body('install', 'npm:left-pad'));
      return (r.ok === false && r.code === 'unknown-item' && r.action === 'install' && idle(made)) || JSON.stringify(r);
    });
    await check('E5. 安装：目录自己抛错 / 没有目录 → 同样拒绝（fail closed）', async () => {
      const throwing = make(gateWorld, { catalog: { has: () => { throw new Error('x'); }, warm: async () => { throw new Error('y'); } } });
      const a = await throwing.packages.act(body('install', 'npm:new-ext'));
      const none = make(gateWorld, { catalog: null });
      const b = await none.packages.act(body('install', 'npm:new-ext'));
      return (a.code === 'unknown-item' && b.code === 'unknown-item' && idle(throwing) && idle(none)) || JSON.stringify({ a, b });
    });
    await check('E6. 安装：npm 标记为不安全的包 → not-allowed', async () => {
      const made = gate();
      const r = await made.packages.act(body('install', 'npm:flagged-ext'));
      return (r.ok === false && r.code === 'not-allowed' && r.id === 'npm:flagged-ext' && r.name === 'flagged-ext' && idle(made)) || JSON.stringify(r);
    });
    await check('E7. 安装：已经装了（用户级）/ 当前项目已配置 → already-installed，措辞不同', async () => {
      const made = gate();
      const mine = await made.packages.act(body('install', 'npm:have-it'));
      const proj = await made.packages.act(body('install', 'npm:proj-configured'));
      return (mine.code === 'already-installed' && mine.error.includes('更新') && proj.code === 'already-installed'
        && proj.error.includes('项目') && idle(made)) || JSON.stringify({ mine, proj });
    });
    await check('E7a. 安装仍检查展示上限之外的配置，并拒绝无法解析的项目配置', async () => {
      const w = world();
      w.settings({ packages: [...Array.from({ length: 300 }, (_, i) => `npm:sample-${i}`), { source: 'npm:pi-memory@1.2.3', extensions: [] }] });
      const made = make(w, { catalog: stubCatalog({ 'npm:pi-memory': {} }) });
      const input = body('install', 'npm:pi-memory', { __expectedCwd: w.project });
      const duplicate = await made.packages.act(input);
      w.write(path.join(w.project, '.pi', 'settings.json'), '{broken');
      const unreadable = await made.packages.act(input);
      return (duplicate.code === 'already-installed' && unreadable.code === 'settings-unreadable' && idle(made)) || JSON.stringify({ duplicate, unreadable });
    });
    await check('E7b. 不将 URL、别名或同名重复登记交给 Pi 更新', async () => {
      const w = world();
      w.pkg('local-fixture');
      const made = make(w);
      for (const entries of [
        ['npm:local-fixture@https://example.test/fixture.tgz?token=fixture'],
        ['npm:local-fixture@npm:other-fixture'],
        ['npm:local-fixture', ...Array.from({ length: 300 }, (_, i) => `npm:sample-${i}`), 'npm:local-fixture@npm:other-fixture'],
      ]) {
        w.settings({ packages: entries });
        const report = made.packages.readInventory();
        const record = find(report, 'local-fixture');
        const result = await made.packages.act(body('update', record.id, { __expectedCwd: w.project }));
        if (result.code !== 'not-allowed' || !idle(made) || JSON.stringify(report).includes('token=fixture')) return result.code;
      }
      return true;
    });
    await check('E7c. 拒绝经过符号链接或 Windows 目录联接的托管路径', async () => {
      const w = world();
      const outside = path.join(w.base, 'other');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(w.agent, 'npm'), process.platform === 'win32' ? 'junction' : 'dir');
      const made = make(w, { catalog: stubCatalog({ 'npm:pi-memory': {} }) });
      const result = await made.packages.act(body('install', 'npm:pi-memory', { __expectedCwd: w.project }));
      return (result.code === 'unsafe-package-path' && idle(made)) || JSON.stringify(result);
    });
    await check('E7d. 相对路径与 ~ 解析到实际 Pi 配置目录，并交给受控 CLI', async () => {
      for (const kind of ['relative', 'tilde']) {
        const w = world();
        w.env.PI_CODING_AGENT_DIR = kind === 'relative' ? path.relative(w.project, w.agent) : '~/.pi/agent';
        const made = make(w, { catalog: stubCatalog({ 'npm:pi-memory': {} }), registry: { 'pi-memory': '1.2.3' } });
        const result = await made.packages.act(body('install', 'npm:pi-memory', { __expectedCwd: w.project }));
        if (!(result.ok && made.pi.log[0]?.opts.agentDir === w.agent)) return JSON.stringify(result);
      }
      return true;
    });
    await check('E7e. 用户配置目录指向当前项目时，两个作用域不能重复显示或执行写入', async () => {
      const w = world();
      w.env.PI_CODING_AGENT_DIR = '.pi';
      w.projectSettings({ packages: ['npm:pi-memory'] });
      const made = make(w, { catalog: stubCatalog({ 'npm:pi-memory': {} }) });
      const report = made.packages.readInventory();
      const input = { __expectedCwd: w.project };
      const install = await made.packages.act(body('install', 'npm:pi-memory', input));
      const remove = await made.packages.act(body('remove', report.packages[0].id, input));
      return (report.packages.length === 1 && report.packages[0].scope === 'project'
        && report.operations.available === false && !made.packages.canManageAgentDir()
        && install.code === 'project-agent-dir' && remove.code === 'project-agent-dir' && idle(made)) || JSON.stringify({ report, install, remove });
    });
    await check('E8. 卸载 / 更新：id 必须是 pkg_ + 20 位小写十六进制', async () => {
      const bad = ['npm:have-it', 'have-it', 'pkg_', 'pkg_' + 'a'.repeat(19), 'pkg_' + 'a'.repeat(21), 'pkg_' + 'A'.repeat(20),
        'pkg_' + 'g'.repeat(20), 'pkg_0123456789abcdef0123/../x', ' pkg_0123456789abcdef0123', 'pkg_0123456789abcdef0123\n', 'PKG_0123456789abcdef0123'];
      for (const action of ['remove', 'update']) {
        for (const id of bad) {
          const made = gate();
          const r = await made.packages.act(body(action, id));
          if (!(r.ok === false && r.code === 'bad-id' && r.action === action)) return `${action}/${JSON.stringify(id)} → ${JSON.stringify(r)}`;
          if (!idle(made)) return `${action}/${JSON.stringify(id)} 竟然动了 Pi`;
        }
      }
      return true;
    });
    await check('E9. 卸载 / 更新：清单里没有这个 id → unknown-package', async () => {
      const made = gate();
      const a = await made.packages.act(body('remove', 'pkg_' + '0'.repeat(20)));
      const b = await made.packages.act(body('update', 'pkg_' + 'f'.repeat(20)));
      return (a.code === 'unknown-package' && b.code === 'unknown-package' && idle(made)) || JSON.stringify({ a, b });
    });
    await check('E10. 卸载 / 更新：项目级、Git、本地、名字不规范 → not-allowed，原因就是清单里那句', async () => {
      const made = gate();
      const report = made.packages.readInventory();
      const targets = [find(report, 'proj-pkg', 'project'), find(report, 'thing'), find(report, 'some-local'), find(report, 'Weird_Name')];
      if (targets.some((record) => !record)) return '夹具没建对：' + JSON.stringify(report.packages.map((pkg) => pkg.name));
      for (const record of targets) {
        for (const action of ['remove', 'update']) {
          const r = await made.packages.act(body(action, record.id));
          if (!(r.ok === false && r.code === 'not-allowed' && r.error === record.actions[action].reason && r.name === record.name)) {
            return `${record.name}/${action} → ${JSON.stringify(r)}`;
          }
        }
      }
      return idle(made) || '竟然动了 Pi';
    });
    await check('E11. 固定了精确版本：更新 not-allowed（Pi 自己会跳过它），卸载照常允许', async () => {
      const made = gate();
      const id = idOf(made.packages, 'pinned');
      const update = await made.packages.act(body('update', id));
      return (update.ok === false && update.code === 'not-allowed' && update.error.includes('已固定在 1.0.0') && idle(made)
        && find(made.packages.readInventory(), 'pinned').actions.remove.allowed === true) || JSON.stringify(update);
    });
    await check('E12. 没有执行器 → unsupported（不退化成「假装成功」）', async () => {
      const made = gate({ withOperations: false });
      const r = await made.packages.act(body('install', 'npm:new-ext'));
      return (r.ok === false && r.code === 'unsupported' && idle(made)) || JSON.stringify(r);
    });
    await check('E13. 执行器的闸门拒绝（没确认 / 工作区过期 / 忙 / 没有入口）：带回身份，commandStarted=false', async () => {
      const cases = [
        [gate(), { action: 'install', id: 'npm:new-ext' }, 'confirm-required'],
        [gate(), { action: 'install', id: 'npm:new-ext', confirm: 'yes' }, 'confirm-required'],
        [gate(), { action: 'install', id: 'npm:new-ext', confirm: true, __expectedCwd: path.join(gateWorld.base, 'elsewhere') }, 'workspace-stale'],
        [gate({ busy: { code: 'busy-turn', error: '正在生成' } }), body('install', 'npm:new-ext'), 'busy-turn'],
        [gate({ busy: { code: 'busy-pi-update', error: 'Pi 正在更新' } }), body('install', 'npm:new-ext'), 'busy-pi-update'],
        [gate({ resolveOk: false }), body('install', 'npm:new-ext'), 'unsupported'],
      ];
      for (const [made, input, code] of cases) {
        const r = await made.packages.act(input);
        const verdict = same({ ok: r.ok, code: r.code, action: r.action, id: r.id, name: r.name, commandStarted: r.commandStarted },
          { ok: false, code, action: 'install', id: 'npm:new-ext', name: 'new-ext', commandStarted: false });
        if (verdict !== true) return `${code}: ${verdict}`;
        if (!idle(made)) return `${code} 竟然动了 Pi`;
        if ('before' in r || 'after' in r) return `${code} 不该有读盘结果`;
      }
      return true;
    });
    await check('E14. 用户级 settings.json 解析不了 → settings-unreadable：不执行（Pi 此时不保存登记，只会留下孤儿目录）', async () => {
      const w = world();
      w.write(w.settingsFile, '{ "packages": [ "npm:have-it", ');
      const made = make(w, { catalog: stubCatalog({ 'npm:new-ext': { version: '1.2.0' } }), registry: { 'new-ext': '1.2.0' } });
      const r = await made.packages.act({ action: 'install', id: 'npm:new-ext', confirm: true, __expectedCwd: w.project });
      return (same(r, {
        ok: false, code: 'settings-unreadable', error: r.error, action: 'install', id: 'npm:new-ext', name: 'new-ext',
      }) === true && r.error.includes('settings.json') && idle(made) && !fs.existsSync(w.pkgDir('new-ext'))
        && fs.readFileSync(w.settingsFile, 'utf8') === '{ "packages": [ "npm:have-it", ') || JSON.stringify(r);
    });
    await check('E15. 每次操作前只读一次目录的磁盘缓存（warm）；形状不对的请求连这一步都到不了', async () => {
      const catalog = stubCatalog({ 'npm:new-ext': { version: '1.2.0' } });
      const made = gate({ catalog });
      await made.packages.act({ action: 'toggle', id: 'npm:new-ext', confirm: true });
      await made.packages.act({ action: 'install', id: 42, confirm: true });
      const early = catalog.calls.warm;
      await made.packages.act(body('install', 'npm:left-pad'));
      await made.packages.act(body('remove', 'pkg_' + '0'.repeat(20)));
      return (early === 0 && catalog.calls.warm === 2 && idle(made)) || JSON.stringify({ early, warm: catalog.calls.warm });
    });

    /* ================= F. 安装 ================= */
    section('F. 安装：命令之后读盘才算数');

    const installWorld = () => {
      const w = world();
      w.pkg('keep-me', { version: '1.0.0' });
      w.settings({ theme: 'dark', defaultModel: 'x', packages: ['npm:keep-me'] });
      return w;
    };
    const installCatalog = () => stubCatalog({ 'npm:new-ext': { version: '1.2.0' }, 'npm:other-ext': { version: '2.0.0' }, 'npm:@scope/new': { version: '0.1.0' } });
    const installBody = (w, id = 'npm:new-ext', extra = {}) => ({ action: 'install', id, confirm: true, __expectedCwd: w.project, ...extra });

    await check('F1. 装上了：code=installed / verified=true，前后读盘结果、手动命令都在；loaded 仍是 null', async () => {
      const w = installWorld();
      const made = make(w, { catalog: installCatalog(), registry: { 'new-ext': '1.2.0' } });
      const r = await made.packages.act(installBody(w));
      return same(r, {
        ok: true, code: 'installed', action: 'install', source: 'npm:new-ext', commandCompleted: true, commandStarted: true,
        exitCode: 0, restarted: true, outcome: null, loaded: null,
        id: 'npm:new-ext', name: 'new-ext',
        before: { configured: false, files: false, version: null },
        after: { configured: true, files: true, version: '1.2.0' },
        manual: 'pi install npm:new-ext', verified: true,
      });
    });
    await check('F2. 交给 Pi 的 argv 恰好是 install + npm:<包名> + --no-approve；维护原因是 capability-install', async () => {
      const w = installWorld();
      const made = make(w, { catalog: installCatalog(), registry: { '@scope/new': '0.1.0' } });
      const r = await made.packages.act(installBody(w, 'npm:@scope/new'));
      return (r.ok === true && made.pi.log.length === 1 && same(made.pi.log[0].args, ['install', 'npm:@scope/new', '--no-approve']) === true
        && same(made.state.paused, ['capability-install']) === true && made.state.resumed === 1 && made.state.invalidated === 1
        && made.pi.log[0].opts.entry === ENTRY) || JSON.stringify({ r, log: made.pi.log, state: made.state });
    });
    await check('F3. 请求体里的 source / name / args / command 对 argv 没有任何影响', async () => {
      const w = installWorld();
      const made = make(w, { catalog: installCatalog(), registry: { 'new-ext': '1.2.0', 'evil-package': '6.6.6' } });
      const r = await made.packages.act(installBody(w, 'npm:new-ext', {
        source: 'npm:evil-package', name: 'evil-package', packageName: 'evil-package', args: ['--all'], command: 'rm',
        registry: 'https://evil.example', scope: 'project', local: true, version: '6.6.6',
      }));
      return (r.ok === true && r.name === 'new-ext' && same(made.pi.log[0].args, ['install', 'npm:new-ext', '--no-approve']) === true
        && !fs.existsSync(w.pkgDir('evil-package'))) || JSON.stringify({ r, args: made.pi.log[0] && made.pi.log[0].args });
    });
    await check('F4. 装完后清单与安装摘要里都有它，别的配置原样', async () => {
      const w = installWorld();
      const made = make(w, { catalog: installCatalog(), registry: { 'new-ext': '1.2.0' } });
      await made.packages.act(installBody(w));
      const record = find(made.packages.readInventory(), 'new-ext');
      const settings = w.readSettings();
      return (record && record.installed === true && record.version === '1.2.0' && record.actions.remove.allowed === true
        && made.packages.installedIndex().get('new-ext').packageId === record.id
        && settings.theme === 'dark' && settings.defaultModel === 'x' && settings.packages.includes('npm:keep-me'))
        || JSON.stringify({ record, settings });
    });
    await check('F5. 重复安装 → already-installed，命令不再跑第二次', async () => {
      const w = installWorld();
      const made = make(w, { catalog: installCatalog(), registry: { 'new-ext': '1.2.0' } });
      const first = await made.packages.act(installBody(w));
      const second = await made.packages.act(installBody(w));
      return (first.ok === true && second.ok === false && second.code === 'already-installed' && made.pi.log.length === 1
        && made.state.paused.length === 1) || JSON.stringify({ first, second, runs: made.pi.log.length });
    });
    await check('F6. 命令退出码 0 但盘上什么都没变 → unverified / verified=false（不宣布成功）', async () => {
      const w = installWorld();
      const made = make(w, { catalog: installCatalog(), script: () => ({ ok: true, exitCode: 0, stdout: 'Installed npm:new-ext\n', stderr: '' }) });
      const r = await made.packages.act(installBody(w));
      return (r.ok === false && r.code === 'unverified' && r.verified === false && r.commandCompleted === true && r.loaded === null
        && same(r.after, { configured: false, files: false, version: null }) === true && r.manual === 'pi install npm:new-ext'
        && typeof r.error === 'string' && r.error.length > 0) || JSON.stringify(r);
    });
    await check('F7. 只登记了没有文件 / 只有文件没登记 → 都不算装上', async () => {
      const only = async (script) => {
        const w = installWorld();
        const made = make(w, { catalog: installCatalog(), script });
        return made.packages.act(installBody(w));
      };
      const configuredOnly = await only((args, tools) => {
        const data = tools.load();
        data.packages.push('npm:new-ext');
        tools.save(data);
        return { ok: true, exitCode: 0, stdout: '', stderr: '' };
      });
      const filesOnly = await only((args, tools) => {
        tools.w.pkg('new-ext', { version: '1.2.0' });
        return { ok: true, exitCode: 0, stdout: '', stderr: '' };
      });
      return (configuredOnly.code === 'unverified' && configuredOnly.verified === false && configuredOnly.after.configured === true
        && configuredOnly.after.files === false && filesOnly.code === 'unverified' && filesOnly.verified === false
        && filesOnly.after.configured === false && filesOnly.after.files === true) || JSON.stringify({ configuredOnly, filesOnly });
    });
    await check('F8. 命令之后 settings.json 读不出来 → verified=null（未知，不是 false）', async () => {
      const w = installWorld();
      const made = make(w, {
        catalog: installCatalog(),
        script: (args, tools) => {
          tools.w.pkg('new-ext', { version: '1.2.0' });
          tools.w.write(tools.w.settingsFile, '{half written');
          return { ok: true, exitCode: 0, stdout: '', stderr: '' };
        },
      });
      const r = await made.packages.act(installBody(w));
      return (r.ok === false && r.code === 'unverified' && r.verified === null && r.after.configured === null && r.after.files === true)
        || JSON.stringify(r);
    });
    await check('F9. 装到托管目录里的东西名字对不上 → 不算装上', async () => {
      const w = installWorld();
      const made = make(w, {
        catalog: installCatalog(),
        script: (args, tools) => {
          tools.w.write(path.join(tools.w.pkgDir('new-ext'), 'package.json'), { name: 'something-else', version: '1.2.0' });
          const data = tools.load();
          data.packages.push('npm:new-ext');
          tools.save(data);
          return { ok: true, exitCode: 0, stdout: '', stderr: '' };
        },
      });
      const r = await made.packages.act(installBody(w));
      return (r.code === 'unverified' && r.after.files === false && r.after.version === null) || JSON.stringify(r);
    });
    await check('F10. 失败（网络）：install-failed + cause=network + 下一步提示 + 手动命令；Pi 已恢复', async () => {
      const w = installWorld();
      const made = make(w, {
        catalog: installCatalog(),
        script: () => ({ ok: false, exitCode: 1, stdout: 'RAW-STDOUT-LINE', stderr: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/new-ext failed' }),
      });
      const r = await made.packages.act(installBody(w));
      return (r.ok === false && r.code === 'install-failed' && r.cause === 'network' && r.verified === null && r.commandStarted === true
        && r.hint.includes('网络') && r.manual === 'pi install npm:new-ext' && r.id === 'npm:new-ext' && r.name === 'new-ext'
        && same(r.after, { configured: false, files: false, version: null }) === true && made.state.resumed === 1
        && !JSON.stringify(r).includes('RAW-STDOUT-LINE') && !('stdout' in r) && !('stderr' in r)) || JSON.stringify(r);
    });
    await check('F11. 失败的各种原因各有提示：找不到包 / 权限 / 磁盘满 / 校验失败 / 没有 npm', async () => {
      const cases = [
        ['npm error code E404\nnpm error 404 Not Found', 'package-not-found', '没有找到这个包'],
        ['npm error code EPERM\nnpm error syscall rename', 'permission', '权限'],
        ['npm error code ENOSPC', 'disk-full', '磁盘空间不足'],
        ['npm error code EINTEGRITY', 'integrity', '完整性校验'],
        ['Error: spawn npm ENOENT', 'package-manager-missing', '没有找到 npm'],
      ];
      for (const [stderr, cause, text] of cases) {
        const w = installWorld();
        const made = make(w, { catalog: installCatalog(), script: () => ({ ok: false, exitCode: 1, stdout: '', stderr }) });
        const r = await made.packages.act(installBody(w));
        if (!(r.code === 'install-failed' && r.cause === cause && typeof r.hint === 'string' && r.hint.includes(text))) {
          return `${cause} → ${JSON.stringify(r)}`;
        }
      }
      return true;
    });
    await check('F12. 认不出原因的失败：cause=null、hint=null（不编一个解释）', async () => {
      const w = installWorld();
      const made = make(w, { catalog: installCatalog(), script: () => ({ ok: false, exitCode: 3, stdout: '', stderr: 'something nobody has seen' }) });
      const r = await made.packages.act(installBody(w));
      return (r.code === 'install-failed' && r.cause === null && r.hint === null && r.verified === null) || JSON.stringify(r);
    });
    await check('F13. 超时：install-timeout，提示包目录可能停在一半；仍然读盘并如实给出', async () => {
      const w = installWorld();
      const made = make(w, {
        catalog: installCatalog(),
        script: (args, tools) => {
          tools.w.pkg('new-ext', { version: '1.2.0' });
          return { ok: false, timedOut: true, error: '超时（600s）' };
        },
      });
      const r = await made.packages.act(installBody(w));
      return (r.code === 'install-timeout' && r.commandStarted === true && r.hint.includes('超时') && r.verified === null
        && same(r.after, { configured: false, files: true, version: '1.2.0' }) === true && made.state.invalidated === 1) || JSON.stringify(r);
    });
    await check('F14. 进程没起来：install-spawn-failed，commandStarted=false（一定没动磁盘）', async () => {
      const w = installWorld();
      const made = make(w, { catalog: installCatalog(), script: () => ({ ok: false, spawnFailed: true, error: '无法启动' }) });
      const r = await made.packages.act(installBody(w));
      return (r.code === 'install-spawn-failed' && r.commandStarted === false && r.hint === null && made.state.invalidated === 0
        && made.state.resumed === 1 && same(r.before, r.after) === true) || JSON.stringify(r);
    });
    await check('F15. 暂停 Pi 失败：不执行命令，但结果里仍有读盘事实与手动命令', async () => {
      const w = installWorld();
      const made = make(w, { catalog: installCatalog(), registry: { 'new-ext': '1.2.0' }, pause: { ok: false, code: 'pause-timeout' } });
      const r = await made.packages.act(installBody(w));
      return (r.ok === false && r.code === 'pause-timeout' && r.commandStarted === false && made.pi.log.length === 0
        && made.state.resumed === 0 && r.manual === 'pi install npm:new-ext' && r.verified === null
        && same(r.after, { configured: false, files: false, version: null }) === true) || JSON.stringify(r);
    });
    await check('F16. 并发：第二个操作被拒（operation-running），命令只跑一次；不同包也一样', async () => {
      const w = installWorld();
      let release;
      const hold = new Promise((resolve) => { release = resolve; });
      const made = make(w, {
        catalog: installCatalog(),
        registry: { 'new-ext': '1.2.0', 'other-ext': '2.0.0' },
        script: async () => {
          await hold;
          return null;
        },
      });
      const first = made.packages.act(installBody(w, 'npm:new-ext'));
      const same1 = made.packages.act(installBody(w, 'npm:new-ext'));
      const other = made.packages.act(installBody(w, 'npm:other-ext'));
      const [r2, r3] = await Promise.all([same1, other]);
      release();
      const r1 = await first;
      return (r1.ok === true && r2.code === 'operation-running' && r3.code === 'operation-running' && r3.name === 'other-ext'
        && r2.commandStarted === false && made.pi.log.length === 1 && !fs.existsSync(w.pkgDir('other-ext')))
        || JSON.stringify({ r1, r2, r3, runs: made.pi.log.length });
    });
    await check('F17. 操作在跑的时候清单如实标 running；跑完恢复', async () => {
      const w = installWorld();
      let release;
      const hold = new Promise((resolve) => { release = resolve; });
      const made = make(w, {
        catalog: installCatalog(),
        registry: { 'new-ext': '1.2.0' },
        script: async () => {
          await hold;
          return null;
        },
      });
      const pending = made.packages.act(installBody(w));
      while (made.pi.log.length === 0) await new Promise((resolve) => setImmediate(resolve));
      const during = made.packages.readInventory().operations.running;
      release();
      await pending;
      return (during === true && made.packages.readInventory().operations.running === false) || JSON.stringify({ during });
    });

    /* ================= G. 卸载 ================= */
    section('G. 卸载');

    const removeWorld = () => {
      const w = world();
      w.pkg('victim', { version: '1.0.0' });
      w.pkg('keep-me', { version: '1.0.0' });
      w.settings({ theme: 'dark', packages: ['npm:victim', 'npm:keep-me'], extensions: ['./x.ts'] });
      return w;
    };

    await check('G1. 卸掉了：code=removed / verified=true；argv 是 remove + source + --no-approve', async () => {
      const w = removeWorld();
      const made = make(w);
      const id = idOf(made.packages, 'victim');
      const r = await made.packages.act({ action: 'remove', id, confirm: true, __expectedCwd: w.project });
      const verdict = same(r, {
        ok: true, code: 'removed', action: 'remove', source: 'npm:victim', commandCompleted: true, commandStarted: true,
        exitCode: 0, restarted: true, outcome: null, loaded: null,
        id, name: 'victim',
        before: { configured: true, files: true, version: '1.0.0' },
        after: { configured: false, files: false, version: null },
        manual: 'pi remove npm:victim', verified: true, filesRemain: false,
      });
      if (verdict !== true) return verdict;
      return (same(made.pi.log[0].args, ['remove', 'npm:victim', '--no-approve']) === true
        && same(made.state.paused, ['extension-remove']) === true && made.state.resumed === 1) || JSON.stringify(made.pi.log);
    });
    await check('G2. 卸载不碰别的包与别的配置', async () => {
      const w = removeWorld();
      const made = make(w);
      await made.packages.act({ action: 'remove', id: idOf(made.packages, 'victim'), confirm: true, __expectedCwd: w.project });
      const settings = w.readSettings();
      const names = made.packages.readInventory().packages.map((pkg) => pkg.name);
      return (same(names, ['keep-me']) === true && settings.theme === 'dark' && same(settings.extensions, ['./x.ts']) === true
        && fs.existsSync(path.join(w.pkgDir('keep-me'), 'package.json'))) || JSON.stringify({ names, settings });
    });
    await check('G3. 登记摘掉了但文件还在 → 仍算卸掉（Pi 不再加载它），并如实标 filesRemain', async () => {
      const w = removeWorld();
      const made = make(w, {
        script: (args, tools) => {
          const data = tools.load();
          data.packages = data.packages.filter((entry) => tools.nameOf(entry) !== 'victim');
          tools.save(data);
          return { ok: true, exitCode: 0, stdout: 'Removed npm:victim\n', stderr: '' };
        },
      });
      const r = await made.packages.act({ action: 'remove', id: idOf(made.packages, 'victim'), confirm: true, __expectedCwd: w.project });
      return (r.ok === true && r.code === 'removed' && r.verified === true && r.filesRemain === true && r.after.files === true) || JSON.stringify(r);
    });
    await check('G4. 命令退出码 0 但配置里还登记着 → unverified / verified=false', async () => {
      const w = removeWorld();
      const made = make(w, { script: () => ({ ok: true, exitCode: 0, stdout: 'Removed npm:victim\n', stderr: '' }) });
      const r = await made.packages.act({ action: 'remove', id: idOf(made.packages, 'victim'), confirm: true, __expectedCwd: w.project });
      return (r.ok === false && r.code === 'unverified' && r.verified === false && r.after.configured === true
        && r.manual === 'pi remove npm:victim') || JSON.stringify(r);
    });
    await check('G5. Pi 说配置里没有这个包 → remove-failed + cause=not-configured + 提示刷新', async () => {
      const w = removeWorld();
      const made = make(w, { script: () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'No matching package found for npm:victim' }) });
      const r = await made.packages.act({ action: 'remove', id: idOf(made.packages, 'victim'), confirm: true, __expectedCwd: w.project });
      return (r.code === 'remove-failed' && r.cause === 'not-configured' && r.hint.includes('刷新') && r.verified === null) || JSON.stringify(r);
    });
    await check('G6. 卸掉之后旧 id 失效：再卸一次 → unknown-package，命令不再跑', async () => {
      const w = removeWorld();
      const made = make(w);
      const id = idOf(made.packages, 'victim');
      await made.packages.act({ action: 'remove', id, confirm: true, __expectedCwd: w.project });
      const again = await made.packages.act({ action: 'remove', id, confirm: true, __expectedCwd: w.project });
      return (again.code === 'unknown-package' && made.pi.log.length === 1) || JSON.stringify(again);
    });
    await check('G7. 卸载托管目录里没有文件的包（只是登记着）也能成', async () => {
      const w = world();
      w.settings({ packages: ['npm:ghost'] });
      const made = make(w);
      const r = await made.packages.act({ action: 'remove', id: idOf(made.packages, 'ghost'), confirm: true, __expectedCwd: w.project });
      return (r.ok === true && r.code === 'removed' && same(r.before, { configured: true, files: false, version: null }) === true)
        || JSON.stringify(r);
    });
    await check('G8. 对象形式登记的包同样按包身份卸载', async () => {
      const w = world();
      w.pkg('objform', { version: '1.0.0' });
      w.settings({ packages: [{ source: 'npm:objform@^1.0.0', extensions: ['a.ts'] }] });
      const made = make(w);
      const r = await made.packages.act({ action: 'remove', id: idOf(made.packages, 'objform'), confirm: true, __expectedCwd: w.project });
      return (r.ok === true && r.code === 'removed' && same(made.pi.log[0].args, ['remove', 'npm:objform', '--no-approve']) === true) || JSON.stringify(r);
    });

    /* ================= H. 更新 ================= */
    section('H. 更新');

    const updateWorld = (source = 'npm:upd', version = '1.0.0') => {
      const w = world();
      if (version) w.pkg('upd', { version });
      w.settings({ packages: [source, 'npm:keep-me'] });
      w.pkg('keep-me', { version: '1.0.0' });
      return w;
    };
    const updateOf = async (made, w) => made.packages.act({ action: 'update', id: idOf(made.packages, 'upd'), confirm: true, __expectedCwd: w.project });

    await check('H1. 版本变了：code=updated；argv 是 update --extension <source> --no-approve', async () => {
      const w = updateWorld();
      const made = make(w, { registry: { upd: '1.1.0' } });
      const id = idOf(made.packages, 'upd');
      const r = await updateOf(made, w);
      const verdict = same(r, {
        ok: true, code: 'updated', action: 'update', source: 'npm:upd', commandCompleted: true, commandStarted: true,
        exitCode: 0, restarted: true, outcome: 'updated', loaded: null,
        id, name: 'upd',
        before: { configured: true, files: true, version: '1.0.0' },
        after: { configured: true, files: true, version: '1.1.0' },
        manual: 'pi update --extension npm:upd', verified: true,
      });
      if (verdict !== true) return verdict;
      return (same(made.pi.log[0].args, ['update', '--extension', 'npm:upd', '--no-approve']) === true
        && same(made.state.paused, ['extension-update']) === true) || JSON.stringify(made.pi.log);
    });
    await check('H2. 已经是最新：code=up-to-date，版本没变', async () => {
      const w = updateWorld();
      const made = make(w, { registry: { upd: '1.0.0' } });
      const r = await updateOf(made, w);
      return (r.ok === true && r.code === 'up-to-date' && r.verified === true && r.before.version === '1.0.0' && r.after.version === '1.0.0')
        || JSON.stringify(r);
    });
    await check('H3. Pi 处于离线模式 / 有警告没更新：code 如实是 skipped-offline / not-updated', async () => {
      const run = async (stdout) => {
        const w = updateWorld();
        const made = make(w, { script: () => ({ ok: true, exitCode: 0, stdout, stderr: '' }) });
        return updateOf(made, w);
      };
      const offline = await run('Skipped package updates (offline mode)\n');
      const warned = await run('npm:upd was not updated, see the warnings above\n');
      return (offline.code === 'skipped-offline' && offline.ok === true && warned.code === 'not-updated' && warned.verified === true)
        || JSON.stringify({ offline, warned });
    });
    await check('H4. stdout 认不出、版本也没变 → unchanged（不猜原因）', async () => {
      const w = updateWorld();
      const made = make(w, { script: () => ({ ok: true, exitCode: 0, stdout: 'a sentence a later Pi might print\n', stderr: '' }) });
      const r = await updateOf(made, w);
      return (r.code === 'unchanged' && r.outcome === null && r.verified === true) || JSON.stringify(r);
    });
    await check('H5. stdout 说「更新了」但盘上版本没变 → 以盘为准：unchanged', async () => {
      const w = updateWorld();
      const made = make(w, { script: () => ({ ok: true, exitCode: 0, stdout: 'Updated 1 package:\n  npm:upd\n', stderr: '' }) });
      const r = await updateOf(made, w);
      return (r.code === 'unchanged' && r.outcome === 'updated' && r.before.version === r.after.version) || JSON.stringify(r);
    });
    await check('H6. stdout 说「已是最新」但盘上版本变了 → 以盘为准：updated', async () => {
      const w = updateWorld();
      const made = make(w, {
        script: (args, tools) => {
          tools.w.pkg('upd', { version: '1.5.0' });
          return { ok: true, exitCode: 0, stdout: 'npm:upd is already up to date\n', stderr: '' };
        },
      });
      const r = await updateOf(made, w);
      return (r.code === 'updated' && r.after.version === '1.5.0') || JSON.stringify(r);
    });
    await check('H7. 托管目录里本来没有文件，更新把它装上了 → reinstalled', async () => {
      const w = updateWorld('npm:upd', null);
      const made = make(w, { registry: { upd: '1.1.0' } });
      const before = find(made.packages.readInventory(), 'upd');
      const r = await updateOf(made, w);
      return (before.installed === null && before.actions.update.repair === true && r.ok === true && r.code === 'reinstalled'
        && r.before.files === false && r.after.files === true && r.after.version === '1.1.0') || JSON.stringify({ before, r });
    });
    await check('H8. 更新之后托管目录里读不到它 → unverified（不说「更新成功」）', async () => {
      const w = updateWorld();
      const made = make(w, {
        script: (args, tools) => {
          fs.rmSync(tools.w.pkgDir('upd'), { recursive: true, force: true });
          return { ok: true, exitCode: 0, stdout: 'Updated 1 package:\n  npm:upd\n', stderr: '' };
        },
      });
      const r = await updateOf(made, w);
      return (r.ok === false && r.code === 'unverified' && r.verified === false && r.after.files === false) || JSON.stringify(r);
    });
    await check('H9. 登记的是区间 → 可以更新，交给 Pi 的仍是不带版本的包身份', async () => {
      const w = updateWorld('npm:upd@^1.0.0');
      const made = make(w, { registry: { upd: '1.9.0' } });
      const r = await updateOf(made, w);
      return (r.ok === true && r.code === 'updated' && same(made.pi.log[0].args, ['update', '--extension', 'npm:upd', '--no-approve']) === true
        && w.readSettings().packages[0] === 'npm:upd@^1.0.0') || JSON.stringify({ r, args: made.pi.log[0] && made.pi.log[0].args });
    });
    await check('H10. 更新失败（网络）：update-failed + cause + 提示；别的包没被碰', async () => {
      const w = updateWorld();
      const made = make(w, { script: () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' }) });
      const r = await updateOf(made, w);
      return (r.code === 'update-failed' && r.cause === 'network' && r.manual === 'pi update --extension npm:upd'
        && r.after.version === '1.0.0' && find(made.packages.readInventory(), 'keep-me').version === '1.0.0') || JSON.stringify(r);
    });
    await check('H11. 更新超时：update-timeout，带「可能停在一半」的提示', async () => {
      const w = updateWorld();
      const made = make(w, { script: () => ({ ok: false, timedOut: true, error: '超时（600s）' }) });
      const r = await updateOf(made, w);
      return (r.code === 'update-timeout' && r.hint.includes('超时') && r.commandStarted === true) || JSON.stringify(r);
    });
    await check('H12. 更新之后清单里的版本与「有没有更新」跟着变', async () => {
      const w = updateWorld();
      const catalog = stubCatalog({ 'npm:upd': { version: '1.1.0' } });
      const made = make(w, { catalog, registry: { upd: '1.1.0' } });
      const before = find(made.packages.readInventory(), 'upd');
      await updateOf(made, w);
      const after = find(made.packages.readInventory(), 'upd');
      return (before.updateAvailable === true && before.version === '1.0.0' && after.updateAvailable === false && after.version === '1.1.0'
        && before.id === after.id) || JSON.stringify({ before, after });
    });

    /* ================= I. HTTP 层 ================= */
    section('I. HTTP 层');

    const httpWorld = installWorld();
    const httpMade = make(httpWorld, { catalog: installCatalog(), registry: { 'new-ext': '1.2.0' } });
    const handle = httpMade.packages.handle;

    await check('I1. GET → 200 + 清单；先读一次目录的磁盘缓存', async () => {
      const res = await http(handle, 'GET');
      return (res.code === 200 && res.payload.ok === true && res.payload.packages.length === 1 && httpMade.catalog.calls.warm === 1)
        || JSON.stringify({ code: res.code, body: res.body });
    });
    await check('I2. POST 请求体不是合法 JSON → 400 bad-body', async () => {
      const res = await http(handle, 'POST', '{not json');
      return (res.code === 400 && res.payload.code === 'bad-body') || res.body;
    });
    await check('I3. POST 请求体不是对象（数组 / 字符串 / null / 数字）→ 400', async () => {
      for (const text of ['[]', '"install"', 'null', '42', 'true']) {
        const res = await http(handle, 'POST', text);
        if (!(res.code === 400 && res.payload.code === 'bad-body')) return `${text} → ${res.code} ${res.body}`;
      }
      return true;
    });
    await check('I4. POST 请求体超过 4 KiB → 400（不进入任何动作）', async () => {
      const big = JSON.stringify({ action: 'install', id: 'npm:new-ext', confirm: true, pad: 'x'.repeat(5000) });
      const res = await http(handle, 'POST', big);
      return (res.code === 400 && res.payload.code === 'bad-body' && httpMade.pi.log.length === 0) || res.body;
    });
    await check('I5. 空请求体 → 200 + unknown-action（业务拒绝，不是协议错误）', async () => {
      const res = await http(handle, 'POST');
      return (res.code === 200 && res.payload.ok === false && res.payload.code === 'unknown-action') || res.body;
    });
    await check('I6. PUT / DELETE / PATCH → 405', async () => {
      for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) {
        const res = await http(handle, method);
        if (!(res.code === 405 && res.payload.code === 'method-not-allowed')) return `${method} → ${res.code}`;
      }
      return httpMade.pi.log.length === 0 || '405 之后竟然执行了命令';
    });
    await check('I7. 业务拒绝一律 200 + ok:false', async () => {
      const res = await http(handle, 'POST', JSON.stringify({ action: 'install', id: 'npm:left-pad', confirm: true }));
      return (res.code === 200 && res.payload.ok === false && res.payload.code === 'unknown-item') || res.body;
    });
    await check('I8. 合法安装请求 → 200 + installed，argv 是固定的那三格', async () => {
      const res = await http(handle, 'POST', JSON.stringify({ action: 'install', id: 'npm:new-ext', confirm: true, __expectedCwd: httpWorld.project }));
      return (res.code === 200 && res.payload.ok === true && res.payload.code === 'installed' && res.payload.verified === true
        && same(httpMade.pi.log[0].args, ['install', 'npm:new-ext', '--no-approve']) === true) || res.body;
    });
    await check('I9. 读清单时内部抛错 → 200 + packages-failed + 空清单（界面不白屏）', async () => {
      const broken = createExtensionPackages({ runtime: { getCurrentCwd: () => { throw new Error('boom'); } }, env: httpWorld.env });
      const res = await http(broken.handle, 'GET');
      return (res.code === 200 && res.payload.ok === false && res.payload.code === 'packages-failed'
        && same(res.payload.packages, []) === true && !res.body.includes('boom')) || res.body;
    });

    /* ================= J. 与真实的市场模块接在一起 ================= */
    section('J. 与真实的市场模块接在一起');

    const row = (name, extra = {}) => ({
      downloads: { monthly: 1000, weekly: 250 },
      flags: { insecure: extra.insecure ? 1 : 0 },
      package: {
        name, version: extra.version || '1.0.0', description: `${name} description`, keywords: ['pi-package'],
        date: '2026-10-01T00:00:00.000Z', license: 'MIT',
        links: { npm: `https://www.npmjs.com/package/${name}` },
        maintainers: [{ username: 'alice', email: 'alice@example.test' }],
        publisher: { username: 'alice', email: 'alice@example.test' },
      },
    });
    function integration() {
      const w = world();
      w.pkg('older', { version: '1.0.0' });
      w.settings({ packages: ['npm:older'] });
      const fetched = [];
      let packagesRef = null;
      const made = { w, fetched };
      const pi = fakePi(w, { registry: { 'pi-web-access': '0.48.0', 'snapshot-ext': '3.1.0', older: '1.4.0' } });
      const operations = createCapabilityInstall({
        currentCwd: () => w.project,
        busyReason: () => null,
        resolveInstallTarget: () => ({ ok: true, entry: ENTRY }),
        runInstall: pi.run,
        pauseBridge: async () => ({ ok: true }),
        resumeBridge: () => {},
        invalidateCaches: () => {},
      });
      const market = createExtensionMarket({
        dataDir: path.join(w.base, 'gui-data'),
        fetchJson: async (url) => {
          fetched.push(url);
          const from = Number(new URL(url).searchParams.get('from') || 0);
          const rows = from === 0 ? [row('snapshot-ext', { version: '3.1.0' }), row('flagged-ext', { insecure: true }), row('older', { version: '1.4.0' })] : [];
          return { ok: true, data: { objects: rows, total: 3, time: 'x' } };
        },
        readInstalled: () => (packagesRef ? packagesRef.installedIndex() : null),
        operations,
      });
      const packages = packagesRef = createExtensionPackages({ runtime: { getCurrentCwd: () => w.project }, env: w.env, operations, catalog: market });
      return Object.assign(made, { market, packages, pi });
    }

    await check('J1. 没同意联网：内置的四个已知能力照样能装；不发任何请求', async () => {
      const it = integration();
      const r = await it.packages.act({ action: 'install', id: 'npm:pi-web-access', confirm: true, __expectedCwd: it.w.project });
      return (r.ok === true && r.code === 'installed' && r.after.version === '0.48.0' && it.fetched.length === 0) || JSON.stringify({ r, fetched: it.fetched });
    });
    await check('J2. 没同意联网：目录里只有内置条目，别的包一律 unknown-item', async () => {
      const it = integration();
      const r = await it.packages.act({ action: 'install', id: 'npm:snapshot-ext', confirm: true, __expectedCwd: it.w.project });
      return (r.code === 'unknown-item' && it.pi.log.length === 0 && it.fetched.length === 0) || JSON.stringify(r);
    });
    await check('J3. 同意并读到目录后：快照里的包能装，npm 标记不安全的不能装', async () => {
      const it = integration();
      await it.market.act({ action: 'consent' });
      const good = await it.packages.act({ action: 'install', id: 'npm:snapshot-ext', confirm: true, __expectedCwd: it.w.project });
      const bad = await it.packages.act({ action: 'install', id: 'npm:flagged-ext', confirm: true, __expectedCwd: it.w.project });
      return (good.ok === true && good.code === 'installed' && bad.code === 'not-allowed' && it.pi.log.length === 1) || JSON.stringify({ good, bad });
    });
    await check('J4. 清单用目录里的版本判断有没有更新；市场用清单标已安装（同一个 packageId）', async () => {
      const it = integration();
      await it.market.act({ action: 'consent' });
      const record = find(it.packages.readInventory(), 'older');
      const listed = await it.market.list({ q: 'older', category: 'all', sort: 'recommended', offset: 0, limit: 24, deep: false });
      const item = listed.items.find((entry) => entry.name === 'older');
      return (record.latest === '1.4.0' && record.updateAvailable === true && item.installed.state === 'installed'
        && item.installed.packageId === record.id && item.installed.version === '1.0.0' && item.updateAvailable === true
        && item.install.allowed === false && item.installed.canUpdate === true) || JSON.stringify({ record, item });
    });
    await check('J5. 进程重启后（新实例）：安装闸门靠磁盘缓存认得快照里的包，不重新联网', async () => {
      const it = integration();
      await it.market.act({ action: 'consent' });
      const before = it.fetched.length;
      const fetchedAgain = [];
      const market2 = createExtensionMarket({
        dataDir: path.join(it.w.base, 'gui-data'),
        fetchJson: async (url) => {
          fetchedAgain.push(url);
          return { ok: false, code: 'network', error: 'should not be called' };
        },
      });
      const pi2 = fakePi(it.w, { registry: { 'snapshot-ext': '3.1.0' } });
      const operations2 = createCapabilityInstall({
        currentCwd: () => it.w.project, busyReason: () => null, resolveInstallTarget: () => ({ ok: true, entry: ENTRY }),
        runInstall: pi2.run, pauseBridge: async () => ({ ok: true }), resumeBridge: () => {}, invalidateCaches: () => {},
      });
      const packages2 = createExtensionPackages({ runtime: { getCurrentCwd: () => it.w.project }, env: it.w.env, operations: operations2, catalog: market2 });
      const r = await packages2.act({ action: 'install', id: 'npm:snapshot-ext', confirm: true, __expectedCwd: it.w.project });
      return (r.ok === true && r.code === 'installed' && fetchedAgain.length === 0 && it.fetched.length === before) || JSON.stringify({ r, fetchedAgain });
    });

    /* ================= K. 源码级约束 ================= */
    section('K. 源码级约束');

    const source = read('server/extension-packages.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    await check('K1. 模块自己不起进程、不拼命令行（执行只经 capability-install）', () =>
      (!/child_process|spawn\(|execFile|execSync|runCli|runPiCliCommand/.test(source)
        && !/(npm|pnpm|bun|yarn)\s+(install|add|i|uninstall|remove|update)\b/.test(source)) || '出现了进程启动 / 别的包管理路径');
    await check('K2. 模块对磁盘只读：fs 只检查存在性与规范路径（元数据读取走 readExtensionJson）', () => {
      const used = [...new Set([...source.matchAll(/\bfs\.(?:promises\.)?([A-Za-z]+)/g)].map((m) => m[1]))].sort();
      return same(used, ['existsSync', 'realpathSync']);
    });
    await check('K3. 模块不联网', () =>
      !/\bfetch\(|node:https?|node:net|node:dns|node:tls|XMLHttpRequest|WebSocket/.test(source) || '出现了网络调用');
    await check('K4. 手动命令只是文本：三种动作各一种写法，项目级才带 -l', () => {
      const texts = [...source.matchAll(/`pi [^`]+`/g)].map((m) => m[0]);
      return same(texts, ['`pi install npm:${name}${local}`', '`pi remove npm:${name}${local}`', '`pi update --extension npm:${name}`']);
    });
    await check('K5. Registry 这个只读模块没有被改（动作契约原样）', () => {
      const registry = read('server/extension-registry.js');
      return (/actions:\s*\{\s*install:\s*false,\s*toggle:\s*false,\s*remove:\s*false,\s*refresh:\s*true,\s*restart:\s*true\s*\}/.test(registry)
        && !/extension-packages|extension-market|startOperation/.test(registry)) || 'Registry 被改了';
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('失败：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
