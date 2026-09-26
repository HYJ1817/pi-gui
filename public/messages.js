/* 对话渲染。
 *
 * 这里处理 pi 事件流里最麻烦的两条约定（见 pi docs/rpc.md）：
 *   - message_update 只给 delta，没有累积快照 → 按 contentIndex 自行组装，
 *     并以 message_end.message 为最终权威校正
 *   - tool_execution_update.partialResult 是累积值 → 直接替换（在 tools.js）
 *
 * 另外有一条硬规则：**助手消息绝不允许静默空白**。
 * 上游报错时 pi 返回的是 {content:[], stopReason:'error', errorMessage:'402: …'}，
 * 早期实现遇到空 content 就直接 return，用户看到的是一个空白的「Pi」，
 * 完全不知道发生了什么。现在失败、中断、真没内容三种情况都有对应呈现。
 *
 * 空白还有第二个来源：**只有工具调用**的助手消息（content 全是 toolCall，
 * 没有 text / thinking）。这类消息渲染不出任何正文，外壳留着就是一条孤零零的
 * 「Pi」—— 实测 11 个真实会话里有 20 条。所以整条外壳（含角色行）直接收掉，
 * 由 rebuildAssistant 的返回值告诉调用方「这次有没有值得占位的正文」。
 *
 * 收掉外壳**不等于那次工具调用消失了** —— 它由 Tool Timeline 呈现
 * （实时见 tools.js，历史见下面的 rebuildFromMessages + tool-history.js）。
 * 两者渲染的是同一个 ToolEntry 结构，所以刷新前后语义一致。 */

import { el, S } from './state.js';
import { registerConversationAnchor, rebuildConversationNav, clearConversationNav } from './conversation-nav.js';
import { esc, icon, iconFor } from './util.js';
import { md } from './markdown.js';
import { sendCommand } from './api.js';
import { updateSendState } from './composer.js';
import { FILE_BLOCK_RE } from './attachments.js';
import { clearLiveEntries, hasRunning, settleRunning } from './tool-model.js';
import { planHistory } from './tool-history.js';
import { addToGroup, createGroup, renderEntry } from './tool-view.js';

/* ---------- 线程与滚动 ---------- */

/* 空会话显示欢迎块，有内容就收起来。
 *
 * 早先是在 ensureThread() 里把 #welcome 直接 remove() 掉 —— 新会话一建出
 * 空线程，欢迎块就永久消失，对话区变成一片纯黑，用户看不到任何引导。
 * 现在改成显隐切换（见 syncWelcome），元素始终留在 DOM 里。 */
