/* pi 的 RPC 命令层：发命令、处理应答、以及由会话生命周期触发的动作。
 *
 * 约定（踩过的坑，别改回去）：
 *   - 应答事件必须**同时**带 type:'response' 和 command:'xxx'。
 *     只有 command 会被前端静默丢弃 —— 症状是「流式能渲染，但模型名/统计/对话区全空」。
 *   - set_model 需要 provider + modelId 两个字段；只传 model 会报
 *     "Model not found: <provider>/undefined"（官方文档没写）。
 *   - pi 对非法的思考档位也回 {ok:true}（medium 被静默夹成 high、bogus 被忽略），
 *     所以设置类命令一律**回读 get_state**，不然界面会显示一个 pi 根本没接受的值。 */

import { el, S, confirmStop, invalidateStop } from './state.js';
import { sendCommand, downloadSessionHtml } from './api.js';
import { toast, withNotificationSource } from './ui/toast.js';
import { setStatus } from './shell.js';
import { clearThread, rebuildFromMessages, noteLoadFailure, setStreaming } from './messages.js';
import { applyTree } from './tree.js';
import { applyState, applyStats, onModels, onThinkingLevels } from './usage.js';
import { autoGrow, updateSendState, renderModelControls, imageInputBlocked } from './composer.js';
import { attachmentImages, buildMessage, renderAttachments } from './attachments.js';
import { clearChanges } from './changes.js';
import { showChat } from './ui/workspace-surface.js';
import { clearDraft, draftSync } from './draft.js';
import { closePop, currentAnchor } from './ui/popover.js';
import { startFallbackRequest, cancelFallback, setFallbackModelSwitcher } from './fallback.js';

/** pi 就绪后拉一遍初始状态。切换项目 / 重载配置也会走这里。 */
export function boot() {
  cancelFallback('boot');
  activeModelSwitch = null;
  queuedModelSwitch = null;
  refreshModelState({ pending: false });
  sendCommand({ type: 'get_session_stats' });
  sendCommand({ type: 'get_tree' });
  // 切换项目 / 重载配置后 pi 会恢复该目录的历史会话，用 get_messages 重建对话区
  sendCommand({ type: 'get_messages' });
  sendCommand({ type: 'get_available_models' });
}

// Pi 原生回传 request id。仅在前端关联，不改变 RPC 或后端发现来源。
let modelGeneration = 0;
let activeModelSwitch = null;
let queuedModelSwitch = null;
let modelRefresh = null;
const modelRequestPrefix = 'composer-model-';
const stateReads = new Map();
let stateReadSequence = 0;

function readState() {
  const id = 'composer-state-' + (++stateReadSequence);
  stateReads.set(id, { generation: modelGeneration, workspace: S.workspaceGeneration });
  sendCommand({ type: 'get_state', id }).then((result) => {
    if (!result?.ok) stateReads.delete(id);
  });
}

function pendingModel() {
  S.thinkingLevels = [];
  S.modelSwitchPending = true;
  renderModelControls();
  if (currentAnchor() === el.btnThink) closePop();
}

export function refreshModelState({ pending = true, completion = null } = {}) {
  S.thinkingLevels = [];
  S.modelSwitchPending = pending;
  renderModelControls();
  const generation = ++modelGeneration;
  stateReads.clear();
  const prefix = modelRequestPrefix + generation;
  const refresh = modelRefresh = { generation, workspace: S.workspaceGeneration, stateId: prefix + '-state', levelsId: prefix + '-levels', completion };
  for (const [type, id] of [['get_state', refresh.stateId], ['get_available_thinking_levels', refresh.levelsId]]) {
    sendCommand({ type, id }).then((result) => {
      if (!result?.ok && modelRefresh === refresh) {
        onResponse({ command: type, id, success: false });
      }
    });
  }
}

