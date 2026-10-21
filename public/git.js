/* 文件变更面板（Changed Files → Unified Diff → 撤销 / 打开）。
 *
 * ---------- 与 changes.js 的分工（需求明确要求，不要混） ----------
 *
 *   changes.js  = **Agent 事件账本**。这次会话里 Agent 声称改过哪些文件，
 *                 由 pi 的工具事件驱动，随会话清空。它回答的是「Agent 动了什么」。
 *   S.changes   = **Git 工作区状态**。由 `git status` 得到，是磁盘上的客观事实，
 *                 与本次会话无关（用户自己改的文件也在里面）。它回答的是
 *                 「磁盘上现在是什么样」。
 *
 * 两者会不一致，而且**以 Git 为准**：Agent 改了又自己撤回、或者用户手动
 * revert，账本还留着记录而工作区已经干净了。所以：
 *   - 侧栏徽标（Changes N）**永远**是 Git 的总数，不受任何过滤影响；
 *   - 账本只用来给列表加一个「本会话」标记，以及「仅本次会话」这个视角。
 *
 * 依赖方向：tools.js → git.js → changes.js。这条边是单向的、不成环
 * （changes.js 不 import 任何业务模块，它只认工具名和参数），
 * 所以这里可以放心引账本。
 *
 * ---------- 这一版刻意不做的事 ----------
 *   不做代码编辑器（打开文件交给系统默认程序）、不做 side-by-side、不做
 *   merge conflict 编辑、不做 commit/push/branch。定位是
 *   Coding Agent Workspace 的「看到改了什么 → 决定留还是撤」，不是 IDE。
 */

import { el, panels, S, ownsWorkspace } from './state.js';
import { toProjectRel } from './util.js';
import {
  fetchGitDiff,
  fetchGitStatus,
  resolveGitOpenTarget,
  restoreAllGitPaths,
  restoreGitPath,
  gitConversationScope,
} from './api.js';
import { listChanges, onChanges } from './changes.js';
import { toast } from './ui/toast.js';
import { confirmModal, openModal } from './ui/modal.js';
import { openSecondarySurface } from './ui/secondary-surface.js';
import { allHunksOpen, bindDiffToggles, countDiffLines, diffHtml, setAllHunks } from './diff.js';
import {
  REVIEW_LIMITS,
  addComment,
  beginReviewRefresh,
  commentCount,
  commentAtPosition,
  commentForLine,
  commentsForPath,
  commentsForScope,
  currentReviewScope,
  deleteComment,
  formatReviewFeedback,
  lineLabel,
  markMissingPathsStale,
  reconcileSectionOptions,
  sectionLabel as reviewSectionLabel,
  updateComment,
} from './diff-comments.js';
import { fillReviewComposer } from './review-fill.js';

/* 自动刷新的防抖窗口。
 *
 * 落在需求给的 300~800ms 区间里，取中值：太短则一次 Agent 连续改 5 个文件会
 * 触发 5 次 git status（每次都要起几个 git 进程），太长则用户觉得「改完了半天
 * 没反应」。450ms 对这两者都够用。 */
const REFRESH_DEBOUNCE_MS = 450;

/* 一次会话里可能连续发生几十次改动，所以只留一个定时器 —— 后一次调用把前一次
 * 顶掉，于是「连续 N 次操作」只产生 1 次刷新。 */
let refreshTimer = null;
let statusRequest = 0;
let scopeRevision = 0;
document.addEventListener('pi-gui:git-scope', () => {
  scopeRevision++; statusRequest++;
  S.changes = blankChanges(); view.sessionOnly = false;
  dropReviewDraftSurface();
  renderChangesBody();
});
document.addEventListener('pi-gui:workspace-generation', () => {
  dropReviewDraftSurface();
});
document.addEventListener('pi-gui:session-switch', () => {
  /* Classic session switch: the comment bucket changes with S.state.sessionId,
   * so unsaved text and expanded-diff state must not survive the switch. */
  dropReviewDraftSurface();
  suspendReviewSurface();
});

const STATUS_LABEL = {
  M: '已修改',
  A: '新增',
  D: '已删除',
  R: '重命名',
  C: '复制',
  U: '冲突',
  '??': '未跟踪',
};

/* ---------- 视图状态（只活在这次运行里，不写 localStorage） ---------- */

const view = {
  /* 「仅本次会话」是个临时视角，不是设置 —— 用户下次打开面板时想看的
   * 多半还是全部（磁盘上现在什么样）。所以只记在内存里。 */
  sessionOnly: false,
};

/* 用户最后一次选的上下文行数。新展开的文件沿用这个选择 ——
 * 「我要看更多上下文」通常是对整个仓库的偏好，不是对某一个文件的。 */
let lastContext = null;

/* 「全部撤销」按钮的引用。它长在面板头上（不随列表重绘），
 * 但可用状态要跟着列表走，所以留一个槽位。 */
let restoreAllBtn = null;
let activeChangesSurface = null;
let reviewButton = null;
let reviewSummaryClose = null;
/* A classic session switch changes the comment owner immediately, but
 * S.state.sessionId only catches up after boot(). Keep the old session's
 * counts off the screen during that window instead of pretending they belong
 * to the new session. */
let reviewScopeSuspended = false;
/* 批量撤销进行中标记：连点两次会把同一个仓库撤两遍，第二次结果毫无意义。 */
let restoringAll = false;
/* Expanded diff state survives a list redraw caused by an external Git refresh. */
const diffViewState = new Map();
/* Unsaved comment text is captured before a destructive redraw and restored
 * only inside the same workspace/conversation scope. */
const pendingReviewDrafts = new Map();
/* Block → {path, section, truncated}. A WeakMap keeps user-controlled paths out
 * of DOM attributes entirely. */
const reviewBlockMeta = new WeakMap();

/**
 * Unsaved editor text, which diff is expanded and the summary dialog all belong
 * to one workspace/conversation. Comments themselves are scope-bucketed and
 * stay available when the user comes back; only the transient surface is
 * dropped here.
 */
function dropReviewDraftSurface() {
  pendingReviewDrafts.clear();
  diffViewState.clear();
  reviewSummaryClose?.();
  reviewSummaryClose = null;
}

function suspendReviewSurface() {
  reviewScopeSuspended = true;
  const box = panels.changes;
  if (box) {
    for (const node of box.querySelectorAll('.chg-review-n')) node.remove();
    for (const row of box.querySelectorAll('.d-row.has-comment, .d-row.has-stale-comment')) {
      row.classList.remove('has-comment', 'has-stale-comment');
      delete row.dataset.commentId;
      const gutter = row.querySelector('.d-gutter');
      if (gutter) {
        gutter.dataset.comment = '';
        gutter.setAttribute('aria-pressed', 'false');
        gutter.title = '为这一行添加评论';
      }
    }
  }
  syncReviewButton();
}

/* ---------- 状态 ---------- */

/* 「Git 状态刷新完了」的通知点。
 *
 * 为什么要有它：时间线要给 write / edit 补上 +N −M，而那个数字只有 Git 知道
 * （§9：Git 是最终权威）。但 git.js 不能 import tools.js —— tools.js 已经
 * import 了 git.js，会成环。所以这里反过来：谁关心谁来登记，刷新完成后挨个叫。
 *
 * 由 tools.js 在模块加载时登记（和本文件末尾那个 onChanges(...) 一个路数）。 */
const statusHooks = new Set();

export function setGitStatusHook(fn) {
  if (typeof fn !== 'function') return () => {};
  statusHooks.add(fn);
  return () => statusHooks.delete(fn);
}

function emitGitStatus() {
  for (const fn of statusHooks) {
    try {
      fn(S.changes);
    } catch {
      /* 订阅者自己炸了不该带塌刷新流程 */
    }
  }
}

function blankChanges() {
  return {
    isRepo: false,
    loaded: false,
    files: [],
    error: '',
    noGit: false,
    noProject: false,
    projectRoot: '',
    truncated: false,
  };
}

