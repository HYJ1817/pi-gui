'use strict';
/* CredentialSheet 的固定本地输入面（P2）。
 *
 * 这个文件是**打包资源**：build-app.mjs 会把 electron/ 下的 .cjs 原样复制进应用，
 * 桌面控制器（provider-credentials.cjs）经 `pi-gui-credential://` 自定义协议把这三份
 * 固定文本装进独立非持久化 session。页面因此：
 *   - 完全离线：不 fetch、不加载远端资源；该 session 不持有后端令牌。
 *   - 无秘密回显：preload 只给目标摘要与状态，永不回传已提交的值；
 *     密码框 value 只活在用户输入期间，应用/取消即销毁。
 *   - 布局与主题：跟主窗口同一套 --ds-* tokens 的语义（深/浅两套、窄窗单列），
 *     但这里内嵌一份最小子集，避免依赖主页面样式表。
 *
 * 页面逻辑刻意很小：填值 → apply（submit）→ 由专属 preload 转发给主进程。
 * 没有任何网络、导航、剪贴板读取或 window.open。
 */

const CSP = [
  "default-src 'none'",
  /* 脚本与样式经一次性 nonce 精确放行（不支持外链文件的 hash 漂移，
   * 也不靠 scheme source——部分 Chromium 版本对 custom scheme source
   * 与外链子资源的组合会拒载）。 */
  "script-src 'nonce-__CSP_NONCE__'",
  "style-src 'nonce-__CSP_NONCE__'",
  "img-src pi-gui-credential: data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const html = `<!doctype html>
<html data-theme="dark">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>Pi GUI 凭据输入</title>
<style nonce="__CSP_NONCE__">
__SHEET_CSS__
</style>
</head>
<body>
<main class="sheet" aria-labelledby="sheet-title">
  <h1 id="sheet-title">输入 API 密钥</h1>
  <p class="target-label">凭据将用于以下服务目标</p>
  <p class="target" id="sheet-target">—</p>
  <div class="oauth-warn hidden" id="oauth-warn" role="alert">
    该服务当前保存的是 OAuth 登录凭据。应用新密钥会<strong>替换</strong>它，
    且旧 OAuth 登录无法从 GUI 恢复，需要重新登录。
  </div>
  <label class="key-label" for="sheet-key">API 密钥</label>
  <input id="sheet-key" type="password" autocomplete="off" spellcheck="false"
         aria-describedby="key-hint" placeholder="粘贴密钥；应用后立即关闭">
  <p class="hint" id="key-hint">密钥只在本次输入期间存在于本窗口，应用后进入待保存状态；旧密钥不会回显。</p>
  <label class="check"><input type="checkbox" id="allow-discovery">
    允许向此目标发送密钥以自动读取模型列表（只读模型目录，不调用推理）</label>
  <label class="check"><input type="checkbox" id="remember-target">
    记住此目标，下次打开时自动重新确认</label>
  <p class="status" id="sheet-status" role="status"></p>
  <div class="actions">
    <button type="button" class="secondary" id="sheet-cancel">取消</button>
    <button type="button" class="primary" id="sheet-apply">应用到草稿</button>
  </div>
</main>
<script nonce="__CSP_NONCE__">
__SHEET_JS__
</script>
</body>
</html>
`;

const css = `:root {
  --sheet-bg: #141519; --sheet-panel: #1d1f24; --sheet-field: #101114;
  --sheet-ink: #e8eaed; --sheet-muted: #9aa0a6; --sheet-line: #34373d;
  --sheet-primary: #f2f4f7; --sheet-primary-ink: #101114;
  --sheet-warn-bg: #3a2d18; --sheet-warn-ink: #f5c66b; --sheet-danger: #e58080;
}
:root[data-theme="light"] {
  --sheet-bg: #f4f5f7; --sheet-panel: #ffffff; --sheet-field: #eceef1;
  --sheet-ink: #1c1e21; --sheet-muted: #5f6368; --sheet-line: #d5d8dd;
  --sheet-primary: #1c1e21; --sheet-primary-ink: #ffffff;
  --sheet-warn-bg: #fdf3df; --sheet-warn-ink: #7a5410; --sheet-danger: #a33333;
}
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  background: var(--sheet-bg); color: var(--sheet-ink);
  font: 13px/1.5 "Segoe UI", system-ui, sans-serif;
  display: flex; align-items: stretch; justify-content: stretch;
}
.sheet {
  flex: 1; display: flex; flex-direction: column; gap: 8px;
  padding: 20px; background: var(--sheet-panel);
  margin: 12px; border-radius: 12px; border: 1px solid var(--sheet-line);
  min-width: 0; overflow-y: auto;
}
h1 { font-size: 15px; font-weight: 600; letter-spacing: .2px; }
.target-label { color: var(--sheet-muted); font-size: 12px; }
.target {
  font-family: ui-monospace, Consolas, monospace; font-size: 12px;
  background: var(--sheet-field); border: 1px solid var(--sheet-line);
  border-radius: 8px; padding: 8px 10px; word-break: break-all;
}
.oauth-warn {
  background: var(--sheet-warn-bg); color: var(--sheet-warn-ink);
  border-radius: 8px; padding: 8px 10px; font-size: 12px;
}
.hidden { display: none; }
.key-label { font-size: 12px; color: var(--sheet-muted); }
input[type="password"] {
  width: 100%; background: var(--sheet-field); color: var(--sheet-ink);
  border: 1px solid var(--sheet-line); border-radius: 8px;
  padding: 9px 10px; font-size: 13px; outline: none;
}
input[type="password"]:focus { border-color: var(--sheet-ink); }
.hint { color: var(--sheet-muted); font-size: 11px; }
.check {
  display: flex; gap: 8px; align-items: flex-start;
  font-size: 12px; color: var(--sheet-ink);
}
.check input { margin-top: 2px; accent-color: var(--sheet-ink); }
.status { min-height: 16px; font-size: 12px; color: var(--sheet-muted); }
.status.error { color: var(--sheet-danger); }
.actions {
  margin-top: auto; display: flex; gap: 10px; justify-content: flex-end;
  padding-top: 8px;
}
button {
  border-radius: 8px; padding: 8px 16px; font-size: 13px;
  border: 1px solid var(--sheet-line); background: transparent;
  color: var(--sheet-ink); cursor: pointer; min-height: 32px;
}
button.primary {
  background: var(--sheet-primary); color: var(--sheet-primary-ink);
  border-color: var(--sheet-primary); font-weight: 600;
}
button:disabled { opacity: .55; cursor: default; }
@media (max-width: 420px) {
  .sheet { margin: 6px; padding: 14px; }
  .actions { flex-direction: column-reverse; }
  .actions button { width: 100%; }
}
`;

const js = `'use strict';
/* 固定输入面脚本。唯一的出口是专属 preload 的具名动作；
 * Esc=取消、Enter=应用，应用/取消后窗口由主进程销毁，DOM 随之销毁。 */
