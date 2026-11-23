/* 「写到哪里」的共享选择器：导入、新建、市场安装共用一个控件与选项文案。
 *
 * 选项来自服务端给出的 writable targets，value 仍是原来的 target key；
 * 选中只更新调用方的 targetKey，不在这里做任何写入或改名。
 * 没有可写位置时保留原有占位选项「没有可写的位置」，提交按钮仍由调用方禁用。
 */

import { createPicker } from '../ui/picker.js';

export function targetPickerOptions(targets) {
  const options = (Array.isArray(targets) ? targets : []).map((target) => ({
    value: target.key,
    label: `${target.scope === 'project' ? '项目' : '全局'} · ${target.label}`,
  }));
  if (!options.length) options.push({ value: '', label: '没有可写的位置' });
  return options;
}

/**
 * @param {object} options
 * @param {Array}  options.targets    skillWritableTargets(data)
 * @param {string} options.value      current target key
 * @param {string} options.label      accessible name（保存位置 / 安装到）
 * @param {string} options.field      dataset.field on the trigger
 * @param {(value: string) => void} options.onChange
 */
export function createTargetPicker({ targets, value = '', label = '保存位置', field = '', onChange = () => {} } = {}) {
  return createPicker({
    value,
    options: targetPickerOptions(targets),
    label,
    fallbackLabel: '没有可写的位置',
    align: 'start',
    field,
    className: 'skills-picker',
    triggerClassName: 'skills-picker-trigger',
    menuClassName: 'skills-picker-menu',
    onSelect: (next) => { onChange(next); },
  });
}
