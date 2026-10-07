/* P32.4-A：项目会话区里的 runtime conversation 导航。
 *
 * 这是 P32.3 那个「独立会话」窄入口 modal 的**侧栏视图**，不是第二套状态：
 *   - 数据源是 registry 快照（GET /api/runtime-sessions），归属按 worktrees
 *     返回的 projectId 判定（不按标题/路径猜）；
 *   - 状态读的是 runtime-state.js 里那**同一个** store（revision / eventSequence /
 *     owner 三条防护复用，不另造）；
 *   - 行位置只由后端持久化的 createdAt 决定，点击/后台事件都不会让它换位。
 *
 * 本模块**不 spawn**：列出来只读快照；只有用户点「新建并行会话」或恢复会话时
 * 才会走到创建/恢复路径（由调用方注入，复用 P32.2 + P32.3 既有入口）。
 */
import { fetchRuntimeSessions, fetchWorktrees, runtimeSessionAction, worktreeAction } from './api.js';
import { runtimeStore as store, onRuntimeChange } from './runtime-state.js';
import { openModal } from './ui/modal.js';
import { toast } from './ui/toast.js';

/* 侧栏自己订阅 store 的变化 —— 不依赖任何视图模块替它接线。 */
onRuntimeChange(() => repaintRuntimeNav());

const LIFECYCLE = { dormant: '已关闭', starting: '启动中', ready: '就绪', error: '错误', disposing: '清理中' };
const ACTIVITY = { idle: '空闲', running: '运行中', stopping: '正在停止' };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* 只记「归属 + 排序键」；状态一律从 store 现读，避免在这里复制一份 item。
 * 复制一份就等于把 revision 判据拆成两处。 */
let members = [];
let projectId = '';
let currentProjectPath = '';
let parent = null;
let host = null;
let token = 0;
let loading = null;
let focusHandler = null;
let createHandler = null;

/** 中央视图切换由组合根注入（P32.4-B 的落点）；A 阶段没注入时点击只改 focus 状态。 */
export function setRuntimeFocusHandler(fn) { focusHandler = fn || null; }

/** 「新建并行会话」的落点可由组合根覆盖（测试与将来 P32.4-D 的确认流程）；
 *  默认实现是 P32.2 create + P32.3 start 的编排，不自己拼第二条创建路径。 */
export function setRuntimeCreateHandler(fn) { createHandler = fn || null; }

export function runtimeNavCount() { return members.length; }

/** 侧栏要用的会话视图（归属 + store 里的实时 item）。 */
export function runtimeNavItems() {
  return members.map(m => ({ conversationId: m.conversationId, createdAt: m.createdAt, item: store.get(m.conversationId)?.item || null }));
}

/* 列表区每次重画都会换掉子节点，所以父容器由调用方每次交进来；
 * 本模块自己负责在父容器里建/复用自己的那一块（放在最前面）。 */
export function setRuntimeNavParent(next) { parent = next || null; }

/** 从后端重新拉一次归属与快照。返回归属数量，便于调用方决定是否还画这块。 */
export function loadRuntimeNav(project, context = {}) {
  if (context.parent) parent = context.parent;
  const path = project?.path || '';
  if (loading?.path === path) return loading.promise;
  const task = { path, promise: null };
  loading = task;
  task.promise = readRuntimeNav(project).finally(() => { if (loading === task) loading = null; });
  return task.promise;
}

