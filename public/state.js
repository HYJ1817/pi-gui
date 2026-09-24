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
  providerCount: $('providerCount'),
  modal: $('modal'),
  modalCard: $('modalCard'),
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
  btnPickProject: $('btnPickProject'),
};

/* 弹层里的动态容器。
 *
 * 关闭弹层时必须置空 —— 否则异步回来的数据会写进已经被 innerHTML='' 卸掉的
 * 节点上：不报错，但界面上什么都不出现，属于最难查的一类问题。
 * 早先是两个模块级 let（treeContainer / providerContainer），
 * 拆模块后导入绑定不可写，改成同一个对象上的两个槽位。 */
export const panels = { tree: null, providers: null };

export const S = {
  seq: 0,
  streaming: false,
  thread: null,
  current: null,
  blocks: new Map(),
  tools: new Map(),
  working: null,
  models: [],
  thinkingLevels: [],
  state: null,
  stats: null,
  treeData: [],
  onStats: null,
  cwd: '',
  attachments: [],
  ready: false,
  /* 有没有选项目。没有的话 pi 根本没启动（见 server.js 的 startPi），
   * 界面要整体切到「先添加文件夹」的形态，而不是给一个发不出去的输入框。 */
  hasProject: false,
};