/** 拉一次 Git 工作区状态，写进 S.changes 并更新侧栏徽标。
 *  永远不抛：网络失败也落到「结构化错误」上，界面显示降级文案而不是崩掉。 */
export async function loadGitStatus() {
  const generation = S.workspaceGeneration;
  const request = ++statusRequest;
  const c = S.changes;
  const j = await fetchGitStatus();
  if (!ownsWorkspace(generation) || request !== statusRequest) return null;

  c.loaded = true;

  if (!j || j.network) {
    // 后端连不上时保留上一次的文件列表会让数字骗人，索性清空
    c.isRepo = false;
    c.files = [];
    c.noGit = false;
    c.noProject = false;
    c.projectRoot = '';
    c.truncated = false;
    c.error = '无法连接后端，变更信息暂不可用。';
    renderChangesBadge();
    emitGitStatus();
    return c;
  }

  c.noGit = Boolean(j.noGit);
  c.noProject = Boolean(j.noProject);
  c.isRepo = Boolean(j.isRepo);
  c.files = Array.isArray(j.files) ? j.files : [];
  c.truncated = Boolean(j.truncated);
  c.projectRoot = typeof j.projectRoot === 'string' ? j.projectRoot : '';
  c.error = j.ok === false ? String(j.error || '读取 Git 状态失败') : '';

  renderChangesBadge();
  emitGitStatus();
  return c;
}

/** 换项目时清空 —— 上一个项目的变更列表留在界面上是纯粹的误导。 */
export function resetChanges() {
  statusRequest++;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  Object.assign(S.changes, blankChanges());
  view.sessionOnly = false;
  renderChangesBadge();
  renderChangesBody();
}

/** 侧栏徽标。0 条时隐藏而不是显示 0 —— 常态是「干净」，不该常驻一个数字。
 *  **注意这里数的是 Git 的总数**，与「仅本次会话」过滤无关：
 *  徽标回答的是「磁盘上有多少没提交的东西」，那是权威数字，不该被视角改变。 */
export function renderChangesBadge() {
  if (!el.changesCount) return;
  const n = S.changes.files.length;
  el.changesCount.textContent = n ? String(n) : '';
  el.changesCount.hidden = n === 0;
}

/* ---------- 会话账本 → 项目相对路径 ---------- */

/* 归一化规则本身搬去了 util.js 的 toProjectRel —— 时间线的 +N −M 回填
 * （tool-model.js）也要用同一份规则，各写一份迟早会漂移。 */

/** 本次会话改过的文件，归一成项目相对路径的集合。 */
export function sessionFileSet() {
  const set = new Set();
  if (gitConversationScope()) return set; // Classic event ledger does not own runtime files.
  for (const e of listChanges()) {
    const rel = toProjectRel(e.path, S.changes.projectRoot);
    if (rel) set.add(rel);
  }
  return set;
}

/** 会话集合的指纹，用来判断「账本真的变了吗」。
 *  没有它的话，每一次工具调用都会重画面板 —— 用户展开的 diff 会被反复清掉。 */
const sessionSignature = () => [...sessionFileSet()].sort().join('\n');

let lastSessionSig = sessionSignature();

/* 账本变了：过滤关着时只需刷新计数，过滤开着时列表本身会变，必须重画。 */
onChanges(() => {
  const sig = sessionSignature();
  if (sig === lastSessionSig) return;
  lastSessionSig = sig;
  if (!panels.changes) return;
  if (view.sessionOnly) renderChangesBody();
  else updateFilterCounts();
});

/* ---------- 刷新（防抖） ---------- */

/** 安排一次延迟刷新。连续调用只生效最后一次。 */
export function scheduleGitRefresh(delay = REFRESH_DEBOUNCE_MS) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshGitNow();
  }, delay);
}

/** 立刻刷新：拉状态 + 重画面板（面板没开时只更新徽标）。 */
export async function refreshGitNow() {
  const result = await loadGitStatus();
  if (!result) return;
  reviewScopeSuspended = false;
  preserveReviewDrafts();
  /* New Git state means every anchor must be re-proved by a rendered diff.
   * Collapsed files keep their comments as "尚未重新确认", never as valid. */
  beginReviewRefresh();
  renderChangesBody();
}

/* ---------- 面板 ---------- */

export function openChangesPanel(options = {}) {
  const split = document.createElement('button');
  split.type = 'button';
  split.id = 'btnChangesSplit';
  split.className = 'icon-btn changes-split-icon';
  split.textContent = '⇅';
  split.title = '同时显示 Specs 与文件变更';
  split.setAttribute('aria-label', '与 Specs 分屏');
  split.onclick = () => document.dispatchEvent(new window.CustomEvent(
    'pi-gui:open-split-workbench',
    { detail: { source: 'changes' } }
  ));
  return openSecondarySurface(
    'changes',
    (card, instance) => mountChangesPanel(card, instance, {
      ...options,
      extraActions: [...(options.extraActions || []), split],
    })
  );
}

export function mountChangesPanel(card, instance, { extraActions = [] } = {}) {
  card.classList.add('changes');
  activeChangesSurface = instance;
  instance.onDispose(() => {
    panels.changes = null;
    restoreAllBtn = null;
    reviewButton = null;
    if (activeChangesSurface === instance) activeChangesSurface = null;
    /* Closing the panel (or swapping it for another surface) discards unsaved
     * editor text. This is a deliberate rule: drafts live in memory together
     * with the visible editor, and are never resurrected after a close. */
    dropReviewDraftSurface();
  });

  const head = document.createElement('div');
  head.className = 'chg-head';

  const h = document.createElement('h3');
  h.textContent = '文件变更';

  const sub = document.createElement('span');
  sub.className = 'chg-sub';
  sub.textContent = 'Git 工作区 · 磁盘真实状态';

  const grow = document.createElement('span');
  grow.className = 'grow';

  /* 全部撤销。危险操作，所以用 danger 配色；具体确认在 restoreAll() 里，
   * 那时会拿到后端算出的**权威**计划（恢复几个 / 取消暂存几个 / 删几个）。 */
  const btnAll = document.createElement('button');
  btnAll.type = 'button';
  btnAll.className = 'btn tiny danger';
  btnAll.textContent = '全部撤销';
  btnAll.title = '把工作区所有改动恢复成 Git 中的版本';
  btnAll.onclick = () => restoreAll();
  restoreAllBtn = btnAll;

  const btnRefresh = document.createElement('button');
  btnRefresh.type = 'button';
  btnRefresh.id = 'btnChangesRefresh';
  btnRefresh.className = 'btn tiny';
  btnRefresh.textContent = '刷新';
  btnRefresh.onclick = () => refreshGitNow();

  const btnReview = document.createElement('button');
  btnReview.type = 'button';
  btnReview.id = 'btnChangesReview';
  btnReview.className = 'btn tiny';
  btnReview.textContent = '审查意见';
  btnReview.title = '查看、复制或填入当前作用域的行级评论';
  btnReview.onclick = () => openReviewSummary();
  reviewButton = btnReview;

  head.append(h, sub, grow, btnAll, btnReview, btnRefresh, ...extraActions);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'chg-body';
  card.appendChild(body);

  /* 弹层里的动态容器。关闭时 modal.js 会把它置回 null，
   * 于是「异步结果晚到」的情况会自然落空，不会往已卸载的节点里写。 */
  panels.changes = body;

  renderChangesBody();

  // 打开就用最新数据重画一次（先用已有状态垫一帧，避免空白等待）
  loadGitStatus().then(() => {
    if (instance.isCurrent()) renderChangesBody();
  });
}

