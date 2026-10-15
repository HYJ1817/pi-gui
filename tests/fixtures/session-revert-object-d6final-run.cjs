// Standalone TEST ONLY entry. Never imported by product or build scripts.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const ROOT=path.resolve(__dirname,'../..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function build(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D6final-launch-')),entry=path.join(root,'test-only.cjs'),esbuild=await import('esbuild');
 await esbuild.build({entryPoints:[path.join(__dirname,'session-revert-object-d6final-main.mjs')],outfile:entry,bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],define:{'import.meta.url':'__D6_ASSET_URL__'},banner:{js:'var __D6_ASSET_URL__='+JSON.stringify(pathToFileURL(path.join(ROOT,'server/session-revert-compute.js')).href)+';'},logLevel:'silent',plugins:[{name:'TEMP-private-exports',setup(b){b.onLoad({filter:/session-revert-object-(?:writer|service)\.js$/},async a=>({contents:await fs.readFile(a.path,'utf8')+'\nexport { '+(a.path.endsWith('writer.js')?'createIsolatedWriter':'createObjectServiceCore')+' };',loader:'js'}));}}]});
 const preload=path.join(root,'preload.cjs'),rpcLauncher=path.join(root,'rpc.mjs');await fs.copyFile(path.join(__dirname,'session-revert-object-d5-preload.cjs'),preload);await fs.copyFile(path.join(__dirname,'session-revert-object-d6final-model-rpc.mjs'),rpcLauncher);return {root,entry,preload,rpcLauncher};
}
async function main(args){
 const managed=args.length===1&&args[0]==='--offline-managed-sdk-native',offline=managed||args.length===1&&args[0]==='--offline-sdk-native',real=args.includes('--real-model');
 if(!offline){assert.ok(real&&args.includes('--new-model-authorization=explicit')&&args.includes('--max-model-requests=4'),'REAL_MODEL_RETEST_PENDING: explicit new authorization and budget required');assert.equal(args.length,3);}
 assert.equal(process.platform,'win32');
 const {createPiLaunch}=await import(pathToFileURL(path.join(ROOT,'server/pi-launch.js')));const packageDir=createPiLaunch().packageDir();assert.ok(packageDir);assert.equal(JSON.parse(await fs.readFile(path.join(packageDir,'package.json'),'utf8')).version,'1.2.0');
 const sdk=await import(pathToFileURL(path.join(packageDir,'dist/index.js'))),credentials={async read(){return undefined;},async list(){return [];},async modify(_id,fn){return fn(undefined);},async delete(){}};
 const runtime=await sdk.ModelRuntime.create({credentials,modelsPath:null,refreshOnCreate:false,allowModelNetwork:false}),model=runtime.getModel('deepseek','deepseek-flash');assert.ok(model);
 // This future opt-in requires a caller-supplied credential. Never searches auth files.
 let apiKey=offline?'offline-fixture-not-a-credential':process.env.PI_GUI_D6FINAL_MODEL_KEY;assert.ok(apiKey,'explicit caller key required');
 const modelConfig={packageDir,defaultProvider:'deepseek',defaultModel:'deepseek-flash',model,apiKey,offlineFixture:offline};
 const mode=managed?'managed':'classic',x=await build(),output=path.join(ROOT,'.shots','p33-d6final-'+mode+'-'+Date.now());await fs.mkdir(output,{recursive:true});
 const config={launchRoot:x.root,resourceRoot:ROOT,...x,mode,layer:mode,scale:1.25,output,offlineFixture:offline};const configFile=path.join(x.root,'config.json');await fs.writeFile(configFile,JSON.stringify(config));
 let reserved=0,project=null,result=null,challenged=false;
 try{await new Promise((resolve,reject)=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.PI_GUI_D6FINAL_MODEL_KEY;
  const child=spawn(require('electron'),[x.entry,configFile,'--no-sandbox','--force-device-scale-factor=1.25'],{env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const timer=setTimeout(()=>{child.kill();reject(Error('bounded_GUI_timeout'));},600000);let buffer='';
  child.stderr.on('data',()=>{});
  child.on('message',row=>{if(row?.phase==='challenge'&&!challenged&&row.version===1&&/^[a-f0-9]{64}$/.test(row.nonce)){challenged=true;child.send({version:1,command:'run',nonce:row.nonce,modelConfig});}
   else if(row?.type==='d6-root-permit'){const allowed=!offline&&challenged&&typeof row.projectId==='string'&&(!project||project===row.projectId)&&row.projectRequest===reserved+1&&reserved<4;if(allowed){project=row.projectId;reserved++;}child.send({type:'d6-root-permit-result',requestId:row.requestId,allowed,totalReserved:reserved});}});
  child.stdout.on('data',bytes=>{buffer+=bytes;if(buffer.length>2*1024*1024){child.kill();return;}while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const row=JSON.parse(line);if(['failure','result'].includes(row.phase))result=row;}catch{}}});
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0||result?.phase!=='result')return reject(Object.assign(Error('classic_failed'),{result,code}));resolve();});
 });console.log(JSON.stringify({passed:result.checks,failed:0,skipped:0,modelRequests:reserved,offlineFixture:offline,actualSdk:true,actualNative:true,credentialsRead:!offline,realModel:offline?'REAL_MODEL_RETEST_PENDING':'REAL_MODEL_VERIFIED',output,launchRoot:x.root,launcherDigest:hash(await fs.readFile(x.entry))}));}
 finally{apiKey=null;modelConfig.apiKey=null;await fs.writeFile(path.join(x.root,'budget.json'),JSON.stringify({reserved,max:4,automaticRetry:false,offlineFixture:offline,result:result?.phase??null}));}
}
module.exports={main,build};
