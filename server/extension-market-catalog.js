/* Extension 插件市场：目录数据的**纯**归一化与查询。
 *
 * 这里没有 I/O：不读盘、不联网、不 spawn。网络与缓存在 `extension-market.js`，
 * 安装在 `extension-packages.js` → `capability-install.js`。拆开的理由是这一层
 * 决定「远端给的东西里哪些能进目录、长什么样」，必须能被单独、离线地测。
 *
 * ---------- 数据来源（2026-11 实测） ----------
 *
 * Pi 生态**没有**统一的市场 API：官方画廊 https://pi.dev/packages 是服务端渲染的
 * 页面，没有公开 JSON 接口；它收录的判据是 npm 包带 `pi-package` 关键词
 * （Pi 文档 `docs/packages.md`）。所以目录直接读 npm registry 的公开搜索接口：
 *
 *     GET https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250&from=N
 *
 * 实测事实（决定了下面的取舍）：
 *   - 命中总数约 1.4 万；单页上限 250；`from` 翻到很深会绕回第一页 ——
 *     **不能**把整个集合枚举下来，所以目录是「搜索排序靠前的一段快照」，
 *     界面必须如实写「收录 M 个 / npm 上共 N 个」，不伪造总数。
 *   - 每条里有维护者的**邮箱**。只取用户名，邮箱不进内存之外的任何地方。
 *   - 没有评分、没有「Pi 内的安装量」。能诚实给出的热度只有 npm 月下载量，
 *     所以排序叫「下载量」，不叫「最热」。
 *
 * ---------- 归一化的纪律 ----------
 *
 *   - 包名必须过**严格**规则（与安装器的 `isControlledSource` 同一条），
 *     过不了的整条丢弃：它将来会成为 argv 的一格。
 *   - 必须自带 `pi-package` 关键词，否则不算 Pi 包（深度搜索的结果尤其要验）。
 *   - 文本一律去控制字符 / 零宽 / 双向控制符并截断；链接只收 https、不带凭据。
 *   - 拿不到的字段就是 null（未知），**不补默认值、不推断**。
 */
import { CAPABILITY_SOURCES, isControlledSource } from './capability-install.js';

export const CATALOG_KEYWORD = 'pi-package';
export const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const GALLERY_URL = 'https://pi.dev/packages';
export const MARKET_PAGE_SIZE = 24;
export const MARKET_MAX_PAGE_SIZE = 48;
export const MAX_QUERY_CHARS = 64;

/** Pi 宿主包。新名在前；旧名在 Pi 1.x 里仍被 loader 映射，但版本线不同。 */
export const PI_HOST_PACKAGES = Object.freeze(['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']);

const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/* ---------------- 文本 / 版本 / 链接 ---------------- */

/* C0/C1 控制字符、零宽字符、双向控制符、BOM：都可能让一段文本「看起来」
 * 不是它实际的内容（例如把包名显示成另一个名字）。 */
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g;

export function cleanText(value, max = 300) {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE_CHARS_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    .replace(/[\ud800-\udbff]$/, '');
}

/* 每段最多 15 位：有的包用时间戳当版本号，而 15 位以内的整数在 double 里仍是精确的。 */
const SEMVER_RE = /^(\d{1,15})\.(\d{1,15})\.(\d{1,15})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 严格 semver（不带 `v` 前缀）。不是就回 null。 */
export function cleanVersion(value) {
  return typeof value === 'string' && value.length <= 64 && SEMVER_RE.test(value) ? value : null;
}

function parseVersion(value) {
  const m = typeof value === 'string' ? SEMVER_RE.exec(value.replace(/^v/, '')) : null;
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null } : null;
}

