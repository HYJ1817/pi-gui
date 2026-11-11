/* 从 Claude Desktop / Cursor / VS Code 只读扫描并导入 MCP 配置。
 * 全部使用 os.tmpdir() 下的假 HOME / APPDATA，不读真实用户目录。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let count = 0;
const check = (name, fn) => { fn(); count++; console.log('  ok  ' + name); };
const checkAsync = async (name, fn) => { await fn(); count++; console.log('  ok  ' + name); };
const section = (t) => console.log('\n--- ' + t + ' ---');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gui-mcp-import-'));
const HOME = path.join(TMP, 'home');
const APPDATA = path.join(HOME, 'AppData', 'Roaming');
const AGENT = path.join(TMP, 'agent');
const PROJECT = path.join(TMP, 'project');
const env = { HOME, USERPROFILE: HOME, APPDATA, PI_CODING_AGENT_DIR: AGENT, PATH: process.env.PATH || '' };
fs.mkdirSync(AGENT, { recursive: true });
fs.mkdirSync(path.join(PROJECT, '.pi'), { recursive: true });
const userFile = path.join(AGENT, 'mcp.json');
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8'); };
const writeText = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v, 'utf8'); };
const hashFile = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const claudeFile = path.join(APPDATA, 'Claude', 'claude_desktop_config.json');
const cursorFile = path.join(HOME, '.cursor', 'mcp.json');
const vscodeProjectFile = path.join(PROJECT, '.vscode', 'mcp.json');
const vscodeUserFile = path.join(APPDATA, 'Code', 'User', 'settings.json');

writeJson(claudeFile, {
  mcpServers: {
    memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { TOKEN: '${MEMORY_TOKEN}', MEMORY_FILE_PATH: 'C:/data/memory.json' } },
    api: { url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } },
    leaky: { command: 'npx', args: ['-y', 'leaky'], env: { API_KEY: 'sk-live-1234567890' } },
    sse: { type: 'sse', url: 'https://sse.example.com/mcp' },
    shell: { command: 'npx', env: { TOKEN: '!security find-generic-password -w' } },
    qs: { url: 'https://api.example.com/mcp?token=abc' },
    sid: { url: 'https://api.example.com/mcp?sid=ghp_abcdefghijklmnop' },
    inputy: { command: 'npx', args: ['-y', '${input:package}'] },
    argtoken: { command: 'npx', args: ['--token', 'arg-secret-123', '-y', 'pkg'] },
    argkey: { command: 'npx', args: ['--api-key=arg-key-456', '-y'] },
    argurl: { command: 'node', args: ['https://api.example.com/mcp?token=arg-url-789&mode=1'] },
    argauth: { command: 'npx', args: ['-H', 'Authorization: Bearer arg-bearer-000'] },
    safeargs: { command: 'npx', args: ['-y', 'safe-mcp', '--port', '8080'] },
  },
});
writeJson(cursorFile, {
  mcpServers: {
    memory: { command: 'uvx', args: ['mcp-server-memory'] },
    cursoronly: { command: 'npx', args: ['-y', 'cursor-mcp'] },
  },
});
writeText(vscodeProjectFile, `{
  // VS Code 的 JSONC 配置
  "servers": {
    "vs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "vs-mcp",],
      "env": { "VS_TOKEN": "\${env:VS_TOKEN}" },
    },
    "vs-file": { "type": "stdio", "command": "npx", "envFile": ".env" },
  },
}`);
writeJson(vscodeUserFile, {
  mcp: { servers: { vscodeuser: { command: 'uvx', args: ['uvx-mcp'] } } },
});

(async () => {
  const { createMcpImporter } = await import('../server/mcp-import.js');
  const { createMcpConfigStore } = await import('../server/mcp-config.js');
  const state = {
    trust: { trusted: true, requiresTrust: false },
    existing: [],
  };
  const configStore = createMcpConfigStore({
    runtime: { getCurrentCwd: () => PROJECT }, env, readTrust: async () => state.trust,
  });
  const importer = createMcpImporter({
    runtime: { getCurrentCwd: () => PROJECT }, env, configStore,
    listServers: async () => state.existing,
    readTrust: async () => state.trust,
  });

  section('A. 扫描（只读 / 脱敏）');
  const beforeHashes = new Map([claudeFile, cursorFile, vscodeProjectFile, vscodeUserFile].map((f) => [f, hashFile(f)]));
  const scan = await importer.scan();
  await checkAsync('A·识别三个来源与项目级配置', async () => {
    assert.equal(scan.ok, true);
    assert.ok(scan.detected >= 4, `detected=${scan.detected}`);
    const byId = new Map(scan.tools.map((t) => [t.id, t]));
    assert.equal(byId.get('claude-desktop').detected, true);
    assert.equal(byId.get('cursor').detected, true);
    assert.equal(byId.get('vscode-project').detected, true);
    assert.equal(byId.get('vscode').detected, true);
    assert.equal(byId.get('vscode-project').readable, true, 'JSONC 应该能被解析');
  });
  await checkAsync('A·合法条目 importable，敏感/占位符条目 blocked', async () => {
    const byName = new Map(scan.entries.map((e) => [e.id, e]));
    assert.equal(byName.get('claude-desktop:memory').status, 'importable');
    assert.equal(byName.get('claude-desktop:api').status, 'importable');
    assert.equal(byName.get('claude-desktop:leaky').status, 'blocked');
    assert.equal(byName.get('claude-desktop:leaky').code, 'plaintext-secret');
    assert.equal(byName.get('claude-desktop:sse').status, 'blocked');
    assert.equal(byName.get('claude-desktop:shell').code, 'shell-command');
    assert.equal(byName.get('claude-desktop:qs').status, 'blocked');
    assert.equal(byName.get('claude-desktop:sid').status, 'blocked');
    assert.equal(byName.get('claude-desktop:sid').code, 'protected-url');
    assert.equal(byName.get('claude-desktop:inputy').status, 'blocked');
    for (const id of ['argtoken', 'argkey', 'argurl', 'argauth']) {
      assert.equal(byName.get('claude-desktop:' + id).status, 'blocked', id);
      assert.equal(byName.get('claude-desktop:' + id).code, 'plaintext-secret', id);
    }
    assert.equal(byName.get('claude-desktop:safeargs').status, 'importable');
    assert.equal(byName.get('vscode-project:vs').status, 'importable');
    assert.equal(byName.get('vscode-project:vs-file').status, 'blocked');
    assert.equal(byName.get('vscode:vscodeuser').status, 'importable');
  });
  await checkAsync('A·返回体不含明文凭据 / 命令原文中的敏感值', async () => {
    const text = JSON.stringify(scan);
    assert.ok(!text.includes('sk-live-1234567890'));
    assert.ok(!text.includes('literal-secret'));
    assert.ok(!text.includes('!security find-generic-password'));
    assert.ok(!text.includes('token=abc'));
    assert.ok(!text.includes('ghp_abcdefghijklmnop'));
    for (const secret of ['arg-secret-123', 'arg-key-456', 'arg-url-789', 'arg-bearer-000']) {
      assert.ok(!text.includes(secret), `扫描结果泄露了 ${secret}`);
    }
    assert.ok(!text.includes('C:/data/memory.json'), '字面 env 值不应出现在扫描结果里');
    assert.ok(text.includes('MEMORY_FILE_PATH'), '键名可以出现');
  });
  await checkAsync('A·来源文件在扫描后逐字节未变', async () => {
    for (const [f, h] of beforeHashes) assert.equal(hashFile(f), h, f);
  });
  await checkAsync('A·与现有配置 / 同次扫描同名条目标出冲突', async () => {
    state.existing = [{ name: 'memory', scope: 'user' }, { name: 'api', scope: 'project' }];
    const s = await importer.scan();
    const mem = s.entries.find((e) => e.id === 'claude-desktop:memory');
    assert.ok(mem.conflicts.some((c) => c.kind === 'existing' && c.scope === 'user'));
    assert.ok(mem.conflicts.some((c) => c.kind === 'scanned' && c.source === 'cursor'));
    state.existing = [];
  });

  section('B. 导入');
  await checkAsync('B·导入多条，写入用户级配置', async () => {
    const r = await importer.apply({
      scope: 'user',
      ids: ['claude-desktop:memory', 'claude-desktop:api', 'vscode-project:vs'],
      expectedRevision: configStore.revisions().user,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.imported.sort(), ['api', 'memory', 'vs']);
    const saved = JSON.parse(fs.readFileSync(userFile, 'utf8')).mcpServers;
    assert.equal(saved.memory.command, 'npx');
    assert.equal(saved.memory.env.TOKEN, '${MEMORY_TOKEN}');
    assert.equal(saved.memory.env.MEMORY_FILE_PATH, 'C:/data/memory.json');
    assert.equal(saved.api.headers.Authorization, 'Bearer ${API_TOKEN}');
    assert.equal(saved.vs.env.VS_TOKEN, '${VS_TOKEN}');
  });
  await checkAsync('B·导入后来源文件仍然未变（只读）', async () => {
    for (const [f, h] of beforeHashes) assert.equal(hashFile(f), h, f);
  });
  await checkAsync('B·已存在的名字需要 allowReplace；确认后覆盖', async () => {
    const deny = await importer.apply({
      scope: 'user', ids: ['cursor:cursoronly', 'claude-desktop:api'],
      expectedRevision: configStore.revisions().user,
    });
    assert.equal(deny.ok, false);
    assert.equal(deny.code, 'name-conflict');
    const ok = await importer.apply({
      scope: 'user', ids: ['cursor:cursoronly', 'claude-desktop:api'],
      expectedRevision: configStore.revisions().user, allowReplace: true,
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });
  await checkAsync('B·同名导入需要显式重命名', async () => {
    const dup = await importer.apply({
      scope: 'user', ids: ['claude-desktop:memory', 'cursor:memory'],
      expectedRevision: configStore.revisions().user, allowReplace: true,
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, 'name-conflict');
    const renamed = await importer.apply({
      scope: 'user', ids: ['claude-desktop:memory', 'cursor:memory'],
      rename: { 'cursor:memory': 'memory-cursor' },
      expectedRevision: configStore.revisions().user, allowReplace: true,
    });
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    const saved = JSON.parse(fs.readFileSync(userFile, 'utf8')).mcpServers;
    assert.equal(saved['memory-cursor'].command, 'uvx');
  });
  await checkAsync('B·同名覆盖前给出结构差异预览，且不含值原文', async () => {
    state.existing = [{ name: 'memory', scope: 'user' }];
    const s = await importer.scan();
    const cursorMemory = s.entries.find((e) => e.id === 'cursor:memory');
    const conflict = cursorMemory.conflicts.find((c) => c.kind === 'existing' && c.scope === 'user');
    assert.ok(conflict, '应标出与现有配置的冲突');
    assert.ok(Array.isArray(conflict.diff) && conflict.diff.length > 0, '应有差异预览');
    const args = conflict.diff.find((d) => d.field === 'args');
    assert.deepEqual({ from: args.from, to: args.to }, { from: 2, to: 1 });
    const env = conflict.diff.find((d) => d.field === 'env');
    assert.ok(env.removed.includes('TOKEN'));
    assert.ok(env.removed.includes('MEMORY_FILE_PATH'));
    const text = JSON.stringify(conflict);
    assert.ok(!text.includes('C:/data/memory.json'), '差异预览不能带 env 值');
    assert.ok(!text.includes('${MEMORY_TOKEN}'), '差异预览不能带引用值');
    state.existing = [];
  });
  await checkAsync('B·选中 blocked 条目 fail closed', async () => {
    const r = await importer.apply({
      scope: 'user', ids: ['claude-desktop:leaky'],
      expectedRevision: configStore.revisions().user,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'source-blocked');
  });
  await checkAsync('B·项目未信任拒绝导入', async () => {
    state.trust = { trusted: false, requiresTrust: true };
    const r = await importer.apply({
      scope: 'project', ids: ['claude-desktop:memory'],
      expectedRevision: '', allowReplace: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'project-untrusted');
    state.trust = { trusted: true, requiresTrust: false };
  });

  section('C. 空环境 / JSONC');
  await checkAsync('C·没有检测到来源工具时正常返回空态', async () => {
    const emptyHome = path.join(TMP, 'empty-home');
    fs.mkdirSync(emptyHome, { recursive: true });
    const empty = createMcpImporter({
      runtime: { getCurrentCwd: () => path.join(TMP, 'no-project') },
      env: { HOME: emptyHome, USERPROFILE: emptyHome, APPDATA: path.join(emptyHome, 'AppData') },
      configStore,
    });
    const s = await empty.scan();
    assert.equal(s.ok, true);
    assert.equal(s.detected, 0);
    assert.equal(s.entries.length, 0);
  });
  check('C·JSONC 注释/尾逗号剥离不碰字符串内容', () => {
    const { stripJsonc } = importer._internals;
    const text = '{ "a": "http://x/y", // comment\n "b": [1,2,], /* c */ }';
    const parsed = JSON.parse(stripJsonc(text));
    assert.equal(parsed.a, 'http://x/y');
    assert.deepEqual(parsed.b, [1, 2]);
  });

  console.log(`\n${count} assertions passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
