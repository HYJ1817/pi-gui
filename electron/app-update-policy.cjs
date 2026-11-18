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

function parsePreferenceDocument(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
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
  let state = defaultState();
  let corrupt = false;
  let saveFailed = false;
  let loaded = false;

  function load() {
    let stat;
    try {
      stat = fsImpl.lstatSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      corrupt = true;
      return;
    }
    // 配置只应是普通文件。符号链接/目录/设备一律不读，避免被外部指向
    // 其它位置；下一次用户保存会用原子替换写回普通文件。
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PREFERENCE_BYTES) {
      corrupt = true;
      return;
    }
    let text;
    try {
      text = fsImpl.readFileSync(file, 'utf8');
    } catch {
      corrupt = true;
      return;
    }
    let parsed;
    try {
      parsed = parsePreferenceDocument(text);
    } catch {
      corrupt = true;
      return;
    }
    if (!parsed.ok) {
      corrupt = true;
      return;
    }
    state = {
      preference: parsed.preference,
      ignoredVersion: parsed.ignoredVersion,
      pausedVersion: parsed.pausedVersion,
      lastNotifiedVersion: parsed.lastNotifiedVersion,
    };
    loaded = true;
  }

  load();

  function snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      ...state,
      corrupt,
      loaded,
      saveFailed,
    };
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
      saveFailed = false;
      loaded = true;
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

  function update(patch, { repair = true } = {}) {
    if (!validatePatch(patch)) {
      return { ok: false, code: 'invalid_preference_state' };
    }
    state = { ...state, ...patch };
    // 损坏文件只在用户显式操作（保存偏好、忽略、取消等）时修复。后台检查
    // 更新 lastNotifiedVersion 只是书签，不能在用户没动手时覆盖原文件。
    if (corrupt && repair !== true) {
      return { ok: true, persisted: false, skipped: true, state: snapshot() };
    }
    const persisted = persist();
    return { ok: true, persisted, state: snapshot() };
  }

  function setPreference(value) {
    if (!isUpdatePreference(value)) {
      return { ok: false, code: 'invalid_preference' };
    }
    return update({ preference: value });
  }

  return {
    file,
    snapshot,
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
