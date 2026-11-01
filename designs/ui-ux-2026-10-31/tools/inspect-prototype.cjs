'use strict';
// Local design QA driver. Uses the already installed Electron Chromium.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../../..'),OUT=path.resolve(__dirname,'../evidence/prototype');
if(!process.versions.electron){const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(require('electron'),[__filename],{cwd:ROOT,env,stdio:'inherit',windowsHide:true});child.on('exit',c=>process.exitCode=c??1)}else main();
async function main(){
 const {app,BrowserWindow,session}=require('electron');const world=fs.mkdtempSync(path.join(os.tmpdir(),'pi-design-qa-'));app.setPath('userData',path.join(world,'profile'));await app.whenReady();fs.mkdirSync(OUT,{recursive:true});
 const errors=[];session.defaultSession.webRequest.onBeforeRequest((details,cb)=>{const ok=/^(http:\/\/(127\.0\.0\.1|localhost):\d+\/|data:|blob:|devtools:|about:)/.test(details.url);cb({cancel:!ok})});
 const win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,autoHideMenuBar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
 win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
 await win.loadURL('about:blank');
 const frameFor=target=>{const frames=win.webContents.mainFrame.framesInSubtree;if(target==='preview')return frames.find(f=>f.url.startsWith('about:srcdoc')||f.url.includes('blob:'))??frames.at(-1);return win.webContents.mainFrame};
 const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');let data='';for await(const part of req)data+=part;let result;
 if(url.pathname==='/state')result={title:win.getTitle(),size:win.getContentSize(),zoom:win.webContents.getZoomFactor(),frames:win.webContents.mainFrame.framesInSubtree.map(f=>({url:f.url,name:f.name,processId:f.processId,routingId:f.routingId})),errors};
 else if(url.pathname==='/eval')result=await frameFor(url.searchParams.get('target')).executeJavaScript(data,true);
 else if(url.pathname==='/load'){await win.loadURL(JSON.parse(data).url);result={loaded:true}}
 else if(url.pathname==='/size'){const d=JSON.parse(data);win.setContentSize(d.width,d.height);if(d.zoom)win.webContents.setZoomFactor(d.zoom);result=win.getContentSize()}
 else if(url.pathname==='/key'){const d=JSON.parse(data),keyCode=({ArrowDown:'Down',ArrowUp:'Up',ArrowLeft:'Left',ArrowRight:'Right'})[d.key]??d.key;win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers:d.modifiers??[]});if(d.key==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:'\r',modifiers:d.modifiers??[]});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers:d.modifiers??[]});result={sent:true}}
 else if(url.pathname==='/click'){const d=JSON.parse(data),z=win.webContents.getZoomFactor(),x=Math.round(d.x*z),y=Math.round(d.y*z);win.webContents.sendInputEvent({type:'mouseDown',x,y,button:d.button??'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x,y,button:d.button??'left',clickCount:1});result={sent:true,css:{x:d.x,y:d.y},dip:{x,y},zoom:z}}
 else if(url.pathname==='/move'){const d=JSON.parse(data),z=win.webContents.getZoomFactor();win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(d.x*z),y:Math.round(d.y*z)});result={sent:true}}
 else if(url.pathname==='/media'){if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:JSON.parse(data)});result={emulated:true}}
 else if(url.pathname==='/shot'){const name=url.searchParams.get('name');if(!/^[a-zA-Z0-9_.-]+$/.test(name))throw Error('invalid evidence name');win.webContents.invalidate();await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await new Promise(r=>setTimeout(r,220));const image=await win.webContents.capturePage();const file=path.join(OUT,name+'.png');fs.writeFileSync(file,image.toPNG());result={file,size:image.getSize(),contentSize:win.getContentSize()}}
 else if(url.pathname==='/fonts'){if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('DOM.enable');await win.webContents.debugger.sendCommand('CSS.enable');const tree=await win.webContents.debugger.sendCommand('DOM.getFlattenedDocument',{depth:-1,pierce:true});const ids=tree.nodes.filter(n=>n.nodeName==='TEXTAREA'||(n.nodeName==='ARTICLE'&&n.attributes?.includes('pg-assistant'))).slice(0,4);result=await Promise.all(ids.map(async n=>({node:n.nodeName,...await win.webContents.debugger.sendCommand('CSS.getPlatformFontsForNode',{nodeId:n.nodeId})})));}
 else if(url.pathname==='/quit'){result={closed:true};setTimeout(()=>app.quit(),100)}else throw Error('unknown QA operation');
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result??null));
 }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.stack}))}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const info={url:'http://127.0.0.1:'+server.address().port,world,pid:process.pid};fs.writeFileSync(path.join(OUT,'driver.json'),JSON.stringify(info,null,2));console.log(JSON.stringify(info));app.on('before-quit',()=>{server.closeAllConnections();server.close()});
}
