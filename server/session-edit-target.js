/* 编辑并重新发送：从 Pi 原生 session entries 解析“界面上第 N 条用户消息”。
 *
 * ---------- 为什么需要这一层 ----------
 *
 * Renderer 的 `data-anchor-id` 是 DOM 渲染序号，不是 Pi entry id；刷新、
 * 分叉、压缩之后都会变。编辑事务必须绑定**原生 entry id + leafId**，否则
 * 迟到的点击会改到另一条消息上。
 *
 * `get_entries` 返回的是 append-order 的完整树，而 UI 显示的是 active path
 * 的 projection。本模块按 Pi 文档（session-format.md）复刻两件事：
 *
 *   1. `buildContextEntries`：从 leaf 向 root 走，保留最新 compaction 及其
 *      `firstKeptEntryId` 之后的范围；
 *   2. `context_edit`：同一 target 以 active path 上最后一条为准；replacement
 *      为 null 时该 target 不进入模型上下文，否则只替换 content。
 *
 * 只做只读投影，不写 session、不调用 Pi。任何形状不符都返回 `null`，由
 * 调用方 fail-closed —— 不猜、不按序号硬套。
 */

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const part of content) {
    if (isObject(part) && part.type === 'text' && typeof part.text === 'string') out.push(part.text);
  }
  return out.join('\n');
}

function contentImages(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    if (!isObject(part) || part.type !== 'image') continue;
    if (typeof part.data !== 'string' || !part.data || typeof part.mimeType !== 'string' || !part.mimeType) {
      return null;
    }
    images.push({ type: 'image', data: part.data, mimeType: part.mimeType });
  }
  return images;
}

function unsupportedPart(content) {
  if (typeof content === 'string' || content === undefined || content === null) return false;
  if (!Array.isArray(content)) return true;
  return content.some(part => !isObject(part) || !['text', 'image'].includes(part.type));
}

function hasToolActivity(message) {
  if (!isObject(message)) return false;
  if (message.role === 'toolResult') return true;
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.content.some(part => isObject(part) && part.type === 'toolCall');
}

/** Walk from leaf to root. Returns null when a non-null leaf cannot be resolved. */
export function activePath(entries, leafId) {
  if (!Array.isArray(entries)) return null;
  const byId = new Map();
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id || byId.has(entry.id)) return null;
    byId.set(entry.id, entry);
  }
  if (leafId === null || leafId === undefined) return [];
  if (typeof leafId !== 'string' || !byId.has(leafId)) return null;
  const path = [];
  const seen = new Set();
  let current = byId.get(leafId);
  while (current) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    path.push(current);
    if (current.parentId === null || current.parentId === undefined) break;
    if (typeof current.parentId !== 'string' || !byId.has(current.parentId)) return null;
    current = byId.get(current.parentId);
  }
  return path.reverse();
}

/** Pi's compaction-aware context range, preserving non-message entries. */
export function contextEntries(entries, leafId) {
  const path = activePath(entries, leafId);
  if (!path) return null;
  let compaction = null;
  for (const entry of path) if (entry.type === 'compaction') compaction = entry;
  if (!compaction) return path;
  const index = path.findIndex(entry => entry.id === compaction.id);
  if (index < 0) return null;
  const firstKept = typeof compaction.firstKeptEntryId === 'string' ? compaction.firstKeptEntryId : null;
  const out = [compaction];
  let found = false;
  for (let i = 0; i < index; i++) {
    const entry = path[i];
    if (firstKept && entry.id === firstKept) found = true;
    if (found && !(entry.type === 'message' && entry.message?.role === 'system')) out.push(entry);
  }
  out.push(...path.slice(index + 1));
  return out;
}

function editMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (entry.type !== 'context_edit' || typeof entry.targetId !== 'string') continue;
    if (entry.replacement !== null && (!isObject(entry.replacement) || !Object.hasOwn(entry.replacement, 'content'))) {
      return null;
    }
    map.set(entry.targetId, entry);
  }
  return map;
}

function projectMessage(entry, edit) {
  if (!isObject(entry.message)) return null;
  let content = entry.message.content;
  if (edit) {
    if (edit.replacement === null) return null;
    content = edit.replacement.content;
  }
  return {
    entryId: entry.id,
    parentId: entry.parentId ?? null,
    role: entry.message.role,
    content,
    timestamp: entry.timestamp ?? null,
  };
}

/**
 * Visible user targets in the same order the GUI renders `get_messages`.
 *
 * Only `type:"message"` / `role:"user"` entries become targets. Compaction,
 * branch summaries and custom messages use other roles, so they cannot shift
 * the index. Any malformed projection returns null instead of a partial list.
 */
export function userTargets(entries, leafId) {
  const context = contextEntries(entries, leafId);
  if (!context) return null;
  const edits = editMap(context);
  if (!edits) return null;
  const projected = [];
  for (const entry of context) {
    if (entry.type === 'context_edit') continue;
    if (entry.type !== 'message' || !isObject(entry.message)) continue;
    const edit = edits.get(entry.id) || null;
    const message = projectMessage(entry, edit);
    if (!message) continue;
    projected.push(message);
  }

  const targets = [];
  let userIndex = 0;
  for (let i = 0; i < projected.length; i++) {
    const message = projected[i];
    if (message.role !== 'user') continue;
    const text = contentText(message.content);
    const images = contentImages(message.content);
    if (!images) return null;
    let hasToolsAfter = false;
    for (let j = i + 1; j < projected.length; j++) {
      if (hasToolActivity(projected[j])) { hasToolsAfter = true; break; }
    }
    targets.push({
      userIndex,
      entryId: message.entryId,
      parentId: message.parentId,
      text,
      images,
      hasUnsupportedParts: unsupportedPart(message.content),
      hasToolsAfter,
      timestamp: message.timestamp,
    });
    userIndex += 1;
  }
  return targets;
}

/** Resolve one visible user message and return the full list for revision checks. */
export function resolveUserTarget(entries, leafId, userIndex) {
  if (!Number.isInteger(userIndex) || userIndex < 0) return { ok: false, code: 'invalid_user_index' };
  const targets = userTargets(entries, leafId);
  if (!targets) return { ok: false, code: 'history_unparsable' };
  const target = targets[userIndex];
  if (!target) return { ok: false, code: 'unknown_user_message' };
  if (target.hasUnsupportedParts) return { ok: false, code: 'attachments_unsupported' };
  return { ok: true, target, targets, leafId: leafId ?? null, entryCount: Array.isArray(entries) ? entries.length : 0 };
}

/** First token of a Pi command invocation, or null when the text is not one. */
export function commandNameOf(text) {
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  const space = text.indexOf(' ');
  const name = space === -1 ? text.slice(1) : text.slice(1, space);
  return name || null;
}

/** True when text would be dispatched as one of the registered Pi commands. */
export function commandConflict(text, commands) {
  const name = commandNameOf(text);
  if (!name || !Array.isArray(commands)) return null;
  const hit = commands.find(command => isObject(command) && command.name === name);
  return hit ? name : null;
}
