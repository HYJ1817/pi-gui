// Serialized into the frame. Programmatic focus/scrollIntoView must not scroll
// host ancestors; real wheel input remains Chromium's native scroll chaining.
export function installHtmlArtifactScroll(view) {
  const doc = view.document;
  const styleOf = view.getComputedStyle.bind(view);
  const rectOf = view.Element.prototype.getBoundingClientRect;
  const numeric = value => Number.parseFloat(value) || 0;
  function displacement(start, end, low, high, alignment) {
    if (alignment === 'start') return start - low;
    if (alignment === 'end') return end - high;
    if (alignment === 'center') return (start + end - low - high) / 2;
    if (start >= low && end <= high || start < low && end > high) return 0;
    if (start < low) return end - start > high - low ? end - high : start - low;
    return end - start > high - low ? start - low : end - high;
  }
  function scrollIntoView(options) {
    if (!this.isConnected || this.ownerDocument !== doc) return;
    const align = typeof options === 'object' && options !== null ? options
      : { block: options === false ? 'end' : 'start' };
    const targetStyle = styleOf(this), target = rectOf.call(this);
    const root = doc.scrollingElement || doc.documentElement;
    let top = target.top - numeric(targetStyle.scrollMarginTop);
    let bottom = target.bottom + numeric(targetStyle.scrollMarginBottom);
    let left = target.left - numeric(targetStyle.scrollMarginLeft);
    let right = target.right + numeric(targetStyle.scrollMarginRight);
    let element = this, fixed = targetStyle.position === 'fixed';
    function move(container, viewport = false) {
      const style = styleOf(container), rect = viewport ? { top: 0, left: 0 } : rectOf.call(container);
      const y = rect.top + (viewport ? 0 : container.clientTop);
      const x = rect.left + (viewport ? 0 : container.clientLeft);
      let dy = displacement(top, bottom, y + numeric(style.scrollPaddingTop),
        y + container.clientHeight - numeric(style.scrollPaddingBottom), align.block || 'start');
      let dx = displacement(left, right, x + numeric(style.scrollPaddingLeft),
        x + container.clientWidth - numeric(style.scrollPaddingRight), align.inline || 'nearest');
      dy = Math.max(-container.scrollTop, Math.min(container.scrollHeight - container.clientHeight - container.scrollTop, dy));
      const minX = style.direction === 'rtl' ? container.clientWidth - container.scrollWidth : 0;
      dx = Math.max(minX - container.scrollLeft,
        Math.min(minX + container.scrollWidth - container.clientWidth - container.scrollLeft, dx));
      // Direct local writes are deliberate. Native scrollIntoView can cross the
      // browsing context boundary; window/parent/host are never a scroll target.
      container.scrollTop += dy; container.scrollLeft += dx;
      top -= dy; bottom -= dy; left -= dx; right -= dx;
    }
    while (!fixed) {
      element = element.parentElement || element.getRootNode?.().host;
      if (!element || element === root || element === doc.documentElement) break;
      const style = styleOf(element);
      if (/(auto|scroll|hidden)/.test(style.overflow + style.overflowY + style.overflowX)) move(element);
      fixed = style.position === 'fixed';
    }
    if (!fixed && root) move(root, true);
  }
  try {
    Object.defineProperty(view.Element.prototype, 'scrollIntoView', {
      value: scrollIntoView, configurable: false, writable: false,
    });
    for (const type of [view.HTMLElement, view.SVGElement]) {
      const nativeFocus = type?.prototype.focus;
      if (typeof nativeFocus !== 'function') continue;
      Object.defineProperty(type.prototype, 'focus', {
        configurable: false, writable: false,
        value(options) {
          nativeFocus.call(this, { ...options, preventScroll: true });
          if (!options?.preventScroll) scrollIntoView.call(this, { block: 'nearest', inline: 'nearest' });
        },
      });
    }
  } catch { return false; }
  return true;
}
