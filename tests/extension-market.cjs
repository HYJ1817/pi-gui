/* Extension 插件市场：目录的归一化、读取、缓存与查询（第二阶段 B）的离线回归测试。
 *
 * ---------- 这一套要钉住什么 ----------
 *
 *   1. **没有同意就不联网**：目录里只有四个内置条目，一次请求都不发、一个文件都不写。
 *      同意在每一次远端读取出去之前都再验一遍（等待期间撤回也发不出去）。
 *   2. **目录不是全集，也不装成全集**：收录多少 / npm 上共多少分开给；
 *      下载量 / 更新时间没有数据时这两种排序就是不可用，不拿 0 充数。
 *   3. **远端与缓存都是不可信输入**：包名过严格规则、必须自带 `pi-package`、
 *      文本去控制字符与零宽字符、链接只收 https 且不带凭据、邮箱不读不存；
 *      磁盘缓存读回来按同样的规则重新校验，分类与标签重算。
 *   4. **失败就地降级**：有旧快照继续用旧的并带上错误；`network` 类错误的原文
 *      （可能带地址）不出后端；失败后一段时间内不自动重试，手动刷新不受限。
 *   5. **撤回同意**：快照、缓存文件、搜索池、详情缓存一起清掉；在飞的请求回来后作废。
 *   6. **它不是任意 npm 包的查询代理**：详情只给目录里有的、或本机已经装着的包。
 *
 * ---------- 离线纪律 ----------
 *
 * 网络层是注入的替身（`fetchJson`），**测试绝不真的联网**；替身返回的形状照
 * npm registry 2026-11 的真实响应造（包括我们故意不读的邮箱字段，用来证明它
 * 出不了后端）。所有文件都写在 `os.tmpdir()` 的 fixture 里。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

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
function same(got, want) {
  try {
    assert.deepEqual(got, want);
    return true;
  } catch {
    return `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
  }
}
/** 逐行表：每行 [输入…, 期望]；不等时指出是哪一行。 */
function table(fn, rows) {
  for (const row of rows) {
    const want = row[row.length - 1];
    const got = fn(...row.slice(0, -1));
    const verdict = same(got, want);
    if (verdict !== true) return `${JSON.stringify(row.slice(0, -1))}: ${verdict}`;
  }
  return true;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** 等某个条件成立。等不到就抛错 —— 让这一条红，而不是让整套卡死到 CI 超时。
 *  上限只用来兜「永远等不到」；正常情况下几拍之内就成立，结论不取决于它。 */
async function until(cond, what) {
  const deadline = Date.now() + 20000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等不到：' + what);
    await tick();
  }
}

/* 看不见的字符一律用码点造：源文件里不留任何字面的零宽 / 双向 / 控制字符。 */
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const NEL = String.fromCharCode(0x85);
const ZWSP = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
const WJ = String.fromCharCode(0x2060);
const BOM = String.fromCharCode(0xfeff);

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
async function http(handle, method, target, body) {
  const req = mockReq(method);
  const res = mockRes();
  const url = typeof target === 'string' ? new URL(target, 'http://127.0.0.1') : target;
  const pending = handle(req, res, url);
  await tick();
  if (body !== undefined && body !== null) req.emit('data', Buffer.from(String(body), 'utf8'));
  req.emit('end');
  await pending;
  return res;
}

/* ---------- npm 响应的替身（照真实形状造） ---------- */

