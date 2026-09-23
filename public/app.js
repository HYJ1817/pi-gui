/* Pi GUI — 前端
 *
 * 数据流：SSE 收 pi 的 RPC 事件 → 渲染；POST /api/command 发命令。
 * 关键约定（来自 pi docs/rpc.md）：
 *   - message_update 只给 delta，不带累积快照；需要按 contentIndex 自行组装，
 *     并以 message_end.message 为最终权威。
 *   - tool_execution_update.partialResult 是「累积」值，直接替换显示即可。
 *   - 权限确认走 extension_ui_request / extension_ui_response 子协议。
 */

const $ = (id) => document.getElementById(id);

const el = {
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

/* 弹层内的动态容器；关闭弹层时置空，防止写入已卸载节点 */
let treeContainer = null;
let providerContainer = null;

const S = {
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

/* ============ 工具函数 ============ */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmt(n) {
  if (n == null || n === 0) return '0';
  // 用 Number() 去掉小数尾零：61000 → 61k，1000000 → 1M，1500000 → 1.5M
  const trim = (x) => String(Number(x.toFixed(2)));
  if (n >= 1e6) return trim(n / 1e6) + 'M';
  if (n >= 1e3) return trim(n / 1e3) + 'k';
  return String(n);
}

/* 轻量 markdown 渲染。按行扫描成块：段落 / 有序无序列表 / 标题 / 代码块。
 * 之前的实现把每个 \n 都换成 <br>，于是代码块前后各留一对 <br>，
 * 叠在块级元素上就出现了大片空白，列表也退化成一堆字面量短横线。 */
function md(src) {
  const codes = [];
  const s = String(src).replace(/```(\w*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    codes.push(code.replace(/\n$/, ''));
    return `\u0000${codes.length - 1}\u0000`;
  });

  const inline = (t) =>
    esc(t)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  const out = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (!para.length) return;
    out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>` + list.items.map((t) => '<li>' + inline(t) + '</li>').join('') + `</${list.tag}>`);
    list = null;
  };
  const openList = (tag) => {
    if (!list || list.tag !== tag) {
      flushList();
      list = { tag, items: [] };
    }
  };

  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();

    const ph = /^\u0000(\d+)\u0000$/.exec(t);
    if (ph) {
      flushPara();
      flushList();
      out.push(`<pre class="code"><code>${esc(codes[+ph[1]])}</code></pre>`);
      continue;
    }

    if (!t) {
      flushPara();
      flushList();
      continue;
    }

    const h = /^(#{1,6}) (.+)$/.exec(t);
    if (h) {
      flushPara();
      flushList();
      out.push('<h4>' + inline(h[2]) + '</h4>');
      continue;
    }

    const ul = /^[-*+] (.+)$/.exec(t);
    if (ul) {
      flushPara();
      openList('ul');
      list.items.push(ul[1]);
      continue;
    }

    const ol = /^\d+[.)] (.+)$/.exec(t);
    if (ol) {
      flushPara();
      openList('ol');
      list.items.push(ol[1]);
      continue;
    }

    flushList();
    para.push(t);
  }

  flushPara();
  flushList();
  return out.join('');
}

function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  return '';
}

function resultText(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  if (Array.isArray(res.content)) return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (typeof res.text === 'string') return res.text;
  return '';
}

const ICONS = {
  terminal: '<svg viewBox="0 0 24 24"><polyline points="5 8 9.5 12 5 16"/><path d="M12.5 16h6.5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M16.5 4.5l3 3L8.5 18.5 4.5 20l1.5-4z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
  tool: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 1 5 5l-8.4 8.4a2 2 0 0 1-2.8-2.8z"/><path d="M5 5l4 4"/></svg>',
};

const TOOL_META = {
  bash: { label: '执行命令', icon: 'terminal' },
  read: { label: '读取文件', icon: 'file' },
  write: { label: '写入文件', icon: 'file' },
  edit: { label: '编辑文件', icon: 'edit' },
  glob: { label: '查找文件', icon: 'search' },
  grep: { label: '搜索内容', icon: 'search' },
};

function summarizeArgs(name, args) {
  if (!args) return '';
  if (typeof args === 'string') return args;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query']) {
    if (typeof args[k] === 'string') return args[k];
  }
  const first = Object.values(args).find((v) => typeof v === 'string');
  return first || JSON.stringify(args).slice(0, 90);
}

/* ============ 基础 UI ============ */

function toast(msg, kind = 'info') {
  if (!msg) return;
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'error' ? ' error' : kind === 'warn' ? ' warn' : '');
  t.textContent = msg;
  el.toasts.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 260);
  }, 4200);
}

function setConn(kind, text) {
  el.conn.className = 'conn' + (kind ? ' ' + kind : '');
  el.connText.textContent = text;
}

function setStatus(text) {
  el.statusText.textContent = text || '';
}

function setTitleText(t) {
  if (!t) return;
  el.title.textContent = t;
}

/* ============ 浮层 ============
 * 模型选择、思考等级、上下文提示都用同一套：锚在触发元素上方，
 * 右边缘对齐，越界时自动收回视口内。 */

const pop = document.createElement('div');
pop.className = 'pop';
pop.hidden = true;
document.body.appendChild(pop);

let popAnchor = null;

function closePop() {
  pop.hidden = true;
  pop.innerHTML = '';
  pop.classList.remove('tip-mode');
  popAnchor = null;
}

function showPop(anchor, { tip = false, align = 'right' } = {}) {
  pop.classList.toggle('tip-mode', tip);
  pop.hidden = false;

  const a = anchor.getBoundingClientRect();
  const r = pop.getBoundingClientRect();

  let left = align === 'left' ? a.left : a.right - r.width;
  left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));

  let top = a.top - r.height - 8;
  if (top < 8) top = Math.max(8, Math.min(a.bottom + 8, window.innerHeight - r.height - 8));

  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
  popAnchor = anchor;
}

document.addEventListener('mousedown', (e) => {
  if (pop.hidden) return;
  if (pop.contains(e.target)) return;
  if (popAnchor && (popAnchor === e.target || popAnchor.contains(e.target))) return;
  closePop();
});

window.addEventListener('resize', closePop);
window.addEventListener('blur', closePop);

function popTitle(text) {
  const d = document.createElement('div');
  d.className = 'pop-title';
  d.textContent = text;
  return d;
}

function popLabel(text) {
  const d = document.createElement('div');
  d.className = 'pop-label';
  d.textContent = text;
  return d;
}

function popSep() {
  const d = document.createElement('div');
  d.className = 'pop-sep';
  return d;
}

function popItem({ label, sub, on, onClick }) {
  const d = document.createElement('div');
  d.className = 'pop-item' + (on ? ' on' : '');

  const t = document.createElement('span');
  t.className = 'pi-text';
  t.textContent = label;
  d.appendChild(t);

  if (sub) {
    const s = document.createElement('span');
    s.className = 'pi-sub';
    s.textContent = sub;
    d.appendChild(s);
  }

  const c = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  c.setAttribute('viewBox', '0 0 24 24');
  c.setAttribute('class', 'pi-check');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7');
  c.appendChild(p);
  d.appendChild(c);

  d.onclick = onClick;
  return d;
}

/* pi 的 export_html 不传 outputPath 时会返回相对文件名（落在 pi 的 cwd 下），
 * 这里补成绝对路径，免得用户找不到文件。 */
function absPath(p) {
  if (!p) return '';
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return p;
  const base = S.cwd || '';
  if (!base) return p;
  const sep = base.includes('\\') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + p.replace(/^[\\/]+/, '');
}

function openModal(build) {
  el.modalCard.innerHTML = '';
  // 弹层里的动态区域在关闭时失效，避免继续往已卸载的节点里写
  treeContainer = null;
  providerContainer = null;
  const close = () => {
    el.modal.hidden = true;
    el.modalCard.innerHTML = '';
    treeContainer = null;
    providerContainer = null;
  };
  build(el.modalCard, close);
  el.modal.hidden = false;
}

el.modal.addEventListener('click', (e) => {
  if (e.target === el.modal) {
    el.modal.hidden = true;
    el.modalCard.innerHTML = '';
    treeContainer = null;
    providerContainer = null;
  }
});

/* ============ 通信 ============ */

async function send(cmd) {
  try {
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const j = await r.json();
    if (!j.ok) toast(j.error || '命令发送失败', 'error');
    return j;
  } catch (err) {
    toast('无法连接后端：' + err.message, 'error');
    return { ok: false };
  }
}

/* 记录 pi 的工作目录，用于把相对路径补成绝对路径 */
async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const j = await r.json();
    S.cwd = j.cwd || '';
    // hasProject 由后端显式给出；老后端没有这个字段时退回「cwd 非空」的判断
    S.hasProject = j.hasProject ?? Boolean(S.cwd);
  } catch {
    S.cwd = '';
    S.hasProject = false;
  }
  applyProjectState();
}

