/* Pi GUI — 前端入口。
 *
 * 这个文件只做三件事：
 *   1. 装配：把各模块需要的回调接上（分叉、流式开关）
 *   2. 事件路由：SSE 收到的事件按 type 分发到对应模块
 *   3. 绑定与启动：DOM 事件、快捷键、首次加载
 * 具体逻辑都在同目录的模块里 —— 这个文件应该越薄越好。
 *
 * 数据流：SSE 收 pi 的 RPC 事件 → 渲染；POST /api/command 发命令。
 * 关键约定（来自 pi docs/rpc.md）：
 *   - message_update 只给 delta，不带累积快照；需要按 contentIndex 自行组装，
 *     并以 message_end.message 为最终权威。
 *   - tool_execution_update.partialResult 是「累积」值，直接替换显示即可。
 *   - 权限确认走 extension_ui_request / extension_ui_response 子协议。
 */

import { $, el, S, invalidateStop } from './state.js';
import { fmt } from './util.js';
import { modelIdentity, modelCapabilitySummary } from './model-capabilities.js';
import { observeFallbackEvent, cancelFallback } from './fallback.js';
import { sendCommand } from './api.js';
import { configureRuntimeSessions, observeRuntimeEvent } from './runtime-sessions.js';
import { observeWebEvent } from './web-access.js';
import { observeSubagentEvent } from './subagents.js';
import { observeMemoryEvent } from './memory.js';
import { observeBrowserEvent } from './browser.js';
import { observeGuiBrowserEvent, initGuiBrowserState } from './gui-browser-capabilities.js';
import { observeMcpEvent } from './mcp-observer.js';
import { cancelPendingApprovals, expireAll, observeApprovalEvent } from './approval.js';
import { acceptSubagentEvent } from './subagent-capabilities.js';
import { toast, withNotificationSource } from './ui/toast.js';
import { closePop, currentAnchor, openPop, pop, popItem, popTitle, popVisible } from './ui/popover.js';
import { closeModal, confirmModal, openModal } from './ui/modal.js';
import { applyProjectState, loadStatus, setBridgeState, setBridgeReconciler, setTransportOnline, setStatus, setTitleText } from './shell.js';
import { createBridgeRecovery } from './bridge-recovery.js';
import { samePath } from './util.js';
import { autoGrow, initComposerLayout, updateSendState } from './composer.js';
import {
  boot,
  compactNow,
  exportHtml,
  forkFrom,
  newSession,
  onResponse,
  onStopState,
  setModel,
  setSessionName,
  setSessionListRefresh,
  setThinkingLevel,
  refreshModelState,
  stop,
  submit,
} from './rpc.js';
import {
  dropTrailingError,
  onMessageEnd,
  onMessageStart,
  onMessageUpdate,
  onSettled,
  interruptActive,
  setStreaming,
  syncWelcome,
} from './messages.js';
import { onToolEnd, onToolStart, onToolUpdate } from './tools.js';
import { openBranchPanel, setForkHandler } from './tree.js';
import { openCtxTip, renderCtxChip, onTurnUsage } from './usage.js';
import { handleFiles, renderAttachments } from './attachments.js';
import { loadProjects, openDirPicker, setSessionsSlot, setProjectSessionActions, flushProjectSessionAction } from './projects.js';
import { loadProviders, openProvidersPanel, openProviderAuthPanel, reloadPi } from './providers.js';
import { applyProjectPreferences, openProjectSettings } from './project-config.js';
import { loadGitStatus, openChangesPanel, refreshGitNow } from './git.js';
import { loadExtensionsBadge, openExtensions } from './extensions.js';
import { resetDrift } from './schema-drift.js';
import { loadPlannerBadge, openPlanner } from './planner.js';
import { mountSessionPlans } from './session-plans.js';
import { renderSidebarSessions, refreshSidebarSessions, expandSidebarSessions, createSidebarPreviewRow, openSidebarPreviewSession } from './sessions.js';
import { initConversationNav } from './conversation-nav.js';
import { openDiagnostics, copyDiagnosticsSummary } from './diagnostics.js';
import { initUpdateAuto } from './update.js';
import { initPiUpdateAuto } from './pi-update.js';
import { showChat, showRuntimeConversation, runtimeViewElement } from './ui/workspace-surface.js';
import { createRuntimeConversation } from './runtime-conversation.js';
import { createRuntimeSecondary } from './runtime-secondary.js';
import { setGitConversationScope, gitConversationScope } from './api.js';
import { setRuntimeFocusHandler } from './runtime-nav.js';
import { refreshRuntimeResources } from './runtime-resources.js';
/* P24：日常使用面 —— 命令面板、快捷键注册表、草稿恢复、状态条。
 * 全部由这一层装配：它们要调的动作都在别的模块里，装配层是唯一同时认识
 * 「谁提供动作」与「谁需要动作」的地方。 */
import { registerShortcut, installShortcuts, assertNoConflicts } from './shortcuts.js';
import { openShortcutHelp } from './ui/shortcut-help.js';
import { openPalette, paletteOpen } from './palette.js';
import { defineCommands, setDynamicCommands } from './palette-model.js';
import { initDraft, draftSync, clearDraft } from './draft.js';
import { startupNotice, NOTICE_ACTIONS } from './status-copy.js';
import { showNotice, hideNotice } from './ui/notice.js';
import { knownSessions, switchToSessionById } from './sessions.js';
import { initRightPane } from './right-pane.js';
import { attachBrowserPane, isBrowserAvailable } from './browser-pane.js';
import { configureSecondaryPane } from './ui/secondary-surface.js';
import { openProcessPanel as openClassicProcessPanel } from './process-panel.js';
import { openAppUpdates } from './settings.js';

/* ---------- 装配 ---------- */

// tree.js 的节点点击要触发分叉，但 tree.js 不能 import rpc.js（会成环），
// 所以在这里把回调递进去。
setForkHandler(forkFrom);

/* 会话列表挂在当前项目那一行下面（参考 Codex，不单开窗口）。
 * projects.js 不 import sessions.js，由这里把渲染函数递进去。 */
setSessionsSlot(renderSidebarSessions);

/* P32.4-B：侧栏点一条并行会话 → 中央切到它。
 * focus 本身由 runtime-nav 发（带 captured owner），这里只负责把中央视图换过去；
 * 切回经典会话/项目时由 showChat() 换回来。 */
const runtimeConversation = createRuntimeConversation({ host: runtimeViewElement(), openBrowser: () => runtimeSecondary.openBrowser(), openProcesses: () => runtimeSecondary.openProcesses() });
const conversationScopeActive = () => Boolean(gitConversationScope());
const focusRuntimeConversation = conversationId => {
  runtimeConversation.show(conversationId);
  showRuntimeConversation();
  runtimeSecondary.focus(conversationId);
  /* P32.4-C：Changes 跟随 focused 会话。只设 conversationId ——
   * 工作区根由后端从 registry 记录解析，前端不传路径。 */
  setGitConversationScope(conversationId);
  void refreshGitNow();
};
setRuntimeFocusHandler(focusRuntimeConversation);

