/* 新建 / 编辑技能：同一份 SKILL.md 的两种写法。
 *
 *   表单    只改 description 与正文；frontmatter 里其它键（license、allowed-tools…）
 *           由服务端按行保留，界面上只提示还有哪些键。
 *   源文件  整份文本替换；用于 frontmatter 的写法表单读不懂的情况。
 *
 * 两种写法都先调 `/api/skills/check` 做不落盘校验，错误就禁用保存；
 * 保存时带 baseHash，文件在编辑期间被别的程序改过会 409，不会覆盖那次修改。
 * 校验与保存的迟到响应都有序号守卫，关掉弹窗后不会再改任何节点。 */

import { checkSkill, createSkill, fetchSkillSource, saveSkill } from '../api.js';
import { createIcon } from '../ui/icons.js';
import { openModal } from '../ui/modal.js';
import { createSegmentedControl } from '../ui/primitives.js';
import { resourceEl as el, resourceNote as note } from '../ui/resource-dom.js';
import { formatSkillBytes, skillTargetLabel, skillWritableTargets } from './model.js';

const CHECK_DEBOUNCE_MS = 350;

/** UTF-8 字节数（jsdom 里没有 TextEncoder）。 */
function utf8Bytes(value) {
  try {
    return encodeURIComponent(String(value)).replace(/%[0-9A-F]{2}/g, 'x').length;
  } catch {
    return String(value).length;
  }
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}

function field(labelText, control, { hint = '', extra = null } = {}) {
  const wrap = el('label', 'skills-field');
  const head = el('span', 'skills-field-head');
  head.append(el('span', 'skills-field-label', labelText));
  if (hint) head.append(el('span', 'skills-field-hint', hint));
  if (extra) head.append(extra);
  wrap.append(head, control);
  return wrap;
}

function dialogButton(label, className, iconName) {
  const button = el('button', 'btn' + (className ? ' ' + className : ''));
  button.type = 'button';
  if (iconName) button.append(createIcon(iconName, { size: 14 }));
  button.append(el('span', '', label));
  return button;
}

/**
 * @param options.mode    'create' | 'edit'
 * @param options.skill   编辑时的技能行（含 id / name / manage）
 * @param options.project 当前项目上下文（?project=）
 * @param options.data    当前列表数据（写入目标、limits）
 * @param options.onSaved 保存成功后的回调，收到服务端结果
 */
