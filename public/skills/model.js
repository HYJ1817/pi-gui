/* 技能页的纯数据投影：状态文案、作用域、筛选、分组、计数、市场分页。
 *
 * 不碰 DOM、不发请求、不缓存。事实只有一份 —— 服务端 `/api/skills` 等接口的返回值；
 * 这里只把它变成页面要显示的样子。未知状态保持「状态未知」，不猜。 */

/** dot = 行图标角上的状态点（.ext-dot 的变体）；tone = 状态徽标的 .ds-badge 语气。 */
export const SKILL_STATE_META = Object.freeze({
  enabled: Object.freeze({ dot: 'on', tone: 'success', label: '已启用' }),
  disabled: Object.freeze({ dot: 'off', tone: 'neutral', label: '已停用' }),
  untrusted: Object.freeze({ dot: 'warn', tone: 'warning', label: '未加载（项目未信任）' }),
  invalid: Object.freeze({ dot: 'err', tone: 'error', label: '无法加载' }),
  shadowed: Object.freeze({ dot: 'warn', tone: 'warning', label: '被同名覆盖' }),
  'not-loaded': Object.freeze({ dot: 'warn', tone: 'warning', label: 'pi 未加载' }),
  unknown: Object.freeze({ dot: 'dim', tone: 'neutral', label: '状态未知' }),
});

/** user = pi 的用户级目录（~/.pi/agent/skills 等），对用户来说就是「全局」。 */
export const SKILL_SCOPE_LABEL = Object.freeze({ project: '项目', user: '全局', temporary: '临时' });
export const SKILL_SCOPE_TITLE = Object.freeze({
  user: '全局级', project: '项目级', temporary: '临时（--skill）', other: '其他',
});

/** 页面分组顺序，对照 PI-Desktop 技能页：全局级在前、项目级在后。
 *  这只是展示顺序：同名时谁生效由 server/skills.js 按 pi 的规则核对（项目级优先），
 *  结果体现在行上的「被同名覆盖」状态，不靠分组先后表达。 */
export const SKILL_SCOPE_ORDER = Object.freeze(['user', 'project', 'temporary']);

export const SKILL_STATE_FILTERS = Object.freeze([
  Object.freeze({ value: '', label: '全部状态' }),
  Object.freeze({ value: 'enabled', label: '已启用' }),
  Object.freeze({ value: 'off', label: '未启用' }),
  Object.freeze({ value: 'problem', label: '有问题' }),
]);

const PROBLEM_STATES = new Set(['untrusted', 'invalid', 'shadowed', 'not-loaded']);

export function skillStateMeta(state) {
  return SKILL_STATE_META[state] || SKILL_STATE_META.unknown;
}

/**
 * 行上的状态：配置状态与 pi 的实际加载状态分开说。
 * 刚停用的技能在 pi 重启前仍会被加载 —— 这时只写「已停用」会让人以为它已经不生效了，
 * 所以把「重启前仍加载」写进同一枚徽标，角标也用警示色。
 * loaded 是三值：true / false / null（pi 没在运行，无法确认）。
 */
export function skillDisplayStatus(skill) {
  const meta = skillStateMeta(skill?.state);
  if (skill?.state === 'disabled' && skill.loaded === true) {
    return { label: '已停用 · 重启前仍加载', tone: 'warning', dot: 'warn' };
  }
  if (skill?.state === 'enabled' && skill.loaded === true) {
    return { label: '已加载', tone: meta.tone, dot: meta.dot };
  }
  return { label: meta.label, tone: meta.tone, dot: meta.dot };
}

export function skillScopeLabel(scope) {
  return SKILL_SCOPE_LABEL[scope] || String(scope || '未知');
}

export function skillScopeTitle(scope) {
  return SKILL_SCOPE_TITLE[scope] || SKILL_SCOPE_TITLE.other;
}

/** 开关反映配置；运行时是否加载由状态徽标和详情单独显示。 */
export function isSkillOn(skill) {
  return skill?.state === 'enabled' || (skill?.state !== 'disabled' && skill?.disabledBy === '');
}

