/* 统一的 capability setup 布局（P22）。
 *
 * ---------- 为什么要有它 ----------
 *
 * P16 / P17 / P18 / P20 各自画了一遍「设置区」，四份几乎一样的 DOM：标题、状态行、
 * 固定安装命令、复制、安装后重启、运行观察、限制说明。四份实现意味着**四套措辞**
 * —— 同一个 `loaded` 在一处叫「加载状态已确认」、在另一处叫「加载状态：已验证」，
 * 用户没法把它们当同一件事读。
 *
 * 所以这里做**唯一一套布局**：调用方给一份**已经算好的视图模型**
 * （`capability-model.js` 的 `setupViewModel()`），这里只负责把它画出来。
 * 布局本身不含任何判定 —— 「算不出来」的东西在这一层不可能被画出来。
 *
 * ---------- 与 feature 模块的分工（不许破坏 feature module）----------
 *
 * `web-access.js` / `subagents.js` / `memory.js` / `browser.js` 继续**拥有**自己的
 * 事实来源、安装命令、观察入口与措辞；它们只是把 descriptor 交给这里渲染。
 * 也就是说：这一层换了，feature 模块的语义一个都没换。
 *
 * ---------- 重启只有一条路 ----------
 *
 * 「安装后重启 Pi」全仓库只有**一处**实现（就是下面这个 `restartPiButton()`）：
 * 先 `confirmModal`，再校验 `ownsWorkspace(generation)`，最后调既有的
 * `restartBackend()`。切了项目就什么都不做 —— **绝不对着新项目重启**。
 *
 * ---------- 一键安装（P24 收口）----------
 *
 * 「安装」按钮也全仓库只有**这一处**实现。它做四件事，顺序固定：
 *   1. `confirmModal` —— 先把命令、权限、安装范围（用户级）说清楚，再动手；
 *   2. `POST /api/capabilities/install`，body **只送 capabilityId** ——
 *      包名由后端固定 allowlist 决定，这一层不送也不认识 source；
 *   3. 按钮状态机 `安装 → 安装中… → 正在重启… → 已安装 / 安装失败`，
 *      期间 disabled（后端另有一把单飞锁，前端 disabled 只是体验）；
 *   4. 成功后**不宣布「已加载」** —— 只重新读一遍 Extension Registry，
 *      界面按重新拿到的证据重画。
 * 「复制安装命令」继续保留，作为高级 / 故障恢复入口。
 */
import { S, ownsWorkspace } from '../state.js';
import { restartBackend, installCapability } from '../api.js';
import { confirmModal } from './modal.js';
import { toast } from './toast.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 复制到剪贴板。失败不抛 —— 有些环境下剪贴板 API 不可用。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'info');
    return true;
  } catch {
    toast('复制失败，请手工选中', 'warn');
    return false;
  }
}

export function copyButton(text, label = '复制') {
  const button = el('button', 'btn tiny', label);
  button.type = 'button';
  button.onclick = () => copyText(text);
  return button;
}

/**
 * 「安装后重启 Pi」——**全仓库唯一实现**。
 * @param message 确认框正文（各 feature 用自己那句，因为要说明各自不做的事）
 */
export function restartPiButton(message) {
  const button = el('button', 'btn tiny', '安装后重启 Pi');
  button.type = 'button';
  button.onclick = async () => {
    const generation = S.workspaceGeneration;
    const ok = await confirmModal({ title: '重启 Pi？', message, okText: '重启 Pi' });
    if (!ok || !ownsWorkspace(generation)) return;
    button.disabled = true;
    try {
      const result = await restartBackend();
      if (ownsWorkspace(generation)) {
        toast(result?.ok ? '正在重启 Pi' : '重启失败，可重试', result?.ok ? 'info' : 'warn');
      }
    } catch {
      if (ownsWorkspace(generation)) toast('重启失败，可重试', 'warn');
    } finally {
      button.disabled = false;
    }
  };
  return button;
}

