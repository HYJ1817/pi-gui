/* 版本检查（P5）的测试。
 *
 * 硬规矩：**默认绝不访问真实 GitHub。** 所有网络请求都通过注入的假 fetch，
 * 而且有一条断言盯着「假 fetch 真的被用上了」—— 否则以后有人把注入去掉，
 * 这整个套件会悄悄变成打真接口，CI 上要么超时要么被限流。
 *
 * 分六段：
 *   1. SemVer（纯函数）
 *   2. GitHub 响应处理（13 种真实会遇到的形态）
 *   3. 缓存与 single-flight
 *   4. 隐私（请求里到底发了什么）
 *   5. 路由与鉴权（GET / force / POST / 令牌）
 *   6. 外链白名单（含与 Electron 侧实现的**一致性**对拍）
 */
const assert = require('node:assert/strict');

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

const RELEASE_API = 'https://api.github.com/repos/HYJ1817/pi-gui/releases/latest';

/* ---------- 假 fetch ---------- */

/** 记录调用的假 fetch。handler 决定这次返回什么。 */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({
      url: String(url),
      method: opts && opts.method,
      headers: (opts && opts.headers) || {},
      body: opts && opts.body,
      signal: opts && opts.signal,
    });
    return handler(url, opts, calls.length);
  };
  fn.calls = calls;
  return fn;
}

/** 造一个「像 fetch 响应」的对象。headers.get 按小写键取。 */
function jsonResponse(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  return {
    status,
    headers: { get: (k) => lower[String(k).toLowerCase()] ?? null },
    json: async () => body,
  };
}

/** 返回了东西但 body 不是 JSON —— 真实场景：被门户/代理拦下返回 HTML。 */
function notJsonResponse(status = 200) {
  return {
    status,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  };
}

