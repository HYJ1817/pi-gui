/* 消息内文件链接的交互层：点击、悬停信息、右键菜单、纯文件名候选升级。
 *
 * 渲染层（markdown.js）只输出带 `data-file-*` 的锚点、候选 `<code>` 与
 * 纯文本候选 `<span>`；这里统一处理行为，避免每个渲染路径各绑一套监听。
 *
 * 安全边界：
 *   - 元数据查询只用于工作区内路径；工作区外路径在用户通过原生对话框授权
 *     之前**不发任何请求**，也不显示真实大小；
 *   - 点击/打开前校验“链接所属会话 == 当前焦点会话”，不允许用当前项目
 *     去解析别的会话的历史消息；
 *   - 外部打开/文件管理器/复制完整路径/外部编辑器都先经后端授权，渲染进程
 *     不持有 shell；
 *   - 异步结果带工作区代次；旧代次返回的元数据、候选结果与授权确认一律丢弃，
 *     不会回填到新会话/新工作区。 */
import { fetchExternalFileMetadata, fetchFileMetadata, findWorkspaceFile, gitConversationScope } from './api.js';
import {
  baseName,
  fileLinkDisplayLabel,
  fileLinkFromInlineCode,
  fileLinkFromPlainText,
  isPathWithin,
  positionLabel,
  resolveFileReference,
} from './file-link-model.js';
import { fmtSize } from './util.js';
import { createFileIcon, fileIconHtml } from './ui/file-icons.js';
import { iconMarkup } from './ui/icons.js';
import { openActionMenu } from './ui/action-menu.js';
import { toast } from './ui/toast.js';
import {
  authorizeExternalFile,
  copyAbsolutePath,
  copyRelativePath,
  hasEditorBridge,
  openInExternalEditor,
  openInSystemProgram,
  revealInFileManager,
  revokeExternalAccess,
} from './file-actions.js';
import { openFileReference } from './files-panel.js';

export const FILE_LINK_TOOLTIP_DELAY = 240;
const METADATA_TTL = 20_000;
const METADATA_LIMIT = 120;
const FIND_TTL = 20_000;
const FIND_LIMIT = 80;

let installed = false;
let hoverLink = null;
let hoverShowTimer = 0;
let hoverHideTimer = 0;
let hoverToken = 0;
let tip = null;
let tipFor = null;
let candidateObserver = null;
let candidateTimer = 0;
let cacheEpoch = 0;
const metadataCache = new Map();
const metadataInFlight = new Map();
const findCache = new Map();
const findInFlight = new Map();
const externalGrantCache = new Map();

const positiveInt = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const scopeOf = (value) => (typeof value === 'string' ? value : (value || null));
const sameScope = (a, b) => scopeOf(a) === scopeOf(b);

/** 从渲染出的锚点读回文件身份。DOM 里的路径本身不可信：
 *  必须重新走一遍解析；工作区外标记必须与解析结果一致。 */
export function fileMetaFromElement(link) {
  if (!link?.dataset) return null;
  const external = link.dataset.fileExternal === '1';
  const resolved = resolveFileReference(link.dataset.filePath || '', link.dataset.fileCwd || '', {
    allowExternal: external,
  });
  if (!resolved.ok) return null;
  if (external && !resolved.external) return null;
  const line = positiveInt(link.dataset.fileLine);
  const column = positiveInt(link.dataset.fileColumn);
  const endLine = positiveInt(link.dataset.fileEndLine);
  const endColumn = positiveInt(link.dataset.fileEndColumn);
  return {
    path: resolved.path,
    cwd: resolved.cwd,
    absolutePath: resolved.absolutePath,
    name: baseName(resolved.path),
    displayPath: link.dataset.fileDisplay || resolved.path,
    external: resolved.external,
    line,
    column,
    endLine,
    endColumn,
    position: positionLabel({ line, column, endLine, endColumn }),
    conversationId: link.dataset.fileConversation || null,
    grantId: link.dataset.fileGrant || '',
  };
}

function scopeMatches(meta) {
  return sameScope(meta?.conversationId || null, gitConversationScope() || null);
}