function row(label, value) {
  const line = el('div', 'ext-row');
  /* `data-k` 是给测试与无障碍读的稳定钩子：文案会变，这一格的名字不会。 */
  line.dataset.k = label;
  line.appendChild(el('span', 'ext-row-k', label));
  const text = el('span', 'ext-row-v', value);
  text.title = String(value);
  line.appendChild(text);
  return line;
}

/* ---------- 一键安装 ---------- */

/** 按钮的静止文案。`data-install-state` 才是判据（文案会变，状态名不会）。 */
const INSTALL_IDLE_LABEL = { install: '安装', recheck: '重新检查', installed: '已安装' };

/**
 * 跑一次受控安装。**任何一步失败都不伪造成功**：按钮进「安装失败」，
 * 提示用后端给的**脱敏**文案（原始 stdout/stderr 从不进 DOM）。
 */
async function runInstall(model, button, options) {
  const generation = S.workspaceGeneration;
  const confirm = model.installConfirm || {};
  const ok = await confirmModal({ title: confirm.title, message: confirm.message, okText: confirm.okText || '安装' });
  if (ok !== true || !ownsWorkspace(generation)) return;
  const setState = (state, label) => {
    button.dataset.installState = state;
    button.textContent = label;
  };
  button.disabled = true;
  setState('installing', '安装中…');
  try {
    const result = await installCapability(model.installId);
    if (!ownsWorkspace(generation)) return;
    if (!result || result.ok !== true) {
      setState('failed', '安装失败');
      button.disabled = false;
      toast((result && result.error) || '安装失败，可重试或复制命令自己执行', 'warn');
      return;
    }
    setState('restarting', '正在重启…');
    /* ⚠️ 官方命令跑完 ≠ 装上了。**真实状态只由重新发现的 Registry 回答**：
     * 有 onRecheck（Capability 视图）就刷新一遍，按钮与状态行都按新证据重画，
     * 并且**只有在真的看到了 installed === true 时**才说「已安装」；否则如实说
     * 「尚未确认到 Extension」。没有 onRecheck 的入口（各 feature 设置区）
     * 连确认都不假装，只说明「命令已完成，刷新后按 Registry 的结果确认」。 */
    if (typeof options.onRecheck === 'function') {
      const refreshed = await options.onRecheck();
      if (!ownsWorkspace(generation)) return;
      const confirmed = Boolean(refreshed && refreshed.state && refreshed.state.installed === true);
      toast(
        confirmed
          ? '安装完成：Extension Registry 已经发现它；加载状态仍以 Pi 的实际证据为准'
          : '安装命令已完成，但 Pi GUI 尚未确认到 Extension，请刷新或查看诊断',
        confirmed ? 'info' : 'warn',
      );
      return;
    }
    setState('installed', '已安装');
    toast('安装命令已完成，Pi 正在重启；刷新后按 Extension Registry 的结果确认', 'info');
  } catch (err) {
    if (!ownsWorkspace(generation)) return;
    setState('failed', '安装失败');
    button.disabled = false;
    toast('安装失败：' + err.message, 'error');
  }
}

/**
 * 安装动作按钮。**只对「Pi GUI 明确维护的已知 capability」出现**
 * （模型层给出 `installState`，没有 installId 的能力它一定是 null）。
 */
function installAction(model, options) {
  if (!model.installState) return null;
  const button = el('button', 'btn tiny cap-install', INSTALL_IDLE_LABEL[model.installState] || '安装');
  button.type = 'button';
  button.dataset.installState = model.installState;
  if (model.installState === 'installed') {
    /* 已安装：不是一个「可以再点一次」的动作，所以 disabled。 */
    button.disabled = true;
    button.title = 'Extension Registry 已经发现了这个 Extension';
    return button;
  }
  if (model.installState === 'recheck') {
    /* installed === null 是「无法确认」，**不是「确认未安装」** —— 所以这里
     * 不提供安装，只给一次重新读取。 */
    button.title = '当前无法确认是否已安装；重新读一次 Extension Registry';
    button.onclick = () => {
      if (typeof options.onRecheck === 'function') options.onRecheck();
    };
    return button;
  }
  button.title = '用当前 Pi 的官方安装命令安装（用户级）';
  button.onclick = () => runInstall(model, button, options);
  return button;
}

