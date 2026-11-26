/* 移动端 remote/v1 的**本机管理面**（contract localAdminControl）。
 *
 * 这些操作只存在于已认证的 127.0.0.1 桌面 API（/api/remote/*，走现有
 * token+Origin 门禁，router 在分发前已对 /api/* 统一 denyRequest）——
 * 契约 remoteAccessible:false，远程设备永远到不了这里。
 *
 * 暴露契约 localAdminControl.operations：
 *   remote.status / remote.enable / remote.pairing.create /
 *   remote.pairing.cancel / remote.devices.list / remote.devices.revoke
 * 另加桌面确认所需的 remote.pairing.approve（注入一次性 approvalId，
 * 绑定完整 canonical 转录+scope 集合）与 remote.devices.grants（default-deny
 * 授权集调整，移除授权时即触发该设备事件流 authorization_changed 复位）。
 *
 * remote.enable 只在进程内切换运行时开关：remote 监听器只在启动时按
 * PI_GUI_REMOTE_PORT 装配；这里 enable/disable 控制的是「该监听器是否实际
 * 打开」——本实现里它**只能**把已启动的网关标为打开/关闭管理操作许可，
 * 不能凭空拉起一个未装配的监听器（那需要重启进程+环境变量，属显式开关）。
 */

import { json, readBody } from './http-utils.js';

export function createRemoteAdmin({ getRemote, log = () => {} }) {
  /** 当前已装配的 remote 实例（未启动时为 null）。 */
  const remote = () => (typeof getRemote === 'function' ? getRemote() : null);

  async function handle(req, res, url) {
    const r = remote();
    const path = url.pathname;

    // remote.status / remote.enable —— 管理面即使未装配也要能回答。
    if (path === '/api/remote/status' && req.method === 'GET') {
      const st = r ? r.admin.status() : { enabled: false };
      return json(res, 200, { ok: true, enabled: !!r, ...st });
    }
    if (path === '/api/remote/enable' && req.method === 'POST') {
      // 运行时不可凭空装配监听器；已装配则返回真实指纹。
      if (!r) return json(res, 409, { ok: false, code: 'remote_not_started', error: 'remote/v1 未启动；以 PI_GUI_REMOTE_PORT 显式开启后重启生效。' });
      return json(res, 200, { ok: true, enabled: true, serviceFingerprint: r.serviceFingerprint });
    }

    // 以下操作都需要一个活着的 remote。
    if (!r) return json(res, 503, { ok: false, code: 'remote_unavailable', error: 'remote/v1 未启用。' });

    if (path === '/api/remote/pairing' && req.method === 'POST') {
      const session = r.admin.issuePairing();
      if (!session) return json(res, 429, { ok: false, code: 'too_many_pending', error: '待配对会话已达上限。' });
      // pairingSessionId + code + expires + fingerprint：UI/QR 展示用；
      // code 只在此一次性明文返回，服务端只存 HMAC（契约 pairCodePlaintextPersistence:false）。
      return json(res, 200, { ok: true, pairing: session });
    }
    if (path === '/api/remote/pairing/cancel' && req.method === 'POST') {
      const body = await readBody(req).then(s => { try { return JSON.parse(s || '{}'); } catch { return null; } });
      const id = body?.pairingSessionId;
      if (typeof id !== 'string' || !id) return json(res, 400, { ok: false, code: 'invalid_request' });
      return json(res, 200, { ok: true, cancelled: r.admin.cancelPairing(id) });
    }
    if (path === '/api/remote/pairing/pending' && req.method === 'GET') {
      // The verified-but-unconfirmed exchange transcripts the desktop UI shows
      // (deviceName + key fingerprint + requested scopes). pairCode and the
      // raw proof transcript never leave the server.
      return json(res, 200, { ok: true, pending: r.admin.listPendingConfirmations() });
    }
    if (path === '/api/remote/pairing/approve' && req.method === 'POST') {
      // 桌面用户确认：按 pairingSessionId 绑定**服务端已核验**的转录——
      // 回环 UI 不能伪造 devicePublicKey/clientNonce/proofTranscript，只对
      // 网关已验证的转录说「批准」。批准生成一次性 approvalId，设备用同一
      // 签名请求重试即原子完成注册。
      const body = await readBody(req).then(s => { try { return JSON.parse(s || '{}'); } catch { return null; } });
      const id = body?.pairingSessionId;
      if (typeof id !== 'string' || !id) return json(res, 400, { ok: false, code: 'invalid_request' });
      const approvalId = r.admin.approvePendingConfirmation(id);
      return json(res, approvalId ? 200 : 404, { ok: !!approvalId, ...(approvalId ? { approvalId } : { code: 'unknown_pending' }) });
    }
    if (path === '/api/remote/pairing/decline' && req.method === 'POST') {
      const body = await readBody(req).then(s => { try { return JSON.parse(s || '{}'); } catch { return null; } });
      const id = body?.pairingSessionId;
      if (typeof id !== 'string' || !id) return json(res, 400, { ok: false, code: 'invalid_request' });
      return json(res, 200, { ok: true, declined: r.admin.declinePendingConfirmation(id) });
    }
    if (path === '/api/remote/devices' && req.method === 'GET') {
      return json(res, 200, { ok: true, devices: r.admin.listDevices() });
    }
    if (path === '/api/remote/devices/revoke' && req.method === 'POST') {
      const body = await readBody(req).then(s => { try { return JSON.parse(s || '{}'); } catch { return null; } });
      const id = body?.deviceId;
      if (typeof id !== 'string' || !id) return json(res, 400, { ok: false, code: 'invalid_request' });
      const result = r.admin.revokeDevice(id);               // 同时断开实时流
      if (!result) return json(res, 404, { ok: false, code: 'unknown_device' });
      // FSEC-005: a revocation that no durable channel confirmed is never
      // acknowledged as success. The device IS denied in memory and its
      // streams ARE dead — but the operator is told the durability failed
      // and must retry (the same endpoint is the retry path: revoke of an
      // already-revoked record re-attempts both durable channels).
      if (!result.durable) return json(res, 503, { ok: false, code: 'revocation_not_durable', inMemoryDenied: true });
      return json(res, 200, { ok: true, revoked: true, ...(result.alreadyRevoked ? { alreadyRevoked: true } : {}) });
    }
    if (path === '/api/remote/devices/grants' && req.method === 'POST') {
      const body = await readBody(req).then(s => { try { return JSON.parse(s || '{}'); } catch { return null; } });
      const id = body?.deviceId;
      const projectIds = body?.projectIds;
      if (typeof id !== 'string' || !id || !Array.isArray(projectIds)) return json(res, 400, { ok: false, code: 'invalid_request' });
      const done = r.admin.setGrants(id, projectIds);        // 移除授权 -> 该设备流 reset
      return json(res, done ? 200 : 404, { ok: done, ...(done ? {} : { code: 'unknown_device' }) });
    }
    return json(res, 404, { ok: false, code: 'not_found' });
  }

  return { handle };
}
