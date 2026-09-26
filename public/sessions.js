/* 侧栏的会话列表。
 *
 * ---------- 为什么不是弹窗 ----------
 *
 * 第一版做成了一个独立的「会话」面板（点侧栏入口开 Modal）。但会话本来就属于
 * 项目 —— 把它单开一个窗口，等于让用户先想「我要看会话」再想「是哪个项目的」，
 * 而且和项目列表分处两个地方，切项目之后还要重新打开。
 *
 * 现在照 Codex 的做法：**会话直接列在当前项目那一行下面**，随项目列表一起渲染。
 * 点一条即切；当前那条高亮且不可点。
 *
 * ---------- 为什么需要它 ----------
 *
 * Pi GUI 一直有「新对话」，却**没有入口切回旧会话** —— 用户点一下，旧对话就
 * 从界面上消失了。它其实完整躺在磁盘上（pi 把每个会话存成独立的 `.jsonl`），
 * 但界面上再也够不着，看起来就像「对话丢了」。
 *
 * pi 的 RPC 有 `switch_session` 但没有「列出会话」，所以列表由后端扫
 * `<agentDir>/sessions/` 得到（见 server/sessions.js）。
 *
 * ---------- 五条必须守住的规矩 ----------
 *
 * 1. **只传后端给的稳定 ID**，不传路径。后端在自己的索引里解析真实路径，
 *    并核对那条会话确实属于当前项目 ⇒ 不可能切到别的项目上去。
 * 2. **切换后必须走 afterSessionSwitch()**：清空对话区与变更账本再重建。
 *    不走这一步的话，切完界面还挂着上一个会话的消息，看着像「切了没生效」。
 * 3. **正在流式输出时不给切** —— 切走会让那一轮的回答悬在半空。
 * 4. ⚠️ **会话一变就必须重画这个列表。** 列表原本只在 renderProjects() 里渲染，
 *    而 new_session / fork / 切换都不触发它 —— 于是列表停在旧状态：旧会话仍然
 *    带着 `current` 标记，而当前项是**不给点**的（你已经在里面了），用户就再也
 *    回不到那条对话。这正是「开个新对话，旧对话就消失了」的真正原因。
 *    现在由 rpc.js 的 afterSessionSwitch() 通过 setSessionListRefresh() 回调触发。
 * 5. **归档 / 删除不能碰当前会话**：pi 正开着那个文件往里追加。后端也会拒，
 *    界面这一层先不给按钮，避免用户点出一个必然失败的确认框。
 * 6. **搜索框只建一次，重画只画列表区。** 输入框挂在列表区上面；跟着列表区
 *    一起重建的话，每敲一个字都会丢焦点与光标位置。搜索状态本体在
 *    `session-search.js` 里，本模块只负责「按状态决定列表区画什么」。
 */
import { fetchSessions, switchSession, renameSession, archiveSession, deleteSession } from './api.js';
import { afterSessionSwitch } from './rpc.js';
import { S } from './state.js';
import { fmtTime } from './util.js';
import { toast } from './ui/toast.js';
import { confirmModal } from './ui/modal.js';
import { setAfterHistoryRendered } from './messages.js';
import { scrollToUserTurn } from './conversation-nav.js';
import {
  createSearchBar,
  renderSearchResults,
  searchViewMode,
  resetSearch,
  refreshSearch,
  setSearchChangeHandler,
} from './session-search.js';

/** 进行中的会话一次最多列几条，超出折叠（和 Codex 一样给个「展开显示」）。 */
const COLLAPSED = 6;
/** 已归档的默认全部展开，但给个上限，免得几百条把侧栏撑爆。 */
const MAX_ARCHIVED = 50;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

/**
 * 某个 pi 能力是否**已被证实**不可用（兼容层报告，见 server/pi-compat.js）。
 *
 * 没拿到兼容摘要时一律返回 false（= 按可用处理）。这是刻意的：**未验证 ≠ 不支持**，
 * 而且宁可让用户点一下发现不行，也不要在状态还没回来时先把功能藏了。
 */
function capMissing(name) {
  return Boolean(S.compat && Array.isArray(S.compat.missing) && S.compat.missing.indexOf(name) !== -1);
}