/**
 * 统一 setup 区块。顺序固定，每一项都存在，但**只在有证据时才显示对应内容**：
 *
 *   名称 → 用途 → 结论（圆点 + 文案）→ 状态表（6 个统一字段）→
 *   安装 / 内置状态 → 固定官方命令（若有）+ 复制 + 安装后重启 →
 *   说明（含运行观察的纪律）→ 限制 → 证据出处 → 外链
 *
 * @param model `capability-model.js` 的 `setupViewModel(row)`
 * @param options.linkFactory 可选：把 `model.link` 变成节点的工厂
 *                （feature 模块用它复用既有的安全外链实现，避免重复一套 URL 校验）
 * @param options.onRecheck   可选：安装成功后重新读取证据的回调（Capability 视图传
 *                「重新加载这一页」）。**没有它就不假装已确认** —— 按钮只到
 *                「已安装（命令完成）」，状态行仍按原证据显示。
 */
export function renderSetupSection(model, { linkFactory = null, onRecheck = null } = {}) {
  const options = { linkFactory, onRecheck };
  const box = el('section', 'cap-setup');

  box.appendChild(el('h4', '', model.name));
  if (model.purpose) box.appendChild(el('p', 'cap-purpose', model.purpose));

  const verdict = el('div', 'cap-verdict');
  verdict.appendChild(el('span', 'ext-dot ' + (model.status?.dot || 'dim')));
  verdict.appendChild(el('span', 'cap-verdict-text', model.status?.label || ''));
  verdict.appendChild(el('span', 'ext-badge', model.originLabel));
  box.appendChild(verdict);

  /* 状态行**只含对这个能力适用的字段**（`'n/a'` 与未声明的字段不画；
   * `null` 照旧画成「未知（无法确认）」）。判断全在模型层。 */
  const rows = el('div', 'ext-rows cap-rows');
  for (const [label, value] of model.stateRows) rows.appendChild(row(label, value));
  box.appendChild(rows);

  /* 安装 / 内置状态。**Native MCP 与 built-in 到不了这里** —— 它们的
   * installCommand 是 null，只会走下面那条「它从哪来」的说明。 */
  box.appendChild(el('div', 'ext-sec-head', model.installCommand ? '安装' : '来源'));
  box.appendChild(el('p', 'cap-note', model.installNote || ''));

  if (model.installCommand) {
    const code = el('code', '', model.installCommand);
    box.appendChild(code);
  }

  const actions = el('div', 'ext-acts');
  /* 主按钮：一键安装（只在有 installId 的已知 capability 上出现）。 */
  const install = installAction(model, options);
  if (install) actions.appendChild(install);
  /* 高级 / 故障恢复入口：复制固定官方命令，用户仍可在终端自己执行。 */
  if (model.installCommand) actions.appendChild(copyButton(model.installCommand, model.copyLabel));
  if (model.restart) actions.appendChild(restartPiButton(model.restart.message));
  /* 「查看上下文与额度」这类只读入口：模型给出 handler，这一层不发明动作。 */
  if (typeof model.onOpen === 'function') {
    const open = el('button', 'btn tiny', model.openLabel || '打开');
    open.type = 'button';
    open.onclick = () => model.onOpen();
    actions.appendChild(open);
  }
  if (actions.childElementCount) box.appendChild(actions);

  for (const note of model.notes) box.appendChild(el('p', 'cap-note', note));

  if (model.limits.length) {
    box.appendChild(el('div', 'ext-sec-head', '限制'));
    for (const limit of model.limits) box.appendChild(el('p', 'cap-note cap-limit', limit));
  }

  if (model.evidence) {
    box.appendChild(el('div', 'ext-sec-head', '出处'));
    box.appendChild(el('pre', 'ext-code quote', model.evidence));
  }
  if (model.source) box.appendChild(el('p', 'cap-source', model.source));

  if (model.link && typeof linkFactory === 'function') {
    const node = linkFactory(model.link);
    if (node) box.appendChild(node);
  }

  return box;
}
