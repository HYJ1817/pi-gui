/* Planner / Agent 编排面板（P5）。
 *
 * ---------- 这个面板的立场 ----------
 *
 * **pi 没有原生 sub-agent / plan mode。** 所以这里是 Pi GUI 自己的编排层，
 * 文案里不许写成「pi 的多 Agent」—— 那是在冒领别人的能力。
 *
 * ---------- 两件必须说清的事 ----------
 *
 * 1. **Planner 与 Executor 是两个按钮。** 「生成计划」只产出计划，
 *    必须用户看过、改过、点「开始执行」才会跑（规格 §8）。不存在
 *    「一生成就自动开跑」这条路。
 *
 * 2. **取消不是失败。** `cancelled` 用灰色、`failed` 才用红色。用户自己按的停止，
 *    标成红色会让他以为出错了，然后去重试一个刚放弃的任务（规格 §25）。
 *
 * 渲染上和扩展面板一样：**不用 innerHTML**，全走 textContent / createElement。
 * Agent 的 stdout 是不可信输入，必须当文本处理。
 */
import {
  fetchAgents,
  fetchPlans,
  fetchPlan,
  createPlan,
  generatePlan,
  updatePlan,
  deletePlan,
  startPlan,
  stopPlan,
  retryPlanTask,
  cancelPlanTask,
  skipPlanTask,
  openPlanTaskSession,
} from './api.js';
import { openModal, closeModal, confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { S } from './state.js';
import { afterSessionSwitch } from './rpc.js';
import { openChangesPanel } from './git.js';

/* ---------- 状态与文案表 ---------- */

const TASK_STATE = {
  pending: { dot: 'dim', label: '等待' },
  blocked: { dot: 'warn', label: '被阻塞' },
  ready: { dot: 'off', label: '就绪' },
  running: { dot: 'on', label: '执行中' },
  success: { dot: 'ok', label: '成功' },
  failed: { dot: 'err', label: '失败' },
  cancelled: { dot: 'dim', label: '已取消' },
  skipped: { dot: 'warn', label: '已跳过' },
  interrupted: { dot: 'warn', label: '被中断' },
};

const PLAN_STATE = {
  draft: { dot: 'off', label: '草稿' },
  ready: { dot: 'off', label: '待执行' },
  running: { dot: 'on', label: '执行中' },
  paused: { dot: 'warn', label: '已暂停' },
  completed: { dot: 'ok', label: '已完成' },
  failed: { dot: 'err', label: '失败' },
  cancelled: { dot: 'dim', label: '已取消' },
};

const dotClass = (meta) => 'ext-dot ' + (meta && meta.dot ? meta.dot : 'dim');

/* ---------- 小工具 ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

/**
 * 从 tasks/attempts 现算 Plan 级汇总（P7 §18/§19）。
 *
 * **不请求新接口、也不缓存**：plan 详情已经带了每条 attempt 的关系字段，
 * 汇总只是去重。这样「汇总」和「明细」永远对得上 —— 如果另开一个接口去算，
 * 两边迟早会出现「上面说 4 个会话、下面只列出 3 个」这种没人能解释的差异。
 *
 * 会话按 id 去重（同一个会话可能被多条 attempt 指向），保留首次出现的那条
 * 上下文（哪个任务、第几次），因为界面上要显示「它属于哪个任务」。
 */
function planRelations(plan) {
  const sessions = new Map();
  const files = new Set();
  for (const t of plan.tasks || []) {
    for (const a of t.attempts || []) {
      if (a.sessionId && !sessions.has(a.sessionId)) {
        sessions.set(a.sessionId, {
          sessionId: a.sessionId,
          title: a.sessionTitle || '',
          available: a.sessionAvailable !== false,
          taskId: t.id,
          taskTitle: t.title,
          attempt: a.attempt,
        });
      }
      for (const p of a.filesChanged || []) files.add(p);
    }
  }
  return { sessions: [...sessions.values()], files: [...files] };
}

/* ---------- SSE 联动 ---------- */

let executionHandler = null;
/** 由 app.js 装配：SSE 收到 execution_event 时转给当前打开的面板。 */
export function setExecutionHandler(fn) {
  executionHandler = fn;
}
export function onExecutionEvent(evt) {
  if (executionHandler) executionHandler(evt);
}

/* ---------- 侧栏计数 ---------- */

export async function loadPlannerBadge() {
  const node = document.getElementById('planCount');
  if (!node) return;
  try {
    const r = await fetchPlans();
    const n = (r.plans || []).length;
    node.textContent = n ? String(n) : '';
    node.title = r.activePlanId ? `有 1 个计划正在执行，共 ${n} 个` : `共 ${n} 个计划`;
  } catch {
    node.textContent = '';
  }
}

/* ---------- 主面板 ---------- */

/**
 * 打开 Planner 面板。
 *
 * @param focus 可选 `{ planId, taskId }` —— 从「会话头部的关联任务」跳进来时用，
 *              会直接把那个计划选中并滚到对应任务（P7 §8 的「查看任务」）。
 */
export function openPlanner(focus = null) {
  let plans = [];
  let agents = [];
  let current = null; // 当前选中的 plan（完整对象）
  let dirty = false; // 未保存的编辑
  let liveEvents = new Map(); // taskId → [{kind, data, timestamp}]
  /* P7 §18/§19：Plan 级汇总的两个展开开关（默认收起，别把详情页撑长）。 */
  let relOpen = false;
  let filesOpen = false;

  openModal((card) => {
    card.classList.add('wide', 'planner');

    const tabs = el('div', 'ext-tabs');
    const tabPlans = el('button', 'ext-tab on', '计划');
    const tabAgents = el('button', 'ext-tab', 'Agent');
    tabs.append(tabPlans, tabAgents);

    const body = el('div', 'ext-body');
    const plansPane = el('div', 'ext-panel planner-pane');
    const agentsPane = el('div', 'ext-panel');
    agentsPane.classList.add('planner-agents');
    agentsPane.style.display = 'none';
    body.append(plansPane, agentsPane);
    card.append(tabs, body);

    const showTab = (which) => {
      const isPlans = which === 'plans';
      tabPlans.classList.toggle('on', isPlans);
      tabAgents.classList.toggle('on', !isPlans);
      plansPane.style.display = isPlans ? '' : 'none';
      agentsPane.style.display = isPlans ? 'none' : '';
    };
    tabPlans.onclick = () => showTab('plans');
    tabAgents.onclick = () => showTab('agents');

    /* ================= 计划列表（左） ================= */

    const listWrap = el('div', 'ext-list planner-list');
    const detailWrap = el('div', 'ext-detail planner-detail');
    const split = el('div', 'ext-split');
    split.append(listWrap, detailWrap);

    const goalInput = el('textarea', 'planner-goal');
    goalInput.rows = 3;
    goalInput.placeholder = '用一句话写清楚要做什么，例如：给这个项目补完整的登录功能，并跑测试';
    const genBtn = btn('生成计划', 'primary', () => doGenerate());
    const emptyBtn = btn('新建空计划', '', () => doCreateEmpty());
    const bar = el('div', 'planner-bar');
    const barLeft = el('div', 'planner-bar-l');
    barLeft.append(goalInput);
    const barRight = el('div', 'planner-bar-r');
    barRight.append(genBtn, emptyBtn);
    bar.append(barLeft, barRight);

    plansPane.append(bar, split);

    /* ================= 生成 / 新建 ================= */

    async function doGenerate() {
      const goal = goalInput.value.trim();
      if (!goal) {
        toast('先写清楚目标', 'warn');
        return;
      }
      genBtn.disabled = true;
      genBtn.textContent = '生成中…';
      try {
        const r = await generatePlan({ goal });
        if (!r.ok) {
          // 生成失败不是崩溃：把原因和**原始输出**都摆出来（规格 §33）
          showDiagnostics(r.error, r.errors || [], r.raw);
          return;
        }
        clearDiagnostics();
        current = r.plan;
        dirty = false;
        liveEvents = new Map();
        await reload();
        toast('计划已生成，确认后再点「开始执行」', 'ok');
      } catch (err) {
        showDiagnostics('生成请求失败：' + err.message, [], '');
      } finally {
        genBtn.disabled = false;
        genBtn.textContent = '生成计划';
      }
    }

    async function doCreateEmpty() {
      try {
        const r = await createPlan({ title: '手工计划', goal: goalInput.value.trim(), tasks: [{ id: 'task-1', title: '第一个任务', agent: 'auto', workingDirectory: '.', dependsOn: [] }] });
        if (!r.ok) {
          toast(r.error || '新建失败', 'error');
          return;
        }
        current = r.plan;
        dirty = false;
        await reload();
      } catch (err) {
        toast('新建失败：' + err.message, 'error');
      }
    }

    /* ---------- 诊断区 ---------- */

    const diag = el('div', 'planner-diag');
    diag.style.display = 'none';
    plansPane.append(diag);

    function showDiagnostics(message, errors, raw) {
      diag.replaceChildren();
      diag.style.display = '';
      diag.append(el('div', 'ext-sec-head', '计划生成失败'));
      diag.append(el('div', 'planner-diag-msg', message || '生成失败'));
      if (errors && errors.length) {
        const ul = el('ul', 'planner-diag-list');
        for (const e of errors) ul.append(el('li', null, String(e)));
        diag.append(ul);
      }
      if (raw) {
        diag.append(el('div', 'ext-sec-head', 'Planner 的原始输出（不可信文本，仅用于排查）'));
        const pre = el('pre', 'ext-code');
        pre.textContent = String(raw);
        diag.append(pre);
      }
      const acts = el('div', 'ext-acts');
      acts.append(btn('重新生成', 'primary', () => { clearDiagnostics(); doGenerate(); }));
      acts.append(btn('关闭诊断', '', () => clearDiagnostics()));
      diag.append(acts);
    }
    function clearDiagnostics() {
      diag.replaceChildren();
      diag.style.display = 'none';
    }

    /* ================= 计划列表渲染 ================= */

    function renderList() {
      listWrap.replaceChildren();
      const head = el('div', 'ext-sec-head');
      head.append(el('span', null, `当前项目的计划（${plans.length}）`));
      listWrap.append(head);
      if (!plans.length) {
        listWrap.append(el('div', 'ext-empty', '还没有计划。上面写个目标点「生成计划」，或者新建一个空计划手工加任务。'));
        return;
      }
      for (const p of plans) {
        const item = el('div', 'ext-item' + (current && current.id === p.id ? ' on' : ''));
        const top = el('div', 'ext-item-top');
        top.append(el('span', dotClass(PLAN_STATE[p.status]), (PLAN_STATE[p.status] || {}).label || p.status));
        top.append(el('span', 'ext-name', p.title));
        item.append(top);
        const c = p.counts || {};
        item.append(el('div', 'ext-item-desc', `${c.total || 0} 个任务 · 成功 ${c.success || 0} · 失败 ${c.failed || 0}${c.cancelled ? ' · 取消 ' + c.cancelled : ''}`));
        if ((p.recoveryNotes || []).length) {
          item.append(el('div', 'ext-item-note', p.recoveryNotes.join('；')));
        }
        item.onclick = async () => {
          if (dirty && current && !(await confirmModal({ title: '放弃未保存的修改？', message: '当前计划的改动还没保存。', okText: '放弃并切换' }))) return;
          const r = await fetchPlan(p.id);
          if (r.ok) {
            current = r.plan;
            dirty = false;
            liveEvents = new Map();
            renderList();
            renderDetail();
          }
        };
        listWrap.append(item);
      }
    }

    /* ================= 详情渲染 ================= */

    function renderDetail() {
      detailWrap.replaceChildren();
      if (!current) {
        detailWrap.append(el('div', 'ext-empty', '左侧选一个计划，或先生成一个。'));
        return;
      }
      const running = current.status === 'running';
      const c = countsOf(current);

      /* 头部：标题 + 状态 + 操作 */
      const head = el('div', 'planner-head');
      const title = el('input', 'planner-title');
      title.value = current.title;
      title.disabled = running;
      title.oninput = () => {
        current.title = title.value;
        dirty = true;
        markDirty();
      };
      head.append(title);
      head.append(el('span', dotClass(PLAN_STATE[current.status]), (PLAN_STATE[current.status] || {}).label || current.status));
      detailWrap.append(head);

      if (current.goal) detailWrap.append(el('div', 'planner-goal-view', current.goal));

      const acts = el('div', 'ext-acts');
      if (running) {
        acts.append(btn('停止计划', 'danger', () => doStop()));
      } else {
        acts.append(btn('开始执行', 'primary', () => doStart()));
      }
      if (!running) {
        acts.append(btn('保存修改', dirty ? 'primary' : '', () => doSave()));
        acts.append(btn('删除计划', 'danger', () => doDelete()));
      }
      acts.append(btn('刷新', '', () => refreshCurrent()));
      detailWrap.append(acts);

      /* 进度（规格 §23：状态清晰即可，不画节点连线图） */
      const prog = el('div', 'planner-progress');
      prog.append(el('span', null, `进度 ${c.success + c.failed + c.cancelled + c.skipped}/${c.total}`));
      if (current.status === 'paused') {
        prog.append(el('span', 'planner-warn', '已暂停：有任务失败，请选择重试 / 跳过 / 停止'));
      }
      detailWrap.append(prog);

      /* ---------- P7 §18/§19：这个目标一共关联了什么 ----------
       *
       * 全部**从 tasks/attempts 现算**，不请求新接口：plan 详情已经带了
       * 每条 attempt 的 sessionId / filesChanged（后端一次性给的，见 planView），
       * 所以这里只是去重汇总 —— 既没有 N+1，也不会出现「汇总和明细对不上」。 */
      const rel = planRelations(current);
      if (rel.sessions.length || rel.files.length) {
        const line = el('div', 'planner-relations');
        if (rel.sessions.length) {
          const b = el('button', 'planner-rel-btn', `关联会话 ${rel.sessions.length}`);
          b.type = 'button';
          b.onclick = () => {
            relOpen = !relOpen;
            renderDetail();
          };
          line.append(b);
        }
        if (rel.files.length) {
          const b = el('button', 'planner-rel-btn', `执行期间涉及 ${rel.files.length} 个文件`);
          b.type = 'button';
          b.onclick = () => {
            filesOpen = !filesOpen;
            renderDetail();
          };
          line.append(b);
        }
        detailWrap.append(line);

        if (relOpen) {
          const box = el('div', 'planner-rel-list');
          for (const s of rel.sessions) {
            const r = el('div', 'planner-rel-row');
            r.append(el('span', 'planner-sess-name', s.title || '（无标题）'));
            r.append(el('span', 'planner-rel-meta', `${s.taskTitle} · 第 ${s.attempt} 次`));
            if (s.available) r.append(btn('打开会话', 'planner-open-sess', () => doOpenSession(current.id, s.taskId, s.attempt)));
            else r.append(el('span', 'planner-sess-gone', '已删除'));
            box.append(r);
          }
          detailWrap.append(box);
        }

        if (filesOpen) {
          const box = el('div', 'planner-rel-list');
          const fl = el('div', 'planner-file-list');
          for (const p of rel.files) fl.append(el('span', 'planner-file', p));
          box.append(fl);
          /* 措辞与 task 级一致：这是「执行期间观察到」的集合，不是归属声明。
           * 完整 diff 仍然走「文件变更」面板 —— 这里**不复制 diff**（规格 §19）。 */
          box.append(el('div', 'ext-item-note', '这些文件在执行期间被观察到有变化（可能也包含其它来源的改动）。diff 请在侧栏「文件变更」里看。'));
          const b = btn('打开文件变更', 'planner-rel-btn', () => {
            closeModal();
            openChangesPanel();
          });
          box.append(b);
          detailWrap.append(box);
        }
      }

      /* 任务列表 */
      const tl = el('div', 'planner-tasks');
      for (const t of current.tasks) tl.append(renderTask(t, running));
      detailWrap.append(tl);

      if (!running) {
        const add = btn('+ 添加任务', '', () => {
          const n = current.tasks.length + 1;
          let id = 'task-' + n;
          let i = n;
          while (current.tasks.some((x) => x.id === id)) id = 'task-' + ++i;
          current.tasks.push({ id, title: id, description: '', agent: 'auto', workingDirectory: '.', dependsOn: [], status: 'pending', attempt: 0, attempts: [], result: null, error: '' });
          dirty = true;
          renderDetail();
        });
        detailWrap.append(add);
      }
    }

    function markDirty() {
      const b = detailWrap.querySelector('.ext-acts button:nth-child(2)');
      if (b && !b.classList.contains('primary')) b.classList.add('primary');
    }

    /**
     * 一条 attempt：状态 + 关联会话 + 执行期间变更（P7 §6 / §10）。
     *
     * 三种「没有会话」的情形分开说，因为用户该做的事完全不同：
     *   - 这次执行没关联到会话（Agent 不支持）→ 「无可关联会话」
     *   - 关联过，但会话文件已经找不到了 → 「关联会话已删除」
     *   - 有会话且能找到 → 显示标题 + 「打开会话」
     * 全都不是错误，所以都不用红色 —— 这只是信息缺失，不是失败。
     */
    function renderAttempt(planId, task, a) {
      const row = el('div', 'planner-attempt');
      const head = el('div', 'planner-attempt-head');
      const meta = a.success ? TASK_STATE.success : /取消/.test(String(a.error || '')) ? TASK_STATE.cancelled : TASK_STATE.failed;
      head.append(el('span', dotClass(meta), ''));
      head.append(el('span', 'planner-attempt-no', `第 ${a.attempt} 次`));
      if (Number.isFinite(a.startedAt) && Number.isFinite(a.endedAt)) {
        head.append(el('span', 'planner-attempt-dur', fmtDuration(a.endedAt - a.startedAt)));
      }
      if (a.error) head.append(el('span', 'planner-attempt-err', String(a.error).slice(0, 160)));
      row.append(head);

      const srow = el('div', 'planner-attempt-sess');
      srow.append(el('span', 'planner-lbl', '会话'));
      if (!a.sessionId) {
        srow.append(el('span', 'planner-sess-none', '无可关联会话'));
      } else if (a.sessionAvailable === false) {
        srow.append(el('span', 'planner-sess-gone', '关联会话已删除'));
      } else {
        srow.append(el('span', 'planner-sess-name', a.sessionTitle || '（无标题）'));
        srow.append(btn('打开会话', 'planner-open-sess', () => doOpenSession(planId, task.id, a.attempt)));
      }
      row.append(srow);

      const files = Array.isArray(a.filesChanged) ? a.filesChanged : [];
      if (files.length) {
        const frow = el('div', 'planner-attempt-files');
        /* 措辞刻意是「执行期间变更」，**不是**「该 Agent 修改」（规格 §11）：
         * 用户自己、编辑器、另一个并行任务都可能在同一时间段动过这些文件。
         * 这个字符串同时也是 planner.cjs / workflow-relations.cjs 的断言对象。 */
        frow.append(el('span', 'planner-lbl', '执行期间变更'));
        const list = el('div', 'planner-file-list');
        for (const p of files.slice(0, 20)) list.append(el('span', 'planner-file', p));
        frow.append(list);
        if (files.length > 20) frow.append(el('span', 'planner-file-more', `等 ${files.length} 个文件`));
        row.append(frow);
      } else if (a.changeCaptureIncomplete) {
        row.append(el('div', 'planner-attempt-note', '执行期间变更：采集不到（这个项目不是 git 仓库，或这次执行被中断）'));
      } else {
        row.append(el('div', 'planner-attempt-note', '执行期间未观察到文件变化'));
      }
      return row;
    }

    /**
     * 从任务跳到它的会话（P7 §7）。
     *
     * **切换动作全在后端**：前端只发 planId / taskId / attempt，后端解析真实路径、
     * 核对归属、拒绝正在执行的任务，然后复用现有的 `switch_session`。
     * 前端这一侧只负责**切完之后把界面收尾** —— 走的是和侧栏切换完全同一个
     * `afterSessionSwitch()`（清对话区、清变更账本、重画会话列表、boot 重建历史）。
     * 不这么做就会出现「会话切了但界面还挂着上一个会话的消息」。
     */
    async function doOpenSession(planId, taskId, attempt) {
      if (S.streaming) {
        toast('正在生成回答，等这一轮结束再切会话（或先点停止）', 'warn');
        return;
      }
      try {
        const r = await openPlanTaskSession(planId, taskId, attempt);
        if (!r.ok) {
          // 「没有可关联的会话」「会话已删除」都是正常结果，用 warn 不用 error
          toast(r.error || '打开会话失败', 'warn');
          return;
        }
        closeModal();
        afterSessionSwitch();
        toast('已切到任务会话：' + (r.title || '（无标题）'), 'info');
      } catch (err) {
        toast('打开会话失败：' + err.message, 'error');
      }
    }

    function renderTask(t, planRunning) {
      const wrap = el('div', 'planner-task');
      // P7：从会话头部的「查看任务」跳进来时要能定位到这一条
      wrap.dataset.taskId = t.id;
      if (focus && focus.taskId === t.id) wrap.classList.add('focus');
      const meta = TASK_STATE[t.status] || { dot: 'dim', label: t.status };
      const top = el('div', 'planner-task-top');
      top.append(el('span', dotClass(meta), meta.label));
      top.append(el('span', 'planner-task-id', t.id));
      top.append(el('span', 'planner-task-agent', t.agent));
      if (t.dependsOn && t.dependsOn.length) top.append(el('span', 'planner-task-dep', '依赖 ' + t.dependsOn.join(', ')));
      if (t.attempt > 1) top.append(el('span', 'planner-task-attempt', `第 ${t.attempt} 次`));
      if (t.result && Number.isFinite(t.result.durationMs)) top.append(el('span', 'planner-task-dur', fmtDuration(t.result.durationMs)));
      wrap.append(top);

      /* 标题 / 描述 / agent / 依赖 的编辑（运行中锁定结构，规格 §46） */
      const title = el('input', 'planner-task-title');
      title.value = t.title;
      title.disabled = planRunning;
      title.oninput = () => { t.title = title.value; dirty = true; };
      wrap.append(title);

      const desc = el('textarea', 'planner-task-desc');
      desc.rows = 2;
      desc.value = t.description || '';
      desc.disabled = planRunning;
      desc.placeholder = '这个任务具体要做什么';
      desc.oninput = () => { t.description = desc.value; dirty = true; };
      wrap.append(desc);

      const row = el('div', 'planner-task-row');
      const agentSel = el('select', 'ext-sel');
      const opts = [{ id: 'auto', name: 'auto（自动挑一个可用的）' }].concat(
        agents.map((a) => ({ id: a.id, name: a.name + (a.available ? '' : '（不可用）') }))
      );
      for (const o of opts) {
        const op = el('option', null, o.name);
        op.value = o.id;
        agentSel.append(op);
      }
      agentSel.value = t.agent || 'auto';
      agentSel.disabled = planRunning;
      agentSel.onchange = () => { t.agent = agentSel.value; dirty = true; renderDetail(); };
      row.append(el('span', 'planner-lbl', 'Agent'), agentSel);

      // 依赖选择器（普通列表 + 勾选，不做拖拽 DAG 编辑器 —— 规格 §8）
      const depBox = el('div', 'planner-deps');
      depBox.append(el('span', 'planner-lbl', '依赖'));
      for (const other of current.tasks) {
        if (other.id === t.id) continue;
        const lab = el('label', 'planner-dep');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = (t.dependsOn || []).includes(other.id);
        cb.disabled = planRunning;
        cb.onchange = () => {
          const set = new Set(t.dependsOn || []);
          if (cb.checked) set.add(other.id);
          else set.delete(other.id);
          t.dependsOn = [...set];
          dirty = true;
        };
        lab.append(cb, el('span', null, other.id));
        depBox.append(lab);
      }
      row.append(depBox);
      wrap.append(row);

      /* 结果 / 错误 / 变更 */
      if (t.error) wrap.append(el('div', 'planner-task-err', t.error));
      if (t.result && t.result.summary) {
        const s = el('div', 'planner-task-summary');
        s.textContent = t.result.summary;
        wrap.append(s);
      }
      if (t.result && t.result.changes && t.result.changes.files && t.result.changes.files.length) {
        const ch = el('div', 'planner-changes');
        // 措辞刻意是「执行期间观察到的工作区变化」—— 不声称是 Agent 改的（规格 §18）
        ch.append(el('div', 'ext-sec-head', '执行期间观察到的工作区变化'));
        for (const f of t.result.changes.files.slice(0, 20)) {
          const line = el('div', 'planner-change');
          line.append(el('span', 'planner-change-path', f.path));
          line.append(el('span', 'planner-change-kind', f.change));
          if (Number.isFinite(f.additions) || Number.isFinite(f.deletions)) {
            line.append(el('span', 'planner-change-num', `+${f.additions ?? '?'} −${f.deletions ?? '?'}`));
          }
          ch.append(line);
        }
        if (t.result.changes.note) ch.append(el('div', 'ext-item-note', t.result.changes.note));
        wrap.append(ch);
      }

      /* ---------- P7：尝试历史 + 会话关联 + 执行期间变更 ----------
       *
       * 从「只在多次尝试时才显示」改成「有尝试就显示」：单次尝试同样需要
       * 看到「用了哪个会话、执行期间动了哪些文件」—— 那正是 P7 要串起来的关系。
       *
       * ⚠️ 关系必须挂在**每条 attempt** 上，不能只在 task 顶层放一份：
       * 重试之后顶层那份会被覆盖，两次尝试的会话与文件就分不开了（规格 §6/§29）。 */
      if (Array.isArray(t.attempts) && t.attempts.length) {
        const hist = el('div', 'planner-attempts');
        hist.append(el('div', 'ext-sec-head', t.attempts.length > 1 ? '尝试历史' : '本次执行'));
        for (const a of t.attempts) hist.append(renderAttempt(current.id, t, a));
        wrap.append(hist);
      }

      /* 实时事件（同一次运行的 agent 输出 / 工具调用） */
      const evs = liveEvents.get(t.id);
      if (evs && evs.length) {
        const log = el('div', 'planner-livelog');
        log.append(el('div', 'ext-sec-head', `本次运行的输出（${t.agent}）`));
        for (const e of evs.slice(-40)) {
          const line = el('div', 'planner-live-line');
          if (e.kind === 'agent_tool') {
            const phase = e.data && e.data.phase;
            line.append(el('span', dotClass(phase === 'end' ? (e.data.isError ? TASK_STATE.failed : TASK_STATE.success) : TASK_STATE.running), ''));
            line.append(el('span', 'planner-live-tool', (e.data && e.data.toolName) || 'tool'));
            if (e.data && e.data.detail) line.append(el('span', 'planner-live-detail', String(e.data.detail).slice(0, 120)));
          } else {
            line.append(el('span', dotClass({ dot: 'dim' }), ''));
            line.append(el('span', 'planner-live-text', String((e.data && e.data.text) || '').slice(0, 400)));
          }
          log.append(line);
        }
        wrap.append(log);
      }

      /* 单任务操作 */
      const tacts = el('div', 'ext-acts');
      const settled = ['success', 'failed', 'cancelled', 'skipped', 'interrupted'].includes(t.status);
      if (t.status === 'failed' || t.status === 'interrupted') {
        tacts.append(btn('重试', 'primary', () => doTaskAction('retry', t.id)));
        tacts.append(btn('跳过', '', () => doTaskAction('skip', t.id)));
      }
      if (t.status === 'blocked' || t.status === 'pending' || t.status === 'ready') {
        tacts.append(btn('跳过', '', () => doTaskAction('skip', t.id)));
      }
      if (!settled && t.status !== 'blocked' && t.status !== 'pending') {
        tacts.append(btn('取消这个任务', 'danger', () => doTaskAction('cancel', t.id)));
      }
      if (tacts.childElementCount) wrap.append(tacts);
      return wrap;
    }

    function countsOf(plan) {
      const c = { total: plan.tasks.length, success: 0, failed: 0, cancelled: 0, skipped: 0 };
      for (const t of plan.tasks) {
        if (t.status === 'success') c.success++;
        else if (t.status === 'failed' || t.status === 'interrupted') c.failed++;
        else if (t.status === 'cancelled') c.cancelled++;
        else if (t.status === 'skipped') c.skipped++;
      }
      return c;
    }

    /* ================= 动作 ================= */

    async function doStart() {
      if (dirty) {
        const okSave = await confirmModal({ title: '先保存修改？', message: '计划有未保存的改动，先保存再执行。', okText: '保存并执行' });
        if (!okSave) return;
        const s = await doSave();
        if (!s) return;
      }
      try {
        const r = await startPlan(current.id);
        if (!r.ok) {
          if (r.problems && r.problems.length) {
            const lines = r.problems.map((p) => `· ${p.taskId}：${p.detail || p.reason}`).join('\n');
            toast('有任务指定的 Agent 不可用，请先换掉：\n' + lines, 'error');
          } else {
            toast(r.error || '启动失败', 'error');
          }
          return;
        }
        liveEvents = new Map();
        await refreshCurrent();
        toast('已开始执行（默认串行）', 'ok');
      } catch (err) {
        toast('启动失败：' + err.message, 'error');
      }
    }

    async function doStop() {
      const ok = await confirmModal({
        title: '停止计划？',
        message: '正在执行的 Agent 会被取消，还没开始的任务会标成「已取消」。已完成的不会受影响。',
        okText: '停止',
        danger: true,
      });
      if (!ok) return;
      try {
        const r = await stopPlan(current.id);
        if (!r.ok) toast(r.error || '停止失败', 'warn');
        await refreshCurrent();
      } catch (err) {
        toast('停止失败：' + err.message, 'error');
      }
    }

    async function doSave() {
      try {
        const r = await updatePlan(current.id, { title: current.title, goal: current.goal, tasks: current.tasks });
        if (!r.ok) {
          const msg = (r.errors && r.errors.length ? r.errors.join('\n') : r.error) || '保存失败';
          toast(msg, 'error');
          return false;
        }
        current = r.plan;
        dirty = false;
        await reload();
        return true;
      } catch (err) {
        toast('保存失败：' + err.message, 'error');
        return false;
      }
    }

    async function doDelete() {
      const ok = await confirmModal({ title: '删除这个计划？', message: '只删执行记录，不动项目里的任何文件。', okText: '删除', danger: true });
      if (!ok) return;
      try {
        await deletePlan(current.id);
        current = null;
        await reload();
      } catch (err) {
        toast('删除失败：' + err.message, 'error');
      }
    }

    async function doTaskAction(action, taskId) {
      try {
        const fn = action === 'retry' ? retryPlanTask : action === 'cancel' ? cancelPlanTask : skipPlanTask;
        const r = await fn(current.id, taskId);
        if (!r.ok) {
          toast(r.error || '操作失败', 'warn');
          return;
        }
        if (action === 'skip' && r.blockedDependents && r.blockedDependents.length) {
          toast(`已跳过。依赖它的 ${r.blockedDependents.join(', ')} 仍然是「被阻塞」——要跑就得先改依赖。`, 'warn');
        }
        await refreshCurrent();
      } catch (err) {
        toast('操作失败：' + err.message, 'error');
      }
    }

    /* ================= 加载 / 刷新 ================= */

    async function reload() {
      try {
        const r = await fetchPlans();
        plans = r.plans || [];
        renderList();
        if (current && !plans.some((p) => p.id === current.id)) current = null;
        renderDetail();
        loadPlannerBadge();
      } catch (err) {
        listWrap.replaceChildren(el('div', 'ext-empty', '读取计划失败：' + err.message));
      }
    }

    async function refreshCurrent() {
      if (!current) return;
      try {
        const r = await fetchPlan(current.id);
        if (r.ok) {
          current = r.plan;
          renderDetail();
          renderList();
        }
      } catch {
        /* 下一轮再试 */
      }
    }

    /* Agent 页。
     *
     * 早先这里复用了 Skills 列表的 .ext-item 样式，而 .ext-item.static 是
     * **flex 行**布局 —— 于是「标题行 + 描述 + 能力 + 不可用原因」全部并排挤在
     * 一行里，Claude 那条的原因还被推到右侧窄列折行折断。整宽的页面需要的是
     * **纵向卡片**：标题行（状态/名称/版本）→ 描述 → 能力胶囊 → 原因块。
     *
     * 能力不再拼成「·」分隔的一长串，改成胶囊：一眼能看出谁支持什么，
     * 缺哪项用虚线弱化。不可用的卡片整体降调，但**它的原因块最显眼** ——
     * 那一行里最该被读到的就是「为什么不可用、该怎么办」。 */
    const AGENT_REASON = {
      'not-installed': '未安装',
      'entry-missing': '安装不完整',
      'no-bin': '包缺少 bin 定义',
      'unsupported-entry': '入口类型不支持',
      'detect-failed': '探测失败',
      'not-adapted': '尚未适配调用方式',
    };
    const AGENT_CAPS = [
      ['streaming', '流式输出', '无流式'],
      ['cancellation', '可取消', '不可取消'],
      ['resume', '可续会话', '不续会话'],
      ['toolEvents', '工具级事件', '仅文本摘要'],
      /* P7：能不能把「这次执行」关联到一条会话。不支持就是「不关联会话」——
       * 界面据此显示「无可关联会话」，而不是假装有。 */
      ['sessionLinking', '可关联会话', '不关联会话'],
    ];

    /** 后端给的 note 有时会以原因标签开头（「安装不完整：…」），
     *  而上面那块已经写了同样的标签 —— 渲染时把重复的前缀去掉。 */
    function stripReasonPrefix(text, label) {
      if (!label) return text;
      for (const sep of ['：', ':']) {
        if (text.startsWith(label + sep)) return text.slice(label.length + sep.length).trim();
      }
      return text;
    }

    function renderAgentCard(a) {
      const card = el('div', 'agent-card' + (a.available ? '' : ' off'));

      /* 标题行：状态点 + 可用/不可用 + 名称 + id + 版本，**全部靠左成组**。
       * 早先把版本用 margin-left:auto 推到最右，卡片宽 1100px 时它离名字
       * 900px 远，看着像布局坏了；而且「可用/不可用」已经用颜色点出来了，
       * 右边那一列并不承担扫描作用。 */
      const head = el('div', 'agent-head');
      head.append(el('span', dotClass(a.available ? { dot: 'ok' } : { dot: 'err' }), ''));
      head.append(el('span', 'agent-status ' + (a.available ? 'ok' : 'err'), a.available ? '可用' : '不可用'));
      head.append(el('span', 'agent-name', a.name));
      head.append(el('span', 'agent-id', a.id));
      if (a.version) head.append(el('span', 'agent-ver', 'v' + a.version));
      card.append(head);

      if (a.description) card.append(el('div', 'agent-desc', a.description));

      const caps = a.capabilities || {};
      const capBox = el('div', 'agent-caps');
      for (const [key, yes, no] of AGENT_CAPS) {
        const on = Boolean(caps[key]);
        capBox.append(el('span', 'agent-cap' + (on ? '' : ' no'), on ? yes : no));
      }
      card.append(capBox);

      if (!a.available) {
        /* 原因与建议**合成一块**：分开渲染会出现两块彩色框、而且「安装不完整」
         * 这句会重复两遍。事实在前、建议用 → 起一行，一块就够。 */
        const label = AGENT_REASON[a.reason] || a.reason || '不可用';
        const box = el('div', 'agent-reason err');
        box.append(el('div', 'agent-reason-k', label));
        if (a.detail) box.append(el('div', 'agent-reason-v', a.detail));
        for (const n of a.notes || []) {
          box.append(el('div', 'agent-reason-v agent-advice', '→ ' + stripReasonPrefix(n, label)));
        }
        card.append(box);
      } else {
        /* 可用的 agent 只是「注意」（例如「这个 CLI 没有 JSON 事件流」），
         * 用警示色边框太响 —— 降成一行淡色说明。 */
        for (const n of a.notes || []) card.append(el('div', 'agent-note', n));
      }
      return card;
    }

    async function loadAgents() {
      try {
        const r = await fetchAgents();
        agents = r.agents || [];
        const okCount = agents.filter((a) => a.available).length;
        agentsPane.replaceChildren();

        const sum = el('div', 'agent-summary');
        sum.append(el('span', null, `本机检测到 ${agents.length} 个 Agent，其中 ${okCount} 个可用`));
        if (r.auto) sum.append(el('span', 'agent-auto', `auto → ${r.auto}`));
        agentsPane.append(sum);

        agentsPane.append(
          el(
            'div',
            'agent-hint',
            '所有 Agent 都经适配器调用（shell:false + 参数数组），Planner 不拼命令字符串。不可用的会在点「开始执行」之前被拦下来，并说明是哪个任务。'
          )
        );

        for (const a of agents) agentsPane.append(renderAgentCard(a));

        agentsPane.append(
          el('div', 'agent-boundary', '注：pi 没有原生 sub-agent / plan mode —— 这一层是 Pi GUI 自己的编排，不是 pi 的能力。')
        );
      } catch (err) {
        agentsPane.replaceChildren(el('div', 'ext-empty', '读取 Agent 失败：' + err.message));
      }
    }

    /* ================= SSE 联动 ================= */

    setExecutionHandler((evt) => {
      if (!current || evt.planId !== current.id) return;
      if (evt.taskId) {
        if (!liveEvents.has(evt.taskId)) liveEvents.set(evt.taskId, []);
        const arr = liveEvents.get(evt.taskId);
        if (evt.kind === 'agent_output' || evt.kind === 'agent_tool') arr.push({ kind: evt.kind, data: evt.data, timestamp: evt.timestamp });
      }
      /* 状态类事件直接就地改内存里的 plan 并重画，不为了每条事件都打一次接口 */
      const t = evt.taskId ? current.tasks.find((x) => x.id === evt.taskId) : null;
      if (t) {
        if (evt.kind === 'task_start') t.status = 'running';
        else if (evt.kind === 'task_success') t.status = 'success';
        else if (evt.kind === 'task_error') t.status = 'failed';
        else if (evt.kind === 'task_cancelled') t.status = 'cancelled';
        else if (evt.kind === 'task_skipped') t.status = 'skipped';
      }
      if (evt.kind === 'plan_start') current.status = 'running';
      else if (evt.kind === 'plan_paused') current.status = 'paused';
      else if (evt.kind === 'plan_cancelled') current.status = 'cancelled';
      else if (evt.kind === 'plan_success') current.status = 'completed';
      else if (evt.kind === 'plan_failed') current.status = 'failed';

      renderDetail();
      if (evt.kind.startsWith('plan_')) {
        // 计划级收尾时补一次权威数据
        setTimeout(() => {
          reload();
        }, 300);
      }
    });

    /* ================= 初始化 ================= */

    loadAgents();
    reload().then(async () => {
      if (!focus || !focus.planId) return;
      const r = await fetchPlan(focus.planId);
      if (!r.ok) return;
      current = r.plan;
      dirty = false;
      liveEvents = new Map();
      renderList();
      renderDetail();
      /* 从会话跳进来时把对应任务滚进视野 —— 否则用户要在一个长计划里自己找
       * 「我刚才点的是哪个任务」。用 dataset 比对而不是拼属性选择器：
       * task id 来自模型输出，拼进选择器会踩到转义问题。 */
      if (focus.taskId) {
        const node = [...detailWrap.querySelectorAll('.planner-task')].find((n) => n.dataset.taskId === focus.taskId);
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
      }
    });
  }, () => {
    // 关闭面板时摘掉 SSE 回调，避免它继续往已经销毁的 DOM 上写
    setExecutionHandler(null);
    loadPlannerBadge();
  });
}
