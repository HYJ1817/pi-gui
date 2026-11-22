/* 扩展页的纯数据投影：Registry 条目的状态文案、筛选与详情行。
 *
 * 唯一事实来源是 `/api/extensions`（server/extension-registry.js，只读 Registry）。
 * installed / enabled / loaded / restartRequired 是四个独立的三值事实：
 * null 一律显示「未知 / 无法确认」，绝不折算成「否」。这里不做任何按包名的分支。 */

/** 列表徽标：错误优先，其次是 Pi 给出的加载证据。 */
export function extensionStateLabel(item) {
  const state = item?.state || {};
  if (state.error) return state.error.phase === 'discovery' ? '发现异常' : '加载失败';
  if (state.loaded === true) return '已加载';
  if (state.loaded === false) return '未加载';
  return '加载未知';
}

export function extensionDisplayName(item) {
  return item?.displayName || item?.name || '（未命名）';
}

export function extensionScopeLabel(scope) {
  if (scope === 'global') return '全局';
  if (scope === 'project') return '项目';
  return '未知';
}

export function extensionSourceLabel(item) {
  const type = item?.source?.type;
  if (type === 'local') return '本地';
  return type || '未知来源';
}

function triState(value, unknown = '未知') {
  if (value === null || value === undefined) return unknown;
  return value ? '是' : '否';
}

/** 详情里的事实行，顺序与拆分前一致。 */
export function extensionFactRows(item) {
  const state = item?.state || {};
  return [
    ['版本', item?.version || '未知'],
    ['来源', item?.source?.type || 'unknown'],
    ['位置', item?.source?.location || '未知'],
    ['作用域', extensionScopeLabel(item?.scope)],
    ['已安装', triState(state.installed)],
    ['已启用', triState(state.enabled)],
    ['已加载', triState(state.loaded, '无法确认')],
    ['需要重启', triState(state.restartRequired)],
  ];
}

/** 卡片标题下的一行元信息：版本 · 来源 · 作用域。未知就写未知，不省略也不猜。 */
export function extensionCardMeta(item) {
  const scope = extensionScopeLabel(item?.scope);
  return [
    item?.version ? `v${item.version}` : '版本未知',
    extensionSourceLabel(item),
    scope === '未知' ? '作用域未知' : scope,
  ].join(' · ');
}

/** 卡片上的状态标签：只写需要用户注意的事实（显式停用 / 需要重启）；null 不出标签。 */
export function extensionCardTags(item) {
  const state = item?.state || {};
  const tags = [];
  if (state.enabled === false) tags.push({ text: '已停用', tone: 'neutral' });
  if (state.restartRequired === true) tags.push({ text: '需要重启', tone: 'warning' });
  return tags;
}

/** 已安装页的分组：有错误的先列出来，其余按 Pi 给出的加载证据分；没有证据单独成组，不并进「未加载」。 */
export const EXTENSION_GROUPS = Object.freeze([
  Object.freeze({ id: 'problem', label: '需要处理' }),
  Object.freeze({ id: 'loaded', label: '已加载' }),
  Object.freeze({ id: 'unloaded', label: '未加载' }),
  Object.freeze({ id: 'unknown', label: '加载状态未知' }),
]);

export function extensionGroupId(item) {
  const state = item?.state || {};
  if (state.error) return 'problem';
  if (state.loaded === true) return 'loaded';
  if (state.loaded === false) return 'unloaded';
  return 'unknown';
}

/** 按 EXTENSION_GROUPS 的顺序分组，组内保持 Registry 给的顺序；空组不返回。 */
export function groupExtensions(items) {
  const groups = new Map(EXTENSION_GROUPS.map((group) => [group.id, []]));
  for (const item of Array.isArray(items) ? items : []) groups.get(extensionGroupId(item)).push(item);
  return EXTENSION_GROUPS
    .filter((group) => groups.get(group.id).length)
    .map((group) => ({ id: group.id, label: group.label, items: groups.get(group.id) }));
}

