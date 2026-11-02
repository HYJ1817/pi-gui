import fs from 'node:fs/promises';
import path from 'node:path';
import {root,qa,read,sleep} from './refinement-ops.mjs';
await qa('load',{url:'http://127.0.0.1:8120/exports/refined/Refined.dc.html'});await sleep(300);
const checks=await read(`[
 {name:'任务和资源退出聊天侧栏',pass:!document.querySelector('.pg-sidebar #nav-tasks')&&!document.querySelector('.pg-sidebar #nav-skills')},
 {name:'选择器没有装饰下箭头',pass:!/[⌄▾▿]/.test(['#toggle-runtime','#model-trigger','#think-trigger'].map(s=>document.querySelector(s)?.textContent??'').join(''))},
 {name:'变更与浏览器退出顶栏',pass:!document.querySelector('.pg-header #open-changes')&&!document.querySelector('.pg-header #open-browser')}
]`);
const out=path.join(root,'evidence/comment-revision');await fs.mkdir(out,{recursive:true});const before=process.argv.includes('--before');await fs.writeFile(path.join(out,before?'before.json':'acceptance.json'),JSON.stringify({scope:'browser comments presentation acceptance only',passed:checks.filter(x=>x.pass).length,total:checks.length,checks},null,2));
console.log(checks);process.exitCode=checks.some(x=>!x.pass)?1:0;
