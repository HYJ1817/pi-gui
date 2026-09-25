/* Plan 持久化 + 崩溃恢复（规格 §28–§32）。
 *
 * ---------- 为什么存在 Pi GUI 自己的数据目录，而不是项目仓库 ----------
 *
 * 位置：`<PI_GUI_DATA>/plans/<planId>.json`。
 *
 * 执行历史属于**本地运行状态**，不是项目内容。写进项目仓库意味着：
 * 每次跑计划都会弄脏用户的 git working tree、可能被误提交、
 * 而且同一个项目在不同机器上会带着别人的执行记录。所以刻意分开。
 *
 * 也**刻意不放进 `.pi-gui/config.json`**（规格 §29）：Project Config 是
 * 「这个项目希望用什么」的偏好，Plan 是「某一次执行」的实例。两者生命周期
 * 完全不同 —— 偏好是长期稳定的，执行实例会不断新增。混在一个文件里，
 * 一个是几十字节的偏好、一个是几百 KB 的执行历史，读写和原子性都会互相拖累。
 *
 * ---------- 写盘策略（规格 §30） ----------
 *
 * 只在**状态真的变了**的时候写：task 状态变化、attempt 起止、plan 状态变化。
 * 不按 token 写 —— agent 每吐一个字都落盘，一次任务就能写出几万次磁盘操作。
 * 写盘一律 `临时文件 → rename`，所以任何时候断电都不会读到半个 JSON。
 *
 * ---------- 崩溃恢复（规格 §31） ----------
 *
 * App 重开时如果看到 `task.status === 'running'`，**原进程已经不存在了**。
 * 这时候继续显示「运行中」是撒谎，用户会一直等一个永远不会来的结果。
 * 所以加载时统一把它翻成 `interrupted`，并在 plan 上留一条说明 ——
 * 用户看到的是「上次被中断了，可以重试」，而不是一个卡死的转圈。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PLAN_STATUS, TASK_STATUS, TERMINAL_PLAN_STATUS, TERMINAL_TASK_STATUS, summarizePlan } from './model.js';

/** plan 文件的格式版本。格式一变就把旧文件当不认识的，避免半读半猜。 */
export const PLAN_SCHEMA_VERSION = 1;