/** 名称 / 简介 / 状态 / 来源 / 作用域都可搜，状态用的是列表上同一套文案。 */
export function filterExtensions(items, query) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((item) => [
    item.displayName, item.name, item.description, extensionStateLabel(item), item.source?.type, item.scope,
  ].some((part) => String(part || '').toLowerCase().includes(q)));
}

/* ====================================================================
 * 第二阶段 B：已安装页的卡片单元
 * ====================================================================
 *
 * 一个单元 = 一个在 Pi 配置里登记的包（连同它带来的 Extension 入口），或一个不属于任何包的
 * 独立入口。包清单来自 `/api/extensions/packages`，两份数据靠
 * `packages[].extensionIds` = Registry 的 `id` 对上 —— 那是服务端用同一个解析函数算出来的，
 * 不是按名字猜的。包清单读不到时所有入口都是独立单元，页面退回只读的 Registry 视图。
 * 三值事实的纪律不变：null 就是未知。 */

/** 四个已知能力的人读名字。只用于展示与搜索；识别（capabilityId）与安装来源都由服务端给。 */
export const EXTENSION_CAPABILITY_LABELS = Object.freeze({
  web: 'Web Access', subagents: 'Subagents', memory: 'Pi Memory', browser: 'Browser Use',
});

const PACKAGE_KIND_LABELS = Object.freeze({ npm: 'npm', git: 'Git', local: '本地' });

export function extensionPackageKindLabel(kind) {
  return PACKAGE_KIND_LABELS[kind] || '未知来源';
}

/** 包单元的加载结论：任一入口有 Pi 的加载证据 → 已加载；全部入口确认未加载 → 未加载；其余未知。
 *  （只注册工具、不注册命令的入口拿不到加载证据，不能因此把整个包说成未加载。） */
function unitLoaded(entries) {
  const states = entries.map((entry) => entry.state?.loaded ?? null);
  if (states.some((value) => value === true)) return true;
  if (states.length && states.every((value) => value === false)) return false;
  return null;
}

/**
 * @param registry  `/api/extensions` 的报告；读不到传 null（包的加载状态一律未知）
 * @param inventory `/api/extensions/packages` 的报告；读不到传 null（退回纯 Registry 视图）
 * @returns 单元数组：先是包（清单次序：项目级在前），再是不属于任何包的入口（Registry 次序）
 */
export function buildExtensionUnits(registry, inventory) {
  const entries = Array.isArray(registry?.extensions) ? registry.extensions : [];
  const packages = Array.isArray(inventory?.packages) ? inventory.packages : [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const claimed = new Set();
  const units = [];
  for (const pkg of packages) {
    const ids = Array.isArray(pkg.extensionIds) ? pkg.extensionIds : [];
    const own = [];
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry || claimed.has(id)) continue;
      claimed.add(id);
      own.push(entry);
    }
    units.push({
      kind: 'package', id: pkg.id, pkg, entries: own, entryCount: ids.length,
      loaded: unitLoaded(own), errorEntry: own.find((entry) => entry.state?.error) || null,
    });
  }
  for (const entry of entries) {
    if (claimed.has(entry.id)) continue;
    units.push({
      kind: 'extension', id: entry.id, pkg: null, entries: [entry], entryCount: 1,
      loaded: entry.state?.loaded ?? null, errorEntry: entry.state?.error ? entry : null,
    });
  }
  return units;
}

/** 已安装页的分组：在 Registry 的四组之外，多一组「装好了、但不带扩展入口」的包（只带技能 / 提示词 / 主题）。 */
export const EXTENSION_UNIT_GROUPS = Object.freeze([
  ...EXTENSION_GROUPS,
  Object.freeze({ id: 'resources', label: '其他资源包' }),
]);

export function extensionUnitGroupId(unit) {
  if (unit?.pkg?.problem || unit?.errorEntry) return 'problem';
  if (unit?.kind === 'package' && unit.entryCount === 0 && unit.pkg.installed === true && unit.pkg.resources?.extensions === 0) return 'resources';
  if (unit?.loaded === true) return 'loaded';
  if (unit?.loaded === false) return 'unloaded';
  return 'unknown';
}

