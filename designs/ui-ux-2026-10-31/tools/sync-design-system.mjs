// Local /design-sync: tokens.json is the only source. No npm or production files.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const project=path.join(root,'system/project'),t=JSON.parse(await fs.readFile(path.join(project,'tokens.json'),'utf8'));
const value=v=>typeof v==='string'?v.replace(/\{([^}]+)\}/g,'var(--$1)'):v;
const lines=theme=>Object.entries(t).flatMap(([family,data])=>family==='type'||!data?.tokens?[]:data.tokens.map(x=>`  --${x.name}: ${value(typeof x.value==='object'?x.value[theme]:x.value)};`));
const fonts=Object.entries(t.type.families).map(([name,font])=>`  --font-${name}: ${font};`);
const typeStyles=t.type.groups.flatMap(g=>(g.styles??[]).flatMap(s=>Object.entries(s).filter(([key])=>['fontSize','lineHeight','fontWeight'].includes(key)).map(([key,v])=>`  --type-${s.name}-${key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}: ${v};`)));
const css=`/* Pi Workbench — generated from tokens.json by tools/sync-design-system.mjs */\n:root, [data-theme="light"] {\n${[...lines('light'),...fonts,...typeStyles].join('\n')}\n}\n[data-theme="dark"] {\n${lines('dark').join('\n')}\n}\n`;
await fs.writeFile(path.join(project,'tokens.css'),css);
const dest=path.join(root,'canvas/project/ds/pi-workbench-refined');await fs.mkdir(path.join(dest,'components'),{recursive:true});
for(const file of ['tokens.json','tokens.css','components/bundle.css'])await fs.copyFile(path.join(project,file),path.join(dest,file));
console.log('Synced '+t.color.tokens.length+' color tokens and shared dimensions; previous A/B snapshots unchanged.');
