/* MCP —— 如实的能力报告，不是一套 MCP 管理器。
 *
 * ---------- 为什么这里没有 MCP Server 列表 ----------
 *
 * pi 0.87.0 **没有原生 MCP 支持，而且是有意为之**。`docs/usage.md:310` 原文：
 *
 *   "It intentionally does not include built-in MCP, sub-agents, permission popups,
 *    plan mode, to-dos, or background bash. You can build or install those workflows
 *    as extensions or packages, or use external tools such as containers and tmux."
 *
 * 全包（排除 `dist/**\/bundle/` 与 `node_modules/`）搜 `mcp` 只命中那句文档、
 * `dist/core/export-html/vendor/highlight.min.js` 与 `dist/utils/tool-result-images.js`
 * （后两者无关）；`examples/` 零命中；**没有 `mcpServers` / `.mcp.json` / `mcp.json`
 * 任何配置约定**。
 *
 * 所以本模块**不做**下面这些事，做了就是撒谎：
 *   - 不假装有 MCP Server 可以增删改；
 *   - 不在 `.pi-gui/` 里自己存一份 MCP 配置（pi 不会读它，等于一个假开关）；
 *   - 不显示「已配置 / 已连接」这种没有数据支撑的状态。
 *
 * 它做的是：**报告 pi 到底支不支持 MCP（带可核对的证据），并指出 pi 官方给的
 * 替代路径 —— extension —— 以及本机已经装了哪些 extension。**
 * 这样用户看到的不是一页空白，而是「为什么没有 + 该怎么做」。
 *
 * ---------- 检测方式 ----------
 *
 * 不硬编码「0.87.0 没有 MCP」这句话，而是**去读本机真正装着的那个 pi 包**：
 *   1. 定位 pi 包目录（从 PI_BIN 推、或扫几个 npm 全局位置）；
 *   2. 读它的 package.json 拿版本号；
 *   3. 看 `dist/core/` 下有没有名字带 mcp 的模块；
 *   4. 从 `docs/usage.md` 里截出提到 MCP 的那句话当证据。
 * 找不到包就如实回 unknown —— 不猜。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json } from './http-utils.js';

/** pi 包的 npm 名（从 dist/config.js 的 PACKAGE_NAME 默认值抄来）。 */
const PI_PACKAGE = path.join('@earendil-works', 'pi-coding-agent');
const CONFIG_DIR = '.pi';
const EXTENSIONS_SUBDIR = 'extensions';
const MAX_DOC_BYTES = 256 * 1024;
const MAX_EVIDENCE_CHARS = 400;
const MAX_LIST = 200;

function readJsonSafe(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readTextSafe(file, maxBytes = MAX_DOC_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 从 PI_BIN 与几个 npm 全局位置里找出 pi 包目录。找不到回 null。 */
function locatePiPackage({ piBin, env }) {
  const candidates = [];
  const add = (p) => {
    if (p) candidates.push(p);
  };

  // 1) PI_BIN 若是路径，包就在它旁边的 node_modules 里
  const bin = piBin || env.PI_BIN || '';
  if (bin && (bin.includes('/') || bin.includes('\\'))) {
    let dir = path.dirname(path.resolve(bin));
    // npm 的 bin 目录可能是 <prefix> 或 <prefix>/bin
    for (let i = 0; i < 3; i++) {
      add(path.join(dir, 'node_modules', PI_PACKAGE));
      add(path.join(dir, 'lib', 'node_modules', PI_PACKAGE));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // 2) 常见的全局安装位置
  if (env.APPDATA) add(path.join(env.APPDATA, 'npm', 'node_modules', PI_PACKAGE));
  if (env.LOCALAPPDATA) {
    add(path.join(env.LOCALAPPDATA, 'Programs', 'pi', 'node_modules', PI_PACKAGE));
    add(path.join(env.LOCALAPPDATA, 'npm', 'node_modules', PI_PACKAGE));
  }
  const home = env.HOME || os.homedir();
  add(path.join(home, '.local', 'lib', 'node_modules', PI_PACKAGE));
  add(path.join(home, 'node_modules', PI_PACKAGE));
  add(path.join('/usr', 'local', 'lib', 'node_modules', PI_PACKAGE));
  add(path.join('/opt', 'homebrew', 'lib', 'node_modules', PI_PACKAGE));

  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'package.json'))) return dir;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** 检测这个 pi 包有没有原生 MCP。返回 {supported, evidence, version, packageDir}。 */
function detectMcpSupport({ piBin, env }) {
  const packageDir = locatePiPackage({ piBin, env });
  if (!packageDir) {
    return {
      supported: null,
      packageDir: null,
      version: null,
      evidence: '',
      reason: '没有找到本机安装的 pi 包，无法检测它是否支持 MCP',
    };
  }
  const pkg = readJsonSafe(path.join(packageDir, 'package.json')) || {};
  const version = typeof pkg.version === 'string' ? pkg.version : null;

  // 1) dist/core 下有没有 mcp 模块
  const coreHits = [];
  try {
    for (const entry of fs.readdirSync(path.join(packageDir, 'dist', 'core'), { withFileTypes: true })) {
      if (/mcp/i.test(entry.name)) coreHits.push(entry.name);
    }
  } catch {
    /* dist/core 不存在就跳过这一路证据 */
  }
  // 2) package.json 里有没有 mcp 依赖/字段
  const pkgText = JSON.stringify(pkg);
  const pkgHits = /mcp/i.test(pkgText);

  // 3) docs 里提到 MCP 的那句话（作为给用户看的原文证据）
  let evidence = '';
  for (const rel of ['docs/usage.md', 'docs/index.md', 'README.md']) {
    const text = readTextSafe(path.join(packageDir, rel));
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/mcp/i.test(lines[i])) continue;
      evidence = lines.slice(Math.max(0, i - 1), i + 2).join(' ').trim().slice(0, MAX_EVIDENCE_CHARS);
      break;
    }
    if (evidence) {
      evidence = `${rel}: ${evidence}`;
      break;
    }
  }

  const supported = coreHits.length > 0 || pkgHits;
  return {
    supported,
    packageDir,
    version,
    evidence,
    reason: supported
      ? '这个 pi 包里出现了 MCP 相关模块，可能是新版本加入了支持 —— 请以 pi 的官方文档为准'
      : '这个 pi 包里没有任何 MCP 模块或配置约定（pi 官方明确表示不内置 MCP）',
  };
}

