/* 设置 › Agent 能力 › 技能 —— Pi 原生 Skills 的列表页。
 *
 * 事实来源只有 `/api/skills`（server/skills.js：扫描 + pi get_commands 交叉核对）。
 * 本页不缓存第二份清单：每次 load 整体替换 `state.data`，筛选只是对它的投影。
 * 启停写的是 pi 自己的 settings.json（`-<rel>` 停用规则），pi 只在启动时读它，
 * 所以写完要不要重启由用户在确认框里决定 —— 与拆分前的行为一致。
 *
 * 生命周期：设置详情卡关闭（返回、切到别的设置页、Esc）时 presentDetail 调 onClose，
 * 这里置 disposed 并摘掉监听；之后所有迟到的异步结果都会被丢弃。
 * 工作区换代时不自动重读（切换过程中后端可能还没就绪），而是把列表换成「项目已切换」
 * 的提示，避免对着旧项目的数据启停。 */

import { S, ownsWorkspace } from '../state.js';
import { fetchSkills, setSkillEnabled, restartBackend } from '../api.js';
import { confirmModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { createIcon } from '../ui/icons.js';
import { createSegmentedControl, createSettingsToggle } from '../ui/primitives.js';
import { resourceEl as el, resourceNote as note } from '../ui/resource-dom.js';
import { renderSkillDetail } from './detail.js';
import {
  SKILL_SCOPE_LABEL, SKILL_STATE_FILTERS, filterSkills, groupSkillsByScope, isSkillOn,
  skillGroupRoots, skillScopeCounts, skillStateMeta, skillToggleCopy,
} from './model.js';

const GROUP_TITLE = Object.freeze({ project: '项目级', user: '全局级', temporary: '临时（--skill）', other: '其他' });
const TRUST_NOTE = '当前项目未被信任，pi 在非交互模式下不会加载项目级 Skills / Extensions —— 所以项目里那些会显示成「未加载（项目未信任）」。这是 pi 的默认行为，不是配置丢了。';
const PI_SILENT_NOTE = 'pi 没有应答，所以「是否加载」这一列无法确认 —— 状态显示为「状态未知」。';
const NO_PROJECT_NOTE = '还没有选择项目 —— 现在只能看到全局技能。选一个文件夹后项目级的才会出现。';
const STALE_TEXT = '项目已切换，刷新后查看当前项目的 Skills。';
const RESTART_COPY = Object.freeze({
  title: '需要重启 pi 才生效',
  message: 'pi 只在启动时读 settings.json，所以这个改动要等 pi 重新启动才起作用。现在就重启吗？（当前会话会被恢复）',
  okText: '重启 pi',
});

/** 设置菜单「技能」旁的数字：只显示发现了几个（读失败就清空，不留旧数）。 */
function writeSkillBadge(result) {
  const badge = document.getElementById('skillCount');
  if (!badge) return;
  if (!result || result.ok === false || !result.counts) {
    badge.textContent = '';
    badge.removeAttribute('title');
    return;
  }
  const total = result.counts.total || 0;
  badge.textContent = total ? String(total) : '';
  badge.title = `发现 ${total} 个 Skill（其中已加载 ${result.counts.enabled || 0} 个）`;
}

/** 启动 / 换项目后刷新徽标。不为它单独问 pi；换代后的迟到结果丢弃。 */
export async function loadSkillsBadge() {
  const generation = S.workspaceGeneration;
  const result = await fetchSkills();
  if (ownsWorkspace(generation)) writeSkillBadge(result);
}

export function openSkillsSettings({ present }) {
  let page = null;
  present((card) => {
    card.setAttribute('aria-label', '技能');
    page = createSkillsPage(card);
  }, () => {
    page?.dispose();
    page = null;
  }, { className: 'skills-page' });
}

function textButton(label, iconName, onClick) {
  const button = el('button', 'btn ghost skills-action');
  button.type = 'button';
  if (iconName) button.append(createIcon(iconName, { size: 14, className: 'skills-action-icon' }));
  button.append(el('span', '', label));
  button.onclick = onClick;
  return button;
}

function createSkillsPage(card) {
  const state = {
    data: null, loading: false, stale: false, error: '', diagnostics: [],
    loadedGeneration: S.workspaceGeneration,
    scope: '', status: '', query: '', openId: '', busyIds: new Set(),
  };
  let disposed = false;
  let loadToken = 0;
  let detailSeq = 0;
  let openDetail = null; // { id, data, node }：当前展开项的详情节点
  const alive = () => !disposed;

  /* ---------- 骨架：只建一次，筛选与刷新不重建输入框（焦点和输入法状态不丢） ---------- */
  const head = el('header', 'skills-head');
  const copy = el('div', 'skills-head-copy');
  copy.append(el('h3', 'settings-page-title', '技能'),
    el('p', 'settings-page-desc', 'Pi 在全局与项目目录中发现的技能。启停会写入对应的 settings.json，重启 Pi 后生效。'));
  const actionsBox = el('div', 'skills-head-actions');
  const refresh = textButton('刷新', 'refresh', () => load());
  actionsBox.append(refresh);
  head.append(copy, actionsBox);

  const toolbar = el('div', 'skills-toolbar');
  const scopeControl = createSegmentedControl({
    ariaLabel: '按作用域筛选',
    value: '',
    options: [
      { value: '', label: '全部' },
      { value: 'project', label: SKILL_SCOPE_LABEL.project },
      { value: 'user', label: SKILL_SCOPE_LABEL.user },
      { value: 'temporary', label: SKILL_SCOPE_LABEL.temporary },
    ],
    onChange: (value) => { state.scope = value; renderBody(); },
  });
  scopeControl.element.classList.add('skills-scope');
  const statusSelect = el('select', 'ds-select skills-status');
  statusSelect.setAttribute('aria-label', '按状态筛选');
  for (const option of SKILL_STATE_FILTERS) {
    const item = el('option', '', option.label);
    item.value = option.value;
    statusSelect.append(item);
  }
  statusSelect.onchange = () => { state.status = statusSelect.value; renderBody(); };
  const search = el('label', 'skills-search ds-search-field ds-search-control');
  search.append(createIcon('search', { size: 14, className: 'skills-search-icon' }));
  const searchInput = el('input', 'skills-search-input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索名称 / 描述 / 路径…';
  searchInput.setAttribute('aria-label', '搜索技能');
  searchInput.oninput = () => { state.query = searchInput.value; renderBody(); };
  search.append(searchInput);
  toolbar.append(scopeControl.element, statusSelect, search);

  const notes = el('div', 'skills-notes');
  const body = el('div', 'skills-body');
  body.setAttribute('aria-live', 'polite');
  card.append(head, toolbar, notes, body);

  /* ---------- 渲染 ---------- */
  function syncScopeCounts() {
    const counts = skillScopeCounts(state.data?.skills);
    for (const button of scopeControl.element.querySelectorAll('.ds-segment-item')) {
      const value = button.dataset.value;
      const label = value ? SKILL_SCOPE_LABEL[value] : '全部';
      const count = value ? counts[value] : counts.all;
      button.querySelector('.ds-segment-label').textContent = state.data ? `${label} ${count}` : label;
      if (value === 'temporary') button.hidden = !counts.temporary;
    }
    if (state.scope === 'temporary' && !counts.temporary) {
      state.scope = '';
      scopeControl.setValue('');
    }
  }

  function renderNotes() {
    notes.replaceChildren();
    const data = state.data;
    if (!data) {
      for (const d of state.diagnostics) notes.append(note(d.message, 'warn'));
      return;
    }
    if (data.hasProject === false) notes.append(note(NO_PROJECT_NOTE, 'dim'));
    if (data.piReachable === false) notes.append(note(PI_SILENT_NOTE, 'warn'));
    for (const d of data.diagnostics || []) notes.append(note(d.message, 'warn'));
    if (data.trust && data.trust.requiresTrust && !data.trust.trusted) notes.append(note(TRUST_NOTE, 'warn'));
  }

  function emptyState(text, actionLabel) {
    const box = el('div', 'ext-empty skills-empty', text);
    if (actionLabel) {
      const retry = el('button', 'btn tiny', actionLabel);
      retry.type = 'button';
      retry.onclick = () => load();
      box.append(retry);
    }
    return box;
  }

  function renderBody() {
    if (disposed) return;
    body.replaceChildren();
    if (state.loading && !state.data) { body.append(emptyState('正在读取 Skills…')); return; }
    if (state.stale) { body.append(emptyState(STALE_TEXT, '刷新')); return; }
    if (state.error) { body.append(emptyState(state.error, '重试')); return; }
    const all = state.data?.skills || [];
    const items = filterSkills(all, { scope: state.scope, state: state.status, query: state.query });
    if (!items.length) { body.append(emptyState(all.length ? '没有符合筛选条件的 Skill' : '没有发现 Skill')); return; }
    for (const group of groupSkillsByScope(items)) body.append(renderGroup(group));
  }

  function renderGroup({ scope, items }) {
    const section = el('section', 'skills-group');
    const title = el('h4', 'skills-group-title', GROUP_TITLE[scope] || GROUP_TITLE.other);
    title.id = `skillsGroup-${scope}`;
    section.setAttribute('aria-labelledby', title.id);
    const groupHead = el('header', 'skills-group-head');
    groupHead.append(title, el('span', 'skills-group-count', String(items.length)));
    const roots = skillGroupRoots(items).join(' · ');
    if (roots) {
      const rootText = el('span', 'skills-group-roots', roots);
      rootText.title = roots;
      groupHead.append(rootText);
    }
    const list = el('div', 'skills-rows');
    list.setAttribute('role', 'list');
    for (const skill of items) list.append(renderRow(skill));
    section.append(groupHead, list);
    return section;
  }

  function renderRow(skill) {
    const meta = skillStateMeta(skill.state);
    const open = skill.id === state.openId;
    const item = el('div', 'skill-row' + (open ? ' is-open' : ''));
    item.setAttribute('role', 'listitem');
    item.dataset.skillId = skill.id;
    const line = el('div', 'skill-row-line');
    const main = el('button', 'skill-row-main');
    main.type = 'button';
    main.setAttribute('aria-expanded', String(open));
    const detailId = `skillDetail-${skill.id}`;
    main.setAttribute('aria-controls', detailId);
    const dot = el('span', 'ext-dot ' + meta.dot);
    dot.title = meta.label;
    const text = el('span', 'skill-row-text');
    const titleLine = el('span', 'skill-row-title');
    titleLine.append(el('span', 'skill-name', skill.name));
    if (skill.state !== 'enabled') titleLine.append(el('span', 'ext-badge', meta.label));
    if (skill.source === 'local') titleLine.append(el('span', 'ext-badge', '来自 settings'));
    if (skill.disableModelInvocation) titleLine.append(el('span', 'ext-badge', '不进系统提示词'));
    text.append(titleLine, el('span', 'skill-row-desc', skill.description || '（没有描述）'));
    if (skill.state !== 'enabled' && skill.stateNote) text.append(el('span', 'skill-row-note', skill.stateNote));
    main.append(dot, text);
    main.onclick = () => {
      state.openId = open ? '' : skill.id;
      renderBody(); // 行会重建：把焦点还给同一行，键盘用户不丢位置
      [...body.querySelectorAll('.skill-row')].find((row) => row.dataset.skillId === skill.id)
        ?.querySelector('.skill-row-main')?.focus();
    };
    line.append(main);
    if (skill.toggleable) line.append(renderToggle(skill));
    item.append(line);
    if (open) item.append(openDetailFor(skill, detailId));
    return item;
  }

  /* 筛选 / 输入搜索词会整表重绘；展开项的详情（含已读到的 SKILL.md）原样挪进新行，
   * 只有换了展开项或重读了清单才重建并重新请求 —— 与拆分前「只在选中时读详情」一致。 */
  function openDetailFor(skill, detailId) {
    if (openDetail && openDetail.id === skill.id && openDetail.data === state.data) return openDetail.node;
    const node = el('div', 'skill-detail');
    node.id = detailId;
    const seq = ++detailSeq;
    const generation = state.loadedGeneration;
    renderSkillDetail(node, skill, () => alive() && seq === detailSeq && ownsWorkspace(generation) && !state.stale);
    openDetail = { id: skill.id, data: state.data, node };
    return node;
  }

  function renderToggle(skill) {
    const control = createSettingsToggle({
      checked: isSkillOn(skill),
      disabled: state.busyIds.has(skill.id),
      ariaLabel: `启用技能 ${skill.name}`,
      onChange: (want) => { void toggleSkill(skill, want, control); },
    });
    control.element.classList.add('skill-toggle');
    return control.element;
  }

  /* ---------- 启停：确认 → 写 settings → 询问是否重启 pi → 重读 ---------- */
  async function toggleSkill(skill, want, control) {
    const generation = state.loadedGeneration;
    const ok = await confirmModal(skillToggleCopy(skill, want));
    if (!alive()) return;
    if (!ok) { control.setChecked(!want); return; }
    if (state.stale || !ownsWorkspace(generation)) { control.setChecked(!want); markStale(); return; }
    state.busyIds.add(skill.id);
    control.setDisabled(true);
    const result = await setSkillEnabled(skill.id, want);
    state.busyIds.delete(skill.id);
    if (!alive()) return;
    control.setDisabled(false);
    if (!result || !result.ok) {
      control.setChecked(!want);
      toast((result && result.error) || '操作失败', 'error');
      return;
    }
    for (const warning of result.warnings || []) toast(warning, 'warn');
    if (result.restartRequired) {
      const go = await confirmModal(RESTART_COPY);
      if (go && alive() && ownsWorkspace(generation)) {
        await restartBackend();
        toast('已请求重启 pi，稍等一下', 'info');
      }
    } else {
      toast('设置没有变化', 'info');
    }
    if (alive()) await load();
  }

  /* ---------- 读取 ---------- */
  function markStale() {
    if (disposed) return;
    state.stale = true;
    renderBody();
  }

  async function load() {
    const token = ++loadToken;
    const generation = S.workspaceGeneration;
    state.loading = true;
    refresh.disabled = true;
    if (!state.data) renderBody();
    const result = await fetchSkills();
    if (disposed || token !== loadToken) return;
    state.loading = false;
    refresh.disabled = false;
    if (!ownsWorkspace(generation)) { markStale(); return; }
    state.stale = false;
    state.loadedGeneration = generation;
    if (!result || result.ok === false) {
      state.data = null;
      state.error = (result && result.error) || '读取 Skills 失败';
      state.diagnostics = (result && result.diagnostics) || [];
    } else {
      state.data = result;
      state.error = '';
      state.diagnostics = [];
      if (state.openId && !(result.skills || []).some((skill) => skill.id === state.openId)) state.openId = '';
    }
    syncScopeCounts();
    renderNotes();
    renderBody();
    writeSkillBadge(result); // 页面刚读到的数字顺手同步给菜单徽标，省一次请求
  }

  const onGeneration = () => { if (!disposed && state.data) markStale(); };
  document.addEventListener('pi-gui:workspace-generation', onGeneration);
  syncScopeCounts();
  void load();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      loadToken += 1;
      detailSeq += 1;
      openDetail = null;
      document.removeEventListener('pi-gui:workspace-generation', onGeneration);
    },
  };
}
