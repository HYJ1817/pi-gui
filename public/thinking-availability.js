/* Shared Classic/Runtime projection. Callers own native read correlation and
 * invalidate evidence on model/Owner/generation changes. A supplied levels
 * array means a successful current native read unless readStatus says otherwise.
 * Static capability stays three-valued; this never writes it or invents levels. */
import { modelIdentity, modelCapability } from './model-capabilities.js';

export function thinkingAvailability({ model = null, levels = [], pending = false, readStatus = 'success' } = {}) {
  // Keep native tokens exact: trimming/stripping would authorize a different
  // value than Pi returned. Accept future named levels without a preset table.
  const list = Array.isArray(levels)
    ? [...new Set(levels.filter(level => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level)))] : [];
  const result = (state, label, detail, options = list) => ({ state, levels: options, usable: [], label, detail });
  if (pending || readStatus === 'pending') return result('pending', '思考同步中…', '正在读取当前模型支持的思考等级');
  const identity = modelIdentity(model);
  if (!identity.providerId || !identity.modelId) return result('no-model', '思考不可用', '还没有读到当前模型', []);
  if (readStatus === 'error') return result('read-failed', '思考等级读取失败', '未能读取当前模型的思考等级，请刷新重试', []);
  if (readStatus === 'stale') return result('stale', '思考等级已过期', '当前模型的思考等级需要重新读取', []);
  if (readStatus === 'invalid') return result('invalid', '思考等级数据无效', 'Pi 未提供有效的思考等级列表', []);
  if (readStatus !== 'success') return result('unconfirmed', '思考等级尚未确认', '尚未成功读取当前模型的思考等级', []);
  if (!Array.isArray(levels) || levels.length && !list.length) return result('invalid', '思考等级数据无效', 'Pi 未提供有效的思考等级列表', []);
  const usable = list.filter(level => level !== 'off');
  if (usable.length) return { state: 'ready', levels: list, usable, label: '', detail: '' };
  const reasoning = modelCapability(model).capabilities.reasoning;
  if (!list.length && reasoning === false) return result('unsupported', '此模型不支持推理', '当前模型的能力里明确写了不支持推理');
  if (!list.length && reasoning === null) return result('unknown', '推理能力未知', '没有拿到这个模型的推理能力证据，按未知处理');
  return result('unavailable', 'Pi 未提供可选思考等级', list.length
    ? 'Pi 仅提供 off，没有可调节的思考强度' : '当前模型报告支持推理，但 Pi 没有给出可选的档位');
}
