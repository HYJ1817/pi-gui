/* Blocking head script: resolve presentation before stylesheets/first paint. */
(() => {
  const initial = window.piGuiDesktop?.theme?.snapshot?.() || window.piGuiDesktop?.theme?.initial;
  let preference = initial?.preference;
  if (!['dark', 'light', 'system'].includes(preference)) {
    try { preference = localStorage.getItem('pi-gui.theme.v1'); } catch { /* Storage may be disabled. */ }
  }
  if (!['dark', 'light', 'system'].includes(preference)) preference = 'dark';
  const resolved = initial?.resolved === 'light' || initial?.resolved === 'dark' ? initial.resolved
    : preference === 'system' ? window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;

  try {
    const fontScale = localStorage.getItem('pi-gui.font-scale.v1');
    if (fontScale && Number.isFinite(Number(fontScale))) {
      const num = Math.min(150, Math.max(80, Number(fontScale)));
      const scale = Math.round(num / 5) * 5;
      document.documentElement.style.setProperty('--font-scale', (scale / 100).toFixed(2));
    }
    /* Keep these stacks in sync with public/fonts.js. v2 stores the complete
     * family list; v1 is the legacy token form kept for painless migration. */
    const cjkFallback = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Microsoft YaHei UI", sans-serif';
    const legacy = {
      mono: `ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", "Microsoft YaHei", monospace`,
      sans: `"Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`
    };
    let fontFamily = null;
    try { fontFamily = localStorage.getItem('pi-gui.font-family.v2'); } catch { /* Storage may be disabled. */ }
    if (typeof fontFamily !== 'string') {
      try { fontFamily = legacy[localStorage.getItem('pi-gui.font-family.v1')] || ''; } catch { fontFamily = ''; }
    }
    fontFamily = String(fontFamily || '').trim();
    if (fontFamily && fontFamily.length <= 512) {
      const hasCjk = /pingfang sc|hiragino sans gb|microsoft yahei/i.test(fontFamily);
      const stack = hasCjk ? fontFamily : `${fontFamily.replace(/,\s*(sans-serif|system-ui|ui-sans-serif)\s*$/i, '')}, ${cjkFallback}`;
      document.documentElement.style.setProperty('--font-sans', stack);
      document.documentElement.style.setProperty('--ui-font-sans', stack);
    }
  } catch { /* Storage may be disabled. */ }
})();