function sendModelSwitch(request) {
  activeModelSwitch = request;
  sendCommand({ type: 'set_model', id: request.id, provider: request.provider, modelId: request.modelId, ...(request.fallbackOwner ? { __fallbackOwner: request.fallbackOwner } : {}) }).then((result) => {
    if (!result?.ok && activeModelSwitch === request) onResponse({ command: 'set_model', id: request.id, success: false });
  });
}

function acceptModelResponse(evt) {
  if (typeof evt.id === 'string' && evt.id.startsWith('composer-state-')) {
    const read = stateReads.get(evt.id);
    stateReads.delete(evt.id);
    if (read && read.generation === modelGeneration && read.workspace === S.workspaceGeneration && !S.modelSwitchPending && evt.success) applyState(evt.data || {});
    return true;
  }
  if (evt.command === 'set_model' && activeModelSwitch) {
    const request = activeModelSwitch;
    if (evt.id !== request.id) return true;
    activeModelSwitch = null;
    if (request.workspace !== S.workspaceGeneration) {
      request.resolve?.(false);
      queuedModelSwitch = null;
      return true;
    }
    if (queuedModelSwitch) {
      request.resolve?.(false);
      const next = queuedModelSwitch;
      queuedModelSwitch = null;
      sendModelSwitch(next);
      return true;
    }
    if (evt.success) toast('已切换到 ' + (evt.data?.name || evt.data?.id || request.modelId), 'info');
    else if (evt.error) toast(evt.error, 'error');
    // 失败也读取 Pi 的实际模型，绝不保留乐观选择。
    refreshModelState({ completion: { resolve: request.resolve, success: evt.success === true, provider: request.provider, modelId: request.modelId } });
    return true;
  }
  if (typeof evt.id === 'string' && evt.id.startsWith(modelRequestPrefix)) {
    const refresh = modelRefresh;
    if (!refresh || refresh.generation !== modelGeneration || refresh.workspace !== S.workspaceGeneration) return true;
    if (evt.id === refresh.stateId && evt.command === 'get_state') refresh.stateResult = evt;
    else if (evt.id === refresh.levelsId && evt.command === 'get_available_thinking_levels') refresh.levelsResult = evt;
    else return true;
    if (refresh.stateResult && refresh.levelsResult) {
      S.modelSwitchPending = false;
      if (refresh.stateResult.success) applyState(refresh.stateResult.data || {});
      if (refresh.stateResult.success && refresh.levelsResult.success) onThinkingLevels(refresh.levelsResult.data || {});
      modelRefresh = null;
      renderModelControls();
      const c = refresh.completion;
      c?.resolve?.(c.success && refresh.stateResult.success && refresh.levelsResult.success
        && S.state?.model?.providerId === c.provider && S.state?.model?.modelId === c.modelId);
    }
    return true;
  }
  // 未关联的旧 state/levels 不能插进正在同步的模型。
  return S.modelSwitchPending && (evt.command === 'get_state' || evt.command === 'get_available_thinking_levels');
}

