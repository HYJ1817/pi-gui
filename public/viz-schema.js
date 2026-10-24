/* pi-gui-viz 结构化可视化协议校验器。
 *
 * ---------- 安全模型 ----------
 *
 * 1. 严格白名单：只放行白名单内的字段与图表类型（首版支持 line 与 bar）。
 * 2. 数量与大小限制：
 *    - JSON 源码最大 128KB
 *    - 标签（labels）最多 100 个，每个最长 50 字符
 *    - 数据系列（series）最多 8 个，名称最长 50 字符
 *    - 系列数据点必须严格为原生有限数值（typeof === 'number' && Number.isFinite），拒绝 null / boolean / 空字符串转换
 *    - 数值绝对值不得超过安全量级 1e12，避免极端溢出
 *    - 参数（params）最多 5 个，仅支持 number / range / select，严格校验数值界限
 * 3. 严格禁止代码执行：不包含任何函数、脚本、事件或表达式字段。
 * 4. 零异常抛出：解析或校验失败统一返回 { ok: false, error }，确保安全降级。
 */

export const VIZ_LIMITS = Object.freeze({
  MAX_RAW_LENGTH: 128 * 1024,
  MAX_TITLE_LENGTH: 100,
  MAX_DESC_LENGTH: 300,
  MAX_UNIT_LENGTH: 20,
  MAX_LABELS: 100,
  MAX_LABEL_LENGTH: 50,
  MAX_SERIES: 8,
  MAX_SERIES_NAME_LENGTH: 50,
  MAX_PARAMS: 5,
  MAX_PARAM_ID_LENGTH: 30,
  MAX_PARAM_NAME_LENGTH: 50,
  MAX_SELECT_OPTIONS: 10,
  MAX_OPTION_LENGTH: 50,
  MAX_NUMERIC_MAGNITUDE: 1e12,
  SUPPORTED_VERSIONS: Object.freeze(['1', 1]),
  SUPPORTED_TYPES: Object.freeze(['line', 'bar']),
});

const PARAM_ID_RE = /^[a-zA-Z0-9_-]{1,30}$/;

function sanitizeString(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  return s.length > maxLength ? s.slice(0, maxLength) : s;
}

