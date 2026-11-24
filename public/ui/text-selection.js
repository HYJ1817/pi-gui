/* Preserve a reader's text selection through synchronous display updates.
 * Prefer the original DOM endpoints when nodes survive. Markdown replacement
 * uses temporary text offsets, adjusted for the changed prefix/suffix; no
 * content is stored on elements, in preferences, logs or persistent state. */
export function preserveTextSelection(container, update) {
  const document = container?.ownerDocument;
  const selection = document?.defaultView?.getSelection?.();
  if (!selection || selection.isCollapsed
      || !container.contains(selection.anchorNode) && !container.contains(selection.focusNode)) return update();
  const before = container.textContent;
  const save = (node, offset) => {
    const inside = container.contains(node);
    let position = null;
    if (inside) {
      const range = document.createRange();
      range.selectNodeContents(container);
      range.setEnd(node, offset);
      position = range.toString().length;
    }
    return { node, offset, inside, position };
  };
  const anchor = save(selection.anchorNode, selection.anchorOffset);
  const focus = save(selection.focusNode, selection.focusOffset);
  const result = update();
  const after = container.textContent;
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix
      && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const restore = point => {
    if (point.node.isConnected) return [point.node, Math.min(point.offset,
      point.node.nodeType === 3 ? point.node.length : point.node.childNodes.length)];
    if (!point.inside || !container.isConnected) return null;
    let position = point.position <= prefix ? point.position
      : point.position >= before.length - suffix ? point.position + after.length - before.length
      : Math.min(after.length - suffix, point.position);
    position = Math.max(0, Math.min(after.length, position));
    const walker = document.createTreeWalker(container, 4); // SHOW_TEXT, UTF-16 DOM offsets.
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (position <= node.length) return [node, position];
      position -= node.length;
    }
    return [container, container.childNodes.length];
  };
  const a = restore(anchor), f = restore(focus);
  if (a && f) {
    if (typeof selection.setBaseAndExtent === 'function') selection.setBaseAndExtent(...a, ...f);
    else if (typeof selection.extend === 'function') { selection.collapse(...a); selection.extend(...f); }
  }
  return result;
}
