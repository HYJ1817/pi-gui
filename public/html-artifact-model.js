// Shared wire contract. HTML bytes are deliberately absent from references and
// ordinary timeline state. A reference is evidence of a native tool result, not
// authority to read a snapshot; the server must prove session/branch membership.
export const HTML_RENDER_TOOL = 'html_render';
export const HTML_ARTIFACT_VERSION = 1;
export const HTML_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const HTML_ARTIFACT_MIN_HEIGHT = 80;
export const HTML_ARTIFACT_MAX_INITIAL_HEIGHT = 2048;
export const HTML_ARTIFACT_MAX_HEIGHT = 4096;
export const HTML_ARTIFACT_DEFAULT_HEIGHT = 320;

const digestPattern = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

export function isHtmlArtifactId(value) {
  return typeof value === 'string' && digestPattern.test(value);
}

export function normalizeHtmlArtifactHeight(value) {
  if (value === undefined || value === null) return HTML_ARTIFACT_DEFAULT_HEIGHT;
  if (!Number.isInteger(value) || value < HTML_ARTIFACT_MIN_HEIGHT || value > HTML_ARTIFACT_MAX_INITIAL_HEIGHT) return null;
  return value;
}

// Return a closed projection rather than preserving unknown fields from a Pi
// extension, a historical entry, or a future schema. Never return raw details.
export function projectHtmlArtifactReference(value) {
  if (!record(value) || value.schemaVersion !== HTML_ARTIFACT_VERSION || value.kind !== 'html'
    || !isHtmlArtifactId(value.id) || value.contentRef !== value.id
    || !identifier(value.sessionId, 128) || !identifier(value.messageId, 256) || !identifier(value.toolCallId, 256)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160 || /[\x00-\x1f\x7f]/.test(value.title)
    || normalizeHtmlArtifactHeight(value.height) !== value.height
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > HTML_ARTIFACT_MAX_BYTES
    || !isHtmlArtifactId(value.digest) || typeof value.createdAt !== 'string'
    || value.createdAt.length > 40 || !Number.isFinite(Date.parse(value.createdAt))) return null;
  return {
    schemaVersion: HTML_ARTIFACT_VERSION,
    kind: 'html',
    id: value.id,
    title: value.title,
    sessionId: value.sessionId,
    messageId: value.messageId,
    toolCallId: value.toolCallId,
    contentRef: value.id,
    height: value.height,
    createdAt: value.createdAt,
    bytes: value.bytes,
    digest: value.digest,
  };
}

export function htmlArtifactFromToolResult(result) {
  if (!record(result) || result.isError === true) return null;
  const details = result.details;
  if (!record(details) || details.kind !== 'html_artifact' || details.schemaVersion !== HTML_ARTIFACT_VERSION || details.ok !== true) return null;
  return projectHtmlArtifactReference(details.artifact);
}

export function htmlArtifactToolDetails(reference) {
  const artifact = projectHtmlArtifactReference(reference);
  if (!artifact) return null;
  return { kind: 'html_artifact', schemaVersion: HTML_ARTIFACT_VERSION, ok: true, artifact };
}