/* fmtTime 搬去了 util.js —— 搜索模块也要用同一套相对时间写法，
 * 各写一份会让同一个会话在侧栏和搜索结果里显示成两个时间。 */

/* 当前挂着的那块列表、它的「列表区」、以及这份会话数据。
 * 只可能有一块（会话只列在当前项目下面），所以用模块级状态就够。
 *
 * 为什么要把「列表区」单独拎出来：搜索框挂在列表区**上面**且只建一次，
 * 输入时只重画列表区 —— 否则每敲一个字都会重建输入框，光标和焦点全丢。 */
let boxRef = null;
let listRef = null;
let dataRef = null;
let loadToken = 0;
let expanded = false;
let archivedOpen = false;

/* 点了搜索结果之后要跳到的那次提问。切会话是异步的（afterSessionSwitch 只是
 * setTimeout(boot,250)，还要等 get_messages 一个来回），所以**不能在点击处
 * 直接滚** —— 那时新历史还没渲染出来。存下来，等「历史渲染完成」的生命周期
 * 回调来消费。带时间戳是为了兜底：万一那个会话没渲染成功（切失败 / 文件没了），
 * 这个待办不能一直挂着等下一次重建时错误地生效。 */
let pendingLocate = null;
const LOCATE_TTL_MS = 15000;

setAfterHistoryRendered(() => {
  const p = pendingLocate;
  pendingLocate = null;
  if (!p) return false;
  if (Date.now() - p.at > LOCATE_TTL_MS) return false; // 过期了，宁愿不跳也不要乱跳
  return scrollToUserTurn(p.userIndex);
});

/* 搜索结果变化 → 重画列表区（不碰输入框）。 */
setSearchChangeHandler(() => {
  paintList();
});

function moreBtn(text, onclick, cls) {
  const b = el('div', 'pj-sess-more' + (cls ? ' ' + cls : ''), text);
  b.onclick = onclick;
  return b;
}

function actBtn(label, glyph, onclick, danger) {
  const b = el('button', 'pj-sess-act' + (danger ? ' danger' : ''), glyph);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.onclick = (e) => {
    // 别让点动作顺带触发「切换会话」
    e.stopPropagation();
    onclick();
  };
  return b;
}

/**
 * 把当前项目的会话渲染到项目行下面。
 * 由 app.js 通过 projects.setSessionsSlot() 注入 —— projects.js 不 import 本模块，
 * 两边不互相依赖。
 *
 * @param projectEl 当前项目那一行的元素（`.project.active`）
 */
export async function renderSidebarSessions(projectEl) {
  const parent = projectEl && projectEl.parentNode;
  if (!parent) return;

  const box = el('div', 'pj-sessions');
  parent.insertBefore(box, projectEl.nextSibling);
  box.append(el('div', 'pj-sess-hint', '读取会话…'));

  boxRef = box;
  listRef = null;
  dataRef = null;
  expanded = false;
  archivedOpen = false;
  /* 换了项目就丢掉上一个项目的搜索状态。searchViewMode() 是模块级的，
   * 不清的话会拿着 A 的结果去画 B 的侧栏（迟到的响应虽然会被 generation
   * 校验丢掉，但那只是「刚好没出错」）。 */
  pendingLocate = null;
  resetSearch();
  await fill(box, ++loadToken);
}

/**
 * 会话变了（新开 / 分叉 / 切到别的会话）之后重画那块列表。
 *
 * 没有这一步，列表就停在旧状态：旧会话仍然标着「当前」，而当前项不给点 ——
 * 用户于是再也回不到那条对话，看起来就是「开个新对话，旧对话没了」。
 */
export async function refreshSidebarSessions() {
  const box = boxRef;
  if (!box || !box.isConnected) return;
  await fill(box, ++loadToken);
}

async function fill(box, token) {
  let data;
  try {
    data = await fetchSessions();
  } catch {
    // 读不到就整块不显示 —— 侧栏里挂一条红色报错只会碍事
    if (token === loadToken && box.isConnected) box.remove();
    return;
  }
  // 旧请求回来晚了，或者这块已经被项目列表重渲染带走了
  if (token !== loadToken || !box.isConnected) return;

  if (!data.hasProject || !(data.sessions || []).length) {
    box.remove();
    return;
  }
  paint(box, data);
}