/** 重画面板内容。`panels.changes` 为空（面板没开 / 已关）时直接返回。 */
export function renderChangesBody() {
  const box = panels.changes;
  if (!box || !box.isConnected) return;

  preserveReviewDrafts();
  box.innerHTML = '';
  const c = S.changes;

  syncRestoreAllBtn(c);
  syncReviewButton();

  if (!c.loaded) {
    box.appendChild(hint('正在读取 Git 状态…'));
    return;
  }
  /* 「不是 Git 仓库」是**正常情况**，不是错误 —— Pi GUI 允许打开普通文件夹。
   * 所以这里是中性提示，不弹窗、不报错、不影响聊天与 pi 的执行。 */
  if (c.noProject) {
    box.appendChild(hint('还没有选择项目。先在左侧「添加文件夹」选一个目录。'));
    return;
  }
  if (c.noGit) {
    box.appendChild(hint('没有找到 git 命令，无法读取变更。\n装上 Git 并重启即可；聊天与代码修改不受影响。'));
    return;
  }
  if (c.error) {
    box.appendChild(hint('读取 Git 状态失败：' + c.error, 'err'));
    box.appendChild(tinyBtn('重试', () => refreshGitNow()));
    return;
  }
  if (!c.isRepo) {
    box.appendChild(hint('当前项目不是 Git 仓库，没有可比较的文件变更。\n聊天与代码修改不受影响。'));
    return;
  }
  if (!c.files.length) {
    markMissingPathsStale([]);
    box.appendChild(hint('没有文件变更。工作区是干净的。'));
    return;
  }

  const session = sessionFileSet();
  box.appendChild(filterRow(session));

  const shown = view.sessionOnly ? c.files.filter((f) => session.has(f.path)) : c.files;
  markMissingPathsStale(c.files.map((f) => f.path));

  if (!shown.length) {
    /* 两种情况要分开说：账本本身是空的，和账本里有东西但都对不上当前工作区。
     * 混成一句话会让「Agent 明明改过」的用户以为是工具坏了。 */
    box.appendChild(
      hint(
        session.size
          ? '本次会话碰过的文件现在都没有未提交的改动 —— 可能已经提交、或者被撤销了。\n切到「全部」可以看到工作区里剩下的改动。'
          : '本次会话还没有记录到文件改动。\n账本只记 write / edit 这两个工具 —— 通过 bash 改的文件不会出现在这里，切到「全部」可以看到它们。'
      )
    );
    return;
  }

  const list = document.createElement('div');
  list.className = 'chg-list';
  for (const f of shown) list.appendChild(changeRow(f, session.has(f.path)));
  box.appendChild(list);

  if (c.truncated) box.appendChild(hint('变更列表过长，已截断显示。', 'warn'));
}

/** 「全部 / 仅本次会话」切换。 */
function filterRow(session) {
  const row = document.createElement('div');
  row.className = 'chg-filter';

  const mk = (id, label, n, on) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = 'chg-tab' + (view.sessionOnly === on ? ' on' : '');
    b.setAttribute('aria-pressed', String(view.sessionOnly === on));
    const t = document.createElement('span');
    t.textContent = label;
    const c = document.createElement('b');
    c.className = 'chg-tab-n';
    c.textContent = String(n);
    b.append(t, c);
    b.onclick = () => {
      if (view.sessionOnly === on) return;
      view.sessionOnly = on;
      renderChangesBody();
    };
    return b;
  };

  row.append(
    mk('chgFilterAll', '全部', S.changes.files.length, false),
    mk('chgFilterSession', '本会话编辑', session.size, true)
  );

  const note = document.createElement('span');
  note.className = 'chg-filter-note';
  note.textContent = '记录 Pi 的 write / edit 工具；终端命令产生的文件修改请在「全部」中查看。';
  row.appendChild(note);

  return row;
}

/** 只更新过滤行上的数字，不动列表 —— 账本变了但过滤关着时走这条，
 *  这样用户展开的 diff 不会被重画清掉。 */
function updateFilterCounts() {
  const box = panels.changes;
  if (!box) return;
  const all = box.querySelector('#chgFilterAll .chg-tab-n');
  const sess = box.querySelector('#chgFilterSession .chg-tab-n');
  if (all) all.textContent = String(S.changes.files.length);
  if (sess) sess.textContent = String(sessionFileSet().size);
}

/** 「全部撤销」按钮的可用状态：没有可撤销的东西时禁用，
 *  而不是让它点了之后弹一句「没有改动」。 */
function syncRestoreAllBtn(c) {
  if (!restoreAllBtn) return;
  const usable = Boolean(c.loaded && c.isRepo && !c.noGit && !c.noProject && c.files.length);
  restoreAllBtn.disabled = !usable || restoringAll;
  restoreAllBtn.title = usable
    ? `把工作区这 ${c.files.length} 项改动恢复成 Git 中的版本`
    : '当前没有可撤销的改动';
}

function syncReviewButton() {
  if (!reviewButton) return;
  if (reviewScopeSuspended) {
    reviewButton.textContent = '审查意见';
    reviewButton.disabled = true;
    reviewButton.title = '正在切换会话；刷新后显示当前会话的评论';
    return;
  }
  const count = commentCount();
  reviewButton.textContent = count ? `审查意见 ${count}` : '审查意见';
  reviewButton.disabled = false;
  reviewButton.title = count
    ? `当前作用域有 ${count} 条行级评论；评论只保留到应用重启`
    : '还没有行级评论；在 Diff 行号上添加';
}

/* ---------- 列表项 ---------- */

function hint(text, kind) {
  const d = document.createElement('div');
  d.className = 'chg-hint' + (kind ? ' ' + kind : '');
  d.textContent = text;
  return d;
}

function tinyBtn(text, onClick, kind) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn tiny' + (kind ? ' ' + kind : '');
  b.textContent = text;
  // 行本身也是可点的（展开 diff），按钮不能把点击冒泡上去
  b.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return b;
}

/** 「已修改 · 未跟踪」这类补充说明。
 *
 * 注意 `??` 的状态标签本身就是「未跟踪」，这里不再重复一次 ——
 * 否则未跟踪目录会显示成「未跟踪 · 目录 · 未跟踪」。
 * 真正需要补充的是「已暂存 / 暂存 + 工作区」：状态字母只给了 M，
 * 看不出改动到底在哪一层。 */
function describe(f) {
  const parts = [STATUS_LABEL[f.status] || f.status];
  if (f.isDir) parts.push('目录');
  if (!f.untracked) {
    if (f.staged && f.worktree && f.worktree !== ' ') parts.push('暂存 + 工作区');
    else if (f.staged) parts.push('已暂存');
  }
  if (f.oldPath) parts.push('原路径 ' + f.oldPath);
  return parts.join(' · ');
}

/** 把 +N −M 写进一个 span。`null` 表示后端没给出数字（未跟踪文件太多被跳过）。 */
function fillStat(span, add, del) {
  span.innerHTML = '';
  if (add) {
    const a = document.createElement('b');
    a.className = 'add';
    a.textContent = '+' + add;
    span.appendChild(a);
  }
  if (del) {
    const d = document.createElement('b');
    d.className = 'del';
    d.textContent = '−' + del;
    span.appendChild(d);
  }
}