/* 中央离开并行会话（回到经典 chat / 工作区）时，Changes 也要跟着离开那个会话的作用域。 */
document.addEventListener('pi-gui:workspace-view', event => {
  if (event.detail?.view === 'runtime') return;   // 具体会话由上面的 focus handler 设定
  if (!conversationScopeActive()) return;
  runtimeSecondary.leave();
  setGitConversationScope(null);
  void refreshGitNow();
});
setProjectSessionActions({ newSession, search: openSessionSearch, previewRow: createSidebarPreviewRow, openPreviewSession: openSidebarPreviewSession });

/* 会话一变（新开 / 分叉 / 切换）就要重画侧栏那块列表。
 * rpc.js 不能 import sessions.js（sessions.js 已经 import 了 rpc.js，会成环），
 * 所以同样由装配层把回调递进去。 */
setSessionListRefresh(refreshSidebarSessions);

/* 会话内提问导航：只装配一次（挂 scroll / resize / ResizeObserver）。
 * 标记本身由 messages.js 在渲染消息时注册。 */
initConversationNav();

/* P7：会话标题旁的「关联任务」窄条。这里只把容器交给它 —— 拉数据与显隐
 * 由 session-plans.js 自己决定（没有关联时整块 hidden，不占位）。 */
mountSessionPlans($('sessionPlans'));

/* 右栏工作区（P26）。
 * 外壳是通用的（right-pane.js），这一版只往里装「内置浏览器」一面。
 * 网页版（浏览器里跑 npm start）没有 preload 桥 —— 那时 browserPane 为 null，
 * 入口按钮直接不显示，而不是画一个点了没反应的按钮。 */
const rightPane = initRightPane();
const runtimeSecondary = rightPane ? createRuntimeSecondary({ pane: rightPane }) : null;
const openProcessPanel = () => conversationScopeActive() ? runtimeSecondary?.openProcesses() : openClassicProcessPanel();
configureRuntimeSessions({ pane: rightPane, focusView: focusRuntimeConversation, openBrowser: () => runtimeSecondary?.openBrowser() });
configureSecondaryPane(rightPane);
const browserPane = rightPane && isBrowserAvailable() ? attachBrowserPane(rightPane) : null;
initGuiBrowserState();

const btnBrowser = $('btnBrowser');
if (btnBrowser) {
  if (!browserPane) {
    btnBrowser.hidden = true; // 网页版：没有内置浏览器这回事
  } else {
    btnBrowser.addEventListener('click', () => conversationScopeActive() ? runtimeSecondary?.openBrowser() : browserPane.toggle());
    /* 右栏可能从内部（工具栏的 ×）关掉，只有它自己知道 —— 所以入口按钮的
     * 状态跟着事件走，不去猜。 */
    document.addEventListener('pi-gui:right-pane', (e) => {
      const open = e.detail?.open === true && e.detail?.surface === 'browser';
      btnBrowser.setAttribute('aria-pressed', open ? 'true' : 'false');
      btnBrowser.classList.toggle('is-active', open);
    });
  }
}

/* ---------- SSE ---------- */

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => setTransportOnline(true);
  es.onerror = () => setTransportOnline(false);
  es.onmessage = (e) => {
    let evt;
    try {
      evt = JSON.parse(e.data);
    } catch {
      return;
    }
    // 断线重连时服务端会补发历史事件，用序号去重
    if (typeof evt._seq === 'number') {
      if (evt._seq <= S.seq) return;
      S.seq = evt._seq;
    }
    handle(evt);
  };
}

function handle(evt) {
  return withNotificationSource(evt._replay ? 'history' : 'live', () => handleEvent(evt));
}

function handleEvent(evt) {
  if (['runtime_event', 'runtime_state', 'runtime_closed'].includes(evt.type)) { observeRuntimeEvent(evt); return; }
  if (evt.type === 'bridge_status' || evt.type === 'bridge_snapshot') {
    if (evt._replay) return;
    return reconcileBridgeSnapshot(evt);
  }
  if (!S.hasProject && evt.type !== 'bridge_status' && Number.isInteger(evt.bridgeRun)) return;
  if (!acceptSubagentEvent(evt, S)) return;
  if (Number.isInteger(evt.bridgeRun) && Number.isInteger(S.bridgeRun) && evt.bridgeRun < S.bridgeRun) return;
  if (evt.type !== 'bridge_status' && Number.isInteger(evt.bridgeRun)) {
    if (evt.bridgeRun !== S.bridgeRun) return;
  }
  if (evt.legacyOwner && evt.bridgeRun === S.bridgeRun) S.legacyOwner = evt.legacyOwner;
  if (evt.type !== 'bridge_status') { observeWebEvent(evt); observeSubagentEvent(evt); observeMemoryEvent(evt); observeBrowserEvent(evt); observeGuiBrowserEvent(evt); observeMcpEvent(evt); observeApprovalEvent(evt); }
  observeFallbackEvent(evt);
  switch (evt.type) {
    case 'bridge_status':
      return onBridge(evt);
    case 'bridge_stderr':
      return onStderr(evt);
    case 'bridge_parse_error':
      return;
    case 'project_config_notice':
      // 后端在同步项目指令、应用项目配置时的警告（写入失败、版本不认识…）
      return toast(evt.message, evt.level === 'error' ? 'error' : 'warn');
    case 'execution_event':
      /* Planner / Agent 编排的执行事件。**刻意不并进主对话时间线** ——
       * 那是另一个进程在另一个工作目录里干的事，混进当前聊天会让人以为
       * 是自己这轮对话的一部分（规格 §11 明确要求分开）。
       * 但它复用同一套渲染语言（状态点 / 工具名 / 耗时），并且事件里带
       * planId / taskId / agent，所以界面上能看清「谁在跑」。 */
      return onExecutionEvent(evt);
    case 'response':
      onResponse(evt);
      if (S.syncPending && evt.success && (evt.command === 'get_state' || evt.command === 'get_messages')) {
        S.syncPending[evt.command === 'get_state' ? 'state' : 'messages'] = false;
        if (!S.syncPending.state && !S.syncPending.messages) {
          S.switching = false;
          S.syncPending = null;
          applyProjectState();
          flushProjectSessionAction();
        }
      }
      return;
    case 'agent_start':
      return setStreaming(true);
    case 'agent_end':
      return;
    case 'agent_settled':
      /* Pi 已经收尾：还挂在 pending 的 approval 对话框不可能再被应答（Pi 侧
       * 在 abort/timeout 时已自行 resolve），本地作废，别留一张永远等的卡。 */
      expireAll('agent-settled');
      /* ⚠️ 这里**不动 S.stopping**。agent_settled 与 abort 应答的先后不确定；
       * 它先到时如果就把 stopping 落下去，用户能在屏障还挂着的时候发新消息
       * —— 那正是要修的 bug。停止的收口只有 stop_state 事件与 HTTP 应答。 */
      return onSettled();
    case 'stop_state':
      /* 后端停止屏障的状态广播（见 server/rpc-bridge.js）。它覆盖的是
       * 「HTTP 等超时了、屏障稍后才解除」那条路径。 */
      return onStopState(evt);
    case 'message_start':
      return onMessageStart(evt);
    case 'message_update':
      if (evt.usage) onTurnUsage(evt.usage, { source: 'message_update' });
      return onMessageUpdate(evt);
    case 'message_end':
      if (evt.message?.usage) {
        onTurnUsage(evt.message.usage, {
          provider: evt.message.provider,
          model: evt.message.model,
          source: 'message_end',
        });
      }
      return onMessageEnd(evt);
    case 'tool_execution_start':
      return onToolStart(evt);
    case 'tool_execution_update':
      return onToolUpdate(evt);
    case 'tool_execution_end':
      return onToolEnd(evt);
    case 'extension_ui_request':
      return onUiRequest(evt);
    case 'compaction_start':
      return setStatus('正在压缩上下文…');
    case 'compaction_end':
      return setStatus('');
    case 'auto_retry_start':
      // pi 会为每次重试单独发一轮 message_start / message_end，上一次那轮的
      // 错误卡片和已经空掉的外壳一起撤掉，否则重试成功后对话区里会留下
      // 一张失败卡片 + 一串没有正文的空白「Pi」（见 dropTrailingError）
      dropTrailingError();
      return setStatus(`请求失败，第 ${evt.attempt}/${evt.maxAttempts} 次重试…`);
    case 'auto_retry_end':
      return setStatus('');
    case 'extension_error':
      return toast(`扩展错误：${evt.error}`, 'error');
    default:
      return;
  }
}