/** `/-/v1/search` 的一行。邮箱字段是真实响应里有的 —— 我们不读它。 */
function row(name, extra = {}) {
  const bare = name.replace(/^@[^/]+\//, '');
  return {
    downloads: { monthly: 'monthly' in extra ? extra.monthly : 1200, weekly: 300 },
    dependents: '3',
    updated: '2026-11-20T00:00:00.000Z',
    searchScore: 1717.5,
    score: { final: 1717.5, detail: { popularity: 1, quality: 1, maintenance: 1 } },
    flags: { insecure: extra.insecure ? 1 : 0 },
    package: {
      name,
      version: 'version' in extra ? extra.version : '1.0.0',
      description: 'description' in extra ? extra.description : `${name} for pi`,
      keywords: 'keywords' in extra ? extra.keywords : ['pi-package'],
      date: 'date' in extra ? extra.date : '2026-10-01T08:00:00.000Z',
      license: 'license' in extra ? extra.license : 'MIT',
      links: 'links' in extra ? extra.links : {
        npm: `https://www.npmjs.com/package/${name}`,
        homepage: `https://example.test/${name}#readme`,
        repository: `git+https://github.com/acme/${bare}.git`,
        bugs: `https://github.com/acme/${bare}/issues`,
      },
      publisher: 'publisher' in extra ? extra.publisher : { username: 'publisher-bot', email: 'bot@secret-mail.test' },
      maintainers: 'maintainers' in extra ? extra.maintainers : [{ username: extra.maintainer || 'alice', email: 'alice@secret-mail.test' }],
    },
  };
}

/** `/<name>/latest` 的清单。 */
function manifest(name, extra = {}) {
  const bare = name.replace(/^@[^/]+\//, '');
  return {
    name,
    version: '1.0.0',
    description: `${name} manifest description`,
    license: 'MIT',
    author: 'Alice Example <alice@secret-mail.test> (https://alice.example)',
    _npmUser: { name: 'alice', email: 'alice@secret-mail.test' },
    maintainers: [{ name: 'alice', email: 'alice@secret-mail.test' }],
    repository: { type: 'git', url: `git+https://github.com/acme/${bare}.git` },
    homepage: `https://example.test/${bare}`,
    keywords: ['pi-package'],
    pi: { extensions: ['./extensions/index.ts'], skills: ['./skills/a', './skills/b'] },
    scripts: { postinstall: 'node scripts/setup.js --token=SECRET-SCRIPT', test: 'vitest', preinstall: '   ' },
    dependencies: { a: '^1.0.0', b: '^2.0.0', c: '^3.0.0' },
    peerDependencies: { '@earendil-works/pi-coding-agent': '>=1.5.0' },
    engines: { node: '>=22' },
    dist: {
      tarball: `https://registry.npmjs.org/${name}/-/${bare}-1.0.0.tgz`,
      shasum: '0123456789abcdef',
      integrity: 'sha512-AAAA',
      unpackedSize: 123456,
      fileCount: 42,
      signatures: [{ keyid: 'SHA256:x', sig: 'MEUC' }],
      attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/x', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
    },
    ...extra,
  };
}
function detailOf(name, fields = {}) {
  const bare = name.replace(/^@[^/]+\//, '');
  return {
    name,
    version: '1.0.0',
    description: `${name} manifest description`,
    license: 'MIT',
    author: 'Alice Example',
    publishedBy: 'alice',
    links: { npm: `https://www.npmjs.com/package/${name}`, repository: `https://github.com/acme/${bare}`, homepage: `https://example.test/${bare}` },
    declaresResources: true,
    resources: { extensions: 1, skills: 2, prompts: null, themes: null },
    installScripts: ['postinstall'],
    dependencyCount: 3,
    unpackedSize: 123456,
    fileCount: 42,
    integrity: true,
    signatures: true,
    provenance: true,
    nodeRange: '>=22',
    peer: { name: '@earendil-works/pi-coding-agent', range: '>=1.5.0' },
    deprecated: null,
    ...fields,
  };
}

const ALL_URLS = [];

/** 可编程的受控网络层替身：记下每一次调用；可以卡住、可以按规则失败。 */
function net(options = {}) {
  const calls = [];
  const state = {
    pages: options.pages || [],
    total: options.total === undefined ? null : options.total,
    manifests: options.manifests || {},
    deep: options.deep || null,
    fail: options.fail || null,
    gate: null,
  };
  async function fetchJson(url, opts) {
    const u = new URL(url);
    calls.push({ url, opts });
    ALL_URLS.push(url);
    const index = calls.length;
    if (state.gate) await state.gate;
    if (state.fail) {
      const failure = state.fail(u, index);
      if (failure) return failure;
    }
    if (u.pathname === '/-/v1/search') {
      const text = u.searchParams.get('text');
      const size = Number(u.searchParams.get('size'));
      const from = Number(u.searchParams.get('from') || 0);
      if (text !== 'keywords:pi-package') {
        const rows = typeof state.deep === 'function' ? state.deep(text) : state.deep || [];
        return { ok: true, data: { objects: rows, total: rows.length, time: 'Sun Nov 22 2026' } };
      }
      const rows = state.pages[from / size] || [];
      const total = state.total === null ? state.pages.flat().length : state.total;
      return { ok: true, data: { objects: rows, total, time: 'Sun Nov 22 2026' } };
    }
    const m = /^\/(.+)\/latest$/.exec(u.pathname);
    if (m) {
      const data = state.manifests[decodeURIComponent(m[1])];
      return data ? { ok: true, data } : { ok: false, code: 'http-404', error: '目录里没有这个包' };
    }
    return { ok: false, code: 'blocked-url', error: '意料之外的地址' };
  }
  return {
    fetchJson,
    calls,
    state,
    /** 卡住之后的所有请求，直到调用返回的函数。 */
    hold() {
      let release;
      state.gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        state.gate = null;
        release();
      };
    },
  };
}

const SOURCE = { id: 'npm-pi-package', label: 'npm 上带 pi-package 关键词的包', host: 'registry.npmjs.org', gallery: 'https://pi.dev/packages' };
const NONE = { state: 'none', version: null, scope: null, packageId: null, pinned: null, canUpdate: false, canRemove: false };
const EMPTY_SNAPSHOT = { state: 'none', at: null, covered: 0, npmTotal: null, pages: 0, partial: false, refreshing: false, error: null };
const Q = (extra = {}) => ({ q: '', category: 'all', sort: 'recommended', offset: 0, limit: 24, deep: false, ...extra });
const HOUR = 60 * 60 * 1000;

/** 目录条目在响应里的样子（没装、可装）。 */
function wireOf(name, fields = {}) {
  const bare = name.replace(/^@[^/]+\//, '');
  return {
    id: `npm:${name}`,
    name,
    description: `${name} for pi`,
    version: '1.0.0',
    maintainer: 'alice',
    updatedAt: '2026-10-01T08:00:00.000Z',
    keywords: ['pi-package'],
    tags: [],
    category: 'other',
    downloadsMonthly: 1200,
    license: 'MIT',
    links: { npm: `https://www.npmjs.com/package/${name}`, repository: `https://github.com/acme/${bare}`, homepage: `https://example.test/${name}#readme` },
    known: null,
    flagged: false,
    rank: null,
    installed: NONE,
    updateAvailable: false,
    install: { allowed: true, reason: '' },
    ...fields,
  };
}

/** 两页、每页五行：有重复、有不合格、有缺字段 —— 真实目录里都见过。 */
const PAGES = () => [
  [
    row('alpha-tools', { keywords: ['pi-package', 'git', 'lint'], monthly: 500, date: '2026-09-01T08:00:00.000Z' }),
    row('pi-memory', { keywords: ['pi-package', 'memory'], version: '0.4.2', monthly: 9000, date: '2026-11-01T08:00:00.000Z' }),
    row('beta-agents', { keywords: ['pi-package', 'subagents', 'workflow'], monthly: null, date: '2026-11-10T08:00:00.000Z', maintainer: 'bob' }),
    row('@scope/gamma-web', { keywords: ['pi-package', 'web-search'], monthly: 500, date: 'not a date' }),
    row('flagged-thing', { insecure: true, monthly: 10, date: '2026-01-01T08:00:00.000Z' }),
  ],
  [
    row('alpha-tools', { version: '9.9.9' }),
    row('Bad_Name'),
    row('no-keyword', { keywords: ['pi'] }),
    row('delta-notes', { keywords: ['PI-PACKAGE', 'Todo', 'todo'], monthly: 42, date: '2026-10-15T08:00:00.000Z', maintainers: [] }),
    row('epsilon-models', { keywords: ['pi-package', 'ollama', 'openai'], monthly: 7000, date: '2026-11-15T08:00:00.000Z', version: 'not-semver' }),
  ],
];
const RECOMMENDED = ['pi-web-access', 'pi-subagents', 'pi-memory', 'pi-browser-harness',
  'alpha-tools', 'beta-agents', '@scope/gamma-web', 'flagged-thing', 'delta-notes', 'epsilon-models'];
const ALPHA = () => wireOf('alpha-tools', {
  updatedAt: '2026-09-01T08:00:00.000Z', keywords: ['pi-package', 'git', 'lint'], tags: ['git', 'lint'],
  category: 'devtools', downloadsMonthly: 500, rank: 0,
});

(async () => {
  const catalog = await import('../server/extension-market-catalog.js');
  const { createExtensionMarket } = await import('../server/extension-market.js');
  const { CAPABILITY_SOURCES } = await import('../server/capability-install.js');

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-2b-market-')));
  const consentFileOf = (dir) => path.join(dir, 'extension-market.json');
  const cacheFileOf = (dir) => path.join(dir, 'extension-market-catalog.json.gz');
  const T0 = 1800000000000;

  let dirs = 0;
  const newDir = () => path.join(root, `d${++dirs}`);
  /** 直接在盘上放一份「已同意」（等同于上一次运行时用户点过同意）。 */
  function grant(dir, at = 1) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(consentFileOf(dir), JSON.stringify({ version: 1, remote: true, at }));
    return dir;
  }
  function writeCache(dir, data) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFileOf(dir), Buffer.isBuffer(data) ? data : zlib.gzipSync(Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))));
  }
  const readCache = (dir) => JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFileOf(dir))).toString('utf8'));

  function make(options = {}) {
    const dir = options.dir || newDir();
    const clock = options.clock || { t: T0 };
    const wire = options.net || net(options);
    const market = createExtensionMarket({
      dataDir: dir,
      fetchJson: 'fetchJson' in options ? options.fetchJson : wire.fetchJson,
      now: () => clock.t,
      readPiVersion: 'readPiVersion' in options ? options.readPiVersion : () => '1.6.0',
      readInstalled: options.readInstalled || (() => new Map()),
      operations: 'operations' in options ? options.operations : { available: () => true, isRunning: () => false },
      pages: options.pageCount === undefined ? 2 : options.pageCount,
      pageSize: options.pageSize === undefined ? 5 : options.pageSize,
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
      ...(options.detailTtlMs === undefined ? {} : { detailTtlMs: options.detailTtlMs }),
    });
    return { market, dir, clock, net: wire, calls: wire.calls };
  }
  /** 已同意、并且读到了那份两页的目录。 */
  async function loaded(options = {}) {
    const made = make({ pages: PAGES(), total: 14112, ...options });
    const result = await made.market.act({ action: 'consent' });
    assert.equal(result.loaded, true, '夹具：目录没读到');
    return made;
  }
  /** 盘上已有同意、但还没有快照。 */
  const granted = (options = {}) => make({ dir: grant(newDir()), ...options });
  const settle = async (made) => {
    await until(() => !made.market._internals.snapshotMeta().refreshing, '读取结束');
  };
  const names = (listed) => listed.items.map((item) => item.name);

  try {
    /* ================= A. 纯函数：归一化 ================= */
    section('A. 归一化（纯函数）');

    await check('A1. cleanText：控制字符 / 零宽 / 双向控制符 / BOM 都变成空格，再压空白、截断', () => table(catalog.cleanText, [
      ['plain text', 'plain text'],
      ['a' + NUL + 'b', 'a b'],
      ['a' + ESC + '[31mb', 'a [31mb'],
      ['x' + DEL + 'y' + NEL + 'z', 'x y z'],
      ['  many   spaces\n\tand\r\nlines  ', 'many spaces and lines'],
      ['x' + ZWSP + 'y' + RLO + 'z' + WJ + BOM, 'x y z'],
      ['evil' + RLO + 'txt.exe', 'evil txt.exe'],
      [ZWSP + ZWSP + NUL, ''],
      ['abcdef', 3, 'abc'],
      [42, ''],
      [null, ''],
      [undefined, ''],
      [{ toString: () => 'x' }, ''],
      [['a'], ''],
    ]));
    await check('A2. cleanText：截断不会留下半个代理对', () => {
      const face = String.fromCodePoint(0x1f600);
      const cut = catalog.cleanText('ab' + face, 3);
      return (cut === 'ab' && catalog.cleanText('ab' + face, 4) === 'ab' + face && catalog.cleanText('x'.repeat(400)).length === 300) || JSON.stringify(cut);
    });
    await check('A3. cleanVersion：只认严格 semver（不带 v、不带空白），别的都是 null', () => table(catalog.cleanVersion, [
      ['1.2.3', '1.2.3'],
      ['0.0.0', '0.0.0'],
      ['1.2.3-beta.1', '1.2.3-beta.1'],
      ['1.2.3+build.5', '1.2.3+build.5'],
      ['1.2.3-rc.1+sha.abc', '1.2.3-rc.1+sha.abc'],
      ['20261122093000.0.1', '20261122093000.0.1'],
      ['1.2.3-' + 'a'.repeat(58), '1.2.3-' + 'a'.repeat(58)],
      ['1.2.3-' + 'a'.repeat(59), null],
      ['v1.2.3', null],
      ['1.2', null],
      ['1', null],
      ['1.2.3.4', null],
      [' 1.2.3', null],
      ['1.2.3 ', null],
      ['1.2.3\n', null],
      ['1.2.3-', null],
      ['1.2.3; rm -rf /', null],
      ['1234567890123456.0.0', null],
      ['latest', null],
      ['', null],
      [null, null],
      [123, null],
      [['1.2.3'], null],
    ]));
    await check('A4. compareSemver：数值比较、预发布规则、构建号不参与；不是 semver → null（不猜）', () => table(catalog.compareSemver, [
      ['1.0.0', '1.0.0', 0],
      ['1.0.1', '1.0.0', 1],
      ['1.0.0', '1.1.0', -1],
      ['2.0.0', '10.0.0', -1],
      ['1.10.0', '1.9.0', 1],
      ['1.0.0', '1.0.0-rc.1', 1],
      ['1.0.0-rc.1', '1.0.0', -1],
      ['1.0.0-alpha', '1.0.0-alpha.1', -1],
      ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
      ['1.0.0-beta.2', '1.0.0-beta.11', -1],
      ['1.0.0-beta.11', '1.0.0-rc.1', -1],
      ['1.0.0-rc.1', '1.0.0-rc.1', 0],
      ['v1.2.3', '1.2.3', 0],
      ['1.0.0+a', '1.0.0+b', 0],
      ['1.0', '1.0.0', null],
      ['latest', '1.0.0', null],
      ['1.0.0', '^1.0.0', null],
      [null, '1.0.0', null],
      ['1.0.0', undefined, null],
      [1, 2, null],
    ]));
    await check('A5. cleanDate：收敛成 UTC ISO；范围外 / 认不出 / 不是字符串 → null', () => table(catalog.cleanDate, [
      ['2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z'],
      ['2026-10-01', '2026-10-01T00:00:00.000Z'],
      ['2026-10-01T08:00:00+08:00', '2026-10-01T00:00:00.000Z'],
      ['2009-12-31T23:59:59Z', null],
      ['2100-01-02T00:00:00Z', null],
      ['yesterday', null],
      ['2026-10-01T08:00:00.000Z' + ' '.repeat(20), null],
      ['', null],
      [1700000000000, null],
      [null, null],
    ]));
    await check('A6. cleanHandle：只认 npm 用户名的形状（带空格的不是用户名）', () => table(catalog.cleanHandle, [
      ['alice', 'alice'],
      ['a.b-c_d', 'a.b-c_d'],
      ['A1', 'A1'],
      ['x'.repeat(64), 'x'.repeat(64)],
      ['x'.repeat(65), null],
      ['GitHub Actions', null],
      ['-lead', null],
      ['bad<script>', null],
      ['alice' + ZWSP, null],
      ['', null],
      [42, null],
      [null, null],
    ]));
    await check('A7. cleanLink：只收 https、不带凭据；别的协议一律不要', () => table(catalog.cleanLink, [
      ['https://example.com/a?b=1#c', 'https://example.com/a?b=1#c'],
      ['https://example.com', 'https://example.com/'],
      ['  https://example.com/x  ', 'https://example.com/x'],
      ['http://example.com/', null],
      ['javascript:alert(1)', null],
      ['data:text/html,<script>alert(1)</script>', null],
      ['file:///etc/passwd', null],
      ['ftp://example.com/x', null],
      ['https://user:pw@example.com/', null],
      ['https://token@example.com/', null],
      ['//example.com/x', null],
      ['example.com/x', null],
      ['acme/x', null],
      ['git+https://github.com/acme/x.git', null],
      ['https://', null],
      ['', null],
      [42, null],
      [null, null],
      ['https://example.com/' + 'a'.repeat(300), null],
      ['https://example.com/' + 'a'.repeat(400), null],
    ]));
    await check('A8. cleanLink（仓库形态）：npm 的各种写法收敛成网页地址；ssh / git 协议不要', () => table(
      (value) => catalog.cleanLink(value, { repository: true }), [
        ['git+https://github.com/acme/x.git', 'https://github.com/acme/x'],
        ['https://github.com/acme/x.git', 'https://github.com/acme/x'],
        ['https://gitlab.com/group/sub/x', 'https://gitlab.com/group/sub/x'],
        ['github:acme/x', 'https://github.com/acme/x'],
        ['acme/x', 'https://github.com/acme/x'],
        ['git+ssh://git@github.com/acme/x.git', null],
        ['git://github.com/acme/x.git', null],
        ['git@github.com:acme/x.git', null],
        ['git+https://user:tok3n@github.com/acme/x.git', null],
        ['../../etc/passwd', null],
        ['acme/x/y', null],
        [{ url: 'https://github.com/acme/x' }, null],
      ]));
    await check('A9. cleanKeywords：小写、去重、限长；pi-package 排在第 150 位也找得到并放到第一位', () => {
      const basic = catalog.cleanKeywords(['Pi-Package', 'MEMORY', 'memory', '', 42, null, ' spaced  out ', 'x'.repeat(60)]);
      const padded = Array.from({ length: 180 }, (_, index) => (index === 150 ? 'pi-package' : `kw-${index}`));
      const deep = catalog.cleanKeywords(padded);
      const beyond = catalog.cleanKeywords([...Array.from({ length: 200 }, (_, index) => `kw-${index}`), 'pi-package']);
      return (same(basic, ['pi-package', 'memory', 'spaced out', 'x'.repeat(40)]) === true
        && deep[0] === 'pi-package' && deep.length === 40 && deep[1] === 'kw-0'
        && !beyond.includes('pi-package') && beyond.length === 40
        && same(catalog.cleanKeywords('pi-package'), []) === true && same(catalog.cleanKeywords(null), []) === true)
        || JSON.stringify({ basic, deep: deep.slice(0, 3), beyond: beyond.length });
    });
    await check('A10. 条目 id 就是安装器的 source；形状判据与安装器是同一条', () => {
      const bad = ['foo', 'npm:Foo', 'npm:foo@1.0.0', 'npm:foo@latest', 'npm:../x', 'npm:@a/../b', 'npm:', 'npm:.foo', 'npm:-foo', 'npm:_foo',
        'npm:foo bar', 'npm:foo\n', ' npm:foo', 'npm:--registry=https://evil.example', 'git:github.com/a/b', 'https://x', null, undefined, 42, {}, ['npm:foo']];
      const leaked = bad.filter((id) => catalog.nameOfMarketId(id) !== null);
      return (catalog.marketIdOf('foo') === 'npm:foo' && catalog.nameOfMarketId('npm:foo') === 'foo'
        && catalog.nameOfMarketId('npm:@scope/foo') === '@scope/foo' && leaked.length === 0) || JSON.stringify(leaked);
    });
    await check('A11. 已知能力的包名 → 能力 id；次序固定（网页、子智能体、记忆、浏览器）', () =>
      (same(Object.entries(CAPABILITY_SOURCES), [['web', 'npm:pi-web-access'], ['subagents', 'npm:pi-subagents'], ['memory', 'npm:pi-memory'], ['browser', 'npm:pi-browser-harness']]) === true
        && table(catalog.knownCapabilityOf, [
          ['pi-web-access', 'web'], ['pi-subagents', 'subagents'], ['pi-memory', 'memory'], ['pi-browser-harness', 'browser'],
          ['left-pad', null], ['toString', null], ['__proto__', null], ['constructor', null], ['', null],
        ]) === true) || '已知能力表变了');
    await check('A12. categorize：按包自带的关键词归类；已知能力直接指定；归不进就是「其他」', () => table(catalog.categorize, [
      [['subagents'], 'x', 'agents'],
      [['memory'], 'x', 'memory'],
      [['ollama'], 'x', 'models'],
      [['mcp'], 'x', 'integrations'],
      [['web-search'], 'x', 'web'],
      [['macos'], 'x', 'desktop'],
      [['lint'], 'x', 'devtools'],
      [['todo'], 'x', 'productivity'],
      [[], 'x', 'other'],
      [['pi', 'ai', 'agent', 'llm', 'cli'], 'x', 'other'],
      [['git', 'test', 'mcp'], 'x', 'devtools'],
      [['subagents', 'memory'], 'x', 'agents'],
      [['todo', 'lint'], 'x', 'devtools'],
      [['skills'], 'x', 'productivity'],
      [['skills', 'claude'], 'x', 'integrations'],
      [['mcp', 'mcp-server', 'slack'], 'pi-memory', 'memory'],
      [['memory'], 'pi-web-access', 'web'],
      [[], 'pi-subagents', 'agents'],
      [[], 'pi-browser-harness', 'web'],
      [['toString', 'constructor', '__proto__'], '__proto__', 'other'],
      [null, 'x', 'other'],
      ['memory', 'x', 'other'],
    ]));
    await check('A13. 分类清单：九类，标签固定；每一类至少有一条规则能到达（没有空类别）', () => {
      const reachable = new Set([
        ['lint'], ['subagents'], ['todo'], ['web-search'], ['macos'], ['memory'], ['ollama'], ['mcp'], [],
      ].map((keywords) => catalog.categorize(keywords, 'x')));
      return (same(catalog.MARKET_CATEGORIES.map((c) => [c.id, c.label]), [
        ['devtools', '开发工具'], ['agents', '智能体与工作流'], ['productivity', '效率工具'], ['web', '网页与搜索'], ['desktop', '桌面与系统'],
        ['memory', '记忆与知识库'], ['models', '模型与供应商'], ['integrations', '第三方接入'], ['other', '其他'],
      ]) === true && reachable.size === 9 && Object.isFrozen(catalog.MARKET_CATEGORIES)) || [...reachable].join(',');
    });
    await check('A14. displayTags：包自己写的关键词里前三个非泛词；不造标签', () =>
      (same(catalog.displayTags(['pi-package', 'pi', 'agent', 'memory', 'rag', 'notes', 'extra']), ['memory', 'rag', 'notes']) === true
        && same(catalog.displayTags(['pi-package', 'pi-extension', 'ai', 'llm', 'cli', 'typescript']), []) === true
        && same(catalog.displayTags(null), []) === true) || '标签规则变了');

    section('A′. 归一化：npm 搜索结果 / 磁盘缓存 / 包清单');

    await check('A15. normalizeSearchObject：真实形状的一行 → 完整条目', () =>
      same(catalog.normalizeSearchObject(row('@scope/gamma-web', {
        keywords: ['pi-package', 'web-search', 'pi', 'Exa'], version: '2.1.0', monthly: 4321, date: '2026-10-01T08:00:00+08:00',
      }), 7), {
        id: 'npm:@scope/gamma-web', name: '@scope/gamma-web', description: '@scope/gamma-web for pi', version: '2.1.0',
        maintainer: 'alice', updatedAt: '2026-10-01T00:00:00.000Z',
        keywords: ['pi-package', 'web-search', 'pi', 'exa'], tags: ['web-search', 'exa'], category: 'web',
        downloadsMonthly: 4321, license: 'MIT',
        links: { npm: 'https://www.npmjs.com/package/@scope/gamma-web', repository: 'https://github.com/acme/gamma-web', homepage: 'https://example.test/@scope/gamma-web#readme' },
        known: null, knownOrder: null, flagged: false, rank: 7,
      }));
    await check('A16. 邮箱不读：结果里没有任何邮箱的痕迹', () => {
      const text = JSON.stringify(catalog.normalizeSearchObject(row('alpha-tools'), 0));
      return (!text.includes('secret-mail') && !text.includes('email')) || text;
    });
    await check('A17. 不合格的行整条丢弃：不是对象 / 没有 package / 包名不过严格规则 / 没有 pi-package 关键词', () => {
      const bad = [
        null, undefined, 'row', 42, [], {}, { package: null }, { package: 'x' }, { package: {} }, { package: { name: 42, keywords: ['pi-package'] } },
        row('Bad_Name'), row('../escape'), row('a b'), row('foo@1.0.0'), row('--registry=x'), row('.hidden'), row('x'.repeat(215)),
        row('no-keyword', { keywords: ['pi', 'extension'] }), row('no-keywords', { keywords: null }), row('kw-string', { keywords: 'pi-package' }),
        row('@scope/'), row('@/name'), row(''),
      ];
      const kept = bad.filter((value) => catalog.normalizeSearchObject(value, 0) !== null);
      return kept.length === 0 || JSON.stringify(kept.map((value) => value && value.package && value.package.name));
    });
    await check('A18. 逐字段：拿不到 / 形状不对的字段是 null（未知），不补默认值', () => {
      const item = catalog.normalizeSearchObject(row('odd-one', {
        version: 'v1.0.0', description: 42, date: 'soon', monthly: -1, license: { type: 'MIT' }, links: 'none',
        maintainers: [{ username: 'GitHub Actions', email: 'x@secret-mail.test' }], publisher: { username: 'has space' },
      }), -1);
      const noFlags = row('no-flags');
      delete noFlags.flags;
      delete noFlags.downloads;
      const bare = catalog.normalizeSearchObject(noFlags, 1.5);
      return (same({ ...item, keywords: 0, tags: 0 }, {
        id: 'npm:odd-one', name: 'odd-one', description: null, version: null, maintainer: null, updatedAt: null,
        keywords: 0, tags: 0, category: 'other', downloadsMonthly: null, license: null,
        links: { npm: 'https://www.npmjs.com/package/odd-one', repository: null, homepage: null },
        known: null, knownOrder: null, flagged: false, rank: null,
      }) === true && bare.flagged === false && bare.downloadsMonthly === null && bare.rank === null) || JSON.stringify({ item, bare });
    });
    await check('A19. 维护者取第一个 maintainer 的用户名，没有再退到 publisher；月下载量只认非负整数', () => {
      const pick = (extra) => catalog.normalizeSearchObject(row('x-pkg', extra), 0);
      return (pick({}).maintainer === 'alice' && pick({ maintainers: [] }).maintainer === 'publisher-bot'
        && pick({ maintainers: 'alice' }).maintainer === 'publisher-bot' && pick({ maintainers: [null], publisher: null }).maintainer === null
        && pick({ monthly: 0 }).downloadsMonthly === 0 && pick({ monthly: 1.5 }).downloadsMonthly === null
        && pick({ monthly: '100' }).downloadsMonthly === null && pick({ monthly: Number.MAX_SAFE_INTEGER + 1 }).downloadsMonthly === null)
        || '维护者 / 下载量的取值规则变了';
    });
    await check('A20. 描述去掉看不见的字符并截断到 300；许可证截断到 40；npm 标记不安全 → flagged', () => {
      const item = catalog.normalizeSearchObject(row('long-one', {
        description: 'safe' + RLO + 'text' + ZWSP + ' ' + 'd'.repeat(400), license: 'L'.repeat(80), insecure: true,
      }), 3);
      return (item.description.startsWith('safe text d') && item.description.length === 300 && item.license === 'L'.repeat(40)
        && item.flagged === true && item.rank === 3) || JSON.stringify(item);
    });
    await check('A21. 已知能力的包：known / knownOrder / 类别由 Pi GUI 指定，不看它自己写的关键词', () => {
      const item = catalog.normalizeSearchObject(row('pi-browser-harness', { keywords: ['pi-package', 'memory', 'rag'] }), 40);
      return (item.known === 'browser' && item.knownOrder === 3 && item.category === 'web' && item.rank === 40) || JSON.stringify(item);
    });
    await check('A22. 磁盘缓存往返：归一化的结果写出去再读回来一模一样', () => {
      for (const source of PAGES().flat()) {
        const item = catalog.normalizeSearchObject(source, 5);
        if (!item) continue;
        const verdict = same(catalog.reviveCatalogItem(JSON.parse(JSON.stringify(item))), item);
        if (verdict !== true) return `${item.name}: ${verdict}`;
      }
      return true;
    });
    await check('A23. 磁盘缓存是不可信输入：被改过的字段重新校验，分类 / 标签 / known / npm 链接重算', () => {
      const revived = catalog.reviveCatalogItem({
        name: 'tampered', keywords: ['pi-package', 'memory'], category: 'devtools', tags: ['injected'], known: 'web', knownOrder: 0,
        flagged: 'yes', rank: -5, version: '1.0.0; rm -rf /', description: 'ok' + ZWSP + 'hidden', maintainer: 'has space',
        links: { npm: 'https://evil.example/', repository: 'javascript:alert(1)', homepage: 'http://insecure.example/' },
        downloadsMonthly: -1, updatedAt: 'yesterday', license: 42, email: 'leak@secret-mail.test', extra: { nested: true },
      });
      const dropped = [null, 'x', [], {}, { name: '../escape', keywords: ['pi-package'] }, { name: 'nokw', keywords: [] },
        { name: 'Upper', keywords: ['pi-package'] }, { name: 42, keywords: ['pi-package'] }].filter((raw) => catalog.reviveCatalogItem(raw) !== null);
      return (same(revived, {
        id: 'npm:tampered', name: 'tampered', description: 'ok hidden', version: null, maintainer: null, updatedAt: null,
        keywords: ['pi-package', 'memory'], tags: ['memory'], category: 'memory', downloadsMonthly: null, license: null,
        links: { npm: 'https://www.npmjs.com/package/tampered', repository: null, homepage: null },
        known: null, knownOrder: null, flagged: false, rank: null,
      }) === true && dropped.length === 0) || JSON.stringify({ revived, dropped });
    });
    await check('A24. 内置条目：四个已知能力，离线也在；版本 / 维护者 / 下载量 / 时间都是未知', () => {
      const items = catalog.builtinMarketItems();
      return (same(items.map((item) => [item.id, item.known, item.knownOrder, item.category]), [
        ['npm:pi-web-access', 'web', 0, 'web'], ['npm:pi-subagents', 'subagents', 1, 'agents'],
        ['npm:pi-memory', 'memory', 2, 'memory'], ['npm:pi-browser-harness', 'browser', 3, 'web'],
      ]) === true && items.every((item) => item.version === null && item.maintainer === null && item.updatedAt === null
        && item.downloadsMonthly === null && item.license === null && item.rank === null && item.flagged === false
        && item.keywords.length === 0 && item.tags.length === 0 && typeof item.description === 'string' && item.description.length > 5
        && item.links.npm === `https://www.npmjs.com/package/${item.name}` && item.links.repository === null)) || JSON.stringify(items);
    });
    await check('A25. normalizeManifest：真实形状的清单 → 详情里的事实（脚本只记名字）', () => {
      const detail = catalog.normalizeManifest(manifest('alpha-tools'), 'alpha-tools');
      const text = JSON.stringify(detail);
      const verdict = same(detail, detailOf('alpha-tools'));
      return verdict === true
        ? (!text.includes('SECRET-SCRIPT') && !text.includes('secret-mail') && !text.includes('tarball') && !text.includes('.tgz')) || '脚本内容 / 邮箱 / 下载地址出了后端'
        : verdict;
    });
    await check('A26. normalizeManifest：名字对不上 / 版本不是 semver / 不是对象 → 整份不认', () => {
      const bad = [
        [manifest('other-name'), 'alpha-tools'], [manifest('alpha-tools', { version: 'latest' }), 'alpha-tools'],
        [manifest('alpha-tools', { version: undefined }), 'alpha-tools'], [null, 'alpha-tools'], [[], 'alpha-tools'], ['x', 'alpha-tools'],
        [manifest('alpha-tools', { name: 'Alpha-Tools' }), 'alpha-tools'],
      ];
      const kept = bad.filter(([data, name]) => catalog.normalizeManifest(data, name) !== null);
      return kept.length === 0 || JSON.stringify(kept.map(([data]) => data && data.name));
    });
    await check('A27. normalizeManifest：没有 pi 字段 → 资源数是 null（按约定目录加载，清单里读不出来），不是 0', () => {
      const detail = catalog.normalizeManifest(manifest('plain', {
        pi: undefined, scripts: undefined, dependencies: undefined, peerDependencies: undefined, engines: undefined, dist: undefined,
        author: { name: 'Bob <bob@secret-mail.test>', email: 'bob@secret-mail.test' }, _npmUser: undefined, repository: 'acme/plain',
        homepage: 'http://insecure.example/', license: { type: 'Apache-2.0' }, deprecated: 'use something else' + RLO,
      }), 'plain');
      return same(detail, detailOf('plain', {
        author: 'Bob', publishedBy: null, license: 'Apache-2.0',
        links: { npm: 'https://www.npmjs.com/package/plain', repository: 'https://github.com/acme/plain', homepage: null },
        declaresResources: false, resources: { extensions: null, skills: null, prompts: null, themes: null },
        installScripts: [], dependencyCount: 0, unpackedSize: null, fileCount: null,
        integrity: false, signatures: false, provenance: false, nodeRange: null, peer: null, deprecated: 'use something else',
      }));
    });
    await check('A28. normalizeManifest：三个安装期脚本都认；旧宿主包名也认；pi 字段里只数字符串', () => {
      const detail = catalog.normalizeManifest(manifest('scripted', {
        scripts: { preinstall: 'a', install: 'b', postinstall: 'c', prepare: 'd', postuninstall: 'e' },
        peerDependencies: { '@mariozechner/pi-coding-agent': '>=0.50.0', react: '*' },
        pi: { extensions: ['a.ts', 42, null, 'b.ts'], skills: 'skills', prompts: [], themes: ['t'] },
        dist: { unpackedSize: -1, fileCount: 1.5, integrity: '', signatures: [] },
      }), 'scripted');
      return (same(detail.installScripts, ['preinstall', 'install', 'postinstall']) === true
        && same(detail.peer, { name: '@mariozechner/pi-coding-agent', range: '>=0.50.0' }) === true
        && same(detail.resources, { extensions: 2, skills: null, prompts: 0, themes: 1 }) === true
        && detail.unpackedSize === null && detail.fileCount === null && detail.integrity === false && detail.signatures === false
        && detail.provenance === false) || JSON.stringify(detail);
    });

    section('A″. 查询参数 / 搜索 / 排序 / 地址 / 兼容性（纯函数）');

    const parse = (text) => catalog.parseMarketQuery(new URLSearchParams(text));
    await check('A29. parseMarketQuery：认不出的值回默认，数字夹在范围里', () =>
      (same(parse(''), { q: '', category: 'all', sort: 'recommended', offset: 0, limit: 24, deep: false }) === true
        && same(parse('q=++Hello+++World++&category=web&sort=downloads&offset=48&limit=12&deep=1'),
          { q: 'Hello World', category: 'web', sort: 'downloads', offset: 48, limit: 12, deep: true }) === true
        && table((text) => {
          const q = parse(text);
          return [q.category, q.sort, q.offset, q.limit, q.deep];
        }, [
          ['category=all&sort=name', ['all', 'name', 0, 24, false]],
          ['category=nope&sort=hot', ['all', 'recommended', 0, 24, false]],
          ['category=__proto__&sort=constructor', ['all', 'recommended', 0, 24, false]],
          ['offset=-1&limit=0', ['all', 'recommended', 0, 1, false]],
          ['offset=1.5&limit=49', ['all', 'recommended', 0, 48, false]],
          ['offset=abc&limit=x', ['all', 'recommended', 0, 24, false]],
          ['offset=9999999&limit=48', ['all', 'recommended', 100000, 48, false]],
          ['offset=99999999', ['all', 'recommended', 0, 24, false]],
          ['offset=1e3', ['all', 'recommended', 0, 24, false]],
          ['deep=true', ['all', 'recommended', 0, 24, false]],
          ['deep=1', ['all', 'recommended', 0, 24, true]],
        ]) === true
        && parse('q=' + 'x'.repeat(100)).q.length === 64
        && parse('q=a%00b%E2%80%8Bc').q === 'a b c'
        && same(catalog.parseMarketQuery(null), parse('')) === true && same(catalog.parseMarketQuery({}), parse('')) === true)
        || '查询参数的解析变了');
    await check('A30. 搜索：最多 8 个词，全部都要命中（名称 / 简介 / 关键词 / 维护者任意一处），不分大小写', () => {
      const item = catalog.normalizeSearchObject(row('alpha-tools', { keywords: ['pi-package', 'git'], description: 'Lint Helper' }), 0);
      return (same(catalog.searchTokens('  Foo   BAR baz '), ['foo', 'bar', 'baz']) === true
        && catalog.searchTokens('a b c d e f g h i j').length === 8 && same(catalog.searchTokens(''), []) === true
        && catalog.matchesTokens(item, []) === true
        && catalog.matchesTokens(item, catalog.searchTokens('ALPHA')) === true
        && catalog.matchesTokens(item, catalog.searchTokens('lint GIT alice')) === true
        && catalog.matchesTokens(item, catalog.searchTokens('alpha missing')) === false
        && catalog.matchesTokens({ ...item, description: null, maintainer: null }, ['null']) === false) || '搜索规则变了';
    });
    await check('A31. 排序清单：推荐 / 下载量 / 最新 / 名称 —— 没有「最热」「评分」', () => {
      const labels = catalog.MARKET_SORTS.map((sort) => `${sort.id}:${sort.label}`);
      return (same(labels, ['recommended:推荐', 'downloads:下载量', 'updated:最新', 'name:名称']) === true
        && !labels.join(' ').match(/热|评分|star|rating|popular|trending/i)) || labels.join(',');
    });
    await check('A32. availableSorts：没有数据支撑的排序是不可用（不拿 0 充数）', () => {
      const none = catalog.availableSorts(catalog.builtinMarketItems()).map((sort) => [sort.id, sort.available]);
      const some = catalog.availableSorts([catalog.normalizeSearchObject(row('x-pkg', { date: 'bad' }), 0)]).map((sort) => [sort.id, sort.available]);
      return (same(none, [['recommended', true], ['downloads', false], ['updated', false], ['name', true]]) === true
        && same(some, [['recommended', true], ['downloads', true], ['updated', false], ['name', true]]) === true) || JSON.stringify({ none, some });
    });
    await check('A33. sortMarketItems：不改入参；认不出的排序按推荐', () => {
      const items = PAGES()[0].map((source, index) => catalog.normalizeSearchObject(source, index));
      const before = items.map((item) => item.name);
      const byName = catalog.sortMarketItems(items, 'name').map((item) => item.name);
      const bogus = catalog.sortMarketItems(items, 'toString').map((item) => item.name);
      return (same(items.map((item) => item.name), before) === true
        && same(byName, ['@scope/gamma-web', 'alpha-tools', 'beta-agents', 'flagged-thing', 'pi-memory']) === true
        && same(bogus, ['pi-memory', 'alpha-tools', 'beta-agents', '@scope/gamma-web', 'flagged-thing']) === true) || JSON.stringify({ byName, bogus });
    });
    await check('A34. 远端地址：固定的 registry、固定的关键词限定；带 scope 的包名里的 / 编码', () =>
      (catalog.REGISTRY_ORIGIN === 'https://registry.npmjs.org' && catalog.CATALOG_KEYWORD === 'pi-package'
        && catalog.searchUrl() === 'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=250'
        && catalog.searchUrl({ size: 250, from: 500 }) === 'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=250&from=500'
        && catalog.searchUrl({ text: 'foo bar', size: 50 }) === 'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package+foo+bar&size=50'
        && catalog.manifestUrl('foo') === 'https://registry.npmjs.org/foo/latest'
        && catalog.manifestUrl('@scope/foo') === 'https://registry.npmjs.org/@scope%2Ffoo/latest') || '地址的拼法变了');
    await check('A35. 深度搜索的词：去掉限定符用的冒号与其它符号；不足两个字符不搜', () => table(catalog.deepSearchText, [
      ['  foo   bar ', 'foo bar'],
      ['a', ''],
      ['', ''],
      [':::', ''],
      ['author:evil', 'author evil'],
      ['foo keywords:x not:insecure is:unstable', 'foo keywords x not insecure is unstable'],
      ['foo&size=9999&from=1', 'foo size 9999 from 1'],
      ['foo"bar\'baz', 'foo bar baz'],
      ['@scope/name', '@scope/name'],
      ['pi-web.access_x', 'pi-web.access_x'],
      ['a_b|c;d$e`f(g)h', 'a_b c d e f g h'],
      ['a' + NUL + 'b', 'a b'],
      [42, ''],
    ]));
    await check('A36. 深度搜索的词支持非拉丁文字', () => {
      const text = catalog.deepSearchText(String.fromCodePoint(0x8bb0, 0x5fc6) + ' memory');
      return text === String.fromCodePoint(0x8bb0, 0x5fc6) + ' memory' || JSON.stringify(text);
    });
    await check('A37. satisfiesRange：常见写法判得准；判断不了的写法回 null（不误判）', () => table(catalog.satisfiesRange, [
      ['1.6.0', '*', true],
      ['1.6.0', '', true],
      ['1.6.0', 'x', true],
      ['1.6.0', '>=1.5.0', true],
      ['1.4.9', '>=1.5.0', false],
      ['1.6.0', '>= 1.5.0', true],
      ['1.6.0', '^1.2', true],
      ['2.0.0', '^1.2', false],
      ['1.1.9', '^1.2', false],
      ['0.5.3', '^0.5.1', true],
      ['0.6.0', '^0.5.1', false],
      ['0.0.3', '^0.0.3', true],
      ['0.0.4', '^0.0.3', false],
      ['1.2.9', '~1.2.3', true],
      ['1.3.0', '~1.2.3', false],
      ['1.9.9', '~1', true],
      ['1.6.0', '1.x', true],
      ['2.0.0', '1.x', false],
      ['1.6.0', '1', true],
      ['1.6.0', '1.6', true],
      ['1.7.0', '1.6', false],
      ['1.6.0', '=1.6.0', true],
      ['1.6.1', '1.6.0', false],
      ['1.6.0', '>=1.0.0 <2.0.0', true],
      ['2.0.0', '>=1.0.0 <2.0.0', false],
      ['1.6.0', '>1', false],
      ['2.0.0', '>1', true],
      ['1.6.0', '<=1', true],
      ['1.6.0', '<1.6', false],
      ['1.5.9', '<1.6', true],
      ['1.6.0', '^0.9 || ^1.5', true],
      ['3.0.0', '^0.9 || ^1.5', false],
      ['v1.6.0', '>=1.5.0', true],
      ['1.6.0', '1.0.0 - 2.0.0', null],
      ['1.6.0', 'latest', null],
      ['1.6.0', '1.x.3', null],
      ['1.6.0', '>=1.5.0-beta.1', null],
      ['1.6.0', '^0.9 || workspace:*', null],
      ['1.6.0', '^1.5 || workspace:*', true],
      ['1.6.0-beta.1', '>=1.5.0', null],
      ['not-a-version', '*', null],
      ['1.6.0', null, null],
      ['1.6.0', '>=1.0.0 ' + 'x'.repeat(120), null],
    ]));
    await check('A38. compatibility：只是提示 —— 五种结论，旧宿主包名的版本线不对照', () => table(catalog.compatibility, [
      [null, '1.6.0', { status: 'undeclared', peer: null, range: null, piVersion: '1.6.0', legacy: false }],
      [{ name: '@earendil-works/pi-coding-agent', range: '>=1.5.0' }, '1.6.0',
        { status: 'compatible', peer: '@earendil-works/pi-coding-agent', range: '>=1.5.0', piVersion: '1.6.0', legacy: false }],
      [{ name: '@earendil-works/pi-coding-agent', range: '>=2.0.0' }, '1.6.0',
        { status: 'incompatible', peer: '@earendil-works/pi-coding-agent', range: '>=2.0.0', piVersion: '1.6.0', legacy: false }],
      [{ name: '@earendil-works/pi-coding-agent', range: '*' }, '1.6.0',
        { status: 'unconstrained', peer: '@earendil-works/pi-coding-agent', range: '*', piVersion: '1.6.0', legacy: false }],
      [{ name: '@earendil-works/pi-coding-agent', range: 'latest' }, '1.6.0',
        { status: 'unknown', peer: '@earendil-works/pi-coding-agent', range: 'latest', piVersion: '1.6.0', legacy: false }],
      [{ name: '@earendil-works/pi-coding-agent', range: '>=1.5.0' }, null,
        { status: 'unknown', peer: '@earendil-works/pi-coding-agent', range: '>=1.5.0', piVersion: null, legacy: false }],
      [{ name: '@earendil-works/pi-coding-agent', range: '>=1.5.0' }, 'v1.6.0',
        { status: 'unknown', peer: '@earendil-works/pi-coding-agent', range: '>=1.5.0', piVersion: null, legacy: false }],
      [{ name: '@mariozechner/pi-coding-agent', range: '>=0.50.0' }, '1.6.0',
        { status: 'unknown', peer: '@mariozechner/pi-coding-agent', range: '>=0.50.0', piVersion: '1.6.0', legacy: true }],
      [{ name: '@mariozechner/pi-coding-agent', range: '*' }, '1.6.0',
        { status: 'unconstrained', peer: '@mariozechner/pi-coding-agent', range: '*', piVersion: '1.6.0', legacy: true }],
    ]));

    /* ================= B. 没有同意：只有内置条目，不联网、不写盘 ================= */
    section('B. 没有同意');

    await check('B1. 目录里只有四个内置条目；一次请求都不发；数据目录里一个文件都不写', async () => {
      const m = make({ pages: PAGES() });
      const listed = await m.market.list(Q());
      const verdict = same(listed, {
        ok: true,
        consent: { remote: false },
        source: SOURCE,
        snapshot: EMPTY_SNAPSHOT,
        categories: [
          { id: 'all', label: '全部', count: 4 }, { id: 'agents', label: '智能体与工作流', count: 1 },
          { id: 'web', label: '网页与搜索', count: 2 }, { id: 'memory', label: '记忆与知识库', count: 1 },
        ],
        sorts: [
          { id: 'recommended', label: '推荐', available: true }, { id: 'downloads', label: '下载量', available: false },
          { id: 'updated', label: '最新', available: false }, { id: 'name', label: '名称', available: true },
        ],
        query: { q: '', category: 'all', sort: 'recommended', offset: 0, limit: 24 },
        total: 4,
        catalogTotal: 4,
        items: [
          wireOf('pi-web-access', { description: '网页搜索、网页抓取、PDF 提取与视频理解。', known: 'web', category: 'web' }),
          wireOf('pi-subagents', { description: '把任务委派给子智能体，或按脚本编排多智能体工作流。', known: 'subagents', category: 'agents' }),
          wireOf('pi-memory', { description: '跨会话记忆：每日日志、长期记忆与草稿板，支持语义检索。', known: 'memory', category: 'memory' }),
          wireOf('pi-browser-harness', { description: '通过 CDP 控制真实 Chrome：导航、点击、输入、截图与提取数据。', known: 'browser', category: 'web' }),
        ].map((item) => ({
          ...item, version: null, maintainer: null, updatedAt: null, keywords: [], downloadsMonthly: null, license: null,
          links: { npm: item.links.npm, repository: null, homepage: null },
        })),
        nextOffset: null,
        deep: null,
        operations: { available: true, running: false },
      });
      if (verdict !== true) return verdict;
      return (m.calls.length === 0 && !fs.existsSync(m.dir)) || `请求 ${m.calls.length} 次，数据目录存在：${fs.existsSync(m.dir)}`;
    });
    await check('B2. 要求按下载量 / 最新排 → 没有数据，实际按推荐排，并如实回报', async () => {
      const m = make({ pages: PAGES() });
      const a = await m.market.list(Q({ sort: 'downloads' }));
      const b = await m.market.list(Q({ sort: 'updated' }));
      const c = await m.market.list(Q({ sort: 'name' }));
      return (a.query.sort === 'recommended' && b.query.sort === 'recommended' && c.query.sort === 'name'
        && same(names(c), ['pi-browser-harness', 'pi-memory', 'pi-subagents', 'pi-web-access']) === true && m.calls.length === 0)
        || JSON.stringify([a.query, b.query, names(c)]);
    });
    await check('B3. 详情：内置条目给得出来，但不读清单（detailState=no-consent）；不联网', async () => {
      const m = make({ manifests: { 'pi-memory': manifest('pi-memory') } });
      const r = await m.market.item('npm:pi-memory');
      return (r.ok === true && r.detailState === 'no-consent' && r.detail === null && r.detailError === null && r.compatibility === null
        && r.item.name === 'pi-memory' && r.item.version === null && r.consent.remote === false && r.piVersion === '1.6.0'
        && m.calls.length === 0) || JSON.stringify(r);
    });
    await check('B4. 刷新 → consent-required；深度搜索 → 失败并说明；都不联网', async () => {
      const m = make({ pages: PAGES(), deep: [row('zeta-extra')] });
      const refresh = await m.market.act({ action: 'refresh' });
      const listed = await m.market.list(Q({ q: 'zeta', deep: true }));
      return (same(refresh, { ok: false, code: 'consent-required', error: '还没有同意读取在线目录', consent: { remote: false }, snapshot: EMPTY_SNAPSHOT }) === true
        && same(listed.deep, { state: 'failed', added: 0, error: { code: 'consent-required', error: '还没有同意读取在线目录' } }) === true
        && listed.total === 0 && m.calls.length === 0) || JSON.stringify({ refresh, deep: listed.deep });
    });
    await check('B5. 内部入口直接调也发不出请求：同意在每次远端读取出去之前都再验一遍', async () => {
      const m = make({ pages: PAGES(), manifests: { 'pi-memory': manifest('pi-memory') }, deep: [row('zeta-extra')] });
      const refresh = await m.market._internals.refresh();
      const deep = await m.market._internals.deepSearch('zeta');
      const detail = await m.market._internals.manifestOf('pi-memory');
      return (refresh.ok === false && refresh.code === 'consent-required' && deep.state === 'failed' && deep.error.code === 'consent-required'
        && detail.ok === false && detail.code === 'consent-required' && m.calls.length === 0
        && same(m.market._internals.snapshotMeta(), EMPTY_SNAPSHOT) === true) || JSON.stringify({ refresh, deep, detail });
    });
    await check('B6. 安装闸门用的只读方法：内置的认得，别的不认；warm 不联网、不读缓存', async () => {
      const dir = newDir();
      writeCache(dir, { version: 1, at: T0, npmTotal: 9, pages: 1, partial: false, items: [catalog.normalizeSearchObject(row('cached-thing'), 0)] });
      const m = make({ dir, pages: PAGES() });
      await m.market.warm();
      const listed = await m.market.list(Q());
      return (m.market.has('npm:pi-memory') === true && m.market.has('npm:cached-thing') === false && m.market.has('npm:alpha-tools') === false
        && m.market.has(null) === false && m.market.has(42) === false && m.market.has('pi-memory') === false
        && m.market.flagged('npm:pi-memory') === false && m.market.latestVersion('pi-memory') === null
        && same(m.market.status(), { remote: false, at: null }) === true && listed.total === 4 && listed.snapshot.state === 'none'
        && m.calls.length === 0) || JSON.stringify({ status: m.market.status(), total: listed.total });
    });
    await check('B7. 同意文件形状不对 / 太大 / 不是 JSON / remote 不是 true → 一律当作没有同意', async () => {
      const bad = [
        '{broken', '[]', 'null', '"yes"', JSON.stringify({ version: 2, remote: true }), JSON.stringify({ version: 1, remote: 'true' }),
        JSON.stringify({ version: 1, remote: 1 }), JSON.stringify({ remote: true }), JSON.stringify({ version: 1, remote: false }),
        JSON.stringify({ version: 1, remote: true, pad: 'x'.repeat(5000) }), '',
      ];
      for (const text of bad) {
        const dir = newDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(consentFileOf(dir), text);
        const m = make({ dir, pages: PAGES() });
        const listed = await m.market.list(Q());
        if (!(listed.consent.remote === false && listed.total === 4 && m.calls.length === 0)) return `${text.slice(0, 40)} 被当成了同意`;
      }
      return true;
    });
    await check('B8. 带 BOM 的同意文件照样认（Windows 上手工改过的文件常见）', async () => {
      const dir = newDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(consentFileOf(dir), BOM + JSON.stringify({ version: 1, remote: true, at: 5 }));
      const m = make({ dir, pages: PAGES() });
      const listed = await m.market.list(Q());
      return (listed.consent.remote === true && listed.total === 10 && m.calls.length === 2) || JSON.stringify(listed.consent);
    });

    /* ================= C. 同意之后：读取、快照、缓存 ================= */
    section('C. 同意之后');

    await check('C1. 同意 → 写同意文件、读目录、回报快照（收录数与 npm 总数分开）', async () => {
      const m = make({ pages: PAGES(), total: 14112 });
      const r = await m.market.act({ action: 'consent' });
      return (same(r, {
        ok: true, consent: { remote: true }, loaded: true,
        snapshot: { state: 'fresh', at: T0, covered: 7, npmTotal: 14112, pages: 2, partial: false, refreshing: false, error: null },
      }) === true && same(JSON.parse(fs.readFileSync(consentFileOf(m.dir), 'utf8')), { version: 1, remote: true, at: T0 }) === true)
        || JSON.stringify(r);
    });
    await check('C2. 默认抓 4 页 × 250 条：地址、超时、限长都是固定的', async () => {
      const m = make({ pageCount: undefined, pageSize: undefined, net: net({ pages: [[row('only-one')], [], [], []] }) });
      const market = createExtensionMarket({ dataDir: m.dir, fetchJson: m.net.fetchJson, now: () => T0 });
      await market.act({ action: 'consent' });
      return (same(m.calls.map((call) => call.url), [
        'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=250',
        'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=250&from=250',
        'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=250&from=500',
        'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=250&from=750',
      ]) === true && m.calls.every((call) => same(call.opts, { timeoutMs: 8000, maxBytes: 2 * 1024 * 1024 }) === true)
        && same(market._internals.snapshotMeta(), { state: 'fresh', at: T0, covered: 1, npmTotal: 1, pages: 4, partial: false, refreshing: false, error: null }) === true)
        || JSON.stringify(m.calls);
    });
    await check('C3. 磁盘缓存：gzip、只有归一化后的条目、没有邮箱；数据目录里没有残留的临时文件', async () => {
      const m = await loaded();
      const raw = fs.readFileSync(cacheFileOf(m.dir));
      const cache = readCache(m.dir);
      const text = JSON.stringify(cache);
      return (raw[0] === 0x1f && raw[1] === 0x8b
        && same({ ...cache, items: cache.items.length }, { version: 1, at: T0, npmTotal: 14112, pages: 2, partial: false, items: 7 }) === true
        && !text.includes('secret-mail') && !text.includes('email') && !text.includes('publisher-bot@')
        && same(fs.readdirSync(m.dir).sort(), ['extension-market-catalog.json.gz', 'extension-market.json']) === true) || text.slice(0, 300);
    });
    await check('C4. 去重先到先得；名次 = 页序 × 页长 + 行序；不合格的行不进目录', async () => {
      const m = await loaded();
      const items = m.market._internals.catalogItems();
      const snapshotOnly = items.filter((item) => item.rank !== null).map((item) => [item.name, item.rank, item.version]);
      return (same(snapshotOnly, [
        ['pi-memory', 1, '0.4.2'], ['alpha-tools', 0, '1.0.0'], ['beta-agents', 2, '1.0.0'], ['@scope/gamma-web', 3, '1.0.0'],
        ['flagged-thing', 4, '1.0.0'], ['delta-notes', 8, '1.0.0'], ['epsilon-models', 9, null],
      ]) === true && !items.some((item) => item.name === 'Bad_Name' || item.name === 'no-keyword')) || JSON.stringify(snapshotOnly);
    });
    await check('C5. 内置条目在快照里有同名包时用快照那份（数据更全），推荐序里仍在前四个', async () => {
      const m = await loaded();
      const listed = await m.market.list(Q());
      const memory = listed.items.find((item) => item.name === 'pi-memory');
      return (same(names(listed), RECOMMENDED) === true && listed.total === 10 && listed.catalogTotal === 10
        && same(memory, wireOf('pi-memory', {
          version: '0.4.2', updatedAt: '2026-11-01T08:00:00.000Z', keywords: ['pi-package', 'memory'], tags: ['memory'],
          category: 'memory', downloadsMonthly: 9000, known: 'memory', rank: 1,
        })) === true) || JSON.stringify({ names: names(listed), memory });
    });
    await check('C6. 条目的线上形状：完整字段；内部用的 knownOrder 不出后端', async () => {
      const m = await loaded();
      const listed = await m.market.list(Q());
      const alpha = listed.items.find((item) => item.name === 'alpha-tools');
      return same(alpha, ALPHA()) === true ? listed.items.every((item) => !('knownOrder' in item)) || 'knownOrder 泄到了响应里' : same(alpha, ALPHA());
    });
    await check('C7. 重启后（新实例、同一个数据目录）：同意还在，目录来自磁盘缓存，不联网', async () => {
      const first = await loaded();
      const second = make({ dir: first.dir, pages: PAGES(), total: 14112 });
      const listed = await second.market.list(Q());
      return (second.calls.length === 0 && listed.consent.remote === true && same(names(listed), RECOMMENDED) === true
        && same(listed.snapshot, { state: 'fresh', at: T0, covered: 7, npmTotal: 14112, pages: 2, partial: false, refreshing: false, error: null }) === true
        && same(listed.items.find((item) => item.name === 'alpha-tools'), ALPHA()) === true) || JSON.stringify(listed.snapshot);
    });
    await check('C8. warm：已同意时只读磁盘缓存（给安装闸门与「已安装」页用），不联网', async () => {
      const first = await loaded();
      const second = make({ dir: first.dir, pages: PAGES() });
      const before = second.market.has('npm:alpha-tools');
      await second.market.warm();
      return (before === false && second.market.has('npm:alpha-tools') === true && second.market.flagged('npm:flagged-thing') === true
        && second.market.flagged('npm:alpha-tools') === false && second.market.latestVersion('alpha-tools') === '1.0.0'
        && second.market.latestVersion('epsilon-models') === null && second.market.latestVersion('nope') === null
        && same(second.market.status(), { remote: true, at: T0 }) === true && second.calls.length === 0) || JSON.stringify(second.market.status());
    });
    await check('C9. 同意写不了盘 → consent-write-failed：不联网，仍然是没有同意', async () => {
      const dir = newDir();
      fs.writeFileSync(dir, 'a file where the data directory should be');
      const m = make({ dir, pages: PAGES() });
      const r = await m.market.act({ action: 'consent' });
      const listed = await m.market.list(Q());
      return (r.ok === false && r.code === 'consent-write-failed' && listed.consent.remote === false && listed.total === 4 && m.calls.length === 0)
        || JSON.stringify(r);
    });
    await check('C10. 未知动作 / 形状不对的请求体 → unknown-action，不动任何状态', async () => {
      const m = make({ pages: PAGES() });
      const results = [];
      for (const body of [{ action: 'install' }, { action: 'toggle' }, { action: '__proto__' }, {}, null, 'consent', ['consent'], { action: ['consent'] }]) {
        results.push(await m.market.act(body));
      }
      return (results.every((r) => r.ok === false && r.code === 'unknown-action') && m.calls.length === 0 && !fs.existsSync(m.dir))
        || JSON.stringify(results);
    });

    /* ================= D. 查询：搜索 / 分类 / 排序 / 分页 ================= */
    section('D. 查询');

    const shared = await loaded();
    const list = (extra) => shared.market.list(Q(extra));

    await check('D1. 搜索：所有词都要命中，不分大小写；名称 / 简介 / 关键词 / 维护者都搜', async () => {
      const cases = [
        ['ALPHA git', ['alpha-tools']],
        ['alice', ['pi-memory', 'alpha-tools', '@scope/gamma-web', 'flagged-thing', 'epsilon-models']],
        ['publisher-bot', ['delta-notes']],
        ['web', ['pi-web-access', '@scope/gamma-web']],
        ['ollama', ['epsilon-models']],
        ['alpha missing', []],
        ['   ', RECOMMENDED],
      ];
      for (const [q, want] of cases) {
        const listed = await list({ q });
        const verdict = same(names(listed), want);
        if (verdict !== true) return `${q}: ${verdict}`;
        if (listed.total !== want.length) return `${q}: total=${listed.total}`;
      }
      return true;
    });
    await check('D2. 类别清单来自整份目录里真实出现过的类别；数字是当前搜索词下的命中数', async () => {
      const all = await list();
      const searched = await list({ q: 'web' });
      return (same(all.categories.map((c) => [c.id, c.count]), [
        ['all', 10], ['devtools', 1], ['agents', 2], ['productivity', 1], ['web', 3], ['memory', 1], ['models', 1], ['other', 1],
      ]) === true && same(searched.categories.map((c) => [c.id, c.count]), [
        ['all', 2], ['devtools', 0], ['agents', 0], ['productivity', 0], ['web', 2], ['memory', 0], ['models', 0], ['other', 0],
      ]) === true && !all.categories.some((c) => c.id === 'desktop' || c.id === 'integrations'))
        || JSON.stringify([all.categories, searched.categories]);
    });
    await check('D3. 类别筛选：total 是这个类别下的数量；catalogTotal 不变；类别计数不随所选类别变', async () => {
      const web = await list({ category: 'web' });
      const agents = await list({ category: 'agents', q: 'pi' });
      const empty = await list({ category: 'desktop' });
      return (same(names(web), ['pi-web-access', 'pi-browser-harness', '@scope/gamma-web']) === true && web.total === 3 && web.catalogTotal === 10
        && web.categories[0].count === 10 && same(names(agents), ['pi-subagents', 'beta-agents']) === true
        && empty.total === 0 && empty.items.length === 0 && empty.nextOffset === null && empty.query.category === 'desktop')
        || JSON.stringify([names(web), names(agents), empty.total]);
    });
    await check('D4. 按下载量：多的在前，同数按推荐序，未知的永远在最后（不当成 0）', async () => {
      const listed = await list({ sort: 'downloads' });
      return (listed.query.sort === 'downloads' && same(names(listed), ['pi-memory', 'epsilon-models', 'alpha-tools', '@scope/gamma-web', 'delta-notes',
        'flagged-thing', 'pi-web-access', 'pi-subagents', 'pi-browser-harness', 'beta-agents']) === true) || names(listed).join(',');
    });
    await check('D5. 按最新：新的在前，未知的在最后', async () => {
      const listed = await list({ sort: 'updated' });
      return same(names(listed), ['epsilon-models', 'beta-agents', 'pi-memory', 'delta-notes', 'alpha-tools', 'flagged-thing',
        'pi-web-access', 'pi-subagents', 'pi-browser-harness', '@scope/gamma-web']);
    });
    await check('D6. 按名称；有了数据之后四种排序都可用', async () => {
      const listed = await list({ sort: 'name' });
      return (same(names(listed), ['@scope/gamma-web', 'alpha-tools', 'beta-agents', 'delta-notes', 'epsilon-models', 'flagged-thing',
        'pi-browser-harness', 'pi-memory', 'pi-subagents', 'pi-web-access']) === true && listed.sorts.every((sort) => sort.available === true))
        || names(listed).join(',');
    });
    await check('D7. 分页：一批一批给，nextOffset 接得上；总数是真实的，不随翻页变', async () => {
      const first = await list({ limit: 4 });
      const second = await list({ limit: 4, offset: first.nextOffset });
      const third = await list({ limit: 4, offset: second.nextOffset });
      const beyond = await list({ limit: 4, offset: 50 });
      return (first.nextOffset === 4 && second.nextOffset === 8 && third.nextOffset === null && third.items.length === 2
        && same([...names(first), ...names(second), ...names(third)], RECOMMENDED) === true
        && [first, second, third, beyond].every((page) => page.total === 10 && page.catalogTotal === 10)
        && beyond.items.length === 0 && beyond.nextOffset === null && same(first.query, { q: '', category: 'all', sort: 'recommended', offset: 0, limit: 4 }) === true)
        || JSON.stringify([first.nextOffset, second.nextOffset, third.nextOffset]);
    });
    await check('D8. 搜索 + 类别 + 排序 + 分页叠在一起', async () => {
      const listed = await list({ q: 'alice', sort: 'downloads', limit: 2, offset: 2 });
      return (same(names(listed), ['alpha-tools', '@scope/gamma-web']) === true && listed.total === 5 && listed.nextOffset === 4) || names(listed).join(',');
    });
    await check('D9. 查询全程不联网（目录已在内存里）', () => shared.calls.length === 2 || shared.calls.length);

    /* ================= E. 缓存与时效 ================= */
    section('E. 缓存与时效');

    await check('E1. 快照过期：先用旧的立刻回，后台换新；换好之后是新的', async () => {
      const m = await loaded();
      m.clock.t += HOUR + 1;
      const release = m.net.hold();
      const stale = await m.market.list(Q());
      const during = { state: stale.snapshot.state, refreshing: stale.snapshot.refreshing, total: stale.total, calls: m.calls.length };
      release();
      await settle(m);
      const fresh = await m.market.list(Q());
      return (same(during, { state: 'stale', refreshing: true, total: 10, calls: 4 }) === true
        && fresh.snapshot.state === 'fresh' && fresh.snapshot.at === m.clock.t && fresh.snapshot.refreshing === false && m.calls.length === 4)
        || JSON.stringify({ during, after: fresh.snapshot });
    });
    await check('E2. 刚好没过期（恰好一小时）不刷新', async () => {
      const m = await loaded();
      m.clock.t += HOUR;
      const listed = await m.market.list(Q());
      return (listed.snapshot.state === 'fresh' && m.calls.length === 2) || JSON.stringify(listed.snapshot);
    });
    await check('E3. 后台刷新失败：继续用旧快照并带上错误；30 秒内不自动重试，到点才再试', async () => {
      const m = await loaded();
      m.clock.t += HOUR + 1;
      m.net.state.fail = () => ({ ok: false, code: 'timeout', error: '读取超时' });
      await m.market.list(Q());
      await settle(m);
      const after = await m.market.list(Q());
      const callsAfterFailure = m.calls.length;
      m.clock.t += 29999;
      await m.market.list(Q());
      await settle(m);
      const within = m.calls.length;
      m.clock.t += 1;
      await m.market.list(Q());
      await settle(m);
      return (after.snapshot.state === 'stale' && after.total === 10 && same(after.snapshot.error, { code: 'timeout', error: '读取超时' }) === true
        && after.snapshot.at === T0 && callsAfterFailure === 4 && within === 4 && m.calls.length === 6)
        || JSON.stringify({ snapshot: after.snapshot, callsAfterFailure, within, final: m.calls.length });
    });
    await check('E4. 手动刷新不受重试间隔限制；成功后错误清掉', async () => {
      const m = await loaded();
      m.net.state.fail = () => ({ ok: false, code: 'timeout', error: '读取超时' });
      const failed = await m.market.act({ action: 'refresh' });
      const again = await m.market.act({ action: 'refresh' });
      m.net.state.fail = null;
      m.clock.t += 5;
      const ok = await m.market.act({ action: 'refresh' });
      return (failed.ok === false && failed.code === 'timeout' && failed.error === '读取超时' && failed.consent.remote === true
        && failed.snapshot.state === 'fresh' && failed.snapshot.covered === 7 && same(failed.snapshot.error, { code: 'timeout', error: '读取超时' }) === true
        && again.ok === false && m.calls.length === 8
        && same(ok, { ok: true, consent: { remote: true }, snapshot: { state: 'fresh', at: T0 + 5, covered: 7, npmTotal: 14112, pages: 2, partial: false, refreshing: false, error: null } }) === true)
        || JSON.stringify({ failed, ok, calls: m.calls.length });
    });
    await check('E5. 从来没读到过目录：只剩内置条目并带上错误；重试间隔内再打开市场不重复请求', async () => {
      const m = make({ fail: () => ({ ok: false, code: 'proxy-required', error: '需要通过代理访问，请检查代理设置' }) });
      const consent = await m.market.act({ action: 'consent' });
      const listed = await m.market.list(Q());
      const within = m.calls.length;
      m.clock.t += 30000;
      await m.market.list(Q());
      return (same(consent, {
        ok: true, consent: { remote: true }, loaded: false,
        snapshot: { ...EMPTY_SNAPSHOT, error: { code: 'proxy-required', error: '需要通过代理访问，请检查代理设置' } },
      }) === true && listed.total === 4 && listed.consent.remote === true && listed.snapshot.error.code === 'proxy-required'
        && within === 2 && m.calls.length === 4 && !fs.existsSync(cacheFileOf(m.dir))) || JSON.stringify({ consent, within, calls: m.calls.length });
    });
    await check('E6. 缓存的时间戳在未来：五分钟以内接受，再远就当作没有缓存', async () => {
      const item = catalog.normalizeSearchObject(row('cached-thing'), 0);
      const near = grant(newDir());
      writeCache(near, { version: 1, at: T0 + 5 * 60 * 1000, npmTotal: 9, pages: 1, partial: false, items: [item] });
      const far = grant(newDir());
      writeCache(far, { version: 1, at: T0 + 5 * 60 * 1000 + 1, npmTotal: 9, pages: 1, partial: false, items: [item] });
      const a = make({ dir: near, pages: PAGES() });
      const b = make({ dir: far, pages: PAGES() });
      const listedA = await a.market.list(Q());
      const listedB = await b.market.list(Q());
      return (a.calls.length === 0 && listedA.snapshot.state === 'fresh' && listedA.snapshot.covered === 1 && a.market.has('npm:cached-thing')
        && b.calls.length === 2 && listedB.snapshot.covered === 7 && !b.market.has('npm:cached-thing')) || JSON.stringify([a.calls.length, b.calls.length]);
    });
    await check('E7. 缓存文件坏了 / 形状不对 / 太大 / 条目太多 / 没有可用条目 → 当作没有缓存，重新读', async () => {
      const item = catalog.normalizeSearchObject(row('cached-thing'), 0);
      const good = { version: 1, at: T0, npmTotal: 9, pages: 1, partial: false, items: [item] };
      const cases = {
        '不是 gzip': Buffer.from('plain text, not gzip'),
        'gzip 里不是 JSON': 'not json at all',
        '空文件': Buffer.alloc(0),
        '超过 4 MiB': Buffer.alloc(4 * 1024 * 1024 + 1),
        '版本不对': { ...good, version: 2 },
        '时间戳不是数字': { ...good, at: '1800000000000' },
        'items 不是数组': { ...good, items: { 0: item } },
        '顶层是数组': [good],
        '没有一条合格': { ...good, items: [{ name: 'Bad_Name', keywords: ['pi-package'] }, { name: 'nokw', keywords: [] }] },
        '超过 5000 条': { ...good, items: Array.from({ length: 5001 }, (_, index) => ({ name: `bulk-${index}`, keywords: ['pi-package'] })) },
      };
      for (const [label, data] of Object.entries(cases)) {
        const dir = grant(newDir());
        writeCache(dir, data);
        const m = make({ dir, pages: PAGES() });
        const listed = await m.market.list(Q());
        if (!(m.calls.length === 2 && listed.snapshot.covered === 7 && !m.market.has('npm:cached-thing') && !m.market.has('npm:bulk-0'))) {
          return `${label}：请求 ${m.calls.length} 次，收录 ${listed.snapshot.covered}`;
        }
      }
      return true;
    });
    await check('E8. 缓存里被改过的条目：读回来重新校验，改出来的字段不被采信', async () => {
      const dir = grant(newDir());
      writeCache(dir, {
        version: 1, at: T0, npmTotal: -1, pages: 0, partial: 'yes',
        items: [
          { name: 'tampered', keywords: ['pi-package', 'memory'], category: 'devtools', known: 'web', knownOrder: 0, flagged: 'yes',
            links: { npm: 'https://evil.example/', repository: 'javascript:alert(1)', homepage: 'http://insecure.example/' }, version: '9.9.9; x' },
          { name: '../escape', keywords: ['pi-package'] },
          { name: 'tampered', keywords: ['pi-package'], version: '6.6.6' },
        ],
      });
      const m = make({ dir });
      const listed = await m.market.list(Q({ q: 'tampered' }));
      return (m.calls.length === 0 && listed.total === 1
        && same(listed.items[0], wireOf('tampered', {
          description: null, version: null, maintainer: null, updatedAt: null, keywords: ['pi-package', 'memory'], tags: ['memory'], category: 'memory',
          downloadsMonthly: null, license: null, links: { npm: 'https://www.npmjs.com/package/tampered', repository: null, homepage: null },
        })) === true
        && same(listed.snapshot, { state: 'fresh', at: T0, covered: 1, npmTotal: null, pages: 1, partial: false, refreshing: false, error: null }) === true
        && !m.market.has('npm:../escape')) || JSON.stringify({ item: listed.items[0], snapshot: listed.snapshot });
    });
    await check('E9. 缓存记着「上次只读到一部分」：读回来仍然如实标 partial', async () => {
      const dir = grant(newDir());
      writeCache(dir, { version: 1, at: T0 - 1000, npmTotal: 777, pages: 3, partial: true, items: [catalog.normalizeSearchObject(row('cached-thing'), 0)] });
      const m = make({ dir });
      const listed = await m.market.list(Q());
      return same(listed.snapshot, { state: 'fresh', at: T0 - 1000, covered: 1, npmTotal: 777, pages: 3, partial: true, refreshing: false, error: null });
    });

    /* ================= F. 读取失败 ================= */
    section('F. 读取失败');

    const refreshWith = async (options) => {
      const m = granted(options);
      return { m, r: await m.market.act({ action: 'refresh' }) };
    };

    await check('F1. network 类错误：换成固定措辞，底层原文（可能带地址 / 代理凭据）不出后端', async () => {
      const raw = 'connect ECONNREFUSED 10.1.2.3:443 via http://user:pw@proxy.corp:8080';
      const { m, r } = await refreshWith({ fail: () => ({ ok: false, code: 'network', error: raw }) });
      const fixed = '无法连接 npm 目录（网络不可用或被拦截）';
      const listed = await m.market.list(Q());
      const text = JSON.stringify([r, listed]);
      return (same(r, { ok: false, code: 'network', error: fixed, consent: { remote: true }, snapshot: { ...EMPTY_SNAPSHOT, error: { code: 'network', error: fixed } } }) === true
        && !text.includes('10.1.2.3') && !text.includes('proxy.corp') && !text.includes('user:pw')) || text;
    });
    await check('F2. 其余错误码的文案本来就是固定句子：保留它的指引（清洗并限长）', async () => {
      const { r } = await refreshWith({ fail: () => ({ ok: false, code: 'timeout', error: '读取超时' + NUL + '，请稍后重试' + ZWSP + ' ' + 'x'.repeat(400) }) });
      return (r.code === 'timeout' && r.error.startsWith('读取超时 ，请稍后重试 x') && r.error.length === 240) || JSON.stringify(r);
    });
    await check('F3. 认不出的错误码 / 没有错误码 / 没有文案 → 一律按 network 处理', async () => {
      for (const failure of [
        { ok: false, code: 'Weird Code', error: 'x' }, { ok: false, code: 'x'.repeat(41), error: 'x' }, { ok: false, code: 42, error: 'x' },
        { ok: false, error: 'only text' }, { ok: false }, null, undefined, 'nope', { ok: 'true', data: { objects: [] } },
      ]) {
        const { r } = await refreshWith({ fail: () => failure || { ok: false } });
        if (!(r.ok === false && r.code === 'network' && r.error === '无法连接 npm 目录（网络不可用或被拦截）')) return `${JSON.stringify(failure)} → ${JSON.stringify(r)}`;
      }
      const { r } = await refreshWith({ fail: () => ({ ok: false, code: 'tls-failed' }) });
      return (r.code === 'tls-failed' && r.error === '读取 npm 目录失败') || JSON.stringify(r);
    });
    await check('F4. 网络层抛错 / 返回 null → network，不让异常冒出去', async () => {
      const thrown = await refreshWith({ fail: () => { throw new Error('socket hang up at 10.9.8.7'); } });
      const nulled = granted({ fetchJson: async () => null });
      const r2 = await nulled.market.act({ action: 'refresh' });
      return (thrown.r.code === 'network' && !JSON.stringify(thrown.r).includes('10.9.8.7') && r2.code === 'network') || JSON.stringify([thrown.r, r2]);
    });
    await check('F5. 没有受控网络层（这种运行方式）→ network-unavailable', async () => {
      const m = granted({ fetchJson: null });
      const r = await m.market.act({ action: 'refresh' });
      const listed = await m.market.list(Q());
      return (r.ok === false && r.code === 'network-unavailable' && listed.total === 4 && listed.snapshot.error.code === 'network-unavailable')
        || JSON.stringify(r);
    });
    await check('F6. 响应的形状不认识 → invalid-response', async () => {
      for (const data of [null, [], 'text', 42, {}, { objects: 'nope' }, { objects: null }, { total: 5 }]) {
        const m = granted({ fetchJson: async () => ({ ok: true, data }) });
        const r = await m.market.act({ action: 'refresh' });
        if (!(r.ok === false && r.code === 'invalid-response')) return `${JSON.stringify(data)} → ${JSON.stringify(r)}`;
      }
      return true;
    });
    await check('F7. 只读到一部分：读到的先用上，标 partial 并带上那一页的错误', async () => {
      const { m, r } = await refreshWith({
        pages: PAGES(), total: 14112,
        fail: (u) => (u.searchParams.get('from') ? { ok: false, code: 'timeout', error: '读取超时' } : null),
      });
      return (same(r, {
        ok: true, consent: { remote: true },
        snapshot: { state: 'fresh', at: T0, covered: 5, npmTotal: 14112, pages: 1, partial: true, refreshing: false, error: { code: 'timeout', error: '读取超时' } },
      }) === true && readCache(m.dir).partial === true && m.market.has('npm:alpha-tools') && !m.market.has('npm:delta-notes')) || JSON.stringify(r);
    });
    await check('F8. 第一页失败、第二页成功：名次仍按页序算；npm 总数取自第一张成功的页', async () => {
      const { m, r } = await refreshWith({
        pages: PAGES(), total: 14112,
        fail: (u) => (u.searchParams.get('from') ? null : { ok: false, code: 'timeout', error: '读取超时' }),
      });
      const ranks = m.market._internals.catalogItems().filter((item) => item.rank !== null).map((item) => [item.name, item.rank, item.version]);
      return (r.ok === true && r.snapshot.partial === true && r.snapshot.npmTotal === 14112 && r.snapshot.covered === 3
        && same(ranks, [['alpha-tools', 5, '9.9.9'], ['delta-notes', 8, '1.0.0'], ['epsilon-models', 9, null]]) === true) || JSON.stringify(ranks);
    });
    await check('F9. 请求都成功但没有一条合格的包 → 失败，旧快照不被一份空目录顶掉', async () => {
      const m = await loaded();
      m.net.state.pages = [[row('Bad_Name'), row('no-keyword', { keywords: [] })], []];
      const r = await m.market.act({ action: 'refresh' });
      const listed = await m.market.list(Q());
      const empty = await refreshWith({ pages: [[], []] });
      return (r.ok === false && r.code === 'invalid-response' && r.error === 'npm 目录没有返回任何可用的条目' && listed.total === 10
        && listed.snapshot.covered === 7 && empty.r.code === 'invalid-response') || JSON.stringify(r);
    });
    await check('F10. total 不是非负整数 → npm 总数是未知（null），不拿收录数冒充', async () => {
      const m = granted({ fetchJson: async () => ({ ok: true, data: { objects: [row('solo-pkg')], total: '14112' } }) });
      const r = await m.market.act({ action: 'refresh' });
      return (r.ok === true && r.snapshot.npmTotal === null && r.snapshot.covered === 1) || JSON.stringify(r);
    });
    await check('F11. 一页里超过页长的行被截掉（远端不能塞进比我们要的更多的东西）', async () => {
      const many = Array.from({ length: 9 }, (_, index) => row(`stuffed-${index}`));
      const m = granted({ fetchJson: async (url) => ({ ok: true, data: { objects: new URL(url).searchParams.get('from') ? [] : many, total: 9 } }) });
      const r = await m.market.act({ action: 'refresh' });
      return (r.snapshot.covered === 5 && m.market.has('npm:stuffed-4') && !m.market.has('npm:stuffed-5')) || JSON.stringify(r.snapshot);
    });

    /* ================= G. 撤回同意 ================= */
    section('G. 撤回同意');

    await check('G1. 撤回：快照、缓存文件、同意一起清掉；之后只有内置条目，不再联网', async () => {
      const m = await loaded({ manifests: { 'alpha-tools': manifest('alpha-tools', { version: '1.2.0' }) }, deep: [row('zeta-extra')] });
      await m.market.item('npm:alpha-tools');
      await m.market.list(Q({ q: 'zeta', deep: true }));
      const before = { calls: m.calls.length, pool: m.market.has('npm:zeta-extra'), latest: m.market.latestVersion('alpha-tools') };
      m.clock.t += 7;
      const r = await m.market.act({ action: 'revoke' });
      const listed = await m.market.list(Q({ q: 'zeta' }));
      const all = await m.market.list(Q());
      return (same(before, { calls: 4, pool: true, latest: '1.2.0' }) === true
        && same(r, { ok: true, consent: { remote: false }, snapshot: EMPTY_SNAPSHOT }) === true
        && same(JSON.parse(fs.readFileSync(consentFileOf(m.dir), 'utf8')), { version: 1, remote: false, at: T0 + 7 }) === true
        && !fs.existsSync(cacheFileOf(m.dir)) && listed.total === 0 && all.total === 4 && all.consent.remote === false
        && !m.market.has('npm:alpha-tools') && !m.market.has('npm:zeta-extra') && m.market.latestVersion('alpha-tools') === null
        && same(m.market.status(), { remote: false, at: null }) === true && m.calls.length === 4)
        || JSON.stringify({ before, r, calls: m.calls.length });
    });
    await check('G2. 撤回之后重启（新实例）：仍然是没有同意，不读缓存、不联网', async () => {
      const first = await loaded();
      await first.market.act({ action: 'revoke' });
      const second = make({ dir: first.dir, pages: PAGES() });
      const listed = await second.market.list(Q());
      return (listed.consent.remote === false && listed.total === 4 && second.calls.length === 0) || JSON.stringify(listed.consent);
    });
    await check('G3. 读取在飞的时候撤回：结果回来后整个作废，不留快照、不留缓存文件', async () => {
      const m = granted({ pages: PAGES(), total: 14112 });
      const release = m.net.hold();
      const pending = m.market.act({ action: 'refresh' });
      await until(() => m.calls.length >= 2, '第 2 次请求发出');
      await m.market.act({ action: 'revoke' });
      release();
      const r = await pending;
      const listed = await m.market.list(Q());
      return (r.ok === false && r.code === 'consent-required' && r.consent.remote === false && same(r.snapshot, EMPTY_SNAPSHOT) === true
        && listed.total === 4 && !fs.existsSync(cacheFileOf(m.dir)) && !m.market.has('npm:alpha-tools') && m.calls.length === 2)
        || JSON.stringify({ r, total: listed.total, cache: fs.existsSync(cacheFileOf(m.dir)) });
    });
    await check('G4. 撤回后马上又同意（旧读取还在飞）：另起一次新的读取，旧的那次不影响新的', async () => {
      const m = granted({ pages: PAGES(), total: 14112 });
      const release = m.net.hold();
      const old = m.market.act({ action: 'refresh' });
      await until(() => m.calls.length >= 2, '第 2 次请求发出');
      await m.market.act({ action: 'revoke' });
      const again = m.market.act({ action: 'consent' });
      await until(() => m.calls.length >= 4, '第 4 次请求发出');
      release();
      const [oldResult, newResult] = await Promise.all([old, again]);
      await settle(m);
      const listed = await m.market.list(Q());
      return (oldResult.ok === false && oldResult.code === 'consent-required' && newResult.ok === true && newResult.loaded === true
        && newResult.snapshot.covered === 7 && listed.total === 10 && listed.snapshot.refreshing === false && m.calls.length === 4
        && fs.existsSync(cacheFileOf(m.dir))) || JSON.stringify({ oldResult, newResult, calls: m.calls.length });
    });
    await check('G5. 清单在飞的时候撤回：不进详情缓存；响应里的同意状态以此刻为准', async () => {
      const m = await loaded({ manifests: { 'alpha-tools': manifest('alpha-tools', { version: '1.2.0' }) } });
      const release = m.net.hold();
      const pending = m.market.item('npm:alpha-tools');
      await until(() => m.calls.length >= 3, '第 3 次请求发出');
      await m.market.act({ action: 'revoke' });
      release();
      const r = await pending;
        return (r.ok === false && r.code === 'unknown-item'
          && m.market.status().remote === false && m.market.latestVersion('alpha-tools') === null) || JSON.stringify(r);
    });
    await check('G6. 深度搜索在飞的时候撤回：结果不进搜索池；响应如实是「没有同意」', async () => {
      const m = await loaded({ deep: [row('zeta-extra')] });
      const release = m.net.hold();
      const pending = m.market.list(Q({ q: 'zeta', deep: true }));
      await until(() => m.calls.length >= 3, '第 3 次请求发出');
      await m.market.act({ action: 'revoke' });
      release();
      const listed = await pending;
      return (same(listed.deep, { state: 'skipped', added: 0, error: null }) === true && listed.total === 0 && listed.consent.remote === false
        && !m.market.has('npm:zeta-extra')) || JSON.stringify({ deep: listed.deep, total: listed.total, consent: listed.consent });
    });
    await check('G6a. 启用请求在飞时撤回，旧 POST 不可重报同意', async () => {
      const m = make({ pages: PAGES() });
      const release = m.net.hold();
      const enabling = m.market.act({ action: 'consent' });
      await until(() => m.calls.length > 0, '目录请求发出');
      await m.market.act({ action: 'revoke' });
      release();
      const stale = await enabling;
      return (stale.ok === false && stale.consent.remote === false && m.market.status().remote === false) || JSON.stringify(stale);
    });
    await check('G6b. 等待基础目录期间撤回并重新同意，旧查询词不发往 npm', async () => {
      const m = granted({ pages: PAGES() });
      const release = m.net.hold();
      const previous = m.market.list(Q({ q: 'private-fixture-query', deep: true }));
      await until(() => m.calls.length > 0, '首次刷新开始');
      await m.market.act({ action: 'revoke' });
      const fresh = m.market.act({ action: 'consent' });
      release();
      const [result] = await Promise.all([previous, fresh]);
      return (result.deep?.state === 'skipped' && !m.calls.some(({ url }) => String(url).includes('private-fixture-query')))
        || JSON.stringify({ result, calls: m.calls });
    });
    await check('G7. 撤回写不了盘：这个进程照样不再联网，并如实说明没写成', async () => {
      const m = await loaded();
      fs.rmSync(m.dir, { recursive: true, force: true });
      fs.writeFileSync(m.dir, 'now a file');
      const r = await m.market.act({ action: 'revoke' });
      const listed = await m.market.list(Q());
      const refresh = await m.market.act({ action: 'refresh' });
      return (r.ok === false && r.code === 'consent-write-failed' && r.consent.remote === false && listed.total === 4
        && refresh.code === 'consent-required' && m.calls.length === 2) || JSON.stringify(r);
    });
    await check('G8. 撤回之后再同意：重新读取，一切照常', async () => {
      const m = await loaded();
      await m.market.act({ action: 'revoke' });
      m.clock.t += 100;
      const r = await m.market.act({ action: 'consent' });
      const listed = await m.market.list(Q());
      return (r.loaded === true && r.snapshot.at === T0 + 100 && listed.total === 10 && m.calls.length === 4 && fs.existsSync(cacheFileOf(m.dir)))
        || JSON.stringify(r);
    });
    await check('G9. 撤回落在「正在写缓存文件」的途中：不管先后，盘上都不留缓存文件，也不留临时文件', async () => {
      /* 写缓存要过三次真实的异步（压缩 / 写临时文件 / 改名），撤回可能落在任何一段。
       * 每一轮多让出几拍，让撤回落在不同的位置；正确的实现在任何时序下结论都一样。 */
      for (let round = 0; round < 6; round++) {
        const m = granted({ pages: PAGES(), total: 14112 });
        const pending = m.market.act({ action: 'refresh' });
        await until(() => m.market._internals.snapshotMeta().covered === 7, '新快照换上');
        for (let i = 0; i < round; i++) await tick();
        const revoked = await m.market.act({ action: 'revoke' });
        await pending;
        const left = fs.readdirSync(m.dir).sort();
        if (!(revoked.ok === true && same(left, ['extension-market.json']) === true && same(m.market.status(), { remote: false, at: null }) === true)) {
          return `第 ${round} 轮：${JSON.stringify(left)}`;
        }
      }
      return true;
    });

    /* ================= H. 深度搜索 ================= */
    section('H. 深度搜索（用户搜不到时显式触发）');

    const deepRows = () => [
      row('zeta-extra', { keywords: ['pi-package', 'zeta', 'macos'], monthly: 77 }),
      row('zeta-nokw', { keywords: ['zeta'] }),
      row('alpha-tools', { version: '5.0.0', description: 'zeta in the description' }),
      row('pi-memory', { description: 'zeta too' }),
      row('zeta-flagged', { keywords: ['pi-package', 'zeta'], insecure: true }),
      row('Zeta_Bad', { keywords: ['pi-package', 'zeta'] }),
    ];

    await check('H1. 一次远端搜索：固定带 keywords:pi-package 限定，50 条，固定的超时与限长', async () => {
      const m = await loaded({ deep: deepRows() });
      const listed = await m.market.list(Q({ q: 'zeta', deep: true }));
      const call = m.calls[2];
      return (m.calls.length === 3 && call.url === 'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package+zeta&size=50'
        && same(call.opts, { timeoutMs: 8000, maxBytes: 2 * 1024 * 1024 }) === true
        && same(listed.deep, { state: 'done', added: 2, error: null }) === true) || JSON.stringify({ url: call && call.url, deep: listed.deep });
    });
    await check('H2. 结果逐条验：没有 pi-package 关键词的、包名不合格的、目录里已有的都不进搜索池', async () => {
      const m = await loaded({ deep: deepRows() });
      const listed = await m.market.list(Q({ q: 'zeta', deep: true }));
      const alpha = (await m.market.list(Q({ q: 'alpha-tools' }))).items[0];
      return (same(names(listed), ['zeta-extra', 'zeta-flagged']) === true && listed.total === 2
        && !m.market.has('npm:zeta-nokw') && !m.market.has('npm:Zeta_Bad')
        /* 目录里已有的包不被搜索结果顶掉：版本与简介还是快照那份 */
        && alpha.version === '1.0.0' && alpha.description === 'alpha-tools for pi') || JSON.stringify({ names: names(listed), alpha });
    });
    await check('H3. 搜索池不算进目录：没有搜索词时不出现，catalogTotal 不变；有搜索词时不必再联网', async () => {
      const m = await loaded({ deep: deepRows() });
      const deep = await m.market.list(Q({ q: 'zeta', deep: true }));
      const plain = await m.market.list(Q());
      const again = await m.market.list(Q({ q: 'zeta' }));
      return (deep.catalogTotal === 10 && plain.total === 10 && plain.catalogTotal === 10 && !names(plain).includes('zeta-extra')
        && same(names(again), ['zeta-extra', 'zeta-flagged']) === true && again.deep === null && m.calls.length === 3)
        || JSON.stringify({ plain: plain.total, again: names(again), calls: m.calls.length });
    });
    await check('H4. 搜索池里的包有自己的类别可选；被 npm 标记的照样不给装', async () => {
      const m = await loaded({ deep: deepRows() });
      const listed = await m.market.list(Q({ q: 'zeta', deep: true }));
      const desktop = await m.market.list(Q({ q: 'zeta', category: 'desktop' }));
      const flagged = listed.items.find((item) => item.name === 'zeta-flagged');
      return (listed.categories.some((c) => c.id === 'desktop' && c.count === 1) && same(names(desktop), ['zeta-extra']) === true
        && same(flagged.install, { allowed: false, reason: 'npm 把这个包标记为不安全，Pi GUI 不提供安装' }) === true
        && m.market.has('npm:zeta-extra') && m.market.flagged('npm:zeta-flagged') && !m.market.flagged('npm:zeta-extra')
        && m.market.latestVersion('zeta-extra') === '1.0.0') || JSON.stringify({ categories: listed.categories, flagged });
    });
    await check('H5. 用户输入改写不了限定条件：冒号等符号在发出去之前就去掉了', async () => {
      const m = await loaded({ deep: () => [] });
      await m.market.list(Q({ q: 'foo author:evil not:insecure keywords:x', deep: true }));
      const text = new URL(m.calls[2].url).searchParams.get('text');
      return (text === 'keywords:pi-package foo author evil not insecure keywords x' && !text.slice('keywords:pi-package'.length).includes(':')) || text;
    });
    await check('H6. 不足两个字符不搜；没有搜索词不搜', async () => {
      const m = await loaded({ deep: deepRows() });
      const short = await m.market.list(Q({ q: 'z', deep: true }));
      const none = await m.market.list(Q({ q: '', deep: true }));
      return (same(short.deep, { state: 'skipped', added: 0, error: null }) === true && none.deep === null && m.calls.length === 2)
        || JSON.stringify([short.deep, none.deep, m.calls.length]);
    });
    await check('H7. 远端搜索失败：就地说明，本地结果照常给', async () => {
      const m = await loaded({ deep: deepRows() });
      m.net.state.fail = () => ({ ok: false, code: 'timeout', error: '读取超时' });
      const listed = await m.market.list(Q({ q: 'alpha', deep: true }));
      m.net.state.fail = null;
      m.net.state.deep = 'not rows';
      const bad = make({ dir: grant(newDir()), fetchJson: async (url) => (new URL(url).searchParams.get('text') === 'keywords:pi-package'
        ? { ok: true, data: { objects: [row('solo-pkg')], total: 1 } } : { ok: true, data: { objects: 'nope' } }) });
      const shaped = await bad.market.list(Q({ q: 'solo', deep: true }));
      return (listed.ok === true && same(listed.deep, { state: 'failed', added: 0, error: { code: 'timeout', error: '读取超时' } }) === true
        && same(names(listed), ['alpha-tools']) === true
        && same(shaped.deep, { state: 'failed', added: 0, error: { code: 'invalid-response', error: 'npm 搜索返回的数据形状不认识' } }) === true
        && same(names(shaped), ['solo-pkg']) === true) || JSON.stringify([listed.deep, shaped.deep]);
    });
    await check('H8. 重复搜到的不重复计数；搜索池有上限（500），最早的先被挤掉', async () => {
      let batch = 0;
      const m = await loaded({ deep: () => Array.from({ length: 50 }, (_, index) => row(`bulk-${batch}-${index}`, { keywords: ['pi-package', 'bulk'] })) });
      const first = await m.market.list(Q({ q: 'bulk', deep: true }));
      const repeat = await m.market.list(Q({ q: 'bulk', deep: true }));
      for (batch = 1; batch <= 10; batch++) await m.market.list(Q({ q: 'bulk', deep: true }));
      const listed = await m.market.list(Q({ q: 'bulk', limit: 48 }));
      return (first.deep.added === 50 && repeat.deep.added === 0 && listed.total === 500 && !m.market.has('npm:bulk-0-0') && m.market.has('npm:bulk-1-0')
        && m.market.has('npm:bulk-10-49') && listed.catalogTotal === 10 && listed.nextOffset === 48) || JSON.stringify({ total: listed.total });
    });
    await check('H9. 排序可不可用看的是此刻参与结果的全集：目录里没有下载量数据、搜到的包有 → 搜索时才可按下载量排', async () => {
      const m = make({
        pages: [[row('plain-one', { monthly: null, date: 'bad' }), row('plain-two', { monthly: null, date: 'bad' })], []],
        deep: [row('zeta-extra', { keywords: ['pi-package', 'zeta'], monthly: 77 })],
      });
      await m.market.act({ action: 'consent' });
      const usable = (listed) => listed.sorts.filter((sort) => sort.available).map((sort) => sort.id);
      const before = await m.market.list(Q({ sort: 'downloads' }));
      const searched = await m.market.list(Q({ q: 'zeta', deep: true, sort: 'downloads' }));
      const after = await m.market.list(Q({ sort: 'downloads' }));
      return (same(usable(before), ['recommended', 'name']) === true && before.query.sort === 'recommended'
        && same(usable(searched), ['recommended', 'downloads', 'updated', 'name']) === true && searched.query.sort === 'downloads'
        && same(names(searched), ['zeta-extra']) === true
        && same(usable(after), ['recommended', 'name']) === true && after.query.sort === 'recommended')
        || JSON.stringify([usable(before), usable(searched), usable(after)]);
    });

    /* ================= I. 详情 ================= */
    section('I. 详情（只在打开时读清单）');

    await check('I1. 读清单的地址、超时、限长都是固定的；带 scope 的包名里的 / 编码', async () => {
      const m = await loaded({ manifests: { 'alpha-tools': manifest('alpha-tools'), '@scope/gamma-web': manifest('@scope/gamma-web') } });
      await m.market.item('npm:alpha-tools');
      await m.market.item('npm:@scope/gamma-web');
      return (same(m.calls.slice(2).map((call) => call.url), [
        'https://registry.npmjs.org/alpha-tools/latest', 'https://registry.npmjs.org/@scope%2Fgamma-web/latest',
      ]) === true && m.calls.slice(2).every((call) => same(call.opts, { timeoutMs: 8000, maxBytes: 512 * 1024 }) === true)) || JSON.stringify(m.calls.slice(2));
    });
    await check('I2. 响应的完整形状：条目 + 清单里的事实 + 兼容性提示；脚本内容 / 邮箱 / 下载地址不出后端', async () => {
      const m = await loaded({ manifests: { 'alpha-tools': manifest('alpha-tools') } });
      const r = await m.market.item('npm:alpha-tools');
      const text = JSON.stringify(r);
      const verdict = same(r, {
        ok: true, consent: { remote: true }, source: SOURCE, item: ALPHA(), detail: detailOf('alpha-tools'),
        detailState: 'ok', detailError: null,
        compatibility: { status: 'compatible', peer: '@earendil-works/pi-coding-agent', range: '>=1.5.0', piVersion: '1.6.0', legacy: false },
        piVersion: '1.6.0',
      });
      return verdict === true ? (!text.includes('SECRET-SCRIPT') && !text.includes('secret-mail') && !text.includes('.tgz')) || '敏感内容出了后端' : verdict;
    });
    await check('I3. 同一个包同时打开两次只读一次；十分钟内再开不重读，过了再读', async () => {
      const m = await loaded({ manifests: { 'alpha-tools': manifest('alpha-tools') } });
      const release = m.net.hold();
      const a = m.market.item('npm:alpha-tools');
      const b = m.market.item('npm:alpha-tools');
      await until(() => m.calls.length >= 3, '第 3 次请求发出');
      await tick();
      const during = m.calls.length;
      release();
      const [ra, rb] = await Promise.all([a, b]);
      await m.market.item('npm:alpha-tools');
      m.clock.t += 10 * 60 * 1000;
      await m.market.item('npm:alpha-tools');
      const cached = m.calls.length;
      m.clock.t += 1;
      await m.market.item('npm:alpha-tools');
      return (during === 3 && ra.detailState === 'ok' && rb.detailState === 'ok' && cached === 3 && m.calls.length === 4)
        || JSON.stringify({ during, cached, final: m.calls.length });
    });
    await check('I4. 清单与这个包对不上（名字不同）→ 详情读取失败，条目本身照常给', async () => {
      const m = await loaded({ manifests: { 'alpha-tools': manifest('other-name') } });
      const r = await m.market.item('npm:alpha-tools');
      return (r.ok === true && r.detail === null && r.detailState === 'failed' && r.compatibility === null
        && same(r.detailError, { code: 'invalid-response', error: 'npm 返回的包清单与这个包对不上' }) === true
        && same(r.item, ALPHA()) === true) || JSON.stringify(r);
    });
    await check('I5. 读清单失败：就地说明；失败不进缓存，下次打开会重读', async () => {
      const m = await loaded({ manifests: {} });
      const first = await m.market.item('npm:alpha-tools');
      await m.market.item('npm:alpha-tools');
      return (first.detailState === 'failed' && same(first.detailError, { code: 'http-404', error: '目录里没有这个包' }) === true && m.calls.length === 4)
        || JSON.stringify(first);
    });
    await check('I6. 清单里的版本比快照新 → 条目、列表、latestVersion 都用它；刷新目录后以新快照为准', async () => {
      const installed = new Map([['alpha-tools', { installed: true, version: '1.0.0', scope: 'global', packageId: 'pkg_' + 'a'.repeat(20), pinned: false, canUpdate: true, canRemove: true }]]);
      const m = await loaded({ manifests: { 'alpha-tools': manifest('alpha-tools', { version: '1.2.0' }) }, readInstalled: () => installed });
      const before = (await m.market.list(Q({ q: 'alpha' }))).items[0];
      const r = await m.market.item('npm:alpha-tools');
      const after = (await m.market.list(Q({ q: 'alpha' }))).items[0];
      const latest = m.market.latestVersion('alpha-tools');
      await m.market.act({ action: 'refresh' });
      const refreshed = (await m.market.list(Q({ q: 'alpha' }))).items[0];
      return (before.version === '1.0.0' && before.updateAvailable === false && r.item.version === '1.2.0' && r.item.updateAvailable === true
        && after.version === '1.2.0' && after.updateAvailable === true && latest === '1.2.0'
        && refreshed.version === '1.0.0' && m.market.latestVersion('alpha-tools') === '1.0.0') || JSON.stringify({ before, after, latest, refreshed });
    });
    await check('I7. 不是任意 npm 包的查询代理：目录里没有、本机也没装的包 → unknown-item，不联网', async () => {
      const m = await loaded({ manifests: { 'left-pad': manifest('left-pad') } });
      const r = await m.market.item('npm:left-pad');
      return (same(r, { ok: false, code: 'unknown-item', error: '目录里没有这个扩展包' }) === true && m.calls.length === 2) || JSON.stringify(r);
    });
    await check('I8. 本机装着、但不在目录里的包：给得出详情（「已安装」页查最新版本用）', async () => {
      const installed = new Map([['private-ext', { installed: true, version: '0.9.0', scope: 'global', packageId: 'pkg_' + 'b'.repeat(20), pinned: false, canUpdate: true, canRemove: true }]]);
      const m = await loaded({ manifests: { 'private-ext': manifest('private-ext', { version: '1.1.0', peerDependencies: undefined }) }, readInstalled: () => installed });
      const r = await m.market.item('npm:private-ext');
      return (r.ok === true && r.detailState === 'ok' && r.item.version === '1.1.0' && r.item.description === null && r.item.rank === null
        && r.item.installed.state === 'installed' && r.item.installed.version === '0.9.0' && r.item.updateAvailable === true
        && r.item.install.allowed === false && r.compatibility.status === 'undeclared' && !m.market.has('npm:private-ext')) || JSON.stringify(r);
    });
    await check('I9. 形状不对的 id → bad-id，不联网', async () => {
      const m = await loaded({ manifests: { 'alpha-tools': manifest('alpha-tools') } });
      for (const id of ['alpha-tools', 'npm:Alpha', 'npm:alpha-tools@1.0.0', 'npm:../x', 'npm:', 'npm:alpha-tools/latest', 'npm:alpha-tools?x=1', null, undefined, 42]) {
        const r = await m.market.item(id);
        if (!(r.ok === false && r.code === 'bad-id')) return `${JSON.stringify(id)} → ${JSON.stringify(r)}`;
      }
      return m.calls.length === 2 || m.calls.length;
    });
    await check('I10. 读不到 Pi 的版本（抛错 / 形状不对）→ 兼容性是「未知」，不猜', async () => {
      const cases = [() => { throw new Error('x'); }, () => 'v1.6.0', () => null, () => 16, null];
      for (const readPiVersion of cases) {
        const m = await loaded({ manifests: { 'alpha-tools': manifest('alpha-tools') }, readPiVersion });
        const r = await m.market.item('npm:alpha-tools');
        if (!(r.piVersion === null && r.compatibility.status === 'unknown' && r.compatibility.piVersion === null)) return JSON.stringify(r.compatibility);
      }
      return true;
    });
    await check('I11. 详情缓存有上限（100 个），最久没读的先被挤掉', async () => {
      const bulk = Array.from({ length: 101 }, (_, index) => `bulk-${index}`);
      const m = make({
        pageCount: 1, pageSize: 200, pages: [bulk.map((name) => row(name))],
        manifests: Object.fromEntries(bulk.map((name) => [name, manifest(name)])),
      });
      await m.market.act({ action: 'consent' });
      for (const name of bulk) await m.market.item(`npm:${name}`);
      const afterAll = m.calls.length;
      await m.market.item('npm:bulk-100');
      const cached = m.calls.length;
      await m.market.item('npm:bulk-0');
      return (afterAll === 102 && cached === 102 && m.calls.length === 103) || JSON.stringify({ afterAll, cached, final: m.calls.length });
    });

    /* ================= J. 本机安装状态 ================= */
    section('J. 本机安装状态（只用读盘读到的事实）');

    const mine = (fields) => ({ installed: true, version: '1.0.0', scope: 'global', packageId: 'pkg_' + '1'.repeat(20), pinned: false, canUpdate: true, canRemove: true, ...fields });
    const listWith = async (entries, options = {}) => {
      const m = await loaded({ readInstalled: () => new Map(entries), ...options });
      const listed = await m.market.list(Q());
      return Object.fromEntries(listed.items.map((item) => [item.name, item]));
    };

    await check('J1. 装着的：installed + 版本 / 级别 / 清单 id / 是否固定 / 能不能更新与卸载', async () => {
      const items = await listWith([
        ['alpha-tools', mine({ version: '0.9.0' })],
        ['beta-agents', mine({ installed: null, version: null, packageId: 'pkg_' + '2'.repeat(20) })],
        ['delta-notes', mine({ scope: 'project', canUpdate: false, canRemove: false, packageId: 'pkg_' + '3'.repeat(20) })],
        ['epsilon-models', mine({ pinned: true, canUpdate: false, packageId: 'pkg_' + '4'.repeat(20) })],
      ]);
      return (same(items['alpha-tools'].installed, { state: 'installed', version: '0.9.0', scope: 'global', packageId: 'pkg_' + '1'.repeat(20), pinned: false, canUpdate: true, canRemove: true }) === true
        /* 登记了但托管目录里没读到文件：configured，不说成 installed */
        && same(items['beta-agents'].installed, { state: 'configured', version: null, scope: 'global', packageId: 'pkg_' + '2'.repeat(20), pinned: false, canUpdate: true, canRemove: true }) === true
        && same(items['delta-notes'].installed, { state: 'installed', version: '1.0.0', scope: 'project', packageId: 'pkg_' + '3'.repeat(20), pinned: false, canUpdate: false, canRemove: false }) === true
        && items['epsilon-models'].installed.pinned === true && items['epsilon-models'].installed.canUpdate === false
        && same(items['@scope/gamma-web'].installed, NONE) === true) || JSON.stringify(items['beta-agents'].installed);
    });
    await check('J2. 有没有更新：目录版本比本机新才是 true；任一边版本未知 → null；没装 → false', async () => {
      const items = await listWith([
        ['alpha-tools', mine({ version: '0.9.0' })],
        ['pi-memory', mine({ version: '0.4.2' })],
        ['beta-agents', mine({ version: '2.0.0' })],
        ['delta-notes', mine({ version: null })],
        ['epsilon-models', mine({ version: '1.0.0' })],
        ['@scope/gamma-web', mine({ version: '1.0.0-rc.1' })],
      ]);
      return same([
        items['alpha-tools'].updateAvailable, items['pi-memory'].updateAvailable, items['beta-agents'].updateAvailable,
        items['delta-notes'].updateAvailable, items['epsilon-models'].updateAvailable, items['@scope/gamma-web'].updateAvailable,
        items['flagged-thing'].updateAvailable,
      ], [true, false, false, null, null, true, false]);
    });
    await check('J3. 能不能装、为什么不能：已安装 / 项目已配置 / npm 标记不安全 / 没有官方 CLI 入口', async () => {
      const items = await listWith([['alpha-tools', mine()], ['delta-notes', mine({ scope: 'project' })], ['flagged-thing', mine()]]);
      const noCli = await listWith([], { operations: { available: () => false, isRunning: () => false } });
      const flagged = await listWith([]);
      return same([
        items['alpha-tools'].install, items['delta-notes'].install, items['flagged-thing'].install, items['beta-agents'].install,
        flagged['flagged-thing'].install, noCli['beta-agents'].install, noCli['flagged-thing'].install,
      ], [
        { allowed: false, reason: '已经安装' },
        { allowed: false, reason: '当前项目已配置这个包' },
        { allowed: false, reason: '已经安装' },
        { allowed: true, reason: '' },
        { allowed: false, reason: 'npm 把这个包标记为不安全，Pi GUI 不提供安装' },
        { allowed: false, reason: '当前这份 Pi 没有可证明的官方 CLI 入口，无法安装' },
        { allowed: false, reason: 'npm 把这个包标记为不安全，Pi GUI 不提供安装' },
      ]);
    });
    await check('J3a. 目录新版本不在所配范围内时保留未知，固定包无受控更新', async () => {
      const ranged = await listWith([['alpha-tools', mine({ version: '0.8.0', range: '^0.8.0' })]]);
      const fixed = await listWith([['alpha-tools', mine({ version: '0.8.0', pinned: true, canUpdate: false })]]);
      return (ranged['alpha-tools'].updateAvailable === null && fixed['alpha-tools'].updateAvailable === false) || { ranged, fixed };
    });
    await check('J3b. 深搜条目进入刷新后的目录时，计数和分页保留一份', async () => {
      const m = await loaded({ deep: [row('zeta-extra')] });
      await m.market.list(Q({ q: 'zeta', deep: true }));
      m.net.state.pages[0] = [...m.net.state.pages[0].slice(0, -1), row('zeta-extra')];
      await m.market.act({ action: 'refresh' });
      const listed = await m.market.list(Q({ q: 'zeta', limit: 1 }));
      return (listed.total === 1 && listed.nextOffset === null && listed.items[0]?.id === 'npm:zeta-extra') || JSON.stringify(listed);
    });
    await check('J4. 读安装状态抛错 / 给的不是 Map：按「没有安装信息」处理，目录照常给', async () => {
      for (const readInstalled of [() => { throw new Error('x'); }, () => ({ 'alpha-tools': mine() }), () => null, () => [['alpha-tools', mine()]]]) {
        const m = await loaded({ readInstalled });
        const listed = await m.market.list(Q());
        if (!(listed.ok === true && listed.total === 10 && listed.items.every((item) =>
          item.installed.state === 'unknown' && item.install.allowed === false))) return '安装信息异常时应保留目录并禁止操作';
      }
      return true;
    });
    await check('J5. 执行器的状态如实带出；判断不了（抛错）就当不可用 —— 不出现任何安装按钮', async () => {
      const running = await loaded({ operations: { available: () => true, isRunning: () => true } });
      const broken = await loaded({ operations: { available: () => { throw new Error('x'); }, isRunning: () => true } });
      const none = await loaded({ operations: null });
      const a = await running.market.list(Q());
      const b = await broken.market.list(Q());
      const c = await none.market.list(Q());
      return (same(a.operations, { available: true, running: true }) === true && same(b.operations, { available: false, running: false }) === true
        && same(c.operations, { available: false, running: false }) === true
        && b.items.every((item) => item.install.allowed === false) && c.items.every((item) => item.install.allowed === false))
        || JSON.stringify([a.operations, b.operations, c.operations]);
    });

    /* ================= K. 并发 ================= */
    section('K. 并发');

    await check('K1. 同时打开五次市场：目录只读一轮（单飞）', async () => {
      const m = granted({ pages: PAGES(), total: 14112 });
      const release = m.net.hold();
      const pending = Array.from({ length: 5 }, () => m.market.list(Q()));
      await until(() => m.calls.length >= 2, '第 2 次请求发出');
      await tick();
      await tick();
      const during = m.calls.length;
      release();
      const results = await Promise.all(pending);
      return (during === 2 && m.calls.length === 2 && results.every((listed) => listed.total === 10 && listed.snapshot.state === 'fresh'))
        || JSON.stringify({ during, final: m.calls.length });
    });
    await check('K2. 刷新在飞时再点刷新 / 再打开市场：都等同一轮，不叠加请求', async () => {
      const m = await loaded();
      const release = m.net.hold();
      const a = m.market.act({ action: 'refresh' });
      const b = m.market.act({ action: 'refresh' });
      const c = m.market.list(Q());
      await until(() => m.calls.length >= 4, '第 4 次请求发出');
      await tick();
      const during = m.calls.length;
      release();
      const [ra, rb, listed] = await Promise.all([a, b, c]);
      return (during === 4 && m.calls.length === 4 && ra.ok === true && rb.ok === true && listed.total === 10) || JSON.stringify({ during, final: m.calls.length });
    });
    await check('K3. 慢的旧查询与快的新查询互不串：各自的响应带着各自的查询条件', async () => {
      const m = await loaded({ deep: () => [] });
      const release = m.net.hold();
      const slow = m.market.list(Q({ q: 'alpha', deep: true }));
      await until(() => m.calls.length >= 3, '第 3 次请求发出');
      const fast = await m.market.list(Q({ q: 'beta' }));
      release();
      const late = await slow;
      return (same(names(fast), ['beta-agents']) === true && fast.query.q === 'beta' && same(names(late), ['alpha-tools']) === true && late.query.q === 'alpha')
        || JSON.stringify([fast.query, late.query]);
    });

    /* ================= L. HTTP 层 ================= */
    section('L. HTTP 层');

    const web = await loaded({ manifests: { 'alpha-tools': manifest('alpha-tools') } });
    const handle = web.market.handle;

    await check('L1. GET /api/extensions/market：查询参数经受控解析后回显', async () => {
      const res = await http(handle, 'GET', '/api/extensions/market?q=ALPHA&sort=name&category=devtools&limit=5');
      return (res.code === 200 && res.payload.ok === true && same(res.payload.query, { q: 'ALPHA', category: 'devtools', sort: 'name', offset: 0, limit: 5 }) === true
        && same(res.payload.items.map((item) => item.name), ['alpha-tools']) === true) || res.body.slice(0, 300);
    });
    await check('L2. 乱七八糟的查询参数不报错：认不出的回默认值，过大的夹到上限', async () => {
      const res = await http(handle, 'GET', '/api/extensions/market?category=__proto__&sort=hot&offset=-9&limit=100000&deep=yes&q=' + 'x'.repeat(500));
      return (res.code === 200 && same({ ...res.payload.query, q: res.payload.query.q.length }, { q: 64, category: 'all', sort: 'recommended', offset: 0, limit: 48 }) === true
        && res.payload.deep === null && res.payload.total === 0 && res.payload.items.length === 0) || JSON.stringify(res.payload.query);
    });
    await check('L3. GET /api/extensions/market/item?id=…：详情；只支持 GET', async () => {
      const ok = await http(handle, 'GET', '/api/extensions/market/item?id=npm:alpha-tools');
      const bad = await http(handle, 'GET', '/api/extensions/market/item?id=../../etc/passwd');
      const none = await http(handle, 'GET', '/api/extensions/market/item');
      const post = await http(handle, 'POST', '/api/extensions/market/item?id=npm:alpha-tools', '{}');
      return (ok.code === 200 && ok.payload.ok === true && ok.payload.detailState === 'ok' && bad.code === 200 && bad.payload.code === 'bad-id'
        && none.payload.code === 'bad-id' && post.code === 405 && post.payload.code === 'method-not-allowed') || [ok.code, bad.body, post.code].join(' ');
    });
    await check('L4. POST：同意 / 刷新 / 撤回 / 未知动作', async () => {
      const m = make({ pages: PAGES(), total: 14112 });
      const consent = await http(m.market.handle, 'POST', '/api/extensions/market', JSON.stringify({ action: 'consent' }));
      const refresh = await http(m.market.handle, 'POST', '/api/extensions/market', JSON.stringify({ action: 'refresh' }));
      const unknown = await http(m.market.handle, 'POST', '/api/extensions/market', JSON.stringify({ action: 'install', id: 'npm:alpha-tools' }));
      const revoke = await http(m.market.handle, 'POST', '/api/extensions/market', JSON.stringify({ action: 'revoke' }));
      const empty = await http(m.market.handle, 'POST', '/api/extensions/market');
      return (consent.code === 200 && consent.payload.loaded === true && refresh.payload.ok === true && unknown.code === 200
        && unknown.payload.code === 'unknown-action' && revoke.payload.consent.remote === false && empty.payload.code === 'unknown-action'
        && m.calls.length === 4) || [consent.body, refresh.body, unknown.body].join(' ').slice(0, 300);
    });
    await check('L5. POST 请求体不是合法 JSON / 超过 4 KiB → 400；不是对象 → unknown-action', async () => {
      const m = make({ pages: PAGES() });
      const broken = await http(m.market.handle, 'POST', '/api/extensions/market', '{not json');
      const big = await http(m.market.handle, 'POST', '/api/extensions/market', JSON.stringify({ action: 'consent', pad: 'x'.repeat(5000) }));
      const nulled = await http(m.market.handle, 'POST', '/api/extensions/market', 'null');
      const arr = await http(m.market.handle, 'POST', '/api/extensions/market', '["consent"]');
      return (broken.code === 400 && broken.payload.code === 'bad-body' && big.code === 400 && nulled.code === 200 && nulled.payload.code === 'unknown-action'
        && arr.payload.code === 'unknown-action' && m.calls.length === 0 && !fs.existsSync(m.dir)) || [broken.code, big.code, nulled.body].join(' ');
    });
    await check('L6. PUT / DELETE / PATCH → 405', async () => {
      for (const method of ['PUT', 'DELETE', 'PATCH']) {
        const res = await http(handle, method, '/api/extensions/market');
        if (!(res.code === 405 && res.payload.code === 'method-not-allowed')) return `${method} → ${res.code}`;
      }
      return true;
    });
    await check('L7. 内部抛错 → 200 + market-failed（界面不白屏；错误原文不出后端）', async () => {
      const exploding = { pathname: '/api/extensions/market', searchParams: { get: () => { throw new Error('boom at C:\\Users\\someone\\secret'); } } };
      const res = await http(handle, 'GET', exploding);
      return (res.code === 200 && same(res.payload, { ok: false, code: 'market-failed', error: '插件市场读取失败' }) === true) || res.body;
    });

    /* ================= M. 源码级约束与全局不变量 ================= */
    section('M. 源码级约束');

    const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const marketSource = strip(read('server/extension-market.js'));
    const catalogSource = strip(read('server/extension-market-catalog.js'));
    const importsOf = (text) => [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

    await check('M1. 归一化模块是纯的：除了安装器的包名规则，不引任何东西（没有 I/O）', () =>
      same(importsOf(catalogSource), ['./capability-install.js']) === true
        ? !/\bprocess\.|\bfs\.|require\(|import\(/.test(catalogSource) || '出现了 I/O'
        : same(importsOf(catalogSource), ['./capability-install.js']));
    await check('M2. 市场模块不自带网络、不起进程：联网只经注入的 fetchJson', () =>
      (same(importsOf(marketSource), ['node:fs', 'node:path', 'node:zlib', 'node:crypto', 'node:util', './http-utils.js', './extension-market-catalog.js']) === true
        && !/child_process|spawn\(|execFile|execSync|\bfetch\(|XMLHttpRequest|WebSocket|node:https?|node:net|node:dns|node:tls/.test(marketSource))
        || importsOf(marketSource).join(','));
    await check('M3. 两个模块都不读邮箱字段', () =>
      (!/\.email\b|\['email'\]|"email"/.test(marketSource) && !/\.email\b|\['email'\]|"email"/.test(catalogSource)) || '读了邮箱');
    await check('M4. 市场模块写盘只写自己数据目录里的那两个文件（及它们的临时文件）', () => {
      const targets = [...marketSource.matchAll(/fs\.(?:promises\.)?(?:writeFile|writeFileSync|rename|renameSync|rm|rmSync|mkdir|mkdirSync)\(\s*([A-Za-z]+)/g)].map((m) => m[1]);
      const allowed = new Set(['tmp', 'dir', 'file', 'cacheFile', 'consentFile']);
      return (targets.length >= 6 && targets.every((name) => allowed.has(name))
        && /const consentFile = path\.join\(dataDir, 'extension-market\.json'\)/.test(marketSource)
        && /const cacheFile = path\.join\(dataDir, 'extension-market-catalog\.json\.gz'\)/.test(marketSource)) || targets.join(',');
    });
    await check('M5. 市场模块不装任何东西：没有安装 / 卸载 / 更新的入口', () =>
      !/startOperation|buildInstallArgs|buildRemoveArgs|buildUpdateArgs|runInstall|packageOperation/.test(marketSource) || '市场模块碰了安装器');
    await check('M6. 整套测试发出去的每一个地址都在 registry.npmjs.org 上，且只有搜索与读清单两种', () => {
      const odd = ALL_URLS.filter((url) => !/^https:\/\/registry\.npmjs\.org\/(?:-\/v1\/search\?text=keywords%3Api-package[^#]*|(?:@[a-z0-9._-]+%2F)?[a-z0-9._-]+\/latest)$/.test(url));
      return (ALL_URLS.length > 100 && odd.length === 0) || JSON.stringify(odd.slice(0, 5));
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
