/* 已安装的 Pi 包：只读清单 + 受控的安装 / 卸载 / 更新。
 *
 * ---------- 与 Registry 的分工 ----------
 *
 * `extension-registry.js` 回答「Pi 会加载哪些 **Extension 入口文件**、它们的启用与
 * 加载证据」，它是只读的，这里不改它。这个模块回答另一件事：「settings 里登记了
 * 哪些 **包**、装没装上、是什么版本、能不能由 Pi GUI 管理」。两边用同一条 id 规则，
 * 清单里的 `extensionIds` 就是 Registry 里那些入口的 id，前端据此把两份数据对上。
 *
 * ---------- 清单只读盘，三值 ----------
 *
 * 与 Pi 1.6.0 的 `package-manager.js` 对齐（只读核对，不调用它）：
 *   - 包登记在 `<agentDir>/settings.json`（用户级）与 `<cwd>/.pi/settings.json`
 *     （项目级）的 `packages` 数组里，条目是字符串或 `{ source, … }`。
 *   - npm 包装在 `<根>/npm/node_modules/<包名>`。**用户级**的包在托管目录里找不到时，
 *     Pi 还会去旧的全局 npm 目录找，再不行就在下次启动时自动补装 —— 所以托管目录
 *     里没有 ≠ 没装：这种情况 `installed` 是 **null（未知）**，不是 false。
 *   - 同一个包两级都登记时，项目级生效（`shadowed`）。
 *
 * 这里**不**探测全局 npm 目录（那要起子进程，也不该碰用户的全局 npm）。
 *
 * ---------- 能管理什么 ----------
 *
 * 只有**用户级、npm 来源、包名过严格规则**的包才有卸载 / 更新；其余（项目级、
 * Git、本地目录）只展示，并给出原因与手动命令。依据：
 *   - 官方命令带 `--no-approve` 时项目级 settings 被忽略，GUI 不替用户做
 *     「信任这个项目」的决定，也不改写项目仓库里的文件；
 *   - Pi 不更新固定了精确版本的包（`npm:foo@1.2.3`），所以这类包的更新是禁用的；
 *   - Pi 没有非交互的启用 / 停用命令（`pi config` 是交互式 TUI），所以没有开关。
 *
 * ---------- 操作的事实边界 ----------
 *
 * renderer 只送受控 id（市场条目 `npm:<包名>` 或清单里的 `pkg_<hash>`）。
 * 这里把它解析成 source，交给 `capability-install.js` 的 `startOperation`
 * （固定 argv、同一把锁、暂停 Pi、自动恢复）。命令结束后**在同一把锁里重新读盘**：
 * 响应里的 `verified` 是读盘得到的结论，退出码只是其中一条线索；`loaded` 永远是
 * null —— 加载证据要等 Pi 重启后由 Registry 给。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { json, readBody } from './http-utils.js';
import { containedExtensionPath, readExtensionJson, resolvePackageExtensionPaths } from '../lib/extension-paths.js';
import { packageOperation, isControlledSource } from './capability-install.js';
import { cleanText, cleanVersion, compareSemver, satisfiesRange, knownCapabilityOf, nameOfMarketId } from './extension-market-catalog.js';

const MAX_ENTRIES = 300;
const MAX_BODY_BYTES = 4096;
const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

/* 与 extension-registry.js 同一条 id 规则。那边不导出它，也不该为了这里去改一个
 * 只读模块；两边算出的 id 必须相等，由 tests/extension-packages.cjs 用真实的
 * Registry 交叉核对（漂了就红）。 */
const cmp = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 20);
const extensionIdOf = (file) => sha(cmp(file));
const realOrResolved = (file) => {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
};