const cmp3 = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function comparePrerelease(a, b) {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]);
    const ny = /^\d+$/.test(y[i]);
    if (nx && ny) {
      const d = Number(x[i]) - Number(y[i]);
      if (d) return d < 0 ? -1 : 1;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** semver 比较：-1 / 0 / 1；任一边不是严格 semver → null（未知，不猜）。 */
export function compareSemver(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  const core = cmp3(x.parts, y.parts);
  if (core) return core < 0 ? -1 : 1;
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return comparePrerelease(x.pre, y.pre);
}

export function cleanDate(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < Date.UTC(2010, 0, 1) || ms > Date.UTC(2100, 0, 1)) return null;
  return new Date(ms).toISOString();
}

/** npm 用户名。带空格的（例如 CI 发布者 "GitHub Actions"）不是用户名，回 null。 */
export function cleanHandle(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : null;
}

/**
 * 外链：只收 https、不带凭据。`repository` 形态额外接受 npm 的写法
 * （`git+https://….git`、`github:user/repo`、`user/repo`）并收敛成网页地址。
 */
export function cleanLink(value, { repository = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 400) return null;
  let text = value.trim();
  if (repository) {
    text = text.replace(/^git\+/, '');
    const short = /^(?:github:)?([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(text);
    if (short) text = `https://github.com/${short[1]}/${short[2]}`;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
  if (repository) url.pathname = url.pathname.replace(/\.git$/, '');
  /* `URL#href` 已经把控制字符与非 ASCII 百分号编码了，这里只需要限长。 */
  const href = url.href;
  return href.length <= 300 ? href : null;
}

const MAX_KEYWORDS = 40;

/**
 * 关键词：小写、去重、限长限量。
 *
 * 有的包把几十个关键词堆在 `pi-package` 前面（实测前 500 个里有 4 个把它排在
 * 第 30 位之后）。所以「是不是 Pi 包」要在**整个**数组里找，找到就把它放在
 * 第一位 —— 这样截断与磁盘缓存往返都不会把这个判据弄丢。
 */
export function cleanKeywords(value) {
  if (!Array.isArray(value)) return [];
  const words = [];
  const seen = new Set();
  for (const raw of value.slice(0, 200)) {
    const word = cleanText(raw, 40).toLowerCase();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  if (!seen.has(CATALOG_KEYWORD)) return words.slice(0, MAX_KEYWORDS);
  return [CATALOG_KEYWORD, ...words.filter((word) => word !== CATALOG_KEYWORD)].slice(0, MAX_KEYWORDS);
}

/* ---------------- 标识 ---------------- */

/** 目录条目 id：`npm:<严格包名>`。它同时就是交给安装器的 source。 */
export function marketIdOf(name) {
  return `npm:${name}`;
}

/** id → 包名；形状不对回 null。**与安装器共用同一条判据**，不另写一份。 */
export function nameOfMarketId(id) {
  return isControlledSource(id) ? id.slice(4) : null;
}

const KNOWN_BY_NAME = new Map(Object.entries(CAPABILITY_SOURCES).map(([id, source], index) => [source.slice(4), { id, index }]));

/** 包名 → Pi GUI 自己维护的已知能力 id（web / subagents / memory / browser）或 null。 */
export function knownCapabilityOf(name) {
  return KNOWN_BY_NAME.get(name)?.id || null;
}

/* ---------------- 分类 ---------------- */

/**
 * 分类是 **Pi GUI 按包自带的 npm 关键词归的**，不是 npm 或 Pi 官方给的字段
 * （npm 没有分类）。规则来自对实际目录前 500 个包关键词频次的统计；
 * 归不进任何一类的就是「其他」，不硬凑。
 */
export const MARKET_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'devtools', label: '开发工具' }),
  Object.freeze({ id: 'agents', label: '智能体与工作流' }),
  Object.freeze({ id: 'productivity', label: '效率工具' }),
  Object.freeze({ id: 'web', label: '网页与搜索' }),
  Object.freeze({ id: 'desktop', label: '桌面与系统' }),
  Object.freeze({ id: 'memory', label: '记忆与知识库' }),
  Object.freeze({ id: 'models', label: '模型与供应商' }),
  Object.freeze({ id: 'integrations', label: '第三方接入' }),
  Object.freeze({ id: 'other', label: '其他' }),
]);
const CATEGORY_IDS = new Set(MARKET_CATEGORIES.map((c) => c.id));

