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
 * revert，账本还留着记录而工作区已经干净了。所以界面上的数字（侧栏 Changes N）
 * 一律来自这里，账本只用于将来做「本次会话的改动摘要」。
 *
 * ---------- 这一版刻意不做的事 ----------
 *   不做代码编辑器（打开文件交给系统默认程序）、不做 side-by-side、不做
 *   merge conflict 编辑、不做 commit/push/branch。定位是
 *   Coding Agent Workspace 的「看到改了什么 → 决定留还是撤」，不是 IDE。
 *
 * 依赖方向：tools.js → git.js（单向）。本文件不引 tools.js / changes.js，
 * 免得和账本形成环。
 */

import { el, panels, S } from './state.js';
import { fetchGitDiff, fetchGitStatus, resolveGitOpenTarget, restoreGitPath } from './api.js';
import { toast } from './ui/toast.js';
import { confirmModal, openModal } from './ui/modal.js';
import { countDiffLines, diffHtml } from './diff.js';

/* 自动刷新的防抖窗口。
 *
 * 落在需求给的 300~800ms 区间里，取中值：太短则一次 Agent 连续改 5 个文件会
 * 触发 5 次 git status（每次都要起几个 git 进程），太长则用户觉得「改完了半天
 * 没反应」。450ms 对这两者都够用。 */
const REFRESH_DEBOUNCE_MS = 450;

/* 一次会话里可能连续发生几十次改动，所以只留一个定时器 —— 后一次调用把前一次
 * 顶掉，于是「连续 N 次操作」只产生 1 次刷新。 */
let refreshTimer = null;

const STATUS_LABEL = {
  M: '已修改',
  A: '新增',
  D: '已删除',
  R: '重命名',
  C: '复制',
  U: '冲突',
  '??': '未跟踪',
};

/* ---------- 状态 ---------- */

function blankChanges() {
  return {
    isRepo: false,
    loaded: false,
    files: [],
    error: '',
    noGit: false,
    noProject: false,
    truncated: false,
  };
}

/** 拉一次 Git 工作区状态，写进 S.changes 并更新侧栏徽标。
 *  永远不抛：网络失败也落到「结构化错误」上，界面显示降级文案而不是崩掉。 */
export async function loadGitStatus() {
  const c = S.changes;
  const j = await fetchGitStatus();

  c.loaded = true;

  if (!j || j.network) {
    // 后端连不上时保留上一次的文件列表会让数字骗人，索性清空
    c.isRepo = false;
    c.files = [];
    c.noGit = false;
    c.noProject = false;
    c.truncated = false;
    c.error = '无法连接后端，变更信息暂不可用。';
    renderChangesBadge();
    return c;
  }

  c.noGit = Boolean(j.noGit);
  c.noProject = Boolean(j.noProject);
  c.isRepo = Boolean(j.isRepo);
  c.files = Array.isArray(j.files) ? j.files : [];
  c.truncated = Boolean(j.truncated);
  c.error = j.ok === false ? String(j.error || '读取 Git 状态失败') : '';

  renderChangesBadge();
  return c;
}

/** 换项目时清空 —— 上一个项目的变更列表留在界面上是纯粹的误导。 */
export function resetChanges() {
  Object.assign(S.changes, blankChanges());
  renderChangesBadge();
}

/** 侧栏徽标。0 条时隐藏而不是显示 0 —— 常态是「干净」，不该常驻一个数字。 */
export function renderChangesBadge() {
  if (!el.changesCount) return;
  const n = S.changes.files.length;
  el.changesCount.textContent = n ? String(n) : '';
  el.changesCount.hidden = n === 0;
}

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
  await loadGitStatus();
  renderChangesBody();
}

/* ---------- 面板 ---------- */

