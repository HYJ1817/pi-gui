/* 项目（工作目录）。
 *
 * pi 的会话按 cwd 分目录存储，而 RPC 协议本身没有「切换工作目录」的命令，
 * 所以「切换项目」= 用新的 cwd 重启子进程。
 *
 * ---------- cwd 的归属 ----------
 *
 * currentCwd **不存在这个文件里** —— 它是共享运行态，唯一权威在 runtime.js。
 * 这里只通过 runtime 读写，绝不自己缓存一份。切换项目的写路径只有一处
 * （下面的 activate 分支）：先 setCurrentCwd，再 restartPi，顺序不能反。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, readBody } from './http-utils.js';

/**
 * 启动时该用哪个目录当项目。
 *
 * 优先 PI_CWD（开发与自动化测试用它把工作目录隔离到临时目录）；
 * 否则读 projects.json 里上次激活的项目；都没有就是 null。
 *
 * 早先这里兜底成 process.cwd()，桌面版又把后端进程的 cwd 设成用户主目录，
 * 于是**首次启动直接落在用户主目录**，还会把该目录下的 pi 历史会话整段恢复出来。
 * 用户第一眼看到一堆跟自己无关的对话，完全不知道发生了什么。
 * 宁可空着、让界面明确提示「添加文件夹」，也不要猜一个目录。
 *
 * 返回 null 之后所有下游都要能接受它：rpc-bridge.start 会跳过，
 * 前端会切到「未选项目」形态。
 *
 * @param projectsFile projects.json 的绝对路径
 * @param env          环境变量来源，默认 process.env
 */
export function resolveInitialCwd(projectsFile, env = process.env) {
  const fromEnv = String(env.PI_CWD || '').trim();
  if (fromEnv) return path.resolve(fromEnv);

  try {
    const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
    const active = String(data?.active || '').trim();
    // 上次的项目可能已经被删掉/移走/拔了盘 —— 那就当作没有，别开在一个不存在的目录上
    if (active && fs.statSync(active).isDirectory()) return path.resolve(active);
  } catch {
    /* 没有 projects.json，或目录已经不在了 */
  }
  return null;
}

/**
 * @param projectsFile projects.json 的绝对路径
 * @param runtime      共享运行态（读 cwd、写 cwd）
 * @param restartPi    切换项目后重启 pi 的回调（注入而不是 import，
 *                     避免 projects ↔ rpc-bridge 互相 import）
 * @param isWin        是否 Windows（影响盘符列举与路径大小写归一）
 * @param beforeActivate 可选的「切换前闸门」。返回非空字符串 = 拒绝切换，
 *                     字符串就是给用户看的原因。存在的理由是 Planner：
 *                     有计划正在跑的时候切项目，会让某个 task 的输出归属
 *                     变得说不清（见 server/planner/index.js 的说明）。
 */
