'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.md':'text/plain; charset=utf-8','.png':'image/png','.zip':'application/zip'};
const server=http.createServer((req,res)=>{try{
 const url=new URL(req.url,'http://localhost'),rel=decodeURIComponent(url.pathname).replace(/^\/+/,''),file=path.resolve(root,rel||'index.html');
 if(!file.startsWith(root+path.sep)){res.writeHead(404);return res.end('Not found')}
 const exists=fs.statSync(file,{throwIfNoEntry:false})?.isFile();
 // Editor metadata is optional during offline preview; absence does not prove it stopped.
 if(!exists&&['canvas/.artifact-server.json','system/.artifact-server.json'].includes(rel)){
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  return res.end(JSON.stringify({url:null,status:'unknown'}));
 }
 if(!exists){res.writeHead(404);return res.end('Not found')}
 res.writeHead(200,{'content-type':types[path.extname(file)]??'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});fs.createReadStream(file).pipe(res);
}catch{res.writeHead(400);res.end('Bad request')}});
server.listen(Number(process.argv[2]??process.env.DESIGN_PORT??0),'127.0.0.1',()=>{const data={url:'http://127.0.0.1:'+server.address().port,root,pid:process.pid};fs.mkdirSync(path.join(root,'evidence'),{recursive:true});fs.writeFileSync(path.join(root,'evidence','preview-server.json'),JSON.stringify(data,null,2));console.log(JSON.stringify(data))});