function changeRow(f, inSession) {
  const surface = activeChangesSurface;
  const revision = scopeRevision;
  const row = document.createElement('div');
  row.className = 'chg-row';

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'chg-main';

  const code = document.createElement('span');
  code.className = 'chg-code';
  code.dataset.s = f.status;
  code.textContent = f.status;

  const info = document.createElement('span');
  info.className = 'chg-info';

  const p = document.createElement('span');
  p.className = 'chg-path';
  p.textContent = f.path;
  p.title = f.path;

  const meta = document.createElement('span');
  meta.className = 'chg-meta';
  meta.textContent = describe(f);

  info.append(p, meta);

  const stat = document.createElement('span');
  stat.className = 'chg-stat';
  if (f.binary) stat.textContent = '二进制';
  else fillStat(stat, f.additions, f.deletions);

  const commentN = commentsForPath(f.path).length;
  /* 「本会话」标记。只是标记，不是过滤条件 —— 它回答「这一条是不是 Agent 改的」，
   * 而列表里有没有它由上面的过滤决定。 */
  const metaNodes = [code, info, stat];
  if (commentN) {
    const review = document.createElement('span');
    review.className = 'chg-review-n';
    review.textContent = `${commentN} 条评论`;
    review.title = '这个文件在当前作用域的行级评论数';
    metaNodes.push(review);
  }
  if (inSession) {
    const s = document.createElement('span');
    s.className = 'chg-sess';
    s.textContent = '本会话';
    s.title = '这次会话里 write / edit 碰过这个文件';
    metaNodes.push(s);
  }
  main.append(...metaNodes);

  const acts = document.createElement('span');
  acts.className = 'chg-acts';
  if (canOpenFile()) acts.append(tinyBtn('打开', () => openFile(f)));
  acts.append(tinyBtn(f.untracked ? '删除' : '撤销', () => restoreFile(f), 'danger'));

  row.append(main, acts);

  const diffBox = document.createElement('div');
  diffBox.className = 'chg-diff';
  diffBox.dataset.role = 'diff';
  const stateKey = `${currentReviewScope()}\u0000${f.path}`;
  const retained = diffViewState.get(stateKey);
  const hasPendingDraft = [...pendingReviewDrafts.values()].some((draft) => draft.path === f.path);
  const reopen = Boolean(retained?.open && hasPendingDraft);
  if (retained) diffBox.scrollTop = retained.scrollTop || 0;
  diffBox.hidden = !reopen;
  if (reopen) row.classList.add('open');
  row.appendChild(diffBox);

  /* 这一个文件的 diff 视图状态。context 是**按文件**记的：想细看某个文件的
   * 上下文是局部需求，不该顺手把别的文件也重拉一遍。 */
  const dstate = {
    context: retained?.context ?? lastContext,
    loaded: false,
    busy: false,
    stateKey,
  };

  async function reloadDiff() {
    dstate.busy = true;
    diffBox.innerHTML = '';
    diffBox.appendChild(hint('正在读取差异…'));

    const reviewScroll = diffBox.scrollTop;
    const r = await fetchGitDiff(f.path, dstate.context);
    if (!surface || !surface.isCurrent() || revision !== scopeRevision) return;
    dstate.busy = false;
    dstate.loaded = true;
    rememberDiffView(dstate, diffBox, true);

    // 后端没给出增删行数时（未跟踪文件超限被跳过），从 diff 正文里补一次
    if (!f.binary && f.additions === null && f.deletions === null && r && r.ok) {
      const n = countDiffLines(String(r.working || '') + String(r.staged || ''));
      if (n.add || n.del) fillStat(stat, n.add, n.del);
    }

    renderDiffInto(diffBox, r, f, dstate, reloadDiff, reviewScroll);
  }

  /* 点击行 = 就地展开 unified diff。
   * 用「就地展开」而不是再开一层弹层：diff 常常要对照着文件列表看，
   * 而且嵌套弹层的返回路径（Esc 关哪一层）很容易做错。 */
  main.onclick = async () => {
    if (!diffBox.hidden) {
      rememberDiffView(dstate, diffBox, false);
      preserveReviewDrafts();
      diffBox.hidden = true;
      row.classList.remove('open');
      return;
    }
    diffBox.hidden = false;
    row.classList.add('open');
    rememberDiffView(dstate, diffBox, true);
    if (dstate.loaded || dstate.busy) return;
    await reloadDiff();
  };

  diffBox.addEventListener('scroll', () => rememberDiffView(dstate, diffBox, !diffBox.hidden), { passive: true });
  if (reopen) queueMicrotask(() => { void reloadDiff().then(() => { diffBox.scrollTop = retained.scrollTop || 0; }); });

  return row;
}

function rememberDiffView(dstate, box, open) {
  if (!dstate?.stateKey) return;
  diffViewState.set(dstate.stateKey, {
    open: Boolean(open),
    context: dstate.context,
    scrollTop: Number(box?.scrollTop) || 0,
  });
}

/* ---------- Diff 渲染 ---------- */

function sectionLabel(text) {
  const s = document.createElement('div');
  s.className = 'chg-label';
  s.textContent = text;
  return s;
}

/* diffHtml() 自己先整体转义、再插入白名单标签，所以这里的 innerHTML 是安全的
 * （详见 public/diff.js 顶部的安全模型说明）。 */
function diffBlock(text, { commentable = true } = {}) {
  const d = document.createElement('div');
  d.className = 'chg-block';
  d.innerHTML = diffHtml(text, { commentable });
  const root = d.querySelector('.diff');
  if (root) bindDiffToggles(root);
  return d;
}

function rowAnchor(row, section, path, fingerprint) {
  const code = row.querySelector('.dl')?.textContent || '';
  return {
    path,
    section,
    type: row.dataset.lineType,
    oldLine: row.dataset.oldLine === '' ? null : Number(row.dataset.oldLine),
    newLine: row.dataset.newLine === '' ? null : Number(row.dataset.newLine),
    hunkIndex: Number(row.dataset.hunkIndex),
    hunkHeader: row.dataset.hunkHeader || '',
    codeHash: row.dataset.codeHash || '',
    diffFingerprint: fingerprint,
    snippet: code.slice(1),
  };
}

function rowLine(anchor) {
  return {
    type: anchor.type,
    oldLine: anchor.oldLine,
    newLine: anchor.newLine,
    hunkIndex: anchor.hunkIndex,
    hunkHeader: anchor.hunkHeader,
    codeHash: anchor.codeHash,
  };
}

function draftKey(path, section, anchor) {
  return `${currentReviewScope()}\u0000${path}\u0000${section}\u0000${anchor.type}\u0000${anchor.oldLine ?? ''}\u0000${anchor.newLine ?? ''}\u0000${anchor.codeHash}`;
}

/* Unsaved editors are user text, so they are bounded like comments are: a long
 * session of opening editors cannot grow this map without limit. */
const MAX_PENDING_DRAFTS = 40;

function setPendingDraft(key, value) {
  pendingReviewDrafts.delete(key);
  if (!value) return;
  pendingReviewDrafts.set(key, value);
  while (pendingReviewDrafts.size > MAX_PENDING_DRAFTS) {
    pendingReviewDrafts.delete(pendingReviewDrafts.keys().next().value);
  }
}

function preserveReviewDrafts() {
  const box = panels.changes;
  if (!box) return;
  for (const editor of box.querySelectorAll('.d-review-editor[data-draft-key]')) {
    const text = editor.querySelector('textarea')?.value || '';
    if (!text.trim()) {
      pendingReviewDrafts.delete(editor.dataset.draftKey);
      continue;
    }
    setPendingDraft(editor.dataset.draftKey, {
      text,
      path: editor.dataset.path || '',
      section: editor.dataset.section || 'working',
      anchor: JSON.parse(editor.dataset.anchor || 'null'),
    });
  }
}

function setRowComment(row, comment) {
  row.classList.toggle('has-comment', Boolean(comment));
  row.classList.toggle('has-stale-comment', Boolean(comment?.stale));
  if (comment) row.dataset.commentId = comment.id;
  else delete row.dataset.commentId;
  const gutter = row.querySelector('.d-gutter');
  if (!gutter) return;
  gutter.dataset.comment = comment ? '1' : '';
  gutter.setAttribute('aria-pressed', String(Boolean(comment)));
  gutter.title = comment ? '编辑这一行的评论' : '为这一行添加评论';
}

function closeReviewEditor(row) {
  row.querySelector(':scope > .d-review-editor')?.remove();
  row.classList.remove('reviewing');
  row.querySelector('.d-gutter')?.setAttribute('aria-expanded', 'false');
}