let lastBridgeError = '';
/* 最近一次启动失败的原因与下一步（后端 bridge_status.error 与 .hint）。
 * 只活在内存里：它是「当前这个进程为什么没起来」的说明，不属于任何持久状态。 */
let bridgeErrorText = '';
let bridgeHintText = '';

/* ---------- P24：状态条（启动 / 连接 / 兼容）----------
 *
 * toast 是一次性的，状态是持续的：pi 起不来时用户随时回来都该看到同一句说明
 * 与同一个下一步。这里只做「把状态翻译成一条 notice」，具体文案在 status-copy.js。
 * 动作一律指向既有入口（重启走 restartPi、诊断走 openDiagnostics），
 * **不自动修复任何东西**（不装、不改 PATH、不删配置）。 */
const NOTICE_HANDLERS = {
  resync: () => loadStatus(),
  restart: () => restartPi(),
  diagnostics: () => openDiagnostics(),
};

function noticeActions(ids) {
  return (ids || [])
    .map((id) => {
      const meta = NOTICE_ACTIONS[id];
      const run = NOTICE_HANDLERS[id];
      return meta && run ? { label: meta.label, title: meta.title, run } : null;
    })
    .filter(Boolean);
}

function syncNotice() {
  const model = startupNotice({
    bridgeState: S.bridgeState,
    bridgeError: bridgeErrorText,
    bridgeHint: bridgeHintText,
    hasProject: S.hasProject,
    compat: S.compat,
    /* 维护态说哪一句话由 reason 决定（Pi 自更新 vs 正在安装扩展）。 */
    maintenanceReason: S.maintenanceReason,
    recoveryOverdue,
  });
  if (!model) {
    hideNotice();
    return false;
  }
  showNotice({ ...model, actions: noticeActions(model.actions) });
  return true;
}

let recoveryOverdue = false;
let lastReadyRun;
const bridgeRecovery = createBridgeRecovery({
  readStatus: () => loadStatus(),
  reconcile: snapshot => reconcileBridgeSnapshot(snapshot),
  overdue: value => { recoveryOverdue = value; syncNotice(); },
});
setBridgeReconciler(reconcileBridgeSnapshot);

