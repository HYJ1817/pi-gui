/* 应用外壳状态：连接指示、状态文案、标题，以及「有没有项目」决定的整体形态。
 *
 * 单独成模块的原因：这几个东西被 rpc.js、usage.js、projects.js 同时需要，
 * 而它们本身又不属于任何一个业务域。放在这里可以避免
 * projects → app → projects 这类循环。 */

import { el, S, ownsWorkspace } from './state.js';
import { fetchStatus } from './api.js';
import { updateSendState } from './composer.js';

export function setConn(kind, text) {
  el.conn.className = 'conn' + (kind ? ' ' + kind : '');
  el.connText.textContent = text;
}

export function setStatus(text) {
  el.statusText.textContent = text || '';
}

export function setBridgeState(state, detail = '') {
  S.bridgeState = state;
  const labels = {
    'no-project': ['', '未选择项目'],
    starting: ['busy', '正在启动 pi…'],
    ready: ['ok', '已连接'],
    restarting: ['busy', '正在重启 pi…'],
    exited: ['bad', detail || 'pi 已退出'],
    error: ['bad', 'pi 启动失败'],
  };
  const [kind, label] = labels[state] || ['', detail];
  setConn(kind, label);
  applyProjectState();
}

export function setTitleText(t) {
  if (!t) return;
  el.title.textContent = t;
}

/** 「有没有项目」决定整块界面的形态。
 *
 * 没有项目时 pi 是不启动的，任何命令都会 503。所以这里必须把输入区锁掉并
 * 换成引导文案 —— 否则用户对着一个看起来能输入、按了却只弹错误提示的界面，
 * 只会以为是程序坏了。
 *
 * 幂等：loadStatus / 增删项目后都会调，重复调用无副作用。 */
export function applyProjectState() {
  const ready = S.hasProject;
  const canUse = ready && !S.switching && S.bridgeState === 'ready';
  el.welcomeRestore.hidden = !S.restoring;
  el.welcomeReady.hidden = S.restoring || !ready;
  el.welcomeNoProj.hidden = S.restoring || ready;
  el.composerBox.classList.toggle('is-locked', !canUse);
  el.input.disabled = !canUse;
  el.input.placeholder = !ready ? '先添加一个文件夹' : S.switching ? '正在切换项目…' : canUse ? '随心输入' : '等待 pi 就绪…';
  el.btnAttach.disabled = !canUse;
  el.btnModel.disabled = !canUse;
  el.btnThink.disabled = !canUse;
  updateSendState();
}

/** 回读 /api/status。
 *  S.cwd 用于把相对路径补成绝对路径；hasProject 决定输入框解不解锁。 */
export async function loadStatus(generation = S.workspaceGeneration) {
  const j = await fetchStatus();
  if (!ownsWorkspace(generation)) return;
  S.restoring = false;
  if (j && j.ok !== false) {
    S.cwd = j.cwd || '';
    // hasProject 由后端显式给出；老后端没有这个字段时退回「cwd 非空」的判断
    S.hasProject = j.hasProject ?? Boolean(S.cwd);
    if (!S.switching && Number.isInteger(j.bridgeRun)) S.bridgeRun = j.bridgeRun;
  } else {
    S.cwd = '';
    S.hasProject = false;
  }
  applyProjectState();
}
