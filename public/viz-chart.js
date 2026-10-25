/* 原生 SVG 交互图表渲染引擎（无外部依赖）。
 *
 * 支持折线图（line）与柱状图（bar）：
 * - 纯 SVG DOM 节点构建，严禁 eval 与 innerHTML 注入模型原文
 * - 自适应 viewBox 比例缩放与安全坐标换算，杜绝 NaN / Infinity 溢出
 * - 严格遵循零基线规则（柱状图绝不截断基线以夸大差异，支持全负数、常量负数与跨零数据）
 * - 支持图例、系列开关联动、阈值辅助线与超标标记
 * - 鼠标悬停及键盘聚焦 Tooltip 查看详细数值与单位
 * - 无障碍图形语义（role="graphics-document" / aria-label）
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export const VIZ_COLORS = Object.freeze([
  '#4a72b2', // 0: 稳健蓝
  '#2a9d8f', // 1: 青绿
  '#e76f51', // 2: 暖橙红
  '#9d4edd', // 3: 紫罗兰
  '#f4a261', // 4: 琥珀黄
  '#588157', // 5: 灰绿
  '#d62828', // 6: 绯红
  '#3a86ff', // 7: 亮蓝
]);

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  return node;
}

export function calculateBounds(seriesList, activeIndices, threshold, chartType = 'line') {
  let min = Infinity;
  let max = -Infinity;

  let hasData = false;
  for (const idx of activeIndices) {
    const s = seriesList[idx];
    if (!s) continue;
    for (const v of s.data) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
        hasData = true;
      }
    }
  }

  if (typeof threshold === 'number' && Number.isFinite(threshold)) {
    if (threshold < min) min = threshold;
    if (threshold > max) max = threshold;
    hasData = true;
  }

  if (!hasData) {
    return { min: 0, max: 10, range: 10, ticks: [0, 2.5, 5, 7.5, 10] };
  }

  let niceMin;
  let niceMax;

  if (chartType === 'bar') {
    // 柱状图零基线规则：绝不使用截断基线夸大数值差异
    if (min >= 0 && max >= 0) {
      // 全正数或零：零基线固定在 0
      niceMin = 0;
      const topVal = max > 0 ? max : 1;
      niceMax = topVal * 1.1;
    } else if (min <= 0 && max <= 0) {
      // 全负数或零（含常量负数）：零基线固定在 0
      niceMax = 0;
      const bottomVal = min < 0 ? min : -1;
      niceMin = bottomVal * 1.1;
    } else {
      // 跨零数据（正负兼有）：零基线包含在坐标系内部，两侧均留白
      const span = max - min;
      niceMin = min - span * 0.08;
      niceMax = max + span * 0.08;
    }
  } else {
    // 折线图规则
    if (min === max) {
      const delta = Math.abs(min) * 0.1 || 1;
      min -= delta;
      max += delta;
    }
    const rawRange = max - min;
    const padding = rawRange * 0.08 || 1;
    niceMin = min - padding;
    niceMax = max + padding;
  }

  const range = niceMax - niceMin;
  const safeRange = Number.isFinite(range) && range > 0 ? range : 1;

  // 生成 5 个基准刻度
  const tickCount = 4;
  const ticks = [];
  for (let i = 0; i <= tickCount; i++) {
    ticks.push(niceMin + (safeRange / tickCount) * i);
  }

  return { min: niceMin, max: niceMax, range: safeRange, ticks };
}

function formatNumber(num) {
  if (Math.abs(num) >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (Math.abs(num) >= 1000) return (num / 1000).toFixed(1) + 'k';
  if (Number.isInteger(num)) return String(num);
  return num.toFixed(2).replace(/\.?0+$/, '');
}

/** 渲染交互图表到给定的容器元素中。
 *
 * @param {HTMLElement} container 渲染目标容器
 * @param {Object} options 配置项
 * @param {Object} options.data 经 parseVizData 校验的图表数据
 * @param {string} [options.type] 强制指定图表类型（'line' 或 'bar'，用于参数切换）
 * @param {Set<number>} [options.activeSeries] 激活展示的系列索引集合
 * @param {number} [options.rangeLimit] 显示数据范围（取最近 N 项，或 0 代表全量）
 * @param {number} [options.threshold] 阈值告警线
 * @returns {{ dispose: Function, update: Function, bounds: Object }} 控制句柄
 */
