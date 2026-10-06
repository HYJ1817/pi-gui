import { json, readRawBody } from './http-utils.js';

const CODES = new Set(['stale_runtime', 'stale_workspace', 'unknown_workspace', 'workspace_in_use', 'workspace_archived', 'workspace_unavailable',
  'runtime_limit', 'conversation_limit', 'unknown_conversation', 'invalid_request', 'invalid_command', 'invalid_cursor', 'runtime_not_ready',
  'runtime_start_failed', 'registry_unavailable', 'metadata_write_failed', 'cleanup_pending', 'pi_entry_unproven', 'session_unavailable',
  'stop_in_progress', 'stale_approval', 'maintenance', 'auth_syncing', 'process_limit', 'process_control_disabled', 'cancelled',
  'stale_generation', 'stale_process', 'invalid_permission', 'invalid_args']);
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const fail = () => { throw Object.assign(Error('invalid_request'), { code: 'invalid_request' }); };
export function createRuntimeRoutes({ registry, validateWorkspace = async () => {} } = {}) {
  return { async handle(req, res) {
    try {
      if (req.method === 'GET') return json(res, 200, registry.snapshot());
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'invalid_request' });
      const body = JSON.parse((await readRawBody(req, 96 * 1024 * 1024)).toString('utf8'));
      if (!closed(body, ['action', 'owner', 'args', 'conversationId', 'allowThird', 'command', 'cursor'])) fail();
      let result;
      switch (body.action) {
        case 'start': result = await registry.start(body.args); break;
        case 'resume': result = await registry.resume(body.conversationId, { allowThird: body.allowThird === true }); break;
        case 'focus': result = await registry.focus(body.owner); break;
        case 'blur': result = await registry.blur(body.owner); break;
        case 'close': await registry.close(body.owner); result = { ok: true }; break;
        case 'restart': result = await registry.restart(body.owner); break;
        case 'command': result = await registry.command(body.owner, body.command); break;
        case 'read': result = { ok: true, data: await registry.read(body.owner, body.command) }; break;
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
