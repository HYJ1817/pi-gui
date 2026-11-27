// The host owns theme/font preferences; frames receive only resolved values.
// No HTML or arbitrary CSS from an artifact is ever interpreted in this realm.
export const HTML_ARTIFACT_THEME_TOKENS = Object.freeze({
  background: '--ds-bg-primary', foreground: '--ds-text-primary', muted: '--ds-bg-secondary',
  // Use the body-safe secondary ink, not the faint metadata ink, for generated
  // descriptions. T3's variable vocabulary maps to OUR existing semantic tokens.
  'muted-foreground': '--ds-text-secondary', border: '--ds-border-default', input: '--ds-surface-input',
  ring: '--ds-focus', primary: '--ds-accent', 'primary-foreground': '--ui-on-primary',
  accent: '--ds-accent', 'accent-foreground': '--ui-on-primary',
  'accent-surface': '--ds-bg-hover', 'accent-surface-foreground': '--ds-text-primary',
  card: '--ds-surface-card', 'card-foreground': '--ds-text-primary',
  popover: '--ds-bg-elevated-opaque', 'popover-foreground': '--ds-text-primary',
  secondary: '--ds-bg-secondary', 'secondary-foreground': '--ds-text-primary',
  destructive: '--ds-error', 'destructive-surface': '--ds-error-surface',
  'destructive-foreground': '--ds-text-primary',
  warning: '--ds-warning', 'warning-surface': '--ds-warning-surface', 'warning-foreground': '--ds-text-primary',
  success: '--ds-success', 'success-surface': '--ds-success-surface', 'success-foreground': '--ds-text-primary',
  info: '--ds-info', 'info-surface': '--ds-info-surface', 'info-foreground': '--ds-text-primary',
  'code-background': '--ui-code-surface', 'code-foreground': '--ds-text-primary',
  radius: '--radius-md', 'font-sans': '--font-sans', 'font-mono': '--font-mono',
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
