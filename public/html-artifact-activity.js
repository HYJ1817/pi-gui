import { HTML_RENDER_TOOL } from './html-artifact-model.js';

// A short, safe tool row. HTML input, result text and unknown details have no
// fallback path into either its summary, title or expanded tool disclosure.
export function htmlArtifactActivity(entry) {
  if (entry?.name !== HTML_RENDER_TOOL) return null;
  return {
    kind: 'html_artifact', known: true, label: '生成可视化',
    summary: 'HTML', facts: '', resultLine: '', output: '', args: null, details: null,
  };
}
