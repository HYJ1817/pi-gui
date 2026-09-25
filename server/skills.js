/* Skills 管理：发现 / 查看 / 启停。
 *
 * 这个模块只做一件事：把 **pi 已有的** skill 机制做成可靠的 GUI 数据源。
 * 它不发明任何 pi 不认识的概念 —— 每一个字段都能在 pi 的源码里找到出处。
 *
 * ---------- pi 的 skill 机制（读 dist/core/package-manager.js + core/skills.js 得出） ----------
 *
 * 发现位置（`addAutoDiscoveredResources`）：
 *   ~/.pi/agent/skills                    user    总是          collect 模式 "pi"
 *   ~/.agents/skills                      user    总是          collect 模式 "agents"
 *   <cwd>/.pi/skills                      project 项目被信任时  collect 模式 "pi"
 *   <cwd> 及祖先的 .agents/skills          project 项目被信任时  collect 模式 "agents"
 *   另外 settings 的 skills 数组里的「普通条目」也是路径/glob 来源。
 *
 * collect 两种模式的差别（`collectSkillEntries`）：
 *   - 目录里直接有 SKILL.md → 把那个文件当成一个 skill，不再往里递归；
 *   - "pi" 模式额外认**根级 .md**；"agents" 模式**忽略根级 .md**，只认子目录里的。
 *   - 两者都跳过点开头条目与 node_modules。
 *
 * 同名冲突：**项目级胜出**。`resourcePrecedenceRank` 把 project(0/1) 排在 user(2/3)
 *   之前，而 `loadSkills` 的 addSkills 是先到者胜 —— 所以别信「user 覆盖 project」的直觉。
 *   （skills.js 里那个 includeDefaults 分支是死代码，全仓库只有一个调用者且传 false。）
 *
 * 项目信任闸门（core/project-trust.js）：非交互模式（`--mode rpc`）没有 UI，
 *   `defaultProjectTrust` 默认 "ask" → 判定为 **false**。所以 Pi GUI 默认下
 *   项目级 skill 根本不会加载。这一点必须如实显示，不能显示成「已启用」。
 *
 * 启停（core/package-manager.js 的 `isEnabledByOverrides`）：settings 的 skills 数组里
 *   `!glob`（走 matchesAnyPattern）、`+exact`、`-exact`（走 matchesAnyExactPattern）
 *   是 override。**作用域必须配对**：user 作用域的 skill 只吃全局 settings，
 *   project 作用域的只吃项目 .pi/settings.json。
 *   exact 模式比的是「相对 baseDir 的 posix 路径」，所以 baseDir 是 agentDir /
 *   ~/.agents / <cwd>/.pi / <cwd>/.agents —— 路径一定带 skills/ 前缀。
 *   实测：`-r-skill.md` 这种裸文件名**无效**，必须写 `-skills/r-skill.md`。
 *   本模块统一用 `-` + posix(relative(baseDir, path))。
 *
 * 权威的「pi 实际加载了哪些 skill」= RPC `get_commands`（rpc-mode.js:560 把
 *   resourceLoader.getSkills().skills 逐个以 `skill:<name>` 返回）。
 *   实测 `enableSkillCommands:false` 时它依然返回 → 可以放心当权威来源。
 *   本模块的做法是：**文件系统枚举负责「有哪些」，get_commands 负责「哪些真的生效」**，
 *   两边合并；只在 get_commands 里出现、枚举没找到的（比如包里的 skill）也补进来。
 *   配对**必须按 sourceInfo.path**（应答里带着它），不能只按名字 —— 否则同名被抢先的
 *   那一条也会被算成「已加载」，UI 就同时显示两条 enabled。
 *
 * ---------- 安全边界 ----------
 *
 *   - 前端只拿得到**稳定 ID**（路径的 sha1 前 16 位），拿不到也传不了绝对路径。
 *     所有按 ID 的操作都在本模块内部索引里查真实路径。
 *   - 读文件前再校验一次「这个路径确实落在某个已知发现根之下」（纵深防御）。
 *   - 写 settings 是 read → merge → validate → 原子写，**保留一切未知字段**，
 *     并且只增删我们自己那一条精确模式 —— 不碰用户的通配模式。
 *   - 任何一条 skill 坏了都只影响它自己（记录进该条的 errors），不让整页打不开。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, readBody } from './http-utils.js';

const CONFIG_DIR = '.pi';
const SKILL_FILE = 'SKILL.md';
const AGENTS_DIR = '.agents';
const SKILLS_SUBDIR = 'skills';

/** SKILL.md 读取上限。技能文件本来就是给模型看的短指令，256KB 已经非常宽裕。 */
const MAX_SKILL_BYTES = 256 * 1024;
/** 详情里浅列 skill 目录的条数上限。 */
const MAX_DIR_ENTRIES = 40;
/** Agent Skills 规范的名字/描述长度上限（pi 也按这两个值校验）。 */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

const toPosix = (p) => p.split(path.sep).join('/');

