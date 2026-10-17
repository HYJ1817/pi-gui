param([string]$Phase='baseline')
$ErrorActionPreference='Continue'
Set-Location -LiteralPath 'C:/pi-GUI-ui4-integration'
$taskRoot=Join-Path ([IO.Path]::GetTempPath()) ('pi-gui-ui4-'+$Phase+'-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$env:TEMP=$taskRoot;$env:TMP=$taskRoot;$env:TMPDIR=$taskRoot
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Text.UTF8Encoding]::new($false)
$taskWatch=[Diagnostics.Stopwatch]::StartNew();$taskStarted=[DateTime]::UtcNow.ToString('o');$taskCode=1
$taskEvidence='docs/claude-ui-redesign/ui4-integration-evidence/'
try { & npm.cmd test *> ($taskEvidence+$Phase+'.log');$taskCode=$LASTEXITCODE }
catch { $_ | Out-String | Add-Content -LiteralPath ($taskEvidence+$Phase+'.log') }
finally { $taskWatch.Stop();[ordered]@{command='npm test';phase=$Phase;exitCode=$taskCode;seconds=$taskWatch.Elapsed.TotalSeconds;startedUtc=$taskStarted;finishedUtc=[DateTime]::UtcNow.ToString('o');fixtureRoot=$taskRoot} | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath ($taskEvidence+$Phase+'-process.json') }
exit $taskCode
