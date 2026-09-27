/* Plan / Task 数据模型 + DAG 校验 + 路径安全（规格 §3–§5、§14、§15、§43、§44）。
 *
 * 这个文件只有纯函数：不碰磁盘、不 spawn、不发事件。所以它能被单独测，
 * 也是「模型输出 = 不可信输入」这条规矩的落点 —— Planner 拿回来的 JSON 必须
 * 从这里过一遍（parse → validate → normalize），过不去就不许执行。
 *
 * ---------- 三条设计选择，都是刻意的 ----------
 *
 * 1. **状态用明确的枚举，不用 `done: true/false`**（规格 §4）。
 *    原因很实际：`done` 无法区分「失败」「被用户取消」「依赖没满足所以没跑」，
 *    而这三种在 UI 上要给完全不同的操作（重试 / 什么都不做 / 改依赖）。
 *
 * 2. **`cancelled` 不是 `failed`**（规格 §25）。用户主动停下来的东西标红成失败，
 *    会把「我按了停止」显示成「出错了」，然后诱导用户去重试一个他刚放弃的任务。
 *
 * 3. **workingDirectory 必须落在项目内，且必须已存在**（规格 §14/§15）。
 *    复用 `lib/safe-path.js` 的 `resolveProjectPath` —— 它已经处理了 `../`、
 *    绝对路径、Windows 盘符、UNC、以及 realpath 之后的 symlink/junction 逃逸。
 *    要求「已存在」是刻意的：不隐式建目录，第一版优先可预测。
 */
import path from 'node:path';
import { resolveProjectPath } from '../../lib/safe-path.js';
import { MAX_SESSION_ID, SESSION_ID_RE, isSafeSessionId, toSafeSessionId } from '../../lib/session-id.js';

/* 会话 id 的校验规则来自 `lib/session-id.js` —— 那是全项目唯一一处定义，
 * sessions.js 也用同一份（同一约束两个消费者，各写一份迟早会漂）。
 * 这里原样再导出，方便调用方从 model 拿齐「模型相关的一切」。 */
export { MAX_SESSION_ID, SESSION_ID_RE, isSafeSessionId };

export const PLAN_STATUS = Object.freeze({
  DRAFT: 'draft',
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  BLOCKED: 'blocked',
  READY: 'ready',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
  /** 上次进程死掉时它还在 running —— 原进程已经没了，不能假装还在跑（规格 §31） */
  INTERRUPTED: 'interrupted',
});

/** 不会再变的 task 状态。scheduler 靠它判断依赖是否已有结论。 */
export const TERMINAL_TASK_STATUS = Object.freeze([
  TASK_STATUS.SUCCESS,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.SKIPPED,
  TASK_STATUS.INTERRUPTED,
]);

/** 不会再变的 plan 状态。 */
export const TERMINAL_PLAN_STATUS = Object.freeze([PLAN_STATUS.COMPLETED, PLAN_STATUS.FAILED, PLAN_STATUS.CANCELLED]);

/** 第一版同一 workspace 只允许一个 running Plan（规格 §32）。 */
export const MAX_TASKS = 24;
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 8000;
export const MAX_GOAL = 4000;
export const DEFAULT_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 2;

