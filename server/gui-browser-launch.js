import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

// Private launch adapter. Neither its paths nor its credentials enter bridge status.
export function createGuiBrowserLaunch({launch,env=process.env}) {
  const url=env.PI_GUI_BROWSER_BRIDGE_URL, token=env.PI_GUI_BROWSER_BRIDGE_TOKEN, extension=env.PI_GUI_BROWSER_EXTENSION;
  let supported=false, active=false, bundled=false, lifecycleQueue=Promise.resolve();
  try {
    bundled=Boolean(extension&&fs.statSync(extension).isFile());
    const dir=launch.packageDir();
    const args=fs.readFileSync(path.join(dir,'dist','cli','args.js'),'utf8');
    const types=fs.readFileSync(path.join(dir,'dist','core','extensions','types.d.ts'),'utf8');
    supported=Boolean(url&&token&&bundled&&args.includes('"--extension"')&&types.includes('registerTool<'));
  } catch { /* Unknown official API -> do not inject tools. */ }
  function requestLifecycle(endpoint,body) {
    return new Promise((resolve,reject) => {
      const target=new URL(url);
      if(target.protocol!=='http:'||target.hostname!=='127.0.0.1') return reject(Error('invalid bridge'));
      const req=http.request(new URL(endpoint,target),{method:'POST',headers:{'Content-Type':'application/json','X-Pi-Browser-Token':token}},res=>{
        let text=''; res.on('data',chunk=>{text+=chunk;if(text.length>4096)req.destroy();});res.on('end',()=>{try{const result=JSON.parse(text);result.ok?resolve(result):reject(Error('unavailable'));}catch{reject(Error('unavailable'));}});res.on('error',reject);
      }); req.on('error',reject); req.setTimeout(3000,()=>req.destroy(Error('timeout'))); req.end(JSON.stringify({...body,requestId:randomUUID()}));
    });
  }
  function lifecycle(endpoint,body) {
    const task=lifecycleQueue.catch(()=>{}).then(()=>requestLifecycle(endpoint,body));
    lifecycleQueue=task.catch(()=>{});return task;
  }
  return {
    available:()=>supported,
    report:()=>({bundled,configured:supported,loaded:null,bridgeReady:active}),
    async prepare() { if(!supported)return null; try{const result=await lifecycle('/session',{});active=true;return {args:['--extension',extension],env:{PI_GUI_BROWSER_URL:url,PI_GUI_BROWSER_TOKEN:result.token}};}catch{active=false;return null;} },
    invalidate({disable=false,revoke=false,strict=false}={}) { if(!supported)return Promise.resolve(); if(revoke)active=false; return lifecycle('/invalidate',{disable,revoke}).then(()=>{if(revoke)active=false;}).catch(()=>{active=false;if(strict)throw Error('Browser cancellation acknowledgement unavailable');}); },
  };
}
