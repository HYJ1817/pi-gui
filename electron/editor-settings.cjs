'use strict';

/* 外部编辑器：检测、持久化与打开。
 *
 * 这里只做三件事：
 *   1. 用**文件存在性**检测已安装的编辑器（不执行陌生二进制去探版本）；
 *   2. 把用户选择写进主进程持有的设置文件（与系统设置同一套原子写入）；
 *   3. 打开文件前先让后端授权，再用明确的可执行文件 + 参数数组启动。
 *
 * 没有 shell 拼接：所有参数都是数组元素；路径来自后端授权结果，不来自
 * 模型输出或页面自由拼装。自定义编辑器只接收文件路径（未知编辑器不猜参数）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createSystemPreferenceFile } = require('./system-settings-store.cjs');

const EDITOR_IDS = Object.freeze(['system', 'vscode', 'cursor', 'windsurf', 'zed', 'notepadpp', 'custom']);
const EDITOR_SET = new Set(EDITOR_IDS);
const DEFAULTS = Object.freeze({ editor: 'system', customPath: '' });
const MAX_POSITION = 10_000_000;
const DANGEROUS_OPEN_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.msi', '.msp', '.scr', '.pif', '.cpl', '.msc',
  '.hta', '.hjs', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.ps1', '.psm1', '.psd1',
  '.reg', '.lnk', '.url', '.scf', '.jar', '.class', '.application', '.appref-ms',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.pyw',
  '.sh', '.bash', '.zsh', '.fish', '.ksh', '.rb', '.pl', '.pm', '.php', '.lua',
]);

function validPreferences(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2
    && EDITOR_SET.has(value.editor)
    && typeof value.customPath === 'string'
    && value.customPath.length <= 1024
    && (value.customPath === '' || path.isAbsolute(value.customPath));
}

function executableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

function pathDirs(env) {
  return String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
}

function findOnPath(names, env) {
  for (const dir of pathDirs(env)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (executableFile(candidate)) return candidate;
    }
  }
  return '';
}

function windowsCandidates(env, relativePaths) {
  const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
    .filter(Boolean);
  return roots.flatMap(root => relativePaths.map(relative => path.join(root, relative)));
}

/* 安装路径不一定在 Program Files：用户可以把 VS Code 装在任意盘符，
 * 安装器会把真实入口写进 App Paths。只读注册表里的这一处，不执行编辑器
 * 探测版本。`reg.exe` 的输出会把 `(Default)` 本地化成 `(默认)`，所以按
 * `REG_SZ` 值而不是值名解析；同一个键里优先取存在的可执行文件。 */
function parseAppPaths(text) {
  const found = new Map();
  let current = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const key = line.match(/App Paths\\([^\\]+)\s*$/i);
    if (/^HKEY_/i.test(line) && key) {
      current = key[1].toLowerCase();
      continue;
    }
    const value = line.match(/\sREG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i);
    if (!current || !value) continue;
    const candidate = value[1].replace(/^"|"$/g, '');
    if (!found.has(current) && /\.exe$/i.test(candidate) && executableFile(candidate)) {
      found.set(current, candidate);
    }
  }
  return found;
}

/* reg.exe 输出按控制台代码页编码，中文 Windows 上是 GBK 而不是 UTF-8。
 * 不猜系统语言：把常见编码都解一遍，取“解出的可执行文件真正存在”最多的
 * 那一份；纯 ASCII 输出时所有候选结果相同，稳定回落到 UTF-8。 */
