import http from 'node:http';
import { randomUUID } from 'node:crypto';

// Only Node built-ins: schemas are ordinary JSON Schema accepted by Pi's official tool API.
export const ACTIONS = ['open','snapshot','click','fill','press','reload','back','forward','screenshot','console','network','status'];
export function transport(connection, endpoint, body, signal) {
  return new Promise((resolve,reject) => {
    if (signal?.aborted) return reject(Object.assign(Error(), {code:'cancelled'}));
    const address = new URL(connection.url);
    if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1') return reject(Object.assign(Error(), {code:'desktop_required'}));
    const req = http.request(new URL(endpoint, address), {method:'POST',headers:{'Content-Type':'application/json','X-Pi-Browser-Token':connection.token}}, res => {
      const chunks=[]; let bytes=0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) req.destroy(Object.assign(Error(),{code:'payload_too_large'})); else chunks.push(chunk); });
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(Error(),{code:'internal'})); } });
      res.on('error',reject);
    });
    const abort = () => req.destroy(Object.assign(Error(),{code:'cancelled'}));
    signal?.addEventListener('abort',abort,{once:true});
    req.on('close', () => signal?.removeEventListener('abort',abort));
    req.on('error',reject);
    req.setTimeout(18000, () => req.destroy(Object.assign(Error(),{code:'timeout'})));
    req.end(JSON.stringify(body));
  });
}
export function toolResult(result) {
  const details = result && typeof result === 'object' ? result : {ok:false,code:'internal'};
  // Screenshot pixels enter model context through Pi's official image ToolResult.
  if (details.ok !== false && typeof details.image?.data === 'string' && details.image.mimeType === 'image/png') {
    const {image,...summary}=details;
    const {data,mimeType}=image;
    return {content:[{type:'image',data,mimeType},{type:'text',text:JSON.stringify(summary)}],details:summary};
  }
  return {content:[{type:'text',text:JSON.stringify(details)}],details,isError:details.ok===false};
}
export default function browserExtension(pi) {
  const connection = {url:process.env.PI_GUI_BROWSER_URL,token:process.env.PI_GUI_BROWSER_TOKEN};
  if (!connection.url || !connection.token) return; // Web mode registers no unavailable tools.
  for (const action of ACTIONS) {
    const properties = action === 'open' ? {url:{type:'string',maxLength:2048}}
      : action === 'click' ? {ref:{type:'string',maxLength:128}}
      : action === 'fill' ? {ref:{type:'string',maxLength:128},text:{type:'string',maxLength:16384}}
      : action === 'press' ? {key:{type:'string',enum:['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Backspace','Delete','Home','End','PageUp','PageDown','Ctrl+Enter']}}
      : ['console','network'].includes(action) ? {limit:{type:'integer',minimum:1,maximum:100}} : {};
    pi.registerTool({name:`gui_browser_${action}`,label:`Built-in browser ${action}`,
      description:`${action} in pi-GUI's built-in browser. Requires the user's Agent Control switch; only loopback web pages are permitted.`,
      parameters:{type:'object',properties,required:['open','click','fill','press'].includes(action)?Object.keys(properties):[],additionalProperties:false},
      async execute(toolCallId,args,signal) {
        const requestId=randomUUID();
        const cancel = () => { transport(connection,'/cancel',{requestId}).catch(() => {}); };
        signal?.addEventListener('abort',cancel,{once:true});
        try {
          const state=await transport(connection,'/state',{requestId},signal);
          if (!state.ok) return toolResult(state);
          const result=await transport(connection,'/action',{requestId,action,args,epoch:state.epoch,generation:state.generation},signal);
          return toolResult(result);
        } catch(err) { return toolResult({ok:false,code:err.code === 'cancelled'?'cancelled':err.code === 'timeout'?'timeout':'cdp_unavailable',message:'Built-in browser request could not complete.'}); }
        finally { signal?.removeEventListener('abort',cancel); }
      },
    });
  }
}