export function createProjects({ projectsFile, runtime, restartPi, isWin, beforeActivate = null }) {
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      if (data && Array.isArray(data.items)) {
        // active 兜底用「正在跑的那个目录」：用户可能刚把 active 那条从列表里移掉，
        // 但当前会话还在那个目录里跑着，界面上的高亮要跟着实际状态走。
        return { active: data.active || runtime.getCurrentCwd() || '', items: data.items };
      }
    } catch {
      /* 首次运行 —— 空列表，等用户自己添加 */
    }
    /* 不再拿「当前目录」当默认项目。
     * 早先这里返回 items:[当前目录]，等于把「程序碰巧运行在哪」当成用户的项目，
     * 桌面版上就是用户主目录。 */
    return { active: runtime.getCurrentCwd() || '', items: [] };
  }

  function write(data) {
    fs.writeFileSync(projectsFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  // 返回 null 表示读不了（不存在 / 无权限），与「空目录」区分开
  function readDirs(dir) {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => {
          try {
            return e.isDirectory() && !e.name.startsWith('.');
          } catch {
            return false;
          }
        })
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
        .slice(0, 400);
    } catch {
      return null;
    }
  }

  function listDirectory(target) {
    if (!target) {
      if (isWin) {
        const drives = [];
        for (let i = 67; i <= 90; i++) {
          const d = String.fromCharCode(i) + ':\\';
          try {
            if (fs.existsSync(d)) drives.push({ name: d, path: d });
          } catch {
            /* 盘符不存在或无权限 */
          }
        }
        return { path: '', parent: null, dirs: drives };
      }
      const home = os.homedir();
      return { path: home, parent: path.dirname(home), dirs: readDirs(home) || [] };
    }

    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) return { error: `目录不存在：${resolved}` };

    const dirs = readDirs(resolved);
    if (dirs === null) return { error: `无法读取（可能没有权限）：${resolved}` };

    const parent = path.dirname(resolved);
    return {
      path: resolved,
      parent: parent === resolved ? null : parent,
      dirs,
    };
  }

  function handleFs(res, url) {
    const target = url.searchParams.get('path') || '';
    try {
      const r = listDirectory(target);
      if (r.error) return json(res, 200, { ok: false, error: r.error });
      return json(res, 200, { ok: true, ...r });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err.message) });
    }
  }

  // Windows 与 macOS 的路径不区分大小写，去重必须归一后再比，
  // 否则同一个目录换个大小写就能重复加进来。
  function samePath(a, b) {
    if (!a || !b) return false;
    const norm = (s) => {
      const t = String(s).replace(/[\\/]+$/, '');
      return isWin || process.platform === 'darwin' ? t.toLowerCase() : t;
    };
    return norm(a) === norm(b);
  }

  function handle(req, res, url) {
    if (req.method === 'GET') {
      return json(res, 200, { ok: true, ...read(), cwd: runtime.getCurrentCwd() });
    }

    if (req.method === 'POST' && url.pathname === '/api/projects') {
      return readBody(req)
        .then((raw) => {
          let payload;
          try {
            payload = JSON.parse(raw || '{}');
          } catch {
            return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          }

          const target = String(payload.path || '').trim();
          if (!target) return json(res, 400, { ok: false, error: '路径必填' });

          const resolved = path.resolve(target);
          let stat;
          try {
            stat = fs.statSync(resolved);
          } catch {
            return json(res, 400, { ok: false, error: `目录不存在：${resolved}` });
          }
          if (!stat.isDirectory()) {
            return json(res, 400, { ok: false, error: `不是目录：${resolved}` });
          }

          const cfg = read();
          if (!cfg.items.some((p) => samePath(p.path, resolved))) {
            cfg.items.push({
              path: resolved,
              name: String(payload.name || '').trim() || path.basename(resolved) || resolved,
            });
            write(cfg);
          }
          return json(res, 200, { ok: true, path: resolved });
        })
        .catch((err) => json(res, 500, { ok: false, error: String(err.message) }));
    }

    if (req.method === 'DELETE') {
      const raw = url.searchParams.get('path') || '';
      const resolved = path.resolve(raw);
      const cfg = read();
      const before = cfg.items.length;
      cfg.items = cfg.items.filter((p) => !samePath(p.path, resolved));
      /* 移掉的正好是「上次激活的那个」时，把 active 也清掉。
       *
       * 不清的话会出现这种怪事：从列表里移除了，重启之后它又回来了
       * （resolveInitialCwd 读的就是 active）。用户会觉得「移除没生效」。
       * 注意这里**不**动 currentCwd —— 当前会话还在那个目录里跑着，
       * 立刻把 pi 掐掉比留着更让人困惑。 */
      if (samePath(cfg.active, resolved)) cfg.active = '';
      write(cfg);
      return json(res, 200, { ok: true, removed: resolved, count: before - cfg.items.length });
    }

    if (req.method === 'POST' && url.pathname === '/api/projects/activate') {
      return readBody(req)
        .then((raw) => {
          let payload;
          try {
            payload = JSON.parse(raw || '{}');
          } catch {
            return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          }

          const resolved = path.resolve(String(payload.path || ''));
          try {
            if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
          } catch {
            return json(res, 400, { ok: false, error: `目录不可用：${resolved}` });
          }

          /* 有计划正在执行时不许切项目。
           * 技术上能切，但切完之后「某个 task 的输出属于哪个项目」就得靠
           * generation 去猜 —— 那是最难查的一类状态错。第一版直接拒绝，
           * 让用户先停止计划（界面上有停止按钮）。 */
          if (beforeActivate) {
            const reason = beforeActivate();
            if (reason) return json(res, 409, { ok: false, code: 'plan-running', error: reason });
          }

          const cfg = read();
          cfg.active = resolved;
          if (!cfg.items.some((p) => samePath(p.path, resolved))) {
            cfg.items.push({ path: resolved, name: path.basename(resolved) || resolved });
          }
          write(cfg);

          // pi 只能在启动时确定 cwd，所以切换项目必须重启子进程。
          // 先改共享态、再重启 —— 反了的话新进程会拿到旧 cwd。
          runtime.setCurrentCwd(resolved);
          restartPi();
          return json(res, 200, { ok: true, cwd: resolved });
        })
        .catch((err) => json(res, 500, { ok: false, error: String(err.message) }));
    }

    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  return { handle, handleFs, read, write, samePath, listDirectory };
}
