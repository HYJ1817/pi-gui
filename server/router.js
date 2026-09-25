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
 * @param rpc           pi 桥接（send / request / restart / getState）
 * @param providers     供应商（handle / handleModels）
 * @param projects      项目（handle / handleFs）
 * @param projectConfig 当前项目的配置（handle）
 * @param skills        Skills（handle）
 * @param mcp           MCP 能力报告（handle）
 * @param sessions      会话列表与切换（handle）
 * @param planner       Planner / Agent 编排（handle）
 * @param gitRoutes     Git 路由（handle）
 * @param uploads       附件上传（handle）
 * @returns {import('node:http').RequestListener}
 */
export function createRouter({
  auth,
  sse,
  rpc,
  providers,
  projects,
  projectConfig,
  skills,
  mcp,
  sessions,
  planner,
  gitRoutes,
  uploads,
}) {
  function handleCommand(req, res) {
    // 必须按 Buffer 累积再一次性解码：逐块 body += chunk 会在 chunk 边界
    // 把多字节字符切开，中文就会变成乱码。
    readRawBody(req, MAX_COMMAND_BYTES)
      .then((buf) => {
        let cmd;
        try {
          cmd = JSON.parse(buf.toString('utf8') || '{}');
        } catch {
          return json(res, 400, { ok: false, error: '命令不是合法 JSON' });
        }
        try {
          rpc.send(cmd);
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 503, { ok: false, error: String(err.message) });
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
    if (url.pathname === '/api/command' && req.method === 'POST') return handleCommand(req, res);
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return json(res, 200, rpc.getState());
    }
    // 必须排在下面那条前缀匹配之前 —— 否则 /api/providers/models 会被
    // 当成「保存一个叫 models 的供应商」，而且前端拿不到任何报错。
    if (url.pathname === '/api/providers/models' && req.method === 'POST') {
      return providers.handleModels(req, res);
    }
    if (url.pathname === '/api/providers' || url.pathname.startsWith('/api/providers/')) {
      return providers.handle(req, res, url);
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
