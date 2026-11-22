/* 从其他 Agent 工具扫描技能。
 *
 * 只扫服务端确认过的位置（Claude Code 的用户 / 项目目录、Codex 的用户目录）；
 * 扫描本身只读，导入是把读到的内容复制进 pi 的技能目录，原目录不会被改动。
 * 候选 ID 是服务端按目录算的哈希，前端只把 ID 带回去，传不了路径。
 *
 * 「已有同名（内容相同）」「已有同名（内容不同）」「已链接」逐项标出来，
 * 避免用户把同一份技能导入两遍。 */

import { importExternalSkills, scanExternalSkills } from '../api.js';
import { createIcon } from '../ui/icons.js';
import { openModal } from '../ui/modal.js';
import { createBadge } from '../ui/primitives.js';
import { resourceEl as el, resourceNote as note } from '../ui/resource-dom.js';
import { externalPresentMeta, formatSkillBytes, skillDefaultTarget, skillWritableTargets } from './model.js';

const MAX_BATCH = 64;

function button(label, className, iconName) {
  const node = el('button', 'btn' + (className ? ' ' + className : ''));
  node.type = 'button';
  if (iconName) node.append(createIcon(iconName, { size: 14 }));
  node.append(el('span', '', label));
  return node;
}

function selectField(labelText, select, hint = '') {
  const wrap = el('label', 'skills-field');
  const head = el('span', 'skills-field-head');
  head.append(el('span', 'skills-field-label', labelText));
  if (hint) head.append(el('span', 'skills-field-hint', hint));
  wrap.append(head, select);
  return wrap;
}

/**
 * @param options.project    项目上下文（?project=）
 * @param options.data       当前列表数据（写入目标）
 * @param options.onImported 导入完成后的回调（含 undo / restartRequired / results）
 */
