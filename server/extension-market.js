/* Extension 插件市场：目录的读取、缓存与查询。
 *
 * 这个模块**只读目录**。它不安装任何东西 —— 安装 / 卸载 / 更新在
 * `extension-packages.js`，最终只经 `capability-install.js` 调 Pi 官方 CLI。
 * 这里对安装链路的唯一作用是回答「这个 id 是不是目录里真有的包」（`has`）。
 *
 * ---------- 目录由三部分拼成 ----------
 *
 *   1. **内置**：Pi GUI 自己维护的四个已知能力。离线、没同意联网时也在。
 *   2. **远端快照**：npm registry 上带 `pi-package` 关键词的包，取搜索排序靠前的
 *      `pages × pageSize`（默认 4 × 250）条。npm 上这样的包有一万多个且无法整份
 *      枚举（见 `extension-market-catalog.js` 的说明），所以快照**不是全集**，
 *      响应里同时给出「收录了多少」与「npm 上共多少」。
 *   3. **深度搜索池**：用户搜不到时显式触发的一次远端搜索的结果，只在有搜索词时
 *      参与结果，不计入目录总数。
 *
 * ---------- 联网的边界 ----------
 *
 *   - **必须先有用户同意**。同意记在 `<dataDir>/extension-market.json`；没有同意
 *     就只有内置条目，绝不发任何请求。撤回同意会同时清掉快照、缓存文件、
 *     搜索池与详情缓存。
 *   - **没有预取**：启动时、后台、打开「已安装」页都不联网。只有打开插件市场
 *     （或用户点刷新 / 深度搜索 / 打开详情）才会读远端。
 *   - 网络层是注入的：生产环境用 MCP 市场那一套（HTTPS:443、DNS 结果固定、
 *     不跟随重定向、系统代理 / PAC / fake-IP 判定、响应限长限时），
 *     所以代理与内网规则与 MCP 市场完全一致，不另起一套。
 *   - 失败就地降级：有旧快照就继续用旧的并带上错误；没有就只剩内置条目。
 *     失败后 `retryMs` 内不自动重试（手动刷新不受这个限制）。
 *
 * ---------- 不存什么 ----------
 *
 *   维护者邮箱、原始响应、下载地址都不落盘也不出后端；缓存里只有归一化后的条目，
 *   读回来还会按不可信输入重新校验一遍。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { json, readBody } from './http-utils.js';
import {
  GALLERY_URL, builtinMarketItems, emptyMarketItem, normalizeSearchObject, reviveCatalogItem, normalizeManifest,
  parseMarketQuery, searchTokens, matchesTokens, sortMarketItems, availableSorts, categoryCounts,
  searchUrl, manifestUrl, deepSearchText, nameOfMarketId, compatibility, compareSemver, cleanText, cleanVersion, satisfiesRange,
} from './extension-market-catalog.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const CACHE_MAX_BYTES = 4 * 1024 * 1024;
const CACHE_MAX_SKEW_MS = 5 * 60 * 1000;
const CONSENT_MAX_BYTES = 4096;
const SEARCH_MAX_BYTES = 2 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 512 * 1024;
const MAX_ITEMS = 5000;
const MAX_POOL = 500;
const MAX_DETAILS = 100;
const DEEP_PAGE_SIZE = 50;

const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const codeError = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

const SOURCE = Object.freeze({
  id: 'npm-pi-package',
  label: 'npm 上带 pi-package 关键词的包',
  host: 'registry.npmjs.org',
  gallery: GALLERY_URL,
});

/**
 * @param dataDir        Pi GUI 自己的数据目录（同意记录与目录缓存放这里）
 * @param fetchJson      (url, { timeoutMs, maxBytes }) => {ok:true,data} | {ok:false,code,error}
 *                       —— 受控的 HTTPS JSON 读取（见上面的「联网的边界」）
 * @param readPiVersion  () => 当前 Pi 的版本号或 null（兼容性提示用）
 * @param readInstalled  () => Map<包名, 已安装摘要> | null（由 extension-packages 提供）
 * @param operations     { available(), isRunning() } —— 受控包操作执行器
 */
