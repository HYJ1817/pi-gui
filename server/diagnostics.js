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
        capabilities: r.capabilities,
        missing: r.missing,
        unverified: r.unverified,
        protocol: r.protocol,
        issues: r.issues,
      };
    } catch (err) {
      return { status: 'unknown', detected: false, error: String((err && err.message) || err) };
    }
  }

  function readSnapshot() {
    const cwd = runtime?.getCurrentCwd?.() || null;
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
        version: piAgent?.version || mcpReport.piVersion || null,
      },
      agents,
      mcp: {
        supported: typeof mcpReport.supported === 'boolean' ? mcpReport.supported : null,
        piVersion: mcpReport.piVersion || null,
        error: mcpReport.error || null,
      },
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
