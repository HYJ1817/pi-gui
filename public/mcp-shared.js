/* MCP 管理页与市场页共用的展示层工具。
 *
 * 这个模块只做三件事：把后端的安全投影翻译成人能读的状态、生成静态图标、
 * 提供不依赖 innerHTML 的 DOM 小工具。它不 fetch、不缓存服务端状态，
 * 也不把任何上游字符串直接塞进 DOM。
 */

export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* 运行时状态闭集（与 Pi 的 ServerState 对齐）。后端已经把未知值折成
 * `unknown`；这里仍保留兜底，未知值不原样显示。 */
const RUNTIME_LABELS = {
  connected: '已连接',
  connecting: '连接中…',
  'needs-auth': '需要授权',
  disconnected: '已断开',
  failed: '连接失败',
  closed: '已关闭',
  disabled: '已停用',
  unknown: '状态未知',
};

export function runtimeLabel(state) {
  return RUNTIME_LABELS[state] || '状态未知';
}

export function scopeLabel(scope) {
  if (scope === 'project') return '项目';
  if (scope === 'user') return '全局';
  if (scope === 'extension') return '扩展注册';
  return '未知';
}

export function transportLabel(server) {
  if (!server) return '未知';
  if (server.transportType === 'http') return 'HTTP';
  if (server.transportType === 'stdio') return 'stdio';
  if (server.transportType === 'inherited') return '继承全局';
  return '未知';
}

export function relativeTime(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const delta = Math.max(0, Date.now() - then);
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  try {
    return new Date(then).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

/* ---------- DOM ---------- */

export function node(tag, className = '', text = '') {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== '' && text !== null && text !== undefined) n.textContent = String(text);
  return n;
}

export function button(className, text, { label = '', title = '', type = 'button' } = {}) {
  const b = node('button', className, text);
  b.type = type;
  if (label) b.setAttribute('aria-label', label);
  if (title) b.title = title;
  return b;
}

export function badge(text, tone = '') {
  return node('span', 'mcp-badge' + (tone ? ` is-${tone}` : ''), text);
}

export function statusDot(tone = 'dim') {
  const dot = node('span', `mcp-status-dot is-${tone}`);
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

const ICONS = {
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  market: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9 20v-6h6v6"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  test: '<path d="M9 3h6M10 3v5l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 17l-5-9V3"/><path d="M7.5 14h9"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l2 2M14 9l2 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  warning: '<path d="M12 4l9 16H3z"/><path d="M12 9v5M12 17h.01"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
};

export function icon(name, className = 'mcp-icon') {
  const span = document.createElement('span');
  span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.server}</svg>`;
  return span;
}

/** 静态图标名是否受支持（给测试用，避免拼错时静默退回 server）。 */
export function iconNames() {
  return Object.keys(ICONS);
}

/* ---------- 状态推导 ---------- */

/** 在运行时报告里找一台 server。scope 双方都已知时优先精确匹配。 */
export function runtimeServerFor(runtime, name, scope) {
  if (!runtime || !Array.isArray(runtime.servers)) return null;
  const rows = runtime.servers.filter((s) => s && s.name === name);
  if (!rows.length) return null;
  const wanted = scope === 'project' ? 'project' : scope === 'user' ? 'user' : '';
  return rows.find((s) => !wanted || !s.scope || s.scope === wanted) || rows[0];
}

/**
 * 把「配置事实 + 运行时事实 + 信任事实」合成一个展示状态。
 *
 * 绝不合流：
 *   configured → 文件里写了（summary 一定为真）
 *   connected  → 只有 runtime state === 'connected' 才是
 *   loaded     → 本界面拿不到 Agent 会话的加载状态，永远单独说明
 */
export function serverStatus(server, runtime, { trust } = {}) {
  if (!server || typeof server !== 'object') {
    return { tone: 'dim', label: '状态未知', detail: '', state: 'unknown' };
  }
  const eff = server.effective || {};
  if (server.scope === 'project' && trust !== true) {
    return {
      tone: 'warn',
      label: trust === false ? '项目未信任' : '信任未知 · 未生效',
      detail: 'Pi 在非交互模式下不会读取未信任项目的 .pi/mcp.json',
      state: 'untrusted',
    };
  }
  if (server.scope === 'user' && eff.reason === 'overridden') {
    return {
      tone: 'dim',
      label: '已被项目覆盖',
      detail: '项目里有同名条目，当前项目内使用项目那份配置',
      state: 'overridden',
    };
  }
  if (server.enabled === false || eff.reason === 'disabled') {
    return { tone: 'dim', label: '已停用', detail: '配置仍在，Pi 不会加载它', state: 'disabled' };
  }
  if (eff.reason === 'replaced') {
    return { tone: 'warn', label: '内置 MCP 被扩展接管', detail: 'pi 的 /mcp 被扩展注册替换', state: 'replaced' };
  }
  if (eff.reason === 'unsupported') {
    return { tone: 'warn', label: 'Pi 不支持原生 MCP', detail: '当前 pi 包没有 builtin:mcp', state: 'unsupported' };
  }
  if (!runtime) {
    return { tone: 'dim', label: '未测试', detail: '连接状态未知；点「测试连接」或「刷新状态」', state: 'untested' };
  }
  if (runtime.ok === false) {
    return { tone: 'warn', label: '刷新失败', detail: runtime.error || 'pi mcp list 没有成功返回', state: 'refresh-failed' };
  }
  const entry = runtimeServerFor(runtime, server.name, server.scope);
  if (!entry) {
    return {
      tone: 'warn',
      label: '未加载',
      detail: '配置存在，但最近一次 pi mcp list 没有返回它；可能是项目未信任或会话尚未重载',
      state: 'not-loaded',
    };
  }
  const state = entry.state || 'unknown';
  if (state === 'connected') {
    const count = typeof entry.toolCount === 'number'
      ? entry.toolCount
      : Array.isArray(entry.tools) ? entry.tools.length : null;
    const tools = count === null ? '工具数未知' : `${count} 个工具`;
    return { tone: 'ok', label: '已连接', detail: tools, state, entry };
  }
  if (state === 'connecting') {
    return { tone: 'run', label: '连接中…', detail: 'pi 正在启动或握手', state, entry };
  }
  if (state === 'needs-auth') {
    return { tone: 'warn', label: '需要授权', detail: '需要完成 OAuth 登录后才会连接', state, entry };
  }
  if (state === 'failed') {
    return { tone: 'err', label: '连接失败', detail: entry.error || 'pi 报告连接失败', state, entry };
  }
  if (state === 'disabled') {
    return { tone: 'dim', label: '已停用', detail: '运行时没有启动它', state, entry };
  }
  if (state === 'closed' || state === 'disconnected') {
    return { tone: 'err', label: runtimeLabel(state), detail: entry.error || '没有活动的连接', state, entry };
  }
  return { tone: 'dim', label: '状态未知', detail: '', state, entry };
}
