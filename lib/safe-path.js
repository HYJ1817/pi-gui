/* 项目内路径校验 —— 安全边界上最关键的一环。
 *
 * 单独成模块（而不是塞进 lib/git.js）的理由：这里的每一条分支都对应一个
 * 真实的越权手法，是 review 和测试时最该一眼看到的东西。它同时被
 * 「打开文件」「查看 diff」「撤销改动」三条链路共用，放一处才不会各写一遍、
 * 各漏一种情况。
 *
 * 被挡住的手法：
 *   1. `../` 相对逃逸              —— 字符串层先挡一次
 *   2. 绝对路径（`C:\Windows\…`）   —— 直接拒，Git 返回的永远是相对路径，没有正当用途
 *   3. 符号链接 / junction 逃逸     —— 必须用 realpath 解析后再比一次
 *   4. Windows 大小写 / 分隔符差异  —— 比较前归一，否则 `C:\Proj` 与 `c:\proj\x` 判不出包含关系
 *   5. 前缀伪装（`/proj-evil`）     —— 比的是「root + 分隔符」而不是裸前缀
 *
 * 注意第 3 条不能省：只做字符串归一的话，项目里一个指向 `C:\` 的 junction
 * 就能让 `link\Windows\win.ini` 通过校验。 */

import fs from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
/* Windows 与 macOS 的文件系统默认不区分大小写。比较时统一小写，
 * 否则同一个路径换个大小写就会被判成「在外面」。 */
const CASE_INSENSITIVE = IS_WIN || process.platform === 'darwin';

/** 归一成可比较的形式：统一分隔符、折叠重复斜杠、去尾斜杠、按平台决定是否小写。 */
export function normalizeForCompare(p) {
  let t = String(p ?? '').replace(/\\/g, '/');
  t = t.replace(/\/{2,}/g, '/');
  // Windows 的长路径前缀（\\?\C:\…）在归一后是 //?/C:/…，去掉它才好比
  t = t.replace(/^\/\?\/?/, '');
  if (t.length > 1) t = t.replace(/\/+$/, '');
  return CASE_INSENSITIVE ? t.toLowerCase() : t;
}

/** target 是否位于 root 之内（含 root 本身）。
 *
 * 必须比「root + '/'」而不是裸前缀：否则 `/proj-evil/x` 会被当成在 `/proj` 里面。 */
export function isInside(root, target) {
  const r = normalizeForCompare(root);
  const t = normalizeForCompare(target);
  if (!r || !t) return false;
  if (t === r) return true;
  return t.startsWith(r + '/');
}

/** 解析真实路径。用 native 版本 —— 它会把 junction / 符号链接一路解到底。
 *  路径不存在（例如文件已被删除）时返回 null，由调用方决定怎么办。 */
export function realPathOrNull(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** 绝对路径判定，含 Windows 盘符与 UNC 形式。 */
export function isAbsoluteAny(p) {
  const s = String(p ?? '');
  return path.isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('//');
}

/**
 * 把一个「相对项目根的路径」解析成绝对路径，并确认它没有跑出项目。
 *
 * @param {string} projectRoot 项目根目录（绝对路径）
 * @param {string} relativePath 来自客户端的相对路径
 * @returns {{ok:true, abs:string, rel:string, missing:boolean} | {ok:false, code:string, error:string}}
 *
 * code 取值（便于测试与前端区分）：
 *   'no-root'   项目根不可用
 *   'empty'     没给路径
 *   'illegal'   含 NUL 等非法字符
 *   'absolute'  传了绝对路径
 *   'escape'    字符串层就跑到项目外了（`../`）
 *   'symlink'   realpath 之后跑到项目外了（符号链接 / junction）
 */
export function resolveProjectPath(projectRoot, relativePath) {
  const rootReal = realPathOrNull(projectRoot);
  if (!rootReal) return { ok: false, code: 'no-root', error: '项目目录不可用' };

  const raw = String(relativePath ?? '').trim();
  if (!raw) return { ok: false, code: 'empty', error: '缺少文件路径' };
  if (raw.includes('\0')) return { ok: false, code: 'illegal', error: '路径包含非法字符' };

  // Git 返回的路径永远是相对的。收绝对路径没有任何正当场景，一律拒。
  if (isAbsoluteAny(raw)) {
    return { ok: false, code: 'absolute', error: '不接受绝对路径，请使用相对项目根的路径' };
  }

  const joined = path.resolve(rootReal, raw);

  // 第一层：字符串归一后必须仍在项目内。这一步能挡掉绝大多数 `../` 手法，
  // 而且即使后面 realpath 失败（文件不存在）也已经安全了。
  if (!isInside(rootReal, joined)) {
    return { ok: false, code: 'escape', error: '路径越出项目目录' };
  }

  // 第二层：解析真实路径，挡符号链接 / junction 逃逸。
  const realJoined = realPathOrNull(joined);
  if (realJoined) {
    if (!isInside(rootReal, realJoined)) {
      return { ok: false, code: 'symlink', error: '路径经符号链接指向项目之外' };
    }
    return { ok: true, abs: realJoined, rel: path.relative(rootReal, realJoined), missing: false };
  }

  /* 文件不存在（删除后查看、撤销删除等场景会走到这里）。
   * 不存在的路径本身不可能是符号链接，但它的**父目录**可能是，
   * 所以仍然要校验父目录的真实路径。 */
  const parentReal = realPathOrNull(path.dirname(joined));
  if (!parentReal) return { ok: false, code: 'no-root', error: '路径不可用（父目录不存在）' };
  if (!isInside(rootReal, parentReal)) {
    return { ok: false, code: 'symlink', error: '路径经符号链接指向项目之外' };
  }
  return { ok: true, abs: joined, rel: path.relative(rootReal, joined), missing: true };
}