/** 读文件，任何失败都回 null（调用方按「读不到」降级）。 */
function readTextSafe(file, maxBytes = MAX_SKILL_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = fs.readSync(fd, buf, 0, maxBytes, 0);
        return buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/* ---------- frontmatter ----------
 *
 * pi 用 yaml 包解析。这里刻意**不引入依赖**，只实现 skill frontmatter 用得到的那一小块：
 * 顶层 `key: value`、引号包裹、以及 `|` / `>` 块标量。理由是：本模块真正要回答的
 * 只有一个问题 —— 「description 是不是空的」（那是 pi 决定加不加载的唯一硬条件），
 * 而 name/description 的**权威值**我们本来就从 get_commands 拿。
 * 解析不出来就当没有 frontmatter，绝不因此崩掉。 */
function parseFrontmatter(text) {
  if (typeof text !== 'string') return null;
  // 允许 BOM 与 CRLF
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---')) return null;
  const end = src.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = src.slice(src.indexOf('\n', 3) + 1, end);
  const out = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    // 顶层键必须是行首无缩进
    if (/^\s/.test(line)) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-' || value === '|+' || value === '>+') {
      const folded = value.startsWith('>');
      const parts = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() && !/^\s/.test(lines[j])) break;
        parts.push(lines[j].replace(/^\s{1,}/, ''));
      }
      i = j - 1;
      value = parts.join(folded ? ' ' : '\n').trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
      if (m[2].trim().startsWith('"')) value = value.replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    out[key] = value;
  }
  return out;
}

/** 按 Agent Skills 规范校验名字（pi 用同一套规则，且只警告不拒载）。 */
function validateName(name) {
  const errors = [];
  if (typeof name !== 'string' || !name) return ['name is required'];
  if (name.length > MAX_NAME_LENGTH) errors.push(`name 超过 ${MAX_NAME_LENGTH} 字符`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push('name 只能用小写字母、数字、连字符');
  if (name.startsWith('-') || name.endsWith('-')) errors.push('name 不能以连字符开头或结尾');
  if (name.includes('--')) errors.push('name 不能有连续连字符');
  return errors;
}

function validateDescription(description) {
  if (typeof description !== 'string' || !description.trim()) return ['description 是必需的'];
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [`description 超过 ${MAX_DESCRIPTION_LENGTH} 字符（${description.length}）`];
  }
  return [];
}

/* ---------- glob / exact 匹配（对齐 pi 的 matchesAnyPattern / matchesAnyExactPattern） ----------
 *
 * 只用于**判断某条 settings 模式是否命中某个 skill**（给 UI 显示「被哪条规则关掉了」）。
 * 不是通用 glob 实现，只覆盖 pi 会遇到的形态：`*`（不跨 /）、`**`（跨 /）、`?`。 */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** 跨目录
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return null;
  }
}

/** 与 pi 的 matchesAnyPattern 同语义：对 rel / name / filePathPosix，SKILL.md 时再加父目录三种。 */
function matchesAnyPattern(filePath, patterns, baseDir) {
  const rel = toPosix(path.relative(baseDir, filePath));
  const name = path.basename(filePath);
  const filePosix = toPosix(filePath);
  const isSkillFile = name === SKILL_FILE;
  const parentDir = isSkillFile ? path.dirname(filePath) : '';
  const parentRel = isSkillFile ? toPosix(path.relative(baseDir, parentDir)) : '';
  const parentName = isSkillFile ? path.basename(parentDir) : '';
  const parentPosix = isSkillFile ? toPosix(parentDir) : '';
  return patterns.some((pattern) => {
    const re = globToRegExp(toPosix(pattern));
    if (!re) return false;
    if (re.test(rel) || re.test(name) || re.test(filePosix)) return true;
    if (!isSkillFile) return false;
    return re.test(parentRel) || re.test(parentName) || re.test(parentPosix);
  });
}

/** 与 pi 的 matchesAnyExactPattern 同语义（注意：**不比 name**）。 */
function matchesAnyExactPattern(filePath, patterns, baseDir) {
  if (!patterns.length) return false;
  const rel = toPosix(path.relative(baseDir, filePath));
  const filePosix = toPosix(filePath);
  const isSkillFile = path.basename(filePath) === SKILL_FILE;
  const parentDir = isSkillFile ? path.dirname(filePath) : '';
  const parentRel = isSkillFile ? toPosix(path.relative(baseDir, parentDir)) : '';
  const parentPosix = isSkillFile ? toPosix(parentDir) : '';
  return patterns.some((raw) => {
    let p = toPosix(raw);
    if (p.startsWith('./') || p.startsWith('.\\')) p = p.slice(2);
    if (p === rel || p === filePosix) return true;
    if (!isSkillFile) return false;
    return p === parentRel || p === parentPosix;
  });
}

/**
 * 找出 settings 的 skills 数组里**关掉**这个 skill 的那条模式。
 * 按 pi 的判定顺序：`!` 排除 → `+` 强制包含 → `-` 强制排除，后者覆盖前者。
 * 返回 {disabled:boolean, pattern:string}。
 */
function disabledByPatterns(filePath, patterns, baseDir) {
  const overrides = (patterns || []).filter((p) => typeof p === 'string' && /^[!+-]/.test(p));
  const excludes = overrides.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const forceIncludes = overrides.filter((p) => p.startsWith('+')).map((p) => p.slice(1));
  const forceExcludes = overrides.filter((p) => p.startsWith('-')).map((p) => p.slice(1));
  let disabled = false;
  let pattern = '';
  if (excludes.length && matchesAnyPattern(filePath, excludes, baseDir)) {
    disabled = true;
    pattern = '!' + excludes.find((p) => matchesAnyPattern(filePath, [p], baseDir));
  }
  if (forceIncludes.length && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
    disabled = false;
    pattern = '';
  }
  if (forceExcludes.length && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
    disabled = true;
    pattern = '-' + forceExcludes.find((p) => matchesAnyExactPattern(filePath, [p], baseDir));
  }
  return { disabled, pattern };
}

