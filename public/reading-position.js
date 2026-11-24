/**
 * 会话阅读位置书签与折叠位置补偿（P2-A / P2-B）。
 *
 * 契约与边界：
 * 1. 仅在渲染进程内存中保存书签（Map<sessionId, bookmark>），应用重启或刷新后清空；
 *    不写 localStorage，不写会话文件，不侵入 pi 数据。
 * 2. 键名严格使用 pi 的 sessionId（UUID），不拿标题或文件路径猜测。
 * 3. 严格限制最大书签容量（LRU 淘汰），防止长时间使用造成内存泄漏。
 * 4. 恢复位置时只修改对应滚动容器自身的 scrollTop，绝不调用 scrollIntoView。
 * 5. 锚点不存在时安全降级到 savedScrollTop，绝不白屏、异常滚动或死循环。
 * 6. 折叠位置补偿支持视口内标题原位保持与视口上方高度补偿，用户主动滚动时立即取消。
 */

const MAX_BOOKMARKS = 100;
const bookmarks = new Map();

const ANCHORS = '[data-anchor-id], [data-block-id], [data-history-message-id]';
const readingId = node => node.dataset.anchorId || node.dataset.blockId || node.dataset.historyMessageId || node.dataset.navId || node.id;

function* readingAnchors(content) {
  for (const child of content?.children || []) {
    if (child.hasAttribute('data-execution-turn') || child.hasAttribute('data-conversation-work')) {
      const descendants = [...child.querySelectorAll(ANCHORS)];
      if (!descendants.some(node => !node.closest('[hidden]'))) yield child;
      for (const node of descendants) {
        // An open work log is a container, not the row being read. A closed
        // log's stable header is a valid fallback when its native rows are hidden.
        if (node.matches('.execution-activity-group, [data-conversation-work], .tl-group')
            && node.querySelector('.execution-body:not([hidden]), .conversation-work-list:not([hidden]), .tl-list:not([hidden])')
            && node.querySelector(ANCHORS)) continue;
        yield node;
      }
    } else yield child;
  }
}

function readingTop(node, rect) {
  // Classic 入场动效带有 3px 的位移。书签记录静止布局，动效仍按原样播放。
  if (!node.getAnimations?.().some(animation => animation.animationName === 'ui2-rise-in')) return rect.top;
  const view = node.ownerDocument.defaultView;
  const transform = view.getComputedStyle(node).transform;
  return transform === 'none' ? rect.top : rect.top - new view.DOMMatrixReadOnly(transform).m42;
}

/**
 * 采集指定容器的阅读位置。
 * @param {HTMLElement} scroller 滚动容器（如 #stream 或 .rtc-output）
 * @param {HTMLElement} [content] 容器内的内容区（如 .thread）
 * @param {object} [options]
 * @param {boolean} [options.isPinned] 显式指定是否贴底；未指定时按距底阈值判断
 * @param {number} [options.pinnedThreshold=160] 贴底判定阈值（像素）
 * @returns {object|null}
 */
export function captureReadingPosition(scroller, content, options = {}) {
  if (!scroller || typeof scroller.scrollTop !== 'number') return null;

  const scrollHeight = scroller.scrollHeight || 0;
  const clientHeight = scroller.clientHeight || 0;
  const scrollTop = scroller.scrollTop || 0;
  const threshold = options.pinnedThreshold ?? 160;
  const isPinned = typeof options.isPinned === 'boolean'
    ? options.isPinned
    : (scrollHeight - scrollTop - clientHeight < threshold);

  if (isPinned) {
    return {
      isPinned: true,
      scrollTop,
      scrollHeight,
      clientHeight,
      anchorId: null,
      offset: 0,
      timestamp: Date.now(),
    };
  }

  let anchorId = null;
  let offset = 0;

  if (content && content.children && content.children.length > 0) {
    const scrollerRect = scroller.getBoundingClientRect
      ? scroller.getBoundingClientRect()
      : { top: 0, bottom: clientHeight, height: clientHeight };

    for (const child of readingAnchors(content)) {
      if (!child || child.nodeType !== 1) continue;
      if (child.closest('[hidden]') || child.classList?.contains('working')) continue;

      const r = child.getBoundingClientRect ? child.getBoundingClientRect() : null;
      if (!r) continue;
      if (r.height === 0 && r.width === 0) continue;

      // 寻找底部处于视口顶部以下（即在视口内可见或跨越视口上边界）的第一个子元素
      const id = readingId(child);
      if (id && r.bottom > scrollerRect.top + 2) {
        const layoutOffset = readingTop(child, r) - scrollerRect.top;
        if (layoutOffset + r.height <= 2) continue;
        anchorId = id;
        offset = layoutOffset;
        break;
      }
    }
  }

  return {
    isPinned: false,
    scrollTop,
    scrollHeight,
    clientHeight,
    anchorId,
    offset,
    timestamp: Date.now(),
  };
}