/** loaded 是三值：true / false / null（pi 没在跑，无法确认）。 */
export function skillLoadedText(skill) {
  if (skill?.loaded === null || skill?.loaded === undefined) return '无法确认（pi 未运行）';
  return skill.loaded ? '是' : '否';
}

export function skillMatchesState(skill, state) {
  if (state === 'enabled') return skill.state === 'enabled';
  if (state === 'off') return skill.state !== 'enabled';
  if (state === 'problem') return PROBLEM_STATES.has(skill.state);
  return true;
}

export function skillMatchesQuery(skill, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [skill.name, skill.description, skill.path, skill.rootLabel, skill.stateNote]
    .some((value) => String(value ?? '').toLowerCase().includes(q));
}

/** scope 为空 = 全部。顺序保持服务端给的顺序。 */
export function filterSkills(skills, { scope = '', state = '', query = '' } = {}) {
  return (Array.isArray(skills) ? skills : []).filter((skill) =>
    (!scope || skill.scope === scope) && skillMatchesState(skill, state) && skillMatchesQuery(skill, query));
}

/** 各作用域条数，供分段筛选显示。临时技能只有存在时才出现在筛选里。 */
export function skillScopeCounts(skills) {
  const counts = { all: 0, project: 0, user: 0, temporary: 0 };
  for (const skill of Array.isArray(skills) ? skills : []) {
    counts.all += 1;
    if (SKILL_SCOPE_ORDER.includes(skill.scope)) counts[skill.scope] += 1;
  }
  return counts;
}

/** 按作用域分组；未知作用域单独成组放最后，不丢条目。 */
export function groupSkillsByScope(skills) {
  const groups = new Map(SKILL_SCOPE_ORDER.map((scope) => [scope, []]));
  for (const skill of Array.isArray(skills) ? skills : []) {
    const key = groups.has(skill.scope) ? skill.scope : 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(skill);
  }
  return [...groups].filter(([, items]) => items.length).map(([scope, items]) => ({ scope, items }));
}

/** 分组标题旁显示的来源目录：取这一组实际出现过的 rootLabel，去重保序。 */
export function skillGroupRoots(items) {
  return [...new Set(items.map((skill) => skill.rootLabel).filter(Boolean))];
}

/** 分组标题旁的发现目录（来自 `/api/skills` 的 roots）：这一作用域里磁盘上存在的根；
 *  一个都不存在时只给第一个（pi 的默认位置），让空分组也说得清「放在哪里会被发现」。
 *  label 是服务端给的展示名（可能带 ~ 或 <项目> 缩写），dir 是全路径，供悬停查看。 */
export function skillScopeRoots(roots, scope) {
  const own = (Array.isArray(roots) ? roots : []).filter((root) => root && root.scope === scope && root.label);
  const existing = own.filter((root) => root.exists === true);
  return (existing.length ? existing : own.slice(0, 1))
    .map((root) => ({ label: String(root.label), dir: String(root.dir || root.label) }));
}

/** 启停确认文案：说清楚写哪个文件、加 / 删哪条规则，以及不动 skill 文件本身。 */
export function skillToggleCopy(skill, want) {
  return {
    title: want ? '启用这个 Skill？' : '停用这个 Skill？',
    message: want
      ? `会从 ${skill.settingsPath} 里删掉一条停用规则（${skill.disablePattern}）。不会改动 skill 文件本身。`
      : `会往 ${skill.settingsPath} 里加一条规则（${skill.disablePattern}）。不会删除或移动 skill 文件 —— 只是让 pi 不再加载它。`,
    okText: want ? '启用' : '停用',
  };
}

/* ---------- 项目上下文与写入目标 ---------- */

/** 列表返回的上下文：'none' 表示「只看全局」。 */
export function skillContextProject(data) {
  return data && data.context && typeof data.context.project === 'string' ? data.context.project : 'none';
}

/** 项目选择器的选项。active 表示它正是 pi 当前运行的工作区。 */
export function skillProjectOptions(data) {
  const options = (Array.isArray(data?.projects) ? data.projects : []).map((project) => ({
    value: project.id,
    label: project.active ? `${project.name}（当前）` : project.name,
  }));
  options.push({ value: 'none', label: '不指定项目（只看全局）' });
  return options;
}

