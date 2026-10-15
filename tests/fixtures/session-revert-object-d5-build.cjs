// Private bundling adds exports only in TEMP output, never in product sources.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const ROOT=path.resolve(__dirname,'../..');
async function build({resourceRoot=null}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'p33-D5-launcher-'));
 const entry=path.join(root,'D5-private-main.cjs');
 const esbuild=await import('esbuild');
 const assetEntry=resourceRoot?path.join(resourceRoot,'server.cjs'):path.join(ROOT,'server/session-revert-compute.js');
 await esbuild.build({entryPoints:[path.join(__dirname,'session-revert-object-d5-launcher.mjs')],bundle:true,platform:'node',format:'cjs',target:'node22',outfile:entry,external:['electron'],define:{'import.meta.url':'__D5_ASSET_URL__'},banner:{js:'var __D5_ASSET_URL__=require("url").pathToFileURL('+JSON.stringify(assetEntry)+').href;'},logLevel:'silent',plugins:[{name:'D5-TEMP-private-core',setup(b){b.onLoad({filter:/session-revert-object-(?:writer|service)\.js$/},async a=>({contents:await fs.readFile(a.path,'utf8')+'\nexport { '+(a.path.endsWith('writer.js')?'createIsolatedWriter':'createObjectServiceCore')+' };',loader:'js'}));}}]});
 for(const file of ['session-revert-object-d5-preload.cjs','session-revert-object-d5-rpc.mjs'])await fs.copyFile(path.join(__dirname,file),path.join(root,file));
 return {root,entry,resourceRoot:resourceRoot??ROOT,preload:path.join(root,'session-revert-object-d5-preload.cjs'),rpc:path.join(root,'session-revert-object-d5-rpc.mjs')};
}
module.exports={build,ROOT};
