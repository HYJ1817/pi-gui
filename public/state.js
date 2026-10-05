/* 全局 DOM 引用与应用状态。
 *
 * 单独成文件，是为了让「谁都能读、但只有该管的地方去写」这件事显式化：
 * 其他模块 import { el, S } 只读地取用，要改状态就走各自的语义函数
 * （例如 setStreaming / applyStats），而不是散落各处直接赋值。
 *
 * 跨模块共享的**可变容器**一律用对象包一层（见 panels）。
 * 原因：ES Module 的导入绑定对导入方是只读的，`export let x` 之后
 * 别的模块赋不了值 —— 包成对象属性就没这个限制，也不会有「快照还是活绑定」
 * 的歧义。 */

export const $ = (id) => document.getElementById(id);

export const el = {
  stream: $('stream'),
  input: $('input'),
  btnSend: $('btnSend'),
  btnStop: $('btnStop'),
  statusText: $('statusText'),
  title: $('title'),
  modelText: $('modelText'),
  thinkText: $('thinkText'),
  btnModel: $('btnModel'),
  btnThink: $('btnThink'),
  footName: $('footName'),
  conn: $('conn'),
  connText: $('connText'),
  uPct: $('uPct'),
  uCtxBar: $('uCtxBar'),
  uNote: $('uNote'),
  uTok: $('uTok'),
  uCache: $('uCache'),
  uCost: $('uCost'),
  uQuota: $('uQuota'),
  projects: $('projects'),
  groupHead: $('groupHead'),
  branchCount: $('branchCount'),
  changesCount: $('changesCount'),
  providerCount: $('providerCount'),
  modal: $('modal'),
  modalCard: $('modalCard'),
  confirmLayer: $('confirmLayer'),
  confirmCard: $('confirmCard'),
  toasts: $('toasts'),
  composerBox: $('composerBox'),
  attachTray: $('attachTray'),
  fileInput: $('fileInput'),
  btnAttach: $('btnAttach'),
  btnCtx: $('btnCtx'),
  ctxRing: $('ctxRing'),
  ctxPct: $('ctxPct'),
  welcomeReady: $('welcomeReady'),
  welcomeNoProj: $('welcomeNoProj'),
  welcomeRestore: $('welcomeRestore'),
  btnPickProject: $('btnPickProject'),
};

/* 动态容器。tree/providers 属于弹层；changes 属于 Stage Work Surface。
 *
 * 关闭弹层时必须置空 —— 否则异步回来的数据会写进已经被 innerHTML='' 卸掉的
 * 节点上：不报错，但界面上什么都不出现，属于最难查的一类问题。
 * 早先是两个模块级 let（treeContainer / providerContainer），
 * 拆模块后导入绑定不可写，改成同一个对象上的两个槽位。 */
export const panels = { tree: null, providers: null, changes: null };

export const S = {
  seq: 0,
  workspaceGeneration: 0,
  restoring: true,
  switching: false,
  desiredCwd: '',
  bridgeRun: null,
  bridgeState: 'starting',
  syncPending: null,
  streaming: false,
  /* 「正在停止」是**独立于 streaming 的第三态**（P30 Stop 语义）。
   *
   * 为什么不复用 S.streaming：Pi 的 abort 应答可能比 agent_settled 晚到
   * （也可能早到），两种顺序下 streaming 都会先变 false —— 而那时后端
   * 屏障可能还挂着。用 streaming 当「能不能发」的判据，就会把新消息
   * 变成旧 run 的 steer，正是要修的那个 bug。
   *
   * stopping 为真时：发送键禁用、submit() 直接返回、Stop 重复点击不重发。
   * 只有后端给出权威停止确认（HTTP ok 或 stop_state 事件）才落回 false。 */
  stopping: false,
  /* 停止的「代」：每次 stop() / 换工作区 / bridge 换代都 ++。
   * 迟到的停止应答靠它认领 —— 代对不上就一概不写状态、不解除屏障。 */
  stopGeneration: 0,
  /* 这一轮 run 期间用户点过 Stop。用于把「Provider 报的 cancelled」
   * 与「用户主动停止」分开：只有它还是 true 时才按用户停止呈现，
   * 否则保留真正的取消错误（不吞错误）。新的 run 一开始就清掉。 */
  stopOwnedTurn: false,
  submitting: false,
  fallbackActive: false,
  fallbackRuntime: null,
  thread: null,
  current: null,
  blocks: new Map(),
  tools: new Map(),
  /* 当前打开的 Tool Timeline 组（§12）。
   * 一组 = 一条 assistant 消息里的全部 toolCall。放在 S 上而不是 tools.js 的
   * 模块级变量：messages.js 也要在「新的 assistant 消息开始」「用户消息进来」
   * 这两个边界上把它关掉，而 messages.js 不能 import tools.js（会成环）。 */
  tlGroup: null,
  working: null,
  models: [],
  thinkingLevels: [],
  modelSwitchPending: false,
  state: null,
  stats: null,
  /* 本地用量（LocalUsage）与远端额度（RemoteQuota）（P21）。
   * 0 只能表示真实 0，缺失为 null。两层分立，来源可追溯。 */
  localUsage: {
    providerId: null,
    modelId: null,
    sessionId: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    contextUsed: null,
    contextLimit: null,
    contextPercent: null,
    estimatedCost: null,
    lastTurn: null,
    source: 'none',
    updatedAt: null,
  },
  remoteQuota: null,
  quotaLoading: false,
  quotaEpoch: 0,
  currentProviderId: null,
  treeData: [],
  onStats: null,
  cwd: '',
  /* Pi 兼容摘要（P4），由 /api/status 带回来：`{ status, missing[] }`。
   * 只用来**局部降级**（某个能力确定不可用时藏起对应入口）。
   * 还没拿到（null）时一律按「可用」处理 —— 宁可乐观，也不要因为状态没到
   * 就把功能藏起来。 */
  compat: null,
  attachments: [],
  ready: false,
  /* 有没有选项目。没有的话 pi 根本没启动（见 server.js 的 startPi），
   * 界面要整体切到「先添加文件夹」的形态，而不是给一个发不出去的输入框。 */
  hasProject: false,
  /* Git 工作区变更（磁盘真实状态）。
   *
   * 与 changes.js 的账本是两件事，不要混：
   *   - changes.js  = **Agent 事件**账本（这次会话里 Agent 声称改过哪些文件），
   *                   由工具事件驱动，随会话清空。
   *   - S.changes   = **Git 工作区**状态，由 git status 得到，是磁盘的权威事实。
   * 两者不一致时以 Git 为准（例如 Agent 改了又自己撤回，账本还留着记录）。
   *
   * projectRoot 来自后端的 git status（已 realpath 过）。它存在的唯一理由是
   * 「会话过滤」：账本里记的是 pi 工具参数里的原始路径（可能是绝对路径），
   * 而 Git 给的是项目相对路径，两边要先归一到同一个坐标系才能求交集。 */
  changes: {
    isRepo: false,
    loaded: false,
    files: [],
    error: '',
    noGit: false,
    noProject: false,
    projectRoot: '',
    truncated: false,
  },
};

