/* 会话搜索：输入框 + 范围筛选 + 结果视图。
 *
 * ---------- 它挂在哪 ----------
 *
 * 不新开面板，也不做独立的「会话管理后台」—— **就挂在当前项目那一行下面的
 * 会话区域里**（与 sessions.js 同一块 `.pj-sessions`）。会话本来就属于项目，
 * 搜索也一样，把这个前提保持住，用户不需要先想「我要搜什么」再想「哪个项目」。
 *
 * 三种视图状态（由 sessions.js 的列表区按 searchViewMode() 决定）：
 *   list   关键词为空        → 原样显示普通会话列表
 *   hint   未满 MIN_QUERY    → 提示再输几个字，**不发请求**
 *   search 可以搜了          → 显示结果 / 正在搜索 / 没找到 / 搜索失败
 *
 * ---------- 四件必须守住的事 ----------
 *
 * 1. **debounce**：每敲一个字就扫磁盘是不可接受的。停下来 220ms 才发请求。
 * 2. **stale response 二次校验**：`requestId` 挡住「abcd 先回来、abc 后回来」
 *    （旧结果不许覆盖新结果）；`S.workspaceGeneration` 挡住「在 A 搜索、切到 B、
 *    A 的结果才回来」（跨项目的旧结果必须丢弃）。两者缺一不可 —— 它们挡的是
 *    两类不同的竞态。
 * 3. **snippet 只走文本节点**。它是会话正文，属于不可信输入。高亮用
 *    `createElement('mark')` + `textContent`，**一次 `innerHTML` 都不用** ——
 *    不能因为「要加个高亮」把 XSS 防线重新打开。
 * 4. **不显示文件名、不显示路径**。后端也不回，这里是第二道。
 *
 * ---------- 与 sessions.js 的分工 ----------
 *
 * sessions.js 拥有那块 `.pj-sessions` 容器与普通列表；本模块拥有搜索状态与
 * 结果视图。两边用一个注册进来的回调通信（`setSearchChangeHandler`），
 * 而不是互相 import —— sessions.js 已经 import 本模块，反向 import 会成环
 * （ESM 链接器会把环断掉，症状是「某个导出是 undefined」）。
 */
import { searchSessions } from './api.js';
import { S, ownsWorkspace } from './state.js';
import { fmtTime } from './util.js';

/** 输入停下多久才真的发请求。 */
const DEBOUNCE_MS = 220;
/** 少于这个长度不发请求（1 个字符几乎必然命中一切）。 */
const MIN_QUERY = 2;
/** 后端也会截断，这里先拦一道。 */
const MAX_QUERY = 64;

export const SCOPES = [
  { id: 'active', label: '活跃', title: '只在未归档的会话里搜' },
  { id: 'archived', label: '已归档', title: '只在已归档的会话里搜' },
  { id: 'all', label: '全部', title: '活跃与已归档都搜' },
];

/* ---------- 模块级状态（与 sessions.js 的 expanded / archivedOpen 同一风格）---------- */

let query = '';
let scope = 'active';
/** idle | loading | ready | error */
let status = 'idle';
let results = [];
let errorText = '';
/** 递增的请求号：回来晚了的一律丢弃。 */
let requestId = 0;
let timer = null;
/** 状态变化后请宿主重画列表区（由 sessions.js 注入）。 */
let changeHandler = () => {};

export function setSearchChangeHandler(fn) {
  changeHandler = typeof fn === 'function' ? fn : () => {};
}

const notify = () => {
  try {
    changeHandler();
  } catch {
    /* 宿主重画失败不该带塌搜索 */
  }
};

export const currentQuery = () => query;
export const currentScope = () => scope;

/** list | hint | search —— 由宿主据此决定列表区画什么。 */
export function searchViewMode() {
  const q = query.trim();
  if (!q) return 'list';
  if (q.length < MIN_QUERY) return 'hint';
  return 'search';
}

/**
 * 清空搜索状态。
 *
 * **切项目时必须调**：否则会拿着 A 项目的结果去渲染 B 项目的侧栏。
 * （就算不调，generation 校验也会丢弃迟到的响应，但那是一个「刚好没出错」，
 * 不是「结构上不会错」。）
 */