function insideProject(cwd, agentDir) {
  if (!cwd) return false;
  const relative = path.relative(realOrResolved(cwd), realOrResolved(agentDir));
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

/* Pi 的 `parseNpmSpec`：名字里不含 `@`（scope 的前导 `@` 除外），其后可跟 `@版本`。 */
const NPM_SPEC_RE = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/;
/* Pi 用 `semver.valid()` 判断「是不是精确版本」；这是它的严格文法
 * （可带一个前导 `v`，数字段不带前导零）。 */
const EXACT_VERSION_RE = /^v?(?:0|[1-9]\d{0,15})\.(?:0|[1-9]\d{0,15})\.(?:0|[1-9]\d{0,15})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/* 只读定位用的宽松包名（字符集与 Registry 相同）；纯点号的段会被 path.join
 * 解释成上级目录，单独排除。**操作**要求的是另一条严格规则（isControlledSource）。 */
const LOCATABLE_NAME_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const hasDotSegment = (name) => name.split('/').some((segment) => /^@?\.+$/.test(segment));
const SECRET_WORD_RE = /(?:api[_-]?key|token|password|credential|secret|authorization|bearer|ghp_)/i;
const DIST_TAG_RE = /^[a-z][a-z0-9._-]{0,63}$/i;
const SEMVER_RANGE_CHARS = /^[0-9vVxX.*+~^<>=| -]+$/;

function packageVersionSpec(version, pin) {
  if (pin === 'none') return null;
  const value = version.trim();
  if (value.length > 64) return null;
  const range = SEMVER_RANGE_CHARS.test(value) && satisfiesRange('1.2.3', value) !== null;
  return pin === 'exact' || DIST_TAG_RE.test(value) || range ? value : null;
}

/* Pi 1.6 normalizes file URLs, shell drive paths and ~ before opening settings. */
function resolvePackageAgentDir(override, home, cwd) {
  let location = override || path.join(home, '.pi', 'agent');
  if (location === '~' || location.startsWith('~/') || (process.platform === 'win32' && location.startsWith('~\\'))) {
    location = path.join(home, location.slice(2));
  } else if (location.startsWith('file://')) {
    try { location = fileURLToPath(location); } catch { return null; }
  } else if (process.platform === 'win32' && !location.includes('\\')) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(location);
    if (drive) location = `${drive[1]}:/${drive[2] || ''}`;
  }
  return path.resolve(cwd || process.cwd(), location);
}

/** 包的描述是不可信元数据：出现凭据字样就整段不展示（与 Registry 同一条规则）。 */
function safeDescription(value) {
  if (typeof value !== 'string' || SECRET_WORD_RE.test(value)) return null;
  return cleanText(value, 300) || null;
}

/**
 * Git 来源 → `host/path` 展示标签。URL 里可能带用户名 / 令牌，所以**原始 source
 * 永远不出后端**；认不出安全的形状就回 null（界面只说「Git 仓库」）。
 */
function gitLabel(text) {
  let rest = text.replace(/^git:/, '');
  if (rest.startsWith('github:')) rest = `https://github.com/${rest.slice('github:'.length)}`;
  let host = '';
  let pathname = '';
  if (/^(?:https?|ssh|git):\/\//.test(rest)) {
    try {
      const url = new URL(rest);
      host = url.hostname;
      pathname = url.pathname;
    } catch {
      return null;
    }
  } else {
    const short = /^(?:[^@/\s]+@)?([^:/\s]+)[:/](.+)$/.exec(rest);
    if (!short) return null;
    host = short[1];
    pathname = short[2];
  }
  const label = `${host}/${pathname.replace(/^\/+/, '').replace(/@[^/]*$/, '').replace(/\.git$/, '')}`;
  return /^[A-Za-z0-9.-]{1,100}\/[A-Za-z0-9._/-]{1,150}$/.test(label) ? label : null;
}

/** 与 Pi 的 `parseSource` 同一套分流：npm / git / 本地；`builtin:` 归为不可定位。 */
export function parsePackageSource(source) {
  if (source.startsWith('npm:')) {
    const spec = source.slice('npm:'.length).trim();
    const m = NPM_SPEC_RE.exec(spec);
    const version = m && m[2] !== undefined ? m[2] : null;
    return {
      kind: 'npm',
      name: m ? m[1] : spec,
      version,
      /* none = 没写版本；exact = 精确版本（Pi 不更新它）；range = 区间或标签。 */
      pin: version === null ? 'none' : EXACT_VERSION_RE.test(version.trim()) ? 'exact' : 'range',
    };
  }
  const text = source.trim();
  if (/^(?:git:|github:|https?:|ssh:)/.test(text)) return { kind: 'git', label: gitLabel(text) };
  if (text.startsWith('builtin:')) return { kind: 'unknown' };
  return { kind: 'local', path: source };
}

