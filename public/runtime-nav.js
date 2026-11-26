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
import { runtimeStore as store, onRuntimeChange, seedRuntimeSnapshot } from './runtime-state.js';
import { launchRuntimeSession, resourceText, runtimeActionNotice } from './runtime-resources.js';
import { openRuntimeSessions } from './runtime-sessions.js';
import { generateAiTitle, isTitleGenerating, renameSessionTitle, titleCapability } from './session-titles.js';
import { MENU_ICONS, openActionMenu } from './ui/action-menu.js';
import { iconMarkup } from './ui/icons.js';
import { openModal } from './ui/modal.js';
import { feedbackContext, toast } from './ui/toast.js';
import { samePath } from './util.js';

/* 侧栏自己订阅 store 的变化 —— 不依赖任何视图模块替它接线。 */
onRuntimeChange(() => repaintRuntimeNav());

const LIFECYCLE = { dormant: '已关闭', starting: '启动中', ready: '就绪', error: '错误', disposing: '清理中' };
const ACTIVITY = { idle: '空闲', running: '运行中', stopping: '正在停止' };
/* P4-E：只展示后端归一好的四种终态，不在前端按错误文本猜结果。 */
const OUTCOME = {
  completed: { text: '已完成', title: '后台运行已完成' },
  failed: { text: '失败', title: '后台运行失败' },
  interrupted: { text: '已中断', title: '后台运行已中断' },
  unknown: { text: '已结束', title: '后台运行已结束，结果未确认' },
};

/* 与经典会话行共用同一个三点图形常量来源（不是字符图标）。 */
const SVG_MORE = iconMarkup('more');

/** Runtime 行的手动标题入口：与经典会话共用同一套生成 / 改名服务。
 *  Runtime 会话可能还在后台运行或已经关闭；改名只写 pi-GUI 元数据，
 *  不 focus、不重启、不打断正在跑的回合。 */
function runtimeTitleItems(conversationId, item, rowEl, titleEl) {
  const busy = isTitleGenerating('runtime:' + conversationId);
  const noSession = !item?.nativeSessionId;
  const items = [];
  if (titleCapability().supported !== false) {
    items.push({
      label: busy ? 'AI 生成标题中…' : 'AI 生成标题',
      icon: MENU_ICONS.spark,
      disabled: busy || noSession,
      disabledReason: busy ? '正在生成标题，请稍候。' : '这条会话还没有可读取的 Pi 会话记录。',
      onClick: () => { void generateAiTitle({ scope: 'runtime', conversationId }); },
    });
  }
  items.push({
    label: '重命名',
    icon: MENU_ICONS.pencil,
    disabled: !item || !rowEl || !titleEl,
    disabledReason: '这条并行会话还没有可用的标题记录。',
    onClick: () => startRuntimeRename(rowEl, titleEl, conversationId, item),
  });
  return items;
}

/** 行内改名：Enter 保存、Escape 取消、失焦保存合法改动。
 *  不调用 focus，也不改变运行状态；失败恢复原标题并提示。 */
