import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const fail = () => { throw Object.assign(Error('evidence_storage_failed'), { code: 'evidence_storage_failed' }); };
const fingerprint = s => [s.dev, s.ino, s.size, s.birthtimeMs, s.mtimeMs, s.ctimeMs, s.mode, s.nlink].join(':');
const directoryIdentity = s => [s.dev, s.ino, s.birthtimeMs, s.mode].join(':');
const nativeSource = `using System; using System.IO; using System.Collections.Generic; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class RevertAllocation {
 [StructLayout(LayoutKind.Sequential)] public struct Standard { public long AllocationSize; public long EndOfFile; public uint NumberOfLinks; [MarshalAs(UnmanagedType.U1)] public bool DeletePending; [MarshalAs(UnmanagedType.U1)] public bool Directory; }
 [StructLayout(LayoutKind.Sequential)] public struct Tag { public uint Attributes; public uint ReparseTag; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int type,out Standard s,uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int type,out Tag s,uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int type,IntPtr buffer,uint size);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetDiskFreeSpaceW(string root,out uint sectors,out uint bytes,out uint free,out uint total);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFileAttributesW(string p);
 public static long[] Measure(string p) { using(var h=CreateFileW(p,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
  Standard s; Tag tag;
  if(h.IsInvalid || !GetFileInformationByHandleEx(h,1,out s,(uint)Marshal.SizeOf(typeof(Standard))) || !GetFileInformationByHandleEx(h,9,out tag,(uint)Marshal.SizeOf(typeof(Tag))) || (tag.Attributes & 0x400)!=0 || s.Directory || s.DeletePending || s.NumberOfLinks!=1 || s.AllocationSize<0 || s.EndOfFile<0) throw new IOException("allocation_unavailable");
  // FileStreamInfo queries the same opened object. Oversized/unknown stream
  // tables and any named stream are rejected, never omitted from accounting.
  IntPtr streams=Marshal.AllocHGlobal(16384); try {
   if(!GetFileInformationByHandleEx(h,7,streams,16384)) throw new IOException("allocation_unavailable");
   int next=Marshal.ReadInt32(streams,0), length=Marshal.ReadInt32(streams,4);
   if(next!=0 || length<0 || length>16360 || (length & 1)!=0 || Marshal.PtrToStringUni(IntPtr.Add(streams,24),length/2)!="::$DATA") throw new IOException("allocation_unavailable");
  } finally { Marshal.FreeHGlobal(streams); }
  return new long[]{s.EndOfFile,s.AllocationSize}; }}
 public static long Unit(string root) {
  string current=Path.GetFullPath(root); int depth=0; var checkedPaths=new List<string>(); var checkedAttributes=new List<uint>();
  while(true) {
   uint attributes=GetFileAttributesW(current);
   // Ordinary directory attributes only: EFS, compression, reparse points and
   // unknown profiles cannot justify the future-file allocation estimate.
   if(++depth>2048 || attributes==0xffffffff || (attributes & 0x10)==0 || (attributes & ~0x20b7U)!=0) throw new IOException("allocation_unavailable");
   checkedPaths.Add(current); checkedAttributes.Add(attributes);
   DirectoryInfo parent=Directory.GetParent(current); if(parent==null) break; current=parent.FullName;
  }
  uint sectors,bytes,free,total;
  if(!GetDiskFreeSpaceW(Path.GetPathRoot(root),out sectors,out bytes,out free,out total) || sectors==0 || bytes==0) throw new IOException("allocation_unavailable");
  for(int i=0;i<checkedPaths.Count;i++) if(GetFileAttributesW(checkedPaths[i])!=checkedAttributes[i]) throw new IOException("allocation_unavailable");
  return checked((long)sectors*bytes);
 }
}`;
async function nativeProbe(paths, unit = false, timeout = 10000) {
  const text = JSON.stringify(paths);
  if (Buffer.byteLength(text, 'utf16le') > 24000 || paths.length > 32) fail();
  const env = { ...process.env, PI_GUI_ALLOCATION_INPUT: text };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const script = `$ErrorActionPreference='Stop'; try { Add-Type -TypeDefinition @'\n${nativeSource}\n'@; $items=ConvertFrom-Json $env:PI_GUI_ALLOCATION_INPUT; $result=@(foreach($p in $items){ `
    + (unit ? `[RevertAllocation]::Unit($p)` : `$n=[RevertAllocation]::Measure($p); @{logicalBytes=$n[0];allocatedBytes=$n[1]}`)
    + ` }); ConvertTo-Json -Compress -InputObject $result } catch { [Console]::Error.WriteLine('allocation_unavailable'); exit 1 }`;
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout, maxBuffer: 8192, env }, (error, stdout) => {
      if (error) return reject(Object.assign(Error('evidence_storage_failed'), { code: 'evidence_storage_failed' }));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(Object.assign(Error('evidence_storage_failed'), { code: 'evidence_storage_failed' })); }
    }));
}
async function regular(location) {
  if (typeof location !== 'string' || !path.isAbsolute(location) || location.length > 4096 || /[\x00-\x1f]/.test(location)) fail();
  let current = location;
  while (true) {
    const s = await fs.lstat(current);
    if (s.isSymbolicLink() || (current === location ? !s.isFile() || s.nlink !== 1 : !s.isDirectory())) fail();
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return fs.lstat(location);
}
/** Private bounded allocation probe. Never return native diagnostics or paths. */
export async function measureStorageFiles(paths, { deadline = Date.now() + 15000 } = {}) {
  if (!Array.isArray(paths) || paths.length > 20000) fail();
  const timed = () => { if (Date.now() >= deadline) fail(); };
  const result = [];
  for (let offset = 0; offset < paths.length;) {
    timed();
    const batch = []; let chars = 0;
    while (offset < paths.length && batch.length < 32 && chars + paths[offset].length < 11000) { chars += paths[offset].length; batch.push(paths[offset++]); }
    if (!batch.length) fail();
    const before = await Promise.all(batch.map(regular));
    timed();
    const rows = process.platform === 'win32' ? await nativeProbe(batch, false, Math.max(1, Math.min(10000, deadline - Date.now()))) : before.map(s => ({ logicalBytes: s.size, allocatedBytes: s.blocks * 512 }));
    if (!Array.isArray(rows) || rows.length !== batch.length) fail();
    for (let i = 0; i < batch.length; i++) {
      timed();
      const after = await regular(batch[i]), row = rows[i];
      if (fingerprint(before[i]) !== fingerprint(after) || row.logicalBytes !== after.size
        || !Number.isSafeInteger(row.logicalBytes) || row.logicalBytes < 0 || !Number.isSafeInteger(row.allocatedBytes) || row.allocatedBytes < 0) fail();
      result.push({ logicalBytes: row.logicalBytes, allocatedBytes: row.allocatedBytes, chargeBytes: Math.max(row.logicalBytes, row.allocatedBytes) });
    }
  }
  return result;
}
export async function measureAllocationUnit(root) {
  const ancestors = []; let current = path.resolve(root);
  while (true) {
    const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    ancestors.push([current, directoryIdentity(stat)]);
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  const unit = process.platform === 'win32' ? (await nativeProbe([path.resolve(root)], true))[0] : (await fs.statfs(root)).bsize;
  if (!Number.isSafeInteger(unit) || unit < 1) fail();
  for (const [location, before] of ancestors) { const after = await fs.lstat(location); if (after.isSymbolicLink() || directoryIdentity(after) !== before) fail(); }
  return unit;
}