/** 永远不回应，直到 signal abort —— 用来测 timeout。 */
function hangingFetch() {
  return async (_url, opts) => {
    const signal = opts && opts.signal;
    return new Promise((_resolve, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          const e = new Error('This operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
  };
}

/** 网络层直接 reject（DNS 失败 / 连接被拒）。 */
function rejectingFetch(message = 'fetch failed') {
  return async () => {
    throw new TypeError(message);
  };
}

/* ---------- 真实形状的 Release fixture ----------
 *
 * 形状照 GitHub API 的实际返回（字段名、嵌套、asset 里的 browser_download_url），
 * 不是凭印象写的简版 —— 本项目的记忆里有一条血债：fixture 形状错了会把真实缺陷
 * 藏起来（`get_tree` 那次藏了整整一版）。
 * asset 名字用的是仓库真实的三个（见 HYJ1817/pi-gui 的 Release）。 */
function releaseFixture({
  tag = 'v0.12.0',
  name = 'Pi GUI v0.12.0',
  publishedAt = '2026-09-26T09:28:37Z',
  htmlUrl,
  body = '## 新增\n\n- 版本检查\n',
  assets = null,
  extra = {},
} = {}) {
  return {
    tag_name: tag,
    name,
    published_at: publishedAt,
    html_url: htmlUrl === undefined ? `https://github.com/HYJ1817/pi-gui/releases/tag/${tag}` : htmlUrl,
    prerelease: false,
    draft: false,
    body,
    assets:
      assets === null
        ? [
            {
              name: `Pi-GUI-Setup-${tag.replace(/^v/, '')}.exe`,
              size: 105020429,
              content_type: 'application/x-msdownload',
              browser_download_url: `https://github.com/HYJ1817/pi-gui/releases/download/${tag}/Pi-GUI-Setup-${tag.replace(/^v/, '')}.exe`,
            },
            {
              name: `Pi-GUI-${tag.replace(/^v/, '')}-portable.zip`,
              size: 342487040,
              content_type: 'application/zip',
              browser_download_url: `https://github.com/HYJ1817/pi-gui/releases/download/${tag}/Pi-GUI-${tag.replace(/^v/, '')}-portable.zip`,
            },
            {
              name: 'SHA256SUMS.txt',
              size: 183,
              content_type: 'text/plain; charset=utf-8',
              browser_download_url: `https://github.com/HYJ1817/pi-gui/releases/download/${tag}/SHA256SUMS.txt`,
            },
          ]
        : assets,
    ...extra,
  };
}

/* ---------- 极简 req / res 替身（照 tests/modules.cjs 的形状） ---------- */

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
    json() {
      return JSON.parse(this.body());
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
  const mod = await import('../server/update-check.js');
  const { createUpdateCheck, parseVersion, compareVersions, isSafeReleaseUrl, classifyAsset, ASSET_LABELS } = mod;

  /* ================= 1. SemVer ================= */
  console.log('\n--- 1. SemVer（纯函数）---');

  check('1. 相同版本 → 0', () => compareVersions('0.11.0', '0.11.0') === 0);
  check('2. patch 更大 → 有更新（0.12.0 < 0.12.1）', () => compareVersions('0.12.0', '0.12.1') === -1);
  check('3. minor 更大 → 有更新（0.11.0 < 0.12.0）', () => compareVersions('0.11.0', '0.12.0') === -1);
  check('4. major 更大 → 有更新（0.12.0 < 1.0.0）', () => compareVersions('0.12.0', '1.0.0') === -1);
  check('5. v 前缀与不带前缀等价', () =>
    compareVersions('v0.11.0', '0.11.0') === 0 && compareVersions('V1.2.3', '1.2.3') === 0);
  check('6. prerelease 小于同版本正式版', () =>
    compareVersions('0.12.0-beta.1', '0.12.0') === -1 && compareVersions('0.12.0', '0.12.0-rc.1') === 1);
  check('6b. prerelease 之间按 semver 规则排（rc.1 > beta.1；数字段 < 字母段）', () =>
    compareVersions('0.12.0-beta.1', '0.12.0-rc.1') === -1 &&
    compareVersions('1.0.0-alpha', '1.0.0-1') === 1 &&
    compareVersions('1.0.0-beta.2', '1.0.0-beta.11') === -1);
  check('8. 非法版本不崩：parseVersion 回 null', () =>
    parseVersion('not-a-version') === null &&
    parseVersion('') === null &&
    parseVersion(null) === null &&
    parseVersion('0.11.0.5') === null &&
    parseVersion('1.2.3-') === null);
  check('8b. 非法版本不崩：compareVersions 回 null（不是 0）', () =>
    compareVersions('x', '1.0.0') === null &&
    compareVersions('1.0.0', undefined) === null &&
    compareVersions('1.0.0.0', '1.0.0') === null);
  check('8c. 缺段按 0 补（1 == 1.0.0，1.2 == 1.2.0）', () =>
    parseVersion('1').minor === 0 && compareVersions('1', '1.0.0') === 0 && compareVersions('1.2', '1.2.0') === 0);

  /* §7 的实测量：稳定版 + prerelease 的 tag → updateAvailable 必须为 false */
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: 'v0.13.0-beta.1' })));
    const uc = createUpdateCheck({ version: '0.12.0', fetchImpl });
    const r = await uc.readUpdate({});
    check('7. 稳定版用户不提示 prerelease（实测量：updateAvailable=false）', () =>
      r.ok === true && r.latestVersion === '0.13.0-beta.1' && r.updateAvailable === false || JSON.stringify(r));
    check('7b. 不提示 prerelease 时不返回 release 正文', () => r.release === undefined);
  }
  {
    /* 已经在 prerelease 轨道上的人：同轨道内的前进照常提示 */
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: 'v0.13.0-beta.1' })));
    const uc = createUpdateCheck({ version: '0.12.0-beta.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('7c. 自己就在 prerelease 轨道上的人不受「不提示 prerelease」限制', () =>
      r.ok === true && r.updateAvailable === true || JSON.stringify(r));
  }

  /* ================= 2. GitHub 响应处理 ================= */
  console.log('\n--- 2. GitHub Release 响应 ---');

  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: 'v0.12.0' })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('9. 正常 Release：结构完整', () =>
      r.ok === true &&
      r.currentVersion === '0.11.1' &&
      r.latestVersion === '0.12.0' &&
      r.cached === false &&
      r.release &&
      r.release.tag === 'v0.12.0' &&
      r.release.name === 'Pi GUI v0.12.0' &&
      r.release.publishedAt === '2026-09-26T09:28:37Z' &&
      r.release.url === 'https://github.com/HYJ1817/pi-gui/releases/tag/v0.12.0' &&
      typeof r.release.notes === 'string' || JSON.stringify(r));
    check('10. 有更新：updateAvailable=true', () => r.updateAvailable === true);
    check('12. assets 正常：三个都识别出来', () => {
      const kinds = r.release.assets.map((a) => a.kind);
      return (
        r.release.assets.length === 3 &&
        kinds.includes('installer') &&
        kinds.includes('portable') &&
        kinds.includes('checksums') &&
        r.release.assets[0].size === 105020429 &&
        r.release.assets.every((a) => typeof a.url === 'string' && a.url.startsWith('https://github.com/')) ||
        JSON.stringify(kinds)
      );
    });
    check('12b. 资产类型标签是单一真相（后端给，前端不自己维护一份）', () =>
      ASSET_LABELS.installer === '安装版' && ASSET_LABELS.portable === '便携版' && ASSET_LABELS.checksums === '校验和');
    check('12c. classifyAsset 认得出真实命名，认不出的一律 other', () =>
      classifyAsset('Pi-GUI-Setup-0.11.1.exe') === 'installer' &&
      classifyAsset('Pi-GUI-0.11.1-portable.zip') === 'portable' &&
      classifyAsset('SHA256SUMS.txt') === 'checksums' &&
      classifyAsset('weird-thing.dmg') === 'other' &&
      classifyAsset('') === 'other');
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: 'v0.11.1' })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('11. 无更新：updateAvailable=false 且不带 release 正文', () =>
      r.ok === true && r.updateAvailable === false && r.latestVersion === '0.11.1' && r.release === undefined ||
      JSON.stringify(r));
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: 'v0.12.0', assets: [] })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('13. assets 为空：不崩，assets 是空数组', () =>
      r.ok === true && r.updateAvailable === true && Array.isArray(r.release.assets) && r.release.assets.length === 0);
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ assets: [{ name: 'a.exe', size: 1 }] })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('13b. asset 缺 browser_download_url 会被丢掉（不猜下载地址）', () =>
      r.ok === true && r.release.assets.length === 0 && r.release.droppedAssets === 1);
  }
  {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(200, releaseFixture({ assets: [{ name: 'x.exe', size: 1, browser_download_url: 'https://evil.example/x.exe' }] }))
    );
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('13c. 站外 asset URL 会被后端过滤掉（不进响应）', () =>
      r.release.assets.length === 0 && !JSON.stringify(r).includes('evil.example'));
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ htmlUrl: 'https://evil.example/release' })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('13d. html_url 站外时退回自建的 tag 链接（仍可打开，且是官方域）', () =>
      r.release.url === 'https://github.com/HYJ1817/pi-gui/releases/tag/v0.12.0' && !JSON.stringify(r).includes('evil.example'));
  }
  {
    const body = releaseFixture({ tag: 'v0.12.0' });
    delete body.tag_name;
    const fetchImpl = fakeFetch(() => jsonResponse(200, body));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('14. 缺 tag_name → invalid-response，不崩', () => r.ok === false && r.code === 'invalid-response' || JSON.stringify(r));
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: 'v0.12.0', extra: { tag_name: '  ' } })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('14b. tag_name 只有空白同样算 invalid-response', () => r.ok === false && r.code === 'invalid-response');
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: '不是版本号' })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('14c. tag 不是合法版本 → invalid-response（不让非法版本把流程弄崩）', () =>
      r.ok === false && r.code === 'invalid-response' || JSON.stringify(r));
  }
  {
    const fetchImpl = fakeFetch(() => notJsonResponse(200));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('15. 非 JSON → invalid-response', () => r.ok === false && r.code === 'invalid-response' || JSON.stringify(r));
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, [1, 2, 3]));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('15b. JSON 是数组（不是对象）→ invalid-response', () => r.ok === false && r.code === 'invalid-response');
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('17. 403 + remaining=0 → rate-limit，文案是「稍后再试」', () =>
      r.ok === false && r.code === 'rate-limit' && /稍后再试/.test(r.error) || JSON.stringify(r));
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(403, { message: 'Forbidden' }, { 'x-ratelimit-remaining': '57' }));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('16. 403（不是限流）→ github-error', () => r.ok === false && r.code === 'github-error' || JSON.stringify(r));
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(404, { message: 'Not Found' }));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('18. 404 → no-release（仓库上还没有已发布的 Release）', () =>
      r.ok === false && r.code === 'no-release' && /还没有已发布的 Release/.test(r.error) || JSON.stringify(r));
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(500, { message: 'Server Error' }));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('19. 500 → github-error', () => r.ok === false && r.code === 'github-error' || JSON.stringify(r));
  }
  {
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl: hangingFetch(), timeoutMs: 40 });
    const r = await uc.readUpdate({});
    check('20. timeout → timeout（AbortController 生效）', () =>
      r.ok === false && r.code === 'timeout' && /超时/.test(r.error) || JSON.stringify(r));
  }
  {
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl: rejectingFetch('getaddrinfo ENOTFOUND api.github.com') });
    const r = await uc.readUpdate({});
    check('21. 网络层 reject（DNS 失败）→ network', () => r.ok === false && r.code === 'network' || JSON.stringify(r));
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ body: 'x'.repeat(9000) })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('13e. Release Notes 超长被截断到 4000 字并标记 truncated', () =>
      r.release.notes.length === 4000 && r.release.notesTruncated === true || `len=${r.release.notes.length}`);
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ body: 12345 })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('13f. body 不是字符串时当空说明处理，不崩', () => r.ok === true && r.release.notes === '');
  }
  {
    /* 失败**不能**被缓存：GitHub 抽风一次不该让用户 30 分钟都点不动 */
    const fetchImpl = fakeFetch((_u, _o, n) =>
      n === 1 ? jsonResponse(500, {}) : jsonResponse(200, releaseFixture({ tag: 'v0.12.0' }))
    );
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const first = await uc.readUpdate({});
    const second = await uc.readUpdate({});
    check('13g. 失败结果不进缓存，下一次立刻重试就能成功', () =>
      first.ok === false && second.ok === true && fetchImpl.calls.length === 2 || JSON.stringify([first, second]));
  }
  {
    /* 异常也不能冒成 unhandled rejection：fetchImpl 本身抛同步错 */
    const uc = createUpdateCheck({
      version: '0.11.1',
      fetchImpl: () => {
        throw new Error('boom');
      },
    });
    const r = await uc.readUpdate({});
    check('13h. fetchImpl 同步抛错 → 结构化 network 结果，不冒泡', () => r.ok === false && r.code === 'network');
  }

  /* ================= 3. 缓存与 single-flight ================= */
  console.log('\n--- 3. 缓存与 single-flight ---');

  {
    let clock = 1_000_000;
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: 'v0.12.0' })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl, now: () => clock, ttlMs: 1000 });

    const a = await uc.readUpdate({});
    check('22. 首次检查真的走了网络', () => fetchImpl.calls.length === 1 && a.cached === false || `calls=${fetchImpl.calls.length}`);

    const b = await uc.readUpdate({});
    check('23. TTL 内复用缓存（不再请求）', () =>
      fetchImpl.calls.length === 1 && b.cached === true && b.latestVersion === '0.12.0' || `calls=${fetchImpl.calls.length}`);

    const c = await uc.readUpdate({ force: true });
    check('24. force=1 绕过缓存（多打一次）', () =>
      fetchImpl.calls.length === 2 && c.cached === false || `calls=${fetchImpl.calls.length}`);

    clock += 1001;
    const d = await uc.readUpdate({});
    check('25. TTL 过期后重新请求', () => fetchImpl.calls.length === 3 && d.cached === false || `calls=${fetchImpl.calls.length}`);

    clock += 500;
    const e = await uc.readUpdate({});
    check('25b. 重新请求后的结果又进了缓存', () => fetchImpl.calls.length === 3 && e.cached === true);
  }
  {
    let resolveFetch = null;
    const fetchImpl = fakeFetch(
      () =>
        new Promise((resolve) => {
          resolveFetch = () => resolve(jsonResponse(200, releaseFixture({ tag: 'v0.12.0' })));
        })
    );
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });

    const p1 = uc.readUpdate({ force: true });
    const p2 = uc.readUpdate({ force: true });
    const p3 = uc.readUpdate({ force: true });
    // 让三个请求都进到「等待网络」的状态
    await new Promise((r) => setTimeout(r, 10));
    resolveFetch();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    check('26. 三个并发 force=1 只真正请求 GitHub 一次（single-flight）', () =>
      fetchImpl.calls.length === 1 || `calls=${fetchImpl.calls.length}`);
    check('26b. 并发请求拿到的是同一份结果', () =>
      r1 === r2 && r2 === r3 && r1.latestVersion === '0.12.0' || '三个 Promise 结果不是同一个对象');
  }
  {
    /* 普通请求 + force 同时到达：也只打一次（force 只是「别用缓存」，不是「再打一次」） */
    let resolveFetch = null;
    const fetchImpl = fakeFetch(
      () =>
        new Promise((resolve) => {
          resolveFetch = () => resolve(jsonResponse(200, releaseFixture({ tag: 'v0.12.0' })));
        })
    );
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const p1 = uc.readUpdate({});
    const p2 = uc.readUpdate({ force: true });
    await new Promise((r) => setTimeout(r, 10));
    resolveFetch();
    await Promise.all([p1, p2]);
    check('26c. 普通请求与 force 并发时同样只打一次', () => fetchImpl.calls.length === 1 || `calls=${fetchImpl.calls.length}`);
  }

  /* ================= 4. 隐私 ================= */
  console.log('\n--- 4. 隐私：请求里到底发了什么 ---');

  {
    /* 用一组「一旦泄漏就能被 grep 抓到」的哨兵值。它们代表 Pi GUI 手上
     * 真实存在、但**绝不该**出现在更新检查请求里的东西。 */
    const SENTINELS = {
      cwd: 'C:\\Users\\21022\\secret-project',
      token: 'deadbeefdeadbeefdeadbeefdeadbeef',
      session: 'sess-abc123-should-never-be-sent',
      model: 'deepseek-chat',
      provider: 'deepseek',
      diagnostics: 'pi-gui-diagnostics-marker',
    };
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: 'v0.12.0' })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    await uc.readUpdate({});
    const call = fetchImpl.calls[0];
    const wire = JSON.stringify({ url: call.url, headers: call.headers, body: call.body, method: call.method });

    check('27. 请求 URL 不含 cwd / 项目名', () =>
      call.url === RELEASE_API && !wire.includes(SENTINELS.cwd) && !wire.includes('secret-project') || call.url);
    check('28. 请求 headers 不含 Pi GUI 令牌', () =>
      !wire.toLowerCase().includes('token') && !wire.includes(SENTINELS.token) || JSON.stringify(call.headers));
    check('29. 不发送 session 信息', () => !wire.includes(SENTINELS.session) && !wire.toLowerCase().includes('session'));
    check('30. 不发送 model / provider', () =>
      !wire.includes(SENTINELS.model) && !wire.includes(SENTINELS.provider));
    check('31. 不发送 Diagnostics 内容', () => !wire.includes(SENTINELS.diagnostics) && !wire.toLowerCase().includes('diagnostic'));
    check('31b. headers 只有 GitHub 必需的 User-Agent 与 Accept 两项', () => {
      const keys = Object.keys(call.headers).sort();
      return (keys.length === 2 && keys[0] === 'Accept' && keys[1] === 'User-Agent') || keys.join(',');
    });
    check('31c. 不带 Authorization / Cookie', () =>
      !Object.keys(call.headers).some((k) => /authorization|cookie/i.test(k)) || Object.keys(call.headers).join(','));
    check('31d. 是 GET 且没有请求体', () => call.method === undefined && call.body === undefined);
    check('31e. 请求带 AbortSignal（timeout 真的接在 fetch 上）', () => Boolean(call.signal));
    check('31f. User-Agent 只带版本号，不带机器/用户名信息', () => {
      const ua = call.headers['User-Agent'];
      return /^pi-gui\/[0-9][0-9A-Za-z.\-+]*$/.test(ua) || ua;
    });
  }
  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: 'v0.12.0' })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('31g. 响应里不带 header / 状态码 / 堆栈等技术细节', () => {
      const wire = JSON.stringify(r);
      return (
        !wire.includes('x-ratelimit') &&
        !wire.includes('etag') &&
        !wire.includes('stack') &&
        !wire.includes('headers') &&
        !/at .*\(.*:\d+:\d+\)/.test(wire) ||
        wire.slice(0, 200)
      );
    });
  }
  {
    /* 失败响应同样不能带技术细节 */
    const fetchImpl = fakeFetch(() => jsonResponse(403, { message: 'API rate limit exceeded for 1.2.3.4' }, { 'x-ratelimit-remaining': '0' }));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const r = await uc.readUpdate({});
    check('31h. 失败响应也不回显 GitHub 的原文与 IP', () =>
      !JSON.stringify(r).includes('1.2.3.4') && !JSON.stringify(r).includes('rate limit exceeded') || JSON.stringify(r));
  }

  /* ================= 5. 路由与鉴权 ================= */
  console.log('\n--- 5. 路由与本地鉴权 ---');

  const { createRouter } = await import('../server/router.js');
  const { createAuth } = await import('../server/auth.js');

  {
    const fetchImpl = fakeFetch(() => jsonResponse(200, releaseFixture({ tag: 'v0.12.0' })));
    const uc = createUpdateCheck({ version: '0.11.1', fetchImpl });
    const noop = () => {};
    const router = createRouter({
      auth: createAuth({ token: 'T', port: 7788, appId: 'pi-gui', protocol: 1, version: '0.11.1' }),
      sse: { subscribe: noop },
      rpc: { send: noop, restart: noop, getState: () => ({}) },
      providers: { handle: noop, handleModels: noop },
      projects: { handle: noop, handleFs: noop },
      projectConfig: { handle: noop },
      skills: { handle: noop },
      mcp: { handle: noop },
      sessions: { handle: noop },
      sessionSearch: { handle: noop },
      planner: { handle: noop },
      gitRoutes: { handle: noop },
      uploads: { handle: noop },
      diagnostics: { handle: noop },
      updateCheck: uc,
    });
    const hit = (method, url, headers = {}) => {
      const res = mockRes();
      router(mockReq({ method, url, headers }), res);
      return res;
    };
    const AUTH = { 'x-pi-gui-token': 'T' };
    const settle = () => new Promise((r) => setTimeout(r, 30));

    const r1 = hit('GET', '/api/update', AUTH);
    await settle();
    check('32. GET /api/update → 200 且 ok:true', () =>
      r1.code === 200 && r1.json().ok === true && r1.json().latestVersion === '0.12.0' || r1.body().slice(0, 200));
    const callsAfterGet = fetchImpl.calls.length;

    const r2 = hit('GET', '/api/update', AUTH);
    await settle();
    check('32b. 紧接着再 GET 走缓存（cached:true，不再打网络）', () =>
      r2.json().cached === true && fetchImpl.calls.length === callsAfterGet || `calls=${fetchImpl.calls.length}`);

    const r3 = hit('GET', '/api/update?force=1', AUTH);
    await settle();
    check('33. GET /api/update?force=1 绕过缓存', () =>
      r3.json().cached === false && fetchImpl.calls.length === callsAfterGet + 1 || `calls=${fetchImpl.calls.length}`);

    const r4 = hit('POST', '/api/update', AUTH);
    await settle();
    check('34. POST /api/update → 405（不是被静态资源兜底吞掉）', () =>
      r4.code === 405 && r4.json().ok === false || `code=${r4.code} body=${r4.body().slice(0, 120)}`);

    const r5 = hit('GET', '/api/update');
    await settle();
    check('35. /api/update 仍经过本地 API 鉴权（无令牌 → 401）', () =>
      r5.code === 401 && r5.json().ok === false || `code=${r5.code}`);
    check('35b. 鉴权失败时不会顺手去打 GitHub', () => fetchImpl.calls.length === callsAfterGet + 1 || `calls=${fetchImpl.calls.length}`);

    const r6 = hit('GET', '/api/update', { origin: 'https://evil.example', 'x-pi-gui-token': 'T' });
    await settle();
    check('35c. 跨站 Origin → 403（和其余 /api/* 同一条规则）', () => r6.code === 403 || `code=${r6.code}`);

    const r7 = hit('PUT', '/api/update', AUTH);
    await settle();
    check('34b. PUT /api/update → 405', () => r7.code === 405);
  }
  {
    /* 没注入 updateCheck 的 router（老调用方 / 单测）不能把请求打成 500 */
    const router = createRouter({
      auth: createAuth({ token: '', port: 7788, appId: 'pi-gui', protocol: 1, version: '0.11.1' }),
      sse: { subscribe: () => {} },
      rpc: { send: () => {}, restart: () => {}, getState: () => ({}) },
      providers: { handle: () => {}, handleModels: () => {} },
      projects: { handle: () => {}, handleFs: () => {} },
      projectConfig: { handle: () => {} },
      skills: { handle: () => {} },
      mcp: { handle: () => {} },
      sessions: { handle: () => {} },
      sessionSearch: { handle: () => {} },
      planner: { handle: () => {} },
      gitRoutes: { handle: () => {} },
      uploads: { handle: () => {} },
      diagnostics: { handle: () => {} },
    });
    const res = mockRes();
    router(mockReq({ method: 'GET', url: '/api/update' }), res);
    await new Promise((r) => setTimeout(r, 10));
    check('35d. 未注入 updateCheck 时回 503 而不是崩', () => res.code === 503 || `code=${res.code}`);
  }

  /* ================= 6. 外链白名单 ================= */
  console.log('\n--- 6. Release / 下载外链白名单 ---');

  const ALLOW = [
    ['https://github.com/HYJ1817/pi-gui/releases/tag/v0.12.0', 'Release 页面'],
    ['https://github.com/HYJ1817/pi-gui/releases/download/v0.11.1/Pi-GUI-Setup-0.11.1.exe', '下载 asset'],
    ['https://api.github.com/repos/HYJ1817/pi-gui/releases/latest', 'API 地址'],
    ['https://objects.githubusercontent.com/xxx', '下载重定向落地域'],
    ['https://raw.githubusercontent.com/x/y', 'raw 域'],
    ['HTTPS://GITHUB.COM/x', '大小写不敏感'],
  ];
  for (const [url, why] of ALLOW) {
    check(`允许：${why}`, () => isSafeReleaseUrl(url) === true || url);
  }

  const DENY = [
    ['https://evil.example/a.exe', '第三方 host'],
    ['https://github.com.evil.example/x', '后缀伪装'],
    ['https://evilgithubusercontent.com/x', '后缀伪装（缺那个点）'],
    ['https://evil.github.com/x', '前缀伪装'],
    ['https://user:pw@github.com/x', '带凭据的 URL'],
    ['http://github.com/x', 'http（非 https）'],
    ['javascript:alert(1)', 'javascript:'],
    ['file:///C:/Windows/win.ini', 'file:'],
    ['data:text/html,<script>alert(1)</script>', 'data:'],
    ['ftp://github.com/x', 'ftp:'],
    ['', '空串'],
    ['not a url', '根本不是 URL'],
  ];
  for (const [url, why] of DENY) {
    check(`拒绝：${why}`, () => isSafeReleaseUrl(url) === false || url);
  }

  /* 两份实现必须一致：server/update-check.js（ESM，后端）与
   * electron/net-probe.cjs（CJS，主进程）。它们是两个独立的边界，
   * 名单一旦漂开，就会出现「后端放行、主进程拒绝」这类只有点下去才发现的问题。 */
  {
    const probe = require('../electron/net-probe.cjs');
    const all = [...ALLOW.map(([u]) => u), ...DENY.map(([u]) => u)];
    const drift = all.filter((u) => isSafeReleaseUrl(u) !== probe.isSafeReleaseUrl(u));
    check('两份白名单实现完全一致（后端 ESM ↔ 主进程 CJS）', () =>
      drift.length === 0 || '判定不一致：' + drift.join(' , '));
    check('两份 host 名单也一致', () =>
      JSON.stringify(mod.RELEASE_HOSTS) === JSON.stringify(probe.RELEASE_HOSTS) ||
      `${JSON.stringify(mod.RELEASE_HOSTS)} vs ${JSON.stringify(probe.RELEASE_HOSTS)}`);
  }

  console.log('');
  console.log(`${pass}/${pass + fail} 通过`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