/** 只读列出扩展目录里的条目（名字/类型/大小/时间），不读内容、不执行。 */
function listExtensionDir(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, entries: out, error: '' };
    return { exists: true, entries: out, error: String(err.message || err) };
  }
  for (const entry of entries) {
    if (out.length >= MAX_LIST) break;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    let size = null;
    let mtime = null;
    let kind = entry.isDirectory() ? 'dir' : 'file';
    try {
      const stat = fs.statSync(full);
      size = stat.size;
      mtime = stat.mtimeMs;
      kind = stat.isDirectory() ? 'dir' : 'file';
    } catch {
      /* 读不到就只给名字 */
    }
    out.push({ name: entry.name, kind, size, mtime });
  }
  return { exists: true, entries: out, error: '' };
}

/**
 * @param runtime 共享运行态（要 cwd）。只读。
 * @param env     环境变量来源，默认 process.env。
 * @param piBin   pi 可执行文件（用来推包目录），默认 env.PI_BIN。
 */
export function createMcp({ runtime, env = process.env, piBin = null }) {
  const HOME = env.HOME || os.homedir();
  const AGENT_DIR = env.PI_CODING_AGENT_DIR || path.join(HOME, CONFIG_DIR, 'agent');

  function readReport() {
    const cwd = runtime.getCurrentCwd();
    const detected = detectMcpSupport({ piBin: piBin || env.PI_BIN, env });

    // pi 官方给的替代路径就是 extension —— 顺手把本机装了哪些列出来（只读）
    const globalSettings = readJsonSafe(path.join(AGENT_DIR, 'settings.json')) || {};
    const projectSettings = cwd ? readJsonSafe(path.join(cwd, CONFIG_DIR, 'settings.json')) || {} : {};

    const userDir = path.join(AGENT_DIR, EXTENSIONS_SUBDIR);
    const projectDir = cwd ? path.join(cwd, CONFIG_DIR, EXTENSIONS_SUBDIR) : null;
    const userList = listExtensionDir(userDir);
    const projectList = projectDir ? listExtensionDir(projectDir) : { exists: false, entries: [], error: '' };

    const settingsExtensions = [];
    for (const [scope, settings] of [
      ['user', globalSettings],
      ['project', projectSettings],
    ]) {
      const arr = Array.isArray(settings.extensions) ? settings.extensions : [];
      for (const e of arr) {
        if (typeof e === 'string') settingsExtensions.push({ scope, value: e });
      }
    }
    const packages = [];
    for (const [scope, settings] of [
      ['user', globalSettings],
      ['project', projectSettings],
    ]) {
      const arr = Array.isArray(settings.packages) ? settings.packages : [];
      for (const p of arr) {
        packages.push({ scope, value: typeof p === 'string' ? p : JSON.stringify(p) });
      }
    }

    return {
      ok: true,
      // 「有没有原生 MCP」是这份报告唯一的结论，null = 检测不出来（不许猜成 false）
      supported: detected.supported,
      reason: detected.reason,
      evidence: detected.evidence,
      piVersion: detected.version,
      piPackageDir: detected.packageDir,
      // 永远是空的 —— 没有原生 MCP 就没有 Server 配置可读。留着这个字段是为了
      // 前端结构稳定，也为了将来 pi 真加了支持时不用改前端。
      servers: [],
      serversNote: detected.supported
        ? '检测到 pi 包里有 MCP 相关模块，但 Pi GUI 还没有适配它的配置格式 —— 所以这里列不出 Server。'
        : 'pi 没有 MCP 配置文件约定，所以没有 Server 可以列出。',
      // 替代路径
      extensionRoute: {
        note: 'pi 官方建议把 MCP 这类能力做成 extension 或 package。下面是本机已有的扩展，Pi GUI 只列出、不安装也不执行。',
        userDir,
        projectDir,
        user: { ...userList, count: userList.entries.length },
        project: { ...projectList, count: projectList.entries.length },
        fromSettings: settingsExtensions,
        packages,
      },
    };
  }

  function handle(req, res) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed' });
    try {
      return json(res, 200, readReport());
    } catch (err) {
      return json(res, 200, {
        ok: false,
        error: String(err.message || err),
        supported: null,
        servers: [],
        reason: '检测 MCP 支持情况时出错',
      });
    }
  }

  return { handle, readReport, _internals: { locatePiPackage, detectMcpSupport, listExtensionDir } };
}
