/* 从本机导入技能：单个 .md，或整个技能目录（连同脚本、参考资料）。
 *
 * 两步，与后端一致：
 *   1. 选中文件 → 上传暂存 → 服务端完整校验 → 显示「将要导入什么」；
 *   2. 用户确认名称、位置与同名策略 → 凭暂存令牌落盘。
 * 暂存不落盘；第二步落下的字节就是第一步看过的那一份。
 *
 * 这里只读用户选中的文件、只发 pi-GUI 自己的 /api/skills/import 请求；
 * 不碰别的工具目录，也不按路径安装。 */

import { commitSkillImport, stageSkillImport } from '../api.js';
import { createIcon } from '../ui/icons.js';
import { openModal } from '../ui/modal.js';
import { resourceEl as el, resourceNote as note } from '../ui/resource-dom.js';
import { formatSkillBytes, skillDefaultTarget, skillWritableTargets } from './model.js';

const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

function field(labelText, control, hint = '') {
  const wrap = el('label', 'skills-field');
  const head = el('span', 'skills-field-head');
  head.append(el('span', 'skills-field-label', labelText));
  if (hint) head.append(el('span', 'skills-field-hint', hint));
  wrap.append(head, control);
  return wrap;
}

function button(label, className, iconName) {
  const node = el('button', 'btn' + (className ? ' ' + className : ''));
  node.type = 'button';
  if (iconName) node.append(createIcon(iconName, { size: 14 }));
  node.append(el('span', '', label));
  return node;
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read-failed'));
    reader.onload = () => {
      const text = String(reader.result || '');
      const comma = text.indexOf(',');
      resolve(comma === -1 ? '' : text.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** 选中的文件与目录都按「相对所选目录」的路径整理；隐藏文件与 node_modules 不进上传。 */
function collectEntries(fileList, kind) {
  const all = Array.from(fileList || []);
  if (!all.length) return { error: '没有选到文件' };
  if (kind === 'file') {
    if (all.length !== 1) return { error: '一次只能导入一个文件' };
    const file = all[0];
    if (!/\.md$/i.test(file.name)) return { error: '请选择一个 .md 文件（通常是 SKILL.md）' };
    return { entries: [{ file, path: file.name }], dirName: '', bytes: file.size, skipped: [] };
  }
  const dirName = (all[0].webkitRelativePath || '').split('/')[0] || '';
  const skipped = [];
  const entries = [];
  let bytes = 0;
  let sawSkillMd = false;
  for (const file of all) {
    const relative = String(file.webkitRelativePath || file.name).split('/').slice(1).join('/');
    if (!relative) continue;
    const segments = relative.split('/');
    if (segments.some((segment) => segment.startsWith('.')) || segments.includes('node_modules')) {
      skipped.push(relative);
      continue;
    }
    if (relative === 'SKILL.md') sawSkillMd = true;
    bytes += file.size;
    entries.push({ file, path: relative });
  }
  if (!sawSkillMd) return { error: '所选目录的顶层没有 SKILL.md，这不是一个技能目录' };
  return { entries, dirName, bytes, skipped };
}

function precheck(entries, bytes) {
  if (!entries.length) return '没有可导入的文件';
  if (entries.length > MAX_FILES) return `文件太多（上限 ${MAX_FILES} 个）`;
  for (const entry of entries) {
    if (entry.file.size > MAX_FILE_BYTES) return `${entry.path} 超过单个文件 2 MB 的上限`;
  }
  if (bytes > MAX_TOTAL_BYTES) return '技能超过 12 MB 的总大小上限';
  return '';
}

/**
 * @param options.project    项目上下文（?project=）
 * @param options.data       当前列表数据（写入目标）
 * @param options.targetPreset 从哪个分组点进来的默认目标（user-pi / project-pi 等）
 * @param options.onImported 安装成功后的回调（含 undo / restartRequired / warnings）
 */
export function openSkillImport({ project = 'none', data = null, targetPreset = '', onImported = () => {} } = {}) {
  let closeModal = null;
  let disposed = false;
  let busyToken = 0;
  let plan = null;
  let staged = null;
  let skippedByClient = [];
  const targets = skillWritableTargets(data);
  let targetKey = targets.some((target) => target.key === targetPreset)
    ? targetPreset
    : skillDefaultTarget(data, '');
  let conflict = 'fail';

  openModal((card, close) => {
    closeModal = close;
    card.classList.add('skills-dialog', 'skills-import-dialog');
    card.setAttribute('aria-label', '导入技能');

    const head = el('header', 'skills-dialog-head');
    const heading = el('div', 'skills-dialog-heading');
    const glyph = el('span', 'skills-dialog-glyph');
    glyph.append(createIcon('arrowDown', { size: 15 }));
    const titles = el('div', 'skills-dialog-titles');
    const title = el('h3', 'skills-dialog-title', '导入技能');
    const subtitle = el('p', 'skills-dialog-sub', '选择一个 SKILL.md，或整个技能目录；附属脚本与资源会一起导入。');
    titles.append(title, subtitle);
    heading.append(glyph, titles);
    head.append(heading);
    card.append(head);

    const body = el('div', 'skills-dialog-body');
    const footer = el('div', 'skills-dialog-foot');

    /* ---------- 选择 ---------- */
    const picker = el('div', 'skills-import-picker');
    const fileInput = el('input', 'skills-file-input');
    fileInput.type = 'file';
    fileInput.accept = '.md,text/markdown';
    fileInput.hidden = true;
    fileInput.setAttribute('aria-label', '选择单个 SKILL.md');
    const dirInput = el('input', 'skills-file-input');
    dirInput.type = 'file';
    dirInput.multiple = true;
    dirInput.hidden = true;
    dirInput.setAttribute('webkitdirectory', '');
    dirInput.setAttribute('directory', '');
    dirInput.setAttribute('aria-label', '选择技能目录');
    const pickFile = button('选择文件', 'tiny', 'fileText');
    const pickDir = button('选择目录', 'tiny', 'folder');
    pickFile.onclick = () => fileInput.click();
    pickDir.onclick = () => dirInput.click();
    const pickNote = el('span', 'skills-import-pick-note', '隐藏文件与 node_modules 会自动跳过');
    picker.append(pickFile, pickDir, pickNote, fileInput, dirInput);
    body.append(picker);

    const status = el('div', 'skills-dialog-status skills-import-status');
    status.setAttribute('aria-live', 'polite');
    body.append(status);

    /* ---------- 计划 ---------- */
    const planBox = el('div', 'skills-import-plan');
    planBox.hidden = true;
    const planSummary = el('div', 'skills-import-summary');
    const nameInput = el('input', 'ds-input skills-input');
    nameInput.type = 'text';
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.setAttribute('aria-label', '导入后的名称');
    const nameField = field('名称', nameInput, '小写字母、数字和连字符，也是目录名');
    planBox.append(planSummary, nameField);

    const targetSelect = el('select', 'ds-select skills-select');
    targetSelect.setAttribute('aria-label', '保存位置');
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
    targetSelect.value = targetKey || '';
    targetSelect.onchange = () => { targetKey = targetSelect.value; renderTargetNote(); };
    planBox.append(field('保存到', targetSelect));
    const targetNote = note('', 'dim');
    targetNote.hidden = true;
    planBox.append(targetNote);
    function renderTargetNote() {
      const hit = targets.find((target) => target.key === targetKey);
      targetNote.textContent = hit && hit.notice ? hit.notice : '';
      targetNote.hidden = !targetNote.textContent;
    }

    const conflictSelect = el('select', 'ds-select skills-select');
    conflictSelect.setAttribute('aria-label', '同名技能怎么处理');
    for (const [value, label] of [['fail', '不覆盖，提示我'], ['rename', '保留两者（自动改名）'], ['replace', '覆盖已有的']]) {
      const option = el('option', '', label);
      option.value = value;
      conflictSelect.append(option);
    }
    conflictSelect.onchange = () => { conflict = conflictSelect.value; };
    planBox.append(field('同名时', conflictSelect, '同名判断以目标目录里的名字为准'));

    const planFiles = el('div', 'skills-import-files');
    const planNotes = el('div', 'skills-import-notes');
    planBox.append(planFiles, planNotes);
    body.append(planBox);

    const conflictBox = el('div', 'skills-import-conflict');
    conflictBox.hidden = true;
    body.append(conflictBox);

    /* ---------- 底部 ---------- */
    const reset = button('重新选择', 'ghost', 'refresh');
    reset.hidden = true;
    const cancel = button('取消', 'ghost');
    cancel.onclick = () => close();
    const commit = button('导入', 'primary', null);
    commit.disabled = true;
    footer.append(cancel, reset, commit);
    card.append(body, footer);

    function setStatus(message, tone = '') {
      status.replaceChildren();
      if (message) status.append(note(message, tone));
    }

    function setBusy(busy, message = '') {
      if (busy) card.setAttribute('aria-busy', 'true');
      else card.removeAttribute('aria-busy');
      pickFile.disabled = busy;
      pickDir.disabled = busy;
      reset.disabled = busy;
      commit.disabled = busy || !staged;
      cancel.disabled = false;
      if (message) setStatus(message);
    }

    async function stageSelection(kind, fileList) {
      const token = ++busyToken;
      setBusy(true, kind === 'file' ? '正在读取文件…' : '正在读取目录…');
      /* 新选择一开始就作废旧计划：否则新文件校验失败时，界面已经把计划藏起来了，
       * 底部的「导入」却还会拿旧令牌把上一个技能写进去。 */
      staged = null;
      plan = null;
      skippedByClient = [];
      commit.disabled = true;
      planBox.hidden = true;
      conflictBox.hidden = true;
      const collected = collectEntries(fileList, kind);
      if (collected.error) { setBusy(false); setStatus(collected.error, 'err'); return; }
      const bad = precheck(collected.entries, collected.bytes);
      if (bad) { setBusy(false); setStatus(bad, 'err'); return; }
      let files;
      try {
        files = await Promise.all(collected.entries.map(async (entry) => ({
          path: entry.path,
          data: await readBase64(entry.file),
        })));
      } catch {
        if (disposed || token !== busyToken) return;
        setBusy(false);
        setStatus('读取文件失败，请重新选择', 'err');
        return;
      }
      if (disposed || token !== busyToken) return;
      setStatus('正在校验…');
      const result = await stageSkillImport({ kind, dirName: collected.dirName, files });
      if (disposed || token !== busyToken) return;
      if (!result || result.ok === false) {
        setBusy(false);
        setStatus((result && result.error) || '这个文件不能导入', 'err');
        return;
      }
      staged = { stageId: result.stageId };
      skippedByClient = collected.skipped;
      plan = result.plan;
      nameInput.value = plan.suggestedName || '';
      renderPlan();
      setBusy(false, '');
      setStatus('');
      nameInput.focus();
    }

    function renderPlan() {
      planBox.hidden = false;
      reset.hidden = false;
      commit.disabled = !targets.length;
      planSummary.replaceChildren();
      const count = el('span', 'skills-import-count', `${plan.fileCount} 个文件 · ${formatSkillBytes(plan.totalBytes)}`);
      const kindLabel = plan.kind === 'dir' ? '技能目录' : '单个文件';
      planSummary.append(el('span', 'skills-import-kind', kindLabel), count);
      if (plan.declaredName) planSummary.append(el('span', 'skills-import-declared', `frontmatter 名称：${plan.declaredName}`));
      planFiles.replaceChildren();
      const details = el('details', 'skills-import-file-list');
      details.open = plan.fileCount <= 8;
      const summary = el('summary', '', `将写入的文件（${plan.fileCount}）`);
      const list = el('div', 'skills-import-file-rows');
      for (const file of plan.files) {
        const row = el('div', 'skills-import-file');
        row.append(el('span', 'skills-import-file-path', file.path), el('span', 'skills-import-file-size', formatSkillBytes(file.size)));
        list.append(row);
      }
      details.append(summary, list);
      planFiles.append(details);
      planNotes.replaceChildren();
      if (skippedByClient.length) planNotes.append(note(`已跳过 ${skippedByClient.length} 个隐藏文件 / node_modules 条目。`, 'dim'));
      for (const skipped of plan.skipped || []) planNotes.append(note(`跳过 ${skipped.path}：${skipped.note || skipped.reason}`, 'dim'));
      for (const problem of plan.problems || []) planNotes.append(note(problem.message, problem.level === 'error' ? 'err' : 'warn'));
      if (!(plan.problems || []).some((problem) => problem.level === 'error')) {
        planNotes.append(note('pi 会加载它。', 'dim'));
      }
      // 名称/描述摘要帮助确认选对了技能
      if (plan.description) planNotes.prepend(el('p', 'skills-import-desc', plan.description));
    }

    function renderConflict(result) {
      const info = result.conflict || {};
      conflictBox.replaceChildren();
      conflictBox.hidden = false;
      const message = el('p', 'skills-import-conflict-text', (result && result.error) || '目标目录里已经有了同名技能。');
      conflictBox.append(message);
      const actions = el('div', 'skills-import-conflict-actions');
      if (info.suggestion) {
        const keep = button(`保留两者（${info.suggestion}）`, 'tiny');
        keep.onclick = () => { conflict = 'rename'; conflictSelect.value = 'rename'; void submit('rename'); };
        actions.append(keep);
      }
      if (info.replaceable === true) {
        const replace = button('覆盖已有的', 'tiny danger');
        replace.onclick = () => { conflict = 'replace'; conflictSelect.value = 'replace'; void submit('replace'); };
        actions.append(replace);
      }
      const rename = button('换个名字', 'tiny ghost');
      rename.onclick = () => { nameInput.focus(); nameInput.select(); };
      actions.append(rename);
      conflictBox.append(actions);
    }

    async function submit(onConflict = conflict) {
      if (!staged || !plan) return;
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); setStatus('请填写名称', 'err'); return; }
      if (!targetKey) { setStatus('没有可写的位置', 'err'); return; }
      const token = ++busyToken;
      setBusy(true, '正在导入…');
      conflictBox.hidden = true;
      const result = await commitSkillImport(project, {
        stageId: staged.stageId, target: targetKey, name, onConflict,
      });
      if (disposed || token !== busyToken) return;
      setBusy(false, '');
      if (result && result.ok === true) {
        onImported(result);
        close();
        return;
      }
      if (result && result.code === 'exists' && result.conflict) {
        setStatus('');
        renderConflict(result);
        return;
      }
      setStatus((result && result.error) || '导入失败', 'err');
      commit.disabled = false;
    }

    commit.onclick = () => { void submit(); };
    reset.onclick = () => {
      staged = null;
      plan = null;
      skippedByClient = [];
      planBox.hidden = true;
      conflictBox.hidden = true;
      reset.hidden = true;
      commit.disabled = true;
      fileInput.value = '';
      dirInput.value = '';
      setStatus('');
      pickFile.focus();
    };

    fileInput.onchange = () => { if (fileInput.files?.length) void stageSelection('file', fileInput.files); };
    dirInput.onchange = () => { if (dirInput.files?.length) void stageSelection('dir', dirInput.files); };

    renderTargetNote();
    if (!targets.length) {
      setStatus(data?.targets?.length
        ? '当前没有可写的位置；项目级目录被信任状态或链接检查拦住了。'
        : '当前没有可写的位置。', 'err');
    }
    pickFile.focus();
  }, () => { disposed = true; busyToken += 1; });

  return { close: () => { if (closeModal) closeModal(); } };
}
