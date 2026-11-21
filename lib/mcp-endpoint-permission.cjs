'use strict';
const { randomUUID, createHash } = require('node:crypto');
const net = require('node:net');
const local = require('./local-endpoint-policy.cjs');

// One-use confirmation for the MCP editor's exact pending config write. No
// market/import caller receives or persists these handles, and Pi never sees it.
function createMcpEndpointPermission({ networkPolicy, urlLooksSensitive, now = Date.now }) {
  if (typeof urlLooksSensitive !== 'function') throw new TypeError('MCP URL sensitivity check required');
  const pending = new Map();
  const denied = message => ({ ok: false, code: 'endpoint-policy', error: message, field: 'url' });
  return ({ config, scope, name, file, revision, authorization }) => {
    if (!config.url) return null;
    let url;
    try { url = new URL(config.url); } catch { return denied('无法确认 MCP 端点。'); }
    const host = url.hostname.replace(/^\[|\]$/gu, '');
    const needsPermission = url.protocol === 'http:' || host === 'localhost' || Boolean(local.localKind(host));
    if (!needsPermission) return null;
    const policy = networkPolicy();
    if (policy?.relaxed !== true) {
      pending.clear();
      return denied('此本地或明文端点需要先启用网络宽松模式，再在当前 MCP 配置中单独授权。');
    }
    const target = local.endpoint(config.url);
    const addresses = target?.host === 'localhost' ? ['127.0.0.1', '::1'] : [target?.host];
    if (!target || !local.permitsAddresses(target, addresses, { controlPorts: [7788, ...(policy.controlPorts || [])] })
      || !net.isIP(target.host) && target.host !== 'localhost') {
      return denied('只支持明确的回环或局域网 IP 端点；不允许元数据地址、保留地址、内部控制服务或无法固定的域名。');
    }
    const safeFields = new Set(['type', 'url', 'description', 'timeout', 'exposure', 'toolExposure', 'enabled', 'headers']);
    // The final config can include a native URL restored by keepUrl. Apply the
    // same sensitivity check as the editor detail before minting or redeeming
    // a challenge, so a hidden URL can never become a confirmation summary.
    if (urlLooksSensitive(url) || Object.keys(config.headers || {}).length
      || Object.keys(config).some(key => !safeFields.has(key))) {
      return denied('本地端点兼容仅支持不携带凭据的配置；请使用可信 HTTPS 服务和原有认证流程。');
    }
    const time = now();
    for (const [id, value] of pending) if (value.expires <= time) pending.delete(id);
    const fingerprint = createHash('sha256').update(JSON.stringify([file, scope, name, revision, config, policy.generation ?? 0])).digest('hex');
    if (typeof authorization === 'string') {
      const grant = pending.get(authorization);
      pending.delete(authorization);
      return grant?.expires > time && grant.fingerprint === fingerprint ? null : denied('端点授权已过期或配置已变化，请重新确认当前目标。');
    }
    if (pending.size >= 16) pending.delete(pending.keys().next().value);
    const id = randomUUID();
    pending.set(id, { expires: time + 60_000, fingerprint });
    return { ...denied('请明确确认当前 MCP 端点。'), needsEndpointAuthorization: true, endpointChallenge: id,
      targetSummary: { scope, name, url: target.url } };
  };
}
module.exports = { createMcpEndpointPermission };