/**
 * 恢复阅读位置。
 * @param {HTMLElement} scroller 滚动容器
 * @param {HTMLElement} [content] 内容区
 * @param {object} bookmark 阅读书签
 * @returns {boolean} 是否成功恢复
 */
export function restoreReadingPosition(scroller, content, bookmark) {
  if (!scroller || !bookmark) return false;

  const scrollHeight = scroller.scrollHeight || 0;
  const clientHeight = scroller.clientHeight || 0;
  const maxScroll = Math.max(0, scrollHeight - clientHeight);

  // 1. 贴底状态直接回到底部
  if (bookmark.isPinned) {
    scroller.scrollTop = maxScroll;
    return true;
  }

  // 2. 尝试通过锚点恢复
  let anchor = null;
  if (bookmark.anchorId && content) {
    for (const child of readingAnchors(content)) {
      if (readingId(child) === bookmark.anchorId
          && !child.closest('[hidden]')) {
        anchor = child;
        break;
      }
    }
  }

  if (anchor && anchor.getBoundingClientRect && scroller.getBoundingClientRect) {
    const scrollerRect = scroller.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const currentOffset = readingTop(anchor, anchorRect) - scrollerRect.top;
    const delta = currentOffset - (bookmark.offset || 0);
    const target = (scroller.scrollTop || 0) + delta;
    scroller.scrollTop = Math.max(0, Math.min(maxScroll, target));
    return true;
  }

  // 3. 锚点不存在时的安全降级：回退至保存的 scrollTop（按当前滚动上下界截断）
  if (typeof bookmark.scrollTop === 'number' && Number.isFinite(bookmark.scrollTop)) {
    scroller.scrollTop = Math.max(0, Math.min(maxScroll, bookmark.scrollTop));
    return true;
  }

  return false;
}

/**
 * 保存会话书签（内存 LRU）。
 * @param {string} sessionId pi 会话 id
 * @param {HTMLElement} scroller
 * @param {HTMLElement} content
 * @param {object} [options]
 * @returns {boolean} 是否保存成功
 */
export function saveSessionBookmark(sessionId, scroller, content, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || !scroller) return false;
  const cleanId = sessionId.trim();
  const bookmark = captureReadingPosition(scroller, content, options);
  if (!bookmark) return false;

  // LRU 更新
  if (bookmarks.has(cleanId)) bookmarks.delete(cleanId);
  bookmarks.set(cleanId, bookmark);

  while (bookmarks.size > MAX_BOOKMARKS) {
    const oldest = bookmarks.keys().next().value;
    bookmarks.delete(oldest);
  }
  return true;
}

/**
 * 恢复会话书签。
 * @param {string} sessionId
 * @param {HTMLElement} scroller
 * @param {HTMLElement} content
 * @returns {boolean} 是否成功恢复
 */
export function restoreSessionBookmark(sessionId, scroller, content) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || !scroller) return false;
  const cleanId = sessionId.trim();
  const bookmark = bookmarks.get(cleanId);
  if (!bookmark) return false;

  // LRU 触碰
  bookmarks.delete(cleanId);
  bookmarks.set(cleanId, bookmark);

  return restoreReadingPosition(scroller, content, bookmark);
}

/** 检查是否存在指定会话的书签。 */
export function hasSessionBookmark(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return false;
  return bookmarks.has(sessionId.trim());
}

/** 清理指定会话的书签（如会话删除时）。 */
export function clearSessionBookmark(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return false;
  return bookmarks.delete(sessionId.trim());
}

/** 清空全部书签。 */
export function clearAllBookmarks() {
  bookmarks.clear();
}

