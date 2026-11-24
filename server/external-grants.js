/* 工作区外文件访问的授权账本。
 *
 * 设计边界（与 docs/file-links.md 保持一致）：
 *   - 授权只能由**可信的原生通道**创建：Electron main 在系统对话框里取得用户
 *     确认后，经父子进程 IPC 调到这里。HTTP 渲染进程没有任何 create 入口。
 *   - 授权绑定会话身份（runtime conversationId；经典会话绑定项目根），
 *     另一个会话不能复用。
 *   - 授权绑定**文件系统对象身份**，不只是路径：
 *     单文件记 dev/ino/birthtime/size/mtime/ctime；目录记 dev/ino/birthtime。
 *     文件被替换、目录被删除重建或变成符号链接/junction 时旧授权失效；
 *     目录的 size/mtime/ctime 随成员增删变化，不进身份，普通增删子文件
 *     不会让授权误失效。
 *   - 目录授权只允许目录内的真实路径；符号链接 / junction 解析到目录外一律拒绝。
 *   - 敏感系统目录、用户凭据目录、UNC / 设备路径、Windows 保留名不参与授权。
 *   - 仅目录授权可持久化。持久化由 Electron 主进程走既有的系统设置持久化设施
 *     （`createSystemPreferenceFile`）保存；本模块只持有运行期账本，启动时由
 *     主进程通过私有 IPC 恢复。这里不另建配置文件，也不读 DATA_DIR。
 *   - 撤销会让在途读取失效：读取前后都核对 grants.epoch。
 *
 * 这个模块不碰 HTTP、不碰 UI。errors 带稳定的 code，由 files.js 映射状态码。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isInside, normalizeForCompare, realPathOrNull } from '../lib/safe-path.js';
import { directoryIdentityOf, fileIdentityOf, sameFileIdentity, sameStatIdentity } from '../lib/file-identity.js';

export const EXTERNAL_LIMITS = Object.freeze({
  maxGrants: 64,
  maxPathChars: 1024,
});

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_BAD_CHARS = /[<>"|?*]/;

const fail = (code, message) => Object.assign(new Error(message || code), { code });
const slash = (value) => String(value ?? '').replace(/\\/g, '/');

function isAbsoluteLocalPath(value) {
  const p = String(value ?? '');
  if (!p || p.length > EXTERNAL_LIMITS.maxPathChars) return false;
  if (CONTROL.test(p)) return false;
  // UNC（\\host\share、//host/share）与设备命名空间（\\?\, \\.\）全部拒绝。
  if (/^[\\/]{2}/.test(p)) return false;
  if (WINDOWS_DRIVE.test(p)) return !WINDOWS_BAD_CHARS.test(p);
  return p.startsWith('/') && !p.startsWith('//');
}

function hasUnsafeWindowsShape(value) {
  const p = String(value ?? '');
  const withoutDrive = p.replace(WINDOWS_DRIVE, '');
  if (withoutDrive.includes(':')) return true; // ADS / 冒号文件名
  const segments = slash(p).split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return true;
    if (/[. ]$/.test(segment)) return true;  // Windows 会静默去掉尾部点/空格
    if (WINDOWS_RESERVED.test(segment)) return true;
  }
  return false;
}

function fileKey(abs, stat) {
  return createHash('sha256')
    .update(`${normalizeForCompare(abs)}\0${stat.dev}\0${stat.ino}`)
    .digest('base64url')
    .slice(0, 22);
}

/* 单文件授权记录创建时的对象身份。dev/ino 在某些文件系统上会被复用
 * （Windows 删除后立刻新建就可能拿到同一个 FileIndex），所以同时记录
 * birthtime/ctime 与大小/mtime；ctime 在 Windows 上是不可由用户回拨的变更时间。 */
function identityOf(stat) {
  return fileIdentityOf(stat);
}

function directoryIdentity(stat) {
  return directoryIdentityOf(stat);
}