export function onResponse(evt) {
  // Replayed mutation acknowledgements must not initiate another session rebuild.
  if (evt._replay && ['new_session', 'fork', 'set_model', 'compact'].includes(evt.command)) return;
  if (acceptModelResponse(evt)) return;
  if (!evt.success) {
    if (evt.command !== 'get_available_thinking_levels') {
      toast(evt.error || `命令 ${evt.command} 执行失败`, 'error');
    }
    /* 历史读不出来时对话区会是一片空白 —— 用户会以为「对话丢了」。
     * toast 会自己消失，所以再在对话区留一条**留得住**的说明。
     * （降级路径之一：某些 pi 版本 / 构建可能没有 get_messages。） */
    if (evt.command === 'get_messages') {
      noteLoadFailure(`无法读取历史消息：${evt.error || '上游没有说明原因'}`);
    }
    // 设置类命令失败后，之前乐观更新的显示会与 pi 不一致，回读一次纠正
    if (evt.command === 'set_model') refreshModelState();
    if (evt.command === 'set_thinking_level') readState();
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
      return withNotificationSource('history', () => rebuildFromMessages(d));
    case 'get_available_models':
      return onModels(d);
    case 'get_available_thinking_levels':
      return onThinkingLevels(d);
    case 'set_model':
      toast('已切换到 ' + (d.name || d.id), 'info');
      refreshModelState();
      return;
    case 'new_session':
      afterSessionSwitch();
      toast('已开始新会话（旧会话还在侧栏项目下面，点一下就能切回去）', 'info');
      return;
    case 'fork':
      afterSessionSwitch();
      toast('已从该节点分叉', 'info');
      return;
    case 'compact':
      toast('上下文压缩完成', 'info');
      return;
    case 'export_html':
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
  if (S.submitting || S.fallbackActive) return;
  /* 停止中**一律不发**。这一条是 Stop 语义的核心：停止期间发出去的消息，
   * 会在下面被 `S.streaming` 判成 steer，排进那个还没停干净的旧 run
   * —— 旧任务继续跑、新任务被吞。后端也有同样的闸门（stop_in_progress），
   * 两层都要有：这里是为了不产生一次注定失败的往返与错误提示。 */
  if (S.stopping) return;
  if (!S.hasProject || S.switching || S.bridgeState !== 'ready') {
    toast('还没有选择项目：先在左侧「添加文件夹」选一个目录。', 'info');
    return;
  }
  const text = el.input.value.trim();
  const atts = S.attachments.slice();
  if (!text && !atts.length) return;
  if (S.modelSwitchPending) return toast('正在确认当前模型，请稍后发送。', 'info');
  if (imageInputBlocked() && atts.some(a => a.kind === 'image')) {
    toast('当前模型不支持图片，请移除图片或切换模型。', 'info');
    return;
  }

  const message = buildMessage(text);
  const images = attachmentImages();

  const cmd = { message };
  if (images.length) cmd.images = images;

  S.submitting = true;
  updateSendState();
  const cleanup = () => {
    if (el.input.value.trim() === text) el.input.value = '';
    S.attachments = S.attachments.filter(item => !atts.includes(item));
    renderAttachments();autoGrow();
    if (!el.input.value.trim()) clearDraft();
  };
  try {
    if (!S.streaming && await startFallbackRequest({ type: 'prompt', ...cmd }, cleanup)) return;
    let result;
    if (S.streaming) {
      // 运行中发送 → 作为引导消息插话
      result = await sendCommand({ type: 'steer', ...cmd });
      if (result.ok) toast('已作为引导消息排队', 'info');
    } else {
      result = await sendCommand({ type: 'prompt', ...cmd });
    }
    if (!result?.ok) return; // 失败时保留输入和附件，用户可以重试
    cleanup();
    /* P24：这一条真的发出去了 → 当前身份的草稿作废（不然刷新之后
     * 会把已经发出去的内容再填回输入框，看起来像「发重了」）。 */
    if (!el.input.value.trim()) clearDraft();
  } finally {
    S.submitting = false;
    updateSendState();
  }
}

/* ---------- 停止（Stop = 权威停止，不是「请求一下」）----------
 *
 * 旧实现是「写一条 abort → 立刻 setStatus('已请求停止…')」，而 HTTP 200 只代表
 * 命令写进了 stdin。于是用户看到「已请求停止」就发下一条，新消息被 `S.streaming`
 * 判成 steer 排进旧 run —— 旧任务继续完成，新任务也被执行。
 *
 * 现在：点下 Stop 先进 `S.stopping`（发送键禁用 / Enter 不提交 / 重复点击不重发），
 * 等**后端**拿到 Pi 的权威确认（abort 应答保证会话已空闲）才落回可发送状态。
 * 后端还立着一道屏障：停止未确认期间 prompt / steer / follow_up 一律拒绝
 * （`stop_in_progress`），前端 disabled 只是第一层，不是唯一一层。 */

/** 停止已被后端确认。HTTP 与 SSE 两条路径谁先到都调它，**幂等**。
 *
 *  `confirmStop()` 会 ++stopGeneration：可能还在飞的另一次等待（HTTP 超时前
 *  那一条、或用户点的第二次 Stop）据此认领失败，不会再写一次状态。 */
function applyStopConfirmed() {
  confirmStop();
  /* abort 应答的官方语义是「会话已经空闲」，所以这一刻 streaming 必然为假 ——
   * 不必等 agent_settled。不收口的话，agent_settled 到达前的那几毫秒里
   * 下一条消息仍会被判成 steer。 */
  setStreaming(false);
  setStatus('已停止');
  updateSendState();
}

/** 后端广播的停止状态（SSE）。**只在权威确认时用** —— 它覆盖的是
 *  「HTTP 已经超时、屏障稍后才解除」那条路径。 */
export function onStopState(evt) {
  /* 断线重连会补发 backlog：那时候的「已停止」是历史，不是现在 ——
   * 不能拿它往刚打开的界面上写状态栏。 */
  if (evt?._replay) return;
  if (evt?.state === 'stopped') applyStopConfirmed();
  else if (evt?.state === 'reset') invalidateStop();
}

export async function stop() {
  /* 停止中再点 Stop：**不重发**。后端会用同一个屏障去重（不会写出第二条
   * clear_queue / abort），这里只是不做无意义的第二次往返。 */
  if (S.stopping) return;
  const fallbackWasActive = S.fallbackActive;
  cancelFallback('stop');
  if (!S.streaming && !fallbackWasActive) return;

  const generation = ++S.stopGeneration;
  S.stopping = true;
  /* 这一轮 run 期间用户点过 Stop：之后 provider 报回的 cancelled / aborted
   * 只有在这个标记还在时才按「用户停止」呈现（见 messages.js 的说明）。 */
  S.stopOwnedTurn = true;
  updateSendState();
  /* 「正在停止…」而不是「已请求停止…」—— 后者会让用户以为已经停了。 */
  setStatus('正在停止…');

  const result = await sendCommand({ type: 'abort' });
  /* 代对不上 = 这次停止已经作废（换了工作区 / Pi 换代 / 又点了一次 /
   * SSE 已经先行确认）。迟到的应答不许再动界面。 */
  if (S.stopGeneration !== generation) return;

  if (result?.ok) return applyStopConfirmed();

  /* 浏览器取消确认失败：Pi 那边**照旧收到 abort 了**（两件事，不能因为浏览器
   * 不可用就不停 Pi），所以保持 stopping，等屏障解除。错误提示由 sendCommand
   * 统一弹（安全文案来自后端），这里不覆盖状态栏。 */
  if (result?.code === 'browser_cancel_unconfirmed') return updateSendState();

  if (result?.code === 'stop_unconfirmed' || result?.network) {
    /* 等不到 Pi 的权威应答：**不解除保护**。宁可暂时不让发，也不把新任务
     * 塞进旧 run。后台屏障仍然挂着，后端的 stop_state 事件会来收口；
     * 用户仍可重启 Pi 作为恢复路径。 */
    setStatus('停止尚未得到 Pi 确认，请等待或重启 Pi');
    return updateSendState();
  }

  /* 其余情况（bridge 已换代 / 环境不允许发出停止）：这次停止不成立，
   * 放回可发送状态。 */
  invalidateStop();
  updateSendState();
}

export const newSession = () => sendCommand({ type: 'new_session' });

/* 会话列表的刷新回调。
 *
 * 用注册而不是 import：sessions.js 要 import 本模块的 afterSessionSwitch，
 * 本模块再 import 回去就成环了（ESM 链接器会把环断掉，症状是「某个导出是 undefined」）。
 * 由 app.js 在装配阶段把 sessions.js 的 refreshSidebarSessions 注进来。 */
let refreshSessionList = () => {};
export function setSessionListRefresh(fn) {
  refreshSessionList = typeof fn === 'function' ? fn : () => {};
}

/**
 * 会话换掉之后要做的界面收尾：回到 Chat，清空对话区与变更账本，
 * 再 boot() 按新会话重建。
 *
 * 抽出来是因为**有三条路径**都会换会话：pi 主动报的 `new_session` / `fork`
 * （走 onResponse）、以及用户在侧栏点某条旧会话（走后端 HTTP，不经过这里）。
 * 三条路径必须做同一件事 —— 否则切完会话界面还挂着上一个会话的消息，
 * 看起来就像「切了但没生效」。
 *
 * ⚠️ **必须顺带重画侧栏的会话列表**：列表只在 renderProjects() 里渲染，
 * 不在这里刷的话它会停在旧状态 —— 旧会话仍然带着 current 标记，而当前项是
 * 不给点的，用户就再也回不到那条对话（这正是「开新对话后旧对话消失」的根因）。
 */
export function afterSessionSwitch() {
  cancelFallback('session-switch');
  pendingModel();
  modelRefresh = null;
  ++modelGeneration;
  stateReads.clear();
  activeModelSwitch = null;
  queuedModelSwitch = null;
  showChat({ focusComposer: true });
  clearThread();
  // 换了一条工作线，上一段的文件变更记录不再适用。
  // 注意 fork 也不清：分叉不改磁盘，之前改过的文件依然处于改动状态。
  clearChanges();
  refreshSessionList();
  /* P24：换会话 = 换草稿身份。**立刻对齐一次**（把上一条会话里没发出去的字
   * 归到上一条会话的 key，并把新会话的草稿填回来），而不是等 get_state
   * 回来才动 —— 那中间用户可能已经开始打字了。 */
  draftSync();
  setTimeout(boot, 250);
}

export const forkFrom = (entryId) => sendCommand({ type: 'fork', entryId });

export async function exportHtml() {
  const result = await downloadSessionHtml();
  toast(result.ok ? '会话 HTML 已下载' : result.error || '导出失败', result.ok ? 'info' : 'error');
  return result;
}

export const setSessionName = (name) => sendCommand({ type: 'set_session_name', name });

export function compactNow() {
  sendCommand({ type: 'compact' });
  toast('已请求压缩上下文', 'info');
}

/* 模型与思考档位完全由 Pi 确认后回读。 */
export function setModel(provider, modelId, options = null) {
  const fallbackOwner = options && typeof options === 'object' ? options.fallbackOwner : null;
  if (!fallbackOwner) cancelFallback('manual-model');
  modelRefresh?.completion?.resolve?.(false);
  queuedModelSwitch?.resolve?.(false);
  pendingModel();
  modelRefresh = null;
  const generation = ++modelGeneration;
  stateReads.clear();
  let resolve, timer;
  const completed = new Promise(r => { resolve = value => { clearTimeout(timer); r(value); }; });
  const request = { id: modelRequestPrefix + generation + '-set', provider, modelId, workspace: S.workspaceGeneration, resolve, fallbackOwner };
  if (fallbackOwner) timer = setTimeout(() => {
    resolve(false);
    if (activeModelSwitch === request) {
      activeModelSwitch = null;
      if (queuedModelSwitch) { const next = queuedModelSwitch; queuedModelSwitch = null; sendModelSwitch(next); }
      else refreshModelState();
    } else if (modelRefresh?.completion?.resolve === resolve) refreshModelState();
  }, 30000);
  if (activeModelSwitch && activeModelSwitch.workspace === S.workspaceGeneration) queuedModelSwitch = request;
  else {
    queuedModelSwitch = null;
    sendModelSwitch(request);
  }
  return completed;
}

setFallbackModelSwitcher((identity, fallbackOwner) => setModel(identity.providerId, identity.modelId, { fallbackOwner }));

export function setThinkingLevel(level) {
  if (S.modelSwitchPending || !S.thinkingLevels.includes(level) || !S.thinkingLevels.some(v => v !== 'off')) return;
  sendCommand({ type: 'set_thinking_level', level });
  readState();
}
