/* MCP —— 如实的能力报告，不是一套 MCP 管理器。
 *
 * ---------- 这份报告在 P20.5 里被改写的原因 ----------
 *
 * 旧版这里写着「pi 0.87.0 **没有原生 MCP 支持，而且是有意为之**」，并引用
 * `docs/usage.md:310` 的 "It intentionally does not include built-in MCP…"。
 * 那句话在 **0.87.0 里确实存在**，但：
 *
 *   1. 它描述的是 **0.87.0**，不是「pi 永远不内置 MCP」；
 *   2. 在 **0.99.1** 里那句话已经被删掉了，`docs/usage.md` 全文再无 mcp 命中；
 *   3. 0.99.1 的 `dist/extensions/index.js` 明确列出
 *      `{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true }`。
 *
 * 所以旧文案是**把一个历史版本的特性当成了 pi 的固有属性** —— 这正是 P20.5
 * 要清理的那类「失效的绝对文案」。现在的做法是：**读当前装着的那个包**，
 * 让 built-in 证据自己说话（见 `server/pi-builtins.js`）。
 *
 * ---------- 这个模块现在做什么 ----------
 *
 * 只回答三件事，全部带可核对的出处：
 *   1. **这个 pi 带不带 MCP 能力**（`builtin:mcp` 在不在 / ExtensionAPI 有没有
 *      `registerMcpServer`）；三值：true / false / null（读不到包就是 null）。
 *   2. **本机有没有 MCP 配置文件**（`~/.pi/agent/mcp.json` 与 `<cwd>/.pi/mcp.json`
 *      的**存在与否**）—— 只 stat，不读内容：里面可能有 `headers.Authorization`
 *      和 `env` 密钥。
 *   3. **配置它要走哪条路**（`pi mcp add` / `pi mcp remove`，从 pi 自己的
 *      `docs/mcp.md` 里取原文当证据）。
 *
 * ---------- 仍然不做的事（做了就是撒谎）----------
 *
 *   - **不列 Server**（`servers` 恒为空数组）。读取与增删改留给 P20.6；
 *     现在把 Server 名字列出来会让人以为这里能管它们。
 *   - 不在 `.pi-gui/` 里自己存一份 MCP 配置（pi 不会读它，等于一个假开关）；
 *   - 不显示「已连接 / 已配置」这种没有数据支撑的状态 —— 本模块看不到 pi 的
 *     运行时 MCP 状态，`builtin:mcp` 在不在包里**不等于**当前会话启用了它
 *     （`replaceable: true`：第三方 extension 可以接管）。
 *   - 不执行 `pi mcp …`、不装包、不改 settings。
 *
 * 附带的「本机装了哪些 extension」列表保持原样：那是 pi 官方给的替代路径，
 * 与 MCP 无关，只读列出。
 *
 * ---------- 检测方式 ----------
 *
 * 不硬编码任何版本的结论，而是**去读本机真正装着的那个 pi 包**：
 *   1. 定位 pi 包目录（`locatePiPackage`，与 P19 的能力探测共用一处）；
 *   2. 解析 `dist/extensions/index.js` 的 `builtInExtensions`（只读文本、不执行）；
 *   3. 看 `dist/core/extensions/types.d.ts` 有没有 `registerMcpServer` / `getMcpServers`；
 *   4. 从 `docs/mcp.md` 里截出 `pi mcp add` 那一行当配置路径的证据。
 * 读不到包就如实回 unknown —— 不猜。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json } from './http-utils.js';
import { createPiBuiltins } from './pi-builtins.js';

/** pi 包的 npm 名（从 dist/config.js 的 PACKAGE_NAME 默认值抄来）。 */
const PI_PACKAGE = path.join('@earendil-works', 'pi-coding-agent');
const CONFIG_DIR = '.pi';
const EXTENSIONS_SUBDIR = 'extensions';
const MAX_LIST = 200;

