import { createSettingsCard, createSettingsRow, createSettingsToggle, createSegmentedControl } from './ui/primitives.js';

const DEFAULT = { mode: 'system', proxy: '', bypass: '', relaxed: false };
const TEST_MESSAGES = {
  connected: '连接成功。', proxy_unreachable: '无法连接代理，请检查地址及代理服务。',
  proxy_auth_required: '代理要求认证；当前版本不支持带用户名或密码的代理。',
  dns_failed: '域名解析失败。', tls_failed: 'TLS 证书校验失败；未降低证书安全要求。',
  timeout: '连接测试超时。', target_blocked: '目标解析为非公网地址，安全策略已阻止。',
  network_failed: '连接失败，请检查网络后重试。', invalid_network: '请检查代理地址和绕过列表；不支持代理认证。',
};
function element(tag, className, text) {
  const node = document.createElement(tag); node.className = className || ''; node.textContent = text || ''; return node;
}
export function createSystemNetworkCard({ desktop, call, current }) {
  let snapshot = null, draft = { ...DEFAULT }, saving = false, testing = false, generation = 0, dirty = false;
  const feedback = element('p', 'system-status'); feedback.id = 'system-network-feedback'; feedback.setAttribute('role', 'status');
  const effective = element('p', 'system-status'); effective.id = 'system-network-effective'; effective.setAttribute('role', 'status');
  const proxy = createSegmentedControl({ ariaLabel: '代理', value: 'system', options: [
    { value: 'system', label: '系统' }, { value: 'direct', label: '直连' }, { value: 'custom', label: '自定义' },
  ], onChange: value => change({ mode: value }) });
  const address = element('input', 'ds-input system-network-field'); address.type = 'url'; address.autocomplete = 'off';
  address.placeholder = 'http://127.0.0.1:7890'; address.setAttribute('aria-label', '自定义代理地址'); address.spellcheck = false;
  address.maxLength = 2048;
  const bypass = element('textarea', 'ds-input system-network-field'); bypass.rows = 2; bypass.maxLength = 2048;
  bypass.placeholder = 'example.com, *.example.org'; bypass.setAttribute('aria-label', '代理绕过列表'); bypass.spellcheck = false;
  const relaxed = createSettingsToggle({ ariaLabel: '网络宽松模式', onChange: value => change({ relaxed: value }) });
  const save = element('button', 'btn primary', '保存网络设置'); save.type = 'button'; save.onclick = saveDraft;
  const test = element('button', 'btn', '测试连接'); test.type = 'button'; test.onclick = testDraft;
  const actions = element('div', 'system-actions'); actions.append(test, save);
  const custom = element('div', 'system-network-custom');
  custom.append(createSettingsRow({ label: '代理地址', control: address,
    detail: '支持 HTTP、HTTPS、SOCKS5 / SOCKS5H。SOCKS5 由代理解析目标域名；不支持用户名或密码。' }),
  createSettingsRow({ label: '绕过列表', control: bypass,
    detail: '用逗号、分号或换行分隔域名、IP 或域名后缀。回环地址和应用内部服务始终保护，不支持 CIDR。' }));
  for (const control of [address, bypass, save, test, relaxed.element]) control.setAttribute('aria-describedby', feedback.id);
  function say(text, error = false) { feedback.textContent = text; feedback.classList.toggle('is-error', error); }
  function change(values) {
    draft = { ...draft, ...values }; generation++; dirty = true;
    say('有未保存的网络设置；连接测试不会保存。'); paint();
  }
  address.oninput = () => {
    // Do not retain a pasted credential-bearing URL in draft state or echo it.
    try {
      const parsed = new URL(address.value);
      if (parsed.username || parsed.password) { address.value = ''; draft.proxy = ''; generation++; dirty = true; say('不支持代理认证。已清空带用户名或密码的地址。', true); paint(); return; }
    } catch { /* Incomplete text is validated by main on save/test. */ }
    change({ proxy: address.value });
  };
  bypass.oninput = () => change({ bypass: bypass.value });
  function paint() {
    const available = Boolean(desktop && snapshot && snapshot.persistence !== 'unavailable');
    proxy.setValue(draft.mode); proxy.setDisabled(!available || saving);
    relaxed.setChecked(draft.relaxed); relaxed.setDisabled(!available || saving);
    custom.hidden = draft.mode !== 'custom';
    address.value = draft.proxy; bypass.value = draft.bypass;
    address.disabled = bypass.disabled = !available || saving || draft.mode !== 'custom';
    const retryPermission = snapshot?.endpointPermissions === 'unconfirmed';
    save.disabled = !available || saving || testing || (!dirty && !retryPermission);
    test.disabled = !available || saving || testing;
    save.textContent = saving ? '正在保存…' : '保存网络设置'; test.textContent = testing ? '正在测试…' : '测试连接';
    const mode = { system: '系统代理', direct: '应用直连', custom: '自定义代理' }[snapshot?.settings?.mode];
    const label = value => ({ system: '系统代理', direct: '应用直连', custom: '自定义代理' }[value] || '未确认');
    effective.textContent = mode ? `已保存：${mode}；Chromium：${label(snapshot.effective?.electron?.mode || snapshot.settings.mode)}；`
      + `Node 启动时：${label(snapshot.effective?.backendStartup?.mode)}。${snapshot.effective?.pi?.note || 'Pi 实际线路尚未确认。'}`
      + (snapshot.restartRequired ? ' 后端/新 Pi 的代理变更在正常重启后生效；不会中断当前 Agent。' : '') : '';
  }
  async function saveDraft() {
    if (save.disabled) return;
    const focus = document.activeElement; saving = true; paint(); say('正在保存网络设置…');
    const result = await call('saveNetwork', { ...draft });
    if (!current()) return;
    const next = result.snapshot || (await call('state')).snapshot;
    if (!current()) return;
    snapshot = next?.network || snapshot; saving = false;
    if (result.ok && snapshot) { draft = { ...snapshot.settings }; dirty = false; generation++; }
    paint(); say(result.ok ? `网络设置已保存。${snapshot?.note || '部分网络设置将在重启后生效。'}`
      : result.error || snapshot?.error || '未能确认网络设置已保存，请重试或重新打开此页。', !result.ok);
    if (focus?.isConnected && !focus.disabled && document.activeElement === document.body) focus.focus();
  }
  async function testDraft() {
    if (test.disabled) return;
    const version = generation; testing = true; paint(); say('正在使用当前草稿测试固定公共端点；不会调用模型或消耗模型额度…');
    const result = await call('testNetwork', { ...draft });
    if (!current()) return;
    testing = false; paint();
    if (version !== generation || result.stale) { say('网络草稿已变化，旧测试结果已丢弃；请重新测试。'); return; }
    say((TEST_MESSAGES[result.code] || '连接测试不可用，请重试。')
      + (result.ok && Number.isFinite(result.durationMs) ? ` 用时 ${Math.round(result.durationMs)} ms。` : ''), !result.ok);
  }
  const card = createSettingsCard({ title: '网络', children: [
    createSettingsRow({ label: '代理', control: proxy,
      detail: '仅调整应用网络策略，不修改系统代理、VPN、TUN 或路由；已运行的 Agent 保持原网络环境。' }),
    custom,
    createSettingsRow({ label: '网络宽松模式', control: relaxed,
      detail: '兼容可证明代理线路的 Fake-IP，并允许在供应商或 MCP 配置中单独授权无凭据的本地端点。不会自动授权内网、明文密钥或重定向，也不会关闭 TLS；Pi 原生请求仍由其客户端管理。' }),
    effective, actions, feedback,
  ] });
  paint();
  return { card, adopt(result) {
    snapshot = result?.capabilities?.network === true ? result.network : null;
    draft = { ...DEFAULT, ...snapshot?.settings }; dirty = false; paint();
    say(snapshot?.error || (!desktop ? '仅桌面版可配置网络。' : !snapshot ? '当前环境不支持网络配置。' : snapshot.note || ''), Boolean(snapshot?.error));
  } };
}
