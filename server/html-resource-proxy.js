import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { hostnameOf } from '../lib/market-network-policy.cjs';
import {
  checkHtmlResourceAbort, checkHtmlResourceEnvironment, checkHtmlResourceUrl,
  failHtmlResource, htmlResourceError, isHtmlResourceError, isPublicHtmlResourceAddress,
} from './html-resource-policy.js';

// Only a lifetime race: late DNS completions cannot trigger a connection.
function abortableDns(operation, signal) {
  checkHtmlResourceAbort(signal);
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => { signal.removeEventListener('abort', cancel); fn(value); };
    const cancel = () => { try { checkHtmlResourceAbort(signal); } catch (error) { finish(reject, error); } };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { checkHtmlResourceAbort(signal); return operation(); })
      .then(value => finish(resolve, value), () => {
        if (signal.aborted) cancel();
        else finish(reject, htmlResourceError('html_resource_dns'));
      });
  });
}

function ownAddresses(networkInterfaces) {
  const own = new net.BlockList();
  try {
    for (const rows of Object.values(networkInterfaces())) for (const row of rows || []) {
      const address = row.address?.split('%')[0], family = net.isIP(address || '');
      if (family) own.addAddress(address, family === 6 ? 'ipv6' : 'ipv4');
    }
  } catch { failHtmlResource('html_resource_blocked'); }
  return own;
}

async function resolvePublicTarget(url, { lookupImpl, networkInterfaces, limits, signal }) {
  const hostname = hostnameOf(url), literalFamily = net.isIP(hostname);
  const rows = literalFamily ? [{ address: hostname, family: literalFamily }]
    : await abortableDns(() => lookupImpl(hostname, { all: true, verbatim: true }), signal);
  checkHtmlResourceAbort(signal);
  if (!Array.isArray(rows) || !rows.length || rows.length > limits.dnsAddresses) failHtmlResource('html_resource_dns');
  const own = ownAddresses(networkInterfaces);
  // Check ALL answers, not just the one we plan to connect to. Never permit a
  // mixed public/private/fake-IP answer or trust an asserted DNS family.
  for (const row of rows) {
    const address = row?.address, family = typeof address === 'string' ? net.isIP(address) : 0;
    if (!family || row.family !== family || !isPublicHtmlResourceAddress(address)
      || own.check(address, family === 6 ? 'ipv6' : 'ipv4')) failHtmlResource('html_resource_blocked');
  }
  // Prefer IPv4 when both are public; do not perform another unpinned lookup or
  // fall back to a proxy when a vetted address is unreachable.
  const selected = rows.find(row => row.family === 4) || rows[0];
  return { address: selected.address, family: selected.family };
}

function requestOptions(url, target) {
  const hostname = hostnameOf(url);
  return {
    protocol: 'https:', hostname, port: 443,
    method: 'GET', path: `${url.pathname}${url.search}`,
    headers: {
      host: url.host, accept: 'image/png,image/jpeg,image/webp,image/gif',
      'accept-encoding': 'identity', 'user-agent': 'pi-gui-html-resource/1',
    },
    // Not globalAgent: environment/system proxy agents and connection reuse
    // cannot substitute a destination after DNS vetting. TLS uses the URL name.
    agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    ...(net.isIP(hostname) ? {} : { servername: hostname }),
    family: target.family, autoSelectFamily: false, maxHeaderSize: 8192,
    lookup: (_host, options, callback) => options?.all
      ? callback(null, [{ address: target.address, family: target.family }])
      : callback(null, target.address, target.family),
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
function header(response, name) {
  const value = response.headers?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f-\x9f]/.test(value)) failHtmlResource('html_resource_response');
  return value;
}