export function reconcileBridgeSnapshot(snapshot) {
  if (snapshot.bridgeInstance && S.bridgeInstance && snapshot.bridgeInstance !== S.bridgeInstance
    || Number.isInteger(snapshot.bridgeRun) && Number.isInteger(S.bridgeRun) && snapshot.bridgeRun !== S.bridgeRun
    || ['starting', 'restarting', 'exited', 'error', 'no-project', 'maintenance'].includes(snapshot.bridgeState || snapshot.state)) {
    cancelFallback('bridge-lifecycle');
    /* 换了进程/换了一代执行线：还在飞的停止应答已经不属于任何东西，
     * 覆盖它是错的。后端同样会在这些时刻解除屏障（releaseStop）。 */
    invalidateStop();
  }
  const evt = { ...snapshot, type: 'bridge_status', state: snapshot.bridgeState || snapshot.state,
    error: snapshot.bridgeError ?? snapshot.error, hint: snapshot.bridgeHint ?? snapshot.hint,
    reason: snapshot.maintenance?.reason ?? snapshot.reason };
  if (!['no-project', 'starting', 'ready', 'restarting', 'maintenance', 'exited', 'error'].includes(evt.state)) return;
  if (typeof snapshot.bridgeInstance === 'string' && snapshot.bridgeInstance !== S.bridgeInstance) {
    // Only a current snapshot may establish a new backend epoch. Counters are
    // monotonic inside that epoch, not across GUI server process restarts.
    const authoritative = snapshot.type === 'bridge_snapshot' || (!snapshot.type && snapshot.bridgeState);
    if (S.bridgeInstance && !authoritative) return;
    S.bridgeInstance = snapshot.bridgeInstance;
    S.bridgeRun = null; S.bridgeRevision = null; S.seq = 0;
    lastReadyRun = undefined;
  }
  if (Number.isInteger(evt.bridgeRun) && Number.isInteger(S.bridgeRun) && evt.bridgeRun < S.bridgeRun) return;
  if (Number.isInteger(evt.bridgeRevision) && Number.isInteger(S.bridgeRevision) && evt.bridgeRevision < S.bridgeRevision) return;
  if (!S.hasProject && S.desiredCwd === null && evt.cwd) return;
  if (S.switching && evt.cwd && !samePath(evt.cwd, S.desiredCwd)) return;
  if (Number.isInteger(evt.bridgeRun)) S.bridgeRun = evt.bridgeRun;
  if (Number.isInteger(evt.bridgeRevision)) S.bridgeRevision = evt.bridgeRevision;
  if (typeof evt.cwd === 'string') S.cwd = evt.cwd;
  if (snapshot.legacyOwner) S.legacyOwner = snapshot.legacyOwner;
  S.hasProject = evt.hasProject ?? Boolean(S.cwd);
  // Classic children share the backend budget with independent conversations.
  // Refresh only after this snapshot passed the bridge authority guards.
  void refreshRuntimeResources().catch(() => {});
  bridgeRecovery.observe({ ...evt, hasProject: S.hasProject });
  observeWebEvent(evt);
  observeSubagentEvent(evt);
  observeMemoryEvent(evt);
  observeBrowserEvent(evt);
  observeGuiBrowserEvent(evt);
  observeMcpEvent(evt);
  observeApprovalEvent(evt);
  switch (evt.state) {
    case 'starting':
      /* P23：bridge 生命周期一变，前端看到的 schema 漂移也不再属于当前运行 ——
       * 与各 feature 的运行观察同一条纪律（旧 run 的结论不许留在表里）。 */
      resetDrift();
      setBridgeState('starting');
      return syncNotice();
    case 'ready':
      if (lastReadyRun === S.bridgeRun && (Number.isInteger(S.bridgeRun) || S.bridgeState === 'ready')) {
        setBridgeState('ready');
        return syncNotice();
      }
      lastReadyRun = S.bridgeRun;
      if (Number.isInteger(evt.bridgeRun)) S.bridgeRun = evt.bridgeRun;
      S.cwd = evt.cwd || S.cwd;
      S.hasProject = Boolean(S.cwd);
      S.models = [];
      lastBridgeError = '';
      bridgeErrorText = '';
      bridgeHintText = '';
      setStatus('');
      setBridgeState('ready');
      hideNotice();
      /* pi 起来了 → 会话身份可能刚变（新 cwd / 新会话），草稿要对齐。
       * 这个调用与「会话 id 变化时」那一条是同一个函数，重复调用无副作用。 */
      draftSync();
      loadExtensionsBadge();
      loadPlannerBadge();
      boot();
      /* 项目偏好要在 pi 起来之后再落到会话上。
       * 模型不能当启动参数传（过期引用会让 pi 退出，见 project-config.js 的说明），
       * 只能等 get_available_models 回来核对过再 set_model —— 所以它排在这里，
       * 而不是跟 --thinking 一起进启动参数。 */
      applyProjectPreferences();
      if (S.switching) {
        const generation = S.workspaceGeneration;
        setTimeout(() => {
          if (S.switching && generation === S.workspaceGeneration && S.bridgeState === 'ready') {
            S.switching = false;
            S.syncPending = null;
            applyProjectState();
            setStatus('状态同步超时。可以重试切换项目或重启 pi。');
          }
        }, 12000);
      }
      return;
    case 'exited':
      setBridgeState('exited', `pi 已退出 (${evt.code ?? evt.signal ?? '?'})`);
      interruptActive();
      return syncNotice();
    case 'maintenance':
      /* 短时维护态：Pi 正在被官方 self-update 替换（`server/pi-update.js`），
       * 或者正在跑一次 Capability 一键安装（`server/capability-install.js`）。
       * **这不是崩溃**：进程是我们自己停的，停之前后端已经拒绝了新命令。
       *
       * 所以这里刻意**不**做「exited」那三件事：不清当前会话、不弹
       * 「pi 已退出」、不把这一轮说成失败。只把状态条换成一句维护说明，
       * 让用户知道为什么这会儿发不出消息。维护结束后端会推 ready。
       * `evt.reason` 决定说哪一句 —— 装扩展被说成「正在更新 Pi」是在骗人。 */
      setBridgeState('maintenance', '', typeof evt.reason === 'string' ? evt.reason : null);
      return syncNotice();
    case 'restarting':
      setBridgeState('restarting');
      return syncNotice();
    case 'no-project':
      /* 后端明确告知「没有项目所以没启动 pi」。
       * 这不是错误状态 —— 底部连接指示不能说「连接断开」，那会让用户以为网络坏了。
       * 传空 kind 用 .conn 的默认灰点：中性、不刺眼。 */
      S.cwd = '';
      S.hasProject = false;
      S.switching = false;
      S.syncPending = null;
      setBridgeState('no-project');
      return hideNotice();
    case 'error': {
      setBridgeState('error');
      if (S.switching) {
        S.switching = false;
        S.syncPending = null;
        applyProjectState();
      }
      bridgeErrorText = evt.error || '';
      bridgeHintText = evt.hint || '';
      const message = [evt.error, evt.hint].filter(Boolean).join('\n');
      setStatus(message);
      /* P24：这一条现在有**常驻**状态条了（底部连接指示 + 输入区也各有一份说明）。
       * 再弹一个一次性 toast 就是同一件事说三遍 —— 只在没有常驻条时兜底提醒。 */
      const permanent = syncNotice();
      if (!permanent && message !== lastBridgeError) toast(message, 'error');
      lastBridgeError = message;
      return;
    }
    default:
      return;
  }
}

function onStderr(evt) {
  const text = (evt.text || '').trim();
  if (!text) return;
  if (/error|enoent|not found|failed/i.test(text)) {
    setStatus(text.slice(0, 180));
  }
}

/* ---------- 扩展 UI ---------- */
/* 对话框方法（select / confirm / input / editor）**不在这里**处理：
 * 它们是「阻塞等待用户决定」的 approval，统一走 approval.js
 *（handle() 已把每条事件分发过去）。这里只处理 fire-and-forget 方法 ——
 * 它们没有应答，也就没有可追踪的生命周期。 */
function onUiRequest(evt) {  switch (evt.method) {
    case 'notify':
      return toast(evt.message, evt.notifyType === 'error' ? 'error' : evt.notifyType === 'warning' ? 'warn' : 'info');
    case 'setStatus':
      return setStatus(evt.statusText || '');
    case 'setTitle':
      return setTitleText(evt.title);
    default:
      return;
  }
}

/* ---------- 选择器 ---------- */

const expandedModelProviders = new Set();
const knownModelProviders = new Set();

