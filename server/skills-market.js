/* 技能市场：目录源、目录快照、预览与安装。
 *
 * 几条不变的规矩：
 *   1. **从不自己联网。** state() 只读本机缓存；联网只发生在用户明确触发的四个动作里：
 *      加载 / 刷新目录、打开一个技能的预览、添加目录源之后的那次加载。
 *   2. **先预览、再安装，装的就是预览过的那一份。** preview() 把技能的全部文件取回来、
 *      逐个核对哈希、整包校验，暂存在内存里并返回一个令牌；install() 只认这个令牌，
 *      不再联网，落盘的字节就是用户看过的字节。
 *   3. **不执行任何远端内容。** 安装 = 把文件写进 pi 的技能目录（由 skills-manage.js
 *      完成，路径、信任、冲突、回收站都在那边）。没有安装脚本、没有 npm、没有 git。
 *   4. 远端给的一切都是数据：路径逐段校验后才拼 URL，文件清单过包校验才落盘。
 *
 * 目录从哪来：GitHub 的提交 + 文件树接口（把目录固定在一个提交上，文件用 git blob
 * 哈希核对）；GitHub 接口限流或不可达时退到 jsDelivr 的文件清单（按分支，文件用
 * sha256 核对）。文件内容从 jsDelivr CDN 取，取不到再试 GitHub raw。 */
import fs from 'node:fs';
import path from 'node:path';
import { decodeSkillBytes, sanitizeSkillSlug } from './skills-document.js';
import { BUNDLE_LIMITS, createTokenStore, describeError, validateBundle, writeFileAtomic } from './skills-files.js';
import { fail } from './skills-manage.js';
import {
  DEFAULT_SOURCES, ENTRY_ID_PATTERN, MARKET_CATEGORIES, SOURCE_ID_PATTERN, buildCatalogEntries, contentMatches, contentUrls,
  curatedFor, describeEntry, entryIdOf, filesFromFlatListing, filesFromGitTree, isCommitSha, isRefName, parseRepoSpec,
  sourceIdOf, validSnapshotEntries,
} from './skills-market-catalog.js';
import { MARKET_HOSTS, createSkillsMarketNetwork } from './skills-market-network.js';

const SKILL_FILE = 'SKILL.md';
const STORE_VERSION = 1;
const MAX_CUSTOM_SOURCES = 20;
const PAGE_SIZE = 24;
/** 这么久之内刚读过的目录不重复读（除非用户点「刷新」）。 */
const FRESH_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 20_000;
const LIST_MAX_BYTES = 8 * 1024 * 1024;
const META_MAX_BYTES = 1024 * 1024;
const FILE_TIMEOUT_MS = 10_000;
const PREVIEW_DEADLINE_MS = 60_000;
const PREVIEW_CONCURRENCY = 4;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const PREVIEW_MAX_ENTRIES = 6;
const PREVIEW_MAX_BYTES = 32 * 1024 * 1024;
const VIEW_MAX_BYTES = 256 * 1024;
const MAX_CACHED_DESCRIPTION = 400;

/* 这些失败换一个主机也一样（线路被拒、代理不可用），所以不做备用尝试。 */
const POLICY_CODES = new Set(['blocked-url', 'blocked-host', 'proxy-unsupported', 'proxy-blocked', 'proxy-auth-required', 'proxy-unreachable']);

const GONE = '目录里已经没有这个技能了，请刷新目录';
const EXPIRED = '预览已经过期，请重新打开这个技能';

