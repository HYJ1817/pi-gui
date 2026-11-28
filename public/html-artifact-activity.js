import { HTML_RENDER_TOOL } from './html-artifact-model.js';
import { HTML_PREVIEW_TOOL } from './html-preview-model.js';

// A short, safe tool row. HTML input, result text and unknown details have no
// fallback path into either its summary, title or expanded tool disclosure.
export function htmlArtifactActivity(entry) {
  const preview = entry?.name === HTML_PREVIEW_TOOL;
  if (!preview && entry?.name !== HTML_RENDER_TOOL) return null;
  return {
    kind: preview ? 'html_preview' : 'html_artifact', known: true, label: preview ? '预览可视化' : '生成可视化',
    summary: 'HTML', facts: '', resultLine: '', output: '', args: null, details: null,
  };
}
