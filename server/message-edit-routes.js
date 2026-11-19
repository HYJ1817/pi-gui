/* `/api/message-edit` 的 HTTP 适配（Classic 会话）。
 *
 * 只做四件事：鉴权后的 owner 核对、请求体白名单、把一次事务绑定到当前
 * bridgeRun / workspaceGeneration / native sessionId、把结果原样交给事务服务。
 * 业务状态机在 `server/message-edit.js`；这里不解析历史、不发 RPC 命令。
 *
 * owner 必须逐字段等于请求到达时的当前 owner：切换会话、切项目、bridge 换代
 * 之后，旧页面发来的编辑请求会得到 `stale_runtime`，不会把 A 的编辑写进 B。
 */
import { json, readRawBody } from './http-utils.js';

const MAX_BODY = 2 * 1024 * 1024;
const BODY_KEYS = ['action', 'userIndex', 'kind', 'text', 'expectedEntryId', 'expectedLeafId', 'requestId'];
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

function parseOwner(req) {
  try { return JSON.parse(req.headers['x-pi-gui-owner'] || 'null'); } catch { return null; }
}

export function createMessageEditRoutes({
  service,
  getOwner,
  request,
  commandName,
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

  async function handle(req, res, url) {
    try {
      if (!service) return json(res, 503, { ok: false, code: 'edit_unavailable' });
      if (url.pathname === '/api/message-edit/status' && req.method === 'GET') {
        if (!(await ownerOk(req))) return json(res, 409, { ok: false, code: 'stale_runtime' });
        return json(res, 200, service.status(url.searchParams.get('requestId')));
      }
      if (url.pathname !== '/api/message-edit' || req.method !== 'POST') {
        return json(res, 405, { ok: false, code: 'method_not_allowed' });
      }
      if (!(await ownerOk(req))) return json(res, 409, { ok: false, code: 'stale_runtime' });
      const body = JSON.parse((await readRawBody(req, MAX_BODY)).toString('utf8'));
      if (!closed(body, BODY_KEYS) || typeof body.action !== 'string') return json(res, 400, { ok: false, code: 'invalid_request' });
      if (body.action === 'status') return json(res, 200, service.status(body.requestId));
      if (!['preflight', 'resend'].includes(body.action)) return json(res, 400, { ok: false, code: 'invalid_request' });

      /* `get_state` 是当前 native session 的权威来源；事务内部还会再读一次，
       * 两边不一致就按 stale_session 拒绝。 */
      const stateRead = await request({ type: 'get_state' });
      if (!stateRead?.ok || typeof stateRead.data?.sessionId !== 'string' || !stateRead.data.sessionId) {
        return json(res, 409, { ok: false, code: stateRead?.code || 'stale_session' });
      }
      const sessionId = stateRead.data.sessionId;
      const bridgeRun = getBridgeRun();
      const workspaceGeneration = getWorkspaceGeneration();
      const cwd = getCwd();
      const owner = getOwner();

      const io = {
        scope: 'classic',
        sessionId,
        commandName,
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
          /* 只把**真正开跑**的 prompt 记成活动；导航命令的 handled 应答不算。 */
          if (!nav && result?.ok === true && wire?.type === 'prompt' && result.data?.disposition === 'started') {
            try { afterPrompt?.(wire); } catch { /* observation only */ }
          }
          return result;
        },
        validate() {
          if (getBridgeRun() !== bridgeRun || getWorkspaceGeneration() !== workspaceGeneration || getCwd() !== cwd
            || !sameOwner(owner, getOwner())) throw fail('stale_runtime');
        },
        busyReason,
      };
      const result = body.action === 'preflight'
        ? await service.preflight(io, body)
        : await service.resend(io, body);
      return json(res, result?.ok ? 200 : 409, result);
    } catch (error) {
      const tooLarge = /超过上限/.test(String(error?.message || ''));
      return json(res, tooLarge ? 413 : 409, { ok: false, code: tooLarge ? 'message_too_large' : 'invalid_request' });
    }
  }

  return { handle };
}