/** 当前上下文里可写的目标；scope 为空 = 全部。 */
export function skillWritableTargets(data, scope = '') {
  return (Array.isArray(data?.targets) ? data.targets : [])
    .filter((target) => target && target.writable === true && (!scope || target.scope === scope));
}

/** 某个目标 key 的展示名；找不到时原样返回。 */
export function skillTargetLabel(data, key) {
  const hit = (Array.isArray(data?.targets) ? data.targets : []).find((target) => target && target.key === key);
  return hit ? hit.label : String(key || '');
}

/** 按作用域选的默认导入目标：先项目级，再全局的第一个。 */
export function skillDefaultTarget(data, scope) {
  const preferred = skillWritableTargets(data, scope);
  return (preferred[0] || skillWritableTargets(data)[0] || null)?.key || '';
}

/** 列表里已有技能的名字集合（小写），用于市场卡片标「已安装」。 */
export function marketInstalledNames(skills) {
  const names = new Set();
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill) continue;
    if (skill.name) names.add(String(skill.name).toLowerCase());
    const dirName = String(skill.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).slice(-2, -1)[0];
    if (dirName && dirName !== 'skills') names.add(String(dirName).toLowerCase());
  }
  return names;
}

/* ---------- 市场投影 ---------- */

export function formatSkillBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function marketCategoryLabel(categories, id) {
  if (!id) return '';
  const hit = (Array.isArray(categories) ? categories : []).find((category) => category && category.id === id);
  return hit ? hit.label : String(id);
}

export function marketSourceName(source) {
  if (!source) return '';
  return `${source.repo}${source.ref ? `@${source.ref}` : ''}`;
}

/** 市场条目筛选：来源、分类、搜索（名称 / 描述 / 仓库 / 目录）。 */
export function filterMarketEntries(entries, { query = '', category = '', sourceId = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (!entry) return false;
    if (sourceId && entry.sourceId !== sourceId) return false;
    if (category && !(Array.isArray(entry.categories) && entry.categories.includes(category))) return false;
    if (!q) return true;
    return [entry.title, entry.slug, entry.description, entry.repo, entry.dir, marketSourceName({ repo: entry.repo })]
      .some((value) => String(value ?? '').toLowerCase().includes(q));
  });
}

export function marketPageCount(total, pageSize) {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 24;
  return Math.max(1, Math.ceil((Array.isArray(total) ? total.length : Number(total) || 0) / size));
}

export function marketPageItems(entries, page, pageSize) {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 24;
  const list = Array.isArray(entries) ? entries : [];
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  return list.slice((current - 1) * size, current * size);
}

/** 页码窗口：1 … 4 5 6 … 67。返回数字或 '…'。 */
export function marketPageWindow(page, total, radius = 1) {
  const pages = Math.max(1, Math.trunc(total) || 1);
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const out = [];
  const push = (value) => { if (out[out.length - 1] !== value) out.push(value); };
  const from = Math.max(1, current - radius);
  const to = Math.min(pages, current + radius);
  if (pages <= 7) {
    for (let n = 1; n <= pages; n += 1) push(n);
    return out;
  }
  push(1);
  if (from > 2) push('…');
  for (let n = from; n <= to; n += 1) push(n);
  if (to < pages - 1) push('…');
  push(pages);
  return out;
}

/** 条目是否已在当前上下文中：按市场显示名与目录名匹配。 */
export function marketEntryInstalled(entry, installedNames) {
  if (!entry || !(installedNames instanceof Set)) return false;
  return [entry.slug, entry.title].some((name) => name && installedNames.has(String(name).toLowerCase()));
}

/** 外部扫描候选项的「已有状态」徽标。 */
export function externalPresentMeta(present) {
  if (present === 'same') return { label: '已有同名（内容相同）', tone: 'neutral' };
  if (present === 'different') return { label: '已有同名（内容不同）', tone: 'warning' };
  if (present === 'linked') return { label: '已链接', tone: 'success' };
  return { label: '未导入', tone: 'neutral' };
}
