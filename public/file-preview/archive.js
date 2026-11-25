import { node, button, searchControl, formatBytes } from './common.js';
import { inspectZip, ZIP_LIMITS } from './zip-policy.js';

import { archivePreviewLimit } from './archive-policy.js';
export { archivePreviewLimit };

function treeFor(entries) {
  const root = { name: '', children: new Map() };
  for (const entry of entries) {
    const parts = entry.name.replace(/\/$/, '').split('/');
    let parent = root;
    let path = '';
    for (let index = 0; index < parts.length; index++) {
      path += parts[index] + (index < parts.length - 1 || entry.directory ? '/' : '');
      let item = parent.children.get(parts[index]);
      if (!item) {
        item = { name: parts[index], path, directory: index < parts.length - 1 || entry.directory, children: new Map() };
        parent.children.set(parts[index], item);
      }
      if (index === parts.length - 1) item.entry = entry;
      parent = item;
    }
  }
  return root;
}

export async function mount(ctx) {
  let disposed = false;
  let zip;
  let root;
  let search = '';
  let selected = '';
  const expanded = new Set(Array.isArray(ctx.state?.expanded) ? ctx.state.expanded.filter(path => typeof path === 'string').slice(0, 4096) : []);
  const current = () => !disposed && !ctx.resources.signal.aborted && ctx.resources.isCurrent();
  const rowListeners = [];
  const clearRows = () => rowListeners.splice(0).forEach(remove => remove());
  const rowListen = (target, type, fn) => {
    target.addEventListener(type, fn);
    rowListeners.push(() => target.removeEventListener(type, fn));
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearRows();
    zip = null;
    root = null;
  };
  const handle = { dispose, getState: () => ({ search, selected, expanded: Array.from(expanded).slice(0, 4096) }) };
  ctx.resources.own(dispose);
  try {
    const bytes = await ctx.access.bytes(ZIP_LIMITS.maxArchiveBytes);
    if (!current()) return handle;
    zip = inspectZip(bytes);
    root = treeFor(zip.entries);
    const wrapper = node('section', 'fp-archive');
    wrapper.setAttribute('aria-label', '压缩包目录');
    const total = zip.entries.reduce((sum, entry) => sum + entry.size, 0);
    const summary = node('div', 'fp-archive-summary', `${zip.entries.length} 个条目 · 声明大小 ${formatBytes(total)} · 文件大小 ${formatBytes(bytes.length)}`);
    const listing = node('div', 'fp-archive-listing');
    const selection = node('div', 'fp-archive-selection');
    const status = node('p', 'fp-archive-status');
    status.setAttribute('role', 'status');
    const name = node('span', 'fp-archive-selected-name', '选择文件查看元数据');
    const sizes = node('span', 'fp-archive-selected-size');
    const open = button('预览文件', async () => {
      if (!current() || !selected || !zip) return;
      const entry = zip.entries.find(item => item.name === selected);
      const cap = entry && archivePreviewLimit(entry);
      if (!cap) return;
      open.disabled = true;
      try {
        const data = zip.read(entry.name, cap);
        if (!current()) return;
        const result = ctx.open({ source: 'archive', name: entry.name.split('/').pop(), bytes: data, archiveEntry: entry.name, parent: ctx.request });
        await result;
        if (current()) status.textContent = '';
      } catch {
        if (current()) status.textContent = '此条目无法安全预览。';
      } finally {
        if (current()) {
          const latest = zip.entries.find(item => item.name === selected);
          open.disabled = !latest || !archivePreviewLimit(latest);
        }
      }
    });
    open.disabled = true;
    selection.append(name, sizes, open);
    wrapper.append(summary, listing, selection, status);
    ctx.host.append(wrapper);
    function select(entry) {
      if (!current()) return;
      selected = entry.name;
      name.textContent = entry.name;
      name.title = entry.name;
      sizes.textContent = `声明大小 ${formatBytes(entry.size)} · 压缩后 ${formatBytes(entry.compressedSize)}`;
      open.disabled = !archivePreviewLimit(entry);
      status.textContent = open.disabled ? '此类型或大小仅显示目录与元数据，不解压到磁盘。' : '';
      listing.querySelectorAll('[aria-pressed]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.entry === selected)));
    }
    function fileRow(entry, label) {
      const item = node('li', 'fp-archive-file');
      const choose = button(label || entry.name.split('/').pop(), () => select(entry));
      choose.classList.add('fp-archive-entry');
      choose.title = entry.name;
      choose.dataset.entry = entry.name;
      choose.setAttribute('aria-pressed', String(entry.name === selected));
      const size = node('span', 'fp-archive-entry-size', formatBytes(entry.size));
      item.append(choose, size);
      return item;
    }
    function directoryList(directory) {
      const list = node('ul', 'fp-archive-tree');
      const children = Array.from(directory.children.values()).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      for (const item of children) {
        if (!item.directory) { list.append(fileRow(item.entry, item.name)); continue; }
        const li = node('li', 'fp-archive-directory');
        const details = node('details', 'fp-archive-folder');
        const heading = node('summary', 'fp-archive-folder-name', item.name);
        heading.title = item.path;
        details.open = expanded.has(item.path);
        details.append(heading);
        let childList;
        const populate = () => {
          if (!childList) { childList = directoryList(item); details.append(childList); }
        };
        if (details.open) populate();
        rowListen(details, 'toggle', () => {
          if (!current()) return;
          if (details.open) { expanded.add(item.path); populate(); }
          else expanded.delete(item.path);
        });
        li.append(details);
        list.append(li);
      }
      return list;
    }
    function render() {
      if (!current()) return;
      clearRows();
      listing.replaceChildren();
      if (search) {
        const matches = zip.entries.filter(entry => !entry.directory && entry.name.toLowerCase().includes(search.toLowerCase()));
        const list = node('ul', 'fp-archive-tree fp-archive-results');
        matches.slice(0, 200).forEach(entry => list.append(fileRow(entry, entry.name)));
        listing.append(list);
        if (!matches.length) listing.append(node('p', 'fp-archive-empty', '没有匹配的文件。'));
        status.textContent = matches.length > 200 ? `找到 ${matches.length} 个文件，仅显示前 200 个。` : '';
      } else if (!zip.entries.length) listing.append(node('p', 'fp-archive-empty', '压缩包为空。'));
      else listing.append(directoryList(root));
    }
    // One bounded search belongs to this archive; it cannot trigger disk scans.
    const input = searchControl(ctx.toolbar, value => {
      search = String(value ?? '').slice(0, 256);
      render();
    });
    input.setAttribute('aria-label', '查找压缩包中的文件');
    input.maxLength = 256;
    search = typeof ctx.state?.search === 'string' ? ctx.state.search.slice(0, 256) : '';
    input.value = search;
    render();
    if (typeof ctx.state?.selected === 'string') {
      const entry = zip.entries.find(item => item.name === ctx.state.selected && !item.directory);
      if (entry) select(entry);
    }
  } catch (error) {
    if (current()) ctx.error(error?.code?.startsWith('zip_') ? '压缩包无法安全预览；仅支持未加密的普通 ZIP。' : '压缩包读取失败。');
  }
  return handle;
}
