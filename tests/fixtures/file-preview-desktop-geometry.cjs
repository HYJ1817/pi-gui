'use strict';
// The shared maximize owner covers the chat workspace, not the project sidebar.
// Keep its geometry contract separate from the former Files fullscreen overlay.
module.exports = function measurePreviewGeometry() {
  const rect = selector => {
    const element = document.querySelector(selector);
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const app = rect('.app');
  const reserved = ['#globalRail', '#projectSidebar'].reduce((width, selector) => {
    const element = document.querySelector(selector);
    return width + (element && !element.hidden ? element.getBoundingClientRect().width : 0);
  }, 0);
  const surface = rect('.files-surface');
  const pane = rect('#rightPane');
  const body = rect('#rightPane > .rp-body');
  const preview = rect('.files-preview');
  return {
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    theme: document.documentElement.dataset.theme,
    docOverflow: document.documentElement.scrollWidth - innerWidth,
    app, reserved, surface, pane, body, preview,
    expectedWidth: app.width - reserved,
    chatPresent: !!document.querySelector('#input'),
    chatInert: document.querySelector('#workspace').inert,
    font: parseFloat(getComputedStyle(document.querySelector('.fp-text-scroll') || document.querySelector('.fp-markdown-body')).fontSize),
    bodyText: !!document.querySelector('.fp-markdown-body .katex'),
  };
};