function startRuntimeRename(rowEl, titleEl, conversationId, item) {
  if (rowEl.querySelector('.pj-sess-input')) return;
  /* 行元素捕获的 item 可能是上一次渲染的快照；标题修订号以 store 当前值为准，
   * 否则连续第二次改名会拿旧修订反复撞 conflict。 */
  const freshItem = () => store.get(conversationId)?.item || item || null;
  const input = el('input', 'pj-sess-input');
  input.type = 'text';
  input.value = label(freshItem());
  input.maxLength = 80;
  input.setAttribute('aria-label', `重命名并行会话：${label(freshItem())}`);
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const restore = () => { if (input.isConnected) input.replaceWith(titleEl); };
  const finish = async (save) => {
    if (done) return;
    const value = input.value.replace(/\s+/g, ' ').trim();
    const before = label(freshItem());
    if (!save || !value || value === before) {
      done = true;
      restore();
      return;
    }
    done = true;
    input.disabled = true;
    input.setAttribute('aria-busy', 'true');
    try {
      const res = await renameSessionTitle({
        scope: 'runtime',
        conversationId,
        expectedRevision: freshItem()?.titleRevision || 0,
      }, value);
      if (res?.ok !== true) {
        if (res?.code === 'revision_conflict' && typeof res.title === 'string' && res.title) {
          titleEl.textContent = res.title;
        }
        restore();
        toast((res && res.error) || '改名失败，已保留原标题', 'error');
        return;
      }
      titleEl.textContent = res.title;
      /* SSE / 事件门槛可能因为别的原因没有落到 store（例如测试里的短 id），
       * 成功应答本身是权威的：就地记下新修订，连续第二次改名不会拿旧值。 */
      if (Number.isSafeInteger(res.revision)) {
        store.patchTitle(conversationId, { title: res.title, source: 'manual', revision: res.revision });
      }
      restore();
      toast('已改名：' + res.title, 'info');
    } catch (err) {
      restore();
      toast('改名失败：' + (err?.message || err), 'error');
    }
  };
  input.onclick = (e) => e.stopPropagation();
  input.onpointerdown = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
}

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
let focusIntent = 0;

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
  if (project?.path !== currentProjectPath) focusIntent++;
  if (typeof project?.path === 'string') currentProjectPath = project.path;
  const path = project?.path || '';
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
  const ordinary = snapshot.items.find(item=>item.kind==='project'&&samePath(item.workspace?.cwd,path));
  projectId = typeof worktrees?.projectId === 'string' ? worktrees.projectId : ordinary?.workspace?.projectId || '';
  seedRuntimeSnapshot(snapshot);
  members = (projectId ? snapshot.items : [])
    .filter(item => item.kind==='project' ? samePath(item.workspace?.cwd,path) : item?.workspace?.projectId === projectId)
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
    if (!known.has(id) && (record.owner.projectId === projectId || record.item.kind==='project'&&samePath(record.item.workspace?.cwd,currentProjectPath))) { void loadRuntimeNav({ path: currentProjectPath }, { parent }); return; }  }
  paint();
}

export function clearRuntimeNav() { members = []; projectId = ''; token++; focusIntent++; host = null; loading = null; }

function label(item) {
  if (item?.title) return item.title;
  const branch = item?.workspace?.branch;
  if (branch) return branch;
  return '并行会话';
}

function outcomeMeta(item) {
  return item?.outcome && OUTCOME[item.outcome.kind] ? item.outcome.kind : null;
}

function statusText(item) {
  if (!item) return '';
  if (store.get(item.conversationId)?.approvals.length) return '待审批';
  if (item.activity === 'stopping') return '正在停止';
  if (item.activity === 'running') return '运行中';
  const kind = outcomeMeta(item);
  const problem = item.error === 'cleanup_pending' ? '清理未完成' : item.lifecycle === 'error' ? '错误' : null;
  /* 终态是这一轮的结果，lifecycle/error 是会话当前是否可用；两者同时存在时
   * 都保留，避免后台完成把随后发生的空闲断线错误盖掉（P4-C 原有错误可见性）。 */
  if (kind) return problem ? `${OUTCOME[kind].text} · ${problem}` : OUTCOME[kind].text;
  if (problem) return problem;
  return LIFECYCLE[item.lifecycle] || item.lifecycle;
}

/* 视觉只用**一个**轻量状态点 + 一行文字，不加彩色 badge（P30 的信息密度）。 */
function stateClass(item) {
  if (!item) return 'dormant';
  if (item.activity === 'stopping') return 'stopping';
  if (item.activity === 'running') return 'running';
  const kind = outcomeMeta(item);
  if (kind) return 'outcome-' + kind;
  if (item.lifecycle === 'error') return 'error';
  return item.lifecycle;
}

