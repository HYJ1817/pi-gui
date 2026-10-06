/* P32.4-B：中央的「focused conversation」承载。
 *
 * ---------- 它是什么 ----------
 *
 * P32.4-A 让侧栏能列出并行会话并改 focus；这一步把 focus 落到**中央**：点侧栏
 * 一行 → 中央切到那条会话，看到它自己的输出/工具/审批，能发送、停止、重启、关闭。
 *
 * ---------- 为什么不是第二套状态 ----------
 *
 * 状态一律读 runtime-state.js 里那**同一份** store（revision / eventSequence /
 * owner 三条防护复用）。本模块只做投影与动作，不缓存 text/tools/approvals。
 * 唯一自己持有的是**纯视图态**：滚动位置与「正在看哪个会话」——它们不属于
 * runtime 事实，后端也不该知道。
 *
 * ---------- 每个会话必须隔离 ----------
 *
 * draft 存在 store 记录的 `draft` 上（follow P32.3 的做法），滚动位置按
 * conversationId 存在本模块的 Map 里。切 A → B → A，两边都不该串。
 *
 * ---------- dormant：看历史 vs 恢复 Agent ----------
 *
 * 两条路**分开**：
 *   「打开历史」只读后端已证明的 sessionLocator 解析出的正文，**不 spawn**，
 *     因此不占 Runtime slot（默认只有 2 个）；
 *   「恢复会话」才真的 spawn 一个 child。
 * 从历史切回「恢复」时也由用户显式点，不做隐式升级。
 *
 * 本模块**不发**focus —— focus 是侧栏/组合根的职责（见 runtime-nav.js）。
 */
import { runtimeSessionAction, fetchRuntimeHistory } from './api.js';
import { runtimeStore as store, onRuntimeChange } from './runtime-state.js';

const LIFECYCLE = { dormant: '已关闭', starting: '启动中', ready: '就绪', error: '错误', disposing: '清理中' };
const ACTIVITY = { idle: '空闲', running: '运行中', stopping: '正在停止' };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
const same = (a, b) => a && b && Object.keys(a).every(k => a[k] === b[k]);

