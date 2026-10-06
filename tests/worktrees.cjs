const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let count = 0;
async function check(name, fn) { await fn(); count++; console.log('  ok  ' + name); }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(cwd, '..', 'fixture-git-config'), GIT_TERMINAL_PROMPT: '0' } }).trim();

(async () => {
  let createWorktrees;
  try { ({ createWorktrees } = await import('../server/worktrees.js')); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  await check('生命周期模块可用', () => assert.equal(typeof createWorktrees, 'function'));
  // Windows 的 8.3 短名（`C:\Program Files` ↔ `C:\PROGRA~1`）：`fs.realpathSync` **不展开**
  // 短名，而 git 与系统 API 返回长名。GitHub Actions 的 Windows 运行器临时目录正是短名
  // 形状（`…\RUNNER~1\…`），于是同一目录得到两个字符串，`samePath` / `isInside` 判不出
  // 包含关系，`repository()` 会把合法项目误判成 invalid_project —— 整条 worktree 套件在
  // CI 上必红、在长名机器上全绿。这条断言把「两种写法必须归一到同一路径」钉住。
  // 卷上关掉 8.3 生成时短名不存在，该断言跳过（跳过不计入分子分母）。
  const SHORT_ALIAS = 'C:\\PROGRA~1', LONG_ALIAS = 'C:\\Program Files';
  if (process.platform === 'win32' && fs.existsSync(SHORT_ALIAS) && fs.existsSync(LONG_ALIAS)) {
    const { canonicalPath } = await import('../lib/safe-path.js');
    await check('8.3 短名与长名归一到同一路径', () => assert.equal(canonicalPath(SHORT_ALIAS), canonicalPath(LONG_ALIAS)));
  }
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'p32-worktrees-'));
  const repo = path.join(fixture, 'repo 中文'), data = path.join(fixture, 'data');
  fs.mkdirSync(repo); fs.mkdirSync(data); fs.mkdirSync(path.join(repo, 'src'));
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'core.autocrlf', 'false'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n'); fs.writeFileSync(path.join(repo, 'src/keep.txt'), 'source\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.local\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  let cwd = repo, generation = 1, busy = false, missing = 0;
  const options = { dataDir: data, getProjects: () => [{ path: repo, name: 'Fixture' }, { path: path.join(repo, 'src'), name: 'Subdir' }],
    getContext: () => ({ cwd, generation }), busyReason: () => busy ? 'workspace_busy' : null,
    activate: async (target, project) => { cwd = target; generation++; return { ok: true, cwd: target, project }; },
    onMissing: async () => { missing++; cwd = null; generation++; } };
  let manager = createWorktrees(options);
  const rejected = async (fn, code) => assert.rejects(fn, e => e.code === code);
  const identity = w => ({ id: w.id, epoch: w.epoch });
  const create = async (project = repo, branch) => manager.create({ nonce: (await manager.prepare({ project, branch })).nonce });
  try {
    await check('非登记项目不能读写', () => rejected(() => manager.list({ project: fixture }), 'unknown_project'));
    const initial = await manager.list({ project: repo });
    await check('主工作区只读登记，列表不启动 Pi', () => { assert.equal(initial.items.length, 1); assert.equal(initial.items[0].kind, 'main'); });
    const plan = await manager.prepare({ project: repo, branch: 'pi-gui/test-a' });
    await check('创建前明确 commit/dirty/branch，路径不是客户端输入', () => {
      assert.match(plan.plan.sourceHash, /^[0-9a-f]{40,64}$/); assert.equal(plan.plan.mainDirty, false); assert.equal(plan.plan.branch, 'pi-gui/test-a');
    });
    const a = (await manager.create({ nonce: plan.nonce })).workspace;
    const b = (await create(repo, 'pi-gui/test-b')).workspace;
    await check('同 repo A/B 两个真实 worktree，root/index/admin 分离', () => {
      assert.notEqual(a.id, b.id); assert.notEqual(a.path, b.path);
      assert.notEqual(git(a.path, 'rev-parse', '--git-dir'), git(b.path, 'rev-parse', '--git-dir'));
      assert.equal(fs.readFileSync(path.join(b.path, 'file.txt'), 'utf8'), 'base\n');
    });
    await check('nonce 只能使用一次', () => rejected(() => manager.create({ nonce: plan.nonce }), 'confirmation_expired'));
    await check('body 不接受任意 path', () => rejected(() => manager.create({ nonce: 'x', path: fixture }), 'invalid_request'));
    await check('branch 选项/路径注入拒绝', () => rejected(() => manager.prepare({ project: repo, branch: '../evil' }), 'invalid_branch'));
    await check('source 选项注入拒绝', () => rejected(() => manager.prepare({ project: repo, source: '--output=evil' }), 'invalid_source'));
    await check('branch 冲突不覆盖', () => rejected(() => manager.prepare({ project: repo, branch: a.branch }), 'branch_conflict'));
    await check('外部 PATH 字符串不能成为工作区 id', () => rejected(() => manager.remove({ id: '../repo', epoch: a.epoch }), 'unknown_workspace'));
    await check('陈旧 epoch 不能打开/删除', () => rejected(() => manager.open({ id: a.id, epoch: 'old' }), 'stale_workspace'));
    fs.writeFileSync(path.join(a.path, 'file.txt'), 'only A\n');
    await check('A 文件/状态不污染 B 或 main', () => {
      assert.match(git(a.path, 'status', '--porcelain'), /file.txt/); assert.equal(git(b.path, 'status', '--porcelain'), '');
      assert.equal(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8'), 'base\n');
    });
    await check('dirty worktree remove 拒绝且文件不变', async () => {
      await rejected(() => manager.remove(identity(a)), 'dirty_worktree'); assert.equal(fs.readFileSync(path.join(a.path, 'file.txt'), 'utf8'), 'only A\n');
    });
    fs.writeFileSync(path.join(a.path, 'file.txt'), 'base\n'); fs.writeFileSync(path.join(a.path, 'token.local'), 'fixture-secret');
    await check('ignored 文件 remove 也保守拒绝', () => rejected(() => manager.remove(identity(a)), 'dirty_worktree'));
    fs.unlinkSync(path.join(a.path, 'token.local'));
    fs.writeFileSync(path.join(a.path, 'new.txt'), 'untracked');
    await check('untracked remove 拒绝', () => rejected(() => manager.remove(identity(a)), 'dirty_worktree'));
    fs.unlinkSync(path.join(a.path, 'new.txt'));
    fs.writeFileSync(path.join(a.path, 'file.txt'), 'commit A\n'); git(a.path, 'add', '.');
    await check('staged remove 拒绝', () => rejected(() => manager.remove(identity(a)), 'dirty_worktree'));
    git(a.path, 'commit', '-m', 'work A');
    await check('clean 但未合并提交 remove 拒绝', () => rejected(() => manager.remove(identity(a)), 'unmerged_work'));
    git(repo, 'merge', '--ff-only', a.branch);
    await check('已合并、干净、安全 worktree 可移除，branch 保留', async () => {
      assert.equal((await manager.remove(identity(a))).ok, true); assert.equal(fs.existsSync(a.path), false);
      assert.equal(git(repo, 'rev-parse', a.branch), git(repo, 'rev-parse', 'HEAD'));
    });
    await check('重复 remove 幂等，不删除其它路径', async () => assert.equal((await manager.remove(identity(a))).alreadyRemoved, true));
    await manager.open(identity(b));
    await check('open 只走单工作区 activate，cwd 权威来自后端', () => assert.equal(cwd, b.path));
    await check('active remove 拒绝', () => rejected(() => manager.remove(identity(b)), 'workspace_in_use'));
    await check('active archive 拒绝', () => rejected(() => manager.archive({ ...identity(b), archived: true }), 'workspace_in_use'));
    cwd = repo; generation++;
    await check('archive 只修改 metadata，目录/branch 保留', async () => {
      await manager.archive({ ...identity(b), archived: true }); assert.ok(fs.existsSync(b.path)); assert.equal(git(b.path, 'branch', '--show-current'), b.branch);
    });
    await check('归档状态恢复后不自动 spawn', async () => {
      manager.dispose(); manager = createWorktrees(options); const rows = await manager.list({ project: repo }); assert.equal(rows.items.find(w => w.id === b.id).archived, true);
    });
    await check('archived open 给明确恢复错误', () => rejected(() => manager.open(identity(b)), 'workspace_archived'));
    await manager.archive({ ...identity(b), archived: false });
    busy = true;
    await check('既有 Planner/Stop/维护闸门不能绕过', () => rejected(() => manager.open(identity(b)), 'workspace_busy'));
    await check('busy remove 拒绝', () => rejected(() => manager.remove(identity(b)), 'workspace_busy'));
    busy = false;
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'main marker');
    const beforeIndex = fs.readFileSync(path.join(repo, '.git/index'));
    const dirty = await manager.prepare({ project: repo }); const d = (await manager.create({ nonce: dirty.nonce })).workspace;
    await check('dirty main 提示且不 stash/reset/复制未提交数据', () => {
      assert.equal(dirty.plan.mainDirty, true); assert.equal(fs.existsSync(path.join(d.path, 'dirty.txt')), false);
      assert.equal(fs.readFileSync(path.join(repo, 'dirty.txt'), 'utf8'), 'main marker'); assert.deepEqual(fs.readFileSync(path.join(repo, '.git/index')), beforeIndex);
    });
    const stale = await manager.prepare({ project: repo }); generation++;
    await check('项目 generation 改变使确认失效', () => rejected(() => manager.create({ nonce: stale.nonce }), 'stale_workspace'));
    const pathPlan = await manager.prepare({ project: repo });
    const reserved = path.join(data, 'worktrees', pathPlan.plan.repoId, pathPlan.plan.id); fs.mkdirSync(reserved); fs.writeFileSync(path.join(reserved, 'keep'), 'occupied');
    await check('目标 path 占用不覆盖', async () => {
      await rejected(() => manager.create({ nonce: pathPlan.nonce }), 'path_occupied'); assert.equal(fs.readFileSync(path.join(reserved, 'keep'), 'utf8'), 'occupied');
    });
    const sub = (await create(path.join(repo, 'src'))).workspace;
    await manager.open(identity(sub));
    await check('Project 子目录保留 prefix，不落到 repo root', () => assert.equal(cwd, path.join(sub.path, 'src')));
    const subRows = await manager.list({ project: path.join(repo, 'src') });
    await check('同 repo 子项目能发现工作区，但保持当前项目映射', () => assert.ok(subRows.items.some(w => w.id === b.id)));
    cwd = repo; generation++;
    git(d.path, 'worktree', 'lock', '--reason', 'fixture', d.path);
    await check('locked worktree remove 拒绝', () => rejected(() => manager.remove(identity(d)), 'worktree_locked'));
    git(repo, 'worktree', 'unlock', d.path);
    cwd = b.path; generation++;
    git(repo, 'worktree', 'remove', b.path);
    const deleted = await manager.list({ project: repo });
    await check('外部删除 → missing，epoch 失效，当前执行线关闭', () => {
      const row = deleted.items.find(w => w.id === b.id); assert.equal(row.health, 'missing'); assert.notEqual(row.epoch, b.epoch); assert.equal(missing, 1); assert.equal(cwd, null);
    });
    await check('missing open 不退回 main', () => rejected(() => manager.open(identity(b)), 'stale_workspace'));
    manager.dispose(); manager = createWorktrees(options);
    await check('app restart 重新发现 missing，保留 branch 与 manifest', async () => {
      const row = (await manager.list({ project: repo })).items.find(w => w.id === b.id); assert.equal(row.health, 'missing'); assert.ok(git(repo, 'rev-parse', b.branch));
    });
    const nonGit = path.join(fixture, 'non-git'); fs.mkdirSync(nonGit);
    const other = createWorktrees({ ...options, getProjects: () => [{ path: nonGit }] });
    await check('非 Git 项目明确拒绝，不 git init', async () => { await rejected(() => other.prepare({ project: nonGit }), 'not_git'); assert.equal(fs.existsSync(path.join(nonGit, '.git')), false); }); other.dispose();
    const branchPlan = await manager.prepare({ project: repo, branch: 'pi-gui/race' }); git(repo, 'branch', 'pi-gui/race');
    await check('确认后 branch 竞态再次检查', () => rejected(() => manager.create({ nonce: branchPlan.nonce }), 'branch_conflict'));
    const concurrent = await manager.prepare({ project: repo }); const results = await Promise.allSettled([manager.create({ nonce: concurrent.nonce }), manager.create({ nonce: concurrent.nonce })]);
    await check('重复并发 create 只创建一个工作区', () => assert.equal(results.filter(r => r.status === 'fulfilled').length, 1));
    await check('显式旧 generation 在队列执行前被拒绝', () => rejected(() => manager.prepare({ project: repo }, generation - 1), 'stale_workspace'));
    const changedPlan = await manager.prepare({ project: repo }); fs.writeFileSync(path.join(repo, 'changed.txt'), 'new');
    await check('确认后主区 dirty 变化拒绝创建', () => rejected(() => manager.create({ nonce: changedPlan.nonce }), 'confirmation_changed'));
    fs.unlinkSync(path.join(repo, 'changed.txt'));
    const junction = (await create()).workspace;
    git(repo, 'worktree', 'remove', junction.path);
    fs.symlinkSync(repo, junction.path, process.platform === 'win32' ? 'junction' : 'dir');
    await check('同路径换成 junction/symlink 不接受为 owned worktree', async () => {
      const rows = await manager.list({ project: repo }); const row = rows.items.find(w => w.id === junction.id);
      assert.equal(row.health, 'unavailable'); await rejected(() => manager.open(identity(row)), 'workspace_unavailable');
      assert.equal(fs.readFileSync(path.join(repo, 'dirty.txt'), 'utf8'), 'main marker');
    });
    fs.unlinkSync(junction.path);
    await check('未知 managed root 路径不能直接激活绕过登记', () => rejected(() => manager.withActivation(path.join(data, 'worktrees', 'unknown'), () => ({ ok: true })), 'unknown_workspace'));
    const brokenData = path.join(fixture, 'broken-data'); fs.mkdirSync(brokenData); fs.writeFileSync(path.join(brokenData, 'worktrees.json'), '{broken');
    const broken = createWorktrees({ ...options, dataDir: brokenData });
    await check('损坏 manifest 保守拒绝，原文件不覆盖', async () => { await rejected(() => broken.prepare({ project: repo }), 'metadata_invalid'); assert.equal(fs.readFileSync(path.join(brokenData, 'worktrees.json'), 'utf8'), '{broken'); }); broken.dispose();
    const nested = (await create()).workspace; git(path.join(nested.path, 'src'), 'init');
    await check('已跟踪目录内嵌套 Git 仓库也拒绝删除', async () => { await rejected(() => manager.remove(identity(nested)), 'submodule_present'); assert.ok(fs.existsSync(path.join(nested.path, 'src/.git'))); });
    const alias = path.join(fixture, 'worktree-alias'); fs.symlinkSync(nested.path, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await check('junction alias 不绕过受控 activation', () => rejected(() => manager.withActivation(alias, () => ({ ok: true })), 'unsafe_path'));
    cwd = alias; generation++;
    await check('current alias 仍识别 in-use，不误删正在使用目录', () => rejected(() => manager.remove(identity(nested)), 'workspace_in_use'));
    cwd = repo; generation++; fs.unlinkSync(alias);
    const outside = path.join(fixture, 'outside'); fs.mkdirSync(outside);
    const escape = path.join(nested.path, 'escape'); fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
    await check('worktree 内部 junction 不能逃逸实际 cwd', () => rejected(() => manager.withActivation(escape, () => ({ ok: true })), 'unsafe_path'));
    cwd = escape; generation++;
    await check('恢复/当前 cwd 逃逸会撤销执行上下文', async () => { await rejected(() => manager.validateCurrent(), 'unsafe_path'); assert.equal(cwd, null); });
    cwd = repo; generation++; fs.unlinkSync(escape);
    manager.dispose(); let invalidateDuringLookup = false;
    manager = createWorktrees({ ...options, getProjects: () => { if (invalidateDuringLookup) { invalidateDuringLookup = false; generation++; } return options.getProjects(); } });
    const racing = await manager.prepare({ project: repo }); invalidateDuringLookup = true;
    await check('异步校验期间 generation 改变也不创建', async () => { await rejected(() => manager.create({ nonce: racing.nonce }), 'stale_workspace'); assert.equal(fs.existsSync(path.join(data, 'worktrees', racing.plan.repoId, racing.plan.id)), false); });
    const externalPath = path.join(fixture, 'external-worktree'); git(repo, 'worktree', 'add', '-b', 'external-fixture', externalPath, 'HEAD');
    const external = (await manager.list({ project: repo })).items.find(w => w.kind === 'external' && w.branch === 'external-fixture');
    await check('外部 worktree 只读发现，不自动认领', () => { assert.ok(external); assert.equal(external.path, undefined); assert.equal(external.current, false); });
    await check('外部 worktree id 不能成为移除控制目标', () => rejected(() => manager.remove({ id: external.id, epoch: 'unknown' }), 'unknown_workspace'));
    const hooks = path.join(fixture, 'hooks'); fs.mkdirSync(hooks); const marker = path.join(fixture, 'hook-ran');
    fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\nprintf ran > '${marker.replace(/\\/g, '/')}'\n`, { mode: 0o755 }); git(repo, 'config', 'core.hooksPath', hooks);
    const hooked = (await create()).workspace;
    await check('受控 Git add 不执行 repository post-checkout hook', () => { assert.ok(fs.existsSync(hooked.path)); assert.equal(fs.existsSync(marker), false); });
    git(repo, 'config', '--unset', 'core.hooksPath');
    const insideData = path.join(repo, 'inside-data'); fs.mkdirSync(insideData);
    const inside = createWorktrees({ ...options, dataDir: insideData });
    await check('managed storage 不能放在仓库内污染 main Git 状态', async () => { await rejected(() => inside.prepare({ project: repo }), 'storage_inside_project'); assert.equal(fs.existsSync(path.join(insideData, 'worktrees')), false); }); inside.dispose();
    console.log(`Worktree lifecycle: ${count}/${count} passed (${process.platform}, real Git fixtures)`);
  } finally { manager.dispose(); fs.rmSync(fixture, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