/* 同分时的固定次序：越专门的类别越靠前，宽泛的（开发 / 效率）垫底。 */
const CATEGORY_PRIORITY = ['agents', 'memory', 'models', 'integrations', 'web', 'desktop', 'devtools', 'productivity'];

/* [类别, 权重, 关键词…]。权重 3 = 这个词基本就是在说这个类别；1 = 只在没有
 * 更强信号时才起作用。泛词（pi / ai / agent / llm / cli / typescript…）不参与。 */
const CATEGORY_RULES = [
  ['agents', 3, 'subagents subagent multi-agent orchestration agent-orchestration delegation swarm agent-team agent-teams supervisor'],
  ['agents', 2, 'workflow workflows autonomous planning planner plan-mode handoff goal goals loop parallel'],
  ['memory', 3, 'memory long-term-memory knowledge-base knowledge-graph rag embeddings vector vector-search compaction recall'],
  ['memory', 2, 'context context-management knowledge notes obsidian session-search transcript history wiki'],
  ['models', 3, 'provider providers model-provider llm-provider openrouter ollama lmstudio bedrock vertex local-llm'],
  ['models', 2, 'openai anthropic gemini kimi moonshot deepseek glm zhipu qwen dashscope minimax alibaba copilot github-copilot groq mistral xai grok cerebras nvidia azure antigravity models model model-switcher quota oauth'],
  ['integrations', 3, 'mcp model-context-protocol mcp-server mcp-client acp agent-client-protocol a2a'],
  ['integrations', 2, 'telegram slack discord github gitlab jira linear notion feishu lark wechat dingtalk email gmail webhook zed vscode neovim nvim jetbrains ide'],
  ['integrations', 1, 'claude-code codex opencode cursor claude'],
  ['web', 3, 'web-search websearch web-scraping browser-automation web-automation deep-research web-fetch'],
  ['web', 2, 'web browser playwright puppeteer scraping crawler search chrome cdp fetch research exa tavily brave perplexity firecrawl youtube'],
  ['desktop', 3, 'computer-use desktop macos linux windows'],
  ['desktop', 2, 'terminal shell bash zsh powershell tmux ssh docker sandbox notifications notification clipboard voice speech tts stt audio screenshot system'],
  ['devtools', 3, 'developer-tools devtools dev-tools code-review linter lint lsp debugger'],
  ['devtools', 2, 'git tdd testing test review diagnostics debug debugging ci ci-cd observability tracing telemetry security guardrails policy permissions approval refactoring code-search codebase ast formatter'],
  ['productivity', 3, 'productivity todo todos statusline status-line prompt-templates'],
  ['productivity', 2, 'tasks task automation template templates prompt prompts footer tui terminal-ui theme themes pi-theme markdown pdf cron scheduler usage stats dashboard web-ui session sessions export shortcuts keybindings commands slash-commands'],
  ['productivity', 1, 'skills agent-skills agent-skill pi-skill'],
];
const KEYWORD_CATEGORY = new Map();
for (const [category, weight, words] of CATEGORY_RULES) {
  for (const word of words.split(' ')) if (!KEYWORD_CATEGORY.has(word)) KEYWORD_CATEGORY.set(word, [category, weight]);
}

/* 四个已知能力由 Pi GUI 自己维护，分类直接指定，不靠关键词猜。 */
const KNOWN_CATEGORY = Object.freeze({
  'pi-web-access': 'web',
  'pi-subagents': 'agents',
  'pi-memory': 'memory',
  'pi-browser-harness': 'web',
});

export function categorize(keywords, name = '') {
  if (Object.prototype.hasOwnProperty.call(KNOWN_CATEGORY, name)) return KNOWN_CATEGORY[name];
  const score = new Map();
  for (const word of Array.isArray(keywords) ? keywords : []) {
    const hit = KEYWORD_CATEGORY.get(word);
    if (hit) score.set(hit[0], (score.get(hit[0]) || 0) + hit[1]);
  }
  let best = 'other';
  let top = 0;
  for (const id of CATEGORY_PRIORITY) {
    const value = score.get(id) || 0;
    if (value > top) {
      best = id;
      top = value;
    }
  }
  return best;
}