/* 目录授权绑的是“当时那个目录对象”，不是路径字符串。目录被删除后原地
 * 重建、重命名后被顶替、变成符号链接/junction 时 dev/ino/birthtime
 * 会变化；member 增删只影响目录的 size/mtime/ctime，不在身份里，避免误失效。
 * 旧记录（schema v1、无身份字段）当作未知对象处理：只标记失效并引导重新
 * 授权，不静默沿用路径继续放行。 */
function directoryIdentityCurrent(target) {
  const real = realPathOrNull(target);
  if (!real || normalizeForCompare(real) !== normalizeForCompare(target)) return null;
  let stat;
  try {
    stat = fs.lstatSync(real);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  return { real, stat, identity: directoryIdentity(stat) };
}

function conversationKeyOf(scope) {
  const id = scope && typeof scope.conversationId === 'string' ? scope.conversationId : '';
  if (id) return `conversation:${id}`;
  const root = scope && typeof scope.root === 'string' ? normalizeForCompare(scope.root) : '';
  return `classic:${root}`;
}

function homeOf(env) {
  return env.USERPROFILE || env.HOME || '';
}

function sensitiveRoots(env, platform, protectedRoots = []) {
  const roots = [];
  const add = (value, label) => {
    if (!value) return;
    const real = realPathOrNull(value) || path.resolve(value);
    roots.push({ path: real, label });
  };
  for (const value of protectedRoots) add(value, 'Pi 数据或凭据目录');
  const home = homeOf(env);
  if (platform === 'win32') {
    add(env.SystemRoot || env.windir, 'Windows');
    add(env.ProgramFiles, 'Program Files');
    add(env['ProgramFiles(x86)'], 'Program Files');
    add(env.ProgramW6432, 'Program Files');
    add(env.ProgramData, 'ProgramData');
    if (home) {
      for (const relative of [
        '.ssh', '.gnupg', '.aws', '.azure', '.kube',
        'AppData/Roaming/Microsoft/Credentials',
        'AppData/Local/Microsoft/Credentials',
        'AppData/Roaming/Mozilla/Firefox',
        'AppData/Local/Google/Chrome/User Data',
        'AppData/Local/Microsoft/Edge/User Data',
      ]) add(path.join(home, relative), '凭据或浏览器数据');
    }
  } else {
    for (const root of ['/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/var', '/System', '/Library', '/Applications']) {
      add(root, '系统目录');
    }
    if (home) {
      for (const relative of ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.config/gcloud']) {
        add(path.join(home, relative), '凭据或浏览器数据');
      }
    }
  }
  return roots;
}

function tooBroad(pathValue, env, platform) {
  const normalized = normalizeForCompare(pathValue);
  const home = homeOf(env);
  const root = path.parse(pathValue).root;
  if (normalized === normalizeForCompare(root)) return true;
  if (home && normalized === normalizeForCompare(home)) return true;
  if (platform === 'win32') {
    const users = env.SystemDrive ? path.join(env.SystemDrive, 'Users') : '';
    if (users && normalized === normalizeForCompare(users)) return true;
  } else if (normalized === normalizeForCompare('/Users') || normalized === normalizeForCompare('/home')) {
    return true;
  }
  return false;
}

export function createExternalGrants({
  env = process.env,
  platform = process.platform,
  now = () => Date.now(),
  /* Pi 自己的 agent 目录（含 auth.json）与应用数据目录不属于普通工作区外文件，
   * 由 server.js 注入；测试使用临时目录。 */
  protectedRoots = [],
  /* 授权不是只能由用户撤销：目录被替换/授权对象消失时账本也会自动逐出。
   * 上层（files.js 的 SSE publish）必须知道这些逐出，才能关闭已经打开的
   * 外部标签、清缓存、断在途请求；否则用户看到的是“旧授权还在”的假象。 */
  onEvict = null,
} = {}) {
  let grants = [];
  let epoch = 0;
  const approvals = new Map();
  const APPROVAL_TTL_MS = 5 * 60_000;
  const APPROVAL_LIMIT = 32;

  function touch() {
    epoch++;
  }

  function evictGrant(grant) {
    grants = grants.filter((item) => item.id !== grant.id);
    touch();
    if (typeof onEvict === 'function') {
      try { onEvict(grant); } catch { /* 推送只尽力而为，逐出本身已生效 */ }
    }
  }

  function scopeKeyOf(scope) {
    return [
      conversationKeyOf(scope),
      scope && typeof scope.scopeId === 'string' ? scope.scopeId : '',
      scope && (typeof scope.generation === 'string' || typeof scope.generation === 'number')
        ? String(scope.generation)
        : '',
      scope && typeof scope.root === 'string' ? normalizeForCompare(scope.root) : '',
    ].join('\0');
  }

  function issueApproval(record) {
    const at = now();
    for (const [id, entry] of approvals) {
      if (entry.expiresAt <= at) approvals.delete(id);
    }
    while (approvals.size >= APPROVAL_LIMIT) {
      approvals.delete(approvals.keys().next().value);
    }
    const id = randomBytes(16).toString('hex');
    approvals.set(id, { ...record, expiresAt: at + APPROVAL_TTL_MS });
    return id;
  }

  function takeApproval(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) {
      throw fail('approval_required', '缺少用户确认记录，请重新点击。');
    }
    const record = approvals.get(id);
    approvals.delete(id);
    if (!record || record.expiresAt <= now()) {
      throw fail('approval_stale', '确认已过期，请重新点击。');
    }
    return record;
  }

  function sanitizeTarget(rawPath, scopeKind) {
    const raw = String(rawPath ?? '');
    if (!isAbsoluteLocalPath(raw)) throw fail('invalid_path', '路径不是可访问的本地绝对路径。');
    if (hasUnsafeWindowsShape(raw)) throw fail('invalid_path', '路径包含不支持的 Windows 特殊形式。');
    const real = realPathOrNull(raw);
    if (!real) throw fail('file_missing', '路径不存在。');
    let stat;
    try {
      stat = fs.lstatSync(real);
    } catch {
      throw fail('file_missing', '路径不存在。');
    }
    if (stat.isSymbolicLink()) throw fail('invalid_path', '不接受符号链接。');
    const wantsFile = scopeKind === 'file';
    if (wantsFile && !stat.isFile()) throw fail('not_a_file', '目标不是文件。');
    const target = wantsFile ? real : (stat.isDirectory() ? real : path.dirname(real));
    const targetStat = wantsFile ? stat : fs.lstatSync(target);
    if (!wantsFile && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) {
      throw fail('not_a_directory', '目标不是目录。');
    }
    return { target, stat: targetStat, isFile: wantsFile };
  }

  function rejectSensitive(target, { directory }) {
    if (directory && tooBroad(target, env, platform)) {
      throw fail('scope_too_broad', '这个目录范围过大，请选择更具体的目录。');
    }
    for (const entry of sensitiveRoots(env, platform, protectedRoots)) {
      /* 两个方向都查：目标在敏感目录内；或目标是敏感目录的祖先。
       * 后者挡住“先授权 AppData/Local，再读下面浏览器 profile”的绕过。 */
      if (isInside(entry.path, target)) {
        throw fail('sensitive_path', `这里属于${entry.label}，不能授权访问。`);
      }
      if (directory && isInside(target, entry.path)) {
        throw fail('sensitive_path', `这个目录包含${entry.label}，不能整体授权。`);
      }
    }
  }

  /** 可信通道的“看一眼”：只返回规范化目标与已有授权，不创建任何东西。
   *  若需要新建授权，同时签发一个只能消费一次的确认记录；`create` 只接受
   *  这份记录，不再重新解释渲染进程传来的路径，避免“对话框显示一个文件、
   *  实际授权另一个”的替换/切工作区窗口。 */
  function inspect({ rawPath, scopeKind = 'file', scope } = {}) {
    const conversationKey = conversationKeyOf(scope);
    const normalized = sanitizeTarget(rawPath, scopeKind === 'directory' ? 'directory' : 'file');
    const directory = !normalized.isFile;
    rejectSensitive(normalized.target, { directory });
    const folder = normalized.isFile ? path.dirname(normalized.target) : normalized.target;
    let folderStat;
    try {
      folderStat = fs.lstatSync(folder);
    } catch {
      throw fail('file_missing', '所在文件夹不存在。');
    }
    if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) {
      throw fail('invalid_path', '所在文件夹不可用。');
    }
    let existing = findCovering(conversationKey, normalized.target, { touchAccess: false });
    if (existing && existing.kind === 'file' && !sameFileIdentity(existing, normalized.stat)) {
      existing = null; // 文件已经被替换：旧授权不再代表当前对象。
    }
    /* 已有会话级目录授权时仍签发一次性确认：用户可能是在显式请求
     * “记住这个文件夹”，主进程会重新弹窗把它升级为长期授权。
     * 已有长期授权时不再签发，避免每次点击都产生无用的确认记录。 */
    const approval = existing && existing.scope === 'persistent' ? null : issueApproval({
      conversationKey,
      scopeKey: scopeKeyOf(scope),
      target: normalized.target,
      targetKind: normalized.isFile ? 'file' : 'directory',
      identity: normalized.isFile
        ? identityOf(normalized.stat)
        : directoryIdentity(normalized.stat),
      folder,
      folderIdentity: directoryIdentity(folderStat),
    });
    return {
      ok: true,
      conversationKey,
      target: normalized.target,
      folder,
      kind: normalized.isFile ? 'file' : 'directory',
      existing: existing ? publicGrant(existing) : null,
      approval,
    };
  }

  function publicGrant(grant) {
    return {
      id: grant.id,
      kind: grant.kind,
      scope: grant.scope,
      target: grant.target,
      createdAt: grant.createdAt,
      ...(grant.kind === 'directory' && grant.dirIdentity ? { dirIdentity: grant.dirIdentity } : {}),
    };
  }

  function publicIdentity(identity) {
    /* 持久化记录只写结构，不写实时路径。dirIdentity 可能是
     *  dev/ino/birthtime 的纯数据对象，也可能是后续扩展字段；
     *  保存前压平成可 JSON 化的普通对象，防止把内部形状带进磁盘。 */
    if (!identity || typeof identity !== 'object') return null;
    return {
      dev: String(identity.dev ?? ''),
      ino: String(identity.ino ?? ''),
      birthtimeMs: Number.isFinite(identity.birthtimeMs) ? identity.birthtimeMs : 0,
    };
  }

  function persistentGrants() {
    /* 只经主进程的私有 IPC 返回，用来回写系统设置存储；HTTP list 不含这个字段。
     * dirIdentity 随记录一起持久化，重启恢复时按它验证“还是不是同一个目录对象”。 */
    return grants
      .filter((grant) => grant.kind === 'directory' && grant.scope === 'persistent')
      .map((grant) => ({
        ...publicGrant(grant),
        conversationKey: grant.conversationKey,
        ...(publicIdentity(grant.dirIdentity) ? { dirIdentity: publicIdentity(grant.dirIdentity) } : {}),
      }));
  }

  function validConversationKey(value) {
    if (typeof value !== 'string' || !value || value.length > EXTERNAL_LIMITS.maxPathChars + 16
      || CONTROL.test(value)) return false;
    if (value.startsWith('conversation:')) return CONVERSATION_ID.test(value.slice('conversation:'.length));
    return value.startsWith('classic:') && value.length > 'classic:'.length;
  }

  /* 启动时由 Electron 主进程恢复它通过系统设置设施保存的长期目录授权。
   * 每一条都按“新授权”重新做路径、符号链接与敏感目录检查；任何一条不通过
   * 都只丢弃那一条，绝不把损坏或越权的记录变成可用授权。返回清理后的权威
   * 持久集，主进程据此回写存储。 */
  function restore(entries) {
    if (!Array.isArray(entries)) throw fail('invalid_request', '授权记录不合法。');
    const seen = new Set(grants.map((grant) => grant.id));
    let restored = 0;
    for (const raw of entries.slice(0, EXTERNAL_LIMITS.maxGrants)) {
      try {
        if (grants.length >= EXTERNAL_LIMITS.maxGrants) break;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        if (typeof raw.id !== 'string' || !/^[a-f0-9]{32}$/.test(raw.id) || seen.has(raw.id)) continue;
        if (raw.kind !== 'directory' || raw.scope !== 'persistent') continue;
        if (!validConversationKey(raw.conversationKey)) continue;
        if (typeof raw.target !== 'string' || !isAbsoluteLocalPath(raw.target)
          || hasUnsafeWindowsShape(raw.target)) continue;
        /* 存储里的 target 是授权时的真实路径。若它后来变成符号链接/junction，
         * realpath 会指向别处；这已经不是用户当时确认的目录，必须重新授权。 */
        const rawStat = fs.lstatSync(raw.target);
        if (!rawStat.isDirectory() || rawStat.isSymbolicLink()) continue;
        const real = realPathOrNull(raw.target);
        if (!real || normalizeForCompare(real) !== normalizeForCompare(raw.target)) continue;
        rejectSensitive(real, { directory: true });
        /* 新版记录带 dirIdentity：要求当前目录对象与保存时一致，否则
         * 这是删除后重建/被顶替/换符号链接的另一个目录，不能用旧授权。
         * 旧记录（无 dirIdentity）按“无法证明同一对象”处理：不恢复成
         * 可用授权，让上层走重新授权，而不是沿用路径继续放行。 */
        const current = directoryIdentity(rawStat);
        const saved = publicIdentity(raw.dirIdentity);
        if (!saved || !sameStatIdentity(saved, current)) continue;
        grants.push({
          id: raw.id,
          conversationKey: raw.conversationKey,
          kind: 'directory',
          scope: 'persistent',
          target: real,
          dirIdentity: current,
          createdAt: typeof raw.createdAt === 'string' && raw.createdAt.length <= 40
            ? raw.createdAt
            : new Date(0).toISOString(),
        });
        seen.add(raw.id);
        restored++;
        if (grants.length >= EXTERNAL_LIMITS.maxGrants) break;
      } catch { /* 单条记录无效时只跳过这一条 */ }
    }
    if (restored) touch();
    return { ok: true, restored, persistent: persistentGrants() };
  }

  function findCovering(conversationKey, realTarget, { touchAccess = true } = {}) {
    const target = normalizeForCompare(realTarget);
    let best = null;
    for (const grant of grants) {
      if (grant.conversationKey !== conversationKey) continue;
      if (grant.kind === 'file') {
        if (normalizeForCompare(grant.target) === target) best = best || grant;
      } else if (isInside(grant.target, realTarget)) {
        if (!best || grant.target.length > best.target.length) best = grant;
      }
    }
    if (best && touchAccess) best.lastUsedAt = now();
    return best;
  }

  function approvedTarget(record, scopeKind) {
    const wantsFile = scopeKind !== 'directory';
    if (wantsFile && record.targetKind !== 'file') {
      throw fail('approval_stale', '确认期间目标类型已经变化，请重新点击。');
    }
    const target = wantsFile ? record.target : record.folder;
    const identity = wantsFile ? record.identity : record.folderIdentity;
    let real;
    try {
      real = realPathOrNull(target);
    } catch {
      real = null;
    }
    if (!real || normalizeForCompare(real) !== normalizeForCompare(target)) {
      throw fail('approval_stale', '确认期间文件或文件夹已经变化，请重新点击。');
    }
    let stat;
    try {
      stat = fs.lstatSync(real);
    } catch {
      throw fail('file_missing', '确认的目标已经不存在，请重新点击。');
    }
    if (stat.isSymbolicLink() || (wantsFile ? !stat.isFile() : !stat.isDirectory())) {
      throw fail('approval_stale', '确认期间目标类型已经变化，请重新点击。');
    }
    const unchanged = wantsFile
      ? sameFileIdentity(identity, stat)
      : sameStatIdentity(identity, directoryIdentity(stat));
    if (!unchanged) {
      throw fail('approval_stale', '确认期间目标已经被替换，请重新点击。');
    }
    return { target: real, stat, isFile: wantsFile };
  }

  /** 只能由 inspect 签发的一次性确认创建授权；不再接受渲染进程重新解释路径。 */
  function create({ approval, scopeKind = 'file', persistent = false, scope } = {}) {
    const conversationKey = conversationKeyOf(scope);
    const record = takeApproval(approval);
    if (record.conversationKey !== conversationKey || record.scopeKey !== scopeKeyOf(scope)) {
      throw fail('approval_stale', '确认期间会话或工作区已经变化，请重新点击。');
    }
    const normalized = approvedTarget(record, scopeKind);
    const directory = !normalized.isFile;
    rejectSensitive(normalized.target, { directory });
    if (persistent && !directory) throw fail('persistent_requires_directory', '只有目录授权可以长期保留。');
    if (grants.length >= EXTERNAL_LIMITS.maxGrants) {
      const removable = grants.findIndex((grant) => grant.scope === 'session');
      if (removable >= 0) grants.splice(removable, 1);
      else throw fail('grant_limit', '授权数量已达上限，请先撤销一部分。');
    }
    const covered = findCovering(conversationKey, normalized.target, { touchAccess: false });
    if (covered && covered.kind === 'file' && !sameFileIdentity(covered, normalized.stat)) {
      // 旧授权指向的是已经被替换的文件对象；先作废再签发新的。
      evictGrant(covered);
    } else if (covered && normalizeForCompare(covered.target) === normalizeForCompare(normalized.target)) {
      // 完全相同的目标才复用旧授权；目录内更具体的请求另签一条，
      // 避免把“只记住这个子目录”悄悄扩大成覆盖它的整棵目录。
      if (persistent && covered.kind !== 'directory') {
        throw fail('persistent_requires_directory', '只有目录授权可以长期保留。');
      }
      if (covered.kind === 'directory') {
        const sameObject = sameStatIdentity(covered.dirIdentity, directoryIdentity(normalized.stat));
        if (!sameObject) {
          /* 授权目录已经被替换：不能沿用旧记录（即使路径相同），否则等于
           * 把旧目录的授权搬到新目录上。 */
          evictGrant(covered);
        } else {
          if (persistent && covered.scope !== 'persistent') {
            covered.scope = 'persistent';
            touch();
          }
          return { ok: true, grant: publicGrant(covered), persistent: persistentGrants() };
        }
      } else {
        if (persistent && covered.scope !== 'persistent') {
          covered.scope = 'persistent';
          touch();
        }
        return { ok: true, grant: publicGrant(covered), persistent: persistentGrants() };
      }
    }
    const grant = {
      id: randomBytes(16).toString('hex'),
      conversationKey,
      kind: normalized.isFile ? 'file' : 'directory',
      scope: persistent ? 'persistent' : 'session',
      target: normalized.target,
      ...(normalized.isFile
        ? identityOf(normalized.stat)
        : { dirIdentity: directoryIdentity(normalized.stat) }),
      createdAt: new Date(now()).toISOString(),
      lastUsedAt: now(),
    };
    grants.push(grant);
    touch();
    return { ok: true, grant: publicGrant(grant), persistent: persistentGrants() };
  }

  function list(scope) {
    const conversationKey = conversationKeyOf(scope);
    return {
      ok: true,
      grants: grants.filter((grant) => grant.conversationKey === conversationKey).map(publicGrant),
    };
  }

  function revoke({ id, scope } = {}) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw fail('invalid_request', '授权标识不合法。');
    const conversationKey = conversationKeyOf(scope);
    const index = grants.findIndex((grant) => grant.id === id && grant.conversationKey === conversationKey);
    if (index < 0) throw fail('grant_missing', '授权不存在或已经撤销。');
    const [removed] = grants.splice(index, 1);
    touch();
    return {
      ok: true,
      id,
      removed: { ...publicGrant(removed), conversationKey: removed.conversationKey },
      persistent: persistentGrants(),
    };
  }

  /** 读取前验证授权。返回真实路径与打开前的身份快照。 */
  function authorizeRead({ grantId, rawPath, scope } = {}) {
    if (typeof grantId !== 'string' || !/^[a-f0-9]{32}$/.test(grantId)) {
      throw fail('grant_required', '需要先授权访问这个文件。');
    }
    const conversationKey = conversationKeyOf(scope);
    const grant = grants.find((item) => item.id === grantId && item.conversationKey === conversationKey);
    if (!grant) throw fail('grant_invalid', '授权不存在、已撤销或不属于当前会话。');
    if (!isAbsoluteLocalPath(rawPath) || hasUnsafeWindowsShape(String(rawPath))) {
      throw fail('invalid_path', '文件路径不合法。');
    }
    /* 授权目录对象本身先核对：目录被删除重建/重命名顶替/换成符号链接时，
     * 无论这次请求的是哪个文件，旧授权都已经死了 —— 逐出并通知上层，
     * 不能让它留在账本里靠“每次范围检查碰巧失败”来挡住访问。 */
    if (grant.kind === 'directory') {
      const current = directoryIdentityCurrent(grant.target);
      if (!current || !sameStatIdentity(grant.dirIdentity, current.identity)) {
        evictGrant(grant);
        throw fail('grant_changed', '授权的目录已经变化，请重新授权。');
      }
    }
    const requested = String(rawPath);
    const lexicalInside = grant.kind === 'directory'
      ? isInside(grant.target, requested)
      : normalizeForCompare(grant.target) === normalizeForCompare(requested);
    const real = realPathOrNull(requested);
    /* 词法上不在授权范围内时，realpath 只用于兼容 8.3 短名等别名；无论目标是
     * 不存在、还是存在但在范围外，都返回同一个 grant_scope。否则“文件不存在”
     * 与“文件存在但越权”会变成探测任意路径是否存在的旁路。 */
    if (!lexicalInside) {
      const aliasInside = real && (grant.kind === 'directory'
        ? isInside(grant.target, real)
        : normalizeForCompare(grant.target) === normalizeForCompare(real));
      if (!aliasInside) throw fail('grant_scope', grant.kind === 'directory'
        ? '这个文件不在已授权的目录内。' : '这个授权只适用于另一个文件。');
    }
    if (!real) throw fail('file_missing', '文件不存在。');
    let stat;
    try {
      stat = fs.lstatSync(real);
    } catch {
      throw fail('file_missing', '文件不存在。');
    }
    if (stat.isSymbolicLink()) throw fail('unsafe_path', '不接受符号链接。');
    if (!stat.isFile()) throw fail('not_a_file', '目标不是文件。');
    if (grant.kind === 'directory') {
      /* 目录对象身份已在范围检查之前核对过；这里只确认真实路径没逃出授权目录。 */
      if (!isInside(grant.target, real)) throw fail('grant_scope', '这个文件不在已授权的目录内。');
    } else {
      if (normalizeForCompare(grant.target) !== normalizeForCompare(real)) {
        throw fail('grant_scope', '这个授权只适用于另一个文件。');
      }
      if (!sameFileIdentity(grant, stat)) {
        throw fail('file_changed', '授权的文件已经被替换，请重新授权。');
      }
    }
    const targetKey = fileKey(real, stat);
    return { grant, real, stat, conversationKey, epoch, targetKey };
  }

  function assertStillValid(state) {
    if (!state || state.epoch !== epoch) throw fail('grant_changed', '授权状态已经变化，请重新打开文件。');
    const grant = grants.find((item) => item.id === state.grant.id);
    if (!grant) throw fail('grant_invalid', '授权已经被撤销。');
    /* 读取窗口很长：授权目录在 authorizeRead 之后、读完之前也可能被替换。
     * 与撤销同样处理 —— 旧对象不再放行。 */
    if (grant.kind === 'directory') {
      const current = directoryIdentityCurrent(grant.target);
      if (!current || !sameStatIdentity(grant.dirIdentity, current.identity)) {
        evictGrant(grant);
        throw fail('grant_changed', '授权的目录已经变化，请重新授权。');
      }
    }
    return grant;
  }

  return {
    inspect,
    create,
    restore,
    list,
    revoke,
    authorizeRead,
    assertStillValid,
    conversationKeyOf,
    publicGrant,
    persistentGrants,
    snapshot: () => ({ grants: grants.map(publicGrant), persistent: persistentGrants(), epoch }),
    dispose: () => { grants = []; approvals.clear(); touch(); },
  };
}
