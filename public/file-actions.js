/* 消息内文件链接与 Files 面板共用的“扩展动作”。
 *
 * 渲染进程永远不直接调用 shell：桌面版走 preload 的具名桥，主进程再向后端
 * 请求授权后的绝对路径；网页版没有这个能力，只把后端认可的绝对路径告诉
 * 用户，不假装打开了文件。 */
import { authorizeFileOpen } from './api.js';
import { toast } from './ui/toast.js';

const bridge = () => globalThis.window?.piGuiDesktop || null;
const scope = (conversationId) => (typeof conversationId === 'string' && conversationId ? conversationId : null);

export function hasDesktopFileBridge() {
  return typeof bridge()?.openWorkspaceFile === 'function';
}

/** 用系统默认程序打开。返回 `{ok, abs?, error?}`，调用方不需要 toast。 */
export async function openInSystemProgram({ path, conversationId } = {}) {
  if (!path) return { ok: false, error: '缺少文件路径' };
  const desktop = bridge();
  if (typeof desktop?.openWorkspaceFile === 'function') {
    try {
      const result = await desktop.openWorkspaceFile(path, scope(conversationId));
      if (result?.ok === false) toast(result.error || '打开失败', 'error');
      return result || { ok: false, error: '打开失败' };
    } catch (error) {
      toast('打开失败：' + error.message, 'error');
      return { ok: false, error: error.message };
    }
  }
  const authorized = await authorizeFileOpen(path, scope(conversationId));
  if (!authorized?.ok) {
    toast(authorized?.error || '打开失败', 'error');
    return authorized || { ok: false, error: '打开失败' };
  }
  toast('网页版无法调用系统程序。文件：' + (authorized.file?.absolutePath || path), 'warn');
  return authorized;
}

export async function revealInFileManager({ path, conversationId } = {}) {
  if (!path) return { ok: false, error: '缺少文件路径' };
  const desktop = bridge();
  if (typeof desktop?.revealWorkspaceFile === 'function') {
    try {
      const result = await desktop.revealWorkspaceFile(path, scope(conversationId));
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
export async function copyAbsolutePath({ path, conversationId } = {}) {
  if (!path) return false;
  const authorized = await authorizeFileOpen(path, scope(conversationId));
  if (!authorized?.ok || typeof authorized.file?.absolutePath !== 'string') {
    toast(authorized?.error || '无法取得完整路径', 'error');
    return false;
  }
  return writeClipboard(authorized.file.absolutePath);
}
