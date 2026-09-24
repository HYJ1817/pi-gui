/* 工具调用卡片。
 *
 * pi 的事件：tool_execution_start → (update)* → end。
 * 注意 **partialResult 是累积值不是增量**，直接整体替换即可（见 onToolUpdate）。
 *
 * 「哪些文件被改过」这件事不在这里维护 —— 统一交给 changes.js 的账本，
 * 本文件只负责在工具结束时把参数转交过去。这样将来加 diff 面板时，
 * 消费方订阅账本即可，不必依赖工具卡片的渲染细节。 */

import { S } from './state.js';
import { ICONS } from './util.js';
import { recordToolChange } from './changes.js';
import { scheduleGitRefresh } from './git.js';
import { ensureThread, moveWorkingToEnd, resultText, scrollBottom } from './messages.js';

/* 会改动磁盘、因而值得重读 Git 状态的工具。
 *
 * write / edit 是明确的。bash 单列进来的理由：它改文件的方式太多
 * （`> file`、`sed -i`、`mv`、`rm`、装依赖…），靠解析命令去猜「这次到底改没改」
 * 既不可靠也不值得；而刷新本身是**只读 + 防抖**的，多刷一次的代价远小于
 * 「Agent 明明改了文件，Changes 里却没有」。 */
const REFRESH_TOOLS = new Set(['write', 'edit', 'bash']);

export const TOOL_META = {
  bash: { label: '执行命令', icon: 'terminal' },
  read: { label: '读取文件', icon: 'file' },
  write: { label: '写入文件', icon: 'file' },
  edit: { label: '编辑文件', icon: 'edit' },
  glob: { label: '查找文件', icon: 'search' },
  grep: { label: '搜索内容', icon: 'search' },
};

export function summarizeArgs(name, args) {
  if (!args) return '';
  if (typeof args === 'string') return args;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query']) {
    if (typeof args[k] === 'string') return args[k];
  }
  const first = Object.values(args).find((v) => typeof v === 'string');
  return first || JSON.stringify(args).slice(0, 90);
}

/* 改动类工具的判定与路径提取在 changes.js（那里是账本的唯一归属）。
 * 本模块只消费它，不再对外转出 —— 项目约定不使用 re-export。 */

export function onToolStart(evt) {
  const t = ensureThread();
  const meta = TOOL_META[evt.toolName] || { label: evt.toolName, icon: 'tool' };

  const card = document.createElement('div');
  card.className = 'tool running';
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-icon">${ICONS[meta.icon] || ICONS.tool}</span>
      <span class="tool-name"></span>
      <span class="tool-args"></span>
      <span class="tool-state">运行中</span>
    </div>
    <pre class="tool-out"></pre>`;

  card.querySelector('.tool-name').textContent = meta.label;
  card.querySelector('.tool-args').textContent = summarizeArgs(evt.toolName, evt.args);
  card.querySelector('.tool-head').onclick = () => card.classList.toggle('open');

  t.appendChild(card);
  S.tools.set(evt.toolCallId, card);
  /* 把工具名与参数寄存在卡片上。
   *
   * tool_execution_end 事件**不保证**带 toolName / args（实测 end 只有
   * toolCallId / result / isError），而记账两样都要。存在卡片上比再开一张
   * toolCallId → 元数据 的表要省事，卡片一被回收，寄存也就跟着没了。 */
  card._tool = evt.toolName;
  card._args = evt.args;
  moveWorkingToEnd();
  scrollBottom(true);
}

export function onToolUpdate(evt) {
  const card = S.tools.get(evt.toolCallId);
  if (!card) return;
  // partialResult 是累积值，直接替换
  const text = resultText(evt.partialResult);
  if (!text) return;
  const out = card.querySelector('.tool-out');
  if (!out) return;
  out.textContent = text;
  card.classList.add('open');
  scrollBottom();
}

export function onToolEnd(evt) {
  const card = S.tools.get(evt.toolCallId);
  if (!card) return;

  card.classList.remove('running');
  card.classList.add(evt.isError ? 'err' : 'done');
  card.querySelector('.tool-state').textContent = evt.isError ? '失败' : '完成';

  const text = resultText(evt.result);
  const out = card.querySelector('.tool-out');
  if (text && out) {
    out.textContent = text;
  } else if (out) {
    out.remove();
    const empty = document.createElement('div');
    empty.className = 'tool-empty';
    empty.textContent = '无输出';
    card.appendChild(empty);
  }

  // 记一笔「改动了哪些文件」。只在成功时记 —— 失败的工具没真正改到磁盘，
  // 记进去会让将来的变更列表出现幽灵条目。
  const tool = card._tool || evt.toolName;
  if (!evt.isError) {
    recordToolChange(tool, card._args);
    /* 顺带安排一次 Git 状态刷新（防抖 450ms）。一次 Agent 回合里连改 5 个文件
     * 只会产生 1 次 git status —— 见 git.js 的 scheduleGitRefresh。 */
    if (REFRESH_TOOLS.has(tool)) scheduleGitRefresh();
  }

  S.tools.delete(evt.toolCallId);
  moveWorkingToEnd();
  scrollBottom();
}