/* 卡片上的标签：包**自己写的**关键词里前三个非泛词。不造标签。 */
const GENERIC_KEYWORDS = new Set([CATALOG_KEYWORD, 'pi', 'pi-extension', 'pi-extensions', 'pi-coding-agent', 'coding-agent',
  'extension', 'extensions', 'ai', 'pi-agent', 'agent', 'agents', 'ai-agent', 'ai-agents', 'llm', 'cli', 'typescript', 'javascript']);

export function displayTags(keywords) {
  return (Array.isArray(keywords) ? keywords : []).filter((word) => !GENERIC_KEYWORDS.has(word)).slice(0, 3);
}

/* ---------------- 目录条目 ---------------- */

/** 只有名字的空条目：其余字段都是「未知」。已安装但不在目录里的包也用它。 */
export function emptyMarketItem(name) {
  const known = KNOWN_BY_NAME.get(name) || null;
  return {
    id: marketIdOf(name),
    name,
    description: null,
    version: null,
    maintainer: null,
    updatedAt: null,
    keywords: [],
    tags: [],
    category: categorize([], name),
    downloadsMonthly: null,
    license: null,
    links: { npm: `https://www.npmjs.com/package/${name}`, repository: null, homepage: null },
    known: known ? known.id : null,
    knownOrder: known ? known.index : null,
    flagged: false,
    rank: null,
  };
}

/* 没有远端目录时四个已知能力的一句话说明（Pi GUI 自己写的事实描述）。
 * 目录里有这个包时，以包自己的 description 为准。 */
const KNOWN_DESCRIPTION = Object.freeze({
  'pi-web-access': '网页搜索、网页抓取、PDF 提取与视频理解。',
  'pi-subagents': '把任务委派给子智能体，或按脚本编排多智能体工作流。',
  'pi-memory': '跨会话记忆：每日日志、长期记忆与草稿板，支持语义检索。',
  'pi-browser-harness': '通过 CDP 控制真实 Chrome：导航、点击、输入、截图与提取数据。',
});

/** 内置条目：四个已知能力。离线、未同意联网时目录里也有它们（版本等字段未知）。 */
export function builtinMarketItems() {
  return [...KNOWN_BY_NAME.keys()].map((name) => ({ ...emptyMarketItem(name), description: KNOWN_DESCRIPTION[name] || null }));
}

/**
 * npm 搜索结果的一行 → 目录条目；不是合格的 Pi 包就回 null。
 *
 * 真实形状（节选）：`{ package: { name, version, description, keywords[], date,
 * license, links: { npm, homepage, repository, bugs }, publisher: { username, email },
 * maintainers: [{ username, email }] }, downloads: { monthly, weekly },
 * flags: { insecure }, score, searchScore }`。
 */