export function createExtensionMarket({
  dataDir,
  fetchJson = null,
  now = () => Date.now(),
  readPiVersion = null,
  readInstalled = null,
  canManage = null,
  operations = null,
  ttlMs = 60 * 60 * 1000,
  retryMs = 30 * 1000,
  pages = 4,
  pageSize = 250,
  pageTimeoutMs = 8000,
  detailTtlMs = 10 * 60 * 1000,
} = {}) {
  const consentFile = path.join(dataDir, 'extension-market.json');
  const cacheFile = path.join(dataDir, 'extension-market-catalog.json.gz');
  const builtins = new Map(builtinMarketItems().map((item) => [item.id, item]));

  /** null = 还没读过盘；之后是布尔。 */
  let consent = null;
  /** { at, items: Map<id,item>, npmTotal, pages, partial, skipped } | null */
  let snapshot = null;
  let cacheLoad = null;
  let refreshing = null;
  let lastAttemptAt = null;
  let lastError = null;
  /* 撤回同意时自增：在飞的请求回来后发现 epoch 变了，就把结果整个丢掉。 */
  let epoch = 0;
  let merged = null;
  const pool = new Map();
  const details = new Map();
  const detailFlights = new Map();

  /* ---------------- 同意 ---------------- */

  function loadConsent() {
    if (consent !== null) return consent;
    consent = false;
    try {
      const stat = fs.statSync(consentFile);
      if (stat.isFile() && stat.size <= CONSENT_MAX_BYTES) {
        const data = JSON.parse(fs.readFileSync(consentFile, 'utf8').replace(/^\ufeff/, ''));
        consent = isRecord(data) && data.version === 1 && data.remote === true;
      }
    } catch {
      /* 没有文件 / 读不了 / 不是 JSON：一律当作「没有同意」。 */
    }
    return consent;
  }

  function writeConsent(remote) {
    const dir = path.dirname(consentFile);
    const tmp = path.join(dir, `.${path.basename(consentFile)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, remote, at: now() }), { mode: 0o600 });
      fs.renameSync(tmp, consentFile);
      return true;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 临时文件清不掉不改变结论 */
      }
      return false;
    }
  }

  function forget() {
    epoch += 1;
    snapshot = null;
    merged = null;
    cacheLoad = null;
    /* 在飞的读取不再算数（它们回来时会发现 epoch 变了）；重新同意后要能立刻另起一次。 */
    refreshing = null;
    lastAttemptAt = null;
    lastError = null;
    pool.clear();
    details.clear();
    detailFlights.clear();
  }

  async function revoke() {
    /* 先让内存里的同意失效，再写盘：哪怕写盘失败，这个进程也不会再联网。 */
    consent = false;
    forget();
    const saved = writeConsent(false);
    try {
      await fs.promises.rm(cacheFile, { force: true });
    } catch {
      /* 缓存文件删不掉：下次读到它之前仍要先过同意这一关 */
    }
    return saved ? { ok: true } : codeError('consent-write-failed', '已停止读取在线目录，但没能把这个选择写入磁盘；重启后可能需要再撤回一次');
  }

  /* ---------------- 磁盘缓存 ---------------- */

  async function readCacheFile() {
    try {
      const stat = await fs.promises.stat(cacheFile);
      if (!stat.isFile() || stat.size <= 0 || stat.size > CACHE_MAX_BYTES) return null;
      const data = JSON.parse((await gunzip(await fs.promises.readFile(cacheFile))).toString('utf8'));
      if (!isRecord(data) || data.version !== 1 || !Number.isFinite(data.at) || !Array.isArray(data.items)) return null;
      if (data.items.length > MAX_ITEMS || data.at - now() > CACHE_MAX_SKEW_MS) return null;
      const items = new Map();
      for (const raw of data.items) {
        const item = reviveCatalogItem(raw);
        if (item && !items.has(item.id)) items.set(item.id, item);
      }
      if (!items.size) return null;
      return {
        at: data.at,
        items,
        npmTotal: Number.isSafeInteger(data.npmTotal) && data.npmTotal >= 0 ? data.npmTotal : null,
        pages: Number.isSafeInteger(data.pages) && data.pages > 0 ? data.pages : 1,
        partial: data.partial === true,
        skipped: 0,
      };
    } catch {
      /* 缓存是可再生的：任何解析 / 形状 / 时钟异常都按「没有缓存」处理。 */
      return null;
    }
  }

  /** `mine` 是开始读取时的 epoch：中途撤回了同意，就不留下（也不留住）缓存文件。 */
  async function writeCacheFile(snap, mine) {
    const drop = async (file) => {
      try {
        await fs.promises.rm(file, { force: true });
      } catch {
        /* 清不掉不改变结论：读它之前仍要先过同意这一关 */
      }
    };
    try {
      const text = JSON.stringify({
        version: 1,
        at: snap.at,
        npmTotal: snap.npmTotal,
        pages: snap.pages,
        partial: snap.partial,
        items: [...snap.items.values()],
      });
      const packed = await gzip(Buffer.from(text, 'utf8'), { level: zlib.constants.Z_BEST_SPEED });
      if (packed.length > CACHE_MAX_BYTES || mine !== epoch) return false;
      const dir = path.dirname(cacheFile);
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = path.join(dir, `.${path.basename(cacheFile)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
      try {
        await fs.promises.writeFile(tmp, packed, { mode: 0o600 });
        if (mine !== epoch) {
          await drop(tmp);
          return false;
        }
        await fs.promises.rename(tmp, cacheFile);
      } catch {
        await drop(tmp);
        return false;
      }
      /* 撤回恰好发生在改名期间：它删文件与这里落文件谁先谁后不确定，再删一次。 */
      if (mine !== epoch) {
        await drop(cacheFile);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 同意之后才读缓存；只读一次（撤回同意会重置）。不联网。 */
  function ensureCache() {
    if (!loadConsent()) return Promise.resolve();
    if (!cacheLoad) {
      const mine = epoch;
      cacheLoad = readCacheFile().then((cached) => {
        if (mine === epoch && cached && !snapshot) {
          snapshot = cached;
          merged = null;
        }
      });
    }
    return cacheLoad;
  }

  /* ---------------- 远端读取 ---------------- */

  function failureOf(result) {
    const code = result && typeof result.code === 'string' && /^[a-z0-9-]{1,40}$/.test(result.code) ? result.code : 'network';
    /* `network` 的上游文案里带着底层错误原文（可能有地址）；这里换成固定措辞。
     * 其余 code 的文案本来就是固定句子（代理 / 超时 / 限长…），保留它们的指引。 */
    const error = code === 'network' ? '无法连接 npm 目录（网络不可用或被拦截）'
      : cleanText(result && result.error, 240) || '读取 npm 目录失败';
    return { code, error };
  }

  const NO_CONSENT = Object.freeze({ code: 'consent-required', error: '还没有同意读取在线目录' });

  /**
   * **所有**远端读取都从这里出去，所以同意在这里再验一次：调用方先查过同意、
   * 中间隔了一次 await、这期间用户撤回了 —— 这种情况也发不出请求。
   */
  async function safeFetch(url, options) {
    if (!loadConsent()) return { ok: false, ...NO_CONSENT };
    if (typeof fetchJson !== 'function') {
      return codeError('network-unavailable', '当前运行方式没有可用的受控网络层，无法读取在线目录');
    }
    try {
      const result = await fetchJson(url, options);
      if (result && result.ok === true) return result;
      return { ok: false, ...failureOf(result) };
    } catch {
      return { ok: false, ...failureOf(null) };
    }
  }

  async function fetchPage(index) {
    const fetched = await safeFetch(searchUrl({ size: pageSize, from: index * pageSize }), {
      timeoutMs: pageTimeoutMs,
      maxBytes: SEARCH_MAX_BYTES,
    });
    if (!fetched.ok) return fetched;
    const data = fetched.data;
    if (!isRecord(data) || !Array.isArray(data.objects)) return codeError('invalid-response', 'npm 目录返回的数据形状不认识');
    return {
      ok: true,
      rows: data.objects.slice(0, pageSize),
      total: Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : null,
    };
  }

  /**
   * 重新抓一份快照。单飞；至少成功一页才替换旧快照（部分成功会标 `partial`）。
   * 一页都没成功就保留旧快照，只记下错误。
   */
  function refresh() {
    if (!loadConsent()) return Promise.resolve({ ok: false, ...NO_CONSENT });
    if (refreshing) return refreshing;
    const mine = epoch;
    const flight = (async () => {
      lastAttemptAt = now();
      const results = await Promise.all(Array.from({ length: pages }, (_, index) => fetchPage(index)));
      if (mine !== epoch) return codeError('consent-required', '已撤回同意，这次读取作废');
      const items = new Map();
      let skipped = 0;
      let okPages = 0;
      let npmTotal = null;
      let firstError = null;
      results.forEach((result, pageIndex) => {
        if (!result.ok) {
          if (!firstError) firstError = { code: result.code, error: result.error };
          return;
        }
        okPages += 1;
        if (npmTotal === null) npmTotal = result.total;
        result.rows.forEach((row, rowIndex) => {
          const item = normalizeSearchObject(row, pageIndex * pageSize + rowIndex);
          if (!item) skipped += 1;
          else if (!items.has(item.id)) items.set(item.id, item);
        });
      });
      if (!okPages || !items.size) {
        lastError = firstError || { code: 'invalid-response', error: 'npm 目录没有返回任何可用的条目' };
        return { ok: false, ...lastError };
      }
      snapshot = { at: now(), items, npmTotal, pages: okPages, partial: okPages < pages, skipped };
      merged = null;
      lastError = firstError;
      /* 新快照里的版本号比详情缓存新：让「有没有更新」以这次读取为准。 */
      details.clear();
      await writeCacheFile(snapshot, mine);
      return { ok: true };
    })().finally(() => {
      /* 撤回之后可能已经另起了一次读取：只清自己这一次。 */
      if (refreshing === flight) refreshing = null;
    });
    refreshing = flight;
    return flight;
  }

  const canRetry = () => lastAttemptAt === null || now() - lastAttemptAt >= retryMs;

  /** 打开市场时的加载策略：没有快照就等一次；过期就先用旧的、后台换新。 */
  async function ensureCatalog() {
    if (!loadConsent()) return;
    await ensureCache();
    if (!snapshot) {
      if (refreshing || canRetry()) await refresh();
      return;
    }
    if (now() - snapshot.at > ttlMs && !refreshing && canRetry()) {
      refresh().catch(() => {});
    }
  }

  async function deepSearch(q) {
    const text = deepSearchText(q);
    if (!text) return { state: 'skipped', added: 0, error: null };
    const mine = epoch;
    const fetched = await safeFetch(searchUrl({ text, size: DEEP_PAGE_SIZE }), { timeoutMs: pageTimeoutMs, maxBytes: SEARCH_MAX_BYTES });
    if (mine !== epoch) return { state: 'skipped', added: 0, error: null };
    if (!fetched.ok) return { state: 'failed', added: 0, error: { code: fetched.code, error: fetched.error } };
    const rows = isRecord(fetched.data) && Array.isArray(fetched.data.objects) ? fetched.data.objects.slice(0, DEEP_PAGE_SIZE) : null;
    if (!rows) return { state: 'failed', added: 0, error: { code: 'invalid-response', error: 'npm 搜索返回的数据形状不认识' } };
    let added = 0;
    for (const row of rows) {
      /* 远端按我们固定的 `keywords:pi-package` 限定搜；结果仍逐条验关键词，
       * 不信任「搜出来的就一定是 Pi 包」。 */
      const item = normalizeSearchObject(row, null);
      if (!item || builtins.has(item.id) || (snapshot && snapshot.items.has(item.id))) continue;
      if (!pool.has(item.id)) added += 1;
      pool.delete(item.id);
      pool.set(item.id, item);
    }
    while (pool.size > MAX_POOL) pool.delete(pool.keys().next().value);
    return { state: 'done', added, error: null };
  }

  async function manifestOf(name) {
    const id = `npm:${name}`;
    const hit = details.get(id);
    if (hit && now() - hit.at <= detailTtlMs) return { ok: true, detail: hit.detail };
    const flying = detailFlights.get(id);
    if (flying) return flying;
    const mine = epoch;
    const flight = (async () => {
      const fetched = await safeFetch(manifestUrl(name), { timeoutMs: pageTimeoutMs, maxBytes: MANIFEST_MAX_BYTES });
      if (mine !== epoch) return codeError('consent-required', '已撤回同意，这次读取作废');
      if (!fetched.ok) return fetched;
      const detail = normalizeManifest(fetched.data, name);
      if (!detail) return codeError('invalid-response', 'npm 返回的包清单与这个包对不上');
      details.delete(id);
      details.set(id, { at: now(), detail });
      while (details.size > MAX_DETAILS) details.delete(details.keys().next().value);
      return { ok: true, detail };
    })().finally(() => {
      if (detailFlights.get(id) === flight) detailFlights.delete(id);
    });
    detailFlights.set(id, flight);
    return flight;
  }

  /* ---------------- 查询 ---------------- */

  /** 内置 ∪ 快照。内置条目在快照里有同名包时，用快照那份（数据更全）。 */
  function catalogItems() {
    if (merged && merged.snapshot === snapshot) return merged.items;
    const items = [];
    for (const [id, item] of builtins) items.push((snapshot && snapshot.items.get(id)) || item);
    if (snapshot) for (const [id, item] of snapshot.items) if (!builtins.has(id)) items.push(item);
    merged = { snapshot, items };
    return items;
  }

  const find = (id) => (snapshot && snapshot.items.get(id)) || pool.get(id) || builtins.get(id) || null;

  function installedMap() {
    if (typeof readInstalled !== 'function') return null;
    try {
      const map = readInstalled();
      return map instanceof Map ? map : null;
    } catch {
      return null;
    }
  }

  function operationsMeta() {
    let available = false;
    let running = false;
    try {
      available = Boolean(operations && operations.available && operations.available());
      running = Boolean(operations && operations.isRunning && operations.isRunning());
      if (canManage && !canManage()) return { available: false, running, reason: 'Pi 的用户配置目录当前无法安全管理，包操作不可用' };
    } catch {
      /* 判断不了就当不可用：不出现任何操作按钮 */
    }
    return { available, running };
  }

  /** 目录条目 + 本机安装状态（**只有读盘读到的事实**；没装就是 none）。 */
  function present(item, installed, ops) {
    const mine = installed ? installed.get(item.name) || null : null;
    const { knownOrder: _knownOrder, ...wire } = item;
    let install = { allowed: false, reason: '' };
    if (!installed) install.reason = '无法读取完整的 Pi 包配置，请刷新后重试';
    else if (mine) install.reason = mine.scope === 'project' ? '当前项目已配置这个包'
      : mine.installed === true ? '已经安装' : '这个包已在配置里登记';
    else if (item.flagged) install.reason = 'npm 把这个包标记为不安全，Pi GUI 不提供安装';
    else if (!ops.available) install.reason = ops.reason || '当前这份 Pi 没有可证明的官方 CLI 入口，无法安装';
    else install = { allowed: true, reason: '' };
    const newer = mine?.version && item.version ? compareSemver(item.version, mine.version) === 1 : null;
    const updateAvailable = !installed ? null : !mine ? false
      : newer !== true ? newer
        : mine.canUpdate !== true || item.flagged ? false
          : Object.hasOwn(mine, 'range') && satisfiesRange(item.version, mine.range) !== true ? null : true;
    return {
      ...wire,
      installed: mine
        ? {
          /* installed：托管目录里读到了它；configured：settings 里登记了但没读到文件。 */
          state: mine.installed === true ? 'installed' : 'configured',
          version: mine.version || null,
          scope: mine.scope,
          packageId: mine.packageId,
          pinned: mine.pinned,
          canUpdate: mine.canUpdate === true,
          canRemove: mine.canRemove === true,
        }
        : { state: installed ? 'none' : 'unknown', version: null, scope: null, packageId: null, pinned: null, canUpdate: false, canRemove: false },
      /* 目录版本比本机新才算有更新；任一边版本未知 → null（未知），不猜。 */
      updateAvailable,
      install,
    };
  }

  function snapshotMeta() {
    return {
      state: !snapshot ? 'none' : now() - snapshot.at > ttlMs ? 'stale' : 'fresh',
      at: snapshot ? snapshot.at : null,
      covered: snapshot ? snapshot.items.size : 0,
      npmTotal: snapshot ? snapshot.npmTotal : null,
      pages: snapshot ? snapshot.pages : 0,
      partial: Boolean(snapshot && snapshot.partial),
      refreshing: Boolean(refreshing),
      error: lastError ? { code: lastError.code, error: lastError.error } : null,
    };
  }

  async function list(query) {
    const queryEpoch = epoch;
    await ensureCatalog();
    let deep = null;
    if (query.deep && query.q) {
      deep = queryEpoch !== epoch ? { state: 'skipped', added: 0, error: null }
        : loadConsent() ? await deepSearch(query.q) : { state: 'failed', added: 0, error: { ...NO_CONSENT } };
    }
    /* 上面两步都可能等过网络：同意以**此刻**为准（等的时候可能已被撤回）。 */
    const remote = loadConsent();
    const catalog = catalogItems();
    const tokens = searchTokens(query.q);
    /* 搜索池只在有搜索词时参与：它是「这次搜索额外找到的」，不属于目录本身。 */
    const extras = tokens.length ? [...pool.values()].filter(({ id }) => !builtins.has(id) && !snapshot?.items.has(id)) : [];
    const universe = extras.length ? [...catalog, ...extras] : catalog;
    const matched = universe.filter((item) => matchesTokens(item, tokens));
    const sorts = availableSorts(universe);
    const sort = sorts.some((s) => s.id === query.sort && s.available) ? query.sort : 'recommended';
    const scoped = query.category === 'all' ? matched : matched.filter((item) => item.category === query.category);
    const sorted = sortMarketItems(scoped, sort);
    /* 详情刚从 npm 读到过更新的版本号时，列表里用同一个 —— 不让列表与详情对
     * 「有没有更新」各说各的（`latestVersion` 也是这个次序）。 */
    const page = sorted.slice(query.offset, query.offset + query.limit).map((item) => {
      const hit = details.get(item.id);
      return hit && hit.detail.version !== item.version ? { ...item, version: hit.detail.version } : item;
    });
    const installed = installedMap();
    const ops = operationsMeta();
    const end = query.offset + page.length;
    return {
      ok: true,
      consent: { remote },
      source: SOURCE,
      snapshot: snapshotMeta(),
      /* 类别取自此刻参与结果的全集：搜索池里的包也要有自己的类别可选。 */
      categories: categoryCounts(universe, matched),
      sorts,
      query: { q: query.q, category: query.category, sort, offset: query.offset, limit: query.limit },
      total: sorted.length,
      catalogTotal: catalog.length,
      items: page.map((item) => present(item, installed, ops)),
      nextOffset: end < sorted.length ? end : null,
      deep,
      operations: ops,
    };
  }

  /**
   * 单个包的详情。id 必须是目录里的，或是本机已经装着的 npm 包（这样「已安装」页
   * 能给不在快照里的包查最新版本）—— 它不是任意 npm 包的查询代理。
   */
  async function item(rawId) {
    const name = nameOfMarketId(rawId);
    if (!name) return codeError('bad-id', '扩展标识不合法');
    const remote = loadConsent();
    const detailEpoch = epoch;
    await ensureCache();
    const id = `npm:${name}`;
    const initialInstalled = installedMap();
    const base = find(id) || (initialInstalled?.has(name) ? emptyMarketItem(name) : null);
    if (!base) return codeError('unknown-item', '目录里没有这个扩展包');
    let detail = null;
    let detailState = remote ? 'failed' : 'no-consent';
    let detailError = null;
    if (remote && detailEpoch === epoch) {
      const got = await manifestOf(name);
      if (got.ok) {
        detail = got.detail;
        detailState = 'ok';
      } else detailError = { code: got.code, error: got.error };
    }
    if (detailEpoch !== epoch) {
      detail = null;
      detailState = 'no-consent';
      detailError = null;
    }
    let piVersion = null;
    try {
      piVersion = cleanVersion(typeof readPiVersion === 'function' ? readPiVersion() : null);
    } catch {
      piVersion = null;
    }
    /* 详情里的版本是刚从 npm 读到的 latest；快照可能旧一些，以详情为准。 */
    const currentInstalled = installedMap();
    const current = find(id) || (currentInstalled?.has(name) ? emptyMarketItem(name) : null);
    if (!current) return codeError('unknown-item', '目录里没有这个扩展包');
    const fresh = detail ? { ...current, version: detail.version } : current;
    return {
      ok: true,
      /* 读清单时等过网络：同意以此刻为准。 */
      consent: { remote: loadConsent() },
      source: SOURCE,
      item: present(fresh, currentInstalled, operationsMeta()),
      detail,
      detailState,
      detailError,
      compatibility: detail ? compatibility(detail.peer, piVersion) : null,
      piVersion,
    };
  }

  async function act(body) {
    const action = isRecord(body) ? body.action : null;
    if (action === 'consent') {
      if (!writeConsent(true)) return codeError('consent-write-failed', '无法保存这个选择，已取消读取在线目录');
      consent = true;
      const mine = epoch;
      await ensureCache();
      if (mine !== epoch) return codeError('consent-required', '在线目录设置已更改', { consent: { remote: loadConsent() } });
      const result = refreshing || canRetry() ? await refresh() : { ok: Boolean(snapshot) };
      if (mine !== epoch) return codeError('consent-required', '在线目录设置已更改', { consent: { remote: loadConsent() } });
      return { ok: true, consent: { remote: true }, snapshot: snapshotMeta(), loaded: result.ok === true };
    }
    if (action === 'revoke') {
      const result = await revoke();
      return { ...result, consent: { remote: false }, snapshot: snapshotMeta() };
    }
    if (action === 'refresh') {
      if (!loadConsent()) return codeError('consent-required', '还没有同意读取在线目录', { consent: { remote: false }, snapshot: snapshotMeta() });
      const mine = epoch;
      await ensureCache();
      if (mine !== epoch) return codeError('consent-required', '在线目录设置已更改', { consent: { remote: loadConsent() } });
      const result = await refresh();
      return result.ok && mine === epoch
        ? { ok: true, consent: { remote: true }, snapshot: snapshotMeta() }
        : { ok: false, code: result.code || 'consent-required', error: result.error || '在线目录设置已更改', consent: { remote: loadConsent() }, snapshot: snapshotMeta() };
    }
    return codeError('unknown-action', '不支持的市场操作');
  }

  async function handle(req, res, url) {
    try {
      if (url.pathname === '/api/extensions/market/item') {
        if (req.method !== 'GET') return json(res, 405, codeError('method-not-allowed', '只支持 GET'));
        return json(res, 200, await item(url.searchParams.get('id')));
      }
      if (req.method === 'GET') return json(res, 200, await list(parseMarketQuery(url.searchParams)));
      if (req.method !== 'POST') return json(res, 405, codeError('method-not-allowed', '只支持 GET / POST'));
      let body;
      try {
        body = JSON.parse((await readBody(req, 4096)) || '{}');
      } catch {
        return json(res, 400, codeError('bad-body', '请求体不是合法 JSON'));
      }
      return json(res, 200, await act(body));
    } catch {
      return json(res, 200, codeError('market-failed', '插件市场读取失败'));
    }
  }

  return {
    handle,
    list,
    item,
    act,
    /** 只在已同意时读磁盘缓存；**不联网**。给「已安装」页判断有没有更新用。 */
    warm: () => ensureCache(),
    /** 这个 id 是不是目录里真有的包（内置 / 快照 / 搜索池）。安装闸门用。 */
    has: (id) => typeof id === 'string' && find(id) !== null,
    flagged: (id) => Boolean(typeof id === 'string' && find(id) && find(id).flagged),
    /** 目录里已知的最新版本；不知道就是 null。 */
    latestVersion(name) {
      const id = `npm:${name}`;
      const detail = details.get(id);
      if (detail) return detail.detail.version;
      const known = find(id);
      return known ? known.version : null;
    },
    status: () => ({ remote: loadConsent(), at: snapshot ? snapshot.at : null }),
    _internals: { refresh, deepSearch, manifestOf, catalogItems, snapshotMeta, files: { consentFile, cacheFile } },
  };
}
