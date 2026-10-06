import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isInside } from '../lib/safe-path.js';
import { samePath, failure, fileIdentity, worktreeGit, repository, inventory, sourceCommit, validBranch, dirtyStatus, branchName, adminDirectory } from '../lib/git-worktree.js';
import { json, readRawBody } from './http-utils.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
const MESSAGES = {
  unknown_project: '项目不在登记列表中，请重新选择项目。', not_git: '此项目不是 Git 仓库；请选择 Git 项目，或继续顺序对话。',
  git_unavailable: 'Git 不可用，请检查本机安装。', git_failed: 'Git 操作未完成，请检查工作区后重试。',
  invalid_source: '源提交不可用，请选择已有的本地提交。', invalid_branch: '分支名称不合法。', branch_conflict: '分支已存在，请换一个名称。',
  path_occupied: '目标目录已被占用，未覆盖任何文件。', invalid_request: '请求格式不正确。', unknown_workspace: '工作区未登记，不能操作。',
  stale_workspace: '工作区身份已变化，请刷新后重试。', workspace_unavailable: '工作区已丢失或身份不明；可保留历史并新建工作区。',
  confirmation_expired: '创建确认已失效，请重新预检。', confirmation_changed: '预检事实已变化，请重新确认。',
  workspace_busy: '当前任务、停止或清理尚未完成，请先完成或停止。', workspace_in_use: '此工作区正在使用，请先切回主工作区并完成清理。',
  workspace_archived: '工作区已归档，请先取消归档。', worktree_locked: 'Git 已锁定此工作区，请先人工检查。',
  dirty_worktree: '存在未提交、未跟踪或 ignored 文件，保守拒绝移除；请先自行保留或清理。',
  unmerged_work: '尚有未合并工作或整合目标不明，保守拒绝移除。', submodule_present: '存在子模块或嵌套仓库，保守拒绝移除。',
  unsafe_path: '受控路径校验失败，未操作任何目录。', metadata_invalid: 'Worktree 登记文件不可用，请保留文件并检查诊断。',
  metadata_write_failed: '登记写入失败；请刷新检查工作区，不会强制删除。', partial_creation: '创建未完成，保留已生成的分支或目录供检查。',
  workspace_limit: '登记工作区已达上限，请先检查和清理旧记录。', invalid_project: '项目目录边界无法确认。',
  storage_inside_project: '受控目录位于仓库内；请将 PI_GUI_DATA 设为仓库外目录后重启，再创建工作区。',
};