let seq = 0;
export function newPlanId(now = Date.now()) {
  seq = (seq + 1) % 100000;
  return `plan-${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clampStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/* ==================== P7：任务 ↔ 会话 / 任务 ↔ 文件 的关系字段 ====================
 *
 * 两条规矩，都是**不能破**的：
 *
 * 1. **会话 id 只允许「稳定 id」，绝不允许路径。** 前端与持久化里出现的 sessionId
 *    永远是 pi 的会话 id（或我们自己拼的那个），不是 `C:\...\xxx.jsonl`。
 *    路径只活在后端解析的那一刻（见 server/sessions.js 的 resolveByUuid）。
 *
 * 2. **filesChanged 只允许项目相对路径。** 绝对路径会随项目被搬到别的机器上而失真，
 *    而且它属于「不该进 Planner 元数据」的东西（规格 §33 / §32）。
 *
 * 字符集这条**不是洁癖**：pi 对 `--session-id` 做同一个校验
 * （`assertValidSessionId`），不合法时 `validateSessionIdFlags` 直接 `process.exit(1)`。
 * 所以拼 id 的时候就要保证合法 —— 否则一个带非法字符的 task id 会让任务
 * 在**启动阶段**就死掉，报错还跟 session 毫无关系，极难查。
 */
/** 一次 attempt 最多记多少个变更文件（超出只截断展示，不影响执行）。 */
export const MAX_FILES_CHANGED = 200;
const MAX_CHANGED_PATH = 400;

/**
 * 给一次 attempt 拼一个**确定性**的会话 id。
 *
 * 确定性是有意的：这样「这个 task 的这次尝试用了哪个会话」在执行前就已经确定，
 * 不依赖解析 Agent 的输出。而 attempt 编号进 id，保证**每次重试拿到不同的会话**
 * —— 否则重试会续进上一次那个会话，Attempt 1 / Attempt 2 的关系就分不开了
 * （规格 §29 要求两次尝试各自保留自己的会话）。
 */
export function taskSessionId(planId, taskId, attempt) {
  const safe = toSafeSessionId(`pi-gui-${planId}-${taskId}-a${attempt}`);
  return safe || `pi-gui-task-a${Number(attempt) || 1}`;
}

/**
 * 归一化一个「变更文件路径」。不合规的一律丢弃（返回 ''），不抛错 ——
 * 一个坏路径不该让整个计划读不出来（规格 §38「corrupt relation 不拖垮 Planner」）。
 */
export function normalizeChangedPath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim().replace(/\\/g, '/');
  if (!s || s.length > MAX_CHANGED_PATH) return '';
  if (s.startsWith('/')) return ''; // 绝对路径（posix）
  if (/^[A-Za-z]:/.test(s)) return ''; // 绝对路径（Windows 盘符）
  if (s.startsWith('//')) return ''; // UNC
  while (s.startsWith('./')) s = s.slice(2);
  const segs = s.split('/');
  if (segs.some((x) => x === '..')) return ''; // 逃出项目
  if (segs.some((x) => x === '')) return ''; // 空段（含结尾斜杠）
  return s;
}

/** 归一化 filesChanged：去重、保序、按上限截断、丢掉不合规的。 */
export function normalizeFilesChanged(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const p = normalizeChangedPath(raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_FILES_CHANGED) break;
  }
  return out;
}

/**
 * 归一化一条 attempt 的关系字段 + P8-A 的审阅字段。**读盘与写盘都要过这里** ——
 * 于是「文件里被手工塞了一个绝对路径」这种情形在进入内存时就被挡掉了，
 * 而不是等到它被回给前端才被发现。
 */
export function normalizeAttempt(raw) {
  const a = isPlainObject(raw) ? { ...raw } : {};
  a.sessionId = isSafeSessionId(a.sessionId) ? a.sessionId : null;
  a.filesChanged = normalizeFilesChanged(a.filesChanged);
  a.changeCaptureIncomplete = Boolean(a.changeCaptureIncomplete);
  /* P8-A：三个新字段，全部 additive —— 老 attempt 缺它们时补成 null / 默认 review，
   * 所以**不需要数据迁移**，P7 及更早的 Plan 照常读取。 */
  a.outcomeStatus = normalizeAttemptOutcome(a.outcomeStatus);
  a.verificationSnapshot = normalizeVerificationSnapshot(a.verificationSnapshot);
  /* P9：Pi GUI 自己独立跑过的验证证据。同样是 additive —— 老 attempt 没有它，
   * 归一化成 null（界面显示「尚未独立确认」），**不需要 migration**。 */
  a.verificationResult = normalizeVerificationResult(a.verificationResult);
  /* P9 收口：这次 attempt 开始时**冻结的工作目录**。
   * 与 verificationSnapshot 同一个理由 —— task.workingDirectory 是可编辑的，
   * 等验证时再读当前值，就等于「用现在的目录去验证过去那次执行」。
   * 老 attempt 没有它 → null，验证时 fallback 到当前 task 值并**如实标记**。 */
  a.workingDirectorySnapshot = normalizeWorkingDirectorySnapshot(a.workingDirectorySnapshot);
  a.review = normalizeReview(a.review);
  return a;
}

/* ==================== P8-A：人工审阅 ====================
 *
 * 一条**不能破**的语义：
 *
 *     执行状态  ≠  人工审阅状态
 *
 * 执行状态（success / failed / cancelled / interrupted）由 Scheduler 写，
 * 是「机器跑出来什么」。审阅状态（pending / accepted / needs_changes）由人写，
 * 是「我认不认这个结果」。两者同时存在、各答一个问题：
 *
 *     execution = success        + review = needs_changes   ← 合法
 *     execution = failed         + review = accepted        ← 必须拒绝
 *
 * 审阅**永远不能**改执行状态：保存 needs_changes 不会触发重试、不会暂停计划、
 * 不会碰 DAG、不会改 task.status、不会调 Agent、不会动 Git。
 */

/** 人工审阅状态。只有这三个 —— 刻意不含 approved / rejected / done / verified。 */
export const REVIEW_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  NEEDS_CHANGES: 'needs_changes',
});

/** 审阅说明的长度上限。后端必须自己校验，不能只依赖前端限制。 */
export const MAX_REVIEW_NOTE = 1000;

/** 一次 attempt 的**稳定**执行结论。P8-A 起写入。 */
export const ATTEMPT_OUTCOME = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
});

const REVIEW_STATUSES = Object.values(REVIEW_STATUS);
const ATTEMPT_OUTCOMES = Object.values(ATTEMPT_OUTCOME);

/**
 * 归一化审阅记录。
 *
 * **宽容**（读盘路径）：非法状态退成 pending、超长说明截断、非法 revision 归 0。
 * 一个坏字段不该让整个计划读不出来。**严格校验在 API 那一侧**（超长直接拒绝），
 * 两者分工不同，别把宽容当成「API 可以不校验」。
 *
 * `pending` 是「清除」的语义，所以归一化时强制把 note / reviewedAt 清掉 ——
 * 否则一条「pending 但带着旧说明」的记录会让人以为还留着什么。
 */
export function normalizeReview(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const status = REVIEW_STATUSES.includes(r.status) ? r.status : REVIEW_STATUS.PENDING;
  if (status === REVIEW_STATUS.PENDING) {
    return { status, note: '', reviewedAt: null, revision: Number.isInteger(r.revision) && r.revision >= 0 ? r.revision : 0 };
  }
  return {
    status,
    note: clampStr(r.note, MAX_REVIEW_NOTE),
    reviewedAt: Number.isFinite(r.reviewedAt) ? r.reviewedAt : null,
    revision: Number.isInteger(r.revision) && r.revision >= 0 ? r.revision : 0,
  };
}

/** 归一化 attempt 的稳定执行结论。认不出的值一律当「未知」（null），不猜。 */
export function normalizeAttemptOutcome(raw) {
  return ATTEMPT_OUTCOMES.includes(raw) ? raw : null;
}

/**
 * 归一化「这次执行开始时，任务要求的 verification 是什么」。
 *
 * ⚠️ **只保留 command / description 两个键。** 绝不把 task.description、完整
 * prompt、plan.goal、模型输出、cwd、model/provider、env 一起复制进来 ——
 * 这个快照会进 plan 文件，可能被贴进 issue（和 diagnostics 同一条隐私规矩）。
 */
export function normalizeVerificationSnapshot(raw) {
  if (typeof raw === 'string') {
    const s = clampStr(raw, 500).trim();
    return s ? { command: s } : null;
  }
  if (!isPlainObject(raw)) return null;
  const command = clampStr(raw.command, 500).trim();
  if (command) return { command };
  const description = clampStr(raw.description, 500).trim();
  if (description) return { description };
  return null;
}

/* ==================== P9：独立验证 ====================
 *
 * 一条与 P8 同级、但**绝不能混**的语义：
 *
 *     要求   verificationSnapshot   这次 Attempt 开始时**要求**验证什么（已冻结）
 *     证据   verificationResult     Pi GUI **后来真的执行过什么**、结果如何
 *
 * 前者是「要求」，后者是「证据」。所以「验证结果」这一行不再固定显示
 * 「尚未独立确认」—— **没跑过**才是那句，**跑过之后**显示机器实际跑出来的东西。
 *
 * 两件事仍然不变：
 *   - 验证通过 **不等于** 人工 accepted —— 人还得自己判断
 *   - 验证失败 **不会** 自动 Retry —— 重试是人的决定
 */

/** 一次独立验证的状态。 */
export const VERIFICATION_STATUS = Object.freeze({
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
});

const VERIFICATION_STATUSES = Object.values(VERIFICATION_STATUS);

/** 实际执行的那条命令的上限 —— 与 verificationSnapshot.command 的 500 对齐：
 *  它本来就是从那儿来的（执行时读的就是那个冻结值）。 */
const MAX_VERIFICATION_COMMAND = 500;

/**
 * 保存下来的输出摘要上限（字符）。
 *
 * ⚠️ **必须小。** 计划是**整份读写**的 JSON 文件，这个字段会进文件 ——
 * 一次 `npm test` 的输出轻松几百 KB，不设上限就是把用户的计划文件撑爆，
 * 而且此后每次 GET 计划详情都要拖着它走。
 * 量级与 attempt.summary(1000) / attempt.error(2000) 一致。
 * 超出时**保留末尾**（失败原因几乎总在最后几行），并置 `truncated`。
 */
export const MAX_VERIFICATION_OUTPUT = 2000;

/** 验证自身的错误信息（启动失败 / 超时 / 被取消）上限。 */
const MAX_VERIFICATION_ERROR = 500;

/**
 * 工作目录快照的长度上限 —— 与 filesChanged 里的路径同量级。
 * 只存**项目相对路径**：绝对路径随项目搬走就失真，而且不该进元数据。
 */
const MAX_WORKDIR = 400;

/**
 * 这次验证用的是**哪个**工作目录 —— 两种来源的证据强度不一样，必须分开记。
 *
 *   attempt-snapshot          那次 attempt 开始时冻结的目录（P9 收口后的正常路径）
 *   current-task-fallback     老 attempt 没有快照，退而用**当前** task.workingDirectory
 *
 * 前者是「我当时在哪儿跑的」，后者是「我现在猜它当初在哪儿跑的」。
 * 界面上必须把这两种说成两件事 —— 不要让 fallback 看起来和冻结快照一样可靠。
 */
export const WORKDIR_SOURCE = Object.freeze({
  SNAPSHOT: 'attempt-snapshot',
  FALLBACK: 'current-task-fallback',
});

const WORKDIR_SOURCES = Object.values(WORKDIR_SOURCE);

/**
 * 归一化「这次 attempt 开始时冻结的工作目录」。
 *
 * **只做形状归一，不做安全判定** —— 绝对路径、`../` 逃逸这类值**原样留着**，
 * 交给 Verifier 用 `lib/safe-path.js` 去拒绝。
 *
 * 为什么不在这里「顺手清洗」成 null：那会让一个被改坏的值**静默退化成 fallback**，
 * 于是验证跑到「当前」目录里去，而界面还显示一切正常。
 * 宁可让下游明确报 `invalid-cwd`（宁可吵，不可静默跑到别处）。
 *
 * 正常路径不会产生这种值：`task.workingDirectory` 在 normalizeTask 里已经被
 * 校验成「项目相对 + 存在」了。会出现脏值的只有手工改过的计划文件。
 */
export function normalizeWorkingDirectorySnapshot(raw) {
  if (typeof raw !== 'string') return null;
  const s = clampStr(raw, MAX_WORKDIR).trim();
  return s || null;
}

/**
 * 归一化一条独立验证记录。
 *
 * **宽容**（读盘路径）：认不出的 `status` 一律当「没有这条记录」（null），
 * **不猜** —— 与 `normalizeAttemptOutcome` 的「未知就是 null」同一条规矩。
 * 严格校验（能不能跑、跑哪条命令）在 API 与 Verifier 那一侧。
 *
 * `running` 是**会落盘**的：硬崩时它会留在文件里，由进程启动时的 `recoverAll()`
 * 翻成 `interrupted`（与 `task.status` 的 running 同一套处理，理由见 store.js
 * 里「每次 load 都恢复」那个坑的注释）。
 */
export function normalizeVerificationResult(raw) {
  if (!isPlainObject(raw)) return null;
  const status = VERIFICATION_STATUSES.includes(raw.status) ? raw.status : null;
  if (!status) return null;
  const running = status === VERIFICATION_STATUS.RUNNING;
  return {
    status,
    command: clampStr(raw.command, MAX_VERIFICATION_COMMAND),
    /* 实际执行所在的目录（项目相对路径）与它的来源。
     * 这两个是**开始时就知道**的设定事实，不是结论 —— 所以 running 也保留。 */
    workingDirectory: clampStr(raw.workingDirectory, MAX_WORKDIR),
    workingDirectorySource: WORKDIR_SOURCES.includes(raw.workingDirectorySource) ? raw.workingDirectorySource : null,
    /* 运行中的记录**不该带结论字段**（退出码 / 完成时间 / 耗时 / 输出 / 错误）——
     * 归一化时一律清掉，否则会出现「状态是运行中、却挂着上一次的退出码与输出」
     * 这种自相矛盾的展示（与 normalizeReview 对 pending 的处理同一条思路）。 */
    exitCode: running ? null : Number.isInteger(raw.exitCode) ? raw.exitCode : null,
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
    finishedAt: running ? null : Number.isFinite(raw.finishedAt) ? raw.finishedAt : null,
    durationMs: running ? null : Number.isFinite(raw.durationMs) ? raw.durationMs : null,
    outputSummary: running ? '' : clampStr(raw.outputSummary, MAX_VERIFICATION_OUTPUT),
    truncated: running ? false : Boolean(raw.truncated),
    error: running ? '' : clampStr(raw.error, MAX_VERIFICATION_ERROR),
  };
}

/**
 * 这条 attempt 能不能被人工审阅（写入 pending / accepted / needs_changes）。
 *
 * **纯函数，只看 attempt 自己的持久化字段**：
 *   - `outcomeStatus`（P8-A 起写入，稳定）
 *   - `success`（P7 及更早就有的布尔）
 *
 * 两条禁令（都是规格点名的）：
 *   1. **绝不看 task 的当前状态。** 「Attempt 1 failed、Attempt 2 success」时
 *      task 当前是 success，但这不能推出「Attempt 1 可以接受」——
 *      资格必须来自目标 attempt 自己的历史结论。
 *   2. **绝不从 error 文案猜。** `if (error.includes('取消'))` 那种写法把业务语义
 *      建在了给人看的字符串上，改一次文案就静默失效。
 *
 * 老 attempt 没有 outcomeStatus 时退到 `success` 布尔：它足以回答「成功还是不是」，
 * 而 failed / cancelled / interrupted 三种的审阅资格本来就完全相同（都不可接受），
 * 所以不需要区分它们就能正确判定。
 */
export function canReviewAttempt(attempt) {
  if (!isPlainObject(attempt)) return { ok: false, error: '找不到这次尝试' };
  return { ok: true };
}

/** 只有**执行成功**的尝试才允许标记「已接受」。 */
export function canAcceptAttempt(attempt) {
  if (!isPlainObject(attempt)) return false;
  if (attempt.outcomeStatus) return attempt.outcomeStatus === ATTEMPT_OUTCOME.SUCCESS;
  return attempt.success === true;
}

/** 任何已结束的尝试都可以标记「需修改」——包括失败、取消、被中断的。 */
export function canMarkNeedsChanges(attempt) {
  return isPlainObject(attempt);
}

/**
 * 写审阅前的总闸：目标状态在这一刻合不合法。
 * @returns {{ok:true}|{ok:false, error:string}}
 */
export function reviewWriteAllowed(attempt, status) {
  if (!isPlainObject(attempt)) return { ok: false, error: '找不到这次尝试' };
  if (status === REVIEW_STATUS.PENDING) return { ok: true }; // 清除判断永远允许
  if (status === REVIEW_STATUS.ACCEPTED) {
    return canAcceptAttempt(attempt)
      ? { ok: true }
      : { ok: false, error: '这次执行没有成功，不能标记为「已接受」（可以标记「需修改」）' };
  }
  if (status === REVIEW_STATUS.NEEDS_CHANGES) {
    return canMarkNeedsChanges(attempt) ? { ok: true } : { ok: false, error: '这次尝试不能标记「需修改」' };
  }
  return { ok: false, error: '审阅状态只能是 pending / accepted / needs_changes' };
}

/**
 * 校验依赖图。**这是执行前的最后一道闸**（规格 §5）。
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateGraph(tasks) {
  const errors = [];
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, errors: ['计划里没有任何任务'] };
  }
  const ids = new Set();
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || !t.id) {
      errors.push('存在没有 id 的任务');
      continue;
    }
    if (ids.has(t.id)) errors.push(`任务 id 重复：${t.id}`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    if (!t || !Array.isArray(t.dependsOn)) continue;
    for (const d of t.dependsOn) {
      if (d === t.id) errors.push(`任务 ${t.id} 依赖自己`);
      else if (!ids.has(d)) errors.push(`任务 ${t.id} 依赖了不存在的任务：${d}`);
    }
  }
  // 环检测：DFS 三色法，报出具体环路径，便于用户定位
  const color = new Map(); // 0 未访问 1 在栈上 2 完成
  const stack = [];
  const adj = new Map(tasks.filter((t) => t && t.id).map((t) => [t.id, (t.dependsOn || []).filter((d) => ids.has(d))]));
  let cycle = null;
  const dfs = (id) => {
    if (cycle) return;
    color.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) || []) {
      if (cycle) return;
      const c = color.get(next) || 0;
      if (c === 1) {
        const at = stack.indexOf(next);
        cycle = [...stack.slice(at), next];
        return;
      }
      if (c === 0) dfs(next);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const t of tasks) {
    if (t && t.id && (color.get(t.id) || 0) === 0) dfs(t.id);
    if (cycle) break;
  }
  if (cycle) errors.push(`依赖成环：${cycle.join(' → ')}`);

  // 至少一个 root（没有依赖的任务），否则谁也起不来
  const roots = tasks.filter((t) => t && Array.isArray(t.dependsOn) && t.dependsOn.length === 0);
  if (tasks.length > 0 && roots.length === 0) errors.push('没有任何无依赖的任务（没有入口，无法开始执行）');

  return { ok: errors.length === 0, errors };
}

/** 归一化一个 task。`agentIds` 用来挡「模型编了一个不存在的 agent」（规格 §33）。 */
export function normalizeTask(raw, { index = 0, agentIds = [], projectRoot = null } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['任务不是对象'], warnings };

  const id = clampStr(raw.id, 120).trim() || `task-${index + 1}`;
  const title = clampStr(raw.title, MAX_TITLE).trim() || id;
  const description = clampStr(raw.description, MAX_DESCRIPTION);

  let agent = typeof raw.agent === 'string' && raw.agent.trim() ? raw.agent.trim() : 'auto';
  if (agent !== 'auto' && agentIds.length && !agentIds.includes(agent)) {
    errors.push(`任务 ${id} 指定了未知的 agent：${agent}`);
  }

  const dependsOn = Array.isArray(raw.dependsOn)
    ? raw.dependsOn.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim())
    : [];
  const uniqueDeps = [...new Set(dependsOn)];
  if (uniqueDeps.length !== dependsOn.length) warnings.push(`任务 ${id} 的 dependsOn 里有重复项，已去重`);

  // workingDirectory：默认 '.'；必须相对、必须在项目内、必须已存在
  const rawWd = typeof raw.workingDirectory === 'string' && raw.workingDirectory.trim() ? raw.workingDirectory.trim() : '.';
  let workingDirectory = '.';
  if (projectRoot) {
    const resolved = resolveProjectPath(projectRoot, rawWd);
    if (!resolved.ok) {
      errors.push(`任务 ${id} 的工作目录不可用（${rawWd}）：${resolved.error}`);
    } else {
      workingDirectory = resolved.rel ? resolved.rel.split(path.sep).join('/') : '.';
    }
  } else if (rawWd !== '.') {
    workingDirectory = rawWd;
  }

  /* verification（规格 §43）：只**保存描述**，Pi GUI 绝不自己去 shell 执行它。
   * 它会被拼进 task 的 instruction 交给 Agent 执行 —— 因为「谁执行」这件事
   * 必须只有一个答案，两个地方都能跑命令等于多开一个没人管的执行面。 */
  let verification = null;
  if (typeof raw.verification === 'string' && raw.verification.trim()) {
    verification = { command: clampStr(raw.verification, 500).trim() };
  } else if (isPlainObject(raw.verification)) {
    const cmd = clampStr(raw.verification.command, 500).trim();
    const desc = clampStr(raw.verification.description, 500).trim();
    if (cmd) verification = { command: cmd };
    else if (desc) verification = { description: desc };
  }

  const task = {
    id,
    title,
    description,
    agent,
    workingDirectory,
    dependsOn: uniqueDeps,
    status: TASK_STATUS.PENDING,
    startedAt: null,
    endedAt: null,
    attempt: 0,
    attempts: [],
    result: null,
    error: '',
    verification,
  };
  return { ok: errors.length === 0, task, errors, warnings };
}

/**
 * 归一化一个 plan。**Planner 的输出必须从这里过**（规格 §7/§33）。
 * @returns {{ok:boolean, plan:object|null, errors:string[], warnings:string[]}}
 */
export function normalizePlan(raw, { agentIds = [], projectRoot = null, now = Date.now() } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) return { ok: false, plan: null, errors: ['计划不是对象'], warnings };

  const title = clampStr(raw.title, MAX_TITLE).trim() || '未命名计划';
  const goal = clampStr(raw.goal, MAX_GOAL).trim();

  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  if (rawTasks.length === 0) errors.push('计划里没有任何任务');
  if (rawTasks.length > MAX_TASKS) errors.push(`任务数超过上限 ${MAX_TASKS}（拆得太碎反而不如少几个大任务）`);

  const tasks = [];
  rawTasks.slice(0, MAX_TASKS).forEach((t, i) => {
    const r = normalizeTask(t, { index: i, agentIds, projectRoot });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (r.task) tasks.push(r.task);
  });

  const graph = validateGraph(tasks);
  // validateGraph 也会报「没有任务」，这里去重，避免同一句话说两遍
  for (const e of graph.errors) if (!errors.includes(e)) errors.push(e);

  if (errors.length) return { ok: false, plan: null, errors, warnings };

  const plan = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newPlanId(now),
    title,
    goal,
    status: PLAN_STATUS.READY,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: null,
    projectRoot: projectRoot || null,
    concurrency: DEFAULT_CONCURRENCY,
    tasks,
    /** 原始 Planner 输出留档 —— 生成失败时给用户看「模型到底说了什么」（规格 §33） */
    source: typeof raw.source === 'string' ? raw.source.slice(0, 20000) : null,
  };
  return { ok: true, plan, errors, warnings };
}

/** 拓扑序（同层按数组顺序），供串行调度使用。 */
export function topoOrder(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = [];
  const visited = new Set();
  const visit = (t) => {
    if (visited.has(t.id)) return;
    visited.add(t.id);
    for (const d of t.dependsOn) {
      const dep = byId.get(d);
      if (dep) visit(dep);
    }
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return out;
}

/**
 * 按依赖结果算出每个非终态 task 应该是什么状态。
 *
 * 规则（规格 §16 / §26）：
 *   - 依赖全部 success → ready
 *   - 任一依赖 failed / cancelled / interrupted / skipped → blocked
 *     （**跳过不会自动放行依赖者**，用户要自己改依赖 —— 规格 §26 明确要求）
 *   - 依赖还没结论 → pending
 *
 * @returns {Map<string,string>} id → 建议状态（只包含当前处于 pending/blocked/ready 的 task）
 */
export function computeReadyStates(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map();
  for (const t of tasks) {
    if (TERMINAL_TASK_STATUS.includes(t.status) || t.status === TASK_STATUS.RUNNING) continue;
    let ready = true;
    let blocked = false;
    for (const d of t.dependsOn) {
      const dep = byId.get(d);
      if (!dep) {
        blocked = true;
        break;
      }
      if (dep.status === TASK_STATUS.SUCCESS) continue;
      if (TERMINAL_TASK_STATUS.includes(dep.status)) {
        blocked = true;
        break;
      }
      ready = false; // 依赖还没跑完
    }
    out.set(t.id, blocked ? TASK_STATUS.BLOCKED : ready ? TASK_STATUS.READY : TASK_STATUS.PENDING);
  }
  return out;
}

/** Plan 是否已经跑完（所有 task 都是终态）。 */
export function isPlanSettled(plan) {
  return plan.tasks.every((t) => TERMINAL_TASK_STATUS.includes(t.status));
}

/** 汇总：有没有失败 / 有没有被取消。用于决定 plan 的终态。 */
export function summarizePlan(plan) {
  const failed = plan.tasks.filter((t) => t.status === TASK_STATUS.FAILED || t.status === TASK_STATUS.INTERRUPTED).length;
  const cancelled = plan.tasks.filter((t) => t.status === TASK_STATUS.CANCELLED).length;
  const skipped = plan.tasks.filter((t) => t.status === TASK_STATUS.SKIPPED).length;
  const success = plan.tasks.filter((t) => t.status === TASK_STATUS.SUCCESS).length;
  return { total: plan.tasks.length, success, failed, cancelled, skipped };
}

/**
 * 组装交给 Agent 的 prompt（规格 §43：verification 作为 instruction 的一部分，
 * 由 Agent 执行，不由 Pi GUI 执行）。
 */
export function buildTaskPrompt(plan, task) {
  const lines = [];
  lines.push(`# 任务：${task.title}`);
  lines.push('');
  if (plan.goal) {
    lines.push(`整体目标：${plan.goal}`);
    lines.push('');
  }
  if (task.description) {
    lines.push(task.description);
    lines.push('');
  }
  lines.push(`工作目录：${task.workingDirectory === '.' ? '项目根目录' : task.workingDirectory}`);
  const deps = task.dependsOn.map((d) => {
    const t = plan.tasks.find((x) => x.id === d);
    return t ? `${t.title}（${t.status}）` : d;
  });
  if (deps.length) {
    // 不写「已完成」——这个函数在 task 真正开跑前也会被调用来预览 prompt，
    // 那时依赖其实还没跑，写成「已完成」就是在撒谎。
    lines.push(`前置任务（本任务开始前应已结束）：${deps.join('；')}`);
  }
  if (task.verification) {
    const v = task.verification.command || task.verification.description;
    lines.push('');
    lines.push(`完成后请验证：${v}`);
  }
  lines.push('');
  lines.push('请只完成上面这一件事，不要顺手改动无关文件，不要执行 git commit / git push。');
  return lines.join('\n');
}
