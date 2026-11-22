/* 技能管理接口的 HTTP 层：把 /api/skills 下除了「列表 / 详情 / 启停」之外的路由，
 * 接到新建、编辑、删除、导入、扫描、市场这些模块上。
 *
 * 只做三件事：解析并校验请求（ID、令牌、请求体大小）、确定「这次操作针对哪个项目」、
 * 把模块返回的 { ok, status, … } 写成 HTTP 响应。业务判断都在各模块里。
 *
 * 「针对哪个项目」是显式的：?project=<项目 ID>|none。
 *   - 项目 ID 只能是项目列表里已有的那些（或当前工作区），前端传不了任意路径；
 *   - 技能页的项目选择器只是换一个查看 / 管理的对象，**不切换真实工作区**，也不重启 pi；
 *   - 所有会落盘到某个目标目录的写操作都必须带上它。于是「页面上看到的项目」与
 *     「服务端写入的项目」不可能因为中途切了工作区而对不上 —— 对不上就是 409，不是写错地方。
 *
 * 本模块不 import skills.js（它 import 本模块）；需要的能力由 skills.js 以 core 注入。 */
import path from 'node:path';
import { json, readBody } from './http-utils.js';
import { createSkillsExternal } from './skills-external.js';
import { IMPORT_BODY_LIMIT, createSkillsImport } from './skills-import.js';
import { createSkillsManager, fail } from './skills-manage.js';
import { createSkillsMarket } from './skills-market.js';

const ID_PATTERN = /^[0-9a-f]{16}$/;
const TOKEN_PATTERN = /^[0-9a-f]{24}$/;
/** 普通请求体的上限：SKILL.md 最大 256 KB，JSON 转义后留足余量。 */
const JSON_BODY_LIMIT = 1024 * 1024;
const RESERVED = new Set(['create', 'check', 'undo', 'import', 'external', 'market']);

/**
 * @param core     skills.js 注入：paths / buildIndex / readTrustState / approve / isPiRunning / skillId /
 *                 pathKey / validateName / maxSkillBytes / maxDescriptionLength / currentCwd / getProjects
 * @param dataDir  Pi GUI 的数据目录（回收站、市场缓存）
 * @param fetcher  市场的取数实现，测试注入
 * @param now      返回 Date 的时钟，测试注入；撤销令牌、导入暂存、市场预览的过期都按它算
 */
