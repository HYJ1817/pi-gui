/* 设置 › Agent 能力 › 技能 —— 技能列表、创建 / 编辑 / 导入 / 扫描、以及市场入口。
 *
 * 事实来源只有 `/api/skills`（server/skills.js：扫描 + pi get_commands 交叉核对）。
 * 本页不缓存第二份清单：每次 load 整体替换 `state.data`，筛选只是对它的投影。
 *
 * 版式对照 PI-Desktop 的 AgentSkillsPage：
 *   标题（图标 + 技能 + 数量）
 *   第一行：全部 / 全局 / 项目分段 + 搜索 + 项目选择
 *   第二行：扫描 / 新建 / 市场
 *   分组：名称 + 发现目录 + 数量 + 导入文件 / 导入目录 → 行瓦片（图标 + 名称 + 必要徽标 + 一行描述 + 开关）
 * 技术细节（路径、停用规则、加载状态、SKILL.md 全文）只收在展开详情里。
 *
 * 启停写的是 pi 自己的 settings.json；创建 / 编辑 / 删除 / 导入都落在服务端枚举过的写入目标里。
 * 所有迟到结果都由「页面未关 + 工作区代数未变 + 请求令牌」三重校验丢弃。
 *
 * 生命周期：设置详情卡关闭（返回、切到别的设置页、Esc）时 presentDetail 调 onClose，
 * 这里置 disposed 并摘掉监听；之后所有迟到的异步结果都会被丢弃。
 * 工作区换代时不自动重读，而是把列表换成「项目已切换」的提示，避免对着旧项目的数据启停。 */

import { S, ownsWorkspace } from '../state.js';
import {
  deleteSkill, fetchSkills, restartBackend, setSkillEnabled, undoSkillChange,
} from '../api.js';
import { createIcon } from '../ui/icons.js';
import { confirmModal } from '../ui/modal.js';
import { createBadge, createSegmentedControl, createSettingsToggle } from '../ui/primitives.js';
import { resourceEl as el, resourceNote as note } from '../ui/resource-dom.js';
import { renderSkillDetail } from './detail.js';
import { openSkillEditor } from './editor.js';
import { openSkillExternal } from './external.js';
import { openSkillImport } from './import.js';
import { renderSkillsMarket } from './market.js';
import {
  SKILL_SCOPE_LABEL, SKILL_SCOPE_ORDER, filterSkills, groupSkillsByScope, isSkillOn,
  marketInstalledNames, skillContextProject, skillGroupRoots, skillProjectOptions, skillScopeCounts,
  skillScopeRoots, skillScopeTitle, skillStateMeta, skillToggleCopy, skillWritableTargets,
} from './model.js';

/** 全部视图里即使为空也要出现的分组（空分组显示空状态，说明「这里没有」而不是「没读到」）。 */
const ALWAYS_SHOWN = Object.freeze(['user', 'project']);
const TRUST_NOTE = '当前项目未被信任，pi 不会加载项目级技能，项目里的技能显示为「未加载（项目未信任）」。这是 pi 的默认行为，不是配置丢了。';
const PI_SILENT_NOTE = 'pi 没有应答，加载状态无法确认，暂时显示为「状态未知」。';
const STALE_TEXT = '项目已切换，刷新后查看当前项目的技能。';
const EMPTY_DIR = '此目录中没有技能';
const EMPTY_NO_PROJECT = '还没有打开项目';
const EMPTY_FILTERED = '没有符合筛选条件的技能';
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

function actionButton(label, iconName, className, onClick) {
  const button = el('button', 'btn' + (className ? ' ' + className : ''));
  button.type = 'button';
  if (iconName) button.append(createIcon(iconName, { size: 14 }));
  button.append(el('span', '', label));
  button.onclick = onClick;
  return button;
}