/** 获取当前内存书签条数。 */
export function bookmarkCount() {
  return bookmarks.size;
}

/* ---------- 共享折叠滚动补偿工具（P2-B） ---------- */

/**
 * 查找元素所属的会话主滚动容器（#stream 或 .rtc-output）。
 * @param {HTMLElement} el
 * @returns {HTMLElement|null}
 */
export function findScrollContainer(element) {
  if (!element || typeof element.closest !== 'function') return null;
  return element.closest('#stream, .stream, .rtc-output, [data-scroll-container]');
}

/**
 * 在折叠/展开动作前后执行滚动补偿，保持阅读位置或被点击标题在视口内的位置稳定。
 *
 * 保证：
 * 1. 贴底状态保持原有跟随行为。
 * 2. 标题在视口中点击时，折叠后标题在视口内的相对 top 保持不变。
 * 3. 折叠发生在视口上方时，下方正在阅读的内容不发生跳动。
 * 4. 操作期间用户主动滚动时立即取消补偿。
 * 5. 仅调整当前所属滚动容器自身的 scrollTop，不滚动祖先容器或 Composer。
 *
 * @param {HTMLElement} anchorEl 发生折叠的标题或行元素
 * @param {Function} actionFn 执行展开/收起的具体 DOM 修改函数
 * @returns {*} actionFn 的返回值
 */
export function preserveScrollAround(anchorEl, actionFn) {
  if (typeof actionFn !== 'function') return undefined;
  if (!anchorEl || typeof anchorEl.getBoundingClientRect !== 'function') return actionFn();

  const scroller = findScrollContainer(anchorEl);
  if (!scroller || typeof scroller.scrollTop !== 'number') return actionFn();

  const clientHeight = scroller.clientHeight || 0;
  const scrollHeight = scroller.scrollHeight || 0;
  const initialScrollTop = scroller.scrollTop;
  const wasPinned = scrollHeight - initialScrollTop - clientHeight <= 24;

  const scrollerRect = scroller.getBoundingClientRect();
  const anchorRect = anchorEl.getBoundingClientRect();
  const container = anchorEl.closest?.('.tl-group, .plan-card, .think, details, .tool-entry, .tl-item, [data-collapsible]') || anchorEl;
  const initialContainerRect = container.getBoundingClientRect ? container.getBoundingClientRect() : anchorRect;
  const isAboveViewport = initialContainerRect.bottom <= scrollerRect.top + 1;
  const initialOffset = anchorRect.top - scrollerRect.top;

  let userInteracted = false;
  const onUserInteraction = () => { userInteracted = true; };
  scroller.addEventListener('wheel', onUserInteraction, { passive: true, once: true });
  scroller.addEventListener('touchmove', onUserInteraction, { passive: true, once: true });

  const result = actionFn();

  const applyCompensation = () => {
    scroller.removeEventListener('wheel', onUserInteraction);
    scroller.removeEventListener('touchmove', onUserInteraction);
    if (userInteracted) return;

    const currentScrollHeight = scroller.scrollHeight || 0;
    const currentClientHeight = scroller.clientHeight || 0;
    const maxScroll = Math.max(0, currentScrollHeight - currentClientHeight);

    // 贴底保持
    if (wasPinned) {
      scroller.scrollTop = maxScroll;
      return;
    }

    const newAnchorRect = anchorEl.getBoundingClientRect();

    // 视口上方折叠：按容器高度变化补偿 scrollTop，防止下方正在读的内容跳动
    if (isAboveViewport) {
      const newContainerRect = container.getBoundingClientRect ? container.getBoundingClientRect() : newAnchorRect;
      const heightDelta = newContainerRect.height - initialContainerRect.height;
      if (Math.abs(heightDelta) > 0.5) {
        scroller.scrollTop = Math.max(0, Math.min(maxScroll, initialScrollTop + heightDelta));
      }
      return;
    }

    // 视口内被点击标题：按偏移差补偿，保持标题在视口内的原位
    const newOffset = newAnchorRect.top - scrollerRect.top;
    const delta = newOffset - initialOffset;
    if (Math.abs(delta) > 0.5 && scroller.scrollTop === initialScrollTop) {
      scroller.scrollTop = Math.max(0, Math.min(maxScroll, initialScrollTop + delta));
    }
  };

  applyCompensation();

  return result;
}
