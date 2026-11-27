import net from 'node:net';
import { blockedHostname, classifyAddress, hostnameOf } from '../lib/market-network-policy.cjs';
import { HTML_ARTIFACT_MAX_BYTES } from '../public/html-artifact-model.js';

export const HTML_RESOURCE_LIMITS = Object.freeze({
  htmlBytes: HTML_ARTIFACT_MAX_BYTES,
  resourceBytes: 512 * 1024,
  totalResourceBytes: 1024 * 1024,
  count: 8,
  redirects: 2,
  urlChars: 2048,
  dnsAddresses: 64,
  resourceTimeoutMs: 5000,
  totalTimeoutMs: 12000,
  concurrentPreparations: 4,
});
export const HTML_RESOURCE_ERROR_CODES = Object.freeze([
  'html_resource_invalid', 'html_resource_url', 'html_resource_blocked',
  'html_resource_offline', 'html_resource_proxy', 'html_resource_unsupported',
  'html_resource_reference', 'html_resource_dns', 'html_resource_network',
  'html_resource_timeout', 'html_resource_cancelled', 'html_resource_redirect',
  'html_resource_response', 'html_resource_encoding', 'html_resource_type',
  'html_resource_too_large', 'html_resource_busy',
]);

class HtmlResourceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const htmlResourceError = code => new HtmlResourceError(
  HTML_RESOURCE_ERROR_CODES.includes(code) ? code : 'html_resource_network',
);
export const isHtmlResourceError = error => error instanceof HtmlResourceError;
export const failHtmlResource = code => { throw htmlResourceError(code); };
export function checkHtmlResourceAbort(signal) {
  if (signal?.aborted) throw isHtmlResourceError(signal.reason)
    ? signal.reason : htmlResourceError('html_resource_cancelled');
}

// Tests may lower a budget, never increase a production bound.
export function htmlResourceLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) failHtmlResource('html_resource_invalid');
  const limits = { ...HTML_RESOURCE_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value)
      || value < (key === 'redirects' ? 0 : 1) || value > limits[key]) failHtmlResource('html_resource_invalid');
    limits[key] = value;
  }
  return Object.freeze(limits);
}

// Market policy handles embedded IPv4 and most special ranges. Artifacts are
// stricter: no fake-IP or transition ranges, only IPv6 global unicast, and no
// deprecated 6bone/6to4 or IPv4 relay anycast. Do not relax market policy globally.
const GLOBAL_V6 = new net.BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const EXTRA_BLOCKED = new net.BlockList();
EXTRA_BLOCKED.addSubnet('192.88.99.0', 24, 'ipv4');
EXTRA_BLOCKED.addSubnet('2002::', 16, 'ipv6');
EXTRA_BLOCKED.addSubnet('3ffe::', 16, 'ipv6');
export function isPublicHtmlResourceAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = net.isIP(address);
  if (!family || classifyAddress(address) !== 'public') return false;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  return !EXTRA_BLOCKED.check(address, type) && (family !== 6 || GLOBAL_V6.check(address, type));
}

// No whitespace normalization, userinfo, fragment, encoded controls, CSS/JS
// escapes or raw markup delimiters. Query strings are allowed but never logged.
export function checkHtmlResourceUrl(raw, limits = HTML_RESOURCE_LIMITS) {
  if (typeof raw !== 'string' || !raw || raw.length > limits.urlChars
    || /[\s\x00-\x20\x7f-\x9f<>"'`\\]/u.test(raw)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/i.test(raw)) failHtmlResource('html_resource_url');
  let url;
  try { url = new URL(raw); } catch { failHtmlResource('html_resource_url'); }
  if (url.protocol !== 'https:' || !/^https:\/\//i.test(raw) || url.username || url.password
    || raw.match(/^https:\/\/[^/?#]*/i)?.[0].includes('@')
    || (url.port && url.port !== '443') || raw.includes('#')) failHtmlResource('html_resource_url');
  const hostname = hostnameOf(url);
  if (blockedHostname(hostname) || /\.(?:home|lan|home\.arpa)$/i.test(hostname)
    || (!net.isIP(hostname) && (!hostname.includes('.') || !/^[a-z0-9.-]+$/i.test(hostname)))) failHtmlResource('html_resource_blocked');
  if (net.isIP(hostname) && !isPublicHtmlResourceAddress(hostname)) failHtmlResource('html_resource_blocked');
  // Normalize trailing dots once; Host, DNS and TLS must all use the same name.
  url.hostname = net.isIPv6(hostname) ? `[${hostname}]` : hostname;
  if (url.href.length > limits.urlChars) failHtmlResource('html_resource_url');
  return url;
}

export function checkHtmlResourceEnvironment(env = {}) {
  if (env.PI_GUI_OFFLINE === '1' || env.PI_OFFLINE === '1') failHtmlResource('html_resource_offline');
  // This capability has no proxy stack. Refuse proxy intent instead of silently
  // bypassing it or claiming that proxy-side DNS has been pinned by this helper.
  if (['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'PI_GUI_SYSTEM_PROXY']
    .some(key => typeof env[key] === 'string' && env[key].trim()) || env.NODE_USE_ENV_PROXY === '1') failHtmlResource('html_resource_proxy');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') failHtmlResource('html_resource_network');
}

export function checkHtmlResourceDeclarations(resources, limits = HTML_RESOURCE_LIMITS) {
  if (resources === undefined) return [];
  if (!Array.isArray(resources) || resources.length > limits.count) failHtmlResource('html_resource_invalid');
  const seen = new Set();
  return Array.from(resources, resource => {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)
      || Object.keys(resource).length !== 2 || !Object.hasOwn(resource, 'url') || !Object.hasOwn(resource, 'type')
      || !['image', 'font'].includes(resource.type)) failHtmlResource('html_resource_invalid');
    const url = checkHtmlResourceUrl(resource.url, limits);
    // Remote fonts are deliberately unsupported until their parser/decoder
    // budget has its own qualification. Never silently drop a declaration.
    if (resource.type !== 'image') failHtmlResource('html_resource_unsupported');
    if (seen.has(url.href)) failHtmlResource('html_resource_invalid');
    seen.add(url.href);
    return Object.freeze({ url: url.href, type: resource.type });
  });
}
