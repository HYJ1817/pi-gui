param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
$runDir = Split-Path -Parent $Request
$resultFile = Join-Path $runDir 'result.json'
$backup = Join-Path $runDir 'backup'
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
try {
  No-Reparse $Request
  $lockPath = Join-Path (Split-Path -Parent $runDir) 'install.lock'
  if (Test-Path -LiteralPath $lockPath) { No-Reparse $lockPath }
  $installLock = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $config = Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json
  if ($config.version -notmatch '^\d+\.\d+\.\d+$' -or $config.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'manifest' }
  $installDir = [IO.Path]::GetFullPath($config.installDir).TrimEnd('\')
  $installer = [IO.Path]::GetFullPath($config.installer)
  $exe = Join-Path $installDir 'Pi GUI.exe'
  $userData = [IO.Path]::GetFullPath($config.userData)
  if ($userData.Contains('"') -or $userData.StartsWith($installDir + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'user_data_path' }
  if ([IO.Path]::GetFileName($installer) -cne "Pi-GUI-Setup-$($config.version).exe") { throw 'installer_name' }
  if (-not $installer.StartsWith((Split-Path -Parent $runDir) + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'installer_path' }
  if ($runDir.StartsWith($installDir + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'helper_location' }
  No-Reparse $installDir
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
  if (-not $parent.WaitForExit(120000)) { throw 'exit_timeout' }
  $parentExited = $true
  $parent.Dispose()
  if (-not (Test-Path -LiteralPath (Join-Path $runDir 'armed'))) { throw 'not_armed' }
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
  Copy-Item -LiteralPath $installDir -Destination $backup -Recurse
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
  if ($setup.ExitCode -ne 0) { throw 'installer_failed' }
  $installed = Get-Content -LiteralPath (Join-Path $installDir 'resources\app\package.json') -Raw | ConvertFrom-Json
  if ($installed.version -cne $config.version) { throw 'version_mismatch' }
  $success = $true
  Save-Result 'installed'
} catch {
  if ($changed) {
    try {
      No-Reparse $installDir
      # Restore in place, preserving pre-existing program files and user data.
      Copy-Item -Path (Join-Path $backup '*') -Destination $installDir -Recurse -Force
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
