import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { materializeDir } from '../lib/assets.js';
import { json, readRawBody } from './http-utils.js';
import { readExecutionBranch } from './execution-timeline.js';
import { HTML_RESOURCE_ERROR_CODES } from './html-resource-policy.js';
import { HTML_PREVIEW_TOOL } from '../public/html-preview-model.js';
import { HTML_ARTIFACT_MAX_BYTES, HTML_RENDER_TOOL, htmlArtifactToolDetails,
  normalizeHtmlArtifactHeight, projectHtmlArtifactReference } from '../public/html-artifact-model.js';

const fail = code => { throw Object.assign(Error('HTML visualization unavailable.'), { code }); };
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const identifier = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const canonical = file => fs.realpathSync.native(file);
function stamp(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 512 * 1024) throw Error();
  return createHash('sha256').update(JSON.stringify([canonical(file), stat.dev, stat.ino, stat.birthtimeMs]))
    .update(fs.readFileSync(file)).digest('hex');
}
function directory(file) {
  const stat = fs.statSync(file);
  if (!stat.isDirectory()) throw Error();
  return JSON.stringify([canonical(file), stat.dev, stat.ino, stat.birthtimeMs]);
}
function contract(launch) {
  try {
    const root = launch.packageDir();
    const read = relative => {
      const file = path.join(root, relative), stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 512 * 1024) throw Error();
      return fs.readFileSync(file, 'utf8');
    };
    const types = read('dist/core/extensions/types.d.ts');
    const manager = read('dist/core/session-manager.d.ts');
    const args = read('dist/cli/args.js');
    return types.includes('registerTool<') && /execute\(toolCallId: string, params:/.test(types)
      && types.includes('promptSnippet?') && types.includes('promptGuidelines?')
      && ['getSessionId', 'getLeafId', 'getBranch'].every(key => manager.includes(key + '('))
      && args.includes('"--extension"');
  } catch { return false; } // Optional capability must not prevent ordinary Pi startup.
}
const CODES = new Set(['invalid_request', 'stale_runtime', 'html_bridge_unavailable', 'html_cancelled',
  'html_immutable_conflict', 'html_storage_full', 'html_too_large', 'html_store_unavailable',
  'html_preview_unavailable', 'html_preview_timeout', 'html_preview_busy', 'html_preview_failed',
  ...HTML_RESOURCE_ERROR_CODES]);

