/* 交互图表面板（挂载于 Secondary Surface 右栏）。
 *
 * ---------- 功能说明 ----------
 *
 * 1. 外壳复用：使用 openSecondarySurface 与 createPaneHeader，符合 UI4 统一右栏规范。
 * 2. 受控参数交互：
 *    - 图表类型切换（折线图 ↔ 柱状图）
 *    - 数据系列开关（多选 Chip 筛选，至少保留 1 个激活）
 *    - 数据范围调整（滑动条截取最近 N 项）
 *    - 阈值调节（告警参考线与超标标记，安全自适应上下限）
 * 3. 统计摘要精确计算：严格按照当前显示的截取范围（rangeLimit）计算均值、极值与超标数。
 * 4. 引用到对话：复用 fillReviewComposer，将当前图表名、参数与当前可视范围统计摘要追加至草稿。
 * 5. 会话与生命周期隔离：
 *    - 统一 Classic（S.state.sessionId）与 Runtime（gitConversationScope + runtimeStore）身份来源
 *    - 绝不让 S.state.sessionId 覆盖 Runtime 会话
 *    - 原消息删除、历史重建或工作区/会话变更时，严格拒绝引用
 *    - onDispose 释放所有图表与 DOM 资源，防止泄漏
 */

import { S } from './state.js';
import { createPaneHeader } from './right-pane.js';
import { openSecondarySurface } from './ui/secondary-surface.js';
import { renderVizChart, VIZ_COLORS } from './viz-chart.js';
import { fillReviewComposer } from './review-fill.js';
import { toast } from './ui/toast.js';
import { gitConversationScope } from './api.js';
import { workspaceView } from './ui/workspace-surface.js';
import { runtimeStore } from './runtime-state.js';

let activeVizInstance = null;

export function captureSessionScope(sourceElement = null) {
  const view = workspaceView();
  const workspaceGen = S.workspaceGeneration;
  const projectCwd = S.cwd;

  const sourceNode = sourceElement && typeof sourceElement.closest === 'function'
    ? sourceElement.closest('.message, [data-history-message-id], .runtime-conversation')
    : null;

  if (view === 'runtime') {
    const runtimeId = gitConversationScope();
    const record = runtimeId ? runtimeStore.get(runtimeId) : null;
    return {
      view: 'runtime',
      sessionId: runtimeId || null,
      runtimeOwner: record?.owner || null,
      runtimeGeneration: (typeof record?.owner === 'object' ? record?.owner?.runtimeGeneration : record?.generation) ?? null,
      workspaceGeneration: workspaceGen,
      projectCwd,
      sourceNode,
    };
  }

  // Classic view ('chat')
  const classicSessionId = S.state?.sessionId || null;
  return {
    view: 'chat',
    sessionId: classicSessionId,
    runtimeOwner: null,
    runtimeGeneration: null,
    workspaceGeneration: workspaceGen,
    projectCwd,
    sourceNode,
  };
}

export function validateSessionScope(scope) {
  if (!scope) return { ok: false, error: '缺少会话上下文身份。' };

  // 1. 检查源消息节点是否仍挂在 DOM 上
  if (scope.sourceNode && !scope.sourceNode.isConnected) {
    return { ok: false, error: '原图表消息已被清理或删除，无法引用过期图表。' };
  }

  // 2. 检查工作区代数与项目根路径
  if (S.cwd !== scope.projectCwd || S.workspaceGeneration !== scope.workspaceGeneration) {
    return { ok: false, error: '工作区或项目已切换，旧图表配置已失效。' };
  }

  // 3. 检查当前视图
  const curView = workspaceView();
  if (curView !== scope.view) {
    return { ok: false, error: '当前工作区视图与图表所属视图不一致，无法引用。' };
  }

  // 4. Runtime 检查：绝不能用 S.state.sessionId 覆盖
  if (curView === 'runtime') {
    const curId = gitConversationScope();
    if (!curId || curId !== scope.sessionId) {
      return { ok: false, error: '当前并行会话已切换，无法将旧会话图表配置填入当前会话。' };
    }
    const record = runtimeStore.get(curId);
    if (!record?.owner) {
      return { ok: false, error: '当前并行会话 Agent 拥有者已变更或失效，无法引用。' };
    }
    const curOwnerId = typeof record.owner === 'object' ? record.owner.runtimeId : record.owner;
    const expOwnerId = typeof scope.runtimeOwner === 'object' ? scope.runtimeOwner.runtimeId : scope.runtimeOwner;
    if (curOwnerId !== expOwnerId) {
      return { ok: false, error: '当前并行会话 Agent 拥有者已变更或失效，无法引用。' };
    }
    const curGen = (typeof record.owner === 'object' ? record.owner.runtimeGeneration : record.generation) ?? null;
    if (scope.runtimeGeneration !== null && curGen !== scope.runtimeGeneration) {
      return { ok: false, error: '当前会话已重置，无法引用旧图表配置。' };
    }
    return { ok: true };
  }

  // 5. Classic 检查
  const curClassicId = S.state?.sessionId || null;
  if (!curClassicId || curClassicId !== scope.sessionId) {
    return { ok: false, error: '当前会话已切换，无法将旧会话图表配置填入当前会话。' };
  }
  return { ok: true };
}

