/* 文件/目录对象身份：dev+ino 为主，FileIndex 可能被复用时再辅以 birthtime。
 *
 * Windows 的 NTFS FileIndex 不是可靠唯一身份：同一目录被删除后立刻重建，理论上
 * 能拿到同一个 ino。Node 的 stat 只有 dev/ino/size/mtime/ctime/birthtime 这些字段，
 * 没有更稳的“对象 GUID”；所以目录身份用 dev+ino+birthtime，文件身份
 * 在之上再加 size/mtime/ctime。
 *
 * 注意两个时间字段的角色：
 *   - ctime 在 Windows 上≈birthtime（不可回拨），在 POSIX 上是“inode 最近
 *     元数据/内容变化”，同样**不可由用户回拨** —— 文件身份比对带它，能抓到
 *     “改写后又把 mtime 拨回去”的替换；
 *   - 目录的 size/mtime/ctime 会随成员增删变化，不能纳入目录身份，否则“往里
 *     存了一个文件”就把目录授权误判失效。 */

export function statIdentity(stat) {
  if (!stat) return null;
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeMs: stat.birthtimeMs,
  };
}

export function fileIdentityOf(stat) {
  const base = statIdentity(stat);
  if (!base) return null;
  return { ...base, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

export function directoryIdentityOf(stat) {
  /* 目录的 size/mtime/ctime 会随成员增删而变，不能纳入身份；否则“往里存了一个文件”
   * 会把目录授权误判失效。目录对象身份只用 dev+ino+birthtime。 */
  return statIdentity(stat);
}

export function sameStatIdentity(a, b) {
  if (!a || !b) return false;
  return String(a.dev) === String(b.dev)
    && String(a.ino) === String(b.ino)
    && a.birthtimeMs === b.birthtimeMs;
}

export function sameFileIdentity(a, b) {
  /* ctime 一并比对：POSIX 上 mtime 可被 utimes 回拨，ctime 不行；
   * Windows 上 ctime≈birthtime，多比一项无害且更强。 */
  return sameStatIdentity(a, b)
    && a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs;
}
