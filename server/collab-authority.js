import { createHash } from 'node:crypto';
import { createReviewCommentAuthority } from './review-comment-authority.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(Error(code), { code });
const ACTION_CODES = new Set(['collab_invalid', 'collab_conflict', 'collab_scope_unavailable', 'collab_storage_unsafe',
  'collab_storage_inside_project', 'collab_storage_corrupt', 'collab_storage_unavailable', 'collab_storage_write_failed',
  'collab_storage_busy', 'collab_storage_limit', 'collab_editor_expired', 'collab_proposal_unavailable']);

/* Reuse the complete backend evidence acquisition and lifecycle lock. Neither
 * the native session locator nor a client-selected namespace crosses this API. */
export function createCollabAuthority(options = {}) {
  const withReviewAuthority = createReviewCommentAuthority(options);
  return async function withAuthority(req, action) {
    let outcome;
    try {
      outcome = await withReviewAuthority(req, async verified => {
        const scope = {
          key: digest(['collab-documents-v1', verified.key]),
          token: digest(['collab-owner-v1', verified.token]),
          sessionId: digest(['collab-session-v1', verified.key]),
          projectRoot: verified.projectRoot, workspaceCwd: verified.workspaceCwd, gitCommon: verified.gitCommon,
          assertCurrent() {
            try { verified.assertCurrent(); }
            catch { throw fail('collab_scope_unavailable'); }
          },
        };
        scope.assertCurrent();
        // Review authority intentionally sanitizes callback exceptions. Capture
        // ours as data to retain only the collaborative service's safe codes.
        try { return { value: await action(scope) }; }
        catch (error) { return { error: ACTION_CODES.has(error?.code) ? error.code : 'collab_scope_unavailable' }; }
      });
    } catch { throw fail('collab_scope_unavailable'); }
    if (outcome.error) throw fail(outcome.error);
    return outcome.value;
  };
}
