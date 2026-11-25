import { decodeText } from './common.js';
import { archivePreviewLimit } from './archive-policy.js';

const MiB = 1024 * 1024;
const LIMITS = Object.freeze({ text: 4 * MiB, image: 8 * MiB, pdf: 32 * MiB, office: 32 * MiB, archive: 32 * MiB, media: 1024 * MiB, html: 4 * MiB, markdown: 4 * MiB, unsupported: 0 });
const chunkBytes = 8 * MiB;
// Requests carry concrete filesystem/member names, not URLs. Relative-link
// parsing already removes URL query/fragment syntax before this boundary.
const extOf = value => String(value || '').split(/[\\/]/).pop().split('.').pop().toLowerCase();
const typeFor = name => {
  const ext = extOf(name);
  if (ext === 'pdf') return 'pdf';
  if (['docx', 'xlsx', 'pptx', 'csv', 'tsv'].includes(ext)) return 'office';
  if (ext === 'zip') return 'archive';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['md', 'markdown', 'mdown', 'mkd'].includes(ext)) return 'markdown';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi', 'wma', 'wmv', 'flv', '3gp'].includes(ext)) return 'media';
  if (['exe', 'dll', 'com', 'scr', 'msi', 'lnk', 'url', 'app', 'dmg', 'iso', 'jar', 'wasm', 'bin', 'doc', 'xls', 'ppt', 'docm', 'xlsm', 'pptm', 'rar', '7z', 'gz', 'bz2', 'xz', 'zst', 'tar', 'tgz'].includes(ext)) return 'unsupported';
  return 'text';
};
const fail = (code = 'content_unavailable', metadata) => Object.assign(new Error(code), { code, ...(metadata ? { metadata } : {}) });