export function ensureThread() {
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
export function syncWelcome() {
  const w = document.getElementById('welcome');
  if (!w) return;
  const hide = Boolean(S.thread && S.thread.childElementCount);
  if (w.hidden !== hide) w.hidden = hide;
}

export function clearThread() {
  if (S.thread) S.thread.innerHTML = '';
  S.current = null;
  S.blocks.clear();
  S.tools.clear();
  /* 时间线的实时状态也要清 —— 留着的话，换会话之后 applyGitStats 还会去扫
   * 一批已经不在 DOM 里的旧条目。ticker 会自己停（S.tools 空了就没有 running）。 */
  clearLiveEntries();
  S.tlGroup = null;
  hideWorking();
  /* 对话区清空了，导航也跟着清 —— 否则换会话/切项目时会短暂留着上一个
   * 会话的标记（§13 明确不许）。 */
  clearConversationNav();
}

export function scrollBottom(force) {
  const s = el.stream;
  const nearBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  if (force || nearBottom) {
    requestAnimationFrame(() => {
      s.scrollTop = s.scrollHeight;
    });
  }
}

/* ---------- 「正在处理」指示 ---------- */

export function showWorking() {
  hideWorking();
  const t = ensureThread();
  const w = document.createElement('div');
  w.className = 'working';
  w.innerHTML = '<span class="spinner"></span><span>Pi 正在处理…</span>';
  t.appendChild(w);
  S.working = w;
  syncToolWorking();
}

export function hideWorking() {
  if (S.working) {
    S.working.remove();
    S.working = null;
  }
}

export function moveWorkingToEnd() {
  if (S.working && S.thread) S.thread.appendChild(S.working);
}

/* 有工具在跑时把「Pi 正在处理…」收起来（§14）。
 *
 * 时间线上的 running 条目本身已经把「正在工作」说清楚了，再挂一句
 * 「Pi 正在处理…」就是同一句话说两遍；更糟的是它会夹在工具条目之间反复出现，
 * 看起来像状态在横跳。
 *
 * 这里只做**弱化**（把指示器藏起来），不碰 streaming 状态机 ——
 * setStreaming / showWorking / hideWorking 的时序一行没改。
 *
 * 用 hidden 而不是 remove：working 元素会被 moveWorkingToEnd 反复搬位置，
 * 删掉它就得在每条路径上判断「要不要重建」，反而更容易漏。 */
export function syncToolWorking() {
  if (!S.working) return;
  S.working.hidden = hasRunning();
}

export function setStreaming(on) {
  S.streaming = on;
  el.btnStop.hidden = !on;
  if (on) showWorking();
  else hideWorking();
  updateSendState();
}

export function onSettled() {
  interruptActive();
  sendCommand({ type: 'get_session_stats' });
  sendCommand({ type: 'get_state' });
  sendCommand({ type: 'get_tree' });
  el.input.focus();
}

export function interruptActive() {
  setStreaming(false);
  S.current = null;
  S.blocks.clear();
  /* agent 已经收尾了，还有条目停在 running —— 说明那次工具执行没有等到
   * tool_execution_end（用户中断 / 进程被杀 / 上游报错）。让它们永远转下去
   * 是不对的：界面会一直显示「运行中」，而且 hasRunning() 恒为真会让
   * 「Pi 正在处理…」再也不出现。 */
  settleRunning();
}

/* ---------- 用户消息 ---------- */

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
export function userBody(msg) {
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

export function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  return '';
}

/* resultText 搬去了 tool-model.js —— 它是「工具返回值长什么样」的协议知识，
 * 时间线（实时 + 历史）和消息渲染都要用，放在数据模型那一层更合适。 */

function renderUser(msg) {
  const t = ensureThread();
  /* 用户消息是工具分组的硬边界：上一条 assistant 那批工具已经彻底结束了。
   * 放在这里而不是靠时间判断 —— §12 明确禁止「超过几秒算新组」那种猜测。 */
  S.tlGroup = null;

  const wrap = document.createElement('div');
  wrap.className = 'msg user';

  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = '你';

  wrap.append(role, userBody(msg));
  t.appendChild(wrap);
  /* 立刻注册导航点（§11）：不等 assistant 回复完 —— 用户刚发完就该能
   * 在左边看到自己这一条的位置。 */
  registerConversationAnchor(wrap);
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

export function onMessageStart(evt) {
  const msg = evt.message || {};
  if (msg.role === 'user') return renderUser(msg);
  if (msg.role !== 'assistant') return;

  /* 新的 assistant 消息开始 = 上一批工具调用已经跑完了（实测的事件顺序是
   * message_end → tool_execution_start，所以组在这里关掉正好）。
   * 这是**真实边界**：消息本身就是边界。 */
  S.tlGroup = null;
  createAssistant();
}

/* ---------- 流式块组装 ---------- */

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

export function onMessageUpdate(evt) {
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

export function onMessageEnd(evt) {
  const msg = evt.message;
  if (msg?.role === 'assistant' && S.current) {
    // message_end.message 是权威，用它校正渲染结果
    const keep = rebuildAssistant(S.current.body, msg);
    /* 只有工具调用、没有正文时整条外壳收掉。
     * 工具卡片由 tools.js 直接挂在 thread 上，不在这个 body 里，所以不受影响；
     * 下一轮 message_start 会再建一个新的外壳。 */
    if (!keep) S.current.wrap.remove();
  }
  S.current = null;
  S.blocks.clear();
  moveWorkingToEnd();
  scrollBottom();
}

/* ---------- 失败 / 中断 / 空回复 ---------- */

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

export function explainError(raw) {
  const s = String(raw || '');
  for (const [re, title, hint] of ERR_RULES) {
    if (re.test(s)) return { title, hint };
  }
  return { title: '请求失败', hint: '' };
}

export function errorBlock(msg) {
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

export function noteBlock(text) {
  const d = document.createElement('div');
  d.className = 'msg-note';
  d.textContent = text;
  return d;
}

/**
 * 在对话区里留一条**留得住**的说明（历史读不出来时用）。
 *
 * 为什么不用 toast：toast 会自己消失，而且对话区仍然一片空白 —— 用户会以为
 * 「对话丢了」。这条留在那里，直到下一次成功的历史重建把它清掉。
 */
export function noteLoadFailure(text) {
  const t = ensureThread();
  t.appendChild(noteBlock(text));
}

/* 重试开始时撤掉上一次留下的错误块（message_end 已经把 S.current 清空了，
 * 所以还要能回退到对话区里最后一条助手消息）。
 *
 * **只撤错误块是不够的**：pi 每重试一次就重发一次 message_start，所以失败那轮
 * 已经建好了一个新的「Pi」外壳（createAssistant）。错误块一撤，外壳就成了一条
 * 没有正文的空白「Pi」；上游连续失败三次，对话里就是三条空白（实测如此，
 * 数据见会话 jsonl：三条 stopReason=error 且 content 为空的消息）。
 * 所以外壳空了就连它一起收走。
 *
 * 反过来，body 里还有别的东西（失败前已经流出来的正文）时**保留外壳** ——
 * 那是用户已经看到的内容，不该跟着错误块消失。
 * S.current 还指着它时也不动：那说明 message_end 还没跑，外壳马上会被复用。 */
export function dropTrailingError() {
  const body = S.current?.body || [...document.querySelectorAll('#stream .thread .msg.assistant .msg-body')].pop();
  if (!body) return;

  const last = body.lastElementChild;
  if (last && last.classList.contains('msg-err')) last.remove();

  if (!body.childElementCount && S.current?.wrap !== body.parentElement) {
    body.parentElement?.remove();
  }
}

/* 用 message_end 的权威内容重建一条助手消息的正文。
 *
 * **返回值 = 这条消息有没有值得占位的正文**（bodyEl 里落了东西就是 true）。
 * 调用方据此决定要不要保留外层那圈「Pi」角色行 —— 只有 toolCall 的助手消息
 * 渲染不出任何东西，返回 false，调用方把整个外壳收掉，别留空白。
 *
 * 三种「没有正文」要分开看，别混成一种：
 *   - 有 toolCall 之类不可渲染的 part → 什么都不加，返回 false（收掉外壳）
 *   - content 真的为空、也不是失败/中断 → 加一句提示，返回 true（不是空白）
 *   - 失败 / 中断 → 加错误卡片或「已中断」，返回 true */
export function rebuildAssistant(bodyEl, msg) {
  const content = Array.isArray(msg.content) ? msg.content : [];
  const failed = msg?.stopReason === 'error' || Boolean(msg?.errorMessage);
  const aborted = msg?.stopReason === 'aborted';

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
  } else if (!content.length && !failed && !aborted) {
    // 既没内容也不是失败 —— pi 这次什么都没返回，给个提示别留空白
    bodyEl.appendChild(noteBlock('（这次没有返回内容）'));
  }

  if (failed) bodyEl.appendChild(errorBlock(msg));
  else if (aborted) bodyEl.appendChild(noteBlock('已中断'));

  return bodyEl.childElementCount > 0;
}

export function rebuildFromMessages(data) {
  const msgs = Array.isArray(data) ? data : data?.messages || [];
  clearThread();
  const t = ensureThread();
  /* 先全拼进 DocumentFragment 再一次性挂上去（§17）：一段历史可能有几百条，
   * 逐条 append 会触发同样多次布局计算。 */
  const frag = document.createDocumentFragment();

  /* 配对规则全部在 tool-history.js 里（纯函数，可单独测）：
   * toolCall + 对应 toolResult → 一条完整的时间线条目；
   * 缺 result → 「未完成」；孤儿 result → 就地降级显示，不丢也不崩。 */
  for (const item of planHistory(msgs)) {
    if (item.kind === 'user') {
      const wrap = document.createElement('div');
      wrap.className = 'msg user';
      wrap.innerHTML = '<div class="msg-role">你</div>';
      wrap.appendChild(userBody(item.message));
      frag.appendChild(wrap);
      continue;
    }

    if (item.kind === 'assistant') {
      const wrap = document.createElement('div');
      wrap.className = 'msg assistant';
      wrap.innerHTML = '<div class="msg-role">Pi</div>';
      const body = document.createElement('div');
      body.className = 'msg-body';
      /* 重建历史时同样不留空白「Pi」：只有工具调用的那轮没有正文可渲染，
       * 整条跳过。那次工具调用不会因此消失 —— 紧跟其后的 tools 计划项会画它。 */
      if (!rebuildAssistant(body, item.message)) continue;
      wrap.appendChild(body);
      frag.appendChild(wrap);
      continue;
    }

    if (item.kind === 'tools' && item.entries.length) {
      const g = createGroup();
      for (const entry of item.entries) addToGroup(g, renderEntry(entry));
      frag.appendChild(g);
    }
  }

  t.appendChild(frag);
  /* 历史重建完之后**重新扫一遍 DOM** 建导航（§10）—— 刷新页面、重开 App、
   * 恢复旧会话、fork、retry 之后走的都是这条路。不自己维护消息副本，
   * 所以这里不需要知道「刚才删了哪几条」。 */
  rebuildConversationNav();

  /* 有人接管了定位就不再把视图拽到底部。
   * scrollBottom 走的是 requestAnimationFrame —— 若定位在这之后同步发生，
   * 那一帧会把刚滚到的位置又拉回最底（用户看到的是「跳转没生效」）。 */
  let handled = false;
  if (afterHistoryRendered) {
    try {
      handled = afterHistoryRendered() === true;
    } catch {
      /* 监听方自己炸了不该带塌历史重建 */
      handled = false;
    }
  }
  if (!handled) scrollBottom(true);
}

/* 「历史已经渲染完了」的生命周期事件。
 *
 * 为什么需要它：切会话是**异步**的 —— `afterSessionSwitch()` 只是
 * `setTimeout(boot, 250)`，还要再等 `get_messages` 一个来回，重建才真的发生。
 * 「切过去并跳到某次提问」如果靠 setTimeout(几百毫秒) 猜，在慢机器或大会话上
 * 必然错。所以给一个明确的完成信号，而不是猜时间。
 *
 * 触发点放在**导航重建之后**：那一刻 DOM 与 minimap 都已就绪，滚动定位才有意义。
 * 监听方返回 `true` 表示「这次位置由我决定」，调用方就不再滚到底。
 *
 * 用注册回调而不是 import —— messages.js 不能 import sessions.js / 搜索模块
 * （会成环），而它也不该知道有谁在听。 */
let afterHistoryRendered = null;
export function setAfterHistoryRendered(fn) {
  afterHistoryRendered = typeof fn === 'function' ? fn : null;
}
