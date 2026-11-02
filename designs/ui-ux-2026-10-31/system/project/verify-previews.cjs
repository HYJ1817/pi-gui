'use strict';
// Design-only Chromium verification. No Pi, provider, user files, dependencies or production edits.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const COMPONENTS=['Button','IconButton','Input','Textarea','ModelPicker','Menu','Dialog','Popover','Tabs','Sidebar','Tooltip','StatusIndicator','Progress','EmptyState','ErrorState','Toast','ChatMessage','ToolActivity','WorkPanel'];
if(!process.versions.electron){
 const {spawn}=require('node:child_process'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(require('electron'),[__filename],{cwd:path.resolve(__dirname,'../../../..'),env,stdio:'inherit',windowsHide:true});
 child.on('exit',code=>process.exitCode=code??1);
}else{
 const {app,BrowserWindow}=require('electron');
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-workbench-system-'));
 app.setPath('userData',path.join(world,'user-data'));
 app.whenReady().then(async()=>{
  const OUT=path.join(__dirname,process.env.DESIGN_VERIFY_OUT||'verification');fs.mkdirSync(OUT,{recursive:true});
  const checks=[],shots=[],errors=[];
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const server=http.createServer((req,res)=>{
   const u=new URL(req.url,'http://localhost'),m=u.pathname.match(/^\/preview\/(\w+)$/);
   let file,type='text/html;charset=utf-8';
   if(m&&(COMPONENTS.includes(m[1])||m[1]==='Cover')){
    file=path.join(__dirname,'components',m[1],'preview.html');
    let html=fs.readFileSync(file,'utf8');
    const theme=u.searchParams.get('theme')==='dark'?'dark':'light';
    html=html.replace('<html lang="zh-CN">','<html lang="zh-CN" data-theme="'+theme+'">').replace('<head>','<head><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components/bundle.css">');
    res.writeHead(200,{'content-type':type});res.end(html);return;
   }
   if(u.pathname==='/tokens.css'||u.pathname==='/components/bundle.css'){file=path.join(__dirname,u.pathname.slice(1));type='text/css;charset=utf-8';}
   if(!file){res.writeHead(404);res.end('Not found');return;}
   res.writeHead(200,{'content-type':type});res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const win=new BrowserWindow({show:false,width:1000,height:620,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
  win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const u=new URL(d.url);cb({cancel:u.hostname!=='127.0.0.1'&&!['data:','blob:','devtools:'].includes(u.protocol)});});
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=3&&!/Electron Security Warning/.test(message))errors.push(String(message));});
  const read=s=>win.webContents.executeJavaScript(s);
  const click=sel=>read('document.querySelector('+JSON.stringify(sel)+').click()');
  const check=(pass,label,data)=>{checks.push({pass:!!pass,label,...(data?{data}:{})});if(!pass)throw Error(label);};
  const shot=async(name)=>{win.webContents.invalidate();await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(220);const facts=await read('({state:document.getElementById("stateSwitch")?.value||null,componentState:document.getElementById("example")?.dataset.state||null,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}})');const image=await win.webContents.capturePage(name.startsWith('Cover-')?{x:0,y:0,width:960,height:288}:undefined);const file=name+'.png';fs.writeFileSync(path.join(OUT,file),image.toPNG());shots.push({file,...image.getSize(),facts});};
  let current='';
  try{
   for(const theme of ['light','dark']){
    await win.loadURL(origin+'/preview/Cover?theme='+theme);await wait(120);await shot('Cover-'+theme);
    for(const comp of COMPONENTS){
     current=theme+'/'+comp;
     await win.loadURL(origin+'/preview/'+comp+'?theme='+theme);await wait(80);
     check(await read('!!document.getElementById("example")'),'render '+current);
     check(await read('document.documentElement.scrollWidth<=innerWidth'),'horizontal bounds '+current);
     for(const state of ['default','hover','pressed','selected','focus','disabled','error']){
      await read('(()=>{const s=document.getElementById("stateSwitch");s.value='+JSON.stringify(state)+';s.dispatchEvent(new Event("change",{bubbles:true}));})()');
      check(await read('document.getElementById("example").dataset.state==='+JSON.stringify(state)),'state '+current+'/'+state);
     }
     await read('(()=>{const s=document.getElementById("stateSwitch");s.value="default";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
     if(comp==='Button'){await click('#example');check(await read('document.getElementById("result").textContent.includes("已保存")'),'button feedback '+current);}
     if(comp==='IconButton'){await click('#example');check(await read('document.getElementById("example").getAttribute("aria-pressed")==="true"'),'icon selected '+current);}
     if(comp==='Input'){await read('(()=>{const i=document.getElementById("example");i.value="";i.dispatchEvent(new Event("input",{bubbles:true}));})()');check(await read('document.getElementById("example").getAttribute("aria-invalid")==="true"'),'input validation '+current);}
     if(comp==='Textarea'){await read('(()=>{const i=document.getElementById("example");i.value=("多行演示草稿 English"+String.fromCharCode(10)).repeat(30);i.dispatchEvent(new Event("input",{bubbles:true}));})()');check(await read('document.getElementById("example").getBoundingClientRect().height<=240'),'textarea height bound '+current);}
     if(comp==='ModelPicker'){await read('(()=>{const s=document.getElementById("example");s.selectedIndex=2;s.dispatchEvent(new Event("change",{bubbles:true}));})()');check(await read('document.getElementById("modelReadback").textContent.includes("正在读取")'),'model pending '+current);await wait(500);check(await read('document.getElementById("modelReadback").textContent.includes("回读完成")'),'model readback '+current);}
     if(comp==='Menu'){await click('#example');check(await read('(()=>{const m=document.getElementById("demoMenu"),r=m.getBoundingClientRect();return !m.hidden&&r.top>=8&&r.left>=8&&r.bottom<=innerHeight-8&&r.right<=innerWidth-8})()'),'menu viewport '+current);await shot(comp+'-'+theme);await click('#demoMenu button');check(await read('document.getElementById("demoMenu").hidden&&document.activeElement.id==="example"'),'menu return focus '+current);}
     if(comp==='Dialog'){await click('#example');check(await read('document.getElementById("demoDialog").matches(":modal")'),'dialog native modal '+current);await shot(comp+'-'+theme);await click('#demoDialog button[value=cancel]');check(await read('!document.getElementById("demoDialog").open&&document.activeElement.id==="example"'),'dialog close focus '+current);}
     if(comp==='Popover'){await click('#example');check(await read('document.getElementById("demoPopover").matches(":popover-open")'),'popover open '+current);await shot(comp+'-'+theme);}
     if(comp==='Tabs'){await click('#tabSpecs');check(await read('document.getElementById("tabSpecs").getAttribute("aria-selected")==="true"&&document.getElementById("tabPanel").getAttribute("aria-labelledby")==="tabSpecs"'),'tab association '+current);}
     if(comp==='Sidebar'){const before=await read('[...document.querySelectorAll("#example button")].map(x=>x.dataset.id).join(",")');await click('#example button[data-id=diff]');check(await read('[...document.querySelectorAll("#example button")].map(x=>x.dataset.id).join(",")==='+JSON.stringify(before)),'sidebar order stable '+current);}
     if(comp==='Tooltip'){win.webContents.focus();await read('document.getElementById("example").focus();getComputedStyle(document.getElementById("attachTip")).opacity');await win.webContents.capturePage();await wait(240);const facts=await read('({active:document.activeElement.id,focus:document.hasFocus(),within:document.querySelector(".pw-tooltip-anchor").matches(":focus-within"),hidden:document.getElementById("attachTip").hidden,opacity:getComputedStyle(document.getElementById("attachTip")).opacity})');check(facts.opacity==='1','tooltip keyboard focus '+current,facts);}
     if(comp==='StatusIndicator'){await click('[data-status-button=warning]');check(await read('document.getElementById("statusText").textContent==="等待审批"'),'status text '+current);}
     if(comp==='Progress'){await click('#startProgress');await wait(1350);check(await read('document.getElementById("progressBar").value===100'),'progress completion '+current);}
     if(comp==='EmptyState'){await click('#emptyAction');check(await read('document.getElementById("result").textContent.includes("演示会话已准备")'),'empty action '+current);}
     if(comp==='ErrorState'){await click('#retryError');check(await read('document.getElementById("retryError").disabled'),'error pending '+current);await wait(550);check(await read('document.getElementById("errorTitle").textContent.includes("成功")'),'error recovery '+current);}
     if(comp==='Toast'){await click('#example');await click('#example');check(await read('!document.getElementById("demoToast").hidden&&document.querySelectorAll("#demoToast").length===1'),'toast deduplicates '+current);}
     if(comp==='ChatMessage'){await click('#selectMessage');check(await read('getSelection().toString().includes("侧栏点击")'),'message selectable '+current);}
     if(comp==='ToolActivity'){await click('#example summary');check(await read('document.getElementById("example").open'),'tool expansion '+current);}
     if(comp==='WorkPanel'){await read('window.__originalPanel=document.getElementById("example")');await click('#closePanel');await click('#openPanel');check(await read('window.__originalPanel===document.getElementById("example")&&!document.getElementById("example").hidden'),'panel identity preserved '+current);}
     if(!['Menu','Dialog','Popover'].includes(comp))await shot(comp+'-'+theme);
    }
   }
  }catch(e){errors.push(current+': '+e.message);console.error(e.stack);}
  finally{
   const result={scope:'design-system native HTML previews rendered in existing Electron Chromium; temporary profile; no real Pi or user project',date:new Date().toISOString(),passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length,checks,shots,errors,notVerified:['Production integration','Physical Windows DPI','Entity IME','Real provider/model behavior','Native Browser WebContentsView']};
   fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify(result,null,2));
   console.log(JSON.stringify({passed:result.passed,failed:result.failed,screenshots:shots.length,errors}));
   win.destroy();server.closeAllConnections();server.close();app.exit(result.failed||errors.length?1:0);
  }
 });
}