export function calculateSeriesStats(s, labels, threshold) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let overCount = 0;

  for (let i = 0; i < s.data.length; i++) {
    const v = s.data[i];
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      if (typeof threshold === 'number' && Number.isFinite(threshold) && v > threshold) {
        overCount++;
      }
    }
  }

  if (min === Infinity) { min = 0; max = 0; }
  const avg = s.data.length ? Number((sum / s.data.length).toFixed(1)) : 0;
  return { min, max, avg, overCount, count: s.data.length };
}

export function buildVizSummaryMarkdown(data, state) {
  const lines = [`[图表配置引用：${data.title}]`];
  lines.push(`- 图表类型：${state.type === 'line' ? '折线图' : '柱状图'}`);

  // 严格根据当前 state.rangeLimit 切片计算当前可见数据范围
  const totalLabels = data.labels.length;
  const sliceCount = state.rangeLimit > 0 && state.rangeLimit < totalLabels ? state.rangeLimit : totalLabels;
  const startIndex = totalLabels - sliceCount;
  const visibleLabels = data.labels.slice(startIndex);

  const activeNames = [];
  const statSnippets = [];

  for (const idx of state.activeSeries) {
    const s = data.series[idx];
    if (!s) continue;
    activeNames.push(s.name);
    const visibleData = s.data.slice(startIndex);
    const st = calculateSeriesStats({ ...s, data: visibleData }, visibleLabels, state.threshold);
    const unit = data.unit ? data.unit : '';
    let snip = `${s.name}: 均值 ${st.avg}${unit}, 极值 [${st.min} ~ ${st.max}]${unit}`;
    if (st.overCount > 0) snip += ` (${st.overCount} 处超过阈值)`;
    statSnippets.push(snip);
  }

  lines.push(`- 激活系列：${activeNames.join(', ') || '无'}`);

  // 参数配置
  const paramItems = [];
  if (typeof state.threshold === 'number' && Number.isFinite(state.threshold)) {
    paramItems.push(`告警阈值=${state.threshold}${data.unit ? ' ' + data.unit : ''}`);
  }
  if (state.rangeLimit > 0 && state.rangeLimit < data.labels.length) {
    paramItems.push(`展示范围=最近 ${state.rangeLimit} 项`);
  } else {
    paramItems.push(`展示范围=全部 ${data.labels.length} 项`);
  }
  lines.push(`- 当前参数：${paramItems.join('; ')}`);

  // 统计摘要（严格限制长度）
  lines.push(`- 统计摘要：${statSnippets.join('; ')}`);

  const summary = lines.join('\n');
  return summary.length > 950 ? summary.slice(0, 950) + '…' : summary;
}

/** 打开交互可视化面板。
 *
 * @param {Object} data 经 parseVizData 校验的图表数据对象
 * @param {Object} [context] 会话与消息上下文
 */
