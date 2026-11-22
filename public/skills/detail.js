/* 技能行展开后的详情：状态说明、事实行、动作，以及只读的 SKILL.md 与同目录文件。
 *
 * 名称 / 描述 / 状态已经在行上，这里不再重复。SKILL.md 是异步读的：
 * 由调用方给出 `isLive()`（是否仍是当前展开项、仍属当前工作区、页面未关闭），
 * 迟到的结果一律丢弃，不会写进已经换掉的详情。
 *
 * 编辑 / 删除按钮只在服务端说「可写 / 可删」时出现；不能写的原因写在原处，
 * 不用一个点不动的按钮假装有这个能力。 */

import { fetchSkillDetail } from '../api.js';
import { copyButton } from '../ui/capability-setup.js';
import { createIcon } from '../ui/icons.js';
import { resourceEl as el, resourceRow as row, resourceNote as note } from '../ui/resource-dom.js';
import { formatSkillBytes, skillLoadedText, skillStateMeta } from './model.js';

function factRows(skill) {
  const rows = el('div', 'ext-rows');
  rows.append(
    row('路径', skill.path || '（未定位）'),
    row('发现来源', skill.rootLabel),
    row('作用域基准', skill.baseDir),
    row('技能状态', skillStateMeta(skill.state).label),
    row('pi 是否加载', skillLoadedText(skill)),
  );
  if (skill.source === 'local') rows.append(row('加载配置', '来自 settings'));
  if (skill.disableModelInvocation) rows.append(row('系统提示词', '不自动加入'));
  if (skill.rel) rows.append(row('停用模式', skill.disablePattern));
  if (skill.settingsPath) rows.append(row('设置写入', skill.settingsPath));
  if (skill.license) rows.append(row('许可证', skill.license));
  if (skill.compatibility) rows.append(row('兼容性', skill.compatibility));
  return rows;
}

/** 可写时的动作；只读时说明原因，并把「复制路径」留给所有技能。 */
function actions(skill, { onEdit, onDelete }) {
  const acts = el('div', 'skill-detail-actions');
  const manage = skill.manage || null;
  if (manage && manage.editable && onEdit) {
    const edit = el('button', 'btn tiny');
    edit.type = 'button';
    edit.append(createIcon('edit', { size: 13 }), el('span', '', '编辑'));
    edit.onclick = () => onEdit(skill);
    acts.append(edit);
  }
  if (manage && manage.deletable && onDelete) {
    const remove = el('button', 'btn tiny danger ghost');
    remove.type = 'button';
    remove.append(createIcon('trash', { size: 13 }), el('span', '', '删除'));
    remove.onclick = () => onDelete(skill);
    acts.append(remove);
  }
  if (skill.path) acts.append(copyButton(skill.path, '复制路径'));
  if (manage && !manage.editable && manage.reason) acts.append(note(manage.reason, 'dim'));
  else if (!manage) acts.append(note('这里没有定位到这个技能在磁盘上的位置，只能查看 pi 报告的元数据。', 'dim'));
  return acts;
}

function fileChips(files) {
  const box = el('div', 'ext-files skill-detail-files');
  for (const file of files) {
    const chip = el('span', 'ext-file', file.dir ? file.name + '/' : file.name);
    chip.title = file.size === null || file.size === undefined ? '' : `${file.size} 字节`;
    box.append(chip);
  }
  return box;
}

/**
 * @param options.isLive    这次读取是否仍然有效（展开项未换、页面未关、工作区未换）
 * @param options.project   当前项目上下文（?project= 原样带回）
 * @param options.onEdit    编辑动作（只有可写时才有按钮）
 * @param options.onDelete  删除动作（只有可删时才有按钮）
 */
export function renderSkillDetail(host, skill, { isLive, project, onEdit, onDelete } = {}) {
  host.replaceChildren();
  /* 停用只写了 settings；运行中的 pi 在重启前仍会加载它。配置状态与运行时状态分开说。 */
  if (skill.state === 'disabled' && skill.loaded === true) {
    host.append(note('配置已停用，但 pi 仍加载着它：重启 pi 之后才会停止加载。', 'warn'));
  }
  if (skill.stateNote) host.append(note(skill.stateNote, skill.state === 'enabled' ? 'dim' : 'warn'));
  for (const error of skill.errors || []) host.append(note(error.message, error.level === 'error' ? 'warn' : 'dim'));

  const columns = el('div', 'skill-detail-columns');
  const facts = el('div', 'skill-detail-facts');
  facts.append(factRows(skill), actions(skill, { onEdit, onDelete }));
  const codeSide = el('div', 'skill-detail-code');
  const head = el('div', 'skill-detail-code-head');
  head.append(el('span', 'skill-detail-code-title', 'SKILL.md'), el('span', 'skill-detail-code-hint', '只读预览'));
  const pre = el('pre', 'ext-code skill-detail-pre', '读取中…');
  pre.setAttribute('aria-busy', 'true');
  codeSide.append(head, pre);
  columns.append(facts, codeSide);
  host.append(columns);

  void fetchSkillDetail(skill.id, project).then((detail) => {
    if (typeof isLive === 'function' && !isLive()) return;
    pre.removeAttribute('aria-busy');
    if (!detail || detail.ok === false) {
      pre.textContent = (detail && detail.error) || '读不到详情';
      return;
    }
    if (detail.note) codeSide.insertBefore(note(detail.note, 'dim'), columns.contains(codeSide) ? codeSide.firstChild : null);
    pre.textContent = detail.content || '（空文件）';
    const size = Number.isFinite(detail.bytes) ? ` · ${formatSkillBytes(detail.bytes)}` : '';
    head.querySelector('.skill-detail-code-hint').textContent = detail.truncated ? `只显示前一部分${size}` : `只读预览${size}`;
    if ((detail.files || []).length) {
      codeSide.append(el('div', 'skill-detail-files-head', '同一目录下的文件'), fileChips(detail.files));
    }
  }, () => {
    if (typeof isLive === 'function' && !isLive()) return;
    pre.removeAttribute('aria-busy');
    pre.textContent = '读不到详情';
  });
}
