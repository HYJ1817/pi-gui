/* Theme preference has no project, model or RPC dependencies. */
const valid = value => ['dark', 'light', 'system'].includes(value);
let preference = document.documentElement.dataset.themePreference || 'dark';
let revision = -1;
const desktop = window.piGuiDesktop?.theme;
const media = window.matchMedia?.('(prefers-color-scheme: dark)');
const subscribers = new Set();
function apply(snapshot) {
  if (!snapshot || !valid(snapshot.preference) || !['light', 'dark'].includes(snapshot.resolved)) return false;
  if (desktop && (!Number.isInteger(snapshot.revision) || snapshot.revision < revision)) return false;
  revision = snapshot.revision ?? revision;
  preference = snapshot.preference;
  document.documentElement.dataset.theme = snapshot.resolved;
  document.documentElement.dataset.themePreference = preference;
  for (const fn of subscribers) fn({ ...snapshot });
  return true;
}
function webSnapshot() { return { preference, resolved: preference === 'system' ? media?.matches ? 'dark' : 'light' : preference, persisted: true }; }
export function themePreference() { return preference; }
export async function setThemePreference(mode) {
  if (!valid(mode)) return false;
  if (desktop) {
    try { const result = await desktop.set(mode); return result?.ok === true && apply(result.snapshot); } catch { return false; }
  }
  preference = mode;
  const snapshot = webSnapshot();
  try { localStorage.setItem('pi-gui.theme.v1', mode); } catch { snapshot.persisted = false; }
  return apply(snapshot);
}
export function onThemeChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
if (desktop) { apply(desktop.snapshot?.() || desktop.initial); desktop.onChange(apply); }
else media?.addEventListener?.('change', () => { if (preference === 'system') apply(webSnapshot()); });