export function openVizPanel(data, context = {}) {
  const initialScope = context.scope || captureSessionScope(context.sourceNode || null);

  // 初始参数状态
  const state = {
    type: data.type || 'line',
    activeSeries: new Set(data.series.map((_, i) => i)),
    rangeLimit: data.labels.length > 30 ? 20 : 0,
    threshold: null,
  };

  // 检查是否有预定义的 threshold 参数
  const threshParam = data.params?.find((p) => p.id === 'threshold' || p.id === 'thresh');
  if (threshParam && typeof threshParam.default === 'number') {
    state.threshold = threshParam.default;
  }

  activeVizInstance = openSecondarySurface('viz', (host, instance) => {
    host.classList.add('viz-panel');

    let chartHandle = null;

    // 1. 顶部 Header
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn tiny rp-btn';
    resetBtn.textContent = '重置';
    resetBtn.title = '重置图表与参数配置';

    const quoteBtn = document.createElement('button');
    quoteBtn.type = 'button';
    quoteBtn.className = 'btn tiny rp-btn viz-quote-btn';
    quoteBtn.textContent = '引用到对话';
    quoteBtn.title = '将当前图表参数与摘要填入会话输入框';

    const subtitleText = `${data.series.length} 个数据系列 · ${data.labels.length} 个数据点${data.unit ? ' (' + data.unit + ')' : ''}`;
    const header = createPaneHeader({
      title: data.title,
      subtitle: subtitleText,
      actions: [resetBtn, quoteBtn],
    });
    host.append(header.el);

    // 2. 参数交互控制区
    const controls = document.createElement('section');
    controls.className = 'viz-controls';
    controls.setAttribute('aria-label', '图表参数控制');

    // (1) 图表类型切换按钮组
    const typeGroup = document.createElement('div');
    typeGroup.className = 'viz-ctrl-row viz-type-row';

    const typeLabel = document.createElement('span');
    typeLabel.className = 'viz-ctrl-label';
    typeLabel.textContent = '形态：';

    const btnLine = document.createElement('button');
    btnLine.type = 'button';
    btnLine.className = `btn tiny viz-toggle-btn${state.type === 'line' ? ' is-active' : ''}`;
    btnLine.textContent = '折线图';
    btnLine.setAttribute('aria-pressed', state.type === 'line' ? 'true' : 'false');

    const btnBar = document.createElement('button');
    btnBar.type = 'button';
    btnBar.className = `btn tiny viz-toggle-btn${state.type === 'bar' ? ' is-active' : ''}`;
    btnBar.textContent = '柱状图';
    btnBar.setAttribute('aria-pressed', state.type === 'bar' ? 'true' : 'false');

    typeGroup.append(typeLabel, btnLine, btnBar);
    controls.append(typeGroup);

    // (2) 数据系列显隐切换 Chip
    const seriesGroup = document.createElement('div');
    seriesGroup.className = 'viz-ctrl-row viz-series-row';

    const seriesLabel = document.createElement('span');
    seriesLabel.className = 'viz-ctrl-label';
    seriesLabel.textContent = '系列：';
    seriesGroup.append(seriesLabel);

    const seriesPills = document.createElement('div');
    seriesPills.className = 'viz-series-pills';

    data.series.forEach((s, idx) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `viz-pill${state.activeSeries.has(idx) ? ' is-active' : ''}`;
      pill.setAttribute('aria-pressed', state.activeSeries.has(idx) ? 'true' : 'false');

      const dot = document.createElement('span');
      dot.className = 'viz-pill-dot';
      dot.style.backgroundColor = VIZ_COLORS[idx % VIZ_COLORS.length];

      const name = document.createElement('span');
      name.className = 'viz-pill-name';
      name.textContent = s.name;

      pill.append(dot, name);
      pill.onclick = () => {
        if (state.activeSeries.has(idx)) {
          // 至少保留一个系列开启
          if (state.activeSeries.size > 1) {
            state.activeSeries.delete(idx);
            pill.classList.remove('is-active');
            pill.setAttribute('aria-pressed', 'false');
            refreshChart();
          }
        } else {
          state.activeSeries.add(idx);
          pill.classList.add('is-active');
          pill.setAttribute('aria-pressed', 'true');
          refreshChart();
        }
      };
      seriesPills.append(pill);
    });
    seriesGroup.append(seriesPills);
    controls.append(seriesGroup);

    // (3) 数据范围滑块（当数据点超过 6 个时展示）
    let rangeSlider = null;
    let rangeValLabel = null;
    if (data.labels.length > 6) {
      const rangeRow = document.createElement('div');
      rangeRow.className = 'viz-ctrl-row viz-range-row';

      const rLabel = document.createElement('label');
      rLabel.className = 'viz-ctrl-label';
      rLabel.htmlFor = 'vizRangeInput';
      rLabel.textContent = '范围：';

      rangeSlider = document.createElement('input');
      rangeSlider.id = 'vizRangeInput';
      rangeSlider.type = 'range';
      rangeSlider.className = 'viz-slider';
      rangeSlider.min = '5';
      rangeSlider.max = String(data.labels.length);
      rangeSlider.value = String(state.rangeLimit > 0 ? state.rangeLimit : data.labels.length);

      rangeValLabel = document.createElement('span');
      rangeValLabel.className = 'viz-val-text';
      rangeValLabel.textContent = state.rangeLimit > 0 ? `最近 ${state.rangeLimit} 项` : '全部';

      rangeSlider.oninput = () => {
        const val = Number(rangeSlider.value);
        state.rangeLimit = val === data.labels.length ? 0 : val;
        rangeValLabel.textContent = state.rangeLimit > 0 ? `最近 ${state.rangeLimit} 项` : '全部';
        refreshChart();
      };

      rangeRow.append(rLabel, rangeSlider, rangeValLabel);
      controls.append(rangeRow);
    }

    // (4) 告警阈值调节滑块（自适应负数、常量与跨零极值）
    let threshSlider = null;
    let threshValLabel = null;
    let threshCheck = null;

    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (const s of data.series) {
      for (const v of s.data) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          if (v < dataMin) dataMin = v;
          if (v > dataMax) dataMax = v;
        }
      }
    }
    if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
      dataMin = 0;
      dataMax = 100;
    }
    const span = Math.abs(dataMax - dataMin);
    const padding = span > 0 ? span * 0.25 : (Math.abs(dataMax) > 0 ? Math.abs(dataMax) * 0.25 : 10);
    let threshMin = Math.floor(dataMin - padding);
    let threshMax = Math.ceil(dataMax + padding);
    if (threshMin >= threshMax) {
      threshMin = Math.floor(dataMin - 10);
      threshMax = Math.ceil(dataMax + 10);
    }
    const threshSpan = threshMax - threshMin;
    const threshStep = threshSpan > 200 ? 5 : (threshSpan > 50 ? 1 : (threshSpan > 5 ? 0.5 : 0.1));

    const threshRow = document.createElement('div');
    threshRow.className = 'viz-ctrl-row viz-thresh-row';

    threshCheck = document.createElement('input');
    threshCheck.id = 'vizThreshToggle';
    threshCheck.type = 'checkbox';
    threshCheck.checked = state.threshold !== null;

    const tLabel = document.createElement('label');
    tLabel.className = 'viz-ctrl-label viz-check-label';
    tLabel.htmlFor = 'vizThreshToggle';
    tLabel.textContent = '阈值告警：';

    threshSlider = document.createElement('input');
    threshSlider.type = 'range';
    threshSlider.className = 'viz-slider';
    threshSlider.min = String(threshMin);
    threshSlider.max = String(threshMax);
    threshSlider.step = String(threshStep);
    threshSlider.disabled = !threshCheck.checked;

    const defaultThresh = state.threshold !== null ? state.threshold : Math.round((dataMin + dataMax) / 2);
    threshSlider.value = String(defaultThresh);

    threshValLabel = document.createElement('span');
    threshValLabel.className = 'viz-val-text';
    threshValLabel.textContent = threshCheck.checked ? `${threshSlider.value}${data.unit ? ' ' + data.unit : ''}` : '已停用';

    threshCheck.onchange = () => {
      if (threshCheck.checked) {
        state.threshold = Number(threshSlider.value);
        threshSlider.disabled = false;
        threshValLabel.textContent = `${state.threshold}${data.unit ? ' ' + data.unit : ''}`;
      } else {
        state.threshold = null;
        threshSlider.disabled = true;
        threshValLabel.textContent = '已停用';
      }
      refreshChart();
    };

    threshSlider.oninput = () => {
      if (!threshCheck.checked) return;
      state.threshold = Number(threshSlider.value);
      threshValLabel.textContent = `${state.threshold}${data.unit ? ' ' + data.unit : ''}`;
      refreshChart();
    };

    threshRow.append(threshCheck, tLabel, threshSlider, threshValLabel);
    controls.append(threshRow);

    host.append(controls);

    // 3. 图表展示容器
    const chartArea = document.createElement('div');
    chartArea.className = 'viz-chart-area';
    host.append(chartArea);

    function refreshChart() {
      chartHandle?.dispose?.();
      chartHandle = renderVizChart(chartArea, {
        data,
        type: state.type,
        activeSeries: state.activeSeries,
        rangeLimit: state.rangeLimit,
        threshold: state.threshold,
      });
    }

    // 绑定类型切换
    btnLine.onclick = () => {
      if (state.type === 'line') return;
      state.type = 'line';
      btnLine.classList.add('is-active');
      btnLine.setAttribute('aria-pressed', 'true');
      btnBar.classList.remove('is-active');
      btnBar.setAttribute('aria-pressed', 'false');
      refreshChart();
    };

    btnBar.onclick = () => {
      if (state.type === 'bar') return;
      state.type = 'bar';
      btnBar.classList.add('is-active');
      btnBar.setAttribute('aria-pressed', 'true');
      btnLine.classList.remove('is-active');
      btnLine.setAttribute('aria-pressed', 'false');
      refreshChart();
    };

    // 绑定重置
    resetBtn.onclick = () => {
      state.type = data.type || 'line';
      state.activeSeries = new Set(data.series.map((_, i) => i));
      state.rangeLimit = data.labels.length > 30 ? 20 : 0;
      state.threshold = threshParam && typeof threshParam.default === 'number' ? threshParam.default : null;

      btnLine.classList.toggle('is-active', state.type === 'line');
      btnLine.setAttribute('aria-pressed', state.type === 'line' ? 'true' : 'false');
      btnBar.classList.toggle('is-active', state.type === 'bar');
      btnBar.setAttribute('aria-pressed', state.type === 'bar' ? 'true' : 'false');

      Array.from(seriesPills.children).forEach((child) => {
        child.classList.add('is-active');
        child.setAttribute('aria-pressed', 'true');
      });

      if (rangeSlider) {
        rangeSlider.value = String(state.rangeLimit > 0 ? state.rangeLimit : data.labels.length);
        rangeValLabel.textContent = state.rangeLimit > 0 ? `最近 ${state.rangeLimit} 项` : '全部';
      }

      if (threshCheck && threshSlider) {
        threshCheck.checked = state.threshold !== null;
        threshSlider.disabled = !threshCheck.checked;
        if (state.threshold !== null) threshSlider.value = String(state.threshold);
        threshValLabel.textContent = threshCheck.checked ? `${threshSlider.value}${data.unit ? ' ' + data.unit : ''}` : '已停用';
      }

      refreshChart();
    };

    // 绑定引用到对话
    quoteBtn.onclick = () => {
      const scopeCheck = validateSessionScope(initialScope);
      if (!scopeCheck.ok) {
        toast(scopeCheck.error, 'err');
        return;
      }

      const summary = buildVizSummaryMarkdown(data, state);
      const res = fillReviewComposer(summary);
      if (res.ok) {
        toast('已将图表配置与摘要引用至输入框草稿。', 'ok');
      } else {
        toast(res.error || '引用失败，输入框可能未就绪。', 'err');
      }
    };

    // 初次绘制
    refreshChart();

    // 4. 会话与生命周期安全监听
    const onSessionSwitch = () => {
      instance.close();
    };
    const onWorkspaceChange = () => {
      instance.close();
    };

    document.addEventListener('pi-gui:session-switch', onSessionSwitch);
    document.addEventListener('pi-gui:workspace-view', onWorkspaceChange);

    instance.onDispose(() => {
      document.removeEventListener('pi-gui:session-switch', onSessionSwitch);
      document.removeEventListener('pi-gui:workspace-view', onWorkspaceChange);
      chartHandle?.dispose?.();
      chartHandle = null;
      if (activeVizInstance === instance) activeVizInstance = null;
    });
  }, {
    label: `交互图表 · ${data.title}`,
    headerSelector: '.rp-head',
    triggerId: context.triggerId || 'btnHome',
  });

  return activeVizInstance;
}
