// Production PowerShell recovery functions, real TEMP filesystem/Win32 handles.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const helper=fs.readFileSync(path.join(__dirname,'../electron/update-helper.ps1'),'utf8');
const prefix=helper.slice(0,helper.indexOf('\ntry {\n  No-Reparse $Request'));
function fixture(t,body){
  if(process.platform!=='win32'){t.skip('Windows recovery handles');return;}
  const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-update-rollback-'));
  const script=path.join(world,'probe.ps1');
  fs.writeFileSync(script,prefix+`\nInitialize-Recovery\n$installDir=Join-Path $runDir 'installed'\n$backup=Join-Path $runDir 'backup'\n$null=New-Item -ItemType Directory -Path $installDir\n[IO.File]::WriteAllText((Join-Path $installDir 'old.txt'),'original')\n$inventory=@(Get-Inventory $installDir)\nCopy-Item -LiteralPath $installDir -Destination $backup -Recurse\n`+body);
  return execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-File',script,'-Request',path.join(world,'request.json')],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
}
test('rollback removes nested additions and restores complete pre-existing file set',t=>{
  const result=fixture(t,`$null=New-Item -ItemType Directory -Path (Join-Path $installDir 'new\\nested')\n[IO.File]::WriteAllText((Join-Path $installDir 'new\\nested\\added.dll'),'new')\n[IO.File]::WriteAllText((Join-Path $installDir 'old.txt'),'changed')\nRestore-Inventory $installDir $inventory\nif(-not (Test-Inventory $installDir $inventory)){throw 'incomplete'}\n'complete'`);
  if(result!==undefined)assert.equal(result,'complete');
});
test('modified backup is rejected before destination changes',t=>{
  const result=fixture(t,`[IO.File]::WriteAllText((Join-Path $backup 'old.txt'),'corrupt')\n[IO.File]::WriteAllText((Join-Path $installDir 'added.txt'),'preserve on uncertain recovery')\ntry{Restore-Inventory $installDir $inventory;throw 'unexpected_success'}catch{if($_.Exception.Message -eq 'unexpected_success'){throw}}\nif(-not (Test-Path -LiteralPath (Join-Path $installDir 'added.txt'))){throw 'deleted'}\nif([IO.File]::ReadAllText((Join-Path $installDir 'old.txt')) -ne 'original'){throw 'modified'}\n'refused'`);
  if(result!==undefined)assert.equal(result,'refused');
});
test('recovery refuses junction traversal and preserves external user data',t=>{
  const result=fixture(t,`$outside=Join-Path $runDir 'user-data'\n$null=New-Item -ItemType Directory -Path $outside\n[IO.File]::WriteAllText((Join-Path $outside 'sentinel.txt'),'preserve')\n$null=New-Item -ItemType Junction -Path (Join-Path $installDir 'linked') -Target $outside\ntry{Restore-Inventory $installDir $inventory;throw 'unexpected_success'}catch{if($_.Exception.Message -eq 'unexpected_success'){throw}}\nif([IO.File]::ReadAllText((Join-Path $outside 'sentinel.txt')) -ne 'preserve'){throw 'external_data'}\n'refused'`);
  if(result!==undefined)assert.equal(result,'refused');
});
test('recovery refuses hardlinks instead of overwriting external data',t=>{
  const result=fixture(t,`$outside=Join-Path $runDir 'external.txt'\n[IO.File]::WriteAllText($outside,'preserve')\nRemove-Item -LiteralPath (Join-Path $installDir 'old.txt')\n$null=New-Item -ItemType HardLink -Path (Join-Path $installDir 'old.txt') -Target $outside\ntry{Restore-Inventory $installDir $inventory;throw 'unexpected_success'}catch{if($_.Exception.Message -eq 'unexpected_success'){throw}}\nif([IO.File]::ReadAllText($outside) -ne 'preserve'){throw 'external_data'}\n'refused'`);
  if(result!==undefined)assert.equal(result,'refused');
});
test('deletion binds file identity and digest and refuses a replacement object',t=>{
  const result=fixture(t,`$target=Join-Path $installDir 'added.txt'\n[IO.File]::WriteAllText($target,'first')\n$entry=@(Get-Inventory $installDir)|Where-Object {$_.path -eq 'added.txt'}\nMove-Item -LiteralPath $target -Destination (Join-Path $runDir 'original-object.txt')\n[IO.File]::WriteAllText($target,'second')\ntry{[UpdateRecovery]::Remove($target,$entry.identity,$entry.sha256,$false);throw 'unexpected_success'}catch{if($_.Exception.Message -eq 'unexpected_success'){throw}}\nif([IO.File]::ReadAllText($target) -ne 'second'){throw 'deleted_replacement'}\n'refused'`);
  if(result!==undefined)assert.equal(result,'refused');
});
test('files added after the installer observation are preserved and recovery refused',t=>{
  const result=fixture(t,`$postInstall=@(Get-Inventory $installDir)\n$target=Join-Path $installDir 'external-addition.txt'\n[IO.File]::WriteAllText($target,'preserve')\ntry{Restore-Inventory $installDir $inventory $postInstall;throw 'unexpected_success'}catch{if($_.Exception.Message -eq 'unexpected_success'){throw}}\nif([IO.File]::ReadAllText($target) -ne 'preserve'){throw 'deleted'}\n'refused'`);
  if(result!==undefined)assert.equal(result,'refused');
});
test('restore refuses a destination with a different identity before writing',t=>{
  const result=fixture(t,`$target=Join-Path $installDir 'old.txt'\n$entry=$inventory[0]\nMove-Item -LiteralPath $target -Destination (Join-Path $runDir 'saved-old.txt')\n[IO.File]::WriteAllText($target,'external replacement')\ntry{[UpdateRecovery]::Restore((Join-Path $backup 'old.txt'),$target,$entry.sha256,$entry.identity,$entry.sha256);throw 'unexpected_success'}catch{if($_.Exception.Message -eq 'unexpected_success'){throw}}\nif([IO.File]::ReadAllText($target) -ne 'external replacement'){throw 'overwritten'}\n'refused'`);
  if(result!==undefined)assert.equal(result,'refused');
});
