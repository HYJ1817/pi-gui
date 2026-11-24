/* 消息内文件链接与 Files 面板共用的“扩展动作”。
 *
 * 渲染进程永远不直接调用 shell：桌面版走 preload 的具名桥，主进程再向后端
 * 请求授权后的绝对路径；网页版没有这个能力，只把后端认可的绝对路径告诉
 * 用户，不假装打开了文件。
 *
 * 每个动作都携带**工作区身份**（消息引用：cwd + fileId；文件树：
 * workspace token + generation）或**外部授权令牌**。后端是最终裁判：
 * 身份不符、授权被撤销、文件被替换都会拒绝，页面无法靠改字符串绕过。 */
import { authorizeExternalFileOpen, authorizeFileOpen, fetchFileMetadata } from './api.js';
import { toast } from './ui/toast.js';

const bridge = () => globalThis.window?.piGuiDesktop || null;
const scope = (conversationId) => (typeof conversationId === 'string' && conversationId ? conversationId : null);

export function hasDesktopFileBridge() {
  return typeof bridge()?.openWorkspaceFile === 'function';
}

export function hasExternalFileBridge() {
  return typeof bridge()?.externalFiles?.authorize === 'function';
}

export function hasEditorBridge() {
  return typeof bridge()?.editors?.open === 'function';
}

function requestOf(source = {}) {
  return {
    path: typeof source.path === 'string' ? source.path : '',
    cwd: typeof source.cwd === 'string' ? source.cwd : '',
    conversationId: scope(source.conversationId),
    fileId: typeof source.fileId === 'string' ? source.fileId : '',
    workspace: source.workspace && typeof source.workspace === 'object' ? source.workspace : null,
    generation: source.generation === undefined || source.generation === null ? undefined : String(source.generation),
    line: Number.isSafeInteger(source.line) ? source.line : 0,
    column: Number.isSafeInteger(source.column) ? source.column : 0,
    external: source.external === true,
    grantId: typeof source.grantId === 'string' ? source.grantId : '',
  };
}

/** 工作区外文件授权：只能由主进程弹原生对话框并创建令牌。
 *  这里只发起“请求”，拿不到 shell 能力；取消时返回 `{cancelled:true}`。 */
