/* P4-B：错误恢复动作的纯策略层。
 *
 * 只消费服务端已经归一化的结构化失败证据（`generationResult.failure`），
 * 不重新读错误文本、不猜 provider、不发命令、不保存任何 payload。
 *
 * 能显示动作的只有两类，且都必须同时具备受信来源与匹配的结构化状态码：
 *   - `auth_error` + 401/403  → 打开既有的「供应商与认证」设置；
 *   - `model_unavailable` + 404 → 打开既有的模型选择器。
 * 网络、超时、限流、余额、5xx、请求不兼容、上下文超限、未知与取消都没有
 * 经本轮验证的一键恢复路径，一律不显示按钮。权限/审批属于既有审批入口，
 * 同样不在这里处理。
 */
import { safeFallbackFailure } from './model-fallback.js';

export const RECOVERY_ACTIONS = {
  provider_auth: {
    id: 'provider_auth',
    label: '检查供应商认证',
    title: '打开现有的「供应商与认证」设置，检查当前模型的登录或 API Key 状态',
  },
  model_picker: {
    id: 'model_picker',
    label: '选择其他模型',
    title: '打开现有的模型列表，由你选择可用模型；不会自动切换',
  },
};

const BY_CLASS = {
  auth_error: 'provider_auth',
  model_unavailable: 'model_picker',
};

/**
 * 把结构化失败映射成至多一个恢复动作。
 * @param {object} failure 服务端 `safeFallbackFailure` 可验证的失败对象
 * @returns {{id:string,label:string,title:string}|null}
 */
export function recoveryForFailure(failure) {
  const safe = safeFallbackFailure(failure);
  /* 来源不受信时 safe.source 一定是 unknown：不据不可信对象给动作。 */
  if (safe.source === 'unknown') return null;
  const id = BY_CLASS[safe.class];
  if (!id) return null;
  /* 状态码是分类时的真实证据；没有匹配状态码就不把类别当成授权。 */
  if (id === 'provider_auth' && safe.statusCode !== 401 && safe.statusCode !== 403) return null;
  if (id === 'model_picker' && safe.statusCode !== 404) return null;
  return { ...RECOVERY_ACTIONS[id] };
}
