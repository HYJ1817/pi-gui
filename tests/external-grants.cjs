/* 工作区外文件授权账本的单元契约。
 *
 * 账本本身不碰 HTTP / UI：这里只验证授权范围、会话隔离、文件替换、
 * 符号链接逃逸、Windows 特殊路径形式、敏感目录、持久化与撤销失效。
 * 所有 fixture 都在 os.tmpdir()；**不访问任何真实敏感目录**。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log('  ok  ' + name);
}

/* 账本只接受 inspect 签发的一次性确认，测试也走同一条真实路径。 */
function createApproved(grants, { rawPath, scopeKind = 'file', persistent = false, scope }) {
  const inspected = grants.inspect({ rawPath, scopeKind, scope });
  assert.ok(inspected.approval, 'inspection should issue an approval');
  return grants.create({ approval: inspected.approval, scopeKind, persistent, scope });
}

const write = (root, rel, content) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

(async () => {
  const { createExternalGrants } = await import('../server/external-grants.js');
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-external-grants-'));
  const project = path.join(world, 'project');
  const outside = path.join(world, 'outside');
  const fileArea = path.join(world, 'file-area');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(fileArea, { recursive: true });
  write(outside, '报告 v1.md', '# report\n');
  write(outside, 'nested/日志.txt', 'log\n');
  write(outside, 'sibling.txt', 'sibling\n');
  write(fileArea, 'sibling.txt', 'file area sibling\n');
  write(fileArea, 'replaced.txt', 'old\n');
  write(outside, 'link-target/secret.txt', 'target secret\n');
  write(world, 'elsewhere/secret.txt', 'outside the grant\n');
  fs.symlinkSync(path.join(world, 'elsewhere'), path.join(outside, 'escape-link'), 'junction');
  write(world, 'fakehome/.ssh/config', 'Host *\n');

  const conversationA = { root: project, conversationId: '11111111-2222-3333-4444-555555555555' };
  const conversationB = { root: project, conversationId: '99999999-8888-7777-6666-555555555555' };
  const fakeEnv = { HOME: path.join(world, 'fakehome'), USERPROFILE: path.join(world, 'fakehome') };
  const grants = createExternalGrants({ env: fakeEnv, platform: 'linux' });
  const report = path.join(outside, '报告 v1.md');

  try {
    await check('inspect canonicalizes spaces and Chinese characters without creating a grant', async () => {
      const state = grants.inspect({ rawPath: report, scopeKind: 'file', scope: conversationA });
      assert.equal(state.ok, true);
      assert.equal(state.kind, 'file');
      assert.equal(fs.realpathSync.native(state.target).toLowerCase(), fs.realpathSync.native(report).toLowerCase());
      assert.equal(state.existing, null);
      assert.deepEqual(grants.list(conversationA).grants, []);
    });

    await check('a file grant covers exactly one file and rejects a sibling and another conversation', async () => {
      const created = createApproved(grants, { rawPath: report, scopeKind: 'file', scope: conversationA });
      assert.match(created.grant.id, /^[a-f0-9]{32}$/);
      assert.equal(created.grant.kind, 'file');
      assert.equal(created.grant.scope, 'session');
      const state = grants.authorizeRead({ grantId: created.grant.id, rawPath: report, scope: conversationA });
      assert.equal(fs.realpathSync.native(state.real).toLowerCase(), fs.realpathSync.native(report).toLowerCase());
      for (const outsidePath of [
        path.join(outside, 'sibling.txt'),
        path.join(outside, 'not-created.txt'),
        path.join(world, 'elsewhere/secret.txt'),
      ]) {
        assert.throws(
          () => grants.authorizeRead({ grantId: created.grant.id, rawPath: outsidePath, scope: conversationA }),
          (error) => error.code === 'grant_scope',
          outsidePath,
        );
      }
      assert.throws(
        () => grants.authorizeRead({ grantId: created.grant.id, rawPath: report, scope: conversationB }),
        (error) => error.code === 'grant_invalid',
      );
      assert.deepEqual(grants.list(conversationB).grants, []);
    });

    await check('a directory grant covers nested files but not a sibling directory or a junction escape', async () => {
      const directory = createApproved(grants, { rawPath: outside, scopeKind: 'directory', scope: conversationA });
      assert.equal(directory.grant.kind, 'directory');
      const nested = grants.authorizeRead({
        grantId: directory.grant.id,
        rawPath: path.join(outside, 'nested/日志.txt'),
        scope: conversationA,
      });
      assert.ok(nested.stat.isFile());
      for (const outsidePath of [
        path.join(outside, 'escape-link/secret.txt'),
        path.join(world, 'elsewhere/secret.txt'),
        path.join(world, 'elsewhere/missing.txt'),
      ]) {
        assert.throws(
          () => grants.authorizeRead({
            grantId: directory.grant.id,
            rawPath: outsidePath,
            scope: conversationA,
          }),
          (error) => error.code === 'grant_scope',
          outsidePath,
        );
      }
      if (process.platform !== 'win32') {
        /* POSIX 上反斜杠是合法文件名字符；与授权目录同级的 `outside\evil`
         * 不能被 normalizeForCompare 误当成 outside 的子目录。 */
        const sibling = path.join(world, 'outside\\evil');
        write(sibling, 'secret.txt', 'backslash sibling\n');
        assert.throws(
          () => grants.authorizeRead({
            grantId: directory.grant.id,
            rawPath: path.join(sibling, 'secret.txt'),
            scope: conversationA,
          }),
          (error) => error.code === 'grant_scope',
        );
      }
    });

    await check('a replaced file invalidates its grant and inspect no longer reports it', async () => {
      const replaced = path.join(fileArea, 'replaced.txt');
      const created = createApproved(grants, { rawPath: replaced, scopeKind: 'file', scope: conversationA });
      assert.equal(created.grant.kind, 'file');
      fs.unlinkSync(replaced);
      fs.writeFileSync(replaced, 'new content with a different inode\n');
      assert.throws(
        () => grants.authorizeRead({ grantId: created.grant.id, rawPath: replaced, scope: conversationA }),
        (error) => error.code === 'file_changed',
      );
      const inspected = grants.inspect({ rawPath: replaced, scopeKind: 'file', scope: conversationA });
      assert.equal(inspected.existing, null);
    });

    /* POSIX 回归锁（安全复审 C3）：把文件原地改写后再用 utimes 把 mtime 拨回，
     * dev/ino/size/mtime 全等，但 ctime（inode change time，不可回拨）已变 ——
     * 文件身份必须仍判不同。Windows 上 ctime≈birthtime，同样覆盖。 */
    await check('an in-place rewrite with mtime rolled back is still caught by ctime', async () => {
      const victim = path.join(fileArea, 'ctime-rollback.txt');
      fs.writeFileSync(victim, 'original content A\n');
      const created = createApproved(grants, { rawPath: victim, scopeKind: 'file', scope: conversationA });
      const statBefore = fs.lstatSync(victim);
      /* 原地改写（保持 size 一致最严苛：连 size 都不变时只剩 ctime 能抓到）。
       * 用秒级浮点 utimes 保留亚毫秒精度，真正只留下 ctime 差异。 */
      fs.writeFileSync(victim, 'replaced content B\n');
      fs.utimesSync(victim, statBefore.atimeMs / 1000, statBefore.mtimeMs / 1000);
      const statAfter = fs.lstatSync(victim);
      assert.equal(statAfter.size, statBefore.size, 'fixture should keep size identical');
      /* NTFS 时间戳粒度 ~0.5µs，回写后 mtime 不会位级相等但仍在回拨窗口内；
       * 关键是 ctime 已前进 —— 而 ctime 用户不可回拨，必须仍判 file_changed。 */
      assert.ok(Math.abs(statAfter.mtimeMs - statBefore.mtimeMs) < 2,
        `mtime should be rolled back close to original: ${statAfter.mtimeMs} vs ${statBefore.mtimeMs}`);
      assert.throws(
        () => grants.authorizeRead({ grantId: created.grant.id, rawPath: victim, scope: conversationA }),
        (error) => error.code === 'file_changed',
      );
    });

    await check('an approval is single-use and rejects a file replaced while the dialog was open', async () => {
      const victim = path.join(fileArea, 'approval.txt');
      fs.writeFileSync(victim, 'before\n');
      const inspected = grants.inspect({ rawPath: victim, scopeKind: 'file', scope: conversationA });
      assert.ok(inspected.approval);
      fs.unlinkSync(victim);
      fs.writeFileSync(victim, 'replaced while dialog open\n');
      assert.throws(
        () => grants.create({ approval: inspected.approval, scopeKind: 'file', scope: conversationA }),
        (error) => error.code === 'approval_stale',
      );
      const second = grants.inspect({ rawPath: victim, scopeKind: 'file', scope: conversationA });
      const created = grants.create({ approval: second.approval, scopeKind: 'file', scope: conversationA });
      assert.equal(created.ok, true);
      assert.throws(
        () => grants.create({ approval: second.approval, scopeKind: 'file', scope: conversationA }),
        (error) => error.code === 'approval_stale',
      );
    });

    await check('a workspace change or directory replacement invalidates the approval', async () => {
      const file = path.join(fileArea, 'workspace-bound.txt');
      fs.writeFileSync(file, 'bound\n');
      const scoped = { ...conversationA, scopeId: 'workspace-a', generation: '1' };
      const inspected = grants.inspect({ rawPath: file, scopeKind: 'file', scope: scoped });
      assert.throws(
        () => grants.create({ approval: inspected.approval, scopeKind: 'file',
          scope: { ...scoped, generation: '2' } }),
        (error) => error.code === 'approval_stale',
      );

      const folder = path.join(world, 'approval-folder');
      fs.mkdirSync(folder);
      const folderInspect = grants.inspect({ rawPath: folder, scopeKind: 'directory', scope: conversationA });
      fs.renameSync(folder, folder + '-old');
      fs.mkdirSync(folder);
      assert.throws(
        () => grants.create({ approval: folderInspect.approval, scopeKind: 'directory', scope: conversationA }),
        (error) => error.code === 'approval_stale',
      );
    });

    await check('choosing the containing folder uses the folder inspected at dialog time', async () => {
      const folder = path.join(world, 'approval-parent');
      const file = path.join(folder, 'note.md');
      write(folder, 'note.md', '# note\n');
      const inspected = grants.inspect({ rawPath: file, scopeKind: 'file', scope: conversationA });
      const created = grants.create({ approval: inspected.approval, scopeKind: 'directory', scope: conversationA });
      assert.equal(created.grant.kind, 'directory');
      assert.equal(created.grant.target, fs.realpathSync.native(folder));
      fs.rmSync(folder, { recursive: true, force: true });
      assert.equal(grants.list(conversationA).grants.some((grant) => grant.id === created.grant.id), true);
    });

    await check('revoking a grant invalidates in-flight read state and removes it from the list', async () => {
      const target = path.join(fileArea, 'sibling.txt');
      const created = createApproved(grants, { rawPath: target, scopeKind: 'file', scope: conversationA });
      assert.equal(created.grant.kind, 'file');
      const state = grants.authorizeRead({
        grantId: created.grant.id,
        rawPath: target,
        scope: conversationA,
      });
      assert.doesNotThrow(() => grants.assertStillValid(state));
      const revoked = grants.revoke({ id: created.grant.id, scope: conversationA });
      assert.equal(revoked.ok, true);
      assert.throws(() => grants.assertStillValid(state), (error) => error.code === 'grant_changed');
      assert.throws(
        () => grants.authorizeRead({
          grantId: created.grant.id,
          rawPath: target,
          scope: conversationA,
        }),
        (error) => error.code === 'grant_invalid',
      );
      assert.throws(
        () => grants.revoke({ id: created.grant.id, scope: conversationB }),
        (error) => error.code === 'grant_missing',
      );
    });

    await check('only directory grants may be persistent', async () => {
      assert.throws(
        () => createApproved(grants, { rawPath: path.join(fileArea, 'sibling.txt'), scopeKind: 'file', persistent: true, scope: conversationA }),
        (error) => error.code === 'persistent_requires_directory',
      );
    });

    await check('a persistent directory grant is restored from the main-owned settings record', async () => {
      const directory = fileArea;
      const created = createApproved(grants, { rawPath: directory, scopeKind: 'directory', persistent: true, scope: conversationA });
      assert.equal(created.grant.scope, 'persistent');
      const saved = created.persistent.find((grant) => grant.id === created.grant.id);
      assert.ok(saved, 'persistent grants must be returned for the main process to save');
      assert.equal(saved.conversationKey, grants.conversationKeyOf(conversationA));
      const restored = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      const result = restored.restore([saved]);
      assert.equal(result.restored, 1);
      const listed = restored.list(conversationA).grants.find((grant) => grant.id === created.grant.id);
      assert.ok(listed, 'persistent grant must survive restart');
      assert.equal(listed.scope, 'persistent');
      const state = restored.authorizeRead({
        grantId: created.grant.id,
        rawPath: path.join(directory, 'sibling.txt'),
        scope: conversationA,
      });
      assert.ok(state.stat.isFile());
      assert.equal(restored.list(conversationB).grants.some((grant) => grant.id === created.grant.id), false);
    });

    await check('a persistent grant can be revoked after restart and stays revoked', async () => {
      const first = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      const created = createApproved(first, { rawPath: path.join(outside, 'nested'), scopeKind: 'directory', persistent: true, scope: conversationA });
      const restored = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      restored.restore(created.persistent);
      const persistent = restored.list(conversationA).grants.find((grant) => grant.id === created.grant.id);
      assert.ok(persistent);
      const afterRevoke = restored.revoke({ id: persistent.id, scope: conversationA });
      assert.equal(afterRevoke.persistent.some((grant) => grant.id === persistent.id), false);
      const again = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      again.restore(afterRevoke.persistent);
      assert.equal(again.list(conversationA).grants.some((grant) => grant.id === persistent.id), false);
    });

    await check('sensitive credential directories are never eligible for authorization', async () => {
      const ssh = path.join(world, 'fakehome/.ssh/config');
      assert.throws(
        () => grants.inspect({ rawPath: ssh, scopeKind: 'file', scope: conversationA }),
        (error) => error.code === 'sensitive_path',
      );
      assert.throws(
        () => createApproved(grants, { rawPath: ssh, scopeKind: 'file', scope: conversationA }),
        (error) => error.code === 'sensitive_path',
      );
    });

    await check('the home directory itself is too broad to authorize as a directory', async () => {
      assert.throws(
        () => createApproved(grants, { rawPath: path.join(world, 'fakehome'), scopeKind: 'directory', scope: conversationA }),
        (error) => error.code === 'scope_too_broad',
      );
    });

    await check('a directory that contains a protected subtree cannot be authorized as a whole', async () => {
      const chromeProfile = path.join(world, 'fakehome/AppData/Local/Google/Chrome/User Data');
      fs.mkdirSync(chromeProfile, { recursive: true });
      const windowsLedger = createExternalGrants({ env: fakeEnv, platform: 'win32' });
      assert.throws(
        () => windowsLedger.inspect({
          rawPath: path.join(world, 'fakehome/AppData/Local'),
          scopeKind: 'directory',
          scope: conversationA,
        }),
        (error) => error.code === 'sensitive_path',
      );
      const agentRoot = path.join(world, 'pi-agent');
      fs.mkdirSync(agentRoot, { recursive: true });
      fs.writeFileSync(path.join(agentRoot, 'auth.json'), '{}\n');
      const protectedLedger = createExternalGrants({ env: fakeEnv, platform: 'linux', protectedRoots: [agentRoot] });
      assert.throws(
        () => protectedLedger.inspect({
          rawPath: path.join(agentRoot, 'auth.json'),
          scopeKind: 'file',
          scope: conversationA,
        }),
        (error) => error.code === 'sensitive_path',
      );
    });

    await check('UNC, device namespaces, reserved names, ADS and relative paths are rejected', async () => {
      for (const bad of [
        '\\\\server\\share\\x.txt',
        '//server/share/x.txt',
        '\\\\?\\C:\\temp\\x.txt',
        '\\\\.\\pipe\\x',
        'relative/path.txt',
        'C:\\temp\\con.txt',
        'C:\\temp\\a:b.txt',
        'C:\\temp\\trailing.',
        'C:\\temp\\trailing ',
        'C:\\temp\\..\\x.txt',
      ]) {
        assert.throws(
          () => grants.inspect({ rawPath: bad, scopeKind: 'file', scope: conversationA }),
          (error) => error.code === 'invalid_path',
          bad,
        );
      }
      assert.throws(
        () => grants.authorizeRead({ grantId: 'a'.repeat(32), rawPath: 'relative.txt', scope: conversationA }),
        (error) => error.code === 'grant_invalid' || error.code === 'invalid_path',
      );
    });

    await check('an invalid grant id is a request error, not a lookup miss', async () => {
      assert.throws(
        () => grants.authorizeRead({ grantId: 'not-a-grant', rawPath: report, scope: conversationA }),
        (error) => error.code === 'grant_required',
      );
      assert.throws(
        () => grants.revoke({ id: 'not-a-grant', scope: conversationA }),
        (error) => error.code === 'invalid_request',
      );
    });

    await check('grant creation evicts the oldest session grant at the cap instead of growing forever', async () => {
      const ledger = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      let firstId = '';
      for (let i = 0; i < 64; i++) {
        const file = path.join(world, `cap-${i}.txt`);
        fs.writeFileSync(file, 'x');
        const created = createApproved(ledger, { rawPath: file, scopeKind: 'file', scope: conversationA });
        if (i === 0) firstId = created.grant.id;
      }
      assert.equal(ledger.list(conversationA).grants.length, 64);
      const extra = path.join(world, 'cap-extra.txt');
      fs.writeFileSync(extra, 'x');
      createApproved(ledger, { rawPath: extra, scopeKind: 'file', scope: conversationA });
      const ids = ledger.list(conversationA).grants.map((grant) => grant.id);
      assert.equal(ids.length, 64);
      assert.equal(ids.includes(firstId), false);
    });

    await check('restore accepts only well-formed, still-safe persistent directory grants', async () => {
      const ledger = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      const key = ledger.conversationKeyOf(conversationA);
      const stat = fs.lstatSync(path.join(outside, 'nested'));
      const good = {
        id: 'a'.repeat(32),
        conversationKey: key,
        kind: 'directory',
        scope: 'persistent',
        target: path.join(outside, 'nested'),
        dirIdentity: {
          dev: String(stat.dev),
          ino: String(stat.ino),
          birthtimeMs: stat.birthtimeMs,
        },
        createdAt: new Date(0).toISOString(),
      };
      fs.mkdirSync(path.join(world, 'fakehome/.ssh/keys'), { recursive: true });
      const result = ledger.restore([
        good,
        { ...good }, // duplicate id
        { ...good, id: 'b'.repeat(32), kind: 'file' },
        { ...good, id: 'c'.repeat(32), scope: 'session' },
        { ...good, id: 'not-a-grant' },
        { ...good, id: 'd'.repeat(32), conversationKey: 'conversation:not-a-uuid' },
        { ...good, id: 'e'.repeat(32), target: path.join(fileArea, 'sibling.txt') },
        { ...good, id: 'f'.repeat(32), target: path.join(outside, 'escape-link') },
        { ...good, id: '1'.repeat(32), target: path.join(world, 'fakehome/.ssh/keys') },
        { ...good, id: '2'.repeat(32), target: path.join(world, 'fakehome') },
        { ...good, id: '3'.repeat(32), target: path.join(world, 'missing-dir') },
      ]);
      assert.equal(result.restored, 1);
      assert.deepEqual(ledger.persistentGrants().map((grant) => grant.id), ['a'.repeat(32)]);
      assert.throws(() => ledger.restore({}), (error) => error.code === 'invalid_request');
    });

    /* 目录对象身份：以下每条在旧实现（只比对路径字符串）里都会通过，
     * 在新实现（dev+ino+birthtime）里必须让授权失效或被拒绝恢复。 */
    await check('member churn keeps a directory grant alive while delete+recreate kills it', async () => {
      const dir = path.join(world, 'churn-dir');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
      const evicted = [];
      const ledger = createExternalGrants({ env: fakeEnv, platform: 'linux', onEvict: (grant) => evicted.push(grant.id) });
      const created = createApproved(ledger, { rawPath: dir, scopeKind: 'directory', scope: conversationA });
      const file = path.join(dir, 'note.md');
      fs.writeFileSync(file, '# n\n');
      /* 普通增删成员只动目录的 size/mtime/ctime，不动对象身份：授权必须仍然有效。 */
      fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
      fs.unlinkSync(path.join(dir, 'b.txt'));
      assert.doesNotThrow(() => ledger.authorizeRead({ grantId: created.grant.id, rawPath: file, scope: conversationA }));
      /* 删除后原地重建：路径字符串相同，但 dev/ino/birthtime 已是另一个对象。 */
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      fs.writeFileSync(file, '# n\n');
      assert.throws(
        () => ledger.authorizeRead({ grantId: created.grant.id, rawPath: file, scope: conversationA }),
        (error) => error.code === 'grant_changed' || error.code === 'file_missing',
      );
      assert.equal(ledger.list(conversationA).grants.some((grant) => grant.id === created.grant.id), false);
      assert.ok(evicted.includes(created.grant.id), 'eviction must notify listeners so tabs/caches close');
    });

    await check('a renamed-away imposter directory does not inherit the grant', async () => {
      const dir = path.join(world, 'imposter-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'keep.md'), 'k\n');
      const ledger = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      const created = createApproved(ledger, { rawPath: dir, scopeKind: 'directory', scope: conversationA });
      fs.renameSync(dir, dir + '-old');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'keep.md'), 'k\n');
      assert.throws(
        () => ledger.authorizeRead({ grantId: created.grant.id, rawPath: path.join(dir, 'keep.md'), scope: conversationA }),
        (error) => error.code === 'grant_changed',
      );
      assert.equal(ledger.list(conversationA).grants.length, 0);
      fs.rmSync(dir + '-old', { recursive: true, force: true });
    });

    await check('a directory swapped for a junction at the same path loses the grant', async () => {
      const real = path.join(world, 'junction-real');
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, 'inside.md'), 'i\n');
      const swap = path.join(world, 'junction-swap');
      fs.mkdirSync(swap);
      const ledger = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      const created = createApproved(ledger, { rawPath: swap, scopeKind: 'directory', scope: conversationA });
      fs.rmdirSync(swap);
      fs.symlinkSync(real, swap, 'junction');
      assert.throws(
        () => ledger.authorizeRead({ grantId: created.grant.id, rawPath: path.join(swap, 'inside.md'), scope: conversationA }),
        (error) => error.code === 'grant_changed' || error.code === 'unsafe_path',
      );
      fs.rmSync(swap, { force: true });
    });

    await check('restore drops records whose directory was replaced or never carried an identity', async () => {
      const dir = path.join(world, 'restore-dir');
      fs.mkdirSync(dir);
      const first = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      const created = createApproved(first, { rawPath: dir, scopeKind: 'directory', persistent: true, scope: conversationA });
      const saved = created.persistent.find((grant) => grant.id === created.grant.id);
      assert.ok(saved.dirIdentity, 'persistent record must carry dirIdentity');
      /* 同一目录对象：恢复成功。 */
      const ok = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      assert.equal(ok.restore([saved]).restored, 1);
      /* 目录被删除重建：同一路径不同对象，记录必须被丢弃。 */
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const replaced = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      const result = replaced.restore([saved]);
      assert.equal(result.restored, 0);
      assert.equal(result.persistent.length, 0);
      /* 旧版记录没有 dirIdentity：不能证明同一对象，同样丢弃，走重新授权。 */
      const legacy = { ...saved };
      delete legacy.dirIdentity;
      const legacyLedger = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      assert.equal(legacyLedger.restore([legacy]).restored, 0);
      /* 身份被篡改的记录也丢弃。 */
      const tampered = { ...saved, dirIdentity: { ...saved.dirIdentity, ino: '1' } };
      const tamperedLedger = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      assert.equal(tamperedLedger.restore([tampered]).restored, 0);
    });

    await check('a mid-read directory swap fails the still-valid check like a revoke', async () => {
      const dir = path.join(world, 'midread-dir');
      fs.mkdirSync(dir);
      const file = path.join(dir, 'data.txt');
      fs.writeFileSync(file, 'd\n');
      const evicted = [];
      const ledger = createExternalGrants({ env: fakeEnv, platform: 'linux', onEvict: (grant) => evicted.push(grant.id) });
      const created = createApproved(ledger, { rawPath: dir, scopeKind: 'directory', scope: conversationA });
      const state = ledger.authorizeRead({ grantId: created.grant.id, rawPath: file, scope: conversationA });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      fs.writeFileSync(file, 'd\n');
      assert.throws(() => ledger.assertStillValid(state), (error) => error.code === 'grant_changed');
      assert.ok(evicted.includes(created.grant.id));
    });

    await check('a second authorization for a replaced directory does not resurrect the old grant', async () => {
      const dir = path.join(world, 'reauth-dir');
      fs.mkdirSync(dir);
      const evicted = [];
      const ledger = createExternalGrants({ env: fakeEnv, platform: 'linux', onEvict: (grant) => evicted.push(grant.id) });
      const first = createApproved(ledger, { rawPath: dir, scopeKind: 'directory', scope: conversationA });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'new.md'), 'n\n');
      /* 用户在旧路径重新授权：旧对象必须逐出并通知，新授权绑定新对象。 */
      const second = createApproved(ledger, { rawPath: dir, scopeKind: 'directory', scope: conversationA });
      assert.notEqual(second.grant.id, first.grant.id);
      assert.ok(evicted.includes(first.grant.id));
      const listed = ledger.list(conversationA).grants;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, second.grant.id);
      assert.doesNotThrow(() => ledger.authorizeRead({
        grantId: second.grant.id, rawPath: path.join(dir, 'new.md'), scope: conversationA,
      }));
    });

    await check('classic sessions bind grants to the project root, not to every classic session', async () => {
      const ledger = createExternalGrants({ env: fakeEnv, platform: 'linux' });
      const classicA = { root: project };
      const classicB = { root: path.join(world, 'other-project') };
      fs.mkdirSync(classicB.root, { recursive: true });
      const created = createApproved(ledger, { rawPath: report, scopeKind: 'file', scope: classicA });
      assert.equal(ledger.conversationKeyOf(classicA).startsWith('classic:'), true);
      assert.throws(
        () => ledger.authorizeRead({ grantId: created.grant.id, rawPath: report, scope: classicB }),
        (error) => error.code === 'grant_invalid',
      );
    });
  } finally {
    fs.rmSync(world, { recursive: true, force: true });
  }

  console.log(`external-grants: ${checks} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
