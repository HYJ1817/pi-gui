import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json } from './http-utils.js';

const REDACTED = '[REDACTED]';
const SECRET_KEY_RE = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|cookie|session[-_]?token|pi_gui_token)/i;
const ENV_SECRET_RE = /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD))=([^\s]+)/gi;
const BEARER_RE = /\bBearer\s+[^\s,;]+/gi;
const SK_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

function replaceKnownPath(text, value, label) {
  if (!value || typeof text !== 'string') return text;
  const raw = String(value);
  if (!raw) return text;
  return text.split(raw).join(label);
}

function redactString(value, { cwd = null, dataDir = null, homeDir = null } = {}) {
  let out = String(value);
  out = replaceKnownPath(out, cwd, '<project>');
  out = replaceKnownPath(out, dataDir, '<data-dir>');
  out = replaceKnownPath(out, homeDir, '<home>');
  out = out.replace(BEARER_RE, 'Bearer ' + REDACTED);
  out = out.replace(SK_RE, REDACTED);
  out = out.replace(ENV_SECRET_RE, (_m, name) => `${name}=${REDACTED}`);
  return out;
}

export function redactDiagnosticValue(value, ctx = {}) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value, ctx);
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, ctx));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactDiagnosticValue(item, ctx);
  }
  return out;
}

function canAccess(fsApi, target, mode) {
  if (!target) return false;
  try {
    fsApi.accessSync(target, mode);
    return true;
  } catch {
    return false;
  }
}

function safeBasename(p) {
  if (!p) return null;
  try {
    return path.basename(p) || null;
  } catch {
    return null;
  }
}

/**
 * 只收集“定位问题需要、同时适合发给别人”的信息。
 *
 * 设计边界：
 * - 不读取 models.json / settings.json / 会话正文；
 * - 不返回绝对项目路径、data dir、HOME；
 * - 不返回 PID；
 * - 最后再走一次递归脱敏，防止 adapter 的 reason/detail 意外带 secret。
 */
