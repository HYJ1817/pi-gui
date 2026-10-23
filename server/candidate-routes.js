import {json,readRawBody} from './http-utils.js';
export const CANDIDATE_MESSAGES=Object.freeze({
  candidate_busy:'已有 Agent、停止、验证或候选流程正在执行，请先完成该操作。',candidate_changed:'文件内容或 Git 身份已变化，请重新预检。',
  candidate_expired:'确认已失效或已经使用，请重新预检。',candidate_comments_changed:'评论已修改或删除，请重新选择并预览。',
  candidate_anchor_changed:'评论位置未由当前完整 Diff 确认，请返回 Diff 核实。',candidate_untracked:'存在未跟踪文件。本阶段不隐式复制这些文件，请先自行整理并重新预检。',
  candidate_git_config:'仓库存在当前无法安全复制的属性、过滤器或特殊 Git 配置。',candidate_sensitive:'输入含可能的凭据文件，已拒绝复制。',
  candidate_unsafe:'路径、链接或文件身份无法确认，已拒绝操作。',candidate_locked:'Git 正在被锁定，请稍后重新预检。',
  candidate_limit:'输入或证据超过容量上限，未截断输入，请减少范围。',candidate_unsupported:'当前 Git 状态或项目子目录暂不支持安全候选执行。',
  candidate_storage_unsafe:'候选材料存储位置或格式不安全，请保留原件并检查。',candidate_storage_busy:'候选写入锁尚未释放，请先确认其他实例和进程已退出，不要强行删除候选。',
  candidate_scope:'当前会话无权查看该候选结果。',candidate_missing:'未找到此候选运行。',candidate_not_running:'候选任务当前没有可停止的执行线。',
  candidate_stop_pending:'停止尚未得到确认，请在候选会话中继续核实。',candidate_unavailable:'候选功能当前不可用，请重新同步。',candidate_invalid:'请求格式不正确。',
});
export function createCandidateRoutes({runs,withAuthority}={}){
  return{async handle(req,res,url){try{
    if(url.search||!['GET','POST'].includes(req.method))throw Error();
    // Resolve authority first, then release its lifecycle lock before nested Worktree operations.
    const scope=await withAuthority(req,s=>s);
    if(req.method==='GET')return json(res,200,runs.list(scope));
    const body=JSON.parse((await readRawBody(req,16384)).toString('utf8'));
    if(!body||Array.isArray(body)||!Object.keys(body).every(k=>['action','selectedIds','revision','scope','nonce','id'].includes(k)))throw Error();
    let result;
    if(body.action==='prepare')result=await runs.prepare(scope,body,JSON.parse(req.headers['x-pi-gui-owner']));
    else if(body.action==='confirm'&&typeof body.nonce==='string')result=await runs.confirm(scope,body.nonce);
    else if(body.action==='cancel'&&typeof body.nonce==='string')result=runs.cancel(scope,body.nonce);
    else if(body.action==='list')result=runs.list(scope);
    else if(body.action==='get'&&typeof body.id==='string')result=runs.get(scope,body.id);
    else if(body.action==='stop'&&typeof body.id==='string')result=await runs.stop(scope,body.id);
    else throw Error();
    return json(res,200,result);
  }catch(e){const code=Object.hasOwn(CANDIDATE_MESSAGES,e?.code)?e.code:'candidate_unavailable';return json(res,409,{ok:false,code,error:CANDIDATE_MESSAGES[code]});}}};
}
