$ErrorActionPreference='Stop'
Set-Location -LiteralPath 'C:/pi-GUI-ui4-integration'
$taskEvidence='docs/claude-ui-redesign/ui4-integration-evidence/'
$taskBaseline=Get-Content -Raw -LiteralPath ($taskEvidence+'baseline-process.json') | ConvertFrom-Json
if ($taskBaseline.exitCode -ne 0) { throw 'baseline did not pass' }
if ((git rev-parse HEAD) -ne '17f855f01fedb7b13a13496ba45ebf8d28e465ac') { throw 'unexpected integration HEAD' }
git diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'tracked integration changes before merge' }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw 'staged integration changes before merge' }
$taskPreflight=Get-Content -Raw -LiteralPath ($taskEvidence+'preflight.json') | ConvertFrom-Json
$taskInputs=@(
  @{name='pane';branch='codex/ui4-pane'},
  @{name='approval';branch='codex/ui4-approval'},
  @{name='feedback';branch='codex/ui4-feedback'}
)
foreach ($inputRecord in $taskInputs) {
  $expected=$taskPreflight.inputs | Where-Object name -eq $inputRecord.name
  if ((git -C $expected.cwd status --porcelain --untracked-files=all)) { throw ('input changed: '+$inputRecord.name) }
  if ((git -C $expected.cwd rev-parse HEAD) -ne $expected.head) { throw ('input HEAD changed: '+$inputRecord.name) }
  if ((git rev-parse $inputRecord.branch) -ne $expected.head) { throw ('input branch moved: '+$inputRecord.name) }
}
$taskMerges=@()
foreach ($inputRecord in $taskInputs) {
  $taskMessage=git rev-parse --git-path COMMIT_MSG_TMP.txt
  [IO.File]::WriteAllText($taskMessage,('集成 UI-4 '+$inputRecord.name+' 分支，保留独立交付历史'),[Text.UTF8Encoding]::new($false))
  git merge --no-ff $inputRecord.branch -F $taskMessage
  if ($LASTEXITCODE -ne 0) { throw ('merge requires manual review: '+$inputRecord.branch) }
  $taskMerges+=@{branch=$inputRecord.branch;head=(git rev-parse HEAD);parents=(git show -s --format=%P HEAD)}
}
$taskMerges | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 -LiteralPath ($taskEvidence+'merges.json')