/* 远端读不到不是本机接口的故障：与 MCP 市场一样，用 200 + ok:false 把原因带回去。 */
const upstream = (code, error, extra = {}) => fail(200, code, error, extra);

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseJsonBytes(bytes) {
  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

/**
 * @param dataDir  Pi GUI 的数据目录；目录缓存与自定义目录源放在 <dataDir>/skills-market/。不传则只在内存里
 * @param manager  skills-manage.js 的实例（inspectBundle / install）
 * @param core     skills.js 注入的只读能力（这里只用 maxSkillBytes）
 * @param network  Electron 主进程的代理桥；网页版为 null
 * @param fetcher  { fetchBytes(url, options) }，测试注入；传了就不建真实的网络层
 * @param now      毫秒时钟，测试注入（目录的新鲜度、预览的期限与过期都按它算）
 */
export function createSkillsMarket({
  dataDir = null, manager, core, network = null, env = process.env, fetcher = null, now = () => Date.now(),
}) {
  const dir = dataDir ? path.join(dataDir, 'skills-market') : null;
  const sourcesFile = dir ? path.join(dir, 'sources.json') : null;
  const snapshotFile = (id) => path.join(dir, `catalog-${id}.json`);

  let net = fetcher || createSkillsMarketNetwork({ network, env });
  let custom = null;
  const snapshots = new Map();
  const errors = new Map();
  const inflight = new Map();
  const previews = createTokenStore({ ttlMs: PREVIEW_TTL_MS, maxEntries: PREVIEW_MAX_ENTRIES, maxBytes: PREVIEW_MAX_BYTES, now });

  /** server.js 在网络桥就绪后调用一次，把桌面端的代理线路接进来。 */
  function configure({ network: nextNetwork = null, env: nextEnv = process.env } = {}) {
    if (!fetcher) net = createSkillsMarketNetwork({ network: nextNetwork, env: nextEnv });
  }

  async function writeJson(file, value) {
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    await writeFileAtomic(file, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
  }

  /* ---------- 目录源 ---------- */

  function loadCustom() {
    if (custom) return custom;
    custom = [];
    const stored = sourcesFile ? readJsonFile(sourcesFile) : null;
    if (stored && stored.version === STORE_VERSION && Array.isArray(stored.custom)) {
      for (const item of stored.custom.slice(0, MAX_CUSTOM_SOURCES)) {
        const spec = item && typeof item.repo === 'string' ? `${item.repo}${typeof item.ref === 'string' && item.ref ? `@${item.ref}` : ''}` : '';
        const parsed = parseRepoSpec(spec);
        if (parsed.ok) custom.push({ owner: parsed.owner, repo: parsed.repo, ref: parsed.ref, addedAt: Number(item.addedAt) || 0 });
      }
    }
    return custom;
  }

  const persistSources = () => writeJson(sourcesFile, {
    version: STORE_VERSION,
    custom: loadCustom().map((item) => ({ repo: `${item.owner}/${item.repo}`, ref: item.ref, addedAt: item.addedAt })),
  });

  function allSources() {
    const seen = new Set();
    const list = [];
    const add = (item, builtin) => {
      const id = sourceIdOf(item.owner, item.repo, item.ref);
      if (seen.has(id)) return;
      seen.add(id);
      list.push({ id, owner: item.owner, repo: item.repo, ref: item.ref || '', builtin });
    };
    for (const item of DEFAULT_SOURCES) add(item, true);
    for (const item of loadCustom()) add(item, false);
    return list;
  }

  /* ---------- 目录快照 ---------- */

  function snapshotOf(source) {
    if (snapshots.has(source.id)) return snapshots.get(source.id);
    let snapshot = null;
    const stored = dir ? readJsonFile(snapshotFile(source.id)) : null;
    // 缓存文件坏了、形状不对、或者不是这个源的，一律当作没加载过
    if (
      stored && stored.version === STORE_VERSION && stored.sourceId === source.id && Number.isFinite(stored.fetchedAt) &&
      (stored.mode === 'pinned' ? isCommitSha(stored.resolvedRef) : stored.mode === 'cdn' && isRefName(stored.resolvedRef)) &&
      validSnapshotEntries(stored.entries)
    ) {
      snapshot = { resolvedRef: stored.resolvedRef, mode: stored.mode, fetchedAt: stored.fetchedAt, truncated: stored.truncated === true, entries: stored.entries };
    }
    snapshots.set(source.id, snapshot);
    return snapshot;
  }

  const persistSnapshot = (source, snapshot) => writeJson(snapshotFile(source.id), {
    version: STORE_VERSION,
    sourceId: source.id,
    repo: `${source.owner}/${source.repo}`,
    ref: source.ref,
    resolvedRef: snapshot.resolvedRef,
    mode: snapshot.mode,
    fetchedAt: snapshot.fetchedAt,
    truncated: snapshot.truncated,
    entries: snapshot.entries,
  });

  function sourceSummary(source) {
    const snapshot = snapshotOf(source);
    const failure = errors.get(source.id) || null;
    return {
      id: source.id,
      repo: `${source.owner}/${source.repo}`,
      ref: source.ref,
      builtin: source.builtin,
      removable: !source.builtin,
      loaded: Boolean(snapshot),
      fetchedAt: snapshot ? snapshot.fetchedAt : null,
      resolvedRef: snapshot ? snapshot.resolvedRef : '',
      mode: snapshot ? snapshot.mode : '',
      count: snapshot ? snapshot.entries.length : curatedFor(source.owner, source.repo).length,
      truncated: snapshot ? snapshot.truncated : false,
      error: failure ? failure.error : '',
      errorCode: failure ? failure.code : '',
    };
  }

  function entriesOf(source) {
    const snapshot = snapshotOf(source);
    const curated = curatedFor(source.owner, source.repo);
    if (!snapshot) return curated.map((item) => describeEntry(source, null, item, ''));
    const curatedByDir = new Map(curated.map((item) => [item.dir, item]));
    return snapshot.entries.map((entry) => describeEntry(source, entry, curatedByDir.get(entry.dir), snapshot.resolvedRef));
  }

  /** 当前目录，不联网。没加载过的源只给出预置的那几条。 */
  function state() {
    const sources = allSources();
    return {
      ok: true,
      sources: sources.map(sourceSummary),
      entries: sources.flatMap(entriesOf),
      categories: MARKET_CATEGORIES,
      hosts: MARKET_HOSTS,
      persistent: Boolean(dir),
      limits: { maxCustomSources: MAX_CUSTOM_SOURCES, pageSize: PAGE_SIZE },
    };
  }

  /* ---------- 读目录 ---------- */

  async function getJson(url, options) {
    const got = await net.fetchBytes(url, { accept: 'application/json', ...options });
    if (!got.ok) return got;
    try {
      return { ok: true, data: parseJsonBytes(got.bytes) };
    } catch {
      return { ok: false, code: 'bad-response', error: `${new URL(url).hostname} 返回的不是合法 JSON` };
    }
  }

  /** GitHub：最新提交 → 它的文件树。目录因此固定在一个提交上。 */
  async function listPinned(source) {
    const api = `https://api.github.com/repos/${source.owner}/${source.repo}`;
    const head = await getJson(`${api}/commits?per_page=1${source.ref ? `&sha=${encodeURIComponent(source.ref)}` : ''}`, {
      timeoutMs: LIST_TIMEOUT_MS, maxBytes: META_MAX_BYTES,
    });
    if (!head.ok) return head;
    const commit = Array.isArray(head.data) ? head.data[0] : null;
    const sha = commit && commit.sha;
    const treeSha = commit && commit.commit && commit.commit.tree && commit.commit.tree.sha;
    if (!isCommitSha(sha) || !isCommitSha(treeSha)) return { ok: false, code: 'bad-response', error: 'api.github.com 返回的提交信息不完整' };
    const tree = await getJson(`${api}/git/trees/${treeSha}?recursive=1`, { timeoutMs: LIST_TIMEOUT_MS, maxBytes: LIST_MAX_BYTES });
    if (!tree.ok) return tree;
    const listed = filesFromGitTree(tree.data);
    if (!listed.ok) return { ok: false, code: 'bad-response', error: 'api.github.com 返回的文件清单格式不对' };
    return { ok: true, mode: 'pinned', resolvedRef: sha, files: listed.files, truncated: listed.truncated };
  }

  /** jsDelivr：按分支给出整个仓库的文件清单（带 sha256）。没指定分支时依次试 main / master。 */
  async function listCdn(source) {
    let last = null;
    for (const ref of source.ref ? [source.ref] : ['main', 'master']) {
      const got = await getJson(
        `https://data.jsdelivr.com/v1/packages/gh/${source.owner}/${source.repo}@${encodeURIComponent(ref)}?structure=flat`,
        { timeoutMs: LIST_TIMEOUT_MS, maxBytes: LIST_MAX_BYTES },
      );
      if (got.ok) {
        const listed = filesFromFlatListing(got.data);
        if (!listed.ok) return { ok: false, code: 'bad-response', error: 'data.jsdelivr.com 返回的文件清单格式不对' };
        return { ok: true, mode: 'cdn', resolvedRef: ref, files: listed.files, truncated: false };
      }
      last = got;
      if (got.code !== 'http-404') break;
    }
    return last;
  }

  function listFailure(source, failure) {
    const repo = `${source.owner}/${source.repo}`;
    if (failure.code === 'http-404') {
      return { code: 'not-found', error: `找不到仓库 ${repo}${source.ref ? `（分支 ${source.ref}）` : ''}，请确认它是公开仓库` };
    }
    if (failure.code === 'http-403' || failure.code === 'http-429') {
      return { code: failure.code, error: `${failure.error}。GitHub 接口可能在限流（未登录每小时 60 次），请稍后再试。` };
    }
    return { code: failure.code || 'network', error: failure.error || '读取目录失败' };
  }

  async function refreshNow(source) {
    let listed = await listPinned(source);
    if (!listed.ok && !POLICY_CODES.has(listed.code) && listed.code !== 'http-404') {
      const primary = listed;
      const backup = await listCdn(source);
      listed = backup.ok ? backup : primary;
    }
    // 读的这一会儿里，这个源可能已经被用户移除了
    if (!allSources().some((item) => item.id === source.id)) return fail(404, 'source-gone', '这个目录源已经不在了');
    if (!listed.ok) {
      const failure = listFailure(source, listed);
      errors.set(source.id, failure);
      return upstream(failure.code, failure.error, { source: sourceSummary(source) });
    }
    const built = buildCatalogEntries(listed.files, { maxSkillBytes: core.maxSkillBytes });
    // 之前预览时记下的描述：SKILL.md 没变的条目沿用
    const previous = snapshotOf(source);
    const known = new Map();
    for (const entry of previous ? previous.entries : []) {
      if (entry.description && entry.files[0]) known.set(entry.dir, { hash: entry.files[0][1], description: entry.description });
    }
    for (const entry of built.entries) {
      const hit = known.get(entry.dir);
      if (hit && entry.files[0] && entry.files[0][1] === hit.hash) entry.description = hit.description;
    }
    const snapshot = {
      resolvedRef: listed.resolvedRef, mode: listed.mode, fetchedAt: now(), truncated: listed.truncated || built.truncated, entries: built.entries,
    };
    snapshots.set(source.id, snapshot);
    errors.delete(source.id);
    try {
      await persistSnapshot(source, snapshot);
    } catch {
      /* 缓存写不进去不影响这次使用，只是下次打开要重新加载 */
    }
    return { ok: true, refreshed: true, source: sourceSummary(source) };
  }

  /** 加载 / 刷新一个目录源。**会联网**，只由用户的点击触发。 */
  async function refresh({ sourceId, force = false } = {}) {
    if (typeof sourceId !== 'string' || !SOURCE_ID_PATTERN.test(sourceId)) return fail(400, 'bad-request', '目录源 ID 不合法');
    const source = allSources().find((item) => item.id === sourceId);
    if (!source) return fail(404, 'source-gone', '这个目录源已经不在了');
    const snapshot = snapshotOf(source);
    if (force !== true && snapshot && now() - snapshot.fetchedAt < FRESH_MS) return { ok: true, refreshed: false, source: sourceSummary(source) };
    if (!inflight.has(sourceId)) {
      inflight.set(sourceId, refreshNow(source).finally(() => inflight.delete(sourceId)));
    }
    return inflight.get(sourceId);
  }

  async function addSource({ repo } = {}) {
    const parsed = parseRepoSpec(repo);
    if (!parsed.ok) return fail(400, 'bad-repo', parsed.error);
    const id = sourceIdOf(parsed.owner, parsed.repo, parsed.ref);
    if (allSources().some((item) => item.id === id)) return fail(409, 'exists', '这个仓库已经在目录源里了');
    const list = loadCustom();
    if (list.length >= MAX_CUSTOM_SOURCES) return fail(409, 'too-many', `最多添加 ${MAX_CUSTOM_SOURCES} 个自定义目录源`);
    list.push({ owner: parsed.owner, repo: parsed.repo, ref: parsed.ref, addedAt: now() });
    try {
      await persistSources();
    } catch (err) {
      list.pop();
      return fail(500, 'write-failed', `保存失败：${describeError(err)}`);
    }
    return { ok: true, source: sourceSummary(allSources().find((item) => item.id === id)) };
  }

  async function removeSource({ id } = {}) {
    const source = allSources().find((item) => item.id === id);
    if (!source) return fail(404, 'source-gone', '这个目录源已经不在了');
    if (source.builtin) return fail(403, 'builtin', '默认目录源不能移除');
    const list = loadCustom();
    const index = list.findIndex((item) => sourceIdOf(item.owner, item.repo, item.ref) === id);
    const [removed] = list.splice(index, 1);
    try {
      await persistSources();
    } catch (err) {
      list.splice(index, 0, removed);
      return fail(500, 'write-failed', `保存失败：${describeError(err)}`);
    }
    snapshots.delete(id);
    errors.delete(id);
    if (dir) {
      try {
        fs.rmSync(snapshotFile(id), { force: true });
      } catch {
        /* 留下一个没人读的缓存文件，无害 */
      }
    }
    return { ok: true };
  }

  /* ---------- 预览 ---------- */

  function locate(entryId) {
    const source = allSources().find((item) => item.id === entryId.slice(0, 16));
    if (!source) return null;
    const snapshot = snapshotOf(source);
    const curated = curatedFor(source.owner, source.repo);
    if (!snapshot) {
      const item = curated.find((candidate) => entryIdOf(source.id, candidate.dir) === entryId);
      return item ? { source, snapshot: null, entry: null, curated: item } : null;
    }
    const entry = snapshot.entries.find((candidate) => entryIdOf(source.id, candidate.dir) === entryId);
    return entry ? { source, snapshot, entry, curated: curated.find((item) => item.dir === entry.dir) } : null;
  }

  /** 取一个文件：依次试给定的主机，取回来的字节必须与目录登记的大小、哈希一致。 */
  async function fetchRecord(hit, record, hosts, deadline) {
    const [rel, hash, size] = record;
    const urls = contentUrls(hit.source, hit.snapshot.resolvedRef, hit.entry.dir ? `${hit.entry.dir}/${rel}` : rel);
    let failure = { code: 'timeout', error: '预览超时' };
    for (const host of hosts) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const got = await net.fetchBytes(urls[host], { timeoutMs: Math.min(FILE_TIMEOUT_MS, remaining), maxBytes: BUNDLE_LIMITS.maxFileBytes });
      if (got.ok) {
        if (contentMatches(hit.snapshot.mode, hash, size, got.bytes)) return { ok: true, bytes: got.bytes, host };
        // 代理桥只能按文本传回响应体，二进制文件经过它会失真 —— 这里的不一致多半就是这个原因
        failure = got.route === 'proxied'
          ? { code: 'integrity', error: '经系统代理读取时，非文本文件无法保持原样' }
          : { code: 'integrity', error: '内容与目录登记的不一致' };
        continue;
      }
      if (POLICY_CODES.has(got.code)) return { ok: false, fatal: true, code: got.code, error: got.error };
      failure = { code: got.code, error: got.error };
    }
    return { ok: false, fatal: false, ...failure };
  }

  /**
   * 把一个技能的全部文件取回来、核对、校验，暂存后返回预览。**会联网**。
   * 返回的 previewId 是安装的唯一凭据。
   */
  async function preview({ entryId } = {}) {
    if (typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId)) return fail(400, 'bad-request', '条目 ID 不合法');
    let hit = locate(entryId);
    if (!hit) return fail(404, 'entry-gone', GONE);
    if (!hit.snapshot) {
      // 预置条目还没有文件清单：先把它所在的目录读回来
      const refreshed = await refresh({ sourceId: hit.source.id });
      if (!refreshed.ok) return refreshed;
      hit = locate(entryId);
      if (!hit || !hit.snapshot) return fail(404, 'entry-gone', GONE);
    }
    const { source, snapshot, entry } = hit;
    const summary = describeEntry(source, entry, hit.curated, snapshot.resolvedRef);
    const skillRecord = entry.files.find((record) => record[0] === SKILL_FILE);
    if (!skillRecord) return fail(409, 'not-installable', `${summary.reason || '它不符合安装限制'}，无法预览`);

    const deadline = now() + PREVIEW_DEADLINE_MS;
    const first = await fetchRecord(hit, skillRecord, ['cdn', 'raw'], deadline);
    if (!first.ok) return upstream(first.code, `读不到这个技能的 SKILL.md：${first.error}`);
    // SKILL.md 从哪个主机取到的，其余文件就先试哪个
    const hosts = first.host === 'cdn' ? ['cdn', 'raw'] : ['raw', 'cdn'];

    const others = entry.files.filter((record) => record !== skillRecord);
    const results = new Array(others.length);
    let cursor = 0;
    let fatal = null;
    const worker = async () => {
      while (cursor < others.length && !fatal) {
        const index = cursor;
        cursor += 1;
        const result = await fetchRecord(hit, others[index], hosts, deadline);
        if (result.fatal) fatal = result;
        results[index] = result;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREVIEW_CONCURRENCY, others.length) }, worker));
    if (fatal) return upstream(fatal.code, fatal.error);

    const fetched = [{ path: SKILL_FILE, bytes: first.bytes, executable: skillRecord[3] === 1 }];
    const report = [{ path: SKILL_FILE, size: skillRecord[2], status: 'ok', note: '' }];
    const missing = [];
    others.forEach((record, index) => {
      const result = results[index];
      if (result && result.ok) {
        fetched.push({ path: record[0], bytes: result.bytes, executable: record[3] === 1 });
        report.push({ path: record[0], size: record[2], status: 'ok', note: '' });
      } else {
        missing.push(record[0]);
        report.push({ path: record[0], size: record[2], status: 'failed', note: (result && result.error) || '没有取到' });
      }
    });

    const checked = validateBundle(fetched);
    if (!checked.ok) return fail(400, checked.code, checked.error);
    const inspected = manager.inspectBundle(checked.files, { dirName: summary.slug });
    if (!inspected.ok) return inspected;

    const origin = { repo: summary.repo, dir: entry.dir, ref: snapshot.resolvedRef, mode: snapshot.mode, homepage: summary.homepage };
    const previewId = previews.put({
      entryId, files: checked.files, missing, installable: !entry.blocked, reason: summary.reason, source: origin,
    }, checked.totalBytes);

    if (inspected.description && entry.description !== inspected.description.slice(0, MAX_CACHED_DESCRIPTION)) {
      // 记下描述，列表里下次就能直接显示；写缓存失败无所谓
      entry.description = inspected.description.slice(0, MAX_CACHED_DESCRIPTION);
      persistSnapshot(source, snapshot).catch(() => {});
    }
    return {
      ok: true,
      previewId,
      entry: { ...summary, description: inspected.description || summary.description },
      name: inspected.name,
      suggestedName: sanitizeSkillSlug(inspected.name) || summary.slug,
      description: inspected.description,
      content: inspected.text,
      files: report,
      skipped: entry.skipped,
      totalBytes: checked.totalBytes,
      problems: inspected.problems,
      partial: missing.length > 0,
      installable: !entry.blocked,
      reason: summary.reason,
      source: origin,
    };
  }

  /** 预览里的某个文件（文本）。不联网，读的是已经取回来的那一份。 */
  function previewFile({ previewId, path: relPath } = {}) {
    const staged = previews.get(previewId);
    if (!staged) return fail(410, 'preview-expired', EXPIRED);
    const file = typeof relPath === 'string' ? staged.files.find((item) => item.path === relPath) : null;
    if (!file) return fail(404, 'not-found', '预览里没有这个文件');
    let cut = Math.min(file.bytes.length, VIEW_MAX_BYTES);
    // 别把一个多字节字符从中间切开
    while (cut > 0 && cut < file.bytes.length && (file.bytes[cut] & 0xc0) === 0x80) cut -= 1;
    const decoded = decodeSkillBytes(file.bytes.subarray(0, cut));
    if (!decoded.ok) return { ok: true, path: file.path, size: file.bytes.length, binary: true, text: '', truncated: false };
    return { ok: true, path: file.path, size: file.bytes.length, binary: false, text: decoded.text, truncated: cut < file.bytes.length };
  }

  /* ---------- 安装 ---------- */

  /** @param payload { previewId, target, name, onConflict, allowPartial } */
  async function install(context, payload = {}) {
    const staged = previews.get(payload.previewId);
    if (!staged) return fail(410, 'preview-expired', EXPIRED);
    if (!staged.installable) return fail(409, 'not-installable', `${staged.reason || '它不符合安装限制'}，不能安装`);
    if (staged.missing.length && payload.allowPartial !== true) {
      return fail(409, 'partial', `有 ${staged.missing.length} 个文件没有取到，确认后才会安装不完整的技能`, { missing: staged.missing.slice(0, 50) });
    }
    const result = await manager.install(context, {
      targetKey: payload.target,
      name: payload.name,
      files: staged.files,
      onConflict: payload.onConflict || 'fail',
    });
    // 失败（比如同名冲突）时预览要留着：用户选完「覆盖 / 保留两者」还要再提交一次
    if (!result.ok) return result;
    previews.delete(payload.previewId);
    return { ...result, source: staged.source, partial: staged.missing.length > 0 };
  }

  return { configure, state, refresh, addSource, removeSource, preview, previewFile, install };
}
