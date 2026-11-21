/* 技能页的纯数据投影：状态文案、作用域、筛选、分组、计数。
 *
 * 不碰 DOM、不发请求、不缓存。事实只有一份 —— server/skills.js 的 `/api/skills`
 * 返回值；这里只把它变成页面要显示的样子。未知状态保持「状态未知」，不猜。 */

export const SKILL_STATE_META = Object.freeze({
  enabled: Object.freeze({ dot: 'on', label: '已启用' }),
  disabled: Object.freeze({ dot: 'off', label: '已停用' }),
  untrusted: Object.freeze({ dot: 'warn', label: '未加载（项目未信任）' }),
  invalid: Object.freeze({ dot: 'err', label: '无法加载' }),
  shadowed: Object.freeze({ dot: 'warn', label: '被同名覆盖' }),
  'not-loaded': Object.freeze({ dot: 'warn', label: 'pi 未加载' }),
  unknown: Object.freeze({ dot: 'dim', label: '状态未知' }),
});

/** user = pi 的用户级目录（~/.pi/agent/skills 等），对用户来说就是「全局」。 */
export const SKILL_SCOPE_LABEL = Object.freeze({ project: '项目', user: '全局', temporary: '临时' });

/** 与 server/skills.js 的排序一致：项目级优先（它会覆盖同名的全局技能）。 */
export const SKILL_SCOPE_ORDER = Object.freeze(['project', 'user', 'temporary']);

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
