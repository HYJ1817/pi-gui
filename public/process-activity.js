const LABELS={start:'启动开发进程',status:'查看进程状态',logs:'读取进程日志',stop:'停止开发进程',restart:'重启开发进程'};
const STATES=new Set(['starting','ready','running','exited','failed','stopping']);
export function processActivity(entry){
  const action=String(entry?.name||'').replace(/^gui_process_/,'');
  if(entry?.name!==`gui_process_${action}`||!LABELS[action])return null;
  const d=entry.details&&typeof entry.details==='object'?entry.details:{};
  const status=entry.status==='running'?'running':d.ok===false?'error':entry.status||'error';
  const facts=status==='success'&&d.ok===true&&STATES.has(d.process?.state)?`状态：${d.process.state}`:'';
  return {known:true,status,label:LABELS[action],summary:'',facts,sources:[]};
}