export function createWorktrees({ dataDir, getProjects, getContext = () => ({ cwd: null, generation: 0 }),
  busyReason = () => null, activate = async () => { throw failure('workspace_unavailable'); }, onMissing = async () => {}, now = Date.now,
  isWorkspaceInUse = () => false } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dataRoot = fs.realpathSync(dataDir), dataIdentity = fileIdentity(dataRoot);
  const root = path.join(dataRoot, 'worktrees'), manifest = path.join(dataRoot, 'worktrees.json');
  let entries = [], invalid = false, queue = Promise.resolve(), disposed = false, timer = null;
  const confirmations = new Map();
  try {
    if (fs.existsSync(manifest)) {
      if (fs.lstatSync(manifest).isSymbolicLink() || fs.statSync(manifest).size > 1024 * 1024) throw Error();
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > 256) throw Error();
      entries = parsed.entries;
      const seen = new Set();
      for (const r of entries) {
        if (!uuid(r.id) || !uuid(r.epoch) || !/^[0-9a-f]{24}$/.test(r.repoId) || seen.has(r.id)
          || !['anchor', 'common', 'project', 'branch', 'sourceHash', 'prefix'].every(k => typeof r[k] === 'string')
          || path.isAbsolute(r.prefix) || r.prefix.split(/[\\/]/).includes('..')) throw Error();
        seen.add(r.id);
      }
    }
  } catch { invalid = true; }
  function baseGuard() {
    if (disposed || invalid) throw failure('metadata_invalid');
    if (fs.lstatSync(dataRoot).isSymbolicLink() || fileIdentity(dataRoot) !== dataIdentity || !samePath(fs.realpathSync(dataRoot), dataRoot)) throw failure('unsafe_path');
  }
  function serialize(fn, expected = getContext().generation) {
    const task = queue.catch(() => {}).then(async () => {
      const guard = () => { baseGuard(); if (expected !== getContext().generation) throw failure('stale_workspace'); };
      guard(); return fn(guard);
    }); queue = task.catch(() => {}); return task;
  }
  function save() {
    baseGuard(); const tmp = path.join(dataRoot, `.worktrees-${randomUUID()}.tmp`);
    try { fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, manifest); }
    catch { throw failure('metadata_write_failed'); }
    finally { try { fs.unlinkSync(tmp); } catch { /* already renamed */ } }
  }
  function target(r) { return path.join(root, r.repoId, r.id); }
  function safeParent(r, create = false) {
    baseGuard(); let current = dataRoot;
    for (const part of ['worktrees', r.repoId]) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) { if (!create) throw failure('unsafe_path'); fs.mkdirSync(current); }
      if (fs.lstatSync(current).isSymbolicLink() || !samePath(fs.realpathSync(current), current) || !isInside(dataRoot, current)) throw failure('unsafe_path');
    }
    return current;
  }
  function checkBusy() { if (busyReason()) throw failure('workspace_busy'); }
  async function projectInfo(project) {
    const item = getProjects().find(p => samePath(p.path, project));
    if (!item) throw failure('unknown_project');
    const repo = await repository(item.path);
    return { ...repo, project: item.path, name: item.name || path.basename(item.path), repoId: hash(repo.common), projectId: hash(fs.realpathSync(item.path)) };
  }
  function lookup(args) {
    if (!closed(args, ['id', 'epoch', 'archived']) || typeof args.id !== 'string') throw failure('invalid_request');
    const r = entries.find(r => r.id === args.id); if (!r) throw failure('unknown_workspace');
    if (args.epoch !== r.epoch) throw failure('stale_workspace'); return r;
  }
  function within(r, cwd) {
    if (!cwd) return false;
    if (isInside(target(r), path.resolve(cwd))) return true;
    try { return isInside(target(r), fs.realpathSync(cwd)); } catch { return false; }
  }
  function inUse(r) { return within(r, getContext().cwd) || isWorkspaceInUse(target(r)); }
  function noNestedRepositories(dir) {
    const pending = [dir]; let visited = 0;
    while (pending.length) {
      const parent = pending.pop();
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (++visited > 100000) throw failure('submodule_present');
        if (parent === dir && entry.name === '.git') continue;
        if (entry.name.toLowerCase() === '.git' || entry.isSymbolicLink()) throw failure('submodule_present');
        if (entry.isDirectory()) pending.push(path.join(parent, entry.name));
      }
    }
  }
  function summary(r) {
    return { id: r.id, epoch: r.epoch, repoId: r.repoId, kind: 'managed', path: target(r), cwd: path.join(target(r), r.prefix || ''),
      branch: r.branch, health: r.health, archived: r.archived === true, current: within(r, getContext().cwd), inUse: inUse(r), removed: r.removed === true };
  }
  async function health(r) {
    if (r.removed) return 'removed';
    let state = 'unavailable';
    try {
      safeParent(r); const dir = target(r);
      if (!fs.existsSync(dir)) state = 'missing';
      else if (fs.lstatSync(dir).isSymbolicLink()) state = 'unavailable';
      else {
        const repo = await repository(dir), admin = await adminDirectory(dir);
        const registered = (await inventory(r.anchor)).find(w => samePath(w.path, dir));
        const intact = r.rootIdentity && r.adminIdentity && fileIdentity(dir) === r.rootIdentity && fileIdentity(admin) === r.adminIdentity
          && samePath(repo.root, dir) && samePath(repo.common, r.common) && samePath(admin, r.admin) && hash(repo.common) === r.repoId;
        state = intact && registered && !r.invalidated ? registered.locked ? 'locked' : registered.branch === r.branch ? 'healthy' : 'changed' : 'unavailable';
      }
    } catch { state = fs.existsSync(target(r)) ? 'unavailable' : 'missing'; }
    if (r.health !== state) {
      const lost = !['healthy', 'locked'].includes(state) && ['healthy', 'locked'].includes(r.health);
      r.health = state;
      if (lost) { r.epoch = randomUUID(); r.invalidated = true; if (inUse(r)) await onMissing(summary(r)); }
      save();
    }
    return state;
  }
  async function owned(r) {
    if (await health(r) === 'locked') throw failure('worktree_locked');
    if (r.health !== 'healthy') throw failure('workspace_unavailable');
    safeParent(r);
  }
  async function prepareImpl(args) {
    if (!closed(args, ['project', 'source', 'branch'])) throw failure('invalid_request');
    if (entries.length >= 256) throw failure('workspace_limit');
    const repo = await projectInfo(args.project), id = randomUUID();
    if (isInside(repo.root, root) || isInside(repo.common, root)) throw failure('storage_inside_project');
    const branch = args.branch || `pi-gui/p32/${id}`;
    await validBranch(repo.root, branch); const sourceHash = await sourceCommit(repo.root, args.source || 'HEAD');
    const status = await dirtyStatus(repo.root), integration = await branchName(repo.root);
    const r = { id, epoch: randomUUID(), repoId: repo.repoId, project: repo.project, prefix: repo.prefix, anchor: repo.root, common: repo.common,
      source: args.source || 'HEAD', sourceHash, integration, branch, health: 'creating', archived: false };
    safeParent(r, true); if (fs.existsSync(target(r))) throw failure('path_occupied');
    for (const [key, item] of confirmations) if (now() > item.expires) confirmations.delete(key);
    if (confirmations.size >= 32) confirmations.delete(confirmations.keys().next().value);
    const nonce = randomUUID(); confirmations.set(nonce, { record: r, status, context: getContext().generation, expires: now() + 300000 });
    return { ok: true, nonce, plan: { id, repoId: r.repoId, projectId: repo.projectId, sourceHash, branch, mainDirty: Boolean(status), name: repo.name } };
  }
  const prepare = (args, expected) => serialize(() => prepareImpl(args), expected);
  const create = (args, expected) => serialize(async guard => {
    if (!closed(args, ['nonce'])) throw failure('invalid_request');
    const confirmation = confirmations.get(args.nonce); confirmations.delete(args.nonce);
    if (!confirmation || confirmation.expires < now()) throw failure('confirmation_expired');
    if (confirmation.context !== getContext().generation) throw failure('stale_workspace');
    checkBusy(); const r = confirmation.record, repo = await projectInfo(r.project);
    if (!samePath(repo.common, r.common) || !samePath(repo.root, r.anchor) || await sourceCommit(repo.root, r.source) !== r.sourceHash
      || await dirtyStatus(repo.root) !== confirmation.status || await branchName(repo.root) !== r.integration) throw failure('confirmation_changed');
    await validBranch(repo.root, r.branch); safeParent(r); if (fs.existsSync(target(r))) throw failure('path_occupied');
    guard(); checkBusy();
    entries.push(r); save();
    try {
      await worktreeGit(repo.root, ['worktree', 'add', '-b', r.branch, '--', target(r), r.sourceHash]);
      r.admin = await adminDirectory(target(r)); r.rootIdentity = fileIdentity(target(r)); r.adminIdentity = fileIdentity(r.admin);
      r.health = 'healthy'; await owned(r); save(); return { ok: true, workspace: summary(r) };
    } catch (e) { r.health = 'unavailable'; save(); throw failure(e.code === 'metadata_write_failed' ? e.code : 'partial_creation'); }
  }, expected);
  const list = args => serialize(async () => {
    if (!closed(args, ['project'])) throw failure('invalid_request');
    const repo = await projectInfo(args.project), found = await inventory(repo.root);
    const items = [{ id: `main-${repo.projectId}`, kind: 'main', path: repo.root, cwd: repo.project, branch: await branchName(repo.root), health: 'healthy', archived: false,
      current: samePath(getContext().cwd, repo.project) }];
    for (const r of entries.filter(r => r.repoId === repo.repoId && !r.removed)) { await health(r); items.push(summary(r)); }
    for (const w of found) if (!samePath(w.path, repo.root) && !entries.some(r => samePath(target(r), w.path))) items.push({ id: `external-${hash(w.path)}`, kind: 'external',
      branch: w.branch || null, health: w.prunable ? 'missing' : w.locked ? 'locked' : 'healthy', archived: false, current: false });
    return { ok: true, repoId: repo.repoId, projectId: repo.projectId, items, contextGeneration: getContext().generation };
  });
  const open = (args, expected) => serialize(async guard => {
    checkBusy(); const r = lookup(args); await owned(r); if (r.archived) throw failure('workspace_archived');
    await projectInfo(r.project); const cwd = path.join(target(r), r.prefix || '');
    if (!isInside(target(r), fs.realpathSync(cwd))) throw failure('unsafe_path');
    guard(); checkBusy();
    const result = await activate(cwd, r.project); if (!result?.ok) throw failure('workspace_busy'); return { ok: true, cwd, workspace: summary(r) };
  }, expected);
  const archive = (args, expected) => serialize(async guard => {
    checkBusy(); const r = lookup(args); if (typeof args.archived !== 'boolean') throw failure('invalid_request');
    if (inUse(r)) throw failure('workspace_in_use'); await health(r); guard(); checkBusy(); r.archived = args.archived; save(); return { ok: true, workspace: summary(r) };
  }, expected);
  const remove = (args, expected) => serialize(async guard => {
    checkBusy(); const r = lookup(args); if (r.removed) return { ok: true, alreadyRemoved: true };
    if (inUse(r)) throw failure('workspace_in_use'); await owned(r); await projectInfo(r.project);
    const dir = target(r);
    noNestedRepositories(dir);
    if (await dirtyStatus(dir)) throw failure('dirty_worktree');
    if ((await worktreeGit(dir, ['ls-files', '--stage', '-z'])).split('\0').some(line => line.startsWith('160000 '))) throw failure('submodule_present');
    if (!r.integration) throw failure('unmerged_work');
    let merged;
    try { const commit = await sourceCommit(r.anchor, `refs/heads/${r.integration}`);
      const result = await worktreeGit(dir, ['merge-base', '--is-ancestor', 'HEAD', commit], { okCodes: [0] }); merged = result !== null;
    } catch { throw failure('unmerged_work'); }
    if (!merged) throw failure('unmerged_work');
    await owned(r); if (inUse(r)) throw failure('workspace_in_use');
    if (await dirtyStatus(dir)) throw failure('dirty_worktree');
    noNestedRepositories(dir);
    guard(); checkBusy(); if (inUse(r)) throw failure('workspace_in_use');
    await worktreeGit(r.anchor, ['worktree', 'remove', '--', dir]);
    if (fs.existsSync(dir) || (await inventory(r.anchor)).some(w => samePath(w.path, dir))) throw failure('git_failed');
    r.removed = true; r.health = 'removed'; save(); return { ok: true };
  }, expected);
  function projectFor(cwd) {
    return entries.find(r => !r.removed && within(r, cwd))?.project || null;
  }
  async function validateCurrent() {
    return serialize(async () => {
      const cwd = getContext().cwd, r = entries.find(r => !r.removed && within(r, cwd));
      if (r && !isInside(target(r), path.resolve(cwd))) { await onMissing(summary(r)); throw failure('unsafe_path'); }
      if (cwd && isInside(root, path.resolve(cwd)) && !r) throw failure('unknown_workspace');
      if (r && !['healthy', 'locked'].includes(await health(r))) throw failure('workspace_unavailable');
      if (r && !isInside(target(r), fs.realpathSync(cwd))) { await onMissing(summary(r)); throw failure('unsafe_path'); }
    });
  }
  function withActivation(cwd, action) {
    return serialize(async guard => {
      const r = entries.find(r => !r.removed && within(r, cwd));
      let canonical = path.resolve(cwd); try { canonical = fs.realpathSync(cwd); } catch { /* normal activation checks existence */ }
      if ((isInside(root, path.resolve(cwd)) || isInside(root, canonical)) && !r) throw failure('unknown_workspace');
      if (r && (!isInside(target(r), path.resolve(cwd)) || !isInside(target(r), canonical))) throw failure('unsafe_path');
      if (r) { checkBusy(); await owned(r); await projectInfo(r.project); if (r.archived) throw failure('workspace_archived'); }
      guard();
      return action();
    });
  }
  // Registry admission holds the same lifecycle lock as archive/remove. The
  // callback reserves its immutable workspace lease before this lock releases.
  function withWorkspace(args, action) {
    return serialize(async guard => {
      const r = lookup({ id: args.id, epoch: args.epoch });
      await owned(r); if (r.archived) throw failure('workspace_archived');
      const project = await projectInfo(r.project), cwd = path.join(target(r), r.prefix || '');
      if (!isInside(target(r), fs.realpathSync(cwd))) throw failure('unsafe_path');
      guard();
      return action({ projectId: project.projectId, repoId: r.repoId, workspaceId: r.id, workspaceEpoch: r.epoch,
        cwd, root: target(r), branch: r.branch });
    });
  }
  async function handle(req, res, url) {
    try {
      if (req.method === 'GET') return json(res, 200, await list({ project: url.searchParams.get('project') }));
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'invalid_request', error: MESSAGES.invalid_request });
      const body = JSON.parse((await readRawBody(req, 4096)).toString('utf8'));
      if (!closed(body, ['action', 'project', 'branch', 'source', 'nonce', 'id', 'epoch', 'archived', 'contextGeneration'])) throw failure('invalid_request');
      const { action, contextGeneration, ...args } = body;
      if (contextGeneration !== getContext().generation) throw failure('stale_workspace');
      const actions = { prepare, create, open, archive, remove }; if (!Object.hasOwn(actions, action)) throw failure('invalid_request');
      return json(res, 200, await actions[action](args, contextGeneration));
    } catch (e) { const code = Object.hasOwn(MESSAGES, e.code) ? e.code : 'invalid_request'; return json(res, 409, { ok: false, code, error: MESSAGES[code] }); }
  }
  return { prepare, create, list, open, archive, remove, projectFor, validateCurrent, withActivation, withWorkspace, handle,
    monitor() { if (!timer) { timer = setInterval(() => { void validateCurrent().catch(() => {}); }, 5000); timer.unref(); } },
    dispose() { disposed = true; clearInterval(timer); confirmations.clear(); } };
}