export function createSkillsRoutes({ core, dataDir = null, env = process.env, fetcher = null, now = undefined }) {
  const msClock = now ? { now: () => now().getTime() } : {};
  const manager = createSkillsManager({ core, dataDir, ...(now ? { now } : {}) });
  const importer = createSkillsImport({ manager, ...msClock });
  const external = createSkillsExternal({ core, manager, env });
  const market = createSkillsMarket({ dataDir, manager, core, env, fetcher, ...msClock });

  /* ---------- 项目上下文 ---------- */

  /** 可选的项目：项目列表里登记过的，加上当前工作区（它可能没登记）。 */
  function registeredProjects() {
    const current = core.currentCwd();
    const seen = new Set();
    const list = [];
    const add = (rawPath, name) => {
      if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) return;
      const key = core.pathKey(rawPath);
      if (seen.has(key)) return;
      seen.add(key);
      list.push({
        id: core.skillId(rawPath),
        name: (typeof name === 'string' && name.trim()) || path.basename(rawPath) || rawPath,
        path: rawPath,
        active: Boolean(current) && key === core.pathKey(current),
      });
    };
    let items = [];
    try {
      items = core.getProjects ? core.getProjects() : [];
    } catch {
      items = [];
    }
    for (const item of Array.isArray(items) ? items : []) add(item && item.path, item && item.name);
    if (current) add(current, '');
    return list;
  }

  /**
   * live：这个上下文就是 pi 正在运行的那个工作区。只有 live 的上下文才向 pi 问「实际加载了哪些」；
   * 别的项目只能给出静态判断，加载状态如实标为未知。
   */
  function resolveContext(param) {
    const current = core.currentCwd();
    if (param === null || param === '') return { ok: true, explicit: false, cwd: current, live: true };
    if (param === 'none') return { ok: true, explicit: true, cwd: '', live: current === '' };
    if (!ID_PATTERN.test(param)) return fail(400, 'bad-project', 'project 参数不合法');
    const hit = registeredProjects().find((project) => project.id === param);
    if (!hit) return fail(409, 'project-gone', '这个项目已经不在项目列表里了，请刷新');
    return { ok: true, explicit: true, cwd: hit.path, live: hit.active };
  }

  function send(res, result) {
    if (result && result.ok === false) {
      const { status, ...rest } = result;
      json(res, Number.isInteger(status) ? status : 500, rest);
    } else {
      json(res, 200, result);
    }
    return true;
  }

  /** 解析 ?project=。不合法时自己把响应写掉并返回 null。 */
  function contextOf(res, url) {
    const context = resolveContext(url.searchParams.get('project'));
    if (context.ok) return context;
    send(res, context);
    return null;
  }

  /* ---------- 列表的附加信息 ---------- */

  const READ_ONLY = Object.freeze({ target: null, editable: false, deletable: false, reason: '' });

  /** 在原有列表上补：当前上下文、可选项目、写入目标、每个技能能不能改。 */
  function listExtras(payload, idx, context) {
    const described = manager.describe(idx, context);
    return {
      ...payload,
      context: { project: context.cwd ? core.skillId(context.cwd) : 'none', live: context.live },
      projects: registeredProjects().map((project) => ({ id: project.id, name: project.name, path: project.path, active: project.active })),
      targets: described.targets,
      trashAvailable: described.trashAvailable,
      skills: payload.skills.map((skill) => ({ ...skill, manage: described.manage.get(skill.id) || READ_ONLY })),
    };
  }

  /* ---------- 请求体 ---------- */

  async function readJson(req, res, limit = JSON_BODY_LIMIT) {
    let text;
    try {
      text = await readBody(req, limit);
    } catch (err) {
      const tooLarge = /超过上限/.test(String(err && err.message));
      json(res, tooLarge ? 413 : 400, { ok: false, code: tooLarge ? 'too-large' : 'bad-request', error: tooLarge ? '请求体太大' : '请求体读取失败' });
      return null;
    }
    try {
      const value = text ? JSON.parse(text) : {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value;
    } catch {
      json(res, 400, { ok: false, code: 'bad-request', error: '请求体不是合法 JSON' });
      return null;
    }
  }

  const methodNotAllowed = (res) => send(res, fail(405, 'method-not-allowed', 'Method not allowed'));
  const notFound = (res) => send(res, fail(404, 'not-found', 'Not found'));
  /** 会落盘到某个目标目录的操作，必须说清楚是哪个项目。 */
  const projectRequired = (res, context) => (context.explicit ? false : send(res, fail(400, 'project-required', '缺少 project 参数')));

  /** POST + JSON 请求体的公共骨架。needsProject：是否要求显式的项目上下文。 */
  async function post(req, res, context, { needsProject = false, limit = JSON_BODY_LIMIT }, run) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    if (needsProject && projectRequired(res, context)) return true;
    const body = await readJson(req, res, limit);
    if (!body) return true;
    return send(res, await run(body));
  }

  /* ---------- 路由 ---------- */

  async function routeReserved(req, res, url, context, segments) {
    const [head, second, third, fourth] = segments;
    const count = segments.length;

    if (head === 'create' && count === 1) {
      return post(req, res, context, { needsProject: true }, (body) => manager.create(context, body));
    }
    if (head === 'check' && count === 1) {
      return post(req, res, context, {}, (body) => manager.check(context, body));
    }
    if (head === 'undo' && count === 2) {
      if (req.method !== 'POST') return methodNotAllowed(res);
      if (!TOKEN_PATTERN.test(second)) return send(res, fail(400, 'bad-request', '撤销令牌不合法'));
      return send(res, await manager.undo(second));
    }

    if (head === 'import' && count === 2 && second === 'stage') {
      return post(req, res, context, { limit: IMPORT_BODY_LIMIT }, (body) => importer.stage(body));
    }
    if (head === 'import' && count === 2 && second === 'commit') {
      return post(req, res, context, { needsProject: true }, (body) => importer.commit(context, body));
    }

    if (head === 'external' && count === 1) {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return send(res, await external.scan(context));
    }
    if (head === 'external' && count === 2 && second === 'import') {
      return post(req, res, context, { needsProject: true }, (body) => external.importMany(context, body));
    }

    if (head === 'market' && count === 1) {
      if (req.method !== 'GET') return methodNotAllowed(res);
      return send(res, market.state());
    }
    if (head === 'market' && count === 2 && second === 'refresh') {
      return post(req, res, context, {}, (body) => market.refresh({ sourceId: body.sourceId, force: body.force === true }));
    }
    if (head === 'market' && count === 2 && second === 'sources') {
      return post(req, res, context, {}, (body) => {
        if (body.action === 'add') return market.addSource({ repo: body.repo });
        if (body.action === 'remove') return market.removeSource({ id: body.id });
        return fail(400, 'bad-request', 'action 只能是 add 或 remove');
      });
    }
    if (head === 'market' && count === 2 && second === 'preview') {
      return post(req, res, context, {}, (body) => market.preview({ entryId: body.entryId }));
    }
    if (head === 'market' && count === 4 && second === 'preview' && fourth === 'file') {
      if (req.method !== 'GET') return methodNotAllowed(res);
      if (!TOKEN_PATTERN.test(third)) return send(res, fail(400, 'bad-request', '预览令牌不合法'));
      return send(res, market.previewFile({ previewId: third, path: url.searchParams.get('path') }));
    }
    if (head === 'market' && count === 2 && second === 'install') {
      return post(req, res, context, { needsProject: true }, (body) => market.install(context, body));
    }
    return notFound(res);
  }

  /** 这条路径归不归本模块：保留字开头的、<id>/source、DELETE <id>。列表 / 详情 / 启停不归这里。 */
  function parseRoute(req, url) {
    const rest = url.pathname.replace(/^\/api\/skills\/?/, '');
    if (!rest) return null;
    let segments;
    try {
      segments = rest.split('/').map((segment) => decodeURIComponent(segment));
    } catch {
      return { malformed: true };
    }
    const reserved = RESERVED.has(segments[0]);
    const isSource = segments.length === 2 && segments[1] === 'source';
    const isDelete = segments.length === 1 && req.method === 'DELETE';
    return reserved || isSource || isDelete ? { segments, reserved, isDelete } : null;
  }

  /** 同步判定，不读请求体 —— 调用方据此决定由谁去读。 */
  const owns = (req, url) => parseRoute(req, url) !== null;

  /** 处理本模块负责的路由（先用 owns 判定）。读请求体之前没有任何异步等待。 */
  async function handle(req, res, url, context) {
    const route = parseRoute(req, url);
    if (!route) return notFound(res);
    if (route.malformed) return send(res, fail(400, 'bad-request', '路径不合法'));
    const { segments, reserved, isDelete } = route;
    const [head] = segments;

    try {
      if (reserved) return await routeReserved(req, res, url, context, segments);
      if (!ID_PATTERN.test(head)) return send(res, fail(400, 'bad-request', 'ID 不合法'));
      if (isDelete) {
        if (projectRequired(res, context)) return true;
        return send(res, await manager.remove(context, head));
      }
      if (req.method === 'GET') return send(res, await manager.readSource(context, head));
      if (req.method !== 'PUT') return methodNotAllowed(res);
      if (projectRequired(res, context)) return true;
      const body = await readJson(req, res);
      if (!body) return true;
      return send(res, await manager.saveSource(context, head, body));
    } catch (err) {
      // 只带错误类别，不带原始报错正文（里面可能有本机路径）
      if (!res.headersSent) json(res, 500, { ok: false, code: 'internal', error: `技能操作失败（${(err && err.code) || '内部错误'}）` });
      return true;
    }
  }

  return {
    owns,
    handle,
    contextOf,
    listExtras,
    configureMarket: (options) => market.configure(options),
    manager,
    market,
  };
}
