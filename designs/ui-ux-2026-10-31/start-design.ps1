param([int]$Port = 8120, [switch]$Editors)
$ErrorActionPreference = 'Stop'
$designRoot = $PSScriptRoot
$nodePath = (Get-Command node).Source
$previewUrl = 'http://127.0.0.1:' + $Port
$isOurs = $false
try {
  $response = Invoke-WebRequest -Uri ($previewUrl + '/index.html') -TimeoutSec 2 -UseBasicParsing
  $isOurs = $response.Content.Contains('pi-gui-design-review-20261031')
} catch {}
if (-not $isOurs) {
  # WMI creates the helper independently of the calling agent's process tree.
  # This is a hidden, user-owned process, not a service or a scheduled task.
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $commandLine = '"' + $nodePath + '" "' + (Join-Path $designRoot 'tools/serve.cjs') + '" ' + $Port
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; ProcessStartupInformation = $startup }
  if ($created.ReturnValue -ne 0) { throw ('无法启动独立预览进程，Windows返回码：' + $created.ReturnValue) }
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri ($previewUrl + '/index.html') -TimeoutSec 1 -UseBasicParsing
      if ($response.Content.Contains('pi-gui-design-review-20261031')) { $isOurs = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 150
  }
  if (-not $isOurs) { throw '预览未就绪或该端口已被占用；请使用 -Port 指定另一个端口。' }
}
Write-Output ('设计验收入口：' + $previewUrl + '/index.html')
if ($Editors) {
  $archive = Join-Path $designRoot 'tooling/baoyu-design-4923c3e.zip'
  $expected = '662F4E7B67E3D03B9F281FCAE90EACACF276A8B57D8481E787602239CB182579'
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw '离线设计工具包摘要不符。' }
  $runtimeRoot = Join-Path ([IO.Path]::GetTempPath()) 'pi-gui-design-runtime-4923c3e'
  if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'claude-design/scripts/artifact.mjs'))) {
    Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot
  }
  & $nodePath (Join-Path $runtimeRoot 'claude-design/scripts/artifact.mjs') check (Join-Path $designRoot 'canvas')
  if ($LASTEXITCODE -ne 0) { throw '画布格式校验失败。' }
  & $nodePath (Join-Path $runtimeRoot 'claude-design/scripts/artifact.mjs') open (Join-Path $designRoot 'canvas')
  & $nodePath (Join-Path $runtimeRoot 'claude-design-system/scripts/artifact.mjs') check (Join-Path $designRoot 'system')
  if ($LASTEXITCODE -ne 0) { throw '设计系统格式校验失败。' }
  & $nodePath (Join-Path $runtimeRoot 'claude-design-system/scripts/artifact.mjs') open (Join-Path $designRoot 'system')
}
