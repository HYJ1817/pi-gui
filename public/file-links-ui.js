/* 消息内文件链接的交互层：点击、悬停信息、右键菜单、纯文件名候选升级。
 *
 * 渲染层（markdown.js）只输出带 `data-file-*` 的锚点与候选 `<code>`；
 * 这里统一处理行为，避免每个渲染路径各绑一套监听。
 *
 * 安全边界：
 *   - 悬停只发一次 metadata GET，不读内容、不执行文件、不打开外部程序；
 *   - 点击打开前校验“链接所属会话 == 当前焦点会话”，不允许用当前项目
 *     去解析别的会话的历史消息；
 *   - 外部打开/文件管理器/复制完整路径都先经后端授权，渲染进程不持有 shell。 */
import { fetchFileMetadata, findWorkspaceFile, gitConversationScope } from './api.js';
import { baseName, fileLinkFromInlineCode, isPathWithin, positionLabel, rangeLabel, resolveFilePath } from './file-link-model.js';
import { fmtSize } from './util.js';
import { createFileIcon } from './ui/file-icons.js';
import { iconMarkup } from './ui/icons.js';
import { openActionMenu } from './ui/action-menu.js';
import { toast } from './ui/toast.js';
import { copyAbsolutePath, copyRelativePath, openInSystemProgram, revealInFileManager } from './file-actions.js';
import { openFileReference } from './files-panel.js';

export const FILE_LINK_TOOLTIP_DELAY = 240;
const METADATA_TTL = 20_000;
const METADATA_LIMIT = 120;

let installed = false;
let hoverLink = null;
let hoverShowTimer = 0;
let hoverHideTimer = 0;
let hoverToken = 0;
let tip = null;
let tipFor = null;
let candidateObserver = null;
let candidateTimer = 0;
const metadataCache = new Map();
const candidateResults = new Map();

const positiveInt = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** 从渲染出的锚点读回文件身份。DOM 里的相对路径本身不可信：
 *  必须重新走一遍解析，落在 cwd 之外就当作失效链接。 */
export function fileMetaFromElement(link) {
  if (!link?.dataset) return null;
  const resolved = resolveFilePath(link.dataset.filePath || '', link.dataset.fileCwd || '');
  if (!resolved.ok) return null;
  const line = positiveInt(link.dataset.fileLine);
  const column = positiveInt(link.dataset.fileColumn);
  const endLine = positiveInt(link.dataset.fileEndLine);
  const endColumn = positiveInt(link.dataset.fileEndColumn);
  return {
    path: resolved.path,
    cwd: resolved.cwd,
    absolutePath: resolved.absolutePath,
    name: baseName(resolved.path),
    line,
    column,
    endLine,
    endColumn,
    position: positionLabel({ line, column, endLine, endColumn }),
    conversationId: link.dataset.fileConversation || null,
  };
}

function scopeMatches(meta) {
  return (meta?.conversationId || null) === (gitConversationScope() || null);
}

