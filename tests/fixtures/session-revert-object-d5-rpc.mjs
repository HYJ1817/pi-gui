// Private fixture child: installed Pi's real JSONL RPC loop and default tools.
// This launcher is never imported into, or shipped with, the product.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const pi=await import(pathToFileURL(path.join(config.packageDir,'dist/index.js')));
Object.assign(process.env,config.captureEnvironment);
const settings=pi.SettingsManager.inMemory({});
const loader=new pi.DefaultResourceLoader({cwd:config.workspace,agentDir:config.agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,additionalExtensionPaths:[config.extensionFile]});
await loader.reload();
if(loader.getExtensions().errors.length)throw Error('fixture_extension_load_failed');
const model={id:'d5-fixture',name:'D5 fixture stream',api:'openai-completions',provider:'openai',baseUrl:'http://127.0.0.1:1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:4096};
const modelRuntime=await pi.ModelRuntime.create({authPath:path.join(config.agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
// Synthetic TEMP-only credential satisfies real RPC prompt preflight. The
// stream function below never calls a provider; this is not a model credential.
await modelRuntime.setRuntimeApiKey('openai','d5-fixture-not-a-real-credential');
const result=await pi.createAgentSession({cwd:config.workspace,agentDir:config.agentDir,model,modelRuntime,settingsManager:settings,resourceLoader:loader,sessionManager:pi.SessionManager.open(config.sessionFile),tools:['write','edit']});
let turn=0,call=0;
result.session.agent.streamFunction=()=>{
 const phase=turn++,tool=phase===0?{name:'write',arguments:{path:'file.txt',content:'agent-one\nanchor-one\nbody\nanchor-two\ntail\n'}}:phase===2?{name:'edit',arguments:{path:'file.txt',edits:[{oldText:'body',newText:'agent-two'}]}}:null;
 const message={role:'assistant',content:tool?[{type:'toolCall',id:'d5-tool-'+(++call),...tool}]:[{type:'text',text:'fixture complete'}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:tool?'toolUse':'stop',timestamp:Date.now()};
 return {async *[Symbol.asyncIterator](){yield {type:'done',reason:message.stopReason,message};},async result(){return message;}};
};
const host={session:result.session,setRebindSession(){},async dispose(){result.session.dispose();}};
await pi.runRpcMode(host);
