// Only the separate D5 test BrowserWindow installs this preload.
const {contextBridge,ipcRenderer}=require('electron');
const methods=new Set(['query','preview','history','qualification','prepare','apply','cancel','inspectRecovery','prepareRecovery','exportMaterial']);
contextBridge.exposeInMainWorld('piGuiObjectTest',Object.freeze({invoke(method,body){
 if(!methods.has(method)||!body||typeof body!=='object'||Array.isArray(body))return Promise.resolve({ok:false,code:'invalid_request'});
 return ipcRenderer.invoke('p33-d5-private-object',method,body);
}}));
