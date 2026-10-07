/* P32.4-B：中央的「focused conversation」承载。
 *
 * ---------- 它是什么 ----------
 *
 * P32.4-A 让侧栏能列出并行会话并改 focus；这一步把 focus 落到**中央**：点侧栏
 * 一行 → 中央切到那条会话，看到它自己的输出/工具/审批，能发送、停止、重启、关闭。
 *
 * ---------- 为什么不是第二套状态 ----------
 *
 * runtime 真相（text/tools/approvals/owner/lifecycle）一律读 runtime-state.js 里
 * 那**同一份** store，本模块只做投影与动作，不缓存它们。
 *
 * ---------- 视图态必须**按会话**存，不能是模块级单值 ----------
 *
 * `pending` / `notice` / `history` / `pendingHistory` 都是**纯 UI 态**，但它们属于
 * 具体的某条会话。写成模块级单值会出两个真实缺陷：
 *   1) A 的 Stop 还在飞时切到 B，那个 `busy` 会让 **B 的控件被禁用** —— 用户看到
 *      「B 不能操作」，而 B 其实完全可用；
 *   2) A 的迟到响应会写进**当前**会话的 notice / history：切到 B 时，A 的历史会
 *      画到 B 上，A 的错误会显示在 B 的提示条里。
 * 所以这里按 conversationId 保存这些视图态；动作一律在**开始时捕获 target**，
 * 响应回来只写 target 自己的那一格，并且只在「当前看的还是 target」时才重画 DOM。
 *
 * 另外给历史请求记**代次**：同一会话连点两次「打开历史」，先发的后回也不覆盖。
 *
 * ---------- dormant：看历史 vs 恢复 Agent ----------
 *
 * 两条路**分开**：「打开历史」只读后端已证明的 sessionLocator 解析出的正文，
 * **不 spawn**（因此不占 Runtime slot，默认只有 2 个）；「恢复会话」才真的 spawn。
 *
 * 本模块**不发**focus —— focus 是侧栏/组合根的职责（见 runtime-nav.js）。
 */
import { runtimeSessionAction, fetchRuntimeHistory } from './api.js';
import { runtimeStore as store, onRuntimeChange } from './runtime-state.js';
import { launchRuntimeSession, resourceText, runtimeLimitNotice, refreshRuntimeResources } from './runtime-resources.js';

const LIFECYCLE = { dormant: '已关闭', starting: '启动中', ready: '就绪', error: '错误', disposing: '清理中' };
const ACTIVITY = { idle: '空闲', running: '运行中', stopping: '正在停止' };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
const same = (a, b) => a && b && Object.keys(a).every(k => a[k] === b[k]);
const EMPTY = { pending: false, notice: '', history: null, pendingHistory: false, historyToken: 0 };

