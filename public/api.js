/* HTTP 层。
 *
 * **这是前端唯一发起 fetch 的地方。** 其他模块只调用这里的语义化函数，
 * 不直接写 fetch —— 这样「有哪些后端接口、各自怎么处理失败」只有一处答案。
 *
 * 失败一律结构化返回（带 ok / error / network 三个字段），不抛异常：
 * 读操作可以据此静默降级，写操作可以据此弹提示。
 * 「用户点了按钮却什么都没发生」是最糟的体验，所以写操作必须能说出原因。 */

import { toast } from './ui/toast.js';

/** GET 一个 JSON 接口。网络层失败返回 {ok:false, network:true}。 */
export async function getJSON(url) {
  try {
    const r = await fetch(url);
    return await r.json();
  } catch (err) {
    return { ok: false, error: err.message, network: true };
  }
}

/** POST / DELETE 一个 JSON 接口。网络层失败同样返回结构化结果，不抛。 */
export async function sendJSON(url, { method = 'POST', body, contentType } = {}) {
  const opts = { method };
  if (contentType) {
    opts.headers = { 'Content-Type': contentType };
    opts.body = body;
  } else {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body || {});
  }
  try {
    const r = await fetch(url, opts);
    return await r.json();
  } catch (err) {
    return { ok: false, error: err.message, network: true };
  }
}

/* ---------- pi 的 RPC 命令 ---------- */

/** 把一条 RPC 命令发进后端。这是驱动 pi 的唯一出口。 */
export async function sendCommand(cmd) {
  const j = await sendJSON('/api/command', { body: cmd });
  if (j.network) {
    toast('无法连接后端：' + j.error, 'error');
    return { ok: false };
  }
  if (!j.ok) toast(j.error || '命令发送失败', 'error');
  return j;
}

/* ---------- 状态 / 项目 ---------- */

export const fetchStatus = () => getJSON('/api/status');
export const fetchProjects = () => getJSON('/api/projects');

export const createProject = (path, name) => sendJSON('/api/projects', { body: { path, name } });
export const deleteProject = (path) => sendJSON('/api/projects?path=' + encodeURIComponent(path), { method: 'DELETE' });
export const activateProject = (path) => sendJSON('/api/projects/activate', { body: { path } });
export const listDirectory = (target) =>
  getJSON('/api/fs' + (target ? '?path=' + encodeURIComponent(target) : ''));

export const restartBackend = () => sendJSON('/api/restart');

/* ---------- 当前项目的配置 ---------- */

/** 当前项目的偏好设置。没有项目时后端也回 200，只是 hasProject=false、config=null ——
 *  调用方不需要为「还没选项目」写一条错误分支。 */
export const fetchProjectConfig = () => getJSON('/api/project-config');

/** 保存当前项目的偏好。只发要改的字段即可（后端做合并），
 *  但界面上是整表单提交，所以这里是全量发。 */
export const saveProjectConfig = (config) => sendJSON('/api/project-config', { method: 'PUT', body: config });

/* ---------- 供应商 ---------- */

export const fetchProviders = () => getJSON('/api/providers');
export const saveProvider = (name, config) => sendJSON('/api/providers', { body: { name, config } });
export const deleteProvider = (name) => sendJSON('/api/providers/' + encodeURIComponent(name), { method: 'DELETE' });
export const fetchProviderModels = (payload) => sendJSON('/api/providers/models', { body: payload });

/* ---------- Git 变更 ---------- */

export const fetchGitStatus = () => getJSON('/api/git/status');

/** 拉某个文件的 diff。`context` 为 undefined 时不传，由 git 用默认上下文；
 *  传数字或 'all' 则是用户显式要求展开更多上下文 —— 这必须重新问后端，
 *  前端无法从已截断的正文里补出被 git 裁掉的上下文行。 */
export const fetchGitDiff = (path, context) =>
  sendJSON('/api/git/diff', { body: context === undefined || context === null ? { path } : { path, context } });

/** 撤销单个文件。两个布尔是**授权开关**，默认全关：
 *  deleteUntracked 允许删除未跟踪文件，unstage 允许取消暂存（会改 index）。 */
export const restoreGitPath = (path, { deleteUntracked = false, unstage = false } = {}) =>
  sendJSON('/api/git/restore', {
    body: { path, deleteUntracked: Boolean(deleteUntracked), unstage: Boolean(unstage) },
  });

/** 撤销全部。不接受 path —— 作用于整个工作区。
 *
 *  不带 `planned` 是**干跑**：只拿回计划（会恢复几个 / 取消暂存几个 / 删几个），
 *  一个字都不动。用户看过计划点头后再带 `planned: true` 重发，这次才真的执行。
 *  两个布尔是授权开关：unstage 允许取消暂存（会改 index），
 *  deleteUntracked 允许删除未跟踪文件。 */
export const restoreAllGitPaths = ({ deleteUntracked = false, unstage = false, planned = false } = {}) =>
  sendJSON('/api/git/restore-all', {
    body: { deleteUntracked: Boolean(deleteUntracked), unstage: Boolean(unstage), planned: Boolean(planned) },
  });

/** 只做校验并拿回绝对路径；真正「用系统默认程序打开」由 Electron 侧完成。 */
export const resolveGitOpenTarget = (path) => sendJSON('/api/git/open', { body: { path } });

/* ---------- 附件上传 ---------- */

/** 上传走裸二进制（文件名放 query），省掉 multipart 解析。 */
export const uploadFile = (file, name) =>
  sendJSON('/api/upload?name=' + encodeURIComponent(name), {
    body: file,
    contentType: 'application/octet-stream',
  });
