'use strict';

/* 更新偏好策略与本地持久化。
 *
 * 这一层只做三件不依赖 Electron 的事：
 *   1. 严格版本判断（畸形版本永远不进下载/安装流程）；
 *   2. 判断当前安装形态是否支持自动安装；
 *   3. 把用户偏好、忽略版本、暂停版本、已提醒版本原子地写进 userData。
 *
 * 信任边界：偏好只能来自主进程校验后的值；本模块不接受 Renderer 传来的
 * 路径、URL、命令行或安装形态。配置损坏、字段未知、读写失败一律按
 * 「手动更新」安全降级，不把错误状态当成自动安装许可。 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SCHEMA_VERSION = 1;
const DEFAULT_UPDATE_PREFERENCE = 'manual';
const UPDATE_PREFERENCES = Object.freeze(['automatic', 'manual']);
const MAX_PREFERENCE_BYTES = 4096;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function isUpdatePreference(value) {
  return value === 'automatic' || value === 'manual';
}

function isStrictVersion(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

function compareParts(a, b) {
  const left = BigInt(a);
  const right = BigInt(b);
  return left === right ? 0 : left > right ? 1 : -1;
}

/* 返回 -1 / 0 / 1；任一版本畸形返回 null。 */
function compareVersions(a, b) {
  if (!isStrictVersion(a) || !isStrictVersion(b)) return null;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < 3; i += 1) {
    const result = compareParts(left[i], right[i]);
    if (result !== 0) return result;
  }
  return 0;
}

function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

/* Windows 正式 NSIS 安装版才具备「退出时自动安装」所需的外部安装助手与
 * 可替换目录。便携版、开发模式、形态未知及其他平台保持手动流程。
 * mode 必须来自 app-update.cjs 的 detectMode（注册表 + 真实 exe 身份）。 */
function resolveAutomaticSupport({ platform, packaged, mode }) {
  if (platform !== 'win32') {
    return { supported: false, code: 'platform' };
  }
  if (!packaged) {
    return { supported: false, code: 'development' };
  }
  if (mode !== 'installed') {
    return { supported: false, code: 'portable' };
  }
  return { supported: true, code: null };
}

function resolveEffectivePreference(preference, support) {
  if (!isUpdatePreference(preference)) return DEFAULT_UPDATE_PREFERENCE;
  if (preference === 'automatic' && !support?.supported) return 'manual';
  return preference;
}

function cleanVersion(value) {
  return isStrictVersion(value) ? value : null;
}

/* 写入失败时的“手动覆盖”标记。
 *
 * 只在用户显式把更新切回手动、或忽略/暂停等安全设置无法落盘时写入。
 * 它比偏好文件多一层保护：即便偏好文件仍是旧的 automatic，重启后也会
 * 先把有效策略降级为手动。标记本身只代表“自动更新不可信”，不携带版本
 * 或路径；无法读取时同样按手动处理。 */
function overrideFileFor(file) {
  return `${file}.manual-override`;
}

function parsePreferenceDocument(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false };
  }
  // 忽略/暂停是安全抑制字段：只要存在但不是严格版本号，就不能确认它们
  // 指向哪个版本，整份配置按损坏处理并降级为手动。已提醒版本只是书签，
  // 畸形时丢弃即可，不必因此拒绝一份仍然有效的偏好。
  if (parsed.ignoredVersion !== null && parsed.ignoredVersion !== undefined && !isStrictVersion(parsed.ignoredVersion)) {
    return { ok: false };
  }
  if (parsed.pausedVersion !== null && parsed.pausedVersion !== undefined && !isStrictVersion(parsed.pausedVersion)) {
    return { ok: false };
  }
  return {
    ok: true,
    preference: isUpdatePreference(parsed.preference)
      ? parsed.preference
      : DEFAULT_UPDATE_PREFERENCE,
    ignoredVersion: cleanVersion(parsed.ignoredVersion),
    pausedVersion: cleanVersion(parsed.pausedVersion),
    lastNotifiedVersion: cleanVersion(parsed.lastNotifiedVersion),
  };
}

function defaultState() {
  return {
    preference: DEFAULT_UPDATE_PREFERENCE,
    ignoredVersion: null,
    pausedVersion: null,
    lastNotifiedVersion: null,
  };
}

