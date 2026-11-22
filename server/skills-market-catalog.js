/* 技能市场的纯数据与纯函数：默认目录源、分类、把一份「仓库文件清单」变成技能条目、
 * 内容完整性校验。这里不读盘、不联网，全部可以直接单测。
 *
 * 目录源就是公开的 GitHub 技能仓库（PI-Desktop 用的是同一批）。一个技能 = 仓库里
 * 一个含 SKILL.md 的目录；它的**全部**文件（脚本、参考资料、模板）都算这个技能的，
 * 不只是 Markdown。 */
import crypto from 'node:crypto';
import { sanitizeSkillSlug } from './skills-document.js';
import { BUNDLE_LIMITS, classifyBundlePath, formatBytes } from './skills-files.js';

const SKILL_FILE = 'SKILL.md';

export const MARKET_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'workflow', label: '工作流' }),
  Object.freeze({ id: 'writing', label: '写作' }),
  Object.freeze({ id: 'coding', label: '编程' }),
  Object.freeze({ id: 'data', label: '数据' }),
  Object.freeze({ id: 'docs', label: '文档' }),
]);

/* 顺序有意义：第一个命中的分类生效（与 PI-Desktop 的 guessSkillCategories 同表同序）。 */
const CATEGORY_KEYWORDS = [
  ['data', ['data', 'sql', 'database', 'postgres', 'mongo', 'redis', 'analytics', 'dataset', 'spreadsheet', 'excel', 'xlsx', 'csv', 'dashboard', 'chart', 'visualization']],
  ['workflow', ['workflow', 'review', 'planning', 'brainstorm', 'checklist', 'process', 'sop', 'handoff', 'standup', 'retro', 'discernment', 'verification', 'triage', 'audit', 'security', 'incident']],
  ['coding', ['code', 'test', 'debug', 'api', 'git-', 'dev', 'engineer', 'typescript', 'python', 'react', 'frontend', 'backend', 'refactor', 'deploy', 'lint', 'mcp', 'agent', 'artifact', 'script', 'automation', 'cli']],
  ['writing', ['writing', 'write', 'writer', 'comms', 'email', 'blog', 'content', 'copy', 'editorial', 'story', 'blogpost', 'article', 'newsletter', 'social-media', 'summar', 'art', 'design', 'creative', 'gif', 'image', 'poster', 'diagram', 'logo', 'typography', 'mentor']],
  ['docs', ['doc', 'pdf', 'pptx', 'docx', 'word', 'slide', 'presentation', 'report', 'wiki', 'manual', 'guide', 'readme', 'changelog', 'brand', 'canvas', 'theme']],
];

/** 没有任何元数据时，按路径与名字里的关键词猜一个分类；猜不出算「工作流」。 */
export function guessSkillCategories(haystack) {
  const text = String(haystack || '').toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((keyword) => text.includes(keyword))) return [category];
  }
  return ['workflow'];
}

/** 默认目录源。不可移除；用户可以另外添加自己的仓库。 */
export const DEFAULT_SOURCES = Object.freeze([
  Object.freeze({ owner: 'anthropics', repo: 'skills', ref: '' }),
  Object.freeze({ owner: 'anthropics', repo: 'claude-plugins-official', ref: '' }),
  Object.freeze({ owner: 'obra', repo: 'superpowers', ref: '' }),
  Object.freeze({ owner: 'wshobson', repo: 'agents', ref: '' }),
  Object.freeze({ owner: 'mattpocock', repo: 'skills', ref: '' }),
  Object.freeze({ owner: 'alirezarezvani', repo: 'claude-skills', ref: '' }),
  Object.freeze({ owner: 'ComposioHQ', repo: 'awesome-claude-skills', ref: '' }),
]);

/* 离线时也能看到的几条：anthropics/skills 里最常用的技能，描述是手写的。
 * 它们只是「目录里有什么」的预告 —— 文件清单与内容仍然要联网读到之后才能预览、安装。 */
const CURATED = Object.freeze([
  { repo: 'anthropics/skills', dir: 'skills/docx', description: 'Create, read, and edit Word (.docx) files with tracked changes and comments', categories: ['docs'] },
  { repo: 'anthropics/skills', dir: 'skills/pdf', description: 'Read, extract, merge, split, and generate PDF files', categories: ['docs'] },
  { repo: 'anthropics/skills', dir: 'skills/pptx', description: 'Create, edit, and analyze PowerPoint (.pptx) presentations', categories: ['docs'] },
  { repo: 'anthropics/skills', dir: 'skills/xlsx', description: 'Work with spreadsheets: formulas, charts, pivots, and multiple sheets', categories: ['docs', 'data'] },
  { repo: 'anthropics/skills', dir: 'skills/frontend-design', description: 'Make distinctive, intentional visual design when building or restyling UI', categories: ['coding'] },
  { repo: 'anthropics/skills', dir: 'skills/webapp-testing', description: 'Drive and verify a local web app with Playwright', categories: ['coding'] },
  { repo: 'anthropics/skills', dir: 'skills/mcp-builder', description: 'Create high-quality MCP servers that connect LLMs to tools and data', categories: ['coding'] },
  { repo: 'anthropics/skills', dir: 'skills/skill-creator', description: 'Create new skills, improve existing ones, and measure how well they work', categories: ['coding', 'workflow'] },
]);

