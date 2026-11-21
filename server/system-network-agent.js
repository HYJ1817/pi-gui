/* Main's private loopback proxy is a transport, never an SSRF authority. This
 * adapter is used only AFTER provider-network has validated consent and every
 * DNS result. CONNECT pins the checked IP; the separate route-host is used by
 * main only for PAC/bypass selection. TLS still authenticates the original host.
 * Ordinary/source servers without the main-issued capability stay on their
 * existing pinned direct transport, not on arbitrary ambient proxy variables. */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import policy from '../lib/system-network-policy.cjs';

const { PRIVATE_PROXY_KEY, privateProxy, isPrivateProxyEnvironment, LOOPBACK } = policy;
let backendProxy;

// Consume the bootstrap secret before the backend constructs any spawn owner.
// Configure this process's transport, not the environment inherited by tools.
export function startSystemNetwork(env = process.env, { onEndpointPolicyChange = () => {} } = {}) {
  const proxy = env[PRIVATE_PROXY_KEY];
  const desktop = env.PI_GUI_DESKTOP === '1';
  const relaxed = desktop && env.PI_GUI_NETWORK_RELAXED === '1';
  for (const key of Object.keys(env)) if (isPrivateProxyEnvironment(key, env[key])) delete env[key];
  if (desktop) delete env.PI_GUI_NETWORK_RELAXED;
  const state = { desktop, relaxed, endpointGeneration: 0, controlPorts: privateProxy(proxy) ? [+privateProxy(proxy).port] : [] };
  if (desktop && process.send && process.connected) process.on('message', message => {
    // Only the directly attached Main process owns this private IPC. Routing
    // stays frozen; this updates only eligibility for extra endpoint grants.
    if (message?.type !== 'system-endpoint-policy' || typeof message.relaxed !== 'boolean'
      || typeof message.requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(message.requestId)) return;
    let ok = true;
    const disabling = state.relaxed && !message.relaxed;
    if (disabling) state.endpointGeneration++;
    state.relaxed = message.relaxed;
    if (!state.relaxed) {
      // Revocation is idempotent. A retried disable must finish it before ACK,
      // even when the earlier attempt already flipped the eligibility bit.
      try { onEndpointPolicyChange(); } catch { ok = false; }
    }
    try { process.send({ type: 'system-endpoint-policy-ack', requestId: message.requestId, ok,
      relaxed: state.relaxed, endpointGeneration: state.endpointGeneration }, () => {}); } catch { /* Parent exited. */ }
  });
  if (proxy && desktop) {
    if (!process.send || !process.connected || !privateProxy(proxy) || typeof http.setGlobalProxyFromEnv !== 'function') {
      throw Error('network_transport_unsupported');
    }
    http.setGlobalProxyFromEnv({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: LOOPBACK.join(',') });
    backendProxy = proxy;
  }
  return state;
}
export function hasSystemProxyCapability(env) { return privateProxy(env?.[PRIVATE_PROXY_KEY]) !== null; }
export function systemWorkerProxy(env) {
  return hasSystemProxyCapability(env) ? env[PRIVATE_PROXY_KEY] : backendProxy;
}
// This is our SDK worker's initialization, not Pi CLI patching. Use Node's public
// transport API before importing the SDK. Never mutate the backend/main global
// fetch, and never widen the private discovery worker's pinned request policy.
export function systemWorkerProxyPrelude(proxy) {
  if (!privateProxy(proxy)) return '';
  return `{
    const http = require('node:http');
    if (typeof http.setGlobalProxyFromEnv !== 'function') throw Error('network_transport_unsupported');
    const { workerData } = require('node:worker_threads');
    const proxy = workerData.systemProxy;
    http.setGlobalProxyFromEnv({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,[::1],::1' });
    delete workerData.systemProxy;
  }\n`;
}
export function createPinnedSystemAgent({ host, port, address, signal, timeoutMs, env, proxy = env ? env[PRIVATE_PROXY_KEY] : backendProxy, tlsOptions = {} }) {
  const gateway = privateProxy(proxy);
  if (!gateway) return null;
  // This guard is not a replacement for the caller's address classification.
  if (!net.isIP(address) || !host || /[\s\x00-\x1f\x7f/@?#\\]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('network_unavailable');
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    let done = false, socket;
    const finish = (error, connected) => {
      if (done) { if (connected && connected !== socket) connected.destroy(); return; }
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { socket?.destroy(); request.destroy(); }
      callback(error ? Error('network_unavailable') : null, connected);
    };
    const abort = () => finish(Error('aborted'));
    const timer = setTimeout(abort, Math.max(1, Math.min(30000, timeoutMs || 15000)));
    const authority = `${net.isIP(address) === 6 ? '[' + address + ']' : address}:${port}`;
    const request = http.request({ host: '127.0.0.1', port: +gateway.port, method: 'CONNECT', path: authority,
      agent: false, headers: { host: authority,
        'proxy-authorization': 'Basic ' + Buffer.from('pi-gui:' + gateway.password).toString('base64'),
        'x-pi-gui-route-host': host } });
    request.on('error', () => finish(Error('network_unavailable')));
    request.on('connect', (response, raw, head) => {
      socket = raw;
      if (done || signal?.aborted || response.statusCode !== 200) { raw.destroy(); finish(Error('network_unavailable')); return; }
      if (head.length) raw.unshift(head);
      socket = tls.connect({ ...tlsOptions, socket: raw, host, servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: true, checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert) });
      socket.on('error', () => finish(Error('network_unavailable')));
      socket.once('secureConnect', () => {
        if (signal?.aborted) return finish(Error('aborted'));
        finish(null, socket);
      });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else request.end();
  };
  return agent;
}
