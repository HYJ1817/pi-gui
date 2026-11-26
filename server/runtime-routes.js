import { json, readRawBody } from './http-utils.js';

const CODES = new Set(['stale_runtime', 'stale_workspace', 'unknown_workspace', 'workspace_in_use', 'workspace_archived', 'workspace_unavailable',
  'unknown_conversation', 'invalid_request', 'invalid_command', 'invalid_cursor', 'runtime_not_ready',
  'runtime_start_failed', 'registry_unavailable', 'metadata_write_failed', 'cleanup_pending', 'pi_entry_unproven', 'session_unavailable',
  'stop_in_progress', 'runtime_busy', 'stale_approval', 'maintenance', 'auth_syncing', 'process_limit', 'process_control_disabled', 'cancelled',
  'stale_generation', 'stale_process', 'invalid_permission', 'invalid_args', 'unknown_project', 'session_in_use', 'tool_guard_unavailable',
  'edit_unavailable', 'edit_in_progress', 'stale_history', 'unknown_user_message', 'history_unparsable', 'navigate_unavailable',
  'navigate_failed', 'navigate_unverified', 'restore_unconfirmed', 'restore_unavailable', 'command_text_conflict',
  'attachments_unsupported', 'empty_message', 'message_too_large', 'prompt_rejected', 'prompt_handled', 'pi_request_failed',
  'pi_timeout', 'stale_session', 'session_streaming', 'session_compacting', 'session_queued', 'model_unavailable',
  'missing_target_identity', 'prompt_unconfirmed', 'acceptance_unknown', 'recovery_pending', 'recovery_required',
  'invalid_user_index', 'unavailable']);
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const fail = () => { throw Object.assign(Error('invalid_request'), { code: 'invalid_request' }); };
export function createRuntimeRoutes({ registry, validateWorkspace = async () => {}, readHistory = null, openSession = null, beforeAction = () => {} } = {}) {
  return { async handle(req, res) {
    try {
      if (req.method === 'GET') {
        /* P32.4：只读历史。**不 spawn** —— 读的是 registry 记录里后端持有、
         * 绑定时已证明过的 sessionLocator；前端只传 conversationId，不传路径。 */
        const conversationId = new URL(req.url, 'http://127.0.0.1').searchParams.get('conversationId');
        if (!conversationId) return json(res, 200, registry.snapshot());
        const target = registry.historyTarget(conversationId);
        if (!target) return json(res, 404, { ok: false, code: 'unknown_conversation' });
        if (!target.sessionLocator || !readHistory) return json(res, 409, { ok: false, code: 'history_unavailable' });
        const history = await readHistory(target.sessionLocator, target);
        if (!history?.ok) return json(res, 409, { ok: false, code: history?.code || 'history_unavailable' });
        const current = registry.historyTarget(conversationId);
        if (!current || current.sessionLocator !== target.sessionLocator || JSON.stringify(current.locator) !== JSON.stringify(target.locator)
          || JSON.stringify(current.sessionIdentity) !== JSON.stringify(target.sessionIdentity)) return json(res, 409, { ok: false, code: 'history_unavailable' });
        return json(res, 200, { ok: true, sessionId: target.sessionId, locator: target.locator, messages: history.messages,
          truncated: history.truncated === true, ...(history.toolSummary ? { toolSummary: history.toolSummary } : {}),
          ...(history.execution ? { execution: history.execution } : {}) });
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'invalid_request' });
      const body = JSON.parse((await readRawBody(req, 96 * 1024 * 1024)).toString('utf8'));
      if (!closed(body, ['action', 'owner', 'args', 'conversationId', 'allowThird', 'command', 'cursor', 'edit', 'requestId'])) fail();
      // Older renderers sent this quota confirmation flag. Accept at the
      // transport boundary, then deliberately discard it before backend calls.
      beforeAction(body);
      let result;
      switch (body.action) {
        case 'open-session': if (!openSession) fail(); result = await openSession(body.args); break;
        case 'start': {
          // New UI never sends this; old renderers nested it under args. Ignore
          // the legacy admission flag at the transport boundary, never consult it.
          const { allowThird: _legacy, ...args } = body.args || {};
          result = await registry.start(args); break;
        }
        case 'resume': result = await registry.resume(body.conversationId); break;
        case 'focus': result = await registry.focus(body.owner); break;
        case 'blur': result = await registry.blur(body.owner); break;
        case 'close': await registry.close(body.owner); result = { ok: true }; break;
        case 'restart': result = await registry.restart(body.owner); break;
        case 'command': result = await registry.command(body.owner, body.command); break;
        case 'read': result = { ok: true, data: await registry.read(body.owner, body.command) }; break;
        case 'execution-history':
          if (!closed(body, ['action', 'owner']) || !registry.executionHistory) fail();
          result = await registry.executionHistory(body.owner);
          break;
        case 'edit-preflight': result = await registry.editPreflight(body.owner, body.edit); break;
        case 'edit-resend': result = await registry.editResend(body.owner, body.edit); break;
        case 'edit-status': result = await registry.editStatus(body.owner, body.requestId); break;
        case 'edit-recover': result = await registry.editRecover(body.owner, body.requestId); break;
        case 'events': result = registry.events(body.owner, body.cursor ?? 0); break;
        case 'process': {
          const adapter = registry.getAdapter(body.owner), args = body.args;
          if (!closed(args, ['action', 'generation', 'id', 'revision', 'cursor', 'enabled']) || !['permission', 'status', 'logs', 'stop', 'restart'].includes(args.action)) fail();
          if (args.action !== 'stop') await validateWorkspace(body.owner);
          if (registry.getAdapter(body.owner) !== adapter) fail();
          const manager = adapter.managed.manager;
          if (args.action === 'permission') result = await manager.enable(args.enabled, args.generation);
          else if (args.action === 'status') result = { ...manager.snapshot(), available: adapter.managed.available() };
          else result = await manager.action(args.action, { id: args.id, revision: args.revision, ...(args.action === 'logs' ? { cursor: args.cursor ?? 0 } : {}) }, args.generation);
          registry.getAdapter(body.owner); break;
        }
        default: fail();
      }
      return json(res, result?.ok === false ? 409 : 200, result);
    } catch (e) { const code = CODES.has(e.code) ? e.code : 'runtime_unavailable'; return json(res, 409, { ok: false, code, error: '会话操作未完成，请刷新状态后重试。' }); }
  } };
}