export async function authorizeExternalFile({ path, conversationId, kind = 'file' } = {}) {
  if (!path) return { ok: false, error: '缺少文件路径' };
  const desktop = bridge();
  if (typeof desktop?.externalFiles?.authorize !== 'function') {
    return { ok: false, code: 'unsupported', error: '外部文件授权只在桌面应用中可用。' };
  }
  try {
    const result = await desktop.externalFiles.authorize({
      path,
      conversationId: scope(conversationId),
      kind: kind === 'directory' ? 'directory' : 'file',
    });
    return result || { ok: false, error: '授权失败' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function listExternalGrants(conversationId) {
  const desktop = bridge();
  if (typeof desktop?.externalFiles?.list !== 'function') {
    return { ok: false, code: 'unsupported', error: '外部文件授权只在桌面应用中可用。' };
  }
  try {
    return await desktop.externalFiles.list({ conversationId: scope(conversationId) });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function revokeExternalAccess({ grantId, conversationId } = {}) {
  const desktop = bridge();
  if (typeof desktop?.externalFiles?.revoke !== 'function') {
    return { ok: false, code: 'unsupported', error: '外部文件授权只在桌面应用中可用。' };
  }
  if (typeof grantId !== 'string' || !grantId) return { ok: false, error: '缺少授权标识' };
  try {
    const result = await desktop.externalFiles.revoke({ grantId, conversationId: scope(conversationId) });
    if (result?.ok) {
      document.dispatchEvent(new window.CustomEvent('pi-gui:external-grants', { detail: { revoked: grantId } }));
    }
    return result || { ok: false, error: '撤销失败' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function chooseExternalDirectory(conversationId) {
  const desktop = bridge();
  if (typeof desktop?.externalFiles?.chooseDirectory !== 'function') {
    return { ok: false, code: 'unsupported', error: '外部文件授权只在桌面应用中可用。' };
  }
  try {
    const result = await desktop.externalFiles.chooseDirectory({ conversationId: scope(conversationId) });
    if (result?.ok) {
      document.dispatchEvent(new window.CustomEvent('pi-gui:external-grants', { detail: { created: result.grant?.id } }));
    }
    return result || { ok: false, error: '授权失败' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function ensureExternalGrant(request) {
  if (request.grantId) return request.grantId;
  const result = await authorizeExternalFile({
    path: request.path,
    conversationId: request.conversationId,
    kind: 'file',
  });
  if (!result?.ok) {
    if (!result?.cancelled) toast(result?.error || '没有取得访问授权。', 'error');
    return '';
  }
  return typeof result.grant?.id === 'string' ? result.grant.id : '';
}

async function withFileIdentity(request) {
  if (request.fileId || request.workspace || request.external || !request.cwd) return request;
  const meta = await fetchFileMetadata(request.path, request.conversationId, { root: request.cwd });
  if (!meta?.ok || typeof meta.file?.fileId !== 'string') return request;
  return { ...request, fileId: meta.file.fileId };
}

/** 用系统默认程序打开。返回 `{ok, abs?, error?}`，调用方不需要 toast。 */
export async function openInSystemProgram(source = {}) {
  const request = requestOf(source);
  if (!request.path) return { ok: false, error: '缺少文件路径' };
  const desktop = bridge();
  if (typeof desktop?.openWorkspaceFile === 'function') {
    let grantId = '';
    if (request.external) {
      grantId = await ensureExternalGrant(request);
      if (!grantId) return { ok: false, code: 'grant_required', error: '没有取得访问授权。' };
    }
    try {
      const result = await desktop.openWorkspaceFile({ ...request, grantId });
      if (result?.ok === false) toast(result.error || '打开失败', 'error');
      return result || { ok: false, error: '打开失败' };
    } catch (error) {
      toast('打开失败：' + error.message, 'error');
      return { ok: false, error: error.message };
    }
  }
  if (request.external) {
    toast('网页版无法访问工作区外文件。', 'warn');
    return { ok: false, code: 'unsupported', error: 'unsupported' };
  }
  const authorized = await authorizeFileOpen(await withFileIdentity(request));
  if (!authorized?.ok) {
    toast(authorized?.error || '打开失败', 'error');
    return authorized || { ok: false, error: '打开失败' };
  }
  toast('网页版无法调用系统程序。文件：' + (authorized.file?.absolutePath || request.path), 'warn');
  return authorized;
}

export async function revealInFileManager(source = {}) {
  const request = requestOf(source);
  if (!request.path) return { ok: false, error: '缺少文件路径' };
  const desktop = bridge();
  if (typeof desktop?.revealWorkspaceFile === 'function') {
    let grantId = '';
    if (request.external) {
      grantId = await ensureExternalGrant(request);
      if (!grantId) return { ok: false, code: 'grant_required', error: '没有取得访问授权。' };
    }
    try {
      const result = await desktop.revealWorkspaceFile({ ...request, grantId });
      if (result?.ok === false) toast(result.error || '无法在文件管理器中显示', 'error');
      return result || { ok: false, error: '无法在文件管理器中显示' };
    } catch (error) {
      toast('无法在文件管理器中显示：' + error.message, 'error');
      return { ok: false, error: error.message };
    }
  }
  toast('网页版无法打开文件管理器。', 'warn');
  return { ok: false, error: 'unsupported' };
}

/** Ctrl/Cmd+点击、右键菜单里的“用外部编辑器打开”。
 *  编辑器配置、可执行文件选择与参数构造都在主进程；这里只传文件身份。 */
export async function openInExternalEditor(source = {}) {
  const request = requestOf(source);
  if (!request.path) return { ok: false, error: '缺少文件路径' };
  const desktop = bridge();
  if (typeof desktop?.editors?.open !== 'function') {
    toast('桌面版设置外部编辑器后可从这里打开。', 'warn');
    return { ok: false, code: 'unsupported' };
  }
  let grantId = '';
  if (request.external) {
    grantId = await ensureExternalGrant(request);
    if (!grantId) return { ok: false, code: 'grant_required', error: '没有取得访问授权。' };
  }
  try {
    const result = await desktop.editors.open({ ...request, grantId });
    if (result?.ok === false) toast(result.error || '无法用外部编辑器打开', 'error');
    return result || { ok: false, error: '无法用外部编辑器打开' };
  } catch (error) {
    toast('无法用外部编辑器打开：' + error.message, 'error');
    return { ok: false, error: error.message };
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制路径', 'success', { important: true });
    return true;
  } catch {
    toast('复制失败，请在文件面板中手动复制路径。', 'warn');
    return false;
  }
}

export function copyRelativePath(path) {
  if (!path) return Promise.resolve(false);
  return writeClipboard(path);
}

/** 完整路径必须来自后端认可的结果，而不是渲染进程自己拼 cwd。 */
export async function copyAbsolutePath(source = {}) {
  const request = requestOf(source);
  if (!request.path) return false;
  let grantId = '';
  if (request.external) {
    grantId = await ensureExternalGrant(request);
    if (!grantId) return false;
  }
  const desktop = bridge();
  let authorized = null;
  if (typeof desktop?.authorizeWorkspaceFile === 'function') {
    try {
      authorized = await desktop.authorizeWorkspaceFile({ ...request, grantId, action: 'copy' });
    } catch (error) {
      toast('无法取得完整路径：' + error.message, 'error');
      return false;
    }
  } else if (request.external) {
    authorized = await authorizeExternalFileOpen({ ...request, grantId, action: 'copy' });
  } else {
    authorized = await authorizeFileOpen(await withFileIdentity({ ...request, action: 'copy' }));
  }
  if (!authorized?.ok || typeof authorized.file?.absolutePath !== 'string') {
    toast(authorized?.error || '无法取得完整路径', 'error');
    return false;
  }
  return writeClipboard(authorized.file.absolutePath);
}

/* ---------- 外部编辑器设置 ---------- */

export async function editorSettings() {
  const desktop = bridge();
  if (typeof desktop?.editors?.list !== 'function') {
    return { ok: false, code: 'unsupported', error: '外部编辑器只在桌面应用中可用。' };
  }
  try {
    return await desktop.editors.list();
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function saveEditorSettings(preference) {
  const desktop = bridge();
  if (typeof desktop?.editors?.save !== 'function') {
    return { ok: false, code: 'unsupported', error: '外部编辑器只在桌面应用中可用。' };
  }
  try {
    return await desktop.editors.save(preference);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function chooseCustomEditor() {
  const desktop = bridge();
  if (typeof desktop?.editors?.chooseCustom !== 'function') {
    return { ok: false, code: 'unsupported', error: '外部编辑器只在桌面应用中可用。' };
  }
  try {
    return await desktop.editors.chooseCustom();
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
