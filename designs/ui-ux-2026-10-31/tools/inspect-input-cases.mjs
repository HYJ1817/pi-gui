import {qa,read,sleep} from './refinement-ops.mjs';
const fact=()=>read(`({selected:[...document.querySelectorAll('.pg-session')].filter(e=>e.getAttribute('aria-current')==='true').map(e=>e.innerText),title:document.querySelector('.pg-title').innerText,input:document.querySelector('#message-input').value,usage:document.querySelector('.pg-usage-popover')?.innerText,scroll:{x:scrollX,y:scrollY},row:document.querySelector('[data-session="s4"]').getBoundingClientRect().toJSON()})`);
console.log('before',await fact());
const b=await read(`document.querySelector('[data-session="s4"]').getBoundingClientRect().toJSON()`);
await qa('click',{x:b.x+b.width/2,y:b.y+b.height/2});await sleep(180);console.log('native click',await fact());
await read(`document.querySelector('[data-session="s4"]').click()`);await sleep(180);console.log('DOM click',await fact());