export function createRuntimeConversation({ host, onNotice = () => {} }) {
  const scrollTops = new Map();
  const historyCache = new Map();
  let id = null, busy = false, alive = true, history = null, historyPending = false, approvalKey = '', renderedId = null;

  const root = el('div', 'runtime-conversation');
  host.append(root);
  /* store 一变就重画。本模块只**订阅**、不自己 apply —— 各视图各自 apply 会把
   * eventSequence 游标吃两遍，第二个视图就再也看不到那一帧。 */
  const unsubscribe = onRuntimeChange(() => { if (alive) draw(); });
  const head = el('div', 'rtc-head');
  const title = el('div', 'rtc-title');
  const state = el('div', 'rtc-state');
  const controls = el('div', 'rtc-controls');
  head.append(title, state, controls); root.append(head);
  const notice = el('p', 'rtc-notice'); notice.setAttribute('role', 'status'); root.append(notice);
  const setNotice = text => { notice.textContent = text; onNotice(text); };
  /* 类名**故意与 modal 的 `.runtime-output` 不同**：官方 modal 用的是全局选择器
   * （测试也这么取），中央再挂一个同名元素会让 `document.querySelector('.runtime-output')`
   * 命中中央那个（它在 DOM 里更靠前），看起来像「modal 的输出不更新」。
   * 两个视图各用各的类名，样式各写各的，不给未来的选择器埋雷。 */
  const output = el('pre', 'rtc-output'); output.tabIndex = 0; output.setAttribute('aria-label', '当前会话输出'); root.append(output);
  const tools = el('div', 'rtc-state'); root.append(tools);
  const approvals = el('div', 'rtc-approvals'); root.append(approvals);
  const input = el('textarea'); input.rows = 3; input.maxLength = 256 * 1024; input.setAttribute('aria-label', '给当前会话的任务'); root.append(input);
  input.oninput = () => { const r = store.get(id); if (r && !history) r.draft = input.value; };

  const send = el('button', 'btn primary', '发送'); send.type = 'button';
  const stop = el('button', 'btn', '停止'); stop.type = 'button';
  const restart = el('button', 'btn', '重启'); restart.type = 'button';
  const end = el('button', 'btn', '关闭会话'); end.type = 'button';
  const resume = el('button', 'btn', '恢复会话'); resume.type = 'button';
  const openHistory = el('button', 'btn', '打开历史'); openHistory.type = 'button';
  for (const b of [send, stop, restart, end, resume, openHistory]) { b.type = 'button'; }
  controls.append(send, stop, restart, end, resume, openHistory);
  send.onclick = () => {
    const r = store.get(id), text = input.value.trim();
    if (!r?.owner || !text || busy) return;
    history = null;                       // 一旦真的要发，就回到实时视图
    const owner = { ...r.owner }, target = id;
    void action({ action: 'command', owner, command: { type: 'prompt', message: text } }, result => {
      const current = store.get(target);
      if (result.ok && same(current?.owner, owner)) { current.draft = ''; if (id === target) input.value = ''; }
    });
  };
  stop.onclick = () => owned('command', { command: { type: 'abort' } });
  restart.onclick = () => owned('restart');
  end.onclick = () => owned('close');
  resume.onclick = () => {
    if (busy) return;
    history = null;
    void action({ action: 'resume', conversationId: id });
  };
  openHistory.onclick = () => { void loadHistory(); };

  async function action(payload, after) {
    if (busy || !alive) return null;
    busy = true; draw();
    try {
      const result = await runtimeSessionAction(payload);
      if (!alive) return null;
      setNotice(result.ok === false ? `${result.error || '操作未完成'}${result.code ? ' (' + result.code + ')' : ''}` : '');
      after?.(result);
      return result;
    } finally { busy = false; if (alive) draw(); }
  }
  /* 每个动作都把 **captured owner** 随请求带走：执行结束时再读「当前 focused」
   * 会把 A 的停止/重启打到 B 上。 */
  function owned(name, extra = {}) { const r = store.get(id); if (r?.owner) void action({ action: name, owner: { ...r.owner }, ...extra }); }

  /** 只读历史：不 spawn，不占 Runtime slot。 */
  async function loadHistory() {
    if (!id || historyPending) return;
    if (historyCache.has(id)) { history = historyCache.get(id); draw(); return; }
    historyPending = true; draw();
    try {
      const result = await fetchRuntimeHistory(id);
      if (!alive) return;
      if (result?.ok === false) { setNotice(result.code === 'history_unavailable' ? '这条会话没有可读的历史（原生记录已失效），只能新建会话。' : '读取历史失败。'); return; }
      history = { messages: result.messages || [], truncated: result.truncated === true };
      historyCache.set(id, history);
    } catch { if (alive) setNotice("读取历史失败。"); }
    finally { historyPending = false; if (alive) draw(); }
  }

  function statusLine(item) {
    if (!item) return '';
    const life = LIFECYCLE[item.lifecycle] || item.lifecycle;
    const act = item.lifecycle === 'ready' ? (ACTIVITY[item.activity] || item.activity) : '';
    const reason = item.error === 'generation_failed' ? ' · 生成失败，请重试或检查模型' : item.error ? ' · 运行异常' : '';
    return `${life}${act ? ' · ' + act : ''}${reason}`;
  }

  function saveScroll() { if (id && !history) scrollTops.set(id, output.scrollTop); }

  function draw() {
    if (!host) return;
    const r = store.get(id);
    root.hidden = !id;
    if (!id) return;
    const label = r?.item?.workspace?.branch || '并行会话';
    title.textContent = label;
    if (history) state.textContent = `只读历史 · ${history.messages.length} 条${history.truncated ? '（仅显示最近部分）' : ''} · 未被启动，不占运行名额`;
    else if (historyPending) state.textContent = '读取历史…';
    else state.textContent = statusLine(r?.item) || (r ? '' : '这条会话还没有记录');

    if (history) {
      output.textContent = history.messages.map(m => `${m.role === 'user' ? '我' : '助手'}：${m.text}`).join('\n\n') || '（没有可显示的正文）';
    } else {
      output.textContent = r?.text || '等待任务';
    }
    tools.textContent = r && !history ? r.tools.map(t => `${t.name} · ${t.state}`).join(' / ') : '';

    if (renderedId !== id || document.activeElement !== input) input.value = history ? '' : (r?.draft || '');
    renderedId = id;
    input.disabled = Boolean(history);
    input.placeholder = history ? '查看历史时不发送；需要继续请点「恢复会话」' : '';

    const live = Boolean(r?.owner);
    send.disabled = busy || !live || r?.item?.lifecycle !== 'ready' || r?.item?.activity === 'stopping' || Boolean(history);
    stop.disabled = busy || !live || r?.item?.activity === 'idle';
    restart.disabled = end.disabled = busy || !live;
    resume.disabled = busy || live;
    openHistory.disabled = busy || live || historyPending;

    const key = JSON.stringify([id, r?.owner, r?.approvals]);
    if (key !== approvalKey) {
      approvalKey = key; approvals.replaceChildren();
      for (const a of r?.approvals || []) {
        const approvalOwner = { ...r.owner }, approvalId = id;
        const row = el('div', 'rtc-approval'); row.append(el('p', '', a.title));
        const respond = response => {
          if (!same(store.get(approvalId)?.owner, approvalOwner)) return Promise.resolve(null);
          return action({ action: 'command', owner: approvalOwner, command: { type: 'extension_ui_response', id: a.id, ...response } });
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
      if (next === id) { draw(); return; }
      saveScroll();
      id = next || null;
      history = historyCache.get(id) || null;
      approvalKey = ''; renderedId = null;
      draw();
    },
    draw,
    /** 离开中央视图时记下滚动位置。 */
    leave() { saveScroll(); },
    dispose() { alive = false; unsubscribe(); root.remove(); },
  };
}
