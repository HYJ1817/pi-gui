/* 会话面板。
 *
 * ---------- 为什么需要它 ----------
 *
 * Pi GUI 一直有「新对话」，却**没有入口切回旧会话** —— 用户点一下「新对话」，
 * 旧对话就从界面上消失了。它其实完整躺在磁盘上（pi 把每个会话存成独立的
 * `.jsonl` 文件），但界面上再也够不着，看起来就像「对话丢了」。
 *
 * pi 的 RPC 有 `switch_session` 但没有「列出会话」，所以列表由后端扫
 * `<agentDir>/sessions/` 得到（见 server/sessions.js）。
 *
 * ---------- 三条必须守住的规矩 ----------
 *
 * 1. **只传后端给的稳定 ID**，不传路径。后端在自己的索引里解析真实路径，
 *    并核对那条会话确实属于当前项目 —— 于是不可能切到别的项目上去。
 * 2. **切换后必须走 afterSessionSwitch()**：清空对话区与变更账本再重建。
 *    不走这一步的话，切完界面还挂着上一个会话的消息，看着像「切了没生效」。
 * 3. **正在流式输出时不给切** —— 切走会让那一轮的回答悬在半空。
 */
import { fetchSessions, switchSession, renameSession } from './api.js';
import { afterSessionSwitch } from './rpc.js';
import { S, $ } from './state.js';
import { openModal } from './ui/modal.js';
import { toast } from './ui/toast.js';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  const pad = (n) => String(n).padStart(2, '0');
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const base = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameYear ? base : `${d.getFullYear()}-${base}`;
}

/* ---------- 侧栏计数 ---------- */

export async function loadSessionsBadge() {
  const node = $('sessionCount');
  if (!node) return;
  try {
    const r = await fetchSessions();
    const n = (r.sessions || []).length;
    node.textContent = n > 1 ? String(n) : '';
    node.title = n ? `当前项目有 ${n} 个会话` : '';
  } catch {
    node.textContent = '';
  }
}

/* ---------- 面板 ---------- */

export function openSessions() {
  let data = { sessions: [], currentId: null, diagnostics: [] };
  let busy = false;

  openModal((card) => {
    card.classList.add('sess-modal');

    const head = el('div', 'sess-head');
    const titleBox = el('div');
    titleBox.append(el('div', 'sess-title', '会话'));
    const sub = el('div', 'sess-sub');
    titleBox.append(sub);
    const refresh = el('button', 'btn', '刷新');
    refresh.type = 'button';
    refresh.onclick = () => load();
    head.append(titleBox, refresh);

    const hint = el('div', 'sess-hint');

    /* 当前会话改名。pi 的 set_session_name 只作用于**当前**会话，
     * 所以这里没有「给任意会话改名」的入口 —— 不做一个做不到的按钮。 */
    const renameRow = el('div', 'sess-rename');
    const nameInput = el('input', 'sess-name-input');
    nameInput.type = 'text';
    nameInput.placeholder = '给当前会话起个名字（便于以后认出来）';
    nameInput.maxLength = 120;
    const nameBtn = el('button', 'btn', '保存名字');
    nameBtn.type = 'button';
    nameBtn.onclick = async () => {
      const v = nameInput.value.trim();
      if (!v) {
        toast('名字不能为空', 'warn');
        return;
      }
      nameBtn.disabled = true;
      try {
        const r = await renameSession(v);
        if (!r.ok) toast(r.error || '改名失败', 'error');
        else toast('已改名：' + v, 'info');
      } catch (err) {
        toast('改名失败：' + err.message, 'error');
      } finally {
        nameBtn.disabled = false;
      }
    };
    renameRow.append(nameInput, nameBtn);

    const list = el('div', 'sess-list');

    card.append(head, hint, renameRow, list);

    function render() {
      const n = data.sessions.length;
      sub.textContent = n ? `当前项目共 ${n} 个会话` : '';
      hint.replaceChildren();
      hint.append(
        el(
          'span',
          null,
          '点一条即可切过去。旧会话不会丢 —— pi 把每个会话存成独立文件，「新对话」只是开了一条新的，没有覆盖任何东西。'
        )
      );
      for (const d of data.diagnostics || []) hint.append(el('div', 'sess-diag', d.message));

      list.replaceChildren();
      if (!n) {
        list.append(el('div', 'ext-empty', '这个项目还没有会话记录。'));
        return;
      }
      for (const s of data.sessions) {
        const row = el('div', 'sess-item' + (s.current ? ' on' : ''));
        const top = el('div', 'sess-item-top');
        if (s.current) top.append(el('span', 'sess-cur', '当前'));
        top.append(el('span', 'sess-item-title', s.title || '（无标题）'));
        top.append(el('span', 'sess-item-time', fmtTime(s.updatedAt)));
        row.append(top);
        const meta = el('div', 'sess-item-meta');
        meta.append(el('span', null, `${s.messageCount} 条消息`));
        meta.append(el('span', null, '·'));
        meta.append(el('span', 'sess-id', s.sessionId.slice(0, 8)));
        if (s.createdAt) meta.append(el('span', null, '· 创建于 ' + fmtTime(Date.parse(s.createdAt))));
        if (s.truncated) meta.append(el('span', 'sess-warn', '· 文件很大，统计可能不完整'));
        row.append(meta);

        if (!s.current) {
          row.onclick = () => doSwitch(s);
        }
        list.append(row);
      }
    }

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
        loadSessionsBadge();
        closeAndReload();
      } catch (err) {
        toast('切换失败：' + err.message, 'error');
      } finally {
        busy = false;
      }
    }

    function closeAndReload() {
      // 面板关掉即可 —— 对话区由 afterSessionSwitch() 重建
      const m = $('modal');
      if (m) m.hidden = true;
      const c = $('modalCard');
      if (c) c.replaceChildren();
    }

    async function load() {
      list.replaceChildren(el('div', 'ext-empty', '读取中…'));
      try {
        data = await fetchSessions();
      } catch (err) {
        list.replaceChildren(el('div', 'ext-empty', '读取会话列表失败：' + err.message));
        return;
      }
      if (!data.hasProject) {
        list.replaceChildren(el('div', 'ext-empty', '还没有选择项目。'));
        return;
      }
      render();
      loadSessionsBadge();
    }

    load();
  });
}
