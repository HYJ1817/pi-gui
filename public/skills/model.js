/* 技能页的纯数据投影：状态文案、作用域、筛选、分组、计数。
 *
 * 不碰 DOM、不发请求、不缓存。事实只有一份 —— server/skills.js 的 `/api/skills`
 * 返回值；这里只把它变成页面要显示的样子。未知状态保持「状态未知」，不猜。 */

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

export function skillScopeLabel(scope) {
  return SKILL_SCOPE_LABEL[scope] || String(scope || '未知');
}

/** 开关显示的「当前是否开着」：与旧实现同一判据（loaded 为真且没有停用规则也算开）。 */
export function isSkillOn(skill) {
  return skill?.state === 'enabled' || (skill?.loaded === true && !skill?.disabledBy);
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
  return [skill.name, skill.description, skill.path, skill.rootLabel]
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
