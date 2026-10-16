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
})();
