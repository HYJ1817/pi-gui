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
 * ---------- 三条必须守住的规矩 ----------
 *
 * 1. **只传后端给的稳定 ID**，不传路径。后端在自己的索引里解析真实路径，
 *    并核对那条会话确实属于当前项目 ⇒ 不可能切到别的项目上去。
 * 2. **切换后必须走 afterSessionSwitch()**：清空对话区与变更账本再重建。
 *    不走这一步的话，切完界面还挂着上一个会话的消息，看着像「切了没生效」。
 * 3. **正在流式输出时不给切** —— 切走会让那一轮的回答悬在半空。
 */
import { fetchSessions, switchSession, renameSession } from './api.js';
import { afterSessionSwitch } from './rpc.js';
import { S } from './state.js';
import { toast } from './ui/toast.js';

/** 一次最多列几条，超出折叠（和 Codex 一样给个「展开显示」）。 */
const COLLAPSED = 6;

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

  let data;
  try {
    data = await fetchSessions();
  } catch {
    // 读不到就整块不显示 —— 侧栏里挂一条红色报错只会碍事
    box.remove();
    return;
  }
  // 这期间项目列表可能已经重渲染过，那这个 box 就是孤儿了
  if (!box.isConnected) return;

  if (!data.hasProject || !(data.sessions || []).length) {
    box.remove();
    return;
  }

  let expanded = false;

  function render() {
    box.replaceChildren();
    const list = data.sessions;
    const shown = expanded ? list : list.slice(0, COLLAPSED);

    for (const s of shown) {
      const row = el('div', 'pj-sess' + (s.current ? ' on' : ''));
      row.title = `${s.messageCount} 条消息 · ${fmtTime(s.updatedAt)}${s.createdAt ? ' · 创建于 ' + fmtTime(Date.parse(s.createdAt)) : ''}`;

      const t = el('span', 'pj-sess-title', s.title || '（无标题）');
      row.append(t);
      row.append(el('span', 'pj-sess-time', fmtTime(s.updatedAt)));

      if (s.current) {
        // 改名只对当前会话有效（pi 的 set_session_name 就是只作用当前会话），
        // 所以铅笔只出现在这一条上 —— 不做一个做不到的按钮。
        const pen = el('button', 'pj-sess-pen');
        pen.type = 'button';
        pen.title = '给当前会话起个名字';
        pen.textContent = '✎';
        pen.onclick = (e) => {
          e.stopPropagation();
          startRename(row, t, s);
        };
        row.append(pen);
      } else {
        row.onclick = () => doSwitch(s);
      }
      box.append(row);
    }

    if (list.length > COLLAPSED) {
      const more = el('div', 'pj-sess-more', expanded ? '收起' : `展开显示（还有 ${list.length - COLLAPSED} 条）`);
      more.onclick = () => {
        expanded = !expanded;
        render();
      };
      box.append(more);
    }
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
      render();
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
      // 换会话之后必须清界面再重建，否则旧消息还挂在上面
      afterSessionSwitch();
      toast('已切到：' + (s.title || '（无标题）'), 'info');
    } catch (err) {
      toast('切换失败：' + err.message, 'error');
    } finally {
      busy = false;
    }
  }

  render();
}
