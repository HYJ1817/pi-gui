/* Files-only geometry. Never changes right-pane's remembered width or mode. */
import { createIcon } from './ui/icons.js';
export function createFilesLayout(host, { state = {}, onChange = () => {} } = {}) {
  let treeWidth = Math.max(140, Math.min(Number(state.treeWidth) || 220, 480));
  let treeVisible = state.treeVisible !== false;
  let narrow = false;
  let overlay = false;
  let endDrag = null;
  let alive = true;
  const layout = document.createElement('div');
  layout.className = 'files-layout';
  const sidebar = document.createElement('aside');
  sidebar.className = 'files-sidebar';
  sidebar.id = 'filesSidebar';
  sidebar.setAttribute('aria-label', '文件导航');
  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'files-tree-backdrop';
  backdrop.tabIndex = -1;
  backdrop.setAttribute('aria-label', '收起文件树');
  const divider = document.createElement('div');
  divider.className = 'files-tree-resizer';
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', '文件树宽度');
  divider.setAttribute('aria-valuemin', '140');
  divider.setAttribute('aria-valuemax', '480');
  const main = document.createElement('div');
  main.className = 'files-main';
  layout.append(backdrop, main, divider, sidebar);
  const treeButton = iconButton('切换文件树', 'panel');
  treeButton.classList.add('files-tree-toggle');
  treeButton.setAttribute('aria-controls', sidebar.id);

  function apply() {
    const shown = narrow ? overlay : treeVisible;
    host.classList.toggle('files-narrow', narrow);
    host.classList.toggle('files-tree-open', shown);
    sidebar.hidden = !shown;
    divider.hidden = !shown || narrow;
    backdrop.hidden = !shown || !narrow;
    main.inert = shown && narrow;
    treeButton.setAttribute('aria-expanded', String(shown));
    treeButton.setAttribute('aria-pressed', String(shown));
    divider.setAttribute('aria-valuenow', String(Math.round(treeWidth)));
    host.style.setProperty('--files-tree-width', `${treeWidth}px`);
  }
  function measure() {
    if (!alive) return;
    const width = host.getBoundingClientRect().width;
    const next = (width || window.innerWidth || 1024) < 620;
    if (next !== narrow) { narrow = next; overlay = false; }
    apply();
  }
  function hideOverlay({ focus = false } = {}) {
    if (!narrow || !overlay) return;
    overlay = false;
    apply();
    if (focus) treeButton.focus();
  }
  treeButton.onclick = () => {
    if (narrow) overlay = !overlay;
    else treeVisible = !treeVisible;
    apply();
    onChange();
    if (narrow && overlay) (sidebar.querySelector('[tabindex="0"]') || sidebar.querySelector('input'))?.focus();
  };
  backdrop.onclick = () => hideOverlay({ focus: true });
  sidebar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && narrow && overlay) {
      event.preventDefault(); event.stopPropagation(); hideOverlay({ focus: true });
    } else if (event.key === 'Tab' && narrow && overlay) {
      const items = [...sidebar.querySelectorAll('button:not([disabled]),input,[tabindex="0"]')].filter((element) => !element.closest('[hidden]'));
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  });
  function setWidth(width) {
    treeWidth = Math.round(Math.max(140, Math.min(width, 480, Math.max(140, host.getBoundingClientRect().width - 280))));
    apply();
  }
  divider.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setWidth(event.key === 'Home' ? 140 : event.key === 'End' ? 480 : treeWidth + (event.key === 'ArrowLeft' ? 16 : -16));
    onChange();
  };
  divider.onmousedown = (event) => {
    if (event.button !== 0 || narrow) return;
    event.preventDefault();
    endDrag?.();
    const startX = event.clientX;
    const width = treeWidth;
    host.classList.add('files-resizing');
    const move = (e) => setWidth(width + startX - e.clientX);
    const stop = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
      host.classList.remove('files-resizing');
      endDrag = null;
      onChange();
    };
    endDrag = stop;
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  observer?.observe(host);
  window.addEventListener('resize', measure);
  measure();
  return {
    element: layout, sidebar, main, treeButton, hideOverlay, measure,
    getState: () => ({ treeWidth, treeVisible }),
    dispose() {
      alive = false;
      endDrag?.(); observer?.disconnect();
      window.removeEventListener('resize', measure);
      host.classList.remove('files-narrow', 'files-tree-open', 'files-resizing');
      main.inert = false;
    },
  };
}

export function iconButton(label, icon) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(createIcon(icon));
  return button;
}