export function normalizeSearchObject(row, rank = null) {
  const pkg = isRecord(row) && isRecord(row.package) ? row.package : null;
  if (!pkg || typeof pkg.name !== 'string' || !isControlledSource(marketIdOf(pkg.name))) return null;
  const keywords = cleanKeywords(pkg.keywords);
  if (!keywords.includes(CATALOG_KEYWORD)) return null;
  const item = emptyMarketItem(pkg.name);
  const maintainers = Array.isArray(pkg.maintainers) ? pkg.maintainers : [];
  const links = isRecord(pkg.links) ? pkg.links : {};
  const monthly = isRecord(row.downloads) ? row.downloads.monthly : null;
  item.description = cleanText(pkg.description, 300) || null;
  item.version = cleanVersion(pkg.version);
  /* 只取用户名。邮箱在同一个对象里，**不读**。 */
  item.maintainer = cleanHandle(isRecord(maintainers[0]) ? maintainers[0].username : null)
    || cleanHandle(isRecord(pkg.publisher) ? pkg.publisher.username : null);
  item.updatedAt = cleanDate(pkg.date);
  item.keywords = keywords;
  item.tags = displayTags(keywords);
  item.category = categorize(keywords, pkg.name);
  item.downloadsMonthly = Number.isSafeInteger(monthly) && monthly >= 0 ? monthly : null;
  item.license = (typeof pkg.license === 'string' && cleanText(pkg.license, 40)) || null;
  item.links.repository = cleanLink(links.repository, { repository: true });
  item.links.homepage = cleanLink(links.homepage);
  /* npm 自己标记为不安全的包：进目录（让用户看得到原因），但不给安装。 */
  item.flagged = isRecord(row.flags) && Boolean(row.flags.insecure);
  item.rank = Number.isSafeInteger(rank) && rank >= 0 ? rank : null;
  return item;
}

/**
 * 磁盘缓存里的一条 → 目录条目。缓存是自己写的，但仍按「不可信输入」重新过一遍：
 * 文件可能被别的程序改过，分类规则也可能随版本变了（所以分类与标签是重算的）。
 */
export function reviveCatalogItem(raw) {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !isControlledSource(marketIdOf(raw.name))) return null;
  const keywords = cleanKeywords(raw.keywords);
  if (!keywords.includes(CATALOG_KEYWORD)) return null;
  const item = emptyMarketItem(raw.name);
  const links = isRecord(raw.links) ? raw.links : {};
  item.description = cleanText(raw.description, 300) || null;
  item.version = cleanVersion(raw.version);
  item.maintainer = cleanHandle(raw.maintainer);
  item.updatedAt = cleanDate(raw.updatedAt);
  item.keywords = keywords;
  item.tags = displayTags(keywords);
  item.category = categorize(keywords, raw.name);
  item.downloadsMonthly = Number.isSafeInteger(raw.downloadsMonthly) && raw.downloadsMonthly >= 0 ? raw.downloadsMonthly : null;
  item.license = (typeof raw.license === 'string' && cleanText(raw.license, 40)) || null;
  item.links.repository = cleanLink(links.repository);
  item.links.homepage = cleanLink(links.homepage);
  item.flagged = raw.flagged === true;
  item.rank = Number.isSafeInteger(raw.rank) && raw.rank >= 0 ? raw.rank : null;
  return item;
}

/* ---------------- 查询：搜索 / 分类 / 排序 / 分页 ---------------- */

export const MARKET_SORTS = Object.freeze([
  Object.freeze({ id: 'recommended', label: '推荐' }),
  Object.freeze({ id: 'downloads', label: '下载量' }),
  Object.freeze({ id: 'updated', label: '最新' }),
  Object.freeze({ id: 'name', label: '名称' }),
]);
const SORT_IDS = new Set(MARKET_SORTS.map((s) => s.id));

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'string' && /^\d{1,7}$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** URLSearchParams → 受控的查询对象。认不出的值回默认，不报错。 */
export function parseMarketQuery(params) {
  const get = (key) => (params && typeof params.get === 'function' ? params.get(key) : null);
  const category = get('category');
  const sort = get('sort');
  return {
    q: cleanText(get('q') || '', MAX_QUERY_CHARS),
    category: typeof category === 'string' && CATEGORY_IDS.has(category) ? category : 'all',
    sort: typeof sort === 'string' && SORT_IDS.has(sort) ? sort : 'recommended',
    offset: clampInt(get('offset'), 0, 0, 100000),
    limit: clampInt(get('limit'), MARKET_PAGE_SIZE, 1, MARKET_MAX_PAGE_SIZE),
    deep: get('deep') === '1',
  };
}

export function searchTokens(q) {
  return cleanText(q, MAX_QUERY_CHARS).toLowerCase().split(' ').filter(Boolean).slice(0, 8);
}