export function isStrictFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseVizData(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: '输入必须是字符串' };
  }
  if (raw.length > VIZ_LIMITS.MAX_RAW_LENGTH) {
    return { ok: false, error: `数据体积超过上限（最大 ${VIZ_LIMITS.MAX_RAW_LENGTH / 1024}KB）` };
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `JSON 解析失败: ${err.message}` };
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '可视化数据根节点必须为对象' };
  }

  // 1. 版本校验
  const version = obj.version;
  if (!VIZ_LIMITS.SUPPORTED_VERSIONS.includes(version)) {
    return { ok: false, error: `不支持的版本: ${version}` };
  }

  // 2. 类型校验
  const type = String(obj.type || '').toLowerCase();
  if (!VIZ_LIMITS.SUPPORTED_TYPES.includes(type)) {
    return { ok: false, error: `不支持的图表类型: ${obj.type}` };
  }

  // 3. 标题与说明
  const title = sanitizeString(obj.title, VIZ_LIMITS.MAX_TITLE_LENGTH);
  if (!title) {
    return { ok: false, error: '图表缺少有效标题（title）' };
  }
  const description = sanitizeString(obj.description, VIZ_LIMITS.MAX_DESC_LENGTH, '');
  const unit = sanitizeString(obj.unit, VIZ_LIMITS.MAX_UNIT_LENGTH, '');

  // 4. 坐标标签 labels
  if (!Array.isArray(obj.labels) || obj.labels.length === 0) {
    return { ok: false, error: '图表必须包含非空的 labels 数组' };
  }
  if (obj.labels.length > VIZ_LIMITS.MAX_LABELS) {
    return { ok: false, error: `数据点标签过多（最多 ${VIZ_LIMITS.MAX_LABELS} 个）` };
  }
  const labels = [];
  for (let i = 0; i < obj.labels.length; i++) {
    const l = obj.labels[i];
    if (typeof l !== 'string' && typeof l !== 'number') {
      return { ok: false, error: `第 ${i + 1} 个标签格式无效（必须为文本或数字）` };
    }
    const s = String(l).trim();
    if (!s) {
      return { ok: false, error: `第 ${i + 1} 个标签不能为空` };
    }
    labels.push(s.length > VIZ_LIMITS.MAX_LABEL_LENGTH ? s.slice(0, VIZ_LIMITS.MAX_LABEL_LENGTH) : s);
  }

  // 5. 数据系列 series
  if (!Array.isArray(obj.series) || obj.series.length === 0) {
    return { ok: false, error: '图表必须包含非空的 series 数组' };
  }
  if (obj.series.length > VIZ_LIMITS.MAX_SERIES) {
    return { ok: false, error: `数据系列过多（最多 ${VIZ_LIMITS.MAX_SERIES} 个）` };
  }

  const series = [];
  for (let idx = 0; idx < obj.series.length; idx++) {
    const s = obj.series[idx];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return { ok: false, error: `第 ${idx + 1} 个数据系列格式无效` };
    }
    const name = sanitizeString(s.name, VIZ_LIMITS.MAX_SERIES_NAME_LENGTH) || `系列 ${idx + 1}`;
    if (!Array.isArray(s.data)) {
      return { ok: false, error: `系列「${name}」缺少 data 数值数组` };
    }
    if (s.data.length !== labels.length) {
      return { ok: false, error: `系列「${name}」数据点数 (${s.data.length}) 与标签数 (${labels.length}) 不一致` };
    }

    const data = [];
    for (let di = 0; di < s.data.length; di++) {
      const v = s.data[di];
      // 严格检查：必须为原生数值，拒绝 null / boolean / string 经 Number() 产生的假数值
      if (!isStrictFiniteNumber(v)) {
        return { ok: false, error: `系列「${name}」包含非法非数值数据 (索引 ${di}): ${v}` };
      }
      if (Math.abs(v) > VIZ_LIMITS.MAX_NUMERIC_MAGNITUDE) {
        return { ok: false, error: `系列「${name}」数值过大，超出安全计算范围: ${v}` };
      }
      data.push(v);
    }

    series.push(Object.freeze({
      name,
      data: Object.freeze(data),
    }));
  }

  // 6. 受控参数 params（可选）
  const params = [];
  if (Array.isArray(obj.params)) {
    if (obj.params.length > VIZ_LIMITS.MAX_PARAMS) {
      return { ok: false, error: `参数过多（最多 ${VIZ_LIMITS.MAX_PARAMS} 个）` };
    }

    const seenIds = new Set();
    for (let pi = 0; pi < obj.params.length; pi++) {
      const p = obj.params[pi];
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;

      const id = String(p.id || '').trim();
      if (!PARAM_ID_RE.test(id) || seenIds.has(id)) continue;
      seenIds.add(id);

      const pName = sanitizeString(p.name, VIZ_LIMITS.MAX_PARAM_NAME_LENGTH) || id;
      const pType = String(p.type || '').toLowerCase();

      if (pType === 'number' || pType === 'range') {
        if (!isStrictFiniteNumber(p.min) || !isStrictFiniteNumber(p.max) || p.max <= p.min) {
          continue;
        }
        if (Math.abs(p.min) > VIZ_LIMITS.MAX_NUMERIC_MAGNITUDE || Math.abs(p.max) > VIZ_LIMITS.MAX_NUMERIC_MAGNITUDE) {
          continue;
        }
        const min = p.min;
        const max = p.max;
        const step = isStrictFiniteNumber(p.step) && p.step > 0 ? p.step : 1;
        let def = isStrictFiniteNumber(p.default) ? p.default : min;
        def = Math.min(Math.max(def, min), max);
        params.push(Object.freeze({
          id,
          name: pName,
          type: pType,
          min,
          max,
          step,
          default: def,
        }));
      } else if (pType === 'select') {
        if (!Array.isArray(p.options) || p.options.length === 0) continue;
        const options = p.options
          .slice(0, VIZ_LIMITS.MAX_SELECT_OPTIONS)
          .map((o) => sanitizeString(o, VIZ_LIMITS.MAX_OPTION_LENGTH))
          .filter(Boolean);
        if (options.length === 0) continue;
        const def = options.includes(String(p.default)) ? String(p.default) : options[0];
        params.push(Object.freeze({
          id,
          name: pName,
          type: 'select',
          options: Object.freeze(options),
          default: def,
        }));
      }
    }
  }

  return {
    ok: true,
    data: Object.freeze({
      version: String(version),
      type,
      title,
      description,
      unit,
      labels: Object.freeze(labels),
      series: Object.freeze(series),
      params: Object.freeze(params),
    }),
  };
}