const state = window.piGuiCredentialSheet.initial;
document.documentElement.dataset.theme = state.theme;
const targetEl = document.getElementById('sheet-target');
const showTarget = () => { if (state.targetSummary) targetEl.textContent = document.getElementById('oauth-warn') ? state.targetSummary : state.targetSummary; };
showTarget();
window.addEventListener('pi-gui-credential-target', showTarget);
if (state.oauthConflict) document.getElementById('oauth-warn').classList.remove('hidden');
const key = document.getElementById('sheet-key');
const allow = document.getElementById('allow-discovery');
const remember = document.getElementById('remember-target');
const status = document.getElementById('sheet-status');
const apply = document.getElementById('sheet-apply');
const cancel = document.getElementById('sheet-cancel');
function note(text, isError) {
  status.textContent = text || '';
  status.classList.toggle('error', isError === true);
}
function busy(flag) {
  apply.disabled = flag === true; cancel.disabled = flag === true; key.disabled = flag === true;
}
key.focus();
apply.addEventListener('click', async () => {
  const value = key.value;
  if (!value) { note('请输入密钥，或选择取消。', true); return; }
  busy(true); note('正在校验并暂存…');
  const result = await window.piGuiCredentialSheet.submit({
    input: value, allowDiscovery: allow.checked, rememberTarget: remember.checked,
  });
  if (result && result.ok === true) { key.value = ''; note('已应用到草稿。'); return; }
  const text = result && result.code === 'oauth_conflict'
    ? '该服务当前是 OAuth 登录。请阅读上方提示，仍要替换请再次点击「应用到草稿」。'
    : result && result.code === 'expired' ? '暂存已过期，请重新输入。'
    : result && result.code === 'credential_conflict' ? '凭据或草稿状态已变化，请关闭后重试。'
    : '操作失败，请重试或取消。';
  busy(false); note(text, true);
  key.focus();
});
cancel.addEventListener('click', () => window.piGuiCredentialSheet.cancel());
window.piGuiCredentialSheet.onState(stateUpdate => {
  if (stateUpdate && stateUpdate.state === 'closed') { key.value = ''; return; }
  if (stateUpdate && stateUpdate.message) note(stateUpdate.message, stateUpdate.error === true);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); window.piGuiCredentialSheet.cancel(); }
  if (event.key === 'Enter' && document.activeElement !== allow && document.activeElement !== remember) {
    event.preventDefault(); apply.click();
  }
});
`;

/* 一次性 nonce：进程内随机生成，HTML/CSP/样式/脚本统一替换；每次打开窗口
 * 相同（同一进程的固定文档），跨进程不同。CSP 不放外链文件，样式与脚本
 * 直接内联在带 nonce 的标签里。 */
const { randomBytes } = require('node:crypto');
const nonce = randomBytes(16).toString('base64');
const fill = text => String(text).split('__CSP_NONCE__').join(nonce);
/* 模板字面量里的 css/js 占位符在这里才组装，避免提前求值未初始化的常量。 */
const assembled = html.replace('__SHEET_CSS__', () => css).replace('__SHEET_JS__', () => js);

module.exports = { credentialSheetPage: { html: fill(assembled), css: fill(css), js: fill(js), csp: fill(CSP) } };
