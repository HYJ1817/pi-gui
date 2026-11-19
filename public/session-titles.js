/* AI 会话标题：设置缓存、SSE 应用与手动生成入口。
 *
 * 这里只做前端编排：
 *   - 设置/能力缓存（GET /api/session-titles/settings）；
 *   - 收到 `session_title` 后**就地**更新侧栏行、顶部标题、搜索结果与
 *     runtime store，不重建列表、不改变排序键；
 *   - 手动「AI 生成标题」的重复点击保护与「手动标题需确认」流程。
 *
 * 后端已经保证：只写原目标会话、迟到结果丢弃、自动标题只生成一次。
 * 前端不复制这些判据，只根据返回的 ok/code 展示结果。
 */
import {
  applySessionTitle,
  fetchSessionTitleSettings,
  generateSessionTitle,
  renameSessionTitle as renameSessionTitleApi,
  updateSessionTitleSettings,
} from './api.js';
import { S } from './state.js';
import { setTitleText } from './shell.js';
import { applySearchTitle } from './session-search.js';
import { patchRuntimeTitle } from './runtime-state.js';
import { acceptTitleEvent, resolveTitleSnapshot, titleKey } from './title-revision.js';
import { confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';

const listeners = new Set();
const generating = new Set();
let cache = null;
let loading = null;

function notify() {
  const snapshot = cache;
  for (const fn of listeners) {
    try { fn(snapshot); } catch { /* 设置页监听失败不带塌标题 */ }
  }
  document.dispatchEvent(new CustomEvent('pi-gui:session-title-settings', { detail: snapshot }));
}

function adopt(payload) {
  if (!payload || payload.ok !== true) return false;
  cache = {
    settings: payload.settings || { autoEnabled: true },
    capability: payload.capability || { supported: null, reason: null },
    model: payload.model || { mode: 'current-session', label: '跟随当前会话' },
  };
  notify();
  return true;
}

export function onSessionTitleSettings(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function sessionTitleSettingsSnapshot() {
  return cache;
}

/** supported 为 null 表示「还没验证」—— 未验证不等于不支持，入口照常显示。 */
export function titleCapability() {
  return cache?.capability || { supported: null, reason: null };
}

export function isTitleGenerating(key) {
  return generating.has(key);
}

export async function loadSessionTitleSettings({ force = false } = {}) {
  if (cache && !force) return cache;
  if (loading) return loading;
  loading = Promise.resolve()
    .then(() => fetchSessionTitleSettings())
    .then((res) => {
      adopt(res);
      return cache;
    })
    .catch(() => cache)
    .finally(() => { loading = null; });
  return loading;
}

export async function setAutoSessionTitle(enabled) {
  const res = await updateSessionTitleSettings(enabled === true);
  if (!res || res.ok !== true) {
    return { ok: false, error: (res && (res.error || res.code)) || '设置未能保存，请重试' };
  }
  adopt(res);
  return { ok: true };
}

function safeConversationId(value) {
  return typeof value === 'string' && /^[\da-f-]{36}$/i.test(value) ? value : null;
}

/** 把标题事件就地应用到所有看得到该会话的位置。
 *
 * 事件先过 `title-revision` 的门槛：旧 SSE（或与本地已采纳标题同修订但内容
 * 不同的迟到帧）直接丢弃，一行 DOM 都不碰。 */
export function applyTitleEvent(event) {
  if (!event || typeof event.title !== 'string' || !event.title) return;
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
  const conversationId = event.scope === 'runtime' ? safeConversationId(event.conversationId) : null;
  const key = event.scope === 'runtime'
    ? titleKey('runtime', conversationId)
    : titleKey('classic', sessionId);
  const accepted = acceptTitleEvent(key, {
    title: event.title,
    source: event.source,
    revision: Number.isSafeInteger(event.revision) ? event.revision : 0,
  });
  if (!accepted) return;
  const title = accepted.title;

  if (event.scope === 'runtime' && conversationId) {
    patchRuntimeTitle(conversationId, accepted);
    for (const row of document.querySelectorAll('.pj-runtime[data-conversation-id]')) {
      if (row.dataset.conversationId !== conversationId) continue;
      const titleEl = row.querySelector('.pj-sess-title');
      if (titleEl) titleEl.textContent = title;
      const primary = row.querySelector('.pj-sess-primary');
      if (primary) {
        const status = primary.querySelector('.pj-runtime-status')?.textContent || '';
        primary.setAttribute('aria-label', `并行会话：${title}${status ? '，' + status : ''}`);
      }
      const trigger = row.querySelector('.pj-sess-menu-trigger');
      if (trigger) trigger.setAttribute('aria-label', `会话操作：${title}`);
    }
    document.dispatchEvent(new CustomEvent('pi-gui:runtime-title', {
      detail: { conversationId, title, revision: accepted.revision, projectPath: event.projectPath || '' },
    }));
  } else if (sessionId) {
    document.dispatchEvent(new CustomEvent('pi-gui:classic-title', {
      detail: { sessionId, title, source: accepted.source, revision: accepted.revision },
    }));
    /* 顶部标题只在**确实是当前会话**时更新。优先看 state 的 sessionId；
     * switch 刚回来、get_state 还没到时，侧栏的当前行标记同样可信。
     * 是否允许覆盖由修订裁决，不再看 get_state.sessionName。 */
    const isCurrentRow = [...document.querySelectorAll('.pj-sess[data-classic-current]')]
      .some((row) => row.dataset.sessionId === sessionId);
    if (S.state?.sessionId === sessionId || isCurrentRow) setTitleText(title);
  }

  /* 搜索结果里同一条会话的标题也要更新；当前关键词的结果缓存由该模块维护。 */
  applySearchTitle(sessionId || null, title);
}

/**
 * 任意会话的手动改名（侧栏行、非当前项目预览、归档、Runtime 共用）。
 * 成功后立即按返回的修订就地更新；失败时保留原标题并返回错误，调用方给反馈。
 */
export async function renameSessionTitle(target = {}, title = '') {
  const scope = target.scope === 'runtime' ? 'runtime' : 'classic';
  const body = scope === 'runtime'
    ? {
      scope, conversationId: target.conversationId, title,
      expectedRevision: Number.isSafeInteger(target.expectedRevision) ? target.expectedRevision : 0,
    }
    : {
      scope, id: target.id, project: target.project, title,
      expectedRevision: Number.isSafeInteger(target.expectedRevision) ? target.expectedRevision : 0,
    };
  const res = await renameSessionTitleApi(body);
  if (!res || res.ok !== true) {
    /* 修订冲突说明别处已经改过标题。把后端给出的权威标题/修订并入本地，
     * 下一次重试就不会继续拿旧修订撞墙；不改用户刚输入的值。 */
    if (res?.code === 'revision_conflict' && typeof res.title === 'string' && res.title
      && Number.isSafeInteger(res.revision)) {
      applyTitleEvent({
        scope,
        sessionId: res.sessionId || target.sessionId || null,
        ...(scope === 'runtime' ? { conversationId: target.conversationId } : {}),
        title: res.title,
        source: 'manual',
        revision: res.revision,
      });
    }
    return res || { ok: false, code: 'failed', error: '改名失败，请重试' };
  }
  applyTitleEvent({
    scope,
    sessionId: res.sessionId || target.sessionId || null,
    ...(scope === 'runtime' ? { conversationId: target.conversationId } : {}),
    title: res.title,
    source: 'manual',
    revision: res.revision,
  });
  return res;
}

/** 记录一份可信快照（切换应答 / 列表行），返回裁决后的标题与修订。 */
export function reconcileTitleSnapshot(scope, id, snapshot) {
  return resolveTitleSnapshot(titleKey(scope, id), snapshot);
}

/** SSE 入口（app.js 在 bridgeRun 过滤之前调用）。 */
export function handleSessionTitleEvent(event) {
  if (!event) return;
  if (event.type === 'session_title_settings') {
    adopt(event);
    return;
  }
  if (event.type === 'session_title') applyTitleEvent(event);
}

/**
 * 手动生成。target：{scope:'classic', id} 或 {scope:'runtime', conversationId}。
 * 返回后端结果，方便调用方决定是否刷新菜单。
 */
export async function generateAiTitle(target = {}) {
  const scope = target.scope === 'runtime' ? 'runtime' : 'classic';
  const key = scope === 'runtime' ? `runtime:${target.conversationId || ''}` : `classic:${target.id || ''}`;
  if (generating.has(key)) return { ok: false, code: 'busy' };
  generating.add(key);
  try {
    const body = scope === 'runtime'
      ? { scope, conversationId: target.conversationId }
      : { scope, id: target.id, ...(target.project ? { project: target.project } : {}) };
    const res = await generateSessionTitle(body);
    if (!res || res.ok !== true) {
      if (res?.code === 'unsupported') void loadSessionTitleSettings({ force: true });
      toast((res && res.error) || '标题生成失败，已保留原标题', 'error');
      return res || { ok: false, code: 'failed' };
    }
    if (res.requiresConfirmation && res.proposal) {
      const ok = await confirmModal({
        title: '替换会话标题？',
        message:
          `当前是手动标题「${res.proposal.currentTitle}」。\n\n` +
          `AI 生成的新标题：\n「${res.proposal.title}」\n\n` +
          '替换后会保存为新的手动标题；不替换则保留原标题。',
        okText: '替换标题',
      });
      if (ok !== true) return { ok: false, code: 'cancelled' };
      const applied = await applySessionTitle(res.proposal.id);
      if (!applied || applied.ok !== true) {
        toast((applied && applied.error) || '标题未能应用，已保留原标题', 'error');
        return applied || { ok: false, code: 'failed' };
      }
      applyTitleEvent({
        scope, sessionId: applied.sessionId || target.sessionId || null,
        ...(scope === 'runtime' ? { conversationId: target.conversationId } : {}),
        title: applied.title, source: 'manual', revision: applied.revision,
      });
      toast('会话标题已更新', 'info');
      return applied;
    }
    /* 直接应用：SSE 也会到，但本地先画一次，避免断线时看不到结果。
     * 标题事件是幂等的，不会改变列表顺序或滚动位置。 */
    if (res.applied && res.title) {
      applyTitleEvent({
        scope, sessionId: res.sessionId || target.sessionId || null,
        ...(scope === 'runtime' ? { conversationId: target.conversationId } : {}),
        title: res.title, source: 'manual', revision: res.revision,
      });
      toast('会话标题已更新', 'info');
    }
    return res;
  } catch (err) {
    toast('标题生成失败：' + (err?.message || err), 'error');
    return { ok: false, code: 'failed' };
  } finally {
    generating.delete(key);
  }
}