/** 所有词都要出现（名称 / 简介 / 关键词 / 维护者里任意一处）。 */
export function matchesTokens(item, tokens) {
  if (!tokens.length) return true;
  const hay = `${item.name} ${item.description || ''} ${item.keywords.join(' ')} ${item.maintainer || ''}`.toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const orInfinity = (value) => (value === null || value === undefined ? Infinity : value);
/* 推荐序 = Pi GUI 自己维护并验证过的四个能力在前（固定次序），其余按 npm 搜索
 * 自己的相关度名次。这是能说清楚依据的次序，不是编出来的「热门」。 */
const byRecommended = (a, b) => (orInfinity(a.knownOrder) - orInfinity(b.knownOrder))
  || (orInfinity(a.rank) - orInfinity(b.rank)) || byName(a, b);

/* 未知值永远排在最后，不当成 0 参与比较。 */
const unknownLast = (a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0);

const SORTERS = {
  recommended: byRecommended,
  downloads: (a, b) => unknownLast(a.downloadsMonthly, b.downloadsMonthly)
    || ((b.downloadsMonthly || 0) - (a.downloadsMonthly || 0)) || byRecommended(a, b),
  /* updatedAt 都是 `toISOString()` 的产物，字典序就是时间序。 */
  updated: (a, b) => unknownLast(a.updatedAt, b.updatedAt)
    || (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1) || byRecommended(a, b),
  name: byName,
};

export function sortMarketItems(items, sort) {
  return [...items].sort(SORTERS[SORT_IDS.has(sort) ? sort : 'recommended']);
}

/** 哪些排序此刻有数据支撑：没有远端快照时下载量 / 更新时间都是未知，不给排。 */
export function availableSorts(items) {
  const hasDownloads = items.some((item) => item.downloadsMonthly !== null);
  const hasDates = items.some((item) => item.updatedAt !== null);
  return MARKET_SORTS.map((sort) => ({
    ...sort,
    available: sort.id === 'downloads' ? hasDownloads : sort.id === 'updated' ? hasDates : true,
  }));
}

/** 类别清单取自**整份目录里真实出现过**的类别；数字是当前搜索词下的命中数。 */
export function categoryCounts(catalog, matched) {
  const present = new Set(catalog.map((item) => item.category));
  const counts = new Map();
  for (const item of matched) counts.set(item.category, (counts.get(item.category) || 0) + 1);
  return [
    { id: 'all', label: '全部', count: matched.length },
    ...MARKET_CATEGORIES.filter((c) => present.has(c.id)).map((c) => ({ ...c, count: counts.get(c.id) || 0 })),
  ];
}

/* ---------------- 远端地址 ---------------- */

export function searchUrl({ text = '', size = 250, from = 0 } = {}) {
  const url = new URL('/-/v1/search', REGISTRY_ORIGIN);
  url.searchParams.set('text', text ? `keywords:${CATALOG_KEYWORD} ${text}` : `keywords:${CATALOG_KEYWORD}`);
  url.searchParams.set('size', String(size));
  if (from) url.searchParams.set('from', String(from));
  return url.toString();
}

/** 调用方必须先用 `nameOfMarketId` 验过包名。 */
export function manifestUrl(name) {
  return `${REGISTRY_ORIGIN}/${name.replace('/', '%2F')}/latest`;
}

/**
 * 深度搜索的词：只留字母数字与少量标点。尤其去掉 `:` —— npm 搜索把
 * `keywords:` / `author:` / `not:` 当限定符，用户输入不能改写我们固定的限定条件。
 */
export function deepSearchText(q) {
  const text = cleanText(q, MAX_QUERY_CHARS).replace(/[^\p{L}\p{N}._@/ -]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return text.length >= 2 ? text : '';
}

/* ---------------- 兼容性（只是提示） ---------------- */

function parsePartial(text) {
  const m = /^v?(\d{1,15}|[xX*])(?:\.(\d{1,15}|[xX*]))?(?:\.(\d{1,15}|[xX*]))?$/.exec(text);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].map((s) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s)));
  /* 通配之后不能再出现具体数字（1.x.3 不是合法写法）。 */
  if ((parts[0] === null && (parts[1] !== null || parts[2] !== null)) || (parts[1] === null && parts[2] !== null)) return null;
  return parts;
}