const repoKey = (owner, repo) => `${owner}/${repo}`.toLowerCase();

export function curatedFor(owner, repo) {
  const key = repoKey(owner, repo);
  return CURATED.filter((entry) => entry.repo.toLowerCase() === key);
}

const hex16 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/** 目录源的稳定 ID：仓库名不分大小写，分支名分。 */
export const sourceIdOf = (owner, repo, ref = '') => hex16(`github:${repoKey(owner, repo)}@${ref}`);

/** 条目 ID：源 ID + 目录的哈希。前端只把它原样带回来，带不了路径。 */
export const entryIdOf = (sourceId, dir) => `${sourceId}${hex16(`dir:${dir}`)}`;

export const ENTRY_ID_PATTERN = /^[0-9a-f]{32}$/;
export const SOURCE_ID_PATTERN = /^[0-9a-f]{16}$/;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const isCommitSha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
export const isRefName = (value) => typeof value === 'string' && REF_PATTERN.test(value) && !value.includes('..');

/**
 * 解析用户填的仓库：owner/repo、owner/repo@分支，或 github.com 的仓库网址。
 * 只接受 GitHub；分支名里带「/」的不支持。
 */
export function parseRepoSpec(raw) {
  const bad = (error) => ({ ok: false, error });
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return bad('请填写 GitHub 仓库，例如 owner/repo');
  if (text.length > 300) return bad('仓库地址太长');
  let owner;
  let repo;
  let ref = '';
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)(?:\/tree\/([^/\s?#]+)(?:\/[^\s?#]*)?)?\/?(?:[?#]\S*)?$/i.exec(text);
  if (url) {
    [, owner, repo] = url;
    ref = url[3] || '';
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return bad('只支持 GitHub 仓库，例如 owner/repo 或 https://github.com/owner/repo');
    const plain = /^([^/\s@]+)\/([^/\s@]+)(?:@(\S+))?$/.exec(text);
    if (!plain) return bad('写成 owner/repo 的形式，例如 anthropics/skills');
    [, owner, repo] = plain;
    ref = plain[3] || '';
  }
  repo = repo.replace(/\.git$/i, '');
  if (!OWNER_PATTERN.test(owner)) return bad('仓库所有者的名字不合法');
  if (!REPO_PATTERN.test(repo) || repo === '.' || repo === '..') return bad('仓库名不合法');
  if (ref && !isRefName(ref)) return bad('分支名不合法（只支持字母、数字、点、下划线、连字符）');
  return { ok: true, owner, repo, ref };
}

/* ---------- 远端清单 → 文件表 ---------- */

/**
 * GitHub `git/trees/<sha>?recursive=1` 的响应 → 普通文件表。
 * 只收 blob 且是普通文件模式；符号链接（120000）与子模块（type=commit）不收。
 */
export function filesFromGitTree(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.tree)) return { ok: false };
  const files = [];
  for (const node of payload.tree) {
    if (!node || node.type !== 'blob' || typeof node.path !== 'string') continue;
    if (node.mode !== '100644' && node.mode !== '100755') continue;
    if (typeof node.sha !== 'string' || !/^[0-9a-f]{40}$/.test(node.sha)) continue;
    if (!Number.isInteger(node.size) || node.size < 0) continue;
    files.push({ path: node.path, hash: node.sha, size: node.size, exec: node.mode === '100755' });
  }
  return { ok: true, files, truncated: payload.truncated === true };
}

/** jsDelivr `packages/gh/<owner>/<repo>@<ref>?structure=flat` 的响应 → 普通文件表。 */
export function filesFromFlatListing(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.files)) return { ok: false };
  const files = [];
  for (const node of payload.files) {
    if (!node || typeof node.name !== 'string' || !node.name.startsWith('/')) continue;
    if (typeof node.hash !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(node.hash)) continue;
    if (!Number.isInteger(node.size) || node.size < 0) continue;
    files.push({ path: node.name.slice(1), hash: node.hash, size: node.size, exec: false });
  }
  return { ok: true, files, truncated: false };
}

/* ---------- 文件表 → 技能条目 ---------- */

