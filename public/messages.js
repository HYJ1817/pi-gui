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
 * 完全不知道发生了什么。现在失败、中断、真没内容三种情况都有对应呈现。 */

import { el, S } from './state.js';
import { esc, icon, iconFor } from './util.js';
import { md } from './markdown.js';
import { sendCommand } from './api.js';
import { updateSendState } from './composer.js';
import { FILE_BLOCK_RE } from './attachments.js';

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
  hideWorking();
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

export function setStreaming(on) {
  S.streaming = on;
  el.btnStop.hidden = !on;
  if (on) showWorking();
  else hideWorking();
  updateSendState();
}

export function onSettled() {
  setStreaming(false);
  S.current = null;
  S.blocks.clear();
  sendCommand({ type: 'get_session_stats' });
  sendCommand({ type: 'get_state' });
  sendCommand({ type: 'get_tree' });
  el.input.focus();
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

export function resultText(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  if (Array.isArray(res.content)) return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (typeof res.text === 'string') return res.text;
  return '';
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

export function onMessageStart(evt) {
  const msg = evt.message || {};
  if (msg.role === 'user') renderUser(msg);
  else if (msg.role === 'assistant') createAssistant();
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
    rebuildAssistant(S.current.body, msg);
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

/* 重试开始时撤掉上一次留下的错误块（message_end 已经把 S.current 清空了，
 * 所以还要能回退到对话区里最后一条助手消息） */
export function dropTrailingError() {
  const box = S.current?.body || [...document.querySelectorAll('#stream .thread .msg.assistant .msg-body')].pop();
  const last = box?.lastElementChild;
  if (last && last.classList.contains('msg-err')) last.remove();
}

export function rebuildAssistant(bodyEl, msg) {
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

export function rebuildFromMessages(data) {
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