function openReviewEditor(row, { path, section, anchor, focus = true } = {}) {
  closeReviewEditor(row);
  const key = draftKey(path, section, anchor);
  const existing = commentForLine(anchor);
  const occupied = existing ? null : commentAtPosition(anchor);
  const draft = pendingReviewDrafts.get(key);
  const editor = document.createElement('span');
  editor.className = 'd-review-editor';
  editor.dataset.draftKey = key;
  editor.dataset.path = path;
  editor.dataset.section = section;
  editor.dataset.anchor = JSON.stringify(anchor);

  const head = document.createElement('span');
  head.className = 'd-review-head';
  const where = document.createElement('span');
  where.className = 'd-review-where';
  where.textContent = `${path} · ${reviewSectionLabel(section)} · ${existing || occupied ? lineLabel(existing || occupied) : row.querySelector('.d-gutter')?.getAttribute('aria-label')?.split('；')[0] || '代码行'}`;
  const status = document.createElement('span');
  status.className = 'd-review-status';
  status.setAttribute('role', 'status');
  head.append(where, status);

  const input = document.createElement('textarea');
  input.rows = 3;
  input.maxLength = REVIEW_LIMITS.textChars;
  input.value = draft?.text ?? existing?.text ?? '';
  input.placeholder = '写下这一行的修改意见（纯文本，不会自动发送）';
  input.setAttribute('aria-label', `评论 ${path} ${where.textContent}`);
  input.addEventListener('input', () => {
    const text = input.value;
    if (text.trim()) setPendingDraft(key, { text, path, section, anchor });
    else pendingReviewDrafts.delete(key);
    status.textContent = `${text.length}/${REVIEW_LIMITS.textChars}`;
  });
  status.textContent = `${input.value.length}/${REVIEW_LIMITS.textChars}`;

  const actions = document.createElement('span');
  actions.className = 'd-review-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn tiny primary';
  save.textContent = existing ? '保存修改' : '保存评论';
  save.disabled = Boolean(occupied);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn tiny';
  cancel.textContent = '取消';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn tiny danger';
  remove.textContent = '删除';
  remove.hidden = !(existing || occupied);
  const hintNode = document.createElement('span');
  hintNode.className = 'd-review-hint';
  hintNode.textContent = occupied
    ? '这一行已有一条过期评论；只能删除它，不能再挂一条新的。'
    : existing ? '评论保存在内存中，应用重启后不保留。' : '同一行第一阶段只保留一条评论。';
  actions.append(save, cancel, remove, hintNode);

  const fail = (message) => {
    status.textContent = message;
    status.classList.add('err');
  };
  save.onclick = () => {
    status.classList.remove('err');
    const result = existing
      ? updateComment(existing.id, input.value)
      : addComment({ path, anchor, text: input.value });
    if (!result.ok) {
      fail(result.error);
      return;
    }
    pendingReviewDrafts.delete(key);
    setRowComment(row, result.comment);
    closeReviewEditor(row);
    syncReviewButton();
    toast(existing ? '评论已更新' : '评论已保存', 'info');
    row.querySelector('.d-gutter')?.focus({ preventScroll: true });
  };
  cancel.onclick = () => {
    pendingReviewDrafts.delete(key);
    closeReviewEditor(row);
    row.querySelector('.d-gutter')?.focus({ preventScroll: true });
  };
  remove.onclick = () => {
    const target = existing || occupied;
    if (!target) return;
    deleteComment(target.id);
    pendingReviewDrafts.delete(key);
    setRowComment(row, null);
    closeReviewEditor(row);
    syncReviewButton();
    decorateReviewBlocks();
    toast('评论已删除', 'info');
    row.querySelector('.d-gutter')?.focus({ preventScroll: true });
  };
  if (occupied) {
    input.value = occupied.text;
    input.readOnly = true;
    input.setAttribute('aria-readonly', 'true');
    input.placeholder = '这条评论的原位置已变化；可复制或删除它。';
  }
  editor.append(head, input, actions);
  row.appendChild(editor);
  row.classList.add('reviewing');
  row.querySelector('.d-gutter')?.setAttribute('aria-expanded', 'true');
  if (focus) input.focus({ preventScroll: true });
}

function decorateReviewBlock(block, path, section, truncated) {
  const root = block.querySelector('.diff');
  if (!root) {
    return;
  }
  /* A fixed enum, never user text: used to scope "jump to comment" lookups. */
  block.dataset.reviewSection = section;
  reviewBlockMeta.set(block, { path, section, truncated });
  const fingerprint = root.dataset.fingerprint || '';
  const rows = [...root.querySelectorAll('.d-hunkwrap > .d-row')];
  if (truncated) {
    /* The diff was cut at the backend limit: rows here cannot prove either
     * validity or disappearance. Leave the stored status untouched instead of
     * marking every review in this file as "原位置已变化". */
    const note = document.createElement('p');
    note.className = 'd-review-note';
    note.textContent = '差异已截断，无法确认完整行号；此文件的评论暂不能定位，原状态保持不变。';
    block.appendChild(note);
    return;
  }
  const lines = rows.map((row) => rowLine(rowAnchor(row, section, path, fingerprint)));
  reconcileSectionOptions(path, section, lines, fingerprint, { complete: true });

  for (const row of rows) {
    const anchor = rowAnchor(row, section, path, fingerprint);
    const comment = commentForLine(anchor);
    setRowComment(row, comment);
    const gutter = row.querySelector('.d-gutter');
    if (!gutter) continue;
    gutter.setAttribute('aria-expanded', 'false');
    if (!comment) gutter.dataset.comment = '';
    gutter.onclick = () => {
      preserveReviewDrafts();
      openReviewEditor(row, { path, section, anchor });
    };
    const draft = pendingReviewDrafts.get(draftKey(path, section, anchor));
    if (draft) openReviewEditor(row, { path, section, anchor, focus: false });
  }

}

/** Re-apply row markers after a comment was deleted, without touching editors. */
function decorateReviewBlocks() {
  const box = panels.changes;
  if (!box) return;
  for (const block of box.querySelectorAll('.chg-block')) {
    const meta = reviewBlockMeta.get(block);
    const root = block.querySelector('.diff');
    if (!meta || !root) continue;
    const fingerprint = root.dataset.fingerprint || '';
    for (const row of root.querySelectorAll('.d-hunkwrap > .d-row')) {
      setRowComment(row, commentForLine(rowAnchor(row, meta.section, meta.path, fingerprint)));
    }
  }
}

/**
 * 渲染一个文件的 diff。
 *
 * @param dstate  该文件的视图状态（context / loaded）
 * @param reload  重新拉取并重画（切上下文时用）。切换上下文**必须重新问后端**：
 *                diff 正文是 git 按 -U 现算的，前端没法从已截断的文本里
 *                「补出」被裁掉的上下文行。
 */
function renderDiffInto(box, r, f, dstate, reload, restoreScroll = 0) {
  box.innerHTML = '';

  // 所有内容塞进一个**每次重画都新建**的容器里挂事件。
  // 直接挂在 box 上会随着一次次重画累积监听器（box 是复用的节点）。
  const wrap = document.createElement('div');
  wrap.className = 'chg-diff-inner';
  box.appendChild(wrap);

  if (!r || r.network) {
    wrap.appendChild(hint('无法连接后端，读取差异失败。', 'err'));
    return;
  }
  if (!r.ok) {
    wrap.appendChild(hint(r.error || '读取差异失败。', 'err'));
    return;
  }
  if (r.notice) wrap.appendChild(hint(r.notice, 'warn'));

  const staged = String(r.staged || '');
  const working = String(r.working || '');
  const hasBody = Boolean(staged.trim() || working.trim()) && !r.binary;

  /* 二进制：git 给的就是一行 `Binary files … differ`，把它当文本逐行着色没有意义，
   * 直接说明「看不了」并建议用系统编辑器打开。 */
  if (r.binary) {
    wrap.appendChild(hint(canOpenFile() ? '二进制文件，没有可显示的文本差异。用「打开」交给系统程序查看。' : '二进制文件，没有可显示的文本差异。网页模式不能调用系统编辑器。'));
    if (r.truncated) wrap.appendChild(truncatedHint(r));
    return;
  }

  if (!hasBody) {
    wrap.appendChild(hint('没有可显示的差异：文件内容与 Git 中的版本一致。'));
    return;
  }

  // 工具条只在真有正文时出现 —— 对着「没有差异」的提示调上下文是没意义的
  const tools = diffTools(wrap, dstate, reload);
  wrap.appendChild(tools.bar);

  /* 暂存区与工作区分开显示 —— 只给一份的话，`MM` 这种「既暂存又改了」的文件
   * 会让人看不懂到底在跟谁比。 */
  if (staged.trim()) {
    wrap.appendChild(sectionLabel('暂存区（已 git add，尚未提交）'));
    const block = diffBlock(staged, { commentable: !r.truncated && !r.binary });
    wrap.appendChild(block);
    /* 截断的 diff 只允许在安全区显示评论入口；真正的禁用由 decorate 完成。 */
    decorateReviewBlock(block, f.path, 'staged', r.truncated);
  }
  if (working.trim()) {
    wrap.appendChild(sectionLabel(r.untracked ? '未跟踪文件的内容' : '工作区（尚未 git add）'));
    const block = diffBlock(working, { commentable: !r.truncated && !r.binary });
    wrap.appendChild(block);
    decorateReviewBlock(block, f.path, 'working', r.truncated);
  }

  /* 折叠按钮的文案和可见性要等**两个 diff 块都挂上去之后**再同步。
   * 在 diffTools() 内部同步的话，那时 scope 里还没有 .diff，
   * 它会算出「一个可折叠的块都没有」，于是把自己藏起来再也不出现。 */
  tools.sync();

  if (r.truncated) wrap.appendChild(truncatedHint(r));
  if (restoreScroll) box.scrollTop = restoreScroll;
}