export function openSkillExternal({ project = 'none', data = null, onImported = () => {} } = {}) {
  let closeModal = null;
  let disposed = false;
  let token = 0;
  let scan = null;
  let busy = false;
  let imported = null;
  const selected = new Set();
  const targets = skillWritableTargets(data);
  let targetKey = skillDefaultTarget(data, '');
  let conflict = 'skip';

  openModal((card, close) => {
    closeModal = close;
    card.classList.add('skills-dialog', 'skills-external-dialog');
    card.setAttribute('aria-label', '从其他工具扫描技能');

    const head = el('header', 'skills-dialog-head');
    const heading = el('div', 'skills-dialog-heading');
    const glyph = el('span', 'skills-dialog-glyph');
    glyph.append(createIcon('scan', { size: 15 }));
    const titles = el('div', 'skills-dialog-titles');
    const title = el('h3', 'skills-dialog-title', '从其他工具扫描');
    const subtitle = el('p', 'skills-dialog-sub', '只读取 Claude Code 与 Codex 的技能目录；导入只复制，不改动原目录。');
    titles.append(title, subtitle);
    heading.append(glyph, titles);
    head.append(heading);
    card.append(head);

    const body = el('div', 'skills-dialog-body');
    const footer = el('div', 'skills-dialog-foot');
    const status = el('div', 'skills-dialog-status');
    status.setAttribute('aria-live', 'polite');
    const sourcesBox = el('div', 'skills-external-sources');
    const listBox = el('div', 'skills-external-list');
    const resultBox = el('div', 'skills-external-results');
    resultBox.hidden = true;
    const controls = el('div', 'skills-external-controls');
    body.append(status, sourcesBox, listBox, resultBox, controls);

    const refresh = button('重新扫描', 'ghost', 'refresh');
    refresh.onclick = () => { void load(); };
    const closeButton = button('关闭', 'ghost');
    closeButton.onclick = () => close();
    const importButton = button('导入所选', 'primary', null);
    importButton.disabled = true;
    footer.append(refresh, closeButton, importButton);

    const targetSelect = el('select', 'ds-select skills-select');
    targetSelect.setAttribute('aria-label', '导入到');
    for (const target of targets) {
      const option = el('option', '', `${target.scope === 'project' ? '项目' : '全局'} · ${target.label}`);
      option.value = target.key;
      targetSelect.append(option);
    }
    if (!targets.length) {
      const option = el('option', '', '没有可写的位置');
      option.value = '';
      targetSelect.append(option);
    }
    targetSelect.value = targetKey;
    targetSelect.onchange = () => { targetKey = targetSelect.value; };
    const conflictSelect = el('select', 'ds-select skills-select');
    conflictSelect.setAttribute('aria-label', '同名技能怎么处理');
    for (const [value, label] of [['skip', '跳过同名'], ['replace', '覆盖已有的'], ['rename', '保留两者（自动改名）']]) {
      const option = el('option', '', label);
      option.value = value;
      conflictSelect.append(option);
    }
    conflictSelect.onchange = () => { conflict = conflictSelect.value; };
    const selectionInfo = el('span', 'skills-external-selection');
    const selectAll = el('input', 'skills-checkbox');
    selectAll.type = 'checkbox';
    selectAll.setAttribute('aria-label', '选择所有可导入的技能');
    selectAll.onchange = () => {
      selected.clear();
      if (selectAll.checked) {
        for (const candidate of scan?.candidates || []) if (candidate.importable) selected.add(candidate.id);
      }
      renderList();
    };
    const selectAllLabel = el('label', 'skills-external-selectall');
    selectAllLabel.append(selectAll, el('span', '', '全选可导入'));
    controls.append(
      selectAllLabel,
      selectionInfo,
      selectField('导入到', targetSelect),
      selectField('同名时', conflictSelect),
    );
    card.append(body, footer);

    function setStatus(message, tone = '') {
      status.replaceChildren();
      if (message) status.append(note(message, tone));
    }

    function setBusy(value) {
      busy = value;
      card.toggleAttribute('aria-busy', value);
      refresh.disabled = value;
      importButton.disabled = value || selected.size === 0 || !targets.length || Boolean(imported);
      selectAll.disabled = value;
    }

    async function load() {
      const current = ++token;
      imported = null;
      resultBox.hidden = true;
      resultBox.replaceChildren();
      selected.clear();
      setStatus('正在扫描…');
      setBusy(true);
      const result = await scanExternalSkills(project);
      if (disposed || current !== token) return;
      setBusy(false);
      if (!result || result.ok === false) {
        scan = null;
        sourcesBox.replaceChildren();
        listBox.replaceChildren(note((result && result.error) || '扫描失败，请重试', 'err'));
        setStatus('');
        return;
      }
      scan = result;
      setStatus(targets.length ? '' : '当前没有可写的位置，只能查看扫描结果。', targets.length ? '' : 'err');
      renderSources();
      renderList();
    }

    function renderSources() {
      sourcesBox.replaceChildren();
      for (const source of scan.sources || []) {
        const item = el('div', 'skills-external-source');
        const lead = el('div', 'skills-external-source-lead');
        lead.append(el('span', 'skills-external-source-tool', source.tool));
        lead.append(el('span', 'skills-external-source-dir', source.label));
        const meta = el('span', 'skills-external-source-meta');
        meta.textContent = source.exists ? `${source.count} 个${source.truncated ? '（已截断）' : ''}` : '目录不存在';
        item.append(lead, meta);
        if (source.error) item.append(note(source.error, 'warn'));
        sourcesBox.append(item);
      }
    }

    function renderList() {
      listBox.replaceChildren();
      const candidates = scan?.candidates || [];
      if (!candidates.length) {
        listBox.append(note('这些目录里没有发现技能。', 'dim'));
        updateSelection();
        return;
      }
      const groups = new Map();
      for (const candidate of candidates) {
        if (!groups.has(candidate.sourceId)) groups.set(candidate.sourceId, []);
        groups.get(candidate.sourceId).push(candidate);
      }
      for (const [sourceId, items] of groups) {
        const source = (scan.sources || []).find((entry) => entry.id === sourceId);
        const section = el('section', 'skills-external-group');
        const headRow = el('header', 'skills-external-group-head');
        headRow.append(el('h4', 'skills-external-group-title', source ? `${source.tool} · ${source.label}` : sourceId));
        headRow.append(el('span', 'skills-external-group-count', String(items.length)));
        const rows = el('div', 'skills-external-rows');
        for (const candidate of items) rows.append(renderCandidate(candidate));
        section.append(headRow, rows);
        listBox.append(section);
      }
      updateSelection();
    }

    function renderCandidate(candidate) {
      const row = el('div', 'skills-external-row' + (candidate.importable ? '' : ' is-blocked'));
      const check = el('input', 'skills-checkbox');
      check.type = 'checkbox';
      check.checked = selected.has(candidate.id);
      check.disabled = !candidate.importable || busy || Boolean(imported);
      check.setAttribute('aria-label', `选择 ${candidate.name}`);
      check.onchange = () => {
        if (check.checked) selected.add(candidate.id);
        else selected.delete(candidate.id);
        updateSelection();
      };
      const main = el('div', 'skills-external-main');
      const titleLine = el('div', 'skills-external-title');
      titleLine.append(el('span', 'skills-external-name', candidate.name));
      const present = externalPresentMeta(candidate.present);
      titleLine.append(createBadge({ text: present.label, tone: present.tone }));
      if (!candidate.importable) titleLine.append(createBadge({ text: '不可导入', tone: 'warning' }));
      main.append(titleLine);
      if (candidate.description) main.append(el('p', 'skills-external-desc', candidate.description));
      if (candidate.reason) main.append(note(candidate.reason, candidate.importable ? 'dim' : 'warn'));
      for (const problem of candidate.problems || []) {
        main.append(note(problem.message, problem.level === 'error' ? 'err' : 'warn'));
      }
      const side = el('div', 'skills-external-side');
      if (Number.isFinite(candidate.bytes)) side.append(el('span', 'skills-external-size', formatSkillBytes(candidate.bytes)));
      if (candidate.suggestedName && candidate.suggestedName !== candidate.name) {
        side.append(el('span', 'skills-external-slug', `将导入为 ${candidate.suggestedName}`));
      }
      row.append(check, main, side);
      return row;
    }

    function updateSelection() {
      selectAll.checked = Boolean(scan?.candidates?.length)
        && (scan.candidates.filter((candidate) => candidate.importable).length > 0)
        && scan.candidates.filter((candidate) => candidate.importable).every((candidate) => selected.has(candidate.id));
      selectionInfo.textContent = selected.size ? `已选 ${selected.size} 个` : '还没有选择';
      importButton.disabled = busy || selected.size === 0 || !targets.length || Boolean(imported) || selected.size > MAX_BATCH;
      if (selected.size > MAX_BATCH) selectionInfo.textContent = `一次最多导入 ${MAX_BATCH} 个（已选 ${selected.size} 个）`;
    }

    importButton.onclick = async () => {
      if (busy || !selected.size || !targets.length) return;
      if (selected.size > MAX_BATCH) { setStatus(`一次最多导入 ${MAX_BATCH} 个技能`, 'err'); return; }
      const current = ++token;
      setBusy(true);
      setStatus('正在导入…');
      const result = await importExternalSkills(project, { ids: [...selected], target: targetKey, onConflict: conflict });
      if (disposed || current !== token) return;
      setBusy(false);
      if (!result || result.ok === false) {
        setStatus((result && result.error) || '导入失败', 'err');
        return;
      }
      imported = result;
      setStatus('');
      renderResults(result);
      for (const control of listBox.querySelectorAll('input')) control.disabled = true;
      importButton.textContent = '完成';
      importButton.onclick = () => close();
      importButton.disabled = false;
      onImported(result);
      importButton.focus();
    };

    function renderResults(result) {
      resultBox.hidden = false;
      resultBox.replaceChildren();
      const summary = el('p', 'skills-external-result-summary',
        `已导入 ${result.imported} 个，跳过 ${result.skipped} 个，失败 ${result.failed} 个 · 保存到 ${result.targetLabel || ''}`);
      resultBox.append(summary);
      for (const item of result.results || []) {
        const row = el('div', 'skills-external-result is-' + item.status);
        row.append(el('span', 'skills-external-result-name', item.name || item.id));
        row.append(el('span', 'skills-external-result-state', item.status === 'imported' ? '已导入' : item.status === 'skipped' ? '已跳过' : '失败'));
        if (item.error) row.append(el('span', 'skills-external-result-error', item.error));
        resultBox.append(row);
      }
      if (result.restartRequired) resultBox.append(note('pi 正在运行，重启后才会加载新导入的全局技能。', 'warn'));
      if (result.undo) resultBox.append(note('这次导入可以撤销；关闭后页面会给出撤销入口。', 'dim'));
    }

    renderTargetNote();
    function renderTargetNote() {
      /* 从项目分组点进来但项目不可写时，说明原因，而不是默默换成全局。 */
      const preset = (data?.targets || []).find((target) => target.key === targetKey && target.writable === false);
      if (preset) setStatus(preset.blockedReason || '这个位置不可写', 'warn');
    }

    setBusy(true);
    void load();
  }, () => {
    disposed = true;
    token += 1;
  });

  return { close: () => { if (closeModal) closeModal(); } };
}
