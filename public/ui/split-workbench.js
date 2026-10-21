/* Optional two-surface workbench: Specs above, Git Changes below.
 *
 * This module owns layout only. Specs and Changes keep their existing state,
 * request guards, Markdown renderer and Git authority in their own modules.
 */
import { openSecondarySurface } from './secondary-surface.js';
import { mountSpecsPanel, openSpecsPanel } from '../specs-panel.js';
import { mountChangesPanel, openChangesPanel } from '../git.js';

const STORAGE_KEY = 'pi-gui.workbench.split.v1';
const DEFAULT_RATIO = 0.56;
const MIN_PANE_HEIGHT = 220;
const MIN_SPLIT_WIDTH = 900;
const SPLITTER_SIZE = 8;
const MIN_SPLIT_HEIGHT = MIN_PANE_HEIGHT * 2 + SPLITTER_SIZE;

export const SPLIT_WORKBENCH_LIMITS = Object.freeze({
  defaultRatio: DEFAULT_RATIO,
  minPaneHeight: MIN_PANE_HEIGHT,
  minHeight: MIN_SPLIT_HEIGHT,
  splitterSize: SPLITTER_SIZE,
  minWindowWidth: MIN_SPLIT_WIDTH,
});

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const button = (className, text, label, run) => {
  const element = node('button', className, text);
  element.type = 'button';
  if (label) element.setAttribute('aria-label', label);
  element.onclick = run;
  return element;
};

export function normalizeSplitRatio(value) {
  if (value === Number.POSITIVE_INFINITY) return 0.8;
  if (value === Number.NEGATIVE_INFINITY) return 0.2;
  const ratio = Number(value);
  return Number.isFinite(ratio) ? Math.min(0.8, Math.max(0.2, ratio)) : DEFAULT_RATIO;
}

export function clampSplitRatio(value, height) {
  const ratio = normalizeSplitRatio(value);
  const total = Number(height);
  if (!Number.isFinite(total) || total < MIN_SPLIT_HEIGHT) return ratio;
  const usable = total - SPLITTER_SIZE;
  const min = MIN_PANE_HEIGHT / usable;
  const max = 1 - min;
  return Math.min(max, Math.max(min, ratio));
}

export function splitRatioAt(clientY, rect) {
  const top = Number(rect?.top);
  const height = Number(rect?.height);
  if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return DEFAULT_RATIO;
  return normalizeSplitRatio((Number(clientY) - top) / height);
}

function readStoredRatio() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return normalizeSplitRatio(raw?.ratio);
  } catch {
    return DEFAULT_RATIO;
  }
}

function storeRatio(ratio) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ratio: Number(ratio.toFixed(4)) }));
  } catch {
    /* Storage being unavailable must not make the workbench unusable. */
  }
}

function hostHeight(host) {
  const rect = host.getBoundingClientRect?.();
  return Math.max(0, Number(rect?.height) || Number(host.clientHeight) || 0);
}

export function openSplitWorkbench({
  returnSurface = 'specs',
  specsOptions = {},
  changesOptions = {},
} = {}) {
  const triggerId = returnSurface === 'changes' ? 'navChanges' : 'btnSpecs';
  const instance = openSecondarySurface(
    'workbench-split',
    (host, view) => mountSplitWorkbench(host, view, {
      returnSurface,
      specsOptions,
      changesOptions,
    }),
    { label: 'Specs 与文件变更工作台', headerSelector: '.rp-head', triggerId }
  );
  return instance;
}

