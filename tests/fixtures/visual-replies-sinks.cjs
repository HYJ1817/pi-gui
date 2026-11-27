'use strict';

/* Real local egress witnesses. Observing listeners only: they never replace any
 * production Electron permission/network policy. No request body/header/URL,
 * candidate, address or credential is retained in evidence.
 */
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');
const PRIVATE_V4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
function privateAddress() {
  return Object.values(os.networkInterfaces()).flat().find(item => !item.internal && item.family === 'IPv4' && PRIVATE_V4.test(item.address))?.address;
}
function listen(server, host) {
  return new Promise((resolve, reject) => {
    const failed = error => { server.removeListener('listening', ready); reject(error); };
    const ready = () => { server.removeListener('error', failed); resolve(server.address().port); };
    server.once('error', failed); server.once('listening', ready);
    if (typeof server.bind === 'function') server.bind(0, host); else server.listen(0, host);
  });
}
async function createSinks({ includePrivate = false } = {}) {
  const counters = { http: 0, httpBytes: 0, tcp: 0, tcpBytes: 0, udp: 0, udpBytes: 0, privateHttp: 0, ipv6Http: 0 };
  const servers = [], sockets = new Set(), origins = {};
  let closed = false;
  const serve = label => {
    const server = http.createServer((request, response) => {
      counters[label]++; request.on('data', data => { counters.httpBytes += data.length; }); request.resume();
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); response.end();
    });
    server.on('upgrade', (_request, socket) => { counters[label]++; socket.destroy(); });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    servers.push(server); return server;
  };
  const close = async () => {
    if (closed) return; closed = true;
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => {
      try { server.close(() => resolve()); } catch { resolve(); }
    })));
  };
  try {
    const httpPort = await listen(serve('http'), '127.0.0.1');
    origins.loopback = 'http://127.0.0.1:' + httpPort;
    origins.localhost = 'http://localhost:' + httpPort;
    try { origins.ipv6 = 'http://[::1]:' + await listen(serve('ipv6Http'), '::1'); }
    catch (error) { if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EACCES'].includes(error.code)) throw error; }
    const privateHost = includePrivate ? privateAddress() : null;
    if (privateHost) origins.private = 'http://' + privateHost + ':' + await listen(serve('privateHttp'), privateHost);
    const tcp = net.createServer(socket => {
      counters.tcp++; sockets.add(socket); socket.on('data', data => { counters.tcpBytes += data.length; });
      socket.once('close', () => sockets.delete(socket)); socket.resume();
    });
    servers.push(tcp);
    const tcpPort = await listen(tcp, '127.0.0.1');
    const udp = dgram.createSocket('udp4'); servers.push(udp);
    udp.on('message', data => { counters.udp++; counters.udpBytes += data.length; });
    const udpPort = await listen(udp, '127.0.0.1');
    return { config: { http: origins.loopback, origins, stun: 'stun:127.0.0.1:' + udpPort,
      turn: 'turn:127.0.0.1:' + tcpPort + '?transport=tcp' },
      coverage: { loopback: true, localhost: true, ipv6: Boolean(origins.ipv6), privateHostInterface: Boolean(origins.private),
        externalNetworkContacted: false, productionNetworkInterceptionInstalled: false },
      snapshot: () => ({ ...counters }), reset() { for (const key of Object.keys(counters)) counters[key] = 0; }, close,
      async positiveControl() {
        // These Node-only controls validate that the listeners count actual
        // packets; they do not masquerade as successful iframe/API protection.
        await fetch(origins.loopback + '/controlled-self-test', { method: 'POST', body: 'synthetic' });
        await new Promise((resolve, reject) => {
          const socket = net.connect({ port: tcpPort, host: '127.0.0.1' });
          socket.once('connect', () => { socket.end('synthetic'); }); socket.once('error', reject); socket.once('close', resolve);
        });
        await new Promise((resolve, reject) => {
          const packet = dgram.createSocket('udp4');
          packet.send(Buffer.from('synthetic'), udpPort, '127.0.0.1', error => { packet.close(); error ? reject(error) : resolve(); });
        });
        const deadline = Date.now() + 2000;
        while (counters.udp < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        return { httpObserved: counters.http >= 1, tcpObserved: counters.tcp >= 1, udpObserved: counters.udp >= 1 };
      } };
  } catch (error) { await close(); throw error; }
}
module.exports = { createSinks };
