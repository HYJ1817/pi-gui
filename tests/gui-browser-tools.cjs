const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {pathToFileURL}=require('node:url');
const {EventEmitter}=require('node:events');
(async()=>{
  const adapter=await import('../extensions/pi-gui-browser/index.js');
  const oldUrl=process.env.PI_GUI_BROWSER_URL,oldToken=process.env.PI_GUI_BROWSER_TOKEN;
  try{
    delete process.env.PI_GUI_BROWSER_URL;delete process.env.PI_GUI_BROWSER_TOKEN;
    let tools=[];adapter.default({registerTool:tool=>tools.push(tool)});assert.equal(tools.length,0);
    process.env.PI_GUI_BROWSER_URL='http://127.0.0.1:12345';process.env.PI_GUI_BROWSER_TOKEN='test-capability';
    adapter.default({registerTool:tool=>tools.push(tool)});assert.equal(tools.length,12);assert.equal(new Set(tools.map(t=>t.name)).size,12);assert.ok(tools.every(t=>t.name.startsWith('gui_browser_')));assert.ok(tools.every(t=>!t.name.startsWith('browser_')));
    const image=adapter.toolResult({ok:true,image:{data:'pixels',mimeType:'image/png'},generation:1});assert.equal(image.content[0].type,'image');assert.equal(image.content[0].data,'pixels');assert.ok(!JSON.stringify(image.details).includes('pixels'));assert.ok(!('image' in image.details));
    const fill=tools.find(t=>t.name==='gui_browser_fill');assert.deepEqual(fill.parameters.required,['ref','text']);assert.equal(fill.parameters.additionalProperties,false);
    const error=await fill.execute('id',{ref:'e1',text:'private'},AbortSignal.abort());assert.equal(error.details.code,'cancelled');assert.equal(error.isError,true);assert.ok(!JSON.stringify(error).includes('private'));
    const {createGuiBrowserLaunch}=await import('../server/gui-browser-launch.js');
    const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'pi-gui-browser-api-'));try{assert.equal(createGuiBrowserLaunch({launch:{packageDir:()=>fixture},env:{}}).available(),false);}finally{fs.rmSync(fixture,{recursive:true,force:true});}
    const {createRpcBridge}=await import('../server/rpc-bridge.js');
    let spawnSpec, invalidated=0, stopped=false, cancellationAck,failAck=false;const events=[],writes=[];
    const rpc=createRpcBridge({runtime:{getCurrentCwd:()=>os.tmpdir(),isShuttingDown:()=>stopped},publish:event=>events.push(event),piBin:'fixture-pi',isWin:false,
      env:{PI_GUI_TOKEN:'MAIN_SECRET',PI_GUI_BROWSER_BRIDGE_TOKEN:'MASTER_SECRET',PI_GUI_BROWSER_EXTENSION:'PRIVATE_PATH',PI_GUI_BROWSER_URL:'OLD_URL',PI_GUI_BROWSER_TOKEN:'OLD_TOKEN'},
      browserLaunch:{available:()=>true,prepare:async()=>({args:['--extension','BUNDLED_EXTENSION'],env:{PI_GUI_BROWSER_URL:'http://127.0.0.1:23456',PI_GUI_BROWSER_TOKEN:'SESSION_SECRET'}}),invalidate:(opts)=>{invalidated++;return opts?.strict?(failAck?Promise.reject(Error('MASTER_SECRET raw failure')):new Promise(resolve=>{cancellationAck=resolve;})):Promise.resolve();}},
      spawnProcess:(command,args,opts)=>{spawnSpec={command,args,opts};const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdout.setEncoding=child.stderr.setEncoding=()=>{};child.stdin={on(){},write(line){writes.push(JSON.parse(line));},end(){}};child.kill=()=>{};return child;}});
    await rpc.start();assert.ok(spawnSpec.args.includes('--extension'));assert.ok(spawnSpec.args.includes('BUNDLED_EXTENSION'));assert.equal(spawnSpec.opts.env.PI_GUI_BROWSER_TOKEN,'SESSION_SECRET');assert.equal(spawnSpec.opts.env.PI_GUI_TOKEN,undefined);assert.equal(spawnSpec.opts.env.PI_GUI_BROWSER_BRIDGE_TOKEN,undefined);assert.equal(spawnSpec.opts.env.PI_GUI_BROWSER_EXTENSION,undefined);
    assert.ok(!JSON.stringify(events).includes('SECRET'));assert.ok(!JSON.stringify(rpc.getState()).includes('BUNDLED_EXTENSION'));
    const stopPromise=rpc.send({type:'abort'});assert.equal(invalidated,1);assert.equal(writes.length,0);assert.ok(stopPromise instanceof Promise);cancellationAck();await stopPromise;assert.equal(writes[0].type,'abort');
    failAck=true;let safeFailure;try{await rpc.send({type:'abort'});}catch(err){safeFailure=err.message;}assert.ok(safeFailure.includes('取消确认不可用'));assert.ok(!safeFailure.includes('SECRET'));assert.equal(writes.length,2);
    stopped=true;rpc.stop();assert.equal(invalidated,3);
    console.log('gui-browser-tools: 31/31 assertions passed');
    // Opt-in official loader evidence, resolved from the same launch identity as production.
    if(process.env.PI_GUI_AGENT_BROWSER_PI_LOAD==='1'){
      const {createPiLaunch}=await import('../server/pi-launch.js');const launch=createPiLaunch({piBin:process.env.PI_BIN||'pi',env:process.env,getCwd:()=>process.cwd()});const dir=launch.packageDir();
      const loader=await import(pathToFileURL(path.join(dir,'dist/core/extensions/loader.js')).href);
      const result=await loader.loadExtensions([path.resolve('extensions/pi-gui-browser/index.js')],os.tmpdir());assert.deepEqual(result.errors,[]);assert.equal(result.extensions[0].tools.size,12);
      console.log('official Pi loader: 2/2 assertions passed');
    }
  }finally{if(oldUrl===undefined)delete process.env.PI_GUI_BROWSER_URL;else process.env.PI_GUI_BROWSER_URL=oldUrl;if(oldToken===undefined)delete process.env.PI_GUI_BROWSER_TOKEN;else process.env.PI_GUI_BROWSER_TOKEN=oldToken;}
})().catch(error=>{console.error(error);process.exitCode=1;});