/* ---------- 审查意见汇总 ---------- */

function openReviewSummary() {
  const scope = currentReviewScope();
  let closeThis = null;
  let onReviewChange = null;
  openModal((card, close) => {
    closeThis = close;
    reviewSummaryClose = close;
    card.classList.add('review-summary-card');
    const head = document.createElement('div');
    head.className = 'review-summary-head';
    const title = document.createElement('h3');
    title.id = 'reviewSummaryTitle';
    title.textContent = '审查意见';
    const note = document.createElement('p');
    note.className = 'review-summary-note';
    note.textContent = '当前工作区与聚焦会话的临时评论；不会写入项目、Git 或 Planner，重启后不保留。';
    head.append(title, note);

    const actions = document.createElement('div');
    actions.className = 'review-summary-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn primary';
    copy.textContent = '复制审查意见';
    const fill = document.createElement('button');
    fill.type = 'button';
    fill.className = 'btn';
    fill.textContent = '填入当前会话';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn';
    done.textContent = '关闭';
    done.onclick = () => close();
    actions.append(copy, fill, done);

    const status = document.createElement('p');
    status.className = 'review-summary-status';
    status.setAttribute('role', 'status');

    const body = document.createElement('div');
    body.className = 'review-summary-body';
    const preview = document.createElement('textarea');
    preview.className = 'review-feedback-preview';
    preview.readOnly = true;
    preview.rows = 10;
    preview.setAttribute('aria-label', '审查意见反馈预览');

    const draw = () => {
      const comments = commentsForScope(scope);
      body.replaceChildren();
      if (!comments.length) {
        const empty = document.createElement('p');
        empty.className = 'review-summary-empty';
        empty.textContent = '当前作用域还没有评论。展开任意文件的 Diff，点击代码行左侧的行号即可添加。';
        body.appendChild(empty);
      } else {
        const groups = new Map();
        for (const comment of comments) {
          if (!groups.has(comment.path)) groups.set(comment.path, []);
          groups.get(comment.path).push(comment);
        }
        for (const [path, items] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
          const group = document.createElement('section');
          group.className = 'review-file-group';
          const heading = document.createElement('h4');
          heading.textContent = path;
          group.appendChild(heading);
          for (const comment of items.sort((a, b) =>
            String(a.anchor.section).localeCompare(String(b.anchor.section)) ||
            Number(a.anchor.newLine ?? a.anchor.oldLine) - Number(b.anchor.newLine ?? b.anchor.oldLine)
          )) {
            const item = document.createElement('article');
            item.className = 'review-item';
            item.dataset.stale = String(Boolean(comment.stale));
            const meta = document.createElement('div');
            meta.className = 'review-item-meta';
            const where = document.createElement('span');
            where.textContent = `${reviewSectionLabel(comment.anchor.section)} · ${lineLabel(comment)}`;
            if (comment.stale) {
              const stale = document.createElement('b');
              stale.className = 'review-stale';
              stale.textContent = '原位置已变化';
              where.append(' ', stale);
            } else if (comment.verified === false) {
              /* The list was refreshed but this diff has not been re-rendered,
               * so the anchor is unproven rather than confirmed. */
              const pending = document.createElement('span');
              pending.className = 'review-unverified';
              pending.textContent = '待重新确认';
              pending.title = '再次展开这个文件的 Diff 即可确认位置';
              where.append(' ', pending);
            }
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'btn tiny';
            edit.textContent = '编辑';
            edit.onclick = () => {
              close();
              locateAndEdit(comment);
            };
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'btn tiny danger';
            del.textContent = '删除';
            del.onclick = () => {
              deleteComment(comment.id, scope);
              syncReviewButton();
              draw();
              status.textContent = '评论已删除。';
            };
            meta.append(where, edit, del);
            const text = document.createElement('p');
            text.className = 'review-item-text';
            text.textContent = comment.text;
            if (comment.anchor.snippet) {
              const code = document.createElement('code');
              code.className = 'review-item-code';
              code.textContent = comment.anchor.snippet;
              item.append(meta, code, text);
            } else {
              item.append(meta, text);
            }
            group.appendChild(item);
          }
          body.appendChild(group);
        }
      }
      const feedback = formatReviewFeedback(commentsForScope(scope));
      preview.value = feedback;
      copy.disabled = !comments.length;
      fill.disabled = !comments.length;
      if (!comments.length) status.textContent = '';
    };

    copy.onclick = () => {
      const text = formatReviewFeedback(commentsForScope(scope));
      if (!text) return;
      const write = async () => {
        try {
          await navigator.clipboard.writeText(text);
          status.textContent = '审查意见已复制（仅当前作用域，不含完整 Diff）。';
        } catch {
          status.textContent = '复制失败，请在下方预览中手动选中。';
          preview.focus();
          preview.select();
        }
      };
      void write();
    };
    fill.onclick = () => {
      const text = formatReviewFeedback(commentsForScope(scope));
      const current = currentReviewScope();
      if (current !== scope) {
        status.textContent = '工作区已经变化，未填入其他会话。';
        return;
      }
      const result = fillReviewComposer(text);
      status.textContent = result.ok
        ? `已填入当前会话${result.appended ? '（追加在原有草稿之后）' : ''}；不会自动发送。`
        : result.error;
      if (result.ok) close();
    };

    card.append(head, actions, status, body, preview);
    draw();
    /* The summary is a live view: a diff that re-renders behind the dialog can
     * confirm or invalidate anchors while it is open. */
    onReviewChange = (event) => {
      if (event?.detail?.scope && event.detail.scope !== scope) return;
      draw();
    };
    document.addEventListener('pi-gui:review-change', onReviewChange);
  }, () => {
    if (onReviewChange) document.removeEventListener('pi-gui:review-change', onReviewChange);
    onReviewChange = null;
    if (reviewSummaryClose === closeThis) reviewSummaryClose = null;
  }, { className: 'review-summary', labelledBy: 'reviewSummaryTitle' });
}

function locateAndEdit(comment) {
  const path = comment.path;
  const row = [...(panels.changes?.querySelectorAll('.chg-row') || [])]
    .find((item) => item.querySelector('.chg-path')?.textContent === path);
  if (!row) {
    toast('请先刷新文件变更，再编辑这条评论。', 'warn');
    return;
  }
  if (row.querySelector('.chg-diff')?.hidden) row.querySelector('.chg-main')?.click();
  /* The diff may still be loading after the click above, so wait for the
   * anchored row instead of failing on a half-painted panel. */
  const findRow = () => {
    const selector = `.chg-block[data-review-section="${comment.anchor.section}"]` +
      ` .d-row[data-line-type="${comment.anchor.type}"]` +
      `[data-old-line="${comment.anchor.oldLine ?? ''}"][data-new-line="${comment.anchor.newLine ?? ''}"]` +
      `[data-code-hash="${comment.anchor.codeHash}"]`;
    return row.querySelector(selector);
  };
  const target = findRow();
  if (!target) {
    void locateWhenReady(row, findRow, comment);
    return;
  }
  editLocatedRow(row, comment, target);
}

