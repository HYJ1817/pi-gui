/* Trigger-anchored floating surface for settings pickers.
 *
 * Settings cards live inside scrolling containers, so an absolutely
 * positioned child would be clipped. The menu is portaled to document.body
 * as a fixed layer, measured while hidden, then revealed with `is-open`.
 * Placement prefers below-start/end, flips above when the viewport is tight,
 * and is clamped inside the visual viewport.
 *
 * Lifecycle: one menu at a time is owned by the caller's controller. Closing
 * removes every listener; `destroy()` is safe to call from a settings page
 * disposal path and also releases a currently open menu.
 */

let nextId = 0;
const GAP = 6;
const MARGIN = 8;

function viewportSize() {
  return {
    width: globalThis.document?.documentElement?.clientWidth || globalThis.innerWidth || 0,
    height: globalThis.document?.documentElement?.clientHeight || globalThis.innerHeight || 0
  };
}

export function createAnchoredMenu({
  anchor,
  className = '',
  label = '',
  role = 'listbox',
  align = 'end',
  gap = GAP,
  margin = MARGIN,
  initialFocus = 'input',
  onClose = null,
  build = () => {}
} = {}) {
  let menu = null;
  let id = '';
  let isOpen = false;
  let frame = 0;
  let observer = null;
  let listeners = null;
  let closedBy = 'api';

  function menuId() {
    if (!id) id = `piAnchoredMenu${++nextId}`;
    return id;
  }

  function focusInitial() {
    if (!menu || initialFocus === 'none') return;
    let target = null;
    if (initialFocus === 'input') target = menu.querySelector('input:not([disabled])');
    else if (initialFocus === 'selected') target = menu.querySelector('[aria-selected="true"]:not([disabled])');
    if (!target) target = menu.querySelector('button:not([disabled]), input:not([disabled])');
    target?.focus();
  }

  function reposition() {
    if (!menu || !anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const view = viewportSize();
    if (rect.bottom <= 0 || rect.top >= view.height) {
      close({ restoreFocus: false });
      return;
    }
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const maxLeft = Math.max(margin, view.width - width - margin);
    const preferredLeft = align === 'end' ? rect.right - width : rect.left;
    const left = Math.min(Math.max(margin, preferredLeft), maxLeft);
    const below = rect.bottom + gap;
    const above = rect.top - height - gap;
    const maxTop = Math.max(margin, view.height - height - margin);
    const top = below <= maxTop
      ? Math.max(margin, below)
      : above >= margin
        ? above
        : Math.min(Math.max(margin, below), maxTop);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.classList.add('is-open');
  }

  function schedulePosition() {
    if (frame) return;
    frame = globalThis.requestAnimationFrame?.(() => {
      frame = 0;
      reposition();
    }) ?? 0;
    if (!frame) reposition();
  }

  function onPointerDown(event) {
    if (!menu) return;
    const target = event.target;
    if (menu.contains(target) || anchor?.contains(target)) return;
    close({ restoreFocus: false });
  }

  function onKeyDown(event) {
    if (!menu) return;
    // Escape/Tab during IME composition belong to the composition, not the menu.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true, reason: 'escape' });
      return;
    }
    if (event.key === 'Tab') {
      /* The menu owns Tab until it closes. Stop here so a modal focus trap
       * behind it does not also wrap focus in the same keystroke. */
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true, reason: 'tab' });
    }
  }

  function onViewportChange(event) {
    if (!menu) return;
    const target = event?.target;
    if (target && typeof target.nodeType === 'number' && menu.contains(target)) return;
    reposition();
  }

  function removeListeners() {
    if (!listeners) return;
    globalThis.removeEventListener('mousedown', listeners.pointer, true);
    globalThis.removeEventListener('keydown', listeners.key, true);
    globalThis.removeEventListener('resize', listeners.viewport);
    globalThis.removeEventListener('scroll', listeners.viewport, true);
    globalThis.document?.removeEventListener('pi-gui:workspace-view', listeners.workspace);
    listeners = null;
    observer?.disconnect();
    observer = null;
    if (frame) {
      globalThis.cancelAnimationFrame?.(frame);
      frame = 0;
    }
  }

  function open() {
    if (isOpen || !anchor?.isConnected) return false;
    closedBy = 'api';
    menu = globalThis.document.createElement('div');
    menu.id = menuId();
    menu.className = `pi-anchored-menu ${className}`.trim();
    menu.setAttribute('role', role);
    if (label) menu.setAttribute('aria-label', label);
    menu.hidden = false;
    globalThis.document.body.appendChild(menu);
    build(menu);
    anchor.setAttribute('aria-haspopup', role);
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', menu.id);
    isOpen = true;

    listeners = {
      pointer: onPointerDown,
      key: onKeyDown,
      viewport: onViewportChange,
      workspace: () => close({ restoreFocus: false, reason: 'workspace' })
    };
    globalThis.addEventListener('mousedown', listeners.pointer, true);
    globalThis.addEventListener('keydown', listeners.key, true);
    globalThis.addEventListener('resize', listeners.viewport);
    globalThis.addEventListener('scroll', listeners.viewport, true);
    globalThis.document?.addEventListener('pi-gui:workspace-view', listeners.workspace);
    if (globalThis.ResizeObserver) {
      observer = new globalThis.ResizeObserver(() => reposition());
      observer.observe(menu);
      observer.observe(anchor);
    }
    reposition();
    schedulePosition();
    scheduleFocus();
    return true;
  }

  let focusFrame = 0;
  function scheduleFocus() {
    focusFrame = globalThis.requestAnimationFrame?.(() => {
      focusFrame = 0;
      if (isOpen) focusInitial();
    }) ?? 0;
    if (!focusFrame) focusInitial();
  }

  function close({ restoreFocus = true, reason = 'api' } = {}) {
    if (!isOpen) return;
    isOpen = false;
    closedBy = reason;
    const node = menu;
    menu = null;
    removeListeners();
    if (focusFrame) {
      globalThis.cancelAnimationFrame?.(focusFrame);
      focusFrame = 0;
    }
    anchor?.setAttribute('aria-expanded', 'false');
    // The anchor must not keep pointing at a menu node that was just removed.
    anchor?.removeAttribute('aria-controls');
    node?.remove();
    try { onClose?.(reason); } catch { /* Caller cleanup must not prevent close. */ }
    if (restoreFocus && anchor?.isConnected) {
      try { anchor.focus(); } catch { /* Detached anchors cannot take focus. */ }
    }
  }

  function destroy() {
    close({ restoreFocus: false, reason: 'destroy' });
    anchor?.removeAttribute('aria-haspopup');
    anchor?.removeAttribute('aria-expanded');
    anchor?.removeAttribute('aria-controls');
  }

  return {
    open,
    close,
    destroy,
    reposition,
    isOpen: () => isOpen,
    element: () => menu,
    closeReason: () => closedBy
  };
}