function openModelPicker() {
  if (!S.models.length) {
    sendCommand({ type: 'get_available_models' });
    toast('正在获取模型列表…', 'info');
    return;
  }

  const { modelId: currentId, providerId: currentProvider } = modelIdentity(S.state?.model);

  pop.innerHTML = '';
  pop.appendChild(popTitle('选择模型'));

  // 按供应商分组，和 pi 的模型来源一一对应
  const groups = new Map();
  for (const m of S.models) {
    const key = m.providerId || m.provider || '默认';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  for (const provider of knownModelProviders) {
    if (!groups.has(provider)) {
      knownModelProviders.delete(provider);
      expandedModelProviders.delete(provider);
    }
  }
  let groupIndex = 0;
  for (const [provider, list] of groups) {
    const isCurrent = currentProvider ? provider === currentProvider
      : list.some((m) => currentId ? (m.id || m.name) === currentId : m.name === el.modelText.textContent);
    knownModelProviders.add(provider);
    if (isCurrent) expandedModelProviders.add(provider);
    const group = document.createElement('div');
    group.className = 'pop-model-group';
    group.dataset.provider = provider;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'pop-provider';
    const models = document.createElement('div');
    models.className = 'pop-provider-models';
    models.id = 'model-provider-' + (++groupIndex);
    header.setAttribute('aria-controls', models.id);
    const chev = document.createElement('span');
    chev.className = 'pop-provider-chev';
    chev.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'pop-provider-name';
    name.textContent = provider;
    const count = document.createElement('span');
    count.className = 'pop-provider-count';
    count.textContent = String(list.length);
    const syncExpanded = () => {
      const expanded = expandedModelProviders.has(provider);
      header.setAttribute('aria-expanded', String(expanded));
      models.hidden = !expanded;
      chev.textContent = expanded ? '⌄' : '›';
    };
    syncExpanded();
    header.append(chev, name, count);
    header.addEventListener('click', () => {
      if (expandedModelProviders.has(provider)) expandedModelProviders.delete(provider);
      else expandedModelProviders.add(provider);
      syncExpanded();
      openPop(el.btnModel, { model: true });
      header.focus();
    });
    group.append(header, models);
    pop.appendChild(group);
    for (const m of list) {
      const id = m.modelId || m.id || m.name;
      const isCur = currentProvider ? (m.providerId || m.provider) === currentProvider && id === currentId
        : currentId ? id === currentId : m.name === el.modelText.textContent;
      models.appendChild(
        popItem({
          label: m.name || id,
          sub: modelCapabilitySummary(m).text,
          on: isCur,
          onClick: () => {
            closePop({ restoreFocus: true });
            // 实测：pi 的 set_model 需要 provider + modelId 两个字段，
            // 只传 model 会报 "Model not found: <provider>/undefined"
            setModel(m.providerId || m.provider, id);
          },
        })
      );
      models.lastElementChild.title = modelCapabilitySummary(m).title;
    }
  }

  const foot = document.createElement('div');
  foot.className = 'pop-foot';
  const t = document.createElement('span');
  t.textContent = '共 ' + S.models.length + ' 个可用模型';
  foot.appendChild(t);
  pop.appendChild(foot);

  openPop(el.btnModel, { model: true });
}

function openThinkPicker() {
  if (S.modelSwitchPending) {
    toast('正在读取当前模型支持的思考等级…', 'info');
    return;
  }
  if (!S.thinkingLevels.length) {
    toast('Pi 未提供可选思考等级。', 'info');
    return;
  }

  const current = (S.state?.thinkingLevel || el.thinkText.textContent.replace('思考 ', '')).trim();

  const DESC = {
    off: '不思考，最快',
    minimal: '最少思考',
    low: '轻量思考',
    medium: '中等思考',
    high: '深度思考',
    max: '最大思考预算',
  };

  pop.innerHTML = '';
  pop.appendChild(popTitle('思考等级'));

  for (const lv of S.thinkingLevels) {
    const name = typeof lv === 'string' ? lv : lv.level || lv.name;
    pop.appendChild(
      popItem({
        label: name,
        sub: DESC[name] || '',
        on: name === current,
        onClick: () => {
          closePop({ restoreFocus: true });
          setThinkingLevel(name);
        },
      })
    );
  }

  openPop(el.btnThink);
}

/* ---------- 会话统计 / 重命名 / 更多 ---------- */

function renderStatsPanel(card, s) {
  const t = s.tokens || {};
  const ctx = s.contextUsage || {};
  const rows = [
    ['用户消息', s.userMessages],
    ['助手消息', s.assistantMessages],
    ['工具调用', s.toolCalls],
    ['输入 token', t.input],
    ['输出 token', t.output],
    ['缓存读取', t.cacheRead],
    ['缓存写入', t.cacheWrite],
    ['上下文占用', ctx.tokens == null ? '—' : `${fmt(ctx.tokens)} / ${fmt(ctx.contextWindow)}`],
    ['累计成本', typeof s.cost === 'number' ? '$' + s.cost.toFixed(4) : '—'],
  ];

  if (S.localUsage?.lastTurn?.reasoningTokens != null) {
    rows.push(['思考 token', S.localUsage.lastTurn.reasoningTokens]);
  }

  if (S.remoteQuota) {
    const q = S.remoteQuota;
    rows.push(['模型供应商', q.providerId || '—']);
    if (q.status === 'ok') {
      if (q.balance && typeof q.balance.amount === 'number') {
        const cur = q.balance.currency === 'CNY' ? '¥' : '$';
        rows.push(['远端额度', `${cur}${q.balance.amount.toFixed(2)}`]);
      }
    } else if (q.status === 'unsupported') {
      rows.push(['远端额度', '不支持']);
    } else if (q.status === 'auth_error') {
      rows.push(['远端额度', '未认证']);
    } else if (q.status === 'unavailable') {
      rows.push(['远端额度', '不可用']);
    } else {
      rows.push(['远端额度', '查询失败']);
    }
  }

  const box = document.createElement('div');
  box.className = 'stat-rows';
  for (const [k, v] of rows) {
    const r = document.createElement('div');
    const a = document.createElement('span');
    a.textContent = k;
    const b = document.createElement('b');
    b.textContent = v == null || v === '' ? '—' : String(v);
    r.append(a, b);
    box.appendChild(r);
  }
  card.appendChild(box);

  if (s.sessionFile) {
    const f = document.createElement('div');
    f.className = 'selected-path';
    f.textContent = s.sessionFile;
    card.appendChild(f);
  }
}

function openStatsPanel() {
  let slot = null;

  openModal((card, close) => {
    card.classList.add('wide');
    const h = document.createElement('h3');
    h.textContent = '会话统计';
    card.appendChild(h);

    slot = document.createElement('div');
    slot.innerHTML = '<div class="hint-empty">加载中…</div>';
    card.appendChild(slot);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const done = document.createElement('button');
    done.className = 'btn primary';
    done.textContent = '关闭';
    done.onclick = close;
    actions.appendChild(done);
    card.appendChild(actions);
  });

  S.onStats = (d) => {
    if (!slot) return;
    slot.innerHTML = '';
    renderStatsPanel(slot, d);
  };
  sendCommand({ type: 'get_session_stats' });
}

function renameSession() {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = '重命名会话';
    card.appendChild(h);

    const input = document.createElement('input');
    input.className = 'modal-input';
    input.placeholder = '例如 my-feature-work';
    input.value = S.state?.sessionName || '';
    card.appendChild(input);
    setTimeout(() => input.focus(), 30);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.onclick = close;

    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = '保存';
    ok.onclick = () => {
      const name = input.value.trim();
      close();
      if (!name) return;
      setSessionName(name);
      setTitleText(name);
      el.footName.textContent = name;
      toast('已重命名为 ' + name, 'info');
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok.click();
    });

    actions.append(cancel, ok);
    card.appendChild(actions);
  });
}

function openMoreMenu() {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = '更多';
    card.appendChild(h);

    const list = document.createElement('div');
    list.className = 'modal-list';

    const entries = [
      ['开发进程', openProcessPanel],
      ['重命名会话', renameSession],
      ['导出会话 HTML', exportHtml],
      ['压缩上下文', compactNow],
      ['会话统计', () => {
        close();
        openStatsPanel();
      }],
    ];

    for (const [label, fn] of entries) {
      const item = document.createElement('button');
      item.type = 'button';
      if (label === '导出会话 HTML') item.id = 'btnShare';
      if (label === '会话统计') item.id = 'btnStats';
      item.className = 'modal-item';
      item.textContent = label;
      item.onclick = () => {
        if (fn !== renameSession) close();
        fn();
      };
      list.appendChild(item);
    }
    card.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const done = document.createElement('button');
    done.className = 'btn primary';
    done.textContent = '关闭';
    done.onclick = close;
    actions.appendChild(done);
    card.appendChild(actions);
  });
}