function editLocatedRow(row, comment, target) {
  target.scrollIntoView?.({ block: 'center' });
  openReviewEditor(target, {
    path: comment.path,
    section: comment.anchor.section,
    anchor: rowAnchor(target, comment.anchor.section, comment.path, target.closest('.diff')?.dataset.fingerprint || ''),
  });
}

async function locateWhenReady(row, findRow, comment) {
  for (let i = 0; i < 40; i++) {
    const target = findRow();
    if (target) return editLocatedRow(row, comment, target);
    await new Promise((resolve) => setTimeout(resolve, 50));
    /* The panel, the row or the scope may have been replaced while waiting. */
    if (!row.isConnected || !panels.changes?.contains(row) || comment.scope !== currentReviewScope()) return;
  }
  toast('这条评论的原位置已变化，请从审查意见中复制或删除。', 'warn');
}

/** 上下文行数选择 + 全部展开 / 折叠。
 *
 *  `scope` 是本次渲染的容器（每次重画都新建），所以这里的监听器不会累积。
 *
 *  @returns {{bar:HTMLElement, sync:() => void}} `sync` 由调用方在内容挂好之后调。
 */
function diffTools(scope, dstate, reload) {
  const bar = document.createElement('div');
  bar.className = 'chg-tools';

  const lab = document.createElement('span');
  lab.className = 'chg-tools-label';
  lab.textContent = '上下文';
  bar.appendChild(lab);

  /* null = 不传 -U，跟随用户的 diff.context 配置。
   * 不写死成「3 行」—— 用户可能自己配了别的值，我们不该覆盖他的选择。 */
  const OPTIONS = [
    [null, '默认', '跟随 Git 配置（通常 3 行）'],
    [20, '20 行', '上下各多给 20 行上下文'],
    ['all', '全部', '展开整个文件（输出量仍受大小上限约束）'],
  ];

  for (const [v, text, title] of OPTIONS) {
    const b = tinyBtn(text, () => {
      if (dstate.context === v) return;
      dstate.context = v;
      lastContext = v; // 下一个文件沿用这个选择
      reload();
    });
    b.classList.add('chg-ctx');
    b.title = title;
    if (dstate.context === v) b.classList.add('on');
    bar.appendChild(b);
  }

  const grow = document.createElement('span');
  grow.className = 'grow';
  bar.appendChild(grow);

  const roots = () => [...scope.querySelectorAll('.diff')];

  const all = tinyBtn('折叠全部块', () => {
    const anyClosed = roots().some((x) => !allHunksOpen(x));
    for (const x of roots()) setAllHunks(x, anyClosed);
    syncAll();
  });
  all.classList.add('chg-hunkall');

  /* 按钮文案跟着实际状态走：只要还有折叠着的块，它就该是「展开全部块」。
   * 单独点某个 hunk 头也要能反映过来，所以另挂一个委托监听。 */
  function syncAll() {
    const anyClosed = roots().some((x) => !allHunksOpen(x));
    all.textContent = anyClosed ? '展开全部块' : '折叠全部块';
    all.hidden = roots().length === 0;
  }

  bar.appendChild(all);

  scope.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('.d-hunkbar')) syncAll();
  });

  return { bar, sync: syncAll };
}

function truncatedHint(r) {
  const kb = Math.max(1, Math.round((Number(r.limit) || 0) / 1024));
  return hint(`差异过大，已截断（上限 ${kb} KB）。${canOpenFile() ? '完整内容请用系统编辑器打开该文件。' : '网页模式不能调用系统编辑器；可展开差异查看。'}`, 'warn');
}

/* ---------- 打开 / 撤销 ---------- */

/** 用系统默认程序打开。
 *
 * **不在 Pi GUI 里做编辑器**（需求明确）：这里只负责把「请打开这个项目内文件」
 * 递出去。桌面版走 preload 暴露的桥（主进程 shell.openPath），网页版没有这个
 * 能力，就退化成「把绝对路径告诉用户」。 */
function canOpenFile() {
  return typeof globalThis.piGuiDesktop?.openPath === 'function';
}

async function openFile(f) {
  const bridge = globalThis.piGuiDesktop;

  if (bridge && typeof bridge.openPath === 'function') {
    let r;
    try {
      r = await bridge.openPath(f.path, gitConversationScope());
    } catch (err) {
      toast('打开失败：' + err.message, 'error');
      return;
    }
    if (r && r.ok === false) toast(r.error || '打开失败', 'error');
    return;
  }

  const r = await resolveGitOpenTarget(f.path);
  if (!r || r.ok === false) {
    toast((r && r.error) || '打开失败', 'error');
    return;
  }
  toast('网页版无法调用系统程序。文件：' + r.abs, 'warn');
}

/** 这个文件撤销时需不需要「取消暂存」这道额外授权。
 *  与后端 applyRestore 的判断保持一致：冲突 / 重命名 / 复制一律拒绝，
 *  它们连暂存都不该动。 */
const needsUnstage = (f) =>
  Boolean(f.staged) && !f.untracked && f.status !== 'U' && f.status !== 'R' && f.status !== 'C';