export function resetSearch() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  requestId++; // 让在途请求全部作废
  query = '';
  status = 'idle';
  results = [];
  errorText = '';
}

/** 会话变了（切会话 / 归档 / 删除）之后重搜一次，让结果跟上当前状态。 */
export function refreshSearch() {
  if (searchViewMode() === 'search') run(0);
}

/* ---------- 输入框 ---------- */

export function createSearchBar() {
  const wrap = document.createElement('div');
  wrap.className = 'pj-search';

  const row = document.createElement('div');
  row.className = 'pj-search-row';

  const icon = document.createElement('span');
  icon.className = 'pj-search-ic';
  icon.textContent = '⌕';
  icon.setAttribute('aria-hidden', 'true');

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'pj-search-input';
  input.placeholder = '搜索会话…';
  input.setAttribute('aria-label', '在当前项目里搜索会话');
  input.value = query;
  input.maxLength = MAX_QUERY;
  /* 点右上角的 ✕（type=search 自带）会触发 search 事件 */
  input.addEventListener('input', () => {
    query = input.value;
    onQueryChanged();
  });
  input.addEventListener('search', () => {
    query = input.value;
    onQueryChanged();
  });
  /* Esc 清空并回到普通列表 —— 与「弹层 Esc 关闭」同一个心气 */
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && query) {
      e.stopPropagation();
      input.value = '';
      query = '';
      onQueryChanged();
    }
  });

  row.append(icon, input);
  wrap.append(row);

  const scopes = document.createElement('div');
  scopes.className = 'pj-search-scopes';
  for (const s of SCOPES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pj-search-scope' + (s.id === scope ? ' on' : '');
    b.textContent = s.label;
    b.title = s.title;
    b.dataset.scope = s.id;
    b.onclick = () => {
      if (scope === s.id) return;
      scope = s.id;
      for (const other of scopes.children) other.classList.toggle('on', other.dataset.scope === scope);
      /* 换范围立刻重搜（不受 debounce 影响：这是明确的用户动作） */
      if (searchViewMode() === 'search') run(0);
      else notify();
    };
    scopes.append(b);
  }
  wrap.append(scopes);
  return wrap;
}

function onQueryChanged() {
  if (timer) clearTimeout(timer);
  const mode = searchViewMode();
  if (mode !== 'search') {
    /* 回到 list / hint：**立即**反馈，不等 debounce —— 让用户马上看到
     * 「列表回来了」或「还差几个字」。 */
    status = 'idle';
    results = [];
    errorText = '';
    requestId++; // 作废在途请求，免得它回来又把结果画上
    notify();
    return;
  }
  /* 已经搜过一轮、现在只是多敲了一个字：先把「正在搜索…」摆出来，
   * 否则界面会停在上一轮的结果上，看起来像没反应。 */
  if (status !== 'loading') {
    status = 'loading';
    notify();
  }
  timer = setTimeout(() => {
    timer = null;
    run(0);
  }, DEBOUNCE_MS);
}

/**
 * 发一次搜索。
 * @param delayMs 0 = 立刻（换范围 / 手动刷新时用）
 */
function run(delayMs) {
  const q = query.trim().slice(0, MAX_QUERY);
  if (q.length < MIN_QUERY) return;

  const myId = ++requestId;
  /* 记下发请求时的工作区代号 —— 切项目之后它会对不上，结果直接丢。 */
  const gen = S.workspaceGeneration;
  status = 'loading';
  errorText = '';
  notify();

  const fire = () => {
    Promise.resolve()
      .then(() => searchSessions(q, scope))
      .catch((err) => ({ ok: false, error: String(err && err.message ? err.message : err), network: true }))
      .then((res) => {
        /* ---- 两次校验，两类竞态 ---- */
        if (myId !== requestId) return; // abc / abcd：旧的那次回来晚了
        if (!ownsWorkspace(gen)) return; // 已经切走了项目
        if (res && res.ok === true) {
          status = 'ready';
          results = Array.isArray(res.results) ? res.results : [];
          errorText = '';
        } else {
          status = 'error';
          errorText = (res && res.error) || '搜索失败';
          results = [];
        }
        notify();
      });
  };

  if (delayMs > 0) setTimeout(fire, delayMs);
  else fire();
}