function displayAbsolute(meta, absolutePath) {
  const value = String(absolutePath || meta.absolutePath || '');
  return /^[A-Za-z]:[\\/]/.test(meta.cwd || '') ? value.replace(/\//g, '\\') : value;
}

function metadataKey(meta) {
  return `${meta.external ? 'external' : 'internal'}\u0000${meta.conversationId || ''}\u0000${meta.cwd || ''}\u0000${meta.path}`;
}

function findKey(meta) {
  return `${meta.conversationId || ''}\u0000${meta.cwd || ''}\u0000${meta.name}`;
}

function grantKey(meta) {
  return `${meta.conversationId || ''}\u0000${meta.path}`;
}

function rememberGrant(meta, grant) {
  if (!grant || typeof grant.id !== 'string') return;
  externalGrantCache.set(grantKey(meta), grant);
  if (typeof grant.target === 'string') {
    externalGrantCache.set(`${meta.conversationId || ''}\u0000${grant.target}`, grant);
  }
}

function knownGrant(meta) {
  return externalGrantCache.get(grantKey(meta)) || null;
}

function takeCachedMetadata(meta) {
  const key = metadataKey(meta);
  const hit = metadataCache.get(key);
  if (!hit) return null;
  if (hit.epoch !== cacheEpoch || Date.now() - hit.at > METADATA_TTL) {
    metadataCache.delete(key);
    return null;
  }
  return hit.value;
}

function rememberMetadata(meta, value) {
  if (!value || value.network || value.aborted) return;
  if (metadataCache.size >= METADATA_LIMIT) {
    const oldest = metadataCache.keys().next().value;
    if (oldest !== undefined) metadataCache.delete(oldest);
  }
  metadataCache.set(metadataKey(meta), { at: Date.now(), value, epoch: cacheEpoch });
}

function takeCachedFind(meta) {
  const key = findKey(meta);
  const hit = findCache.get(key);
  if (!hit) return null;
  if (hit.epoch !== cacheEpoch || Date.now() - hit.at > FIND_TTL) {
    findCache.delete(key);
    return null;
  }
  return hit.value;
}

function rememberFind(meta, value) {
  if (findCache.size >= FIND_LIMIT) {
    const oldest = findCache.keys().next().value;
    if (oldest !== undefined) findCache.delete(oldest);
  }
  findCache.set(findKey(meta), { at: Date.now(), value, epoch: cacheEpoch });
}

function abortInFlight(map) {
  for (const entry of map.values()) {
    try { entry.controller.abort(); } catch { /* already settled */ }
  }
  map.clear();
}

/** 工作区/会话变化：在途请求作废，缓存清空，候选重新检查。
 *  这比“切换时清缓存”多一道代次判断 —— 旧请求即使晚到也回填不进来。 */
function invalidateAll() {
  cacheEpoch++;
  abortInFlight(metadataInFlight);
  abortInFlight(findInFlight);
  metadataCache.clear();
  findCache.clear();
  externalGrantCache.clear();
  clearHover();
  for (const link of document.querySelectorAll('a.md-file-link[data-file-origin-candidate]')) {
    restoreCandidateOrigin(link);
  }
  for (const element of document.querySelectorAll('[data-file-candidate][data-file-checked]')) {
    element.removeAttribute('data-file-checked');
  }
  scheduleEnhance(0);
}

function invalidateExternalOnly() {
  cacheEpoch++;
  abortInFlight(metadataInFlight);
  metadataCache.clear();
  externalGrantCache.clear();
  /* 链接上的 data-file-grant 也是缓存：撤销后若继续带着旧 id，
   * 右键“系统默认程序/编辑器/复制路径”会直接 403，而不是重新走一次
   * 原生授权。普通点击本来就会重新授权，这里让所有入口保持一致。 */
  for (const link of document.querySelectorAll('a.md-file-link[data-file-grant]')) {
    link.removeAttribute('data-file-grant');
  }
  clearHover();
}

async function metadataFor(meta, { force = false } = {}) {
  if (!force) {
    const cached = takeCachedMetadata(meta);
    if (cached) return cached;
  }
  const key = metadataKey(meta);
  const existing = metadataInFlight.get(key);
  if (existing && existing.epoch === cacheEpoch) return existing.promise;
  if (existing) {
    try { existing.controller.abort(); } catch { /* settled */ }
    metadataInFlight.delete(key);
  }

  const controller = new AbortController();
  const epoch = cacheEpoch;
  const promise = (async () => {
    let result;
    if (meta.external) {
      const grant = knownGrant(meta);
      if (!grant) return { ok: false, code: 'external_authorization_required', error: '需要先授权访问这个文件。' };
      result = await fetchExternalFileMetadata(meta.path, grant.id, meta.conversationId, { signal: controller.signal });
      /* 撤销/工作区变化会推进 epoch 并清空授权缓存；迟到的成功响应不能把
       * 已撤销的 grant 又写回去。 */
      if (epoch === cacheEpoch && result?.ok && result.file?.grantId) {
        rememberGrant(meta, { ...grant, ...result.file, id: result.file.grantId });
      }
    } else {
      result = await fetchFileMetadata(meta.path, meta.conversationId, {
        root: meta.cwd,
        signal: controller.signal,
      });
      if (result?.ok && !isPathWithin(meta.cwd, result.file?.absolutePath || '')) {
        // 会话工作区已经变化（例如 worktree 被替换）。不要把新工作区里
        // 同名的文件当成链接指向的那个文件。
        result = { ok: false, code: 'workspace_changed', error: '工作区已经变化。' };
      }
    }
    if (epoch === cacheEpoch && !result?.aborted) rememberMetadata(meta, result);
    return result;
  })().finally(() => {
    if (metadataInFlight.get(key)?.controller === controller) metadataInFlight.delete(key);
  });
  metadataInFlight.set(key, { promise, controller, epoch });
  return promise;
}

async function findMatches(meta) {
  const cached = takeCachedFind(meta);
  if (cached) return cached;
  const key = findKey(meta);
  const existing = findInFlight.get(key);
  if (existing && existing.epoch === cacheEpoch) return existing.promise;
  if (existing) {
    try { existing.controller.abort(); } catch { /* settled */ }
    findInFlight.delete(key);
  }

  const controller = new AbortController();
  const epoch = cacheEpoch;
  const promise = (async () => {
    const result = await findWorkspaceFile(meta.name, meta.conversationId, {
      root: meta.cwd,
      signal: controller.signal,
    });
    if (result?.network || result?.aborted) return null;
    const value = result?.ok
      ? {
        ok: true,
        matches: Array.isArray(result.matches) ? result.matches.filter((item) => typeof item === 'string') : [],
        truncated: result.truncated === true,
      }
      : { ok: false, code: result?.code || 'find_failed', error: result?.error || '无法查询同名文件。' };
    if (epoch === cacheEpoch) rememberFind(meta, value);
    return value;
  })().finally(() => {
    if (findInFlight.get(key)?.controller === controller) findInFlight.delete(key);
  });
  findInFlight.set(key, { promise, controller, epoch });
  return promise;
}

function fileLabel(meta) {
  return fileLinkDisplayLabel(meta);
}

function chipElement(meta, { ambiguous = false, origin = null } = {}) {
  const link = document.createElement('a');
  link.href = '#';
  link.className = 'md-file-link' + (meta.external ? ' is-external' : '') + (ambiguous ? ' is-ambiguous' : '');
  link.dataset.fileLink = '1';
  if (ambiguous) {
    link.dataset.fileAmbiguous = '1';
    link.dataset.fileCandidate = meta.name;
  } else {
    link.dataset.filePath = meta.path;
    if (meta.external) {
      link.dataset.fileExternal = '1';
      link.dataset.fileDisplay = meta.displayPath || meta.path;
    }
  }
  /* 由裸文件名/纯文本候选升级来的链接保留来源。文件增删改名或工作区刷新时
   * 要退回候选重新确认，不能一直绑定旧的唯一匹配；歧义入口同样需要来源，
   * 否则刷新后无法重新判定它是变唯一了、还是文件已经消失。 */
  if (origin?.raw) {
    link.dataset.fileOriginCandidate = origin.raw;
    link.dataset.fileOriginVerify = origin.verify || (origin.plain ? 'metadata' : 'find');
    if (origin.plain) link.dataset.fileOriginPlain = '1';
  }
  link.dataset.fileCwd = meta.cwd || '';
  link.dataset.fileConversation = meta.conversationId || '';
  if (meta.line) link.dataset.fileLine = String(meta.line);
  if (meta.column) link.dataset.fileColumn = String(meta.column);
  if (meta.endLine) link.dataset.fileEndLine = String(meta.endLine);
  if (meta.endColumn) link.dataset.fileEndColumn = String(meta.endColumn);
  if (meta.grantId) link.dataset.fileGrant = meta.grantId;
  link.setAttribute('aria-label', ambiguous ? `${meta.name}，多个同名文件` : fileLinkDisplayLabel(meta));
  link.append(
    createFileIcon(document, meta.external ? meta.path : (ambiguous ? meta.name : meta.path)),
    Object.assign(document.createElement('span'), {
      className: 'md-file-name',
      textContent: ambiguous ? meta.name : fileLabel(meta),
    })
  );
  return link;
}

function candidateOrigin(element) {
  return {
    raw: element.dataset.fileCandidate || '',
    verify: element.dataset.fileVerify || '',
    plain: element.dataset.filePlain === '1',
  };
}

function restoreCandidateOrigin(link) {
  const raw = link.dataset.fileOriginCandidate;
  if (!raw) return false;
  const plain = link.dataset.fileOriginPlain === '1';
  const element = document.createElement(plain ? 'span' : 'code');
  element.className = plain ? 'md-file-plain-candidate' : 'md-file-candidate';
  element.dataset.fileCandidate = raw;
  element.dataset.fileCwd = link.dataset.fileCwd || '';
  element.dataset.fileConversation = link.dataset.fileConversation || '';
  element.dataset.fileVerify = link.dataset.fileOriginVerify || (plain ? 'metadata' : 'find');
  if (plain) element.dataset.filePlain = '1';
  for (const key of ['fileLine', 'fileColumn', 'fileEndLine', 'fileEndColumn']) {
    if (link.dataset[key]) element.dataset[key] = link.dataset[key];
  }
  element.textContent = raw;
  link.replaceWith(element);
  return true;
}

function metaForCandidate(element) {
  const cwd = element.dataset.fileCwd || '';
  const raw = element.dataset.fileCandidate || '';
  const meta = element.dataset.filePlain === '1'
    ? fileLinkFromPlainText(raw, cwd, { allowExternal: false, relative: true })
    : fileLinkFromInlineCode(raw, cwd, { allowExternal: false });
  if (!meta) return null;
  meta.conversationId = element.dataset.fileConversation || null;
  meta.line = positiveInt(element.dataset.fileLine) || meta.line;
  meta.column = positiveInt(element.dataset.fileColumn) || meta.column;
  meta.endLine = positiveInt(element.dataset.fileEndLine) || meta.endLine;
  meta.endColumn = positiveInt(element.dataset.fileEndColumn) || meta.endColumn;
  meta.position = positionLabel(meta);
  return meta;
}

function withResolvedMatch(meta, match) {
  const resolved = resolveFileReference(match, meta.cwd, { allowExternal: false });
  if (!resolved.ok) return null;
  return {
    ...meta,
    path: resolved.path,
    absolutePath: resolved.absolutePath,
    cwd: resolved.cwd,
    name: baseName(resolved.path),
    external: false,
    candidate: false,
    verification: '',
  };
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
  const unauthorizedExternal = meta.external && !knownGrant(meta);
  const result = unauthorizedExternal ? null : await metadataFor(meta);
  if (token !== hoverToken || hoverLink !== link || !link.isConnected) return;
  const element = ensureTip();
  const parts = [];
  if (unauthorizedExternal) {
    parts.push(meta.displayPath || meta.path, '工作区外 · 点击后授权');
  } else {
    parts.push(displayAbsolute(meta, result?.ok ? result.file?.absolutePath : ''));
    if (result?.ok && Number.isFinite(result.file?.bytes)) parts.push(fmtSize(result.file.bytes));
    if (!result?.ok && result?.code === 'file_missing') parts.push('文件不存在');
    if (!result?.ok && result?.code === 'workspace_changed') parts.push('工作区已经变化');
    if (meta.external && result?.ok) parts.push('工作区外 · 只读');
  }
  const range = meta.line ? `L${meta.line}${meta.endLine && meta.endLine !== meta.line ? `–${meta.endLine}` : ''}` : '';
  if (range) parts.push(range);
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

function actionRequest(meta, link = null) {
  return {
    path: meta.external ? meta.path : meta.path,
    cwd: meta.cwd,
    conversationId: meta.conversationId || null,
    fileId: meta.fileId || '',
    line: meta.line,
    column: meta.column,
    external: meta.external,
    grantId: (link?.dataset.fileGrant || meta.grantId || knownGrant(meta)?.id || ''),
  };
}

async function openExternalReference(meta, link = null) {
  if (!scopeMatches(meta)) {
    toast('这个文件引用属于其它会话，请先切换到那个会话。', 'warn');
    return false;
  }
  let grant = knownGrant(meta);
  if (!grant) {
    const epoch = cacheEpoch;
    const result = await authorizeExternalFile({
      path: meta.absolutePath || meta.path,
      conversationId: meta.conversationId || null,
      kind: 'file',
    });
    if (!result?.ok) {
      if (!result?.cancelled) toast(result?.error || '没有取得访问授权。', 'error');
      return false;
    }
    if (epoch !== cacheEpoch || !scopeMatches(meta)) {
      // 授权窗口打开期间会话/工作区变了；这次结果不能用于当前链接。
      return false;
    }
    grant = result.grant;
    rememberGrant(meta, grant);
  }
  if (link && grant?.id) link.dataset.fileGrant = grant.id;
  openFileReference({
    path: meta.absolutePath || meta.path,
    absolutePath: meta.absolutePath || meta.path,
    name: meta.name,
    displayPath: meta.displayPath || meta.path,
    external: true,
    grantId: grant.id,
    conversationId: meta.conversationId || null,
    line: meta.line,
    column: meta.column,
    endLine: meta.endLine,
    endColumn: meta.endColumn,
  });
  return true;
}

function openInternal(meta) {
  if (!scopeMatches(meta)) {
    toast('这个文件引用属于其它会话，请先切换到那个会话。', 'warn');
    return;
  }
  if (meta.external) {
    void openExternalReference(meta);
    return;
  }
  openFileReference(meta);
}

async function grantFolderFor(meta) {
  if (!scopeMatches(meta)) {
    toast('这个文件引用属于其它会话，请先切换到那个会话。', 'warn');
    return;
  }
  const epoch = cacheEpoch;
  const result = await authorizeExternalFile({
    path: meta.absolutePath || meta.path,
    conversationId: meta.conversationId || null,
    kind: 'directory',
  });
  if (!result?.ok) {
    if (!result?.cancelled) toast(result?.error || '没有取得文件夹授权。', 'error');
    return;
  }
  if (epoch !== cacheEpoch || !scopeMatches(meta)) return;
  rememberGrant(meta, result.grant);
  document.dispatchEvent(new window.CustomEvent('pi-gui:external-grants', { detail: { created: result.grant?.id } }));
  toast('已授权该文件夹，可以继续打开目录内的文件。', 'success', { important: true });
}

async function revokeForLink(meta, link) {
  const grant = knownGrant(meta);
  if (!grant) return;
  const result = await revokeExternalAccess({ grantId: grant.id, conversationId: meta.conversationId });
  if (!result?.ok) {
    toast(result?.error || '撤销失败', 'error');
    return;
  }
  externalGrantCache.delete(grantKey(meta));
  if (link) link.removeAttribute('data-file-grant');
  invalidateExternalOnly();
  toast('已撤销这个会话对该位置的访问授权。', 'success', { important: true });
}

function menuItems(meta, link) {
  const mismatch = !scopeMatches(meta);
  const request = actionRequest(meta, link);
  const external = meta.external;
  /* 菜单里的每个动作都会用链接自己的会话身份去后端解析；当焦点不在
   * 那个会话时，内部打开、编辑器、系统程序、文件管理器、复制路径和授权
   * 都必须一起拒绝，不能只拦住第一项而让其它入口绕开工作区身份。
   * 复制相对路径/完整路径也属于会暴露其它工作区内容的动作。 */
  const guard = (item) => mismatch
    ? { ...item, disabled: true, disabledReason: '这个文件引用属于其它会话' }
    : item;
  const items = [
    guard({
      label: '在文件面板中打开',
      icon: iconMarkup('eye'),
      onClick: () => openInternal(meta),
    }),
    guard({
      label: '用外部编辑器打开',
      icon: iconMarkup('external'),
      onClick: () => void openInExternalEditor(request),
    }),
    guard({
      label: '用系统默认程序打开',
      icon: iconMarkup('external'),
      onClick: () => void openInSystemProgram(request),
    }),
    guard({
      label: '在文件管理器中显示',
      icon: iconMarkup('folder'),
      onClick: () => void revealInFileManager(request),
    }),
  ];
  if (external) {
    items.push(guard({
      label: '授权所在文件夹…',
      icon: iconMarkup('folder'),
      onClick: () => void grantFolderFor(meta),
    }));
  }
  items.push({ separator: true });
  if (!external) {
    items.push(guard({
      label: '复制相对路径',
      icon: iconMarkup('copy'),
      onClick: () => void copyRelativePath(meta.path),
    }));
  }
  items.push(guard({
    label: '复制完整路径',
    icon: iconMarkup('copy'),
    onClick: () => void copyAbsolutePath(request),
  }));
  if (external && knownGrant(meta)) {
    items.push({ separator: true }, guard({
      label: '撤销此授权',
      icon: iconMarkup('trash'),
      danger: true,
      onClick: () => void revokeForLink(meta, link),
    }));
  }
  return items;
}

/* ---------- 同名文件选择 ---------- */

async function openSameNamePicker(link) {
  const meta = metaForCandidate(link);
  if (!meta?.candidate) return;
  if (!scopeMatches(meta)) {
    toast('这个文件引用属于其它会话，请先切换到那个会话。', 'warn');
    return;
  }
  const epoch = cacheEpoch;
  const result = await findMatches(meta);
  if (epoch !== cacheEpoch || !link.isConnected) return;
  if (!result?.ok) {
    toast(result?.error || '无法查询同名文件，请稍后再试。', 'warn');
    return;
  }
  const matches = result.matches.slice(0, 12);
  if (!matches.length) {
    toast('没有找到这个文件。', 'warn');
    return;
  }
  if (matches.length === 1 && !result.truncated) {
    chooseMatch(link, meta, matches[0]);
    return;
  }
  const items = matches.map((match) => ({
    label: match,
    icon: fileIconHtml(match),
    onClick: () => chooseMatch(link, meta, match),
  }));
  if (result.truncated) {
    items.push({ separator: true }, {
      label: '搜索未完成，可能还有其它同名文件',
      disabled: true,
      disabledReason: '',
    });
  } else if (result.matches.length > matches.length) {
    items.push({ separator: true }, {
      label: `还有 ${result.matches.length - matches.length} 个同名文件未显示`,
      disabled: true,
      disabledReason: '',
    });
  }
  openActionMenu(link, items);
}

function chooseMatch(link, meta, match) {
  const linked = withResolvedMatch(meta, match);
  if (!linked) {
    toast('这个文件已经不可用。', 'warn');
    return;
  }
  const replacement = chipElement(linked, { origin: candidateOrigin(link) });
  link.replaceWith(replacement);
  openInternal(linked);
}

/* ---------- 纯文件名 / 纯文本候选 ---------- */

/** 把候选原地升级成文件链接。
 *  - 裸文件名：后端确认唯一存在才升级；多匹配升级成“同名选择”入口；
 *  - 纯文本相对路径：后端 metadata 确认存在才升级；
 *  - 不存在/搜索不完整/暂时网络失败都保持原样。
 *  每批最多 24 个，处理完一批后若还有剩余就再排一批。 */
export async function enhanceFileCandidates(root = document, { auto = false } = {}) {
  if (!root?.querySelectorAll) return 0;
  const candidates = [...root.querySelectorAll(
    'code.md-file-candidate:not([data-file-checked]), span.md-file-plain-candidate:not([data-file-checked])',
  )].slice(0, 24);
  let upgraded = 0;
  let retry = false;
  for (const element of candidates) {
    const epoch = cacheEpoch;
    element.dataset.fileChecked = '1';
    const meta = metaForCandidate(element);
    if (!meta?.candidate) continue;
    if (element.dataset.fileVerify === 'metadata' || element.dataset.filePlain === '1') {
      const result = await metadataFor(meta);
      if (epoch !== cacheEpoch || !element.isConnected) {
        element.removeAttribute('data-file-checked');
        continue;
      }
      if (result?.network || result?.aborted) {
        element.removeAttribute('data-file-checked');
        retry = true;
        continue;
      }
      if (!result?.ok) continue;
      const linked = withResolvedMatch(meta, meta.path);
      if (!linked) continue;
      element.replaceWith(chipElement(linked, { origin: candidateOrigin(element) }));
      upgraded++;
      continue;
    }

    const result = await findMatches(meta);
    if (epoch !== cacheEpoch || !element.isConnected) {
      element.removeAttribute('data-file-checked');
      continue;
    }
    if (!result) {
      element.removeAttribute('data-file-checked');
      retry = true;
      continue;
    }
    if (!result.ok || result.truncated) continue;
    if (result.matches.length === 1) {
      const linked = withResolvedMatch(meta, result.matches[0]);
      if (!linked) continue;
      element.replaceWith(chipElement(linked, { origin: candidateOrigin(element) }));
      upgraded++;
    } else if (result.matches.length > 1) {
      // 歧义不自动打开第一个；只升级成入口，点击时再选。
      // 同样保留候选来源：文件增删后刷新要能重新判定唯一性。
      element.replaceWith(chipElement(meta, { ambiguous: true, origin: candidateOrigin(element) }));
      upgraded++;
    }
  }
  if (auto && root.querySelector?.(
    'code.md-file-candidate:not([data-file-checked]), span.md-file-plain-candidate:not([data-file-checked])',
  )) scheduleEnhance();
  else if (retry && auto) scheduleEnhance(4000);
  return upgraded;
}

function scheduleEnhance(delay = 320) {
  if (candidateTimer) clearTimeout(candidateTimer);
  candidateTimer = setTimeout(() => {
    candidateTimer = 0;
    void enhanceFileCandidates(document, { auto: true });
  }, delay);
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
    if (link.dataset.fileAmbiguous === '1') {
      void openSameNamePicker(link);
      return;
    }
    const meta = fileMetaFromElement(link);
    if (!meta) {
      toast('文件路径不可用。', 'warn');
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (!scopeMatches(meta)) {
        toast('这个文件引用属于其它会话，请先切换到那个会话。', 'warn');
        return;
      }
      void openInExternalEditor(actionRequest(meta, link));
      return;
    }
    if (meta.external) {
      void openExternalReference(meta, link);
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
    if (link.dataset.fileAmbiguous === '1') {
      void openSameNamePicker(link);
      return;
    }
    const meta = fileMetaFromElement(link);
    if (!meta) return;
    openActionMenu(link, menuItems(meta, link));
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
      if (link.dataset.fileAmbiguous === '1') {
        void openSameNamePicker(link);
        return;
      }
      const meta = fileMetaFromElement(link);
      if (meta) openActionMenu(link, menuItems(meta, link));
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
  // 工作区/会话换了，旧的唯一性结论、元数据与外部授权结论都不再成立；
  // 在途请求按代次丢弃，DOM 里已升级的候选重新检查。
  document.addEventListener('pi-gui:git-scope', invalidateAll);
  document.addEventListener('pi-gui:workspace-generation', invalidateAll);
  document.addEventListener('pi-gui:session-switch', invalidateAll);
  document.addEventListener('pi-gui:files-refresh', invalidateAll);
  document.addEventListener('pi-gui:external-grants', invalidateExternalOnly);

  if (typeof MutationObserver === 'function') {
    candidateObserver = new MutationObserver(() => scheduleEnhance());
    candidateObserver.observe(document.body, { childList: true, subtree: true });
  }
  scheduleEnhance();
}

/* 测试与“消息刚渲染完”时可直接调用；不依赖 observer 的时序。 */
export function resetFileLinkCaches() {
  invalidateAll();
}

/** 仅供测试断言容量策略；不暴露缓存内容给页面。 */
export function fileLinkCacheStats() {
  return {
    epoch: cacheEpoch,
    metadata: metadataCache.size,
    metadataInFlight: metadataInFlight.size,
    find: findCache.size,
    findInFlight: findInFlight.size,
    grants: externalGrantCache.size,
  };
}
