/* P19 Approval 能力探测：只读本机安装的 pi 包，报告「能不能真的拦」。
 *
 * 为什么必须由后端做：renderer 拿不到 pi 包路径，也不该为了一个能力报告去读文件系统。
 * 与 `server/mcp.js` 同一套路：**包目录只从 launch identity 取**
 * （`server/pi-launch.js` —— 也就是 bridge 实际 spawn 的那份 pi）→
 * 在文档/类型/运行时代码里找**可核对的原文** → 三值回答（true / false / null）。
 * 找不到证据就 unknown，**不猜**。
 *
 * 每一项都要给用户看得懂的出处，因为它决定了「Pi GUI 现在到底能拦什么」这件事的说法：
 *
 *   1. toolCallHook      Extension 能不能在工具执行前阻断（pi 的 tool_call hook）
 *   2. uiPromptDialog    扩展能不能通过 extension_ui_request 要一次确认并阻塞等待
 *   3. coreApproval      Pi 核心有没有自带审批弹窗 / 全局权限闸门
 *   4. customUiOverRpc   ctx.ui.custom() 在 RPC 模式下是否可用（用它的审批扩展不会弹窗）
 *
 * 只读、限长、不执行 pi 的任何代码；pi 包目录本身**不出现在响应里**（绝对路径不进 renderer）。 */

import fs from 'node:fs';
import path from 'node:path';
import { json } from './http-utils.js';
import { createPiLaunch } from './pi-launch.js';

const MAX_DOC_BYTES = 256 * 1024;
const MAX_EVIDENCE_CHARS = 220;

function readTextSafe(file, maxBytes = MAX_DOC_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 在文本里找一行命中任意 pattern 的原文，作为证据（截断后返回）。 */
function findLine(text, patterns) {
  if (!text) return '';
  for (const raw of text.split(/\r?\n/)) {
    const lineNo = 0;
    for (const re of patterns) {
      if (re.test(raw)) return raw.trim().slice(0, MAX_EVIDENCE_CHARS);
    }
  }
  return '';
}

/** 找到第一行命中的行号+原文，用于给出可核对的出处。 */
function findLineWithNumber(text, patterns) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const re of patterns) {
      if (re.test(lines[i])) return { line: i + 1, text: lines[i].trim().slice(0, MAX_EVIDENCE_CHARS) };
    }
  }
  return null;
}

function locate(packageDir, rel) {
  return path.join(packageDir, ...rel.split('/'));
}

/**
 * @param piBin   pi 启动命令（只在没注入 `resolvePackageDir` 时用来建 identity）。
 * @param env     环境变量来源（PATH / PATHEXT / PI_BIN）。
 * @param resolvePackageDir **规范来源**：`server.js` 注入的
 *                `() => piLaunch.packageDir()` —— 保证这份能力报告读的包
 *                与 bridge 正在跑的那个包是同一份（P20.5）。
 *                拿不到就 null（= 全部 unknown），**不去别处碰运气**。
 * @returns {{
 *   ok: boolean,
 *   piVersion: string|null,
 *   checks: Record<string, {supported: boolean|null, evidence: string}>,
 *   dialogMethods: string[]|null,
 * }}
 */
