import { confirmModal } from './ui/modal.js';

export function createSystemStorageControl({ desktop, call, current, sizeText }) {
  let state = null, busy = false;
  const feedback = document.createElement('p'); feedback.className = 'system-status';
  feedback.id = 'system-storage-feedback'; feedback.setAttribute('role', 'status');
  const change = document.createElement('button'); change.className = 'btn'; change.type = 'button'; change.textContent = '更改路径…'; change.disabled = true;
  change.setAttribute('aria-describedby', feedback.id);
  const say = (text, error) => { feedback.textContent = text; feedback.classList.toggle('is-error', Boolean(error)); };
  const paint = () => { change.disabled = !desktop || !state?.canMigrate || busy; };
  change.onclick = async () => {
    if (change.disabled) return;
    busy = true; paint(); say('请选择空文件夹；仅预检，不会移动或删除数据。');
    try {
      const preview = await call('pickDataDirectory');
      if (!current()) return;
      if (!preview.ok) { say(preview.code === 'cancelled' ? '已取消选择，数据目录未更改。' : preview.error || '预检失败，未迁移任何数据。', preview.code !== 'cancelled'); return; }
      if (!preview.ticket || !preview.summary || document.getElementById('confirmLayer')?.hidden === false) {
        say('请先处理当前确认，再重新预检迁移。'); return;
      }
      const summary = preview.summary;
      let result;
      await confirmModal({ title: '迁移数据并重启？', okText: '迁移并重启',
        message: `将 ${summary.files} 个文件（${sizeText(summary.bytes)}）复制到 ${summary.targetDirectory}。将检查全部任务和写入；忙碌时拒绝，不会强行中断。复制后逐文件校验，再切换目录。原目录保留为备份，不会自动删除。Pi、用户项目、Electron 资料及固定设置不迁移。`,
        onDecide: async decision => {
          if (decision === true && current()) result = await call('migrateData', preview.ticket);
          return true;
        }, submittingText: '正在检查并准备重启…' });
      if (!current() || !result) return;
      if (result.ok && result.restartPending) say('迁移意图已保存。正在安全重启；下次启动将先复制校验，再启动新目录。');
      else say(result.error || '未能确认迁移已准备就绪；数据目录未切换，请重试。', true);
      if (result.state) state = result.state;
    } finally { if (current()) { busy = false; paint(); if (document.activeElement === document.body && !change.disabled) change.focus(); } }
  };
  return { change, feedback, adopt(value) {
    state = value; paint();
    const text = state?.source === 'environment' ? '由 PI_GUI_DATA 指定，不能在此覆盖。'
      : state?.error || (state?.backupDirectory ? `原目录备份保留在 ${state.backupDirectory}。不会自动删除。` : '') || state?.note
      || (desktop ? '当前环境不支持安全迁移。' : '仅桌面版可迁移数据目录。');
    say(text, Boolean(state?.error));
  } };
}

const BUCKETS = {
  'default-session-http-cache': '主窗口 HTTP 磁盘缓存', 'default-session-code-cache': '主窗口编译代码缓存',
  'browser-memory-http-cache': '内置浏览器 HTTP 内存缓存', 'runtime-memory-http-cache': 'Runtime 浏览器 HTTP 内存缓存',
};
export function createCacheBreakdown(sizeText) {
  const detail = document.createElement('div'); detail.className = 'system-cache-breakdown';
  function update(result) {
    detail.replaceChildren();
    if (!Array.isArray(result?.buckets)) return;
    for (const bucket of result.buckets) {
      const row = document.createElement('p'); row.className = 'system-status';
      row.textContent = `${BUCKETS[bucket.id] || '缓存桶'}：${bucket.status === 'excluded' ? '未纳入（无法安全独立验证）' : sizeText(bucket.bytes)}`;
      detail.append(row);
    }
    const note = document.createElement('p'); note.className = 'system-status';
    note.textContent = 'GPU 缓存及 MCP Registry 未纳入：没有已连接且可证明安全的独立清理接口。Cookie、登录状态、历史和恢复文件不清理。';
    detail.append(note);
  }
  return { detail, update };
}