export function createRuntimeConversation({ host, onNotice = () => {}, openBrowser = null, openProcesses = null }) {
  const scrollTops = new Map();       // conversationId -> scrollTop
  const historyCache = new Map();     // conversationId -> { messages, truncated }
  const views = new Map();            // conversationId -> 该会话自己的纯 UI 态
  let id = null, alive = true, active = false, focusEpoch = 0, approvalKey = '', renderedId = null;

  function viewOf(conversationId) {
    let view = views.get(conversationId);
    if (!view) { view = { ...EMPTY }; views.set(conversationId, view); }
    return view;
  }
  /* 当前会话的视图态；没有选中会话时给一个不会被写回的占位对象。 */
  const current = () => (id ? viewOf(id) : EMPTY);

  const root = el('div', 'runtime-conversation');
  host.append(root);
  /* store 一变就重画。本模块只**订阅**、不自己 apply —— 各视图各自 apply 会把
   * eventSequence 游标吃两遍，第二个视图就再也看不到那一帧。 */
  const unsubscribe = onRuntimeChange(() => { if (alive) { focusResumed(); draw(); } });
  function focusResumed() {
    const view = current(), record = store.get(id);
    if (!active || !view.focusOnReady || !record?.owner || record.item.lifecycle !== 'ready'
      || typeof record.owner.sessionId !== 'string' || !record.owner.sessionId) return;
    if (record.owner.runtimeId !== view.focusOnReady) return;
    view.focusOnReady = null;
    // A resumed history view has no prior live focus. Bind only the current
    // target, with its ready owner; switching away cancels this intent.
    void runtimeSessionAction({ action: 'focus', owner: { ...record.owner } }).catch(() => {});
  }

  const head = el('div', 'rtc-head');
  const title = el('div', 'rtc-title');
  const state = el('div', 'rtc-state');
  const resources = el('div', 'runtime-resource-count'); resources.setAttribute('role', 'status');
  const controls = el('div', 'rtc-controls');
  head.append(title, state, resources, controls); root.append(head);
  const notice = el('p', 'rtc-notice'); notice.setAttribute('role', 'status'); root.append(notice);
  /* 类名**故意与 modal 的 `.runtime-output` 不同**：官方 modal 用的是全局选择器
   * （测试也这么取），中央再挂一个同名元素会让 `document.querySelector('.runtime-output')`
   * 命中中央那个（它在 DOM 里更靠前），看起来像「modal 的输出不更新」。 */
  const output = el('pre', 'rtc-output'); output.tabIndex = 0; output.setAttribute('aria-label', '当前会话输出'); root.append(output);
  const tools = el('div', 'rtc-state'); root.append(tools);
  const approvals = el('div', 'rtc-approvals'); root.append(approvals);
  const input = el('textarea'); input.rows = 3; input.maxLength = 256 * 1024; input.setAttribute('aria-label', '给当前会话的任务'); root.append(input);
  input.oninput = () => { const r = store.get(id); if (r && !current().history) r.draft = input.value; };

  const send = el('button', 'btn primary', '发送'); send.type = 'button';
  const stop = el('button', 'btn', '停止'); stop.type = 'button';
  const restart = el('button', 'btn', '重启'); restart.type = 'button';
  const end = el('button', 'btn', '关闭会话'); end.type = 'button';
  const resume = el('button', 'btn', '恢复会话'); resume.type = 'button';
  const historyBtn = el('button', 'btn', '打开历史'); historyBtn.type = 'button';
  controls.append(send, stop, restart, end, resume, historyBtn);
  const browserBtn = el('button', 'btn', 'Browser'), processBtn = el('button', 'btn', '开发进程');
  browserBtn.type = processBtn.type = 'button';
  browserBtn.hidden = !openBrowser || !window.piGuiDesktop?.runtimeBrowser;
  processBtn.hidden = !openProcesses;
  browserBtn.onclick = () => openBrowser?.(); processBtn.onclick = () => openProcesses?.();
  controls.append(browserBtn, processBtn);

  send.onclick = () => {
    const target = id;
    const r = store.get(target), text = input.value.trim();
    if (!target || !r?.owner || !text || current().pending) return;
    viewOf(target).history = null;        // 一旦真的要发，就回到实时视图
    const owner = { ...r.owner };
    void action(target, { action: 'command', owner, command: { type: 'prompt', message: text } }, (result) => {
      const still = store.get(target);
      if (result.ok && same(still?.owner, owner)) { still.draft = ''; if (id === target) input.value = ''; }
    });
  };
  stop.onclick = () => owned('command', { command: { type: 'abort' } });
  restart.onclick = () => owned('restart');
  end.onclick = () => owned('close');
  resume.onclick = () => {
    const target = id;
    const selection = focusEpoch;
    if (!target || current().pending) return;
    void action(target, { action: 'resume', conversationId: target }, result => {
      if (result.ok) {
        viewOf(target).history = null;
        if (active && id === target && selection === focusEpoch) { viewOf(target).focusOnReady = result.owner?.runtimeId || null; focusResumed(); }
      }
    });
  };
  historyBtn.onclick = () => { void loadHistory(); };

  /** 发一个动作。target 在**开始时捕获**，响应只写 target 自己的视图态。 */
  async function action(target, payload, after) {
    const view = viewOf(target);
    if (view.pending || !alive) return null;
    view.pending = true; if (id === target) draw();
    try {
      const result = await (payload.action === 'resume' ? launchRuntimeSession(payload) : runtimeSessionAction(payload));
      if (!alive) return null;
      /* 迟到响应只更新 **target** 那一格：切到别的会话时既不改当前 DOM，
       * 也不改当前会话的 notice —— 切回去才看得到它自己的结果。 */
      view.notice = result.cancelled ? '' : runtimeLimitNotice(result) || (result.ok === false ? `${result.error || '操作未完成'}${result.code ? ' (' + result.code + ')' : ''}` : '');
      after?.(result);
      if (payload.action === 'close' || payload.action === 'restart') await refreshRuntimeResources();
      return result;
    } finally {
      view.pending = false;
      if (alive && id === target) draw();
    }
  }
  /* 每个动作都把 **captured owner** 随请求带走：执行结束时再读「当前 focused」
   * 会把 A 的停止/重启打到 B 上。 */
  function owned(name, extra = {}) { const target = id, r = store.get(target); if (target && r?.owner) void action(target, { action: name, owner: { ...r.owner }, ...extra }); }

  /** 只读历史：不 spawn，不占 Runtime slot。请求归属、缓存键、结果归属都用 captured target。 */
  async function loadHistory() {
    const target = id;
    if (!target) return;
    const view = viewOf(target);
    if (view.pendingHistory) return;
    if (historyCache.has(target)) { view.history = historyCache.get(target); if (id === target) draw(); return; }
    const token = ++view.historyToken;
    view.pendingHistory = true; if (id === target) draw();
    try {
      const result = await fetchRuntimeHistory(target);
      /* 代次对不上（同一会话又发了一次）或已销毁 → 丢弃这个响应。 */
      if (!alive || view.historyToken !== token) return;
      if (result?.ok === false) {
        view.notice = result.code === 'history_unavailable' ? '这条会话没有可读的历史（原生记录已失效），只能新建会话。' : '读取历史失败。';
        return;
      }
      const payload = { messages: result.messages || [], truncated: result.truncated === true };
      historyCache.set(target, payload);
      /* 只写 **target** 的历史：中央已经切到别的会话时，B 的 DOM 一个字都不动。 */
      view.history = payload;
    } catch { if (alive && view.historyToken === token) view.notice = '读取历史失败。'; }
    finally {
      if (view.historyToken === token) view.pendingHistory = false;
      if (alive && id === target) draw();
    }
  }

  function statusLine(item) {
    if (!item) return '';
    const life = LIFECYCLE[item.lifecycle] || item.lifecycle;
    const act = item.lifecycle === 'ready' ? (ACTIVITY[item.activity] || item.activity) : '';
    const reason = item.error === 'generation_failed' ? ' · 生成失败，请重试或检查模型' : item.error ? ' · 运行异常' : '';
    if (item.error === 'cleanup_pending') return '清理未完成 · 运行名额仍被占用';
    return `${life}${act ? ' · ' + act : ''}${reason}`;
  }

  function saveScroll() { if (id && !current().history) scrollTops.set(id, output.scrollTop); }

  function draw() {
    if (!host) return;
    const r = store.get(id), view = current();
    root.hidden = !id;
    if (!id) return;
    title.textContent = r?.item?.workspace?.branch || '并行会话';
    resources.textContent = resourceText();
    notice.textContent = view.notice;
    if (view.history) state.textContent = `只读历史 · ${view.history.messages.length} 条${view.history.truncated ? '（仅显示最近部分）' : ''} · 未被启动，不占运行名额`;
    else if (view.pendingHistory) state.textContent = '读取历史…';
    else state.textContent = statusLine(r?.item) || (r ? '' : '这条会话还没有记录');

    if (view.history) {
      output.textContent = view.history.messages.map(m => `${m.role === 'user' ? '我' : '助手'}：${m.text}`).join('\n\n') || '（没有可显示的正文）';
    } else {
      output.textContent = r?.text || '等待任务';
    }
    tools.textContent = r && !view.history ? r.tools.map(t => `${t.name} · ${t.state}`).join(' / ') : '';

    if (renderedId !== id || document.activeElement !== input) input.value = view.history ? '' : (r?.draft || '');
    renderedId = id;
    input.disabled = Boolean(view.history);
    input.placeholder = view.history ? '查看历史时不发送；需要继续请点「恢复会话」' : '';

    /* 这些判据全部来自**当前会话自己的**视图态 —— A 的 pending 不会禁用 B 的控件。 */
    const live = Boolean(r?.owner), busy = view.pending;
    send.disabled = busy || !live || r?.item?.lifecycle !== 'ready' || r?.item?.activity === 'stopping' || Boolean(view.history);
    stop.disabled = busy || !live || r?.item?.activity === 'idle';
    restart.disabled = end.disabled = busy || !live;
    resume.disabled = busy || live;
    historyBtn.disabled = busy || live || view.pendingHistory;

    const key = JSON.stringify([id, r?.owner, r?.approvals]);
    if (key !== approvalKey) {
      approvalKey = key; approvals.replaceChildren();
      for (const a of r?.approvals || []) {
        const approvalOwner = { ...r.owner }, approvalId = id;
        const row = el('div', 'rtc-approval'); row.append(el('p', '', a.title));
        const respond = response => {
          if (!same(store.get(approvalId)?.owner, approvalOwner)) return Promise.resolve(null);
          return action(approvalId, { action: 'command', owner: approvalOwner, command: { type: 'extension_ui_response', id: a.id, ...response } });
        };
        if (a.method === 'confirm') { const yes = el('button', 'btn', '确认'); const no = el('button', 'btn', '拒绝'); yes.type = no.type = 'button'; yes.onclick = () => respond({ confirmed: true }); no.onclick = () => respond({ confirmed: false }); row.append(yes, no); }
        else if (a.method === 'select') for (const value of a.options) { const b = el('button', 'btn', value); b.type = 'button'; b.onclick = () => respond({ value }); row.append(b); }
        else { const value = el('textarea'); value.setAttribute('aria-label', a.title || '审批输入'); const submit = el('button', 'btn', '提交'); submit.type = 'button'; submit.onclick = () => respond({ value: value.value }); row.append(value, submit); }
        const cancel = el('button', 'btn', '取消'); cancel.type = 'button'; cancel.onclick = () => respond({ cancelled: true }); row.append(cancel);
        approvals.append(row);
      }
    }
    /* 恢复滚动位置（按 conversationId 隔离）：切回 A 时不该停在 B 的位置。 */
    const top = scrollTops.get(id);
    output.scrollTop = top === undefined ? output.scrollHeight : top;
  }

  return {
    element: root,
    get conversationId() { return id; },
    /** 切到某条会话。dormant 时只清历史缓存，**不**自动去读、更不 spawn。 */
    show(next) {
      focusEpoch++;
      active = true;
      if (next === id) { draw(); return; }
      saveScroll();
      if (id) viewOf(id).focusOnReady = null;
      id = next || null;
      approvalKey = ''; renderedId = null;
      draw();
    },
    draw,
    /** 离开中央视图时记下滚动位置。 */
    leave() { active = false; focusEpoch++; saveScroll(); if (id) viewOf(id).focusOnReady = null; },
    dispose() { alive = false; unsubscribe(); root.remove(); },
  };
}