async function readRuntimeNav(project) {
  if (typeof project?.path === 'string') currentProjectPath = project.path;
  const t = ++token;
  const [snapshot, worktrees] = await Promise.all([
    fetchRuntimeSessions().catch(() => null),
    fetchWorktrees(project?.path || '').catch(() => null),
  ]);
  if (t !== token) return members.length;
  if (!snapshot || snapshot.ok === false || !Array.isArray(snapshot.items)) { members = []; projectId = ''; paint(); return 0; }
  /* 归属只认 worktrees 返回的 projectId：它不是从路径字符串推出来的，
   * 而是后端按 Git common-dir 算出的稳定身份。拿不到就不显示（非 Git 项目
   * 本来也不该有并行会话），不猜。 */
  projectId = typeof worktrees?.projectId === 'string' ? worktrees.projectId : '';
  store.seed(snapshot);
  members = (projectId ? snapshot.items : [])
    .filter(item => item?.workspace?.projectId === projectId)
    .map(item => ({ conversationId: item.conversationId, createdAt: typeof item.createdAt === 'string' ? item.createdAt : '' }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.conversationId.localeCompare(b.conversationId));
  paint();
  return members.length;
}

/** SSE 帧到达后的重画（由 runtime-sessions.js 广播）。不重新拉网络。 */
export function repaintRuntimeNav() {
  if (!parent) return;
  /* 出现归属之外的 conversationId → 说明有人新建了并行会话，
   * 这时才需要重新拉一次归属列表（事件驱动，不轮询）。 */
  const known = new Set(members.map(m => m.conversationId));
  for (const record of store.values()) {
    if (!record.owner) continue;
    const id = record.owner.conversationId;
    if (!known.has(id) && record.owner.projectId === projectId) { void loadRuntimeNav({ path: currentProjectPath }, { parent }); return; }  }
  paint();
}

export function clearRuntimeNav() { members = []; projectId = ''; token++; host = null; loading = null; }

function label(item) {
  const branch = item?.workspace?.branch;
  if (branch) return branch;
  return '并行会话';
}

function statusText(item) {
  if (!item) return '';
  if (item.lifecycle === 'error') return '错误';
  if (item.activity === 'stopping') return '正在停止';
  if (item.activity === 'running') return '运行中';
  return LIFECYCLE[item.lifecycle] || item.lifecycle;
}

/* 视觉只用**一个**轻量状态点 + 一行文字，不加彩色 badge（P30 的信息密度）。 */
function stateClass(item) {
  if (!item) return 'dormant';
  if (item.lifecycle === 'error') return 'error';
  if (item.activity === 'stopping') return 'stopping';
  if (item.activity === 'running') return 'running';
  return item.lifecycle;
}

async function focusConversation(conversationId) {
  const record = store.get(conversationId);
  if (!record?.owner) {
    /* dormant：没有 live runtime，**不能**发 focus（后端也没有 owner 可校验），
     * 更不能顺手 spawn 一个。只把意图交给中央视图（P32.4-B 的「打开历史」），
     * 需要继续执行时由用户显式恢复。 */
    focusHandler?.(conversationId);
    return;
  }
  /* captured owner：动作触发时取一次，迟到响应不改别的会话。 */
  const owner = { ...record.owner };
  try {
    const result = await runtimeSessionAction({ action: 'focus', owner });
    if (result?.ok === false) return;
  } catch { return; }
  focusHandler?.(conversationId);
}

function row(member) {
  const item = store.get(member.conversationId)?.item || null;
  const rowEl = el('div', 'pj-sess pj-runtime' + (item?.focused ? ' on' : ''));
  rowEl.dataset.conversationId = member.conversationId;
  if (item?.focused) rowEl.setAttribute('aria-current', 'true');

  const primary = el('button', 'pj-sess-primary');
  primary.type = 'button';
  const status = statusText(item);
  primary.setAttribute('aria-label', `并行会话：${label(item)}，${status}`);
  const dot = el('span', 'pj-sess-dot pj-runtime-dot ' + stateClass(item));
  dot.setAttribute('aria-hidden', 'true');
  const title = el('span', 'pj-sess-title', label(item));
  primary.append(dot, title, el('span', 'pj-runtime-status', status));
  primary.onclick = () => { void focusConversation(member.conversationId); };
  rowEl.append(primary);

  /* attention 只是一个很轻的小点，点了就清（focus 会让后端把 attention 置回 false）。 */
  if (item?.attention) {
    const attention = el('span', 'pj-runtime-attention');
    attention.setAttribute('aria-label', '需要注意');
    attention.title = '需要注意';
    rowEl.append(attention);
  }
  return rowEl;
}

function newConversationRow() {
  const rowEl = el('button', 'pj-sess pj-runtime-new');
  rowEl.type = 'button';
  rowEl.setAttribute('aria-label', '新建并行会话');
  rowEl.append(el('span', 'pj-runtime-plus', '+'), el('span', 'pj-sess-title', '新建并行会话'));
  rowEl.onclick = () => { if (createHandler) createHandler({ path: currentProjectPath }); else void createParallelConversation(); };
  return rowEl;
}

/** 「新建并行会话」= P32.2 create + P32.3 start 的**编排**，不是第二条创建路径。
 *  两个动作都走已验证的 HTTP 端点，后端返回什么就显示什么（dirty / branch 冲突 /
 *  runtime_limit / workspace_busy 都如实呈现，前端不自己模拟）。 */
async function createParallelConversation() {
  if (!currentProjectPath) return;
  const branch = await askBranchName();
  if (branch === null) return;
  try {
    const list = await fetchWorktrees(currentProjectPath);
    if (!list || list.ok === false) return toast(list?.error || '无法读取工作区列表', 'error');
    const plan = await worktreeAction('prepare', { project: currentProjectPath, branch, source: 'HEAD' }, list.contextGeneration);
    if (!plan || plan.ok === false) return toast(plan?.error || '创建前检查未通过', 'warn');
    const created = await worktreeAction('create', { nonce: plan.nonce }, list.contextGeneration);
    if (!created || created.ok === false) return toast(created?.error || '创建并行会话失败', 'error');
    const workspace = created.workspace;
    const started = await runtimeSessionAction({ action: 'start', args: { id: workspace.id, epoch: workspace.epoch } });
    if (started && started.ok === false) {
      /* 工作区已经建好了，只是 runtime 没起来 —— 如实说清楚，不要谎报成功。 */
      toast(`${started.error || '会话未能启动'}（工作区已创建，可在「工作区管理」里重试）`, 'warn');
    }
    await loadRuntimeNav({ path: currentProjectPath }, { parent });
  } catch (e) {
    toast('新建并行会话失败：' + (e?.message || e), 'error');
  }
}

function askBranchName() {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const suggestion = 'pi-gui/p32/' + Math.random().toString(16).slice(2, 10);
    openModal((card, close) => {
      card.setAttribute('aria-label', '新建并行会话');
      const head = el('div', 'wt-head');
      head.append(el('h3', '', '新建并行会话'));
      const closeBtn = el('button', 'btn', '取消');
      closeBtn.type = 'button';
      closeBtn.onclick = () => { finish(null); close(); };
      head.append(closeBtn);
      card.append(head);
      card.append(el('p', 'modal-desc', '会在所选提交上创建一个独立工作区，并启动一个独立的 Pi 会话。未提交的改动不会被带过去。'));
      const label = el('label', 'wt-field', '分支名');
      const input = el('input');
      input.type = 'text';
      input.value = suggestion;
      input.maxLength = 120;
      label.append(input);
      card.append(label);
      const actions = el('div', 'modal-actions');
      const ok = el('button', 'btn primary', '创建并启动');
      ok.type = 'button';
      /* ⚠️ 这里必须回**真实输入值**。曾经写成 finish(null)，于是任何合法分支名都被
       * 当成「取消」，createParallelConversation() 直接 return —— 按钮看着能点，
       * 实际什么都不做。回归见 tests/runtime-nav.cjs 的「新建并行会话」一节。 */
      ok.onclick = () => { const value = input.value.trim(); if (!value) return; finish(value); close(); };
      actions.append(ok);
      card.append(actions);
      input.focus();
      input.select();
      input.onkeydown = e => { if (e.key === 'Enter') ok.click(); else if (e.key === 'Escape') { finish(null); close(); } };
    });
  });
}

function paint() {
  if (!parent || !parent.isConnected) return;
  if (!host || !host.isConnected || host.parentNode !== parent) {
    host = el('div', 'pj-runtime-list');
    host.id = 'pjRuntimeList';
    parent.prepend(host);
  }
  host.replaceChildren();
  /* 只有确认了 Git 项目身份才给这块（含「新建并行会话」）：非 Git 项目没有
   * worktree，摆一个必然失败的入口比不摆更糟。 */
  host.hidden = !projectId;
  if (!projectId) return;
  for (const member of members) host.append(row(member));
  host.append(newConversationRow());
}
