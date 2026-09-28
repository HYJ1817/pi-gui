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
  updateAttemptReview,
  verifyPlanAttempt,
  stopPlanAttemptVerification,
} from './api.js';
import { openModal, closeModal, confirmModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { S, ownsWorkspace } from './state.js';
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
/**
 * 面板里的标准按钮。
 *
 * ⚠️ **`btn` 基类必须带上。** styles.css 里只有 `.btn` / `.btn.primary` /
 * `.btn.danger` 这一组规则 —— 裸的 `primary` / `danger` **一个选择器都不匹配**，
 * 会落回浏览器默认的浅色按钮（深色主题下是刺眼的白块）。
 * P7 之前这里传的就是裸类名，那 11 个按钮一直是 UA 默认样式；现在统一在
 * 这里加前缀，新写的调用就不可能再犯。
 *
 * 已经自带完整样式的类（`planner-open-sess` / `planner-rel-btn`）作为修饰符
 * 叠在 `.btn` 上即可：它们在 styles.css 里更靠后，尺寸与配色照样是它们自己的。
 */
function btn(label, cls, onClick) {
  const b = el('button', cls ? 'btn ' + cls : 'btn', label);
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

/** 时间戳 → 本地时间。**真相来自后端**（review.reviewedAt），不拿浏览器本地时间充数 ——
 *  用户可能改了系统时间，或两个窗口在不同时区看到同一条记录。 */
function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- P8-C：人工审阅 ----------
 *
 * 一条贯穿全段的语义（与后端 model.js 完全一致）：
 *
 *     执行状态  ≠  人工审阅状态
 *
 * 执行状态（success / failed / cancelled / interrupted）是**机器跑出来什么**；
 * 审阅状态（pending / accepted / needs_changes）是**人认不认这个结果**。
 * 保存审阅永远不改执行状态：不重试、不暂停、不动 DAG、不碰 Git。
 *
 * 这里**不做「验证通过」这类判断**：Agent 说 success、exitCode 0、
 * summary 里写着 tests passed，都**不算**独立验证证据。界面上默认只写
 * 「尚未独立确认」。
 */

const REVIEW_STATE = {
  pending: { cls: 'pending', mark: '○', label: '待审阅' },
  accepted: { cls: 'ok', mark: '✓', label: '已接受' },
  needs_changes: { cls: 'warn', mark: '↻', label: '需修改' },
};
/** 与后端 MAX_REVIEW_NOTE 对齐。前端 maxlength 只是顺手，**后端才是最终权威**。 */
const REVIEW_NOTE_MAX = 1000;
/** 一个 attempt 的变更文件默认列几个。20 个文件一次铺开会把卡片糊成一面墙；
 *  超出的收进「展开其余 N 个」，**不隐藏**（历史关系仍然保留）。 */
const FILES_PREVIEW = 5;

/**
 * 一次尝试的**稳定执行结论**。
 *
 * 优先 `outcomeStatus`（P8-A 起写入，唯一权威）。老记录（P7 及更早）没有它，
 * 依次退到 `success` 布尔与 `error` 文案里的「取消」线索 —— 那只是为了把历史
 * 渲染得跟以前一样，**任何业务判定都不依赖它**（审阅资格只认 `success`）。
 */
function attemptOutcome(a) {
  const known = ['success', 'failed', 'cancelled', 'interrupted'];
  if (a && known.includes(a.outcomeStatus)) return a.outcomeStatus;
  if (a && a.success === true) return 'success';
  if (/取消/.test(String((a && a.error) || ''))) return 'cancelled';
  return 'failed';
}

/**
 * 归一化一条审阅记录 —— 与后端 `normalizeReview` 同一套语义。
 *
 * 后端已经保证形状，这里再挡一道是为了「夹具 / 升级上来的老数据」：
 * P8-A 之前的 attempt 根本没有 `review` 字段。
 *
 * `pending` 就是「清除」，所以 note / reviewedAt 一律清空 ——
 * 否则会出现「待审阅却带着上次的说明」这种自相矛盾的展示。
 */
function reviewOf(a) {
  const r = a && a.review && typeof a.review === 'object' ? a.review : null;
  const status = r && Object.prototype.hasOwnProperty.call(REVIEW_STATE, r.status) ? r.status : 'pending';
  const revision = Number.isInteger(r && r.revision) && r.revision >= 0 ? r.revision : 0;
  if (status === 'pending') return { status, note: '', reviewedAt: null, revision };
  return {
    status,
    note: typeof r.note === 'string' ? r.note.slice(0, REVIEW_NOTE_MAX) : '',
    reviewedAt: Number.isFinite(r && r.reviewedAt) ? r.reviewedAt : null,
    revision,
  };
}

/** 只有**执行成功**的尝试才允许标「已接受」—— 与后端 `canAcceptAttempt` 同一条规则。
 *  前端只是不让用户点了白点一次；**即使被绕过，后端也会拒绝**。 */
const canAccept = (a) => attemptOutcome(a) === 'success';

/** 验证要求 / 当前任务验证要求 → 一行可读文本。只认 command 与 description 两个键
 *  （与后端 `normalizeVerificationSnapshot` 同一个形状）。 */
function verificationText(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    return s || '';
  }
  if (!v || typeof v !== 'object') return '';
  const c = typeof v.command === 'string' ? v.command.trim() : '';
  if (c) return c;
  const d = typeof v.description === 'string' ? v.description.trim() : '';
  return d || '';
}

/**
 * Plan 顶部的审阅汇总。
 *
 * ⚠️ **只看每个 Task 的「最新一次 attempt」。** 历史 accepted 仍然留在它自己那张
 * Attempt 卡片里，但**不进这个汇总** —— 否则「Attempt 1 成功被接受、Attempt 2 失败」
 * 的任务会同时算作 accepted 和 failed，那个数字就没人能解释了。
 *
 * 「最新」按 `attempt` 号取最大，不按数组顺序 —— 顺序是写入顺序，不是语义。
 *
 * ⚠️ **`failed` / `cancelled` / `interrupted` 必须分开统计。**
 * P8-B 已经把三者区分得很清楚（Scheduler 与 attempt 卡片都分开）：
 *   interrupted = 应用被关掉，不是你的错，重启后可以重试；
 *   cancelled   = 你自己按了停止；
 *   failed      = 真的跑失败了。
 * 汇总这里如果把 interrupted 并进 failed，就等于在计划顶部说「失败 2」——
 * 而那两条里有一条根本不是失败。汇总和明细必须说同一件事。
 */
function reviewSummary(plan) {
  const exec = { success: 0, failed: 0, cancelled: 0, interrupted: 0, none: 0 };
  const rev = { pending: 0, accepted: 0, needs_changes: 0 };
  for (const t of plan.tasks || []) {
    const arr = Array.isArray(t.attempts) ? t.attempts : [];
    if (!arr.length) {
      exec.none++;
      continue;
    }
    const last = arr.reduce((m, a) => (!m || (a.attempt || 0) > (m.attempt || 0) ? a : m), null);
    const outcome = attemptOutcome(last);
    if (outcome === 'success') {
      exec.success++;
      /* 只有「最新一次成功了」的尝试才进人工审阅的分母。
       * 失败 / 取消 / 被中断的最新结果不产生「待审阅」—— 那不是一个待验收的产物。 */
      rev[reviewOf(last).status]++;
    } else if (outcome === 'cancelled') {
      exec.cancelled++;
    } else if (outcome === 'interrupted') {
      exec.interrupted++;
    } else {
      exec.failed++;
    }
  }
  return { exec, rev };
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

  /* ---------- P8-C：审阅编辑的临时状态 ----------
   *
   * key = `${planId}:${taskId}:${attempt}`，value = 草稿。
   * **只活在内存里**：不写 localStorage、不写 plan 文件 —— 没点保存就不该持久化
   * 任何东西（§四十五）。关掉面板就没了；换项目时整体清掉，绝不跨项目复用。
   *
   * 之所以按 `planId:taskId:attempt` 而不是「当前展开的那条」做键：
   * 保存是异步的，回来时用户可能已经切到别的 attempt 了。键里带全身份，
   * 响应就只能落回它自己那一条（§三十八）。 */
  const reviewDrafts = new Map();
  /** 正在「清除」的 attempt（清除没有草稿，用这个集合做按钮禁用态）。 */
  const clearingReview = new Set();
  /** 文件列表展开过的 attempt（默认只列前几个，避免 20 个文件糊成一面墙）。 */
  const filesExpanded = new Set();
  /** 打开这个面板时的工作区代号。切过项目之后回来的响应一律丢弃（§三十九）。 */
  const openedGeneration = S.workspaceGeneration;

  openModal((card) => {
    card.classList.add('wide', 'planner');

    /* ---------- 工作区身份：这个面板还属于当前项目吗 ----------
     *
     * 下面三个 helper 必须放在**这个回调里面** —— `renderList` / `renderDetail`
     * 都是在这个作用域里声明的，放外面根本看不见它们。
     * `openedGeneration` 在外层捕获，内层闭包照样读得到。
     */

    /**
     * **这个 Planner 面板还属于当前工作区吗？**
     *
     * `openedGeneration` 在 openPlanner() 打开面板时捕获，所以它就是
     * 「这个面板实例属于哪个 workspace」的身份。项目一换 `S.workspaceGeneration`
     * 自增，这里立刻变 false。
     *
     * 它要回答的问题只有一个：**旧面板还该不该继续工作**。
     * 旧面板手上的 plan / attempt / 草稿全属于旧 workspace —— 切走之后它们
     * 既不该再显示、也不该再发请求。
     */
    const plannerAlive = () => ownsWorkspace(openedGeneration);

    /**
     * 丢弃这个面板实例攒下的全部临时 UI 状态。
     *
     * 三样都属于**旧 workspace**，所以项目一换就该全部作废：
     *   reviewDrafts   未保存的说明（连带 `saving` 标记 —— 不清就会永久停在「正在保存…」）
     *   clearingReview 「正在清除…」的标记
     *   filesExpanded  文件列表的展开状态
     *
     * **刻意不写 localStorage / sessionStorage / plan 文件**：这不是「保留跨项目草稿」，
     * 恰恰相反 —— 项目切换就意味着草稿的生命周期结束。
     */
    function dropPlannerState() {
      reviewDrafts.clear();
      clearingReview.clear();
      filesExpanded.clear();
    }

    /**
     * 把面板收成「项目已切换」的样子：丢掉旧状态 + 只留一句提示。
     *
     * ⚠️ **这里绝不调用 `closeModal()`。** modal 只有一个槽位
     * （`public/ui/modal.js` 的 `closeHook`）且没有实例 token —— 从旧实例关掉它
     * 会把**后来打开的新 Planner 一起关掉**。所以旧实例只做两件事：清自己的状态、
     * 把提示写进**自己那份** detailWrap。若 modal 已被新实例重建，旧 detailWrap
     * 早已从文档里摘掉，这些写入是空操作，一个像素都影响不到新面板。
     */
    function renderStalePlanner() {
      dropPlannerState();
      renderList();
      renderDetail();
    }

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
      /* 项目已经切走 —— 旧项目的计划列表不该继续摆在这儿（§十九）。 */
      if (!plannerAlive()) {
        listWrap.append(el('div', 'ext-empty', '项目已切换，请重新打开 Planner'));
        return;
      }
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
        /* ⚠️ 状态文字**不能塞进 `.ext-dot`** —— 那是个 7×7 的圆点：
         * 文字进去会被挤成一个 7px 宽的文字列，渲染成竖排单字（overflow 可见，
         * 所以还叠在标题上）。拆成「圆点 + 文字」两个 span 才读得出来。
         * 这也是 §五十二 的要求：状态不能只靠颜色，必须有文字。 */
        top.append(el('span', dotClass(PLAN_STATE[p.status]), ''));
        top.append(el('span', 'ext-item-state', (PLAN_STATE[p.status] || {}).label || p.status));
        top.append(el('span', 'ext-name', p.title));
        item.append(top);
        const c = p.counts || {};
        item.append(el('div', 'ext-item-desc', `${c.total || 0} 个任务 · 成功 ${c.success || 0} · 失败 ${c.failed || 0}${c.cancelled ? ' · 取消 ' + c.cancelled : ''}`));
        if ((p.recoveryNotes || []).length) {
          item.append(el('div', 'ext-item-note', p.recoveryNotes.join('；')));
        }
        item.onclick = async () => {
          /* 切过项目之后这个列表属于旧 workspace：点它既不该弹确认框、
           * 更不该去打旧项目的接口。就地收成「项目已切换」。 */
          if (!plannerAlive()) {
            renderStalePlanner();
            return;
          }
          if (dirty && current && !(await confirmModal({ title: '放弃未保存的修改？', message: '当前计划的改动还没保存。', okText: '放弃并切换' }))) return;
          /* 确认框是一个 await —— 用户可能就在那会儿切了项目（§十八）。 */
          if (!plannerAlive()) {
            renderStalePlanner();
            return;
          }
          const r = await fetchPlan(p.id);
          if (!plannerAlive()) return;
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
      /* 项目已经切走 —— 这个面板属于旧 workspace，明细不该继续可交互。
       * 收成一句提示就够：把整个 detailWrap 换掉，里面所有按钮（含审阅的）
       * 也就都不在了，旧面板不可能再对旧项目发出任何写操作。 */
      if (!plannerAlive()) {
        dropPlannerState();
        detailWrap.append(el('div', 'ext-empty', '项目已切换，请重新打开 Planner'));
        return;
      }
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
      head.append(el('span', dotClass(PLAN_STATE[current.status]), ''));
      head.append(el('span', 'planner-head-state', (PLAN_STATE[current.status] || {}).label || current.status));
      detailWrap.append(head);

      if (current.goal) detailWrap.append(el('div', 'planner-goal-view', current.goal));

      /* P9 收口：**独立验证在跑时**，开始 / 编辑 / 删除 都会被后端拒（全局互斥）。
       * 前端先禁掉 + 说明原因，免得用户点了才发现「为什么不行」。
       * 后端仍然是最终权威 —— 这只是 UX。 */
      const vActive = current.verificationActive || null;
      const vTip = vActive ? `有独立验证正在运行（${vActive.taskId} 第 ${vActive.attempt} 次），先停止它` : '';
      const lockBtn = (b) => {
        if (vActive) {
          b.disabled = true;
          b.title = vTip;
        }
        return b;
      };

      const acts = el('div', 'ext-acts');
      if (running) {
        acts.append(btn('停止计划', 'danger', () => doStop()));
      } else {
        acts.append(lockBtn(btn('开始执行', 'primary', () => doStart())));
      }
      if (!running) {
        acts.append(lockBtn(btn('保存修改', dirty ? 'primary' : '', () => doSave())));
        acts.append(lockBtn(btn('删除计划', 'danger', () => doDelete())));
      }
      acts.append(btn('刷新', '', () => refreshCurrent()));
      detailWrap.append(acts);

      /* 进度（规格 §23：状态清晰即可，不画节点连线图） */
      const prog = el('div', 'planner-progress');
      prog.append(el('span', null, `进度 ${c.success + c.failed + c.cancelled + c.skipped}/${c.total}`));
      if (current.status === 'paused') {
        prog.append(el('span', 'planner-warn', '已暂停：有任务失败，请选择重试 / 跳过 / 停止'));
      }
      /* 验证在跑时把话说明白（禁用的按钮只靠 title 是发现不了的）。 */
      if (vActive) {
        prog.append(el('span', 'planner-warn', `有独立验证正在运行（${vActive.taskId} 第 ${vActive.attempt} 次）—— 先停止它，再开始执行 / 编辑 / 删除 / 重试`));
      }
      detailWrap.append(prog);

      /* ---------- P8-C：执行结果 + 人工审阅汇总 ----------
       *
       * **只看每个任务的「最新一次 attempt」**（§二十六/§二十七）。所以
       * 「Attempt 1 成功且被接受、Attempt 2 失败」的任务算作**失败**，
       * 不会因为历史上曾成功而多算一个「已接受」。历史判断仍然留在它自己那张
       * Attempt 卡片里 —— 那是「那次执行曾经被接受」，与「这个任务现在怎样」是两回事。
       *
       * 这是一个**纯展示的汇总，不是闸门**：needs_changes 再多也不会暂停计划、
       * 不会禁止下游、不会改 DAG（§二十九）。 */
      const sum = reviewSummary(current);
      const sumBox = el('div', 'planner-revsum');
      const row1 = el('div', 'planner-revsum-row');
      row1.append(el('span', 'planner-revsum-k', '执行结果'));
      const parts = [`成功 ${sum.exec.success}`, `失败 ${sum.exec.failed}`];
      if (sum.exec.cancelled) parts.push(`取消 ${sum.exec.cancelled}`);
      /* 「中断」单列 —— **不并进「失败」**。应用被关掉不是跑失败，
       * 重启后还能重试；并进去会让计划顶部说一件明细里没发生的事（§四）。 */
      if (sum.exec.interrupted) parts.push(`中断 ${sum.exec.interrupted}`);
      if (sum.exec.none) parts.push(`尚无结果 ${sum.exec.none}`);
      row1.append(el('span', 'planner-revsum-v', parts.join(' · ')));
      sumBox.append(row1);
      /* 审阅汇总只在**确实有成功结果**时才出现 —— 否则是一行全零，纯噪声。
       * 分母也只有「最新一次成功」的那些任务：失败/取消/被中断的结果不是待验收的产物。 */
      if (sum.exec.success > 0) {
        const row2 = el('div', 'planner-revsum-row');
        row2.append(el('span', 'planner-revsum-k', '成功结果审阅'));
        row2.append(el('span', 'planner-revsum-v', `已接受 ${sum.rev.accepted} · 需修改 ${sum.rev.needs_changes} · 待审阅 ${sum.rev.pending}`));
        sumBox.append(row2);
      }
      detailWrap.append(sumBox);

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

    /* ================= P8-C：人工审阅 ================= */

    /** 一条紧凑按钮（attempt 行内用）。评审动作全在这里，避免又长又重的按钮。 */
    const miniBtn = (label, cls, onClick) => {
      const b = el('button', 'planner-mini' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      if (onClick) b.onclick = onClick;
      return b;
    };

    const draftKey = (planId, taskId, attempt) => `${planId}:${taskId}:${attempt}`;

    /**
     * 按**身份**在当前计划里现查一条 attempt。
     *
     * 不缓存、不认闭包里的旧引用 —— 所有异步回来的响应都靠它重新定位。
     * 「保存 Attempt 1 → 用户切去看 Attempt 2 → 响应回来」时，我们改的是
     * 按 taskId+attempt 查出来的那一条，**碰不到 Attempt 2 的界面**（§三十八）。
     */
    function attemptOf(taskId, attempt) {
      const t = current && (current.tasks || []).find((x) => x.id === taskId);
      const arr = t && Array.isArray(t.attempts) ? t.attempts : [];
      return arr.find((a) => a.attempt === attempt) || null;
    }

    /** 这个路径**现在**还有没有未提交差异。
     *  三值：'changed' / 'clean' / 'unknown' —— git 状态还没加载时不许猜（§二十二）。 */
    function currentChangeState(p) {
      const c = S.changes;
      if (!c || !c.loaded || !c.isRepo) return 'unknown';
      return c.files.some((f) => f && f.path === p) ? 'changed' : 'clean';
    }

    /** 进入编辑态。**点状态按钮不直接保存** —— 用户很可能还要补一句说明（§十一）。 */
    function openEditor(planId, taskId, attempt, status, note) {
      /* 旧 workspace 的面板不许再开编辑态（§十七）。 */
      if (!plannerAlive()) {
        renderStalePlanner();
        return;
      }
      const cur = reviewOf(attemptOf(taskId, attempt));
      reviewDrafts.set(draftKey(planId, taskId, attempt), {
        status,
        note: note != null ? note : cur.note,
        saving: false,
        error: '',
        conflict: false,
        conflictRevision: null,
      });
      renderDetail();
    }

    function closeEditor(planId, taskId, attempt) {
      reviewDrafts.delete(draftKey(planId, taskId, attempt));
      renderDetail();
    }

    /**
     * 真正发请求 + 处理结果。草稿有无都能走（「清除」就是无草稿那条路）。
     *
     * 三道身份确认，缺一不可：
     *   1. **项目没换**（`plannerAlive()` —— 这个面板实例还属于当前 workspace）
     *   2. 还是同一个计划（`current.id === planId`）
     *   3. 目标 attempt 仍在当前计划里（按 taskId + attempt 现查）
     * 第 1 条不成立时**不清 DOM 就完事**：要先把这个实例的临时状态（草稿 /
     * 清除中 / 文件展开）整体作废，否则 `saving` 标记会让按钮永久停在
     * 「正在保存…」；然后只把面板收成提示，**不 closeModal**（那会误关新面板）。
     * 第 2、3 条不成立时直接丢弃响应、一个字都不写 —— 那是「计划切换 /
     * attempt 身份不匹配」的污染，界面本来就不该动。
     */
    async function submitReview(planId, taskId, attempt, status, note) {
      /* 旧 workspace 的面板不许再发写请求（§十七）。 */
      if (!plannerAlive()) {
        renderStalePlanner();
        return;
      }
      const key = draftKey(planId, taskId, attempt);
      const draft = reviewDrafts.get(key);
      const target = attemptOf(taskId, attempt);
      if (!target) {
        toast('这次尝试已经不在当前计划里了，请重新加载', 'warn');
        return;
      }
      /* 乐观并发：用**当前渲染这一版的 revision**，永远不是写死的 0（§三十七）。 */
      const revision = reviewOf(target).revision;

      if (draft) {
        if (draft.saving) return; // 防双击
        draft.saving = true;
        draft.error = '';
        draft.conflict = false;
      } else {
        if (clearingReview.has(key)) return;
        clearingReview.add(key);
      }
      renderDetail();

      let r;
      try {
        r = await updateAttemptReview(planId, taskId, attempt, { status, note, expectedRevision: revision });
      } catch (err) {
        r = { ok: false, error: err.message || '网络错误' };
      }
      clearingReview.delete(key);

      /* ---- 先确认「还是那个上下文」，再决定要不要碰 DOM ---- */
      /* ---- 先确认「还是那个上下文」，再决定要不要碰 DOM ---- */
      /* 项目切走了：**这个实例的临时状态全部作废** —— 包括草稿里的 `saving`
       * 标记，否则按钮会永久停在「正在保存…」。然后只把面板收成提示。
       * **绝不 `closeModal()`** —— 那会把后来打开的新 Planner 一起关掉。 */
      if (!plannerAlive()) {
        renderStalePlanner();
        return;
      }
      if (!current || current.id !== planId) return; // 切计划了
      const t2 = attemptOf(taskId, attempt);
      if (!t2) return; // 计划被换成另一份了 —— 宁可不画，也不要画错

      if (r && r.ok) {
        /* **只更新目标那一条**，不重置整个 Planner（§三十二）。 */
        t2.review = r.review || { status, note, reviewedAt: Date.now(), revision: revision + 1 };
        reviewDrafts.delete(key);
        renderDetail();
        toast(status === 'pending' ? '已清除审阅判断' : '审阅已保存', 'ok');
        return;
      }

      const d2 = reviewDrafts.get(key);
      if (d2) {
        d2.saving = false;
        if (r && r.code === 'review-conflict') {
          /* 冲突：**不自动重试、不 last-write-wins、不自动合并 note**（§三十五）。
           * 本地输入原样留着，等用户明确点「重新加载」。 */
          d2.conflict = true;
          d2.conflictRevision = Number.isInteger(r.currentRevision) ? r.currentRevision : null;
        } else {
          /* 校验失败 / 保存失败：把后端的原话显示出来，**输入不能丢**（§三十三 / §三十四）。 */
          d2.error = (r && r.error) || '保存失败';
        }
      } else {
        toast((r && r.error) || '清除失败', 'error');
      }
      renderDetail();
    }

    async function doClearReview(planId, taskId, attempt) {
      if (!plannerAlive()) {
        renderStalePlanner();
        return;
      }
      const ok = await confirmModal({
        title: '清除这条审阅？',
        message: '判断与说明会一起清掉，回到「待审阅」。执行结果本身不受影响。',
        okText: '清除',
        danger: true,
      });
      if (!ok) return;
      /* 确认框是一个 await —— 那会儿用户可能已经切了项目（§十八）。 */
      if (!plannerAlive()) {
        renderStalePlanner();
        return;
      }
      /* 走**同一个 API**：pending 就是「清除」的语义，没有单独的 DELETE 接口，
       * 也不在前端假装删掉（§十二）。 */
      await submitReview(planId, taskId, attempt, 'pending', '');
    }

    /**
     * 一条 attempt 的审阅块。
     *
     * 三态只有 pending / accepted / needs_changes，**刻意不含 verified / rejected /
     * stale / superseded** —— 状态一多，用户就得先学一套词汇才能表达「我认不认」。
     */
    function renderReview(planId, task, a, isRunning) {
      const wrap = el('div', 'planner-rv');
      wrap.append(el('span', 'planner-lbl', '人工审阅'));

      if (isRunning) {
        /* 正在跑的那一次**还没有历史记录**（attempt 号在开始时涨上去，记录是结束时写的），
         * 此刻没有可审阅的对象 —— 所以不发请求、不给按钮，直接说明（§九）。 */
        wrap.append(el('span', 'planner-rv-hint', '任务仍在执行，完成后可进行人工审阅'));
        return wrap;
      }

      const key = draftKey(planId, task.id, a.attempt);
      const draft = reviewDrafts.get(key);
      const saved = reviewOf(a);

      if (!draft) {
        /* ---------- 展示态 ---------- */
        const meta = REVIEW_STATE[saved.status];
        const line = el('div', 'planner-rv-view');
        /* **状态必须有文字**，不能只靠颜色区分（§五十二）。 */
        line.append(el('span', 'planner-rv-state ' + meta.cls, meta.mark + ' ' + meta.label));
        if (saved.reviewedAt) line.append(el('span', 'planner-rv-time', fmtTime(saved.reviewedAt)));
        wrap.append(line);
        if (saved.note) wrap.append(el('div', 'planner-rv-note', saved.note));

        const acts = el('div', 'planner-rv-acts');
        if (clearingReview.has(key)) {
          acts.append(el('span', 'planner-rv-hint', '正在清除…'));
        } else if (saved.status === 'pending') {
          /* 「接受本次结果」只给执行成功的尝试 —— 与后端同一条规则。
           * 失败 / 取消 / 被中断的**只有「需要修改」**（§八）。 */
          if (canAccept(a)) acts.append(miniBtn('接受本次结果', 'primary', () => openEditor(planId, task.id, a.attempt, 'accepted')));
          acts.append(miniBtn('需要修改', '', () => openEditor(planId, task.id, a.attempt, 'needs_changes')));
        } else {
          acts.append(miniBtn('修改判断', '', () => openEditor(planId, task.id, a.attempt, saved.status, saved.note)));
          acts.append(miniBtn('清除', '', () => doClearReview(planId, task.id, a.attempt)));
        }
        wrap.append(acts);
        return wrap;
      }

      /* ---------- 编辑态 ---------- */
      const pick = el('div', 'planner-rv-pick');
      const mkPick = (value, label) => {
        const b = el('button', 'planner-rv-opt' + (draft.status === value ? ' on' : ''), label);
        b.type = 'button';
        b.disabled = Boolean(draft.saving);
        b.onclick = () => {
          draft.status = value;
          renderDetail();
        };
        return b;
      };
      if (canAccept(a)) pick.append(mkPick('accepted', '✓ 接受本次结果'));
      pick.append(mkPick('needs_changes', '↻ 需要修改'));
      wrap.append(pick);

      wrap.append(el('div', 'planner-lbl planner-rv-lbl2', '说明'));
      const counter = el('div', 'planner-rv-count');
      const ta = el('textarea', 'planner-rv-note-in');
      ta.rows = 3;
      ta.maxLength = REVIEW_NOTE_MAX;
      ta.value = draft.note;
      ta.disabled = Boolean(draft.saving);
      ta.placeholder = '写一句判断依据（可选）';
      ta.oninput = () => {
        draft.note = ta.value;
        counter.textContent = ta.value.length + ' / ' + REVIEW_NOTE_MAX;
      };
      counter.textContent = draft.note.length + ' / ' + REVIEW_NOTE_MAX;
      wrap.append(ta, counter);

      const acts = el('div', 'planner-rv-acts');
      const saveLabel = draft.saving ? '正在保存…' : draft.error ? '重试' : '保存';
      const save = miniBtn(saveLabel, 'primary', () => submitReview(planId, task.id, a.attempt, draft.status, draft.note));
      save.disabled = Boolean(draft.saving);
      acts.append(save);
      if (!draft.saving) {
        /* 冲突时不提供「取消」这个逃生口之外的静默路径 —— 用户要么重新加载，
         * 要么继续编辑，两条路都是明确的。 */
        const cancel = miniBtn('取消', '', () => closeEditor(planId, task.id, a.attempt));
        acts.append(cancel);
      }
      wrap.append(acts);

      if (draft.conflict) {
        const box = el('div', 'planner-rv-msg err');
        box.append(el('div', null, '这条审阅已经在其他窗口被修改。你写的内容还留着 —— 点「重新加载」会拿服务端最新的那一版覆盖它。'));
        box.append(miniBtn('重新加载', '', () => {
          /* 用户明确选择覆盖：丢掉草稿，重新拉一次计划（§四十一）。
           * 只重拉 plan detail，不刷新整个窗口。 */
          reviewDrafts.delete(key);
          refreshCurrent();
        }));
        wrap.append(box);
      } else if (draft.error) {
        wrap.append(el('div', 'planner-rv-msg err', '保存失败：' + draft.error));
      }
      return wrap;
    }

    /* ================= P9：独立验证 =================
     *
     * 与 P8 的「人工审阅」是**两件事**，界面上也分开显示：
     *
     *     独立验证   Pi GUI 真的跑了一遍那条命令 —— 这是**机器证据**
     *     人工审阅   我认不认这个结果 —— 这是**人的判断**
     *
     * 所以「验证通过 + 待审阅」和「验证失败 + 已接受」都是合法组合。
     * 验证通过**不会**自动 accepted（要人来点），验证失败也**不会**自动重试。
     */

    const VERIFY_STATE = {
      running: { cls: 'run', label: '正在验证…' },
      passed: { cls: 'ok', label: '通过' },
      failed: { cls: 'err', label: '失败' },
      interrupted: { cls: 'warn', label: '已中断' },
    };

    /** 归一化一条验证记录 —— 与后端 `normalizeVerificationResult` 同一套语义。
     *  后端已经保证形状，这里再挡一道是给「夹具 / P9 之前的老数据」：
     *  它们根本没有 `verificationResult` 字段，必须照常显示「尚未独立确认」。 */
    function verificationOf(a) {
      const v = a && a.verificationResult && typeof a.verificationResult === 'object' ? a.verificationResult : null;
      if (!v || !Object.prototype.hasOwnProperty.call(VERIFY_STATE, v.status)) return null;
      return {
        status: v.status,
        command: typeof v.command === 'string' ? v.command : '',
        /* 实际在哪个目录跑的、以及那个目录是**冻结的**还是**退而求其次的**。
         * 后者必须如实说明 —— 它和冻结记录不是同一种证据强度。 */
        workingDirectory: typeof v.workingDirectory === 'string' ? v.workingDirectory : '',
        workingDirectorySource: typeof v.workingDirectorySource === 'string' ? v.workingDirectorySource : '',
        exitCode: Number.isInteger(v.exitCode) ? v.exitCode : null,
        durationMs: Number.isFinite(v.durationMs) ? v.durationMs : null,
        outputSummary: typeof v.outputSummary === 'string' ? v.outputSummary : '',
        truncated: Boolean(v.truncated),
        error: typeof v.error === 'string' ? v.error : '',
      };
    }

    /** 这条 attempt 当初冻结的验证要求里有没有**可执行命令**。
     *  只有 description 时不给「运行验证」—— 由一句描述猜一条命令是在编造要求。 */
    function hasVerificationCommand(a) {
      const s = a && a.verificationSnapshot;
      return Boolean(s && typeof s.command === 'string' && s.command.trim());
    }

    /** 把一份验证记录按**身份**写回内存里的计划，然后重画。 */
    function applyVerification(planId, taskId, attempt, record) {
      if (!current || current.id !== planId) return;
      const t = (current.tasks || []).find((x) => x.id === taskId);
      const a = t && (Array.isArray(t.attempts) ? t.attempts : []).find((x) => x.attempt === attempt);
      if (!a) return;
      a.verificationResult = record || null;
      /* 刚由**本进程**起的这一次：`running` 是活的（决定给不给「停止验证」）。 */
      a.verificationRunning = Boolean(record && record.status === 'running');
      /* 全局互斥的 UX 那一半：起手就把锁置上，结束时松开。
       * 后端才是权威 —— 这里只是让界面与它一致（别让用户点一个必然被拒的按钮）。 */
      current.verificationActive = record && record.status === 'running' ? { planId, taskId, attempt } : null;
      renderDetail();
    }

    async function doRunVerification(planId, taskId, attempt) {
      if (!plannerAlive()) {
        renderStalePlanner();
        return;
      }
      try {
        const r = await verifyPlanAttempt(planId, taskId, attempt);
        /* 响应回来先确认上下文没变 —— 切了项目就一个字都不写。 */
        if (!plannerAlive()) {
          renderStalePlanner();
          return;
        }
        if (!r.ok) {
          /* 显示后端原话：`no-command` / `plan-active` / `already-running` 都能读懂。
           * 状态可能已经被别处改了（例如同一次正在跑），所以拉一次权威数据。 */
          toast(r.error || '无法运行验证', 'warn');
          await refreshCurrent();
          return;
        }
        applyVerification(planId, taskId, attempt, r.verification);
        toast('已开始独立验证', 'ok');
      } catch (err) {
        toast('运行验证失败：' + err.message, 'error');
      }
    }

    async function doStopVerification(planId, taskId, attempt) {
      if (!plannerAlive()) {
        renderStalePlanner();
        return;
      }
      try {
        const r = await stopPlanAttemptVerification(planId, taskId, attempt);
        if (!plannerAlive()) {
          renderStalePlanner();
          return;
        }
        if (!r.ok) {
          toast(r.error || '停止失败', 'warn');
          return;
        }
        toast('已请求停止验证，稍等一下会收成「已中断」', 'info');
      } catch (err) {
        toast('停止验证失败：' + err.message, 'error');
      }
    }

    /**
     * 验证区。「尚未独立确认」只在**从来没跑过**时出现 —— 跑过之后显示的是
     * 机器实际跑出来的东西。但**验证通过仍然不等于人工验收**，那是下一行的事。
     */
    function renderVerification(planId, task, a) {
      const vr = verificationOf(a);
      const live = Boolean(a.verificationRunning);
      /* 两个类：`.planner-attempt-verify` 是**行布局**（与「验证要求」那行共用），
       * `.planner-verify-row` 标明「这是验证结果那一行」—— 两行长得一样但语义不同，
       * 只靠共用的布局类去 querySelector 只会拿到第一行（测试里就踩到过）。 */
      const row = el('div', 'planner-attempt-verify planner-verify-row');
      row.append(el('span', 'planner-lbl', '验证结果'));
      if (!vr) {
        row.append(el('span', 'planner-rv-hint', '尚未独立确认'));
      } else {
        row.append(el('span', 'planner-verify-state ' + VERIFY_STATE[vr.status].cls, VERIFY_STATE[vr.status].label));
      }
      /* 按钮只看两件事：**有没有可跑的命令**、**跑没跑完**。
       * `running` 但本进程没在跑（磁盘上留着的陈旧记录 —— 正常只出现在崩溃后，
       * 下次启动会被恢复成「已中断」）→ 不给「停止验证」，因为没有东西可停。 */
      if (hasVerificationCommand(a)) {
        if (vr && vr.status === 'running') {
          if (live) row.append(miniBtn('停止验证', '', () => doStopVerification(planId, task.id, a.attempt)));
        } else {
          row.append(miniBtn(vr ? '重新运行验证' : '运行验证', 'primary', () => doRunVerification(planId, task.id, a.attempt)));
        }
      }
      return row;
    }

    /** 验证明细（命令 / 退出码 / 耗时 / 输出 / 错误）。单起一行，免得把状态行撑爆。 */
    function renderVerificationDetail(a) {
      const vr = verificationOf(a);
      if (!vr) return null;
      const box = el('div', 'planner-verify-detail');

      if (vr.command) {
        const line = el('div', 'planner-verify-line');
        line.append(el('span', 'planner-lbl', '命令'));
        const chip = el('span', 'planner-verify-cmd', vr.command);
        chip.title = vr.command; // 长命令截断后悬停看全（与文件路径同一条规矩）
        line.append(chip);
        box.append(line);
      }
      if (vr.workingDirectory) {
        const line = el('div', 'planner-verify-line');
        line.append(el('span', 'planner-lbl', '目录'));
        const chip = el('span', 'planner-verify-cwd', vr.workingDirectory);
        chip.title = vr.workingDirectory;
        line.append(chip);
        box.append(line);
        /* fallback **必须如实说**。它是「我现在猜它当初在哪儿跑的」，
         * 不是「我当时在哪儿跑的」—— 两者证据强度不一样，不能装成一样。 */
        if (vr.workingDirectorySource === 'current-task-fallback') {
          box.append(el('div', 'planner-verify-msg warn', '这次执行没有记录当时的工作目录，上面显示的是当前任务的目录 —— 证据强度低于冻结记录。'));
        }
      }
      if (vr.status !== 'running') {
        const facts = [];
        if (vr.exitCode !== null) facts.push(`退出码 ${vr.exitCode}`);
        if (Number.isFinite(vr.durationMs)) facts.push(`耗时 ${fmtDuration(vr.durationMs)}`);
        if (facts.length) {
          const line = el('div', 'planner-verify-line');
          line.append(el('span', 'planner-lbl', '结果'));
          line.append(el('span', 'planner-verify-facts', facts.join(' · ')));
          box.append(line);
        }
      }
      if (vr.error) box.append(el('div', 'planner-verify-msg err', vr.error));
      if (vr.outputSummary) {
        const pre = el('pre', 'planner-verify-out');
        /* 纯文本 —— 命令输出是**完全不可信**的输入（里面有仓库内容、可能有人
         * 故意打出来的标签）。与 Agent stdout 同一条规矩。 */
        pre.textContent = vr.outputSummary;
        box.append(pre);
        /* 截断必须说出来：悄悄只给末尾会让人以为「输出就这么点」。 */
        if (vr.truncated) box.append(el('div', 'planner-verify-msg', '输出已截断，只保留末尾'));
      }
      return box.childElementCount ? box : null;
    }

    /* ================= P10：历史变更证据（Attempt 冻结的 Diff） =================
     *
     * 与「当前 Diff」是两件事：
     *
     *     当前 Diff     工作区**此刻**相对 Git 基线是什么样 —— 会随时间漂移
     *     本次 Diff     这次 Attempt **执行前 → 执行后**的差 —— 一旦写下就不再变
     *
     * 措辞仍然是「执行期间观察到的变化」，**不是**「Agent 改的」：
     * 用户、编辑器、formatter、watcher、构建脚本都可能在同一时间段动过文件。
     */

    const EVIDENCE_KIND = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' };
    const EVIDENCE_LABEL = { modified: '修改', added: '新增', deleted: '删除', renamed: '改名' };

    /** 归一化一份历史证据 —— 与后端 `normalizeChangeEvidence` 同一套语义。
     *  老 attempt 根本没有这个字段 → null（界面**不假装**有 Diff）。 */
    function evidenceOf(a) {
      const e = a && a.changeEvidence && typeof a.changeEvidence === 'object' ? a.changeEvidence : null;
      if (!e) return null;
      const status = ['available', 'partial', 'unavailable'].includes(e.status) ? e.status : 'unavailable';
      const files = (Array.isArray(e.files) ? e.files : []).map((f) => ({
        path: typeof f.path === 'string' ? f.path : '',
        change: EVIDENCE_KIND[f.change] ? f.change : 'modified',
        oldPath: typeof f.oldPath === 'string' && f.oldPath ? f.oldPath : null,
        binary: Boolean(f.binary),
        additions: Number.isInteger(f.additions) ? f.additions : null,
        deletions: Number.isInteger(f.deletions) ? f.deletions : null,
        patch: typeof f.patch === 'string' ? f.patch : '',
        truncated: Boolean(f.truncated),
      })).filter((f) => f.path);
      return { status, files, truncated: Boolean(e.truncated), note: typeof e.note === 'string' ? e.note : '' };
    }

    /**
     * 历史 Diff 查看器。
     *
     * 第一版刻意**只做证据可读**：文件列表 → 展开 → unified diff。
     * 没有 side-by-side、没有语法高亮、没有 Monaco（§十九）。
     *
     * 所有内容都是**不可信文本**（仓库内容里可能有 `<img onerror>`）：路径、patch、
     * note 一律 textContent 渲染 ✓ 一条 innerHTML 都没有。
     */
    function openHistoricalDiff(taskId, attemptNo) {
      const a = attemptOf(taskId, attemptNo);
      const ev = a ? evidenceOf(a) : null;
      if (!ev) return;
      openModal((card) => {
        card.classList.add('wide', 'planner', 'evidence');
        const head = el('div', 'ev-head');
        head.append(el('h3', null, `历史 Diff · 第 ${attemptNo} 次尝试`));
        card.append(head);
        /* 这一句是 P10 的核心语义，必须显眼：它不是「现在的文件」。 */
        card.append(el('div', 'ev-sub', '这是该 Attempt 执行前后观察到的工作区变化。之后的修改不会改变这里的内容。'));

        const sum = el('div', 'ev-sum');
        sum.append(el('span', null, ev.files.length ? `${ev.files.length} 个文件` : '没有文件变化'));
        if (ev.truncated) sum.append(el('span', 'ev-warn', '历史 Diff 已截断'));
        card.append(sum);
        if (ev.note) card.append(el('div', 'ev-note', ev.note));

        if (ev.status === 'unavailable') {
          card.append(el('div', 'ev-empty', '这次执行没有采集到变更证据。'));
        } else if (!ev.files.length) {
          card.append(el('div', 'ev-empty', '这次执行期间没有观察到文件变化。'));
        } else {
          const all = [];
          for (const f of ev.files) {
            const det = el('details', 'ev-file');
            const sm = el('summary', 'ev-file-head');
            sm.append(el('span', 'ev-kind ' + f.change, EVIDENCE_KIND[f.change] || 'M'));
            const p = el('span', 'ev-path', f.path);
            p.title = f.path; // 长路径截断后悬停看全
            sm.append(p);
            if (f.oldPath) sm.append(el('span', 'ev-old', '← ' + f.oldPath));
            if (f.binary) sm.append(el('span', 'ev-stat', '二进制'));
            else if (f.additions !== null || f.deletions !== null) sm.append(el('span', 'ev-stat', `+${f.additions ?? '?'} −${f.deletions ?? '?'}`));
            if (f.truncated) sm.append(el('span', 'ev-warn', '已截断'));
            det.append(sm);

            if (f.binary) {
              det.append(el('div', 'ev-note', '二进制文件已变化，不展示文本 Diff'));
            } else if (f.patch) {
              const pre = el('pre', 'ext-code ev-patch');
              pre.textContent = f.patch; // ← 纯文本。patch 里什么都可能有。
              det.append(pre);
            } else {
              det.append(el('div', 'ev-note', '这次执行没有保存这个文件的内容记录'));
            }
            card.append(det);
            all.push(det);
          }
          /* 50 个文件一次性展开会把几 MB 塞进 DOM —— 默认全收起（§二十六）。 */
          const acts = el('div', 'ext-acts');
          const toggle = btn('全部展开', '', () => {
            const open = all.some((d) => !d.open);
            for (const d of all) d.open = open;
            toggle.textContent = open ? '全部收起' : '全部展开';
          });
          acts.append(toggle);
          card.append(acts);
        }
      });
    }

    /**
     * 一条 attempt：状态 + 关联会话 + 执行期间变更 + 历史证据 + 验证要求 + 人工审阅。
     *
     * 四种「没有会话」的情形分开说，因为用户该做的事完全不同：
     *   - 这次执行没关联到会话（Agent 不支持）→ 「无可关联会话」
     *   - 关联过，但会话文件已经找不到了 → 「关联会话已删除」
     *   - 有会话且能找到 → 显示标题 + 「打开会话」
     * 全都不是错误，所以都不用红色 —— 这只是信息缺失，不是失败。
     */
    function renderAttempt(planId, task, a) {
      const row = el('div', 'planner-attempt');
      const head = el('div', 'planner-attempt-head');
      /* 执行结论用**稳定字段**（`outcomeStatus`），不再从 error 文案猜 ——
       * 文案是给人看的，改一次就静默失效（见 attemptOutcome 的说明）。 */
      const outcome = attemptOutcome(a);
      const meta = TASK_STATE[outcome] || { dot: 'dim', label: outcome };
      head.append(el('span', dotClass(meta), ''));
      head.append(el('span', 'planner-attempt-no', `第 ${a.attempt} 次`));
      head.append(el('span', 'planner-attempt-state', meta.label));
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
         * 这个字符串同时也是 smoke.cjs 的断言对象。 */
        frow.append(el('span', 'planner-lbl', '执行期间变更'));
        const list = el('div', 'planner-file-list');
        /* 展开态按 attempt 记，不按 task —— 同一个 task 的不同 attempt 各管各的。 */
        const expandKey = draftKey(planId, task.id, a.attempt) + ':files';
        const expanded = filesExpanded.has(expandKey);
        let anyChanged = false;
        for (const p of expanded ? files : files.slice(0, FILES_PREVIEW)) {
          const line = el('div', 'planner-file-row');
          /* 路径仍然是**纯 `.planner-file` 文本节点** —— 现有测试按 textContent 断言它，
           * 所以「查看当前 Diff」必须是它的兄弟节点，不能塞进去。 */
          const chip = el('span', 'planner-file', p);
          /* 超长路径会被 CSS 截断，悬停时用 title 给全路径（§四十八）。 */
          chip.title = p;
          line.append(chip);
          const state = currentChangeState(p);
          if (state === 'clean') {
            /* 历史文件关系保留、**不隐藏这个文件**，只是如实说明现在没差异了（§二十二）。 */
            line.append(el('span', 'planner-rv-hint', '当前工作区已无该文件的未提交差异'));
          } else {
            if (state === 'changed') anyChanged = true;
            line.append(
              miniBtn('查看当前 Diff', '', () => {
                /* 复用现有的 Git 变更面板，**不新做 reviewDiff / historicalDiff**（§二十）：
                 * P7/P8 从来没有保存过「这次执行当时的 diff」，能给的只有当前工作区。 */
                closeModal();
                openChangesPanel();
              })
            );
          }
          list.append(line);
        }
        if (files.length > FILES_PREVIEW) {
          list.append(
            miniBtn(expanded ? `收起（共 ${files.length} 个）` : `展开其余 ${files.length - FILES_PREVIEW} 个`, '', () => {
              if (expanded) filesExpanded.delete(expandKey);
              else filesExpanded.add(expandKey);
              renderDetail();
            })
          );
        }
        frow.append(list);
        if (a.changeCaptureIncomplete) {
          /* 有文件但采集不全 —— 不能因为「有内容」就不提这件事（§二十三）。 */
          frow.append(el('span', 'planner-rv-warn', '⚠ 执行期间文件变化未完整采集'));
        }
        row.append(frow);
        if (anyChanged) {
          /* 两种 Diff 的语义必须写在 UI 上（§十八）：上面那些按钮给的是
           * **当前工作区**的差异，P10 那个按钮给的是**这次执行前后**冻结的证据。
           * 两者可能完全不同，措辞不能混。 */
          row.append(el('div', 'planner-attempt-note', '「查看当前 Diff」打开的是当前工作区的差异，会随之后的修改变化。'));
        }
      } else if (a.changeCaptureIncomplete) {
        row.append(el('div', 'planner-attempt-note', '执行期间变更：采集不到（这个项目不是 git 仓库，或这次执行被中断）'));
      } else {
        row.append(el('div', 'planner-attempt-note', '执行期间未观察到文件变化'));
      }

      /* ---------- P10：历史变更证据 ----------
       *
       * 与上面「查看当前 Diff」**分开**：这个是这次执行前后冻结下来的证据，
       * 之后无论工作区怎么变、Retry 多少次，它都不动。
       * 没有证据时**不假装有**（老 attempt / 采集失败都如实说）。 */
      const ev = evidenceOf(a);
      const evRow = el('div', 'planner-attempt-evidence');
      if (ev && ev.status !== 'unavailable') {
        evRow.append(miniBtn('查看本次 Diff', '', () => openHistoricalDiff(task.id, a.attempt)));
        evRow.append(el('span', 'planner-rv-hint', `这次执行前后 ${ev.files.length} 个文件的变化（冻结证据，不会随工作区改变）`));
        if (ev.status === 'partial' || ev.truncated) evRow.append(el('span', 'planner-rv-warn', '⚠ 证据不完整'));
      } else if (ev) {
        evRow.append(el('span', 'planner-rv-hint', '这次执行没有采集到变更证据'));
        if (ev.note) evRow.append(el('span', 'planner-rv-hint', `（${ev.note}）`));
      } else {
        /* 老 attempt（P10 之前产生的）根本没有这个字段 —— 如实说，不假装有 Diff。 */
        evRow.append(el('span', 'planner-rv-hint', '这次执行没有变更证据（更早版本没有采集）'));
      }
      row.append(evRow);

      /* ---------- 验证要求 / 验证结果（P8-A 的 verificationSnapshot） ----------
       *
       * 「验证要求」是**这次执行开始时**冻结下来的，所以之后改 task.verification
       * 不会篡改历史。老 attempt 没有快照时如实说没有 —— 并把**当前任务**的要求
       * 另起一行标出来，前缀必须写「当前任务」，否则用户会以为那是当时的要求（§十六）。 */
      const snap = verificationText(a.verificationSnapshot);
      const vrow = el('div', 'planner-attempt-verify');
      vrow.append(el('span', 'planner-lbl', '验证要求'));
      if (snap) {
        vrow.append(el('span', 'planner-verify-cmd', snap));
      } else {
        vrow.append(el('span', 'planner-rv-hint', '该次执行没有保存历史验证要求'));
      }
      row.append(vrow);
      if (!snap) {
        const curV = verificationText(task.verification);
        if (curV) {
          const crow = el('div', 'planner-attempt-verify');
          crow.append(el('span', 'planner-lbl', '当前任务验证要求'));
          crow.append(el('span', 'planner-verify-cmd', curV));
          row.append(crow);
        }
      }
      /* ---------- 独立验证（P9） ----------
       *
       * 「尚未独立确认」只在**从没跑过**时出现。跑过之后这一行显示的是 Pi GUI
       * 自己跑出来的结果 —— 但**验证通过仍然不等于人工验收**：那是下面
       * 「人工审阅」那一行的判断，两者永远是两行。
       *
       * ⚠️ 仍然**不提供**「标记为已验证」这种入口：Pi GUI 只报它真的跑出来的东西，
       * 不替人下结论。 */
      row.append(renderVerification(planId, task, a));
      const vdetail = renderVerificationDetail(a);
      if (vdetail) row.append(vdetail);

      /* ---------- P8-C：人工审阅 ---------- */
      row.append(renderReview(planId, task, a, false));
      return row;
    }

    /**
     * 正在执行的那一次尝试。
     *
     * 它**在历史里还不存在**（attempt 号在开始时涨上去，记录是结束时才写的），
     * 但正因如此界面必须显式占位 —— 否则用户看到「第 2 次执行中」却没有第 2 条的
     * 任何痕迹，会以为记录丢了。这一行只说明状态，**不给任何审阅操作**（§九）。
     */
    function renderRunningAttempt(planId, task) {
      const row = el('div', 'planner-attempt planner-attempt-live');
      const head = el('div', 'planner-attempt-head');
      head.append(el('span', dotClass(TASK_STATE.running), ''));
      head.append(el('span', 'planner-attempt-no', `第 ${task.attempt} 次`));
      head.append(el('span', 'planner-attempt-state', '执行中'));
      row.append(head);
      row.append(renderReview(planId, task, { attempt: task.attempt }, true));
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
      top.append(el('span', dotClass(meta), ''));
      top.append(el('span', 'planner-task-state', meta.label));
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
        /* P8-C：正在跑的那一次也占一行（它在历史里还不存在，见 renderRunningAttempt）。 */
        if (t.status === 'running') hist.append(renderRunningAttempt(current.id, t));
        wrap.append(hist);
      } else if (t.status === 'running') {
        const hist = el('div', 'planner-attempts');
        hist.append(el('div', 'ext-sec-head', '本次执行'));
        hist.append(renderRunningAttempt(current.id, t));
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
      /* P9 收口：验证在跑时 Retry 会被后端拒（全局互斥）。跳过 / 取消不受影响 ——
       * 它们只改计划里的状态，不在工作区里跑命令，后端也没锁它们。 */
      const taskLocked = Boolean(current && current.verificationActive);
      const lockTaskBtn = (b) => {
        if (taskLocked) {
          b.disabled = true;
          b.title = '有独立验证正在运行，先停止它再重试';
        }
        return b;
      };
      if (t.status === 'failed' || t.status === 'interrupted') {
        tacts.append(lockTaskBtn(btn('重试', 'primary', () => doTaskAction('retry', t.id))));
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
      /* 旧 workspace 的面板不再拉列表 / 重画（§十九）。 */
      if (!plannerAlive()) {
        renderStalePlanner();
        return;
      }
      try {
        const r = await fetchPlans();
        if (!plannerAlive()) return; // 请求飞在路上时切了项目
        plans = r.plans || [];
        renderList();
        if (current && !plans.some((p) => p.id === current.id)) current = null;
        renderDetail();
        loadPlannerBadge();
      } catch (err) {
        if (!plannerAlive()) return;
        listWrap.replaceChildren(el('div', 'ext-empty', '读取计划失败：' + err.message));
      }
    }

    async function refreshCurrent() {
      if (!current) return;
      /* 切过项目之后旧面板点「刷新」，不该又去请求旧项目的计划（§十八）。 */
      if (!plannerAlive()) {
        renderStalePlanner();
        return;
      }
      try {
        const r = await fetchPlan(current.id);
        if (!plannerAlive()) return; // response 回来时又切走了
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

      /* P9：独立验证的开始 / 结束。
       *
       * 开始 → 就地标成 running，按钮立刻变成「停止验证」，不用等下一次拉取。
       * 结束 → **拉一次权威数据**：退出码、耗时、输出摘要都在后端的记录里，
       *        前端不自己再拼一遍（拼一遍就是第二个真相，迟早与后端漂开）。 */
      if (evt.kind === 'verification_start' || evt.kind === 'verification_end') {
        const attNo = evt.data && Number.isInteger(evt.data.attempt) ? evt.data.attempt : null;
        const task = evt.taskId ? current.tasks.find((x) => x.id === evt.taskId) : null;
        const att = attNo !== null && task
          ? (Array.isArray(task.attempts) ? task.attempts : []).find((x) => x.attempt === attNo)
          : null;
        if (att && evt.kind === 'verification_start') {
          att.verificationResult = {
            status: 'running',
            command: evt.data.command || '',
            workingDirectory: evt.data.workingDirectory || '',
            workingDirectorySource: evt.data.workingDirectorySource || '',
            startedAt: evt.timestamp || null,
          };
          att.verificationRunning = true;
          current.verificationActive = { planId: evt.planId, taskId: evt.taskId, attempt: attNo };
        }
        renderDetail();
        if (evt.kind === 'verification_end') setTimeout(() => refreshCurrent(), 150);
        return;
      }

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
