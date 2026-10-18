param([Parameter(Mandatory=$true)][string]$Repository,[Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $Repository
$env:TEMP = $FixtureRoot
$env:TMP = $FixtureRoot
$env:TMPDIR = $FixtureRoot
$taskWatch = [Diagnostics.Stopwatch]::StartNew()
$taskStarted = [DateTime]::UtcNow.ToString('o')
$taskCode = 1
try {
    & npm.cmd test *> 'docs/claude-ui-redesign/ui3-integration-evidence/npm-test-final.log'
    $taskCode = $LASTEXITCODE
} catch {
    $_ | Out-String | Add-Content -LiteralPath 'docs/claude-ui-redesign/ui3-integration-evidence/npm-test-final.log'
} finally {
    $taskWatch.Stop()
    [ordered]@{command='npm test';exitCode=$taskCode;durationSeconds=$taskWatch.Elapsed.TotalSeconds;startedUtc=$taskStarted;finishedUtc=[DateTime]::UtcNow.ToString('o');fixtureRoot=$FixtureRoot;scope='frozen final product sources; persistent local test runner'} |
        ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath 'docs/claude-ui-redesign/ui3-integration-evidence/npm-test-final-process.json'
}
exit $taskCode
