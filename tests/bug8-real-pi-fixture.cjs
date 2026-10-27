// Installed Pi + deterministic loopback model fixture. No external model or credentials.
const fs=require('node:fs'),path=require('node:path');
const target=path.join(__dirname,'bug8-acceptance-live.cjs');let source=fs.readFileSync(target,'utf8');
const start=source.indexOf('  const sdk ='),end=source.indexOf("  const { createHash }",start);
if(start<0||end<start)throw Error('harness_setup_boundary_missing');
const fixture=String.raw`
  const http=require('node:http');let modelCalls=0;
  const modelServer=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);modelCalls++;
    const messages=body.messages||[],user=messages.findLast(x=>x.role==='user');
    const text=typeof user?.content==='string'?user.content:JSON.stringify(user?.content);
    const last=messages.at(-1);let delta,finish;
    if(last?.role==='tool'){delta={content:'Done.'};finish='stop';}
    else {const tag=text.match(/node writer\.cjs ([ABE])/);const name=tag?'bash':'write';
      const args=tag?{command:'node writer.cjs '+tag[1],timeout:180}:{path:'hello-C.txt',content:'hello world\n'};
      delta={tool_calls:[{index:0,id:'fixture-call-'+modelCalls,type:'function',function:{name,arguments:JSON.stringify(args)}}]};finish='tool_calls';}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const chunk=(d,f=null)=>'data: '+JSON.stringify({id:'fixture-'+modelCalls,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:d,finish_reason:f}]})+'\n\n';
    res.write(chunk({role:'assistant'}));res.write(chunk(delta));res.write(chunk({},finish));res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  const provider='bug8-fixture',modelId='fixture';report.provider=provider;report.model=modelId;report.modelKind='deterministic loopback fixture; installed real Pi/tools/guardian';
  const baseUrl='http://127.0.0.1:'+modelServer.address().port+'/v1';
  fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{[provider]:{baseUrl,api:'openai-completions',apiKey:'fixture-unused',models:[{id:modelId,name:'Bug8 fixture',api:'openai-completions',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096,compat:{supportsDeveloperRole:false,supportsStore:false}}]}}}));
  fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({defaultProvider:provider,defaultModel:modelId,retry:{enabled:false,maxRetries:0}}));
  const env={...process.env,PI_CODING_AGENT_DIR:agentDir,PI_PROVIDER:provider,PI_MODEL:modelId,PI_THINKING:'off'};
`;
source=source.slice(0,start)+fixture+source.slice(end);
source=source.replace("if(process.env.PI_GUI_BUG8_LIVE !== '1')","if(process.env.PI_GUI_BUG8_FIXTURE !== '1')");
source=source.replace("report.endedAt=new Date().toISOString();save();}","report.modelCalls=modelCalls;await new Promise(resolve=>modelServer.close(resolve));report.endedAt=new Date().toISOString();save();}");
module._compile(source,target);