async function focusConversation(conversationId, { isCurrent = () => true } = {}) {
  const intent = ++focusIntent;
  const project = projectId;
  const record = store.get(conversationId);
  if (!record?.owner) {
    /* dormant：没有 live runtime，**不能**发 focus（后端也没有 owner 可校验），
     * 更不能顺手 spawn 一个。只把意图交给中央视图（P32.4-B 的「打开历史」），
     * 需要继续执行时由用户显式恢复。 */
    if (isCurrent()) focusHandler?.(conversationId);
    return;
  }
  /* captured owner：动作触发时取一次，迟到响应不改别的会话。 */
  const owner = { ...record.owner };
  try {
    const result = await runtimeSessionAction({ action: 'focus', owner });
    if (result?.ok === false) return;
  } catch { return; }
  if (!isCurrent() || intent !== focusIntent || project !== projectId || !store.get(conversationId)?.owner
    || Object.keys(owner).some(key => store.get(conversationId).owner[key] !== owner[key])) return;
  focusHandler?.(conversationId);
}
export const focusRuntimeById = (conversationId, options) => focusConversation(conversationId, options);

function row(member) {
  const item = store.get(member.conversationId)?.item || null;
  const rowEl = el('div', 'pj-sess pj-runtime' + (item?.focused ? ' on' : ''));
  rowEl.dataset.conversationId = member.conversationId;
  const kind = outcomeMeta(item);
  if (kind) rowEl.dataset.outcome = kind;
  if (item?.focused) rowEl.setAttribute('aria-current', 'true');

  const primary = el('button', 'pj-sess-primary');
  primary.type = 'button';
  const status = statusText(item);
  primary.setAttribute('aria-label', `并行会话：${label(item)}，${status}`);
  if (kind) primary.title = OUTCOME[kind].title;
  const dot = el('span', 'pj-sess-dot pj-runtime-dot ' + stateClass(item));
  dot.setAttribute('aria-hidden', 'true');
  const title = el('span', 'pj-sess-title', label(item));
  const statusEl = el('span', 'pj-runtime-status' + (kind ? ' outcome-' + kind : ''), status);
  if (kind) statusEl.title = OUTCOME[kind].title;
  primary.append(dot, title, statusEl);
  primary.onclick = () => { void focusConversation(member.conversationId); };
  primary.onkeydown = event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...host.querySelectorAll('.pj-sess-primary')];
    const position = buttons.indexOf(primary);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault(); buttons[next]?.focus();
  };
  rowEl.append(primary);

  const titleItems = runtimeTitleItems(member.conversationId, item, rowEl, title);
  if (titleItems.length) {
    const acts = el('span', 'pj-sess-acts');
    const trigger = el('button', 'pj-sess-menu-trigger row-action-trigger');
    trigger.type = 'button';
    trigger.title = '更多操作';
    trigger.setAttribute('aria-label', `会话操作：${label(item)}`);
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = SVG_MORE;
    trigger.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openActionMenu(trigger, titleItems);
    };
    acts.append(trigger);
    rowEl.append(acts);
  }

  /* attention 只是一个很轻的小点，点了就清（focus 会让后端把 attention 置回 false）。 */
  if (item?.attention) {
    const attention = el('span', 'pj-runtime-attention');
    attention.setAttribute('aria-label', '需要注意');
    attention.title = '需要注意';
    rowEl.append(attention);
  }
  return rowEl;
}

function resultMembers() {
  return members
    .map(member => ({ member, item: store.get(member.conversationId)?.item || null }))
    .filter(entry => outcomeMeta(entry.item));
}

function resultBreakdown(results) {
  const counts = { completed: 0, failed: 0, interrupted: 0, unknown: 0 };
  for (const entry of results) counts[outcomeMeta(entry.item)]++;
  return [['completed', '已完成'], ['failed', '失败'], ['interrupted', '已中断'], ['unknown', '已结束']]
    .filter(([kind]) => counts[kind])
    .map(([kind, text]) => `${text} ${counts[kind]}`)
    .join('、');
}

/* P4-E：一个项目只放**一条**聚合提示，不按会话追加通知。单条结果直接去；
 * 多条打开已有 Runtime 列表（不自动切换会话），由用户在那里选具体结果。 */
