/* 供应商目录的展示层。
 *
 * 数据来源只有两份：
 *   - snapshot.catalog（P0 后端已把订阅条目并进来）
 *   - snapshot.auth（订阅是否真的能登录）
 *
 * 这里不发现新供应商，也不猜测认证能力。目录里没有的条目不会被编出来。 */

const ALIASES = Object.freeze({
  custom: 'custom 自定义 端点 endpoint 兼容',
  openai: 'openai gpt chatgpt 平台',
  anthropic: 'anthropic claude 克劳德',
  google: 'google gemini 谷歌',
  deepseek: 'deepseek 深度求索',
  openrouter: 'openrouter 聚合',
  ollama: 'ollama 本地 local 离线',
  'moonshotai-cn': 'moonshot kimi 月之暗面',
  siliconflow: 'siliconflow 硅基流动',
  zhipu: 'zhipu glm 智谱',
  dashscope: 'dashscope 百炼 qwen 千问 阿里',
  'openai-subscription': 'openai chatgpt 订阅 subscription',
  'anthropic-subscription': 'anthropic claude 订阅 subscription',
});

const MONOGRAMS = Object.freeze({
  custom: '自',
  openai: 'O',
  anthropic: 'A',
  google: 'G',
  deepseek: 'D',
  openrouter: 'R',
  ollama: 'L',
  'moonshotai-cn': 'K',
  siliconflow: '硅',
  zhipu: '智',
  dashscope: '阿',
  'openai-subscription': 'O',
  'anthropic-subscription': 'A',
});

export function monogram(item) {
  if (!item) return '?';
  return MONOGRAMS[item.id] || (String(item.name || item.id || '?').trim().charAt(0) || '?').toUpperCase();
}

export function isSubscription(item) {
  return Boolean(item && item.category === 'subscription');
}

export function endpointLabel(connection) {
  if (!connection || typeof connection.baseUrl !== 'string' || !connection.baseUrl) return '';
  try {
    const url = new URL(connection.baseUrl);
    const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '';
    return url.host + path;
  } catch {
    return connection.baseUrl;
  }
}

export function catalogEndpointText(item) {
  if (isSubscription(item)) return '订阅账户 · 使用 Pi 官方登录';
  if (item.id === 'custom' || !item.connection) return '任何兼容协议的端点';
  return endpointLabel(item.connection);
}

export function catalogDescription(item) {
  if (isSubscription(item)) return '使用已有订阅登录，由 Pi 管理账户';
  if (item.id === 'custom') return '手动填写服务地址与协议';
  if (item.suggestedEnvReference) return `API Key 环境变量 ${item.suggestedEnvReference}`;
  return '本机服务，无需 API Key';
}

function haystack(item, authProviders) {
  const auth = authProviders.find(provider => provider.providerId === (item.providerId || item.id));
  return [
    item.id,
    item.providerId,
    item.name,
    item.category,
    ALIASES[item.id] || '',
    item.connection?.baseUrl || '',
    item.connection?.api || '',
    auth?.displayName || '',
    auth?.status || '',
  ].filter(Boolean).join(' ').toLowerCase();
}

export function normalizeCatalog(snapshot) {
  const catalog = Array.isArray(snapshot?.catalog) ? snapshot.catalog : [];
  const authProviders = Array.isArray(snapshot?.auth?.providers) ? snapshot.auth.providers : [];
  const seen = new Set();
  const items = [];
  for (const raw of catalog) {
    if (!raw || typeof raw.id !== 'string' || seen.has(raw.id)) continue;
    seen.add(raw.id);
    items.push({
      ...raw,
      ...(isSubscription(raw) ? { auth: authProviders.find(provider => provider.providerId === raw.providerId) || null } : {}),
    });
  }
  return items;
}

export function authenticateCatalog(items, snapshot) {
  const authProviders = Array.isArray(snapshot?.auth?.providers) ? snapshot.auth.providers : [];
  return items.map(item => (isSubscription(item)
    ? { ...item, auth: authProviders.find(provider => provider.providerId === item.providerId) || null }
    : item));
}

export function filterCatalog(items, query, authProviders = []) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items;
  return items.filter(item => haystack(item, authProviders).includes(q));
}