function decodeRegOutput(buffer) {
  let best = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  let bestCount = -1;
  if (Buffer.isBuffer(buffer)) {
    for (const encoding of ['utf-8', 'gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
      let text;
      try {
        text = new TextDecoder(encoding).decode(buffer);
      } catch {
        continue;
      }
      const count = parseAppPaths(text).size;
      if (count > bestCount) {
        best = text;
        bestCount = count;
      }
    }
  }
  return best;
}

function readWindowsAppPaths() {
  const roots = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  ];
  const found = new Map();
  for (const root of roots) {
    let buffer;
    try {
      buffer = execFileSync('reg.exe', ['query', root, '/s'], {
        encoding: 'buffer',
        windowsHide: true,
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    for (const [name, executable] of parseAppPaths(decodeRegOutput(buffer))) {
      if (!found.has(name)) found.set(name, executable);
    }
  }
  return found;
}

function catalog(platform, env, appPaths = new Map()) {
  const entries = [{ id: 'system', label: '系统默认程序' }];
  if (platform === 'win32') {
    const registered = name => appPaths.get(name) || '';
    const vscode = [
      registered('code.exe'),
      ...windowsCandidates(env, ['Microsoft VS Code/Code.exe', 'Microsoft VS Code/bin/code.exe']),
      ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe')] : []),
    ];
    const cursor = [registered('cursor.exe'), ...windowsCandidates(env, ['Cursor/Cursor.exe', 'cursor/Cursor.exe'])];
    const windsurf = [registered('windsurf.exe'), ...windowsCandidates(env, ['Windsurf/Windsurf.exe'])];
    const zed = [registered('zed.exe'), ...windowsCandidates(env, ['Zed/Zed.exe', 'Zed/bin/zed.exe', 'Zed/zed.exe'])];
    const notepad = [registered('notepad++.exe'), ...windowsCandidates(env, ['Notepad++/notepad++.exe'])];
    entries.push(
      { id: 'vscode', label: 'Visual Studio Code', launch: 'goto', candidates: vscode },
      { id: 'cursor', label: 'Cursor', launch: 'goto', candidates: cursor },
      { id: 'windsurf', label: 'Windsurf', launch: 'goto', candidates: windsurf },
      { id: 'zed', label: 'Zed', launch: 'direct', candidates: zed },
      { id: 'notepadpp', label: 'Notepad++', launch: 'line-column', candidates: notepad },
    );
  } else if (platform === 'darwin') {
    const app = (name, binary) => [`/Applications/${name}.app`, ...(binary ? [`/Applications/${name}.app/Contents/MacOS/${binary}`] : [])];
    entries.push(
      { id: 'vscode', label: 'Visual Studio Code', launch: 'goto', appName: 'Visual Studio Code', candidates: app('Visual Studio Code') },
      { id: 'cursor', label: 'Cursor', launch: 'goto', appName: 'Cursor', candidates: app('Cursor') },
      { id: 'windsurf', label: 'Windsurf', launch: 'goto', appName: 'Windsurf', candidates: app('Windsurf') },
      { id: 'zed', label: 'Zed', launch: 'direct', appName: 'Zed', candidates: [...app('Zed', 'cli'), '/usr/local/bin/zed'] },
    );
  } else {
    entries.push(
      { id: 'vscode', label: 'Visual Studio Code', launch: 'goto', candidates: [findOnPath(['code'], env)] },
      { id: 'cursor', label: 'Cursor', launch: 'goto', candidates: [findOnPath(['cursor'], env)] },
      { id: 'windsurf', label: 'Windsurf', launch: 'goto', candidates: [findOnPath(['windsurf'], env)] },
      { id: 'zed', label: 'Zed', launch: 'direct', candidates: [findOnPath(['zed', 'zeditor'], env)] },
      { id: 'notepadpp', label: 'Notepad++', launch: 'line-column', candidates: [findOnPath(['notepad++'], env)] },
    );
  }
  return entries;
}

function detect(platform, env, preference, appPaths = new Map()) {
  const entries = catalog(platform, env, appPaths);
  const results = [];
  for (const entry of entries) {
    if (entry.id === 'system') {
      results.push({ id: 'system', label: entry.label, available: true });
      continue;
    }
    const found = (entry.candidates || []).find(executableFile) || '';
    results.push({
      id: entry.id,
      label: entry.label,
      available: Boolean(found),
      ...(found ? { path: found } : {}),
      launch: entry.launch,
      ...(entry.appName ? { appName: entry.appName } : {}),
    });
  }
  const custom = preference?.customPath || '';
  results.push({
    id: 'custom',
    label: '自定义编辑器',
    available: Boolean(custom && executableFile(custom)),
    ...(custom ? { path: custom } : {}),
    launch: 'direct',
  });
  return results;
}

function positioned(abs, line, column) {
  if (!line) return abs;
  return `${abs}:${line}${column ? `:${column}` : ''}`;
}

function editorArgs(entry, abs, line, column) {
  const style = entry?.launch || 'direct';
  if (style === 'goto') {
    return line ? ['--goto', positioned(abs, line, column)] : [abs];
  }
  if (style === 'line-column') {
    return [
      ...(line ? [`-n${line}`] : []),
      ...(column ? [`-c${column}`] : []),
      abs,
    ];
  }
  return [positioned(abs, line, column)];
}

function spawnDetached(command, args, env, platform) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        /* 不能设 windowsHide: true。Windows 会把 STARTUPINFO 的 SW_HIDE
         * 应用到子进程创建的**第一个顶层窗口**，GUI 编辑器因此启动成功却
         * 没有可见窗口。真实桌面验收就是被这一点卡住的：
         * Code.exe 进程存在、窗口标题也已生成，但 IsWindowVisible=false。
         * reg.exe 这类控制台探测仍各自带自己的 windowsHide。 */
        windowsHide: false,
        env,
        shell: false,
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }
    const timer = setTimeout(() => finish({ ok: true, pid: child.pid || null }), 3000);
    child.once('spawn', () => finish({ ok: true, pid: child.pid || null }));
    child.once('error', error => finish({ ok: false, error: error.message }));
    try { child.unref(); } catch { /* spawn already detached */ }
  });
}