/* ---------- 信任状态（对齐 core/trust-manager.js + core/project-trust.js） ---------- */

/** pi 认为「需要信任」的项目资源：.pi 下这几项，以及 cwd/祖先的 .agents/skills。 */
const TRUST_REQUIRING = ['settings.json', 'extensions', 'skills', 'prompts', 'themes', 'SYSTEM.md', 'APPEND_SYSTEM.md'];

function hasTrustRequiringProjectResources(cwd, homeDir) {
  if (!cwd) return false;
  const userAgentsSkills = path.join(homeDir, AGENTS_DIR, SKILLS_SUBDIR);
  const configDir = path.join(cwd, CONFIG_DIR);
  for (const entry of TRUST_REQUIRING) {
    if (fs.existsSync(path.join(configDir, entry))) return true;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const agentsSkills = path.join(dir, AGENTS_DIR, SKILLS_SUBDIR);
    if (path.resolve(agentsSkills) !== path.resolve(userAgentsSkills) && fs.existsSync(agentsSkills)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** trust.json 的「最近祖先决定」—— 与 pi 的 findNearestTrustEntry 同语义。 */
function nearestTrustDecision(trustFile, cwd) {
  const data = (() => {
    try {
      const raw = fs.readFileSync(trustFile, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  })();
  if (!data) return null;
  let dir = path.resolve(cwd);
  for (;;) {
    const v = data[dir];
    if (v === true || v === false) return { path: dir, decision: v };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 这个项目在 pi 眼里算不算「被信任」。
 *
 * 严格照抄 pi 的判定顺序（core/project-trust.js）：
 *   0. 没有项目 → 谈不上信任（reason=no-project）
 *   1. `--approve` / `--no-approve`（本模块用 override 参数表达）
 *   2. 没有任何「需要信任的项目资源」→ 直接 true（闸门根本没合上）
 *   3. trust.json 的最近祖先决定
 *   4. 全局 settings 的 defaultProjectTrust：always → true，never → false
 *   5. ask + 没有 UI（RPC 模式就是没有 UI）→ false
 *
 * 这里**不**模拟扩展的 project_trust 事件（那要跑扩展，代价与风险都不值）。
 * 真到那一步时结论会偏保守（显示未信任），不会把没生效的说成生效。
 */
function readTrustState({ cwd, agentDir, homeDir, trustOverride }) {
  const trustFile = path.join(agentDir, 'trust.json');
  const settingsFile = path.join(agentDir, 'settings.json');
  const base = { trustFile, trustOverride: trustOverride ?? null };
  // 没有项目就谈不上「项目是否被信任」—— 这一条要排在 override 之前，
  // 否则 cwd 为空时带 --approve 会报出一个没有意义的 approve-flag。
  if (!cwd) return { ...base, trusted: false, reason: 'no-project', requiresTrust: false };
  if (trustOverride === true || trustOverride === false) {
    return { ...base, trusted: trustOverride, reason: trustOverride ? 'approve-flag' : 'no-approve-flag', requiresTrust: true };
  }
  const requiresTrust = hasTrustRequiringProjectResources(cwd, homeDir);
  if (!requiresTrust) {
    return { ...base, trusted: true, reason: 'no-project-resources', requiresTrust: false };
  }
  const decision = nearestTrustDecision(trustFile, cwd);
  if (decision) {
    return { ...base, trusted: decision.decision, reason: 'trust-file', requiresTrust: true, decidedAt: decision.path };
  }
  const settings = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, ''));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  })();
  const fallback = settings.defaultProjectTrust;
  if (fallback === 'always') return { ...base, trusted: true, reason: 'default-always', requiresTrust: true };
  if (fallback === 'never') return { ...base, trusted: false, reason: 'default-never', requiresTrust: true };
  // ask + 非交互模式没有 UI → false
  return { ...base, trusted: false, reason: 'ask-no-ui', requiresTrust: true, defaultProjectTrust: fallback ?? 'ask' };
}

/* ---------- 发现 ---------- */

/**
 * 忠实移植 pi 的 collectSkillEntries。
 * @param dir  要扫描的目录
 * @param mode 'pi'（根级 .md 也算）或 'agents'（忽略根级 .md）
 * @returns {string[]} skill 文件（SKILL.md 或根级 .md）的绝对路径
 */
function collectSkillEntries(dir, mode) {
  const found = [];
  const root = dir;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    // 先看 current/SKILL.md —— 有就把当前目录当成一个 skill，不再递归
    for (const entry of entries) {
      if (entry.name !== SKILL_FILE) continue;
      const full = path.join(current, entry.name);
      if (isFileFollowingSymlink(entry, full)) {
        found.push(full);
        return;
      }
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      const kind = kindOf(entry, full);
      if (kind === 'file') {
        const includeRootMd = entry.name.endsWith('.md') && ((mode === 'pi' && current === root) || (mode === 'agents' && current !== root));
        if (includeRootMd) found.push(full);
        continue;
      }
      if (kind === 'dir') walk(full);
    }
  };
  walk(dir);
  return found;
}

function isFileFollowingSymlink(dirent, full) {
  if (dirent.isFile()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return fs.statSync(full).isFile();
  } catch {
    return false;
  }
}

function kindOf(dirent, full) {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) {
    try {
      const stat = fs.statSync(full);
      return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
    } catch {
      return 'other';
    }
  }
  return 'other';
}

/** cwd 及祖先里的 .agents/skills（有 git 仓库就停在仓库根，否则到文件系统根）。 */
function ancestorAgentsSkillDirs(cwd) {
  const dirs = [];
  if (!cwd) return dirs;
  let dir = path.resolve(cwd);
  let gitRoot = null;
  for (let probe = dir; ; ) {
    if (fs.existsSync(path.join(probe, '.git'))) {
      gitRoot = probe;
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  for (;;) {
    dirs.push(path.join(dir, AGENTS_DIR, SKILLS_SUBDIR));
    if (gitRoot && dir === gitRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** 路径归一化 key（Windows 大小写不敏感）。用于把 pi 报的 sourceInfo.path 与磁盘文件配对。 */
function pathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 稳定 ID：路径的 sha1 前 16 位。前端只拿得到它，传不了也猜不出绝对路径。 */
function skillId(absPath) {
  return crypto.createHash('sha1').update(pathKey(absPath)).digest('hex').slice(0, 16);
}

function readSettings(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, data: null, error: 'settings.json 不是一个 JSON 对象' };
    }
    return { exists: true, data: parsed, error: '' };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, data: {}, error: '' };
    return { exists: true, data: null, error: `settings.json 读不出来：${err.message}` };
  }
}

function writeSettingsAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能根本没建出来 */
    }
    throw err;
  }
}

