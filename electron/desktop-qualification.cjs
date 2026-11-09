'use strict';
/* 桌面安全资格判定（FIX-04）。
 *
 * 原文密钥输入只在「本实例直属后端 + 正常沙箱 + 无可附加调试器」时开放。
 * 判定保持保守白名单思路：只要出现已知的调试、无沙箱或降隔离启动方式，
 * 一律返回原因码并关闭资格；不确定的环境不放开。
 *
 * reason 码（前端 electron/provider-credential 与 public/provider-management/credentials.js
 * 使用固定安全文案）：backend_unavailable / debug_port / debug_pipe / debug_inspector /
 * sandbox_disabled / single_process / web_security_disabled / no_sandbox / desktop_unqualified。
 */

const DEBUG_SWITCHES = Object.freeze([
  ['remote-debugging-port', 'debug_port'],
  ['no-sandbox', 'no_sandbox'],
  ['remote-debugging-pipe', 'debug_pipe'],
  ['inspect', 'debug_inspector'],
  ['inspect-brk', 'debug_inspector'],
  ['single-process', 'single_process'],
  ['disable-web-security', 'web_security_disabled'],
]);

function flagPresent(argv, name) {
  return (Array.isArray(argv) ? argv : []).some(argument => {
    const text = String(argument || '');
    return text === `--${name}` || text.startsWith(`--${name}=`);
  });
}

function desktopQualification({ argv = [], execArgv = [], hasSwitch = () => false, env = {}, backendConnected = false } = {}) {
  if (backendConnected !== true) return { ok: false, reason: 'backend_unavailable' };
  const strings = [...(Array.isArray(argv) ? argv : []), ...(Array.isArray(execArgv) ? execArgv : [])].map(String);
  for (const [name, reason] of DEBUG_SWITCHES) {
    if (flagPresent(strings, name)) return { ok: false, reason };
    try { if (hasSwitch(name) === true) return { ok: false, reason }; } catch { /* fail closed below */ }
  }
  const disabled = env && env.ELECTRON_DISABLE_SANDBOX;
  if (typeof disabled === 'string' ? disabled !== '' : Boolean(disabled)) return { ok: false, reason: 'sandbox_disabled' };
  const nodeOptions = typeof env?.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS : '';
  if (/--inspect(?:-brk)?(?:\s|=|$)/.test(nodeOptions)) return { ok: false, reason: 'debug_inspector' };
  return { ok: true, reason: null };
}

module.exports = { desktopQualification, DEBUG_SWITCHES };
