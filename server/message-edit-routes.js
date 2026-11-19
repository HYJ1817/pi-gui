/* `/api/message-edit` 的 HTTP 适配（Classic 会话）。
 *
 * 只做四件事：鉴权后的 owner 核对、请求体白名单、把一次事务绑定到当前
 * bridgeRun / workspaceGeneration / native sessionId、把结果原样交给事务服务。
 * 业务状态机在 `server/message-edit.js`；这里不解析历史、不发 RPC 命令。
 *
 * owner 必须逐字段等于请求到达时的当前 owner：切换会话、切项目、bridge 换代
 * 之后，旧页面发来的编辑请求会得到 `stale_runtime`，不会把 A 的编辑写进 B。
 *
 * status / recover 使用**不绑定 bridgeRun** 的 io：bridge 异常重启后，用户仍要
 * 能用原 requestId 查到事务状态并核对 native session；是否 stale 由服务按
 * 回读到的 sessionId 判断。正式 resend 仍严格绑定 bridgeRun。
 */
import { json, readRawBody } from './http-utils.js';

const MAX_BODY = 2 * 1024 * 1024;
const BODY_KEYS = ['action', 'userIndex', 'kind', 'text', 'expectedEntryId', 'expectedLeafId', 'expectedParentId', 'expectedSessionId', 'requestId'];
/* status / recover 要能跨 bridge 代次查询：bridge 重启后 runtimeId /
 * runtimeGeneration / sessionId 都会变化，但项目、工作区与 conversation
 * 仍是同一事务的稳定归属。native session 是否仍一致由服务读取 get_state
 * 后判定（不一致会 markRecoveryRequired(stale_session)），不能在这里用
 * 旧 owner 的瞬时字段把查询直接拒掉。 */
const RECOVERY_OWNER_KEYS = ['backendInstance', 'projectId', 'repoId', 'workspaceId', 'workspaceEpoch', 'conversationId'];
const fail = code => Object.assign(Error(code), { code });

function closed(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}

function sameOwner(expected, actual) {
  if (!expected || !actual || typeof expected !== 'object' || Array.isArray(expected)) return false;
  if (typeof actual !== 'object' || Array.isArray(actual)) return false;
  const keys = Object.keys(actual);
  return keys.length === Object.keys(expected).length && keys.every(key => expected[key] === actual[key]);
}

function sameRecoveryOwner(expected, actual) {
  if (!expected || !actual || typeof expected !== 'object' || Array.isArray(expected)) return false;
  if (typeof actual !== 'object' || Array.isArray(actual)) return false;
  return RECOVERY_OWNER_KEYS.every(key => expected[key] === actual[key]);
}

function parseOwner(req) {
  try { return JSON.parse(req.headers['x-pi-gui-owner'] || 'null'); } catch { return null; }
}

