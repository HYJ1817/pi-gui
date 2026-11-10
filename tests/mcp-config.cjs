/* MCP 配置受控写入的离线契约。
 *
 * 全部落在 os.tmpdir()：假的 agent 目录 + 假项目目录，不碰真实 mcp.json，
 * 不启动 pi、不联网。覆盖：校验 / 原子写 / 备份 / 冲突 / trust / 覆盖 /
 * secret keep 语义 / 批量导入回滚 / Pi 1.5 项目 override 解析。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const checkAsync = async (name, fn) => { await fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-mcpc-'));
const AGENT = path.join(TMP, 'agent');
const PROJECT = path.join(TMP, 'project');
fs.mkdirSync(AGENT, { recursive: true });
fs.mkdirSync(path.join(PROJECT, '.pi'), { recursive: true });
fs.mkdirSync(path.join(PROJECT, 'allowed'), { recursive: true });

const env = { HOME: TMP, USERPROFILE: TMP, PI_CODING_AGENT_DIR: AGENT, PATH: process.env.PATH || '' };
const userFile = path.join(AGENT, 'mcp.json');
const projectFile = path.join(PROJECT, '.pi', 'mcp.json');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const resetFiles = () => {
  for (const f of [userFile, projectFile]) {
    try { fs.rmSync(f, { force: true }); } catch { /* noop */ }
    try {
      for (const n of fs.readdirSync(path.dirname(f))) {
        if (n.startsWith(path.basename(f) + '.bak-')) fs.rmSync(path.join(path.dirname(f), n), { force: true });
      }
    } catch { /* noop */ }
  }
};

