/* Controlled “fill, never send” bridge for review feedback.
 *
 * It only targets the composer that is already visible for the focused
 * conversation. Existing text is preserved by appending, and an `input` event
 * is dispatched so the existing classic/runtime draft owners persist it.
 */
import { el, S } from './state.js';
import { gitConversationScope } from './api.js';
import { workspaceView } from './ui/workspace-surface.js';
import { runtimeStore } from './runtime-state.js';

const SEPARATOR = '\n\n';

function sharedConversation(input) {
  return input && input.closest?.('.runtime-conversation[data-conversation-id]');
}

function fillTextarea(input, text, extra) {
  if (!input || input.disabled || input.readOnly) return { ok: false, error: '当前输入框不可写入。' };
  if (!text) return { ok: false, error: '没有可填入的审查意见。' };
  const original = String(input.value || '');
  const appended = Boolean(original.trim());
  /* Never rewrite the user's draft, including trailing whitespace. */
  const prefix = original ? original + SEPARATOR : '';
  const limit = Number(input.maxLength) > 0 ? Number(input.maxLength) : 256 * 1024;
  if (prefix.length + text.length > limit) {
    return { ok: false, error: '原草稿加上审查意见超过输入框上限，已保留审查意见供复制。' };
  }
  // Use the native setter so framework/value trackers observe this assignment
  // just like a paste. The explicit input event keeps the existing draft owner.
  const TextArea = input.ownerDocument?.defaultView?.HTMLTextAreaElement;
  const proto = TextArea && input instanceof TextArea ? TextArea.prototype : null;
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, prefix + text);
  else input.value = prefix + text;
  try {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {
    /* The draft owner may not be installed in a headless test. */
  }
  input.focus();
  try {
    input.setSelectionRange(input.value.length, input.value.length);
  } catch {
    /* Selection APIs are optional in a minimal DOM. */
  }
  return { ok: true, appended, ...extra };
}

export function fillReviewComposer(text) {
  const view = workspaceView();
  if (view === 'chat') {
    if (!S.hasProject || S.switching || S.stopping || S.submitting || S.bridgeState !== 'ready') {
      return { ok: false, error: '当前会话尚未就绪，已保留审查意见供复制。' };
    }
    if (gitConversationScope()) {
      return { ok: false, error: '当前是并行会话视图，未找到对应的经典输入框。' };
    }
    return fillTextarea(el.input, text, { target: 'classic' });
  }

  if (view !== 'runtime') {
    return { ok: false, error: '当前不在可填写的会话视图。' };
  }
  const id = gitConversationScope();
  if (!id) return { ok: false, error: '无法确定当前并行会话，已保留审查意见供复制。' };
  const record = runtimeStore.get(id);
  if (!record?.owner) return { ok: false, error: '当前并行会话没有可用的 Agent，已保留审查意见供复制。' };
  if (record.item?.lifecycle !== 'ready' || record.item?.activity === 'stopping') {
    return { ok: false, error: '当前并行会话未就绪或正在停止，已保留审查意见供复制。' };
  }
  const root = document.querySelector('.runtime-conversation[data-conversation-id]');
  if (!root || root.dataset.conversationId !== id) {
    return { ok: false, error: '当前并行会话身份不一致，未填入输入框。' };
  }
  const input = root.querySelector('textarea[aria-label="给当前会话的任务"]');
  if (sharedConversation(input) !== root) {
    return { ok: false, error: '当前并行会话输入框身份不一致，未填入。' };
  }
  return fillTextarea(input, text, { target: 'runtime', conversationId: id });
}
