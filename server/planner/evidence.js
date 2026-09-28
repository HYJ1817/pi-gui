/* P10：把「两棵树之间的 diff」变成 attempt 上那份**冻结的变更证据**。
 *
 * 纯函数：不碰磁盘、不跑 git —— 所以整条组装路径都能被单测。
 * 跑 git 的部分在 `lib/git.js`（worktreeTree / treeDiff / treeNumstat），
 * 由 server.js 注入进来（`server/` 下的模块不互相 import）。
 *
 * ---------- 两条来源，各管一半 ----------
 *
 *   numstat（NUL 分隔）  权威的**文件列表** + 增删行数 + binary 标记
 *   diff 文本            每个文件的 **patch 内容** + change 类型 + rename 的另一半
 *
 * 为什么不只用 diff 文本：它被字节上限截断时，**尾巴上的文件就完全消失了**，
 * 而「哪些文件变了」是这份证据最基本的部分，不能因为排后面就丢掉。
 * numstat 很小，几乎不会被截断。
 */

import {
  CHANGE_EVIDENCE_STATUS,
  CHANGE_KIND,
  MAX_EVIDENCE_FILE_PATCH,
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_TOTAL_PATCH,
} from './model.js';

/**
 * 把 unified diff 文本按文件切开。
 *
 * ---------- 两个实测出来的细节（别想当然） ----------
 *
 * 1. **不从 `diff --git a/x b/y` 那一行取路径**：带空格的文件名在那里有歧义。
 *    改从 `--- `/`+++ `/`rename from|to` 取 —— 那些行「整行就是路径」。
 * 2. **`--- `/`+++ ` 行末尾可能带一个 TAB**：文件路径含空格时 git 用它消歧
 *    （实测 `--- a/src/a b.js\t`）。必须剥掉，否则路径里会多一个制表符。
 *
 * 切块的判据是行首正好是 `diff --git `：patch 的内容行一定带 ' ' / '+' / '-' / '\'
 * 前缀，所以内容里不可能出现「行首恰好是 diff --git 」。
 *
 * @returns Map<新路径, {change, oldPath, binary, patch}>
 */
export function splitUnifiedDiff(text) {
  const out = new Map();
  const src = String(text || '');
  const chunks = src.split(/^diff --git /m);
  for (let i = 1; i < chunks.length; i++) {
    const body = chunks[i];
    const patch = 'diff --git ' + body;
    /* 末尾的 TAB 是 git 给「路径里有空格」加的分隔符，不是路径的一部分。 */
    const clean = (p) => String(p || '').replace(/\t+$/, '').trim();
    const stripA = (p) => (p.startsWith('a/') ? p.slice(2) : p);
    const stripB = (p) => (p.startsWith('b/') ? p.slice(2) : p);

    const fromM = /^rename from (.*)$/m.exec(body);
    const toM = /^rename to (.*)$/m.exec(body);
    let path = '';
    let oldPath = null;
    let change = CHANGE_KIND.MODIFIED;
    if (fromM && toM) {
      change = CHANGE_KIND.RENAMED;
      oldPath = clean(fromM[1]);
      path = clean(toM[1]);
    } else {
      const minusM = /^--- (.*)$/m.exec(body);
      const plusM = /^\+\+\+ (.*)$/m.exec(body);
      const minus = clean(minusM ? minusM[1] : '');
      const plus = clean(plusM ? plusM[1] : '');
      if (plus === '/dev/null') {
        change = CHANGE_KIND.DELETED;
        path = stripA(minus);
      } else if (minus === '/dev/null') {
        change = CHANGE_KIND.ADDED;
        path = stripB(plus);
      } else {
        path = stripB(plus) || stripA(minus);
        /* 二进制 diff **没有** `---`/`+++`（git 只给一句 `Binary files … differ`），
         * 所以上面两条都取不到路径。这时退回块自己的第一行 —— 切块时已经剥掉了
         * `diff --git ` 前缀，所以它长这样：`a/bin.png b/bin.png`。
         * 只在**两边路径相同**时才用（带空格的路径在那里有歧义；文件列表的权威
         * 来源始终是 numstat，这里兜底只是让纯解析也能认出二进制块）。 */
        if (!path) {
          const gm = /^a\/(.*) b\/(.*)$/m.exec(body);
          if (gm && gm[1] === gm[2]) path = gm[1];
        }
      }
    }
    if (!path) continue;
    out.set(path, { change, oldPath, binary: /^Binary files .* differ$/m.test(body), patch });
  }
  return out;
}

/**
 * 组装 `changeEvidence`。
 *
 * @param stats        normalize… 之前的那份 numstat Map（path → {add, del}），
 *                     binary 的行数是 null
 * @param diffText     两棵树之间的 unified diff 文本
 * @param meta         { capturedAt, allowEmpty, reason, diffTruncated }
 *                     `reason` 是「为什么没采到」（非空时直接给 unavailable）
 *
 * @returns changeEvidence 对象（**未归一化**，交给 model.normalizeChangeEvidence 收口；
 *          这里也按上限切一遍，是为了别先把几百 KB 塞进内存再丢）
 */
