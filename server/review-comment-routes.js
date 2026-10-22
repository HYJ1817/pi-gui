import { timingSafeEqual } from 'node:crypto';
import { json, readRawBody } from './http-utils.js';
import { REVIEW_DATA_LIMITS, REVIEW_STORAGE_MESSAGES, validReviewRevision } from '../lib/review-comment-data.js';

const fail = code => { throw Object.assign(Error(code), { code }); };
const tokenMatches = (a, b) => typeof a === 'string' && /^[a-f0-9]{64}$/.test(a)
  && typeof b === 'string' && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/* Installed after the router's existing auth check and before its classic-only
 * owner guard. Both classic/runtime requests enforce their own full authority. */
export function createReviewCommentRoutes({ store, withAuthority } = {}) {
  return { async handle(req, res, url) {
    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { ok: false, code: 'comment_invalid' });
    let payload;
    try {
      if (url.search) fail('comment_invalid');
      if (req.method === 'POST') {
        let bytes;
        try { bytes = await readRawBody(req, REVIEW_DATA_LIMITS.fileBytes); }
        catch { return json(res, 413, { ok: false, code: 'comment_invalid', error: REVIEW_STORAGE_MESSAGES.comment_invalid }); }
        const text = bytes.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(bytes)) fail('comment_invalid');
        try { payload = JSON.parse(text); } catch { fail('comment_invalid'); }
        if (!payload || Array.isArray(payload) || Object.keys(payload).length !== 4
          || !Object.keys(payload).every(k => ['scope', 'token', 'revision', 'comments'].includes(k))
          || !validReviewRevision(payload.revision) || !Array.isArray(payload.comments)) fail('comment_invalid');
      }
      return await withAuthority(req, scope => {
        scope.assertCurrent();
        if (payload && (payload.scope !== scope.key || !tokenMatches(payload.token, scope.token))) fail('comment_scope_unavailable');
        const result = payload ? store.write(scope, payload.revision, payload.comments) : store.read(scope);
        scope.assertCurrent();
        return json(res, 200, { ok: true, scope: scope.key, token: scope.token, ...result });
      });
    } catch (e) {
      const code = Object.hasOwn(REVIEW_STORAGE_MESSAGES, e?.code) ? e.code : 'comment_storage_unavailable';
      const status = code === 'comment_invalid' ? 400 : ['comment_storage_unavailable', 'comment_storage_write_failed'].includes(code) ? 503 : 409;
      // Never return filesystem error.message, payloads, paths or comments.
      return json(res, status, { ok: false, code, error: REVIEW_STORAGE_MESSAGES[code] });
    }
  } };
}
