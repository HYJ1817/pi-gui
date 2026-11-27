'use strict';
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const net = require('node:net');

// Real, tiny raster containers; JPEG is the same bounded SOF/SOS structure a
// server receives, not a made-up {body: string} fetch response.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==', 'base64');

/** ClientRequest events + binary IncomingMessage stream shape, with actual
 * lookup callback execution. No socket/DNS/HTTP fallback exists in this fixture. */
function resourceNetwork(responses = [], { lookup, interfaces = () => ({}) } = {}) {
  const requests = [], lookups = [], events = new EventEmitter();
  const lookupImpl = async (host, options) => {
    lookups.push({ host, options });
    return lookup ? lookup(host, options, lookups.length) : [{ address: '93.184.215.14', family: 4 }];
  };
  const requestImpl = options => {
    const spec = responses[requests.length] || {};
    if (spec.throw) throw spec.throw;
    const request = new EventEmitter();
    request.options = options;
    request.destroyed = false;
    request.destroy = () => {
      if (request.destroyed) return request;
      request.destroyed = true;
      request.response?.destroy();
      queueMicrotask(() => {
        if (spec.lateError) request.emit('error', spec.lateError);
        request.emit('close');
      });
      return request;
    };
    request.deliver = () => {
      if (request.destroyed) return;
      if (spec.error) { request.emit('error', spec.error); request.destroy(); return; }
      const response = new PassThrough();
      request.response = response;
      response.statusCode = spec.status ?? 200;
      response.headers = {
        'content-type': Object.hasOwn(spec, 'type') ? spec.type : 'image/png',
        ...(spec.headers || {}),
      };
      response.complete = false;
      request.callback(response);
      if (response.destroyed || spec.holdBody) return;
      queueMicrotask(() => {
        if (spec.abortResponse) { response.emit('aborted'); response.destroy(); return; }
        if (spec.responseError) { response.emit('error', spec.responseError); response.destroy(); return; }
        if (spec.prematureClose) { response.destroy(); return; }
        for (const chunk of spec.chunks || [spec.body ?? PNG]) {
          if (response.destroyed) return;
          response.write(chunk);
        }
        if (response.destroyed) return;
        response.complete = spec.complete !== false;
        response.end();
      });
    };
    request.end = () => queueMicrotask(() => {
      if (request.destroyed) return;
      const deliver = () => { if (!spec.holdResponse) request.deliver(); };
      if (net.isIP(options.hostname)) { request.pinned = [{ address: options.hostname, family: options.family }]; deliver(); }
      else options.lookup(options.hostname, { all: true }, (error, addresses) => {
        if (error) request.emit('error', error);
        else { request.pinned = addresses; deliver(); }
      });
    });
    requests.push(request);
    events.emit('request', request);
    return request;
  };
  // Match https.request(options, callback), not fetch(url) or a fake byte helper.
  const request = (options, callback) => {
    const req = requestImpl(options);
    req.callback = callback;
    return req;
  };
  return { requests, lookups, events, options: { env: {}, lookupImpl, requestImpl: request, networkInterfaces: interfaces } };
}
const resource = (url = 'https://cdn.example/a.png') => ({ url, type: 'image' });
const image = url => `<img src="${url}">`;
module.exports = { PNG, GIF, WEBP, JPEG, resourceNetwork, resource, image };
