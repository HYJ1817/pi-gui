/* P24 未发送草稿的恢复（workspace / session 隔离）。
 *
 * ---------- 存什么，不存什么（这是本模块存在的全部理由）----------
 *
 * **只存一段纯文本**：`{ v: 1, text, at }`。
 *
 * 明确**不存**：
 *   - 附件对象。它们带着 `dataUrl`（整张图的 base64）、`text`（抽取出来的正文）、
 *     `path`（本机绝对路径）—— 那是二进制与用户数据，不属于 localStorage。
 *   - 任何 token / cookie / 网页内容 / MCP-OAuth 凭据引用。
 *   - 会话文件绝对路径。key 里用的是**哈希**，不是路径原文。
 *
 * `tests/daily-use.cjs` 会直接断言「写进去的 JSON 只有这三个字段」——
 * 以后谁想往草稿里塞附件，那条断言当场红。
 *
 * ---------- key 的构成与版本 ----------
 *
 *   `pi-gui.draft.v1:<workspaceHash>:<sessionHash>`
 *
 *   workspaceHash = 当前项目路径的 FNV-1a 哈希（**不是路径原文**）
 *   sessionHash   = pi 会话 id 的哈希；拿不到会话身份时用 `nosession`
 *
 * 换项目 / 换会话 → key 变 → 读到的是**那一条**草稿，而不是上一条的。
 * 加 `v1` 是为了将来改结构时能一次性丢弃旧格式，而不是把两种格式混着读。
 *
 * ---------- 什么时候写、什么时候清 ----------
 *
 * - 输入时**防抖写**（400ms）；切换身份前立刻 flush 一次。
 * - 发送成功 → 清掉（`rpc.submit()` 调 `clearDraft()`）。
 * - 用户手动清空输入框 → 空文本**不落盘**，同时删掉旧 key（不留幽灵草稿）。
 * - 显式清空（`clearDraft()`）随时可用。
 * - 隐私模式 / 配额满导致 `localStorage` 抛错 → 静默降级为「不持久化」，
 *   功能照常，只是刷新后不恢复。**绝不因为存不下就报错打扰用户。**
 */
import { el, S } from './state.js';

export const DRAFT_PREFIX = 'pi-gui.draft.';
export const DRAFT_VERSION = 1;
/** 单条草稿的字符上限（超出部分不存，只留前 N 个字符 + 一个标记）。 */
export const DRAFT_MAX_CHARS = 20000;
/** 防抖窗口。 */
export const DRAFT_SAVE_DEBOUNCE_MS = 400;