/** 撤销单个文件的改动。危险操作，一律先二次确认。 */
async function restoreFile(f) {
  const conversationId = gitConversationScope(), revision = scopeRevision;
  const untracked = Boolean(f.untracked);
  const unstage = needsUnstage(f);

  /* 未跟踪的**目录**：后端一律拒绝（不会递归删目录 —— 那是 `git clean -fd`
   * 的活儿，我们不做）。所以这里先说明白，不浪费一次往返，也不给一个
   * 「点了会被拒绝」的按钮。 */
  if (f.isDir) {
    toast('未跟踪的目录不在这里删除，请手动处理。', 'warn');
    return;
  }

  /* 已暂存的**新增**文件（`A`）：取消暂存后它就变成未跟踪文件，
   * 「撤销」等于把它删掉。这件事必须在一次对话里说清楚 ——
   * 分成两次问，用户很容易在第二个弹窗上条件反射地点确认。 */
  const stagedAdd = unstage && f.index === 'A';

  /* 授权在**点确认之前**就给全，而不是先试一次等后端说「还缺授权」。
   *
   * 因为对话框里已经把后果写清楚了：未跟踪文件的按钮就叫「删除文件」，
   * 文案里写着「撤销将删除该文件」。用户点了确认，授权就已经拿到了 ——
   * 再让后端拒绝一次、再弹一个框，是纯粹的多余动作。
   *
   * 下面那段 needsConfirm 分支仍然保留，它处理的是另一种情况：
   * 列表过期了（点开面板之后文件才被 git add），此时我们的判断是错的，
   * 该由后端说了算。 */
  let opts = {};
  if (untracked) opts = { deleteUntracked: true };
  else if (unstage) opts = { unstage: true };
  if (stagedAdd) opts = { unstage: true, deleteUntracked: true };

  const title = untracked ? '删除未跟踪文件' : stagedAdd ? '取消暂存并删除文件' : unstage ? '取消暂存并撤销' : '撤销文件改动';

  let message;
  if (untracked) {
    message = `这个文件尚未被 Git 跟踪。撤销将删除该文件。\n\n${f.path}\n\n此操作不可恢复。`;
  } else if (stagedAdd) {
    message = `这个文件是已暂存的新增文件。撤销会先取消暂存（它随即变成未跟踪文件），然后删除该文件。\n\n${f.path}\n\n此操作不可恢复。`;
  } else if (unstage) {
    message = `这个文件的改动已进入暂存区。撤销会先取消暂存（改动 Git 暂存内容），再把它恢复成 Git 中的版本。\n\n${f.path}`;
  } else {
    message = `将把下面的文件恢复成 Git 中的版本，该文件上尚未提交的改动会丢失。\n\n${f.path}`;
  }

  const okText = untracked ? '删除文件' : stagedAdd ? '取消暂存并删除' : unstage ? '取消暂存并撤销' : '撤销改动';

  const ok = await confirmModal({ title, message, okText, danger: true });
  if (!ok || revision !== scopeRevision) return;

  let r = await restoreGitPath(f.path, opts, conversationId);
  if (revision !== scopeRevision) return;

  /* 列表可能已经过期（比如这个文件刚被 git add 了）。后端会把「还需要什么
   * 授权」原样告诉我们，这里最多再问一轮 —— 不做循环重试，
   * 免得出现「点了取消却反复弹」这种失控形态。
   *
   * requiresUnstage 是后端在**动 index 之前**就拦下来的情况（已暂存的新增文件），
   * 所以两个授权要一次给全，否则会留下「index 已改、文件还在」的半吊子状态。 */
  if (r && r.needsConfirm && r.requiresUnstage && !(opts.unstage && opts.deleteUntracked)) {
    const again = await confirmModal({
      title: '取消暂存并删除文件',
      message: String(r.error || '') + `\n\n${f.path}\n\n此操作不可恢复。`,
      okText: '取消暂存并删除',
      danger: true,
    });
    if (!again || revision !== scopeRevision) return;
    r = await restoreGitPath(f.path, { unstage: true, deleteUntracked: true }, conversationId);
  } else if (r && r.needsUnstage && !opts.unstage) {
    const again = await confirmModal({
      title: '取消暂存并撤销',
      message: String(r.error || '') + `\n\n${f.path}`,
      okText: '取消暂存并撤销',
      danger: true,
    });
    if (!again || revision !== scopeRevision) return;
    r = await restoreGitPath(f.path, { ...opts, unstage: true }, conversationId);
  } else if (r && r.needsConfirm && !opts.deleteUntracked) {
    const again = await confirmModal({
      title: '删除未跟踪文件',
      message: String(r.error || '这个文件尚未被 Git 跟踪。撤销将删除该文件。') + `\n\n${f.path}\n\n此操作不可恢复。`,
      okText: '删除文件',
      danger: true,
    });
    if (!again || revision !== scopeRevision) return;
    r = await restoreGitPath(f.path, { ...opts, deleteUntracked: true }, conversationId);
  }

  if (revision !== scopeRevision) return;
  if (!r || r.network) {
    toast('无法连接后端，撤销未执行。', 'error');
    return;
  }
  if (!r.ok) {
    toast(r.error || '撤销失败', 'error');
    return;
  }

  toast(restoreDoneText(r.action), 'info');
  await refreshGitNow();
}

/** 把后端的 action 翻成一句人话。action 可能是 `unstaged-` 前缀的复合值。 */
function restoreDoneText(action) {
  const a = String(action || '');
  const unstaged = a.startsWith('unstaged');
  const tail = unstaged ? a.slice('unstaged-'.length) : a;

  let core;
  if (tail === 'deleted-untracked') core = '已删除未跟踪文件';
  else if (tail === 'restored-deleted') core = '已恢复被删除的文件';
  else if (tail === 'restored') core = '已撤销该文件的改动';
  else core = '已取消暂存';

  return unstaged && core !== '已取消暂存' ? '已取消暂存并' + core.replace(/^已/, '') : core;
}

/* ---------- 撤销全部 ---------- */

/** 撤销整个工作区的改动。
 *
 * 三段式，每一段都必要：
 *   1. **干跑**拿后端的权威计划。不让前端按自己那份可能过期的列表算 ——
 *      「对话框里写的」和「真正会发生的」必须是同一件事。
 *   2. **一次确认**，把三件事一起摊开：恢复几个、取消暂存几个、删几个。
 *      有未跟踪文件时给第二条路径「仅撤销已跟踪文件」，因为「撤销改动」和
 *      「删掉新文件」是两个不同的意愿，不该捆成一个按钮。
 *   3. 带授权执行，然后如实汇报结果（恢复了多少、多少没处理、多少要手动）。 */
async function restoreAll() {
  const conversationId = gitConversationScope(), revision = scopeRevision;
  if (restoringAll) return;
  restoringAll = true;
  syncRestoreAllBtn(S.changes);

  try {
    const plan = await restoreAllGitPaths({}, conversationId);
    if (revision !== scopeRevision) return;

    if (!plan || plan.network) {
      toast('无法连接后端，未执行。', 'error');
      return;
    }
    if (plan.ok && plan.total === 0) {
      toast('工作区已经是干净的。', 'info');
      return;
    }
    if (!plan.ok && !plan.needsPlan) {
      toast(plan.error || '无法读取变更', 'error');
      return;
    }

    const p = plan.plan || {};
    const nPlain = (p.plain || []).length;
    const nStaged = (p.staged || []).length;
    const nUntracked = (p.untracked || []).length;
    const nSkip = (p.skipped || []).length;

    const choice = await confirmModal({
      title: '撤销全部改动',
      message: planMessage({ nPlain, nStaged, nUntracked, nSkip, p }),
      okText: nUntracked ? `撤销全部（含删除 ${nUntracked} 个文件）` : '撤销全部',
      // 有未跟踪文件时给第二条路径。「撤销改动」和「删掉新文件」是两个意愿。
      altText: nUntracked ? `仅撤销已跟踪文件（保留 ${nUntracked} 个）` : '',
      danger: true,
    });
    if (!choice || revision !== scopeRevision) return;

    /* confirmModal 的返回值：主按钮 `true`、备选 `'alt'`、取消 `false`。
     * 只有走主路径才删未跟踪文件 —— 「仅撤销已跟踪文件」这条路径存在的全部意义
     * 就是不删东西。 */
    const del = choice === true && nUntracked > 0;
    const r = await restoreAllGitPaths({ planned: true, unstage: true, deleteUntracked: del }, conversationId);
    if (revision !== scopeRevision) return;

    if (!r || r.network) {
      toast('无法连接后端，未执行。', 'error');
      return;
    }
    if (!r.ok) {
      toast(r.error || '撤销全部失败', 'error');
      return;
    }

    const parts = [`已撤销 ${r.restored.length} 个文件`];
    if (r.kept.length) parts.push(`${r.kept.length} 个因未授权被保留`);
    if (r.skipped.length) parts.push(`${r.skipped.length} 个需手动处理`);
    toast(parts.join('，'), r.kept.length || r.skipped.length ? 'warn' : 'info');

    await refreshGitNow();
  } finally {
    restoringAll = false;
    syncRestoreAllBtn(S.changes);
  }
}

/** 拼确认框正文。**把数字和路径都写出来** —— 只说「撤销全部」而
 *  不说要删几个文件，等于没问。 */
function planMessage({ nPlain, nStaged, nUntracked, nSkip, p }) {
  const lines = [];
  if (nPlain) lines.push(`· 恢复 ${nPlain} 个已修改 / 已删除的文件`);
  if (nStaged) lines.push(`· 先取消暂存，再恢复 ${nStaged} 个已暂存的文件（会改动 Git 暂存内容）`);
  if (nUntracked) lines.push(`· 删除 ${nUntracked} 个未跟踪文件（这些文件不在 Git 里，删掉无法找回）`);
  if (nSkip) lines.push(`· ${nSkip} 个文件需要手动处理（重命名 / 复制 / 冲突 / 未跟踪目录），不会被自动改动`);

  const body = ['将把工作区恢复成 Git 中的版本：', '', ...lines];

  // 删除类的路径逐条列出来。数量多时截断，但**一定给出总数**。
  if (nUntracked) {
    body.push('', '将被删除的文件：');
    for (const path of (p.untracked || []).slice(0, 20)) body.push('  ' + path);
    if (nUntracked > 20) body.push(`  …以及另外 ${nUntracked - 20} 个`);
    body.push('', '这些文件尚未被 Git 跟踪，删除后无法通过 Git 找回。');
  }

  return body.join('\n');
}