const sourceOf = (entry) => {
  const source = typeof entry === 'string' ? entry : isRecord(entry) ? entry.source : null;
  return typeof source === 'string' && source.trim() ? source : null;
};

const countStrings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').length : null);

function declaredResources(data) {
  const pi = isRecord(data) && isRecord(data.pi) ? data.pi : null;
  return {
    declared: Boolean(pi),
    extensions: pi ? countStrings(pi.extensions) : null,
    skills: pi ? countStrings(pi.skills) : null,
    prompts: pi ? countStrings(pi.prompts) : null,
    themes: pi ? countStrings(pi.themes) : null,
  };
}

const CAUSE_HINTS = Object.freeze({
  network: '连不上包仓库。请检查网络或代理后重试 —— Pi 调用的是本机的 npm，用的是 npm 自己的代理与镜像配置。',
  'package-not-found': '包仓库里没有找到这个包：可能已下架，或本机 npm 指向的镜像还没同步到它。',
  permission: '没有权限写入 Pi 的包目录，或文件正被占用。请关闭其它正在使用 Pi 的程序后重试。',
  'disk-full': '磁盘空间不足。',
  integrity: '下载内容没有通过完整性校验（通常是缓存损坏或镜像问题）。可以先运行 npm cache verify 再重试。',
  'version-unresolved': '包仓库里没有满足要求的版本。',
  'package-manager-missing': '没有找到 npm。Pi 通过本机的 npm 安装扩展包，请先确认 npm 可用。',
  'not-configured': 'Pi 的配置里已经没有这个包了（可能刚在别处被移除）。请刷新列表。',
  timeout: '命令超时后被终止，包目录可能停在一半的状态。可以稍后重试，或按下面的命令手动处理。',
});

/** 手动恢复用的命令原文：只给用户看 / 复制，**这里不执行**。 */
function manualCommand(action, name, scope = 'global') {
  const local = scope === 'project' ? ' -l' : '';
  if (action === 'install') return `pi install npm:${name}${local}`;
  if (action === 'remove') return `pi remove npm:${name}${local}`;
  return `pi update --extension npm:${name}`;
}

/**
 * @param runtime     { getCurrentCwd() }
 * @param env         HOME / PI_CODING_AGENT_DIR 的来源（测试注入临时目录）
 * @param operations  capability-install 的实例：{ startOperation, available, isRunning }
 * @param catalog     插件市场：{ has(id), flagged(id), latestVersion(name), warm(), status() }
 */