/** 「有没有项目」决定整块界面的形态。
 *
 * 没有项目时 pi 是不启动的，任何命令都会 503。所以这里必须把输入区锁掉并
 * 换成引导文案 —— 否则用户对着一个看起来能输入、按了却只弹错误提示的界面，
 * 只会以为是程序坏了。
 *
 * 幂等：loadProjects / loadStatus / 增删项目后都会调，重复调用无副作用。 */
function applyProjectState() {
  const ready = S.hasProject;
  el.welcomeReady.hidden = !ready;
  el.welcomeNoProj.hidden = ready;
  el.composerBox.classList.toggle('is-locked', !ready);
  el.input.disabled = !ready;
  el.input.placeholder = ready ? '随心输入' : '先添加一个文件夹';
  updateSendState();
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => setConn('ok', '已连接');
  es.onerror = () => setConn('bad', '连接断开');
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
  switch (evt.type) {
    case 'bridge_status': return onBridge(evt);
    case 'bridge_stderr': return onStderr(evt);
    case 'bridge_parse_error': return;
    case 'response': return onResponse(evt);
    case 'agent_start': return setStreaming(true);
    case 'agent_end': return;
    case 'agent_settled': return onSettled();
    case 'message_start': return onMessageStart(evt);
    case 'message_update': return onMessageUpdate(evt);
    case 'message_end': return onMessageEnd(evt);
    case 'tool_execution_start': return onToolStart(evt);
    case 'tool_execution_update': return onToolUpdate(evt);
    case 'tool_execution_end': return onToolEnd(evt);
    case 'extension_ui_request': return onUiRequest(evt);
    case 'compaction_start': return setStatus('正在压缩上下文…');
    case 'compaction_end': return setStatus('');
    case 'auto_retry_start':
      // pi 会为每次重试单独发一轮 message_end，上一次的错误块先撤掉，
      // 否则重试成功后对话区里还留着一张失败卡片
      dropTrailingError();
      return setStatus(`请求失败，第 ${evt.attempt}/${evt.maxAttempts} 次重试…`);
    case 'auto_retry_end': return setStatus('');
    case 'extension_error': return toast(`扩展错误：${evt.error}`, 'error');
    default: return;
  }
}

