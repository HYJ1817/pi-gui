'use strict';

// Shared value contract, not a URL fetcher. Proxy/bypass configuration never
// grants an endpoint permission; each request owner retains its SSRF policy.
const net = require('node:net');
const DEFAULTS = Object.freeze({ mode: 'system', proxy: '', bypass: '', relaxed: false });
const KEYS = Object.keys(DEFAULTS);
const LOOPBACK = Object.freeze(['localhost', '127.0.0.1', '[::1]']);
const PROXY_KEYS = ['http_proxy', 'https_proxy', 'all_proxy'];
const PRIVATE_PROXY_KEY = 'PI_GUI_SYSTEM_PROXY';
const ENV_KEYS = new Set([...PROXY_KEYS, 'no_proxy', 'node_use_env_proxy', PRIVATE_PROXY_KEY.toLowerCase(), 'pi_gui_network_relaxed']);

function privateProxy(value) {
  try {
    if (typeof value !== 'string' || value.length > 256) return null;
    const u = new URL(value);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.username === 'pi-gui'
      && /^pi-proxy-token-[a-f0-9]{64}$/.test(u.password) && u.port && u.pathname === '/' && !u.search && !u.hash ? u : null;
  } catch { return null; }
}
function isPrivateProxyEnvironment(key, value) {
  const name = key.toLowerCase();
  return name === PRIVATE_PROXY_KEY.toLowerCase() || PROXY_KEYS.includes(name) && Boolean(privateProxy(value));
}

function proxyAddress(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)
      || url.username || url.password || url.search || url.hash || url.pathname && url.pathname !== '/'
      || !url.hostname || !url.port && !['http:', 'https:'].includes(url.protocol)) return null;
    // URL normalizes an explicit default HTTP(S) port to the empty string.
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
    const host = url.hostname.toLowerCase();
    if (!net.isIP(host.replace(/^\[|\]$/g, '')) && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) return null;
    return { protocol: url.protocol.slice(0, -1), host, port: Number(port),
      address: `${url.protocol}//${host}:${port}`, chromium: `${url.protocol === 'socks5h:' ? 'socks5:' : url.protocol}//${host}:${port}` };
  } catch { return null; }
}
function bypassEntries(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null;
  const entries = value.split(/[,;\r\n]/).map(item => item.trim().toLowerCase()).filter(Boolean);
  if (entries.length > 64) return null;
  for (const entry of entries) {
    // A deliberately small common subset of Chromium and Node NO_PROXY:
    // hostname, suffix, IPv4 or bracketed IPv6, each with optional port.
    const match = /^(\[[0-9a-f:]+\]|(?:\*\.)?\.?[a-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(entry);
    if (!match || match[2] && (+match[2] < 1 || +match[2] > 65535)) return null;
    const host = match[1].replace(/^\*\.|^\./, '');
    if (host.startsWith('[')) { if (net.isIP(host.slice(1, -1)) !== 6) return null; }
    else if (!net.isIP(host) && (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..'))) return null;
  }
  return [...new Set(entries)];
}
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(value, key))
    || !['system', 'direct', 'custom'].includes(value.mode) || typeof value.relaxed !== 'boolean'
    || typeof value.proxy !== 'string' || typeof value.bypass !== 'string') return null;
  const entries = bypassEntries(value.bypass);
  if (!entries || value.proxy && !proxyAddress(value.proxy) || value.mode === 'custom' && !value.proxy) return null;
  return { mode: value.mode, proxy: value.proxy ? proxyAddress(value.proxy).address : '', bypass: entries.join(', '), relaxed: value.relaxed };
}
function validNetworkSettings(value) { return Boolean(normalize(value)); }
function electronProxy(value) {
  const config = normalize(value);
  if (!config) throw new TypeError('invalid network settings');
  if (config.mode !== 'custom') return { mode: config.mode };
  return { mode: 'fixed_servers', proxyRules: proxyAddress(config.proxy).chromium,
    proxyBypassRules: [...LOOPBACK, ...bypassEntries(config.bypass)].join(';') };
}
function withoutProxyEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !ENV_KEYS.has(key.toLowerCase())));
}
function directEnvironment(env) {
  // Pi's public CLI fills HTTP(S)_PROXY from its own httpProxy setting with
  // ??=. Explicit empty values prevent that refill without touching Pi config.
  // Other programs may still implement their own routing; this is not a VPN.
  return { ...withoutProxyEnvironment(env), HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*', NODE_USE_ENV_PROXY: '0' };
}
function externalEnvironment(value, env) {
  const config = normalize(value);
  if (!config) throw new TypeError('invalid network settings');
  if (config.mode === 'direct') return directEnvironment(env);
  if (config.mode === 'system') {
    // External programs may honor existing OS/environment or their own setup;
    // they cannot consume Chromium PAC or the private compatibility gateway.
    return Object.fromEntries(Object.entries(env).filter(([key, item]) =>
      !isPrivateProxyEnvironment(key, item) && !['node_use_env_proxy', 'pi_gui_network_relaxed'].includes(key.toLowerCase())));
  }
  const proxy = config.proxy.replace(/^socks5h:/, 'socks5:'); // Pi/undici SOCKS5 resolves the hostname remotely.
  const bypass = [...LOOPBACK, '::1', ...bypassEntries(config.bypass)].join(',');
  return { ...withoutProxyEnvironment(env), HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: bypass, no_proxy: bypass };
}
module.exports = { DEFAULTS, LOOPBACK, PRIVATE_PROXY_KEY, privateProxy, isPrivateProxyEnvironment,
  proxyAddress, bypassEntries, normalize, validNetworkSettings, electronProxy, withoutProxyEnvironment, directEnvironment, externalEnvironment };
