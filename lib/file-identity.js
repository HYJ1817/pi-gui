/* 文件/目录对象身份：dev+ino 为主，FileIndex 可能被复用时再辅以 birthtime/ctime。
 *
 * Windows 的 NTFS FileIndex 不是可靠唯一身份：同一目录被删除后立刻重建，理论上
 * 能拿到同一个 ino。Node 的 stat 只有 dev/ino/size/mtime/ctime/birthtime 这些字段，
 * 没有更稳的“对象 GUID”；所以目录身份用 dev+ino+birthtime+ctime，文件身份
 * 在之上再加 size+mtime。
 *
 * 注意：ctime 在 Windows 上是“最近一次元数据/内容变化”，不是创建时间；
 * 它不能被用户回拨，但仍会随文件改写变化 —— 所以只把它当“是否还是同一个对象”
 * 的旁证，不当“内容没变”的证据。 */

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
  /* 目录的 size/mtime 会随成员增删而变，不能纳入身份；否则“往里存了一个文件”
   * 会把目录授权误判失效。对象身份只用 dev+ino+birthtime+ctime。 */
  return statIdentity(stat);
}

export function sameStatIdentity(a, b) {
  if (!a || !b) return false;
  return String(a.dev) === String(b.dev)
    && String(a.ino) === String(b.ino)
    && a.birthtimeMs === b.birthtimeMs;
}

export function sameFileIdentity(a, b) {
  return sameStatIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