/** 归一化路径用于比较（Windows 大小写不敏感）。 */
function normRoot(p) {
  if (!p) return '';
  const r = path.resolve(String(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function createPlanStore({ dataDir, maxPlans = 500 } = {}) {
  if (!dataDir) throw new Error('createPlanStore 需要 dataDir');
  const dir = path.join(dataDir, 'plans');

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function fileOf(id) {
    // id 只可能是我们自己生成的（plan-xxx）或校验过的字符串，这里再挡一层
    const safe = String(id || '').replace(/[^A-Za-z0-9._-]/g, '');
    if (!safe) throw new Error('非法的 plan id');
    return path.join(dir, `${safe}.json`);
  }

  /** 原子写：临时文件 → rename。任何失败都不会留下半个文件。 */
  function save(plan) {
    ensureDir();
    const file = fileOf(plan.id);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const payload = { schemaVersion: PLAN_SCHEMA_VERSION, ...plan, updatedAt: Date.now() };
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件可能根本没建出来 */
      }
      throw err;
    }
    return payload;
  }

  /**
   * 把盘上读到的对象修成可用的 plan。
   *
   * ⚠️ **`recover` 默认 false，这一点是踩过坑的。**
   *
   * 最初写成「每次 load 都做崩溃恢复」，结果前端轮询 `GET /api/plans/:id` 时
   * 把**正在运行**的任务翻成了 `interrupted` —— 因为「看到 running」既可能是
   * 「上个进程死了」，也可能是「本进程正在跑」，光看文件分不出来。
   * 崩溃恢复是**进程启动时**的一次性动作（见 recoverAll），不是读操作的一部分。
   */
  function revive(raw, { recover = false } = {}) {
    const plan = { ...raw };
    const notes = [];
    let recovered = false;

    if (raw.schemaVersion !== PLAN_SCHEMA_VERSION) {
      notes.push(`计划文件格式版本是 ${raw.schemaVersion}，当前支持 ${PLAN_SCHEMA_VERSION}`);
    }
    if (!Array.isArray(plan.tasks)) plan.tasks = [];
    plan.tasks = plan.tasks.map((t) => ({
      ...t,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
      attempts: Array.isArray(t.attempts) ? t.attempts : [],
      attempt: Number.isFinite(t.attempt) ? t.attempt : 0,
      error: typeof t.error === 'string' ? t.error : '',
      result: t.result ?? null,
    }));

    if (recover) {
      /* 上次进程死的时候还在 running 的 task，原进程已经没了。 */
      for (const t of plan.tasks) {
        if (t.status === TASK_STATUS.RUNNING) {
          t.status = TASK_STATUS.INTERRUPTED;
          t.endedAt = t.endedAt || Date.now();
          t.error = t.error || '上一次运行被中断（应用已重启，原进程不存在了）';
          recovered = true;
        }
      }
      if (plan.status === PLAN_STATUS.RUNNING) {
        // 还有活可干 → 暂停等用户决定；全跑完了 → 直接落终态
        const settled = plan.tasks.every((t) => TERMINAL_TASK_STATUS.includes(t.status));
        plan.status = settled ? statusFromTasks(plan) : PLAN_STATUS.PAUSED;
        recovered = true;
      }
      if (recovered) {
        const s = summarizePlan(plan);
        notes.push(`上次运行被中断：${s.failed} 个任务需要重试`);
      }
    }
    /* 保留已经持久化的恢复说明。
     * 早先这里直接 `plan.recoveryNotes = notes`，于是 recover=false 的普通读取
     * 会把上次恢复时写下的说明**覆盖成空数组** —— 「为什么这个计划被标成中断」
     * 这条信息在重启后的第一次读取就消失了。 */
    const persisted = Array.isArray(raw.recoveryNotes) ? raw.recoveryNotes : [];
    plan.recoveryNotes = [...new Set([...persisted, ...notes])];
    return { plan, recovered, notes };
  }

  /** 全部终态时该给 plan 什么状态。
   *  注意：**「有成功也有取消」算 completed，不算 cancelled** ——
   *  用户中途停掉但已经干完一半，报成「已取消」会让他以为白跑了。 */
  function statusFromTasks(plan) {
    const s = summarizePlan(plan);
    if (s.failed > 0) return PLAN_STATUS.FAILED;
    if (s.cancelled > 0 && s.success === 0) return PLAN_STATUS.CANCELLED;
    return PLAN_STATUS.COMPLETED;
  }

  function readFileSafe(file) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: '文件内容不是一个 JSON 对象' };
      }
      return { raw: parsed };
    } catch (err) {
      return { error: err && err.code === 'ENOENT' ? '文件不存在' : `读不出来：${err.message}` };
    }
  }

  /**
   * 列出计划。
   * @param projectRoot 只列这个项目的（规格 §35「不同项目隔离」）。不传则列全部。
   *
   * 注意这里**不做崩溃恢复**（原因见 revive 的说明）—— 恢复只在启动时做一次。
   */
  function list({ projectRoot = null, limit = maxPlans } = {}) {
    const out = [];
    const broken = [];
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      if (err && err.code === 'ENOENT') return { plans: [], broken: [] };
      return { plans: [], broken: [{ file: dir, error: `目录读不出来：${err.message}` }] };
    }

    const want = normRoot(projectRoot);
    for (const f of files) {
      const full = path.join(dir, f);
      const r = readFileSafe(full);
      if (r.error) {
        // 一个坏文件不能拖垮整个列表（规格 §33）
        broken.push({ file: f, error: r.error });
        continue;
      }
      const { plan } = revive(r.raw);
      if (want && normRoot(plan.projectRoot) !== want) continue;
      out.push(plan);
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { plans: out.slice(0, limit), broken };
  }

  function load(id) {
    const r = readFileSafe(fileOf(id));
    if (r.error) return null;
    const { plan, notes } = revive(r.raw);
    return { plan, recovered: false, notes };
  }

  /**
   * **进程启动时调用一次**：把所有「上次进程死时还在 running」的计划恢复成
   * interrupted。这是崩溃恢复的唯一入口（规格 §31）。
   * @returns {{scanned:number, recovered:number}}
   */
  function recoverAll() {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return { scanned: 0, recovered: 0 };
    }
    let recovered = 0;
    for (const f of files) {
      const full = path.join(dir, f);
      const r = readFileSafe(full);
      if (r.error) continue;
      const res = revive(r.raw, { recover: true });
      if (!res.recovered) continue;
      try {
        save(res.plan);
        recovered++;
      } catch {
        /* 写不进去就下次再说 */
      }
    }
    return { scanned: files.length, recovered };
  }

  function remove(id) {
    try {
      fs.unlinkSync(fileOf(id));
      return true;
    } catch {
      return false;
    }
  }

  /** 摘要（列表接口用，不带 tasks 明细，省带宽）。 */
  function summary(plan) {
    const s = summarizePlan(plan);
    return {
      id: plan.id,
      title: plan.title,
      goal: plan.goal,
      status: plan.status,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      startedAt: plan.startedAt,
      endedAt: plan.endedAt,
      projectRoot: plan.projectRoot,
      counts: s,
      recoveryNotes: plan.recoveryNotes || [],
    };
  }

  return { dir, save, load, list, remove, summary, revive, recoverAll, statusFromTasks, _fileOf: fileOf };
}

/** 让外部能判断「这个 plan 是不是已经结束了」。 */
export function isTerminalPlanStatus(status) {
  return TERMINAL_PLAN_STATUS.includes(status);
}
