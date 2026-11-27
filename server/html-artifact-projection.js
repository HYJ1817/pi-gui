import { HTML_RENDER_TOOL, htmlArtifactFromToolResult, htmlArtifactToolDetails } from '../public/html-artifact-model.js';
import { HTML_PREVIEW_TOOL, projectHtmlPreviewResult } from '../public/html-preview-model.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const htmlName = name => name === HTML_RENDER_TOOL || name === HTML_PREVIEW_TOOL;
const isPreview = value => value?.name === HTML_PREVIEW_TOOL || value?.toolName === HTML_PREVIEW_TOOL
  || value?.details?.kind === 'html_preview';
const isHtml = value => htmlName(value?.name) || htmlName(value?.toolName)
  || value?.details?.kind === 'html_artifact' || isPreview(value);
const safeText = artifact => artifact ? `HTML: ${artifact.title} (${artifact.id})` : 'HTML visualization unavailable.';

export function projectHtmlToolResult(result, toolName = null) {
  if (toolName === HTML_PREVIEW_TOOL || isPreview(result)) return projectHtmlPreviewResult(result);
  const artifact = htmlArtifactFromToolResult(result);
  return { content: [{ type: 'text', text: safeText(artifact) }],
    ...(artifact ? { details: htmlArtifactToolDetails(artifact) } : { isError: true }) };
}

// Last outbound boundary, before SSE/backlog or public history. A provider's
// toolcall_delta has no trustworthy tool identity yet: argument fragments never
// cross this boundary. Native observers and persistence consume the original.
export function projectHtmlArtifacts(value, toolName = null) {
  let remaining = 500_000;
  const visit = (node, depth = 0) => {
    if (--remaining < 0 || depth > 80) return null;
    if (Array.isArray(node)) return node.map(item => visit(item, depth + 1));
    if (!object(node)) return node;
    if (isHtml(node) && node.type === 'toolCall') {
      return { type: 'toolCall', id: node.id, name: isPreview(node) ? HTML_PREVIEW_TOOL : HTML_RENDER_TOOL, arguments: {} };
    }
    if (isHtml(node) && node.role === 'toolResult') {
      return { role: 'toolResult', toolName: isPreview(node) ? HTML_PREVIEW_TOOL : HTML_RENDER_TOOL, toolCallId: node.toolCallId,
        ...(typeof node.timestamp === 'number' ? { timestamp: node.timestamp } : {}), ...projectHtmlToolResult(node) };
    }
    // Real Pi wire events can carry non-string type payloads in nested nodes
    // (for example object-valued content parts); fail closed as non-execution.
    const execution = typeof node.type === 'string' && node.type.startsWith('tool_execution_');
    // A legacy nameless completion must use the start-bound name. With no
    // witness, hide payload rather than accidentally publishing an HTML error.
    const name = node.toolName || (node === value ? toolName : null);
    const html = isHtml(node) || execution && (!name || htmlName(name));
    const out = {};
    for (const [key, item] of Object.entries(node)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      if (html && ['html', 'args', 'arguments', 'input', 'partialResult', 'output', 'error', 'errorMessage'].includes(key)) continue;
      if (html && key === 'result') { out.result = projectHtmlToolResult(node.isError === true ? { isError: true } : item, name); continue; }
      if (html && ['content', 'details'].includes(key)) continue;
      if (node.type === 'toolcall_delta' && ['delta', 'arguments', 'args', 'partialJson'].includes(key)) continue;
      out[key] = visit(item, depth + 1);
    }
    if (html && !execution && node.role !== 'assistant' && node.details) Object.assign(out, projectHtmlToolResult(node));
    return out;
  };
  return visit(value);
}

// Classic retains ordinary tool output, including old Pi completions without a
// toolName. Keep only bounded name witnesses, never argument or result bytes.
export function createHtmlArtifactProjection() {
  const names = new Map();
  let run = null;
  return event => {
    if (event.type === 'execution_branch' || Number.isInteger(event.bridgeRun) && event.bridgeRun !== run) {
      names.clear(); run = event.bridgeRun;
    }
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string' && typeof event.toolName === 'string') {
      names.delete(event.toolCallId); names.set(event.toolCallId, event.toolName);
      if (names.size > 4096) names.delete(names.keys().next().value);
    }
    return projectHtmlArtifacts(event, names.get(event.toolCallId));
  };
}

// Reference identity includes the native assistant entry, not just a call ID
// (providers may reuse IDs in another turn). Forks inherit original references.
export function htmlReferencesInPath(entries) {
  const found = [];
  let declarations = new Map();
  const flush = () => { for (const call of declarations.values()) if (call?.artifact) found.push(call.artifact); };
  for (const entry of entries || []) {
    const message = entry?.type === 'message' ? entry.message : null;
    if (message?.role === 'assistant') {
      flush(); declarations = new Map();
      for (const call of Array.isArray(message.content) ? message.content : []) {
        if (call?.type !== 'toolCall') continue;
        if (declarations.has(call.id)) declarations.set(call.id, null);
        else declarations.set(call.id, call.name === HTML_RENDER_TOOL ? { messageId: entry.id, seen: false, artifact: null } : null);
      }
    } else if (message?.role === 'user') {
      flush(); declarations.clear();
    } else if (message?.role === 'toolResult') {
      const declaration = declarations.get(message.toolCallId);
      if (!declaration) continue;
      if (declaration.seen) { declaration.artifact = null; continue; }
      declaration.seen = true;
      if (message.toolName !== HTML_RENDER_TOOL) continue;
      const artifact = htmlArtifactFromToolResult(message);
      if (artifact && artifact.messageId === declaration.messageId && artifact.toolCallId === message.toolCallId) declaration.artifact = artifact;
    }
  }
  flush();
  return found;
}

export function sameHtmlReference(a, b) {
  return Boolean(a && b && JSON.stringify(htmlArtifactToolDetails(a)) === JSON.stringify(htmlArtifactToolDetails(b)));
}