export function createMessageEditRoutes({
  service,
  getOwner,
  request,
  commandName,
  editToken = () => null,
  getSessionId = () => null,
  busyReason = () => null,
  getBridgeRun,
  getWorkspaceGeneration,
  getCwd,
  beforePrompt = null,
  afterPrompt = null,
} = {}) {
  async function ownerOk(req) {
    return sameOwner(parseOwner(req), getOwner());
  }

  async function recoveryOwnerOk(req) {
    return sameRecoveryOwner(parseOwner(req), getOwner());
  }

  function makeIo({ sessionId = null, bindBridge = false } = {}) {
    const bridgeRun = getBridgeRun();
    const workspaceGeneration = getWorkspaceGeneration();
    const cwd = getCwd();
    const owner = getOwner();
    return {
      scope: 'classic',
      sessionId,
      commandName,
      editToken,
      getBridgeRun,
      async request(cmd) {
        /* 导航命令只移动 leaf，不开 run；真正的重发 prompt 必须走与普通
         * prompt 相同的工具闸门、变更采集闸门与互斥写入闸门。
         * 导航标记由事务服务显式携带，不靠命令名猜 —— bridge 换代时命令名
         * 会被清空，按名字判断会把导航误当成用户消息发出去。 */
        const { __messageEditNav, ...wire } = cmd || {};
        const nav = __messageEditNav === true;
        if (!nav && wire?.type === 'prompt' && typeof beforePrompt === 'function') {
          try { await beforePrompt(wire); } catch (error) { return { ok: false, code: error?.code || 'edit_unavailable' }; }
        }
        const result = await request(wire);
        if (!result) return { ok: false, code: 'pi_timeout', unknown: true };
        if (result.ok !== true) return { ok: false, code: result.code || 'pi_request_failed', unknown: result.unknown === true };
        /* 只把**真正开跑**的 prompt 记成活动；导航命令的 handled 应答不算。 */
        if (!nav && wire?.type === 'prompt' && result.data?.disposition === 'started') {
          try { afterPrompt?.(wire); } catch { /* observation only */ }
        }
        return result;
      },
      validate() {
        if (getWorkspaceGeneration() !== workspaceGeneration || getCwd() !== cwd
          || !sameOwner(owner, getOwner())) throw fail('stale_runtime');
        if (bindBridge && getBridgeRun() !== bridgeRun) throw fail('stale_runtime');
      },
      busyReason,
    };
  }

  async function handle(req, res, url) {
    try {
      if (!service) return json(res, 503, { ok: false, code: 'edit_unavailable' });
      if (url.pathname === '/api/message-edit/status' && req.method === 'GET') {
        if (!(await recoveryOwnerOk(req))) return json(res, 409, { ok: false, code: 'stale_runtime' });
        const requestId = url.searchParams.get('requestId');
        return json(res, 200, await service.status(makeIo({ sessionId: getSessionId() }), requestId));
      }
      if (url.pathname !== '/api/message-edit' || req.method !== 'POST') {
        return json(res, 405, { ok: false, code: 'method_not_allowed' });
      }
      const body = JSON.parse((await readRawBody(req, MAX_BODY)).toString('utf8'));
      if (!closed(body, BODY_KEYS) || typeof body.action !== 'string') return json(res, 400, { ok: false, code: 'invalid_request' });
      /* status / recover 允许 bridge 换代后的旧 owner 查询；preflight / resend
       * 仍要求 owner 逐字段一致，不能把旧页面的编辑写进新会话。 */
      const recoveryAction = body.action === 'status' || body.action === 'recover';
      if (!(await (recoveryAction ? recoveryOwnerOk(req) : ownerOk(req)))) return json(res, 409, { ok: false, code: 'stale_runtime' });
      if (body.action === 'status') return json(res, 200, await service.status(makeIo({ sessionId: getSessionId() }), body.requestId));
      if (body.action === 'recover') return json(res, 200, await service.recover(makeIo({ sessionId: getSessionId() }), body.requestId));
      if (!['preflight', 'resend'].includes(body.action)) return json(res, 400, { ok: false, code: 'invalid_request' });

      /* `get_state` 是当前 native session 的权威来源；事务内部还会再读一次，
       * 两边不一致就按 stale_session 拒绝。 */
      const stateRead = await request({ type: 'get_state' });
      if (!stateRead?.ok || typeof stateRead.data?.sessionId !== 'string' || !stateRead.data.sessionId) {
        return json(res, 409, { ok: false, code: stateRead?.code || 'stale_session' });
      }
      const io = makeIo({ sessionId: stateRead.data.sessionId, bindBridge: true });
      const result = body.action === 'preflight'
        ? await service.preflight(io, body)
        : await service.resend(io, body);
      return json(res, result?.ok ? 200 : 409, result);
    } catch (error) {
      const tooLarge = /超过上限/.test(String(error?.message || ''));
      /* 服务层抛出的稳定错误码（stale_runtime / stale_session 等）要原样带回，
       * 不能一律压成 invalid_request —— 前端据此决定“刷新会话”还是“修正请求”。 */
      const code = tooLarge ? 'message_too_large' : (typeof error?.code === 'string' ? error.code : 'invalid_request');
      return json(res, tooLarge ? 413 : 409, { ok: false, code });
    }
  }

  return { handle };
}
