import { createHash } from 'node:crypto';
import { createReviewCommentAuthority } from './review-comment-authority.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const ACTION_CODES = new Set(['collab_invalid', 'collab_conflict', 'collab_scope_unavailable', 'collab_storage_unsafe',
  'collab_storage_inside_project', 'collab_storage_corrupt', 'collab_storage_unavailable', 'collab_storage_write_failed',
  'collab_storage_busy', 'collab_storage_limit', 'collab_editor_expired', 'collab_proposal_unavailable',
  'collab_generation_active', 'collab_agent_busy', 'collab_generate_unavailable', 'collab_generate_rejected',
  'collab_generate_failed', 'collab_generate_aborted', 'collab_generate_invalid_output', 'collab_generate_no_output',
  'collab_generate_timeout', 'collab_queue_full']);

/* Reuse the complete backend evidence acquisition and lifecycle lock. Neither
 * the native session locator nor a client-selected namespace crosses this API. */
export function createCollabAuthority(options = {}) {
  const withReviewAuthority = createReviewCommentAuthority(options);
  return async function withAuthority(req, action) {
    // 生成通道选择只看「是否带已验证的会话头」：带 = Runtime，否则 Classic。
    // 值本身仍由 review authority 对焦点会话核验，这里不重复信任。
    const conversationHeader = req.headers?.['x-pi-gui-conversation'];
    let outcome;
    try {
      outcome = await withReviewAuthority(req, async verified => {
        const scope = {
          key: digest(['collab-documents-v1', verified.key]),
          token: digest(['collab-owner-v1', verified.token]),
          sessionId: digest(['collab-session-v1', verified.key]),
          origin: conversationHeader !== undefined ? 'runtime' : 'classic',
          conversationId: conversationHeader ?? null,
          projectRoot: verified.projectRoot, workspaceCwd: verified.workspaceCwd, gitCommon: verified.gitCommon,
          /* Z4-3 安全收口：在验证通过的工作区锁内捕获服务端身份快照。
           * dispatch（锁外发送）前 source 会把「当前通道身份」与该快照逐项
           * 比对，并反复调用 assertCurrent——项目/会话/代次变化的旧请求
           * fail closed，不得向新 Pi 会话发送指令。 */
          expectedIdentity: conversationHeader !== undefined
            ? (options.registry?.getOwner?.(conversationHeader)
              ? { kind: 'runtime', owner: options.registry.getOwner(conversationHeader) } : null)
            : { kind: 'classic', bridgeRun: options.classic.owner().runtimeGeneration,
              cwd: options.classic.cwd(), workspaceGeneration: options.classic.generation(),
              sessionId: options.classic.owner().sessionId },
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