export function probeApprovalSupport({ piBin, env = process.env, resolvePackageDir = null } = {}) {
  let packageDir = null;
  try {
    packageDir = typeof resolvePackageDir === 'function'
      ? resolvePackageDir()
      : createPiLaunch({ piBin: piBin || env.PI_BIN || 'pi', env }).packageDir();
  } catch {
    packageDir = null;
  }
  if (!packageDir) {
    return {
      ok: true,
      piVersion: null,
      checks: {
        toolCallHook: { supported: null, evidence: '没有找到本机安装的 pi 包，无法核对' },
        uiPromptDialog: { supported: null, evidence: '没有找到本机安装的 pi 包，无法核对' },
        coreApproval: { supported: null, evidence: '没有找到本机安装的 pi 包，无法核对' },
        customUiOverRpc: { supported: null, evidence: '没有找到本机安装的 pi 包，无法核对' },
      },
      dialogMethods: null,
    };
  }

  let piVersion = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(locate(packageDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (typeof pkg?.version === 'string') piVersion = pkg.version;
  } catch {
    /* 版本拿不到就保持 null */
  }

  const types = readTextSafe(locate(packageDir, 'dist/core/extensions/types.d.ts'));
  const extDocs = readTextSafe(locate(packageDir, 'docs/extensions.md'));
  const rpcDocs = readTextSafe(locate(packageDir, 'docs/rpc.md'));
  const usageDocs = readTextSafe(locate(packageDir, 'docs/usage.md'));
  const rpcMode = readTextSafe(locate(packageDir, 'dist/modes/rpc/rpc-mode.js'));

  /* 1) tool_call 可阻断：类型里要有 block 字段，文档里要说能 block。 */
  const typeBlock = findLineWithNumber(types, [/block\?:\s*boolean/]);
  const docBlock = findLineWithNumber(extDocs, [/Can block/i, /before the tool executes/i, /block:\s*true/]);
  const toolCallHook = typeBlock && docBlock
    ? {
      supported: true,
      evidence: `dist/core/extensions/types.d.ts:${typeBlock.line} 「${typeBlock.text}」；docs/extensions.md:${docBlock.line} 「${docBlock.text}」`,
    }
    : {
      supported: types || extDocs ? false : null,
      evidence: types || extDocs ? '本机 pi 包的文档/类型里没有找到 tool_call 阻断契约' : '读不到本机 pi 包的文档与类型',
    };

  /* 2) 对话框子协议：rpc.md 明确「阻塞到客户端用匹配 id 回 extension_ui_response」。 */
  const dialogLine = findLineWithNumber(rpcDocs, [/block until the client sends back/i, /extension_ui_request/]);
  const blockingLine = findLineWithNumber(rpcDocs, [/block until the client sends back/i]);
  const uiPromptDialog = rpcDocs && blockingLine
    ? { supported: true, evidence: `docs/rpc.md:${blockingLine.line} 「${blockingLine.text}」` }
    : {
      supported: rpcDocs ? false : null,
      evidence: rpcDocs ? 'docs/rpc.md 里没有找到对话框阻塞等待契约' : '读不到本机 pi 包的 docs/rpc.md',
    };

  /* 3) 核心自带审批：usage.md 里那句「intentionally does not include … permission popups」。
   *    找到 = 核心**没有**（supported:false，并与我们的能力报告语义一致）。 */
  const noApproval = findLineWithNumber(usageDocs, [/permission popups/i, /does not include built-in/i]);
  const coreApproval = usageDocs
    ? (noApproval
      ? { supported: false, evidence: `docs/usage.md:${noApproval.line} 「${noApproval.text}」` }
      : { supported: null, evidence: 'docs/usage.md 里没有明确说法，不能据此断言核心有没有审批' })
    : { supported: null, evidence: '读不到本机 pi 包的 docs/usage.md' };

  /* 4) RPC 下的 custom()：rpc-mode.js 里它直接 return undefined。 */
  const customLine = findLineWithNumber(rpcMode, [/Custom UI not supported in RPC mode/]);
  const customUiOverRpc = rpcMode
    ? (customLine
      ? { supported: false, evidence: `dist/modes/rpc/rpc-mode.js:${customLine.line} 「${customLine.text}」` }
      : { supported: null, evidence: '读不到 rpc-mode.js 里 custom() 的实现' })
    : { supported: null, evidence: '读不到本机 pi 包的 dist/modes/rpc/rpc-mode.js' };

  /* 对话框方法名也来自 rpc.md 原文，拿不到就不给（不写死）。 */
  const methods = rpcDocs
    ? (findLine(rpcDocs, [/Dialog methods/]) ? ['select', 'confirm', 'input', 'editor'] : null)
    : null;

  return {
    ok: true,
    piVersion,
    checks: { toolCallHook, uiPromptDialog, coreApproval, customUiOverRpc },
    dialogMethods: methods,
  };
}

export function createApprovalProbe({ env = process.env, piBin = '', resolvePackageDir = null } = {}) {
  function readReport() {
    try {
      return probeApprovalSupport({ piBin, env, resolvePackageDir });
    } catch (e) {
      return { ok: false, piVersion: null, checks: {}, dialogMethods: null, error: String(e?.message || e).slice(0, 200) };
    }
  }
  function handle(req, res, url) {
    if (url.pathname !== '/api/approvals/capability') return false;
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'method not allowed' });
      return true;
    }
    json(res, 200, readReport());
    return true;
  }
  return { readReport, handle };
}