/* ---------- 结果视图 ---------- */

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

const TYPE_LABEL = { title: '标题', user: '你问的', assistant: 'Pi 回的' };

/**
 * 把 text 填进 parent，并把 q 的每一处命中包成 <mark>。
 *
 * **全程文本节点 + createElement，零 innerHTML** —— snippet 是会话正文，
 * 属于不可信输入。不要为了高亮换回拼字符串。
 */
function fillHighlight(parent, text, q) {
  const needle = String(q || '').toLowerCase();
  const hay = String(text == null ? '' : text);
  if (!needle) {
    parent.textContent = hay;
    return;
  }
  const lower = hay.toLowerCase();
  let i = 0;
  let at = lower.indexOf(needle, i);
  while (at !== -1) {
    if (at > i) parent.append(document.createTextNode(hay.slice(i, at)));
    const mk = document.createElement('mark');
    mk.textContent = hay.slice(at, at + needle.length);
    parent.append(mk);
    i = at + needle.length;
    at = lower.indexOf(needle, i);
  }
  if (i < hay.length) parent.append(document.createTextNode(hay.slice(i)));
}

function statusLine(text, cls) {
  return node('div', 'pj-sess-hint' + (cls ? ' ' + cls : ''), text);
}

function makeResult(res, onPick) {
  const box = node('div', 'pj-sr');
  box.dataset.sessionId = res.id;
  if (res.archived) box.classList.add('archived');

  const head = node('div', 'pj-sr-head');
  const title = node('span', 'pj-sr-title', res.title || '（无标题）');
  head.append(title);
  if (res.archived) head.append(node('span', 'pj-sr-badge', '已归档'));
  head.append(node('span', 'pj-sr-time', fmtTime(res.updatedAt)));
  box.append(head);

  const meta = node('div', 'pj-sr-meta', `${res.matchCount || (res.matches || []).length} 处命中 · ${res.messageCount || 0} 条消息`);
  box.append(meta);

  for (const m of res.matches || []) {
    const line = node('div', 'pj-sr-hit');
    line.dataset.matchType = m.type;
    line.append(node('span', 'pj-sr-type', TYPE_LABEL[m.type] || m.type));
    const snip = node('span', 'pj-sr-snip');
    fillHighlight(snip, m.snippet || '', currentQuery().trim());
    line.append(snip);
    line.onclick = (e) => {
      e.stopPropagation();
      onPick(res, m);
    };
    box.append(line);
  }

  box.onclick = () => onPick(res, (res.matches || [])[0] || null);
  return box;
}

/**
 * 把当前搜索状态画进列表区。
 *
 * @param container 列表区元素（sessions.js 建的 `.pj-sess-list`）
 * @param onPick    点某条命中时调用：onPick(sessionResult, match)
 */
export function renderSearchResults(container, { onPick }) {
  container.replaceChildren();
  container.dataset.view = 'search';

  const mode = searchViewMode();
  if (mode === 'hint') {
    container.append(statusLine(`再输入至少 ${MIN_QUERY} 个字符（支持中文与英文，不区分大小写）`));
    return;
  }
  if (mode === 'list') return;

  if (status === 'loading') {
    container.append(statusLine('正在搜索…', 'pj-sr-loading'));
    return;
  }
  if (status === 'error') {
    container.append(statusLine('搜索失败：' + (errorText || '未知原因'), 'pj-sr-error'));
    return;
  }
  if (!results.length) {
    container.append(statusLine('没有找到相关会话'));
    return;
  }

  const n = results.reduce((a, r) => a + ((r.matches || []).length || 0), 0);
  container.append(node('div', 'pj-sess-hint', `找到 ${results.length} 个会话、${n} 处命中`));
  for (const r of results) container.append(makeResult(r, onPick));
}
