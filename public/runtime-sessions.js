import { fetchRuntimeSessions, runtimeSessionAction } from './api.js';
import { runtimeStore as store, observeRuntimeFrame, onRuntimeChange } from './runtime-state.js';
import { openModal, confirmModal } from './ui/modal.js';

const same = (a, b) => a && b && Object.keys(a).every(k => a[k] === b[k]);
const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const button = (text, action) => { const e = node('button', 'btn', text); e.type = 'button'; e.onclick = action; return e; };
const labels = { dormant: '已关闭', starting: '启动中', ready: '就绪', error: '错误', disposing: '清理中', idle: '空闲', running: '运行中', stopping: '正在停止' };
let pane, render = null, selected = null;
let focusView = null, openBoundBrowser = null;
/* P32.4：帧到达时统一由 runtime-state.js 广播；本模块只订阅自己的重画。 */
onRuntimeChange(() => render?.());
export function observeRuntimeEvent(frame) { observeRuntimeFrame(frame); }
export function configureRuntimeSessions(options) {
  pane = options.pane;
  focusView = options.focusView || null; openBoundBrowser = options.openBrowser || null;
}

// A narrow phase-3 control surface. It never changes the legacy renderer's S or
// guesses a target from the selected project. Every request captures its owner.
export function openRuntimeSessions(project, workspace = null) {
  let alive = true, request = 0, busy = false, keepBrowser = false, approvalKey = '', renderedId = null, timer;
  openModal((card, close) => {
    card.classList.add('wide', 'runtime-dialog'); card.setAttribute('aria-label', '独立会话');
    const head = node('div', 'wt-head'); head.append(node('h3', '', '独立会话'), button('关闭', close)); card.append(head);
    card.append(node('p', 'modal-desc', '每个会话独占工作区。关闭会话会停止其 Browser 和开发进程；记录保留。'));
    const notice = node('p', 'wt-notice'); notice.setAttribute('role', 'status'); card.append(notice);
    const layout = node('div', 'runtime-layout'), list = node('div', 'runtime-list'), body = node('div', 'runtime-body'); layout.append(list, body); card.append(layout);
    const controls = node('div', 'runtime-controls'), title = node('div', 'wt-name'), state = node('div', 'modal-desc'); body.append(title, state, controls);
    const output = node('pre', 'runtime-output'); output.tabIndex = 0; output.setAttribute('aria-label', '当前独立会话输出'); body.append(output);
    const tools = node('div', 'modal-desc'), approvals = node('div', 'runtime-approvals'); body.append(tools, approvals);
    const input = node('textarea'); input.rows = 3; input.maxLength = 256 * 1024; input.setAttribute('aria-label', '给当前独立会话的任务'); body.append(input);
    input.oninput = () => { const r = store.get(selected); if (r) r.draft = input.value; };
    const send = button('发送', async () => {
      const r = store.get(selected), text = input.value.trim(); if (!r?.owner || !text || busy) return;
      const owner = { ...r.owner }, id = selected;
      await action({ action: 'command', owner, command: { type: 'prompt', message: text } }, result => {
        const current = store.get(id); if (result.ok && same(current?.owner, owner)) { current.draft = ''; if (selected === id) input.value = ''; }
      });
    }); send.classList.add('primary'); controls.append(send);
    const stop = button('停止', () => owned('command', { command: { type: 'abort' } })); controls.append(stop);
    const restart = button('重启', () => owned('restart')); controls.append(restart);
    const end = button('关闭会话', () => owned('close')); controls.append(end);
    const browse = button('Browser', async () => {
      const r = store.get(selected); if (!r?.owner || !pane || !openBoundBrowser || !window.piGuiDesktop?.runtimeBrowser) return;
      const owner = { ...r.owner }, result = await runtimeSessionAction({ action: 'focus', owner });
      if (!alive || !result.ok || !same(store.get(selected)?.owner, owner)) return;
      focusView?.(owner.conversationId);
      keepBrowser = true; close(); await openBoundBrowser();
    }); browse.hidden = !window.piGuiDesktop?.runtimeBrowser; controls.append(browse);
    const processes = button('开发进程', () => showProcesses()); controls.append(processes);
    const processBox = node('div', 'runtime-processes'); body.append(processBox);
    if (workspace) head.insertBefore(button('启动此工作区', () => launch({ action: 'start', args: { id: workspace.id, epoch: workspace.epoch } })), head.lastChild);

    async function refresh() {
      const n = ++request, snapshot = await fetchRuntimeSessions(); if (!alive || n !== request) return;
      if (!snapshot.ok) { notice.textContent = snapshot.error || '无法读取会话'; return; }
      store.seed(snapshot); if (!store.get(selected)) selected = snapshot.items.find(i => i.workspace.projectId === workspace?.projectId)?.conversationId || snapshot.items[0]?.conversationId || null;
      draw();
    }
    async function action(payload, after) {
      if (busy || !alive) return; busy = true; draw();
      try { const result = await runtimeSessionAction(payload); if (!alive) return;
        notice.textContent = result.ok === false ? `${result.error || '操作未完成'}${result.code ? ' (' + result.code + ')' : ''}` : '';
        after?.(result); await refresh(); return result;
      } finally { busy = false; if (alive) draw(); }
    }
    async function launch(payload) {
      const result = await action(payload, r => { if (r.ok) selected = r.conversationId; });
      if (result?.code === 'runtime_limit' && alive) {
        const snapshot = await fetchRuntimeSessions(); if (!alive || snapshot.totalCount !== 2) return;
        if (await confirmModal({ title: '临时启用第三个运行时', message: '每个 Pi 会话会占用独立 child 和模型请求；开发服务另占资源。硬上限为三个，列表本身不启动进程。', okText: '继续启动' })) {
          const next = payload.action === 'start' ? { ...payload, args: { ...payload.args, allowThird: true } } : { ...payload, allowThird: true };
          await action(next, r => { if (r.ok) selected = r.conversationId; });
        }
      }
    }
    async function owned(name, extra = {}) { const r = store.get(selected); if (r?.owner) await action({ action: name, owner: { ...r.owner }, ...extra }); }
    async function choose(id) {
      selected = id; processBox.replaceChildren(); draw(); const r = store.get(id); if (!r?.owner) return;
      const owner = { ...r.owner }; const focused = await runtimeSessionAction({ action: 'focus', owner });
      if (!alive || !same(store.get(id)?.owner, owner)) return;
      if (!focused.ok) { notice.textContent = focused.error; return; }
      focusView?.(id);
      if (r.text && (!r.truncated || r.item.activity !== 'idle')) return;
      const cursor = r.cursor, result = await runtimeSessionAction({ action: 'read', owner, command: { type: 'get_messages' } });
      if (alive && result.ok) { store.history(id, result.data?.messages || [], owner, cursor); draw(); }
    }
    async function showProcesses() {
      const r = store.get(selected); if (!r?.owner) return;
      const owner = { ...r.owner }, id = selected;
      const result = await runtimeSessionAction({ action: 'process', owner, args: { action: 'status' } });
      if (!alive || id !== selected || !same(store.get(id)?.owner, owner)) return;
      processBox.replaceChildren(); if (!result.ok) { notice.textContent = result.error; return; }
      if (!result.available) { processBox.append(node('p', 'modal-desc', '此 Pi 版本的 Process 扩展不可用。')); return; }
      processBox.append(button(result.enabled ? '禁用 Process' : '允许此会话的 Process', async () => {
        await action({ action: 'process', owner, args: { action: 'permission', generation: result.generation, enabled: !result.enabled } }); if (alive && id === selected) await showProcesses();
      }));
      for (const p of result.processes || []) {
        const row = node('div', 'wt-row'); row.append(node('span', '', `${p.name || p.command || '开发进程'} · ${p.state}`));
        for (const [label, command] of [['日志', 'logs'], ['停止', 'stop'], ['重启', 'restart']]) row.append(button(label, async () => {
          const next = await runtimeSessionAction({ action: 'process', owner, args: { action: command, generation: result.generation, id: p.id, revision: p.revision, ...(command === 'logs' ? { cursor: 0 } : {}) } });
          if (!alive || selected !== id || !same(store.get(id)?.owner, owner)) return;
          if (!next.ok) { notice.textContent = next.error || next.code; return; }
          if (command === 'logs') { processBox.querySelector('pre')?.remove(); const log = node('pre', 'runtime-output', (next.lines || []).map(l => l.text || '').join('\n')); processBox.append(log); } else await showProcesses();
        })); processBox.append(row);
      }
    }
    function draw() {
      const focused = document.activeElement, focusId = focused?.dataset.conversationId;
      list.replaceChildren();
      for (const r of store.values()) {
        const b = button(`${r.item.workspace.branch || '工作区'} · ${labels[r.item.lifecycle !== 'ready' ? r.item.lifecycle : r.item.activity] || r.item.lifecycle}${r.item.attention ? ' · 未读' : ''}`, () => choose(r.item.conversationId));
        b.dataset.conversationId = r.item.conversationId; b.setAttribute('aria-pressed', String(selected === r.item.conversationId)); list.append(b);
      }
      if (focusId) list.querySelector(`[data-conversation-id="${focusId}"]`)?.focus();
      const r = store.get(selected); body.hidden = !r;
      if (!r) { notice.textContent ||= '从工作区菜单启动独立会话。'; return; }
      title.textContent = r.item.workspace.branch || '独立会话'; state.textContent = `${labels[r.item.lifecycle]} · ${labels[r.item.activity]}${r.item.error === 'generation_failed' ? ' · 生成失败，请重试或检查模型' : r.item.error ? ' · 运行异常' : ''}${r.truncated ? ' · 显示最近输出' : ''}`;
      output.textContent = r.text || '等待任务'; tools.textContent = r.tools.map(t => `${t.name} · ${t.state}`).join(' / ');
      if (renderedId !== selected || document.activeElement !== input) input.value = r.draft;
      renderedId = selected;
      send.disabled = busy || r.item.lifecycle !== 'ready' || r.item.activity === 'stopping'; stop.disabled = busy || !r.owner || r.item.activity === 'idle';
      restart.disabled = end.disabled = processes.disabled = browse.disabled = busy || !r.owner;
      if (!r.owner && !controls.querySelector('[data-resume]')) { const resume = button('恢复会话', () => launch({ action: 'resume', conversationId: selected })); resume.dataset.resume = 'true'; controls.append(resume); }
      if (r.owner) controls.querySelector('[data-resume]')?.remove();
      const nextApprovalKey = JSON.stringify([selected, r.owner, r.approvals]);
      if (nextApprovalKey === approvalKey) return;
      approvalKey = nextApprovalKey; approvals.replaceChildren();
      for (const a of r.approvals) {
        const approvalOwner = { ...r.owner }, approvalConversation = selected;
        const row = node('div', 'runtime-approval'); row.append(node('p', '', a.title));
        const respond = response => {
          if (!same(store.get(approvalConversation)?.owner, approvalOwner)) return;
          return action({ action: 'command', owner: approvalOwner, command: { type: 'extension_ui_response', id: a.id, ...response } });
        };
        if (a.method === 'confirm') row.append(button('确认', () => respond({ confirmed: true })), button('拒绝', () => respond({ confirmed: false })));
        else if (a.method === 'select') for (const value of a.options) row.append(button(value, () => respond({ value })));
        else { const value = node('textarea'); value.setAttribute('aria-label', a.title || '审批输入'); row.append(value, button('提交', () => respond({ value: value.value }))); }
        row.append(button('取消', () => respond({ cancelled: true }))); approvals.append(row);
      }
    }
    render = draw; void refresh(); timer = setInterval(() => { if (!busy) void refresh(); }, 3000);
  }, () => { alive = false; request++; render = null; clearInterval(timer);
    // 中央视图接管 focus 后，关 modal 只关闭覆盖层；不能把仍可见的会话 blur。
    const owner = store.get(selected)?.owner; if (!focusView && !keepBrowser && owner) void runtimeSessionAction({ action: 'blur', owner });
  });
}
