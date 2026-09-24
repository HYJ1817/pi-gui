/* Git 变更的 HTTP 路由适配层。
 *
 * **这里只有「把 HTTP 映射成业务调用」，没有 Git 逻辑。** 真正的实现全在
 * lib/git.js（状态 / diff / 撤销 / 打开目标解析）—— 那是一个独立业务模块，
 * 拆后端时不该动它一行。
 *
 * 设计要点：
 *   - **不是 Git 仓库不是错误。** Pi GUI 允许打开普通文件夹，那种情况下 Agent
 *     照常工作，只是没有变更信息。所以一律回 200 + isRepo:false，让前端安静降级，
 *     而不是弹一串错误提示。
 *   - 真正的错误（路径越权、git 未安装）也用 200 + ok:false 回，但带明确的
 *     error 文案 —— 前端只有「解析 JSON 看 ok」这一条路径，不必同时处理
 *     HTTP 错误码和业务错误两套逻辑。唯一的例外是**路径越权**：那属于明确的
 *     拒绝，用 403 表态，便于审计与测试。
 *   - 路径安全统一由 lib/safe-path.js 把关（见那里的说明）。这里只负责把
 *     结果映射成 HTTP 语义。
 *
 * 写操作有两条**默认关闭**的闸门（删未跟踪文件 / 取消暂存）。没有授权时后端
 * 不会动手，而是回 `needsPlan` / `needsUnstage` / `needsConfirm` + 一份计划，
 * 由前端问过用户再带授权重发 —— 所以这里不需要为「需要确认」单独设计状态码。
 */
import { gitDiff, gitRestore, gitStatus, resolveOpenTarget, restoreAllGit } from '../lib/git.js';
import { json, readBody } from './http-utils.js';

/** 越权类错误 → 403；参数缺失 → 400；其余（非仓库 / git 未安装 / 没有改动 / 需确认）→ 200。 */
function gitStatusOf(result) {
  if (result.ok) return 200;
  if (result.code === 'empty') return 400;
  if (result.code === 'absolute' || result.code === 'escape' || result.code === 'symlink' || result.code === 'illegal') {
    return 403;
  }
  return 200;
}

/**
 * @param runtime 共享运行态（要 cwd）。只读，不改。
 */
export function createGitRoutes({ runtime }) {
  function handle(req, res, url) {
    const sub = url.pathname.slice('/api/git/'.length);
    const cwd = runtime.getCurrentCwd();

    if (sub === 'status' && req.method === 'GET') {
      return gitStatus(cwd)
        .then((r) => json(res, 200, r))
        .catch((err) => json(res, 200, { ok: false, isRepo: false, files: [], error: String(err.message) }));
    }

    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });

    // 没有项目时这些操作都无从谈起，直接给出可执行的指引
    if (!cwd) {
      return json(res, 200, { ok: false, isRepo: false, noProject: true, error: '还没有选择项目：先在左侧「添加文件夹」选一个目录。' });
    }

    return readBody(req)
      .then(async (raw) => {
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        }

        /* 撤销全部。不接受 path —— 它作用于整个工作区，多一个参数只会让
         * 「到底撤了什么」变得含糊。放在 `path` 校验**之前**，因为它本来就不需要。 */
        if (sub === 'restore-all') {
          const r = await restoreAllGit(cwd, {
            deleteUntracked: payload.deleteUntracked === true,
            unstage: payload.unstage === true,
            planned: payload.planned === true,
          });
          return json(res, gitStatusOf(r), r);
        }

        const rel = String(payload.path ?? '');
        if (!rel.trim()) return json(res, 400, { ok: false, error: '缺少 path' });

        if (sub === 'diff') {
          const r = await gitDiff(cwd, rel, { context: payload.context });
          return json(res, gitStatusOf(r), r);
        }

        if (sub === 'restore') {
          const r = await gitRestore(cwd, rel, {
            deleteUntracked: payload.deleteUntracked === true,
            unstage: payload.unstage === true,
          });
          return json(res, gitStatusOf(r), r);
        }

        if (sub === 'open') {
          /* 只做校验并给出绝对路径 —— **不在这里打开文件**。
           * 浏览器模式下后端没有「用系统默认程序打开」的能力，桌面版则由 Electron
           * 主进程拿着这个绝对路径去 shell.openPath。好处是「什么算项目内的文件」
           * 只有这一处答案，Electron 那边不必再实现一遍同样的判断。 */
          const r = resolveOpenTarget(cwd, rel);
          return json(res, gitStatusOf(r), r);
        }

        return json(res, 404, { ok: false, error: '未知的 Git 接口' });
      })
      .catch((err) => json(res, 500, { ok: false, error: String(err.message) }));
  }

  return { handle };
}