/**
 * @param runtime 共享运行态（要 cwd）。只读。
 * @param rpc     pi 桥接，用它的 request('get_commands') 拿权威加载集。可选 ——
 *                不传时 loaded 一律是 null（「未知」），UI 要如实说「无法确认」。
 * @param env     环境变量来源，默认 process.env（读 PI_CODING_AGENT_DIR）。
 * @param homeDir 用户主目录，默认 process.env.HOME || os.homedir()（与 pi 的 getHomeDir 一致）。
 * @param approve 是否以 `--approve` 启动 pi（决定项目级资源的信任 override）。默认 null = 不由我们决定。
 */
export function createSkills({ runtime, rpc = null, env = process.env, homeDir = null, approve = null }) {
  const HOME = homeDir || env.HOME || os.homedir();
  const AGENT_DIR = env.PI_CODING_AGENT_DIR || path.join(HOME, CONFIG_DIR, 'agent');

  function paths() {
    const cwd = runtime.getCurrentCwd();
    return {
      cwd,
      agentDir: AGENT_DIR,
      homeDir: HOME,
      globalSettings: path.join(AGENT_DIR, 'settings.json'),
      projectSettings: cwd ? path.join(cwd, CONFIG_DIR, 'settings.json') : null,
      trustFile: path.join(AGENT_DIR, 'trust.json'),
    };
  }

  /** 权威加载集：pi 通过 get_commands 报的 skill 名 → {name, description, sourceInfo}。 */
  async function loadFromPi() {
    if (!rpc || typeof rpc.request !== 'function') return { reachable: false, skills: null };
    const data = await rpc.request({ type: 'get_commands' });
    if (!data || data.__error) return { reachable: false, skills: null };
    const out = new Map();
    for (const cmd of data.commands || []) {
      if (cmd.source !== 'skill') continue;
      const name = String(cmd.name || '').replace(/^skill:/, '');
      if (name) out.set(name, cmd);
    }
    return { reachable: true, skills: out };
  }

  /** 枚举磁盘上的 skill（含项目级 —— 即使项目没被信任也要列出来，只是标记成未加载）。 */
  function enumerate({ cwd, agentDir, homeDir, globalSettings, projectSettings }) {
    const roots = [];
    roots.push({
      dir: path.join(agentDir, SKILLS_SUBDIR),
      mode: 'pi',
      scope: 'user',
      source: 'auto',
      baseDir: agentDir,
      label: '~/.pi/agent/skills',
    });
    roots.push({
      dir: path.join(homeDir, AGENTS_DIR, SKILLS_SUBDIR),
      mode: 'agents',
      scope: 'user',
      source: 'auto',
      baseDir: path.join(homeDir, AGENTS_DIR),
      label: '~/.agents/skills',
    });
    if (cwd) {
      roots.push({
        dir: path.join(cwd, CONFIG_DIR, SKILLS_SUBDIR),
        mode: 'pi',
        scope: 'project',
        source: 'auto',
        baseDir: path.join(cwd, CONFIG_DIR),
        label: '<项目>/.pi/skills',
      });
      const userAgentsSkills = path.resolve(path.join(homeDir, AGENTS_DIR, SKILLS_SUBDIR));
      for (const dir of ancestorAgentsSkillDirs(cwd)) {
        // pi 会把 ~/.agents/skills 从祖先列表里剔掉（它已经作为 user 根收过了）
        if (path.resolve(dir) === userAgentsSkills) continue;
        roots.push({
          dir,
          mode: 'agents',
          scope: 'project',
          source: 'auto',
          baseDir: path.dirname(dir),
          label: dir,
        });
      }
    }

    // settings 里的「普通条目」（非 !/+/- 模式）也是 skill 来源
    for (const [file, scope, baseDir] of [
      [globalSettings, 'user', agentDir],
      [projectSettings, 'project', cwd ? path.join(cwd, CONFIG_DIR) : null],
    ]) {
      if (!file || !baseDir) continue;
      const { data } = readSettings(file);
      const arr = data && Array.isArray(data.skills) ? data.skills : [];
      for (const entry of arr) {
        if (typeof entry !== 'string') continue;
        if (/^[!+-]/.test(entry)) continue; // override 模式不是路径
        if (entry.includes('*') || entry.includes('?')) continue; // glob 条目本模块不展开
        const resolved = path.isAbsolute(entry) ? entry : path.resolve(baseDir, entry);
        let stat;
        try {
          stat = fs.statSync(resolved);
        } catch {
          continue;
        }
        const label = `${entry}（来自 settings）`;
        if (stat.isDirectory()) {
          roots.push({ dir: resolved, mode: 'pi', scope, source: 'local', baseDir, label });
        } else if (stat.isFile() && resolved.endsWith('.md')) {
          roots.push({ dir: null, file: resolved, mode: 'pi', scope, source: 'local', baseDir, label });
        }
      }
    }

    const byPath = new Map();
    for (const root of roots) {
      const files = root.file ? [root.file] : collectSkillEntries(root.dir, root.mode);
      for (const file of files) {
        // 同一文件被多个根覆盖时保留优先级更高的那个（project 优先，与 pi 一致）
        const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
        const prev = byPath.get(key);
        if (prev && prev.scope === 'project') continue;
        byPath.set(key, { file, root });
      }
    }
    return { roots, byPath };
  }

  /** 解析一个 skill 文件，得到元数据 + 问题清单。**永不抛**。 */
  function inspect(file, root) {
    const errors = [];
    const dir = path.dirname(file);
    const isDeclared = path.basename(file) === SKILL_FILE;
    const text = readTextSafe(file);
    let fm = null;
    if (text === null) {
      errors.push({ level: 'error', message: '文件读不出来（权限或编码问题）' });
    } else {
      fm = parseFrontmatter(text);
      if (fm === null && isDeclared) {
        errors.push({ level: 'warn', message: 'SKILL.md 没有合法的 frontmatter（pi 会警告并跳过它）' });
      }
    }
    const fmName = fm && typeof fm.name === 'string' ? fm.name.trim() : '';
    const name = fmName || path.basename(dir);
    const description = fm && typeof fm.description === 'string' ? fm.description.trim() : '';
    if (!description) {
      errors.push({
        level: 'error',
        message: isDeclared ? 'frontmatter 里没有 description —— pi 不会加载它' : '没有 description —— 这个 .md 不会被当成 skill',
      });
    }
    for (const e of validateName(name)) errors.push({ level: 'warn', message: e });
    for (const e of validateDescription(description)) {
      if (!errors.some((x) => x.message.includes('description'))) errors.push({ level: 'warn', message: e });
    }
    const rel = toPosix(path.relative(root.baseDir, file));
    return {
      name,
      description,
      file,
      dir,
      rel,
      baseDir: root.baseDir,
      scope: root.scope,
      source: root.source,
      mode: root.mode,
      rootLabel: root.label,
      disableModelInvocation: Boolean(fm && fm['disable-model-invocation'] === true),
      license: fm && typeof fm.license === 'string' ? fm.license : '',
      compatibility: fm && typeof fm.compatibility === 'string' ? fm.compatibility : '',
      errors,
      bytes: text === null ? null : Buffer.byteLength(text, 'utf8'),
    };
  }

  /**
   * 组装完整列表。**一次 RPC 往返 + 一次文件系统扫描**，之后所有按 ID 的操作
   * 都在这份索引里查 —— 这也是「前端传不了路径」的实现基础。
   */
  async function buildIndex() {
    const p = paths();
    const trust = readTrustState({ cwd: p.cwd, agentDir: p.agentDir, homeDir: HOME, trustOverride: approve });
    const { roots, byPath } = enumerate(p);
    const piSide = await loadFromPi();

    const globalSettingsRead = readSettings(p.globalSettings);
    const projectSettingsRead = p.projectSettings ? readSettings(p.projectSettings) : { exists: false, data: {}, error: '' };
    const globalPatterns = globalSettingsRead.data && Array.isArray(globalSettingsRead.data.skills) ? globalSettingsRead.data.skills : [];
    const projectPatterns = projectSettingsRead.data && Array.isArray(projectSettingsRead.data.skills) ? projectSettingsRead.data.skills : [];

    const skills = [];
    const diagnostics = [];
    for (const read of [globalSettingsRead, projectSettingsRead]) {
      if (read.error) diagnostics.push({ level: 'warn', message: read.error });
    }

    /* 第一趟：把每条 skill 的事实收集齐（不判状态）。
     * 状态要等所有记录都在手里才能判 —— 「同名被别人抢先」需要知道别人是谁。 */
    const facts = [];

    /* pi 报的每一条都带 sourceInfo.path —— 必须**按路径**配对，不能只按名字。
     * 只按名字的话，「同名但被抢先的那条」也会被标成已加载，UI 就会同时显示两条
     * enabled，用户完全不知道为什么自己改的那条没生效（规格 §15 明确要避免这个）。 */
    const piByPath = new Map();
    const piByName = new Map();
    if (piSide.skills) {
      for (const [name, cmd] of piSide.skills) {
        piByName.set(name, cmd);
        const pth = cmd.sourceInfo && cmd.sourceInfo.path;
        if (pth) piByPath.set(pathKey(pth), cmd);
      }
    }

    for (const { file, root } of byPath.values()) {
      const info = inspect(file, root);
      const patterns = info.scope === 'project' ? projectPatterns : globalPatterns;
      const off = disabledByPatterns(file, patterns, info.baseDir);
      const hitByPath = piSide.skills ? piByPath.get(pathKey(file)) : undefined;
      const hitByName = piSide.skills ? piByName.get(info.name) : undefined;
      // pi 报了同名，但路径是另一个文件 → 这一条被抢先了（pi 保留先找到的那个）
      const shadowedByPi = !hitByPath && hitByName ? String((hitByName.sourceInfo && hitByName.sourceInfo.path) || '') : '';
      // 名字与描述只认「确实是这一条」的 pi 记录；被抢先的那条用磁盘上的值（别张冠李戴）
      const loadedEntry = hitByPath || (shadowedByPi ? undefined : hitByName);
      facts.push({
        info,
        off,
        loadedEntry,
        shadowedByPi,
        loaded: piSide.skills ? Boolean(hitByPath || hitByName) : null,
        settingsFile: info.scope === 'project' ? p.projectSettings : p.globalSettings,
        // 项目级 + 项目没被信任 → pi 根本不会扫这个目录
        blockedByTrust: info.scope === 'project' && trust.requiresTrust && !trust.trusted,
      });
    }

    /* 第二趟：判状态。
     * 顺序按「原因的确定性」排：确定的不加载（没有 description）> 闸门挡住 >
     * 明确被设置关掉 > pi 没报（可能同名被别人抢先）> pi 没运行（未知）。 */
    for (const f of facts) {
      const { info, off, loadedEntry, shadowedByPi, loaded, settingsFile, blockedByTrust } = f;
      const missingDescription = info.errors.some((e) => e.level === 'error' && /description/.test(e.message));
      let state = 'enabled';
      let stateNote = '';
      let shadowedBy = null;
      if (missingDescription) {
        state = 'invalid';
        stateNote = '没有 description，pi 不会加载';
      } else if (blockedByTrust) {
        state = 'untrusted';
        stateNote = '项目未被信任：pi 在非交互模式下不加载项目级资源';
      } else if (off.disabled) {
        state = 'disabled';
        stateNote = `被 settings 里的 ${off.pattern} 关掉了`;
      } else if (shadowedByPi) {
        // pi 加载的是同名的另一个文件 → 这一条没生效
        state = 'shadowed';
        shadowedBy = shadowedByPi;
        stateNote = `同名 skill 已被 ${shadowedByPi} 占用（pi 保留先找到的那个）`;
      } else if (loaded === false) {
        // pi 加载了同名但路径不是这一条 → 这一条被抢先了（pi 保留先找到的那个）
        const winner = facts.find((o) => o.loaded && o.info.name === info.name && o.info.file !== info.file);
        if (winner) {
          state = 'shadowed';
          shadowedBy = winner.info.file;
          stateNote = `同名 skill 已被 ${winner.info.file} 占用（pi 保留先找到的那个）`;
        } else {
          state = 'not-loaded';
          stateNote = '磁盘上有，但 pi 没有加载它';
        }
      } else if (loaded === null) {
        state = 'unknown';
        stateNote = 'pi 未运行，无法确认加载状态';
      }

      skills.push({
        id: skillId(info.file),
        name: info.name,
        // 名字与描述优先用 pi 报的（权威）；磁盘解析只作为 pi 没运行时的兜底
        description: loadedEntry && loadedEntry.description ? String(loadedEntry.description) : info.description,
        scope: info.scope,
        source: info.source,
        origin: 'top-level',
        mode: info.mode,
        rootLabel: info.rootLabel,
        path: info.file,
        dir: info.dir,
        file: path.basename(info.file),
        rel: info.rel,
        baseDir: info.baseDir,
        loaded,
        state,
        stateNote,
        shadowedBy,
        /* 关闭时要写进 settings 的那条精确模式。用 '-' + rel 是因为 exact 匹配比的是
         * 「相对 baseDir 的 posix 路径」—— 实测裸文件名（-name）不命中。 */
        disablePattern: '-' + info.rel,
        settingsPath: settingsFile,
        toggleable: info.scope === 'user' || info.scope === 'project',
        blockedByTrust,
        disabledBy: off.pattern,
        disableModelInvocation: info.disableModelInvocation,
        license: info.license,
        compatibility: info.compatibility,
        bytes: info.bytes,
        errors: info.errors,
      });
    }

    // pi 报了但我们没枚举到的（例如来自 package 的 skill）—— 补进来，别丢信息
    if (piSide.skills) {
      const seen = new Set(skills.map((s) => s.name));
      for (const [name, cmd] of piSide.skills) {
        if (seen.has(name)) continue;
        const si = cmd.sourceInfo || {};
        skills.push({
          id: skillId(String(si.path || `pi:${name}`)),
          name,
          description: String(cmd.description || ''),
          scope: si.scope === 'project' ? 'project' : si.scope === 'temporary' ? 'temporary' : 'user',
          source: si.source || 'auto',
          origin: si.origin || 'top-level',
          mode: 'pi',
          rootLabel: si.baseDir || '（来自 pi，未能定位目录）',
          path: si.path || '',
          dir: si.path ? path.dirname(String(si.path)) : '',
          file: si.path ? path.basename(String(si.path)) : '',
          rel: '',
          baseDir: si.baseDir || '',
          loaded: true,
          state: 'enabled',
          stateNote: '由 pi 报告为已加载（Pi GUI 未在磁盘发现它，可能来自 package）',
          disablePattern: '',
          settingsPath: null,
          toggleable: false,
          blockedByTrust: false,
          disabledBy: '',
          disableModelInvocation: false,
          license: '',
          compatibility: '',
          bytes: null,
          errors: [],
        });
      }
    }

    skills.sort((a, b) => {
      const rank = (s) => (s.scope === 'project' ? 0 : s.scope === 'user' ? 1 : 2);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.name.localeCompare(b.name);
    });

    const index = new Map(skills.map((s) => [s.id, s]));
    return {
      cwd: p.cwd,
      hasProject: Boolean(p.cwd),
      agentDir: p.agentDir,
      homeDir: HOME,
      globalSettings: p.globalSettings,
      projectSettings: p.projectSettings,
      trust,
      piReachable: piSide.reachable,
      roots: roots.map((r) => ({
        label: r.label,
        dir: r.file || r.dir,
        scope: r.scope,
        mode: r.mode,
        exists: r.file ? fs.existsSync(r.file) : fs.existsSync(r.dir),
        blockedByTrust: r.scope === 'project' && trust.requiresTrust && !trust.trusted,
      })),
      diagnostics,
      skills,
      index,
    };
  }

  /** 纵深防御：按 ID 拿到的路径，必须真的落在某个已知发现根之下才允许读。 */
  function isUnderKnownRoot(file, idx) {
    const target = path.resolve(file);
    return idx.roots.some((r) => {
      if (!r.dir) return false;
      const root = path.resolve(r.dir);
      if (target === root) return true;
      const prefix = root.endsWith(path.sep) ? root : root + path.sep;
      return target.startsWith(prefix);
    });
  }

  function listPayload(idx) {
    return {
      ok: true,
      hasProject: idx.hasProject,
      cwd: idx.cwd,
      agentDir: idx.agentDir,
      homeDir: idx.homeDir,
      globalSettings: idx.globalSettings,
      projectSettings: idx.projectSettings,
      trust: idx.trust,
      piReachable: idx.piReachable,
      roots: idx.roots,
      diagnostics: idx.diagnostics,
      counts: {
        total: idx.skills.length,
        enabled: idx.skills.filter((s) => s.state === 'enabled').length,
        project: idx.skills.filter((s) => s.scope === 'project').length,
        user: idx.skills.filter((s) => s.scope === 'user').length,
      },
      skills: idx.skills,
    };
  }

  async function handleList(res) {
    try {
      const idx = await buildIndex();
      return json(res, 200, listPayload(idx));
    } catch (err) {
      // 整页打不开是最糟的结果，所以这里兜底成 200 + 空列表 + 一条诊断
      return json(res, 200, {
        ok: false,
        error: String(err.message || err),
        skills: [],
        diagnostics: [{ level: 'error', message: `扫描 skills 时出错：${err.message}` }],
      });
    }
  }

  async function handleDetail(res, id) {
    const idx = await buildIndex();
    const rec = idx.index.get(id);
    if (!rec) {
      return json(res, 404, { ok: false, error: '找不到这个 skill（可能刚被删掉或改名，刷新一下列表）' });
    }
    if (!rec.path) {
      return json(res, 200, { ok: true, skill: rec, content: '', truncated: false, files: [], readable: false, note: 'Pi GUI 没有定位到这个 skill 的文件，只能显示 pi 报告的元数据' });
    }
    if (!isUnderKnownRoot(rec.path, idx)) {
      return json(res, 403, { ok: false, error: '这个路径不在已知的 skill 目录下，拒绝读取' });
    }
    const stat = (() => {
      try {
        return fs.statSync(rec.path);
      } catch {
        return null;
      }
    })();
    const content = readTextSafe(rec.path);
    const files = [];
    try {
      for (const entry of fs.readdirSync(rec.dir, { withFileTypes: true })) {
        if (files.length >= MAX_DIR_ENTRIES) break;
        if (entry.name.startsWith('.')) continue;
        const full = path.join(rec.dir, entry.name);
        let size = null;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = null;
        }
        files.push({ name: entry.name, dir: entry.isDirectory(), size });
      }
    } catch {
      /* 目录读不了就不列 */
    }
    return json(res, 200, {
      ok: true,
      skill: rec,
      readable: content !== null,
      truncated: Boolean(stat && stat.size > MAX_SKILL_BYTES),
      bytes: stat ? stat.size : null,
      content: content === null ? '' : content.slice(0, MAX_SKILL_BYTES),
      files,
      note: content === null ? '文件读不出来（权限或编码问题），只能显示元数据' : '',
    });
  }

  /** 启停：往 pi 官方的 settings.json 里增删**我们自己那一条精确模式**。 */
  async function handleToggle(res, id, payload) {
    const idx = await buildIndex();
    const rec = idx.index.get(id);
    if (!rec) return json(res, 404, { ok: false, error: '找不到这个 skill，刷新一下列表' });
    if (!rec.toggleable || !rec.settingsPath || !rec.disablePattern) {
      return json(res, 400, {
        ok: false,
        error: rec.scope === 'temporary'
          ? '这个 skill 是通过命令行 --skill 临时加载的，没有对应的 settings 条目，无法在这里启停'
          : '这个 skill 没有可写入的 settings 文件，无法在这里启停',
      });
    }
    const enabled = payload.enabled === true;

    const read = readSettings(rec.settingsPath);
    if (read.error) return json(res, 409, { ok: false, error: `${read.error}。为安全起见没有做任何改动。` });
    const data = read.data || {};
    const existing = data.skills;
    if (existing !== undefined && !Array.isArray(existing)) {
      return json(res, 409, {
        ok: false,
        error: `${rec.settingsPath} 里的 "skills" 不是数组。为安全起见没有改动它 —— 请先手工修好这个字段。`,
        path: rec.settingsPath,
      });
    }
    const patterns = Array.isArray(existing) ? existing.slice() : [];

    /* 只增删「我们自己写的那一条精确模式」。
     * 用户可能写了一条通配（如 `!*foo*`）也把这个 skill 关掉了 —— 那种情况下
     * 我们不替他去改通配，而是在返回里如实说明「还有一条通配在关着它」。 */
    const ours = rec.disablePattern;
    const withoutOurs = patterns.filter((p) => p !== ours);
    const next = enabled ? withoutOurs : withoutOurs.includes(ours) ? withoutOurs : [...withoutOurs, ours];

    // 只有在「想打开」时才需要检查还有没有别的规则在关着它
    const stillDisabledBy = enabled ? disabledByPatterns(rec.path, next, rec.baseDir).pattern : '';
    const changed = JSON.stringify(next) !== JSON.stringify(patterns);

    if (changed) {
      const out = { ...data };
      if (next.length === 0 && !('skills' in data)) {
        // 本来就没有这个键、现在也不用加 —— 不动文件
      } else if (next.length === 0) {
        out.skills = [];
      } else {
        out.skills = next;
      }
      try {
        writeSettingsAtomic(rec.settingsPath, out);
      } catch (err) {
        return json(res, 500, { ok: false, error: `写入失败：${err.message}`, path: rec.settingsPath });
      }
    }

    const warnings = [];
    // stillDisabledBy 只在「想打开」时才有值：我们删掉了自己那条，但别的模式还在关着它
    if (stillDisabledBy) {
      warnings.push(`注意：${stillDisabledBy} 这条模式也命中它，所以只删掉 Pi GUI 写的那条不会生效，它仍然是停用状态`);
    }
    if (rec.blockedByTrust) {
      warnings.push('当前项目未被信任，pi 在非交互模式下不会加载项目级 skill —— 这条设置会在项目被信任后才生效');
    }
    if (!changed) warnings.push('设置本来就是这个样子，没有改动文件');

    return json(res, 200, {
      ok: true,
      path: rec.settingsPath,
      pattern: ours,
      enabled,
      changed,
      warnings,
      // 改的是 pi 的 settings，而 pi 只在启动时读它（没有文件监听）→ 必须重启
      restartRequired: changed,
      note: changed ? '已保存。pi 只在启动时读 settings.json，需要重启 pi 才会生效。' : '',
    });
  }

  async function handle(req, res, url) {
    const rest = url.pathname.replace(/^\/api\/skills\/?/, '');
    const id = rest ? decodeURIComponent(rest) : '';

    if (req.method === 'GET' && !id) return handleList(res);
    if (req.method === 'GET' && id) {
      if (id.length > 64) return json(res, 400, { ok: false, error: 'ID 不合法' });
      return handleDetail(res, id);
    }
    if (req.method === 'PUT' && id) {
      if (id.length > 64) return json(res, 400, { ok: false, error: 'ID 不合法' });
      const raw = await readBody(req).catch((err) => ({ __tooBig: String(err.message || err) }));
      if (raw && raw.__tooBig) return json(res, 413, { ok: false, error: raw.__tooBig });
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      if (typeof payload.enabled !== 'boolean') {
        return json(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
      }
      try {
        return await handleToggle(res, id, payload);
      } catch (err) {
        return json(res, 500, { ok: false, error: `操作失败：${err.message}` });
      }
    }
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  return {
    handle,
    // 供测试与其它模块使用
    readIndex: buildIndex,
    _internals: {
      parseFrontmatter,
      collectSkillEntries,
      ancestorAgentsSkillDirs,
      readTrustState,
      disabledByPatterns,
      matchesAnyPattern,
      matchesAnyExactPattern,
      skillId,
      validateName,
      validateDescription,
      writeSettingsAtomic,
      readSettings,
      paths,
    },
    get agentDir() {
      return AGENT_DIR;
    },
    get homeDir() {
      return HOME;
    },
  };
}

// 供测试直接引用
export { MAX_SKILL_BYTES };
