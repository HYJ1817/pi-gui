/* pi 的 RPC 命令层：发命令、处理应答、以及由会话生命周期触发的动作。
 *
 * 约定（踩过的坑，别改回去）：
 *   - 应答事件必须**同时**带 type:'response' 和 command:'xxx'。
 *     只有 command 会被前端静默丢弃 —— 症状是「流式能渲染，但模型名/统计/对话区全空」。
 *   - set_model 需要 provider + modelId 两个字段；只传 model 会报
 *     "Model not found: <provider>/undefined"（官方文档没写）。
 *   - pi 对非法的思考档位也回 {ok:true}（medium 被静默夹成 high、bogus 被忽略），
 *     所以设置类命令一律**回读 get_state**，不然界面会显示一个 pi 根本没接受的值。 */

import { el, S } from './state.js';
import { absPath } from './util.js';
import { sendCommand } from './api.js';
import { toast } from './ui/toast.js';
import { setStatus } from './shell.js';
import { clearThread, rebuildFromMessages } from './messages.js';
import { applyTree } from './tree.js';
import { applyState, applyStats, onModels, onThinkingLevels } from './usage.js';
import { autoGrow, updateSendState } from './composer.js';
import { attachmentImages, buildMessage, renderAttachments } from './attachments.js';
import { clearChanges } from './changes.js';

/** pi 就绪后拉一遍初始状态。切换项目 / 重载配置也会走这里。 */
export function boot() {
  sendCommand({ type: 'get_state' });
  sendCommand({ type: 'get_session_stats' });
  sendCommand({ type: 'get_tree' });
  // 切换项目 / 重载配置后 pi 会恢复该目录的历史会话，用 get_messages 重建对话区
  sendCommand({ type: 'get_messages' });
  sendCommand({ type: 'get_available_models' });
  sendCommand({ type: 'get_available_thinking_levels' });
}

export function onResponse(evt) {
  if (!evt.success) {
    if (evt.command !== 'get_available_thinking_levels') {
      toast(evt.error || `命令 ${evt.command} 执行失败`, 'error');
    }
    // 设置类命令失败后，之前乐观更新的显示会与 pi 不一致，回读一次纠正
    if (evt.command === 'set_model' || evt.command === 'set_thinking_level') sendCommand({ type: 'get_state' });
    return;
  }
  const d = evt.data || {};
  switch (evt.command) {
    case 'get_state':
      return applyState(d);
    case 'get_session_stats':
      return applyStats(d);
    case 'get_tree':
      return applyTree(d);
    case 'get_messages':
      return rebuildFromMessages(d);
    case 'get_available_models':
      return onModels(d);
    case 'get_available_thinking_levels':
      return onThinkingLevels(d);
    case 'set_model':
      if (d.name || d.id) el.modelText.textContent = d.name || d.id;
      toast('已切换到 ' + (d.name || d.id), 'info');
      return;
    case 'new_session':
      afterSessionSwitch();
      toast('已开始新会话（旧会话还在，「会话」面板里可以切回去）', 'info');
      return;
    case 'fork':
      afterSessionSwitch();
      toast('已从该节点分叉', 'info');
      return;
    case 'compact':
      toast('上下文压缩完成', 'info');
      return;
    case 'export_html':
      toast('已导出会话：' + absPath(d.path || ''), 'info');
      return;
    default:
      return;
  }
}

/* ---------- 会话动作 ---------- */

export function respond(id, payload) {
  sendCommand({ type: 'extension_ui_response', id, ...payload });
}

export async function submit() {
  if (S.submitting) return;
  if (!S.hasProject || S.switching || S.bridgeState !== 'ready') {
    toast('还没有选择项目：先在左侧「添加文件夹」选一个目录。', 'info');
    return;
  }
  const text = el.input.value.trim();
  const atts = S.attachments.slice();
  if (!text && !atts.length) return;

  const message = buildMessage(text);
  const images = attachmentImages();

  const cmd = { message };
  if (images.length) cmd.images = images;

  S.submitting = true;
  updateSendState();
  try {
    let result;
    if (S.streaming) {
      // 运行中发送 → 作为引导消息插话
      result = await sendCommand({ type: 'steer', ...cmd });
      if (result.ok) toast('已作为引导消息排队', 'info');
    } else {
      result = await sendCommand({ type: 'prompt', ...cmd });
    }
    if (!result?.ok) return; // 失败时保留输入和附件，用户可以重试
    if (el.input.value.trim() === text) el.input.value = '';
    S.attachments = S.attachments.filter((item) => !atts.includes(item));
    renderAttachments();
    autoGrow();
  } finally {
    S.submitting = false;
    updateSendState();
  }
}

export async function stop() {
  if (!S.streaming) return;
  await sendCommand({ type: 'abort' });
  setStatus('已请求停止…');
}

export const newSession = () => sendCommand({ type: 'new_session' });

/**
 * 会话换掉之后要做的界面收尾：清空对话区与变更账本，再 boot() 按新会话重建。
 *
 * 抽出来是因为**有两条路径**都会换会话：pi 主动报的 `new_session` / `fork`
 * （走 onResponse），以及用户在「会话」面板里切到某个旧会话（走后端 HTTP，
 * 不经过这里）。两条路径必须做同一件事 —— 否则切完会话界面还挂着上一个会话的
 * 消息，看起来就像「切了但没生效」。
 */
export function afterSessionSwitch() {
  clearThread();
  // 换了一条工作线，上一段的文件变更记录不再适用。
  // 注意 fork 也不清：分叉不改磁盘，之前改过的文件依然处于改动状态。
  clearChanges();
  setTimeout(boot, 250);
}

export const forkFrom = (entryId) => sendCommand({ type: 'fork', entryId });

export const exportHtml = () => sendCommand({ type: 'export_html' });

export const setSessionName = (name) => sendCommand({ type: 'set_session_name', name });

export function compactNow() {
  sendCommand({ type: 'compact' });
  toast('已请求压缩上下文', 'info');
}

/* 设置类命令：先乐观更新显示，再回读状态让 pi 说了算。
 * 成功提示放在 onResponse 的 set_model 分支里 —— 点选时不抢先弹。 */
export function setModel(provider, modelId, label) {
  sendCommand({ type: 'set_model', provider, modelId });
  if (label) el.modelText.textContent = label;
  sendCommand({ type: 'get_state' });
}

export function setThinkingLevel(level) {
  sendCommand({ type: 'set_thinking_level', level });
  el.thinkText.textContent = '思考 ' + level;
  sendCommand({ type: 'get_state' });
}