export async function createAccess(request, transport, signal) {
  let sourceBytes = null;
  let file = null;
  let metadata = { name: request.name || request.path || 'file', bytes: request.bytes ?? request.size, fileId: request.fileId || '', type: typeFor(request.name || request.path) };
  let type = typeFor(request.source ? metadata.name : request.path || metadata.name);
  let budget = LIMITS[type] ?? LIMITS.unsupported;
  if (request.source === 'attachment') {
    file = request.file;
    if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size) || file.size < 0) throw fail('attachment_unavailable');
    metadata.bytes = file.size;
    if (budget === 0) throw fail('unsupported_type', metadata);
    if (file.size > budget) throw fail('oversized', metadata);
  } else if (request.source === 'archive') {
    if (!(request.bytes instanceof Uint8Array)) throw fail('oversized');
    const memberBudget = archivePreviewLimit({ name: metadata.name, size: request.bytes.byteLength });
    if (!memberBudget) throw fail('oversized');
    budget = Math.min(budget, memberBudget);
    sourceBytes = new Uint8Array(request.bytes);
    metadata.bytes = sourceBytes.length;
    metadata.fileId = '';
  } else {
    const metadataFn = request.external ? transport?.externalMetadata : transport?.metadata;
    if (typeof metadataFn === 'function') {
      const info = request.external
        ? await metadataFn(request.path, request.grantId, request.conversationId, { signal })
        : await metadataFn(request.path, request.conversationId, { root: request.cwd || '', fileId: request.fileId || '', workspace: request.workspace, generation: request.generation, signal });
      if (!info?.ok || !info.file) throw fail(info?.code || 'metadata_unavailable');
      if (request.fileId && info.file.fileId && request.fileId !== info.file.fileId) throw fail('file_changed');
      metadata = { ...metadata, ...info.file, name: info.file.name || metadata.name, bytes: info.file.bytes, fileId: info.file.fileId || metadata.fileId,
        type: info.file.type || type, mime: info.file.mime, maxBytes: info.file.maxBytes, range: info.file.range };
    }
    type = typeFor(metadata.name);
    budget = LIMITS[type] ?? LIMITS.unsupported;
    if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0) throw fail('metadata_unavailable');
    if (Number.isFinite(metadata.maxBytes) && metadata.bytes > metadata.maxBytes) throw fail('oversized', metadata);
    if (budget === 0) throw fail('unsupported_type', metadata);
    if (metadata.bytes > budget) throw fail('oversized', metadata);
  }

  async function readAll(maxBytes, localSignal = signal) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw fail('oversized');
    maxBytes = Math.min(maxBytes, budget);
    if (Number.isFinite(metadata.bytes) && metadata.bytes > maxBytes) throw fail('oversized');
    if (localSignal?.aborted) throw fail('cancelled');
    if (sourceBytes) return new Uint8Array(sourceBytes);
    if (file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (localSignal?.aborted) throw fail('cancelled');
      if (bytes.length > maxBytes) throw fail('oversized');
      return bytes;
    }
    const fn = request.external ? transport?.externalContent : transport?.content;
    // Compatibility for existing injected tests/callers only. Production uses
    // the bounded binary endpoint and never expands old document/asset access.
    if (typeof fn !== 'function') {
      if (type === 'image' && typeof (request.external ? transport?.externalAsset : transport?.asset) === 'function') {
        const asset = await (request.external ? transport.externalAsset(request.path, request.grantId, request.conversationId, { signal: localSignal })
          : transport.asset(request.path, request.conversationId, { root: request.cwd || '', fileId: metadata.fileId, workspace: request.workspace, generation: request.generation, signal: localSignal }));
        if (asset?.ok && asset.blob) {
          if (asset.blob.size > maxBytes) throw fail('oversized');
          const bytes = new Uint8Array(await asset.blob.arrayBuffer());
          if (localSignal?.aborted) throw fail('cancelled');
          if (bytes.length > maxBytes) throw fail('oversized');
          return bytes;
        }
        throw fail(asset?.code || 'content_unavailable');
      }
      const documentFn = request.external ? transport?.externalDocument : transport?.document;
      if (['text', 'markdown', 'html'].includes(type) && typeof documentFn === 'function') {
        const doc = request.external
          ? await documentFn(request.path, request.grantId, request.conversationId, { signal: localSignal })
          : await documentFn(request.path, request.workspace, request.generation, { root: request.cwd || '', fileId: metadata.fileId, conversationId: request.conversationId, signal: localSignal });
        if (doc?.ok && !doc.file?.binary && typeof doc.file?.content === 'string') {
          const bytes = new TextEncoder().encode(doc.file.content);
          if (bytes.length > maxBytes) throw fail('oversized');
          return bytes;
        }
        if (doc?.ok && doc.file?.binary) throw fail('binary_text');
        throw fail(doc?.code || 'content_unavailable');
      }
      throw fail('content_unavailable');
    }
    if (!metadata.fileId) throw fail('file_identity_required');
    const expectedBytes = metadata.bytes;
    const maxRead = Math.min(maxBytes, budget, Number.isFinite(expectedBytes) ? expectedBytes : maxBytes);
    const chunks = [];
    let position = 0;
    while (position < maxRead) {
      if (localSignal?.aborted) throw fail('cancelled');
      const end = Math.min(maxRead, position + chunkBytes) - 1;
      const opts = request.external
        ? { range: `bytes=${position}-${end}`, signal: localSignal }
        : { root: request.cwd || '', fileId: metadata.fileId, workspace: request.workspace, generation: request.generation, range: `bytes=${position}-${end}`, signal: localSignal };
      const result = await fn(request.path, request.external ? request.grantId : request.conversationId,
        ...(request.external ? [metadata.fileId, request.conversationId, opts] : [opts]));
      if (localSignal?.aborted) throw fail('cancelled');
      if (!result?.ok || !(result.bytes instanceof Uint8Array)) throw fail(result?.code || 'content_unavailable');
      if (result.bytes.length > chunkBytes || position + result.bytes.length > maxBytes || !result.bytes.length) throw fail('oversized');
      if (result.rangeStart !== undefined && (result.rangeStart !== position || result.rangeEnd !== position + result.bytes.length - 1 || result.rangeTotal !== expectedBytes)) throw fail('file_changed');
      chunks.push(result.bytes); position += result.bytes.length;
      if (result.bytes.length < end - (position - result.bytes.length) + 1) break;
    }
    if (Number.isFinite(expectedBytes) && position !== expectedBytes) throw fail('file_changed');
    const output = new Uint8Array(position);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  }

  async function text(maxBytes, localSignal = signal, encoding = 'auto') {
    const bytes = await readAll(maxBytes, localSignal);
    return decodeText(bytes, encoding);
  }
  async function url(localSignal = signal) {
    if (file) return URL.createObjectURL(file);
    if (sourceBytes) return URL.createObjectURL(new Blob([sourceBytes]));
    if (typeof transport?.mediaUrl === 'function') return transport.mediaUrl({ ...request, fileId: metadata.fileId });
    throw fail('media_unavailable');
  }
  return { metadata, readAll, text, url, type, budget };
}

export { LIMITS as PREVIEW_ACCESS_LIMITS, typeFor as previewTypeFor };