/** FNV-1a 32 位：只用于「同一性」，不是密码学哈希，也不需要是。 */
export function hashKey(value) {
  const text = String(value == null ? '' : value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 当前 workspace 的哈希（没有项目时是 `noproj`）。 */
export function workspaceHash() {
  const cwd = S.cwd || '';
  return cwd ? hashKey(cwd) : 'noproj';
}

/** 当前会话的哈希（pi 还没应答时是 `nosession`）。 */
export function sessionHash() {
  const id = S.state?.sessionId || S.localUsage?.sessionId || '';
  return id ? hashKey(id) : 'nosession';
}

export function draftKey(ws = workspaceHash(), session = sessionHash()) {
  return `${DRAFT_PREFIX}v${DRAFT_VERSION}:${ws}:${session}`;
}

/* ---------- 存储层（所有 localStorage 访问都包了 try/catch）---------- */

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 读一条草稿的文本（读不到/格式不对/版本不对 → ''）。 */
export function readDraftText(key) {
  const store = storage();
  if (!store || !key) return '';
  let raw = null;
  try {
    raw = store.getItem(key);
  } catch {
    return '';
  }
  if (!raw) return '';
  try {
    const data = JSON.parse(raw);
    if (!data || data.v !== DRAFT_VERSION || typeof data.text !== 'string') return '';
    return data.text;
  } catch {
    return '';
  }
}

/** 写一条草稿。空文本 = 删除（不留幽灵草稿）。返回真正写下的 payload 或 null。 */
export function writeDraftText(key, text) {
  const store = storage();
  if (!store || !key) return null;
  const value = typeof text === 'string' ? text : '';
  if (!value.trim()) {
    try {
      store.removeItem(key);
    } catch {
      /* 删不掉也不影响使用 */
    }
    return null;
  }
  const payload = { v: DRAFT_VERSION, text: value.slice(0, DRAFT_MAX_CHARS), at: Date.now() };
  try {
    store.setItem(key, JSON.stringify(payload));
  } catch {
    return null;
  }
  return payload;
}

export function removeDraft(key) {
  const store = storage();
  if (!store || !key) return;
  try {
    store.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

/* ---------- 与输入框的绑定 ---------- */

/* 上一次「归到某个 key」的文本。用来判断输入框里的内容是不是用户刚打的
 * 还没归档的字 —— 那种情况下换身份**不许**用旧草稿覆盖它。 */
let lastSavedText = '';
let currentKey = null;
let timer = null;
let installed = false;

/** 现在应该用哪个 key。 */
function liveKey() {
  return draftKey();
}

/** 立刻把输入框内容归档到当前 key。 */
export function flushDraft() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (currentKey === null) currentKey = liveKey();
  const text = el.input ? el.input.value : '';
  writeDraftText(currentKey, text);
  lastSavedText = text;
  return currentKey;
}

function scheduleSave() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flushDraft();
  }, DRAFT_SAVE_DEBOUNCE_MS);
}

/**
 * 身份（workspace / session）可能变了 —— 重新对齐草稿。
 *
 * 规则：
 *   - 先把「还在输入框里、尚未归档」的字归到**旧** key（避免丢字）；
 *   - key 没变 → 什么都不做；
 *   - key 变了 → 用新 key 的草稿填充输入框（用户刚打的、还没归档的字不动）。
 */
export function draftSync() {
  if (!el.input) return null;
  if (currentKey === null) {
    // 首次：直接绑定到当前身份，并恢复那条草稿
    currentKey = liveKey();
    const restored = readDraftText(currentKey);
    if (restored && !el.input.value) el.input.value = restored;
    lastSavedText = el.input.value;
    return currentKey;
  }
  const next = liveKey();
  if (next === currentKey) return currentKey;

  // 身份变了：先把旧身份的字归档（用户可能还没来得及等防抖）
  const live = el.input.value;
  if (live !== lastSavedText) {
    if (timer) clearTimeout(timer);
    timer = null;
    writeDraftText(currentKey, live);
  } else if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const untouched = live === '' || live === lastSavedText;
  currentKey = next;
  if (!untouched) {
    /* 用户正在打字（输入框里的字还没归档到任何身份）—— 不覆盖它。
     * 下一次输入会把这段字归到新身份，行为可预测。 */
    lastSavedText = live;
    return currentKey;
  }
  const restored = readDraftText(next);
  el.input.value = restored;
  lastSavedText = restored;
  return currentKey;
}

/** 发送成功后调用：清掉当前身份的草稿（内存与磁盘）。 */
export function clearDraft() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (currentKey === null) currentKey = liveKey();
  removeDraft(currentKey);
  lastSavedText = el.input ? el.input.value : '';
}

/** 装配：绑定输入监听（写盘）并做一次初始同步（读盘恢复）。 */
export function initDraft() {
  if (installed || !el.input) return false;
  installed = true;
  el.input.addEventListener('input', () => {
    if (currentKey === null) currentKey = liveKey();
    scheduleSave();
  });
  /* 关页面前 flush —— 防抖窗口里的最后几个字不该丢。 */
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      try {
        flushDraft();
      } catch {
        /* 关页面路径上不抛 */
      }
    });
  }
  draftSync();
  return true;
}

/** 只给测试用：复位模块内部状态（不动磁盘）。 */
export function resetDraftState() {
  if (timer) clearTimeout(timer);
  timer = null;
  currentKey = null;
  lastSavedText = '';
  installed = false;
}
