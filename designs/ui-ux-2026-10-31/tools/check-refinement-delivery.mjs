import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const t=JSON.parse(await fs.readFile(path.join(root,'system/project/tokens.json'),'utf8'));
const file=path.join(root,'system/project/Contrast-Checks.md'),old=await fs.readFile(file,'utf8');
const base=path.join(root,'revisions/2026-11-01/baseline-contrast.md');try{await fs.access(base)}catch{await fs.writeFile(base,old)}
const colors=Object.fromEntries(t.color.tokens.map(x=>[x.name,x.value]));
const lum=h=>{const v=h.slice(1).match(/../g).slice(0,3).map(x=>parseInt(x,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return .2126*v[0]+.7152*v[1]+.0722*v[2]};
const pairs=[...old.matchAll(/^\| (light|dark) \| ([\w-]+) \| ([\w-]+) \| [\d.]+ \| ([\d.]+):1 \|$/gm)].map(m=>{const [,theme,fg,bg,min]=m,a=lum(colors[fg][theme]),b=lum(colors[bg][theme]),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);return {theme,fg,bg,ratio,min:Number(min),pass:ratio>=Number(min)}});
if(pairs.length!==78)throw Error('Expected 78 preserved contrast pairings, got '+pairs.length);
const passed=pairs.filter(x=>x.pass).length;
await fs.writeFile(file,`# v2 对比度计算记录\n\n2026-11-01，使用当前 tokens.json 重新计算，${passed}/${pairs.length}；失败${pairs.length-passed}。不继承首轮值。普通文字4.5:1，焦点/控件边界3:1；border-subtle为装饰分隔，不承担唯一可操作边界。透明遮罩不作文字背景计算。\n\n算法：WCAG sRGB相对亮度；通道≤0.04045时除12.92，否则((c+0.055)/1.055)^2.4。亮度0.2126R+0.7152G+0.0722B；比值(L高+0.05)/(L低+0.05)。全精度判断，显示保留两位。指定配对通过不等于所有叠加或透明状态均已验证。\n\n| 主题 | 前景 | 背景 | 比值 | 要求 |\n| --- | --- | --- | ---: | ---: |\n`+pairs.map(p=>`| ${p.theme} | ${p.fg} | ${p.bg} | ${p.ratio.toFixed(2)} | ${p.min}:1 |`).join('\n')+'\n');
const checks=[];const check=(pass,name)=>checks.push({name,pass:!!pass});
check(passed===78,'v2 contrast 78 pairings');
const manifest=JSON.parse(await fs.readFile(path.join(root,'exports/refined-manifest.json'),'utf8'));
const hash=async p=>createHash('sha256').update(await fs.readFile(path.join(root,p))).digest('hex');
check(await hash('canvas/project/Refined.dc.html')===manifest.sourceSha256,'current source matches export');check(await hash('exports/refined.zip')===manifest.sha256,'current ZIP hash');
const prior=JSON.parse(await fs.readFile(path.join(root,'exports/export-manifest.json'),'utf8'));
for(const r of prior.records){check(await hash('canvas/project/'+r.file)===r.sourceSha256,'prior '+r.slug+' source preserved');check(await hash('exports/'+r.slug+'.zip')===r.sha256,'prior '+r.slug+' ZIP preserved')}
for(const name of ['review-refined.html','reports/10-refinement-plan.md','reports/11-refinement-validation.md','reports/12-refinement-review.md','reports/13-browser-comment-revision.md','reports/14-input-assistance-reference.md','reports/15-input-assistance-validation.md','system/project/README.md']){
 const text=await fs.readFile(path.join(root,name),'utf8');const links=name.endsWith('.html')?[...text.matchAll(/(?:href|src)="([^"{}]+)"/g)].map(x=>x[1]):[...text.matchAll(/\]\(([^)]+)\)/g)].map(x=>x[1]);
 for(const link of links){if(/^(https?:|#)/.test(link))continue;try{await fs.access(path.resolve(path.dirname(path.join(root,name)),link.split('#')[0]));check(true,name+' → '+link)}catch{check(false,name+' → '+link)}}
}
await fs.writeFile(path.join(root,'evidence/input-assistance/contrast-results.json'),JSON.stringify({tokensSha256:await hash('system/project/tokens.json'),passed,total:pairs.length,pairs},null,2));
await fs.writeFile(path.join(root,'evidence/input-assistance/delivery-results.json'),JSON.stringify({passed:checks.filter(x=>x.pass).length,total:checks.length,checks},null,2));
console.log('Contrast '+passed+'/'+pairs.length+'; delivery '+checks.filter(x=>x.pass).length+'/'+checks.length);for(const c of checks)if(!c.pass)console.log('FAIL '+c.name);process.exitCode=checks.some(x=>!x.pass)?1:0;