export function buildChangeEvidence({ stats = new Map(), diffText = '', meta = {} } = {}) {
  const capturedAt = Number.isFinite(meta.capturedAt) ? meta.capturedAt : null;
  /* 采集失败（不是 git 仓库 / git 不可用 / 超时 / 树建不出来）→ 如实说采不到。
   * 这不是任务失败（§十三）：执行结果与证据采集是两件事。 */
  if (meta.reason) {
    return { status: CHANGE_EVIDENCE_STATUS.UNAVAILABLE, capturedAt, files: [], truncated: false, note: String(meta.reason).slice(0, 500) };
  }

  const byPath = splitUnifiedDiff(diffText);
  const renameOld = new Set();
  for (const info of byPath.values()) if (info.oldPath) renameOld.add(info.oldPath);

  const files = [];
  let truncated = Boolean(meta.diffTruncated);
  let budget = MAX_EVIDENCE_TOTAL_PATCH;
  let dropped = 0;

  for (const [path, st] of stats) {
    /* rename 在 numstat 里是**两条记录**（新旧各一条，统计相同）——
     * 只保留新的那条，旧的由 `oldPath` 表达。 */
    if (renameOld.has(path)) continue;
    if (files.length >= MAX_EVIDENCE_FILES) {
      dropped++;
      truncated = true;
      continue;
    }
    const info = byPath.get(path) || null;
    let patch = info ? info.patch : '';
    let cut = false;
    if (patch.length > MAX_EVIDENCE_FILE_PATCH) {
      patch = patch.slice(0, MAX_EVIDENCE_FILE_PATCH);
      cut = true;
    }
    if (patch.length > budget) {
      patch = patch.slice(0, Math.max(0, budget));
      cut = true;
    }
    budget -= patch.length;
    /* 有统计、但 diff 文本里没有它（原始 diff 被字节上限截断）—— 也要如实标出来，
     * 不能悄悄给它一个空 patch 假装「这个文件没有内容变化」。 */
    const missingPatch = !info && !(st && st.add === null);
    if (cut || missingPatch) truncated = true;
    files.push({
      path,
      change: info ? info.change : CHANGE_KIND.MODIFIED,
      oldPath: info ? info.oldPath : null,
      /* binary 以 numstat 为准（`-` 就是二进制），diff 里那句提示作补充。 */
      binary: Boolean(st && st.add === null) || Boolean(info && info.binary),
      additions: st && Number.isInteger(st.add) ? st.add : null,
      deletions: st && Number.isInteger(st.del) ? st.del : null,
      patch,
      truncated: cut || missingPatch,
    });
  }

  const note = [];
  if (meta.extraNote) note.push(String(meta.extraNote));
  if (dropped) note.push(`变更文件超过 ${MAX_EVIDENCE_FILES} 个，只保留了前 ${MAX_EVIDENCE_FILES} 个`);
  if (truncated) note.push('部分 diff 已截断');
  if (!files.length && !meta.allowEmpty) note.push('执行期间未观察到文件变化');

  return {
    status: truncated ? CHANGE_EVIDENCE_STATUS.PARTIAL : CHANGE_EVIDENCE_STATUS.AVAILABLE,
    capturedAt,
    files,
    truncated,
    note: note.join('；').slice(0, 500),
  };
}

/**
 * 采集一次 attempt 的变更证据：**执行后的工作区** vs 执行前那棵树。
 *
 * 三步：post tree → numstat（权威文件列表）→ diff（patch 内容）。
 * **任何一步失败都不抛**，而是给出一份如实说明「采不到什么、为什么」的证据 ——
 * 证据采集失败绝不能变成任务失败（§十三）。
 *
 * @param preTree   执行前那棵树的 SHA（没采到就是 null）
 * @param preReason preTree 为空时「为什么没采到」
 */
export async function captureEvidence(gitEvidence, projectRoot, { preTree = null, preReason = '', capturedAt = Date.now() } = {}) {
  if (!gitEvidence || typeof gitEvidence.worktreeTree !== 'function') {
    return buildChangeEvidence({ meta: { reason: '没有接入 Git 证据采集', capturedAt } });
  }
  if (!preTree) {
    return buildChangeEvidence({ meta: { reason: preReason || '无法采集执行前的工作区状态', capturedAt } });
  }
  let post;
  try {
    post = await gitEvidence.worktreeTree(projectRoot);
  } catch (err) {
    post = { ok: false, reason: String((err && err.message) || err) };
  }
  if (!post.ok) {
    return buildChangeEvidence({ meta: { reason: `无法采集执行后的工作区状态（${post.reason}）`, capturedAt } });
  }
  let ns = null;
  let df = null;
  try {
    [ns, df] = await Promise.all([
      gitEvidence.treeNumstat(projectRoot, preTree, post.tree),
      gitEvidence.treeDiff(projectRoot, preTree, post.tree),
    ]);
  } catch {
    /* 下面按 null 处理成「采不到」 */
  }
  if (!ns || !ns.ok) {
    return buildChangeEvidence({ meta: { reason: `无法计算执行前后的差异（${(ns && ns.reason) || 'diff 失败'}）`, capturedAt } });
  }
  return buildChangeEvidence({
    stats: ns.stats,
    diffText: df && df.ok ? df.text : '',
    meta: {
      capturedAt,
      diffTruncated: Boolean(df && df.truncated),
      extraNote: df && !df.ok ? '无法读取 diff 内容，只保留了文件列表' : '',
      allowEmpty: true,
    },
  });
}
