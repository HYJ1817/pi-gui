// Opt-in actual Electron/Native fixture acceptance; not a daily environment test.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const builder=require('./fixtures/session-revert-object-d5-build.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function launch(file,args,config){return new Promise((resolve,reject)=>{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(file,args,{env,windowsHide:true,stdio:['pipe','pipe','pipe','ipc']});let text='',allOutput='',error='',result=null;const timer=setTimeout(()=>{child.kill();reject(Error('D5_Electron_timeout'));},1200000);
 child.on('message',row=>{if(row.phase==='challenge')child.send({version:1,command:'run',nonce:row.nonce});});
 child.stdin.on('error',()=>{});child.stderr.on('data',b=>{error+=b.toString();});child.stdout.on('data',b=>{allOutput+=b.toString();text+=b.toString();while(text.includes('\n')){const at=text.indexOf('\n'),line=text.slice(0,at);text=text.slice(at+1);try{const row=JSON.parse(line);if(row.phase==='challenge')child.stdin.write(JSON.stringify({version:1,command:'run',nonce:row.nonce})+'\n');else if(['result','failure'].includes(row.phase))result=row;}catch{}}});
 child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',async code=>{clearTimeout(timer);await fs.writeFile(path.join(config.output,config.layer+'-'+Math.round(config.scale*100)+'-private-error.log'),error);await fs.writeFile(path.join(config.launchRoot,'private-output-'+config.scale+'.log'),allOutput);if(code!==0||result?.phase!=='result')return reject(Error('D5_Electron_failed:'+JSON.stringify(result)));resolve(result);});
});}
(async()=>{
 if(process.platform!=='win32'){console.log('D5 Electron: 0/0; skipped=1 Windows Native only');return;}
 const resourceRoot=process.argv[2]?path.resolve(process.argv[2]):null,layer=resourceRoot?'packaged':'source',x=await builder.build({resourceRoot}),output=path.join(builder.ROOT,'.shots/p33-d5');
 await fs.mkdir(output,{recursive:true});let host=require('electron'),packaged=false;
 if(resourceRoot){
  const formalApp=path.resolve(resourceRoot,'../..'),testApp=path.join(x.root,'D5-test-only-app');
  await fs.cp(formalApp,testApp,{recursive:true,filter:from=>{const rel=path.relative(formalApp,from).replaceAll('\\','/');return rel!=='resources/app'&&!rel.startsWith('resources/app/');}});
  host=path.join(testApp,'D5 Test Only.exe');await fs.rename(path.join(testApp,'Pi GUI.exe'),host);assert.equal(hash(await fs.readFile(host)),hash(await fs.readFile(path.join(formalApp,'Pi GUI.exe'))));
  const testResources=path.join(testApp,'resources/app');await fs.mkdir(testResources,{recursive:true});await fs.copyFile(x.entry,path.join(testResources,'main.cjs'));await fs.writeFile(path.join(testResources,'package.json'),JSON.stringify({name:'p33-d5-private-test-only',version:'0.0.0',main:'main.cjs'}));packaged=true;
 }
 if(resourceRoot){const bundled=await fs.readFile(path.join(resourceRoot,'server.cjs'),'utf8');assert.equal(bundled.includes('createObjectServiceCore'),false);assert.equal(bundled.includes('createIsolatedWriter'),false);assert.equal(bundled.includes('p33-d5-private-object'),false);}
 let passed=0;const results=[];
 for(const scale of [1.25,1.5]){const config={launchRoot:x.root,resourceRoot:x.resourceRoot,preload:x.preload,rpcLauncher:x.rpc,scale,layer,output};const file=path.join(x.root,'config-'+scale+'.json');await fs.writeFile(file,JSON.stringify(config));const r=await launch(host,[...(packaged?[]:[x.entry]),file,'--no-sandbox','--force-device-scale-factor='+scale],config);passed+=r.checks;results.push(r);console.log(`D5 ${layer} Electron scale ${scale}: ${r.checks}/${r.checks}; failed=0; skipped=0`);}
 const privateSourceHashes={};for(const name of ['session-revert-object-electron.cjs',...['build.cjs','issuer.mjs','launcher.mjs','preload.cjs','rpc.mjs'].map(n=>'fixtures/session-revert-object-d5-'+n)])privateSourceHashes[name]=hash(await fs.readFile(path.join(__dirname,name)));
 const report={layer,passed,failed:0,skipped:0,launcherRoot:x.root,launcherDigest:hash(await fs.readFile(x.entry)),hostDigest:hash(await fs.readFile(host)),privateSourceHashes,results};await fs.writeFile(path.join(output,layer+'-summary.json'),JSON.stringify(report,null,2));console.log(`D5 Electron ${layer}: ${passed}/${passed}; failed=0; skipped=0`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
