// Build-only helper. Never imported by server.js or the ordinary build entries.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile),ROOT=path.resolve(__dirname,'../..');
async function command(file,args,options={}){
 return exec(file,args,{cwd:ROOT,maxBuffer:4*1024*1024,windowsHide:true,...options});
}
async function bundle(outfile,assetEntry,entry=path.join(ROOT,'tests/fixtures/session-revert-object-packed-launcher.mjs')){
 const trusted=path.resolve(ROOT,'tests/fixtures');
 entry=path.resolve(entry);assert.equal(path.dirname(entry),trusted);assert.match(path.basename(entry),/^session-revert-object-[a-z0-9-]+\.mjs$/);
 const esbuild=await import('esbuild');
 const privateExports=new Map([
  ['session-revert-object-writer.js','createIsolatedWriter'],
  ['session-revert-object-service.js','createObjectServiceCore, readObservedOriginal'],
 ]);
 return esbuild.build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',target:'node22',outfile,
  define:{'import.meta.url':'__SEA_URL__'},banner:{js:'var __SEA_URL__=require("url").pathToFileURL('+(assetEntry?JSON.stringify(assetEntry):'__filename')+').href;'},logLevel:'silent',
  plugins:[{name:'TEMP-only-private-exports',setup(b){b.onLoad({filter:/session-revert-object-(?:writer|service)\.js$/},async a=>{
   assert.equal(path.dirname(a.path),path.join(ROOT,'server'));
   return {contents:await fs.readFile(a.path,'utf8')+'\nexport { '+privateExports.get(path.basename(a.path))+' };',loader:'js'};
  });}}]});
}
async function build({electronZipDir}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D4 packaged 中文 '));
 const flags=['--output-root',root];
 await command(process.execPath,['scripts/build-app.mjs','--rebuild',...flags],{env:{...process.env,PI_GUI_ELECTRON_ZIP_DIR:electronZipDir}});
 const buildDir=path.join(root,'build');
 const seaConfig=JSON.parse(await fs.readFile(path.join(buildDir,'sea-config.json'),'utf8'));
 const testDir=path.join(root,'test-sea');await fs.mkdir(testDir);
 const testEntry=path.join(testDir,'launcher.cjs');await bundle(testEntry);
 const testConfig=path.join(testDir,'sea-config.json');
 await fs.writeFile(testConfig,JSON.stringify({...seaConfig,main:testEntry,output:path.join(testDir,'sea-prep.blob')}));
 await command(process.execPath,['--experimental-sea-config',testConfig]);
 const testExe=path.join(testDir,'D4 Test Only.exe');await fs.copyFile(process.execPath,testExe);
 await command(process.execPath,[path.join(ROOT,'node_modules/postject/dist/cli.js'),testExe,'NODE_SEA_BLOB',path.join(testDir,'sea-prep.blob'),'--sentinel-fuse','NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);
 let appDir=null,appExe=null,backendLauncher=null;
 if(electronZipDir){
  appDir=path.join(root,'dist-app/Pi GUI-win32-x64');appExe=path.join(appDir,'Pi GUI.exe');
  // Separate test entry; the trusted build-time URL binds original assets.js
  // to the formal application's actual resource layout. No test file enters it.
  const backendTestDir=path.join(root,'test-backend');await fs.mkdir(backendTestDir);
  backendLauncher=path.join(backendTestDir,'D4-test-only.cjs');await bundle(backendLauncher,path.join(appDir,'resources/app/server.cjs'));
 }
 return {root,buildDir,productionExe:path.join(buildDir,'Pi GUI.exe'),testExe,appDir,appExe,backendLauncher,seaConfig};
}
module.exports={build,bundle,command,ROOT};