/* ---------- 事件绑定 ---------- */

el.input.addEventListener('input', () => {
  autoGrow();
  updateSendState();
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  } else if (e.key === 'Escape') {
    // 浮层开着时 Esc 先关浮层，别把正在跑的对话也停掉
    if (popVisible()) {
      closePop({ restoreFocus: true });
      return;
    }
    stop();
  }
});

// 输入区
el.btnSend.onclick = submit;
/* Stop 之前先把还挂着的 approval 对话框按 fail-closed 取消掉：
 * 用户按了「停止」就不该留一张永远等的卡片，Pi 侧也要收到明确的取消
 *（confirm 的取消被 rpc-mode 解析成 false，也就是拒绝）。 */
el.btnStop.onclick = () => {
  cancelPendingApprovals();
  stop();
};
el.btnModel.onclick = () => {
  if (popVisible() && currentAnchor() === el.btnModel) return closePop();
  openModelPicker();
};
el.btnThink.onclick = () => {
  if (popVisible() && currentAnchor() === el.btnThink) return closePop();
  openThinkPicker();
};

// 上下文占用：悬停出提示，带一点延迟避免扫过就闪
let ctxTimer = null;
el.btnCtx.addEventListener('mouseenter', () => {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(openCtxTip, 110);
});
el.btnCtx.addEventListener('mouseleave', () => {
  clearTimeout(ctxTimer);
  ctxTimer = setTimeout(() => {
    if (!pop.matches(':hover')) closePop();
  }, 200);
});
pop.addEventListener('mouseleave', () => {
  if (pop.classList.contains('tip-mode')) closePop();
});
// 悬停已经会打开提示，此时再点一下不该把它关掉 —— 所以点击只在关闭时起作用
el.btnCtx.addEventListener('click', () => {
  if (!popVisible()) openCtxTip();
});

/* --- 附件 --- */

el.btnAttach.onclick = () => el.fileInput.click();

el.fileInput.onchange = () => {
  handleFiles(el.fileInput.files);
  el.fileInput.value = ''; // 允许连续选同一个文件
};

let dragDepth = 0;
el.composerBox.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  el.composerBox.classList.add('drop');
});
el.composerBox.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
el.composerBox.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.composerBox.classList.remove('drop');
});
el.composerBox.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.composerBox.classList.remove('drop');
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});

// 粘贴图片：剪贴板里是文件才拦，纯文本照常交给 textarea
document.addEventListener('paste', (e) => {
  const files = e.clipboardData?.files;
  if (files && files.length) {
    e.preventDefault();
    handleFiles(files);
  }
});

// 顶栏
$('btnTree').onclick = openBranchPanel;
$('btnMore').onclick = openMoreMenu;

// 侧栏导航
$('navNew').onclick = newSession;
$('navSearch').onclick = openSessionSearch;
/* 「回到对话」的既有语义：关掉二级弹层与 More 菜单、切回 Chat、把焦点给输入框。
 * P24 起它被三处复用（侧栏 Home、命令面板、快捷键），所以抽成一个函数 ——
 * 各写一份迟早会出现「从某条路回去焦点不对」。 */
function goChat() {
  if (!$('modal').hidden) closeModal();
  $('globalMoreMenu').hidden = true;
  $('navGlobalMore').setAttribute('aria-expanded', 'false');
  showChat();
  el.input.focus();
}

$('navHome').onclick = goChat;
$('navChanges').onclick = openChangesPanel;
document.addEventListener('pi-gui:right-pane', (event) => {
  const open = event.detail?.open === true && event.detail?.surface === 'changes';
  $('navChanges').setAttribute('aria-pressed', String(open));
  $('navChanges').classList.toggle('is-active', open);
});
$('navProviders').onclick = openProvidersPanel;
$('navProviderAuth').onclick = openProviderAuthPanel;
$('navDiagnostics').onclick = openDiagnostics;
$('navCapabilities').onclick = () => openExtensions({ tab: 'capabilities' });
$('navMcp').onclick = () => openExtensions({ tab: 'mcp' });
$('navAppUpdates').onclick = openAppUpdates;
$('navRestartPi').onclick = restartPi;
/* P24：More 菜单里的两个可见入口（快捷键要能被发现，不能只写在文档里）。 */
$('navPalette').onclick = () => {
  $('globalMoreMenu').hidden = true;
  $('navGlobalMore').setAttribute('aria-expanded', 'false');
  openPalette();
};
$('navShortcutHelp').onclick = () => {
  $('globalMoreMenu').hidden = true;
  $('navGlobalMore').setAttribute('aria-expanded', 'false');
  openShortcutHelp();
};

// 侧栏头部 / 项目
// 「添加文件夹」在项目操作菜单和未选项目的欢迎块里共用目录选择器。
$('btnAddProject').onclick = openDirPicker;
$('btnPickProject').onclick = openDirPicker;
$('btnProjectSettings').onclick = openProjectSettings;

// 扩展能力（Skills / MCP）保留全局入口；模型供应商位于 More 菜单。
$('navExtensions').onclick = () => openExtensions({ tab: 'skills' });
$('navPlanner').onclick = () => openPlanner();

const globalMenu = $('globalMoreMenu');
const globalMore = $('navGlobalMore');
globalMore.onclick = () => {
  globalMenu.hidden = !globalMenu.hidden;
  globalMore.setAttribute('aria-expanded', String(!globalMenu.hidden));
  if (!globalMenu.hidden) globalMenu.querySelector('button')?.focus();
};
globalMenu.addEventListener('keydown', (event) => {
  const buttons = [...globalMenu.querySelectorAll('button:not([disabled])')];
  const index = buttons.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }
  if (event.key === 'Tab' && (event.shiftKey && index === 0 || !event.shiftKey && index === buttons.length - 1)) {
    globalMenu.hidden = true;
    globalMore.setAttribute('aria-expanded', 'false');
  }
});
for (const entry of globalMenu.querySelectorAll('button')) {
  entry.addEventListener('click', () => {
    globalMenu.hidden = true;
    globalMore.setAttribute('aria-expanded', 'false');
  });
}
document.addEventListener('click', (event) => {
  if (!globalMenu.hidden && !globalMenu.contains(event.target) && !globalMore.contains(event.target)) {
    globalMenu.hidden = true;
    globalMore.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !projectMenu.hidden) {
    projectMenu.hidden = true;
    projectMenuButton.setAttribute('aria-expanded', 'false');
    projectMenuButton.focus();
  }
  if (event.key === 'Escape' && $('projectSidebar').classList.contains('search-open') && $('projectSidebar').contains(document.activeElement)) {
    $('projectSidebar').classList.remove('search-open');
    $('navSearch').setAttribute('aria-expanded', 'false');
    $('navSearch').focus();
  }
  if (event.key === 'Escape' && !globalMenu.hidden) {
    globalMenu.hidden = true;
    globalMore.setAttribute('aria-expanded', 'false');
    globalMore.focus();
  }
});

