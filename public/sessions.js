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
 */
import { fetchSessions, switchSession, renameSession, archiveSession, deleteSession } from './api.js';
import { afterSessionSwitch } from './rpc.js';
import { S } from './state.js';
import { toast } from './ui/toast.js';
import { confirmModal } from './ui/modal.js';

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

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  const pad = (n) => String(n).padStart(2, '0');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const base = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameYear ? base : `${d.getFullYear()}-${base}`;
}

/* 当前挂着的那块列表，以及两个折叠开关。
 * 只可能有一块（会话只列在当前项目下面），所以用模块级状态就够。 */
let boxRef = null;
let loadToken = 0;
let expanded = false;
let archivedOpen = false;

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
  expanded = false;
  archivedOpen = false;
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
  box.replaceChildren();

  const all = data.sessions || [];
  const live = all.filter((s) => !s.archived);
  const arch = all.filter((s) => s.archived);

  const shown = expanded ? live : live.slice(0, COLLAPSED);
  for (const s of shown) box.append(makeRow(s, box, data));

  if (live.length > COLLAPSED) {
    box.append(
      moreBtn(expanded ? '收起' : `展开显示（还有 ${live.length - COLLAPSED} 条）`, () => {
        expanded = !expanded;
        paint(box, data);
      })
    );
  }

  if (arch.length) {
    box.append(
      moreBtn(archivedOpen ? `已归档 ${arch.length} 条 · 收起` : `已归档 ${arch.length} 条`, () => {
        archivedOpen = !archivedOpen;
        paint(box, data);
      }, 'pj-sess-arch-toggle')
    );
    if (archivedOpen) {
      for (const s of arch.slice(0, MAX_ARCHIVED)) box.append(makeRow(s, box, data));
      if (arch.length > MAX_ARCHIVED) {
        box.append(el('div', 'pj-sess-hint', `还有 ${arch.length - MAX_ARCHIVED} 条已归档未显示`));
      }
    }
  }
}

function makeRow(s, box, data) {
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
    acts.append(actBtn('给当前会话起个名字', '✎', () => startRename(row, title, s, box, data)));
  } else if (!s.pending) {
    acts.append(
      actBtn(s.archived ? '取消归档' : '归档', s.archived ? '↩' : '⤓', () => doArchive(s, !s.archived))
    );
    acts.append(actBtn('删除这个会话', '✕', () => doDelete(s), true));
  }
  if (acts.childElementCount) row.append(acts);

  if (!s.current && !s.pending) row.onclick = () => doSwitch(s);

  return row;
}

function startRename(row, titleEl, s, box, data) {
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
    paint(box, data);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

let busy = false;

async function doSwitch(s) {
  if (busy) return;
  if (S.streaming) {
    toast('正在生成回答，等这一轮结束再切（或先点停止）', 'warn');
    return;
  }
  busy = true;
  try {
    const r = await switchSession(s.id);
    if (!r.ok) {
      toast(r.error || '切换失败', 'error');
      return;
    }
    // 换会话之后必须清界面再重建，否则旧消息还挂在上面。
    // 列表的重画由 afterSessionSwitch 的回调负责（见文件头规矩 4）。
    afterSessionSwitch();
    toast('已切到：' + (s.title || '（无标题）'), 'info');
  } catch (err) {
    toast('切换失败：' + err.message, 'error');
  } finally {
    busy = false;
  }
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
  } catch (err) {
    toast('删除失败：' + err.message, 'error');
  }
}
