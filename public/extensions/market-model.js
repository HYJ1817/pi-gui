/* 插件市场、包详情与包操作的纯数据投影（不碰 DOM、不发请求）。
 *
 * 事实来源是三个接口的应答：`/api/extensions/market`（目录页）、`/api/extensions/market/item`
 * （单个包 + npm 清单）与 `POST /api/extensions/packages` 的操作结果。这里只把它们翻译成
 * 界面上的字；判断「能不能装 / 装没装上 / 有没有更新」的是服务端。
 * 读不到的一律写「未知」，不省略、不当成否，也不编数字。 */

const VERBS = Object.freeze({ install: '安装', update: '更新', remove: '卸载' });

/** 进行中的按钮文案。 */
export function extensionOperationBusyLabel(action) {
  return `${VERBS[action] || '处理'}中…`;
}

/** 计数：一万以内写全（带千分位），以上用「万 / 亿」。读不到回空串。 */
export function extensionCountLabel(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 10000) return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const [base, unit] = value >= 1e8 ? [1e8, '亿'] : [1e4, '万'];
  const scaled = value / base;
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))} ${unit}`;
}

/** ISO 时间 → `YYYY-MM-DD`（取 UTC 日期，同一份数据在任何时区显示一致）。 */
export function extensionDateLabel(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : '';
}

/** 目录读取时间（毫秒时间戳）→ 本地的 `MM-DD HH:mm`。 */
export function extensionTimeLabel(ms) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const two = (value) => String(value).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function extensionBytesLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

/** 市场卡片标题下的一行：发布者 · 版本 · 更新日期。 */
export function extensionMarketMeta(item) {
  const date = extensionDateLabel(item?.updatedAt);
  return [
    item?.maintainer || '发布者未知',
    item?.version ? `v${item.version}` : '版本未知',
    date ? `更新于 ${date}` : '',
  ].filter(Boolean).join(' · ');
}

/**
 * 市场卡片与详情的主操作，完全按服务端给的事实决定。
 *   install    可以安装
 *   update     已安装，目录里的版本更新，且这个包允许更新
 *   installed  已安装（读到了包文件）
 *   configured 已在配置里登记，但没读到包文件
 *   blocked    不提供安装（原因在 reason）
 */
export function extensionMarketCardState(item) {
  const installed = item?.installed || {};
  if (installed.state === 'installed') {
    if (item.updateAvailable === true && installed.canUpdate === true) return { kind: 'update', label: '更新', reason: '' };
    return { kind: 'installed', label: '已安装', reason: installed.version ? `已安装 v${installed.version}` : '已安装，版本未知' };
  }
  if (installed.state === 'configured') {
    return { kind: 'configured', label: '已登记', reason: '已在 Pi 配置里登记，但没有读到包文件' };
  }
  if (installed.state === 'unknown') {
    return { kind: 'blocked', label: '安装状态未知', reason: '无法读取完整的 Pi 包配置，请刷新后重试' };
  }
  if (item?.install?.allowed === true) return { kind: 'install', label: '安装', reason: '' };
  return { kind: 'blocked', label: '安装', reason: item?.install?.reason || '当前不能安装这个包' };
}

/** 结果行：「共 N 个插件」，以及目录的覆盖范围（目录只收录 npm 上排在前面的一部分时如实说）。 */
export function extensionMarketCountText(response) {
  if (!response) return '';
  const total = Number.isInteger(response.total) ? response.total : 0;
  const parts = [`共 ${extensionCountLabel(total)} 个插件`];
  const snapshot = response.snapshot || {};
  if (Number.isInteger(snapshot.npmTotal) && snapshot.npmTotal > snapshot.covered) {
    parts.push(`目录收录 ${extensionCountLabel(snapshot.covered)} 个，npm 上共 ${extensionCountLabel(snapshot.npmTotal)} 个`);
  }
  return parts.join(' · ');
}

/**
 * 目录状态的就地提示。返回 `{ kind: 'error' | 'warn' | 'dim', text, retry }` 的数组（通常 0–1 条）。
 * 没同意联网不在这里（那是独立的同意横幅）。
 */
export function extensionMarketNotes(response) {
  const snapshot = response?.snapshot;
  if (!snapshot || response.consent?.remote !== true) return [];
  const at = extensionTimeLabel(snapshot.at);
  const notes = [];
  if (snapshot.error) {
    const reason = snapshot.error.error || '读取在线目录失败';
    notes.push({
      kind: 'error', retry: true,
      text: snapshot.state === 'none' ? `${reason}。下面只有内置条目。` : `${reason}。下面是 ${at || '之前'} 读取的目录。`,
    });
  } else if (snapshot.state === 'stale') {
    notes.push({
      kind: 'dim', retry: !snapshot.refreshing,
      text: snapshot.refreshing ? `目录读取于 ${at}，正在后台刷新。` : `目录读取于 ${at}，可能不是最新的。`,
    });
  }
  if (snapshot.partial && !snapshot.error) {
    notes.push({ kind: 'warn', retry: true, text: '这次只读到了目录的一部分，结果可能不全。' });
  }
  return notes;
}

/** 包声明的 Pi 版本要求与当前 Pi 的对照（只是提示：Pi 安装时不强制这一项）。 */
export function extensionCompatibilityText(compat) {
  if (!compat) return '未知（没有读到 npm 清单）';
  const current = compat.piVersion ? `当前 Pi ${compat.piVersion}` : '当前 Pi 版本未知';
  if (compat.status === 'compatible') return `要求 Pi ${compat.range}，${current}，满足`;
  if (compat.status === 'incompatible') return `要求 Pi ${compat.range}，${current}，不满足（Pi 安装时不强制这一项，但可能无法正常工作）`;
  if (compat.status === 'unconstrained') return '声明支持任意版本的 Pi';
  if (compat.status === 'undeclared') return '没有声明要求的 Pi 版本';
  if (compat.legacy) return `按旧包名 ${compat.peer} 声明了 ${compat.range}，无法与当前 Pi 对照`;
  return `要求 Pi ${compat.range || '（未写明）'}，无法与${current}对照`;
}

const RESOURCE_LABELS = Object.freeze([['extensions', '扩展'], ['skills', '技能'], ['prompts', '提示词'], ['themes', '主题']]);

function manifestResources(detail) {
  if (!detail) return '未知（没有读到 npm 清单）';
  if (!detail.declaresResources) return '未声明（Pi 按约定目录加载）';
  const parts = RESOURCE_LABELS
    .filter(([key]) => Number.isInteger(detail.resources?.[key]) && detail.resources[key] > 0)
    .map(([key, label]) => `${label} ${detail.resources[key]}`);
  return parts.length ? parts.join(' · ') : '没有声明资源';
}

function localStateText(item, pkg) {
  const installed = item.installed || {};
  const scope = installed.scope === 'project' ? '项目级' : installed.scope === 'global' ? '用户级' : '';
  if (installed.state === 'installed') {
    return [installed.version ? `已安装 v${installed.version}` : '已安装，版本未知', scope].filter(Boolean).join(' · ');
  }
  if (installed.state === 'configured') {
    return [pkg?.problem?.message || '已在 Pi 配置里登记，但没有读到包文件', scope].filter(Boolean).join(' · ');
  }
  if (installed.state === 'unknown') return '未知';
  return '未安装';
}

function updateText(item, pkg) {
  const installed = item.installed || {};
  if (installed.state !== 'installed') return '';
  if (item.updateAvailable === true) {
    if (installed.canUpdate) return `可更新到 v${item.version}`;
    return `目录里有 v${item.version}；${pkg?.actions?.update?.reason || '这个包不能由 Pi GUI 更新'}`;
  }
  if (item.updateAvailable === false) return pkg?.actions?.update?.allowed === false
    ? pkg.actions.update.reason : item.version ? `目录版本 v${item.version}` : '未发现可用的新版本';
  return '无法判断是否有更新（版本未知）';
}

const MANIFEST_UNKNOWN = '未知（没有读到 npm 清单）';

/**
 * 详情弹层的分节事实。每节 `{ id, title, note?, rows: [{ label, value, mono?, copy? }] }`。
 * @param data.item           市场条目（带本机安装状态）
 * @param data.detail         npm 清单里的事实；没读到是 null
 * @param data.compatibility  服务端算好的兼容性对照；没有清单时是 null
 * @param data.pkg            清单里对应的包记录（已安装时），没有是 null
 * @param data.installRoot    用户级托管目录
 */
export function extensionDetailSections({ item, detail = null, compatibility = null, pkg = null, installRoot = '' }) {
  const downloads = extensionCountLabel(item.downloadsMonthly);
  const date = extensionDateLabel(item.updatedAt);
  const source = {
    id: 'source', title: '来源',
    rows: [
      { label: '包标识', value: `npm:${item.name}`, mono: true },
      { label: '发布者', value: detail?.publishedBy || item.maintainer || '未知' },
      ...(detail?.author ? [{ label: '作者', value: detail.author }] : []),
      { label: '许可证', value: detail?.license || item.license || '未知' },
      { label: '最近发布', value: date || '未知' },
      { label: '月下载量', value: downloads || '未知' },
    ],
  };

  const update = updateText(item, pkg);
  const install = {
    id: 'install', title: '安装',
    rows: [
      { label: '本机状态', value: localStateText(item, pkg) },
      ...(update ? [{ label: '更新', value: update }] : []),
      ...(pkg?.pin === 'exact' && pkg.spec ? [{ label: '固定版本', value: `${pkg.spec}（Pi 不会更新固定了精确版本的包）` }] : []),
      { label: '安装范围', value: item.installed?.scope === 'project' ? '项目级' : '用户级（对所有项目生效）' },
      { label: '安装位置', value: pkg?.location || (item.installed?.scope !== 'project' && installRoot) || '未知', mono: Boolean(pkg?.location || installRoot) },
      { label: '安装命令', value: `pi install npm:${item.name}`, mono: true, copy: true },
    ],
  };

  const integrity = detail
    ? [detail.integrity ? '有完整性校验值' : '没有完整性校验值', detail.signatures ? '有注册表签名' : '没有注册表签名',
      detail.provenance ? '有构建来源证明' : '没有构建来源证明'].join(' · ')
    : MANIFEST_UNKNOWN;
  const size = detail && Number.isFinite(detail.unpackedSize)
    ? [extensionBytesLabel(detail.unpackedSize), Number.isFinite(detail.fileCount) ? `${detail.fileCount} 个文件` : ''].filter(Boolean).join(' · ')
    : detail ? '未知' : MANIFEST_UNKNOWN;
  const security = {
    id: 'security', title: '权限与安全',
    note: '扩展代码以 Pi 进程的权限运行，可以读写文件、执行命令、访问网络。Pi 没有声明式的权限清单，Pi GUI 无法预先列出或限制它会做什么。',
    rows: [
      ...(item.flagged ? [{ label: 'npm 标记', value: '被 npm 标记为不安全，Pi GUI 不提供安装' }] : []),
      ...(detail?.deprecated ? [{ label: '已弃用', value: detail.deprecated }] : []),
      {
        label: '安装脚本',
        value: !detail ? MANIFEST_UNKNOWN
          : detail.installScripts.length ? `${detail.installScripts.join('、')}（安装时会以当前用户身份执行）` : '没有',
      },
      { label: '直接依赖', value: detail ? `${detail.dependencyCount} 个` : MANIFEST_UNKNOWN },
      { label: '解包大小', value: size },
      { label: '发布校验', value: integrity },
    ],
  };

  const compat = {
    id: 'compatibility', title: '兼容性',
    rows: [
      { label: 'Pi 版本', value: extensionCompatibilityText(compatibility) },
      { label: 'Node 版本', value: detail ? detail.nodeRange || '没有声明' : MANIFEST_UNKNOWN },
    ],
  };

  const contents = {
    id: 'contents', title: '包内容',
    rows: [
      { label: '资源', value: manifestResources(detail) },
      ...(item.keywords?.length ? [{ label: '关键词', value: item.keywords.slice(0, 12).join(' · ') }] : []),
    ],
  };
  return [source, install, security, compat, contents];
}

/** 详情里的外链（只收服务端清洗过的 https 链接）。 */
export function extensionDetailLinks(item, detail) {
  const links = { ...(item?.links || {}), ...(detail?.links || {}) };
  return [['npm 页面', links.npm], ['代码仓库', links.repository], ['主页', links.homepage]]
    .filter(([, url], index, all) => typeof url === 'string' && url && all.findIndex(([, other]) => other === url) === index)
    .map(([title, url]) => ({ title, url }));
}

const RISK_TEXT = '扩展代码以 Pi 进程的权限运行，可以读写文件、执行命令、访问网络；Pi 没有权限清单，Pi GUI 无法限制它。只安装你信任的来源。';

/** 安装确认框的内容（`confirmModal` 的参数）。来源与位置都写出来，读不到的写未知。 */
export function extensionInstallConfirm(item, detail = null, { installRoot = '' } = {}) {
  const version = detail?.version || item.version;
  return {
    title: `安装 ${item.name}？`,
    message: 'Pi GUI 会用 Pi 的官方命令安装这个包。安装期间 Pi 会暂停，结束后自动重新启动。',
    details: [
      { label: '来源', text: `npm:${item.name}`, mono: true },
      { label: '版本', text: version ? `v${version}（目录里的最新版本）` : '未知（由 npm 在安装时解析）' },
      { label: '安装到', text: installRoot ? `用户级 · ${installRoot}` : '用户级（对所有项目生效）' },
      {
        label: '安装脚本',
        text: !detail ? MANIFEST_UNKNOWN
          : detail.installScripts.length ? `${detail.installScripts.join('、')}（安装时会以当前用户身份执行）` : '没有',
      },
      { label: '命令', text: `pi install npm:${item.name}`, mono: true },
    ],
    risk: RISK_TEXT,
    context: '实际下载地址取决于本机 npm 的 registry 配置。',
    okText: '安装',
  };
}

/** 更新确认框：当前版本 → 目标版本、来源、命令。 */
export function extensionUpdateConfirm(pkg) {
  const repair = pkg.actions?.update?.repair === true;
  const target = pkg.pin === 'range' && pkg.spec ? `未知（由 Pi 按配置的范围 ${pkg.spec} 解析）`
    : pkg.latest ? `v${pkg.latest}（目录里的最新版本）` : '未知（由 Pi 在更新时解析）';
  return {
    title: repair ? `重新安装 ${pkg.name}？` : `更新 ${pkg.name}？`,
    message: repair
      ? 'Pi 的托管目录里没有读到这个包的文件，Pi 的更新命令会把它重新装上。期间 Pi 会暂停，结束后自动重新启动。'
      : 'Pi GUI 会用 Pi 的官方命令更新这个包。更新期间 Pi 会暂停，结束后自动重新启动。',
    details: [
      { label: '来源', text: `npm:${pkg.name}`, mono: true },
      { label: '当前版本', text: pkg.version ? `v${pkg.version}` : '未知' },
      { label: '目标版本', text: target },
      { label: '范围', text: '用户级（只更新这一个包）' },
      { label: '命令', text: pkg.manual?.update || `pi update --extension npm:${pkg.name}`, mono: true },
    ],
    risk: '新版本的代码同样以 Pi 进程的权限运行。',
    context: '包的安装脚本可以访问当前用户有权限的文件。确认前请核实发布来源。',
    okText: repair ? '重新安装' : '更新',
  };
}

/** 卸载确认框（危险动作）。 */
export function extensionRemoveConfirm(pkg) {
  return {
    title: `卸载 ${pkg.name}？`,
    message: 'Pi GUI 会用 Pi 的官方命令卸载这个包：从用户级配置里移除登记，并删除托管目录里的包文件。期间 Pi 会暂停，结束后自动重新启动。',
    details: [
      { label: '来源', text: `npm:${pkg.name}`, mono: true },
      { label: '版本', text: pkg.version ? `v${pkg.version}` : '未知' },
      { label: '位置', text: pkg.location || '未知', mono: Boolean(pkg.location) },
      { label: '命令', text: pkg.manual?.remove || `pi remove npm:${pkg.name}`, mono: true },
    ],
    context: '可从可信来源重新安装。扩展自行保存的数据可能保留。',
    okText: '卸载',
    danger: true,
  };
}

/* 这些拒绝不是「再试一次」能解决的：先刷新看清现状。 */
const NO_RETRY_CODES = new Set(['already-installed', 'unknown-item', 'unknown-package', 'not-allowed', 'bad-id', 'unsupported', 'unknown-action', 'source-rejected', 'unsafe-package-path']);

function restartNote(result, hasProject) {
  if (!hasProject) return '打开项目后可检查是否加载。';
  if (result.restarted !== true) return '如有需要，请重启 Pi 检查加载状态。';
  return '已请求重启 Pi，加载状态以重新发现的证据为准。';
}

/**
 * 操作结果 → 就地显示的一段话。
 *
 * ⚠️ 成功文案只说**服务端重新读盘确认过**的事（装上了 / 移除了 / 版本变了）。
 * 「已加载」不是这里能说的：那要等 Pi 重启后由 Registry 给证据。
 *
 * @returns {{ tone: 'success'|'info'|'warning'|'error', title, text, hint, manual, retry, uncertain }}
 */
export function extensionOperationOutcome(action, result, { hasProject = false } = {}) {
  const verb = VERBS[action] || '操作';
  const base = { tone: 'error', title: `${verb}失败`, text: '', hint: '', manual: '', retry: true, uncertain: false };
  if (!result || typeof result !== 'object') return { ...base, text: '没有收到结果。', uncertain: true };
  if (result.network === true) {
    return {
      ...base, tone: 'warning', title: `没有收到${verb}结果`, uncertain: true, retry: false,
      text: '与后端的连接中断了：命令可能还在进行，也可能已经结束。请稍后刷新，按实际状态判断。',
    };
  }
  const manual = typeof result.manual === 'string' ? result.manual : '';
  const before = result.before || {};
  const after = result.after || {};
  if (result.ok === true) {
    const done = { ...base, tone: 'success', retry: false, manual: '' };
    const note = restartNote(result, hasProject);
    if (result.code === 'installed') {
      return { ...done, title: after.version ? `已安装 v${after.version}` : '已安装', text: `已在 Pi 的配置与托管目录里确认到这个包。${note}` };
    }
    if (result.code === 'removed') {
      const remain = result.filesRemain === true ? '托管目录里还留着它的文件，但 Pi 不会再加载。' : '';
      return { ...done, title: '已卸载', text: `Pi 的用户级配置里已经没有这个包。${remain}${result.restarted === true && hasProject ? '已请求重启 Pi。' : ''}` };
    }
    if (result.code === 'updated') {
      const from = before.version ? `从 v${before.version} ` : '';
      return { ...done, title: after.version ? `已更新到 v${after.version}` : '已更新', text: `${from}更新完成。${note}` };
    }
    if (result.code === 'reinstalled') {
      return { ...done, title: after.version ? `已重新安装 v${after.version}` : '已重新安装', text: `托管目录里已经能读到这个包。${note}` };
    }
    if (result.code === 'up-to-date') return { ...done, tone: 'info', title: '已经是最新版本', text: 'Pi 检查后没有可用的新版本。' };
    if (result.code === 'skipped-offline') {
      return { ...done, tone: 'warning', title: '没有更新', text: 'Pi 处于离线模式，跳过了包更新。', manual };
    }
    if (result.code === 'not-updated') {
      return { ...done, tone: 'warning', title: '没有更新', text: 'Pi 报告这个包没有被更新。可以稍后重试，或在终端运行下面的命令查看原因。', manual, retry: true };
    }
    return { ...done, tone: 'info', title: '版本没有变化', text: '更新命令已结束，托管目录里的版本与之前相同。' };
  }
  const code = String(result.code || '');
  const started = result.commandStarted === true;
  const text = [result.error || `${verb}没有成功`, started ? '' : '命令没有执行，磁盘没有被改动。']
    .filter(Boolean).map((part) => (/[。！？.!?]$/.test(part) ? part : `${part}。`)).join('');
  const title = code === 'unverified' ? `${verb}结果未确认`
    : /-timeout$/.test(code) ? `${verb}超时`
      : code === 'workspace-stale' ? '项目已切换'
        : `${verb}失败`;
  return {
    ...base,
    tone: code === 'unverified' ? 'warning' : 'error',
    title, text,
    hint: typeof result.hint === 'string' ? result.hint : '',
    manual: started ? manual : '',
    retry: !NO_RETRY_CODES.has(code),
    uncertain: code === 'unverified' && result.verified === null,
  };
}
