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

/* 弹层里的动态容器。
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
  submitting: false,
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
  state: null,
  stats: null,
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
  S.workspaceGeneration++;
  S.switching = true;
  S.desiredCwd = cwd;
  S.syncPending = { state: true, messages: true };
  S.bridgeState = 'restarting';
  return S.workspaceGeneration;
}

export const ownsWorkspace = (generation) => generation === S.workspaceGeneration;