function readJsonSafe(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 从 PI_BIN 与几个 npm 全局位置里找出 pi 包目录。找不到回 null。
 *  导出是给 P19 的 approval 能力探测复用同一处定位逻辑（别写第二份）。 */
export function locatePiPackage({ piBin, env }) {
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

/** 检测这个 pi 包有没有原生 MCP。
 *
 * 判据全部来自**读到的文本**，不是版本号：
 *   - `dist/extensions/index.js` 的 `builtInExtensions` 里有名为 `mcp` 的条目；
 *   - `dist/core/extensions/types.d.ts` 里有 `registerMcpServer`。
 * 两者任一为真即 `supported: true`；两者都**读到了**且都为假 → `false`
 * （0.87.0 就是这一档：只有 `llama.cpp`，且没有 `registerMcpServer`）。
 * 包读不到 → `null`，不猜。
 *
 * @returns {{supported:boolean|null, packageDir:string|null, packageFound:boolean,
 *            version:string|null, evidence:string, reason:string, builtin:object|null}}
 */
function detectMcpSupport({ piBin, env, cwd = null, builtins = null }) {
  const packageDir = locatePiPackage({ piBin, env });
  /* 探测先建出来：即使包定位不到，「本机有没有 mcp.json」照样能回答。
   * （built-ins / ExtensionAPI / RPC 那几条会保持 unknown。） */
  const probe = builtins
    || createPiBuiltins({ resolvePackageDir: () => packageDir, env }).read({ cwd });

  if (!packageDir) {
    return {
      supported: null,
      packageDir: null,
      packageFound: false,
      version: null,
      evidence: '',
      builtin: probe,
      reason: '没有找到本机安装的 pi 包，无法检测它是否支持 MCP',
    };
  }
  const pkg = readJsonSafe(path.join(packageDir, 'package.json')) || {};
  const version = typeof pkg.version === 'string' ? pkg.version : null;

  const entries = Array.isArray(probe.builtins) ? probe.builtins : null;
  const builtinMcp = entries ? entries.find((e) => e.id === 'mcp') || null : null;
  const apiMcp = probe.extensionApi ? probe.extensionApi.registerMcpServer : null;

  /* 三值：读到包了才可能给 false；`entries === null` 说明这份包的
   * builtInExtensions 形状不认识 —— 那一半证据缺失，只能靠 API 那一半。 */
  let supported = null;
  if (builtinMcp || apiMcp === true) supported = true;
  else if (entries !== null && apiMcp === false) supported = false;

  const evidence = builtinMcp
    ? `dist/extensions/index.js: ${builtinMcp.evidence}`
    : (probe.extensionApi && probe.extensionApi.evidence ? `dist/core/extensions/types.d.ts: ${probe.extensionApi.evidence}` : '');

  let reason;
  if (supported === true) {
    reason = builtinMcp
      ? '这个 pi 包自带 built-in 扩展 `mcp`（配置走 pi 自己的 mcp.json，命令行是 pi mcp add / remove）'
      : '这个 pi 包的 ExtensionAPI 提供 registerMcpServer（MCP 由扩展注册，不是内置扩展）';
  } else if (supported === false) {
    reason = '这个 pi 包里既没有 built-in 扩展 `mcp`，ExtensionAPI 也没有 registerMcpServer —— 它不带原生 MCP';
  } else {
    reason = '读到了 pi 包，但认不出它的 built-in 扩展清单形状，无法判定是否支持 MCP';
  }

  return { supported, packageDir, packageFound: true, version, evidence, reason, builtin: probe };
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
 * @param runtime   共享运行态（要 cwd）。只读。
 * @param env       环境变量来源，默认 process.env。
 * @param piBin     pi 可执行文件（用来推包目录），默认 env.PI_BIN。
 * @param piVersion 规范版本状态（server/pi-version.js 的 read()）。缺省则只回 detected.version。
 * @param piBuiltins 共用的 built-in 探测：`(cwd) => 探测结果`。缺省则自己建一个。
 */
export function createMcp({ runtime, env = process.env, piBin = null, piVersion = null, piBuiltins = null }) {
  const HOME = env.HOME || os.homedir();
  const AGENT_DIR = env.PI_CODING_AGENT_DIR || path.join(HOME, CONFIG_DIR, 'agent');

  /** 版本状态读取失败不该把整份 MCP 报告带塌 —— 失败就是「版本未知」。 */
  function safeRead(read) {
    try {
      const state = read();
      return state && typeof state === 'object' ? state : null;
    } catch {
      return null;
    }
  }

  function readReport() {
    const cwd = runtime.getCurrentCwd();
    const detected = detectMcpSupport({
      piBin: piBin || env.PI_BIN,
      env,
      cwd,
      builtins: typeof piBuiltins === 'function' ? safeRead(() => piBuiltins(cwd)) : null,
    });
    const probe = detected.builtin;

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

    /* 规范版本状态：value / source / status / updatedAt。
     * `piVersion` 这个字符串字段保留 —— 它的语义（「读到的 pi 版本」）没变，
     * 老调用方不用改；新代码读 `version` 能拿到出处与状态。 */
    const canonical = typeof piVersion === 'function' ? safeRead(piVersion) : null;

    return {
      ok: true,
      // 「有没有原生 MCP」是这份报告唯一的结论，null = 检测不出来（不许猜成 false）
      supported: detected.supported,
      reason: detected.reason,
      evidence: detected.evidence,
      piVersion: canonical && canonical.value ? canonical.value : detected.version,
      version: canonical || {
        value: detected.version,
        // 没注入规范探测源时的兜底：`detected.version` 也是**刚刚**从 package.json 读的，
        // 所以给它一个真实时间戳（而不是 null）——「状态一定有 updatedAt」这条契约别破。
        source: detected.version ? 'package.json' : 'none',
        status: detected.version ? 'known' : 'unknown',
        updatedAt: new Date().toISOString(),
      },
      // 只报「找到了没有」，不回绝对路径（renderer 不需要它）
      piPackageFound: detected.packageFound,
      // 永远是空的 —— Server 的读取与管理留给后续阶段。留着这个字段是为了
      // 前端结构稳定，也为了 P20.6 真做的时候不用改前端。
      servers: [],
      serversNote: detected.supported === true
        ? '这个 pi 带 MCP 能力，但本页只报告能力：Server 的读取与管理留给后续阶段。配置走 pi 自己的 mcp.json（命令行 pi mcp add / remove）。'
        : detected.supported === false
          ? '这个 pi 不带 MCP，所以没有 Server 可以列出。'
          : '无法判定这个 pi 是否支持 MCP，所以不列 Server。',
      /* P20.5：built-in 能力与 RPC 事实。
       * built-ins 编译在 pi 包内部，**不是**用户装的 npm extension ——
       * 所以它们不出现在下面的 extension 列表里，也不该被当成「扫目录扫不到」。 */
      builtins: {
        known: Boolean(probe && probe.known),
        source: probe ? probe.source : null,
        entries: probe && Array.isArray(probe.builtins)
          ? probe.builtins.map((b) => ({ id: b.id, replaceable: b.replaceable, hidden: b.hidden, evidence: b.evidence }))
          : null,
        evidence: probe ? probe.builtinsEvidence : '',
        note: 'built-in 扩展编译在 pi 包里，不由 Extension Registry 的目录扫描发现；「包里带了它」不等于「当前会话启用了它」。',
      },
      extensionApi: probe ? probe.extensionApi : null,
      rpc: probe
        ? {
            commandCount: Array.isArray(probe.rpc.commands) ? probe.rpc.commands.length : null,
            commands: probe.rpc.commands,
            // 「RPC 有没有一条返回已注册工具清单的命令」—— null = 读不到 pi 包
            toolListCommand: probe.rpc.toolListCommand,
            note: 'Pi RPC 没有已注册工具清单命令：ExtensionAPI 有 getAllTools()，但那是扩展进程内的 API，RPC 不暴露它。所以 GUI 不伪造工具注册表。',
          }
        : null,
      mcpConfig: probe ? probe.mcpConfig : null,
      mcpCli: probe ? probe.mcpCli : null,
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
