import { createFileIcon } from './ui/file-icons.js';
import { createIcon } from './ui/icons.js';
import { openActionMenu } from './ui/action-menu.js';
import { positionLabel } from './file-link-model.js';
import { tabLabels } from './files-state.js';
import { iconButton } from './files-layout.js';

export function createFilesTabs({ getTabs, getActive, activate, close, reorder }) {
  const element = document.createElement('div');
  element.className = 'files-tabs';
  const list = document.createElement('div');
  list.className = 'files-tablist';
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', '打开的文件');
  const more = iconButton('文件标签菜单', 'more');
  more.classList.add('files-tabs-menu');
  element.append(list, more);
  let dragging = null;
  let menu = null;
  let previousActive = null;
  const focusTab = (key) => [...list.querySelectorAll('.files-tab-select')].find((button) => button.dataset.tabKey === key)?.focus();
  function showMenu(anchor, key) {
    const tabs = getTabs();
    const index = tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    menu?.close();
    menu = openActionMenu(anchor, [
      { label: '关闭当前标签', onClick: () => close([key], { focus: true }) },
      { label: '关闭其他标签', disabled: tabs.length < 2, onClick: () => close(tabs.filter((tab) => tab.key !== key).map((tab) => tab.key), { focus: true }) },
      { label: '关闭右侧标签', disabled: index === tabs.length - 1, onClick: () => close(tabs.slice(index + 1).map((tab) => tab.key), { focus: true }) },
      { separator: true },
      { label: '关闭全部标签', onClick: () => close(tabs.map((tab) => tab.key), { focus: true }) },
    ]);
  }
  more.onclick = () => showMenu(more, getActive());
  list.onwheel = (event) => {
    if (!event.deltaY || list.scrollWidth <= list.clientWidth) return;
    event.preventDefault();
    list.scrollLeft += event.deltaY;
  };
  function render({ focus = false } = {}) {
    const tabs = getTabs();
    const key = getActive();
    const labels = tabLabels(tabs);
    const scroll = list.scrollLeft;
    const focusKey = document.activeElement?.closest('.files-tab')?.querySelector('.files-tab-select')?.dataset.tabKey;
    list.replaceChildren();
    element.hidden = tabs.length === 0;
    for (const tab of tabs) {
      const request = tab.request;
      const item = document.createElement('div');
      item.className = 'files-tab';
      item.dataset.fileTab = request.path || request.name;
      item.setAttribute('aria-selected', String(tab.key === key));
      item.draggable = true;
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'files-tab-select';
      select.dataset.tabKey = tab.key;
      select.id = tab.id;
      select.tabIndex = tab.key === key ? 0 : -1;
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(tab.key === key));
      select.setAttribute('aria-controls', 'filesPreviewPanel');
      select.title = (request.path || request.name) + (request.line ? positionLabel(request) : '');
      const label = document.createElement('span');
      label.className = 'files-tab-label';
      label.textContent = labels.get(tab.key);
      select.append(createFileIcon(document, request.path || request.name, 'file-kind-icon'), label);
      if (request.line) {
        const position = document.createElement('span');
        position.className = 'files-tab-position';
        position.textContent = positionLabel(request);
        select.append(position);
      }
      select.onclick = () => activate(tab.key);
      select.onkeydown = (event) => {
        const index = getTabs().findIndex((other) => other.key === tab.key);
        const order = getTabs();
        if ((event.key === 'Delete' || (event.key.toLowerCase() === 'w' && (event.ctrlKey || event.metaKey)))) {
          event.preventDefault(); event.stopPropagation(); close([tab.key], { focus: true }); return;
        }
        if (event.key === 'F10' && event.shiftKey) {
          event.preventDefault(); showMenu(select, tab.key); return;
        }
        let next = null;
        if (event.key === 'ArrowRight') next = (index + 1) % order.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + order.length) % order.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = order.length - 1;
        if (next === null) return;
        event.preventDefault();
        if (event.altKey && event.shiftKey) reorder(tab.key, order[next].key);
        else activate(order[next].key);
        focusTab(event.altKey && event.shiftKey ? tab.key : order[next].key);
      };
      const remove = iconButton(`关闭 ${request.name || request.path}`, 'close');
      remove.classList.add('files-tab-close');
      remove.tabIndex = -1;
      remove.onclick = (event) => { event.stopPropagation(); close([tab.key], { focus: item.contains(document.activeElement) }); };
      item.oncontextmenu = (event) => { event.preventDefault(); showMenu(select, tab.key); };
      item.onauxclick = (event) => { if (event.button === 1) { event.preventDefault(); close([tab.key]); } };
      item.ondragstart = (event) => {
        if (event.target?.closest('.files-tab-close')) { event.preventDefault(); return; }
        dragging = tab.key;
        item.classList.add('is-dragging');
        if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', tab.id); }
      };
      item.ondragover = (event) => {
        if (!dragging || dragging === tab.key) return;
        event.preventDefault(); item.classList.add('is-drop-target');
      };
      item.ondragleave = () => item.classList.remove('is-drop-target');
      item.ondrop = (event) => {
        event.preventDefault();
        if (dragging) reorder(dragging, tab.key);
        dragging = null;
      };
      item.ondragend = () => { dragging = null; for (const child of list.children) child.classList.remove('is-dragging', 'is-drop-target'); };
      item.append(select, remove);
      list.append(item);
    }
    list.scrollLeft = scroll;
    if (key !== previousActive) {
      [...list.children].find((item) => item.getAttribute('aria-selected') === 'true')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    previousActive = key;
    if (focus || focusKey) focusTab(focus ? key : focusKey);
  }
  return { element, render, focus: focusTab, dispose() { menu?.close(); dragging = null; } };
}