export function openChangesPanel() {
  openModal((card, close) => {
    card.classList.add('changes');

    const head = document.createElement('div');
    head.className = 'chg-head';

    const h = document.createElement('h3');
    h.textContent = '文件变更';

    const sub = document.createElement('span');
    sub.className = 'chg-sub';
    sub.textContent = 'Git 工作区 · 磁盘真实状态';

    const grow = document.createElement('span');
    grow.className = 'grow';

    const btnRefresh = document.createElement('button');
    btnRefresh.type = 'button';
    btnRefresh.className = 'btn tiny';
    btnRefresh.textContent = '刷新';
    btnRefresh.onclick = () => refreshGitNow();

    head.append(h, sub, grow, btnRefresh);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'chg-body';
    card.appendChild(body);

    /* 弹层里的动态容器。关闭时 modal.js 会把它置回 null，
     * 于是「异步结果晚到」的情况会自然落空，不会往已卸载的节点里写。 */
    panels.changes = body;

    renderChangesBody();
  });

  // 打开就用最新数据重画一次（先用已有状态垫一帧，避免空白等待）
  loadGitStatus().then(renderChangesBody);
}

/** 重画面板内容。`panels.changes` 为空（面板没开 / 已关）时直接返回。 */
export function renderChangesBody() {
  const box = panels.changes;
  if (!box) return;

  box.innerHTML = '';
  const c = S.changes;

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
  if (!c.isRepo) {
    box.appendChild(hint('当前项目不是 Git 仓库，没有可比较的文件变更。\n聊天与代码修改不受影响。'));
    return;
  }
  if (c.error) {
    box.appendChild(hint('读取 Git 状态失败：' + c.error, 'err'));
    return;
  }
  if (!c.files.length) {
    box.appendChild(hint('工作区干净 · No changes'));
    return;
  }

  const list = document.createElement('div');
  list.className = 'chg-list';
  for (const f of c.files) list.appendChild(changeRow(f));
  box.appendChild(list);

  if (c.truncated) box.appendChild(hint('变更列表过长，已截断显示。', 'warn'));
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

function changeRow(f) {
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

  main.append(code, info, stat);

  const acts = document.createElement('span');
  acts.className = 'chg-acts';
  acts.append(
    tinyBtn('打开', () => openFile(f)),
    tinyBtn(f.untracked ? '删除' : '撤销', () => restoreFile(f), 'danger')
  );

  row.append(main, acts);

  const diffBox = document.createElement('div');
  diffBox.className = 'chg-diff';
  diffBox.dataset.role = 'diff';
  diffBox.hidden = true;
  row.appendChild(diffBox);

  /* 点击行 = 就地展开 unified diff。
   * 用「就地展开」而不是再开一层弹层：diff 常常要对照着文件列表看，
   * 而且嵌套弹层的返回路径（Esc 关哪一层）很容易做错。 */
  let loaded = false;
  let busy = false;
  main.onclick = async () => {
    if (!diffBox.hidden) {
      diffBox.hidden = true;
      row.classList.remove('open');
      return;
    }
    diffBox.hidden = false;
    row.classList.add('open');
    if (loaded || busy) return;

    busy = true;
    diffBox.innerHTML = '';
    diffBox.appendChild(hint('正在读取差异…'));

    const r = await fetchGitDiff(f.path);
    busy = false;
    loaded = true;

    // 后端没给出增删行数时（未跟踪文件超限被跳过），从 diff 正文里补一次
    if (!f.binary && f.additions === null && f.deletions === null && r && r.ok) {
      const n = countDiffLines(String(r.working || '') + String(r.staged || ''));
      if (n.add || n.del) fillStat(stat, n.add, n.del);
    }

    renderDiffInto(diffBox, r, f);
  };

  return row;
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
function diffBlock(text) {
  const d = document.createElement('div');
  d.className = 'chg-block';
  d.innerHTML = diffHtml(text);
  return d;
}

function renderDiffInto(box, r, f) {
  box.innerHTML = '';

  if (!r || r.network) {
    box.appendChild(hint('无法连接后端，读取差异失败。', 'err'));
    return;
  }
  if (!r.ok) {
    box.appendChild(hint(r.error || '读取差异失败。', 'err'));
    return;
  }
  if (r.notice) box.appendChild(hint(r.notice, 'warn'));

  const staged = String(r.staged || '');
  const working = String(r.working || '');

  /* 二进制：git 给的就是一行 `Binary files … differ`，把它当文本逐行着色没有意义，
   * 直接说明「看不了」并建议用系统编辑器打开。 */
  if (r.binary) {
    box.appendChild(hint('二进制文件，没有可显示的文本差异。用「打开」交给系统程序查看。'));
    if (r.truncated) box.appendChild(truncatedHint(r));
    return;
  }

  if (!staged.trim() && !working.trim()) {
    box.appendChild(hint('没有可显示的差异：文件内容与 Git 中的版本一致。'));
    return;
  }

  /* 暂存区与工作区分开显示 —— 只给一份的话，`MM` 这种「既暂存又改了」的文件
   * 会让人看不懂到底在跟谁比。 */
  if (staged.trim()) {
    box.appendChild(sectionLabel('暂存区（已 git add，尚未提交）'));
    box.appendChild(diffBlock(staged));
  }
  if (working.trim()) {
    box.appendChild(sectionLabel(r.untracked ? '未跟踪文件的内容' : '工作区（尚未 git add）'));
    box.appendChild(diffBlock(working));
  }

  if (r.truncated) box.appendChild(truncatedHint(r));
}

function truncatedHint(r) {
  const kb = Math.max(1, Math.round((Number(r.limit) || 0) / 1024));
  return hint(`差异过大，已截断（上限 ${kb} KB）。完整内容请用系统编辑器打开该文件。`, 'warn');
}

/* ---------- 打开 / 撤销 ---------- */

/** 用系统默认程序打开。
 *
 * **不在 Pi GUI 里做编辑器**（需求明确）：这里只负责把「请打开这个项目内文件」
 * 递出去。桌面版走 preload 暴露的桥（主进程 shell.openPath），网页版没有这个
 * 能力，就退化成「把绝对路径告诉用户」。 */
async function openFile(f) {
  const bridge = globalThis.piGuiDesktop;

  if (bridge && typeof bridge.openPath === 'function') {
    let r;
    try {
      r = await bridge.openPath(f.path);
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

/** 撤销单个文件的改动。危险操作，一律先二次确认。 */
async function restoreFile(f) {
  const untracked = Boolean(f.untracked);

  const ok = await confirmModal({
    title: untracked ? '删除未跟踪文件' : '撤销文件改动',
    message: untracked
      ? `这个文件尚未被 Git 跟踪。撤销将删除该文件。\n\n${f.path}\n\n此操作不可恢复。`
      : `将把下面的文件恢复成 Git 中的版本，该文件上尚未提交的改动会丢失。\n\n${f.path}`,
    okText: untracked ? '删除文件' : '撤销改动',
    danger: true,
  });
  if (!ok) return;

  let r = await restoreGitPath(f.path, untracked);

  /* 后端以**它此刻看到的**状态为准。若它认为还需要确认（客户端的列表过期了，
   * 例如文件刚变成未跟踪），就把后端的原话再问一次 —— 但只追问一轮，
   * 不做循环重试，免得出现「点了取消却反复弹」这种失控形态。 */
  if (r && r.needsConfirm && !untracked) {
    const again = await confirmModal({
      title: '删除未跟踪文件',
      message: String(r.error || '这个文件尚未被 Git 跟踪。撤销将删除该文件。') + `\n\n${f.path}\n\n此操作不可恢复。`,
      okText: '删除文件',
      danger: true,
    });
    if (!again) return;
    r = await restoreGitPath(f.path, true);
  }

  if (!r || r.network) {
    toast('无法连接后端，撤销未执行。', 'error');
    return;
  }
  if (!r.ok) {
    toast(r.error || '撤销失败', 'error');
    return;
  }

  toast(r.action === 'deleted-untracked' ? '已删除未跟踪文件' : '已撤销该文件的改动', 'info');
  await refreshGitNow();
}
