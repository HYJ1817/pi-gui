import { parseOffice } from './office-parse.js';

const SAFE_CODES = new Set(['size', 'sheet-limit', 'slide-limit', 'slide-size', 'image-limit', 'xml-limit', 'active-content', 'external-link', 'entity', 'encoding', 'csv-format', 'format', 'duplicate']);
let started = false;
self.onmessage = async event => {
  if (started) return;
  started = true;
  try {
    const { kind, buffer, encoding } = event.data || {};
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Invalid input');
    const result = await parseOffice(kind, new Uint8Array(buffer), encoding);
    self.postMessage({ ok: true, result });
  } catch (error) {
    // No original XML, cell values, relationships, filenames, stack or parser
    // messages cross the worker's error boundary.
    self.postMessage({ ok: false, code: SAFE_CODES.has(error?.code) ? error.code : 'invalid' });
  }
};
