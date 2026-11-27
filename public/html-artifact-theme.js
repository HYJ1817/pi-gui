// The host owns theme/font preferences; frames receive only resolved values.
// No HTML or arbitrary CSS from an artifact is ever interpreted in this realm.
export const HTML_ARTIFACT_THEME_TOKENS = Object.freeze({
  background: '--ds-bg-primary', foreground: '--ds-text-primary', muted: '--ds-bg-secondary',
  'muted-foreground': '--ds-text-muted', border: '--ds-border-default', primary: '--ds-accent',
  accent: '--ds-accent', destructive: '--ds-error', warning: '--ds-warning', success: '--ds-success',
  info: '--ds-info', radius: '--radius-md', 'font-sans': '--font-sans', 'font-mono': '--font-mono',
  'primary-foreground': '--ui-on-primary', card: '--ds-surface-card', 'card-foreground': '--ds-text-primary',
  'chart-1': '--ds-info', 'chart-2': '--ds-success', 'chart-3': '--ds-warning',
  'chart-4': '--ds-error', 'chart-5': '--ds-accent', 'chart-6': '--ds-text-secondary',
});
export const HTML_ARTIFACT_THEME_KEYS = Object.freeze([...Object.keys(HTML_ARTIFACT_THEME_TOKENS), 'font-size']);

export function readHtmlArtifactTheme(doc) {
  const style = doc.defaultView.getComputedStyle(doc.documentElement);
  const values = {};
  for (const [key, token] of Object.entries(HTML_ARTIFACT_THEME_TOKENS)) {
    const value = style.getPropertyValue(token).trim();
    if (value && value.length <= 512) values[key] = value;
  }
  // Respect the host's existing font-scale as well as its chosen font family.
  const scale = Number(style.getPropertyValue('--font-scale')) || 1;
  values['font-size'] = `${14 * Math.max(0.5, Math.min(3, scale))}px`;
  return { values, colorScheme: doc.documentElement.dataset.theme === 'light' ? 'light' : 'dark' };
}
