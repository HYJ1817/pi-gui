# 本次 TEMP 探针原文

仅为本次证据留档；路径绑定本轮 TEMP 目录。正式复现先替换输出目录和仓库路径，保持临时数据隔离。

```
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const root='C:\\pi-GUI',out=__dirname;
const files=execFileSync('git',['ls-files','-co','--exclude-standard','public','electron','server','lib','scripts','tests','package.json','package-lock.json','.github'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean).sort();
const snapshot=()=>files.map(file=>({file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}));
(async()=>{const {createTestGroupPlan,validateTestGroupPlan}=await import('file:///C:/pi-GUI/scripts/test-group-plan.mjs');const plan=createTestGroupPlan({root,packageJson:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))});validateTestGroupPlan(plan);const before=snapshot(),started=new Date().toISOString();fs.writeFileSync(path.join(out,'frozen-source.json'),JSON.stringify(before,null,2));fs.writeFileSync(path.join(out,'canonical-plan.json'),JSON.stringify({leaves:plan.leaves,groups:[...plan.byGroup]},null,2));const log=fs.createWriteStream(path.join(out,'canonical.log'));console.log('Starting one npm test, commands='+plan.leaves.length);const child=spawn('cmd.exe',['/d','/s','/c','npm test'],{cwd:root,env:{...process.env,TEST_PORT:'17881',GUARD_PORT:'17882',SEC_PORT:'17883',GIT_PORT:'17884',PSExecutionPolicyPreference:'Bypass'},windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});child.once('error',error=>{throw error});child.once('exit',code=>{const ended=new Date().toISOString(),after=snapshot();const report={command:'npm test',started,ended,elapsedMs:Date.parse(ended)-Date.parse(started),exitCode:code,commands:plan.leaves.length,sourceUnchanged:JSON.stringify(before)===JSON.stringify(after),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),log:'canonical.log',ports:{TEST_PORT:17881,GUARD_PORT:17882,SEC_PORT:17883,GIT_PORT:17884}};log.end(()=>{fs.writeFileSync(path.join(out,'canonical-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exitCode=code??1});});})();

```