function comparator(token) {
  const m = /^(>=|<=|>|<|=|\^|~>?)?(.+)$/.exec(token);
  const partial = m ? parsePartial(m[2]) : null;
  if (!partial) return null;
  const op = m[1] || '=';
  const [major, minor, patch] = partial;
  if (major === null) return op === '>' || op === '<' ? () => false : () => true;
  const lo = [major, minor ?? 0, patch ?? 0];
  /* 不完整版本号代表的区间的（开）上界：1 → 2.0.0，1.2 → 1.3.0。 */
  const next = minor === null ? [major + 1, 0, 0] : patch === null ? [major, minor + 1, 0] : null;
  if (op === '=') return next ? (v) => cmp3(v, lo) >= 0 && cmp3(v, next) < 0 : (v) => cmp3(v, lo) === 0;
  if (op === '>=') return (v) => cmp3(v, lo) >= 0;
  if (op === '>') return next ? (v) => cmp3(v, next) >= 0 : (v) => cmp3(v, lo) > 0;
  if (op === '<=') return next ? (v) => cmp3(v, next) < 0 : (v) => cmp3(v, lo) <= 0;
  if (op === '<') return (v) => cmp3(v, lo) < 0;
  let hi;
  if (op === '^') {
    if (major > 0 || minor === null) hi = [major + 1, 0, 0];
    else if (minor > 0 || patch === null) hi = [0, minor + 1, 0];
    else hi = [0, 0, patch + 1];
  } else hi = minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0];
  return (v) => cmp3(v, lo) >= 0 && cmp3(v, hi) < 0;
}

/**
 * `version` 是否落在 `range` 里：true / false / **null（这个子集判断不了）**。
 *
 * 只实现常见写法（`*`、`>=1.2.3`、`^1.2`、`~1.2.3`、`1.x`、空格相与、`||` 相或）。
 * 连字符区间、带预发布标签的比较等一律回 null —— 宁可说「未知」也不误判。
 */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed || parsed.pre || typeof range !== 'string' || range.length > 120) return null;
  let unknown = false;
  for (const alternative of range.split('||')) {
    const text = alternative.trim().replace(/(>=|<=|>|<|=|\^|~>?)\s+/g, '$1');
    if (/\s-\s/.test(text)) {
      unknown = true;
      continue;
    }
    const tokens = text.split(/\s+/).filter(Boolean);
    let verdict = true;
    for (const token of tokens) {
      const test = comparator(token);
      if (!test) {
        if (verdict !== false) verdict = null;
      } else if (!test(parsed.parts)) verdict = false;
    }
    if (verdict === true) return true;
    if (verdict === null) unknown = true;
  }
  return unknown ? null : false;
}

/**
 * 包声明的 Pi 版本要求与当前 Pi 的对照。**只是提示**：Pi 安装包时不强制 peer
 * 版本（它传 `--legacy-peer-deps`，见 Pi 的 `docs/packages.md`），所以这里的
 * 「不满足」不等于「装不上」。
 *
 * status：compatible / incompatible / unconstrained（声明了 `*`）/
 *         undeclared（没声明）/ unknown（判断不了）。
 */
export function compatibility(peer, piVersion) {
  const current = cleanVersion(piVersion);
  if (!peer) return { status: 'undeclared', peer: null, range: null, piVersion: current, legacy: false };
  const legacy = peer.name !== PI_HOST_PACKAGES[0];
  const base = { peer: peer.name, range: peer.range, piVersion: current, legacy };
  if (peer.range === '*' || peer.range === '' || /^[xX]$/.test(peer.range)) return { status: 'unconstrained', ...base };
  /* 旧包名的版本线与当前 Pi 不是同一条，区间没法对照。 */
  if (legacy || !current) return { status: 'unknown', ...base };
  const verdict = satisfiesRange(current, peer.range);
  return { status: verdict === true ? 'compatible' : verdict === false ? 'incompatible' : 'unknown', ...base };
}

