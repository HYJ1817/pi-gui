'use strict';
const path = require('node:path');
const fs = require('node:fs');
const policyFile = [path.join(__dirname, 'system-network-policy.cjs'), path.join(__dirname, '../lib/system-network-policy.cjs')].find(file => fs.existsSync(file));
const { DEFAULTS, normalize, validNetworkSettings, electronProxy } = require(policyFile);
const { createSystemPreferenceFile } = require('./system-settings-store.cjs');

// One authority for stored policy and the actually configured Chromium sessions.
// Existing Pi processes keep their original environment until their next start.
async function createSystemNetwork({ directory, getSessions = () => [], store: injectedStore,
  testConnection, now = Date.now } = {}) {
  const store = injectedStore || await createSystemPreferenceFile({ directory, fileName: 'system-network.json',
    defaults: DEFAULTS, validate: validNetworkSettings, maxBytes: 8192 });
  const startup = normalize(store.snapshot().settings) || { ...DEFAULTS };
  let active = { ...startup }, operation = null, testing = false, revision = 0, disposed = false, error = '';
  const configured = new Set(), registering = new Map();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function configure(ses, value) {
    if (!ses || typeof ses.setProxy !== 'function') throw Error('network_session_unavailable');
    await ses.setProxy(electronProxy(value));
  }
  function forget(ses) {
    configured.delete(ses);
    registering.delete(ses);
  }
  function snapshot() {
    const saved = store.snapshot();
    return { settings: { ...active }, saved: { ...saved.settings }, persistence: saved.status,
      revision, busy: Boolean(operation), testing, restartRequired: !same(active, startup),
      error: [error, saved.error].filter(Boolean).join(' '),
      protocols: ['http', 'https', 'socks5', 'socks5h'], authentication: 'unsupported',
      note: '部分网络设置将在重启后生效。正在运行的 Agent 不会被中断；系统直连不能绕过 VPN、TUN 或系统路由。' };
  }
  async function registerSession(ses) {
    if (disposed) throw Error('network_disposed');
    if (registering.has(ses)) return registering.get(ses);
    const previousSave = operation;
    const registration = Promise.resolve().then(async () => {
      if (previousSave) await previousSave;
      if (registering.get(ses) !== registration) throw Error('network_session_unavailable');
      await configure(ses, active);
      if (registering.get(ses) !== registration) throw Error('network_session_unavailable');
      configured.add(ses);
    });
    registering.set(ses, registration);
    try { await registration; }
    finally { if (registering.get(ses) === registration) registering.delete(ses); }
  }
  async function save(request) {
    const value = normalize(request);
    if (!value) return { ok: false, code: 'invalid_network', error: '请使用无用户名和密码的 HTTP、HTTPS、SOCKS5 或 SOCKS5H 代理地址；检查绕过列表格式。' };
    if (disposed || operation) return { ok: false, code: 'network_busy' };
    if (store.snapshot().status === 'unavailable') return { ok: false, code: 'network_unavailable', snapshot: snapshot() };
    // A registration that starts before this save must finish before we
    // enumerate sessions. Later registrations wait on this save instead.
    const earlierRegistrations = [...registering.values()];
    operation = (async () => {
      if (earlierRegistrations.length) await Promise.allSettled(earlierRegistrations);
      const previous = { ...active }, touched = [];
      let committed = false;
      try {
        if (disposed) throw Error('network_disposed');
        for (const ses of new Set([...configured, ...getSessions()])) {
          touched.push(ses); await configure(ses, value);
        }
        if (disposed) throw Error('network_disposed');
        const result = await store.save(value);
        if (!result.ok) throw Error('network_save_failed');
        committed = true; active = { ...value }; revision++; error = '';
        return { ok: true, snapshot: snapshot() };
      } catch {
        let restored = !committed;
        if (!committed) for (const ses of touched) {
          try { await configure(ses, previous); } catch { restored = false; }
        }
        error = restored ? '网络设置未保存，已恢复原策略。请检查代理地址、磁盘权限后重试。'
          : '网络策略恢复未能确认。请停止发起新的网络操作，并重新启动应用。';
        return { ok: false, code: restored ? 'network_not_saved' : 'network_recovery_required', snapshot: snapshot() };
      }
    })();
    try { return await operation; } finally { operation = null; }
  }
  async function test(request) {
    const value = normalize(request);
    if (!value) return { ok: false, code: 'invalid_network', error: '连接测试未执行：代理或绕过列表格式无效，不支持代理认证。' };
    if (testing || disposed || operation) return { ok: false, code: 'network_busy' };
    if (typeof testConnection !== 'function') return { ok: false, code: 'test_unavailable', error: '当前环境不支持连接测试。' };
    testing = true;
    const generation = revision, started = now();
    try {
      // The adapter owns an isolated routing session, fixed target, deadline and a
      // closed error projection. Drafts never become the saved/effective policy.
      const result = await testConnection(value);
      if (disposed || generation !== revision) return { ok: false, code: 'test_stale', stale: true };
      const code = ['connected', 'proxy_unreachable', 'proxy_auth_required', 'dns_failed', 'tls_failed', 'timeout', 'network_failed', 'target_blocked']
        .includes(result?.code) ? result.code : 'network_failed';
      return { ok: result?.ok === true && code === 'connected', code, durationMs: Math.max(0, now() - started), revision: generation };
    } catch { return { ok: false, code: 'network_failed', durationMs: Math.max(0, now() - started) }; }
    finally { testing = false; }
  }
  for (const ses of new Set(getSessions())) {
    // No backend/browser may start on an unconfirmed fallback policy.
    try { await configure(ses, active); configured.add(ses); }
    catch { throw Error('network_initialization_failed'); }
  }
  return { snapshot, save, test, registerSession, unregisterSession: forget, startup: () => ({ ...startup }),
    pending: () => operation, dispose() { disposed = true; configured.clear(); registering.clear(); } };
}
module.exports = { createSystemNetwork };
