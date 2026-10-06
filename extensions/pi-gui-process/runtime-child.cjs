// Private RPC wrapper inside the existing guardian Job/group. No PID control protocol.
const net=require('node:net'),{spawn}=require('node:child_process'),{StringDecoder}=require('node:string_decoder');
const LIMIT=1024*1024;
const port=Number(process.env.PI_GUI_SUPERVISOR_PORT),token=process.env.PI_GUI_SUPERVISOR_TOKEN;
delete process.env.PI_GUI_SUPERVISOR_PORT;delete process.env.PI_GUI_SUPERVISOR_TOKEN;
if(!Number.isInteger(port)||port<1||port>65535||!token)process.exit(1);
const socket=net.connect({host:'127.0.0.1',port});
let child=null,buffer='',decoder=new StringDecoder('utf8');
const send=frame=>{const data=JSON.stringify(frame)+'\n';if(Buffer.byteLength(data)>LIMIT||socket.writableLength>LIMIT)return socket.destroy();socket.write(data);};
socket.on('connect',()=>send({type:'hello',token}));
socket.on('error',()=>process.exit(1));socket.on('close',()=>process.exit(0));
socket.on('data',chunk=>{
  socket.pause();buffer+=decoder.write(chunk);if(buffer.length>LIMIT)return socket.destroy();
  void drain().then(()=>{if(!socket.destroyed)socket.resume();},()=>socket.destroy());
});
async function drain(){
  let end;
  while((end=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let frame;try{frame=JSON.parse(line);}catch{return socket.destroy();}
    if(!child){
      if(frame.type!=='spec'||typeof frame.command!=='string'||!Array.isArray(frame.args)||!frame.args.every(v=>typeof v==='string')||typeof frame.cwd!=='string'||!frame.env||typeof frame.env!=='object')return socket.destroy();
      const env={...frame.env};for(const key of Object.keys(env))if(key.startsWith('PI_GUI_SUPERVISOR'))delete env[key];
      try{child=spawn(frame.command,frame.args,{cwd:frame.cwd,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{send({type:'failure'});return;}
      child.on('spawn',()=>send({type:'spawn'}));
      child.on('error',()=>send({type:'failure'}));child.stdin.on('error',()=>{});
      for(const type of ['stdout','stderr'])child[type].on('data',data=>send({type,data:data.toString('base64')}));
      child.on('close',code=>send({type:'exit',code:Number.isInteger(code)?code:1}));
    }else if(frame.type==='stdin'&&typeof frame.data==='string'&&frame.data.length<=LIMIT){
      const data=Buffer.from(frame.data,'base64');if(data.length>64*1024)return socket.destroy();
      await new Promise((resolve,reject)=>child.stdin.write(data,error=>error?reject(error):resolve()));
    }else return socket.destroy();
  }
}