function paint(box, data) {
  dataRef = data;
  box.replaceChildren();

  /* 搜索框**只在这里建一次**。列表区由 paintList() 反复重画，输入框始终不重建
   * —— 否则每敲一个字都会丢焦点、丢光标位置。 */
  box.append(createSearchBar());

  const listArea = el('div', 'pj-sess-list');
  box.append(listArea);
  listRef = listArea;
  paintList();
}

/** 只重画列表区：搜索态画结果，否则画普通会话列表。 */
function paintList() {
  const area = listRef;
  const data = dataRef;
  if (!area || !area.isConnected || !data) return;

  /* 关键词非空时，整块列表区交给搜索视图（结果 / 正在搜索 / 没找到 / 失败 /
   * 「还差几个字」）。空关键词才回落到普通列表 —— 这正是「清空搜索恢复普通
   * 列表」那条要求的落点。 */
  if (searchViewMode() !== 'list') {
    renderSearchResults(area, { onPick: pickResult });
    return;
  }

  area.dataset.view = 'list';
  area.replaceChildren();

  const all = data.sessions || [];
  const live = all.filter((s) => !s.archived);
  const arch = all.filter((s) => s.archived);

  const shown = expanded ? live : live.slice(0, COLLAPSED);
  for (const s of shown) area.append(makeRow(s));

  if (live.length > COLLAPSED) {
    area.append(
      moreBtn(expanded ? '收起' : `展开显示（还有 ${live.length - COLLAPSED} 条）`, () => {
        expanded = !expanded;
        paintList();
      })
    );
  }

  if (arch.length) {
    area.append(
      moreBtn(archivedOpen ? `已归档 ${arch.length} 条 · 收起` : `已归档 ${arch.length} 条`, () => {
        archivedOpen = !archivedOpen;
        paintList();
      }, 'pj-sess-arch-toggle')
    );
    if (archivedOpen) {
      for (const s of arch.slice(0, MAX_ARCHIVED)) area.append(makeRow(s));
      if (arch.length > MAX_ARCHIVED) {
        area.append(el('div', 'pj-sess-hint', `还有 ${arch.length - MAX_ARCHIVED} 条已归档未显示`));
      }
    }
  }
}

function makeRow(s) {
  const row = el('div', 'pj-sess' + (s.current ? ' on' : '') + (s.pending ? ' pending' : ''));
  row.title = s.pending
    ? '新会话：还没有消息，pi 还没把它写到磁盘上'
    : `${s.messageCount} 条消息 · ${fmtTime(s.updatedAt)}${s.createdAt ? ' · 创建于 ' + fmtTime(Date.parse(s.createdAt)) : ''}`;

  const title = el('span', 'pj-sess-title', s.title || '（无标题）');
  row.append(title);
  row.append(el('span', 'pj-sess-time', fmtTime(s.updatedAt)));

  const acts = el('span', 'pj-sess-acts');

  if (s.current) {
    // 改名只对当前会话有效（pi 的 set_session_name 就是只作用当前会话），
    // 所以铅笔只出现在这一条上 —— 不做一个做不到的按钮。
    // 兼容层证实这个能力不可用时，连按钮都不给（见 capMissing 的说明）。
    if (!capMissing('sessionNaming')) acts.append(actBtn('给当前会话起个名字', '✎', () => startRename(row, title, s)));
  } else if (!s.pending) {
    acts.append(
      actBtn(s.archived ? '取消归档' : '归档', s.archived ? '↩' : '⤓', () => doArchive(s, !s.archived))
    );
    acts.append(actBtn('删除这个会话', '✕', () => doDelete(s), true));
  }
  if (acts.childElementCount) row.append(acts);

  /* 切换会话要 pi 的 `switch_session`。它被证实不可用时不给点，并在 title 里
   * 说明原因 —— 留一个点了毫无反应的入口比藏起来更让人困惑。 */
  if (!s.current && !s.pending) {
    if (capMissing('switchSession')) {
      row.classList.add('pj-sess-off');
      row.title = '当前 pi 没有提供「切换会话」能力（详情见侧栏「诊断」）';
    } else {
      row.onclick = () => doSwitch(s);
    }
  }

  return row;
}

