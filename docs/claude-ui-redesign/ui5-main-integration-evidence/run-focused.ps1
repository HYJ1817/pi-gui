$ErrorActionPreference = 'Continue'
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$out = $PSScriptRoot
$env:TEMP = Join-Path 'C:\WINDOWS\TEMP' ('pi-gui-ui5-focused-' + [guid]::NewGuid().ToString('N'))
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$env:UI3_EVIDENCE_ROOT = Join-Path $out 'ui3-electron'
$env:UI4_EVIDENCE_ROOT = Join-Path $out 'ui4-electron'
$env:UI4_CDP_EVIDENCE_ROOT = Join-Path $out 'ui4-cdp'
$env:UI5_EVIDENCE_ROOT = Join-Path $out 'ui5-logs-electron'
$env:UI5_VISUAL_OUT = Join-Path $out 'ui5-visual'
$env:UI_THEME_EVIDENCE = Join-Path $out 'theme-electron'
$env:P32_RUNTIME_EVIDENCE = Join-Path $out 'ui4-runtime-electron'

$tests = @(
  @{ id = 'logging'; exe = 'npm.cmd'; args = @('run', 'test:logging') },
  @{ id = 'ui3'; exe = 'npm.cmd'; args = @('run', 'test:ui3') },
  @{ id = 'ui3-visual'; exe = 'npm.cmd'; args = @('run', 'test:ui3:visual') },
  @{ id = 'ui4'; exe = 'npm.cmd'; args = @('run', 'test:ui4') },
  @{ id = 'ui4-desktop'; exe = 'npm.cmd'; args = @('run', 'test:ui4:desktop') },
  @{ id = 'ui4-cdp'; exe = 'npm.cmd'; args = @('run', 'test:ui4:cdp') },
  @{ id = 'approval'; exe = 'node'; args = @('tests/approvals.cjs') },
  @{ id = 'stop'; exe = 'npm.cmd'; args = @('run', 'test:stop') },
  @{ id = 'runtime'; exe = 'npm.cmd'; args = @('run', 'test:runtime') },
  @{ id = 'agent-browser'; exe = 'npm.cmd'; args = @('run', 'test:agent-browser') },
  @{ id = 'electron-guard'; exe = 'node'; args = @('tests/electron-guard.cjs') },
  @{ id = 'theme'; exe = 'npm.cmd'; args = @('run', 'test:theme') },
  @{ id = 'theme-electron'; exe = 'node'; args = @('tests/theme-electron.cjs') },
  @{ id = 'ui5-logs-electron'; exe = 'npm.cmd'; args = @('run', 'test:ui5:electron') },
  @{ id = 'ui5-visual'; exe = 'npm.cmd'; args = @('run', 'test:ui5:visual') }
)

$results = @()
$failed = @()
foreach ($test in $tests) {
  $log = Join-Path $out ($test.id + '.log')
  $exitFile = Join-Path $out ($test.id + '.exit')
  $processFile = Join-Path $out ($test.id + '.process.json')
  $started = Get-Date
  Push-Location $root
  try {
    $arguments = $test.args
    & $test.exe @arguments *> $log
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  [string]$code | Set-Content $exitFile
  $meta = @{
    id = $test.id
    command = (@($test.exe) + @($test.args)) -join ' '
    startedAt = $started.ToString('o')
    finishedAt = (Get-Date).ToString('o')
    durationSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 3)
    exitCode = $code
    temp = $env:TEMP
    head = (& git rev-parse HEAD)
  }
  $meta | ConvertTo-Json | Set-Content $processFile
  $results += $meta
  if ($code -ne 0) { $failed += $test.id }
  Write-Host (('{0}: exit {1}' -f $test.id, $code))
}

@{ temp = $env:TEMP; head = (& git rev-parse HEAD); tests = $results; failed = $failed } |
  ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'focused-summary.json')
if ($failed.Count) { exit 1 } else { exit 0 }