export function openSkillEditor({ mode = 'edit', skill = null, project = 'none', data = null, onSaved = () => {} } = {}) {
  const creating = mode === 'create';
  let closeModal = null;
  let closed = false;
  let disposed = false;
  let checkToken = 0;
  let loadToken = 0;
  let saveToken = 0;
  let source = null; // 编辑模式读到 { content, hash, form, ... }
  let modeTab = creating ? 'form' : 'form';
  let saving = false;
  let touched = false;
  let lastCheck = null;

  const targets = skillWritableTargets(data);
  let targetKey = (creating ? targets[0]?.key : skill?.manage?.target) || targets[0]?.key || '';
  if (!creating && skill?.manage?.target && targets.every((item) => item.key !== skill.manage.target)) {
    targetKey = skill.manage.target;
  }

  openModal((card, close) => {
    closeModal = close;
    card.classList.add('skills-dialog', 'skills-editor-dialog');
    card.setAttribute('aria-label', creating ? '新建技能' : '编辑技能');

    const head = el('header', 'skills-dialog-head');
    const titleBox = el('div', 'skills-dialog-heading');
    const glyph = el('span', 'skills-dialog-glyph');
    glyph.append(createIcon(creating ? 'plus' : 'edit', { size: 15 }));
    const titles = el('div', 'skills-dialog-titles');
    const title = el('h3', 'skills-dialog-title', creating ? '新建技能' : '编辑技能');
    title.id = 'skillsEditorTitle';
    card.setAttribute('aria-labelledby', title.id);
    const subtitle = el('p', 'skills-dialog-sub');
    titles.append(title, subtitle);
    titleBox.append(glyph, titles);
    head.append(titleBox);
    card.append(head);

    const body = el('div', 'skills-dialog-body');
    const footer = el('div', 'skills-dialog-foot');

    /* ---------- 表单 / 源文件 ---------- */
    const tabs = createSegmentedControl({
      ariaLabel: '编辑方式',
      value: modeTab,
      options: creating
        ? [{ value: 'form', label: '表单' }]
        : [{ value: 'form', label: '表单' }, { value: 'raw', label: '源文件' }],
      onChange: (value) => { modeTab = value; syncPanel(); scheduleCheck(0); },
    });
    const tabsRow = el('div', 'skills-editor-tabs');
    tabsRow.append(tabs.element);

    const formPanel = el('div', 'skills-editor-panel');
    const rawPanel = el('div', 'skills-editor-panel');
    rawPanel.hidden = true;

    /* 名称（新建时是目录名，也写进 frontmatter） */
    let nameInput = null;
    if (creating) {
      nameInput = el('input', 'ds-input skills-input');
      nameInput.type = 'text';
      nameInput.autocomplete = 'off';
      nameInput.spellcheck = false;
      nameInput.placeholder = '例如 pdf-tools';
      nameInput.setAttribute('aria-label', '技能名称');
      const nameHint = el('span', 'skills-counter');
      const nameField = field('名称', nameInput, { hint: '小写字母、数字和连字符，也是目录名', extra: nameHint });
      nameField.classList.add('skills-field-name');
      formPanel.append(nameField);
    }

    const description = el('textarea', 'ds-input skills-textarea');
    description.rows = 3;
    description.placeholder = 'pi 靠这句话判断什么时候使用这个技能';
    description.setAttribute('aria-label', '描述');
    const descCounter = el('span', 'skills-counter');
    const descField = field('描述', description, { hint: '一行，会写进 frontmatter 的 description', extra: descCounter });
    formPanel.append(descField);

    const text = el('textarea', 'ds-input skills-textarea skills-textarea-body');
    /* 8 行 + CSS 的 min-height 让「保存到」在 820 高的窗口里也留在首屏；
     * 再长的正文由输入框自己滚动，弹层不用整体滚动。 */
    text.rows = 8;
    text.placeholder = '技能正文（Markdown）。写清楚步骤、边界和例子。';
    text.setAttribute('aria-label', '正文');
    const bodyCounter = el('span', 'skills-counter');
    const bodyField = field('正文', text, { hint: 'Markdown，保存在 frontmatter 之后', extra: bodyCounter });
    formPanel.append(bodyField);

    const extraKeys = el('p', 'skills-editor-note');
    extraKeys.hidden = true;
    formPanel.append(extraKeys);

    /* 新建时给一份「将要写入的文件」预览；它来自服务端校验返回的合成结果。 */
    const previewWrap = el('details', 'skills-editor-preview');
    if (creating) {
      previewWrap.open = false;
      const summary = el('summary', 'skills-editor-preview-summary', '预览将要写入的 SKILL.md');
      const pre = el('pre', 'ext-code skills-editor-preview-code', '');
      previewWrap.append(summary, pre);
      formPanel.append(previewWrap);
    }

    const rawTa = el('textarea', 'ds-input skills-textarea skills-textarea-raw');
    rawTa.rows = 20;
    rawTa.spellcheck = false;
    rawTa.setAttribute('aria-label', 'SKILL.md 源文件');
    rawPanel.append(field('SKILL.md', rawTa, { hint: '整份文件，包含 frontmatter' }));

    const formUnavailable = note('', 'dim');
    formUnavailable.hidden = true;
    formPanel.prepend(formUnavailable);

    /* ---------- 目标位置 ---------- */
    let targetSelect = null;
    if (creating) {
      targetSelect = el('select', 'ds-select skills-select');
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
      targetSelect.value = targetKey;
      targetSelect.onchange = () => {
        targetKey = targetSelect.value;
        renderTargetNotice();
        scheduleCheck(0);
      };
      const targetField = field('保存到', targetSelect, { hint: '全局技能对所有项目可用；项目技能只属于当前项目' });
      formPanel.append(targetField);
    }
    const targetNotice = note('', 'dim');
    targetNotice.hidden = true;
    formPanel.append(targetNotice);
    function renderTargetNotice() {
      const hit = targets.find((item) => item.key === targetKey);
      targetNotice.textContent = hit && hit.notice ? hit.notice : '';
      targetNotice.hidden = !targetNotice.textContent;
    }

    /* ---------- 校验反馈 ---------- */
    const feedback = el('div', 'skills-editor-feedback');
    feedback.setAttribute('aria-live', 'polite');
    formPanel.append(feedback);
    rawPanel.append(feedback.cloneNode(false));
    const rawFeedback = rawPanel.lastChild;

    const footerStatus = el('span', 'skills-dialog-status');
    footerStatus.setAttribute('aria-live', 'polite');
    const reload = dialogButton('重新载入', 'ghost', 'refresh');
    reload.hidden = true;
    const cancel = dialogButton('取消', 'ghost');
    const submit = dialogButton(creating ? '创建' : '保存', 'primary', null);
    cancel.onclick = () => close();
    footer.append(footerStatus, reload, cancel, submit);

    if (creating) {
      body.append(tabsRow, formPanel);
    } else {
      body.append(tabsRow, formPanel, rawPanel);
      /* 预览只在新建时有意义（服务端 `check` 合成将要写入的整份文件）。
       * 编辑时不要挂一个空 <details>：浏览器会给它一个本地化的默认标题「详情」。 */
      formPanel.append(extraKeys);
    }
    // 创建时 formPanel 已包含全部字段；表单顺序：名称 → 描述 → 正文 → 目标 → 提示
    if (creating) {
      // 目标字段在描述/正文之后才创建，移动到正文之后、提示之前
      const targetFieldNode = targetSelect?.closest('.skills-field');
      if (targetFieldNode) formPanel.insertBefore(targetFieldNode, targetNotice);
      formPanel.append(extraKeys);
    }

    card.append(body, footer);
    syncPanel();
    renderTargetNotice();
    updateCounters();

    /* ---------- 读取（编辑） ---------- */
    if (creating) {
      subtitle.textContent = targets.length ? '保存到一个可写的技能目录。' : '当前没有可写的技能目录。';
      submit.disabled = !targets.length;
      if (nameInput) nameInput.focus();
    } else {
      subtitle.textContent = skill?.manage?.reason || '修改 SKILL.md 的 frontmatter 与正文。';
      setBusy(true, '正在读取…');
      void loadSource();
    }

    function loadSource() {
      const token = ++loadToken;
      setBusy(true, '正在读取…');
      return fetchSkillSource(skill.id, project).then((result) => {
        if (disposed || token !== loadToken) return;
        if (!result || result.ok === false) {
          setBusy(false);
          loadError((result && result.error) || '读不到这个技能的文件');
          return;
        }
        source = result;
        description.value = result.form?.available ? result.form.description : '';
        text.value = result.form?.available ? result.form.body : '';
        rawTa.value = result.content || '';
        if (result.form && !result.form.available) {
          formUnavailable.hidden = false;
          formUnavailable.textContent = `表单不可用：${result.form.reason}。请改用「源文件」。`;
          modeTab = 'raw';
          tabs.setValue('raw');
        } else {
          formUnavailable.hidden = true;
          modeTab = 'form';
          tabs.setValue('form');
        }
        if (result.form?.extraKeys?.length) {
          extraKeys.hidden = false;
          extraKeys.textContent = `frontmatter 里还有这些键，保存表单时原样保留：${result.form.extraKeys.join('、')}`;
        } else {
          extraKeys.hidden = true;
        }
        subtitle.textContent = `${skill.name} · ${result.targetLabel} · ${formatSkillBytes(result.bytes)}`;
        setBusy(false);
        syncPanel();
        updateCounters();
        scheduleCheck(0);
        (modeTab === 'raw' ? rawTa : (nameInput || description)).focus();
      }, () => {
        if (disposed || token !== loadToken) return;
        setBusy(false);
        loadError('读不到这个技能的文件（网络中断）');
      });
    }

    function loadError(message) {
      feedback.replaceChildren(note(message, 'warn'));
      rawFeedback.replaceChildren(note(message, 'warn'));
      submit.disabled = true;
      reload.hidden = false;
      reload.onclick = () => { reload.hidden = true; void loadSource(); };
    }

    /* ---------- 模式切换 ---------- */
    const rawFeedbackSync = () => {
      // 两个面板的实时反馈保持一致，切标签不会看到上一次的旧提示
      if (!feedback.childNodes.length) rawFeedback.replaceChildren();
      else rawFeedback.replaceChildren(...[...feedback.childNodes].map((node) => node.cloneNode(true)));
    };
    function syncPanel() {
      const raw = modeTab === 'raw';
      formPanel.hidden = raw;
      rawPanel.hidden = !raw;
      tabs.setOptionDisabled('form', false);
      updateCounters();
    }

    /* ---------- 计数器 ---------- */
    function updateCounters() {
      const byteCount = utf8Bytes(text.value);
      bodyCounter.textContent = `${text.value.length} 字符 · 正文约 ${formatSkillBytes(byteCount)}`;
      descCounter.textContent = `${description.value.length} 字符`;
      if (nameInput) {
        const nameCounter = nameInput.closest('.skills-field')?.querySelector('.skills-counter');
        if (nameCounter) nameCounter.textContent = nameInput.value ? `${nameInput.value.length}/64` : '';
      }
    }

    /* ---------- 校验 ---------- */
    const scheduleCheck = debounce((delay = CHECK_DEBOUNCE_MS) => { void runCheck(); }, CHECK_DEBOUNCE_MS);
    function payloadOf() {
      if (creating) {
        return {
          kind: 'create',
          name: nameInput ? nameInput.value.trim() : '',
          description: description.value,
          body: text.value,
          target: targetKey,
        };
      }
      if (modeTab === 'raw') return { kind: 'raw', id: skill.id, content: rawTa.value };
      return { kind: 'form', id: skill.id, description: description.value, body: text.value };
    }

    async function runCheck() {
      if (disposed || saving) return;
      if (!creating && !source) return;
      const token = ++checkToken;
      const payload = payloadOf();
      const result = await checkSkill(project, payload);
      if (disposed || token !== checkToken) return;
      if (!result || result.ok === false) {
        lastCheck = null;
        renderFeedback([], [], result && result.error ? [result.error] : ['校验请求失败']);
        return;
      }
      lastCheck = result;
      const errors = result.errors || [];
      const warnings = result.warnings || [];
      renderFeedback(errors, warnings, []);
      if (creating && result.content) {
        const pre = previewWrap.querySelector('pre');
        if (pre) pre.textContent = result.content;
      }
      if (creating) {
        // 服务端返回的 content 就是将要写入的完整文件；摘要行给一个行数
        const summary = previewWrap.querySelector('summary');
        if (summary) summary.textContent = `预览将要写入的 SKILL.md（${(result.content || '').split('\n').length} 行）`;
      }
    }

    function renderFeedback(errors, warnings, generic) {
      const target = modeTab === 'raw' ? rawFeedback : feedback;
      target.replaceChildren();
      if (generic.length) {
        for (const message of generic) target.append(note(message, 'warn'));
      }
      for (const error of errors) target.append(note(error.message, 'err'));
      for (const warning of warnings) target.append(note(warning.message, 'warn'));
      setFieldInvalid('description', errors.some((entry) => entry.field === 'description'));
      setFieldInvalid('body', errors.some((entry) => entry.field === 'body'));
      setFieldInvalid('name', errors.some((entry) => entry.field === 'name'));
      setFieldInvalid('content', errors.some((entry) => entry.field === 'content'));
      if (target === feedback) rawFeedbackSync();
      else feedback.replaceChildren(...[...rawFeedback.childNodes].map((node) => node.cloneNode(true)));
      const blocked = errors.length > 0 || generic.length > 0;
      if (!saving) submit.disabled = blocked || (!creating && !source) || (creating && !targets.length);
    }

    function setFieldInvalid(fieldName, invalid) {
      const control = fieldName === 'name' ? nameInput
        : fieldName === 'description' ? description
          : fieldName === 'body' ? text
            : fieldName === 'content' ? rawTa : null;
      if (!control) return;
      if (invalid) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    }

    function setBusy(busy, message = '') {
      if (busy) {
        submit.disabled = true;
        card.setAttribute('aria-busy', 'true');
        footerStatus.textContent = message;
      } else {
        card.removeAttribute('aria-busy');
        footerStatus.textContent = '';
        if (!saving) submit.disabled = false;
      }
    }

    /* ---------- 保存 ---------- */
    submit.onclick = async () => {
      if (saving || disposed) return;
      touched = true;
      if (!lastCheck) {
        await runCheck();
        if (!lastCheck) return;
      }
      if ((lastCheck.errors || []).length) {
        (modeTab === 'raw' ? rawTa : (nameInput || description)).focus();
        return;
      }
      saving = true;
      const token = ++saveToken;
      submit.setAttribute('aria-busy', 'true');
      submit.disabled = true;
      footerStatus.textContent = creating ? '正在创建…' : '正在保存…';
      const payload = payloadOf();
      let result;
      if (creating) {
        result = await createSkill(project, {
          name: payload.name,
          description: payload.description,
          body: payload.body,
          target: targetKey,
        });
      } else if (modeTab === 'raw') {
        result = await saveSkill(skill.id, project, { mode: 'raw', content: rawTa.value, baseHash: source.hash });
      } else {
        result = await saveSkill(skill.id, project, {
          mode: 'form', description: description.value, body: text.value, baseHash: source.hash,
        });
      }
      if (disposed || token !== saveToken) return;
      saving = false;
      submit.removeAttribute('aria-busy');
      submit.disabled = false;
      footerStatus.textContent = '';
      if (!result || result.ok === false) {
        const errors = result && Array.isArray(result.errors) ? result.errors : [];
        if (errors.length) renderFeedback(errors, result.warnings || [], []);
        else renderFeedback([], [], [result && result.error ? result.error : '保存失败']);
        if (result && (result.code === 'changed-on-disk' || result.code === 'form-unavailable')) {
          reload.hidden = false;
          reload.onclick = () => { reload.hidden = true; void loadSource(); };
        }
        if (result && result.code === 'changed-on-disk') {
          footerStatus.textContent = '文件在编辑期间被改过，没有覆盖。';
        }
        return;
      }
      onSaved(result, { mode: creating ? 'create' : modeTab });
      close();
    };

    /* ---------- 输入与生命周期 ---------- */
    const onInput = () => {
      touched = true;
      lastCheck = null;
      updateCounters();
      scheduleCheck();
    };
    for (const control of [description, text, rawTa, ...(nameInput ? [nameInput] : [])]) {
      control.addEventListener('input', onInput);
    }
    // 表单里的内容变了，切到源文件时以服务端返回的完整文本为准；这里不本地合成，避免两份真相
    tabs.element.addEventListener('click', () => { if (touched) scheduleCheck(); });

    return;
  }, () => {
    closed = true;
    disposed = true;
    checkToken += 1;
    loadToken += 1;
    saveToken += 1;
  });

  return {
    close: () => { if (closeModal) closeModal(); },
    get closed() { return closed; },
  };
}