function resultsRow(results) {
  const result = el('button', 'pj-runtime-results');
  result.type = 'button';
  const breakdown = resultBreakdown(results);
  result.setAttribute('aria-label', `${results.length} 个后台会话有结果：${breakdown}。查看结果`);
  result.title = `后台会话结果：${breakdown}`;
  result.append(
    el('span', 'pj-runtime-results-text', `${results.length} 个后台会话有结果`),
    el('span', 'pj-runtime-results-hint', '查看'),
  );
  result.onclick = () => {
    if (results.length === 1) { void focusConversation(results[0].item.conversationId); return; }
    const latest = [...results].sort((a, b) => (b.item.revision || 0) - (a.item.revision || 0))[0];
    openRuntimeSessions({ path: currentProjectPath }, null, { selectedId: latest?.item?.conversationId });
  };
  return result;
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
 *  workspace_busy 都如实呈现，前端不自己模拟）。 */
export async function createParallelConversation(project = null) {
  const projectPath = project?.path || currentProjectPath;
  if (!projectPath) return;
  const context = feedbackContext();
  const branch = await askBranchName();
  if (branch === null) return;
  try {
    const list = await fetchWorktrees(projectPath);
    if (!list || list.ok === false) return toast(list?.error || '无法读取工作区列表', 'error', { context });
    const plan = await worktreeAction('prepare', { project: projectPath, branch, source: 'HEAD' }, list.contextGeneration);
    if (!plan || plan.ok === false) return toast(plan?.error || '创建前检查未通过', 'warn', { context });
    const created = await worktreeAction('create', { nonce: plan.nonce }, list.contextGeneration);
    if (!created || created.ok === false) return toast(created?.error || '创建并行会话失败', 'error', { context });
    const workspace = created.workspace;
    const started = await launchRuntimeSession({ action: 'start', args: { id: workspace.id, epoch: workspace.epoch } });
    if (started?.cancelled) toast('未启动会话。工作区已创建，可稍后从「工作区管理」启动。', 'info', { context });
    if (started && started.ok === false && !started.cancelled) {
      /* 工作区已经建好了，只是 runtime 没起来 —— 如实说清楚，不要谎报成功。 */
      toast(`${runtimeActionNotice(started) || started.error || '会话未能启动'}（工作区已创建，可在「工作区管理」里重试）`, 'warn', { context });
    }
    if (!project || projectPath === currentProjectPath) await loadRuntimeNav({ path: projectPath }, { parent });
    if (started?.ok && started.owner) await focusConversation(started.owner.conversationId);
  } catch (e) {
    toast('新建并行会话失败：' + (e?.message || e), 'error', { context });
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
  const focused = host.contains(document.activeElement) ? document.activeElement.closest('[data-conversation-id]')?.dataset.conversationId : null;
  const newFocused = host.contains(document.activeElement) && document.activeElement.classList.contains('pj-runtime-new');
  const resultsFocused = host.contains(document.activeElement) && document.activeElement.classList.contains('pj-runtime-results');
  host.replaceChildren();
  /* 只有确认了 Git 项目身份才给这块（含「新建并行会话」）：非 Git 项目没有
   * worktree，摆一个必然失败的入口比不摆更糟。 */
  host.hidden = !projectId;
  if (!projectId) return;
  const resources = el('div', 'runtime-resource-count', resourceText());
  resources.setAttribute('role', 'status');
  host.append(resources);
  const results = resultMembers();
  if (results.length) host.append(resultsRow(results));
  for (const member of members) host.append(row(member));
  host.append(newConversationRow());
  if (resultsFocused) {
    const aggregate = host.querySelector('.pj-runtime-results');
    /* 单条结果激活后入口会被读掉并消失；焦点不能掉到 body，交给已经
     * 切过去的会话行（没有则退回「新建并行会话」）。 */
    (aggregate || host.querySelector('.pj-runtime.on .pj-sess-primary') || host.querySelector('.pj-runtime-new'))
      ?.focus({ preventScroll: true });
  } else if (focused) [...host.querySelectorAll('[data-conversation-id]')].find(row => row.dataset.conversationId === focused)?.querySelector('button')?.focus({ preventScroll: true });
  else if (newFocused) host.querySelector('.pj-runtime-new')?.focus({ preventScroll: true });
}

document.addEventListener('pi-gui:workspace-view', event => { if (event.detail?.view !== 'runtime') focusIntent++; });