export function createExtensionPackages({ runtime, env = process.env, operations = null, catalog = null } = {}) {
  const home = env === process.env ? os.homedir() : env.HOME || os.homedir();
  const currentCwd = () => runtime?.getCurrentCwd?.() || null;
  const agentDirFor = (cwd) => resolvePackageAgentDir(env.PI_CODING_AGENT_DIR, home, cwd);

  function canManageAgentDir() {
    const cwd = currentCwd();
    const agentDir = agentDirFor(cwd);
    return Boolean(agentDir && !insideProject(cwd, agentDir));
  }

  function operationsMeta() {
    let available = false;
    let running = false;
    try {
      available = Boolean(operations && typeof operations.available === 'function' && operations.available());
      running = Boolean(operations && typeof operations.isRunning === 'function' && operations.isRunning());
    } catch {
      /* 判断不了就当不可用：不出现任何操作按钮 */
    }
    return { available, running };
  }

  function latestOf(name) {
    try {
      return catalog && typeof catalog.latestVersion === 'function' ? cleanVersion(catalog.latestVersion(name)) : null;
    } catch {
      return null;
    }
  }

  /** 这个包能做什么；不能做就带上原因（界面把按钮禁用并显示它）。 */
  function actionsOf(record, strict, available) {
    const deny = (reason) => ({ allowed: false, reason });
    let blocked = '';
    if (record.kind === 'git') blocked = 'Git 来源的包请在终端用 pi 命令管理';
    else if (record.kind === 'local') blocked = '本地目录里的包由你自己维护，Pi GUI 不改动它';
    else if (record.kind !== 'npm' || !strict) blocked = '这个来源不在 Pi GUI 的受控范围内，请在终端用 pi 命令管理';
    else if (record.scope === 'project') blocked = '这是项目级配置。Pi GUI 只管理用户级的包，请在项目目录里用 pi 命令管理';
    else if (!available) blocked = '当前这份 Pi 没有可证明的官方 CLI 入口，无法执行包操作';
    if (blocked) return { update: deny(blocked), remove: deny(blocked) };
    let flagged = false;
    try { flagged = catalog?.flagged?.(`npm:${record.name}`) === true; }
    catch { return { update: deny('无法校验目录记录，请刷新后重试'), remove: { allowed: true, reason: '' } }; }
    return {
      update: flagged ? deny('npm 把这个包标记为不安全，Pi GUI 不提供更新')
        : record.pin !== 'none' && record.spec === null
        ? deny('配置使用了不受支持的版本来源，请在终端管理')
        : record.pin === 'exact'
        ? deny(`已固定在 ${record.spec}，Pi 不会更新固定了精确版本的包`)
        /* repair：托管目录里读不到它，「更新」实际会把它重新装上。 */
        : { allowed: true, reason: '', repair: record.installed !== true },
      remove: { allowed: true, reason: '' },
    };
  }

  function describe(entry, root, { light, available }) {
    const source = sourceOf(entry);
    if (!source) return null;
    const parsed = parsePackageSource(source);
    const objectForm = isRecord(entry);
    const filtered = objectForm && (entry.extensions !== undefined || entry.autoload === false);
    let packageRoot = null;
    let identity;
    let name;
    let label;
    if (parsed.kind === 'npm') {
      name = cleanText(parsed.name, 214);
      /* `npm:` 后面什么都没有：没有可以展示、也没有可以定位的东西。 */
      if (!name) return null;
      identity = `npm:${parsed.name}`;
      label = `npm:${name}`;
      if (LOCATABLE_NAME_RE.test(parsed.name) && !hasDotSegment(parsed.name)) {
        packageRoot = path.join(root.base, 'npm', 'node_modules', parsed.name);
      }
    } else if (parsed.kind === 'local') {
      packageRoot = path.isAbsolute(parsed.path) ? parsed.path : path.resolve(root.base, parsed.path);
      identity = `local:${cmp(packageRoot)}`;
      name = cleanText(path.basename(packageRoot), 214) || '本地包';
      label = cleanText(packageRoot, 300);
    } else if (parsed.kind === 'git') {
      identity = `git:${parsed.label ? parsed.label.toLowerCase() : sha(source)}`;
      name = parsed.label ? parsed.label.split('/').pop() : 'Git 仓库';
      label = parsed.label || 'Git 仓库';
    } else {
      identity = `raw:${sha(source)}`;
      name = '未识别的来源';
      label = '未识别的来源';
    }
    const strict = parsed.kind === 'npm' && isControlledSource(`npm:${parsed.name}`);
    const manifest = packageRoot ? readExtensionJson(path.join(packageRoot, 'package.json')) : { data: null, error: 'unlocatable' };
    let installed = null;
    let problem = null;
    if (manifest.data) {
      if (parsed.kind === 'npm' && manifest.data.name !== parsed.name) {
        problem = { code: 'metadata-mismatch', message: '托管目录里的包与配置登记的名字对不上' };
      } else installed = true;
    } else if (manifest.error === 'metadata-invalid') {
      problem = { code: 'metadata-invalid', message: '这个包的 package.json 无法解析' };
    } else if (manifest.error === 'missing') {
      if (parsed.kind === 'local') {
        /* 本地包可以没有 package.json（Pi 按约定目录收集资源）：看目录在不在。 */
        installed = fs.existsSync(packageRoot);
        if (!installed) problem = { code: 'package-missing', message: '配置里登记的本地路径不存在' };
      } else if (root.scope === 'global') {
        problem = {
          code: 'files-unconfirmed',
          message: 'Pi 的托管目录里没有这个包的文件。它可能装在旧的全局 npm 目录里；否则 Pi 下次启动时会尝试自动补装',
        };
      } else {
        installed = false;
        problem = { code: 'package-missing', message: '已在项目配置里登记，但没有找到包文件' };
      }
    } else if (parsed.kind === 'npm') {
      /* 包名带路径段或别的非常规字符：不拿它去拼路径，安装状态就是未知。 */
      problem = { code: 'unlocatable', message: '这个包名不是常规的 npm 包名，Pi GUI 不去定位它的文件' };
    }
    const data = installed === true ? manifest.data : null;
    const record = {
      id: `pkg_${sha(`${root.scope}\0${parsed.kind}\0${identity}\0${source}`)}`,
      kind: parsed.kind,
      name,
      scope: root.scope,
      source: label,
      spec: parsed.kind === 'npm' ? packageVersionSpec(parsed.version, parsed.pin) : null,
      pin: parsed.kind === 'npm' ? parsed.pin : 'none',
      installed,
      version: data ? cleanVersion(data.version) : null,
      description: data ? safeDescription(data.description) : null,
      location: packageRoot && (parsed.kind === 'npm' || parsed.kind === 'local') ? packageRoot : null,
      capabilityId: strict ? knownCapabilityOf(parsed.name) : null,
      resources: declaredResources(data),
      extensionIds: [],
      /* 对象形式的条目可能筛掉了一部分资源：是否启用以 Registry 的逐项结论为准。 */
      filtered,
      shadowed: false,
      latest: null,
      updateAvailable: null,
      problem,
      identity,
    };
    record.actions = actionsOf(record, strict, available);
    record.manual = strict
      ? {
        update: manualCommand('update', parsed.name, root.scope),
        remove: manualCommand('remove', parsed.name, root.scope),
        /* 重新安装不带版本的同名包会把固定版本的条目换掉（Pi 按包身份替换）。 */
        unpin: record.pin === 'exact' ? manualCommand('install', parsed.name, root.scope) : null,
      }
      : null;
    if (light) return record;
    if (packageRoot) {
      /* 与 Registry 同样的参数调同一个解析函数 —— 得到的就是同一批入口文件。 */
      const rows = resolvePackageExtensionPaths(packageRoot, manifest.data, { diagnostics: [], objectForm, filtered });
      record.extensionIds = [...new Set(rows.map((row) => extensionIdOf(row.file)))];
    }
    if (strict) {
      record.latest = latestOf(parsed.name);
      if (record.installed === true && record.version && record.latest) {
        const newer = compareSemver(record.latest, record.version) === 1;
        if (!newer) record.updateAvailable = false;
        /* 登记的是区间 / 标签：最新版落在区间里才敢说「有更新」，否则是未知。 */
        else if (!record.actions.update.allowed) record.updateAvailable = false;
        else if (record.pin === 'range') record.updateAvailable = satisfiesRange(record.latest, record.spec) === true ? true : null;
        else record.updateAvailable = true;
      }
    }
    return record;
  }

  /**
   * 读盘得到的包清单。`light` 只要身份与安装事实（给市场和操作计划用），
   * 不解析入口文件、不查目录版本。
   */
  function readInventory({ light = false } = {}) {
    const cwd = currentCwd();
    const agentDir = agentDirFor(cwd);
    if (!agentDir) return { ok: false, code: 'settings-unreadable', packages: [] };
    const roots = [{ scope: 'global', base: agentDir, settings: path.join(agentDir, 'settings.json') }];
    if (cwd) {
      const projectDir = path.join(cwd, '.pi');
      if (cmp(realOrResolved(projectDir)) === cmp(realOrResolved(agentDir))) roots.pop();
      roots.unshift({ scope: 'project', base: projectDir, settings: path.join(projectDir, 'settings.json') });
    }
    const ops = operationsMeta();
    const diagnostics = [];
    const writableScope = !insideProject(cwd, agentDir);
    if (!writableScope) {
      ops.available = false;
      diagnostics.push({ scope: 'global', code: 'project-agent-dir', message: 'Pi 的用户配置目录位于当前项目内，应用已禁用包写入' });
    }
    const packages = [];
    const projectIdentities = new Set();
    for (const root of roots) {
      const settings = readExtensionJson(root.settings);
      if ((settings.error && settings.error !== 'missing')
        || (settings.data?.packages !== undefined && !Array.isArray(settings.data.packages))) {
        diagnostics.push({ scope: root.scope, code: 'settings-invalid', message: 'Pi 的 settings.json 无法解析，这一级的包清单读不出来' });
      }
      const entries = settings.data && Array.isArray(settings.data.packages) ? settings.data.packages : [];
      if (entries.length > MAX_ENTRIES) {
        diagnostics.push({ scope: root.scope, code: 'limit', message: `包条目超过 ${MAX_ENTRIES} 个，只读取了前 ${MAX_ENTRIES} 个` });
      }
      const seen = new Set();
      for (const entry of entries.slice(0, MAX_ENTRIES)) {
        const record = describe(entry, root, { light, available: ops.available });
        if (!record) {
          diagnostics.push({ scope: root.scope, code: 'entry-invalid', message: '包清单里有一个无法识别的条目' });
          continue;
        }
        /* 同一级里重复登记同一个包：Pi 只认第一条。 */
        if (seen.has(record.identity)) {
          diagnostics.push({ scope: root.scope, code: 'duplicate-entry', message: '同一个包在这一级配置里登记了不止一次，Pi 只使用第一条' });
          continue;
        }
        seen.add(record.identity);
        /* `autoload:false` 的项目条目是对用户级条目的增量，两条都生效，不算覆盖。 */
        if (root.scope === 'project' && !(isRecord(entry) && entry.autoload === false)) projectIdentities.add(record.identity);
        packages.push(record);
      }
    }
    for (const record of packages) {
      record.shadowed = record.scope === 'global' && projectIdentities.has(record.identity);
      delete record.identity;
    }
    let status = { remote: false, at: null };
    try {
      if (catalog && typeof catalog.status === 'function') status = catalog.status();
    } catch {
      /* 目录状态读不到不影响清单 */
    }
    return {
      ok: true,
      hasProject: Boolean(cwd),
      packages,
      diagnostics,
      operations: ops,
      /* 新装的包会落在这里（用户级托管目录）。 */
      installRoot: path.join(agentDir, 'npm', 'node_modules'),
      catalog: { remote: Boolean(status && status.remote), at: status && Number.isFinite(status.at) ? status.at : null },
    };
  }

  /**
   * 包名 → 本机安装摘要（给插件市场标「已安装 / 可更新」）。
   * 两级都登记时取用户级那条 —— 市场里的操作只作用于用户级。
   */
  function installedIndex() {
    const index = new Map();
    const { ok, packages, diagnostics } = readInventory({ light: true });
    if (!ok || diagnostics.some(({ code }) => code === 'settings-invalid' || code === 'limit')) return null;
    for (const pkg of packages) {
      if (pkg.kind !== 'npm') continue;
      const prior = index.get(pkg.name);
      if (prior && (prior.scope === 'global' || pkg.scope !== 'global')) continue;
      index.set(pkg.name, {
        installed: pkg.installed,
        version: pkg.version,
        scope: pkg.scope,
        packageId: pkg.id,
        pinned: pkg.pin === 'exact',
        ...(pkg.pin === 'range' ? { range: pkg.spec } : {}),
        canUpdate: pkg.actions.update.allowed === true,
        canRemove: pkg.actions.remove.allowed === true,
      });
    }
    return index;
  }

  /** 用户级这一个包此刻在盘上的事实：登记了吗、文件在吗、什么版本。 */
  function configuredSources(root, name) {
    const settings = readExtensionJson(path.join(root, 'settings.json'));
    if (!settings.data) return settings.error === 'missing' ? [] : null;
    const entries = settings.data.packages;
    if (entries === undefined) return [];
    if (!Array.isArray(entries)) return null;
    return entries.map(sourceOf).filter((source) => {
      if (!source) return false;
      const parsed = parsePackageSource(source);
      return parsed.kind === 'npm' && parsed.name === name;
    });
  }

  function diskState(name, agentDir = agentDirFor(currentCwd())) {
    const sources = configuredSources(agentDir, name);
    const configured = sources ? sources.length > 0 : null;
    const manifest = readExtensionJson(path.join(agentDir, 'npm', 'node_modules', name, 'package.json'));
    const files = manifest.data ? manifest.data.name === name : manifest.error === 'missing' ? false : null;
    return { configured, files, version: files === true ? cleanVersion(manifest.data.version) : null };
  }

  /** renderer 的受控 id → 服务端的执行计划。全程同步、只读盘。 */
  function planOf(action, id, { cwd = currentCwd(), agentDir = agentDirFor(cwd) } = {}) {
    if (!agentDir) return fail('settings-unreadable', '无法确定 Pi 的用户配置目录，已拒绝操作', { action });
    if (insideProject(cwd, agentDir)) return fail('project-agent-dir', 'Pi 的用户配置目录位于当前项目内，已拒绝包写入', { action });
    if (action === 'install') {
      const name = nameOfMarketId(id);
      if (!name) return fail('bad-id', '扩展标识不合法，已拒绝安装', { action });
      let known = false;
      let flagged = false;
      try {
        known = Boolean(catalog && typeof catalog.has === 'function' && catalog.has(id));
        flagged = Boolean(known && typeof catalog.flagged === 'function' && catalog.flagged(id));
      } catch {
        known = false;
      }
      /* 只装目录里**此刻真有**的包：renderer 不能凭一个名字让后端去装任意 npm 包。 */
      if (!known) return fail('unknown-item', '插件市场的目录里没有这个包，已拒绝安装（请刷新目录后重试）', { action });
      if (flagged) return fail('not-allowed', 'npm 把这个包标记为不安全，Pi GUI 不提供安装', { action, id, name });
      const global = configuredSources(agentDir, name);
      const project = cwd ? configuredSources(path.join(cwd, '.pi'), name) : [];
      if (global === null || project === null) {
        return fail('settings-unreadable', '无法确认用户或项目的包配置，请修复 settings.json 后重试', { action, id, name });
      }
      if (global.length) {
        return fail('already-installed', '这个包已经安装；需要新版本请用「更新」', { action, id, name });
      }
      if (project.length) return fail('already-installed', '当前项目已经配置了这个包，Pi GUI 不重复安装', { action, id, name });
      return { ok: true, action, id, name, source: `npm:${name}` };
    }
    if (!/^pkg_[0-9a-f]{20}$/.test(id)) return fail('bad-id', '扩展标识不合法，已拒绝操作', { action });
    const record = readInventory({ light: true }).packages.find((pkg) => pkg.id === id);
    if (!record) return fail('unknown-package', '没有找到这个已安装的包（可能已被移除），请刷新后重试', { action });
    const rule = record.actions[action];
    if (!rule || rule.allowed !== true) {
      return fail('not-allowed', (rule && rule.reason) || '这个包不支持该操作', { action, id, name: record.name });
    }
    const sources = configuredSources(agentDir, record.name);
    if (sources?.length !== 1) {
      return fail('not-allowed', '用户配置中无法确认这个包的唯一登记，请检查 settings.json', { action, id, name: record.name });
    }
    return { ok: true, action, id, name: record.name, source: `npm:${record.name}` };
  }

  /**
   * 命令结束后（仍在锁里）重新读盘，把「命令完成」换成「盘上现在是什么」。
   * 失败也读：命令跑到一半可能已经动过磁盘，界面要能如实显示。
   */
  function settle(plan, before, result, agentDir) {
    const after = diskState(plan.name, agentDir);
    const base = { ...result, id: plan.id, name: plan.name, before, after, manual: manualCommand(plan.action, plan.name) };
    if (result.ok !== true) {
      const cause = result.cause || (/-timeout$/.test(String(result.code)) ? 'timeout' : null);
      return { ...base, verified: null, hint: (cause && CAUSE_HINTS[cause]) || null };
    }
    if (plan.action === 'install') {
      const verified = after.configured === true && after.files === true ? true
        : after.configured === null || after.files === null ? null : false;
      return verified === true
        ? { ...base, code: 'installed', verified }
        : { ...base, ok: false, code: 'unverified', verified, error: '安装命令已结束，但没有在 Pi 的配置与托管目录里确认到这个包' };
    }
    if (plan.action === 'remove') {
      const verified = after.configured === false ? true : after.configured === null ? null : false;
      return verified === true
        ? { ...base, code: 'removed', verified, filesRemain: after.files === true }
        : { ...base, ok: false, code: 'unverified', verified, error: '卸载命令已结束，但 Pi 的配置里仍然登记着这个包' };
    }
    if (after.configured !== true || after.files !== true) {
      const verified = after.configured === null || after.files === null ? null : false;
      return { ...base, ok: false, code: 'unverified', verified, error: '更新命令已结束，但无法确认 Pi 的包配置与托管文件' };
    }
    let code = 'unchanged';
    if (before.files !== true) code = 'reinstalled';
    else if (before.version && after.version && before.version !== after.version) code = 'updated';
    /* 版本没变时，stdout 里的结论只用来解释「为什么没变」。 */
    else if (result.outcome === 'up-to-date' || result.outcome === 'not-updated' || result.outcome === 'skipped-offline') code = result.outcome;
    return { ...base, code, verified: true };
  }

  async function act(body) {
    const input = isRecord(body) ? body : {};
    const def = packageOperation(input.action);
    if (!def) return fail('unknown-action', '不支持的扩展操作，已拒绝');
    const action = def.action;
    if (typeof input.id !== 'string' || !input.id || input.id.length > 240) return fail('bad-id', '扩展标识不合法，已拒绝操作', { action });
    if (!operations || typeof operations.startOperation !== 'function') {
      return fail('unsupported', '当前运行方式不支持扩展包操作', { action });
    }
    /* 只读磁盘缓存（且仅在已同意读取在线目录时）；不联网。 */
      if (catalog && typeof catalog.warm === 'function') {
      try {
        await catalog.warm();
      } catch {
        /* 缓存读不到：目录里就只有内置条目，下面的闸门照常判 */
      }
    }
    /* 从这里到 startOperation 上锁**没有 await**：计划、操作前的读盘与上锁在同一个
     * tick 里完成，不会被另一个请求插进来。 */
    const cwd = currentCwd();
    const agentDir = agentDirFor(cwd);
    const plan = planOf(action, input.id, { cwd, agentDir });
    if (!plan.ok) return plan;
    const managedPaths = [
      path.join('npm', 'node_modules', plan.name),
      path.join('npm', 'package.json'),
      path.join('npm', 'package-lock.json'),
    ];
    if (managedPaths.some((relative) => !containedExtensionPath(agentDir, relative))) {
      return fail('unsafe-package-path', 'Pi 的托管包路径无法安全定位，已拒绝操作', { action, id: plan.id, name: plan.name });
    }
    const before = diskState(plan.name, agentDir);
    /* 用户级 settings.json 解析不了：Pi 在这种状态下不保存包登记（它不覆盖读不懂的
     * 配置文件，见 settings-manager 的 save()），命令跑完只会留下一个没登记的目录。 */
    if (before.configured === null) {
      return fail('settings-unreadable', 'Pi 的用户级 settings.json 无法解析。Pi 在这种状态下不会保存包登记，已拒绝操作；请先修复这个文件后再试', {
        action, id: plan.id, name: plan.name,
      });
    }
    const result = await operations.startOperation(input, {
      action,
      source: plan.source,
      agentDir,
      finish: (settled) => settle(plan, before, settled, agentDir),
    });
    /* 闸门直接拒绝的（没确认 / 忙 / 工作区过期…）不经过 settle：补上身份字段。
     * 结果自己带的字段优先 —— 复核抛错时命令其实已经跑过，`commandStarted` 不能被盖成 false。 */
    return isRecord(result) && result.before
      ? result
      : {
        action, id: plan.id, name: plan.name, commandStarted: false,
        ...(isRecord(result) ? result : fail('operation-failed', '扩展操作没有返回结果')),
      };
  }

  async function handle(req, res) {
    try {
      if (req.method === 'GET') {
        if (catalog && typeof catalog.warm === 'function') {
          try {
            await catalog.warm();
          } catch {
            /* 没有目录缓存只是少了「最新版本」一列 */
          }
        }
        return json(res, 200, readInventory());
      }
      if (req.method !== 'POST') return json(res, 405, fail('method-not-allowed', '只支持 GET / POST'));
      let body;
      try {
        body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}');
      } catch {
        return json(res, 400, fail('bad-body', '请求体不是合法 JSON'));
      }
      if (!isRecord(body)) return json(res, 400, fail('bad-body', '请求体不是合法 JSON 对象'));
      /* 业务上的拒绝一律 200 + ok:false（与已知能力安装同一种约定）。 */
      return json(res, 200, await act(body));
    } catch {
      return json(res, 200, fail('packages-failed', '读取扩展包清单失败', { packages: [], diagnostics: [] }));
    }
  }

  return { handle, act, readInventory, installedIndex, canManageAgentDir, _internals: { planOf, diskState, settle } };
}