function onBridge(evt) {
  switch (evt.state) {
    case 'starting':
      return setConn('busy', '正在启动 pi…');
    case 'ready':
      setConn('ok', '已连接');
      boot();
      return;
    case 'exited':
      setConn('bad', `pi 已退出 (${evt.code ?? evt.signal ?? '?'})`);
      setStreaming(false);
      return;
    case 'restarting':
      return setConn('busy', '正在重启 pi…');
    case 'no-project':
      /* 后端明确告知「没有项目所以没启动 pi」。
       * 这不是错误状态 —— 底部连接指示不能说「连接断开」，那会让用户以为网络坏了。
       * 传空 kind 用 .conn 的默认灰点：中性、不刺眼。 */
      setConn('', '未选择项目');
      return;
    case 'error':
      setConn('bad', 'pi 启动失败');
      toast([evt.error, evt.hint].filter(Boolean).join('\n'), 'error');
      return;
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

function boot() {
  send({ type: 'get_state' });
  send({ type: 'get_session_stats' });
  send({ type: 'get_tree' });
  // 切换项目 / 重载配置后 pi 会恢复该目录的历史会话，用 get_messages 重建对话区
  send({ type: 'get_messages' });
  send({ type: 'get_available_models' });
  send({ type: 'get_available_thinking_levels' });
}

function onResponse(evt) {
  if (!evt.success) {
    if (evt.command !== 'get_available_thinking_levels') {
      toast(evt.error || `命令 ${evt.command} 执行失败`, 'error');
    }
    // 设置类命令失败后，之前乐观更新的显示会与 pi 不一致，回读一次纠正
    if (evt.command === 'set_model' || evt.command === 'set_thinking_level') send({ type: 'get_state' });
    return;
  }
  const d = evt.data || {};
  switch (evt.command) {
    case 'get_state': return applyState(d);
    case 'get_session_stats': return applyStats(d);
    case 'get_tree': return applyTree(d);
    case 'get_messages': return rebuildFromMessages(d);
    case 'get_available_models': return onModels(d);
    case 'get_available_thinking_levels': return onThinkingLevels(d);
    case 'set_model':
      if (d.name || d.id) el.modelText.textContent = d.name || d.id;
      toast('已切换到 ' + (d.name || d.id), 'info');
      return;
    case 'new_session':
      clearThread();
      toast('已开始新会话', 'info');
      setTimeout(boot, 250);
      return;
    case 'fork':
      clearThread();
      toast('已从该节点分叉', 'info');
      setTimeout(() => {
        send({ type: 'get_messages' });
        boot();
      }, 250);
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

/* ============ 状态应用 ============ */

function applyState(d) {
  S.ready = true;
  S.state = d;
  if (d.model) el.modelText.textContent = d.model.name || d.model.id || '模型';
  if (d.thinkingLevel) el.thinkText.textContent = '思考 ' + d.thinkingLevel;
  if (d.sessionName) setTitleText(d.sessionName);
  el.footName.textContent = d.sessionName || '本地会话';
  setStreaming(Boolean(d.isStreaming));
}

function applyStats(d) {
  S.stats = d;
  const ctx = d.contextUsage || {};
  const pct = typeof ctx.percent === 'number' ? ctx.percent : 0;

  el.uPct.textContent = ctx.tokens ? Math.round(pct) + '%' : '—';
  el.uCtxBar.style.width = Math.min(100, pct) + '%';
  el.uCtxBar.style.background = pct > 85 ? 'var(--err)' : pct > 65 ? 'var(--warn)' : 'var(--accent)';
  el.uNote.textContent = ctx.tokens
    ? `上下文 ${fmt(ctx.tokens)} / ${fmt(ctx.contextWindow)}`
    : '上下文 —';

  const t = d.tokens || {};
  el.uTok.textContent = t.input || t.output ? `${fmt(t.input)} / ${fmt(t.output)}` : '—';
  el.uCache.textContent = t.cacheRead ? fmt(t.cacheRead) : '—';
  el.uCost.textContent = typeof d.cost === 'number' ? '$' + d.cost.toFixed(4) : '—';

  renderCtxChip();

  // 统计面板是一次性拉取，拿到数据后回调渲染
  if (S.onStats) {
    const fn = S.onStats;
    S.onStats = null;
    fn(d);
  }
}

/* ============ 上下文占用指示器 ============ */

const RING_LEN = 2 * Math.PI * 15.5;

function ctxPct() {
  const ctx = S.stats?.contextUsage;
  if (!ctx || ctx.tokens == null || !ctx.contextWindow) return null;
  return typeof ctx.percent === 'number'
    ? ctx.percent
    : Math.round((ctx.tokens / ctx.contextWindow) * 100);
}

function renderCtxChip() {
  const pct = ctxPct();

  if (pct == null) {
    el.ctxPct.textContent = '—';
    el.ctxRing.style.strokeDashoffset = String(RING_LEN);
    el.btnCtx.className = 'ctx-chip';
    return;
  }

  const clamped = Math.max(0, Math.min(100, pct));
  el.ctxPct.textContent = Math.round(clamped) + '%';
  el.ctxRing.style.strokeDashoffset = String(RING_LEN * (1 - clamped / 100));
  el.btnCtx.className = 'ctx-chip' + (clamped > 85 ? ' hot' : clamped > 65 ? ' warn' : '');
}

function openCtxTip() {
  const ctx = S.stats?.contextUsage;

  pop.innerHTML = '';
  const box = document.createElement('div');

  if (!ctx || ctx.tokens == null || !ctx.contextWindow) {
    box.innerHTML = '<div class="tip-head">背景信息窗口:</div><div class="tip-dim">暂无数据</div>';
  } else {
    const pct = Math.round(ctxPct());
    const left = Math.max(0, 100 - pct);
    const head = document.createElement('div');
    head.className = 'tip-head';
    head.textContent = '背景信息窗口:';

    const big = document.createElement('div');
    big.className = 'tip-big';
    big.textContent = `${pct}% 已用 (剩余 ${left}%)`;

    const dim = document.createElement('div');
    dim.className = 'tip-dim';
    dim.textContent = `已用 ${fmt(ctx.tokens)} 标记, 共 ${fmt(ctx.contextWindow)}`;

    box.append(head, big, dim);
  }

  pop.appendChild(box);
  showPop(el.btnCtx, { tip: true });
}

function onModels(d) {
  S.models = Array.isArray(d) ? d : d?.models || [];
}

function onThinkingLevels(d) {
  S.thinkingLevels = Array.isArray(d) ? d : d?.levels || [];
}

/* ============ 分支树 ============ */

function entryText(entry) {
  if (!entry) return '（空条目）';
  const role = entry.role || entry.type || '';
  let text = '';
  const c = entry.content;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter((x) => x.type === 'text').map((x) => x.text).join(' ');
  if (!text) text = entry.text || entry.message || '';
  const who = role === 'user' ? '你' : role === 'assistant' ? 'Pi' : role || '条目';
  const body = String(text).replace(/\s+/g, ' ').trim().slice(0, 56);
  return body ? `${who}：${body}` : who;
}

function countNodes(list) {
  let n = 0;
  for (const x of list) {
    n += 1;
    if (x.children?.length) n += countNodes(x.children);
  }
  return n;
}

function applyTree(data) {
  const nodes = Array.isArray(data) ? data : data?.tree || [];
  S.treeData = nodes;

  const total = countNodes(nodes);
  el.branchCount.textContent = total ? String(total) : '';

  if (treeContainer) renderTree(nodes, treeContainer);
}

function renderTree(nodes, box) {
  box.innerHTML = '';

  if (!nodes.length) {
    box.innerHTML =
      '<div class="hint-empty">还没有分支记录。对话开始后，每个可回溯的节点都会出现在这里。</div>';
    return;
  }

  const walk = (list, depth) => {
    for (const n of list) {
      const div = document.createElement('div');
      div.className = 'tree-node';
      div.style.paddingLeft = 6 + depth * 12 + 'px';

      const txt = document.createElement('span');
      txt.className = 'tree-text';
      txt.textContent = entryText(n.entry);
      if (n.label) {
        const lb = document.createElement('span');
        lb.className = 'tree-label';
        lb.textContent = n.label;
        txt.appendChild(lb);
      }
      div.appendChild(txt);

      const id = n.entry?.id;
      if (id) {
        div.title = '点击从此节点分叉';
        div.onclick = () => {
          el.modal.hidden = true;
          el.modalCard.innerHTML = '';
          treeContainer = null;
          forkFrom(id);
        };
      }
      box.appendChild(div);
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
}

function openBranchPanel() {
  openModal((card, close) => {
    card.classList.add('wide');

    const h = document.createElement('h3');
    h.textContent = '分支';
    card.appendChild(h);

    const desc = document.createElement('div');
    desc.className = 'modal-desc';
    desc.textContent = '当前会话的所有可回溯节点。点击任意节点即可从该处分叉，开启一条新的支线。';
    card.appendChild(desc);

    const box = document.createElement('div');
    box.className = 'tree';
    card.appendChild(box);

    treeContainer = box;
    if (S.treeData.length) renderTree(S.treeData, box);
    else box.innerHTML = '<div class="hint-empty">加载中…</div>';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const refresh = document.createElement('button');
    refresh.className = 'btn';
    refresh.textContent = '刷新';
    refresh.onclick = () => send({ type: 'get_tree' });

    const clone = document.createElement('button');
    clone.className = 'btn';
    clone.textContent = '复制当前分支';
    clone.onclick = () => {
      send({ type: 'clone' });
      close();
      toast('已复制当前分支', 'info');
    };

    const done = document.createElement('button');
    done.className = 'btn primary';
    done.textContent = '关闭';
    done.onclick = close;

    actions.append(refresh, clone, done);
    card.appendChild(actions);
  });

  send({ type: 'get_tree' });
}

async function forkFrom(entryId) {
  await send({ type: 'fork', entryId });
}

/* ============ 对话渲染 ============ */

/* 空会话显示欢迎块，有内容就收起来。
 *
 * 早先是在 ensureThread() 里把 #welcome 直接 remove() 掉 —— 新会话一建出
 * 空线程，欢迎块就永久消失，对话区变成一片纯黑，用户看不到任何引导。
 * 现在改成显隐切换（见 syncWelcome），元素始终留在 DOM 里。 */
function ensureThread() {
  if (S.thread) return S.thread;
  const t = document.createElement('div');
  t.className = 'thread';
  el.stream.appendChild(t);
  S.thread = t;
  return t;
}

/** 欢迎块跟着「对话区有没有内容」自动显隐。
 *
 * 用 MutationObserver 而不是在每条渲染分支里手动调：消息的渲染路径有
 * 实时流式、历史重建、工具卡片插入等好几条，逐条插调用必然漏掉某条。
 * 这里只读一次 childElementCount，开销可忽略。 */
function syncWelcome() {
  const w = document.getElementById('welcome');
  if (!w) return;
  const hide = Boolean(S.thread && S.thread.childElementCount);
  if (w.hidden !== hide) w.hidden = hide;
}

function clearThread() {
  if (S.thread) S.thread.innerHTML = '';
  S.current = null;
  S.blocks.clear();
  S.tools.clear();
  hideWorking();
}

function scrollBottom(force) {
  const s = el.stream;
  const nearBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  if (force || nearBottom) {
    requestAnimationFrame(() => {
      s.scrollTop = s.scrollHeight;
    });
  }
}

function showWorking() {
  hideWorking();
  const t = ensureThread();
  const w = document.createElement('div');
  w.className = 'working';
  w.innerHTML = '<span class="spinner"></span><span>Pi 正在处理…</span>';
  t.appendChild(w);
  S.working = w;
}

function hideWorking() {
  if (S.working) {
    S.working.remove();
    S.working = null;
  }
}

function moveWorkingToEnd() {
  if (S.working && S.thread) S.thread.appendChild(S.working);
}

function setStreaming(on) {
  S.streaming = on;
  el.btnStop.hidden = !on;
  if (on) showWorking();
  else hideWorking();
  updateSendState();
}

function onSettled() {
  setStreaming(false);
  S.current = null;
  S.blocks.clear();
  send({ type: 'get_session_stats' });
  send({ type: 'get_state' });
  send({ type: 'get_tree' });
  el.input.focus();
}

function fileBlockCard(name, meta, content) {
  const d = document.createElement('div');
  d.className = 'msg-file';

  const head = document.createElement('div');
  head.className = 'msg-file-head';
  head.appendChild(icon(iconFor(name)));

  const n = document.createElement('span');
  n.textContent = name;
  head.appendChild(n);

  const mt = document.createElement('span');
  mt.className = 'msg-file-meta';
  mt.textContent = meta || '';
  head.appendChild(mt);

  const chev = document.createElement('span');
  chev.className = 'mf-chev';
  chev.appendChild(icon(['M9.5 5.5L16 12l-6.5 6.5']));
  head.appendChild(chev);

  const inner = document.createElement('div');
  inner.className = 'msg-file-body';
  inner.textContent = content;

  head.onclick = () => d.classList.toggle('open');
  d.append(head, inner);
  return d;
}

/* 图片附件的缩略图行。数据取自消息 content 里的 image 部分，
 * 所以刷新页面后从历史重建也能还原，不依赖内存里的 S.attachments。 */
function attChips(imgs) {
  const row = document.createElement('div');
  row.className = 'msg-att-chips';
  for (const c of imgs) {
    const chip = document.createElement('div');
    chip.className = 'msg-att-chip';
    chip.title = '图片附件';
    const img = document.createElement('img');
    img.src = `data:${c.mimeType || 'image/png'};base64,${c.data}`;
    img.alt = '图片附件';
    chip.appendChild(img);
    row.appendChild(chip);
  }
  return row;
}

/* 用户消息体：把附件正文切成折叠卡片，否则一份长 PDF 会把对话整个铺满。
 * 实时渲染和历史重建共用，避免刷新后裸标签直接暴露出来。 */
function userBody(msg) {
  const body = document.createElement('div');
  body.className = 'msg-body';

  const raw = textOf(msg) || '(空消息)';

  const imgs = Array.isArray(msg?.content) ? msg.content.filter((c) => c?.type === 'image' && c.data) : [];
  if (imgs.length) body.appendChild(attChips(imgs));

  FILE_BLOCK_RE.lastIndex = 0;
  let last = 0;
  let m;
  const pushText = (s) => {
    const v = s.trim();
    if (!v) return;
    const seg = document.createElement('div');
    seg.textContent = v;
    body.appendChild(seg);
  };

  while ((m = FILE_BLOCK_RE.exec(raw))) {
    pushText(raw.slice(last, m.index));
    body.appendChild(fileBlockCard(m[1], m[2], m[3]));
    last = m.index + m[0].length;
  }
  pushText(raw.slice(last));

  if (!body.childNodes.length) body.textContent = raw;
  return body;
}

function renderUser(msg) {
  const t = ensureThread();
  const wrap = document.createElement('div');
  wrap.className = 'msg user';

  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = '你';

  wrap.append(role, userBody(msg));
  t.appendChild(wrap);
  moveWorkingToEnd();
  scrollBottom(true);
}

function createAssistant() {
  const t = ensureThread();
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';

  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'Pi';

  const body = document.createElement('div');
  body.className = 'msg-body';

  wrap.append(role, body);
  t.appendChild(wrap);

  S.current = { wrap, body };
  S.blocks.clear();
  moveWorkingToEnd();
  scrollBottom(true);
  return S.current;
}

function onMessageStart(evt) {
  const msg = evt.message || {};
  if (msg.role === 'user') renderUser(msg);
  else if (msg.role === 'assistant') createAssistant();
}

/* --- 流式块组装 --- */

const pendingPaint = new Map();
let rafId = null;

function schedulePaint(block) {
  pendingPaint.set(block, true);
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    for (const b of pendingPaint.keys()) paint(b);
    pendingPaint.clear();
  });
}

function paint(b) {
  if (!b.node) return;
  if (b.kind === 'text') {
    b.node.innerHTML = md(b.text);
  } else if (b.bodyEl) {
    b.bodyEl.textContent = b.text;
    if (b.headEl) b.headEl.textContent = `思考过程 · ${b.text.length} 字`;
  }
}

function ensureBlock(idx, kind) {
  const existing = S.blocks.get(idx);
  if (existing && existing.kind === kind) return existing;
  if (!S.current) createAssistant();

  const b = { kind, text: '', node: null };

  if (kind === 'text') {
    const p = document.createElement('p');
    S.current.body.appendChild(p);
    b.node = p;
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'think';
    wrap.innerHTML =
      '<div class="think-head"><svg viewBox="0 0 24 24"><path d="M6.5 9.5L12 15l5.5-5.5"/></svg><span>思考中…</span></div><div class="think-body"></div>';
    wrap.querySelector('.think-head').onclick = () => wrap.classList.toggle('collapsed');
    S.current.body.appendChild(wrap);
    b.node = wrap;
    b.bodyEl = wrap.querySelector('.think-body');
    b.headEl = wrap.querySelector('.think-head span');
  }

  S.blocks.set(idx, b);
  return b;
}

function appendBlock(idx, kind, delta) {
  const b = ensureBlock(idx, kind);
  b.text += delta;
  schedulePaint(b);
}

function setBlockText(idx, kind, text) {
  const b = ensureBlock(idx, kind);
  b.text = text;
  paint(b);
}

function onMessageUpdate(evt) {
  const d = evt.assistantMessageEvent;
  if (!d) return;
  const idx = d.contentIndex ?? 0;

  switch (d.type) {
    case 'text_start':
      ensureBlock(idx, 'text');
      break;
    case 'text_delta':
      appendBlock(idx, 'text', d.delta || '');
      scrollBottom();
      break;
    case 'text_end':
      if (typeof d.content === 'string') setBlockText(idx, 'text', d.content);
      break;

    case 'thinking_start':
      ensureBlock(idx, 'think');
      break;
    case 'thinking_delta':
      appendBlock(idx, 'think', d.delta || '');
      break;
    case 'thinking_end': {
      if (typeof d.content === 'string') setBlockText(idx, 'think', d.content);
      const b = S.blocks.get(idx);
      if (b?.node) b.node.classList.add('collapsed');
      break;
    }
    default:
      break;
  }
}

function onMessageEnd(evt) {
  const msg = evt.message;
  if (msg?.role === 'assistant' && S.current) {
    // message_end.message 是权威，用它校正渲染结果
    rebuildAssistant(S.current.body, msg);
  }
  S.current = null;
  S.blocks.clear();
  moveWorkingToEnd();
  scrollBottom();
}

/* 把上游错误翻译成人话。
 * pi 把 HTTP 错误原样塞在 message.errorMessage 里，形如
 * `402: {"message":"Insufficient Balance","type":"unknown_error",...}`，
 * 直接铺给用户没法看。实测余额不足时 stopReason='error'、usage 全 0、
 * content 为空 —— 不处理的话对话区就是一片空白，完全看不出发生了什么。 */
const ERR_RULES = [
  [/insufficient[_ ]?(balance|quota)|余额不足|quota exceeded|exceeded your current quota/i, '账户余额不足', '到模型服务商平台充值后重试'],
  [/401|unauthorized|invalid[_ ]api[_ ]key|incorrect api key/i, 'API Key 无效或已过期', '检查左下「模型供应商」里的 Key'],
  [/403|forbidden|permission denied/i, '无权访问该模型', '确认账号是否已开通这个模型'],
  [/404|model[_ ]not[_ ]found|no such model|does not exist/i, '模型不存在', '在「模型供应商」里核对模型 ID'],
  [/429|rate[_ ]limit|too many requests/i, '触发限流', '稍等片刻再试，或降低并发'],
  [/context[_ ]length|too many tokens|maximum context/i, '上下文超出模型上限', '用「压缩」精简历史，或新开会话'],
  [/\b5\d\d\b|internal server error|bad gateway|service unavailable/i, '模型服务端异常', '通常是临时故障，稍后重试'],
  [/fetch failed|econnrefused|enotfound|etimedout|socket hang up|network/i, '网络连接失败', '检查网络或代理设置'],
];

function explainError(raw) {
  const s = String(raw || '');
  for (const [re, title, hint] of ERR_RULES) {
    if (re.test(s)) return { title, hint };
  }
  return { title: '请求失败', hint: '' };
}

function errorBlock(msg) {
  const raw = msg?.errorMessage || '';
  const { title, hint } = explainError(raw);

  const d = document.createElement('div');
  d.className = 'msg-err';

  const head = document.createElement('div');
  head.className = 'me-head';
  head.appendChild(icon(['M12 4.5L21 20H3z', 'M12 10v4.5', 'M12 17.1v.3']));
  const t = document.createElement('span');
  t.textContent = title;
  head.appendChild(t);
  d.appendChild(head);

  if (hint) {
    const h = document.createElement('div');
    h.className = 'me-hint';
    h.textContent = hint;
    d.appendChild(h);
  }

  const r = document.createElement('div');
  r.className = 'me-raw';
  r.textContent = raw || '(pi 没有给出错误详情)';
  d.appendChild(r);
  return d;
}

function noteBlock(text) {
  const d = document.createElement('div');
  d.className = 'msg-note';
  d.textContent = text;
  return d;
}

/* 重试开始时撤掉上一次留下的错误块（message_end 已经把 S.current 清空了，
 * 所以还要能回退到对话区里最后一条助手消息） */
function dropTrailingError() {
  const box = S.current?.body || [...document.querySelectorAll('#stream .thread .msg.assistant .msg-body')].pop();
  const last = box?.lastElementChild;
  if (last && last.classList.contains('msg-err')) last.remove();
}

function rebuildAssistant(bodyEl, msg) {
  const content = Array.isArray(msg.content) ? msg.content : [];
  const failed = msg?.stopReason === 'error' || Boolean(msg?.errorMessage);
  const aborted = msg?.stopReason === 'aborted';

  // 既没内容也不是失败 —— pi 这次什么都没返回，给个提示别留空白
  if (!content.length && !failed && !aborted) {
    bodyEl.appendChild(noteBlock('（这次没有返回内容）'));
    return;
  }

  const html = content
    .map((c) => {
      if (c.type === 'text') return md(c.text || '');
      if (c.type === 'thinking') {
        return `<div class="think collapsed"><div class="think-head"><svg viewBox="0 0 24 24"><path d="M6.5 9.5L12 15l5.5-5.5"/></svg><span>思考过程 · ${(c.thinking || '').length} 字</span></div><div class="think-body">${esc(c.thinking || '')}</div></div>`;
      }
      return '';
    })
    .join('');

  if (html) {
    bodyEl.innerHTML = html;
    bodyEl.querySelectorAll('.think-head').forEach((h) => {
      h.onclick = () => h.parentElement.classList.toggle('collapsed');
    });
  }

  if (failed) bodyEl.appendChild(errorBlock(msg));
  else if (aborted) bodyEl.appendChild(noteBlock('已中断'));
}

function rebuildFromMessages(data) {
  const msgs = Array.isArray(data) ? data : data?.messages || [];
  clearThread();
  const t = ensureThread();
  for (const m of msgs) {
    if (m.role === 'user') {
      const wrap = document.createElement('div');
      wrap.className = 'msg user';
      wrap.innerHTML = '<div class="msg-role">你</div>';
      wrap.appendChild(userBody(m));
      t.appendChild(wrap);
    } else if (m.role === 'assistant') {
      const wrap = document.createElement('div');
      wrap.className = 'msg assistant';
      wrap.innerHTML = '<div class="msg-role">Pi</div>';
      const body = document.createElement('div');
      body.className = 'msg-body';
      rebuildAssistant(body, m);
      wrap.appendChild(body);
      t.appendChild(wrap);
    }
  }
  scrollBottom(true);
}

/* ============ 工具调用 ============ */

function onToolStart(evt) {
  const t = ensureThread();
  const meta = TOOL_META[evt.toolName] || { label: evt.toolName, icon: 'tool' };

  const card = document.createElement('div');
  card.className = 'tool running';
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-icon">${ICONS[meta.icon] || ICONS.tool}</span>
      <span class="tool-name"></span>
      <span class="tool-args"></span>
      <span class="tool-state">运行中</span>
    </div>
    <pre class="tool-out"></pre>`;

  card.querySelector('.tool-name').textContent = meta.label;
  card.querySelector('.tool-args').textContent = summarizeArgs(evt.toolName, evt.args);
  card.querySelector('.tool-head').onclick = () => card.classList.toggle('open');

  t.appendChild(card);
  S.tools.set(evt.toolCallId, card);
  moveWorkingToEnd();
  scrollBottom(true);
}

function onToolUpdate(evt) {
  const card = S.tools.get(evt.toolCallId);
  if (!card) return;
  // partialResult 是累积值，直接替换
  const text = resultText(evt.partialResult);
  if (!text) return;
  const out = card.querySelector('.tool-out');
  if (!out) return;
  out.textContent = text;
  card.classList.add('open');
  scrollBottom();
}

function onToolEnd(evt) {
  const card = S.tools.get(evt.toolCallId);
  if (!card) return;

  card.classList.remove('running');
  card.classList.add(evt.isError ? 'err' : 'done');
  card.querySelector('.tool-state').textContent = evt.isError ? '失败' : '完成';

  const text = resultText(evt.result);
  const out = card.querySelector('.tool-out');
  if (text && out) {
    out.textContent = text;
  } else if (out) {
    out.remove();
    const empty = document.createElement('div');
    empty.className = 'tool-empty';
    empty.textContent = '无输出';
    card.appendChild(empty);
  }

  S.tools.delete(evt.toolCallId);
  moveWorkingToEnd();
  scrollBottom();
}

/* ============ 扩展 UI（权限确认等） ============ */

function respond(id, payload) {
  send({ type: 'extension_ui_response', id, ...payload });
}

function onUiRequest(evt) {
  switch (evt.method) {
    case 'select':
      return uiSelect(evt);
    case 'confirm':
      return uiConfirm(evt);
    case 'input':
      return uiInput(evt, false);
    case 'editor':
      return uiInput(evt, true);
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

function uiSelect(evt) {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = evt.title || '请选择';
    card.appendChild(h);

    const list = document.createElement('div');
    list.className = 'modal-list';
    for (const opt of evt.options || []) {
      const item = document.createElement('div');
      item.className = 'modal-item';
      item.textContent = opt;
      item.onclick = () => {
        close();
        respond(evt.id, { value: opt });
      };
      list.appendChild(item);
    }
    card.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.onclick = () => {
      close();
      respond(evt.id, { cancelled: true });
    };
    actions.appendChild(cancel);
    card.appendChild(actions);
  });
}

function uiConfirm(evt) {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = evt.title || '确认';
    card.appendChild(h);

    if (evt.message) {
      const p = document.createElement('div');
      p.className = 'modal-desc';
      p.textContent = evt.message;
      card.appendChild(p);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const no = document.createElement('button');
    no.className = 'btn';
    no.textContent = '取消';
    no.onclick = () => {
      close();
      respond(evt.id, { confirmed: false });
    };

    const yes = document.createElement('button');
    yes.className = 'btn primary';
    yes.textContent = '确认';
    yes.onclick = () => {
      close();
      respond(evt.id, { confirmed: true });
    };

    actions.append(no, yes);
    card.appendChild(actions);
  });
}

function uiInput(evt, multiline) {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = evt.title || '输入';
    card.appendChild(h);

    if (evt.message) {
      const p = document.createElement('div');
      p.className = 'modal-desc';
      p.textContent = evt.message;
      card.appendChild(p);
    }

    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.className = 'modal-input';
    if (multiline) input.rows = 6;
    if (evt.placeholder) input.placeholder = evt.placeholder;
    card.appendChild(input);
    setTimeout(() => input.focus(), 30);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.onclick = () => {
      close();
      respond(evt.id, { cancelled: true });
    };

    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = '确定';
    ok.onclick = () => {
      const value = input.value;
      close();
      respond(evt.id, { value });
    };

    actions.append(cancel, ok);
    card.appendChild(actions);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) ok.click();
    });
  });
}

/* ============ 项目管理 ============ */

let projectData = { active: '', items: [] };

const SVG_FOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const SVG_UP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>';
const SVG_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

async function loadProjects() {
  try {
    const r = await fetch('/api/projects');
    const j = await r.json();
    projectData = { active: j.active || '', items: j.items || [] };
  } catch {
    projectData = { active: '', items: [] };
  }
  renderProjects();
}

function renderProjects() {
  el.projects.innerHTML = '';

  if (!projectData.items.length) {
    el.projects.innerHTML = '<div class="hint-empty">还没有项目，点下面的「添加文件夹」。</div>';
    return;
  }

  for (const p of projectData.items) {
    const isActive = samePath(p.path, projectData.active);

    const item = document.createElement('div');
    item.className = 'project' + (isActive ? ' active' : '');
    item.title = p.path;

    const icon = document.createElement('span');
    icon.className = 'pj-icon';
    icon.innerHTML = SVG_FOLDER;

    const body = document.createElement('div');
    body.className = 'pj-body';
    const n = document.createElement('span');
    n.className = 'pj-name';
    n.textContent = p.name || p.path;
    const pa = document.createElement('span');
    pa.className = 'pj-path';
    pa.textContent = p.path;
    body.append(n, pa);

    const del = document.createElement('button');
    del.className = 'pj-del';
    del.title = '从列表移除（不会删除磁盘文件）';
    del.innerHTML = SVG_X;
    del.onclick = (e) => {
      e.stopPropagation();
      removeProject(p.path);
    };

    item.append(icon, body, del);
    if (!isActive) item.onclick = () => activateProject(p.path, p.name || p.path);

    el.projects.appendChild(item);
  }
}

async function addProject(target, name) {
  try {
    const r = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target, name }),
    });
    const j = await r.json();
    if (!j.ok) return toast(j.error || '添加失败', 'error');
    await loadProjects();
    await activateProject(j.path, name || '');
  } catch (err) {
    toast('添加失败：' + err.message, 'error');
  }
}

async function removeProject(target) {
  try {
    const r = await fetch('/api/projects?path=' + encodeURIComponent(target), { method: 'DELETE' });
    const j = await r.json();
    if (!j.ok) return toast(j.error || '移除失败', 'error');
    await loadProjects();
    /* 移掉的可能是当前正在用的那个项目。后端会把「上次激活」清掉但让会话继续跑，
     * 所以这里回读一次状态，让界面高亮和底部连接指示跟着走，别停在旧状态上。 */
    await loadStatus();
  } catch (err) {
    toast('移除失败：' + err.message, 'error');
  }
}

async function activateProject(target, label) {
  try {
    const r = await fetch('/api/projects/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
    const j = await r.json();
    if (!j.ok) return toast(j.error || '切换失败', 'error');

    clearThread();
    const title = label || target;
    el.title.textContent = title;
    el.footName.textContent = title;
    /* 先回读状态再等 pi 起来：S.cwd 是相对路径补成绝对的依据，
     * 而 hasProject 决定输入框解锁 —— 第一次添加项目时正是靠它从「未选项目」切过来。 */
    await loadStatus();
    await loadProjects();
    toast(`已切换到 ${title}，pi 正在重启…`, 'info');
  } catch (err) {
    toast('切换失败：' + err.message, 'error');
  }
}

/* 目录选择器 */

function openDirPicker() {
  let current = '';

  openModal((card, close) => {
    card.classList.add('wide');

    const h = document.createElement('h3');
    h.textContent = '选择项目文件夹';
    card.appendChild(h);

    const desc = document.createElement('div');
    desc.className = 'modal-desc';
    desc.textContent =
      '选一个目录作为 pi 的工作目录。切换后 pi 会以该目录重启，并尝试接上这里之前的工作。';
    card.appendChild(desc);

    const crumbs = document.createElement('div');
    crumbs.className = 'crumbs';
    card.appendChild(crumbs);

    const list = document.createElement('div');
    list.className = 'dir-list';
    card.appendChild(list);

    const selected = document.createElement('div');
    selected.className = 'selected-path';
    selected.textContent = '未选择';
    card.appendChild(selected);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.onclick = close;

    const confirm = document.createElement('button');
    confirm.className = 'btn primary';
    confirm.textContent = '使用此目录';
    confirm.disabled = true;
    confirm.style.opacity = '.45';
    confirm.onclick = () => {
      if (!current) return;
      close();
      addProject(current, '');
    };

    actions.append(cancel, confirm);
    card.appendChild(actions);

    function renderCrumbs(p) {
      crumbs.innerHTML = '';
      const rootBtn = document.createElement('button');
      rootBtn.className = 'crumb';
      rootBtn.textContent = '此电脑';
      rootBtn.onclick = () => go('');
      crumbs.appendChild(rootBtn);

      if (!p) return;

      const isWin = /^[A-Za-z]:/.test(p);
      const parts = p.split(/[\\/]+/).filter(Boolean);
      let acc = isWin ? '' : '/';

      parts.forEach((part, i) => {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '/';
        crumbs.appendChild(sep);

        if (isWin) {
          acc = i === 0 ? part + '\\' : acc.replace(/[\\/]+$/, '') + '\\' + part;
        } else {
          acc = acc.replace(/\/+$/, '') + '/' + part;
        }

        const target = acc;
        const b = document.createElement('button');
        b.className = 'crumb';
        b.textContent = part;
        b.onclick = () => go(target);
        crumbs.appendChild(b);
      });
    }

    function renderList(data) {
      list.innerHTML = '';

      if (data.parent) {
        const up = document.createElement('div');
        up.className = 'dir-item up';
        up.innerHTML = '<span class="ic">' + SVG_UP + '</span><span class="dir-name">返回上级</span>';
        up.onclick = () => go(data.parent);
        list.appendChild(up);
      }

      if (!data.dirs || !data.dirs.length) {
        const empty = document.createElement('div');
        empty.className = 'dir-empty';
        empty.textContent = '该目录下没有子文件夹';
        list.appendChild(empty);
        return;
      }

      for (const d of data.dirs) {
        const item = document.createElement('div');
        item.className = 'dir-item';
        item.innerHTML = '<span class="ic">' + SVG_FOLDER + '</span><span class="dir-name"></span>';
        item.querySelector('.dir-name').textContent = d.name;
        item.onclick = () => go(d.path);
        list.appendChild(item);
      }
    }

    async function go(target) {
      let data;
      try {
        const r = await fetch('/api/fs' + (target ? '?path=' + encodeURIComponent(target) : ''));
        data = await r.json();
      } catch (err) {
        toast('无法读取目录：' + err.message, 'error');
        return;
      }
      if (!data.ok) return toast(data.error || '读取失败', 'error');

      current = data.path || '';
      renderCrumbs(current);
      renderList(data);

      selected.textContent = current || '请选择一个目录';
      confirm.disabled = !current;
      confirm.style.opacity = current ? '1' : '.45';
    }

    go('');
  });
}

/* ============ 供应商管理 ============ */

const PRESETS = {
  openrouter: { label: 'OpenRouter', name: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '$OPENROUTER_API_KEY', models: '' },
  ollama: { label: 'Ollama 本地', name: 'ollama', api: 'openai-completions', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama', models: 'llama3.1:8b\nqwen2.5-coder:7b' },
  deepseek: { label: 'DeepSeek', name: 'deepseek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', apiKey: '$DEEPSEEK_API_KEY', models: 'deepseek-chat|DeepSeek Chat\ndeepseek-reasoner|DeepSeek Reasoner' },
  moonshot: { label: 'Moonshot', name: 'moonshot', api: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1', apiKey: '$MOONSHOT_API_KEY', models: 'kimi-k2-0905-preview|Kimi K2' },
  siliconflow: { label: '硅基流动', name: 'siliconflow', api: 'openai-completions', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '$SILICONFLOW_API_KEY', models: 'deepseek-ai/DeepSeek-V3|DeepSeek V3' },
  zhipu: { label: '智谱 GLM', name: 'zhipu', api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '$ZHIPU_API_KEY', models: 'glm-4.6|GLM-4.6' },
  dashscope: { label: '阿里百炼', name: 'dashscope', api: 'openai-completions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '$DASHSCOPE_API_KEY', models: 'qwen3-max|Qwen3 Max' },
  anthropic: { label: 'Anthropic', name: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', apiKey: '$ANTHROPIC_API_KEY', models: 'claude-sonnet-4-5|Claude Sonnet 4.5' },
  gemini: { label: 'Google Gemini', name: 'google', api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: '$GEMINI_API_KEY', models: 'gemini-2.5-pro|Gemini 2.5 Pro' },
};

let providerData = { path: '', providers: {}, keyStates: {} };

async function loadProviders(container) {
  try {
    const r = await fetch('/api/providers');
    const j = await r.json();
    providerData = { path: j.path || '', providers: j.providers || {}, keyStates: j.keyStates || {} };
  } catch {
    providerData = { path: '', providers: {}, keyStates: {} };
  }
  renderProviders(container || providerContainer);
}

function renderProviders(box) {
  const names = Object.keys(providerData.providers);

  el.providerCount.textContent = names.length ? String(names.length) : '';
  if (!box) return;

  box.innerHTML = '';

  if (!names.length) {
    box.innerHTML =
      '<div class="hint-empty">还没有自定义供应商。<br>内置供应商由 pi 自己管理，这里只放你自己添加的。</div>';
    return;
  }

  for (const name of names) {
    const cfg = providerData.providers[name] || {};
    const count = Array.isArray(cfg.models) ? cfg.models.length : 0;

    const item = document.createElement('div');
    item.className = 'prov';

    const main = document.createElement('div');
    main.className = 'prov-main';
    const n = document.createElement('span');
    n.className = 'prov-name';
    n.textContent = name;
    const m = document.createElement('span');
    m.className = 'prov-meta';
    m.textContent = `${count} 个模型 · ${cfg.api || 'openai-completions'}`;
    m.title = cfg.baseUrl || '';
    main.append(n, m);

    const ks = providerData.keyStates[name];
    if (ks && !ks.ok) {
      const warn = document.createElement('span');
      warn.className = 'prov-warn';
      warn.textContent = ks.note;
      main.appendChild(warn);
    }

    const del = document.createElement('button');
    del.className = 'prov-del';
    del.title = '删除该供应商';
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';
    del.onclick = (e) => {
      e.stopPropagation();
      removeProvider(name);
    };

    item.append(main, del);
    box.appendChild(item);
  }
}

function openProvidersPanel() {
  openModal((card, close) => {
    card.classList.add('wide');

    const h = document.createElement('h3');
    h.textContent = '模型供应商';
    card.appendChild(h);

    const desc = document.createElement('div');
    desc.className = 'modal-desc';
    desc.textContent =
      '这里添加的供应商会写进 pi 的 ' +
      (providerData.path || '~/.pi/agent/models.json') +
      '，已有的配置不会被覆盖。保存后需要重载 pi 才会生效。';
    card.appendChild(desc);

    const box = document.createElement('div');
    box.className = 'providers';
    card.appendChild(box);

    providerContainer = box;
    box.innerHTML = '<div class="hint-empty">加载中…</div>';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const add = document.createElement('button');
    add.className = 'btn primary';
    add.textContent = '添加供应商';
    add.onclick = openAddProvider;

    const reload = document.createElement('button');
    reload.className = 'btn';
    reload.textContent = '重载 pi 配置';
    reload.onclick = () => {
      close();
      reloadPi();
    };

    const done = document.createElement('button');
    done.className = 'btn';
    done.textContent = '关闭';
    done.onclick = close;

    actions.append(add, reload, done);
    card.appendChild(actions);
  });

  loadProviders();
}

async function removeProvider(name) {
  try {
    const r = await fetch('/api/providers/' + encodeURIComponent(name), { method: 'DELETE' });
    const j = await r.json();
    if (!j.ok) return toast(j.error || '删除失败', 'error');
    toast(`已删除供应商 ${name}。重载 pi 后生效。`, 'info');
    await loadProviders();
  } catch (err) {
    toast('删除失败：' + err.message, 'error');
  }
}

function openAddProvider() {
  openModal((card, close) => {
    card.classList.add('wide');

    const mk = (tag, cls, attrs = {}) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      Object.assign(n, attrs);
      return n;
    };

    const h = mk('h3', '', { textContent: '添加模型供应商' });
    const desc = mk('div', 'modal-desc', {
      textContent: '配置写入 pi 的 ' + (providerData.path || '~/.pi/agent/models.json') + '。已有供应商不会被覆盖。',
    });
    const presets = mk('div', 'presets');
    card.append(h, desc, presets);

    const fName = mk('div', 'field');
    fName.innerHTML = '<label>供应商 ID</label>';
    const iName = mk('input', '', { placeholder: 'my-provider' });
    fName.appendChild(iName);

    const fApi = mk('div', 'field');
    fApi.innerHTML = '<label>API 类型</label>';
    const sApi = mk('select');
    for (const [v, t] of [
      ['openai-completions', 'openai-completions（兼容性最好）'],
      ['openai-responses', 'openai-responses'],
      ['anthropic-messages', 'anthropic-messages'],
      ['google-generative-ai', 'google-generative-ai'],
    ]) {
      sApi.appendChild(mk('option', '', { value: v, textContent: t }));
    }
    fApi.appendChild(sApi);

    const fBase = mk('div', 'field');
    fBase.innerHTML = '<label>Base URL</label>';
    const iBase = mk('input', '', { placeholder: 'https://api.example.com/v1' });
    fBase.appendChild(iBase);

    const row = mk('div', 'field-row');
    row.append(fApi, fBase);

    const fKey = mk('div', 'field');
    fKey.innerHTML = '<label>API Key</label>';
    const iKey = mk('input', '', { placeholder: '$MY_API_KEY 或 sk-...' });
    fKey.append(
      iKey,
      mk('div', 'hint', {
        textContent:
          '可填 $ENV_VAR 引用环境变量、!command 执行命令取值，或直接填字面量。注意：$ENV_VAR 没设置时 pi 会直接忽略整个供应商，且不报错。',
      })
    );

    const fModels = mk('div', 'field');
    fModels.innerHTML = '<label>模型列表</label>';
    const iModels = mk('textarea', '', {
      rows: 4,
      placeholder: 'llama3.1:8b\nqwen2.5-coder:7b|Qwen Coder',
    });
    fModels.append(
      iModels,
      mk('div', 'hint', { textContent: '每行一个模型。用 id|显示名 的格式可指定显示名称。' })
    );

    card.append(fName, row, fKey, fModels);

    for (const p of Object.values(PRESETS)) {
      const b = mk('button', 'preset', { textContent: p.label, type: 'button' });
      b.onclick = () => {
        presets.querySelectorAll('.preset').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        iName.value = p.name;
        sApi.value = p.api;
        iBase.value = p.baseUrl;
        iKey.value = p.apiKey;
        iModels.value = p.models;
      };
      presets.appendChild(b);
    }

    const actions = mk('div', 'modal-actions');
    const cancel = mk('button', 'btn', { textContent: '取消', type: 'button' });
    cancel.onclick = close;

    const save = mk('button', 'btn primary', { textContent: '保存', type: 'button' });
    save.onclick = async () => {
      const name = iName.value.trim();
      const baseUrl = iBase.value.trim();
      if (!name) return toast('请填写供应商 ID', 'warn');
      if (!baseUrl) return toast('请填写 Base URL', 'warn');

      const models = iModels.value
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [id, label] = l.split('|').map((s) => s.trim());
          return label ? { id, name: label } : { id };
        });

      try {
        const r = await fetch('/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            config: { baseUrl, api: sApi.value, apiKey: iKey.value.trim(), models },
          }),
        });
        const j = await r.json();
        if (!j.ok) return toast(j.error || '保存失败', 'error');
        close();
        if (j.warning) toast(j.warning, 'warn');
        toast(`已保存供应商 ${name}。重载 pi 后即可选用。`, 'info');
        await loadProviders();
        openProvidersPanel();
      } catch (err) {
        toast('保存失败：' + err.message, 'error');
      }
    };

    actions.append(cancel, save);
    card.appendChild(actions);
  });
}

async function reloadPi() {
  try {
    await fetch('/api/restart', { method: 'POST' });
    toast('正在重载 pi 配置…', 'info');
    clearThread();
  } catch (err) {
    toast('重载失败：' + err.message, 'error');
  }
}

/* ============ 选择器 ============ */

function openModelPicker() {
  if (!S.models.length) {
    send({ type: 'get_available_models' });
    toast('正在获取模型列表…', 'info');
    return;
  }

  const currentId = S.state?.model?.id || null;

  pop.innerHTML = '';
  pop.appendChild(popTitle('选择模型'));

  // 按供应商分组，和 pi 的模型来源一一对应
  const groups = new Map();
  for (const m of S.models) {
    const key = m.provider || '默认';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  for (const [provider, list] of groups) {
    pop.appendChild(popLabel(provider));
    for (const m of list) {
      const id = m.id || m.name;
      const isCur = currentId ? id === currentId : m.name === el.modelText.textContent;
      pop.appendChild(
        popItem({
          label: m.name || id,
          sub: m.reasoning ? '推理' : '',
          on: isCur,
          onClick: () => {
            closePop();
            // 实测：pi 的 set_model 需要 provider + modelId 两个字段，
            // 只传 model 会报 "Model not found: <provider>/undefined"
            send({ type: 'set_model', provider: m.provider, modelId: id });
            el.modelText.textContent = m.name || id; // 乐观更新，失败时靠 get_state 纠正
            send({ type: 'get_state' });
          },
        })
      );
    }
  }

  const foot = document.createElement('div');
  foot.className = 'pop-foot';
  const t = document.createElement('span');
  t.textContent = '共 ' + S.models.length + ' 个可用模型';
  foot.appendChild(t);
  pop.appendChild(foot);

  showPop(el.btnModel);
}

function openThinkPicker() {
  if (!S.thinkingLevels.length) {
    send({ type: 'get_available_thinking_levels' });
    toast('正在获取思考等级…', 'info');
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
          closePop();
          send({ type: 'set_thinking_level', level: name });
          el.thinkText.textContent = '思考 ' + name; // 乐观更新
          // pi 对非法档位也回 ok（实测 medium 被静默映射成 high，bogus 被忽略），
          // 所以必须回读状态，否则界面会显示一个 pi 根本没接受的档位
          send({ type: 'get_state' });
        },
      })
    );
  }

  showPop(el.btnThink);
}

/* ============ 附件 ============
 * pi 的原生附件只有图片（prompt/steer 的 images 字段，ImageContent 格式）。
 * PDF、Word 这些它读不了 —— 内置工具只有 bash/edit/grep/ls/read/write，
 * 所以由后端 lib/extract.js 先转成文本，再以 <pi-file> 块拼进消息正文。
 * 图片则保持原样走 images 字段，让模型真正“看”到图。 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(paths) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  }
  return s;
}

const FILE_ICON = {
  pdf: ['M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z', 'M14 3.5V7.5H18'],
  doc: ['M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z', 'M14 3.5V7.5H18', 'M9 12h6M9 15.5h4'],
  text: ['M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z', 'M14 3.5V7.5H18', 'M9 12h6M9 15.5h6'],
  bin: ['M6 5.5h12v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z', 'M9.5 5.5V4h5v1.5', 'M10 10v6M14 10v6'],
};

function iconFor(name) {
  const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (ext === 'pdf') return FILE_ICON.pdf;
  if (ext === 'doc' || ext === 'docx') return FILE_ICON.doc;
  if (['txt', 'md', 'csv', 'json', 'log', 'yml', 'yaml', 'xml'].includes(ext)) return FILE_ICON.text;
  return FILE_ICON.bin;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function attMeta(a) {
  if (a.loading) return '解析中…';
  if (a.error) return a.error;
  if (a.kind === 'image') return `图片 · ${fmtSize(a.size)}`;
  if (a.kind === 'text') {
    const bits = [];
    if (a.pages) bits.push(a.pages + ' 页');
    bits.push(fmt(a.chars) + ' 字');
    if (a.truncated) bits.push('已截断');
    if (a.note) bits.push(a.note);
    return bits.join(' · ');
  }
  return `二进制 · ${fmtSize(a.size)} · pi 读不了`;
}

async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => f && f.size > 0);
  if (!files.length) return;

  for (const f of files) {
    const isImg = /^image\//.test(f.type || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || '');
    const att = {
      id: 'tmp-' + Math.random().toString(36).slice(2),
      name: f.name || '粘贴的图片.png',
      size: f.size,
      loading: true,
      kind: isImg ? 'image' : 'unknown',
    };

    if (isImg) {
      try {
        att.dataUrl = await fileToDataUrl(f);
      } catch {
        /* 缩略图失败不影响上传 */
      }
    }

    S.attachments.push(att);
    renderAttachments();
    updateSendState();

    try {
      const r = await fetch('/api/upload?name=' + encodeURIComponent(att.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: f,
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '上传失败');

      // 保留客户端算出来的 kind（mime 更可靠），其余以后端为准
      const keepImg = att.kind === 'image';
      Object.assign(att, j);
      if (keepImg) att.kind = 'image';
      att.loading = false;
      if (j.error) att.error = j.error;
    } catch (err) {
      att.loading = false;
      att.error = err.message || '上传失败';
    }

    renderAttachments();
  }

  updateSendState();
}

function removeAttachment(id) {
  S.attachments = S.attachments.filter((a) => a.id !== id);
  renderAttachments();
  updateSendState();
}

function renderAttachments() {
  const box = el.attachTray;
  box.innerHTML = '';

  if (!S.attachments.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  for (const a of S.attachments) {
    const d = document.createElement('div');
    d.className = 'att' + (a.loading ? ' loading' : '') + (a.error ? ' err' : '');

    if (a.kind === 'image' && a.dataUrl) {
      const th = document.createElement('div');
      th.className = 'att-thumb';
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.alt = a.name;
      th.appendChild(img);
      d.appendChild(th);
    } else if (a.loading) {
      const ic = document.createElement('div');
      ic.className = 'att-ic';
      const sp = document.createElement('div');
      sp.className = 'att-spin';
      ic.appendChild(sp);
      d.appendChild(ic);
    } else {
      const ic = document.createElement('div');
      ic.className = 'att-ic';
      ic.appendChild(icon(iconFor(a.name)));
      d.appendChild(ic);
    }

    const body = document.createElement('div');
    body.className = 'att-body';
    const n = document.createElement('span');
    n.className = 'att-name';
    n.textContent = a.name;
    n.title = a.path || a.name;
    const m = document.createElement('span');
    m.className = 'att-meta';
    m.textContent = attMeta(a);
    body.append(n, m);
    d.appendChild(body);

    const x = document.createElement('button');
    x.className = 'att-x';
    x.title = '移除';
    x.appendChild(icon(['M7 7l10 10', 'M17 7L7 17']));
    x.onclick = (e) => {
      e.stopPropagation();
      removeAttachment(a.id);
    };
    d.appendChild(x);

    box.appendChild(d);
  }
}

/* 附件在消息正文里的标记。用自定义标签而不是 Markdown 代码块，
 * 是为了渲染时能折叠成一张卡片，避免几万字的 PDF 直接铺满对话。 */
const FILE_BLOCK_RE = /<pi-file name="([^"]*)" meta="([^"]*)">\n?([\s\S]*?)\n?<\/pi-file>/g;

function buildMessage(text) {
  const atts = S.attachments.slice();
  const images = atts.filter((a) => a.kind === 'image');
  const docs = atts.filter((a) => a.kind !== 'image');
  if (!atts.length) return text;

  const parts = [];
  if (text) parts.push(text);

  if (images.length) {
    parts.push(
      `【附件】以下 ${images.length} 张图片已作为图像内容提供：` +
        images.map((a) => a.name).join('、')
    );
  }

  const blocks = [];
  for (const a of docs) {
    if (a.kind === 'text') {
      const meta = [a.pages ? a.pages + ' 页' : '', fmt(a.chars) + ' 字', a.truncated ? '已截断' : '']
        .filter(Boolean)
        .join(' · ');
      blocks.push(
        `<pi-file name="${a.name}" meta="${meta}">\n${a.text}${a.truncated ? '\n…（内容过长，已截断）' : ''}\n</pi-file>`
      );
    } else {
      const why = a.error ? a.error : '无法解析为文本';
      blocks.push(
        `<pi-file name="${a.name}" meta="无法解析">\n（${why}）\n本机路径：${a.path || '未知'}\n如果这是文本类文件，可以用 read 工具按上面的路径读取。\n</pi-file>`
      );
    }
  }
  if (blocks.length) parts.push(blocks.join('\n\n'));

  return parts.join('\n\n');
}

function attachmentImages() {
  return S.attachments
    .filter((a) => a.kind === 'image' && a.dataUrl)
    .map((a) => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(a.dataUrl);
      return m ? { type: 'image', data: m[2], mimeType: m[1] } : null;
    })
    .filter(Boolean);
}

/* ============ 交互 ============ */

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 220) + 'px';
}

function updateSendState() {
  // 没有项目时 pi 没起来，发出去只会 503 —— 直接按住发送键
  if (!S.hasProject) {
    el.btnSend.disabled = true;
    return;
  }
  const hasText = Boolean(el.input.value.trim());
  const hasAtt = S.attachments.length > 0;
  el.btnSend.disabled = !hasText && !hasAtt;
}

async function submit() {
  if (!S.hasProject) {
    toast('还没有选择项目：先在左侧「添加文件夹」选一个目录。', 'info');
    return;
  }
  const text = el.input.value.trim();
  const atts = S.attachments.slice();
  if (!text && !atts.length) return;

  const message = buildMessage(text);
  const images = attachmentImages();

  el.input.value = '';
  S.attachments = [];
  renderAttachments();
  autoGrow();
  updateSendState();

  const cmd = { message };
  if (images.length) cmd.images = images;

  if (S.streaming) {
    // 运行中发送 → 作为引导消息插话
    await send({ type: 'steer', ...cmd });
    toast('已作为引导消息排队', 'info');
  } else {
    await send({ type: 'prompt', ...cmd });
  }
}

async function stop() {
  if (!S.streaming) return;
  await send({ type: 'abort' });
  setStatus('已请求停止…');
}

async function newSession() {
  await send({ type: 'new_session' });
}

function compactNow() {
  send({ type: 'compact' });
  toast('已请求压缩上下文', 'info');
}

/* --- 会话统计 --- */

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
  send({ type: 'get_session_stats' });
}

/* --- 会话重命名 --- */

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
      send({ type: 'set_session_name', name });
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

/* --- 更多菜单 --- */

function openMoreMenu() {
  openModal((card, close) => {
    const h = document.createElement('h3');
    h.textContent = '更多';
    card.appendChild(h);

    const list = document.createElement('div');
    list.className = 'modal-list';

    const entries = [
      ['重命名会话', renameSession],
      ['导出会话 HTML', () => send({ type: 'export_html' })],
      ['压缩上下文', compactNow],
      ['会话统计', () => { close(); openStatsPanel(); }],
      ['重载 pi 配置', () => { close(); reloadPi(); }],
    ];

    for (const [label, fn] of entries) {
      const item = document.createElement('div');
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

/* ============ 事件绑定 ============ */

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
    if (!pop.hidden) {
      closePop();
      return;
    }
    stop();
  }
});

// 输入区
el.btnSend.onclick = submit;
el.btnStop.onclick = stop;
el.btnModel.onclick = () => {
  if (!pop.hidden && popAnchor === el.btnModel) return closePop();
  openModelPicker();
};
el.btnThink.onclick = () => {
  if (!pop.hidden && popAnchor === el.btnThink) return closePop();
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
  if (pop.hidden) openCtxTip();
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
$('btnShare').onclick = () => send({ type: 'export_html' });
$('btnStats').onclick = openStatsPanel;

// 侧栏导航
$('navNew').onclick = newSession;
$('navBranches').onclick = openBranchPanel;
$('navProviders').onclick = openProvidersPanel;

// 侧栏头部 / 项目
// 「添加文件夹」在两处：侧栏分组下常年有一个，欢迎块上在未选项目时再补一个
$('btnReload').onclick = reloadPi;
$('btnCompact').onclick = compactNow;
$('btnAddProject').onclick = openDirPicker;
$('btnPickProject').onclick = openDirPicker;

// 项目分组折叠状态记忆
const group = $('groupHead').parentElement;
try {
  if (localStorage.getItem('pi-group-open') !== '0') group.classList.add('open');
} catch {
  group.classList.add('open');
}
$('groupHead').onclick = () => {
  group.classList.toggle('open');
  try {
    localStorage.setItem('pi-group-open', group.classList.contains('open') ? '1' : '0');
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
};

/* ============ 启动 ============ */

/* 欢迎块自动显隐。挂在整个对话区上（subtree），这样无论消息是从哪条路径
 * 进来的 —— 实时流式、历史重建、清空重画 —— 都能跟上。 */
new MutationObserver(syncWelcome).observe(el.stream, { childList: true, subtree: true });
syncWelcome();

loadProjects();
loadProviders();
autoGrow();
/* 先按「还没选项目」摆一次，锁住输入区。
 * 真的有项目时 loadStatus 会立刻把它打开 —— 那一瞬间两块引导都是藏着的，
 * 所以不会闪出错误文案（页面里的默认态也是都藏，见 index.html 的说明）。 */
applyProjectState();
updateSendState();
renderAttachments();
renderCtxChip();
el.input.focus();

// 先拿到 cwd 再连事件流，保证导出提示里的路径一开始就是绝对的
loadStatus().then(connect);
