/* Single preview lifecycle. Tabs retain descriptors, not decoded documents. */
import * as Api from '../api.js';
import { createAccess, previewTypeFor } from './access.js';
import { relativeRequest } from './relative.js';
import { node, button, loadStyle, shortError, formatBytes } from './common.js';
import { openActionMenu, closeActionMenu } from '../ui/action-menu.js';
import { copyRelativePath, copyAbsolutePath, openInSystemProgram, openInExternalEditor, revealInFileManager } from '../file-actions.js';

export const PREVIEW_REGISTRY = Object.freeze({
  text: { load: () => import('./text.js') },
  markdown: { load: () => import('./markdown.js') },
  html: { load: () => import('./html.js') },
  pdf: { load: () => import('./pdf.js') },
  office: { load: () => import('./office.js'), style: 'office.css' },
  image: { load: () => import('./image.js'), style: 'media-archive.css' },
  media: { load: () => import('./media.js'), style: 'media-archive.css' },
  archive: { load: () => import('./archive.js'), style: 'media-archive.css' },
});
const defaultTransport = {
  metadata: Api.fetchFileMetadata, externalMetadata: Api.fetchExternalFileMetadata,
  content: Api.fetchFilePreviewContent, externalContent: Api.fetchExternalFilePreviewContent,
  mediaUrl: Api.filePreviewMediaUrl,
};
const quietly = disposer => { try { disposer?.(); } catch { /* one failure cannot retain other resources */ } };

export function mountFilePreview(host, source, options = {}) {
  loadStyle('preview.css');
  const request = { ...source }, toolbar = options.toolbar || node('div', 'files-format-tools');
  const originalType = previewTypeFor(request.name || request.path);
  let disposed = false, active = null, state = options.state || {}, metadata = null, actionAnchor = null;
  let mode = originalType === 'markdown' && state.rendered === false ? 'text' : null;
  function release() {
    const run = active; active = null;
    if (actionAnchor?.getAttribute('aria-expanded') === 'true') closeActionMenu({ restoreFocus: false });
    actionAnchor = null;
    if (!run) return;
    run.abort.abort(); quietly(() => run.engine?.dispose?.());
    for (const dispose of run.owned) quietly(dispose);
    run.owned.clear(); for (const url of run.urls) URL.revokeObjectURL(url); run.urls.clear();
  }
  function appendFileMenu() {
    if (request.source || !request.path) return;
    const concrete = { ...request, fileId: metadata?.fileId || request.fileId };
    const more = button('文件操作', () => openActionMenu(more, [
      { label: '用系统默认程序打开', onClick: () => void openInSystemProgram(concrete) },
      { label: '用外部编辑器打开', onClick: () => void openInExternalEditor(concrete) },
      { label: '在文件管理器中显示', onClick: () => void revealInFileManager(concrete) },
      { separator: true },
      { label: '复制相对路径', disabled: request.external === true, onClick: () => void copyRelativePath(request.path) },
      { label: '复制完整路径', onClick: () => void copyAbsolutePath(concrete) },
    ]), { icon: 'more' });
    more.classList.add('fp-file-menu'); actionAnchor = more; toolbar.append(more);
  }
  function fallback(message) {
    if (disposed) return;
    release(); toolbar.replaceChildren(); appendFileMenu();
    const summary = node('p', 'files-preview-note fp-fallback', message || '此格式暂不支持内联预览。');
    summary.setAttribute('role', 'status'); host.replaceChildren(summary);
    if (metadata && Number.isFinite(metadata.bytes)) summary.append(node('span', 'fp-fallback-meta', `${metadata.name || ''} · ${formatBytes(metadata.bytes)}`));
    if (!request.source && request.path) {
      const open = button('用系统默认程序打开', () => void openInSystemProgram({ ...request, fileId: metadata?.fileId || request.fileId }));
      open.classList.add('files-preview-open'); host.append(open);
    }
  }
  function getState() {
    let position = {};
    try { position = active?.engine?.getState?.() || {}; } catch { /* cannot block closing */ }
    return { ...state, ...position, ...(originalType === 'markdown' ? { rendered: mode !== 'text' } : {}) };
  }
  async function start(typeOverride) {
    release();
    const run = { abort: new AbortController(), owned: new Set(), urls: new Set(), engine: null };
    active = run;
    const signal = run.abort.signal, current = () => !disposed && active === run && !signal.aborted;
    const own = disposer => { if (typeof disposer !== 'function') return; if (current()) run.owned.add(disposer); else quietly(disposer); };
    const loading = node('p', 'fp-loading', '正在打开文件…'); loading.setAttribute('role', 'status');
    host.replaceChildren(loading); toolbar.replaceChildren();
    try {
      const transport = options.transport || defaultTransport;
      const access = await createAccess(request, transport, signal);
      if (!current()) return;
      metadata = access.metadata; options.onMetadata?.(metadata);
      const type = typeOverride || access.type, entry = PREVIEW_REGISTRY[type];
      appendFileMenu();
      if (!entry) { fallback('这个格式暂不支持内联预览。'); return; }
      if (entry.style) loadStyle(entry.style);
      if (access.type === 'markdown') {
        const toggle = button(type === 'text' ? '渲染视图' : '源码', () => {
          state = getState(); mode = type === 'text' ? access.type : 'text'; state.rendered = mode !== 'text'; void start(mode);
        });
        toggle.classList.add('fp-source-toggle'); toolbar.append(toggle);
      }
      const plugin = await entry.load();
      if (!current()) return;
      host.replaceChildren();
      const resources = { signal, isCurrent: current, own,
        url(blob) { if (!current()) throw new Error('cancelled'); const url = URL.createObjectURL(blob); run.urls.add(url); return url; },
      };
      let relativeReads = 0, relativeBytes = 0;
      const ctx = {
        host, toolbar, request, meta: metadata, state, resources,
        resolve: href => relativeRequest(request, href),
        access: {
          bytes: cap => access.readAll(cap, signal),
          text: (cap, encoding) => access.text(cap, signal, encoding || 'auto'),
          async relative(href, maxBytes = 2 * 1024 * 1024) {
            const related = relativeRequest(request, href);
            if (!current() || !related || ++relativeReads > 32 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 2 * 1024 * 1024) throw new Error('relative_unavailable');
            const reader = await createAccess(related, transport, signal);
            if (!['image', 'text'].includes(reader.type) || reader.metadata.bytes > maxBytes || relativeBytes + reader.metadata.bytes > 16 * 1024 * 1024) throw new Error('relative_budget');
            relativeBytes += reader.metadata.bytes;
            const bytes = await reader.readAll(maxBytes, signal);
            if (!current()) throw new Error('cancelled');
            return { bytes, metadata: reader.metadata, request: related };
          },
          async url() {
            const url = await access.url(signal);
            if (url.startsWith('blob:')) run.urls.add(url);
            if (!current()) { if (url.startsWith('blob:')) URL.revokeObjectURL(url); throw new Error('cancelled'); }
            return url;
          },
        },
        open: value => current() ? options.onOpen?.(value) : undefined,
        error: message => { if (current()) fallback(message); },
      };
      const mounted = await plugin.mount(ctx);
      if (!current()) { quietly(() => mounted?.dispose?.()); return; }
      run.engine = mounted || {};
    } catch (error) {
      if (current()) {
        if (error?.metadata) { metadata = error.metadata; options.onMetadata?.(metadata); }
        fallback(shortError(error?.code));
      }
    }
  }
  const ready = start(mode);
  return { ready, getState, dispose() { if (disposed) return; disposed = true; release(); host.replaceChildren(); toolbar.replaceChildren(); } };
}
