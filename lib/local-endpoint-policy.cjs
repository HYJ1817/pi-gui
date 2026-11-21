'use strict';

// Extra permission is for one configured endpoint, never a resolver-wide rule.
// LAN hostnames are deliberately not eligible: without an IP literal the native
// Pi client cannot preserve the GUI's DNS witness for its later requests.
const net = require('node:net');
const { classifyAddress } = require('./market-network-policy.cjs');

function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || /%(?:2f|5c|2e|25|00)|\/\//iu.test(url.pathname)) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return { url: url.href, protocol: url.protocol.slice(0, -1), host, port, path: url.pathname };
  } catch { return null; }
}

function metadataAddress(address) {
  // Node accepts scoped IPv6 in isIPv6(), but WHATWG URLs do not. Leave
  // scoped/invalid answers to the classifier's closed rejection, not a throw.
  if (typeof address !== 'string' || address.includes('%')) return false;
  const value = net.isIPv6(address) ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address;
  return ['168.63.129.16', '169.254.169.254', '100.100.100.200', 'fd00:ec2::254'].includes(value);
}

function localKind(address) {
  if (!net.isIP(address) || metadataAddress(address)) return null;
  const kind = classifyAddress(address);
  if (kind === 'loopback') return 'loopback';
  // Only RFC1918 and IPv6 unique-local, not CGNAT, link-local, metadata,
  // documentation, benchmark/Fake-IP, translated addresses or other reserves.
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return 'lan';
  } else if (kind === 'ula') return 'lan';
  return null;
}

function eligible(target) {
  return Boolean(target && !metadataAddress(target.host) && (target.host === 'localhost' || localKind(target.host)));
}

function protectedLocal(target, addresses, controlPorts = []) {
  return addresses.some(address => Boolean(localKind(address))) && controlPorts.includes(target.port);
}

function permitsAddresses(target, addresses, { controlPorts = [] } = {}) {
  if (!eligible(target) || !Array.isArray(addresses) || !addresses.length
    || addresses.some(metadataAddress) || protectedLocal(target, addresses, controlPorts)) return false;
  if (target.host === 'localhost') return addresses.every(address => address === '127.0.0.1' || address === '::1');
  if (net.isIP(target.host)) return addresses.every(address => address === target.host) && Boolean(localKind(target.host));
  return false;
}

module.exports = { endpoint, localKind, metadataAddress, eligible, protectedLocal, permitsAddresses };