export function groupCatalog(items) {
  const subscription = [];
  const apiKey = [];
  for (const item of items) (isSubscription(item) ? subscription : apiKey).push(item);
  return { subscription, apiKey };
}

/** 订阅条目是不是真的能点。
 * 任何一项不确定都按不可用处理 —— 宁可显示「待接通」，也不伪造一个登录入口。 */
export function subscriptionAvailability(snapshot, item) {
  if (!isSubscription(item)) return { available: false, reason: '不是订阅服务' };
  if (item.enabled === false || item.disabledReason) {
    return { available: false, reason: subscriptionReason(item.disabledReason) };
  }
  const oauth = snapshot?.capabilities?.oauthLogin;
  if (oauth === false) return { available: false, reason: '当前 Pi 版本未开放订阅登录' };
  if (oauth !== true) return { available: false, reason: '正在确认 Pi 认证能力' };
  if (snapshot?.auth?.capability?.sdkAvailable === false) {
    return { available: false, reason: snapshot.auth.capability.reason || 'Pi 认证 SDK 不可用' };
  }
  const auth = item.auth || (Array.isArray(snapshot?.auth?.providers)
    ? snapshot.auth.providers.find(provider => provider.providerId === item.providerId) : null);
  if (!auth) return { available: false, reason: '未找到对应的 Pi 认证供应商' };
  if (auth.canLogin === true || auth.status === 'connected') return { available: true, reason: '' };
  if (auth.canLogin === false) return { available: false, reason: '该订阅登录不可用' };
  return { available: false, reason: '订阅登录状态未知' };
}

export function subscriptionReason(code) {
  switch (code) {
    case 'oauth_unavailable': return '该订阅登录在当前 Pi 版本不可用';
    case 'oauthLogin': return '订阅登录尚未接通';
    case 'p2_pending': return '桌面凭据输入待接通';
    case 'discovery_transport_pending': return '自动发现尚未接通';
    default: return code ? `暂不可用（${code}）` : '暂不可用';
  }
}

export function authStatusLabel(auth) {
  if (!auth) return '认证状态未知';
  if (auth.status === 'connected') return '已连接';
  if (auth.status === 'unknown') return '认证状态未知';
  return '未连接';
}

export function catalogItemByService(snapshot, service) {
  const items = normalizeCatalog(snapshot);
  return items.find(item => item.id === (service?.catalogId || service?.providerId)) || null;
}

export function catalogItemDisplayName(item, fallback = '') {
  return (item && item.name) || fallback;
}

export function serviceDisplayName(service, snapshot) {
  const item = catalogItemByService(snapshot, service);
  return service?.displayName || item?.name || service?.providerId || '';
}

export function suggestProviderId(name, existingIds = [], fallback = 'provider') {
  const taken = new Set(existingIds);
  let base = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 56);
  if (!base || /^(__proto__|prototype|constructor|\.|\.\.)$/.test(base)) base = fallback;
  if (!/^[a-z0-9]/.test(base)) base = `p-${base}`.slice(0, 56);
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 64);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 64);
}

export function credentialSourceLabel(state) {
  if (!state || state.source === 'none' || state.state === 'none') return '未配置凭据';
  if (state.source === 'env') return '环境变量引用';
  if (state.source === 'pi-credential') return 'Pi 本机凭据';
  // literal/command 仍在 models.json 的 apiKey 字段里，不是 Pi 原生槽；
  // 混称“本机凭据”会让用户以为清除操作会调用 Pi logout。
  if (state.source === 'literal' || state.source === 'command') return '配置内凭据';
  if (state.state === 'unknown') return '凭据状态未知';
  return '凭据状态未知';
}

export function serviceCredentialText(service) {
  const credential = service?.credentialState;
  if (!credential) return '凭据状态未知';
  if (credential.state === 'none' || credential.source === 'none') return '未配置凭据';
  return credentialSourceLabel(credential);
}

export function serviceModelCount(service) {
  const selected = Array.isArray(service?.modelOrder)
    ? service.modelOrder.length
    : Array.isArray(service?.selectedModelIds)
      ? service.selectedModelIds.length
      : Array.isArray(service?.models) ? service.models.length : 0;
  return selected;
}

export function serviceSelectable(service) {
  return Boolean(service && !service.readOnly);
}
