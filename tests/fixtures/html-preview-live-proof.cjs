'use strict';

// Opt-in acceptance observations only. No payload, console text, URL or headers
// are retained. The production extension remains the only image injector.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function providerImages(payload) {
  const images = new Map(); let visited = 0;
  const visit = (value, depth = 0) => {
    if (++visited > 30000 || depth > 30 || !value || typeof value !== 'object') return;
    let data;
    if (value.type === 'image' && value.source?.type === 'base64' && value.source.media_type === 'image/png') data = value.source.data;
    if (value.type === 'image' && value.mimeType === 'image/png' && typeof value.data === 'string') data = value.data;
    const url = value.image_url?.url || value.image_url;
    if (['image_url', 'input_image'].includes(value.type) && typeof url === 'string' && url.startsWith('data:image/png;base64,')) data = url.slice(22);
    if (typeof data === 'string' && data.length <= 4 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      const png = Buffer.from(data, 'base64');
      if (png.length >= 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        const sha256 = hash(png);
        images.set(sha256, { sha256, bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20), png });
      }
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child, depth + 1);
  };
  visit(payload); return [...images.values()];
}

function installObserver(pi) {
  const h = require('./visual-replies-support.cjs');
  const world = h.validateWorld(process.env.VISUAL_REPLIES_WORLD, process.env.VISUAL_REPLIES_TEMP_ROOT);
  const saved = new Set();
  const record = (ctx, value) => {
    const id = ctx.sessionManager.getSessionId();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Error('fixture_session_shape');
    fs.appendFileSync(path.join(world, 'evidence', `provider-${id}.jsonl`), JSON.stringify(value) + '\n');
  };
  pi.on('context_with_system', (event, ctx) => {
    const previewText = [], images = [];
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (value.role === 'toolResult' && value.toolName === 'html_preview') {
        const texts = (value.content || []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text);
        previewText.push(...texts);
        const mode = texts.some(text => text.includes('Interactive preview')) ? 'interactive'
          : texts.some(text => text.includes('Static preview')) ? 'static' : 'unknown';
        images.push(...providerImages(value.content).map(image => ({ ...image, mode })));
        return;
      }
      if (Array.isArray(value)) for (const child of value) visit(child);
      else for (const [key, child] of Object.entries(value)) if (key !== 'data' && key !== 'payload') visit(child);
    };
    visit(event.messages);
    record(ctx, { event: 'context', previewResults: previewText.length,
      staticPreview: previewText.some(text => text.includes('Static preview')),
      diagnostics: previewText.map(text => {
        const match = text.match(/\{\s*"console"\s*:[\s\S]*\}\s*$/);
        try { const value = JSON.parse(match?.[0] || ''); return { warningCount: value.warnings.length, errorCount: value.errors.length }; }
        catch { return { available: text.includes('"warnings":') }; }
      }), images: images.map(({ png, ...metadata }) => metadata) });
  });
  pi.on('before_provider_request', (event, ctx) => {
    const images = providerImages(event.payload);
    for (const image of images) if (!saved.has(image.sha256)) {
      fs.writeFileSync(path.join(world, 'evidence', 'provider-image-' + image.sha256 + '.png'), image.png, { flag: 'wx' });
      saved.add(image.sha256);
    }
    record(ctx, { event: 'request', images: images.map(({ png, ...metadata }) => metadata) });
    // Deliberately no return value: observe the real provider payload unchanged.
  });
  pi.on('after_provider_response', (event, ctx) => record(ctx, { event: 'response', status: event.status }));
}

function createChallenge() {
  const code = String(crypto.randomInt(1000, 10000)), width = 180, height = 70;
  const digits = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
    '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
  const rows = Buffer.alloc((1 + width * 3) * height, 255);
  for (let y = 0; y < height; y++) {
    rows[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const index = Math.floor((x - 14) / 40), dx = (x - 14) % 40, dy = y - 10;
      if (index < 0 || index > 3 || dx < 0 || dx >= 30 || dy < 0 || dy >= 50) continue;
      if (digits[Number(code[index])][Math.floor(dy / 10) * 3 + Math.floor(dx / 10)] !== '1') continue;
      rows.fill(0, y * (1 + width * 3) + 1 + x * 3, y * (1 + width * 3) + 4 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4), bytes = Buffer.concat([name, data]);
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', require('node:zlib').deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  return { code, data: png.toString('base64'), sha256: hash(png) };
}

function prepareProof(world) {
  const h = require('./visual-replies-support.cjs'); h.validateWorld(world);
  fs.writeFileSync(path.join(world, 'evidence', 'vision-challenge.json'), JSON.stringify(createChallenge()), { flag: 'wx' });
  const extension = path.join(world, 'agent', 'preview-observer.mjs');
  fs.writeFileSync(extension, `import proof from ${JSON.stringify(require('node:url').pathToFileURL(__filename).href)};\nexport default proof.installObserver;\n`, { flag: 'wx' });
  const file = path.join(world, 'agent', 'settings.json'), settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  settings.extensions = [extension]; fs.writeFileSync(file, JSON.stringify(settings));
}

module.exports = { providerImages, installObserver, createChallenge, prepareProof };
