// Preview images and page diagnostics belong to Pi's tool context, not the
// public timeline. This closed projection carries status/geometry only.
export const HTML_PREVIEW_TOOL = 'html_preview';
const CODES = new Set(['invalid_request', 'stale_runtime', 'html_bridge_unavailable', 'html_cancelled',
  'html_too_large', 'html_preview_unavailable', 'html_preview_timeout', 'html_preview_busy', 'html_preview_failed']);
const dimension = value => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000;

export function projectHtmlPreviewResult(result) {
  const source = result?.details;
  const ok = result?.isError !== true && source?.kind === 'html_preview'
    && source.schemaVersion === 1 && source.ok === true;
  const details = { kind: 'html_preview', schemaVersion: 1, ok };
  if (ok) {
    if (source.mode === 'static' || source.mode === 'interactive') details.mode = source.mode;
    for (const key of ['width', 'height', 'contentWidth', 'contentHeight']) {
      if (dimension(source[key])) details[key] = source[key];
    }
    if (source.diagnosticCounts && typeof source.diagnosticCounts === 'object') {
      const counts = {};
      for (const key of ['console', 'errors', 'resources', 'warnings']) {
        const value = source.diagnosticCounts[key];
        if (Number.isSafeInteger(value) && value >= 0 && value <= 1000) counts[key] = value;
      }
      if (Object.keys(counts).length) details.diagnosticCounts = counts;
    }
  } else if (CODES.has(source?.code)) details.code = source.code;
  return { content: [{ type: 'text', text: ok ? 'HTML preview completed.' : 'HTML preview unavailable.' }],
    details, ...(!ok ? { isError: true } : {}) };
}
