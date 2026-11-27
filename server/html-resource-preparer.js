import {
  checkHtmlResourceAbort, checkHtmlResourceDeclarations, checkHtmlResourceEnvironment,
  checkHtmlResourceUrl, failHtmlResource, htmlResourceError, htmlResourceLimits, isHtmlResourceError,
} from './html-resource-policy.js';
import { fetchHtmlResource } from './html-resource-proxy.js';
import { htmlResourceImageMime } from './html-resource-image.js';
export { HTML_RESOURCE_LIMITS, HTML_RESOURCE_ERROR_CODES } from './html-resource-policy.js';
export { HTML_RESOURCE_IMAGE_LIMITS } from './html-resource-image.js';

// Authored contract: a whole single/double-quoted absolute URL (attributes,
// CSS url("..."), or string literals), or bare CSS url(https://...). A URL in
// srcset, an unquoted HTML attribute, CSS/JS escapes, concatenation, and HTML
// entities other than semicolon-terminated ampersands are NOT interpreted.
// No DOM parser, resource loader, model execution, or unlisted URL discovery.
const LITERALS = /(["'])(https:\/\/[^\s"'<>`\\]+)\1|(?<![\w-])url\(\s*(https:\/\/[^\s"'<>`()\\]+)\s*\)/gi;
const unescapeAmpersands = value => value.replace(/&(?:amp|#0*38|#x0*26);/gi, '&');
function references(html, declarations, limits) {
  const declared = new Set(declarations.map(resource => resource.url)), found = new Set(), matches = [];
  for (const match of html.matchAll(LITERALS)) {
    const raw = match[2] ?? match[3];
    let url;
    // Plain literals and one-pass HTML escaping are both explicit spelling
    // forms; canonicalization only resolves normal HTTPS URL syntax.
    for (const spelling of [raw, unescapeAmpersands(raw)]) {
      try {
        const candidate = checkHtmlResourceUrl(spelling, limits).href;
        if (declared.has(candidate)) { url = candidate; break; }
      } catch { /* Unlisted/unsupported text is left to the unchanged frame CSP. */ }
    }
    if (!url) continue;
    const start = match.index + (match[2] !== undefined ? 1 : match[0].indexOf(raw));
    matches.push({ start, end: start + raw.length, url });
    found.add(url);
  }
  if (found.size !== declared.size) failHtmlResource('html_resource_reference');
  return matches;
}

/** Construct once per backend; inject only trusted DNS/HTTPS dependencies.
 * prepare(html, resources?, {signal}?) => Promise<string>.
 *
 * Every declared resource must occur in the supported literal grammar. All
 * resources succeed or the operation throws a fixed html_resource_* code with
 * no URL, payload, upstream exception, or persistent cache. Preview and final
 * publication must BOTH call this before browser/store admission. No endpoint
 * is exposed to an opaque frame. The caller retains owner/revision checks,
 * cancellation, immutable store publication and the unchanged sandbox/CSP. */
export function createHtmlResourcePreparer({
  env = process.env, limits: overrides, lookupImpl, requestImpl, networkInterfaces,
} = {}) {
  const limits = htmlResourceLimits(overrides);
  let active = 0;
  async function prepare(html, resources, { signal } = {}) {
    checkHtmlResourceAbort(signal);
    if (typeof html !== 'string' || !html.length) failHtmlResource('html_resource_invalid');
    const htmlBytes = Buffer.byteLength(html);
    if (htmlBytes > limits.htmlBytes) failHtmlResource('html_resource_too_large');
    const declarations = checkHtmlResourceDeclarations(resources, limits);
    // Existing self-contained documents are byte-for-byte stable even offline,
    // with proxy settings, or without any usable DNS/HTTPS dependencies.
    if (!declarations.length) return html;
    checkHtmlResourceEnvironment(env);
    const matches = references(html, declarations, limits);
    if (active >= limits.concurrentPreparations) failHtmlResource('html_resource_busy');
    active++;
    const controller = new AbortController();
    const cancel = () => controller.abort(htmlResourceError('html_resource_cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(htmlResourceError('html_resource_timeout')), limits.totalTimeoutMs);
    try {
      let totalBytes = 0, preparedBytes = htmlBytes;
      const dataUris = new Map();
      for (const resource of declarations) {
        checkHtmlResourceAbort(controller.signal);
        const maxBytes = Math.min(limits.resourceBytes, limits.totalResourceBytes - totalBytes);
        if (maxBytes < 1) failHtmlResource('html_resource_too_large');
        const { bytes, type } = await fetchHtmlResource(resource.url, {
          env, limits, maxBytes, signal: controller.signal, lookupImpl, requestImpl, networkInterfaces,
        });
        checkHtmlResourceAbort(controller.signal);
        const mime = htmlResourceImageMime(bytes, type);
        totalBytes += bytes.length;
        const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
        // Count EVERY occurrence before allocating a potentially amplified HTML
        // string, not merely the downloaded bytes or number of unique URLs.
        for (const match of matches) if (match.url === resource.url) {
          preparedBytes += dataUri.length - Buffer.byteLength(html.slice(match.start, match.end));
          if (preparedBytes > limits.htmlBytes) failHtmlResource('html_resource_too_large');
        }
        dataUris.set(resource.url, dataUri);
      }
      checkHtmlResourceAbort(controller.signal);
      const parts = [];
      let cursor = 0;
      for (const match of matches) {
        parts.push(html.slice(cursor, match.start), dataUris.get(match.url));
        cursor = match.end;
      }
      parts.push(html.slice(cursor));
      return parts.join('');
    } catch (error) {
      if (isHtmlResourceError(error)) throw error;
      throw htmlResourceError('html_resource_network');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      active--;
    }
  }
  return Object.freeze({ prepare });
}
