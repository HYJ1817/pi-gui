'use strict';
// Additional guard for the real desktop fixture: fetch guards alone do not
// cover Node HTTP, TLS, CONNECT or SDK worker transports. No dependency download,
// user proxy reconfiguration or remote destination is permitted in this runner.
const net = require('node:net');
const dns = require('node:dns');
const local = value => {
  const host = String(value || 'localhost').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || net.isIP(host) === 4 && host.startsWith('127.');
};
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = first && typeof first === 'object' ? first.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (host && !local(host)) throw Object.assign(Error('offline_fixture'), { code: 'ENETUNREACH' });
  return original.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (local(host)) return lookup.call(this, host, ...args);
  const callback = args.at(-1);
  if (typeof callback !== 'function') throw Error('offline_fixture');
  queueMicrotask(() => callback(Object.assign(Error('offline_fixture'), { code: 'ENOTFOUND' })));
};
const promises = require('node:dns/promises');
const promiseLookup = promises.lookup;
promises.lookup = async function (host, ...args) {
  if (!local(host)) throw Object.assign(Error('offline_fixture'), { code: 'ENOTFOUND' });
  return promiseLookup.call(this, host, ...args);
};
globalThis.__systemRawNetworkGuard = true;
