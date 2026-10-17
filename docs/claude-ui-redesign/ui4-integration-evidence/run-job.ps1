param([Parameter(Mandatory=$true)][string]$Name)
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
Set-Location -LiteralPath 'C:/pi-GUI-ui4-integration'
$taskEvidence='docs/claude-ui-redesign/ui4-integration-evidence/'
$taskJobs=Get-Content -Raw -LiteralPath ($taskEvidence+'jobs.json') | ConvertFrom-Json
$taskJob=$taskJobs.$Name
if (!$taskJob) { throw 'unknown evidence job' }
if ($Name -notmatch '^[a-z0-9-]+$') { throw 'invalid job name' }
$taskRoot=Join-Path ([IO.Path]::GetTempPath()) ('pi-gui-ui4-'+$Name+'-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$env:TEMP=$taskRoot;$env:TMP=$taskRoot;$env:TMPDIR=$taskRoot
if ($taskJob.env) { foreach ($p in $taskJob.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name,[string]$p.Value,'Process') } }
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Text.UTF8Encoding]::new($false)
$taskWatch=[Diagnostics.Stopwatch]::StartNew();$taskStarted=[DateTime]::UtcNow.ToString('o');$taskCode=1
try { $taskArgs=@($taskJob.args); & $taskJob.command @taskArgs *> ($taskEvidence+$Name+'.log');$taskCode=$LASTEXITCODE }
catch { $_ | Out-String | Add-Content -LiteralPath ($taskEvidence+$Name+'.log') }
finally { $taskWatch.Stop();[ordered]@{command=$taskJob.command;args=$taskJob.args;exitCode=$taskCode;seconds=$taskWatch.Elapsed.TotalSeconds;startedUtc=$taskStarted;finishedUtc=[DateTime]::UtcNow.ToString('o');fixtureRoot=$taskRoot} | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 -LiteralPath ($taskEvidence+$Name+'-process.json') }
exit $taskCode