function createPreferenceStore({ file, fsImpl = fs, randomId = randomUUID }) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('preference store requires a file path');
  }
  const directory = path.dirname(file);
  const overrideFile = overrideFileFor(file);
  let state = defaultState();
  let persisted = null;
  const dirty = {
    preference: false,
    ignoredVersion: false,
    pausedVersion: false,
    lastNotifiedVersion: false,
  };
  let corrupt = false;
  let saveFailed = false;
  let loaded = false;
  let overrideActive = false;
  let overridePersisted = false;

  function hasOverride() {
    try {
      fsImpl.lstatSync(overrideFile);
      return true;
    } catch (error) {
      // 只有明确的“不存在”才算没有标记；权限错误、I/O 错误都按存在处理，
      // 宁可本次降级为手动，也不能把未知状态当成自动安装许可。
      return Boolean(error && error.code !== 'ENOENT');
    }
  }

  function load() {
    let stat;
    try {
      stat = fsImpl.lstatSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // fall through to the override marker check
      } else {
        corrupt = true;
      }
    }
    if (stat) {
      // 配置只应是普通文件。符号链接/目录/设备一律不读，避免被外部指向
      // 其它位置；下一次用户保存会用原子替换写回普通文件。
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PREFERENCE_BYTES) {
        corrupt = true;
      } else {
        let text;
        try {
          text = fsImpl.readFileSync(file, 'utf8');
        } catch {
          corrupt = true;
        }
        if (text !== undefined) {
          let parsed;
          try {
            parsed = parsePreferenceDocument(text);
          } catch {
            corrupt = true;
          }
          if (parsed?.ok) {
            state = {
              preference: parsed.preference,
              ignoredVersion: parsed.ignoredVersion,
              pausedVersion: parsed.pausedVersion,
              lastNotifiedVersion: parsed.lastNotifiedVersion,
            };
            persisted = { ...state };
            loaded = true;
          } else if (parsed) {
            corrupt = true;
          }
        }
      }
    }

    overrideActive = hasOverride();
    overridePersisted = overrideActive;
    if (overrideActive) {
      // 标记存在的全部意义就是“不要把文件里的 automatic 当许可”。
      // 仍保留 persisted 供界面说明差异，但当前有效策略固定为手动。
      if (state.preference === 'automatic') state.preference = 'manual';
      saveFailed = true;
    }
  }

  load();

  /* 自动权限必须是“已加载、已成功写入、偏好与安全抑制都没有脏值”的交集。
   * 后台通知书记忆（lastNotifiedVersion）失败不影响这项判断。 */
  function automaticTrusted() {
    if (corrupt || overrideActive || !loaded || !persisted) return false;
    if (state.preference !== 'automatic' || persisted.preference !== 'automatic') return false;
    if (dirty.preference || dirty.ignoredVersion || dirty.pausedVersion) return false;
    return true;
  }

  function snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      ...state,
      corrupt,
      loaded,
      saveFailed,
      requestedPreference: state.preference,
      persistedPreference: persisted ? persisted.preference : null,
      persistedIgnoredVersion: persisted ? persisted.ignoredVersion : null,
      persistedPausedVersion: persisted ? persisted.pausedVersion : null,
      dirtyPreference: dirty.preference,
      dirtyIgnoredVersion: dirty.ignoredVersion,
      dirtyPausedVersion: dirty.pausedVersion,
      overrideActive,
      overridePersisted,
      automaticTrusted: automaticTrusted(),
    };
  }

  function clearDirty() {
    for (const key of Object.keys(dirty)) dirty[key] = false;
  }

  function writeOverride() {
    const temp = path.join(
      directory,
      `.${path.basename(overrideFile)}.${process.pid}.${randomId()}.tmp`,
    );
    let fd = null;
    try {
      fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fd = fsImpl.openSync(temp, 'wx', 0o600);
      fsImpl.writeFileSync(fd, `{"schemaVersion":${SCHEMA_VERSION},"reason":"manual"}\n`, 'utf8');
      fsImpl.fsyncSync(fd);
      fsImpl.closeSync(fd);
      fd = null;
      fsImpl.renameSync(temp, overrideFile);
      overrideActive = true;
      overridePersisted = true;
      return true;
    } catch {
      if (fd !== null) {
        try {
          fsImpl.closeSync(fd);
        } catch {
          // 清理失败不影响内存状态。
        }
      }
      try {
        fsImpl.rmSync(temp, { force: true });
      } catch {
        // 临时文件名带随机 id，不会被当成配置读取。
      }
      overrideActive = false;
      overridePersisted = false;
      return false;
    }
  }

  function clearOverride() {
    try {
      fsImpl.rmSync(overrideFile, { force: true });
      overrideActive = false;
      overridePersisted = false;
      return true;
    } catch {
      // 标记理论上只应是普通文件。若被替换成空目录，rmdir 能安全清掉；
      // 非空目录/链接等异常形态保持原样并按保存失败处理。
      try {
        fsImpl.rmdirSync(overrideFile);
        overrideActive = false;
        overridePersisted = false;
        return true;
      } catch {
        overrideActive = true;
        overridePersisted = true;
        return false;
      }
    }
  }

  function persist() {
    const temp = path.join(
      directory,
      `.${path.basename(file)}.${process.pid}.${randomId()}.tmp`,
    );
    let fd = null;
    try {
      fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const body = `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        preference: state.preference,
        ignoredVersion: state.ignoredVersion,
        pausedVersion: state.pausedVersion,
        lastNotifiedVersion: state.lastNotifiedVersion,
      })}\n`;
      fd = fsImpl.openSync(temp, 'wx', 0o600);
      fsImpl.writeFileSync(fd, body, 'utf8');
      fsImpl.fsyncSync(fd);
      fsImpl.closeSync(fd);
      fd = null;
      fsImpl.renameSync(temp, file);
      persisted = { ...state };
      clearDirty();
      corrupt = false;
      loaded = true;
      saveFailed = false;
      // 偏好文件已经写入后，覆盖标记必须清掉，否则自动更新会永远被
      // 降级为手动。清理失败按保存失败上报，让用户看到真实有效状态。
      if (overrideActive || hasOverride()) {
        if (!clearOverride()) {
          saveFailed = true;
          return false;
        }
      }
      return true;
    } catch {
      if (fd !== null) {
        try {
          fsImpl.closeSync(fd);
        } catch {
          // 忽略清理失败；下面还会尝试删除临时文件。
        }
      }
      try {
        fsImpl.rmSync(temp, { force: true });
      } catch {
        // 清理失败不影响内存状态；临时文件名带随机 id，不会被当成配置读取。
      }
      saveFailed = true;
      // 偏好切回手动，或忽略/暂停这类安全抑制无法确认落盘：必须留下
      // 跨进程的手动覆盖标记。仅通知书签失败不触发这一层。
      if (
        state.preference === 'manual' ||
        dirty.ignoredVersion ||
        dirty.pausedVersion
      ) {
        writeOverride();
      }
      return false;
    }
  }

  function validatePatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
    const keys = Object.keys(patch);
    for (const key of keys) {
      if (key === 'preference') {
        if (!isUpdatePreference(patch.preference)) return false;
      } else if (
        key === 'ignoredVersion' ||
        key === 'pausedVersion' ||
        key === 'lastNotifiedVersion'
      ) {
        if (patch[key] !== null && !isStrictVersion(patch[key])) return false;
      } else {
        return false;
      }
    }
    return keys.length > 0;
  }

  function update(patch, { repair = true, transient = false } = {}) {
    if (!validatePatch(patch)) {
      return { ok: false, code: 'invalid_preference_state' };
    }
    const changed = Object.keys(patch).filter((key) => state[key] !== patch[key]);
    state = { ...state, ...patch };
    // 后台发现更高版本时会即时清掉已过期的忽略/暂停。这不是用户的安全
    // 抑制动作，也不是一次可持久化的保存：只改内存，不能因此给未落盘的
    // automatic 盖章，也不能把旧抑制从文件里“偷偷”改掉。
    if (transient) {
      return { ok: true, persisted: false, transient: true, state: snapshot() };
    }
    for (const key of changed) dirty[key] = true;

    // 损坏文件只在用户显式操作（保存偏好、忽略、取消等）时修复。后台检查
    // 更新 lastNotifiedVersion 只是书签，不能在用户没动手时覆盖原文件。
    if (corrupt && repair !== true) {
      return { ok: true, persisted: false, skipped: true, state: snapshot() };
    }
    // 后台书签更不能顺手把未成功落盘的 automatic / 忽略 / 暂停写进文件；
    // 那会把刚被撤销的自动安装权限“意外恢复”成持久许可。
    if (
      repair !== true &&
      (overrideActive || dirty.preference || dirty.ignoredVersion || dirty.pausedVersion)
    ) {
      return { ok: true, persisted: false, skipped: true, state: snapshot() };
    }
    if (changed.length === 0 && loaded && !saveFailed && !overrideActive) {
      return { ok: true, persisted: true, unchanged: true, state: snapshot() };
    }
    const persistedOk = persist();
    return {
      ok: true,
      persisted: persistedOk,
      ...(persistedOk ? {} : { code: 'write_failed' }),
      state: snapshot(),
    };
  }

  function setPreference(value) {
    if (!isUpdatePreference(value)) {
      return { ok: false, code: 'invalid_preference' };
    }
    return update({ preference: value });
  }

  return {
    file,
    overrideFile,
    snapshot,
    automaticTrusted,
    setPreference,
    update,
    setIgnoredVersion(value) {
      return update({ ignoredVersion: value });
    },
    setPausedVersion(value) {
      return update({ pausedVersion: value });
    },
    setLastNotifiedVersion(value) {
      return update({ lastNotifiedVersion: value });
    },
  };
}

module.exports = {
  DEFAULT_UPDATE_PREFERENCE,
  MAX_PREFERENCE_BYTES,
  SCHEMA_VERSION,
  UPDATE_PREFERENCES,
  compareVersions,
  createPreferenceStore,
  isNewerVersion,
  isStrictVersion,
  isUpdatePreference,
  resolveAutomaticSupport,
  resolveEffectivePreference,
};