function iconButton(iconName, label, onClick) {
  /* 只挂共享的 .icon-btn：再叠 .btn 会被 32px 最小高度和左右内边距挤成一条竖线。 */
  const button = el('button', 'icon-btn skills-icon-btn');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(createIcon(iconName, { size: 15 }));
  button.onclick = onClick;
  return button;
}

/** 空状态瓦片：图标片 + 一句话 + 可选说明与动作（重试 / 刷新）。 */
function emptyState(text, { icon = 'book', hint = '', action = null, className = '' } = {}) {
  const box = el('div', 'skills-empty' + (className ? ' ' + className : ''));
  const chip = el('span', 'skills-empty-icon');
  chip.append(createIcon(icon, { size: 16 }));
  box.append(chip, el('div', 'skills-empty-title', text));
  if (hint) box.append(el('div', 'skills-empty-text', hint));
  if (action) box.append(actionButton(action.label, action.icon || null, 'tiny', action.onClick));
  return box;
}

function createSkillsPage(card) {
  const state = {
    data: null, loading: false, stale: false, error: '', diagnostics: [],
    loadedGeneration: S.workspaceGeneration,
    scope: '', query: '', openId: '', busyIds: new Set(),
    project: null, view: 'list', notice: null, needsReload: false,
  };
  let disposed = false;
  let loadToken = 0;
  let detailSeq = 0;
  let openDetail = null; // { id, data, node }：当前展开项的详情节点
  let market = null;
  const alive = () => !disposed;

  /* ---------- 骨架：只建一次，筛选与刷新不重建输入框（焦点和输入法状态不丢） ---------- */
  const head = el('header', 'skills-head');
  const headGlyph = el('span', 'skills-head-glyph');
  headGlyph.append(createIcon('book', { size: 18 }));
  const headText = el('div', 'skills-head-text');
  headText.append(el('h2', 'skills-title', '技能'));
  const headCount = el('span', 'skills-head-count');
  const refresh = iconButton('refresh', '刷新技能列表', () => { void load(state.project ?? undefined); });
  head.append(headGlyph, headText, headCount, refresh);

  const toolbar = el('div', 'skills-toolbar');
  const scopeControl = createSegmentedControl({
    ariaLabel: '按作用域筛选',
    value: '',
    options: [
      { value: '', label: '全部', count: null },
      { value: 'user', label: SKILL_SCOPE_LABEL.user, count: null },
      { value: 'project', label: SKILL_SCOPE_LABEL.project, count: null },
      { value: 'temporary', label: SKILL_SCOPE_LABEL.temporary, count: null },
    ],
    onChange: (value) => { state.scope = value; renderBody(); },
  });
  scopeControl.element.classList.add('skills-scope');
  const search = el('label', 'skills-search ds-search-field ds-search-control');
  search.append(createIcon('search', { size: 14, className: 'skills-search-icon' }));
  const searchInput = el('input', 'skills-search-input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索技能';
  searchInput.setAttribute('aria-label', '搜索技能');
  searchInput.oninput = () => { state.query = searchInput.value; renderBody(); };
  search.append(searchInput);
  const projectField = el('label', 'skills-project');
  projectField.append(el('span', 'skills-project-label', '项目'));
  const projectSelect = el('select', 'ds-select skills-project-select');
  projectSelect.setAttribute('aria-label', '查看哪个项目的技能');
  projectSelect.onchange = () => { void switchProject(projectSelect.value); };
  projectField.append(projectSelect);
  toolbar.append(scopeControl.element, search, projectField);

  const actionsBar = el('div', 'skills-actions-bar');
  const scanButton = actionButton('扫描', 'scan', 'ghost', openScan);
  const createButton = actionButton('新建', 'plus', 'primary', openCreate);
  const marketButton = actionButton('市场', 'market', 'ghost', openMarket);
  actionsBar.append(scanButton, createButton, marketButton);

  const noticeHost = el('div', 'skills-notice-host');
  noticeHost.setAttribute('aria-live', 'polite');
  const notes = el('div', 'skills-notes');
  const content = el('div', 'skills-content');
  card.append(head, toolbar, actionsBar, noticeHost, notes, content);

  /* ---------- 操作结果：内联提示（成功不弹 Toast） ---------- */
  function setNotice(notice) {
    if (notice && notice.restart) {
      const details = notice.details || [];
      if (!details.some((line) => /重启/.test(line))) {
        notice = { ...notice, details: [...details, 'pi 只在启动时读 settings.json，重启后生效。'] };
      }
    }
    state.notice = notice && (notice.text || (notice.details || []).length) ? notice : null;
    renderNotice();
  }

  function renderNotice() {
    if (disposed) return;
    noticeHost.replaceChildren();
    const notice = state.notice;
    if (!notice) return;
    const box = el('div', 'skills-notice is-' + (notice.tone || 'success'));
    const glyph = el('span', 'skills-notice-icon');
    glyph.append(createIcon(notice.tone === 'error' ? 'warning' : notice.tone === 'warn' ? 'warning' : 'check', { size: 14 }));
    const body = el('div', 'skills-notice-body');
    body.append(el('div', 'skills-notice-text', notice.text || '完成'));
    for (const detail of notice.details || []) body.append(el('div', 'skills-notice-detail', detail));
    const actions = el('div', 'skills-notice-actions');
    if (notice.undo) {
      const undo = actionButton('撤销', 'refresh', 'ghost tiny', async () => {
        undo.disabled = true;
        undo.setAttribute('aria-busy', 'true');
        const result = await undoSkillChange(notice.undo);
        if (!alive()) return;
        if (!result || result.ok === false) {
          setNotice({ tone: 'error', text: (result && result.error) || '撤销失败' });
          return;
        }
        setNotice({
          tone: 'success',
          text: result.name ? `已撤销：${result.name}` : '已撤销这次改动。',
          details: result.warnings || [],
          restart: result.restartRequired === true,
        });
        await load(state.project ?? undefined);
      });
      actions.append(undo);
    }
    if (notice.restart) {
      const restart = actionButton('重启 pi', 'refresh', 'tiny', async () => {
        restart.disabled = true;
        restart.setAttribute('aria-busy', 'true');
        const result = await restartBackend();
        if (!alive()) return;
        if (!result || result.ok === false) {
          setNotice({ tone: 'error', text: (result && result.error) || '重启失败' });
          return;
        }
        setNotice({ tone: 'success', text: '已请求重启 pi，稍等一下。' });
      });
      actions.append(restart);
    }
    const close = iconButton('close', '关闭提示', () => setNotice(null));
    close.classList.add('skills-notice-close');
    actions.append(close);
    box.append(glyph, body, actions);
    noticeHost.append(box);
  }

  /**
   * 写入类操作成功后的统一收尾：内联提示 + 撤销 / 重启入口 + 重读列表。
   * 市场视图里不重建列表（市场自己会更新已安装徽标），回到列表时再重读。
   */
  function afterMutation(result, fallbackText) {
    setNotice({
      tone: 'success',
      text: result.notice || fallbackText,
      details: result.warnings || [],
      undo: typeof result.undo === 'string' ? result.undo : '',
      restart: result.restartRequired === true,
    });
    state.needsReload = true;
    if (state.view !== 'market') void load(state.project ?? undefined);
  }

  /* ---------- 读取 ---------- */
  function syncScopeCounts() {
    const counts = skillScopeCounts(state.data?.skills);
    for (const value of ['', 'user', 'project', 'temporary']) {
      scopeControl.setCount(value, state.data ? (value ? counts[value] : counts.all) : null);
    }
    scopeControl.setOptionHidden('temporary', !counts.temporary);
    if (state.scope === 'temporary' && !counts.temporary) {
      state.scope = '';
      scopeControl.setValue('');
    }
    headCount.textContent = state.data ? `${counts.all} 个技能` : '';
  }

  function syncProjects() {
    const options = state.data ? skillProjectOptions(state.data) : [];
    const value = state.project ?? (state.data ? skillContextProject(state.data) : 'none');
    // 读取失败时 data 为空、state.project 还留着上次的项目：补一条同值选项，
    // 否则 select 的值在选项里找不到，会显示成空白。
    if (!options.some((option) => option.value === value)) options.push({ value, label: '当前项目' });
    projectSelect.replaceChildren();
    for (const option of options) {
      const item = el('option', '', option.label);
      item.value = option.value;
      projectSelect.append(item);
    }
    projectSelect.value = value;
    projectSelect.disabled = state.loading || state.stale;
  }

  /** 没有清单 / 工作区已切换时，动作按钮不能假装还能用：它们都依赖当前清单里的写入目标。 */
  function syncActions() {
    const ready = Boolean(state.data) && !state.stale;
    for (const button of [scanButton, createButton, marketButton]) button.disabled = !ready;
  }

  function renderNotes() {
    notes.replaceChildren();
    const data = state.data;
    if (!data) {
      for (const d of state.diagnostics) notes.append(note(d.message, 'warn'));
      return;
    }
    if (data.piReachable === false) notes.append(note(PI_SILENT_NOTE, 'warn'));
    for (const d of data.diagnostics || []) notes.append(note(d.message, 'warn'));
    if (data.trust && data.trust.requiresTrust && !data.trust.trusted) notes.append(note(TRUST_NOTE, 'warn'));
  }

  function renderBody() {
    if (disposed || state.view === 'market') return;
    syncActions();
    content.replaceChildren();
    if (state.loading && !state.data) {
      content.append(emptyState('正在读取技能…', { icon: 'refresh', className: 'is-loading' }));
      return;
    }
    if (state.stale) {
      content.append(emptyState(STALE_TEXT, {
        icon: 'refresh',
        action: { label: '刷新', icon: 'refresh', onClick: () => { state.project = null; void load(undefined); } },
      }));
      return;
    }
    if (state.error) {
      content.append(emptyState(state.error, {
        icon: 'warning',
        action: { label: '重试', icon: 'refresh', onClick: () => { void load(state.project ?? undefined); } },
      }));
      return;
    }
    const all = state.data?.skills || [];
    const filtering = Boolean(state.query.trim() || state.scope);
    const items = filterSkills(all, { scope: state.scope, query: state.query });
    if (filtering && !items.length) {
      content.append(emptyState(EMPTY_FILTERED, { icon: 'search' }));
      return;
    }
    const shown = new Map(groupSkillsByScope(items).map((group) => [group.scope, group.items]));
    // 全部视图：全局级 / 项目级常驻（为空时给空状态），临时 / 其他只在有条目时出现；
    // 搜索或按作用域筛选时只留有匹配的分组，免得一屏都是「没有匹配」。
    const scopes = state.scope
      ? [state.scope]
      : [...SKILL_SCOPE_ORDER, 'other'].filter((scope) => shown.has(scope) || (!filtering && ALWAYS_SHOWN.includes(scope)));
    for (const scope of scopes) content.append(renderGroup(scope, shown.get(scope) || []));
  }

  function importTargetFor(scope) {
    return skillWritableTargets(state.data, scope)[0] || null;
  }

  function renderGroup(scope, items) {
    const section = el('section', 'skills-group');
    section.dataset.scope = scope;
    const title = el('h3', 'skills-group-title', skillScopeTitle(scope));
    title.id = `skillsGroup-${scope}`;
    section.setAttribute('aria-labelledby', title.id);
    const groupHead = el('header', 'skills-group-head');
    // 发现目录优先取服务端的 roots（空分组也能说明放在哪里会被发现），旧形状回退到条目自带的 rootLabel。
    const roots = skillScopeRoots(state.data?.roots, scope);
    const labels = roots.length ? roots.map((root) => root.label) : skillGroupRoots(items);
    const path = el('span', 'skills-group-path', labels.join(' · '));
    path.title = roots.length ? roots.map((root) => root.dir).join('\n') : labels.join('\n');
    groupHead.append(title, path, el('span', 'skills-group-count', String(items.length)));
    if (scope === 'user' || scope === 'project') {
      const target = importTargetFor(scope);
      const importActions = el('div', 'skills-group-actions');
      for (const [label, icon] of [['导入文件', 'fileText'], ['导入目录', 'folder']]) {
        const button = actionButton(label, icon, 'ghost tiny', () => openImport(target ? target.key : ''));
        button.disabled = !target;
        // 窄窗只留图标（.skills-group-actions .btn span 被隐藏），按钮必须另有可读名字。
        button.setAttribute('aria-label', target ? `${label}到 ${target.label}` : label);
        button.title = target ? `${label} · ${target.label}` : '这个作用域没有可写的目录';
        importActions.append(button);
      }
      groupHead.append(importActions);
    }
    section.append(groupHead);
    if (!items.length) {
      section.append(scope === 'project' && state.data?.hasProject === false
        ? emptyState(EMPTY_NO_PROJECT, { icon: 'folder', className: 'skills-empty-group' })
        : emptyState(EMPTY_DIR, { className: 'skills-empty-group' }));
      return section;
    }
    const list = el('div', 'skills-rows');
    list.setAttribute('role', 'list');
    for (const skill of items) list.append(renderRow(skill));
    section.append(list);
    return section;
  }

  function rowBadges(skill, meta) {
    const badges = el('span', 'skill-row-badges');
    badges.append(createBadge({ text: SKILL_SCOPE_LABEL[skill.scope] || '其他', tone: 'neutral' }));
    if (skill.state !== 'enabled') badges.append(createBadge({ text: meta.label, tone: meta.tone }));
    else {
      badges.append(createBadge({ text: '已启用', tone: 'success' }));
      if (skill.loaded === true) badges.append(createBadge({ text: '已加载', tone: 'success' }));
    }
    if (skill.source === 'local') badges.append(createBadge({ text: '来自 settings' }));
    if (skill.disableModelInvocation) badges.append(createBadge({ text: '不进系统提示词' }));
    return badges;
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
    const glyph = el('span', 'skill-glyph');
    glyph.append(createIcon('book', { size: 16 }));
    const dot = el('span', 'ext-dot ' + meta.dot);
    dot.title = meta.label;
    glyph.append(dot);
    const text = el('span', 'skill-row-text');
    const titleLine = el('span', 'skill-row-title');
    titleLine.append(el('span', 'skill-name', skill.name), rowBadges(skill, meta));
    const desc = el('span', 'skill-row-desc', skill.description || '（没有描述）');
    if (skill.description) desc.title = skill.description;
    text.append(titleLine, desc);
    main.append(glyph, text);
    main.onclick = () => {
      state.openId = open ? '' : skill.id;
      renderBody(); // 行会重建：把焦点还给同一行，键盘用户不丢位置
      [...content.querySelectorAll('.skill-row')].find((row) => row.dataset.skillId === skill.id)
        ?.querySelector('.skill-row-main')?.focus();
    };
    const actions = el('div', 'skill-row-actions');
    if (skill.toggleable) actions.append(renderToggle(skill));
    line.append(main, actions);
    item.append(line);
    if (open) item.append(openDetailFor(skill, detailId));
    return item;
  }

  /* 筛选 / 输入搜索词会整表重绘；展开项的详情（含已读到的 SKILL.md）原样挪进新行，
   * 只有换了展开项或重读了清单才重建并重新请求。 */
  function openDetailFor(skill, detailId) {
    if (openDetail && openDetail.id === skill.id && openDetail.data === state.data) return openDetail.node;
    const node = el('div', 'skill-detail');
    node.id = detailId;
    const seq = ++detailSeq;
    const generation = state.loadedGeneration;
    renderSkillDetail(node, skill, {
      isLive: () => alive() && seq === detailSeq && ownsWorkspace(generation) && !state.stale
        && state.openId === skill.id && state.data === openDetail?.data,
      project: state.project ?? undefined,
      onEdit: (target) => openEdit(target),
      onDelete: (target) => { void removeSkill(target); },
    });
    openDetail = { id: skill.id, data: state.data, node };
    return node;
  }

  function renderToggle(skill) {
    const control = createSettingsToggle({
      checked: isSkillOn(skill),
      disabled: state.busyIds.has(skill.id),
      ariaLabel: `${isSkillOn(skill) ? '停用' : '启用'}技能 ${skill.name}`,
      onChange: (want) => { void toggleSkill(skill, want, control); },
    });
    control.element.classList.add('skill-toggle');
    return control.element;
  }

  /* ---------- 启停：确认 → 写 settings → 内联提示（含重启）→ 重读 ---------- */
  async function toggleSkill(skill, want, control) {
    const generation = state.loadedGeneration;
    const ok = await confirmModal(skillToggleCopy(skill, want));
    if (!alive()) return;
    if (!ok) { control.setChecked(!want); return; }
    if (state.stale || !ownsWorkspace(generation)) { control.setChecked(!want); markStale(); return; }
    state.busyIds.add(skill.id);
    control.setDisabled(true);
    const result = await setSkillEnabled(skill.id, want, state.project ?? undefined);
    state.busyIds.delete(skill.id);
    if (!alive()) return;
    control.setDisabled(false);
    if (!result || result.ok === false) {
      control.setChecked(!want);
      setNotice({ tone: 'error', text: (result && result.error) || '操作失败' });
      return;
    }
    setNotice({
      tone: 'success',
      text: result.notice || (want ? `已启用 ${skill.name}。` : `已停用 ${skill.name}。`),
      details: result.warnings || [],
      restart: result.restartRequired === true,
    });
    await load(state.project ?? undefined);
  }

  /* ---------- 创建 / 编辑 / 删除 / 导入 / 扫描 ---------- */
  function openCreate() {
    if (!state.data) return;
    openSkillEditor({
      mode: 'create',
      project: state.project ?? undefined,
      data: state.data,
      onSaved: (result) => afterMutation(result, result.name ? `已创建 ${result.name}。` : '已创建技能。'),
    });
  }

  function openEdit(skill) {
    if (!skill) return;
    openSkillEditor({
      mode: 'edit',
      skill,
      project: state.project ?? undefined,
      data: state.data,
      onSaved: (result) => afterMutation(result, result.name ? `已保存 ${result.name}。` : '已保存。'),
    });
  }

  async function removeSkill(skill) {
    const target = skill.manage?.target || skill.path || '技能目录';
    const ok = await confirmModal({
      title: `删除技能「${skill.name}」？`,
      message: `会把这个技能从 ${target} 移进 pi-GUI 的回收站（如果可用），不是直接抹掉。pi 重启后才会停止加载它。`,
      okText: '删除',
      danger: true,
    });
    if (!ok || !alive()) return;
    const result = await deleteSkill(skill.id, state.project ?? undefined);
    if (!alive()) return;
    if (!result || result.ok === false) {
      setNotice({ tone: 'error', text: (result && result.error) || '删除失败' });
      return;
    }
    state.openId = '';
    openDetail = null;
    afterMutation(result, result.name ? `已删除 ${result.name}。` : '已删除。');
  }

  function openImport(targetPreset = '') {
    if (!state.data) return;
    openSkillImport({
      project: state.project ?? undefined,
      data: state.data,
      targetPreset,
      onImported: (result) => afterMutation(result, result.name
        ? `已导入 ${result.name}（${result.fileCount || 1} 个文件）。`
        : '已导入技能。'),
    });
  }

  function openScan() {
    if (!state.data) return;
    openSkillExternal({
      project: state.project ?? undefined,
      data: state.data,
      onImported: (result) => afterMutation(result, `已导入 ${result.imported} 个技能。`),
    });
  }

  /* ---------- 市场子视图 ---------- */
  function openMarket() {
    if (!state.data || state.view === 'market') return;
    state.view = 'market';
    state.openId = '';
    setNotice(null);
    head.classList.add('is-market');
    refresh.hidden = true;
    toolbar.hidden = true;
    actionsBar.hidden = true;
    notes.hidden = true;
    noticeHost.hidden = true;
    content.replaceChildren();
    const host = el('div', 'skills-market-host');
    content.append(host);
    market = renderSkillsMarket(host, {
      project: state.project ?? (state.data ? skillContextProject(state.data) : 'none'),
      listData: state.data,
      installedNames: marketInstalledNames(state.data.skills),
      onBack: closeMarket,
      onInstalled: () => { state.needsReload = true; },
    });
  }

  function closeMarket() {
    if (state.view !== 'market') return;
    state.view = 'list';
    market?.dispose();
    market = null;
    head.classList.remove('is-market');
    refresh.hidden = false;
    toolbar.hidden = false;
    actionsBar.hidden = false;
    notes.hidden = false;
    noticeHost.hidden = false;
    if (state.needsReload) {
      state.needsReload = false;
      void load(state.project ?? undefined);
      return;
    }
    renderBody();
  }

  /* ---------- 项目上下文 ---------- */
  async function switchProject(value) {
    if (value === state.project) return;
    state.project = value;
    state.openId = '';
    openDetail = null;
    state.data = null;
    state.error = '';
    state.stale = false;
    detailSeq += 1;
    syncScopeCounts();
    renderNotes();
    state.loading = true;
    renderBody();
    await load(value);
  }

  /* ---------- 读取 ---------- */
  function markStale() {
    if (disposed) return;
    state.stale = true;
    if (state.view === 'market') closeMarket();
    syncProjects();
    renderBody();
  }

  async function load(project) {
    const token = ++loadToken;
    const generation = S.workspaceGeneration;
    state.loading = true;
    refresh.disabled = true;
    projectSelect.disabled = true;
    content.classList.add('is-loading');
    if (!state.data) renderBody();
    const result = await fetchSkills(project === null ? undefined : project);
    if (disposed || token !== loadToken) return;
    state.loading = false;
    refresh.disabled = false;
    projectSelect.disabled = false;
    content.classList.remove('is-loading');
    if (!ownsWorkspace(generation)) { markStale(); return; }
    state.stale = false;
    state.loadedGeneration = generation;
    if (!result || result.ok === false) {
      state.data = null;
      state.error = (result && result.error) || '读取技能失败';
      state.diagnostics = (result && result.diagnostics) || [];
      if (result && result.code === 'project-gone') state.project = null;
    } else {
      state.data = result;
      state.error = '';
      state.diagnostics = [];
      state.project = skillContextProject(result);
      if (state.openId && !(result.skills || []).some((skill) => skill.id === state.openId)) {
        state.openId = '';
        openDetail = null;
      }
    }
    syncScopeCounts();
    syncProjects();
    renderNotes();
    renderBody();
    writeSkillBadge(result); // 页面刚读到的数字顺手同步给菜单徽标，省一次请求
  }

  const onGeneration = () => { if (!disposed && state.data) markStale(); };
  document.addEventListener('pi-gui:workspace-generation', onGeneration);
  syncScopeCounts();
  syncProjects();
  void load(undefined);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      loadToken += 1;
      detailSeq += 1;
      openDetail = null;
      market?.dispose();
      market = null;
      document.removeEventListener('pi-gui:workspace-generation', onGeneration);
    },
  };
}
