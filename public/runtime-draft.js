/* Z5-1: Runtime 并行会话纯文本草稿持久化与安全恢复适配器
 *
 * 职责：
 * 1. Runtime 草稿 key 生成与后端证明的稳定 locator 身份隔离；
 * 2. 复用 public/draft.js 的纯文本原语（readDraftText, writeDraftText, removeDraft）；
 * 3. 20000 字符恢复上限守卫（超限不截断、清除旧副本、内存保留、内联提示）；
 * 4. 存储不可用/配额不足时的内存降级；
 * 5. 400ms 防抖与离开/卸载时的同步 flush；
 * 6. 发送成功时的条件清理与旧 ACK 隔离。
 *
 * 严禁：持久化附件、凭据、文件路径、工具输出、模型响应或无稳定身份的公共 key。
 */

import {
  readDraftText,
  writeDraftText,
  removeDraft,
  DRAFT_MAX_CHARS,
  DRAFT_SAVE_DEBOUNCE_MS,
} from './draft.js';

export { DRAFT_MAX_CHARS, DRAFT_SAVE_DEBOUNCE_MS };

export const RUNTIME_DRAFT_PREFIX = 'pi-gui.draft.v1:runtime:';

/**
 * 校验标识字段是否为非空、有界字符串。
 */
function isValidIdentity(str) {
  return typeof str === 'string' && str.trim().length > 0 && str.length <= 512;
}

/**
 * 从 item 和 owner 提取后端已证明的稳定 locator。
 * 必须完整包含：projectId, workspaceId, workspaceEpoch, conversationId, nativeSessionId。
 * 若 item.nativeSessionId 与 owner.sessionId 冲突，或任一字段缺失，返回 null。
 */
export function extractStableLocator(item, owner) {
  if (!item && !owner) return null;
  const conversationId = item?.conversationId || owner?.conversationId;
  const itemWs = item?.workspace;
  if (itemWs && owner) {
    if (itemWs.projectId && owner.projectId && itemWs.projectId !== owner.projectId) return null;
    if (itemWs.workspaceId && owner.workspaceId && itemWs.workspaceId !== owner.workspaceId) return null;
    if (itemWs.workspaceEpoch && owner.workspaceEpoch && itemWs.workspaceEpoch !== owner.workspaceEpoch) return null;
  }
  const projectId = itemWs?.projectId || owner?.projectId;
  const workspaceId = itemWs?.workspaceId || owner?.workspaceId;
  const workspaceEpoch = itemWs?.workspaceEpoch || owner?.workspaceEpoch;

  if (item?.nativeSessionId && owner?.sessionId && item.nativeSessionId !== owner.sessionId) {
    return null; // 身份冲突
  }
  const nativeSessionId = item?.nativeSessionId || owner?.sessionId || null;

  if (
    !isValidIdentity(conversationId) ||
    !isValidIdentity(projectId) ||
    !isValidIdentity(workspaceId) ||
    !isValidIdentity(workspaceEpoch) ||
    !isValidIdentity(nativeSessionId)
  ) {
    return null;
  }

  return {
    projectId,
    workspaceId,
    workspaceEpoch,
    conversationId,
    nativeSessionId,
  };
}

/**
 * 生成 Runtime 持久化草稿 key。
 * 格式：pi-gui.draft.v1:runtime:<projectId>:<workspaceId>:<workspaceEpoch>:<conversationId>:<nativeSessionId>
 * 若 locator 无效或字段缺失，返回 null。禁止写入公共空身份。
 */
export function runtimeDraftKey(locator) {
  if (!locator) return null;
  const { projectId, workspaceId, workspaceEpoch, conversationId, nativeSessionId } = locator;
  if (
    !isValidIdentity(projectId) ||
    !isValidIdentity(workspaceId) ||
    !isValidIdentity(workspaceEpoch) ||
    !isValidIdentity(conversationId) ||
    !isValidIdentity(nativeSessionId)
  ) {
    return null;
  }
  return RUNTIME_DRAFT_PREFIX + [
    projectId,
    workspaceId,
    workspaceEpoch,
    conversationId,
    nativeSessionId,
  ].map(encodeURIComponent).join(':');
}

/**
 * 比较两个稳定 locator 是否完全一致。
 */
export function sameStableLocator(a, b) {
  if (!a || !b) return false;
  return (
    a.projectId === b.projectId &&
    a.workspaceId === b.workspaceId &&
    a.workspaceEpoch === b.workspaceEpoch &&
    a.conversationId === b.conversationId &&
    a.nativeSessionId === b.nativeSessionId
  );
}

/**
 * 保存 Runtime 草稿纯文本。
 * - 超过 20000 字符：不调用 writeDraftText（不截断），清除旧持久副本，返回 exceeded 状态。
 * - 正常范围纯文本：写入 localStorage。写入失败则返回 memory_only 状态。
 * - 空文本：清除持久副本。
 * - 无稳定 key：返回 unbound 状态，仅保留在内存。
 */
export function saveRuntimeDraft(key, text) {
  const value = typeof text === 'string' ? text : '';
  if (!key) {
    return { status: 'unbound', text: value };
  }
  if (!value.trim()) {
    removeDraft(key);
    return { status: 'empty', text: '' };
  }
  if (value.length > DRAFT_MAX_CHARS) {
    // 超限：不能静默截断，清除旧持久副本以防恢复旧稿，完整文本保留在内存中
    removeDraft(key);
    return {
      status: 'exceeded',
      text: value,
      limit: DRAFT_MAX_CHARS,
      notice: '草稿超过本地恢复上限，请复制保存完整文本',
    };
  }
  const payload = writeDraftText(key, value);
  if (!payload) {
    return {
      status: 'memory_only',
      text: value,
      notice: '草稿仅在本次窗口保留',
    };
  }
  return { status: 'saved', text: value };
}

/**
 * 从持久副本恢复草稿纯文本。
 * 超过 DRAFT_MAX_CHARS 或格式异常拒绝恢复并清除。
 */
export function restoreRuntimeDraft(key) {
  if (!key) return '';
  const text = readDraftText(key);
  if (typeof text !== 'string') return '';
  if (text.length > DRAFT_MAX_CHARS) {
    removeDraft(key);
    return '';
  }
  return text;
}

/**
 * 清除持久草稿。若传入 expectedText，仅当当前持久副本内容等于 expectedText 时才清除。
 */
export function clearRuntimeDraft(key, expectedText = null) {
  if (!key) return false;
  if (typeof expectedText === 'string') {
    const current = readDraftText(key);
    if (current !== expectedText) {
      return false; // 持久副本已发生变化，不误删新输入
    }
  }
  removeDraft(key);
  return true;
}

/**
 * 为 Runtime 会话提供草稿防抖与同步生命周期管理器。
 */
export function createRuntimeDraftCoordinator({ onStatus } = {}) {
  let timer = null;
  let pendingKey = null;
  let pendingText = null;

  function cancel() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingKey = null;
    pendingText = null;
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingKey !== null) {
      const res = saveRuntimeDraft(pendingKey, pendingText);
      onStatus?.(pendingKey, res);
      pendingKey = null;
      pendingText = null;
      return res;
    }
    return null;
  }

  function schedule(key, text) {
    pendingKey = key;
    pendingText = text;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const res = saveRuntimeDraft(key, text);
      pendingKey = null;
      pendingText = null;
      onStatus?.(key, res);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }

  return {
    schedule,
    flush,
    cancel,
    dispose() {
      cancel();
    },
  };
}