const projectMenu = $('projectActions');
const projectMenuButton = $('btnProjectMenu');
projectMenuButton.onclick = () => {
  projectMenu.hidden = !projectMenu.hidden;
  projectMenuButton.setAttribute('aria-expanded', String(!projectMenu.hidden));
};
for (const action of projectMenu.querySelectorAll('button')) action.addEventListener('click', () => {
  projectMenu.hidden = true;
  projectMenuButton.setAttribute('aria-expanded', 'false');
});

const sidebar = $('projectSidebar');
const expandSidebar = $('btnSidebarExpand');
const collapseSidebar = $('btnSidebarCollapse');
function setSidebarCollapsed(collapsed) {
  sidebar.hidden = collapsed;
  expandSidebar.hidden = !collapsed;
  collapseSidebar.setAttribute('aria-expanded', String(!collapsed));
  expandSidebar.setAttribute('aria-expanded', String(!collapsed));
}
collapseSidebar.onclick = () => { setSidebarCollapsed(true); expandSidebar.focus(); };
expandSidebar.onclick = () => { setSidebarCollapsed(false); collapseSidebar.focus(); };

// 项目分组折叠状态记忆
const group = $('groupHead').closest('.rail-group');
try {
  group.classList.toggle('open', localStorage.getItem('pi-group-open') !== '0');
} catch {
  group.classList.add('open');
}
$('groupHead').setAttribute('aria-expanded', String(group.classList.contains('open')));
$('groupHead').onclick = () => {
  group.classList.toggle('open');
  $('groupHead').setAttribute('aria-expanded', String(group.classList.contains('open')));
  try {
    localStorage.setItem('pi-group-open', group.classList.contains('open') ? '1' : '0');
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
};

/* ---------- P24：命令面板 / 快捷键 / 草稿 ----------
 *
 * **全部复用既有 handler**：这里不实现任何「切视图」「重启」「复制」的细节，
 * 只把「动作 → 名字 → 键位 / 面板条目」接起来。加一个动作 = 加一行，不是加一套逻辑。 */

/* ---------- P24：重启 pi 的唯一入口（含确认）----------
 *
 * 为什么要有这个包装：P24 给「重启 pi」加了两个新入口（命令面板、状态条），
 * 而它原本在 More 菜单里是**直接执行**的。三个入口各写一遍确认，迟早会有一个漏掉
 * —— 那就等于「有确认」是假的。所以收敛成一个函数，谁都从这里走。
 *
 * 危险动作不能被绕过：命令面板只调这个函数，不提供任何跳过确认的参数。
 * 提示语按「会不会真的中断什么」分开写 —— 正在生成时要说清会中断这一轮。 */
export async function restartPi() {
  const busy = Boolean(S.streaming);
  const ok = await confirmModal({
    title: '重启 pi？',
    message: busy
      ? '正在生成回答，重启会中断这一轮。\n\n磁盘上的会话与文件不受影响，重启后仍在。'
      : '重启会重新加载配置并重建会话视图。\n\n磁盘上的会话与文件不受影响。',
    okText: '重启 pi',
  });
  if (ok !== true) return false;
  reloadPi();
  return true;
}

/** 弹层开着时不要抢键位（弹层有自己的 Esc / Tab 处理）。 */
const noOverlay = () => el.modal.hidden && el.confirmLayer.hidden && !paletteOpen();
const canRun = () => noOverlay();
const canPrompt = () => S.hasProject && !S.switching && S.bridgeState === 'ready';

/* 侧栏的「搜索会话」那一条路径（展开分组 + 聚焦搜索框）也在这里复用。 */
function openSessionSearch() {
  setSidebarCollapsed(false);
  group.classList.add('open');
  $('groupHead').setAttribute('aria-expanded', 'true');
  $('projectSidebar').classList.add('search-open');
  $('navSearch').setAttribute('aria-expanded', 'true');
  /* 会话列表可能被用户折叠着 —— 输入框就在那块列表里，不先展开的话
   * 「搜索会话」点下去什么都不会发生（focus 一个隐藏元素是空操作）。 */
  expandSidebarSessions();
  $('projectSidebar').querySelector('.pj-search-input')?.focus();
}

const openView = (view) => () => {
  if (view === 'chat') return goChat();
  if (view === 'planner') return openPlanner();
  if (view === 'changes') return openChangesPanel();
  return openExtensions({ tab: 'skills' });
};

registerShortcut({ id: 'palette', combo: 'primary+k', label: '打开命令面板', group: '通用', when: canRun, run: () => openPalette() });
/* 第二个绑定：浏览器里 Ctrl+K 常被地址栏吃掉，Ctrl+Shift+P 是各编辑器通用的备选。
 * 两条绑同一个动作 —— 不是两个功能。 */
registerShortcut({ id: 'palette-alt', combo: 'primary+shift+p', label: '打开命令面板（备用键）', group: '通用', when: canRun, run: () => openPalette() });
registerShortcut({ id: 'shortcut-help', combo: 'primary+/', label: '键盘快捷键帮助', group: '通用', when: canRun, run: () => openShortcutHelp() });
registerShortcut({ id: 'view-chat', combo: 'alt+1', label: '切到对话', group: '视图', when: canRun, run: openView('chat') });
registerShortcut({ id: 'view-planner', combo: 'alt+2', label: '切到任务', group: '视图', when: canRun, run: openView('planner') });
registerShortcut({ id: 'view-changes', combo: 'alt+3', label: '切到文件变更', group: '视图', when: canRun, run: openView('changes') });
registerShortcut({ id: 'view-extensions', combo: 'alt+4', label: '切到扩展与能力', group: '视图', when: canRun, run: openView('extensions') });
/* 冲突检查放在装配末尾：注册完立刻验，重复键位在启动时就炸出来，
 * 而不是等用户按下那个键才发现有两个功能抢。 */
assertNoConflicts();
installShortcuts({});

defineCommands([
  { id:'view.processes',title:'开发进程',group:'视图',keywords:'process dev server 服务 进程 日志',run:openProcessPanel },
  { id: 'app.preferences', title: '设置', group: '全局', keywords: 'settings 偏好 账户 updates 更新', run: () => { if (globalMenu.hidden) globalMore.click(); } },
  { id: 'app.updates', title: '应用与更新', group: '全局', keywords: 'update 更新 pi gui 版本', run: openAppUpdates },
  { id: 'view.chat', title: '对话', group: '视图', keywords: 'chat 会话 首页 home', run: goChat },
  { id: 'view.planner', title: '任务（Planner）', group: '视图', keywords: 'planner 计划 任务 plan', run: () => openPlanner() },
  { id: 'view.changes', title: '文件变更', group: '视图', keywords: 'git diff changes 变更', run: () => openChangesPanel() },
  { id: 'view.extensions', title: '扩展（Extensions）', group: '视图', keywords: 'extension 扩展 注册表', run: () => openExtensions() },
  /* 内置浏览器：只是**右栏的一个面板**，不是第四个一级视图 —— 所以它在这里，
   * 不进左侧全局导航栏。when 为假（网页版）时压根不进列表，不灰着骗人。 */
  { id: 'view.browser', title: '打开内置浏览器', group: '视图', keywords: 'browser 浏览器 web preview localhost 预览 网页 内置', when: () => Boolean(browserPane), run: () => conversationScopeActive() ? runtimeSecondary?.openBrowser() : browserPane.open() },
  { id: 'view.capabilities', title: '能力视图（Capabilities）', group: '视图', keywords: 'capability 能力 状态 可用', run: () => openExtensions({ tab: 'capabilities' }) },
  { id: 'view.skills', title: 'Skills', group: '视图', keywords: 'skill 技能', run: () => openExtensions({ tab: 'skills' }) },
  { id: 'view.mcp', title: 'MCP', group: '视图', keywords: 'mcp server 原生', run: () => openExtensions({ tab: 'mcp' }) },
  { id: 'view.usage', title: '用量与额度', group: '视图', keywords: 'usage quota 用量 额度 token 上下文', run: () => openCtxTip() },
  { id: 'session.new', title: '新对话', group: '会话', keywords: 'new session 新会话', when: canPrompt, run: () => newSession() },
  { id: 'session.search', title: '搜索会话', group: '会话', keywords: 'search session 查找 历史', run: openSessionSearch },
  { id: 'session.stats', title: '会话统计', group: '会话', keywords: 'stats 统计 token 成本', when: () => S.hasProject, run: () => openStatsPanel() },
  { id: 'session.rename', title: '重命名会话', group: '会话', keywords: 'rename 改名 标题', when: () => S.hasProject, run: () => renameSession() },
  { id: 'session.export', title: '导出会话为 HTML', group: '会话', keywords: 'export share 导出 分享', when: canPrompt, run: () => exportHtml() },
  { id: 'run.stop', title: '停止生成', group: '执行', keywords: 'stop abort 中断 取消', when: () => S.streaming, run: () => stop() },
  { id: 'run.compact', title: '压缩上下文', group: '执行', keywords: 'compact 压缩 context', when: canPrompt, run: () => compactNow() },
  /* 重启仍然走 restartPi()（唯一入口 + 确认）—— 面板不提供跳过确认的路径。 */
  { id: 'run.restart', title: '重启 Pi', group: '执行', keywords: 'restart 重载 reload pi', when: () => S.hasProject, run: () => restartPi() },
  { id: 'app.settings', title: '项目设置', group: '全局', keywords: 'settings 设置 配置', when: () => S.hasProject, run: () => openProjectSettings() },
  { id: 'app.providers', title: '模型供应商', group: '全局', keywords: 'provider 供应商 模型 key', run: () => openProvidersPanel() },
  { id: 'app.providerAuth', title: '供应商与认证', group: '全局', keywords: 'provider authentication OAuth login 认证', run: () => openProviderAuthPanel() },
  { id: 'app.diagnostics', title: '诊断', group: '全局', keywords: 'diagnostics 诊断 版本 兼容', run: () => openDiagnostics() },
  { id: 'app.copy-diagnostics', title: '复制诊断摘要', group: '全局', keywords: 'copy diagnostics 复制 摘要 issue', run: () => copyDiagnosticsSummary() },
  { id: 'app.shortcuts', title: '键盘快捷键', group: '全局', keywords: 'keyboard shortcut 快捷键 帮助', run: () => openShortcutHelp() },
]);

/* 动态条目：已加载的会话列表（复用侧栏那一份数据，不重新拉）。
 * **只在有查询时才出现** —— 否则一打开面板就被十几条会话刷屏，
 * 常用动作反而要往下找。 */
setDynamicCommands((ctx = {}) => {
  const q = String(ctx.query || '').trim();
  if (!q) return [];
  return knownSessions()
    .filter((s) => !s.current)
    .slice(0, 12)
    .map((s) => ({
      id: `session.switch.${s.id}`,
      title: `切换到会话：${s.title}`,
      group: '会话',
      hint: s.archived ? '已归档' : '',
      keywords: 'switch session 会话 切换',
      run: () => switchToSessionById(s.id),
    }));
});

/* 草稿：绑定输入监听 + 首次恢复。身份（项目/会话）变化时由 draftSync 对齐。 */
initDraft();

/* ---------- 启动 ---------- */

/* 欢迎块自动显隐。挂在整个对话区上（subtree），这样无论消息是从哪条路径
 * 进来的 —— 实时流式、历史重建、清空重画 —— 都能跟上。 */
new MutationObserver(syncWelcome).observe(el.stream, { childList: true, subtree: true });
syncWelcome();

loadProjects();
loadProviders();
/* 侧栏「扩展」右边那个数字：发现了几条 skill。
 * 只做展示，失败就留空 —— 这个数字不该在启动路径上弹任何错。 */
loadExtensionsBadge();

/* Git 工作区状态先拉一次，把侧栏的「文件变更 N」填上。
 * 失败也无所谓 —— 不是 Git 仓库、没装 git、还没选项目都是正常情况，
 * 面板会各自给出中性文案（见 git.js 的 renderChangesBody）。 */
loadGitStatus();
autoGrow();
/* 先按「还没选项目」摆一次，锁住输入区。
 * 真的有项目时 loadStatus 会立刻把它打开 —— 那一瞬间两块引导都是藏着的，
 * 所以不会闪出错误文案（页面里的默认态也是都藏，见 index.html 的说明）。 */
applyProjectState();
updateSendState();
renderAttachments();
renderCtxChip();
initComposerLayout();
el.input.focus();

// 先拿到 cwd 再连事件流，保证导出提示里的路径一开始就是绝对的
loadStatus().then(() => {
  /* 草稿与状态条都依赖 cwd / hasProject / compat，等状态回来再对齐一次。 */
  draftSync();
  syncNotice();
  connect();
});

/* 版本检查：启动后**延迟**跑一次，不阻塞启动、不在启动瞬间请求
 * （那时 pi 桥接正在拉起，任何并发都只会互相干扰）。
 * 失败与无更新都完全静默，只有真的发现新版才给一次轻提示 ——
 * 不弹 Modal、不重复打扰。详见 public/update.js。 */
initUpdateAuto();

/* Pi 运行时（外部程序 pi）的版本检查：同样延迟、同样静默、同样只检查。
 * **它只是检查** —— 真正的更新必须由用户在诊断面板里点、并再确认一次，
 * 见 public/pi-update.js 的文件头。 */
initPiUpdateAuto();
