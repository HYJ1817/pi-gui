'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom'),{bundle}=require('./esm-bundle.cjs');
const root=path.resolve(__dirname,'..');
let passed=0,failed=0;
const check=(name,fn)=>{try{fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+e.message);}};
const pause=()=>new Promise(r=>setTimeout(r,30));
(async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'public/index.html'),'utf8'),{url:'http://fixture.invalid/',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document,calls=[];
 w.matchMedia=()=>({matches:false,addEventListener(){}});w.ResizeObserver=class{observe(){}};
 w.HTMLElement.prototype.scrollIntoView=()=>{};w.EventSource=class{close(){}};
 w.fetch=async(url,o={})=>{if(url==='/api/command')calls.push(JSON.parse(o.body));return{ok:true,json:async()=>({ok:true,projects:[],providers:[],models:[],items:[],files:[],sessions:[],hasProject:false,piRunning:false,isRepo:false})};};
 w.eval(bundle(path.join(root,'public/app.js')).code);await pause();
 Object.assign(w.S,{hasProject:true,bridgeState:'ready',switching:false,submitting:false,stopping:false,fallbackActive:false,modelSwitchPending:false,attachments:[],thinkingLevels:['off','high'],state:{model:{provider:'a',id:'same',reasoning:true,input:['text','image']},thinkingLevel:'high'}});
 const input=d.getElementById('input');input.disabled=false;w.applyProjectState();w.renderModelControls();
 const set=v=>{input.value=v;input.setSelectionRange(v.length,v.length);input.dispatchEvent(new w.Event('input',{bubbles:true}));};
 const key=(k,opts={})=>input.dispatchEvent(new w.KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true,...opts}));
 const opened=()=>!!d.querySelector('.ui3-inline-menu:not([hidden])');
 check('production styles loaded once each',()=>{for(const file of ['ui3-composer.css','ui3-model.css','ui3-inline-commands.css'])assert.equal(d.querySelectorAll(`link[href="/${file}"]`).length,1);});
 let runs=0;w.defineCommands([{id:'ui3.fixture',title:'Fixture command',keywords:'uniquefixture',run:()=>{runs++;}}]);
 set('/uniquefixture');check('production input opens real registered slash candidate',()=>assert.ok(opened()));
 const before=calls.length;key('Enter');
 check('Enter runs exactly once, consumes command token, no send',()=>{assert.equal(runs,1);assert.equal(input.value,'');assert.equal(calls.length,before);assert.equal(opened(),false);});
 set('draft\n/uniquefixture');key('Enter');check('command removes only token and preserves surrounding draft',()=>{assert.equal(input.value,'draft\n');assert.equal(runs,2);});
 set('/uniquefixture');key('Escape');check('Escape closes slash without abort or losing draft',()=>{assert.equal(opened(),false);assert.equal(input.value,'/uniquefixture');assert.equal(calls.filter(c=>c.type==='abort').length,0);});
 for(const signal of [{isComposing:true},{keyCode:229}]){set('普通草稿');const n=calls.length;key('Enter',signal);check('IME ordinary Enter guarded '+JSON.stringify(signal),()=>assert.equal(calls.length,n));}
 set('/uniquefixture');input.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));const n=calls.length;key('Enter');
 check('composition lifecycle closes menu and prevents submit',()=>{assert.equal(opened(),false);assert.equal(calls.length,n);});
 input.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
 set('/uniquefixture');key('k',{ctrlKey:true});check('Ctrl+K target opens independent panel with slash closed',()=>{assert.equal(d.getElementById('paletteLayer').hidden,false);assert.equal(opened(),false);});w.closePalette();
 for(const event of [new w.CustomEvent('pi-gui:session-switch'),new w.CustomEvent('pi-gui:workspace-view',{detail:{view:'planner'}}),new w.CustomEvent('pi-gui:workspace-view',{detail:{view:'runtime'}})]){set('/uniquefixture');d.dispatchEvent(event);check('lifecycle '+event.type+' preserves draft and closes menu',()=>{assert.equal(opened(),false);assert.equal(input.value,'/uniquefixture');});}
 w.S.models=[{provider:'a',id:'same',name:'Same'},{provider:'b',id:'same',name:'Same'}];d.getElementById('btnModel').click();
 check('production model view selects only matching Provider identity',()=>{const selected=d.querySelectorAll('.ui3-model-item.on');assert.equal(selected.length,1);assert.equal(selected[0].dataset.provider,'a');assert.ok(d.querySelector('.ui3-current').textContent.includes('a / same'));});w.closePop();
 for(const [reasoning,expected] of [[false,'unsupported'],[null,'unknown'],[true,'unavailable']]){
   w.S.state.model={provider:'a',id:'same',reasoning};w.S.thinkingLevels=[];w.renderModelControls();await pause();
   const info=d.getElementById('btnThinkInfo');info.focus();info.click();
   check('unavailable Thinking explanation reachable: '+expected,()=>{assert.equal(w.el.btnThink.disabled,true);assert.equal(info.hidden,false);assert.equal(d.querySelector('.ui3-think-state').dataset.state,expected);assert.equal(d.querySelectorAll('.ui3-think-item:not(:disabled)').length,0);});
   d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
   check('explanation Escape restores actual trigger focus: '+expected,()=>{assert.equal(d.getElementById('composerPopover').hidden,true);assert.equal(d.activeElement,info);});
 }
 w.S.modelSwitchPending=true;w.S.thinkingLevels=['off','high'];w.renderModelControls();await pause();d.getElementById('btnThinkInfo').click();
 check('pending explanation cannot enable selection or send',()=>{assert.equal(d.querySelector('.ui3-think-state').dataset.state,'pending');assert.equal(d.querySelectorAll('.ui3-think-item:not(:disabled)').length,0);assert.equal(w.el.btnSend.disabled,true);});
 w.S.modelSwitchPending=false;w.S.thinkingLevels=['off','high'];w.renderModelControls();await pause();
 check('real returned levels enable existing button and hide explanation entry',()=>{assert.equal(w.el.btnThink.disabled,false);assert.equal(d.getElementById('btnThinkInfo').hidden,true);});
 check('readback closes obsolete pending explanation and restores enabled trigger',()=>{assert.equal(d.getElementById('composerPopover').hidden,true);assert.equal(d.activeElement,w.el.btnThink);});
 set('ordinary message');const prompts=calls.filter(c=>c.type==='prompt').length;key('Enter');await pause();
 check('ordinary Enter reaches original submit exactly once',()=>assert.equal(calls.filter(c=>c.type==='prompt').length,prompts+1));
 dom.window.close();console.log(`UI3 integration ${passed}/${passed+failed}; failed=${failed}; skipped=0`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