// One private capability per child launch, never shared with the tool guard or
// renderer. Native IDs are assertions to verify, not authority supplied by HTTP.
export function createHtmlRenderBridge({ store, launch, getCwd, readState, readEntries, capture,
  isCurrent, scopeForWitness, canRevalidate = () => false, supported, readTimeoutMs = 1500, publication = null,
  preview = null, prepareHtml = null } = {}) {
  let server = null, binding = null, disposed = false, preparing = null;
  const source = () => launch.identityKey?.() ?? launch.packageDir?.();
  function valid(b) {
    try { return !disposed && b === binding && !b.revoked && b.source === source()
      && b.cwd === directory(getCwd()) && b.extensionStamp === stamp(b.extension); }
    catch { return false; }
  }
  function check(b, witness, epoch) {
    if (!valid(b) || b.paused || b.epoch !== epoch || !isCurrent(witness)) fail('stale_runtime');
  }
  function revoke() {
    const b = binding;
    if (!b) return;
    b.revoked = true; b.epoch++;
    for (const cancel of [...b.waits]) cancel();
  }
  function bounded(b, operation) {
    return new Promise(resolve => {
      let done = false;
      const finish = result => { if (done) return; done = true; clearTimeout(timer); b.waits.delete(cancel); resolve(result); };
      const cancel = () => finish(null), timer = setTimeout(cancel, readTimeoutMs);
      b.waits.add(cancel);
      Promise.resolve().then(operation).then(finish, () => finish(null));
    });
  }
  async function verify(b, native, witness, epoch) {
    check(b, witness, epoch);
    const state = await bounded(b, readState);
    check(b, witness, epoch);
    if (!state || state.__error || state.sessionId !== native) fail('html_bridge_unavailable');
  }
  async function declaration(b, body, witness, epoch, tool) {
    const branch = await readExecutionBranch({ scope: scopeForWitness(witness), branchEpoch: epoch,
      readState: () => bounded(b, readState), readEntries: () => bounded(b, readEntries),
      isCurrent: () => { check(b, witness, epoch); return true; },
    });
    check(b, witness, epoch);
    if (!branch) fail('html_bridge_unavailable');
    const index = branch.entries.findIndex(row => row.id === body.messageId), entry = branch.entries[index];
    if (entry?.role !== 'assistant' || !entry.toolCalls?.some(call => call.id === body.toolCallId && call.name === tool)) fail('invalid_request');
    // The most recent assistant owns this execution, not an older reused call ID.
    if (branch.entries.slice(index + 1).some(row => ['assistant', 'user'].includes(row.role)
      || row.role === 'toolResult' && row.toolCallId === body.toolCallId)) fail('stale_runtime');
  }
  async function route(req, res) {
    const b = binding;
    if (req.method !== 'POST' || req.headers.origin || !b || !same(req.headers['x-pi-gui-html-token'], b.token)) return json(res, 403, { ok: false, code: 'unauthorized' });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    b.waits.add(cancel);
    res.once('close', cancel);
    try {
      if (!valid(b)) fail('html_bridge_unavailable');
      let body;
      try { body = JSON.parse((await readRawBody(req, HTML_ARTIFACT_MAX_BYTES * 6 + 4096)).toString('utf8')); }
      catch { fail('invalid_request'); }
      if (!identifier(body?.sessionId, 128)) fail('invalid_request');
      const witness = capture(body.sessionId), epoch = b.epoch;
      check(b, witness, epoch);
      if (b.witness && !isCurrent(b.witness) && !canRevalidate(b.witness, witness)) fail('stale_runtime');
      if (req.url === '/hello') {
        if (!closed(body, ['sessionId'])) fail('invalid_request');
        await verify(b, body.sessionId, witness, epoch);
        b.native = body.sessionId; b.witness = witness;
        return json(res, 200, { ok: true });
      }
      const isPreview = req.url === '/preview';
      const keys = ['sessionId', 'messageId', 'toolCallId', 'html', 'height', 'resources'];
      if ((!isPreview && req.url !== '/publish') || !closed(body, [...keys, ...(isPreview ? ['width', 'theme'] : ['title'])])
        || b.native !== body.sessionId || !identifier(body.messageId) || !identifier(body.toolCallId)
        || typeof body.html !== 'string' || !Buffer.byteLength(body.html)) fail('invalid_request');
      if (isPreview) {
        if (!preview) fail('html_preview_unavailable');
        if (body.width !== undefined && (!Number.isInteger(body.width) || body.width < 240 || body.width > 1600)
          || body.height !== undefined && (!Number.isInteger(body.height) || body.height < 80 || body.height > 4096)
          || body.theme !== undefined && !['light', 'dark'].includes(body.theme)) fail('invalid_request');
      } else if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 160
        || /[\x00-\x1f\x7f]/.test(body.title) || normalizeHtmlArtifactHeight(body.height) === null) fail('invalid_request');
      if (Buffer.byteLength(body.html) > HTML_ARTIFACT_MAX_BYTES) fail('html_too_large');
      const tool = isPreview ? HTML_PREVIEW_TOOL : HTML_RENDER_TOOL;
      await declaration(b, body, witness, epoch, tool);
      if (controller.signal.aborted) fail('html_cancelled');
      const { resources, ...input } = body;
      if (resources !== undefined && !prepareHtml) fail('html_resource_unsupported');
      if (prepareHtml) input.html = await prepareHtml(input.html, resources, { signal: controller.signal });
      if (controller.signal.aborted) fail('html_cancelled');
      check(b, witness, epoch);
      if (isPreview) {
        const { html, width, height, theme } = input;
        const result = await preview({ html, width, height, theme }, { signal: controller.signal });
        if (controller.signal.aborted) fail('html_cancelled');
        await declaration(b, body, witness, epoch, tool);
        b.witness = witness;
        return json(res, 200, result);
      }
      const finish = publication?.begin?.();
      try {
        const artifact = projectHtmlArtifactReference(await store.publish(input));
        await declaration(b, body, witness, epoch, tool);
        check(b, witness, epoch);
        if (res.destroyed) fail('html_cancelled');
        if (!artifact || artifact.sessionId !== body.sessionId || artifact.messageId !== body.messageId || artifact.toolCallId !== body.toolCallId) fail('html_store_unavailable');
        b.witness = witness;
        return json(res, 200, { ok: true, details: htmlArtifactToolDetails(artifact) });
      } finally { finish?.(); }
    } catch (error) {
      const code = controller.signal.aborted ? 'html_cancelled' : ({ html_artifact_invalid: 'invalid_request', html_artifact_conflict: 'html_immutable_conflict',
        html_artifact_quota: 'html_storage_full' })[error?.code] || (CODES.has(error?.code) ? error.code : 'html_store_unavailable');
      if (!res.destroyed) return json(res, 409, { ok: false, code });
    } finally {
      b.waits.delete(cancel);
      res.removeListener('close', cancel);
    }
  }
  return {
    available: () => true,
    prepare() {
      if (preparing) return preparing;
      preparing = (async () => {
        revoke();
        if (disposed || !(supported !== undefined ? supported : contract(launch))) return null;
        const extension = path.join(materializeDir('extensions/pi-gui-html'), 'index.js');
        const b = { token: randomBytes(32).toString('hex'), source: source(), cwd: directory(getCwd()), extension,
          extensionStamp: stamp(extension), native: null, witness: null, epoch: 0, paused: false, revoked: false, waits: new Set() };
        binding = b;
        if (!server) {
          server = http.createServer((req, res) => { void route(req, res); });
          server.requestTimeout = 15000; server.headersTimeout = 10000;
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        }
        if (!valid(b)) { revoke(); return null; }
        return { args: ['--extension', extension], env: { PI_GUI_HTML_URL: `http://127.0.0.1:${server.address().port}`, PI_GUI_HTML_TOKEN: b.token } };
      })().finally(() => { preparing = null; });
      return preparing;
    },
    pause() { if (binding) { binding.paused = true; binding.epoch++; for (const cancel of [...binding.waits]) cancel(); } },
    resume() { if (binding && valid(binding)) binding.paused = false; },
    invalidate: revoke,
    async dispose() {
      disposed = true; revoke();
      await preparing?.catch(() => {});
      if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); server = null; }
    },
  };
}
