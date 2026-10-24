/* Z3: viz-schema unit tests.
 *
 * Verifies whitelist validation, size limits, error handling and safety fallbacks.
 */
const assert = require('node:assert/strict');

let checks = 0;
const ok = (name, value) => {
  assert.ok(typeof value === 'function' ? value() : value, name);
  checks++;
  console.log('  ok   ' + name);
};

async function main() {
  const { parseVizData, VIZ_LIMITS } = await import('../public/viz-schema.js');

  // 1. Valid line chart
  const validLine = JSON.stringify({
    version: '1',
    type: 'line',
    title: '系统 CPU 趋势',
    description: '每分钟负载监控',
    unit: '%',
    labels: ['10:00', '10:01', '10:02'],
    series: [
      { name: 'Node 1', data: [12.5, 34.0, 56.2] },
      { name: 'Node 2', data: [5.0, 15.2, 22.8] },
    ],
    params: [
      { id: 'threshold', name: '告警线', type: 'number', min: 0, max: 100, default: 50 },
    ],
  });
  const res1 = parseVizData(validLine);
  ok('valid line chart parses successfully', res1.ok === true);
  ok('valid line chart properties match', res1.data.type === 'line' && res1.data.series.length === 2);
  ok('valid line chart is frozen', Object.isFrozen(res1.data) && Object.isFrozen(res1.data.series[0]));

  // 2. Valid bar chart with numeric version
  const validBar = JSON.stringify({
    version: 1,
    type: 'bar',
    title: '按模块用时对比',
    labels: ['模块 A', '模块 B'],
    series: [
      { name: '耗时', data: [120, 340] },
    ],
  });
  const res2 = parseVizData(validBar);
  ok('valid bar chart with numeric version parses successfully', res2.ok === true && res2.data.type === 'bar');

  // 3. Malformed JSON
  const invalidJson = '{ not a valid json:';
  const res3 = parseVizData(invalidJson);
  ok('invalid json returns ok:false with error message', res3.ok === false && res3.error.includes('JSON 解析失败'));

  // 4. Unsupported version
  const badVersion = JSON.stringify({ version: '2', type: 'line', title: 'T', labels: ['1'], series: [{ name: 'S', data: [1] }] });
  const res4 = parseVizData(badVersion);
  ok('unsupported version is rejected', res4.ok === false && res4.error.includes('不支持的版本'));

  // 5. Unsupported or malicious type
  const badType = JSON.stringify({ version: '1', type: '<script>alert(1)</script>', title: 'T', labels: ['1'], series: [{ name: 'S', data: [1] }] });
  const res5 = parseVizData(badType);
  ok('unsupported/malicious chart type is rejected', res5.ok === false && res5.error.includes('不支持的图表类型'));

  // 6. Missing or empty title
  const noTitle = JSON.stringify({ version: '1', type: 'line', title: '   ', labels: ['1'], series: [{ name: 'S', data: [1] }] });
  const res6 = parseVizData(noTitle);
  ok('missing title is rejected', res6.ok === false && res6.error.includes('缺少有效标题'));

  // 7. Non-numeric or NaN data
  const nanData = JSON.stringify({
    version: '1', type: 'line', title: 'T', labels: ['1', '2'],
    series: [{ name: 'S', data: [10, 'not-a-number'] }],
  });
  const res7 = parseVizData(nanData);
  ok('non-numeric data point is rejected', res7.ok === false && res7.error.includes('非法非数值数据'));

  // 8. Series length mismatch with labels
  const mismatch = JSON.stringify({
    version: '1', type: 'line', title: 'T', labels: ['1', '2'],
    series: [{ name: 'S', data: [10] }],
  });
  const res8 = parseVizData(mismatch);
  ok('length mismatch is rejected', res8.ok === false && res8.error.includes('不一致'));

  // 9. Oversized raw payload (> 128KB)
  const bigStr = 'x'.repeat(VIZ_LIMITS.MAX_RAW_LENGTH + 10);
  const res9 = parseVizData(bigStr);
  ok('payload over 128KB is rejected', res9.ok === false && res9.error.includes('数据体积超过上限'));

  // 10. Too many labels (> 100)
  const tooManyLabels = Array.from({ length: 105 }, (_, i) => `L${i}`);
  const dataTooManyLabels = Array.from({ length: 105 }, () => 1);
  const res10 = parseVizData(JSON.stringify({
    version: '1', type: 'line', title: 'T', labels: tooManyLabels, series: [{ name: 'S', data: dataTooManyLabels }],
  }));
  ok('over 100 labels is rejected', res10.ok === false && res10.error.includes('标签过多'));

  // 11. Too many series (> 8)
  const tooManySeries = Array.from({ length: 10 }, (_, i) => ({ name: `S${i}`, data: [1, 2] }));
  const res11 = parseVizData(JSON.stringify({
    version: '1', type: 'line', title: 'T', labels: ['1', '2'], series: tooManySeries,
  }));
  ok('over 8 series is rejected', res11.ok === false && res11.error.includes('数据系列过多'));

  // 12. Parameters sanitization (types, clamped defaults, select options)
  const withParams = JSON.stringify({
    version: '1', type: 'line', title: 'T', labels: ['1', '2'],
    series: [{ name: 'S', data: [1, 2] }],
    params: [
      { id: 'thresh', name: '阈值', type: 'range', min: 10, max: 100, default: 5 }, // default clamped to 10
      { id: 'mode', name: '模式', type: 'select', options: ['A', 'B'], default: 'B' },
      { id: 'invalid id!', type: 'number' }, // invalid ID should be dropped
      { id: 'thresh', name: '重复', type: 'number' }, // duplicate ID should be dropped
    ],
  });
  const res12 = parseVizData(withParams);
  ok('parameters sanitize and clamp defaults', res12.ok === true && res12.data.params.length === 2);
  ok('param 0 min/max/default clamped correctly', res12.data.params[0].default === 10);
  ok('param 1 select options retained', res12.data.params[1].options[1] === 'B');

  console.log(`\nViz Schema: ${checks}/${checks} passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
