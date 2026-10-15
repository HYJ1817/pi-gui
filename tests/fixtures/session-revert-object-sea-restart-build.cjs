// Separate test-only SEA. No product entry or package includes this launcher.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {bundle,command,ROOT}=require('./session-revert-object-packed-build.cjs');
async function build(){
 const testDir=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D6 SEA restart 中文 ')),entry=path.join(testDir,'launcher.cjs');
 await bundle(entry,undefined,path.join(__dirname,'session-revert-object-sea-restart-launcher.mjs'));
 const assets={'revert-object/observe.ps1':path.join(ROOT,'server/session-revert-object-native.ps1'),'revert-object/write.ps1':path.join(ROOT,'server/session-revert-object-write-native.ps1'),'revert-compute/algorithm.mjs':path.join(ROOT,'lib/session-revert.js'),'revert-compute/worker.mjs':path.join(ROOT,'server/session-revert-worker.mjs')};
 const manifest=path.join(testDir,'asset-manifest.json');await fs.writeFile(manifest,JSON.stringify(Object.keys(assets)));assets['asset-manifest.json']=manifest;
 const blob=path.join(testDir,'blob'),config=path.join(testDir,'sea-config.json');await fs.writeFile(config,JSON.stringify({main:entry,output:blob,assets,disableExperimentalSEAWarning:true}));
 await command(process.execPath,['--experimental-sea-config',config]);const testExe=path.join(testDir,'D6 Restart Test Only.exe');await fs.copyFile(process.execPath,testExe);
 await command(process.execPath,[path.join(ROOT,'node_modules/postject/dist/cli.js'),testExe,'NODE_SEA_BLOB',blob,'--sentinel-fuse','NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);
 const hash=b=>createHash('sha256').update(b).digest('hex');
 return {testDir,testExe,config,launcherDigest:hash(await fs.readFile(entry)),exeDigest:hash(await fs.readFile(testExe))};
}
async function processIdentity(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)throw Error('invalid_pid');
 const {stdout}=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop';$p=Get-Process | Where-Object Id -eq ${pid};if($p){[Console]::Write($p.StartTime.ToUniversalTime().Ticks)};exit 0`]);
 const creation=stdout.trim();return creation?{creation}:null;
}
module.exports={ROOT,build,processIdentity};
