/* 外部编辑器：检测、持久化、参数与授权打开的主进程契约。
 *
 * 不启动 Electron、不真正拉起编辑器：可执行文件都是 os.tmpdir() 里的
 * 空 fixture，spawn 被注入的 spy 替代；授权请求打到本地 HTTP 桩。
 * 重点是**参数数组**：路径里的空格、中文、`&`、引号都不能变成 shell 语法。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log('  ok  ' + name);
}

const ORIGIN = 'http://127.0.0.1:7790';
const CONVERSATION = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'editor-fixture-token';
const TOKEN_HEADER = 'x-pi-gui-token';

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) { handlers.set(channel, fn); },
    invoke(channel, request, event) { return handlers.get(channel)(event, request); },
    has(channel) { return handlers.has(channel); },
  };
}

function trustedWindow(origin) {
  const mainFrame = { url: origin + '/index.html' };
  const webContents = { mainFrame };
  return {
    window: { isDestroyed: () => false, webContents },
    event: { sender: webContents, senderFrame: mainFrame },
    foreign: { sender: webContents, senderFrame: { url: origin + '/other.html' } },
  };
}

async function startServer() {
  const records = [];
  const state = { deny: false, absolutePath: 'C:\\项目 目录\\src\\app.js' };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    records.push({ method: req.method, url: req.url, headers: req.headers, body });
    const json = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url.startsWith('/api/files/metadata')) return json({ ok: true, file: { fileId: 'meta-file-id' } });
    if (req.url.startsWith('/api/files/open-target')) {
      if (state.deny) return json({ ok: false, code: 'stale_workspace', error: '工作区已经变化。' });
      return json({ ok: true, file: { absolutePath: state.absolutePath, fileId: 'f'.repeat(32) } });
    }
    if (req.url.startsWith('/api/files/external/open-target')) {
      if (state.deny) return json({ ok: false, code: 'grant_invalid', error: '授权已经撤销。' });
      return json({ ok: true, external: true, file: { absolutePath: state.externalPath || 'D:\\外部 报告\\a.md' } });
    }
    json({ ok: false, code: 'not_expected' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  state.origin = `http://127.0.0.1:${state.port}`;
  state.records = records;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}

(async () => {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-editor-settings-'));
  const localAppData = path.join(world, 'localappdata');
  const programFiles = path.join(world, 'programfiles');
  const customDir = path.join(world, 'custom');
  const downloadsDir = path.join(world, '下载 目录');
  const dataDir = path.join(world, 'data');
  const vscodeExe = path.join(localAppData, 'Programs/Microsoft VS Code/Code.exe');
  const notepadExe = path.join(programFiles, 'Notepad++/notepad++.exe');
  const customExe = path.join(customDir, '我的 编辑器.exe');
  const downloadedVscodeExe = path.join(downloadsDir, 'Microsoft VS Code/Code.exe');
  for (const file of [vscodeExe, notepadExe, customExe, downloadedVscodeExe]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture executable');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const env = {
    LOCALAPPDATA: localAppData,
    ProgramFiles: programFiles,
    'ProgramFiles(x86)': path.join(world, 'programfiles86'),
    ProgramW6432: path.join(world, 'programfiles64'),
    PATH: '',
  };
  const { detect, editorArgs, installEditorSettings, parseAppPaths } = require('../electron/editor-settings.cjs');
  const server = await startServer();
  const origin = server.origin;
  const openWindow = trustedWindow(origin);

  try {
    await check('detection reports only editors whose executable actually exists', async () => {
      const editors = detect('win32', env, { editor: 'system', customPath: '' });
      const byId = Object.fromEntries(editors.map((editor) => [editor.id, editor]));
      assert.equal(byId.system.available, true);
      assert.equal(byId.vscode.available, true);
      assert.equal(byId.vscode.path, vscodeExe);
      assert.equal(byId.notepadpp.available, true);
      assert.equal(byId.cursor.available, false);
      assert.equal(byId.windsurf.available, false);
      assert.equal(byId.zed.available, false);
      assert.equal(byId.custom.available, false);
      const withCustom = detect('win32', env, { editor: 'custom', customPath: customExe });
      assert.equal(withCustom.find((editor) => editor.id === 'custom').available, true);
    });

    await check('App Paths detection reads localized registry output and ignores missing executables', async () => {
      const output = [
        'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
        '    (默认)    REG_SZ    ' + downloadedVscodeExe,
        '    Path    REG_SZ    C:\\somewhere',
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Notepad++.exe',
        '    (Default)    REG_SZ    ' + notepadExe,
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Ghost.exe',
        '    (默认)    REG_SZ    C:\\missing\\Ghost.exe',
        '',
      ].join('\r\n');
      const parsed = parseAppPaths(output);
      assert.equal(parsed.get('code.exe'), downloadedVscodeExe);
      assert.equal(parsed.get('notepad++.exe'), notepadExe);
      assert.equal(parsed.has('ghost.exe'), false);
      const bareEnv = { LOCALAPPDATA: path.join(world, 'empty'), ProgramFiles: path.join(world, 'empty') };
      const viaRegistry = detect('win32', bareEnv, { editor: 'system', customPath: '' },
        new Map([['code.exe', downloadedVscodeExe]]));
      assert.equal(viaRegistry.find((editor) => editor.id === 'vscode').available, true);
      assert.equal(viaRegistry.find((editor) => editor.id === 'vscode').path, downloadedVscodeExe);
      const withoutRegistry = detect('win32', bareEnv, { editor: 'system', customPath: '' });
      assert.equal(withoutRegistry.find((editor) => editor.id === 'vscode').available, false);
    });

    await check('each editor gets its own argument shape; positions are never concatenated into a shell', async () => {
      assert.deepEqual(editorArgs({ launch: 'goto' }, 'C:\\a b\\文件.md', 128, 10), ['--goto', 'C:\\a b\\文件.md:128:10']);
      assert.deepEqual(editorArgs({ launch: 'goto' }, 'C:\\a b\\文件.md', 0, 0), ['C:\\a b\\文件.md']);
      assert.deepEqual(editorArgs({ launch: 'line-column' }, 'C:\\a b\\文件.md', 7, 3), ['-n7', '-c3', 'C:\\a b\\文件.md']);
      assert.deepEqual(editorArgs({ launch: 'line-column' }, 'C:\\a b\\文件.md', 7, 0), ['-n7', 'C:\\a b\\文件.md']);
      assert.deepEqual(editorArgs({ launch: 'direct' }, 'C:\\a b\\文件.md', 7, 3), ['C:\\a b\\文件.md:7:3']);
      assert.deepEqual(editorArgs({ launch: 'direct' }, 'C:\\a b\\文件.md', 0, 0), ['C:\\a b\\文件.md']);
    });

    function setup({ spawnFile, env: setupEnv = env, detectAppPaths, directory = dataDir } = {}) {
      const ipcMain = fakeIpcMain();
      const spawnCalls = [];
      const shellCalls = [];
      const dialogCalls = [];
      const dialog = {
        showOpenDialog: async (_win, options) => {
          dialogCalls.push(options);
          return dialog.pick || { canceled: true, filePaths: [] };
        },
        showMessageBox: async () => ({ response: 0 }),
      };
      const shell = {
        openPath: async (target) => { shellCalls.push({ kind: 'openPath', target }); return ''; },
        showItemInFolder: (target) => { shellCalls.push({ kind: 'reveal', target }); },
      };
      const promise = installEditorSettings({
        ipcMain,
        dialog,
        shell,
        getWindow: () => openWindow.window,
        origin,
        authToken: TOKEN,
        tokenHeader: TOKEN_HEADER,
        directory,
        platform: 'win32',
        env: setupEnv,
        ...(detectAppPaths ? { detectAppPaths } : {}),
        spawnFile: spawnFile || (async (command, args, spawnEnv, platform) => {
          spawnCalls.push({ command, args, spawnEnv, platform });
          return { ok: true, pid: 4242 };
        }),
      });
      return { ipcMain, promise, spawnCalls, shellCalls, dialogCalls, dialog, shell };
    }

    const first = setup();
    await first.promise;
    await check('the default preference is the system default program', async () => {
      const state = await first.ipcMain.invoke('pi-gui:editors-list', undefined, openWindow.event);
      assert.equal(state.ok, true);
      assert.deepEqual(state.preference, { editor: 'system', customPath: '' });
      assert.equal(state.persistence, 'default');
      assert.equal(Array.isArray(state.editors), true);
    });

    await check('the real installer detection path consumes App Paths when the standard roots are empty', async () => {
      const dataDir2 = path.join(world, 'data-registry');
      fs.mkdirSync(dataDir2, { recursive: true });
      const registryOnly = setup({
        env: { LOCALAPPDATA: path.join(world, 'empty'), ProgramFiles: path.join(world, 'empty'), PATH: '' },
        directory: dataDir2,
        detectAppPaths: () => new Map([['code.exe', downloadedVscodeExe]]),
      });
      await registryOnly.promise;
      const state = await registryOnly.ipcMain.invoke('pi-gui:editors-list', undefined, openWindow.event);
      const vscode = state.editors.find((editor) => editor.id === 'vscode');
      assert.equal(vscode.available, true);
      assert.equal(vscode.path, downloadedVscodeExe);
      const saved = await registryOnly.ipcMain.invoke('pi-gui:editors-save', { editor: 'vscode', customPath: '' }, openWindow.event);
      assert.equal(saved.ok, true);
    });

    await check('untrusted renderers cannot read, save or open', async () => {
      assert.equal((await first.ipcMain.invoke('pi-gui:editors-list', undefined, openWindow.foreign)).code, 'untrusted-sender');
      assert.equal((await first.ipcMain.invoke('pi-gui:editors-save', { editor: 'vscode' }, openWindow.foreign)).code, 'untrusted-sender');
      assert.equal((await first.ipcMain.invoke('pi-gui:editors-open', { path: 'src/app.js' }, openWindow.foreign)).code, 'untrusted-sender');
    });

    await check('the chosen editor and custom path survive a restart', async () => {
      const saved = await first.ipcMain.invoke('pi-gui:editors-save', {
        editor: 'vscode',
        customPath: '',
      }, openWindow.event);
      assert.equal(saved.ok, true);
      assert.equal(saved.preference.editor, 'vscode');
      const second = setup();
      await second.promise;
      const restored = await second.ipcMain.invoke('pi-gui:editors-list', undefined, openWindow.event);
      assert.deepEqual(restored.preference, { editor: 'vscode', customPath: '' });
      assert.equal(restored.persistence, 'saved');
      assert.equal(second.ipcMain.has('pi-gui:editors-open'), true);
    });

    await check('saving an unavailable editor is refused', async () => {
      const invalid = await first.ipcMain.invoke('pi-gui:editors-save', { editor: 'cursor', customPath: '' }, openWindow.event);
      assert.equal(invalid.ok, false);
      assert.equal(invalid.code, 'editor_unavailable');
    });

    await check('a custom executable is chosen through the native picker and saved', async () => {
      first.dialog.pick = { canceled: false, filePaths: [customExe] };
      const result = await first.ipcMain.invoke('pi-gui:editors-choose-custom', undefined, openWindow.event);
      assert.equal(result.ok, true);
      assert.equal(result.preference.editor, 'custom');
      assert.equal(result.preference.customPath, customExe);
      assert.deepEqual(first.dialogCalls[0].properties, ['openFile']);
    });

    await check('editors-save cannot register an executable path; only the native picker can', async () => {
      const directDir = path.join(world, 'data-direct-custom');
      fs.mkdirSync(directDir, { recursive: true });
      const direct = setup({ directory: directDir });
      await direct.promise;
      const refused = await direct.ipcMain.invoke('pi-gui:editors-save', {
        editor: 'custom',
        customPath: vscodeExe,
      }, openWindow.event);
      assert.equal(refused.ok, false);
      assert.equal(refused.code, 'editor_unavailable');
      const state = await direct.ipcMain.invoke('pi-gui:editors-list', undefined, openWindow.event);
      assert.deepEqual(state.preference, { editor: 'system', customPath: '' });
      assert.equal(direct.spawnCalls.length, 0);
    });

    await check('a configured editor opens the authorized absolute path with --goto line:column', async () => {
      await first.ipcMain.invoke('pi-gui:editors-save', { editor: 'vscode', customPath: '' }, openWindow.event);
      server.absolutePath = 'C:\\项目 目录\\src\\app.js';
      const result = await first.ipcMain.invoke('pi-gui:editors-open', {
        path: 'src/app.js',
        cwd: 'C:\\项目 目录',
        fileId: 'file-id-1',
        line: 128,
        column: 10,
      }, openWindow.event);
      assert.equal(result.ok, true);
      assert.equal(result.editor, 'vscode');
      assert.equal(first.spawnCalls.length, 1);
      assert.equal(first.spawnCalls[0].command, vscodeExe);
      assert.deepEqual(first.spawnCalls[0].args, ['--goto', 'C:\\项目 目录\\src\\app.js:128:10']);
      const posted = server.records.filter((record) => record.url === '/api/files/open-target').at(-1);
      assert.equal(posted.method, 'POST');
      assert.equal(posted.headers[TOKEN_HEADER], TOKEN);
      const body = JSON.parse(posted.body);
      assert.equal(body.path, 'src/app.js');
      assert.equal(body.root, 'C:\\项目 目录');
      assert.equal(body.fileId, 'file-id-1');
      assert.equal(body.action, 'editor');
    });

    await check('paths with spaces, Chinese, ampersands and quotes stay one argument', async () => {
      await first.ipcMain.invoke('pi-gui:editors-save', { editor: 'vscode', customPath: '' }, openWindow.event);
      const hostile = 'C:\\tmp\\报告 & calc.exe "quoted" `tick`.md';
      server.absolutePath = hostile;
      first.spawnCalls.length = 0;
      const result = await first.ipcMain.invoke('pi-gui:editors-open', {
        path: 'src/app.js',
        cwd: 'C:\\项目 目录',
        fileId: 'file-id-1',
        line: 7,
        column: 2,
      }, openWindow.event);
      assert.equal(result.ok, true);
      assert.deepEqual(first.spawnCalls[0].args, ['--goto', `${hostile}:7:2`]);
      assert.equal(first.spawnCalls[0].args.length, 2);
    });

    await check('Notepad++ receives -n/-c flags, not a --goto string', async () => {
      await first.ipcMain.invoke('pi-gui:editors-save', { editor: 'notepadpp', customPath: '' }, openWindow.event);
      first.spawnCalls.length = 0;
      server.absolutePath = 'C:\\项目 目录\\src\\app.js';
      await first.ipcMain.invoke('pi-gui:editors-open', {
        path: 'src/app.js',
        cwd: 'C:\\项目 目录',
        fileId: 'file-id-1',
        line: 7,
        column: 3,
      }, openWindow.event);
      assert.equal(first.spawnCalls[0].command, notepadExe);
      assert.deepEqual(first.spawnCalls[0].args, ['-n7', '-c3', 'C:\\项目 目录\\src\\app.js']);
    });

    await check('a custom editor receives the file path only and no guessed position flags', async () => {
      await first.ipcMain.invoke('pi-gui:editors-save', { editor: 'custom', customPath: customExe }, openWindow.event);
      first.spawnCalls.length = 0;
      await first.ipcMain.invoke('pi-gui:editors-open', {
        path: 'src/app.js',
        cwd: 'C:\\项目 目录',
        fileId: 'file-id-1',
        line: 7,
        column: 3,
      }, openWindow.event);
      assert.equal(first.spawnCalls[0].command, customExe);
      assert.deepEqual(first.spawnCalls[0].args, ['C:\\项目 目录\\src\\app.js']);
    });

    await check('the system default editor still requires backend authorization before shell.openPath', async () => {
      await first.ipcMain.invoke('pi-gui:editors-save', { editor: 'system', customPath: '' }, openWindow.event);
      server.deny = true;
      first.shellCalls.length = 0;
      const denied = await first.ipcMain.invoke('pi-gui:editors-open', {
        path: 'src/app.js',
        cwd: 'C:\\项目 目录',
        fileId: 'file-id-1',
      }, openWindow.event);
      assert.equal(denied.ok, false);
      assert.equal(denied.code, 'stale_workspace');
      assert.equal(first.shellCalls.length, 0);

      server.deny = false;
      server.absolutePath = 'C:\\项目 目录\\src\\app.js';
      const opened = await first.ipcMain.invoke('pi-gui:editors-open', {
        path: 'src/app.js',
        cwd: 'C:\\项目 目录',
        fileId: 'file-id-1',
      }, openWindow.event);
      assert.equal(opened.ok, true);
      assert.deepEqual(first.shellCalls, [{ kind: 'openPath', target: 'C:\\项目 目录\\src\\app.js' }]);
    });

    await check('an external file open carries the grant token and never a workspace path', async () => {
      await first.ipcMain.invoke('pi-gui:editors-save', { editor: 'vscode', customPath: '' }, openWindow.event);
      first.spawnCalls.length = 0;
      server.externalPath = 'D:\\外部 报告\\a.md';
      const result = await first.ipcMain.invoke('pi-gui:editors-open', {
        path: 'D:\\外部 报告\\a.md',
        external: true,
        grantId: 'a'.repeat(32),
        conversationId: CONVERSATION,
        line: 4,
      }, openWindow.event);
      assert.equal(result.ok, true);
      assert.deepEqual(first.spawnCalls[0].args, ['--goto', 'D:\\外部 报告\\a.md:4']);
      const posted = server.records.filter((record) => record.url === '/api/files/external/open-target').at(-1);
      assert.equal(posted.headers['x-pi-gui-conversation'], CONVERSATION);
      assert.deepEqual(JSON.parse(posted.body), {
        grant: 'a'.repeat(32),
        path: 'D:\\外部 报告\\a.md',
        action: 'editor',
      });
    });

    await check('a denied external grant returns the backend code and spawns nothing', async () => {
      server.deny = true;
      first.spawnCalls.length = 0;
      const result = await first.ipcMain.invoke('pi-gui:editors-open', {
        path: 'D:\\外部 报告\\a.md',
        external: true,
        grantId: 'a'.repeat(32),
        conversationId: CONVERSATION,
      }, openWindow.event);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'grant_invalid');
      assert.equal(first.spawnCalls.length, 0);
      server.deny = false;
    });

    await check('without a file id the main process first asks the backend for one using the message root', async () => {
      await first.ipcMain.invoke('pi-gui:editors-save', { editor: 'vscode', customPath: '' }, openWindow.event);
      server.records.length = 0;
      first.spawnCalls.length = 0;
      await first.ipcMain.invoke('pi-gui:editors-open', {
        path: 'src/app.js',
        cwd: 'C:\\项目 目录',
        conversationId: CONVERSATION,
      }, openWindow.event);
      const metadata = server.records.find((record) => record.url.startsWith('/api/files/metadata'));
      assert.ok(metadata);
      const query = new URL(metadata.url, 'http://x').searchParams;
      assert.equal(query.get('path'), 'src/app.js');
      assert.equal(query.get('root'), 'C:\\项目 目录');
      const posted = server.records.find((record) => record.url === '/api/files/open-target');
      assert.equal(JSON.parse(posted.body).fileId, 'meta-file-id');
    });

    await check('invalid paths and conversations cannot reach the launcher; bad positions clamp to none', async () => {
      first.spawnCalls.length = 0;
      for (const request of [
        { path: '' },
        { path: 'src/\napp.js' },
        { path: 'src/\r\napp.js' },
      ]) {
        const result = await first.ipcMain.invoke('pi-gui:editors-open', request, openWindow.event);
        assert.equal(result.ok, false, JSON.stringify(request));
        assert.equal(result.code, 'invalid_request');
      }
      assert.equal(first.spawnCalls.length, 0);
      server.absolutePath = 'C:\\项目 目录\\src\\app.js';
      const clamped = await first.ipcMain.invoke('pi-gui:editors-open', {
        path: 'src/app.js',
        cwd: 'C:\\项目 目录',
        fileId: 'file-id-1',
        line: -1,
        column: Number.MAX_SAFE_INTEGER,
      }, openWindow.event);
      assert.equal(clamped.ok, true);
      assert.equal(first.spawnCalls.length, 1);
      assert.deepEqual(first.spawnCalls[0].args, ['C:\\项目 目录\\src\\app.js']);
    });

    await check('an uninstalled editor falls back to the system program instead of failing silently', async () => {
      await first.ipcMain.invoke('pi-gui:editors-save', { editor: 'vscode', customPath: '' }, openWindow.event);
      fs.renameSync(vscodeExe, vscodeExe + '.gone');
      try {
        first.spawnCalls.length = 0;
        first.shellCalls.length = 0;
        server.absolutePath = 'C:\\项目 目录\\src\\app.js';
        const result = await first.ipcMain.invoke('pi-gui:editors-open', {
          path: 'src/app.js',
          cwd: 'C:\\项目 目录',
          fileId: 'file-id-1',
        }, openWindow.event);
        assert.equal(result.ok, true);
        assert.equal(result.editor, 'system');
        assert.equal(result.fallback, true);
        assert.equal(first.spawnCalls.length, 0);
        assert.deepEqual(first.shellCalls, [{ kind: 'openPath', target: 'C:\\项目 目录\\src\\app.js' }]);
      } finally {
        fs.renameSync(vscodeExe + '.gone', vscodeExe);
      }
    });

    console.log(`editor-settings: ${checks} checks passed`);
  } finally {
    await server.close();
    fs.rmSync(world, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