export function beginWorkspaceSwitch(cwd) {
  S.cancelFallback?.('workspace-switch');
  S.workspaceGeneration++;
  /* 换工作区 = 换了一条执行线：上一次停止的应答（如果还在飞）不许再动
   * 新工作区的界面，也不许解除新工作区的屏障（那一代已经作废了）。 */
  invalidateStop();
  S.switching = true;
  S.thinkingLevels = [];
  S.modelSwitchPending = true;
  resetUsageState();
  S.desiredCwd = cwd;
  S.syncPending = { state: true, messages: true };
  S.bridgeState = 'restarting';
  return S.workspaceGeneration;
}

export const ownsWorkspace = (generation) => generation === S.workspaceGeneration;

/* ---------- 停止的「代」 ----------
 *
 * 停止是**异步**的：点下去到后端确认之间，世界可能已经变了（换工作区、
 * 重启 Pi、Pi 退出、用户又点了一次）。所以每次停止都领一个号，
 * 迟到的应答先验证身份再写状态 —— 代对不上就什么都不做。
 *
 * `invalidateStop` 是唯一让「旧停止」失效的地方 —— 它同时把 UI 从 stopping
 * 里放出来：那个旧 run 已经不属于任何还在等它的东西了。 */
export function invalidateStop() {
  S.stopGeneration++;
  S.stopping = false;
  S.stopOwnedTurn = false;
}

/** 停止已被权威确认（Pi 的 abort 应答 / bridge 已换代）。
 *
 *  与 invalidateStop 的区别只有一处：**保留 stopOwnedTurn** ——
 *  被中断的那条消息还没渲染出来，它仍然属于「用户主动停止」。
 *  两者都 ++stopGeneration（迟到的应答据此认领失败）。 */
export function confirmStop() {
  S.stopGeneration++;
  S.stopping = false;
}

/* 用量 DOM 的渲染钩子。
 *
 * state.js 不能 import usage.js（usage.js 已经 import state.js，会成环），
 * 所以由 usage.js 在模块初始化时注册；`resetUsageState()` 负责调用它。
 * 这样「JS state 清零」与「界面立刻归零」永远是同一个动作，
 * 不会出现「切了项目但侧栏还挂着上一个项目的数字」。 */
let usageRenderHook = null;
export function setUsageRenderHook(fn) {
  usageRenderHook = typeof fn === 'function' ? fn : null;
}

export function resetUsageState() {
  S.stats = null;
  S.remoteQuota = null;
  S.quotaLoading = false;
  S.quotaEpoch++;
  S.currentProviderId = null;
  Object.assign(S.localUsage, {
    providerId: null,
    modelId: null,
    sessionId: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    contextUsed: null,
    contextLimit: null,
    contextPercent: null,
    estimatedCost: null,
    lastTurn: null,
    source: 'none',
    updatedAt: null,
  });
  /* 只清 JS 不够：旧项目的数字必须立刻从 DOM 上消失，
   * 而不是等下一次 RPC 应答回来才被覆盖。 */
  if (usageRenderHook) usageRenderHook();
}
