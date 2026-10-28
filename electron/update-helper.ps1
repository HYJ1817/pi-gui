param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
$runDir = Split-Path -Parent $Request
$resultFile = Join-Path $runDir 'result.json'
$backup = Join-Path $runDir 'backup'
$manifest = Join-Path $runDir 'backup-manifest.json'
$changed = $false
$success = $false
$parentExited = $false
$restartPid = $null
$resultPhase = 'failed'
$config = $null
function Save-Result($code) {
  $script:resultPhase = $code
  # Diagnostic persistence must never change install/rollback ordering. In
  # particular, a failed timeout record must not bypass WaitForExit below.
  try {
    @{ phase = $code; expectedVersion = $config.version; previousVersion = $config.previousVersion; restartPid = $restartPid } |
      ConvertTo-Json -Compress | Set-Content -LiteralPath $resultFile -Encoding UTF8
  } catch { }
}
function No-Reparse([string]$target) {
  $item = Get-Item -LiteralPath $target -Force
  while ($null -ne $item) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    if ($item -is [IO.DirectoryInfo]) { $item = $item.Parent } else { $item = $item.Directory }
  }
}
function File-Hash([string]$target) {
  $stream = [IO.File]::OpenRead($target)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','') }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
# Recovery operations use the validated object handle, never a second pathname
# lookup for writes/deletion. Directory handles deny rename while paths are used.
function Initialize-Recovery {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class UpdateRecovery {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref int data, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
  static Info Inspect(SafeFileHandle file, bool directory) {
    Info info;
    if (file.IsInvalid || !GetFileInformationByHandle(file, out info)) throw new Win32Exception();
    if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || (!directory && info.Links != 1)) throw new IOException("object_identity");
    return info;
  }
  static string Id(Info info) { return info.Volume+":"+info.IndexHigh+":"+info.IndexLow; }
  static SafeFileHandle Open(string path, uint access, uint share, bool directory, uint mode=3) {
    var file=CreateFile(path,access,share,IntPtr.Zero,mode,0x200000u | (directory ? 0x2000000u : 0u),IntPtr.Zero);
    try {
      Inspect(file,directory);
      var final=new StringBuilder(32768);
      uint size=GetFinalPathNameByHandle(file,final,(uint)final.Capacity,0);
      if(size==0 || size>=final.Capacity || !String.Equals(final.ToString(),"\\\\?\\"+Path.GetFullPath(path).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)) throw new IOException("path_identity");
      return file;
    } catch { file.Dispose(); throw; }
  }
  public static SafeFileHandle Pin(string path) { return Open(path,0x80,3,true); }
  public static string Identity(string path, bool directory) {
    using(var file=Open(path,0x80,3,directory)) { return Id(Inspect(file,directory)); }
  }
  static string Hash(Stream stream) {
    using(var sha=SHA256.Create()) { return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", ""); }
  }
  public static string[] Describe(string path) {
    using(var file=Open(path,0x80000000,1,false))
    using(var stream=new FileStream(file,FileAccess.Read)) {
      return new string[] { Id(Inspect(file,false)), Hash(stream), stream.Length.ToString() };
    }
  }
  public static void Remove(string path, string identity, string hash, bool directory) {
    using(var file=Open(path,directory ? 0x10080u : 0x80010000u, directory ? 3u : 0u,directory)) {
      if (Id(Inspect(file,directory)) != identity) throw new IOException("object_changed");
      if (!directory) {
        using(var stream=new FileStream(file,FileAccess.Read)) {
          if(Hash(stream)!=hash) throw new IOException("content_changed");
          int remove=1;
          if(!SetFileInformationByHandle(file,4,ref remove,4)) throw new Win32Exception();
        }
      } else {
        int remove=1;
        // Windows itself refuses nonempty directory deletion, including races.
        if(!SetFileInformationByHandle(file,4,ref remove,4)) throw new Win32Exception();
      }
    }
  }
  public static void Restore(string source, string target, string hash, string identity, string currentHash) {
    using(var inputHandle=Open(source,0x80000000,1,false))
    using(var input=new FileStream(inputHandle,FileAccess.Read)) {
      if(Hash(input)!=hash) throw new IOException("backup_changed");
      input.Position=0;
      // OPEN_EXISTING never follows links; missing files use CREATE_NEW.
      using(var outputHandle=Open(target,0xc0000000,0,false,String.IsNullOrEmpty(identity) ? 1u : 3u))
      using(var output=new FileStream(outputHandle,FileAccess.ReadWrite)) {
        if(!String.IsNullOrEmpty(identity) && (Id(Inspect(outputHandle,false))!=identity || Hash(output)!=currentHash)) throw new IOException("destination_changed");
        output.Position=0;
        input.CopyTo(output); output.SetLength(input.Length); output.Flush(true);
      }
    }
  }
}
'@
}
function Get-Inventory([string]$root) {
  $entries = @()
  $pins = New-Object 'System.Collections.Generic.List[System.IDisposable]'
  try {
  $pending = New-Object 'System.Collections.Generic.Queue[string]'
  $pending.Enqueue($root)
  while ($pending.Count -gt 0) {
   $directory = $pending.Dequeue()
   $pins.Add([UpdateRecovery]::Pin($directory))
   foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    $relative = $item.FullName.Substring($root.Length).TrimStart('\')
    if ($item -is [IO.DirectoryInfo]) {
      $entries += [ordered]@{ path = $relative; type = 'directory'; identity = [UpdateRecovery]::Identity($item.FullName,$true) }
      $pending.Enqueue($item.FullName)
    } elseif ($item -is [IO.FileInfo]) {
      $description = [UpdateRecovery]::Describe($item.FullName)
      $entries += [ordered]@{ path = $relative; type = 'file'; size = [long]$description[2]; sha256 = $description[1]; identity = $description[0] }
    } else { throw 'unsupported_file_type' }
  }
  }
  return @($entries | Sort-Object -Property path -CaseSensitive)
  } finally { foreach ($pin in $pins) { $pin.Dispose() } }
}
function Test-Inventory([string]$root,[object[]]$expected) {
  $actual = @(Get-Inventory $root)
  if ($actual.Count -ne $expected.Count) { return $false }
  for ($i = 0; $i -lt $expected.Count; $i++) {
    $left = $expected[$i]
    $right = $actual[$i]
    if ($left.path -cne $right.path -or $left.type -cne $right.type) { return $false }
    if ($left.type -eq 'file' -and ($left.size -ne $right.size -or $left.sha256 -cne $right.sha256)) { return $false }
  }
  return $true
}
function Restore-Inventory([string]$root,[object[]]$expected,[object[]]$postInstall) {
  No-Reparse $backup
  if (-not (Test-Inventory $backup $expected)) { throw 'backup_changed' }
  $pins = @{}
  try {
  # Pin every existing directory before removing or restoring any file. Also pin
  # the backup tree: a changed/reparsed backup is never a restore authority.
  foreach ($base in @($root,$backup)) {
    $pending = New-Object 'System.Collections.Generic.Queue[string]'
    $pending.Enqueue($base)
    while ($pending.Count -gt 0) {
      $directory = $pending.Dequeue()
      No-Reparse $directory
      $pins[$directory] = [UpdateRecovery]::Pin($directory)
      foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
        if ($item -is [IO.DirectoryInfo]) { $pending.Enqueue($item.FullName) }
      }
    }
  }
  $known = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $expected) { $null = $known.Add($entry.path) }
  $current = @(Get-Inventory $root)
  if ($null -ne $postInstall) {
    if (-not (Test-Inventory $root $postInstall)) { throw 'post_install_changed' }
    for ($i = 0; $i -lt $current.Count; $i++) {
      if ($current[$i].identity -cne $postInstall[$i].identity) { throw 'post_install_identity' }
    }
  }
  $observed = @{}
  foreach ($entry in $current) { $observed[$entry.path] = $entry }
  $extra = @($current | Where-Object { -not $known.Contains($_.path) } | Sort-Object { $_.path.Length } -Descending)
  foreach ($entry in $extra | Where-Object { $_.type -eq 'file' }) {
    $target = Join-Path $root $entry.path
    No-Reparse $target
    [UpdateRecovery]::Remove($target,$entry.identity,$entry.sha256,$false)
  }
  foreach ($entry in $expected | Where-Object { $_.type -eq 'directory' } | Sort-Object { $_.path.Length }) {
    $target = Join-Path $root $entry.path
    if (-not (Test-Path -LiteralPath $target)) { $null = [IO.Directory]::CreateDirectory($target); $pins[$target] = [UpdateRecovery]::Pin($target) }
    No-Reparse $target
  }
  foreach ($entry in $expected | Where-Object { $_.type -eq 'file' }) {
    $target = Join-Path $root $entry.path
    if (Test-Path -LiteralPath $target) { No-Reparse $target }
    $prior = $observed[$entry.path]
    if ($null -ne $prior -and $prior.type -ne 'file') { throw 'destination_type' }
    [UpdateRecovery]::Restore((Join-Path $backup $entry.path),$target,$entry.sha256,$prior.identity,$prior.sha256)
  }
  foreach ($entry in $extra | Where-Object { $_.type -eq 'directory' }) {
    $target = Join-Path $root $entry.path
    No-Reparse $target
    $pins[$target].Dispose()
    $pins.Remove($target)
    [UpdateRecovery]::Remove($target,$entry.identity,$null,$true)
  }
  } finally { foreach ($pin in $pins.Values) { $pin.Dispose() } }
}
try {
  No-Reparse $Request
  $lockPath = Join-Path (Split-Path -Parent $runDir) 'install.lock'
  if (Test-Path -LiteralPath $lockPath) { No-Reparse $lockPath }
  $installLock = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $config = Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($config.version -notmatch '^\d+\.\d+\.\d+$' -or $config.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'manifest' }
  $installDir = [IO.Path]::GetFullPath($config.installDir).TrimEnd('\')
  $installer = [IO.Path]::GetFullPath($config.installer)
  $exe = Join-Path $installDir 'Pi GUI.exe'
  $userData = [IO.Path]::GetFullPath($config.userData)
  if ($userData.Contains('"') -or $userData.TrimEnd('\') -ieq $installDir -or $userData.StartsWith($installDir + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'user_data_path' }
  if ([IO.Path]::GetFileName($installer) -cne "Pi-GUI-Setup-$($config.version).exe") { throw 'installer_name' }
  if (-not $installer.StartsWith((Split-Path -Parent $runDir) + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'installer_path' }
  if ($runDir.StartsWith($installDir + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'helper_location' }
  No-Reparse $installDir
  Initialize-Recovery
  $rootPin = [UpdateRecovery]::Pin($installDir)
  No-Reparse $exe
  $previousHash = File-Hash $exe
  No-Reparse $installer
  if ((Get-Item -LiteralPath $installer).Length -ne $config.size) { throw 'size' }
  # Keep an OS handle: PID reuse can never make us wait for the wrong instance.
  $parent = [Diagnostics.Process]::GetProcessById($config.parentPid)
  if ($parent.StartTime.ToUniversalTime().Ticks.ToString() -ne $config.parentStart) { throw 'parent_identity' }
  $null = $parent.Handle
  # Deny writes/deletion until NSIS finishes using the verified package.
  $package = [IO.File]::Open($installer,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $sha = [Security.Cryptography.SHA256]::Create()
  $actual = ([BitConverter]::ToString($sha.ComputeHash($package))).Replace('-','').ToLowerInvariant()
  if ($actual -cne $config.sha256) { throw 'checksum' }
  [IO.File]::WriteAllText((Join-Path $runDir 'ready'),'ready')
  $exitDeadline = [DateTime]::UtcNow.AddSeconds(120)
  while (-not $parent.WaitForExit(200)) {
    if (Test-Path -LiteralPath (Join-Path $runDir 'cancelled')) { Save-Result 'cancelled'; exit 1 }
    if ([DateTime]::UtcNow -ge $exitDeadline) { throw 'exit_timeout' }
  }
  $parentExited = $true
  $parent.Dispose()
  if (-not (Test-Path -LiteralPath (Join-Path $runDir 'armed'))) { throw 'not_armed' }
  if (Test-Path -LiteralPath (Join-Path $runDir 'cancelled')) { Save-Result 'cancelled'; exit 1 }
  # A signalled main-process handle alone does not prove Chromium/backend image
  # mappings are gone. Prove the executable can be exclusively opened for write
  # before touching program files; never force-kill a lingering process.
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $unlocked = $false
  while (-not $unlocked -and [DateTime]::UtcNow -lt $deadline) {
    try {
      $probe = [IO.File]::Open($exe,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      $probe.Dispose()
      $unlocked = $true
    } catch { Start-Sleep -Milliseconds 150 }
  }
  if (-not $unlocked) { throw 'exit_unconfirmed' }
  No-Reparse $installDir
  # Back up program files only. No AppData or project directory is ever touched.
  if (Get-ChildItem -LiteralPath $installDir -Recurse -Force | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}) { throw 'reparse' }
  $inventory = @(Get-Inventory $installDir)
  [ordered]@{ version = 1; files = $inventory } |
    ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $manifest -Encoding UTF8
  Copy-Item -LiteralPath $installDir -Destination $backup -Recurse -Force
  if (-not (Test-Inventory $backup $inventory)) { throw 'backup_inventory' }
  $changed = $true
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $installer
  $psi.Arguments = '/S /D=' + $installDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $setup = [Diagnostics.Process]::Start($psi)
  # Do not kill a timed-out installer: it may still own the destination.
  if (-not $setup.WaitForExit(600000)) {
    Save-Result 'installer_timeout'
    # Retain the install mutex while NSIS might still be writing. Another
    # helper must not race a timed-out installer; only the user may stop it.
    $setup.WaitForExit()
    exit 2
  }
  $postInstall = @(Get-Inventory $installDir)
  if ($setup.ExitCode -ne 0) { throw 'installer_failed' }
  $installed = Get-Content -LiteralPath (Join-Path $installDir 'resources\app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($installed.version -cne $config.version) { throw 'version_mismatch' }
  $success = $true
  Save-Result 'installed'
} catch {
  if ($changed) {
    try {
      No-Reparse $installDir
      # Remove only items proven absent from the successful pre-install backup,
      # then restore the complete old program inventory in place.
      if ($null -eq $postInstall) { throw 'post_install_unconfirmed' }
      Restore-Inventory $installDir $inventory $postInstall
      if (-not (Test-Inventory $installDir $inventory)) { throw 'restore_inventory' }
      Save-Result 'rolled_back'
    } catch { Save-Result 'recovery_required'; exit 3 }
  } else {
    Save-Result 'failed'
    if (-not $parentExited) { exit 1 }
    # A backup failure after exit must still reopen the unchanged application.
    # Refuse relaunch if its identity/path has changed in the meantime.
    try {
      No-Reparse $exe
      if ((File-Hash $exe) -cne $previousHash) { throw 'old_identity' }
    } catch { Save-Result 'recovery_required'; exit 3 }
  }
} finally {
  if ($package) { $package.Dispose() }
  if ($sha) { $sha.Dispose() }
  if ($installLock) { $installLock.Dispose() }
  if ($rootPin) { $rootPin.Dispose() }
}
try {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $exe
  $start.Arguments = '--user-data-dir="' + $userData + '"'
  $start.UseShellExecute = $false
  $start.WorkingDirectory = $installDir
  # Inherit user data overrides for the same installation; remove Node injection.
  $start.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  $start.EnvironmentVariables.Remove('NODE_OPTIONS')
  $restarted = [Diagnostics.Process]::Start($start)
  $restartPid = $restarted.Id
  Save-Result $resultPhase
} catch { Save-Result 'restart_failed'; exit 4 }
exit 0