async function installEditorSettings({
  ipcMain,
  dialog,
  getWindow,
  origin,
  authToken,
  tokenHeader,
  directory,
  platform = process.platform,
  env = process.env,
  shell,
  spawnFile = spawnDetached,
  /* 测试传假 env 时不读本机注册表；真实应用（env === process.env）才探测。 */
  detectAppPaths = platform === 'win32' && env === process.env
    ? readWindowsAppPaths
    : () => new Map(),
} = {}) {
  const store = await createSystemPreferenceFile({
    directory,
    fileName: 'editor-settings.json',
    defaults: DEFAULTS,
    validate: validPreferences,
  });
  let disposed = false;

  function trusted(event) {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) return false;
    try {
      const url = new URL(event.senderFrame.url);
      return url.protocol === 'http:' && url.origin === origin;
    } catch { return false; }
  }

  function snapshot() {
    const state = store.snapshot();
    return {
      ok: true,
      platform,
      preference: { ...state.settings },
      editors: detect(platform, env, state.settings, detectAppPaths()),
      persistence: state.status,
      ...(state.error ? { warning: state.error } : {}),
    };
  }

  async function savePreferences(next, { allowCustomPath = false } = {}) {
    const current = store.snapshot().settings;
    /* customPath 只能来自主进程的原生文件选择。渲染进程即使被注入，也不能
     * 用 editors-save 指定一个已存在的可执行文件，再借“打开文件”执行它。 */
    const merged = {
      editor: EDITOR_SET.has(next?.editor) ? next.editor : current.editor,
      customPath: allowCustomPath && typeof next?.customPath === 'string'
        ? next.customPath
        : current.customPath,
    };
    if (!validPreferences(merged)) return { ok: false, code: 'invalid_preferences', error: '编辑器设置不合法。' };
    if (merged.editor !== 'system') {
      const available = detect(platform, env, merged, detectAppPaths()).find(editor => editor.id === merged.editor);
      if (!available?.available) {
        return { ok: false, code: 'editor_unavailable', error: '这个编辑器当前不可用。' };
      }
    }
    const result = await store.save(merged);
    if (!result.ok) {
      return { ok: false, code: result.code || 'settings_save_failed', error: result.error || '编辑器设置未能保存。' };
    }
    return snapshot();
  }

  ipcMain.handle('pi-gui:editors-list', event => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    return snapshot();
  });

  ipcMain.handle('pi-gui:editors-save', async (event, request) => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    return savePreferences(request);
  });

  ipcMain.handle('pi-gui:editors-choose-custom', async event => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    try {
      const result = await dialog.showOpenDialog(getWindow(), {
        title: '选择编辑器可执行文件',
        properties: ['openFile'],
        ...(platform === 'win32' ? { filters: [{ name: '程序', extensions: ['exe'] }] } : {}),
      });
      if (result.canceled || result.filePaths.length !== 1 || !trusted(event)) {
        return { ok: false, cancelled: true };
      }
      const chosen = result.filePaths[0];
      if (!path.isAbsolute(chosen) || !executableFile(chosen)) {
        return { ok: false, code: 'invalid_editor', error: '请选择一个可执行文件。' };
      }
      return savePreferences({ editor: 'custom', customPath: chosen }, { allowCustomPath: true });
    } catch {
      return { ok: false, code: 'dialog_failed', error: '无法打开文件选择窗口。' };
    }
  });

  async function postJson(pathname, body, conversationId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${origin}${pathname}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          [tokenHeader]: authToken,
          ...(conversationId ? { 'X-Pi-Gui-Conversation': conversationId } : {}),
        },
        body: JSON.stringify(body),
      });
      return await response.json().catch(() => null);
    } catch (error) {
      return { ok: false, code: 'backend_unreachable', error: '无法连接后端：' + error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJson(pathname, conversationId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${origin}${pathname}`, {
        signal: controller.signal,
        headers: {
          [tokenHeader]: authToken,
          ...(conversationId ? { 'X-Pi-Gui-Conversation': conversationId } : {}),
        },
      });
      return await response.json().catch(() => null);
    } catch (error) {
      return { ok: false, code: 'backend_unreachable', error: '无法连接后端：' + error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async function authorizeInternal(request, action) {
    const conversationId = request.conversationId || null;
    const hasWorkspace = Boolean(request.workspace?.id);
    let fileId = typeof request.fileId === 'string' ? request.fileId : '';
    if (!fileId && !hasWorkspace) {
      const query = new URLSearchParams({
        path: String(request.path || ''),
        root: String(request.cwd || ''),
      });
      const meta = await getJson('/api/files/metadata?' + query, conversationId);
      if (!meta?.ok || typeof meta.file?.fileId !== 'string') {
        return meta || { ok: false, code: 'metadata_failed', error: '无法确认文件身份。' };
      }
      fileId = meta.file.fileId;
    }
    return postJson('/api/files/open-target', {
      path: request.path,
      root: request.cwd,
      fileId,
      workspace: hasWorkspace ? request.workspace : null,
      generation: request.generation,
      action,
    }, conversationId);
  }

  async function authorizeExternal(request, action) {
    return postJson('/api/files/external/open-target', {
      grant: request.grantId,
      path: request.path,
      action,
    }, request.conversationId || null);
  }

  async function openWithSystem(abs) {
    const error = await shell.openPath(abs);
    if (error) return { ok: false, code: 'open_failed', error };
    return { ok: true, abs, used: 'system' };
  }

  ipcMain.handle('pi-gui:editors-open', async (event, request) => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    const source = request && typeof request === 'object' ? request : {};
    if (typeof source.path !== 'string' || !source.path.trim() || source.path.length > 4096) {
      return { ok: false, code: 'invalid_request', error: '缺少文件路径。' };
    }
    if (/[\u0000\r\n]/.test(source.path)) {
      return { ok: false, code: 'invalid_request', error: '文件路径包含不支持的字符。' };
    }
    const conversationId = typeof source.conversationId === 'string' && /^[\da-f-]{36}$/.test(source.conversationId)
      ? source.conversationId
      : null;
    const line = Number.isSafeInteger(source.line) && source.line > 0 && source.line <= MAX_POSITION ? source.line : 0;
    const column = Number.isSafeInteger(source.column) && source.column > 0 && source.column <= MAX_POSITION ? source.column : 0;

    const preference = store.snapshot().settings;
    const editors = detect(platform, env, preference, detectAppPaths());
    const chosen = editors.find(editor => editor.id === preference.editor) || editors[0];
    const external = source.external === true;

    // 系统默认程序：仍然要经后端授权（外部文件还要校验授权令牌）。
    if (!chosen || chosen.id === 'system' || !chosen.available) {
      const authorized = external
        ? await authorizeExternal({ ...source, conversationId }, 'open')
        : await authorizeInternal({ ...source, conversationId }, 'open');
      if (!authorized?.ok || typeof authorized.file?.absolutePath !== 'string') {
        return {
          ok: false,
          code: authorized?.code || 'unauthorized',
          error: authorized?.error || '文件没有通过授权校验。',
        };
      }
      const result = await openWithSystem(authorized.file.absolutePath);
      return { ...result, fallback: chosen?.id !== 'system', editor: 'system' };
    }

    const authorized = external
      ? await authorizeExternal({ ...source, conversationId }, 'editor')
      : await authorizeInternal({ ...source, conversationId }, 'editor');
    if (!authorized?.ok || typeof authorized.file?.absolutePath !== 'string') {
      return {
        ok: false,
        code: authorized?.code || 'unauthorized',
        error: authorized?.error || '文件没有通过授权校验。',
      };
    }
    const abs = authorized.file.absolutePath;
    if (chosen.id === 'custom') {
      const result = await spawnFile(chosen.path, [abs], env, platform);
      return result.ok ? { ...result, abs, used: 'custom', editor: 'custom' } : result;
    }
    if (platform === 'darwin' && chosen.appName) {
      const args = ['-a', chosen.appName, '--args', ...editorArgs(chosen, abs, line, column)];
      const result = await spawnFile('/usr/bin/open', args, env, platform);
      return result.ok ? { ...result, abs, used: chosen.id, editor: chosen.id } : result;
    }
    const result = await spawnFile(chosen.path, editorArgs(chosen, abs, line, column), env, platform);
    return result.ok ? { ...result, abs, used: chosen.id, editor: chosen.id } : result;
  });

  // 主进程自己的“用系统默认程序打开 / 文件管理器定位”也要先授权。
  async function authorizeShellRequest(request, action) {
    if (!request || typeof request.path !== 'string' || !request.path.trim()) {
      return { ok: false, code: 'invalid_request', error: '缺少文件路径。' };
    }
    const conversationId = typeof request.conversationId === 'string' && /^[\da-f-]{36}$/.test(request.conversationId)
      ? request.conversationId
      : null;
    const authorized = request.external === true
      ? await authorizeExternal({ ...request, conversationId }, action)
      : await authorizeInternal({ ...request, conversationId }, action);
    if (!authorized?.ok || typeof authorized.file?.absolutePath !== 'string') {
      return {
        ok: false,
        code: authorized?.code || 'unauthorized',
        error: authorized?.error || '文件没有通过授权校验。',
      };
    }
    return { ok: true, abs: authorized.file.absolutePath, file: authorized.file };
  }

  ipcMain.handle('pi-gui:open-workspace-file', async (event, request) => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    const authorized = await authorizeShellRequest(request, 'open');
    if (!authorized.ok) return authorized;
    return openWithSystem(authorized.abs);
  });

  ipcMain.handle('pi-gui:reveal-workspace-file', async (event, request) => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    const authorized = await authorizeShellRequest(request, 'reveal');
    if (!authorized.ok) return authorized;
    shell.showItemInFolder(authorized.abs);
    return { ok: true, abs: authorized.abs };
  });

  ipcMain.handle('pi-gui:authorize-workspace-file', async (event, request) => {
    if (!trusted(event)) return { ok: false, code: 'untrusted-sender' };
    return authorizeShellRequest(request, request?.action === 'copy' ? 'copy' : 'reveal');
  });

  return {
    dispose() { disposed = true; },
    isDisposed() { return disposed; },
    snapshot,
  };
}

module.exports = {
  installEditorSettings,
  EDITOR_IDS,
  DANGEROUS_OPEN_EXTENSIONS,
  editorArgs,
  detect,
  parseAppPaths,
  readWindowsAppPaths,
};
