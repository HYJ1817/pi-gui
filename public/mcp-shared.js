import { createIcon } from './ui/icons.js';
import { noteUnknownEnum } from './schema-drift.js';
/* MCP 管理页与市场页共用的展示层工具。
 *
 * 这个模块只做三件事：把后端的安全投影翻译成人能读的状态、生成静态图标、
 * 提供不依赖 innerHTML 的 DOM 小工具。它不 fetch、不缓存服务端状态，
 * 也不把任何上游字符串直接塞进 DOM。
 */

/* 服务端还会拒绝 `__proto__` 等保留键；前端提前用同一条判据，
 * 避免用户填完表单才在请求里拿到 bad-name。 */
export const MCP_NAME_RE = /^(?!__proto__$|prototype$|constructor$)[A-Za-z0-9_-]{1,64}$/;

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

/** 闭集外的运行状态显示「状态未知」，同时记一条 schema 漂移（只记来源 / 字段 / 类型，不记值）。
 *  这条上报原在旧「Skills 与扩展 › MCP」标签里，标签移除后由管理页承接。 */
export function runtimeLabel(state) {
  if (RUNTIME_LABELS[state]) return RUNTIME_LABELS[state];
  if (state) noteUnknownEnum('mcp-runtime', 'server.state', state);
  return '状态未知';
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

const MCP_ICONS = 'server globe folder search plus market scan refresh edit trash test key info warning check close chevron external clock list terminal box lock'.split(' ');

export function icon(name, className = 'mcp-icon') {
  const span = document.createElement('span');
  span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.append(createIcon(name === 'chevron' ? 'chevronRight' : name, { fallback: 'server' }));
  return span;
}

/** 静态图标名是否受支持（给测试用，避免拼错时静默退回 server）。 */
export function iconNames() {
  return [...MCP_ICONS];
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
 *
 * 原生层的全局状态（replaced / disabled / unsupported）属于整页事实：
 * 页面只在页头或一条横幅里说一次。这里不再把它复制到每一行 ——
 * `replaced` 尤其不是错误，server 仍按运行时事实显示。
 */
export function serverStatus(server, runtime, { trust, nativeState = null } = {}) {
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
  if (server.enabled === false) {
    return { tone: 'dim', label: '已停用', detail: '配置仍在，Pi 不会加载它', state: 'disabled' };
  }
  /* 原生层整体不可用时，每一行都显示同一条原因只是重复。页头/横幅已经
   * 说明「这里的配置不会被加载」，这里只给一个安静的结果标记。 */
  if (nativeState === 'disabled' || nativeState === 'unsupported') {
    return { tone: 'dim', label: '未生效', detail: '', state: nativeState };
  }
  if (!runtime) {
    return { tone: 'dim', label: '未测试', detail: '连接状态未知；点「测试连接」或「刷新状态」', state: 'untested' };
  }
  if (runtime.ok === false) {
    /* 整次刷新失败是页面级事实（页顶一条横幅带原因）；逐行再写“刷新失败”
     * 只是把同一条错误复制 N 遍。行内只保留“这台的连接状态未验证”。 */
    return { tone: 'dim', label: '未验证', detail: '', state: 'refresh-failed' };
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
  // 闭集外的值经 runtimeLabel：仍显示「状态未知」，同时留一条漂移记录（不回显上游原文）。
  return { tone: 'dim', label: runtimeLabel(state), detail: '', state, entry };
}