function startRename(row, titleEl, s) {
  const input = el('input', 'pj-sess-input');
  input.type = 'text';
  input.value = s.title || '';
  input.maxLength = 120;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== s.title) {
      try {
        const r = await renameSession(v);
        if (!r.ok) toast(r.error || '改名失败', 'error');
        else {
          s.title = v;
          toast('已改名：' + v, 'info');
        }
      } catch (err) {
        toast('改名失败：' + err.message, 'error');
      }
    }
    paintList();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

let busy = false;

/**
 * 切到某个会话。
 * @param s               会话（来自普通列表或搜索结果；只要有 id / title）
 * @param locateUserIndex 可选：切过去之后跳到第 N 次提问（搜索结果带的 userIndex）
 */
async function doSwitch(s, locateUserIndex = null) {
  if (busy) return;
  if (S.streaming) {
    toast('正在生成回答，等这一轮结束再切（或先点停止）', 'warn');
    return;
  }
  busy = true;
  /* **先挂待办再切** —— 顺序反了就可能挂在「历史已重建」回调之后，
   * 那一次定位永远等不到。 */
  pendingLocate = Number.isInteger(locateUserIndex) ? { userIndex: locateUserIndex, at: Date.now() } : null;
  try {
    const r = await switchSession(s.id);
    if (!r.ok) {
      pendingLocate = null; // 没切成功就把待办撤掉，别留给下一次重建
      toast(r.error || '切换失败', 'error');
      return;
    }
    // 换会话之后必须清界面再重建，否则旧消息还挂在上面。
    // 列表的重画由 afterSessionSwitch 的回调负责（见文件头规矩 4）；
    // 「跳到第 N 次提问」由 messages.js 的「历史渲染完成」回调消费（规矩 6）。
    afterSessionSwitch();
    toast('已切到：' + (s.title || '（无标题）'), 'info');
  } catch (err) {
    pendingLocate = null;
    toast('切换失败：' + err.message, 'error');
  } finally {
    busy = false;
  }
}

/**
 * 点了一条搜索结果：切到那个会话，并尽量跳到命中的那次提问。
 *
 * 定位用 `match.userIndex`（后端扫文件时算好的「第几次用户提问」），
 * **不用消息 ID** —— 前端的 nav id（`msg-N`）是渲染时按顺序现发的计数器，
 * 跨重建不稳定；只有「第 N 次提问」这个序号在两边语义一致
 * （见 conversation-nav.js 的 scrollToUserTurn）。
 */
function pickResult(res, match) {
  if (!res) return;
  if (capMissing('switchSession')) {
    toast('当前 pi 没有提供「切换会话」能力（详情见侧栏「诊断」）', 'warn');
    return;
  }
  doSwitch({ id: res.id, title: res.title, archived: res.archived }, match ? match.userIndex : null);
}

async function doArchive(s, archived) {
  try {
    const r = await archiveSession(s.id, archived);
    if (!r.ok) {
      toast(r.error || '操作失败', 'error');
      return;
    }
    toast(archived ? '已归档：' + s.title : '已取消归档：' + s.title, 'info');
    // 归档只影响我们自己的列表，不需要重开会话
    await refreshSidebarSessions();
    /* 归档会影响 scope 过滤（active / archived / all），所以搜索开着的时候
     * 要重搜一次 —— 不然刚归档的那条还挂在「活跃」结果里。 */
    refreshSearch();
  } catch (err) {
    toast('操作失败：' + err.message, 'error');
  }
}

async function doDelete(s) {
  const ok = await confirmModal({
    title: '删除这个会话？',
    message:
      `「${s.title || '（无标题）'}」会从列表里消失。\n\n` +
      '会话文件**不会被抹掉** —— 它会移到 Pi GUI 的回收站目录，事后仍可人工找回。',
    okText: '删除会话',
    danger: true,
  });
  if (ok !== true) return;
  try {
    const r = await deleteSession(s.id);
    if (!r.ok) {
      toast(r.error || '删除失败', 'error');
      return;
    }
    toast('已删除：' + (s.title || '（无标题）'), 'info');
    await refreshSidebarSessions();
    // 删掉的东西不该再出现在搜索结果里
    refreshSearch();
  } catch (err) {
    toast('删除失败：' + err.message, 'error');
  }
}