/** 按 EXTENSION_UNIT_GROUPS 的顺序分组，组内保持单元次序；空组不返回。 */
export function groupExtensionUnits(units) {
  const groups = new Map(EXTENSION_UNIT_GROUPS.map((group) => [group.id, []]));
  for (const unit of Array.isArray(units) ? units : []) groups.get(extensionUnitGroupId(unit)).push(unit);
  return EXTENSION_UNIT_GROUPS
    .filter((group) => groups.get(group.id).length)
    .map((group) => ({ id: group.id, label: group.label, items: groups.get(group.id) }));
}

export function extensionUnitName(unit) {
  if (unit.kind === 'package') return unit.pkg.name || '（未命名）';
  return extensionDisplayName(unit.entries[0]);
}

export function extensionUnitDescription(unit) {
  if (unit.kind !== 'package') return unit.entries[0].description || '';
  return unit.pkg.description || unit.entries.find((entry) => entry.description)?.description || '';
}

/** 卡片标题下的一行：版本 · 来源 · 作用域（独立入口沿用 Registry 的那一行）。 */
export function extensionUnitMeta(unit) {
  if (unit.kind !== 'package') return extensionCardMeta(unit.entries[0]);
  const scope = extensionScopeLabel(unit.pkg.scope);
  return [
    unit.pkg.version ? `v${unit.pkg.version}` : '版本未知',
    extensionPackageKindLabel(unit.pkg.kind),
    scope === '未知' ? '作用域未知' : scope,
  ].join(' · ');
}

/** 卡片上的状态标签：只放需要用户知道的事实，没有的就不出标签。 */
export function extensionUnitTags(unit) {
  if (unit.kind !== 'package') return extensionCardTags(unit.entries[0]);
  const pkg = unit.pkg;
  const tags = [];
  const capability = EXTENSION_CAPABILITY_LABELS[pkg.capabilityId];
  if (capability) tags.push({ text: capability, tone: 'neutral' });
  if (pkg.updateAvailable === true && pkg.latest) tags.push({ text: `可更新 v${pkg.latest}`, tone: 'success' });
  if (pkg.pin === 'exact' && pkg.spec) tags.push({ text: `已固定 ${pkg.spec}`, tone: 'neutral' });
  if (pkg.shadowed) tags.push({ text: '被项目级覆盖', tone: 'neutral' });
  const enabled = unit.entries.map((entry) => entry.state?.enabled ?? null);
  if (enabled.length && enabled.every((value) => value === false)) tags.push({ text: '已停用', tone: 'neutral' });
  if (unit.entries.some((entry) => entry.state?.restartRequired === true)) tags.push({ text: '需要重启', tone: 'warning' });
  return tags;
}

const RESOURCE_LABELS = Object.freeze([['extensions', '扩展'], ['skills', '技能'], ['prompts', '提示词'], ['themes', '主题']]);

/** 包在 package.json 的 `pi` 字段里声明的资源数量；没声明（按约定目录加载）或读不到就是空数组。 */
export function extensionResourceParts(resources) {
  if (!resources || resources.declared !== true) return [];
  return RESOURCE_LABELS
    .filter(([key]) => Number.isInteger(resources[key]) && resources[key] > 0)
    .map(([key, label]) => `${label} ${resources[key]}`);
}

/** 卡片上的小标签：Pi 已确认的能力（命令）；一个都没有的包退回它声明的资源数量。 */
export function extensionUnitChips(unit) {
  const chips = [];
  for (const entry of unit.entries) {
    for (const capability of Array.isArray(entry.capabilities) ? entry.capabilities : []) {
      const name = capability.displayName || capability.id;
      chips.push({ text: name, title: `${capability.type}: ${name}`, mono: true });
    }
  }
  if (chips.length || unit.kind !== 'package') return chips;
  return extensionResourceParts(unit.pkg.resources).map((text) => ({ text, title: '包声明的资源', mono: false }));
}

