'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

// Unlike Node's lstat, Win32 reports every reparse tag and NPFS/device type.
// This intentionally does not invoke the install/restore helpers: their other
// modes can write, and their manifests use different identity/size contracts.
// The only input to this fixed script is bounded, base64-encoded UTF-8 JSON on
// stdin; selected paths are never shell/script text. No path/stream name is
// emitted. This is a check, not an OS guard across subsequent Node operations.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class StoragePathCheck {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StreamInfo {
    public long Size; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=296)] public string Name;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string p, uint access, uint share, IntPtr sec, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("kernel32.dll")] static extern uint GetFileType(SafeFileHandle h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder p, uint n, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationW(string root, IntPtr label, uint labelSize, out uint serial, out uint max, out uint flags, IntPtr fs, uint fsSize);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr FindFirstStreamW(string p, int level, out StreamInfo info, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FindNextStreamW(IntPtr h, out StreamInfo info);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr h);
  static readonly HashSet<string> Parents = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static readonly Dictionary<string,bool> NamedStreams = new Dictionary<string,bool>(StringComparer.OrdinalIgnoreCase);
  static readonly StringBuilder FinalPath = new StringBuilder(8192);
  static bool HasNamedStreams(string root) {
    bool supported;
    if (NamedStreams.TryGetValue(root, out supported)) return supported;
    uint serial, max, flags, kind = GetDriveTypeW(root);
    if (kind != 2 && kind != 3) throw new IOException();
    if (!GetVolumeInformationW(root, IntPtr.Zero, 0, out serial, out max, out flags, IntPtr.Zero, 0)) throw new IOException();
    supported = (flags & 0x40000) != 0;
    NamedStreams.Add(root, supported);
    return supported;
  }
  static bool PlainStreams(string p, bool dir) {
    StreamInfo info;
    var find = FindFirstStreamW(p, 0, out info, 0);
    if (find == new IntPtr(-1)) {
      if (dir && Marshal.GetLastWin32Error() == 38) return true;
      throw new IOException();
    }
    try {
      if (info.Name != "::$DATA" || FindNextStreamW(find, out info)) return false;
      if (Marshal.GetLastWin32Error() != 38) throw new IOException();
      return true;
    } finally { FindClose(find); }
  }
  static int Inspect(string p, bool directory, bool streams, bool writable) {
    string native = @"\\?\" + p;
    using (var h = CreateFileW(native, writable ? 0x86u : 0x80u, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (h.IsInvalid) return Marshal.GetLastWin32Error() == 5 && writable ? 3 : 2;
      Info info;
      if (GetFileType(h) != 1 || !GetFileInformationByHandle(h, out info)) return 2;
      if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || (!directory && info.Links != 1)) return 1;
      uint size = GetFinalPathNameByHandleW(h, FinalPath, (uint)FinalPath.Capacity, 0);
      if (size == 0 || size >= FinalPath.Capacity) return 2;
      if (!String.Equals(native, FinalPath.ToString(), StringComparison.OrdinalIgnoreCase)) return 1;
      return !streams || PlainStreams(native, directory) ? 0 : 1;
    }
  }
  public static int Check(string p, bool directory, bool writable) {
    if (!Path.IsPathRooted(p) || p.Length < 3 || p[1] != ':' || p[2] != '\\' || p.IndexOf(':', 2) >= 0) return 1;
    var chain = new Stack<string>();
    for (var parent = Path.GetDirectoryName(p); !String.IsNullOrEmpty(parent) && !Parents.Contains(parent); parent = Path.GetDirectoryName(parent)) {
      if (chain.Count >= 64) return 1;
      chain.Push(parent);
    }
    foreach (var item in chain) {
      int result = Inspect(item, true, false, false);
      if (result != 0) return result;
      Parents.Add(item);
    }
    return Inspect(p, directory, HasNamedStreams(Path.GetPathRoot(p)), writable);
  }
}
'@
  $inputText = [Console]::In.ReadToEnd()
  if ($inputText.Length -gt 16777216) { exit 2 }
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($inputText)) | ConvertFrom-Json
  foreach ($entry in $request) {
    $code = [StoragePathCheck]::Check($entry.path, $entry.directory, $entry.writable)
    if ($code -ne 0) { exit $code }
  }
  exit 0
} catch { exit 2 }
`;
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64');

function inspectWindowsPaths(entries) {
  if (entries.length === 0) return Promise.resolve('ok');
  const input = Buffer.from(JSON.stringify(entries)).toString('base64');
  if (input.length > 16 * 1024 * 1024) return Promise.resolve('unavailable');
  const root = process.env.SystemRoot || 'C:\\Windows';
  if (!/^[a-z]:[\\/]/iu.test(root)) return Promise.resolve('unavailable');
  const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT],
      { windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); resolve('unavailable'); }, 30_000);
    child.on('error', () => { clearTimeout(timer); resolve('unavailable'); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve(code === 0 ? 'ok' : code === 1 ? 'unsafe' : code === 3 ? 'permission' : 'unavailable');
    });
    child.stdin.on('error', () => { /* exit status is authoritative, not a closed pipe */ });
    child.stdin.end(input);
  });
}

module.exports = { inspectWindowsPaths };
