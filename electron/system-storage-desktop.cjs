'use strict';
const REASONS = Object.freeze({
  environment_override: '数据目录由 PI_GUI_DATA 指定，应用不会覆盖外部配置。',
  worktree_or_candidate_present: '存在受控工作树或候选任务，路径与 Git 登记绑定；当前不支持安全迁移。',
  provider_authority_present: '存在供应商路径授权账本，当前不支持安全重定位；未修改任何凭据或授权文件。',
  revert_evidence_present: '存在文件回退证据或原对象恢复依赖，当前不支持安全重定位。',
  unknown_data: '数据目录包含未识别的数据，未略过或删除；请先核对目录内容。',
  unknown_transaction: '发现未确认的写入事务或锁，当前不能迁移。',
  target_not_empty: '请选择已存在的空文件夹，应用不会覆盖或清理目标内容。',
  source_target_overlap: '源目录与目标目录不能相同，也不能互为父子目录。',
  protected_overlap: '目标与项目、Pi、安装目录或其他受保护目录重叠，已拒绝。',
  source_changed: '源数据在预检后发生变化。请等待任务结束后重新选择目录并确认。',
  inventory_changed: '数据在检查期间发生变化，请稍后重新预检。',
  insufficient_space: '目标磁盘可用空间不足。', space_unavailable: '无法确认目标磁盘空间。',
  permission_denied: '目录权限不足，未切换数据目录。',
  ticket_invalid: '预检确认已过期或已使用，请重新选择目录。',
  unsafe_entry: '目录含链接、重解析点、硬链接、附加数据流或其他不安全对象，已拒绝。',
  shutdown_unconfirmed: '未确认旧服务安全退出，未复制或切换数据目录。请重新选择目录并确认。',
  interrupted_staging: '上一次复制被中断，源目录仍保留；请选择另一个空目录重新迁移。',
  start_failed: '新目录已成为权威数据目录，但启动未成功。不会自动回到旧备份，以免分叉。',
  cancelled: '迁移已取消，权威数据目录未切换。',
});
function createSystemStorageDesktop({ storage, dialog, getWindow, maintenance, ownsBackend = () => false } = {}) {
  let selecting = false, disposed = false;
  const describe = code => REASONS[code] || '无法安全迁移，请检查任务状态、目录权限与磁盘空间后重试。';
  function state() {
    const value = storage.state();
    const supported = !disposed && ownsBackend() && value.source !== 'environment';
    return { ...value, supported,
      canMigrate: supported && value.canMigrate && !selecting && !maintenance.busy(),
      error: value.reason ? describe(value.reason) : '',
      note: '仅迁移 pi-GUI 业务数据。Electron 资料、Pi、项目、安装运行时和固定系统设置留在原处；旧目录作为备份保留，不会自动删除。' };
  }
  async function pick() {
    const before = state();
    if (disposed || selecting || !before.canMigrate) return { ok: false, code: 'storage_unavailable', error: before.error || describe(before.source === 'environment' ? 'environment_override' : '') };
    selecting = true;
    try {
      const result = await dialog.showOpenDialog(getWindow(), { title: '选择空文件夹作为数据保存目录',
        buttonLabel: '预检此目录', properties: ['openDirectory', 'dontAddToRecent'] });
      if (disposed || result.canceled || result.filePaths?.length !== 1) return { ok: false, code: 'cancelled' };
      const preview = await storage.preview(result.filePaths[0]);
      return { ...preview, ...(preview.ok ? {} : { error: describe(preview.code) }) };
    } catch { return { ok: false, code: 'storage_preview_failed', error: describe() }; }
    finally { selecting = false; }
  }
  async function migrate(request) {
    if (disposed || selecting || !ownsBackend() || !request || Array.isArray(request)
      || Object.keys(request).length !== 2 || request.confirm !== true || typeof request.ticket !== 'string') {
      return { ok: false, code: 'invalid_storage_request' };
    }
    const { intentId: _intentId, ...result } = await maintenance.restart({ commit: () => storage.commit(request),
      arm: transactionId => storage.arm({ transactionId }),
      cancel: transactionId => storage.cancelPending({ transactionId }) });
    return { ...result, state: state(), ...(result.ok ? {} : { error: result.error || describe(result.code) }) };
  }
  return { state, pick, migrate, dispose() { disposed = true; } };
}
module.exports = { createSystemStorageDesktop, REASONS };