export function renderVizChart(container, {
  data,
  type = data.type,
  activeSeries = new Set(data.series.map((_, i) => i)),
  rangeLimit = 0,
  threshold = null,
} = {}) {
  container.replaceChildren();
  container.classList.add('viz-chart-container');

  const wrapper = document.createElement('div');
  wrapper.className = 'viz-svg-wrapper';

  const tooltip = document.createElement('div');
  tooltip.className = 'viz-tooltip';
  tooltip.hidden = true;
  tooltip.setAttribute('role', 'status');
  tooltip.setAttribute('aria-live', 'polite');
  wrapper.append(tooltip);

  // 准备数据切片（根据 rangeLimit 筛选最近 N 项）
  const totalLabels = data.labels.length;
  const sliceCount = rangeLimit > 0 && rangeLimit < totalLabels ? rangeLimit : totalLabels;
  const startIndex = totalLabels - sliceCount;
  const labels = data.labels.slice(startIndex);
  const series = data.series.map((s) => ({
    name: s.name,
    data: s.data.slice(startIndex),
  }));

  const activeIndices = [...activeSeries].filter((i) => i >= 0 && i < series.length);
  const chartType = type === 'bar' ? 'bar' : 'line';
  const unit = data.unit ? ` ${data.unit}` : '';

  // 坐标系画布尺寸规范
  const VB_WIDTH = 640;
  const VB_HEIGHT = 340;
  const MARGIN = { top: 28, right: 36, bottom: 48, left: 60 };
  const W = VB_WIDTH - MARGIN.left - MARGIN.right;
  const H = VB_HEIGHT - MARGIN.top - MARGIN.bottom;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${VB_WIDTH} ${VB_HEIGHT}`,
    class: `viz-svg viz-chart-${chartType}`,
    role: 'graphics-document',
    'aria-label': `${data.title}（${chartType === 'line' ? '折线图' : '柱状图'}）`,
  });

  const titleEl = svgEl('title');
  titleEl.textContent = data.title;
  svg.append(titleEl);

  const descEl = svgEl('desc');
  descEl.textContent = data.description || `${labels.length} 个数据点，${activeIndices.length} 个显示系列`;
  svg.append(descEl);

  const bounds = calculateBounds(series, activeIndices, threshold, chartType);

  const coordX = (index) => {
    if (labels.length <= 1) return MARGIN.left + W / 2;
    if (chartType === 'line') {
      return MARGIN.left + (W / (labels.length - 1)) * index;
    }
    return MARGIN.left + (W / labels.length) * (index + 0.5);
  };

  const coordY = (val) => {
    if (!Number.isFinite(val) || bounds.range <= 0 || !Number.isFinite(bounds.range)) {
      return MARGIN.top + H / 2;
    }
    const ratio = (val - bounds.min) / bounds.range;
    const clampedRatio = Math.max(-0.5, Math.min(1.5, ratio));
    return MARGIN.top + H - clampedRatio * H;
  };

  // 1. 背景水平网格线与 Y 轴刻度
  const gridGroup = svgEl('g', { class: 'viz-grid' });
  for (const tickVal of bounds.ticks) {
    const y = coordY(tickVal);
    const line = svgEl('line', {
      x1: MARGIN.left,
      y1: y,
      x2: MARGIN.left + W,
      y2: y,
      class: 'viz-grid-line',
    });
    const label = svgEl('text', {
      x: MARGIN.left - 8,
      y: y + 4,
      class: 'viz-axis-text viz-axis-y',
      'text-anchor': 'end',
    });
    label.textContent = formatNumber(tickVal) + unit;
    gridGroup.append(line, label);
  }

  // 柱状图零基线高亮线（当数据跨越零点时绘制明确的零刻度线）
  const zeroY = coordY(0);
  if (chartType === 'bar' && bounds.min < 0 && bounds.max > 0) {
    const zeroLine = svgEl('line', {
      x1: MARGIN.left,
      y1: zeroY,
      x2: MARGIN.left + W,
      y2: zeroY,
      class: 'viz-zero-line',
      stroke: 'var(--border, #888)',
      'stroke-width': '1.2',
    });
    gridGroup.append(zeroLine);
  }
  svg.append(gridGroup);

  // 2. 阈值辅助线（如果提供且在数值有效范围内）
  if (typeof threshold === 'number' && Number.isFinite(threshold)) {
    const threshY = coordY(threshold);
    if (threshY >= MARGIN.top - 10 && threshY <= MARGIN.top + H + 10) {
      const threshGroup = svgEl('g', { class: 'viz-threshold-group' });
      const tLine = svgEl('line', {
        x1: MARGIN.left,
        y1: threshY,
        x2: MARGIN.left + W,
        y2: threshY,
        class: 'viz-threshold-line',
      });
      const tBadge = svgEl('text', {
        x: MARGIN.left + W - 4,
        y: threshY - 5,
        class: 'viz-threshold-badge',
        'text-anchor': 'end',
      });
      tBadge.textContent = `阈值: ${formatNumber(threshold)}${unit}`;
      threshGroup.append(tLine, tBadge);
      svg.append(threshGroup);
    }
  }

  // 3. X 轴线与刻度标签（密集标签自动采样防重叠）
  const xAxisGroup = svgEl('g', { class: 'viz-axis-x-group' });
  const baseline = svgEl('line', {
    x1: MARGIN.left,
    y1: MARGIN.top + H,
    x2: MARGIN.left + W,
    y2: MARGIN.top + H,
    class: 'viz-axis-line',
  });
  xAxisGroup.append(baseline);

  const stepX = labels.length > 12 ? Math.ceil(labels.length / 8) : 1;
  labels.forEach((lab, i) => {
    if (i % stepX !== 0 && i !== labels.length - 1) return;
    const x = coordX(i);
    const y = MARGIN.top + H + 18;
    const tick = svgEl('line', {
      x1: x,
      y1: MARGIN.top + H,
      x2: x,
      y2: MARGIN.top + H + 4,
      class: 'viz-tick-mark',
    });
    const txt = svgEl('text', {
      x,
      y,
      class: 'viz-axis-text viz-axis-x',
      'text-anchor': 'middle',
    });
    txt.textContent = lab;
    xAxisGroup.append(tick, txt);
  });
  svg.append(xAxisGroup);

  // Tooltip 控制逻辑
  function showTip(event, label, sName, val, isOverThreshold) {
    const rect = wrapper.getBoundingClientRect();
    const clientX = event.clientX || event.touches?.[0]?.clientX || 0;
    const clientY = event.clientY || event.touches?.[0]?.clientY || 0;
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;

    tooltip.textContent = '';
    const h = document.createElement('div');
    h.className = 'viz-tip-header';
    h.textContent = label;

    const b = document.createElement('div');
    b.className = 'viz-tip-body';
    b.textContent = `${sName}: ${val}${unit}`;

    tooltip.append(h, b);
    if (isOverThreshold) {
      const warn = document.createElement('div');
      warn.className = 'viz-tip-warn';
      warn.textContent = `⚠ 超过阈值 (${formatNumber(threshold)}${unit})`;
      tooltip.append(warn);
    }

    tooltip.hidden = false;

    // 智能防溢出定位
    const tipWidth = 140;
    const left = offsetX + tipWidth > rect.width ? Math.max(10, offsetX - tipWidth - 10) : offsetX + 12;
    const top = Math.max(10, offsetY - 40);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTip() {
    tooltip.hidden = true;
  }

  // 4. 数据实体渲染
  const dataGroup = svgEl('g', { class: 'viz-data-group' });

  if (chartType === 'line') {
    // 折线图
    activeIndices.forEach((sIdx) => {
      const s = series[sIdx];
      const color = VIZ_COLORS[sIdx % VIZ_COLORS.length];
      const points = s.data.map((v, i) => `${coordX(i)},${coordY(v)}`).join(' ');

      const polyline = svgEl('polyline', {
        points,
        class: `viz-line viz-line-${sIdx}`,
        stroke: color,
        fill: 'none',
        'stroke-width': '2.4',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      });
      dataGroup.append(polyline);

      // 数据点圆圈
      s.data.forEach((val, i) => {
        const cx = coordX(i);
        const cy = coordY(val);
        const over = typeof threshold === 'number' && val > threshold;

        const circle = svgEl('circle', {
          cx,
          cy,
          r: over ? '4.8' : '3.6',
          class: `viz-point viz-point-${sIdx}${over ? ' is-alert' : ''}`,
          fill: over ? '#e76f51' : color,
          stroke: '#ffffff',
          'stroke-width': '1.5',
          tabindex: '0',
          role: 'graphics-symbol',
          'aria-label': `${s.name}: ${labels[i]} 数值 ${val}${unit}${over ? ' (超过阈值)' : ''}`,
        });

        circle.addEventListener('mouseenter', (e) => showTip(e, labels[i], s.name, val, over));
        circle.addEventListener('mousemove', (e) => showTip(e, labels[i], s.name, val, over));
        circle.addEventListener('mouseleave', hideTip);
        circle.addEventListener('focus', (e) => showTip(e, labels[i], s.name, val, over));
        circle.addEventListener('blur', hideTip);

        dataGroup.append(circle);
      });
    });
  } else {
    // 柱状图：严格锚定 zeroY 绘制柱条
    const activeCount = activeIndices.length || 1;
    const catWidth = labels.length > 0 ? W / labels.length : W;
    const groupPadding = Math.min(16, catWidth * 0.2);
    const availWidth = Math.max(4, catWidth - groupPadding * 2);
    const barWidth = Math.max(2, availWidth / activeCount);

    labels.forEach((lab, lIdx) => {
      const groupLeft = MARGIN.left + lIdx * catWidth + groupPadding;

      activeIndices.forEach((sIdx, subIdx) => {
        const s = series[sIdx];
        const val = s.data[lIdx];
        const color = VIZ_COLORS[sIdx % VIZ_COLORS.length];
        const over = typeof threshold === 'number' && val > threshold;

        const barX = groupLeft + subIdx * barWidth;
        const targetY = coordY(val);
        const barY = Math.min(zeroY, targetY);
        const barH = Math.max(1, Math.abs(zeroY - targetY));

        const rect = svgEl('rect', {
          x: barX,
          y: barY,
          width: Math.max(1, barWidth - 1.5),
          height: barH,
          rx: '2',
          class: `viz-bar viz-bar-${sIdx}${over ? ' is-alert' : ''}`,
          fill: over ? '#e76f51' : color,
          tabindex: '0',
          role: 'graphics-symbol',
          'aria-label': `${s.name}: ${lab} 数值 ${val}${unit}${over ? ' (超过阈值)' : ''}`,
        });

        rect.addEventListener('mouseenter', (e) => showTip(e, lab, s.name, val, over));
        rect.addEventListener('mousemove', (e) => showTip(e, lab, s.name, val, over));
        rect.addEventListener('mouseleave', hideTip);
        rect.addEventListener('focus', (e) => showTip(e, lab, s.name, val, over));
        rect.addEventListener('blur', hideTip);

        dataGroup.append(rect);
      });
    });
  }
  svg.append(dataGroup);

  wrapper.append(svg);
  container.append(wrapper);

  return {
    svg,
    bounds,
    dispose: () => {
      hideTip();
      container.replaceChildren();
    },
  };
}
