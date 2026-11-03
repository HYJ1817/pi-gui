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
    if (fontScale && Number(fontScale)) {
      const num = Number(fontScale);
      if (num >= 50 && num <= 200) {
        document.documentElement.style.setProperty('--font-scale', (num / 100).toFixed(2));
      }
    }
    const fontFamily = localStorage.getItem('pi-gui.font-family.v1');
    if (fontFamily === 'mono') {
      const monoFont = 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
      document.documentElement.style.setProperty('--font-sans', monoFont);
      document.documentElement.style.setProperty('--ui-font-sans', monoFont);
    } else if (fontFamily === 'sans') {
      const sansFont = '"Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
      document.documentElement.style.setProperty('--font-sans', sansFont);
      document.documentElement.style.setProperty('--ui-font-sans', sansFont);
    }
  } catch { /* Storage may be disabled. */ }
})();