function getPinned(url, target, { requestImpl, maxBytes, signal }) {
  checkHtmlResourceAbort(signal);
  return new Promise((resolve, reject) => {
    let request, response, settled = false, total = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      if (error || value?.location !== undefined) { response?.destroy(); request?.destroy(); }
      if (error) reject(error); else resolve(value);
    };
    const failed = () => finish(htmlResourceError('html_resource_network'));
    const cancel = () => { try { checkHtmlResourceAbort(signal); } catch (error) { finish(error); } };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      checkHtmlResourceAbort(signal);
      request = requestImpl(requestOptions(url, target), res => {
        response = res;
        res.on('error', failed);
        if (settled || signal.aborted) { res.destroy(); cancel(); return; }
        try {
          if (REDIRECTS.has(res.statusCode)) {
            const location = header(res, 'location');
            if (!location) failHtmlResource('html_resource_redirect');
            finish(null, { location });
            return;
          }
          if (res.statusCode !== 200) failHtmlResource('html_resource_response');
          const encoding = header(res, 'content-encoding');
          if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') failHtmlResource('html_resource_encoding');
          const type = header(res, 'content-type');
          if (!type || !/^image\/(?:png|jpeg|webp|gif)(?:\s*;|\s*$)/i.test(type)) failHtmlResource('html_resource_type');
          const length = header(res, 'content-length');
          if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) failHtmlResource('html_resource_response');
          if (length !== undefined && Number(length) > maxBytes) failHtmlResource('html_resource_too_large');
          res.on('aborted', failed);
          res.on('close', () => { if (!settled) failed(); });
          res.on('data', chunk => {
            if (settled) return;
            if (!Buffer.isBuffer(chunk)) { failed(); return; }
            total += chunk.length;
            if (total > maxBytes) { finish(htmlResourceError('html_resource_too_large')); return; }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (res.complete === false || (length !== undefined && total !== Number(length))) { failed(); return; }
            finish(null, { bytes: Buffer.concat(chunks, total), type });
          });
        } catch (error) { finish(isHtmlResourceError(error) ? error : htmlResourceError('html_resource_network')); }
      });
      request.on('error', failed); // Keep a sink for errors emitted by destroy().
      request.on('close', () => { if (!response && !settled) failed(); });
      if (settled) request.destroy(); else request.end();
    } catch { failed(); }
  });
}

/** Backend-private GET, not an HTTP proxy endpoint. The caller owns admission,
 * aggregate bytes and total lifetime. Dependencies are only injectable by the
 * trusted composition root/tests, never by resource declarations or HTML. */
export async function fetchHtmlResource(rawUrl, {
  limits, maxBytes, signal, env = process.env, lookupImpl = dns.promises.lookup,
  requestImpl = https.request, networkInterfaces = os.networkInterfaces,
}) {
  checkHtmlResourceAbort(signal);
  checkHtmlResourceEnvironment(env);
  const controller = new AbortController();
  const cancel = () => {
    try { checkHtmlResourceAbort(signal); } catch (error) { controller.abort(error); }
  };
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(htmlResourceError('html_resource_timeout')), limits.resourceTimeoutMs);
  const visited = new Set();
  try {
    let url = checkHtmlResourceUrl(rawUrl, limits);
    for (let redirects = 0; ; redirects++) {
      checkHtmlResourceAbort(controller.signal);
      checkHtmlResourceEnvironment(env); // A redirect never inherits a stale policy decision.
      if (visited.has(url.href)) failHtmlResource('html_resource_redirect');
      visited.add(url.href);
      const target = await resolvePublicTarget(url, { lookupImpl, networkInterfaces, limits, signal: controller.signal });
      checkHtmlResourceAbort(controller.signal);
      checkHtmlResourceEnvironment(env);
      const result = await getPinned(url, target, { requestImpl, maxBytes, signal: controller.signal });
      checkHtmlResourceAbort(controller.signal);
      if (result.location === undefined) return result;
      if (redirects >= limits.redirects) failHtmlResource('html_resource_redirect');
      if (/[\s\x00-\x20\x7f-\x9f\\]/u.test(result.location)) failHtmlResource('html_resource_redirect');
      let next;
      try { next = new URL(result.location, url).href; } catch { failHtmlResource('html_resource_redirect'); }
      url = checkHtmlResourceUrl(next, limits);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
