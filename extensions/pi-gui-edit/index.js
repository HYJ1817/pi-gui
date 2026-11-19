/* GUI 内部扩展：在**同一个 Pi 原生会话文件**内移动 active leaf。
 *
 * 为什么需要它：Pi 1.5.2 的 RPC 没有 navigate 命令，而 `fork` / `new_session`
 * 会创建新的 session 文件 —— 那正是“编辑并重新发送”禁止的降级。官方公开的
 * `ctx.navigateTree(targetId)`（TUI 的 `/tree` 也用它）只改当前 session 的
 * leaf，不新建文件，因此由 GUI 在启动时注入本扩展，只注册一条随机命名的
 * 内部命令。命令名与 token 都由后端每次启动生成并通过环境变量传入，避免与
 * 用户扩展冲突，也让其它入口无法只凭命令名调用内部导航。
 *
 * 执行前重新核对：会话身份、当前 leaf、目标节点与父节点、空闲状态。后端在
 * 发命令前已经查过一次；这里再查一次，专门关闭“后端最后一次检查”和“扩展
 * 真正执行”之间的竞态。任何一项不匹配都拒绝导航。
 *
 * 失败回滚：`navigateTree(userEntry)` 会把 leaf 设为该消息的父节点。如果原
 * leaf 本身就是一条用户消息（例如上一轮失败/中断后停在那里），直接回滚会
 * 丢掉它。所以导航前先追加一个不参与模型上下文的 custom guard entry，把
 * old leaf 变成普通节点；失败时后端导航回 guard 即可精确恢复原路径。
 * guard 只含随机 requestId，不含消息正文、路径或凭据。
 */
const GUARD_TYPE = 'pi-gui-edit-guard';

function splitArgs(args) {
  const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
  return parts.length === 6 ? parts : null;
}

function nullableId(value) {
  return value === '-' ? null : value;
}

export default function messageEditExtension(pi) {
  const name = process.env.PI_GUI_EDIT_COMMAND;
  const token = process.env.PI_GUI_EDIT_TOKEN;
  if (typeof name !== 'string' || !name) return;

  pi.registerCommand(name, {
    description: 'Internal: move the active branch for message edit.',
    handler: async (args, ctx) => {
      const parsed = splitArgs(args);
      if (!parsed) throw new Error('invalid_edit_request');
      const [targetId, expectedLeaf, expectedParent, expectedSession, requestId, suppliedToken] = parsed;
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(targetId)
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(expectedSession)
        || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)
        || !/^[A-Za-z0-9-]{8,128}$/.test(suppliedToken)
        || !/^[A-Za-z0-9-]{8,128}$/.test(String(token || ''))
        || suppliedToken !== token) {
        throw new Error('invalid_edit_request');
      }
      const expectedLeafId = nullableId(expectedLeaf);
      const expectedParentId = nullableId(expectedParent);
      if ((expectedLeafId !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(expectedLeafId))
        || (expectedParentId !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(expectedParentId))) {
        throw new Error('invalid_edit_request');
      }
      if (typeof ctx.navigateTree !== 'function') throw new Error('navigate_unavailable');
      if (ctx.isIdle && !ctx.isIdle()) throw new Error('session_busy');

      const manager = ctx.sessionManager;
      if (!manager || typeof manager.getSessionId !== 'function' || typeof manager.getLeafId !== 'function') {
        throw new Error('session_identity_unavailable');
      }
      if (manager.getSessionId() !== expectedSession) throw new Error('stale_edit_session');
      if ((manager.getLeafId() ?? null) !== expectedLeafId) throw new Error('stale_edit_leaf');

      const target = manager.getEntry(targetId);
      if (!target) throw new Error('target_not_found');
      if ((target.parentId ?? null) !== expectedParentId) throw new Error('stale_edit_target');

      const oldLeafId = manager.getLeafId();
      if (oldLeafId) {
        const oldLeaf = manager.getEntry(oldLeafId);
        /* 这两类目标在 navigateTree 里都会被解析成“父节点”：用户消息与
         * custom_message。若它们恰好就是 old leaf，直接回滚会把它丢掉，
         * 所以先追加 guard，把 old leaf 变成普通节点。 */
        if (oldLeaf && (oldLeaf.type === 'custom_message'
          || oldLeaf.type === 'message' && oldLeaf.message?.role === 'user')) {
          if (typeof pi.appendEntry !== 'function') throw new Error('restore_unavailable');
          pi.appendEntry(GUARD_TYPE, { requestId });
          if (manager.getLeafId() === oldLeafId) throw new Error('restore_unavailable');
        }
      }

      await ctx.navigateTree(targetId, { summarize: false });
    },
  });
}