/* ---------------- 包清单（详情） ---------------- */

function authorName(value) {
  const raw = isRecord(value) ? value.name : value;
  if (typeof raw !== 'string') return null;
  /* 字符串形态是 "Name <email> (url)"：只留名字。 */
  return cleanText(raw.replace(/<[^>]*>/g, ' ').replace(/\([^)]*\)/g, ' '), 80) || null;
}

const countStrings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').length : null);
const sizeOf = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * `GET <registry>/<name>/latest` 的清单 → 详情里要展示的**事实**。
 *
 * 只取结构与少量文本；脚本只记**名字**（内容不出后端）。名字对不上 /
 * 版本不是 semver 就整份不认（回 null）。
 *
 * Pi 没有声明式的 Extension 权限清单 —— 这里给的不是「权限」，而是能从清单
 * 读出来的、与风险直接相关的事实：会不会在安装时跑脚本、带多少依赖、带哪些资源。
 */
export function normalizeManifest(data, expectedName) {
  if (!isRecord(data) || data.name !== expectedName) return null;
  const version = cleanVersion(data.version);
  if (!version) return null;
  const pi = isRecord(data.pi) ? data.pi : null;
  const scripts = isRecord(data.scripts) ? data.scripts : {};
  const peers = isRecord(data.peerDependencies) ? data.peerDependencies : {};
  const dist = isRecord(data.dist) ? data.dist : {};
  const engines = isRecord(data.engines) ? data.engines : {};
  const host = PI_HOST_PACKAGES.find((name) => typeof peers[name] === 'string');
  const repository = isRecord(data.repository) ? data.repository.url : data.repository;
  const license = isRecord(data.license) ? data.license.type : data.license;
  return {
    name: expectedName,
    version,
    description: cleanText(data.description, 600) || null,
    license: (typeof license === 'string' && cleanText(license, 40)) || null,
    author: authorName(data.author),
    publishedBy: cleanHandle(isRecord(data._npmUser) ? data._npmUser.name : null),
    links: {
      npm: `https://www.npmjs.com/package/${expectedName}`,
      repository: cleanLink(repository, { repository: true }),
      homepage: cleanLink(data.homepage),
    },
    /* 没有 `pi` 字段的包按约定目录（extensions/ skills/ prompts/ themes/）加载，
     * 数量从清单里读不出来 —— 那就是 null，不是 0。 */
    declaresResources: Boolean(pi),
    resources: {
      extensions: pi ? countStrings(pi.extensions) : null,
      skills: pi ? countStrings(pi.skills) : null,
      prompts: pi ? countStrings(pi.prompts) : null,
      themes: pi ? countStrings(pi.themes) : null,
    },
    /* Pi 调包管理器安装时**不带** `--ignore-scripts`：这些脚本会在安装时以当前用户身份运行。 */
    installScripts: ['preinstall', 'install', 'postinstall'].filter((key) => typeof scripts[key] === 'string' && scripts[key].trim()),
    dependencyCount: isRecord(data.dependencies) ? Object.keys(data.dependencies).length : 0,
    unpackedSize: sizeOf(dist.unpackedSize),
    fileCount: sizeOf(dist.fileCount),
    integrity: typeof dist.integrity === 'string' && dist.integrity.length > 0,
    signatures: Array.isArray(dist.signatures) && dist.signatures.length > 0,
    provenance: isRecord(dist.attestations) && isRecord(dist.attestations.provenance),
    nodeRange: (typeof engines.node === 'string' && cleanText(engines.node, 60)) || null,
    peer: host ? { name: host, range: cleanText(peers[host], 60) } : null,
    deprecated: typeof data.deprecated === 'string' && data.deprecated.trim() ? cleanText(data.deprecated, 200) : null,
  };
}