(async () => {
  const { createMcpConfigStore } = await import('../server/mcp-config.js');
  const { createMcpNative, parseMcpServers } = await import('../server/mcp-native.js');
  const state = { cwd: PROJECT, trust: { trusted: true, requiresTrust: false } };
  const runtime = { getCurrentCwd: () => state.cwd };
  const store = createMcpConfigStore({
    runtime,
    env,
    readTrust: async () => state.trust,
    now: () => 1700000000000,
  });

  section('A. 新建 / 编辑 / revision');
  await checkAsync('A·新建用户级 stdio（env 引用 + 非敏感字面值）', async () => {
    resetFiles();
    const r = await store.save({
      scope: 'user', name: 'memory', expectedRevision: '',
      transport: 'stdio', command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: [
        { key: 'API_TOKEN', value: '${MEMORY_TOKEN}' },
        { key: 'MEMORY_FILE_PATH', value: path.join(TMP, 'memory.json') },
      ],
      description: '记忆服务器', timeout: 45, exposure: 'deferred', enabled: true,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const data = read(userFile);
    assert.deepEqual(data.mcpServers.memory.args, ['-y', '@modelcontextprotocol/server-memory']);
    assert.equal(data.mcpServers.memory.env.API_TOKEN, '${MEMORY_TOKEN}');
    assert.equal(data.mcpServers.memory.env.MEMORY_FILE_PATH, path.join(TMP, 'memory.json'));
    assert.equal(data.mcpServers.memory.timeout, 45);
    assert.equal(data.mcpServers.memory.exposure, 'deferred');
    assert.equal(r.revision.length, 64);
    assert.ok(fs.readFileSync(userFile, 'utf8').endsWith('\n'));
  });

  await checkAsync('A·编辑时保留缩进、旧文件备份、revision 变化', async () => {
    fs.writeFileSync(userFile, JSON.stringify({ mcpServers: { memory: { command: 'npx', args: ['-y', 'x'] } } }, null, 4) + '\n');
    const rev = fs.readFileSync(userFile, 'utf8');
    const { createHash } = require('node:crypto');
    const hash = createHash('sha256').update(rev).digest('hex');
    const r = await store.save({
      scope: 'user', name: 'memory', originalName: 'memory', expectedRevision: hash,
      transport: 'stdio', command: 'npx', args: ['-y', 'y'],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const text = fs.readFileSync(userFile, 'utf8');
    assert.ok(text.includes('\n    "mcpServers"'), '应沿用 4 空格缩进');
    assert.ok(r.backup && fs.existsSync(path.join(AGENT, r.backup)), '备份应存在于同目录');
  });

  await checkAsync('A·陈旧 revision 被拒，文件不变', async () => {
    const before = fs.readFileSync(userFile, 'utf8');
    const r = await store.save({ scope: 'user', name: 'memory', expectedRevision: 'deadbeef', transport: 'stdio', command: 'npx' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'stale-config');
    assert.equal(fs.readFileSync(userFile, 'utf8'), before);
  });

  section('B. 校验与 secret 边界');
  await checkAsync('B·明文 Authorization 被拒', async () => {
    const before = fs.readFileSync(userFile, 'utf8');
    const r = await store.save({
      scope: 'user', name: 'docs', expectedRevision: store.revisions().user,
      transport: 'http', url: 'https://example.com/mcp',
      headers: [{ key: 'Authorization', value: 'Bearer sk-live-123' }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'secret-value-unsupported');
    assert.equal(fs.readFileSync(userFile, 'utf8'), before);
  });

  await checkAsync('B·header 引用与普通 header 可写入', async () => {
    const r = await store.save({
      scope: 'user', name: 'docs', expectedRevision: store.revisions().user,
      transport: 'http', url: 'https://example.com/mcp',
      headers: [
        { key: 'Authorization', value: 'Bearer ${DOCS_TOKEN}' },
        { key: 'X-Client', value: 'pi-gui' },
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const data = read(userFile);
    assert.equal(data.mcpServers.docs.headers.Authorization, 'Bearer ${DOCS_TOKEN}');
    assert.equal(data.mcpServers.docs.headers['X-Client'], 'pi-gui');
  });

  await checkAsync('B·URL 里的凭据查询串被拒', async () => {
    const r = await store.save({
      scope: 'user', name: 'q', expectedRevision: store.revisions().user,
      transport: 'http', url: 'https://example.com/mcp?token=abc',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad-url');
  });

  await checkAsync('B·旧明文值读详情不回显，但 keep 能原样保留', async () => {
    const data = read(userFile);
    data.mcpServers.docs.headers.Authorization = 'Bearer literal-secret';
    write(userFile, data);
    const detail = await store.getDetail({ scope: 'user', name: 'docs' });
    assert.equal(detail.ok, true);
    const auth = detail.entry.headers.find((h) => h.key === 'Authorization');
    assert.equal(auth.value, null);
    assert.equal(auth.secret, true);
    const rev = detail.revision;
    const saved = await store.save({
      scope: 'user', name: 'docs', originalName: 'docs', expectedRevision: rev,
      transport: 'http', url: detail.entry.url,
      headers: [
        { key: 'Authorization', keep: true },
        { key: 'X-Client', value: 'pi-gui' },
      ],
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(read(userFile).mcpServers.docs.headers.Authorization, 'Bearer literal-secret');
  });

  section('C. 冲突 / 命名空间 / 损坏文件');
  await checkAsync('C·同名覆盖需要 allowReplace', async () => {
    const r = await store.save({
      scope: 'user', name: 'memory', expectedRevision: store.revisions().user,
      transport: 'stdio', command: 'npx', args: ['-y', 'other'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'name-conflict');
    assert.equal(r.canReplace, true);
  });

  await checkAsync('C·namespace 冲突（- / _）被拒', async () => {
    const first = await store.save({
      scope: 'user', name: 'alpha-beta', expectedRevision: store.revisions().user,
      transport: 'stdio', command: 'npx',
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    const r = await store.save({
      scope: 'user', name: 'alpha_beta', expectedRevision: store.revisions().user,
      transport: 'stdio', command: 'npx',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'config-conflict');
  });

  await checkAsync('C·损坏 JSON 拒绝写入且不覆盖', async () => {
    fs.writeFileSync(userFile, '{ bad json', 'utf8');
    const r = await store.save({ scope: 'user', name: 'x', expectedRevision: '', transport: 'stdio', command: 'npx' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'config-corrupt');
    assert.equal(fs.readFileSync(userFile, 'utf8'), '{ bad json');
  });

  section('D. 项目 trust / override');
  resetFiles();
  await checkAsync('D·项目未信任（false）拒绝写', async () => {
    state.trust = { trusted: false, requiresTrust: true };
    const r = await store.save({ scope: 'project', name: 'p', expectedRevision: '', transport: 'stdio', command: 'npx' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'project-untrusted');
    assert.equal(fs.existsSync(projectFile), false);
  });

  await checkAsync('D·trust 未知（null）同样 fail closed', async () => {
    state.trust = { trusted: null, requiresTrust: null };
    const r = await store.save({ scope: 'project', name: 'p', expectedRevision: '', transport: 'stdio', command: 'npx' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'trust-unknown');
  });

  await checkAsync('D·项目级可写 + 同全局名需确认 override', async () => {
    state.trust = { trusted: true, requiresTrust: false };
    const u = await store.save({ scope: 'user', name: 'shared', expectedRevision: store.revisions().user, transport: 'stdio', command: 'npx' });
    assert.equal(u.ok, true);
    const warn = await store.save({ scope: 'project', name: 'shared', expectedRevision: '', transport: 'stdio', command: 'uvx' });
    assert.equal(warn.ok, false);
    assert.equal(warn.code, 'scope-conflict');
    assert.equal(warn.canOverride, true);
    const ok = await store.save({ scope: 'project', name: 'shared', expectedRevision: '', transport: 'stdio', command: 'uvx', confirmOverride: true });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(read(projectFile).mcpServers.shared.command, 'uvx');
  });

  await checkAsync('D·项目 setEnabled 创建 override，不复制凭据', async () => {
    const u = read(userFile);
    u.mcpServers.shared.env = { TOKEN: '${SHARED_TOKEN}' };
    write(userFile, u);
    const before = read(projectFile).mcpServers.shared;
    assert.equal(before.command, 'uvx');
    // 先删掉完整项目条目，模拟“只有用户级 server”的场景
    const clean = read(projectFile);
    delete clean.mcpServers.shared;
    write(projectFile, clean);
    const r = await store.setEnabled({ scope: 'project', name: 'shared', enabled: false, expectedRevision: store.revisions().project });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.createdOverride, true);
    assert.deepEqual(read(projectFile).mcpServers.shared, { enabled: false });
  });

  await checkAsync('D·项目 override 无需复制凭据即可重新启用', async () => {
    const r = await store.setEnabled({ scope: 'project', name: 'shared', enabled: true, expectedRevision: store.revisions().project });
    assert.equal(r.ok, true);
    assert.equal(read(projectFile).mcpServers.shared.enabled, true);
    assert.equal(read(projectFile).mcpServers.shared.command, undefined);
  });

  await checkAsync('D·项目 override 删除后用户级恢复', async () => {
    const r = await store.remove({ scope: 'project', name: 'shared', expectedRevision: store.revisions().project });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(read(projectFile).mcpServers.shared, undefined);
    assert.equal(read(userFile).mcpServers.shared.command, 'npx');
  });

  section('E. 批量导入 / 备份上限');
  await checkAsync('E·一条非法则整批不写', async () => {
    const before = fs.readFileSync(userFile, 'utf8');
    const r = await store.importMany({
      scope: 'user', expectedRevision: store.revisions().user,
      entries: [
        { name: 'good-one', config: { transport: 'stdio', command: 'npx' } },
        { name: 'bad one', config: { transport: 'stdio', command: 'npx' } },
      ],
    });
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(userFile, 'utf8'), before);
  });

  await checkAsync('E·批量导入成功且一次写入', async () => {
    const r = await store.importMany({
      scope: 'user', expectedRevision: store.revisions().user,
      entries: [
        { name: 'import-a', config: { transport: 'stdio', command: 'npx', args: ['-y', 'a'] } },
        { name: 'import-b', config: { transport: 'http', url: 'https://example.com/b' } },
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.names.sort(), ['import-a', 'import-b']);
    assert.equal(read(userFile).mcpServers['import-a'].command, 'npx');
    assert.equal(read(userFile).mcpServers['import-b'].url, 'https://example.com/b');
  });

  await checkAsync('E·备份最多保留 5 份', async () => {
    for (let i = 0; i < 8; i += 1) {
      const r = await store.setEnabled({ scope: 'user', name: 'import-a', enabled: i % 2 === 0, expectedRevision: store.revisions().user });
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const backups = fs.readdirSync(AGENT).filter((n) => n.startsWith('mcp.json.bak-'));
    assert.ok(backups.length <= 5, `备份数 ${backups.length} 应 <= 5`);
  });

  section('F. Pi 1.5 项目 override 解析 / effective');
  check('F·override 条目被解析为 inherited，不是无效', () => {
    const r = parseMcpServers({ mcpServers: { docs: { enabled: false } } }, { scope: 'project', takenNames: ['docs'] });
    assert.equal(r.invalid.length, 0, JSON.stringify(r.invalid));
    assert.equal(r.servers.length, 1);
    assert.equal(r.servers[0].overrideOnly, true);
    assert.equal(r.servers[0].enabled, false);
    assert.equal(r.servers[0].transportType, 'inherited');
  });
  check('F·override 没有全局 base → 无效', () => {
    const r = parseMcpServers({ mcpServers: { ghost: { enabled: false } } }, { scope: 'project', takenNames: [] });
    assert.equal(r.servers.length, 0);
    assert.ok(r.invalid.some((m) => m.includes('global server to override')));
  });
  check('F·override 带额外键 → 无效（有 command 时它是完整条目，不是 override）', () => {
    const extra = parseMcpServers({ mcpServers: { docs: { enabled: false, description: 'x' } } }, { scope: 'project', takenNames: ['docs'] });
    assert.equal(extra.servers.length, 0);
    const full = parseMcpServers({ mcpServers: { docs: { enabled: false, command: 'x' } } }, { scope: 'project', takenNames: ['docs'] });
    assert.equal(full.servers.length, 1);
  });

  await checkAsync('F·summary 正确合并 override 的 enabled / transport / secrets', async () => {
    resetFiles();
    write(userFile, {
      mcpServers: {
        docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' }, enabled: false },
      },
    });
    write(projectFile, { mcpServers: { docs: { enabled: true } } });
    state.trust = { trusted: true, requiresTrust: false };
    const native = createMcpNative({
      runtime, env, readTrust: async () => state.trust,
      now: () => 1000, ttlMs: 60000,
    });
    const s = await native.summary();
    const user = s.servers.find((x) => x.scope === 'user');
    const proj = s.servers.find((x) => x.scope === 'project');
    assert.equal(user.overridden, true);
    assert.equal(user.effective.active, false);
    assert.equal(proj.overrideOnly, true);
    assert.equal(proj.enabled, true);
    assert.equal(proj.transportType, 'http');
    assert.equal(proj.hasSecrets, true);
    assert.equal(proj.effective.active, true);
  });

  section('G. 编辑保留上游字段');
  await checkAsync('G·编辑 HTTP 条目保留 oauth/auth/toolExposure/未知键与 type', async () => {
    resetFiles();
    state.trust = { trusted: true, requiresTrust: false };
    write(userFile, {
      mcpServers: {
        rich: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ${RICH_TOKEN}' },
          oauth: { clientId: 'fixture-client' },
          auth: { provider: 'fixture-provider' },
          toolExposure: { search: 'hidden' },
          description: '旧描述', timeout: 30, exposure: 'direct', enabled: false,
          futureKey: { nested: true },
        },
      },
    });
    const saved = await store.save({
      scope: 'user', name: 'rich', originalName: 'rich', expectedRevision: store.revisions().user,
      transport: 'http', url: 'https://example.com/mcp',
      headers: [
        { key: 'Authorization', keep: true },
        { key: 'X-Client', value: 'pi-gui' },
      ],
      description: '新描述', enabled: true,
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const entry = read(userFile).mcpServers.rich;
    assert.equal(entry.type, 'streamable-http');
    assert.deepEqual(entry.oauth, { clientId: 'fixture-client' });
    assert.deepEqual(entry.auth, { provider: 'fixture-provider' });
    assert.deepEqual(entry.toolExposure, { search: 'hidden' });
    assert.deepEqual(entry.futureKey, { nested: true });
    assert.equal(entry.description, '新描述');
    assert.equal(entry.timeout, 30);
    assert.equal(entry.exposure, 'direct');
    assert.equal(entry.headers.Authorization, 'Bearer ${RICH_TOKEN}');
    assert.equal(entry.headers['X-Client'], 'pi-gui');
  });

  await checkAsync('G·改名删除旧键并继续保留上游字段', async () => {
    const saved = await store.save({
      scope: 'user', name: 'rich-renamed', originalName: 'rich', expectedRevision: store.revisions().user,
      transport: 'http', url: 'https://example.com/mcp',
      headers: [{ key: 'Authorization', keep: true }],
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const table = read(userFile).mcpServers;
    assert.equal(table.rich, undefined);
    assert.deepEqual(table['rich-renamed'].oauth, { clientId: 'fixture-client' });
    assert.deepEqual(table['rich-renamed'].auth, { provider: 'fixture-provider' });
    assert.deepEqual(table['rich-renamed'].toolExposure, { search: 'hidden' });
  });

  await checkAsync('G·HTTP → stdio 丢弃仅属于 HTTP 的 oauth/auth，其余未知键仍保留', async () => {
    const saved = await store.save({
      scope: 'user', name: 'rich-renamed', originalName: 'rich-renamed', expectedRevision: store.revisions().user,
      transport: 'stdio', command: 'npx', args: ['-y', 'fixture'],
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const entry = read(userFile).mcpServers['rich-renamed'];
    assert.equal(entry.type, 'stdio');
    assert.equal(entry.oauth, undefined);
    assert.equal(entry.auth, undefined);
    assert.deepEqual(entry.futureKey, { nested: true });
    assert.equal(entry.command, 'npx');
  });

  await checkAsync('G·项目 override 改名删除旧覆盖键', async () => {
    resetFiles();
    write(userFile, { mcpServers: { shared: { command: 'npx' }, shared2: { command: 'uvx' } } });
    write(projectFile, { mcpServers: { shared: { enabled: false } } });
    const saved = await store.save({
      scope: 'project', name: 'shared2', originalName: 'shared', overrideOnly: true,
      enabled: true, expectedRevision: store.revisions().project,
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const table = read(projectFile).mcpServers;
    assert.equal(table.shared, undefined);
    assert.deepEqual(table.shared2, { enabled: true });
  });

  section('H. args 里的凭据');
  await checkAsync('H·含凭据的 args 不回填详情、不进入 renderer', async () => {
    resetFiles();
    write(userFile, {
      mcpServers: {
        secretargs: { command: 'npx', args: ['-y', 'pkg', '--token', 'literal-token-123'] },
      },
    });
    const detail = await store.getDetail({ scope: 'user', name: 'secretargs' });
    assert.equal(detail.ok, true, JSON.stringify(detail));
    assert.equal(detail.entry.argsProtected, true);
    assert.deepEqual(detail.entry.args, []);
    assert.equal(detail.entry.argsCount, 4);
    assert.ok(!JSON.stringify(detail).includes('literal-token-123'), '详情不应回显 args 凭据');
  });
  await checkAsync('H·编辑省略 args 时原样保留，不改写凭据', async () => {
    const saved = await store.save({
      scope: 'user', name: 'secretargs', originalName: 'secretargs',
      expectedRevision: store.revisions().user,
      transport: 'stdio', command: 'npx', description: '只改描述',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(read(userFile).mcpServers.secretargs.args, ['-y', 'pkg', '--token', 'literal-token-123']);
    assert.equal(read(userFile).mcpServers.secretargs.description, '只改描述');
  });
  await checkAsync('H·新 args 含明文凭据被拒，文件不变', async () => {
    const before = fs.readFileSync(userFile, 'utf8');
    const rejected = await store.save({
      scope: 'user', name: 'secretargs', originalName: 'secretargs',
      expectedRevision: store.revisions().user,
      transport: 'stdio', command: 'npx', args: ['--api-key=sk-live-123'],
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'secret-value-unsupported');
    assert.equal(fs.readFileSync(userFile, 'utf8'), before);
  });
  await checkAsync('H·显式提供安全 args 时可以替换旧参数', async () => {
    const saved = await store.save({
      scope: 'user', name: 'secretargs', originalName: 'secretargs',
      expectedRevision: store.revisions().user,
      transport: 'stdio', command: 'npx', args: ['-y', 'pkg'],
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(read(userFile).mcpServers.secretargs.args, ['-y', 'pkg']);
  });

  section('I. 复审回归：保留与边界');
  await checkAsync('I·编辑普通条目时保留 cwd', async () => {
    resetFiles();
    write(userFile, {
      mcpServers: { cwdtest: { command: 'npx', args: ['-y', 'x'], cwd: 'C:\\work' } },
    });
    const saved = await store.save({
      scope: 'user', name: 'cwdtest', originalName: 'cwdtest',
      expectedRevision: store.revisions().user,
      transport: 'stdio', command: 'npx', description: '只改描述',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(read(userFile).mcpServers.cwdtest.cwd, 'C:\\work');
    assert.equal(read(userFile).mcpServers.cwdtest.description, '只改描述');
  });

  await checkAsync('I·编辑项目 override 保留 exposure / toolExposure', async () => {
    resetFiles();
    write(userFile, { mcpServers: { foo: { command: 'npx' } } });
    write(projectFile, {
      mcpServers: { foo: { exposure: 'deferred', toolExposure: { search: 'hidden' }, enabled: false } },
    });
    const saved = await store.save({
      scope: 'project', name: 'foo', originalName: 'foo', overrideOnly: true,
      enabled: true, expectedRevision: store.revisions().project,
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const entry = read(projectFile).mcpServers.foo;
    assert.equal(entry.exposure, 'deferred');
    assert.deepEqual(entry.toolExposure, { search: 'hidden' });
    assert.equal(entry.enabled, true);
  });

  await checkAsync('I·项目 override 详情不泄露继承的 args 凭据', async () => {
    resetFiles();
    write(userFile, {
      mcpServers: { foo: { command: 'npx', args: ['--token', 'literal-token-123'] } },
    });
    write(projectFile, { mcpServers: { foo: { enabled: true } } });
    const detail = await store.getDetail({ scope: 'project', name: 'foo' });
    assert.equal(detail.ok, true, JSON.stringify(detail));
    assert.equal(detail.overrideOnly, true);
    assert.equal(detail.entry.inherited.argsProtected, true);
    assert.deepEqual(detail.entry.inherited.args, []);
    assert.equal(detail.entry.inherited.argsCount, 2);
    assert.ok(!JSON.stringify(detail).includes('literal-token-123'), 'override 详情不应回显继承的 args 凭据');
  });

  await checkAsync('I·URL 查询值像凭据时详情脱敏、保存拒绝', async () => {
    resetFiles();
    write(userFile, {
      mcpServers: { urlsecret: { type: 'http', url: 'https://example.com/mcp?sid=ghp_abcdefghijklmnop' } },
    });
    const detail = await store.getDetail({ scope: 'user', name: 'urlsecret' });
    assert.equal(detail.ok, true, JSON.stringify(detail));
    assert.equal(detail.entry.urlProtected, true);
    assert.equal(detail.entry.url, null);
    assert.equal(detail.entry.urlPreview, 'https://example.com');
    assert.ok(!JSON.stringify(detail).includes('ghp_abcdefghijklmnop'), '详情不应回显 URL 查询值');
    const before = fs.readFileSync(userFile, 'utf8');
    const rejected = await store.save({
      scope: 'user', name: 'urlsecret', originalName: 'urlsecret',
      expectedRevision: store.revisions().user,
      transport: 'http', url: 'https://example.com/mcp?sid=ghp_abcdefghijklmnop',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'bad-url');
    assert.equal(fs.readFileSync(userFile, 'utf8'), before);
  });

  await checkAsync('I·项目条目与全局 namespace 冲突时拒绝写入', async () => {
    resetFiles();
    write(userFile, { mcpServers: { 'alpha-beta': { command: 'npx' } } });
    const before = fs.existsSync(projectFile) ? fs.readFileSync(projectFile, 'utf8') : null;
    const rejected = await store.save({
      scope: 'project', name: 'alpha_beta', expectedRevision: store.revisions().project,
      transport: 'stdio', command: 'npx',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'config-conflict');
    assert.equal(fs.existsSync(projectFile) ? fs.readFileSync(projectFile, 'utf8') : null, before);
  });

  await checkAsync('I·缺少 expectedRevision 的写入被拒绝', async () => {
    resetFiles();
    write(userFile, { mcpServers: { guarded: { command: 'npx' } } });
    const before = fs.readFileSync(userFile, 'utf8');
    const rejected = await store.save({ scope: 'user', name: 'guarded', transport: 'stdio', command: 'npx' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'missing-revision');
    assert.equal(fs.readFileSync(userFile, 'utf8'), before);
  });

  /* junction 不需要管理员权限，正好覆盖“父目录是链接”的路径。
   * 没有创建权限的环境只打印 skip，不把平台差异当成产品失败。 */
  let linkedProject = null;
  let linkedOutside = null;
  try {
    linkedProject = fs.mkdtempSync(path.join(TMP, 'linked-project-'));
    linkedOutside = fs.mkdtempSync(path.join(TMP, 'linked-outside-'));
    fs.symlinkSync(linkedOutside, path.join(linkedProject, '.pi'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    linkedProject = null;
  }
  if (linkedProject) {
    await checkAsync('I·项目 .pi 是目录链接时拒绝写入链接目标', async () => {
      const previous = state.cwd;
      state.cwd = linkedProject;
      try {
        const rejected = await store.save({
          scope: 'project', name: 'linked', expectedRevision: '',
          transport: 'stdio', command: 'npx',
        });
        assert.equal(rejected.ok, false);
        assert.equal(rejected.code, 'unsafe-parent');
        assert.equal(fs.existsSync(path.join(linkedOutside, 'mcp.json')), false);
      } finally {
        state.cwd = previous;
      }
    });
  } else {
    console.log('  skip I·目录链接（当前环境不能创建 junction/symlink）');
  }

  console.log(`\n${count} assertions passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
