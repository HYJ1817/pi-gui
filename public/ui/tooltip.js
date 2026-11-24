/* Small design-system tooltip for icon-only conversation actions.
 *
 * The trigger keeps its own accessible name; the tooltip is visual only, so we
 * never duplicate the label through title/aria-describedby. It opens on hover
 * and keyboard focus, closes on pointer leave, blur, Escape, scroll or resize.
 * Geometry is fixed positioning clamped to the viewport; it never changes the
 * message layout. */

let tip = null;
let anchor = null;
let hideTimer = 0;
let placement = 'top';

function hostDocument() {
  return anchor?.ownerDocument || globalThis.document || null;
}

function ensureTip(document) {
  if (tip?.ownerDocument === document) return tip;
  tip?.remove();
  tip = document.createElement('div');
  tip.className = 'ui-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}

function place() {
  if (!tip || !anchor || tip.hidden) return;
  const document = tip.ownerDocument;
  const view = document.defaultView;
  if (!view) return;
  const rect = anchor.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  let left = rect.left + rect.width / 2 - box.width / 2;
  left = Math.max(margin, Math.min(left, view.innerWidth - box.width - margin));
  let top;
  if (placement === 'bottom') {
    /* 消息操作栏在正文下方：提示优先向下，避免盖住刚读完的最后一行。 */
    top = rect.bottom + gap;
    if (top + box.height > view.innerHeight - margin) top = rect.top - box.height - gap;
  } else {
    top = rect.top - box.height - gap;
    if (top < margin) top = rect.bottom + gap;
  }
  top = Math.max(margin, Math.min(top, view.innerHeight - box.height - margin));
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}

export function hideTooltip() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }
  const document = hostDocument();
  if (tip) tip.hidden = true;
  if (anchor) anchor.removeAttribute('aria-describedby');
  const previous = anchor;
  anchor = null;
  if (previous?._uiTooltipCleanup) previous._uiTooltipCleanup();
  if (previous) previous._uiTooltipCleanup = null;
  if (document) { /* nothing else to tear down */ }
}

function show(target, text, side = 'top') {
  const document = target.ownerDocument;
  if (!document?.body) return;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }
  if (anchor !== target) hideTooltip();
  placement = side === 'bottom' ? 'bottom' : 'top';
  anchor = target;
  const element = ensureTip(document);
  element.textContent = text;
  element.hidden = false;
  element.style.left = '-9999px';
  element.style.top = '-9999px';
  place();

  const view = document.defaultView;
  const close = event => {
    if (event.type === 'keydown') {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
    }
    hideTooltip();
  };
  const dismiss = () => hideTooltip();
  target.addEventListener('pointerleave', dismiss);
  target.addEventListener('blur', dismiss);
  target.addEventListener('keydown', close);
  view?.addEventListener('scroll', dismiss, true);
  view?.addEventListener('resize', dismiss);
  target._uiTooltipCleanup = () => {
    target.removeEventListener('pointerleave', dismiss);
    target.removeEventListener('blur', dismiss);
    target.removeEventListener('keydown', close);
    view?.removeEventListener('scroll', dismiss, true);
    view?.removeEventListener('resize', dismiss);
  };
}

/** Attach the visual tooltip to a control that already has an accessible name.
 * `placement` only chooses the preferred side; both sides stay viewport-clamped. */
export function bindTooltip(control, text, { placement: side = 'top' } = {}) {
  if (!control || !text) return control;
  const enter = () => {
    if (control.disabled) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    show(control, text, side);
  };
  const leave = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hideTooltip(), 80);
  };
  control.addEventListener('pointerenter', enter);
  control.addEventListener('focus', enter);
  control.addEventListener('pointerleave', leave);
  control.addEventListener('blur', leave);
  return control;
}