function displayAbsolute(meta, absolutePath) {
  const value = String(absolutePath || meta.absolutePath || '');
  return /^[A-Za-z]:[\\/]/.test(meta.cwd || '') ? value.replace(/\//g, '\\') : value;
}

function metadataKey(meta) {
  return `${meta.conversationId || ''}\u0000${meta.path}`;
}

function cachedMetadata(meta) {
  const hit = metadataCache.get(metadataKey(meta));
  if (!hit) return null;
  if (Date.now() - hit.at > METADATA_TTL) {
    metadataCache.delete(metadataKey(meta));
    return null;
  }
  return hit.value;
}

function rememberMetadata(meta, value) {
  if (metadataCache.size >= METADATA_LIMIT) {
    const oldest = metadataCache.keys().next().value;
    if (oldest !== undefined) metadataCache.delete(oldest);
  }
  metadataCache.set(metadataKey(meta), { at: Date.now(), value });
}

async function metadataFor(meta) {
  const cached = cachedMetadata(meta);
  if (cached) return cached;
  const result = await fetchFileMetadata(meta.path, meta.conversationId);
  let value = result;
  if (result?.ok && !isPathWithin(meta.cwd, result.file?.absolutePath || '')) {
    // 会话的工作区已经变化（例如 worktree 被替换）。不要把新工作区里
    // 同名的文件当成链接指向的那个文件。
    value = { ok: false, code: 'workspace_changed', error: '工作区已经变化。' };
  }
  rememberMetadata(meta, value);
  return value;
}

function fileLabel(meta) {
  return meta.name + (meta.position || '');
}

function chipElement(meta) {
  const link = document.createElement('a');
  link.href = '#';
  link.className = 'md-file-link';
  link.dataset.fileLink = '1';
  link.dataset.filePath = meta.path;
  link.dataset.fileCwd = meta.cwd;
  link.dataset.fileConversation = meta.conversationId || '';
  if (meta.line) link.dataset.fileLine = String(meta.line);
  if (meta.column) link.dataset.fileColumn = String(meta.column);
  if (meta.endLine) link.dataset.fileEndLine = String(meta.endLine);
  if (meta.endColumn) link.dataset.fileEndColumn = String(meta.endColumn);
  link.setAttribute('aria-label', meta.path + (meta.position || ''));
  link.append(
    createFileIcon(document, meta.path),
    Object.assign(document.createElement('span'), { className: 'md-file-name', textContent: fileLabel(meta) })
  );
  return link;
}

/* ---------- 悬停提示 ---------- */

function ensureTip() {
  if (tip?.isConnected) return tip;
  tip = document.createElement('div');
  tip.className = 'ui-tooltip file-link-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}

function hideTip() {
  hoverToken++;
  if (tip) tip.hidden = true;
  tipFor = null;
}

function placeTip(anchor) {
  if (!tip || tip.hidden) return;
  const view = document.defaultView;
  if (!view) return;
  const rect = anchor.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  let left = rect.left + rect.width / 2 - box.width / 2;
  left = Math.max(margin, Math.min(left, view.innerWidth - box.width - margin));
  let top = rect.top - box.height - gap;
  if (top < margin) top = rect.bottom + gap;
  top = Math.max(margin, Math.min(top, view.innerHeight - box.height - margin));
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}

async function showTip(link) {
  const meta = fileMetaFromElement(link);
  if (!meta) return;
  const token = ++hoverToken;
  const result = await metadataFor(meta);
  if (token !== hoverToken || hoverLink !== link || !link.isConnected) return;
  const element = ensureTip();
  const parts = [displayAbsolute(meta, result?.ok ? result.file?.absolutePath : '')];
  if (result?.ok && Number.isFinite(result.file?.bytes)) parts.push(fmtSize(result.file.bytes));
  const range = rangeLabel(meta);
  if (range) parts.push(range);
  if (!result?.ok && result.code === 'file_missing') parts.push('文件不存在');
  element.textContent = parts.join(' · ');
  element.hidden = false;
  element.style.left = '-9999px';
  element.style.top = '-9999px';
  tipFor = link;
  placeTip(link);
}

function hideSchedule() {
  if (hoverShowTimer) { clearTimeout(hoverShowTimer); hoverShowTimer = 0; }
  if (hoverHideTimer) clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(() => { hoverHideTimer = 0; hideTip(); }, 80);
}

function showSchedule(link, delay) {
  if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = 0; }
  if (hoverShowTimer) clearTimeout(hoverShowTimer);
  hoverShowTimer = setTimeout(() => { hoverShowTimer = 0; void showTip(link); }, delay);
}

function clearHover() {
  hoverLink = null;
  if (hoverShowTimer) { clearTimeout(hoverShowTimer); hoverShowTimer = 0; }
  hideTip();
}

/* ---------- 打开 ---------- */

function openInternal(meta) {
  if (!scopeMatches(meta)) {
    toast('这个文件引用属于其它会话，请先切换到那个会话。', 'warn');
    return;
  }
  openFileReference(meta);
}

function menuItems(meta) {
  const mismatch = !scopeMatches(meta);
  return [
    {
      label: '在文件面板中打开',
      icon: iconMarkup('eye'),
      disabled: mismatch,
      disabledReason: mismatch ? '这个文件引用属于其它会话' : '',
      onClick: () => openInternal(meta),
    },
    {
      label: '用系统默认程序打开',
      icon: iconMarkup('external'),
      onClick: () => void openInSystemProgram({ path: meta.path, conversationId: meta.conversationId }),
    },
    {
      label: '在文件管理器中显示',
      icon: iconMarkup('folder'),
      onClick: () => void revealInFileManager({ path: meta.path, conversationId: meta.conversationId }),
    },
    { separator: true },
    {
      label: '复制相对路径',
      icon: iconMarkup('copy'),
      onClick: () => void copyRelativePath(meta.path),
    },
    {
      label: '复制完整路径',
      icon: iconMarkup('copy'),
      onClick: () => void copyAbsolutePath({ path: meta.path, conversationId: meta.conversationId }),
    },
  ];
}

/* ---------- 纯文件名候选 ---------- */

async function uniqueMatch(meta) {
  const key = `${meta.conversationId || ''}\u0000${meta.name}`;
  if (candidateResults.has(key)) return candidateResults.get(key);
  const result = await findWorkspaceFile(meta.name, meta.conversationId);
  // 后端暂时不可达不能当成“不唯一”永久缓存；下次渲染还能再试。
  if (result?.network) return null;
  let match = null;
  if (result?.ok && !result.truncated && Array.isArray(result.matches) && result.matches.length === 1) {
    const resolved = resolveFilePath(result.matches[0], meta.cwd);
    if (resolved.ok) match = result.matches[0];
  }
  candidateResults.set(key, match);
  return match;
}

/** 把 `<code data-file-candidate>` 原地升级成文件链接。
 *  只在后端确认“唯一存在”时升级；歧义/不存在/查询失败都保持代码外观。
 *  每批最多 24 个，避免长对话一次打出上百个请求；`auto` 用于自动扫描，
 *  处理完一批后若还有剩余就再排一批。 */
export async function enhanceFileCandidates(root = document, { auto = false } = {}) {
  if (!root?.querySelectorAll) return 0;
  const candidates = [...root.querySelectorAll('code.md-file-candidate:not([data-file-checked])')].slice(0, 24);
  let upgraded = 0;
  for (const element of candidates) {
    element.dataset.fileChecked = '1';
    const meta = fileLinkFromInlineCode(element.dataset.fileCandidate || '', element.dataset.fileCwd || '');
    if (!meta?.candidate) continue;
    const match = await uniqueMatch(meta);
    if (!match || !element.isConnected) continue;
    const resolved = resolveFilePath(match, meta.cwd);
    if (!resolved.ok) continue;
    const line = positiveInt(element.dataset.fileLine);
    const column = positiveInt(element.dataset.fileColumn);
    const endLine = positiveInt(element.dataset.fileEndLine);
    const endColumn = positiveInt(element.dataset.fileEndColumn);
    const link = chipElement({
      path: resolved.path,
      cwd: resolved.cwd,
      absolutePath: resolved.absolutePath,
      name: baseName(resolved.path),
      line,
      column,
      endLine,
      endColumn,
      position: positionLabel({ line, column, endLine, endColumn }),
      conversationId: element.dataset.fileConversation || null,
    });
    element.replaceWith(link);
    upgraded++;
  }
  if (auto && root.querySelector?.('code.md-file-candidate:not([data-file-checked])')) scheduleEnhance();
  return upgraded;
}

function scheduleEnhance() {
  if (candidateTimer) clearTimeout(candidateTimer);
  candidateTimer = setTimeout(() => {
    candidateTimer = 0;
    void enhanceFileCandidates(document, { auto: true });
  }, 320);
}

/* ---------- 事件装配 ---------- */

export function initFileLinks() {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  document.addEventListener('click', (event) => {
    const link = event.target?.closest?.('a.md-file-link');
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    clearHover();
    const meta = fileMetaFromElement(link);
    if (!meta) {
      toast('文件路径不可用。', 'warn');
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      void openInSystemProgram({ path: meta.path, conversationId: meta.conversationId });
      return;
    }
    openInternal(meta);
  });

  document.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    if (event.target?.closest?.('a.md-file-link')) event.preventDefault();
  });

  document.addEventListener('contextmenu', (event) => {
    const link = event.target?.closest?.('a.md-file-link');
    if (!link) return;
    event.preventDefault();
    clearHover();
    const meta = fileMetaFromElement(link);
    if (!meta) return;
    openActionMenu(link, menuItems(meta));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      clearHover();
      return;
    }
    const link = event.target?.closest?.('a.md-file-link');
    if (!link) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const meta = fileMetaFromElement(link);
      if (meta) openActionMenu(link, menuItems(meta));
    }
  });

  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const link = event.target?.closest?.('a.md-file-link');
    if (!link || link === hoverLink) return;
    hoverLink = link;
    showSchedule(link, FILE_LINK_TOOLTIP_DELAY);
  });

  document.addEventListener('pointerout', (event) => {
    const link = event.target?.closest?.('a.md-file-link');
    if (!link || link !== hoverLink) return;
    if (link.contains(event.relatedTarget)) return;
    hoverLink = null;
    hideSchedule();
  });

  document.addEventListener('focusin', (event) => {
    const link = event.target?.closest?.('a.md-file-link');
    if (!link) return;
    hoverLink = link;
    showSchedule(link, 0);
  });

  document.addEventListener('focusout', (event) => {
    const link = event.target?.closest?.('a.md-file-link');
    if (!link) return;
    if (link.contains(event.relatedTarget)) return;
    hoverLink = null;
    hideSchedule();
  });

  const dismiss = () => { if (tipFor) hideTip(); };
  document.addEventListener('scroll', dismiss, true);
  document.defaultView?.addEventListener('resize', dismiss);
  // 工作区换了，旧的唯一性结论也不再成立（同一个会话 id 下相对路径可能指向
  // 另一个项目）；元数据与候选结果都必须一起作废。
  document.addEventListener('pi-gui:git-scope', () => { metadataCache.clear(); candidateResults.clear(); clearHover(); });
  document.addEventListener('pi-gui:workspace-generation', () => { metadataCache.clear(); candidateResults.clear(); clearHover(); });

  if (typeof MutationObserver === 'function') {
    candidateObserver = new MutationObserver(() => scheduleEnhance());
    candidateObserver.observe(document.body, { childList: true, subtree: true });
  }
  scheduleEnhance();
}

/* 测试与“消息刚渲染完”时可直接调用；不依赖 observer 的时序。 */
export function resetFileLinkCaches() {
  metadataCache.clear();
  candidateResults.clear();
}