/** 卡片上的问题一行：包自己的问题优先，其次是入口的发现 / 加载错误。没有问题回空串。 */
export function extensionUnitErrorText(unit) {
  if (unit.pkg?.problem) return unit.pkg.problem.message || '这个包的状态需要处理';
  const entry = unit.errorEntry;
  if (!entry) return '';
  const text = `${extensionStateLabel(entry)}：${entry.state.error.message || '没有错误信息'}`;
  const count = unit.entries.filter((item) => item.state?.error).length;
  return count > 1 ? `${text}（共 ${count} 个入口有问题）` : text;
}

/** 一组入口的同一个三值事实 → 一句话。全体一致就直接说；不一致逐类给数。 */
function entriesFact(unit, key, unknown = '未知') {
  const values = unit.entries.map((entry) => entry.state?.[key] ?? null);
  if (!values.length) return unit.pkg.resources?.extensions === 0 ? '没有声明扩展入口' : unknown;
  const yes = values.filter((value) => value === true).length;
  const no = values.filter((value) => value === false).length;
  const rest = values.length - yes - no;
  if (yes === values.length) return '是';
  if (no === values.length) return '否';
  if (rest === values.length) return unknown;
  return [yes ? `${yes} 个是` : '', no ? `${no} 个否` : '', rest ? `${rest} 个${unknown}` : ''].filter(Boolean).join('，');
}

/** 详情里的事实行。独立入口沿用 Registry 那八行；包多出最新版本、固定版本与包内容。 */
export function extensionUnitFactRows(unit) {
  if (unit.kind !== 'package') return extensionFactRows(unit.entries[0]);
  const pkg = unit.pkg;
  const rows = [['版本', pkg.version || '未知']];
  if (pkg.latest) rows.push(['最新版本', pkg.updateAvailable === true ? `${pkg.latest}（可更新）` : pkg.latest]);
  rows.push(
    ['来源', pkg.source || extensionPackageKindLabel(pkg.kind)],
    ['位置', pkg.location || '未知'],
    ['作用域', extensionScopeLabel(pkg.scope)],
    ['已安装', triState(pkg.installed)],
    ['已启用', entriesFact(unit, 'enabled')],
    ['已加载', entriesFact(unit, 'loaded', '无法确认')],
    ['需要重启', entriesFact(unit, 'restartRequired')],
  );
  if (pkg.pin === 'exact' && pkg.spec) rows.push(['固定版本', `${pkg.spec}（Pi 不会更新固定了精确版本的包）`]);
  else if (pkg.pin === 'range' && pkg.spec) rows.push(['版本范围', pkg.spec]);
  if (pkg.installed === true) {
    const parts = extensionResourceParts(pkg.resources);
    rows.push(['包内容', parts.length ? parts.join(' · ') : pkg.resources?.declared ? '没有声明资源' : '未声明（Pi 按约定目录加载）']);
  }
  if (pkg.filtered) rows.push(['资源筛选', '配置里筛选了这个包的资源，逐项状态以下面的入口为准']);
  return rows;
}

/** 名称 / 简介 / 已知能力名 / 来源 / 作用域 / 分组 / 入口状态 / 已确认的命令都可搜。 */
export function filterExtensionUnits(units, query) {
  const list = Array.isArray(units) ? units : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  const groupLabels = new Map(EXTENSION_UNIT_GROUPS.map((group) => [group.id, group.label]));
  return list.filter((unit) => {
    const parts = [extensionUnitName(unit), extensionUnitDescription(unit), groupLabels.get(extensionUnitGroupId(unit))];
    if (unit.pkg) {
      parts.push(EXTENSION_CAPABILITY_LABELS[unit.pkg.capabilityId], unit.pkg.source,
        extensionPackageKindLabel(unit.pkg.kind), unit.pkg.scope, extensionScopeLabel(unit.pkg.scope));
    }
    for (const entry of unit.entries) {
      parts.push(entry.displayName, entry.name, entry.description, extensionStateLabel(entry), entry.source?.type, entry.scope);
      for (const capability of Array.isArray(entry.capabilities) ? entry.capabilities : []) parts.push(capability.displayName || capability.id);
    }
    return parts.some((part) => String(part || '').toLowerCase().includes(q));
  });
}
