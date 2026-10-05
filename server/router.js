/* HTTP 路由表 + 静态资源。
 *
 * 全部用原生 node:http，不引入任何框架 —— 路由就是一张有序的 if 表。
 * **顺序即语义**，几处「必须排在前面」的注释都是踩过的坑，改动前先读一遍。
 *
 * 这里只做「请求 → 处理器」的分发，不含业务逻辑：各处理器由 server.js 装配好
 * 之后注入进来（见 createRouter 的参数）。于是依赖方向永远是
 *
 *     server.js → router.js → 各处理器模块
 *
 * router 不 import server.js，也不 import 任何一个业务模块。
 */
import path from 'node:path';
import { readPublic } from '../lib/assets.js';
import { json, readRawBody } from './http-utils.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  try {
    rel = decodeURIComponent(rel);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
    return;
  }

  // 挡目录穿越。打包成 exe 后资源是内存里的 key，更要自己把关。
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../') || path.isAbsolute(norm)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }

  try {
    const data = readPublic(norm);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(norm).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

// 带图的 prompt 要装 base64，手机截图动辄 3-5MB，编码后还要涨三分之一，
// 所以这里给足余量；上限可用环境变量覆盖。
const MAX_COMMAND_BYTES = Number(process.env.PI_GUI_MAX_COMMAND_BYTES || 96 * 1024 * 1024);

/**
 * @param auth          本地访问控制（denyRequest / handleHealth）
 * @param sse           事件总线（subscribe）
 * @param rpc           pi 桥接（send / request / abortAndWait / restart / getState）
 * @param providers     供应商（handle / handleModels）
 * @param projects      项目（handle / handleFs）
 * @param projectConfig 当前项目的配置（handle）
 * @param skills        Skills（handle）
 * @param mcp           MCP 能力报告（handle）
 * @param mcpNative     P20.6 原生 MCP 状态与受控动作（handleServers / handleStatus）
 * @param extensions    Extension 只读注册表（handle）
 * @param sessions      会话列表与切换（handle）
 * @param sessionSearch 会话全文搜索（handle）
 * @param planner       Planner / Agent 编排（handle）
 * @param gitRoutes     Git 路由（handle）
 * @param uploads       附件上传（handle）
 * @param diagnostics   诊断信息（handle）
 * @param updateCheck   版本检查（handle）
 * @param piUpdate      Pi 运行时更新（handle）
 * @param capabilityInstall Known Capability 一键安装（handle；POST）
 * @returns {import('node:http').RequestListener}
 */
export function createRouter({
  auth,
  sse,
  rpc,
  providers,
  providerAuth = null,
  sessionExport = null,
  projects,
  projectConfig,
  skills,
  mcp,
  mcpNative = null,
  approvalProbe,
  extensions,
  sessions,
  sessionSearch,
  planner,
  gitRoutes,
  uploads,
  diagnostics,
  updateCheck,
  piUpdate = null,
  capabilityInstall = null,
  quota = null,
  compat = null,
  processes = null,
}) {
  function handleCommand(req, res) {
    // 必须按 Buffer 累积再一次性解码：逐块 body += chunk 会在 chunk 边界
    // 把多字节字符切开，中文就会变成乱码。
    readRawBody(req, MAX_COMMAND_BYTES)
      .then(async (buf) => {
        let cmd;
        try {
          cmd = JSON.parse(buf.toString('utf8') || '{}');
        } catch {
          return json(res, 400, { ok: false, error: '命令不是合法 JSON' });
        }
        try {
          if (cmd.type === 'export_html') return json(res, 400, { ok: false, error: '请使用安全会话导出入口' });
          if (typeof cmd.id === 'number') return json(res, 400, { ok: false, error: '客户端请求 ID 必须为字符串' });
          /* Stop 是**权威停止**，不是 fire-and-forget：它等的是 Pi 那条 abort
           * 应答（官方语义：应答发出时会话已经空闲）。所以它有自己的出口，
           * 不能混进下面「桥已接受就算成功」的通用路径。
           * `ok:true` 才代表停止已确认；`stop_unconfirmed` 代表**没确认**
           * ——那时后端的停止屏障仍然挂着，新的 prompt / steer 照样发不出去。 */
          if (cmd.type === 'abort') {
            const stop = await rpc.abortAndWait(cmd);
            return json(res, stop.ok ? 200 : 503, stop.ok
              ? { ok: true, stop: { evidence: stop.evidence, queue: stop.queue } }
              : { ok: false, code: stop.code, error: stop.error });
          }
          await rpc.send(cmd);
          return json(res, 200, { ok: true });
        } catch (err) {
          /* `code` 是稳定标识（例如 stop_in_progress）—— 前端据它区分
           * 「正在停止」与真正的失败，不去匹配文案。 */
          return json(res, 503, { ok: false, error: String(err.message), ...(err.code ? { code: err.code } : {}) });
        }
      })
      .catch((err) => json(res, 413, { ok: false, error: String(err.message) }));
  }

  return function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // 身份探测：必须排在鉴权之前（见 auth.js 的 handleHealth 说明）
    if (url.pathname === '/api/health' && req.method === 'GET') return auth.handleHealth(res);

    /* 其余 /api/* 一律先过访问控制。
     * 注意是「全部」而不是挑几个敏感的 —— 逐个列敏感项迟早会漏一个，
     * 而漏掉的那个正好是新加的功能。静态资源不受影响。 */
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const denied = auth.denyRequest(req);
      if (denied) return json(res, denied.code, { ok: false, error: denied.error });
    }

    if (url.pathname === '/api/events' && req.method === 'GET') return sse.subscribe(req, res);
    if (url.pathname === '/api/processes') return processes ? processes.handle(req,res,url) : json(res,503,{ok:false,code:'process_unavailable'});
    if (url.pathname === '/api/command' && req.method === 'POST') return handleCommand(req, res);
    if (url.pathname === '/api/session-export') {
      if (!sessionExport) return json(res, 503, { ok: false, error: '导出模块未启用' });
      return sessionExport.handle(req, res);
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const st = rpc.getState();
      /* Pi 兼容摘要（P4）：前端据此**局部降级**（隐藏改名、禁用切换…）。
       * 只加字段不删字段，老前端不受影响；没注入 compat 时（单测）就不加。 */
      if (compat && typeof compat.summary === 'function') {
        try {
          st.compat = compat.summary();
        } catch {
          /* 兼容摘要拿不到不该让 /api/status 挂掉 */
        }
      }
      return json(res, 200, st);
    }
    if (url.pathname === '/api/diagnostics') {
      return diagnostics.handle(req, res, url);
    }
    /* 版本检查（P5）。独立顶层路径，**必须排在下面 `req.method !== 'GET' → 405`
     * 之前** —— 它自己要能给 POST 回 405（而不是被兜底吞掉，那种静默失败
     * 前端只会看到一个没有 JSON 的 405）。 */
    if (url.pathname === '/api/update') {
      if (!updateCheck) return json(res, 503, { ok: false, error: '更新检查未启用' });
      return updateCheck.handle(req, res, url);
    }
    /* Pi 运行时更新（Built-in Pi Updater）。**与上面那条完全分离**：
     * 那个是「Pi GUI 自己要不要升级」，这个是「它驱动的 pi 要不要升级」。
     * 同样必须排在下面 405 兜底之前 —— 真正的更新是 POST。 */
    if (url.pathname === '/api/pi-update') {
      if (!piUpdate) return json(res, 503, { ok: false, code: 'not-wired', error: 'Pi 更新模块未装配' });
      return piUpdate.handle(req, res, url, json);
    }
    /* Known Capability 一键安装（POST）。**独立顶层路径**，与 /api/extensions
     * （通用只读发现）刻意分开：这个端点只认 capabilityId，自己从固定 allowlist
     * 取 source，所以它不可能是「任意包安装 / 命令执行」入口。
     * 同样必须排在下面 405 兜底之前 —— 它本身是 POST。 */
    if (url.pathname === '/api/capabilities/install') {
      if (!capabilityInstall) return json(res, 503, { ok: false, code: 'not-wired', error: 'Capability 安装模块未装配' });
      return capabilityInstall.handle(req, res, url, json);
    }
    // 必须排在下面那条前缀匹配之前 —— 否则 /api/providers/models 会被
    // 当成「保存一个叫 models 的供应商」，而且前端拿不到任何报错。
    if (url.pathname === '/api/providers/models' && req.method === 'POST') {
      return providers.handleModels(req, res);
    }
    if (url.pathname === '/api/provider-auth' || url.pathname.startsWith('/api/provider-auth/')) {
      if (!providerAuth) return json(res, 503, { ok: false, error: '认证模块未启用' });
      return providerAuth.handle(req, res, url);
    }
    if (url.pathname === '/api/providers' || url.pathname.startsWith('/api/providers/')) {
      return providers.handle(req, res, url);
    }
    /* 远端额度（P21）。独立顶层路径，必须排在 405 兜底之前。 */
    if (url.pathname === '/api/quota' || url.pathname.startsWith('/api/quota/')) {
      if (quota) return quota.handle(req, res, url);
      return json(res, 503, { ok: false, error: 'Quota 模块未装配' });
    }
    /* 项目配置单独一条顶层路径，**刻意不挂在 /api/projects/ 下面**。
     *
     * 挂成 /api/projects/config 的话，就必须排在下面那条前缀匹配之前 ——
     * 那是本文件里第三处「顺序即语义」的坑（前两处见 providers/models 与 git）。
     * 而这种坑漏掉的代价是静默的：GET 会返回项目列表，PUT 会落进 405，
     * 前端拿到的都不是报错，是一个看起来正常但完全不对的结果。
     * 换成独立路径就没有这个约束，也不用在注释里维护「谁必须排在谁前面」。 */
    if (url.pathname === '/api/project-config') {
      return projectConfig.handle(req, res, url);
    }
    /* 扩展能力（Skills / MCP）。和 project-config 同理用独立顶层路径，
     * 不挂在别的前缀下面，省掉一条「谁必须排在谁前面」的隐式约束。
     *
     * 位置要求：**必须排在下面 `req.method !== 'GET' → 405` 之前** ——
     * 启停 skill 用的是 PUT。 */
    if (url.pathname === '/api/skills' || url.pathname.startsWith('/api/skills/')) {
      return skills.handle(req, res, url);
    }
    if (url.pathname === '/api/mcp') {
      return mcp.handle(req, res, url);
    }
    /* P20.6 原生 MCP：Server 明细（GET）与受控动作（POST add/remove/login/logout）。
     * 独立顶层路径，不挂在 /api/mcp 下面（与 skills 同一条理由：省掉顺序约束）。
     * 状态刷新（POST，会启动用户的 stdio servers）只在用户手势时调用。 */
    if (url.pathname === '/api/mcp/servers') {
      if (mcpNative) return mcpNative.handleServers(req, res);
      return json(res, 503, { ok: false, code: 'not-wired', error: 'MCP 原生模块未装配' });
    }
    if (url.pathname === '/api/mcp/status') {
      if (mcpNative) return mcpNative.handleStatus(req, res);
      return json(res, 503, { ok: false, code: 'not-wired', error: 'MCP 原生模块未装配' });
    }
    /* P19：approval 能力报告（只读本机 pi 包）。GET，必须排在 405 兜底之前。 */
    if (url.pathname === '/api/approvals/capability') {
      if (approvalProbe) return approvalProbe.handle(req, res, url);
      return json(res, 200, { ok: false, piVersion: null, checks: {}, dialogMethods: null });
    }
    if (url.pathname === '/api/extensions') {
      return extensions.handle(req, res, url);
    }
    /* 会话全文搜索（P3）。
     * **必须排在下面 `/api/sessions/` 前缀匹配之前** —— 否则会被会话模块整个吃掉，
     * 症状是静默的（搜索请求拿到的是会话列表 / 405）。这与 providers/models
     * 和 project-config 那两处是同一类坑：顺序即语义。 */
    if (url.pathname === '/api/sessions/search') {
      return sessionSearch.handle(req, res, url);
    }
    /* 会话列表与切换。切换是 POST，**必须排在 405 兜底之前**。 */
    if (url.pathname === '/api/sessions' || url.pathname.startsWith('/api/sessions/')) {
      return sessions.handle(req, res, url);
    }
    /* Planner / Agent 编排（P5）。和上面同理用独立顶层路径。
     * 位置要求：**必须排在下面 `req.method !== 'GET' → 405` 之前** ——
     * 计划的所有操作都是 POST / PUT / DELETE。 */
    if (url.pathname === '/api/agents' || url.pathname === '/api/plans' || url.pathname.startsWith('/api/plans/')) {
      return planner.handle(req, res, url);
    }
    if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
      return projects.handle(req, res, url);
    }
    if (url.pathname === '/api/fs' && req.method === 'GET') {
      return projects.handleFs(res, url);
    }
    // 必须排在下面「req.method !== 'GET' → 405」之前
    if (url.pathname === '/api/git' || url.pathname.startsWith('/api/git/')) {
      return gitRoutes.handle(req, res, url);
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      return uploads.handle(req, res, url);
    }
    if (url.pathname === '/api/restart' && req.method === 'POST') {
      rpc.restart();
      return json(res, 200, { ok: true });
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    serveStatic(res, url.pathname);
  };
}
