/* 技能行展开后的详情：事实行、复制路径、只读 SKILL.md 与同目录文件。
 *
 * 名称 / 描述 / 状态已经在行上，这里不再重复。SKILL.md 是异步读的：
 * 由调用方给出 `isLive()`（是否仍是当前展开项、仍属当前工作区、页面未关闭），
 * 迟到的结果一律丢弃，不会写进已经换掉的详情。 */

import { fetchSkillDetail } from '../api.js';
import { copyButton } from '../ui/capability-setup.js';
import { resourceEl as el, resourceRow as row, resourceNote as note } from '../ui/resource-dom.js';
import { skillLoadedText } from './model.js';

function factRows(skill) {
  const rows = el('div', 'ext-rows');
  rows.append(
    row('路径', skill.path || '（未定位）'),
    row('发现来源', skill.rootLabel),
    row('作用域基准', skill.baseDir),
    row('pi 是否加载', skillLoadedText(skill)),
  );
  if (skill.rel) rows.append(row('停用模式', skill.disablePattern));
  if (skill.settingsPath) rows.append(row('设置写入', skill.settingsPath));
  if (skill.license) rows.append(row('许可证', skill.license));
  if (skill.compatibility) rows.append(row('兼容性', skill.compatibility));
  return rows;
}

/** 只在「不能写」时解释原因；能写的技能用行上的开关。 */
function actions(skill) {
  const acts = el('div', 'ext-acts');
  if (!skill.toggleable) {
    acts.append(note(skill.scope === 'temporary'
      ? '这个 Skill 是通过命令行 --skill 临时加载的，没有可写的 settings 条目。'
      : '这个 Skill 没有可写入的 settings 文件，无法在这里启停。', 'dim'));
  }
  acts.append(copyButton(skill.path || skill.name, '复制路径'));
  return acts;
}

function fileChips(files) {
  const box = el('div', 'ext-files');
  for (const file of files) {
    const chip = el('span', 'ext-file', file.dir ? file.name + '/' : file.name);
    chip.title = file.size === null || file.size === undefined ? '' : `${file.size} 字节`;
    box.append(chip);
  }
  return box;
}

export function renderSkillDetail(host, skill, isLive) {
  host.replaceChildren();
  if (skill.stateNote) host.append(note(skill.stateNote, skill.state === 'enabled' ? 'dim' : 'warn'));
  for (const error of skill.errors || []) host.append(note(error.message, error.level === 'error' ? 'warn' : 'dim'));
  host.append(factRows(skill), actions(skill));

  const head = el('div', 'ext-sec-head');
  head.append(el('span', '', 'SKILL.md（只读）'));
  const pre = el('pre', 'ext-code', '读取中…');
  host.append(head, pre);

  void fetchSkillDetail(skill.id).then((detail) => {
    if (!isLive()) return;
    if (!detail || detail.ok === false) {
      pre.textContent = (detail && detail.error) || '读不到详情';
      return;
    }
    if (detail.note) host.insertBefore(note(detail.note, 'dim'), head);
    pre.textContent = detail.content || '（空文件）';
    if (detail.truncated) host.append(note(`文件较大，只显示前 ${Math.round((detail.content || '').length / 1024)}KB`, 'dim'));
    if ((detail.files || []).length) host.append(el('div', 'ext-sec-head', '同一目录下的文件'), fileChips(detail.files));
  }, () => {
    if (isLive()) pre.textContent = '读不到详情';
  });
}
