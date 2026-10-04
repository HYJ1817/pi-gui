/* Project-config form editor; no persistence or second model catalog. */
import { S } from '../state.js';
import { modelIdentity, modelCapabilitySummary } from '../model-capabilities.js';
import { normalizeFallbackConfig, sameModel } from '../model-fallback.js';
export function createFallbackSettings(initial,primary) {
  let config=normalizeFallbackConfig(initial),onChange=()=>{},available=[];
  const box=document.createElement('section');box.className='field fallback-settings';
  const title=document.createElement('label');title.textContent='自动备用模型';box.appendChild(title);
  const label=document.createElement('label');label.className='fallback-enable';
  const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=config.enabled;
  label.append(enabled,document.createTextNode('启用自动备用'));box.appendChild(label);
  const hint=document.createElement('div');hint.className='hint';hint.textContent='仅在没有回答或工具活动的可靠生成故障后按顺序尝试。认证、上下文溢出和未知错误不自动切换。';box.appendChild(hint);
  const list=document.createElement('div');list.className='fallback-chain';box.appendChild(list);
  const addRow=document.createElement('div');addRow.className='fallback-add';
  const select=document.createElement('select');select.setAttribute('aria-label','选择备用模型');
  const add=document.createElement('button');add.type='button';add.className='btn tiny';add.textContent='添加备用模型';add.dataset.fallbackAdd='';addRow.append(select,add);box.appendChild(addRow);
  const validation=document.createElement('div');validation.className='hint';validation.setAttribute('aria-live','polite');box.appendChild(validation);
  function error(){return enabled.checked && !config.chain.length?'至少添加一个备用模型。'
    :config.chain.some(id=>sameModel(id,primary()))?'当前主模型不能再次出现在备用顺序中。':'';}
  function draw(){
    list.replaceChildren();
    config.chain.forEach((id,index)=>{
      const model=S.models.find(m=>sameModel(m,id)),row=document.createElement('div');row.className='fallback-row';
      const text=document.createElement('div');text.className='fallback-model';
      const name=document.createElement('span');name.textContent=`${index+1}. ${id.providerId} / ${model?.name||id.modelId}`;name.title=id.modelId;
      const detail=document.createElement('small');detail.textContent=!model?'模型不可用（运行时跳过）':sameModel(id,primary())?'当前主模型（不会重复尝试）':modelCapabilitySummary(model).text||'能力未确认';
      text.append(name,detail);row.appendChild(text);
      for(const [caption,delta] of [['↑',-1],['↓',1],['×',0]]){
        const button=document.createElement('button');button.type='button';button.className='btn tiny';button.textContent=caption;
        button.setAttribute('aria-label',`${delta===0?'删除':delta<0?'上移':'下移'}备用模型 ${id.providerId}/${id.modelId}`);
        button.disabled=delta!==0 && (index+delta<0 || index+delta>=config.chain.length);
        button.onclick=()=>{if(delta===0)config.chain.splice(index,1);else [config.chain[index],config.chain[index+delta]]=[config.chain[index+delta],config.chain[index]];draw();};row.appendChild(button);
      }
      list.appendChild(row);
    });
    select.replaceChildren();available=[];const groups=new Map();
    S.models.forEach(m=>{if(sameModel(m,primary()) || config.chain.some(id=>sameModel(id,m)))return;
      const id=modelIdentity(m);if(!groups.has(id.providerId)){const g=document.createElement('optgroup');g.label=id.providerId;groups.set(id.providerId,g);select.appendChild(g);}
      const opt=document.createElement('option');opt.value=String(available.length);available.push(id);const summary=modelCapabilitySummary(m).text;
      opt.textContent=(m.name||id.modelId)+(summary?' · '+summary:' · 能力未确认');groups.get(id.providerId).appendChild(opt);
    });
    add.disabled=!select.options.length || config.chain.length>=20;
    select.disabled=!select.options.length;
    validation.textContent=error();validation.classList.toggle('over',!!error());onChange(!error());
  }
  enabled.onchange=draw;add.onclick=()=>{const id=available[Number(select.value)];if(id && !sameModel(id,primary()) && !config.chain.some(m=>sameModel(id,m)))config.chain.push(id);draw();};
  draw();
  return {element:box,refresh:draw,valid:()=>!error(),value:()=>({enabled:enabled.checked,chain:config.chain.map(id=>({...id}))}),
    reset(value){config=normalizeFallbackConfig(value);enabled.checked=config.enabled;draw();},onChange(fn){onChange=fn;draw();}};
}