export function mountSplitWorkbench(host, view, {
  returnSurface = 'specs',
  specsOptions = {},
  changesOptions = {},
} = {}) {
  host.classList.add('workbench-split');
  let storedRatio = readStoredRatio();
  let activeFallback = returnSurface === 'changes' ? 'changes' : 'specs';
  let fallback = false;
  let dragMove = null;
  let dragUp = null;

  const modebar = node('div', 'workbench-modebar');
  modebar.setAttribute('role', 'group');
  modebar.setAttribute('aria-label', '工作台视图');
  const specsTab = button('workbench-tab', 'Specs', '显示 Specs', () => selectFallback('specs'));
  specsTab.dataset.workbenchTab = 'specs';
  const changesTab = button('workbench-tab', 'Changes', '显示文件变更', () => selectFallback('changes'));
  changesTab.dataset.workbenchTab = 'changes';
  const modeGrow = node('span', 'workbench-grow');
  const modeExit = button('btn tiny workbench-exit', '退出', '退出分屏，恢复单面板', () => exitSplit());
  modeExit.dataset.workbenchExit = 'true';
  const modeClose = button('icon-btn workbench-close', '×', '关闭工作台', () => view.close());
  modebar.append(specsTab, changesTab, modeGrow, modeExit, modeClose);
  modebar.hidden = true;

  const specsPane = node('section', 'workbench-pane workbench-pane-specs');
  specsPane.id = 'workbenchSpecsPane';
  specsPane.setAttribute('aria-label', 'Specs 与 Changes 分屏');
  const changesPane = node('section', 'workbench-pane workbench-pane-changes');
  changesPane.id = 'workbenchChangesPane';
  changesPane.setAttribute('aria-label', 'Specs 与 Changes 分屏');

  const splitter = node('div', 'workbench-splitter');
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'horizontal');
  splitter.setAttribute('aria-label', '调整 Specs 与文件变更的高度');
  splitter.setAttribute('aria-controls', 'workbenchSpecsPane workbenchChangesPane');
  splitter.tabIndex = 0;
  splitter.append(node('span', 'workbench-splitter-grip'));

  host.append(modebar, specsPane, splitter, changesPane);
  specsPane.style.flex = '0 0 calc(56% - 4px)';
  changesPane.style.flex = '1 1 0';

  const exitAction = button('btn rp-btn workbench-exit', '退出', '退出分屏，恢复单面板', () => exitSplit());
  exitAction.dataset.workbenchExit = 'true';
  mountSpecsPanel(specsPane, view, {
    ...specsOptions,
    extraActions: [...(specsOptions.extraActions || []), exitAction],
  });
  mountChangesPanel(changesPane, view, changesOptions);

  function selectFallback(next) {
    activeFallback = next === 'changes' ? 'changes' : 'specs';
    applyLayout();
  }

  function exitSplit() {
    const target = fallback ? activeFallback : returnSurface;
    if (target === 'changes') openChangesPanel(changesOptions);
    else openSpecsPanel(specsOptions);
  }

  function syncA11y(height, ratio) {
    const usable = Math.max(1, height - SPLITTER_SIZE);
    const min = Math.min(50, Math.max(20, Math.round(MIN_PANE_HEIGHT / usable * 100)));
    const max = 100 - min;
    const now = Math.round(ratio * 100);
    splitter.setAttribute('aria-valuemin', String(min));
    splitter.setAttribute('aria-valuemax', String(max));
    splitter.setAttribute('aria-valuenow', String(now));
    splitter.setAttribute('aria-valuetext', `Specs ${now}% / Changes ${100 - now}%`);
  }

  function applyLayout() {
    if (!view.isCurrent()) return;
    const height = hostHeight(host);
    const active = document.activeElement;
    fallback = window.innerWidth < MIN_SPLIT_WIDTH || (height > 0 && height < MIN_SPLIT_HEIGHT);
    host.classList.toggle('is-fallback', fallback);
    host.dataset.workbenchMode = fallback ? 'fallback' : 'split';
    modebar.hidden = !fallback;

    if (fallback) {
      endDrag();
      splitter.hidden = true;
      specsPane.hidden = activeFallback !== 'specs';
      changesPane.hidden = activeFallback !== 'changes';
      if (active === splitter || active?.matches('.secondary-close, .workbench-pane-specs .workbench-exit') ||
        (specsPane.hidden && specsPane.contains(active)) || (changesPane.hidden && changesPane.contains(active))) {
        (activeFallback === 'specs' ? specsTab : changesTab).focus();
      }
      specsPane.style.flex = '1 1 auto';
      changesPane.style.flex = '1 1 auto';
      specsTab.setAttribute('aria-pressed', String(activeFallback === 'specs'));
      changesTab.setAttribute('aria-pressed', String(activeFallback === 'changes'));
      return;
    }

    splitter.hidden = false;
    specsPane.hidden = false;
    changesPane.hidden = false;
    if (modebar.contains(active)) splitter.focus();
    specsTab.setAttribute('aria-pressed', 'false');
    changesTab.setAttribute('aria-pressed', 'false');
    const ratio = clampSplitRatio(storedRatio, height);
    if (height > 0) {
      const usable = Math.max(0, height - SPLITTER_SIZE);
      const top = Math.round(usable * ratio);
      specsPane.style.flex = `0 0 ${top}px`;
      changesPane.style.flex = '1 1 0';
      syncA11y(height, ratio);
    }
  }

  function setRatio(next, persist = false) {
    const height = hostHeight(host);
    storedRatio = clampSplitRatio(next, height);
    applyLayout();
    if (persist) storeRatio(storedRatio);
  }

  function moveBy(deltaRatio, persist) {
    const height = Math.max(1, hostHeight(host));
    setRatio(storedRatio + deltaRatio * (height / Math.max(1, height - SPLITTER_SIZE)), persist);
  }

  function onDragStart(event) {
    if (fallback || !view.isCurrent() || (event.button !== undefined && event.button !== 0)) return;
    event.preventDefault();
    endDrag();
    const rect = host.getBoundingClientRect();
    splitter.classList.add('is-dragging');
    document.body.classList.add('workbench-resizing');
    dragMove = (moveEvent) => setRatio(splitRatioAt(moveEvent.clientY, rect));
    dragUp = () => {
      endDrag();
      storeRatio(storedRatio);
    };
    document.addEventListener('mousemove', dragMove);
    document.addEventListener('mouseup', dragUp);
  }

  function endDrag() {
    if (dragMove) document.removeEventListener('mousemove', dragMove);
    if (dragUp) document.removeEventListener('mouseup', dragUp);
    dragMove = null;
    dragUp = null;
    splitter.classList.remove('is-dragging');
    document.body.classList.remove('workbench-resizing');
  }

  splitter.addEventListener('mousedown', onDragStart);
  splitter.addEventListener('dblclick', () => setRatio(DEFAULT_RATIO, true));
  splitter.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 80 : 24;
    const height = Math.max(1, hostHeight(host));
    if (event.key === 'ArrowUp') moveBy(-step / height, true);
    else if (event.key === 'ArrowDown') moveBy(step / height, true);
    else if (event.key === 'Home') setRatio(Number.NEGATIVE_INFINITY, true);
    else if (event.key === 'End') setRatio(Number.POSITIVE_INFINITY, true);
    else if (event.key === 'Enter' || event.key === ' ') setRatio(DEFAULT_RATIO, true);
    else return;
    event.preventDefault();
  });

  const onResize = () => applyLayout();
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', endDrag);
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  observer?.observe(host);

  view.onDispose(() => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', endDrag);
    observer?.disconnect();
    endDrag();
    specsPane.replaceChildren();
    changesPane.replaceChildren();
  });

  instanceMethods(view, {
    measure: applyLayout,
    snapshot: () => ({
      mode: fallback ? 'fallback' : 'split',
      activeFallback,
      ratio: clampSplitRatio(storedRatio, hostHeight(host)),
      storedRatio,
    }),
    setRatio: (ratio, persist = false) => setRatio(ratio, persist),
  });

  queueMicrotask(applyLayout);
}

/* Keep the public instance small while making layout testable without relying
 * on jsdom's zero-sized layout engine. */
function instanceMethods(instance, methods) {
  Object.defineProperties(instance, {
    measureWorkbenchLayout: { value: methods.measure, configurable: true },
    workbenchSnapshot: { value: methods.snapshot, configurable: true },
    setWorkbenchRatio: { value: methods.setRatio, configurable: true },
  });
}