export function createDiagnostics({
  runtime,
  rpc,
  agentRegistry,
  mcp,
  compat = null,
  /* P20.5 Blocker A：launch identity 的脱敏摘要与规范版本状态。
   * 两者都是**函数**（惰性求值）—— 诊断只在被打开时才去算。
   * 都不注入时（老调用方 / 单测）给 null，既有断言不受影响。 */
  launch = null,
  piVersion = null,
  /* P23：能力 probe 表 / 兼容矩阵摘要 / 原生 MCP 摘要 / Extension 发现报告。
   * 同样是**惰性函数**，同样全部可选 —— 不注入时这些块是 null。 */
  probes = null,
  compatMatrix = null,
  mcpNative = null,
  extensions = null,
  dataDir,
  version,
  env = process.env,
  fsApi = fs,
  osApi = os,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.version,
  now = () => new Date(),
} = {}) {
  /* Pi 兼容性报告（P4）。
   *
   * 报告本身**只含结构信息**（版本、能力三值、缺失清单、异常的字段名与类型）——
   * 它在 pi-compat 里就从来没存过 payload。这里再走一遍递归脱敏是双保险。
   * 没注入 compat（老调用方 / 单测）时给 null，不影响既有断言。 */
  function compatBlock() {
    if (!compat || typeof compat.report !== 'function') return null;
    try {
      const r = compat.report();
      return {
        status: r.status,
        detected: r.detected,
        piVersion: r.version,
        versionKnown: r.versionKnown,
        /* P20.5：版本值的**出处**（source / status / updatedAt）。
         * 它只有枚举与时间戳，没有 payload —— 让 Diagnostics 能区分
         * 「文档里的历史基线」与「这台机器上跑的那个」。 */
        versionSource: r.versionSource || null,
        /* P23：版本是否在兼容矩阵里核对过（与 versionSource 分开：
         * 一个是「值从哪来」，一个是「这个值我们认不认识」）。 */
        versionVerification: r.versionVerification || null,
        capabilities: r.capabilities,
        missing: r.missing,
        unverified: r.unverified,
        protocol: r.protocol,
        /* P23：schema 漂移（来源 + 字段名，没有值）。 */
        schema: r.schema || { unknownFields: [], unknownEnums: [] },
        issues: r.issues,
      };
    } catch (err) {
      return { status: 'unknown', detected: false, error: String((err && err.message) || err) };
    }
  }

  function readSnapshot() {    const cwd = runtime?.getCurrentCwd?.() || null;
    const bridge = rpc?.getState?.() || {};
    const agentsRaw = agentRegistry?.list?.() || [];
    const agents = agentsRaw.map((a) => ({
      id: a.id,
      available: Boolean(a.available),
      version: a.version || null,
      reason: a.reason || null,
      capabilities: a.capabilities || null,
    }));

    let mcpReport = {};
    try {
      mcpReport = mcp?.readReport?.() || {};
    } catch (err) {
      mcpReport = { supported: null, error: String(err?.message || err) };
    }

    const dataReadable = canAccess(fsApi, dataDir, fs.constants.R_OK);
    const dataWritable = canAccess(fsApi, dataDir, fs.constants.W_OK);
    const projectReadable = cwd ? canAccess(fsApi, cwd, fs.constants.R_OK) : null;
    const projectWritable = cwd ? canAccess(fsApi, cwd, fs.constants.W_OK) : null;
    const piAgent = agents.find((a) => a.id === 'pi') || null;

    /* 版本优先级：**规范版本状态** → adapter 探测 → mcp 报告兜底。
     * 第一条是 P20.5 的真值（它证明过包目录与 bridge 入口绑定），
     * 后两条只是历史来源，保留是为了「规范状态还没算出来」时不至于空白。 */
    let canon = null;
    if (typeof piVersion === 'function') {
      try {
        const s = piVersion();
        canon = s && typeof s === 'object' ? s : null;
      } catch {
        canon = null;
      }
    }
    /* launch identity 的脱敏摘要：`{source, binName, entryKnown, packageDirKnown}`。
     * 只有枚举、basename 与布尔 —— 绝对路径进不了这里（模块本身就不给），
     * 再叠一层 redactDiagnosticValue 双保险。 */
    let launchInfo = null;
    if (typeof launch === 'function') {
      try {
        const s = launch();
        if (s && typeof s === 'object') {
          launchInfo = {
            source: s.source || null,
            binName: s.binName || null,
            entryKnown: Boolean(s.entryKnown),
            packageDirKnown: Boolean(s.packageDirKnown),
          };
        }
      } catch {
        launchInfo = null;
      }
    }

    /* ---------- P23：能力 probe + 兼容矩阵 + 原生 MCP + Extension 版本 ----------
     *
     * 全部**惰性**（函数注入），全部**可选**（不注入就是 null）。
     * probe 表里有证据行（来自 pi 包源码的原文，限长）；矩阵只有版本号与日期；
     * 原生 MCP 只给状态与计数（**不给 server 名字** —— 诊断不需要它）；
     * Extension 只给「有可靠 metadata 的那些」的名字与版本，不带路径。 */
    let probeReport = null;
    if (typeof probes === 'function') {
      try {
        const p = probes();
        if (p && Array.isArray(p.probes)) {
          probeReport = {
            at: p.at || null,
            packageKnown: Boolean(p.packageKnown),
            summary: p.summary || null,
            items: p.probes.map((item) => ({
              id: item.id,
              kind: item.kind,
              label: item.label,
              state: item.state === true ? true : item.state === false ? false : null,
              evidence: item.evidence || '',
            })),
          };
        }
      } catch (err) {
        probeReport = { error: String(err?.message || err).slice(0, 200) };
      }
    } else if (typeof probes === 'object' && probes && Array.isArray(probes.probes)) {
      probeReport = probes;
    }

    let matrixInfo = null;
    if (typeof compatMatrix === 'function') {
      try {
        const m = compatMatrix();
        if (m && typeof m === 'object') matrixInfo = m;
      } catch {
        matrixInfo = null;
      }
    }

    let nativeInfo = null;
    if (typeof mcpNative === 'function') {
      try {
        const s = mcpNative();
        if (s && typeof s === 'object') {
          const nat = s.native && typeof s.native === 'object' ? s.native : null;
          nativeInfo = {
            fresh: Boolean(s.fresh),
            state: nat && typeof nat.state === 'string' ? nat.state : null,
            reason: nat && typeof nat.reason === 'string' ? nat.reason : '',
            replaced: nat ? Boolean(nat.replaced) : null,
            disabled: nat && typeof nat.disabled === 'boolean' ? nat.disabled : null,
            builtinPresent: nat && typeof nat.builtinPresent === 'boolean' ? nat.builtinPresent : null,
            serverCount: Array.isArray(s.servers) ? s.servers.length : null,
            trust: s.trust === null || s.trust === undefined ? null : Boolean(s.trust.trusted),
          };
        }
      } catch {
        nativeInfo = null;
      }
    }

    /* 关键 Extension 的版本：**只在有可靠 metadata（package.json 读到 version）时**
     * 才列，并对着兼容矩阵标出「核对过 / 没核对过」。名字与版本不是秘密，路径不进。
     * 上限 20 条 —— 诊断不是扩展清单。 */
    let extensionInfo = null;
    if (typeof extensions === 'function') {
      try {
        const r = extensions();
        const list = r && r.ok !== false && Array.isArray(r.extensions) ? r.extensions : null;
        if (list) {
          extensionInfo = {
            discovered: list.length,
            items: list
              .filter((e) => e && typeof e.version === 'string' && e.version)
              .slice(0, 20)
              .map((e) => ({
                name: typeof e.name === 'string' ? e.name : null,
                version: e.version,
                scope: e.scope === 'project' ? 'project' : e.scope === 'global' ? 'global' : null,
                installed: e.state ? e.state.installed === true : null,
                loaded: e.state ? e.state.loaded : null,
              })),
          };
        }
      } catch {
        extensionInfo = null;
      }
    }

    const raw = {
      schemaVersion: 1,
      generatedAt: now().toISOString(),
      app: {
        id: 'pi-gui',
        version: version || '0.0.0',
      },
      system: {
        platform,
        arch,
        node: nodeVersion,
        os: typeof osApi.type === 'function' ? osApi.type() : null,
        release: typeof osApi.release === 'function' ? osApi.release() : null,
      },
      project: {
        selected: Boolean(cwd),
        name: safeBasename(cwd),
        readable: projectReadable,
        writable: projectWritable,
      },
      data: {
        readable: dataReadable,
        writable: dataWritable,
      },
      bridge: {
        piRunning: Boolean(bridge.piRunning),
        bridgeRun: Number.isFinite(bridge.bridgeRun) ? bridge.bridgeRun : 0,
        hasProject: Boolean(bridge.hasProject ?? cwd),
        args: Array.isArray(bridge.args) ? bridge.args : [],
      },
      pi: {
        configuredBin: safeBasename(env.PI_BIN || 'pi'),
        available: piAgent ? piAgent.available : null,
        version: canon?.value || piAgent?.version || mcpReport.piVersion || null,
        /* 版本值的出处（`package.json` / `pi --version` / `unknown`）。
         * 让故障报告能区分「读到的版本」和「哪一步读到的」。 */
        versionSource: canon ? canon.source : null,
        /* P23：这个版本在兼容矩阵里核过没有。`verified` / `unverified` /
         * `unknown`（版本本身没读到）/ `unchecked`（没注入矩阵）。 */
        verification: canon
          ? {
            status: canon.verification || 'unchecked',
            verifiedAgainst: canon.verifiedAgainst || null,
            relative: canon.relative || 'unknown',
          }
          : null,
        /* **bridge 实际会启动的那个入口**（脱敏）：source 与 basename，
         * 加两个布尔（入口解析到没有 / 包目录证明到没有）。
         * 有了它，诊断里就能一眼看出「版本和启动的不是同一份」这种情况。 */
        launch: launchInfo,
      },
      agents,
      mcp: {
        supported: typeof mcpReport.supported === 'boolean' ? mcpReport.supported : null,
        piVersion: mcpReport.piVersion || null,
        error: mcpReport.error || null,
        /* P23：Native MCP 的**状态**（没有 server 名字、没有路径）。
         * 只有打开过 MCP 页 / 切过项目之后才有摘要 —— 「没算过」≠「没有」。 */
        native: nativeInfo,
      },
      /* P23：能力 probe 表（每条带出处）。`unverified` 列出「还没法下结论」的核心 probe。 */
      probes: probeReport,
      /* P23：兼容矩阵摘要（我们**声称**验证过什么）。只有版本号与日期。 */
      matrix: matrixInfo,
      /* P23：关键 Extension 的版本（有可靠 metadata 时）。 */
      extensions: extensionInfo,
      checks: [
        { id: 'data-readable', ok: dataReadable },
        { id: 'data-writable', ok: dataWritable },
        { id: 'project-readable', ok: cwd ? projectReadable : null },
        { id: 'project-writable', ok: cwd ? projectWritable : null },
        { id: 'pi-running', ok: cwd ? Boolean(bridge.piRunning) : null },
      ],
      compatibility: compatBlock(),
      privacy: {
        absolutePathsIncluded: false,
        conversationContentIncluded: false,
        configFileContentIncluded: false,
        environmentIncluded: false,
        /* 兼容层的异常只记「字段名 + 期望形状 + 实际类型」，不记 payload ——
         * 这条是那个模块的硬规矩（见 server/pi-compat.js 头部规矩 3）。 */
        protocolPayloadsIncluded: false,
        /* P23：schema 漂移记录更严 —— 只有来源、我们自己代码里的字段名、
         * 以及 `typeof`。**连对象键名都不记**，更不记值。 */
        schemaDriftValuesIncluded: false,
        redactionApplied: true,
      },
    };

    return redactDiagnosticValue(raw, {
      cwd,
      dataDir,
      homeDir: typeof osApi.homedir === 'function' ? osApi.homedir() : null,
    });
  }

  function handle(req, res) {
    if (req.method !== 'GET') {
      return json(res, 405, { ok: false, error: 'Method not allowed' });
    }
    try {
      return json(res, 200, { ok: true, diagnostics: readSnapshot() });
    } catch (err) {
      return json(res, 500, { ok: false, error: '诊断信息生成失败', detail: String(err?.message || err) });
    }
  }

  return { readSnapshot, handle };
}