const BLOCK_NOTES = Object.freeze({
  'unsafe-path': '它包含不安全的文件路径',
  'file-too-large': `它有文件超过 ${formatBytes(BUNDLE_LIMITS.maxFileBytes)}`,
  'too-many-files': `它的文件超过 ${BUNDLE_LIMITS.maxFiles} 个`,
  'too-large': `它的总大小超过 ${formatBytes(BUNDLE_LIMITS.maxTotalBytes)}`,
  'skill-md-too-large': '它的 SKILL.md 太大',
});

export const blockNote = (code) => (code ? BLOCK_NOTES[code] || '它不符合安装限制' : '');

/** 技能目录在仓库里的路径：要拼进 URL，所以只接受老实的相对路径（允许点开头的目录，如 .claude/skills）。 */
function usableDir(dir) {
  if (dir === '') return true;
  if (dir.length > 400 || /[\x00-\x1f\x7f\\]/.test(dir)) return false;
  return dir.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * 把仓库的文件表切成技能条目。
 *   - 含 SKILL.md 的目录是一个技能；技能目录里再嵌套的 SKILL.md 属于外层那个技能（pi 也不再往里找）；
 *   - 仓库根上的 SKILL.md 只有在它是唯一一个时才算技能（整个仓库就是一个技能）；
 *   - `template/` 下的是模板，不列（与 PI-Desktop 一致）；
 *   - 超出安装上限的条目照样列出来，但标明原因、不可安装，文件清单只留 SKILL.md 供预览。
 *
 * @param files [{ path, hash, size, exec }]
 * @returns { entries:[{ dir, files:[[relPath, hash, size, exec(0|1)]], skipped, bytes, blocked }], truncated }
 */
export function buildCatalogEntries(files, {
  maxEntries = 2000, maxFileRecords = 20000, limits = BUNDLE_LIMITS, maxSkillBytes = 256 * 1024,
} = {}) {
  const skillDirs = new Set();
  for (const file of files) {
    // 仓库顶层 template/ 下的 SKILL.md 是给人照着抄的模板，不是技能
    if (file.path === SKILL_FILE) skillDirs.add('');
    else if (file.path.endsWith(`/${SKILL_FILE}`) && !file.path.startsWith('template/')) skillDirs.add(file.path.slice(0, -(SKILL_FILE.length + 1)));
  }
  if (skillDirs.has('') && skillDirs.size > 1) skillDirs.delete('');

  const tops = new Map();
  for (const dir of skillDirs) {
    if (!usableDir(dir)) continue;
    let nested = false;
    for (let cut = dir.lastIndexOf('/'); cut > 0; cut = dir.lastIndexOf('/', cut - 1)) {
      if (skillDirs.has(dir.slice(0, cut))) {
        nested = true;
        break;
      }
    }
    if (!nested) tops.set(dir, { dir, files: [], skill: null, count: 0, skipped: 0, bytes: 0, blocked: '' });
  }

  const wholeRepo = tops.has('');
  for (const file of files) {
    let owner = null;
    if (wholeRepo) {
      owner = '';
    } else {
      for (let cut = file.path.lastIndexOf('/'); cut > 0; cut = file.path.lastIndexOf('/', cut - 1)) {
        const dir = file.path.slice(0, cut);
        if (tops.has(dir)) {
          owner = dir;
          break;
        }
      }
    }
    if (owner === null) continue;
    const entry = tops.get(owner);
    const rel = owner ? file.path.slice(owner.length + 1) : file.path;
    const verdict = classifyBundlePath(rel, limits);
    if (!verdict.ok) {
      if (verdict.fatal) entry.blocked = entry.blocked || 'unsafe-path';
      else entry.skipped += 1;
      continue;
    }
    const record = [rel, file.hash, file.size, file.exec ? 1 : 0];
    if (file.size > limits.maxFileBytes) entry.blocked = entry.blocked || 'file-too-large';
    if (rel === SKILL_FILE) {
      entry.skill = record;
      if (file.size > maxSkillBytes) entry.blocked = entry.blocked || 'skill-md-too-large';
    }
    entry.count += 1;
    entry.bytes += file.size;
    // 超出上限的条目反正不可安装，文件清单不必存全
    if (entry.count <= limits.maxFiles) entry.files.push(record);
  }

  const entries = [];
  let records = 0;
  let truncated = false;
  for (const entry of [...tops.values()].sort((a, b) => a.dir.localeCompare(b.dir))) {
    // SKILL.md 自己是个链接或子模块时，文件表里没有它 —— 这不是一个能装的技能
    if (!entry.skill) continue;
    if (entry.count > limits.maxFiles) entry.blocked = entry.blocked || 'too-many-files';
    if (entry.bytes > limits.maxTotalBytes) entry.blocked = entry.blocked || 'too-large';
    let kept;
    if (entry.blocked) kept = entry.blocked === 'skill-md-too-large' ? [] : [entry.skill];
    else kept = entry.files.sort((a, b) => (a[0] === SKILL_FILE ? -1 : b[0] === SKILL_FILE ? 1 : a[0].localeCompare(b[0])));
    if (entries.length >= maxEntries || records + kept.length > maxFileRecords) {
      truncated = true;
      break;
    }
    records += kept.length;
    entries.push({ dir: entry.dir, files: kept, fileCount: entry.count, skipped: entry.skipped, bytes: entry.bytes, blocked: entry.blocked });
  }
  return { entries, truncated };
}

/**
 * 缓存文件里读回来的条目：形状不对就整份不要（当作还没加载过）。
 * 文件路径要过与建目录时同一道校验 —— 它们会被拼进 URL，缓存文件不比远端更可信。
 */
export function validSnapshotEntries(entries, limits = BUNDLE_LIMITS) {
  if (!Array.isArray(entries)) return false;
  return entries.every((entry) => (
    entry && typeof entry.dir === 'string' && usableDir(entry.dir) && Array.isArray(entry.files) &&
    Number.isInteger(entry.fileCount) && Number.isInteger(entry.skipped) && Number.isFinite(entry.bytes) &&
    typeof entry.blocked === 'string' && (entry.description === undefined || typeof entry.description === 'string') &&
    entry.files.every((record) => (
      Array.isArray(record) && record.length === 4 && typeof record[0] === 'string' && typeof record[1] === 'string' &&
      Number.isInteger(record[2]) && record[2] >= 0 && (record[3] === 0 || record[3] === 1) &&
      classifyBundlePath(record[0], limits).ok === true
    ))
  ));
}

/* ---------- 给界面的条目 ---------- */

/** 技能的显示名与安装时的默认目录名：技能目录的最后一段；整个仓库是一个技能时用仓库名。 */
export const slugOfDir = (dir, repo) => sanitizeSkillSlug(dir ? dir.split('/').pop() : repo);

/**
 * @param source  { id, owner, repo, ref }
 * @param entry   快照里的条目；没有快照时传 null，用 curated 的预告条目
 * @param curated CURATED 里对应的那一条（或 undefined）
 * @param ref     用来拼主页链接的分支 / 提交
 */
export function describeEntry(source, entry, curated, ref) {
  const dir = entry ? entry.dir : curated.dir;
  const slug = slugOfDir(dir, source.repo);
  const rawName = dir ? dir.split('/').pop() : source.repo;
  const shownRef = ref || source.ref || 'HEAD';
  return {
    id: entryIdOf(source.id, dir),
    sourceId: source.id,
    repo: `${source.owner}/${source.repo}`,
    dir,
    slug,
    title: slug || rawName,
    description: (entry && entry.description) || (curated ? curated.description : ''),
    categories: curated ? curated.categories.slice() : guessSkillCategories(`${dir} ${rawName}`),
    // 「官方」= Anthropic 自己的仓库；不是对内容的背书，也不代表经过了 Pi GUI 的审核
    official: source.owner.toLowerCase() === 'anthropics',
    listed: Boolean(entry),
    fileCount: entry ? entry.fileCount : null,
    bytes: entry ? entry.bytes : null,
    installable: entry ? !entry.blocked : true,
    reason: entry ? blockNote(entry.blocked) : '',
    homepage: `https://github.com/${source.owner}/${source.repo}/tree/${encodeURIComponent(shownRef)}${dir ? `/${dir.split('/').map(encodeURIComponent).join('/')}` : ''}`,
  };
}

/* ---------- 内容完整性 ---------- */

/** git 的 blob 哈希：sha1("blob <字节数>\0" + 内容)。目录来自 GitHub 时用它核对每个文件。 */
export function gitBlobSha1(bytes) {
  return crypto.createHash('sha1').update(`blob ${bytes.length}\x00`).update(bytes).digest('hex');
}

export const sha256Base64 = (bytes) => crypto.createHash('sha256').update(bytes).digest('base64');

/** 取回来的字节是不是清单里登记的那一份。mode：pinned（git blob sha1）/ cdn（sha256）。 */
export function contentMatches(mode, hash, size, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) return false;
  return mode === 'pinned' ? gitBlobSha1(bytes) === hash : sha256Base64(bytes) === hash;
}

const encodePath = (relPath) => relPath.split('/').map(encodeURIComponent).join('/');

/** 文件内容的两个来源：jsDelivr CDN 为主，GitHub raw 作备用。两边都按固定的提交 / 分支取。 */
export function contentUrls(source, ref, fullPath) {
  const repo = `${source.owner}/${source.repo}`;
  return {
    cdn: `https://cdn.jsdelivr.net/gh/${repo}@${encodeURIComponent(ref)}/${encodePath(fullPath)}`,
    raw: `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encodePath(fullPath)}`,
  };
}
