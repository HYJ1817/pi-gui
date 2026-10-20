// TEMP-only real Pi SDK/RPC with a synthetic model stream. No provider network.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const config=JSON.parse(fs.readFileSync(process.env.PI_ORDINARY_SDK_CONFIG,'utf8'));
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const label=arg('--fixture-label');if(!['A','B'].includes(label))throw Error('fixture_label');
process.env.PI_ORDINARY_FIXTURE_LABEL=label;
const pi=await import(pathToFileURL(path.join(config.packageDir,'dist/index.js')));
const settings=pi.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false}});
const extensionPaths=[config.toolFile];
for(let i=0;i<process.argv.length;i++)if(process.argv[i]==='--extension')extensionPaths.push(process.argv[++i]);
const loader=new pi.DefaultResourceLoader({cwd:process.cwd(),agentDir:config.agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,additionalExtensionPaths:extensionPaths});
await loader.reload();if(loader.getExtensions().errors.length)throw Error('fixture_extensions');
const model={id:'fixture',name:'Offline fixture',api:'openai-completions',provider:'openai',baseUrl:'http://127.0.0.1:1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:4096};
const modelRuntime=await pi.ModelRuntime.create({authPath:path.join(config.agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
await modelRuntime.setRuntimeApiKey('openai','fixture-not-a-real-credential');
const manager=pi.SessionManager.create(process.cwd(),config.sessionDir);
const result=await pi.createAgentSession({cwd:process.cwd(),agentDir:config.agentDir,model,modelRuntime,settingsManager:settings,resourceLoader:loader,sessionManager:manager,tools:['fixture_write']});
let previous=null,called=false;
result.session.agent.streamFunction=(_model,context)=>{
 const user=[...context.messages].reverse().find(m=>m.role==='user');const value=typeof user?.content==='string'?user.content:(user?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
 if(value!==previous){previous=value;called=false;fs.appendFileSync(path.join(config.workspace,'model-starts.txt'),label+'\n');}
 const tool=!called;called=true;
 const message={role:'assistant',content:tool?[{type:'toolCall',id:'shared-tool',name:'fixture_write',arguments:{path:'shared.txt',content:label+' result'}}]:[{type:'text',text:label+' completed'}],api:model.api,provider:model.provider,model:model.id,
  usage:{input:label==='A'?11:22,output:1,cacheRead:0,cacheWrite:0,totalTokens:label==='A'?12:23,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:tool?'toolUse':'stop',timestamp:Date.now()};
 return {async *[Symbol.asyncIterator](){yield {type:'done',reason:message.stopReason,message};},async result(){return message;}};
};
await pi.runRpcMode({session:result.session,setRebindSession(){},async dispose(){result.session.dispose();}});
